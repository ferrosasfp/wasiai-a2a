/**
 * PREFLIGHT DE ESQUEMA DEL CAMINO ESCROW — AR de HU-202, BLOQUEANTE 1.
 *
 * ── EL PROBLEMA QUE RESUELVE ────────────────────────────────────────────────
 *
 * HU-202 convirtió el retorno de `recordDebitSettleStatus` de un LOG en un GATE DURO
 * de dinero: sin lease persistido, el hop 2 NO sale (`payment-intent.ts`, paso 5). Ese
 * retorno es negativo cuando el RPC tira, y el RPC TIRA
 * (`RAISE EXCEPTION 'INVALID_SETTLE_STATUS'`) contra una base que no llegó a
 * `20260728000000`, porque `resolving_settle` recién se acepta desde ahí.
 *
 * La secuencia contra una base vieja NO es un borde, es el 100% del tráfico de escrow:
 *   1. el hop 1 confirma y MUEVE LOS FONDOS DEL BUYER on-chain;
 *   2. el lease falla porque el RPC no conoce el status;
 *   3. el hop 2 no sale (fail-closed, correcto dado el punto 2);
 *   4. el intent termina `failed_ambiguous` SIN reembolsar (a propósito: los fondos ya
 *      salieron).
 * Comprador debitado, vendedor sin cobrar, plata parada en la wallet del operador.
 *
 * Hasta este módulo, el "gate de orden de release" existía SÓLO COMO PROSA en el header
 * del `.sql` y en un `.md`. Un gate que nadie ejecuta no es un gate.
 *
 * ── QUÉ VERIFICA, Y POR QUÉ ESTAS DOS COSAS ────────────────────────────────
 *
 * (1) LA COLUMNA `debit_hop2_attempted_at` EXISTE (migración 20260729000000). Es el
 *     hecho persistido sobre el que se apoya el guard independiente del status en
 *     `claim_reconciliation`. Sin ella el candado queda colgando sólo del string del
 *     status: una DEGRADACIÓN silenciosa.
 *
 * (2) EL RPC `record_debit_settle_status` ACEPTA `resolving_settle` (migración
 *     20260728000000). Es LA condición cuya ausencia estaciona la plata.
 *
 * ⚠️ (2) SE VERIFICA EJERCITANDO EL RPC DE VERDAD, NO LEYENDO UN CATÁLOGO. Se lo llama
 * con un `p_intent_id` UUID aleatorio, y se lee QUÉ excepción tira. El orden del cuerpo
 * de la función es lo que lo hace seguro y concluyente a la vez:
 *
 *     IF p_status NOT IN (...) THEN RAISE 'INVALID_SETTLE_STATUS'  ← (2) se decide ACÁ
 *     SELECT ... FROM a2a_payment_intents WHERE id = p_intent_id FOR UPDATE
 *     IF NOT FOUND THEN RAISE 'INTENT_NOT_FOUND'                   ← y acá corta
 *     ... UPDATE ...                                               ← NUNCA se alcanza
 *
 *   · `INVALID_SETTLE_STATUS` ⟹ la base NO tiene 20260728000000 ⟹ FAIL.
 *   · `INTENT_NOT_FOUND`      ⟹ el whitelist de status YA aceptó `resolving_settle`
 *     ⟹ PASS. Es prueba positiva: la ejecución pasó el punto exacto que falla.
 *
 * CERO EFECTOS: la excepción se levanta ANTES de cualquier `UPDATE`, y con un UUID v4
 * aleatorio la fila no existe (y si existiera, el guard de ownership tira antes del
 * `UPDATE` igual). No escribe, no deja locks, no consume nonces.
 *
 * ── DÓNDE SE ENFORCEA, Y POR QUÉ ACÁ Y NO EN EL ARRANQUE ────────────────────
 *
 * El ENFORCEMENT es PEREZOSO y vive en `settleEscrowAware`, inmediatamente después del
 * gate del flag y ANTES de cualquier lectura o escritura de dinero. Tres razones:
 *
 *   1. NO ROMPE EL ARRANQUE DE QUIEN NO USA ESCROW. `ESCROW_SETTLE_ENABLED` exige
 *      `=== 'true'` y el default es OFF, o sea que el 100% de los entornos de hoy
 *      —incluidos los tests y los deploys sin escrow— nunca ejecutan este probe.
 *   2. NO HAY VENTANA TOCTOU. Un chequeo SÓLO al arrancar no cubre el proceso que ya
 *      está vivo cuando alguien revierte la migración; el gate perezoso decide en el
 *      camino que gasta la plata, que es donde importa.
 *   3. NO ES UNA CONSULTA POR REQUEST. El veredicto se memoiza (ver abajo) y las
 *      llamadas concurrentes comparten un único probe en vuelo. Después del primero, el
 *      costo es una comparación de enteros.
 *
 * Y ADEMÁS SUENA AL ARRANCAR: `src/index.ts` dispara `warmEscrowSchemaPreflight()`
 * fire-and-forget cuando el flag está ON. No bloquea ni tira el boot (un blip de red no
 * puede impedir que el servicio levante y sirva los caminos que no son escrow), pero
 * pone el `log.error` en el arranque en vez de en medio de una transferencia. El probe
 * es el MISMO y comparte el mismo cache: el warm-up no puede divergir del gate.
 *
 * ── POLÍTICA DE CACHE (por qué el fallo NO se cachea para siempre) ──────────
 *
 *   · `ok:true`  → se cachea PARA SIEMPRE. Una migración aplicada no se des-aplica sola;
 *     revertirla es una acción de operador que viene con un restart del servicio.
 *   · `ok:false` → se cachea por `ESCROW_SCHEMA_PREFLIGHT_RETRY_MS` (default 60s). Si se
 *     cacheara para siempre, un timeout transitorio de la DB durante el primer settle
 *     dejaría el camino escrow apagado hasta el próximo deploy. Si no se cacheara nada,
 *     una base caída haría un probe por request.
 *
 * ── QUÉ PASA CUANDO FALLA (y por qué no estaciona plata) ────────────────────
 *
 * `settleEscrowAware` cae al seam operador-custodial (`settlePaymentIntentOnChain`), que
 * es EXACTAMENTE el camino del flag OFF y el mismo fallback que ya existe cuando no hay
 * firma `valid`. Concretamente: NO se dispara el hop 1, así que los fondos del buyer NO
 * se mueven, y el seller SÍ cobra por la vía de siempre. Se pierde el rewire
 * non-custodial (el operador adelanta la plata, como hoy) y se gana no dejar al buyer
 * debitado con el seller sin cobrar. Es la asimetría del money-path: un settle
 * custodial es recuperable, un buyer debitado sin contraparte no.
 */

