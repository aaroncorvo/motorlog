// BLE ELM327 bridge — advertises the FreematicsPlus SPP service (0xABF0,
// write FFE1 / notify FFE2) and emulates enough ELM327 for the MotorLog
// app's CONNECT path: live gauges + DTC read/clear from the phone while the
// firmware keeps logging and uploading on its own.
#pragma once
#include <Arduino.h>

struct BleLive {
  volatile int rpm = -1;         // -1 = unknown
  volatile int speedKph = -1;
  volatile int coolantC = -100;
  volatile int fuelPct = -1;
  volatile float battV = 0;
  volatile bool valid = false;   // false until OBD data flows
};
extern BleLive bleLive;

// implemented in motorlog.ino (main-loop context only)
int  bleReadDtcsHook(uint16_t* codes, int maxN);
bool bleClearDtcsHook();

void bleBridgeInit(const char* name);
void bleBridgeProcess();   // call every loop() pass; polls the command queue
