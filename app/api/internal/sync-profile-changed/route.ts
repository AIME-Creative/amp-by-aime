// AIME-15: internal receiver for profile-changed events.
//
// Called by the `sync_profile_to_ghl_v2_trigger` Postgres trigger via
// pg_net.http_post when a watched profile field changes. Authenticated
// by a shared secret (NOT public-facing — this URL is never linked).
//
// Pipeline:
//   1. Verify the shared secret header (else 401)
//   2. Validate { event_id, op, profile_id }
//   3. INSERT into sync_events with source='app' (UNIQUE dedup at receiver)
//   4. If new row: enqueue pg-boss job with singletonKey=profile_id
//      so per-profile updates process in enqueue order
//   5. Return 200
//
// The worker handler refetches the full profile from Supabase
// (reconcile-from-source). Payload here only carries the id.

import { NextRequest, NextResponse } from 'next/server';
import {
  enqueue,
  getSupabaseAdmin,
  insertReceivedEvent,
  QUEUE_NAMES,
} from '@/lib/sync';

interface ProfileChangedPayload {
  event_id?: unknown;
  op?: unknown;
  profile_id?: unknown;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const expected = process.env.INTERNAL_SYNC_SECRET;
  if (!expected) {
    console.error('[sync-profile-changed] INTERNAL_SYNC_SECRET not configured');
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const provided = request.headers.get('x-internal-sync-secret');
  if (!provided || provided !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: ProfileChangedPayload;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const eventId = typeof body.event_id === 'string' ? body.event_id : null;
  const op = typeof body.op === 'string' ? body.op : null;
  const profileId = typeof body.profile_id === 'string' ? body.profile_id : null;

  if (!eventId || !profileId || (op !== 'INSERT' && op !== 'UPDATE')) {
    return NextResponse.json(
      { error: 'Missing or invalid event_id, op, or profile_id' },
      { status: 400 },
    );
  }

  const db = getSupabaseAdmin();
  let row;
  try {
    row = await insertReceivedEvent(db, {
      source: 'app',
      event_id: eventId,
      event_type: 'profile.upsert',
      payload: { op, profile_id: profileId },
    });
  } catch (err) {
    console.error('[sync-profile-changed] sync_events insert failed:', err);
    return NextResponse.json({ error: 'Audit write failed' }, { status: 500 });
  }

  if (row === null) {
    // Duplicate event_id (trigger re-fired same uuid — shouldn't happen in
    // practice since the trigger generates a fresh uuid each call, but
    // the contract holds).
    return NextResponse.json({ received: true, duplicate: true });
  }

  try {
    await enqueue(
      QUEUE_NAMES.appProfileGhlUpsert,
      { sync_event_id: row.id },
      { singletonKey: profileId },
    );
  } catch (err) {
    console.error('[sync-profile-changed] pg-boss enqueue failed:', err);
    return NextResponse.json({ error: 'Enqueue failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true, sync_event_id: row.id });
}
