import React, { useEffect, useState, useCallback, useRef } from 'react'
import { supabase, configMissing } from './lib/supabase.js'
import { dailyRecallCheck } from './lib/recalls.js'
import { fetchPlan } from './lib/plan.js'
import { fetchTelemetryOdos } from './lib/telem.js'
import { isNative, oauthRedirect } from './lib/native.js'
import Dashboard, { AddVehicleForm } from './components/Dashboard.jsx'
import FuelScreen from './components/FuelScreen.jsx'
import ServiceScreen from './components/ServiceScreen.jsx'
import MaintenanceScreen from './components/MaintenanceScreen.jsx'
import DataScreen from './components/DataScreen.jsx'
import TcoScreen from './components/TcoScreen.jsx'
import ProfileScreen from './components/ProfileScreen.jsx'
import VehicleSelect from './components/VehicleSelect.jsx'
import GloveboxSheet from './components/GloveboxSheet.jsx'
import NotificationBell from './components/NotificationBell.jsx'

const TABS = ['Fleet', 'Vehicle', 'Fuel', 'Service', 'Maint', 'TCO', 'Settings']
const VEHICLE_TABS = ['Vehicle', 'Fuel', 'Service', 'Maint', 'TCO']

// 24px stroke icons, one per tab — the Fleet mark is the brand's ///
const ICONS = {
  Fleet: <><path d="M7.5 19L11 5" /><path d="M12.5 19L16 5" /><path d="M17.5 19L21 5" /></>,
  Vehicle: <><path d="M4 16v-2.2c0-.9.5-1.7 1.3-2L7 11l1.6-3.2A2 2 0 0 1 10.4 6.5h3.2a2 2 0 0 1 1.8 1.3L17 11l1.7.8c.8.3 1.3 1.1 1.3 2V16" /><circle cx="7.5" cy="16.5" r="1.8" /><circle cx="16.5" cy="16.5" r="1.8" /><path d="M9.5 16.5h4.5" /></>,
  Fuel: <><path d="M4 21V6a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v15" /><path d="M3.5 21h10" /><path d="M13 10h2a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0v-7l-2.5-2.5" /><path d="M6.5 8h4" /></>,
  Service: <><path d="M14.5 6.5a4 4 0 0 0-5.3 5.3L4 17l3 3 5.2-5.2a4 4 0 0 0 5.3-5.3L14.6 12 12 9.4l2.5-2.9z" /></>,
  Maint: <><path d="M4.5 14a7.5 7.5 0 0 1 15 0" /><path d="M12 14l3.4-3.9" /><path d="M4.5 14H3M21 14h-1.5M6 8.5l-1-1M18 8.5l1-1M12 5.5V4" /></>,
  TCO: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5v9" /><path d="M14.5 9.3c-.5-.8-1.4-1.2-2.5-1.2-1.5 0-2.6.8-2.6 1.9 0 2.6 5.2 1.3 5.2 3.9 0 1.1-1.1 1.9-2.6 1.9-1.1 0-2-.4-2.5-1.2" /></>,
  Settings: <><circle cx="12" cy="12" r="3.1" /><path d="M12 2.9v2.6M12 18.5v2.6M2.9 12h2.6M18.5 12h2.6M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" /></>,
}

