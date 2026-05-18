import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { stripe } from '@/lib/stripe/config'

export async function POST(request: NextRequest) {
  try {
    // No auth gate: this route is called from /sign-up before the user
    // exists in Supabase. It only validates a Stripe promotion code +
    // looks up the public plan price — no PII or per-user data leaks,
    // and Stripe itself rate-limits abuse.
    const supabase = await createClient()

    const { code, planId, billingInterval } = await request.json()
    if (!code || !planId || !billingInterval) {
      return NextResponse.json(
        { error: 'code, planId, and billingInterval are required' },
        { status: 400 },
      )
    }

    const planTier = mapPlanIdToTier(planId)
    if (!planTier) {
      return NextResponse.json(
        { error: `Invalid plan ID: ${planId}` },
        { status: 400 },
      )
    }

    const { data: plan } = await supabase
      .from('subscription_plans')
      .select('price')
      .eq('plan_tier', planTier)
      .eq('billing_period', billingInterval)
      .eq('is_active', true)
      .single()

    if (!plan) {
      return NextResponse.json({ error: 'Plan not found' }, { status: 400 })
    }

    const codes = await stripe.promotionCodes.list({
      code: String(code).trim(),
      active: true,
      limit: 1,
      expand: ['data.promotion.coupon'],
    })

    if (codes.data.length === 0) {
      return NextResponse.json(
        { error: 'Invalid or expired promotion code' },
        { status: 400 },
      )
    }

    const promo = codes.data[0]
    const couponRef = promo.promotion?.coupon
    const coupon =
      couponRef && typeof couponRef === 'object' ? couponRef : null

    if (!coupon) {
      return NextResponse.json(
        { error: 'Promotion code is missing coupon details' },
        { status: 400 },
      )
    }

    const baseAmount = Math.round(Number(plan.price) * 100)

    let discountAmount = 0
    if (coupon.amount_off) {
      discountAmount = coupon.amount_off
    } else if (coupon.percent_off) {
      discountAmount = Math.round(baseAmount * (coupon.percent_off / 100))
    }

    return NextResponse.json({
      valid: true,
      code: promo.code,
      baseAmount,
      discountAmount,
      finalAmount: Math.max(0, baseAmount - discountAmount),
      coupon: {
        name: coupon.name ?? null,
        percentOff: coupon.percent_off ?? null,
        amountOff: coupon.amount_off ?? null,
      },
    })
  } catch (error: any) {
    console.error('Preview coupon error:', error)
    return NextResponse.json(
      { error: error.message || 'Failed to validate code' },
      { status: 500 },
    )
  }
}

function mapPlanIdToTier(planId: string): string | null {
  const id = planId.toLowerCase()
  if (id === 'premium') return 'Premium'
  if (id === 'premium_processor') return 'Premium Processor'
  if (id === 'elite') return 'Elite'
  if (id === 'elite_processor') return 'Elite Processor'
  if (id === 'vip') return 'VIP'
  if (id === 'vip_processor') return 'VIP Processor'
  return null
}
