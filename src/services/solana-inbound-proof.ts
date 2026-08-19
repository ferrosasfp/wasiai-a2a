/**
 * USO UNICO DE LAS PRUEBAS DE PAGO x402 INBOUND EN SOLANA — WKH-314.
 *
 * ── QUE PROBLEMA RESUELVE ───────────────────────────────────────────────────
 *
 * Una prueba de pago Solana es **una firma que ya aterrizó**. El pagador la puede
 * presentar N veces y la cadena no objeta nada: no hay nada que gastar de nuevo. A
 * diferencia de EIP-3009 —cuyo `authorization.nonce` es single-use a nivel token
 * on-chain— acá **no hay backstop de ninguna clase**. Este seam de aplicación es LA
 * defensa contra que una sola transferencia compre el servicio para siempre.
 *
 * ⚠️ POR QUE NO SE REUSA `services/x402-nonce.ts`. Falla **ABIERTO** por diseño, y su
 * justificación escrita es que *"el `authorization.nonce` EIP-3009 ya es single-use a
 * nivel token on-chain"*. Eso es cierto en EVM y **FALSO en Solana**. Reusarlo sería
 * heredar un fail-open sobre el único guard que hay. Y "arreglarlo" volviéndolo
 * fail-closed cambiaría el camino EVM, que esta HU tiene prohibido tocar.
 *
 * ── LAS TRES REGLAS QUE GOBIERNAN TODO ESTE ARCHIVO ─────────────────────────
 *
 * 1. **ESCRITURA CONDICIONAL ATOMICA.** Nunca un `SELECT` que decide y un
 *    `UPDATE` que ejecuta: entre los dos entra otro request. El consumo es UNA sola
 *    sentencia de Postgres que informa en su propio resultado si aplicó, contra la PK
 *    `(caip2, signature)`. Dos presentaciones concurrentes de la misma firma tienen
 *    exactamente un ganador, y **lo decide Postgres, no este código**.
 *
 *    El único `SELECT` de este archivo es `peekInboundProof`, y no es una excepción:
 *    es un **peek** que no concede ni impide nada. La autoridad es
 *    `consumeInboundProof`.
 *
 * 2. **FAIL-CLOSED.** Cliente caído, RPC que tira, error de Postgres, `data` vacío,
 *    `applied: undefined`, forma inesperada: todo eso es "no sé", y **"no sé" nunca
 *    concede acceso**. No hay fallback en memoria, no hay degradación silenciosa.
 *    La asimetría es deliberada y va al revés que en el leg de salida: un pago
 *    rechazado de más es **reintentable** (el pagador vuelve con la misma firma, que
 *    sigue gastable); un servicio entregado dos veces por una sola transferencia no se
 *    deshace.
 *
 * 3. **NINGUNA FUNCION DEVUELVE `boolean`.** Un `false` colapsa "ya se cobró" /
 *    "los términos no son estos" / "el store no contestó", que tienen remedios
 *    DISTINTOS: el primero es terminal, el segundo es un error del pagador y el
 *    tercero se reintenta.
 *
 * ── BOUNDARY ───────────────────────────────────────────────────────────────
 *
 * Vive en `src/services/` y **no** en `adapters/solana/` porque
 * `adapters/solana/settle-ledger.ts` declara ser el ÚNICO archivo de
 * `adapters/solana/**` con acceso a datos. Los clasificadores de error de Postgres se
 * IMPORTAN de ahí (una sola expresión por valor), no se re-escriben.
 *
 * ── PII ────────────────────────────────────────────────────────────────────
 *
 * `pay_to` nunca se loguea entero. Ni el secreto del challenge ni ninguna clave
 * privada pasan por acá: este camino no firma nada.
 */

