import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { fmt } from '../lib/calc.js'

const MI_PER_KM = 0.621371

// Trips reconstructed from device telemetry. Distance appears only when the
// trip carried GPS positions; OBD-only trips still show duration and engine
// data, which is what the under-dash antenna situation gives us today.
export default function TripsPanel({ vehicle }) {
  const [trips, setTrips] = useState(null)   // null = table missing (0015/0017)
  const [stats, setStats] = useState({})

  useEffect(() => {
    let live = true
    ;(async () => {
      const { data, error } = await supabase
        .from('trips').select('*')
        .eq('vehicle_id', vehicle.id)
        .order('started_at', { ascending: false })
        .limit(10)
      if (!live) return
      if (error) { setTrips(null); return }
      setTrips(data || [])
      // engine stats per trip come from the telemetry rows themselves
      const ids = (data || []).map(t => t.id)
      if (ids.length) {
        const { data: tel } = await supabase
          .from('telemetry').select('trip_id,rpm,coolant_c,batt_v')
          .in('trip_id', ids).not('rpm', 'is', null)
        const by = {}
        for (const r of tel || []) {
          const s = by[r.trip_id] ||= { maxRpm: 0, maxCoolant: null, minV: null }
          if (r.rpm > s.maxRpm) s.maxRpm = r.rpm
          if (r.coolant_c != null && (s.maxCoolant == null || r.coolant_c > s.maxCoolant)) s.maxCoolant = r.coolant_c
          if (r.batt_v != null && (s.minV == null || r.batt_v < s.minV)) s.minV = r.batt_v
        }
        if (live) setStats(by)
      }
    })()
    return () => { live = false }
  }, [vehicle.id])

  if (trips === null) return null            // telematics not set up — hide
  if (!trips.length) return (
    <div className="card">
      <div className="note">
        No trips recorded yet. Trips appear automatically after the device logs
        a drive and uploads it.
      </div>
    </div>
  )

  const dur = (t) => {
    if (!t.ended_at) return '—'
    const m = Math.round((new Date(t.ended_at) - new Date(t.started_at)) / 60000)
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
  }

  return (
    <div className="card">
      {trips.map(t => {
        const s = stats[t.id] || {}
        const miles = t.distance_km ? t.distance_km * MI_PER_KM : null
        return (
          <div className="logrow" key={t.id}>
            <div className="lmain">
              <div className="lt">
                {new Date(t.started_at).toLocaleString('en-US', {
                  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                })}
              </div>
              <div className="ls" style={{ fontFamily: 'var(--font-mono)' }}>
                {dur(t)}
                {s.maxRpm ? ` · ${fmt.num(s.maxRpm)} rpm peak` : ''}
                {s.maxCoolant != null ? ` · ${Math.round(s.maxCoolant * 9 / 5 + 32)}°F` : ''}
                {s.minV != null ? ` · ${s.minV.toFixed(1)}V` : ''}
              </div>
            </div>
            <div className="lnum">
              <div className="ln1">{miles ? miles.toFixed(1) + ' mi' : '—'}</div>
              {t.max_speed_kph ? (
                <div className="ln2">{Math.round(t.max_speed_kph * MI_PER_KM)} mph</div>
              ) : null}
            </div>
          </div>
        )
      })}
      <div className="note" style={{ marginTop: 10 }}>
        Distance needs GPS positions; engine data comes from OBD. Trips are
        segmented on 5-minute gaps.
      </div>
    </div>
  )
}
