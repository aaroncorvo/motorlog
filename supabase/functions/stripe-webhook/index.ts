// stripe-webhook — Stripe → subscriptions table. Deploy with Verify JWT **OFF**
// (Stripe signs requests instead; we verify the Stripe-Signature HMAC here).
// Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_* (same 3).
// Subscribe the endpoint to: checkout.session.completed,
// customer.subscription.created / updated / deleted.
import { createClient } from 'npm:@supabase/supabase-js@2'

const enc = new TextEncoder()

async function verifySignature(payload: string, header: string | null, secret: string) {
  if (!header) return false
  let t = ''
  const v1s: string[] = []
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2)
    if (k === 't') t = v
    if (k === 'v1') v1s.push(v)
  }
  if (!t || !v1s.length) return false
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false
  const key = await crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`))
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('')
  return v1s.includes(hex)
}

function tierForPrice(priceId: string | undefined) {
  if (!priceId) return null
  for (const tier of ['individual', 'family', 'commercial']) {
    if (Deno.env.get(`STRIPE_PRICE_${tier.toUpperCase()}`) === priceId) return tier
  }
  return null
}

// Stripe status → our status vocabulary ('trialing'|'active'|'past_due'|'canceled'|'expired')
function mapStatus(s: string) {
  if (s === 'active' || s === 'trialing' || s === 'past_due') return s
  if (s === 'incomplete_expired') return 'expired'
  return 'canceled'
}

async function fetchStripe(path: string) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { authorization: `Bearer ${Deno.env.get('STRIPE_SECRET_KEY')}` },
  })
  if (!res.ok) throw new Error(`stripe GET ${path} ${res.status}`)
  return res.json()
}

Deno.serve(async (req) => {
  const payload = await req.text()
  const ok = await verifySignature(payload, req.headers.get('stripe-signature'),
    Deno.env.get('STRIPE_WEBHOOK_SECRET')!)
  if (!ok) return new Response('bad signature', { status: 400 })

  const event = JSON.parse(payload)
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  let sub: Record<string, unknown> | null = null
  if (event.type === 'checkout.session.completed' && event.data.object.subscription) {
    sub = await fetchStripe(`/subscriptions/${event.data.object.subscription}`)
  } else if (event.type.startsWith('customer.subscription.')) {
    sub = event.data.object
  }
  if (!sub) return new Response('ignored', { status: 200 })

  const item = (sub as any).items?.data?.[0]
  const owner = (sub as any).metadata?.user_id ??
    (await admin.from('billing_customers').select('user_id')
      .eq('stripe_customer_id', (sub as any).customer).maybeSingle()).data?.user_id
  const tier = tierForPrice(item?.price?.id)
  if (!owner || !tier) return new Response('unmapped — ignored', { status: 200 })

  // period end lives on the item in newer API versions, on the sub in older ones
  const periodEnd = (sub as any).current_period_end ?? item?.current_period_end
  const status = event.type === 'customer.subscription.deleted'
    ? 'canceled' : mapStatus((sub as any).status)

  const { error } = await admin.from('subscriptions').upsert({
    owner_user_id: owner,
    provider: 'stripe',
    provider_subscription_id: (sub as any).id,
    tier,
    status,
    current_period_end: new Date(periodEnd * 1000).toISOString(),
    cancel_at_period_end: !!(sub as any).cancel_at_period_end,
    raw: { customer: (sub as any).customer, price: item?.price?.id, event: event.type },
    updated_at: new Date().toISOString(),
  }, { onConflict: 'provider_subscription_id' })
  if (error) return new Response(`db: ${error.message}`, { status: 500 })

  return new Response('ok', { status: 200 })
})