import {
  isRelationMissingError,
  isTransportFailure,
} from '../adapters/solana/settle-ledger.js';
import type {
  InboundConsumeResult,
  InboundObserveResult,
  InboundPeekResult,
} from '../adapters/types.js';
import { getLogger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';

const log = getLogger('solana-inbound-proof');

/** Marca que levanta el peek con `p_probe := true`. Prueba POSITIVA del preflight. */
export const INBOUND_PROBE_OK_MARKER = 'WKH314_PROBE_OK';

/** Veredicto crudo del probe del store. Lo interpreta `inbound-preflight.ts`. */
export type InboundStoreProbeResult =
  | { probe: 'ok' }
  | { probe: 'table_missing'; detail: string }
  | { probe: 'rpc_missing'; detail: string }
  | { probe: 'failed'; detail: string };

/** Los términos que identifican UN pago. La firma sola no alcanza: ver `terms_conflict`. */
export interface InboundProofArgs {
  caip2: string;
  signature: string;
  reference: string;
  resource: string;
  payTo: string;
  amountAtomic: string;
  mint: string;
}

/** Fila que devuelven `record_…` y `consume_…`. Lectura defensiva, sin coerciones. */
type WriteRow = {
  applied?: boolean;
  outcome?: string;
  status?: string | null;
  attempts?: number | null;
};

/** Fila que devuelve `peek_…`. */
type PeekRow = {
  found?: boolean;
  status?: string | null;
  reference?: string | null;
  resource?: string | null;
  pay_to?: string | null;
  amount_atomic?: string | null;
  mint?: string | null;
};

function firstRow<T>(data: unknown): T | undefined {
  if (Array.isArray(data)) return data[0] as T | undefined;
  // Una función `RETURNS TABLE` de una sola fila puede llegar como objeto.
  if (data && typeof data === 'object') return data as T;
  return undefined;
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message?: unknown }).message);
  }
  return String(err);
}

