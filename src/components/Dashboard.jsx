import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { computeMpg, fuelStats, currentOdometer, maintenanceStatus, tcoRollup, forecastMaintenance, fmt } from '../lib/calc.js'
import { photoUrls, primaryPhoto } from '../lib/vehiclePhotos.js'
import { decodeVin } from '../lib/vin.js'
import { PartLine } from './MaintenanceScreen.jsx'
import { planStatus } from '../lib/plan.js'
import { listReminders } from '../lib/reminders.js'

const DAY = 86400000

export default function Dashboard({ vehicles, fuelLogs, serviceLogs, maintItems, fixedCosts, docs, photos, recalls, plan, telemOdos, setVid, refresh, showToast, goTab }) {
  const [thumbs, setThumbs] = useState({})
  const [addOpen, setAddOpen] = useState(false)
  const [reminders, setReminders] = useState([])

  // Self-fetched (App.jsx is owned by another agent): reminders merge into the
  // calendar + agenda alongside maintenance forecasts and doc expiries.
  // Any error (e.g. 0014 not applied yet) degrades silently to no events.
  useEffect(() => {
    let live = true
    listReminders().then(({ data, error }) => {
      if (live) setReminders(error ? [] : (data || []))
    }).catch(() => { if (live) setReminders([]) })
    return () => { live = false }
  }, [])

  // one signed-URL batch for the dashboard thumbnails
  const primaries = vehicles.map(v => primaryPhoto(photos || [], v.id)).filter(Boolean)
  useEffect(() => {
    let live = true
    photoUrls(primaries).then(m => { if (live) setThumbs(m) }).catch(() => {})
    return () => { live = false }
  }, [photos]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fleet-level totals
  let fleetFuel = 0, fleetSvc = 0
  for (const l of fuelLogs) fleetFuel += Number(l.total_cost || 0)
  for (const s of serviceLogs) fleetSvc += Number(s.cost || 0)
  const openRecalls = (recalls || []).filter(r => r.status === 'open').length

  // Every tracked interval projected to a calendar date, fleet-wide
  const events = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const maint = forecastMaintenance(vehicles, fuelLogs, serviceLogs, maintItems, today, telemOdos || {})
      .map(f => ({
        date: f.dueDate, overdue: f.overdue,
        vehicle: f.vehicle, title: f.item.name, basis: f.basis, kind: 'maint',
        item: f.item,
      }))
    const docEvents = (docs || []).filter(d => d.expires_on).map(d => {
      const date = new Date(d.expires_on + 'T00:00:00')
      return {
        date, overdue: date < today,
        vehicle: vehicles.find(v => v.id === d.vehicle_id) || null,
        title: `${d.label || d.kind} expires`, basis: d.holder || null, kind: 'doc',
      }
    })
    const reminderEvents = reminders
      .filter(r => !r.completed_at) // recurring roll their due_date; only non-recurring get completed_at
      .map(r => {
        const date = new Date(r.due_date + 'T00:00:00')
        return {
          date, overdue: date < today,
          vehicle: vehicles.find(v => v.id === r.vehicle_id) || null, // null = fleet-wide
          title: r.title, kind: 'reminder', basis: 'reminder',
        }
      })
    return [...maint, ...docEvents, ...reminderEvents].sort((a, b) => a.date - b.date)
  }, [vehicles, fuelLogs, serviceLogs, maintItems, docs, reminders, telemOdos])

  const overdueCount = events.filter(e => e.overdue).length
  const horizon = new Date(Date.now() + 90 * DAY)
  const upcoming = events.filter(e => !e.overdue && e.date <= horizon)

  return (
    <>
      <div className="statgrid">
        <div className="stat"><div className="sv">{fmt.money0(fleetFuel)}</div><div className="sl">Fuel Spend</div></div>
        <div className="stat"><div className="sv">{fmt.money0(fleetSvc)}</div><div className="sl">Service Spend</div></div>
        <div className="stat"><div className={'sv' + (overdueCount ? ' bad' : '')}>{overdueCount}</div><div className="sl">Overdue</div></div>
        <div className="stat"><div className={'sv' + (openRecalls ? ' bad' : '')}>{openRecalls}</div><div className="sl">Open Recalls</div></div>
      </div>

      <div className="section-label">Upcoming — Next 90 Days</div>
      <div className="card">
        <MiniCalendar events={events} />
        {overdueCount > 0 && (
          <div className="agenda-block">
            {events.filter(e => e.overdue).map((e, i) => <AgendaRow key={'od' + i} e={e} overdue />)}
          </div>
        )}
        {upcoming.length > 0 ? (
          <div className="agenda-block">
            {upcoming.slice(0, 8).map((e, i) => <AgendaRow key={i} e={e} />)}
            {upcoming.length > 8 && <div className="note" style={{ marginTop: 6 }}>+{upcoming.length - 8} more within 90 days</div>}
          </div>
        ) : overdueCount === 0 ? (
          <div className="note" style={{ marginTop: 10 }}>Nothing due in the next 90 days. Forecast dates come from each vehicle's rolling miles/day.</div>
        ) : null}
      </div>

      <div className="section-label">Cost Per Mile — Fleet Comparison</div>
      <div className="card">
        <TcoCompare vehicles={vehicles} fuelLogs={fuelLogs} serviceLogs={serviceLogs} fixedCosts={fixedCosts || []} />
      </div>

      <div className="section-label">Vehicles</div>
      {vehicles.map(v => {
        const p = primaryPhoto(photos || [], v.id)
        const vRecalls = (recalls || []).filter(r => r.vehicle_id === v.id && r.status === 'open').length
        return <VehicleCard key={v.id} v={v} thumb={p ? thumbs[p.file_path] : null} openRecalls={vRecalls}
          fuelLogs={fuelLogs} serviceLogs={serviceLogs} maintItems={maintItems}
          onOpen={() => { setVid(v.id); goTab('Vehicle') }} />
      })}

      {addOpen ? (
        <AddVehicleForm ownerId={vehicles[0]?.user_id} nextSort={vehicles.length + 1}
          onDone={async (saved) => { setAddOpen(false); if (saved) { showToast('VEHICLE ADDED'); await refresh() } }} />
      ) : (() => {
        const st = planStatus(plan, { vehicles: vehicles.length, members: 0 })
        return st.canAddVehicle
          ? <button className="btn2" onClick={() => setAddOpen(true)}>+ ADD VEHICLE BY VIN</button>
          : <div className="note" style={{ textAlign: 'center', padding: '10px 0' }}>
              Vehicle limit reached ({st.vehiclesUsed}/{st.maxVehicles} on the {st.tier} plan) — manage your plan in Settings.
            </div>
      })()}
    </>
  )
}

