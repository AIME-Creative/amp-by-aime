// AIME-14: Postgres clients used by sync code.
//
// Two distinct clients live here because they serve different needs:
//
//   getSupabaseAdmin()  — Supabase service-role REST client. Used by
//                          handlers to mutate `profiles` and other
//                          public schema tables via RLS-bypassing
//                          PostgREST. Good for typical CRUD.
//
//   getSyncDbUrl()      — raw Postgres connection string. Used by
//                          pg-boss (which opens its own pool) and any
//                          code that needs to write across the
//                          `pgboss` schema where PostgREST has no
//                          access.
//
// Both are lazy so importing this module at build time doesn't blow up
// when env vars aren't set (matches the pattern in lib/stripe/config.ts).

import { createClient, SupabaseClient } from '@supabase/supabase-js';

let cachedClient: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (cachedClient) return cachedClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'getSupabaseAdmin(): NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set',
    );
  }

  cachedClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedClient;
}

// pg-boss needs a session-mode Postgres connection (transaction-mode
// pooler drops LISTEN, which pg-boss uses for low-latency job pickup).
// On Supabase, session-mode is exposed on the pooler hostname at port
// 5432 with username `postgres.<project-ref>`.
//
// Production env var: SYNC_DB_URL  (set in Railway worker service env)
// Staging env var:    SYNC_DB_URL  (set in Railway worker service env)
export function getSyncDbUrl(): string {
  const url = process.env.SYNC_DB_URL;
  if (!url) {
    throw new Error(
      'getSyncDbUrl(): SYNC_DB_URL must be set to a session-mode Postgres connection string',
    );
  }
  return url;
}
