# Fuse E2E Specs — Setup Contract

The three Fuse paid-flow specs (`fuse-monthly-buy-finalize.spec.ts`,
`fuse-top-up-paid.spec.ts`, `fuse-upgrade-paid.spec.ts`) are all
**`test.skip` by default**. They need real seed data + a Stripe
test-mode customer with a saved card before they can run, and the
existing smoke harness doesn't provide any of that. Don't unskip
them until everything below is in place.

---

## 1. Stripe test-mode setup

The runner's Stripe key must be a test-mode `sk_test_…`. Verify:

```bash
echo $STRIPE_SECRET_KEY | grep -q '^sk_test_' || echo 'FAIL: not test mode'
```

The `STRIPE_TEST_PRICE_*` env override pattern in `app/api/checkout`
and `app/api/checkout/payment-element` lets dev hit test-mode price
IDs without mutating shared prod `subscription_plans` rows. The same
pattern should be extended to Fuse ticket prices before these specs
run — see `lib/fuse/pricing.ts` `pickActivePrice` callers.

---

## 2. Test user (annual + monthly variants)

Each spec needs a Supabase auth user already provisioned with a
Stripe customer + saved test card. The harness's existing `auth.setup.ts`
creates **one** authenticated context. These specs need two more:

### Annual VIP test user (`fuse-upgrade-paid.spec.ts`)

```sql
-- Profile row: VIP annual member, no Fuse claim yet.
INSERT INTO profiles (id, email, full_name, plan_tier, billing_period,
                      stripe_customer_id, stripe_subscription_status,
                      onboarding_step, profile_complete)
VALUES (
  '<auth_user_id>',
  'e2e-vip-annual@aimegroup.test',
  'E2E VIP Annual',
  'VIP', 'annual',
  '<stripe test customer with attached pm_card_visa>',
  'active',
  'completed', true
);
```

The Stripe customer must have a card attached AND
`invoice_settings.default_payment_method` set, since the user-facing
PaymentIntent flow resolves the default PM at server time
(`lib/fuse/stripe-errors.ts:resolveCustomerPaymentMethodId`).

### Monthly Premium test user (`fuse-monthly-buy-finalize.spec.ts`, `fuse-top-up-paid.spec.ts`)

Same shape, `plan_tier='Premium'`, `billing_period='monthly'`.

### Saved card

Use Stripe test card `pm_card_visa` (no SCA). If you need to test 3DS,
use `pm_card_threeDSecure2Required` and the spec should walk the
`handleNextAction` modal — currently the specs don't.

---

## 3. Active Fuse event + prices

```sql
-- Active event (one per environment).
INSERT INTO fuse_events (id, name, year, location, registration_open,
                          end_date, is_active)
VALUES (
  '<some-uuid>',
  'Fuse 2026',
  2026, 'Austin, TX', true,
  '2026-09-26', true
);

-- Prices — must include GA, GA Plus, HOA, and a tier-included GA row
-- per eligible tier. See migrations/20260515_fuse_2026_v2_pricing.sql
-- for the canonical shape.
```

The `getFuseEligibility` helper reads `billing_period` case-insensitive
but expects the literal values `Premium | Elite | VIP`. If the
prod DB stores `'Annual'` (capitalized), the seed should match.

---

## 4. Cleanup between runs

Each spec leaves a `fuse_registrations` row (and possibly guests) for
the test user, plus a charge on the Stripe test customer. Two options:

- **Idempotent**: reset before each run via a setup hook.
  ```sql
  DELETE FROM fuse_registrations
   WHERE user_id IN (
     SELECT id FROM profiles WHERE email LIKE 'e2e-%@aimegroup.test'
   );
  UPDATE profiles
     SET fuse_ticket_claimed_year = NULL
   WHERE email LIKE 'e2e-%@aimegroup.test';
  ```
- **Disposable users**: create a fresh auth user per run (slower).

The existing smoke harness uses a single shared `storageState`; if
these specs are added to the `authenticated` project, the cleanup
hook must run before the storageState session is reused.

---

## 5. Unskipping the specs

Once setup is in place:

1. Remove the `test.skip` calls.
2. Update `playwright.config.ts` to include a `fuse-paid` project that
   depends on a new `fuse-setup.ts` (creates / verifies the test users
   above + runs the cleanup SQL).
3. Add an env guard so they don't run against a live-mode Stripe key:

   ```ts
   test.skip(
     !process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_'),
     'Fuse paid specs only run against Stripe test mode.',
   )
   ```

---

## 6. What the specs assert (high level)

- **Monthly buy → finalize paid**: visit `/dashboard/fuse-registration`
  as a monthly Premium user → server auto-creates a GA reservation →
  add an addon → click Save & Pay → PI succeeds → page reloads on
  ManagePanel → assert `fuse_registrations.step_completed='finalized'`
  + `profiles.fuse_ticket_claimed_year` flipped → banner is gone.
- **Top-up paid**: from a finalized registration, add HOA + a guest →
  Save & Pay → PI succeeds → ManagePanel shows the new addon + guest.
- **Upgrade paid**: from a finalized GA registration, click "Add Upgrade
  to Order" → total swaps GA → GA Plus → Save & Pay → PI succeeds →
  registration row shows `ticket_type='general_admission_plus'` +
  `purchase_type='upgraded'`.