export default function App() {
  const [session, setSession] = useState(null)
  const [authReady, setAuthReady] = useState(false)
  const [tab, setTab] = useState('Fleet')
  const [vid, setVid] = useState(null)          // globally selected vehicle
  const [theme, setTheme] = useState(() => localStorage.getItem('ml_theme') || 'dark')
  const [vehicles, setVehicles] = useState([])
  const [fuelLogs, setFuelLogs] = useState([])
  const [serviceLogs, setServiceLogs] = useState([])
  const [maintItems, setMaintItems] = useState([])
  const [fixedCosts, setFixedCosts] = useState([])
  const [fixedCostsError, setFixedCostsError] = useState(false)
  const [receipts, setReceipts] = useState([])
  const [receiptsError, setReceiptsError] = useState(false)
  const [photos, setPhotos] = useState([])
  const [photosError, setPhotosError] = useState(false)
  const [recalls, setRecalls] = useState([])
  const [recallsError, setRecallsError] = useState(false)
  const [docs, setDocs] = useState([])
  const [docsError, setDocsError] = useState(false)
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState(null)
  const [gbOpen, setGbOpen] = useState(false)
  const [plan, setPlan] = useState(null)      // fleet owner's billing plan (0012)
  const [telemOdos, setTelemOdos] = useState({})   // vehicle_id → telemetry-derived odometer

  const showToast = useCallback((msg) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2200)
  }, [])

  // Native: dismiss the splash as soon as React mounts — otherwise it lingers
  // on a fixed timeout ("automatically hidden" warning in the device logs)
  useEffect(() => {
    if (!isNative()) return
    import('@capacitor/splash-screen')
      .then(({ SplashScreen }) => SplashScreen.hide())
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (configMissing) return
    // A failed or slow session read must still reveal the login screen — an
    // unresolved promise here renders as a permanent splash spinner.
    const timeout = new Promise(resolve => setTimeout(() => resolve({ data: {} }), 8000))
    Promise.race([supabase.auth.getSession(), timeout])
      .catch(e => { console.warn('[auth] getSession failed:', e?.message); return { data: {} } })
      .then(({ data }) => {
        setSession(data?.session ?? null)
        setAuthReady(true)
      })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    const [v, f, s, m, fc, rc, ph, rec, dd] = await Promise.all([
      supabase.from('vehicles').select('*').eq('archived', false).order('sort_order'),
      supabase.from('fuel_logs').select('*').order('odometer'),
      supabase.from('service_logs').select('*').order('serviced_at', { ascending: false }),
      supabase.from('maintenance_items').select('*').order('name'),
      supabase.from('fixed_costs').select('*').order('name'),
      supabase.from('receipts').select('*').order('receipt_date', { ascending: false }),
      supabase.from('vehicle_photos').select('*').order('created_at'),
      supabase.from('recalls').select('*').order('report_date', { ascending: false }),
      supabase.from('driver_docs').select('*').order('created_at'),
    ])
    setVehicles(v.data || [])
    setFuelLogs(f.data || [])
    setServiceLogs(s.data || [])
    setMaintItems(m.data || [])
    setFixedCosts(fc.data || [])
    setFixedCostsError(!!fc.error)   // table missing until migration 0002 is applied
    setReceipts(rc.data || [])
    setReceiptsError(!!rc.error)     // table missing until migration 0003 is applied
    setPhotos(ph.data || [])
    setPhotosError(!!ph.error)       // table missing until migration 0004 is applied
    setRecalls(rec.data || [])
    setRecallsError(!!rec.error)     // table missing until migration 0007 is applied
    setDocs(dd.data || [])
    setDocsError(!!dd.error)         // table missing until migration 0009 is applied
    setLoading(false)
    fetchTelemetryOdos(v.data || []).then(setTelemOdos)   // non-blocking
  }, [])

  useEffect(() => { if (session) refresh() }, [session, refresh])

  // keep the global selection valid as vehicles load/change; each device
  // remembers its driver's vehicle and lands on their Profile at open
  const landed = useRef(false)
  useEffect(() => {
    if (!vehicles.length) return
    if (!vehicles.some(v => v.id === vid)) {
      const saved = localStorage.getItem('ml_vid')
      const pick = vehicles.find(v => v.id === saved)?.id ?? vehicles[0].id
      setVid(pick)
      if (!landed.current && pick === saved && !window.location.search) setTab('Vehicle')
    }
    landed.current = true
  }, [vehicles, vid])
  useEffect(() => { if (vid) localStorage.setItem('ml_vid', vid) }, [vid])

  // Fleet owner's plan — gates cosmetic UI; triggers in Postgres are the wall
  useEffect(() => {
    const owner = vehicles[0]?.user_id ?? session?.user?.id
    if (!owner) return
    let live = true
    fetchPlan(owner).then(p => { if (live) setPlan(p) })
    return () => { live = false }
  }, [vehicles, session])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('ml_theme', theme)
  }, [theme])

  // Once-daily NHTSA recall sweep across the fleet
  const recallSweepDone = useRef(false)
  useEffect(() => {
    if (recallSweepDone.current || !vehicles.length || recallsError) return
    recallSweepDone.current = true
    dailyRecallCheck(vehicles, recalls).then(added => {
      if (added) { showToast(`⚠ ${added} NEW RECALL${added > 1 ? 'S' : ''} FOUND`); refresh() }
    })
  }, [vehicles, recalls, recallsError, refresh, showToast])

  // Native builds receive the OAuth code as a universal/app link rather than a
  // page load, so push it into the same query-param path the web flow uses.
  useEffect(() => {
    if (!isNative()) return
    let remove
    import('@capacitor/app').then(({ App: CapApp }) => {
      CapApp.addListener('appUrlOpen', ({ url }) => {
        const q = url.includes('?') ? url.slice(url.indexOf('?')) : ''
        if (q.includes('code=')) {
          window.history.replaceState({}, '', window.location.pathname + q)
          window.dispatchEvent(new Event('ml-oauth-return'))
        }
      }).then(h => { remove = () => h.remove() })
    })
    return () => remove?.()
  }, [])

  // Google Drive OAuth redirect: ?code=...&state=... lands back on the app root
  const [oauthTick, setOauthTick] = useState(0)
  useEffect(() => {
    const bump = () => setOauthTick(t => t + 1)
    window.addEventListener('ml-oauth-return', bump)
    return () => window.removeEventListener('ml-oauth-return', bump)
  }, [])
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code'), state = params.get('state')
    if (!session || !code) return
    window.history.replaceState({}, '', window.location.pathname)
    if (state !== sessionStorage.getItem('gdrive_state')) { showToast('DRIVE CONNECT FAILED: state mismatch'); return }
    sessionStorage.removeItem('gdrive_state')
    supabase.functions.invoke('google-drive', {
      body: { action: 'exchange', code, redirect_uri: oauthRedirect() },
    }).then(({ data, error }) => {
      if (error || data?.error) showToast('DRIVE CONNECT FAILED: ' + (data?.error || error.message))
      else { showToast('GOOGLE DRIVE CONNECTED — ' + (data.email || '')); setTab('Settings') }
    })
  }, [session, showToast, oauthTick])

  if (configMissing) return (
    <div className="empty" style={{ paddingTop: '30vh' }}>
      VITE_SUPABASE_URL / VITE_SUPABASE_KEY not set.<br />Configure environment variables and rebuild.
    </div>
  )
  if (!authReady) return <div className="spin" style={{ marginTop: '40vh' }} />
  if (!session) return <AuthGate />

  const commonProps = { vehicles, fuelLogs, serviceLogs, maintItems, vid, setVid, refresh, showToast, telemOdos }

  return (
    <>
      <header className="hdr">
        <div>
          <h1><span className="tick">///</span> MOTORLOG</h1>
          <div className="sub">{vehicles.length} VEHICLES · TRACKED</div>
        </div>
        {vehicles.length > 0 && (
          <div className="hdr-actions">
            <NotificationBell vehicles={vehicles} />
            <button className="gbbtn" onClick={() => setGbOpen(true)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 10h18" /><path d="M7 14.5h5" /></svg>
              GLOVEBOX
            </button>
          </div>
        )}
      </header>

      <div className="wrap">
        {loading ? <div className="spin" /> : (
          vehicles.length === 0 ? <EmptyFleet refresh={refresh} showToast={showToast} /> : <>
          {VEHICLE_TABS.includes(tab) && <VehicleSelect vehicles={vehicles} vid={vid} setVid={setVid} photos={photos} />}
          {
          tab === 'Fleet' ? <Dashboard {...commonProps} photos={photos} recalls={recalls} fixedCosts={fixedCosts} docs={docs} plan={plan} goTab={setTab} /> :
          tab === 'Vehicle' ? <ProfileScreen {...commonProps} receipts={receipts} photos={photos} photosError={photosError} recalls={recalls} recallsError={recallsError} docs={docs} docsError={docsError} goTab={setTab} /> :
          tab === 'Fuel' ? <FuelScreen {...commonProps} /> :
          tab === 'Service' ? <ServiceScreen {...commonProps} receipts={receipts} receiptsError={receiptsError} /> :
          tab === 'Maint' ? <MaintenanceScreen {...commonProps} /> :
          tab === 'TCO' ? <TcoScreen {...commonProps} fixedCosts={fixedCosts} fixedCostsError={fixedCostsError} /> :
          <DataScreen {...commonProps} theme={theme} setTheme={setTheme} plan={plan} />}
          </>
        )}
      </div>

      <nav className="nav">
        {TABS.map(t => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">{ICONS[t]}</svg>
            {t}
          </button>
        ))}
      </nav>

      <GloveboxSheet open={gbOpen} onClose={() => setGbOpen(false)} docs={docs}
        vehicles={vehicles} vid={vid} goTab={t => { setGbOpen(false); setTab(t) }} />

      {toast && <div className="toast">{toast}</div>}
    </>
  )
}

