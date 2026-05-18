# ADR 0001 — Event-driven sync layer on pg-boss + Node worker

**Status:** Proposed
**Date:** 2026-05-16
**Jira:** AIME-13 (epic: Replace Make.com Middleware)
**Supersedes:** the Make.com middleware inventoried in [AIME-12 audit](../aime-12-make-scenarios-audit.md)

---

## 1. Context

AMP's three sources of truth — Stripe (payments / membership), Supabase (portal data), GoHighLevel (CRM, escalations, events) — are stitched together today by 22 in-scope Make.com scenarios plus a parallel set of in-code Supabase Edge Functions. Under burst traffic, Make.com silently drops events. The [AIME-12 audit](../aime-12-make-scenarios-audit.md) measured the resulting state: **988 drifted records across Stripe / Supabase / GHL**, including 386 paying Stripe customers with no active Supabase profile and 367 Stripe customers with no Supabase profile at all by email.

The replacement must satisfy six non-negotiable requirements from the AIME-13 ticket:

1. Idempotent handlers (safe to replay)
2. Retries with exponential backoff
3. Dead-letter queue for persistent failures
4. Ordering guarantees for membership lifecycle events
5. Per-event audit log
6. Survives bursts without dropping events

Adding a new paid managed service is explicitly off the table for AMP. The stack must live on the infrastructure already in place: Supabase Postgres + Edge Functions, and Railway-hosted Next.js.

## 2. Decision

Build the sync layer on three components, all on existing infrastructure:

1. **Postgres-backed queue: `pg-boss` v12** running inside the same Supabase Postgres database used by the app. Provides retries with exponential backoff, dead-letter queues, cron scheduling, and strict per-key FIFO ordering natively. No new vendor, no new bill.
2. **Worker process: a new long-lived Node service `aime-sync-worker`** deployed as a second Railway service from the existing `amp-by-aime` repo. Shares `lib/` code (Stripe / GHL / Supabase clients) with the Next.js app via a new `lib/sync/` directory.
3. **Audit log: a `sync_events` table** in the app database. Every inbound event is persisted here with a `UNIQUE (source, event_id)` constraint *before* a pg-boss job is enqueued. The table is the immutable system of record; pg-boss jobs are transient work referring back to it.

Webhook receivers (`stripe-webhook`, future `ghl-webhook`, internal triggers from the app) remain as Supabase Edge Functions. Their sole job becomes: verify signature → write to `sync_events` → enqueue pg-boss job → return 200. They do no business logic. This keeps the receiving surface burst-tolerant (a fast insert + enqueue completes in milliseconds; bursts are absorbed by the queue, not by the receiver).

The three existing `pg_cron` + `pg_net` scheduled jobs (`reset-annual-escalations`, `expire-overrides-daily`, `sync-stripe-subscriptions`) migrate to pg-boss `schedule()` calls. One job system in production, not two. The P0 finding from AIME-12 — the Make.com "Recurring Agency Access Token [DO NOT TURN OFF]" scenario — becomes a pg-boss scheduled job in the worker, and is the first thing cut over since every other GHL-touching handler depends on the token it refreshes.

## 3. Architecture

