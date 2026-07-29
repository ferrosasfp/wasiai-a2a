/**
 * HU-306 — el pipeline falló a mitad de camino y la plata que YA salió no vuelve.
 *
 * POR QUÉ EXISTE ESTE MÓDULO. Cuando `/compose` corta en el step `i`, los steps
 * `0..i-1` ya se ejecutaron y su pago ya se confirmó on-chain: el settle downstream
 * (gateway → agente) y, en el camino x402 sin agent key, también el settle inbound
 * (caller → `payTo` del agente). Ese dinero **no se reembolsa ni se reclama** — no hay
 * a quién pedírselo, la tx está minada. Hasta esta HU la única evidencia de que había
 * salido era `StepResult.downstreamTxHash`, que muere con la respuesta HTTP: nadie
 * podía contar cuánto se había ido, ni por qué, ni si estaba creciendo.
 *
 * ESTE MÓDULO NO MUEVE PLATA Y NO PUEDE MOVERLA. Es la aritmética y la forma de una
 * superficie de SOLO LECTURA (AC-7): calcula la cota de exposición, decide qué steps
 * cuentan como "pagados y varados", arma el evento durable y lo vuelve a leer.
 *
 * ⚠️ NO ES UN RIEL DE PAGO ALTERNATIVO. Ninguna función de acá crea saldo, crédito,
 * recarga ni liquidación diferida para NINGÚN agente, propio o de tercero (CD-1). El
 * pago por llamada sigue siendo el único método de cobro para todos por igual (AC-6).
 *
 * Módulo LEAF, por la misma razón que `compose-limits.ts` y `downstream-skip-code.ts`:
 * su ÚNICO import de runtime es `./compose-limits.js` (otro leaf). Media docena de
 * suites mockean los módulos gordos del money-path completos con factories sin
 * `importOriginal` — todo export no listado en esos mocks queda `undefined`. Un archivo
 * sin dependencias no puede quedar `undefined` en ninguna suite porque nadie lo mockea.
 *
 * NUNCA TIRA. Lo consumen un camino fire-and-forget (la emisión del evento, CD-9) y un
 * lector de filas viejas (CD-12): en los dos, una excepción se llevaría puesto algo que
 * no tiene nada que ver con el residuo que este módulo sólo observa.
 */

import type { StepResult } from '../types/index.js';
import { MAX_COMPOSE_STEPS } from './compose-limits.js';

/**
 * `event_type` de la fila durable que queda por cada run con pago varado.
 *
 * ⛔ PROHIBIDO agregarlo a `SETTLE_UNKNOWN_EVENT_TYPES` (CD-8). Son dos preguntas
 * distintas y mezclarlas corrompe la lista de HU-203:
 *   · `compose_settle_unknown` — el settle quedó SIN RESOLVER (no sabemos si salió).
 *   · `compose_stranded_payment` — el settle se CONFIRMÓ y el pipeline falló después.
 * La primera se reconcilia contra la cadena; la segunda ya está reconciliada y lo que
 * queda es contarla.
 */
export const COMPOSE_STRANDED_PAYMENT_EVENT = 'compose_stranded_payment';

/**
 * Cuántos steps de un pipeline pueden quedar pagados-y-varados, como máximo (AC-1).
 *
 * `- 1` porque el step que FALLA no deja residuo por sí mismo: si su propio settle quedó
 * sin resolver, eso es la otra pregunta —la cola `compose_settle_unknown` de HU-203— y
 * se cuenta allá. Acá sólo entran los steps que completaron.
 *
 * DERIVADO de `MAX_COMPOSE_STEPS`, nunca escrito como `4` a mano, por el motivo que
 * `compose-limits.ts` documenta: dos números sueltos divergen en silencio, y este
 * divergiría hacia abajo (afirmaríamos una cota menor que la real) justo después de que
 * alguien sube el límite de steps.
 */
export const MAX_STRANDABLE_STEPS = MAX_COMPOSE_STEPS - 1;

