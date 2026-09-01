import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabase.js'
import { computeMpg, fuelStats, maintenanceStatus, fmt , localToday } from '../lib/calc.js'
import { prepareReceiptFile, uploadReceipt, ocrReceipt, receiptUrl, extractionToFuel, insertFuelReceipt } from '../lib/receipts.js'
import MpgChart from './MpgChart.jsx'

export default function FuelScreen({ vehicles, fuelLogs, maintItems, vid, setVid, refresh, showToast }) {
  const [showForm, setShowForm] = useState(false)
  const [prefill, setPrefill] = useState(null)   // { initial, receipt } from a scan
  const [scanning, setScanning] = useState(false)
  const [receipts, setReceipts] = useState([])       // self-fetched: id, fuel_log_id, file_path
  const [receiptsError, setReceiptsError] = useState(false)
  const fileRef = useRef(null)
  const mpgMap = useMemo(() => computeMpg(fuelLogs), [fuelLogs])
  const vlogs = fuelLogs.filter(l => l.vehicle_id === vid).sort((a, b) => b.odometer - a.odometer)
  const fs = fuelStats(fuelLogs, vid)
  const vehicle = vehicles.find(v => v.id === vid)

  // FuelScreen doesn't receive receipts as a prop — self-fetch the linked rows
  // so the history list can show a ⌁ indicator. Only fuel-linked rows, minimal cols.
  const loadReceipts = useCallback(async () => {
    const { data, error } = await supabase.from('receipts')
      .select('id, fuel_log_id, file_path')
      .not('fuel_log_id', 'is', null)
    if (error) { setReceiptsError(true); setReceipts([]); return }
    setReceiptsError(false); setReceipts(data || [])
  }, [])
  useEffect(() => { loadReceipts() }, [loadReceipts])
  useEffect(() => { setShowForm(false); setPrefill(null) }, [vid])

  const receiptFor = (logId) => receipts.find(r => r.fuel_log_id === logId)

  const scan = async (file) => {
    if (!file) return
    setScanning(true)
    try {
      const prepared = await prepareReceiptFile(file)
      // upload and OCR in parallel — neither depends on the other
      const [path, extracted] = await Promise.all([
        uploadReceipt(prepared, vid),
        ocrReceipt(prepared),
      ])
      setPrefill({ initial: extractionToFuel(extracted), receipt: { path, extracted } })
      setShowForm(true)
      showToast('RECEIPT READ — REVIEW & SAVE')
    } catch (e) {
      showToast('SCAN FAILED: ' + e.message)
    }
    setScanning(false)
  }

  const viewReceipt = async (r) => {
    try { window.open(await receiptUrl(r.file_path), '_blank') }
    catch (e) { showToast('ERROR: ' + e.message) }
  }

  return (
    <>
      <input ref={fileRef} type="file" accept="image/*,application/pdf" capture="environment"
        style={{ display: 'none' }} onChange={e => { scan(e.target.files[0]); e.target.value = '' }} />

      {!showForm && (
        <>
          <button className="btn" onClick={() => { setPrefill(null); setShowForm(true) }} style={{ marginBottom: 8 }}>
            + LOG FILL-UP
          </button>
          <button className="btn2" onClick={() => fileRef.current.click()} disabled={scanning}
            style={{ marginBottom: 16 }}>
            {scanning ? 'READING RECEIPT…' : '⌁ SCAN PUMP RECEIPT'}
          </button>
        </>
      )}
      {showForm && (
        <FuelForm vehicle={vehicle} lastOdo={vlogs[0]?.odometer}
          maintItems={(maintItems || []).filter(m => m.vehicle_id === vid)}
          initial={prefill?.initial} receipt={prefill?.receipt} showToast={showToast}
          onDone={async (saved, hadReceipt) => {
            setShowForm(false); setPrefill(null)
            if (saved) { showToast('FILL LOGGED'); await refresh(); if (hadReceipt) await loadReceipts() }
          }} />
      )}

      {fs && (
        <div className="statgrid">
          <div className="stat"><div className="sv">{fmt.mpg(fs.aggMpg)}</div><div className="sl">Aggregate MPG</div></div>
          <div className="stat"><div className="sv">{fmt.money(fs.avgCpg)}</div><div className="sl">Avg $/Gal</div></div>
          <div className="stat"><div className="sv">{fmt.cpm(fs.costPerMile)}</div><div className="sl">Fuel Cost/Mi</div></div>
          <div className="stat"><div className="sv">{fmt.money0(fs.totalSpend)}</div><div className="sl">Total Spend</div></div>
        </div>
      )}

      <div className="section-label">MPG Trend</div>
      <div className="card">
        <MpgChart points={
          [...vlogs].sort((a, b) => a.odometer - b.odometer)
            .map(l => ({ odometer: l.odometer, mpg: mpgMap.get(l.id)?.mpg, date: l.filled_at }))
            .filter(p => p.mpg != null)
        } />
      </div>

      <div className="section-label">Fill History</div>
      {vlogs.length === 0 && <div className="empty">NO FILLS LOGGED</div>}
      {vlogs.map(l => {
        const c = mpgMap.get(l.id)
        const receipt = receiptFor(l.id)
        return (
          <div className="logrow" key={l.id}>
            <div className="lmain">
              <div className="lt">{fmt.num(l.odometer)} mi
                {l.fill_type !== 'full' && <span style={{ color: 'var(--text-faint)', fontSize: 12 }}> · {l.fill_type.toUpperCase()}</span>}
                {receipt && (
                  <span role="button" title="View receipt" onClick={() => viewReceipt(receipt)}
                    style={{ color: 'var(--amber)', cursor: 'pointer', marginLeft: 6 }}> ⌁</span>
                )}
              </div>
              <div className="ls">
                {l.filled_at}{l.brand ? ' · ' + l.brand : ''}{l.total_cost ? ' · ' + fmt.money(l.total_cost) : ''}
                {' · '}{fmt.gal(l.gallons)} gal{l.cost_per_gallon ? ' @ ' + fmt.money(l.cost_per_gallon) : ''}
                {l.tire_psi && <><br />PSI {['fl', 'fr', 'rl', 'rr'].map(k => l.tire_psi[k] ?? '—').join(' / ')}</>}
              </div>
            </div>
            <div className="lnum">
              <div className="ln1">{c?.mpg ? c.mpg.toFixed(1) : '—'}</div>
              <div className="ln2">MPG{c?.miles ? ' · ' + c.miles + ' mi' : ''}</div>
            </div>
          </div>
        )
      })}
    </>
  )
}

