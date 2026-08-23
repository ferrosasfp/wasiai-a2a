/**
 * Suspended Run Service — WKH-225 (un paso de /compose que espera a una persona).
 *
 * El estado de un pipeline suspendido vive ACÁ, en el Coordinador, y no en el
 * cliente. Si el Coordinador orquesta, el estado es suyo; si lo delegáramos al
 * cliente, volveríamos exactamente al problema que esta HU cierra —un agente
 * consumido por fuera del carril de pago porque el modelo pedido-respuesta no
 * sabía expresar la espera.
 *
 * Atomicidad: el claim `suspended→resuming` ocurre DENTRO del RPC, bajo
 * `FOR UPDATE`. N resumes concurrentes ⇒ exactamente 1 ejecuta la cola del
 * pipeline; el resto pierde el lock-race. El settle es exactly-once
 * (status-gated). Es el mismo patrón que WKH-137, y por el mismo motivo.
 *
 * ── LAS TRES REGLAS QUE ESTE ARCHIVO HEREDA (`adapters/solana/settle-ledger.ts`)
 *
 *  1. ESCRITURA CONDICIONAL ATÓMICA. Nunca un `SELECT` que decide y un
 *     `UPDATE` que ejecuta: entre los dos entra otro proceso. Y el reloj del
 *     vencimiento es el de POSTGRES, no el de Node.
 *  2. FAIL-CLOSED. Cliente caído, RPC que tira, error de Postgres, `data`
 *     vacío, forma inesperada: todo eso es "no sé", y "no sé" nunca autoriza a
 *     seguir ejecutando un pipeline que ya cobró.
 *  3. NINGUNA FUNCIÓN DEVUELVE `boolean`. Un `false` colapsa "el guard lo
 *     rechazó" / "la escritura falló" / "el store no está", que tienen remedios
 *     DISTINTOS: el primero lo arregla el caller, el segundo el operador, el
 *     tercero es un incidente. Uniones discriminadas siempre.
 *
 * ── OWNERSHIP GUARD (app-layer)
 *
 * El cliente usa `SUPABASE_SERVICE_KEY`, que bypassea RLS: el guard real es el
 * `.eq('owner_ref', ownerId)` de cada cadena. Toda firma que reciba un id de
 * fila recibe además un `ownerId: string` — nunca `string | undefined`, porque
 * un `undefined` que se filtre convierte el guard en un no-op silencioso.
 *
 * ⚠️ Y las DOS RPC quedan ENTERAS fuera del guardián automático, que no mira
 * los `supabase.rpc(...)`. Ahí el filtro vive dentro del SQL
 * (`v_owner IS DISTINCT FROM p_owner_ref`) y lo único que lo verifica son los
 * tests de este service y los del `.sql`.
 */

import { randomUUID } from 'node:crypto';
import { getLogger } from '../lib/logger.js';
import {
  type ResumeTokenCaller,
  resolveSuspendTtlSeconds,
  resumeTokenHash,
  signResumeToken,
} from '../lib/resume-token.js';
import {
  buildStrandedPaymentEvent,
  collectStrandedSteps,
} from '../lib/stranded-payment.js';
import { supabase } from '../lib/supabase.js';
import type { Database } from '../types/database.types.js';
import type {
  StepResult,
  SuspendedRunClaim,
  SuspendedRunRow,
} from '../types/index.js';
import { eventService } from './event.js';

const log = getLogger('suspended-run');

/** Alias del JSONB tal como lo declara el archivo de tipos generado. */
type JsonColumn =
  Database['public']['Tables']['a2a_suspended_runs']['Insert']['steps_json'];

/**
 * `unknown` → columna JSONB, con `undefined` colapsado a `null`.
 *
 * El colapso es deliberado y no una conveniencia de tipos: con
 * `exactOptionalPropertyTypes`, mandar `undefined` en un campo del `Insert` no
 * es "no mandar el campo" —es mandarlo indefinido—, y lo que queremos decir
 * cuando el pipeline no traía traza de contratación es que la columna es NULA.
 * Son la misma fila; el que no lo son es el tipo.
 */
function asJsonColumn(value: unknown): JsonColumn {
  return (value ?? null) as JsonColumn;
}

/**
 * Lo que hace falta para abrir un run suspendido. Todo sale del pipeline que
 * acaba de suspender; nada de acá lo elige el caller salvo el `ttlSeconds`.
 */
