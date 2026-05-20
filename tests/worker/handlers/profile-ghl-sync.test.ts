/**
 * AIME-15: tests for the profile-ghl-sync worker handler.
 *
 * Covers: happy path (update existing GHL contact), happy path (create
 * new GHL contact), profile-not-found skip, replay no-op, GHL fetch
 * error → DLQ path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.GHL_PRIVATE_KEY = 'pit-test';
process.env.GHL_LOCATION_ID = 'loc-test';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
process.env.SYNC_DB_URL = 'postgres://test/test';

const mocks = vi.hoisted(() => ({
  getEventByIdMock: vi.fn(),
  markProcessingMock: vi.fn().mockResolvedValue(undefined),
  markProcessedMock: vi.fn().mockResolvedValue(undefined),
  markFailedMock: vi.fn().mockResolvedValue(undefined),
  getSupabaseAdminMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('@/lib/sync', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/sync')>();
  return {
    ...orig,
    getEventById: mocks.getEventByIdMock,
    markProcessing: mocks.markProcessingMock,
    markProcessed: mocks.markProcessedMock,
    markFailed: mocks.markFailedMock,
    getSupabaseAdmin: mocks.getSupabaseAdminMock,
  };
});

globalThis.fetch = mocks.fetchMock as unknown as typeof fetch;

import { makeMockDb, syncEventRow } from './_helpers';
import { handleProfileGhlSync } from '@/worker/handlers/profile-ghl-sync';

function fetchResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const baseProfile = {
  id: 'profile-1',
  email: 'jane@example.com',
  full_name: 'Jane Doe',
  first_name: 'Jane',
  last_name: 'Doe',
  phone: '+15555550100',
  address: '123 Main',
  city: 'Austin',
  state: 'TX',
  zip_code: '78701',
  company: 'Acme',
  company_nmls: '999',
  birthday: null,
  role: 'loan_officer',
  state_licenses: ['TX', 'CA'],
  race: null,
  gender: null,
  plan_tier: 'Premium',
  billing_period: 'Monthly',
  payment_amount: 19.99,
  scotsman_guide_subscription: null,
  scotsman_guide_subscription_date: null,
  stripe_customer_id: 'cus_123',
  subscription_status: 'active',
};

beforeEach(() => {
  for (const m of Object.values(mocks)) {
    if (typeof (m as { mockReset?: unknown }).mockReset === 'function') {
      (m as { mockReset: () => void }).mockReset();
    }
  }
  mocks.markProcessingMock.mockResolvedValue(undefined);
  mocks.markProcessedMock.mockResolvedValue(undefined);
  mocks.markFailedMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('profile-ghl-sync handler', () => {
  it('happy path: finds existing GHL contact by email and PUT-updates it', async () => {
    const db = makeMockDb();
    mocks.getSupabaseAdminMock.mockReturnValue(db.client);
    db.setRead('profiles', baseProfile);

    mocks.getEventByIdMock.mockResolvedValue(
      syncEventRow({
        event_type: 'profile.upsert',
        payload: { op: 'UPDATE', profile_id: 'profile-1' },
        source: 'app',
      }),
    );

    // 1st fetch = search by email returns existing contact
    // 2nd fetch = PUT update succeeds
    mocks.fetchMock
      .mockResolvedValueOnce(
        fetchResponse(200, { contacts: [{ id: 'ghl-contact-1' }] }),
      )
      .mockResolvedValueOnce(
        fetchResponse(200, { contact: { id: 'ghl-contact-1' } }),
      );

    await handleProfileGhlSync([
      { id: 'job1', data: { sync_event_id: 'sync-evt-1' } } as never,
    ]);

    expect(mocks.markProcessedMock).toHaveBeenCalledWith(
      db.client,
      'sync-evt-1',
      expect.objectContaining({
        profile_id: 'profile-1',
        ghl_contact_id: 'ghl-contact-1',
        action: 'updated',
      }),
    );

    // Verify the search call (POST to /contacts/search with email filter)
    const searchCall = mocks.fetchMock.mock.calls[0]!;
    expect(searchCall[0]).toContain('/contacts/search');
    const searchBody = JSON.parse(searchCall[1]!.body as string);
    expect(searchBody.filters[0].filters[0]).toEqual({
      field: 'email',
      operator: 'eq',
      value: 'jane@example.com',
    });

    // Verify the PUT update call
    const updateCall = mocks.fetchMock.mock.calls[1]!;
    expect(updateCall[0]).toBe(
      'https://services.leadconnectorhq.com/contacts/ghl-contact-1',
    );
    expect(updateCall[1]!.method).toBe('PUT');
    const updateBody = JSON.parse(updateCall[1]!.body as string);
    expect(updateBody.locationId).toBeUndefined(); // stripped on PUT
    expect(updateBody.email).toBe('jane@example.com');
  });

  it('happy path: no existing GHL contact → POST-creates a new one', async () => {
    const db = makeMockDb();
    mocks.getSupabaseAdminMock.mockReturnValue(db.client);
    db.setRead('profiles', baseProfile);

    mocks.getEventByIdMock.mockResolvedValue(
      syncEventRow({
        event_type: 'profile.upsert',
        payload: { op: 'INSERT', profile_id: 'profile-1' },
        source: 'app',
      }),
    );

    // 1. search by email → no match
    // 2. search by phone → no match
    // 3. POST create → success
    mocks.fetchMock
      .mockResolvedValueOnce(fetchResponse(200, { contacts: [] }))
      .mockResolvedValueOnce(fetchResponse(200, { contacts: [] }))
      .mockResolvedValueOnce(
        fetchResponse(201, { contact: { id: 'ghl-new-1' } }),
      );

    await handleProfileGhlSync([
      { id: 'job2', data: { sync_event_id: 'sync-evt-2' } } as never,
    ]);

    expect(mocks.markProcessedMock).toHaveBeenCalledWith(
      db.client,
      'sync-evt-2',
      expect.objectContaining({
        profile_id: 'profile-1',
        ghl_contact_id: 'ghl-new-1',
        action: 'created',
      }),
    );
    const createCall = mocks.fetchMock.mock.calls[2]!;
    expect(createCall[0]).toBe(
      'https://services.leadconnectorhq.com/contacts/',
    );
    expect(createCall[1]!.method).toBe('POST');
  });

  it('skips when profile not found (deleted between trigger and processing)', async () => {
    const db = makeMockDb();
    mocks.getSupabaseAdminMock.mockReturnValue(db.client);
    // No profile seeded — read returns null.

    mocks.getEventByIdMock.mockResolvedValue(
      syncEventRow({
        event_type: 'profile.upsert',
        payload: { op: 'UPDATE', profile_id: 'deleted-profile' },
        source: 'app',
      }),
    );

    await handleProfileGhlSync([
      { id: 'jobX', data: { sync_event_id: 'sync-evt-X' } } as never,
    ]);

    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.markProcessedMock).toHaveBeenCalledWith(
      db.client,
      'sync-evt-X',
      expect.objectContaining({
        skipped: 'profile_not_found',
      }),
    );
  });

  it('replay: status=processed event is a no-op', async () => {
    const db = makeMockDb();
    mocks.getSupabaseAdminMock.mockReturnValue(db.client);

    mocks.getEventByIdMock.mockResolvedValue(
      syncEventRow({
        event_type: 'profile.upsert',
        payload: { op: 'UPDATE', profile_id: 'profile-1' },
        source: 'app',
        status: 'processed',
      }),
    );

    await handleProfileGhlSync([
      { id: 'jobR', data: { sync_event_id: 'sync-evt-R' } } as never,
    ]);

    expect(mocks.fetchMock).not.toHaveBeenCalled();
    expect(mocks.markProcessingMock).not.toHaveBeenCalled();
  });

  it('failure: GHL search returns 500 propagates → markFailed + rethrow', async () => {
    const db = makeMockDb();
    mocks.getSupabaseAdminMock.mockReturnValue(db.client);
    db.setRead('profiles', baseProfile);

    mocks.getEventByIdMock.mockResolvedValue(
      syncEventRow({
        event_type: 'profile.upsert',
        payload: { op: 'UPDATE', profile_id: 'profile-1' },
        source: 'app',
      }),
    );

    // 1. search by email returns 500
    // 2. search by phone (fallback) returns 500
    // 3. POST create returns 500 → handler throws
    mocks.fetchMock
      .mockResolvedValueOnce(fetchResponse(500, { error: 'upstream' }))
      .mockResolvedValueOnce(fetchResponse(500, { error: 'upstream' }))
      .mockResolvedValueOnce(fetchResponse(500, { error: 'upstream' }));

    await expect(
      handleProfileGhlSync([
        { id: 'jobF', data: { sync_event_id: 'sync-evt-F' } } as never,
      ]),
    ).rejects.toThrow(/GHL create failed/);
    expect(mocks.markFailedMock).toHaveBeenCalled();
  });
});
