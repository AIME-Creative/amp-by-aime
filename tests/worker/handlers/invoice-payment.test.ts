/**
 * AIME-14: invoice-payment handler tests.
 *
 * Covers invoice.payment_failed / invoice.payment_succeeded / invoice.paid
 * across happy / replay / failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.STRIPE_SECRET_KEY = 'sk_test_invoice_handler';
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
import { handleInvoicePayment } from '@/worker/handlers/invoice-payment';

const baseProfile = {
  id: 'p1',
  email: 'invoice@example.com',
  full_name: 'Invoice User',
  plan_tier: 'Premium',
  stripe_subscription_id: 'sub_1',
  subscription_override: false,
  pending_plan_tier: null,
  pending_plan_price_id: null,
  payment_failed_at: null,
};

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

describe('invoice-payment handler', () => {
  it('invoice.payment_failed → sets past_due + payment_failed_at on first failure', async () => {
    const db = makeMockDb();
    mocks.getSupabaseAdminMock.mockReturnValue(db.client);
    db.setRead('profiles', { ...baseProfile, payment_failed_at: null });

    mocks.getEventByIdMock.mockResolvedValue(
      syncEventRow({
        event_type: 'invoice.payment_failed',
        payload: {
          type: 'invoice.payment_failed',
          data: {
            object: {
              id: 'in_1',
              customer: 'cus_1',
              subscription: 'sub_1',
            },
          },
        },
      }),
    );

    await handleInvoicePayment([
      { id: 'job1', data: { sync_event_id: 'sync-evt-1' } } as never,
    ]);

    const update = db.updates.find((u) => u.table === 'profiles');
    expect(update).toBeDefined();
    expect(update!.updates).toMatchObject({
      subscription_status: 'past_due',
      stripe_subscription_status: 'past_due',
    });
    expect(update!.updates.payment_failed_at).toBeTruthy();
    expect(mocks.markProcessedMock).toHaveBeenCalled();
  });

  it('invoice.payment_failed when payment_failed_at already set → keeps original timestamp', async () => {
    const db = makeMockDb();
    mocks.getSupabaseAdminMock.mockReturnValue(db.client);
    db.setRead('profiles', {
      ...baseProfile,
      payment_failed_at: '2026-05-01T00:00:00Z',
    });

    mocks.getEventByIdMock.mockResolvedValue(
      syncEventRow({
        event_type: 'invoice.payment_failed',
        payload: {
          type: 'invoice.payment_failed',
          data: { object: { id: 'in_2', customer: 'cus_1', subscription: 'sub_1' } },
        },
      }),
    );

    await handleInvoicePayment([
      { id: 'job2', data: { sync_event_id: 'sync-evt-2' } } as never,
    ]);

    const update = db.updates.find((u) => u.table === 'profiles');
    expect(update!.updates.payment_failed_at).toBeUndefined();
  });

  it('invoice.payment_succeeded → clears payment_failed_at + restores active', async () => {
    const db = makeMockDb();
    mocks.getSupabaseAdminMock.mockReturnValue(db.client);
    db.setRead('profiles', {
      ...baseProfile,
      payment_failed_at: '2026-05-10T00:00:00Z',
    });

    mocks.getEventByIdMock.mockResolvedValue(
      syncEventRow({
        event_type: 'invoice.payment_succeeded',
        payload: {
          type: 'invoice.payment_succeeded',
          data: { object: { id: 'in_3', customer: 'cus_1', subscription: 'sub_1' } },
        },
      }),
    );

    await handleInvoicePayment([
      { id: 'job3', data: { sync_event_id: 'sync-evt-3' } } as never,
    ]);

    const update = db.updates.find((u) => u.table === 'profiles');
    expect(update!.updates).toMatchObject({
      subscription_status: 'active',
      stripe_subscription_status: 'active',
      payment_failed_at: null,
    });
  });

  it('subscription_override → skips status change', async () => {
    const db = makeMockDb();
    mocks.getSupabaseAdminMock.mockReturnValue(db.client);
    db.setRead('profiles', { ...baseProfile, subscription_override: true });

    mocks.getEventByIdMock.mockResolvedValue(
      syncEventRow({
        event_type: 'invoice.payment_failed',
        payload: {
          type: 'invoice.payment_failed',
          data: { object: { id: 'in_4', customer: 'cus_1', subscription: 'sub_1' } },
        },
      }),
    );

    await handleInvoicePayment([
      { id: 'job4', data: { sync_event_id: 'sync-evt-4' } } as never,
    ]);

    expect(db.updates.length).toBe(0);
    expect(mocks.markProcessedMock).toHaveBeenCalledWith(
      db.client,
      'sync-evt-4',
      expect.objectContaining({ skipped: 'override_blocks_status_change' }),
    );
  });

  it('non-subscription invoice → skipped with explanation', async () => {
    const db = makeMockDb();
    mocks.getSupabaseAdminMock.mockReturnValue(db.client);

    mocks.getEventByIdMock.mockResolvedValue(
      syncEventRow({
        event_type: 'invoice.paid',
        payload: {
          type: 'invoice.paid',
          data: { object: { id: 'in_5', customer: 'cus_1' } }, // no subscription
        },
      }),
    );

    await handleInvoicePayment([
      { id: 'job5', data: { sync_event_id: 'sync-evt-5' } } as never,
    ]);

    expect(db.updates.length).toBe(0);
    expect(mocks.markProcessedMock).toHaveBeenCalledWith(
      db.client,
      'sync-evt-5',
      expect.objectContaining({ skipped: 'non_subscription_invoice' }),
    );
  });

  it('replay: status=processed event is a no-op', async () => {
    const db = makeMockDb();
    mocks.getSupabaseAdminMock.mockReturnValue(db.client);

    mocks.getEventByIdMock.mockResolvedValue(
      syncEventRow({
        event_type: 'invoice.payment_failed',
        payload: {
          type: 'invoice.payment_failed',
          data: { object: { id: 'in_r', customer: 'cus_1', subscription: 'sub_1' } },
        },
        status: 'processed',
      }),
    );

    await handleInvoicePayment([
      { id: 'jobR', data: { sync_event_id: 'sync-evt-R' } } as never,
    ]);

    expect(mocks.markProcessingMock).not.toHaveBeenCalled();
    expect(db.updates.length).toBe(0);
  });

  it('failure: unexpected event type → markFailed + rethrow', async () => {
    const db = makeMockDb();
    mocks.getSupabaseAdminMock.mockReturnValue(db.client);

    mocks.getEventByIdMock.mockResolvedValue(
      syncEventRow({
        event_type: 'customer.created',
        payload: { type: 'customer.created', data: { object: {} } },
      }),
    );

    await expect(
      handleInvoicePayment([
        { id: 'jobF', data: { sync_event_id: 'sync-evt-F' } } as never,
      ]),
    ).rejects.toThrow(/unexpected event type/);
    expect(mocks.markFailedMock).toHaveBeenCalled();
  });
});
