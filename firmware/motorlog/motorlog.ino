/**
 * MotorLog firmware for Freematics ONE+ (Model B) — ml-0.3
 * ---------------------------------------------------------
 * New in ml-0.3:
 *   - SD card spooling: full trips captured regardless of length; chunk files
 *     (~240 samples each) deleted only after the server acks them
 *   - Cellular uplink (SIM7670G, Hologram APN) as WiFi fallback — device key
 *     travels in the JSON body over cell (SIMCOM HTTP can't add headers)
 *   - Low-battery guard: cellular transmit pauses below 11.9 V resting
 * Carries the ml-0.2 fixes: obd.begin(sys.link), WiFi STA reset on reconnect,
 * motion gating, timestamped OBD retry.
 */
#include <FreematicsPlus.h>
#include <FreematicsNetwork.h>
#include <WiFi.h>
#include <SPI.h>
#include <SD.h>
#include "http_transport.h"
#include "ble_bridge.h"
#include "secrets.h"

#define SAMPLE_INTERVAL_MS 1000
#define CONFIG_PULL_MS (60 * 60 * 1000UL)
#define HEARTBEAT_MS (10 * 60 * 1000UL)
#define OBD_RETRY_MS 20000
#define CELL_RETRY_MS (5 * 60 * 1000UL)
#define MAX_CHUNK 240             // samples per spool file (~36KB batch string)
#define RAM_BUF 120               // fallback when no SD card (kept small:
                                  // 900 cost 50KB of RAM the radios need —
                                  // with the SD installed this is dead space)
#define LOW_BATT_V 11.9f
#define FW_VERSION "ml-0.6"
#define DTC_SCAN_MS (10 * 60 * 1000UL)

FreematicsESP32 sys;
COBD obd;

// CellHTTP + network-clock access: LTE broadcasts time (AT+CCLK), which lets
// the device timestamp samples with no GPS fix and no WiFi (garage cold-boot).
class MLCell : public CellHTTP {
public:
  // Proper SIM7670 HTTPS POST: the library's branch fires AT+HTTPACTION and
  // returns without waiting for (or parsing) the result. This one completes
  // the handshake and returns the real HTTP status (0 = transport failure).
  // SIM7670 HTTPS POST. The stock library fires AT+HTTPACTION without waiting
  // for the result; this completes the handshake and returns the real status.
  // sslVariant selects a TLS config permutation (see postCell) because SIM7670G
  // firmware revisions disagree about which CSSLCFG form they accept.
  int post7670(const char* url, const char* payload, int len, int sslVariant) {
    sendCommand("AT+HTTPTERM\r", 1000);
    if (!sendCommand("AT+HTTPINIT\r", 3000)) return 0;

    switch (sslVariant) {
      case 0:                                    // explicit TLS1.2 + SNI, no verify
        sendCommand("AT+CSSLCFG=\"sslversion\",0,3\r", 1000);
        sendCommand("AT+CSSLCFG=\"authmode\",0,0\r", 1000);
        sendCommand("AT+CSSLCFG=\"enableSNI\",0,1\r", 1000);
        sendCommand("AT+HTTPPARA=\"SSLCFG\",0\r", 1000);
        break;
      case 1:                                    // any TLS version + SNI
        sendCommand("AT+CSSLCFG=\"sslversion\",0,4\r", 1000);
        sendCommand("AT+CSSLCFG=\"authmode\",0,0\r", 1000);
        sendCommand("AT+CSSLCFG=\"enableSNI\",0,1\r", 1000);
        sendCommand("AT+HTTPPARA=\"SSLCFG\",0\r", 1000);
        break;
      case 2:                                    // ignore local time (RTC unset)
        sendCommand("AT+CSSLCFG=\"sslversion\",0,3\r", 1000);
        sendCommand("AT+CSSLCFG=\"authmode\",0,0\r", 1000);
        sendCommand("AT+CSSLCFG=\"ignorelocaltime\",0,1\r", 1000);
        sendCommand("AT+CSSLCFG=\"enableSNI\",0,1\r", 1000);
        sendCommand("AT+HTTPPARA=\"SSLCFG\",0\r", 1000);
        break;
      default:                                   // modem defaults, no CSSLCFG
        break;
    }

    char cmd[320];
    snprintf(cmd, sizeof(cmd), "AT+HTTPPARA=\"URL\",\"%s\"\r", url);
    int code = 0;
    if (sendCommand(cmd, 2000)) {
      sendCommand("AT+HTTPPARA=\"CONTENT\",\"application/json\"\r", 1000);
      snprintf(cmd, sizeof(cmd), "AT+HTTPDATA=%d,10000\r", len);
      if (sendCommand(cmd, 3000, "DOWNLOAD")) {
        m_device->xbWrite(payload, len);
        sendCommand(0, 5000, "OK");
        if (sendCommand("AT+HTTPACTION=1\r", 2000) && sendCommand(0, 45000, "+HTTPACTION:")) {
          char* p = strstr(m_buffer, "+HTTPACTION:");
          if (p && (p = strchr(p, ','))) code = atoi(p + 1);
        }
      }
    }
    sendCommand("AT+HTTPTERM\r", 1000);
    return code;
  }

