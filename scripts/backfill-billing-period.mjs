#!/usr/bin/env node
// Backfill profiles.billing_period + payment_amount for active paid
// members whose rows are null. Pulls authoritative values from Stripe.
//
// Usage:
//   node scripts/backfill-billing-period.mjs --dry-run
//   node scripts/backfill-billing-period.mjs
//
// Required env (load via your shell or `node --env-file=.env.local`):
//   STRIPE_SECRET_KEY
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

const DRY_RUN = process.argv.includes('--dry-run')
const RATE_LIMIT_MS = 200 // ~5 req/s against Stripe

const stripeKey = process.env.STRIPE_SECRET_KEY
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!stripeKey || !supabaseUrl || !supabaseKey) {
  console.error('Missing one of STRIPE_SECRET_KEY / NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const stripe = new Stripe(stripeKey)
const supabase = createClient(supabaseUrl, supabaseKey)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function intervalToBillingPeriod(interval) {
  if (interval === 'year') return 'annual'
  if (interval === 'month') return 'monthly'
  return null
}

async function main() {
  console.log(`[backfill-billing-period] dry-run=${DRY_RUN}`)

  // Catch BOTH null billing_period AND null payment_amount — earlier
  // self-heal paths may have repaired one but not the other.
  const { data: rows, error } = await supabase
    .from('profiles')
    .select('id, email, stripe_subscription_id, plan_tier, stripe_subscription_status, billing_period, payment_amount')
    .or('billing_period.is.null,payment_amount.is.null')
    .in('plan_tier', ['Premium', 'Elite', 'VIP', 'Premium Processor', 'Elite Processor', 'VIP Processor'])
    .in('stripe_subscription_status', ['active', 'trialing', 'past_due'])
    .not('stripe_subscription_id', 'is', null)

  if (error) {
    console.error('Failed to fetch profiles:', error)
    process.exit(1)
  }

  console.log(`Found ${rows.length} candidate profiles`)

  const updates = []
  const skips = []
  let processed = 0

  for (const row of rows) {
    await sleep(RATE_LIMIT_MS)

    let sub
    try {
      sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id, {
        expand: ['items.data.price'],
      })
    } catch (err) {
      skips.push({ id: row.id, email: row.email, reason: `stripe_error:${err.code || err.message}` })
      processed++
      if (processed % 25 === 0) console.log(`  ...processed ${processed}/${rows.length}`)
      continue
    }

    const item = sub.items.data[0]
    const interval = item?.price?.recurring?.interval
    const billingPeriod = intervalToBillingPeriod(interval)
    const unitAmount = item?.price?.unit_amount
    const paymentAmount = typeof unitAmount === 'number' ? unitAmount / 100 : null

    if (!billingPeriod) {
      skips.push({ id: row.id, email: row.email, reason: `unknown_interval:${interval ?? 'null'}` })
      continue
    }

    updates.push({
      id: row.id,
      email: row.email,
      billing_period: billingPeriod,
      payment_amount: paymentAmount,
      sub_id: row.stripe_subscription_id,
    })

    processed++
    if (processed % 25 === 0) console.log(`  ...processed ${processed}/${rows.length}`)
  }

  console.log(`Planned updates: ${updates.length}`)
  console.log(`Skips: ${skips.length}`)

  if (skips.length) {
    console.log('\n--- Skipped ---')
    for (const s of skips) console.log(`  ${s.email} (${s.id}): ${s.reason}`)
  }

  if (DRY_RUN) {
    console.log('\n--- Dry-run preview (first 20) ---')
    for (const u of updates.slice(0, 20)) {
      console.log(`  ${u.email}: billing_period=${u.billing_period} payment_amount=${u.payment_amount}`)
    }
    console.log('\nDry-run complete. Re-run without --dry-run to apply.')
    return
  }

  let written = 0
  let failed = 0
  for (const u of updates) {
    const { error: updateErr } = await supabase
      .from('profiles')
      .update({
        billing_period: u.billing_period,
        payment_amount: u.payment_amount,
        updated_at: new Date().toISOString(),
      })
      .eq('id', u.id)
    if (updateErr) {
      failed++
      console.error(`  FAIL ${u.email} (${u.id}): ${updateErr.message}`)
    } else {
      written++
    }
  }

  console.log(`\n--- Done ---`)
  console.log(`Wrote: ${written}`)
  console.log(`Failed: ${failed}`)
  console.log(`Skipped: ${skips.length}`)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
