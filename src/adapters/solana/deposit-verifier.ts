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

  // ── LA IDENTIDAD DE UNA CUENTA ES SU DIRECCION (fix-pack it5 · BLQ-ALTO-1) ─
  //
  // ⚠️ EL `owner` YA NO DECIDE A QUE CUENTA PERTENECE UNA FILA, Y ESE ERA EL AGUJERO.
  //
  // Antes, una fila cuyo `owner` declarado no coincidía con el configurado se
  // descalificaba como "no es la nuestra" y pasaba a contarse como **otra cuenta**. Con
  // eso, dos índices que resolvían a la MISMA dirección esquivaban el guard de
  // duplicados con sólo mentir el `owner` de una de las dos filas: una entraba como
  // nuestra ATA y la otra financiaba el crédito desde el otro lado de la ecuación
  // (reproducido: 1001 USDC por un depósito de 1). Un campo que el emisor del dato
  // controla no puede decidir en qué cubeta cae una fila.
  //
  // La ATA es una PDA derivada de (mint, owner): **la dirección ya es la identidad**.
  // Un `owner` declarado que contradice esa derivación no descalifica la fila: es una
  // CONTRADICCION del dataset consigo mismo, y eso es indeterminación.
  const isOurAta = (b: { accountIndex: number; mint: string }): boolean =>
    b.mint === mint && addressAt(b.accountIndex) === expectedAta;

  for (const b of [...pre, ...post]) {
    if (!isOurAta(b)) continue;
    const owner = declaredOwner(b);
    // El `owner` AUSENTE no descalifica (fix-pack AR MNR-2): mint + dirección ya
    // identifican la cuenta, y exigirlo agregaba un falso negativo sobre un campo
    // opcional. Presente y contradictorio es otra cosa: es un dato imposible.
    if (owner !== undefined && owner !== expectedOwner) {
      return {
        ok: false,
        reason: 'DEPOSIT_VERIFICATION_UNKNOWN',
        detail: `a token balance row for the deposit ATA address declares owner ${owner}, but that address is the associated token account derived for ${expectedOwner} — the dataset contradicts itself and no balance can be read from it`,
      };
    }
  }

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
  /**
   * ═══════════════════════════════════════════════════════════════════════════
   * ── UNA SOLA TABLA, UNA SOLA DERIVACION (fix-pack it4 · CAMBIO ESTRUCTURAL) ─
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * ⚠️ POR QUE ESTO SE REESCRIBIO EN VEZ DE AGREGAR UN CUARTO GUARD.
   *
   * Durante tres iteraciones el crédito se calculaba por un camino y se auditaba por
   * otro, y **nada obligaba a que los dos números hablaran del mismo hecho**:
   *   · el crédito sumaba POR ENTRADA (`sumAtomic(post.filter(isOurAta))`);
   *   · el invariante agregaba POR INDICE con "gana la última" sobre todas las entradas
   *     del mint, y sus totales **nunca se comparaban contra el delta**.
   * Dos agregaciones paralelas con reglas distintas no se restringen entre sí, así que
   * cada iteración podía cerrar un caso y dejar la familia viva. Cuatro veces salió la
   * misma respuesta literal —`{ok:true, amountUsd:"1001"}` por un depósito de 1— por
   * cuatro caminos distintos. El bug no era ninguno de los cuatro: era la ESTRUCTURA.
   *
   * Ahora hay **una sola tabla canónica por lista** (DIRECCION → monto, del mint
   * configurado) y **todo** sale de ella: el delta que se acredita y la medición que lo
   * audita. La ecuación final compara el crédito contra filas DISJUNTAS de la misma
   * tabla, así que los dos números están obligados a hablar del mismo hecho.
   *
   * ── LO QUE ESTE ARCHIVO GARANTIZA, EN SU FORMA FALSABLE (it5) ──────────────
   *
   * ⚠️ Cada frase de acá tiene que poder romperse nombrando un input concreto. Si no se
   * puede nombrar, la frase dice de más — y decir de más es lo que produjo CINCO
   * iteraciones: una afirmación universal que la fórmula no sostenía hizo, cada vez, que
   * todos dejáramos de buscar en esa dirección. El sobre-anuncio no es un problema de
   * estilo: es un apagador de revisiones.
   *
   * GARANTIA: **ninguna incoherencia de PRESENCIA, DUPLICACION, ILEGIBILIDAD o IDENTIDAD
   * de filas puede inflar el crédito.** Las cuatro clases tienen guard propio, test con
   * nombre y un caso adversario en `deposit-verifier.fuzz.test.ts`, donde además se
   * midió que **neutralizar cualquiera de los guards pone ese archivo en rojo**.
   *
   * ⚠️ SIN CIFRAS ACA (fix-pack it6 · BLQ-2). Esta prosa citaba "206 mutaciones y 21.321
   * pares" mientras el fuzz commiteado corría 103 y 5.253: un sobre-anuncio de 2× y 4×
   * **sobre la evidencia**, en el comentario que gobierna un guard de dinero. Un número
   * en prosa se desactualiza en silencio y nadie se entera; el que assertea un test se
   * pone rojo. Los conteos viven en el fuzz, con `expect`.
   *
   * LIMITE, escrito como límite y no como pendiente: un dataset **internamente
   * coherente pero falso** —una historia consistente, "esta cuenta tenía 1000 y los
   * mandó acá"— es indistinguible de un depósito legítimo por cualquier chequeo local,
   * porque es idéntico a lo que ese depósito produciría. Ningún invariante sobre estas
   * dos listas puede rechazarlo. Lo que acota ese riesgo no vive acá: es la confianza en
   * el endpoint RPC configurado y la finalidad medida con `getSignatureStatuses`.
   *
   * Reglas de construcción, las tres fail-CLOSED:
   *  1. **Dirección repetida ⇒ se RECHAZA la tx** (y el `accountIndex` repetido cae en la
   *     misma regla, porque resuelve a la misma dirección). No se define un desempate.
   *     Justificación (que el orquestador pidió por escrito): `pre/postTokenBalances`
   *     tiene, por construcción, **una entrada por token account tocada** — el
   *     `accountIndex` es la clave en `accountKeys`, y un mensaje de Solana no puede
   *     listar la misma cuenta dos veces. Dos filas para el mismo índice no son un dato
   *     legítimo: son corrupción, un proxy que concatenó, o una inyección. Elegir cuál
   *     creer sería **adivinar entre dos afirmaciones contradictorias sobre la misma
   *     cuenta**, que es exactamente lo que esta HU prohíbe — y era observable: con la
   *     regla "gana la última", invertir el orden de dos renglones cambiaba el veredicto
   *     de `ok:true` a `UNKNOWN`. Un resultado que depende de la POSICION de una fila no
   *     es una medición.
   *  2. **Monto ilegible ⇒ se rechaza** (la tabla no se construye a medias).
   *  3. La tabla es la ÚNICA fuente: nadie vuelve a leer `b.uiTokenAmount` después.
   */
  type CanonicalTable =
    | { ok: true; byAddress: Map<string, bigint> }
    | { ok: false; detail: string };

  const canonicalize = (
    list: readonly {
      accountIndex: number;
      mint: string;
      uiTokenAmount: { amount: string };
    }[],
    label: 'preTokenBalances' | 'postTokenBalances',
  ): CanonicalTable => {
    const byAddress = new Map<string, bigint>();
    for (const b of list) {
      if (b.mint !== mint) continue;
      // La clave es la DIRECCION, no el `accountIndex` (fix-pack it5 · BLQ-ALTO-1).
      // Mi propia premisa para rechazar el índice repetido —"un mensaje no puede listar
      // la misma cuenta dos veces"— se viola también en su forma de DIRECCION, y ahí no
      // rechazaba: dos índices distintos apuntando a la misma pubkey eran, para la
      // tabla, dos cuentas. Indexar por lo que de verdad identifica a la cuenta hace
      // que las dos formas del mismo problema caigan en la misma regla, y **sin
      // consultar el `owner`**, que es lo que hacía esquivable el guard anterior.
      // `addressAt` no puede devolver `undefined` acá: toda fila del mint ya pasó el
      // guard de resolución de arriba; el `?? ''` sólo satisface al compilador y, si
      // alguna vez se alcanzara, colapsaría las filas irresolubles en una sola clave:
      // con DOS o más el chequeo de duplicado las rechaza; con UNA sola no hay duplicado
      // y contaría como otra cuenta, así que la afirmación "fail-closed en los dos casos"
      // que había acá decía de más. El estado es inalcanzable —verificado instrumentando
      // este punto con un `throw`, con la suite y el fuzz enteros en verde—, pero eso lo
      // sostiene el guard de resolución de arriba, no este `??`.
      const addr = addressAt(b.accountIndex) ?? '';
      if (byAddress.has(addr)) {
        return {
          ok: false,
          detail: `${label} carries TWO entries for the same account ${addr} of the configured mint (the second one at index ${b.accountIndex}) — a token account appears at most once per list, so these two rows are contradictory statements about the same account and no balance can be derived from them`,
        };
      }
      const v = atomicOf(b);
      if (v === null) {
        return {
          ok: false,
          detail: `${label} carries an entry for the configured mint with an unreadable uiTokenAmount.amount — the balance table cannot be built, and a table built with holes is not a measurement`,
        };
      }
      byAddress.set(addr, v);
    }
    return { ok: true, byAddress };
  };

  const preTable = canonicalize(pre, 'preTokenBalances');
  const postTable = canonicalize(post, 'postTokenBalances');
  if (!preTable.ok || !postTable.ok) {
    return {
      ok: false,
      reason: 'DEPOSIT_VERIFICATION_UNKNOWN',
      detail: preTable.ok
        ? (postTable as { detail: string }).detail
        : preTable.detail,
    };
  }
  const preByAddr = preTable.byAddress;
  const postByAddr = postTable.byAddress;

  // ── PRESENCIA BILATERAL, PARA **TODA** FILA DEL MINT ──────────────────────
  //
  // ⚠️ FIX-PACK it5 · BLQ-ALTO-2 — Y ES LA TERCERA VEZ QUE COMETO ESTE ERROR DE FORMA.
  //
  // En it4 escribí la regla —una cuenta aparece en las dos listas o en ninguna, porque
  // "sólo en una" tiene dos lecturas con créditos distintos— y **la apliqué únicamente a
  // NUESTRA fila**. Para las demás quedó un `?? 0n` que dejaba a una fila de un solo
  // lado aportar valor sin límite del lado derecho de la ecuación. Con eso, una fila que
  // sólo existe en `pre` financiaba un `delta` inflado y **la igualdad cerraba**:
  // reproducido, 1001 USDC por un depósito de 1. Mover el lado derecho no siempre
  // produce desigualdad — también puede RESTAURARLA contra un izquierdo ya inflado, que
  // es justo el paso que yo había dado por válido.
  //
  // La misma ambigüedad que hacía inaceptable la asimetría en nuestra fila la hace
  // inaceptable en cualquiera: una fila sólo en `pre` es "cuenta cerrada" (bajó todo) o
  // "fila perdida" (bajó una cantidad desconocida), y las dos lecturas dan créditos
  // distintos. La regla no puede depender de QUIEN es el dueño de la fila.
  //
  // ── COSTO, MEDIDO Y DECLARADO ─────────────────────────────────────────────
  // Pasan a `503 UNKNOWN` (sin consumir la prueba, con evento durable) las txs que
  // CREAN o CIERRAN una cuenta **del mint configurado** en la misma tx del depósito:
  //   · el depositante cierra su cuenta de USDC en la misma tx en que deposita
  //     ("transfer + close" para recuperar el rent) — es el caso realista;
  //   · el depósito viene acompañado de un pago a un tercero que todavía no tiene ATA
  //     de USDC y la crea en esa misma tx.
  // NO afectan: crear/cerrar cuentas de OTROS mints (el caso común de las rutas de swap
  // con WSOL temporal), porque acá sólo se miran filas del mint configurado.
  // Remediación del depositante: repetir el depósito sin cerrar la cuenta en la misma
  // tx; o el runbook manual, que ya existe. Es molesto y recuperable; un crédito inflado
  // no lo es, y cuando los dos errores no cuestan lo mismo el default va del lado barato.
  for (const addr of new Set([...preByAddr.keys(), ...postByAddr.keys()])) {
    const inPre = preByAddr.has(addr);
    const inPost = postByAddr.has(addr);
    if (inPre !== inPost) {
      return {
        ok: false,
        reason: 'DEPOSIT_VERIFICATION_UNKNOWN',
        detail: `account ${addr}${addr === expectedAta ? ' (the deposit ATA)' : ''} appears in only ONE of the two token balance lists (pre=${inPre}, post=${inPost}) — that is either an account created/closed in this transaction or a lost row, and the two readings credit different amounts, so neither can be asserted`,
      };
    }
  }

  // ── EL DELTA, DERIVADO UNA SOLA VEZ Y SOLO DE FILAS PRESENTES ─────────────
  // Después del guard de arriba, nuestra dirección está en las dos tablas o en ninguna,
  // así que estos dos `?? 0n` ya no son una suposición: son el caso "no aparece en
  // ninguna", que es un delta de cero medido, no un default que rellena un hueco.
  const delta =
    (postByAddr.get(expectedAta) ?? 0n) - (preByAddr.get(expectedAta) ?? 0n);

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

  // ── LA ECUACION QUE CIERRA SOBRE LO QUE SE ACREDITA ───────────────────────
  //
  // ⚠️ ESTE ES EL GUARD, Y AHORA SI GUARDA: SU LADO IZQUIERDO **ES** EL CREDITO.
  //
  //        delta (lo que se acredita)  ===  la BAJA NETA de todas las demás cuentas
  //
  // Las tres versiones anteriores fallaban por lo mismo: calculaban totales que **nunca
  // se comparaban contra `delta`**. Dos números que no se tocan no se restringen. Acá el
  // lado izquierdo es exactamente la cantidad que se va a acreditar y el derecho se
  // computa sobre filas DISJUNTAS de la misma tabla canónica (todos los índices menos el
  // nuestro), así que el guard no puede recalcular la fórmula que vigila ni quedar
  // satisfecho por coincidencia entre dos agregaciones distintas.
  //
  // Por qué es correcta: en una transferencia los tokens no se crean ni se destruyen, así
  // que lo que entró a nuestra cuenta tiene que ser exactamente lo que salió netamente
  // del resto. Un depósito legítimo la cumple; una tx que además le paga a un tercero
  // también (ese tercero SUBE, así que baja la baja neta del resto en la misma medida).
  //
  // ── LO QUE ESTA ECUACION SI GARANTIZA, Y LO QUE NO (fix-pack it5 · prosa) ──
  //
  // ⚠️ LA VERSION ANTERIOR DE ESTE COMENTARIO ERA FALSA, y el sobre-anuncio es la causa
  // raíz de las cuatro iteraciones: decía *"cualquier fila ausente de otra cuenta sólo
  // puede mover el lado DERECHO, y moverlo produce desigualdad"*. **El paso no vale**:
  // mover el lado derecho también puede RESTAURAR la igualdad contra un lado izquierdo
  // ya inflado, que es exactamente lo que hacía CE1. Cada vez que escribí una propiedad
  // universal que la fórmula no sostenía, esa frase hizo que todos —yo incluido—
  // dejáramos de buscar en esa dirección. Una afirmación de más en un comentario es un
  // apagador de revisiones.
  //
  // GARANTIA, en su forma falsable: **ninguna incoherencia de PRESENCIA, DUPLICACION,
  // ILEGIBILIDAD o IDENTIDAD de filas puede inflar el crédito.** Cada una de esas cuatro
  // clases tiene su guard, su test con nombre y su caso adversario en el fuzz; los
  // conteos del barrido los assertea el propio fuzz y no se repiten acá, porque un número
  // escrito en prosa se desactualiza en silencio (pasó: esta línea citaba un barrido 2×
  // y 4× más grande que el commiteado). Y cada frase de acá se puede romper nombrando un
  // input concreto — si no, diría de más.
  //
  // ⚠️ LIMITE DEL ALCANCE, escrito como límite y no como pendiente: un dataset
  // INTERNAMENTE COHERENTE pero falso —una historia consistente: "esta cuenta tenía 1000
  // y los mandó acá"— es indistinguible de un depósito legítimo por cualquier chequeo
  // local, porque es idéntico a lo que produciría ese depósito. Ningún invariante sobre
  // estas dos listas puede rechazarlo, así que la afirmación universal "ninguna
  // incoherencia puede inflar el crédito" **nunca podrá ser verdadera contra un RPC que
  // miente**. Lo que acota ese riesgo no vive en este archivo: es la confianza en el
  // endpoint (`SOLANA_RPC_URL`, config del operador) y la finalidad leída con
  // `getSignatureStatuses`.
  //
  // ⚠️ SUPUESTO DECLARADO: el mint configurado es SPL Token clásico, sin extensión de fee
  // ni mint/burn en el camino del depositante. Con Token-2022 y fee, lo retenido rompería
  // la igualdad en una tx legítima y esto la rechazaría con un 503: fail-CLOSED y
  // visible, no un crédito de más — pero hay que revisitarlo ahí, no descubrirlo.
  //
  // Nota sobre los `?? 0n` de abajo: NO son un default sobre un hueco. La presencia
  // bilateral ya corrió, así que toda dirección de la unión está en las DOS tablas; el
  // `?? 0n` es inalcanzable y sólo satisface al compilador.
  let othersNetDrop = 0n;
  for (const addr of new Set([...preByAddr.keys(), ...postByAddr.keys()])) {
    if (addr === expectedAta) continue;
    othersNetDrop += (preByAddr.get(addr) ?? 0n) - (postByAddr.get(addr) ?? 0n);
  }
  if (delta !== othersNetDrop) {
    return {
      ok: false,
      reason: 'DEPOSIT_VERIFICATION_UNKNOWN',
      detail: `conservation check failed: the deposit ATA gained ${delta} atomic units while the other accounts of the mint dropped ${othersNetDrop} net — a transfer neither creates nor destroys tokens, so at least one balance row is missing or contradictory and no claim about this transfer can be made`,
    };
  }

  if (delta <= 0n) {
    // Hay entradas del mint, pero el saldo de NUESTRA ATA no subió. El token es el
    // correcto y el destino no. Análogo exacto de RECIPIENT_MISMATCH.
    // **Sin reembolso automático** (AC-4): el runbook manual es la remediación.
    //
    // ── BLQ-BAJO-2 (it4): POR QUE ESTE 400 SE MOVIO DESPUES DE LA ECUACION ──
    //
    // Yo mismo declaré en MNR-4 que *un veredicto de indeterminación precede a
    // cualquier veredicto medido derivado de los mismos datos posiblemente
    // incompletos*, y después lo apliqué **sólo a `DEPOSITOR_AMBIGUOUS`**. Este
    // `RECIPIENT_MISMATCH` sale de las mismas listas y corría ANTES: con las filas de
    // nuestra ATA truncadas de las dos listas, contestaba —definitivamente, con un 400 y
    // por lo tanto **sin el evento durable** de `routes/auth/deposit.ts`— que la plata
    // fue a otra cuenta, y con un `detail` IDENTICO al del destino genuinamente
    // equivocado. Indistinguibles para el caller y para el operador, y sin rastro para
    // reconciliar.
    //
    // Con la ecuación adelante, los dos casos se separan solos y sin ningún guard nuevo:
    //   · destino equivocado de verdad ⇒ nuestra ATA no aparece (nadie la tocó), las
    //     listas CUADRAN y este 400 es una afirmación MEDIDA;
    //   · filas truncadas ⇒ alguien bajó y nadie subió ⇒ la ecuación falla primero ⇒
    //     503 `UNKNOWN` con evento durable y sin consumir la prueba.
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
  // ⚠️ Y LEE DE LA TABLA CANONICA, NO DEL CRUDO (it4). Antes volvía a llamar a
  // `atomicOf` sobre las mismas filas: una SEGUNDA derivación del mismo número, que es
  // la forma exacta del bug estructural que esta iteración vino a cerrar. Acá sólo se
  // usa el crudo para el `owner`, que la tabla no lleva.
  //
  // ⚠️ Y ACA YA NO QUEDA NINGUN `?? 0n` (fix-pack it5). El que había leía "ausente de
  // `post`" como "se drenó entera", que es la misma suposición que BLQ-ALTO-2 vino a
  // cerrar. Con la presencia bilateral exigida para TODA fila del mint, una cuenta
  // ausente de `post` ya no llega hasta acá: la tx se rechazó antes. Los dos saldos
  // existen o no se llega.
  const sourceOwners = new Set<string>();
  for (const b of pre) {
    if (b.mint !== mint) continue;
    const addr = addressAt(b.accountIndex) ?? '';
    const before = preByAddr.get(addr);
    const after = postByAddr.get(addr);
    if (before === undefined || after === undefined) {
      // Inalcanzable: las tablas se construyeron de estas mismas listas y la presencia
      // bilateral ya corrió. El compilador no lo sabe, y un `!` sería una aserción sin
      // chequeo.
      return {
        ok: false,
        reason: 'DEPOSIT_VERIFICATION_UNKNOWN',
        detail:
          'a preTokenBalance entry for the configured mint is missing from the canonical balance table — the depositor cannot be determined',
      };
    }
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
