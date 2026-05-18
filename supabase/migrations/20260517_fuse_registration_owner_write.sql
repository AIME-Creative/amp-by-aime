-- Owner write policies for the user-facing Fuse flow.
--
-- The original create migration (20260202000002) only granted SELECT to
-- authenticated users, plus FOR ALL to admins / service_role. That worked
-- when registrations were created server-side by the GHL webhook (service
-- role) or by an admin filling them in manually. The new self-serve
-- claim / buy / manage flow runs as the user themselves, so the user
-- needs INSERT + UPDATE on their own rows (and on guests under their
-- registrations).
--
-- Service role + admin policies stay untouched. Owner policies are
-- scoped strictly to rows where user_id = auth.uid() (or, for guests,
-- the parent registration's user_id).

BEGIN;

-- fuse_registrations: owner insert
DROP POLICY IF EXISTS "Users can insert own registration" ON fuse_registrations;
CREATE POLICY "Users can insert own registration" ON fuse_registrations
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- fuse_registrations: owner update (finalize, top-up, upgrade routes)
DROP POLICY IF EXISTS "Users can update own registration" ON fuse_registrations;
CREATE POLICY "Users can update own registration" ON fuse_registrations
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- fuse_registration_guests: owner insert
DROP POLICY IF EXISTS "Users can insert own registration guests" ON fuse_registration_guests;
CREATE POLICY "Users can insert own registration guests" ON fuse_registration_guests
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM fuse_registrations fr
      WHERE fr.id = fuse_registration_guests.registration_id
      AND fr.user_id = auth.uid()
    )
  );

-- fuse_registration_guests: owner update (name edits, addon toggles)
DROP POLICY IF EXISTS "Users can update own registration guests" ON fuse_registration_guests;
CREATE POLICY "Users can update own registration guests" ON fuse_registration_guests
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM fuse_registrations fr
      WHERE fr.id = fuse_registration_guests.registration_id
      AND fr.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM fuse_registrations fr
      WHERE fr.id = fuse_registration_guests.registration_id
      AND fr.user_id = auth.uid()
    )
  );

COMMIT;
