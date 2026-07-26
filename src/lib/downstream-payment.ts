/**
 * Downstream x402 Payment — chain-aware thin orchestrator (WKH-112 / BASE-07).
 *
 * Resolves the destination chain from `agent.payment.chain` via `normalizeChainSlug`,
 * validates it is initialized in the registry (fail-loud `CHAIN_NOT_SUPPORTED`), and
 * delegates sign + verify + settle to `getPaymentAdapter(chainKey)`. The EIP-3009
 * signature is owned by the adapter (per-chain EIP-712 domain) — NEVER reimplemented
 * inline (CD-9). NEVER throws (CD-7): every async step is wrapped and returns `null`
 * with a skip-code.
 */
import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  http,
  parseUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  isMainnetChainKey,
  normalizeChainSlug,
} from '../adapters/chain-resolver.js';
import {
  getAdaptersBundle,
  getInitializedChainKeys,
  getPaymentAdapter,
  getPaymentAdapterOrUnion,
} from '../adapters/registry.js';
import type { ChainKey, SolanaPaymentAdapter } from '../adapters/types.js';
import type { Agent, DownstreamLogger } from '../types/index.js';
import { isValidSolanaAddress } from './wallet-format.js';

// Re-export for backward-compat: callers historically import
// `DownstreamLogger` from this module (e.g. compose.ts). The canonical
// definition now lives in `types/index.ts` (TD-WKH-55-4 / CR-MNR-3).
export type { DownstreamLogger };

// CD-NEW-SDD-3: read the flag ONCE at module load
const DOWNSTREAM_FLAG = process.env.WASIAI_DOWNSTREAM_X402 === 'true';

/**
 * WKH-235a — warn-once del skip `FLAG_OFF`. Era el ÚNICO skip-code que
 * retornaba `null` sin dejar rastro (hallazgo F4 de WKH-241): el campo
 * `downstream` desaparecía del output de `/compose` sin explicación. El flag se
 * lee una sola vez al cargar el módulo, así que un log por proceso alcanza
 * (mismo patrón warn-once que `avalanche/payment.ts` / `discovery.ts`) — se
 * evita ruido por cada leg de cada request.
 */
let _warnedFlagOff = false;

/**
 * EIP-3009 authorization window (`validBefore`) in seconds, passed to
 * `adapter.sign({ ..., timeoutSeconds })`. Reproduces the legacy
 * `VALID_BEFORE_SECONDS = 300` so the Avalanche path keeps its observable 300s
 * window (CD-1). The adapter default is 60s — omitting this regressed the
 * window (AR BLQ-MED-1).
 */
const DOWNSTREAM_AUTH_WINDOW_SECONDS = 300;

/**
 * Maps each `ChainKey` to the env-var NAME that holds its RPC URL (DT-3).
 * This is NOT a hardcode of chain (CD-3 tolerates env-var names): the actual
 * URL comes from the process env at runtime. The `Record<ChainKey, string>`
 * covers all 6 keys to satisfy TS strict, even though only the 3 testnets are
 * exercised in this HU (mainnet is Scope OUT).
 */
const RPC_ENV_BY_CHAIN: Record<ChainKey, string> = {
  'avalanche-fuji': 'FUJI_RPC_URL',
  'avalanche-mainnet': 'AVALANCHE_RPC_URL',
  'base-sepolia': 'BASE_TESTNET_RPC_URL',
  'base-mainnet': 'BASE_MAINNET_RPC_URL',
  'kite-ozone-testnet': 'KITE_RPC_URL',
  'kite-mainnet': 'KITE_MAINNET_RPC_URL',
  // WKH-090 — cuarto rail (testnet-only, flag-gated OFF). Requerido para
  // exhaustividad del Record<ChainKey, string>; dead code con el flag OFF (el
  // rail nunca inicializa un bundle → CHAIN_NOT_SUPPORTED antes de llegar acá).
  'tempo-testnet': 'TEMPO_TESTNET_RPC_URL',
  // WKH-234 — Solana rail. Requerido para exhaustividad del Record<ChainKey>;
  // el settle Solana no usa este env viem-oriented (usa SOLANA_RPC_URL vía el
  // adapter), pero el nombre canónico coincide.
  'solana-devnet': 'SOLANA_RPC_URL',
};

