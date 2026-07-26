import { randomBytes } from 'node:crypto';
import {
  type Chain,
  createPublicClient,
  createWalletClient,
  parseSignature,
  WaitForTransactionReceiptTimeoutError,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getLogger } from '../../lib/logger.js';
import { classifyOperatorError } from '../../lib/operator-funding.js';
import {
  estimateGaslessValueUsd,
  getGaslessDefaultCapUsd,
  USDC_GASLESS_DECIMALS,
} from '../../lib/price.js';
import { buildRpcTransport } from '../../lib/rpc-transport.js';
import type {
  GaslessFundingState,
  GaslessSupportedToken,
} from '../../types/index.js';
import { GaslessTransferError } from '../errors.js';
import type {
  ChainKey,
  GaslessAdapter,
  GaslessAdapterResult,
  GaslessAdapterStatus,
  GaslessTransferAdapterRequest,
} from '../types.js';
import { type AvalancheNetwork, getAvalancheChain } from './chain.js';

/**
 * Avalanche gasless adapter (WKH-138 v1 — EIP-3009 operator-relayed).
 *
 * Reemplaza el stub 501. El OPERATOR key firma un `transferWithAuthorization`
 * EIP-3009 contra el contrato Circle USDC y auto-relaya la tx él mismo vía
 * `writeContract` (paga su propio gas AVAX). El caller se debita off-chain
 * contra su Agent Key en la ruta; acá el riesgo #1 es DRENAR el operator wallet,
 * por eso `transfer()` re-valida el cap chain-aware (USDC 6-dec) ANTES de firmar
 * (CD-5, belt-and-suspenders vs llamada directa al adapter).
 *
 * Modelo idéntico a `kite-ozone/gasless.ts`, salvo que Avalanche NO tiene un
 * relayer HTTP externo → el operator submite la tx on-chain directamente.
 *
 * CD-SDD: NO importar de `avalanche/payment.ts` (money-path). Las constantes /
 * helpers USDC son copias mínimas mirror EXACTO de `payment.ts`; el guard contra
 * divergencia es el test T-DEC (paridad address/decimals con el payment adapter).
 */

const AVALANCHE_CHAIN_ID = 43114 as const;

// USDC contract addresses canonical Circle (mirror EXACTO de payment.ts:45-48).
const DEFAULT_FUJI_USDC =
  '0x5425890298aed601595a70AB815c96711a31Bc65' as `0x${string}`;
const DEFAULT_AVALANCHE_USDC =
  '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E' as `0x${string}`;

// USDC EIP-712 domain — Circle USDC ABI identical on Fuji y Avalanche C-Chain
// (mirror EXACTO de payment.ts:51-54).
const USDC_DECIMALS = USDC_GASLESS_DECIMALS; // = 6 (CD-2: paridad con el pricing)
const USDC_EIP712_NAME = 'USD Coin' as const;
const USDC_EIP712_VERSION_DEFAULT = '2' as const;

// Guard mínimo de valor (el cap per-call es el guard real). String wei.
const USDC_MINIMUM_TRANSFER_WEI_DEFAULT = '1';

// Ventana de validez EIP-3009 (segundos). Corta: la tx se submite ya mismo.
const VALIDITY_WINDOW_SECONDS = 60;

// Timeout del receipt on-chain (ms). CD-8: timeout THROWS, no se refleja en el
// receipt. Env override no bloqueante.
const RECEIPT_TIMEOUT_MS_DEFAULT = 60_000;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const log = getLogger('avalanche');

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

