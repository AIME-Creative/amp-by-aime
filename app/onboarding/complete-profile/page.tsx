'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Loader2, ChevronLeft, ChevronRight, LogOut } from 'lucide-react'
import Image from 'next/image'
import { toast } from 'sonner'

export default function CompleteProfilePage() {
  const router = useRouter()
  const supabase = createClient()
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [currentStep, setCurrentStep] = useState(1)
  const [hasInteractedWithStep3, setHasInteractedWithStep3] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [touched, setTouched] = useState<Record<string, boolean>>({})

  const [formData, setFormData] = useState({
    // Personal Information
    firstName: '',
    lastName: '',
    email: '',
    mobilePhone: '',
    mailingAddress: '',
    city: '',
    state: '',
    zipCode: '',
    roleType: '',
    individualNMLS: '',
    stateLicenses: [] as string[],
    birthday: '',
    gender: '',
    languagesSpoken: [] as string[],
    race: '',

    // Company Information
    company: '',
    companyNMLS: '',
    companyAddress: '',
    companyCity: '',
    companyState: '',
    companyZipCode: '',
    companyPhone: '',

    // Subscriptions
    scotsmanGuide: true,
  })

  useEffect(() => {
    async function loadProfile() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        router.push('/sign-in')
        return
      }

      const { data: profile, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single()

      console.log('Profile data loaded:', profile)
      console.log('User email:', user.email)

      if (error) {
        console.error('Error loading profile:', error)
      }

      if (profile) {
        // Check if already completed
        if (profile.profile_complete) {
          router.push('/dashboard')
          return
        }

        // Legacy 'select_plan' state. Pre-consolidation onboarding
        // had plan picking as its own route; the new sign-up pays
        // inline. Two cases now end up here:
        //   1) Already paid (active/trialing sub) but the sign-up's
        //      onboarding_step UPDATE never fired — they're on the
        //      right step, just mis-labeled. Fall through to
        //      complete-profile, no redirect needed.
        //   2) Never paid — route them to /dashboard/select-plan to
        //      complete checkout.
        if (profile.onboarding_step === 'select_plan') {
          // Check both columns — they're written by different code paths
          // and aren't always in sync. Active in either counts.
          const status = profile.stripe_subscription_status ?? profile.subscription_status
          const hasActiveSub = status === 'active' || status === 'trialing'
          if (!hasActiveSub) {
            router.push('/dashboard/select-plan')
            return
          }
          // Paid but mis-labeled — silently clear the stale state and
          // continue on to complete-profile.
          await supabase
            .from('profiles')
            .update({ onboarding_step: 'complete_profile' })
            .eq('id', user.id)
        }

        // Fuse 2026 wedge: between checkout and complete-profile we offer
        // eligible annual members a one-tap claim. The page self-skips
        // when the user isn't eligible or the event has ended.
        if (profile.onboarding_step === 'claim_fuse_ticket') {
          router.push('/onboarding/claim-fuse-ticket')
          return
        }

        // Pre-fill existing data from profile and user
        // Use first_name/last_name if available, otherwise parse full_name
        let firstName = profile.first_name || ''
        let lastName = profile.last_name || ''
        if (!firstName && !lastName && profile.full_name) {
          const nameParts = profile.full_name.split(' ')
          firstName = nameParts[0] || ''
          lastName = nameParts.slice(1).join(' ') || ''
        }

        setFormData({
          firstName,
          lastName,
          email: user.email || profile.email || '',
          mobilePhone: profile.phone || '',
          mailingAddress: profile.address || '',
          city: profile.city || '',
          state: profile.state || '',
          zipCode: profile.zip_code || '',
          roleType: profile.role || '',
          individualNMLS: profile.nmls_number || '',
          stateLicenses: profile.state_licenses || [],
          birthday: profile.birthday || '',
          gender: profile.gender || '',
          languagesSpoken: profile.languages_spoken || [],
          race: profile.race || '',
          company: profile.company || '',
          companyNMLS: profile.company_nmls || '',
          companyAddress: profile.company_address || '',
          companyCity: profile.company_city || '',
          companyState: profile.company_state || '',
          companyZipCode: profile.company_zip_code || '',
          companyPhone: profile.company_phone || '',
          scotsmanGuide: profile.scotsman_guide_subscription || false,
        })
      } else {
        // No profile found, just set email from user
        setFormData(prev => ({
          ...prev,
          email: user.email || '',
        }))
      }

      setIsLoading(false)
    }

    loadProfile()
  }, [])

  // Auto-enable submit button after 3 seconds on step 3 as fallback
  useEffect(() => {
    if (currentStep === 3 && !hasInteractedWithStep3) {
      const timer = setTimeout(() => {
        setHasInteractedWithStep3(true)
      }, 3000)

      return () => clearTimeout(timer)
    }
  }, [currentStep, hasInteractedWithStep3])

  // Re-validate on form data changes to clear errors when fields are filled
  useEffect(() => {
    if (Object.keys(touched).length > 0) {
      const step1Errors = validateStep1()
      const step2Errors = validateStep2()
      setErrors({ ...step1Errors, ...step2Errors })
    }
  }, [formData])

  const nextStep = () => {
    if (currentStep === 1) {
      const step1Errors = validateStep1()
      setErrors(step1Errors)
      markAllFieldsTouched(1)

      if (Object.keys(step1Errors).length > 0) {
        toast.error('Please fill in all required fields')
        return
      }
    }

    if (currentStep === 2) {
      const step2Errors = validateStep2()
      setErrors(step2Errors)
      markAllFieldsTouched(2)

      if (Object.keys(step2Errors).length > 0) {
        toast.error('Please fill in all required fields')
        return
      }
    }

    if (currentStep < 3) {
      setCurrentStep(currentStep + 1)
      setErrors({}) // Clear errors when moving to next step
    }
  }

  const previousStep = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1)
      // Reset step 3 interaction flag when going back
      if (currentStep === 3) {
        setHasInteractedWithStep3(false)
      }
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    // Prevent auto-submit on step 3 before user interaction
    if (currentStep === 3 && !hasInteractedWithStep3) {
      return
    }

    setIsSubmitting(true)

    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      // Update profile with all information
      const { error } = await supabase
        .from('profiles')
        .update({
          first_name: formData.firstName.trim(),
          last_name: formData.lastName.trim(),
          full_name: `${formData.firstName} ${formData.lastName}`.trim(),
          email: formData.email,
          phone: formData.mobilePhone,
          address: formData.mailingAddress,
          city: formData.city,
          state: formData.state,
          zip_code: formData.zipCode,
          role: formData.roleType,
          nmls_number: formData.individualNMLS || null,
          state_licenses: formData.stateLicenses,
          birthday: formData.birthday,
          gender: formData.gender,
          languages_spoken: formData.languagesSpoken,
          race: formData.race,
          company: formData.company,
          company_nmls: formData.companyNMLS,
          company_address: formData.companyAddress,
          company_city: formData.companyCity,
          company_state: formData.companyState,
          company_zip_code: formData.companyZipCode,
          company_phone: formData.companyPhone,
          scotsman_guide_subscription: formData.scotsmanGuide,
          profile_complete: true,
          onboarding_step: 'completed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', user.id)

      if (error) throw error

      // GHL sync happens automatically via database trigger

      // Redirect to dashboard
      router.push('/dashboard')
    } catch (error) {
      console.error('Error updating profile:', error)
      setIsSubmitting(false)
    }
  }

  const toggleStateLicense = (state: string) => {
    setFormData(prev => ({
      ...prev,
      stateLicenses: prev.stateLicenses.includes(state)
        ? prev.stateLicenses.filter(s => s !== state)
        : [...prev.stateLicenses, state]
    }))
  }

  const toggleLanguage = (language: string) => {
    setFormData(prev => ({
      ...prev,
      languagesSpoken: prev.languagesSpoken.includes(language)
        ? prev.languagesSpoken.filter(l => l !== language)
        : [...prev.languagesSpoken, language]
    }))
  }

  // Validation for each step
  const validateStep1 = () => {
    const newErrors: Record<string, string> = {}

    if (!formData.firstName.trim()) newErrors.firstName = 'First name is required'
    if (!formData.mobilePhone.trim()) newErrors.mobilePhone = 'Mobile phone is required'
    if (!formData.mailingAddress.trim()) newErrors.mailingAddress = 'Mailing address is required'
    if (!formData.city.trim()) newErrors.city = 'City is required'
    if (!formData.state.trim()) newErrors.state = 'State is required'
    if (!formData.zipCode.trim()) newErrors.zipCode = 'Zip code is required'
    if (!formData.roleType) newErrors.roleType = 'Role type is required'
    if (!formData.individualNMLS.trim()) newErrors.individualNMLS = 'Individual NMLS is required'
    if (formData.stateLicenses.length === 0) newErrors.stateLicenses = 'At least one state license is required'
    if (!formData.birthday) newErrors.birthday = 'Birthday is required'
    if (!formData.gender) newErrors.gender = 'Gender is required'
    if (formData.languagesSpoken.length === 0) newErrors.languagesSpoken = 'At least one language is required'
    if (!formData.race) newErrors.race = 'Race is required'

    return newErrors
  }

  const validateStep2 = () => {
    const newErrors: Record<string, string> = {}

    if (!formData.company.trim()) newErrors.company = 'Company name is required'
    if (!formData.companyPhone.trim()) newErrors.companyPhone = 'Company phone is required'
    if (!formData.companyAddress.trim()) newErrors.companyAddress = 'Company address is required'
    if (!formData.companyCity.trim()) newErrors.companyCity = 'Company city is required'
    if (!formData.companyState.trim()) newErrors.companyState = 'Company state is required'
    if (!formData.companyZipCode.trim()) newErrors.companyZipCode = 'Company zip code is required'
    if (!formData.companyNMLS.trim()) newErrors.companyNMLS = 'Company NMLS is required'

    return newErrors
  }

  const markAllFieldsTouched = (step: number) => {
    const step1Fields = ['firstName', 'mobilePhone', 'mailingAddress', 'city', 'state', 'zipCode', 'roleType', 'individualNMLS', 'stateLicenses', 'birthday', 'gender', 'languagesSpoken', 'race']
    const step2Fields = ['company', 'companyPhone', 'companyAddress', 'companyCity', 'companyState', 'companyZipCode', 'companyNMLS']

    const fields = step === 1 ? step1Fields : step2Fields
    const newTouched: Record<string, boolean> = { ...touched }
    fields.forEach(field => newTouched[field] = true)
    setTouched(newTouched)
  }

  const handleFieldBlur = (fieldName: string) => {
    setTouched(prev => ({ ...prev, [fieldName]: true }))
  }

  const getInputClassName = (fieldName: string, baseClass: string = '') => {
    const hasError = touched[fieldName] && errors[fieldName]
    return `${baseClass} ${hasError ? 'border-red-500 focus:border-red-500 focus:ring-red-500' : ''}`
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    router.push('/sign-in')
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-[#20adce] via-[#1a8ba8] to-[#25314e] flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-white animate-spin" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#20adce] via-[#1a8ba8] to-[#25314e] py-12 px-4 relative">
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

      <div className="max-w-4xl mx-auto">
        {/* Logo */}
        <div className="text-center mb-8">
          <Image
            src="/assets/AMP_MemberPortalLogo_White.svg"
            alt="AMP AIME Member Portal"
            width={300}
            height={80}
            className="w-auto h-16 mx-auto mb-4"
            priority
          />
          <h1 className="text-3xl md:text-4xl font-bold text-white mb-2">
            Complete Your Profile
          </h1>
          <p className="text-white/90">
            Step {currentStep} of 3
          </p>
        </div>

        {/* Progress Indicator */}
        <div className="flex justify-center mb-8 space-x-2">
          {[1, 2, 3].map((step) => (
            <div
              key={step}
              className={`h-2 w-24 rounded-full transition-colors ${
                step === currentStep
                  ? 'bg-[#dd1969]'
                  : step < currentStep
                  ? 'bg-white'
                  : 'bg-white/30'
              }`}
            />
          ))}
        </div>

        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-xl p-8">
          {/* Step 1: Personal Information */}
          {currentStep === 1 && (
            <div className="space-y-6">
              <h2 className="text-2xl font-bold text-[#25314e] mb-6">Personal Information</h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <Label htmlFor="firstName" className={errors.firstName && touched.firstName ? 'text-red-500' : ''}>First Name *</Label>
                  <Input
                    id="firstName"
                    type="text"
                    value={formData.firstName}
                    onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
                    onBlur={() => handleFieldBlur('firstName')}
                    className={getInputClassName('firstName', 'mt-2')}
                  />
                  {errors.firstName && touched.firstName && (
                    <p className="text-red-500 text-sm mt-1">{errors.firstName}</p>
                  )}
                </div>

                <div>
                  <Label htmlFor="lastName">Last Name</Label>
                  <Input
                    id="lastName"
                    type="text"
                    value={formData.lastName}
                    onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
                    className="mt-2"
                  />
                </div>

                <div>
                  <Label htmlFor="email">Email *</Label>
                  <Input
                    id="email"
                    type="email"
                    value={formData.email}
                    disabled
                    className="mt-2 bg-gray-50"
                  />
                </div>

                <div>
                  <Label htmlFor="mobilePhone" className={errors.mobilePhone && touched.mobilePhone ? 'text-red-500' : ''}>Mobile Phone *</Label>
                  <Input
                    id="mobilePhone"
                    type="tel"
                    value={formData.mobilePhone}
                    onChange={(e) => setFormData({ ...formData, mobilePhone: e.target.value })}
                    onBlur={() => handleFieldBlur('mobilePhone')}
                    className={getInputClassName('mobilePhone', 'mt-2')}
                  />
                  {errors.mobilePhone && touched.mobilePhone && (
                    <p className="text-red-500 text-sm mt-1">{errors.mobilePhone}</p>
                  )}
                </div>

                <div className="md:col-span-2">
                  <Label htmlFor="mailingAddress" className={errors.mailingAddress && touched.mailingAddress ? 'text-red-500' : ''}>Mailing Address *</Label>
                  <Input
                    id="mailingAddress"
                    type="text"
                    value={formData.mailingAddress}
                    onChange={(e) => setFormData({ ...formData, mailingAddress: e.target.value })}
                    onBlur={() => handleFieldBlur('mailingAddress')}
                    className={getInputClassName('mailingAddress', 'mt-2')}
                  />
                  {errors.mailingAddress && touched.mailingAddress && (
                    <p className="text-red-500 text-sm mt-1">{errors.mailingAddress}</p>
                  )}
                </div>

                <div>
                  <Label htmlFor="city" className={errors.city && touched.city ? 'text-red-500' : ''}>City *</Label>
                  <Input
                    id="city"
                    type="text"
                    value={formData.city}
                    onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                    onBlur={() => handleFieldBlur('city')}
                    className={getInputClassName('city', 'mt-2')}
                  />
                  {errors.city && touched.city && (
                    <p className="text-red-500 text-sm mt-1">{errors.city}</p>
                  )}
                </div>

                <div>
                  <Label htmlFor="state" className={errors.state && touched.state ? 'text-red-500' : ''}>State *</Label>
                  <Input
                    id="state"
                    type="text"
                    value={formData.state}
                    onChange={(e) => setFormData({ ...formData, state: e.target.value })}
                    onBlur={() => handleFieldBlur('state')}
                    className={getInputClassName('state', 'mt-2')}
                  />
                  {errors.state && touched.state && (
                    <p className="text-red-500 text-sm mt-1">{errors.state}</p>
                  )}
                </div>

                <div>
                  <Label htmlFor="zipCode" className={errors.zipCode && touched.zipCode ? 'text-red-500' : ''}>Zip Code *</Label>
                  <Input
                    id="zipCode"
                    type="text"
                    value={formData.zipCode}
                    onChange={(e) => setFormData({ ...formData, zipCode: e.target.value })}
                    onBlur={() => handleFieldBlur('zipCode')}
                    className={getInputClassName('zipCode', 'mt-2')}
                  />
                  {errors.zipCode && touched.zipCode && (
                    <p className="text-red-500 text-sm mt-1">{errors.zipCode}</p>
                  )}
                </div>

                <div>
                  <Label htmlFor="roleType" className={errors.roleType && touched.roleType ? 'text-red-500' : ''}>Role Type *</Label>
                  <Select value={formData.roleType} onValueChange={(value) => { setFormData({ ...formData, roleType: value }); handleFieldBlur('roleType') }}>
                    <SelectTrigger className={`mt-2 ${errors.roleType && touched.roleType ? 'border-red-500' : ''}`}>
                      <SelectValue placeholder="Select role type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="loan_officer">Loan Officer</SelectItem>
                      <SelectItem value="broker_owner">Broker Owner</SelectItem>
                      <SelectItem value="loan_officer_assistant">Loan Officer Assistant</SelectItem>
                      <SelectItem value="processor">Processor</SelectItem>
                    </SelectContent>
                  </Select>
                  {errors.roleType && touched.roleType && (
                    <p className="text-red-500 text-sm mt-1">{errors.roleType}</p>
                  )}
                </div>

                <div>
                  <Label htmlFor="individualNMLS" className={errors.individualNMLS && touched.individualNMLS ? 'text-red-500' : ''}>Individual NMLS *</Label>
                  <Input
                    id="individualNMLS"
                    type="text"
                    value={formData.individualNMLS}
                    onChange={(e) => setFormData({ ...formData, individualNMLS: e.target.value })}
                    onBlur={() => handleFieldBlur('individualNMLS')}
                    className={getInputClassName('individualNMLS', 'mt-2')}
                  />
                  {errors.individualNMLS && touched.individualNMLS && (
                    <p className="text-red-500 text-sm mt-1">{errors.individualNMLS}</p>
                  )}
                </div>

                <div>
                  <Label htmlFor="stateLicenses" className={errors.stateLicenses && touched.stateLicenses ? 'text-red-500' : ''}>State Licenses (Select all that apply) *</Label>
                  <Select value={formData.stateLicenses[0] || ''} onValueChange={(value) => { toggleStateLicense(value); handleFieldBlur('stateLicenses') }}>
                    <SelectTrigger className={`mt-2 ${errors.stateLicenses && touched.stateLicenses ? 'border-red-500' : ''}`}>
                      <SelectValue placeholder="Select state licenses" />
                    </SelectTrigger>
                    <SelectContent className="max-h-[300px]">
                      <SelectItem value="AL">AL - Alabama</SelectItem>
                      <SelectItem value="AK">AK - Alaska</SelectItem>
                      <SelectItem value="AZ">AZ - Arizona</SelectItem>
                      <SelectItem value="AR">AR - Arkansas</SelectItem>
                      <SelectItem value="CA">CA - California</SelectItem>
                      <SelectItem value="CO">CO - Colorado</SelectItem>
                      <SelectItem value="CT">CT - Connecticut</SelectItem>
                      <SelectItem value="DE">DE - Delaware</SelectItem>
                      <SelectItem value="FL">FL - Florida</SelectItem>
                      <SelectItem value="GA">GA - Georgia</SelectItem>
                      <SelectItem value="HI">HI - Hawaii</SelectItem>
                      <SelectItem value="ID">ID - Idaho</SelectItem>
                      <SelectItem value="IL">IL - Illinois</SelectItem>
                      <SelectItem value="IN">IN - Indiana</SelectItem>
                      <SelectItem value="IA">IA - Iowa</SelectItem>
                      <SelectItem value="KS">KS - Kansas</SelectItem>
                      <SelectItem value="KY">KY - Kentucky</SelectItem>
                      <SelectItem value="LA">LA - Louisiana</SelectItem>
                      <SelectItem value="ME">ME - Maine</SelectItem>
                      <SelectItem value="MD">MD - Maryland</SelectItem>
                      <SelectItem value="MA">MA - Massachusetts</SelectItem>
                      <SelectItem value="MI">MI - Michigan</SelectItem>
                      <SelectItem value="MN">MN - Minnesota</SelectItem>
                      <SelectItem value="MS">MS - Mississippi</SelectItem>
                      <SelectItem value="MO">MO - Missouri</SelectItem>
                      <SelectItem value="MT">MT - Montana</SelectItem>
                      <SelectItem value="NE">NE - Nebraska</SelectItem>
                      <SelectItem value="NV">NV - Nevada</SelectItem>
                      <SelectItem value="NH">NH - New Hampshire</SelectItem>
                      <SelectItem value="NJ">NJ - New Jersey</SelectItem>
                      <SelectItem value="NM">NM - New Mexico</SelectItem>
                      <SelectItem value="NY">NY - New York</SelectItem>
                      <SelectItem value="NC">NC - North Carolina</SelectItem>
                      <SelectItem value="ND">ND - North Dakota</SelectItem>
                      <SelectItem value="OH">OH - Ohio</SelectItem>
                      <SelectItem value="OK">OK - Oklahoma</SelectItem>
                      <SelectItem value="OR">OR - Oregon</SelectItem>
                      <SelectItem value="PA">PA - Pennsylvania</SelectItem>
                      <SelectItem value="RI">RI - Rhode Island</SelectItem>
                      <SelectItem value="SC">SC - South Carolina</SelectItem>
                      <SelectItem value="SD">SD - South Dakota</SelectItem>
                      <SelectItem value="TN">TN - Tennessee</SelectItem>
                      <SelectItem value="TX">TX - Texas</SelectItem>
                      <SelectItem value="UT">UT - Utah</SelectItem>
                      <SelectItem value="VT">VT - Vermont</SelectItem>
                      <SelectItem value="VA">VA - Virginia</SelectItem>
                      <SelectItem value="WA">WA - Washington</SelectItem>
                      <SelectItem value="WV">WV - West Virginia</SelectItem>
                      <SelectItem value="WI">WI - Wisconsin</SelectItem>
                      <SelectItem value="WY">WY - Wyoming</SelectItem>
                    </SelectContent>
                  </Select>
                  {formData.stateLicenses.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {formData.stateLicenses.map(state => (
                        <span key={state} className="bg-gray-100 px-3 py-1 rounded-full text-sm cursor-pointer hover:bg-red-100" onClick={() => toggleStateLicense(state)}>
                          {state} ×
                        </span>
                      ))}
                    </div>
                  )}
                  {errors.stateLicenses && touched.stateLicenses && (
                    <p className="text-red-500 text-sm mt-1">{errors.stateLicenses}</p>
                  )}
                </div>

                <div>
                  <Label htmlFor="birthday" className={errors.birthday && touched.birthday ? 'text-red-500' : ''}>Birthday *</Label>
                  <Input
                    id="birthday"
                    type="date"
                    value={formData.birthday}
                    onChange={(e) => setFormData({ ...formData, birthday: e.target.value })}
                    onBlur={() => handleFieldBlur('birthday')}
                    className={getInputClassName('birthday', 'mt-2')}
                  />
                  {errors.birthday && touched.birthday && (
                    <p className="text-red-500 text-sm mt-1">{errors.birthday}</p>
                  )}
                </div>

                <div>
                  <Label htmlFor="gender" className={errors.gender && touched.gender ? 'text-red-500' : ''}>Gender *</Label>
                  <Select value={formData.gender} onValueChange={(value) => { setFormData({ ...formData, gender: value }); handleFieldBlur('gender') }}>
                    <SelectTrigger className={`mt-2 ${errors.gender && touched.gender ? 'border-red-500' : ''}`}>
                      <SelectValue placeholder="Select gender" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Male">Male</SelectItem>
                      <SelectItem value="Female">Female</SelectItem>
                      <SelectItem value="Other">Other</SelectItem>
                      <SelectItem value="Prefer not to say">Prefer not to say</SelectItem>
                    </SelectContent>
                  </Select>
                  {errors.gender && touched.gender && (
                    <p className="text-red-500 text-sm mt-1">{errors.gender}</p>
                  )}
                </div>

                <div>
                  <Label htmlFor="languagesSpoken" className={errors.languagesSpoken && touched.languagesSpoken ? 'text-red-500' : ''}>Languages Spoken (Select all that apply) *</Label>
                  <Select value={formData.languagesSpoken[0] || ''} onValueChange={(value) => { toggleLanguage(value); handleFieldBlur('languagesSpoken') }}>
                    <SelectTrigger className={`mt-2 ${errors.languagesSpoken && touched.languagesSpoken ? 'border-red-500' : ''}`}>
                      <SelectValue placeholder="Select languages" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="English">English</SelectItem>
                      <SelectItem value="Spanish">Spanish</SelectItem>
                      <SelectItem value="Mandarin">Mandarin</SelectItem>
                      <SelectItem value="French">French</SelectItem>
                      <SelectItem value="Other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                  {formData.languagesSpoken.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {formData.languagesSpoken.map(lang => (
                        <span key={lang} className="bg-gray-100 px-3 py-1 rounded-full text-sm cursor-pointer hover:bg-red-100" onClick={() => toggleLanguage(lang)}>
                          {lang} ×
                        </span>
                      ))}
                    </div>
                  )}
                  {errors.languagesSpoken && touched.languagesSpoken && (
                    <p className="text-red-500 text-sm mt-1">{errors.languagesSpoken}</p>
                  )}
                </div>

                <div>
                  <Label htmlFor="race" className={errors.race && touched.race ? 'text-red-500' : ''}>Race *</Label>
                  <Select value={formData.race} onValueChange={(value) => { setFormData({ ...formData, race: value }); handleFieldBlur('race') }}>
                    <SelectTrigger className={`mt-2 ${errors.race && touched.race ? 'border-red-500' : ''}`}>
                      <SelectValue placeholder="Select race" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Asian">Asian</SelectItem>
                      <SelectItem value="Black or African American">Black or African American</SelectItem>
                      <SelectItem value="Hispanic or Latino">Hispanic or Latino</SelectItem>
                      <SelectItem value="White">White</SelectItem>
                      <SelectItem value="Native American or Alaska Native">Native American or Alaska Native</SelectItem>
                      <SelectItem value="Native Hawaiian or Pacific Islander">Native Hawaiian or Pacific Islander</SelectItem>
                      <SelectItem value="Two or More Races">Two or More Races</SelectItem>
                      <SelectItem value="Prefer not to say">Prefer not to say</SelectItem>
                    </SelectContent>
                  </Select>
                  {errors.race && touched.race && (
                    <p className="text-red-500 text-sm mt-1">{errors.race}</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Company Information */}
          {currentStep === 2 && (
            <div className="space-y-6">
              <h2 className="text-2xl font-bold text-[#25314e] mb-6">Company Information</h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <Label htmlFor="company" className={errors.company && touched.company ? 'text-red-500' : ''}>Company Name *</Label>
                  <Input
                    id="company"
                    type="text"
                    value={formData.company}
                    onChange={(e) => setFormData({ ...formData, company: e.target.value })}
                    onBlur={() => handleFieldBlur('company')}
                    className={getInputClassName('company', 'mt-2')}
                  />
                  {errors.company && touched.company && (
                    <p className="text-red-500 text-sm mt-1">{errors.company}</p>
                  )}
                </div>

                <div>
                  <Label htmlFor="companyPhone" className={errors.companyPhone && touched.companyPhone ? 'text-red-500' : ''}>Company Phone Number *</Label>
                  <Input
                    id="companyPhone"
                    type="tel"
                    value={formData.companyPhone}
                    onChange={(e) => setFormData({ ...formData, companyPhone: e.target.value })}
                    onBlur={() => handleFieldBlur('companyPhone')}
                    className={getInputClassName('companyPhone', 'mt-2')}
                  />
                  {errors.companyPhone && touched.companyPhone && (
                    <p className="text-red-500 text-sm mt-1">{errors.companyPhone}</p>
                  )}
                </div>

                <div className="md:col-span-2">
                  <Label htmlFor="companyAddress" className={errors.companyAddress && touched.companyAddress ? 'text-red-500' : ''}>Company Address *</Label>
                  <Input
                    id="companyAddress"
                    type="text"
                    value={formData.companyAddress}
                    onChange={(e) => setFormData({ ...formData, companyAddress: e.target.value })}
                    onBlur={() => handleFieldBlur('companyAddress')}
                    className={getInputClassName('companyAddress', 'mt-2')}
                  />
                  {errors.companyAddress && touched.companyAddress && (
                    <p className="text-red-500 text-sm mt-1">{errors.companyAddress}</p>
                  )}
                </div>

                <div>
                  <Label htmlFor="companyCity" className={errors.companyCity && touched.companyCity ? 'text-red-500' : ''}>Company City *</Label>
                  <Input
                    id="companyCity"
                    type="text"
                    value={formData.companyCity}
                    onChange={(e) => setFormData({ ...formData, companyCity: e.target.value })}
                    onBlur={() => handleFieldBlur('companyCity')}
                    className={getInputClassName('companyCity', 'mt-2')}
                  />
                  {errors.companyCity && touched.companyCity && (
                    <p className="text-red-500 text-sm mt-1">{errors.companyCity}</p>
                  )}
                </div>

                <div>
                  <Label htmlFor="companyState" className={errors.companyState && touched.companyState ? 'text-red-500' : ''}>Company State *</Label>
                  <Input
                    id="companyState"
                    type="text"
                    value={formData.companyState}
                    onChange={(e) => setFormData({ ...formData, companyState: e.target.value })}
                    onBlur={() => handleFieldBlur('companyState')}
                    className={getInputClassName('companyState', 'mt-2')}
                  />
                  {errors.companyState && touched.companyState && (
                    <p className="text-red-500 text-sm mt-1">{errors.companyState}</p>
                  )}
                </div>

                <div>
                  <Label htmlFor="companyZipCode" className={errors.companyZipCode && touched.companyZipCode ? 'text-red-500' : ''}>Company Zip Code *</Label>
                  <Input
                    id="companyZipCode"
                    type="text"
                    value={formData.companyZipCode}
                    onChange={(e) => setFormData({ ...formData, companyZipCode: e.target.value })}
                    onBlur={() => handleFieldBlur('companyZipCode')}
                    className={getInputClassName('companyZipCode', 'mt-2')}
                  />
                  {errors.companyZipCode && touched.companyZipCode && (
                    <p className="text-red-500 text-sm mt-1">{errors.companyZipCode}</p>
                  )}
                </div>

                <div>
                  <Label htmlFor="companyNMLS" className={errors.companyNMLS && touched.companyNMLS ? 'text-red-500' : ''}>Company NMLS *</Label>
                  <Input
                    id="companyNMLS"
                    type="text"
                    value={formData.companyNMLS}
                    onChange={(e) => setFormData({ ...formData, companyNMLS: e.target.value })}
                    onBlur={() => handleFieldBlur('companyNMLS')}
                    className={getInputClassName('companyNMLS', 'mt-2')}
                  />
                  {errors.companyNMLS && touched.companyNMLS && (
                    <p className="text-red-500 text-sm mt-1">{errors.companyNMLS}</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Subscriptions */}
          {currentStep === 3 && (
            <div className="space-y-6">
              <h2 className="text-2xl font-bold text-[#25314e] mb-6">Subscriptions</h2>

              <p className="text-sm text-gray-600 mb-4">
                Select your subscription preferences below to continue.
              </p>

              <div className="flex items-start space-x-3">
                <Checkbox
                  id="scotsmanGuide"
                  checked={formData.scotsmanGuide}
                  onCheckedChange={(checked) => {
                    setHasInteractedWithStep3(true)
                    setFormData({ ...formData, scotsmanGuide: checked as boolean })
                  }}
                />
                <div className="grid gap-1.5 leading-none">
                  <label
                    htmlFor="scotsmanGuide"
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                    onClick={() => setHasInteractedWithStep3(true)}
                  >
                    Check the box to claim your FREE subscription to Scotsman Guide.
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* Navigation Buttons */}
          <div className="flex justify-between pt-8 mt-8 border-t">
            {currentStep > 1 && (
              <Button
                type="button"
                onClick={previousStep}
                variant="outline"
                className="flex items-center gap-2"
              >
                <ChevronLeft className="w-4 h-4" />
                Previous
              </Button>
            )}

            <div className="ml-auto">
              {currentStep < 3 ? (
                <Button
                  type="button"
                  onClick={nextStep}
                  className="bg-[#dd1969] hover:bg-[#c01559] text-white font-semibold px-8 flex items-center gap-2"
                >
                  Next
                  <ChevronRight className="w-4 h-4" />
                </Button>
              ) : (
                <Button
                  type="submit"
                  disabled={isSubmitting || !hasInteractedWithStep3}
                  className="bg-[#dd1969] hover:bg-[#c01559] text-white font-semibold px-12 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Completing Profile...
                    </>
                  ) : (
                    'Complete Profile'
                  )}
                </Button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
