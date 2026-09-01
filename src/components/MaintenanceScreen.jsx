import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { currentOdometer, maintenanceStatus, fmt , localToday } from '../lib/calc.js'
import { suggestParts, suggestionToParts } from '../lib/parts.js'

const ORDER = { overdue: 0, 'due-soon': 1, baseline: 2, ok: 3 }

export default function MaintenanceScreen({ vehicles, fuelLogs, serviceLogs, maintItems, vid, setVid, refresh, showToast, telemOdos }) {
  const [editItem, setEditItem] = useState(null)
  const [adding, setAdding] = useState(false)
  useEffect(() => { setEditItem(null); setAdding(false) }, [vid])
  const vehicle = vehicles.find(v => v.id === vid)
  const odo = vehicle ? currentOdometer(vehicle, fuelLogs, serviceLogs, telemOdos?.[vehicle.id]) : 0

  const items = maintItems
    .filter(m => m.vehicle_id === vid)
    .map(m => ({ m, st: maintenanceStatus(m, odo) }))
    .sort((a, b) => (ORDER[a.st.status] - ORDER[b.st.status]) || a.m.name.localeCompare(b.m.name))

  const counts = { overdue: 0, 'due-soon': 0 }
  for (const { st } of items) if (counts[st.status] != null) counts[st.status]++

  return (
    <>

      <div className="statgrid">
        <OdoStat vehicle={vehicle} odo={odo} refresh={refresh} showToast={showToast} />
        <div className="stat">
          <div className="sv" style={{ color: counts.overdue ? 'var(--red)' : 'var(--green)' }}>
            {counts.overdue}
          </div>
          <div className="sl">Overdue</div>
        </div>
      </div>

      {(editItem || adding) ? (
        <MaintForm item={editItem} vehicle={vehicle} vehicleId={vid} ownerId={vehicle?.user_id} currentOdo={odo}
          onDone={async (saved) => {
            setEditItem(null); setAdding(false)
            if (saved) { showToast('SAVED'); await refresh() }
          }} />
      ) : (
        <button className="btn2" onClick={() => setAdding(true)} style={{ marginBottom: 8 }}>+ ADD ITEM</button>
      )}

      <div className="section-label">Intervals — {vehicle?.name}</div>
      {items.map(({ m, st }) => (
        <div className="mrow" key={m.id} onClick={() => { setAdding(false); setEditItem(m) }} style={{ cursor: 'pointer' }}>
          <div className={'dot ' + st.status} />
          <div className="mmain">
            <div className="mt">{m.name}</div>
            <div className="ms">
              <StatusLine m={m} st={st} />
              {m.part_number && <><br />PN {m.part_number}</>}
              {m.notes && <><br />{m.notes}</>}
            </div>
            {m.parts?.length > 0 && (
              <div className="plist">
                {m.parts.map((p, i) => <PartLine key={i} p={p} />)}
              </div>
            )}
          </div>
        </div>
      ))}
    </>
  )
}

// Tap-to-edit current mileage. The odometer is always DERIVED (max of
// base_odometer, fuel logs, service logs) — this writes the base_odometer
// anchor, which matters for vehicles with no logged history yet (their
// derived odo is 0 and every mileage feature is blind until anchored).
function OdoStat({ vehicle, odo, refresh, showToast }) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    const n = parseInt(val)
    if (!n || n < 0) { showToast('ENTER A MILEAGE'); return }
    setBusy(true)
    const { error } = await supabase.from('vehicles')
      .update({ base_odometer: n }).eq('id', vehicle.id)
    setBusy(false)
    if (error) { showToast('ERROR: ' + error.message); return }
    setEditing(false); setVal('')
    showToast(n < odo
      ? `SAVED — logs already show ${odo.toLocaleString()} mi, which wins`
      : 'MILEAGE UPDATED')
    await refresh()
  }

  if (!editing) return (
    <button className="stat" onClick={() => { setVal(odo ? String(odo) : ''); setEditing(true) }}
      style={{ cursor: 'pointer', textAlign: 'left', font: 'inherit', color: 'inherit' }}
      aria-label="Update current mileage">
      <div className="sv">{fmt.num(odo)}</div>
      <div className="sl">Current Odo · <span style={{ color: 'var(--amber)' }}>tap to set</span></div>
    </button>
  )
  return (
    <div className="stat">
      <input type="number" inputMode="numeric" autoFocus value={val}
        onChange={e => setVal(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && save()}
        placeholder={vehicle.name + ' mileage'}
        style={{ width: '100%', fontSize: 16, fontFamily: 'var(--font-mono)',
          background: 'transparent', border: '1px solid var(--line-bright)',
          borderRadius: 4, color: 'var(--text)', padding: '6px 8px' }} />
      <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
        <button className="btn-sm" onClick={save} disabled={busy}
          style={{ flex: 1, color: 'var(--amber)', borderColor: 'rgba(255,176,0,0.4)' }}>
          {busy ? '…' : 'SET'}
        </button>
        <button className="btn-sm" onClick={() => setEditing(false)} style={{ flex: 1 }}>CANCEL</button>
      </div>
    </div>
  )
}

