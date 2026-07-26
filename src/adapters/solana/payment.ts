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
import { parseUnits } from 'viem';
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
const _intentSignatures = new Map<string, string>();

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
    return _intentSignatures.get(intentId);
  }

  async quote(amountUsd: number): Promise<QuoteResult> {
    const decimals = getSolanaUsdcDecimals();
    // Mirror del patrón avalanche: toFixed(decimals) antes de parseUnits para
    // aterrizar notación científica / sub-atómica a la grilla del token.
    const amountWei = parseUnits(
      amountUsd.toFixed(decimals),
      decimals,
    ).toString();
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
    const prior = _intentSignatures.get(req.intentId);
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
    _intentSignatures.set(req.intentId, signature);
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
    _intentSignatures.set(req.intentId, candidate);
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
}
