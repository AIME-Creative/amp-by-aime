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
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const { planId, billingInterval, returnUrl, embedded } = await request.json()

    if (!planId) {
      return NextResponse.json(
        { error: 'Plan ID is required' },
        { status: 400 }
      )
    }

    // Map frontend planId to database plan_tier
    const planIdLower = planId.toLowerCase()
    let planTier: string
    let isFreeTrial = false

    if (planIdLower === 'free') {
      isFreeTrial = true
      planTier = 'Premium' // Free trial uses Premium tier with trial period
    } else if (planIdLower === 'premium') {
      planTier = 'Premium'
    } else if (planIdLower === 'premium_processor') {
      planTier = 'Premium Processor'
    } else if (planIdLower === 'elite') {
      planTier = 'Elite'
    } else if (planIdLower === 'elite_processor') {
      planTier = 'Elite Processor'
    } else if (planIdLower === 'vip') {
      planTier = 'VIP'
    } else if (planIdLower === 'vip_processor') {
      planTier = 'VIP Processor'
    } else {
      return NextResponse.json(
        { error: `Invalid plan ID: ${planId}` },
        { status: 400 }
      )
    }

    // Determine billing period
    const billingPeriod = isFreeTrial ? 'monthly' : billingInterval
    if (!isFreeTrial && (!billingPeriod || !['monthly', 'annual'].includes(billingPeriod))) {
      return NextResponse.json(
        { error: 'Invalid billing interval' },
        { status: 400 }
      )
    }

    // Fetch the stripe_price_id from database
    const { data: subscriptionPlan, error: planError } = await supabase
      .from('subscription_plans')
      .select('stripe_price_id, name')
      .eq('plan_tier', planTier)
      .eq('billing_period', billingPeriod)
      .eq('is_active', true)
      .single()

    if (planError || !subscriptionPlan?.stripe_price_id) {
      console.error('Plan lookup error:', planError, { planTier, billingPeriod })
      return NextResponse.json(
        { error: 'Plan not found or not configured' },
        { status: 400 }
      )
    }

    // Dev override: when STRIPE_TEST_PRICE_<TIER>_<PERIOD> env vars are
    // set, prefer those over the DB value so dev can run against Stripe
    // test mode without mutating the shared prod subscription_plans
    // rows. Prod env never sets these → falls back to DB unchanged.
    const envKey = `STRIPE_TEST_PRICE_${planTier.toUpperCase()}_${billingPeriod.toUpperCase()}`
    const envOverridePriceId = process.env[envKey]
    const stripePriceId = envOverridePriceId || subscriptionPlan.stripe_price_id
    const planName = subscriptionPlan.name
    if (envOverridePriceId) {
      console.log(`Using ${envKey} override (${envOverridePriceId}) instead of DB price ${subscriptionPlan.stripe_price_id}`)
    }

    // Get or create Stripe customer
    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id, email, first_name, last_name, full_name')
      .eq('id', user.id)
      .single()

    let customerId = profile?.stripe_customer_id

    // Get names from profile (parse full_name if first/last not set)
    let firstName = profile?.first_name || ''
    let lastName = profile?.last_name || ''
    if (!firstName && !lastName && profile?.full_name) {
      const parsed = parseFullName(profile.full_name)
      firstName = parsed.firstName
      lastName = parsed.lastName
    }

    // Build customer name
    const customerName = [firstName, lastName].filter(Boolean).join(' ').trim() || undefined

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email || profile?.email,
        name: customerName,
        metadata: {
          supabase_user_id: user.id,
        },
      })
      customerId = customer.id

      // Save customer ID to profile
      await supabase
        .from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', user.id)
    } else if (customerName) {
      // Update existing customer with name if not already set
      const existingCustomer = await stripe.customers.retrieve(customerId) as Stripe.Customer
      if (!existingCustomer.name) {
        await stripe.customers.update(customerId, { name: customerName })
      }
    }

    // Determine success and cancel URLs based on returnUrl
    // Use NEXT_PUBLIC_APP_URL to avoid localhost origin when behind a proxy
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin

    const successUrl = returnUrl
      ? `${baseUrl}${returnUrl}?success=true&plan=${planName}`
      : `${baseUrl}/dashboard/settings?success=true&plan=${planName}`

    const cancelUrl = returnUrl
      ? `${baseUrl}/onboarding/select-plan?canceled=true`
      : `${baseUrl}/dashboard/select-plan?canceled=true`

    // Create checkout session configuration
    const sessionConfig: any = {
      customer: customerId,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: stripePriceId,
          quantity: 1,
        },
      ],
      allow_promotion_codes: true, // Allow users to enter coupon codes at checkout
      metadata: {
        supabase_user_id: user.id,
        plan_tier: planTier,
        billing_interval: isFreeTrial ? 'trial' : billingInterval,
        first_name: firstName,
        last_name: lastName,
      },
    }

    if (embedded) {
      // Embedded Checkout: stays on our page, post-payment handled in JS via onComplete
      sessionConfig.ui_mode = 'embedded'
      sessionConfig.redirect_on_completion = 'never'
    } else {
      sessionConfig.success_url = successUrl
      sessionConfig.cancel_url = cancelUrl
    }

    // Add trial period for Free Trial
    if (isFreeTrial) {
      sessionConfig.subscription_data = {
        trial_period_days: 90,
      }
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create(sessionConfig)

    return NextResponse.json({
      sessionId: session.id,
      url: session.url,
      clientSecret: session.client_secret,
    })
  } catch (error) {
    console.error('Checkout error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