  uint32_t networkEpoch() {
    if (!sendCommand("AT+CCLK?\r", 3000, "+CCLK:")) return 0;
    char* p = strstr(m_buffer, "+CCLK:");
    if (!p || !(p = strchr(p, '"'))) return 0;
    int yy, MM, dd, hh, mm, ss, tz = 0;
    if (sscanf(p + 1, "%d/%d/%d,%d:%d:%d%d", &yy, &MM, &dd, &hh, &mm, &ss, &tz) < 6) return 0;
    struct tm tmv = {};
    tmv.tm_year = 100 + yy; tmv.tm_mon = MM - 1; tmv.tm_mday = dd;
    tmv.tm_hour = hh; tmv.tm_min = mm; tmv.tm_sec = ss;
    time_t e = mktime(&tmv);                     // fields are local-with-offset
    if (e < 1700000000) return 0;
    return (uint32_t)e - (int32_t)tz * 15 * 60;  // strip quarter-hour offset → UTC
  }
};
MLCell cell;
bool obdReady = false, gpsReady = false, sdReady = false, cellReady = false, cellBegun = false;
uint32_t lastCellTry = 0;
float lastBattV = 0;
int sslVariant = -1;      // -1 = not yet discovered

struct Sample {
  uint32_t epoch;
  float lat, lng, speedKph;
  int16_t heading;
  float hdop;
  int rpm, speedObd, coolant, fuelPct;
  float battV;
  bool haveGps, haveObd;
};
Sample ramBuf[RAM_BUF];
int ramCount = 0;
int chunkLines = 0;               // lines in the active spool chunk
uint32_t chunkSeq = 0;            // active chunk number
uint32_t reportIntervalMs = 30000;
uint32_t lastPost = 0, lastConfig = 0, lastSample = 0, lastHeartbeat = 0, lastObdRetry = 0;
uint32_t epochBase = 0, epochBaseMs = 0;
uint32_t lastDtcScan = 0;
char dtcJson[128] = "";              // e.g. "P0301","P0420" — sent with next batch, then cleared
long odoKm = -1;                     // true odometer when the vehicle answers, else -1
uint32_t lastOdoRead = 0;
#define ODO_READ_MS (10 * 60 * 1000UL)

// ---------- time ----------
void syncTimeFromGps(GPS_DATA* gd) {
  if (!gd || !gd->date) return;
  uint32_t d = gd->date, t = gd->time;
  int day = d / 10000, mon = (d / 100) % 100, yr = 2000 + d % 100;
  int hh = t / 1000000, mi = (t / 10000) % 100, ss = (t / 100) % 100;
  struct tm tmv = {};
  tmv.tm_year = yr - 1900; tmv.tm_mon = mon - 1; tmv.tm_mday = day;
  tmv.tm_hour = hh; tmv.tm_min = mi; tmv.tm_sec = ss;
  time_t e = mktime(&tmv);
  if (e > 1700000000) { epochBase = (uint32_t)e; epochBaseMs = millis(); }
}

uint32_t nowEpoch() {
  if (epochBase) return epochBase + (millis() - epochBaseMs) / 1000;
  time_t e = time(nullptr);
  return e > 1700000000 ? (uint32_t)e : 0;
}

