import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { stripe } from './config'

export type ResolvedSubscriptionFields = {
  billingPeriod: 'annual' | 'monthly' | null
  paymentAmount: number | null
}

export async function resolveSubscriptionFields(
  supabase: SupabaseClient,
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
      billingPeriod = plan.billing_period
    }
  }

  if (!billingPeriod) {
    const interval = item?.price?.recurring?.interval
    if (interval === 'year') billingPeriod = 'annual'
    else if (interval === 'month') billingPeriod = 'monthly'
  }

  return { billingPeriod, paymentAmount }
}
