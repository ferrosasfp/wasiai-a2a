/**
 * PREFLIGHT DE ESQUEMA DEL LEDGER SOLANA — WKH-307 (AC-11).
 *
 * ── POR QUE EXISTE ─────────────────────────────────────────────────────────
 *
 * La migracion de esta HU se aplica **solo a bdwv** (la base de desarrollo). Aplicarla
 * a produccion es WKH-307b, founder-gated. O sea que **existe POR DISEÑO al menos una
 * base sin la tabla**, y el codigo va a correr contra ella.
 *
 * La leccion, textual, del auto-blindaje de HU-202:
 *
 *   *"Toda vez que un valor de retorno pasa de telemetria a condicion de dinero, su
 *   precondicion de esquema deja de ser documentacion y pasa a ser codigo.
 *   **Un gate que nadie corre no es un gate.**"*
 *
 * Un aviso en el header del `.sql` diciendo "aplicar antes de deployar" es prosa. Esto
 * es el gate ejecutable.
 *
 * ── QUE VERIFICA ───────────────────────────────────────────────────────────
 *
 * Delega en `probeSettleLedger()` (CD-7: `settle-ledger.ts` es el unico archivo de
 * `adapters/solana/**` con acceso a datos), que hace dos comprobaciones:
 *
 *   (1) la TABLA `a2a_solana_settle_intents` resuelve;
 *   (2) el RPC de reclamo es **la version nueva**, ejercitandolo con `p_probe := true`.
 *
 * (2) es una prueba POSITIVA y de costo cero: la funcion hace
 * `RAISE EXCEPTION 'WKH307_PROBE_OK'` como PRIMERA sentencia, antes de cualquier
 * escritura. Recibir esa excepcion demuestra que la funcion deployada es la nueva sin
 * escribir una sola fila. Leer un catalogo no probaria lo mismo: una funcion homonima
 * con el cuerpo viejo figuraria igual.
 *
 * ── DONDE SE ENFORCEA, Y POR QUE AHI ───────────────────────────────────────
 *
 * El enforcement es PEREZOSO y vive en `settle()`, como **primera operacion**, antes
 * del reclamo y de cualquier resolucion de conexion, operador o ATA. Tres razones,
 * las mismas que el preflight del escrow:
 *
 *   1. NO ROMPE EL ARRANQUE DE QUIEN NO USA SOLANA. `SOLANA_ADAPTER_ENABLED` exige
 *      `=== 'true'` y el default es OFF.
 *   2. NO HAY VENTANA TOCTOU. Un chequeo solo al arrancar no cubre al proceso que ya
 *      esta vivo cuando alguien revierte la migracion.
 *   3. NO ES UNA CONSULTA POR REQUEST. El veredicto se memoiza y las llamadas
 *      concurrentes comparten un unico probe en vuelo. Despues del primero el costo es
 *      una comparacion.
 *
 * Y ADEMAS SUENA AL ARRANCAR: `src/index.ts` dispara `warmSolanaSchemaPreflight()`
 * fire-and-forget cuando el flag esta ON. No bloquea ni tira el boot, pero pone el
 * `log.error` en el arranque en vez de en medio de una transferencia. El probe es EL
 * MISMO y comparte cache: el warm-up no puede divergir del gate.
 *
 * ── QUE PASA CUANDO FALLA ──────────────────────────────────────────────────
 *
 * `settle()` **rechaza, ruidoso**, con el motivo distinguible. **NUNCA hay fallback**
 * (no queda ningun store en memoria al que caer, y si quedara seria peor: pagar sin
 * saber si ya se pago es exactamente lo que esta HU viene a impedir).
 *
 * Consecuencia declarada: mientras la migracion no este en una base, un entorno que
 * apunte a ella con `SOLANA_ADAPTER_ENABLED=true` **no settlea Solana**. Es
 * fail-closed deliberado y recuperable (aplicar la migracion), no un doble pago.
 */

import { getLogger } from '../../lib/logger.js';
import { probeSettleLedger } from './settle-ledger.js';

const log = getLogger('solana-schema-preflight');

/** TTL del cache de un veredicto NEGATIVO (ms). El positivo no expira. */
const RETRY_MS_DEFAULT = 60_000;

