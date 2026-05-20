-- AIME-15: replace the legacy profile→GHL sync trigger.
--
-- Old path:   trigger → pg_net.http_post → sync-profile-ghl Edge Function
--             (handles field mapping + GHL API call + retry inline)
--
-- New path:   trigger → pg_net.http_post → Next.js receiver
--             → INSERT sync_events + enqueue pg-boss job → worker handler
--             (DLQ + audit + structured retry via pg-boss)
--
-- The field-watch list is preserved exactly — same set of columns whose
-- changes trigger a sync. The DELETE of the old trigger + function and
-- the CREATE of the new ones happen in one transaction so the database
-- never has zero sync-trigger coverage on profiles.
--
-- Per-environment config (receiver URL, shared secret) lives in a small
-- `sync_config` key/value table rather than ALTER DATABASE SET GUCs
-- because Supabase's managed `postgres` role lacks permission to set
-- custom database-level parameters. After applying this migration in
-- each environment, populate sync_config with:
--
--   INSERT INTO public.sync_config(key, value) VALUES
--     ('profile_receiver_url', 'https://<env-app-url>/api/internal/sync-profile-changed'),
--     ('internal_sync_secret', '<random-shared-secret-also-set-as-INTERNAL_SYNC_SECRET-env-var>')
--   ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

BEGIN;

-- ============================================================
-- 1. sync_config table
-- ============================================================
CREATE TABLE IF NOT EXISTS public.sync_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

ALTER TABLE public.sync_config ENABLE ROW LEVEL SECURITY;

-- Service-role only. No client should ever read these (they contain a
-- shared secret).
DROP POLICY IF EXISTS "Service role manages sync_config" ON public.sync_config;
CREATE POLICY "Service role manages sync_config"
  ON public.sync_config
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.sync_config IS
  'AIME-15: per-environment config for the sync trigger → receiver path. '
  'Service-role only. Contains the receiver URL + shared secret.';

-- ============================================================
-- 2. Drop the legacy trigger + function
-- ============================================================
DROP TRIGGER IF EXISTS sync_profile_to_ghl_trigger ON public.profiles;
DROP FUNCTION IF EXISTS public.sync_profile_to_ghl();

-- Also drop any prior v2 attempt so this migration is idempotent.
DROP TRIGGER IF EXISTS sync_profile_to_ghl_v2_trigger ON public.profiles;
DROP FUNCTION IF EXISTS public.sync_profile_to_ghl_v2();

