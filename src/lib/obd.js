// ===== OBD-II over BLE (ELM327-compatible dongles) =====
// Protocol layer is pure and tested; the transport uses Web Bluetooth today
// (Chrome desktop/Android) and maps 1:1 onto @capacitor-community/bluetooth-le
// for the iOS app later. BLE dongles only (Vgate iCar Pro BLE, OBDLink CX,
// Veepeak BLE+) — Bluetooth-Classic ELM327s can't talk to iPhones anyway.

import { isNative } from './native.js'

// Known BLE UART-ish services used by ELM327 BLE dongles
// 0xABF0 is the Freematics SPP service — our own dongle firmware (ml-0.6+)
// bridges ELM327 over it (write FFE1 / notify FFE2)
export const OBD_SERVICES = [0xFFF0, 0xFFE0, 0xABF0, '0000fff0-0000-1000-8000-00805f9b34fb', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2']

export const INIT_COMMANDS = ['ATZ', 'ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATSP0']

// Live-data PIDs we poll (mode 01)
export const PIDS = {
  '0C': { label: 'RPM', unit: '', decode: (a, b) => Math.round(((a << 8) + b) / 4) },
  '0D': { label: 'Speed', unit: 'mph', decode: (a) => Math.round(a * 0.621371) },
  '05': { label: 'Coolant', unit: '°F', decode: (a) => Math.round((a - 40) * 9 / 5 + 32) },
  '2F': { label: 'Fuel', unit: '%', decode: (a) => Math.round(a * 100 / 255) },
  '42': { label: 'Battery', unit: 'V', decode: (a, b) => Math.round(((a << 8) + b) / 10) / 100 },
  '0F': { label: 'Intake', unit: '°F', decode: (a) => Math.round((a - 40) * 9 / 5 + 32) },
}

// Strip ELM chatter: echoes, prompt '>', CR/LF, SEARCHING..., whitespace
export function cleanElm(raw) {
  return String(raw)
    .replace(/SEARCHING\.*/gi, '')
    .replace(/[\r\n>]/g, '')
    .replace(/\s+/g, '')
    .toUpperCase()
}

// Parse a mode-01 response for a given PID: '410C1AF8' → decoded value.
// Returns null on NO DATA / errors / wrong echo.
export function parsePid(raw, pid) {
  const s = cleanElm(raw)
  if (!s || s.includes('NODATA') || s.includes('ERROR') || s.includes('?')) return null
  const marker = '41' + pid.toUpperCase()
  const i = s.indexOf(marker)
  if (i < 0) return null
  const data = s.slice(i + marker.length)
  const a = parseInt(data.slice(0, 2), 16)
  const b = parseInt(data.slice(2, 4), 16)
  if (Number.isNaN(a)) return null
  const def = PIDS[pid.toUpperCase()]
  return def ? def.decode(a, Number.isNaN(b) ? 0 : b) : null
}

// Decode mode-03 (stored, '43') or mode-07 (pending, '47') DTC responses.
// Handles CAN (count byte first) and legacy (zero-padded) framings.
export function decodeDtcs(raw, marker = '43') {
  const s = cleanElm(raw)
  const i = s.indexOf(marker)
  if (i < 0) return []
  let data = s.slice(i + marker.length)
  // CAN frames include a count byte; if it matches the remaining pair count, drop it
  if (data.length >= 2) {
    const maybeCount = parseInt(data.slice(0, 2), 16)
    const pairsAfter = Math.floor((data.length - 2) / 4)
    if (maybeCount > 0 && maybeCount <= 8 && maybeCount === pairsAfter) data = data.slice(2)
  }
  const out = []
  for (let p = 0; p + 4 <= data.length; p += 4) {
    const chunk = data.slice(p, p + 4)
    if (chunk === '0000') continue
    const first = parseInt(chunk[0], 16)
    if (Number.isNaN(first)) break
    const letter = ['P', 'C', 'B', 'U'][first >> 2]
    out.push(letter + (first & 3).toString(10) + chunk.slice(1))
  }
  return out
}

// ===== Transport selection =====
// Web Bluetooth on desktop/Android browsers; Capacitor BLE in the native apps
// (iOS has no Web Bluetooth — the reason the wrapper exists).
export function bleSupported() {
  if (isNative()) return true
  return typeof navigator !== 'undefined' && !!navigator.bluetooth
}

// Returns a connection object with a common interface: connect(), send(),
// readPids(), readDtcs(), clearDtcs(), disconnect().
export async function createObdConnection() {
  if (isNative()) {
    const { NativeObdConnection } = await import('./obdNative.js')
    return new NativeObdConnection()
  }
  return new ObdConnection()
}

export class ObdConnection {
  constructor() {
    this.device = null
    this.writeChar = null
    this.notifyChar = null
    this.buffer = ''
    this.pending = null
  }

  // allDevices: fallback chooser showing every BLE device in range, for dongles
  // advertising nonstandard service UUIDs. A Bluetooth-Classic ELM327 will never
  // appear in either chooser — that's the compatibility tell.
  async connect(allDevices = false) {
    this.device = await navigator.bluetooth.requestDevice(
      allDevices
        ? { acceptAllDevices: true, optionalServices: OBD_SERVICES }
        : { filters: OBD_SERVICES.map(s => ({ services: [s] })), optionalServices: OBD_SERVICES },
    )
    const server = await this.device.gatt.connect()
    // find a service exposing a notify + write pair
    for (const svcId of OBD_SERVICES) {
      try {
        const svc = await server.getPrimaryService(svcId)
        const chars = await svc.getCharacteristics()
        this.notifyChar = chars.find(c => c.properties.notify)
        this.writeChar = chars.find(c => c.properties.write || c.properties.writeWithoutResponse)
        if (this.notifyChar && this.writeChar) break
      } catch { /* service absent on this dongle; try next */ }
    }
    if (!this.notifyChar || !this.writeChar) {
      throw new Error('This device has no ELM327 service — it may be a Bluetooth-Classic dongle (not BLE), which browsers and iPhones cannot use')
    }
    await this.notifyChar.startNotifications()
    this.notifyChar.addEventListener('characteristicvaluechanged', (e) => {
      this.buffer += new TextDecoder().decode(e.target.value)
      if (this.buffer.includes('>') && this.pending) {
        const { resolve } = this.pending
        this.pending = null
        const out = this.buffer
        this.buffer = ''
        resolve(out)
      }
    })
    for (const cmd of INIT_COMMANDS) await this.send(cmd)
    return this.device.name || 'OBD-II'
  }

  send(cmd, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      if (!this.writeChar) return reject(new Error('Not connected'))
      this.buffer = ''
      this.pending = { resolve }
      const t = setTimeout(() => {
        if (this.pending) { this.pending = null; resolve(this.buffer) }
      }, timeoutMs)
      const done = this.pending.resolve
      this.pending.resolve = (v) => { clearTimeout(t); done(v) }
      this.writeChar.writeValue(new TextEncoder().encode(cmd + '\r')).catch(reject)
    })
  }

  async readPids(pids) {
    const out = {}
    for (const pid of pids) {
      out[pid] = parsePid(await this.send('01' + pid), pid)
    }
    return out
  }

  async readDtcs() {
    const stored = decodeDtcs(await this.send('03'), '43')
    const pending = decodeDtcs(await this.send('07'), '47')
    return { stored, pending }
  }

  // Mode 04: clears codes AND resets emissions readiness monitors.
  async clearDtcs() {
    await this.send('04')
  }

  disconnect() {
    try { this.device?.gatt?.disconnect() } catch { /* already gone */ }
    this.device = this.writeChar = this.notifyChar = null
  }
}
