/**
 * PRESENCIA + FINALIDAD + TERMINOS DE UNA PRUEBA DE PAGO INBOUND — WKH-314.
 *
 * Responde una sola pregunta —*¿esta firma le acreditó a NUESTRA wallet, de forma
 * irreversible, al menos lo que el challenge pedía, en el mint que el challenge
 * pedía?*— y la responde con una unión discriminada que **nunca colapsa "no pude
 * preguntar" en una negativa**. **NUNCA lanza**: todo fallo se traduce a un estado.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ── LA REGLA QUE GOBIERNA TODO ESTE ARCHIVO ───────────────────────────────────
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `if (res.error) return <veredicto definitivo>` está **PROHIBIDO**.
 *
 * Un `absent`, un `terms_mismatch` o un `not_finalized` son afirmaciones sobre la
 * CADENA y exigen evidencia **POSITIVA**. Todo lo demás —un throw, un array vacío, un
 * campo ausente, un nodo que va atrasado— se llama `unknown`.
 *
 * Y acá el colapso cuesta en las DOS direcciones, que es lo que hace este camino
 * distinto del de salida:
 *   · leer "no pude preguntar" como `absent` **rechaza un pago que ya se hizo**: el
 *     pagador transfirió USDC de verdad y se queda sin el servicio;
 *   · leer "no pude preguntar" como `finalized_ok` **regala el servicio**.
 * Por eso `unknown` es un estado propio y **no concede**, pero tampoco condena: se
 * responde con `Retry-After` y **sin consumir la prueba**, así que la misma firma
 * sigue siendo gastable cuando el nodo vuelva.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ── POR QUE NO SE REUSA `probeSettlementPresence` DE `payment.ts` ─────────────
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Es la tentación obvia y sería INCORRECTA. Lo mismo decidió (y midió) WKH-315 para su
 * camino: *"Lo compartido es la DOCTRINA, no la función: tres valores mínimo,
 * `getSignatureStatuses` + `searchTransactionHistory` como ÚNICA fuente de una
 * negativa, `unknown` para todo lo demás, nunca lanzar"*. Concretamente, su
 * `SettlementPresence` **descarta `confirmationStatus`** (sólo mira `status.err`), así
 * que su `landed_ok` **no implica `finalized`** y no puede sostener la garantía de esta
 * HU. `payment.ts` —money-path de salida, recién shipeado— **no se toca**.
 */

import type { Connection } from '@solana/web3.js';
import type { SolanaInboundBinding, SolanaInboundPresence } from '../types.js';
import { readInboundBinding } from './inbound-verify.js';

/**
 * ⚠️ LITERAL DE MODULO. **NINGUNA env puede debilitarlo.**
 *
 * La finalidad es un hecho del ledger, no una política: no hay nada que el operador
 * pueda afirmar en lugar de la cadena. En particular **NO** se usa
 * `getSolanaCommitment()` (env-driven, default `'confirmed'`) para decidir la
 * finalidad, ni se hereda el commitment de la `Connection` compartida.
 */
const INBOUND_FINALITY = 'finalized' as const;

/**
 * Commitment con el que se LEE EL CONTENIDO de la transacción, una vez que su
 * finalidad **ya está probada** por `getSignatureStatuses`.
 *
 * ⚠️ ESTO NO AFLOJA NADA, Y LA RAZON ES MEDIBLE. Una transacción `finalized` es
 * inmutable: leer su contenido a `confirmed` devuelve exactamente los mismos bytes.
 * Lo que cambia es la DISPONIBILIDAD — y ahí está el dato: medido contra
 * `api.devnet.solana.com` el 2026-08-19, `getParsedTransaction` con
 * `commitment: 'finalized'` devolvió `null` para las tres transacciones más recientes
 * del mint USDC de devnet (slot 485455160), y las MISMAS tres devolvieron el parseo
 * completo con `commitment: 'confirmed'`. Leer los términos a `finalized` habría
 * convertido casi todo cobro real en `unknown` contra el endpoint público.
 * *Esto sería falso si*: la finalidad se decidiera con esta lectura. No se decide acá
 * — se decide arriba, con `getSignatureStatuses`, y sin eso probado no se llega a esta
 * línea.
 */
const INBOUND_TERMS_READ = 'confirmed' as const;