import { randomUUID } from 'node:crypto';
import { getLogger } from '../../lib/logger.js';
import { supabase } from '../../lib/supabase.js';

const log = getLogger('escrow-schema-preflight');

/** TTL del cache de un veredicto NEGATIVO (ms). El positivo no expira. */
const RETRY_MS_DEFAULT = 60_000;

/**
 * Motivo del rechazo. Los tres son fail-closed, pero NO son la misma alarma:
 *   · `RPC_REJECTS_RESOLVING_SETTLE` — la migración no está. Acción: aplicarla.
 *   · `COLUMN_MISSING`               — 20260729000000 no está. Acción: aplicarla.
 *   · `PROBE_UNAVAILABLE`            — no se pudo decidir (DB caída, RPC ausente,
 *     respuesta inesperada). Acción: mirar la DB. Se reintenta solo.
 */
export type EscrowSchemaFailure =
  | 'COLUMN_MISSING'
  | 'RPC_REJECTS_RESOLVING_SETTLE'
  | 'PROBE_UNAVAILABLE';

export type EscrowSchemaVerdict =
  | { ok: true }
  | { ok: false; failure: EscrowSchemaFailure; detail: string };

let _cached: EscrowSchemaVerdict | null = null;
let _cachedAt = 0;
let _inFlight: Promise<EscrowSchemaVerdict> | null = null;

function retryMs(): number {
  const raw = process.env.ESCROW_SCHEMA_PREFLIGHT_RETRY_MS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : RETRY_MS_DEFAULT;
}

/** TEST-ONLY — limpia el cache memoizado (patrón `_resetDebitExecutor`). */
export function _resetEscrowSchemaPreflight(): void {
  _cached = null;
  _cachedAt = 0;
  _inFlight = null;
}

/**
 * El probe real. NUNCA lanza: cualquier sorpresa se traduce a `PROBE_UNAVAILABLE`
 * (fail-closed) para que el camino de dinero no dependa de un throw.
 */
