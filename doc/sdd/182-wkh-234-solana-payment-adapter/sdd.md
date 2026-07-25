# SDD — [WKH-234] PaymentAdapter Solana en el gateway (payTo base58 + settle SPL on-chain)

> Fase: F2 (Solution Design Document) · SDD_MODE: full · Sizing: L
> Branch: `feat/182-wkh-234-solana-payment-adapter`
> Estructura: **UN SOLO SDD** que cubre B1+B2+B3 en **6 waves secuenciales** (W0–W5), ejecutables por un solo dev en un solo branch. NO se decompone en sub-HUs Jira (corrida autónoma — decisión del orquestador).
> Input: `work-item.md` (10 ACs EARS, 13 archivos Scope IN, 7 DT, 7 CD) + `project-context.md` + resoluciones del orquestador a los 6 `[NEEDS CLARIFICATION]`.

---

## 0. Resumen de la solución

El gateway `wasiai-a2a` es hoy 100% EVM-shaped en la capa de dinero: `ChainKey` (unión literal de 7 slugs EVM), `PaymentAdapter` (`chainId:number`, `getToken():0x…`, `sign({to:0x…})`, EIP-3009), el resolver de slugs, el validador de wallet (`ADDRESS_RE = /^0x…{40}$/`) y el settle per-leg (`downstream-payment.ts` + `compose.ts`). El **discovery ya es chain-agnóstico** (WKH-113): basta registrar el slug Solana en el resolver para que un agente Solana-native pase el filtro.