```
                ┌──────────────────────────────────────────────────────┐
                │  Inbound events                                      │
                │   Stripe webhooks · GHL webhooks · App-triggered     │
                └──────────────────────────┬───────────────────────────┘
                                           ▼
                ┌──────────────────────────────────────────────────────┐
                │  Supabase Edge Function receivers                    │
                │   1. Verify signature                                │
                │   2. INSERT INTO sync_events                         │
                │      (UNIQUE on source+event_id → dedup is automatic)│
                │   3. pg-boss.send(queue, { sync_event_id })          │
                │   4. Return 200                                      │
                └──────────────────────────┬───────────────────────────┘
                                           ▼
                ┌──────────────────────────────────────────────────────┐
                │  Supabase Postgres                                   │
                │   • sync_events   (immutable audit log)              │
                │   • pgboss.*      (queue tables, managed by pg-boss) │
                └──────────────────────────┬───────────────────────────┘
                                           ▼ (long-poll via pg-boss)
                ┌──────────────────────────────────────────────────────┐
                │  aime-sync-worker (Railway service, Node)            │
                │   • Long-lived process                               │
                │   • One handler per queue name                       │
                │   • Handlers reconcile from source (Stripe / GHL),   │
                │     do not apply deltas from payload                 │
                │   • Marks sync_events row processed in same tx as    │
                │     the destination write                            │
                │   • Cron jobs: agency-token refresh, escalation      │
                │     reset, etc. live here too                        │
                └──────────────────────────────────────────────────────┘
```

### How each non-negotiable is satisfied

