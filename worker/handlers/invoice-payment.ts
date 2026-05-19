// AIME-14: invoice.payment_succeeded / invoice.paid / invoice.payment_failed.
//
// Ported from supabase/functions/stripe-webhook/index.ts:
//   - payment_failed: set subscription_status='past_due',
//                     set payment_failed_at on first failure only
//   - payment_succeeded + paid: clear payment_failed_at,
//                                set subscription_status='active'
//
// subscription_override blocks all status changes on the affected
// profile (admin overrides take precedence over Stripe state).

import type { Job } from 'pg-boss';
import type Stripe from 'stripe';
import {
  getEventById,
  getSupabaseAdmin,
  markFailed,
  markProcessed,
  markProcessing,
  type QueueJobData,
} from '../../lib/sync';
import { findProfileByCustomerId } from './_lib/profile';

const SUBSCRIPTION_EVENTS = new Set([
  'invoice.payment_failed',
  'invoice.payment_succeeded',
  'invoice.paid',
]);

export async function handleInvoicePayment(
  jobs: Job<QueueJobData>[],
): Promise<void> {
  for (const job of jobs) {
    await processOne(job.data.sync_event_id);
  }
}

async function processOne(syncEventId: string): Promise<void> {
  const db = getSupabaseAdmin();
  const event = await getEventById(db, syncEventId);
  if (!event) throw new Error(`sync_events row ${syncEventId} not found`);
  if (event.status === 'processed') return;

  await markProcessing(db, syncEventId);

  try {
    const stripeEvent = event.payload as Stripe.Event;
    if (!SUBSCRIPTION_EVENTS.has(stripeEvent.type)) {
      throw new Error(
        `invoice-payment: unexpected event type ${stripeEvent.type}`,
      );
    }

    const invoice = stripeEvent.data.object as Stripe.Invoice;
    const customerId = invoice.customer as string;
    const subscriptionId =
      (invoice as unknown as { subscription?: string }).subscription ?? null;

    // Non-subscription invoices (e.g. one-shot charges) aren't in scope
    // for this handler. The audit row still records that we received
    // it; the outcome marks why we didn't act.
    if (!subscriptionId) {
      await markProcessed(db, syncEventId, {
        skipped: 'non_subscription_invoice',
      });
      return;
    }

    const profile = await findProfileByCustomerId(db, customerId);
    if (!profile) {
      await markProcessed(db, syncEventId, {
        skipped: 'no_profile_for_customer',
        customer: customerId,
      });
      return;
    }
    if (profile.subscription_override) {
      await markProcessed(db, syncEventId, {
        skipped: 'override_blocks_status_change',
        profile_id: profile.id,
      });
      return;
    }

    const isFailure = stripeEvent.type === 'invoice.payment_failed';
    const update: Record<string, unknown> = {
      subscription_status: isFailure ? 'past_due' : 'active',
      stripe_subscription_status: isFailure ? 'past_due' : 'active',
      updated_at: new Date().toISOString(),
    };

    if (isFailure) {
      // Only set the first-failure marker if not already set, so a
      // cycle of retries doesn't overwrite the original failure date.
      if (!profile.payment_failed_at) {
        update.payment_failed_at = new Date().toISOString();
      }
    } else {
      // Success: payment recovered. Always clear the failure marker.
      update.payment_failed_at = null;
    }

    const { error } = await db
      .from('profiles')
      .update(update)
      .eq('id', profile.id);
    if (error) throw error;

    await markProcessed(db, syncEventId, {
      profile_id: profile.id,
      invoice_id: invoice.id,
      new_status: update.subscription_status,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markFailed(db, syncEventId, message);
    throw err;
  }
}
