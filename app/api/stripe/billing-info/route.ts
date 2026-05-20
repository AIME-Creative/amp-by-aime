import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { stripe } from '@/lib/stripe/config'
import { resolveSubscriptionFields } from '@/lib/stripe/resolve-billing-period'
import Stripe from 'stripe'

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Check for impersonation - if userId provided, verify admin status
    const { searchParams } = new URL(request.url)
    const impersonatedUserId = searchParams.get('userId')
    let targetUserId = user.id

    if (impersonatedUserId) {
      // Verify current user is an admin
      const { data: adminProfile } = await supabase
        .from('profiles')
        .select('is_admin')
        .eq('id', user.id)
        .single()

      if (!adminProfile?.is_admin) {
        return NextResponse.json(
          { error: 'Admin access required for impersonation' },
          { status: 403 }
        )
      }
      targetUserId = impersonatedUserId
    }

    // Get user's profile with Stripe IDs
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('stripe_customer_id, stripe_subscription_id, plan_tier')
      .eq('id', targetUserId)
      .single()

    if (profileError || !profile) {
      return NextResponse.json(
        { error: 'Profile not found' },
        { status: 404 }
      )
    }

    let subscriptionData = null
    let invoices: any[] = []
    let activeSubscription: Stripe.Subscription | null = null

    // STRIPE IS SOURCE OF TRUTH: Fetch current subscription
    // First try by subscription ID if we have one, then fall back to customer ID
    if (profile.stripe_subscription_id) {
      try {
        // Fetch directly by subscription ID - most reliable
        const subscription = await stripe.subscriptions.retrieve(
          profile.stripe_subscription_id,
          { expand: ['items.data.price.product'] }
        )
        if (subscription && ['active', 'trialing', 'past_due'].includes(subscription.status)) {
          activeSubscription = subscription
        }
      } catch (subError: any) {
        console.log(`Could not fetch subscription ${profile.stripe_subscription_id}:`, subError.message)
      }
    }

    // Fall back to listing by customer ID if no subscription found
    if (!activeSubscription && profile.stripe_customer_id) {
      try {
        // Get all active/trialing subscriptions for this customer
        const subscriptions = await stripe.subscriptions.list({
          customer: profile.stripe_customer_id,
          status: 'active',
          limit: 1,
          expand: ['data.items.data.price.product']
        })

        // Also check for trialing subscriptions
        if (subscriptions.data.length === 0) {
          const trialingSubscriptions = await stripe.subscriptions.list({
            customer: profile.stripe_customer_id,
            status: 'trialing',
            limit: 1,
            expand: ['data.items.data.price.product']
          })
          if (trialingSubscriptions.data.length > 0) {
            activeSubscription = trialingSubscriptions.data[0]
          }
        } else {
          activeSubscription = subscriptions.data[0]
        }

        // Self-heal: Full sync if subscription ID is stale or mismatched
        if (activeSubscription && activeSubscription.id !== profile.stripe_subscription_id) {
          console.log(`Self-healing subscription for user ${targetUserId}: ${profile.stripe_subscription_id} -> ${activeSubscription.id}`)

          // Look up the plan tier from the price ID
          const priceId = activeSubscription.items.data[0]?.price?.id
          let newPlanTier = profile.plan_tier
          let newEscalations = null

          if (priceId) {
            const { data: plan } = await supabase
              .from('subscription_plans')
              .select('plan_tier')
              .eq('stripe_price_id', priceId)
              .single()

            if (plan) {
              newPlanTier = plan.plan_tier

              // Get escalations for the tier
              const escalationsMap: Record<string, number> = {
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
              newEscalations = escalationsMap[newPlanTier] ?? 0
              console.log(`Found plan tier ${newPlanTier} for price ${priceId}`)
            }
          }

          // Resolve billing_period (lowercase) + payment_amount via the
          // shared helper. Replaces inline Title-Case mapping.
          const { billingPeriod: newBillingPeriod, paymentAmount: newPaymentAmount } =
            await resolveSubscriptionFields(supabase, activeSubscription)

          const updateData: Record<string, any> = {
            stripe_subscription_id: activeSubscription.id,
            subscription_status: activeSubscription.status,
            stripe_subscription_status: activeSubscription.status,
            billing_period: newBillingPeriod,
            payment_amount: newPaymentAmount,
            updated_at: new Date().toISOString()
          }

          // Only update tier/escalations if we found a matching plan AND tier is different
          if (newPlanTier && newPlanTier !== profile.plan_tier) {
            updateData.plan_tier = newPlanTier
            updateData.escalations_remaining = newEscalations
            updateData.escalations_last_reset_date = new Date().toISOString()
            console.log(`Updating tier from ${profile.plan_tier} to ${newPlanTier}`)
          }

          await supabase
            .from('profiles')
            .update(updateData)
            .eq('id', targetUserId)
        }

      } catch (subError: any) {
        if (subError?.code === 'resource_missing' || subError?.message?.includes('No such customer')) {
          console.log(`Stripe customer ${profile.stripe_customer_id} not found - may be from old system`)
        } else {
          console.error('Error fetching subscriptions by customer:', subError)
        }
      }
    }

    // Build subscription data if we found an active subscription (from either method)
    if (activeSubscription) {
      const price = activeSubscription.items.data[0]?.price
      const amount = price?.unit_amount ? price.unit_amount / 100 : 0
      const interval = price?.recurring?.interval || 'year'
      const sub = activeSubscription as any

      // Get next billing date from upcoming invoice (most accurate)
      let nextBillingDate = 'N/A'
      let currentPeriodEnd: number | null = null

      try {
        // @ts-ignore - Stripe SDK method varies by version
        const upcomingInvoice = await (stripe.invoices as any).upcoming({
          customer: profile.stripe_customer_id!,
          subscription: activeSubscription.id
        })
        if (upcomingInvoice.period_end) {
          currentPeriodEnd = upcomingInvoice.period_end
          nextBillingDate = new Date(upcomingInvoice.period_end * 1000).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
          })
        }
      } catch (invErr) {
        // Fallback: calculate from billing_cycle_anchor + interval
        const anchor = sub.billing_cycle_anchor as number | undefined
        if (anchor) {
          const anchorDate = new Date(anchor * 1000)
          const now = new Date()
          // Find next billing date after now
          while (anchorDate <= now) {
            if (interval === 'month') {
              anchorDate.setMonth(anchorDate.getMonth() + 1)
            } else {
              anchorDate.setFullYear(anchorDate.getFullYear() + 1)
            }
          }
          currentPeriodEnd = Math.floor(anchorDate.getTime() / 1000)
          nextBillingDate = anchorDate.toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
          })
        }
      }

      subscriptionData = {
        status: activeSubscription.status,
        currentPeriodEnd,
        cancelAtPeriodEnd: activeSubscription.cancel_at_period_end,
        price: amount,
        billingInterval: interval,
        nextBillingDate
      }
    }

    // Get invoices (payment history) if they have a customer ID
    if (profile.stripe_customer_id) {
      try {
        const stripeInvoices = await stripe.invoices.list({
          customer: profile.stripe_customer_id,
          limit: 10,
          status: 'paid'
        })

        invoices = stripeInvoices.data.map(invoice => ({
          id: invoice.number || invoice.id,
          description: invoice.lines.data[0]?.description || 'Subscription payment',
          date: new Date((invoice.created || 0) * 1000).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric'
          }),
          amount: invoice.amount_paid ? `$${(invoice.amount_paid / 100).toFixed(2)}` : '$0.00',
          status: invoice.status === 'paid' ? 'Paid' : invoice.status,
          invoiceUrl: invoice.hosted_invoice_url
        }))
      } catch (invError: any) {
        // If customer doesn't exist in Stripe (e.g., migrated from old system), just skip
        if (invError?.code === 'resource_missing' || invError?.message?.includes('No such customer')) {
          console.log(`Stripe customer ${profile.stripe_customer_id} not found for invoices - may be from old system`)
        } else {
          console.error('Error fetching invoices:', invError)
        }
      }
    }

    return NextResponse.json({
      subscription: subscriptionData,
      invoices,
      planTier: profile.plan_tier
    })

  } catch (error) {
    console.error('Error fetching billing info:', error)
    return NextResponse.json(
      { error: 'Failed to fetch billing information' },
      { status: 500 }
    )
  }
}
