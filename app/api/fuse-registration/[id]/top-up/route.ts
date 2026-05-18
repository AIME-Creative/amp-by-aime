import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ghlClient } from '@/lib/ghl/client'
import { getImpersonationSettings } from '@/lib/impersonation-server'
import { pickActivePrice, planGuestPricing } from '@/lib/fuse/pricing'
import { dropFuseRegistration, shouldDropFuseRegistration } from '@/lib/fuse/ghl-drop'
import { handleStripeChargeError, resolveCustomerPaymentMethodId } from '@/lib/fuse/stripe-errors'
import { canSeeFuse } from '@/lib/fuse/visibility'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

/**
 * POST /api/fuse-registration/[id]/top-up
 *
 * Phase 7d + 8a: additive changes to an already-finalized registration.
 * Members come back later to add more guests or paid/free add-ons.
 *
 * Charge model (mirrors purchase-escalations):
 *   1. Compute the requested changes and total cents.
 *   2. If anything paid, create a PaymentIntent with confirm:true against
 *      the customer's default card. We do NOT mutate the registration row
 *      until the PaymentIntent reaches status='succeeded'.
 *   3. If the PaymentIntent comes back as `requires_action`, return the
 *      client_secret + payment_intent_id so the client can run
 *      stripe.handleNextAction (3DS), then re-submit the same body with
 *      `confirmed_payment_intent_id` set. Server re-validates that the PI
 *      is succeeded AND that its amount matches the recomputed total,
 *      then applies the changes.
 *   4. If no payment method on file, return { code: 'no_payment_method' }
 *      so the client can open AddCardModal and retry.
 *
 * Body shape:
 *   {
 *     add_hall_of_aime?: boolean
 *     add_wmn_at_fuse?: boolean
 *     new_guests?: [{ full_name, ticket_type?, is_included? }]
 *     confirmed_payment_intent_id?: string   // 3DS second pass
 *   }
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const supabase = await createClient()
    const { id: registrationId } = await context.params

    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const impersonationSettings = await getImpersonationSettings()
    const isImpersonating =
      impersonationSettings?.isImpersonating && impersonationSettings?.impersonatedUserId
    const effectiveUserId = isImpersonating ? impersonationSettings.impersonatedUserId : user.id

    const { data: adminProfile } = await supabase
      .from('profiles')
      .select('is_admin, stripe_customer_id')
      .eq('id', user.id)
      .single()
    const isAdmin = adminProfile?.is_admin === true

    // Pre-go-live: non-admins get a 404 until FUSE_LIVE=true.
    if (!canSeeFuse(isAdmin)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Effective customer id: when impersonating, use the impersonated user's
    // Stripe customer (their card will be charged). For non-impersonated
    // flows the real user's customer is used.
    const { data: effectiveProfile } = await supabase
      .from('profiles')
      .select('stripe_customer_id, full_name, phone, company, plan_tier, billing_period, nmls_number')
      .eq('id', effectiveUserId)
      .single()
    const stripeCustomerId = effectiveProfile?.stripe_customer_id ?? null

    const { data: registration, error: regFetchError } = await supabase
      .from('fuse_registrations')
      .select(
        'id, fuse_event_id, user_id, email, full_name, phone, tier, ticket_type, purchase_type, step_completed, has_hall_of_aime, has_wmn_at_fuse, has_vetted_va, has_vip_luncheon, ghl_contact_id',
      )
      .eq('id', registrationId)
      .single()

    if (regFetchError || !registration) {
      return NextResponse.json({ error: 'Registration not found' }, { status: 404 })
    }

    if (registration.user_id !== effectiveUserId && !isAdmin) {
      return NextResponse.json({ error: 'Not authorized for this registration' }, { status: 403 })
    }

    if (registration.step_completed !== 'finalized') {
      return NextResponse.json(
        { error: 'Top-up is only available after the registration is finalized.' },
        { status: 409 },
      )
    }

    const body = await request.json()
    const {
      add_hall_of_aime = false,
      add_wmn_at_fuse = false,
      add_vetted_va = false,
      add_vip_luncheon = false,
      new_guests = [],
      confirmed_payment_intent_id,
    } = body as {
      add_hall_of_aime?: boolean
      add_wmn_at_fuse?: boolean
      add_vetted_va?: boolean
      add_vip_luncheon?: boolean
      new_guests?: Array<{
        full_name: string
        ticket_type?: string
        is_included?: boolean
        addons?: {
          has_hall_of_aime?: boolean
          has_wmn_at_fuse?: boolean
          has_vetted_va?: boolean
          has_vip_luncheon?: boolean
        }
      }>
      confirmed_payment_intent_id?: string
    }

    // Only flip flags from false to true.
    const willAddHoa = add_hall_of_aime && !registration.has_hall_of_aime
    const willAddWmn = add_wmn_at_fuse && !registration.has_wmn_at_fuse
    const willAddVettedVa = add_vetted_va && !registration.has_vetted_va
    const willAddVipLuncheon = add_vip_luncheon && !registration.has_vip_luncheon
    // GA Plus / upgrade was retired for Fuse 2026 — no upgrade path.
    const willUpgrade = false

    if (
      !willAddHoa &&
      !willAddWmn &&
      !willAddVettedVa &&
      !willAddVipLuncheon &&
      new_guests.length === 0
    ) {
      return NextResponse.json({ error: 'No changes to apply' }, { status: 400 })
    }

    // -------------------------------------------------------------
    // 1. Plan the changes and total cents WITHOUT mutating anything.
    // -------------------------------------------------------------

    const { data: priceRows } = await supabase
      .from('fuse_ticket_prices')
      .select('*')
      .eq('fuse_event_id', registration.fuse_event_id)
      .eq('is_active', true)

    const { data: rules } = await supabase
      .from('fuse_guest_pricing_rules')
      .select('tier, base_product_key, discount_percent')
      .eq('fuse_event_id', registration.fuse_event_id)

    const { data: eventRow } = await supabase
      .from('fuse_events')
      .select('year')
      .eq('id', registration.fuse_event_id)
      .single()

    const { data: existingGuests } = await supabase
      .from('fuse_registration_guests')
      .select('id, is_included, has_hall_of_aime')
      .eq('registration_id', registrationId)
    const existingIncludedCount =
      (existingGuests ?? []).filter((g) => g.is_included === true).length
    const existingGuestHoaIncludedCount =
      (existingGuests ?? []).filter((g) => g.has_hall_of_aime === true).length

    // The main attendee must have an add-on for a guest to opt in. Gate
    // against either the existing registration state OR an add in this
    // same batch (so a user can opt themselves + a guest into HOA in
    // one click).
    const mainHasHoaEffective = registration.has_hall_of_aime || willAddHoa
    const mainHasWmnEffective = registration.has_wmn_at_fuse || willAddWmn
    const mainHasVettedVaEffective = registration.has_vetted_va || willAddVettedVa
    const mainHasVipLuncheonEffective =
      registration.has_vip_luncheon || willAddVipLuncheon
    const sanitizedNewGuests = new_guests.map((g) => ({
      full_name: g.full_name,
      ticket_type: g.ticket_type,
      addons: {
        has_hall_of_aime: !!g.addons?.has_hall_of_aime && mainHasHoaEffective,
        has_wmn_at_fuse: !!g.addons?.has_wmn_at_fuse && mainHasWmnEffective,
        has_vetted_va: !!g.addons?.has_vetted_va && mainHasVettedVaEffective,
        has_vip_luncheon:
          !!g.addons?.has_vip_luncheon && mainHasVipLuncheonEffective,
      },
    }))

    const guestPlan = planGuestPricing({
      tier: registration.tier ?? null,
      rules: rules ?? null,
      prices: priceRows ?? null,
      existingIncludedCount,
      existingGuestHoaIncludedCount,
      newGuests: sanitizedNewGuests,
      eventLabel: `Fuse ${eventRow?.year ?? ''}`.trim(),
    })

    // HOA: tier-specific or public phase-active.
    let hoaCents = 0
    let hoaStripePriceId: string | null = null
    if (willAddHoa) {
      const tierHoa = pickActivePrice(priceRows, 'hoa', registration.tier ?? null)
      const hoaPrice =
        (tierHoa && !tierHoa.is_included && tierHoa.stripe_price_id ? tierHoa : null) ??
        pickActivePrice(priceRows, 'hoa', null)
      if (hoaPrice?.stripe_price_id && !hoaPrice.is_included) {
        hoaStripePriceId = hoaPrice.stripe_price_id
        hoaCents = (hoaPrice.price ?? 0) * 100
      }
    }

    const totalCents = guestPlan.totalCents + hoaCents

    // -------------------------------------------------------------
    // 2. Payment first. If nothing's chargeable, skip straight to write.
    // -------------------------------------------------------------

    let paymentConfirmed = totalCents === 0
    let paymentIntentForResponse: Stripe.PaymentIntent | null = null

    if (totalCents > 0) {
      if (confirmed_payment_intent_id) {
        // 3DS second pass: verify the PI is succeeded and amount matches.
        try {
          const pi = await stripe.paymentIntents.retrieve(confirmed_payment_intent_id)
          if (pi.status !== 'succeeded') {
            return NextResponse.json(
              { error: `Payment not confirmed (status: ${pi.status})` },
              { status: 400 },
            )
          }
          if (pi.amount !== totalCents) {
            return NextResponse.json(
              {
                error:
                  'Payment amount does not match the requested changes. Please refresh and try again.',
              },
              { status: 400 },
            )
          }
          paymentConfirmed = true
          paymentIntentForResponse = pi
        } catch (err: any) {
          return NextResponse.json(
            { error: `Could not verify payment: ${err.message}` },
            { status: 400 },
          )
        }
      } else {
        // First pass: try to charge the customer's default card.
        if (!stripeCustomerId) {
          return NextResponse.json(
            {
              code: 'no_payment_method',
              error: 'No payment method on file. Please add a card first.',
            },
            { status: 402 },
          )
        }

        // Build a short description for the receipt.
        const descParts: string[] = []
        if (willAddHoa) descParts.push('Hall of AIME add-on')
        if (guestPlan.guestsForInsert.filter((g) => !g.is_included).length > 0) {
          descParts.push(
            `${guestPlan.guestsForInsert.filter((g) => !g.is_included).length} guest ticket(s)`,
          )
        }
        const description = `Fuse ${eventRow?.year ?? ''} top-up: ${descParts.join(', ')}`.trim()

        const paymentMethodId = await resolveCustomerPaymentMethodId(stripe, stripeCustomerId)
        if (!paymentMethodId) {
          return NextResponse.json(
            {
              code: 'no_payment_method',
              error: 'No payment method on file. Please add a card first.',
            },
            { status: 402 },
          )
        }

        try {
          const pi = await stripe.paymentIntents.create({
            amount: totalCents,
            currency: 'usd',
            customer: stripeCustomerId,
            payment_method: paymentMethodId,
            description,
            metadata: {
              registration_id: registration.id,
              fuse_event_id: registration.fuse_event_id,
              type: 'fuse_claim_addon',
              source: 'top-up',
            },
            confirm: true,
            automatic_payment_methods: {
              enabled: true,
              allow_redirects: 'never',
            },
          })

          if (pi.status === 'succeeded') {
            paymentConfirmed = true
            paymentIntentForResponse = pi
          } else if (pi.status === 'requires_action') {
            return NextResponse.json({
              requires_action: true,
              client_secret: pi.client_secret,
              payment_intent_id: pi.id,
            })
          } else {
            return NextResponse.json(
              { error: `Payment ${pi.status}. Please try a different card.` },
              { status: 402 },
            )
          }
        } catch (err: any) {
          // Translate "missing payment method" into the no_payment_method
          // contract the client already handles (opens AddCardModal).
          const noPm = handleStripeChargeError(err)
          if (noPm) return noPm
          return NextResponse.json(
            { error: err.message || 'Payment failed. Please try a different card.' },
            { status: 402 },
          )
        }
      }
    }

    if (!paymentConfirmed) {
      // Defensive — we should have hit a return by now.
      return NextResponse.json({ error: 'Unexpected payment state' }, { status: 500 })
    }

    // -------------------------------------------------------------
    // 3. Payment is confirmed (or no payment needed). Write changes.
    // Track failures so we can skip the GHL drop if anything fell over.
    // -------------------------------------------------------------

    let writeFailed = false

    if (willAddHoa || willAddWmn || willAddVettedVa || willAddVipLuncheon || willUpgrade) {
      const regUpdate: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (willAddHoa) regUpdate.has_hall_of_aime = true
      if (willAddWmn) regUpdate.has_wmn_at_fuse = true
      if (willAddVettedVa) regUpdate.has_vetted_va = true
      if (willAddVipLuncheon) regUpdate.has_vip_luncheon = true

      const { error: updateError } = await supabase
        .from('fuse_registrations')
        .update(regUpdate)
        .eq('id', registrationId)

      if (updateError) {
        console.error('Error updating registration after payment:', updateError)
        writeFailed = true
      }
    }

    if (guestPlan.guestsForInsert.length > 0) {
      const { error: guestError } = await supabase
        .from('fuse_registration_guests')
        .insert(
          guestPlan.guestsForInsert.map((g) => ({
            registration_id: registrationId,
            full_name: g.full_name,
            email: null,
            ticket_type: g.ticket_type,
            is_included: g.is_included,
            has_hall_of_aime: g.has_hall_of_aime,
            has_wmn_at_fuse: g.has_wmn_at_fuse,
            has_vetted_va: g.has_vetted_va,
            has_vip_luncheon: g.has_vip_luncheon,
          })),
        )
      if (guestError) {
        console.error('Error inserting guests after payment:', guestError)
        writeFailed = true
      }
    }

    // GHL tags for newly-added add-ons (skip admin test registrations).
    const anyFlagAdded = willAddHoa || willAddWmn || willAddVettedVa || willAddVipLuncheon
    if (registration.ghl_contact_id && !isAdmin && anyFlagAdded) {
      try {
        if (eventRow?.year) {
          const tags: string[] = []
          if (willAddHoa) tags.push(`fuse-${eventRow.year}-hall-of-aime`)
          if (willAddWmn) tags.push(`fuse-${eventRow.year}-wmn`)
          if (willAddVettedVa) tags.push(`fuse-${eventRow.year}-vetted-va`)
          if (willAddVipLuncheon) tags.push(`fuse-${eventRow.year}-vip-luncheon`)
          await Promise.all(
            tags.map((tag) =>
              ghlClient.addTagToContact(registration.ghl_contact_id as string, tag),
            ),
          )
        }
      } catch (tagError) {
        console.error('Error adding GHL tags:', tagError)
      }
    }

    // Fire Fuse Opportunity webhook push for the top-up (incremental change).
    // Drop on any meaningful state change: new add-ons, GA Plus upgrade,
    // or new guests. Skip when our DB writes failed — we don't want to
    // push state that isn't actually persisted.
    const anyGuestsAdded = guestPlan.guestsForInsert.length > 0
    if (
      shouldDropFuseRegistration(isAdmin) &&
      !writeFailed &&
      (anyFlagAdded || willUpgrade || anyGuestsAdded)
    ) {
      try {
        // Fetch the full guest list (existing + just-inserted) for the payload.
        const { data: allGuests } = await supabase
          .from('fuse_registration_guests')
          .select(
            'full_name, ticket_type, is_included, has_hall_of_aime, has_wmn_at_fuse, has_vetted_va, has_vip_luncheon',
          )
          .eq('registration_id', registrationId)

        await dropFuseRegistration({
          registration_id: registration.id,
          fuse_event_id: registration.fuse_event_id,
          fuse_event_year: eventRow?.year ?? null,
          ghl_contact_id: registration.ghl_contact_id ?? null,
          full_name: registration.full_name ?? effectiveProfile?.full_name ?? '',
          email: registration.email,
          phone: registration.phone ?? effectiveProfile?.phone ?? null,
          company: effectiveProfile?.company ?? null,
          nmls_number: effectiveProfile?.nmls_number ?? null,
          plan_tier: effectiveProfile?.plan_tier ?? null,
          billing_period: effectiveProfile?.billing_period ?? null,
          ticket_type: registration.ticket_type,
          tier: registration.tier,
          // Use the actual purchase_type on the row (paid monthly
          // reservations are 'purchased'/'pending', not 'claimed').
          purchase_type: registration.purchase_type,
          has_hall_of_aime: registration.has_hall_of_aime || willAddHoa,
          has_wmn_at_fuse: registration.has_wmn_at_fuse || willAddWmn,
          has_vetted_va: registration.has_vetted_va || willAddVettedVa,
          has_vip_luncheon: registration.has_vip_luncheon || willAddVipLuncheon,
          guests: (allGuests ?? []).map((g) => ({
            full_name: g.full_name,
            ticket_type: g.ticket_type,
            is_included: g.is_included,
            has_hall_of_aime: g.has_hall_of_aime,
            has_wmn_at_fuse: g.has_wmn_at_fuse,
            has_vetted_va: g.has_vetted_va,
            has_vip_luncheon: g.has_vip_luncheon,
          })),
          pricing_phase: null,
          total_paid_cents: totalCents,
          invoice_number: paymentIntentForResponse?.id ?? null,
          created_at: new Date().toISOString(),
        }, 'update')
      } catch (dropErr) {
        console.error('Fuse GHL drop failed (non-fatal):', dropErr)
      }
    }

    return NextResponse.json({
      success: true,
      registration_id: registration.id,
      payment_intent_id: paymentIntentForResponse?.id ?? null,
      // Silence unused-var lint for hoaStripePriceId; kept for potential
      // future audit / receipt logging.
      ...(hoaStripePriceId ? { hoa_stripe_price_id: hoaStripePriceId } : {}),
      ...(writeFailed
        ? { warning: 'Payment received but some updates did not save. Please contact support.' }
        : {}),
    })
  } catch (error: any) {
    console.error('Error in top-up registration:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 },
    )
  }
}
