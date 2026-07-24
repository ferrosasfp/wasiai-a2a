# Story File — [WKH-234] PaymentAdapter Solana en el gateway

> Fase: F2.5 · Contrato autosuficiente para el Dev (F3). **Este documento es lo ÚNICO que leés para implementar.** Todo (paths, firmas, tratamientos, tests, gates) está acá. NO releas el SDD.
> Branch: `feat/182-wkh-234-solana-payment-adapter`
> Derivado de: `doc/sdd/182-wkh-234-solana-payment-adapter/sdd.md` (SPEC_APPROVED).

---

## 1. Contexto mínimo

Se construye el **rail de pago del FEE del agente en Solana devnet** dentro del gateway `wasiai-a2a` (hoy 100% EVM: kite/avalanche/base/tempo). Es **settle-only**: el **OPERADOR del gateway firma** el SPL-token transfer real (broadcast + confirm + verify on-chain) con su keypair — custodial de ese lado, espejo exacto del path EVM (Avalanche/Base firman con `OPERATOR_PRIVATE_KEY`). El caller NO posee wallet Solana. El principal de la remesa (escrow/facilitator) es Scope OUT (HELD en otro repo).

**Invariante rector (no negociable):**
- **EVM byte-idéntico** (AC-4 / CD-2): ningún pipeline 100%-EVM cambia comportamiento observable. La suite EVM pasa **sin modificar expectativas**. Única excepción mecánica: extender el DOMINIO del `Record<ChainKey,Chain>` en `settle-verifier.test.ts` para excluir Solana (no cambia ninguna aserción EVM).
- **Flag OFF por default** (CD-8): `SOLANA_ADAPTER_ENABLED=false`. Con OFF, `getSupportedChains()` retorna EXACTAMENTE los 7 slugs actuales.
- **Clean architecture** (CD-7): `@solana/web3.js` y `@solana/spl-token` viven SOLO en `src/adapters/solana/*`. NUNCA importados desde `src/services/*`, `src/routes/*`, `src/lib/*`. `wallet-format.ts` valida base58 con código PURO (sin web3.js).
- **Sin hardcodes** (CD-3): cluster/CAIP-2/mint/RPC/keypair/decimals/sentinel → todo env var con default documentado. `SOLANA_OPERATOR_PRIVATE_KEY` NUNCA en logs ni error messages.
- **Devnet-only** (CD-4): slug `solana-devnet` SIN sufijo `-mainnet` (respeta el invariante `types.ts:124-134`; `isMainnetChainKey` lo clasifica testnet → fail-OPEN correcto).
- **Sin `any` / `as unknown`** (project-context regla 8): la generalización usa unión discriminada por `vmFamily`.

**Cómo se generaliza `PaymentAdapter` (clave):** un `class` de TS NO puede `implements` una unión. Por eso: la interfaz EVM actual se preserva verbatim y se renombra a `EvmPaymentAdapter` (+1 campo discriminante `vmFamily:'evm'`); nace `SolanaPaymentAdapter` (`vmFamily:'solana'`); `type PaymentAdapter = EvmPaymentAdapter | SolanaPaymentAdapter`. Los 4 adapters EVM cambian `implements PaymentAdapter` → `implements EvmPaymentAdapter` + `readonly vmFamily = 'evm' as const` (runtime byte-idéntico). El wiring narrowa por `vmFamily` con `else` exhaustivo `never`.

---

## 2. Scope IN — lista exhaustiva de archivos

**NUEVOS (crear):**
- `src/adapters/solana/chain.ts`
- `src/adapters/solana/payment.ts`
- `src/adapters/solana/attestation.ts`
- `src/adapters/solana/gasless.ts`
- `src/adapters/solana/identity.ts`
- `src/adapters/solana/index.ts`
- `src/adapters/solana/payment.test.ts` (W3)
- Migración SQL aditiva (W5, dir de migraciones del repo)
- Tests nuevos por wave (§ Tests)