// ---------- serialization ----------
String sampleJson(const Sample& s) {
  String out = "{\"ts\":" + String(s.epoch);
  if (s.haveGps) {
    out += ",\"lat\":" + String(s.lat, 6) + ",\"lon\":" + String(s.lng, 6);
    out += ",\"speed_kph\":" + String(s.speedKph, 1);
    out += ",\"heading\":" + String(s.heading);
    out += ",\"hdop\":" + String(s.hdop, 1);
  }
  if (s.haveObd) {
    if (s.rpm >= 0) out += ",\"rpm\":" + String(s.rpm);
    if (s.coolant > -40) out += ",\"coolant_c\":" + String(s.coolant);
    if (s.fuelPct >= 0) out += ",\"fuel_pct\":" + String(s.fuelPct);
    out += ",\"batt_v\":" + String(s.battV, 2);
    out += ",\"engine_on\":";
    out += (s.rpm > 0 ? "true" : "false");
  }
  out += '}';
  return out;
}

// ---------- SD spool ----------
String chunkPath(uint32_t seq) {
  char p[24];
  snprintf(p, sizeof(p), "/ml/%08u.jsn", seq);
  return String(p);
}

void sdInit() {
  SPI.begin();
  sdReady = SD.begin(PIN_SD_CS, SPI, SPI_FREQ);
  if (!sdReady) { Serial.println("[SD] none — RAM buffer fallback"); return; }
  SD.mkdir("/ml");
  // resume after the highest existing chunk
  File dir = SD.open("/ml");
  uint32_t maxSeq = 0;
  for (File f = dir.openNextFile(); f; f = dir.openNextFile()) {
    uint32_t n = atol(f.name());
    if (n > maxSeq) maxSeq = n;
    f.close();
  }
  dir.close();
  chunkSeq = maxSeq + 1;
  Serial.printf("[SD] ready, %u MB free, spool resumes at #%u\n",
    (unsigned)((SD.totalBytes() - SD.usedBytes()) >> 20), chunkSeq);
}

void spoolSample(const Sample& s) {
  File f = SD.open(chunkPath(chunkSeq), FILE_APPEND);
  if (!f) { sdReady = false; return; }       // card yanked: fall back to RAM
  f.println(sampleJson(s));
  f.close();
  if (++chunkLines >= MAX_CHUNK) { chunkSeq++; chunkLines = 0; }
}

// oldest sealed chunk (or the active one if it has data and we're idle)
bool oldestChunk(uint32_t& seq) {
  File dir = SD.open("/ml");
  if (!dir) return false;
  uint32_t best = 0xFFFFFFFF;
  for (File f = dir.openNextFile(); f; f = dir.openNextFile()) {
    uint32_t n = atol(f.name());
    if (n && n < best) best = n;
    f.close();
  }
  dir.close();
  if (best == 0xFFFFFFFF) return false;
  seq = best;
  return true;
}

String batchHeader() {
  String h = "{\"device_key\":\"" DEVICE_KEY "\",\"fw_version\":\"" FW_VERSION "\"";
  if (dtcJson[0]) { h += ",\"dtcs\":["; h += dtcJson; h += "]"; }
  if (odoKm > 0) { h += ",\"odo_km\":" + String(odoKm); }
  h += ",\"batch\":[";
  return h;
}

String loadChunkBatch(uint32_t seq) {
  File f = SD.open(chunkPath(seq));
  if (!f) return "";
  String out = batchHeader();
  bool first = true;
  while (f.available()) {
    String line = f.readStringUntil('\n');
    line.trim();
    if (!line.length()) continue;
    if (!first) out += ',';
    out += line;
    first = false;
  }
  f.close();
  out += "]}";
  return first ? "" : out;
}

// ---------- transports ----------
bool wifiUp() { return WiFi.status() == WL_CONNECTED; }

void connectWiFi() {
  if (wifiUp()) return;
  WiFi.disconnect(true);
  delay(100);
  Serial.print("[WIFI] connecting ");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  for (int i = 0; i < 20 && !wifiUp(); i++) { delay(500); Serial.print('.'); }
  Serial.println(wifiUp() ? " OK" : " FAILED");
}

void tryCell() {
  if (cellReady) return;
  if (lastCellTry != 0 && millis() - lastCellTry < CELL_RETRY_MS) return;  // 0 = never tried
  lastCellTry = millis();
  Serial.print("[CELL] init… ");
  // begin() power-cycles the modem — do it once, or every retry restarts the
  // multi-minute LTE band scan from zero
  if (!cellBegun) {
    if (!cell.begin(&sys)) { Serial.println("no modem"); return; }
    cellBegun = true;
  }
  if (!cell.setup(CELL_APN, 0, 0, 120000)) {   // fresh roaming SIMs can take minutes
    Serial.println("no network yet (registration continues in background)");
    return;
  }
  cellReady = true;
  Serial.println("registered on LTE");
  if (!epochBase) {
    uint32_t e = cell.networkEpoch();
    if (e) { epochBase = e; epochBaseMs = millis(); Serial.println("[CELL] clock synced from network"); }
  }
}

