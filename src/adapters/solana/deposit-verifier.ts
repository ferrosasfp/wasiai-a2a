/**
 * El verificador de depósitos Solana (WKH-315 · el corazón de la HU).
 *
 * `verifySolanaDeposit` responde una sola pregunta —*¿esta firma acreditó USDC a
 * nuestra cuenta de depósito, de forma irreversible, y de quién?*— y la responde con
 * una unión discriminada que **nunca colapsa "no pude preguntar" en una negativa**.
 * **NUNCA lanza**: todo fallo se traduce a un estado del tipo.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ── CD-14, LA REGLA QUE GOBIERNA TODO ESTE ARCHIVO ────────────────────────────
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * `if (res.error) return <veredicto definitivo>` está **PROHIBIDO**.
 *
 * Un `absent`, un `MINT_MISMATCH` o un `not_finalized` son afirmaciones sobre la
 * CADENA y exigen evidencia **POSITIVA**. Todo lo demás —un throw, un array vacío, un
 * campo ausente, un nodo que va atrasado— se llama `unknown` y produce un **503**, no
 * un 400.
 *
 * Por qué importa en el camino de ENTRADA, que es al revés del de salida: acá el
 * colapso no hace pagar dos veces, hace **negarle a un depositante un dólar que ya
 * mandó**. "El nodo no me contestó" leído como "tu depósito no existe" es plata real
 * del usuario declarada inexistente por un timeout.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * ── POR QUE NO SE REUSA `probeSettlementPresence` (§7.1 del SDD) ──────────────
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Es la tentación obvia y sería INCORRECTA, por dos razones medidas:
 *
 * 1. Su veredicto de términos **exige monto y destino conocidos de antemano**: saca su
 *    `landed_ok` de `checkTerms(parsed, proof)`, que compara `delta < proof.amountAtomic`.
 *    **Un depósito no conoce el monto: lo DESCUBRE.** Invocarlo obligaría a fabricar un
 *    proof con `amountAtomic: '0'`, y entonces `landed_ok` significaría *"el saldo no
 *    bajó"*: **un guard de dinero que siempre pasa**. No es reuso, es un falso verde con
 *    forma de reuso.
 * 2. Lee a `'confirmed'` hardcodeado y su `SettlementPresence` **descarta**
 *    `confirmationStatus` (sólo mira `status.err`), así que su `landed_ok` **no implica
 *    `finalized`** y no puede sostener la garantía de esta HU.
 *
 * **Lo compartido es la DOCTRINA, no la función**: tres valores mínimo,
 * `getSignatureStatuses` + `searchTransactionHistory` como ÚNICA fuente de una
 * negativa, `unknown` para todo lo demás, nunca lanzar. `payment.ts` queda intacto
 * (es de WKH-314).
 */

import type { Connection } from '@solana/web3.js';
import { formatUnits, parseUnits } from 'viem';
import type {
  SolanaDepositLanding,
  SolanaDepositVerification,
} from '../types.js';
import {
  getSolanaConnection,
  getSolanaUsdcDecimals,
  getSolanaUsdcMint,
} from './chain.js';
import {
  isSolanaDepositEnabled,
  resolveSolanaDepositAta,
  resolveSolanaDepositOwner,
} from './deposit-account.js';

/**
 * ⚠️ LITERAL DE MODULO. **NINGUNA env puede debilitarlo.**
 *
 * Una variable de entorno capaz de bajar una garantía de dinero es el mismo footgun
 * que un `SKIP_`. La única forma admitida de una salida por env en esta casa es
 * **declarar una afirmación del operador** (exemplar:
 * `SOLANA_RPC_LEDGER_HISTORY_DECLARED_SUFFICIENT`, `schema-preflight.ts`), y acá **no
 * hay nada que el operador pueda afirmar en lugar de la cadena**: la finalidad es un
 * hecho del ledger, no una política.
 *
 * En particular **NO** se usa `getSolanaCommitment()` (default `'confirmed'`,
 * env-driven) ni se hereda el commitment de la `Connection` compartida. El override es
 * **por llamada**, así que la `Connection` cacheada se puede reusar sin contaminar el
 * camino de settle.
 *
 * Honestidad, para que no se lea como una inconsistencia: `payment.ts` lee a
 * `'confirmed'` a propósito y con su razón escrita. Es el camino de SALIDA y queda
 * intacto.
 */
const DEPOSIT_COMMITMENT = 'finalized' as const;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Argumentos de `verifySolanaDeposit`. */
export interface VerifySolanaDepositArgs {
  /** Firma/txid base58 que el depositante presenta. Ya validada de FORMATO por la ruta. */
  signature: string;
  /**
   * Monto declarado por el caller (`body.amount`), OPCIONAL. Sólo se usa para
   * CONTRASTAR: el monto acreditado es siempre el de la cadena (AC-1).
   */
  expectedAmountUsd?: string | undefined;
}

