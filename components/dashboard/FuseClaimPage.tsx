'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, CheckCircle2, ArrowLeft, CreditCard } from 'lucide-react'
import { toast } from 'sonner'
import Link from 'next/link'
import { loadStripe } from '@stripe/stripe-js'
import { AddCardModal } from '@/components/modals/AddCardModal'
import { planGuestPricing, pickActivePrice } from '@/lib/fuse/pricing'
import { getFuseEligibility } from '@/lib/fuse/eligibility'

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!)

// ===== Types =====

interface FuseEvent {
  id: string
  name: string
  year: number
  location?: string
  start_date?: string
  end_date?: string
}

interface TierPrice {
  id: string
  product_key: string
  label: string
  description: string | null
  price: number
  stripe_price_id: string | null
  is_addon: boolean
  is_included: boolean
  gender_lock: string | null
  pricing_phase: string
  tier: string | null
  phase_end_at: string | null
  sort_order: number
}

interface AllPriceRow {
  id: string
  product_key: string
  label: string
  description: string | null
  price: number
  stripe_price_id: string | null
  is_addon: boolean
  is_included: boolean
  gender_lock: string | null
  pricing_phase: string
  tier: string | null
  phase_start_at: string | null
  phase_end_at: string | null
  sort_order: number
}

interface GuestPricingRule {
  tier: string
  base_product_key: string
  discount_percent: number
}

interface FuseClaimPageProps {
  event: FuseEvent
  userProfile: {
    id: string
    email: string
    full_name?: string
    phone?: string
    company?: string
    plan_tier?: string
    billing_period?: string
    subscription_override?: boolean | null
    gender?: string
  }
  existingRegistration: {
    id: string
    ticket_type: string
    purchase_type: string
    has_hall_of_aime: boolean
    has_wmn_at_fuse: boolean
    has_vetted_va: boolean
    has_vip_luncheon: boolean
    step_completed: 'claim' | 'finalized'
    guests?: Array<{
      id: string
      full_name: string
      ticket_type: string
      is_included: boolean
    }>
  } | null
  isAdmin: boolean
  tierPrices: TierPrice[]
  allPrices: AllPriceRow[]
  guestPricingRules: GuestPricingRule[]
}

const TIER_INCLUSIONS: Record<string, { ticket: string; label: string }> = {
  Premium: { ticket: 'general_admission', label: 'General Admission' },
  Elite: { ticket: 'general_admission', label: 'General Admission' },
  VIP: { ticket: 'vip', label: 'VIP' },
}

const GENDER_OPTIONS = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'non_binary', label: 'Non-binary' },
  { value: 'prefer_not_to_say', label: 'Prefer not to say' },
]

const FUSE_ATTENDANCE_OPTIONS = [
  { value: '0', label: 'This will be my first Fuse' },
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '4', label: '4' },
  { value: '5+', label: '5 or more' },
]

// General Admission Plus was removed for Fuse 2026. The label stays
// in this lookup so legacy 'general_admission_plus' rows still render
// readable text in the admin's manage panel, but no UI creates new
// ones.
const TICKET_LABELS: Record<string, string> = {
  general_admission: 'General Admission',
  general_admission_plus: 'General Admission Plus',
  vip: 'VIP',
}

// Detect whether an addon is currently showing its early-bird price AND
// a higher regular-phase row exists. Used to render the "$299 $199 /
// Early-Bird until June 15" treatment.
function getAddonSaleInfo(
  addon: { product_key: string; tier: string | null; pricing_phase: string; price: number; phase_end_at: string | null },
  allPrices: AllPriceRow[],
): { regularPrice: number; earlyBirdEndAt: string | null } | null {
  if (addon.pricing_phase !== 'early_bird') return null
  const regularRow = allPrices.find(
    (p) =>
      p.product_key === addon.product_key &&
      (p.tier ?? null) === (addon.tier ?? null) &&
      p.pricing_phase === 'regular',
  )
  if (!regularRow || (regularRow.price ?? 0) <= (addon.price ?? 0)) return null
  return {
    regularPrice: regularRow.price ?? 0,
    earlyBirdEndAt: addon.phase_end_at,
  }
}

function formatSaleEndDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
}

// ===== Component =====