// POST a prebuilt body via best transport; returns HTTP status (0 = no transport)
int postBody(const String& body) {
  if (wifiUp()) {
    int code = mlPost(INGEST_URL, SUPABASE_ANON, DEVICE_KEY, body);
    if (code > 0) return code;
    // WiFi TLS can starve for heap while BLE is resident (ml-0.6+): the
    // modem does its own crypto, so fall through to the cellular path
    Serial.println("[WIFI] TLS post failed — falling back to cellular");
  }
  if (lastBattV > 0 && lastBattV < LOW_BATT_V) {
    Serial.println("[CELL] skipped — battery low");
    return 0;
  }
  tryCell();
  if (!cellReady) return 0;
  // sslVariant is discovered once, then reused for the life of the boot
  // Cellular goes through the Netlify relay: this modem's CA store trusts
  // Let's Encrypt (Netlify) but not Google Trust Services (Supabase direct).
  for (int v = (sslVariant >= 0 ? sslVariant : 0); v <= (sslVariant >= 0 ? sslVariant : 3); v++) {
    int code = cell.post7670(RELAY_URL, body.c_str(), body.length(), v);
    if (code >= 200 && code < 600) {
      if (sslVariant != v) { sslVariant = v; Serial.printf("[CELL] TLS variant %d works\n", v); }
      return code;
    }
    Serial.printf("[CELL] TLS variant %d -> %d\n", v, code);
    if (sslVariant >= 0) break;            // already latched; don't loop on a blip
  }
  cellReady = false;
  return 0;
}

// ---------- sampling ----------
void takeSample() {
  Sample s = {};
  s.epoch = nowEpoch();

  GPS_DATA* gd = nullptr;
  // sat>=3 alone isn't a fix: the co-processor reports satellites in view and
  // zeroed coordinates before it has a position lock. Require real coordinates.
  if (gpsReady && sys.gpsGetData(&gd) && gd && gd->sat >= 4 &&
      (gd->lat != 0 || gd->lng != 0) && fabs(gd->lat) <= 90 && fabs(gd->lng) <= 180) {
    syncTimeFromGps(gd);
    if (!s.epoch) s.epoch = nowEpoch();
    s.haveGps = true;
    s.lat = gd->lat; s.lng = gd->lng;
    s.speedKph = gd->speed * 1.852f;
    s.heading = gd->heading;
    s.hdop = gd->hdop / 10.0f;
  }

  if (obdReady) {
    int v;
    if (obd.readPID(PID_RPM, v)) { s.haveObd = true; s.rpm = v; } else { s.rpm = -1; obdReady = false; }
    if (s.haveObd) {
      s.speedObd = obd.readPID(PID_SPEED, v) ? v : -1;
      s.coolant  = obd.readPID(PID_COOLANT_TEMP, v) ? v : -100;
      s.fuelPct  = obd.readPID(PID_FUEL_LEVEL, v) ? v : -1;
      s.battV    = obd.getVoltage();
      lastBattV  = s.battV;
    }
  }

  // feed the BLE live cache — the phone's gauges read from here, never the bus
  bleLive.valid = s.haveObd;
  if (s.haveObd) {
    bleLive.rpm = s.rpm; bleLive.speedKph = s.speedObd;
    bleLive.coolantC = s.coolant; bleLive.fuelPct = s.fuelPct;
    bleLive.battV = s.battV;
  }

  bool moving = s.haveGps && s.speedKph > 3.0f;
  bool engine = s.haveObd && s.rpm > 0;
  if (!s.epoch || (!moving && !engine)) return;

  if (sdReady) spoolSample(s);
  else if (ramCount < RAM_BUF) ramBuf[ramCount++] = s;
}

// ---------- upload ----------
String ramBatch() {
  String out = batchHeader();
  for (int i = 0; i < ramCount; i++) {
    if (i) out += ',';
    out += sampleJson(ramBuf[i]);
  }
  out += "]}";
  return out;
}

