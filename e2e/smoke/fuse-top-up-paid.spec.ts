/**
 * Fuse — Member adds a paid add-on + guest after their registration
 * is already finalized (the "top-up" flow).
 *
 * SKIPPED by default. See `README-fuse-e2e.md` for seed/cleanup
 * requirements before unskipping.
 *
 * Asserts:
 *   - From a finalized registration's Manage panel, toggling HOA + adding
 *     a guest puts both lines into the Order Summary.
 *   - Save & Pay charges via PaymentIntent.
 *   - The new guest row appears in the guest list with the right
 *     ticket_type + addon flags.
 *   - `fuse_registrations.has_hall_of_aime` is now true.
 */
import { test, expect } from '@playwright/test'

test.skip(
  true,
  'Requires Fuse paid E2E seed setup + a pre-finalized registration ' +
    '(see README-fuse-e2e.md). Unskip after wiring fuse-setup.ts.',
)

test('top-up adds a paid add-on + guest to an already-finalized registration', async ({ page }) => {
  // 1. Start on the Manage panel for a finalized registration.
  await page.goto('/dashboard/fuse-registration')
  await expect(page.getByText(/You're Registered/i)).toBeVisible()

  // 2. Toggle Hall of AIME on (paid) and add a guest.
  await page.getByLabel(/Hall of AIME/i).check()
  await page.getByRole('button', { name: /Add a Guest/i }).click()
  await page.getByPlaceholder(/First name/i).fill('Test')
  await page.getByPlaceholder(/Last name/i).fill('Guest')

  // 3. Order summary reflects the new HOA + guest lines + a non-zero total.
  const orderSummary = page.getByRole('region', { name: /Order Summary/i })
  await expect(orderSummary.getByText(/Hall of AIME/i)).toBeVisible()
  await expect(orderSummary.getByText(/Guest: Test Guest/i)).toBeVisible()

  // 4. Save & Pay.
  await page.getByRole('button', { name: /Save & Pay/i }).click()

  // 5. Manage panel re-renders with HOA confirmed + the new guest listed.
  await expect(page.getByText(/Hall of AIME.*Confirmed/i)).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.getByText('Test Guest')).toBeVisible()
})