/**
 * Cota superior de exposición de UN pipeline, en USD (AC-1, re-computable por código —
 * CD-6: la fórmula vive acá y en `scripts/report-stranded-exposure.mjs`, no en prosa).
 *
 * ⚠️ LO QUE ESTA COTA **NO** ACOTA: `maxStepPriceUsd` es un dato de ENTRADA, no un techo
 * del repo. Hoy no existe ningún `MAX_PRICE` por agente, así que la cota es una MEDICIÓN
 * del catálogo vivo (el `max(priceUsdc)` de `/discover`), no una garantía estructural.
 * El techo por pipeline existe (`resolveEffectivePipelineBudgetUsd`) pero se entrega
 * SIN configurar, a propósito: ver su docstring.
 */
export function maxStrandedExposureUsd(maxStepPriceUsd: number): number {
  return MAX_STRANDABLE_STEPS * maxStepPriceUsd;
}

/**
 * Umbral de alerta recomendado (AC-5): 10 pipelines varados completos dentro de la
 * ventana. El factor 10 es deliberadamente holgado — la alerta existe para detectar
 * ACUMULACIÓN sistémica (un rail caído, un agente que rompe a todos), no un run aislado,
 * que es residuo normal y esperado de un sistema distribuido.
 */
export function recommendedAlertThresholdUsd(maxStepPriceUsd: number): number {
  return 10 * maxStrandedExposureUsd(maxStepPriceUsd);
}

/** Qué prueba on-chain tenemos de que ese step se pagó. */
export type StrandedEvidence = 'downstream' | 'inbound' | 'both';

/**
 * Un step pagado y varado, EN LA FORMA EN QUE VIAJA A `metadata.paid_steps[]` (snake_case:
 * es JSON persistido, no un objeto de dominio). El lector lo devuelve con esta MISMA forma,
 * así que la ida y la vuelta no pueden divergir.
 */
export interface StrandedPaidStep {
  /** Índice del step dentro del pipeline (0-based). */
  step: number;
  agent_slug: string | null;
  registry: string | null;
  /** Cadena declarada por la ficha del agente, cuando la trae. */
  chain: string | null;
  /** USD que el caller pagó por ese step. Número, no string: sale de `StepResult`. */
  cost_usdc: number;
  /**
   * `downstreamSettledAmount` **VERBATIM, sin convertir**. Es una cantidad ATÓMICA y los
   * decimals de la cadena de ese leg no viajan en `StepResult`: dividir por `1e6` acá
   * sería fabricar un número de dinero para un rail que quizá no tiene 6 decimales.
   */
  settled_atomic: string | null;
  /**
   * La prueba on-chain principal. Con `evidence: 'both'` es el hash **DOWNSTREAM** (el
   * pago al agente); el hash INBOUND de ese mismo step queda igual de durable en la fila
   * `compose_step` del run, que lleva el mismo `compose_run_id` — se recupera por join,
   * no se pierde.
   */
  tx_hash: string | null;
  evidence: StrandedEvidence;
}

