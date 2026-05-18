/**
 * Stripe reconciler — payment_intent.succeeded handler in
 * app/api/webhooks/stripe/route.ts. Closes the residual "PI succeeded
 * but our DB writes failed" gap.
 *
 * These tests exercise the route handler directly with mocked Stripe
 * signature verification and a mocked Supabase admin client. They
 * never hit Stripe or Postgres.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// -----------------------------------------------------------------
// Env stubs — set BEFORE importing the route, because lib/stripe/config
// throws at import time if STRIPE_SECRET_KEY is missing.
// -----------------------------------------------------------------
process.env.STRIPE_SECRET_KEY = 'sk_test_reconciler'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_reconciler'
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test'

// -----------------------------------------------------------------
// Stripe mock — replace lib/stripe/config so we can return any event
// from constructEvent without computing a real HMAC signature.
// -----------------------------------------------------------------
const constructEventMock = vi.fn()
vi.mock('@/lib/stripe/config', () => ({
  stripe: {
    webhooks: { constructEvent: constructEventMock },
    paymentIntents: { retrieve: vi.fn() },
    subscriptions: { retrieve: vi.fn() },
    customers: { retrieve: vi.fn() },
    paymentMethods: { retrieve: vi.fn() },
  },
}))

// -----------------------------------------------------------------
// Supabase mock — chainable query builder. Per-table reads return
// values from `tableReads`; updates land in `recordedUpdates`.
// -----------------------------------------------------------------
type TableRead = { row: Record<string, any> | null }
const tableReads = new Map<string, TableRead>()
let recordedUpdates: Array<{ table: string; updates: any; filters: any[] }> = []

// Update chain — thenable so it can be awaited at any link, and
// chainable so filters compose (.eq().is(), .eq().eq(), etc.).
// Recording happens lazily on the terminal `await`.
function makeUpdateChain(table: string, updates: any) {
  const filters: any[] = []
  const recordOnce = () => {
    recordedUpdates.push({ table, updates, filters: [...filters] })
    return { error: null }
  }
  const chain: any = {
    eq: (col: string, val: any) => {
      filters.push({ kind: 'eq', col, val })
      return chain
    },
    is: (col: string, val: any) => {
      filters.push({ kind: 'is', col, val })
      return chain
    },
    then: (onFulfilled: any, onRejected?: any) =>
      Promise.resolve(recordOnce()).then(onFulfilled, onRejected),
    catch: (onRejected: any) => Promise.resolve(recordOnce()).catch(onRejected),
  }
  return chain
}

// Read chain — .select().eq()...eq().single() returns the seeded row.
function makeReadChain(table: string) {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    or: () => chain,
    order: () => chain,
    limit: () => chain,
    single: () => {
      const read = tableReads.get(table)
      return Promise.resolve({ data: read?.row ?? null, error: null })
    },
  }
  return chain
}

function buildQueryBuilder(table: string) {
  const base: any = {
    ...makeReadChain(table),
    update: (updates: any) => makeUpdateChain(table, updates),
  }
  return base
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: (table: string) => buildQueryBuilder(table),
  })),
}))

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------
async function postEvent(event: any) {
  // Body content doesn't matter — constructEvent is mocked to return `event`.
  constructEventMock.mockReturnValueOnce(event)
  // Late import so the mocks above are in place before the route module
  // initializes its Stripe client / Supabase imports.
  const { POST } = await import('@/app/api/webhooks/stripe/route')
  const req = new Request('http://localhost/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'stripe-signature': 'fake' },
    body: '{}',
  })
  // Next's NextRequest is a thin wrapper over Request for our purposes.
  return POST(req as any)
}

function setTable(table: string, row: Record<string, any> | null) {
  tableReads.set(table, { row })
}

beforeEach(() => {
  tableReads.clear()
  recordedUpdates = []
  constructEventMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

// =================================================================
// Test 1 — finalize recovery: PI succeeded but the row is still 'claim'
// =================================================================
describe('payment_intent.succeeded reconciler', () => {
  it('promotes step_completed claim → finalized when a finalize PI lands', async () => {
    setTable('fuse_registrations', {
      id: 'reg_test_1',
      user_id: 'user_test_1',
      fuse_event_id: 'event_test_1',
      ticket_type: 'general_admission',
      purchase_type: 'purchased',
      step_completed: 'claim',
    })
    setTable('fuse_events', { year: 2026 })

    const res = await postEvent({
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_finalize_test',
          status: 'succeeded',
          amount: 19900,
          metadata: {
            type: 'fuse_claim_addon',
            source: 'finalize',
            registration_id: 'reg_test_1',
          },
        },
      },
    })
    expect(res.status).toBe(200)

    const regUpdate = recordedUpdates.find((u) => u.table === 'fuse_registrations')
    expect(regUpdate).toBeDefined()
    expect(regUpdate!.updates.step_completed).toBe('finalized')

    // profile claim-year backfill — gated by `.is('fuse_ticket_claimed_year', null)`
    const profileUpdate = recordedUpdates.find((u) => u.table === 'profiles')
    expect(profileUpdate).toBeDefined()
    expect(profileUpdate!.updates.fuse_ticket_claimed_year).toBe(2026)
    expect(
      profileUpdate!.filters.some(
        (f) => f.kind === 'is' && f.col === 'fuse_ticket_claimed_year' && f.val === null,
      ),
    ).toBe(true)
  })

  // ===============================================================
  // Test 2 — upgrade-to-ga-plus recovery: ticket_type + purchase_type drift
  // ===============================================================
  it('promotes ticket_type + purchase_type when an upgrade PI lands on a non-upgraded row', async () => {
    setTable('fuse_registrations', {
      id: 'reg_test_2',
      user_id: 'user_test_2',
      fuse_event_id: 'event_test_2',
      ticket_type: 'general_admission',
      purchase_type: 'claimed',
      step_completed: 'finalized',
    })
    setTable('fuse_events', { year: 2026 })

    const res = await postEvent({
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_upgrade_test',
          status: 'succeeded',
          amount: 119900,
          metadata: {
            type: 'fuse_claim_addon',
            source: 'upgrade-to-ga-plus',
            registration_id: 'reg_test_2',
          },
        },
      },
    })
    expect(res.status).toBe(200)

    const regUpdate = recordedUpdates.find((u) => u.table === 'fuse_registrations')
    expect(regUpdate).toBeDefined()
    expect(regUpdate!.updates.ticket_type).toBe('general_admission_plus')
    expect(regUpdate!.updates.purchase_type).toBe('upgraded')
    // step_completed wasn't claim, so it shouldn't be in the update
    expect(regUpdate!.updates.step_completed).toBeUndefined()
  })

  // ===============================================================
  // Test 3 — idempotent replay: row already finalized + upgraded → no write
  // ===============================================================
  it('is a no-op when the row is already reconciled (idempotent replay)', async () => {
    setTable('fuse_registrations', {
      id: 'reg_test_3',
      user_id: 'user_test_3',
      fuse_event_id: 'event_test_3',
      ticket_type: 'general_admission_plus',
      purchase_type: 'upgraded',
      step_completed: 'finalized',
    })
    setTable('fuse_events', { year: 2026 })

    const res = await postEvent({
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_replay_test',
          status: 'succeeded',
          amount: 119900,
          metadata: {
            type: 'fuse_claim_addon',
            source: 'upgrade-to-ga-plus',
            registration_id: 'reg_test_3',
          },
        },
      },
    })
    expect(res.status).toBe(200)

    // No registration update — every branch was a no-op.
    expect(
      recordedUpdates.find((u) => u.table === 'fuse_registrations'),
    ).toBeUndefined()

    // Profile update still attempted (it's gated by .is(null) so it
    // would no-op at the DB layer; we just verify we didn't write
    // a different year).
    const profileUpdate = recordedUpdates.find((u) => u.table === 'profiles')
    if (profileUpdate) {
      expect(profileUpdate.updates.fuse_ticket_claimed_year).toBe(2026)
    }
  })

  // ===============================================================
  // Bonus — non-Fuse PI is ignored
  // ===============================================================
  it('ignores PaymentIntents that are not tagged as Fuse', async () => {
    const res = await postEvent({
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_unrelated',
          status: 'succeeded',
          amount: 1000,
          metadata: { type: 'subscription_renewal' },
        },
      },
    })
    expect(res.status).toBe(200)
    expect(recordedUpdates).toHaveLength(0)
  })
})
