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
import type { StepResult, SuspendedRunClaim } from '../types/index.js';
import { eventService } from './event.js';

const log = getLogger('suspended-run');

/** Alias del JSONB tal como lo declara el archivo de tipos generado. */
type JsonColumn =
  Database['public']['Tables']['a2a_suspended_runs']['Insert']['steps_json'];

/**
 * `unknown` → columna JSONB, con `undefined` colapsado a `null`.
 *
 * El colapso es la DECISIÓN, no una conveniencia de tipos: cuando el pipeline no
 * traía traza de contratación, lo que queremos decir es que la columna es NULA.
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
  /**
   * Fix-pack AR/BLQ-BAJO-1 — YA RE-INDEXADOS contra `remainingSteps`. El
   * productor (`compose.suspendIfEnvelope`) los recorta con el MISMO
   * `slice(i + 1)` que arma `remainingSteps`, así que el índice 0 de este array
   * es el precio del índice 0 de aquél. Guardar el array entero dejaba dos
   * espacios de índices distintos apuntando a la misma plata.
   */
  frozenStepPrices: unknown;
  totalCostUsdc: number;
  /**
   * Fix-pack AR/BLQ-MED-1 — el techo declarado por el caller en el `/compose`
   * original, o `null` si no declaró ninguno. Sin persistirlo, el tramo
   * reanudado corría sin techo del caller y con el del operador reiniciado.
   */
  maxBudgetUsdc: number | null;
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
      max_budget_usdc: input.maxBudgetUsdc,
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
   * 🔴 CUANDO EL RUN VENCIÓ, la fila SIGUE `suspended` al volver de este RPC, y
   * eso es lo correcto: el `RAISE EXCEPTION` del claim aborta su transacción, así
   * que NADA de lo que se escriba ahí adentro sobrevive (fix-pack AR/BLQ-ALTO-1,
   * medido contra Postgres 16). La transición durable la aplica `expire()` en una
   * sentencia propia y CONDICIONAL, y ahí "exactamente un residuo" deja de ser
   * una promesa de este código: es el número de filas que afectó un
   * `UPDATE … WHERE status = 'suspended'`. El segundo intento afecta 0.
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
   * AC-7 — la TRANSICIÓN a `expired` y la constancia durable de la plata que ya
   * salió y no vuelve, cuando un run suspendido vence sin que nadie lo reanude.
   *
   * ── 🔴 FIX-PACK AR/BLQ-ALTO-1 · ESTA FUNCIÓN AHORA **ESCRIBE**
   *
   * Antes sólo LEÍA, porque se creía que el `UPDATE … SET status = 'expired'` que
   * vivía dentro de `claim_suspended_run` había dejado la fila terminal. No:
   * el `RAISE EXCEPTION` que va dos líneas más abajo aborta la transacción y
   * descarta ese UPDATE — PostgREST corre cada `rpc()` en una transacción propia.
   * Medido contra Postgres 16: tres claims seguidos sobre una fila vencida la
   * dejaban `suspended` las tres veces. O sea que `expired` era INALCANZABLE y
   * cada intento emitía OTRO `compose_stranded_payment`, sin techo: un caller
   * autenticado podía encender `strandedExposureBreached` en `/health` repitiendo
   * el mismo token vencido.
   *
   * ── POR QUÉ UN `UPDATE` CONDICIONAL Y NO UN `SELECT` + UN `UPDATE`
   *
   * Regla 1 del encabezado de este archivo: nunca un `SELECT` que decide y un
   * `UPDATE` que ejecuta. El `.eq('status', 'suspended')` es el gate: bajo
   * READ COMMITTED, dos llamadas concurrentes se serializan sobre el row lock y
   * la segunda re-evalúa el `WHERE` contra la versión nueva, encuentra `expired`
   * y afecta 0 filas. Verificado ejecutando: 5 sesiones concurrentes contra
   * Postgres 16 ⇒ `1 0 0 0 0`. El residuo se emite SÓLO si esta sentencia afectó
   * una fila, así que "exactamente uno" es una propiedad del motor.
   *
   * ⛔ EL PREDICADO DEL RELOJ NO ESTÁ ACÁ, Y ES DELIBERADO (CD-19). Quien decide
   * que el run venció es `claim_suspended_run`, comparando `NOW() >= expires_at`
   * con el reloj de POSTGRES en los dos lados. Escribir acá un
   * `.lte('expires_at', new Date().toISOString())` metería el reloj de NODE en la
   * decisión, que es exactamente lo que CD-19 prohíbe. Esta sentencia sólo
   * REGISTRA una decisión ya tomada, y `expires_at` no se puede mover después del
   * INSERT (el trigger es `BEFORE INSERT`, verificado ejecutando).
   *
   * ⛔ Y POR ESO ESTA FUNCIÓN SÓLO SE LLAMA DESDE LA RAMA `RUN_EXPIRED` DE
   * `claim()`. Llamarla desde otro lado marcaría `expired` un run que sigue vivo.
   * Es un único call-site y así tiene que quedarse.
   *
   * REUSA el módulo leaf del residuo: cero aritmética nueva. Si ningún step
   * dejó evidencia on-chain no se emite NADA — un run que suspendió en el step
   * 0 sin pagos confirmados se comporta byte-idéntico a hoy. La transición SÍ se
   * aplica igual: que no haya plata varada no significa que el run no venció.
   *
   * FIRE-AND-FORGET con `.catch` para el evento, igual que el residuo del
   * pipeline: es telemetría de un resultado YA decidido, y un fallo al ANOTAR no
   * puede convertirse en un fallo distinto del que el caller iba a recibir. El
   * `.catch` es obligatorio: sin él, el rechazo sería una unhandled rejection.
   *
   * NO PUEDE LANZAR: se la llama desde el camino de error del claim, donde una
   * excepción suya reemplazaría el 410 por un 500.
   */
  async expire(tokenHash: string, ownerId: string): Promise<void> {
    try {
      const { data, error } = await supabase
        .from('a2a_suspended_runs')
        .update({ status: 'expired' })
        .eq('token_hash', tokenHash)
        .eq('owner_ref', ownerId)
        .eq('status', 'suspended')
        .select('id, compose_run_id, steps_json');

      if (error) {
        log.error(
          { detail: error.message },
          '[suspended-run.expire] the run expired and could NOT be marked terminal — the only remaining record is this log line',
        );
        return;
      }

      const rows =
        (data as unknown as Array<{
          id: string;
          compose_run_id: string;
          steps_json: unknown;
        }> | null) ?? [];
      const row = rows[0];
      // 0 filas = la transición ya la aplicó otra pasada (o el dueño no es el
      // suyo, o el run nunca estuvo `suspended`). NO es un error y NO emite: es
      // justamente lo que hace que el residuo sea exactamente uno.
      if (row === undefined) return;

      const steps = Array.isArray(row.steps_json)
        ? (row.steps_json as StepResult[])
        : [];
      const strandedSteps = collectStrandedSteps(steps);
      if (strandedSteps.length === 0) return;

      eventService
        .track(
          buildStrandedPaymentEvent({
            composeRunId: row.compose_run_id,
            strandedSteps,
            failedStepIndex: steps.length,
            error: 'suspended run expired without being resumed',
          }),
        )
        .catch((trackErr) =>
          log.error(
            { err: trackErr, runId: row.id },
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
};