/**
 * Presencia + finalidad de la firma. **Es la única fuente admitida de una negativa**,
 * porque `getSignatureStatuses(..., { searchTransactionHistory: true })` es la única
 * llamada que puede distinguir *"el nodo buscó y no la tiene"* de *"no pude
 * preguntar"*: devuelve `null` en la posición de la firma SOLO tras haber buscado.
 *
 * ⚠️ **NO se usa `getParsedTransaction` para decidir ausencia**: su `null` mezcla "no
 * existe" con "este nodo no lo tiene indexado / va atrasado".
 *
 * ⚠️ Y **la finalidad se LEE, no se hereda**. `confirmationStatus` es OPCIONAL en el
 * tipo del SDK, así que su ausencia es un caso real, no paranoia:
 *   - `'finalized'`            ⇒ seguir (evidencia POSITIVA)
 *   - `'processed'`/`'confirmed'` ⇒ `not_finalized` (negativa MEDIDA, reintentable)
 *   - **ausente / desconocido** ⇒ **`unknown`**, NO "todavía no". Es CD-14 aplicado a la
 *     finalidad misma: no sabemos si está finalizada, y afirmar "todavía no" sería
 *     inventar una medición que el nodo no dio.
 */
async function probeDepositLanding(
  connection: Connection,
  signature: string,
): Promise<SolanaDepositLanding> {
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
  // `null` DESPUES de haber buscado el histórico = prueba de ausencia. Es lo más
  // fuerte que se puede afirmar: "este nodo, buscando en lo que tiene, no conoce esta
  // firma". La precondición de que el endpoint retenga histórico la mide
  // `probeRpcHistoryRetention` en el preflight de arranque; esta HU no la re-implementa
  // ni la debilita.
  if (status === null || status === undefined) return { state: 'absent' };
  if (status.err) {
    return { state: 'landed_failed', detail: JSON.stringify(status.err) };
  }

  const conf = status.confirmationStatus;
  if (conf === 'finalized') return { state: 'finalized_ok' };
  if (conf === 'processed' || conf === 'confirmed') {
    return { state: 'not_finalized', confirmationStatus: conf };
  }
  // Ausente o un valor que no reconocemos. NO es "todavía no": es "no sé".
  return {
    state: 'unknown',
    detail: `getSignatureStatuses returned no usable confirmationStatus (got ${
      conf === undefined || conf === null ? 'absent' : JSON.stringify(conf)
    }) — cannot assert finality either way`,
  };
}

/**
 * Verifica un depósito Solana. **NUNCA lanza.** El monto acreditado es SIEMPRE el de la
 * cadena (AC-1); `expectedAmountUsd` sólo se contrasta.
 */