// ─── Public types ───────────────────────────────────────────────────
export interface DownstreamResult {
  // WKH-234: namespace-aware. EVM = `0x${string}` (tx hash); Solana = firma
  // base58 del SPL-transfer. Widened a `string` para alojar ambas familias.
  txHash: string;
  blockNumber?: number; // opcional — el adapter SettleResult no lo expone (TD-WKH-112-01)
  settledAmount: string; // atomic units; = value.toString()
  // WKH-234 fix-pack AR-BLQ-1: CAIP-2 del leg cuando el settle fue Solana
  // (`solana:<cluster>`). Presente SOLO en la rama Solana → `compose` lo usa
  // para registrar el CAIP-2 + firma en el ledger (AC-8). Ausente en legs EVM.
  settleCaip2?: string;
  // Fix-pack AR-profundo FIX 3: monto REALMENTE settleado al agente, en USD,
  // derivado de `settledAmount` con los decimals del token del adapter. Es lo
  // que el recibo del ledger debe cruzar contra la transferencia on-chain — el
  // débito del caller (`stepDebitedUsd` en compose) NO sirve: vale 0 para el
  // step 0 (lo debita el middleware) e incluye el gas overhead del gateway, que
  // nunca se le paga al agente. Poblado SOLO en la rama Solana (la única que
  // alimenta el ledger vía `settleCaip2`); ausente en legs EVM → rama EVM
  // byte-idéntica.
  settledAmountUsd?: number;
}

export type DownstreamSkipCode =
  | 'FLAG_OFF'
  | 'NO_PAYMENT_FIELD'
  | 'METHOD_NOT_SUPPORTED'
  | 'CHAIN_NOT_SUPPORTED'
  | 'MAINNET_NOT_ALLOWED'
  | 'INVALID_PAY_TO_FORMAT'
  | 'ZERO_PAY_TO'
  | 'INVALID_PRICE'
  | 'INSUFFICIENT_BALANCE'
  | 'BALANCE_READ_FAILED'
  | 'SIGNING_FAILED'
  | 'VERIFY_FAILED'
  | 'SETTLE_FAILED';

// ─── Internal helpers ───────────────────────────────────────────────

/**
 * Fix-pack AR-profundo FIX 1(b) — opt-in EXPLÍCITO para settlear un leg
 * downstream contra una chain MAINNET (dinero real).
 *
 * Contexto del hallazgo: la chain del leg es agent-controlled por diseño (el
 * agente declara `payment.chain` en su card). `base-mainnet` / `kite-mainnet` /
 * `avalanche-mainnet` estaban en `SUPPORTED_CHAINS` SIN gate, a diferencia de
 * `tempo-testnet` / `solana-devnet` (flag-gated en `registry.getSupportedChains`),
 * y el control que la documentación de operación prometía
 * (`WASIAI_DOWNSTREAM_NETWORK`) no lo lee NADIE — era un control muerto.
 *
 * Política (FAIL-CLOSED, default seguro):
 *   - `WASIAI_DOWNSTREAM_MAINNET_ALLOW` ausente o vacía → NINGUNA mainnet
 *     permitida en el leg downstream → skip-code `MAINNET_NOT_ALLOWED`.
 *   - CSV de slugs (acepta cualquier alias que el resolver conozca, incluidos
 *     los numéricos: `avalanche-mainnet`, `43114`, `base-mainnet`, `8453`, …) →
 *     sólo esas mainnets pueden settlear.
 *
 * NO afecta ningún entorno actual (todo el deploy es testnet-only) y NO toca el
 * rail INBOUND: los slugs mainnet siguen en `SUPPORTED_CHAINS` y el debit de
 * budget inbound sigue funcionando igual. Es estrictamente más restrictivo que
 * hoy en la única dirección donde el gateway MUEVE fondos del operador.
 *
 * La env se lee POR LLAMADA (no cacheada al cargar el módulo, a diferencia de
 * `DOWNSTREAM_FLAG`): así el operador puede revertir el opt-in con un redeploy
 * de variables sin depender del orden de import, y el gate es testeable sin
 * `vi.resetModules()`. El costo es una lectura de `process.env` por leg.
 */
