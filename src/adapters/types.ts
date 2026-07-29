import type {
  GaslessFundingState,
  GaslessSupportedToken,
  X402PaymentRequest,
} from '../types/index.js';
export interface TokenSpec {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
}
export interface SettleRequest {
  authorization: X402PaymentRequest['authorization'];
  signature: string;
  network: string;
  paymentRequirements?: { payTo: string; maxAmountRequired: string };
}
export interface SettleResult {
  txHash: string;
  success: boolean;
  error?: string | undefined;
}
export interface X402Proof {
  authorization: X402PaymentRequest['authorization'];
  signature: string;
  network: string;
  paymentRequirements?: { payTo: string; maxAmountRequired: string };
}
export interface VerifyResult {
  valid: boolean;
  error?: string | undefined;
}
export interface QuoteResult {
  amountWei: string;
  token: TokenSpec;
  facilitatorUrl: string;
}
export interface SignRequest {
  to: `0x${string}`;
  value: string;
  timeoutSeconds?: number;
}
export interface SignResult {
  xPaymentHeader: string;
  paymentRequest: X402PaymentRequest;
}
export interface AttestEvent {
  type: string;
  payload: Record<string, unknown>;
}
export interface AttestRef {
  txHash: string;
}
export interface GaslessTransferAdapterRequest {
  to: `0x${string}`;
  value: bigint;
}
export interface GaslessAdapterResult {
  txHash: `0x${string}`;
}
export interface GaslessAdapterStatus {
  enabled: boolean;
  network: string;
  supportedToken: GaslessSupportedToken | null;
  operatorAddress: `0x${string}` | null;
  funding_state: GaslessFundingState;
  chain_id?: number;
  relayer?: string;
  documentation?: string;
}
export interface BindResult {
  success: boolean;
  txHash?: string;
  error?: string;
}
export interface BindVerification {
  bound: boolean;
  chainAddress?: string;
  verifiedAt?: string;
}
// ── Superficie COMÚN, VM-agnóstica (lo que el wiring puede leer SIN narrowing) ──
export interface PaymentAdapterCommon {
  readonly name: string;
  quote(amountUsd: number): Promise<QuoteResult>;
  getScheme(): string;
  getNetwork(): string;
  getMaxTimeoutSeconds(): number;
  getMerchantName(): string;
}

// ── EVM (cuerpo actual de PaymentAdapter, INTACTO + discriminante) ──
export interface EvmPaymentAdapter extends PaymentAdapterCommon {
  readonly vmFamily: 'evm'; // ← ÚNICO campo nuevo
  readonly chainId: number;
  readonly supportedTokens: TokenSpec[]; // TokenSpec.address: `0x${string}` (INTACTO)
  settle(req: SettleRequest): Promise<SettleResult>;
  verify(proof: X402Proof): Promise<VerifyResult>;
  sign(opts: SignRequest): Promise<SignResult>;
  getToken(): `0x${string}`;
}

// ── Solana (superficie honesta; NADA de 0x / EIP-3009) ──
export interface SolanaTokenSpec {
  symbol: string;
  mint: string; // base58 SPL mint
  decimals: number; // MISMO nombre que TokenSpec.decimals → lectura genérica de decimals homogénea
}
export interface SolanaSettleRequest {
  payTo: string; // base58 owner pubkey del agente (payout_wallet)
  amountAtomic: string; // unidades atómicas del mint (decimals-aware)
  intentId: string; // clave de idempotencia (AC-7) — leg/step id determinístico
}
export interface SolanaSettleProof {
  signature: string; // firma/txid base58 del SPL-transfer
  payTo: string;
  amountAtomic: string;
}
/**
 * WKH-307 (AR BLQ-MEDIO-1) — PRESENCIA ON-CHAIN de una firma ya transmitida.
 *
 * ⚠️ POR QUE ESTE TIPO EXISTE, Y POR QUE TIENE CINCO ESTADOS Y NO DOS.
 *
 * Este es el veredicto del que cuelga la decision de RE-TRANSMITIR un SPL transfer.
 * En Solana no hay backstop on-chain: si se re-transmite algo que ya aterrizo, el
 * agente cobra dos veces y no hay forma de deshacerlo.
 *
 * El error que este tipo hace IMPOSIBLE: tratar un `null` de RPC como prueba de
 * ausencia. Un `getParsedTransaction` que devuelve `null` puede significar
 * "no existe", pero tambien "este nodo no tiene ese historico", "este nodo va
 * atrasado" o "el indice esta degradado". Con un `boolean` (o un `T | null`) los
 * cuatro colapsan en el mismo `false`, y el call-site no puede distinguir
 * *"probado que no aterrizo"* de *"no pude preguntar"* — que en un camino de dinero
 * son OPUESTOS: el primero autoriza re-pagar, el segundo obliga a fail-closear.
 *
 * REGLA GENERAL (vale para cualquier consulta a un sistema externo): toda pregunta
 * tiene TRES respuestas, no dos — **esta / no esta / no pude preguntar**. Si el tipo
 * no tiene el tercero, el tercero ya se perdio en el diseño y todo call-site aguas
 * abajo lo va a colapsar mal.
 *
 * La determinacion NEGATIVA (`absent`) exige que el nodo haya RESPONDIDO habiendo
 * buscado en el historico (`getSignatureStatuses` con `searchTransactionHistory`),
 * no la ausencia de un parseo.
 */
