import { NextRequest, NextResponse } from 'next/server'

// In-memory rate limiter (per IP, resets on deploy)
const attempts = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT = 5 // max signups per window
const RATE_WINDOW = 60 * 60 * 1000 // 1 hour

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = attempts.get(ip)

  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + RATE_WINDOW })
    return false
  }

  entry.count++
  return entry.count > RATE_LIMIT
}

// Gibberish detector — real names are pronounceable, bot names aren't
function isGibberishName(name: string): boolean {
  const trimmed = name.trim()
  if (!trimmed) return true

  const parts = trimmed.split(/\s+/)

  // Real names have at least first + last
  if (parts.length < 2) return true

  for (const part of parts) {
    // Too long for a real name part
    if (part.length > 20) return true

    // Mostly uppercase interior letters (e.g. "kCUKAFVmmguyflwGPODp")
    const interior = part.slice(1)
    if (interior.length > 3) {
      const uppercaseRatio = (interior.match(/[A-Z]/g)?.length || 0) / interior.length
      if (uppercaseRatio > 0.4) return true
    }

    // No vowels = not a real name
    if (part.length > 3 && !/[aeiouAEIOU]/.test(part)) return true

    // Excessive consonant clusters (4+ consonants in a row)
    if (/[^aeiouAEIOU\s]{5,}/i.test(part)) return true
  }

  return false
}

// Suspicious email pattern detector
function isSuspiciousEmail(email: string): boolean {
  const local = email.split('@')[0] || ''
  const domain = email.split('@')[1] || ''

  // Dotted gmail pattern: a.b.c.d.e.f.1.2@gmail.com (4+ dots in local part for gmail)
  if (domain === 'gmail.com') {
    const dotCount = (local.match(/\./g) || []).length
    if (dotCount >= 4) return true
  }

  // Local part ends with digits after dots: a.b.c123@gmail.com
  if (/\.\d{2,}@/.test(email)) return true

  return false
}

export async function POST(request: NextRequest) {
  try {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || request.headers.get('x-real-ip')
      || 'unknown'

    // Rate limit check. Skipped in dev so repeated test sign-ups don't
    // get throttled. Prod (NODE_ENV='production') enforces normally.
    const isDev = process.env.NODE_ENV !== 'production'
    if (!isDev && isRateLimited(ip)) {
      return NextResponse.json(
        { success: false, error: 'Too many signup attempts. Please try again later.' },
        { status: 429 }
      )
    }

    const { fullName, email } = await request.json()

    const reasons: string[] = []

    if (isGibberishName(fullName || '')) {
      reasons.push('name')
    }

    if (isSuspiciousEmail(email || '')) {
      reasons.push('email')
    }

    // Block if BOTH signals fire (reduces false positives)
    if (reasons.length >= 2) {
      console.warn(`Blocked suspected bot signup: ${email} (${fullName}) [${reasons.join(', ')}]`)
      return NextResponse.json(
        { success: false, error: 'Unable to create account. Please contact support.' },
        { status: 403 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Signup verification error:', error)
    // Fail open — don't block real users if verification crashes
    return NextResponse.json({ success: true })
  }
}
