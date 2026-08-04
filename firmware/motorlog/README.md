# MotorLog firmware (Freematics ONE+ Model B)

Minimal telematics node: OBD-II + GNSS → batched JSON → the
`ingest-telemetry` edge function, with app-managed config pull.

Build home: clone https://github.com/stanleyhuangyc/Freematics next to the
app repo and copy this folder to `Freematics/firmware_v5/motorlog/` (the
`lib_extra_dirs = ../../libraries` path expects to live inside their tree).

1. `cp secrets.h.example secrets.h` and fill in WiFi + the device key
   (provisioned key's sha256 must exist in the `devices` table).
2. `pio run` — build
3. `pio run -t upload` — flash over USB
4. `pio device monitor` — watch [WIFI]/[GNSS]/[OBD]/[POST] lines

Config changes (interval, WiFi for the NEXT flash) are made in the app:
Settings → Devices → CONFIG. The device pulls config hourly and at boot.

## Cellular status (SIM7670G, Hologram) — WORKING

Registered on AT&T LTE, network-clock synced, HTTPS POSTs delivering.

The one obstacle was a CA-trust mismatch, diagnosed by probing three URLs from
the device: plain HTTP returned 200, TLS to Netlify returned 404 (a real HTTP
response, so the handshake succeeded), and TLS to Supabase returned +HTTPACTION
715 (handshake failure). Supabase is signed by Google Trust Services; Netlify by
Let's Encrypt. This modem's CA store carries ISRG but not the newer GTS roots.

Fix: cellular traffic goes to `https://motorlog.netlify.app/api/ingest`
(netlify/functions/ingest.js), which terminates the device's TLS on a CA it
trusts and forwards to the ingest-telemetry edge function over Netlify's own
verified TLS. The device key stays inside the encrypted body on both hops.
WiFi still posts to Supabase directly.
