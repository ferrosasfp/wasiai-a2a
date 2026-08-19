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
  /**
   * `true` cuando NO se pudo determinar el estado on-chain (RPC caído, la tx no
   * aparece en el nodo consultado, respuesta ilegible) — a diferencia de una
   * negativa DEMOSTRADA (la tx se ejecutó y falló, o acreditó de menos).
   *
   * ⚠️ Existe porque `valid: boolean` tiene dos valores y la pregunta tiene TRES:
   * está / no está / no pude preguntar. Sin este campo, todo call-site lee
   * `valid:false` y colapsa "no sé" con "no", que en un camino de dinero autoriza
   * volver a pagar algo ya pagado. Campo OPCIONAL y aditivo: los adapters que no
   * lo setean se comportan igual que siempre.
   */
  indeterminate?: boolean | undefined;
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
 *
 * ⚠️ HASTA DONDE LLEGA `absent`, DICHO SIN INFLAR (AR re-review MNR-1). NO es una
 * "prueba de ausencia" absoluta: `searchTransactionHistory` obliga al nodo a mirar su
 * almacenamiento de largo plazo — **el que ESE nodo tiene**. Un validador sin
 * `--enable-rpc-bigtable-ledger-storage`, o sin el rango de ledger correspondiente,
 * devuelve `null` igual sobre una tx que SI existe, y desde la respuesta **no hay
 * forma de distinguir** "busque en todo el historial" de "busque hasta donde tengo".
 *
 * Lo que `absent` significa de verdad: **este nodo, buscando en lo que tiene, no
 * conoce esta firma.**
 *
 * Por eso `absent` NO autoriza por si solo: el codigo exige ADEMAS la prueba de
 * expiracion del blockhash. Y la precondicion de despliegue —el endpoint tiene que
 * retener historico— se verifica en el preflight de arranque
 * (`schema-preflight.ts`), en vez de quedar como un supuesto tacito.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⛔ NO LE AGREGUES UN SEXTO ESTADO A ESTA UNION (WKH-319, CD-13).
 *
 * Esta advertencia vive ACA —y no solo en el codigo que la razona— porque ACA es
 * el lugar fisico donde alguien lo haria, y porque el compilador NO lo va a frenar.
 *
 * Los cuatro consumidores (`payment.ts`: `settleAlreadyConfirmed`,
 * `settleAlreadySigned`, `settleViaFacilitator`, `recoverConfirmedSettle`)
 * discriminan con CADENAS DE `if`, no con `switch` exhaustivo. Un estado nuevo que
 * alguien no agregue a esas cadenas cae por descarte en la cola de
 * `settleAlreadySigned`, que —tras probar la expiracion del blockhash—
 * **RE-TRANSMITE**. En Solana no hay backstop on-chain: eso es un SEGUNDO PAGO
 * REAL, en silencio, y TypeScript no dice una palabra.
 *
 * Si necesitas expresar una causa nueva de indeterminacion, NO es un estado: es un
 * `detail` de `unknown`, que ya significa exactamente "no se pudo determinar".
 * Asi resolvio WKH-319 su `terms_*` (ver `checkTerms`), en vez de agregar
 * `terms_indeterminate` aca.
 *
 * Si aun asi hace falta el estado, la cola de `settleAlreadySigned` exige
 * pertenencia EXPLICITA a `{absent, landed_failed}` y va a fallar cerrada con
 * `SETTLE_PRESENCE_UNHANDLED`. Ese guard es tu red — no lo saques para "simplificar".
 * ─────────────────────────────────────────────────────────────────────────────
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

