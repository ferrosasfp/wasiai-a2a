/**
 * Receipts Routes Tests — WKH-124 KEY-RECEIPTS
 *
 * Cubre: AC-7 (GET /receipts filtra por owner del caller), AC-4 (verify
 * owner-match → 200 {valid:true}), AC-5 (tamper → 200 {valid:false,
 * tamper_detected:true}), AC-8 (`:id` de otro owner → 404 disclosure-safe).
 *
 * Patrón: Fastify in-process + mock de receiptService e identityService
 * (auth de la master key, igual auth.key-session.test.ts).
 */

import crypto from 'node:crypto';
import Fastify from 'fastify';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { A2AAgentKeyRow } from '../types/index.js';
import type { ReceiptRow } from '../types/receipt.js';

vi.mock('../services/identity.js', () => ({
  identityService: {
    lookupByHash: vi.fn(),
  },
  isIdentityVerified: (row: { erc8004_identity?: unknown } | null) =>
    row?.erc8004_identity != null,
}));

vi.mock('../services/receipt.js', () => ({
  receiptService: {
    list: vi.fn(),
    getById: vi.fn(),
    verify: vi.fn(),
  },
}));

import { identityService } from '../services/identity.js';
import { receiptService } from '../services/receipt.js';
import receiptsRoutes from './receipts.js';

const mockLookupByHash = vi.mocked(identityService.lookupByHash);
const mockList = vi.mocked(receiptService.list);
const mockGetById = vi.mocked(receiptService.getById);
const mockVerify = vi.mocked(receiptService.verify);

const MASTER_KEY = `wasi_a2a_${'a'.repeat(64)}`;

function makeKeyRow(overrides: Partial<A2AAgentKeyRow> = {}): A2AAgentKeyRow {
  return {
    id: 'key-1',
    owner_ref: 'user-1',
    key_hash: crypto.createHash('sha256').update(MASTER_KEY).digest('hex'),
    display_name: null,
    budget: { '2368': '50.00' },
    daily_limit_usd: null,
    daily_spent_usd: '0',
    daily_reset_at: new Date().toISOString(),
    allowed_registries: null,
    allowed_agent_slugs: null,
    allowed_categories: null,
    max_spend_per_call_usd: null,
    is_active: true,
    last_used_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    erc8004_identity: null,
    kite_passport: null,
    agentkit_wallet: null,
    funding_wallet: null,
    metadata: {},
    require_signature: false,
    ...overrides,
  };
}

function makeReceipt(overrides: Partial<ReceiptRow> = {}): ReceiptRow {
  return {
    id: 'rcpt-1',
    owner_ref: 'user-1',
    agent_key_id: 'key-1',
    session_id: null,
    delegation_id: null,
    receipt_type: 'budget_debit',
    amount_usd: '1.50000000',
    chain_id: 2368,
    tx_hash: null,
    counterparty: null,
    orchestration_id: null,
    prev_receipt_hash: null,
    receipt_hash: 'a'.repeat(64),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('receipts routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(receiptsRoutes, { prefix: '/receipts' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── AC-7 ──────────────────────────────────────────────────
  it('GET /receipts filters by caller owner (AC-7)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockList.mockResolvedValue([]);

    const res = await app.inject({
      method: 'GET',
      url: '/receipts',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ receipts: [] });
    expect(mockList).toHaveBeenCalledWith('user-1');
  });

  it('GET /receipts without key → 403', async () => {
    mockLookupByHash.mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: '/receipts' });
    expect(res.statusCode).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  // ── AC-4 ──────────────────────────────────────────────────
  it('GET /receipts/:id/verify owner-match → 200 {valid:true} (AC-4)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetById.mockResolvedValue(makeReceipt());
    mockVerify.mockResolvedValue({
      valid: true,
      receipt_id: 'rcpt-1',
      computed_hash: 'a'.repeat(64),
      stored_hash: 'a'.repeat(64),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/receipts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/verify',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(true);
    expect(mockVerify).toHaveBeenCalledWith(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'user-1',
    );
  });

  // ── AC-5 ──────────────────────────────────────────────────
  it('GET /receipts/:id/verify tamper → 200 {valid:false, tamper_detected:true} (AC-5)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetById.mockResolvedValue(makeReceipt());
    mockVerify.mockResolvedValue({
      valid: false,
      receipt_id: 'rcpt-1',
      tamper_detected: true,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/receipts/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/verify',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(false);
    expect(res.json().tamper_detected).toBe(true);
  });

  // ── AC-8 ──────────────────────────────────────────────────
  it('GET /receipts/:id of another owner → 404 disclosure-safe (AC-8)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetById.mockResolvedValue(null); // cross-owner → null

    const res = await app.inject({
      method: 'GET',
      url: '/receipts/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error_code).toBe('RECEIPT_NOT_FOUND');
  });

  it('GET /receipts/:id/verify of another owner → 404, verify NOT called (AC-8)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockGetById.mockResolvedValue(null);

    const res = await app.inject({
      method: 'GET',
      url: '/receipts/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/verify',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });

    expect(res.statusCode).toBe(404);
    expect(mockVerify).not.toHaveBeenCalled();
  });

  // ── WKH-345 · `:id` sin forma de UUID ─────────────────────
  // Antes de esta HU el valor llegaba a una columna `uuid` y Postgres
  // respondía 22P02, que nadie traducía: 500. El aserto de `not.toHaveBeenCalled`
  // es el que mata el mutante "mover el guard adentro del try".
  it('T-1a (AC-1) GET /receipts/:id con :id malformado → 400 INVALID_INPUT, getById NOT llamado', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());

    const res = await app.inject({
      method: 'GET',
      url: '/receipts/not-a-uuid',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('INVALID_INPUT');
    expect(mockGetById).not.toHaveBeenCalled();
  });

  it('T-1b (AC-1) GET /receipts/:id/verify con :id malformado → 400 INVALID_INPUT, getById y verify NOT llamados', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());

    const res = await app.inject({
      method: 'GET',
      url: '/receipts/not-a-uuid/verify',
      headers: { authorization: `Bearer ${MASTER_KEY}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('INVALID_INPUT');
    expect(mockGetById).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
  });
});