// One line per part: "Engine Oil — 0W-20 · 7.9 qt · PN 00279-0WQTE-01"
export function PartLine({ p }) {
  return (
    <div className="pline">
      {p.url
        ? <a className="pname plink" href={p.url} target="_blank" rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}>{p.name} ↗</a>
        : <span className="pname">{p.name}</span>}
      {[p.spec, p.qty, p.part_number ? `PN ${p.part_number}` : null]
        .filter(Boolean).map((x, i) => <span key={i}> · {x}</span>)}
    </div>
  )
}

function StatusLine({ m, st }) {
  if (st.status === 'baseline') {
    return <span>No baseline — tap to set last-done{m.interval_miles ? ` (every ${m.interval_miles.toLocaleString()} mi${m.interval_months ? ` / ${m.interval_months} mo` : ''})` : m.interval_months ? ` (every ${m.interval_months} mo)` : ''}</span>
  }
  const parts = []
  if (st.remainMiles != null) {
    const cls = st.remainMiles <= 0 ? 'warn' : st.remainMiles <= 1000 ? 'soon' : ''
    parts.push(<span key="mi" className={cls}>
      {st.remainMiles <= 0
        ? `OVERDUE ${Math.abs(st.remainMiles).toLocaleString()} mi`
        : `${st.remainMiles.toLocaleString()} mi remaining`}
      {' '}(due {st.dueMiles.toLocaleString()})
    </span>)
  }
  if (st.remainDays != null) {
    const cls = st.remainDays <= 0 ? 'warn' : st.remainDays <= 30 ? 'soon' : ''
    parts.push(<span key="dt" className={cls}>
      {parts.length > 0 && ' · '}
      {st.remainDays <= 0 ? `OVERDUE ${Math.abs(st.remainDays)} days` : `${st.remainDays} days remaining`}
    </span>)
  }
  if (parts.length === 0) parts.push(<span key="x">Tracked</span>)
  return <>{parts}</>
}

