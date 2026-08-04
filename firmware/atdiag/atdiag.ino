// Modem AT diagnostic for Freematics ONE+ (SIM7670G).
// Powers the modem, then runs a scripted interrogation:
// SIM presence, signal, current network state, and a full operator scan.
#include <FreematicsPlus.h>

FreematicsESP32 sys;
char buf[2048];

void at(const char* cmd, unsigned int timeout = 3000) {
  Serial.print(">> "); Serial.println(cmd);
  sys.xbPurge();
  sys.xbWrite(cmd); sys.xbWrite("\r");
  unsigned long t0 = millis();
  while (millis() - t0 < timeout) {
    int n = sys.xbRead(buf, sizeof(buf) - 1, 500);
    if (n > 0) { buf[n] = 0; Serial.print(buf); }
  }
  Serial.println("----");
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n[ATDIAG] start");
  sys.begin(true, true);
  sys.xbBegin(115200);
  // wake the modem
  for (int i = 0; i < 10; i++) {
    sys.xbTogglePower(200);
    delay(3000);
    sys.xbPurge();
    sys.xbWrite("AT\r");
    int n = sys.xbRead(buf, sizeof(buf) - 1, 1000);
    if (n > 0 && strstr(buf, "OK")) { Serial.println("[ATDIAG] modem up"); break; }
  }
  at("ATE0");
  at("ATI");                    // model/firmware
  at("AT+CPIN?");               // SIM present/ready?
  at("AT+CICCID");              // SIM serial — proves electrical contact
  at("AT+CSQ");                 // signal quality (99,99 = no signal)
  at("AT+CFUN?");               // radio on?
  at("AT+CNMP?");               // network mode preference
  at("AT+CPSI?");               // serving cell
  at("AT+CREG?"); at("AT+CEREG?");
  Serial.println("[ATDIAG] scanning operators (60-120s)…");
  at("AT+COPS=?", 120000);      // visible networks — the antenna truth test
  Serial.println("[ATDIAG] done");
}

void loop() { delay(1000); }
