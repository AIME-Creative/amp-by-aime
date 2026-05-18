import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import DashboardLayout from '@/components/layout/DashboardLayout'
import { getViewAsSettings, applyViewAsOverride } from '@/lib/view-as-server'
import { getImpersonationSettings } from '@/lib/impersonation-server'
import { canSeeFuse } from '@/lib/fuse/visibility'

export default async function Layout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/sign-in')
  }

  // Check for impersonation mode first
  const impersonationSettings = await getImpersonationSettings()
  const isImpersonating = impersonationSettings?.isImpersonating && impersonationSettings?.impersonatedUserId

  // Fetch user profile - use impersonated user's ID if impersonating
  const profileUserId = isImpersonating ? impersonationSettings.impersonatedUserId : user.id
  let { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', profileUserId)
    .single()

  // If impersonating, also get the admin's profile to check admin status
  let adminProfile = null
  if (isImpersonating) {
    const { data: ap } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', user.id)
      .single()
    adminProfile = ap
  }

  // Apply view-as override if active (for admin preview functionality)
  // Note: View-as is for role/tier simulation, impersonation is for specific user
  const viewAsSettings = await getViewAsSettings()
  const effectiveProfile = applyViewAsOverride(profile, viewAsSettings)

  // Fetch active Fuse event for banner display
  const { data: activeFuseEvent } = await supabase
    .from('fuse_events')
    .select('name, year, location, registration_open, end_date')
    .eq('is_active', true)
    .single()

  // Get full name from profile or auth metadata
  const fullName = profile?.full_name || user.user_metadata?.full_name || null

  // Check if user is admin
  // If impersonating, use admin's original profile; otherwise use current profile
  const isAdmin = isImpersonating
    ? adminProfile?.is_admin === true
    : profile?.is_admin === true

  // Get user role for access control (use effective profile for view-as)
  const userRole = effectiveProfile?.role as string | undefined

  // Admin preview mode: View As or Impersonation active
  const isAdminPreview = !!(isImpersonating || viewAsSettings?.isViewingAs)

  return (
    <DashboardLayout
      user={{
        full_name: fullName,
        email: isImpersonating ? impersonationSettings.impersonatedUserEmail : user.email!,
        avatar_url: profile?.avatar_url,
      }}
      isAdmin={isAdmin}
      userRole={userRole}
      paymentFailedAt={profile?.payment_failed_at}
      subscriptionStatus={profile?.stripe_subscription_status}
      planTier={effectiveProfile?.plan_tier}
      billingPeriod={effectiveProfile?.billing_period}
      fuseTicketClaimedYear={profile?.fuse_ticket_claimed_year}
      fuseActiveEventYear={activeFuseEvent?.year}
      fuseActiveEventEndDate={activeFuseEvent?.end_date}
      fuseEventName={activeFuseEvent?.name}
      fuseEventLocation={activeFuseEvent?.location}
      fuseVisible={canSeeFuse(isAdmin)}
      isAdminPreview={isAdminPreview}
    >
      {children}
    </DashboardLayout>
  )
}
