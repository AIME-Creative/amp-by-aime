// AIME-14: customer.subscription.{created,updated,deleted} handler.
//
// Reconcile-from-source pattern: regardless of the inbound event's
// `data.object`, we refetch the subscription's *current* state from
// Stripe and write that to the profile. This makes the handler safe
// to replay and tolerant of out-of-order delivery — running it once
// or running it five times converges to whatever Stripe says now.
//
// Business logic ported faithfully from the legacy EF at
// supabase/functions/stripe-webhook/index.ts:
//   - subscription_override === true → only sync stripe_subscription_id
//   - Tier lookup via subscription_plans(stripe_price_id)
//   - Paid-access gating against PAID_ACCESS_STATUSES
//   - cancel_at_period_end → pending_plan_tier='Canceled'
//   - Cancellation undone → clear pending_plan_*
//   - Tier change → reset escalations + track_subscription_conversion
//   - Cross-profile duplicate-subscription guard
//   - send-subscription-notification email
//
// Delete handling additionally:
//   - Looks for another active/trialing sub on the customer and rebinds
//     (legacy EF behaviour for "user canceled and re-subscribed")
//   - Otherwise sets to Canceled with escalations=0 + cancellation email

import type { Job } from 'pg-boss';
import type Stripe from 'stripe';
import { stripe } from '../../lib/stripe/config';
import { getBasePlanEscalations } from '../../lib/escalations';
import {
  getEventById,
  getSupabaseAdmin,
  markFailed,
  markProcessed,
  markProcessing,
  type QueueJobData,
} from '../../lib/sync';
import {
  classifyTierChange,
  PAID_ACCESS_STATUSES,
  REVOKE_PAID_ACCESS_STATUSES,
  tierFromPriceId,
} from './_lib/tier';
import {
  detectSubscriptionDuplicate,
  findProfileByCustomerId,
  type ProfileForSync,
} from './_lib/profile';
import { sendSubscriptionNotification } from './_lib/notify';

interface ProfileUpdate {
  plan_tier?: string;
  stripe_customer_id?: string;
  stripe_subscription_id?: string | null;
  subscription_status?: string;
  stripe_subscription_status?: string;
  billing_period?: string | null;
  payment_amount?: number | null;
  escalations_remaining?: number;
  escalations_last_reset_date?: string;
  payment_failed_at?: string | null;
  pending_plan_tier?: string | null;
  pending_plan_effective_date?: string | null;
  pending_plan_price_id?: string | null;
  updated_at: string;
}

export async function handleSubscriptionLifecycle(
  jobs: Job<QueueJobData>[],
): Promise<void> {
  for (const job of jobs) {
    await processOne(job.data.sync_event_id);
  }
}

async function processOne(syncEventId: string): Promise<void> {
  const db = getSupabaseAdmin();
  const event = await getEventById(db, syncEventId);
  if (!event) {
    throw new Error(`sync_events row ${syncEventId} not found`);
  }
  // Idempotency: if a previous run already marked this processed,
  // skip silently. pg-boss can deliver the same job after a crash.
  if (event.status === 'processed') return;

  await markProcessing(db, syncEventId);

  try {
    const stripeEvent = event.payload as Stripe.Event;
    let outcome: Record<string, unknown>;

    switch (stripeEvent.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        outcome = await processUpsert(db, stripeEvent);
        break;
      case 'customer.subscription.deleted':
        outcome = await processDeletion(db, stripeEvent);
        break;
      default:
        throw new Error(
          `subscription-lifecycle: unexpected event type ${stripeEvent.type}`,
        );
    }

    await markProcessed(db, syncEventId, outcome);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markFailed(db, syncEventId, message);
    throw err; // re-throw so pg-boss retries / DLQs per its config
  }
}