export interface OpenSuspendedRunInput {
  caller: ResumeTokenCaller;
  ownerRef: string;
  keyId: string;
  composeRunId: string;
  /** Índice del step que suspendió. Ese step SÍ se ejecutó y SÍ se pagó. */
  stepIndex: number;
  /** Los `StepResult` COMPLETOS de lo ya ejecutado, sin reducir. */
  steps: readonly StepResult[];
  lastOutput: unknown;
  /** Los steps que faltan, tal como los resolvió el pipeline. */
  remainingSteps: unknown;
  frozenStepPrices: unknown;
  totalCostUsdc: number;
  totalLatencyMs: number;
  contractingChain: unknown;
  contractingDepth: number;
  selfHostHint: string | null;
  chainId: number | null;
  ttlSeconds: number | undefined;
  /** CD-15: vencimiento de la garantía del quote que congeló precios, si hubo. */
  frozenPricesExpireAtMs: number | undefined;
}

/**
 * ⛔ CD-22 — ni `boolean` ni `null`. `reason` separa las tres cosas que un
 * `false` colapsaría, y `no_secret` está aparte de `write_failed` a propósito:
 * la primera la arregla el operador poniendo una variable, la segunda es una
 * base que no responde.
 */
export type OpenSuspendedRunResult =
  | { ok: true; runId: string; token: string; expiresAt: string }
  | {
      ok: false;
      reason: 'invalid_ttl' | 'no_secret' | 'write_failed';
      detail?: string;
    };

/**
 * ⛔ CD-22. `not_found` cubre TAMBIÉN el dueño ajeno, y no por comodidad: el
 * RPC levanta el mismo literal en los dos casos justamente para que acá no
 * exista la distinción que después se filtraría por HTTP.
 */
export type ClaimSuspendedRunResult =
  | { ok: true; run: SuspendedRunClaim }
  | {
      ok: false;
      reason: 'not_found' | 'expired' | 'already_used' | 'unavailable';
    };

/** ⛔ CD-22. */
export type SettleSuspendedRunResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'ownership_mismatch' | 'not_found' | 'unavailable';
    };

/** ⛔ CD-22. Una lista vacía y una lectura fallida NO son lo mismo. */
export type ListSuspendedRunsResult =
  | { ok: true; rows: SuspendedRunRow[] }
  | { ok: false; reason: 'unavailable' };

/** Las columnas que la fila expone hacia afuera del service. */
const ROW_COLUMNS =
  'id, token_hash, owner_ref, key_id, caller_kind, caller_id, compose_run_id, ' +
  'step_index, steps_json, last_output, remaining_steps, frozen_step_prices, ' +
  'total_cost_usdc::text, total_latency_ms, contracting_chain, ' +
  'contracting_depth, self_host_hint, chain_id, status, ttl_seconds, ' +
  'expires_at, resumed_at, error_message, created_at, updated_at';

