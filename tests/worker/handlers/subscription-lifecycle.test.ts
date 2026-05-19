/**
 * AIME-14: subscription-lifecycle handler tests.
 *
 * Covers customer.subscription.created/updated/deleted across:
 *   - happy path (state updates correctly, sync_events marked processed)
 *   - replay (already-processed event is a no-op)
 *   - failure (Stripe API throws → markFailed called + handler rethrows)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.STRIPE_SECRET_KEY = 'sk_test_sub_handler';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
process.env.SYNC_DB_URL = 'postgres://test/test';

const mocks = vi.hoisted(() => ({
  // Mock Stripe client
  subscriptionsRetrieve: vi.fn(),
  subscriptionsList: vi.fn(),
  // Mock sync helpers from lib/sync
  getEventByIdMock: vi.fn(),
  markProcessingMock: vi.fn().mockResolvedValue(undefined),
  markProcessedMock: vi.fn().mockResolvedValue(undefined),
  markFailedMock: vi.fn().mockResolvedValue(undefined),
  // Will be set per test to a MockDb client
  getSupabaseAdminMock: vi.fn(),
  // Mock fetch (notification email — non-fatal in handler)
  fetchMock: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('@/lib/stripe/config', () => ({
  stripe: {
    subscriptions: {
      retrieve: mocks.subscriptionsRetrieve,
      list: mocks.subscriptionsList,
    },
  },
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

// Replace global fetch so notify.ts doesn't actually hit the network.
globalThis.fetch = mocks.fetchMock as unknown as typeof fetch;

import { makeMockDb, syncEventRow } from './_helpers';
import { handleSubscriptionLifecycle } from '@/worker/handlers/subscription-lifecycle';

beforeEach(() => {
  for (const m of Object.values(mocks)) {
    if (typeof (m as { mockReset?: unknown }).mockReset === 'function') {
      (m as { mockReset: () => void }).mockReset();
    }
  }
  mocks.markProcessingMock.mockResolvedValue(undefined);
  mocks.markProcessedMock.mockResolvedValue(undefined);
  mocks.markFailedMock.mockResolvedValue(undefined);
  mocks.fetchMock.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('subscription-lifecycle handler', () => {
  it('happy path: customer.subscription.updated upgrades plan_tier + clears past_due', async () => {
    const db = makeMockDb();
    mocks.getSupabaseAdminMock.mockReturnValue(db.client);

    // Seed: profile lookup returns the test row; duplicate-check on
    // profiles returns null (no other profile owns sub_new).
    db.setReads('profiles', [
      {
        id: 'p1',
        email: 'user@example.com',
        full_name: 'Test User',
        plan_tier: 'Premium',
        stripe_subscription_id: 'sub_old',
        subscription_override: false,
        pending_plan_tier: null,
        pending_plan_price_id: null,
        payment_failed_at: null,
      },
      null, // detectSubscriptionDuplicate
    ]);
    db.setRead('subscription_plans', { plan_tier: 'Elite' });

    const stripeEvent = {
      type: 'customer.subscription.updated',
      data: {
        object: { id: 'sub_new', customer: 'cus_1' },
      },
    };
    mocks.getEventByIdMock.mockResolvedValue(
      syncEventRow({ event_type: stripeEvent.type, payload: stripeEvent }),
    );
    mocks.subscriptionsRetrieve.mockResolvedValue({
      id: 'sub_new',
      customer: 'cus_1',
      status: 'active',
      cancel_at_period_end: false,
      items: {
        data: [
          {
            price: {
              id: 'price_elite_monthly',
              recurring: { interval: 'month' },
              unit_amount: 6999,
            },
          },
        ],
      },
      metadata: {},
    });

    await handleSubscriptionLifecycle([
      { id: 'job1', data: { sync_event_id: 'sync-evt-1' } } as never,
    ]);

    // Profile UPDATE should have flipped plan_tier to Elite and not be a duplicate.
    const profileUpdate = db.updates.find((u) => u.table === 'profiles');
    expect(profileUpdate).toBeDefined();
    expect(profileUpdate!.updates).toMatchObject({
      plan_tier: 'Elite',
      subscription_status: 'active',
      stripe_subscription_status: 'active',
      stripe_subscription_id: 'sub_new',
      billing_period: 'Monthly',
      payment_amount: 69.99,
      payment_failed_at: null,
    });
    // Tier-change side effects: RPC call + email
    expect(db.rpcCalls.some((r) => r.fn === 'track_subscription_conversion')).toBe(true);
    expect(mocks.fetchMock).toHaveBeenCalled();
    // sync_events marked processed
    expect(mocks.markProcessedMock).toHaveBeenCalledWith(
      db.client,
      'sync-evt-1',
      expect.objectContaining({ plan_tier: 'Elite', overrode: false }),
    );
  });

  it('happy path: customer.subscription.deleted with no fallback sub → Canceled', async () => {
    const db = makeMockDb();
    mocks.getSupabaseAdminMock.mockReturnValue(db.client);

    db.setRead('profiles', {
      id: 'p2',
      email: 'user2@example.com',
      full_name: 'User Two',
      plan_tier: 'Elite',
      stripe_subscription_id: 'sub_old',
      subscription_override: false,
      pending_plan_tier: null,
      pending_plan_price_id: null,
      payment_failed_at: null,
    });

    const stripeEvent = {
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_old', customer: 'cus_2' } },
    };
    mocks.getEventByIdMock.mockResolvedValue(
      syncEventRow({ event_type: stripeEvent.type, payload: stripeEvent }),
    );
    mocks.subscriptionsList.mockResolvedValue({ data: [] });

    await handleSubscriptionLifecycle([
      { id: 'job2', data: { sync_event_id: 'sync-evt-2' } } as never,
    ]);

    const profileUpdate = db.updates.find((u) => u.table === 'profiles');
    expect(profileUpdate).toBeDefined();
    expect(profileUpdate!.updates).toMatchObject({
      plan_tier: 'Canceled',
      stripe_subscription_id: null,
      subscription_status: 'canceled',
      escalations_remaining: 0,
    });
    expect(db.rpcCalls.some((r) => r.fn === 'track_subscription_conversion')).toBe(true);
    expect(mocks.markProcessedMock).toHaveBeenCalled();
  });

  it('subscription_override: only stripe_subscription_id is synced, tier left alone', async () => {
    const db = makeMockDb();
    mocks.getSupabaseAdminMock.mockReturnValue(db.client);

    db.setReads('profiles', [
      {
        id: 'p3',
        email: 'override@example.com',
        full_name: 'Override User',
        plan_tier: 'VIP',
        stripe_subscription_id: 'sub_a',
        subscription_override: true, // <-- the gate
        pending_plan_tier: null,
        pending_plan_price_id: null,
        payment_failed_at: null,
      },
      null, // dup-check inside mutateOverrideOnly
    ]);

    const stripeEvent = {
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_b', customer: 'cus_3' } },
    };
    mocks.getEventByIdMock.mockResolvedValue(
      syncEventRow({ event_type: stripeEvent.type, payload: stripeEvent }),
    );
    mocks.subscriptionsRetrieve.mockResolvedValue({
      id: 'sub_b',
      customer: 'cus_3',
      status: 'canceled', // would normally demote, but override blocks
      cancel_at_period_end: false,
      items: { data: [{ price: { id: 'price_x' } }] },
      metadata: {},
    });

    await handleSubscriptionLifecycle([
      { id: 'job3', data: { sync_event_id: 'sync-evt-3' } } as never,
    ]);

    const profileUpdate = db.updates.find((u) => u.table === 'profiles');
    expect(profileUpdate).toBeDefined();
    expect(profileUpdate!.updates).toEqual({
      stripe_subscription_id: 'sub_b',
      updated_at: expect.any(String),
    });
    // No tier change, no RPC, no notification.
    expect(db.rpcCalls.length).toBe(0);
  });

  it('replay: sync_events row already status=processed → handler is a no-op', async () => {
    const db = makeMockDb();
    mocks.getSupabaseAdminMock.mockReturnValue(db.client);

    mocks.getEventByIdMock.mockResolvedValue(
      syncEventRow({
        event_type: 'customer.subscription.updated',
        payload: { type: 'customer.subscription.updated', data: { object: {} } },
        status: 'processed',
      }),
    );

    await handleSubscriptionLifecycle([
      { id: 'jobR', data: { sync_event_id: 'sync-evt-R' } } as never,
    ]);

    // No Stripe call, no markProcessing, no profile update.
    expect(mocks.subscriptionsRetrieve).not.toHaveBeenCalled();
    expect(mocks.markProcessingMock).not.toHaveBeenCalled();
    expect(db.updates.length).toBe(0);
  });

  it('failure: Stripe API throws → markFailed called and handler rethrows', async () => {
    const db = makeMockDb();
    mocks.getSupabaseAdminMock.mockReturnValue(db.client);

    mocks.getEventByIdMock.mockResolvedValue(
      syncEventRow({
        event_type: 'customer.subscription.updated',
        payload: {
          type: 'customer.subscription.updated',
          data: { object: { id: 'sub_x', customer: 'cus_x' } },
        },
      }),
    );
    mocks.subscriptionsRetrieve.mockRejectedValue(new Error('stripe upstream down'));

    await expect(
      handleSubscriptionLifecycle([
        { id: 'jobF', data: { sync_event_id: 'sync-evt-F' } } as never,
      ]),
    ).rejects.toThrow(/stripe upstream down/);
    expect(mocks.markFailedMock).toHaveBeenCalledWith(
      db.client,
      'sync-evt-F',
      expect.stringContaining('stripe upstream down'),
    );
  });
});
