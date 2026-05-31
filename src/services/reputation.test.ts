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
}

function row(o: Partial<Row> = {}): Row {
  return {
    agent_id: 'agent-a',
    status: 'success',
    cost_usdc: 1,
    latency_ms: 100,
    ...o,
  };
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
    const data = Array.from({ length: 100 }, () =>
      row({ status: 'success', cost_usdc: 1 }),
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
    const data = [
      ...Array.from({ length: 50 }, () =>
        row({ status: 'success', cost_usdc: 1 }),
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
