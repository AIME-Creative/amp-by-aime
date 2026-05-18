-- Fuse 2026 v2 pricing updates
-- Source: docs/fuse-2026-implementation-plan.md Phase 0
--
-- This migration is additive and behavior-neutral until app code starts
-- referencing the new rows / table / constraint value. Safe to apply ahead
-- of the Phase 0 code patches.
--
-- Changes:
--   1. Extend fuse_registrations.purchase_type to allow 'upgraded'
--      (member GA -> GA Plus upgrade flow)
--   2. Add public HOA early-bird ($199) and fix public HOA regular ($349 -> $299)
--   3. Add GA Plus public tickets ($1,199 early / $1,299 regular)
--   4. Add Vetted VA and VIP Luncheon add-ons (free; VIP Luncheon eligibility
--      is enforced in app code, not via tier rows)
--   5. Create fuse_guest_pricing_rules for tier-based guest discounts
--      (Premium 10% / Elite 20% / VIP 30% off GA regular)
--   6. Set the June 15 2026 early-bird cutoff on all early_bird rows that
--      do not already have one
--
-- Verified against live schema 2026-05-15: Fuse 2026 event id
-- fdf0c8ea-e8b4-4734-b28e-f9c99e8834ff is active. No existing early-bird
-- HOA, GA Plus, vetted_va, vip_luncheon, or guest pricing rows. No
-- phase_end_at values currently set anywhere.

BEGIN;

-- ============================================================
-- 1. Allow 'upgraded' purchase_type
-- ============================================================
ALTER TABLE fuse_registrations
  DROP CONSTRAINT IF EXISTS fuse_registrations_purchase_type_check;

ALTER TABLE fuse_registrations
  ADD CONSTRAINT fuse_registrations_purchase_type_check
  CHECK (purchase_type = ANY (ARRAY['purchased'::text, 'claimed'::text, 'pending'::text, 'upgraded'::text]));

-- ============================================================
-- 2. HOA pricing fixes
-- ============================================================
-- Fix public HOA regular: $349 -> $299
UPDATE fuse_ticket_prices
SET price = 299, updated_at = NOW()
WHERE fuse_event_id = 'fdf0c8ea-e8b4-4734-b28e-f9c99e8834ff'
  AND product_key = 'hoa'
  AND tier IS NULL
  AND pricing_phase = 'regular';

-- Add public HOA early-bird at $199
INSERT INTO fuse_ticket_prices
  (fuse_event_id, product_key, label, description, tier, pricing_phase, price, is_addon, is_included, gender_lock, sort_order)
VALUES
  (
    'fdf0c8ea-e8b4-4734-b28e-f9c99e8834ff',
    'hoa',
    'Hall of AIME',
    'Early-bird pricing for the Hall of AIME recognition ceremony',
    NULL,
    'early_bird',
    199,
    TRUE,
    FALSE,
    NULL,
    3
  );

-- ============================================================
-- 3. GA Plus public tickets
-- ============================================================
INSERT INTO fuse_ticket_prices
  (fuse_event_id, product_key, label, description, tier, pricing_phase, price, is_addon, is_included, gender_lock, sort_order)
VALUES
  (
    'fdf0c8ea-e8b4-4734-b28e-f9c99e8834ff',
    'general_admission_plus',
    'General Admission Plus',
    'Premium experience with extra perks, including VIP Luncheon access',
    NULL,
    'early_bird',
    1199,
    FALSE,
    FALSE,
    NULL,
    2
  ),
  (
    'fdf0c8ea-e8b4-4734-b28e-f9c99e8834ff',
    'general_admission_plus',
    'General Admission Plus',
    'Premium experience with extra perks, including VIP Luncheon access',
    NULL,
    'regular',
    1299,
    FALSE,
    FALSE,
    NULL,
    2
  );

-- ============================================================
-- 4. New free add-ons
-- ============================================================
INSERT INTO fuse_ticket_prices
  (fuse_event_id, product_key, label, description, tier, pricing_phase, price, is_addon, is_included, gender_lock, sort_order)
VALUES
  (
    'fdf0c8ea-e8b4-4734-b28e-f9c99e8834ff',
    'vetted_va',
    'Vetted VA Summit',
    'Free with any Fuse ticket',
    NULL,
    'regular',
    0,
    TRUE,
    FALSE,
    NULL,
    5
  ),
  (
    'fdf0c8ea-e8b4-4734-b28e-f9c99e8834ff',
    'vip_luncheon',
    'VIP Luncheon',
    'Free for GA Plus and VIP ticket holders',
    NULL,
    'regular',
    0,
    TRUE,
    FALSE,
    NULL,
    6
  );

-- ============================================================
-- 5. Guest pricing rules table
-- ============================================================
CREATE TABLE IF NOT EXISTS fuse_guest_pricing_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fuse_event_id UUID NOT NULL REFERENCES fuse_events(id) ON DELETE CASCADE,
  tier TEXT NOT NULL CHECK (tier IN ('Premium', 'Elite', 'VIP')),
  base_product_key TEXT NOT NULL DEFAULT 'ga',
  discount_percent INTEGER NOT NULL CHECK (discount_percent BETWEEN 0 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (fuse_event_id, tier, base_product_key)
);

CREATE INDEX IF NOT EXISTS idx_fuse_guest_pricing_event_tier
  ON fuse_guest_pricing_rules(fuse_event_id, tier);

ALTER TABLE fuse_guest_pricing_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can view guest pricing rules"
  ON fuse_guest_pricing_rules
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins can manage guest pricing rules"
  ON fuse_guest_pricing_rules
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
  );

CREATE POLICY "Service role can manage guest pricing rules"
  ON fuse_guest_pricing_rules
  FOR ALL
  TO service_role
  USING (true);

-- Seed Fuse 2026 guest pricing
INSERT INTO fuse_guest_pricing_rules
  (fuse_event_id, tier, base_product_key, discount_percent)
VALUES
  ('fdf0c8ea-e8b4-4734-b28e-f9c99e8834ff', 'Premium', 'ga', 10),
  ('fdf0c8ea-e8b4-4734-b28e-f9c99e8834ff', 'Elite', 'ga', 20),
  ('fdf0c8ea-e8b4-4734-b28e-f9c99e8834ff', 'VIP', 'ga', 30);

-- ============================================================
-- 6. Early-bird cutoff: 2026-06-15 23:59:59 Pacific
-- ============================================================
UPDATE fuse_ticket_prices
SET phase_end_at = '2026-06-15 23:59:59-07'::timestamptz,
    updated_at = NOW()
WHERE fuse_event_id = 'fdf0c8ea-e8b4-4734-b28e-f9c99e8834ff'
  AND pricing_phase = 'early_bird'
  AND phase_end_at IS NULL;

COMMIT;
