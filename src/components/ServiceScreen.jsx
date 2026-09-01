import React, { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { fmt , localToday } from '../lib/calc.js'
import { prepareReceiptFile, uploadReceipt, ocrReceipt, receiptUrl, extractionToService } from '../lib/receipts.js'

const COMMON_SERVICES = [
  'Oil Change', 'Tire Rotation', 'Tires', 'Engine Air Filter', 'Cabin Air Filter',
  'Brake Pads - Front', 'Brake Pads - Rear', 'Brake Fluid Flush',
  'Transmission Fluid', 'Differential Fluid', 'Transfer Case Fluid',
  'Coolant', 'Spark Plugs', 'Battery', 'Alignment', 'Inspection', 'Repair', 'Parts', 'Other',
]

export default function ServiceScreen({ vehicles, serviceLogs, maintItems, receipts, receiptsError, vid, setVid, refresh, showToast }) {
  const [showForm, setShowForm] = useState(false)
  const [prefill, setPrefill] = useState(null)     // { initial, receipt } from a scan
  const [scanning, setScanning] = useState(false)
  const fileRef = useRef(null)
  useEffect(() => { setShowForm(false); setPrefill(null) }, [vid])
  const vlogs = serviceLogs.filter(s => s.vehicle_id === vid)
  const vehicle = vehicles.find(v => v.id === vid)
  const totalSpend = vlogs.reduce((s, x) => s + Number(x.cost || 0), 0)
  const vreceipts = (receipts || []).filter(r => r.vehicle_id === vid)

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
      setPrefill({ initial: extractionToService(extracted), receipt: { path, extracted } })
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
            + LOG SERVICE
          </button>
          <button className="btn2" onClick={() => fileRef.current.click()} disabled={scanning || receiptsError}
            style={{ marginBottom: 16 }}>
            {scanning ? 'READING RECEIPT…' : '⌁ SCAN RECEIPT'}
          </button>
          {receiptsError && (
            <div className="note" style={{ marginBottom: 12 }}>
              Receipt storage not set up — run supabase/migrations/0003_receipts.sql in the SQL
              Editor and deploy the ocr-receipt edge function, then reload.
            </div>
          )}
        </>
      )}
      {showForm && (
        <ServiceForm vehicle={vehicle} maintItems={maintItems.filter(m => m.vehicle_id === vid)}
          initial={prefill?.initial} receipt={prefill?.receipt}
          onDone={async (saved) => {
            setShowForm(false); setPrefill(null)
            if (saved) { showToast('SERVICE LOGGED'); await refresh() }
          }} />
      )}

      <div className="statgrid">
        <div className="stat"><div className="sv">{vlogs.length}</div><div className="sl">Services</div></div>
        <div className="stat"><div className="sv">{fmt.money0(totalSpend)}</div><div className="sl">Total Spend</div></div>
      </div>

      <div className="section-label">Service History</div>
      {vlogs.length === 0 && <div className="empty">NO SERVICES LOGGED</div>}
      {vlogs.map(s => {
        const receipt = vreceipts.find(r => r.service_log_id === s.id)
        return (
          <div className="logrow" key={s.id}>
            <div className="lmain">
              <div className="lt">{s.service_type}{receipt && <span style={{ color: 'var(--amber)' }}> ⌁</span>}</div>
              <div className="ls">
                {s.serviced_at}{s.odometer ? ' · ' + fmt.num(s.odometer) + ' mi' : ''}
                {s.shop ? ' · ' + s.shop : ''}{s.parts ? ' · ' + s.parts : ''}
              </div>
              {s.notes && <div className="ls">{s.notes}</div>}
              {receipt && (
                <div className="ls">
                  <button className="btn-sm" onClick={() => viewReceipt(receipt)} style={{ marginTop: 4 }}>
                    VIEW RECEIPT
                  </button>
                </div>
              )}
            </div>
            <div className="lnum">
              <div className="ln1">{s.cost ? fmt.money0(s.cost) : '—'}</div>
            </div>
          </div>
        )
      })}

      {vreceipts.some(r => !r.service_log_id) && (
        <>
          <div className="section-label">Unlinked Receipts</div>
          {vreceipts.filter(r => !r.service_log_id).map(r => (
            <div className="logrow" key={r.id}>
              <div className="lmain">
                <div className="lt">{r.vendor || 'Receipt'}</div>
                <div className="ls">{r.receipt_date || '—'}{r.odometer ? ' · ' + fmt.num(r.odometer) + ' mi' : ''}</div>
              </div>
              <div className="lnum">
                <div className="ln1">{r.total ? fmt.money0(r.total) : '—'}</div>
                <button className="btn-sm" onClick={() => viewReceipt(r)} style={{ marginTop: 4 }}>VIEW</button>
              </div>
            </div>
          ))}
        </>
      )}
    </>
  )
}

