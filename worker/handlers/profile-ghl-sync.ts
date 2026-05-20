// AIME-15: Supabase profile → GHL contact upsert handler.
//
// Reconcile-from-source: the receiver only forwards the profile id;
// we refetch the row from Supabase here so the GHL state always
// reflects whatever Supabase says right now (not a stale snapshot
// from when the trigger fired).
//
// Business logic ported faithfully from the legacy
// supabase/functions/sync-profile-ghl/index.ts:
//   - Search GHL contact by email first, fall back to phone
//   - PUT-update if found, POST-create otherwise
//   - On 429: inline retry with 1s / 2s / 4s backoff, max 3 attempts
//   - On 400 + matchingField=phone duplicate: retry update without phone
//   - On create-time duplicate (meta.contactId present): update that
//     contact instead of failing
//
// Field mapping itself lives in lib/sync/ghl-mapping.ts.

import type { Job } from 'pg-boss';
import {
  getEventById,
  getSupabaseAdmin,
  markFailed,
  markProcessed,
  markProcessing,
  type QueueJobData,
} from '../../lib/sync';
import {
  buildGHLContactPayload,
  toUpdatePayload,
  type ProfileForGHL,
} from '../../lib/sync/ghl-mapping';

const GHL_API_URL = 'https://services.leadconnectorhq.com';
const PROFILE_SELECT =
  'id, email, full_name, first_name, last_name, phone, address, city, state, zip_code, ' +
  'company, company_nmls, birthday, role, state_licenses, race, gender, plan_tier, ' +
  'billing_period, payment_amount, scotsman_guide_subscription, ' +
  'scotsman_guide_subscription_date, stripe_customer_id, subscription_status';

interface PayloadShape {
  op: 'INSERT' | 'UPDATE';
  profile_id: string;
}

export async function handleProfileGhlSync(
  jobs: Job<QueueJobData>[],
): Promise<void> {
  for (const job of jobs) {
    await processOne(job.data.sync_event_id);
  }
}

