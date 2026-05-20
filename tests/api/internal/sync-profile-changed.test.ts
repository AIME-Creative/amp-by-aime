/**
 * AIME-15: tests for the internal sync-profile-changed receiver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
process.env.INTERNAL_SYNC_SECRET = 'test-shared-secret';
process.env.SYNC_DB_URL = 'postgres://test/test';

const mocks = vi.hoisted(() => ({
  insertReceivedEventMock: vi.fn(),
  enqueueMock: vi.fn(),
  QUEUE_NAMES: {
    appProfileGhlUpsert: 'sync.app.profile-ghl-upsert',
    stripeSubscriptionLifecycle: 'sync.stripe.subscription-lifecycle',
    stripeInvoicePayment: 'sync.stripe.invoice-payment',
    stripeChargeRefund: 'sync.stripe.charge-refund',
  },
}));

vi.mock('@/lib/sync', () => ({
  getSupabaseAdmin: () => ({}),
  insertReceivedEvent: mocks.insertReceivedEventMock,
  enqueue: mocks.enqueueMock,
  QUEUE_NAMES: mocks.QUEUE_NAMES,
}));

import { POST } from '@/app/api/internal/sync-profile-changed/route';

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://staging.example/api/internal/sync-profile-changed', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.insertReceivedEventMock.mockReset();
  mocks.enqueueMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sync-profile-changed receiver', () => {
  it('rejects requests without the shared secret header', async () => {
    const res = await POST(
      makeRequest({ event_id: 'e', op: 'UPDATE', profile_id: 'p1' }) as never,
    );
    expect(res.status).toBe(401);
    expect(mocks.insertReceivedEventMock).not.toHaveBeenCalled();
  });

  it('rejects requests with the wrong shared secret', async () => {
    const res = await POST(
      makeRequest(
        { event_id: 'e', op: 'UPDATE', profile_id: 'p1' },
        { 'x-internal-sync-secret': 'wrong' },
      ) as never,
    );
    expect(res.status).toBe(401);
  });

  it('rejects payloads missing required fields', async () => {
    const res = await POST(
      makeRequest(
        { event_id: 'e', op: 'UPDATE' },
        { 'x-internal-sync-secret': 'test-shared-secret' },
      ) as never,
    );
    expect(res.status).toBe(400);
  });

  it('rejects invalid op values', async () => {
    const res = await POST(
      makeRequest(
        { event_id: 'e', op: 'DELETE', profile_id: 'p1' },
        { 'x-internal-sync-secret': 'test-shared-secret' },
      ) as never,
    );
    expect(res.status).toBe(400);
  });

  it('happy path: inserts sync_event + enqueues with singletonKey=profile_id', async () => {
    mocks.insertReceivedEventMock.mockResolvedValue({ id: 'sync-evt-1' });
    mocks.enqueueMock.mockResolvedValue('job-1');

    const res = await POST(
      makeRequest(
        { event_id: 'evt-uuid', op: 'UPDATE', profile_id: 'profile-uuid' },
        { 'x-internal-sync-secret': 'test-shared-secret' },
      ) as never,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.received).toBe(true);
    expect(json.sync_event_id).toBe('sync-evt-1');

    expect(mocks.insertReceivedEventMock).toHaveBeenCalledTimes(1);
    const insertArgs = mocks.insertReceivedEventMock.mock.calls[0]![1];
    expect(insertArgs).toMatchObject({
      source: 'app',
      event_id: 'evt-uuid',
      event_type: 'profile.upsert',
      payload: { op: 'UPDATE', profile_id: 'profile-uuid' },
    });

    expect(mocks.enqueueMock).toHaveBeenCalledTimes(1);
    const [queue, data, opts] = mocks.enqueueMock.mock.calls[0]!;
    expect(queue).toBe('sync.app.profile-ghl-upsert');
    expect(data).toEqual({ sync_event_id: 'sync-evt-1' });
    expect(opts).toEqual({ singletonKey: 'profile-uuid' });
  });

  it('dedup: returns 200 + duplicate=true without enqueueing', async () => {
    mocks.insertReceivedEventMock.mockResolvedValue(null); // UNIQUE conflict
    const res = await POST(
      makeRequest(
        { event_id: 'replay', op: 'INSERT', profile_id: 'p1' },
        { 'x-internal-sync-secret': 'test-shared-secret' },
      ) as never,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.duplicate).toBe(true);
    expect(mocks.enqueueMock).not.toHaveBeenCalled();
  });
});
