import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { fmt } from '../lib/calc.js'

const MI = 0.621371

const dur = (t) => {
  if (!t.ended_at) return '—'
  const m = Math.round((new Date(t.ended_at) - new Date(t.started_at)) / 60000)
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}

// Per-trip engine stats pulled from the trip's own telemetry rows on expand
function useTripStats(tripId, open) {
  const [stats, setStats] = useState(null)
  useEffect(() => {
    if (!open || stats) return
    let live = true
    supabase.from('telemetry')
      .select('rpm,coolant_c,fuel_pct,batt_v,speed_kph,source')
      .eq('trip_id', tripId).order('ts')
      .then(({ data }) => {
        if (!live || !data) return
        const obd = data.filter(r => r.rpm != null)
        const fuel = data.map(r => r.fuel_pct).filter(v => v != null)
        const cool = data.map(r => r.coolant_c).filter(v => v != null)
        const volt = data.map(r => r.batt_v).filter(v => v != null)
        setStats({
          samples: data.length,
          obdSamples: obd.length,
          maxRpm: obd.length ? Math.max(...obd.map(r => r.rpm)) : null,
          fuelStart: fuel.length ? fuel[0] : null,
          fuelEnd: fuel.length ? fuel[fuel.length - 1] : null,
          maxCoolant: cool.length ? Math.max(...cool) : null,
          minVolt: volt.length ? Math.min(...volt) : null,
          source: data[0]?.source || 'device',
        })
      })
    return () => { live = false }
  }, [open, tripId, stats])
  return stats
}

