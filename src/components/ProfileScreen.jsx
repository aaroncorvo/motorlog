import React, { useRef, useState } from 'react'
import { fmt } from '../lib/calc.js'
import VehicleDetail from './VehicleDetail.jsx'
import { DOC_KINDS, uploadDoc, docUrl, deleteDoc, docExpiry, prepareDocFile, ocrDocument, extractionToDocForm } from '../lib/docs.js'
import ObdPanel from './ObdPanel.jsx'
import RemindersPanel from './RemindersPanel.jsx'
import TripsPanel from './TripsPanel.jsx'

// Dedicated per-vehicle page: photos, profile fields, glovebox docs, recent work.
export default function ProfileScreen({ vehicles, vid, setVid, fuelLogs, serviceLogs, receipts, photos, photosError, recalls, recallsError, docs, docsError, refresh, showToast, goTab }) {
  const vehicle = vehicles.find(v => v.id === vid) || vehicles[0]
  if (!vehicle) return null
  const recent = serviceLogs.filter(s => s.vehicle_id === vehicle.id).slice(0, 5)
  const vreceipts = (receipts || []).filter(r => r.vehicle_id === vehicle.id)
  const vdocs = (docs || []).filter(d => !d.vehicle_id || d.vehicle_id === vehicle.id)

  return (
    <>
      <VehicleDetail vehicle={vehicle} fuelLogs={fuelLogs} serviceLogs={serviceLogs}
        photos={photos || []} photosError={photosError} recalls={recalls || []} recallsError={recallsError}
        refresh={refresh} showToast={showToast} />

      <div className="section-label">Glovebox</div>
      {docsError ? (
        <div className="note">Document storage not set up — run supabase/migrations/0009_glovebox.sql, then reload.</div>
      ) : (
        <Glovebox vehicle={vehicle} vdocs={vdocs} refresh={refresh} showToast={showToast} />
      )}

      <div className="section-label">OBD-II Link</div>
      <ObdPanel vehicle={vehicle} refresh={refresh} showToast={showToast} />

      <div className="section-label">Recent Trips</div>
      <TripsPanel vehicle={vehicle} />

      <div className="section-label">Reminders</div>
      <RemindersPanel vehicle={vehicle} ownerId={vehicle.user_id} />

      <div className="section-label">Updates & Repairs</div>
      {recent.length === 0 && (
        <div className="empty" style={{ padding: '18px 0' }}>NO WORK LOGGED YET</div>
      )}
      {recent.map(s => (
        <div className="logrow" key={s.id}>
          <div className="lmain">
            <div className="lt">
              {s.service_type}
              {vreceipts.some(r => r.service_log_id === s.id) && <span style={{ color: 'var(--amber)' }}> ⌁</span>}
            </div>
            <div className="ls">
              {s.serviced_at}{s.odometer ? ' · ' + fmt.num(s.odometer) + ' mi' : ''}
              {s.shop ? ' · ' + s.shop : ''}
            </div>
          </div>
          <div className="lnum">
            <div className="ln1">{s.cost ? fmt.money0(s.cost) : '—'}</div>
          </div>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn2" style={{ flex: 1 }} onClick={() => goTab('Service')}>LOG WORK / SCAN RECEIPT</button>
        <button className="btn2" style={{ flex: 1 }} onClick={() => goTab('Maint')}>INTERVALS</button>
      </div>
    </>
  )
}

function Glovebox({ vehicle, vdocs, refresh, showToast }) {
  const [form, setForm] = useState(null)          // null = closed; {holder,kind,label,expires_on,thisVehicle}
  const [prepared, setPrepared] = useState(null)  // normalized file waiting for save
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const handleFile = async (file) => {
    if (!file) return
    setScanning(true)
    try {
      const prep = await prepareDocFile(file)
      setPrepared(prep)
      let pre = { holder: vehicle.primary_driver || '', kind: 'Insurance Card', label: '', expires_on: '' }
      try {
        pre = { ...pre, ...extractionToDocForm(await ocrDocument(prep)) }
        if (!pre.holder) pre.holder = vehicle.primary_driver || ''
        showToast('DOCUMENT READ — REVIEW & SAVE')
      } catch {
        showToast('SCAN UNAVAILABLE — FILL IN MANUALLY')
      }
      setForm({ ...pre, thisVehicle: true })
    } catch (e) { showToast('ERROR: ' + e.message) }
    setScanning(false)
  }

  const save = async () => {
    setBusy(true)
    try {
      await uploadDoc(prepared, {
        ownerId: vehicle.user_id, holder: form.holder || 'Family', kind: form.kind, label: form.label,
        vehicleId: form.thisVehicle ? vehicle.id : null, expiresOn: form.expires_on,
      })
      showToast('DOCUMENT SAVED')
      setForm(null); setPrepared(null)
      await refresh()
    } catch (e) { showToast('SAVE FAILED: ' + e.message) }
    setBusy(false)
  }

  const view = async (d) => {
    try { window.open(await docUrl(d), '_blank') }
    catch (e) { showToast('ERROR: ' + e.message) }
  }

  return (
    <>
      {vdocs.map(d => {
        const exp = docExpiry(d)
        return (
          <div className="logrow" key={d.id}>
            <div className="lmain">
              <div className="lt" style={{ fontSize: 15 }}>{d.label || d.kind}</div>
              <div className="ls">
                {d.kind} · {d.holder}{!d.vehicle_id && ' · fleet-wide'}
                {d.expires_on && (
                  <span style={{ color: exp === 'expired' ? 'var(--red)' : exp === 'expiring' ? 'var(--amber-hi)' : undefined }}>
                    {' · '}{exp === 'expired' ? 'EXPIRED ' : 'expires '}{d.expires_on}
                  </span>
                )}
              </div>
            </div>
            <div className="lnum" style={{ display: 'flex', gap: 6 }}>
              <button className="btn-sm" onClick={() => view(d)}>VIEW</button>
              <button className="btn-sm danger" onClick={async () => {
                if (!confirm(`Delete "${d.label || d.kind}"?`)) return
                await deleteDoc(d); await refresh(); showToast('DELETED')
              }}>✕</button>
            </div>
          </div>
        )
      })}
      <input ref={fileRef} type="file" accept="image/*,application/pdf" capture="environment"
        style={{ display: 'none' }} onChange={e => { handleFile(e.target.files[0]); e.target.value = '' }} />
      {!form ? (
        <button className="btn2" onClick={() => fileRef.current.click()} disabled={scanning} style={{ marginTop: 8 }}>
          {scanning ? 'READING DOCUMENT…' : '⌁ ADD DOCUMENT — SNAP OR CHOOSE FILE'}
        </button>
      ) : (
        <div className="card" style={{ marginTop: 8 }}>
          <div className="note" style={{ marginBottom: 10, color: 'var(--amber)' }}>
            ⌁ Fields below were read from the document — review before saving.
          </div>
          <div className="frow">
            <div className="field">
              <label>Holder</label>
              <input value={form.holder} onChange={e => set('holder', e.target.value)} placeholder="Aaron" />
            </div>
            <div className="field">
              <label>Type</label>
              <select value={form.kind} onChange={e => set('kind', e.target.value)}>
                {DOC_KINDS.map(k => <option key={k}>{k}</option>)}
              </select>
            </div>
          </div>
          <div className="field">
            <label>Label</label>
            <input value={form.label} onChange={e => set('label', e.target.value)} placeholder="State Farm 84-XX-1234" />
          </div>
          <div className="field">
            <label>Expires</label>
            <input type="date" value={form.expires_on} onChange={e => set('expires_on', e.target.value)} />
          </div>
          <div className="field">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none', fontSize: 12 }}>
              <input type="checkbox" checked={form.thisVehicle} onChange={e => set('thisVehicle', e.target.checked)} style={{ width: 'auto' }} />
              This vehicle only (uncheck for fleet-wide, e.g. AAA card)
            </label>
          </div>
          <button className="btn" onClick={save} disabled={busy}>{busy ? 'SAVING…' : 'SAVE DOCUMENT'}</button>
          <div style={{ height: 8 }} />
          <button className="btn2" onClick={() => { setForm(null); setPrepared(null) }}>CANCEL</button>
          <div className="note" style={{ marginTop: 10 }}>
            Stored privately (owner-only access, encrypted at rest, links expire in 5 minutes).
            Good for insurance/registration cards — keep driver's licenses in Apple Wallet instead.
          </div>
        </div>
      )}
    </>
  )
}
