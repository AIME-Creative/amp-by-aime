/**
 * AIME-14: shared test helpers for worker handler tests.
 *
 * Builds chainable Supabase mocks (modeled on Joe's existing pattern
 * in tests/api/webhooks/stripe-fuse-reconciler.test.ts) and a small
 * builder for sync_events rows.
 */
import { vi } from 'vitest';

export type TableUpdate = {
  table: string;
  updates: Record<string, unknown>;
  filters: Array<{ kind: string; col: string; val: unknown }>;
};

export type TableRpc = { fn: string; args: Record<string, unknown> };

// Per-table queue of read responses. Tests push expected rows in
// the order they're consumed by the handler under test. The handler
// often reads the same table multiple times (profile lookup, then a
// duplicate-prevention re-read of profiles), so each read pulls the
// next queued row. When the queue is empty, reads return null.
export type ReadMap = Map<string, Array<Record<string, unknown> | null>>;

export interface MockDb {
  client: unknown;
  updates: TableUpdate[];
  rpcCalls: TableRpc[];
  reads: ReadMap;
  // Push one read response onto the queue for `table`.
  setRead(table: string, row: Record<string, unknown> | null): void;
  // Replace the entire queue for `table` (use when seeding multiple
  // responses up front).
  setReads(table: string, rows: Array<Record<string, unknown> | null>): void;
}

export function makeMockDb(): MockDb {
  const updates: TableUpdate[] = [];
  const rpcCalls: TableRpc[] = [];
  const reads: ReadMap = new Map();

  function makeReadChain(table: string): unknown {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.neq = () => chain;
    chain.is = () => chain;
    chain.or = () => chain;
    chain.order = () => chain;
    chain.limit = () => chain;
    chain.maybeSingle = () => {
      const q = reads.get(table);
      const row = q && q.length > 0 ? q.shift()! : null;
      return Promise.resolve({ data: row, error: null });
    };
    chain.single = chain.maybeSingle;
    return chain;
  }

  function makeUpdateChain(table: string, updates_data: Record<string, unknown>): unknown {
    const filters: TableUpdate['filters'] = [];
    const record = () => {
      updates.push({ table, updates: updates_data, filters: [...filters] });
      return { error: null };
    };
    const chain: Record<string, unknown> = {};
    chain.eq = (col: string, val: unknown) => {
      filters.push({ kind: 'eq', col, val });
      return chain;
    };
    chain.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) =>
      Promise.resolve(record()).then(onFulfilled, onRejected);
    chain.catch = (onRejected: (r: unknown) => unknown) =>
      Promise.resolve(record()).catch(onRejected);
    return chain;
  }

  function makeInsertChain(table: string, insertData: Record<string, unknown> | Record<string, unknown>[]): unknown {
    const recordOnce = () => {
      const data = Array.isArray(insertData) ? insertData[0] : insertData;
      return { data, error: null };
    };
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.maybeSingle = () => Promise.resolve(recordOnce());
    chain.single = chain.maybeSingle;
    return chain;
  }

  const client = {
    from: (table: string) => ({
      select: () => makeReadChain(table),
      update: (data: Record<string, unknown>) => makeUpdateChain(table, data),
      insert: (data: Record<string, unknown> | Record<string, unknown>[]) => makeInsertChain(table, data),
    }),
    rpc: vi.fn((fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return Promise.resolve({ data: null, error: null });
    }),
  };

  return {
    client,
    updates,
    rpcCalls,
    reads,
    setRead(table: string, row: Record<string, unknown> | null) {
      const q = reads.get(table) ?? [];
      q.push(row);
      reads.set(table, q);
    },
    setReads(table: string, rows: Array<Record<string, unknown> | null>) {
      reads.set(table, [...rows]);
    },
  };
}

export function syncEventRow(args: {
  id?: string;
  source?: string;
  event_id?: string;
  event_type: string;
  payload: unknown;
  status?: string;
}): Record<string, unknown> {
  return {
    id: args.id ?? 'sync-evt-1',
    source: args.source ?? 'stripe',
    event_id: args.event_id ?? 'evt_test',
    event_type: args.event_type,
    payload: args.payload,
    received_at: new Date().toISOString(),
    processed_at: null,
    status: args.status ?? 'received',
    retry_count: 0,
    last_error: null,
    outcome: null,
  };
}
