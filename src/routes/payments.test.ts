/**
 * Payment Routes — WKH-135 route tests.
 *
 * Cubre: T-AC5 (literales APP "session"/"upto"), T-AC4 (owner guard → 403),
 * T-WRITE (write-boundary money-path → 422, service NO llamado), auth (403).
 * Service + resolveCallerKey mockeados; PaymentIntentError real (instanceof en
 * el mapeo de errores del route).
 */

import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockService = vi.hoisted(() => ({
  openSession: vi.fn(),
  addVoucher: vi.fn(),
  closeSession: vi.fn(),
  createUpto: vi.fn(),
  settleUpto: vi.fn(),
  expireStale: vi.fn(),
  verifyCapSignature: vi.fn(),
}));

vi.mock('../services/payment-intent.js', async () => {
  const actual = await vi.importActual<
    typeof import('../services/payment-intent.js')
  >('../services/payment-intent.js');
  return { ...actual, paymentIntentService: mockService };
});

const mockResolveCallerKey = vi.hoisted(() => vi.fn());
vi.mock('./auth/parsers.js', () => ({
  resolveCallerKey: mockResolveCallerKey,
}));

// MNR-1: la default chain del registry es 2368 (kite) en estos tests.
vi.mock('../adapters/registry.js', () => ({
  getChainConfig: () => ({ name: 'kite', chainId: 2368, explorerUrl: '' }),
}));

import { PaymentIntentError } from '../services/payment-intent.js';
import { paymentsRoutes } from './payments.js';

const FUNDING = '0xabc0000000000000000000000000000000000001';
const PAYTO = '0x2222222222222222222222222222222222222222';

function activeKey(): void {
  mockResolveCallerKey.mockResolvedValue({
    is_active: true,
    owner_ref: 'tenant-A',
    funding_wallet: FUNDING,
  });
}

async function buildApp(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify();
  await app.register(paymentsRoutes, { prefix: '/payments' });
  await app.ready();
  return app;
}

function typedData() {
  return {
    domain: { name: 'WasiAI-a2a Upto', version: '1', chainId: 2368 },
    types: {},
    primaryType: 'UptoCap',
    message: {
      seller_ref: 'reg/agent',
      cap: '5',
      chain_id: 2368,
      nonce: `0x${'11'.repeat(32)}`,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── T-AC5: literales APP "session" / "upto" ─────────────────────
describe('T-AC5 literales APP', () => {
  it('POST /payments/session → 201 intentType "session"', async () => {
    activeKey();
    mockService.openSession.mockResolvedValue({
      intentId: 'i1',
      expiresAt: '2026-07-04T00:00:00.000Z',
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/payments/session',
      payload: {
        keyId: 'k1',
        sellerRef: 'reg/agent',
        payTo: PAYTO,
        chainId: 2368,
        depositUsd: 10,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().intentType).toBe('session');
    await app.close();
  });

  it('POST /payments/upto → 201 intentType "upto"', async () => {
    activeKey();
    mockService.createUpto.mockResolvedValue({
      intentId: 'i2',
      expiresAt: '2026-07-04T00:00:00.000Z',
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/payments/upto',
      payload: {
        keyId: 'k1',
        sellerRef: 'reg/agent',
        payTo: PAYTO,
        chainId: 2368,
        capUsd: 5,
        capSignature: `0x${'22'.repeat(65)}`,
        capNonce: `0x${'11'.repeat(32)}`,
        typedData: typedData(),
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().intentType).toBe('upto');
    await app.close();
  });
});

// ── T-AC4: owner guard → 403 ────────────────────────────────────
describe('T-AC4 owner guard (route)', () => {
  it('close de otro owner → 403 OWNERSHIP_MISMATCH', async () => {
    activeKey();
    mockService.closeSession.mockRejectedValue(
      new PaymentIntentError('OWNERSHIP_MISMATCH'),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/payments/session/i1/close',
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('OWNERSHIP_MISMATCH');
    await app.close();
  });

  it('INTENT_NOT_OPEN en voucher → 409', async () => {
    activeKey();
    mockService.addVoucher.mockRejectedValue(
      new PaymentIntentError('INTENT_NOT_OPEN'),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/payments/session/i1/voucher',
      payload: { voucherId: 'v1', amountUsd: 1 },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });
});

// ── T-WRITE: write-boundary money-path → 422 ────────────────────
describe('T-WRITE guard money-path (CD-12)', () => {
  it('depositUsd negativo → 422, service NO llamado', async () => {
    activeKey();
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/payments/session',
      payload: {
        keyId: 'k1',
        sellerRef: 'reg/agent',
        payTo: PAYTO,
        chainId: 2368,
        depositUsd: -5,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(mockService.openSession).not.toHaveBeenCalled();
    await app.close();
  });

  it('amountUsd no-number → 422 en voucher', async () => {
    activeKey();
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/payments/session/i1/voucher',
      payload: { voucherId: 'v1', amountUsd: 'abc' },
    });
    expect(res.statusCode).toBe(422);
    expect(mockService.addVoucher).not.toHaveBeenCalled();
    await app.close();
  });

  it('capUsd negativo → 422 en upto', async () => {
    activeKey();
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/payments/upto',
      payload: {
        keyId: 'k1',
        sellerRef: 'reg/agent',
        payTo: PAYTO,
        chainId: 2368,
        capUsd: -1,
        capSignature: `0x${'22'.repeat(65)}`,
        capNonce: `0x${'11'.repeat(32)}`,
        typedData: typedData(),
      },
    });
    expect(res.statusCode).toBe(422);
    expect(mockService.createUpto).not.toHaveBeenCalled();
    await app.close();
  });

  it('MNR-1: chainId no-default → 422 CHAIN_NOT_SUPPORTED, service NO llamado', async () => {
    activeKey();
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/payments/session',
      payload: {
        keyId: 'k1',
        sellerRef: 'reg/agent',
        payTo: PAYTO,
        chainId: 8453, // != default (2368)
        depositUsd: 10,
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error_code).toBe('CHAIN_NOT_SUPPORTED');
    expect(mockService.openSession).not.toHaveBeenCalled();
    await app.close();
  });

  it('MNR-1: chainId no-default → 422 CHAIN_NOT_SUPPORTED en upto', async () => {
    activeKey();
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/payments/upto',
      payload: {
        keyId: 'k1',
        sellerRef: 'reg/agent',
        payTo: PAYTO,
        chainId: 8453, // != default (2368)
        capUsd: 5,
        capSignature: `0x${'22'.repeat(65)}`,
        capNonce: `0x${'11'.repeat(32)}`,
        typedData: typedData(),
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error_code).toBe('CHAIN_NOT_SUPPORTED');
    expect(mockService.createUpto).not.toHaveBeenCalled();
    await app.close();
  });

  it('reportedUsageUsd negativo → 422 en settle', async () => {
    activeKey();
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/payments/upto/i1/settle',
      payload: { reportedUsageUsd: -1 },
    });
    expect(res.statusCode).toBe(422);
    expect(mockService.settleUpto).not.toHaveBeenCalled();
    await app.close();
  });
});

// ── Auth ────────────────────────────────────────────────────────
describe('auth', () => {
  it('caller inactivo → 403', async () => {
    mockResolveCallerKey.mockResolvedValue({ is_active: false });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/payments/session',
      payload: {
        keyId: 'k1',
        sellerRef: 'reg/agent',
        payTo: PAYTO,
        chainId: 2368,
        depositUsd: 10,
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
