'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Edit, Trash2, Plus, ChevronLeft, ChevronRight, Users, Ticket, ChevronDown, ChevronUp, Download, CreditCard, Send, UserCheck, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import type { FuseEvent, FuseRegistration, FuseRegistrationGuest } from '@/types/database.types'
import { pickActivePrice } from '@/lib/fuse/pricing'
import { getFuseEligibility } from '@/lib/fuse/eligibility'

const PURCHASE_TYPE_LABELS: Record<string, string> = {
  claimed: 'Claimed (member benefit)',
  purchased: 'Purchased (paid)',
  pending: 'Pending payment',
  // Legacy label — GA Plus was retired for Fuse 2026 and admins can no
  // longer set 'upgraded' on new rows, but the badge still renders for
  // any historical rows in the DB.
  upgraded: 'Upgraded (legacy)',
}

const PURCHASE_TYPE_BADGE_CLASS: Record<string, string> = {
  claimed: 'bg-teal-100 text-teal-800',
  purchased: 'bg-yellow-100 text-yellow-800',
  pending: 'bg-orange-100 text-orange-800',
  upgraded: 'bg-purple-100 text-purple-800',
}

const STEP_COMPLETED_BADGE_CLASS: Record<string, string> = {
  claim: 'bg-orange-100 text-orange-800',
  finalized: 'bg-green-100 text-green-800',
}