function nonEmpty(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * Qué steps de un pipeline fallido dejaron plata afuera (AC-2 + AC-8).
 *
 * Recibe SÓLO los steps COMPLETADOS (`ComposeResult.steps`, que se puebla nada más que
 * en `finishSuccessfulStep`), así que el step que falló no está en la lista por
 * construcción — no hay que excluirlo, nunca llegó.
 *
 * Los dos ejes de evidencia son pagos on-chain REALES y distintos:
 *   · `downstreamTxHash` — settle del gateway al agente (camino con agent key).
 *   · `txHash` — settle inbound x402: en el camino SIN `a2aKey` es un pago real al
 *     `payTo` del agente (AC-8). Contar sólo el primero subestimaría el residuo
 *     exactamente en el camino anónimo, que es el que no tiene débito per-step.
 *
 * Puro y total: sin I/O, sin `throw`. Un step sin ninguna evidencia no entra.
 */
export function collectStrandedSteps(
  steps: readonly StepResult[],
): StrandedPaidStep[] {
  const out: StrandedPaidStep[] = [];
  for (const [index, step] of steps.entries()) {
    if (!step) continue;
    const downstreamTx = nonEmpty(step.downstreamTxHash);
    const inboundTx = nonEmpty(step.txHash);
    if (!downstreamTx && !inboundTx) continue;
    const evidence: StrandedEvidence =
      downstreamTx && inboundTx
        ? 'both'
        : downstreamTx
          ? 'downstream'
          : 'inbound';
    out.push({
      step: index,
      agent_slug: nonEmpty(step.agent?.slug),
      registry: nonEmpty(step.agent?.registry),
      chain: nonEmpty(step.agent?.payment?.chain),
      cost_usdc: typeof step.costUsdc === 'number' ? step.costUsdc : 0,
      settled_atomic: nonEmpty(step.downstreamSettledAmount),
      tx_hash: downstreamTx ?? inboundTx,
      evidence,
    });
  }
  return out;
}

/** Techo del `error` que se persiste: un mensaje largo no aporta y engorda la fila. */
const ERROR_MAX_CHARS = 500;

/**
 * Arma el input de `eventService.track()` del run varado. PURA (no importa el event
 * service) por el mismo motivo que `buildSettleUnknownEvent`: el módulo sigue siendo un
 * leaf y la forma de la fila se arma en un solo lugar.
 *
 * Decisiones que NO son cosméticas:
 *
 * · `txHash` es el del **PRIMER** step varado, y **es el primero de N**. Una columna que
 *   dice "el hash" cuando hay varios miente por omisión, así que queda dicho acá y la
 *   lista COMPLETA viaja en `metadata.paid_steps[]`, que es la fuente para reconciliar.
 *
 * · `agentId` / `agentName` / `registry` se OMITEN (⟹ columna NULL) A PROPÓSITO. El
 *   agente que rompió el pipeline no está en `ComposeResult` —sólo su índice—, así que
 *   lo único que podríamos poner ahí es el primero que COBRÓ: durante un incidente el
 *   panel señalaría al agente equivocado. El culpable se recupera por join con
 *   `compose_run_id` contra las filas `compose_step` del mismo run.
 *
 * · `costUsdc` va en USD (no atómico): es la suma de `cost_usdc` de los steps varados,
 *   que es lo que el caller pagó. `metadata.stranded_usd` repite el número A PROPÓSITO:
 *   si al leer la columna `NUMERIC` diverge del valor del JSON, hay un bug de precisión
 *   (lección WKH-196, que costó un epic entero).
 */
export function buildStrandedPaymentEvent(input: {
  composeRunId: string;
  strandedSteps: readonly StrandedPaidStep[];
  /** Índice del step que falló = cantidad de steps completados. */
  failedStepIndex: number;
  error?: string | undefined;
  errorCode?: string | undefined;
}): {
  eventType: string;
  status: 'failed';
  costUsdc: number;
  txHash?: string | undefined;
  metadata: Record<string, unknown>;
} {
  const strandedUsd = input.strandedSteps.reduce(
    (acc, s) => acc + (Number.isFinite(s.cost_usdc) ? s.cost_usdc : 0),
    0,
  );
  const firstTxHash = input.strandedSteps.find(
    (s) => s.tx_hash !== null,
  )?.tx_hash;
  return {
    eventType: COMPOSE_STRANDED_PAYMENT_EVENT,
    status: 'failed',
    costUsdc: strandedUsd,
    ...(firstTxHash ? { txHash: firstTxHash } : {}),
    metadata: {
      compose_run_id: input.composeRunId,
      failed_step_index: input.failedStepIndex,
      error_code: input.errorCode ?? null,
      error:
        typeof input.error === 'string'
          ? input.error.slice(0, ERROR_MAX_CHARS)
          : null,
      stranded_usd: strandedUsd,
      paid_steps: input.strandedSteps,
    },
  };
}

function readNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function readPaidStep(raw: unknown): StrandedPaidStep | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const step = readNumber(r.step);
  if (step === null) return null;
  const evidence = r.evidence;
  return {
    step,
    agent_slug: nonEmpty(r.agent_slug),
    registry: nonEmpty(r.registry),
    chain: nonEmpty(r.chain),
    cost_usdc: readNumber(r.cost_usdc) ?? 0,
    settled_atomic: nonEmpty(r.settled_atomic),
    tx_hash: nonEmpty(r.tx_hash),
    evidence:
      evidence === 'downstream' || evidence === 'inbound' || evidence === 'both'
        ? evidence
        : 'downstream',
  };
}

