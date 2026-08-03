/**
 * MotorLog firmware for Freematics ONE+ (Model B) — ml-0.2
 * ---------------------------------------------------------
 * Changes from ml-0.1 (first-drive shakedown findings):
 *   - FIX: obd.begin(sys.link) was never called — OBD had no transport
 *   - FIX: WiFi reconnect after long absence (disconnect before re-begin)
 *   - Buffer grown 60 → 900 samples (~15 min) with chunked drain (≤450/POST)
 *   - Motion gating: only record when moving or engine-on; idle = heartbeat
 *   - OBD retry on a timestamp, not a modulo burst
 */
#include <FreematicsPlus.h>
#include <WiFi.h>
#include "http_transport.h"
#include "secrets.h"

#define SAMPLE_INTERVAL_MS 1000
#define CONFIG_PULL_MS (60 * 60 * 1000UL)
#define HEARTBEAT_MS (10 * 60 * 1000UL)
#define OBD_RETRY_MS 20000
#define MAX_BUF 900               // ~15 min at 1 Hz
#define MAX_POST 450              // ingest fn caps batches at 500
#define FW_VERSION "ml-0.2"

FreematicsESP32 sys;
COBD obd;
bool obdReady = false;
bool gpsReady = false;

struct Sample {
  uint32_t epoch;
  float lat, lng, speedKph;
  int16_t heading;
  float hdop;
  int rpm, speedObd, coolant, fuelPct;
  float battV;
  bool haveGps, haveObd;
};
Sample buf[MAX_BUF];
int bufCount = 0;
uint32_t reportIntervalMs = 30000;
uint32_t lastPost = 0, lastConfig = 0, lastSample = 0, lastHeartbeat = 0, lastObdRetry = 0;
uint32_t epochBase = 0, epochBaseMs = 0;

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  // a long time out of range can wedge the STA state — reset it first
  WiFi.disconnect(true);
  delay(100);
  Serial.print("[WIFI] connecting ");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  for (int i = 0; i < 20 && WiFi.status() != WL_CONNECTED; i++) {
    delay(500); Serial.print('.');
  }
  Serial.println(WiFi.status() == WL_CONNECTED ? " OK" : " FAILED");
}

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

void takeSample() {
  if (bufCount >= MAX_BUF) return;          // full: oldest data wins until drained
  Sample& s = buf[bufCount];
  s = {};
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
    }
  }

  // motion gating: record only when something is happening — moving, or the
  // engine is turning. A parked truck with a GPS fix stays quiet (heartbeat
  // covers liveness) instead of logging 86k idle rows a day.
  bool moving = s.haveGps && s.speedKph > 3.0f;
  bool engine = s.haveObd && s.rpm > 0;
  if (s.epoch && (moving || engine)) bufCount++;
}

String buildBatch(int count) {
  String out = "{\"fw_version\":\"" FW_VERSION "\",\"batch\":[";
  for (int i = 0; i < count; i++) {
    Sample& s = buf[i];
    if (i) out += ',';
    out += "{\"ts\":" + String(s.epoch);
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
  }
  out += "]}";
  return out;
}

void drainBuffer() {
  // up to two chunks per cycle: a full buffer clears in one go
  for (int pass = 0; pass < 2 && bufCount > 0; pass++) {
    int n = bufCount < MAX_POST ? bufCount : MAX_POST;
    int code = mlPost(INGEST_URL, SUPABASE_ANON, DEVICE_KEY, buildBatch(n));
    Serial.printf("[POST] %d/%d samples -> HTTP %d\n", n, bufCount, code);
    if (code != 200) return;                 // keep everything, retry next cycle
    if (bufCount > n) memmove(buf, buf + n, (bufCount - n) * sizeof(Sample));
    bufCount -= n;
    lastHeartbeat = millis();
  }
}

void postCycle() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (bufCount) { drainBuffer(); return; }
  if (millis() - lastHeartbeat >= HEARTBEAT_MS || lastHeartbeat == 0) {
    uint32_t e = nowEpoch();
    if (!e) return;
    String hb = "{\"fw_version\":\"" FW_VERSION "\",\"batch\":[{\"ts\":" + String(e) + "}]}";
    int code = mlPost(INGEST_URL, SUPABASE_ANON, DEVICE_KEY, hb);
    Serial.printf("[HEARTBEAT] HTTP %d\n", code);
    if (code == 200) lastHeartbeat = millis();
  }
}

void pullConfig() {
  if (WiFi.status() != WL_CONNECTED) return;
  String body;
  if (mlGet(INGEST_URL, SUPABASE_ANON, DEVICE_KEY, body) == 200) {
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
  obd.begin(sys.link);                       // the ml-0.1 bug: this was missing
  obdReady = obd.init(PROTO_AUTO, true);
  if (obdReady) Serial.println("[OBD] connected");
}

void setup() {
  Serial.begin(115200);
  Serial.println("\n[MOTORLOG] " FW_VERSION " starting");
  sys.begin(true, false);

  obd.begin(sys.link);
  obdReady = obd.init();
  Serial.println(obdReady ? "[OBD] connected" : "[OBD] not connected (will retry)");

  gpsReady = sys.gpsBegin();
  Serial.println(gpsReady ? "[GNSS] on" : "[GNSS] unavailable");

  connectWiFi();
  configTime(0, 0, "pool.ntp.org");
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
    connectWiFi();
    postCycle();
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