function isDownstreamMainnetAllowed(chainKey: ChainKey): boolean {
  const raw = process.env.WASIAI_DOWNSTREAM_MAINNET_ALLOW;
  if (typeof raw !== 'string' || raw.trim().length === 0) return false;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .some((entry) => normalizeChainSlug(entry) === chainKey);
}

/**
 * Validates payTo format and rejects the zero-address (R-1 mitigation).
 * Returns { ok: true, addr } or { ok: false, code }.
 */
function validatePayTo(
  contract: string,
):
  | { ok: true; addr: `0x${string}` }
  | { ok: false; code: 'INVALID_PAY_TO_FORMAT' | 'ZERO_PAY_TO' } {
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) {
    return { ok: false, code: 'INVALID_PAY_TO_FORMAT' };
  }
  if (contract.toLowerCase() === '0x0000000000000000000000000000000000000000') {
    return { ok: false, code: 'ZERO_PAY_TO' };
  }
  return { ok: true, addr: contract as `0x${string}` };
}

/**
 * WKH-234 — settle de UN leg Solana (settle-only, operator-signed). Espejo
 * funcional de la rama EVM pero SIN el dance sign→verify→settle: el adapter
 * Solana hace build+sign+broadcast+confirm (idempotente por `intentId`, AC-7).
 * NEVER-throws (CD-10): retorna `null` + skip-code, nunca lanza. Monto atómico
 * decimals-aware desde el adapter (CD-9).
 *
 * CR-2 (WKH-234): antes de settlear corre un pre-flight de balance del operador
 * (mismo skip-code `INSUFFICIENT_BALANCE` que la rama EVM), fail-soft si el
 * balance no se puede leer — ver el comentario del bloque.
 *
 * NOTA (fix-pack AR-MNR-2): el settle FRESCO confía en la confirmación de
 * `sendAndConfirmTransaction` (commitment configurado); el `verify()` on-chain
 * del adapter sólo corre en el camino idempotente-hit (re-lee una firma previa
 * antes de reusarla). Este helper NO invoca verify() en el settle fresco.
 */