function FuelForm({ vehicle, lastOdo, maintItems, initial, receipt, showToast, onDone }) {
  const today = localToday()
  const draftKey = `ml_fuel_draft_${vehicle.id}`
  const restoredRef = useRef(false)
  const [f, setF] = useState(() => {
    const base = {
      filled_at: today, odometer: '', fill_type: 'full',
      gallons: '', cost_per_gallon: '', total_cost: '',
      octane: vehicle?.fuel_octane || '', brand: '', notes: '',
    }
    // Prefill from a scan: only fill fields the base leaves empty — never clobber
    // a real default (octane, fill_type) with an empty extraction value.
    if (initial) {
      for (const [k, v] of Object.entries(initial)) {
        if (k in base && v !== '' && v != null && !base[k]) base[k] = v
      }
    }
    // Restore an interrupted entry: iOS reloads the webview when the screen
    // locks or the app is backgrounded, wiping React state mid-fill-up.
    try {
      const d = JSON.parse(localStorage.getItem(draftKey) || 'null')
      if (d && Date.now() - d.ts < 12 * 3600 * 1000) {
        restoredRef.current = true
        return { ...base, ...d.f }
      }
    } catch { /* corrupt draft — start fresh */ }
    return base
  })

  // keep the draft current while the user types (only once real data exists)
  useEffect(() => {
    const dirty = f.odometer || f.gallons || f.cost_per_gallon || f.total_cost || f.brand || f.notes
    if (!dirty) return
    const t = setTimeout(() => {
      try { localStorage.setItem(draftKey, JSON.stringify({ f, ts: Date.now() })) } catch { /* storage full */ }
    }, 400)
    return () => clearTimeout(t)
  }, [f, draftKey])
  const [psi, setPsi] = useState({ fl: '', fr: '', rl: '', rr: '' })
  const [showPsi, setShowPsi] = useState(false)
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setF(p => ({ ...p, [k]: v }))

  // live "what's coming due" at the odometer being entered
  const odoNum = parseInt(f.odometer)
  const upcoming = odoNum > 0 ? maintItems
    .map(m => ({ m, st: maintenanceStatus(m, odoNum) }))
    .filter(x => x.st.status === 'overdue' || x.st.status === 'due-soon')
    .sort((a, b) => (a.st.status === 'overdue' ? 0 : 1) - (b.st.status === 'overdue' ? 0 : 1))
    : []

  // auto-derive: any two of (gallons, $/gal, total) fill the third
  const autoTotal = () => {
    const g = parseFloat(f.gallons), c = parseFloat(f.cost_per_gallon), t = parseFloat(f.total_cost)
    if (g && c && !t) set('total_cost', (g * c).toFixed(2))
    else if (g && t && !c) set('cost_per_gallon', (t / g).toFixed(3))
    else if (c && t && !g) set('gallons', (t / c).toFixed(3))
  }

  const save = async () => {
    setBusy(true)
    const psiVals = Object.fromEntries(Object.entries(psi).filter(([, v]) => v !== '').map(([k, v]) => [k, parseFloat(v)]))
    const { data: row, error } = await supabase.from('fuel_logs').insert({
      vehicle_id: vehicle.id,
      user_id: vehicle.user_id,   // fleet owner, so shared members write to the same fleet
      tire_psi: Object.keys(psiVals).length ? psiVals : null,
      filled_at: f.filled_at,
      odometer: parseInt(f.odometer),
      fill_type: f.fill_type,
      gallons: parseFloat(f.gallons),
      cost_per_gallon: f.cost_per_gallon ? parseFloat(f.cost_per_gallon) : null,
      total_cost: f.total_cost ? parseFloat(f.total_cost) : null,
      octane: f.octane || null,
      brand: f.brand || null,
      notes: f.notes || null,
    }).select('id').single()
    if (error) { setBusy(false); alert(error.message); return }
    try { localStorage.removeItem(draftKey) } catch { /* nothing to clear */ }

    // attach the scanned receipt to the fill it produced
    if (receipt) {
      const { error: rerr, degraded } = await insertFuelReceipt({
        vehicle_id: vehicle.id,
        user_id: vehicle.user_id,
        fuel_log_id: row.id,
        file_path: receipt.path,
        vendor: receipt.extracted.vendor,
        location: receipt.extracted.location,
        receipt_date: receipt.extracted.receipt_date,
        total: receipt.extracted.total,
        extracted: receipt.extracted,
      })
      if (rerr) alert('Fill saved, but receipt link failed: ' + rerr.message)
      else if (degraded) showToast('FILL SAVED — receipt stored UNLINKED (run migration 0014)')
    }
    setBusy(false)
    onDone(true, !!receipt)
  }

  const valid = f.odometer && f.gallons && parseInt(f.odometer) > 0
  const odoWarn = lastOdo && f.odometer && parseInt(f.odometer) <= lastOdo && f.fill_type !== 'reset'

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      {restoredRef.current && (
        <div className="note" style={{ marginBottom: 10, color: 'var(--green)' }}>
          ◉ Picked up where you left off — your unsaved entry was restored.
        </div>
      )}
      {receipt && (
        <div className="note" style={{ marginBottom: 10, color: 'var(--amber)' }}>
          ⌁ Receipt attached — fields below were read from it. Enter gallons (or $/gal) and review before saving.
        </div>
      )}
      <div className="frow">
        <div className="field">
          <label>Odometer {lastOdo ? `(last ${lastOdo.toLocaleString()})` : ''}</label>
          <input type="number" inputMode="numeric" value={f.odometer} onChange={e => set('odometer', e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label>Gallons</label>
          <input type="number" inputMode="decimal" step="0.001" value={f.gallons}
            onChange={e => set('gallons', e.target.value)} onBlur={autoTotal} />
        </div>
      </div>
      {odoWarn && <div className="note" style={{ color: 'var(--red)', marginBottom: 10 }}>
        ⚠ Odometer ≤ last logged reading — double-check.
      </div>}
      {upcoming.length > 0 && (
        <div className="card" style={{ background: 'rgba(255,176,0,0.05)', borderColor: 'rgba(255,176,0,0.3)', padding: 12, marginBottom: 12 }}>
          <div className="gl" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--amber)', marginBottom: 6 }}>
            At {odoNum.toLocaleString()} mi — coming due
          </div>
          {upcoming.slice(0, 5).map(({ m, st }) => (
            <div key={m.id} className="ms" style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.7 }}>
              <span className={st.status === 'overdue' ? 'warn' : 'soon'} style={{ color: st.status === 'overdue' ? 'var(--red)' : 'var(--amber-hi)' }}>
                {st.status === 'overdue' ? '● ' : '◐ '}{m.name}
              </span>
              {' — '}
              {st.remainMiles != null && (st.remainMiles <= 0 ? `${Math.abs(st.remainMiles).toLocaleString()} mi overdue` : `${st.remainMiles.toLocaleString()} mi left`)}
              {st.remainMiles != null && st.remainDays != null && ' · '}
              {st.remainDays != null && (st.remainDays <= 0 ? `${Math.abs(st.remainDays)} days overdue` : `${st.remainDays} days left`)}
            </div>
          ))}
        </div>
      )}
      <div className="frow">
        <div className="field">
          <label>$/Gallon</label>
          <input type="number" inputMode="decimal" step="0.001" value={f.cost_per_gallon}
            onChange={e => set('cost_per_gallon', e.target.value)} onBlur={autoTotal} />
        </div>
        <div className="field">
          <label>Total $</label>
          <input type="number" inputMode="decimal" step="0.01" value={f.total_cost}
            onChange={e => set('total_cost', e.target.value)} onBlur={autoTotal} />
        </div>
      </div>
      <div className="field">
        <label>Fill Type</label>
        <div className="seg">
          {['full', 'partial', 'reset'].map(t => (
            <button key={t} className={f.fill_type === t ? 'on' : ''} onClick={() => set('fill_type', t)}>{t}</button>
          ))}
        </div>
      </div>
      <div className="frow">
        <div className="field">
          <label>Date</label>
          <input type="date" value={f.filled_at} onChange={e => set('filled_at', e.target.value)} />
        </div>
        <div className="field">
          <label>Brand</label>
          <input value={f.brand} onChange={e => set('brand', e.target.value)} placeholder="QuikTrip" />
        </div>
      </div>
      <div className="field">
        <label>Notes</label>
        <input value={f.notes} onChange={e => set('notes', e.target.value)} />
      </div>
      {!showPsi ? (
        <button className="btn-sm" onClick={() => setShowPsi(true)} style={{ marginBottom: 12 }}>+ TIRE PSI</button>
      ) : (
        <div className="field">
          <label>Tire PSI — FL / FR / RL / RR</label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            {['fl', 'fr', 'rl', 'rr'].map(k => (
              <input key={k} type="number" inputMode="decimal" placeholder={k.toUpperCase()}
                value={psi[k]} onChange={e => setPsi(p => ({ ...p, [k]: e.target.value }))}
                style={{ textAlign: 'center', padding: '10px 4px' }} />
            ))}
          </div>
        </div>
      )}
      <button className="btn" onClick={save} disabled={!valid || busy}>{busy ? 'SAVING…' : 'SAVE FILL'}</button>
      <div style={{ height: 8 }} />
      <button className="btn2" onClick={() => onDone(false)}>CANCEL</button>
    </div>
  )
}