export type SettlementPresence =
  /** Aterrizo y cumple los terminos (monto/mint/destino). NO re-transmitir. */
  | { state: 'landed_ok' }
  /**
   * Aterrizo y FALLO on-chain. La transferencia NO ocurrio y esa firma es terminal
   * (una tx fallida ya esta grabada: nunca puede volver a ejecutarse), asi que
   * re-pagar con una firma nueva es correcto.
   */
  | { state: 'landed_failed'; detail: string }
  /**
   * Aterrizo pero NO cumple los terminos. Algo se movio con esa firma: re-pagar
   * seria pagar dos veces por cosas distintas. Fail-closed, requiere mirada humana.
   */
  | { state: 'landed_mismatch'; detail: string }
  /** El nodo RESPONDIO, buscando en el historico, y no la conoce. Prueba de ausencia. */
  | { state: 'absent' }
  /** No se pudo preguntar. NUNCA autoriza re-transmitir. */
  | { state: 'unknown'; detail: string };

/**
 * WKH-307 — resultado del peek de idempotencia.
 *
 * ⚠️ POR QUE UNA UNION Y NO `string | undefined`: el retorno anterior COLAPSABA
 * *"no se pago"* con *"no se si se pago"*, que en un camino de dinero son OPUESTOS.
 * El primero autoriza a cortar por fondos insuficientes; el segundo obliga a
 * fail-closear y a decir POR QUE. Con la union el caller distingue y loguea distinto.
 *
 * `unknown` es el traductor del fallo: el peek NUNCA lanza, un store mudo llega aca.
 */
export type SettledPeek =
  /** No hay reclamo para este intent. */
  | { state: 'none' }
  /** Confirmado y con firma: ya se pago. */
  | { state: 'settled'; signature: string }
  /** Reclamado por alguien (o firmado) pero sin confirmar. */
  | { state: 'in_progress' }
  /** El store no respondio. NO significa "no se pago". */
  | { state: 'unknown' };

export interface SolanaPaymentAdapter extends PaymentAdapterCommon {
  readonly vmFamily: 'solana';
  readonly caip2ChainId: string; // DT-1: `solana:<genesis-prefix>` (NO chainId:number)
  readonly supportedTokens: SolanaTokenSpec[];
  settle(req: SolanaSettleRequest): Promise<SettleResult>; // build+sign+broadcast+confirm, idempotente (AC-7)
  verify(proof: SolanaSettleProof): Promise<VerifyResult>; // getSignatureStatus/getParsedTransaction (verify-before-trust)
  getMint(): string; // base58 (análogo VM-agnóstico de getToken)
  /**
   * Balance SPL del operador (unidades atómicas del mint, como string) —
   * análogo VM-agnóstico del `balanceOf` que la rama EVM lee con viem para su
   * pre-flight de balance (CR-2 de WKH-234). Lectura pura del RPC: NO importa
   * services ni DB (CD-7). LANZA cuando la lectura no se puede hacer (RPC
   * caído, ATA del operador inexistente); el caller decide cómo degradar.
   */
  getOperatorSplBalance(): Promise<string>;
  /**
   * Fix-pack AR-profundo FIX 2 — peek SINCRÓNICO del seam de idempotencia:
   * devuelve la firma ya confirmada para `intentId`, o `undefined` si el intent
   * nunca se settleó.
   *
   * Existe porque el pre-flight de balance del operador vive en el CALLER
   * (`downstream-payment.settleSolanaLeg`, para poder devolver el skip-code
   * `INSUFFICIENT_BALANCE` distinguible) mientras el registro de idempotencia
   * vive DENTRO del adapter. Sin este peek, el pre-check cortaba ANTES de
   * `settle()` y el hit idempotente era inalcanzable justamente cuando el
   * balance ya había bajado por haber pagado ese mismo leg ⇒ un leg PAGADO se
   * reportaba como no pagado (sin recibo ni `settle_signature`).
   *
   * WKH-307: pasa a ASINCRONO (el registro dejo de ser un `Map` de proceso y paso a
   * una tabla) y a UNION DISCRIMINADA. NUNCA lanza y NUNCA es autoritativa sobre el
   * pago — la validacion verify-before-trust sigue siendo responsabilidad de
   * `settle()`.
   */
  getSettledSignature(intentId: string): Promise<SettledPeek>;
}

export type PaymentAdapter = EvmPaymentAdapter | SolanaPaymentAdapter;
export interface AttestationAdapter {
  readonly name: string;
  readonly chainId: number;
  attest(event: AttestEvent): Promise<{ txHash: string; proofUrl: string }>;
  verify(ref: AttestRef): Promise<boolean>;
}
export interface GaslessAdapter {
  readonly name: string;
  readonly chainId: number;
  transfer(req: GaslessTransferAdapterRequest): Promise<GaslessAdapterResult>;
  status(): Promise<GaslessAdapterStatus>;
}
export interface IdentityBindingAdapter {
  readonly name: string;
  readonly chainId: number;
  bind(
    keyId: string,
    chainAddress: string,
    sig: `0x${string}`,
  ): Promise<BindResult>;
  verify(keyId: string): Promise<BindVerification>;
}

