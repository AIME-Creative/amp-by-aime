import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import Stripe from 'stripe'
import { pickActivePrice, planGuestPricing } from '@/lib/fuse/pricing'

// Stripe Checkout supports either a pre-made price id or ad-hoc
// price_data per line item. The admin builder emits both: pre-made
// for fixed catalog items (main ticket, HOA), ad-hoc for guest
// tickets that need tier-discounted rates.
type CheckoutLineItem =
  | { price: string; quantity: number }
  | {
      price_data: {
        currency: 'usd'
        product_data: { name: string }
        unit_amount: number
      }
      quantity: number
    }

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    // Verify admin
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data: admin } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', user.id)
      .single()

    if (!admin?.is_admin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    const body = await request.json()
    const { action, registration_id, email, line_items } = body

    if (!registration_id) {
      return NextResponse.json({ error: 'Registration ID required' }, { status: 400 })
    }

    // Verify registration exists
    const { data: registration } = await supabase
      .from('fuse_registrations')
      .select('id, email, full_name, fuse_event_id')
      .eq('id', registration_id)
      .single()

    if (!registration) {
      return NextResponse.json({ error: 'Registration not found' }, { status: 404 })
    }

    const customerEmail = email || registration.email
    const origin = request.headers.get('origin') || process.env.NEXT_PUBLIC_APP_URL || ''

    // Build line items server-side from registration data + fuse_ticket_prices.
    // Covers every chargeable line the user-facing finalize/top-up flows
    // emit: main ticket (paid buyer / pending / upgraded), HOA on main,
    // each paid guest ticket, and per-guest HOA (with VIP entitlement
    // consuming the 2 free HOA: 1 on main, 1 on first guest).
    const buildLineItemsFromRegistration = async () => {
      const items: CheckoutLineItem[] = []

      const { data: fullReg } = await supabase
        .from('fuse_registrations')
        .select('*, guests:fuse_registration_guests(*)')
        .eq('id', registration_id)
        .single()

      if (!fullReg) return items

      const { data: allPrices } = await supabase
        .from('fuse_ticket_prices')
        .select('*')
        .eq('fuse_event_id', fullReg.fuse_event_id)
        .eq('is_active', true)

      if (!allPrices) return items

      const { data: eventRow } = await supabase
        .from('fuse_events')
        .select('year')
        .eq('id', fullReg.fuse_event_id)
        .single()
      const eventLabel = `Fuse ${eventRow?.year ?? ''}`.trim()

      // ----------------------------------------------------------------
      // Main ticket.
      //   - 'purchased'/'pending' GA → charge active GA price
      //   - 'purchased'/'pending' GA Plus → charge active GA Plus price
      //   - 'upgraded' → swap GA → GA Plus; charge GA Plus
      //   - 'claimed' → free (entitled)
      // ----------------------------------------------------------------
      const isMainPaid =
        fullReg.purchase_type === 'purchased' ||
        fullReg.purchase_type === 'pending' ||
        fullReg.purchase_type === 'upgraded'
      if (isMainPaid) {
        const mainKey =
          fullReg.ticket_type === 'general_admission_plus' ||
          fullReg.purchase_type === 'upgraded'
            ? 'general_admission_plus'
            : 'ga'
        const mainPrice = pickActivePrice(allPrices, mainKey, null)
        if (mainPrice?.stripe_price_id) {
          items.push({ price: mainPrice.stripe_price_id, quantity: 1 })
        }
      }

      // ----------------------------------------------------------------
      // HOA on the main attendee. VIP membership includes it (no charge);
      // everyone else pays the active-phase price.
      // ----------------------------------------------------------------
      const isVipClaim =
        fullReg.purchase_type === 'claimed' && fullReg.ticket_type === 'vip'
      const mainHoaIsFree = isVipClaim
      if (fullReg.has_hall_of_aime && !mainHoaIsFree) {
        const tierHoa = pickActivePrice(allPrices, 'hoa', fullReg.tier)
        const hoaPrice =
          (tierHoa && !tierHoa.is_included && tierHoa.stripe_price_id ? tierHoa : null)
          ?? pickActivePrice(allPrices, 'hoa', null)
        if (hoaPrice?.stripe_price_id) {
          items.push({ price: hoaPrice.stripe_price_id, quantity: 1 })
        }
      }

      // ----------------------------------------------------------------
      // Guests. Static guest_ticket price — shared logic with the
      // user-facing flow via planGuestPricing. Already-included guests
      // (VIP first-guest slot) are skipped via `existingIncludedCount`,
      // and we feed in only the non-included guests as "new" so they
      // get priced.
      // ----------------------------------------------------------------
      const guests = fullReg.guests || []
      const includedGuestCount = guests.filter((g: any) => g.is_included).length
      const paidGuestRows = guests.filter((g: any) => !g.is_included)
      const guestPlan = planGuestPricing({
        tier: fullReg.tier ?? null,
        prices: allPrices,
        existingIncludedCount: includedGuestCount,
        newGuests: paidGuestRows.map((g: any) => ({
          full_name: g.full_name,
          ticket_type: g.ticket_type,
        })),
        eventLabel,
      })
      for (const line of guestPlan.stripeLineItems) {
        items.push(line as CheckoutLineItem)
      }

      // ----------------------------------------------------------------
      // Per-guest HOA. VIP entitlement gives 2 free HOA across the
      // party (1 already credited to main, 1 to the first guest who has
      // it). Subsequent guests with HOA pay.
      // ----------------------------------------------------------------
      const hoaPriceForGuests = pickActivePrice(allPrices, 'hoa', null)
      if (hoaPriceForGuests?.stripe_price_id) {
        let vipGuestHoaFreeRemaining = isVipClaim ? 1 : 0
        let paidGuestHoaCount = 0
        for (const g of guests) {
          if (!g.has_hall_of_aime) continue
          if (vipGuestHoaFreeRemaining > 0) {
            vipGuestHoaFreeRemaining -= 1
            continue
          }
          paidGuestHoaCount += 1
        }
        if (paidGuestHoaCount > 0) {
          items.push({
            price: hoaPriceForGuests.stripe_price_id,
            quantity: paidGuestHoaCount,
          })
        }
      }

      return items
    }

    if (action === 'checkout') {
      const resolvedItems = line_items?.length > 0 ? line_items : await buildLineItemsFromRegistration()

      if (resolvedItems.length === 0) {
        return NextResponse.json({ error: 'No paid items found for this registration' }, { status: 400 })
      }

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: resolvedItems,
        customer_email: customerEmail,
        metadata: {
          registration_id: registration.id,
          fuse_event_id: registration.fuse_event_id,
          type: 'fuse_admin_checkout',
          admin_user_id: user.id,
        },
        success_url: `${origin}/admin/fuse-registration?paid=${registration.id}`,
        cancel_url: `${origin}/admin/fuse-registration`,
      })

      return NextResponse.json({ checkout_url: session.url })
    }

    if (action === 'invoice') {
      const resolvedItems = line_items?.length > 0 ? line_items : await buildLineItemsFromRegistration()

      if (resolvedItems.length === 0) {
        return NextResponse.json({ error: 'No paid items found for this registration' }, { status: 400 })
      }

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: resolvedItems,
        customer_email: customerEmail,
        metadata: {
          registration_id: registration.id,
          fuse_event_id: registration.fuse_event_id,
          type: 'fuse_member_invoice',
        },
        expires_at: Math.floor(Date.now() / 1000) + (72 * 60 * 60), // 72 hours
        success_url: `${origin}/dashboard/fuse-registration/confirmation`,
        cancel_url: `${origin}/dashboard`,
      })

      return NextResponse.json({
        payment_url: session.url,
        expires_at: new Date(session.expires_at! * 1000).toISOString(),
      })
    }

    if (action === 'claim_for_member') {
      // Admin claims a ticket on behalf of a member
      const { member_email } = body

      if (!member_email) {
        return NextResponse.json({ error: 'Member email required' }, { status: 400 })
      }

      // Look up the member
      const { data: member } = await supabase
        .from('profiles')
        .select('id, plan_tier, ghl_contact_id')
        .eq('email', member_email.toLowerCase())
        .single()

      if (!member) {
        return NextResponse.json({ error: 'Member not found' }, { status: 404 })
      }

      // Update the registration to link to the member
      const { error: updateError } = await supabase
        .from('fuse_registrations')
        .update({
          user_id: member.id,
          tier: member.plan_tier,
          purchase_type: 'claimed',
          ghl_contact_id: member.ghl_contact_id,
        })
        .eq('id', registration_id)

      if (updateError) {
        return NextResponse.json({ error: 'Failed to update registration' }, { status: 500 })
      }

      // Set fuse_ticket_claimed_year on the member's profile
      const { data: event } = await supabase
        .from('fuse_events')
        .select('year')
        .eq('id', registration.fuse_event_id)
        .single()

      if (event) {
        await supabase
          .from('profiles')
          .update({ fuse_ticket_claimed_year: event.year })
          .eq('id', member.id)
      }

      return NextResponse.json({ success: true })
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  } catch (error: any) {
    console.error('Error in admin fuse stripe:', error)
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 })
  }
}
