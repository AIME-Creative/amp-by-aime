/**
 * AIME-15: tests for the profile → GHL field mapping.
 *
 * Behavior should match the legacy supabase/functions/sync-profile-ghl
 * EF exactly — same custom fields, same transforms, same conditional
 * inclusion.
 */
import { describe, expect, it } from 'vitest';
import {
  buildGHLContactPayload,
  toUpdatePayload,
  type ProfileForGHL,
} from '@/lib/sync/ghl-mapping';

const LOCATION = 'loc_test';

function base(overrides: Partial<ProfileForGHL> = {}): ProfileForGHL {
  return {
    id: 'profile-uuid-1',
    email: 'user@example.com',
    ...overrides,
  };
}

describe('buildGHLContactPayload', () => {
  it('parses full_name into firstName + lastName when first/last not set', () => {
    const out = buildGHLContactPayload(base({ full_name: 'Jane Q Doe' }), LOCATION);
    expect(out.firstName).toBe('Jane');
    expect(out.lastName).toBe('Q Doe');
    expect(out.name).toBe('Jane Q Doe');
  });

  it('prefers explicit first_name + last_name over parsed full_name', () => {
    const out = buildGHLContactPayload(
      base({
        full_name: 'Wrong Name',
        first_name: 'Jane',
        last_name: 'Doe',
      }),
      LOCATION,
    );
    expect(out.firstName).toBe('Jane');
    expect(out.lastName).toBe('Doe');
    expect(out.name).toBe('Wrong Name'); // GHL `name` field = full_name when set
  });

  it('maps role to a display name and adds jobtitle custom field', () => {
    const out = buildGHLContactPayload(base({ role: 'loan_officer' }), LOCATION);
    expect(out.customFields).toContainEqual({
      key: 'jobtitle',
      field_value: 'Loan Officer',
    });
  });

  it('adds broker_owner=Yes when role is broker_owner', () => {
    const out = buildGHLContactPayload(base({ role: 'broker_owner' }), LOCATION);
    expect(out.customFields).toContainEqual({
      key: 'broker_owner',
      field_value: 'Yes',
    });
    // Also the jobtitle for broker_owner
    expect(out.customFields).toContainEqual({
      key: 'jobtitle',
      field_value: 'Broker Owner',
    });
  });

  it('does NOT add broker_owner field when role is not broker_owner', () => {
    const out = buildGHLContactPayload(base({ role: 'processor' }), LOCATION);
    expect(out.customFields.some((f) => f.key === 'broker_owner')).toBe(false);
  });

  it('joins state_licenses array as comma-separated CSV', () => {
    const out = buildGHLContactPayload(
      base({ state_licenses: ['CA', 'TX', 'NY'] }),
      LOCATION,
    );
    expect(out.customFields).toContainEqual({
      key: 'brokerage_state_licenses',
      field_value: 'CA, TX, NY',
    });
  });

  it('formats scotsman_guide_subscription_date as YYYY-MM-DD', () => {
    const out = buildGHLContactPayload(
      base({
        scotsman_guide_subscription_date: '2026-03-15T10:30:00Z',
      }),
      LOCATION,
    );
    expect(out.customFields).toContainEqual({
      key: 'scotsman_guide_subscription_date',
      field_value: '2026-03-15',
    });
  });

  it('only writes scotsman_guide_subscription when value is exactly true', () => {
    const optedIn = buildGHLContactPayload(
      base({ scotsman_guide_subscription: true }),
      LOCATION,
    );
    expect(optedIn.customFields).toContainEqual({
      key: 'scotsman_guide_subscription',
      field_value: 'Opt-in',
    });

    const optedOut = buildGHLContactPayload(
      base({ scotsman_guide_subscription: false }),
      LOCATION,
    );
    expect(
      optedOut.customFields.some((f) => f.key === 'scotsman_guide_subscription'),
    ).toBe(false);
  });

  it('writes payment_amount as a string even when 0', () => {
    const out = buildGHLContactPayload(base({ payment_amount: 0 }), LOCATION);
    expect(out.customFields).toContainEqual({
      key: 'payment_amount',
      field_value: '0',
    });
  });

  it('omits empty / null / undefined top-level fields', () => {
    const out = buildGHLContactPayload(
      base({ phone: null, address: '', city: undefined }),
      LOCATION,
    );
    expect(out.phone).toBeUndefined();
    expect(out.address1).toBeUndefined();
    expect(out.city).toBeUndefined();
  });

  it('always includes locationId + email + customFields (the required scaffolding)', () => {
    const out = buildGHLContactPayload(base(), LOCATION);
    expect(out.locationId).toBe(LOCATION);
    expect(out.email).toBe('user@example.com');
    expect(Array.isArray(out.customFields)).toBe(true);
    // aime_membership_id always present (profile.id)
    expect(out.customFields).toContainEqual({
      key: 'aime_membership_id',
      field_value: 'profile-uuid-1',
    });
  });

  it('maps a fully-populated profile to all expected custom fields', () => {
    const out = buildGHLContactPayload(
      base({
        full_name: 'Jane Doe',
        role: 'loan_officer',
        gender: 'Female',
        race: 'Asian',
        plan_tier: 'Elite',
        subscription_status: 'active',
        billing_period: 'Monthly',
        payment_amount: 69.99,
        stripe_customer_id: 'cus_123',
        company_nmls: '999111',
        state_licenses: ['WA', 'OR'],
        company: 'Acme Mortgage',
        scotsman_guide_subscription: true,
        scotsman_guide_subscription_date: '2026-01-01',
      }),
      LOCATION,
    );
    const keys = out.customFields.map((f) => f.key).sort();
    expect(keys).toEqual(
      [
        'aime_membership_id',
        'aime_membership_tier',
        'brokerage_nmls',
        'brokerage_state_licenses',
        'company_name',
        'gender',
        'jobtitle',
        'membership_status',
        'payment_amount',
        'payment_schedule',
        'race_type',
        'scotsman_guide_subscription',
        'scotsman_guide_subscription_date',
        'stripe_id',
      ].sort(),
    );
  });
});

describe('toUpdatePayload', () => {
  it('strips locationId (PUT /contacts/{id} rejects it)', () => {
    const full = buildGHLContactPayload(base(), LOCATION);
    const update = toUpdatePayload(full);
    expect('locationId' in update).toBe(false);
    expect(update.email).toBe('user@example.com');
  });
});
