// crm-sync — pushes every MotorLog user into the GHL (LeadConnector) sub-account
// as a contact with plan-state tags, so CRM workflows can react (welcome,
// trial-ending, payment-failed, upgrade nudges). Full idempotent upsert each
// run — fine at beta scale, no queue to break.
// Deploy with Verify JWT **OFF** (cron-secret auth, same pattern as google-drive).
// Secrets: GHL_API_KEY (private integration token), GHL_LOCATION_ID,
// GDRIVE_CRON_SECRET (the project's shared cron secret — already set).
import { createClient } from 'npm:@supabase/supabase-js@2'

const GHL = 'https://services.leadconnectorhq.com'

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== Deno.env.get('GDRIVE_CRON_SECRET')) {
    return new Response('forbidden', { status: 403 })
  }
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  const { data: { users }, error: uerr } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (uerr) return new Response(`auth: ${uerr.message}`, { status: 500 })

  const { data: vehicles } = await admin.from('vehicles').select('user_id').eq('archived', false)
  const vcount = new Map<string, number>()
  for (const v of vehicles ?? []) vcount.set(v.user_id, (vcount.get(v.user_id) ?? 0) + 1)

  const { data: subs } = await admin.from('subscriptions')
    .select('owner_user_id, provider, status')
  const isBeta = new Set((subs ?? []).filter(s => s.provider === 'comp' && s.status === 'active')
    .map(s => s.owner_user_id))

  let synced = 0
  const failures: string[] = []
  for (const u of users) {
    if (!u.email) continue
    const { data: tier } = await admin.rpc('effective_tier', { owner: u.id })
    const tags = ['motorlog', `plan-${tier ?? 'free'}`]
    if (isBeta.has(u.id)) tags.push('beta')
    const res = await fetch(`${GHL}/contacts/upsert`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${Deno.env.get('GHL_API_KEY')}`,
        Version: '2021-07-28',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        locationId: Deno.env.get('GHL_LOCATION_ID'),
        email: u.email,
        name: (u.user_metadata as Record<string, string>)?.full_name || undefined,
        tags,
        source: 'motorlog-app',
        customFields: [
          { key: 'motorlog_vehicles', field_value: String(vcount.get(u.id) ?? 0) },
          { key: 'motorlog_signup', field_value: (u.created_at ?? '').slice(0, 10) },
        ],
      }),
    })
    if (res.ok) synced++
    else failures.push(`${u.email}: ${res.status} ${(await res.text()).slice(0, 120)}`)
  }
  return new Response(JSON.stringify({ synced, failures }), {
    headers: { 'content-type': 'application/json' },
  })
})