// -------------------------------------------------------------------
// Upsert (created + updated share the same logic)
// -------------------------------------------------------------------
async function processUpsert(
  db: ReturnType<typeof getSupabaseAdmin>,
  event: Stripe.Event,
): Promise<Record<string, unknown>> {
  const eventSub = event.data.object as Stripe.Subscription;
  const customerId = eventSub.customer as string;

  // Reconcile from source: refetch the current subscription state
  // rather than trusting the event payload.
  const subscription = await stripe.subscriptions.retrieve(eventSub.id);

  const profile = await findProfileByCustomerId(db, customerId);
  if (!profile) {
    return { skipped: 'no_profile_for_customer', customer: customerId };
  }

  // Override-respect: legacy EF refuses to mutate tier/status when
  // subscription_override is true. Only the subscription ID gets
  // synced through.
  if (profile.subscription_override) {
    return mutateOverrideOnly(db, profile, subscription);
  }

  const priceId = subscription.items.data[0]?.price?.id ?? null;
  const interval = subscription.items.data[0]?.price?.recurring?.interval;
  const billingPeriod =
    interval === 'year' ? 'Annual' : interval === 'month' ? 'Monthly' : null;
  const unitAmount = subscription.items.data[0]?.price?.unit_amount;
  const paymentAmount =
    typeof unitAmount === 'number' ? unitAmount / 100 : null;

  const status = subscription.status;
  const hasPaidAccess = PAID_ACCESS_STATUSES.has(status);

  // Duplicate-subscription guard. If another profile already owns
  // this subscription, refuse to overwrite. Match legacy EF behaviour
  // (logs + skips, doesn't error).
  if (subscription.id) {
    const conflictingEmail = await detectSubscriptionDuplicate(
      db,
      subscription.id,
      profile.id,
    );
    if (conflictingEmail) {
      console.warn(
        `[sub-lifecycle] duplicate subscription ${subscription.id} already owned by ${conflictingEmail}; skipping profile ${profile.id}`,
      );
      return { skipped: 'duplicate_subscription', conflictingEmail };
    }
  }

  // Compute target tier. Only re-tier when subscription is in paid-
  // access state; otherwise keep current tier and apply status-based
  // gating below.
  let newPlanTier = profile.plan_tier;
  if (priceId && hasPaidAccess) {
    const looked = await tierFromPriceId(db, priceId);
    if (looked) newPlanTier = looked;
  }

  const update: ProfileUpdate = {
    subscription_status: status,
    stripe_subscription_status: status,
    stripe_subscription_id: subscription.id,
    updated_at: new Date().toISOString(),
  };
  if (billingPeriod) update.billing_period = billingPeriod;
  if (paymentAmount !== null) update.payment_amount = paymentAmount;

  // Recovery from past_due: any time we land in a paid state, clear
  // the failure marker.
  if (hasPaidAccess) update.payment_failed_at = null;

  // Status-driven access revocation. Mirrors EF: non-paying statuses
  // demote to Canceled (unless already None/Canceled).
  if (!hasPaidAccess) {
    if (status === 'past_due' && !profile.payment_failed_at) {
      update.payment_failed_at = new Date().toISOString();
    }
    if (REVOKE_PAID_ACCESS_STATUSES.has(status)) {
      if (profile.plan_tier !== 'Canceled' && profile.plan_tier !== 'None') {
        update.plan_tier = 'Canceled';
        update.escalations_remaining = 0;
      }
    }
  }

  // cancel_at_period_end → pending_plan_tier='Canceled'.
  if (subscription.cancel_at_period_end) {
    const cancelDate = new Date(
      (subscription as unknown as { current_period_end: number })
        .current_period_end * 1000,
    );
    const pendingDowngrade = subscription.metadata?.pending_downgrade_tier;
    if (!pendingDowngrade) {
      update.pending_plan_tier = 'Canceled';
      update.pending_plan_effective_date = cancelDate.toISOString();
      update.pending_plan_price_id = null;
    }
  } else if (profile.pending_plan_tier === 'Canceled') {
    // Cancellation undone.
    update.pending_plan_tier = null;
    update.pending_plan_effective_date = null;
    update.pending_plan_price_id = null;
  }

  // Tier change: bump escalations, track conversion, notify.
  let conversionTracked: 'upgrade' | 'downgrade' | null = null;
  if (hasPaidAccess && newPlanTier !== profile.plan_tier) {
    update.plan_tier = newPlanTier;
    update.escalations_remaining = getBasePlanEscalations(newPlanTier);
    update.escalations_last_reset_date = new Date().toISOString();
    const direction = classifyTierChange(profile.plan_tier, newPlanTier);
    if (direction !== 'no-change') {
      conversionTracked = direction;
      try {
        await db.rpc('track_subscription_conversion', {
          p_user_id: profile.id,
          p_from_tier: profile.plan_tier,
          p_to_tier: newPlanTier,
          p_conversion_type: direction,
        });
      } catch (err) {
        console.warn('[sub-lifecycle] track_subscription_conversion failed (non-fatal):', err);
      }
      if (profile.email) {
        await sendSubscriptionNotification({
          type: direction,
          userEmail: profile.email,
          userName: profile.full_name,
          fromTier: profile.plan_tier,
          toTier: newPlanTier,
        });
      }
    }
  }

  const { error } = await db.from('profiles').update(update).eq('id', profile.id);
  if (error) throw error;

  return {
    profile_id: profile.id,
    subscription_id: subscription.id,
    status,
    plan_tier: update.plan_tier ?? profile.plan_tier,
    billing_period: update.billing_period ?? null,
    conversion: conversionTracked,
    overrode: false,
  };
}

