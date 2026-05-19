// AIME-14: profile lookup helpers shared across Stripe handlers.

import type { SupabaseClient } from '@supabase/supabase-js';

export interface ProfileForSync {
  id: string;
  email: string | null;
  full_name: string | null;
  plan_tier: string;
  stripe_subscription_id: string | null;
  subscription_override: boolean;
  pending_plan_tier: string | null;
  pending_plan_price_id: string | null;
  payment_failed_at: string | null;
}

const PROFILE_SELECT =
  'id, email, full_name, plan_tier, stripe_subscription_id, subscription_override, pending_plan_tier, pending_plan_price_id, payment_failed_at';

export async function findProfileByCustomerId(
  db: SupabaseClient,
  customerId: string,
): Promise<ProfileForSync | null> {
  const { data, error } = await db
    .from('profiles')
    .select(PROFILE_SELECT)
    .eq('stripe_customer_id', customerId)
    .maybeSingle();
  if (error) throw error;
  return (data as ProfileForSync | null) ?? null;
}

// Cross-profile duplicate-subscription guard. Mirrors the
// "DUPLICATE PREVENTED" pattern in the legacy EF — refuses to write a
// subscription_id onto a profile when another profile already owns
// that subscription.
//
// Returns the email of the conflicting owner (for logging) if a
// conflict exists, or null when the write is safe.
export async function detectSubscriptionDuplicate(
  db: SupabaseClient,
  subscriptionId: string,
  thisProfileId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from('profiles')
    .select('id, email')
    .eq('stripe_subscription_id', subscriptionId)
    .neq('id', thisProfileId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? ((data as { email: string }).email ?? 'unknown') : null;
}
