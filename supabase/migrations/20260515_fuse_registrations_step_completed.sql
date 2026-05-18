-- Phase 7c: track whether a member has visited the step-2 (add-ons + guests)
-- page after claiming. Drives the "Resume your Fuse registration" CTA so we
-- don't bug a member who claimed-and-is-done.
--
-- Values:
--   'claim'      => step 1 done, step 2 not yet visited
--   'finalized'  => step 2 visited (even with no add-ons / guests added)
--
-- Existing rows are backfilled to 'finalized' so we don't surface a resume
-- CTA on registrations that pre-date this column.

BEGIN;

ALTER TABLE fuse_registrations
  ADD COLUMN IF NOT EXISTS step_completed TEXT NOT NULL DEFAULT 'claim'
  CHECK (step_completed IN ('claim', 'finalized'));

-- Backfill: anything already in the DB is effectively done.
UPDATE fuse_registrations
SET step_completed = 'finalized'
WHERE step_completed = 'claim';

-- After backfill, reset the default for new rows to 'claim'. (The ADD
-- COLUMN above set DEFAULT 'claim' which is what we want for any future
-- INSERT, so this is documentation only — no statement needed.)

COMMIT;