async function settleSolanaLeg(
  agent: Agent,
  adapter: SolanaPaymentAdapter,
  logger: DownstreamLogger,
  intentId?: string,
): Promise<DownstreamResult | null> {
  // payTo base58 (CD-9) — NO 0x. Validador puro (sin web3.js).
  const payTo = agent.payment?.contract ?? '';
  if (!isValidSolanaAddress(payTo)) {
    logger.warn(
      { agentSlug: agent.slug, code: 'INVALID_PAY_TO_FORMAT' },
      '[Downstream] solana payTo is not a valid base58 pubkey',
    );
    return null;
  }

  // priceUsdc guard (mismo criterio que la rama EVM).
  if (!Number.isFinite(agent.priceUsdc) || agent.priceUsdc <= 0) {
    logger.warn(
      {
        agentSlug: agent.slug,
        code: 'INVALID_PRICE',
        priceUsdc: agent.priceUsdc,
      },
      '[Downstream] priceUsdc must be a finite positive number',
    );
    return null;
  }

  // Monto atómico decimals-aware desde el mint del adapter (CD-9, nunca 1e6/1e18).
  const token = adapter.supportedTokens[0];
  if (!token) {
    logger.warn(
      { agentSlug: agent.slug, code: 'INVALID_PRICE' },
      '[Downstream] solana adapter has no supported tokens',
    );
    return null;
  }
  let amountAtomic: string;
  try {
    amountAtomic = parseUnits(
      String(agent.priceUsdc),
      token.decimals,
    ).toString();
  } catch (e) {
    logger.warn(
      { agentSlug: agent.slug, code: 'INVALID_PRICE', detail: String(e) },
      '[Downstream] parseUnits failed (solana)',
    );
    return null;
  }

  // Idempotency key determinístico del leg (AC-7). Fallback si el caller no lo
  // pasó: `<slug>:<payTo>` (estable por leg). Canónico: `contextId:stepIndex:payTo`.
  //
  // Fix-pack AR-profundo FIX 2: se resuelve ANTES del pre-flight de balance. El
  // orden importa: un intent YA settleado no necesita fondos. Con el pre-check
  // primero, el hit idempotente del adapter era inalcanzable exactamente cuando
  // el balance del operador había bajado del precio del leg — que es lo que pasa
  // DESPUÉS de haber pagado ese mismo leg ⇒ el retry devolvía `null` con
  // `INSUFFICIENT_BALANCE`, sin recibo ni `settle_signature` en el ledger, y el
  // log afirmaba lo contrario de la verdad (un pago SPL real reportado como no
  // pagado).
  const legIntentId = intentId ?? `${agent.slug}:${payTo}`;
  const priorSignature = adapter.getSettledSignature(legIntentId);

  // Pre-flight de balance del operador — paridad de observabilidad con la rama
  // EVM (CR-2 de WKH-234). Corta temprano con el MISMO skip-code
  // `INSUFFICIENT_BALANCE` que el paso 9 del path EVM, en vez de dejar que el
  // settle falle-soft con un `SETTLE_FAILED` genérico que no distingue "no hay
  // fondos" de "falló el RPC" o "la tx se rechazó".
  //
  // Se OMITE cuando el intent ya tiene firma (FIX 2): el settle de abajo va a
  // tomar el camino idempotente (verify on-chain de la firma previa + retorno
  // sin re-broadcast), que no mueve fondos nuevos.
  //
  // ASIMETRÍA DELIBERADA vs EVM: si el balance NO se puede leer, acá NO se
  // bloquea el settle (la rama EVM sí corta con `BALANCE_READ_FAILED`). El
  // pre-check es una optimización de observabilidad, NO un gate nuevo: en Solana
  // la lectura del ATA del operador lanza tanto por RPC caído como porque la
  // cuenta todavía no existe, y ambas son indistinguibles a este nivel →
  // tratarlas como "fondos insuficientes" bloquearía settles legítimos (falso
  // negativo). Se degrada a "balance desconocido, intentá el settle" y el error
  // real, si lo hay, sigue apareciendo como `SETTLE_FAILED`.
  if (priorSignature !== undefined) {
    logger.info(
      {
        agentSlug: agent.slug,
        code: 'BALANCE_PRECHECK_SKIPPED',
        intentId: legIntentId,
        reason: 'IDEMPOTENT_INTENT',
      },
      '[Downstream] solana balance pre-check skipped (intent already settled — idempotent replay)',
    );
  } else {
    let operatorBalance: bigint | undefined;
    try {
      operatorBalance = BigInt(await adapter.getOperatorSplBalance());
    } catch (e) {
      logger.info(
        {
          agentSlug: agent.slug,
          code: 'BALANCE_PRECHECK_SKIPPED',
          detail: String(e),
        },
        '[Downstream] solana balance pre-check skipped (operator SPL balance unreadable)',
      );
    }
    if (
      operatorBalance !== undefined &&
      operatorBalance < BigInt(amountAtomic)
    ) {
      logger.warn(
        {
          agentSlug: agent.slug,
          code: 'INSUFFICIENT_BALANCE',
          balance: operatorBalance.toString(),
          required: amountAtomic,
        },
        '[Downstream] insufficient solana operator SPL balance',
      );
      return null;
    }
  }

  // settle: build+sign+broadcast+confirm + verify-before-trust interno.
  let settleRes: Awaited<ReturnType<typeof adapter.settle>>;
  try {
    settleRes = await adapter.settle({
      payTo,
      amountAtomic,
      intentId: legIntentId,
    });
  } catch (e) {
    logger.warn(
      { agentSlug: agent.slug, code: 'SETTLE_FAILED', detail: String(e) },
      '[Downstream] solana adapter.settle threw',
    );
    return null;
  }
  if (!settleRes.success || !settleRes.txHash) {
    logger.warn(
      { agentSlug: agent.slug, code: 'SETTLE_FAILED', error: settleRes.error },
      '[Downstream] solana adapter.settle returned success=false',
    );
    return null;
  }

  return {
    txHash: settleRes.txHash, // firma base58 del SPL-transfer
    settledAmount: amountAtomic,
    // Fix-pack AR-BLQ-1: propaga el CAIP-2 del adapter para que compose registre
    // el leg Solana en el ledger (AC-8 — settle_caip2 + settle_signature).
    settleCaip2: adapter.caip2ChainId,
    // Fix-pack AR-profundo FIX 3: monto settleado en USD, derivado del MISMO
    // atómico que se transfirió y de los decimals del mint del adapter (round-trip
    // exacto de `parseUnits`). Es el número que el recibo del ledger debe cruzar
    // contra la transferencia on-chain.
    settledAmountUsd: Number(formatUnits(BigInt(amountAtomic), token.decimals)),
  };
}

