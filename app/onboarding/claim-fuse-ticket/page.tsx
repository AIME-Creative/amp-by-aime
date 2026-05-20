import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getFuseEligibility } from '@/lib/fuse/eligibility'
import { canSeeFuse } from '@/lib/fuse/visibility'
import ClaimFuseTicketClient from './ClaimFuseTicketClient'

/**
 * Onboarding wedge between Stripe checkout and complete-profile.
 *
 * Eligible annual members get a one-tap Fuse claim. Anyone ineligible
 * (wrong tier / wrong billing / event ended / already claimed / no active
 * event) is silently advanced to /onboarding/complete-profile so the
 * step is invisible outside its narrow window.
 *
 * This whole route is a temporary surface — it can be deleted after Fuse
 * 2026 with no other code changes (the redirect target above just
 * stops firing, and select-plan can be reverted to set
 * 'complete_profile' directly).
 */
export default async function ClaimFuseTicketPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/sign-in')

  const { data: profile } = await supabase
    .from('profiles')
    .select('plan_tier, billing_period, subscription_override, full_name, fuse_ticket_claimed_year, profile_complete, is_admin')
    .eq('id', user.id)
    .single()

  if (profile?.profile_complete) redirect('/dashboard')

  const { data: activeEvent } = await supabase
    .from('fuse_events')
    .select('id, name, year, location, start_date, end_date')
    .eq('is_active', true)
    .single()

  const now = new Date()
  const eventEnded =
    activeEvent?.end_date &&
    now > new Date(`${activeEvent.end_date}T23:59:59`)

  const eligibility = getFuseEligibility(
    profile?.plan_tier,
    profile?.billing_period,
    profile?.subscription_override,
  )
  const alreadyClaimed =
    !!activeEvent?.year &&
    profile?.fuse_ticket_claimed_year === activeEvent.year

  // Pre-go-live: non-admin users skip silently to complete-profile.
  const fuseVisible = canSeeFuse(profile?.is_admin === true)

  const skip =
    !fuseVisible ||
    !activeEvent ||
    eventEnded ||
    eligibility.kind === 'none' ||
    alreadyClaimed

  if (skip) {
    await supabase
      .from('profiles')
      .update({ onboarding_step: 'complete_profile' })
      .eq('id', user.id)
    redirect('/onboarding/complete-profile')
  }

  const tierTicketLabel =
    eligibility.kind === 'claim' && eligibility.planTier === 'VIP'
      ? '2 VIP tickets + 2 Hall of AIME tickets'
      : eligibility.kind === 'claim'
      ? 'General Admission ticket'
      : 'General Admission ticket'

  return (
    <ClaimFuseTicketClient
      eventId={activeEvent!.id}
      eventName={activeEvent!.name || `Fuse ${activeEvent!.year}`}
      eventYear={activeEvent!.year}
      eventLocation={activeEvent!.location ?? null}
      eventStartDate={activeEvent!.start_date ?? null}
      eventEndDate={activeEvent!.end_date ?? null}
      planTier={profile!.plan_tier as string}
      ticketLabel={tierTicketLabel}
      fullName={profile?.full_name ?? null}
      variant={eligibility.kind === 'claim' ? 'claim' : 'buy'}
    />
  )
}