// ABI mínima transferWithAuthorization (9 args v/r/s).
// [VERIFY-AT-IMPL resuelto] Circle USDC (FiatTokenV2) expone esta firma en
// Fuji/Avalanche C-Chain; los payment adapters ya firman EIP-3009 contra estos
// mismos contratos y el facilitator los submite. Ver Story File Exemplar 2.
const TRANSFER_WITH_AUTHORIZATION_ABI = [
  {
    name: 'transferWithAuthorization',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;

// ABI mínima balanceOf para status() (mirror de kite-ozone/gasless.ts:225-238).
const BALANCE_OF_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// ─── Module-level lazy state (per-process) — mirror payment.ts ──────────
let _walletClientFuji: ReturnType<typeof createWalletClient> | null = null;
let _walletClientMainnet: ReturnType<typeof createWalletClient> | null = null;
let _publicClientFuji: ReturnType<typeof createPublicClient> | null = null;
let _publicClientMainnet: ReturnType<typeof createPublicClient> | null = null;
let _warnedDefaultTokenFuji = false;
let _warnedDefaultTokenMainnet = false;

function getDefaultUsdcAddress(network: AvalancheNetwork): `0x${string}` {
  return network === 'mainnet' ? DEFAULT_AVALANCHE_USDC : DEFAULT_FUJI_USDC;
}

// Mirror EXACTO de payment.ts:90-137 (mismos env vars, mismo ADDRESS_RE,
// misma lógica warn-once). CD-SDD: duplicación controlada, guard = T-DEC.
function getUsdcAddress(network: AvalancheNetwork): `0x${string}` {
  const fallback = getDefaultUsdcAddress(network);
  const env =
    network === 'mainnet'
      ? process.env.AVALANCHE_USDC_ADDRESS
      : process.env.FUJI_USDC_ADDRESS;
  if (!env) {
    if (network === 'mainnet') {
      if (!_warnedDefaultTokenMainnet) {
        _warnedDefaultTokenMainnet = true;
        log.warn(
          { fallback },
          'AVALANCHE_USDC_ADDRESS not set — defaulting to USDC',
        );
      }
    } else {
      if (!_warnedDefaultTokenFuji) {
        _warnedDefaultTokenFuji = true;
        log.warn(
          { fallback },
          'FUJI_USDC_ADDRESS not set — defaulting to USDC',
        );
      }
    }
    return fallback;
  }
  if (!ADDRESS_RE.test(env)) {
    if (network === 'mainnet') {
      if (!_warnedDefaultTokenMainnet) {
        _warnedDefaultTokenMainnet = true;
        log.warn(
          { env, fallback },
          'AVALANCHE_USDC_ADDRESS has invalid format — defaulting to USDC',
        );
      }
    } else {
      if (!_warnedDefaultTokenFuji) {
        _warnedDefaultTokenFuji = true;
        log.warn(
          { env, fallback },
          'FUJI_USDC_ADDRESS has invalid format — defaulting to USDC',
        );
      }
    }
    return fallback;
  }
  return env as `0x${string}`;
}

// Mirror EXACTO de payment.ts:139-143.
function getUsdcEip712Version(network: AvalancheNetwork): string {
  return network === 'mainnet'
    ? (process.env.AVALANCHE_USDC_EIP712_VERSION ?? USDC_EIP712_VERSION_DEFAULT)
    : (process.env.FUJI_USDC_EIP712_VERSION ?? USDC_EIP712_VERSION_DEFAULT);
}

// Mirror EXACTO de payment.ts:145-149.
function getRpcUrl(network: AvalancheNetwork): string | undefined {
  return network === 'mainnet'
    ? process.env.AVALANCHE_RPC_URL
    : process.env.FUJI_RPC_URL;
}

function getMinimumTransferWei(): bigint {
  const raw = process.env.GASLESS_MIN_TRANSFER_USDC_WEI;
  if (raw) {
    try {
      const parsed = BigInt(raw);
      if (parsed > 0n) return parsed;
    } catch {
      // fall through to default
    }
  }
  return BigInt(USDC_MINIMUM_TRANSFER_WEI_DEFAULT);
}

function getReceiptTimeoutMs(): number {
  const raw = process.env.GASLESS_RECEIPT_TIMEOUT_MS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : RECEIPT_TIMEOUT_MS_DEFAULT;
}

// Mirror del patrón de payment.ts:167-199 (cache per-network + buildRpcTransport).
function getWalletClient(network: AvalancheNetwork) {
  if (network === 'mainnet' && _walletClientMainnet)
    return _walletClientMainnet;
  if (network === 'fuji' && _walletClientFuji) return _walletClientFuji;
  const pk = process.env.OPERATOR_PRIVATE_KEY;
  if (!pk) {
    throw new Error(
      'OPERATOR_PRIVATE_KEY not set — avalanche gasless signing disabled',
    );
  }
  const account = privateKeyToAccount(pk as `0x${string}`);
  const avalancheChain = getAvalancheChain(network);
  const client = createWalletClient({
    account,
    chain: avalancheChain,
    transport: buildRpcTransport({
      primary: getRpcUrl(network),
      fallbackEnv:
        network === 'mainnet'
          ? 'AVALANCHE_RPC_URL_FALLBACK'
          : 'FUJI_RPC_URL_FALLBACK',
      chainId: avalancheChain.id,
    }),
  });
  if (network === 'mainnet') {
    _walletClientMainnet = client;
  } else {
    _walletClientFuji = client;
  }
  return client;
}

// Public client para waitForTransactionReceipt + balanceOf (DT-8), cacheado
// per-network igual que el wallet client.
function getPublicClient(network: AvalancheNetwork) {
  if (network === 'mainnet' && _publicClientMainnet)
    return _publicClientMainnet;
  if (network === 'fuji' && _publicClientFuji) return _publicClientFuji;
  const avalancheChain = getAvalancheChain(network);
  const client = createPublicClient({
    chain: avalancheChain,
    transport: buildRpcTransport({
      primary: getRpcUrl(network),
      fallbackEnv:
        network === 'mainnet'
          ? 'AVALANCHE_RPC_URL_FALLBACK'
          : 'FUJI_RPC_URL_FALLBACK',
      chainId: avalancheChain.id,
    }),
  });
  if (network === 'mainnet') {
    _publicClientMainnet = client;
  } else {
    _publicClientFuji = client;
  }
  return client;
}

function buildSupportedToken(network: AvalancheNetwork): GaslessSupportedToken {
  return {
    network: network === 'mainnet' ? 'mainnet' : 'testnet',
    symbol: 'USDC',
    address: getUsdcAddress(network),
    decimals: USDC_DECIMALS,
    eip712Name: USDC_EIP712_NAME,
    eip712Version: getUsdcEip712Version(network),
    minimumTransferAmount: getMinimumTransferWei().toString(),
  };
}

async function getOperatorTokenBalance(
  network: AvalancheNetwork,
  operatorAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
): Promise<bigint | null> {
  try {
    const client = getPublicClient(network);
    const balance = await client.readContract({
      address: tokenAddress,
      abi: BALANCE_OF_ABI,
      functionName: 'balanceOf',
      args: [operatorAddress],
    });
    return balance;
  } catch {
    // RPC fail → null → funding_state degrada a unfunded → 503 (fail-closed).
    return null;
  }
}

// Mirror EXACTO de kite-ozone/gasless.ts:245-254 (CD-9).
function computeFundingState(opts: {
  enabled: boolean;
  operatorAddress: `0x${string}` | null;
  balance: bigint | null;
}): GaslessFundingState {
  if (!opts.enabled) return 'disabled';
  if (!opts.operatorAddress) return 'unconfigured';
  if (opts.balance === null || opts.balance === 0n) return 'unfunded';
  return 'ready';
}

function sanitizeError(err: unknown): string {
  return err instanceof Error ? err.message.substring(0, 160) : 'unknown error';
}

export class AvalancheGaslessAdapter implements GaslessAdapter {
  readonly name = 'avalanche';
  readonly chainId: number;
  private readonly network: AvalancheNetwork;
  private readonly networkTag: 'avalanche-fuji' | 'avalanche-mainnet';

  constructor(chainId: number) {
    this.chainId = chainId;
    this.network = chainId === AVALANCHE_CHAIN_ID ? 'mainnet' : 'fuji';
    this.networkTag =
      chainId === AVALANCHE_CHAIN_ID ? 'avalanche-mainnet' : 'avalanche-fuji';
  }

  /** ChainKey de pricing para la re-validación adapter-level del cap (CD-5). */
  private priceChainKey(): ChainKey {
    return this.network === 'mainnet' ? 'avalanche-mainnet' : 'avalanche-fuji';
  }

  async transfer(
    req: GaslessTransferAdapterRequest,
  ): Promise<GaslessAdapterResult> {
    // ── CD-5: re-validación del cap adapter-level (belt-and-suspenders) ──────
    // Rechaza value !finite / > cap / < minimum ANTES de firmar o submitear.
    // Chain-aware (USDC 6-dec, mismo estimador que la ruta) → anti-drain vs
    // llamada directa al adapter que bypassee el preHandler de la ruta.
    const estimatedUsd = estimateGaslessValueUsd(
      this.priceChainKey(),
      req.value,
    );
    const cap = getGaslessDefaultCapUsd();
    if (!Number.isFinite(estimatedUsd) || estimatedUsd > cap) {
      throw new GaslessTransferError(
        this.networkTag,
        `value exceeds per-call cap (estimated ${
          Number.isFinite(estimatedUsd) ? estimatedUsd : 'Infinity'
        } USD > cap ${cap} USD)`,
        // HU-192: pre-flight, nada se firmó ni se mandó a la red.
        'not-moved',
      );
    }
    const minimum = getMinimumTransferWei();
    if (req.value < minimum) {
      throw new GaslessTransferError(
        this.networkTag,
        'value below minimum_transfer_amount',
        'not-moved', // HU-192: pre-flight.
      );
    }

    // ── CD-6: firma SOLO con el OPERATOR key. from == operator.address ───────
    const walletClient = getWalletClient(this.network);
    if (!walletClient.account)
      throw new GaslessTransferError(
        this.networkTag,
        'wallet has no account',
        'not-moved', // HU-192: pre-flight.
      );
    const account = walletClient.account;
    const publicClient = getPublicClient(this.network);
    const token = getUsdcAddress(this.network);

    const now = Math.floor(Date.now() / 1000);
    const validAfter = 0n;
    const validBefore = BigInt(now + VALIDITY_WINDOW_SECONDS);
    const nonce = `0x${randomBytes(32).toString('hex')}` as `0x${string}`;

    let signature: `0x${string}`;
    try {
      signature = await walletClient.signTypedData({
        account,
        domain: {
          name: USDC_EIP712_NAME,
          version: getUsdcEip712Version(this.network),
          chainId: this.chainId,
          verifyingContract: token,
        },
        types: EIP3009_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: {
          from: account.address,
          to: req.to,
          value: req.value,
          validAfter,
          validBefore,
          nonce,
        },
      });
    } catch (err) {
      throw new GaslessTransferError(
        this.networkTag,
        `sign failed: ${sanitizeError(err)}`,
        // HU-192: la firma es local; nada llegó a la red.
        'not-moved',
      );
    }

    const parsed = parseSignature(signature);
    const vNum =
      parsed.v !== undefined ? Number(parsed.v) : Number(parsed.yParity) + 27;

    // ── Submit on-chain (operator paga su gas). CD-7: account ?? null ───────
    let txHash: `0x${string}`;
    try {
      txHash = await walletClient.writeContract({
        address: token,
        abi: TRANSFER_WITH_AUTHORIZATION_ABI,
        functionName: 'transferWithAuthorization',
        args: [
          account.address,
          req.to,
          req.value,
          validAfter,
          validBefore,
          nonce,
          vNum,
          parsed.r,
          parsed.s,
        ],
        chain: getAvalancheChain(this.network) as Chain,
        account: walletClient.account ?? null,
      });
    } catch (err) {
      // WKH-71 AC-3: the operator wallet pays its OWN gas via writeContract, so
      // a dry wallet surfaces here as viem "insufficient funds for gas".
      // Relabel it with the stable `operator-funding-low` reason instead of an
      // anonymous RPC string (message still sanitized/truncated).
      const { message, fundingLow } = classifyOperatorError(err);
      throw new GaslessTransferError(
        this.networkTag,
        `submit failed: ${message.substring(0, 160)}`,
        // HU-192: `fundingLow` = el nodo rechazó la tx por gas del operador ⟹
        // NUNCA entró al mempool, el valor no se movió (reembolsable). Cualquier
        // otro fallo de `writeContract` es AMBIGUO: `eth_sendRawTransaction`
        // puede haber sido aceptado y la respuesta perdida ⟹ 'unknown'
        // (fail-safe: no reembolsar de más).
        fundingLow ? 'not-moved' : 'unknown',
      );
    }

    // ── Receipt. CD-8: timeout (THROW) separado de revert (receipt.status) ──
    try {
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: getReceiptTimeoutMs(),
      });
      if (receipt.status !== 'success') {
        throw new GaslessTransferError(
          this.networkTag,
          `transfer reverted on-chain (tx ${txHash})`,
          // HU-192: revert CONFIRMADO — la tx existe pero no transfirió nada
          // (el operador sólo perdió gas) ⟹ el débito del caller es reembolsable.
          'not-moved',
        );
      }
    } catch (err) {
      if (err instanceof WaitForTransactionReceiptTimeoutError) {
        throw new GaslessTransferError(
          this.networkTag,
          `receipt timeout (tx ${txHash})`,
          // HU-192: la tx YA está en la red y puede confirmarse después ⟹ NO
          // reembolsar (sería pagar el transfer Y devolver el budget).
          'unknown',
        );
      }
      if (err instanceof GaslessTransferError) throw err;
      throw new GaslessTransferError(
        this.networkTag,
        `receipt failed: ${sanitizeError(err)}`,
        // HU-192: la tx se broadcasteó; el fallo es del read del receipt ⟹
        // suerte del valor desconocida.
        'unknown',
      );
    }

    return { txHash };
  }

  async status(): Promise<GaslessAdapterStatus> {
    const enabled = process.env.GASLESS_ENABLED === 'true';
    const baseFields = {
      network: this.networkTag,
      chain_id: this.chainId,
      documentation:
        'https://github.com/ferrosasfp/wasiai-a2a/blob/main/doc/architecture/CHAIN-ADAPTIVE.md',
    };
    if (!enabled) {
      return {
        enabled: false,
        ...baseFields,
        supportedToken: null,
        operatorAddress: null,
        funding_state: 'disabled',
      };
    }

    let operatorAddress: `0x${string}` | null = null;
    const pk = process.env.OPERATOR_PRIVATE_KEY;
    if (pk) {
      try {
        operatorAddress = privateKeyToAccount(pk as `0x${string}`).address;
      } catch {
        operatorAddress = null;
      }
    }

    const supportedToken = buildSupportedToken(this.network);

    let balance: bigint | null = null;
    if (operatorAddress) {
      balance = await getOperatorTokenBalance(
        this.network,
        operatorAddress,
        supportedToken.address,
      );
    }

    const funding_state = computeFundingState({
      enabled,
      operatorAddress,
      balance,
    });

    return {
      enabled,
      ...baseFields,
      supportedToken,
      operatorAddress,
      funding_state,
    };
  }
}

/**
 * TEST-ONLY — clears cached wallet/public clients + warn-once flags so each test
 * can rebuild deterministically (CD-11).
 */
export function _resetAvalancheGasless(): void {
  _walletClientFuji = null;
  _walletClientMainnet = null;
  _publicClientFuji = null;
  _publicClientMainnet = null;
  _warnedDefaultTokenFuji = false;
  _warnedDefaultTokenMainnet = false;
}
