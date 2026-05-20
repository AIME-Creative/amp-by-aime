import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { FuseRegistration } from '@/types/database.types'
import { getFuseEligibility } from '@/lib/fuse/eligibility'

// Allowed enum values (kept in sync with DB CHECK constraints).
const VALID_PURCHASE_TYPES = ['claimed', 'purchased', 'pending', 'upgraded'] as const
const VALID_STEP_COMPLETED = ['claim', 'finalized'] as const

export type FuseRegistrationStats = {
  total: number
  ga: number
  vip: number
  guests: number
  hallOfAime: number
  wmnAtFuse: number
  vettedVa: number
  vipLuncheon: number
}

function computeStats(rows: any[]): FuseRegistrationStats {
  const s: FuseRegistrationStats = {
    total: 0,
    ga: 0,
    vip: 0,
    guests: 0,
    hallOfAime: 0,
    wmnAtFuse: 0,
    vettedVa: 0,
    vipLuncheon: 0,
  }
  for (const r of rows) {
    s.total++
    if (r.ticket_type === 'general_admission') s.ga++
    else if (r.ticket_type === 'vip') s.vip++
    if (r.has_hall_of_aime) s.hallOfAime++
    if (r.has_wmn_at_fuse) s.wmnAtFuse++
    if (r.has_vetted_va) s.vettedVa++
    if (r.has_vip_luncheon) s.vipLuncheon++
    for (const g of r.guests || []) {
      s.total++
      s.guests++
      if (g.ticket_type === 'general_admission') s.ga++
      else if (g.ticket_type === 'vip' || g.ticket_type === 'vip_guest') s.vip++
      if (g.has_hall_of_aime) s.hallOfAime++
      if (g.has_wmn_at_fuse) s.wmnAtFuse++
      if (g.has_vetted_va) s.vettedVa++
      if (g.has_vip_luncheon) s.vipLuncheon++
    }
  }
  return s
}

