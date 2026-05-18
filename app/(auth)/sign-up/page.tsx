'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { ChevronDown, Loader2, Check, Tag, X } from 'lucide-react'
import { loadStripe, StripeElementsOptions } from '@stripe/stripe-js'
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js'
import {
  PlanCard,
  standardPlans,
  standardFeatures,
  standardFeatureMatrix,
} from '@/lib/plans'
import { captureUtmIfPresent, getStoredAttribution } from '@/lib/utm'

interface AppliedCoupon {
  code: string
  baseAmount: number
  discountAmount: number
  finalAmount: number
  label: string
}

const HIDDEN_PLAN_IDS = new Set<string>()
const SUPPORT_EMAIL = 'brokermembership@aimegroup.com'

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!)

const inputClass =
  'w-full h-12 px-4 bg-white text-gray-900 placeholder:text-gray-500 border-0 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#dd1969]/60'

function getPlanAmountCents(plan: PlanCard, isAnnual: boolean): number {
  const priceStr = isAnnual ? plan.annualPrice : plan.price
  const numStr = priceStr.replace(/[^0-9.]/g, '')
  return Math.round(Number(numStr) * 100)
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function buildCouponLabel(coupon: {
  name?: string | null
  percentOff?: number | null
  amountOff?: number | null
}): string {
  if (coupon.name) return coupon.name
  if (coupon.percentOff) return `${coupon.percentOff}% off`
  if (coupon.amountOff) return `${formatCents(coupon.amountOff)} off`
  return 'Discount applied'
}

function PageBackground() {
  return <div className="fixed inset-0 z-0 bg-[#021649]" />
}

const visiblePlans = standardPlans.filter((p) => !HIDDEN_PLAN_IDS.has(p.id))

export default function SignUpPage() {
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    confirmPassword: '',
    fullName: '',
    phone: '',
  })
  const [selectedPlan, setSelectedPlan] = useState<string>(
    visiblePlans.find((p) => p.popular)?.id ?? visiblePlans[0].id,
  )
  const [isAnnual, setIsAnnual] = useState(true)
  const [appliedCoupon, setAppliedCoupon] = useState<AppliedCoupon | null>(null)
  const [isFeaturesOpen, setIsFeaturesOpen] = useState(false)

  useEffect(() => {
    captureUtmIfPresent()
  }, [])

  const selectedPlanData =
    visiblePlans.find((p) => p.id === selectedPlan) ?? visiblePlans[0]
  const baseAmount = getPlanAmountCents(selectedPlanData, isAnnual)
  const totalAmount = appliedCoupon ? appliedCoupon.finalAmount : baseAmount

  const elementsOptions: StripeElementsOptions = {
    mode: 'subscription',
    amount: Math.max(totalAmount, 50),
    currency: 'usd',
    appearance: {
      theme: 'stripe',
      variables: {
        colorPrimary: '#dd1969',
        colorBackground: '#ffffff',
        colorText: '#25314e',
        fontFamily: 'inherit',
        borderRadius: '10px',
      },
    },
  }

  return (
    <div className="min-h-screen relative">
      <PageBackground />

      <div className="relative z-10 px-4 py-10 md:py-14">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-8">
            <Image
              src="/assets/AMP_MemberPortalLogo_White.svg"
              alt="AMP AIME Member Portal"
              width={300}
              height={80}
              className="w-auto h-20 mx-auto mb-6"
              priority
            />
            <h1 className="text-3xl md:text-4xl font-bold text-white">
              Become a Broker Member
            </h1>
            <p className="text-white/80 text-sm mt-2">
              Sign up, choose a plan, and pay — all in one step
            </p>
          </div>

          <Elements stripe={stripePromise} options={elementsOptions}>
            <CheckoutForm
              formData={formData}
              setFormData={setFormData}
              selectedPlan={selectedPlan}
              setSelectedPlan={setSelectedPlan}
              isAnnual={isAnnual}
              setIsAnnual={setIsAnnual}
              appliedCoupon={appliedCoupon}
              setAppliedCoupon={setAppliedCoupon}
              isFeaturesOpen={isFeaturesOpen}
              setIsFeaturesOpen={setIsFeaturesOpen}
              plan={selectedPlanData}
              baseAmount={baseAmount}
              totalAmount={totalAmount}
            />
          </Elements>
        </div>
      </div>
    </div>
  )
}

