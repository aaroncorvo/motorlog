import { supabase } from './supabase.js'

// Telemetry-derived odometer per vehicle: server-side telemetry_odometer()
// sums GPS trip distance since the last human-entered reading (fill-up or
// service), so it can only run AHEAD of the logs, never behind, and every
// fill-up re-anchors it. Fails open to {} when telematics isn't set up.
export async function fetchTelemetryOdos(vehicles) {
  const out = {}
  await Promise.all(vehicles.map(async (v) => {
    try {
      const { data, error } = await supabase.rpc('telemetry_odometer', { v_id: v.id })
      if (!error && typeof data === 'number' && data > 0) out[v.id] = data
    } catch { /* rpc missing pre-0017 */ }
  }))
  return out
}