function TripRow({ t }) {
  const [open, setOpen] = useState(false)
  const stats = useTripStats(t.id, open)
  const miles = t.distance_km ? t.distance_km * MI : null
  return (
    <div className="triprow" onClick={() => setOpen(o => !o)}>
      <div className="logrow" style={{ borderBottom: 'none', cursor: 'pointer' }}>
        <div className="lmain">
          <div className="lt">
            {new Date(t.started_at).toLocaleString('en-US', {
              month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            })}
          </div>
          <div className="ls" style={{ fontFamily: 'var(--font-mono)' }}>
            {dur(t)}{t.max_speed_kph ? ` · ${Math.round(t.max_speed_kph * MI)} mph max` : ''}
            <span style={{ color: 'var(--amber)' }}>{open ? ' · hide' : ' · details ▸'}</span>
          </div>
        </div>
        <div className="lnum">
          <div className="ln1">{miles ? miles.toFixed(1) + ' mi' : '—'}</div>
        </div>
      </div>
      {open && (
        <div className="tripdetail">
          {!stats ? <div className="note">loading…</div> : (
            <>
              <div className="gauges">
                <div className="gauge">
                  <div className="gv">{stats.fuelStart != null
                    ? `${Math.round(stats.fuelStart)}→${Math.round(stats.fuelEnd)}%` : '—'}</div>
                  <div className="gl">Fuel Level</div>
                </div>
                <div className="gauge">
                  <div className="gv amber">{stats.maxRpm ? fmt.num(stats.maxRpm) : '—'}</div>
                  <div className="gl">Peak RPM</div>
                </div>
                <div className="gauge">
                  <div className="gv">{stats.maxCoolant != null
                    ? Math.round(stats.maxCoolant * 9 / 5 + 32) + '°F' : '—'}</div>
                  <div className="gl">Max Coolant</div>
                </div>
                <div className="gauge">
                  <div className="gv">{stats.minVolt != null ? stats.minVolt.toFixed(1) + 'V' : '—'}</div>
                  <div className="gl">Min Battery</div>
                </div>
              </div>
              <div className="note" style={{ marginTop: 8 }}>
                {new Date(t.started_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                {' → '}
                {t.ended_at ? new Date(t.ended_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '…'}
                {' · '}{stats.samples} samples ({stats.obdSamples} with engine data)
                {' · via '}{stats.source === 'phone' ? 'phone' : 'vehicle device'}
                {t.start_lat ? ` · from ${t.start_lat.toFixed(3)},${t.start_lon.toFixed(3)}` : ''}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// Rolling driving stats across every recorded trip for the vehicle
function StatsStrip({ vehicle }) {
  const [st, setSt] = useState(null)
  useEffect(() => {
    let live = true
    supabase.from('trips')
      .select('started_at,ended_at,distance_km,max_speed_kph')
      .eq('vehicle_id', vehicle.id).order('started_at', { ascending: false }).limit(1000)
      .then(({ data }) => {
        if (!live || !data?.length) return
        const cutoff = Date.now() - 30 * 86400000
        let miles30 = 0, trips30 = 0, driveMin30 = 0, topSpeed = 0
        for (const t of data) {
          if (t.max_speed_kph > topSpeed) topSpeed = t.max_speed_kph
          if (new Date(t.started_at).getTime() >= cutoff) {
            trips30++
            miles30 += (t.distance_km || 0) * MI
            if (t.ended_at) driveMin30 += (new Date(t.ended_at) - new Date(t.started_at)) / 60000
          }
        }
        setSt({ trips30, miles30, driveMin30, topSpeed })
      })
    return () => { live = false }
  }, [vehicle.id])
  if (!st) return null
  const h = Math.floor(st.driveMin30 / 60), m = Math.round(st.driveMin30 % 60)
  return (
    <div className="gauges" style={{ marginBottom: 12 }}>
      <div className="gauge"><div className="gv">{st.trips30}</div><div className="gl">Trips · 30d</div></div>
      <div className="gauge"><div className="gv amber">{st.miles30.toFixed(0)}</div><div className="gl">Miles · 30d</div></div>
      <div className="gauge"><div className="gv">{h ? `${h}h ${m}m` : `${m}m`}</div><div className="gl">Drive Time · 30d</div></div>
      <div className="gauge"><div className="gv">{st.topSpeed ? Math.round(st.topSpeed * MI) : '—'}</div><div className="gl">Top Speed mph</div></div>
    </div>
  )
}

// Trips reconstructed from device/phone telemetry. Distance requires GPS
// positions; OBD-only trips still carry duration and engine stats.
export default function TripsPanel({ vehicle }) {
  const [trips, setTrips] = useState(null)   // null = telematics not set up
  const [all, setAll] = useState(false)

  useEffect(() => {
    let live = true
    supabase.from('trips').select('*')
      .eq('vehicle_id', vehicle.id)
      .order('started_at', { ascending: false })
      .limit(all ? 500 : 8)
      .then(({ data, error }) => { if (live) setTrips(error ? null : (data || [])) })
    return () => { live = false }
  }, [vehicle.id, all])

  if (trips === null) return null
  if (!trips.length) return (
    <div className="card"><div className="note">
      No trips recorded yet. Drive with the vehicle device installed (or record
      from the phone via the OBD panel) and trips appear automatically.
    </div></div>
  )

  // group by month with totals when showing everything
  const groups = []
  if (all) {
    let cur = null
    for (const t of trips) {
      const key = new Date(t.started_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      if (!cur || cur.key !== key) { cur = { key, trips: [], miles: 0 }; groups.push(cur) }
      cur.trips.push(t)
      cur.miles += (t.distance_km || 0) * MI
    }
  }

  return (
    <div className="card">
      <StatsStrip vehicle={vehicle} />
      {!all
        ? trips.map(t => <TripRow key={t.id} t={t} />)
        : groups.map(g => (
            <div key={g.key}>
              <div className="tripmonth">
                <span>{g.key}</span>
                <span>{g.trips.length} trips · {g.miles.toFixed(1)} mi</span>
              </div>
              {g.trips.map(t => <TripRow key={t.id} t={t} />)}
            </div>
          ))}
      <button className="btn2" style={{ marginTop: 10 }} onClick={() => setAll(a => !a)}>
        {all ? 'SHOW RECENT ONLY' : 'VIEW ALL TRIPS'}
      </button>
      <div className="note" style={{ marginTop: 10 }}>
        Distance needs GPS; engine stats come from OBD. Mileage-log CSV export
        is in Settings → Export.
      </div>
    </div>
  )
}