| Requirement | Mechanism |
|---|---|
| **Idempotent handlers** | (a) `sync_events` has `UNIQUE (source, event_id)` — duplicate webhook delivery is a no-op at the receiver. (b) Handlers reconcile current state from the source API (Stripe / GHL) instead of applying deltas from the event payload, so re-running a handler produces the same final state. (c) Side effects + `sync_events.processed_at` are written in one Postgres transaction. |
| **Retries with exponential backoff** | pg-boss `retryLimit` + `retryDelay` + `retryBackoff: true` + `retryDelayMax`. Default policy: 5 retries, 30s base delay, exponential, capped at 1 hour. Per-queue overrides where needed. |
| **Dead-letter queue** | pg-boss `deadLetter: '<queue>-dlq'` option per queue. After `retryLimit` is exhausted, the job's payload (including the `sync_event_id`) is copied into the DLQ queue. DLQ queues have no auto-processor — entries require manual triage. Replay = a SQL `UPDATE` returning the row to its source queue. UI deferred to a later ticket. |
| **Ordering guarantees** | pg-boss `policy: 'key_strict_fifo'` with `singletonKey: <customer_id>` for membership lifecycle queues. Stripe events for the same customer are processed strictly in the order they were enqueued. Combined with the reconcile-from-source pattern, out-of-order delivery from upstream is also tolerated — handlers always converge to the current Stripe state. |
| **Per-event audit log** | `sync_events` table. Columns: `id`, `source` (stripe / ghl / app), `event_id` (the upstream's stable ID), `event_type`, `received_at`, `processed_at`, `status` (received / processing / processed / failed / dlq), `retry_count`, `last_error`, `payload` (jsonb), `outcome` (jsonb). Append-only; rows are never deleted. |
| **Survives bursts** | Receivers do O(1) work (signature check + insert + enqueue), so they can absorb 1000s/sec without blocking. Bursts queue up in pg-boss; the worker drains at a configured concurrency cap (start at 10 concurrent jobs per queue). If the worker is down, events accumulate in the queue safely and process when it comes back. |

### Code organization

```
amp-by-aime/
├── app/                          # Next.js (unchanged)
├── lib/
│   └── sync/                     # NEW — shared between Next.js, EFs, worker
│       ├── clients/              # extracted: stripe.ts, ghl.ts, supabase.ts
│       ├── events/               # sync_events table helpers, type defs
│       └── queues/               # pg-boss queue/handler definitions
├── worker/                       # NEW — Railway service entrypoint
│   ├── index.ts                  # boots pg-boss, registers handlers, runs forever
│   └── handlers/                 # one file per queue: stripe-subscription-sync.ts, etc.
├── supabase/
│   ├── functions/                # Edge Functions — receivers stay here, get slimmer
│   └── migrations/               # adds sync_events table + pg-boss schema install
└── docs/adr/0001-...md           # this file
```

### Deployment

- One Railway project, two services from the same repo:
  - `aime-amp` (existing Next.js app, unchanged build)
  - `aime-sync-worker` (new, `npm run worker:start`, no public port)
- Both services share the same env-var namespace in Railway. Worker reads Stripe / GHL / Supabase credentials the same way the Next.js app does.
- Same `staging` and `main` branch convention. Worker auto-deploys alongside the app.

## 4. Cutover & validation

Every Make.com scenario being replaced by this architecture must pass a parallel-run validation in staging before the prod cutover. This is a non-negotiable project rule, not a per-scenario judgment call. The process for each scenario is identical:

### Per-scenario cutover steps

1. **Stage the scenario in Make.com.** Clone the live Make.com scenario inside the existing team and rename it `[STAGING] <original name>`. Reconfigure the cloned scenario's connections to point at staging Supabase, staging GHL (`PJAAN2zV4gJW33Sbm5Sr`), and Stripe test mode. Capture the cloned scenario's webhook URL.
2. **Wire staging to fire both paths.** Set the staging app's env var(s) for that scenario's webhook URL to the `[STAGING]` clone. Implement the new pg-boss handler in `aime-sync-worker` and deploy to the staging Railway service. The same staging event now fires *both* the cloned Make scenario and the new worker handler.
3. **Trigger representative events** in staging — happy path, the edge cases the AIME-12 drift snapshot surfaced for this scenario, and one duplicate / replay event to verify idempotency.
4. **Diff the outcomes** in staging Supabase + staging GHL. The records created or updated by the Make clone and by the new worker handler must match 100% — fields, counts, and ordering. Any discrepancy is a regression — fix the worker, re-run, do not proceed.
5. **Promote to prod.** Only after the 100% match: deploy the worker handler to prod, then disable the live Make scenario in prod (do not delete yet — keep for 7 days as a rollback target).
6. **Clean up.** After 7 days of stable prod operation with no incidents: delete the prod Make scenario, delete the `[STAGING]` Make clone, remove any parallel-run-only code paths.

### Why staging Make.com lives in the same team

Make.com restricts multiple teams per organization to its Teams tier and above — Core and Pro tiers allow exactly one team. Upgrading the org would mean a new monthly bill on a platform we are actively retiring, so cloned scenarios live in the same team as prod, prefixed `[STAGING]` and with connections pointed at staging services. Operations consumed by clones draw from the same monthly pool but cutover is finite — each clone is deleted as its prod counterpart is retired. (A separate free Make.com account was considered, but the free tier's 1,000 ops/month cap is too tight against the volume of the live scenarios identified in AIME-12 — Mortgage Mornings West Coast alone ran 811 ops in 30 days.)

### What this implies for the architecture

The architecture supports parallel-run for free, by construction:

- `sync_events.event_id` is `UNIQUE` per source, so the same staging event firing both paths produces exactly one audit row — no double-counting in the audit log.
- The worker's `processed_at` and `outcome` columns record what the new path did. The Make clone's effect is observable directly as records in staging Supabase + staging GHL. The diff is a query, not a build.
- No flag-driven cutover code is needed inside the worker — cutover happens by *turning Make scenarios off in prod*, not by gating the new code path with feature flags. This keeps the worker free of cutover scaffolding that would otherwise need to be ripped out after migration.

## 5. Options considered and rejected

Per the AIME-13 ticket, five candidate stacks were evaluated. The decisive cut is the user constraint: **no new paid managed services**. That alone kills four of five.

### 4.1 Inngest — rejected

Managed event-driven platform. Excellent DX, built-in observability, all six requirements satisfied out of the box. Free tier is generous for AMP's volume (~3.5k events/day) but the free tier is rate-limited and lacks per-event audit retention beyond 7 days. Production use at AMP's scale would land on a paid tier. **Rejected: new paid vendor.**

### 4.2 Trigger.dev — rejected

Similar profile to Inngest. Free tier suitable for volume but lacks long-term audit retention. Self-hostable, but self-hosting Trigger.dev requires Redis + Postgres + a Node app — strictly more infrastructure than `pg-boss` for the same outcome. **Rejected: either pay a vendor or self-host more than `pg-boss`.**

### 4.3 AWS SQS + Lambda — rejected

Battle-tested. Free tier covers AMP's volume (1M Lambda invocations + 1M SQS messages per month). But: (a) introduces an AWS account and IAM blast radius to a team that doesn't operate any other AWS today, (b) ordering across Lambda invocations requires SQS FIFO queues which have their own quirks, (c) per-event audit log is not native — you'd add DynamoDB or write to S3, expanding the stack further, (d) DLQ and retries work but the ergonomics across SQS + Lambda + CloudWatch + IAM are heavier than `pg-boss`'s single library. **Rejected: vendor and operational footprint disproportionate to AMP's scale.**

### 4.4 Node worker on Railway + BullMQ + Redis — rejected

BullMQ is the obvious pairing for a Node worker. Mature, fast, good DX. But: BullMQ requires Redis, and Redis on Railway is a paid add-on (Redis usage is metered separately from the Node services). Self-hosting Redis in the same Railway container is fragile (data loss on restart, no high availability) and would create a second source of truth (jobs in Redis, audit in Postgres) — when one drifts from the other under failure, debugging is painful. **Rejected: Redis is a new paid service, and the operational benefit over `pg-boss` is small when Postgres is already there.**

### 4.5 Supabase Edge Functions + pg-boss in Postgres — rejected

The closest alternative to the chosen design. Same queue substrate (pg-boss in Supabase Postgres), but workers run as Edge Functions dispatched by `pg_cron` + `pg_net` rather than a long-lived Node service. Trade-offs:

- **Runtime mismatch**: Edge Functions are Deno; the Next.js app and existing `lib/` are Node + TypeScript. Sharing the GHL / Stripe / Supabase clients across both means maintaining Deno-compatible variants or duplicating code. The chosen design lets the worker import directly from `lib/sync/`.
- **Cold starts**: Edge Functions cold-start on infrequent queues. The cold-start latency compounds under burst — exactly the failure mode AMP is escaping from Make.com.
- **150-second per-invocation cap**: Backfill or replay handlers that need to walk thousands of Stripe events would have to be split into batches that fit under the cap.
- **Concurrency control**: Edge Functions have per-project concurrency limits that are opaque and hard to size against burst patterns. A long-lived worker process has explicit, configurable concurrency.
- **Ordering**: per-key FIFO across cold-starting EFs requires coordinating via pg-boss's `key_strict_fifo` from inside the EF, which means each EF holds a Postgres connection — fighting Supabase's pooler. A single worker process holds a small, stable pool.

**Rejected: solves the queue problem but reintroduces the runtime fragmentation and burst behavior we are explicitly trying to fix.** Edge Functions remain the right tool for *receiving* webhooks (signature check, insert, enqueue, return 200), but not for executing the sync handlers themselves.

### 4.6 Hand-rolled `SELECT ... FOR UPDATE SKIP LOCKED` queue — rejected

The minimum-dependency option: a `jobs` table plus a polling loop, no third-party library. Possible, and Supabase's docs even show the pattern. But every feature listed as a ticket non-negotiable — exponential backoff, DLQ, per-key ordering, cron scheduling — has to be implemented and tested ourselves. `pg-boss` is a 3.5k-star, actively maintained library (latest release 2 weeks ago) that solves these correctly. **Rejected: reinventing well-tested infrastructure for no benefit.**

## 6. Consequences

### Positive

- **Zero new vendors, zero new bills.** Uses Supabase Postgres (already paid for) and one extra small Node service on Railway (charged by usage, marginal cost negligible).
- **Single source of truth for state.** Queue lives in the same Postgres as the app data. Audit log, job state, business data are all queryable together. Drift between systems is impossible because there are no systems to drift across.
- **Reuses existing patterns and code.** Edge Functions as webhook receivers, Railway as deployment target, TypeScript everywhere, same `lib/` clients. No team-wide retraining.
- **Eliminates the dual-sync problem.** AIME-12 found that for several scenarios both an Edge Function and a Make webhook fire on the same event, sometimes creating duplicate GHL records. After cutover, exactly one path writes to each destination.
- **The audit log is the system.** Every event ever received is in `sync_events`. Replaying any event is a SQL `UPDATE`. Debugging "did this event arrive, and what happened to it" is one query.

### Negative

- **Worker is a new long-lived service to operate.** It can crash, OOM, or get stuck. Mitigation: Railway auto-restarts; pg-boss returns in-flight jobs to the queue on worker restart (visibility-timeout pattern); handlers must be safe to retry from any point (the idempotency requirement covers this).
- **pg-boss creates its own `pgboss` schema in the database.** First-run migration adds tables to a managed Supabase Postgres. Verified safe — Supabase allows custom schemas. Migration documented in AIME-14's implementation ticket.
- **Worker holds a Postgres connection pool.** Adds ~5–10 connections to Supabase's connection budget. Supabase Pro allows 200 direct + far more via pooler — well within budget.
- **Migration period runs old (Make.com) and new (worker) in parallel.** The `sync_events` `UNIQUE (source, event_id)` constraint makes this safe — if both fire for the same event, the second is a no-op at insert. But the period requires monitoring both systems until cutover completes.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| `pg-boss` is a single-maintainer project (`timgit`). If maintenance lapses, we own the fix. | Active as of May 2026 (release 12.18.2 two weeks before this ADR). The `inbox table + worker pulling from queue` architecture is the durable decision; the queue *library* is swappable. Alternative if needed: [graphile-worker](https://github.com/graphile/worker), same model. |
| Worker outage = events accumulate but don't process. | Receivers still 200 (events safely persisted). Railway alerts on service-down. Manual recovery: restart worker. Backlog drains automatically. |
| pg-boss + Supabase Postgres connection contention under load. | Worker uses Supabase's transaction-mode pooler (port 6543). Concurrency cap set conservatively at first (10/queue). Connection metrics monitored. |
| `key_strict_fifo` blocks a queue if one job for a key gets stuck. | DLQ moves persistently failing jobs out of the queue head after `retryLimit`. Concurrency for the queue continues for other keys. |
| Need to support backfills (e.g., reconcile all 988 drifted records from AIME-12 once). | One-off scripts enqueue jobs to the same queues as live events. The worker processes them with the same idempotency and ordering guarantees. No separate backfill code path. |

## 7. Out of scope for this ADR

The following are deliberately deferred to later Epic-2 tickets:

- **Schema for `sync_events` and the pg-boss install.** Migration goes in AIME-14 (foundational infrastructure ticket).
- **Per-scenario handler implementations.** AIME-15 onward, one ticket per Make.com scenario being cut over, in the priority order from the AIME-12 rebuild list (P0: agency-token refresh first).
- **DLQ replay UI.** SQL replay sufficient for v1. UI is a later ticket.
- **Per-scenario cutover application.** Section 4 above establishes the cutover *process*. Each individual Make scenario's cutover ticket applies that process — defining its own representative event set, drift-snapshot edge cases to cover, and rollback plan.
- **Google Sheets dependency for vendor-name → GHL-contact-ID mapping** (surfaced in AIME-12). New home for this config is a separate ticket.

## 8. References

- AIME-12 audit: [`docs/aime-12-make-scenarios-audit.md`](../aime-12-make-scenarios-audit.md)
- pg-boss: https://github.com/timgit/pg-boss (v12.18.2, released 2026-05-02)
- pg-boss queue policies: https://timgit.github.io/pg-boss/#/api/queues
- Supabase Edge Functions limits: https://supabase.com/docs/guides/functions/limits
- Railway multi-service deployments: https://docs.railway.com/guides/services
