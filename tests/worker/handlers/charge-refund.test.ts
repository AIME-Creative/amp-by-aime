/**
 * AIME-14: charge-refund handler tests.
 *
 * The handler is intentionally log-only — it mutates nothing on
 * profiles. Tests verify: outcome is captured in sync_events with the
 * refund details, no profile updates happen, replay is a no-op,
 * unexpected event types fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.STRIPE_SECRET_KEY = 'sk_test_refund';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
process.env.SYNC_DB_URL = 'postgres://test/test';

const mocks = vi.hoisted(() => ({
  getEventByIdMock: vi.fn(),
  markProcessingMock: vi.fn().mockResolvedValue(undefined),
  markProcessedMock: vi.fn().mockResolvedValue(undefined),
  markFailedMock: vi.fn().mockResolvedValue(undefined),
  getSupabaseAdminMock: vi.fn(),
}));

vi.mock('@/lib/sync', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/sync')>();
  return {
    ...orig,
    getEventById: mocks.getEventByIdMock,
    markProcessing: mocks.markProcessingMock,
    markProcessed: mocks.markProcessedMock,
    markFailed: mocks.markFailedMock,
    getSupabaseAdmin: mocks.getSupabaseAdminMock,
  };
});

import { makeMockDb, syncEventRow } from './_helpers';
import { handleChargeRefund } from '@/worker/handlers/charge-refund';

beforeEach(() => {
  for (const m of Object.values(mocks)) {
    if (typeof (m as { mockReset?: unknown }).mockReset === 'function') {
      (m as { mockReset: () => void }).mockReset();
    }
  }
  mocks.markProcessingMock.mockResolvedValue(undefined);
  mocks.markProcessedMock.mockResolvedValue(undefined);
  mocks.markFailedMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('charge-refund handler (log-only)', () => {
  it('happy path: writes refund details to outcome, no profile mutation', async () => {
    const db = makeMockDb();
    mocks.getSupabaseAdminMock.mockReturnValue(db.client);

    mocks.getEventByIdMock.mockResolvedValue(
      syncEventRow({
        event_type: 'charge.refunded',
        payload: {
          type: 'charge.refunded',
          data: {
            object: {
              id: 'ch_1',
              customer: 'cus_1',
              amount_refunded: 6999,
              currency: 'usd',
              refunds: {
                data: [{ reason: 'requested_by_customer' }],
              },
            },
          },
        },
      }),
    );

    await handleChargeRefund([
      { id: 'job1', data: { sync_event_id: 'sync-evt-1' } } as never,
    ]);

    expect(db.updates.length).toBe(0); // no profile mutation
    expect(mocks.markProcessedMock).toHaveBeenCalledWith(
      db.client,
      'sync-evt-1',
      expect.objectContaining({
        mode: 'log_only',
        charge_id: 'ch_1',
        customer: 'cus_1',
        amount_refunded: 6999,
        reason: 'requested_by_customer',
        currency: 'usd',
      }),
    );
  });

  it('replay: status=processed event is a no-op', async () => {
    const db = makeMockDb();
    mocks.getSupabaseAdminMock.mockReturnValue(db.client);

    mocks.getEventByIdMock.mockResolvedValue(
      syncEventRow({
        event_type: 'charge.refunded',
        payload: { type: 'charge.refunded', data: { object: { id: 'ch_r' } } },
        status: 'processed',
      }),
    );

    await handleChargeRefund([
      { id: 'jobR', data: { sync_event_id: 'sync-evt-R' } } as never,
    ]);

    expect(mocks.markProcessingMock).not.toHaveBeenCalled();
    expect(mocks.markProcessedMock).not.toHaveBeenCalled();
  });

  it('failure: unexpected event type → markFailed + rethrow', async () => {
    const db = makeMockDb();
    mocks.getSupabaseAdminMock.mockReturnValue(db.client);

    mocks.getEventByIdMock.mockResolvedValue(
      syncEventRow({
        event_type: 'charge.succeeded',
        payload: { type: 'charge.succeeded', data: { object: {} } },
      }),
    );

    await expect(
      handleChargeRefund([
        { id: 'jobF', data: { sync_event_id: 'sync-evt-F' } } as never,
      ]),
    ).rejects.toThrow(/unexpected event type/);
    expect(mocks.markFailedMock).toHaveBeenCalled();
  });
});
