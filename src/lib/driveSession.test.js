import { describe, it, expect } from 'vitest'
import { sampleFromReadings } from './driveSession.js'

const NOW = 1785800000000   // fixed epoch ms

describe('sampleFromReadings — fusing dongle PIDs with phone GPS', () => {
  it('maps decoded PIDs back to storage units', () => {
    const s = sampleFromReadings({ '0C': 1750, '05': 192, '2F': 63, '42': 14.1 }, null, NOW)
    expect(s.ts).toBe(1785800000)
    expect(s.rpm).toBe(1750)
    expect(s.engine_on).toBe(true)
    expect(s.coolant_c).toBe(89)          // 192°F displayed → 89°C stored
    expect(s.fuel_pct).toBe(63)
    expect(s.batt_v).toBe(14.1)
  })

  it('marks engine off at zero rpm', () => {
    expect(sampleFromReadings({ '0C': 0 }, null, NOW).engine_on).toBe(false)
  })

  it('adds phone position, converting m/s to km/h', () => {
    const pos = { coords: { latitude: 30.5083, longitude: -97.6789, speed: 20, heading: 180, accuracy: 5 } }
    const s = sampleFromReadings({ '0C': 900 }, pos, NOW)
    expect(s.lat).toBeCloseTo(30.5083, 4)
    expect(s.lon).toBeCloseTo(-97.6789, 4)
    expect(s.speed_kph).toBeCloseTo(72, 5)
    expect(s.heading).toBe(180)
    expect(s.hdop).toBeCloseTo(1, 5)
  })

  it('drops the sentinel values phones use for unknown speed/heading', () => {
    const pos = { coords: { latitude: 30.5, longitude: -97.6, speed: -1, heading: -1, accuracy: 10 } }
    const s = sampleFromReadings(null, pos, NOW)
    expect(s.speed_kph).toBeUndefined()
    expect(s.heading).toBeUndefined()
    expect(s.lat).toBe(30.5)
  })

  it('works with GPS only (no dongle) and PIDs only (no GPS)', () => {
    const gpsOnly = sampleFromReadings(null, { coords: { latitude: 1, longitude: 2 } }, NOW)
    expect(gpsOnly.rpm).toBeUndefined()
    expect(gpsOnly.lat).toBe(1)
    const obdOnly = sampleFromReadings({ '0C': 800 }, null, NOW)
    expect(obdOnly.lat).toBeUndefined()
    expect(obdOnly.rpm).toBe(800)
  })

  it('omits absent readings rather than writing nulls', () => {
    const s = sampleFromReadings({ '0C': 700, '05': null, '2F': null, '42': null }, null, NOW)
    expect(Object.keys(s).sort()).toEqual(['engine_on', 'rpm', 'ts'])
  })
})