function MaintForm({ item, vehicle, vehicleId, ownerId, currentOdo, onDone }) {
  const [f, setF] = useState({
    name: item?.name || '',
    interval_miles: item?.interval_miles ?? '',
    interval_months: item?.interval_months ?? '',
    last_done_miles: item?.last_done_miles ?? '',
    last_done_date: item?.last_done_date ?? '',
    part_number: item?.part_number ?? '',
    notes: item?.notes ?? '',
  })
  const [parts, setParts] = useState(item?.parts?.length ? item.parts : [])
  const [busy, setBusy] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [suggestNote, setSuggestNote] = useState(null)
  const set = (k, v) => setF(p => ({ ...p, [k]: v }))
  const setPart = (i, k, v) => setParts(ps => ps.map((p, j) => j === i ? { ...p, [k]: v } : p))
  const addPart = () => setParts(ps => [...ps, { name: '', spec: '', qty: '', part_number: '', url: '' }])
  const rmPart = (i) => setParts(ps => ps.filter((_, j) => j !== i))

  const suggest = async () => {
    setSuggesting(true); setSuggestNote(null)
    try {
      const result = await suggestParts(vehicle, f.name)
      const rows = suggestionToParts(result)
      if (!rows.length) setSuggestNote('No standard parts found for this service.')
      else {
        // keep rows the user already filled in; append the factory baseline
        setParts(ps => [...ps.filter(p => p.name || p.spec || p.qty || p.part_number || p.url), ...rows])
        setSuggestNote(result.notes || 'Factory baseline loaded — swap in your preferred brands and add product links.')
      }
    } catch (e) { setSuggestNote('Lookup failed: ' + e.message) }
    setSuggesting(false)
  }

  const save = async () => {
    setBusy(true)
    const payload = {
      name: f.name,
      interval_miles: f.interval_miles ? parseInt(f.interval_miles) : null,
      interval_months: f.interval_months ? parseInt(f.interval_months) : null,
      last_done_miles: f.last_done_miles !== '' ? parseInt(f.last_done_miles) : null,
      last_done_date: f.last_done_date || null,
      part_number: f.part_number || null,
      notes: f.notes || null,
      parts: parts.filter(p => p.name || p.spec || p.qty || p.part_number),
    }
    const write = (pl) => item
      ? supabase.from('maintenance_items').update(pl).eq('id', item.id)
      : supabase.from('maintenance_items').insert({ ...pl, vehicle_id: vehicleId, user_id: ownerId })
    let { error } = await write(payload)
    if (error && /parts/.test(error.message)) {
      // parts column missing until migration 0011 — save the rest, flag the gap
      const { parts: _p, ...rest } = payload
      ;({ error } = await write(rest))
      if (!error) alert('Saved, but the parts list needs migration 0011_maint_parts.sql applied in the Supabase SQL Editor first.')
    }
    setBusy(false)
    if (error) { alert(error.message); return }
    onDone(true)
  }

  const markDoneNow = () => {
    set('last_done_miles', String(currentOdo))
    set('last_done_date', localToday())
  }

  const del = async () => {
    if (!confirm('Delete this maintenance item?')) return
    await supabase.from('maintenance_items').delete().eq('id', item.id)
    onDone(true)
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="field">
        <label>Item Name</label>
        <input value={f.name} onChange={e => set('name', e.target.value)} placeholder="Transfer Case Fluid" />
      </div>
      <div className="frow">
        <div className="field">
          <label>Interval (miles)</label>
          <input type="number" inputMode="numeric" value={f.interval_miles} onChange={e => set('interval_miles', e.target.value)} />
        </div>
        <div className="field">
          <label>Interval (months)</label>
          <input type="number" inputMode="numeric" value={f.interval_months} onChange={e => set('interval_months', e.target.value)} />
        </div>
      </div>
      <div className="frow">
        <div className="field">
          <label>Last Done (miles)</label>
          <input type="number" inputMode="numeric" value={f.last_done_miles} onChange={e => set('last_done_miles', e.target.value)} />
        </div>
        <div className="field">
          <label>Last Done (date)</label>
          <input type="date" value={f.last_done_date} onChange={e => set('last_done_date', e.target.value)} />
        </div>
      </div>
      <button className="btn-sm" onClick={markDoneNow} style={{ marginBottom: 4 }}>
        {currentOdo > 0 ? `MARK DONE TODAY @ ${currentOdo.toLocaleString()} MI` : 'MARK DONE TODAY'}
      </button>
      <div className="note" style={{ marginBottom: 12 }}>
        {currentOdo > 0
          ? 'Fills the fields above — edit the mileage there if the odometer estimate is off, then SAVE.'
          : 'No odometer on record for this vehicle — type the actual mileage into "Last Done (miles)" above, or set Current Odo at the top of this screen first.'}
      </div>
      <div className="field">
        <label>Part Number</label>
        <input value={f.part_number} onChange={e => set('part_number', e.target.value)} />
      </div>
      <div className="field">
        <label>Parts & Fluids for This Service</label>
      </div>
      <button className="btn-sm" onClick={suggest} disabled={suggesting || !f.name}
        style={{ marginBottom: 10, color: 'var(--amber)', borderColor: 'rgba(255,176,0,0.4)' }}>
        {suggesting ? 'LOOKING UP…' : `✦ SUGGEST STANDARD PARTS FOR ${(vehicle?.name || 'VEHICLE').toUpperCase()}`}
      </button>
      {suggestNote && <div className="note" style={{ marginBottom: 10 }}>{suggestNote}</div>}
      {parts.map((p, i) => (
        <div className="partrow" key={i}>
          <div className="frow">
            <div className="field">
              <input value={p.name} onChange={e => setPart(i, 'name', e.target.value)} placeholder="Engine Oil" />
            </div>
            <div className="field">
              <input value={p.spec} onChange={e => setPart(i, 'spec', e.target.value)} placeholder="0W-20 Full Syn" />
            </div>
          </div>
          <div className="frow">
            <div className="field">
              <input value={p.qty} onChange={e => setPart(i, 'qty', e.target.value)} placeholder="7.9 qt" />
            </div>
            <div className="field" style={{ display: 'flex', gap: 6 }}>
              <input value={p.part_number} onChange={e => setPart(i, 'part_number', e.target.value)}
                placeholder="PN 04152-YZZA5" style={{ flex: 1 }} />
              <button className="btn-sm" onClick={() => rmPart(i)} aria-label="Remove part"
                style={{ width: 38, flexShrink: 0, color: 'var(--red)', borderColor: 'rgba(255,77,77,0.35)' }}>✕</button>
            </div>
          </div>
          <div className="field">
            <input type="url" inputMode="url" value={p.url || ''} onChange={e => setPart(i, 'url', e.target.value)}
              placeholder="https:// product link — your preferred brand (optional)" />
          </div>
        </div>
      ))}
      <button className="btn-sm" onClick={addPart} style={{ marginBottom: 12 }}>+ ADD PART / FLUID</button>
      <div className="field">
        <label>Notes</label>
        <textarea rows={2} value={f.notes} onChange={e => set('notes', e.target.value)} />
      </div>
      <button className="btn" onClick={save} disabled={busy || !f.name}>{busy ? 'SAVING…' : 'SAVE'}</button>
      <div style={{ height: 8 }} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn2" style={{ flex: 1 }} onClick={() => onDone(false)}>CANCEL</button>
        {item && <button className="btn2" style={{ flex: 1, borderColor: 'rgba(255,77,77,0.4)', color: 'var(--red)' }} onClick={del}>DELETE</button>}
      </div>
    </div>
  )
}