function ServiceForm({ vehicle, maintItems, initial, receipt, onDone }) {
  const today = localToday()
  const draftKey = `ml_svc_draft_${vehicle.id}`
  const [f, setF] = useState(() => {
    const base = {
      serviced_at: today, odometer: '', service_type: 'Oil Change', parts: '', cost: '', shop: 'DIY', notes: '',
      ...(initial || {}),
    }
    // restore an interrupted entry — iOS reloads the webview on screen lock
    try {
      const d = JSON.parse(localStorage.getItem(draftKey) || 'null')
      if (d && Date.now() - d.ts < 12 * 3600 * 1000) return { ...base, ...d.f }
    } catch { /* corrupt draft — start fresh */ }
    return base
  })
  const [updateMaint, setUpdateMaint] = useState(true)
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setF(p => ({ ...p, [k]: v }))

  useEffect(() => {
    const dirty = f.odometer || f.parts || f.cost || f.notes
    if (!dirty) return
    const t = setTimeout(() => {
      try { localStorage.setItem(draftKey, JSON.stringify({ f, ts: Date.now() })) } catch { /* storage full */ }
    }, 400)
    return () => clearTimeout(t)
  }, [f, draftKey])

  // find a maintenance item whose name loosely matches the service type
  const matchMaint = () => {
    const t = f.service_type.toLowerCase()
    return maintItems.find(m => {
      const n = m.name.toLowerCase()
      if (t === 'oil change') return n.includes('engine oil')
      if (t.includes('air filter') && t.includes('engine')) return n.includes('engine air') || n.includes('air filter')
      if (t.includes('cabin')) return n.includes('cabin')
      if (t.includes('tire rotation')) return n.includes('tire rotation')
      if (t.includes('brake fluid')) return n.includes('brake fluid')
      if (t.includes('transmission')) return n.includes('transmission')
      if (t.includes('differential')) return n.includes('differential') || n.includes('diff')
      if (t.includes('transfer')) return n.includes('transfer')
      if (t.includes('coolant')) return n.includes('coolant')
      if (t.includes('spark')) return n.includes('spark')
      return n === t
    })
  }
  const matched = matchMaint()

  const save = async () => {
    setBusy(true)
    const { data: row, error } = await supabase.from('service_logs').insert({
      vehicle_id: vehicle.id,
      user_id: vehicle.user_id,
      serviced_at: f.serviced_at,
      odometer: f.odometer ? parseInt(f.odometer) : null,
      service_type: f.service_type,
      parts: f.parts || null,
      cost: f.cost ? parseFloat(f.cost) : null,
      shop: f.shop || null,
      notes: f.notes || null,
    }).select('id').single()
    if (error) { setBusy(false); alert(error.message); return }
    try { localStorage.removeItem(draftKey) } catch { /* nothing to clear */ }

    // attach the scanned receipt to the service log it produced
    if (receipt) {
      const { error: rerr } = await supabase.from('receipts').insert({
        vehicle_id: vehicle.id,
        user_id: vehicle.user_id,
        service_log_id: row.id,
        file_path: receipt.path,
        vendor: receipt.extracted.vendor,
        receipt_date: receipt.extracted.receipt_date,
        total: receipt.extracted.total,
        odometer: receipt.extracted.odometer,
        extracted: receipt.extracted,
      })
      if (rerr) alert('Service saved, but receipt link failed: ' + rerr.message)
    }

    // roll the maintenance baseline forward
    if (updateMaint && matched) {
      await supabase.from('maintenance_items').update({
        last_done_miles: f.odometer ? parseInt(f.odometer) : matched.last_done_miles,
        last_done_date: f.serviced_at,
      }).eq('id', matched.id)
    }
    setBusy(false)
    onDone(true)
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      {receipt && (
        <div className="note" style={{ marginBottom: 10, color: 'var(--amber)' }}>
          ⌁ Receipt attached — fields below were read from it. Review before saving.
        </div>
      )}
      <div className="field">
        <label>Service Type</label>
        <select value={f.service_type} onChange={e => set('service_type', e.target.value)}>
          {(COMMON_SERVICES.includes(f.service_type) ? COMMON_SERVICES : [f.service_type, ...COMMON_SERVICES])
            .map(s => <option key={s}>{s}</option>)}
        </select>
      </div>
      <div className="frow">
        <div className="field">
          <label>Date</label>
          <input type="date" value={f.serviced_at} onChange={e => set('serviced_at', e.target.value)} />
        </div>
        <div className="field">
          <label>Odometer</label>
          <input type="number" inputMode="numeric" value={f.odometer} onChange={e => set('odometer', e.target.value)} />
        </div>
      </div>
      <div className="frow">
        <div className="field">
          <label>Cost $</label>
          <input type="number" inputMode="decimal" value={f.cost} onChange={e => set('cost', e.target.value)} />
        </div>
        <div className="field">
          <label>Shop / DIY</label>
          <input value={f.shop} onChange={e => set('shop', e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label>Parts / Part Numbers</label>
        <input value={f.parts} onChange={e => set('parts', e.target.value)} placeholder="04152-YZZA5 + 8qt 0W-20" />
      </div>
      <div className="field">
        <label>Notes</label>
        <input value={f.notes} onChange={e => set('notes', e.target.value)} />
      </div>
      {matched && (
        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none', fontSize: 12, color: 'var(--amber)' }}>
            <input type="checkbox" checked={updateMaint} onChange={e => setUpdateMaint(e.target.checked)}
              style={{ width: 'auto' }} />
            Reset "{matched.name}" interval to this service
          </label>
        </div>
      )}
      <button className="btn" onClick={save} disabled={busy || !f.service_type}>{busy ? 'SAVING…' : 'SAVE SERVICE'}</button>
      <div style={{ height: 8 }} />
      <button className="btn2" onClick={() => onDone(false)}>CANCEL</button>
    </div>
  )
}
