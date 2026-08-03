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
