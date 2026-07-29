/**
 * LEDGER DURABLE DEL SETTLE SOLANA — WKH-307.
 *
 * ── QUE PROBLEMA RESUELVE ───────────────────────────────────────────────────
 *
 * El registro de "a que `intentId` ya se le pago y con que firma" vivia en un `Map`
 * de proceso. Un restart lo borra, y despues de ese restart el sistema **no sabe** si
 * ya le pago a un agente: un retry re-transmite un SPL transfer REAL.
 *
 * Solana no tiene backstop on-chain. A diferencia de EIP-3009 —cuyo nonce
 * deterministico hace que un segundo broadcast REVIERTA en el token— un SPL transfer
 * re-transmitido se ejecuta de nuevo y paga de nuevo. **Este seam de aplicacion es LA
 * UNICA defensa contra el doble pago.**
 *
 * ── LAS TRES REGLAS QUE GOBIERNAN TODO ESTE ARCHIVO ─────────────────────────
 *
 * 1. **ESCRITURA CONDICIONAL ATOMICA.** Nunca un `SELECT` que decide y un
 *    `INSERT`/`UPDATE` que ejecuta: entre los dos entra otro proceso. Cada transicion
 *    es UNA sola operacion que informa en su propio resultado si aplico. Por eso son
 *    funciones `plpgsql` via `supabase.rpc(...)` y no cadenas `.update().eq(...)`.
 *
 *    Y el reloj del lease es el de **Postgres**, no el de Node: si el umbral se
 *    calculara en JS, dos instancias del gateway con skew tendrian leases distintos y
 *    la adelantada robaria un lease vivo ⟹ dos broadcasts.
 *
 *    El UNICO `SELECT` de este archivo que puede parecer una excepcion es
 *    `readSettleIntent`, y no lo es: es un **peek** que no autoriza ni impide un pago.
 *    La autoridad es `settle()`, y su unica puerta es `claimSettleIntent`.
 *
 * 2. **FAIL-CLOSED.** Cliente caido, RPC que tira, error de Postgres, `data` vacio,
 *    `applied: undefined`, forma inesperada: todo eso es "no se", y **"no se" nunca
 *    autoriza una transferencia**. No hay fallback en memoria, no hay degradacion
 *    silenciosa. La asimetria es deliberada: un agente que NO cobra es recuperable
 *    (retry, reconciliacion, pago manual); un agente que cobra DOS VECES no lo es.
 *
 * 3. **NINGUNA FUNCION DEVUELVE `boolean`.** Un `false` colapsa "el guard lo rechazo" /
 *    "la escritura fallo" / "el store no esta", que tienen remedios DISTINTOS. Uniones
 *    discriminadas siempre (leccion del auto-blindaje de HU-202).
 *
 * ── BOUNDARY ───────────────────────────────────────────────────────────────
 *
 * Este es el **UNICO** archivo de `src/adapters/solana/**` que importa
 * `lib/supabase.js`. `schema-preflight.ts` no habla con la DB por su cuenta: consume
 * `probeSettleLedger()` de aca. El resto del adapter (chain, base58, attestation,
 * payment) sigue sin conocer la capa de datos.
 *
 * ── PII ────────────────────────────────────────────────────────────────────
 *
 * `payTo` NUNCA se loguea entero (`shortAddr`). Ni la clave del operador ni ningun
 * secreto pasan por aca.
 */

import { getLogger } from '../../lib/logger.js';
import { supabase } from '../../lib/supabase.js';

const log = getLogger('solana-settle-ledger');

/** Lease por defecto del reclamo (ms). Ver `SOLANA_SETTLE_LEDGER_LEASE_MS`. */
const LEASE_MS_DEFAULT = 120_000;

/** Marca que levanta el RPC de reclamo con `p_probe := true`. Prueba POSITIVA. */
export const PROBE_OK_MARKER = 'WKH307_PROBE_OK';

/** Codigo de Postgres para violacion de UNIQUE — el choque del indice de firma. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Lease del reclamo, en ms. Cuanto puede estar una fila en `claimed` antes de que
 * otro proceso pueda tomarla.
 *
 * Tomar un reclamo vencido es seguro por DEMOSTRACION, no por tiempo: una fila
 * `claimed` no tiene firma, y la firma se persiste ANTES de transmitir (invariante
 * I2) ⟹ una fila `claimed` prueba que nunca se transmitio nada. El lease solo evita
 * que dos procesos vivos se pisen.
 */
