'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Check, LogOut } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import CheckoutButton from '@/components/checkout/CheckoutButton'

const getPlanPrice = (plan: any, isAnnual: boolean, isProcessor: boolean) => {
  if (plan.id === 'premium-guest' || plan.id === 'free') return { price: '$0', period: '90 Days' }

  const standardPrices: Record<string, { monthly: string, annual: string, annualMonthly: string }> = {
    premium: { monthly: '$19.99', annual: '$199', annualMonthly: '$16.58' },
    elite: { monthly: '$69.99', annual: '$699', annualMonthly: '$58.25' },
    vip: { monthly: '$199.99', annual: '$1,999', annualMonthly: '$166.58' },
  }

  const processorPrices: Record<string, { monthly: string, annual: string, annualMonthly: string }> = {
    premium_processor: { monthly: '$19.99', annual: '$199', annualMonthly: '$16.58' },
    elite_processor: { monthly: '$39.99', annual: '$399', annualMonthly: '$33.25' },
    vip_processor: { monthly: '$119', annual: '$1,199', annualMonthly: '$99.92' },
  }

  const prices = isProcessor ? processorPrices : standardPrices
  const planPrices = prices[plan.id]
  if (!planPrices) return { price: '$0', period: '' }

  if (isAnnual) {
    return {
      price: planPrices.annual,
      period: '/year',
      savedText: `${planPrices.annualMonthly}/mo when billed annually`
    }
  }
  return { price: planPrices.monthly, period: '/month' }
}

// NOTE: Premium Guest has been hidden from checkout but not sunset
// It may return at a later date. Existing users can keep their tier.
const standardPlans = [
  {
    id: 'premium',
    name: 'Premium',
    basePrice: '$19.99',
    basePeriod: '/month',
    description: 'Ideal for growing brokers looking to level up',
    features: [
      'Exclusive wholesale resources',
      'Educational content & training',
      'Broker channel growth support',
      'Fuse GA ticket (Annual only)',
      'One loan escalation per year',
      '10% discount on products/services',
      'Vendor partner discounts',
    ],
    buttonText: 'Upgrade to Premium',
    buttonClass: 'bg-[#20adce] hover:bg-[#1a8ba8]',
    popular: true,
  },
  {
    id: 'elite',
    name: 'Elite',
    basePrice: '$69.99',
    basePeriod: '/month',
    description: 'Built for teams and higher-volume shops',
    features: [
      'Everything in Premium',
      'Access to local client referrals',
      'Fuse GA ticket (Annual only)',
      'Six loan escalations per year',
      '20% discount on products/services',
      'Enhanced vendor partner access',
    ],
    buttonText: 'Upgrade to Elite',
    buttonClass: 'bg-[#dd1969] hover:bg-[#c01559]',
    popular: false,
  },
  {
    id: 'vip',
    name: 'VIP',
    basePrice: '$199.99',
    basePeriod: '/month',
    description: 'Best for leaders, influencers, and top-tier producers',
    features: [
      'Access to all AIME benefits',
      'Prioritized referrals and service',
      'VIP Fuse Ticket + VIP Guest Ticket',
      'Unlimited loan escalations',
      '30% discount on products/services',
      'Premium vendor partnership access',
      'Direct industry leader access',
    ],
    buttonText: 'Upgrade to VIP',
    buttonClass: 'bg-[#25314e] hover:bg-[#1a233a]',
    popular: false,
  },
]

