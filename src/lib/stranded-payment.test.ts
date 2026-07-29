/**
 * HU-306 — unit del leaf `stranded-payment`.
 *
 * Lo que se afirma acá es ARITMÉTICA DE DINERO y forma de una fila durable, no
 * "la función devolvió algo". Un rojo de este archivo se lee como: "la cota de
 * exposición que publicamos no es la que el código puede producir", o "el evento que
 * queda escrito no alcanza para reconciliar".
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent, StepResult } from '../types/index.js';
import { MAX_COMPOSE_STEPS } from './compose-limits.js';
import {
  buildStrandedPaymentEvent,
  COMPOSE_STRANDED_PAYMENT_EVENT,
  collectStrandedSteps,
  isPipelineCeilingMisconfigured,
  MAX_ORCHESTRATE_AGENTS,
  MAX_STRANDABLE_STEPS,
  MAX_STRANDABLE_STEPS_ANY_PATH,
  maxStrandedExposureUsd,
  readStrandedMetadata,
  recommendedAlertThresholdUsd,
  resolveEffectivePipelineBudgetUsd,
} from './stranded-payment.js';

const CEILING_ENV = 'PIPELINE_EXPOSURE_CEILING_USD';

afterEach(() => {
  delete process.env[CEILING_ENV];
});

function makeAgent(o: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Agent One',
    slug: 'agent-one',
    description: '',
    capabilities: [],
    priceUsdc: 1,
    registry: 'wasiai',
    registry_id: 'reg-1',
    invokeUrl: 'https://example.test/invoke',
    invocationNote: '',
    verified: true,
    status: 'active',
    ...o,
  } as Agent;
}

function makeStep(o: Partial<StepResult> = {}): StepResult {
  return {
    agent: makeAgent(),
    output: null,
    costUsdc: 1,
    latencyMs: 10,
    ...o,
  };
}

// ── AC-1: la cota ──────────────────────────────────────────────

describe('HU-306 · la cota de exposición es computable, no prosa', () => {
  it('T-COTA-01: MAX_STRANDABLE_STEPS se DERIVA de MAX_COMPOSE_STEPS (y hoy vale 4)', () => {
    // Las dos aserciones son necesarias y afirman cosas distintas: la primera fija la
    // DERIVACIÓN (subir el límite de steps mueve la cota sola), la segunda el VALOR de
    // hoy (subirlo no pasa desapercibido). Mismo patrón que `compose-limits`.
    expect(MAX_STRANDABLE_STEPS).toBe(MAX_COMPOSE_STEPS - 1);
    expect(MAX_STRANDABLE_STEPS).toBe(4);
  });

  it('T-COTA-01b: la cota SIGUE a MAX_COMPOSE_STEPS — no es un 4 escrito a mano (AR MENOR-2)', async () => {
    // T-COTA-01 no puede distinguir la derivación de un literal mientras los dos valgan
    // 4: `4 === MAX_COMPOSE_STEPS - 1` pasa igual. La única forma de fijar la
    // DERIVACIÓN es mover el número del que depende y ver que la cota se mueve sola.
    // Sin esto, cambiar `MAX_COMPOSE_STEPS - 1` por `4` no rompía ningún test, que es
    // exactamente el "dos números que divergen en silencio" que el docstring del módulo
    // dice estar evitando.
    vi.resetModules();
    vi.doMock('./compose-limits.js', () => ({ MAX_COMPOSE_STEPS: 9 }));
    try {
      const fresh = await import('./stranded-payment.js');
      expect(fresh.MAX_STRANDABLE_STEPS).toBe(8);
      // …y todo lo que se deriva de ella también se mueve.
      expect(fresh.maxStrandedExposureUsd(2)).toBe(16);
    } finally {
      vi.doUnmock('./compose-limits.js');
      vi.resetModules();
    }
  });

  it('T-COTA-03: el tope de /orchestrate espeja el schema REAL de la ruta (AR MENOR-1)', () => {
    // El camino insignia no pasa por el guard de `MAX_COMPOSE_STEPS`: `/orchestrate`
    // acota por `maxAgents` y llama a compose() directo. Si ese schema sube y este
    // número no, el reporte de exposición subestima y nadie se entera. Por eso el
    // número no se "documenta": se verifica contra el fuente de la ruta.
    const HERE = dirname(fileURLToPath(import.meta.url));
    const route = readFileSync(
      join(HERE, '..', 'routes', 'orchestrate.ts'),
      'utf8',
    );
    const maximos = [
      ...route.matchAll(/maxAgents:\s*\{[^}]*maximum:\s*(\d+)/g),
    ].map((m) => Number(m[1]));
    // Premisa: los encontramos de verdad (si la forma del schema cambia, este test
    // avisa en vez de pasar por vacío).
    expect(maximos.length).toBeGreaterThanOrEqual(3);
    expect([...new Set(maximos)]).toEqual([MAX_ORCHESTRATE_AGENTS]);
    // …y la cota que usa cualquier reporte es el PEOR caso de los dos caminos.
    expect(MAX_STRANDABLE_STEPS_ANY_PATH).toBe(MAX_ORCHESTRATE_AGENTS - 1);
    expect(MAX_STRANDABLE_STEPS_ANY_PATH).toBeGreaterThan(MAX_STRANDABLE_STEPS);
  });

  it('T-COTA-02: la cota es pasos × precio, y el umbral recomendado es 10 × cota', () => {
    expect(maxStrandedExposureUsd(0.25)).toBeCloseTo(1, 10);
    expect(maxStrandedExposureUsd(3)).toBe(12);
    expect(maxStrandedExposureUsd(0)).toBe(0);
    expect(recommendedAlertThresholdUsd(3)).toBe(120);
    expect(recommendedAlertThresholdUsd(3)).toBe(
      10 * maxStrandedExposureUsd(3),
    );
  });

  it('T-CEILING-03: maxBudget 0 sigue siendo "sin límite"; con los dos, ata el MENOR', () => {
    // (a) env sin setear ⟹ manda el caller; `0` es "sin límite" (semántica ya vigente).
    expect(resolveEffectivePipelineBudgetUsd(undefined)).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(resolveEffectivePipelineBudgetUsd(0)).toBe(Number.POSITIVE_INFINITY);
    expect(resolveEffectivePipelineBudgetUsd(7)).toBe(7);

    // (b) con techo configurado ata el MENOR de los dos, en las dos direcciones.
    process.env[CEILING_ENV] = '5';
    expect(resolveEffectivePipelineBudgetUsd(7)).toBe(5);
    expect(resolveEffectivePipelineBudgetUsd(2)).toBe(2);
    expect(resolveEffectivePipelineBudgetUsd(undefined)).toBe(5);
    expect(resolveEffectivePipelineBudgetUsd(0)).toBe(5);
  });

  it('T-CEILING-05: un techo ilegible se DELATA (fail-open, pero no mudo)', () => {
    // Sin esto, `PIPELINE_EXPOSURE_CEILING_USD=1O` (con una O) y la env sin setear se
    // comportan igual y se VEN igual: el operador creería tener un techo puesto.
    delete process.env[CEILING_ENV];
    expect(isPipelineCeilingMisconfigured()).toBe(false);
    for (const raw of ['', '   ']) {
      process.env[CEILING_ENV] = raw;
      // vacío = "no configurado", no es un typo
      expect(isPipelineCeilingMisconfigured()).toBe(false);
    }
    for (const raw of ['1O', 'abc', '0', '-3', 'NaN']) {
      process.env[CEILING_ENV] = raw;
      expect(isPipelineCeilingMisconfigured()).toBe(true);
      // …y sigue sin acotar: se avisa, no se rompe el tráfico
      expect(resolveEffectivePipelineBudgetUsd(9)).toBe(9);
    }
    process.env[CEILING_ENV] = '5';
    expect(isPipelineCeilingMisconfigured()).toBe(false);
  });

  it('T-CEILING-04: un techo inválido o no positivo NO acota (fail-open declarado)', () => {
    // Un techo que se cae a 0 por un typo RECHAZARÍA TODO el tráfico. Ante un valor
    // ilegible el gateway prefiere no acotar y que la señal salga por la alerta.
    for (const raw of ['', '   ', 'abc', '0', '-3', 'NaN', 'Infinity']) {
      process.env[CEILING_ENV] = raw;
      expect(resolveEffectivePipelineBudgetUsd(undefined)).toBe(
        Number.POSITIVE_INFINITY,
      );
      expect(resolveEffectivePipelineBudgetUsd(9)).toBe(9);
    }
  });
});

// ── AC-2 / AC-8: qué cuenta como pagado y varado ───────────────

describe('HU-306 · qué steps dejaron plata afuera', () => {
  it('cuenta el settle downstream, el inbound x402, y marca cuál fue', () => {
    const steps = [
      makeStep({
        downstreamTxHash: '0xDOWN',
        downstreamSettledAmount: '30000',
      }),
      makeStep({ txHash: '0xIN' }),
      makeStep({ downstreamTxHash: '0xD2', txHash: '0xI2' }),
    ];
    const out = collectStrandedSteps(steps);
    expect(out.map((s) => s.evidence)).toEqual([
      'downstream',
      'inbound',
      'both',
    ]);
    expect(out.map((s) => s.step)).toEqual([0, 1, 2]);
    // `settled_atomic` VERBATIM: no se divide por 1e6 (los decimals del leg no viajan).
    expect(out[0]?.settled_atomic).toBe('30000');
    expect(out[1]?.settled_atomic).toBeNull();
    // con las dos evidencias, el hash principal es el DOWNSTREAM (el pago al agente).
    expect(out[2]?.tx_hash).toBe('0xD2');
  });

  it('un step SIN evidencia on-chain no entra (no todo fallo deja residuo)', () => {
    expect(
      collectStrandedSteps([makeStep(), makeStep({ txHash: '   ' })]),
    ).toEqual([]);
    expect(collectStrandedSteps([])).toEqual([]);
  });

  it('copia el agente y la cadena de la ficha, sin inventarlos', () => {
    const [row] = collectStrandedSteps([
      makeStep({
        agent: makeAgent({
          slug: 'remit-corridor-fx',
          registry: 'wasiai',
          payment: {
            method: 'x402',
            chain: 'solana-devnet',
            contract: 'So1111',
          },
        }),
        costUsdc: 0.03,
        downstreamTxHash: '0xabc',
      }),
    ]);
    expect(row).toMatchObject({
      agent_slug: 'remit-corridor-fx',
      registry: 'wasiai',
      chain: 'solana-devnet',
      cost_usdc: 0.03,
    });
    // sin `payment` en la ficha, la cadena queda null en vez de un default inventado.
    const [noChain] = collectStrandedSteps([
      makeStep({ downstreamTxHash: '0xabc' }),
    ]);
    expect(noChain?.chain).toBeNull();
  });
});

// ── AC-3: la fila durable ──────────────────────────────────────

describe('HU-306 · el evento que queda escrito alcanza para reconciliar', () => {
  const stranded = collectStrandedSteps([
    makeStep({ costUsdc: 0.02, downstreamTxHash: '0xPRIMERO' }),
    makeStep({ costUsdc: 0.03, downstreamTxHash: '0xSEGUNDO' }),
  ]);

  it('suma en USD, apunta al PRIMER hash y no le pone dueño a la fila', () => {
    const ev = buildStrandedPaymentEvent({
      composeRunId: 'run-1',
      strandedSteps: stranded,
      failedStepIndex: 2,
      error: 'Step 2 failed: boom',
      errorCode: 'DEST_CAP_EXCEEDED',
    });
    expect(ev.eventType).toBe(COMPOSE_STRANDED_PAYMENT_EVENT);
    expect(ev.status).toBe('failed');
    expect(ev.costUsdc).toBeCloseTo(0.05, 10);
    expect(ev.txHash).toBe('0xPRIMERO');
    // agentId/agentName/registry AUSENTES a propósito: el agente culpable no está en
    // ComposeResult y poner al primero que cobró señalaría al equivocado.
    expect(ev).not.toHaveProperty('agentId');
    expect(ev).not.toHaveProperty('agentName');
    expect(ev).not.toHaveProperty('registry');
    expect(ev.metadata.compose_run_id).toBe('run-1');
    expect(ev.metadata.failed_step_index).toBe(2);
    expect(ev.metadata.error_code).toBe('DEST_CAP_EXCEEDED');
    expect(ev.metadata.paid_steps).toHaveLength(2);
    // redundante A PROPÓSITO: si diverge de la columna NUMERIC hay bug de precisión.
    expect(ev.metadata.stranded_usd).toBe(ev.costUsdc);
  });

  it('trunca el error a 500 chars y admite un run sin errorCode', () => {
    const ev = buildStrandedPaymentEvent({
      composeRunId: 'run-2',
      strandedSteps: stranded,
      failedStepIndex: 2,
      error: 'x'.repeat(900),
    });
    expect((ev.metadata.error as string).length).toBe(500);
    expect(ev.metadata.error_code).toBeNull();
  });

  it('sin hashes no inventa un txHash de nivel superior', () => {
    const ev = buildStrandedPaymentEvent({
      composeRunId: 'run-3',
      strandedSteps: [],
      failedStepIndex: 0,
    });
    expect(ev).not.toHaveProperty('txHash');
    expect(ev.costUsdc).toBe(0);
  });
});

// ── CD-12: el lector es defensivo ──────────────────────────────

describe('HU-306 · leer una fila vieja o rota no puede voltear la lista', () => {
  it('ida y vuelta: lo que se escribe es lo que se lee', () => {
    const ev = buildStrandedPaymentEvent({
      composeRunId: 'run-9',
      strandedSteps: collectStrandedSteps([
        makeStep({ costUsdc: 0.02, downstreamTxHash: '0xa', txHash: '0xb' }),
      ]),
      failedStepIndex: 1,
    });
    const read = readStrandedMetadata(ev.metadata);
    expect(read.runId).toBe('run-9');
    expect(read.failedStepIndex).toBe(1);
    expect(read.paidSteps).toEqual([
      {
        step: 0,
        agent_slug: 'agent-one',
        registry: 'wasiai',
        chain: null,
        cost_usdc: 0.02,
        settled_atomic: null,
        tx_hash: '0xa',
        evidence: 'both',
      },
    ]);
  });

  it('T-STRAND-DEFENSIVE (unit): metadata null/array/basura ⟹ vacío, nunca throw', () => {
    for (const raw of [
      null,
      undefined,
      [],
      'texto',
      42,
      { paid_steps: 'no' },
    ]) {
      const read = readStrandedMetadata(raw);
      expect(read).toEqual({
        runId: null,
        failedStepIndex: null,
        paidSteps: [],
      });
    }
  });

  it('descarta SÓLO el item roto, no la fila entera', () => {
    const read = readStrandedMetadata({
      compose_run_id: 'run-x',
      failed_step_index: 3,
      paid_steps: [
        null,
        { step: 'uno' },
        { step: 1, agent_slug: 'ok', tx_hash: '0x1', evidence: 'inbound' },
        'basura',
      ],
    });
    expect(read.runId).toBe('run-x');
    expect(read.paidSteps).toHaveLength(1);
    expect(read.paidSteps[0]).toMatchObject({
      step: 1,
      agent_slug: 'ok',
      evidence: 'inbound',
    });
  });
});