/**
 * WKH-319 — veredicto de TERMINOS sobre una tx ya parseada.
 *
 * ⚠️ POR QUE TRES VALORES Y NO DOS. `checkTerms` devolvia
 * `{ok:true} | {ok:false; error}`, y esa union de DOS respondia una pregunta de TRES:
 * *coincide* / *no coincide* / **no pude medirlo**. Sin el tercero, toda forma de dato
 * ilegible —una lista ausente, una entrada truncada, un `amount` que no es un entero—
 * tenia que aterrizar en uno de los dos, y aterrizaba en el equivocado: con
 * `preTokenBalances` ausente el `?? []` fabricaba la lista, `delta` pasaba a ser el
 * SALDO ABSOLUTO de payTo, y una tx donde payTo GASTA se certificaba como nuestro pago.
 *
 * ⚠️ POR QUE EL DISCRIMINANTE ES `verdict: string` Y NO `ok`.
 *  1. `ok: true | false | 'unknown'` seria PEOR que la union de dos: `if (terms.ok)` da
 *     **true** para `'unknown'` — un fail-open silencioso con forma de arreglo.
 *  2. Renombrar el campo hace que **cada lectura vieja deje de compilar**. El colapso no
 *     se previene con un comentario que pida no hacerlo: se previene haciendo que no
 *     compile. Los dos call-sites tienen que ser revisitados a mano, y ese es
 *     exactamente el punto.
 *
 * `creditedAtomic` viaja SOLO en `match`: es el hecho MEDIDO, no el que pedimos. Existe
 * para que el log y (mas adelante) el recibo puedan cerrar sobre el mismo hecho — hoy el
 * recibo usa el monto que CREEMOS haber pagado (TD-319-1). String, no bigint, por la
 * convencion de la casa: los atomicos viajan como string.
 */
export type SolanaTermsVerdict =
  /** Medido: el conjunto receptor subio >= lo requerido. */
  | { verdict: 'match'; creditedAtomic: string }
  /**
   * MEDIDO y no alcanza. Exige que las dos listas esten presentes, sean interpretables
   * y esten COMPLETAS sobre el conjunto receptor. Es una negativa demostrada.
   */
  | { verdict: 'mismatch'; detail: string }
  /**
   * No se pudo medir. NO es una negativa: no autoriza condenar una fila ni
   * re-transmitir. El caller lo traduce a `SettlementPresence.unknown`.
   */
  | { verdict: 'indeterminate'; detail: string };

// ── WKH-315 — depósito Solana (bloque ADITIVO; SettlementPresence NO se toca) ──
//
// ⚠️ POR QUE NO SE REUSA `DepositVerification` (`deposit-verifier.ts`): ese tipo
// es `{ ok: boolean; reason?: ... }`, o sea un booleano con un motivo OPCIONAL.
// Con esa forma "no pude preguntarle a la cadena" no tiene dónde vivir y termina
// colapsado en `TX_NOT_FOUND` — que es una determinación NEGATIVA. En el camino
// de ENTRADA de dinero ese colapso es al revés de peligroso que en el de salida:
// afirma que un depósito no existe cuando lo único cierto es que el nodo no
// contestó. CD-3/CD-14: toda consulta externa tiene TRES respuestas.
//
// `SolanaDepositLanding` es la capa de PRESENCIA+FINALIDAD (análogo de
// `SettlementPresence`, que queda congelado para el camino de salida) y
// `SolanaDepositVerification` es el veredicto completo, ya con los términos.

/**
 * Presencia on-chain de una firma de depósito, CON su finalidad. Cinco estados
 * porque la finalidad se LEE (`confirmationStatus`), no se hereda, y su ausencia
 * es un caso real del SDK (el campo es opcional): ausente ⇒ `unknown`, NUNCA
 * "todavía no".
 */
export type SolanaDepositLanding =
  /** Aterrizó, sin error, y el nodo la reporta `finalized`. Evidencia POSITIVA. */
  | { state: 'finalized_ok' }
  /** Aterrizó y falló on-chain: nada se movió y esa firma es terminal. */
  | { state: 'landed_failed'; detail: string }
  /**
   * Aterrizó pero todavía no está `finalized` — negativa MEDIDA (el nodo dijo
   * `processed`/`confirmed`) y por lo tanto reintentable por el depositante.
   */
  | { state: 'not_finalized'; confirmationStatus: string }
  /** El nodo RESPONDIÓ, habiendo buscado el histórico, y no la conoce. */
  | { state: 'absent' }
  /** No se pudo preguntar. NUNCA acredita y NUNCA afirma ausencia. */
  | { state: 'unknown'; detail: string };

