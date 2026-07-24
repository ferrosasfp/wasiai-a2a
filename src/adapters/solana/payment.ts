import {
  createTransferInstruction,
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
  QuoteResult,
  SettleResult,
  SolanaPaymentAdapter as ISolanaPaymentAdapter,
  SolanaSettleProof,
  SolanaSettleRequest,
  SolanaTokenSpec,
  VerifyResult,
} from '../types.js';
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

  async quote(amountUsd: number): Promise<QuoteResult> {
    const decimals = getSolanaUsdcDecimals();
    // Mirror del patrón avalanche: toFixed(decimals) antes de parseUnits para
    // aterrizar notación científica / sub-atómica a la grilla del token.
    const amountWei = parseUnits(amountUsd.toFixed(decimals), decimals).toString();
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

    const signature = await sendAndConfirmTransaction(connection, tx, [operator], {
      commitment: getSolanaCommitment(),
    });

    // Persist-before-return del seam de idempotencia (W5 lo respalda en ledger).
    _intentSignatures.set(req.intentId, signature);
    log.info(
      { intentId: req.intentId, signature, payTo: req.payTo },
      'solana settle broadcast confirmed',
    );
    return { txHash: signature, success: true };
  }

  async verify(proof: SolanaSettleProof): Promise<VerifyResult> {
    const connection = getSolanaConnection();
    const parsed = await connection.getParsedTransaction(proof.signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (!parsed || !parsed.meta || parsed.meta.err) {
      return { valid: false, error: 'transaction not found or failed on-chain' };
    }

    const mint = getSolanaUsdcMint();
    const required = BigInt(proof.amountAtomic);

    // Delta de balance de token del owner=payTo para el mint esperado
    // (verify-before-trust). pre/postTokenBalances son la fuente canónica.
    const pre = parsed.meta.preTokenBalances ?? [];
    const post = parsed.meta.postTokenBalances ?? [];

    const balanceFor = (
      list: typeof post,
    ): bigint => {
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
