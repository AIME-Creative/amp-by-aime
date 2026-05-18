import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import Image from 'next/image'
import Link from 'next/link'
import { ArrowLeft, Repeat } from 'lucide-react'
import { EventDetailClient } from './EventDetailClient'
import { notFound } from 'next/navigation'
import { getViewAsSettings, applyViewAsOverride } from '@/lib/view-as-server'
import { UpgradeBanner } from '@/components/ui/upgrade-banner'
import { formatRecurrenceRule, getNextOccurrence, toStartCase } from '@/lib/recurrence-utils'
import { ViewTracker } from '@/components/analytics/ViewTracker'

// Helper function to format event date and time in the event's timezone
function formatEventDateTime(startDate: string, timezone?: string): { date: string; time: string } {
  const eventDate = new Date(startDate)
  const tz = timezone || 'America/New_York'

  const dateOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: tz,
  }

  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: tz,
  }

  // Convert timezone to abbreviation
  const timezoneAbbr = tz.includes('New_York') ? 'ET'
    : tz.includes('Chicago') ? 'CT'
    : tz.includes('Denver') ? 'MT'
    : tz.includes('Los_Angeles') ? 'PT'
    : 'ET'

  const formattedDate = eventDate.toLocaleDateString('en-US', dateOptions)
  const formattedTime = `${eventDate.toLocaleTimeString('en-US', timeOptions)} ${timezoneAbbr}`

  return { date: formattedDate, time: formattedTime }
}

interface EventDetailPageProps {
  params: Promise<{ id: string }>
}

