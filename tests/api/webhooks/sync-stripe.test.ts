/**
 * AIME-14: tests for the new sync-stripe receiver route.
 *
 * Exercises the route handler directly with mocked Stripe signature
 * verification and mocked lib/sync helpers. Never hits Stripe, never
 * hits Postgres.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Env must be set before the route imports lib/stripe/config (which
// throws at module load when STRIPE_SECRET_KEY is missing).
process.env.STRIPE_SECRET_KEY = 'sk_test_sync_stripe';
process.env.STRIPE_WEBHOOK_SECRET_SYNC = 'whsec_test_sync_stripe';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
process.env.SYNC_DB_URL = 'postgres://test/test';

// Mocks must be set up via vi.hoisted so vitest's mock-hoisting can
// reference them. Vitest v4 enforces this strictly.
const mocks = vi.hoisted(() => ({
  constructEventMock: vi.fn(),
  insertReceivedEventMock: vi.fn(),
  enqueueMock: vi.fn(),
  queueForStripeEventMock: vi.fn(),
  QUEUE_NAMES: {
    stripeSubscriptionLifecycle: 'sync.stripe.subscription-lifecycle',
    stripeInvoicePayment: 'sync.stripe.invoice-payment',
    stripeChargeRefund: 'sync.stripe.charge-refund',
  },
}));

vi.mock('@/lib/stripe/config', () => ({
  stripe: { webhooks: { constructEvent: mocks.constructEventMock } },
}));

vi.mock('@/lib/sync', () => ({
  getSupabaseAdmin: () => ({}),
  insertReceivedEvent: mocks.insertReceivedEventMock,
  enqueue: mocks.enqueueMock,
  queueForStripeEvent: mocks.queueForStripeEventMock,
  QUEUE_NAMES: mocks.QUEUE_NAMES,
}));

const {
  constructEventMock,
  insertReceivedEventMock,
  enqueueMock,
  queueForStripeEventMock,
  QUEUE_NAMES,
} = mocks;

// Import AFTER mocks register.
import { POST } from '@/app/api/webhooks/sync-stripe/route';

function buildRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://staging.example/api/webhooks/sync-stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

beforeEach(() => {
  constructEventMock.mockReset();
  insertReceivedEventMock.mockReset();
  enqueueMock.mockReset();
  queueForStripeEventMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sync-stripe receiver', () => {
  it('rejects requests without a stripe-signature header', async () => {
    const res = await POST(buildRequest('{}') as never);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/signature/i);
  });

  it('rejects requests with an invalid signature', async () => {
    constructEventMock.mockImplementation(() => {
      throw new Error('bad sig');
    });
    const res = await POST(
      buildRequest('{}', { 'stripe-signature': 'bogus' }) as never,
    );
    expect(res.status).toBe(400);
    expect(insertReceivedEventMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('returns 200 + in_scope:false for unhandled event types, no audit row written', async () => {
    constructEventMock.mockReturnValue({
      id: 'evt_unhandled',
      type: 'customer.created',
      data: { object: {} },
    });
    queueForStripeEventMock.mockReturnValue(null);

    const res = await POST(
      buildRequest('{}', { 'stripe-signature': 'ok' }) as never,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.in_scope).toBe(false);
    expect(insertReceivedEventMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('inserts the audit row and enqueues a job for in-scope events', async () => {
    constructEventMock.mockReturnValue({
      id: 'evt_sub_updated',
      type: 'customer.subscription.updated',
      data: { object: { customer: 'cus_abc' } },
    });
    queueForStripeEventMock.mockReturnValue(
      QUEUE_NAMES.stripeSubscriptionLifecycle,
    );
    insertReceivedEventMock.mockResolvedValue({ id: 'sync-evt-1' });
    enqueueMock.mockResolvedValue('job-id-1');

    const res = await POST(
      buildRequest('{}', { 'stripe-signature': 'ok' }) as never,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.received).toBe(true);
    expect(json.sync_event_id).toBe('sync-evt-1');

    expect(insertReceivedEventMock).toHaveBeenCalledTimes(1);
    const insertArgs = insertReceivedEventMock.mock.calls[0]![1];
    expect(insertArgs).toMatchObject({
      source: 'stripe',
      event_id: 'evt_sub_updated',
      event_type: 'customer.subscription.updated',
    });

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const enqueueArgs = enqueueMock.mock.calls[0]!;
    expect(enqueueArgs[0]).toBe(QUEUE_NAMES.stripeSubscriptionLifecycle);
    expect(enqueueArgs[1]).toEqual({ sync_event_id: 'sync-evt-1' });
    // singletonKey set for subscription queue to enforce per-customer FIFO
    expect(enqueueArgs[2]).toEqual({ singletonKey: 'cus_abc' });
  });

  it('returns 200 + duplicate:true and skips enqueue when sync_events dedups', async () => {
    constructEventMock.mockReturnValue({
      id: 'evt_replay',
      type: 'invoice.payment_failed',
      data: { object: { customer: 'cus_xyz' } },
    });
    queueForStripeEventMock.mockReturnValue(
      QUEUE_NAMES.stripeInvoicePayment,
    );
    // insertReceivedEvent returns null on UNIQUE constraint hit
    insertReceivedEventMock.mockResolvedValue(null);

    const res = await POST(
      buildRequest('{}', { 'stripe-signature': 'ok' }) as never,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.duplicate).toBe(true);
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
