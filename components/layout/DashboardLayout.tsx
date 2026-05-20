'use client'

import { ReactNode } from 'react'
import Sidebar from './Sidebar'
import MobileNav from './MobileNav'
import MobileHeader from './MobileHeader'
import DashboardHeader from './DashboardHeader'
import { ViewAsBanner } from './ViewAsBanner'
import { ImpersonationBanner } from './ImpersonationBanner'
import { PaymentFailedBanner } from '@/components/dashboard/PaymentFailedBanner'
import { FuseClaimBanner } from '@/components/dashboard/FuseClaimBanner'

interface DashboardLayoutProps {
  children: ReactNode
  user?: {
    full_name?: string
    email: string
    avatar_url?: string
  }
  isAdmin?: boolean
  userRole?: string
  paymentFailedAt?: string | null
  subscriptionStatus?: string
  planTier?: string | null
  billingPeriod?: string | null
  subscriptionOverride?: boolean | null
  fuseTicketClaimedYear?: number | null
  fuseActiveEventYear?: number
  fuseActiveEventEndDate?: string | null
  fuseEventName?: string
  fuseEventLocation?: string
  /** Pre-go-live kill switch: gates all Fuse UI to admins only when false. */
  fuseVisible?: boolean
  /** True when admin is in View As or Impersonation mode */
  isAdminPreview?: boolean
}

export default function DashboardLayout({
  children,
  user,
  isAdmin,
  userRole,
  paymentFailedAt,
  subscriptionStatus,
  planTier,
  billingPeriod,
  subscriptionOverride,
  fuseTicketClaimedYear,
  fuseActiveEventYear,
  fuseActiveEventEndDate,
  fuseEventName,
  fuseEventLocation,
  fuseVisible = false,
  isAdminPreview = false,
}: DashboardLayoutProps) {
  return (
    <div className="flex min-h-screen bg-gray-50">
      {/* Desktop Sidebar */}
      <div className="hidden md:block">
        <Sidebar
          user={user}
          userRole={userRole}
          fuseActiveEventYear={fuseActiveEventYear}
          fuseActiveEventEndDate={fuseActiveEventEndDate}
          fuseTicketClaimedYear={fuseTicketClaimedYear}
          fuseVisible={fuseVisible}
        />
      </div>

      {/* Mobile Header */}
      <MobileHeader />

      {/* Main Content */}
      <main className="flex-1 md:ml-56 transition-all duration-300 pt-14 md:pt-0 pb-16 md:pb-0">
        {/* Impersonation Banner (shows when admin is logged in as a specific user) */}
        <ImpersonationBanner />

        {/* View As Banner (only shows when admin is previewing as a role/tier) */}
        <ViewAsBanner />

        {/* Payment Failed Banner (shows when subscription payment failed) */}
        <div className="px-4 md:px-6 lg:px-8">
          <PaymentFailedBanner
            paymentFailedAt={paymentFailedAt ?? null}
            subscriptionStatus={subscriptionStatus}
          />
        </div>

        {/* Fuse Claim Banner (eligible annual members; admins always see for testing) */}
        <FuseClaimBanner
          planTier={planTier}
          billingPeriod={billingPeriod}
          subscriptionOverride={subscriptionOverride}
          fuseTicketClaimedYear={fuseTicketClaimedYear}
          activeEventYear={fuseActiveEventYear}
          eventName={fuseEventName}
          eventLocation={fuseEventLocation}
          isAdmin={isAdmin}
          fuseVisible={fuseVisible}
        />

        {/* Dashboard Header (Search, Notifications, User Actions) */}
        <DashboardHeader user={user} isAdmin={isAdmin} />

        {/* Page Content */}
        {children}
      </main>

      {/* Mobile Bottom Navigation */}
      <MobileNav
        userRole={userRole}
        fuseActiveEventYear={fuseActiveEventYear}
        fuseActiveEventEndDate={fuseActiveEventEndDate}
        fuseTicketClaimedYear={fuseTicketClaimedYear}
        fuseVisible={fuseVisible}
      />
    </div>
  )
}