**MODIFICADOS:**
- `package.json` (W0) — deps
- `src/adapters/types.ts` (W0 tipos + W1 `ChainKey`)
- `src/adapters/kite-ozone/payment.ts` (W0 mecánico)
- `src/adapters/avalanche/payment.ts` (W0 mecánico)
- `src/adapters/base/payment.ts` (W0 mecánico)
- `src/adapters/tempo/payment.ts` (W0 mecánico)
- `.env.example` (W0)
- `src/lib/wallet-format.ts` (W1)
- `src/types/index.ts` (W1)
- `src/services/agent.ts` (W1)
- `src/adapters/deposit-verifier.ts` (W1 — 4 switches)
- `src/lib/downstream-payment.ts` (W1 Record + W4 rama Solana)
- `src/adapters/settle-verifier.test.ts` (W1 — único test EVM a tocar)
- `src/adapters/chain-resolver.ts` (W2)
- `src/adapters/registry.ts` (W3 flag-gate + branch)
- `src/services/compose.ts` (W4 rama inbound Solana)
- `src/services/budget.ts` (W5 CAIP-2 aditivo)

**NO TOCAR** (fuera de scope): `src/routes/orchestrate.ts` (zona relevance, riesgo de merge — no entrar), cuerpos de método de los 4 adapters EVM (salvo el cambio mecánico W0), `discovery.ts` lógica (solo test en W2).

---

## 3. Anti-Hallucination Checklist (específico WKH-234)

Antes de escribir código en cada wave, confirmá:

- [ ] `src/adapters/avalanche/index.ts` es el exemplar de `createSolanaAdapters` — leélo antes de W3.
- [ ] `src/adapters/avalanche/payment.ts` es el exemplar de `payment.ts` (env-resolution warn-once, operator signer, `parseUnits(usd.toFixed(dec),dec)`, `_resetWalletClient()` test-only) — leélo antes de W3.
- [ ] `src/adapters/avalanche/chain.ts` / `attestation.ts` / `identity.ts` — exemplars de las piezas menores.
- [ ] `src/adapters/registry.ts` — `isTempoEnabled` / `getSupportedChains` / branch `buildBundle` son el patrón flag-gate a espejar (leélo antes de W3).
- [ ] `src/adapters/chain-resolver.ts` — `SLUG_ALIASES` con proto `null` (anti-prototype-pollution) es el patrón de W2.
- [ ] `src/lib/wallet-format.ts` — `ADDRESS_RE` / `isValidWallet` deben quedar byte-idénticos; el validador base58 se AGREGA, no reemplaza.
- [ ] `@solana/web3.js` fijado en `^1.x` (NO v2 — API distinta). Símbolos v1: `Connection`, `Keypair`, `Transaction`, `PublicKey`, `sendAndConfirmTransaction`.
- [ ] Ningún import de web3.js/spl-token fuera de `src/adapters/solana/*`.
- [ ] Ningún valor Solana hardcodeado — todo via `process.env` con default fallback (§ Env vars).
- [ ] `SOLANA_OPERATOR_PRIVATE_KEY` jamás pasa a `console.*`, logger, ni a un `Error(...)` message.
- [ ] Todo mock `vi.fn` reexpuesto via spread se tipa con rest `unknown[]` (CD-11, ver § Auto-Blindaje).
- [ ] `tsc --noEmit` COMPLETO (incluye tests) es el gate, NO `npm run build` (excluye tests — lección WKH-196 / CD-13).

---

## 4. Waves W0 → W5 (checklist ejecutable, SECUENCIAL BLOQUEANTE)

> **Regla de orden:** W(n+1) NO arranca hasta que W(n) deje `npx tsc --noEmit` COMPLETO verde + suite de tests verde. Sin excepciones.

---

### ✅ W0 — deps + scaffolding + tipos base (serial, contratos)

**Objetivo:** introducir la unión discriminada `PaymentAdapter` y dejar los 4 adapters EVM compilando (ajuste mecánico), + scaffolding Solana inerte. `ChainKey` NO se toca todavía.

**Tareas:**

1. **`package.json`** — añadir deps:
   - `@solana/web3.js` con rango `^1.x` (NO v2).
   - `@solana/spl-token` (compatible v1).
   - Correr install para actualizar el lockfile.

