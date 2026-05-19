# aime-sync-worker

Long-lived Node service that processes the pg-boss queue for AMP's
external-system sync layer (Stripe → Supabase → GHL).

Background: see [`docs/adr/0001-event-driven-sync-with-pg-boss.md`](../docs/adr/0001-event-driven-sync-with-pg-boss.md).

## Running locally

```sh
npm install
SYNC_DB_URL='postgresql://...' \
NEXT_PUBLIC_SUPABASE_URL='https://nuuffnxjsjqdoubvrtcl.supabase.co' \
SUPABASE_SERVICE_ROLE_KEY='...' \
STRIPE_SECRET_KEY='sk_test_...' \
  npm run worker:dev
```

`worker:dev` reloads on file changes; `worker:start` is the production
entrypoint (no watch).

`SYNC_DB_URL` must be a **session-mode** connection string, not the
transaction-mode pooler — pg-boss uses `LISTEN`/`NOTIFY`. On Supabase
that means port 5432 with the `postgres.<project-ref>` username:

```
postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

(All four required env vars live in `.env.staging` already; source that
file or pass them inline.)

## Railway deployment (one-time setup)

Railway-side configuration is done in the Railway dashboard — this repo
intentionally has no `railway.json` because the main app service relies
on Railpack auto-detect and we don't want to introduce a config file
that overrides that behavior for the existing service. The worker is
declared as a **second Railway service in the same project**, pointing
at the same repo and branch:

| Setting | Value |
|---|---|
| Service name | `aime-sync-worker` |
| Source repo | `JoeLuci/amp-by-aime` (same as main service) |
| Branch (staging) | `staging` |
| Branch (prod) | `main` |
| Build command | (default — Railpack auto-detect, runs `npm install`) |
| Start command | `npm run worker:start` |
| Healthcheck path | (none — worker has no HTTP port) |
| Watch paths | `worker/**`, `lib/sync/**`, `lib/stripe/**`, `lib/supabase/**`, `package.json`, `package-lock.json` |

Required env vars on the worker service (copy from the main service
plus add `SYNC_DB_URL`):

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY`
- `SYNC_DB_URL` *(new — session-mode Postgres connection string)*
- `NODE_ENV=production`

Required env var on the **Next.js (main) service** for the new receiver:

- `STRIPE_WEBHOOK_SECRET_SYNC` *(new — signing secret for the new
  `/api/webhooks/sync-stripe` endpoint, separate from the legacy
  `STRIPE_WEBHOOK_SECRET` that the old `/api/webhooks/stripe` route
  and the legacy `stripe-webhook` Edge Function continue to use)*

## Observability

Logs are structured JSON on stdout. Each line is one event. Tail in
Railway's log viewer, filter on `svc=aime-sync-worker`. Useful fields:
`msg`, `queue`, `sync_event_id`, `error`.

For ops queries, hit the database directly:

```sql
-- Anything stuck or failed in the last hour
SELECT id, source, event_type, status, retry_count, last_error
FROM public.sync_events
WHERE received_at > now() - interval '1 hour'
  AND status IN ('failed', 'dlq', 'processing')
ORDER BY received_at DESC;

-- pg-boss queue depth per queue
SELECT name, state, count(*)
FROM pgboss.job
WHERE state IN ('created', 'active', 'retry')
GROUP BY 1, 2;
```

## Adding a new handler

1. Add a queue name to `QUEUE_NAMES` in `lib/sync/types.ts`.
2. Add the routing rule in `queueForStripeEvent()` (or its analogue
   for other sources) in `lib/sync/queue.ts`.
3. Add a handler module in `worker/handlers/`.
4. Register it in `worker/index.ts` via `boss.work(...)`.
5. Add unit tests in `tests/worker/handlers/`.