export default async function EventDetailPage({ params }: EventDetailPageProps) {
  const { id } = await params
  const supabase = await createClient()

  // Fetch event from database with type info
  const { data: eventData, error } = await supabase
    .from('events')
    .select(`
      *,
      type:type_id (
        id,
        name,
        slug,
        color
      )
    `)
    .eq('id', id)
    .single()

  // Get current user for access control
  const { data: { user } } = await supabase.auth.getUser()
  let { data: profile } = await supabase
    .from('profiles')
    .select('role, plan_tier, billing_period, is_admin, fuse_ticket_claimed_year')
    .eq('id', user?.id)
    .single()

  // Apply view-as override if active
  const viewAsSettings = await getViewAsSettings()
  profile = applyViewAsOverride(profile, viewAsSettings)

  // Detect whether this event row corresponds to the active Fuse event so
  // we can surface a "Claim Your Ticket" CTA. Match by title containing
  // "Fuse" + the active fuse year present in the title or start date.
  const { data: activeFuseEvent } = await supabase
    .from('fuse_events')
    .select('year, name')
    .eq('is_active', true)
    .single()

  const titleLower = (eventData.title || '').toLowerCase()
  const isFuseEvent =
    !!activeFuseEvent &&
    titleLower.includes('fuse') &&
    (titleLower.includes(String(activeFuseEvent.year)) ||
      titleLower.includes((activeFuseEvent.name || '').toLowerCase()))

  const eligibleTiers = ['Premium', 'Elite', 'VIP']
  const fuseEligible =
    !!isFuseEvent &&
    (profile?.is_admin === true ||
      (!!profile?.plan_tier &&
        eligibleTiers.includes(profile.plan_tier) &&
        (profile?.billing_period ?? '').toLowerCase() === 'annual'))
  const fuseClaimed =
    !!activeFuseEvent &&
    profile?.fuse_ticket_claimed_year === activeFuseEvent.year

  if (error || !eventData) {
    notFound()
  }

  // Check if user has access (admins bypass)
  let hasAccess = true
  if (!profile?.is_admin) {
    // Map "Premium Guest" to "Premium" for access checks
    const effectiveTier = profile?.plan_tier === 'Premium Guest' ? 'Premium' : profile?.plan_tier

    const hasPlanAccess = !eventData.required_plan_tier ||
      eventData.required_plan_tier.length === 0 ||
      eventData.required_plan_tier.includes(effectiveTier)

    hasAccess = hasPlanAccess
  }

  // For recurring events, calculate next occurrence
  let displayDate = eventData.start_date
  if (eventData.is_recurring && eventData.recurrence_rule) {
    const nextOccurrence = getNextOccurrence(eventData.start_date, eventData.recurrence_rule, eventData.recurrence_end_date || undefined)
    if (nextOccurrence) {
      displayDate = nextOccurrence.toISOString()
    }
  }

  const { date, time } = formatEventDateTime(displayDate, eventData.timezone)

  // Prioritize type_id (content_types) over event_type enum
  const typeName = (eventData.type as any)?.name || eventData.event_type
  const typeColor = (eventData.type as any)?.color || '#6b7280'

  const event = {
    id: eventData.id,
    title: eventData.title,
    type: toStartCase(typeName),
    date,
    time,
    image: eventData.thumbnail_url || 'https://placehold.co/800x450/8b1554/white?text=' + encodeURIComponent(eventData.title),
    eventUrl: eventData.registration_url || eventData.meeting_url || '',
    description: eventData.description || '',
    typeColor: typeColor,
    startDate: eventData.start_date,
    endDate: eventData.end_date,
    location: eventData.location,
    isRecurring: eventData.is_recurring,
    recurrenceRule: eventData.recurrence_rule,
    recurrenceEndDate: eventData.recurrence_end_date
  }

  // If user doesn't have access, show upgrade banner
  if (!hasAccess) {
    return (
      <div className="min-h-screen bg-gray-50">
        {/* Back Button */}
        <div className="px-4 md:px-8 py-4 bg-white border-b">
          <Link
            href="/dashboard/events"
            className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="text-sm font-medium">Back to events</span>
          </Link>
        </div>

        {/* Event Header with Basic Info */}
        <div className="px-4 md:px-8 py-6 md:py-8 bg-white">
          <div className="max-w-5xl mx-auto text-center">
            <h1 className="text-3xl md:text-4xl font-bold text-gray-900 mb-2">
              {event.title}
            </h1>
            <Badge
              className="text-white border-0 mb-4"
              style={{ backgroundColor: event.typeColor, color: 'white' }}
            >
              {event.type}
            </Badge>
          </div>
        </div>

        {/* Upgrade Banner */}
        <div className="px-4 md:px-8 py-6 md:py-8">
          <UpgradeBanner
            requiredTiers={eventData.required_plan_tier || []}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen">
      {/* Analytics Tracking */}
      <ViewTracker
        contentType="event"
        contentId={eventData.id}
        contentTitle={eventData.title}
      />

      {/* Back Button */}
      <div className="px-4 md:px-8 py-4">
        <Link
          href="/dashboard/events"
          className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span className="text-sm font-medium">Back to events</span>
        </Link>
      </div>

      {/* Fuse claim CTA: shows for eligible members who haven't claimed yet.
          Matches the Fuse banner / claim card brand: navy bg, white pill,
          cream text. */}
      {isFuseEvent && fuseEligible && !fuseClaimed && (
        <div className="px-4 md:px-8 pb-4">
          <div
            className="rounded-lg p-4 md:p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-3"
            style={{ background: '#202F60', border: '1px solid #D4A85A33' }}
          >
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/assets/fuse/fuse-logo.png"
                alt=""
                className="h-10 w-auto"
              />
              <div>
                <div className="font-bold text-sm" style={{ color: '#F4E6CA' }}>
                  Your membership includes a Fuse ticket
                </div>
                <div className="text-xs" style={{ color: '#D4A85A' }}>
                  Claim it now and add guests or add-ons later.
                </div>
              </div>
            </div>
            <Link
              href="/dashboard/fuse-registration"
              className="font-semibold text-sm px-5 py-2 rounded-full transition-all hover:bg-[#F4E6CA] whitespace-nowrap text-center"
              style={{
                background: '#ffffff',
                color: '#202F60',
                boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
              }}
            >
              Claim Your Ticket
            </Link>
          </div>
        </div>
      )}

      {/* "You're registered" callout when they've already claimed */}
      {isFuseEvent && fuseClaimed && (
        <div className="px-4 md:px-8 pb-4">
          <div
            className="rounded-lg p-4 flex items-center justify-between gap-3"
            style={{ background: '#3a5a2022', border: '1px solid #3a5a2055' }}
          >
            <div className="text-sm font-semibold" style={{ color: '#3a5a20' }}>
              You&apos;re registered for Fuse 2026.
            </div>
            <Link
              href="/dashboard/fuse-registration"
              className="text-sm underline"
              style={{ color: '#202F60' }}
            >
              Manage registration
            </Link>
          </div>
        </div>
      )}

      {/* Event Header */}
      <div className="px-4 md:px-8 pb-6">
        <div className="bg-white rounded-lg shadow-lg p-6 md:p-8">
          <div className="flex flex-col md:flex-row gap-6 md:gap-8 items-start">
            {/* Event Image */}
            <div className="w-full md:w-96 flex-shrink-0">
              <div className="relative aspect-video bg-gray-200 rounded-lg overflow-hidden">
                <Image
                  src={event.image}
                  alt={event.title}
                  fill
                  className="object-cover"
                />
              </div>
            </div>

            {/* Event Info */}
            <div className="flex-1">
              <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-4">
                <div>
                  <h1 className="text-3xl md:text-4xl font-bold text-gray-900 mb-2">
                    {event.title}
                  </h1>
                  <div className="flex gap-2 mb-4">
                    <Badge
                      className="text-white border-0"
                      style={{ backgroundColor: event.typeColor, color: 'white' }}
                    >
                      {event.type}
                    </Badge>
                    {event.isRecurring && (
                      <Badge className="bg-[#25314e] text-white hover:bg-[#25314e] flex items-center gap-1">
                        <Repeat className="w-3 h-3" />
                        Recurring
                      </Badge>
                    )}
                  </div>
                </div>

                {/* Action Buttons */}
                <EventDetailClient
                  eventId={event.id}
                  eventName={event.title}
                  eventUrl={event.eventUrl}
                  startDate={event.startDate}
                  endDate={event.endDate}
                  location={event.location}
                  description={event.description}
                  isRecurring={event.isRecurring}
                  recurrenceRule={event.recurrenceRule}
                  recurrenceEndDate={event.recurrenceEndDate}
                />
              </div>

              {/* Date and Time */}
              <div className="inline-block bg-[#25314e] text-white px-4 py-2 rounded-lg text-sm font-medium mb-2">
                {event.date} | {event.time}
              </div>

              {/* Recurrence Pattern */}
              {event.isRecurring && event.recurrenceRule && (
                <div className="mb-6">
                  <p className="text-[#dd1969] font-semibold text-sm flex items-center gap-2">
                    <Repeat className="w-4 h-4" />
                    {formatRecurrenceRule(event.recurrenceRule)}
                  </p>
                </div>
              )}

              {/* Description */}
              <div
                className="prose max-w-none text-gray-700 leading-relaxed"
                dangerouslySetInnerHTML={{ __html: event.description }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
