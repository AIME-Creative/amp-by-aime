-- AIME-14: sync_events audit log.
--
-- Single source of truth for every external event AMP receives (Stripe,
-- GHL, internal app triggers). Every receiver INSERTs into this table
-- before doing any business logic. The UNIQUE (source, event_id)
-- constraint is the dedup primitive: when an upstream replay arrives,
-- the second INSERT is a no-op and the receiver knows to skip enqueueing
-- the same job twice.
--
-- pg-boss jobs (in the pgboss schema) reference sync_events.id and
-- handlers update processed_at + outcome here when they finish.
-- pg-boss is the work queue; sync_events is the immutable history.
--
-- Status lifecycle:
--   received   — row exists, pg-boss job enqueued (or about to be)
--   processing — handler picked up the job
--   processed  — handler wrote side effects + processed_at in same tx
--   failed     — handler errored; pg-boss will retry per its config
--   dlq        — pg-boss exhausted retryLimit; job copied to *-dlq queue
--
-- Status is advisory — the authoritative work queue state lives in
-- pgboss.job. We mirror it here so ops can answer "did event X get
-- processed" with a single query against sync_events.

BEGIN;

CREATE TABLE IF NOT EXISTS public.sync_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source       TEXT NOT NULL CHECK (source IN ('stripe', 'ghl', 'app')),
  event_id     TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  payload      JSONB NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'received'
                 CHECK (status IN ('received', 'processing', 'processed', 'failed', 'dlq')),
  retry_count  INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  outcome      JSONB,
  CONSTRAINT sync_events_source_event_id_key UNIQUE (source, event_id)
);

-- Ops queries: "show me anything stuck or failed."
CREATE INDEX IF NOT EXISTS idx_sync_events_status
  ON public.sync_events (status)
  WHERE status IN ('failed', 'dlq', 'processing');

-- Chronological scans for recent activity dashboards.
CREATE INDEX IF NOT EXISTS idx_sync_events_received_at
  ON public.sync_events (received_at DESC);

-- Per-type queries: "all Stripe subscription.updated events in the last hour."
CREATE INDEX IF NOT EXISTS idx_sync_events_source_event_type
  ON public.sync_events (source, event_type);

-- This is internal system state. No client should ever read it directly;
-- service-role-only access is sufficient. RLS is enabled with no
-- authenticated/anon policies, which means non-service-role roles get
-- an empty result set.
ALTER TABLE public.sync_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage sync events"
  ON public.sync_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.sync_events IS
  'AIME-14: immutable audit log of every external event AMP receives. '
  'UNIQUE(source, event_id) provides idempotency. pg-boss handles the '
  'transient work queue; this table is the durable history.';

COMMIT;