export async function verifySolanaDeposit(
  args: VerifySolanaDepositArgs,
): Promise<SolanaDepositVerification> {
  const { signature, expectedAmountUsd } = args;

  // ── 1. La cuenta de depósito. CHOKE-POINT UNICO del flag ──────────────────
  // La ruta NO lee `A2A_DEPOSIT_ENABLED_SOLANA`: si lo hiciera, habría dos lugares
  // que deciden si el camino de entrada de dinero está abierto.
  if (!isSolanaDepositEnabled()) {
    return {
      ok: false,
      reason: 'DEPOSIT_ACCOUNT_NOT_CONFIGURED',
      detail:
        'solana deposit path is disabled (A2A_DEPOSIT_ENABLED_SOLANA !== "true" or A2A_DEPOSIT_OWNER_SOLANA unset/invalid)',
    };
  }
  const expectedOwner = resolveSolanaDepositOwner();
  const expectedAta = resolveSolanaDepositAta();
  if (expectedOwner === null || expectedAta === null) {
    // Inalcanzable si `isSolanaDepositEnabled()` es true (exige el owner), pero el
    // compilador no lo sabe y un `!` acá sería una aserción sin chequeo.
    return {
      ok: false,
      reason: 'DEPOSIT_ACCOUNT_NOT_CONFIGURED',
      detail: 'deposit owner/ATA could not be resolved',
    };
  }

  const connection = getSolanaConnection();

  // ── 2 + 3. Presencia y finalidad ──────────────────────────────────────────
  const landing = await probeDepositLanding(connection, signature);
  switch (landing.state) {
    case 'absent':
      return { ok: false, reason: 'TX_ABSENT' };
    case 'landed_failed':
      return { ok: false, reason: 'TX_FAILED', detail: landing.detail };
    case 'not_finalized':
      return {
        ok: false,
        reason: 'DEPOSIT_NOT_FINALIZED',
        detail: `confirmationStatus=${landing.confirmationStatus}`,
      };
    case 'unknown':
      return {
        ok: false,
        reason: 'DEPOSIT_VERIFICATION_UNKNOWN',
        detail: landing.detail,
      };
    case 'finalized_ok':
      break; // seguir a los términos
  }

  // ── 4. Los términos, leídos TAMBIEN a `finalized` ─────────────────────────
  let parsed: Awaited<ReturnType<typeof connection.getParsedTransaction>>;
  try {
    parsed = await connection.getParsedTransaction(signature, {
      commitment: DEPOSIT_COMMITMENT,
      maxSupportedTransactionVersion: 0,
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'DEPOSIT_VERIFICATION_UNKNOWN',
      detail: errText(err),
    };
  }
  if (!parsed?.meta) {
    // ⚠️ `unknown`, NO un mismatch. El status dice que la tx ESTA, pero este nodo no
    // la tiene parseada: eso es "no sé qué movió", no "no coinciden los términos".
    // Devolver un mismatch acá sería afirmar en un log que la plata fue a otro lado
    // —falso— y negarle el crédito a un depósito legítimo por una causa transitoria.
    return {
      ok: false,
      reason: 'DEPOSIT_VERIFICATION_UNKNOWN',
      detail:
        'signature status reports the transaction as present and finalized, but this node has no parsed transaction for it (lagging or unindexed)',
    };
  }
  if (parsed.meta.err) {
    return {
      ok: false,
      reason: 'TX_FAILED',
      detail: JSON.stringify(parsed.meta.err),
    };
  }

  // ── 5. Clasificación de términos, EN EL ORDEN DEL EVM ─────────────────────
  // El orden espeja `adapters/deposit-verifier.ts` (TOKEN_MISMATCH antes que
  // RECIPIENT_MISMATCH) para que los códigos sean DISTINGUIBLES: el caller tiene que
  // poder saber si mandó el token equivocado o si lo mandó a la cuenta equivocada —
  // son dos errores con dos remediaciones distintas.
  const mint = getSolanaUsdcMint();
  const decimals = getSolanaUsdcDecimals();
  const meta = parsed.meta;

  // ── 5a. LAS DOS LISTAS TIENEN QUE ESTAR (fix-pack it2 · BLQ-MED-3) ────────
  //
  // ⚠️ ACA VIVIA UN `?? []`, Y UN `?? []` ES UNA SUPOSICION DISFRAZADA DE DEFAULT.
  //
  // `pre/postTokenBalances` son **opcionales** en el tipo de `@solana/web3.js`, así que
  // su ausencia llega hasta acá pasando la validación del SDK. Leerlas como listas
  // VACIAS convierte "el nodo no me mandó los saldos previos" en "los saldos previos
  // eran cero", que es una MEDICION que nadie hizo:
  //   · `pre` ausente  ⇒ `preOurs = 0` ⇒ delta = el saldo ENTERO de la tesorería
  //     (reproducido: 1001 USDC acreditados por un depósito de 1);
  //   · `post` ausente ⇒ delta NEGATIVO, y salía como `RECIPIENT_MISMATCH`, o sea una
  //     afirmación de que la plata fue a otro lado sobre un campo que faltaba.
  //
  // Es el mismo error que BLQ-MED-1 en su versión de PRESENCIA en vez de VALOR: allá
  // el dato era ilegible, acá directamente no vino. Los dos son indeterminación.
  const preRaw = meta.preTokenBalances;
  const postRaw = meta.postTokenBalances;
  if (!Array.isArray(preRaw) || !Array.isArray(postRaw)) {
    return {
      ok: false,
      reason: 'DEPOSIT_VERIFICATION_UNKNOWN',
      detail: `the parsed transaction carries no token balance list (pre present=${Array.isArray(preRaw)}, post present=${Array.isArray(postRaw)}) — without both there is no delta to measure, and an absent list is not an empty one`,
    };
  }
  // ⚠️ Y SE VALIDA EL CONTENIDO, NO SOLO EL CONTENEDOR (fix-pack it3 · MNR-1).
  // El guard de arriba miraba que las listas FUERAN listas, y con eso la cabecera
  // seguía prometiendo "NUNCA lanza" en falso: `preTokenBalances: [null]` tiraba
  // `TypeError` en el primer `b.mint` (probado). El argumento de que el superstruct del
  // SDK rechazaría esa forma aplica IGUAL a las cuatro formas que sí se cerraron, así
  // que o se cierran todas o la promesa se corrige. Se cierran.
  const isBalanceEntry = (b: unknown): boolean =>
    typeof b === 'object' &&
    b !== null &&
    typeof (b as { mint?: unknown }).mint === 'string' &&
    typeof (b as { accountIndex?: unknown }).accountIndex === 'number';
  if (!preRaw.every(isBalanceEntry) || !postRaw.every(isBalanceEntry)) {
    return {
      ok: false,
      reason: 'DEPOSIT_VERIFICATION_UNKNOWN',
      detail:
        'a token balance list contains an entry without a usable `mint`/`accountIndex` — the lists cannot be interpreted, and an uninterpretable list is not an empty one',
    };
  }
  const pre = preRaw;
  const post = postRaw;

  const mintSeen =
    pre.some((b) => b.mint === mint) || post.some((b) => b.mint === mint);
  if (!mintSeen) {
    // Ninguna entrada del mint configurado, ni antes ni después: esta tx no movió
    // nuestro token. Análogo exacto de TOKEN_MISMATCH. Comparación case-SENSITIVE.
    return {
      ok: false,
      reason: 'MINT_MISMATCH',
      detail: 'no pre/post token balance entry for the configured USDC mint',
    };
  }

  // ── 5b. MATCH TRIPLE del destino (CD-5) ───────────────────────────────────
  //
  // `mint` esperado **Y** `owner` == el owner configurado **Y** la DIRECCION de la
  // cuenta (`accountKeys[accountIndex]`) == la ATA derivada.
  //
  // ⚠️ POR QUE LAS TRES Y NO `(owner, mint)` COMO `checkTerms` DE `payment.ts`: un
  // `find` por `(owner, mint)` toma la PRIMERA de varias cuentas posibles del mismo
  // owner para el mismo mint y puede **SUB-MEDIR el delta** (el owner puede tener más
  // de una token account del mismo mint). Y CD-5 exige comparar contra la ATA, que es
  // la dirección que efectivamente se le publicó al depositante.
  //
  // ⚠️ Y SE LEE A LA DEFENSIVA (fix-pack it2 · MENOR-1). `parsed.transaction.message
  // .accountKeys` era el ÚNICO acceso encadenado sin protección del archivo: con
  // `transaction` o `message` ausentes tiraba `TypeError` —probado—, y como la ruta no
  // envuelve la llamada, salía **500 en vez de 503** y sin el evento durable que AC-6
  // exige. La cabecera promete "NUNCA lanza" y esa promesa tiene que ser verdadera, no
  // aspiracional: un módulo que se defiende de `owner`, `confirmationStatus`,
  // `pre/post` y `accountKeys[i]` ausentes y no de estos dos, no se estaba defendiendo:
  // estaba adivinando cuáles campos opcionales iban a venir.
  //
  // Sin `accountKeys` no hay match de DIRECCION, y sin match de dirección no se puede
  // afirmar ni que llegó ni que no llegó ⇒ indeterminación, no mismatch.
  const rawKeys: unknown = (
    parsed.transaction as { message?: { accountKeys?: unknown } } | undefined
  )?.message?.accountKeys;
  if (!Array.isArray(rawKeys)) {
    return {
      ok: false,
      reason: 'DEPOSIT_VERIFICATION_UNKNOWN',
      detail:
        'the parsed transaction carries no account key list — the deposit ATA address cannot be matched, so neither a credit nor a recipient mismatch can be asserted',
    };
  }
  const accountKeys: readonly unknown[] = rawKeys;
  const addressAt = (accountIndex: number): string | undefined => {
    const entry = accountKeys[accountIndex];
    if (entry === undefined || entry === null) return undefined;
    // `accountKeys` puede venir como `PublicKey` o como `ParsedMessageAccount`
    // (`{pubkey, signer, writable}`) según el tipo de mensaje. Se cubren las dos sin
    // asumir cuál — asumir la forma es cómo un fixture "válido" hace pasar un test
    // que no prueba el match.
    const pk = (entry as { pubkey?: { toBase58?: () => string } }).pubkey;
    if (pk?.toBase58) return pk.toBase58();
    const direct = entry as unknown as { toBase58?: () => string };
    if (direct.toBase58) return direct.toBase58();
    return undefined;
  };

  // ⚠️ Y TODA ENTRADA DE NUESTRO MINT TIENE QUE RESOLVER SU DIRECCION (it3 · MNR-2).
  //
  // Con `accountKeys` presente pero MAS CORTO que el `accountIndex` de una entrada,
  // `addressAt` devuelve `undefined`, `isOurAta` da `false` y el veredicto salía
  // `RECIPIENT_MISMATCH` (400, definitivo): otra vez **"no es la nuestra" dicho cuando
  // lo cierto era "no la pude leer"**. Es la fila faltante una capa más arriba, y el
  // invariante de conservación no llega a verla porque el `delta <= 0n` retorna antes.
  //
  // Va DESPUES de `MINT_MISMATCH` a propósito: para decir "mandaste otro token" no hace
  // falta resolver ninguna dirección, así que ese veredicto no depende de este dato.
  for (const b of [...pre, ...post]) {
    if (b.mint !== mint) continue;
    if (addressAt(b.accountIndex) === undefined) {
      return {
        ok: false,
        reason: 'DEPOSIT_VERIFICATION_UNKNOWN',
        detail: `a token balance entry for the configured mint points at account index ${b.accountIndex}, which the account key list does not resolve — the destination of that entry is unknown, so no recipient claim can be made`,
      };
    }
  }

  /**
   * El `owner` DECLARADO de una entrada, o `undefined` si el RPC no lo mandó.
   *
   * ⚠️ `owner` es **OPCIONAL** en el tipo de `@solana/web3.js`: su ausencia es un caso
   * real del transporte, no paranoia. Se normaliza acá una sola vez para que ningún
   * call-site vuelva a comparar un `undefined` contra una pubkey y lea el resultado
   * como "es de otro" (fix-pack AR MNR-2).
   */
  const declaredOwner = (b: {
    owner?: string | undefined;
  }): string | undefined => {
    const o = b.owner;
    return o === undefined || o === null || o === '' ? undefined : o;
  };

  const isOurAta = (b: {
    accountIndex: number;
    mint: string;
    owner?: string | undefined;
  }): boolean => {
    if (b.mint !== mint) return false;
    if (addressAt(b.accountIndex) !== expectedAta) return false;
    // ⚠️ EL `owner` AUSENTE NO DESCALIFICA (fix-pack AR MNR-2). La ATA es una PDA
    // derivada del par (mint, owner): mint + DIRECCION ya identifican la cuenta sin
    // ambigüedad, así que exigir además el `owner` no agrega ninguna seguridad — y sí
    // agregaba un falso negativo. Un RPC que omite el campo hacía que la ATA de
    // depósito no matcheara y el veredicto saliera `RECIPIENT_MISMATCH`: **una
    // afirmación de que la plata fue a otro lado hecha sobre un dato ausente**.
    // Cuando el campo SI viene y contradice al owner configurado, sigue descalificando.
    const owner = declaredOwner(b);
    return owner === undefined || owner === expectedOwner;
  };

  /**
   * El monto atómico de UNA entrada, o `null` si el `amount` no se puede leer como
   * entero decimal sin signo. `null` significa **"no pude medir"**, no "cero".
   *
   * ⚠️ POR QUE UN `try { BigInt(x) }` NO ALCANZA, y es un hallazgo del fix-pack.
   * `BigInt` **acepta cosas que no son un monto** y las convierte en silencio:
   * `BigInt('')` y `BigInt('   ')` dan `0n`, y `BigInt('0x10')` da `16n`. O sea que el
   * `catch` ni siquiera se ejecutaba para tres de las formas ilegibles más probables,
   * y del lado `pre` un `''` colapsaba el saldo previo a cero — exactamente el mismo
   * crédito del saldo entero de tesorería que BLQ-MED-1 describe, por otra puerta.
   * El RPC de Solana manda SIEMPRE un entero decimal en base 10 como string, así que
   * exigirlo no rechaza ningún dato legítimo.
   */
  const ATOMIC_AMOUNT_RE = /^\d+$/;
  const atomicOf = (b: {
    uiTokenAmount: { amount: string };
  }): bigint | null => {
    try {
      const raw = b.uiTokenAmount.amount;
      if (typeof raw !== 'string' || !ATOMIC_AMOUNT_RE.test(raw)) return null;
      return BigInt(raw);
    } catch {
      return null;
    }
  };

  /**
   * Suma de las entradas RELEVANTES. **`null` si CUALQUIERA es ilegible.**
   *
   * ⚠️ FIX-PACK AR (BLQ-MED-1) — ACA EL GUARD FALLABA ABIERTO, Y ES DINERO.
   *
   * Antes, una entrada con `amount` no parseable (`"1.0"`, `"1e9"`, cualquier string
   * que `BigInt()` rechace) se **ignoraba en silencio** y la suma seguía. Del lado
   * `post` eso sub-mide y es inofensivo. Del lado `pre` hacía `preOurs = 0n`, o sea
   * `delta = postOurs`: **el saldo ENTERO de la ATA de tesorería acreditado como si
   * fuera el depósito**. Con 1000 USDC en tesorería y un depósito de 1, acreditaba 1001.
   *
   * Y el comentario que había acá afirmaba lo contrario ("si eso hace que el delta no
   * sea > 0, nadie acredita"), que es falso del lado `pre`: un guard que afirma más de
   * lo que su evidencia sostiene.
   *
   * Un dato ilegible es **indeterminación**, y la indeterminación se rechaza SIN
   * consumir la prueba (`DEPOSIT_VERIFICATION_UNKNOWN` ⇒ 503, reintentable contra otro
   * nodo), nunca se adivina.
   */
  const sumAtomic = (
    list: readonly { uiTokenAmount: { amount: string } }[],
  ): bigint | null => {
    let total = 0n;
    for (const b of list) {
      const v = atomicOf(b);
      if (v === null) return null;
      total += v;
    }
    return total;
  };

  const preOurs = sumAtomic(pre.filter(isOurAta));
  const postOurs = sumAtomic(post.filter(isOurAta));
  if (preOurs === null || postOurs === null) {
    return {
      ok: false,
      reason: 'DEPOSIT_VERIFICATION_UNKNOWN',
      detail: `a token balance entry of the deposit ATA carries an unreadable uiTokenAmount.amount (pre readable=${preOurs !== null}, post readable=${postOurs !== null}) — the delta cannot be measured, so neither a credit nor a mismatch can be asserted`,
    };
  }
  const delta = postOurs - preOurs;

  if (delta < 0n) {
    // ⚠️ UN DELTA NEGATIVO ES IMPOSIBLE LEYENDO BIEN (fix-pack it2 · BLQ-MED-3): la
    // ATA de depósito no gasta, así que su saldo no puede haber BAJADO en una tx que
    // el depositante presenta como su depósito. Si el número da negativo, lo que
    // aprendimos es que los datos no son coherentes —no que la plata haya ido a otro
    // lado—, y `RECIPIENT_MISMATCH` (400, definitivo) era exactamente esa afirmación
    // de más. Va ANTES del `<= 0n` para no quedar tapado por él.
    return {
      ok: false,
      reason: 'DEPOSIT_VERIFICATION_UNKNOWN',
      detail: `the deposit ATA balance delta is NEGATIVE (${delta}) — a receiving account cannot lose balance, so the token balance lists are incoherent and nothing can be asserted about this transfer`,
    };
  }

  if (delta <= 0n) {
    // Hay entradas del mint, pero el saldo de NUESTRA ATA no subió. El token es el
    // correcto y el destino no. Análogo exacto de RECIPIENT_MISMATCH.
    // **Sin reembolso automático** (AC-4): el runbook manual es la remediación.
    return {
      ok: false,
      reason: 'RECIPIENT_MISMATCH',
      detail: `the configured USDC mint moved, but the balance delta of the deposit ATA is ${delta} (expected > 0)`,
    };
  }

  // ── 5c. CONSERVACION, DE LOS DOS LADOS (fix-pack it3 · BLQ-BAJO-1) ────────
  //
  // ⚠️ LA VERSION ANTERIOR DE ESTE INVARIANTE TENIA EL BUG QUE ESTE ARCHIVO CONDENA.
  //
  // Comparaba `delta <= totalSourceDrop`, y `totalSourceDrop` se calculaba con
  // `postByIndex.get(idx) ?? 0n`: una fila ausente en `post` se leía como "esa cuenta se
  // drenó entera" e **inflaba el techo**. O sea que el único insumo del guard usaba el
  // mismo `??` que el resto del fix-pack declara prohibido, y bastaba una truncación de
  // listas —que produce las dos ausencias de una sola vez— para pasar por arriba:
  // reproducido, `{ok:true, amountUsd:"1001"}` con `pre` sin la fila de nuestra ATA y
  // `post` sin la fila de la cuenta que "pagó". El techo lo inventaba la ausencia.
  //
  // El reemplazo NO es un techo: es una IGUALDAD, y trata las dos ausencias de forma
  // SIMETRICA. En una transferencia los tokens no se crean ni se destruyen, así que
  // sobre las entradas del mint tiene que valer `subió total == bajó total`:
  //   · falta una fila en `pre`  ⇒ aparece una subida sin bajada  ⇒ desigualdad;
  //   · falta una fila en `post` ⇒ aparece una bajada sin subida  ⇒ desigualdad.
  // Ninguna ausencia puede ya "pagar" por la otra, que es exactamente el agujero. Y el
  // `?? 0n` que queda es la DEFINICION consistente de los dos únicos casos reales de
  // ausencia (una cuenta creada en la tx valía 0 antes; una cerrada vale 0 después),
  // aplicada a los dos lados en vez de a uno.
  //
  // NO se compara consigo mismo: la subida de nuestra ATA se contrasta contra filas
  // DISJUNTAS (las que bajaron). El fixture del re-AR lo prueba empíricamente — si el
  // invariante recalculara su propia fórmula, los dos números habrían coincidido.
  //
  // ⚠️ SUPUESTO DECLARADO, no silencioso: el mint configurado es SPL Token clásico, sin
  // extensión de fee ni mint/burn en el camino del depositante. Si algún día el mint
  // tuviera transfer-fee (Token-2022), lo retenido haría `bajó > subió` en una tx
  // legítima y este guard la rechazaría con un 503. Es fail-CLOSED y visible, no un
  // crédito de más — pero hay que revisitarlo en ese momento, no descubrirlo.
  //
  // Y una corrección al comentario anterior, que el re-AR falsificó con razón: esto NO
  // "caza formas de corrupción que no se pueden enumerar". Caza UNA propiedad,
  // enunciable y falsable: que las dos listas cuadren entre sí sobre este mint.
  const balancesByIndex = (
    list: readonly {
      accountIndex: number;
      mint: string;
      uiTokenAmount: { amount: string };
    }[],
  ): Map<number, bigint> | null => {
    const m = new Map<number, bigint>();
    for (const b of list) {
      if (b.mint !== mint) continue;
      const v = atomicOf(b);
      if (v === null) return null;
      m.set(b.accountIndex, v);
    }
    return m;
  };
  const preByIndex = balancesByIndex(pre);
  const postByIndexAll = balancesByIndex(post);
  if (preByIndex === null || postByIndexAll === null) {
    return {
      ok: false,
      reason: 'DEPOSIT_VERIFICATION_UNKNOWN',
      detail:
        'a token balance entry for the configured mint carries an unreadable uiTokenAmount.amount — the conservation of the transfer cannot be checked',
    };
  }
  let totalUp = 0n;
  let totalDown = 0n;
  for (const idx of new Set([...preByIndex.keys(), ...postByIndexAll.keys()])) {
    const before = preByIndex.get(idx) ?? 0n;
    const after = postByIndexAll.get(idx) ?? 0n;
    if (after > before) totalUp += after - before;
    else totalDown += before - after;
  }
  if (totalUp !== totalDown) {
    return {
      ok: false,
      reason: 'DEPOSIT_VERIFICATION_UNKNOWN',
      detail: `conservation check failed for the deposit ATA mint: the listed accounts gained ${totalUp} atomic units and lost ${totalDown} — a transfer neither creates nor destroys tokens, so at least one balance row is missing and the credited amount cannot be trusted`,
    };
  }

  // ── 6. El depositante: el owner que BAJA, NO el fee-payer (AC-7 / AC-15) ──
  //
  // ⚠️ El análogo de `Transfer.from` en Solana es el **owner de la cuenta de ORIGEN**,
  // o sea el `owner` de las entradas del mint cuyo delta es NEGATIVO. Se lee de
  // `preTokenBalances`, que es donde el `owner` está poblado aun si la cuenta se cierra
  // en la misma tx.
  //
  // **NO es el fee-payer**: en Solana el fee-payer puede ser un tercero (gasless) y no
  // tiene por qué haber puesto los fondos. Usar el primer firmante haría que un
  // depósito gasless se atribuyera al relayer y el gate rechazara al dueño real.
  //
  // ⚠️ Y UN DATO ILEGIBLE ACA TAMPOCO SE SALTEA (misma familia que BLQ-MED-1). Un
  // `amount` que no parsea o un `owner` que el RPC no mandó no producen "este no es el
  // origen": producen **"no sé quién es el origen"**. Saltearlos hacía que la
  // atribución se decidiera sobre las entradas que SI se pudieron leer, y con eso
  // `sourceOwners` podía quedar en exactamente uno —el equivocado— y acreditarle el
  // depósito a quien no lo hizo, o caer en un `DEPOSITOR_AMBIGUOUS` (400, definitivo)
  // que afirma un hecho de la cadena sobre un campo que faltaba.
  //
  // ⚠️ EL `?? 0n` DE ACA ABAJO SIGUE, Y AHORA SI ES DEFENDIBLE (it3 · BLQ-BAJO-1).
  // Cambió su ROL, que es lo que lo hacía peligroso: ya no alimenta ningún techo de
  // crédito —el invariante de conservación de §5c ya corrió y ya rechazó cualquier
  // lista que no cuadre—, sólo sirve para IDENTIFICAR quién bajó. Y su modo de falla es
  // el contrario del anterior: si sobra un candidato, el veredicto es
  // `DEPOSITOR_AMBIGUOUS` o un owner que el gate de funding wallet rechaza. Fail-CLOSED.
  const sourceOwners = new Set<string>();
  for (const b of pre) {
    if (b.mint !== mint) continue;
    const before = atomicOf(b);
    if (before === null) {
      return {
        ok: false,
        reason: 'DEPOSIT_VERIFICATION_UNKNOWN',
        detail: `a preTokenBalance entry for the configured mint carries an unreadable uiTokenAmount.amount — the depositor cannot be determined`,
      };
    }
    // Si la cuenta desapareció de `post` (se cerró), su saldo pasó a 0.
    const after = postByIndexAll.get(b.accountIndex) ?? 0n;
    if (after - before >= 0n) continue; // no bajó: no es un origen
    const owner = declaredOwner(b);
    if (owner === undefined) {
      // La cuenta BAJO —o sea que ES un origen— pero el nodo no dijo de quién es.
      // Eso es "no pude preguntar", no "hay más de un candidato".
      return {
        ok: false,
        reason: 'DEPOSIT_VERIFICATION_UNKNOWN',
        detail:
          'a source token account for the configured mint lost balance but its `owner` is absent in preTokenBalances — the depositor cannot be named',
      };
    }
    sourceOwners.add(owner);
  }

  if (sourceOwners.size !== 1) {
    // ⚠️ FAIL-CLOSED, y a propósito. Con dos o más owners de origen, ADIVINAR cuál es
    // el depositante es exactamente donde se pierde el gate: elegir mal atribuye el
    // depósito a quien no lo hizo. Un wallet legítimo no produce este caso.
    //
    // ── MNR-4 (it3): POR QUE ESTE 400 VA DESPUES DE LA CONSERVACION Y NO ANTES ──
    //
    // La pregunta del re-AR era si este veredicto le gana la carrera al invariante y
    // afirma "tu tx tiene orígenes ambiguos" cuando lo cierto es "las listas venían
    // incompletas". **Le ganaba, y por eso se movió**: la conservación (§5c) ahora corre
    // ANTES. La regla general que se aplicó: *un veredicto de INDETERMINACION tiene que
    // preceder a cualquier veredicto MEDIDO que se derive de los mismos datos
    // posiblemente incompletos* — si no, el 400 definitivo se emite sobre evidencia que
    // el guard de al lado habría descalificado.
    //
    // Contrapunto honesto del propio re-AR, y su costo aceptado: un `mint_to` legítimo
    // (tokens creados, sin cuenta de origen) también da cero orígenes, y ahora sale como
    // `DEPOSIT_VERIFICATION_UNKNOWN` en vez de `DEPOSITOR_AMBIGUOUS`, porque crear
    // tokens ES una violación de conservación. Se eligió así porque las frecuencias no
    // se parecen: una lista truncada es plausible en cualquier RPC, mientras que mintear
    // USDC hacia nuestra ATA exige la autoridad de emisión de Circle. Los dos casos
    // RECHAZAN el crédito; se optimizó cuál de los dos recibe el diagnóstico exacto.
    //
    // Con la conservación verificada, `size === 0` queda prácticamente inalcanzable y el
    // chequeo se vuelve defensivo (el compilador tampoco sabe que no puede pasar).
    return {
      ok: false,
      reason: 'DEPOSITOR_AMBIGUOUS',
      detail: `expected exactly 1 distinct source owner for the mint, found ${sourceOwners.size}`,
    };
  }
  const depositor = [...sourceOwners][0] as string;

  // ── 7. El monto declarado (opcional): BigInt contra BigInt ────────────────
  if (expectedAmountUsd !== undefined) {
    // ⚠️ **PROHIBIDO `usdToAtomicUnits`**: toma un `number`, y FIX-3 del verificador
    // EVM existe precisamente para NO pasar el monto declarado por un float
    // (`Number('1.000000000000000001')` colapsa a `1`). `parseUnits` de viem es
    // matemática decimal pura sobre el string.
    let expectedAtomic: bigint | undefined;
    try {
      expectedAtomic = parseUnits(expectedAmountUsd, decimals);
    } catch {
      expectedAtomic = undefined;
    }
    if (expectedAtomic === undefined || expectedAtomic !== delta) {
      return {
        ok: false,
        reason: 'AMOUNT_MISMATCH',
        detail: `declared ${expectedAmountUsd} != on-chain ${formatUnits(delta, decimals)}`,
      };
    }
  }

  // ── 8. Éxito. El monto acreditado es el DE LA CADENA (AC-1) ───────────────
  return {
    ok: true,
    amountAtomic: delta,
    amountUsd: formatUnits(delta, decimals),
    depositor,
    ata: expectedAta,
    mint,
    signature,
  };
}