// ─── Public API (SINGLE functional export) ──────────────────────────

/**
 * Resolve the destination chain, delegate sign + verify + settle to its adapter.
 * NEVER throws (CD-7).
 *
 * Returns `null` in any of these cases (each logged with its skip-code):
 *  - flag `WASIAI_DOWNSTREAM_X402` is not 'true'        → FLAG_OFF (warn-once)
 *  - agent.payment absent                               → NO_PAYMENT_FIELD
 *  - method !== 'x402'                                  → METHOD_NOT_SUPPORTED
 *  - chain unrecognized or not initialized in registry  → CHAIN_NOT_SUPPORTED
 *  - chain is MAINNET without explicit env opt-in       → MAINNET_NOT_ALLOWED
 *  - payTo invalid or zero                              → INVALID_PAY_TO_FORMAT / ZERO_PAY_TO
 *  - priceUsdc not a finite positive number             → INVALID_PRICE
 *  - operator balance < required value                  → INSUFFICIENT_BALANCE
 *  - balance read RPC failure                           → BALANCE_READ_FAILED
 *  - adapter.sign throws                                → SIGNING_FAILED
 *  - adapter.verify throws or returns valid=false       → VERIFY_FAILED
 *  - adapter.settle throws or returns success=false     → SETTLE_FAILED
 *
 * Returns `DownstreamResult` ONLY when the adapter confirmed `success: true`.
 */
