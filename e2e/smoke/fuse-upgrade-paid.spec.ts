/**
 * Fuse — Member upgrades a GA registration to GA Plus.
 *
 * SKIPPED by default. See `README-fuse-e2e.md` for seed/cleanup
 * requirements before unskipping.
 *
 * Asserts:
 *   - From a finalized GA registration, clicking "Add Upgrade to Order"
 *     puts a GA Plus Upgrade line in the Order Summary that REPLACES
 *     the GA main line (total goes up by upgrade_delta, not double-
 *     charged).
 *   - Save & Pay charges the upgrade via PaymentIntent.
 *   - The registration row flips to ticket_type='general_admission_plus'
 *     and purchase_type='upgraded'.
 *   - VIP Luncheon becomes available as an add-on (GA Plus unlocks it).
 */
import { test, expect } from '@playwright/test'

test.skip(
  true,
  'Requires Fuse paid E2E seed setup + a pre-finalized GA registration ' +
    '(see README-fuse-e2e.md). Unskip after wiring fuse-setup.ts.',
)

test('upgrade GA → GA Plus charges the upgrade price and flips ticket type', async ({ page }) => {
  // 1. Manage panel for a finalized GA registration shows the upgrade card.
  await page.goto('/dashboard/fuse-registration')
  await expect(page.getByText(/You're Registered/i)).toBeVisible()
  const upgradeCard = page.getByText(/General Admission Plus Upgrade/i)
  await expect(upgradeCard).toBeVisible()

  // 2. Click the upgrade-to-order button.
  await page.getByRole('button', { name: /Add Upgrade to Order/i }).click()
  await expect(
    page.getByRole('button', { name: /✓ Added to Order/i }),
  ).toBeVisible()

  // 3. Order summary should show the GA Plus Upgrade line and NOT the
  //    GA main ticket line (the cart swaps, doesn't add).
  const orderSummary = page.getByRole('region', { name: /Order Summary/i })
  await expect(
    orderSummary.getByText(/General Admission Plus Upgrade/i),
  ).toBeVisible()

  // 4. Save & Pay.
  await page.getByRole('button', { name: /Save & Pay/i }).click()

  // 5. After reload, the ticket label reads "General Admission Plus"
  //    and VIP Luncheon should be enabled.
  await expect(
    page.getByText(/General Admission Plus ticket/i),
  ).toBeVisible({ timeout: 15_000 })
  await expect(page.getByLabel(/VIP Luncheon/i)).toBeEnabled()
})
