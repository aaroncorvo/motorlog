// Cellular TLS relay for telematics devices.
//
// The SIM7670G modem's CA store trusts Let's Encrypt (Netlify) but not Google
// Trust Services (Supabase) — verified on-device: a TLS POST to Netlify
// completes while the same POST to Supabase fails the handshake (+HTTPACTION
// 715). This function terminates the device's TLS on a CA it trusts and
// forwards the body to the ingest-telemetry edge function over Netlify's own
// (fully verified) TLS. The device key stays inside the encrypted body on both
// hops — it is never sent in the clear.
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://fxycfrtycqxdlhrpfeiv.supabase.co'
const ANON = process.env.VITE_SUPABASE_KEY

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type, x-device-key, apikey',
      },
    })
  }
  const body = await req.text()
  const upstream = await fetch(`${SUPABASE_URL}/functions/v1/ingest-telemetry`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: ANON,
      ...(req.headers.get('x-device-key') ? { 'x-device-key': req.headers.get('x-device-key') } : {}),
    },
    body,
  })
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  })
}

export const config = { path: '/api/ingest' }