2. **`src/adapters/types.ts`** — introducir los tipos de la unión discriminada. Reproducir **literal** el siguiente bloque (adaptando `QuoteResult`/`SettleRequest`/`X402Proof`/`SignRequest`/`TokenSpec`/`SettleResult`/`VerifyResult` a los nombres YA existentes en el archivo — NO redefinirlos, se reusan tal cual):

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

   - `SettleResult`/`VerifyResult`/`QuoteResult`/`SignResult` se **reutilizan tal cual** (VM-agnósticos). Para Solana `SettleResult.txHash` = la firma base58 (string opaco, conserva el nombre `txHash`).
   - El cuerpo actual de `PaymentAdapter` se convierte en `EvmPaymentAdapter` (mismo contenido + `readonly vmFamily:'evm'`). NO borres campos EVM.

3. **Los 4 adapters EVM — cambio MECÁNICO no-conductual** (sin tocar cuerpos de método):
   - `src/adapters/kite-ozone/payment.ts` (`KiteOzonePaymentAdapter`, ~línea 248): `implements PaymentAdapter` → `implements EvmPaymentAdapter` + añadir `readonly vmFamily = 'evm' as const;`
   - `src/adapters/avalanche/payment.ts` (`AvalanchePaymentAdapter`, ~línea 357): idem.
   - `src/adapters/base/payment.ts` (`BasePaymentAdapter`, ~línea 378): idem.
   - `src/adapters/tempo/payment.ts` (`TempoPaymentAdapter`, ~línea 310): idem.
   - **SOLO estos 2 tokens por clase.** NO tocar `settle`/`sign`/`verify`/`quote`/`getToken` ni ningún otro cuerpo.

4. **`src/adapters/solana/` — scaffolding tipado que COMPILA (lógica real en W3):**
   - `chain.ts`, `payment.ts`, `attestation.ts`, `gasless.ts`, `identity.ts`, `index.ts` — esqueletos: firmas/exports que tipan contra las interfaces, cuerpos mínimos (pueden lanzar `NOT_IMPLEMENTED` provisorio salvo `identity.ts` = `export const solanaIdentity = null`). El objetivo de W0 es que compile, no que funcione.

5. **`.env.example`** — añadir el bloque Solana completo (§ Env vars, literal).

**Gate W0:** `npx tsc --noEmit` COMPLETO verde. Suite EVM verde (0 cambios de expectativa). Rail Solana inerte (no registrado en registry todavía).

---

### ✅ W1 (B1) — namespace / validador base58 + resolución del blast-radius de `ChainKey`

**Objetivo:** extender `ChainKey` con `solana-devnet` y arreglar los 6 sitios que rompen tsc; validador base58 puro; publish namespace-aware.

**Tareas:**

1. **`src/adapters/types.ts`** — `ChainKey` += `'solana-devnet'` (SIN `-mainnet`, CD-4). **Esto rompe los 6 switches/Records de abajo** → arreglarlos en ESTA wave (el fail-fast del compilador es la feature).

2. **Los 6 sitios exhaustivos que rompen tsc (tratamiento EXACTO):**

| # | Sitio | Tratamiento exacto |
|---|-------|--------------------|
| 1 | `deposit-verifier.ts:68` `resolveChainFamilyEnvSuffix` (switch SIN default) | `case 'solana-devnet': return 'SOLANA'` + extender el type `ChainFamily` a incluir `'SOLANA'`. Código muerto para Solana (deposit = Scope OUT). |
| 2 | `deposit-verifier.ts:128` `resolveRpcUrl` (switch SIN default) | `case 'solana-devnet': return process.env.SOLANA_RPC_URL` (o el nombre canónico del env, ver § Env vars). |
| 3 | `deposit-verifier.ts:153` `resolveRpcFallbackEnv` (switch SIN default) | `case 'solana-devnet': return 'SOLANA_RPC_URL_FALLBACK'`. |
| 4 | `deposit-verifier.ts:177` `resolveChainObject` (switch SIN default, retorna viem `Chain`) | `case 'solana-devnet': throw new Error('resolveChainObject: solana-devnet has no viem Chain — Solana settle usa @solana/web3.js')`. NOT_IMPLEMENTED explícito, NUNCA alcanzado (Solana no entra al deposit viem-path). NO usar `default` silencioso. |
| 5 | `downstream-payment.ts:46` `RPC_ENV_BY_CHAIN: Record<ChainKey,string>` (Record) | añadir entrada `'solana-devnet': 'SOLANA_RPC_URL'`. |
| 6 | `settle-verifier.test.ts:525` `CHAIN_KEY_TO_VIEM: Record<ChainKey,Chain>` (Record en TEST) | **Único test EVM a tocar.** El invariante `-mainnet` es EVM-only. Refactorizar el `Record<ChainKey,Chain>` a `Partial<Record<ChainKey,Chain>>` **o** hacer que el test itere solo sobre chains EVM (excluye `solana-devnet`). **NO cambia NINGUNA expectativa EVM** — solo extiende el dominio para saltar una familia sin viem. Documentar en el diff/commit por qué esto NO viola AC-4. |

   - **CD-13:** tras editar `ChainKey`, correr `npx tsc --noEmit` COMPLETO y arreglar CADA error que el compilador liste. La lista #1-#6 es la conocida; si tsc revela otro sitio (ej. un switch en middleware/x402 o cdp-selector), extenderlo igual con el mismo criterio. El compilador es la red de seguridad (CD-5 / AC-10).
   - Sitios que NO rompen (no requieren acción obligatoria): `price.ts:207` (tiene `default:+Infinity` fail-closed → Solana cae correcto), `registry.ts:35` `satisfies` (se toca en W3), `chain-resolver.ts:60` `satisfies` (se toca en W2).