void drain() {
  if (sdReady) {
    // seal a partially-filled active chunk so it becomes drainable
    if (chunkLines > 0) { chunkSeq++; chunkLines = 0; }
    for (int pass = 0; pass < 3; pass++) {
      uint32_t seq;
      if (!oldestChunk(seq)) return;
      String body = loadChunkBatch(seq);
      if (!body.length()) { SD.remove(chunkPath(seq)); continue; }  // empty file
      int code = postBody(body);
      Serial.printf("[POST] chunk #%u -> HTTP %d\n", seq, code);
      if (code != 200) return;               // keep chunk, retry next cycle
      SD.remove(chunkPath(seq));
      lastHeartbeat = millis();
    }
  } else if (ramCount) {
    int code = postBody(ramBatch());
    Serial.printf("[POST] %d samples (RAM) -> HTTP %d\n", ramCount, code);
    if (code == 200) { ramCount = 0; lastHeartbeat = millis(); }
  }
}

void heartbeat() {
  if (millis() - lastHeartbeat < HEARTBEAT_MS && lastHeartbeat != 0) return;
  uint32_t e = nowEpoch();
  if (!e) return;
  String hb = "{\"device_key\":\"" DEVICE_KEY "\",\"fw_version\":\"" FW_VERSION
              "\",\"batch\":[{\"ts\":" + String(e) + "}]}";
  int code = postBody(hb);
  Serial.printf("[HEARTBEAT] HTTP %d\n", code);
  if (code == 200) lastHeartbeat = millis();
}

void pullConfig() {
  String body;
  int code = 0;
  if (wifiUp()) {
    code = mlGet(INGEST_URL, SUPABASE_ANON, DEVICE_KEY, body);
  } else {
    // cellular config pull: POST {action:'config'}
    String req = "{\"device_key\":\"" DEVICE_KEY "\",\"action\":\"config\"}";
    code = postBody(req);
    // body unavailable through CellHTTP's simple interface; interval changes
    // apply on the next WiFi pull — acceptable for a rarely-changed knob
    if (code == 200) return;
  }
  if (code == 200) {
    int i = body.indexOf("\"report_interval_s\":");
    if (i >= 0) {
      int v = body.substring(i + 20).toInt();
      if (v >= 5 && v <= 3600) {
        reportIntervalMs = (uint32_t)v * 1000;
        Serial.printf("[CFG] report interval %ds\n", v);
      }
    }
  }
}

// Standard OBD DTC uint16 → "P0301"-style string
void dtcToStr(uint16_t code, char* out) {
  const char letters[] = {'P','C','B','U'};
  sprintf(out, "%c%01X%03X", letters[(code >> 14) & 3], (code >> 12) & 3, code & 0xFFF);
}

uint16_t dtcCache[6];                // raw codes for the BLE bridge (no live
int dtcCacheN = 0;                   // OBD access from the BLE task, ever)
volatile bool bleClearReq = false;

void scanDtcs() {
  if (!obdReady) return;
  uint16_t codes[6];
  int n = obd.readDTC(codes, 6);
  if (n <= 0) { dtcJson[0] = 0; dtcCacheN = 0; return; }
  char* p = dtcJson;
  for (int i = 0; i < n && i < 6; i++) {
    char c[8]; dtcToStr(codes[i], c);
    p += sprintf(p, "%s\"%s\"", i ? "," : "", c);
    dtcCache[i] = codes[i];
  }
  dtcCacheN = n < 6 ? n : 6;
  Serial.printf("[DTC] %d stored: %s\n", n, dtcJson);
}

// ---------- odometer ----------
// Pull hex bytes that follow a response marker like "41 A6" or "61 28".
// Returns count parsed (co-processor replies use space-separated hex).
int parseHexAfter(const char* resp, const char* marker, uint8_t* out, int maxN) {
  const char* p = strstr(resp, marker);
  if (!p) return 0;
  p += strlen(marker);
  int n = 0;
  while (n < maxN) {
    while (*p == ' ' || *p == '\r' || *p == '\n') p++;
    if (!isxdigit(*p) || !isxdigit(*(p + 1))) break;
    char b[3] = { p[0], p[1], 0 };
    out[n++] = (uint8_t)strtol(b, nullptr, 16);
    p += 2;
  }
  return n;
}

