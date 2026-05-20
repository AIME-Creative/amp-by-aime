# AIME-15 — AMP profile → GHL contact field mapping

**Source code:** [`lib/sync/ghl-mapping.ts`](../lib/sync/ghl-mapping.ts) is the authoritative implementation. This document mirrors what that file does. If the two diverge, the code wins and this doc needs an update.

**When the sync fires:** the `sync_profile_to_ghl_v2_trigger` Postgres trigger fires on `AFTER INSERT` or `AFTER UPDATE` of `public.profiles` when one of the watched columns (see "Watched columns" below) changes. The trigger calls `/api/internal/sync-profile-changed` which enqueues a worker job. The worker refetches the profile and calls this mapping function to build the GHL payload.

---

## Top-level GHL contact fields

These map directly to GHL's `Contact` object fields. The receiver omits any field that is `null`, `undefined`, or the empty string — `customFields` is the only field always included (it may be empty).

| GHL field | Source from `profiles` | Transform |
|---|---|---|
| `locationId` | env `GHL_LOCATION_ID` | Required by GHL on `POST /contacts/`. Stripped on `PUT /contacts/{id}`. |
| `email` | `email` | Required. Direct copy. |
| `firstName` | `first_name` | If `first_name` not set, derives from the first whitespace-separated token of `full_name`. |
| `lastName` | `last_name` | If `last_name` not set, derives from the remainder of `full_name` after the first token. |
| `name` | `full_name` | Falls back to `"{firstName} {lastName}"` if `full_name` is empty. |
| `phone` | `phone` | Direct copy. |
| `address1` | `address` | Direct copy. |
| `city` | `city` | Direct copy. |
| `state` | `state` | Direct copy (two-letter state code as stored). |
| `postalCode` | `zip_code` | Direct copy. |
| `companyName` | `company` | Direct copy. |
| `dateOfBirth` | `birthday` | Direct copy (string; GHL accepts ISO date format). |

---

## GHL custom fields

Each entry below maps to one `{ key, field_value }` object in the contact's `customFields` array. Empty / null / undefined source values cause the field to be **omitted** from the payload rather than sent as empty.

| GHL custom-field key | Source from `profiles` | Transform |
|---|---|---|
| `jobtitle` | `role` | Mapped through display table: `loan_officer → "Loan Officer"`, `broker_owner → "Broker Owner"`, `loan_officer_assistant → "Loan Officer Assistant"`, `processor → "Processor"`. Unknown roles pass through verbatim. |
| `gender` | `gender` | Direct copy. |
| `race_type` | `race` | Direct copy. |
| `aime_membership_tier` | `plan_tier` | Direct copy (e.g. `Premium`, `Elite`, `VIP`). |
| `aime_membership_id` | `id` | Profile UUID. Always present. |
| `membership_status` | `subscription_status` | Direct copy (e.g. `active`, `trialing`, `past_due`, `canceled`). |
| `payment_schedule` | `billing_period` | Direct copy (`Monthly` or `Annual`). |
| `payment_amount` | `payment_amount` | Stringified number. **Included even when `0`** (only omitted when null/undefined). |
| `stripe_id` | `stripe_customer_id` | Direct copy of the Stripe `cus_*` id. |
| `brokerage_nmls` | `company_nmls` | Direct copy. |
| `brokerage_state_licenses` | `state_licenses` | Array → comma-separated CSV (e.g. `["CA","TX"] → "CA, TX"`). |
| `broker_owner` | (derived) | Literal `"Yes"` when `role === 'broker_owner'`. Omitted otherwise. |
| `company_name` | `company` | Direct copy. Duplicates the top-level `companyName`. |
| `scotsman_guide_subscription` | `scotsman_guide_subscription` | Literal `"Opt-in"` when value is exactly `true`. Omitted when `false`, `null`, or `undefined`. |
| `scotsman_guide_subscription_date` | `scotsman_guide_subscription_date` | Parsed and reformatted as `YYYY-MM-DD`. Omitted if the source isn't a parseable date. |

---

## Watched columns (trigger fires only when one of these changes)

The `sync_profile_to_ghl_v2` trigger function defines the set of profile columns whose changes count as "worth syncing." An UPDATE that touches only unwatched columns is a no-op at the trigger level — no `sync_events` row, no worker job, no GHL call.

`email`, `full_name`, `first_name`, `last_name`, `phone`, `avatar_url`, `address`, `city`, `state`, `zip_code`, `company`, `company_name`, `company_address`, `company_city`, `company_state`, `company_zip_code`, `company_nmls`, `company_phone`, `role`, `nmls_number`, `state_licenses`, `languages_spoken`, `birthday`, `gender`, `race`, `plan_tier`, `subscription_status`, `stripe_customer_id`, `stripe_subscription_status`, `billing_period`, `payment_amount`, `scotsman_guide_subscription`, `last_login_at`, `connections_contact_name`, `connections_contact_email`, `connections_contact_phone`, `escalations_contact_name`, `escalations_contact_email`, `escalations_contact_phone`

If a new profile column is added that should also drive GHL syncs, add it to the watched-columns OR list inside `supabase/migrations/20260520_replace_sync_profile_to_ghl_trigger.sql` and rerun the migration.

---

## Profile columns currently watched by the trigger but NOT pushed to GHL

Some watched columns drive the *decision* to sync but the value itself isn't in the GHL payload. They're watched because a change suggests the contact may need refreshing.

- `avatar_url` — not currently sent to GHL
- `company_address`, `company_city`, `company_state`, `company_zip_code`, `company_phone` — top-level `companyName` is sent but the company's address fields aren't
- `nmls_number` — the individual NMLS isn't currently mapped (the brokerage NMLS is, via `company_nmls`)
- `languages_spoken` — array is computed in the legacy EF but never pushed (preserved here)
- `last_login_at` — not sent
- `stripe_subscription_status` — `membership_status` carries `subscription_status` instead
- `connections_contact_*` and `escalations_contact_*` — contact-info captured for AMP's escalations/connections UI; not sent to GHL

These are deliberate gaps in the legacy EF that AIME-15 preserves verbatim. A future ticket can fold any of them into the payload if the CRM team needs them.

---

## How to add a new mapping

1. Add the source column to the watched-columns OR list in `supabase/migrations/20260520_replace_sync_profile_to_ghl_trigger.sql`. Apply the migration to staging + prod.
2. Add a `push('your_ghl_key', profile.your_column)` line in `lib/sync/ghl-mapping.ts`, near the other custom field pushes.
3. Add a unit-test row in `tests/lib/sync/ghl-mapping.test.ts` confirming the field appears in `customFields` with the right key + value.
4. Add a row to the table in this doc.

---

## How to remove a mapping

1. Delete the `push(...)` line in `lib/sync/ghl-mapping.ts`.
2. Delete the test row that asserted it.
3. Delete the row in this doc.
4. If the source profile column is also no longer needed for triggering, remove it from the watched-columns OR list in the migration too.

---

## Reference: legacy EF this replaces

The implementation prior to AIME-15 lived in `supabase/functions/sync-profile-ghl/index.ts` (now deleted as part of AIME-15). The field set above is a faithful port — no fields added, none removed, no transforms changed. Behavior parity is verified by the staging e2e diff that compares the resulting GHL contact state to what the legacy EF would have produced.
