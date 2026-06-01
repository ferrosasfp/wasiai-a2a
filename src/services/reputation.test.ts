/**
 * Reputation Service unit tests — WKH-103 (W1).
 *
 * Cubre AC-2/AC-3/AC-4/AC-5/AC-9/AC-10 + DT-2/DT-4/DT-10 + CD-1/CD-12/CD-18.
 * Mockea `supabase` con un builder thenable cuyo terminal (`.eq`/`.in`)
 * resuelve `{data,error}`. Usa `mockImplementation` + contador de llamadas
 * (NO `mockReturnValueOnce` encadenado — lección WKH-100). El cache se resetea
 * con `_resetReputationCache()` en `beforeEach`. CI-determinista, sin red.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock supabase ───────────────────────────────────────────
type QueryResult = { data: unknown; error: unknown };

// Cola de resultados que el siguiente terminal (.eq/.in) resolverá.
let _results: QueryResult[] = [];
let _resultIdx = 0;
// Registro de las llamadas terminales para asserts de no-N+1 / batch-page.
const _terminalCalls: Array<{ method: 'eq' | 'in'; arg: unknown }> = [];

function setResults(results: QueryResult[]): void {
  _results = results;
  _resultIdx = 0;
}

function nextResult(): QueryResult {
  const r = _results[_resultIdx] ?? { data: [], error: null };
  _resultIdx++;
  return r;
}

vi.mock('../lib/supabase.js', () => {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((_col: string, arg: unknown) => {
      _terminalCalls.push({ method: 'eq', arg });
      return Promise.resolve(nextResult());
    }),
    in: vi.fn((_col: string, arg: unknown) => {
      _terminalCalls.push({ method: 'in', arg });
      return Promise.resolve(nextResult());
    }),
  };
  return { supabase: { from: vi.fn(() => builder) } };
});

import { supabase } from '../lib/supabase.js';
import { _resetReputationCache, reputationService } from './reputation.js';

const mockFrom = vi.mocked(supabase.from);

// ── Fixtures ────────────────────────────────────────────────
interface Row {
  agent_id: string | null;
  status: string;
  cost_usdc: number | string | null;
  latency_ms: number | null;
  metadata: Record<string, unknown> | null;
}

function row(o: Partial<Row> = {}): Row {
  return {
    agent_id: 'agent-a',
    status: 'success',
    cost_usdc: 1,
    latency_ms: 100,
    metadata: null,
    ...o,
  };
}

// WKH-104: fila success con un caller_ref_hash explícito (distinto caller por
// llamada → no colisiona con el cap por caller en los tests de escala/rate).
function rowWithCaller(hash: string, o: Partial<Row> = {}): Row {
  return row({ ...o, metadata: { caller_ref_hash: hash } });
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  _resetReputationCache();
  _results = [];
  _resultIdx = 0;
  _terminalCalls.length = 0;
  process.env = { ...ORIGINAL_ENV };
  process.env.REPUTATION_SCALE_FACTOR = '50';
  delete process.env.REPUTATION_CACHE_TTL_MS;
  // WKH-104: K por defecto para los tests del cap por caller.
  process.env.REPUTATION_MAX_TASKS_PER_CALLER = '5';
});

describe('reputationService.computeReputationForAgent', () => {
  // T-AC2 / CD-1: success con cost_usdc=0 NO suma a tasks_settled.
  it('T-AC2: success with cost_usdc=0 does NOT count toward tasks_settled', async () => {
    setResults([
      {
        data: [
          row({ status: 'success', cost_usdc: 0 }),
          row({ status: 'success', cost_usdc: 2 }),
        ],
        error: null,
      },
    ]);
    const rep = await reputationService.computeReputationForAgent('agent-a');
    expect(rep).not.toBeNull();
    expect(rep?.tasks_settled).toBe(1); // only the cost>0 success counts
    expect(rep?.total_volume_usdc).toBe(2);
  });

  // T-AC9 / CD-1: solo eventos del slug entran; null/otros no matchean.
  it('T-AC9: only rows for the queried slug are aggregated', async () => {
    setResults([
      {
        data: [row({ status: 'success', cost_usdc: 5 })],
        error: null,
      },
    ]);
    const rep = await reputationService.computeReputationForAgent('agent-a');
    expect(_terminalCalls[0]).toEqual({ method: 'eq', arg: 'agent-a' });
    expect(rep?.tasks_settled).toBe(1);
  });

  // T-AC5 / DT-2: score>0 → objeto con shape esperado.
  it('T-AC5: score>0 yields a typed AgentReputation object', async () => {
    setResults([
      {
        data: [
          row({ cost_usdc: 1, latency_ms: 200 }),
          row({ cost_usdc: 3, latency_ms: 400 }),
        ],
        error: null,
      },
    ]);
    const rep = await reputationService.computeReputationForAgent('agent-a');
    expect(rep).toMatchObject({
      tasks_settled: 2,
      success_rate: 1,
      total_volume_usdc: 4,
      avg_latency_ms: 300,
      source: 'off-chain',
    });
    expect(rep?.score).toBeGreaterThan(0);
    expect(rep?.score).toBeLessThanOrEqual(100);
  });

  // T-FORMULA / DT-2: determinista; cambiar el factor cambia el score; clamp ≤ 100.
  it('T-FORMULA: deterministic, scale factor modulates, raw clamps score<=100', async () => {
    // WKH-104: caller distinto por fila → 100 tasks liquidadas sin que el cap
    // por caller las recorte (cada caller aporta 1 ≤ K).
    const data = Array.from({ length: 100 }, (_v, idx) =>
      rowWithCaller(`caller-${idx}`, { status: 'success', cost_usdc: 1 }),
    );
    // factor=50 → raw=min(100/50,1)=1 → score=100.
    process.env.REPUTATION_SCALE_FACTOR = '50';
    setResults([{ data, error: null }]);
    const a = await reputationService.computeReputationForAgent('agent-a');
    expect(a?.score).toBe(100); // clamp

    // factor=200 → raw=min(100/200,1)=0.5 → score=50.
    _resetReputationCache();
    process.env.REPUTATION_SCALE_FACTOR = '200';
    setResults([{ data, error: null }]);
    const b = await reputationService.computeReputationForAgent('agent-a');
    expect(b?.score).toBe(50);
  });

  // T-SUCCESS-RATE / OBS-1: success+failed → success_rate<1 modula hacia abajo.
  it('T-SUCCESS-RATE: failures reduce the score via success_rate modulator', async () => {
    // 50 settled successes + 50 failed → success_rate=0.5, raw=min(50/50,1)=1.
    // WKH-104: caller distinto por success → 50 tasks sin recorte del cap.
    const data = [
      ...Array.from({ length: 50 }, (_v, idx) =>
        rowWithCaller(`caller-${idx}`, { status: 'success', cost_usdc: 1 }),
      ),
      ...Array.from({ length: 50 }, () =>
        row({ status: 'failed', cost_usdc: 0, latency_ms: null }),
      ),
    ];
    process.env.REPUTATION_SCALE_FACTOR = '50';
    setResults([{ data, error: null }]);
    const rep = await reputationService.computeReputationForAgent('agent-a');
    expect(rep?.success_rate).toBe(0.5);
    expect(rep?.score).toBe(50); // 100 * 1 * 0.5
  });

  // T-ANTI-SYBIL: solo-fallidos → tasks_settled=0 → null.
  it('T-ANTI-SYBIL: only-failed events yield null (0 settled)', async () => {
    setResults([
      {
        data: [
          row({ status: 'failed', cost_usdc: 0, latency_ms: null }),
          row({ status: 'failed', cost_usdc: 0, latency_ms: null }),
        ],
        error: null,
      },
    ]);
    const rep = await reputationService.computeReputationForAgent('agent-a');
    expect(rep).toBeNull();
  });

  // T-0-TASKS: sin eventos → null.
  it('T-0-TASKS: no events yields null', async () => {
    setResults([{ data: [], error: null }]);
    const rep = await reputationService.computeReputationForAgent('agent-a');
    expect(rep).toBeNull();
  });

  // T-CACHE / DT-4: 2ª llamada dentro de TTL → 0 queries adicionales.
  it('T-CACHE: second call within TTL hits cache (no extra query)', async () => {
    setResults([{ data: [row({ cost_usdc: 2 })], error: null }]);
    const a = await reputationService.computeReputationForAgent('agent-a');
    expect(mockFrom).toHaveBeenCalledTimes(1);
    const b = await reputationService.computeReputationForAgent('agent-a');
    expect(mockFrom).toHaveBeenCalledTimes(1); // no new query
    expect(b).toEqual(a);
  });

  // T-AC4 / CD-18: error → null, sin throw, sin propagar error.message.
  it('T-AC4: supabase error yields null without throwing or leaking message', async () => {
    setResults([
      { data: null, error: { code: '42P01', message: 'relation missing' } },
    ]);
    await expect(
      reputationService.computeReputationForAgent('agent-a'),
    ).resolves.toBeNull();
  });
});

describe('reputationService.computeReputationBatch', () => {
  // T-NO-N+1 / CD-12: 3 slugs → supabase.from llamado EXACTAMENTE 1 vez con .in.
  it('T-NO-N+1: a single SELECT with .in for N slugs', async () => {
    setResults([
      {
        data: [
          row({ agent_id: 's1', cost_usdc: 1 }),
          row({ agent_id: 's2', cost_usdc: 2 }),
          row({ agent_id: 's3', cost_usdc: 3 }),
        ],
        error: null,
      },
    ]);
    const map = await reputationService.computeReputationBatch([
      's1',
      's2',
      's3',
    ]);
    expect(mockFrom).toHaveBeenCalledTimes(1); // 1 query, NOT N
    expect(_terminalCalls).toHaveLength(1);
    expect(_terminalCalls[0].method).toBe('in');
    expect(map.size).toBe(3);
  });

  // T-BATCH-PAGE / DT-10: el .in recibe SOLO los slugs pasados.
  it('T-BATCH-PAGE: .in receives exactly the slugs passed', async () => {
    setResults([{ data: [], error: null }]);
    await reputationService.computeReputationBatch(['x', 'y']);
    expect(_terminalCalls[0]).toEqual({ method: 'in', arg: ['x', 'y'] });
  });

  it('empty slugs array does not query', async () => {
    const map = await reputationService.computeReputationBatch([]);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });

  // T-AC4 (batch) / CD-18: error → Map vacío, sin throw.
  it('T-AC4 batch: supabase error yields empty Map without throwing', async () => {
    setResults([
      { data: null, error: { code: '42P01', message: 'relation missing' } },
    ]);
    const map = await reputationService.computeReputationBatch(['a', 'b']);
    expect(map.size).toBe(0);
  });

  it('batch omits slugs with 0 settled tasks', async () => {
    setResults([
      {
        data: [
          row({ agent_id: 'has-score', status: 'success', cost_usdc: 1 }),
          row({
            agent_id: 'no-score',
            status: 'failed',
            cost_usdc: 0,
            latency_ms: null,
          }),
        ],
        error: null,
      },
    ]);
    const map = await reputationService.computeReputationBatch([
      'has-score',
      'no-score',
    ]);
    expect(map.has('has-score')).toBe(true);
    expect(map.has('no-score')).toBe(false);
  });
});

// WKH-104 (TD-SYBIL): cap por caller en tasks_settled (CD-7/CD-8/CD-10).
describe('reputationService — cap por caller anti-sybil (WKH-104)', () => {
  // T-CAP-1 / AC-11 / CD-7: 1 caller × N tasks (N>K) → tasks_settled === K.
  it('T-CAP-1: same caller N>K tasks → capped at K (autopago no infla)', async () => {
    process.env.REPUTATION_MAX_TASKS_PER_CALLER = '5';
    const data = Array.from({ length: 10 }, () =>
      rowWithCaller('caller-self', { status: 'success', cost_usdc: 1 }),
    );
    setResults([{ data, error: null }]);
    const rep = await reputationService.computeReputationForAgent('agent-a');
    expect(rep?.tasks_settled).toBe(5); // min(10, K=5)
  });

  // T-CAP-2 / AC-11: M callers distintos × 1 task → tasks_settled === M.
  it('T-CAP-2: M distinct callers × 1 task each → tasks_settled === M', async () => {
    process.env.REPUTATION_MAX_TASKS_PER_CALLER = '5';
    const data = Array.from({ length: 7 }, (_v, idx) =>
      rowWithCaller(`caller-${idx}`, { status: 'success', cost_usdc: 1 }),
    );
    setResults([{ data, error: null }]);
    const rep = await reputationService.computeReputationForAgent('agent-a');
    expect(rep?.tasks_settled).toBe(7); // each caller contributes 1 (≤ K)
  });

  // T-CAP-3 / AC-11: caller A con N>K + caller B con 1 → tasks_settled === K+1.
  it('T-CAP-3: mixed (A:N>K + B:1) → tasks_settled === K + 1', async () => {
    process.env.REPUTATION_MAX_TASKS_PER_CALLER = '5';
    const data = [
      ...Array.from({ length: 8 }, () =>
        rowWithCaller('caller-A', { status: 'success', cost_usdc: 1 }),
      ),
      rowWithCaller('caller-B', { status: 'success', cost_usdc: 1 }),
    ];
    setResults([{ data, error: null }]);
    const rep = await reputationService.computeReputationForAgent('agent-a');
    expect(rep?.tasks_settled).toBe(6); // min(8,5) + min(1,5) = 5 + 1
  });

  // T-CAP-4 / AC-12 / CD-8: eventos sin caller_ref_hash → bucket __anon__,
  // capeado a K; score NO colapsa a null (≥1 task → score > 0).
  it('T-CAP-4: anonymous bucket capped at K, does not collapse to null', async () => {
    process.env.REPUTATION_MAX_TASKS_PER_CALLER = '5';
    const data = Array.from(
      { length: 9 },
      () => row({ status: 'success', cost_usdc: 1 }), // metadata: null
    );
    setResults([{ data, error: null }]);
    const rep = await reputationService.computeReputationForAgent('agent-a');
    expect(rep).not.toBeNull();
    expect(rep?.tasks_settled).toBe(5); // __anon__ capped at K
    expect(rep?.score).toBeGreaterThan(0);
  });

  // T-CAP-5: histórico (sin hash → __anon__) + callers nuevos (con hash).
  it('T-CAP-5: legacy (no metadata) + hashed callers sum correctly', async () => {
    process.env.REPUTATION_MAX_TASKS_PER_CALLER = '5';
    const data = [
      // 8 legacy sin metadata → __anon__ capeado a 5
      ...Array.from({ length: 8 }, () =>
        row({ status: 'success', cost_usdc: 1 }),
      ),
      // 3 callers nuevos distintos → +3
      rowWithCaller('new-1', { status: 'success', cost_usdc: 1 }),
      rowWithCaller('new-2', { status: 'success', cost_usdc: 1 }),
      rowWithCaller('new-3', { status: 'success', cost_usdc: 1 }),
    ];
    setResults([{ data, error: null }]);
    const rep = await reputationService.computeReputationForAgent('agent-a');
    expect(rep?.tasks_settled).toBe(8); // min(8,5)=5 (__anon__) + 3 (new callers)
  });

  // T-CAP-6: determinismo del cap — mismo input → mismo tasks_settled.
  it('T-CAP-6: deterministic — same input yields same tasks_settled', async () => {
    process.env.REPUTATION_MAX_TASKS_PER_CALLER = '5';
    const build = () => [
      ...Array.from({ length: 8 }, () =>
        rowWithCaller('caller-A', { status: 'success', cost_usdc: 1 }),
      ),
      rowWithCaller('caller-B', { status: 'success', cost_usdc: 1 }),
    ];
    setResults([{ data: build(), error: null }]);
    const a = await reputationService.computeReputationForAgent('agent-a');
    _resetReputationCache();
    setResults([{ data: build(), error: null }]);
    const b = await reputationService.computeReputationForAgent('agent-a');
    expect(a?.tasks_settled).toBe(b?.tasks_settled);
    expect(a?.tasks_settled).toBe(6);
  });

  // T-CAP-7 / CD-10: batch sigue siendo 1 query (.in una sola vez) con el cap.
  it('T-CAP-7: batch with per-caller cap still issues exactly 1 query', async () => {
    process.env.REPUTATION_MAX_TASKS_PER_CALLER = '5';
    const data = [
      // s1: 1 caller × 10 → capeado a 5
      ...Array.from({ length: 10 }, () =>
        rowWithCaller('c-self', {
          agent_id: 's1',
          status: 'success',
          cost_usdc: 1,
        }),
      ),
      // s2: 3 callers distintos → 3
      rowWithCaller('c1', { agent_id: 's2', status: 'success', cost_usdc: 1 }),
      rowWithCaller('c2', { agent_id: 's2', status: 'success', cost_usdc: 1 }),
      rowWithCaller('c3', { agent_id: 's2', status: 'success', cost_usdc: 1 }),
    ];
    setResults([{ data, error: null }]);
    const map = await reputationService.computeReputationBatch(['s1', 's2']);
    expect(mockFrom).toHaveBeenCalledTimes(1); // CD-10: 1 query, NOT per-caller
    expect(_terminalCalls).toHaveLength(1);
    expect(_terminalCalls[0].method).toBe('in');
    expect(map.get('s1')?.tasks_settled).toBe(5);
    expect(map.get('s2')?.tasks_settled).toBe(3);
  });

  // T-CAP-8 / Env: K inválido/ausente → default 5.
  it('T-CAP-8: invalid/absent K falls back to default 5', async () => {
    process.env.REPUTATION_MAX_TASKS_PER_CALLER = 'not-a-number';
    const data = Array.from({ length: 10 }, () =>
      rowWithCaller('caller-self', { status: 'success', cost_usdc: 1 }),
    );
    setResults([{ data, error: null }]);
    const rep = await reputationService.computeReputationForAgent('agent-a');
    expect(rep?.tasks_settled).toBe(5); // default K
  });
});

// T-AC10 / CD-2/CD-3: el módulo NO importa budget/delegation ni toca a2a_agent_keys.
describe('T-AC10: module isolation (anti cross-tenant / scope)', () => {
  it('reputation.ts source imports neither budget/delegation nor a2a_agent_keys', async () => {
    const fs = await import('node:fs');
    const url = await import('node:url');
    const src = fs.readFileSync(
      url.fileURLToPath(new URL('./reputation.ts', import.meta.url)),
      'utf8',
    );
    // No imports of budget/delegation/redis modules (comments may reference
    // CD-2/CD-3 by name — assert on actual `import` statements, not prose).
    const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l));
    const importBlob = importLines.join('\n');
    expect(importBlob).not.toMatch(/budget/);
    expect(importBlob).not.toMatch(/delegation/);
    expect(importBlob).not.toMatch(/redis/i);
    // The ONLY table touched is a2a_events — never a2a_agent_keys (CD-2/CD-3).
    expect(src).not.toContain(".from('a2a_agent_keys')");
    const fromCalls = [...src.matchAll(/\.from\('([^']+)'\)/g)].map(
      (m) => m[1],
    );
    expect(new Set(fromCalls)).toEqual(new Set(['a2a_events']));
  });
});