/** Motivos de rechazo de un depósito Solana. El mapeo a HTTP vive en la ruta. */
export type SolanaDepositReason =
  | 'TX_ABSENT'
  | 'TX_FAILED'
  | 'DEPOSIT_NOT_FINALIZED'
  | 'MINT_MISMATCH'
  | 'RECIPIENT_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'DEPOSITOR_AMBIGUOUS'
  | 'DEPOSIT_ACCOUNT_NOT_CONFIGURED'
  | 'DEPOSIT_VERIFICATION_UNKNOWN';

/**
 * Veredicto del verificador de depósito Solana — unión DISCRIMINADA por `ok`.
 * En la rama `ok: true` los campos son OBLIGATORIOS (no opcionales): el monto
 * acreditado es siempre el de la cadena y el depositante siempre existe, así que
 * el call-site no puede olvidarse de chequearlos.
 */
export type SolanaDepositVerification =
  | {
      ok: true;
      amountAtomic: bigint;
      amountUsd: string;
      depositor: string;
      ata: string;
      mint: string;
      signature: string;
    }
  | { ok: false; reason: SolanaDepositReason; detail?: string };

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

// ── WKH-314 — x402 INBOUND Solana (bloque ADITIVO; SettlementPresence NO se toca) ──
//
// ⚠️ POR QUE NO SE REUSA `SettlementPresence` (§5 · DT-C2 del Story File): su
// `landed_ok` **no implica `finalized`**. Sale de un probe que lee a `'confirmed'` y
// que DESCARTA `confirmationStatus` (sólo mira `status.err`). Para el camino de
// SALIDA eso está bien y queda congelado. Para dinero que ENTRA es el mismo agujero
// que WKH-315 midió y cerró: una tx `confirmed` que la cadena todavía puede descartar
// concedería el servicio. Acá la finalidad es una PRECONDICION del grant, así que
// tiene que ser un estado del tipo y no un campo que se puede olvidar de mirar.
//
// ⚠️ Y POR QUE NO SE REUSA `SolanaDepositLanding` (WKH-315): ese tipo responde
// *"¿aterrizó y finalizó?"* y NADA sobre los términos, porque un depósito **descubre**
// el monto en vez de exigirlo. Un cobro sí lo exige: el challenge dice cuánto, a quién
// y en qué mint ANTES de que el pagador firme. Por eso acá presencia y términos viven
// en el MISMO tipo (`finalized_ok` ya trae `creditedAtomic`, y `terms_mismatch` es un
// estado propio): un `finalized_ok` que no cumpla los términos no se puede construir.

/**
 * Presencia + finalidad + términos de la firma que el PAGADOR presenta.
 *
 * Seis estados, y la exhaustividad la fuerza el compilador en el combinador y en el
 * handler. Ninguno que no sea `finalized_ok` concede acceso.
 */
export type SolanaInboundPresence =
  /** Aterrizó, sin error, `finalized`, y CUMPLE los términos. Único grant. */
  | { state: 'finalized_ok'; creditedAtomic: string }
  /** Aterrizó y falló on-chain: nada se movió. Terminal, NO se consume la prueba. */
  | { state: 'landed_failed'; detail: string }
  /** Aterrizó, `processed`/`confirmed`, todavía no `finalized`. Negativa MEDIDA y REINTENTABLE. */
  | { state: 'not_finalized'; confirmationStatus: string }
  /** Aterrizó y finalizó, pero los términos NO cumplen (monto/mint/destino). Fail-closed. */
  | { state: 'terms_mismatch'; detail: string }
  /** El nodo RESPONDIÓ, buscando en el histórico, y no la conoce. Prueba de ausencia. */
  | { state: 'absent' }
  /** No se pudo preguntar. NUNCA autoriza conceder. */
  | { state: 'unknown'; detail: string };

