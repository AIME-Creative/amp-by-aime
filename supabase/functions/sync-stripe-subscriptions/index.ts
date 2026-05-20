import { createClient } from 'jsr:@supabase/supabase-js@2'
import Stripe from 'npm:stripe@^17.4.0'
import { resolveSubscriptionFields } from '../_shared/billing-period.ts'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2025-10-29.clover',
  httpClient: Stripe.createFetchHttpClient(),
})

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// Escalations by tier
const TIER_ESCALATIONS: Record<string, number> = {
  'Premium': 1,
  'Premium Processor': 1,
  'Premium Guest': 0,
  'Elite': 6,
  'Elite Processor': 3,
  'VIP': 9999,
  'VIP Processor': 6,
  'None': 0,
  'Pending Checkout': 0,
  'Canceled': 0,
  'Free': 0
}

interface SyncResult {
  userId: string
  email: string
  action: 'synced' | 'no_change' | 'error' | 'no_subscription'
  details?: string
}

Deno.serve(async (req) => {
  // No auth check - JWT verification is disabled in function settings
  // This function is called by cron/pg_net

  try {
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Check for specific email parameter (for testing/debugging)
    const url = new URL(req.url)
    const specificEmail = url.searchParams.get('email')

    // Build query
    let query = supabase
      .from('profiles')
      .select('id, email, full_name, stripe_customer_id, stripe_subscription_id, plan_tier, subscription_status, billing_period, payment_amount, subscription_override')
      .not('stripe_customer_id', 'is', null)

    if (specificEmail) {
      // Sync specific user
      query = query.eq('email', specificEmail)
    } else {
      // Batch sync - oldest updated first
      query = query.order('updated_at', { ascending: true }).limit(500)
    }

    const { data: profiles, error: fetchError } = await query

    if (fetchError) {
      throw new Error(`Failed to fetch profiles: ${fetchError.message}`)
    }

    console.log(`Syncing ${profiles?.length || 0} profiles with Stripe`)

    const results: SyncResult[] = []

    for (const profile of profiles || []) {
      try {
        // Fetch active subscription from Stripe by customer ID
        const subscriptions = await stripe.subscriptions.list({
          customer: profile.stripe_customer_id,
          status: 'active',
          limit: 1,
          expand: ['data.items.data.price']
        })

        let activeSubscription = subscriptions.data[0]

        // Also check trialing
        if (!activeSubscription) {
          const trialingSubscriptions = await stripe.subscriptions.list({
            customer: profile.stripe_customer_id,
            status: 'trialing',
            limit: 1,
            expand: ['data.items.data.price']
          })
          activeSubscription = trialingSubscriptions.data[0]
        }

        if (!activeSubscription) {
          // No active subscription in Stripe
          // If user has a paid tier in our DB, they might need to be downgraded
          if (profile.plan_tier && !['None', 'Canceled', 'Pending Checkout', 'Free', 'Premium Guest'].includes(profile.plan_tier)) {
            console.log(`User ${profile.email} has tier ${profile.plan_tier} but no active Stripe subscription`)
            results.push({
              userId: profile.id,
              email: profile.email,
              action: 'no_subscription',
              details: `Has tier ${profile.plan_tier} but no active Stripe subscription - may need review`
            })
          } else {
            results.push({
              userId: profile.id,
              email: profile.email,
              action: 'no_change',
              details: 'No active subscription (expected)'
            })
          }
          continue
        }

        // Look up plan tier from Stripe price - ALWAYS check this
        const priceId = activeSubscription.items.data[0]?.price?.id
        let stripePlanTier: string | null = null

        if (priceId) {
          const { data: plan } = await supabase
            .from('subscription_plans')
            .select('plan_tier')
            .eq('stripe_price_id', priceId)
            .single()

          if (plan) {
            stripePlanTier = plan.plan_tier
          }
        }

        // Resolve billing_period (lowercase) + payment_amount via the
        // shared helper. The helper falls back to price.recurring.interval
        // when subscription_plans has no row for this price — the old
        // inline code silently produced null in that case, which made the
        // billingMismatch check skip the write (this was the bug behind
        // the 351 null-billing_period users).
        const { billingPeriod: stripeBillingPeriod, paymentAmount: stripePaymentAmount } =
          await resolveSubscriptionFields(stripe, supabase, activeSubscription)

        // Guard: skip if this subscription ID already belongs to a different profile
        if (activeSubscription.id !== profile.stripe_subscription_id) {
          const { data: existingOwner } = await supabase
            .from('profiles')
            .select('id, email')
            .eq('stripe_subscription_id', activeSubscription.id)
            .neq('id', profile.id)
            .limit(1)
            .single()

          if (existingOwner) {
            console.warn(`DUPLICATE PREVENTED: subscription ${activeSubscription.id} already belongs to ${existingOwner.email} (${existingOwner.id}), skipping ${profile.email} (${profile.id})`)
            results.push({
              userId: profile.id,
              email: profile.email,
              action: 'error',
              details: `Subscription ${activeSubscription.id} already assigned to ${existingOwner.email} - skipped to prevent duplicate`
            })
            continue
          }
        }

        // Check if ANY field needs sync: subscription ID, tier, billing period, payment amount, or override needs clearing
        const subscriptionIdMismatch = activeSubscription.id !== profile.stripe_subscription_id
        const tierMismatch = stripePlanTier && stripePlanTier !== profile.plan_tier
        const billingMismatch = stripeBillingPeriod && stripeBillingPeriod !== profile.billing_period
        const paymentAmountMismatch = stripePaymentAmount !== null && stripePaymentAmount !== profile.payment_amount
        const hasOverrideWithActiveSubscription = profile.subscription_override === true

        if (!subscriptionIdMismatch && !tierMismatch && !billingMismatch && !paymentAmountMismatch && !hasOverrideWithActiveSubscription) {
          results.push({
            userId: profile.id,
            email: profile.email,
            action: 'no_change',
            details: 'All fields match'
          })
          continue
        }

        // Build update
        const updateData: Record<string, any> = {
          stripe_subscription_id: activeSubscription.id,
          subscription_status: activeSubscription.status,
          stripe_subscription_status: activeSubscription.status,
          updated_at: new Date().toISOString()
        }

        const changes: string[] = []

        if (subscriptionIdMismatch) {
          changes.push(`subscription_id: ${profile.stripe_subscription_id} -> ${activeSubscription.id}`)
        }

        if (tierMismatch && stripePlanTier) {
          updateData.plan_tier = stripePlanTier
          updateData.escalations_remaining = TIER_ESCALATIONS[stripePlanTier] ?? 0
          updateData.escalations_last_reset_date = new Date().toISOString()
          changes.push(`plan_tier: ${profile.plan_tier} -> ${stripePlanTier}`)
        }

        if (billingMismatch && stripeBillingPeriod) {
          updateData.billing_period = stripeBillingPeriod
          changes.push(`billing_period: ${profile.billing_period} -> ${stripeBillingPeriod}`)
        }

        if (paymentAmountMismatch && stripePaymentAmount !== null) {
          updateData.payment_amount = stripePaymentAmount
          changes.push(`payment_amount: ${profile.payment_amount} -> ${stripePaymentAmount}`)
        }

        // Clear override if user now has active Stripe subscription
        if (hasOverrideWithActiveSubscription) {
          updateData.subscription_override = false
          updateData.subscription_override_reason = null
          updateData.subscription_override_expires_at = null
          changes.push('cleared subscription_override (user has active Stripe subscription)')
        }

        // Get billing period dates from upcoming invoice
        try {
          const upcomingInvoice = await stripe.invoices.upcoming({
            customer: profile.stripe_customer_id,
            subscription: activeSubscription.id
          })
          if (upcomingInvoice.period_start) {
            updateData.current_period_start = new Date(upcomingInvoice.period_start * 1000).toISOString()
          }
          if (upcomingInvoice.period_end) {
            updateData.current_period_end = new Date(upcomingInvoice.period_end * 1000).toISOString()
            changes.push(`current_period_end: ${upcomingInvoice.period_end}`)
          }
        } catch (invErr) {
          // Fallback: use billing_cycle_anchor
          const sub = activeSubscription as any
          if (sub.billing_cycle_anchor) {
            const anchor = new Date(sub.billing_cycle_anchor * 1000)
            const interval = activeSubscription.items.data[0]?.price?.recurring?.interval
            const now = new Date()
            while (anchor <= now) {
              if (interval === 'month') {
                anchor.setMonth(anchor.getMonth() + 1)
              } else {
                anchor.setFullYear(anchor.getFullYear() + 1)
              }
            }
            updateData.current_period_end = anchor.toISOString()
            changes.push(`current_period_end (calculated): ${anchor.toISOString()}`)
          }
        }

        // Update the profile
        const { error: updateError } = await supabase
          .from('profiles')
          .update(updateData)
          .eq('id', profile.id)

        if (updateError) {
          throw new Error(`Failed to update: ${updateError.message}`)
        }

        console.log(`Synced user ${profile.email}: ${changes.join(', ')}`)

        results.push({
          userId: profile.id,
          email: profile.email,
          action: 'synced',
          details: changes.join(', ')
        })

      } catch (userError) {
        console.error(`Error syncing user ${profile.email}:`, userError)
        results.push({
          userId: profile.id,
          email: profile.email,
          action: 'error',
          details: userError instanceof Error ? userError.message : 'Unknown error'
        })
      }
    }

    // Summary
    const synced = results.filter(r => r.action === 'synced').length
    const noChange = results.filter(r => r.action === 'no_change').length
    const errors = results.filter(r => r.action === 'error').length
    const noSubscription = results.filter(r => r.action === 'no_subscription').length

    console.log(`Sync complete: ${synced} synced, ${noChange} no change, ${errors} errors, ${noSubscription} need review`)

    return new Response(
      JSON.stringify({
        success: true,
        summary: {
          total: results.length,
          synced,
          noChange,
          errors,
          noSubscription
        },
        results: results.filter(r => r.action !== 'no_change') // Only return interesting results
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Sync error:', error)
    return new Response(
      JSON.stringify({ error: 'Sync failed', details: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
})
