'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

interface Props {
  eventId: string
  eventName: string
  eventYear: number
  eventLocation: string | null
  eventStartDate: string | null
  eventEndDate: string | null
  planTier: string
  ticketLabel: string
  fullName: string | null
  /** 'claim' for annual entitled members, 'buy' for monthly members. */
  variant: 'claim' | 'buy'
}

function formatDateRange(start: string | null, end: string | null): string | null {
  if (!start) return null
  const s = new Date(`${start}T00:00:00`)
  const months = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER']
  const m1 = months[s.getMonth()]
  const d1 = s.getDate()
  const y = s.getFullYear()
  if (end) {
    const e = new Date(`${end}T00:00:00`)
    const d2 = e.getDate()
    if (s.getMonth() === e.getMonth()) return `${m1} ${d1}-${d2}, ${y}`
    return `${m1} ${d1} - ${months[e.getMonth()]} ${d2}, ${y}`
  }
  return `${m1} ${d1}, ${y}`
}

export default function ClaimFuseTicketClient({
  eventId,
  eventName,
  eventYear,
  eventLocation,
  eventStartDate,
  eventEndDate,
  planTier,
  ticketLabel,
  fullName,
  variant,
}: Props) {
  const router = useRouter()
  const supabase = createClient()
  const [busy, setBusy] = useState<'claim' | 'skip' | null>(null)

  const dateRange = formatDateRange(eventStartDate, eventEndDate)

  const advanceOnboarding = async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return
    await supabase
      .from('profiles')
      .update({ onboarding_step: 'complete_profile' })
      .eq('id', user.id)
  }

  const handleClaim = async () => {
    if (busy) return
    setBusy('claim')
    try {
      const ticketType = planTier === 'VIP' ? 'vip' : 'general_admission'
      const res = await fetch('/api/fuse-registration/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fuse_event_id: eventId,
          step: 'claim',
          ticket_type: ticketType,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to claim')
      toast.success('Ticket claimed! Add guests or add-ons anytime from your dashboard.')
      await advanceOnboarding()
      router.push('/onboarding/complete-profile')
    } catch (err: any) {
      toast.error(err.message || 'Failed to claim ticket')
      setBusy(null)
    }
  }

  // Monthly members go to the dashboard fuse page to complete their
  // General Admission purchase. Advance onboarding first so refreshes
  // don't loop them back here.
  const handleBuy = async () => {
    if (busy) return
    setBusy('claim')
    try {
      await advanceOnboarding()
      router.push('/dashboard/fuse-registration')
    } catch {
      setBusy(null)
    }
  }

  const handleSkip = async () => {
    if (busy) return
    setBusy('skip')
    try {
      await advanceOnboarding()
      router.push('/onboarding/complete-profile')
    } catch {
      setBusy(null)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8" style={{ background: '#202F60' }}>
      {/* Subtle gold top accent */}
      <div
        className="fixed top-0 left-0 right-0 h-[2px]"
        style={{
          background: 'linear-gradient(90deg, transparent, #D4A85A, #F4E6CA, #D4A85A, transparent)',
        }}
      />

      <div className="w-full max-w-2xl">
        <div className="rounded-2xl overflow-hidden" style={{ background: '#1A2750', border: '1px solid #2B3A6A' }}>
          {/* Hero */}
          <div className="px-6 sm:px-10 py-10 text-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/assets/fuse/fuse-logo.png"
              alt={eventName}
              className="h-20 w-auto mx-auto mb-6"
              style={{ filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.4))' }}
            />
            {dateRange && (
              <div className="text-sm font-bold tracking-widest" style={{ color: '#F4E6CA' }}>
                {dateRange}
              </div>
            )}
            {eventLocation && (
              <div className="text-xs tracking-widest mt-1" style={{ color: '#D4A85A' }}>
                {eventLocation.toUpperCase()}
              </div>
            )}
          </div>

          {/* Body */}
          <div className="px-6 sm:px-10 pb-10">
            <div
              className="rounded-xl px-5 py-4 mb-6 text-center"
              style={{ background: '#D4A85A22', border: '1px solid #D4A85A44' }}
            >
              <p className="text-sm" style={{ color: '#F4E6CA' }}>
                {fullName ? <>Welcome, <strong style={{ color: '#ffffff' }}>{fullName.split(' ')[0]}</strong>! </> : ''}
                {variant === 'claim' ? (
                  <>Your membership includes <strong style={{ color: '#ffffff' }}>{ticketLabel}</strong> to Fuse {eventYear}.</>
                ) : (
                  <>Pick up your <strong style={{ color: '#ffffff' }}>{ticketLabel}</strong> for Fuse {eventYear}.</>
                )}
              </p>
            </div>

            <div className="text-center text-sm mb-8" style={{ color: '#F4E6CAcc' }}>
              {variant === 'claim'
                ? "Claim it now and we'll save your seat. You can add guests or the Hall of AIME anytime from your dashboard."
                : "Pick your ticket and complete payment on the next screen. You can add guests and add-ons there too."}
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={variant === 'claim' ? handleClaim : handleBuy}
                disabled={!!busy}
                className="flex-1 px-6 py-3 rounded-full font-bold text-sm tracking-wider uppercase transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                style={{
                  background: '#ffffff',
                  color: '#202F60',
                  boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
                  cursor: busy ? 'wait' : 'pointer',
                }}
                onMouseEnter={(e) => !busy && (e.currentTarget.style.background = '#F4E6CA')}
                onMouseLeave={(e) => (e.currentTarget.style.background = '#ffffff')}
              >
                {busy === 'claim' ? (
                  <span className="inline-flex items-center justify-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {variant === 'claim' ? 'Claiming…' : 'Loading…'}
                  </span>
                ) : variant === 'claim' ? (
                  'Claim My Ticket'
                ) : (
                  'Buy My Ticket'
                )}
              </button>

              <button
                onClick={handleSkip}
                disabled={!!busy}
                className="flex-1 px-6 py-3 rounded-full font-semibold text-sm tracking-wider uppercase transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                style={{
                  background: 'transparent',
                  color: '#F4E6CAcc',
                  border: '1px solid #D4A85A66',
                  cursor: busy ? 'wait' : 'pointer',
                }}
                onMouseEnter={(e) => !busy && (e.currentTarget.style.background = '#D4A85A22')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                {busy === 'skip' ? (
                  <span className="inline-flex items-center justify-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Skipping…
                  </span>
                ) : (
                  'Skip for now'
                )}
              </button>
            </div>

            <p className="text-center text-xs mt-6" style={{ color: '#F4E6CA88' }}>
              You can claim later from the Fuse banner in your dashboard.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