export function FuseClaimPage({
  event,
  userProfile,
  existingRegistration,
  isAdmin,
  tierPrices,
  allPrices,
  guestPricingRules,
}: FuseClaimPageProps) {
  const router = useRouter()
  const [isSubmitting, setIsSubmitting] = useState(false)
  // `gender` is read-only on this surface (used by the inner panels for
  // gender-locked add-ons). Sourced from the member's profile.
  const gender = userProfile.gender?.toLowerCase() || ''

  // Card-on-file + AddCardModal for the GA Plus upgrade CTA on the
  // landing card. (Inner panels manage their own copies for their flows.)
  const [paymentMethod, setPaymentMethod] = useState<
    { brand: string; last4: string } | null
  >(null)
  const [addCardOpen, setAddCardOpen] = useState(false)
  const loadPaymentMethod = async () => {
    try {
      const res = await fetch('/api/stripe/payment-method')
      const data = await res.json()
      setPaymentMethod(data.paymentMethod ?? null)
    } catch {
      setPaymentMethod(null)
    }
  }
  useEffect(() => {
    loadPaymentMethod()
  }, [])

  // Annual eligible members see a free-claim CTA. Monthly Premium /
  // Elite / VIP see Buy CTAs (GA + GA Plus) — VIP ticket isn't sold,
  // only claimed. Admins see Claim by default for testing.
  const fuseEligibility = getFuseEligibility(
    userProfile.plan_tier,
    userProfile.billing_period,
    userProfile.subscription_override,
  )
  const tierInclusion =
    fuseEligibility.kind === 'claim'
      ? TIER_INCLUSIONS[fuseEligibility.planTier] ?? null
      : null
  const effectiveTierInclusion =
    tierInclusion || (isAdmin ? { ticket: 'general_admission', label: 'General Admission (Admin Test)' } : null)

  const addonPrices = tierPrices.filter((p) => p.is_addon)

  const formatDateRange = () => {
    if (!event.start_date) return null
    const start = new Date(event.start_date + 'T00:00:00')
    const end = event.end_date ? new Date(event.end_date + 'T00:00:00') : null
    const months = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER']
    const m1 = months[start.getMonth()]
    const d1 = start.getDate()
    const y = start.getFullYear()
    if (end) {
      const d2 = end.getDate()
      if (start.getMonth() === end.getMonth()) return `${m1} ${d1}-${d2}, ${y}`
      return `${m1} ${d1} - ${months[end.getMonth()]} ${d2}, ${y}`
    }
    return `${m1} ${d1}, ${y}`
  }

  // Direct claim (step 1): no form-fill, profile-sourced, sets
  // step_completed='claim'. After success the page reloads and shows the
  // step 2 surface where the member can add add-ons / guests.
  const handleDirectClaim = async (overrideTicketType?: string) => {
    setIsSubmitting(true)
    try {
      const response = await fetch('/api/fuse-registration/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fuse_event_id: event.id,
          step: 'claim',
          ticket_type: overrideTicketType || effectiveTierInclusion?.ticket || 'general_admission',
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to claim')

      toast.success('Ticket claimed! You can now add guests or add-ons.')
      router.refresh()
    } catch (error: any) {
      toast.error(error.message || 'Failed to claim ticket')
    } finally {
      setIsSubmitting(false)
    }
  }

  // Monthly buyer reservation: same endpoint as the annual claim, but
  // the server writes purchase_type='pending' for non-free-claim members.
  // After success the page reloads into the Step2 checkout surface.
  const handleStartBuyerCheckout = async () => {
    setIsSubmitting(true)
    try {
      const response = await fetch('/api/fuse-registration/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fuse_event_id: event.id,
          step: 'claim',
          ticket_type: 'general_admission',
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to reserve ticket')

      router.refresh()
    } catch (error: any) {
      toast.error(error.message || 'Failed to reserve ticket')
    } finally {
      setIsSubmitting(false)
    }
  }

  const dateRange = formatDateRange()

  // Input styles
  const inputStyle: React.CSSProperties = {
    width: '100%', background: '#f5e8cc', border: '1px solid #c4a872',
    borderRadius: 4, padding: '8px 12px', color: '#2a1a08', fontSize: 13, outline: 'none',
  }
  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
    color: '#6a5030', marginBottom: 6, fontWeight: 700,
  }
  const selectStyle: React.CSSProperties = {
    ...inputStyle, appearance: 'none',
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%238a7050'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center', paddingRight: 32,
  }

  return (
    <div className="p-6 md:p-8">
      <div className="max-w-3xl mx-auto">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-6"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Dashboard
        </Link>

        {/* Landing card */}
        <div className="rounded-xl overflow-hidden" style={{ background: '#202F60', border: '1px solid #D4A85A33' }}>
          {/* Header with logo */}
          <div className="p-8 text-center" style={{ borderBottom: '1px solid #D4A85A33' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/assets/fuse/fuse-logo.png" alt="Fuse Austin" className="h-32 mx-auto mb-3" />
            {dateRange && (
              <div className="text-lg font-semibold tracking-wider" style={{ color: '#F4E6CA' }}>
                {dateRange}
              </div>
            )}
            {event.location && (
              <div className="text-xs tracking-widest uppercase mt-1" style={{ color: '#D4A85A' }}>
                {event.location}
              </div>
            )}
          </div>

          {/* Ticket info */}
          <div className="p-6">
            {existingRegistration && existingRegistration.step_completed === 'claim' ? (
              /* Claimed but not finalized — step-2 surface */
              <Step2Panel
                registrationId={existingRegistration.id}
                ticketType={existingRegistration.ticket_type}
                purchaseType={existingRegistration.purchase_type}
                tier={(userProfile.plan_tier as string | undefined) ?? null}
                existingHoa={existingRegistration.has_hall_of_aime}
                existingWmn={existingRegistration.has_wmn_at_fuse}
                existingVettedVa={existingRegistration.has_vetted_va}
                existingVipLuncheon={existingRegistration.has_vip_luncheon}
                eventYear={event.year}
                addonPrices={addonPrices}
                allPrices={allPrices}
                guestPricingRules={guestPricingRules}
                gender={gender}
                router={router}
                inputStyle={inputStyle}
                labelStyle={labelStyle}
              />
            ) : existingRegistration ? (
              /* Already registered + finalized — management surface */
              <ManagePanel
                registration={existingRegistration}
                eventName={event.name}
                eventYear={event.year}
                tier={(userProfile.plan_tier as string | undefined) ?? null}
                addonPrices={addonPrices}
                allPrices={allPrices}
                guestPricingRules={guestPricingRules}
                gender={gender}
                router={router}
                inputStyle={inputStyle}
                labelStyle={labelStyle}
              />
            ) : fuseEligibility.kind === 'buy' ? (
              /* Monthly buyer landing CTA. Reservation row is created on
                 click — page used to insert it on view, which polluted
                 the fuse_registrations table. */
              <div className="text-center py-4">
                <div
                  className="mb-4 rounded-lg px-4 py-2 text-sm inline-block"
                  style={{ background: '#D4A85A22', border: '1px solid #D4A85A44', color: '#F4E6CA' }}
                >
                  Your {fuseEligibility.planTier} plan doesn't include a free Fuse ticket. Reserve a{' '}
                  <strong style={{ color: '#ffffff' }}>General Admission</strong> ticket to continue to checkout.
                </div>

                <div className="flex justify-center">
                  <button
                    onClick={handleStartBuyerCheckout}
                    disabled={isSubmitting}
                    className="px-8 py-3 font-semibold text-sm rounded-full transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                    style={{
                      background: '#ffffff',
                      color: '#202F60',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                      letterSpacing: '0.05em',
                      cursor: isSubmitting ? 'wait' : 'pointer',
                    }}
                    onMouseEnter={(e) => !isSubmitting && (e.currentTarget.style.background = '#F4E6CA')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = '#ffffff')}
                  >
                    {isSubmitting ? (
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Reserving…
                      </span>
                    ) : (
                      'Reserve GA — Continue to Checkout'
                    )}
                  </button>
                </div>
              </div>
            ) : (
              /* Annual-claim landing CTA (and admin test). */
              <div className="text-center py-4">
                {effectiveTierInclusion && (
                  <div className="mb-4 rounded-lg px-4 py-2 text-sm inline-block"
                    style={{ background: '#D4A85A22', border: '1px solid #D4A85A44', color: '#F4E6CA' }}>
                    {userProfile.plan_tier === 'VIP' ? (
                      <>
                        Your membership includes{' '}
                        <strong style={{ color: '#ffffff' }}>2 VIP tickets + 2 Hall of AIME tickets</strong>
                      </>
                    ) : (
                      <>
                        Your membership includes a{' '}
                        <strong style={{ color: '#ffffff' }}>{effectiveTierInclusion.label}</strong> ticket
                      </>
                    )}
                  </div>
                )}

                <div className="flex justify-center">
                  <button
                    onClick={() => handleDirectClaim()}
                    disabled={isSubmitting}
                    className="px-8 py-3 font-semibold text-sm rounded-full transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                    style={{
                      background: '#ffffff',
                      color: '#202F60',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                      letterSpacing: '0.05em',
                      cursor: isSubmitting ? 'wait' : 'pointer',
                    }}
                    onMouseEnter={(e) => !isSubmitting && (e.currentTarget.style.background = '#F4E6CA')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = '#ffffff')}
                  >
                    {isSubmitting
                      ? <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Claiming…</span>
                      : `Claim My ${effectiveTierInclusion?.label || 'Ticket'}`}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <AddCardModal
        open={addCardOpen}
        onOpenChange={setAddCardOpen}
        onSuccess={loadPaymentMethod}
      />
    </div>
  )
}

// ============================================================
// Step 2: add-ons + guests for an already-claimed registration
// ============================================================

interface Step2PanelProps {
  registrationId: string
  ticketType: string
  /**
   * 'purchased' = monthly buyer with an unpaid main ticket (charge on
   * finalize). 'claimed' = annual claimer (main ticket already free).
   * 'upgraded' = post-upgrade. We only need to know whether to charge
   * the main ticket on finalize.
   */
  purchaseType: string
  tier: string | null
  /**
   * Add-ons already locked in on the claimed registration row (e.g. VIP
   * claims auto-include Hall of AIME). The Step2 gate for per-guest
   * add-ons must treat these as "main attendee has it" even though the
   * member never clicked the checkbox.
   */
  existingHoa: boolean
  existingWmn: boolean
  existingVettedVa: boolean
  existingVipLuncheon: boolean
  eventYear: number
  addonPrices: TierPrice[]
  allPrices: AllPriceRow[]
  guestPricingRules: GuestPricingRule[]
  gender: string
  router: ReturnType<typeof useRouter>
  inputStyle: React.CSSProperties
  labelStyle: React.CSSProperties
}

