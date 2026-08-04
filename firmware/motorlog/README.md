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

## Cellular status (SIM7670G, Hologram)

Working: SIM detected, LTE registration on AT&T band 2 (RSSI ~-89 dBm),
network-clock sync, and **plain-HTTP POST returns 200** over cellular.

Blocked: **HTTPS returns +HTTPACTION 715 (TLS handshake failure)** against
Supabase on every SSL config tried — sslversion 3 (TLS1.2) and 4 (any),
authmode 0, enableSNI 1, ignorelocaltime 1, and modem defaults. Since plain
HTTP succeeds on the same connection, the data path is fine; the modem's TLS
stack is the blocker (firmware V1.9.04).

Options to resolve, in order of preference:
1. Load a CA bundle onto the modem (AT+CCERTDOWN) and set authmode 1 — some
   SIM7670G builds fail handshake when no CA is present rather than skipping
   verification as authmode 0 implies.
2. Update the SIM7670G module firmware (SIMCom release newer than V1.9.04).
3. An HTTP-only ingest endpoint fronted by a TLS-terminating proxy — rejected
   for now: it would put the device key on the wire in the clear.

Until then the device runs WiFi + SD spooling: full trips are captured to the
card regardless of length and delivered whenever it's back in WiFi range.
