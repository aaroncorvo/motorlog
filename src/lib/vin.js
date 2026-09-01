// NHTSA vPIC VIN decoding (CORS-open, no key required).
import { localToday } from './calc.js'

const KEEP = [
  ['Series', 'Series'],
  ['Trim', 'Trim'],
  ['BodyClass', 'Body'],
  ['DriveType', 'Drive'],
  ['EngineModel', 'Engine'],
  ['EngineCylinders', 'Cylinders'],
  ['DisplacementL', 'Displacement (L)'],
  ['FuelTypePrimary', 'Fuel'],
  ['TransmissionStyle', 'Transmission'],
  ['TransmissionSpeeds', 'Trans Speeds'],
  ['GVWR', 'GVWR'],
  ['PlantCity', 'Plant City'],
  ['PlantCountry', 'Plant Country'],
  ['Manufacturer', 'Manufacturer'],
]

export async function decodeVin(vin) {
  const r = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`)
  if (!r.ok) throw new Error(`vPIC ${r.status}`)
  const d = (await r.json()).Results?.[0]
  if (!d || !d.Make) throw new Error('VIN could not be decoded')
  const specs = {}
  for (const [key, label] of KEEP) {
    const v = (d[key] || '').trim()
    if (v && v !== '0') specs[label] = v
  }
  return {
    year: d.ModelYear ? parseInt(d.ModelYear) : null,
    make: title(d.Make),
    model: d.Model || '',
    specs,
    decoded_at: localToday(),
  }
}

const title = (s) => (s || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
