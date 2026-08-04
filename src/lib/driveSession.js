import { supabase } from './supabase.js'
import { isNative } from './native.js'

// A recorded drive: engine data from the BLE dongle + position from the phone.
// The phone's GPS is far better placed than a dongle under the dash, and the
// phone's own data connection removes any dependence on the dongle's modem.
// Samples buffer in memory and upload in batches; a failed upload keeps the
// batch for the next attempt, so a tunnel or dead zone loses nothing.

const LIVE_PIDS = ['0C', '0D', '05', '2F', '42']
const UPLOAD_EVERY_MS = 30000
const MAX_BATCH = 400

export function sampleFromReadings(pids, pos, now = Date.now()) {
  const s = { ts: Math.round(now / 1000) }
  if (pids) {
    if (pids['0C'] != null) { s.rpm = pids['0C']; s.engine_on = pids['0C'] > 0 }
    if (pids['05'] != null) s.coolant_c = Math.round((pids['05'] - 32) * 5 / 9)  // UI decodes to °F
    if (pids['2F'] != null) s.fuel_pct = pids['2F']
    if (pids['42'] != null) s.batt_v = pids['42']
  }
  if (pos?.coords) {
    const c = pos.coords
    s.lat = c.latitude
    s.lon = c.longitude
    if (c.speed != null && c.speed >= 0) s.speed_kph = c.speed * 3.6
    if (c.heading != null && c.heading >= 0) s.heading = c.heading
    if (c.accuracy != null) s.hdop = c.accuracy / 5      // rough parity with HDOP scale
  }
  return s
}

export async function uploadBatch(vehicleId, batch, dtcs = null) {
  if (!batch.length) return { ok: true, accepted: 0 }
  const { data, error } = await supabase.functions.invoke('ingest-telemetry', {
    body: { vehicle_id: vehicleId, source: 'phone', batch, ...(dtcs?.length ? { dtcs } : {}) },
  })
  if (error) throw error
  if (data?.error) throw new Error(data.error)
  return data
}

export class DriveSession {
  constructor(conn, vehicleId, { onSample, onUpload, onError } = {}) {
    this.conn = conn
    this.vehicleId = vehicleId
    this.buffer = []
    this.uploaded = 0
    this.onSample = onSample
    this.onUpload = onUpload
    this.onError = onError
    this.watchId = null
    this.lastPos = null
    this.timer = null
    this.uploadTimer = null
    this.busy = false
  }

  async #startGps() {
    if (isNative()) {
      const { Geolocation } = await import('@capacitor/geolocation')
      await Geolocation.requestPermissions()
      this.watchId = await Geolocation.watchPosition(
        { enableHighAccuracy: true, timeout: 10000 },
        (pos, err) => { if (!err && pos) this.lastPos = pos },
      )
      this.gpsStop = async () => {
        const { Geolocation: G } = await import('@capacitor/geolocation')
        if (this.watchId) await G.clearWatch({ id: this.watchId })
      }
    } else if (navigator.geolocation) {
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => { this.lastPos = pos },
        () => {},
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 },
      )
      this.gpsStop = () => navigator.geolocation.clearWatch(this.watchId)
    }
  }

  async start() {
    // GPS-only mode (conn == null): no dongle on the phone — position samples
    // merge server-side with whatever the installed telematics device uploads
    // for the same vehicle (its GPS antenna may be buried under the dash).
    // check-engine snapshot at trip start: stored codes ride with the first
    // upload and raise dedupe-keyed alerts server-side
    try {
      const { stored } = this.conn ? await this.conn.readDtcs() : {}
      this.dtcs = stored?.length ? stored : null
    } catch { this.dtcs = null }
    await this.#startGps()
    this.timer = setInterval(async () => {
      if (this.busy) return
      this.busy = true
      try {
        const pids = this.conn ? await this.conn.readPids(LIVE_PIDS) : null
        const s = sampleFromReadings(pids, this.lastPos)
        // keep only samples that carry something worth storing
        if (s.rpm != null || s.lat != null) {
          if (this.buffer.length < MAX_BATCH * 3) this.buffer.push(s)
          this.onSample?.(s, this.buffer.length)
        }
      } catch (e) { this.onError?.(e) }
      this.busy = false
    }, 1000)

    this.uploadTimer = setInterval(() => this.flush(), UPLOAD_EVERY_MS)
  }

  async flush() {
    if (!this.buffer.length) return
    const batch = this.buffer.slice(0, MAX_BATCH)
    try {
      const res = await uploadBatch(this.vehicleId, batch, this.dtcs)
      this.dtcs = null                       // sent once
      this.buffer = this.buffer.slice(batch.length)
      this.uploaded += res?.accepted ?? batch.length
      this.onUpload?.(this.uploaded, this.buffer.length)
    } catch (e) {
      this.onError?.(e)          // keep the batch; retry on the next tick
    }
  }

  async stop() {
    clearInterval(this.timer); clearInterval(this.uploadTimer)
    this.timer = this.uploadTimer = null
    try { await this.gpsStop?.() } catch { /* watch already gone */ }
    await this.flush()
    return this.uploaded
  }
}
