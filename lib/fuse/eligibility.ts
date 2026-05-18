/**
 * Fuse registration eligibility helper. Centralizes the logic for who
 * sees what surface (banner, onboarding wedge, landing card, sidebar
 * item), so all four stay in sync.
 *
 *   - Annual VIP                  → claim (1 free VIP ticket + entitled HOA)
 *   - Annual Premium / Elite      → claim (1 free GA ticket)
 *   - Monthly Premium / Elite / VIP → buy (GA only; VIP ticket is
 *     claim-only and General Admission Plus has been removed for 2026)
 *   - No tier / Free Trial / non-member → nothing in the AMP app
 */
export type FuseEligibility =
  | {
      kind: 'claim'
      planTier: 'Premium' | 'Elite' | 'VIP'
      defaultTicket: 'general_admission' | 'vip'
    }
  | {
      kind: 'buy'
      planTier: 'Premium' | 'Elite' | 'VIP'
    }
  | { kind: 'none' }

export function getFuseEligibility(
  planTier: string | null | undefined,
  billingPeriod: string | null | undefined,
): FuseEligibility {
  // billing_period is written in two places with different casing:
  // stripe/billing-info writes 'Annual' / 'Monthly', other paths write
  // 'annual' / 'monthly'. Normalize so both work.
  const annual = (billingPeriod ?? '').toLowerCase() === 'annual'
  if (planTier === 'VIP' && annual) {
    return { kind: 'claim', planTier: 'VIP', defaultTicket: 'vip' }
  }
  if ((planTier === 'Premium' || planTier === 'Elite') && annual) {
    return { kind: 'claim', planTier, defaultTicket: 'general_admission' }
  }
  if (planTier === 'Premium' || planTier === 'Elite' || planTier === 'VIP') {
    return { kind: 'buy', planTier }
  }
  return { kind: 'none' }
}
