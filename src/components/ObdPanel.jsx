import React, { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { bleSupported, createObdConnection, PIDS } from '../lib/obd.js'
import { DriveSession } from '../lib/driveSession.js'
import { isNative } from '../lib/native.js'
import { describeDtc, explainDtcs } from '../lib/dtc.js'

const LIVE_PIDS = ['0C', '0D', '05', '2F', '42']

// Live OBD-II link over BLE: gauges, read/understand/clear check-engine codes.
// Works today in Chrome (desktop/Android); iPhone arrives with the Capacitor app.
export default function ObdPanel({ vehicle, refresh, showToast }) {
  const [state, setState] = useState('idle')   // idle | connecting | live | error
  const [deviceName, setDeviceName] = useState(null)
  const [vals, setVals] = useState({})
  const [dtcs, setDtcs] = useState(null)       // null = not read; {stored, pending}
  const [diag, setDiag] = useState(null)       // AI diagnosis result
  const [busyBtn, setBusyBtn] = useState(null) // 'read' | 'explain' | 'clear' | 'log'
  const [err, setErr] = useState(null)
  const [triedFiltered, setTriedFiltered] = useState(false)
  const [rec, setRec] = useState(null)        // { samples, uploaded } while recording
  const connRef = useRef(null)
  const pollRef = useRef(null)
  const sessionRef = useRef(null)

  const stop = () => {
    sessionRef.current?.stop().catch(() => {})
    sessionRef.current = null
    setRec(null)
    clearInterval(pollRef.current)
    connRef.current?.disconnect()
    connRef.current = null
    setState('idle'); setVals({}); setDtcs(null); setDiag(null); setDeviceName(null)
  }
  useEffect(() => stop, [])                    // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { stop() }, [vehicle.id])    // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async (allDevices = false) => {
    setState('connecting'); setErr(null)
    try {
      const conn = await createObdConnection()
      const name = await conn.connect(allDevices)
      connRef.current = conn
      setDeviceName(name)
      setState('live')
      let busy = false
      pollRef.current = setInterval(async () => {
        if (busy || !connRef.current) return
        busy = true
        try { setVals(await connRef.current.readPids(LIVE_PIDS)) }
        catch { /* transient read miss; keep polling */ }
        busy = false
      }, 1200)
    } catch (e) {
      if (e.name === 'NotFoundError') {
        // chooser closed empty — either cancelled or the dongle didn't advertise
        setTriedFiltered(true)
        setState('idle')
      } else {
        setErr(e.message)
        setState('error')
      }
    }
  }

  const startRecording = async (gpsOnly = false) => {
    setErr(null)
    const session = new DriveSession(gpsOnly ? null : connRef.current, vehicle.id, {
      onSample: (_s, n) => setRec(r => ({ ...(r || { uploaded: 0 }), samples: (r?.samples || 0) + 1, buffered: n })),
      onUpload: (uploaded) => setRec(r => ({ ...(r || { samples: 0 }), uploaded, err: null })),
      onError: (e) => setRec(r => (r ? { ...r, err: e.message?.slice(0, 40) } : r)),
    })
    sessionRef.current = session
    setRec({ samples: 0, uploaded: 0 })
    try { await session.start() }
    catch (e) { setErr('Recording failed: ' + e.message); sessionRef.current = null; setRec(null) }
  }

  const stopRecording = async () => {
    const n = await sessionRef.current?.stop()
    sessionRef.current = null
    setRec(null)
    showToast(n ? `DRIVE SAVED — ${n} SAMPLES` : 'RECORDING STOPPED')
    await refresh()
  }

  const readCodes = async () => {
    setBusyBtn('read'); setErr(null); setDiag(null)
    try { setDtcs(await connRef.current.readDtcs()) }
    catch (e) { setErr('Code read failed: ' + e.message) }
    setBusyBtn(null)
  }

  const allCodes = dtcs ? [...new Set([...dtcs.stored, ...dtcs.pending])] : []

  const explain = async () => {
    setBusyBtn('explain'); setErr(null)
    try { setDiag(await explainDtcs(vehicle, allCodes)) }
    catch (e) { setErr('Diagnosis failed: ' + e.message) }
    setBusyBtn(null)
  }

  const clearCodes = async () => {
    if (!confirm(
      'Clear check-engine codes?\n\n' +
      'This erases stored + pending codes AND resets emissions readiness monitors — ' +
      'the vehicle may fail state inspection until several drive cycles complete. ' +
      'If the underlying fault remains, the light will come back.'
    )) return
    setBusyBtn('clear'); setErr(null)
    try {
      await connRef.current.clearDtcs()
      setDtcs(await connRef.current.readDtcs())
      setDiag(null)
      showToast('CODES CLEARED — MONITORS RESET')
    } catch (e) { setErr('Clear failed: ' + e.message) }
    setBusyBtn(null)
  }

  const logToHistory = async () => {
    setBusyBtn('log')
    const lines = allCodes.map(c => {
      const d = diag?.codes?.find(x => x.code === c)
      return `${c}${dtcs.pending.includes(c) && !dtcs.stored.includes(c) ? ' (pending)' : ''} — ${d?.meaning || describeDtc(c)}`
    })
    if (diag?.summary) lines.push('Diagnosis: ' + diag.summary)
    const { error } = await supabase.from('service_logs').insert({
      user_id: vehicle.user_id, vehicle_id: vehicle.id,
      serviced_at: new Date().toISOString().slice(0, 10),
      service_type: 'Diagnostics', cost: 0,
      notes: 'OBD-II scan: ' + (lines.length ? lines.join(' · ') : 'no stored codes'),
    })
    setBusyBtn(null)
    if (error) { setErr('Log failed: ' + error.message); return }
    showToast('LOGGED TO SERVICE HISTORY')
    await refresh()
  }

  if (!bleSupported()) {
    return (
      <div className="card">
        {rec ? (
          <>
            <button className="btn" onClick={stopRecording}
              style={{ background: 'var(--red)', borderColor: 'var(--red)' }}>
              ■ STOP GPS RECORDING
            </button>
            <div className="note" style={{ marginTop: 8 }}>
              GPS track recording · {rec.samples} positions · {rec.uploaded} uploaded
              {rec.err ? ` · retrying (${rec.err})` : ''}
            </div>
          </>
        ) : (
          <button className="btn2" onClick={() => startRecording(true)}
            style={{ color: 'var(--amber)', borderColor: 'rgba(255,176,0,0.4)' }}>
            ● RECORD GPS TRACK (NO DONGLE)
          </button>
        )}
        <div className="note" style={{ marginTop: 10 }}>
          Bluetooth OBD-II works in Chrome or Edge (computer / Android phone) today —
          iPhone support ships with the App Store version. Use a BLE dongle:
          Vgate iCar Pro BLE 4.0, OBDLink CX, or Veepeak BLE+. GPS-track recording
          works everywhere — engine data merges in from an installed telematics device.
        </div>
      </div>
    )
  }

  return (
    <div className="card">
      {state !== 'live' ? (
        rec ? (
          <>
            <button className="btn" onClick={stopRecording}
              style={{ background: 'var(--red)', borderColor: 'var(--red)' }}>
              ■ STOP GPS RECORDING
            </button>
            <div className="note" style={{ marginTop: 8 }}>
              GPS track recording · {rec.samples} positions · {rec.uploaded} uploaded
              {rec.err ? ` · retrying (${rec.err})` : ''} — engine data merges in from the
              installed telematics device.
            </div>
          </>
        ) : (
        <>
          <button className="btn" onClick={() => connect(false)} disabled={state === 'connecting'}>
            {state === 'connecting' ? 'CONNECTING…' : '⌁ CONNECT OBD-II DONGLE'}
          </button>
          <div style={{ height: 8 }} />
          <button className="btn2" onClick={() => startRecording(true)}
            style={{ color: 'var(--amber)', borderColor: 'rgba(255,176,0,0.4)' }}>
            ● RECORD GPS TRACK (NO DONGLE)
          </button>
          {triedFiltered && state === 'idle' && (
            <>
              <div style={{ height: 8 }} />
              <button className="btn2" onClick={() => connect(true)} disabled={state === 'connecting'}>
                DONGLE NOT LISTED? SHOW ALL BLUETOOTH DEVICES
              </button>
            </>
          )}
          <div className="note" style={{ marginTop: 10 }}>
            Plug a BLE dongle (Vgate iCar Pro BLE, OBDLink CX, Veepeak BLE+) into the
            OBD port, turn the ignition on, then connect. Live data, check-engine
            code diagnosis, and code clearing. Bluetooth-Classic dongles (most cheap
            "Android-only" ELM327s) won't appear — BLE models are usually marked
            "for iPhone/iOS".
          </div>
          {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
        </>
        )
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span className="note" style={{ margin: 0, color: 'var(--green)' }}>● {deviceName}</span>
            <button className="btn-sm" onClick={stop}>DISCONNECT</button>
          </div>
          <div className="gauges">
            {LIVE_PIDS.map(pid => (
              <div className="gauge" key={pid}>
                <div className={'gv' + (pid === '0C' ? ' amber' : '')}>
                  {vals[pid] != null ? vals[pid] : '—'}
                  {vals[pid] != null && PIDS[pid].unit && <span style={{ fontSize: 12, color: 'var(--text-faint)' }}> {PIDS[pid].unit}</span>}
                </div>
                <div className="gl">{PIDS[pid].label}</div>
              </div>
            ))}
          </div>
          <div style={{ height: 12 }} />
          {rec ? (
            <>
              <button className="btn" onClick={stopRecording}
                style={{ background: 'var(--red)', borderColor: 'var(--red)' }}>
                ■ STOP RECORDING
              </button>
              <div className="note" style={{ marginTop: 8 }}>
                Recording · {rec.samples} samples captured · {rec.uploaded} uploaded
                {rec.err ? ` · retrying (${rec.err})` : ''}
              </div>
            </>
          ) : (
            <>
              <button className="btn2" onClick={() => startRecording(false)}
                style={{ color: 'var(--amber)', borderColor: 'rgba(255,176,0,0.4)' }}>
                ● RECORD DRIVE {isNative() ? '(phone GPS + engine)' : '(engine + browser GPS)'}
              </button>
              <div style={{ height: 8 }} />
            </>
          )}
          <button className="btn2" onClick={readCodes} disabled={busyBtn === 'read'}>
            {busyBtn === 'read' ? 'READING…' : 'READ CHECK-ENGINE CODES'}
          </button>

          {dtcs !== null && (
            allCodes.length === 0 ? (
              <div className="note" style={{ marginTop: 8, color: 'var(--green)' }}>
                No stored or pending codes. All clear.
              </div>
            ) : (
              <>
                <div style={{ marginTop: 10 }}>
                  {allCodes.map(c => {
                    const d = diag?.codes?.find(x => x.code === c)
                    const pendingOnly = dtcs.pending.includes(c) && !dtcs.stored.includes(c)
                    return (
                      <div key={c} className="dtcrow">
                        <div className="dtchead">
                          <span className={'flag ' + (pendingOnly ? 'due-soon' : 'overdue')}>
                            {pendingOnly ? '◐ ' : '● '}{c}{pendingOnly ? ' PENDING' : ''}
                          </span>
                          {d && <span className={'dtcsev sev-' + d.severity}>{d.severity.toUpperCase()}</span>}
                        </div>
                        <div className="dtcdesc">{d?.meaning || describeDtc(c)}</div>
                        {d && (
                          <div className="dtcdetail">
                            <div><b>Likely causes:</b> {d.likely_causes.join(' → ')}</div>
                            <div><b>DIY:</b> {d.diy}</div>
                            <div><b>Urgency:</b> {d.urgency}</div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {diag?.summary && <div className="note" style={{ marginTop: 8 }}>{diag.summary}</div>}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  {!diag && (
                    <button className="btn2" style={{ flex: 1, color: 'var(--amber)', borderColor: 'rgba(255,176,0,0.4)' }}
                      onClick={explain} disabled={busyBtn === 'explain'}>
                      {busyBtn === 'explain' ? 'DIAGNOSING…' : `✦ DIAGNOSE FOR ${(vehicle.name || '').toUpperCase()}`}
                    </button>
                  )}
                  <button className="btn2" style={{ flex: 1 }} onClick={logToHistory} disabled={busyBtn === 'log'}>
                    {busyBtn === 'log' ? 'LOGGING…' : 'LOG TO HISTORY'}
                  </button>
                  <button className="btn2" style={{ flex: 1, color: 'var(--red)', borderColor: 'rgba(255,77,77,0.4)' }}
                    onClick={clearCodes} disabled={busyBtn === 'clear'}>
                    {busyBtn === 'clear' ? 'CLEARING…' : 'CLEAR CODES'}
                  </button>
                </div>
              </>
            )
          )}
          {err && <div className="err" style={{ marginTop: 8 }}>{err}</div>}
        </>
      )}
    </div>
  )
}
