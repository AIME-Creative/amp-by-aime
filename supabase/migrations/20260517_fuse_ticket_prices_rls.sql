-- fuse_ticket_prices had RLS enabled but zero policies, which silently
-- returned an empty result set to the authenticated app client. Pricing
-- data is non-sensitive (it's already shown publicly on the marketing
-- site), so open SELECT to any authenticated user. Writes stay limited
-- to admins + service-role.

BEGIN;

CREATE POLICY "Anyone authenticated can read fuse ticket prices"
  ON fuse_ticket_prices
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Service role can manage fuse ticket prices"
  ON fuse_ticket_prices
  FOR ALL
  TO service_role
  USING (true);

CREATE POLICY "Admins can manage fuse ticket prices"
  ON fuse_ticket_prices
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
        AND profiles.is_admin = true
    )
  );

COMMIT;