export const suspendedRunService = {
  /**
   * Abre el run suspendido y devuelve el token de reanudación UNA sola vez.
   *
   * 🔴 EL `id` SE GENERA EN NODE Y SE MANDA EN EL INSERT, aunque la columna
   * tenga `DEFAULT gen_random_uuid()`. No es preferencia: el payload firmado
   * lleva el id de la fila, así que hay que conocerlo ANTES de firmar, y firmar
   * después del insert dejaría una ventana en la que la fila existe sin token
   * emitible. Con el id propio, o salen las dos cosas o no sale ninguna.
   *
   * ⛔ NO SE PERSISTE EL TOKEN, sólo su SHA-256 (la columna es `token_hash`,
   * `UNIQUE`). Una filtración de la base no entrega runs reanudables.
   *
   * ⛔ Y `expires_at` NO se calcula acá. Se manda `ttl_seconds` y el instante lo
   * escribe el trigger con el reloj de Postgres (CD-19). Lo que devolvemos es
   * lo que la BASE escribió, releído del insert — no una copia de lo que este
   * proceso hubiera calculado.
   */
  async open(input: OpenSuspendedRunInput): Promise<OpenSuspendedRunResult> {
    const ttl = resolveSuspendTtlSeconds(input.ttlSeconds);
    if (ttl === null) {
      return { ok: false, reason: 'invalid_ttl' };
    }

    const runId = randomUUID();
    const signed = signResumeToken({
      runId,
      caller: input.caller,
      ttlSeconds: ttl,
    });
    if (signed === null) {
      // Sin secreto configurado no se emite NINGÚN token. Fail-closed: sin
      // token no hay reanudación posible, así que tampoco se abre la fila.
      return { ok: false, reason: 'no_secret' };
    }

    const row: Database['public']['Tables']['a2a_suspended_runs']['Insert'] = {
      id: runId,
      token_hash: resumeTokenHash(signed.token),
      owner_ref: input.ownerRef,
      key_id: input.keyId,
      caller_kind: input.caller.kind,
      caller_id: input.caller.id,
      compose_run_id: input.composeRunId,
      step_index: input.stepIndex,
      steps_json: asJsonColumn(input.steps),
      last_output: asJsonColumn(input.lastOutput),
      remaining_steps: asJsonColumn(input.remainingSteps),
      frozen_step_prices: asJsonColumn(input.frozenStepPrices),
      total_cost_usdc: input.totalCostUsdc,
      total_latency_ms: Math.max(0, Math.round(input.totalLatencyMs)),
      contracting_chain: asJsonColumn(input.contractingChain),
      contracting_depth: input.contractingDepth,
      self_host_hint: input.selfHostHint,
      chain_id: input.chainId,
      ttl_seconds: ttl,
      frozen_prices_expires_at:
        input.frozenPricesExpireAtMs === undefined
          ? null
          : new Date(input.frozenPricesExpireAtMs).toISOString(),
    };

    const { data, error } = await supabase
      .from('a2a_suspended_runs')
      .insert(row)
      .select('id, expires_at')
      .single();

    if (error || !data) {
      // ⛔ El token NO entra al log (CD-8). El `runId` sí: es lo único de este
      // camino que se puede escribir en un canal de operador.
      log.error(
        { runId, detail: error?.message },
        '[suspended-run.open] the step suspended and had already been paid, but the state could NOT be persisted',
      );
      return {
        ok: false,
        reason: 'write_failed',
        ...(error?.message === undefined ? {} : { detail: error.message }),
      };
    }

    return {
      ok: true,
      runId,
      token: signed.token,
      expiresAt: (data as { expires_at: string }).expires_at,
    };
  },

  /**
   * Claim atómico `suspended→resuming` (RPC `claim_suspended_run`, FOR UPDATE +
   * status-gate + Ownership Guard DB-level).
   *
   * Mapea los prefijos del `RAISE` por mensaje (patrón `key-session.ts` /
   * `agent-link.ts`) y NUNCA propaga el mensaje crudo de Postgres.
   *
   * 🔴 CUANDO EL RUN VENCIÓ, la fila ya quedó `expired` DENTRO del RPC, en la
   * misma transacción que levantó el error. Acá se emite el residuo, y "exactamente
   * uno" no es una promesa de este código: es una consecuencia de que la
   * transición `suspended→expired` sólo pueda ocurrir una vez. Un segundo
   * intento sobre la misma fila cae en el guard de "ya usado" y no emite nada.
   */
  async claim(
    tokenHash: string,
    ownerId: string,
  ): Promise<ClaimSuspendedRunResult> {
    const { data, error } = await supabase.rpc('claim_suspended_run', {
      p_token_hash: tokenHash,
      p_owner_ref: ownerId,
    });

    if (error) {
      const m = error.message;
      if (m.includes('RUN_EXPIRED')) {
        await this.expire(tokenHash, ownerId);
        return { ok: false, reason: 'expired' };
      }
      if (m.includes('RUN_NOT_FOUND'))
        return { ok: false, reason: 'not_found' };
      if (m.includes('RUN_ALREADY_USED')) {
        return { ok: false, reason: 'already_used' };
      }
      log.error(
        { detail: m },
        '[suspended-run.claim] the claim RPC failed for a reason this service does not model',
      );
      return { ok: false, reason: 'unavailable' };
    }

    const rows = (data ?? []) as unknown as SuspendedRunClaim[];
    const run = rows[0];
    if (!run) {
      // FAIL-CLOSED: el RPC no tiró pero tampoco devolvió fila. "No sé" no
      // autoriza a seguir ejecutando un pipeline que ya cobró.
      return { ok: false, reason: 'already_used' };
    }
    return { ok: true, run };
  },

  /**
   * AC-7 — la constancia durable de la plata que ya salió y no vuelve, cuando
   * un run suspendido vence sin que nadie lo reanude.
   *
   * REUSA el módulo leaf del residuo: cero aritmética nueva. Si ningún step
   * dejó evidencia on-chain no se emite NADA — un run que suspendió en el step
   * 0 sin pagos confirmados se comporta byte-idéntico a hoy.
   *
   * FIRE-AND-FORGET con `.catch`, igual que el residuo del pipeline: esto es
   * telemetría de un resultado YA decidido, y un fallo al ANOTAR no puede
   * convertirse en un fallo distinto del que el caller iba a recibir. El
   * `.catch` es obligatorio: sin él, el rechazo sería una unhandled rejection.
   *
   * NO PUEDE LANZAR: se la llama desde el camino de error del claim, donde una
   * excepción suya reemplazaría el 410 por un 500.
   */
  async expire(tokenHash: string, ownerId: string): Promise<void> {
    try {
      const { data, error } = await supabase
        .from('a2a_suspended_runs')
        .select('id, compose_run_id, steps_json, status')
        .eq('token_hash', tokenHash)
        .eq('owner_ref', ownerId)
        .maybeSingle();

      if (error || !data) {
        log.error(
          { detail: error?.message },
          '[suspended-run.expire] the run expired and its stranded payments could NOT be read — the only remaining record is this log line',
        );
        return;
      }

      const fila = data as unknown as {
        id: string;
        compose_run_id: string;
        steps_json: unknown;
      };
      const steps = Array.isArray(fila.steps_json)
        ? (fila.steps_json as StepResult[])
        : [];
      const strandedSteps = collectStrandedSteps(steps);
      if (strandedSteps.length === 0) return;

      eventService
        .track(
          buildStrandedPaymentEvent({
            composeRunId: fila.compose_run_id,
            strandedSteps,
            // Los steps COMPLETADOS son los que están en la fila; el índice del
            // que "falló" es su cantidad, igual que en el pipeline.
            failedStepIndex: steps.length,
            error: 'suspended run expired without being resumed',
          }),
        )
        .catch((trackErr) =>
          log.error(
            { err: trackErr, runId: fila.id },
            '[suspended-run.expire] a suspended run expired after a step had already been paid on-chain, and that could NOT be persisted as an event',
          ),
        );
    } catch (buildErr) {
      log.error(
        { err: buildErr },
        '[suspended-run.expire] the stranded-payment record could not even be BUILT — the expiry is reported to the caller untouched',
      );
    }
  },

  /**
   * Settle exactly-once (RPC `settle_suspended_run`, FOR UPDATE + status-gate +
   * Ownership Guard DB-level).
   *
   * ⛔ `reopen` SÓLO desde guards que corren ANTES de cualquier débito o invoke
   * de los steps restantes. Todo lo que pase después es terminal (`failed`) y
   * nunca se reabre: reabrir después de un débito ambiguo es ofrecerle al
   * caller un segundo cobro. Es la MISMA decisión de WKH-137, no una nueva.
   */
  async settle(
    id: string,
    ownerId: string,
    outcome: 'resumed' | 'reopen' | 'failed',
    errorMsg: string | null,
  ): Promise<SettleSuspendedRunResult> {
    const { error } = await supabase.rpc('settle_suspended_run', {
      p_id: id,
      p_owner_ref: ownerId,
      p_outcome: outcome,
      p_error: errorMsg,
    });

    if (error) {
      const m = error.message;
      if (m.includes('OWNERSHIP_MISMATCH')) {
        return { ok: false, reason: 'ownership_mismatch' };
      }
      if (m.includes('RUN_NOT_FOUND'))
        return { ok: false, reason: 'not_found' };
      log.error(
        { runId: id, detail: m },
        '[suspended-run.settle] the settle RPC failed; the row may be stuck in `resuming`',
      );
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: true };
  },

  /**
   * Los runs suspendidos de UN dueño.
   *
   * Es la contraparte owner-scoped de la lista admin de
   * `reconciliation.listSuspendedRuns()`, y la diferencia entre las dos es
   * exactamente el `.eq('owner_ref', ownerId)` de acá. Existe además como el
   * sitio donde `suspended-run.ownership.test.ts` puede medir que el filtro
   * AÍSLA —no que esté escrito—, que es lo único que el guardián automático no
   * puede ver.
   *
   * ⛔ NO devuelve `token_hash` hacia afuera pese a leer la fila entera: quien
   * lista sus runs no necesita el material del que sale la credencial.
   */
  async listForOwner(ownerId: string): Promise<ListSuspendedRunsResult> {
    const { data, error } = await supabase
      .from('a2a_suspended_runs')
      .select(ROW_COLUMNS)
      .eq('owner_ref', ownerId)
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) {
      log.error(
        { detail: error.message },
        '[suspended-run.listForOwner] query failed',
      );
      return { ok: false, reason: 'unavailable' };
    }
    const rows = (data as unknown as SuspendedRunRow[] | null) ?? [];
    return {
      ok: true,
      rows: rows.map((r) => ({ ...r, token_hash: '' })),
    };
  },
};
