import { Connection, Keypair } from '@solana/web3.js';
import { getLogger } from '../../lib/logger.js';

/**
 * Solana devnet chain registration (WKH-234).
 *
 * Resuelve cluster / RPC / CAIP-2 / mint / decimals / commitment / sentinel
 * desde env (opts > env > default documentado, CD-3) — espejo de
 * `avalanche/chain.ts`. Devnet-only (CD-4): NO hay variante `-mainnet`.
 *
 * `SOLANA_OPERATOR_PRIVATE_KEY` se decodifica acá y NUNCA se loguea (CD-3).
 */

const log = getLogger('solana');

export type SolanaNetwork = 'devnet';

// ── Defaults documentados (mirror del bloque .env.example, CD-3) ──────────
const DEFAULT_RPC_URL = 'https://api.devnet.solana.com';
const DEFAULT_USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const DEFAULT_USDC_DECIMALS = 6;
const DEFAULT_COMMITMENT = 'confirmed';
const DEFAULT_CAIP2_CHAIN_ID = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const DEFAULT_SYNTHETIC_CHAIN_ID = 900001;

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// ── Module-level lazy state (per-process, no per-instance) ────────────────
let _connection: Connection | null = null;
let _operator: Keypair | null = null;

export function getSolanaNetwork(_opts?: {
  network?: SolanaNetwork;
}): SolanaNetwork {
  // Devnet-only (CD-4). El slug `SOLANA_CLUSTER` se lee para telemetría/consistencia
  // pero la única red soportada es devnet.
  return 'devnet';
}

export function getSolanaRpcUrl(): string {
  return process.env.SOLANA_RPC_URL ?? DEFAULT_RPC_URL;
}

export function getSolanaCommitment(): 'processed' | 'confirmed' | 'finalized' {
  const raw = process.env.SOLANA_COMMITMENT ?? DEFAULT_COMMITMENT;
  return raw === 'processed' || raw === 'finalized' ? raw : 'confirmed';
}

export function getSolanaUsdcMint(): string {
  return process.env.SOLANA_USDC_MINT_DEVNET ?? DEFAULT_USDC_MINT_DEVNET;
}

export function getSolanaUsdcDecimals(): number {
  const raw = process.env.SOLANA_USDC_DECIMALS;
  if (raw === undefined || raw === '') return DEFAULT_USDC_DECIMALS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_USDC_DECIMALS;
}

export function getSolanaCaip2(): string {
  return process.env.SOLANA_CAIP2_CHAIN_ID ?? DEFAULT_CAIP2_CHAIN_ID;
}

export function getSolanaSyntheticChainId(): number {
  const raw = process.env.SOLANA_SYNTHETIC_CHAIN_ID;
  if (raw === undefined || raw === '') return DEFAULT_SYNTHETIC_CHAIN_ID;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_SYNTHETIC_CHAIN_ID;
}

/** Connection cacheada por proceso (mirror del wallet-client cache EVM). */
export function getSolanaConnection(): Connection {
  if (_connection) return _connection;
  _connection = new Connection(getSolanaRpcUrl(), getSolanaCommitment());
  return _connection;
}

/**
 * Decodifica un string base58 a bytes (algoritmo base-x estándar). PURO — no
 * depende de `bs58`. Usado solo para el secret-key del operator.
 */
function base58DecodeToBytes(s: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let carry = BASE58_ALPHABET.indexOf(s[i] as string);
    if (carry < 0) {
      throw new Error('SOLANA_OPERATOR_PRIVATE_KEY is not valid base58');
    }
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] as number) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < s.length && s[i] === '1'; i++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}

/**
 * Operator `Keypair` desde `SOLANA_OPERATOR_PRIVATE_KEY` (base58 ed25519 secret).
 * Cacheado por proceso. NUNCA loguea el secret ni lo incluye en mensajes de error
 * (CD-3) — solo la pubkey es segura de exponer.
 */
export function getSolanaOperatorKeypair(): Keypair {
  if (_operator) return _operator;
  const raw = process.env.SOLANA_OPERATOR_PRIVATE_KEY;
  if (!raw) {
    throw new Error(
      'SOLANA_OPERATOR_PRIVATE_KEY not set — solana settle signing disabled',
    );
  }
  const secret = base58DecodeToBytes(raw.trim());
  const keypair = Keypair.fromSecretKey(secret);
  _operator = keypair;
  log.info(
    { operator: keypair.publicKey.toBase58() },
    'solana operator loaded',
  );
  return keypair;
}

/**
 * TEST-ONLY — limpia la Connection + operator cacheados (mirror
 * `_resetWalletClient`). CD-17.
 */
export function _resetSolanaChain(): void {
  _connection = null;
  _operator = null;
}
