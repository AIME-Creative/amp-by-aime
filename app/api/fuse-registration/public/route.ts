import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe'
import { pickActivePrice } from '@/lib/fuse/pricing'
import { isFuseLive } from '@/lib/fuse/visibility'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

export async function POST(request: NextRequest) {
  try {
    // Pre-go-live: public Fuse purchases are not yet available.
    // 404 (not 403) so we don't leak that the endpoint exists.
    if (!isFuseLive()) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const body = await request.json()
    const {
      fuse_event_id,
      first_name,
      last_name,
      preferred_name,
      phone,
      email,
      company,
      gender,
      fuse_attendance,
      ticket_type,
      has_hall_of_aime = false,
      has_wmn_at_fuse = false,
      guests = [],
    } = body

    // Validation
    if (!fuse_event_id) {
      return NextResponse.json({ error: 'Event ID required' }, { status: 400 })
    }
    if (!first_name || !last_name) {
      return NextResponse.json({ error: 'First and last name required' }, { status: 400 })
    }
    if (!phone || !email || !company) {
      return NextResponse.json({ error: 'Phone, email, and company required' }, { status: 400 })
    }
    if (!gender || !fuse_attendance) {
      return NextResponse.json({ error: 'Gender and attendance info required' }, { status: 400 })
    }
    if (!ticket_type) {
      return NextResponse.json({ error: 'Ticket type required' }, { status: 400 })
    }

    // VIP tickets are claimable by VIP members only; the public flow has
    // no member context, so VIP is never sellable here.
    if (ticket_type === 'vip') {
      return NextResponse.json(
        { error: 'VIP tickets are reserved for VIP members and cannot be purchased here.' },
        { status: 403 },
      )
    }

    // Verify event exists and is active
    const { data: event, error: eventError } = await supabase
      .from('fuse_events')
      .select('id, year, name, registration_open')
      .eq('id', fuse_event_id)
      .eq('is_active', true)
      .single()

    if (!event || eventError) {
      return NextResponse.json({ error: 'Event not found or not active' }, { status: 404 })
    }

    if (event.registration_open === false) {
      return NextResponse.json({ error: 'Registration is not open' }, { status: 400 })
    }

    // Check for existing registration by email
    const { data: existingReg } = await supabase
      .from('fuse_registrations')
      .select('id')
      .eq('fuse_event_id', fuse_event_id)
      .eq('email', email.toLowerCase())
      .single()

    if (existingReg) {
      return NextResponse.json(
        { error: 'This email is already registered for this event' },
        { status: 400 }
      )
    }

    // Fetch public prices from fuse_ticket_prices for this event
    const { data: allPrices } = await supabase
      .from('fuse_ticket_prices')
      .select('*')
      .eq('fuse_event_id', fuse_event_id)
      .is('tier', null)
      .eq('is_active', true)

    // Phase-aware lookup: returns the active row given the current time.
    const activeGA = pickActivePrice(allPrices, 'ga', null)
    const hoaPrice = pickActivePrice(allPrices, 'hoa', null)

    const fullName = `${first_name} ${last_name}`.trim()

    // Create registration record
    const { data: registration, error: regError } = await supabase
      .from('fuse_registrations')
      .insert({
        fuse_event_id,
        user_id: null,
        full_name: fullName,
        first_name,
        last_name,
        preferred_name: preferred_name || null,
        email: email.toLowerCase(),
        phone,
        company,
        gender,
        fuse_attendance,
        ticket_type,
        tier: null,
        purchase_type: 'purchased',
        has_hall_of_aime,
        has_wmn_at_fuse,
        marketing_consent: false,
        registration_source: 'admin_manual',
      })
      .select()
      .single()

    if (regError) {
      console.error('Error creating registration:', regError)
      return NextResponse.json({ error: 'Failed to create registration' }, { status: 500 })
    }

    // Insert guest records
    if (guests.length > 0) {
      const guestRecords = guests.map((guest: any) => ({
        registration_id: registration.id,
        full_name: guest.full_name,
        email: guest.email || null,
        phone: guest.phone || null,
        ticket_type: guest.ticket_type || 'general_admission',
        is_included: false,
      }))

      const { error: guestError } = await supabase
        .from('fuse_registration_guests')
        .insert(guestRecords)

      if (guestError) {
        console.error('Error inserting guests:', guestError)
      }
    }

    // Build Stripe line items from DB prices
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = []

    // Main ticket
    if (activeGA?.stripe_price_id) {
      lineItems.push({ price: activeGA.stripe_price_id, quantity: 1 })
    }

    // Hall of AIME add-on
    if (has_hall_of_aime && hoaPrice?.stripe_price_id) {
      lineItems.push({ price: hoaPrice.stripe_price_id, quantity: 1 })
    }

    // Create Stripe checkout session if there are paid items
    if (lineItems.length > 0) {
      const origin = request.headers.get('origin') || process.env.NEXT_PUBLIC_APP_URL || ''

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: lineItems,
        customer_email: email.toLowerCase(),
        metadata: {
          registration_id: registration.id,
          fuse_event_id,
          type: 'fuse_registration',
        },
        success_url: `${origin}/fuse/checkout/success?registration_id=${registration.id}`,
        cancel_url: `${origin}/fuse/checkout?canceled=true`,
      })

      return NextResponse.json({
        success: true,
        registration_id: registration.id,
        checkout_url: session.url,
      })
    }

    // No paid items (shouldn't happen for public checkout, but handle gracefully)
    return NextResponse.json({
      success: true,
      registration_id: registration.id,
    })
  } catch (error: any) {
    console.error('Error in public fuse registration:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    )
  }
}