async function probeEscrowSchema(): Promise<EscrowSchemaVerdict> {
  // (1) La columna del hecho persistido. `limit(1)` para que el costo no dependa del
  //     tamaño de la tabla: lo que se prueba es que PostgREST resuelva la columna.
  try {
    const col = await supabase
      .from('a2a_payment_intent_debit_signatures')
      .select('debit_hop2_attempted_at')
      .limit(1);
    if (col.error) {
      return {
        ok: false,
        failure: 'COLUMN_MISSING',
        detail: col.error.message,
      };
    }
  } catch (err) {
    return {
      ok: false,
      failure: 'PROBE_UNAVAILABLE',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // (2) El whitelist de status del RPC, ejercitado de verdad. Ver el header: el
  //     `RAISE` ocurre ANTES de cualquier UPDATE, así que esto no escribe nada.
  try {
    const rpc = await supabase.rpc('record_debit_settle_status', {
      p_intent_id: randomUUID(),
      p_owner_ref: `escrow-schema-preflight-${randomUUID()}`,
      p_key_id: randomUUID(),
      p_nonce: '0',
      p_status: 'resolving_settle',
    });
    const message = rpc.error?.message ?? '';
    if (message.includes('INVALID_SETTLE_STATUS')) {
      return {
        ok: false,
        failure: 'RPC_REJECTS_RESOLVING_SETTLE',
        detail: message,
      };
    }
    if (message.includes('INTENT_NOT_FOUND')) return { ok: true };
    // Ni una ni la otra: el RPC no existe (PGRST202), la DB no contesta, o la función
    // cambió de forma. NO se puede afirmar que el camino escrow sea seguro ⟹ fail-closed.
    return {
      ok: false,
      failure: 'PROBE_UNAVAILABLE',
      detail:
        message ||
        'record_debit_settle_status returned no error for a random intent id (expected INTENT_NOT_FOUND)',
    };
  } catch (err) {
    return {
      ok: false,
      failure: 'PROBE_UNAVAILABLE',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Veredicto memoizado. Las llamadas concurrentes comparten el probe en vuelo (single
 * flight) — sin eso, el primer burst de settles dispararía un probe por request.
 */
export async function ensureEscrowSchemaReady(): Promise<EscrowSchemaVerdict> {
  if (_cached?.ok === true) return _cached;
  if (_cached && Date.now() - _cachedAt < retryMs()) return _cached;
  if (_inFlight) return _inFlight;

  const run = probeEscrowSchema().then(
    (verdict) => {
      _cached = verdict;
      _cachedAt = Date.now();
      _inFlight = null;
      if (!verdict.ok) {
        log.error(
          { failure: verdict.failure, detail: verdict.detail },
          // El operador tiene que poder actuar sin leer el código.
          'ESCROW SCHEMA PREFLIGHT FAILED — the escrow settle path is DISABLED and every settle falls back to the operator-custodial seam (the seller is still paid; the buyer escrow is NOT debited). Apply migrations 20260728000000 + 20260729000000 to this database BEFORE relying on the non-custodial path. Running the code ahead of the schema debits the buyer on hop1 and then refuses hop2, leaving the seller unpaid.',
        );
      }
      return verdict;
    },
    // `probeEscrowSchema` ya es no-throw; esto es defensa en profundidad para que el
    // gate del money-path no pueda rechazar la promise NUNCA.
    (err: unknown) => {
      const verdict: EscrowSchemaVerdict = {
        ok: false,
        failure: 'PROBE_UNAVAILABLE',
        detail: err instanceof Error ? err.message : String(err),
      };
      _cached = verdict;
      _cachedAt = Date.now();
      _inFlight = null;
      return verdict;
    },
  );
  _inFlight = run;
  return run;
}

/**
 * Warm-up del arranque (`src/index.ts`). Fire-and-forget A PROPÓSITO: el objetivo es que
 * la alarma suene al arrancar, NO que un blip de red impida levantar el servicio y con
 * él los caminos que no tienen nada que ver con el escrow. El gate real sigue siendo
 * `ensureEscrowSchemaReady()` dentro de `settleEscrowAware`.
 */
export function warmEscrowSchemaPreflight(): void {
  void ensureEscrowSchemaReady().catch(() => {});
}