// True odometer, two attempts:
//  1. SAE J1979 PID 01 A6 (odometer in 0.1 km) — vehicles ~2019+
//  2. Toyota/Lexus combination meter (CAN 7C0): service 21 PID 28 — the same
//     read Techstream uses; odometer km in the 3 bytes after "61 28".
// Either failing is normal (bench, older car); we keep the fill-up estimate.
void readOdometer() {
  if (!obdReady || !sys.link) return;
  char buf[128];
  if (sys.link->sendCommand("01A6\r", buf, sizeof(buf), 1000) > 0) {
    uint8_t b[4];
    if (parseHexAfter(buf, "41 A6", b, 4) == 4) {
      long v = ((long)b[0] << 24 | (long)b[1] << 16 | (long)b[2] << 8 | b[3]) / 10;
      if (v > 0 && v < 2000000) { odoKm = v; Serial.printf("[ODO] PID A6: %ld km\n", v); return; }
    }
  }
  if (sys.link->sendCommand("ATSH7C0\r", buf, sizeof(buf), 1000) > 0) {
    int n = sys.link->sendCommand("2128\r", buf, sizeof(buf), 1500);
    sys.link->sendCommand("ATSH7DF\r", buf, sizeof(buf), 1000);   // restore broadcast
    if (n > 0) {
      uint8_t b[3];
      char resp[128];
      strncpy(resp, buf, sizeof(resp) - 1); resp[sizeof(resp) - 1] = 0;
      if (parseHexAfter(resp, "61 28", b, 3) == 3) {
        long v = (long)b[0] << 16 | (long)b[1] << 8 | b[2];
        if (v > 0 && v < 2000000) { odoKm = v; Serial.printf("[ODO] Toyota 7C0: %ld km\n", v); return; }
      }
    }
  }
  Serial.println("[ODO] not readable on this vehicle");
}

void tryObd() {
  obd.begin(sys.link);
  obdReady = obd.init(PROTO_AUTO, true);
  if (obdReady) {
    Serial.println("[OBD] connected");
    scanDtcs(); lastDtcScan = millis();
    readOdometer(); lastOdoRead = millis();
  }
}

// BLE bridge hooks — called from the BLE task, so they must NOT touch the
// OBD link (loop() owns it). Codes come from the periodic scan cache; a
// clear is flagged and executed by loop() on its next pass.
int bleReadDtcsHook(uint16_t* codes, int maxN) {
  int n = dtcCacheN < maxN ? dtcCacheN : maxN;
  for (int i = 0; i < n; i++) codes[i] = dtcCache[i];
  return n;
}
bool bleClearDtcsHook() {
  if (!obdReady) return false;
  bleClearReq = true;                // loop() performs the actual clear
  return true;
}

void setup() {
  Serial.begin(115200);
  Serial.println("\n[MOTORLOG] " FW_VERSION " starting");
  sys.begin(true, true);                     // co-proc + cellular power rail on

  // BLE first: btStart wants a big contiguous heap block — grab it before
  // WiFi and the cellular stack fragment the arena
  bleBridgeInit("MotorLog OBD");

  obd.begin(sys.link);
  obdReady = obd.init();
  Serial.println(obdReady ? "[OBD] connected" : "[OBD] not connected (will retry)");

  gpsReady = sys.gpsBegin();
  Serial.println(gpsReady ? "[GNSS] on" : "[GNSS] unavailable");

  sdInit();
  connectWiFi();
  configTime(0, 0, "pool.ntp.org");
  tryCell();      // register on LTE at boot even with WiFi up, so the modem is
                  // ready the moment the truck leaves WiFi range
  pullConfig();
  lastConfig = millis();
}

void loop() {
  uint32_t now = millis();
  if (now - lastSample >= SAMPLE_INTERVAL_MS) {
    lastSample = now;
    takeSample();
  }
  if (now - lastPost >= reportIntervalMs) {
    lastPost = now;
    if (!wifiUp()) connectWiFi();
    drain();
    heartbeat();
  }
  if (now - lastConfig >= CONFIG_PULL_MS) {
    lastConfig = now;
    pullConfig();
  }
  if (!obdReady && now - lastObdRetry >= OBD_RETRY_MS) {
    lastObdRetry = now;
    tryObd();
  }
  if (obdReady && now - lastDtcScan >= DTC_SCAN_MS) {
    lastDtcScan = now;
    scanDtcs();
  }
  if (obdReady && now - lastOdoRead >= ODO_READ_MS) {
    lastOdoRead = now;
    readOdometer();
  }
  if (bleClearReq && obdReady) {
    bleClearReq = false;
    obd.clearDTC();
    dtcCacheN = 0; dtcJson[0] = 0;
    Serial.println("[DTC] cleared (BLE request)");
  }
  delay(20);
}