function EmptyFleet({ refresh, showToast }) {
  const [adding, setAdding] = useState(false)
  if (adding) return (
    <>
      <div className="section-label">Add Your First Vehicle</div>
      <AddVehicleForm nextSort={1}
        onDone={async (saved) => { setAdding(false); if (saved) { showToast('VEHICLE ADDED'); await refresh() } }} />
    </>
  )
  return (
    <div className="empty">
      WELCOME TO MOTORLOG
      <div style={{ marginTop: 8 }} className="note">
        Fuel, service, maintenance, and true cost-per-mile — for your whole fleet.
      </div>
      <div style={{ marginTop: 24 }}>
        <button className="btn" onClick={() => setAdding(true)}>
          + ADD YOUR FIRST VEHICLE BY VIN
        </button>
      </div>
      <div style={{ marginTop: 14 }} className="note">
        Decode the VIN and MotorLog fills in year, make, model, and engine specs.
        Everything you log stays private to your account.
      </div>
    </div>
  )
}

function AuthGate() {
  const [mode, setMode] = useState('signin')
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState(null)
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)

  const go = async () => {
    setErr(null); setMsg(null); setBusy(true)
    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({ email, password: pw })
        if (error) throw error
        setMsg('Account created. If email confirmation is on, check your inbox — otherwise sign in.')
        setMode('signin')
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password: pw })
        if (error) throw error
      }
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }

  return (
    <div className="auth">
      <h1><span className="tick">///</span> MOTORLOG</h1>
      <div className="tag">FUEL · SERVICE · MAINTENANCE · TCO</div>
      <div className="field">
        <label>Email</label>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" inputMode="email" />
      </div>
      <div className="field">
        <label>Password</label>
        <input type="password" value={pw} onChange={e => setPw(e.target.value)}
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          onKeyDown={e => e.key === 'Enter' && go()} />
      </div>
      {err && <div className="err">{err}</div>}
      {msg && <div className="ok">{msg}</div>}
      <button className="btn" onClick={go} disabled={busy || !email || !pw}>
        {busy ? '…' : mode === 'signup' ? 'CREATE ACCOUNT' : 'SIGN IN'}
      </button>
      <div className="swap">
        <button onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setErr(null) }}>
          {mode === 'signin' ? 'First time? Create the account' : 'Have an account? Sign in'}
        </button>
      </div>
    </div>
  )
}
