// WiFi HTTPS transport, isolated from FreematicsPlus headers because the
// Freematics library declares its own HTTPClient class (cellular) that
// collides with Arduino's. This unit includes only Arduino networking.
#pragma once
#include <Arduino.h>
int mlPost(const char* url, const char* anonKey, const char* deviceKey, const String& body);
int mlGet(const char* url, const char* anonKey, const char* deviceKey, String& out);