/**
 * Motivo del rechazo. Los tres son fail-closed, pero NO son la misma alarma:
 *   · `table_missing` — la migracion no esta. Accion: aplicarla.
 *   · `rpc_missing`   — la tabla esta pero las funciones no son las nuevas. Accion:
 *     re-aplicar la migracion (¿se aplico a medias? ¿quedo una version vieja?).
 *   · `probe_failed`  — no se pudo decidir (DB caida, respuesta inesperada). Accion:
 *     mirar la DB. Se reintenta solo.
 */
export type SolanaSchemaFailure =
  | 'table_missing'
  | 'rpc_missing'
  | 'probe_failed';

export type SolanaSchemaVerdict =
  | { ok: true }
  | { ok: false; failure: SolanaSchemaFailure; detail: string };

let _cached: SolanaSchemaVerdict | null = null;
let _cachedAt = 0;
let _inFlight: Promise<SolanaSchemaVerdict> | null = null;

function retryMs(): number {
  const raw = process.env.SOLANA_SCHEMA_PREFLIGHT_RETRY_MS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : RETRY_MS_DEFAULT;
}

/** TEST-ONLY — limpia el cache memoizado. */
export function _resetSolanaSchemaPreflight(): void {
  _cached = null;
  _cachedAt = 0;
  _inFlight = null;
}

/** Traduce el probe crudo del ledger al veredicto del preflight. NUNCA lanza. */
async function probeSolanaSchema(): Promise<SolanaSchemaVerdict> {
  const result = await probeSettleLedger();
  switch (result.probe) {
    case 'ok':
      return { ok: true };
    case 'table_missing':
      return { ok: false, failure: 'table_missing', detail: result.detail };
    case 'rpc_missing':
      return { ok: false, failure: 'rpc_missing', detail: result.detail };
    default:
      return { ok: false, failure: 'probe_failed', detail: result.detail };
  }
}

/**
 * Veredicto memoizado. Las llamadas concurrentes comparten el probe en vuelo (single
 * flight) — sin eso, el primer burst de settles dispararia un probe por request.
 *
 * Politica de cache, igual que el preflight del escrow:
 *   · `ok:true`  → PARA SIEMPRE. Una migracion aplicada no se des-aplica sola;
 *     revertirla es una accion de operador que viene con un restart.
 *   · `ok:false` → por `SOLANA_SCHEMA_PREFLIGHT_RETRY_MS` (default 60s). Cachearlo
 *     para siempre dejaria el leg Solana apagado hasta el proximo deploy por un
 *     timeout transitorio; no cachear nada haria un probe por request contra una base
 *     caida.
 */
export async function ensureSolanaSchemaReady(): Promise<SolanaSchemaVerdict> {
  if (_cached?.ok === true) return _cached;
  if (_cached && Date.now() - _cachedAt < retryMs()) return _cached;
  if (_inFlight) return _inFlight;

  const run = probeSolanaSchema().then(
    (verdict) => {
      _cached = verdict;
      _cachedAt = Date.now();
      _inFlight = null;
      if (!verdict.ok) {
        log.error(
          { failure: verdict.failure, detail: verdict.detail },
          // El operador tiene que poder actuar sin leer el codigo.
          'SOLANA SETTLE LEDGER SCHEMA PREFLIGHT FAILED — the Solana settle leg is DISABLED (fail-closed: without the durable ledger the gateway cannot know whether an agent was already paid, and a re-broadcast SPL transfer pays twice with no on-chain backstop). Apply migration 20260730000000_wkh307_solana_settle_intents.sql to this database BEFORE deploying the code.',
        );
      }
      return verdict;
    },
    // `probeSolanaSchema` ya es no-throw; esto es defensa en profundidad para que el
    // gate del money-path no pueda rechazar la promise NUNCA.
    (err: unknown) => {
      const verdict: SolanaSchemaVerdict = {
        ok: false,
        failure: 'probe_failed',
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
 * Warm-up del arranque (`src/index.ts`). Fire-and-forget A PROPOSITO: el objetivo es
 * que la alarma suene al arrancar, NO que un blip de red impida levantar el servicio y
 * con el los caminos que no tienen nada que ver con Solana. El gate real sigue siendo
 * `ensureSolanaSchemaReady()` dentro de `settle()`.
 */
export function warmSolanaSchemaPreflight(): void {
  void ensureSolanaSchemaReady().catch(() => {});
}
