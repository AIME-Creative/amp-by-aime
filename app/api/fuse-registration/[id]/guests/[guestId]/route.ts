import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getImpersonationSettings } from '@/lib/impersonation-server'
import { canSeeFuse } from '@/lib/fuse/visibility'

/**
 * PATCH /api/fuse-registration/[id]/guests/[guestId]
 *
 * Self-serve guest edit. Member who owns the registration (or admin)
 * can update:
 *   - full_name
 *   - has_wmn_at_fuse, has_vetted_va, has_vip_luncheon (free add-ons,
 *     each gated by the main attendee carrying the same flag)
 *
 * HOA is intentionally NOT editable here. It's a paid line item and
 * must flow through /top-up so the charge runs against the customer's
 * card. Adding new guests likewise goes through /top-up; removing
 * guests is admin-only.
 *
 * Body: {
 *   full_name: string,
 *   addons?: {
 *     has_wmn_at_fuse?: boolean,
 *     has_vetted_va?: boolean,
 *     has_vip_luncheon?: boolean,
 *   }
 * }
 */
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string; guestId: string }> },
) {
  try {
    const supabase = await createClient()
    const { id: registrationId, guestId } = await context.params

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

    // Confirm the guest belongs to the registration AND the caller owns
    // the registration (or is admin).
    const { data: registration, error: regErr } = await supabase
      .from('fuse_registrations')
      .select(
        'id, user_id, has_hall_of_aime, has_wmn_at_fuse, has_vetted_va, has_vip_luncheon',
      )
      .eq('id', registrationId)
      .single()

    if (regErr || !registration) {
      return NextResponse.json({ error: 'Registration not found' }, { status: 404 })
    }
    if (registration.user_id !== effectiveUserId && !isAdmin) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    }

    const { data: guest } = await supabase
      .from('fuse_registration_guests')
      .select('id, registration_id')
      .eq('id', guestId)
      .single()

    if (!guest || guest.registration_id !== registrationId) {
      return NextResponse.json({ error: 'Guest not found' }, { status: 404 })
    }

    const body = await request.json()
    const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : ''

    if (!fullName) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }

    // Free add-on toggles. HOA isn't editable here — it's a paid line
    // item set when the guest is added through the top-up flow.
    const addons = (body.addons ?? {}) as {
      has_wmn_at_fuse?: boolean
      has_vetted_va?: boolean
      has_vip_luncheon?: boolean
    }

    const update: Record<string, unknown> = { full_name: fullName }
    if (typeof addons.has_wmn_at_fuse === 'boolean') {
      update.has_wmn_at_fuse =
        addons.has_wmn_at_fuse && registration.has_wmn_at_fuse
    }
    if (typeof addons.has_vetted_va === 'boolean') {
      update.has_vetted_va =
        addons.has_vetted_va && registration.has_vetted_va
    }
    if (typeof addons.has_vip_luncheon === 'boolean') {
      update.has_vip_luncheon =
        addons.has_vip_luncheon && registration.has_vip_luncheon
    }

    const { error: updateError } = await supabase
      .from('fuse_registration_guests')
      .update(update)
      .eq('id', guestId)

    if (updateError) {
      console.error('Error updating guest:', updateError)
      return NextResponse.json({ error: 'Failed to update guest' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error('Error in guest update:', error)
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 },
    )
  }
}
