// ELM327-over-BLE bridge — advertises like a generic BLE OBD dongle
// (service FFF0, notify FFF1 / write FFF2) so the MotorLog app's CONNECT
// path works against it. Uses the Arduino BLE wrapper (Bluedroid): the
// library's own SPP server crashes this core's BT stack on the connect
// event (null memcpy in btc_gatts_cb_handler). Init runs FIRST in setup —
// btStart needs a big contiguous heap block, before WiFi/cell fragment it.
// Responses come from the main loop's sample cache; BLE callbacks only
// queue bytes — they never touch the OBD link.
#include "ble_bridge.h"
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <esp_bt.h>

BleLive bleLive;

static BLECharacteristic* notifyChar = nullptr;
static BLEAdvertising* adv = nullptr;
// Lock-free single-producer (BT task) / single-consumer (loop) byte ring.
// No heap, no critical sections — heap ops with interrupts masked can
// deadlock across cores and freeze the radio mid-connection.
static char rxRing[512];
static volatile uint16_t rxHead = 0, rxTail = 0;
static volatile bool connected = false;

class SrvCb : public BLEServerCallbacks {
  void onConnect(BLEServer*) override { connected = true; Serial.println("[BLE] phone connected"); }
  void onDisconnect(BLEServer*) override {
    connected = false;
    Serial.println("[BLE] phone disconnected");
    if (adv) adv->start();
  }
};

class RxCb : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    std::string v = c->getValue();
    for (char ch : v) {
      uint16_t next = (rxHead + 1) % sizeof(rxRing);
      if (next == rxTail) break;             // ring full: drop, never block
      rxRing[rxHead] = ch;
      rxHead = next;
    }
  }
};

// Dedicated task: the main loop can vanish into multi-second cellular/WiFi
// work, but the phone's ELM protocol expects answers within ~1s. Everything
// this task touches is cache or lock-free — never the OBD link.
static void bleTask(void*) {
  for (;;) {
    bleBridgeProcess();
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}

void bleBridgeInit(const char* name) {
  // BLE-only: hand Classic-BT's controller arena (~45KB) back to the heap
  // BEFORE the controller starts — WiFi can't init without it
  esp_bt_controller_mem_release(ESP_BT_MODE_CLASSIC_BT);
  BLEDevice::init(name);
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new SrvCb());
  BLEService* svc = server->createService(BLEUUID((uint16_t)0xFFF0));
  notifyChar = svc->createCharacteristic(BLEUUID((uint16_t)0xFFF1),
    BLECharacteristic::PROPERTY_NOTIFY);
  notifyChar->addDescriptor(new BLE2902());
  BLECharacteristic* wr = svc->createCharacteristic(BLEUUID((uint16_t)0xFFF2),
    BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  wr->setCallbacks(new RxCb());
  svc->start();
  adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(BLEUUID((uint16_t)0xFFF0));
  adv->setScanResponse(true);
  adv->start();
  xTaskCreatePinnedToCore(bleTask, "ble_elm", 6144, nullptr, 2, nullptr, 1);
  Serial.printf("[BLE] advertising \"%s\" (svc FFF0), free heap %u\n",
    name, (unsigned)ESP.getFreeHeap());
}

// notify in ≤20-byte chunks (default-MTU safe); the app accumulates until '>'
static void sendResp(const String& s) {
  if (!notifyChar || !connected) return;
  for (int i = 0; i < (int)s.length(); i += 20) {
    int n = min(20, (int)s.length() - i);
    notifyChar->setValue((uint8_t*)(s.c_str() + i), n);
    notifyChar->notify();
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
  static char cmdBuf[64];
  static uint8_t cmdLen = 0;
  while (rxTail != rxHead) {
    char ch = rxRing[rxTail];
    rxTail = (rxTail + 1) % sizeof(rxRing);
    if (ch == '\r' || ch == '\n') {
      if (cmdLen) {
        cmdBuf[cmdLen] = 0;
        cmdLen = 0;
        Serial.printf("[BLE] cmd: %s\n", cmdBuf);
        String resp = handleCommand(String(cmdBuf));
        if (resp.length()) sendResp(resp + "\r\r>");
      }
    } else if (cmdLen < sizeof(cmdBuf) - 1) {
      cmdBuf[cmdLen++] = ch;
    }
  }
}
