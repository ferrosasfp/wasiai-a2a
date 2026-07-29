import {
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token';
import { type Connection, PublicKey, Transaction } from '@solana/web3.js';
import { usdToAtomicUnits } from '../../lib/atomic-amount.js';
import { getLogger } from '../../lib/logger.js';
import type {
  SolanaPaymentAdapter as ISolanaPaymentAdapter,
  QuoteResult,
  SettledPeek,
  SettlementPresence,
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
// WKH-307: la idempotencia dejo de ser un Map de proceso y paso a una tabla. Todo el
// acceso a datos del adapter vive en `settle-ledger.ts` (CD-7).
import {
  _resetSolanaSchemaPreflight,
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

    switch (claim.outcome) {
      case 'claimed':
        // Ganamos el derecho a transmitir. Es el UNICO caso que sigue.
        return await this.signPersistBroadcast(req);

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
        'solana settle deferred — the ledger says this intent was confirmed but the chain could not be queried; NOT re-broadcasting and NOT condemning the row',
      );
      throw new Error(
        `SETTLE_PRESENCE_UNKNOWN: ${req.intentId} (${presence.detail})`,
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
        'solana settle refused — could not determine whether the signed transaction landed; refusing to re-broadcast on an unanswered question',
      );
      throw new Error(
        `SETTLE_IN_FLIGHT_UNRESOLVED: ${req.intentId} (presence unknown: ${presence.detail})`,
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

    // Llegados aca la presencia es `absent` o `landed_failed`. LAS DOS exigen ademas
    // la PRUEBA DE EXPIRACION antes de re-firmar.
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
      throw new Error(
        `SETTLE_SIGNED_UNRESOLVED: ${req.intentId} (presence=${presence.state}) has no last_valid_block_height to prove the previous transaction can no longer land`,
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
      throw new Error(`SETTLE_IN_FLIGHT_UNRESOLVED: ${req.intentId}`);
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
    return await this.signPersistBroadcast(req);
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
   */
  private async probeSettlementPresence(
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
    const terms = this.checkTerms(parsed, proof);
    return terms.ok
      ? { state: 'landed_ok' }
      : { state: 'landed_mismatch', detail: terms.error };
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
   */
  private checkTerms(
    parsed: NonNullable<
      Awaited<ReturnType<Connection['getParsedTransaction']>>
    >,
    proof: SolanaSettleProof,
  ): { ok: true } | { ok: false; error: string } {
    const meta = parsed.meta;
    if (!meta) return { ok: false, error: 'transaction has no meta' };
    const mint = getSolanaUsdcMint();
    const required = BigInt(proof.amountAtomic);

    // Delta de balance de token del owner=payTo para el mint esperado
    // (verify-before-trust). pre/postTokenBalances son la fuente canonica.
    const pre = meta.preTokenBalances ?? [];
    const post = meta.postTokenBalances ?? [];
    const balanceFor = (list: typeof post): bigint => {
      const entry = list.find(
        (b) => b.owner === proof.payTo && b.mint === mint,
      );
      return entry ? BigInt(entry.uiTokenAmount.amount) : 0n;
    };
    const delta = balanceFor(post) - balanceFor(pre);
    if (delta < required) {
      return {
        ok: false,
        error: `on-chain transfer ${delta} < required ${required} for ${proof.payTo}`,
      };
    }
    return { ok: true };
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
    if (!parsed?.meta || parsed.meta.err) {
      return {
        valid: false,
        error: 'transaction not found or failed on-chain',
      };
    }
    const terms = this.checkTerms(parsed, proof);
    return terms.ok ? { valid: true } : { valid: false, error: terms.error };
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
