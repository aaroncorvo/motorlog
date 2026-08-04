// Capacitor BLE transport for ELM327 dongles (iOS + Android).
// The protocol layer in obd.js — init sequence, PID decoding, DTC parsing — is
// transport-agnostic and shared verbatim; only the plumbing differs from Web
// Bluetooth. iOS has no Web Bluetooth at all, which is precisely why the native
// wrapper exists.
import { OBD_SERVICES, INIT_COMMANDS, parsePid, decodeDtcs } from './obd.js'

const enc = new TextEncoder()
const dec = new TextDecoder()

// Normalize the 16-bit shorthand the ELM327 world uses into full 128-bit UUIDs
const full = (u) => {
  const s = String(u)
  if (s.includes('-')) return s.toLowerCase()
  const hex = typeof u === 'number' ? u.toString(16) : s
  return `0000${hex.padStart(4, '0')}-0000-1000-8000-00805f9b34fb`.toLowerCase()
}

export class NativeObdConnection {
  constructor() {
    this.deviceId = null
    this.service = null
    this.writeChar = null
    this.notifyChar = null
    this.buffer = ''
    this.pending = null
    this.ble = null
  }

  async #client() {
    if (!this.ble) {
      const { BleClient } = await import('@capacitor-community/bluetooth-le')
      await BleClient.initialize({ androidNeverForLocation: true })
      this.ble = BleClient
    }
    return this.ble
  }

  async connect() {
    const ble = await this.#client()
    const services = OBD_SERVICES.map(full)
    const device = await ble.requestDevice({ optionalServices: services })
    await ble.connect(device.deviceId, () => { this.deviceId = null })
    this.deviceId = device.deviceId

    // find a service exposing a write + notify pair (dongles differ)
    const discovered = await ble.getServices(device.deviceId)
    for (const svc of discovered) {
      const w = svc.characteristics.find(c => c.properties.write || c.properties.writeWithoutResponse)
      const n = svc.characteristics.find(c => c.properties.notify)
      if (w && n) {
        this.service = svc.uuid; this.writeChar = w.uuid; this.notifyChar = n.uuid
        break
      }
    }
    if (!this.service) {
      await this.disconnect()
      throw new Error('No ELM327 service found — Bluetooth-Classic dongles are not supported')
    }

    await ble.startNotifications(this.deviceId, this.service, this.notifyChar, (value) => {
      this.buffer += dec.decode(value.buffer ?? value)
      if (this.buffer.includes('>') && this.pending) {
        const resolve = this.pending
        this.pending = null
        const out = this.buffer
        this.buffer = ''
        resolve(out)
      }
    })

    for (const cmd of INIT_COMMANDS) await this.send(cmd)
    return device.name || 'OBD-II'
  }

  send(cmd, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      if (!this.deviceId) return reject(new Error('Not connected'))
      this.buffer = ''
      const timer = setTimeout(() => {
        if (this.pending) { this.pending = null; resolve(this.buffer) }
      }, timeoutMs)
      this.pending = (v) => { clearTimeout(timer); resolve(v) }
      const data = new DataView(enc.encode(cmd + '\r').buffer)
      this.ble.write(this.deviceId, this.service, this.writeChar, data).catch(reject)
    })
  }

  async readPids(pids) {
    const out = {}
    for (const pid of pids) out[pid] = parsePid(await this.send('01' + pid), pid)
    return out
  }

  async readDtcs() {
    const stored = decodeDtcs(await this.send('03'), '43')
    const pending = decodeDtcs(await this.send('07'), '47')
    return { stored, pending }
  }

  async clearDtcs() { await this.send('04') }

  async disconnect() {
    try { if (this.deviceId) await this.ble?.disconnect(this.deviceId) } catch { /* already gone */ }
    this.deviceId = this.service = this.writeChar = this.notifyChar = null
  }
}