3. **`src/lib/wallet-format.ts`** — validador base58 PURO namespace-aware:
   - `ADDRESS_RE` / `isValidWallet` (EVM) quedan **INTACTOS byte-idénticos** (CD-2).
   - Añadir `isValidSolanaAddress(w: string): boolean` = charset base58 + decode a exactamente 32 bytes. Implementación PURA (~15 líneas, sin deps, sin importar web3.js — preserva el módulo leaf y CD-7).
   - Añadir `type WalletNamespace = 'evm' | 'solana'`.
   - Añadir `isValidPayoutWallet(w: string, ns: WalletNamespace): boolean` que despacha a EVM o Solana según `ns`.

4. **`src/types/index.ts`:**
   - `AgentPaymentSpec.contract` deja de ser exclusivamente `` `0x${string}` `` → `` `0x${string}` | string `` (namespace-aware; la validación de forma vive en `wallet-format` / `validatePayTo`, documentarlo con comentario).
   - Añadir a `PublishAgentInput` un campo aditivo opcional `payoutChain?: string` (contexto de familia para el guard de publish; ausente → EVM byte-idéntico).

5. **`src/services/agent.ts`** — `assertValidPayoutWallet` namespace-aware:
   - Resolver la familia desde `input.payoutChain` via `normalizeChainSlug`: `solana-devnet` ⇒ `'solana'`, EVM ⇒ `'evm'`, desconocido ⇒ rechazo (AC-6).
   - `payoutChain` ausente ⇒ familia `'evm'` ⇒ comportamiento actual byte-idéntico.
   - Aplicar en publish (~línea 330) y update (~línea 487). Usar `isValidPayoutWallet(wallet, ns)`; base58 inválido con ns `'solana'` → lanzar el error de formato existente (AC-5).

**Gate W1:** `npx tsc --noEmit` COMPLETO verde. Suite verde. Un agente publica con `payoutWallet` base58 + `payoutChain:'solana-devnet'` sin activar el guard EVM (AC-1); base58 inválido → rechazo (AC-5); chain desconocida → rechazo (AC-6).

---

### ✅ W2 (B2) — resolver + discovery

**Objetivo:** que `normalizeChainSlug` reconozca los slugs Solana (destraba discovery, que ya es genérico).

**Tareas:**

1. **`src/adapters/chain-resolver.ts`** — añadir entradas en `SLUG_ALIASES` (mismo patrón puro/total, proto `null`):
   - `'solana-devnet' → 'solana-devnet'`
   - `'solana' → 'solana-devnet'`
   - (Opcional, NO requerido: alias CAIP-2 completo.)
   - El resolver NO lee el flag (igual que Tempo — CD-8): conoce el slug estáticamente aunque el bundle no esté inicializado.

2. **`src/services/discovery.ts`** — **SIN cambios de lógica** (`readPayment` ya es genérico una vez el resolver reconoce el slug). Solo añadir un test que verifica que un agente Solana-native pasa el filtro.

