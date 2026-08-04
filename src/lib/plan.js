import { supabase } from './supabase.js'

// Resolve the fleet's plan client-side (UX gating only — the real wall is
// the Postgres triggers from migration 0012). Fail-open: if billing tables
// aren't migrated yet, everything stays enabled and the Plan panel says so.
export async function fetchPlan(ownerId) {
  const [tierRes, limitsRes] = await Promise.all([
    supabase.rpc('effective_tier', { owner: ownerId }),
    supabase.from('plan_limits').select('*'),
  ])
  if (tierRes.error || limitsRes.error) return { ready: false }
  const plan = { ready: true, tier: tierRes.data, limits: limitsRes.data || [] }
  // Purchased extra vehicle slots (family add-on). Fail-open to 0 — the rpc
  // arrives with migration 0022.
  const { data: extras } = await supabase.rpc('extra_vehicles', { owner: ownerId })
  plan.extraVehicles = Number(extras) || 0
  if (plan.tier === 'free' || plan.tier === 'expired') {
    const { data: ends } = await supabase.rpc('trial_ends_at', { owner: ownerId })
    if (ends) plan.trialEndsAt = ends
  }
  return plan
}

// Pure — tested. Turns plan + current counts into UI gating facts.
export function planStatus(plan, counts) {
  if (!plan?.ready) {
    return { ready: false, tier: null, canAddVehicle: true, canAddMember: true, features: {} }
  }
  const row = plan.limits.find(l => l.tier === plan.tier)
  if (!row) return { ready: false, tier: plan.tier, canAddVehicle: true, canAddMember: true, features: {} }
  const maxVehicles = row.max_vehicles + (plan.extraVehicles || 0)
  return {
    ready: true,
    tier: plan.tier,
    maxVehicles,
    maxMembers: row.max_members,
    extraVehicles: plan.extraVehicles || 0,
    vehiclesUsed: counts.vehicles,
    membersUsed: counts.members,
    canAddVehicle: counts.vehicles < maxVehicles,
    canAddMember: counts.members < row.max_members,
    features: row.features || {},
  }
}