Esta HU construye el **rail de pago Solana devnet** para el **fee del agente**: un `AdaptersBundle` Solana nuevo (`src/adapters/solana/`) cuyo `PaymentAdapter` firma+broadcast+confirma+verifica un **SPL-token transfer real** con `@solana/web3.js` v1 + `@solana/spl-token`, firmado por la **keypair del OPERADOR del gateway** (custodial de ese lado, espejo exacto del path EVM — resolución del orquestador al Blocker #1). El principal de la remesa en Solana (escrow/facilitator) es Scope OUT (HELD en otro repo).

**Decisión de tipos central (Blocker #4, resuelto en este SDD):** se generaliza `PaymentAdapter` a una **unión discriminada por `vmFamily: 'evm' | 'solana'`**. La interfaz EVM actual se preserva verbatim como `EvmPaymentAdapter` (+1 campo discriminante literal); nace `SolanaPaymentAdapter` con su superficie honesta (base58/SPL, sin `0x`/EIP-3009). El wiring (`downstream-payment.ts`, `compose.ts`) narrowa por `vmFamily` con un `else` exhaustivo `never` (CD-5 extendido más allá de los switches sobre `ChainKey`). Los 4 adapters EVM (kite / avalanche / base / tempo) quedan **byte-idénticos en runtime** (§9 blast-radius).

---

## 1. Context Map — archivos leídos y patrón extraído

| Archivo leído | Por qué | Patrón / hecho extraído |
|---|---|---|
| `src/adapters/types.ts:1-159` | Contrato central a generalizar | `PaymentAdapter` (`:80-93`) EVM-shaped; `SettleRequest`/`X402Proof`/`SignRequest`/`TokenSpec` 0x-typed; `ChainKey` unión de 7 slugs (`:135-142`) con invariante `-mainnet` (`:124-134`); `AdaptersBundle.chainConfig.chainId:number` (`:149-159`). |
| `src/adapters/avalanche/index.ts` | Exemplar canónico de factory de bundle | `create*Adapters(opts:{network})` async, `await import()` lazy de payment/attestation/gasless, retorna `AdaptersBundle` con `identity:null`. Espejo exacto para `createSolanaAdapters`. |
| `src/adapters/avalanche/payment.ts:1-495` | Exemplar de `PaymentAdapter` real | `implements PaymentAdapter`; env-driven (mint/RPC/facilitator con fallback y warn-once); `OPERATOR_PRIVATE_KEY` como firmante; `parseUnits(usd.toFixed(dec),dec)` para monto atómico; `_resetWalletClient()` test-only. |
| `src/adapters/avalanche/chain.ts` · `attestation.ts` · `identity.ts` | Exemplars de piezas menores del bundle | `chain.ts` resuelve network (opts > env > default); `attestation.ts` = stub que loguea `warn` y retorna `{txHash:'0x0'}`; `identity.ts` = `export const … = null`. |
| `src/adapters/registry.ts:1-271` | Dispatcher factory + flag-gate | `SUPPORTED_CHAINS satisfies readonly ChainKey[]`; `isTempoEnabled()`/`getSupportedChains()` = patrón flag-gate byte-idéntico con OFF; `buildBundle()` if-chain con `throw` final; `getPaymentAdapter(chainKey?)`. Modelo directo para el gate Solana + branch Solana. |
| `src/adapters/chain-resolver.ts:1-96` | Resolver puro namespace | `SLUG_ALIASES` con proto `null` (CD-19 anti-prototype-pollution); `normalizeChainSlug` total, nunca default silencioso. B2 = añadir entradas. |
| `src/adapters/deposit-verifier.ts:66-193` | **Switches exhaustivos sobre `ChainKey`** (CD-5) | `resolveChainFamilyEnvSuffix` (`:68`, SIN default → rompe tsc), `resolveRpcUrl` (`:128`), `resolveRpcFallbackEnv` (`:153`), `resolveChainObject` (`:177`, retorna viem `Chain`). Los 4 rompen la compilación al extender `ChainKey`. |
| `src/lib/price.ts:203-219` | Switch sobre `ChainKey` CON default | `estimateGaslessValueUsd` tiene `default: +Infinity` (fail-closed) → NO rompe tsc; Solana cae al fail-closed correcto. |
| `src/lib/wallet-format.ts:1-30` | ÚNICA fuente de verdad EVM (CD-1/CD-2) | Módulo leaf sin imports; `ADDRESS_RE`/`isValidWallet`. B1 añade validador base58 **puro** (no puede importar web3.js — CD-7). |
| `src/lib/downstream-payment.ts:1-360` | Settle per-leg downstream (AC-3) | Resuelve `chainKey = normalizeChainSlug(agent.payment.chain)` → `getAdaptersBundle` fail-loud `CHAIN_NOT_SUPPORTED`; `validatePayTo` (0x-regex); `RPC_ENV_BY_CHAIN: Record<ChainKey,string>` (`:46`, rompe tsc); delega sign→verify→settle; NEVER-throws (retorna null+skip-code). Espejo para la rama Solana (W4). |
| `src/services/compose.ts:790-1006` | Settle **inbound** per-leg (AC-2/AC-7) | `getPaymentAdapter().settle({authorization,signature,network})` (default-chain, EVM); re-verify on-chain `verifyDefaultChainSettle` (TB-01, verify-before-trust); luego `signAndSettleDownstream`. La rama inbound es 100% `0x`-shaped → narrowing Solana en W4. |
| `src/services/agent.ts:155-213,300-362,486-509` | Publish guard (AC-1/AC-5) | `assertValidPayoutWallet(input.payoutWallet)` (`:330`, `:487`) usa `isValidWallet` EVM. `PublishAgentInput` **NO tiene campo `chain`** → B1 añade `payoutChain?` para dar contexto de familia al guard. |
| `src/types/index.ts:88-98,118-140` | `AgentPaymentSpec` + `PublishAgentInput` | `AgentPaymentSpec.contract: 0x${string}` (`:96`) → namespace-aware. `PublishAgentInput` sin `chain`/`payoutChain`. |
| `src/services/budget.ts:44-102,277-330` | Ledger + ownership guard (AC-8/AC-9) | `debit(keyId, chainId:number, amountUsd, …, ownerRef:string)`; `.eq('id',keyId).eq('owner_ref',ownerId)` (CD-1); RPC `debit_with_dest_policy(p_owner_ref)`. `ownerRef` ya es REQUERIDO. |
| `src/adapters/settle-verifier.ts:190-221` | Invariante `-mainnet` | `isMainnetChainKey = chainKey.endsWith('-mainnet')`; `solana-devnet` → testnet → fail-OPEN (correcto para devnet). Sin cambios. |
| `src/adapters/settle-verifier.test.ts:516-525` | Guard test del invariante `-mainnet` | `CHAIN_KEY_TO_VIEM: Record<ChainKey, Chain>` EXHAUSTIVO → rompe tsc al extender `ChainKey`. Único test EVM que debe tocarse (excluir Solana; §9). |
| `doc/sdd/178.../auto-blindaje.md` · `B1a.../auto-blindaje.md` | Auto-Blindaje histórico | Errores recurrentes: mocks `vi.fn` aridad-fija + spread (TS2556, ≥3 HUs); `noUncheckedIndexedAccess` destructuring de `mock.calls[N]` (TS2488); `Edit replace_all` no cubre distinta indentación. → CD-11/CD-12/CD-13. |

---

## 2. Diseño de tipos — unión discriminada por `vmFamily` (resuelve Blocker #4 / DT-4)

### 2.1 Principio

Un `class` de TS **no puede `implements` una unión** ("A class can only implement an object type…"). Por eso NO se puede simplemente convertir `PaymentAdapter` en unión y dejar a los 4 adapters EVM `implements PaymentAdapter`. La forma correcta:

1. La interfaz EVM actual se **preserva verbatim** y se renombra a `EvmPaymentAdapter`, añadiendo **un solo campo discriminante literal** `readonly vmFamily: 'evm'`.
2. Nace `SolanaPaymentAdapter` con `readonly vmFamily: 'solana'` y su superficie honesta (base58/SPL).
3. `type PaymentAdapter = EvmPaymentAdapter | SolanaPaymentAdapter`.
4. Los 4 adapters EVM cambian `implements PaymentAdapter` → `implements EvmPaymentAdapter` y añaden `readonly vmFamily = 'evm' as const` (1 token + 1 línea c/u; runtime byte-idéntico — §9).

### 2.2 Forma concreta (a materializar en `src/adapters/types.ts`, W0/W1)

```ts
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
  readonly vmFamily: 'evm';                 // ← ÚNICO campo nuevo
  readonly chainId: number;
  readonly supportedTokens: TokenSpec[];    // TokenSpec.address: `0x${string}` (INTACTO)
  settle(req: SettleRequest): Promise<SettleResult>;
  verify(proof: X402Proof): Promise<VerifyResult>;
  sign(opts: SignRequest): Promise<SignResult>;
  getToken(): `0x${string}`;
}

// ── Solana (superficie honesta; NADA de 0x / EIP-3009) ──
export interface SolanaTokenSpec {
  symbol: string;
  mint: string;        // base58 SPL mint
  decimals: number;    // MISMO nombre que TokenSpec.decimals → lectura genérica de decimals homogénea
}
export interface SolanaSettleRequest {
  payTo: string;             // base58 owner pubkey del agente (payout_wallet)
  amountAtomic: string;      // unidades atómicas del mint (decimals-aware)
  intentId: string;          // clave de idempotencia (AC-7) — leg/step id determinístico
}
export interface SolanaSettleProof {
  signature: string;         // firma/txid base58 del SPL-transfer
  payTo: string;
  amountAtomic: string;
}
export interface SolanaPaymentAdapter extends PaymentAdapterCommon {
  readonly vmFamily: 'solana';
  readonly caip2ChainId: string;              // DT-1: `solana:<genesis-prefix>` (NO chainId:number)
  readonly supportedTokens: SolanaTokenSpec[];
  settle(req: SolanaSettleRequest): Promise<SettleResult>;   // build+sign+broadcast+confirm, idempotente (AC-7)
  verify(proof: SolanaSettleProof): Promise<VerifyResult>;   // getSignatureStatus/getParsedTransaction (verify-before-trust)
  getMint(): string;                          // base58 (análogo VM-agnóstico de getToken)
}

export type PaymentAdapter = EvmPaymentAdapter | SolanaPaymentAdapter;
```

`SettleResult` / `VerifyResult` / `QuoteResult` se **reutilizan tal cual** (son VM-agnósticos: `{txHash, success, error}`, `{valid, error}`, `{amountWei, token, facilitatorUrl}`). Para Solana `SettleResult.txHash` = la firma base58 (el nombre `txHash` se conserva; es un string opaco).

### 2.3 Por qué la unión discriminada y no un wrapper con placeholder

- **Sin `any`, sin `as unknown`** (project-context regla 8): cada familia expone SOLO métodos que puede honrar. Un Solana adapter NUNCA finge `getToken():0x…`.
- **Exhaustividad forzada por el compilador**: al narrowar por `vmFamily` en el wiring, un `else { const _x: never = adapter }` obliga a cubrir toda familia futura (CD-5 extendido). Añadir una tercera VM sin actualizar el wiring = error de tsc.
- **Blast-radius mínimo y no-conductual** en los adapters EVM (§9).

### 2.4 `AdaptersBundle` — decisión sobre `chainConfig.chainId:number` (DT-8, nueva)

`AdaptersBundle.chainConfig.chainId` es estructuralmente `number` y lo consumen `getChainConfig`/`downstream-payment.ts:243` (build de un `publicClient` viem — **solo en la rama EVM**). Solana no tiene chainId numérico. Para **NO** ensanchar el tipo (evita blast-radius sobre todos los consumidores de `getChainConfig`), el bundle Solana rellena el slot con un **sentinel numérico no-EVM, env-driven** (`SOLANA_SYNTHETIC_CHAIN_ID`, default documentado fuera del espacio EVM), y el **id autoritativo real** es el CAIP-2 (`payment.caip2ChainId`, usado para el ledger AC-8). El sentinel NUNCA se usa para construir un cliente viem (la rama Solana del wiring no toca `:243`). Ratificado como DT-8.

---

## 3. Decisiones técnicas (DT-N)

Heredadas del work-item (DT-1..DT-5) + ratificaciones del orquestador + nuevas de F2 (DT-6..DT-10).

- **DT-1 (namespace CAIP)** — RATIFICADA. CAIP-10 (`solana:<genesis-prefix>:<base58>`) para cuentas cuando se requiera namespace explícito; **CAIP-2 (`solana:<cluster-id>`) para el chain-id del ledger** (AC-8). No se reusa `chainId:number` EVM.
- **DT-2 (SDK)** — RATIFICADA. `@solana/web3.js` v1 + `@solana/spl-token`, encapsulados **exclusivamente** en `src/adapters/solana/*` (CD-7). Nunca importados desde `src/services/` ni `src/routes/`.
- **DT-3 (settle-verify: OPERADOR firma)** — **RATIFICADA por el orquestador (Blocker #1 RESUELTO)**. El `SolanaPaymentAdapter.settle()` construye+firma+broadcast+confirma el SPL-transfer con `SOLANA_OPERATOR_PRIVATE_KEY` (custodial de ese lado, espejo exacto del path EVM donde Avalanche/Base firman con `OPERATOR_PRIVATE_KEY`). El caller **no posee wallet Solana** en este flujo. El no-custodial del PRINCIPAL de la remesa es Scope OUT (HELD). `verify()` re-lee la confirmación on-chain (`getSignatureStatus` + `getParsedTransaction`) contra amount+destination esperados (verify-before-trust, mismo principio que `settle-verifier.ts`).
- **DT-4 (forma de generalizar `PaymentAdapter`)** — **RESUELTA en §2**: unión discriminada por `vmFamily`. Reemplaza el "diferido a Architect".
- **DT-5 (attestation/identity stubs)** — RATIFICADA. `src/adapters/solana/attestation.ts` = stub que lanza `NOT_IMPLEMENTED` (explícito, no no-op silencioso); `identity: null`; `gasless` = stub `enabled:false`.
- **DT-6 (funding/deposit Solana = Scope OUT)** — RATIFICADA por el orquestador (Blocker #2/#3 del work-item). El budget del caller se sigue fondeando en EVM. Esta HU es **settle-only**. Consecuencia de diseño: los switches EVM del `deposit-verifier.ts` reciben `case 'solana-devnet'` **solo para exhaustividad tsc** (CD-5); son código muerto para Solana (el deposit nunca enruta un chainKey Solana). El caso viem-only (`resolveChainObject`) lanza `NOT_IMPLEMENTED` explícito (§9), nunca alcanzado.
- **DT-7 (gasless Solana = deferred)** — RATIFICADA. `SolanaGaslessAdapter.status()` retorna `{enabled:false, …}` (graceful degradation, patrón WKH-38/WKH-138). `transfer()` lanza `NOT_IMPLEMENTED`.
- **DT-8 (chainConfig.chainId sentinel)** — NUEVA (§2.4). Sentinel numérico env-driven no-EVM en el slot `chainConfig.chainId`; CAIP-2 es el id autoritativo. Evita ensanchar `AdaptersBundle` (blast-radius).
- **DT-9 (mint/stablecoin devnet, env-driven)** — RATIFICADA por el orquestador (Blocker #5). `SOLANA_USDC_MINT_DEVNET` con default sensato = USDC-SPL de Circle en devnet (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`), override total por env (CD-3). `SOLANA_USDC_DECIMALS` default 6.
- **DT-10 (idempotencia del settle Solana, AC-7)** — NUEVA. Antes de broadcastear, el adapter consulta si ya existe una firma confirmada para el `intentId` (persist-before-side-effect, mismo principio que WKH-191b "tx hash persisted before hop2"): si existe → `verify()` on-chain y **NO** re-broadcast (evita doble-settle/replay). El `intentId` se deriva determinísticamente del leg/step (composición: `contextId:stepIndex:payTo`). La persistencia de la firma reusa el seam de ledger/receipt existente (W5). El almacén exacto de idempotencia se implementa en W5 (columna aditiva); en W3 el adapter expone el gancho `verify()` y acepta `intentId`.

---

## 4. Constraint Directives (CD-N)

Heredadas del work-item (CD-1..CD-7) + nuevas de F2 (CD-8..CD-13, varias derivadas de Auto-Blindaje histórico).

- **CD-1 (OBLIGATORIO — ownership guard)** — toda query/mutación sobre `a2a_agent_keys` que el ledger/budget Solana introduzca en `src/services/*.ts` filtra por `owner_ref` además del `id`; funciones nuevas con `keyId` llevan `ownerId: string` (no `| undefined`). `budget.debit` ya cumple; el path Solana **reusa** esa firma sin abrir queries paralelas.
- **CD-2 (OBLIGATORIO — byte-identidad EVM)** — ningún pipeline 100%-EVM cambia comportamiento observable. Suite EVM verde sin modificar expectativas (AC-4). Única excepción mecánica no-conductual: `settle-verifier.test.ts` extiende el DOMINIO del `Record<ChainKey,Chain>` para excluir Solana (no cambia ninguna expectativa EVM — §9).
- **CD-3 (PROHIBIDO hardcodes)** — cluster/CAIP-2/mint/RPC/keypair/decimals/sentinel: todo env var con defaults sensatos documentados en `.env.example`. `SOLANA_OPERATOR_PRIVATE_KEY` NUNCA en logs ni error messages.
- **CD-4 (PROHIBIDO mainnet)** — devnet-only. Slug `solana-devnet` **sin** sufijo `-mainnet` (respeta el invariante `types.ts:124-134`; `isMainnetChainKey` lo clasifica testnet → fail-OPEN correcto).
- **CD-5 (OBLIGATORIO — exhaustividad de switch)** — todo switch/`Record` exhaustivo sobre `ChainKey` DEBE extenderse; `tsc --noEmit` debe fallar si alguno queda incompleto. **Además**, el narrowing por `vmFamily` en el wiring usa `else { const _never: never = x }` — sin `default`/`else` silencioso. Enumeración completa en §9.
- **CD-6 (PROHIBIDO simular en prod)** — el settle SPL es broadcast+confirm real on-chain en devnet (cero simulate-only). `verify()` re-lee la tx real.
- **CD-7 (OBLIGATORIO — clean architecture)** — `@solana/web3.js`/`@solana/spl-token` viven SOLO en `src/adapters/solana/*`. `src/lib/wallet-format.ts` valida base58 con código **puro** (no importa web3.js) para no romper la pureza leaf ni CD-7.
- **CD-8 (OBLIGATORIO — gate flag por defecto OFF)** — el rail Solana se activa vía `SOLANA_ADAPTER_ENABLED=true` (mirror de `TEMPO_ADAPTER_ENABLED`, `registry.ts:46-58`). Con el flag OFF el `SUPPORTED_CHAINS` set y `getSupportedChains()` retornan EXACTAMENTE los 7 slugs actuales → byte-idéntico (AC-4). El resolver SÍ conoce el slug estáticamente (como Tempo), pero sin bundle inicializado → `CHAIN_NOT_SUPPORTED` (defensa idéntica a Tempo).
- **CD-9 (OBLIGATORIO — decimals-aware)** — el monto atómico Solana se deriva de `supportedTokens[0].decimals` (env `SOLANA_USDC_DECIMALS`), nunca un `1e6`/`1e18` hardcodeado (lección WKH-192/WKH-195).
- **CD-10 (OBLIGATORIO — no-throw en el wiring)** — la rama Solana de `downstream-payment.ts` preserva el contrato NEVER-throws (retorna `null` + skip-code); en `compose.ts` el fallo lanza y el pipeline aborta/reembolsa como el path EVM.
- **CD-11 (Auto-Blindaje, tests)** — todo `vi.fn` reexpuesto vía spread `(...a)=>mock(...a)` se tipa con rest param `vi.fn((..._a: unknown[]): T => …)` (evita TS2556, recurrente ≥3 HUs — ref: WKH-191g auto-blindaje#2).
- **CD-12 (Auto-Blindaje, tests)** — con `noUncheckedIndexedAccess`, accesos `mock.calls[N]`/destructuring array usan `!` justificado o guard; buscar el patrón proactivamente con grep (ref: audit B1a auto-blindaje#3).
- **CD-13 (Auto-Blindaje, edición)** — `Edit replace_all` no cubre ocurrencias con distinta indentación; verificar con `tsc --noEmit` COMPLETO (no solo `npm run build` — excluye tests; lección WKH-196) que todos los switches/Records se resolvieron.

---

## 5. Waves de implementación (W0–W5)

> Orden estrictamente secuencial. W0→W1→W2 son additive-sin-tocar-runtime-EVM. W3 crea el rail aislado (testeable solo). W4 lo cablea. W5 cierra el ledger. Cada wave deja `tsc --noEmit` y la suite verdes antes de la siguiente.

### W0 — deps + scaffolding + tipos base (serial, contratos)

**Archivos:**
- `package.json` — añadir `@solana/web3.js` (`^1.x`, NO v2) + `@solana/spl-token`.
- `src/adapters/types.ts` — introducir `PaymentAdapterCommon`, `EvmPaymentAdapter` (= cuerpo actual + `vmFamily:'evm'`), `SolanaPaymentAdapter`, `SolanaTokenSpec`, `SolanaSettleRequest`, `SolanaSettleProof`, `type PaymentAdapter = Evm|Solana` (§2.2). NO tocar `ChainKey` todavía.
- `src/adapters/solana/` (NUEVO, scaffolding vacío tipado): `chain.ts`, `payment.ts`, `attestation.ts`, `gasless.ts`, `identity.ts`, `index.ts` (esqueletos que compilan; lógica real en W3).
- `.env.example` — bloque Solana (§6).

**Nota crítica W0:** al convertir `PaymentAdapter` en unión, los 4 adapters EVM (`implements PaymentAdapter`) rompen tsc. En W0 se hace **solo** el ajuste mecánico no-conductual de los 4: `implements EvmPaymentAdapter` + `readonly vmFamily = 'evm' as const` (§9). Sin este ajuste W0 no compila. Runtime byte-idéntico.

**Salida:** tsc verde, suite EVM verde (0 cambios de expectativa), rail Solana inerte (no registrado).

### W1 (B1) — namespace/validador base58

**Archivos:**
- `src/adapters/types.ts` — `ChainKey` += `'solana-devnet'` (sin `-mainnet`, CD-4). **Esto rompe los switches/Records de §9** → se arreglan en esta misma wave (fail-fast del compilador es la feature).
- `src/lib/wallet-format.ts` — añadir validador base58 **puro** namespace-aware:
  - `ADDRESS_RE`/`isValidWallet` (EVM) INTACTOS byte-idénticos (CD-2).
  - `isValidSolanaAddress(w): boolean` = charset base58 + decode a exactamente 32 bytes (impl pura ~15 líneas, sin deps, preserva el módulo leaf y CD-7).
  - `type WalletNamespace = 'evm' | 'solana'`; `isValidPayoutWallet(w, ns): boolean` que despacha.
- `src/types/index.ts` — `AgentPaymentSpec.contract` deja de ser exclusivamente `` `0x${string}` `` → `` `0x${string}` | string `` namespace-aware (documentar que la validación de forma vive en `wallet-format`/`validatePayTo`). Añadir a `PublishAgentInput` un campo aditivo opcional `payoutChain?: string` (contexto de familia para el guard de publish; ausente → EVM, byte-idéntico).
- `src/services/agent.ts` — `assertValidPayoutWallet` namespace-aware: resuelve la familia desde `input.payoutChain` (vía `normalizeChainSlug` → `solana-devnet`⇒`'solana'`, EVM⇒`'evm'`, desconocido⇒rechazo AC-6). `payoutChain` ausente ⇒ familia `'evm'` ⇒ comportamiento actual byte-idéntico. Aplica en publish (`:330`) y update (`:487`).
- Los 4 switches de `deposit-verifier.ts` + el `Record` de `downstream-payment.ts` + el test `settle-verifier.test.ts` (§9): añadir el caso `solana-devnet` con el tratamiento indicado.

**Salida:** un agente publica con `payoutWallet` base58 + `payoutChain:'solana-devnet'` sin activar el guard EVM (AC-1); base58 inválido → rechazo (AC-5); chain desconocida → rechazo (AC-6). tsc verde, suite verde.

### W2 (B2) — resolver + discovery

**Archivos:**
- `src/adapters/chain-resolver.ts` — entradas en `SLUG_ALIASES`: `'solana-devnet' → 'solana-devnet'`, `'solana' → 'solana-devnet'` (mismo patrón puro/total; el resolver NO lee el flag, igual que Tempo — CD-8). Opcional: alias CAIP-2 completo, no requerido.
- `src/services/discovery.ts` — **sin cambios de lógica** (`readPayment` ya es genérico una vez el resolver reconoce el slug — `discovery.ts:100-102`). Solo se añade test que verifica que un agente Solana-native pasa el filtro.

**Salida:** `normalizeChainSlug('solana')`/`('solana-devnet')` → `'solana-devnet'`; discovery acepta el agente Solana (AC-6 inverso — la ruta feliz). tsc verde, suite verde.

### W3 (B3-core) — `AdaptersBundle` Solana real

**Archivos (todos NUEVOS excepto registry):**
- `src/adapters/solana/chain.ts` — resuelve cluster/RPC/CAIP-2/sentinel desde env (opts > env > default), espejo de `avalanche/chain.ts`. Exporta `getSolanaConnection()` (`Connection` cacheada por proceso), `getSolanaCaip2()`, `getSolanaSyntheticChainId()`.
- `src/adapters/solana/payment.ts` — `SolanaPaymentAdapter implements SolanaPaymentAdapter` (`vmFamily:'solana'`):
  - `settle(req)`: resuelve operator `Keypair` desde `SOLANA_OPERATOR_PRIVATE_KEY` (base58, NUNCA logueado); `getOrCreateAssociatedTokenAccount` (operator + payTo); **idempotencia (DT-10/AC-7)**: si ya hay firma confirmada para `intentId` → `verify()` y skip; si no, `createTransferInstruction(amountAtomic)`, firma con operator, `sendAndConfirmTransaction` (commitment `SOLANA_COMMITMENT`), retorna `{txHash:signature, success}`.
  - `verify(proof)`: `getSignatureStatus`/`getParsedTransaction(signature)`, asserta transfer `>= amountAtomic` del mint a la ATA de `payTo` (verify-before-trust).
  - `quote(usd)`: `amountWei` = atomic con `SOLANA_USDC_DECIMALS` (patrón `parseUnits(usd.toFixed(dec),dec)` de avalanche).
  - `getMint()`, `getNetwork()` (CAIP-2), `getScheme()` (`'spl-transfer'`), `getMaxTimeoutSeconds()`, `getMerchantName()`, `supportedTokens` (mint+decimals).
  - `_resetSolanaClients()` test-only (mirror `_resetWalletClient`).
- `src/adapters/solana/attestation.ts` — `AttestationAdapter` stub que **lanza `NOT_IMPLEMENTED`** (DT-5, no no-op).
- `src/adapters/solana/gasless.ts` — `GaslessAdapter`: `status()` → `{enabled:false,…}`; `transfer()` → throw `NOT_IMPLEMENTED` (DT-7).
- `src/adapters/solana/identity.ts` — `export const solanaIdentity = null`.
- `src/adapters/solana/index.ts` — `createSolanaAdapters(opts?)` async, `await import()` de payment/attestation/gasless, retorna `AdaptersBundle` con `identity:null`, `chainConfig.chainId = getSolanaSyntheticChainId()` (DT-8). Espejo de `avalanche/index.ts`.
- `src/adapters/registry.ts` — flag-gate `isSolanaEnabled()` (mirror `isTempoEnabled`); `getSupportedChains()` añade `'solana-devnet'` solo con flag ON; branch en `buildBundle()`: `if (chainKey === 'solana-devnet') return createSolanaAdapters({ network:'devnet' })`.

**Salida:** con `SOLANA_ADAPTER_ENABLED=true` + envs, `getPaymentAdapter('solana-devnet')` retorna el adapter Solana; `settle()` broadcastea un SPL-transfer real en devnet (AC-2 aislado, testeable con Connection mockeada + un test de integración devnet gated). Flag OFF → 7 slugs, byte-idéntico (AC-4). tsc verde, suite verde.

### W4 (B3-wiring) — settle per-leg (downstream + compose)

**Archivos:**
- `src/lib/downstream-payment.ts` — tras resolver `chainKey`/`bundle`/`adapter`, narrowar por `adapter.vmFamily`:
  - `'evm'` → rama actual byte-idéntica (sign→verify→settle EIP-3009).
  - `'solana'` → `validatePayToSolana` (base58 via wallet-format), monto atómico decimals-aware (CD-9), `adapter.settle({payTo, amountAtomic, intentId})` idempotente + `verify` interno; mapear a `DownstreamResult`/skip-codes. Preservar NEVER-throws (CD-10).
  - `else { const _n: never = adapter }` (CD-5).
- `src/services/compose.ts` — rama inbound per-leg cuando el chain resuelve a Solana (espejo de `:798-991`, hoy `payTo as 0x`/`adapter.sign`/`getPaymentAdapter().settle`):
  - narrowar por `vmFamily`; en Solana usar `adapter.settle` directo (no el dance sign→verify→settle EVM) con verify-before-trust (AC-7) y sin `verifyDefaultChainSettle` (que es viem-only) → usar el `verify()` del adapter Solana.
  - EVM path intacto byte-idéntico (AC-4).

**Salida:** un pipeline con leg Solana liquida ESE leg on-chain en devnet (AC-2); pipeline mixto liquida cada leg en SU red (AC-3); retry de un leg ya confirmado no re-emite transfer (AC-7). tsc verde, suite verde.

### W5 (B3-ledger) — CAIP-2 aditivo + ownership guard

**Archivos:**
- **Migración SQL** (additive, en el dir de migraciones del repo) — columna `settle_caip2 text NULL` (y/o `settle_signature text NULL` para idempotencia DT-10) en la tabla de ledger que el débito inserta. NULL para legs EVM (byte-idéntico). Sin tocar columnas/queries existentes (AC-8).
- `src/services/budget.ts` — el path Solana registra el CAIP-2 (`adapter.caip2ChainId`) de forma aditiva:
  - opción preferida (mínimo riesgo money-path): NO tocar el RPC atómico `debit_with_dest_policy`; registrar `settle_caip2`/`settle_signature` vía el seam de receipt/ledger aditivo existente (`receiptService.emit`, ya transporta metadata arbitraria) o vía la columna nueva por un insert aditivo. `chainId:number` del debit = sentinel DT-8.
  - **CD-1 intacto**: cualquier query/mutación nueva sobre `a2a_agent_keys` filtra por `owner_ref`; se **reusa** `debit(keyId, chainId, amountUsd, …, ownerRef)` con `ownerRef` REQUERIDO threaded del caller autenticado (AC-9). NO se abren queries paralelas sin `owner_ref`.

**Salida:** un débito por leg Solana registra `solana:<cluster-id>` en el ledger sin romper queries EVM (AC-8); el ownership guard se preserva (AC-9). tsc verde, suite verde.

---

## 6. Env vars nuevas (`.env.example`, CD-3)

```bash
# ── Solana devnet payment rail (WKH-234) — settle-only, devnet-only (CD-4) ──
SOLANA_ADAPTER_ENABLED=false                 # gate (mirror TEMPO_ADAPTER_ENABLED); OFF → byte-idéntico
SOLANA_CLUSTER=devnet
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_RPC_URL_FALLBACK=                      # opcional
SOLANA_USDC_MINT_DEVNET=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU  # default = USDC-SPL Circle devnet (DT-9)
SOLANA_USDC_DECIMALS=6
SOLANA_COMMITMENT=confirmed                    # nivel de confirmación broadcast+verify
SOLANA_OPERATOR_PRIVATE_KEY=                   # base58 ed25519 secret — NUNCA en logs (CD-3)
SOLANA_CAIP2_CHAIN_ID=solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1  # CAIP-2 devnet genesis prefix (AC-8/DT-1)
SOLANA_SYNTHETIC_CHAIN_ID=900001               # sentinel numérico NO-EVM para chainConfig.chainId (DT-8; NO autoritativo)
```
> Los defaults son "sensatos" (patrón avalanche USDC default). Todo override-able. Ningún valor es hardcode en código: se leen de `process.env` con el default como fallback documentado.

---

## 7. Mapeo AC → Wave → Test

| AC | Descripción | Wave | Test planificado (archivo → aserción) |
|----|-------------|------|----------------------------------------|
| AC-1 | Publish base58 sin guard EVM | W1 | `agent.test.ts` (o `wallet-format.test.ts`): publish `payoutWallet` base58 + `payoutChain:'solana-devnet'` persiste sin throw; EVM `0x` sigue OK. |
| AC-2 | Settle SPL real broadcast+confirm | W3+W4 | `solana/payment.test.ts`: `settle()` con `Connection` mockeada emite `createTransferInstruction`+`sendAndConfirmTransaction` y retorna `{success:true, txHash}`. Integración devnet gated (`SOLANA_DEVNET_E2E=1`). |
| AC-3 | Per-leg multichain (cada leg su red) | W4 | `downstream-payment.test.ts`: pipeline con leg avalanche-fuji + leg solana-devnet → cada uno resuelve su adapter; EVM leg byte-idéntico. |
| AC-4 | No-regresión EVM (byte-idéntico) | W0–W5 | Suite EVM completa (`avalanche.test.ts`, `base.test.ts`, `registry.test.ts`, `payment.contract.test.ts`, downstream/compose) verde **sin cambiar expectativas**. Test nuevo: flag OFF → `getSupportedChains()` = 7 slugs exactos. |
| AC-5 | base58 inválido → rechazo | W1 | `wallet-format.test.ts`: `isValidSolanaAddress` rechaza charset inválido / longitud ≠32 bytes; `assertValidPayoutWallet` lanza. |
| AC-6 | chain desconocido → `CHAIN_NOT_SUPPORTED` | W1/W2 | `chain-resolver.test.ts`: `normalizeChainSlug('solana-mainnet')`/basura → `undefined`; downstream skip-code `CHAIN_NOT_SUPPORTED`. |
| AC-7 | doble-settle/replay | W3+W4 | `solana/payment.test.ts`: `settle()` con `intentId` ya confirmado → NO re-broadcast, retorna la firma previa vía `verify()`. |
| AC-8 | Ledger CAIP-2 aditivo | W5 | `budget.test.ts`: débito de leg Solana escribe `settle_caip2='solana:…'`; débito EVM deja la columna NULL (queries EVM intactas). |
| AC-9 | Ownership guard `owner_ref` | W5 | `budget.test.ts`: el path Solana pasa `ownerRef` requerido; mismatch → `OwnershipMismatchError`; no hay query sin `.eq('owner_ref',…)`. |
| AC-10 | Exhaustividad switch sin `any`/`default` | W1 | Test de compilación implícito: `tsc --noEmit` verde con TODOS los switches/Records de §9 extendidos; `settle-verifier.test.ts` invariante `-mainnet` verde (Solana excluida del dominio EVM). |

**Regla de tests (project-context 9 + CD-6):** cada archivo nuevo tiene ≥1 test; el settle real se cubre con mock de `Connection` (unit) + un test de integración devnet **gated por env** (`SOLANA_DEVNET_E2E`) para no depender de la red en CI. Total planificado: **≥10 tests** (≥1 por AC) + suite EVM existente intacta.

---

## 8. Exemplars verificados (paths reales, confirmados con Read)

| Exemplar | Path (verificado) | Qué copiar |
|----------|-------------------|------------|
| Factory de bundle | `src/adapters/avalanche/index.ts` | forma de `createSolanaAdapters` |
| PaymentAdapter real env-driven | `src/adapters/avalanche/payment.ts:92-205,357-495` | env-resolution con warn-once, operator signer, `parseUnits(usd.toFixed(dec),dec)`, `_reset*` test-only |
| chain.ts | `src/adapters/avalanche/chain.ts` | resolución network opts>env>default |
| attestation stub | `src/adapters/avalanche/attestation.ts` | forma del stub (Solana lanza NOT_IMPLEMENTED) |
| identity null | `src/adapters/avalanche/identity.ts` | `export const … = null` |
| flag-gate del rail | `src/adapters/registry.ts:41-114` | `isTempoEnabled`/`getSupportedChains`/branch `buildBundle` |
| resolver puro | `src/adapters/chain-resolver.ts:20-74` | entradas `SLUG_ALIASES` proto-null |
| validador leaf | `src/lib/wallet-format.ts:15-30` | preservar `ADDRESS_RE`/`isValidWallet`; añadir base58 puro |
| settle per-leg downstream | `src/lib/downstream-payment.ts:121-360` | narrowing + NEVER-throws + skip-codes |
| settle inbound + verify-before-trust | `src/services/compose.ts:798-991` | rama Solana espejo |
| ownership guard | `src/services/budget.ts:44-102` | `.eq('owner_ref',…)` + `ownerRef` requerido |
| persist-before-side-effect (idempotencia) | WKH-191b (fila 174 `_INDEX.md`) | tx-hash persistido ANTES del side-effect on-chain |

---

## 9. Blast-radius de la generalización de `PaymentAdapter` + extensión de `ChainKey`

### 9.1 Adapters EVM — por qué quedan byte-idénticos en runtime

Hay **4 clases** que `implements PaymentAdapter` (verificado con grep): `KiteOzonePaymentAdapter` (`kite-ozone/payment.ts:248`, cubre `kite-ozone-testnet` + `kite-mainnet`), `AvalanchePaymentAdapter` (`avalanche/payment.ts:357`), `BasePaymentAdapter` (`base/payment.ts:378`), `TempoPaymentAdapter` (`tempo/payment.ts:310`). Cambio por clase (W0):

1. `implements PaymentAdapter` → `implements EvmPaymentAdapter` (1 token).
2. `+ readonly vmFamily = 'evm' as const;` (1 línea).

**Por qué es no-conductual:** `EvmPaymentAdapter` es el cuerpo EXACTO del `PaymentAdapter` actual + un campo readonly literal que **ningún código existente lee**. Los cuerpos de `settle`/`sign`/`verify`/`quote`/`getToken`/etc. no se tocan → cada firma EIP-3009, cada POST al facilitator, cada `parseUnits` produce los mismos bytes. Los tests `payment.contract.test.ts`/`avalanche.test.ts`/`base.test.ts`/`tempo.payment.contract.test.ts` construyen la clase y llaman métodos: siguen verdes (no asertan `vmFamily`). → **AC-4/CD-2 holds**.

### 9.2 Switches/Records exhaustivos sobre `ChainKey` (CD-5) — enumeración completa

Verificado con grep (`Record<ChainKey`, `switch (chainKey)`, `satisfies…ChainKey`). Al añadir `'solana-devnet'`:

| # | Sitio | Tipo | ¿Rompe tsc? | Tratamiento |
|---|-------|------|-------------|-------------|
| 1 | `deposit-verifier.ts:68` `resolveChainFamilyEnvSuffix` | switch SIN default | **SÍ** | `case 'solana-devnet': return 'SOLANA'` + extender `ChainFamily` a incluir `'SOLANA'`. Código muerto para Solana (deposit=Scope OUT, DT-6). |
| 2 | `deposit-verifier.ts:128` `resolveRpcUrl` | switch SIN default | **SÍ** | `case 'solana-devnet': return process.env.SOLANA_RPC_URL`. |
| 3 | `deposit-verifier.ts:153` `resolveRpcFallbackEnv` | switch SIN default | **SÍ** | `case 'solana-devnet': return 'SOLANA_RPC_URL_FALLBACK'`. |
| 4 | `deposit-verifier.ts:177` `resolveChainObject` | switch SIN default, retorna viem `Chain` | **SÍ** | `case 'solana-devnet': throw new Error('resolveChainObject: solana-devnet has no viem Chain — Solana settle usa @solana/web3.js')`. NOT_IMPLEMENTED explícito (no default silencioso); nunca alcanzado (Solana no entra al deposit viem-path). |
| 5 | `downstream-payment.ts:46` `RPC_ENV_BY_CHAIN: Record<ChainKey,string>` | Record | **SÍ** | `'solana-devnet': 'SOLANA_RPC_URL'`. |
| 6 | `settle-verifier.test.ts:525` `CHAIN_KEY_TO_VIEM: Record<ChainKey,Chain>` | Record en TEST | **SÍ** | Único test EVM a tocar. El invariante `-mainnet` es EVM-only; el `Record` se refactoriza a `Partial<Record<ChainKey,Chain>>` o el test itera solo sobre chains EVM (excluye `solana-devnet`). **No cambia ninguna expectativa EVM** — extiende el dominio para saltar una familia sin viem. Documentar en el diff. |
| 7 | `price.ts:207` `estimateGaslessValueUsd` | switch CON `default: +Infinity` | NO | Solana cae al `default` fail-closed (correcto: gasless Solana = stub). Opcional `case` explícito para claridad; no obligatorio. |
| 8 | `registry.ts:35` `SUPPORTED_CHAINS … satisfies readonly ChainKey[]` | `satisfies` (no exige exhaustividad) | NO | Se añade `'solana-devnet'` al set flag-gated (W3), no por obligación de tsc. |
| 9 | `chain-resolver.ts:60` `satisfies Record<string,ChainKey>` | `satisfies` (keys=aliases) | NO | Se añaden aliases (W2), no rompe. |

> **Método de verificación (CD-13):** tras `ChainKey += 'solana-devnet'`, correr `npx tsc --noEmit` COMPLETO (incluye tests — lección WKH-196) y arreglar CADA error que el compilador liste. La lista #1–#6 es la conocida; si tsc revela otra (ej. un switch en middleware/x402 o cdp-selector que hoy usa `.startsWith`), extenderla igual. El compilador es la red de seguridad (CD-5/AC-10).

### 9.3 Consumidores de `getPaymentAdapter(): PaymentAdapter` (ahora unión)

- `downstream-payment.ts` y `compose.ts`: leen `.supportedTokens[0].decimals`, llaman `.sign/.verify/.settle/.getToken` (EVM-específicos). Con `PaymentAdapter` unión, estos accesos requieren narrowing `if (adapter.vmFamily === 'evm')` **antes** de tocar métodos EVM. Es exactamente el wiring de W4. La rama EVM queda byte-idéntica; la Solana es nueva. Métodos VM-agnósticos (`quote`, `getNetwork`, `getScheme`, `getMerchantName`, `getMaxTimeoutSeconds`, `name`) siguen accesibles sin narrowing (viven en `PaymentAdapterCommon`).
- Otros call-sites de `getPaymentAdapter()` (middleware x402, fee-charge, etc.): con la default-chain siempre EVM (Kite/Base), el narrowing por `vmFamily==='evm'` es transparente. Solana NUNCA es default-chain (solo se alcanza per-leg cuando el agente lo declara). Cualquier acceso EVM-específico que tsc marque tras la unión se resuelve con el narrowing `vmFamily` (fail-fast del compilador — es la garantía, no un riesgo).

---

## 10. Riesgos y mitigaciones

| Riesgo | Mitigación |
|--------|-----------|
| Ensanchar `PaymentAdapter` a unión rompe call-sites EVM ocultos | Es **deseable**: tsc los lista todos; se narrowa por `vmFamily`. Ninguno cambia runtime EVM (§9.3). |
| `settle-verifier.test.ts` (invariante `-mainnet`) parece violar AC-4 | Solo extiende el DOMINIO (excluye una familia sin viem); NO cambia expectativas EVM. Documentar en el diff + done-report. |
| Doble-settle si el broadcast confirma pero el proceso muere antes de persistir la firma | DT-10: persist-before-side-effect + `verify()` on-chain idempotente (patrón WKH-191b). Escenario residual = reconciliación (fuera de scope, no re-emite: `verify` detecta la confirmación previa). |
| `SOLANA_OPERATOR_PRIVATE_KEY` filtrado en logs | CD-3: nunca en logs/errores; el adapter loguea solo la pubkey/firma, jamás el secret (mirror del patrón `OPERATOR_PRIVATE_KEY` EVM). |
| Merge-conflict con HUs `in progress` sobre `orchestrate.ts` (relevance) | Zona de código distinta (chain-resolution/compose vs relevance). Vigilar al mergear; no se toca `orchestrate.ts` en este SDD. |
| `@solana/web3.js` v2 accidental (API distinta) | CD (DT-2): fijar `^1.x` explícito en `package.json`; los símbolos usados (`Connection`, `Keypair`, `Transaction`, `sendAndConfirmTransaction`) son v1. |

---

## 11. Readiness Check (F2 → SPEC_APPROVED)

- [x] Work-item leído completo (10 ACs, 13 archivos Scope IN, 7 DT, 7 CD).
- [x] `project-context.md` leído (stack: Fastify/TS strict/vitem→viem/vitest/biome; regla no-`any`).
- [x] Exemplars verificados con Read (paths reales §8): avalanche bundle completo, registry, resolver, deposit-verifier, wallet-format, downstream-payment, compose, budget, settle-verifier, agent, types.
- [x] Blocker #1 (quién firma) RESUELTO → DT-3 ratificada (operador firma, custodial de ese lado).
- [x] Blocker #4 (forma de generalizar `PaymentAdapter`) RESUELTO → §2 unión discriminada `vmFamily`, sin `any`, exhaustividad forzada.
- [x] Deposit Solana / gasless Solana / mint / slug: RESUELTOS (DT-6/DT-7/DT-9 + slug `solana-devnet`).
- [x] Blast-radius de `ChainKey` + `PaymentAdapter` enumerado completo (§9), incluyendo el único test EVM a tocar y por qué no viola AC-4.
- [x] Mapeo AC→wave→test completo (§7), ≥1 test por AC, suite EVM intacta (AC-4).
- [x] CDs heredadas (CD-1..CD-7) + nuevas (CD-8..CD-13, 3 de Auto-Blindaje histórico).
- [x] Env vars nuevas definidas con defaults sensatos (§6), sin hardcodes (CD-3).
- [x] Ownership guard (CD-1/AC-9) preservado por reuso de `budget.debit(…, ownerRef)`.
- [ ] **Sin `[NEEDS CLARIFICATION]` abiertos** — ver §12: ninguno bloqueante. Un punto de dominio menor (esquema exacto de persistencia de idempotencia W5) queda ratificado como DT-10 con enfoque recomendado, resoluble en implementación sin decisión humana.

**Veredicto:** SDD LISTO para `SPEC_APPROVED`. Los 2 blockers de F2 están resueltos por directiva del orquestador + diseño de §2. No hay TBD sin resolver.

---

## 12. `[NEEDS CLARIFICATION]` residuales

Ninguno **bloqueante**. Los 6 del work-item quedan cerrados (Blocker #1→DT-3, #2→DT-6, #3→DT-7, #4→§2/DT-4, #5→DT-9, #6→slug `solana-devnet`).

Punto de dominio menor (NO bloquea SPEC_APPROVED, ratificado como DT-10): el **almacén exacto de idempotencia** del settle Solana (columna aditiva `settle_signature` en el ledger vs. tabla nueva vs. seam de receipt). Se recomienda la columna aditiva sobre la tabla de ledger existente (menor superficie, reusa el insert del débito). La decisión final de esquema se toma en W5 durante la implementación siguiendo el patrón persist-before-side-effect de WKH-191b; no requiere input humano.
