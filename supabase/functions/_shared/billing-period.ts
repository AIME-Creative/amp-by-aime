// Shared subscription field resolver used by Stripe-touching edge functions.
// Returns lowercase billing_period + payment_amount, preferring the
// subscription_plans row for the price ID and falling back to the price's
// own recurring.interval / unit_amount. The fallback is load-bearing —
// without it, a price missing from subscription_plans silently produces
// nulls and downstream mismatch checks skip the write.
import type Stripe from 'npm:stripe@^17.4.0'

export type ResolvedSubscriptionFields = {
  billingPeriod: 'annual' | 'monthly' | null
  paymentAmount: number | null
}

// Minimal supabase client shape we depend on. Untyped to avoid coupling
// this helper to a specific @supabase/supabase-js import path.
type SupabaseLike = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        single: () => Promise<{ data: { billing_period: string | null } | null }>
      }
    }
  }
}

export async function resolveSubscriptionFields(
  stripe: Stripe,
  supabase: SupabaseLike,
  subscription: Stripe.Subscription | string,
): Promise<ResolvedSubscriptionFields> {
  let sub: Stripe.Subscription
  try {
    sub = typeof subscription === 'string'
      ? await stripe.subscriptions.retrieve(subscription)
      : subscription
  } catch (err) {
    console.error('resolveSubscriptionFields: failed to retrieve subscription', err)
    return { billingPeriod: null, paymentAmount: null }
  }

  const item = sub.items.data[0]
  const priceId = item?.price?.id ?? null
  const unitAmount = item?.price?.unit_amount
  const paymentAmount = typeof unitAmount === 'number' ? unitAmount / 100 : null

  let billingPeriod: 'annual' | 'monthly' | null = null

  if (priceId) {
    const { data: plan } = await supabase
      .from('subscription_plans')
      .select('billing_period')
      .eq('stripe_price_id', priceId)
      .single()
    if (plan?.billing_period === 'annual' || plan?.billing_period === 'monthly') {
      billingPeriod = plan.billing_period as 'annual' | 'monthly'
    }
  }

  if (!billingPeriod) {
    const interval = item?.price?.recurring?.interval
    if (interval === 'year') billingPeriod = 'annual'
    else if (interval === 'month') billingPeriod = 'monthly'
  }

  return { billingPeriod, paymentAmount }
}
