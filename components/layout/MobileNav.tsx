'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Home,
  Brain,
  BookOpen,
  Handshake,
  Store,
  Calendar,
  Headphones,
  Settings as SettingsIcon
} from 'lucide-react'

interface MobileNavProps {
  userRole?: string
  fuseActiveEventYear?: number
  fuseActiveEventEndDate?: string | null
  fuseTicketClaimedYear?: number | null
  fuseVisible?: boolean
}

const navItems = [
  { name: 'Home', href: '/dashboard', icon: Home },
  { name: 'AIME AI', href: '/dashboard/aime-ai', icon: Brain },
  { name: 'Resources', href: '/dashboard/resources', icon: BookOpen },
  { name: 'Lenders', href: '/dashboard/lenders', icon: Handshake },
  { name: 'Market', href: '/dashboard/market', icon: Store },
  { name: 'Events', href: '/dashboard/events', icon: Calendar },
  { name: 'Support', href: '/dashboard/support', icon: Headphones },
  { name: 'Settings', href: '/dashboard/settings', icon: SettingsIcon },
]

// Navigation items visible to partner vendors and lenders
const PARTNER_NAV_ITEMS = ['Resources', 'Lenders', 'Market']

export default function MobileNav({
  userRole,
  fuseActiveEventYear,
  fuseActiveEventEndDate,
  fuseTicketClaimedYear,
  fuseVisible = true,
}: MobileNavProps) {
  const pathname = usePathname()

  // Check if user is a partner (vendor or lender)
  const isPartner = userRole === 'partner_vendor' || userRole === 'partner_lender'

  // Filter nav items for partners
  const filteredNavItems = isPartner
    ? navItems.filter(item => PARTNER_NAV_ITEMS.includes(item.name))
    : navItems

  const hasClaimed =
    !!fuseActiveEventYear &&
    fuseTicketClaimedYear === fuseActiveEventYear
  const showFuseLink =
    !isPartner &&
    fuseVisible &&
    hasClaimed &&
    !!fuseActiveEventEndDate &&
    new Date() <= new Date(`${fuseActiveEventEndDate}T23:59:59`)
  const fuseLinkActive = pathname === '/dashboard/fuse-registration'
  const colCount = isPartner ? 3 : (showFuseLink ? 9 : 8)

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-[#25314e] border-t border-white/10 z-50">
      <div className={`grid grid-cols-${colCount} h-16`} style={{ gridTemplateColumns: `repeat(${colCount}, minmax(0, 1fr))` }}>
        {showFuseLink && (
          <Link
            href="/dashboard/fuse-registration"
            className={`flex flex-col items-center justify-center gap-1 transition-colors ${
              fuseLinkActive ? 'ring-2 ring-[#202F60] ring-inset' : ''
            }`}
            style={{ background: '#ffffff' }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/assets/fuse/fuse-logo.png"
              alt=""
              className="h-5 w-auto"
            />
            <span className="text-[9px] font-bold uppercase tracking-wide" style={{ color: '#202F60' }}>
              {fuseActiveEventYear ? `Fuse ${fuseActiveEventYear}` : 'Fuse'}
            </span>
          </Link>
        )}
        {filteredNavItems.map((item) => {
          const Icon = item.icon
          const isActive = pathname === item.href

          return (
            <Link
              key={item.name}
              href={item.href}
              className={`flex flex-col items-center justify-center gap-1 transition-colors ${
                isActive
                  ? 'text-white'
                  : 'text-white/60 hover:text-white/80'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] font-medium">{item.name}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
