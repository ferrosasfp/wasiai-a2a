/**
 * WKH-318 (W0.5) — el vocabulario de la honestidad del catálogo.
 *
 * Módulo puro: sin mocks, sin I/O. Lo que se fija acá es la distinción que la HU
 * existe para no perder — `failed` no es `rows: 0`, y `undefined` no es
 * `complete`.
 */

import { describe, expect, it } from 'vitest';
import type { DiscoverySource } from '../types/index.js';
import {
  buildCatalogStatus,
  classifyFetchFailure,
  describeIncompleteCatalog,
  isCatalogComplete,
  listFailedSources,
  RegistryHttpError,
} from './discovery-sources.js';

function src(
  name: string,
  state: DiscoverySource['state'],
  rows: number | null,
  failure?: DiscoverySource['failure'],
): DiscoverySource {
  const s: DiscoverySource = { name, state, rows };
  if (failure) s.failure = failure;
  return s;
}

describe('WKH-318 discovery-sources (módulo leaf)', () => {
  it('T-LIB-01: buildCatalogStatus([]) es complete — sin fuentes no hay nada que haya fallado', () => {
    expect(buildCatalogStatus([])).toBe('complete');
  });

  it('T-LIB-02: precedencia partial > truncated > unverified > complete', () => {
    expect(
      buildCatalogStatus([
        src('a', 'ok', 3),
        src('b', 'unverified', 20),
        src('c', 'truncated', 100),
        src('d', 'failed', null, 'http_error'),
      ]),
    ).toBe('partial');

    expect(
      buildCatalogStatus([
        src('a', 'ok', 3),
        src('b', 'unverified', 20),
        src('c', 'truncated', 100),
      ]),
    ).toBe('truncated');

    // AR BLQ-1: una sola fuente sin evidencia obtenible alcanza para que el
    // catálogo NO se pueda declarar completo.
    expect(
      buildCatalogStatus([src('a', 'ok', 3), src('b', 'unverified', 20)]),
    ).toBe('unverified');

    expect(buildCatalogStatus([src('a', 'ok', 3), src('b', 'ok', 0)])).toBe(
      'complete',
    );
  });

  it('T-LIB-04b (BLQ-1): `unverified` NO se lee como completo', () => {
    // El guard del corte B es fail-closed: "no sé" se rechaza igual que "falta".
    expect(isCatalogComplete({ catalogStatus: 'unverified' })).toBe(false);
  });

  it('T-LIB-03: classifyFetchFailure cubre las 5 clases nombradas; lo desconocido es unknown, nunca ok', () => {
    const ssrf = new Error('blocked');
    ssrf.name = 'SSRFViolationError';
    expect(classifyFetchFailure(ssrf)).toBe('ssrf_blocked');

    const open = new Error('circuit open');
    open.name = 'CircuitOpenError';
    expect(classifyFetchFailure(open)).toBe('circuit_open');

    expect(classifyFetchFailure(new RegistryHttpError('WasiAI', 400))).toBe(
      'http_error',
    );

    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(classifyFetchFailure(abort)).toBe('timeout');

    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    expect(classifyFetchFailure(timeout)).toBe('timeout');

    // Un Error que no reconocemos SIGUE siendo un fallo.
    expect(classifyFetchFailure(new Error('vaya a saber'))).toBe('unknown');
    // Y un no-Error también.
    expect(classifyFetchFailure('boom')).toBe('unknown');
    expect(classifyFetchFailure(null)).toBe('unknown');
    expect(classifyFetchFailure(undefined)).toBe('unknown');
  });

  it('T-LIB-04: isCatalogComplete es FAIL-CLOSED — undefined/null/{} son los tres false', () => {
    expect(isCatalogComplete(undefined)).toBe(false);
    expect(isCatalogComplete(null)).toBe(false);
    expect(isCatalogComplete({})).toBe(false);
    expect(isCatalogComplete({ catalogStatus: 'partial' })).toBe(false);
    expect(isCatalogComplete({ catalogStatus: 'truncated' })).toBe(false);
    expect(isCatalogComplete({ catalogStatus: 'complete' })).toBe(true);
  });

  it('T-LIB-05: describeIncompleteCatalog nombra fuente y motivo, y NUNCA dice "no agent"', () => {
    const msg = describeIncompleteCatalog([
      { name: 'WasiAI', failure: 'http_error' },
    ]);
    expect(msg).toContain('WasiAI');
    expect(msg).toContain('http_error');
    expect(msg.toLowerCase()).not.toContain('no agent');

    // Truncamiento sin fuentes caídas: sigue sin hablar de agentes.
    const truncMsg = describeIncompleteCatalog([]);
    expect(truncMsg.toLowerCase()).not.toContain('no agent');
  });

  it('T-LIB-06: RegistryHttpError conserva el mensaje byte-idéntico al Error genérico previo', () => {
    const err = new RegistryHttpError('WasiAI', 400);
    expect(err.message).toBe('Registry WasiAI returned 400');
    expect(err.name).toBe('RegistryHttpError');
    expect(err.status).toBe(400);
    expect(err).toBeInstanceOf(Error);
  });

  it('listFailedSources proyecta sólo las caídas y nunca pierde el motivo', () => {
    const failed = listFailedSources([
      src('WasiAI', 'failed', null, 'http_error'),
      src('self-published', 'ok', 3),
      // `failed` sin `failure` explícito: se declara `unknown`, no se omite.
      src('otra', 'failed', null),
    ]);
    expect(failed).toEqual([
      { name: 'WasiAI', failure: 'http_error' },
      { name: 'otra', failure: 'unknown' },
    ]);
  });
});