function CheckoutForm({
  formData,
  setFormData,
  selectedPlan,
  setSelectedPlan,
  isAnnual,
  setIsAnnual,
  appliedCoupon,
  setAppliedCoupon,
  isFeaturesOpen,
  setIsFeaturesOpen,
  plan,
  baseAmount,
  totalAmount,
}: {
  formData: {
    email: string
    password: string
    confirmPassword: string
    fullName: string
    phone: string
  }
  setFormData: React.Dispatch<React.SetStateAction<typeof formData>>
  selectedPlan: string
  setSelectedPlan: (id: string) => void
  isAnnual: boolean
  setIsAnnual: (v: boolean) => void
  appliedCoupon: AppliedCoupon | null
  setAppliedCoupon: (c: AppliedCoupon | null) => void
  isFeaturesOpen: boolean
  setIsFeaturesOpen: React.Dispatch<React.SetStateAction<boolean>>
  plan: PlanCard
  baseAmount: number
  totalAmount: number
}) {
  const stripe = useStripe()
  const elements = useElements()

  const [couponInput, setCouponInput] = useState('')
  const [couponLoading, setCouponLoading] = useState(false)
  const [couponError, setCouponError] = useState<string | null>(null)
  const [paymentError, setPaymentError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Keep Stripe Elements in sync with the live total without remounting.
  useEffect(() => {
    if (!elements) return
    elements.update({ amount: Math.max(totalAmount, 50) })
  }, [elements, totalAmount])

  const billingInterval: 'monthly' | 'annual' = isAnnual ? 'annual' : 'monthly'
  const periodLabel = isAnnual ? 'year' : 'month'

  const applyCoupon = async () => {
    const code = couponInput.trim()
    if (!code) return
    setCouponLoading(true)
    setCouponError(null)
    try {
      const res = await fetch('/api/checkout/preview-coupon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, planId: selectedPlan, billingInterval }),
      })
      const data = await res.json()
      if (!res.ok) {
        setCouponError(data.error || 'Invalid code')
        return
      }
      setAppliedCoupon({
        code: data.code,
        baseAmount: data.baseAmount,
        discountAmount: data.discountAmount,
        finalAmount: data.finalAmount,
        label: buildCouponLabel(data.coupon),
      })
      setCouponInput('')
    } catch {
      setCouponError('Failed to validate code')
    } finally {
      setCouponLoading(false)
    }
  }

  const removeCoupon = () => {
    setAppliedCoupon(null)
    setCouponError(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!stripe || !elements) return

    if (formData.password !== formData.confirmPassword) {
      toast.error('Passwords do not match')
      return
    }
    if (!plan) {
      toast.error('Please select a plan')
      return
    }

    setIsSubmitting(true)
    setPaymentError(null)

    try {
      const { error: submitError } = await elements.submit()
      if (submitError) {
        setPaymentError(submitError.message || 'Please check your payment details')
        setIsSubmitting(false)
        return
      }

      const verifyRes = await fetch('/api/auth/verify-captcha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: formData.fullName,
          email: formData.email,
        }),
      })
      if (verifyRes.status === 429) {
        toast.error('Too many signup attempts. Please try again later.')
        setIsSubmitting(false)
        return
      }
      if (verifyRes.status === 403) {
        toast.error(
          'Unable to create account. Please contact support if this is an error.',
        )
        setIsSubmitting(false)
        return
      }

      const supabase = createClient()
      let userId: string | null = null
      let isReturningFromFailedPayment = false

      const { data, error } = await supabase.auth.signUp({
        email: formData.email,
        password: formData.password,
        options: {
          data: {
            full_name: formData.fullName,
            role: 'loan_officer',
            phone: formData.phone,
          },
        },
      })

      if (error) {
        // The auth user was created on a previous attempt but the
        // payment didn't go through, so we orphaned an account. Try
        // signing in with the supplied password — if it works, the
        // user is the same person retrying, and we can continue
        // straight into the payment step.
        const isAlreadyRegistered =
          error.status === 422 ||
          /already.*registered|already.*exists/i.test(error.message)
        if (!isAlreadyRegistered) throw error

        const { data: signInData, error: signInError } =
          await supabase.auth.signInWithPassword({
            email: formData.email,
            password: formData.password,
          })
        if (signInError || !signInData.user?.id) {
          setPaymentError(
            'This email already has an account. Log in to continue checkout.',
          )
          setIsSubmitting(false)
          return
        }
        userId = signInData.user.id
        isReturningFromFailedPayment = true
      } else if (!data.user?.id) {
        throw new Error('Account creation failed')
      } else {
        userId = data.user.id
      }

      const attribution = getStoredAttribution()

      if (!isReturningFromFailedPayment) {
        try {
          await fetch('/api/ghl/create-contact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId,
              email: formData.email,
              fullName: formData.fullName,
              phone: formData.phone,
              role: 'loan_officer',
              attribution,
            }),
          })
        } catch (ghlError) {
          console.error('GHL contact creation failed:', ghlError)
        }
      }

      await supabase
        .from('profiles')
        .update({
          // Fuse 2026 wedge: drop into the claim/buy step between
          // checkout and complete-profile. The wedge auto-skips
          // ineligible users (no tier / expired event) straight to
          // complete-profile, so this is safe for all sign-ups.
          onboarding_step: 'claim_fuse_ticket',
          ...(attribution ? { attribution } : {}),
        })
        .eq('id', userId)

      const checkoutRes = await fetch('/api/checkout/payment-element', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planId: selectedPlan,
          billingInterval,
          promotionCode: appliedCoupon?.code ?? null,
        }),
      })
      const checkoutData = await checkoutRes.json()
      if (!checkoutRes.ok) {
        setPaymentError(checkoutData.error || 'Could not start checkout')
        setIsSubmitting(false)
        return
      }

      if (!checkoutData.clientSecret) {
        window.location.href = '/onboarding/claim-fuse-ticket'
        return
      }

      const { error: confirmError, paymentIntent } = await stripe.confirmPayment({
        elements,
        clientSecret: checkoutData.clientSecret,
        confirmParams: {
          return_url: `${window.location.origin}/onboarding/claim-fuse-ticket`,
          payment_method_data: {
            billing_details: {
              name: formData.fullName || undefined,
              email: formData.email || undefined,
            },
          },
        },
        redirect: 'if_required',
      })

      if (confirmError) {
        setPaymentError(confirmError.message || 'Payment failed')
        setIsSubmitting(false)
        return
      }

      if (
        paymentIntent &&
        paymentIntent.status !== 'succeeded' &&
        paymentIntent.status !== 'processing'
      ) {
        setPaymentError('Payment was not completed')
        setIsSubmitting(false)
        return
      }

      // The Stripe webhook canonical-sets plan_tier / billing_period
      // from the customer.subscription.created event, but that's async
      // and the user is about to redirect into the Fuse wedge which
      // gates on those values. Set them directly here so the wedge
      // gets the right eligibility on first render. The webhook will
      // re-affirm later and the values are idempotent.
      const planTierLabel =
        selectedPlan === 'vip' ? 'VIP'
        : selectedPlan === 'elite' ? 'Elite'
        : selectedPlan === 'premium' ? 'Premium'
        : null
      if (planTierLabel) {
        // Write subscription_status alongside tier/period to close the
        // race between payment success and the Stripe webhook. Without
        // this, middleware reads subscription_status=null on the next
        // request and bounces the user to /dashboard/select-plan. The
        // customer.subscription.created webhook reaffirms the value
        // seconds later (idempotent).
        await supabase
          .from('profiles')
          .update({
            plan_tier: planTierLabel,
            billing_period: billingInterval,
            subscription_status: 'active',
            stripe_subscription_status: 'active',
          })
          .eq('id', userId)
      }

      window.location.href = '/onboarding/claim-fuse-ticket'
    } catch (err: any) {
      toast.error(err.message || 'Failed to create account')
      setIsSubmitting(false)
    }
  }

  const orderSummary = (
    <div className="bg-white rounded-2xl shadow-xl p-6 space-y-5">
      <div>
        <p className="text-xs uppercase tracking-wider text-gray-500 font-semibold mb-1">
          Order summary
        </p>
        <h3 className="text-xl font-bold text-[#25314e]">
          {plan.name} Membership
        </h3>
        <p className="text-sm text-gray-600">
          Billed {isAnnual ? 'annually' : 'monthly'}
        </p>
      </div>

      <div>
        <label className="text-xs uppercase tracking-wider text-gray-500 font-semibold">
          Promo code
        </label>
        {appliedCoupon ? (
          <div className="mt-2 flex items-center justify-between bg-[#20adce]/10 text-[#20adce] rounded-lg px-3 py-2 text-sm">
            <span className="flex items-center gap-2 font-semibold">
              <Tag className="w-4 h-4" />
              {appliedCoupon.code} — {appliedCoupon.label}
            </span>
            <button
              type="button"
              onClick={removeCoupon}
              className="text-[#20adce] hover:text-[#1a8ba8]"
              aria-label="Remove promo code"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              placeholder="Enter code"
              value={couponInput}
              onChange={(e) => {
                setCouponInput(e.target.value)
                if (couponError) setCouponError(null)
              }}
              className="flex-1 h-11 px-3 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#dd1969]/40 focus:border-[#dd1969]"
            />
            <button
              type="button"
              onClick={applyCoupon}
              disabled={!couponInput.trim() || couponLoading}
              className="h-11 px-4 rounded-lg text-sm font-semibold text-[#dd1969] border border-[#dd1969] hover:bg-[#dd1969] hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {couponLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                'Apply'
              )}
            </button>
          </div>
        )}
        {couponError && (
          <p className="mt-1 text-xs text-red-600">{couponError}</p>
        )}
      </div>

      <div className="border-t border-gray-200 pt-4 space-y-2 text-sm">
        <div className="flex justify-between text-gray-700">
          <span>Subtotal</span>
          <span>{formatCents(baseAmount)}</span>
        </div>
        {appliedCoupon && (
          <div className="flex justify-between text-[#20adce]">
            <span>Discount</span>
            <span>−{formatCents(appliedCoupon.discountAmount)}</span>
          </div>
        )}
        <div className="flex justify-between text-base font-bold text-[#25314e] border-t border-gray-200 pt-2 mt-2">
          <span>Total today</span>
          <span>{formatCents(totalAmount)}</span>
        </div>
        <p className="text-xs text-gray-500">
          Then {formatCents(baseAmount)} per {periodLabel} until canceled.
        </p>
      </div>
    </div>
  )

  const paymentCard = (
    <div className="bg-white rounded-2xl shadow-xl p-6 space-y-5">
      <div>
        <label className="text-xs uppercase tracking-wider text-gray-500 font-semibold">
          Payment details
        </label>
        <div className="mt-2">
          <PaymentElement options={{ layout: 'tabs' }} />
        </div>
      </div>

      {paymentError && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
          {paymentError}
        </div>
      )}

      <Button
        type="submit"
        disabled={!stripe || !elements || isSubmitting}
        className="w-full h-14 bg-[#dd1969] hover:bg-[#c01559] text-white font-semibold text-base rounded-full shadow-lg"
      >
        {isSubmitting ? (
          <>
            <Loader2 className="w-5 h-5 mr-2 animate-spin" />
            Processing...
          </>
        ) : (
          `Sign Up & Pay ${formatCents(totalAmount)}`
        )}
      </Button>
    </div>
  )

  return (
    <form onSubmit={handleSubmit}>
      <div className="lg:grid lg:grid-cols-[1fr_380px] lg:gap-8 lg:items-start space-y-6 lg:space-y-0">
        {/* Main column */}
        <div className="space-y-6">
          {/* Account fields */}
          <div className="space-y-3">
            <input
              type="text"
              placeholder="Full Name"
              value={formData.fullName}
              onChange={(e) =>
                setFormData({ ...formData, fullName: e.target.value })
              }
              required
              className={inputClass}
            />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <input
                type="email"
                placeholder="Email"
                value={formData.email}
                onChange={(e) =>
                  setFormData({ ...formData, email: e.target.value })
                }
                required
                className={inputClass}
              />
              <input
                type="tel"
                placeholder="Phone"
                value={formData.phone}
                onChange={(e) =>
                  setFormData({ ...formData, phone: e.target.value })
                }
                className={inputClass}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <input
                type="password"
                placeholder="Password"
                value={formData.password}
                onChange={(e) =>
                  setFormData({ ...formData, password: e.target.value })
                }
                required
                minLength={6}
                className={inputClass}
              />
              <input
                type="password"
                placeholder="Confirm Password"
                value={formData.confirmPassword}
                onChange={(e) =>
                  setFormData({ ...formData, confirmPassword: e.target.value })
                }
                required
                minLength={6}
                className={inputClass}
              />
            </div>
          </div>

          {/* Plan picker */}
          <div className="pt-2">
            <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
              <h2 className="text-lg font-bold text-white">Choose a plan</h2>
              <div className="flex items-center gap-2">
                <span
                  className={`text-xs font-semibold uppercase tracking-wider ${
                    !isAnnual ? 'text-white' : 'text-white/50'
                  }`}
                >
                  Monthly
                </span>
                <button
                  type="button"
                  onClick={() => setIsAnnual(!isAnnual)}
                  className="relative inline-flex h-6 w-11 items-center rounded-full bg-white/20 transition-colors focus:outline-none focus:ring-2 focus:ring-white/50"
                >
                  <span
                    className={`${
                      isAnnual ? 'translate-x-6' : 'translate-x-1'
                    } inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow`}
                  />
                </button>
                <span
                  className={`text-xs font-semibold uppercase tracking-wider ${
                    isAnnual ? 'text-white' : 'text-white/50'
                  }`}
                >
                  Annual
                </span>
                {isAnnual && (
                  <span className="ml-1 rounded-full bg-[#dd1969] px-2.5 py-0.5 text-[10px] font-semibold text-white uppercase tracking-wider">
                    Best Value
                  </span>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {visiblePlans.map((p) => {
                const selected = selectedPlan === p.id
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setSelectedPlan(p.id)}
                    className={`relative bg-white rounded-2xl p-6 shadow-xl text-left flex flex-col transition-all cursor-pointer hover:-translate-y-1 hover:shadow-2xl ${
                      selected
                        ? 'ring-4 ring-[#dd1969] scale-[1.02]'
                        : p.popular
                          ? 'ring-2 ring-[#dd1969]/40 hover:ring-4 hover:ring-[#dd1969]'
                          : 'ring-1 ring-white/30 hover:ring-2 hover:ring-[#20adce]'
                    }`}
                  >
                    {p.popular && (
                      <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                        <span className="bg-[#dd1969] text-white px-3 py-1 rounded-full text-xs font-semibold whitespace-nowrap">
                          Most Popular
                        </span>
                      </div>
                    )}

                    <div className="text-center mb-5">
                      <h3 className="text-xl font-bold text-gray-900 mb-2">
                        {p.name}
                      </h3>
                      <div className="mb-2">
                        <span className="text-3xl font-bold text-[#25314e]">
                          {isAnnual ? p.annualPrice : p.price}
                        </span>
                        <span className="text-gray-600 ml-1 text-sm">
                          {isAnnual ? p.annualPeriod : p.period}
                        </span>
                      </div>
                      <p className="text-xs text-gray-600">{p.description}</p>
                    </div>

                    <div className="space-y-2.5 mb-5 flex-grow">
                      {p.features.map((feature, index) => (
                        <div key={index} className="flex items-start gap-2">
                          <Check className="w-4 h-4 text-[#20adce] flex-shrink-0 mt-0.5" />
                          <span className="text-xs text-gray-700">
                            {feature}
                          </span>
                        </div>
                      ))}
                    </div>

                    <div
                      className={`w-full text-center py-2.5 rounded-full text-sm font-semibold transition-colors ${
                        selected
                          ? 'bg-[#dd1969] text-white'
                          : 'bg-[#20adce]/10 text-[#20adce]'
                      }`}
                    >
                      {selected ? 'Selected' : `Select ${p.name}`}
                    </div>
                  </button>
                )
              })}
            </div>

            {/* Compare features */}
            <div className="mt-5 bg-white/5 backdrop-blur-sm rounded-2xl ring-1 ring-white/20 overflow-hidden">
              <button
                type="button"
                onClick={() => setIsFeaturesOpen((v) => !v)}
                className="w-full flex items-center justify-between px-5 py-4 text-white hover:bg-white/5 transition-colors"
                aria-expanded={isFeaturesOpen}
              >
                <span className="text-sm font-semibold">
                  Compare all features
                </span>
                <ChevronDown
                  className={`w-5 h-5 transition-transform ${
                    isFeaturesOpen ? 'rotate-180' : ''
                  }`}
                />
              </button>
              {isFeaturesOpen && (
                <div className="bg-white p-4 md:p-6">
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b-2 border-gray-200">
                          <th className="text-left py-3 px-3 text-sm font-semibold text-gray-900">
                            Feature
                          </th>
                          {visiblePlans.map((p) => (
                            <th
                              key={p.id}
                              className={`text-center py-3 px-3 text-sm font-semibold text-gray-900 ${
                                p.popular ? 'bg-[#20adce]/10' : ''
                              }`}
                            >
                              {p.name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {standardFeatures.map((feature, index) => (
                          <tr
                            key={feature}
                            className={index % 2 === 0 ? 'bg-gray-50' : 'bg-white'}
                          >
                            <td className="py-2.5 px-3 text-xs text-gray-700 font-medium">
                              {feature}
                            </td>
                            {visiblePlans.map((p) => (
                              <td
                                key={p.id}
                                className={`py-2.5 px-3 text-xs text-gray-600 text-center ${
                                  p.popular ? 'bg-[#20adce]/5' : ''
                                }`}
                              >
                                {standardFeatureMatrix[feature]?.[p.id] || '—'}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </div>

        </div>

        {/* Right side — entire checkout (summary + payment + Pay button) */}
        <aside className="space-y-6 lg:sticky lg:top-8 self-start">
          {orderSummary}
          {paymentCard}
        </aside>
      </div>

      {/* Footer below the grid */}
      <div className="mt-6 space-y-6">
        <div className="bg-white/10 backdrop-blur-sm rounded-2xl ring-1 ring-white/20 px-5 py-4 text-center">
          <p className="text-sm text-white">
            Are you a processor? Email{' '}
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="font-semibold underline hover:text-white/80"
            >
              {SUPPORT_EMAIL}
            </a>{' '}
            for plan options.
          </p>
        </div>

        <p className="text-center text-sm text-white/80">
          Already have an account?{' '}
          <Link
            href="/sign-in"
            className="font-semibold text-white hover:underline"
          >
            Log in
          </Link>
        </p>
      </div>
    </form>
  )
}