-- ============================================================
-- 3. New trigger function
-- ============================================================
CREATE OR REPLACE FUNCTION public.sync_profile_to_ghl_v2()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  payload jsonb;
  receiver_url text;
  shared_secret text;
  should_sync boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    should_sync := true;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Field-watch list — same as the legacy sync_profile_to_ghl().
    -- Add a field here if a new column should trigger a GHL push.
    should_sync := (
      OLD.email IS DISTINCT FROM NEW.email OR
      OLD.full_name IS DISTINCT FROM NEW.full_name OR
      OLD.first_name IS DISTINCT FROM NEW.first_name OR
      OLD.last_name IS DISTINCT FROM NEW.last_name OR
      OLD.phone IS DISTINCT FROM NEW.phone OR
      OLD.avatar_url IS DISTINCT FROM NEW.avatar_url OR
      OLD.address IS DISTINCT FROM NEW.address OR
      OLD.city IS DISTINCT FROM NEW.city OR
      OLD.state IS DISTINCT FROM NEW.state OR
      OLD.zip_code IS DISTINCT FROM NEW.zip_code OR
      OLD.company IS DISTINCT FROM NEW.company OR
      OLD.company_name IS DISTINCT FROM NEW.company_name OR
      OLD.company_address IS DISTINCT FROM NEW.company_address OR
      OLD.company_city IS DISTINCT FROM NEW.company_city OR
      OLD.company_state IS DISTINCT FROM NEW.company_state OR
      OLD.company_zip_code IS DISTINCT FROM NEW.company_zip_code OR
      OLD.company_nmls IS DISTINCT FROM NEW.company_nmls OR
      OLD.company_phone IS DISTINCT FROM NEW.company_phone OR
      OLD.role IS DISTINCT FROM NEW.role OR
      OLD.nmls_number IS DISTINCT FROM NEW.nmls_number OR
      OLD.state_licenses IS DISTINCT FROM NEW.state_licenses OR
      OLD.languages_spoken IS DISTINCT FROM NEW.languages_spoken OR
      OLD.birthday IS DISTINCT FROM NEW.birthday OR
      OLD.gender IS DISTINCT FROM NEW.gender OR
      OLD.race IS DISTINCT FROM NEW.race OR
      OLD.plan_tier IS DISTINCT FROM NEW.plan_tier OR
      OLD.subscription_status IS DISTINCT FROM NEW.subscription_status OR
      OLD.stripe_customer_id IS DISTINCT FROM NEW.stripe_customer_id OR
      OLD.stripe_subscription_status IS DISTINCT FROM NEW.stripe_subscription_status OR
      OLD.billing_period IS DISTINCT FROM NEW.billing_period OR
      OLD.payment_amount IS DISTINCT FROM NEW.payment_amount OR
      OLD.scotsman_guide_subscription IS DISTINCT FROM NEW.scotsman_guide_subscription OR
      OLD.last_login_at IS DISTINCT FROM NEW.last_login_at OR
      OLD.connections_contact_name IS DISTINCT FROM NEW.connections_contact_name OR
      OLD.connections_contact_email IS DISTINCT FROM NEW.connections_contact_email OR
      OLD.connections_contact_phone IS DISTINCT FROM NEW.connections_contact_phone OR
      OLD.escalations_contact_name IS DISTINCT FROM NEW.escalations_contact_name OR
      OLD.escalations_contact_email IS DISTINCT FROM NEW.escalations_contact_email OR
      OLD.escalations_contact_phone IS DISTINCT FROM NEW.escalations_contact_phone
    );
  END IF;

  IF NOT should_sync THEN
    RETURN NEW;
  END IF;

  SELECT value INTO receiver_url   FROM public.sync_config WHERE key = 'profile_receiver_url';
  SELECT value INTO shared_secret  FROM public.sync_config WHERE key = 'internal_sync_secret';

  IF receiver_url IS NULL OR receiver_url = '' THEN
    RAISE WARNING 'sync_profile_to_ghl_v2: sync_config.profile_receiver_url not configured; skipping';
    RETURN NEW;
  END IF;
  IF shared_secret IS NULL OR shared_secret = '' THEN
    RAISE WARNING 'sync_profile_to_ghl_v2: sync_config.internal_sync_secret not configured; skipping';
    RETURN NEW;
  END IF;

  -- Receiver gets only the profile id; it reads the row fresh from Supabase
  -- (reconcile-from-source). event_id is generated per-fire so the receiver's
  -- sync_events UNIQUE(source, event_id) treats each trigger as one event.
  payload := jsonb_build_object(
    'event_id', gen_random_uuid()::text,
    'op', TG_OP,
    'profile_id', NEW.id
  );

  PERFORM net.http_post(
    url := receiver_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Internal-Sync-Secret', shared_secret
    ),
    body := payload
  );

  RETURN NEW;
END;
$function$;

-- ============================================================
-- 4. Trigger
-- ============================================================
CREATE TRIGGER sync_profile_to_ghl_v2_trigger
AFTER INSERT OR UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.sync_profile_to_ghl_v2();

COMMENT ON FUNCTION public.sync_profile_to_ghl_v2 IS
  'AIME-15: forwards profile changes to the Next.js sync receiver, which '
  'audits to sync_events and enqueues a pg-boss job for the worker. '
  'Replaces the legacy sync_profile_to_ghl() that called the Edge Function directly.';

COMMIT;
