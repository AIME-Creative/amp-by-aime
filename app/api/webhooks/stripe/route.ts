import { NextRequest, NextResponse } from 'next/server'
import { stripe } from '@/lib/stripe/config'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { getBasePlanEscalations } from '@/lib/escalations'
import { parseFullName, combineNames } from '@/lib/utils/name-parser'

// Lazy initialization to avoid build-time errors
function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// Helper function to get cardholder name from Stripe payment method
async function getCardholderName(session: Stripe.Checkout.Session): Promise<string | null> {
  try {
    // Try to get from payment intent's payment method
    if (session.payment_intent) {
      const paymentIntent = await stripe.paymentIntents.retrieve(
        session.payment_intent as string,
        { expand: ['payment_method'] }
      )
      const paymentMethod = paymentIntent.payment_method as Stripe.PaymentMethod
      if (paymentMethod?.billing_details?.name) {
        return paymentMethod.billing_details.name
      }
    }

    // Try to get from subscription's default payment method
    if (session.subscription) {
      const subscription = await stripe.subscriptions.retrieve(
        session.subscription as string,
        { expand: ['default_payment_method'] }
      )
      const pm = subscription.default_payment_method as Stripe.PaymentMethod
      if (pm?.billing_details?.name) {
        return pm.billing_details.name
      }
    }

    // Try to get from customer's default payment method
    if (session.customer) {
      const customer = await stripe.customers.retrieve(session.customer as string) as Stripe.Customer
      if (customer.invoice_settings?.default_payment_method) {
        const pm = await stripe.paymentMethods.retrieve(
          customer.invoice_settings.default_payment_method as string
        )
        if (pm?.billing_details?.name) {
          return pm.billing_details.name
        }
      }
    }

    return null
  } catch (error) {
    console.error('Error fetching cardholder name:', error)
    return null
  }
}