async function processOne(syncEventId: string): Promise<void> {
  const db = getSupabaseAdmin();
  const event = await getEventById(db, syncEventId);
  if (!event) {
    throw new Error(`sync_events row ${syncEventId} not found`);
  }
  if (event.status === 'processed') return;

  await markProcessing(db, syncEventId);

  try {
    const payload = event.payload as PayloadShape;
    if (!payload?.profile_id) {
      throw new Error(`profile-ghl-sync: missing profile_id in payload`);
    }

    // Reconcile from source: refetch the profile row.
    const { data, error } = await db
      .from('profiles')
      .select(PROFILE_SELECT)
      .eq('id', payload.profile_id)
      .maybeSingle();
    if (error) throw error;
    const profile = data as unknown as ProfileForGHL | null;
    if (!profile) {
      // Profile may have been deleted between trigger and processing.
      await markProcessed(db, syncEventId, {
        skipped: 'profile_not_found',
        profile_id: payload.profile_id,
      });
      return;
    }

    const apiKey =
      process.env.GHL_PRIVATE_KEY ||
      process.env.GOHIGHLEVEL_API_KEY ||
      process.env.GHL_API_KEY ||
      '';
    const locationId =
      process.env.GHL_LOCATION_ID ||
      process.env.GOHIGHLEVEL_LOCATION_ID ||
      '';
    if (!apiKey || !locationId) {
      throw new Error(
        'profile-ghl-sync: GHL_PRIVATE_KEY or GHL_LOCATION_ID not configured',
      );
    }

    const ghlPayload = buildGHLContactPayload(profile, locationId);

    // 1. Search by email.
    let existingContactId = await findContactByField(
      apiKey,
      locationId,
      'email',
      profile.email,
    );

    // 2. Fall back to phone if email didn't match.
    if (!existingContactId && profile.phone) {
      existingContactId = await findContactByField(
        apiKey,
        locationId,
        'phone',
        profile.phone,
      );
    }

    let action: 'created' | 'updated';
    let contactId: string;

    if (existingContactId) {
      contactId = await updateContact(
        apiKey,
        existingContactId,
        toUpdatePayload(ghlPayload) as Record<string, unknown>,
      );
      action = 'updated';
    } else {
      const created = await createContact(
        apiKey,
        ghlPayload as unknown as Record<string, unknown>,
      );
      contactId = created.contactId;
      action = created.action;
    }

    await markProcessed(db, syncEventId, {
      profile_id: profile.id,
      ghl_contact_id: contactId,
      action,
      fields_synced: ghlPayload.customFields.map((f) => f.key),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markFailed(db, syncEventId, message);
    throw err;
  }
}

// ----- GHL HTTP helpers --------------------------------------------------

async function ghlFetch(
  url: string,
  init: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await fetch(url, init);
    if (response.status !== 429 || attempt === maxRetries) {
      return response;
    }
    const delay = 2 ** attempt * 1000;
    console.warn(
      `[profile-ghl-sync] 429 rate limited, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
    );
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error('ghlFetch: exceeded max retries');
}

function ghlHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Version: '2021-07-28',
  };
}

async function findContactByField(
  apiKey: string,
  locationId: string,
  field: string,
  value: string,
): Promise<string | null> {
  if (!value) return null;
  const response = await ghlFetch(`${GHL_API_URL}/contacts/search`, {
    method: 'POST',
    headers: ghlHeaders(apiKey),
    body: JSON.stringify({
      locationId,
      page: 1,
      pageLimit: 1,
      filters: [
        {
          group: 'OR',
          filters: [{ field, operator: 'eq', value }],
        },
      ],
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    console.error(
      `[profile-ghl-sync] GHL search by ${field} failed (${response.status}): ${errText}`,
    );
    return null;
  }
  const data = (await response.json()) as { contacts?: Array<{ id: string }> };
  return data.contacts?.[0]?.id ?? null;
}

// Update with duplicate-phone-conflict retry: if GHL refuses the
// update because another contact already has this phone number, retry
// without the phone field rather than failing the whole sync.
async function updateContact(
  apiKey: string,
  contactId: string,
  updatePayload: Record<string, unknown>,
): Promise<string> {
  const headers = ghlHeaders(apiKey);
  const url = `${GHL_API_URL}/contacts/${contactId}`;

  const attempt = async (
    body: Record<string, unknown>,
  ): Promise<Response> =>
    ghlFetch(url, { method: 'PUT', headers, body: JSON.stringify(body) });

  let response = await attempt(updatePayload);
  if (!response.ok) {
    const errText = await response.text();
    try {
      const errData = JSON.parse(errText) as {
        statusCode?: number;
        meta?: { matchingField?: string; contactName?: string; contactId?: string };
      };
      if (
        errData.statusCode === 400 &&
        errData.meta?.matchingField === 'phone'
      ) {
        console.warn(
          `[profile-ghl-sync] duplicate phone conflict on update for ${contactId}; retrying without phone`,
        );
        const { phone: _stripped, ...rest } = updatePayload as { phone?: unknown } & Record<string, unknown>;
        response = await attempt(rest);
      } else {
        throw new Error(`GHL update failed (${errData.statusCode}): ${errText}`);
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        throw new Error(`GHL update failed: ${errText}`);
      }
      throw e;
    }
  }
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`GHL update failed (post-retry): ${errText}`);
  }
  return contactId;
}

// Create with duplicate-contact fallback: GHL's POST /contacts/ returns
// meta.contactId when it detects the contact already exists. In that
// case, switch to PUT-update on that existing contact instead of failing.
async function createContact(
  apiKey: string,
  payload: Record<string, unknown>,
): Promise<{ contactId: string; action: 'created' | 'updated' }> {
  const headers = ghlHeaders(apiKey);
  const response = await ghlFetch(`${GHL_API_URL}/contacts/`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (response.ok) {
    const data = (await response.json()) as {
      contact?: { id?: string };
      id?: string;
    };
    const id = data.contact?.id ?? data.id;
    if (!id) throw new Error('GHL create succeeded but returned no contact id');
    return { contactId: id, action: 'created' };
  }

  const errText = await response.text();
  let errData: {
    meta?: { matchingField?: string; contactId?: string };
  };
  try {
    errData = JSON.parse(errText) as typeof errData;
  } catch {
    throw new Error(`GHL create failed: ${errText}`);
  }

  if (!errData.meta?.contactId) {
    throw new Error(`GHL create failed (no contactId in meta): ${errText}`);
  }

  // Duplicate detected — update the existing contact.
  const existingId = errData.meta.contactId;
  const { locationId: _strip, ...updatePayload } = payload as {
    locationId?: unknown;
  } & Record<string, unknown>;
  const updatedId = await updateContact(apiKey, existingId, updatePayload);
  return { contactId: updatedId, action: 'updated' };
}
