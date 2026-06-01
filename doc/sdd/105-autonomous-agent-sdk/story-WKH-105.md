# Story File — [WKH-105] Autonomía agéntica: SDK + agente de referencia

> Contrato autocontenido para el Dev (F3). **Si algo no está acá, no se hace.**
> Fuente: `doc/sdd/105-autonomous-agent-sdk/sdd.md` (SPEC_APPROVED). Server **read-only** (CD-4).
> Estructura confirmada en disco: el repo **NO es monorepo** (`package.json` sin `workspaces`), `packages/` **no existe todavía** (lo crea W0). `biome.json` raíz solo cubre `src/**/*.ts`. `vitest.config.ts` raíz **no** incluye `packages/**`.

---

## 0. Contexto compacto (qué se construye y por qué)

Un **SDK cliente TypeScript** (`@wasiai/agent-sdk`, clase `WasiAgent`) que expone el ciclo de vida
autónomo de un agente económico sobre wasiai-a2a — **provision → fondeo on-chain → identidad ERC-8004 → operar/pagar → reputación** — sin intervención humana, y un **agente de referencia runnable** (`examples/autonomous-agent.ts`) que lo usa end-to-end desde env vars.

El SDK reproduce, **tipado y mockeable**, el flujo de `examples/fund-agent-key.mjs` (provision) y `examples/delegation-demo.mjs` (delegate EIP-712). El mint ERC-8004 es **REAL** (no stub), gateado por env. El server **no se toca**.

---

## 1. ⚠️ Anti-Hallucination Checklist — LEER ANTES DE CODEAR

Marcá cada ítem mentalmente antes de escribir una línea. Violar cualquiera = retrabajo en CR/AR.

- [ ] **ABI del mint = `register(string agentURI) → uint256 agentId`** a **`msg.sender`** (la wallet del agente). NO existe `register(address owner, string tokenURI)` (eso era la propuesta INCORRECTA del work-item, corregida en SDD §3). NO inventes otra firma. ABI exacto en §4.2.
- [ ] **`token_id`/`agentId` se extrae parseando el log `Registered` del receipt** (CD-13). NUNCA re-leyendo un contador `_lastId` (no determinista). Evento: `Registered(uint256 indexed agentId, string agentURI, address indexed owner)` → `agentId` está en `topics[1]`.
- [ ] **EIP-712 (delegate): bigint al firmar, number en el JSON al server** (CD-10). `expires_at`→`BigInt(...)`, `allowed_chains`→`bigint[]` SOLO en el `message` que va a `signTypedData`. El `typed_data.message` y el `policy` que van en el body POST llevan los uint como **number**. PROHIBIDO pasar el JSON crudo a `signTypedData`. Ref WKH-101 W1.
- [ ] **La private key / `account` NUNCA va a stdout, logs, disco ni serialización.** `#account` es private field. `toJSON()`/`toString()` redactan. El `key` (token `wasi_a2a_*`) tampoco se devuelve en results ni se imprime (CD-5).
- [ ] **NO tocar el server.** Ningún archivo bajo `src/`. Si necesitás un tipo del server, **redeclaralo** en el SDK (el SDK no importa de `../src`).
- [ ] **`biome check --write` ANTES de cerrar cada wave** (CD-12). El SDK tiene su **propio** biome (root biome solo ve `src/`).
- [ ] **Inyección por config, NO mock global** (DT-11, lección WKH-103). `fetchImpl`, `walletClient`, `publicClient` se inyectan vía `WasiAgentConfig`. PROHIBIDO `vi.stubGlobal('fetch')` ni `vi.mock('viem')` global.
- [ ] **`vitest run` raíz (server) NO debe correr ni fallar por tests del SDK** (CD-9). W0 actualiza `vitest.config.ts` raíz para excluir `packages/**` (defensivo). Suite del SDK corre desde `packages/agent-sdk/`.
- [ ] **`InsufficientBudgetError` mapea AMBOS HTTP 402 y HTTP 403 con `body.error_code === 'INSUFFICIENT_BUDGET'`** (OBS-1). Con `x-a2a-key` (el camino del SDK) el server devuelve **403**, no 402. NUNCA reintenta (AC-7).
- [ ] **`ComposeStep` requiere `input: Record<string, unknown>` (NO opcional)** — verificado en `src/types/index.ts:226-233`. `operate()` DEBE enviar `input: {}` (o `{ goal }`) en cada step, además de `agent` y `registry`. Ver §4.5.
- [ ] **Sin hardcodes** (CD-1): treasury/token/chainId salen de `GET /auth/deposit-info`; RPC/registry/network de env. Tolerá `net.treasury === null`.
- [ ] **Sin `any` explícito / `as unknown`** (CD-3). TypeScript strict. Usá `unknown` + narrowing.
- [ ] **viem v2 solo** (CD-2). PROHIBIDO ethers.

---

## 2. Orden de waves (obligatorio, W0 primero y serial)

```
W0  estructura + tipos + errores + config        (serial, contratos) ── gate: tsc --noEmit SDK = 0; vitest raíz verde
W1  client.ts (HTTP) + wallet.ts (viem helpers)   ── gate: tsc SDK 0 errores
W2  agent.ts :: provision()                        ── gate: unit AC-1/AC-3
W3  identity.ts + agent.ts :: mintIdentity()       ── gate: unit AC-4/AC-5
W4  agent.ts :: discover/operate/delegate/getReputation + index.ts  ── gate: unit AC-6/AC-7/AC-8
W5  examples/autonomous-agent.ts + README          ── gate: tsx typecheck / e2e gated
W6  packages/agent-sdk/test/*.test.ts              ── gate: vitest SDK verde sin red + biome check
```