export async function POST(request: NextRequest) {
  const supabaseAdmin = getSupabaseAdmin()
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!
  try {
    const body = await request.text()
    const signature = request.headers.get('stripe-signature')

    if (!signature) {
      return NextResponse.json(
        { error: 'Missing stripe-signature header' },
        { status: 400 }
      )
    }

    let event: Stripe.Event

    try {
      event = stripe.webhooks.constructEvent(body, signature, webhookSecret)
    } catch (err) {
      console.error('Webhook signature verification failed:', err)
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 400 }
      )
    }

    // Handle the event
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session

        // Fuse one-time-payment sessions (public checkout, admin
        // checkout, member invoice). These don't carry plan_tier and
        // shouldn't run through the subscription path below. Flip the
        // referenced registration to purchased + finalized.
        const fuseSessionTypes = new Set([
          'fuse_registration',
          'fuse_admin_checkout',
          'fuse_member_invoice',
        ])
        if (session.metadata?.type && fuseSessionTypes.has(session.metadata.type)) {
          const registrationId = session.metadata?.registration_id
          if (registrationId && session.payment_status === 'paid') {
            const { data: reg } = await supabaseAdmin
              .from('fuse_registrations')
              .select('id, purchase_type, step_completed')
              .eq('id', registrationId)
              .single()
            if (reg) {
              const fuseUpdate: Record<string, unknown> = {
                step_completed: 'finalized',
                updated_at: new Date().toISOString(),
              }
              if (reg.purchase_type === 'pending') {
                fuseUpdate.purchase_type = 'purchased'
              }
              const { error: fuseErr } = await supabaseAdmin
                .from('fuse_registrations')
                .update(fuseUpdate)
                .eq('id', registrationId)
              if (fuseErr) {
                console.error(
                  `[fuse reconciler] checkout.session.completed update failed for ${registrationId}:`,
                  fuseErr,
                )
              } else {
                console.log(
                  `[fuse reconciler] checkout.session.completed reconciled ${registrationId} (type=${session.metadata.type}):`,
                  fuseUpdate,
                )
              }
            } else {
              console.warn(
                `[fuse reconciler] checkout.session.completed references registration ${registrationId} but row not found`,
              )
            }
          }
          break
        }

        let userId = session.metadata?.supabase_user_id
        const planTier = session.metadata?.plan_tier
        const isAdminCreated = session.metadata?.admin_created === 'true'
        const userEmail = session.metadata?.user_email || session.customer_email
        const customerId = session.customer as string

        // Extract names from metadata (priority 1)
        let firstName = session.metadata?.first_name || ''
        let lastName = session.metadata?.last_name || ''

        // If names not in metadata, try to get from cardholder name (priority 2)
        if (!firstName && !lastName) {
          const cardholderName = await getCardholderName(session)
          if (cardholderName) {
            const parsed = parseFullName(cardholderName)
            firstName = parsed.firstName
            lastName = parsed.lastName
            console.log('Extracted name from cardholder:', { firstName, lastName })
          }
        }

        // Fallback to Stripe customer name (priority 3)
        if (!firstName && !lastName && customerId) {
          try {
            const stripeCustomer = await stripe.customers.retrieve(customerId) as Stripe.Customer
            if (stripeCustomer.name) {
              const parsed = parseFullName(stripeCustomer.name)
              firstName = parsed.firstName
              lastName = parsed.lastName
              console.log('Extracted name from Stripe customer:', { firstName, lastName })
            }
          } catch (err) {
            console.error('Error fetching Stripe customer for name:', err)
          }
        }

        // Handle admin-created checkout links where user doesn't exist yet
        if (!userId && isAdminCreated && userEmail && customerId) {
          console.log('Admin checkout completed for new user:', userEmail)

          // Check if user already exists by email
          const { data: existingProfile } = await supabaseAdmin
            .from('profiles')
            .select('id, first_name, last_name')
            .eq('email', userEmail.toLowerCase())
            .single()

          if (existingProfile) {
            // User exists, just update their profile
            userId = existingProfile.id
            // Use existing names if we don't have new ones
            if (!firstName) firstName = existingProfile.first_name || ''
            if (!lastName) lastName = existingProfile.last_name || ''
            console.log('Found existing user:', userId)
          } else {
            // Create new user account
            console.log('Creating new user account for:', userEmail)

            // Use the names we've extracted, or fallback to email prefix
            const customerName = combineNames(firstName, lastName) || userEmail.split('@')[0]
            if (!firstName && !lastName) {
              const parsed = parseFullName(customerName)
              firstName = parsed.firstName
              lastName = parsed.lastName
            }

            // Generate a random password (user will need to reset)
            const tempPassword = crypto.randomUUID() + 'Aa1!'

            // Create auth user
            const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
              email: userEmail.toLowerCase(),
              password: tempPassword,
              email_confirm: true,
              user_metadata: {
                full_name: customerName,
                first_name: firstName,
                last_name: lastName,
              },
            })

            if (createError) {
              console.error('Error creating user:', createError)
              // Try to continue anyway - maybe profile was created by trigger
            } else if (newUser?.user) {
              userId = newUser.user.id
              console.log('Created new user:', userId)

              // Update Stripe customer with Supabase user ID
              await stripe.customers.update(customerId, {
                metadata: { supabase_user_id: userId },
              })
            }

            // If still no userId, try to get it from profile (trigger may have created it)
            if (!userId) {
              const { data: newProfile } = await supabaseAdmin
                .from('profiles')
                .select('id')
                .eq('email', userEmail.toLowerCase())
                .single()
              userId = newProfile?.id
            }
          }

          // Update pending_checkouts status
          if (session.id) {
            await supabaseAdmin
              .from('pending_checkouts')
              .update({
                status: 'completed',
                completed_at: new Date().toISOString(),
                user_id: userId,
              })
              .eq('stripe_checkout_session_id', session.id)
          }
        }

        // Also handle case where user exists but wasn't linked via metadata
        if (!userId && customerId) {
          // Try to find user by stripe_customer_id
          const { data: profileByCustomer } = await supabaseAdmin
            .from('profiles')
            .select('id')
            .eq('stripe_customer_id', customerId)
            .single()

          if (profileByCustomer) {
            userId = profileByCustomer.id
            console.log('Found user by stripe_customer_id:', userId)
          }
        }

        // Update profile names if we have them and current names are empty
        // (Don't overwrite user-provided names with cardholder data)
        if (userId && (firstName || lastName)) {
          const { data: existingProfile } = await supabaseAdmin
            .from('profiles')
            .select('first_name, last_name')
            .eq('id', userId)
            .single()

          if (!existingProfile?.first_name && !existingProfile?.last_name) {
            // Safe to update - names are empty
            const fullName = combineNames(firstName, lastName)
            await supabaseAdmin
              .from('profiles')
              .update({
                first_name: firstName || null,
                last_name: lastName || null,
                full_name: fullName || null,
                updated_at: new Date().toISOString(),
              })
              .eq('id', userId)
            console.log('Updated profile with names:', { userId, firstName, lastName })
          }
        }

        if (userId && planTier) {
          // Get user's current tier before update
          const { data: currentProfile } = await supabaseAdmin
            .from('profiles')
            .select('plan_tier')
            .eq('id', userId)
            .single()

          // Guard: check if this subscription ID already belongs to a different profile
          if (session.subscription) {
            const { data: existingOwner } = await supabaseAdmin
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

          // Get escalations for the new plan tier
          const newEscalations = getBasePlanEscalations(planTier)

          // Update user's plan in database with escalations
          await supabaseAdmin
            .from('profiles')
            .update({
              plan_tier: planTier,
              stripe_customer_id: customerId,
              stripe_subscription_id: session.subscription as string,
              subscription_status: 'active',
              stripe_subscription_status: 'active',
              escalations_remaining: newEscalations,
              escalations_last_reset_date: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', userId)

          // Track conversion in analytics
          try {
            await supabaseAdmin.rpc('track_subscription_conversion', {
              p_user_id: userId,
              p_from_tier: currentProfile?.plan_tier || 'None',
              p_to_tier: planTier,
              p_conversion_type: currentProfile?.plan_tier ? 'upgrade' : 'signup'
            })
          } catch (conversionError) {
            console.error('Error tracking conversion:', conversionError)
            // Don't fail the webhook if conversion tracking fails
          }

          // GHL sync happens automatically via database trigger on profile update
        } else if (!userId) {
          console.error('checkout.session.completed: Could not determine user ID', {
            sessionId: session.id,
            customerId,
            userEmail,
            isAdminCreated,
          })
        }
        break
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription
        const customerId = subscription.customer as string

        // Get user by stripe customer ID
        const { data: profile } = await supabaseAdmin
          .from('profiles')
          .select('id, plan_tier, pending_plan_tier, pending_plan_effective_date')
          .eq('stripe_customer_id', customerId)
          .single()

        if (profile) {
          // Get the current price's product to determine the new plan tier
          const priceId = subscription.items.data[0]?.price?.id
          let newPlanTier = profile.plan_tier

          // Look up plan tier from price - users get their actual subscription tier
          // Premium Guest is deprecated - users get their actual subscription tier regardless of trial status
          if (priceId) {
            // Look up the plan tier from the price ID
            const { data: plan } = await supabaseAdmin
              .from('subscription_plans')
              .select('plan_tier')
              .eq('stripe_price_id', priceId)
              .single()

            if (plan) {
              newPlanTier = plan.plan_tier
            }
          }

          // Check if this is a scheduled downgrade taking effect
          const updateData: Record<string, any> = {
            subscription_status: subscription.status,
            stripe_subscription_status: subscription.status,
            updated_at: new Date().toISOString(),
          }

          // If the plan tier changed, update it with new escalations
          // Users get their actual tier regardless of trial status
          if (newPlanTier !== profile.plan_tier) {
            updateData.plan_tier = newPlanTier
            updateData.escalations_remaining = getBasePlanEscalations(newPlanTier)
            updateData.escalations_last_reset_date = new Date().toISOString()

            // Determine if this is an upgrade or downgrade
            const tierOrder = ['None', 'Premium', 'Premium Processor', 'Elite', 'Elite Processor', 'VIP', 'VIP Processor']
            const oldIndex = tierOrder.indexOf(profile.plan_tier)
            const newIndex = tierOrder.indexOf(newPlanTier)
            const conversionType = newIndex > oldIndex ? 'upgrade' : 'downgrade'

            // Track the conversion
            try {
              await supabaseAdmin.rpc('track_subscription_conversion', {
                p_user_id: profile.id,
                p_from_tier: profile.plan_tier,
                p_to_tier: newPlanTier,
                p_conversion_type: conversionType
              })
            } catch (trackError) {
              console.error('Error tracking conversion:', trackError)
            }

            // Get user email for notification
            const { data: userProfile } = await supabaseAdmin
              .from('profiles')
              .select('email, full_name')
              .eq('id', profile.id)
              .single()

            // Send notification email
            if (userProfile?.email) {
              try {
                await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/send-subscription-notification`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
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

          // Clear pending downgrade if it matches the new tier
          if (profile.pending_plan_tier && newPlanTier === profile.pending_plan_tier) {
            updateData.pending_plan_tier = null
            updateData.pending_plan_effective_date = null
          }

          // Handle cancel_at_period_end - when subscription is scheduled to cancel
          // This catches cancellations made directly in Stripe dashboard
          if (subscription.cancel_at_period_end) {
            // Subscription is scheduled to cancel at period end
            const cancelDate = new Date((subscription as any).current_period_end * 1000)

            // Only set pending cancellation if not already a downgrade
            // (downgrade has a specific target tier, cancellation goes to 'Canceled')
            const pendingDowngradeTier = subscription.metadata?.pending_downgrade_tier
            if (!pendingDowngradeTier) {
              updateData.pending_plan_tier = 'Canceled'
              updateData.pending_plan_effective_date = cancelDate.toISOString()
              updateData.pending_plan_price_id = null
              console.log(`Subscription scheduled for cancellation: ${customerId}, effective ${cancelDate.toISOString()}`)
            }
          } else if (!subscription.cancel_at_period_end && profile.pending_plan_tier === 'Canceled') {
            // Cancellation was undone (reactivated) - clear pending cancellation
            updateData.pending_plan_tier = null
            updateData.pending_plan_effective_date = null
            updateData.pending_plan_price_id = null
            console.log(`Subscription cancellation undone: ${customerId}`)
          }

          await supabaseAdmin
            .from('profiles')
            .update(updateData)
            .eq('id', profile.id)
        }
        break
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription
        const customerId = subscription.customer as string

        // Check if this is a scheduled downgrade (has pending plan metadata)
        const pendingTier = subscription.metadata?.pending_downgrade_tier
        const pendingPriceId = subscription.metadata?.pending_downgrade_price_id

        // Get user by stripe customer ID
        const { data: profile } = await supabaseAdmin
          .from('profiles')
          .select('id, email, full_name, plan_tier, pending_plan_tier, pending_plan_price_id')
          .eq('stripe_customer_id', customerId)
          .single()

        if (profile) {
          // Check if there's a pending downgrade to process
          const targetTier = pendingTier || profile.pending_plan_tier
          const targetPriceId = pendingPriceId || profile.pending_plan_price_id

          if (targetTier && targetPriceId) {
            // Create new subscription at the lower tier
            try {
              // Get customer's default payment method
              const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer
              const defaultPaymentMethod = customer.invoice_settings?.default_payment_method as string | undefined

              const newSubscription = await stripe.subscriptions.create({
                customer: customerId,
                items: [{ price: targetPriceId }],
                default_payment_method: defaultPaymentMethod || undefined,
                metadata: {
                  supabase_user_id: profile.id,
                  plan_tier: targetTier,
                }
              })

              // Guard: check for duplicate before writing new subscription ID
              const { data: dupOwnerDowngrade } = await supabaseAdmin
                .from('profiles')
                .select('id, email')
                .eq('stripe_subscription_id', newSubscription.id)
                .neq('id', profile.id)
                .limit(1)
                .single()
              if (dupOwnerDowngrade) {
                console.warn(`DUPLICATE PREVENTED (downgrade): subscription ${newSubscription.id} already belongs to ${dupOwnerDowngrade.email}, skipping ${profile.id}`)
                break
              }

              // Update profile with new subscription, tier, and reset escalations
              const newEscalations = getBasePlanEscalations(targetTier)
              await supabaseAdmin
                .from('profiles')
                .update({
                  plan_tier: targetTier,
                  stripe_subscription_id: newSubscription.id,
                  subscription_status: newSubscription.status,
                  stripe_subscription_status: newSubscription.status,
                  escalations_remaining: newEscalations,
                  escalations_last_reset_date: new Date().toISOString(),
                  pending_plan_tier: null,
                  pending_plan_effective_date: null,
                  pending_plan_price_id: null,
                  updated_at: new Date().toISOString(),
                })
                .eq('id', profile.id)
            } catch (subError) {
              console.error('Error creating new subscription for downgrade:', subError)
              // Don't change plan tier - needs manual intervention
              // Clear pending data since the old subscription is gone
              await supabaseAdmin
                .from('profiles')
                .update({
                  stripe_subscription_id: null,
                  subscription_status: 'canceled',
                  stripe_subscription_status: 'canceled',
                  pending_plan_tier: null,
                  pending_plan_effective_date: null,
                  pending_plan_price_id: null,
                  updated_at: new Date().toISOString(),
                })
                .eq('id', profile.id)
            }
          } else {
            // No pending downgrade - check if customer has another active subscription
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
              const { data: dupOwnerActive } = await supabaseAdmin
                .from('profiles')
                .select('id, email')
                .eq('stripe_subscription_id', activeSubscription.id)
                .neq('id', profile.id)
                .limit(1)
                .single()
              if (dupOwnerActive) {
                console.warn(`DUPLICATE PREVENTED (sub.deleted fallback): subscription ${activeSubscription.id} already belongs to ${dupOwnerActive.email}, skipping ${profile.id}`)
                break
              }

              const priceId = activeSubscription.items.data[0]?.price?.id
              let newPlanTier = profile.plan_tier

              if (priceId) {
                const { data: plan } = await supabaseAdmin
                  .from('subscription_plans')
                  .select('plan_tier')
                  .eq('stripe_price_id', priceId)
                  .single()

                if (plan) {
                  newPlanTier = plan.plan_tier
                }
              }

              const newEscalations = getBasePlanEscalations(newPlanTier)

              await supabaseAdmin
                .from('profiles')
                .update({
                  plan_tier: newPlanTier,
                  stripe_subscription_id: activeSubscription.id,
                  subscription_status: activeSubscription.status,
                  stripe_subscription_status: activeSubscription.status,
                  escalations_remaining: newEscalations,
                  escalations_last_reset_date: new Date().toISOString(),
                  pending_plan_tier: null,
                  pending_plan_effective_date: null,
                  pending_plan_price_id: null,
                  updated_at: new Date().toISOString(),
                })
                .eq('id', profile.id)

              console.log(`Updated user ${profile.id} to new subscription ${activeSubscription.id} with tier ${newPlanTier}`)
            } else {
              // No other active subscription - proceed with cancellation
              await supabaseAdmin
                .from('profiles')
                .update({
                  plan_tier: 'Canceled',
                  stripe_subscription_id: null,
                  subscription_status: 'canceled',
                  stripe_subscription_status: 'canceled',
                  escalations_remaining: 0,
                  pending_plan_tier: null,
                  pending_plan_effective_date: null,
                  pending_plan_price_id: null,
                  updated_at: new Date().toISOString(),
                })
                .eq('id', profile.id)

              // Track the cancellation
              try {
                await supabaseAdmin.rpc('track_subscription_conversion', {
                  p_user_id: profile.id,
                  p_from_tier: profile.plan_tier,
                  p_to_tier: 'Canceled',
                  p_conversion_type: 'cancellation'
                })
              } catch (trackError) {
                console.error('Error tracking cancellation:', trackError)
              }

              // Send cancellation notification email
              if (profile.email) {
                try {
                  await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/send-subscription-notification`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
                    },
                    body: JSON.stringify({
                      type: 'cancellation',
                      userEmail: profile.email,
                      userName: profile.full_name,
                      fromTier: profile.plan_tier,
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

        // Get user by stripe customer ID
        const { data: failedProfile } = await supabaseAdmin
          .from('profiles')
          .select('id, payment_failed_at')
          .eq('stripe_customer_id', customerId)
          .single()

        if (failedProfile) {
          // Only set payment_failed_at if not already set (first failure in this cycle)
          const updateData: Record<string, any> = {
            subscription_status: 'past_due',
            stripe_subscription_status: 'past_due',
            updated_at: new Date().toISOString(),
          }

          // Only set payment_failed_at on first failure
          if (!failedProfile.payment_failed_at) {
            updateData.payment_failed_at = new Date().toISOString()
          }

          await supabaseAdmin
            .from('profiles')
            .update(updateData)
            .eq('id', failedProfile.id)

          // GHL sync happens automatically via database trigger on profile update
        }
        break
      }

      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice
        const customerId = invoice.customer as string
        const subscriptionId = (invoice as any).subscription as string

        if (!subscriptionId) break // Not a subscription invoice

        // Get user by stripe customer ID
        const { data: paidProfile } = await supabaseAdmin
          .from('profiles')
          .select('id, payment_failed_at')
          .eq('stripe_customer_id', customerId)
          .single()

        if (paidProfile) {
          // Clear payment_failed_at and update status - payment recovered!
          await supabaseAdmin
            .from('profiles')
            .update({
              subscription_status: 'active',
              stripe_subscription_status: 'active',
              payment_failed_at: null,
              updated_at: new Date().toISOString(),
            })
            .eq('id', paidProfile.id)

          // GHL sync happens automatically via database trigger on profile update
        }
        break
      }

      case 'invoice.payment_action_required': {
        const invoice = event.data.object as Stripe.Invoice
        const customerId = invoice.customer as string

        // Get user by stripe customer ID
        const { data: profile } = await supabaseAdmin
          .from('profiles')
          .select('id, payment_failed_at')
          .eq('stripe_customer_id', customerId)
          .single()

        if (profile) {
          // Mark as requiring action (treat similar to payment failed)
          const updateData: Record<string, any> = {
            subscription_status: 'past_due',
            stripe_subscription_status: 'past_due',
            updated_at: new Date().toISOString(),
          }

          if (!profile.payment_failed_at) {
            updateData.payment_failed_at = new Date().toISOString()
          }

          await supabaseAdmin
            .from('profiles')
            .update(updateData)
            .eq('id', profile.id)
        }
        break
      }

      case 'payment_intent.succeeded': {
        // Fuse reconciler — closes the residual gap where a Fuse
        // PaymentIntent succeeded but our DB writes failed (or the
        // client never received the success response and bailed).
        //
        // Filters strictly to our own intents via metadata.type. Idempotent:
        // every branch checks before writing, so replays / out-of-order
        // deliveries are safe. Non-Fuse intents fall through to default.
        const pi = event.data.object as Stripe.PaymentIntent
        if (pi.metadata?.type !== 'fuse_claim_addon') break

        const source = pi.metadata?.source
        const registrationId = pi.metadata?.registration_id
        if (!registrationId) {
          // claim+finalize one-shot path creates the registration row
          // server-side in the same request that creates the PI, so
          // there's no row to reconcile against here. If that write
          // failed, the user-facing route already 500'd.
          break
        }

        const { data: reg } = await supabaseAdmin
          .from('fuse_registrations')
          .select(
            'id, user_id, fuse_event_id, ticket_type, purchase_type, step_completed',
          )
          .eq('id', registrationId)
          .single()

        if (!reg) {
          console.warn(
            `[fuse reconciler] PI ${pi.id} references registration ${registrationId} but row not found`,
          )
          break
        }

        // ----------------------------------------------------------------
        // 1. Promote step_completed='claim' → 'finalized' if a finalize /
        //    top-up / upgrade / claim+finalize PI succeeded. Top-ups
        //    against an already-finalized row are a no-op (registration
        //    stays 'finalized').
        //    Also flip purchase_type='pending' → 'purchased' as a safety
        //    net — the finalize route writes this synchronously, but if
        //    that DB write fails post-charge the webhook still reconciles.
        // ----------------------------------------------------------------
        const isFinalizingSource =
          source === 'finalize' ||
          source === 'top-up' ||
          source === 'upgrade-to-ga-plus' ||
          source === 'claim_finalize'
        const regUpdate: Record<string, unknown> = {}
        if (isFinalizingSource && reg.step_completed !== 'finalized') {
          regUpdate.step_completed = 'finalized'
        }
        if (isFinalizingSource && reg.purchase_type === 'pending') {
          regUpdate.purchase_type = 'purchased'
        }
        // ----------------------------------------------------------------
        // 2. Upgrade reconciliation — if the upgrade PI succeeded but
        //    we never flipped ticket_type / purchase_type, do it now.
        // ----------------------------------------------------------------
        if (source === 'upgrade-to-ga-plus') {
          if (reg.ticket_type !== 'general_admission_plus') {
            regUpdate.ticket_type = 'general_admission_plus'
          }
          if (reg.purchase_type !== 'upgraded') {
            regUpdate.purchase_type = 'upgraded'
          }
        }
        if (Object.keys(regUpdate).length > 0) {
          regUpdate.updated_at = new Date().toISOString()
          const { error: updErr } = await supabaseAdmin
            .from('fuse_registrations')
            .update(regUpdate)
            .eq('id', registrationId)
          if (updErr) {
            console.error(
              `[fuse reconciler] failed to update registration ${registrationId}:`,
              updErr,
            )
          } else {
            console.log(
              `[fuse reconciler] reconciled ${registrationId} from PI ${pi.id} (source=${source}):`,
              regUpdate,
            )
          }
        }

        // ----------------------------------------------------------------
        // 3. profiles.fuse_ticket_claimed_year — set if missing for this
        //    member so the banner + sidebar key off it correctly. Only
        //    touches rows where the value is still null (won't clobber
        //    a more recent year).
        // ----------------------------------------------------------------
        if (reg.user_id) {
          const { data: fuseEvent } = await supabaseAdmin
            .from('fuse_events')
            .select('year')
            .eq('id', reg.fuse_event_id)
            .single()
          if (fuseEvent?.year) {
            await supabaseAdmin
              .from('profiles')
              .update({ fuse_ticket_claimed_year: fuseEvent.year })
              .eq('id', reg.user_id)
              .is('fuse_ticket_claimed_year', null)
          }
        }
        break
      }

      default:
        // Unhandled event types are silently ignored
    }

    return NextResponse.json({ received: true })
  } catch (error) {
    console.error('Webhook error:', error)
    return NextResponse.json(
      { error: 'Webhook handler failed' },
      { status: 500 }
    )
  }
}