function Step2Panel({
  registrationId,
  ticketType,
  purchaseType,
  tier,
  existingHoa,
  existingWmn,
  existingVettedVa,
  existingVipLuncheon,
  eventYear,
  addonPrices,
  allPrices,
  guestPricingRules,
  gender,
  router,
  inputStyle,
  labelStyle,
}: Step2PanelProps) {
  const [addonState, setAddonState] = useState<Record<string, boolean>>({})
  const [guests, setGuests] = useState<{
    id: number
    firstName: string
    lastName: string
    addons: {
      hoa: boolean
      wmn: boolean
      vetted_va: boolean
      vip_luncheon: boolean
    }
  }[]>([])
  const [nextGuestId, setNextGuestId] = useState(0)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Payment method for the order summary's card-on-file consent.
  const [paymentMethod, setPaymentMethod] = useState<
    { brand: string; last4: string } | null
  >(null)
  const [paymentMethodLoading, setPaymentMethodLoading] = useState(true)
  const [addCardOpen, setAddCardOpen] = useState(false)

  const loadPaymentMethod = async () => {
    setPaymentMethodLoading(true)
    try {
      const res = await fetch('/api/stripe/payment-method')
      const data = await res.json()
      setPaymentMethod(data.paymentMethod ?? null)
    } catch {
      setPaymentMethod(null)
    } finally {
      setPaymentMethodLoading(false)
    }
  }

  useEffect(() => {
    loadPaymentMethod()
  }, [])

  // VIP Luncheon is restricted to VIP ticket holders. (GA Plus was
  // removed for Fuse 2026; the only ticket that unlocks the luncheon
  // now is VIP.)
  const vipLuncheonEligible = ticketType === 'vip'

  const toggleAddon = (productKey: string) => {
    const addon = addonPrices.find((a) => a.product_key === productKey)
    if (addon?.gender_lock && gender && gender !== addon.gender_lock) return
    if (addon?.is_included) return
    if (productKey === 'vip_luncheon' && !vipLuncheonEligible) return
    setAddonState((prev) => ({ ...prev, [productKey]: !prev[productKey] }))
  }

  const addGuest = () => {
    const id = nextGuestId + 1
    setNextGuestId(id)
    setGuests([
      ...guests,
      {
        id,
        firstName: '',
        lastName: '',
        addons: { hoa: false, wmn: false, vetted_va: false, vip_luncheon: false },
      },
    ])
  }
  const removeGuest = (id: number) => setGuests(guests.filter((g) => g.id !== id))
  const updateGuest = (id: number, field: 'firstName' | 'lastName', value: string) =>
    setGuests(guests.map((g) => (g.id === id ? { ...g, [field]: value } : g)))
  const toggleGuestAddon = (
    id: number,
    key: 'hoa' | 'wmn' | 'vetted_va' | 'vip_luncheon',
  ) =>
    setGuests(
      guests.map((g) =>
        g.id === id
          ? { ...g, addons: { ...g.addons, [key]: !g.addons[key] } }
          : g,
      ),
    )

  // -------------------------------------------------------------
  // Live order-summary computation. Mirrors the server's planGuestPricing
  // + HOA logic so the member sees the same totals the server will charge.
  // -------------------------------------------------------------

  // Guest add-on gating: the main attendee "has" an add-on if it's
  // already locked in on the registration (e.g. VIP-included HOA) OR if
  // the member is selecting it in this same finalize batch.
  const mainHasHoaEffective = existingHoa || !!addonState.hoa
  const mainHasWmnEffective = existingWmn || !!addonState.wmn
  const mainHasVettedVaEffective = existingVettedVa || !!addonState.vetted_va
  const mainHasVipLuncheonEffective = existingVipLuncheon || !!addonState.vip_luncheon

  const guestPlan = planGuestPricing({
    tier,
    rules: guestPricingRules,
    prices: allPrices,
    existingIncludedCount: 0,
    existingGuestHoaIncludedCount: 0,
    newGuests: guests
      .filter((g) => g.firstName.trim().length > 0)
      .map((g) => ({
        full_name: `${g.firstName.trim()} ${g.lastName.trim()}`.trim(),
        addons: {
          has_hall_of_aime: g.addons.hoa && mainHasHoaEffective,
          has_wmn_at_fuse: g.addons.wmn && mainHasWmnEffective,
          has_vetted_va: g.addons.vetted_va && mainHasVettedVaEffective,
          has_vip_luncheon: g.addons.vip_luncheon && mainHasVipLuncheonEffective,
        },
      })),
    eventLabel: `Fuse ${eventYear}`,
  })

  let hoaCents = 0
  let hoaDisplayCents: number | 'included' = 'included'
  if (addonState.hoa) {
    const tierHoa = pickActivePrice(allPrices, 'hoa', tier ?? null)
    const hoaRow =
      (tierHoa && !tierHoa.is_included && tierHoa.stripe_price_id ? tierHoa : null) ??
      pickActivePrice(allPrices, 'hoa', null)
    if (hoaRow) {
      if (hoaRow.is_included) {
        hoaDisplayCents = 'included'
      } else {
        hoaCents = (hoaRow.price ?? 0) * 100
        hoaDisplayCents = hoaCents
      }
    }
  }

  // Monthly buyer with an unpaid main ticket: charge active GA price
  // on finalize. Annual claimers stay $0 (included).
  const isPaidReservation = purchaseType === 'purchased'
  let mainTicketCents = 0
  if (isPaidReservation) {
    const mainRow = pickActivePrice(allPrices, 'ga', null)
    mainTicketCents = (mainRow?.price ?? 0) * 100
  }

  const totalCents = guestPlan.totalCents + hoaCents + mainTicketCents

  // Build the order summary line items.
  const orderLines: OrderSummaryLine[] = []
  if (isPaidReservation) {
    orderLines.push({
      label: `${TICKET_LABELS[ticketType] || ticketType} Ticket`,
      amountCents: mainTicketCents,
    })
  } else {
    orderLines.push({
      label: `${TICKET_LABELS[ticketType] || ticketType} Ticket`,
      amountCents: 'included',
      hint: 'Included with your membership',
    })
  }
  if (addonState.hoa) {
    orderLines.push({ label: 'Hall of AIME', amountCents: hoaDisplayCents })
  }
  if (addonState.wmn) {
    orderLines.push({ label: 'WMN at Fuse', amountCents: 0 })
  }
  if (addonState.vetted_va) {
    orderLines.push({ label: 'Vetted VA Summit', amountCents: 0 })
  }
  if (addonState.vip_luncheon) {
    orderLines.push({ label: 'VIP Luncheon', amountCents: 0 })
  }
  orderLines.push(...guestPlan.displayLineItems)

  const handleFinalize = async () => {
    setIsSubmitting(true)
    try {
      const basePayload = {
        has_hall_of_aime: !!addonState.hoa,
        has_wmn_at_fuse: !!addonState.wmn,
        has_vetted_va: !!addonState.vetted_va,
        has_vip_luncheon: !!addonState.vip_luncheon,
        marketing_consent: false,
        guests: guests
          .filter((g) => g.firstName.trim().length > 0)
          .map((g) => ({
            full_name: `${g.firstName.trim()} ${g.lastName.trim()}`.trim(),
            // VIP plan members get one free VIP guest slot (2 VIP tickets
            // total per VIP membership). Server pricing engine in
            // lib/fuse/pricing.ts allocates the included slot via
            // vipIncludedRemaining; any excess guests pay as GA.
            ticket_type: tier === 'VIP' ? 'vip' : 'general_admission',
            is_included: false,
            addons: {
              has_hall_of_aime: g.addons.hoa && mainHasHoaEffective,
              has_wmn_at_fuse: g.addons.wmn && mainHasWmnEffective,
              has_vetted_va: g.addons.vetted_va && mainHasVettedVaEffective,
              has_vip_luncheon: g.addons.vip_luncheon && mainHasVipLuncheonEffective,
            },
          })),
      }

      const callFinalize = (extra: Record<string, unknown> = {}) =>
        fetch(`/api/fuse-registration/${registrationId}/finalize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...basePayload, ...extra }),
        })

      let res = await callFinalize()
      let data = await res.json()

      if (res.status === 402 && data.code === 'no_payment_method') {
        setAddCardOpen(true)
        toast.error('Add a payment method to continue.')
        return
      }

      if (data.requires_action && data.client_secret) {
        const stripe = await stripePromise
        if (!stripe) throw new Error('Payment system unavailable')
        const { error, paymentIntent } = await stripe.handleNextAction({
          clientSecret: data.client_secret,
        })
        if (error) throw new Error(error.message || 'Authentication failed')
        if (!paymentIntent || paymentIntent.status !== 'succeeded') {
          throw new Error('Payment was not completed.')
        }
        res = await callFinalize({ confirmed_payment_intent_id: paymentIntent.id })
        data = await res.json()
      }

      if (!res.ok) throw new Error(data.error || 'Failed to finalize')

      toast.success('Registration complete!')
      router.refresh()
    } catch (error: any) {
      toast.error(error.message || 'Failed to save')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleSkip = () => {
    router.push('/dashboard')
  }

  return (
    <div className="py-2">
      <div className="text-center mb-6">
        <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3"
          style={{ background: 'linear-gradient(135deg, #3a5a20, #4a7a2a)' }}>
          <CheckCircle2 className="h-6 w-6" style={{ color: '#e8f0d8' }} />
        </div>
        <h2 className="text-xl font-bold mb-1" style={{ color: '#e8d5b0' }}>
          You&apos;re Claimed!
        </h2>
        <p className="text-xs" style={{ color: '#a08860' }}>
          {TICKET_LABELS[ticketType] || ticketType} ticket secured. Add guests or add-ons below, or do it later.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
        {/* LEFT — controls */}
        <div>
          {/* Add-Ons: clean inline rows, matching public reference */}
          <div className="mb-6">
            <h3 className="font-bold text-base mb-3" style={{ color: '#F4E6CA' }}>
              Add Ons
            </h3>
            {addonPrices.length === 0 ? (
              <div className="text-xs italic" style={{ color: '#D4A85A' }}>
                No add-ons available for your tier.
              </div>
            ) : (
              <div className="divide-y" style={{ borderColor: '#D4A85A33' }}>
                {addonPrices.map((addon) => {
                  const isIncluded = addon.is_included
                  const isGenderLocked = !!(addon.gender_lock && gender && gender !== addon.gender_lock)
                  const isTicketLocked = addon.product_key === 'vip_luncheon' && !vipLuncheonEligible
                  const isLocked = isGenderLocked || isTicketLocked
                  const isSelected = isIncluded || !!addonState[addon.product_key]
                  const sale = getAddonSaleInfo(addon, allPrices)
                  return (
                    <label
                      key={addon.id}
                      className="flex items-center gap-3 py-3 transition-colors"
                      style={{
                        color: '#F4E6CA',
                        opacity: isLocked ? 0.5 : 1,
                        cursor: isIncluded || isLocked ? 'not-allowed' : 'pointer',
                        borderTop: '1px solid #D4A85A22',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={isIncluded || isLocked}
                        onChange={() => toggleAddon(addon.product_key)}
                        className="h-4 w-4 cursor-pointer accent-[#A0282A] flex-shrink-0"
                      />
                      <span className="font-semibold text-sm">{addon.label}</span>
                      {sale && (
                        <span className="text-[10px] uppercase tracking-wider font-semibold whitespace-nowrap" style={{ color: '#D4A85A' }}>
                          Early-Bird until {formatSaleEndDate(sale.earlyBirdEndAt)}
                        </span>
                      )}
                      {isGenderLocked && (
                        <span className="text-[10px] italic whitespace-nowrap" style={{ color: '#A0282A' }}>
                          (Women only)
                        </span>
                      )}
                      {isTicketLocked && (
                        <span className="text-[10px] italic whitespace-nowrap" style={{ color: '#A0282A' }}>
                          (VIP only)
                        </span>
                      )}
                      <span className="ml-auto text-sm font-bold flex items-baseline gap-1.5 whitespace-nowrap" style={{ color: '#F4E6CA' }}>
                        {sale && (
                          <span className="line-through opacity-50 font-normal" style={{ color: '#D4A85A' }}>
                            ${sale.regularPrice}
                          </span>
                        )}
                        <span>
                          {isIncluded ? 'Included' : addon.price === 0 ? 'Free' : `$${addon.price}`}
                        </span>
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
          </div>

          {/* Bring a Guest — full-width button matching public reference */}
          <div className="mb-6">
            <h3 className="font-bold text-base mb-3" style={{ color: '#F4E6CA' }}>
              Bring a Guest
            </h3>
            {guests.length > 0 && (
              <div className="space-y-3 mb-3">
                {guests.map((g) => {
                  const mainAddonGates: Array<{
                    key: 'hoa' | 'wmn' | 'vetted_va' | 'vip_luncheon'
                    label: string
                    enabled: boolean
                  }> = [
                    { key: 'hoa', label: 'Hall of AIME', enabled: mainHasHoaEffective },
                    { key: 'wmn', label: 'WMN at Fuse', enabled: mainHasWmnEffective },
                    { key: 'vetted_va', label: 'Vetted VA', enabled: mainHasVettedVaEffective },
                    { key: 'vip_luncheon', label: 'VIP Luncheon', enabled: mainHasVipLuncheonEffective },
                  ]
                  return (
                    <div
                      key={g.id}
                      className="rounded-lg p-3 space-y-2"
                      style={{ background: '#202F6055', border: '1px solid #D4A85A33' }}
                    >
                      <div className="flex gap-2 items-start">
                        <input
                          placeholder="First name"
                          value={g.firstName}
                          onChange={(e) => updateGuest(g.id, 'firstName', e.target.value)}
                          style={inputStyle}
                        />
                        <input
                          placeholder="Last name"
                          value={g.lastName}
                          onChange={(e) => updateGuest(g.id, 'lastName', e.target.value)}
                          style={inputStyle}
                        />
                        <button
                          type="button"
                          onClick={() => removeGuest(g.id)}
                          className="text-xs px-2 self-center"
                          style={{ color: '#A0282A' }}
                          aria-label="Remove guest"
                        >
                          ✕
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs" style={{ color: '#F4E6CAcc' }}>
                        {mainAddonGates.map((gate) => (
                          <label
                            key={gate.key}
                            className={`inline-flex items-center gap-1.5 ${
                              gate.enabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
                            }`}
                            title={gate.enabled ? '' : `Add ${gate.label} for yourself to enable for this guest`}
                          >
                            <input
                              type="checkbox"
                              checked={gate.enabled && g.addons[gate.key]}
                              disabled={!gate.enabled}
                              onChange={() => gate.enabled && toggleGuestAddon(g.id, gate.key)}
                              className="h-3.5 w-3.5 accent-[#A0282A]"
                            />
                            {gate.label}
                          </label>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            <button
              type="button"
              onClick={addGuest}
              className="w-full py-3 font-bold text-sm uppercase tracking-wider rounded-lg transition-colors"
              style={{
                background: '#D4A85A',
                color: '#3A1F1A',
                letterSpacing: '0.1em',
              }}
            >
              + Add a Guest
            </button>
          </div>
        </div>

        {/* RIGHT — Order Summary */}
        <div className="lg:sticky lg:top-4 lg:self-start">
          <OrderSummary
            title="Order Summary"
            lineItems={orderLines}
            totalCents={totalCents}
            paymentMethod={paymentMethod}
            paymentMethodLoading={paymentMethodLoading}
            onUseDifferentCard={() => setAddCardOpen(true)}
            onPurchase={handleFinalize}
            purchaseLabel={totalCents > 0 ? 'Complete Registration' : 'Confirm'}
            isSubmitting={isSubmitting}
            canPurchase={true}
            showPayment={totalCents > 0}
          />
          <button
            type="button"
            onClick={handleSkip}
            disabled={isSubmitting}
            className="w-full mt-3 px-4 py-2 text-xs rounded-lg transition-colors"
            style={{
              background: 'transparent',
              border: '1px solid #6a5030',
              color: '#a08860',
              letterSpacing: '0.08em',
            }}
          >
            Skip for now
          </button>
        </div>
      </div>

      <AddCardModal
        open={addCardOpen}
        onOpenChange={setAddCardOpen}
        onSuccess={loadPaymentMethod}
      />
    </div>
  )
}

// ============================================================
// Finalized: management surface (Phase 7d)
// ============================================================

interface ManagePanelProps {
  registration: {
    id: string
    ticket_type: string
    has_hall_of_aime: boolean
    has_wmn_at_fuse: boolean
    has_vetted_va: boolean
    has_vip_luncheon: boolean
    step_completed: 'claim' | 'finalized'
    guests?: Array<{
      id: string
      full_name: string
      ticket_type: string
      is_included: boolean
      has_hall_of_aime?: boolean
      has_wmn_at_fuse?: boolean
      has_vetted_va?: boolean
      has_vip_luncheon?: boolean
    }>
  }
  eventName: string
  eventYear: number
  tier: string | null
  addonPrices: TierPrice[]
  allPrices: AllPriceRow[]
  guestPricingRules: GuestPricingRule[]
  gender: string
  router: ReturnType<typeof useRouter>
  inputStyle: React.CSSProperties
  labelStyle: React.CSSProperties
}

function ManagePanel({
  registration,
  eventName,
  eventYear,
  tier,
  addonPrices,
  allPrices,
  guestPricingRules,
  gender,
  router,
  inputStyle,
  labelStyle,
}: ManagePanelProps) {
  const guests = registration.guests || []

  // State for new additions (only saved on "Save changes")
  const [newGuests, setNewGuests] = useState<{
    id: number
    firstName: string
    lastName: string
    addons: {
      hoa: boolean
      wmn: boolean
      vetted_va: boolean
      vip_luncheon: boolean
    }
  }[]>([])
  const [nextNewGuestId, setNextNewGuestId] = useState(0)
  const [addAddons, setAddAddons] = useState<{
    hoa: boolean
    wmn: boolean
    vetted_va: boolean
    vip_luncheon: boolean
  }>({ hoa: false, wmn: false, vetted_va: false, vip_luncheon: false })
  const [isSubmitting, setIsSubmitting] = useState(false)

  // VIP Luncheon is restricted to VIP ticket holders. (GA Plus was
  // removed for Fuse 2026.) Legacy general_admission_plus rows in the
  // DB still keep the luncheon flag they had — they just can't add
  // more from the manage panel without VIP.
  const vipLuncheonEligible =
    registration.ticket_type === 'vip' ||
    registration.ticket_type === 'general_admission_plus'

  // State for inline guest name edits
  const [editingGuestId, setEditingGuestId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [editingAddons, setEditingAddons] = useState<{
    hoa: boolean
    wmn: boolean
    vetted_va: boolean
    vip_luncheon: boolean
  }>({ hoa: false, wmn: false, vetted_va: false, vip_luncheon: false })
  const [savingGuestId, setSavingGuestId] = useState<string | null>(null)

  // Card on file (for the consent line above Save Changes)
  const [paymentMethod, setPaymentMethod] = useState<
    { brand: string; last4: string; expMonth: number; expYear: number } | null
  >(null)
  const [paymentMethodLoading, setPaymentMethodLoading] = useState(true)
  const [addCardOpen, setAddCardOpen] = useState(false)

  const loadPaymentMethod = async () => {
    setPaymentMethodLoading(true)
    try {
      const res = await fetch('/api/stripe/payment-method')
      const data = await res.json()
      setPaymentMethod(data.paymentMethod ?? null)
    } catch {
      setPaymentMethod(null)
    } finally {
      setPaymentMethodLoading(false)
    }
  }

  useEffect(() => {
    loadPaymentMethod()
  }, [])

  // Available add-ons that haven't been claimed yet
  const availableAddons = addonPrices.filter((a) => {
    if (a.is_included) return false
    if (a.product_key === 'hoa' && registration.has_hall_of_aime) return false
    if (a.product_key === 'wmn' && registration.has_wmn_at_fuse) return false
    if (a.product_key === 'vetted_va' && registration.has_vetted_va) return false
    if (a.product_key === 'vip_luncheon' && registration.has_vip_luncheon) return false
    return true
  })

  const hasPendingChanges =
    newGuests.some((g) => g.firstName.trim().length > 0) ||
    addAddons.hoa ||
    addAddons.wmn ||
    addAddons.vetted_va ||
    addAddons.vip_luncheon

  // -------------------------------------------------------------
  // Live order-summary computation for the pending top-up batch.
  // Mirrors the server's planGuestPricing + HOA logic, accounting
  // for any already-included guests on the existing registration
  // (VIP first-guest slot may already be consumed).
  // -------------------------------------------------------------

  const existingIncludedCount = guests.filter((g) => g.is_included).length
  const existingGuestHoaIncludedCount = guests.filter((g) => !!g.has_hall_of_aime).length

  // Guest add-ons gate against what the registration already carries OR
  // what's being added in this same top-up batch.
  const mainHasHoaEffective = registration.has_hall_of_aime || addAddons.hoa
  const mainHasWmnEffective = registration.has_wmn_at_fuse || addAddons.wmn
  const mainHasVettedVaEffective = registration.has_vetted_va || addAddons.vetted_va
  const mainHasVipLuncheonEffective =
    registration.has_vip_luncheon || addAddons.vip_luncheon

  const guestPlan = planGuestPricing({
    tier,
    rules: guestPricingRules,
    prices: allPrices,
    existingIncludedCount,
    existingGuestHoaIncludedCount,
    newGuests: newGuests
      .filter((g) => g.firstName.trim().length > 0)
      .map((g) => ({
        full_name: `${g.firstName.trim()} ${g.lastName.trim()}`.trim(),
        addons: {
          has_hall_of_aime: g.addons.hoa && mainHasHoaEffective,
          has_wmn_at_fuse: g.addons.wmn && mainHasWmnEffective,
          has_vetted_va: g.addons.vetted_va && mainHasVettedVaEffective,
          has_vip_luncheon: g.addons.vip_luncheon && mainHasVipLuncheonEffective,
        },
      })),
    eventLabel: `Fuse ${eventYear}`,
  })

  let pendingHoaCents = 0
  let pendingHoaDisplay: number | 'included' = 'included'
  if (addAddons.hoa) {
    const tierHoa = pickActivePrice(allPrices, 'hoa', tier ?? null)
    const hoaRow =
      (tierHoa && !tierHoa.is_included && tierHoa.stripe_price_id ? tierHoa : null) ??
      pickActivePrice(allPrices, 'hoa', null)
    if (hoaRow) {
      if (hoaRow.is_included) {
        pendingHoaDisplay = 'included'
      } else {
        pendingHoaCents = (hoaRow.price ?? 0) * 100
        pendingHoaDisplay = pendingHoaCents
      }
    }
  }

  const pendingTotalCents = guestPlan.totalCents + pendingHoaCents

  const pendingOrderLines: OrderSummaryLine[] = []
  if (addAddons.hoa) {
    pendingOrderLines.push({ label: 'Hall of AIME', amountCents: pendingHoaDisplay })
  }
  if (addAddons.wmn) {
    pendingOrderLines.push({ label: 'WMN at Fuse', amountCents: 0 })
  }
  if (addAddons.vetted_va) {
    pendingOrderLines.push({ label: 'Vetted VA Summit', amountCents: 0 })
  }
  if (addAddons.vip_luncheon) {
    pendingOrderLines.push({ label: 'VIP Luncheon', amountCents: 0 })
  }
  pendingOrderLines.push(...guestPlan.displayLineItems)

  const startEditGuest = (g: {
    id: string
    full_name: string
    has_hall_of_aime?: boolean
    has_wmn_at_fuse?: boolean
    has_vetted_va?: boolean
    has_vip_luncheon?: boolean
  }) => {
    setEditingGuestId(g.id)
    setEditingName(g.full_name)
    setEditingAddons({
      hoa: !!g.has_hall_of_aime,
      wmn: !!g.has_wmn_at_fuse,
      vetted_va: !!g.has_vetted_va,
      vip_luncheon: !!g.has_vip_luncheon,
    })
  }
  const cancelEditGuest = () => {
    setEditingGuestId(null)
    setEditingName('')
    setEditingAddons({ hoa: false, wmn: false, vetted_va: false, vip_luncheon: false })
  }
  const toggleEditingAddon = (
    key: 'hoa' | 'wmn' | 'vetted_va' | 'vip_luncheon',
  ) => setEditingAddons((prev) => ({ ...prev, [key]: !prev[key] }))

  const saveEditGuest = async (guestId: string) => {
    const trimmed = editingName.trim()
    if (!trimmed) {
      toast.error('Name cannot be empty')
      return
    }
    setSavingGuestId(guestId)
    try {
      // Only the 3 free add-ons go through this PATCH. HOA is set when
      // the guest is added (it's a paid line item) and can't be flipped
      // here without running through the top-up payment flow.
      const res = await fetch(
        `/api/fuse-registration/${registration.id}/guests/${guestId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            full_name: trimmed,
            addons: {
              has_wmn_at_fuse: editingAddons.wmn,
              has_vetted_va: editingAddons.vetted_va,
              has_vip_luncheon: editingAddons.vip_luncheon,
            },
          }),
        },
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to update guest')

      toast.success('Guest updated')
      setEditingGuestId(null)
      setEditingName('')
      setEditingAddons({ hoa: false, wmn: false, vetted_va: false, vip_luncheon: false })
      router.refresh()
    } catch (error: any) {
      toast.error(error.message || 'Failed to update guest')
    } finally {
      setSavingGuestId(null)
    }
  }

  const addNewGuestRow = () => {
    const id = nextNewGuestId + 1
    setNextNewGuestId(id)
    setNewGuests([
      ...newGuests,
      {
        id,
        firstName: '',
        lastName: '',
        addons: { hoa: false, wmn: false, vetted_va: false, vip_luncheon: false },
      },
    ])
  }
  const removeNewGuestRow = (id: number) =>
    setNewGuests(newGuests.filter((g) => g.id !== id))
  const updateNewGuestRow = (id: number, field: 'firstName' | 'lastName', value: string) =>
    setNewGuests(newGuests.map((g) => (g.id === id ? { ...g, [field]: value } : g)))
  const toggleNewGuestAddon = (
    id: number,
    key: 'hoa' | 'wmn' | 'vetted_va' | 'vip_luncheon',
  ) =>
    setNewGuests(
      newGuests.map((g) =>
        g.id === id
          ? { ...g, addons: { ...g.addons, [key]: !g.addons[key] } }
          : g,
      ),
    )

  const toggleAddAddon = (key: 'hoa' | 'wmn' | 'vetted_va' | 'vip_luncheon') => {
    const addon = addonPrices.find((a) => a.product_key === key)
    if (addon?.gender_lock && gender && gender !== addon.gender_lock) return
    if (key === 'vip_luncheon' && !vipLuncheonEligible) return
    setAddAddons((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const handleSaveChanges = async () => {
    setIsSubmitting(true)
    try {
      const basePayload = {
        add_hall_of_aime: addAddons.hoa,
        add_wmn_at_fuse: addAddons.wmn,
        add_vetted_va: addAddons.vetted_va,
        add_vip_luncheon: addAddons.vip_luncheon,
        new_guests: newGuests
          .filter((g) => g.firstName.trim().length > 0)
          .map((g) => ({
            full_name: `${g.firstName.trim()} ${g.lastName.trim()}`.trim(),
            // VIP plan members get one free VIP guest slot (2 VIP tickets
            // total per VIP membership). Server pricing engine in
            // lib/fuse/pricing.ts allocates the included slot via
            // vipIncludedRemaining; any excess guests pay as GA.
            ticket_type: tier === 'VIP' ? 'vip' : 'general_admission',
            is_included: false,
            addons: {
              has_hall_of_aime: g.addons.hoa && mainHasHoaEffective,
              has_wmn_at_fuse: g.addons.wmn && mainHasWmnEffective,
              has_vetted_va: g.addons.vetted_va && mainHasVettedVaEffective,
              has_vip_luncheon: g.addons.vip_luncheon && mainHasVipLuncheonEffective,
            },
          })),
      }

      const callTopUp = (extra: Record<string, unknown> = {}) =>
        fetch(`/api/fuse-registration/${registration.id}/top-up`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...basePayload, ...extra }),
        })

      let res = await callTopUp()
      let data = await res.json()

      // No payment method on file — prompt to add one, then user retries.
      if (res.status === 402 && data.code === 'no_payment_method') {
        setAddCardOpen(true)
        toast.error('Add a payment method to continue.')
        return
      }

      // 3DS / Strong Customer Authentication: client runs handleNextAction,
      // then re-posts the same body with the confirmed PaymentIntent id.
      if (data.requires_action && data.client_secret) {
        const stripe = await stripePromise
        if (!stripe) throw new Error('Payment system unavailable')
        const { error, paymentIntent } = await stripe.handleNextAction({
          clientSecret: data.client_secret,
        })
        if (error) throw new Error(error.message || 'Authentication failed')
        if (!paymentIntent || paymentIntent.status !== 'succeeded') {
          throw new Error('Payment was not completed.')
        }
        res = await callTopUp({ confirmed_payment_intent_id: paymentIntent.id })
        data = await res.json()
      }

      if (!res.ok) throw new Error(data.error || 'Failed to save changes')

      toast.success('Changes saved')
      setNewGuests([])
      setAddAddons({ hoa: false, wmn: false, vetted_va: false, vip_luncheon: false })
      router.refresh()
    } catch (error: any) {
      toast.error(error.message || 'Failed to save changes')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="py-2">
      {/* Header */}
      <div className="text-center mb-6">
        <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3"
          style={{ background: 'linear-gradient(135deg, #3a5a20, #4a7a2a)' }}>
          <CheckCircle2 className="h-6 w-6" style={{ color: '#e8f0d8' }} />
        </div>
        <h2 className="text-xl font-bold mb-1" style={{ color: '#F4E6CA' }}>
          You&apos;re Registered for {eventName}
        </h2>
        <p className="text-xs" style={{ color: '#D4A85A' }}>
          {TICKET_LABELS[registration.ticket_type] || registration.ticket_type} ticket
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
        {/* LEFT — Add-Ons + Guests, unified (existing + addable) */}
        <div>
          {/* Add-Ons: clean inline rows */}
          <div className="mb-6">
            <h3 className="font-bold text-base mb-3" style={{ color: '#F4E6CA' }}>
              Add Ons
            </h3>
            {/* Empty state */}
            {availableAddons.length === 0 &&
              !registration.has_hall_of_aime &&
              !registration.has_wmn_at_fuse &&
              !registration.has_vetted_va &&
              !registration.has_vip_luncheon && (
                <div className="text-xs italic" style={{ color: '#8a7555' }}>
                  No add-ons available for your tier.
                </div>
              )}

            {/* Confirmed (existing) + addable, all as inline rows */}
            <div>
              {[
                { key: 'hoa', label: 'Hall of AIME', confirmed: registration.has_hall_of_aime },
                { key: 'wmn', label: 'WMN at Fuse', confirmed: registration.has_wmn_at_fuse },
                { key: 'vetted_va', label: 'Vetted VA Summit', confirmed: registration.has_vetted_va },
                { key: 'vip_luncheon', label: 'VIP Luncheon', confirmed: registration.has_vip_luncheon },
              ]
                .filter((r) => r.confirmed)
                .map((r) => (
                  <div
                    key={`confirmed-${r.key}`}
                    className="flex items-center gap-3 py-3"
                    style={{ color: '#F4E6CA', borderTop: '1px solid #D4A85A22' }}
                  >
                    <span
                      className="h-4 w-4 rounded flex items-center justify-center text-[10px] flex-shrink-0"
                      style={{ background: '#3a5a20', color: '#F4E6CA' }}
                    >
                      ✓
                    </span>
                    <span className="font-semibold text-sm">{r.label}</span>
                    <span className="text-[10px] italic" style={{ color: '#7ac97a' }}>
                      Confirmed
                    </span>
                  </div>
                ))}

              {availableAddons.map((addon) => {
                const key = addon.product_key as 'hoa' | 'wmn' | 'vetted_va' | 'vip_luncheon'
                if (!['hoa', 'wmn', 'vetted_va', 'vip_luncheon'].includes(key)) return null
                const isGenderLocked = !!(addon.gender_lock && gender && gender !== addon.gender_lock)
                const isTicketLocked = key === 'vip_luncheon' && !vipLuncheonEligible
                const isLocked = isGenderLocked || isTicketLocked
                const selected = addAddons[key]
                const sale = getAddonSaleInfo(addon, allPrices)
                return (
                  <label
                    key={addon.id}
                    className="flex items-center gap-3 py-3 transition-colors"
                    style={{
                      color: '#F4E6CA',
                      opacity: isLocked ? 0.5 : 1,
                      cursor: isLocked ? 'not-allowed' : 'pointer',
                      borderTop: '1px solid #D4A85A22',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={isLocked}
                      onChange={() => toggleAddAddon(key)}
                      className="h-4 w-4 cursor-pointer accent-[#A0282A] flex-shrink-0"
                    />
                    <span className="font-semibold text-sm">{addon.label}</span>
                    {sale && (
                      <span className="text-[10px] uppercase tracking-wider font-semibold whitespace-nowrap" style={{ color: '#D4A85A' }}>
                        Early-Bird until {formatSaleEndDate(sale.earlyBirdEndAt)}
                      </span>
                    )}
                    {isGenderLocked && (
                      <span className="text-[10px] italic whitespace-nowrap" style={{ color: '#A0282A' }}>
                        (Women only)
                      </span>
                    )}
                    {isTicketLocked && (
                      <span className="text-[10px] italic whitespace-nowrap" style={{ color: '#A0282A' }}>
                        (VIP only)
                      </span>
                    )}
                    <span className="ml-auto text-sm font-bold flex items-baseline gap-1.5 whitespace-nowrap" style={{ color: '#F4E6CA' }}>
                      {sale && (
                        <span className="line-through opacity-50 font-normal" style={{ color: '#D4A85A' }}>
                          ${sale.regularPrice}
                        </span>
                      )}
                      <span>{addon.price === 0 ? 'Free' : `$${addon.price}`}</span>
                    </span>
                  </label>
                )
              })}
            </div>
          </div>

          {/* Bring a Guest — full-width button at bottom */}
          <div className="mb-6">
            <h3 className="font-bold text-base mb-3" style={{ color: '#F4E6CA' }}>
              Bring a Guest
            </h3>
            {(guests.length > 0 || newGuests.length > 0) && (
              <div className="space-y-2 mb-3">
                {guests.map((g) => {
                  // Existing-guest edit: 3 free add-ons are togglable
                  // (gated by main attendee). HOA is shown for visibility
                  // but read-only — it's set at add time because adding it
                  // later requires a paid top-up.
                  const editGates: Array<{
                    key: 'hoa' | 'wmn' | 'vetted_va' | 'vip_luncheon'
                    label: string
                    enabled: boolean
                    locked?: boolean
                    lockedReason?: string
                  }> = [
                    {
                      key: 'hoa',
                      label: 'Hall of AIME',
                      enabled: mainHasHoaEffective,
                      locked: true,
                      lockedReason: 'Set when the guest is added (paid line item)',
                    },
                    { key: 'wmn', label: 'WMN at Fuse', enabled: mainHasWmnEffective },
                    { key: 'vetted_va', label: 'Vetted VA', enabled: mainHasVettedVaEffective },
                    { key: 'vip_luncheon', label: 'VIP Luncheon', enabled: mainHasVipLuncheonEffective },
                  ]
                  return (
                    <div
                      key={g.id}
                      className="p-2 rounded space-y-2"
                      style={{ background: '#3a5a2022', border: '1px solid #3a5a2055' }}
                    >
                      {editingGuestId === g.id ? (
                        <>
                          <div className="flex items-center gap-2">
                            <input
                              autoFocus
                              value={editingName}
                              onChange={(e) => setEditingName(e.target.value)}
                              style={{ ...inputStyle, flex: 1 }}
                              placeholder="Full name"
                            />
                            <button
                              type="button"
                              onClick={() => saveEditGuest(g.id)}
                              disabled={savingGuestId === g.id}
                              className="text-xs px-3 py-1 rounded disabled:opacity-60"
                              style={{
                                background: '#A0282A',
                                color: '#F4E6CA',
                                cursor: savingGuestId === g.id ? 'wait' : 'pointer',
                              }}
                            >
                              {savingGuestId === g.id ? '…' : 'Save'}
                            </button>
                            <button
                              type="button"
                              onClick={cancelEditGuest}
                              className="text-xs px-2"
                              style={{ color: '#8a7555' }}
                            >
                              Cancel
                            </button>
                          </div>
                          <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs" style={{ color: '#F4E6CAcc' }}>
                            {editGates.map((gate) => {
                              const isLocked = !!gate.locked
                              const disabled = !gate.enabled || isLocked
                              return (
                                <label
                                  key={gate.key}
                                  className={`inline-flex items-center gap-1.5 ${
                                    disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
                                  }`}
                                  title={
                                    isLocked
                                      ? gate.lockedReason
                                      : gate.enabled
                                      ? ''
                                      : `Add ${gate.label} for yourself to enable for this guest`
                                  }
                                >
                                  <input
                                    type="checkbox"
                                    checked={
                                      isLocked
                                        ? !!g[`has_${gate.key === 'hoa' ? 'hall_of_aime' : gate.key === 'wmn' ? 'wmn_at_fuse' : gate.key}` as keyof typeof g]
                                        : gate.enabled && editingAddons[gate.key]
                                    }
                                    disabled={disabled}
                                    onChange={() => !disabled && toggleEditingAddon(gate.key)}
                                    className="h-3.5 w-3.5 accent-[#A0282A]"
                                  />
                                  {gate.label}
                                </label>
                              )
                            })}
                          </div>
                        </>
                      ) : (
                        <div className="flex items-center gap-2">
                          <div className="flex-1 text-sm" style={{ color: '#F4E6CA' }}>
                            {/* Matches the non-member sign-up format:
                                "Name — General Admission (addon · addon)" */}
                            {(() => {
                              const addonList = [
                                g.has_hall_of_aime && 'Hall of AIME',
                                g.has_wmn_at_fuse && 'WMN',
                                g.has_vetted_va && 'Vetted VA',
                                g.has_vip_luncheon && 'VIP Luncheon',
                              ]
                                .filter(Boolean)
                                .join(' · ')
                              const ticketLabel =
                                TICKET_LABELS[g.ticket_type] || g.ticket_type
                              return (
                                <>
                                  {g.full_name} — {ticketLabel}
                                  {addonList && ` (${addonList})`}
                                </>
                              )
                            })()}
                            {g.is_included && (
                              <span className="ml-2 text-xs" style={{ color: '#4a7a2a' }}>(included)</span>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => startEditGuest(g)}
                            className="text-xs underline"
                            style={{ color: '#D4A85A' }}
                          >
                            Edit
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
                {newGuests.map((g) => {
                  const mainAddonGates: Array<{
                    key: 'hoa' | 'wmn' | 'vetted_va' | 'vip_luncheon'
                    label: string
                    enabled: boolean
                  }> = [
                    { key: 'hoa', label: 'Hall of AIME', enabled: mainHasHoaEffective },
                    { key: 'wmn', label: 'WMN at Fuse', enabled: mainHasWmnEffective },
                    { key: 'vetted_va', label: 'Vetted VA', enabled: mainHasVettedVaEffective },
                    { key: 'vip_luncheon', label: 'VIP Luncheon', enabled: mainHasVipLuncheonEffective },
                  ]
                  return (
                    <div
                      key={g.id}
                      className="rounded-lg p-3 space-y-2"
                      style={{ background: '#202F6055', border: '1px solid #D4A85A33' }}
                    >
                      <div className="flex gap-2 items-start">
                        <input
                          placeholder="First name"
                          value={g.firstName}
                          onChange={(e) => updateNewGuestRow(g.id, 'firstName', e.target.value)}
                          style={inputStyle}
                        />
                        <input
                          placeholder="Last name"
                          value={g.lastName}
                          onChange={(e) => updateNewGuestRow(g.id, 'lastName', e.target.value)}
                          style={inputStyle}
                        />
                        <button
                          type="button"
                          onClick={() => removeNewGuestRow(g.id)}
                          className="text-xs px-2 self-center"
                          style={{ color: '#A0282A' }}
                          aria-label="Remove"
                        >
                          ✕
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs" style={{ color: '#F4E6CAcc' }}>
                        {mainAddonGates.map((gate) => (
                          <label
                            key={gate.key}
                            className={`inline-flex items-center gap-1.5 ${
                              gate.enabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
                            }`}
                            title={gate.enabled ? '' : `Add ${gate.label} for yourself to enable for this guest`}
                          >
                            <input
                              type="checkbox"
                              checked={gate.enabled && g.addons[gate.key]}
                              disabled={!gate.enabled}
                              onChange={() => gate.enabled && toggleNewGuestAddon(g.id, gate.key)}
                              className="h-3.5 w-3.5 accent-[#A0282A]"
                            />
                            {gate.label}
                          </label>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            <button
              type="button"
              onClick={addNewGuestRow}
              className="w-full py-3 font-bold text-sm uppercase tracking-wider rounded-lg transition-colors"
              style={{
                background: '#D4A85A',
                color: '#3A1F1A',
                letterSpacing: '0.1em',
              }}
            >
              + Add a Guest
            </button>
          </div>
        </div>

        {/* RIGHT — order summary for pending changes */}
        <div className="lg:sticky lg:top-4 lg:self-start">
          <OrderSummary
            title="Order Summary"
            lineItems={pendingOrderLines}
            totalCents={pendingTotalCents}
            paymentMethod={paymentMethod}
            paymentMethodLoading={paymentMethodLoading}
            onUseDifferentCard={() => setAddCardOpen(true)}
            onPurchase={handleSaveChanges}
            purchaseLabel={pendingTotalCents > 0 ? 'Pay & Save' : 'Save Changes'}
            isSubmitting={isSubmitting}
            canPurchase={hasPendingChanges}
            showPayment={pendingTotalCents > 0}
          />
        </div>
      </div>

      <AddCardModal
        open={addCardOpen}
        onOpenChange={setAddCardOpen}
        onSuccess={() => {
          // Refresh card on file so the consent line reflects the new card.
          loadPaymentMethod()
        }}
      />
    </div>
  )
}

// ============================================================
// OrderSummary — shared by Step2Panel and ManagePanel
// ============================================================

interface OrderSummaryLine {
  label: string
  /** 'included' renders as "Included", 0 renders as "Free", anything else as "$X.XX". */
  amountCents: number | 'included'
  /** Optional small subtitle below the label. */
  hint?: string
}

interface OrderSummaryProps {
  title?: string
  lineItems: OrderSummaryLine[]
  totalCents: number
  paymentMethod: { brand: string; last4: string } | null
  paymentMethodLoading: boolean
  onUseDifferentCard: () => void
  onPurchase: () => void
  purchaseLabel: string
  isSubmitting: boolean
  canPurchase: boolean
  /** Show the card-on-file consent line only when totalCents > 0. */
  showPayment: boolean
}

function formatAmount(amountCents: number | 'included'): string {
  if (amountCents === 'included') return 'Included'
  if (amountCents === 0) return 'Free'
  return `$${(amountCents / 100).toFixed(2)}`
}

// Fuse 2026 brand palette (from the FS26 logo):
//   Cream / off-white     #F4E6CA
//   Dark brown outline    #3A1F1A
//   Texas red             #A0282A
//   Texas blue            #2B4B8C
//   Gold / tan accent     #D4A85A
//   Hero navy             #021649

function OrderSummary({
  title = 'Order Summary',
  lineItems,
  totalCents,
  paymentMethod,
  paymentMethodLoading,
  onUseDifferentCard,
  onPurchase,
  purchaseLabel,
  isSubmitting,
  canPurchase,
  showPayment,
}: OrderSummaryProps) {
  return (
    <div
      className="rounded-xl shadow-lg p-6"
      style={{ background: '#F4E6CA', border: '1px solid #D4A85A' }}
    >
      <h3
        className="text-lg font-bold mb-4 pb-3 uppercase tracking-wider"
        style={{ color: '#A0282A', borderBottom: '2px solid #D4A85A88' }}
      >
        {title}
      </h3>

      <div className="space-y-2 mb-4">
        {lineItems.length === 0 ? (
          <p className="text-sm italic" style={{ color: '#8a7050' }}>
            Add a guest or add-on to get started.
          </p>
        ) : (
          lineItems.map((item, idx) => (
            <div key={idx} className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm" style={{ color: '#3A1F1A' }}>
                  {item.label}
                </div>
                {item.hint && (
                  <div className="text-xs mt-0.5" style={{ color: '#8a7050' }}>
                    {item.hint}
                  </div>
                )}
              </div>
              <div
                className="text-sm font-semibold whitespace-nowrap"
                style={{
                  color:
                    item.amountCents === 'included' || item.amountCents === 0
                      ? '#3a5a20'
                      : '#3A1F1A',
                }}
              >
                {formatAmount(item.amountCents)}
              </div>
            </div>
          ))
        )}
      </div>

      <div
        className="flex items-center justify-between pt-3 mb-4"
        style={{ borderTop: '2px solid #D4A85A88' }}
      >
        <span className="font-bold text-base" style={{ color: '#3A1F1A' }}>
          Total
        </span>
        <span className="font-bold text-xl" style={{ color: '#A0282A' }}>
          ${(totalCents / 100).toFixed(2)}
        </span>
      </div>

      {showPayment && (
        <div
          className="mb-3 px-3 py-2 rounded text-xs flex items-center justify-between gap-2"
          style={{ background: '#ffffff66', border: '1px solid #D4A85A88' }}
        >
          <div className="flex items-center gap-2" style={{ color: '#3A1F1A' }}>
            <CreditCard className="h-4 w-4" />
            {paymentMethodLoading ? (
              <span style={{ color: '#8a7050' }}>Loading payment method…</span>
            ) : paymentMethod ? (
              <span>
                Charge to <strong>{paymentMethod.brand}</strong> ending{' '}
                <strong>•••• {paymentMethod.last4}</strong>
              </span>
            ) : (
              <span style={{ color: '#A0282A' }}>No card on file</span>
            )}
          </div>
          <button
            type="button"
            onClick={onUseDifferentCard}
            className="text-xs underline whitespace-nowrap"
            style={{ color: '#A0282A' }}
          >
            {paymentMethod ? 'Use a different card' : 'Add a card'}
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={onPurchase}
        disabled={!canPurchase || isSubmitting}
        className="w-full px-4 py-3 font-bold text-sm rounded-full transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        style={{
          background: '#A0282A',
          color: '#F4E6CA',
          border: '1px solid #3A1F1A',
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
        }}
      >
        {isSubmitting ? (
          <span className="inline-flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Processing…
          </span>
        ) : (
          purchaseLabel
        )}
      </button>
    </div>
  )
}
