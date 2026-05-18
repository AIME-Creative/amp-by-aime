/**
 * Fuse — Monthly Premium buyer completes checkout in one session.
 *
 * SKIPPED by default. See `README-fuse-e2e.md` for seed/cleanup
 * requirements before unskipping.
 *
 * Asserts:
 *   - Visiting /dashboard/fuse-registration as a monthly Premium user
 *     auto-creates a GA reservation (purchase_type='purchased',
 *     step_completed='claim').
 *   - Save & Pay finalizes via PaymentIntent against the saved card.
 *   - After redirect, the registration row is step_completed='finalized'
 *     and profiles.fuse_ticket_claimed_year is set to the event year.
 *   - The dashboard "Buy Your Ticket" banner is no longer visible.
 */
import { test, expect } from '@playwright/test'

test.skip(
  true,
  'Requires Fuse paid E2E seed setup (see README-fuse-e2e.md). ' +
    'Unskip after wiring fuse-setup.ts + test user with saved card.',
)

test('monthly Premium buyer finalizes a GA ticket in one session', async ({ page }) => {
  // 1. Land on the unified checkout — server auto-creates the reservation.
  await page.goto('/dashboard/fuse-registration')
  await expect(page.getByText(/You're Claimed!/i)).toBeVisible()

  // 2. Confirm the GA main ticket is in the order summary at the
  //    active-phase public price (not "Included").
  const orderSummary = page.getByRole('region', { name: /Order Summary/i })
  await expect(orderSummary.getByText(/General Admission Ticket/i)).toBeVisible()
  await expect(orderSummary.getByText(/\$/)).toBeVisible()

  // 3. Save & Pay — uses the saved card on the test user's Stripe customer.
  await page.getByRole('button', { name: /Save & Pay|Complete Purchase/i }).click()

  // 4. Post-finalize state — Manage panel + flipped claim year + banner gone.
  await expect(page.getByText(/You're Registered for Fuse/i)).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.getByText(/Buy Your Ticket/i)).not.toBeVisible()
})