/** Nunca se loguea una dirección entera. */
function shortAddr(addr: string): string {
  return addr.length <= 12 ? addr : `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/**
 * PEEK (P3). **No concede ni impide: informa.**
 *
 * Vale por dos cosas, y las dos son medibles:
 *   · una firma ya `consumed` se rechaza **sin gastar una sola llamada al RPC**;
 *   · una firma ya `observed` **salta la consulta a la cadena entera**: la
 *     incertidumbre de la cadena se paga UNA vez en la vida del pago, no una por
 *     reintento.
 *
 * ⚠️ `unknown` NO es `none`. Si el store no contesta, esta función **no puede** decir
 * que la prueba es nueva: decirlo mandaría a re-verificar y eventualmente a conceder
 * sobre una firma que quizás ya se cobró. El caller lo trata como indeterminación.
 */
export async function peekInboundProof(
  caip2: string,
  signature: string,
): Promise<InboundPeekResult> {
  let data: unknown;
  try {
    const res = await supabase.rpc('peek_solana_inbound_proof', {
      p_caip2: caip2,
      p_signature: signature,
      p_probe: false,
    });
    if (res.error) {
      return { state: 'unknown', detail: res.error.message };
    }
    data = res.data;
  } catch (err) {
    return { state: 'unknown', detail: errText(err) };
  }

  const row = firstRow<PeekRow>(data);
  if (!row || typeof row.found !== 'boolean') {
    return { state: 'unknown', detail: 'peek rpc returned no usable row' };
  }
  if (!row.found) return { state: 'none' };
  if (row.status === 'consumed') return { state: 'consumed' };
  if (row.status !== 'observed') {
    // Un `status` que no reconocemos NO se lee como "todavía gastable".
    return {
      state: 'unknown',
      detail: `peek rpc returned an unknown status: ${String(row.status)}`,
    };
  }
  // Una fila `observed` sin sus términos no sirve para saltar la cadena: sin ellos no
  // se puede comprobar que el veredicto guardado sea el de ESTE challenge.
  const { reference, resource, pay_to, amount_atomic, mint } = row;
  if (
    typeof reference !== 'string' ||
    typeof resource !== 'string' ||
    typeof pay_to !== 'string' ||
    typeof amount_atomic !== 'string' ||
    typeof mint !== 'string'
  ) {
    return {
      state: 'unknown',
      detail: 'peek rpc returned an observed row without usable terms',
    };
  }
  return {
    state: 'observed',
    terms: {
      reference,
      resource,
      payTo: pay_to,
      amountAtomic: amount_atomic,
      mint,
    },
  };
}

/**
 * PERSISTIR EL VEREDICTO DE LA CADENA (P6). Es lo que hace que la incertidumbre se
 * pague una sola vez: a partir de acá el peek puede saltar P4 y P5.
 *
 * **No concede nada.** El grant lo decide `consumeInboundProof`.
 */
export async function recordInboundObserved(
  args: InboundProofArgs,
): Promise<InboundObserveResult> {
  let data: unknown;
  try {
    const res = await supabase.rpc('record_solana_inbound_observed', {
      p_caip2: args.caip2,
      p_signature: args.signature,
      p_reference: args.reference,
      p_resource: args.resource,
      p_pay_to: args.payTo,
      p_amount_atomic: args.amountAtomic,
      p_mint: args.mint,
    });
    if (res.error) {
      log.error(
        { caip2: args.caip2, code: res.error.code, detail: res.error.message },
        'solana inbound observe failed — NOT granting access (fail-closed)',
      );
      return { outcome: 'store_unavailable', detail: res.error.message };
    }
    data = res.data;
  } catch (err) {
    return { outcome: 'store_unavailable', detail: errText(err) };
  }

  const row = firstRow<WriteRow>(data);
  if (!row || typeof row.outcome !== 'string') {
    return {
      outcome: 'store_unavailable',
      detail: 'observe rpc returned no usable row',
    };
  }

  switch (row.outcome) {
    case 'observed':
      // Un `applied` que no sea EXACTAMENTE `true` (incluido `undefined`) NO alcanza.
      if (row.applied !== true) {
        return {
          outcome: 'store_unavailable',
          detail: 'observe rpc reported outcome=observed without applied=true',
        };
      }
      return { outcome: 'observed', attempts: row.attempts ?? 1 };
    case 'consumed':
      return { outcome: 'replay' };
    case 'terms_conflict':
      log.error(
        {
          caip2: args.caip2,
          requestedAmountAtomic: args.amountAtomic,
          requestedPayTo: shortAddr(args.payTo),
          requestedMint: args.mint,
        },
        'solana inbound proof rejected — that signature is already recorded against DIFFERENT terms; it is not this payment',
      );
      return {
        outcome: 'terms_conflict',
        detail: 'the signature is already recorded against different terms',
      };
    default:
      // `not_recorded` y cualquier sorpresa. NO se llama "observado" a lo que no se
      // pudo observar.
      return {
        outcome: 'store_unavailable',
        detail: `observe rpc returned outcome: ${row.outcome}`,
      };
  }
}

/**
 * EL COBRO (P7). **Lo único que autoriza servir**, y sólo con
 * `outcome === 'consumed'` **y** `applied === true`.
 *
 * Va lo más tarde posible en la secuencia a propósito: si la respuesta HTTP se pierde
 * después de esto, el pagador queda cobrado sin servicio. Es un residuo DECLARADO —
 * la misma postura que el camino EVM tiene hoy— y se mitiga poniendo el consumo
 * inmediatamente antes de conceder, no resolviéndolo acá.
 */
export async function consumeInboundProof(
  args: InboundProofArgs,
): Promise<InboundConsumeResult> {
  let data: unknown;
  try {
    const res = await supabase.rpc('consume_solana_inbound_proof', {
      p_caip2: args.caip2,
      p_signature: args.signature,
      p_reference: args.reference,
      p_resource: args.resource,
      p_pay_to: args.payTo,
      p_amount_atomic: args.amountAtomic,
      p_mint: args.mint,
    });
    if (res.error) {
      log.error(
        { caip2: args.caip2, code: res.error.code, detail: res.error.message },
        'solana inbound consume failed — NOT granting access (fail-closed)',
      );
      return { outcome: 'store_unavailable', detail: res.error.message };
    }
    data = res.data;
  } catch (err) {
    return { outcome: 'store_unavailable', detail: errText(err) };
  }

  const row = firstRow<WriteRow>(data);
  if (!row || typeof row.outcome !== 'string') {
    return {
      outcome: 'store_unavailable',
      detail: 'consume rpc returned no usable row',
    };
  }

  switch (row.outcome) {
    case 'consumed':
      if (row.applied !== true) {
        return {
          outcome: 'store_unavailable',
          detail: 'consume rpc reported outcome=consumed without applied=true',
        };
      }
      return { outcome: 'consumed' };
    case 'already_consumed':
      return { outcome: 'replay' };
    case 'terms_conflict':
      return {
        outcome: 'terms_conflict',
        detail: 'the signature is recorded against different terms',
      };
    default:
      // `not_observed` es un estado imposible en la secuencia (P6 corre antes que P7):
      // fail-closed, nunca un grant.
      return {
        outcome: 'store_unavailable',
        detail: `consume rpc returned outcome: ${row.outcome}`,
      };
  }
}

/**
 * PROBE DEL STORE — dos preguntas sobre el mismo objeto, en orden:
 *   (1) el RPC deployado es LA VERSION NUEVA, ejercitándolo con `p_probe := true`;
 *   (2) la TABLA resuelve, ejercitando el mismo RPC con `p_probe := false` sobre una
 *       firma centinela que no existe.
 *
 * (1) es una prueba **POSITIVA**: la función hace `RAISE EXCEPTION 'WKH314_PROBE_OK'`
 * como PRIMERA sentencia, antes de leer o escribir nada. Recibir esa excepción
 * demuestra que la función deployada es la nueva **sin tocar una sola fila**. Leer un
 * catálogo no probaría lo mismo: una función homónima con el cuerpo viejo figuraría
 * igual.
 *
 * (2) existe porque (1), por construcción, corta antes de tocar la tabla: no puede
 * decir nada sobre si la tabla está. El peek centinela sí — devuelve `found=false` si
 * la tabla existe y `42P01` desde el cuerpo de la función si no.
 *
 * ⚠️ Sólo la EVIDENCIA POSITIVA de que la relación no existe se llama `table_missing`.
 * Red, timeout, auth o DNS son "no pude preguntar" ⟹ `failed`, que es el único motivo
 * que se reintenta solo. Confundirlos manda al operador a re-aplicar una migración que
 * ya estaba aplicada mientras la base sigue caída.
 */
export async function probeInboundProofStore(): Promise<InboundStoreProbeResult> {
  try {
    const rpc = await supabase.rpc('peek_solana_inbound_proof', {
      p_caip2: 'probe',
      p_signature: `wkh314-probe-${Date.now()}`,
      p_probe: true,
    });
    const message = rpc.error?.message ?? '';
    if (!message.includes(INBOUND_PROBE_OK_MARKER)) {
      if (isTransportFailure(rpc)) {
        return {
          probe: 'failed',
          detail: `could not reach the database to exercise the inbound peek rpc (status=${String(rpc.status)}): ${message}`,
        };
      }
      if (message.length === 0) {
        // Sin error: o el `p_probe` no existe (función vieja) o la función leyó.
        // No se puede afirmar que el esquema sea el nuevo ⟹ fail-closed.
        return {
          probe: 'rpc_missing',
          detail: `inbound peek rpc did not raise ${INBOUND_PROBE_OK_MARKER} for a probe call (stale function deployed?)`,
        };
      }
      return { probe: 'rpc_missing', detail: message };
    }
  } catch (err) {
    return { probe: 'failed', detail: errText(err) };
  }

  try {
    const sentinel = await supabase.rpc('peek_solana_inbound_proof', {
      p_caip2: 'probe',
      p_signature: `wkh314-probe-${Date.now()}`,
      p_probe: false,
    });
    if (sentinel.error) {
      if (isRelationMissingError(sentinel.error)) {
        return { probe: 'table_missing', detail: sentinel.error.message };
      }
      return {
        probe: 'failed',
        detail: `could not determine whether the inbound proofs table exists (code=${sentinel.error.code || 'none'}, status=${String(sentinel.status)}): ${sentinel.error.message}`,
      };
    }
  } catch (err) {
    return { probe: 'failed', detail: errText(err) };
  }

  return { probe: 'ok' };
}
