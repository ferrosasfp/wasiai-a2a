/**
 * Inbound Task Service — unit tests (WKH-115).
 *
 * Cubre: AC-4 (ruteo in-process con scopingKeyRow de la fuente, routed→settled,
 * fail-closed CD-10), AC-5 (escrow → rejected sin budget), AC-6 (cap de budget),
 * AC-7 (SSRF → rejected), AC-9 (cross-tenant = not-found; owner_ref en toda
 * query), + verifySourceAuth (AC-2 core: firma válida/inválida/ventana/sin secret).
 *
 * supabase.from / identity.lookupByHash / orchestrate.orchestrate /
 * validateOutboundUrl / adapters registry mockeados.
 */

import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn() },
}));
vi.mock('./identity.js', () => ({
  identityService: { lookupByHash: vi.fn() },
}));
vi.mock('./orchestrate.js', () => ({
  orchestrateService: { orchestrate: vi.fn() },
}));
vi.mock('../lib/url-validator.js', () => ({
  validateOutboundUrl: vi.fn(),
}));
vi.mock('../adapters/registry.js', () => ({
  getAdaptersBundle: () => ({ chainConfig: { chainId: 2368 } }),
}));

import { supabase } from '../lib/supabase.js';
import { validateOutboundUrl } from '../lib/url-validator.js';
import type { A2AAgentKeyRow } from '../types/index.js';
import { identityService } from './identity.js';
import {
  InboundTaskNotFoundError,
  inboundTaskService,
  type SourceConfig,
} from './inbound-task.js';
import { orchestrateService } from './orchestrate.js';

const mockFrom = vi.mocked(supabase.from);
const mockLookup = vi.mocked(identityService.lookupByHash);
const mockOrchestrate = vi.mocked(orchestrateService.orchestrate);
const mockValidateUrl = vi.mocked(validateOutboundUrl);

const OWNER = 'owner-A';
const SECRET = 's3cr3t-utf8';
const A2A_KEY = 'wasi_a2a_payer_key';

// ── Supabase builder mock (captura inserts/updates + eq filters) ──

type Single = {
  data: unknown;
  error: { code?: string; message?: string } | null;
};

let insertSingle: Single = { data: { id: 'row-1' }, error: null };
let updateSingle: Single = { data: { id: 'row-1' }, error: null };
let getSingle: Single = { data: null, error: null };
// Cola opcional para `maybeSingle` (get / getByExternalRef): permite simular la
// transición de estado entre el pre-check y la re-lectura post-violación (MNR-2).
// Vacía → cae en `getSingle` (comportamiento previo intacto).
let getSingleQueue: Single[] = [];

interface RecordedUpdate {
  payload: Record<string, unknown>;
  eqs: Record<string, string>;
}
const inserts: Record<string, unknown>[] = [];
const updates: RecordedUpdate[] = [];

function makeBuilder() {
  const ctx = {
    op: '' as '' | 'insert' | 'update',
    payload: {} as Record<string, unknown>,
    eqs: {} as Record<string, string>,
  };
  // biome-ignore lint/suspicious/noExplicitAny: test double for supabase builder
  const b: any = {
    insert: (row: Record<string, unknown>) => {
      ctx.op = 'insert';
      ctx.payload = row;
      inserts.push(row);
      return b;
    },
    update: (row: Record<string, unknown>) => {
      ctx.op = 'update';
      ctx.payload = row;
      return b;
    },
    select: () => b,
    eq: (col: string, val: string) => {
      ctx.eqs[col] = val;
      return b;
    },
    single: () => {
      if (ctx.op === 'insert') return Promise.resolve(insertSingle);
      updates.push({ payload: ctx.payload, eqs: ctx.eqs });
      return Promise.resolve(updateSingle);
    },
    maybeSingle: () =>
      Promise.resolve(
        getSingleQueue.length ? getSingleQueue.shift()! : getSingle,
      ),
  };
  return b;
}

function payerKey(): A2AAgentKeyRow {
  return { id: 'key-1', owner_ref: OWNER, is_active: true } as A2AAgentKeyRow;
}

