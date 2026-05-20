// AIME-14: types shared across receiver (Next.js route), worker handlers,
// and the sync_events table helpers.

export type SyncEventSource = 'stripe' | 'ghl' | 'app';

export type SyncEventStatus =
  | 'received'    // row inserted, pg-boss job enqueued
  | 'processing'  // handler picked it up
  | 'processed'   // handler completed successfully
  | 'failed'      // handler errored, pg-boss will retry
  | 'dlq';        // pg-boss retryLimit exhausted, moved to DLQ

export interface SyncEventRow {
  id: string;
  source: SyncEventSource;
  event_id: string;
  event_type: string;
  payload: unknown;
  received_at: string;
  processed_at: string | null;
  status: SyncEventStatus;
  retry_count: number;
  last_error: string | null;
  outcome: unknown | null;
}

// What the receiver passes into the pg-boss queue. Handlers receive
// this as `job.data`. Keep it small — handlers refetch the full event
// row from sync_events by id, so we only need the id here.
export interface QueueJobData {
  sync_event_id: string;
}

// Stable queue names. One queue per scenario (handler) so concurrency
// + retry policy can be tuned independently. DLQ name is convention:
// `<queue>-dlq`.
export const QUEUE_NAMES = {
  stripeSubscriptionLifecycle: 'sync.stripe.subscription-lifecycle',
  stripeInvoicePayment: 'sync.stripe.invoice-payment',
  stripeChargeRefund: 'sync.stripe.charge-refund',
  // AIME-15: profile change → GHL contact upsert.
  appProfileGhlUpsert: 'sync.app.profile-ghl-upsert',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const DLQ_SUFFIX = '-dlq';