// Two-month grid: dots mark days with forecast events; red = overdue lands today.
function MiniCalendar({ events }) {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const months = [0, 1].map(off => new Date(today.getFullYear(), today.getMonth() + off, 1))

  // day-key → worst severity ('red' beats 'amber')
  const marks = {}
  for (const e of events) {
    const d = e.overdue ? today : e.date
    const k = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    if (e.overdue) marks[k] = 'red'
    else if (marks[k] !== 'red') marks[k] = 'amber'
  }

  return (
    <div className="calwrap">
      {months.map((m0, mi) => {
        const label = m0.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
        const firstDow = m0.getDay()
        const daysIn = new Date(m0.getFullYear(), m0.getMonth() + 1, 0).getDate()
        const cells = [...Array(firstDow).fill(null), ...Array.from({ length: daysIn }, (_, i) => i + 1)]
        return (
          <div className="cal" key={mi}>
            <div className="cal-title">{label}</div>
            <div className="cal-grid">
              {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={'h' + i} className="cal-dow">{d}</div>)}
              {cells.map((day, i) => {
                if (day == null) return <div key={'b' + i} />
                const isToday = mi === 0 && day === today.getDate()
                const mark = marks[`${m0.getFullYear()}-${m0.getMonth()}-${day}`]
                return (
                  <div key={i} className={'cal-day' + (isToday ? ' today' : '')}>
                    {day}
                    {mark && <span className={'cal-dot ' + mark} />}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function AgendaRow({ e, overdue }) {
  const [open, setOpen] = useState(false)
  const dstr = overdue ? 'NOW' : e.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()
  const hasDetail = e.item && (e.item.parts?.length > 0 || e.item.part_number || e.item.notes)
  return (
    <div className={'agenda-row' + (overdue ? ' overdue' : '') + (hasDetail ? ' expandable' : '')}
      onClick={hasDetail ? () => setOpen(o => !o) : undefined}>
      <div className="agenda-date">{dstr}</div>
      <div className="agenda-body">
        <div className="agenda-title">{e.title}</div>
        <div className="agenda-meta">
          {e.vehicle ? e.vehicle.name : 'Fleet'}
          {e.basis && !overdue ? ` · ${e.basis}` : ''}
          {hasDetail && <span className="agenda-more">{open ? ' · hide parts' : ' · parts ▸'}</span>}
        </div>
        {open && hasDetail && (
          <div className="plist" onClick={ev => ev.stopPropagation()}>
            {(e.item.parts || []).map((p, i) => <PartLine key={i} p={p} />)}
            {e.item.part_number && <div className="pline"><span className="pname">PN {e.item.part_number}</span></div>}
            {e.item.notes && <div className="pline">{e.item.notes}</div>}
          </div>
        )}
      </div>
      <span className={'cal-dot big ' + (overdue ? 'red' : 'amber')} />
    </div>
  )
}

// Per-vehicle $/mi rollup with proportional bars + annualized estimate
function TcoCompare({ vehicles, fuelLogs, serviceLogs, fixedCosts }) {
  const rows = vehicles.map(v => ({ v, t: tcoRollup(v, fuelLogs, serviceLogs, fixedCosts) }))
  const max = Math.max(...rows.map(r => r.t.totalCPM || 0), 0)
  if (max === 0) return <div className="note">Cost-per-mile comparison appears once fuel history spans 14+ days.</div>
  return (
    <>
      {rows.map(({ v, t }) => (
        <div className="tcorow" key={v.id}>
          <div className="tcorow-head">
            <span className="tcorow-name">{v.name}</span>
            <span className="tcorow-cpm">{t.totalCPM != null ? fmt.cpm(t.totalCPM) + '/mi' : 'no data'}</span>
            <span className="tcorow-yr">{t.annualEst != null ? fmt.money0(t.annualEst) + '/yr' : t.fixedAnnual ? fmt.money0(t.fixedAnnual) + '/yr fixed' : ''}</span>
          </div>
          {t.totalCPM != null && (
            <div className="tcobar">
              {t.fuelCPM != null && <div className="seg fuel" style={{ width: (t.fuelCPM / max * 100) + '%' }} />}
              {t.svcCPM != null && <div className="seg svc" style={{ width: (t.svcCPM / max * 100) + '%' }} />}
              {t.fixedCPM != null && <div className="seg fixed" style={{ width: (t.fixedCPM / max * 100) + '%' }} />}
            </div>
          )}
        </div>
      ))}
      <div className="tcokey">
        <span><i className="seg fuel" /> FUEL</span>
        <span><i className="seg svc" /> SERVICE</span>
        <span><i className="seg fixed" /> FIXED</span>
      </div>
    </>
  )
}

// Tiny inline MPG sparkline for the vehicle cards
function Sparkline({ points }) {
  if (points.length < 2) return null
  const W = 72, H = 22
  const min = Math.min(...points), max = Math.max(...points)
  const X = i => (i / (points.length - 1)) * (W - 4) + 2
  const Y = v => H - 3 - ((v - min) / (max - min || 1)) * (H - 6)
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true" style={{ display: 'block' }}>
      <path d={path} fill="none" stroke="var(--amber)" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" opacity="0.85" />
      <circle cx={X(points.length - 1)} cy={Y(points[points.length - 1])} r="2.2" fill="var(--amber)" />
    </svg>
  )
}

export function AddVehicleForm({ ownerId, nextSort, onDone }) {
  const [vin, setVin] = useState('')
  const [decoded, setDecoded] = useState(null)
  const [f, setF] = useState({ name: '', nickname: '', base_odometer: '', fuel_octane: '87 Regular' })
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setF(p => ({ ...p, [k]: v }))

  const decode = async () => {
    setBusy(true)
    try {
      const d = await decodeVin(vin.trim().toUpperCase())
      setDecoded(d)
      if (!f.name) set('name', (d.model || '').replace(/\s+/g, ''))
    } catch (e) { alert('Decode failed: ' + e.message) }
    setBusy(false)
  }

  const save = async () => {
    setBusy(true)
    const s = decoded.specs || {}
    const engine = [s['Engine'], s['Displacement (L)'] ? s['Displacement (L)'] + 'L' : null].filter(Boolean).join(' ')
    const { error } = await supabase.from('vehicles').insert({
      ...(ownerId ? { user_id: ownerId } : {}),
      name: f.name, nickname: f.nickname || null,
      year: decoded.year, make: decoded.make, model: decoded.model,
      vin: vin.trim().toUpperCase(), engine: engine || null,
      base_odometer: f.base_odometer ? parseInt(f.base_odometer) : 0,
      fuel_octane: f.fuel_octane || null, sort_order: nextSort,
      vin_decode: decoded,
    })
    setBusy(false)
    if (error) { alert(error.message); return }
    onDone(true)
  }

  return (
    <div className="card">
      <div className="field">
        <label>VIN</label>
        <input value={vin} onChange={e => setVin(e.target.value)} placeholder="17-character VIN"
          maxLength={17} style={{ textTransform: 'uppercase' }} />
      </div>
      {!decoded ? (
        <button className="btn" onClick={decode} disabled={busy || vin.trim().length < 11}>
          {busy ? 'DECODING…' : '⌕ DECODE VIN'}
        </button>
      ) : (
        <>
          <div className="note" style={{ margin: '4px 0 12px', color: 'var(--green)' }}>
            ✓ {decoded.year} {decoded.make} {decoded.model}
            {decoded.specs['Engine'] ? ` · ${decoded.specs['Engine']}` : ''} — {Object.keys(decoded.specs).length} specs pulled
          </div>
          <div className="frow">
            <div className="field">
              <label>Display Name</label>
              <input value={f.name} onChange={e => set('name', e.target.value)} />
            </div>
            <div className="field">
              <label>Nickname</label>
              <input value={f.nickname} onChange={e => set('nickname', e.target.value)} />
            </div>
          </div>
          <div className="frow">
            <div className="field">
              <label>Current Odometer</label>
              <input type="number" inputMode="numeric" value={f.base_odometer} onChange={e => set('base_odometer', e.target.value)} />
            </div>
            <div className="field">
              <label>Fuel Octane</label>
              <input value={f.fuel_octane} onChange={e => set('fuel_octane', e.target.value)} />
            </div>
          </div>
          <button className="btn" onClick={save} disabled={busy || !f.name}>{busy ? 'SAVING…' : 'ADD VEHICLE'}</button>
        </>
      )}
      <div style={{ height: 8 }} />
      <button className="btn2" onClick={() => onDone(false)}>CANCEL</button>
    </div>
  )
}

function VehicleCard({ v, thumb, openRecalls, fuelLogs, serviceLogs, maintItems, onOpen }) {
  const fs = fuelStats(fuelLogs, v.id)
  const odo = currentOdometer(v, fuelLogs, serviceLogs)
  const items = maintItems.filter(m => m.vehicle_id === v.id)
  const flagged = items
    .map(m => ({ m, st: maintenanceStatus(m, odo) }))
    .filter(x => x.st.status === 'overdue' || x.st.status === 'due-soon')
    .sort((a, b) => (a.st.status === 'overdue' ? 0 : 1) - (b.st.status === 'overdue' ? 0 : 1))

  const annualFuel = (fs?.milesPerYear && fs?.costPerMile) ? fs.milesPerYear * fs.costPerMile : null
  const mpgMap = computeMpg(fuelLogs)
  const trend = fuelLogs
    .filter(l => l.vehicle_id === v.id).sort((a, b) => a.odometer - b.odometer)
    .map(l => mpgMap.get(l.id)?.mpg).filter(m => m != null)

  return (
    <div className="card vcard" onClick={onOpen}>
      {thumb && (
        <img src={thumb} alt={v.name} style={{
          float: 'right', width: 56, height: 56, objectFit: 'cover',
          borderRadius: 3, border: '1px solid var(--line-bright)', marginLeft: 10,
        }} />
      )}
      <div className="vname">
        <b>{v.name}</b>
        {v.nickname && <span className="nick">"{v.nickname}"</span>}
      </div>
      <div className="vmeta">{v.year} {v.make} {v.model} · {v.engine}</div>
      <div className="gauges">
        <div className="gauge">
          <div className="gv">{fmt.num(odo)}</div>
          <div className="gl">Odometer</div>
        </div>
        <div className="gauge">
          <div className="gv amber">{fmt.mpg(fs?.aggMpg)}</div>
          <div className="gl">Avg MPG</div>
          {trend.length >= 2 && <Sparkline points={trend.slice(-10)} />}
        </div>
        <div className="gauge">
          <div className="gv">{fmt.cpm(fs?.costPerMile)}</div>
          <div className="gl">Fuel $/mi</div>
        </div>
        <div className="gauge">
          <div className="gv">{annualFuel ? fmt.money0(annualFuel) : '—'}</div>
          <div className="gl">Fuel /yr est</div>
        </div>
      </div>
      {(flagged.length > 0 || openRecalls > 0) && (
        <div className="flagrow">
          {openRecalls > 0 && (
            <span className="flag overdue">⚠ {openRecalls} OPEN RECALL{openRecalls > 1 ? 'S' : ''}</span>
          )}
          {flagged.slice(0, 4).map(({ m, st }) => (
            <span key={m.id} className={'flag ' + st.status}>
              {st.status === 'overdue' ? '● ' : '◐ '}{m.name}
            </span>
          ))}
          {flagged.length > 4 && <span className="flag due-soon">+{flagged.length - 4} more</span>}
        </div>
      )}
    </div>
  )
}
