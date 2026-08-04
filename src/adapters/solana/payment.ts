import {
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';
import { type Connection, PublicKey, Transaction } from '@solana/web3.js';
import { usdToAtomicUnits } from '../../lib/atomic-amount.js';
import { getLogger } from '../../lib/logger.js';
// Transporta la disposición del valor ('unknown') cuando no se pudo determinar si
// un pago previo existe — así `downstream-payment.ts` reporta SETTLE_UNKNOWN en vez
// de afirmar que el leg no se pagó. Lo usan los DOS caminos: el del facilitator
// (WKH-302, códigos de payout) y el local (WKH-307/308, estado de la cadena).
import { FacilitatorSettleError } from '../errors.js';
import type {
  SolanaPaymentAdapter as ISolanaPaymentAdapter,
  QuoteResult,
  SettledPeek,
  SettlementPresence,
  SettleResult,
  SolanaSettleProof,
  SolanaSettleRequest,
  SolanaTermsVerdict,
  SolanaTokenSpec,
  VerifyResult,
} from '../types.js';
import { base58Encode } from './base58.js';
import {
  getSolanaCaip2,
  getSolanaCommitment,
  getSolanaConnection,
  getSolanaNetwork,
  getSolanaOperatorKeypair,
  getSolanaUsdcDecimals,
  getSolanaUsdcMint,
} from './chain.js';
// WKH-302 — camino nuevo (bandera ON): el facilitator firma y transmite.
import { payoutViaFacilitator } from './facilitator-settle.js';
// WKH-307: la idempotencia dejo de ser un Map de proceso y paso a una tabla. Todo el
// acceso a datos del adapter vive en `settle-ledger.ts` (CD-7).
import {
  _resetSolanaSchemaPreflight,
  BLOCKHASH_VALIDITY_SLOTS,
  ensureSolanaSchemaReady,
} from './schema-preflight.js';
import {
  claimSettleIntent,
  readSettleIntent,
  reclaimExpiredIntent,
  recordConfirmedIntent,
  recordSignedIntent,
} from './settle-ledger.js';

/**
 * Margen, EN BLOQUES, que se le suma a la cota de expiracion fabricada para el camino
 * del facilitator. Cubre que el nodo que le contesta al gateway vaya ATRASADO respecto
 * del que atendio al facilitator.
 *
 * ⚠️ Subirlo es seguro (se espera de mas). BAJARLO PUEDE COSTAR UN DOBLE PAGO.
 * El razonamiento completo esta en `fabricateExpiryUpperBound`.
 */
const FACILITATOR_HEIGHT_SKEW_MARGIN_SLOTS = 150;

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

// ── Idempotencia (WKH-307) ────────────────────────────────────────────────
//
// El registro de "a que intentId ya se le pago y con que firma" VIVIA ACA, en un Map
// de proceso con TTL, cap y ventana protegida. Se fue entero: un restart lo borraba y
// despues de ese restart el sistema no sabia si ya le habia pagado a un agente.
//
// Ahora vive en `a2a_solana_settle_intents` y se toca por `settle-ledger.ts`. Nada de
// lo que se borro debe volver: sin TTL, sin cap, sin ventana protegida, sin reloj
// inyectable. El unico reloj que gobierna algo es el de Postgres, adentro del lease.

/** Cuantas veces se re-firma ante una colision de firma antes de rendirse (AC-9). */
const DEFAULT_SIGN_MAX_ATTEMPTS = 3;

/**
 * Tope de re-firmas por colision del indice UNIQUE de firma. La colision ocurre ANTES
 * del broadcast, asi que reintentar no puede pagar de mas; el tope existe para no
 * girar para siempre si algo mas anda mal.
 */
/** Texto de un error desconocido, sin asumir que sea `Error`. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resolveSignMaxAttempts(): number {
  const raw = process.env.SOLANA_SETTLE_SIGN_MAX_ATTEMPTS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SIGN_MAX_ATTEMPTS;
}

/**
 * WKH-235a (AC-1) — firma-candidata de una tx cuyo BROADCAST o CONFIRMACIÓN
 * lanzó. La firma de una tx Solana es la firma ed25519 del fee-payer sobre el
 * mensaje: existe ANTES de la confirmación, así que un timeout de confirmación
 * NO debe perderla.
 *
 * WKH-307: desde que la firma se PERSISTE antes de transmitir (invariante I2), esta
 * recuperación dejó de ser la única red — la fila ya quedó en `signed` con la firma
 * correcta, así que aunque el proceso muera acá el próximo retry la re-verifica. Se
 * conserva porque resuelve el caso EN CALIENTE sin esperar a ese retry.
 *
 * Dos fuentes, en orden:
 *  1. `err.signature` — `TransactionExpiredTimeoutError`,
 *     `TransactionExpiredBlockheightExceededError` y
 *     `TransactionExpiredNonceInvalidError` de `@solana/web3.js` exponen la
 *     firma base58 como campo público.
 *  2. `tx.signature` — el adapter firma el objeto `Transaction` ANTES de
 *     transmitirlo, así que el Buffer de la firma queda disponible incluso si el
 *     envío o la confirmación fallaron después.
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
  // una pseudo-firma no consultable on-chain que se persistiria como
  // `settle_signature` y viajaria como `txHash` al ledger → contabilidad
  // contaminada. Se trata igual que `tx.signature === null`: sin firma derivable.
  if (raw?.some((b) => b !== 0)) {
    return base58Encode(raw);
  }
  return undefined;
}

// ── WKH-319 · primitivos del guard de TERMINOS ────────────────────────────
//
// Transcritos (no importados) de `src/adapters/solana/deposit-verifier.ts`, que
// resuelve el bug GEMELO del lado ENTRADA (WKH-315).
//
// ⚠️ ESE ARCHIVO NO EXISTE EN ESTA RAMA (CR MNR-F): vive en la rama de WKH-315, sin
// mergear. NO confundirlo con `src/adapters/deposit-verifier.ts` —sin `solana/`—,
// que es el del rail EVM y no tiene ninguno de estos cuatro primitivos.
//
// Importar crearia ademas una dependencia `payment.ts → deposit-verifier.ts` al
// REVES de la que 315 diseño (315 lee de `payment.ts`, no al contrario), justo
// mientras esa HU esta en vuelo. La convergencia tiene dueño: cuando WKH-314
// promueva `presence.ts`, estos cuatro primitivos viven ahi una sola vez (TD-319-2).

/**
 * La forma MINIMA de una entrada de `pre/postTokenBalances` que hace falta para
 * MEDIR. `accountIndex` y `mint` son OBLIGATORIOS en el esquema de `@solana/web3.js`;
 * `owner` es `optional(string())`, por eso viaja como `unknown` y se lee con
 * `declaredOwner`.
 */
type TokenBalanceLike = {
  accountIndex: number;
  mint: string;
  owner?: unknown;
  uiTokenAmount: { amount: string };
};

/**
 * ⚠️ NO reemplazar por `try { BigInt(x) } catch {}`. Para esta familia de strings el
 * `catch` NI SIQUIERA SE EJECUTA: `BigInt('')` es `0n`, `BigInt('   ')` es `0n` y
 * `BigInt('0x10')` es `16n`. Un saldo previo ilegible leido como cero es exactamente
 * el fail-open que esta HU cierra, con otro disfraz.
 */
const ATOMIC_AMOUNT_RE = /^[0-9]+$/;

/**
 * Valida el CONTENIDO, no solo el contenedor. `preTokenBalances: [null]` tira
 * `TypeError` en el primer `b.mint` (medido en WKH-315): o se cierran todas las
 * formas, o la promesa "NUNCA lanza" de `probeSettlementPresence` es falsa.
 */
function isBalanceEntry(b: unknown): b is TokenBalanceLike {
  if (typeof b !== 'object' || b === null) return false;
  const e = b as {
    accountIndex?: unknown;
    mint?: unknown;
    uiTokenAmount?: unknown;
  };
  if (typeof e.accountIndex !== 'number' || !Number.isInteger(e.accountIndex)) {
    return false;
  }
  if (typeof e.mint !== 'string') return false;
  if (typeof e.uiTokenAmount !== 'object' || e.uiTokenAmount === null) {
    return false;
  }
  return typeof (e.uiTokenAmount as { amount?: unknown }).amount === 'string';
}

/** Copia la lista entera o `null` si CUALQUIER entrada no se puede leer. */
function readBalanceList(list: unknown[]): TokenBalanceLike[] | null {
  const out: TokenBalanceLike[] = [];
  for (const b of list) {
    if (!isBalanceEntry(b)) return null;
    out.push(b);
  }
  return out;
}

/** `null` significa "no pude medir", NUNCA cero. */
function atomicOf(b: TokenBalanceLike): bigint | null {
  const raw = b.uiTokenAmount.amount;
  return ATOMIC_AMOUNT_RE.test(raw) ? BigInt(raw) : null;
}

/**
 * El `owner` DECLARADO, o `null` si la entrada no lo trae. Leer un `owner` ausente
 * como "es de otro" es una AFIRMACION SOBRE UN DATO AUSENTE, y sub-mide el delta ⇒
 * `landed_mismatch` sobre un pago real. Por eso devuelve `null` y el caller decide.
 *
 * ⚠️ EL `length > 0` NO ES COSMETICO — ES LA CLAUSULA QUE SOSTIENE EL FIX DE BLQ-1
 * (re-AR MNR-1). Decide POR QUE PUERTA cae un `owner: ''`, y las dos puertas tienen
 * consecuencias opuestas:
 *
 *   · con el guard  → `null` ⟹ la entrada se cuenta como NO CLASIFICABLE ⟹ si esta
 *     en `pre`, BLOQUEA el `match`;
 *   · sin el guard  → `''` ⟹ `'' !== payTo` ⟹ la entrada se DESCARTA EN SILENCIO:
 *     no suma, no se cuenta, y ademas queda INVISIBLE para el guard de simetria del
 *     Paso 5, que solo recorre las claves de los dos mapas.
 *
 * O sea que borrar cuatro tokens de esta linea REABRE la sexta forma del fail-open
 * entera. Se midio: el mutante COMPILA y sobrevivia la suite de 4333 tests.
 * Clavado por `T-319-7c` (caso `owner: ''`) y por el mutante **M25**.
 */
function declaredOwner(b: TokenBalanceLike): string | null {
  return typeof b.owner === 'string' && b.owner.length > 0 ? b.owner : null;
}

/**
 * WKH-319 (CR MNR-D) — el mensaje operativo correcto para una presencia `unknown`.
 *
 * La rama `unknown` se documentó como *"la cadena no se pudo consultar"*, que era
 * cierto cuando su única causa era el RPC. Ahora también llegan causas donde **la
 * cadena contestó perfecto** y lo que falló fue INTERPRETARLA (`terms_*`), e incluso
 * una donde el dato malo es NUESTRO (`terms_required_unreadable` valida
 * `proof.amountAtomic`, que sale del ledger). Las dos clases se destraban distinto:
 *
 *   · RPC mudo            → transitorio, el próximo retry contra otro nodo lo resuelve;
 *   · `terms_*`           → **DETERMINÍSTICO**: el mismo nodo va a volver a fallar
 *     igual, y reintentar para siempre bajo un mensaje de "transitorio" esconde el
 *     problema. Necesita cambiar de endpoint o mirada humana (runbook).
 *
 * Publicar la segunda con el texto de la primera manda al operador a esperar algo
 * que no va a pasar solo.
 */
function unresolvedTermsMessage(
  detail: string,
  transientMessage: string,
): string {
  return detail.startsWith('terms_')
    ? `${transientMessage} — ⚠️ NOTE: the chain DID answer; what failed was interpreting it (${detail.split(':')[0]}). This does NOT clear up by itself: same input, same result. See doc/sdd/209-wkh-307-solana-durable-idempotency-ledger/runbook-destrabe.md`
    : transientMessage;
}

/**
 * Lamports de `pre/postBalances` en un indice, o `null` si no se puede leer (lista
 * ausente, no-array, indice fuera de rango, valor no numerico).
 *
 * ⚠️ `null` NO es `0`. Es la unica distincion que separa "la ATA se creo en esta
 * misma tx" (0 lamports: la cuenta no existia) de "la lista llego truncada" — y
 * tratarlas igual es el fail-open.
 */
function lamportsAt(list: unknown, index: number): number | null {
  if (!Array.isArray(list)) return null;
  const v: unknown = list[index];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
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
   * PEEK del seam de idempotencia. El caller lo usa para NO cortar por fondos un
   * intent que ya fue settleado (un pago ya hecho no necesita fondos otra vez).
   *
   * WKH-307: pasa a ASINCRONO (lee la tabla, no un Map) y a UNION DISCRIMINADA. El
   * retorno anterior (`string | undefined`) colapsaba *"no se pago"* con *"no se si
   * se pago"*, que en un camino de dinero son OPUESTOS: el primero autoriza cortar
   * por fondos, el segundo obliga a fail-closear.
   *
   * NUNCA lanza (contrato preservado): un fallo del store se traduce a `unknown`.
   * NO valida la firma ni autoriza nada: `settle()` sigue siendo la unica autoridad.
   */
  async getSettledSignature(intentId: string): Promise<SettledPeek> {
    const read = await readSettleIntent(intentId);
    switch (read.state) {
      case 'confirmed':
        return { state: 'settled', signature: read.signature };
      // `signed` y `claimed` son lo mismo para el caller: alguien lo reclamo y
      // todavia no esta confirmado.
      case 'signed':
      case 'claimed':
        return { state: 'in_progress' };
      case 'none':
        return { state: 'none' };
      default:
        return { state: 'unknown' };
    }
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

  /**
   * WKH-307 — el orden es el contrato.
   *
   *   preflight de esquema → RECLAMO ATOMICO → (solo si se gano) firmar →
   *   PERSISTIR la firma → transmitir → confirmar → marcar confirmado
   *
   * El reclamo es la PRIMERA operacion con la DB o la red, antes de resolver
   * conexion, operador o ATAs: nada que cueste plata ocurre antes de haber ganado el
   * derecho a hacerlo.
   */
  async settle(req: SolanaSettleRequest): Promise<SettleResult> {
    // ── Paso 0: el esquema. Un gate que nadie corre no es un gate (AC-11).
    const schema = await ensureSolanaSchemaReady();
    if (!schema.ok) {
      log.error(
        {
          intentId: req.intentId,
          failure: schema.failure,
          detail: schema.detail,
        },
        'solana settle refused — settle ledger schema preflight failed; without the durable ledger the gateway cannot know whether this agent was already paid',
      );
      throw new Error(
        `SETTLE_LEDGER_SCHEMA_UNAVAILABLE: ${schema.failure} — ${schema.detail}`,
      );
    }

    // ── Paso 1-2: EL RECLAMO. Unica puerta al broadcast.
    const claim = await claimSettleIntent({
      intentId: req.intentId,
      caip2: getSolanaCaip2(),
      payTo: req.payTo,
      amountAtomic: req.amountAtomic,
      mint: getSolanaUsdcMint(),
    });

    // ── WKH-302 — bandera de transicion. UNA SOLA LECTURA por invocacion, a una
    //    const local: si se leyera dos veces, un cambio de env a mitad de request
    //    podria partir el flujo entre los dos caminos (AC-3). Comparacion literal
    //    contra 'true'; `Boolean(process.env.X)` daria true para CUALQUIER string
    //    no vacio, incluido 'false'.
    //
    //    Va DESPUES del reclamo y nunca antes (CD-14 de WKH-307): el reclamo es
    //    funcion de la INTENCION, no de quien transmite, asi que cambiar el
    //    transporte no puede invalidarlo. Bajarla a una rama rompe esa invariante.
    const viaFacilitator = process.env.SOLANA_SETTLE_VIA_FACILITATOR === 'true';

    switch (claim.outcome) {
      case 'claimed':
        // Ganamos el derecho a transmitir. Es el UNICO caso que sigue.
        return await this.dispatchPayment(req, viaFacilitator);

      case 'in_progress':
        // Otro request en vuelo que todavia no firmo. "No se todavia" nunca paga.
        log.warn(
          { intentId: req.intentId },
          'solana settle refused — another request holds a live claim for this intent and has not signed yet',
        );
        throw new Error(`SETTLE_IN_PROGRESS: ${req.intentId}`);

      case 'terms_conflict':
        // El intent existe con OTROS terminos: no es este pago. Y no se devuelve la
        // firma previa — seria pagarle a A y decirle a B que cobro (AC-8).
        // AR MNR-1: la salida manual esta en
        // `doc/sdd/209-wkh-307-solana-durable-idempotency-ledger/runbook-destrabe.md`
        // (seccion C). Casi siempre es el llamador reusando un intentId, no el ledger.
        throw new Error(
          `SETTLE_INTENT_CONFLICT: ${req.intentId} already exists with different terms (status=${String(claim.status)}) — see runbook-destrabe.md §C`,
        );

      case 'store_unavailable':
        throw new Error(`SETTLE_LEDGER_UNAVAILABLE: ${claim.detail}`);

      case 'confirmed':
        return await this.settleAlreadyConfirmed(claim.signature, req);

      default:
        return await this.settleAlreadySigned(
          claim.signature,
          claim.lastValidBlockHeight,
          req,
          viaFacilitator,
        );
    }
  }

  /**
   * Rama `confirmed`: el pago ya se hizo. Se RE-VERIFICA on-chain antes de devolver la
   * firma (verify-before-trust, CD-5) — la tabla dice que se pago, la cadena lo prueba.
   */
  private async settleAlreadyConfirmed(
    signature: string,
    req: SolanaSettleRequest,
  ): Promise<SettleResult> {
    const presence = await this.probeSettlementPresence({
      signature,
      payTo: req.payTo,
      amountAtomic: req.amountAtomic,
    });

    if (presence.state === 'landed_ok') {
      log.info(
        { intentId: req.intentId, signature },
        'solana settle idempotent hit — returning the prior signature, nothing broadcast',
      );
      return { txHash: signature, success: true };
    }

    // AR BLQ-MEDIO-1: "no pude preguntar" NO es "no verifica". Antes los dos
    // terminaban en el rechazo PERMANENTE de abajo, o sea que un hipo del RPC
    // condenaba un intent sano a intervencion humana. Ahora es un error TRANSITORIO
    // y el proximo retry vuelve a preguntar.
    if (presence.state === 'unknown') {
      log.warn(
        { intentId: req.intentId, signature, detail: presence.detail },
        unresolvedTermsMessage(
          presence.detail,
          'solana settle deferred — the ledger says this intent was confirmed but the chain could not be queried; NOT re-broadcasting and NOT condemning the row',
        ),
      );
      // ⚠️ `FacilitatorSettleError(..., 'unknown')` y NO un `Error` pelado (AR BLQ-2).
      // `settleSolanaLeg` clasifica el throw con `readSettleValueDisposition`, y un
      // error sin disposicion cae en `SETTLE_FAILED` — que DISPARA REEMBOLSO Y/O
      // RE-ENVIO DEL HOP. O sea: el adapter diria "no pude comprobarlo" y el leg le
      // afirmaria al caller "no se pago". Es el mismo colapso que esta HU cierra un
      // piso mas abajo, y seria absurdo dejarlo vivo un piso mas arriba.
      throw new FacilitatorSettleError(
        `SETTLE_PRESENCE_UNKNOWN: ${req.intentId} (${presence.detail})`,
        'unknown',
      );
    }

    // ⚠️ CAMBIO DE CONDUCTA DELIBERADO (R-3). El seam in-memory borraba la entrada y
    // RE-EMITIA (self-heal). Con un store durable esto NO se arregla pagando de nuevo.
    //
    // TRES causas posibles, y la tercera es la que importa para el destrabe (AR MNR-1):
    //   1. contabilidad corrupta (la fila no corresponde a esa firma);
    //   2. un RPC devolviendo datos que no son los de la cadena;
    //   3. **un FORK**: la fila llego a `confirmed` tras un `confirmTransaction` a
    //      commitment `confirmed`, que es OPTIMISTA — una tx confirmada asi puede
    //      caerse si su bloque queda fuera de la cadena canonica. En ESE caso el pago
    //      genuinamente NO ocurrio y el agente quedo sin cobrar.
    //
    // La asimetria se mantiene a proposito (no cobrar es recuperable, cobrar dos veces
    // no), pero el caso 3 necesita SALIDA MANUAL, no quedar clavado para siempre:
    // el procedimiento de destrabe esta en
    // `doc/sdd/209-wkh-307-solana-durable-idempotency-ledger/runbook-destrabe.md`.
    const detail =
      presence.state === 'absent'
        ? 'the signature is not on chain (node searched its history)'
        : presence.detail;
    log.error(
      {
        intentId: req.intentId,
        signature,
        presence: presence.state,
        detail,
        runbook:
          'doc/sdd/209-wkh-307-solana-durable-idempotency-ledger/runbook-destrabe.md',
      },
      'solana settle REFUSED — the ledger says this intent was confirmed but the chain does not back that up. NOT re-broadcasting: corrupt accounting, a lying RPC and a forked-out optimistic confirmation all look the same from here, and paying again only fixes the third. See the runbook to unstick.',
    );
    throw new Error(
      `SETTLE_CONFIRMED_BUT_UNVERIFIABLE: ${req.intentId} (${presence.state}: ${detail})`,
    );
  }

  /**
   * Rama `signed`: hay firma persistida, o sea que el broadcast PUDO haber salido.
   *
   * ⚠️ AR BLQ-MEDIO-1 — LO QUE HACE SEGURA A LA SALIDA (b). Re-transmitir exige DOS
   * hechos, y los dos tienen que ser PRUEBAS:
   *
   *   1. el blockhash murio (`getBlockHeight() > last_valid_block_height`) — prueba
   *      de que ESA tx ya no puede aterrizar;
   *   2. la tx NO esta en la cadena — y esto **antes se infería de un `null`**, que
   *      tambien puede significar "el nodo no tiene ese historico" o "va atrasado".
   *      Un nodo del pool sin el bloque indexado alcanzaba para concluir "expiro sin
   *      aterrizar" sobre una tx YA PAGADA ⟹ segundo SPL transfer real.
   *
   * Ahora (2) sale de `probeSettlementPresence`, que sólo devuelve `absent` cuando el
   * nodo RESPONDIO habiendo buscado en su historico. Todo lo demas fail-closea.
   */
  private async settleAlreadySigned(
    signature: string,
    lastValidBlockHeight: string | null,
    req: SolanaSettleRequest,
    viaFacilitator: boolean,
  ): Promise<SettleResult> {
    const presence = await this.probeSettlementPresence({
      signature,
      payTo: req.payTo,
      amountAtomic: req.amountAtomic,
    });

    if (presence.state === 'landed_ok') {
      // (a) El pago aterrizo. Marcarlo confirmado es contabilidad, no autorizacion.
      const confirmed = await recordConfirmedIntent({
        intentId: req.intentId,
        signature,
      });
      if (!confirmed.ok) {
        log.error(
          { intentId: req.intentId, signature, reason: confirmed.reason },
          'solana settle: the transfer IS confirmed on-chain but the ledger row could not be marked confirmed — accounting drift, not a payment problem',
        );
      }
      log.info(
        { intentId: req.intentId, signature },
        'solana settle recovered — the signed transaction had already landed on-chain; nothing broadcast',
      );
      return { txHash: signature, success: true };
    }

    // "No pude preguntar" NUNCA autoriza re-transmitir.
    if (presence.state === 'unknown') {
      log.warn(
        { intentId: req.intentId, signature, detail: presence.detail },
        unresolvedTermsMessage(
          presence.detail,
          'solana settle refused — could not determine whether the signed transaction landed; refusing to re-broadcast on an unanswered question',
        ),
      );
      // Idem `settleAlreadyConfirmed` (AR BLQ-2): la incognita tiene que VIAJAR con
      // su disposicion o el leg la publica como "no se pago".
      throw new FacilitatorSettleError(
        `SETTLE_IN_FLIGHT_UNRESOLVED: ${req.intentId} (presence unknown: ${presence.detail})`,
        'unknown',
      );
    }

    // Algo aterrizo con esa firma pero con OTROS terminos: re-pagar seria pagar dos
    // veces por cosas distintas. Fail-closed.
    if (presence.state === 'landed_mismatch') {
      log.error(
        { intentId: req.intentId, signature, detail: presence.detail },
        'solana settle refused — a transaction with this signature IS on chain but does not match the intent terms',
      );
      throw new Error(
        `SETTLE_SIGNED_TERMS_MISMATCH: ${req.intentId} (${presence.detail})`,
      );
    }

    // ⛔ LISTA BLANCA, NO COLA POR DESCARTE (WKH-319, AC-15 / CR MNR-A).
    //
    // Acá abajo se RE-TRANSMITE, y en Solana no hay backstop on-chain: un segundo
    // transfer es plata perdida sin vuelta. Antes esta rama era la cola de una
    // cadena de `if`, o sea que asumía "llegados acá la presencia es `absent` o
    // `landed_failed`". Esa afirmación era CORRECTA HOY y NO VERIFICADA POR EL
    // COMPILADOR: cualquier estado que se agregue a `SettlementPresence` y que
    // alguien olvide sumar a la cadena caía justo acá, en la rama que vuelve a
    // pagar, en silencio.
    //
    // Sólo estos dos PRUEBAN que la transferencia no ocurrió. Con los 5 estados de
    // hoy este throw es inalcanzable: existe para que el sexto falle CERRADO.
    // El `as string` es DELIBERADO y no es pereza de tipos: en este punto TypeScript
    // ya redujo `presence` a `never` —lo cual es, literalmente, la prueba de que hoy
    // el guard es inalcanzable— y sin ensanchar no habria forma de escribir la
    // comprobacion para un estado que TODAVIA NO EXISTE. Ese es el punto del guard.
    const observed = presence.state as string;
    if (observed !== 'absent' && observed !== 'landed_failed') {
      throw new FacilitatorSettleError(
        `SETTLE_PRESENCE_UNHANDLED: ${req.intentId} (${observed}) — refusing to re-broadcast on a presence state this branch does not know how to prove did not happen`,
        'unknown',
      );
    }

    // Las DOS exigen ademas la PRUEBA DE EXPIRACION antes de re-firmar.
    //
    // ⚠️ AR re-review MNR-2 — `landed_failed` ESTABA EXCEPTUADO de este chequeo, con el
    // razonamiento de que una tx grabada con error es terminal y su firma no puede
    // volver a ejecutarse. Es cierto en el caso normal, pero deja una ventana: un
    // re-org que saque de la cadena canonica el bloque de esa tx fallida MIENTRAS su
    // blockhash sigue vivo la vuelve re-ejecutable — y esta vez puede tener exito (si
    // fallo por estado de cuenta) sobre un intent que ya re-pago. Dos transferencias
    // coexistiendo.
    //
    // Exigir la expiracion cuesta, a lo sumo, la espera del blockhash en un camino
    // raro. Elimina la unica ventana donde eso podia pasar.
    if (lastValidBlockHeight === null) {
      // ⚠️ CUARTA PUERTA DEL MISMO PASILLO. El nombre del marcador lo dice
      // (`_UNRESOLVED`) y el mensaje también: **falta la prueba** de que la tx
      // previa ya no pueda aterrizar. Eso es "no pude preguntar", no "no pasó".
      //
      // El `presence` de acá es `absent` o `landed_failed`, y ninguno de los dos
      // CIERRA la pregunta por sí solo: la lógica de las tres líneas de abajo es
      // exactamente que hace falta ADEMÁS la prueba de expiración, porque un
      // `absent` con blockhash vivo puede aterrizar todavía y un `landed_failed`
      // puede re-ejecutarse tras un re-org (ver el bloque de AR MNR-2 arriba).
      // Sin `last_valid_block_height` esa segunda prueba no existe, así que la
      // conclusión que queda es "no sé", no "no se pagó".
      //
      // Con `Error` pelado el leg lo publicaba como `SETTLE_FAILED` = «no se pagó»
      // y habilitaba reembolso/re-envío sobre una transferencia que puede estar
      // viva. Es el mismo colapso que los otros tres sitios de este archivo.
      throw new FacilitatorSettleError(
        `SETTLE_SIGNED_UNRESOLVED: ${req.intentId} (presence=${presence.state}) has no last_valid_block_height to prove the previous transaction can no longer land`,
        'unknown',
      );
    }
    const connection = getSolanaConnection();
    const height = await connection.getBlockHeight(getSolanaCommitment());
    // BigInt y no Number(): la altura viaja como string a proposito (CD-8).
    if (BigInt(height) <= BigInt(lastValidBlockHeight)) {
      // (c) Sigue viva: podria aterrizar (o re-ejecutarse tras un re-org). No paga.
      log.warn(
        {
          intentId: req.intentId,
          signature,
          presence: presence.state,
          blockHeight: String(height),
          lastValidBlockHeight,
        },
        'solana settle refused — the previously signed transaction is not settled but its blockhash is STILL VALID; it could confirm (or be re-executed after a re-org) at any moment',
      );
      // ⚠️ TERCER SITIO del mismo marcador, y el que AR BLQ-2 (WKH-319) NO tocó:
      // ese fix cubrió los dos throws de la rama `presence.state === 'unknown'`
      // (`settleAlreadyConfirmed` y `settleAlreadySigned`) y este quedó `Error`
      // pelado. `readSettleValueDisposition` devuelve `undefined` para un `Error`
      // sin `valueDisposition`, y `settleSolanaLeg` traduce ese `undefined` a
      // `SETTLE_FAILED` — el código que, en el vocabulario público, afirma "no se
      // pagó" (`downstream-skip-code.ts`).
      //
      // Acá esa afirmación es FALSA por construcción: el mensaje de arriba dice que
      // la tx firmada PUEDE aterrizar todavía (su blockhash sigue vivo). O sea que
      // el adapter mide "no puedo descartarlo" y el leg publicaba "no ocurrió".
      // `'unknown'` es lo que el leg necesita leer para publicar `SETTLE_UNKNOWN`.
      //
      // NO es una sobre-corrección hacia "todo es unknown": las salidas de este
      // mismo método que sí PRUEBAN un veredicto siguen siendo `Error` pelado y
      // siguen mapeando a `SETTLE_FAILED` (`SETTLE_SIGNED_TERMS_MISMATCH`, arriba).
      throw new FacilitatorSettleError(
        `SETTLE_IN_FLIGHT_UNRESOLVED: ${req.intentId}`,
        'unknown',
      );
    }

    // (b) LAS DOS PRUEBAS en la mano. Se archiva la firma vieja y se re-firma.
    const reclaimed = await reclaimExpiredIntent({
      intentId: req.intentId,
      signature,
    });
    if (!reclaimed.ok) {
      throw new Error(
        `SETTLE_RECLAIM_REFUSED: ${req.intentId} (${reclaimed.reason} — ${reclaimed.detail})`,
      );
    }
    log.warn(
      {
        intentId: req.intentId,
        expiredSignature: signature,
        presence: presence.state,
      },
      'solana settle: the previously signed transaction will never land (absent + blockhash expired, or landed with an on-chain error) — archived and re-signing',
    );
    return await this.dispatchPayment(req, viaFacilitator);
  }

  /**
   * AR BLQ-MEDIO-1 — ¿esta esta firma en la cadena, y en que estado?
   *
   * Es la unica fuente admitida para una determinacion NEGATIVA, porque es la unica
   * que puede distinguir "el nodo busco y no la tiene" de "no pude preguntar":
   * `getSignatureStatuses(..., { searchTransactionHistory: true })` obliga al nodo a
   * mirar tambien el almacenamiento de largo plazo, y devuelve `null` en la posicion
   * de la firma SOLO tras haber buscado.
   *
   * ⚠️ NO se usa `getParsedTransaction` para decidir ausencia: su `null` mezcla
   * "no existe" con "este nodo no lo tiene indexado / va atrasado". Esa lectura sigue
   * usandose, pero solo para validar los TERMINOS de una tx que ya sabemos presente.
   *
   * NUNCA lanza: todo fallo se traduce a `unknown`.
   *
   * ⚠️ Y AHORA ESO ES ESTRUCTURAL, NO ARGUMENTADO (WKH-319, AR MNR-C). La promesa
   * estaba sostenida por los `try` alrededor de las DOS llamadas de red, pero el
   * cuerpo tenia accesos encadenados FUERA de todo `try` (`statuses.value`,
   * `status.err`, `parsed.meta.err`, los `JSON.stringify` sobre errores on-chain, y
   * hasta `getSolanaConnection()`). Ninguno es producible por un payload JSON-RPC
   * valido, pero "NUNCA" es una promesa absoluta y los callers la usan como tal:
   * quien la lea no deberia tener que auditar el cuerpo para saber si es cierta.
   * El envoltorio de abajo la hace verdadera por construccion.
   */
  private async probeSettlementPresence(
    proof: SolanaSettleProof,
  ): Promise<SettlementPresence> {
    try {
      return await this.probeSettlementPresenceInner(proof);
    } catch (err) {
      // Distinto de `terms_threw`: aquel es un fallo de la VALIDACION de terminos,
      // este es cualquier otra cosa del cuerpo del probe. Se distinguen en el log a
      // proposito (CD-8).
      return { state: 'unknown', detail: `probe_threw: ${errText(err)}` };
    }
  }

  private async probeSettlementPresenceInner(
    proof: SolanaSettleProof,
  ): Promise<SettlementPresence> {
    const connection = getSolanaConnection();
    let statuses: Awaited<
      ReturnType<typeof connection.getSignatureStatuses>
    > | null = null;
    try {
      statuses = await connection.getSignatureStatuses([proof.signature], {
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
      return {
        state: 'unknown',
        detail: 'getSignatureStatuses returned empty',
      };
    }
    const status = statuses.value[0];
    // `null` DESPUES de haber buscado el historico = prueba de ausencia.
    if (status === null || status === undefined) return { state: 'absent' };
    if (status.err) {
      return { state: 'landed_failed', detail: JSON.stringify(status.err) };
    }

    // Presente y sin error: recien ahora se validan los TERMINOS.
    //
    // ⚠️ AR re-review MNR-3 — ACA VIVIA `this.verify()`, Y COLAPSABA DOS COSAS. Su
    // `VerifyResult` devuelve `{valid:false}` tanto cuando los terminos no coinciden
    // como cuando NO SE PUDO LEER la transaccion. Con eso, un nodo que conoce la firma
    // pero no la tiene indexada producia `landed_mismatch`, o sea un log afirmando
    // "esta en la cadena pero con OTROS terminos" —falso— y, sobre una fila
    // `confirmed`, la CONDENA PERMANENTE por una causa transitoria.
    //
    // La distincion de tres valores que esta funcion introdujo en la capa de PRESENCIA
    // hacia falta tambien un piso mas arriba, en la de TERMINOS.
    let parsed: Awaited<ReturnType<typeof connection.getParsedTransaction>>;
    try {
      parsed = await connection.getParsedTransaction(proof.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
    } catch (err) {
      return { state: 'unknown', detail: errText(err) };
    }
    if (!parsed?.meta) {
      // El status dice que ESTA, pero este nodo no la tiene parseada. No se puede
      // afirmar nada sobre los terminos: eso es "no se", no "no coinciden".
      return {
        state: 'unknown',
        detail:
          'signature status reports the transaction as present, but this node has no parsed transaction for it (lagging or unindexed)',
      };
    }
    if (parsed.meta.err) {
      return {
        state: 'landed_failed',
        detail: JSON.stringify(parsed.meta.err),
      };
    }
    // WKH-319 — el `try` externo es CINTURON Y TIRANTES (CD-6). Los guards internos
    // de `checkTerms` hacen que esto no ocurra, pero la promesa "NUNCA lanza" del
    // docstring de arriba tiene que ser ESTRUCTURALMENTE cierta, no argumentada: un
    // guard que se sostiene sobre su propio razonamiento no es un guard.
    let terms: SolanaTermsVerdict;
    try {
      terms = this.checkTerms(parsed, proof);
    } catch (err) {
      return { state: 'unknown', detail: `terms_threw: ${errText(err)}` };
    }
    switch (terms.verdict) {
      case 'match':
        return { state: 'landed_ok' };
      case 'mismatch':
        return { state: 'landed_mismatch', detail: terms.detail };
      case 'indeterminate':
        // "No pude medir los terminos" es un caso de `unknown`, NO de
        // `landed_mismatch`: NO condena la fila y NO autoriza re-transmitir.
        // Deliberadamente NO se agrega un sexto estado a `SettlementPresence`
        // (CD-13): los consumidores discriminan con cadenas de `if` y caen por
        // descarte a la cola que RE-TRANSMITE, asi que un estado nuevo que alguien
        // no agregue a esa cadena cae en la rama que paga de nuevo, en silencio.
        return { state: 'unknown', detail: terms.detail };
    }
  }

  /**
   * La bifurcacion por transporte, en UN solo lugar.
   *
   * ⚠️ Existe como metodo (y no inline en `settle`) porque hay DOS puntos que
   * transmiten: la rama `claimed` y la cola de `settleAlreadySigned`, que re-firma
   * despues de probar que la firma vieja ya no puede aterrizar. Si la bandera solo
   * se respetara en el primero, un intent con la bandera ON que llegue por el
   * segundo firmaria con la LLAVE LOCAL — justo lo que CD-15 prohibe.
   */
  private async dispatchPayment(
    req: SolanaSettleRequest,
    viaFacilitator: boolean,
  ): Promise<SettleResult> {
    return viaFacilitator
      ? await this.settleViaFacilitator(req)
      : await this.signPersistBroadcast(req);
  }

  /**
   * Cota SUPERIOR de la altura en que expira el blockhash que uso el facilitator.
   *
   * ⚠️ ES CONSERVADORA A PROPOSITO. NO la "ajustes" para que sea exacta: el error
   * en cada direccion NO cuesta lo mismo.
   *
   *   · pasarse de largo  ⟹ un intent espera de mas antes de poder re-firmarse.
   *     Se destraba solo, con el tiempo. Molesto.
   *   · quedarse corto    ⟹ `settleAlreadySigned` cree que la tx vieja ya no puede
   *     aterrizar cuando TODAVIA puede, re-firma, y aterrizan las dos. SEGUNDO PAGO
   *     REAL. Irreversible.
   *
   * Por que una cota fabricada es legitima, y no un numero inventado: la altura de
   * la cadena solo SUBE. El facilitator pidio su blockhash en algun instante
   * POSTERIOR a que saliera nuestro POST y ANTERIOR a que llegara su respuesta. Por
   * lo tanto la altura medida AL RECIBIR la respuesta ya es >= la altura que el
   * facilitator vio, y `medida + validez` es >= su expiracion real.
   *
   * El margen extra cubre que el nodo que nos contesta vaya ATRASADO respecto del
   * que atendio al facilitator — el unico caso en que la cota podria quedar corta.
   * Medido sobre el pool publico de devnet (2026-07-29, 64 muestras): dispersion
   * entre nodos de 0 bloques, y el desfasaje estructural `confirmed`↔`finalized` de
   * 31-32 bloques. 150 bloques (~1 min) deja ~5x sobre ese piso estructural.
   *
   * ⚠️ Esa medicion es un PISO, no un techo: no se pudo medir un nodo degradado, y
   * el endpoint del facilitator todavia no existe. El margen esta elegido para el
   * caso que NO se pudo medir, no para el que si.
   *
   * Ganancia sobre pedirle la altura al facilitator: los dos lados de la
   * comparacion final salen del MISMO proveedor RPC, asi que el desfasaje entre
   * nodos se cancela en vez de sumarse.
   */
  private async fabricateExpiryUpperBound(intentId: string): Promise<string> {
    const connection = getSolanaConnection();
    let height: number;
    try {
      height = await connection.getBlockHeight(getSolanaCommitment());
    } catch (err) {
      // El pago YA OCURRIO (2xx del facilitator) pero no podemos anotar una cota
      // honesta, y sin cota la fila no se puede escribir. NO es `SETTLE_FAILED`:
      // afirmar que no se pago dispararia reembolso sobre un pago real.
      throw new FacilitatorSettleError(
        `SETTLE_SIGNED_UNRECORDED: ${intentId} — the facilitator paid but the expiry upper bound could not be measured (${errText(err)})`,
        'unknown',
      );
    }
    return String(
      BigInt(height) +
        BigInt(BLOCKHASH_VALIDITY_SLOTS) +
        BigInt(FACILITATOR_HEIGHT_SKEW_MARGIN_SLOTS),
    );
  }

  /**
   * Camino nuevo (bandera ON): el facilitator firma y transmite. El gateway NO
   * firma NADA, ni siquiera como fallback — un facilitator caido es un leg no
   * liquidado, no una excusa para volver a ser camino de dinero (CD-15).
   *
   * ⚠️⚠️ VENTANA ABIERTA — ACA FALTA UN MARCADOR DURABLE, Y ESTE ES EL PUNTO EXACTO.
   *
   * La invariante I2 de WKH-307 dice que una fila `claimed` SIN firma demuestra que
   * nunca se transmitio nada. Con el facilitator firmando eso YA NO ES CIERTO: el
   * gateway se entera de la firma DESPUES del broadcast. Entre el POST de abajo y el
   * `recordSignedIntent` que le sigue, la fila dice `claimed` mientras puede haber un
   * pago real en vuelo.
   *
   * Si el gateway se cae en esa ventana, el reintento se salva SOLO porque la bandera
   * sigue encendida (el facilitator dedupea por `intentId` y responde
   * `alreadySettled`). Si la bandera se APAGO en el medio — un rollback durante un
   * incidente, que es exactamente cuando pasa — el reintento ve `claimed`, toma el
   * camino local y firma de nuevo: SEGUNDO PAGO REAL.
   *
   * Lo que falta es un estado `dispatched` escrito ANTES del POST, junto con la cota.
   * Es un estado nuevo en la maquina, o sea migracion, y va junto con el hallazgo R-2
   * del adversarial (mismo instante, misma escritura, distinto proceso).
   *
   * ⛔ CONDICION PREVIA A ENCENDER `SOLANA_SETTLE_VIA_FACILITATOR`, no a mergear.
   *    La bandera se entrega APAGADA, asi que hoy la ventana no esta viva.
   *    Encenderla sin el marcador la activa.
   */
  private async settleViaFacilitator(
    req: SolanaSettleRequest,
  ): Promise<SettleResult> {
    // ⛔ Ver el bloque de arriba: el marcador `dispatched` va JUSTO ACA, antes del POST.
    const payout = await payoutViaFacilitator({
      intentId: req.intentId,
      payTo: req.payTo,
      amountAtomic: req.amountAtomic,
      network: `solana:${getSolanaNetwork()}`,
    });

    const lastValidBlockHeight = await this.fabricateExpiryUpperBound(
      req.intentId,
    );
    const signed = await recordSignedIntent({
      intentId: req.intentId,
      signature: payout.signature,
      lastValidBlockHeight,
    });
    if (!signed.ok) {
      // Mismo razonamiento que arriba: el pago ocurrio, la contabilidad no cerro.
      throw new FacilitatorSettleError(
        `SETTLE_SIGNED_UNRECORDED: ${req.intentId} (${signed.reason} — ${signed.detail})`,
        'unknown',
      );
    }

    // ⚠️ NO se salta a `confirmed` con el 2xx como unica evidencia (verify-before-trust,
    // CD-5 de WKH-307). Un 2xx es lo que nos CONTARON; `confirmed` es un estado del que
    // no se vuelve — si despues la cadena dijera `absent`, `settleAlreadyConfirmed`
    // condena la fila para siempre. Se confirma solo con la cadena mirada.
    const presence = await this.probeSettlementPresence({
      signature: payout.signature,
      payTo: req.payTo,
      amountAtomic: req.amountAtomic,
    });
    if (presence.state === 'landed_ok') {
      const confirmed = await recordConfirmedIntent({
        intentId: req.intentId,
        signature: payout.signature,
      });
      if (!confirmed.ok) {
        log.error(
          { intentId: req.intentId, reason: confirmed.reason },
          'solana settle via facilitator: paid and verified on-chain but the ledger row could not be marked confirmed — accounting drift, not a payment problem',
        );
      }
    } else {
      // La fila queda en `signed` CON la cota: un retry posterior la reconcilia por
      // `settleAlreadySigned`, que es el camino recuperable. No es un error.
      log.warn(
        {
          intentId: req.intentId,
          presence: presence.state,
          alreadySettled: payout.alreadySettled,
        },
        'solana settle via facilitator: the facilitator reported success but the chain does not confirm it yet; leaving the row in `signed` so a later retry reconciles it',
      );
    }

    log.info(
      {
        intentId: req.intentId,
        signature: payout.signature,
        alreadySettled: payout.alreadySettled,
      },
      'solana settle via facilitator',
    );
    // `alreadySettled: true` es un EXITO, no un error: es un pago que ya ocurrio.
    return { txHash: payout.signature, success: true };
  }

  /**
   * Pasos 4-8: construir, firmar, **PERSISTIR**, transmitir, confirmar.
   *
   * ⚠️ EL ORDEN ES LA INVARIANTE I2 Y NO SE PUEDE REORDENAR: la firma se persiste
   * ANTES del broadcast, y por eso una fila `claimed` (sin firma) DEMUESTRA que nunca
   * se transmitio nada. Si `recordSignedIntent` no aplica, la transaccion firmada se
   * DESCARTA sin tocar la red.
   *
   * Se firma explicito y se transmite crudo — NO `sendAndConfirmTransaction`. Ese
   * helper sobrescribe el blockhash y VUELVE A FIRMAR adentro, asi que es imposible
   * conocer la firma antes de transmitir, que es justo lo que I2 necesita.
   */
  private async signPersistBroadcast(
    req: SolanaSettleRequest,
  ): Promise<SettleResult> {
    const connection = getSolanaConnection();
    const operator = getSolanaOperatorKeypair();
    const mint = new PublicKey(getSolanaUsdcMint());
    const payTo = new PublicKey(req.payTo);
    const amount = BigInt(req.amountAtomic);
    const commitment = getSolanaCommitment();

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

    const maxAttempts = resolveSignMaxAttempts();
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const ix = createTransferInstruction(
        fromAta.address,
        toAta.address,
        operator.publicKey,
        amount,
      );
      const tx = new Transaction().add(ix);

      const latest = await connection.getLatestBlockhash(commitment);
      tx.feePayer = operator.publicKey;
      tx.recentBlockhash = latest.blockhash;
      tx.lastValidBlockHeight = latest.lastValidBlockHeight;
      tx.sign(operator);

      const raw = tx.signature;
      if (!raw) {
        throw new Error(
          `SETTLE_SIGN_FAILED: ${req.intentId} produced no signature`,
        );
      }
      const signature = base58Encode(raw);

      // ── PERSIST-BEFORE-BROADCAST. Nada de lo de abajo corre si esto no aplica.
      const persisted = await recordSignedIntent({
        intentId: req.intentId,
        signature,
        lastValidBlockHeight: String(latest.lastValidBlockHeight),
      });
      if (!persisted.ok) {
        if (persisted.reason === 'signature_collision') {
          // Otro intent ya persistio EXACTAMENTE esta firma: mismo mensaje bajo el
          // mismo blockhash. Como el choque ocurre antes del broadcast, todavia no
          // salio nada: se re-firma con blockhash fresco. Este es el bucle que
          // reemplaza al del SDK, y es mas fuerte (durable y cross-proceso).
          log.warn(
            { intentId: req.intentId, attempt },
            'solana settle: signature collision — re-signing with a fresh blockhash (nothing was broadcast)',
          );
          continue;
        }
        throw new Error(
          `SETTLE_LEDGER_WRITE_REFUSED: ${persisted.reason} — ${persisted.detail}`,
        );
      }

      // ── EL UNICO EFECTO IRREVERSIBLE ──
      try {
        await connection.sendRawTransaction(tx.serialize(), {
          preflightCommitment: commitment,
        });
        await connection.confirmTransaction(
          {
            signature,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
          },
          commitment,
        );
      } catch (e) {
        // Timeout de confirmacion != pago no ocurrido. Ahora ademas la firma YA esta
        // persistida, asi que aunque este proceso muera la fila queda en `signed` y
        // el proximo retry le pregunta a la cadena en vez de adivinar.
        const recovered = await this.recoverConfirmedSettle(e, tx, req);
        if (recovered) return recovered;
        throw e;
      }

      const confirmed = await recordConfirmedIntent({
        intentId: req.intentId,
        signature,
      });
      if (!confirmed.ok) {
        // El pago OCURRIO. Perderlo seria un bug de contabilidad, no de dinero: la
        // fila queda en `signed` con la firma correcta y el retry converge.
        log.error(
          { intentId: req.intentId, signature, reason: confirmed.reason },
          'solana settle: transfer confirmed on-chain but the ledger row could not be marked confirmed — accounting drift, the payment is fine',
        );
      }
      log.info(
        { intentId: req.intentId, signature },
        'solana settle broadcast confirmed',
      );
      return { txHash: signature, success: true };
    }

    // Agotados los intentos: fail-closed. NUNCA se transmitio nada en este camino.
    throw new Error(
      `SETTLE_SIGNATURE_COLLISION_EXHAUSTED: ${req.intentId} after ${maxAttempts} signing attempts`,
    );
  }

  /**
   * WKH-235a (AC-1/AC-2) — self-heal del timeout de confirmación,
   * **acotado por WKH-308 a los tres estados de la cadena**.
   *
   * Recupera la firma-candidata del fallo y le pregunta a la cadena vía
   * `probeSettlementPresence` (NO vía `verify()`: ése colapsa *aterrizó-y-falló* /
   * *no está* / *este nodo no la tiene indexada* en un solo `valid:false`, y sobre esa
   * mezcla se escribía un falso negativo en el ledger).
   *
   * Las tres salidas, que son el contrato de esta función:
   *
   *   · `landed_ok`                  ⟹ el pago SÍ ocurrió: se marca confirmado y se
   *     retorna éxito (el fee ya salió on-chain — perderlo es un bug de contabilidad);
   *   · `absent` / `landed_failed`   ⟹ está PROBADO que la transferencia no ocurrió:
   *     devuelve `undefined` y el caller propaga el error original (fallo genuino,
   *     sin regresión respecto del camino histórico);
   *   · `unknown`                    ⟹ **LANZA** `FacilitatorSettleError` con
   *     `valueDisposition:'unknown'`. No se afirma que el leg no se pagó, porque no lo
   *     sabemos; la incertidumbre viaja hasta el leg, que la publica como
   *     `SETTLE_UNKNOWN`.
   *
   * ⚠️ Decía *"NUNCA lanza"*. **Ya no es cierto** y el cambio es el punto de WKH-308:
   * degradar el "no pude comprobarlo" a "no recuperado" era exactamente lo que
   * enmascaraba el pago real. Lo que **sigue siendo cierto** es que NUNCA
   * re-broadcastea: ninguna de las tres ramas re-transmite.
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

    // ⚠️ WKH-308 — ACA VIVIA `this.verify()`, Y COLAPSABA TRES SITUACIONES EN UNA.
    //
    // `verify()` devuelve `{valid:false}` tanto cuando la tx aterrizo y FALLO, como
    // cuando NO esta, como cuando **este nodo no la tiene indexada**. Las dos primeras
    // prueban que el pago no ocurrio; la tercera no prueba nada.
    //
    // El daño no era plata: era CONTABILIDAD. Un settle que SI se pago se reportaba
    // como no settleado, no se escribia el recibo del leg y la fila quedaba en `signed`
    // — o sea que la reconciliacion leia "no se pago" sobre un pago hecho. Ese dato
    // falso es el insumo de un job futuro que trate la fila como pendiente, y ahi si
    // aparece el doble pago, meses despues del error.
    //
    // `probeSettlementPresence` es la misma fuente de tres estados que usa el resto del
    // adapter desde WKH-307; aca solo se la reusa.
    const presence = await this.probeSettlementPresence({
      signature: candidate,
      payTo: req.payTo,
      amountAtomic: req.amountAtomic,
    });

    if (presence.state === 'unknown') {
      // NO PUDIMOS COMPROBARLO. No se afirma que el leg no se pago: se transporta la
      // incertidumbre con `valueDisposition:'unknown'`, que es EXACTAMENTE el mecanismo
      // que el leg EVM ya usa (`readSettleValueDisposition`) y que el caller ya recibe
      // hoy como `SETTLE_UNKNOWN`. No es vocabulario nuevo: es dejar de mentir donde el
      // otro riel ya dice la verdad.
      log.warn(
        {
          intentId: req.intentId,
          signature: candidate,
          detail: presence.detail,
          // FP-2: el SINTOMA que disparó todo. Esta rama LANZA un error nuevo, asi que
          // el `throw e` del caller nunca corre y el original no viaja solo. Y es
          // justamente la rama que le dice al operador "andá a reconciliar contra la
          // cadena": mandarlo sin saber si fue un timeout de confirmacion o otra cosa
          // lo deja empezando de cero. La rama de fallo genuino ya lo loguea.
          originalError: String(err),
        },
        'solana settle recovery: could NOT determine whether the broadcast transaction landed — reporting the leg as UNKNOWN, not as failed (asserting "not paid" here would write a false negative into the ledger)',
      );
      throw new FacilitatorSettleError(
        `solana settle presence unknown for ${req.intentId} (${presence.detail})`,
        'unknown',
      );
    }

    // `absent` y `landed_failed` PRUEBAN que la transferencia no ocurrio ⟹ fallo
    // genuino, y el caller propaga el error original.
    //
    // `landed_mismatch` CONSERVA la conducta previa (tambien fallo genuino), y la razon
    // va aca y no en otro archivo: significa que una tx con ESA firma esta on-chain,
    // sin error, pero el delta hacia `payTo` no cubre `amountAtomic`. En este flujo la
    // tx la construimos nosotros por el monto exacto, asi que llegar aca implica que la
    // cadena contradice lo que creemos haber firmado — no es "no se pago" ni "no se":
    // es una contradiccion que ningun reintento automatico arregla.
    //
    // Se deja como fallo (y NO como `unknown`) a proposito: `unknown` significa "puede
    // que se haya pagado, no reintentes y reconcilia", y aca SI sabemos que lo que
    // aterrizo no es el pago que pedimos. Si alguna vez dispara en produccion, merece
    // mirada humana antes que una regla nueva.
    const verified: VerifyResult =
      presence.state === 'landed_ok'
        ? { valid: true }
        : { valid: false, error: `presence=${presence.state}` };

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

    // Pago REAL confirmado a pesar del throw. La firma YA estaba persistida (I2), asi
    // que aca solo se marca confirmado: es contabilidad, no autorizacion. Si falla, el
    // pago sigue siendo valido y la fila queda en `signed` con la firma correcta.
    const confirmed = await recordConfirmedIntent({
      intentId: req.intentId,
      signature: candidate,
    });
    if (!confirmed.ok) {
      log.error(
        {
          intentId: req.intentId,
          signature: candidate,
          reason: confirmed.reason,
        },
        'solana settle recovery: transfer IS confirmed on-chain but the ledger row could not be marked confirmed — accounting drift, the payment is fine',
      );
    }
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

  /**
   * Valida los TERMINOS (monto/mint/destino) sobre una tx YA PARSEADA. Puro, sin red.
   *
   * Se extrajo de `verify()` (AR re-review MNR-3) para que `probeSettlementPresence`
   * pueda reusar la validacion SIN heredar el colapso de dos valores de
   * `VerifyResult`: alli hace falta distinguir "no pude leer la tx" de "los terminos
   * no coinciden", y `verify()` devuelve `{valid:false}` para las dos.
   *
   * ⚠️ WKH-319 — ESTA FUNCION NO FALLABA ABIERTO POR NO VERIFICAR: FALLABA ABIERTO
   * POR VERIFICAR OTRA COSA. Con `preTokenBalances` ausente, un `?? []` fabricaba la
   * lista, el saldo previo daba `0n`, y `delta` dejaba de ser un delta para pasar a
   * ser el SALDO ABSOLUTO de `payTo`. La comprobacion degeneraba de *"esta tx
   * transfirio >= required a payTo"* a *"payTo tiene >= required"*: una tx AJENA en la
   * que `payTo` GASTA 100 USDC y no recibe nada devolvia `ok:true`.
   *
   * ORDEN DE LOS GUARDS = PARTE DEL CONTRATO (CD-12). Cada paso solo puede devolver
   * `indeterminate` o seguir; `mismatch` es SIEMPRE el ultimo y exige que todo lo
   * anterior haya salido bien. El delta negativo se chequea ANTES del `< required`
   * para no quedar tapado por el.
   *
   * NUNCA lanza para ninguna entrada admitida por el esquema de `@solana/web3.js`.
   */
  private checkTerms(
    parsed: NonNullable<
      Awaited<ReturnType<Connection['getParsedTransaction']>>
    >,
    proof: SolanaSettleProof,
  ): SolanaTermsVerdict {
    const meta = parsed.meta;
    if (!meta) {
      // Inalcanzable desde los dos call-sites (los dos guardan `!parsed?.meta`
      // antes), pero sin meta no hay NADA que medir: eso es indeterminacion, no
      // una negativa.
      return {
        verdict: 'indeterminate',
        detail: 'terms_meta_absent: the parsed transaction carries no meta',
      };
    }
    const mint = getSolanaUsdcMint();
    // `BigInt('')` es `0n` y `BigInt('1.0')` LANZA: el monto requerido pasa por el
    // mismo tamiz que los saldos. Un requerido ilegible no es "requerido cero".
    if (!ATOMIC_AMOUNT_RE.test(proof.amountAtomic)) {
      return {
        verdict: 'indeterminate',
        detail: `terms_required_unreadable: ${JSON.stringify(proof.amountAtomic)} is not a base-10 atomic amount`,
      };
    }
    const required = BigInt(proof.amountAtomic);

    // ── Paso 1 — PRESENCIA de las listas ────────────────────────────────
    // Una lista AUSENTE y una lista VACIA son dos indeterminaciones distintas, y
    // NINGUNA de las dos es un dato. Aca vivian los dos `?? []` (CD-3): no vuelven
    // en ninguna forma (`|| []`, `Array.isArray(x) ? x : []`, un default de
    // parametro). El `??` fabricaba justo el dato que el guard iba a mirar.
    const preRaw: unknown = meta.preTokenBalances;
    const postRaw: unknown = meta.postTokenBalances;
    if (!Array.isArray(preRaw) || !Array.isArray(postRaw)) {
      return {
        verdict: 'indeterminate',
        detail: `terms_list_absent: pre=${Array.isArray(preRaw)} post=${Array.isArray(postRaw)} — an absent balance list is not an empty one`,
      };
    }

    // ── Paso 2 — FORMA de las entradas ──────────────────────────────────
    const pre = readBalanceList(preRaw);
    const post = readBalanceList(postRaw);
    if (pre === null || post === null) {
      return {
        verdict: 'indeterminate',
        detail: `terms_entry_shape: unreadable balance entries (pre_ok=${pre !== null} post_ok=${post !== null}) — an entry that cannot be read is not an entry worth zero`,
      };
    }

    // ── Pasos 3 y 4 — el CONJUNTO RECEPTOR, agregado por `accountIndex` ──
    // ⚠️ Aca vivia un `.find()` que tomaba LA PRIMERA entrada de `payTo` en cada
    // lista, sin exigir que fueran la MISMA cuenta: con dos token accounts del
    // mismo owner+mint, los dos `find` podian resolver a cuentas distintas y el
    // delta salia de restar peras con manzanas. No se lo reemplaza por "fijar el
    // accountIndex del post", sino por AGREGACION sobre todas las cuentas nuestras
    // emparejadas por indice: mide el hecho economico que el recibo afirma —*las
    // tenencias del mint de payTo subieron >= required*— y NO importa ningun
    // supuesto sobre que cuenta concreta elige el facilitator (§4.6 del SDD).
    const preOurs = new Map<number, bigint>();
    const postOurs = new Map<number, bigint>();
    // Entradas de NUESTRO mint que no se pueden atribuir por falta de `owner`.
    // No son nuestras, pero tampoco se puede afirmar que no lo sean.
    //
    // ⚠️ SE CUENTAN POR LADO, Y NO ES UN DETALLE (AR BLQ-1). Una entrada sin
    // clasificar no entra a ninguno de los dos mapas, asi que ademas de no sumar es
    // INVISIBLE para el guard de simetria del Paso 5 — y el efecto de esa ceguera
    // es OPUESTO segun el lado:
    //
    //   · en `post`  no medirla achica `postSum` ⟹ achica el delta ⟹ solo puede
    //     sub-medir. La afirmacion POSITIVA sigue siendo solida;
    //   · en `pre`   no medirla achica `preSum` ⟹ **AGRANDA** el delta ⟹ puede
    //     volver verdadero un `>=` que era falso. **Es la mecanica exacta del
    //     `?? []` original, con otro disfraz.**
    //
    // Repro que lo probo: `payTo` con una entrada anonima que BAJA de 100 USDC a 0
    // y una nuestra que sube 0 → 3, con required 3000000, daba `match` — o sea
    // `landed_ok` sobre una tx donde las tenencias de payTo se DERRUMBARON. La
    // misma forma con el `owner` declarado da `terms_negative_delta`: omitir
    // `owner` era lo unico que hacia falta para convertir un caso cazado en un
    // pago certificado.
    let unclassifiablePre = 0;
    let unclassifiablePost = 0;
    for (const [list, ours, side] of [
      [pre, preOurs, 'pre'],
      [post, postOurs, 'post'],
    ] as const) {
      for (const b of list) {
        if (b.mint !== mint) continue;
        const owner = declaredOwner(b);
        if (owner === null) {
          if (side === 'pre') unclassifiablePre += 1;
          else unclassifiablePost += 1;
          continue;
        }
        if (owner !== proof.payTo) continue;
        const amount = atomicOf(b);
        if (amount === null) {
          return {
            verdict: 'indeterminate',
            detail: `terms_amount_unreadable: ${side}[${b.accountIndex}] amount ${JSON.stringify(b.uiTokenAmount.amount)} is not a base-10 atomic amount`,
          };
        }
        if (ours.has(b.accountIndex)) {
          return {
            verdict: 'indeterminate',
            detail: `terms_duplicate_index: ${side} lists accountIndex ${b.accountIndex} twice for the same mint`,
          };
        }
        ours.set(b.accountIndex, amount);
      }
    }

    // ── Paso 5 — COMPLETITUD del conjunto receptor, simetrica ────────────
    // `pre/postBalances` se leen SOLO ante una asimetria: una tx simetrica (el caso
    // normal) no los toca, asi que no se agrega indeterminacion gratuita.
    let preSum = 0n;
    let postSum = 0n;
    for (const index of new Set([...preOurs.keys(), ...postOurs.keys()])) {
      const before = preOurs.get(index);
      const after = postOurs.get(index);
      if (before !== undefined) {
        preSum += before;
      } else {
        // Presente en `post`, ausente en `pre`. Dos causas con consecuencias
        // OPUESTAS: la ATA se creo en esta misma tx (saldo previo genuinamente 0),
        // o la lista llego truncada (tomarlo como 0 FABRICA el dato).
        //
        // ⚠️ LO QUE EL DISCRIMINADOR PRUEBA Y LO QUE NO (AR MNR-B). La implicacion
        // vale en UNA sola direccion: `0 lamports` PRUEBA que la cuenta no existia
        // —una cuenta de token es rent-exempt, asi que existir implica > 0—, pero
        // `> 0 lamports` NO prueba que existiera COMO CUENTA DE TOKEN: una
        // direccion puede tener lamports sin ser todavia una cuenta de token (ATA
        // pre-fondeada; el programa ATA soporta crearla sobre una direccion con
        // saldo, transfiriendo solo la diferencia).
        //
        // O sea que este guard tiene un tercer caso, y cae del lado CERRADO: un
        // pago REAL a una ATA pre-fondeada sale `indeterminate`. No cuesta plata,
        // pero NO se destraba solo — el mismo payload da el mismo resultado
        // siempre. Si aparece en produccion, se distingue en el log por
        // `terms_pre_row_missing` y se resuelve con el tier de direccion (W2.1),
        // que identifica la cuenta sin depender de los lamports.
        if (lamportsAt(meta.preBalances, index) !== 0) {
          return {
            verdict: 'indeterminate',
            detail: `terms_pre_row_missing: accountIndex ${index} is in post but not in pre, and preBalances[${index}] does not prove the account did not exist`,
          };
        }
      }
      if (after !== undefined) {
        postSum += after;
      } else {
        // La regla espejo NO es estetica: sin ella, dropear una fila nuestra del
        // lado `post` hace que el delta se vea MAS CHICO y produce un
        // `landed_mismatch` FALSO sobre un pago real — el mismo error, al reves.
        if (lamportsAt(meta.postBalances, index) !== 0) {
          return {
            verdict: 'indeterminate',
            detail: `terms_post_row_missing: accountIndex ${index} is in pre but not in post, and postBalances[${index}] does not prove the account was closed`,
          };
        }
      }
    }

    // ── Paso 6 — el VEREDICTO ───────────────────────────────────────────
    const delta = postSum - preSum;
    if (delta < 0n) {
      // Para una tx que construimos nosotros esto es FISICAMENTE IMPOSIBLE: el
      // destino no gasta. Si el numero da negativo, lo que aprendimos es que los
      // datos no son coherentes — NO que la plata haya ido a otro lado. Devolver
      // `mismatch` aca condena la fila para siempre
      // (SETTLE_CONFIRMED_BUT_UNVERIFIABLE) por una causa que nunca se midio.
      return {
        verdict: 'indeterminate',
        detail: `terms_negative_delta: ${delta} for ${proof.payTo} — a receiving account cannot spend`,
      };
    }
    const unclassifiableDetail = (why: string): SolanaTermsVerdict => ({
      verdict: 'indeterminate',
      detail: `terms_unclassifiable_entry: ${unclassifiablePre} pre / ${unclassifiablePost} post balance entries of the expected mint carry no owner — ${why} (measured delta ${delta}, required ${required})`,
    });
    if (delta >= required) {
      // La afirmacion positiva EXIGE que el lado `pre` este completo. Una entrada
      // anonima ahi solo puede haber INFLADO este delta (AR BLQ-1).
      if (unclassifiablePre > 0) {
        return unclassifiableDetail(
          'an unattributed pre entry can only have INFLATED this delta',
        );
      }
      return { verdict: 'match', creditedAtomic: delta.toString() };
    }
    // La NEGATIVA exige los DOS lados completos, y el de `pre` tambien — aunque una
    // entrada anonima ahi no pueda romper el `< required` por si sola. Razon: si esa
    // entrada fuera nuestra, el delta VERDADERO seria mas chico que el medido y
    // podria ser NEGATIVO, o sea justo lo que el guard de delta negativo existe para
    // no condenar. Sin esta rama, una entrada sin `owner` en `pre` alcanza para
    // saltearse ese guard y producir SETTLE_CONFIRMED_BUT_UNVERIFIABLE —condena
    // permanente— sobre datos incoherentes.
    if (unclassifiablePre > 0 || unclassifiablePost > 0) {
      return unclassifiableDetail(
        unclassifiablePost > 0
          ? 'an unattributed post entry could only ADD to the side we did not measure'
          : 'an unattributed pre entry means the true delta could be negative',
      );
    }
    return {
      verdict: 'mismatch',
      detail: `on-chain transfer ${delta} < required ${required} for ${proof.payTo}`,
    };
  }

  async verify(proof: SolanaSettleProof): Promise<VerifyResult> {
    const connection = getSolanaConnection();
    const parsed = await connection.getParsedTransaction(proof.signature, {
      // Deliberadamente 'confirmed' (pre-existente WKH-234) y NO
      // `getSolanaCommitment()`. REVISAR antes de mainnet / dinero real: si se
      // configura `SOLANA_COMMITMENT=finalized`, un timeout a nivel finalized se
      // recuperaria (recoverConfirmedSettle) contra una lectura a nivel
      // confirmed, o sea con una garantia MAS DEBIL que la configurada.
      // Diferido en doc/sdd/185-.../work-item.md (MNR-2 del AR).
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (!parsed?.meta) {
      // ⚠️ HALLAZGO ABIERTO (reportado, NO arreglado acá — ver el comentario del
      // self-heal en `settle()`). `null` es la respuesta MÁS DÉBIL: además de "no
      // existe" puede ser un nodo sin ese pedazo de historia, uno atrasado o un
      // índice degradado. Marcarlo `indeterminate` acá APAGA el self-heal de
      // WKH-235a, que está deliberadamente testeado (T-HEAL-1/2, T-P1-2a), así que
      // flipearlo es una decisión de alcance con ticket propio, no un fix suelto.
      // Se deja el mensaje distinguible para que el follow-up sea preciso.
      return {
        valid: false,
        error: 'transaction not found on the queried node',
      };
    }
    if (parsed.meta.err) {
      // La cadena RESPONDIÓ: la tx se ejecutó y falló ⇒ negativa demostrada.
      return {
        valid: false,
        error: 'transaction failed on-chain',
      };
    }
    // WKH-319 — W2 le agrega `indeterminate: true` a la rama no medida (AC-14). Hoy
    // `verify()` NO tiene call-site de produccion (lo despierta WKH-314), asi que el
    // corte minimo sólo lo adapta al discriminante nuevo sin cambiar su contrato.
    const terms = this.checkTerms(parsed, proof);
    return terms.verdict === 'match'
      ? { valid: true }
      : { valid: false, error: terms.detail };
  }
}

/**
 * TEST-ONLY — mirror de `_resetWalletClient`.
 *
 * WKH-307: ya no hay nada de idempotencia que limpiar en memoria (el estado vive en
 * `a2a_solana_settle_intents`). Se CONSERVA porque `payment.test.ts` y
 * `settle-wiring.test.ts` lo llaman, y porque el reset del cache del preflight de
 * esquema si es estado de proceso. El reset de Connection/operator vive en
 * `chain._resetSolanaChain`.
 */
export function _resetSolanaClients(): void {
  _resetSolanaSchemaPreflight();
}
