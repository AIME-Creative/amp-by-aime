import { NextResponse } from 'next/server'
import Stripe from 'stripe'

/**
 * Resolve a customer's default payment method (or first card on file) so
 * we can pass it explicitly to paymentIntents.create. With
 * automatic_payment_methods enabled + confirm:true, Stripe will NOT
 * auto-pick the customer's invoice_settings.default_payment_method —
 * the request 400s with "missing a payment method" unless we pass it.
 */
export async function resolveCustomerPaymentMethodId(
  stripe: Stripe,
  customerId: string,
): Promise<string | null> {
  try {
    const customer = await stripe.customers.retrieve(customerId)
    if (!customer || (customer as Stripe.DeletedCustomer).deleted) return null
    const defaultPm = (customer as Stripe.Customer).invoice_settings
      ?.default_payment_method
    if (typeof defaultPm === 'string' && defaultPm) return defaultPm
    if (defaultPm && typeof defaultPm === 'object' && 'id' in defaultPm) {
      return defaultPm.id
    }
  } catch {
    // fall through to list lookup
  }
  try {
    const pms = await stripe.paymentMethods.list({
      customer: customerId,
      type: 'card',
      limit: 1,
    })
    return pms.data[0]?.id ?? null
  } catch {
    return null
  }
}

/**
 * Stripe surfaces a verbose engineer-facing message when you call
 * paymentIntents.create({ customer, confirm: true }) without a
 * `payment_method` and the customer has no default PM set:
 *
 *   "You cannot confirm this PaymentIntent because it's missing a
 *    payment method. You can either update the PaymentIntent with a
 *    payment method and then confirm it again, or confirm it again
 *    directly with a payment method or ConfirmationToken."
 *
 * The four Fuse payment routes (claim / finalize / top-up / upgrade)
 * already special-case `!stripeCustomerId` by returning
 * `code: 'no_payment_method'`; the client uses that to open
 * AddCardModal. This helper extends that contract to cover the
 * customer-exists-but-no-default-PM case, so the user gets the same
 * "add a card" prompt instead of a raw Stripe sentence.
 */
export function handleStripeChargeError(err: unknown): NextResponse | null {
  const message = (err as { message?: string })?.message ?? ''

  if (
    message.includes('missing a payment method') ||
    message.includes('No payment method on this customer') ||
    message.includes('default_payment_method')
  ) {
    return NextResponse.json(
      {
        code: 'no_payment_method',
        error: 'No payment method on file. Please add a card first.',
      },
      { status: 402 },
    )
  }

  return null
}