**Gate W2:** `npx tsc --noEmit` COMPLETO verde. Suite verde. `normalizeChainSlug('solana')` y `('solana-devnet')` → `'solana-devnet'`; discovery acepta el agente Solana (AC-6 inverso, ruta feliz).

---

### ✅ W3 (B3-core) — `AdaptersBundle` Solana real

**Objetivo:** el rail Solana aislado y testeable (settle SPL real, verify on-chain, idempotencia). Flag-gate en registry.

> Antes de arrancar: leé `src/adapters/avalanche/{index,payment,chain,attestation,identity}.ts` y `src/adapters/registry.ts:41-114` como exemplars.

**Tareas (archivos NUEVOS salvo registry):**

1. **`src/adapters/solana/chain.ts`** — resuelve cluster/RPC/CAIP-2/sentinel desde env (opts > env > default), espejo de `avalanche/chain.ts`. Exporta:
   - `getSolanaConnection(): Connection` (cacheada por proceso).
   - `getSolanaCaip2(): string` (de `SOLANA_CAIP2_CHAIN_ID`).
   - `getSolanaSyntheticChainId(): number` (de `SOLANA_SYNTHETIC_CHAIN_ID`, sentinel no-EVM DT-8).

2. **`src/adapters/solana/payment.ts`** — `class SolanaPaymentAdapter implements SolanaPaymentAdapter` (`readonly vmFamily = 'solana' as const`):
   - `settle(req: SolanaSettleRequest): Promise<SettleResult>`:
     - Resuelve operator `Keypair` desde `SOLANA_OPERATOR_PRIVATE_KEY` (base58, NUNCA logueado).
     - `getOrCreateAssociatedTokenAccount` para operator + `payTo`.
     - **Idempotencia (DT-10 / AC-7):** ANTES de broadcastear, consultar si ya existe firma confirmada para `intentId` (persist-before-side-effect). Si existe → `verify()` on-chain y retornar la firma previa, **NO** re-broadcast. En W3 el gancho de persistencia puede ser un stub/seam; el almacén real se cierra en W5. Lo obligatorio en W3: `settle` acepta `intentId` y expone el path idempotente via `verify()`.
     - Si no existe: `createTransferInstruction(amountAtomic)`, firma con operator, `sendAndConfirmTransaction` (commitment de `SOLANA_COMMITMENT`), retorna `{txHash: signature, success: true}`.
   - `verify(proof: SolanaSettleProof): Promise<VerifyResult>`: `getSignatureStatus` / `getParsedTransaction(signature)`, asserta transfer `>= amountAtomic` del mint hacia la ATA de `payTo` (verify-before-trust).
   - `quote(usd): Promise<QuoteResult>`: `amountWei` = atómico con `SOLANA_USDC_DECIMALS` (patrón `parseUnits(usd.toFixed(dec),dec)` de avalanche).
   - `getMint(): string` (base58), `getNetwork(): string` (CAIP-2), `getScheme(): string` (`'spl-transfer'`), `getMaxTimeoutSeconds()`, `getMerchantName()`, `supportedTokens: SolanaTokenSpec[]` (mint + decimals de env).
   - `caip2ChainId` = `getSolanaCaip2()`.
   - `_resetSolanaClients()` test-only (mirror `_resetWalletClient`).

3. **`src/adapters/solana/attestation.ts`** — stub que **lanza `NOT_IMPLEMENTED`** explícito (DT-5, NO no-op silencioso).

4. **`src/adapters/solana/gasless.ts`** — `status()` → `{enabled:false, …}` (graceful degradation); `transfer()` → throw `NOT_IMPLEMENTED` (DT-7).

5. **`src/adapters/solana/identity.ts`** — `export const solanaIdentity = null`.

6. **`src/adapters/solana/index.ts`** — `createSolanaAdapters(opts?)` async, `await import()` lazy de payment/attestation/gasless, retorna `AdaptersBundle` con `identity: null`, `chainConfig.chainId = getSolanaSyntheticChainId()` (DT-8 sentinel — NUNCA se usa para construir un cliente viem). Espejo de `avalanche/index.ts`.

