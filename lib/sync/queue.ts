// AIME-14: pg-boss client wrapper.
//
// pg-boss owns its own connection pool (it has to, because it uses
// LISTEN/NOTIFY which can't run through a transaction-mode pooler).
// We expose a singleton — the receiver and the worker both reuse the
// same instance within their respective processes.
//
// Two distinct concerns:
//
//   sendOnly()    — used by the receiver. Just enqueues. Does not
//                    register handlers. Calling `boss.stop()` here is
//                    safe and quick.
//
//   start()       — used by the worker entrypoint. Calls boss.start()
//                    which runs migrations, then the caller registers
//                    handlers via boss.work().

import { PgBoss, type SendOptions } from 'pg-boss';
import { getSyncDbUrl } from './db';
import {
  DLQ_SUFFIX,
  QUEUE_NAMES,
  type QueueJobData,
  type QueueName,
} from './types';

let cached: PgBoss | null = null;
let started = false;

// pg-boss config we apply to every queue. Per ADR:
//   - retry exponential backoff, 30s base, cap at 1h, up to 5 retries
//   - then job → DLQ queue (named `<original>-dlq`)
//   - archive completed jobs for 7 days for ops queries
export const PGBOSS_SEND_OPTS: SendOptions = {
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 3600,
};

export function dlqOf(queue: QueueName): string {
  return queue + DLQ_SUFFIX;
}

export async function getBoss(): Promise<PgBoss> {
  if (cached) return cached;
  cached = new PgBoss({
    connectionString: getSyncDbUrl(),
    // Per-queue retention is set when each queue is created (see
    // boss.createQueue calls in the worker). pg-boss v12 moved
    // retention out of the constructor.
  });
  return cached;
}

// Receiver path: enqueue a job referencing a sync_events row.
//
// The queue is chosen by the receiver based on event_type — the
// receiver knows which scenario each Stripe event belongs to.
export async function enqueue(
  queue: QueueName,
  data: QueueJobData,
  extra?: SendOptions,
): Promise<string | null> {
  const boss = await getBoss();
  // pg-boss connections are lazy until first send/work call.
  if (!started) {
    await boss.start();
    started = true;
  }

  return boss.send(queue, data, {
    ...PGBOSS_SEND_OPTS,
    deadLetter: dlqOf(queue),
    ...extra,
  });
}

// Helper to map a Stripe event type to its queue.
export function queueForStripeEvent(eventType: string): QueueName | null {
  if (eventType.startsWith('customer.subscription.')) {
    return QUEUE_NAMES.stripeSubscriptionLifecycle;
  }
  if (
    eventType === 'invoice.payment_succeeded' ||
    eventType === 'invoice.paid' ||
    eventType === 'invoice.payment_failed'
  ) {
    return QUEUE_NAMES.stripeInvoicePayment;
  }
  if (eventType === 'charge.refunded') {
    return QUEUE_NAMES.stripeChargeRefund;
  }
  return null;
}
