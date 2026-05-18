/**
 * Fuse visibility kill switch.
 *
 * While `FUSE_LIVE` is anything other than `'true'`, every user-facing
 * Fuse surface (top banner, sidebar link, dashboard registration page,
 * onboarding wedge, payment API routes) is admin-only. Admins always
 * pass so they can test in a live-production environment before flipping
 * the switch.
 *
 * To go live: set `FUSE_LIVE=true` in the runtime env. No deploy needed —
 * Next reads `process.env.*` per-request in server components / route
 * handlers.
 */
export function isFuseLive(): boolean {
  return process.env.FUSE_LIVE === 'true'
}

export function canSeeFuse(isAdmin: boolean | null | undefined): boolean {
  return !!isAdmin || isFuseLive()
}