// NOTE: Premium Guest has been hidden from processor checkout but not sunset
const processorPlans = [
  {
    id: 'premium_processor',
    name: 'Premium Processor',
    basePrice: '$19.99',
    basePeriod: '/month',
    description: 'Essential benefits for processors',
    features: [
      'Exclusive processor resources',
      'Educational content & training',
      'Processing workflow tools',
      'Fuse GA ticket (Annual only)',
      'One loan escalation per year',
      '10% discount on products/services',
      'Vendor partner discounts',
    ],
    buttonText: 'Upgrade to Premium',
    buttonClass: 'bg-[#20adce] hover:bg-[#1a8ba8]',
    popular: true,
  },
  {
    id: 'elite_processor',
    name: 'Elite Processor',
    basePrice: '$39.99',
    basePeriod: '/month',
    description: 'Advanced tools for professional processors',
    features: [
      'Everything in Premium Processor',
      'Advanced processing resources',
      'Fuse GA ticket (Annual only)',
      'Six loan escalations per year',
      '20% discount on products/services',
      'Enhanced vendor partner access',
    ],
    buttonText: 'Upgrade to Elite',
    buttonClass: 'bg-[#dd1969] hover:bg-[#c01559]',
    popular: false,
  },
  {
    id: 'vip_processor',
    name: 'VIP Processor',
    basePrice: '$119',
    basePeriod: '/month',
    description: 'Premium experience for top processors',
    features: [
      'Access to all AIME benefits',
      'Prioritized support and service',
      'VIP Fuse Ticket + VIP Guest Ticket',
      'Unlimited loan escalations',
      '30% discount on products/services',
      'Premium vendor partnership access',
      'Direct industry leader access',
    ],
    buttonText: 'Upgrade to VIP',
    buttonClass: 'bg-[#25314e] hover:bg-[#1a233a]',
    popular: false,
  },
]

// Standard plan features (matching the official AIME matrix)
const standardFeatures = [
  'Discounts from AIME Vendor Members and Partners',
  'Right to vote in all AIME member elections',
  'Eligible for nomination to join Committees',
  'Eligible to run for elected Board positions',
  'One Free Fuse Ticket (Annual Only)',
  'Discount on AIME products/services/tickets',
  'Subscription to AIME newsletters',
  'Access to Brokers Are Best Facebook Group',
  "Access to Women's Mortgage Network (WMN) Facebook Group",
  'Access to AIME VIP Facebook Group',
  'Webinar Replays',
  'Mortgage Mornings',
  'Lender and Vendor Webinars',
  'Discounted surety bond program',
  'Escalation of loan issues with AIME Lender Members',
  'Scotsman Guide Top Originators',
]

const standardFeatureMatrix: Record<string, Record<string, string>> = {
  'Discounts from AIME Vendor Members and Partners': {
    'premium-guest': '✗',
    premium: '✓',
    elite: '✓',
    vip: '✓',
  },
  'Right to vote in all AIME member elections': {
    'premium-guest': '✗',
    premium: '✓',
    elite: '✓',
    vip: '✓',
  },
  'Eligible for nomination to join Committees': {
    'premium-guest': '✗',
    premium: '✓',
    elite: '✓',
    vip: '✓',
  },
  'Eligible to run for elected Board positions': {
    'premium-guest': '✗',
    premium: '✓',
    elite: '✓',
    vip: '✓',
  },
  'One Free Fuse Ticket (Annual Only)': {
    'premium-guest': '✗',
    premium: '1 GA Ticket',
    elite: '1 GA Ticket',
    vip: '2 VIP Tickets + 2 Hall of AIME Tickets',
  },
  'Discount on AIME products/services/tickets': {
    'premium-guest': '✗',
    premium: '10% Off',
    elite: '20% Off',
    vip: '30% Off',
  },
  'Subscription to AIME newsletters': {
    'premium-guest': '✓',
    premium: '✓',
    elite: '✓',
    vip: '✓',
  },
  'Access to Brokers Are Best Facebook Group': {
    'premium-guest': '✓',
    premium: '✓',
    elite: '✓',
    vip: '✓',
  },
  "Access to Women's Mortgage Network (WMN) Facebook Group": {
    'premium-guest': '✓',
    premium: '✓',
    elite: '✓',
    vip: '✓',
  },
  'Access to AIME VIP Facebook Group': {
    'premium-guest': '✗',
    premium: '✗',
    elite: '✗',
    vip: '✓',
  },
  'Webinar Replays': {
    'premium-guest': '✓',
    premium: '✓',
    elite: '✓',
    vip: '✓',
  },
  'Mortgage Mornings': {
    'premium-guest': '✓',
    premium: '✓',
    elite: '✓',
    vip: '✓',
  },
  'Lender and Vendor Webinars': {
    'premium-guest': '✓',
    premium: '✓',
    elite: '✓',
    vip: '✓',
  },
  'Discounted surety bond program': {
    'premium-guest': '✗',
    premium: '✓',
    elite: '✓',
    vip: '✓',
  },
  'Escalation of loan issues with AIME Lender Members': {
    'premium-guest': '✗',
    premium: '1/year',
    elite: '6/year',
    vip: 'Unlimited',
  },
  'Scotsman Guide Top Originators': {
    'premium-guest': 'Free Sub + 20% Off',
    premium: 'Free Sub + 20% Off',
    elite: 'Free Sub + 20% Off',
    vip: 'Free Sub + 20% Off',
  },
}

