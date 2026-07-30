import { Connection, Keypair } from '@solana/web3.js';
import { getLogger } from '../../lib/logger.js';
import { base58DecodeToBytes } from './base58.js';

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
  const operatorPubkey = keypair.publicKey.toBase58();
  log.info({ operator: operatorPubkey }, 'solana operator loaded');

  // ── WKH-315 (§4.4) — COHERENCIA CUENTA-DE-DEPOSITO ↔ OPERADOR ──────────────
  //
  // El riesgo que cierra: si `A2A_DEPOSIT_OWNER_SOLANA` apunta a una pubkey que el
  // operador NO controla, el dinero del usuario aterriza en una cuenta desde la que
  // no se puede pagar. Nadie se enteraría hasta querer gastarlo, y el depósito ya
  // estaría acreditado en el saldo.
  //
  // ⚠️ POR QUE LA ASERCION VIVE ACA Y NO EN EL CAMINO DE DEPOSITO. Comprobarlo
  // requiere la PUBKEY DEL OPERADOR, o sea cargar el `Keypair` — y AC-12/CD-4
  // prohíben que el camino de depósito lo toque (un depósito no necesita que el
  // gateway firme nada, y hacerlo ataría un proceso que sólo RECIBE a la llave que
  // FIRMA). Tampoco puede ir en `createSolanaAdapters`: esa factory hoy NO carga el
  // keypair, y hacerlo rompería el arranque de un proceso que sólo quiere recibir
  // depósitos. Acá el keypair ya está cargado: cero dependencia de arranque nueva.
  //
  // ⚠️ TRADE-OFF DECLARADO: un error de config del DEPOSITO deja de settlear la
  // SALIDA. Es ruidoso, inmediato y reversible en un minuto (setear la env bien, o
  // declarar la cuenta dedicada), contra un dinero perdido que no lo es. Cuando los
  // dos errores no cuestan lo mismo, el default va del lado barato.
  //
  // La salida es una AFIRMACION DEL OPERADOR, no un apagador del control (exemplar:
  // `SOLANA_RPC_LEDGER_HISTORY_DECLARED_SUFFICIENT` en `schema-preflight.ts`): quien
  // usa deliberadamente una cuenta de depósito distinta lo DECLARA con
  // `A2A_DEPOSIT_OWNER_IS_DEDICATED_SOLANA=true` y se hace responsable de barrerla.
  //
  // ⚠️ Y LA ASERCION SOLO CORRE CON EL CAMINO DE DEPOSITO ENCENDIDO (fix-pack AR ·
  // BLQ-BAJO-1). Sin esta condición, seguir el orden de activación que el propio
  // `.env.example` declara —migración, después el owner, y el flag AL FINAL— y
  // olvidarse de la env de cuenta dedicada **tiraba TODO settle Solana de SALIDA**
  // (`payment.ts`) con el depósito todavía APAGADO, o sea sin que existiera un solo
  // depósito que proteger. El runbook correcto no puede ser el que rompe producción.
  //
  // Se lee la env directamente en vez de llamar a `isSolanaDepositEnabled()`:
  // `deposit-account.ts` importa `getSolanaUsdcMint` de ESTE módulo, así que la
  // llamada crearía un ciclo de imports en el camino de firma. La comparación es la
  // misma comparación literal contra `'true'`, y el choke-point del depósito sigue
  // siendo único — acá el flag es una PRECONDICION de la aserción, no una decisión
  // sobre si el camino de entrada está abierto.
  const depositPathOn = process.env.A2A_DEPOSIT_ENABLED_SOLANA === 'true';
  const declaredOwner = process.env.A2A_DEPOSIT_OWNER_SOLANA?.trim();
  if (
    depositPathOn &&
    declaredOwner !== undefined &&
    declaredOwner !== '' &&
    declaredOwner !== operatorPubkey &&
    process.env.A2A_DEPOSIT_OWNER_IS_DEDICATED_SOLANA !== 'true'
  ) {
    // El mensaje nombra las dos envs (accionable) y NO incluye ningún secreto: las
    // dos pubkeys son públicas por definición.
    throw new Error(
      `A2A_DEPOSIT_OWNER_SOLANA (${declaredOwner}) is not the solana operator pubkey (${operatorPubkey}) — deposits would land in an account this process cannot pay from. Point the env at the operator, or set A2A_DEPOSIT_OWNER_IS_DEDICATED_SOLANA=true to declare the deposit account is deliberately separate.`,
    );
  }

  // ⚠️ EL CACHE VA DESPUES DE LA ASERCION, A PROPOSITO. Si se cacheara antes, el
  // primer llamado lanzaría y el SEGUNDO devolvería el keypair del cache sin
  // re-chequear: un guard que se saltea con un simple reintento no es un guard.
  _operator = keypair;
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
