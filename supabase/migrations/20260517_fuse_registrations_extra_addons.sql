-- Phase 1 partial: add per-registration storage for Vetted VA and VIP
-- Luncheon add-ons. These already exist as catalog rows in
-- fuse_ticket_prices (and as toggles in the UI for Step2Panel), but
-- fuse_registrations had no boolean columns to track who selected them
-- so the ManagePanel addons render had to silently filter them out.
--
-- VIP Luncheon eligibility (GA Plus + VIP only) is still enforced in
-- app code, not by the schema.

BEGIN;

ALTER TABLE fuse_registrations
  ADD COLUMN IF NOT EXISTS has_vetted_va BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS has_vip_luncheon BOOLEAN NOT NULL DEFAULT false;

COMMIT;
