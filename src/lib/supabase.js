import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_KEY

// Auth state lives in WebView localStorage on every platform — same as the
// PWA has always done. A Preferences-backed adapter was tried for iOS but its
// async dynamic import can wedge supabase-js's internal auth lock (getSession
// holds it, signIn waits on it forever). If eviction-proof persistence is
// wanted later, preload the plugin eagerly BEFORE createClient — never lazily
// inside the storage callbacks.
export const supabase = (url && key) ? createClient(url, key) : null
export const configMissing = !supabase
