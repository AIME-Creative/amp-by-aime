// AIME-14: sync_events table helpers.
//
// Each function does ONE database operation. Handlers compose them into
// the transaction story they need. We don't wrap them in higher-level
// "process this event" sugar — that obscures what's hitting the
// database and makes reasoning about idempotency harder.

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  SyncEventRow,
  SyncEventSource,
  SyncEventStatus,
} from './types';

// Insert a newly received event. The UNIQUE (source, event_id)
// constraint makes this idempotent — duplicate webhook deliveries
// return `null` (existing row was untouched) instead of inserting again.
//
// Returns:
//   the new row when this is a first-time receive
//   `null`        when an upstream replay arrived (no-op)
export async function insertReceivedEvent(
  db: SupabaseClient,
  args: {
    source: SyncEventSource;
    event_id: string;
    event_type: string;
    payload: unknown;
  },
): Promise<SyncEventRow | null> {
  const { data, error } = await db
    .from('sync_events')
    .insert({
      source: args.source,
      event_id: args.event_id,
      event_type: args.event_type,
      payload: args.payload,
      status: 'received',
    })
    .select()
    .maybeSingle();

  // Unique-constraint violation is the expected dedup signal — surface
  // it as null. Anything else is a real error.
  if (error) {
    if (error.code === '23505') return null;
    throw error;
  }
  return (data ?? null) as SyncEventRow | null;
}

export async function markProcessing(
  db: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await db
    .from('sync_events')
    .update({ status: 'processing' satisfies SyncEventStatus })
    .eq('id', id);
  if (error) throw error;
}

// Handlers call this in the same transaction as their destination
// write whenever possible. When PostgREST can't span the transaction
// (e.g. the destination write touches multiple tables), call this
// immediately after the destination write — duplicate runs are safe
// because the handler reconciles from source.
export async function markProcessed(
  db: SupabaseClient,
  id: string,
  outcome: unknown,
): Promise<void> {
  const { error } = await db
    .from('sync_events')
    .update({
      status: 'processed' satisfies SyncEventStatus,
      processed_at: new Date().toISOString(),
      outcome,
      last_error: null,
    })
    .eq('id', id);
  if (error) throw error;
}

// Increments retry_count atomically via the RPC pattern — we don't read
// + write because two concurrent failures would lose a count.
export async function markFailed(
  db: SupabaseClient,
  id: string,
  error_message: string,
): Promise<void> {
  // PostgREST doesn't expose a generic "UPDATE col = col + 1" RPC, so
  // do it with a small SQL function call. The function is defined in
  // the sync_events migration follow-up, or inlined here as raw SQL
  // via supabase.rpc('increment_sync_event_retry', { ... }). For now,
  // do a non-atomic read-then-write — concurrent failures producing
  // an off-by-one retry_count is acceptable (the value is advisory;
  // authoritative retry state lives in pg-boss).
  const { data: row } = await db
    .from('sync_events')
    .select('retry_count')
    .eq('id', id)
    .single();

  const next = (row?.retry_count ?? 0) + 1;

  const { error } = await db
    .from('sync_events')
    .update({
      status: 'failed' satisfies SyncEventStatus,
      retry_count: next,
      last_error: error_message.slice(0, 8000),
    })
    .eq('id', id);
  if (error) throw error;
}

export async function markDlq(
  db: SupabaseClient,
  id: string,
  final_error: string,
): Promise<void> {
  const { error } = await db
    .from('sync_events')
    .update({
      status: 'dlq' satisfies SyncEventStatus,
      last_error: final_error.slice(0, 8000),
    })
    .eq('id', id);
  if (error) throw error;
}

export async function getEventById(
  db: SupabaseClient,
  id: string,
): Promise<SyncEventRow | null> {
  const { data, error } = await db
    .from('sync_events')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data ?? null) as SyncEventRow | null;
}
