// Shared pricing helpers for Fuse ticket / add-on rows.
//
// The `fuse_ticket_prices` table can hold multiple rows per product (one
// `early_bird` and one `regular`, optionally with `phase_start_at` /
// `phase_end_at` windows). These helpers pick the single "active" row given
// the current time so the UI and API never render or charge against two
// rows at once.

export interface PriceRow {
  id: string
  product_key: string
  tier: string | null
  pricing_phase: string
  phase_start_at: string | null
  phase_end_at: string | null
  is_active?: boolean
  // Common optional columns on fuse_ticket_prices. Declared here so the
  // generic helpers preserve them in their return types when callers pass
  // loosely-typed (e.g. any[]) input.
  stripe_price_id?: string | null
  is_included?: boolean
  is_addon?: boolean
  price?: number
  label?: string
  description?: string | null
  gender_lock?: string | null
  sort_order?: number
}

export function isEarlyBirdActive(
  row: { phase_start_at: string | null; phase_end_at: string | null },
  now: Date = new Date(),
): boolean {
  const start = row.phase_start_at ? new Date(row.phase_start_at) : null
  const end = row.phase_end_at ? new Date(row.phase_end_at) : null
  if (!start && !end) return true
  if (start && end) return now >= start && now <= end
  if (start) return now >= start
  if (end) return now <= end
  return true
}

/**
 * Pick the active price row for a (productKey, tier) combination. Applies
 * the phase window to early-bird vs regular and returns the single row
 * that should be used right now. Returns null if no matching active row.
 */
export function pickActivePrice<T extends PriceRow>(
  prices: T[] | null | undefined,
  productKey: string,
  tier: string | null,
  now: Date = new Date(),
): T | null {
  if (!prices) return null
  const matches = prices.filter(
    (p) =>
      p.product_key === productKey &&
      (p.tier ?? null) === (tier ?? null) &&
      p.is_active !== false,
  )
  if (matches.length === 0) return null
  if (matches.length === 1) return matches[0]

  const earlyBird = matches.find((p) => p.pricing_phase === 'early_bird')
  const regular = matches.find((p) => p.pricing_phase === 'regular')

  if (earlyBird && isEarlyBirdActive(earlyBird, now)) return earlyBird
  if (regular) return regular
  return earlyBird ?? matches[0]
}

/**
 * Return one active price row per product for the given tier (or null for
 * public). Used to render a deduped product catalog without showing both
 * early-bird and regular variants side-by-side.
 */
export function pickActivePrices<T extends PriceRow>(
  prices: T[] | null | undefined,
  tier: string | null,
  now: Date = new Date(),
): T[] {
  if (!prices) return []
  const productKeys = Array.from(
    new Set(
      prices
        .filter(
          (p) => (p.tier ?? null) === (tier ?? null) && p.is_active !== false,
        )
        .map((p) => p.product_key),
    ),
  )
  return productKeys
    .map((key) => pickActivePrice(prices, key, tier, now))
    .filter((p): p is T => p !== null)
}

// ----------------------------------------------------------------
// Guest pricing plan: applies VIP first-guest-included entitlement
// and the static `guest_ticket` catalog price for every paid guest.
// Used by finalize, top-up, claim, and admin checkout so member and
// public flows stay consistent.
// ----------------------------------------------------------------

export interface GuestInsertRecord {
  full_name: string
  ticket_type: string
  is_included: boolean
  has_hall_of_aime: boolean
  has_wmn_at_fuse: boolean
  has_vetted_va: boolean
  has_vip_luncheon: boolean
}

export interface GuestStripeLineItem {
  /** Set when the line uses a pre-made Stripe Price object. */
  price?: string
  /** Set as a fallback when the catalog row has no stripe_price_id. */
  price_data?: {
    currency: 'usd'
    product_data: { name: string }
    unit_amount: number
  }
  quantity: number
}

export interface GuestDisplayLineItem {
  label: string
  /** 'included' renders as "Included", 0 renders as "Free", otherwise "$X.XX". */
  amountCents: number | 'included'
  /** Optional subtitle below the label (e.g., "Included with VIP membership"). */
  hint?: string
}

export interface GuestPricingPlan {
  guestsForInsert: GuestInsertRecord[]
  stripeLineItems: GuestStripeLineItem[]
  /** Sum of all chargeable guest amounts in cents. 0 for the included VIP slot. */
  totalCents: number
  /** Order-summary-ready rows, one per guest, in input order. */
  displayLineItems: GuestDisplayLineItem[]
}

/**
 * Build the insert records + Stripe line items for a batch of new guests
 * on a registration.
 *
 * Rules:
 *  - VIP: 1 included guest per registration (lifetime, not per-batch).
 *    Beyond that, the static `guest_ticket` catalog price applies.
 *  - Every other guest (member or public): static `guest_ticket` price.
 */
export interface GuestAddonFlags {
  has_hall_of_aime?: boolean
  has_wmn_at_fuse?: boolean
  has_vetted_va?: boolean
  has_vip_luncheon?: boolean
}

