import { redirect } from 'next/navigation'

/**
 * Backward-compat redirect. The onboarding select-plan step was
 * consolidated into the one-page sign-up checkout, so this route no
 * longer renders a picker. Users who were mid-flow when the
 * consolidation shipped (or anyone following an old link) get bounced
 * to the in-app dashboard checkout where they can pick a plan and
 * complete payment.
 */
export default function OnboardingSelectPlanRedirect() {
  redirect('/dashboard/select-plan')
}
