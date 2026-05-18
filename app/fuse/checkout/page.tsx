import { notFound } from 'next/navigation'
import { createClient } from '@supabase/supabase-js'
import { FuseCheckout } from '@/components/fuse/FuseCheckout'
import { pickActivePrice, pickActivePrices } from '@/lib/fuse/pricing'
import { isFuseLive } from '@/lib/fuse/visibility'

export const dynamic = 'force-dynamic'

export default async function FuseCheckoutPage() {
  // Pre-go-live: the public Fuse checkout doesn't exist as far as
  // visitors are concerned. There's no logged-in user here to derive
  // admin status from, so the gate is the env var alone. Admins who
  // need to QA this surface should flip FUSE_LIVE temporarily or test
  // against a staging env that has it set.
  if (!isFuseLive()) {
    notFound()
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: event } = await supabase
    .from('fuse_events')
    .select('id, name, year, start_date, end_date, location, registration_open')
    .eq('is_active', true)
    .single()

  if (!event) {
    return (
      <div style={{
        minHeight: '100vh',
        background: '#1a1008',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#a08860',
        fontFamily: 'Inter, sans-serif',
      }}>
        <div style={{ textAlign: 'center' }}>
          <h1 style={{ fontSize: 24, marginBottom: 8, color: '#c8a050' }}>
            No Active Event
          </h1>
          <p>Registration is not currently open. Check back soon!</p>
        </div>
      </div>
    )
  }

  if (event.registration_open === false) {
    return (
      <div style={{
        minHeight: '100vh',
        background: '#1a1008',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#a08860',
        fontFamily: 'Inter, sans-serif',
      }}>
        <div style={{ textAlign: 'center' }}>
          <h1 style={{ fontSize: 24, marginBottom: 8, color: '#c8a050' }}>
            Registration Coming Soon
          </h1>
          <p>Registration for {event.name} is not yet open. Check back soon!</p>
        </div>
      </div>
    )
  }

  // Fetch public prices (tier IS NULL) for this event
  const { data: prices } = await supabase
    .from('fuse_ticket_prices')
    .select('*')
    .eq('fuse_event_id', event.id)
    .is('tier', null)
    .eq('is_active', true)
    .order('sort_order')

  // Pick one active price row per public product (phase-aware, deduped).
  const publicPrices = pickActivePrices(prices, null)
  const activeGA = pickActivePrice(prices, 'ga', null)
  const isEarlyBird = activeGA?.pricing_phase === 'early_bird'

  return (
    <FuseCheckout
      event={event}
      prices={publicPrices}
      isEarlyBird={isEarlyBird}
    />
  )
}
