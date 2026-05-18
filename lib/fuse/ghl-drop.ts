// Shared helper for firing the Fuse 2026 Opportunity webhook push on
// every confirmed registration. Called by:
//   - app/api/fuse-registration/claim/route.ts (claim + step='finalize')
//   - app/api/fuse-registration/[id]/finalize/route.ts (Phase 7b.2)
//   - app/api/fuse-registration/[id]/top-up/route.ts (Phase 7d)
//   - app/api/webhooks/ghl-fuse-form/route.ts (member claims via GHL form)
//
// We do NOT enroll the contact into a GHL workflow from here — AIME's
// GHL receiver creates the Opportunity and any downstream automation
// fires from there.
//
// Calls are best-effort: failures are logged but do not surface to the
// user's registration response.

import { ghlClient } from '@/lib/ghl/client'

/**
 * Drop event type. The receiver routes off this so AIME can have
 * separate GHL workflows for first-time registrations vs subsequent
 * top-up edits.
 *   - 'new'    : first webhook for this registration (claim, monthly buy
 *                finalize, claim+finalize one-shot, inbound GHL form)
 *   - 'update' : subsequent webhook for the same registration (top-up,
 *                annual claimer adding addons after the initial claim)
 */
export type FuseDropEventType = 'new' | 'update'

export interface FuseRegistrationForGhl {
  // Identifiers
  registration_id: string
  fuse_event_id: string
  fuse_event_year: number | null
  ghl_contact_id: string | null

  // Registrant profile snapshot (whatever we have at registration time)
  full_name: string
  email: string
  phone: string | null
  company: string | null
  nmls_number: string | null
  plan_tier: string | null       // membership tier on profile
  billing_period: string | null  // 'monthly' | 'annual' | null

  // Fuse registration row
  ticket_type: string
  tier: string | null            // Fuse tier (Premium / Elite / VIP / null)
  purchase_type: string          // 'claimed' | 'purchased' | 'upgraded' | 'pending'

  // Add-ons as their own top-level booleans (per AIME's request)
  has_hall_of_aime: boolean
  has_wmn_at_fuse: boolean
  has_vetted_va: boolean
  has_vip_luncheon: boolean

  // Guests on this registration
  guests: Array<{
    full_name: string
    ticket_type: string
    is_included: boolean
    has_hall_of_aime?: boolean
    has_wmn_at_fuse?: boolean
    has_vetted_va?: boolean
    has_vip_luncheon?: boolean
  }>

  // Pricing
  pricing_phase: string | null   // 'early_bird' | 'regular' | null
  total_paid_cents: number

  // Payment reference for AIME's records. Stripe PaymentIntent id for
  // direct-charge flows (claim / finalize / top-up); Stripe Invoice
  // number once Phase 4 manual-invoice flow lands. Null for free claims
  // (no payment processed).
  invoice_number: string | null

  // Meta
  created_at: string
}

export function buildOpportunityPayload(
  reg: FuseRegistrationForGhl,
  eventType: FuseDropEventType = 'new',
) {
  return {
    // Routing flag — `'new'` for the first push, `'update'` for any
    // subsequent push for the same registration. AIME can also branch
    // on this in the receiver workflow.
    event_type: eventType,

    // Identifiers
    registration_id: reg.registration_id,
    fuse_event_id: reg.fuse_event_id,
    fuse_event_year: reg.fuse_event_year,
    ghl_contact_id: reg.ghl_contact_id,

    // Registrant profile
    full_name: reg.full_name,
    email: reg.email,
    phone: reg.phone,
    company: reg.company,
    nmls_number: reg.nmls_number,
    plan_tier: reg.plan_tier,
    billing_period: reg.billing_period,
    is_member: !!reg.tier,

    // Registration
    ticket_type: reg.ticket_type,
    tier: reg.tier,
    purchase_type: reg.purchase_type,

    // Add-ons (top-level booleans, NOT an array)
    has_hall_of_aime: reg.has_hall_of_aime,
    has_wmn_at_fuse: reg.has_wmn_at_fuse,
    has_vetted_va: reg.has_vetted_va,
    has_vip_luncheon: reg.has_vip_luncheon,

    // Guests — each guest's add-on flags surface so AIME can route any
    // per-attendee fulfillment (wristbands, dietary, etc.) downstream.
    guest_count: reg.guests.length,
    guests: reg.guests.map((g) => ({
      full_name: g.full_name,
      ticket_type: g.ticket_type,
      is_included: g.is_included,
      has_hall_of_aime: !!g.has_hall_of_aime,
      has_wmn_at_fuse: !!g.has_wmn_at_fuse,
      has_vetted_va: !!g.has_vetted_va,
      has_vip_luncheon: !!g.has_vip_luncheon,
    })),

    // Pricing
    pricing_phase: reg.pricing_phase,
    total_paid_cents: reg.total_paid_cents,
    total_paid_dollars: reg.total_paid_cents / 100,
    invoice_number: reg.invoice_number,

    // Meta
    created_at: reg.created_at,
  }
}

/**
 * POST the Fuse registration payload to the AIME-owned Opportunity
 * webhook. The destination URL depends on `eventType`:
 *   - 'new'    → GHL_FUSE_OPPORTUNITY_WEBHOOK_URL_NEW
 *   - 'update' → GHL_FUSE_OPPORTUNITY_WEBHOOK_URL_UPDATE
 *
 * Either can fall back to GHL_FUSE_OPPORTUNITY_WEBHOOK_URL if the
 * specific var isn't set, so single-URL deploys still work. Returns
 * silently — caller does not need to await or handle errors.
 */
export async function dropFuseRegistration(
  reg: FuseRegistrationForGhl,
  eventType: FuseDropEventType = 'new',
): Promise<void> {
  try {
    await ghlClient.postFuseOpportunity(
      buildOpportunityPayload(reg, eventType),
      eventType,
    )
  } catch (err) {
    console.error('Fuse opportunity webhook failed:', err)
  }
}

/**
 * Whether to fire the Fuse Opportunity webhook for a given request.
 * Production rule: skip admin test registrations so they don't pollute
 * AIME's GHL pipeline. Dev override: set FUSE_DROP_FOR_ADMIN=true in
 * .env.local to push from your admin account while testing.
 */
export function shouldDropFuseRegistration(isAdmin: boolean): boolean {
  if (!isAdmin) return true
  return process.env.FUSE_DROP_FOR_ADMIN === 'true'
}