7. **`src/adapters/registry.ts`:**
   - Añadir `isSolanaEnabled()` (mirror exacto de `isTempoEnabled`, lee `SOLANA_ADAPTER_ENABLED === 'true'`).
   - `getSupportedChains()` añade `'solana-devnet'` **solo** con flag ON (con OFF → 7 slugs exactos, byte-idéntico).
   - Branch en `buildBundle()`: `if (chainKey === 'solana-devnet') return createSolanaAdapters({ network: 'devnet' })`. Con flag OFF y bundle no inicializado → `CHAIN_NOT_SUPPORTED` (defensa idéntica a Tempo).

**Gate W3:** `npx tsc --noEmit` COMPLETO verde. Suite verde. Con `SOLANA_ADAPTER_ENABLED=true` + envs, `getPaymentAdapter('solana-devnet')` retorna el adapter Solana; `settle()` (con `Connection` mockeada en unit + gated devnet e2e) emite el SPL-transfer. Flag OFF → `getSupportedChains()` = 7 slugs (AC-4).

---

### ✅ W4 (B3-wiring) — settle per-leg (downstream + compose)

**Objetivo:** cablear el rail al settle per-leg (downstream) e inbound (compose), narrowando por `vmFamily`. EVM byte-idéntico.

**Tareas:**

1. **`src/lib/downstream-payment.ts`** — tras resolver `chainKey`/`bundle`/`adapter`, narrowar por `adapter.vmFamily`:
   - `'evm'` → rama actual **byte-idéntica** (sign→verify→settle EIP-3009). NO tocar su lógica; solo envolverla en el narrowing.
   - `'solana'` → `validatePayToSolana` (base58 via `wallet-format`), monto atómico decimals-aware (CD-9, de `supportedTokens[0].decimals`, nunca `1e6`/`1e18` hardcodeado), `adapter.settle({payTo, amountAtomic, intentId})` idempotente + verify interno; mapear a `DownstreamResult`/skip-codes. **Preservar NEVER-throws** (CD-10: retorna `null` + skip-code, no lanza).
   - `else { const _n: never = adapter; }` (CD-5, exhaustividad).
   - El `intentId` se deriva determinísticamente del leg/step (`contextId:stepIndex:payTo`).

2. **`src/services/compose.ts`** — rama inbound per-leg cuando el chain resuelve a Solana (espejo de la rama EVM `:798-991`, hoy `payTo as 0x` / `adapter.sign` / `getPaymentAdapter().settle`):
   - Narrowar por `vmFamily`.
   - En Solana usar `adapter.settle` **directo** (NO el dance sign→verify→settle EVM) con verify-before-trust (AC-7) via el `verify()` del adapter Solana. **NO** usar `verifyDefaultChainSettle` (es viem-only).
   - EVM path **intacto byte-idéntico** (AC-4): en compose, el fallo lanza y el pipeline aborta/reembolsa como el path EVM (CD-10).

**Gate W4:** `npx tsc --noEmit` COMPLETO verde. Suite verde. Un pipeline con leg Solana liquida ESE leg on-chain devnet (AC-2); pipeline mixto liquida cada leg en SU red (AC-3); retry de un leg ya confirmado no re-emite transfer (AC-7).

---

### ✅ W5 (B3-ledger) — CAIP-2 aditivo + ownership guard

**Objetivo:** registrar el chain-id CAIP-2 del leg Solana en el ledger de forma aditiva, preservando el ownership guard.

**Tareas:**

1. **Migración SQL aditiva** (dir de migraciones del repo) — columna `settle_caip2 text NULL` (y/o `settle_signature text NULL` para cerrar la idempotencia DT-10) en la tabla de ledger que el débito inserta. NULL para legs EVM (byte-idéntico). NO tocar columnas/queries existentes (AC-8).

2. **`src/services/budget.ts`** — el path Solana registra el CAIP-2 (`adapter.caip2ChainId`) de forma aditiva:
   - **Opción preferida (mínimo riesgo money-path):** NO tocar el RPC atómico `debit_with_dest_policy`. Registrar `settle_caip2` / `settle_signature` via el seam de receipt/ledger aditivo existente (`receiptService.emit` transporta metadata arbitraria) o via un insert aditivo a la columna nueva. El `chainId:number` del debit = sentinel DT-8.
   - **CD-1 / AC-9 (ownership guard) — INTACTO:** cualquier query/mutación nueva sobre `a2a_agent_keys` filtra por `owner_ref`. **REUSAR** `debit(keyId, chainId, amountUsd, …, ownerRef)` con `ownerRef` REQUERIDO threaded del caller autenticado. NO abrir queries paralelas sin `.eq('owner_ref', …)`. NO agregar funciones con `keyId` sin `ownerId: string` (no `| undefined`).

