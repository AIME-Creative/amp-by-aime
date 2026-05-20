import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-10-29.clover',
})

// GET - List all subscriptions with filters
export async function GET(request: Request) {
  try {
    const supabase = await createClient()

    // Check if user is authenticated and is admin
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', user.id)
      .single()

    if (!profile?.is_admin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    // Get query params for filtering
    const { searchParams } = new URL(request.url)
    const planTier = searchParams.get('planTier')
    const status = searchParams.get('status')
    const search = searchParams.get('search')
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')

    // Fetch all user profiles with their subscription info
    let query = supabase
      .from('profiles')
      .select(`
        id,
        email,
        full_name,
        plan_tier,
        stripe_customer_id,
        stripe_subscription_id,
        subscription_status,
        trial_start_date,
        trial_end_date,
        created_at
      `)
      .neq('is_admin', true) // Exclude admin users
      .order('created_at', { ascending: false })

    // Apply filters
    if (planTier) {
      query = query.eq('plan_tier', planTier)
    }

    if (status) {
      query = query.eq('subscription_status', status)
    }

    if (search) {
      query = query.or(`email.ilike.%${search}%,full_name.ilike.%${search}%`)
    }

    if (startDate) {
      query = query.gte('created_at', startDate)
    }

    if (endDate) {
      query = query.lte('created_at', endDate)
    }

    const { data: subscriptions, error } = await query

    if (error) {
      console.error('Error fetching subscriptions:', error)
      return NextResponse.json({ error: 'Failed to fetch subscriptions' }, { status: 500 })
    }

    // Calculate analytics
    const activeSubscriptions = subscriptions?.filter(
      s => s.subscription_status === 'active' || s.subscription_status === 'trialing'
    ).length || 0

    const totalUsers = subscriptions?.length || 0

    // Calculate plan distribution
    const planDistribution = subscriptions?.reduce((acc: any, sub) => {
      const tier = sub.plan_tier
      if (!acc[tier]) {
        acc[tier] = 0
      }
      acc[tier]++
      return acc
    }, {})

    const planDistributionArray = Object.entries(planDistribution || {}).map(([tier, count]) => ({
      plan_tier: tier,
      count: count as number,
      percentage: totalUsers > 0 ? ((count as number) / totalUsers) * 100 : 0,
    }))

    return NextResponse.json({
      subscriptions,
      analytics: {
        active_subscriptions: activeSubscriptions,
        total_users: totalUsers,
        plan_distribution: planDistributionArray,
      },
    })
  } catch (error: any) {
    console.error('Error in GET /api/admin/subscriptions:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    )
  }
}

// POST - Create a subscription for a user (manually assign plan)
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    // Check if user is authenticated and is admin
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', user.id)
      .single()

    if (!profile?.is_admin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    const body = await request.json()
    const { userId, planId, skipStripe = false } = body

    if (!userId || !planId) {
      return NextResponse.json(
        { error: 'Missing required fields: userId, planId' },
        { status: 400 }
      )
    }

    // Get user profile
    const { data: userProfile, error: userError } = await supabase
      .from('profiles')
      .select('email, stripe_customer_id, plan_tier')
      .eq('id', userId)
      .single()

    if (userError || !userProfile) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Get plan details
    const { data: plan, error: planError } = await supabase
      .from('subscription_plans')
      .select('*')
      .eq('id', planId)
      .single()

    if (planError || !plan) {
      return NextResponse.json({ error: 'Plan not found' }, { status: 404 })
    }

    // If skipStripe is true, just update the profile directly (for manual/free assignments).
    // Write billing_period and payment_amount from the plan row so paid
    // manual assignments don't recreate the null-billing_period hole.
    if (skipStripe || !plan.stripe_price_id) {
      const { error: updateError } = await supabase
        .from('profiles')
        .update({
          plan_tier: plan.plan_tier,
          subscription_status: 'active',
          billing_period: plan.billing_period,
          payment_amount: plan.price,
        })
        .eq('id', userId)

      if (updateError) {
        console.error('Error updating user plan:', updateError)
        return NextResponse.json({ error: 'Failed to update user plan' }, { status: 500 })
      }

      return NextResponse.json({
        message: 'Subscription created successfully (manual assignment)',
        subscription: {
          user_id: userId,
          plan_id: planId,
          status: 'active',
        },
      })
    }

    // Otherwise, create/update Stripe subscription
    let customerId = userProfile.stripe_customer_id

    // Create Stripe customer if they don't have one
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: userProfile.email,
        metadata: {
          supabase_user_id: userId,
        },
      })
      customerId = customer.id

      // Update profile with customer ID
      await supabase
        .from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', userId)
    }

    // Create Stripe subscription
    const subscription: Stripe.Subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: plan.stripe_price_id }],
      metadata: {
        supabase_user_id: userId,
        plan_id: planId,
        admin_created: 'true',
        admin_user_id: user.id,
      },
    })

    // Update user profile with subscription details. Write billing_period
    // and payment_amount from the plan row so admin-created subs land
    // populated without waiting for the Stripe webhook to backfill.
    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        plan_tier: plan.plan_tier,
        stripe_subscription_id: subscription.id,
        subscription_status: subscription.status,
        billing_period: plan.billing_period,
        payment_amount: plan.price,
      })
      .eq('id', userId)

    if (updateError) {
      console.error('Error updating user profile:', updateError)
      // Note: Subscription was created in Stripe, so we should still return success
    }

    return NextResponse.json({
      message: 'Subscription created successfully',
      subscription: {
        id: subscription.id,
        user_id: userId,
        plan_id: planId,
        status: subscription.status,
        current_period_start: new Date((subscription as any).current_period_start * 1000).toISOString(),
        current_period_end: new Date((subscription as any).current_period_end * 1000).toISOString(),
      },
    }, { status: 201 })
  } catch (error: any) {
    console.error('Error in POST /api/admin/subscriptions:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to create subscription' },
      { status: 500 }
    )
  }
}
