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
 * POST /api/fuse-registration/[id]/finalize
 *
 * Phase 7b.2 + 8a: takes a claimed (step_completed='claim') registration
 * and writes the optional add-ons / guests / marketing_consent, marking
 * the registration finalized.
 *
 * Charge model (mirrors top-up + purchase-escalations):
 *   - Payment runs FIRST via a server-confirmed PaymentIntent against
 *     the customer's default card.
 *   - Registration row + guests are not mutated until the PaymentIntent
 *     reaches status='succeeded'.
 *   - `requires_action` returns a client_secret for 3DS; client retries
 *     with `confirmed_payment_intent_id` to apply the changes.
 *   - No payment method on file → 402 + `code: 'no_payment_method'`.
 *
 * Already-finalized registrations are rejected (use top-up instead).
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
      .select('is_admin')
      .eq('id', user.id)
      .single()
    const isAdmin = adminProfile?.is_admin === true

    // Pre-go-live: non-admins get a 404 until FUSE_LIVE=true.
    if (!canSeeFuse(isAdmin)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const { data: effectiveProfile } = await supabase
      .from('profiles')
      .select('stripe_customer_id, full_name, phone, company, plan_tier, billing_period, nmls_number')
      .eq('id', effectiveUserId)
      .single()
    const stripeCustomerId = effectiveProfile?.stripe_customer_id ?? null

    const { data: registration, error: regFetchError } = await supabase
      .from('fuse_registrations')
      .select(
        'id, fuse_event_id, user_id, email, tier, ticket_type, purchase_type, step_completed, ghl_contact_id, full_name, phone',
      )
      .eq('id', registrationId)
      .single()

    if (regFetchError || !registration) {
      return NextResponse.json({ error: 'Registration not found' }, { status: 404 })
    }

    if (registration.user_id !== effectiveUserId && !isAdmin) {
      return NextResponse.json({ error: 'Not authorized for this registration' }, { status: 403 })
    }

    if (registration.step_completed === 'finalized') {
      return NextResponse.json(
        { error: 'Registration is already finalized. Use the manage flow to add more.' },
        { status: 409 },
      )
    }

    const body = await request.json()
    const {
      has_hall_of_aime = false,
      has_wmn_at_fuse = false,
      has_vetted_va = false,
      has_vip_luncheon = false,
      marketing_consent = false,
      guests = [],
      confirmed_payment_intent_id,
    } = body as {
      has_hall_of_aime?: boolean
      has_wmn_at_fuse?: boolean
      has_vetted_va?: boolean
      has_vip_luncheon?: boolean
      marketing_consent?: boolean
      guests?: Array<{
        full_name: string
        email?: string | null
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
    // GA Plus / upgrade was removed for Fuse 2026; we no longer accept
    // an `add_upgrade` flag from the client.

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

    // Finalize is the first-batch path: no prior guests, so the
    // included-guest counters start at 0.
    //
    // Gate per-guest add-ons by what the main is selecting in this same
    // finalize call (registration row hasn't been written yet).
    const sanitizedGuests = guests.map((g) => ({
      full_name: g.full_name,
      ticket_type: g.ticket_type,
      addons: {
        has_hall_of_aime: !!g.addons?.has_hall_of_aime && has_hall_of_aime,
        has_wmn_at_fuse: !!g.addons?.has_wmn_at_fuse && has_wmn_at_fuse,
        has_vetted_va: !!g.addons?.has_vetted_va && has_vetted_va,
        has_vip_luncheon: !!g.addons?.has_vip_luncheon && has_vip_luncheon,
      },
    }))
    const guestPlan = planGuestPricing({
      tier: registration.tier ?? null,
      rules: rules ?? null,
      prices: priceRows ?? null,
      existingIncludedCount: 0,
      existingGuestHoaIncludedCount: 0,
      newGuests: sanitizedGuests,
      eventLabel: `Fuse ${eventRow?.year ?? ''}`.trim(),
    })

    let hoaCents = 0
    if (has_hall_of_aime) {
      const tierHoa = pickActivePrice(priceRows, 'hoa', registration.tier ?? null)
      const hoaPrice =
        (tierHoa && !tierHoa.is_included && tierHoa.stripe_price_id ? tierHoa : null) ??
        pickActivePrice(priceRows, 'hoa', null)
      if (hoaPrice?.stripe_price_id && !hoaPrice.is_included) {
        hoaCents = (hoaPrice.price ?? 0) * 100
      }
    }

    // Monthly buyer finalizing a paid reservation: the registration
    // row exists at step_completed='claim' with purchase_type='pending'
    // (legacy rows may still read 'purchased' if the migration didn't
    // touch them), but the main GA ticket hasn't been charged yet.
    let mainTicketCents = 0
    const isPaidReservation =
      registration.purchase_type === 'pending' ||
      registration.purchase_type === 'purchased'
    if (isPaidReservation) {
      const mainPrice = pickActivePrice(priceRows, 'ga', null)
      mainTicketCents = (mainPrice?.price ?? 0) * 100
    }

    const totalCents = guestPlan.totalCents + hoaCents + mainTicketCents

    // -------------------------------------------------------------
    // 2. Payment first. If nothing's chargeable, skip straight to write.
    // -------------------------------------------------------------

    let paymentConfirmed = totalCents === 0
    let paymentIntentForResponse: Stripe.PaymentIntent | null = null

    if (totalCents > 0) {
      if (confirmed_payment_intent_id) {
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
              { error: 'Payment amount does not match the requested changes. Please refresh and try again.' },
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
        if (!stripeCustomerId) {
          return NextResponse.json(
            {
              code: 'no_payment_method',
              error: 'No payment method on file. Please add a card first.',
            },
            { status: 402 },
          )
        }

        const descParts: string[] = []
        if (has_hall_of_aime) descParts.push('Hall of AIME add-on')
        const paidGuestCount = guestPlan.guestsForInsert.filter((g) => !g.is_included).length
        if (paidGuestCount > 0) descParts.push(`${paidGuestCount} guest ticket(s)`)
        const description = `Fuse ${eventRow?.year ?? ''} finalize: ${descParts.join(', ')}`.trim()

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
              source: 'finalize',
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
      return NextResponse.json({ error: 'Unexpected payment state' }, { status: 500 })
    }

    // -------------------------------------------------------------
    // 3. Payment confirmed (or nothing to charge). Write changes.
    //
    // Track any write failures so we can skip the downstream GHL drop —
    // we don't want to push state to AIME that didn't actually persist
    // in our DB. Payment already succeeded by this point, so we can't
    // fail the request entirely, but we *do* surface a 500 so the
    // client knows something is wrong (it can prompt support).
    // -------------------------------------------------------------

    let writeFailed = false

    // Payment just succeeded, so a 'pending' reservation becomes a real
    // 'purchased' ticket. Hold the effective value locally so the GHL
    // drop below sees the post-update state without re-reading the row.
    const effectivePurchaseType =
      registration.purchase_type === 'pending'
        ? 'purchased'
        : registration.purchase_type

    const regUpdate: Record<string, unknown> = {
      has_hall_of_aime,
      has_wmn_at_fuse,
      has_vetted_va,
      has_vip_luncheon,
      marketing_consent,
      step_completed: 'finalized',
      updated_at: new Date().toISOString(),
    }
    if (registration.purchase_type === 'pending') {
      regUpdate.purchase_type = 'purchased'
    }

    const { error: updateError } = await supabase
      .from('fuse_registrations')
      .update(regUpdate)
      .eq('id', registrationId)

    if (updateError) {
      console.error('Error finalizing registration after payment:', updateError)
      writeFailed = true
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

    // Mark the member's profile as "has a Fuse ticket this year" so the
    // dashboard banner + sidebar Fuse link key off it correctly. Only
    // needed for non-admin users (admin test rows are excluded from
    // that UI anyway).
    if (!isAdmin && eventRow?.year && registration.user_id) {
      const { error: profileError } = await supabase
        .from('profiles')
        .update({ fuse_ticket_claimed_year: eventRow.year })
        .eq('id', registration.user_id)
      if (profileError) {
        console.error('Error updating profile fuse_ticket_claimed_year:', profileError)
        // Don't flip writeFailed — the registration is sound; the
        // banner just won't auto-hide. Surfacing this in logs only.
      }
    }

    // GHL tags (skip admin test registrations).
    if (registration.ghl_contact_id && !isAdmin) {
      try {
        if (eventRow?.year) {
          const tags: string[] = []
          if (has_hall_of_aime) tags.push(`fuse-${eventRow.year}-hall-of-aime`)
          if (has_wmn_at_fuse) tags.push(`fuse-${eventRow.year}-wmn`)
          if (has_vetted_va) tags.push(`fuse-${eventRow.year}-vetted-va`)
          if (has_vip_luncheon) tags.push(`fuse-${eventRow.year}-vip-luncheon`)
          if (tags.length > 0) {
            await Promise.all(
              tags.map((tag) =>
                ghlClient.addTagToContact(registration.ghl_contact_id as string, tag),
              ),
            )
          }
        }
      } catch (tagError) {
        console.error('Error adding GHL tags:', tagError)
      }
    }

    // Fire Fuse Opportunity webhook push. Only when DB writes succeeded
    // so AIME doesn't receive state that didn't persist on our side.
    //
    // Annual claimers already received a 'new' drop from the claim
    // route — this finalize call is an UPDATE for them. Monthly buyers
    // skipped the claim drop (auto-reservation), so this is their
    // first push and rates as NEW.
    const finalizeDropEvent =
      effectivePurchaseType === 'claimed' ? 'update' : 'new'
    if (shouldDropFuseRegistration(isAdmin) && !writeFailed) {
      try {
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
          purchase_type: effectivePurchaseType,
          has_hall_of_aime,
          has_wmn_at_fuse,
          has_vetted_va,
          has_vip_luncheon,
          guests: guestPlan.guestsForInsert.map((g) => ({
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
        }, finalizeDropEvent)
      } catch (dropErr) {
        console.error('Fuse GHL drop failed (non-fatal):', dropErr)
      }
    }

    return NextResponse.json({
      success: true,
      registration_id: registration.id,
      payment_intent_id: paymentIntentForResponse?.id ?? null,
      // Surface partial-write state so the client can prompt the user
      // to contact support. We can't fail the request — payment already
      // succeeded — but we shouldn't pretend everything is fine.
      ...(writeFailed
        ? { warning: 'Payment received but some registration details did not save. Please contact support.' }
        : {}),
    })
  } catch (error: any) {
    console.error('Error in finalize registration:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 },
    )
  }
}
