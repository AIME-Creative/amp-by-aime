-- Per-guest add-on flags. Mirrors fuse_registrations.has_* columns so a
-- guest can independently opt into Hall of AIME, WMN at Fuse, Vetted VA
-- Summit, and the VIP Luncheon. Guests can only have an add-on when the
-- main attendee has selected it as well (enforced in app code, not in
-- the DB so admins can override).
--
-- HOA per guest charges at the active-phase HOA price (same as main).
-- The VIP membership entitlement is 2 free HOA tickets per registration
-- (member + first guest); application code is responsible for tracking
-- which guest gets the included slot.
--
-- WMN / Vetted VA / VIP Luncheon are free per guest.

BEGIN;

ALTER TABLE fuse_registration_guests
  ADD COLUMN IF NOT EXISTS has_hall_of_aime BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS has_wmn_at_fuse  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS has_vetted_va    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS has_vip_luncheon BOOLEAN NOT NULL DEFAULT false;

COMMIT;
