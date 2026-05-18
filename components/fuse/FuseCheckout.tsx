'use client'

import { useState, useCallback, useMemo } from 'react'
import './fuse-checkout.css'

// ===== Types =====

interface FuseEvent {
  id: string
  name: string
  year: number
  start_date: string
  end_date: string
  location: string
}

interface TicketPrice {
  id: string
  product_key: string
  label: string
  description: string | null
  price: number
  stripe_price_id: string | null
  is_addon: boolean
  is_included: boolean
  gender_lock: string | null
  pricing_phase: string
  sort_order: number
}

interface FuseCheckoutProps {
  event: FuseEvent
  prices: TicketPrice[]
  isEarlyBird: boolean
}

type Step = 1 | 2 | 3 | 'success'

interface Guest {
  id: number
  firstName: string
  lastName: string
  email: string
}

// ===== Static Constants =====

const GENDER_OPTIONS = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'non_binary', label: 'Non-binary' },
  { value: 'prefer_not_to_say', label: 'Prefer not to say' },
]

const FUSE_COUNT_OPTIONS = [
  { value: '0', label: 'This is my first Fuse' },
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '4', label: '4' },
  { value: '5+', label: '5 or more' },
]

// ===== Component =====

export function FuseCheckout({ event, prices, isEarlyBird }: FuseCheckoutProps) {
  // Derive tickets and addons from prices.
  // Defensive dedup by product_key: parent should already pass deduped
  // phase-active rows via pickActivePrices(), but if a row pair sneaks
  // through we still render only one card per product.
  const tickets = useMemo(() => {
    const seen = new Set<string>()
    return prices
      .filter((p) => !p.is_addon)
      .filter((p) => {
        if (seen.has(p.product_key)) return false
        seen.add(p.product_key)
        return true
      })
  }, [prices])
  const addons = useMemo(() => {
    const seen = new Set<string>()
    return prices
      .filter((p) => p.is_addon)
      .filter((p) => {
        if (seen.has(p.product_key)) return false
        seen.add(p.product_key)
        return true
      })
  }, [prices])

  // Step state
  const [step, setStep] = useState<Step>(1)

  // Step 1 — Attendee Info
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [preferredName, setPreferredName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [company, setCompany] = useState('')
  const [gender, setGender] = useState('')
  const [fuseCount, setFuseCount] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  // Step 2 — Tickets & Add-ons
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null)
  const [addonState, setAddonState] = useState<Record<string, boolean>>({})
  const [guests, setGuests] = useState<Guest[]>([])
  const [nextGuestId, setNextGuestId] = useState(0)
  const [guestErrors, setGuestErrors] = useState<Record<string, string>>({})

  // Submission
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Derived
  const selectedTicket = tickets.find((t) => t.id === selectedTicketId)

  const getTotal = useCallback(() => {
    let total = selectedTicket?.price || 0
    addons.forEach((addon) => {
      if (addonState[addon.product_key]) total += addon.price
    })
    // No guest pricing in current setup — guests are handled separately if needed
    return total
  }, [selectedTicket, addons, addonState])

  // Format event dates
  const formatDates = () => {
    if (!event.start_date) return ''
    const start = new Date(event.start_date + 'T00:00:00')
    const end = event.end_date ? new Date(event.end_date + 'T00:00:00') : null
    const months = [
      'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
      'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
    ]
    const m1 = months[start.getMonth()]
    const d1 = start.getDate()
    const y = start.getFullYear()
    if (end) {
      const d2 = end.getDate()
      const m2 = months[end.getMonth()]
      if (start.getMonth() === end.getMonth()) {
        return `${m1} ${d1}-${d2}, ${y}`
      }
      return `${m1} ${d1} - ${m2} ${d2}, ${y}`
    }
    return `${m1} ${d1}, ${y}`
  }

  // Step navigation
  const goToStep = (n: Step) => {
    setStep(n)
    window.scrollTo(0, 0)
  }

  // ===== Validation =====

  const validateStep1 = () => {
    const errs: Record<string, string> = {}
    if (!firstName.trim()) errs.firstName = 'Required'
    if (!lastName.trim()) errs.lastName = 'Required'
    if (!phone.trim()) errs.phone = 'Required'
    if (!email.trim() || !/\S+@\S+\.\S+/.test(email)) errs.email = 'Valid email required'
    if (!company.trim()) errs.company = 'Required'
    if (!gender) errs.gender = 'Required'
    if (!fuseCount) errs.fuseCount = 'Required'
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  const validateStep2 = () => {
    if (!selectedTicketId) {
      setErrors({ ticket: 'Please select a ticket type' })
      return false
    }
    const gErrs: Record<string, string> = {}
    let valid = true
    guests.forEach((g) => {
      if (!g.firstName.trim()) { gErrs[`fn-${g.id}`] = 'Required'; valid = false }
      if (!g.lastName.trim()) { gErrs[`ln-${g.id}`] = 'Required'; valid = false }
      if (!g.email.trim() || !/\S+@\S+\.\S+/.test(g.email)) { gErrs[`em-${g.id}`] = 'Valid email required'; valid = false }
    })
    setGuestErrors(gErrs)
    setErrors({})
    return valid
  }

  // ===== Handlers =====

  const handleStep1Continue = () => {
    if (validateStep1()) {
      // Reset WMN addon if gender changed to non-female
      if (gender !== 'female' && addonState.wmn) {
        setAddonState((prev) => ({ ...prev, wmn: false }))
      }
      goToStep(2)
    }
  }

  const handleStep2Continue = () => {
    if (validateStep2()) {
      goToStep(3)
    }
  }

  const addGuest = () => {
    const id = nextGuestId + 1
    setNextGuestId(id)
    setGuests([...guests, { id, firstName: '', lastName: '', email: '' }])
  }

  const removeGuest = (id: number) => {
    setGuests(guests.filter((g) => g.id !== id))
  }

  const updateGuest = (id: number, field: keyof Omit<Guest, 'id'>, value: string) => {
    setGuests(guests.map((g) => (g.id === id ? { ...g, [field]: value } : g)))
  }

  const toggleAddon = (productKey: string) => {
    const addon = addons.find((a) => a.product_key === productKey)
    if (addon?.gender_lock && gender !== addon.gender_lock) return
    setAddonState((prev) => ({ ...prev, [productKey]: !prev[productKey] }))
  }

  const handleSubmit = async () => {
    setIsSubmitting(true)
    setErrors({})
    try {
      // Map product_key to DB ticket_type
      const ticketTypeMap: Record<string, string> = {
        ga: 'general_admission',
        ga_plus: 'general_admission_plus',
        vip: 'vip',
      }

      const response = await fetch('/api/fuse-registration/public', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fuse_event_id: event.id,
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          preferred_name: preferredName.trim() || null,
          phone: phone.trim(),
          email: email.trim().toLowerCase(),
          company: company.trim(),
          gender,
          fuse_attendance: fuseCount,
          ticket_type: ticketTypeMap[selectedTicket?.product_key || 'ga'] || 'general_admission',
          has_hall_of_aime: !!addonState.hoa,
          has_wmn_at_fuse: !!addonState.wmn,
          guests: guests.map((g) => ({
            full_name: `${g.firstName.trim()} ${g.lastName.trim()}`,
            email: g.email.trim().toLowerCase(),
            ticket_type: 'general_admission',
          })),
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Registration failed')
      }

      // If Stripe checkout URL returned, redirect to payment
      if (data.checkout_url) {
        window.location.href = data.checkout_url
        return
      }

      // Free registration — show success
      goToStep('success')
    } catch (error: any) {
      setErrors({ submit: error.message })
    } finally {
      setIsSubmitting(false)
    }
  }

  // ===== Summary strip info =====
  const getSummaryText = () => {
    if (!selectedTicket) return ''
    const parts = [selectedTicket.label]
    if (guests.length > 0) parts.push(`${guests.length} guest${guests.length > 1 ? 's' : ''}`)
    const addonCount = Object.values(addonState).filter(Boolean).length
    if (addonCount > 0) parts.push(`${addonCount} add-on${addonCount > 1 ? 's' : ''}`)
    return parts.join(' + ')
  }

  // ===== Label helpers =====
  const genderLabel = (val: string) =>
    GENDER_OPTIONS.find((o) => o.value === val)?.label || val

  const fuseCountLabel = (val: string) =>
    FUSE_COUNT_OPTIONS.find((o) => o.value === val)?.label || val

  // ===== Render =====

  return (
    <div className="fuse-page">
      {/* Header */}
      <div className="fuse-header">
        <div className="fuse-skyline-wrap">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/assets/fuse/austin-skyline.jpg"
            alt=""
            className="fuse-skyline-img"
          />
        </div>
        <div className="fuse-header-content">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/assets/fuse/fuse-logo.png"
            alt="Fuse Austin — Powered by AIME"
            className="fuse-logo-img"
          />
          <div className="fuse-event-date">{formatDates()}</div>
          <div className="fuse-event-venue">{event.location}</div>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="fuse-progress">
        <div className="fuse-progress-step">
          <div className={`fuse-progress-dot ${step === 1 ? 'active' : typeof step === 'number' && step > 1 ? 'done' : step === 'success' ? 'done' : ''}`}>
            {(typeof step === 'number' && step > 1) || step === 'success' ? '✓' : '1'}
          </div>
          <span className={`fuse-progress-label ${step === 1 ? 'active' : ''}`}>Your Info</span>
          <div className={`fuse-progress-line ${(typeof step === 'number' && step > 1) || step === 'success' ? 'done' : ''}`} />
        </div>
        <div className="fuse-progress-step">
          <div className={`fuse-progress-dot ${step === 2 ? 'active' : (typeof step === 'number' && step > 2) || step === 'success' ? 'done' : ''}`}>
            {(typeof step === 'number' && step > 2) || step === 'success' ? '✓' : '2'}
          </div>
          <span className={`fuse-progress-label ${step === 2 ? 'active' : ''}`}>Tickets</span>
          <div className={`fuse-progress-line ${(typeof step === 'number' && step > 2) || step === 'success' ? 'done' : ''}`} />
        </div>
        <div className="fuse-progress-step">
          <div className={`fuse-progress-dot ${step === 3 ? 'active' : step === 'success' ? 'done' : ''}`}>
            {step === 'success' ? '✓' : '3'}
          </div>
          <span className={`fuse-progress-label ${step === 3 ? 'active' : ''}`}>Review</span>
        </div>
      </div>

      {/* Content */}
      <div className="fuse-container">
        {/* ===== STEP 1: Attendee Information ===== */}
        {step === 1 && (
          <div className="fuse-step" key="step-1">
            <div className="fuse-parchment">
              <div className="fuse-card-title">Attendee Information</div>
              <div className="fuse-card-subtitle">Tell us about yourself</div>
              <div className="fuse-title-rule"><span className="star">&#10022;</span></div>

              <div className="fuse-grid2">
                <div className="fuse-field">
                  <label>First Name <span className="req">*</span></label>
                  <input
                    type="text"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="First name"
                    className={errors.firstName ? 'error' : ''}
                  />
                  {errors.firstName && <span className="fuse-error-text">{errors.firstName}</span>}
                </div>
                <div className="fuse-field">
                  <label>Last Name <span className="req">*</span></label>
                  <input
                    type="text"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder="Last name"
                    className={errors.lastName ? 'error' : ''}
                  />
                  {errors.lastName && <span className="fuse-error-text">{errors.lastName}</span>}
                </div>
              </div>

              <div className="fuse-field">
                <label>Preferred Name <span className="hint">— What should we put on your badge?</span></label>
                <input
                  type="text"
                  value={preferredName}
                  onChange={(e) => setPreferredName(e.target.value)}
                  placeholder="e.g. JJ"
                />
              </div>

              <div className="fuse-grid2">
                <div className="fuse-field">
                  <label>Mobile Phone <span className="req">*</span></label>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+1 (555) 123-4567"
                    className={errors.phone ? 'error' : ''}
                  />
                  {errors.phone && <span className="fuse-error-text">{errors.phone}</span>}
                </div>
                <div className="fuse-field">
                  <label>Email Address <span className="req">*</span></label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="your@email.com"
                    className={errors.email ? 'error' : ''}
                  />
                  {errors.email && <span className="fuse-error-text">{errors.email}</span>}
                </div>
              </div>

              <div className="fuse-field">
                <label>Company Name <span className="req">*</span></label>
                <input
                  type="text"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  placeholder="Company name"
                  className={errors.company ? 'error' : ''}
                />
                {errors.company && <span className="fuse-error-text">{errors.company}</span>}
              </div>

              <div className="fuse-grid2">
                <div className="fuse-field">
                  <label>Gender <span className="req">*</span></label>
                  <select
                    value={gender}
                    onChange={(e) => setGender(e.target.value)}
                    className={errors.gender ? 'error' : ''}
                  >
                    <option value="">Select...</option>
                    {GENDER_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  {errors.gender && <span className="fuse-error-text">{errors.gender}</span>}
                </div>
                <div className="fuse-field">
                  <label>Fuse Events Attended <span className="req">*</span></label>
                  <select
                    value={fuseCount}
                    onChange={(e) => setFuseCount(e.target.value)}
                    className={errors.fuseCount ? 'error' : ''}
                  >
                    <option value="">Select...</option>
                    {FUSE_COUNT_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  {errors.fuseCount && <span className="fuse-error-text">{errors.fuseCount}</span>}
                </div>
              </div>

              <button className="fuse-btn-primary" onClick={handleStep1Continue}>
                Continue to Tickets &#9733;
              </button>
            </div>
          </div>
        )}

        {/* ===== STEP 2: Select Ticket ===== */}
        {step === 2 && (
          <div className="fuse-step" key="step-2">
            <div className="fuse-parchment">
              <div className="fuse-card-title">Select Your Ticket</div>
              <div className="fuse-card-subtitle">Choose the experience that&apos;s right for you</div>
              <div className="fuse-title-rule"><span className="star">&#10022;</span></div>

              {errors.ticket && <div className="fuse-error-banner">{errors.ticket}</div>}

              {/* Ticket cards — from DB */}
              <div className="fuse-ticket-grid">
                {tickets.map((t) => (
                  <div
                    key={t.id}
                    className={`fuse-ticket-card ${selectedTicketId === t.id ? 'selected' : ''}`}
                    onClick={() => { setSelectedTicketId(t.id); setErrors({}) }}
                  >
                    <div className="fuse-ticket-top">
                      <div className="fuse-ticket-radio">
                        <div className="fuse-ticket-radio-inner" />
                      </div>
                      {isEarlyBird && t.pricing_phase === 'early_bird' && (
                        <span className="fuse-popular-badge">&#10022; Early Bird</span>
                      )}
                    </div>
                    <div className="fuse-ticket-price">${t.price.toLocaleString()}</div>
                    <div className="fuse-ticket-name">{t.label}</div>
                    <div className="fuse-ticket-desc">{t.description}</div>
                  </div>
                ))}
              </div>

              {/* Add-ons — from DB */}
              <div className="fuse-addon-section">
                <div className="fuse-addon-title">Add-Ons</div>
                <div className="fuse-addon-subtitle">Enhance your Fuse experience</div>

                {addons.map((addon) => {
                  const isLocked = !!(addon.gender_lock && gender !== addon.gender_lock)
                  const isSelected = !!addonState[addon.product_key]
                  return (
                    <div
                      key={addon.id}
                      className={`fuse-addon-card ${isSelected ? 'selected' : ''} ${isLocked ? 'locked' : ''}`}
                      onClick={() => toggleAddon(addon.product_key)}
                    >
                      <div className="fuse-addon-check">
                        {isSelected ? (
                          <div className="fuse-checkmark">&#10003;</div>
                        ) : (
                          <div className="fuse-check-empty" />
                        )}
                      </div>
                      <div className="fuse-addon-info">
                        <div className="fuse-addon-name">
                          {addon.label}
                          {addon.gender_lock === 'female' && <span className="fuse-women-badge">Women Only</span>}
                        </div>
                        <div className="fuse-addon-desc">{addon.description}</div>
                      </div>
                      <div className="fuse-addon-price">
                        {addon.price === 0 ? 'FREE' : `$${addon.price.toLocaleString()}`}
                      </div>
                    </div>
                  )
                })}
              </div>

              <div className="fuse-nav-row">
                <button className="fuse-btn-back" onClick={() => goToStep(1)} type="button">
                  &#8592; Back
                </button>
                <button
                  className="fuse-btn-primary"
                  onClick={handleStep2Continue}
                  style={{ flex: 1 }}
                >
                  Review Order &#9733;
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ===== STEP 3: Review Order ===== */}
        {step === 3 && (
          <div className="fuse-step" key="step-3">
            <div className="fuse-parchment">
              <div className="fuse-card-title">Review Your Order</div>
              <div className="fuse-card-subtitle">Make sure everything looks right</div>
              <div className="fuse-title-rule"><span className="star">&#10022;</span></div>

              {/* Attendee info */}
              <div className="fuse-review-section">
                <div className="fuse-review-header">Attendee</div>
                <div className="fuse-review-row">
                  <span className="fuse-review-label">Name</span>
                  <span className="fuse-review-value">{firstName} {lastName}</span>
                </div>
                {preferredName && (
                  <div className="fuse-review-row">
                    <span className="fuse-review-label">Badge Name</span>
                    <span className="fuse-review-value">{preferredName}</span>
                  </div>
                )}
                <div className="fuse-review-row">
                  <span className="fuse-review-label">Email</span>
                  <span className="fuse-review-value">{email}</span>
                </div>
                <div className="fuse-review-row">
                  <span className="fuse-review-label">Phone</span>
                  <span className="fuse-review-value">{phone}</span>
                </div>
                <div className="fuse-review-row">
                  <span className="fuse-review-label">Company</span>
                  <span className="fuse-review-value">{company}</span>
                </div>
                <div className="fuse-review-row">
                  <span className="fuse-review-label">Gender</span>
                  <span className="fuse-review-value">{genderLabel(gender)}</span>
                </div>
                <div className="fuse-review-row">
                  <span className="fuse-review-label">Fuse Events Attended</span>
                  <span className="fuse-review-value">{fuseCountLabel(fuseCount)}</span>
                </div>
              </div>

              {/* Order summary */}
              <div className="fuse-review-section">
                <div className="fuse-review-header">Order Summary</div>

                {selectedTicket && (
                  <div className="fuse-order-line">
                    <span>{selectedTicket.label}{isEarlyBird ? ' (Early Bird)' : ''}</span>
                    <span className="fuse-order-line-price">${selectedTicket.price.toLocaleString()}</span>
                  </div>
                )}

                {addons.map((addon) => {
                  if (!addonState[addon.product_key]) return null
                  return (
                    <div key={addon.id} className="fuse-order-line">
                      <span>{addon.label}</span>
                      <span className="fuse-order-line-price">
                        {addon.price === 0 ? 'FREE' : `$${addon.price.toLocaleString()}`}
                      </span>
                    </div>
                  )
                })}

                <div className="fuse-order-total">
                  <span>Total</span>
                  <span className="fuse-order-total-price">${getTotal().toLocaleString()}</span>
                </div>
              </div>

              {errors.submit && <div className="fuse-error-banner">{errors.submit}</div>}

              <div className="fuse-nav-row">
                <button className="fuse-btn-back" onClick={() => goToStep(2)} type="button">
                  &#8592; Back
                </button>
                <button
                  className="fuse-btn-submit"
                  onClick={handleSubmit}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? 'Processing...' : 'Complete Registration ✦'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ===== SUCCESS ===== */}
        {step === 'success' && (
          <div className="fuse-step" key="step-success">
            <div className="fuse-success-wrap">
              <div className="fuse-success-parchment">
                <div className="fuse-success-longhorn">
                  <svg width="64" height="32" viewBox="0 0 64 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M32 28C32 28 28 20 20 16C12 12 2 14 0 16C2 12 12 4 24 8C28 9.5 30 12 32 16C34 12 36 9.5 40 8C52 4 62 12 64 16C62 14 52 12 44 16C36 20 32 28 32 28Z" fill="currentColor"/>
                  </svg>
                </div>
                <div className="fuse-success-icon">&#10003;</div>
                <div className="fuse-success-title">You&apos;re Registered!</div>
                <div className="fuse-success-text">A confirmation has been sent to</div>
                <div className="fuse-success-email">{email}</div>
                <div className="fuse-success-divider" />
                <div className="fuse-success-sub">
                  We&apos;ll see you in {event.location} at {event.name}.
                </div>
                <div className="fuse-success-divider" />
                <div className="fuse-success-amount-label">Order Total:</div>
                <div className="fuse-success-amount">${getTotal().toLocaleString()}</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Summary Strip (fixed bottom bar on step 2) */}
      {step === 2 && selectedTicketId && (
        <div className="fuse-summary-strip">
          <span className="fuse-summary-text">{getSummaryText()}</span>
          <span className="fuse-summary-total">${getTotal().toLocaleString()}</span>
        </div>
      )}
    </div>
  )
}