/**
 * Multi-chain registry (WKH-MULTICHAIN / 086).
 *
 * `ChainKey` is the canonical slug identifier for a chain bundle. Immutable —
 * adding a new chain requires extending this union AND updating the registry
 * factory dispatcher in `registry.ts`.
 *
 * ⚠️ SECURITY INVARIANT (WKH-150 / WKH-144): every MAINNET slug MUST end in the
 * literal suffix `-mainnet`, and every testnet slug MUST NOT. `isMainnetChainKey()`
 * (canonical home: `chain-resolver.ts`; `settle-verifier.ts` re-exports it)
 * classifies mainnet purely via `.endsWith('-mainnet')`. If a new mainnet chain is
 * added here WITHOUT the `-mainnet` suffix, it is silently treated as testnet.
 *
 * INVENTARIO DE CONSECUENCIAS — agregar una chain toca TODOS estos lugares
 * (actualizado en el fix-pack AR-profundo it2, MNR-3):
 *  1. `registry.ts` `buildBundle` — la factory del bundle (sin esto: throw
 *     `Unsupported chain`).
 *  2. `chain-resolver.ts` `CHAIN_VM_FAMILY`, `CHAIN_NAMESPACE` y
 *     `CANONICAL_CHAIN_ID` — `Record<ChainKey, …>` EXHAUSTIVOS: no clasificar la
 *     chain nueva NO COMPILA (fail-loud en build, no en runtime con dinero).
 *     `CANONICAL_CHAIN_ID` además exige que su chainId esté en `KnownEvmChainId`
 *     ⇒ clasificado mainnet/testnet en `EVM_CHAIN_ENVIRONMENT`.
 *  3. `settle-verifier.ts` (WKH-144) — gate fail-CLOSED del settle re-verify: una
 *     mainnet se BLOQUEA cuando a2a no puede re-leer la tx; una testnet falla
 *     OPEN. Clasificación por slug ⇒ un slug mal nombrado = fail-OPEN con dinero
 *     real. Guardado por un test que cruza cada `ChainKey` contra el boolean
 *     independiente `Chain.testnet` de viem.
 *  4. `downstream-payment.ts` (fix-pack AR-profundo) — CONSUMIDOR DE DINERO: gate
 *     de opt-in `WASIAI_DOWNSTREAM_MAINNET_ALLOW` del leg downstream (fondos del
 *     operador). Desde it2 clasifica por el DESTINO REAL del leg
 *     (`classifyDestinationEnvironment`), no por el string del slug.
 *  5. `registry.ts` `assertNoSlugDestinationDrift` (vía `checkChainEnvironmentCoherence`) — fail-loud al arrancar si el
 *     destino real del bundle contradice el mainnet-ness del slug (el caso
 *     `KITE_NETWORK=mainnet` + slug `kite-ozone-testnet`).
 *  6. `RPC_ENV_BY_CHAIN` (`downstream-payment.ts`) — `Record<ChainKey, string>`
 *     exhaustivo del env-var name del RPC.
 *  7. `payment-spec-reader.ts` `resolveAvalancheOutputChain` (línea del
 *     `isMainnetChainKey(chainKey)`) — el ÚNICO consumidor del invariante cuyo
 *     resultado SALE POR HTTP: define el `payment.chain` que `/discover` publica
 *     para el agente (lo consumen wasiai-v2 / Chaski / los remit-*). Es el que
 *     produjo BLQ-MED-1: al colapsar los alias mainnet a `'avalanche'` dejaba el
 *     gate de opt-in del leg SIN ninguna entrada posible (control inejercitable).
 *     Una chain nueva con namespace `avalanche` DEBE revisarse acá. (Faltaba en
 *     este inventario — agregado en it2 MNR-5.)
 */
export type ChainKey =
  | 'kite-ozone-testnet'
  | 'kite-mainnet'
  | 'avalanche-fuji'
  | 'avalanche-mainnet'
  | 'base-sepolia'
  | 'base-mainnet'
  | 'tempo-testnet' // WKH-090 — cuarto rail (testnet-only, CD-2 → sin mainnet)
  | 'solana-devnet'; // WKH-234 — rail Solana (devnet-only, CD-4 → SIN sufijo -mainnet)

/**
 * `AdaptersBundle` groups all chain-specific adapter instances + chain config
 * for a single chain. Stored in `Map<ChainKey, AdaptersBundle>` inside the
 * registry. Treat as immutable from call-sites (CD-18).
 */
export interface AdaptersBundle {
  payment: PaymentAdapter;
  attestation: AttestationAdapter;
  gasless: GaslessAdapter;
  identity: IdentityBindingAdapter | null;
  chainConfig: {
    name: string;
    chainId: number;
    explorerUrl: string;
  };
}
