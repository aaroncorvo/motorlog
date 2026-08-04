// Native-platform helpers. Everything here degrades to sensible web behavior
// so the same bundle runs as a website, a PWA, and inside Capacitor.
import { Capacitor } from '@capacitor/core'

export const isNative = () => Capacitor.isNativePlatform()
export const platform = () => Capacitor.getPlatform()   // 'web' | 'ios' | 'android'

// The app is served from capacitor://localhost in the wrapper, so Netlify's
// /nhtsa/* rewrite doesn't exist. CapacitorHttp routes native fetches through
// the OS HTTP stack, which isn't subject to CORS — so we can call NHTSA direct.
export const nhtsaBase = () => (isNative() ? 'https://api.nhtsa.gov' : '/nhtsa')

// OAuth redirects must land on a real https origin (Google rejects custom
// schemes and blocks embedded webviews), so the native flow uses the web
// origin + a universal/app link back into the app.
export const WEB_ORIGIN = 'https://app.motorlog.co'
export const oauthRedirect = () =>
  isNative() ? `${WEB_ORIGIN}/gdrive-callback` : `${window.location.origin}/`

// Supabase session storage: iOS can evict WKWebView localStorage under storage
// pressure, which would silently sign the user out. Native builds persist the
// session in the OS keystore-backed Preferences instead.
export function makeAuthStorage() {
  if (!isNative()) return undefined            // supabase-js default: localStorage
  // Lazy import keeps @capacitor/preferences out of the web bundle's hot path.
  // Every call falls back to localStorage on failure: a plugin problem must
  // degrade session persistence, never hang the auth check behind an
  // unresolved promise (that shows as an infinite splash spinner).
  const load = () => import('@capacitor/preferences').then(m => m.Preferences)
  const guard = async (fn, fallback) => {
    try { return await fn() } catch (e) {
      console.warn('[native] Preferences unavailable, using localStorage:', e?.message)
      return fallback()
    }
  }
  return {
    getItem: (key) => guard(
      async () => (await (await load()).get({ key })).value ?? null,
      () => window.localStorage.getItem(key)),
    setItem: (key, value) => guard(
      async () => { await (await load()).set({ key, value }) },
      () => window.localStorage.setItem(key, value)),
    removeItem: (key) => guard(
      async () => { await (await load()).remove({ key }) },
      () => window.localStorage.removeItem(key)),
  }
}

// Scoped native HTTP GET returning parsed JSON — used only where the target
// API lacks CORS headers (NHTSA). The global CapacitorHttp fetch patch is OFF
// because it breaks Supabase auth; this helper touches nothing else.
export async function nativeGetJson(url) {
  const { CapacitorHttp } = await import('@capacitor/core')
  const res = await CapacitorHttp.get({ url, responseType: 'json' })
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`)
  return typeof res.data === 'string' ? JSON.parse(res.data) : res.data
}
