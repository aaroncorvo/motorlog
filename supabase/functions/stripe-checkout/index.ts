// stripe-checkout — creates Stripe Checkout / Billing Portal sessions for the
// signed-in user. Deploy with Verify JWT **ON** (only authed users may call).
// Secrets: STRIPE_SECRET_KEY, STRIPE_PRICE_INDIVIDUAL, STRIPE_PRICE_FAMILY,
// STRIPE_PRICE_COMMERCIAL. Optional: STRIPE_TAX=on (requires Stripe Tax enabled).
// Card data never touches this function — Stripe hosts the payment page.
import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const j = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } })

const PRICES: Record<string, string | undefined> = {
  individual: Deno.env.get('STRIPE_PRICE_INDIVIDUAL'),
  family: Deno.env.get('STRIPE_PRICE_FAMILY'),
  commercial: Deno.env.get('STRIPE_PRICE_COMMERCIAL'),
}
const APP = 'https://app.motorlog.co'

async function stripe(path: string, params: Record<string, string>) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${Deno.env.get('STRIPE_SECRET_KEY')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json?.error?.message || `stripe ${res.status}`)
  return json
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: { user } } = await admin.auth.getUser(token)
    if (!user) return j({ error: 'unauthorized' }, 401)

    const body = await req.json().catch(() => ({}))

    // One Stripe customer per auth user, minted lazily and remembered.
    const { data: existing } = await admin.from('billing_customers')
      .select('stripe_customer_id').eq('user_id', user.id).maybeSingle()
    let customerId = existing?.stripe_customer_id
    if (!customerId) {
      const c = await stripe('/customers', { email: user.email ?? '', 'metadata[user_id]': user.id })
      customerId = c.id
      await admin.from('billing_customers').upsert({ user_id: user.id, stripe_customer_id: customerId })
    }

    if (body.action === 'portal') {
      const s = await stripe('/billing_portal/sessions', { customer: customerId!, return_url: `${APP}/` })
      return j({ url: s.url })
    }

    // Family add-on: set the extra-vehicle slot count on the existing
    // subscription. Charges the card on file with immediate proration —
    // no checkout page needed. The webhook's subscription.updated event
    // writes the new quantity back to the subscriptions table.
    if (body.action === 'set_extra_vehicles') {
      const extraPrice = Deno.env.get('STRIPE_PRICE_EXTRA_VEHICLE')
      if (!extraPrice) return j({ error: 'extra-vehicle price not configured' }, 500)
      const qty = Math.max(0, Math.min(10, Math.floor(Number(body.qty ?? 0))))
      const subs = await fetch(
        `https://api.stripe.com/v1/subscriptions?customer=${customerId}&status=active&limit=10`,
        { headers: { authorization: `Bearer ${Deno.env.get('STRIPE_SECRET_KEY')}` } },
      ).then((r) => r.json())
      const famSub = subs.data?.find((s: any) =>
        s.items.data.some((i: any) => i.price.id === PRICES.family))
      if (!famSub) return j({ error: 'Extra vehicles require an active Family subscription' }, 400)
      const extraItem = famSub.items.data.find((i: any) => i.price.id === extraPrice)
      if (extraItem && qty === 0) {
        await fetch(`https://api.stripe.com/v1/subscription_items/${extraItem.id}`, {
          method: 'DELETE',
          headers: {
            authorization: `Bearer ${Deno.env.get('STRIPE_SECRET_KEY')}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ proration_behavior: 'always_invoice' }),
        })
      } else if (extraItem) {
        await stripe(`/subscription_items/${extraItem.id}`,
          { quantity: String(qty), proration_behavior: 'always_invoice' })
      } else if (qty > 0) {
        await stripe('/subscription_items', {
          subscription: famSub.id, price: extraPrice,
          quantity: String(qty), proration_behavior: 'always_invoice',
        })
      }
      return j({ ok: true, qty })
    }

    const price = PRICES[body.tier as string]
    if (!price) return j({ error: `unknown tier: ${body.tier}` }, 400)
    const params: Record<string, string> = {
      mode: 'subscription',
      customer: customerId!,
      client_reference_id: user.id,
      'line_items[0][price]': price,
      'line_items[0][quantity]': '1',
      'subscription_data[metadata][user_id]': user.id,
      'subscription_data[metadata][tier]': body.tier,
      allow_promotion_codes: 'true',
      success_url: `${APP}/?billing=success`,
      cancel_url: `${APP}/?billing=canceled`,
    }
    if (Deno.env.get('STRIPE_TAX') === 'on') {
      params['automatic_tax[enabled]'] = 'true'
      params['customer_update[address]'] = 'auto'
    }
    const s = await stripe('/checkout/sessions', params)
    return j({ url: s.url })
  } catch (e) {
    return j({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
