'use client'

import { ChevronRight } from 'lucide-react'
import Link from 'next/link'
import type { PlanTier } from '@/types/database.types'
import { getFuseEligibility } from '@/lib/fuse/eligibility'

interface FuseClaimBannerProps {
  planTier?: PlanTier | string | null
  billingPeriod?: string | null
  fuseTicketClaimedYear?: number | null
  activeEventYear?: number
  eventName?: string
  eventLocation?: string
  /** Show banner for admin users directly (admins always see it for testing) */
  isAdmin?: boolean
  /**
   * Pre-go-live kill switch: when false, only admins see the banner.
   * Server resolves canSeeFuse(isAdmin) and passes it down. Flipping
   * FUSE_LIVE=true in env makes this true for everyone.
   */
  fuseVisible?: boolean
}

// Copy for the entitlement / sub-headline line on each variant.
const CLAIM_ENTITLEMENTS: Record<string, string> = {
  Premium: '1 GA ticket included',
  Elite: '1 GA ticket included',
  VIP: '2 VIP tickets + 2 Hall of AIME tickets included',
}
const BUY_SUBLINE = 'General Admission ticket available'

export function FuseClaimBanner({
  planTier,
  billingPeriod,
  fuseTicketClaimedYear,
  activeEventYear = 2026,
  eventName,
  eventLocation,
  isAdmin = false,
  fuseVisible = true,
}: FuseClaimBannerProps) {
  // Pre-go-live: only admins see anything.
  if (!fuseVisible) return null

  // Don't show if already claimed / purchased for this year.
  if (fuseTicketClaimedYear === activeEventYear) {
    return null
  }

  const eligibility = getFuseEligibility(planTier, billingPeriod)
  // Admins always see the banner so they can preview / test the flow,
  // even if their own profile doesn't satisfy the live rules.
  if (eligibility.kind === 'none' && !isAdmin) {
    return null
  }

  // Pick the variant. Admins without a tier default to Claim copy so the
  // existing test flow keeps working; monthly members get Buy copy.
  const variant: 'claim' | 'buy' = eligibility.kind === 'buy' ? 'buy' : 'claim'
  const isClaim = variant === 'claim'

  const entitlement = isClaim
    ? eligibility.kind === 'claim'
      ? CLAIM_ENTITLEMENTS[eligibility.planTier]
      : 'Admin test registration'
    : BUY_SUBLINE
  const ctaLabel = isClaim ? 'Claim Your Ticket' : 'Buy Your Ticket'
  const displayName = eventName || `Fuse ${activeEventYear}`

  return (
    <div className="relative overflow-hidden">
      {/* Fuse 2026 brand: deep navy background */}
      <div
        className="absolute inset-0"
        style={{ background: '#202F60' }}
      />
      {/* Subtle gold accent line at top */}
      <div
        className="absolute top-0 left-0 right-0 h-[2px]"
        style={{
          background: 'linear-gradient(90deg, transparent, #D4A85A, #F4E6CA, #D4A85A, transparent)',
        }}
      />

      {/* Content */}
      <div className="relative px-4 md:px-6 lg:px-8 py-3">
        <div className="flex items-center gap-3">
          {/* Fuse logo mini */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/assets/fuse/fuse-logo.png"
            alt=""
            className="h-8 w-auto flex-shrink-0"
            style={{ filter: 'drop-shadow(0 1px 4px rgba(0,0,0,0.5))' }}
          />

          {/* Event info */}
          <div className="flex items-center gap-2 min-w-0">
            <span
              className="font-bold text-sm whitespace-nowrap"
              style={{ color: '#F4E6CA' }}
            >
              {displayName}
            </span>
            {eventLocation && (
              <span
                className="hidden sm:flex items-center gap-1 text-sm"
                style={{ color: '#D4A85A' }}
              >
                <span style={{ color: '#D4A85A' }}>&#9679;</span>
                Austin, TX
              </span>
            )}
            <span className="hidden md:inline" style={{ color: '#D4A85A88' }}>|</span>
            <span
              className="text-sm hidden md:inline"
              style={{ color: '#F4E6CAcc' }}
            >
              {entitlement}
            </span>
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* CTA */}
          <Link
            href="/dashboard/fuse-registration"
            className="flex items-center gap-1 font-semibold text-sm px-4 py-1.5 rounded-full transition-all whitespace-nowrap hover:bg-[#F4E6CA]"
            style={{
              background: '#ffffff',
              color: '#202F60',
              boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
            }}
          >
            {ctaLabel}
            <ChevronRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </div>
  )
}