W1→W4 están acoplados por el cliente HTTP; respetá el orden secuencial. Los tests de W6 pueden escribirse incrementalmente por wave, pero el gate consolidado de "verde sin red" es W6.

---

## 3. Scope IN — archivos exactos a tocar

| # | Archivo | Wave | Crear/Editar |
|---|---------|------|--------------|
| 1 | `packages/agent-sdk/package.json` | W0 | crear |
| 2 | `packages/agent-sdk/tsconfig.json` | W0 | crear |
| 3 | `packages/agent-sdk/vitest.config.ts` | W0 | crear |
| 4 | `packages/agent-sdk/biome.json` | W0 | crear |
| 5 | `packages/agent-sdk/src/types.ts` | W0 | crear |
| 6 | `packages/agent-sdk/src/errors.ts` | W0 | crear |
| 7 | `packages/agent-sdk/src/config.ts` | W0 | crear |
| 8 | `vitest.config.ts` (raíz, server) | W0 | **editar** (solo agregar `exclude: ['packages/**']`) |
| 9 | `packages/agent-sdk/src/client.ts` | W1 | crear |
| 10 | `packages/agent-sdk/src/wallet.ts` | W1 | crear |
| 11 | `packages/agent-sdk/src/agent.ts` | W2/W3/W4 | crear (W2) + editar (W3, W4) |
| 12 | `packages/agent-sdk/src/identity.ts` | W3 | crear |
| 13 | `packages/agent-sdk/src/index.ts` | W4 | crear (barrel export) |
| 14 | `examples/autonomous-agent.ts` | W5 | crear |
| 15 | `examples/README-autonomous-agent.md` | W5 | crear |
| 16 | `packages/agent-sdk/test/provision.test.ts` | W6 | crear |
| 17 | `packages/agent-sdk/test/identity.test.ts` | W6 | crear |
| 18 | `packages/agent-sdk/test/operate.test.ts` | W6 | crear |
| 19 | `packages/agent-sdk/test/reputation.test.ts` | W6 | crear |
| 20 | `packages/agent-sdk/test/agent.test.ts` | W6 | crear |

**Scope OUT (PROHIBIDO tocar):** todo `src/**`, `tsconfig.json` raíz, `tsconfig.build.json`, `package.json` raíz, `biome.json` raíz, lockfile, deploy. La ÚNICA edición fuera de `packages/agent-sdk/` y `examples/` es agregar `exclude: ['packages/**']` al `vitest.config.ts` raíz (ítem 8).

---

## WAVE 0 — Estructura + contratos + tipos + errores + config

**Objetivo:** dejar el sub-paquete TS independiente compilando en vacío, con todos los tipos y clases de error definidos, sin lógica. Cubre: DT-1, DT-9, DT-2 (tipos), DT-8 (errores), CD-1/CD-3/CD-6/CD-9/CD-11.

### W0.1 — `packages/agent-sdk/package.json`

```json
{
  "name": "@wasiai/agent-sdk",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": { ".": "./dist/index.js" },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "lint": "biome check .",
    "format": "biome check --write ."
  },
  "peerDependencies": { "viem": "^2.47.6" },
  "devDependencies": {
    "@biomejs/biome": "^2.4.11",
    "@types/node": "^20.11.0",
    "typescript": "^5.4.0",
    "vitest": "^4.1.4"
  }
}
```
> `viem` es **peerDependency** (CD-6): se resuelve desde el `node_modules` raíz (ya instalado, `^2.47.6`). NO declarar `viem` como dependency. NO declarar `workspaces`.

### W0.2 — `packages/agent-sdk/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "rootDir": "./src",
    "outDir": "./dist",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```
> NO extiende del server. NodeNext → los imports relativos internos del SDK llevan extensión `.js` (ej. `import { WasiAgentError } from './errors.js'`).

### W0.3 — `packages/agent-sdk/vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
});
```
> SIN `env` de Supabase (irrelevante). SIN setup global. La suite corre con `npm --prefix packages/agent-sdk test` o `vitest run` desde `packages/agent-sdk/`.

### W0.4 — `packages/agent-sdk/biome.json`

```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.11/schema.json",
  "files": { "includes": ["src/**/*.ts", "test/**/*.ts"] },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2 },
  "linter": {
    "enabled": true,
    "rules": { "recommended": true, "suspicious": { "noExplicitAny": "error" } }
  },
  "javascript": { "formatter": { "quoteStyle": "single" } }
}
```
> El root `biome.json` solo cubre `src/**/*.ts` (verificado). El SDK necesita el suyo. `noExplicitAny: error` (CD-3).

### W0.5 — `packages/agent-sdk/src/types.ts`

Firmas EXACTAS (TS strict, sin `any`):

```ts
import type { LocalAccount, PublicClient, WalletClient } from 'viem';

export interface AgentCard {
  name: string;
  description: string;
  url: string;
}

export interface WasiAgentConfig {
  a2aBase: string;                              // ej. https://wasiai-a2a-production.up.railway.app
  network: string;                              // slug, matchea /auth/deposit-info (ej. 'base-sepolia')
  rpcUrl: string;
  chainId: number;                              // domain EIP-712 + viem chain (debe == server)
  identityRegistryAddress?: `0x${string}`;
  enableIdentityMint?: boolean;
  maxAgentBudgetUsd?: number;                   // undefined = sin tope
  // Inyectables para test (DT-11) — opcionales, defaults reales en el constructor:
  fetchImpl?: typeof fetch;
  walletClient?: WalletClient;
  publicClient?: PublicClient;
}

