// ELM327-over-BLE bridge on the FreematicsPlus SPP GATT server (the same
// proven ble_init path telelogger ships with): service 0xABF0, command char
// 0xFFE1 (write) + status char 0xFFE2 (notify) — a write/notify pair the
// MotorLog app's service discovery accepts. Responses come from the main
// loop's sample cache; BLE never touches the OBD link from its own task.
#include "ble_bridge.h"
#include <FreematicsPlus.h>          // wraps ble_spp_server.h in extern "C"
#include <esp_bt.h>

BleLive bleLive;
static bool bleUp = false;

void bleBridgeInit(const char* name) {
  // BLE-only: hand Classic-BT's controller arena (~45KB) back to the heap
  // BEFORE the controller starts — WiFi can't init without it
  esp_bt_controller_mem_release(ESP_BT_MODE_CLASSIC_BT);
  ble_init(name);                    // ≤13 chars fits the raw adv payload
  bleUp = true;
  Serial.printf("[BLE] SPP server \"%s\" (svc ABF0), free heap %u\n",
    name, (unsigned)ESP.getFreeHeap());
}

// notify in ≤20-byte chunks (status attr length / default-MTU safe);
// the app accumulates until it sees '>'
static void sendChunked(const String& s) {
  for (int i = 0; i < (int)s.length(); i += 20) {
    int n = min(20, (int)s.length() - i);
    ble_send(SPP_IDX_SPP_STATUS_VAL, (void*)(s.c_str() + i), n);
    delay(8);
  }
}

static String hex2(uint8_t b) { char t[3]; sprintf(t, "%02X", b); return String(t); }

static String pidResponse(const String& pid) {
  if (!bleLive.valid) return "NO DATA";
  int a = -1, b = -1;
  if (pid == "0C") { if (bleLive.rpm < 0) return "NO DATA";
    int raw = bleLive.rpm * 4; a = (raw >> 8) & 0xFF; b = raw & 0xFF; }
  else if (pid == "0D") { if (bleLive.speedKph < 0) return "NO DATA";
    a = bleLive.speedKph & 0xFF; }
  else if (pid == "05") { if (bleLive.coolantC <= -100) return "NO DATA";
    a = (bleLive.coolantC + 40) & 0xFF; }
  else if (pid == "2F") { if (bleLive.fuelPct < 0) return "NO DATA";
    a = (int)(bleLive.fuelPct * 255 / 100) & 0xFF; }
  else if (pid == "42") { if (bleLive.battV <= 0) return "NO DATA";
    int raw = (int)(bleLive.battV * 1000); a = (raw >> 8) & 0xFF; b = raw & 0xFF; }
  else return "NO DATA";
  String r = "41 " + pid + " " + hex2(a);
  if (b >= 0) r += " " + hex2(b);
  return r;
}

static String handleCommand(String cmd) {
  cmd.trim(); cmd.toUpperCase(); cmd.replace(" ", "");
  if (!cmd.length()) return "";
  if (cmd.startsWith("ATZ")) return "ELM327 v1.5 MotorLog";
  if (cmd.startsWith("AT")) return "OK";
  if (cmd == "03") {
    uint16_t codes[6];
    int n = bleReadDtcsHook(codes, 6);
    String r = "43 " + hex2(n < 0 ? 0 : n);
    for (int i = 0; i < n; i++) r += " " + hex2(codes[i] >> 8) + " " + hex2(codes[i] & 0xFF);
    return r;
  }
  if (cmd == "07") return "NO DATA";
  if (cmd == "04") return bleClearDtcsHook() ? "OK" : "ERROR";
  if (cmd.startsWith("01") && cmd.length() >= 4) return pidResponse(cmd.substring(2, 4));
  return "?";
}

void bleBridgeProcess() {
  if (!bleUp) return;
  char* cmd = ble_recv_command(0);   // 0 ticks — pure poll, never blocks the loop
  if (!cmd) return;
  String c(cmd);
  free(cmd);
  String resp = handleCommand(c);
  sendChunked(resp + "\r\r>");
}
