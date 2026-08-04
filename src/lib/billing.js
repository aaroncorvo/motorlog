import { supabase } from './supabase.js'

// Both calls return a Stripe-hosted URL and navigate to it — no card data
// ever passes through our code. The webhook writes the subscription row;
// effective_tier() picks it up on the next plan fetch.
async function invoke(body) {
  const { data, error } = await supabase.functions.invoke('stripe-checkout', { body })
  if (error || !data?.url) throw new Error(data?.error || error?.message || 'Billing service unavailable')
  window.location.assign(data.url)
}

export const startCheckout = (tier) => invoke({ action: 'checkout', tier })
export const openPortal = () => invoke({ action: 'portal' })
