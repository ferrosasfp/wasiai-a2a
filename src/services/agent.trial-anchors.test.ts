/**
 * WKH-313 — `publishedAgentService.listPublisherAnchors`, contra el service REAL.
 *
 * Por qué existe este archivo: en `discovery.trial.test.ts` este lector está
 * MOCKEADO (ahí se prueba al consumidor). Sus propias líneas de guard no las
 * ejecutaba ningún test, y la regla money-path exige cobertura de las líneas del
 * guard y no "la suite pasa". El guard acá es uno solo y es el que importa:
 *
 *   un error de la query devuelve `{ degraded: true }`, NO un Map vacío.
 *
 * Si devolviera un Map vacío, "no pude leer las anclas" y "estos agentes no tienen
 * publicador" serían lo mismo, y el cupo anti-sybil se apagaría solo justo cuando la
 * DB está en problemas: el consumidor leería "sin ancla" y admitiría igual.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type QueryResult = { data: unknown; error: unknown };

const { state } = vi.hoisted(() => ({
  state: {
    result: { data: [], error: null } as QueryResult,
    calls: [] as Array<{ method: string; args: unknown[] }>,
  },
}));

vi.mock('../lib/supabase.js', () => {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: (...args: unknown[]) => {
      state.calls.push({ method: 'select', args });
      return builder;
    },
    in: (...args: unknown[]) => {
      state.calls.push({ method: 'in', args });
      return builder;
    },
    // Terminal de la cadena: `.in('slug', slugs).eq('enabled', true)`.
    eq: (...args: unknown[]) => {
      state.calls.push({ method: 'eq', args });
      return Promise.resolve(state.result);
    },
  });
  return { supabase: { from: () => builder } };
});

import { publishedAgentService } from './agent.js';

beforeEach(() => {
  state.result = { data: [], error: null };
  state.calls.length = 0;
});

describe('WKH-313 · listPublisherAnchors', () => {
  it('devuelve el ancla de cada slug: `owner_ref` + `created_at`', async () => {
    state.result = {
      data: [
        {
          slug: 'a',
          owner_ref: 'owner-1',
          created_at: '2026-01-01T00:00:00Z',
        },
        {
          slug: 'b',
          owner_ref: 'owner-2',
          created_at: '2026-02-02T00:00:00Z',
        },
      ],
      error: null,
    };

    const res = await publishedAgentService.listPublisherAnchors(['a', 'b']);

    expect(res.degraded).toBe(false);
    if (res.degraded) return;
    expect(res.anchors.get('a')).toEqual({
      ownerRef: 'owner-1',
      createdAt: '2026-01-01T00:00:00Z',
    });
    expect(res.anchors.get('b')?.ownerRef).toBe('owner-2');
  });

  it('UN solo SELECT con `.in` + `.eq(enabled)` — anti-N+1 y sólo habilitados', async () => {
    await publishedAgentService.listPublisherAnchors(['a', 'b', 'c']);

    expect(state.calls).toEqual([
      { method: 'select', args: ['slug, owner_ref, created_at'] },
      { method: 'in', args: ['slug', ['a', 'b', 'c']] },
      { method: 'eq', args: ['enabled', true] },
    ]);
  });

  it('EL GUARD: un error de la query devuelve `{ degraded: true }`, NO un Map vacío', async () => {
    state.result = {
      data: null,
      error: { code: '42P01', message: 'relation missing' },
    };

    const res = await publishedAgentService.listPublisherAnchors(['a']);

    // Lo que se canda: que el fallo sea DISTINGUIBLE de "no tienen publicador".
    expect(res.degraded).toBe(true);
    expect(res).not.toHaveProperty('anchors');
  });

  it('sin error y sin filas es `degraded: false` (ausencia ≠ degradación)', async () => {
    state.result = { data: [], error: null };

    const res = await publishedAgentService.listPublisherAnchors(['a']);

    expect(res.degraded).toBe(false);
    if (!res.degraded) expect(res.anchors.size).toBe(0);
  });

  it('`slugs` vacío no consulta la DB y NO es una lectura degradada', async () => {
    const res = await publishedAgentService.listPublisherAnchors([]);

    expect(state.calls).toHaveLength(0);
    expect(res.degraded).toBe(false);
  });

  it('`data: null` sin error no rompe (devuelve Map vacío, no throw)', async () => {
    state.result = { data: null, error: null };

    const res = await publishedAgentService.listPublisherAnchors(['a']);

    expect(res.degraded).toBe(false);
    if (!res.degraded) expect(res.anchors.size).toBe(0);
  });
});
