/**
 * Admin Fuse Stripe builder — guest pricing through planGuestPricing.
 *
 * Confirms that every paid guest (member or no-tier) charges the static
 * `guest_ticket` catalog price via the pre-made Stripe Price id, and
 * that the VIP first-guest-included entitlement is honored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// -----------------------------------------------------------------
// Env stubs — set before importing the route.
// -----------------------------------------------------------------
process.env.STRIPE_SECRET_KEY = 'sk_test_admin_pricing'
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'

// -----------------------------------------------------------------
// Stripe mock — capture line_items passed to checkout.sessions.create.
// -----------------------------------------------------------------
const sessionCreateMock = vi.fn(async () => ({
  id: 'cs_test',
  url: 'https://checkout.stripe.com/test',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
}))
vi.mock('stripe', () => {
  function FakeStripe(this: any) {
    this.checkout = { sessions: { create: sessionCreateMock } }
  }
  return { default: FakeStripe }
})

// -----------------------------------------------------------------
// Supabase mock — chainable builder + table-keyed reads.
// -----------------------------------------------------------------
let tableReads = new Map<string, any>()

function makeReadChain(table: string) {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    or: () => chain,
    order: () => chain,
    limit: () => chain,
    is: () => chain,
    single: () => {
      const value = tableReads.get(table)
      // `.single()` on a list returns the first row; on a scalar returns the row.
      const row = Array.isArray(value) ? value[0] ?? null : value ?? null
      return Promise.resolve({ data: row, error: null })
    },
    then: (onFulfilled: any) => {
      const value = tableReads.get(table)
      return Promise.resolve({ data: value ?? null, error: null }).then(onFulfilled)
    },
  }
  return chain
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'admin_user_id' } } }),
    },
    from: (table: string) => makeReadChain(table),
  })),
}))

// -----------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------
async function callAdminCheckout(body: any) {
  const { POST } = await import(
    '@/app/api/admin/fuse-registrations/stripe/route'
  )
  const req = new Request('http://localhost/api/admin/fuse-registrations/stripe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return POST(req as any)
}

const GUEST_TICKET_PRICE_ID = 'price_guest_ticket_test'

beforeEach(() => {
  tableReads = new Map()
  sessionCreateMock.mockClear()
})
afterEach(() => {
  vi.clearAllMocks()
})

// =================================================================
// Test 1 — Premium member, 1 paid guest. Guest must charge against
// the static guest_ticket Stripe Price id, not an ad-hoc price_data.
// =================================================================
describe('admin Fuse Stripe builder — guest pricing', () => {
  it('uses the static guest_ticket price id for a Premium-linked guest', async () => {
    tableReads.set('profiles', { is_admin: true })
    tableReads.set('fuse_registrations', {
      id: 'reg_premium',
      email: 'premium@test.com',
      full_name: 'Pat Premium',
      fuse_event_id: 'event_test',
      tier: 'Premium',
      ticket_type: 'general_admission',
      purchase_type: 'claimed',
      has_hall_of_aime: false,
      guests: [
        {
          id: 'g1',
          full_name: 'Guest One',
          ticket_type: 'general_admission',
          is_included: false,
          has_hall_of_aime: false,
        },
      ],
    })
    tableReads.set('fuse_ticket_prices', [
      {
        product_key: 'guest_ticket',
        tier: null,
        pricing_phase: 'regular',
        price: 350,
        phase_end_at: null,
        is_active: true,
        is_included: false,
        stripe_price_id: GUEST_TICKET_PRICE_ID,
      },
    ])
    tableReads.set('fuse_events', { year: 2026 })

    const res = await callAdminCheckout({
      action: 'checkout',
      registration_id: 'reg_premium',
    })
    expect(res.status).toBe(200)
    expect(sessionCreateMock).toHaveBeenCalledTimes(1)

    const line_items = (sessionCreateMock.mock.calls[0] as any)[0].line_items as any[]
    expect(line_items).toHaveLength(1)
    expect(line_items[0].price).toBe(GUEST_TICKET_PRICE_ID)
    expect(line_items[0].quantity).toBe(1)
    // No ad-hoc tier-discounted price_data anymore.
    expect(line_items[0].price_data).toBeUndefined()
  })

  // ===============================================================
  // Test 2 — VIP claim, 2 guests. First guest is the VIP-included
  // slot (free, no line item). Second guest charged the static
  // guest_ticket price.
  // ===============================================================
  it('skips VIP first guest (included) and charges second guest the static guest_ticket price', async () => {
    tableReads.set('profiles', { is_admin: true })
    tableReads.set('fuse_registrations', {
      id: 'reg_vip',
      email: 'vip@test.com',
      full_name: 'Val VIP',
      fuse_event_id: 'event_test',
      tier: 'VIP',
      ticket_type: 'vip',
      purchase_type: 'claimed',
      has_hall_of_aime: true,
      guests: [
        {
          id: 'g1',
          full_name: 'Free Guest',
          ticket_type: 'vip_guest',
          is_included: true,
          has_hall_of_aime: false,
        },
        {
          id: 'g2',
          full_name: 'Paid Guest',
          ticket_type: 'general_admission',
          is_included: false,
          has_hall_of_aime: false,
        },
      ],
    })
    tableReads.set('fuse_ticket_prices', [
      {
        product_key: 'guest_ticket',
        tier: null,
        pricing_phase: 'regular',
        price: 350,
        phase_end_at: null,
        is_active: true,
        is_included: false,
        stripe_price_id: GUEST_TICKET_PRICE_ID,
      },
      // VIP membership HOA is free — leaving HOA stripe_price_id absent
      // so the main-HOA branch is a no-op. (VIP-claim main HOA is
      // already skipped via mainHoaIsFree.)
    ])
    tableReads.set('fuse_events', { year: 2026 })

    const res = await callAdminCheckout({
      action: 'checkout',
      registration_id: 'reg_vip',
    })
    expect(res.status).toBe(200)

    const line_items = (sessionCreateMock.mock.calls[0] as any)[0].line_items as any[]
    // Exactly one paid guest line — first guest is VIP-included.
    expect(line_items).toHaveLength(1)
    expect(line_items[0].price).toBe(GUEST_TICKET_PRICE_ID)
    expect(line_items[0].quantity).toBe(1)
    expect(line_items[0].price_data).toBeUndefined()
  })
})
