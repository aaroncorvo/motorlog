#include "http_transport.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

// TODO(hardening): pin the Supabase CA instead of setInsecure(). The payload
// is still authenticated by the per-device key; this only affects transport
// privacy against an active MITM on the local network.
static int run(const char* url, const char* anonKey, const char* deviceKey,
               const String* postBody, String* out) {
  // With BLE resident, TLS buffers may not fit — running out mid-alloc
  // aborts the whole chip (uncaught bad_alloc). Bail early; the cellular
  // fallback in postBody() carries the traffic instead.
  if (ESP.getMaxAllocHeap() < 50000) return -1;
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  if (!http.begin(client, url)) return -1;
  http.addHeader("apikey", anonKey);
  http.addHeader("x-device-key", deviceKey);
  http.setTimeout(8000);
  int code;
  if (postBody) {
    http.addHeader("Content-Type", "application/json");
    code = http.POST(*postBody);
  } else {
    code = http.GET();
  }
  if (out && code == 200) *out = http.getString();
  http.end();
  return code;
}

int mlPost(const char* url, const char* anonKey, const char* deviceKey, const String& body) {
  return run(url, anonKey, deviceKey, &body, nullptr);
}
int mlGet(const char* url, const char* anonKey, const char* deviceKey, String& out) {
  return run(url, anonKey, deviceKey, nullptr, &out);
}