/** El RPC de Solana manda SIEMPRE un entero decimal en base 10 como string. */
const ATOMIC_AMOUNT_RE = /^\d+$/;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface InboundProbeArgs {
  /** Firma/txid base58 que el pagador presenta. Ya validada de FORMATO por el handler. */
  signature: string;
  /** La wallet que tenía que recibir (pubkey base58, de `SOLANA_X402_INBOUND_PAY_TO`). */
  payTo: string;
  /** El mint exigido por el challenge. */
  mint: string;
  /** Lo que el challenge pedía, en unidades ATOMICAS. */
  requiredAtomic: string;
  /** La referencia del challenge — tiene que ser cuenta de esta transacción. */
  reference: string;
  issuedAt: number;
  expiresAt: number;
}

/** Lo que UN proveedor de RPC tiene para decir sobre esta prueba. */
export interface InboundProviderVerdict {
  presence: SolanaInboundPresence;
  binding: SolanaInboundBinding;
}

/**
 * Presencia + finalidad. **Es la única fuente admitida de una negativa de existencia**,
 * porque `getSignatureStatuses(..., { searchTransactionHistory: true })` es la única
 * llamada que puede distinguir *"el nodo buscó y no la tiene"* de *"no pude
 * preguntar"*: devuelve `null` en la posición de la firma SOLO tras haber buscado.
 *
 * ⚠️ **NO se usa `getParsedTransaction` para decidir ausencia**: su `null` mezcla "no
 * existe" con "este nodo no lo tiene indexado / va atrasado" — y eso no es teórico,
 * está medido arriba, en `INBOUND_TERMS_READ`.
 *
 * ⚠️ Y **la finalidad se LEE, no se hereda**: `confirmationStatus` es OPCIONAL en el
 * tipo del SDK.
 *   - `'finalized'`               ⇒ seguir (evidencia POSITIVA)
 *   - `'processed'`/`'confirmed'` ⇒ `not_finalized` (negativa MEDIDA, reintentable)
 *   - **ausente / desconocido**   ⇒ **`unknown`**, NO "todavía no".
 */
async function probeInboundLanding(
  connection: Connection,
  signature: string,
): Promise<SolanaInboundPresence | { state: 'proceed' }> {
  let statuses: Awaited<
    ReturnType<typeof connection.getSignatureStatuses>
  > | null = null;
  try {
    statuses = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
  } catch (err) {
    return { state: 'unknown', detail: errText(err) };
  }
  if (!statuses || !Array.isArray(statuses.value)) {
    return {
      state: 'unknown',
      detail: 'getSignatureStatuses returned no status array',
    };
  }
  if (statuses.value.length === 0) {
    return { state: 'unknown', detail: 'getSignatureStatuses returned empty' };
  }
  const status = statuses.value[0];
  // `null` DESPUES de haber buscado el histórico = prueba de ausencia. La precondición
  // de que el endpoint retenga histórico la mide el preflight; acá no se re-implementa
  // ni se debilita.
  if (status === null || status === undefined) return { state: 'absent' };
  if (status.err) {
    return { state: 'landed_failed', detail: JSON.stringify(status.err) };
  }
  const conf = status.confirmationStatus;
  if (conf === INBOUND_FINALITY) return { state: 'proceed' };
  if (conf === 'processed' || conf === 'confirmed') {
    return { state: 'not_finalized', confirmationStatus: conf };
  }
  return {
    state: 'unknown',
    detail: `getSignatureStatuses returned no usable confirmationStatus (got ${
      conf === undefined || conf === null ? 'absent' : JSON.stringify(conf)
    }) — cannot assert finality either way`,
  };
}

/** Una fila de `pre/postTokenBalances`, leída sin asumir ningún campo opcional. */
interface BalanceEntry {
  accountIndex: number;
  mint: string;
  owner?: string | undefined;
  uiTokenAmount: { amount: string };
}

function isBalanceEntry(b: unknown): b is BalanceEntry {
  return (
    typeof b === 'object' &&
    b !== null &&
    typeof (b as { mint?: unknown }).mint === 'string' &&
    typeof (b as { accountIndex?: unknown }).accountIndex === 'number'
  );
}