// Processor plan features
const processorFeatures = [
  'Right to vote in all AIME member elections',
  'Eligible for nomination to join Committees',
  'Eligible to run for elected Board positions',
  'One Free Fuse Ticket (Annual Only)',
  'Discount on AIME products/services/tickets',
  'Subscription to AIME newsletters',
  'Access to Brokers Are Best Facebook Group',
  "Access to Women's Mortgage Network (WMN) Facebook Group",
  'Access to AIME VIP Facebook Group',
  'Webinar Replays',
  'Mortgage Mornings',
  'Lender and Vendor Webinars',
  'Discounted surety bond program',
  'Escalation of loan issues with AIME Lender Members',
  'Scotsman Guide Top Originators',
]

const processorFeatureMatrix: Record<string, Record<string, string>> = {
  'Right to vote in all AIME member elections': {
    'premium-guest': '—',
    premium: '✓',
    elite: '✓',
    vip: '✓',
  },
  'Eligible for nomination to join Committees': {
    'premium-guest': '—',
    premium: '✓',
    elite: '✓',
    vip: '✓',
  },
  'Eligible to run for elected Board positions': {
    'premium-guest': '—',
    premium: '✓',
    elite: '✓',
    vip: '✓',
  },
  'One Free Fuse Ticket (Annual Only)': {
    'premium-guest': '—',
    premium: '1 GA Ticket',
    elite: '1 GA Ticket',
    vip: '2 VIP Tickets + 2 Hall of AIME Tickets',
  },
  'Discount on AIME products/services/tickets': {
    'premium-guest': '—',
    premium: '10% Off',
    elite: '20% Off',
    vip: '30% Off',
  },
  'Subscription to AIME newsletters': {
    'premium-guest': '✓',
    premium: '✓',
    elite: '✓',
    vip: '✓',
  },
  'Access to Brokers Are Best Facebook Group': {
    'premium-guest': '✓',
    premium: '✓',
    elite: '✓',
    vip: '✓',
  },
  "Access to Women's Mortgage Network (WMN) Facebook Group": {
    'premium-guest': '✓',
    premium: '✓',
    elite: '✓',
    vip: '✓',
  },
  'Access to AIME VIP Facebook Group': {
    'premium-guest': '—',
    premium: '—',
    elite: '—',
    vip: '✓',
  },
  'Webinar Replays': {
    'premium-guest': '✓',
    premium: '✓',
    elite: '✓',
    vip: '✓',
  },
  'Mortgage Mornings': {
    'premium-guest': '✓',
    premium: '✓',
    elite: '✓',
    vip: '✓',
  },
  'Lender and Vendor Webinars': {
    'premium-guest': '✓',
    premium: '✓',
    elite: '✓',
    vip: '✓',
  },
  'Discounted surety bond program': {
    'premium-guest': '—',
    premium: '✓',
    elite: '✓',
    vip: '✓',
  },
  'Escalation of loan issues with AIME Lender Members': {
    'premium-guest': '—',
    premium: '1/year',
    elite: '3/year',
    vip: '6/year',
  },
  'Scotsman Guide Top Originators': {
    'premium-guest': 'Free Sub + 20% Off',
    premium: 'Free Sub + 20% Off',
    elite: 'Free Sub + 20% Off',
    vip: 'Free Sub + 20% Off',
  },
}

