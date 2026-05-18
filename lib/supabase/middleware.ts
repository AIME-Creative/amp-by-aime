import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({
            request,
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Get user and refresh auth token
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Protected route check
  const protectedPaths = ['/dashboard', '/admin']
  const publicAuthPaths = ['/admin/login']

  const isProtectedPath = protectedPaths.some(path =>
    request.nextUrl.pathname.startsWith(path)
  ) && !publicAuthPaths.some(path => request.nextUrl.pathname.startsWith(path))

  // If accessing protected route without authentication, redirect to sign-in
  if (isProtectedPath && !user) {
    const redirectUrl = new URL('/sign-in', request.url)
    redirectUrl.searchParams.set('redirectTo', request.nextUrl.pathname)
    return NextResponse.redirect(redirectUrl)
  }

  // Check profile completion and subscription status for authenticated users (skip for admin users)
  // Also skip for password reset paths - users need to complete password reset before being redirected
  const isOnPasswordResetPath = request.nextUrl.pathname.startsWith('/reset-password') ||
    request.nextUrl.pathname.startsWith('/forgot-password')

  if (user && !request.nextUrl.pathname.startsWith('/onboarding') && !request.nextUrl.pathname.startsWith('/admin') && !request.nextUrl.pathname.startsWith('/fuse') && !isOnPasswordResetPath) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('profile_complete, onboarding_step, is_admin, subscription_status, plan_tier, role')
      .eq('id', user.id)
      .single()

    // Skip onboarding checks for admin users and partner accounts
    const skipOnboarding = profile?.is_admin ||
      profile?.role === 'partner_vendor' ||
      profile?.role === 'partner_lender'

    if (profile && !skipOnboarding) {
      // Check subscription status - users MUST have active subscription to access platform
      const hasActiveSubscription = profile.subscription_status === 'active' ||
        profile.subscription_status === 'trialing'

      // Pending Checkout is not allowed - redirect to select plan
      const hasPaidPlan = profile.plan_tier &&
        profile.plan_tier !== 'None' &&
        profile.plan_tier !== 'Pending Checkout'

      // If no active subscription or no paid plan, force back to the
      // in-app plan picker. The old /onboarding/select-plan route was
      // deprecated when sign-up consolidated into a one-page checkout;
      // anyone landing on it (or here) goes through the dashboard
      // picker instead.
      if (!hasActiveSubscription || !hasPaidPlan) {
        if (!request.nextUrl.pathname.startsWith('/dashboard/select-plan')) {
          return NextResponse.redirect(new URL('/dashboard/select-plan', request.url))
        }
      }
      // If they have subscription but haven't completed profile
      else if (!profile.profile_complete) {
        if (profile.onboarding_step === 'complete_profile' && !request.nextUrl.pathname.startsWith('/onboarding/complete-profile')) {
          return NextResponse.redirect(new URL('/onboarding/complete-profile', request.url))
        }
      }
    }
  }

  // If authenticated user tries to access auth pages, redirect to dashboard
  // Note: /reset-password and /forgot-password excluded - users (including admins) need access to reset passwords
  const authPaths = ['/sign-in', '/sign-up']
  const passwordResetPaths = ['/forgot-password', '/reset-password']
  const isAuthPath = authPaths.some(path => request.nextUrl.pathname.startsWith(path))
  const isPasswordResetPath = passwordResetPaths.some(path => request.nextUrl.pathname.startsWith(path))

  // Always allow access to password reset paths, even for authenticated users
  if (isPasswordResetPath) {
    return supabaseResponse
  }

  if (isAuthPath && user) {
    // Check if profile is complete before redirecting to dashboard (skip for admins)
    const { data: profile } = await supabase
      .from('profiles')
      .select('profile_complete, onboarding_step, is_admin, subscription_status, plan_tier, role')
      .eq('id', user.id)
      .single()

    // Admin users should go to admin portal, not dashboard
    if (profile?.is_admin) {
      return NextResponse.redirect(new URL('/admin', request.url))
    }

    // Partner accounts skip onboarding
    if (profile?.role === 'partner_vendor' || profile?.role === 'partner_lender') {
      return NextResponse.redirect(new URL('/dashboard', request.url))
    }

    // Check subscription status - users MUST have active subscription
    const hasActiveSubscription = profile?.subscription_status === 'active' ||
      profile?.subscription_status === 'trialing'
    const hasPaidPlan = profile?.plan_tier &&
      profile?.plan_tier !== 'None' &&
      profile?.plan_tier !== 'Pending Checkout'

    // No subscription or Pending Checkout = go to in-app plan picker
    if (!hasActiveSubscription || !hasPaidPlan) {
      return NextResponse.redirect(new URL('/dashboard/select-plan', request.url))
    }

    // Has subscription but profile not complete = go to complete profile
    if (profile && !profile.profile_complete) {
      return NextResponse.redirect(new URL('/onboarding/complete-profile', request.url))
    }

    return NextResponse.redirect(new URL('/dashboard', request.url))
  }

  // Admin route check - only allow admin users
  // TODO: Enable admin role check when roles are properly configured
  // if (request.nextUrl.pathname.startsWith('/admin') && user) {
  //   const { data: profile } = await supabase
  //     .from('profiles')
  //     .select('role')
  //     .eq('id', user.id)
  //     .single()

  //   // Define admin roles (you can adjust this based on your needs)
  //   const adminRoles = ['admin', 'super_admin', 'broker_owner', 'partner_lender', 'partner_vendor']

  //   if (!profile || !adminRoles.includes(profile.role)) {
  //     return NextResponse.redirect(new URL('/dashboard', request.url))
  //   }
  // }

  return supabaseResponse
}
