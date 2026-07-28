import {
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';
import {
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js';
import { usdToAtomicUnits } from '../../lib/atomic-amount.js';
import { MAX_COMPOSE_STEPS } from '../../lib/compose-limits.js';
import { getLogger } from '../../lib/logger.js';
import type {
  SolanaPaymentAdapter as ISolanaPaymentAdapter,
  QuoteResult,
  SettleResult,
  SolanaSettleProof,
  SolanaSettleRequest,
  SolanaTokenSpec,
  VerifyResult,
} from '../types.js';
import { base58Encode } from './base58.js';
import {
  getSolanaCaip2,
  getSolanaCommitment,
  getSolanaConnection,
  getSolanaOperatorKeypair,
  getSolanaUsdcDecimals,
  getSolanaUsdcMint,
} from './chain.js';

/**
 * Solana devnet SPL-transfer payment adapter (WKH-234). Settle-only,
 * operator-signed (espejo del path EVM Avalanche/Base). NO EIP-3009, NO 0x.
 *
 * - `settle`: build + sign + broadcast + confirm de un SPL transfer real,
 *   idempotente por `intentId` (AC-7, verify-before-trust en el re-intento).
 *   WKH-235a (AC-1/AC-2): si la confirmación falla (p. ej.
 *   `TransactionExpiredTimeoutError`) pero la tx SÍ se confirmó on-chain, la
 *   firma se recupera y el settle se reporta exitoso — nunca se re-broadcastea.
 * - `verify`: re-lee la tx on-chain (getParsedTransaction) y asserta un transfer
 *   `>= amountAtomic` del mint hacia la ATA de `payTo` (verify-before-trust).
 *
 * `SOLANA_OPERATOR_PRIVATE_KEY` NUNCA se loguea (CD-3): solo pubkey / firma.
 */

const log = getLogger('solana');

const SOLANA_SCHEME = 'spl-transfer' as const;
const SOLANA_MAX_TIMEOUT_SECONDS = 60 as const;
const USDC_SYMBOL = 'USDC' as const;

// QuoteResult.token.address es `0x${string}` (superficie EVM). Solana no tiene
// address 0x → sentinel zero-address (NO es un contrato real; el mint canónico
// se lee vía getMint()). Documentado para no confundir con un token EVM.
const ZERO_EVM_ADDRESS =
  '0x0000000000000000000000000000000000000000' as `0x${string}`;

// ── Idempotencia (DT-10 / AC-7) — seam W3 ────────────────────────────────
// Registro intentId → firma confirmada. En W3 es un store in-memory por proceso
// (suficiente para el path idempotente + su unit test); en W5 el almacén real
// es la columna `settle_signature` del ledger (persist-before-side-effect).
//
// ─── Fix-pack P1 (hallazgo 5): cap + TTL ────────────────────────────────
// El Map no tenía cota: cada intent dejaba una entrada PARA SIEMPRE (los únicos
// borrados eran el self-heal y el reset de tests) → leak de memoria en un
// proceso de larga vida.
//
// ⚠️ SEMÁNTICA QUE NO SE PUEDE ROMPER: este Map es lo que hace IDEMPOTENTE el
// settle de un leg Solana (`settle()`: si el intentId ya tiene firma, se verifica
// on-chain y se devuelve la previa en vez de re-broadcastear). Si una entrada
// desaparece MIENTRAS EL INTENT SIGUE VIVO, un retry re-broadcastea → SE PAGA
// DOS VECES.
//
// Dato que acota el problema: el `intentId` es `${composeRunId}:${i}` con
// `composeRunId = randomUUID()` por ejecución (services/compose.ts). Como el UUID
// es fresco por run, NINGUNA ejecución futura vuelve a preguntar por un intentId
// viejo → una entrada sólo necesita sobrevivir a la ventana de vida de SU PROPIO
// compose-run.
//
// Política (ver `resolveIntentTtlMs` / `evictIntentSignatures`): TTL con margen
// sobre la COTA ESTIMADA de vida de un run + cap SOFT con ventana protegida. Ante
// la duda se CONSERVA la entrada (fail-safe hacia no-pagar-dos-veces).

interface IntentEntry {
  signature: string;
  /** `Date.now()` del alta. La entrada expira a `storedAt + TTL`. */
  storedAt: number;
}

/** Insertion-ordered (garantía de `Map`) → iterar da de más viejo a más nuevo. */
const _intentSignatures = new Map<string, IntentEntry>();

/** Default del timeout de un compose-run (`routes/compose.ts`: 180_000 ms). */
const DEFAULT_COMPOSE_TIMEOUT_MS = 180_000;
/** Piso absoluto del TTL default: 30 min. */
const MIN_DEFAULT_TTL_MS = 1_800_000;
/** Margen del TTL default sobre `TIMEOUT_COMPOSE_MS`. */
const TTL_SAFETY_FACTOR = 10;
/** Margen del TTL default sobre la cota estimada de vida de un run. */
const TTL_MARGIN_OVER_RUN_BOUND = 2;
/** Cap SOFT de entradas. Ver `evictIntentSignatures`. */
const DEFAULT_MAX_INTENT_ENTRIES = 10_000;

// ─── AR MENOR-1: `TIMEOUT_COMPOSE_MS` **NO** es una cota de ejecución ─────
//
// La iteración anterior de este bloque (y el work-item, y `.env.example`) afirmaba
// que «un run no puede sobrevivir a su propio timeout» y derivaba de ahí el piso
// del knob. ES FALSO, verificado archivo por archivo:
//
//   · `src/middleware/timeout.ts:12-20` sólo MANDA el 504. No hay
//     `AbortController`, no hay `signal`, no se cancela nada: el pipeline sigue
//     corriendo después de que el caller recibió el timeout.
//   · `src/services/compose.ts` invoca al agente con `ssrfFetch(...)` SIN `signal`
//     y `src/lib/ssrf-dispatcher.ts` construye el `Agent` de undici sin
//     `headersTimeout`/`bodyTimeout` → el único freno son los defaults de undici
//     (300 s cada uno), y `bodyTimeout` es un timeout de INACTIVIDAD: un agente
//     que trickle-feedea un byte cada 299 s mantiene el hop vivo indefinidamente.
//
// ⚠️ ACTUALIZACIÓN HU-195 (sólo el segundo bullet): el hop de invoke YA tiene
// techo. `lib/ssrf-dispatcher.ts` configura `headersTimeout`/`bodyTimeout` y
// `ssrfFetch` adjunta un `AbortSignal` de wall-clock, ambos gobernados por
// `OUTBOUND_HOP_TIMEOUT_MS` (default 60 s, clampeado a `TIMEOUT_COMPOSE_MS`) —
// ver `lib/outbound-timeout.ts`. El trickle-feed infinito está cerrado.
// Lo que NO cambió, y por eso la conclusión de abajo SIGUE EN PIE: el techo es
// por HOP, no por PIPELINE. El 504 sigue sin cancelar el run, así que tampoco hay
// ahora una cota dura de wall-clock por run. Los números de este módulo se
// dejan a propósito en el peor caso VIEJO (300 s/hop): sobre-estiman la vida de
// un run, y sobre-estimar el TTL de un Map de idempotencia es el lado seguro del
// error. Bajarlos a 60 s es una decisión de money-path con su propia HU.
//
// Conclusión honesta: **no existe cota superior dura** de wall-clock para un run,
// así que NINGÚN número de TTL puede prometer "no expira dentro de la ventana viva
// del run". Elegimos NO cancelar el pipeline en el 504 (opción B del AR): abortar
// un run en medio de un settle es exactamente el estado indeterminado
// broadcasteado-pero-no-confirmado del que este Map protege — el remedio sería
// peor que la enfermedad, y cancelar el money-path está fuera del scope de un
// fix-pack.
//
// Lo que sí se hace: el piso deja de venderse como GARANTÍA y pasa a derivarse de
// la cota más grande que podemos citar con números reales del repo, en vez de de
// una env que no gobierna la ejecución.

// AR it3 MENOR-2: `MAX_COMPOSE_STEPS` se importa del leaf compartido
// (`lib/compose-limits.ts`) en vez de duplicar el literal `5` que vive en el guard
// de `routes/compose.ts`. Subir el límite de la ruta ahora escala esta cota
// automáticamente (y rompe la batería de TTL de `intent-dedup.test.ts`, que
// conserva su propio literal como valor esperado independiente — la señal de
// "re-revisá el margen a mano" que antes no existía).
/**
 * Default de undici 8 por request (`headersTimeout` = `bodyTimeout` = 300_000 ms).
 * NUESTRO código no los configura (`lib/ssrf-dispatcher.ts`), así que es el único
 * freno del hop de invoke.
 */
const UNDICI_DEFAULT_HOP_TIMEOUT_MS = 300_000;
/**
 * COTA ESTIMADA de vida de un compose-run: `MAX_COMPOSE_STEPS` × 300 s = 25 min
 * con el máximo de steps de hoy (5).
 *
 * ⚠️ Es una ESTIMACIÓN, no una garantía. Cuenta UN hop por step (el invoke del
 * agente) y no cuenta los hops del settle (verify + settle del facilitator) ni el
 * caso del body trickle-feedeado, que no tiene techo. Se documenta así a propósito:
 * el número es incómodo (25 min contra los 3 min del timeout del compose) y
 * honesto, en vez de cómodo y falso.
 */
const ESTIMATED_MAX_RUN_WALL_CLOCK_MS =
  MAX_COMPOSE_STEPS * UNDICI_DEFAULT_HOP_TIMEOUT_MS;

/** Timeout de respuesta del compose (NO cota de ejecución — ver arriba). */
function resolveComposeTimeoutMs(): number {
  const raw = process.env.TIMEOUT_COMPOSE_MS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_COMPOSE_TIMEOUT_MS;
}

/**
 * VENTANA PROTEGIDA: una entrada más joven que esto NUNCA se desaloja por presión
 * del cap, porque podría pertenecer a un run todavía vivo.
 *
 * `max(cota estimada del run, TIMEOUT_COMPOSE_MS × 2)` = 25 min con los defaults.
 * El segundo término no es una cota (ver el bloque de AR MENOR-1) pero se conserva
 * por monotonía: un operador que sube el timeout del compose está DECLARANDO que
 * espera runs más largos, y la ventana lo acompaña.
 */
function resolveProtectedWindowMs(): number {
  return Math.max(
    ESTIMATED_MAX_RUN_WALL_CLOCK_MS,
    resolveComposeTimeoutMs() * TTL_MARGIN_OVER_RUN_BOUND,
  );
}

/**
 * TTL de una entrada de idempotencia.
 *
 * Default: `max(cota × 2, TIMEOUT_COMPOSE_MS × 10, 30 min)` = **50 min** con los
 * defaults (antes 30 min, que contra la cota real de 25 min era un margen de
 * ~1.2×, no de 10× — AR MENOR-1).
 *
 * Override `SOLANA_INTENT_DEDUP_TTL_MS`, **con piso = la ventana protegida**
 * (25 min con los defaults, antes 6 min): un TTL por debajo de la ventana
 * protegida es directamente incoherente — la entrada expiraría mientras el
 * desalojo todavía la considera intocable. NO es la garantía "no expira dentro de
 * un run vivo" (esa garantía no existe, ver arriba): es el piso más alto que
 * podemos justificar con números del repo.
 */
function resolveIntentTtlMs(): number {
  const floor = resolveProtectedWindowMs();
  const raw = process.env.SOLANA_INTENT_DEDUP_TTL_MS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isFinite(n) && n > 0) return Math.max(n, floor);
  return Math.max(
    ESTIMATED_MAX_RUN_WALL_CLOCK_MS * TTL_MARGIN_OVER_RUN_BOUND,
    resolveComposeTimeoutMs() * TTL_SAFETY_FACTOR,
    MIN_DEFAULT_TTL_MS,
  );
}

/** Cap SOFT de entradas (`SOLANA_INTENT_DEDUP_MAX_ENTRIES`, default 10.000). */
function resolveMaxIntentEntries(): number {
  const raw = process.env.SOLANA_INTENT_DEDUP_MAX_ENTRIES;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_INTENT_ENTRIES;
}

/**
 * Warn del cap saturado con TODAS las entradas protegidas: una vez por EPISODIO
 * de breach, no una vez por proceso.
 *
 * AR MENOR-2: antes sólo se re-armaba en `_resetSolanaClients` (TEST-ONLY), así
 * que era warn-once-per-process — el mismo anti-patrón que este fix-pack ya
 * documentó para `FLAG_OFF` (auto-blindaje.md): breach a la hora 1, recuperación,
 * breach a la hora 20 → SILENCIO, y un warn que no vuelve a sonar no es señal
 * operativa. Ahora el flag se re-arma en cuanto el tamaño vuelve a bajar del cap,
 * así que cada episodio nuevo loguea exactamente una vez.
 */
let _warnedSoftCapBreached = false;

/**
 * Barrido LAZY (sin `setInterval`: no mantiene el event loop vivo ni introduce
 * flakiness en los tests). Se llama en cada `set`.
 *
 * 1. Borra lo EXPIRADO (edad > TTL).
 * 2. Si aún se supera el cap, desaloja de más viejo a más nuevo — pero NUNCA una
 *    entrada dentro de la VENTANA PROTEGIDA (`resolveProtectedWindowMs`), porque
 *    podría pertenecer a un run todavía vivo y borrarla habilitaría un doble pago.
 * 3. Si TODAS están protegidas, no se desaloja nada: el Map excede el cap a
 *    propósito y se emite un warn (señal operativa). Ante la duda, CONSERVAR.
 */
function evictIntentSignatures(now: number): void {
  const ttl = resolveIntentTtlMs();
  for (const [key, entry] of _intentSignatures) {
    if (now - entry.storedAt > ttl) _intentSignatures.delete(key);
  }

  const max = resolveMaxIntentEntries();
  if (_intentSignatures.size <= max) {
    _warnedSoftCapBreached = false; // re-armado (AR MENOR-2)
    return;
  }

  const protectedWindow = resolveProtectedWindowMs();
  // Insertion order = de más viejo a más nuevo, así que el primer candidato que
  // encontramos es el más viejo desalojable.
  for (const [key, entry] of _intentSignatures) {
    if (_intentSignatures.size <= max) break;
    if (now - entry.storedAt <= protectedWindow) break; // protegida ⇒ y las que
    // siguen son aún más jóvenes: no hay nada más que desalojar.
    _intentSignatures.delete(key);
  }

  if (_intentSignatures.size <= max) {
    _warnedSoftCapBreached = false; // el desalojo alcanzó: episodio cerrado
    return;
  }
  if (!_warnedSoftCapBreached) {
    _warnedSoftCapBreached = true;
    log.warn(
      { size: _intentSignatures.size, max, protectedWindowMs: protectedWindow },
      'solana intent dedup por encima del cap — todas las entradas están dentro de la ventana protegida; se CONSERVAN para no habilitar un doble pago (una vez por episodio: el warn se re-arma cuando el tamaño baja del cap)',
    );
  }
}

/** Alta de una firma en el seam de idempotencia (+ barrido lazy). */
function rememberIntentSignature(intentId: string, signature: string): void {
  const now = Date.now();
  _intentSignatures.set(intentId, { signature, storedAt: now });
  evictIntentSignatures(now);
}

/**
 * Lectura del seam. Una entrada EXPIRADA se trata como ausente (y se borra):
 * devolver una firma vencida sería peor que no tenerla.
 */
function recallIntentSignature(intentId: string): string | undefined {
  const entry = _intentSignatures.get(intentId);
  if (!entry) return undefined;
  if (Date.now() - entry.storedAt > resolveIntentTtlMs()) {
    _intentSignatures.delete(intentId);
    return undefined;
  }
  return entry.signature;
}

/**
 * WKH-235a (AC-1) — firma-candidata de una tx cuyo `sendAndConfirmTransaction`
 * lanzó. La firma de una tx Solana es la firma ed25519 del fee-payer sobre el
 * mensaje: existe ANTES de la confirmación, así que un timeout de confirmación
 * NO debe perderla.
 *
 * Dos fuentes, en orden:
 *  1. `err.signature` — `TransactionExpiredTimeoutError`,
 *     `TransactionExpiredBlockheightExceededError` y
 *     `TransactionExpiredNonceInvalidError` de `@solana/web3.js` exponen la
 *     firma base58 como campo público.
 *  2. `tx.signature` — `sendAndConfirmTransaction` firma el MISMO objeto
 *     `Transaction` in-place antes de broadcastear, así que el Buffer de la
 *     firma queda disponible incluso si el envío falló después.
 *
 * Devuelve `undefined` cuando la tx nunca llegó a firmarse (no hay nada que
 * verificar on-chain → el fallo es genuino).
 */
function candidateSignatureFromFailure(
  err: unknown,
  tx: Transaction,
): string | undefined {
  if (typeof err === 'object' && err !== null && 'signature' in err) {
    const fromErr = (err as { signature?: unknown }).signature;
    if (typeof fromErr === 'string' && fromErr.length > 0) return fromErr;
  }
  const raw = tx.signature;
  // Guard (fix-pack AR, MNR-3): un buffer de 64 bytes en CERO es el placeholder
  // que web3.js usa antes de firmar, NO una firma real. Su base58 ('1'×64) sería
  // una pseudo-firma no consultable on-chain que terminaría en `_intentSignatures`
  // y viajaría como `txHash` al ledger (`settle_signature`) → contabilidad
  // contaminada. Se trata igual que `tx.signature === null`: sin firma derivable.
  if (raw?.some((b) => b !== 0)) {
    return base58Encode(raw);
  }
  return undefined;
}

export class SolanaPaymentAdapter implements ISolanaPaymentAdapter {
  readonly vmFamily = 'solana' as const;
  readonly name = 'solana';
  readonly caip2ChainId: string = getSolanaCaip2();

  get supportedTokens(): SolanaTokenSpec[] {
    return [
      {
        symbol: USDC_SYMBOL,
        mint: getSolanaUsdcMint(),
        decimals: getSolanaUsdcDecimals(),
      },
    ];
  }

  getMint(): string {
    return getSolanaUsdcMint();
  }

  getScheme(): string {
    return SOLANA_SCHEME;
  }

  getNetwork(): string {
    return getSolanaCaip2();
  }

  getMaxTimeoutSeconds(): number {
    return SOLANA_MAX_TIMEOUT_SECONDS;
  }

  getMerchantName(): string {
    return process.env.WASIAI_MERCHANT_NAME ?? 'WasiAI';
  }

  /**
   * Balance SPL del operador para el mint configurado, en unidades atómicas
   * (string) — insumo del pre-flight de balance del leg Solana (CR-2 de
   * WKH-234, paridad con el `balanceOf` de la rama EVM).
   *
   * Lectura PURA del RPC (CD-7: cero imports de services/DB): deriva la ATA del
   * operador con `getAssociatedTokenAddressSync` (misma derivación que usa
   * `settle`, sin red) y consulta `getTokenAccountBalance`.
   *
   * LANZA cuando la lectura no se puede hacer. Dos causas indistinguibles a
   * este nivel: RPC caído y ATA del operador inexistente (`getTokenAccountBalance`
   * rechaza con "could not find account"). Por eso el caller degrada a "balance
   * desconocido" en vez de tratar el fallo como fondos insuficientes.
   */
  async getOperatorSplBalance(): Promise<string> {
    const connection = getSolanaConnection();
    const operator = getSolanaOperatorKeypair();
    const mint = new PublicKey(getSolanaUsdcMint());
    const ata = getAssociatedTokenAddressSync(mint, operator.publicKey);
    const res = await connection.getTokenAccountBalance(
      ata,
      getSolanaCommitment(),
    );
    return res.value.amount;
  }

  /**
   * Fix-pack AR-profundo FIX 2 — peek del seam de idempotencia (in-memory, sin
   * I/O, no lanza). El caller lo usa para NO cortar por fondos un intent que ya
   * fue settleado (un pago ya hecho no necesita fondos otra vez). NO valida la
   * firma: eso lo hace `settle()` (verify-before-trust) antes de reusarla.
   */
  getSettledSignature(intentId: string): string | undefined {
    return recallIntentSignature(intentId);
  }

  async quote(amountUsd: number): Promise<QuoteResult> {
    const decimals = getSolanaUsdcDecimals();
    // Fix-pack P1 (hallazgo 3): `toFixed(decimals)` no emite el decimal que el
    // double representa sino su EXPANSIÓN BINARIA, así que a > 6 decimales metía
    // un artefacto de float en el monto del challenge 402. `usdToAtomicUnits`
    // normaliza por la representación decimal más corta con round-trip y sigue
    // garantizando salida decimal plana (`parseUnits` LANZA con notación
    // científica, que era el motivo del `toFixed`). Para 6 dec (USDC) el
    // resultado es IDÉNTICO al camino anterior — verificado con 200k floats.
    const amountWei = usdToAtomicUnits(amountUsd, decimals);
    return {
      amountWei,
      token: {
        symbol: USDC_SYMBOL,
        // Sentinel: Solana no expone address 0x (ver getMint()).
        address: ZERO_EVM_ADDRESS,
        decimals,
      },
      facilitatorUrl: '',
    };
  }

  async settle(req: SolanaSettleRequest): Promise<SettleResult> {
    // ── Idempotencia (AC-7): si el intentId ya tiene firma confirmada, verify
    //    on-chain y retornar la firma previa — NO re-broadcast. ────────────────
    const prior = recallIntentSignature(req.intentId);
    if (prior) {
      // DECISIÓN ABIERTA (MNR-4 del CR de WKH-235a): este `verify()` NO está
      // envuelto en try/catch, a diferencia del de `recoverConfirmedSettle` (que
      // degrada a "no recuperado"). Con el RPC caído, un retry de un intentId ya
      // conocido lanza en vez de degradar. Hay que decidir si debe degradar igual
      // o propagar a propósito — ver doc/sdd/185-wkh-235a-solana-settle-idempotency-durable/work-item.md
      const verified = await this.verify({
        signature: prior,
        payTo: req.payTo,
        amountAtomic: req.amountAtomic,
      });
      if (verified.valid) {
        log.info(
          { intentId: req.intentId, signature: prior },
          'solana settle idempotent hit — returning prior signature',
        );
        return { txHash: prior, success: true };
      }
      // Firma previa no verifica → limpiar y re-emitir (self-heal).
      _intentSignatures.delete(req.intentId);
    }

    const connection = getSolanaConnection();
    const operator = getSolanaOperatorKeypair();
    const mint = new PublicKey(getSolanaUsdcMint());
    const payTo = new PublicKey(req.payTo);
    const amount = BigInt(req.amountAtomic);

    // ATAs del operator (source) y del agente payTo (destination).
    const fromAta = await getOrCreateAssociatedTokenAccount(
      connection,
      operator,
      mint,
      operator.publicKey,
    );
    const toAta = await getOrCreateAssociatedTokenAccount(
      connection,
      operator,
      mint,
      payTo,
    );

    const ix = createTransferInstruction(
      fromAta.address,
      toAta.address,
      operator.publicKey,
      amount,
    );
    const tx = new Transaction().add(ix);

    let signature: string;
    try {
      signature = await sendAndConfirmTransaction(connection, tx, [operator], {
        commitment: getSolanaCommitment(),
      });
    } catch (e) {
      // ── WKH-235a (AC-1/AC-2): timeout de confirmación ≠ pago no ocurrido.
      //    La firma existe antes de la confirmación → recuperarla y preguntarle
      //    a la cadena ANTES de declarar SETTLE_FAILED. La validación
      //    (monto/mint/destino) es la de `verify()` — NO se duplica acá.
      const recovered = await this.recoverConfirmedSettle(e, tx, req);
      if (recovered) return recovered;
      throw e;
    }

    // Persist-before-return del seam de idempotencia (W5 lo respalda en ledger).
    rememberIntentSignature(req.intentId, signature);
    log.info(
      { intentId: req.intentId, signature, payTo: req.payTo },
      'solana settle broadcast confirmed',
    );
    return { txHash: signature, success: true };
  }

  /**
   * WKH-235a (AC-1/AC-2) — self-heal del timeout de confirmación.
   *
   * Recupera la firma-candidata del fallo y le pregunta a la cadena vía el
   * `verify()` de esta misma clase (verify-before-trust: monto/mint/destino, sin
   * duplicar la validación). Si la tx SÍ está confirmada y es válida, el settle
   * fue exitoso: se registra la firma en el seam de idempotencia y se retorna
   * como éxito (el fee ya se pagó on-chain — perderlo es un bug de
   * contabilidad). Si no, devuelve `undefined` y el caller propaga el error
   * original (fallo genuino, camino de hoy sin regresión).
   *
   * NUNCA re-broadcastea y NUNCA lanza: un fallo del RPC de verificación se
   * degrada a "no recuperado" para no enmascarar el error original.
   */
  private async recoverConfirmedSettle(
    err: unknown,
    tx: Transaction,
    req: SolanaSettleRequest,
  ): Promise<SettleResult | undefined> {
    const candidate = candidateSignatureFromFailure(err, tx);
    if (!candidate) {
      log.warn(
        { intentId: req.intentId, detail: String(err) },
        'solana settle failed with no derivable signature — treating as failure',
      );
      return undefined;
    }

    let verified: VerifyResult;
    try {
      verified = await this.verify({
        signature: candidate,
        payTo: req.payTo,
        amountAtomic: req.amountAtomic,
      });
    } catch (verifyErr) {
      log.warn(
        {
          intentId: req.intentId,
          signature: candidate,
          detail: String(verifyErr),
        },
        'solana settle recovery: on-chain verify threw — treating as failure',
      );
      return undefined;
    }

    if (!verified.valid) {
      log.warn(
        {
          intentId: req.intentId,
          signature: candidate,
          reason: verified.error,
          detail: String(err),
        },
        'solana settle failed and candidate signature is not confirmed on-chain',
      );
      return undefined;
    }

    // Pago REAL confirmado a pesar del throw → mismo persist-before-return del
    // camino feliz (el intentId no queda sin firma asociada).
    rememberIntentSignature(req.intentId, candidate);
    log.warn(
      {
        intentId: req.intentId,
        signature: candidate,
        payTo: req.payTo,
        detail: String(err),
      },
      'solana settle confirmation failed but tx IS confirmed on-chain — recovered signature',
    );
    return { txHash: candidate, success: true };
  }

  async verify(proof: SolanaSettleProof): Promise<VerifyResult> {
    const connection = getSolanaConnection();
    const parsed = await connection.getParsedTransaction(proof.signature, {
      // Deliberadamente 'confirmed' (pre-existente WKH-234) y NO
      // `getSolanaCommitment()`. REVISAR antes de mainnet / dinero real: si se
      // configura `SOLANA_COMMITMENT=finalized`, un timeout a nivel finalized se
      // recuperaría (recoverConfirmedSettle) contra una lectura a nivel
      // confirmed, o sea con una garantía MÁS DÉBIL que la configurada.
      // Diferido en doc/sdd/185-.../work-item.md (MNR-2 del AR).
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (!parsed?.meta || parsed.meta.err) {
      return {
        valid: false,
        error: 'transaction not found or failed on-chain',
      };
    }

    const mint = getSolanaUsdcMint();
    const required = BigInt(proof.amountAtomic);

    // Delta de balance de token del owner=payTo para el mint esperado
    // (verify-before-trust). pre/postTokenBalances son la fuente canónica.
    const pre = parsed.meta.preTokenBalances ?? [];
    const post = parsed.meta.postTokenBalances ?? [];

    const balanceFor = (list: typeof post): bigint => {
      const entry = list.find(
        (b) => b.owner === proof.payTo && b.mint === mint,
      );
      return entry ? BigInt(entry.uiTokenAmount.amount) : 0n;
    };

    const delta = balanceFor(post) - balanceFor(pre);
    if (delta < required) {
      return {
        valid: false,
        error: `on-chain transfer ${delta} < required ${required} for ${proof.payTo}`,
      };
    }
    return { valid: true };
  }
}

/**
 * TEST-ONLY — limpia el seam de idempotencia in-memory (mirror
 * `_resetWalletClient`). El reset de Connection/operator vive en
 * `chain._resetSolanaChain`.
 */
export function _resetSolanaClients(): void {
  _intentSignatures.clear();
  _warnedSoftCapBreached = false;
}

/**
 * TEST-ONLY — tamaño actual del seam de idempotencia. Existe para poder assertear
 * el cap y el TTL del fix-pack P1 (hallazgo 5) sin exponer el Map.
 */
export function _intentDedupSize(): number {
  return _intentSignatures.size;
}

/**
 * TEST-ONLY — inserta una entrada con una antigüedad artificial, para ejercitar
 * expiración y desalojo sin depender de timers reales.
 */
export function _seedIntentSignature(
  intentId: string,
  signature: string,
  ageMs: number,
): void {
  _intentSignatures.set(intentId, {
    signature,
    storedAt: Date.now() - ageMs,
  });
}

/**
 * TEST-ONLY — política vigente del seam (AR MENOR-1). Se expone para poder
 * assertear la RELACIÓN entre el piso del knob y la cota estimada de vida de un
 * run sin re-derivar los números en el test (que fue justamente cómo el work-item
 * terminó afirmando una garantía que el código no da).
 */
export function _intentDedupPolicy(): {
  ttlMs: number;
  protectedWindowMs: number;
  maxEntries: number;
  estimatedMaxRunWallClockMs: number;
} {
  return {
    ttlMs: resolveIntentTtlMs(),
    protectedWindowMs: resolveProtectedWindowMs(),
    maxEntries: resolveMaxIntentEntries(),
    estimatedMaxRunWallClockMs: ESTIMATED_MAX_RUN_WALL_CLOCK_MS,
  };
}
