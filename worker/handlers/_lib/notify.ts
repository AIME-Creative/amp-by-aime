// AIME-14: helper to invoke the existing send-subscription-notification
// Edge Function the same way the legacy EF and the legacy Next.js route
// do. Centralised so all handlers send the same shape and so the
// network call is easy to mock in tests.

export type NotifyType = 'upgrade' | 'downgrade' | 'cancellation';

export interface NotifyPayload {
  type: NotifyType;
  userEmail: string;
  userName: string | null;
  fromTier: string | null;
  toTier: string;
}

export async function sendSubscriptionNotification(
  payload: NotifyPayload,
): Promise<void> {
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) {
    // Don't throw — the email is a courtesy, not load-bearing.
    console.warn('[notify] missing env, skipping email send');
    return;
  }
  try {
    await fetch(`${baseUrl}/functions/v1/send-subscription-notification`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.warn('[notify] email send failed (non-fatal):', err);
  }
}
