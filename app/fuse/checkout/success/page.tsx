import { notFound } from 'next/navigation'
import { createClient } from '@supabase/supabase-js'
import { FuseCheckoutSuccess } from '@/components/fuse/FuseCheckoutSuccess'
import { isFuseLive } from '@/lib/fuse/visibility'

interface Props {
  searchParams: Promise<{ registration_id?: string }>
}

export default async function FuseCheckoutSuccessPage({ searchParams }: Props) {
  // Pre-go-live: the public checkout success page is part of the same
  // surface as /fuse/checkout. Gate by env var. Existing rows in the
  // DB stay reachable the moment FUSE_LIVE flips on.
  if (!isFuseLive()) {
    notFound()
  }

  const params = await searchParams
  const registrationId = params.registration_id

  if (!registrationId) {
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
            Registration Not Found
          </h1>
          <p>We couldn&apos;t find your registration. Please contact support.</p>
        </div>
      </div>
    )
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: registration } = await supabase
    .from('fuse_registrations')
    .select('*, fuse_events(*)')
    .eq('id', registrationId)
    .single()

  if (!registration) {
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
            Registration Not Found
          </h1>
          <p>We couldn&apos;t find your registration. Please contact support.</p>
        </div>
      </div>
    )
  }

  return <FuseCheckoutSuccess registration={registration} event={registration.fuse_events} />
}
