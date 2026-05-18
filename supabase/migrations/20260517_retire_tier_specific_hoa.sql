-- v2 spec flattens HOA pricing: everyone (except VIP, which keeps its
-- included entitlement) pays the public HOA early-bird ($199) / regular
-- ($299) price. The pre-existing Premium / Elite HOA $199 rows
-- (carried over from the original seed) are no longer correct — they
-- intercept the merge logic and hide the public HOA from member tiers,
-- which prevents the early-bird sale treatment from appearing.
--
-- Soft-deactivating rather than deleting so we keep history.

BEGIN;

UPDATE fuse_ticket_prices
SET is_active = false,
    updated_at = NOW()
WHERE product_key = 'hoa'
  AND tier IN ('Premium', 'Elite');

COMMIT;