/**
 * EL MONTO ACREDITADO SE CALCULA SUMANDO, NO CON `.find()` (DT-C3).
 *
 * ⚠️ ESTA ES LA DECISION DE ESTE ARCHIVO QUE MAS FACIL SERIA "SIMPLIFICAR" MAL.
 *
 * El leg de SALIDA usa un `.find()` por `(owner, mint)`, y eso toma **la primera** de
 * las cuentas de token posibles. Si la wallet receptora tiene DOS cuentas del mismo
 * mint y el pagador acreditó en la segunda, un `.find()` mide un delta de cero y
 * produce un `terms_mismatch` **falso sobre un pago real**: el pagador transfirió y se
 * queda sin servicio, y el log dice que mandó mal la plata.
 *
 * La pregunta correcta en el inbound es *"¿cuánto recibió `payTo` de este mint en esta
 * tx?"*, y la respuesta correcta es la **suma de `Σ(post − pre)` sobre TODAS las
 * entradas** cuyo owner sea `payTo` y cuyo mint sea el configurado.
 * *Esto sería falso si*: cambiar la suma por un `.find()` no rompiera ningún test —
 * lo rompe T-SUM-01, que pone el crédito en la segunda cuenta.
 *
 * ⚠️ Y LA SUMA ES `null` SI CUALQUIER ENTRADA RELEVANTE ES ILEGIBLE. Un `amount` que
 * no es un entero decimal, o un `owner` ausente en una fila de nuestro mint, dejan la
 * suma sin medir. `null` significa **"no pude medir"**, no "cero": un cero silencioso
 * acá es un `AMOUNT_SHORT` inventado.
 *
 * ⚠️ POR QUE UN `try { BigInt(x) }` NO ALCANZA (lección medida en WKH-315): `BigInt('')`
 * y `BigInt('   ')` dan `0n`, y `BigInt('0x10')` da `16n`. El `catch` ni siquiera se
 * ejecuta para tres de las formas ilegibles más probables.
 */
export function creditedAtomicSum(
  pre: readonly BalanceEntry[],
  post: readonly BalanceEntry[],
  payTo: string,
  mint: string,
): { ok: true; credited: bigint } | { ok: false; detail: string } {
  let sum = 0n;
  for (const [sign, list] of [
    [-1n, pre],
    [1n, post],
  ] as const) {
    for (const b of list) {
      if (b.mint !== mint) continue;
      const owner = b.owner;
      if (owner === undefined || owner === null || owner === '') {
        // Fila de NUESTRO mint sin owner declarado: puede ser nuestra o no, y las dos
        // lecturas son peligrosas (contarla infla el crédito, ignorarla lo hunde).
        return {
          ok: false,
          detail: `a token balance row for the configured mint (accountIndex ${b.accountIndex}) declares no owner — it can be neither counted nor discarded`,
        };
      }
      if (owner !== payTo) continue;
      const raw = b.uiTokenAmount?.amount;
      if (typeof raw !== 'string' || !ATOMIC_AMOUNT_RE.test(raw)) {
        return {
          ok: false,
          detail: `a token balance row for the recipient carries an unreadable amount (accountIndex ${b.accountIndex})`,
        };
      }
      sum += sign * BigInt(raw);
    }
  }
  return { ok: true, credited: sum };
}

/**
 * Los TERMINOS, sobre una transacción cuya finalidad ya está probada. Puro.
 *
 * Orden de los veredictos, y no es decorativo: primero *"¿movió nuestro token?"*
 * (mint), después *"¿a nosotros?"* (destino), y recién al final *"¿alcanza?"* (monto).
 * Son tres errores con tres remediaciones distintas y el pagador tiene que poder
 * saber cuál cometió.
 *
 * ⚠️ EL MONTO SE COMPARA EN UNIDADES ATOMICAS Y CON `>=`. Acreditar de MAS concede
 * (nadie paga de más por error y se queda sin servicio); acreditar de MENOS es
 * `terms_mismatch` con detalle `AMOUNT_SHORT`. **PROHIBIDO** comparar en decimal
 * —ahí entra el redondeo de coma flotante en un guard de dinero— y **PROHIBIDO** `!==`.
 */
