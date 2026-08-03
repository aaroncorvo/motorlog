/**
 * MotorLog firmware for Freematics ONE+ (Model B)
 * ------------------------------------------------
 * Minimal, readable telematics node built on the FreematicsPlus library:
 *   - OBD-II polling (RPM, speed, coolant, fuel level, battery voltage)
 *   - GNSS positioning
 *   - Store-and-forward RAM buffer
 *   - Batched JSON HTTPS POST to the MotorLog ingest-telemetry edge function
 *   - App-managed config pull (reporting interval; WiFi applies next flash)
 *
 * WiFi transport first (home/driveway); the SIM7670G cellular path is a
 * follow-up once a SIM is installed. Secrets live in secrets.h (git-ignored).
 */
#include <FreematicsPlus.h>
#include <WiFi.h>
#include "http_transport.h"
#include "secrets.h"

#define SAMPLE_INTERVAL_MS 1000
#define CONFIG_PULL_MS (60 * 60 * 1000UL)
#define MAX_BATCH 60          // ~1 min of samples at 1 Hz
#define FW_VERSION "ml-0.1"

FreematicsESP32 sys;
COBD obd;
bool obdReady = false;
bool gpsReady = false;

struct Sample {
  uint32_t epoch;             // seconds; 0 = unknown time (dropped)
  float lat, lng, speedKph;
  int16_t heading;
  float hdop;
  int rpm, speedObd, coolant, fuelPct;
  float battV;
  bool haveGps, haveObd;
};
Sample buf[MAX_BATCH];
int bufCount = 0;
uint32_t reportIntervalMs = 30000;
uint32_t lastPost = 0, lastConfig = 0, lastSample = 0;
uint32_t epochBase = 0, epochBaseMs = 0;   // set from GNSS time

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.print("[WIFI] connecting to " WIFI_SSID " ");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  for (int i = 0; i < 30 && WiFi.status() != WL_CONNECTED; i++) {
    delay(500); Serial.print('.');
  }
  Serial.println(WiFi.status() == WL_CONNECTED ? " OK" : " FAILED");
}

// GNSS provides UTC; convert its ts to a wall-clock epoch base
void syncTimeFromGps(GPS_DATA* gd) {
  if (!gd || !gd->date) return;
  // date: DDMMYY, time: HHMMSSmm (per Freematics GPS parsing)
  uint32_t d = gd->date, t = gd->time;
  int day = d / 10000, mon = (d / 100) % 100, yr = 2000 + d % 100;
  int hh = t / 1000000, mi = (t / 10000) % 100, ss = (t / 100) % 100;
  struct tm tmv = {};
  tmv.tm_year = yr - 1900; tmv.tm_mon = mon - 1; tmv.tm_mday = day;
  tmv.tm_hour = hh; tmv.tm_min = mi; tmv.tm_sec = ss;
  time_t e = mktime(&tmv);   // device TZ is UTC (no TZ set)
  if (e > 1700000000) { epochBase = (uint32_t)e; epochBaseMs = millis(); }
}

uint32_t nowEpoch() {
  if (epochBase) return epochBase + (millis() - epochBaseMs) / 1000;
  time_t e = time(nullptr);                 // NTP epoch if WiFi got it
  return e > 1700000000 ? (uint32_t)e : 0;
}

void takeSample() {
  Sample& s = buf[bufCount];
  s = {};
  s.epoch = nowEpoch();

  GPS_DATA* gd = nullptr;
  if (gpsReady && sys.gpsGetData(&gd) && gd && gd->sat >= 3) {
    syncTimeFromGps(gd);
    if (!s.epoch) s.epoch = nowEpoch();
    s.haveGps = true;
    s.lat = gd->lat; s.lng = gd->lng;
    s.speedKph = gd->speed * 1.852f;        // knots → km/h
    s.heading = gd->heading;
    s.hdop = gd->hdop / 10.0f;
  }

  if (obdReady) {
    int v;
    s.haveObd = true;
    s.rpm      = obd.readPID(PID_RPM, v) ? v : -1;
    s.speedObd = obd.readPID(PID_SPEED, v) ? v : -1;
    s.coolant  = obd.readPID(PID_COOLANT_TEMP, v) ? v : -1;
    s.fuelPct  = obd.readPID(PID_FUEL_LEVEL, v) ? v : -1;
    s.battV    = obd.getVoltage();
  }

  if (s.epoch && (s.haveGps || s.haveObd)) {
    if (bufCount < MAX_BATCH - 1) bufCount++;
    // buffer full: newest sample keeps overwriting the last slot
  }
}

String buildBatch() {
  String out = "{\"fw_version\":\"" FW_VERSION "\",\"batch\":[";
  for (int i = 0; i < bufCount; i++) {
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

void postBatch() {
  if (!bufCount || WiFi.status() != WL_CONNECTED) return;
  int code = mlPost(INGEST_URL, SUPABASE_ANON, DEVICE_KEY, buildBatch());
  Serial.printf("[POST] %d samples -> HTTP %d\n", bufCount, code);
  if (code == 200) bufCount = 0;            // acked: clear; else retry next cycle
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

void setup() {
  Serial.begin(115200);
  Serial.println("\n[MOTORLOG] " FW_VERSION " starting");
  sys.begin(true, false);                    // co-proc on, cellular off (WiFi phase)

  obdReady = obd.init();
  Serial.println(obdReady ? "[OBD] connected" : "[OBD] not connected (bench mode)");

  gpsReady = sys.gpsBegin();
  Serial.println(gpsReady ? "[GNSS] on" : "[GNSS] unavailable");

  connectWiFi();
  configTime(0, 0, "pool.ntp.org");          // NTP fallback clock (UTC)
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
    postBatch();
  }
  if (now - lastConfig >= CONFIG_PULL_MS) {
    lastConfig = now;
    pullConfig();
  }
  if (!obdReady && (now / 1000) % 30 == 0) { // retry OBD every ~30s (car started)
    obdReady = obd.init(PROTO_AUTO, true);
    if (obdReady) Serial.println("[OBD] connected");
  }
  delay(20);
}