**Gate W5:** `npx tsc --noEmit` COMPLETO verde. Suite verde. Un débito por leg Solana registra `solana:<cluster-id>` en el ledger sin romper queries EVM (AC-8); el ownership guard se preserva (AC-9).

---

## 5. Env vars (`.env.example`, CD-3) — literal

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

> Defaults sensatos (patrón avalanche USDC default). Todo override-able. Ningún valor es hardcode en código: se leen de `process.env` con el default como fallback documentado.

---

## 6. Guardrails / PROHIBIDO

- ❌ **NO tocar cuerpos de método** de los 4 adapters EVM (`settle`/`sign`/`verify`/`quote`/`getToken`/etc.). Único cambio permitido: `implements EvmPaymentAdapter` + `readonly vmFamily = 'evm' as const`.
- ❌ **NO `any` ni `as unknown`** (project-context regla 8). La generalización es unión discriminada; el narrowing usa `vmFamily`.
- ❌ **NO importar `@solana/web3.js` / `@solana/spl-token`** fuera de `src/adapters/solana/*` (CD-7). `wallet-format.ts` valida base58 con código puro.
- ❌ **NO hardcodear** mint / RPC / keypair / cluster / CAIP-2 / decimals / sentinel — todo env var con default (CD-3).
- ❌ **`SOLANA_OPERATOR_PRIVATE_KEY` nunca** en `console.*`, logger ni mensaje de `Error`. Logueá solo pubkey/firma.
- ❌ **NO romper el ownership guard** (CD-1): reusar `budget.debit(…, ownerRef)`; no abrir queries sobre `a2a_agent_keys` sin `.eq('owner_ref', …)`; funciones nuevas con `keyId` llevan `ownerId: string`.
- ❌ **NO cambiar expectativas de tests EVM.** Solo extender dominios (único: el `Record<ChainKey,Chain>` de `settle-verifier.test.ts`).
- ❌ **NO usar `default`/`else` silencioso** en switches sobre `ChainKey` ni en el narrowing `vmFamily` (usar `else { const _never: never = x }`).
- ❌ **NO usar `@solana/web3.js` v2** (API distinta). Fijar `^1.x`.
- ❌ **NO tocar `src/routes/orchestrate.ts`** (zona relevance, riesgo de merge).
- ❌ **NO simular** el settle (CD-6): broadcast+confirm real on-chain devnet; `verify()` re-lee la tx.

---

## 7. Tests requeridos (≥10, ≥1 por AC)

| AC | Wave | Test (archivo → aserción) |
|----|------|---------------------------|
| AC-1 | W1 | `agent.test.ts` o `wallet-format.test.ts`: publish `payoutWallet` base58 + `payoutChain:'solana-devnet'` persiste sin throw; EVM `0x` sigue OK. |
| AC-2 | W3+W4 | `src/adapters/solana/payment.test.ts`: `settle()` con `Connection` mockeada emite `createTransferInstruction` + `sendAndConfirmTransaction` y retorna `{success:true, txHash}`. Integración devnet **gated** (`SOLANA_DEVNET_E2E=1`). |
| AC-3 | W4 | `downstream-payment.test.ts`: pipeline con leg `avalanche-fuji` + leg `solana-devnet` → cada uno resuelve su adapter; EVM leg byte-idéntico. |
| AC-4 | W0–W5 | Suite EVM completa (`avalanche.test.ts`, `base.test.ts`, `registry.test.ts`, `payment.contract.test.ts`, downstream/compose) verde **sin cambiar expectativas**. Test nuevo: flag OFF → `getSupportedChains()` = 7 slugs exactos. |
| AC-5 | W1 | `wallet-format.test.ts`: `isValidSolanaAddress` rechaza charset inválido / longitud ≠32 bytes; `assertValidPayoutWallet` lanza. |
| AC-6 | W1/W2 | `chain-resolver.test.ts`: `normalizeChainSlug('solana-mainnet')`/basura → `undefined`; downstream skip-code `CHAIN_NOT_SUPPORTED`. |
| AC-7 | W3+W4 | `src/adapters/solana/payment.test.ts`: `settle()` con `intentId` ya confirmado → NO re-broadcast, retorna la firma previa via `verify()`. |
| AC-8 | W5 | `budget.test.ts`: débito de leg Solana escribe `settle_caip2='solana:…'`; débito EVM deja la columna NULL. |
| AC-9 | W5 | `budget.test.ts`: el path Solana pasa `ownerRef` requerido; mismatch → `OwnershipMismatchError`; no hay query sin `.eq('owner_ref', …)`. |
| AC-10 | W1 | `tsc --noEmit` COMPLETO verde con TODOS los switches/Records de §4.2 extendidos; `settle-verifier.test.ts` invariante `-mainnet` verde (Solana excluida del dominio EVM). |