function cfg(overrides?: Partial<SourceConfig>): SourceConfig {
  return {
    source: 'TEST',
    secret: SECRET,
    a2aKeyRaw: A2A_KEY,
    maxBudgetUsdc: 10,
    defaultBudgetUsdc: 2,
    chainId: 2368,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  inserts.length = 0;
  updates.length = 0;
  insertSingle = { data: { id: 'row-1' }, error: null };
  updateSingle = { data: { id: 'row-1' }, error: null };
  getSingle = { data: null, error: null };
  getSingleQueue = [];
  mockFrom.mockImplementation(() => makeBuilder());
  mockLookup.mockResolvedValue(payerKey());
  mockValidateUrl.mockResolvedValue({
    ok: true,
    value: new URL('https://example.com'),
  });
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('INBOUND_SOURCE_')) delete process.env[k];
  }
});

// ── capBudget (AC-6/CD-2) ────────────────────────────────────────

describe('capBudget (AC-6)', () => {
  it('declared > cap → cap', () => {
    expect(inboundTaskService.capBudget(100, cfg())).toBe(10);
  });
  it('declared < cap → declared', () => {
    expect(inboundTaskService.capBudget(4, cfg())).toBe(4);
  });
  it('declared null → default de la fuente', () => {
    expect(inboundTaskService.capBudget(null, cfg())).toBe(2);
  });
});

// ── ingest crea row 'ingested' primero (AC-1) ────────────────────

