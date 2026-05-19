// AIME-14: aime-sync-worker entrypoint.
//
// Long-lived Node process. Boots pg-boss, registers one work() handler
// per queue, runs forever. Railway runs this as a separate service from
// the Next.js app via `npm run worker:start`.
//
// Process lifecycle:
//   1. boss.start() — pg-boss installs/migrates its schema if needed,
//                      then opens its connection pool.
//   2. boss.work()  — register handlers. Returns immediately.
//   3. wait        — keep the event loop alive until SIGTERM/SIGINT.
//   4. shutdown     — boss.stop() drains in-flight jobs cleanly.

import { getBoss, QUEUE_NAMES, dlqOf } from '../lib/sync';
import type { WorkOptions } from 'pg-boss';

// Handler imports. These are stubbed until task #60/61/62 fill them in;
// the worker still boots and processes incoming jobs by parking them in
// `failed` until the real handlers land. That's intentional — we want
// to be able to run the worker in staging from day 1 to validate the
// plumbing.
import { handleSubscriptionLifecycle } from './handlers/subscription-lifecycle';
import { handleInvoicePayment } from './handlers/invoice-payment';
import { handleChargeRefund } from './handlers/charge-refund';

const SHUTDOWN_GRACE_MS = 15_000;

function log(msg: string, extra?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      svc: 'aime-sync-worker',
      msg,
      ...extra,
    }),
  );
}

async function main(): Promise<void> {
  log('starting');
  const boss = await getBoss();

  boss.on('error', (err: Error) => {
    log('pgboss error', { error: err.message, stack: err.stack });
  });

  await boss.start();
  log('pgboss started');

  // pg-boss v12 requires explicit queue creation before work().
  // createQueue() is idempotent — second call against an existing
  // queue is a no-op. Per-queue retention is set here.
  //
  // subscription-lifecycle uses `key_strict_fifo` so events for the
  // same customer (singletonKey = customer_id at send-time) are
  // processed strictly in enqueue order. invoice-payment and
  // charge-refund stay `standard` — reconcile-from-source handlers
  // tolerate out-of-order delivery for those.
  const baseRetention = {
    retentionSeconds: 7 * 24 * 60 * 60,
    deleteAfterSeconds: 14 * 24 * 60 * 60,
  };
  await boss.createQueue(QUEUE_NAMES.stripeSubscriptionLifecycle, {
    ...baseRetention,
    policy: 'key_strict_fifo',
  });
  await boss.createQueue(dlqOf(QUEUE_NAMES.stripeSubscriptionLifecycle), baseRetention);
  await boss.createQueue(QUEUE_NAMES.stripeInvoicePayment, baseRetention);
  await boss.createQueue(dlqOf(QUEUE_NAMES.stripeInvoicePayment), baseRetention);
  await boss.createQueue(QUEUE_NAMES.stripeChargeRefund, baseRetention);
  await boss.createQueue(dlqOf(QUEUE_NAMES.stripeChargeRefund), baseRetention);
  log('queues created');

  // Each queue runs with conservative concurrency (10 in-flight per
  // queue) so a single misbehaving handler can't saturate Postgres.
  // Per-customer FIFO inside Stripe lifecycle is enforced by sending
  // jobs with singletonKey=customer_id at enqueue time (receiver
  // sets that via lib/sync/queue.ts queueing helpers).
  const opts: WorkOptions = { batchSize: 10 };

  await boss.work(
    QUEUE_NAMES.stripeSubscriptionLifecycle,
    opts,
    handleSubscriptionLifecycle,
  );
  await boss.work(
    QUEUE_NAMES.stripeInvoicePayment,
    opts,
    handleInvoicePayment,
  );
  await boss.work(QUEUE_NAMES.stripeChargeRefund, opts, handleChargeRefund);

  // DLQ queues exist so they're visible to operators in pgboss.queue
  // and so retention policies apply. We don't register handlers —
  // DLQ entries are manually triaged.
  log('handlers registered', {
    queues: Object.values(QUEUE_NAMES),
    dlqs: Object.values(QUEUE_NAMES).map(dlqOf),
  });

  // Graceful shutdown.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('shutdown initiated', { signal });
    const stopper = boss.stop({ graceful: true, timeout: SHUTDOWN_GRACE_MS });
    const timeoutHandle = setTimeout(() => {
      log('shutdown timeout exceeded, forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS + 1_000);
    try {
      await stopper;
      clearTimeout(timeoutHandle);
      log('shutdown clean');
      process.exit(0);
    } catch (err) {
      log('shutdown error', { error: (err as Error).message });
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  log('ready');
}

main().catch((err) => {
  log('fatal', { error: err.message, stack: err.stack });
  process.exit(1);
});