export function readInboundTerms(
  meta:
    | {
        err?: unknown;
        preTokenBalances?: unknown;
        postTokenBalances?: unknown;
      }
    | null
    | undefined,
  args: { payTo: string; mint: string; requiredAtomic: string },
): SolanaInboundPresence {
  if (!meta) {
    // El status dice que la tx ESTA y está finalizada, pero este nodo no la tiene
    // parseada: eso es "no sé qué movió", no "no coinciden los términos".
    return {
      state: 'unknown',
      detail:
        'the signature is present and finalized, but this node has no parsed transaction for it (lagging or unindexed)',
    };
  }
  if (meta.err) {
    return { state: 'landed_failed', detail: JSON.stringify(meta.err) };
  }
  const preRaw = meta.preTokenBalances;
  const postRaw = meta.postTokenBalances;
  // ⚠️ ACA NO VA UN `?? []`. Un `?? []` es una suposición disfrazada de default: con
  // `pre` ausente el delta sería el saldo ENTERO de la cuenta receptora, y cualquier
  // firma que la toque concedería.
  if (!Array.isArray(preRaw) || !Array.isArray(postRaw)) {
    return {
      state: 'unknown',
      detail: `the parsed transaction carries no token balance list (pre present=${Array.isArray(preRaw)}, post present=${Array.isArray(postRaw)}) — an absent list is not an empty one`,
    };
  }
  if (!preRaw.every(isBalanceEntry) || !postRaw.every(isBalanceEntry)) {
    return {
      state: 'unknown',
      detail:
        'a token balance list contains an entry without a usable `mint`/`accountIndex` — the lists cannot be interpreted, and an uninterpretable list is not an empty one',
    };
  }
  const pre = preRaw as BalanceEntry[];
  const post = postRaw as BalanceEntry[];

  const mintSeen =
    pre.some((b) => b.mint === args.mint) ||
    post.some((b) => b.mint === args.mint);
  if (!mintSeen) {
    return {
      state: 'terms_mismatch',
      detail:
        'MINT_MISMATCH: no pre/post token balance entry for the mint this challenge requires',
    };
  }

  const summed = creditedAtomicSum(pre, post, args.payTo, args.mint);
  if (!summed.ok) return { state: 'unknown', detail: summed.detail };

  if (summed.credited <= 0n) {
    return {
      state: 'terms_mismatch',
      detail: `RECIPIENT_MISMATCH: this transaction moved the required mint, but the challenge recipient received nothing from it (net ${summed.credited.toString()})`,
    };
  }

  let required: bigint;
  try {
    if (!ATOMIC_AMOUNT_RE.test(args.requiredAtomic)) {
      return {
        state: 'unknown',
        detail: `the required amount is not a readable atomic integer: ${args.requiredAtomic}`,
      };
    }
    required = BigInt(args.requiredAtomic);
  } catch {
    return {
      state: 'unknown',
      detail: `the required amount could not be parsed: ${args.requiredAtomic}`,
    };
  }

  if (summed.credited < required) {
    return {
      state: 'terms_mismatch',
      detail: `AMOUNT_SHORT: credited ${summed.credited.toString()} atomic units, the challenge required ${required.toString()}`,
    };
  }
  return { state: 'finalized_ok', creditedAtomic: summed.credited.toString() };
}

/**
 * El veredicto COMPLETO de UN proveedor: presencia + finalidad + términos + binding,
 * con **una sola lectura del contenido** de la transacción (la del binding y la de los
 * términos son la misma).
 *
 * **NUNCA lanza.**
 */
export async function probeInboundProof(
  connection: Connection,
  args: InboundProbeArgs,
): Promise<InboundProviderVerdict> {
  const landing = await probeInboundLanding(connection, args.signature);
  if (landing.state !== 'proceed') {
    // Sin finalidad probada no se lee el contenido: sería gastar una llamada para
    // decidir un binding que no puede conceder nada de todos modos.
    return {
      presence: landing,
      binding: {
        state: 'unknown',
        detail: `finality not established (${landing.state}) — the binding was not read`,
      },
    };
  }

  let parsed: Awaited<ReturnType<typeof connection.getParsedTransaction>>;
  try {
    parsed = await connection.getParsedTransaction(args.signature, {
      commitment: INBOUND_TERMS_READ,
      maxSupportedTransactionVersion: 0,
    });
  } catch (err) {
    return {
      presence: { state: 'unknown', detail: errText(err) },
      binding: { state: 'unknown', detail: errText(err) },
    };
  }

  return {
    presence: readInboundTerms(parsed?.meta, {
      payTo: args.payTo,
      mint: args.mint,
      requiredAtomic: args.requiredAtomic,
    }),
    binding: readInboundBinding(parsed, {
      reference: args.reference,
      issuedAt: args.issuedAt,
      expiresAt: args.expiresAt,
    }),
  };
}