/**
 * El binding de la prueba con ESTE challenge: la `reference` tiene que aparecer como
 * cuenta de la transacción y el `blockTime` tiene que caer dentro de la ventana.
 *
 * ⚠️ `unknown` NO es "la referencia no está". Una tx v0 cuyas direcciones cargadas no
 * se pueden resolver deja la pregunta SIN RESPUESTA, y responderla en negativo sería
 * rechazar un pago real por no poder leerlo.
 */
export type SolanaInboundBinding =
  /** La referencia está entre las cuentas y el `blockTime` cae en la ventana. */
  | { state: 'bound'; blockTime: number }
  /** MEDIDO: las cuentas se pudieron enumerar por completo y la referencia no está. */
  | { state: 'reference_absent'; detail: string }
  /** MEDIDO: la tx aterrizó fuera de `[issuedAt, expiresAt]`. */
  | { state: 'outside_window'; detail: string }
  /** No se pudo determinar (tx v0 sin direcciones resolubles, campo ausente, throw). */
  | { state: 'unknown'; detail: string };

/**
 * La tupla que el 402 publica. `issuedAt`/`expiresAt` son ABSOLUTOS (unix segundos) y
 * están DENTRO del MAC: la expiración no se lee nunca del campo suelto que manda el
 * cliente.
 */
export interface SolanaInboundChallenge {
  /** CAIP-2 (`solana:<genesis>`). */
  readonly network: string;
  readonly mint: string;
  /** Unidades ATOMICAS del mint, como string (WKH-196: nunca un number). */
  readonly maxAmountRequired: string;
  readonly payTo: string;
  /** base58 de 32 bytes — o sea una clave pública válida, usable como cuenta. */
  readonly reference: string;
  readonly resource: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/**
 * Resultado de persistir el veredicto de la cadena (P6). NUNCA un boolean: un `false`
 * colapsaría "ya se cobró" con "el store no contestó", que tienen remedios opuestos.
 */
export type InboundObserveResult =
  | { outcome: 'observed'; attempts: number }
  /** La fila ya está `consumed`: a esta firma ya se le sirvió. */
  | { outcome: 'replay' }
  /** La misma firma contra otro destino/monto/mint/referencia/recurso: NO es este pago. */
  | { outcome: 'terms_conflict'; detail: string }
  /** No se pudo saber. NUNCA concede. */
  | { outcome: 'store_unavailable'; detail: string };

/** Resultado del cobro (P7). `consumed` es lo ÚNICO que autoriza servir. */
export type InboundConsumeResult =
  | { outcome: 'consumed' }
  | { outcome: 'replay' }
  | { outcome: 'terms_conflict'; detail: string }
  | { outcome: 'store_unavailable'; detail: string };

/** Los términos con los que una prueba quedó registrada. */
export interface InboundProofTerms {
  readonly reference: string;
  readonly resource: string;
  readonly payTo: string;
  readonly amountAtomic: string;
  readonly mint: string;
}

/**
 * Peek de idempotencia (P3). **NO autoriza ni impide**: informa. Su valor es evitar
 * gastar la cadena dos veces por el mismo pago (DT-12) y cortar un replay sin tocar el
 * RPC.
 */
export type InboundPeekResult =
  | { state: 'none' }
  /** Ya hay veredicto de la cadena para esta firma: P4 y P5 se saltan. */
  | { state: 'observed'; terms: InboundProofTerms }
  | { state: 'consumed' }
  /** No se pudo preguntar. NUNCA concede, y tampoco afirma que la prueba sea nueva. */
  | { state: 'unknown'; detail: string };