export function resolveSettleLeaseMs(): number {
  const raw = process.env.SOLANA_SETTLE_LEDGER_LEASE_MS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : LEASE_MS_DEFAULT;
}

/** `payTo` truncado para logs (CD-15: nunca la direccion entera). */
function shortAddr(addr: string): string {
  return addr.length <= 12 ? addr : `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ── Tipos publicos del seam (todos discriminados, ninguno boolean) ──────────

/**
 * Resultado del reclamo. **Solo `claimed` autoriza a transmitir.** Los otros cinco
 * son, cada uno, un motivo distinto para NO tocar la red — y son distinguibles a
 * proposito: la accion del operador no es la misma para `terms_conflict` que para
 * `store_unavailable`.
 */
export type ClaimResult =
  | { outcome: 'claimed'; attempts: number }
  /** Otro request en vuelo dentro del lease, y todavia no firmo. */
  | { outcome: 'in_progress' }
  /** Hay firma persistida: el broadcast PUDO haber salido. Preguntarle a la cadena. */
  | {
      outcome: 'signed';
      signature: string;
      lastValidBlockHeight: string | null;
    }
  /** El pago se hizo. Re-verificar on-chain antes de devolver la firma (CD-5). */
  | { outcome: 'confirmed'; signature: string }
  /** El caller cambio payTo/monto/mint: NO es el mismo pago (AC-8). */
  | { outcome: 'terms_conflict'; status: string | null }
  /** No se pudo saber. NUNCA autoriza. */
  | { outcome: 'store_unavailable'; detail: string };

/**
 * Resultado de persistir la firma. Es el paso que crea la invariante I2: si esto no
 * devuelve `ok`, **no se transmite**.
 *
 * `signature_collision` (23505) es una situacion COMPLETAMENTE distinta de
 * `not_claimed`: la primera se resuelve re-firmando con blockhash fresco, la segunda
 * significa que otro proceso es el dueño del reclamo. Colapsarlas en un `false`
 * borraria esa diferencia.
 */
export type SignedWrite =
  | { ok: true; attempts: number }
  | {
      ok: false;
      reason: 'not_claimed' | 'signature_collision' | 'store_unavailable';
      detail: string;
    };

export type ConfirmedWrite =
  | { ok: true }
  | {
      ok: false;
      reason: 'signature_mismatch' | 'store_unavailable';
      detail: string;
    };

export type ReclaimWrite =
  | { ok: true }
  | { ok: false; reason: 'not_signed' | 'store_unavailable'; detail: string };

/** Lectura de peek. NO autoriza ni impide un pago: solo informa. */
export type SettleIntentRead =
  | { state: 'none' }
  | { state: 'claimed' }
  | { state: 'signed'; signature: string }
  | { state: 'confirmed'; signature: string }
  | { state: 'unknown'; detail: string };

/** Veredicto crudo del probe de esquema. Lo interpreta `schema-preflight.ts`. */
export type LedgerProbeResult =
  | { probe: 'ok' }
  | { probe: 'table_missing'; detail: string }
  | { probe: 'rpc_missing'; detail: string }
  | { probe: 'failed'; detail: string };

// ── Lectura defensiva de la fila que devuelven las 4 funciones ──────────────

/**
 * Las 4 funciones devuelven LA MISMA fila. Se lee con casts defensivos y sin ninguna
 * coercion numerica sobre `amount_atomic` / `last_valid_block_height` (CD-8: un
 * `Number()` sobre un uint64 pierde precision por encima de 2^53 — el bug que
 * WKH-196 pago caro).
 */
type LedgerRow = {
  applied?: boolean;
  outcome?: string;
  status?: string | null;
  settle_signature?: string | null;
  last_valid_block_height?: string | null;
  attempts?: number | null;
};

function firstRow(data: unknown): LedgerRow | undefined {
  if (Array.isArray(data)) return data[0] as LedgerRow | undefined;
  // Una funcion `RETURNS TABLE` de una sola fila puede llegar como objeto.
  if (data && typeof data === 'object') return data as LedgerRow;
  return undefined;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message?: unknown }).message);
  }
  return String(err);
}

// ── Las 5 operaciones del seam ─────────────────────────────────────────────

/**
 * EL RECLAMO. Primera operacion de dinero de todo el settle y unica puerta al
 * broadcast.
 *
 * Es una sola sentencia atomica del lado de Postgres
 * (`INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING`): dos requests
 * concurrentes sobre el mismo `intentId` tienen exactamente un ganador, y lo decide
 * la PK, no este codigo.
 */
export async function claimSettleIntent(args: {
  intentId: string;
  caip2: string;
  payTo: string;
  amountAtomic: string;
  mint: string;
}): Promise<ClaimResult> {
  let data: unknown;
  try {
    const res = await supabase.rpc('claim_solana_settle_intent', {
      p_intent_id: args.intentId,
      p_caip2: args.caip2,
      p_pay_to: args.payTo,
      p_amount_atomic: args.amountAtomic,
      p_mint: args.mint,
      p_lease_ms: resolveSettleLeaseMs(),
      p_probe: false,
    });
    if (res.error) {
      log.error(
        {
          intentId: args.intentId,
          caip2: args.caip2,
          code: res.error.code,
          detail: res.error.message,
        },
        'solana settle claim failed — NOT transmitting (fail-closed)',
      );
      return { outcome: 'store_unavailable', detail: res.error.message };
    }
    data = res.data;
  } catch (err) {
    // Cliente no configurado, red caida, cualquier sorpresa. "No se" ⟹ no se paga.
    log.error(
      { intentId: args.intentId, caip2: args.caip2, detail: errText(err) },
      'solana settle claim threw — NOT transmitting (fail-closed)',
    );
    return { outcome: 'store_unavailable', detail: errText(err) };
  }

  const row = firstRow(data);
  if (!row || typeof row.outcome !== 'string') {
    // Forma inesperada: NO se puede afirmar que ganamos el reclamo.
    return {
      outcome: 'store_unavailable',
      detail: 'claim rpc returned no usable row',
    };
  }

  switch (row.outcome) {
    case 'claimed':
      // El unico camino que autoriza, y solo si la escritura dijo `applied`.
      // Un `applied` que no sea EXACTAMENTE `true` (incluido `undefined`) NO alcanza.
      if (row.applied !== true) {
        return {
          outcome: 'store_unavailable',
          detail: 'claim rpc reported outcome=claimed without applied=true',
        };
      }
      return { outcome: 'claimed', attempts: row.attempts ?? 1 };
    case 'in_progress':
      return { outcome: 'in_progress' };
    case 'signed': {
      const sig = row.settle_signature;
      if (typeof sig !== 'string' || sig.length === 0) {
        // Fila incoherente (signed sin firma): no se puede consultar la cadena.
        return {
          outcome: 'store_unavailable',
          detail: 'row is signed but carries no signature',
        };
      }
      return {
        outcome: 'signed',
        signature: sig,
        lastValidBlockHeight: row.last_valid_block_height ?? null,
      };
    }
    case 'confirmed': {
      const sig = row.settle_signature;
      if (typeof sig !== 'string' || sig.length === 0) {
        return {
          outcome: 'store_unavailable',
          detail: 'row is confirmed but carries no signature',
        };
      }
      return { outcome: 'confirmed', signature: sig };
    }
    case 'terms_conflict':
      log.error(
        {
          intentId: args.intentId,
          status: row.status,
          // Montos como STRING, nunca Number() (CD-8).
          requestedAmountAtomic: args.amountAtomic,
          requestedPayTo: shortAddr(args.payTo),
          requestedMint: args.mint,
        },
        'solana settle claim rejected — the intent already exists with DIFFERENT terms; NOT transmitting and NOT returning the prior signature',
      );
      return { outcome: 'terms_conflict', status: row.status ?? null };
    default:
      return {
        outcome: 'store_unavailable',
        detail: `claim rpc returned unknown outcome: ${row.outcome}`,
      };
  }
}

/**
 * PERSISTIR LA FIRMA ANTES DE TRANSMITIR. Este paso ES la invariante I2.
 *
 * Si no devuelve `ok`, la transaccion firmada se descarta **sin tocar la red**.
 */
export async function recordSignedIntent(args: {
  intentId: string;
  signature: string;
  lastValidBlockHeight: string;
}): Promise<SignedWrite> {
  let data: unknown;
  try {
    const res = await supabase.rpc('record_solana_settle_signed', {
      p_intent_id: args.intentId,
      p_signature: args.signature,
      p_last_valid_block_height: args.lastValidBlockHeight,
    });
    if (res.error) {
      // 23505 = choque del indice UNIQUE parcial sobre la firma. NO es un fallo del
      // store: es la señal de re-firmar con blockhash fresco. Como el choque ocurre
      // ANTES del broadcast, todavia no salio nada.
      if (res.error.code === PG_UNIQUE_VIOLATION) {
        log.warn(
          { intentId: args.intentId },
          'solana settle signature collision — another intent already persisted this exact signature; re-signing with a fresh blockhash (nothing was broadcast)',
        );
        return {
          ok: false,
          reason: 'signature_collision',
          detail: res.error.message,
        };
      }
      log.error(
        {
          intentId: args.intentId,
          code: res.error.code,
          detail: res.error.message,
        },
        'solana settle record-signed failed — NOT transmitting (fail-closed)',
      );
      return {
        ok: false,
        reason: 'store_unavailable',
        detail: res.error.message,
      };
    }
    data = res.data;
  } catch (err) {
    return { ok: false, reason: 'store_unavailable', detail: errText(err) };
  }

  const row = firstRow(data);
  if (!row) {
    return {
      ok: false,
      reason: 'store_unavailable',
      detail: 'record-signed rpc returned no usable row',
    };
  }
  if (row.applied !== true) {
    // `undefined` cae ACA a proposito: preferimos no transmitir de mas antes que
    // creer que el candado cerro.
    return {
      ok: false,
      reason:
        row.outcome === 'not_claimed' ? 'not_claimed' : 'store_unavailable',
      detail: `record-signed did not apply (outcome=${String(row.outcome)}, status=${String(row.status)})`,
    };
  }
  return { ok: true, attempts: row.attempts ?? 1 };
}

/**
 * Marcar confirmado. Se llama DESPUES de que la cadena confirmo.
 *
 * Un fallo aca NO invalida el pago (ya ocurrio): el caller loguea y devuelve exito,
 * y la fila queda en `signed` con la firma correcta, asi que el proximo retry la
 * re-verifica y converge.
 */
export async function recordConfirmedIntent(args: {
  intentId: string;
  signature: string;
}): Promise<ConfirmedWrite> {
  let data: unknown;
  try {
    const res = await supabase.rpc('record_solana_settle_confirmed', {
      p_intent_id: args.intentId,
      p_signature: args.signature,
    });
    if (res.error) {
      return {
        ok: false,
        reason: 'store_unavailable',
        detail: res.error.message,
      };
    }
    data = res.data;
  } catch (err) {
    return { ok: false, reason: 'store_unavailable', detail: errText(err) };
  }
  const row = firstRow(data);
  if (!row) {
    return {
      ok: false,
      reason: 'store_unavailable',
      detail: 'record-confirmed rpc returned no usable row',
    };
  }
  if (row.applied !== true) {
    return {
      ok: false,
      reason:
        row.outcome === 'signature_mismatch'
          ? 'signature_mismatch'
          : 'store_unavailable',
      detail: `record-confirmed did not apply (outcome=${String(row.outcome)})`,
    };
  }
  return { ok: true };
}

/**
 * Devolver a `claimed` una fila cuya firma YA NO PUEDE ATERRIZAR.
 *
 * Solo se invoca con la prueba en la mano (`getBlockHeight() > last_valid_block_height`).
 * La firma vieja se archiva en `expired_signatures`: la evidencia de que se intento
 * pagar no se borra nunca.
 */
export async function reclaimExpiredIntent(args: {
  intentId: string;
  signature: string;
}): Promise<ReclaimWrite> {
  let data: unknown;
  try {
    const res = await supabase.rpc('reclaim_solana_settle_intent', {
      p_intent_id: args.intentId,
      p_signature: args.signature,
    });
    if (res.error) {
      return {
        ok: false,
        reason: 'store_unavailable',
        detail: res.error.message,
      };
    }
    data = res.data;
  } catch (err) {
    return { ok: false, reason: 'store_unavailable', detail: errText(err) };
  }
  const row = firstRow(data);
  if (!row) {
    return {
      ok: false,
      reason: 'store_unavailable',
      detail: 'reclaim rpc returned no usable row',
    };
  }
  if (row.applied !== true) {
    return {
      ok: false,
      reason: row.outcome === 'not_signed' ? 'not_signed' : 'store_unavailable',
      detail: `reclaim did not apply (outcome=${String(row.outcome)})`,
    };
  }
  return { ok: true };
}

/**
 * PEEK. Lectura pura para el pre-check de balance del caller.
 *
 * ⚠️ NO autoriza ni impide un pago: `settle()` sigue siendo la unica autoridad, y su
 * unica puerta es `claimSettleIntent`. Existe para que el pre-check de fondos no corte
 * un intent que YA fue pagado (un pago hecho no necesita fondos otra vez).
 *
 * NUNCA lanza: cualquier fallo se traduce a `unknown`, que el caller trata como
 * fail-closed.
 */
export async function readSettleIntent(
  intentId: string,
): Promise<SettleIntentRead> {
  try {
    const res = await supabase
      .from('a2a_solana_settle_intents')
      .select('status, settle_signature')
      .eq('intent_id', intentId)
      .maybeSingle();
    if (res.error) {
      return { state: 'unknown', detail: res.error.message };
    }
    const row = res.data as {
      status?: string | null;
      settle_signature?: string | null;
    } | null;
    if (!row) return { state: 'none' };
    const sig = row.settle_signature;
    if (
      row.status === 'confirmed' &&
      typeof sig === 'string' &&
      sig.length > 0
    ) {
      return { state: 'confirmed', signature: sig };
    }
    if (row.status === 'signed' && typeof sig === 'string' && sig.length > 0) {
      return { state: 'signed', signature: sig };
    }
    if (row.status === 'claimed') return { state: 'claimed' };
    // Estado desconocido o fila incoherente: no afirmamos nada.
    return {
      state: 'unknown',
      detail: `unexpected row shape (status=${String(row.status)})`,
    };
  } catch (err) {
    return { state: 'unknown', detail: errText(err) };
  }
}

/**
 * PROBE DE ESQUEMA. Lo consume `schema-preflight.ts` (que no habla con la DB por su
 * cuenta — CD-7: este archivo es el unico de `adapters/solana/**` con acceso a datos).
 *
 * Dos comprobaciones, en orden:
 *   (1) la TABLA resuelve (si falta, el resto no tiene sentido);
 *   (2) el RPC de reclamo es LA VERSION NUEVA, ejercitandolo con `p_probe := true`.
 *
 * (2) es una prueba **POSITIVA**: la funcion hace `RAISE EXCEPTION 'WKH307_PROBE_OK'`
 * como PRIMERA sentencia, antes de cualquier escritura. Recibir esa excepcion
 * demuestra que la funcion deployada es la nueva **sin escribir una sola fila**.
 * Leer un catalogo no probaria lo mismo: una funcion homonima con otro cuerpo
 * figuraria igual.
 */
export async function probeSettleLedger(): Promise<LedgerProbeResult> {
  try {
    const table = await supabase
      .from('a2a_solana_settle_intents')
      .select('intent_id')
      .limit(1);
    if (table.error) {
      return { probe: 'table_missing', detail: table.error.message };
    }
  } catch (err) {
    return { probe: 'failed', detail: errText(err) };
  }

  try {
    const rpc = await supabase.rpc('claim_solana_settle_intent', {
      p_intent_id: `wkh307-probe-${Date.now()}`,
      p_caip2: 'probe',
      p_pay_to: 'probe',
      p_amount_atomic: '0',
      p_mint: 'probe',
      p_lease_ms: 1,
      p_probe: true,
    });
    const message = rpc.error?.message ?? '';
    if (message.includes(PROBE_OK_MARKER)) return { probe: 'ok' };
    if (message.length === 0) {
      // Sin error: o el `p_probe` no existe (funcion vieja) o la funcion escribio.
      // No se puede afirmar que el esquema sea el nuevo ⟹ fail-closed.
      return {
        probe: 'rpc_missing',
        detail: `claim rpc did not raise ${PROBE_OK_MARKER} for a probe call (stale function deployed?)`,
      };
    }
    return { probe: 'rpc_missing', detail: message };
  } catch (err) {
    return { probe: 'failed', detail: errText(err) };
  }
}
