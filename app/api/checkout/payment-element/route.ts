import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { stripe } from '@/lib/stripe/config'
import { parseFullName } from '@/lib/utils/name-parser'
import Stripe from 'stripe'

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { planId, billingInterval, promotionCode } = await request.json()

    if (!planId) {
      return NextResponse.json({ error: 'planId is required' }, { status: 400 })
    }

    if (!['monthly', 'annual'].includes(billingInterval)) {
      return NextResponse.json(
        { error: 'Invalid billing interval' },
        { status: 400 },
      )
    }

    const planTier = mapPlanIdToTier(planId)
    if (!planTier) {
      return NextResponse.json(
        { error: `Invalid plan ID: ${planId}` },
        { status: 400 },
      )
    }

    const { data: subscriptionPlan, error: planError } = await supabase
      .from('subscription_plans')
      .select('stripe_price_id, name')
      .eq('plan_tier', planTier)
      .eq('billing_period', billingInterval)
      .eq('is_active', true)
      .single()

    if (planError || !subscriptionPlan?.stripe_price_id) {
      console.error('Plan lookup error:', planError, { planTier, billingInterval })
      return NextResponse.json(
        { error: 'Plan not configured' },
        { status: 400 },
      )
    }

    // Dev override: when STRIPE_TEST_PRICE_<TIER>_<PERIOD> env vars are
    // set, prefer those over the DB value so dev can run against Stripe
    // test mode without mutating the shared prod subscription_plans
    // rows. Prod env never sets these → falls back to DB unchanged.
    const envKey = `STRIPE_TEST_PRICE_${planTier.toUpperCase()}_${billingInterval.toUpperCase()}`
    const envOverridePriceId = process.env[envKey]
    const stripePriceId = envOverridePriceId || subscriptionPlan.stripe_price_id
    if (envOverridePriceId) {
      console.log(`Using ${envKey} override (${envOverridePriceId}) instead of DB price ${subscriptionPlan.stripe_price_id}`)
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id, email, first_name, last_name, full_name')
      .eq('id', user.id)
      .single()

    let customerId = profile?.stripe_customer_id
    let firstName = profile?.first_name || ''
    let lastName = profile?.last_name || ''
    if (!firstName && !lastName && profile?.full_name) {
      const parsed = parseFullName(profile.full_name)
      firstName = parsed.firstName
      lastName = parsed.lastName
    }
    const customerName =
      [firstName, lastName].filter(Boolean).join(' ').trim() || undefined

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email || profile?.email,
        name: customerName,
        metadata: { supabase_user_id: user.id },
      })
      customerId = customer.id

      await supabase
        .from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', user.id)
    } else if (customerName) {
      const existing = (await stripe.customers.retrieve(
        customerId,
      )) as Stripe.Customer
      if (!existing.name) {
        await stripe.customers.update(customerId, { name: customerName })
      }
    }

    let promotionCodeId: string | undefined
    if (promotionCode && typeof promotionCode === 'string' && promotionCode.trim()) {
      const codes = await stripe.promotionCodes.list({
        code: promotionCode.trim(),
        active: true,
        limit: 1,
      })
      if (codes.data.length === 0) {
        return NextResponse.json(
          { error: 'Invalid or expired promotion code' },
          { status: 400 },
        )
      }
      promotionCodeId = codes.data[0].id
    }

    const subscriptionParams: Stripe.SubscriptionCreateParams = {
      customer: customerId,
      items: [{ price: stripePriceId }],
      payment_behavior: 'default_incomplete',
      payment_settings: {
        save_default_payment_method: 'on_subscription',
        payment_method_types: ['card'],
      },
      expand: ['latest_invoice.confirmation_secret'],
      metadata: {
        supabase_user_id: user.id,
        plan_tier: planTier,
        billing_interval: billingInterval,
        first_name: firstName,
        last_name: lastName,
      },
    }

    if (promotionCodeId) {
      subscriptionParams.discounts = [{ promotion_code: promotionCodeId }]
    }

    const subscription = await stripe.subscriptions.create(subscriptionParams)
    const invoice = subscription.latest_invoice as Stripe.Invoice | null
    const clientSecret = invoice?.confirmation_secret?.client_secret ?? null

    return NextResponse.json({
      subscriptionId: subscription.id,
      clientSecret,
    })
  } catch (error: any) {
    console.error('Payment element checkout error:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 },
    )
  }
}

function mapPlanIdToTier(planId: string): string | null {
  const id = planId.toLowerCase()
  if (id === 'premium') return 'Premium'
  if (id === 'premium_processor') return 'Premium Processor'
  if (id === 'elite') return 'Elite'
  if (id === 'elite_processor') return 'Elite Processor'
  if (id === 'vip') return 'VIP'
  if (id === 'vip_processor') return 'VIP Processor'
  return null
}
