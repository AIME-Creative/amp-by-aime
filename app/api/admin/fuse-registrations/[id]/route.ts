import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const VALID_PURCHASE_TYPES = ['claimed', 'purchased', 'pending', 'upgraded'] as const
const VALID_STEP_COMPLETED = ['claim', 'finalized'] as const

// GET - Get a single registration by ID
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
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

    const { data: registration, error } = await supabase
      .from('fuse_registrations')
      .select(`
        *,
        fuse_event:fuse_event_id (id, name, year),
        user:user_id (id, email, full_name),
        guests:fuse_registration_guests (*)
      `)
      .eq('id', id)
      .single()

    if (error) {
      console.error('Error fetching registration:', error)
      return NextResponse.json({ error: 'Registration not found' }, { status: 404 })
    }

    return NextResponse.json({ registration })
  } catch (error: any) {
    console.error('Error in GET /api/admin/fuse-registrations/[id]:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    )
  }
}

// PATCH - Update a registration
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
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
    const { guests, skip_eligibility_check: _skip, ...updates } = body

    // Validate any provided enum values.
    if (updates.purchase_type && !VALID_PURCHASE_TYPES.includes(updates.purchase_type)) {
      return NextResponse.json(
        { error: `Invalid purchase_type. Must be one of: ${VALID_PURCHASE_TYPES.join(', ')}` },
        { status: 400 },
      )
    }
    if (updates.step_completed && !VALID_STEP_COMPLETED.includes(updates.step_completed)) {
      return NextResponse.json(
        { error: `Invalid step_completed. Must be one of: ${VALID_STEP_COMPLETED.join(', ')}` },
        { status: 400 },
      )
    }

    // Pull the existing row so we can enforce safe transitions + sync
    // VIP HOA entitlement when ticket_type / purchase_type change.
    const { data: existing } = await supabase
      .from('fuse_registrations')
      .select('ticket_type, purchase_type, step_completed, has_hall_of_aime')
      .eq('id', id)
      .single()

    if (existing) {
      // Don't allow downgrading a finalized registration back to 'claim'
      // through this PATCH (it would re-open the unpaid state without
      // re-running the cart). Admins who really need to do this should
      // delete and recreate, or pass skip_eligibility_check.
      if (
        existing.step_completed === 'finalized' &&
        updates.step_completed === 'claim' &&
        !body.skip_eligibility_check
      ) {
        return NextResponse.json(
          {
            error:
              'Cannot move a finalized registration back to claim. Delete and recreate ' +
              'if you really need to, or send skip_eligibility_check.',
          },
          { status: 400 },
        )
      }

      // Auto-set HOA when promoting to a VIP claim (mirrors the user
      // claim route's VIP entitlement). Doesn't strip HOA on the way
      // down — admins can untick that explicitly.
      const nextTicket = updates.ticket_type ?? existing.ticket_type
      const nextPurchase = updates.purchase_type ?? existing.purchase_type
      const becomesVipClaim =
        nextTicket === 'vip' && nextPurchase === 'claimed' && !existing.has_hall_of_aime
      if (becomesVipClaim && updates.has_hall_of_aime === undefined) {
        updates.has_hall_of_aime = true
      }
    }

    // Update the registration
    const { data: registration, error } = await supabase
      .from('fuse_registrations')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      console.error('Error updating registration:', error)
      return NextResponse.json({ error: 'Failed to update registration' }, { status: 500 })
    }

    // Handle guest updates if provided. Gate guest add-ons by what the
    // (post-update) registration carries so admins can't accidentally
    // grant a guest an add-on the main attendee doesn't have.
    if (guests !== undefined) {
      const mainHoa = registration.has_hall_of_aime
      const mainWmn = registration.has_wmn_at_fuse
      const mainVettedVa = registration.has_vetted_va
      const mainVipLuncheon = registration.has_vip_luncheon

      // Delete existing guests
      await supabase
        .from('fuse_registration_guests')
        .delete()
        .eq('registration_id', id)

      // Insert new guests
      if (guests.length > 0) {
        const guestRecords = guests.map((guest: any) => ({
          registration_id: id,
          full_name: guest.full_name,
          email: guest.email || null,
          phone: guest.phone || null,
          ticket_type: guest.ticket_type,
          is_included: guest.is_included || false,
          has_hall_of_aime: !!guest.has_hall_of_aime && mainHoa,
          has_wmn_at_fuse: !!guest.has_wmn_at_fuse && mainWmn,
          has_vetted_va: !!guest.has_vetted_va && mainVettedVa,
          has_vip_luncheon: !!guest.has_vip_luncheon && mainVipLuncheon,
        }))

        await supabase
          .from('fuse_registration_guests')
          .insert(guestRecords)
      }
    }

    // Fetch the updated registration with relations
    const { data: fullRegistration } = await supabase
      .from('fuse_registrations')
      .select(`
        *,
        fuse_event:fuse_event_id (id, name, year),
        user:user_id (id, email, full_name),
        guests:fuse_registration_guests (*)
      `)
      .eq('id', id)
      .single()

    return NextResponse.json({ registration: fullRegistration })
  } catch (error: any) {
    console.error('Error in PATCH /api/admin/fuse-registrations/[id]:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    )
  }
}

// DELETE - Delete a registration
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
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

    // Get the registration first to check if we need to reset the user's claimed year
    const { data: registration } = await supabase
      .from('fuse_registrations')
      .select('user_id, fuse_event_id, purchase_type')
      .eq('id', id)
      .single()

    if (!registration) {
      return NextResponse.json({ error: 'Registration not found' }, { status: 404 })
    }

    // Delete the registration (guests will be cascade deleted)
    const { error } = await supabase
      .from('fuse_registrations')
      .delete()
      .eq('id', id)

    if (error) {
      console.error('Error deleting registration:', error)
      return NextResponse.json({ error: 'Failed to delete registration' }, { status: 500 })
    }

    // Reset the user's fuse_ticket_claimed_year if the deleted row
    // represented their entitlement / reservation. Skip 'upgraded'
    // (paid GA Plus swap — the original ticket is gone) and 'purchased'
    // (admin may want to retain the year-tag for analytics).
    const resetClaimedYearFor: string[] = ['claimed', 'pending']
    if (
      registration.user_id &&
      resetClaimedYearFor.includes(registration.purchase_type)
    ) {
      const { data: fuseEvent } = await supabase
        .from('fuse_events')
        .select('year')
        .eq('id', registration.fuse_event_id)
        .single()

      if (fuseEvent) {
        // Only reset if it matches the current year
        await supabase
          .from('profiles')
          .update({ fuse_ticket_claimed_year: null })
          .eq('id', registration.user_id)
          .eq('fuse_ticket_claimed_year', fuseEvent.year)
      }
    }

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('Error in DELETE /api/admin/fuse-registrations/[id]:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    )
  }
}