**Regla:** cada archivo nuevo tiene ≥1 test. El settle real se cubre con mock de `Connection` (unit) + test de integración devnet **gated por `SOLANA_DEVNET_E2E`** (no depende de la red en CI). Total ≥10 tests + suite EVM intacta.

---

## 8. Auto-Blindaje pre-cargado (CD-11/12/13)

Errores recurrentes de HUs previas — evitarlos proactivamente:

- **CD-11 (TS2556, ≥3 HUs — ref WKH-191g auto-blindaje#2):** todo `vi.fn` reexpuesto via spread se tipa con rest param `unknown[]`:
  ```ts
  const mock = vi.fn((..._a: unknown[]): T => …);
  // reexposición: (...a) => mock(...a)
  ```
  NO dejar `vi.fn()` de aridad fija reexpuesto con spread → rompe tsc.

- **CD-12 (TS2488, `noUncheckedIndexedAccess` — ref audit B1a auto-blindaje#3):** accesos `mock.calls[N]` / destructuring de arrays usan `!` justificado o guard. Buscar el patrón proactivamente con grep antes de cerrar la wave.

- **CD-13 (verificación — lección WKH-196):** verificar con `npx tsc --noEmit` COMPLETO (incluye tests), **NO** solo `npm run build` (excluye tests). `Edit replace_all` no cubre ocurrencias con distinta indentación → tras extender `ChainKey`, confirmar que TODOS los switches/Records se resolvieron corriendo el tsc completo y arreglando cada error listado.

---

## 9. Definition of Done

- [ ] Los 10 ACs mapeados y cubiertos (§7): AC-1 (publish base58), AC-2 (settle SPL real), AC-3 (per-leg multichain), AC-4 (EVM byte-idéntico), AC-5 (base58 inválido rechaza), AC-6 (chain desconocido `CHAIN_NOT_SUPPORTED`), AC-7 (no doble-settle), AC-8 (ledger CAIP-2 aditivo), AC-9 (ownership guard), AC-10 (exhaustividad switch sin `any`/`default`).
- [ ] ≥10 tests nuevos verdes + suite EVM existente intacta (sin cambiar expectativas).
- [ ] `npx tsc --noEmit` COMPLETO verde (incluye tests — CD-13).
- [ ] Flag OFF (`SOLANA_ADAPTER_ENABLED=false`) → `getSupportedChains()` retorna EXACTAMENTE los 7 slugs actuales.
- [ ] Sin secrets en logs (`SOLANA_OPERATOR_PRIVATE_KEY` jamás logueado).
- [ ] `@solana/web3.js` / `@solana/spl-token` solo en `src/adapters/solana/*`.
- [ ] Sin hardcodes: todo Solana desde `process.env` con default documentado en `.env.example`.
- [ ] Ownership guard `owner_ref` preservado (reuso de `budget.debit(…, ownerRef)`).
- [ ] Waves W0→W5 completadas en orden, cada una con tsc + suite verdes antes de la siguiente.

---

> **Recordatorio de orden:** las waves son bloqueantes y secuenciales. Si `tsc --noEmit` COMPLETO o la suite no están verdes al cerrar una wave, NO avances a la siguiente.
