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

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    // Get authenticated user
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Check for impersonation mode
    const impersonationSettings = await getImpersonationSettings()
    const isImpersonating = impersonationSettings?.isImpersonating && impersonationSettings?.impersonatedUserId
    const effectiveUserId = isImpersonating ? impersonationSettings.impersonatedUserId : user.id

    // Get user profile (use impersonated user's profile if impersonating)
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, email, full_name, phone, company, plan_tier, billing_period, nmls_number, ghl_contact_id, stripe_customer_id')
      .eq('id', effectiveUserId)
      .single()

    if (!profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
    }

    // Check if user is admin (admins can register for testing regardless of tier)
    const { data: adminProfile } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', user.id)
      .single()
    const isAdmin = adminProfile?.is_admin === true

    // Pre-go-live: non-admins get a 404 so we don't leak that this
    // endpoint exists until FUSE_LIVE=true.
    if (!canSeeFuse(isAdmin)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Check eligibility (admins bypass tier check)
    const eligibleTiers = ['Premium', 'Elite', 'VIP']
    if (!isAdmin && (!profile.plan_tier || !eligibleTiers.includes(profile.plan_tier))) {
      return NextResponse.json(
        { error: 'Your membership tier does not include a Fuse ticket' },
        { status: 403 }
      )
    }

    // Parse request body
    const body = await request.json()
    const {
      fuse_event_id,
      // `step` controls whether this call only claims (creates the
      // registration row and stops) or finalizes (also writes add-ons /
      // guests / Stripe). Default 'claim' so the simple member click-to-
      // claim flow works with a minimal payload.
      step = 'claim',
      ticket_type,
      // GA Plus upgrade (Phase 7b.4): Premium / Elite member explicitly
      // opts to pay the full GA Plus price instead of claiming their
      // included GA. When true: ticket_type forced to 'general_admission_plus',
      // purchase_type recorded as 'upgraded', and the GA Plus active-phase
      // price is added to totalCents.
      is_upgrade = false,
      has_hall_of_aime = false,
      has_wmn_at_fuse = false,
      has_vetted_va = false,
      has_vip_luncheon = false,
      marketing_consent = false,
      guests = [],
      // The following are optional on `step='claim'`; fall back to the
      // member's profile data when not supplied.
      first_name: bodyFirstName,
      last_name: bodyLastName,
      preferred_name,
      phone: bodyPhone,
      email: bodyEmail,
      company: bodyCompany,
      gender: bodyGender,
      fuse_attendance: bodyFuseAttendance,
      // 3DS second pass for the legacy step='finalize' path: skip PI
      // creation, verify the existing PI, then perform the insert.
      confirmed_payment_intent_id,
    } = body

    if (!['claim', 'finalize'].includes(step)) {
      return NextResponse.json({ error: 'Invalid step' }, { status: 400 })
    }

    // Pull profile fallbacks for the no-form-fill claim flow.
    const profileFirst = profile.full_name?.split(' ')[0] ?? ''
    const profileLast = profile.full_name?.split(' ').slice(1).join(' ') ?? ''
    const first_name = (bodyFirstName ?? profileFirst).trim()
    const last_name = (bodyLastName ?? profileLast).trim()
    const phone = bodyPhone ?? profile.phone ?? ''
    const email = bodyEmail ?? profile.email ?? ''
    const company = bodyCompany ?? profile.company ?? ''
    const gender = bodyGender ?? null
    const fuse_attendance = bodyFuseAttendance ?? null

    // Validation
    if (!fuse_event_id) {
      return NextResponse.json({ error: 'Event ID required' }, { status: 400 })
    }
    if (!first_name || !last_name) {
      return NextResponse.json(
        { error: 'Name not set on your profile. Update your profile and try again.' },
        { status: 400 },
      )
    }
    // Email is required (it's the registration's contact); phone is
    // optional at claim time. The post-checkout onboarding wedge runs
    // before complete-profile, so phone may not be filled in yet — we
    // collect it on the complete-profile form and the user can update
    // their registration later via the manage panel.
    if (!email) {
      return NextResponse.json(
        { error: 'Email must be set on your profile.' },
        { status: 400 },
      )
    }

    // Get the event
    const { data: event } = await supabase
      .from('fuse_events')
      .select('id, year, name')
      .eq('id', fuse_event_id)
      .eq('is_active', true)
      .single()

    if (!event) {
      return NextResponse.json(
        { error: 'Event not found or not active' },
        { status: 404 }
      )
    }

    // Check for existing registration
    const { data: existingReg } = await supabase
      .from('fuse_registrations')
      .select('id')
      .eq('fuse_event_id', fuse_event_id)
      .eq('user_id', effectiveUserId)
      .single()

    if (existingReg) {
      return NextResponse.json(
        { error: 'You are already registered for this event' },
        { status: 400 }
      )
    }

    // Free-claim eligibility: annual Premium / Elite / VIP. Anyone else
    // (monthly any tier, free trial, etc.) is buying, not claiming.
    // Admins always free-claim for testing.
    const eligibleTier =
      profile.plan_tier === 'Premium' ||
      profile.plan_tier === 'Elite' ||
      profile.plan_tier === 'VIP'
    const isAnnual = (profile.billing_period ?? '').toLowerCase() === 'annual'
    const isFreeClaim = isAdmin || (eligibleTier && isAnnual)

    // VIP ticket gating: only annual VIP members (or admins) can take a
    // VIP ticket. Monthly VIP can't buy or claim VIP — they have to
    // purchase GA like Premium / Elite monthly.
    if (ticket_type === 'vip' && !(isFreeClaim && profile.plan_tier === 'VIP')) {
      return NextResponse.json(
        { error: 'VIP tickets are reserved for annual VIP members.' },
        { status: 403 }
      )
    }

    // General Admission Plus was retired for Fuse 2026. Reject any
    // attempt to create one or to upgrade into one.
    if (ticket_type === 'general_admission_plus' || is_upgrade) {
      return NextResponse.json(
        { error: 'General Admission Plus is no longer available for Fuse 2026.' },
        { status: 410 },
      )
    }

    // Determine the correct ticket type. Free claimers get their tier-
    // entitled ticket; paid buyers get whatever they requested (validated
    // to GA only — VIP is gated above, GA Plus rejected above).
    let actualTicketType = ticket_type || 'general_admission'
    if (isFreeClaim && profile.plan_tier === 'VIP') {
      actualTicketType = 'vip'
    } else if (isFreeClaim && (profile.plan_tier === 'Premium' || profile.plan_tier === 'Elite')) {
      actualTicketType = 'general_admission'
    } else if (isFreeClaim) {
      // Admin (no tier) free-claim defaults to GA for testing
      actualTicketType = 'general_admission'
    }
    // else: paid buyer — keep `actualTicketType` from the request body.

    const fullName = `${first_name} ${last_name}`.trim()

    // -------------------------------------------------------------
    // For step='finalize': plan guests + compute total, then charge
    // BEFORE inserting the registration row. For step='claim' or any
    // free-total path, skip straight to insert.
    // -------------------------------------------------------------

    let guestPlan: ReturnType<typeof planGuestPricing> | null = null
    let totalCents = 0
    let priceRows: any[] | null = null

    if (step === 'finalize') {
      const { data: rows } = await supabase
        .from('fuse_ticket_prices')
        .select('*')
        .eq('fuse_event_id', fuse_event_id)
        .eq('is_active', true)
      priceRows = rows ?? null

      const { data: rules } = await supabase
        .from('fuse_guest_pricing_rules')
        .select('tier, base_product_key, discount_percent')
        .eq('fuse_event_id', fuse_event_id)

      // Per-guest add-on gating: a guest can only opt into an add-on if
      // the main attendee is also selecting it in this same finalize.
      // VIP claims auto-include HOA on the registration (see isVipMemberClaim
      // below) so guest HOA gating must mirror that.
      const isVipMemberClaimForGuests = actualTicketType === 'vip'
      const mainHasHoaEffective = !!has_hall_of_aime || isVipMemberClaimForGuests
      const sanitizedGuests = guests.map((g: any) => ({
        full_name: g.full_name,
        ticket_type: g.ticket_type,
        addons: {
          has_hall_of_aime: !!g.addons?.has_hall_of_aime && mainHasHoaEffective,
          has_wmn_at_fuse: !!g.addons?.has_wmn_at_fuse && !!has_wmn_at_fuse,
          has_vetted_va: !!g.addons?.has_vetted_va && !!has_vetted_va,
          has_vip_luncheon: !!g.addons?.has_vip_luncheon && !!has_vip_luncheon,
        },
      }))

      guestPlan = planGuestPricing({
        tier: (profile.plan_tier as string | null) ?? null,
        rules: rules ?? null,
        prices: priceRows ?? null,
        existingIncludedCount: 0,
        existingGuestHoaIncludedCount: 0,
        newGuests: sanitizedGuests,
        eventLabel: `Fuse ${event.year}`,
      })

      let hoaCents = 0
      if (has_hall_of_aime) {
        const tierHoa = pickActivePrice(priceRows, 'hoa', profile.plan_tier ?? null)
        const hoaPrice =
          (tierHoa && !tierHoa.is_included && tierHoa.stripe_price_id ? tierHoa : null) ??
          pickActivePrice(priceRows, 'hoa', null)
        if (hoaPrice?.stripe_price_id && !hoaPrice.is_included) {
          hoaCents = (hoaPrice.price ?? 0) * 100
        }
      }

      // Monthly buyer flow: charge full active-phase public GA price.
      // Annual members claim free and skip this.
      let mainTicketCents = 0
      if (!isFreeClaim) {
        const mainPrice = pickActivePrice(priceRows, 'ga', null)
        mainTicketCents = (mainPrice?.price ?? 0) * 100
      }

      totalCents = guestPlan.totalCents + hoaCents + mainTicketCents
    }

    // -------------------------------------------------------------
    // Payment phase (step='finalize' with totalCents > 0). For
    // step='claim' or free-total this whole block is skipped.
    // -------------------------------------------------------------

    let paymentIntentForResponse: Stripe.PaymentIntent | null = null

    if (step === 'finalize' && totalCents > 0) {
      const stripeCustomerId = profile.stripe_customer_id ?? null

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
        const paidGuestCount = guestPlan?.guestsForInsert.filter((g) => !g.is_included).length ?? 0
        if (paidGuestCount > 0) descParts.push(`${paidGuestCount} guest ticket(s)`)
        const description = `Fuse ${event.year} claim+finalize: ${descParts.join(', ')}`.trim()

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
              fuse_event_id,
              type: 'fuse_claim_addon',
              source: 'claim_finalize',
            },
            confirm: true,
            automatic_payment_methods: {
              enabled: true,
              allow_redirects: 'never',
            },
          })

          if (pi.status === 'succeeded') {
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

    // -------------------------------------------------------------
    // Insert registration (after payment succeeds, or unconditionally
    // for step='claim' / free-total).
    // -------------------------------------------------------------

    // VIP membership entitlement: 2 VIP tickets + 2 Hall of AIME tickets
    // included. The HOA flag is auto-set on every VIP claim/finalize so
    // the member never sees a charge for HOA. Premium / Elite still pay
    // for HOA as an add-on.
    const isVipMemberClaim = actualTicketType === 'vip'
    const insertHoa = (step === 'finalize' ? has_hall_of_aime : false) || isVipMemberClaim
    const insertWmn = step === 'finalize' ? has_wmn_at_fuse : false
    const insertVettedVa = step === 'finalize' ? has_vetted_va : false
    const insertVipLuncheon = step === 'finalize' ? has_vip_luncheon : false
    const insertMarketing = step === 'finalize' ? marketing_consent : false

    const { data: registration, error: regError } = await supabase
      .from('fuse_registrations')
      .insert({
        fuse_event_id,
        user_id: effectiveUserId,
        full_name: fullName,
        first_name,
        last_name,
        preferred_name: preferred_name || null,
        email: email.toLowerCase(),
        phone,
        company,
        gender,
        fuse_attendance,
        ticket_type: actualTicketType,
        // tier_check constraint only accepts these values or NULL.
        // Admins (and any profile with an unexpected plan_tier) land at NULL.
        tier: ['Premium', 'Elite', 'VIP'].includes(profile.plan_tier as string)
          ? profile.plan_tier
          : null,
        purchase_type: isFreeClaim ? 'claimed' : 'purchased',
        has_hall_of_aime: insertHoa,
        has_wmn_at_fuse: insertWmn,
        has_vetted_va: insertVettedVa,
        has_vip_luncheon: insertVipLuncheon,
        marketing_consent: insertMarketing,
        step_completed: step === 'finalize' ? 'finalized' : 'claim',
        ghl_contact_id: profile.ghl_contact_id,
        registration_source: isAdmin ? 'admin_manual' : 'ghl_form',
      })
      .select()
      .single()

    if (regError) {
      console.error('Error creating registration:', regError)
      return NextResponse.json(
        { error: 'Failed to create registration' },
        { status: 500 }
      )
    }

    // Insert guests (finalize path only)
    if (step === 'finalize' && guestPlan && guestPlan.guestsForInsert.length > 0) {
      const { error: guestError } = await supabase
        .from('fuse_registration_guests')
        .insert(
          guestPlan.guestsForInsert.map((g) => ({
            registration_id: registration.id,
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
        console.error('Error inserting guests:', guestError)
      }
    }

    // Update profile's fuse_ticket_claimed_year
    await supabase
      .from('profiles')
      .update({ fuse_ticket_claimed_year: event.year })
      .eq('id', effectiveUserId)

    // Add GHL tags (skip for admin test registrations)
    const contactId = profile.ghl_contact_id
    if (contactId && !isAdmin) {
      try {
        const tags = [`fuse-${event.year}-registered`]
        if (actualTicketType === 'vip') {
          tags.push(`fuse-${event.year}-vip`)
        }
        if (insertHoa) {
          tags.push(`fuse-${event.year}-hall-of-aime`)
        }
        if (insertWmn) {
          tags.push(`fuse-${event.year}-wmn`)
        }
        if (insertVettedVa) {
          tags.push(`fuse-${event.year}-vetted-va`)
        }
        if (insertVipLuncheon) {
          tags.push(`fuse-${event.year}-vip-luncheon`)
        }
        await Promise.all(tags.map((tag) => ghlClient.addTagToContact(contactId, tag)))
      } catch (tagError) {
        console.error('Error adding GHL tags:', tagError)
      }
    }

    // Fire the Fuse 2026 Opportunity webhook push.
    // Best-effort; failures are logged but don't fail the registration.
    if (shouldDropFuseRegistration(isAdmin)) {
      try {
        await dropFuseRegistration({
          registration_id: registration.id,
          fuse_event_id,
          fuse_event_year: event.year,
          ghl_contact_id: profile.ghl_contact_id ?? null,
          full_name: fullName,
          email: email.toLowerCase(),
          phone,
          company: profile.company ?? null,
          nmls_number: profile.nmls_number ?? null,
          plan_tier: profile.plan_tier ?? null,
          billing_period: profile.billing_period ?? null,
          ticket_type: actualTicketType,
          tier: ['Premium', 'Elite', 'VIP'].includes(profile.plan_tier as string)
            ? profile.plan_tier
            : null,
          purchase_type: isFreeClaim ? 'claimed' : 'purchased',
          has_hall_of_aime: insertHoa,
          has_wmn_at_fuse: insertWmn,
          has_vetted_va: insertVettedVa,
          has_vip_luncheon: insertVipLuncheon,
          guests: guestPlan?.guestsForInsert.map((g) => ({
            full_name: g.full_name,
            ticket_type: g.ticket_type,
            is_included: g.is_included,
            has_hall_of_aime: g.has_hall_of_aime,
            has_wmn_at_fuse: g.has_wmn_at_fuse,
            has_vetted_va: g.has_vetted_va,
            has_vip_luncheon: g.has_vip_luncheon,
          })) ?? [],
          pricing_phase: null,
          total_paid_cents: totalCents,
          invoice_number: paymentIntentForResponse?.id ?? null,
          created_at: registration.created_at ?? new Date().toISOString(),
        })
      } catch (dropErr) {
        console.error('Fuse GHL drop failed (non-fatal):', dropErr)
      }
    }

    return NextResponse.json({
      success: true,
      registration_id: registration.id,
      payment_intent_id: paymentIntentForResponse?.id ?? null,
    })
  } catch (error: any) {
    console.error('Error in claim registration:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    )
  }
}
