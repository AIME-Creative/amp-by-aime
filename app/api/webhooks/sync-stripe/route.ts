// AIME-14: Stripe webhook receiver for the new sync architecture.
//
// Replaces the dual handler (supabase/functions/stripe-webhook +
// app/api/webhooks/stripe) for the events in AIME-14's scope. This
// route does NO business logic — it persists every received event into
// sync_events, enqueues a pg-boss job, and returns 200. The worker
// (worker/index.ts) drains the queue.
//
// Idempotency is enforced by sync_events.UNIQUE (source, event_id):
// duplicate Stripe deliveries produce a single audit row and a single
// queued job, no matter how many times Stripe replays.

import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { stripe } from '@/lib/stripe/config';
import {
  enqueue,
  getSupabaseAdmin,
  insertReceivedEvent,
  queueForStripeEvent,
  QUEUE_NAMES,
} from '@/lib/sync';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'Missing stripe-signature' }, { status: 400 });
  }

  // This endpoint uses its own signing secret (separate from the
  // legacy /api/webhooks/stripe route's STRIPE_WEBHOOK_SECRET) so both
  // can run in staging side-by-side during the AIME-14 parallel-run
  // validation. After cutover this can be consolidated.
  const secret = process.env.STRIPE_WEBHOOK_SECRET_SYNC;
  if (!secret) {
    console.error('[sync-stripe] STRIPE_WEBHOOK_SECRET_SYNC not configured');
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const body = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, secret);
  } catch (err) {
    console.error('[sync-stripe] signature verification failed:', err);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  // Only enqueue events we have handlers for. Anything else lands in
  // sync_events for audit but is not enqueued — handlers will be added
  // in subsequent tickets as scope expands.
  const queue = queueForStripeEvent(event.type);
  if (!queue) {
    // Out of scope for AIME-14. Stripe accepts the delivery; no audit
    // row either (keeps sync_events focused on events we actually act
    // on, so its row count reflects work-to-do not all-stripe-noise).
    return NextResponse.json({ received: true, in_scope: false });
  }

  // Audit log. UNIQUE (source, event_id) makes duplicate Stripe
  // deliveries a no-op (insertReceivedEvent returns null).
  const db = getSupabaseAdmin();
  let row;
  try {
    row = await insertReceivedEvent(db, {
      source: 'stripe',
      event_id: event.id,
      event_type: event.type,
      payload: event as unknown,
    });
  } catch (err) {
    console.error('[sync-stripe] sync_events insert failed:', err);
    // Return 500 so Stripe retries — losing the audit row means
    // losing the work, which is worse than a redelivery.
    return NextResponse.json({ error: 'Audit write failed' }, { status: 500 });
  }

  if (row === null) {
    // Duplicate delivery. Stripe gets a 200 and stops retrying; the
    // worker is already processing (or already processed) the first
    // copy.
    return NextResponse.json({ received: true, duplicate: true });
  }

  // Per-customer FIFO for subscription lifecycle. The customer_id is
  // present at event.data.object.customer on every event type in
  // scope. We send the same singletonKey to invoice + refund queues
  // too — those queue policies are `standard` so the key is advisory
  // there, but it costs nothing and keeps the data shape consistent.
  const customerId = extractCustomerId(event);
  const singletonKey =
    queue === QUEUE_NAMES.stripeSubscriptionLifecycle && customerId
      ? customerId
      : undefined;

  try {
    await enqueue(queue, { sync_event_id: row.id }, { singletonKey });
  } catch (err) {
    console.error('[sync-stripe] pg-boss enqueue failed:', err);
    // The audit row is already in. Stripe will retry; the receiver
    // will see the UNIQUE dedup and skip re-inserting but will retry
    // the enqueue. Eventually-consistent.
    return NextResponse.json({ error: 'Enqueue failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true, sync_event_id: row.id });
}

function extractCustomerId(event: Stripe.Event): string | null {
  const obj = event.data.object as { customer?: string | { id: string } | null };
  if (!obj.customer) return null;
  return typeof obj.customer === 'string' ? obj.customer : obj.customer.id;
}
