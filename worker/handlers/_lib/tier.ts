// AIME-14: plan_tier resolution + tier-change classification.
//
// Mirrors the tier-handling in the legacy stripe-webhook Edge Function
// at supabase/functions/stripe-webhook/index.ts. Keep this file in
// sync if subscription_plans gains new rows or the tier ordering shifts.

import type { SupabaseClient } from '@supabase/supabase-js';

// Same access-gating set as the legacy EF. Only these Stripe statuses
// grant paid-tier access in AMP.
export const PAID_ACCESS_STATUSES = new Set(['active', 'trialing']);

// Statuses that explicitly *revoke* paid access (set plan_tier=Canceled).
export const REVOKE_PAID_ACCESS_STATUSES = new Set([
  'canceled',
  'unpaid',
  'incomplete',
  'incomplete_expired',
  'paused',
]);

// Same ordering as the EF for upgrade/downgrade classification.
const TIER_ORDER = [
  'None',
  'Canceled',
  'Pending Checkout',
  'Free',
  'Premium Guest',
  'Premium',
  'Premium Processor',
  'Elite',
  'Elite Processor',
  'VIP',
  'VIP Processor',
] as const;

export type Tier = string;

export function classifyTierChange(
  from: Tier | null,
  to: Tier,
): 'upgrade' | 'downgrade' | 'no-change' {
  if (from === to) return 'no-change';
  const oldIdx = from ? TIER_ORDER.indexOf(from as (typeof TIER_ORDER)[number]) : -1;
  const newIdx = TIER_ORDER.indexOf(to as (typeof TIER_ORDER)[number]);
  return newIdx > oldIdx ? 'upgrade' : 'downgrade';
}

// Look up the AMP plan_tier name from a Stripe price ID via the
// subscription_plans table. Returns null if the price isn't mapped
// (typically a price that was created in Stripe but not seeded into
// subscription_plans yet).
export async function tierFromPriceId(
  db: SupabaseClient,
  priceId: string,
): Promise<Tier | null> {
  const { data, error } = await db
    .from('subscription_plans')
    .select('plan_tier')
    .eq('stripe_price_id', priceId)
    .maybeSingle();
  if (error) {
    console.error('[tier] subscription_plans lookup failed:', error);
    return null;
  }
  return (data?.plan_tier as Tier | undefined) ?? null;
}