interface FuseRegistrationManagerProps {
  events: FuseEvent[]
  initialRegistrations: FuseRegistration[]
  initialPagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

const TICKET_TYPE_LABELS: Record<string, string> = {
  general_admission: 'GA',
  vip: 'VIP',
  vip_guest: 'VIP Guest',
}

const TICKET_TYPE_COLORS: Record<string, string> = {
  general_admission: 'bg-green-100 text-green-800',
  vip: 'bg-purple-100 text-purple-800',
  vip_guest: 'bg-purple-50 text-purple-600',
}

const TIER_COLORS: Record<string, string> = {
  Premium: 'bg-blue-100 text-blue-800',
  Elite: 'bg-indigo-100 text-indigo-800',
  VIP: 'bg-purple-100 text-purple-800',
}

export function FuseRegistrationManager({
  events,
  initialRegistrations,
  initialPagination,
}: FuseRegistrationManagerProps) {
  const router = useRouter()
  const [registrations, setRegistrations] = useState(initialRegistrations)
  const [pagination, setPagination] = useState(initialPagination)
  const [isLoading, setIsLoading] = useState(false)

  // Filters
  const [selectedEventId, setSelectedEventId] = useState<string>(
    events.find(e => e.is_active)?.id || events[0]?.id || ''
  )
  const [searchTerm, setSearchTerm] = useState('')
  const [ticketTypeFilter, setTicketTypeFilter] = useState<string>('all')
  const [tierFilter, setTierFilter] = useState<string>('all')

  const selectedEvent = events.find(e => e.id === selectedEventId)

  // Accordion - track which rows are expanded (all expanded by default)
  const [collapsedRows, setCollapsedRows] = useState<Set<string>>(new Set())

  const toggleRow = (id: string) => {
    setCollapsedRows(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  // Compute ticket counts across all registrations + guests (for current page/filters).
  // Per-guest add-on flags are tallied alongside main-attendee flags so
  // each chip in the summary header reflects the full attendee count.
  const ticketCounts = React.useMemo(() => {
    const counts = {
      total: 0,
      ga: 0,
      gaPlus: 0,
      vip: 0,
      guests: 0,
      hallOfAime: 0,
      wmnAtFuse: 0,
      vettedVa: 0,
      vipLuncheon: 0,
    }
    for (const reg of registrations) {
      counts.total++
      if (reg.ticket_type === 'general_admission') counts.ga++
      else if (reg.ticket_type === 'vip') counts.vip++
      if (reg.has_hall_of_aime) counts.hallOfAime++
      if (reg.has_wmn_at_fuse) counts.wmnAtFuse++
      if ((reg as any).has_vetted_va) counts.vettedVa++
      if ((reg as any).has_vip_luncheon) counts.vipLuncheon++
      if (reg.guests) {
        for (const guest of reg.guests) {
          counts.total++
          counts.guests++
          if (guest.ticket_type === 'general_admission') counts.ga++
          else if (guest.ticket_type === 'vip') counts.vip++
          else if (guest.ticket_type === 'vip_guest') counts.vip++ // VIP guest counts as VIP for check-in
          const g = guest as any
          if (g.has_hall_of_aime) counts.hallOfAime++
          if (g.has_wmn_at_fuse) counts.wmnAtFuse++
          if (g.has_vetted_va) counts.vettedVa++
          if (g.has_vip_luncheon) counts.vipLuncheon++
        }
      }
    }
    return counts
  }, [registrations])

  // CSV Export — flat check-in list: one row per person.
  // Per-guest add-on columns mirror the main attendee columns so check-in
  // can scan a single row to know what each person is entitled to.
  const handleExportCSV = useCallback(() => {
    const rows: string[][] = []
    rows.push([
      'Role', 'Name', 'Email', 'Phone', 'Company', 'Ticket Type',
      'Tier', 'Purchase Type', 'Step', 'Included w/ VIP',
      'Hall of AIME', 'WMN at Fuse', 'Vetted VA', 'VIP Luncheon',
      'Primary Registrant', 'Primary Email', 'Source', 'Notes', 'Created At',
    ])

    let totalAttendees = 0

    for (const reg of registrations) {
      const r = reg as any
      // Primary registrant row
      totalAttendees++
      rows.push([
        'Primary',
        reg.full_name,
        reg.email,
        reg.phone || '',
        reg.company || '',
        TICKET_TYPE_LABELS[reg.ticket_type] || reg.ticket_type,
        reg.tier || 'N/A',
        reg.purchase_type,
        r.step_completed || '',
        '',
        reg.has_hall_of_aime ? 'Yes' : 'No',
        reg.has_wmn_at_fuse ? 'Yes' : 'No',
        r.has_vetted_va ? 'Yes' : 'No',
        r.has_vip_luncheon ? 'Yes' : 'No',
        '', // primary linked to self
        '',
        reg.registration_source || '',
        reg.notes || '',
        reg.created_at ? new Date(reg.created_at).toLocaleDateString() : '',
      ])

      // Guest rows — linked back to primary
      if (reg.guests) {
        for (const guest of reg.guests) {
          const g = guest as any
          totalAttendees++
          rows.push([
            'Guest',
            guest.full_name,
            guest.email || '',
            guest.phone || '',
            '', // guests don't have company
            TICKET_TYPE_LABELS[guest.ticket_type] || guest.ticket_type,
            '', // guests don't have tier
            '', // guests don't have purchase_type
            '', // guests don't have step_completed
            guest.is_included ? 'Yes' : 'No',
            g.has_hall_of_aime ? 'Yes' : 'No',
            g.has_wmn_at_fuse ? 'Yes' : 'No',
            g.has_vetted_va ? 'Yes' : 'No',
            g.has_vip_luncheon ? 'Yes' : 'No',
            reg.full_name, // linked to primary
            reg.email,
            '',
            '',
            guest.created_at ? new Date(guest.created_at).toLocaleDateString() : '',
          ])
        }
      }
    }

    const csvContent = rows
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n')

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    const eventName = selectedEvent?.name?.replace(/\s+/g, '-') || 'fuse'
    link.download = `${eventName}-checkin-${new Date().toISOString().split('T')[0]}.csv`
    link.click()
    URL.revokeObjectURL(url)
    toast.success(`Exported ${totalAttendees} attendees to CSV`)
  }, [registrations, selectedEvent])

  // Modals
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editingRegistration, setEditingRegistration] = useState<FuseRegistration | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [registrationToDelete, setRegistrationToDelete] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Member search
  const [memberSearch, setMemberSearch] = useState('')
  const [memberResults, setMemberResults] = useState<any[]>([])
  const [selectedMember, setSelectedMember] = useState<any>(null)
  const [isSearching, setIsSearching] = useState(false)

  // Debounced member search
  useEffect(() => {
    if (!memberSearch || memberSearch.length < 2) {
      setMemberResults([])
      return
    }
    setIsSearching(true)
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/fuse-registrations/member-search?q=${encodeURIComponent(memberSearch)}`)
        const data = await res.json()
        setMemberResults(data.members || [])
      } catch {
        setMemberResults([])
      } finally {
        setIsSearching(false)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [memberSearch])

  const selectMember = (member: any) => {
    setSelectedMember(member)
    setMemberSearch('')
    setMemberResults([])

    // Use the same eligibility rules the user-facing flows apply:
    //   - Annual eligible tier → claim (free entitled ticket)
    //   - Monthly Premium/Elite/VIP → buy (GA default; admin can flip)
    //   - Anyone else → manual purchase
    const eligibility = getFuseEligibility(
      member.plan_tier,
      member.billing_period,
    )

    const tier = eligibility.kind === 'claim'
      ? eligibility.planTier
      : eligibility.kind === 'buy'
      ? eligibility.planTier
      : ''
    const ticketType =
      eligibility.kind === 'claim' && eligibility.planTier === 'VIP'
        ? 'vip'
        : 'general_admission'
    const purchaseType =
      eligibility.kind === 'claim'
        ? 'claimed'
        : eligibility.kind === 'buy'
        ? 'pending'
        : 'purchased'
    const isVipClaim = eligibility.kind === 'claim' && eligibility.planTier === 'VIP'

    setFormData({
      ...formData,
      full_name: member.full_name || '',
      email: member.email || '',
      phone: member.phone || '',
      company: member.company || '',
      ticket_type: ticketType,
      tier,
      purchase_type: purchaseType,
      step_completed: 'claim',
      // VIP membership includes 2 HOA tickets (member + 1 guest).
      // Auto-populate both here so admin doesn't have to remember.
      has_hall_of_aime: isVipClaim,
      has_wmn_at_fuse: false,
      has_vetted_va: false,
      has_vip_luncheon: false,
      notes: formData.notes,
      guests: isVipClaim
        ? [
            blankGuest({
              ticket_type: 'vip_guest',
              is_included: true,
              has_hall_of_aime: true,
            }),
          ]
        : [],
    })
  }

  // Form data — guest rows carry the same 4 add-on flags as the
  // main registration; UI gates on the main row's flags so admins
  // can't grant a guest an add-on the main attendee doesn't have.
  type GuestRow = {
    full_name: string
    email: string
    phone: string
    ticket_type: string
    is_included: boolean
    has_hall_of_aime: boolean
    has_wmn_at_fuse: boolean
    has_vetted_va: boolean
    has_vip_luncheon: boolean
  }
  const blankGuest = (overrides: Partial<GuestRow> = {}): GuestRow => ({
    full_name: '',
    email: '',
    phone: '',
    ticket_type: 'general_admission',
    is_included: false,
    has_hall_of_aime: false,
    has_wmn_at_fuse: false,
    has_vetted_va: false,
    has_vip_luncheon: false,
    ...overrides,
  })
  const [formData, setFormData] = useState({
    full_name: '',
    email: '',
    phone: '',
    company: '',
    ticket_type: 'general_admission',
    tier: '',
    purchase_type: 'purchased',
    step_completed: 'claim' as 'claim' | 'finalized',
    has_hall_of_aime: false,
    has_wmn_at_fuse: false,
    has_vetted_va: false,
    has_vip_luncheon: false,
    notes: '',
    guests: [] as GuestRow[],
    // Admin override — when true, bypasses the server-side eligibility
    // gate (e.g. lets a monthly member be marked 'claimed' for a comp).
    skip_eligibility_check: false,
  })

  // Fetch registrations when filters change
  const fetchRegistrations = async (page = 1) => {
    setIsLoading(true)
    try {
      const params = new URLSearchParams({
        page: page.toString(),
        limit: '10',
      })

      if (selectedEventId) params.set('event_id', selectedEventId)
      if (searchTerm) params.set('search', searchTerm)
      if (ticketTypeFilter !== 'all') params.set('ticket_type', ticketTypeFilter)
      if (tierFilter !== 'all') params.set('tier', tierFilter)

      const response = await fetch(`/api/admin/fuse-registrations?${params}`)
      const data = await response.json()

      if (response.ok) {
        setRegistrations(data.registrations)
        setPagination(data.pagination)
      } else {
        toast.error(data.error || 'Failed to fetch registrations')
      }
    } catch (error) {
      toast.error('Failed to fetch registrations')
    } finally {
      setIsLoading(false)
    }
  }

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchRegistrations(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [selectedEventId, searchTerm, ticketTypeFilter, tierFilter])

  const handleOpenDialog = (registration?: FuseRegistration) => {
    if (registration) {
      setEditingRegistration(registration)
      setFormData({
        full_name: registration.full_name,
        email: registration.email,
        phone: registration.phone || '',
        company: registration.company || '',
        ticket_type: registration.ticket_type,
        tier: registration.tier || '',
        purchase_type: registration.purchase_type,
        step_completed:
          ((registration as any).step_completed as 'claim' | 'finalized') || 'claim',
        has_hall_of_aime: registration.has_hall_of_aime,
        has_wmn_at_fuse: registration.has_wmn_at_fuse,
        has_vetted_va: !!(registration as any).has_vetted_va,
        has_vip_luncheon: !!(registration as any).has_vip_luncheon,
        notes: registration.notes || '',
        guests:
          registration.guests?.map((g) =>
            blankGuest({
              full_name: g.full_name,
              email: g.email || '',
              phone: g.phone || '',
              ticket_type: g.ticket_type,
              is_included: g.is_included,
              has_hall_of_aime: !!(g as any).has_hall_of_aime,
              has_wmn_at_fuse: !!(g as any).has_wmn_at_fuse,
              has_vetted_va: !!(g as any).has_vetted_va,
              has_vip_luncheon: !!(g as any).has_vip_luncheon,
            }),
          ) || [],
        skip_eligibility_check: false,
      })
    } else {
      setEditingRegistration(null)
      setSelectedMember(null)
      setMemberSearch('')
      setFormData({
        full_name: '',
        email: '',
        phone: '',
        company: '',
        ticket_type: 'general_admission',
        tier: '',
        purchase_type: 'purchased',
        step_completed: 'claim',
        has_hall_of_aime: false,
        has_wmn_at_fuse: false,
        has_vetted_va: false,
        has_vip_luncheon: false,
        notes: '',
        guests: [],
        skip_eligibility_check: false,
      })
    }
    setIsDialogOpen(true)
  }

  const handleSubmit = async () => {
    if (!formData.full_name || !formData.email || !formData.ticket_type) {
      toast.error('Please fill in required fields (Name, Email, Ticket Type)')
      return
    }

    setIsSubmitting(true)

    try {
      const payload = {
        ...formData,
        fuse_event_id: selectedEventId,
        tier: formData.tier || null,
        user_id: selectedMember?.id || null,
      }

      const url = editingRegistration
        ? `/api/admin/fuse-registrations/${editingRegistration.id}`
        : '/api/admin/fuse-registrations'

      const response = await fetch(url, {
        method: editingRegistration ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const data = await response.json()

      if (response.ok) {
        toast.success(editingRegistration ? 'Registration updated!' : 'Registration created!')
        setIsDialogOpen(false)
        fetchRegistrations(pagination.page)
      } else {
        toast.error(data.error || 'Failed to save registration')
      }
    } catch (error) {
      toast.error('Failed to save registration')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDeleteClick = (id: string) => {
    setRegistrationToDelete(id)
    setDeleteDialogOpen(true)
  }

  const handleDeleteConfirm = async () => {
    if (!registrationToDelete) return

    try {
      const response = await fetch(`/api/admin/fuse-registrations/${registrationToDelete}`, {
        method: 'DELETE',
      })

      if (response.ok) {
        toast.success('Registration deleted')
        setDeleteDialogOpen(false)
        setRegistrationToDelete(null)
        fetchRegistrations(pagination.page)
      } else {
        const data = await response.json()
        toast.error(data.error || 'Failed to delete registration')
      }
    } catch (error) {
      toast.error('Failed to delete registration')
    }
  }

  // Build Stripe line items from current form state
  const buildLineItems = (): { price: string; quantity: number }[] => {
    // For now, return empty — Stripe line items will be built server-side
    // when we have the price IDs. The API handles the lookup.
    return []
  }

  // Stripe actions
  const handleCreateCheckout = async (registration: FuseRegistration) => {
    try {
      // Fetch prices for this event to build line items
      const pricesRes = await fetch(`/api/admin/fuse-events?include_prices=true&event_id=${selectedEventId}`)
      const pricesData = await pricesRes.json()
      const prices = pricesData.prices || []

      const lineItems: { price: string; quantity: number }[] = []

      // GA ticket (public price, phase-aware)
      const gaPrice = pickActivePrice(prices, 'ga', null)
      if (gaPrice?.stripe_price_id && registration.ticket_type === 'general_admission') {
        lineItems.push({ price: gaPrice.stripe_price_id, quantity: 1 })
      }

      // HOA — tier first, fall back to public; phase-aware
      if (registration.has_hall_of_aime) {
        const tier = registration.tier
        const tierHoa = pickActivePrice(prices, 'hoa', tier ?? null)
        const hoaPrice =
          (tierHoa && !tierHoa.is_included && tierHoa.stripe_price_id ? tierHoa : null)
          ?? pickActivePrice(prices, 'hoa', null)
        if (hoaPrice?.stripe_price_id) lineItems.push({ price: hoaPrice.stripe_price_id, quantity: 1 })
      }

      // Guest tickets
      const guestCount = registration.guests?.filter(g => !g.is_included).length || 0
      if (guestCount > 0) {
        const guestPrice = prices.find((p: any) => p.product_key === 'guest' && p.stripe_price_id)
        if (guestPrice) lineItems.push({ price: guestPrice.stripe_price_id, quantity: guestCount })
      }

      if (lineItems.length === 0) {
        toast.error('No paid items found for this registration')
        return
      }

      const response = await fetch('/api/admin/fuse-registrations/stripe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'checkout',
          registration_id: registration.id,
          line_items: lineItems,
        }),
      })

      const data = await response.json()
      if (!response.ok) throw new Error(data.error)

      window.open(data.checkout_url, '_blank')
    } catch (error: any) {
      toast.error(error.message || 'Failed to create checkout')
    }
  }

  const handleSendInvoice = async (registration: FuseRegistration) => {
    try {
      const pricesRes = await fetch(`/api/admin/fuse-events?include_prices=true&event_id=${selectedEventId}`)
      const pricesData = await pricesRes.json()
      const prices = pricesData.prices || []

      const lineItems: { price: string; quantity: number }[] = []

      // Same logic as checkout
      const gaPrice = prices.find((p: any) => p.product_key === 'ga' && !p.tier && p.stripe_price_id)
      if (gaPrice && registration.purchase_type === 'purchased') {
        lineItems.push({ price: gaPrice.stripe_price_id, quantity: 1 })
      }

      if (registration.has_hall_of_aime) {
        const tier = registration.tier
        const hoaPrice = prices.find((p: any) => p.product_key === 'hoa' && p.tier === tier && p.stripe_price_id && !p.is_included)
          || prices.find((p: any) => p.product_key === 'hoa' && !p.tier && p.stripe_price_id)
        if (hoaPrice) lineItems.push({ price: hoaPrice.stripe_price_id, quantity: 1 })
      }

      const guestCount = registration.guests?.filter(g => !g.is_included).length || 0
      if (guestCount > 0) {
        const guestPrice = prices.find((p: any) => p.product_key === 'guest' && p.stripe_price_id)
        if (guestPrice) lineItems.push({ price: guestPrice.stripe_price_id, quantity: guestCount })
      }

      if (lineItems.length === 0) {
        toast.error('No paid items to invoice')
        return
      }

      const response = await fetch('/api/admin/fuse-registrations/stripe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'invoice',
          registration_id: registration.id,
          line_items: lineItems,
        }),
      })

      const data = await response.json()
      if (!response.ok) throw new Error(data.error)

      await navigator.clipboard.writeText(data.payment_url)
      toast.success('Payment link copied to clipboard! Send it to the member.')
    } catch (error: any) {
      toast.error(error.message || 'Failed to create invoice')
    }
  }

  const handleClaimForMember = async (registration: FuseRegistration) => {
    try {
      const response = await fetch('/api/admin/fuse-registrations/stripe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'claim_for_member',
          registration_id: registration.id,
          member_email: registration.email,
        }),
      })

      const data = await response.json()
      if (!response.ok) throw new Error(data.error)

      toast.success(`Ticket claimed for ${registration.full_name}`)
      fetchRegistrations(pagination.page)
    } catch (error: any) {
      toast.error(error.message || 'Failed to claim for member')
    }
  }

  const addGuest = () => {
    setFormData({
      ...formData,
      guests: [...formData.guests, blankGuest()],
    })
  }

  const removeGuest = (index: number) => {
    setFormData({
      ...formData,
      guests: formData.guests.filter((_, i) => i !== index),
    })
  }

  const updateGuest = (index: number, field: string, value: string | boolean) => {
    const newGuests = [...formData.guests]
    newGuests[index] = { ...newGuests[index], [field]: value }
    setFormData({ ...formData, guests: newGuests })
  }

  return (
    <div className="bg-white rounded-lg shadow-md">
      {/* Header with filters */}
      <div className="p-6 border-b border-gray-200">
        <div className="flex flex-col gap-4">
          {/* Event selector and Add button */}
          <div className="flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
            <div className="flex items-center gap-4">
              <Select value={selectedEventId} onValueChange={setSelectedEventId}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="Select event" />
                </SelectTrigger>
                <SelectContent>
                  {events.map(event => (
                    <SelectItem key={event.id} value={event.id}>
                      {event.name} {event.is_active && '(Active)'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedEvent && (
                <Badge variant="outline" className="text-sm">
                  {selectedEvent.registration_open ? 'Registration Open' : 'Registration Closed'}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={handleExportCSV}
                disabled={registrations.length === 0}
                className="whitespace-nowrap"
              >
                <Download className="w-4 h-4 mr-2" />
                Export CSV
              </Button>
<Button
                onClick={() => handleOpenDialog()}
                className="bg-[#dd1969] hover:bg-[#c01559] whitespace-nowrap"
              >
                <Plus className="w-4 h-4 mr-2" />
                Add Registration
              </Button>
            </div>
          </div>

          {/* Search and filters */}
          <div className="flex flex-col md:flex-row gap-4">
            <Input
              placeholder="Search by name, email, or company..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full md:max-w-md"
            />
            <Select value={ticketTypeFilter} onValueChange={setTicketTypeFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All Ticket Types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Ticket Types</SelectItem>
                <SelectItem value="general_admission">General Admission</SelectItem>
                <SelectItem value="vip">VIP</SelectItem>
              </SelectContent>
            </Select>
            <Select value={tierFilter} onValueChange={setTierFilter}>
              <SelectTrigger className="w-[150px]">
                <SelectValue placeholder="All Tiers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Tiers</SelectItem>
                <SelectItem value="Premium">Premium</SelectItem>
                <SelectItem value="Elite">Elite</SelectItem>
                <SelectItem value="VIP">VIP</SelectItem>
                <SelectItem value="public">Public (N/A)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* Ticket Count Summary */}
      {registrations.length > 0 && (
        <div className="px-6 py-3 border-b border-gray-200 bg-gray-50/50">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium text-gray-700">
              <Ticket className="w-4 h-4 inline mr-1" />
              {ticketCounts.total} total attendees
            </span>
            <span className="text-gray-300">|</span>
            <Badge className="bg-green-100 text-green-800">{ticketCounts.ga} GA</Badge>
            <Badge className="bg-purple-100 text-purple-800">{ticketCounts.vip} VIP</Badge>
            <span className="text-gray-300">|</span>
            <span className="text-gray-500">
              <Users className="w-3.5 h-3.5 inline mr-1" />
              {ticketCounts.guests} guests
            </span>
            {ticketCounts.hallOfAime > 0 && (
              <Badge className="bg-amber-100 text-amber-800">{ticketCounts.hallOfAime} Hall of AIME</Badge>
            )}
            {ticketCounts.wmnAtFuse > 0 && (
              <Badge className="bg-pink-100 text-pink-800">{ticketCounts.wmnAtFuse} WMN</Badge>
            )}
            {ticketCounts.vettedVa > 0 && (
              <Badge className="bg-emerald-100 text-emerald-800">{ticketCounts.vettedVa} Vetted VA</Badge>
            )}
            {ticketCounts.vipLuncheon > 0 && (
              <Badge className="bg-purple-100 text-purple-800">{ticketCounts.vipLuncheon} VIP Luncheon</Badge>
            )}
          </div>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Name
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Email
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Company
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Ticket
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Tier
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Add-ons
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Type
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Guests
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {isLoading ? (
              <tr>
                <td colSpan={9} className="px-6 py-8 text-center text-gray-500">
                  Loading...
                </td>
              </tr>
            ) : registrations.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-6 py-8 text-center text-gray-500">
                  No registrations found
                </td>
              </tr>
            ) : (
              registrations.map((registration) => {
                const hasGuests = registration.guests && registration.guests.length > 0
                const isExpanded = hasGuests && !collapsedRows.has(registration.id)

                return (
                  <React.Fragment key={registration.id}>
                    <tr className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900">{registration.full_name}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-500">{registration.email}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-500">{registration.company || '-'}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <Badge className={TICKET_TYPE_COLORS[registration.ticket_type]}>
                          {TICKET_TYPE_LABELS[registration.ticket_type]}
                        </Badge>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {registration.tier ? (
                          <Badge className={TIER_COLORS[registration.tier]}>
                            {registration.tier}
                          </Badge>
                        ) : (
                          <Badge className="bg-gray-100 text-gray-600">N/A</Badge>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex flex-col gap-1">
                          {registration.has_hall_of_aime && (
                            <Badge className="bg-amber-100 text-amber-800 text-xs">Hall of AIME</Badge>
                          )}
                          {registration.has_wmn_at_fuse && (
                            <Badge className="bg-pink-100 text-pink-800 text-xs">WMN at Fuse</Badge>
                          )}
                          {(registration as any).has_vetted_va && (
                            <Badge className="bg-emerald-100 text-emerald-800 text-xs">Vetted VA</Badge>
                          )}
                          {(registration as any).has_vip_luncheon && (
                            <Badge className="bg-purple-100 text-purple-800 text-xs">VIP Luncheon</Badge>
                          )}
                          {!registration.has_hall_of_aime &&
                            !registration.has_wmn_at_fuse &&
                            !(registration as any).has_vetted_va &&
                            !(registration as any).has_vip_luncheon && (
                            <span className="text-sm text-gray-400">-</span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex flex-col gap-1">
                          <Badge
                            className={
                              PURCHASE_TYPE_BADGE_CLASS[registration.purchase_type] ||
                              'bg-gray-100 text-gray-800'
                            }
                          >
                            {PURCHASE_TYPE_LABELS[registration.purchase_type] ||
                              registration.purchase_type}
                          </Badge>
                          {(registration as any).step_completed && (
                            <Badge
                              className={`text-xs ${
                                STEP_COMPLETED_BADGE_CLASS[
                                  (registration as any).step_completed
                                ] || 'bg-gray-100 text-gray-700'
                              }`}
                            >
                              {(registration as any).step_completed === 'finalized'
                                ? 'Finalized'
                                : 'Claim'}
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {hasGuests ? (
                          <button
                            onClick={() => toggleRow(registration.id)}
                            className="flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900 transition-colors"
                          >
                            <Users className="w-4 h-4 text-gray-400" />
                            <span>{registration.guests!.length}</span>
                            {isExpanded ? (
                              <ChevronUp className="w-3.5 h-3.5 text-gray-400" />
                            ) : (
                              <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
                            )}
                          </button>
                        ) : (
                          <span className="text-sm text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleOpenDialog(registration)}
                            className="text-blue-600 hover:text-blue-900 hover:bg-blue-50"
                          >
                            <Edit className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteClick(registration.id)}
                            className="text-red-600 hover:text-red-900 hover:bg-red-50"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {/* Guest accordion rows */}
                    {isExpanded && registration.guests!.map((guest, gIdx) => {
                      const g = guest as any
                      const guestAddons = [
                        g.has_hall_of_aime && 'HOA',
                        g.has_wmn_at_fuse && 'WMN',
                        g.has_vetted_va && 'Vetted VA',
                        g.has_vip_luncheon && 'VIP Luncheon',
                      ].filter(Boolean) as string[]
                      return (
                        <tr key={`${registration.id}-guest-${gIdx}`} className="bg-gray-50/70">
                          <td className="px-6 py-2.5 whitespace-nowrap">
                            <div className="flex items-center gap-2 pl-4">
                              <span className="text-gray-300">└</span>
                              <span className="text-sm text-gray-600">{guest.full_name}</span>
                            </div>
                          </td>
                          <td className="px-6 py-2.5 whitespace-nowrap">
                            <span className="text-sm text-gray-400">{guest.email || '-'}</span>
                          </td>
                          <td className="px-6 py-2.5 whitespace-nowrap">
                            <span className="text-sm text-gray-400">{guest.phone || '-'}</span>
                          </td>
                          <td className="px-6 py-2.5 whitespace-nowrap">
                            <Badge className={`${TICKET_TYPE_COLORS[guest.ticket_type] || 'bg-gray-100 text-gray-600'} text-xs`}>
                              {TICKET_TYPE_LABELS[guest.ticket_type] || guest.ticket_type}
                            </Badge>
                          </td>
                          <td className="px-6 py-2.5 whitespace-nowrap">
                            {guest.is_included ? (
                              <Badge className="bg-teal-50 text-teal-700 text-xs">Included</Badge>
                            ) : (
                              <Badge className="bg-yellow-50 text-yellow-700 text-xs">Purchased</Badge>
                            )}
                          </td>
                          <td className="px-6 py-2.5 whitespace-nowrap" colSpan={4}>
                            {guestAddons.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {guestAddons.map((label) => (
                                  <Badge
                                    key={label}
                                    className="bg-amber-50 text-amber-700 text-[10px] font-normal"
                                  >
                                    {label}
                                  </Badge>
                                ))}
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      )
                    })}
                  </React.Fragment>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pagination.total > 0 && (
        <div className="p-4 border-t border-gray-200">
          <div className="flex items-center justify-between">
            <div className="text-sm text-gray-600">
              Showing{' '}
              <span className="font-semibold">
                {(pagination.page - 1) * pagination.limit + 1}-
                {Math.min(pagination.page * pagination.limit, pagination.total)}
              </span>{' '}
              of <span className="font-semibold">{pagination.total}</span> registrations
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchRegistrations(pagination.page - 1)}
                disabled={pagination.page === 1}
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </Button>
              <span className="text-sm text-gray-600">
                Page {pagination.page} of {pagination.totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchRegistrations(pagination.page + 1)}
                disabled={pagination.page === pagination.totalPages}
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingRegistration ? 'Edit Registration' : 'Add New Registration'}
            </DialogTitle>
            <DialogDescription>
              {editingRegistration
                ? 'Update registration details'
                : 'Manually add a new Fuse registration'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Member Lookup — only for new registrations */}
            {!editingRegistration && (
              <div className="space-y-2 pb-4 border-b">
                <Label>Link to AMP Member</Label>
                {selectedMember ? (
                  <div className="flex items-center justify-between bg-teal-50 border border-teal-200 rounded-lg p-3">
                    <div>
                      <div className="text-sm font-medium text-teal-900">{selectedMember.full_name}</div>
                      <div className="text-xs text-teal-600">
                        {selectedMember.email}
                        {selectedMember.plan_tier ? ` • ${selectedMember.plan_tier}` : ''}
                        {selectedMember.billing_period
                          ? ` • ${selectedMember.billing_period.toLowerCase() === 'annual' ? 'Annual' : 'Monthly'}`
                          : ''}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setSelectedMember(null)
                        setFormData({
                          ...formData,
                          full_name: '',
                          email: '',
                          phone: '',
                          company: '',
                          tier: '',
                          ticket_type: 'general_admission',
                          purchase_type: 'purchased',
                          step_completed: 'claim',
                          has_hall_of_aime: false,
                          has_wmn_at_fuse: false,
                          has_vetted_va: false,
                          has_vip_luncheon: false,
                          guests: [],
                        })
                      }}
                      className="text-teal-600 hover:text-teal-900"
                    >
                      Change
                    </Button>
                  </div>
                ) : (
                  <div className="relative">
                    <Input
                      placeholder="Search by name, email, or company..."
                      value={memberSearch}
                      onChange={(e) => setMemberSearch(e.target.value)}
                    />
                    {memberResults.length > 0 && (
                      <div className="absolute z-50 mt-1 w-full bg-white border rounded-lg shadow-lg max-h-48 overflow-y-auto">
                        {memberResults.map((m) => (
                          <button
                            key={m.id}
                            className="w-full text-left px-3 py-2 hover:bg-gray-50 border-b last:border-b-0 transition-colors"
                            onClick={() => selectMember(m)}
                          >
                            <div className="text-sm font-medium text-gray-900">{m.full_name || m.email}</div>
                            <div className="text-xs text-gray-500">
                              {m.email}
                              {m.plan_tier ? ` • ${m.plan_tier}` : ''}
                              {m.billing_period
                                ? ` • ${m.billing_period.toLowerCase() === 'annual' ? 'Annual' : 'Monthly'}`
                                : ''}
                              {m.company ? ` • ${m.company}` : ''}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                    {isSearching && (
                      <div className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400">Searching...</div>
                    )}
                    <p className="text-xs text-gray-400 mt-1">Search to link this registration to an AMP member, or leave blank for manual entry</p>
                  </div>
                )}
              </div>
            )}

            {/* Basic Info */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="full_name">Full Name *</Label>
                <Input
                  id="full_name"
                  value={formData.full_name}
                  onChange={(e) => setFormData({ ...formData, full_name: e.target.value })}
                  placeholder="John Doe"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email *</Label>
                <Input
                  id="email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  placeholder="john@example.com"
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="phone">Phone</Label>
                <Input
                  id="phone"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  placeholder="(555) 123-4567"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="company">Company</Label>
                <Input
                  id="company"
                  value={formData.company}
                  onChange={(e) => setFormData({ ...formData, company: e.target.value })}
                  placeholder="Company Name"
                />
              </div>
            </div>

            {/* Ticket Info */}
            <div className="border-t pt-4">
              <h3 className="font-semibold text-gray-900 mb-4">Ticket Information</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="ticket_type">Ticket Type *</Label>
                  <Select
                    value={formData.ticket_type}
                    onValueChange={(value) => setFormData({ ...formData, ticket_type: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select ticket type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="general_admission">General Admission</SelectItem>
                      <SelectItem value="vip">VIP</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="tier">Member Tier</Label>
                  <Select
                    value={formData.tier || 'none'}
                    onValueChange={(value) => setFormData({ ...formData, tier: value === 'none' ? '' : value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="N/A (Public)" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">N/A (Public)</SelectItem>
                      <SelectItem value="Premium">Premium</SelectItem>
                      <SelectItem value="Elite">Elite</SelectItem>
                      <SelectItem value="VIP">VIP</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Eligibility override — admin escape hatch for comp tickets,
                  legacy fixes, etc. Defaults off; API enforces normally. */}
              <div className="mt-4 flex items-start justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 p-3">
                <div>
                  <Label htmlFor="skip_eligibility_check" className="text-sm font-semibold text-amber-900">
                    Override eligibility check
                  </Label>
                  <p className="text-xs text-amber-700 mt-0.5">
                    Lets you mark a non-annual member as claimed (comp tickets,
                    sponsor seats, etc.). API gating is bypassed when on.
                  </p>
                </div>
                <Switch
                  id="skip_eligibility_check"
                  checked={formData.skip_eligibility_check}
                  onCheckedChange={(checked) =>
                    setFormData({ ...formData, skip_eligibility_check: checked })
                  }
                />
              </div>

              {editingRegistration && (
                <div className="mt-4 grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="purchase_type">Purchase Type</Label>
                    <Select
                      value={formData.purchase_type}
                      onValueChange={(value) => setFormData({ ...formData, purchase_type: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select purchase type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="claimed">Claimed (member benefit)</SelectItem>
                        <SelectItem value="purchased">Purchased (paid)</SelectItem>
                        <SelectItem value="pending">Pending payment</SelectItem>
                        {/* 'upgraded' is read-only at this point — GA Plus was
                            retired for Fuse 2026. Historical rows still render
                            their badge in the table. */}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="step_completed">Step Completed</Label>
                    <Select
                      value={formData.step_completed}
                      onValueChange={(value) =>
                        setFormData({ ...formData, step_completed: value as 'claim' | 'finalized' })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select step" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="claim">Claim (reserved / awaiting payment)</SelectItem>
                        <SelectItem value="finalized">Finalized (paid / locked)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
            </div>

            {/* Add-ons */}
            <div className="border-t pt-4">
              <h3 className="font-semibold text-gray-900 mb-4">Add-ons (main attendee)</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="has_hall_of_aime">Hall of AIME</Label>
                    <p className="text-sm text-gray-500">
                      Paid add-on (VIP members get this free).
                    </p>
                  </div>
                  <Switch
                    id="has_hall_of_aime"
                    checked={formData.has_hall_of_aime}
                    onCheckedChange={(checked) =>
                      setFormData({ ...formData, has_hall_of_aime: checked })
                    }
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="has_wmn_at_fuse">WMN at Fuse</Label>
                    <p className="text-sm text-gray-500">Free — women only</p>
                  </div>
                  <Switch
                    id="has_wmn_at_fuse"
                    checked={formData.has_wmn_at_fuse}
                    onCheckedChange={(checked) =>
                      setFormData({ ...formData, has_wmn_at_fuse: checked })
                    }
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="has_vetted_va">Vetted VA Summit</Label>
                    <p className="text-sm text-gray-500">Free for any ticket holder</p>
                  </div>
                  <Switch
                    id="has_vetted_va"
                    checked={formData.has_vetted_va}
                    onCheckedChange={(checked) =>
                      setFormData({ ...formData, has_vetted_va: checked })
                    }
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label htmlFor="has_vip_luncheon">VIP Luncheon</Label>
                    <p className="text-sm text-gray-500">
                      Free; requires VIP ticket
                    </p>
                  </div>
                  <Switch
                    id="has_vip_luncheon"
                    checked={formData.has_vip_luncheon}
                    onCheckedChange={(checked) =>
                      setFormData({ ...formData, has_vip_luncheon: checked })
                    }
                  />
                </div>
              </div>
            </div>

            {/* Guests */}
            <div className="border-t pt-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-900">Guests</h3>
                <Button type="button" variant="outline" size="sm" onClick={addGuest}>
                  <Plus className="w-4 h-4 mr-1" />
                  Add Guest
                </Button>
              </div>
              {formData.guests.length === 0 ? (
                <p className="text-sm text-gray-500">No guests added</p>
              ) : (
                <div className="space-y-4">
                  {formData.guests.map((guest, index) => {
                    const guestAddonGates: Array<{
                      key: 'has_hall_of_aime' | 'has_wmn_at_fuse' | 'has_vetted_va' | 'has_vip_luncheon'
                      label: string
                      enabled: boolean
                    }> = [
                      {
                        key: 'has_hall_of_aime',
                        label: 'Hall of AIME',
                        enabled: formData.has_hall_of_aime,
                      },
                      {
                        key: 'has_wmn_at_fuse',
                        label: 'WMN at Fuse',
                        enabled: formData.has_wmn_at_fuse,
                      },
                      {
                        key: 'has_vetted_va',
                        label: 'Vetted VA',
                        enabled: formData.has_vetted_va,
                      },
                      {
                        key: 'has_vip_luncheon',
                        label: 'VIP Luncheon',
                        enabled: formData.has_vip_luncheon,
                      },
                    ]
                    return (
                      <div key={index} className="border rounded-lg p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-sm">Guest {index + 1}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => removeGuest(index)}
                            className="text-red-600 hover:text-red-900"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <Input
                            placeholder="Guest Name *"
                            value={guest.full_name}
                            onChange={(e) => updateGuest(index, 'full_name', e.target.value)}
                          />
                          <Input
                            placeholder="Guest Email"
                            type="email"
                            value={guest.email}
                            onChange={(e) => updateGuest(index, 'email', e.target.value)}
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <Select
                            value={guest.ticket_type}
                            onValueChange={(value) => updateGuest(index, 'ticket_type', value)}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Ticket Type" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="vip_guest">VIP Guest (Included)</SelectItem>
                              <SelectItem value="general_admission">General Admission</SelectItem>
                              <SelectItem value="vip">VIP</SelectItem>
                            </SelectContent>
                          </Select>
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={guest.is_included}
                              onCheckedChange={(checked) =>
                                updateGuest(index, 'is_included', checked)
                              }
                            />
                            <Label className="text-sm">Included with VIP</Label>
                          </div>
                        </div>
                        {/* Per-guest add-ons — disabled when the main
                            attendee doesn't carry the flag, since the
                            server-side gate would strip the value anyway. */}
                        <div>
                          <p className="text-xs uppercase tracking-wide text-gray-500 mb-1.5">
                            Add-ons
                          </p>
                          <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-gray-700">
                            {guestAddonGates.map((gate) => (
                              <label
                                key={gate.key}
                                className={`inline-flex items-center gap-1.5 ${
                                  gate.enabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
                                }`}
                                title={
                                  gate.enabled
                                    ? ''
                                    : `Enable ${gate.label} on the main attendee first.`
                                }
                              >
                                <input
                                  type="checkbox"
                                  className="h-3.5 w-3.5"
                                  checked={gate.enabled && (guest as any)[gate.key]}
                                  disabled={!gate.enabled}
                                  onChange={() =>
                                    gate.enabled && updateGuest(index, gate.key, !(guest as any)[gate.key])
                                  }
                                />
                                {gate.label}
                              </label>
                            ))}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* Notes */}
            <div className="border-t pt-4">
              <div className="space-y-2">
                <Label htmlFor="notes">Admin Notes</Label>
                <Textarea
                  id="notes"
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  placeholder="Internal notes about this registration..."
                  rows={3}
                />
              </div>
            </div>

            {/* Actions */}
            <div className="pt-4 border-t space-y-2">
              {editingRegistration ? (
                /* Edit mode — simple save */
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setIsDialogOpen(false)}
                    disabled={isSubmitting}
                    className="flex-1"
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleSubmit}
                    disabled={isSubmitting}
                    className="flex-1 bg-[#dd1969] hover:bg-[#c01559]"
                  >
                    {isSubmitting ? 'Saving...' : 'Update Registration'}
                  </Button>
                </div>
              ) : (
                /* Create mode — three action buttons */
                <>
                  {/* Claim — only if linked to an eligible member */}
                  <Button
                    onClick={() => {
                      setFormData({ ...formData, purchase_type: 'claimed' })
                      setTimeout(handleSubmit, 0)
                    }}
                    disabled={isSubmitting}
                    className="w-full bg-green-700 hover:bg-green-800 text-white"
                  >
                    <UserCheck className="w-4 h-4 mr-2" />
                    {isSubmitting ? 'Processing...' : 'Claim Ticket'}
                  </Button>

                  <div className="flex gap-2">
                    <Button
                      onClick={async () => {
                        setFormData({ ...formData, purchase_type: 'purchased' })
                        // Create registration first, then open Stripe checkout
                        setIsSubmitting(true)
                        try {
                          const payload = {
                            ...formData,
                            purchase_type: 'purchased',
                            fuse_event_id: selectedEventId,
                            tier: formData.tier || null,
                            user_id: selectedMember?.id || null,
                          }
                          const res = await fetch('/api/admin/fuse-registrations', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload),
                          })
                          const data = await res.json()
                          if (!res.ok) throw new Error(data.error)

                          // Now create Stripe checkout
                          const stripeRes = await fetch('/api/admin/fuse-registrations/stripe', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              action: 'checkout',
                              registration_id: data.registration.id,
                              line_items: buildLineItems(),
                            }),
                          })
                          const stripeData = await stripeRes.json()
                          if (stripeRes.ok && stripeData.checkout_url) {
                            window.open(stripeData.checkout_url, '_blank')
                          }

                          toast.success('Registration created! Stripe checkout opened.')
                          setIsDialogOpen(false)
                          fetchRegistrations(pagination.page)
                        } catch (error: any) {
                          toast.error(error.message || 'Failed')
                        } finally {
                          setIsSubmitting(false)
                        }
                      }}
                      disabled={isSubmitting}
                      className="flex-1 bg-amber-700 hover:bg-amber-800 text-white"
                    >
                      <CreditCard className="w-4 h-4 mr-2" />
                      {isSubmitting ? 'Processing...' : 'Checkout & Pay'}
                    </Button>

                    <Button
                      onClick={async () => {
                        setFormData({ ...formData, purchase_type: 'purchased' })
                        setIsSubmitting(true)
                        try {
                          const payload = {
                            ...formData,
                            purchase_type: 'purchased',
                            fuse_event_id: selectedEventId,
                            tier: formData.tier || null,
                            user_id: selectedMember?.id || null,
                          }
                          const res = await fetch('/api/admin/fuse-registrations', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload),
                          })
                          const data = await res.json()
                          if (!res.ok) throw new Error(data.error)

                          // Create payment link
                          const stripeRes = await fetch('/api/admin/fuse-registrations/stripe', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              action: 'invoice',
                              registration_id: data.registration.id,
                              line_items: buildLineItems(),
                            }),
                          })
                          const stripeData = await stripeRes.json()
                          if (stripeRes.ok && stripeData.payment_url) {
                            await navigator.clipboard.writeText(stripeData.payment_url)
                            toast.success('Registration created! Payment link copied to clipboard.')
                          } else {
                            toast.success('Registration created!')
                          }

                          setIsDialogOpen(false)
                          fetchRegistrations(pagination.page)
                        } catch (error: any) {
                          toast.error(error.message || 'Failed')
                        } finally {
                          setIsSubmitting(false)
                        }
                      }}
                      disabled={isSubmitting}
                      variant="outline"
                      className="flex-1"
                    >
                      <Send className="w-4 h-4 mr-2" />
                      {isSubmitting ? 'Processing...' : 'Send Payment Link'}
                    </Button>
                  </div>

                  <Button
                    variant="ghost"
                    onClick={() => setIsDialogOpen(false)}
                    disabled={isSubmitting}
                    className="w-full text-gray-500"
                  >
                    Cancel
                  </Button>
                </>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the registration and all
              associated guest records.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