/**
 * Lee el `metadata` de una fila `compose_stranded_payment` ya persistida (CD-12).
 *
 * DEFENSIVO Y PURO, y no por prolijidad: `a2a_events.metadata` es `jsonb` sin esquema, y
 * este lector corre sobre filas que pueden ser VIEJAS (escritas por una versión anterior)
 * o estar mal formadas. Si tirara, una sola fila rara volteando el mapeo dejaría la lista
 * ENTERA vacía — que es devolver `[]` por la puerta de atrás, exactamente lo que AC-4
 * prohíbe por la puerta de adelante.
 *
 * Ante cualquier forma inesperada: `null` / `[]`. Nunca `throw`.
 */
export function readStrandedMetadata(metadata: unknown): {
  runId: string | null;
  failedStepIndex: number | null;
  paidSteps: StrandedPaidStep[];
} {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { runId: null, failedStepIndex: null, paidSteps: [] };
  }
  const m = metadata as Record<string, unknown>;
  const rawSteps = Array.isArray(m.paid_steps) ? m.paid_steps : [];
  const paidSteps: StrandedPaidStep[] = [];
  for (const raw of rawSteps) {
    const parsed = readPaidStep(raw);
    if (parsed) paidSteps.push(parsed);
  }
  return {
    runId: nonEmpty(m.compose_run_id),
    failedStepIndex: readNumber(m.failed_step_index),
    paidSteps,
  };
}

/**
 * Techo de exposición POR PIPELINE, en USD (AC-1). Se entrega **SIN CONFIGURAR**.
 *
 * `min(maxBudget declarado por el caller, techo del gateway)`, con `+Infinity` como
 * neutro de los dos lados. Con la env sin setear y sin `maxBudget`, el resultado es
 * `+Infinity` ⟹ el guard de presupuesto de `compose` nunca dispara ⟹ comportamiento
 * BYTE-IDÉNTICO al de antes de esta HU, incluido que `maxBudget: 0` sigue significando
 * "sin límite" (`0 || Infinity`), que es la semántica que ese guard ya tenía.
 *
 * ⛔ POR QUÉ SE ENTREGA APAGADA. Elegir el número hoy sería fijarlo sin un solo dato de
 * exposición real, y medir ese dato es el motivo de existir de esta HU. Un techo
 * demasiado bajo RECHAZA TRÁFICO LEGÍTIMO Y YA PAGADO: un daño mayor, y de signo
 * opuesto, al que se quiere evitar. El gatillo para elegirlo está en el runbook
 * (2 semanas de datos + `scripts/report-stranded-exposure.mjs`).
 *
 * Lee la env EN CADA LLAMADA (patrón `getDriftThresholdAtomic`): un valor cacheado al
 * importar el módulo haría que el techo dependiera del orden de carga de módulos.
 */
export function resolveEffectivePipelineBudgetUsd(
  callerMaxBudget: number | undefined,
): number {
  const raw = process.env.PIPELINE_EXPOSURE_CEILING_USD;
  const parsed = raw && raw.trim() !== '' ? Number(raw.trim()) : Number.NaN;
  const ceiling =
    Number.isFinite(parsed) && parsed > 0 ? parsed : Number.POSITIVE_INFINITY;
  const caller = callerMaxBudget || Number.POSITIVE_INFINITY;
  return Math.min(caller, ceiling);
}
