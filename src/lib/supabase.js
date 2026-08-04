import { createClient } from '@supabase/supabase-js'
import { makeAuthStorage } from './native.js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_KEY

// On native builds the session lives in OS-backed Preferences rather than
// WKWebView localStorage, which iOS may evict (see lib/native.js).
const storage = makeAuthStorage()

export const supabase = (url && key)
  ? createClient(url, key, storage ? { auth: { storage, persistSession: true, autoRefreshToken: true } } : undefined)
  : null
export const configMissing = !supabase
