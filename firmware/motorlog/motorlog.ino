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
#include "secrets.h"

#define SAMPLE_INTERVAL_MS 1000
#define CONFIG_PULL_MS (60 * 60 * 1000UL)
#define HEARTBEAT_MS (10 * 60 * 1000UL)
#define OBD_RETRY_MS 20000
#define CELL_RETRY_MS (5 * 60 * 1000UL)
#define MAX_CHUNK 240             // samples per spool file (~36KB batch string)
#define RAM_BUF 900               // fallback when no SD card
#define LOW_BATT_V 11.9f
#define FW_VERSION "ml-0.3"

FreematicsESP32 sys;
COBD obd;
CellHTTP cell;
bool obdReady = false, gpsReady = false, sdReady = false, cellReady = false;
uint32_t lastCellTry = 0;
float lastBattV = 0;

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

String loadChunkBatch(uint32_t seq) {
  File f = SD.open(chunkPath(seq));
  if (!f) return "";
  String out = "{\"device_key\":\"" DEVICE_KEY "\",\"fw_version\":\"" FW_VERSION "\",\"batch\":[";
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
  if (cellReady || millis() - lastCellTry < CELL_RETRY_MS) return;
  lastCellTry = millis();
  Serial.print("[CELL] init… ");
  if (!cell.begin(&sys)) { Serial.println("no modem"); return; }
  if (!cell.setup(CELL_APN)) { Serial.println("no network (SIM? signal?)"); return; }
  cellReady = true;
  Serial.println("registered on LTE");
}

// POST a prebuilt body via best transport; returns HTTP status (0 = no transport)
int postBody(const String& body) {
  if (wifiUp()) return mlPost(INGEST_URL, SUPABASE_ANON, DEVICE_KEY, body);
  if (lastBattV > 0 && lastBattV < LOW_BATT_V) {
    Serial.println("[CELL] skipped — battery low");
    return 0;
  }
  tryCell();
  if (!cellReady) return 0;
  if (!cell.open(INGEST_HOST, 443)) { cellReady = false; return 0; }
  if (!cell.send(METHOD_POST, INGEST_HOST, 443, INGEST_PATH, body.c_str(), body.length())) {
    cellReady = false;
    return 0;
  }
  return cell.code();
}

// ---------- sampling ----------
void takeSample() {
  Sample s = {};
  s.epoch = nowEpoch();

  GPS_DATA* gd = nullptr;
  if (gpsReady && sys.gpsGetData(&gd) && gd && gd->sat >= 3) {
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

  bool moving = s.haveGps && s.speedKph > 3.0f;
  bool engine = s.haveObd && s.rpm > 0;
  if (!s.epoch || (!moving && !engine)) return;

  if (sdReady) spoolSample(s);
  else if (ramCount < RAM_BUF) ramBuf[ramCount++] = s;
}

// ---------- upload ----------
String ramBatch() {
  String out = "{\"device_key\":\"" DEVICE_KEY "\",\"fw_version\":\"" FW_VERSION "\",\"batch\":[";
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

void tryObd() {
  obd.begin(sys.link);
  obdReady = obd.init(PROTO_AUTO, true);
  if (obdReady) Serial.println("[OBD] connected");
}

void setup() {
  Serial.begin(115200);
  Serial.println("\n[MOTORLOG] " FW_VERSION " starting");
  sys.begin(true, true);                     // co-proc + cellular power rail on

  obd.begin(sys.link);
  obdReady = obd.init();
  Serial.println(obdReady ? "[OBD] connected" : "[OBD] not connected (will retry)");

  gpsReady = sys.gpsBegin();
  Serial.println(gpsReady ? "[GNSS] on" : "[GNSS] unavailable");

  sdInit();
  connectWiFi();
  configTime(0, 0, "pool.ntp.org");
  tryCell();      // register on LTE at boot even with WiFi up: idle-cheap, and
                  // the modem is ready the moment the truck leaves WiFi range
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
  delay(20);
}
