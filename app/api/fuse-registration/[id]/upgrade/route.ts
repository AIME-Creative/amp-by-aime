import { NextResponse } from 'next/server'

// General Admission Plus was retired for Fuse 2026. The upgrade route
// is kept as a 410 Gone stub so any in-flight client calls + stale
// links surface a clear error instead of 404. Once we're confident no
// client refers to this endpoint, the file can be deleted.
export async function POST() {
  return NextResponse.json(
    { error: 'General Admission Plus is no longer available for Fuse 2026.' },
    { status: 410 },
  )
}
