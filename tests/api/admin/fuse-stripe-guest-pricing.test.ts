/**
 * Admin Fuse Stripe builder — guest pricing through planGuestPricing.
 *
 * Confirms that member-linked admin registrations charge guest tickets
 * at the spec'd member rate (Premium 10% / Elite 20% / VIP 30% off
 * regular GA) via Stripe `price_data` ad-hoc lines, not the public
 * `guest` Stripe Price.
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

beforeEach(() => {
  tableReads = new Map()
  sessionCreateMock.mockClear()
})
afterEach(() => {
  vi.clearAllMocks()
})

// =================================================================
// Test 1 — Premium member, 1 paid guest. Guest must charge at the
// 10%-off regular-GA member rate via price_data, NOT the public guest
// Stripe Price.
//
// Regular GA = $1299. Premium rate = $1299 * 0.90 = $1169.10
// → 116910 cents per guest.
// =================================================================
describe('admin Fuse Stripe builder — guest pricing', () => {
  it('uses member-rate price_data for a Premium-linked guest (10% off regular GA)', async () => {
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
      // Regular GA — the base for the discount math.
      {
        product_key: 'ga',
        tier: null,
        pricing_phase: 'regular',
        price: 1299,
        phase_end_at: null,
        is_active: true,
        is_included: false,
        stripe_price_id: 'price_ga_regular',
      },
    ])
    tableReads.set('fuse_guest_pricing_rules', [
      { tier: 'Premium', base_product_key: 'ga', discount_percent: 10 },
      { tier: 'Elite', base_product_key: 'ga', discount_percent: 20 },
      { tier: 'VIP', base_product_key: 'ga', discount_percent: 30 },
    ])
    tableReads.set('fuse_events', { year: 2026 })

    const res = await callAdminCheckout({
      action: 'checkout',
      registration_id: 'reg_premium',
    })
    expect(res.status).toBe(200)
    expect(sessionCreateMock).toHaveBeenCalledTimes(1)

    const line_items = (sessionCreateMock.mock.calls[0] as any)[0].line_items as any[]
    // Exactly one guest line for this scenario (claimed VIP/GA main is free,
    // no HOA on main, one paid guest).
    const guestLines = line_items.filter(
      (li) =>
        li.price_data?.product_data?.name?.toLowerCase().includes('guest'),
    )
    expect(guestLines).toHaveLength(1)
    expect(guestLines[0].price_data.unit_amount).toBe(116910) // 1299 * 0.90 * 100
    expect(guestLines[0].quantity).toBe(1)
    // Critical: it's NOT pointing at a pre-made `guest` Stripe Price ID.
    expect(guestLines[0].price).toBeUndefined()
  })

  // ===============================================================
  // Test 2 — VIP claim, 2 guests. First guest is the VIP-included
  // slot (free, no line item). Second guest charged at VIP 30% off.
  //
  // VIP rate = $1299 * 0.70 = $909.30 → 90930 cents.
  // ===============================================================
  it('skips VIP first guest (included) and charges second guest at VIP 30% off', async () => {
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
        product_key: 'ga',
        tier: null,
        pricing_phase: 'regular',
        price: 1299,
        phase_end_at: null,
        is_active: true,
        is_included: false,
        stripe_price_id: 'price_ga_regular',
      },
      // VIP membership HOA is free — leaving HOA stripe_price_id absent
      // so the main-HOA branch is a no-op. (VIP-claim main HOA is
      // already skipped via mainHoaIsFree.)
    ])
    tableReads.set('fuse_guest_pricing_rules', [
      { tier: 'Premium', base_product_key: 'ga', discount_percent: 10 },
      { tier: 'Elite', base_product_key: 'ga', discount_percent: 20 },
      { tier: 'VIP', base_product_key: 'ga', discount_percent: 30 },
    ])
    tableReads.set('fuse_events', { year: 2026 })

    const res = await callAdminCheckout({
      action: 'checkout',
      registration_id: 'reg_vip',
    })
    expect(res.status).toBe(200)

    const line_items = (sessionCreateMock.mock.calls[0] as any)[0].line_items as any[]
    const guestLines = line_items.filter(
      (li) =>
        li.price_data?.product_data?.name?.toLowerCase().includes('guest'),
    )
    // Exactly one paid guest line — the first guest is VIP-included.
    expect(guestLines).toHaveLength(1)
    expect(guestLines[0].quantity).toBe(1)
    expect(guestLines[0].price_data.unit_amount).toBe(90930) // 1299 * 0.70 * 100
    // The product label should reflect the VIP member rate so the
    // receipt isn't misleading.
    expect(guestLines[0].price_data.product_data.name).toMatch(/VIP/i)
  })
})
