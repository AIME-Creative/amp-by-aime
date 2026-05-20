import { createClient } from 'jsr:@supabase/supabase-js@2'
import Stripe from 'npm:stripe@^17.4.0'
import { resolveSubscriptionFields } from '../_shared/billing-period.ts'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2025-10-29.clover',
  httpClient: Stripe.createFetchHttpClient(),
})

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// Get base escalations for a plan tier
function getBasePlanEscalations(planTier: string): number {
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
  return escalationsMap[planTier] || 0
}

Deno.serve(async (req) => {
  const signature = req.headers.get('stripe-signature')

  if (!signature) {
    return new Response(
      JSON.stringify({ error: 'Missing stripe-signature header' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )
  }

  try {
    const body = await req.text()
    const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? ''

    // Verify webhook signature
    let event: Stripe.Event
    try {
      event = await stripe.webhooks.constructEventAsync(
        body,
        signature,
        webhookSecret
      )
    } catch (err) {
      console.error('Webhook signature verification failed:', err)
      return new Response(
        JSON.stringify({ error: 'Invalid signature' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      )
    }

    // Create Supabase client with service role
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // Handle the event
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        const userId = session.metadata?.supabase_user_id
        const planTier = session.metadata?.plan_tier

        console.log('Checkout completed:', { userId, planTier })

        if (userId && planTier) {
          // Get escalations for the new plan tier
          const newEscalations = getBasePlanEscalations(planTier)

          // Resolve billing_period (lowercase) + payment_amount via the
          // shared helper. Helper handles missing-subscription_plans-row
          // fallback to price.recurring.interval, which the old inline
          // code already did but using Title-Case writes.
          const { billingPeriod, paymentAmount } = session.subscription
            ? await resolveSubscriptionFields(stripe, supabase, session.subscription as string)
            : { billingPeriod: null, paymentAmount: null }
          console.log(`Subscription billing period: ${billingPeriod}, payment amount: ${paymentAmount}`)

          // Guard: check if this subscription ID already belongs to a different profile
          if (session.subscription) {
            const { data: existingOwner } = await supabase
              .from('profiles')
              .select('id, email')
              .eq('stripe_subscription_id', session.subscription as string)
              .neq('id', userId)
              .limit(1)
              .single()

            if (existingOwner) {
              console.warn(`DUPLICATE PREVENTED (checkout): subscription ${session.subscription} already belongs to ${existingOwner.email} (${existingOwner.id}), skipping update for user ${userId}`)
              break
            }
          }

          // Checkout completed = they paid, so update everything and CLEAR any override
          // (override was a workaround, now they have a real subscription)
          const { error } = await supabase
            .from('profiles')
            .update({
              plan_tier: planTier,
              stripe_customer_id: session.customer as string,
              stripe_subscription_id: session.subscription as string,
              subscription_status: 'active',
              stripe_subscription_status: 'active',
              billing_period: billingPeriod,
              payment_amount: paymentAmount,
              escalations_remaining: newEscalations,
              escalations_last_reset_date: new Date().toISOString(),
              payment_failed_at: null,
              // Clear override since they now have a real paid subscription
              subscription_override: false,
              override_plan_tier: null,
              override_subscription_status: null,
              override_reason: null,
              override_set_by: null,
              override_set_at: null,
              override_expires_at: null,
              updated_at: new Date().toISOString(),
            })
            .eq('id', userId)

          if (error) {
            console.error('Error updating profile:', error)
          } else {
            console.log(`Updated plan for user ${userId} to ${planTier} (${billingPeriod}) with ${newEscalations} escalations (override cleared)`)
          }
        }
        break
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription
        const customerId = subscription.customer as string
        const priceId = subscription.items.data[0]?.price?.id
        const subscriptionStatus = subscription.status

        console.log('Subscription updated:', { customerId, status: subscriptionStatus, priceId })

        // Resolve billing_period (lowercase) + payment_amount via the
        // shared helper.
        const { billingPeriod, paymentAmount } = await resolveSubscriptionFields(
          stripe,
          supabase,
          subscription,
        )
        console.log(`Subscription details: billing_period=${billingPeriod}, payment_amount=${paymentAmount}`)

        // CRITICAL: Only these statuses should grant access to paid tiers
        const paidAccessStatuses = ['active', 'trialing']
        const hasPaidAccess = paidAccessStatuses.includes(subscriptionStatus)

        // Get user by stripe customer ID
        const { data: profile, error: fetchError } = await supabase
          .from('profiles')
          .select('id, plan_tier, subscription_override')
          .eq('stripe_customer_id', customerId)
          .single()

        if (fetchError) {
          console.error('Error fetching profile:', fetchError)
        } else if (profile) {
          // CRITICAL: If user has an override, don't change their tier - admin controls it
          if (profile.subscription_override) {
            console.log(`User ${profile.id} has subscription_override enabled - skipping tier changes, only syncing stripe_subscription_id`)
            // Guard: check for duplicate before writing subscription ID
            if (subscription.id) {
              const { data: dupOwner } = await supabase
                .from('profiles')
                .select('id, email')
                .eq('stripe_subscription_id', subscription.id)
                .neq('id', profile.id)
                .limit(1)
                .single()
              if (dupOwner) {
                console.warn(`DUPLICATE PREVENTED (override path): subscription ${subscription.id} already belongs to ${dupOwner.email}, skipping ${profile.id}`)
                break
              }
            }
            // Only update the subscription ID reference, not tier or status
            await supabase
              .from('profiles')
              .update({
                stripe_subscription_id: subscription.id,
                updated_at: new Date().toISOString(),
              })
              .eq('id', profile.id)
            break
          }

          // Look up plan tier from price ID (only used if subscription is in good standing)
          let newPlanTier = profile.plan_tier
          if (priceId && hasPaidAccess) {
            const { data: plan } = await supabase
              .from('subscription_plans')
              .select('plan_tier')
              .eq('stripe_price_id', priceId)
              .single()

            if (plan) {
              newPlanTier = plan.plan_tier
              console.log(`Found plan tier ${plan.plan_tier} for price ${priceId}`)
            }
          }

          // Guard: check for duplicate before writing subscription ID
          if (subscription.id) {
            const { data: dupOwner } = await supabase
              .from('profiles')
              .select('id, email')
              .eq('stripe_subscription_id', subscription.id)
              .neq('id', profile.id)
              .limit(1)
              .single()
            if (dupOwner) {
              console.warn(`DUPLICATE PREVENTED (sub.updated): subscription ${subscription.id} already belongs to ${dupOwner.email}, skipping ${profile.id}`)
              break
            }
          }

          // Build update data - always sync the subscription status, billing period, and payment amount
          const updateData: Record<string, any> = {
            subscription_status: subscriptionStatus,
            stripe_subscription_status: subscriptionStatus,
            stripe_subscription_id: subscription.id,
            updated_at: new Date().toISOString(),
          }

          // Always sync billing period and payment amount when available
          if (billingPeriod) {
            updateData.billing_period = billingPeriod
          }
          if (paymentAmount !== null) {
            updateData.payment_amount = paymentAmount
          }

          // If subscription is now active/trialing, clear any payment failure tracking
          if (hasPaidAccess) {
            updateData.payment_failed_at = null
          }

          // Handle non-paying statuses - user should NOT have paid tier access
          if (!hasPaidAccess) {
            console.log(`Subscription status '${subscriptionStatus}' does not grant paid access - not updating tier`)

            // For past_due, set payment_failed_at if not already set
            if (subscriptionStatus === 'past_due') {
              const { data: currentProfile } = await supabase
                .from('profiles')
                .select('payment_failed_at')
                .eq('id', profile.id)
                .single()

              if (!currentProfile?.payment_failed_at) {
                updateData.payment_failed_at = new Date().toISOString()
              }
            }

            // For canceled/unpaid/incomplete/incomplete_expired/paused - set to Canceled tier
            // These statuses mean user does NOT have valid paid access
            if (['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'].includes(subscriptionStatus)) {
              if (profile.plan_tier !== 'Canceled' && profile.plan_tier !== 'None') {
                updateData.plan_tier = 'Canceled'
                updateData.escalations_remaining = 0
                console.log(`Setting user to Canceled due to subscription status: ${subscriptionStatus}`)
              }
            }
          }

          // Handle cancel_at_period_end - when subscription is scheduled to cancel
          if (subscription.cancel_at_period_end) {
            const cancelDate = new Date((subscription as any).current_period_end * 1000)
            const pendingDowngradeTier = subscription.metadata?.pending_downgrade_tier

            if (!pendingDowngradeTier) {
              updateData.pending_plan_tier = 'Canceled'
              updateData.pending_plan_effective_date = cancelDate.toISOString()
              updateData.pending_plan_price_id = null
              console.log(`Subscription scheduled for cancellation: ${customerId}, effective ${cancelDate.toISOString()}`)
            }
          } else {
            // Check if cancellation was undone (reactivated)
            const { data: currentProfile } = await supabase
              .from('profiles')
              .select('pending_plan_tier')
              .eq('stripe_customer_id', customerId)
              .single()

            if (currentProfile?.pending_plan_tier === 'Canceled') {
              updateData.pending_plan_tier = null
              updateData.pending_plan_effective_date = null
              updateData.pending_plan_price_id = null
              console.log(`Subscription cancellation undone: ${customerId}`)
            }
          }

          // ONLY update plan tier if subscription is active/trialing AND tier actually changed
          if (hasPaidAccess && newPlanTier !== profile.plan_tier) {
            updateData.plan_tier = newPlanTier
            updateData.escalations_remaining = getBasePlanEscalations(newPlanTier)
            updateData.escalations_last_reset_date = new Date().toISOString()
            console.log(`Plan tier changing from ${profile.plan_tier} to ${newPlanTier} (status: ${subscriptionStatus})`)

            // Determine if upgrade or downgrade (order from lowest to highest access)
            const tierOrder = ['None', 'Canceled', 'Pending Checkout', 'Free', 'Premium Guest', 'Premium', 'Premium Processor', 'Elite', 'Elite Processor', 'VIP', 'VIP Processor']
            const oldIndex = tierOrder.indexOf(profile.plan_tier)
            const newIndex = tierOrder.indexOf(newPlanTier)
            const conversionType = newIndex > oldIndex ? 'upgrade' : 'downgrade'

            // Track the conversion
            try {
              await supabase.rpc('track_subscription_conversion', {
                p_user_id: profile.id,
                p_from_tier: profile.plan_tier,
                p_to_tier: newPlanTier,
                p_conversion_type: conversionType
              })
            } catch (trackError) {
              console.error('Error tracking conversion:', trackError)
            }

            // Get user email for notification
            const { data: userProfile } = await supabase
              .from('profiles')
              .select('email, full_name')
              .eq('id', profile.id)
              .single()

            // Send notification email
            if (userProfile?.email) {
              try {
                const notifyUrl = `${supabaseUrl}/functions/v1/send-subscription-notification`
                await fetch(notifyUrl, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${supabaseServiceKey}`,
                  },
                  body: JSON.stringify({
                    type: conversionType,
                    userEmail: userProfile.email,
                    userName: userProfile.full_name,
                    fromTier: profile.plan_tier,
                    toTier: newPlanTier,
                  }),
                })
              } catch (emailError) {
                console.error('Error sending notification email:', emailError)
              }
            }
          }

          const { error } = await supabase
            .from('profiles')
            .update(updateData)
            .eq('id', profile.id)

          if (error) {
            console.error('Error updating subscription status:', error)
          } else {
            console.log(`Updated subscription for user ${profile.id}`)
          }
        }
        break
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription
        const customerId = subscription.customer as string

        console.log('Subscription deleted:', { customerId, deletedSubscriptionId: subscription.id })

        // Get user by stripe customer ID
        const { data: profile, error: fetchError } = await supabase
          .from('profiles')
          .select('id, email, full_name, plan_tier, stripe_subscription_id, subscription_override')
          .eq('stripe_customer_id', customerId)
          .single()

        if (fetchError) {
          console.error('Error fetching profile:', fetchError)
        } else if (profile) {
          // CRITICAL: If user has an override, don't change their tier - admin controls it
          if (profile.subscription_override) {
            console.log(`User ${profile.id} has subscription_override enabled - skipping cancellation tier changes`)
            break
          }

          // Check if customer has another active subscription
          // This handles cases where user cancels and creates a new subscription
          const otherSubscriptions = await stripe.subscriptions.list({
            customer: customerId,
            status: 'active',
            limit: 1,
          })

          // Also check for trialing subscriptions
          const trialingSubscriptions = await stripe.subscriptions.list({
            customer: customerId,
            status: 'trialing',
            limit: 1,
          })

          const activeSubscription = otherSubscriptions.data[0] || trialingSubscriptions.data[0]

          if (activeSubscription) {
            // User has another active subscription - update to that one instead of canceling
            console.log(`User has another active subscription: ${activeSubscription.id}`)

            // Guard: check for duplicate before writing subscription ID
            const { data: dupOwner } = await supabase
              .from('profiles')
              .select('id, email')
              .eq('stripe_subscription_id', activeSubscription.id)
              .neq('id', profile.id)
              .limit(1)
              .single()
            if (dupOwner) {
              console.warn(`DUPLICATE PREVENTED (sub.deleted): subscription ${activeSubscription.id} already belongs to ${dupOwner.email}, skipping ${profile.id}`)
              break
            }

            const priceId = activeSubscription.items.data[0]?.price?.id
            let newPlanTier = profile.plan_tier

            if (priceId) {
              const { data: plan } = await supabase
                .from('subscription_plans')
                .select('plan_tier')
                .eq('stripe_price_id', priceId)
                .single()

              if (plan) {
                newPlanTier = plan.plan_tier
              }
            }

            const newEscalations = getBasePlanEscalations(newPlanTier)
            const { billingPeriod, paymentAmount } = await resolveSubscriptionFields(
              stripe,
              supabase,
              activeSubscription,
            )

            const { error } = await supabase
              .from('profiles')
              .update({
                plan_tier: newPlanTier,
                stripe_subscription_id: activeSubscription.id,
                subscription_status: activeSubscription.status,
                stripe_subscription_status: activeSubscription.status,
                billing_period: billingPeriod,
                payment_amount: paymentAmount,
                escalations_remaining: newEscalations,
                escalations_last_reset_date: new Date().toISOString(),
                // Clear any pending cancellation since they have a new active subscription
                pending_plan_tier: null,
                pending_plan_effective_date: null,
                pending_plan_price_id: null,
                payment_failed_at: null,
                updated_at: new Date().toISOString(),
              })
              .eq('id', profile.id)

            if (error) {
              console.error('Error updating to new subscription:', error)
            } else {
              console.log(`Updated user ${profile.id} to new subscription ${activeSubscription.id} with tier ${newPlanTier}`)
            }
          } else {
            // No other active subscription - proceed with cancellation
            const previousTier = profile.plan_tier

            // Set to Canceled and reset escalations
            const { error } = await supabase
              .from('profiles')
              .update({
                plan_tier: 'Canceled',
                stripe_subscription_id: null,
                subscription_status: 'canceled',
                stripe_subscription_status: 'canceled',
                billing_period: null,
                payment_amount: null,
                escalations_remaining: 0,
                updated_at: new Date().toISOString(),
              })
              .eq('id', profile.id)

            if (error) {
              console.error('Error updating to Canceled:', error)
            } else {
              console.log(`Updated user ${profile.id} to Canceled`)

              // Track the cancellation
              try {
                await supabase.rpc('track_subscription_conversion', {
                  p_user_id: profile.id,
                  p_from_tier: previousTier,
                  p_to_tier: 'Canceled',
                  p_conversion_type: 'cancellation'
                })
              } catch (trackError) {
                console.error('Error tracking cancellation:', trackError)
              }

              // Send cancellation notification
              if (profile.email) {
                try {
                  const notifyUrl = `${supabaseUrl}/functions/v1/send-subscription-notification`
                  await fetch(notifyUrl, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${supabaseServiceKey}`,
                    },
                    body: JSON.stringify({
                      type: 'cancellation',
                      userEmail: profile.email,
                      userName: profile.full_name,
                      fromTier: previousTier,
                      toTier: 'Canceled',
                    }),
                  })
                } catch (emailError) {
                  console.error('Error sending cancellation notification:', emailError)
                }
              }
            }
          }
        }
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        const customerId = invoice.customer as string
        const subscriptionId = (invoice as any).subscription as string

        if (!subscriptionId) break // Not a subscription invoice

        console.log('Payment failed:', { customerId, subscriptionId })

        // Get user by stripe customer ID
        const { data: profile, error: fetchError } = await supabase
          .from('profiles')
          .select('id, payment_failed_at, subscription_override')
          .eq('stripe_customer_id', customerId)
          .single()

        if (fetchError) {
          console.error('Error fetching profile:', fetchError)
        } else if (profile) {
          // CRITICAL: If user has an override, don't change their status - admin controls it
          if (profile.subscription_override) {
            console.log(`User ${profile.id} has subscription_override enabled - skipping payment failure status change`)
            break
          }

          // Only set payment_failed_at if not already set (first failure)
          const updateData: Record<string, any> = {
            subscription_status: 'past_due',
            stripe_subscription_status: 'past_due',
            updated_at: new Date().toISOString(),
          }

          if (!profile.payment_failed_at) {
            updateData.payment_failed_at = new Date().toISOString()
          }

          const { error } = await supabase
            .from('profiles')
            .update(updateData)
            .eq('id', profile.id)

          if (error) {
            console.error('Error updating payment failure:', error)
          } else {
            console.log(`Marked payment failed for user ${profile.id}`)
          }
        }
        break
      }

      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice
        const customerId = invoice.customer as string
        const subscriptionId = (invoice as any).subscription as string

        if (!subscriptionId) break // Not a subscription invoice

        console.log('Payment succeeded:', { customerId, subscriptionId })

        // Get user by stripe customer ID
        const { data: profile, error: fetchError } = await supabase
          .from('profiles')
          .select('id, subscription_override')
          .eq('stripe_customer_id', customerId)
          .single()

        if (fetchError) {
          console.error('Error fetching profile:', fetchError)
        } else if (profile) {
          // CRITICAL: If user has an override, don't change their status - admin controls it
          if (profile.subscription_override) {
            console.log(`User ${profile.id} has subscription_override enabled - skipping payment success status change`)
            break
          }

          // Clear payment_failed_at and restore active status
          const { error } = await supabase
            .from('profiles')
            .update({
              subscription_status: 'active',
              stripe_subscription_status: 'active',
              payment_failed_at: null,
              updated_at: new Date().toISOString(),
            })
            .eq('id', profile.id)

          if (error) {
            console.error('Error clearing payment failure:', error)
          } else {
            console.log(`Payment recovered for user ${profile.id}`)
          }
        }
        break
      }

      case 'invoice.payment_action_required': {
        const invoice = event.data.object as Stripe.Invoice
        const customerId = invoice.customer as string

        console.log('Payment action required:', { customerId })

        // Get user by stripe customer ID
        const { data: profile, error: fetchError } = await supabase
          .from('profiles')
          .select('id, payment_failed_at, subscription_override')
          .eq('stripe_customer_id', customerId)
          .single()

        if (fetchError) {
          console.error('Error fetching profile:', fetchError)
        } else if (profile) {
          // CRITICAL: If user has an override, don't change their status - admin controls it
          if (profile.subscription_override) {
            console.log(`User ${profile.id} has subscription_override enabled - skipping payment action required status change`)
            break
          }

          // Treat similar to payment failed
          const updateData: Record<string, any> = {
            subscription_status: 'past_due',
            stripe_subscription_status: 'past_due',
            updated_at: new Date().toISOString(),
          }

          if (!profile.payment_failed_at) {
            updateData.payment_failed_at = new Date().toISOString()
          }

          const { error } = await supabase
            .from('profiles')
            .update(updateData)
            .eq('id', profile.id)

          if (error) {
            console.error('Error updating payment action required:', error)
          }
        }
        break
      }

      default:
        console.log(`Unhandled event type: ${event.type}`)
    }

    return new Response(
      JSON.stringify({ received: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('Webhook error:', error)
    return new Response(
      JSON.stringify({ error: 'Webhook handler failed' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
})