export interface ProvisionInput {
  ownerRef: string;
  amount: string;                               // string decimal, ej. '1.0' (parseUnits con token.decimals)
  displayName?: string;
}

// NUNCA incluye la PK ni el token `key`:
export interface ProvisionResult {
  keyId: string;
  balance: string;
  chainId: number;
  fundingWallet: `0x${string}`;                 // address pública (no es secreto)
  txHash: `0x${string}`;
}

export interface MintResult {
  skipped: boolean;
  reason?: string;                              // 'IDENTITY_MINT_DISABLED' cuando skipped
  tokenId?: string;
  chainId?: number;
  agentCardUri?: string;                        // el data: URI minteado (público)
  bindTxHash?: `0x${string}`;
  mintTxHash?: `0x${string}`;
}

export interface DiscoverQuery {
  goal?: string;                                // → q
  capabilities?: string[];
  maxPrice?: number;
  minReputation?: number;
  limit?: number;
  registry?: string;
  verified?: boolean;
}

// Subset tipado del Agent del server (el SDK NO importa de ../src):
export interface DiscoveredAgent {
  id: string;
  name: string;
  slug: string;
  priceUsdc: number;
  registry: string;
  registry_id: string;
  verified: boolean;
}

export interface OperateInput {
  goal: string;
}

export interface OperateResult {
  operated: boolean;
  reason?: string;                              // 'NO_AGENT_IN_BUDGET' cuando operated=false
  agentSlug?: string;
  payload?: unknown;
  kiteTxHash?: string;
}

// Reputación: subset tipado de AgentReputation del server (computedReputation):
export interface AgentReputation {
  score: number;
  tasks_settled: number;
  success_rate: number;
  total_volume_usdc: number;
  avg_latency_ms?: number;
  source: 'off-chain' | 'hybrid';
  onchain?: { value: string; chain_id: number };
}

export type ProvisionStep = 'signup' | 'bind' | 'transfer' | 'deposit';

export interface DelegationPolicy {
  max_amount_per_tx: string;
  max_total_amount: string;
  expires_at: number;                           // unix seconds (number en el JSON; bigint solo al firmar)
  allowed_chains: number[];                     // number[] en JSON; bigint[] solo al firmar
  allowed_agent_slugs: string[];
  allowed_registries: string[];
}

export interface DelegateResult {
  delegationId: string;
  sessionKeyAddress: `0x${string}`;
}
```

> Reexportá `LocalAccount` desde el barrel para que el caller la use sin importar viem directamente, pero NO la guardes en ningún result.

### W0.6 — `packages/agent-sdk/src/errors.ts` (DT-8 + CD-11)

Clase base + 4 subclases. **CD-11**: `message` público estable; el detalle crudo (`error.message` de viem/HTTP, body de PG) va a `cause`, que NO se serializa por default.

```ts
export class WasiAgentError extends Error {
  readonly code: string;
  readonly cause?: unknown;
  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'WasiAgentError';
    this.code = code;
    // cause no-enumerable → no aparece en JSON.stringify (anti-leak, CD-11)
    Object.defineProperty(this, 'cause', { value: cause, enumerable: false });
  }
}

export class ProvisionError extends WasiAgentError {
  readonly step: ProvisionStep;
  constructor(step: ProvisionStep, message: string, cause?: unknown) {
    super('PROVISION_FAILED', message, cause);
    this.name = 'ProvisionError';
    this.step = step;
  }
}

export class InsufficientBudgetError extends WasiAgentError {
  readonly keyId?: string;
  readonly chainId?: number;
  constructor(detail: string, keyId?: string, chainId?: number, cause?: unknown) {
    super('INSUFFICIENT_BUDGET', detail, cause);
    this.name = 'InsufficientBudgetError';
    this.keyId = keyId;
    this.chainId = chainId;
  }
}

export class IdentityMintError extends WasiAgentError {
  readonly stage: 'mint' | 'bind';
  constructor(stage: 'mint' | 'bind', message: string, cause?: unknown) {
    super('IDENTITY_MINT_FAILED', message, cause);
    this.name = 'IdentityMintError';
    this.stage = stage;
  }
}

