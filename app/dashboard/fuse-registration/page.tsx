import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { FuseClaimPage } from '@/components/dashboard/FuseClaimPage'
import { getImpersonationSettings } from '@/lib/impersonation-server'
import { getViewAsSettings } from '@/lib/view-as-server'
import { pickActivePrices } from '@/lib/fuse/pricing'
import { getFuseEligibility } from '@/lib/fuse/eligibility'
import { canSeeFuse } from '@/lib/fuse/visibility'

export default async function FuseRegistrationPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/sign-in')
  }

  // Check for impersonation mode
  const impersonationSettings = await getImpersonationSettings()
  const isImpersonating = impersonationSettings?.isImpersonating && impersonationSettings?.impersonatedUserId
  const effectiveUserId = isImpersonating ? impersonationSettings.impersonatedUserId : user.id

  const viewAsSettings = await getViewAsSettings()
  const isAdminPreview = !!(isImpersonating || viewAsSettings?.isViewingAs)

  // Get user profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('id, email, full_name, phone, company, plan_tier, billing_period, subscription_override, fuse_ticket_claimed_year, gender, is_admin')
    .eq('id', effectiveUserId)
    .single()

  if (!profile) {
    redirect('/dashboard')
  }

  // Admin-ness must come from the ORIGINAL session user, not the
  // impersonated profile. Otherwise an admin impersonating a non-admin
  // gets locked out of the page they're trying to QA pre-go-live.
  // (Matches the pattern in app/dashboard/layout.tsx.)
  let isAdmin = profile.is_admin === true
  if (isImpersonating) {
    const { data: originalAdmin } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', user.id)
      .single()
    isAdmin = originalAdmin?.is_admin === true
  }

  // Pre-go-live kill switch — non-admins bounce until FUSE_LIVE=true.
  if (!canSeeFuse(isAdmin)) {
    redirect('/dashboard')
  }

  const eligibleTiers = ['Premium', 'Elite', 'VIP']

  // Eligibility: annual eligible tier (claim flow) OR monthly eligible
  // tier (buy flow). Anyone else bounces to /dashboard. Admins bypass
  // so they can preview either variant regardless of their own plan.
  const eligibility = getFuseEligibility(profile.plan_tier, profile.billing_period, profile.subscription_override)
  if (!isAdmin && eligibility.kind === 'none') {
    redirect('/dashboard')
  }

  // Get active Fuse event
  const { data: activeEvent } = await supabase
    .from('fuse_events')
    .select('*')
    .eq('is_active', true)
    .single()

  if (!activeEvent) {
    redirect('/dashboard')
  }

  // Check for existing registration (and its guests for the manage panel)
  let { data: existingRegistration } = await supabase
    .from('fuse_registrations')
    .select(
      'id, ticket_type, purchase_type, has_hall_of_aime, has_wmn_at_fuse, has_vetted_va, has_vip_luncheon, step_completed, guests:fuse_registration_guests(id, full_name, ticket_type, is_included, has_hall_of_aime, has_wmn_at_fuse, has_vetted_va, has_vip_luncheon)',
    )
    .eq('fuse_event_id', activeEvent.id)
    .eq('user_id', effectiveUserId)
    .single()

  // Monthly buyers used to get a reservation row inserted here on page
  // view, which polluted fuse_registrations with rows for anyone who
  // merely opened the page. The buyer CTA on the landing card now
  // creates the row on first deliberate click.

  // Fetch tier-specific prices + universal add-ons (tier IS NULL, like WMN)
  const effectiveTier = profile.plan_tier && eligibleTiers.includes(profile.plan_tier)
    ? profile.plan_tier
    : isAdmin ? 'Premium' : null

  const { data: tierPrices } = await supabase
    .from('fuse_ticket_prices')
    .select('*')
    .eq('fuse_event_id', activeEvent.id)
    .eq('tier', effectiveTier)
    .eq('is_active', true)
    .order('sort_order')

  // Also fetch universal add-ons (tier = null, is_addon = true) that aren't already covered by tier prices
  const { data: universalAddons } = await supabase
    .from('fuse_ticket_prices')
    .select('*')
    .eq('fuse_event_id', activeEvent.id)
    .is('tier', null)
    .eq('is_addon', true)
    .eq('is_active', true)
    .order('sort_order')

  // Merge: tier prices + universal add-ons not already in tier prices.
  // Dedupe public addons by phase-active picking so products with both
  // early-bird and regular rows (e.g. HOA) only render once with the
  // currently-active price.
  const tierProductKeys = (tierPrices || []).map((p) => p.product_key)
  const activePublicAddons = pickActivePrices(universalAddons || [], null)
  const mergedPrices = [
    ...(tierPrices || []),
    ...activePublicAddons.filter((a) => !tierProductKeys.includes(a.product_key)),
  ]

  // Full price catalog + guest pricing rules for client-side order-summary math.
  // planGuestPricing (used in OrderSummary) needs the regular public GA row to
  // compute the member-discount base, which isn't always in `mergedPrices`.
  const { data: allPriceRows } = await supabase
    .from('fuse_ticket_prices')
    .select('*')
    .eq('fuse_event_id', activeEvent.id)
    .eq('is_active', true)
    .order('sort_order')

  const { data: guestPricingRules } = await supabase
    .from('fuse_guest_pricing_rules')
    .select('tier, base_product_key, discount_percent')
    .eq('fuse_event_id', activeEvent.id)

  return (
    <FuseClaimPage
      event={activeEvent}
      userProfile={{
        id: profile.id,
        email: profile.email,
        full_name: profile.full_name,
        phone: profile.phone,
        company: profile.company,
        plan_tier: profile.plan_tier,
        billing_period: profile.billing_period,
        subscription_override: profile.subscription_override,
        gender: profile.gender,
      }}
      existingRegistration={existingRegistration}
      isAdmin={isAdmin}
      tierPrices={mergedPrices}
      allPrices={allPriceRows ?? []}
      guestPricingRules={guestPricingRules ?? []}
    />
  )
}
