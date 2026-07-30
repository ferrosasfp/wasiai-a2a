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
  // La ruta NO lee `A2A_SOLANA_DEPOSIT_ENABLED`: si lo hiciera, habría dos lugares
  // que deciden si el camino de entrada de dinero está abierto.
  if (!isSolanaDepositEnabled()) {
    return {
      ok: false,
      reason: 'DEPOSIT_ACCOUNT_NOT_CONFIGURED',
      detail:
        'solana deposit path is disabled (A2A_SOLANA_DEPOSIT_ENABLED !== "true" or A2A_DEPOSIT_SOLANA_OWNER unset/invalid)',
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

  const isOurAta = (b: {
    accountIndex: number;
    mint: string;
    owner?: string | undefined;
  }): boolean =>
    b.mint === mint &&
    b.owner === expectedOwner &&
    addressAt(b.accountIndex) === expectedAta;

  const atomicOf = (
    list: readonly { uiTokenAmount: { amount: string } }[],
  ): bigint => {
    let total = 0n;
    for (const b of list) {
      try {
        total += BigInt(b.uiTokenAmount.amount);
      } catch {
        // Un `amount` no numérico es un dato que no podemos sumar. Se ignora la
        // entrada en vez de lanzar; si eso hace que el delta no sea > 0, el veredicto
        // será RECIPIENT_MISMATCH y nadie acredita nada.
      }
    }
    return total;
  };

  const preOurs = atomicOf(pre.filter(isOurAta));
  const postOurs = atomicOf(post.filter(isOurAta));
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
  const postByIndex = new Map<number, bigint>();
  for (const b of post) {
    if (b.mint !== mint) continue;
    try {
      postByIndex.set(b.accountIndex, BigInt(b.uiTokenAmount.amount));
    } catch {
      /* amount ilegible: la entrada no puede sostener una afirmación de origen */
    }
  }
  const sourceOwners = new Set<string>();
  for (const b of pre) {
    if (b.mint !== mint) continue;
    const owner = b.owner;
    if (owner === undefined || owner === null || owner === '') continue;
    let before: bigint;
    try {
      before = BigInt(b.uiTokenAmount.amount);
    } catch {
      continue;
    }
    // Si la cuenta desapareció de `post` (se cerró), su saldo pasó a 0.
    const after = postByIndex.get(b.accountIndex) ?? 0n;
    if (after - before < 0n) sourceOwners.add(owner);
  }

  if (sourceOwners.size !== 1) {
    // ⚠️ FAIL-CLOSED, y a propósito. Con dos o más owners de origen, ADIVINAR cuál es
    // el depositante es exactamente donde se pierde el gate: elegir mal atribuye el
    // depósito a quien no lo hizo. Un wallet legítimo no produce este caso.
    // Cero (imposible si el delta de destino es > 0, pero el compilador no lo sabe)
    // cae acá también, en vez de colarse como un `undefined`.
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