export class OperationError extends WasiAgentError {
  readonly endpoint: string;
  readonly status: number;
  constructor(endpoint: string, status: number, message: string, cause?: unknown) {
    super('OPERATION_FAILED', message, cause);
    this.name = 'OperationError';
    this.endpoint = endpoint;
    this.status = status;
  }
}
```
> Importá `ProvisionStep` desde `./types.js`. NO pongas `cause` enumerable. NO copies `error.message` crudo de viem/PG al `message` público — usá un texto estable + `cause`.

### W0.7 — `packages/agent-sdk/src/config.ts` (CD-1)

Validador puro de `WasiAgentConfig`: lanza `WasiAgentError('INVALID_CONFIG', ...)` si falta `a2aBase`/`network`/`rpcUrl`/`chainId`. NO hardcodea defaults de red/treasury/token (esos salen de `/auth/deposit-info`). Resolución de viem chain por `chainId` (ver §4.4). Helper `resolveViemChain(chainId)` que mapea `8453→base`, `84532→baseSepolia`, `43113→avalancheFuji`, `43114→avalanche` (importados de `viem/chains`); para otros chainId construí un objeto `Chain` mínimo desde config (no hardcodear).

### W0.8 — `vitest.config.ts` raíz (ítem 8, defensivo CD-9)

Editar el array `exclude` actual (`['dist/**', 'node_modules/**']`) para incluir `'packages/**'`:
```ts
exclude: ['dist/**', 'node_modules/**', 'packages/**'],
```
> Único cambio fuera del SDK. NO toques `include` ni `env`.

**DoD W0:**
- `npm --prefix packages/agent-sdk run build` (o `tsc --noEmit` en el dir) → 0 errores.
- `npm run test` en la **raíz** (server) sigue verde y NO ejecuta nada de `packages/`.
- `npm --prefix packages/agent-sdk run lint` → 0 errores.

---

## WAVE 1 — `client.ts` (HTTP) + `wallet.ts` (viem helpers)

**Objetivo:** wrapper `fetch` tipado con header `x-a2a-key` y mapeo de errores; helpers viem (transfer, signMessage, signTypedData, mint+parse-log). Cubre: DT-8, CD-2, CD-10, CD-11, CD-13.

### W1.1 — `packages/agent-sdk/src/client.ts`

Patrón de `examples/fund-agent-key.mjs:51-58` (`api()`), tipado:

```ts
export interface A2AClientOptions {
  baseUrl: string;
  fetchImpl: typeof fetch;
  key?: string;                                 // token wasi_a2a_* — interno, nunca logueado
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  key?: string;
}

export class A2AClient {
  // request<T>(path, opts): Promise<T>
  // - headers: { 'Content-Type': 'application/json', ['x-a2a-key']: key }
  // - body: JSON.stringify(body) si body !== undefined
  // - res.ok === false → mapeo de error (ver abajo). NUNCA throw Error crudo.
}
```

**Mapeo de error (DT-8 + OBS-1):** al recibir `!res.ok`, parsear `body = await res.json().catch(() => ({}))` y:
- `status === 402` → `InsufficientBudgetError(detail, keyId?, chainId?, cause=body)`.
- `status === 403 && body.error_code === 'INSUFFICIENT_BUDGET'` → `InsufficientBudgetError(...)`. (confirmado `src/middleware/a2a-key.ts:528-532`: el server devuelve **403** con ese `error_code` cuando se paga con `x-a2a-key`).
- cualquier otro → `OperationError(path, status, stableMessage, cause=body)`.
- **CD-11:** `stableMessage` = texto fijo tipo `'request to <path> failed with status <status>'`; el `body` crudo va SOLO en `cause`. NO copies `body.error` ni `error.message` de PG al mensaje público.

### W1.2 — `packages/agent-sdk/src/wallet.ts`

ABI ERC-20 inline `as const` (patrón `fund-agent-key.mjs:46-47` + `erc8004-identity.ts:51-66`):

```ts
export const ERC20_ABI = [
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }] },
] as const;
```

Helpers (todos reciben el `WalletClient`/`PublicClient`/`LocalAccount` como argumento — inyectables):
- `transferErc20(wallet, { token, to, amount }): Promise<\`0x${string}\`>` → `wallet.writeContract({ address: token, abi: ERC20_ABI, functionName: 'transfer', args: [to, amount] })`. `amount` se calcula con `parseUnits(amountStr, decimals)` en `agent.ts` (NO acá).
- `waitReceipt(publicClient, hash, confirmations): Promise<TransactionReceipt>` → `publicClient.waitForTransactionReceipt({ hash, confirmations })`.
- `signBindMessage(account, keyId): Promise<\`0x${string}\`>` → `account.signMessage({ message: \`WASIAI_BIND_FUNDING_WALLET:${keyId}\` })` (mensaje canónico confirmado `src/routes/auth.ts:63-64`).
- `signDelegation(account, { domain, types, message }): Promise<\`0x${string}\`>` → `account.signTypedData({ domain, types, primaryType: 'Delegation', message })`. **CD-10:** el `message` que entra acá ya tiene `expires_at: BigInt(...)` y `allowed_chains: bigint[]`. Construcción del split en §4.3.

**Mint + parse-log (CD-13):** ver §4.2 (vive en `identity.ts`, pero el `writeContract` del mint y el helper de parseo del log `Registered` pueden vivir acá o en identity; mantenelo coherente — el SDD ubica el ABI mint en `identity.ts`).

**DoD W1:** `tsc --noEmit` SDK 0 errores. (Tests de client/wallet entran en W6.)

---

## WAVE 2 — `agent.ts` :: `provision()`

**Objetivo:** clase `WasiAgent` + `provision()` end-to-end secuencial. Cubre: AC-1, AC-2, AC-3, DT-2, CD-1, CD-5, CD-8.

### W2.1 — `packages/agent-sdk/src/agent.ts` (esqueleto + provision)

