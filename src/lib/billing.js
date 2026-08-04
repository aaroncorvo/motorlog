import { supabase } from './supabase.js'

// All billing goes through the stripe-checkout edge function — no card data
// ever passes through our code. Checkout/portal return a Stripe-hosted URL;
// slot changes charge the card on file and return the new quantity.
async function invoke(body) {
  const { data, error } = await supabase.functions.invoke('stripe-checkout', { body })
  if (error || data?.error) throw new Error(data?.error || error?.message || 'Billing service unavailable')
  return data
}

export const startCheckout = (tier) =>
  invoke({ action: 'checkout', tier }).then(d => { window.location.assign(d.url) })

export const openPortal = () =>
  invoke({ action: 'portal' }).then(d => { window.location.assign(d.url) })

export const setExtraVehicles = (qty) =>
  invoke({ action: 'set_extra_vehicles', qty }).then(d => d.qty)
