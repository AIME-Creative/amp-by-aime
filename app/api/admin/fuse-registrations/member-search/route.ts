import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.get('q') || ''

  if (query.trim().length < 2) {
    return NextResponse.json({ members: [] })
  }

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

  const searchTerm = `%${query.toLowerCase()}%`

  // billing_period is needed so the admin UI can auto-fill the right
  // purchase_type via getFuseEligibility (annual eligible → claimed,
  // monthly Premium/Elite/VIP → purchased/pending).
  const { data: members } = await supabase
    .from('profiles')
    .select('id, full_name, email, phone, company, plan_tier, billing_period, subscription_override, fuse_ticket_claimed_year')
    .or(`full_name.ilike.${searchTerm},email.ilike.${searchTerm},company.ilike.${searchTerm}`)
    .order('full_name')
    .limit(10)

  return NextResponse.json({ members: members || [] })
}