```ts
import type { LocalAccount } from 'viem';
import { createPublicClient, createWalletClient, http, parseUnits } from 'viem';
import type { PublicClient, WalletClient } from 'viem';
// ... types, errors, client, wallet, config

export class WasiAgent {
  readonly #account: LocalAccount;              // NUNCA expuesto por getter (CD-5)
  readonly #config: WasiAgentConfig;
  readonly #client: A2AClient;
  readonly #wallet: WalletClient;
  readonly #public: PublicClient;
  #key?: string;                                // token wasi_a2a_* — interno
  #keyId?: string;

  constructor(account: LocalAccount, config: WasiAgentConfig) {
    validateConfig(config);                     // CD-1
    this.#account = account;
    this.#config = config;
    const chain = resolveViemChain(config.chainId, config.rpcUrl);
    this.#wallet = config.walletClient
      ?? createWalletClient({ account, chain, transport: http(config.rpcUrl) });
    this.#public = config.publicClient
      ?? createPublicClient({ chain, transport: http(config.rpcUrl) });
    this.#client = new A2AClient({ baseUrl: config.a2aBase, fetchImpl: config.fetchImpl ?? globalThis.fetch });
  }

  // CD-5: anti-leak. NUNCA exponer #account ni #key.
  toJSON(): Record<string, unknown> {
    return { network: this.#config.network, chainId: this.#config.chainId, address: this.#account.address, keyId: this.#keyId ?? null };
  }
  toString(): string { return `WasiAgent(address=${this.#account.address}, network=${this.#config.network})`; }

  get address(): `0x${string}` { return this.#account.address; }   // OK: address es pública

  async provision(input: ProvisionInput): Promise<ProvisionResult> { /* ... */ }
}
```

**Flujo de `provision()` — SECUENCIAL (CD-8), cada step en su try → `ProvisionError(step, ...)`** (reproduce `fund-agent-key.mjs:60-99`):

1. **deposit-info** — `GET /auth/deposit-info` (sin key). Buscar `net = networks.find(n => n.slug === config.network)`. Si no existe → `ProvisionError('signup', 'network <slug> not available')`. Si `net.treasury == null` → `ProvisionError('transfer', 'treasury not configured for <slug>')`. Extraer `treasury`, `token.{address,decimals,symbol}`, `chain_id`, `min_confirmations`.
2. **signup** — `POST /auth/agent-signup { owner_ref: input.ownerRef, display_name: input.displayName ?? 'autonomous-agent' }` → `{ key, key_id }`. Guardar `this.#key = key; this.#keyId = key_id`. Error → `ProvisionError('signup', ...)`.
3. **bind** — `signBindMessage(#account, key_id)` → `POST /auth/funding-wallet { wallet: #account.address, signature }` con `key`. Error → `ProvisionError('bind', ...)`.
4. **transfer** — `amount = parseUnits(input.amount, token.decimals)`; `txHash = transferErc20(#wallet, { token: token.address, to: treasury, amount })`; `await waitReceipt(#public, txHash, min_confirmations)`. Error (revert / RPC) → `ProvisionError('transfer', ...)`. (AC-3)
5. **deposit** — `POST /auth/deposit { key_id, tx_hash: txHash, chain_id }` con `key` → `{ balance, chain_id }`. Error → `ProvisionError('deposit', ...)`.
6. **return** `{ keyId: key_id, balance, chainId: chain_id, fundingWallet: #account.address, txHash }`. **NO** incluye `key` ni PK (CD-5).

> CD-8: NO `Promise.all` sobre writes. `transfer` y `deposit` con `await` estricto, uno después del otro.

**DoD W2:** unit `test/provision.test.ts` (W6) verde para AC-1 (happy) y AC-3 (transfer fail). `tsc` 0 errores. `biome check` 0.

---

## WAVE 3 — `identity.ts` + `agent.ts` :: `mintIdentity()`

**Objetivo:** mint ERC-8004 REAL gateado por env + bind. Cubre: AC-4, AC-5, DT-4, DT-5, CD-7, CD-13.

### W3.1 — `packages/agent-sdk/src/identity.ts`

**ABI mint EXACTO (CONFIRMADO, NO inventar — SDD §3):**

```ts
export const IDENTITY_REGISTRY_ABI = [
  { name: 'register', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'agentURI', type: 'string' }],
    outputs: [{ name: 'agentId', type: 'uint256' }] },
  { type: 'event', name: 'Registered',
    inputs: [
      { name: 'agentId', type: 'uint256', indexed: true },
      { name: 'agentURI', type: 'string', indexed: false },
      { name: 'owner', type: 'address', indexed: true },
    ] },
] as const;
```

Helpers:
- `buildAgentCardUri(card: AgentCard): string` (DT-5) → `data:application/json;base64,${Buffer.from(JSON.stringify(card)).toString('base64')}`. Card mínimo `{ name, description, url }`; `url = \`${a2aBase}/agents/${account.address}\``.
- `mintIdentityOnChain(wallet, publicClient, { registryAddress, agentURI }): Promise<{ tokenId: string; txHash: \`0x${string}\` }>`:
  1. `txHash = await wallet.writeContract({ address: registryAddress, abi: IDENTITY_REGISTRY_ABI, functionName: 'register', args: [agentURI] })`.
  2. `receipt = await publicClient.waitForTransactionReceipt({ hash: txHash })`.
  3. **CD-13:** parsear el log `Registered` del receipt con viem `decodeEventLog({ abi: IDENTITY_REGISTRY_ABI, data, topics })` sobre los `receipt.logs`, encontrar el evento `Registered`, leer `args.agentId` (bigint) → `tokenId = agentId.toString()`. NUNCA re-leer un contador. Si no aparece el log → `IdentityMintError('mint', 'Registered event not found in receipt')`.

### W3.2 — `agent.ts` :: `mintIdentity(card?: Partial<AgentCard>): Promise<MintResult>`

**Gate (CD-7):** mintea SOLO si `config.enableIdentityMint === true` **Y** `config.identityRegistryAddress` está seteada. Caso contrario:
```ts
return { skipped: true, reason: 'IDENTITY_MINT_DISABLED' };
```
(El agente de referencia loguea `IDENTITY_SKIP: mint disabled (set ENABLE_IDENTITY_MINT=true + ERC8004_REGISTRY_ADDRESS)` y continúa — AC-5.)

Si el gate pasa:
1. Construir card: `{ name: card?.name ?? \`agent-${address}\`, description: card?.description ?? 'Autonomous WasiAI agent', url: card?.url ?? \`${a2aBase}/agents/${address}\` }`. `agentURI = buildAgentCardUri(card)`.
2. `{ tokenId, txHash } = await mintIdentityOnChain(...)`. Error → `IdentityMintError('mint', ...)`.
3. `POST /auth/erc8004/bind { token_id: tokenId }` con `#key` (omitir `agent_slug`/`agent_registry` — bind sin ancla, válido: `src/routes/auth.ts:644` los exige JUNTOS o NINGUNO). Error → `IdentityMintError('bind', ...)`.
4. `return { skipped: false, tokenId, chainId: config.chainId, agentCardUri: agentURI, mintTxHash: txHash, bindTxHash }`.

> Requiere haber hecho `provision()` antes (necesita `#key` para el bind). Si no hay `#key` → `IdentityMintError('bind', 'provision() must run before mintIdentity()')`.

**DoD W3:** unit `test/identity.test.ts` (W6) verde para AC-4 (mint con receipt mockeado que trae el log `Registered`) y AC-5 (skip sin error). `tsc`/`biome` 0.

---

## WAVE 4 — `discover` + `operate` + `delegate` + `getReputation` + `index.ts`

**Objetivo:** ciclo de operación/pago + delegación + reputación + barrel export. Cubre: AC-6, AC-7, AC-8, DT-6, DT-7, DT-10, CD-10, OBS-1, OBS-4.

### W4.1 — `agent.ts` :: `discover(query: DiscoverQuery): Promise<DiscoveredAgent[]>`

`POST /discover { q: query.goal, capabilities?, maxPrice?, minReputation?, limit?, registry?, verified? }` con `#key`. Respuesta `{ agents, total, registries }` → retornar `agents` (subset tipado `DiscoveredAgent[]`). El server ya filtra a `status==='active'` (DT-10): el SDK **NO** re-filtra status.

### W4.2 — `agent.ts` :: `operate(input: OperateInput): Promise<OperateResult>`

1. `agents = await this.discover({ goal: input.goal })`.
2. Selección determinista (DT-10): `target = agents.find(a => config.maxAgentBudgetUsd === undefined || a.priceUsdc <= config.maxAgentBudgetUsd)` (el **primero** del array que cumple; el orden lo define el server). Si no hay → `return { operated: false, reason: 'NO_AGENT_IN_BUDGET' }` (NO error).
3. `POST /compose` con `#key`, body:
   ```ts
   { steps: [{ agent: target.slug, registry: target.registry_id, input: {} }] }
   ```
   **⚠️ `input` es OBLIGATORIO** en `ComposeStep` (`src/types/index.ts:226-233`) — usá `input: {}` si no hay payload del goal. **OBS-4:** se pasa `registry: target.registry_id` (PK canónico); el server resuelve precio vía `resolveAgentPriceUsdc(agent, registry)` (`src/routes/compose.ts:48-52`). Si en runtime el server rechaza el `registry_id` y espera `target.registry` (display name), ajustá el campo según el comportamiento verificado (ambos están en `DiscoveredAgent`).
4. Respuesta OK `{ kiteTxHash, ...result }` → `return { operated: true, agentSlug: target.slug, payload: result, kiteTxHash }`.
5. **AC-7 / OBS-1:** si el cliente lanza `InsufficientBudgetError` (mapeado de 402 **o** 403+code en W1), **propagalo tal cual, sin retry**. NO lo captures para reintentar.

### W4.3 — `agent.ts` :: `delegate(policy: DelegationPolicy): Promise<DelegateResult>`

Reproduce `examples/delegation-demo.mjs:42-79`, tipado. **CD-10 (split bigint/number):**
```ts
const session = privateKeyToAccount(generatePrivateKey());          // session key efímera
const nonce = `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
const domain = { name: 'WasiAI-a2a Delegation', version: '1', chainId: config.chainId };  // SIN verifyingContract
const types = { Delegation: [...], DelegationPolicy: [...] };        // exacto de delegation-demo.mjs:52-66
// PARA FIRMAR — uint a bigint:
const signMsg = {
  session_key: session.address,
  policy: { ...policy, expires_at: BigInt(policy.expires_at), allowed_chains: policy.allowed_chains.map(BigInt) },
  nonce,
};
const signature = await signDelegation(this.#account, { domain, types, message: signMsg });
// PARA EL SERVER — uint como number (policy crudo):
const typed_data = { domain, types, primaryType: 'Delegation', message: { session_key: session.address, policy, nonce } };
const created = await this.#client.request('/auth/delegation', { method: 'POST', key: this.#key, body: { typed_data, signature, session_key_address: session.address, policy } });
return { delegationId: created.delegation_id ?? created.id, sessionKeyAddress: session.address };
```
> `domain` SIN `verifyingContract`. `types` idéntico a `delegation-demo.mjs:52-66`. PROHIBIDO pasar el `policy` crudo (con number) a `signTypedData`.

### W4.4 — `agent.ts` :: `getReputation(input: { agentSlug: string }): Promise<AgentReputation | null>`

`GET /agents/${input.agentSlug}/agent-card` (sin key necesaria; público). Respuesta = AgentCard JSON. Retornar `card.computedReputation ?? null` (el campo es **opcional/omitido** si no hay score — `src/routes/agent-card.ts:74-81`). 404 → `OperationError('/agents/:slug/agent-card', 404, ...)`.

### W4.5 — `packages/agent-sdk/src/index.ts` (barrel)

Export: `WasiAgent`, todos los tipos de `types.ts`, todas las clases de error de `errors.ts`. Reexportá `LocalAccount` de viem para conveniencia del caller.

**DoD W4:** unit `test/operate.test.ts` (AC-6, AC-7) + `test/reputation.test.ts` (AC-8) verdes. `tsc`/`biome` 0.

---

## WAVE 5 — `examples/autonomous-agent.ts` + README

**Objetivo:** agente de referencia runnable end-to-end. Cubre: AC-9, AC-10, DT-3, CD-1, CD-5.

### W5.1 — `examples/autonomous-agent.ts`

Importa el SDK por **source path relativo** (DT-9, NodeNext): `import { WasiAgent } from '../packages/agent-sdk/src/index.js';`. Se corre con `tsx` (ya en devDeps raíz). NO requiere build previo del SDK.

Lee TODO de env (DT-3, defaults degradables):
- `A2A_BASE` (default `https://wasiai-a2a-production.up.railway.app`)
- `NETWORK` (default `base-sepolia`)
- `RPC_URL` (default por network: base-sepolia→`https://sepolia.base.org`, avalanche-fuji→`https://api.avax-test.network/ext/bc/C/rpc`)
- `CHAIN_ID` (default por network: base-sepolia→84532, avalanche-fuji→43113)
- `FUNDER_PK` (REQUERIDO — sin él `process.exit(1)`)
- `AMOUNT` (default `'1.0'`), `OWNER_REF` (default `'autonomous-agent-demo'`)
- `ENABLE_IDENTITY_MINT` (`=== 'true'`), `ERC8004_REGISTRY_ADDRESS`, `MAX_AGENT_BUDGET_USD` (Number, undefined si no seteado)

Patrón PK (de `fund-agent-key.mjs:70`): `const normPk = (s) => \`0x${(s||'').replace(/[^0-9a-fA-F]/g,'').slice(-64)}\``; `const account = privateKeyToAccount(normPk(FUNDER_PK))`.

Ciclo (log estructurado por step, exit 0 al final):
1. `await agent.provision({ ownerRef, amount })` → log `1. provisioned keyId=... balance=...` (NUNCA imprimir `key`/PK).
2. `const mint = await agent.mintIdentity()` → si `mint.skipped` log `IDENTITY_SKIP: mint disabled (...)`; si no, log `2. minted tokenId=...`.
3. `const op = await agent.operate({ goal })` (goal de env `GOAL` default `'summarize text'`) → si `!op.operated` log `OPERATE_SKIP: ${op.reason}` y **exit 0**; si no log `3. operated agent=${op.agentSlug} tx=${op.kiteTxHash}`.
4. `const rep = await agent.getReputation({ agentSlug: op.agentSlug })` (solo si operó) → log `4. reputation=${JSON.stringify(rep)}`.
5. `process.exit(0)`.

**AC-10 (anti-leak en error):** envolver todo en `try/catch`. En catch: `console.error(\`STEP_FAILED step=${err.step ?? err.code ?? '?'} code=${err.code} message=${err.message}\`)`; **NUNCA** imprimir `account`, `key`, `err.cause`, ni `JSON.stringify(agent)` (que de todas formas redacta por `toJSON`). `process.exit(1)`. El `InsufficientBudgetError` y `ProvisionError` exponen `.step`/`.code` sin la PK.

### W5.2 — `examples/README-autonomous-agent.md`

Documentar: env vars + defaults, prerequisito de gas/USDC testnet (OBS-3, MI-5), comando de run (`A2A_BASE=... FUNDER_PK=0x... NETWORK=base-sepolia npx tsx examples/autonomous-agent.ts`), gate del mint (`ENABLE_IDENTITY_MINT=true ERC8004_REGISTRY_ADDRESS=0x...`), y aclaración de que el SDK no requiere build (import por source). Direcciones canónicas del registry SOLO como referencia doc (SDD §3), NO hardcodeadas en el código.

**DoD W5:** `npx tsc --noEmit` sobre el ejemplo (o `tsx --check`) sin errores de tipo. E2E real es gated `RUN_E2E` (manual, no CI).

---

## WAVE 6 — Tests (vitest, sin red)

**Objetivo:** ≥1 test por AC, todos sin red ni env (DT-11, AC-11, CD-9, CD-12). Inyección por config (`fetchImpl`, `walletClient`, `publicClient` mockeados con `vi.fn()`). PROHIBIDO `vi.stubGlobal('fetch')` / `vi.mock('viem')`.

| Archivo | Tests | AC |
|---------|-------|----|
| `test/provision.test.ts` | happy path (signup→bind→transfer→deposit en orden; `parseUnits(amount, decimals)`; espera `min_confirmations`; result SIN `key`/PK); transfer revert → `ProvisionError` `step==='transfer'`; RPC down → idem | AC-1, AC-2, AC-3 |
| `test/identity.test.ts` | gate ON → `register(string)` con `data:` URI base64; `tokenId` extraído del log `Registered`; bind 200; gate OFF → `{skipped:true}` sin writeContract | AC-4, AC-5 |
| `test/operate.test.ts` | discover 2 agentes → primer dentro de budget → compose con `steps:[{agent,registry,input:{}}]` → payload; sin candidato → `{operated:false,reason:'NO_AGENT_IN_BUDGET'}`; compose **403 INSUFFICIENT_BUDGET** → `InsufficientBudgetError` sin retry; compose **402** → mismo error (OBS-1) | AC-6, AC-7 |
| `test/reputation.test.ts` | agent-card con `computedReputation` → lo retorna; sin el campo → `null` | AC-8 |
| `test/agent.test.ts` | en cualquier error, `JSON.stringify(agent)` y `agent.toString()` NO contienen la PK ni el token `key`; `toJSON` redacta; ningún `globalThis.fetch` real invocado (todos los mocks por config) | AC-10, AC-11 |

**Patrón de mock (DT-11):**
```ts
const fetchImpl = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => ({ /* shape */ }) })) as unknown as typeof fetch;
const walletClient = { writeContract: vi.fn(async () => '0x..' as `0x${string}`), account: testAccount } as unknown as WalletClient;
const publicClient = { waitForTransactionReceipt: vi.fn(async () => ({ logs: [/* Registered log */] })) } as unknown as PublicClient;
const agent = new WasiAgent(testAccount, { a2aBase: 'http://x', network: 'base-sepolia', rpcUrl: 'http://x', chainId: 84532, fetchImpl, walletClient, publicClient });
```
> El `as unknown as` es aceptable **solo en tests** para shaping de mocks (no en `src/`). El `testAccount` = `privateKeyToAccount(generatePrivateKey())` (PK efímera de test, nunca real).

**DoD W6 (consolidado, cierre de la HU):**
- `npm --prefix packages/agent-sdk test` → **verde sin env vars ni red** (CD-9, AC-11).
- `npm run test` en la **raíz** → verde, sin ejecutar `packages/**` (CD-9).
- `npm --prefix packages/agent-sdk run build` → 0 errores (tsc).
- `npm --prefix packages/agent-sdk run lint` (`biome check .`) → 0 errores. Corré `format` antes (CD-12).
- `npm run build` en la **raíz** (server, `tsc -p tsconfig.build.json`) → 0 errores, **build del server intacto** (no ve `packages/` ni `examples/`).

---

## 7. Done Definition (de la HU completa)

- [ ] Todos los archivos de Scope IN creados/editados; **0 archivos de `src/**` modificados** (CD-4), única edición externa = `vitest.config.ts` raíz `exclude: ['packages/**']`.
- [ ] `WasiAgent` con la API exacta de §4 (constructor + 6 métodos), sin `any` (CD-3).
- [ ] ABI mint = `register(string)` a `msg.sender`; `tokenId` parseado del log `Registered` (CD-13).
- [ ] EIP-712 delegate con split bigint(firma)/number(JSON) (CD-10).
- [ ] PK/`account`/`key` nunca serializados ni logueados; `toJSON`/`toString` redactan; results sin secretos (CD-5).
- [ ] Mint gateado por `enableIdentityMint && identityRegistryAddress` (CD-7); skip loguea `IDENTITY_SKIP` y continúa.
- [ ] `InsufficientBudgetError` mapea 402 **y** 403+`INSUFFICIENT_BUDGET`, sin retry (OBS-1, AC-7).
- [ ] `operate()` envía `input: {}` en el `ComposeStep` (campo obligatorio).
- [ ] Sin hardcodes de treasury/token/chainId/registry/RPC (CD-1); viem v2, no ethers (CD-2).
- [ ] Suite del SDK verde sin red; `vitest run` raíz verde sin tocar el SDK (CD-9); `biome check` SDK 0 (CD-12); server build intacto.
- [ ] `examples/autonomous-agent.ts` runnable desde env, exit 0/1 con step name, anti-leak en error (AC-9, AC-10).

---

## 8. Exemplars verificados (paths reales — confirmados con Read)

| Exemplar | Qué copiar |
|----------|-----------|
| `examples/fund-agent-key.mjs:30-100` | provision end-to-end: `api()` helper, deposit-info, signup, bind (`signMessage`), `parseUnits`, ERC-20 transfer, `waitForTransactionReceipt(min_conf)`, deposit. `normPk` (`:70`). |
| `examples/delegation-demo.mjs:42-79` | delegate EIP-712: domain SIN verifyingContract, types, split bigint(firma)/number(JSON), session key efímera. |
| `src/adapters/erc8004-identity.ts:51-66, 130-133` | ABI inline `as const`; clasificación revert vs transporte. Chain ids Base (`:120-122`). |
| `src/types/index.ts:118-150, 226-233` | shape de `Agent` (subset → `DiscoveredAgent`), `AgentReputation`, **`ComposeStep.input` OBLIGATORIO**. |
| `src/middleware/a2a-key.ts:528-532` | server devuelve **403** `INSUFFICIENT_BUDGET` con `x-a2a-key` (OBS-1). |
| `src/routes/compose.ts:43-60` | `resolveAgentPriceUsdc(step.agent, step.registry)` usa el `registry` del step (OBS-4). |
| `src/routes/agent-card.ts:74-81` | `computedReputation` omitido (undefined) si no hay score. |
| `package.json` / `biome.json` / `tsconfig.json` / `vitest.config.ts` raíz | confirmado: sin `workspaces`; biome solo `src/**`; vitest sin `packages/**`. |