async function mutateOverrideOnly(
  db: ReturnType<typeof getSupabaseAdmin>,
  profile: ProfileForSync,
  subscription: Stripe.Subscription,
): Promise<Record<string, unknown>> {
  if (subscription.id) {
    const conflictingEmail = await detectSubscriptionDuplicate(
      db,
      subscription.id,
      profile.id,
    );
    if (conflictingEmail) {
      return { skipped: 'override_path_duplicate', conflictingEmail };
    }
  }
  const { error } = await db
    .from('profiles')
    .update({
      stripe_subscription_id: subscription.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', profile.id);
  if (error) throw error;
  return { profile_id: profile.id, overrode: true };
}

// -------------------------------------------------------------------
// Deletion
// -------------------------------------------------------------------
async function processDeletion(
  db: ReturnType<typeof getSupabaseAdmin>,
  event: Stripe.Event,
): Promise<Record<string, unknown>> {
  const subscription = event.data.object as Stripe.Subscription;
  const customerId = subscription.customer as string;

  const profile = await findProfileByCustomerId(db, customerId);
  if (!profile) {
    return { skipped: 'no_profile_for_customer', customer: customerId };
  }
  if (profile.subscription_override) {
    return { skipped: 'override_blocks_cancel', profile_id: profile.id };
  }

  // Check for another active/trialing sub on this customer. Legacy EF
  // does this to handle "canceled old, created new in same session"
  // cases.
  const [activeRes, trialingRes] = await Promise.all([
    stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 1 }),
    stripe.subscriptions.list({ customer: customerId, status: 'trialing', limit: 1 }),
  ]);
  const fallback = activeRes.data[0] ?? trialingRes.data[0] ?? null;

  if (fallback) {
    const conflictingEmail = await detectSubscriptionDuplicate(
      db,
      fallback.id,
      profile.id,
    );
    if (conflictingEmail) {
      return { skipped: 'fallback_sub_duplicate', conflictingEmail };
    }
    const priceId = fallback.items.data[0]?.price?.id ?? null;
    let newTier = profile.plan_tier;
    if (priceId) {
      const looked = await tierFromPriceId(db, priceId);
      if (looked) newTier = looked;
    }
    const { error } = await db
      .from('profiles')
      .update({
        plan_tier: newTier,
        stripe_subscription_id: fallback.id,
        subscription_status: fallback.status,
        stripe_subscription_status: fallback.status,
        escalations_remaining: getBasePlanEscalations(newTier),
        escalations_last_reset_date: new Date().toISOString(),
        pending_plan_tier: null,
        pending_plan_effective_date: null,
        pending_plan_price_id: null,
        payment_failed_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', profile.id);
    if (error) throw error;
    return {
      profile_id: profile.id,
      rebound_to: fallback.id,
      plan_tier: newTier,
    };
  }

  // No fallback subscription — proceed with cancellation.
  const previousTier = profile.plan_tier;
  const { error } = await db
    .from('profiles')
    .update({
      plan_tier: 'Canceled',
      stripe_subscription_id: null,
      subscription_status: 'canceled',
      stripe_subscription_status: 'canceled',
      escalations_remaining: 0,
      updated_at: new Date().toISOString(),
    })
    .eq('id', profile.id);
  if (error) throw error;

  // Non-load-bearing: analytics + email.
  try {
    await db.rpc('track_subscription_conversion', {
      p_user_id: profile.id,
      p_from_tier: previousTier,
      p_to_tier: 'Canceled',
      p_conversion_type: 'cancellation',
    });
  } catch (err) {
    console.warn('[sub-lifecycle] cancellation tracking failed (non-fatal):', err);
  }
  if (profile.email) {
    await sendSubscriptionNotification({
      type: 'cancellation',
      userEmail: profile.email,
      userName: profile.full_name,
      fromTier: previousTier,
      toTier: 'Canceled',
    });
  }

  return { profile_id: profile.id, canceled_from: previousTier };
}