// GET - List all fuse registrations with filtering and pagination
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', user.id)
      .single()

    if (!profile?.is_admin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    // Parse query parameters
    const searchParams = request.nextUrl.searchParams
    const eventId = searchParams.get('event_id')
    const search = searchParams.get('search')
    const ticketType = searchParams.get('ticket_type')
    const tier = searchParams.get('tier')
    const page = parseInt(searchParams.get('page') || '1')
    const limit = parseInt(searchParams.get('limit') || '20')
    const offset = (page - 1) * limit

    // Build query
    let query = supabase
      .from('fuse_registrations')
      .select(`
        *,
        fuse_event:fuse_event_id (id, name, year),
        user:user_id (id, email, full_name),
        guests:fuse_registration_guests (*)
      `, { count: 'exact' })

    // Filter by event
    if (eventId) {
      query = query.eq('fuse_event_id', eventId)
    }

    // Search by name, email, or company
    if (search) {
      query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%,company.ilike.%${search}%`)
    }

    // Filter by ticket type
    if (ticketType && ticketType !== 'all') {
      query = query.eq('ticket_type', ticketType)
    }

    // Filter by tier
    if (tier && tier !== 'all') {
      if (tier === 'public') {
        query = query.is('tier', null)
      } else {
        query = query.eq('tier', tier)
      }
    }

    // Add pagination and ordering
    const { data: registrations, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) {
      console.error('Error fetching registrations:', error)
      return NextResponse.json({ error: 'Failed to fetch registrations' }, { status: 500 })
    }

    // Aggregate stats across the FULL filtered set (not just the current
    // page). The admin summary chips need to show every ticket / add-on
    // for the event, even when the table only shows 10 rows at a time.
    let statsQuery = supabase
      .from('fuse_registrations')
      .select(`
        ticket_type,
        has_hall_of_aime,
        has_wmn_at_fuse,
        has_vetted_va,
        has_vip_luncheon,
        guests:fuse_registration_guests (
          ticket_type,
          has_hall_of_aime,
          has_wmn_at_fuse,
          has_vetted_va,
          has_vip_luncheon
        )
      `)
    if (eventId) statsQuery = statsQuery.eq('fuse_event_id', eventId)
    if (search) {
      statsQuery = statsQuery.or(
        `full_name.ilike.%${search}%,email.ilike.%${search}%,company.ilike.%${search}%`,
      )
    }
    if (ticketType && ticketType !== 'all') statsQuery = statsQuery.eq('ticket_type', ticketType)
    if (tier && tier !== 'all') {
      if (tier === 'public') statsQuery = statsQuery.is('tier', null)
      else statsQuery = statsQuery.eq('tier', tier)
    }
    const { data: allForStats } = await statsQuery

    const stats = computeStats(allForStats || [])

    return NextResponse.json({
      registrations,
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: count ? Math.ceil(count / limit) : 0,
      },
      stats,
    })
  } catch (error: any) {
    console.error('Error in GET /api/admin/fuse-registrations:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    )
  }
}

// POST - Create a new registration (admin manual entry)
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', user.id)
      .single()

    if (!profile?.is_admin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    const body = await request.json()
    const {
      fuse_event_id,
      full_name,
      email,
      phone,
      company,
      ticket_type,
      tier,
      purchase_type,
      has_hall_of_aime = false,
      has_wmn_at_fuse = false,
      has_vetted_va = false,
      has_vip_luncheon = false,
      step_completed,
      notes,
      guests = [],
    } = body

    // Validate required fields
    if (!fuse_event_id || !full_name || !email || !ticket_type || !purchase_type) {
      return NextResponse.json(
        { error: 'Missing required fields: fuse_event_id, full_name, email, ticket_type, purchase_type' },
        { status: 400 }
      )
    }

    // Validate enum values against DB CHECK constraints. Bad values
    // would otherwise surface as opaque DB errors.
    if (!VALID_PURCHASE_TYPES.includes(purchase_type)) {
      return NextResponse.json(
        { error: `Invalid purchase_type. Must be one of: ${VALID_PURCHASE_TYPES.join(', ')}` },
        { status: 400 },
      )
    }
    // GA Plus retired for Fuse 2026 — admins can still PATCH legacy
    // rows but not create new ones with those values.
    if (ticket_type === 'general_admission_plus' || purchase_type === 'upgraded') {
      return NextResponse.json(
        { error: 'General Admission Plus / upgraded is no longer available for new Fuse 2026 registrations.' },
        { status: 400 },
      )
    }
    if (step_completed && !VALID_STEP_COMPLETED.includes(step_completed)) {
      return NextResponse.json(
        { error: `Invalid step_completed. Must be one of: ${VALID_STEP_COMPLETED.join(', ')}` },
        { status: 400 },
      )
    }

    // Use explicit user_id if provided (from member picker), otherwise
    // look up by email. Pull billing_period too — it's needed for
    // eligibility gating below.
    let memberProfile:
      | {
          id: string
          plan_tier: string | null
          billing_period: string | null
          subscription_override: boolean | null
        }
      | null = null
    if (body.user_id) {
      const { data: mp } = await supabase
        .from('profiles')
        .select('id, plan_tier, billing_period, subscription_override')
        .eq('id', body.user_id)
        .single()
      memberProfile = mp
    } else {
      const { data: mp } = await supabase
        .from('profiles')
        .select('id, plan_tier, billing_period, subscription_override')
        .eq('email', email.toLowerCase())
        .single()
      memberProfile = mp
    }

    // Eligibility gating. If the registration is linked to a member,
    // make sure the purchase_type matches what their plan actually
    // entitles them to:
    //   - Annual Premium/Elite/VIP → 'claimed' only
    //   - Monthly Premium/Elite/VIP → 'purchased' or 'pending' (not VIP ticket)
    //   - Non-eligible profile → 'purchased' / 'pending' only (no claim)
    // Admins can explicitly override by passing `skip_eligibility_check: true`
    // if they need to fix legacy data.
    if (memberProfile && !body.skip_eligibility_check) {
      const eligibility = getFuseEligibility(
        memberProfile.plan_tier,
        memberProfile.billing_period,
        memberProfile.subscription_override,
      )
      if (purchase_type === 'claimed' && eligibility.kind !== 'claim') {
        return NextResponse.json(
          {
            error:
              "This member isn't eligible for a free claim (annual Premium/Elite/VIP only). " +
              'Use purchase_type "purchased" or "pending" instead, or set skip_eligibility_check.',
          },
          { status: 400 },
        )
      }
      if (ticket_type === 'vip' && !(eligibility.kind === 'claim' && eligibility.planTier === 'VIP')) {
        return NextResponse.json(
          { error: 'VIP tickets are reserved for annual VIP members.' },
          { status: 400 },
        )
      }
    }

    // VIP membership entitlement: 2 VIP tickets + 2 Hall of AIME
    // included. Mirror the user-facing claim route — auto-set HOA on
    // any VIP claim regardless of whether the admin remembered to tick
    // the box. Other purchase_types stay literal.
    const effectiveHoa =
      purchase_type === 'claimed' && ticket_type === 'vip'
        ? true
        : has_hall_of_aime

    // Create registration
    const { data: registration, error } = await supabase
      .from('fuse_registrations')
      .insert({
        fuse_event_id,
        user_id: memberProfile?.id || null,
        full_name,
        email: email.toLowerCase(),
        phone: phone || null,
        company: company || null,
        ticket_type,
        tier: tier || null,
        purchase_type,
        has_hall_of_aime: effectiveHoa,
        has_wmn_at_fuse,
        has_vetted_va,
        has_vip_luncheon,
        step_completed: step_completed || 'claim',
        registration_source: 'admin_manual',
        notes: notes || null,
        created_by: user.id,
      })
      .select()
      .single()

    if (error) {
      console.error('Error creating registration:', error)
      return NextResponse.json({ error: 'Failed to create registration' }, { status: 500 })
    }

    // Insert guests if any. Guest add-ons are gated by what the main
    // registration carries — a guest can't have HOA if the main doesn't.
    // Admins can still flip them later via PATCH after editing the main.
    if (guests.length > 0) {
      const guestRecords = guests.map((guest: any) => ({
        registration_id: registration.id,
        full_name: guest.full_name,
        email: guest.email || null,
        phone: guest.phone || null,
        ticket_type: guest.ticket_type,
        is_included: guest.is_included || false,
        has_hall_of_aime: !!guest.has_hall_of_aime && effectiveHoa,
        has_wmn_at_fuse: !!guest.has_wmn_at_fuse && has_wmn_at_fuse,
        has_vetted_va: !!guest.has_vetted_va && has_vetted_va,
        has_vip_luncheon: !!guest.has_vip_luncheon && has_vip_luncheon,
      }))

      const { error: guestError } = await supabase
        .from('fuse_registration_guests')
        .insert(guestRecords)

      if (guestError) {
        console.error('Error creating guest records:', guestError)
        // Don't fail the entire request, just log the error
      }
    }

    // If member claimed, update their profile
    if (memberProfile && purchase_type === 'claimed') {
      const { data: fuseEvent } = await supabase
        .from('fuse_events')
        .select('year')
        .eq('id', fuse_event_id)
        .single()

      if (fuseEvent) {
        await supabase
          .from('profiles')
          .update({ fuse_ticket_claimed_year: fuseEvent.year })
          .eq('id', memberProfile.id)
      }
    }

    // Fetch the full registration with relations
    const { data: fullRegistration } = await supabase
      .from('fuse_registrations')
      .select(`
        *,
        fuse_event:fuse_event_id (id, name, year),
        user:user_id (id, email, full_name),
        guests:fuse_registration_guests (*)
      `)
      .eq('id', registration.id)
      .single()

    return NextResponse.json({ registration: fullRegistration }, { status: 201 })
  } catch (error: any) {
    console.error('Error in POST /api/admin/fuse-registrations:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    )
  }
}
