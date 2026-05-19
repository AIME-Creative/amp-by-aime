// AIME-14: charge.refunded handler — LOG-ONLY.
//
// `charge.refunded` is handled nowhere in the existing AMP stack:
// no Make.com scenario, no code, no Postgres trigger, no Edge
// Function. Stripe LIVE isn't even configured to send the event to
// AMP (only Stripe TEST is). This handler preserves that
// no-mutation behaviour but adds visibility: every received refund
// lands in sync_events with the refund amount + reason in `outcome`,
// so ops can query when refunds start needing real automation.
//
// Deliberately NOT touching profiles. Refund semantics are nuanced
// (partial vs full, single charge vs whole subscription period,
// billing period crossover) — encoding a "right answer" without
// product input would introduce silent behaviour. The audit row
// gives us data to make that call later.

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

export async function handleChargeRefund(
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
    if (stripeEvent.type !== 'charge.refunded') {
      throw new Error(
        `charge-refund: unexpected event type ${stripeEvent.type}`,
      );
    }

    const charge = stripeEvent.data.object as Stripe.Charge;
    const customerId =
      typeof charge.customer === 'string'
        ? charge.customer
        : charge.customer?.id ?? null;

    await markProcessed(db, syncEventId, {
      mode: 'log_only',
      charge_id: charge.id,
      customer: customerId,
      amount_refunded: charge.amount_refunded,
      refund_count: charge.refunds?.data?.length ?? 0,
      reason: charge.refunds?.data?.[0]?.reason ?? null,
      currency: charge.currency,
      note: 'AIME-14: no profile mutation; preserves pre-existing behaviour. Audit only.',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markFailed(db, syncEventId, message);
    throw err;
  }
}