export function planGuestPricing<T extends PriceRow>(args: {
  tier: string | null
  prices: T[] | null | undefined
  /** Count of guests already on this registration with is_included = true. */
  existingIncludedCount: number
  /**
   * Count of existing guests already credited with the VIP free-HOA slot
   * (i.e. existing guests with has_hall_of_aime=true on a VIP
   * registration). The VIP entitlement is 2 free HOA per party: 1 for
   * the member (auto-set on claim), 1 spread across guests. Caller is
   * responsible for excluding the member's own HOA from this count.
   */
  existingGuestHoaIncludedCount?: number
  /**
   * New guests being added in this submission. `addons` are written to
   * the inserted row verbatim; the route is responsible for stripping
   * any addon the main attendee hasn't selected.
   */
  newGuests: Array<{
    full_name: string
    ticket_type?: string
    addons?: GuestAddonFlags
  }>
  /** Event label used in the Stripe ad-hoc product name. */
  eventLabel: string
}): GuestPricingPlan {
  const {
    tier,
    prices,
    existingIncludedCount,
    existingGuestHoaIncludedCount = 0,
    newGuests,
    eventLabel,
  } = args

  const guestsForInsert: GuestInsertRecord[] = []
  const stripeLineItems: GuestStripeLineItem[] = []
  const displayLineItems: GuestDisplayLineItem[] = []
  let totalCents = 0

  // VIP first-guest-included entitlement: only the first VIP-tier guest
  // (across all submissions) gets is_included = true.
  let vipIncludedRemaining =
    tier === 'VIP' ? Math.max(0, 1 - existingIncludedCount) : 0

  // Static guest ticket price — same for every paid guest, all tiers.
  const guestTicket = pickActivePrice(prices, 'guest_ticket', null)

  // HOA pricing: same active-phase price the main attendee pays. Per
  // spec, member discounts apply to guest TICKETS only, not add-ons —
  // so HOA is the public phase-active price for every guest.
  const hoaPriceRow = pickActivePrice(prices, 'hoa', null)
  const hoaCentsPerGuest = (hoaPriceRow?.price ?? 0) * 100

  // VIP membership entitlement: 2 free HOA per party (1 already auto-set
  // on the member, 1 spread across guests).
  let vipFreeGuestHoaRemaining =
    tier === 'VIP'
      ? Math.max(0, 1 - existingGuestHoaIncludedCount)
      : 0

  for (const g of newGuests) {
    const name = (g.full_name || '').trim()
    if (!name) continue

    const addons = g.addons ?? {}
    const wantsHoa = !!addons.has_hall_of_aime
    const wantsWmn = !!addons.has_wmn_at_fuse
    const wantsVettedVa = !!addons.has_vetted_va
    const wantsVipLuncheon = !!addons.has_vip_luncheon

    // Per-guest HOA charge: VIP gets one free across guests, then
    // everyone else pays the active HOA price. Free addons (WMN, Vetted
    // VA, VIP Luncheon) flow through as flags only — no Stripe line.
    let hoaIncludedForThisGuest = false
    if (wantsHoa && vipFreeGuestHoaRemaining > 0) {
      hoaIncludedForThisGuest = true
      vipFreeGuestHoaRemaining -= 1
    }

    const pushGuestRecord = (ticketType: string, isIncluded: boolean) => {
      guestsForInsert.push({
        full_name: name,
        ticket_type: ticketType,
        is_included: isIncluded,
        has_hall_of_aime: wantsHoa,
        has_wmn_at_fuse: wantsWmn,
        has_vetted_va: wantsVettedVa,
        has_vip_luncheon: wantsVipLuncheon,
      })
    }

    const pushHoaLineIfPaid = () => {
      if (!wantsHoa || hoaIncludedForThisGuest || hoaCentsPerGuest <= 0) {
        if (wantsHoa && hoaIncludedForThisGuest) {
          displayLineItems.push({
            label: `Guest: ${name} — Hall of AIME`,
            amountCents: 'included',
            hint: 'Included with VIP membership',
          })
        }
        return
      }
      stripeLineItems.push({
        price_data: {
          currency: 'usd',
          product_data: { name: `${eventLabel} Hall of AIME (guest)` },
          unit_amount: hoaCentsPerGuest,
        },
        quantity: 1,
      })
      totalCents += hoaCentsPerGuest
      displayLineItems.push({
        label: `Guest: ${name} — Hall of AIME`,
        amountCents: hoaCentsPerGuest,
      })
    }

    if (vipIncludedRemaining > 0) {
      vipIncludedRemaining -= 1
      // This branch only fires when tier === 'VIP' (see
      // vipIncludedRemaining computation above), so the included slot is
      // always a VIP ticket. Force 'vip' to keep stored ticket_type
      // truthful regardless of what the client sent.
      pushGuestRecord('vip', true)
      displayLineItems.push({
        label: `Guest: ${name}`,
        amountCents: 'included',
        hint: 'Included with VIP membership',
      })
      pushHoaLineIfPaid()
      continue
    }

    // Paid-guest branch: every non-included guest is charged the static
    // guest_ticket price regardless of the client-supplied ticket_type.
    // The VIP plan only grants ONE free VIP guest slot — that's handled
    // above by the vipIncludedRemaining branch. So force the stored
    // ticket_type to 'general_admission' here even if the client sent
    // 'vip' (which it does for VIP plan members so the first guest's
    // record reflects the included VIP slot).
    pushGuestRecord('general_admission', false)

    if (guestTicket) {
      const cents = (guestTicket.price ?? 0) * 100
      if (guestTicket.stripe_price_id) {
        stripeLineItems.push({
          price: guestTicket.stripe_price_id,
          quantity: 1,
        })
      } else if (cents > 0) {
        stripeLineItems.push({
          price_data: {
            currency: 'usd',
            product_data: { name: `${eventLabel} Guest Ticket` },
            unit_amount: cents,
          },
          quantity: 1,
        })
      }
      totalCents += cents
      displayLineItems.push({
        label: `Guest: ${name}`,
        amountCents: cents,
      })
    }

    pushHoaLineIfPaid()
  }

  return { guestsForInsert, stripeLineItems, totalCents, displayLineItems }
}
