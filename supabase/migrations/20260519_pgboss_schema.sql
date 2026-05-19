-- AIME-14: pg-boss schema bootstrap.
--
-- Creates the `pgboss` schema where the pg-boss Node library will create
-- its job/archive/schedule tables on the worker's first `boss.start()`
-- call. We pre-create the schema (rather than letting pg-boss issue
-- CREATE SCHEMA itself) because Supabase's default role policy is more
-- permissive for "create objects within an existing schema" than for
-- "create new schemas at the database level."
--
-- pg-boss owns everything inside this schema. The migration is
-- deliberately minimal — pg-boss's own install routine (run once by the
-- worker on startup) creates pgboss.job, pgboss.archive, pgboss.schedule,
-- pgboss.subscription, pgboss.version, and the supporting functions.
-- If we ever upgrade pg-boss, its built-in migration logic handles the
-- table changes — we don't replicate that here.

BEGIN;

CREATE SCHEMA IF NOT EXISTS pgboss;

-- The postgres role on Supabase is the schema owner by default for
-- CREATE SCHEMA. Ensure that's explicit so pg-boss (running under the
-- service-role connection) can create objects inside it.
ALTER SCHEMA pgboss OWNER TO postgres;

-- Service role needs the ability to USE the schema and create objects
-- within it. (USAGE is what lets queries reference pgboss.job, etc.;
-- CREATE is what lets pg-boss's install routine add the tables.)
GRANT USAGE, CREATE ON SCHEMA pgboss TO service_role;
GRANT USAGE, CREATE ON SCHEMA pgboss TO postgres;

COMMENT ON SCHEMA pgboss IS
  'AIME-14: home for pg-boss job-queue tables. Managed by the pg-boss '
  'Node library at runtime (worker startup).';

COMMIT;