export default function SelectPlanPage() {
  const [currentPlan, setCurrentPlan] = useState('Premium Guest')
  const [isAnnual, setIsAnnual] = useState(false)
  const [isProcessor, setIsProcessor] = useState(false)
  const [hasActiveSubscription, setHasActiveSubscription] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    async function loadProfile() {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        let { data: profile } = await supabase
          .from('profiles')
          .select('plan_tier, is_admin, role, stripe_subscription_id')
          .eq('id', user.id)
          .single()

        // Apply view-as override if active (read from cookie)
        const cookieValue = document.cookie
          .split('; ')
          .find(row => row.startsWith('viewAsSettings='))
          ?.split('=')[1]

        if (cookieValue) {
          try {
            const viewAsSettings = JSON.parse(decodeURIComponent(cookieValue))
            if (viewAsSettings && viewAsSettings.isViewingAs) {
              // Override with view-as settings
              profile = {
                ...profile,
                plan_tier: viewAsSettings.plan_tier,
                is_admin: false
              } as any
            }
          } catch (e) {
            console.error('Error parsing viewAsSettings:', e)
          }
        }

        setCurrentPlan(profile?.plan_tier || 'None')
        setIsProcessor(profile?.role === 'processor')
        setHasActiveSubscription(!!profile?.stripe_subscription_id)
      }
    }
    loadProfile()
  }, [])

  const plans = isProcessor ? processorPlans : standardPlans
  const features = isProcessor ? processorFeatures : standardFeatures
  const featureMatrix = isProcessor ? processorFeatureMatrix : standardFeatureMatrix

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/sign-in')
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#20adce] via-[#1a8ba8] to-[#25314e]">
      {/* Logout Button */}
      <div className="absolute top-4 right-4 md:top-8 md:right-8">
        <button
          onClick={handleLogout}
          className="flex items-center gap-2 px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-lg transition-colors"
        >
          <LogOut className="w-4 h-4" />
          <span>Logout</span>
        </button>
      </div>

      {/* Page Header */}
      <div className="px-4 md:px-8 py-8 md:py-12">
        <div className="text-center text-white mb-8">
          <h1 className="text-4xl md:text-5xl font-bold mb-4">
            Choose Your Plan
          </h1>
          <p className="text-lg md:text-xl text-white/90 max-w-2xl mx-auto">
            {isProcessor ? 'Special processor pricing and benefits' : 'Select the perfect plan to unlock your full potential'}
          </p>

          {/* Billing Toggle */}
          <div className="flex items-center justify-center gap-4 mt-6">
            <span className={`text-sm font-medium ${!isAnnual ? 'text-white' : 'text-white/70'}`}>
              Monthly
            </span>
            <button
              onClick={() => setIsAnnual(!isAnnual)}
              className="relative inline-flex h-8 w-14 items-center rounded-full bg-white/20 transition-colors focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-[#20adce]"
            >
              <span
                className={`${
                  isAnnual ? 'translate-x-7' : 'translate-x-1'
                } inline-block h-6 w-6 transform rounded-full bg-white transition-transform`}
              />
            </button>
            <span className={`text-sm font-medium ${isAnnual ? 'text-white' : 'text-white/70'}`}>
              Annual
            </span>
            {isAnnual && (
              <span className="ml-2 rounded-full bg-[#dd1969] px-3 py-1 text-xs font-semibold text-white">
                Best Value
              </span>
            )}
          </div>
        </div>

        {/* Plan Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-5xl mx-auto mb-12 justify-items-center">
          {plans.map((plan) => {
            const pricing = getPlanPrice(plan, isAnnual, isProcessor)
            return (
            <div
              key={plan.id}
              className={`bg-white rounded-2xl p-6 shadow-xl relative flex flex-col ${
                plan.popular ? 'ring-4 ring-[#dd1969] transform scale-105' : ''
              }`}
            >
              {plan.popular && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                  <span className="bg-[#dd1969] text-white px-4 py-1 rounded-full text-sm font-semibold">
                    Most Popular
                  </span>
                </div>
              )}

              <div className="text-center mb-6">
                <h3 className="text-2xl font-bold text-gray-900 mb-2">
                  {plan.name}
                </h3>
                <div className="mb-2">
                  <span className="text-4xl font-bold text-[#25314e]">
                    {pricing.price}
                  </span>
                  <span className="text-gray-600 ml-1">{pricing.period}</span>
                </div>
                {pricing.savedText && (
                  <p className="text-xs text-[#dd1969] font-semibold mb-1">
                    {pricing.savedText}
                  </p>
                )}
                <p className="text-sm text-gray-600">{plan.description}</p>
              </div>

              <div className="space-y-3 mb-6 flex-grow">
                {plan.features.map((feature, index) => (
                  <div key={index} className="flex items-start gap-2">
                    <Check className="w-5 h-5 text-[#20adce] flex-shrink-0 mt-0.5" />
                    <span className="text-sm text-gray-700">{feature}</span>
                  </div>
                ))}
              </div>

              <CheckoutButton
                planId={plan.name}
                planName={plan.name}
                currentPlan={currentPlan}
                billingInterval={isAnnual ? 'annual' : 'monthly'}
                className={`w-full text-white font-semibold ${plan.buttonClass}`}
                hasActiveSubscription={hasActiveSubscription}
              />
            </div>
            )
          })}
        </div>

        {/* Feature Comparison Table */}
        <div className="bg-white rounded-2xl shadow-xl p-6 md:p-8 max-w-7xl mx-auto">
          <h2 className="text-2xl md:text-3xl font-bold text-gray-900 mb-6 text-center">
            Feature Comparison
          </h2>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b-2 border-gray-200">
                  <th className="text-left py-4 px-4 font-semibold text-gray-900">
                    Feature
                  </th>
                  <th className="text-center py-4 px-4 font-semibold text-gray-900 bg-[#20adce]/10">
                    Premium
                  </th>
                  <th className="text-center py-4 px-4 font-semibold text-gray-900">
                    Elite
                  </th>
                  <th className="text-center py-4 px-4 font-semibold text-gray-900">
                    VIP
                  </th>
                </tr>
              </thead>
              <tbody>
                {features.map((feature, index) => (
                  <tr
                    key={feature}
                    className={index % 2 === 0 ? 'bg-gray-50' : 'bg-white'}
                  >
                    <td className="py-3 px-4 text-sm text-gray-700 font-medium">
                      {feature}
                    </td>
                    <td className="py-3 px-4 text-sm text-gray-600 text-center bg-[#20adce]/5">
                      {featureMatrix[feature]?.premium || '—'}
                    </td>
                    <td className="py-3 px-4 text-sm text-gray-600 text-center">
                      {featureMatrix[feature]?.elite || '—'}
                    </td>
                    <td className="py-3 px-4 text-sm text-gray-600 text-center">
                      {featureMatrix[feature]?.vip || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Back to Dashboard */}
        <div className="text-center mt-8">
          <Link
            href="/dashboard"
            className="text-white hover:text-white/80 underline"
          >
            Back to Dashboard
          </Link>
        </div>
      </div>
    </div>
  )
}