describe('ingest crea ingested (AC-1)', () => {
  it('el primer write es un insert con status=ingested', async () => {
    mockOrchestrate.mockResolvedValue({
      orchestrationId: 'orch-1',
      answer: 'ok',
      pipeline: { success: true },
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    } as any);
    await inboundTaskService.ingest('test', cfg(), {
      goal: 'build a report',
      id: 'ext-1',
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.status).toBe('ingested');
    expect(inserts[0]!.goal).toBe('build a report');
    expect(inserts[0]!.external_ref).toBe('ext-1');
    expect(inserts[0]!.owner_ref).toBe(OWNER);
  });
});

// ── ingest happy path + fail-closed (AC-4/CD-10) ─────────────────

describe('ingest routing (AC-4, CD-10)', () => {
  it('AC-4: rutea in-process con scopingKeyRow de la fuente; routed→settled', async () => {
    mockOrchestrate.mockResolvedValue({
      orchestrationId: 'orch-1',
      answer: 'done',
      pipeline: { success: true },
      // biome-ignore lint/suspicious/noExplicitAny: minimal OrchestrateResult stub
    } as any);

    const res = await inboundTaskService.ingest('test', cfg(), {
      goal: 'build a report',
      budget_usdc: 100,
    });

    expect(res).toEqual({
      status: 'settled',
      orchestrationId: expect.any(String),
      answer: 'done',
    });
    // orchestrate llamado in-process con budget CAPADO (100 → 10) + key fuente.
    expect(mockOrchestrate).toHaveBeenCalledTimes(1);
    const [req] = mockOrchestrate.mock.calls[0]!;
    expect(req.budget).toBe(10);
    expect(req.scopingKeyRow).toMatchObject({ id: 'key-1', owner_ref: OWNER });
    expect(req.chainId).toBe(2368);
    // VERIFY-AT-IMPL: NO se pasa maxQuotedCostUsdc (no está en OrchestrateRequest).
    expect('maxQuotedCostUsdc' in req).toBe(false);
    // Orden de escrituras: routed ANTES, settled DESPUÉS.
    expect(updates.map((u) => u.payload.status)).toEqual(['routed', 'settled']);
    const routed = updates[0]!;
    expect(routed.payload.budget_usdc).toBe(10);
    expect(routed.payload.orchestration_id).toBeDefined();
  });

  it('CD-10: pipeline.success===false → failed (nunca settled)', async () => {
    mockOrchestrate.mockResolvedValue({
      orchestrationId: 'orch-1',
      answer: null,
      pipeline: { success: false, error: 'no agents' },
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    } as any);

    const res = await inboundTaskService.ingest('test', cfg(), { goal: 'x' });
    expect(res.status).toBe('failed');
    expect(updates.map((u) => u.payload.status)).toEqual(['routed', 'failed']);
  });

  it('CD-10: orchestrate throws → failed (nunca settled)', async () => {
    mockOrchestrate.mockRejectedValue(new Error('boom'));
    const res = await inboundTaskService.ingest('test', cfg(), { goal: 'x' });
    expect(res.status).toBe('failed');
    expect(updates.map((u) => u.payload.status)).toEqual(['routed', 'failed']);
    if (res.status === 'failed') expect(res.reason).toContain('boom');
  });
});

// ── escrow gate (AC-5) ───────────────────────────────────────────

describe('ingest escrow gate (AC-5)', () => {
  it('payment presente → rejected, orchestrate NUNCA invocado, sin budget', async () => {
    const res = await inboundTaskService.ingest('test', cfg(), {
      goal: 'x',
      payment: { amount: 999 },
    });
    expect(res.status).toBe('rejected');
    expect(mockOrchestrate).not.toHaveBeenCalled();
    // Solo un update: rejected. Ningún routed con budget acreditado.
    expect(updates.map((u) => u.payload.status)).toEqual(['rejected']);
    expect(updates[0]!.payload.budget_usdc).toBeUndefined();
  });

  it('escrow presente → rejected', async () => {
    const res = await inboundTaskService.ingest('test', cfg(), {
      goal: 'x',
      escrow: '0xabc',
    });
    expect(res.status).toBe('rejected');
    expect(mockOrchestrate).not.toHaveBeenCalled();
  });
});

// ── SSRF gate (AC-7) ─────────────────────────────────────────────

describe('ingest SSRF gate (AC-7)', () => {
  it('URL embebida maliciosa → rejected razón ssrf, sin orchestrate', async () => {
    mockValidateUrl.mockResolvedValue({
      ok: false,
      error: { category: 'private-ip', reason: '169.254.169.254' },
    });
    const res = await inboundTaskService.ingest('test', cfg(), {
      goal: 'x',
      callback_url: 'http://169.254.169.254/latest/meta-data',
    });
    expect(res.status).toBe('rejected');
    if (res.status === 'rejected') expect(res.reason).toContain('ssrf:');
    expect(mockOrchestrate).not.toHaveBeenCalled();
    expect(updates.map((u) => u.payload.status)).toEqual(['rejected']);
  });

  it('URL embebida válida → sigue al ruteo', async () => {
    mockOrchestrate.mockResolvedValue({
      orchestrationId: 'orch-1',
      answer: 'ok',
      pipeline: { success: true },
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    } as any);
    const res = await inboundTaskService.ingest('test', cfg(), {
      goal: 'x',
      callback_url: 'https://example.com/cb',
    });
    expect(res.status).toBe('settled');
    expect(mockValidateUrl).toHaveBeenCalledWith('https://example.com/cb');
  });
});

// ── ownership (AC-9) ─────────────────────────────────────────────

describe('ownership scoping (AC-9/CD-OBL-2)', () => {
  it('get cross-tenant → undefined', async () => {
    getSingle = { data: null, error: null };
    const r = await inboundTaskService.get('other-owner', 'row-1');
    expect(r).toBeUndefined();
  });

  it('updateStatus cross-tenant (PGRST116) → InboundTaskNotFoundError', async () => {
    updateSingle = { data: null, error: { code: 'PGRST116' } };
    await expect(
      inboundTaskService.updateStatus('other-owner', 'row-1', 'failed'),
    ).rejects.toBeInstanceOf(InboundTaskNotFoundError);
  });

  it('toda query filtra por owner_ref', async () => {
    mockOrchestrate.mockResolvedValue({
      orchestrationId: 'orch-1',
      answer: 'ok',
      pipeline: { success: true },
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    } as any);
    await inboundTaskService.ingest('test', cfg(), { goal: 'x' });
    // Cada update usó .eq('owner_ref', OWNER).
    for (const u of updates) {
      expect(u.eqs.owner_ref).toBe(OWNER);
    }
    // El insert selló owner_ref.
    expect(inserts[0]!.owner_ref).toBe(OWNER);
  });
});

// ── idempotency por (source, external_ref) (MNR-2) ───────────────

describe('ingest idempotency (MNR-2)', () => {
  function settledRow(extRef: string) {
    return {
      id: 'row-1',
      owner_ref: OWNER,
      source: 'TEST',
      external_ref: extRef,
      status: 'settled',
      goal: 'x',
      budget_usdc: 10,
      constraints: {},
      orchestration_id: 'orch-1',
      error_reason: null,
      created_at: '2026-07-06T00:00:00Z',
      updated_at: '2026-07-06T00:00:00Z',
    };
  }

  it('mismo (source, external_ref) 2x → 2ª idempotente, orchestrate 1x, sin 2ª row', async () => {
    mockOrchestrate.mockResolvedValue({
      orchestrationId: 'orch-1',
      answer: 'done',
      pipeline: { success: true },
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    } as any);

    // 1ª ingesta: pre-check no encuentra nada (getSingle null) → crea + orquesta.
    const first = await inboundTaskService.ingest('test', cfg(), {
      goal: 'x',
      id: 'ext-42',
    });
    expect(first.status).toBe('settled');
    expect(mockOrchestrate).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(1);

    // 2ª ingesta idéntica: ahora la row ya existe (settled) → replay idempotente.
    getSingle = { data: settledRow('ext-42'), error: null };
    const second = await inboundTaskService.ingest('test', cfg(), {
      goal: 'x',
      id: 'ext-42',
    });
    expect(second.status).toBe('settled');
    // orchestrate NO se re-invocó (sin doble-cobro) y NO se creó 2ª row.
    expect(mockOrchestrate).toHaveBeenCalledTimes(1);
    expect(inserts).toHaveLength(1);
  });

  it('sin external_ref → pre-check omitido, flujo normal preservado', async () => {
    // Incluso si maybeSingle devolviera una row, sin external_ref no se consulta.
    getSingle = { data: settledRow('other'), error: null };
    mockOrchestrate.mockResolvedValue({
      orchestrationId: 'orch-1',
      answer: 'ok',
      pipeline: { success: true },
      // biome-ignore lint/suspicious/noExplicitAny: minimal stub
    } as any);

    const res = await inboundTaskService.ingest('test', cfg(), { goal: 'x' });
    expect(res.status).toBe('settled');
    // Se creó la row y se orquestó → el pre-check idempotente NO se ejecutó.
    expect(inserts).toHaveLength(1);
    expect(mockOrchestrate).toHaveBeenCalledTimes(1);
  });

  it('violación UNIQUE (23505) en el insert (race) → replay de la existente, sin re-orchestrate', async () => {
    // maybeSingle: pre-check null (no existe aún), re-lectura post-violación row.
    getSingleQueue = [
      { data: null, error: null },
      { data: settledRow('ext-9'), error: null },
    ];
    insertSingle = { data: null, error: { code: '23505', message: 'dup key' } };

    const res = await inboundTaskService.ingest('test', cfg(), {
      goal: 'x',
      id: 'ext-9',
    });
    expect(res.status).toBe('settled');
    // El insert colisionó → NO se re-orquestó y no hubo reintento de creación.
    expect(mockOrchestrate).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(1);
  });
});

// ── verifySourceAuth (AC-2 core) ─────────────────────────────────

describe('verifySourceAuth (AC-2)', () => {
  function setupEnv() {
    process.env.INBOUND_SOURCE_SECRET_TEST = SECRET;
    process.env.INBOUND_SOURCE_A2A_KEY_TEST = A2A_KEY;
    process.env.INBOUND_SOURCE_MAX_BUDGET_TEST = '10';
    process.env.INBOUND_SOURCE_DEFAULT_BUDGET_TEST = '2';
    process.env.INBOUND_SOURCE_CHAIN_TEST = '2368';
  }
  function sign(secret: string, ts: string, body: string): string {
    return createHmac('sha256', Buffer.from(secret, 'utf8'))
      .update(`${ts}.`)
      .update(body)
      .digest('hex');
  }

  it('firma válida + ts en ventana → SourceConfig', () => {
    setupEnv();
    const ts = String(Math.floor(Date.now() / 1000));
    const body = '{"goal":"x"}';
    const sig = sign(SECRET, ts, body);
    const res = inboundTaskService.verifySourceAuth('test', body, ts, sig);
    expect(res).not.toBeNull();
    expect(res?.maxBudgetUsdc).toBe(10);
  });

  it('firma inválida → null', () => {
    setupEnv();
    const ts = String(Math.floor(Date.now() / 1000));
    const res = inboundTaskService.verifySourceAuth(
      'test',
      '{"goal":"x"}',
      ts,
      'a'.repeat(64),
    );
    expect(res).toBeNull();
  });

  it('hex malformado → null (antes de Buffer.from)', () => {
    setupEnv();
    const ts = String(Math.floor(Date.now() / 1000));
    const res = inboundTaskService.verifySourceAuth(
      'test',
      '{}',
      ts,
      'not-hex',
    );
    expect(res).toBeNull();
  });

  it('timestamp fuera de ventana → null', () => {
    setupEnv();
    const ts = String(Math.floor(Date.now() / 1000) - 10_000);
    const body = '{}';
    const sig = sign(SECRET, ts, body);
    expect(
      inboundTaskService.verifySourceAuth('test', body, ts, sig),
    ).toBeNull();
  });

  it('fuente sin secret → null', () => {
    // sin setupEnv → no hay INBOUND_SOURCE_SECRET_TEST.
    const ts = String(Math.floor(Date.now() / 1000));
    expect(
      inboundTaskService.verifySourceAuth('test', '{}', ts, 'a'.repeat(64)),
    ).toBeNull();
  });

  // NIT-ts: timestamp estricto — solo dígitos.
  it('timestamp no-dígito (whitespace / 1e10 / 0x10 / 12.3) → null', () => {
    setupEnv();
    const body = '{}';
    for (const ts of [
      ' 123',
      '123 ',
      '1e10',
      '0x10',
      '12.3',
      '',
      'abc',
      '+5',
    ]) {
      // Firma sobre el mismo `ts` para aislar que el rechazo es por el guard.
      const sig = sign(SECRET, ts, body);
      expect(
        inboundTaskService.verifySourceAuth('test', body, ts, sig),
      ).toBeNull();
    }
  });
});

// ── loadSourceConfig null cases (NIT-cfg) ────────────────────────

describe('loadSourceConfig null cases (NIT-cfg)', () => {
  function baseValidEnv() {
    process.env.INBOUND_SOURCE_SECRET_TEST = SECRET;
    process.env.INBOUND_SOURCE_A2A_KEY_TEST = A2A_KEY;
    process.env.INBOUND_SOURCE_MAX_BUDGET_TEST = '10';
  }

  it('MAX_BUDGET = 0 → null', () => {
    baseValidEnv();
    process.env.INBOUND_SOURCE_MAX_BUDGET_TEST = '0';
    expect(inboundTaskService.loadSourceConfig('test')).toBeNull();
  });

  it('MAX_BUDGET negativo → null', () => {
    baseValidEnv();
    process.env.INBOUND_SOURCE_MAX_BUDGET_TEST = '-5';
    expect(inboundTaskService.loadSourceConfig('test')).toBeNull();
  });

  it('MAX_BUDGET no-finito → null', () => {
    baseValidEnv();
    process.env.INBOUND_SOURCE_MAX_BUDGET_TEST = 'abc';
    expect(inboundTaskService.loadSourceConfig('test')).toBeNull();
  });

  it('DEFAULT_BUDGET negativo → null (misconfig)', () => {
    baseValidEnv();
    process.env.INBOUND_SOURCE_DEFAULT_BUDGET_TEST = '-1';
    expect(inboundTaskService.loadSourceConfig('test')).toBeNull();
  });

  it('DEFAULT_BUDGET no-finito → null (misconfig)', () => {
    baseValidEnv();
    process.env.INBOUND_SOURCE_DEFAULT_BUDGET_TEST = 'xyz';
    expect(inboundTaskService.loadSourceConfig('test')).toBeNull();
  });

  it('source vacío tras sanitize → null', () => {
    baseValidEnv();
    expect(inboundTaskService.loadSourceConfig('!!!')).toBeNull();
  });
});