export async function signAndSettleDownstream(
  agent: Agent,
  logger: DownstreamLogger,
  // WKH-234: idempotency key para el leg Solana (AC-7). Solo lo consume la rama
  // Solana; la rama EVM lo ignora (usa el nonce EIP-3009). Ausente → derivado
  // del leg (agent.slug:payTo). Formato canónico: `contextId:stepIndex:payTo`.
  intentId?: string,
): Promise<DownstreamResult | null> {
  // 1. Flag check (zero overhead when off). WKH-235a: observabilidad warn-once
  //    del skip — el comportamiento NO cambia (sigue devolviendo `null` sin
  //    resolver ningún adapter).
  if (!DOWNSTREAM_FLAG) {
    if (!_warnedFlagOff) {
      _warnedFlagOff = true;
      logger.info(
        { agentSlug: agent.slug, code: 'FLAG_OFF' },
        '[Downstream] WASIAI_DOWNSTREAM_X402 not enabled — downstream settle skipped (logged once per process)',
      );
    }
    return null;
  }

  // 2. agent.payment presence
  if (!agent.payment) {
    logger.info(
      { agentSlug: agent.slug, code: 'NO_PAYMENT_FIELD' },
      '[Downstream] agent.payment absent — skipped',
    );
    return null;
  }

  // 3. method check
  if (agent.payment.method !== 'x402') {
    logger.info(
      {
        agentSlug: agent.slug,
        method: agent.payment.method,
        code: 'METHOD_NOT_SUPPORTED',
      },
      `[Downstream] method=${agent.payment.method} not supported — skipped`,
    );
    return null;
  }

  // 4. Resolve the chain ONCE (CD-6). Fail-loud if unrecognized or not
  //    initialized in the registry — PROHIBITED to fall back to a default
  //    or cross-chain (CD-4 / AC-4).
  const chainKey = normalizeChainSlug(agent.payment.chain);
  const bundle = chainKey ? getAdaptersBundle(chainKey) : undefined;
  if (!chainKey || !bundle) {
    logger.warn(
      {
        agentSlug: agent.slug,
        chain: agent.payment.chain,
        code: 'CHAIN_NOT_SUPPORTED',
        initialized: getInitializedChainKeys(),
      },
      `[Downstream] chain=${agent.payment.chain} not supported/initialized — skipped`,
    );
    return null;
  }

  // 4a. Fix-pack AR-profundo FIX 1(b) — gate FAIL-CLOSED de mainnet. La chain
  //     del leg la declara el AGENTE; sin este opt-in explícito por env, un
  //     agent card podía dirigir el settle (fondos del operador) a una chain de
  //     dinero real. Sin `WASIAI_DOWNSTREAM_MAINNET_ALLOW` NINGUNA mainnet
  //     settlea. NO toca el rail inbound (los slugs siguen soportados).
  if (isMainnetChainKey(chainKey) && !isDownstreamMainnetAllowed(chainKey)) {
    logger.warn(
      {
        agentSlug: agent.slug,
        chain: chainKey,
        declared: agent.payment.chain,
        code: 'MAINNET_NOT_ALLOWED',
      },
      `[Downstream] chain=${chainKey} is MAINNET and not opted-in via WASIAI_DOWNSTREAM_MAINNET_ALLOW — settle skipped`,
    );
    return null;
  }

  // 4b. WKH-234 — narrow por vmFamily. El leg Solana es settle-only (SPL
  //     transfer operator-signed): NO el dance EVM sign→verify→settle. Tiene su
  //     propia validación base58 + atómico decimals-aware. La rama EVM (pasos
  //     5-13) queda INTACTA byte-idéntica (AC-4). NEVER-throws preservado (CD-10).
  const adapterUnion = getPaymentAdapterOrUnion(chainKey);
  if (adapterUnion.vmFamily === 'solana') {
    return settleSolanaLeg(agent, adapterUnion, logger, intentId);
  }
  if (adapterUnion.vmFamily !== 'evm') {
    // Exhaustividad (CD-5): unión discriminada agotada.
    const _never: never = adapterUnion;
    return _never;
  }

  // 5. payTo validation (R-1)
  const payToCheck = validatePayTo(agent.payment.contract);
  if (!payToCheck.ok) {
    logger.warn(
      {
        agentSlug: agent.slug,
        contract: agent.payment.contract,
        code: payToCheck.code,
      },
      '[Downstream] payTo validation failed',
    );
    return null;
  }

  // 6. priceUsdc guard (non-finite / non-positive)
  if (!Number.isFinite(agent.priceUsdc) || agent.priceUsdc <= 0) {
    logger.warn(
      {
        agentSlug: agent.slug,
        code: 'INVALID_PRICE',
        priceUsdc: agent.priceUsdc,
      },
      '[Downstream] priceUsdc must be a finite positive number',
    );
    return null;
  }

  // 7. Resolve the adapter (same chainKey — CD-6). `getPaymentAdapter` could
  //    throw if the registry were uninitialized, but step 4 already validated
  //    `getAdaptersBundle(chainKey) !== undefined`.
  const adapter = getPaymentAdapter(chainKey);

  // 8. Compute the atomic value with the ADAPTER's decimals (CD-8). Kite/PYUSD
  //    is 18-dec — using a fixed 6 would sign a 10^12× wrong value.
  const primaryToken = adapter.supportedTokens[0];
  if (!primaryToken) {
    logger.warn(
      { agentSlug: agent.slug, code: 'INVALID_PRICE' },
      '[Downstream] adapter has no supported tokens',
    );
    return null;
  }
  const decimals = primaryToken.decimals;
  let value: bigint;
  try {
    value = parseUnits(String(agent.priceUsdc), decimals);
  } catch (e) {
    logger.warn(
      { agentSlug: agent.slug, code: 'INVALID_PRICE', detail: String(e) },
      '[Downstream] parseUnits failed',
    );
    return null;
  }

  // 9. Pre-flight balance check, chain-aware (DT-3). Ephemeral public client
  //    derived from the bundle chainId + the RPC env for this chain. Fail-soft
  //    when no RPC is configured (the facilitator will still settle).
  const rpc = process.env[RPC_ENV_BY_CHAIN[chainKey]];
  if (!rpc) {
    logger.info(
      {
        agentSlug: agent.slug,
        chain: chainKey,
        code: 'BALANCE_PRECHECK_SKIPPED',
      },
      `[Downstream] balance pre-check skipped (no RPC for ${chainKey})`,
    );
  } else {
    const pk = process.env.OPERATOR_PRIVATE_KEY;
    if (pk?.startsWith('0x')) {
      const operator = privateKeyToAccount(pk as `0x${string}`).address;
      const publicClient = createPublicClient({
        chain: {
          id: bundle.chainConfig.chainId,
          name: bundle.chainConfig.name,
          nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
          rpcUrls: { default: { http: [rpc] } },
        },
        transport: http(rpc),
      });
      let balance: bigint;
      try {
        balance = (await publicClient.readContract({
          address: adapter.getToken(),
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [operator],
        })) as bigint;
      } catch (e) {
        logger.warn(
          {
            agentSlug: agent.slug,
            code: 'BALANCE_READ_FAILED',
            detail: String(e),
          },
          '[Downstream] balance read RPC failed',
        );
        return null;
      }
      if (balance < value) {
        logger.warn(
          {
            agentSlug: agent.slug,
            code: 'INSUFFICIENT_BALANCE',
            balance: balance.toString(),
            required: value.toString(),
          },
          '[Downstream] insufficient balance',
        );
        return null;
      }
    }
  }

  // 10-12. Delegate sign + verify + settle to the adapter (CD-9). The whole
  //         block is wrapped to preserve NEVER-throws (CD-7): adapter.verify /
  //         adapter.settle CAN throw (e.g. Kite pieverse network error).
  try {
    // 10. Sign EIP-3009 via the adapter (per-chain EIP-712 domain).
    let signed: Awaited<ReturnType<typeof adapter.sign>>;
    try {
      signed = await adapter.sign({
        to: payToCheck.addr,
        value: value.toString(),
        // CD-1 / AR BLQ-MED-1: preserve the legacy 300s EIP-3009 window.
        timeoutSeconds: DOWNSTREAM_AUTH_WINDOW_SECONDS,
      });
    } catch (e) {
      logger.warn(
        { agentSlug: agent.slug, code: 'SIGNING_FAILED', detail: String(e) },
        '[Downstream] adapter.sign failed',
      );
      return null;
    }

    // The network for verify/settle comes from the SAME signed.paymentRequest
    // (coherence chain — CD-6 / AC-5). Fall back to adapter.getNetwork() only
    // to satisfy TS strict (network is string|undefined in the type, but the
    // adapters always populate it); both resolve to the SAME chain.
    const network = signed.paymentRequest.network ?? adapter.getNetwork();
    const proof = {
      authorization: signed.paymentRequest.authorization,
      signature: signed.paymentRequest.signature,
      network,
    };

    // 11. Verify via the adapter.
    let verifyRes: Awaited<ReturnType<typeof adapter.verify>>;
    try {
      verifyRes = await adapter.verify(proof);
    } catch (e) {
      logger.warn(
        { agentSlug: agent.slug, code: 'VERIFY_FAILED', detail: String(e) },
        '[Downstream] adapter.verify threw',
      );
      return null;
    }
    if (!verifyRes.valid) {
      logger.warn(
        {
          agentSlug: agent.slug,
          code: 'VERIFY_FAILED',
          error: verifyRes.error,
        },
        '[Downstream] adapter.verify returned valid=false',
      );
      return null;
    }

    // 12. Settle via the adapter.
    let settleRes: Awaited<ReturnType<typeof adapter.settle>>;
    try {
      settleRes = await adapter.settle(proof);
    } catch (e) {
      logger.warn(
        { agentSlug: agent.slug, code: 'SETTLE_FAILED', detail: String(e) },
        '[Downstream] adapter.settle threw',
      );
      return null;
    }
    if (!settleRes.success || !settleRes.txHash) {
      logger.warn(
        {
          agentSlug: agent.slug,
          code: 'SETTLE_FAILED',
          error: settleRes.error,
        },
        '[Downstream] adapter.settle returned success=false',
      );
      return null;
    }

    // 13. Success. blockNumber is OMITTED — SettleResult does not expose it
    //     (DT-1 opción C / TD-WKH-112-01). txHash intact.
    return {
      // Fix-pack CR-MNR-1: sin cast — `txHash` es `string` (aloja firmas base58
      // y hashes 0x). El campo ya es del tipo correcto.
      txHash: settleRes.txHash,
      settledAmount: value.toString(),
    };
  } catch (e) {
    // Defensive outer catch (CD-7): nothing in the inner blocks should reach
    // here, but if anything unexpected throws, we still return null.
    logger.warn(
      { agentSlug: agent.slug, code: 'SETTLE_FAILED', detail: String(e) },
      '[Downstream] unexpected error during sign/verify/settle',
    );
    return null;
  }
}
