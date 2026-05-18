import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { ghlClient } from '@/lib/ghl/client'
import { dropFuseRegistration } from '@/lib/fuse/ghl-drop'

// Use service role for webhook operations
function getSupabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

interface GHLFormPayload {
  contact_id?: string
  first_name?: string
  last_name?: string
  full_name?: string
  email?: string
  phone?: string
  company?: string
  company_name?: string
  ticket_type?: string
  has_hall_of_aime?: boolean | string
  has_wmn_at_fuse?: boolean | string
  form_submission_id?: string
  // Guest fields (may be arrays or pipe-delimited strings)
  guest_names?: string | string[]
  guest_emails?: string | string[]
  guest_ticket_types?: string | string[]
  // Additional form fields that might come through
  [key: string]: any
}

export async function POST(request: NextRequest) {
  try {
    const body: GHLFormPayload = await request.json()
    console.log('GHL Fuse form webhook received:', JSON.stringify(body, null, 2))

    const supabase = getSupabaseAdmin()

    // Extract contact info
    const email = body.email?.toLowerCase()
    if (!email) {
      console.error('No email in webhook payload')
      return NextResponse.json({ error: 'Email required' }, { status: 400 })
    }

    const fullName = body.full_name || `${body.first_name || ''} ${body.last_name || ''}`.trim()
    const phone = body.phone
    const company = body.company || body.company_name

    // Normalize ticket type. GA Plus was retired for Fuse 2026, so any
    // "GA Plus" coming in from a stale form payload is downgraded to GA.
    let ticketType = 'general_admission'
    if (body.ticket_type) {
      const rawType = body.ticket_type.toLowerCase().replace(/[^a-z]/g, '')
      if (rawType.includes('vip')) {
        ticketType = 'vip'
      }
      // Plus / GA+ → general_admission (silently downgraded)
    }

    // Get add-on flags
    const hasHallOfAime = body.has_hall_of_aime === true || body.has_hall_of_aime === 'true' || body.has_hall_of_aime === 'yes'
    const hasWmnAtFuse = body.has_wmn_at_fuse === true || body.has_wmn_at_fuse === 'true' || body.has_wmn_at_fuse === 'yes'

    // Look up member by email
    const { data: memberProfile } = await supabase
      .from('profiles')
      .select('id, plan_tier, ghl_contact_id')
      .eq('email', email)
      .single()

    // Determine tier and purchase type based on membership
    let tier: string | null = null
    let purchaseType = 'purchased'

    if (memberProfile) {
      const planTier = memberProfile.plan_tier
      if (planTier === 'Premium' || planTier === 'Elite' || planTier === 'VIP') {
        tier = planTier
        purchaseType = 'claimed'
      }
    }

    // Get active Fuse event
    const { data: activeEvent, error: eventError } = await supabase
      .from('fuse_events')
      .select('id, year')
      .eq('is_active', true)
      .single()

    if (eventError || !activeEvent) {
      console.error('No active Fuse event found:', eventError)
      return NextResponse.json({ error: 'No active Fuse event' }, { status: 500 })
    }

    // Check for existing registration to prevent duplicates
    const { data: existingReg } = await supabase
      .from('fuse_registrations')
      .select('id')
      .eq('fuse_event_id', activeEvent.id)
      .eq('email', email)
      .single()

    if (existingReg) {
      console.log(`Registration already exists for ${email} in Fuse ${activeEvent.year}`)
      return NextResponse.json({
        success: true,
        message: 'Registration already exists',
        registration_id: existingReg.id,
      })
    }

    // Create registration
    const { data: registration, error: regError } = await supabase
      .from('fuse_registrations')
      .insert({
        fuse_event_id: activeEvent.id,
        user_id: memberProfile?.id || null,
        full_name: fullName,
        email,
        phone: phone || null,
        company: company || null,
        ticket_type: ticketType,
        tier,
        purchase_type: purchaseType,
        has_hall_of_aime: hasHallOfAime,
        has_wmn_at_fuse: hasWmnAtFuse,
        ghl_contact_id: body.contact_id || memberProfile?.ghl_contact_id || null,
        ghl_form_submission_id: body.form_submission_id || null,
        registration_source: 'ghl_form',
      })
      .select()
      .single()

    if (regError) {
      console.error('Error creating registration:', regError)
      return NextResponse.json({ error: 'Failed to create registration' }, { status: 500 })
    }

    console.log(`Created registration ${registration.id} for ${email}`)

    // Parse and insert guests
    const guestNames = parseArrayField(body.guest_names)
    const guestEmails = parseArrayField(body.guest_emails)
    const guestTicketTypes = parseArrayField(body.guest_ticket_types)

    if (guestNames.length > 0) {
      const guests = guestNames.map((name, i) => ({
        registration_id: registration.id,
        full_name: name,
        email: guestEmails[i] || null,
        ticket_type: normalizeGuestTicketType(guestTicketTypes[i]),
        is_included: ticketType === 'vip' && i === 0, // First VIP guest is included
      }))

      const { error: guestError } = await supabase
        .from('fuse_registration_guests')
        .insert(guests)

      if (guestError) {
        console.error('Error inserting guests:', guestError)
      } else {
        console.log(`Added ${guests.length} guests to registration`)
      }
    }

    // Update member's fuse_ticket_claimed_year if they claimed
    if (memberProfile && purchaseType === 'claimed') {
      await supabase
        .from('profiles')
        .update({ fuse_ticket_claimed_year: activeEvent.year })
        .eq('id', memberProfile.id)
    }

    // Add GHL tags for nurture workflow
    const contactId = body.contact_id || memberProfile?.ghl_contact_id
    if (contactId) {
      try {
        const year = activeEvent.year
        const tags = [`fuse-${year}-registered`]

        if (ticketType === 'vip') {
          tags.push(`fuse-${year}-vip`)
        }
        if (hasHallOfAime) {
          tags.push(`fuse-${year}-hall-of-aime`)
        }
        if (hasWmnAtFuse) {
          tags.push(`fuse-${year}-wmn`)
        }

        // Add tags in parallel
        await Promise.all(tags.map(tag => ghlClient.addTagToContact(contactId, tag)))
        console.log(`Added GHL tags: ${tags.join(', ')}`)
      } catch (tagError) {
        console.error('Error adding GHL tags:', tagError)
        // Don't fail the webhook for tag errors
      }
    }

    // Fire Fuse confirmation workflow + opportunity webhook — but only
    // for member claims. Non-member 'purchased' rows from this path are
    // marketing-owned upstream; we don't push anything until we know the
    // payment-trust story (see plan Pending #2).
    if (purchaseType === 'claimed') {
      try {
        await dropFuseRegistration({
          registration_id: registration.id,
          fuse_event_id: activeEvent.id,
          fuse_event_year: activeEvent.year,
          ghl_contact_id: contactId ?? null,
          full_name: fullName,
          email,
          phone: phone || null,
          company: company || null,
          nmls_number: null,
          plan_tier: memberProfile?.plan_tier ?? null,
          billing_period: null,
          ticket_type: ticketType,
          tier,
          purchase_type: purchaseType,
          has_hall_of_aime: hasHallOfAime,
          has_wmn_at_fuse: hasWmnAtFuse,
          has_vetted_va: false,
          has_vip_luncheon: false,
          guests: guestNames.map((name, i) => ({
            full_name: name,
            ticket_type: normalizeGuestTicketType(guestTicketTypes[i]),
            is_included: ticketType === 'vip' && i === 0,
          })),
          pricing_phase: null,
          total_paid_cents: 0,
          invoice_number: null,
          created_at: new Date().toISOString(),
        }, 'new')
      } catch (dropErr) {
        console.error('Fuse GHL drop failed (non-fatal):', dropErr)
      }
    }

    return NextResponse.json({
      success: true,
      registration_id: registration.id,
      purchase_type: purchaseType,
      tier,
    })
  } catch (error: any) {
    console.error('Webhook error:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    )
  }
}

// Helper to parse array fields that might come as pipe-delimited strings
function parseArrayField(value: string | string[] | undefined): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value.filter(v => v && v.trim())
  return value.split('|').map(v => v.trim()).filter(Boolean)
}

// Helper to normalize guest ticket type
function normalizeGuestTicketType(type?: string): string {
  if (!type) return 'general_admission'
  const normalized = type.toLowerCase().replace(/[^a-z]/g, '')
  if (normalized.includes('vipguest') || normalized.includes('guestvip')) {
    return 'vip_guest'
  }
  if (normalized.includes('vip')) {
    return 'vip'
  }
  // GA Plus retired for Fuse 2026 — any "plus" / "ga+" downgrades to GA.
  return 'general_admission'
}
