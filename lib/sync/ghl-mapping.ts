// AIME-15: pure mapping function from Supabase `profiles` row to the
// GHL contact payload. Lifted out of the legacy
// `supabase/functions/sync-profile-ghl/index.ts` so the worker handler
// can import it and unit tests can exercise it in isolation.
//
// Behavior preserved exactly from the legacy EF — same field set, same
// transforms, same conditional inclusion rules. If you change anything
// here, also update docs/aime-15-supabase-ghl-field-mapping.md.

export interface ProfileForGHL {
  id: string;
  email: string;
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip_code?: string | null;
  company?: string | null;
  company_nmls?: string | null;
  birthday?: string | null;
  role?: string | null;
  state_licenses?: string[] | null;
  race?: string | null;
  gender?: string | null;
  plan_tier?: string | null;
  billing_period?: string | null;
  payment_amount?: number | null;
  scotsman_guide_subscription?: boolean | null;
  scotsman_guide_subscription_date?: string | null;
  stripe_customer_id?: string | null;
  subscription_status?: string | null;
}

export interface GHLCustomField {
  key: string;
  field_value: string;
}

export interface GHLContactPayload {
  locationId: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  email: string;
  phone?: string;
  address1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  companyName?: string;
  dateOfBirth?: string;
  customFields: GHLCustomField[];
}

const ROLE_DISPLAY: Record<string, string> = {
  loan_officer: 'Loan Officer',
  broker_owner: 'Broker Owner',
  loan_officer_assistant: 'Loan Officer Assistant',
  processor: 'Processor',
};

function parseName(profile: ProfileForGHL): { firstName: string; lastName: string } {
  const nameParts = (profile.full_name ?? '').trim().split(/\s+/).filter(Boolean);
  const firstName = profile.first_name || nameParts[0] || '';
  const lastName = profile.last_name || nameParts.slice(1).join(' ') || '';
  return { firstName, lastName };
}

function formatDateYYYYMMDD(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function buildGHLContactPayload(
  profile: ProfileForGHL,
  locationId: string,
): GHLContactPayload {
  const { firstName, lastName } = parseName(profile);
  const roleDisplay = ROLE_DISPLAY[profile.role ?? ''] ?? profile.role ?? '';
  const stateLicensesCsv = Array.isArray(profile.state_licenses)
    ? profile.state_licenses.join(', ')
    : '';

  const customFields: GHLCustomField[] = [];
  const push = (key: string, value: string | null | undefined): void => {
    if (value !== null && value !== undefined && value !== '') {
      customFields.push({ key, field_value: value });
    }
  };

  push('jobtitle', roleDisplay);
  push('gender', profile.gender);
  push('race_type', profile.race);
  push('aime_membership_tier', profile.plan_tier);
  push('aime_membership_id', profile.id);
  push('membership_status', profile.subscription_status);
  push('payment_schedule', profile.billing_period);
  if (
    profile.payment_amount !== undefined &&
    profile.payment_amount !== null
  ) {
    customFields.push({
      key: 'payment_amount',
      field_value: String(profile.payment_amount),
    });
  }
  push('stripe_id', profile.stripe_customer_id);
  push('brokerage_nmls', profile.company_nmls);
  push('brokerage_state_licenses', stateLicensesCsv);
  if (profile.role === 'broker_owner') {
    customFields.push({ key: 'broker_owner', field_value: 'Yes' });
  }
  push('company_name', profile.company);
  if (profile.scotsman_guide_subscription === true) {
    customFields.push({
      key: 'scotsman_guide_subscription',
      field_value: 'Opt-in',
    });
  }
  const scotsmanDate = formatDateYYYYMMDD(
    profile.scotsman_guide_subscription_date,
  );
  if (scotsmanDate) {
    customFields.push({
      key: 'scotsman_guide_subscription_date',
      field_value: scotsmanDate,
    });
  }

  const payload: GHLContactPayload = {
    locationId,
    email: profile.email,
    customFields,
  };
  if (firstName) payload.firstName = firstName;
  if (lastName) payload.lastName = lastName;
  const displayName = profile.full_name || `${firstName} ${lastName}`.trim();
  if (displayName) payload.name = displayName;
  if (profile.phone) payload.phone = profile.phone;
  if (profile.address) payload.address1 = profile.address;
  if (profile.city) payload.city = profile.city;
  if (profile.state) payload.state = profile.state;
  if (profile.zip_code) payload.postalCode = profile.zip_code;
  if (profile.company) payload.companyName = profile.company;
  if (profile.birthday) payload.dateOfBirth = profile.birthday;
  return payload;
}

// PUT-update variant: GHL's PUT /contacts/{id} rejects `locationId`.
// Strips it from the payload returned by buildGHLContactPayload.
export function toUpdatePayload(
  payload: GHLContactPayload,
): Omit<GHLContactPayload, 'locationId'> {
  const { locationId: _ignore, ...rest } = payload;
  return rest;
}
