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
  const pre = meta.preTokenBalances ?? [];
  const post = meta.postTokenBalances ?? [];

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
  const accountKeys = parsed.transaction.message.accountKeys;
  const addressAt = (accountIndex: number): string | undefined => {
    const entry = accountKeys[accountIndex];
    if (entry === undefined) return undefined;
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
  const postByIndex = new Map<number, bigint>();
  for (const b of post) {
    if (b.mint !== mint) continue;
    const after = atomicOf(b);
    if (after === null) {
      return {
        ok: false,
        reason: 'DEPOSIT_VERIFICATION_UNKNOWN',
        detail: `a postTokenBalance entry for the configured mint carries an unreadable uiTokenAmount.amount — the depositor cannot be determined`,
      };
    }
    postByIndex.set(b.accountIndex, after);
  }
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
    const after = postByIndex.get(b.accountIndex) ?? 0n;
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
    // Cero cae acá también, en vez de colarse como un `undefined`. Es alcanzable con
    // un `pre` que no lista la cuenta de origen; lo que YA NO llega hasta acá es el
    // dato ausente o ilegible, que sale arriba como indeterminación.
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
