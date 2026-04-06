# SDD-018 — Gasless Integration EIP-3009 (testnet only PYUSD) — WKH-29

| Campo | Valor |
|-------|-------|
| HU | WKH-29 |
| Epic | WKH-4 (Sprint 4 — Polish + Diferenciadores) |
| Tipo | feature (hackathon bonus) |
| Mode | QUALITY |
| SDD_MODE | full |
| Branch | `feat/018-gasless-aa` |
| Base | `main` |
| Sizing | S (~100 LOC lib + ~40 LOC route + ~80 LOC tests + ~15 LOC tipos) |
| Riesgo | Bajo (testnet only, dependencia externa aislada por feature flag) |
| Fecha | 2026-04-06 |
| SPEC_APPROVED | no |

---

## 1. Resumen

WKH-29 agrega soporte gasless para transfers de stablecoin (PYUSD) en Kite Testnet usando el relayer oficial `gasless.gokite.ai` y el estándar EIP-3009 `TransferWithAuthorization`. Se reusa el patrón EIP-712 con `viem` ya consolidado en `src/lib/x402-signer.ts`. La feature es opt-in (`GASLESS_ENABLED=false` por defecto) y vive en un módulo independiente del path x402, sin tocar el middleware de pago existente. Mainnet (USDC.e) y la convergencia gasless ↔ x402 quedan fuera de scope (WKH-33).

---

## 2. Context Map (Codebase Grounding — verificado con Read)

### Archivos leídos y patrones extraídos

| Archivo | Líneas relevantes | Patrón / símbolo verificado | Reuso en WKH-29 |
|---------|-------------------|------------------------------|-----------------|
| `src/lib/x402-signer.ts` | L7-9 imports `createWalletClient`, `http`, `privateKeyToAccount` | EIP-712 signing con viem | **Exemplar principal** del nuevo `gasless-signer.ts` |
| `src/lib/x402-signer.ts` | L39-57 `_walletClient` lazy singleton + `getWalletClient()` con guard de `OPERATOR_PRIVATE_KEY` | Lazy singleton WalletClient | Replicar tal cual en `gasless-signer.ts` (singleton independiente) |
| `src/lib/x402-signer.ts` | L93-106 `client.signTypedData({account, domain, types, primaryType, message})` con `BigInt(...)` para uint256 y `nonce as 0x${string}` | Firma EIP-712 con viem 2.47.6 | Misma API; cambia primaryType a `TransferWithAuthorization` y types al schema EIP-3009 |
| `src/lib/x402-signer.ts` | L82 `randomBytes(32).toString('hex')` para nonce | Generación de nonce 32-byte | Reusar `node:crypto.randomBytes` |
| `src/lib/x402-signer.ts` | L125-127 `_resetWalletClient()` `@internal` para tests | Reset de singleton | Replicar `_resetGaslessSigner()` para vitest |
| `src/lib/kite-chain.ts` | L10-33 `kiteTestnet = defineChain({ id: 2368, ... })` | Chain definition reutilizable | Usar `kiteTestnet` para `createWalletClient({chain: kiteTestnet})` |
| `src/services/kite-client.ts` | L19-42 `initKiteClient()` + `export const kiteClient` (top-level await) | PublicClient singleton | Importar `requireKiteClient()` para `getBlock({blockTag: 'latest'})` (AC-3) |
| `src/services/kite-client.ts` | L48-55 `requireKiteClient()` lanza si null | Guard helper | Usar dentro de `signTransferWithAuthorization()` para timestamp del bloque |
| `src/index.ts` | L11-19 imports de rutas + L48-56 `fastify.register(routes, { prefix })` | Patrón de registro Fastify | Insertar registro condicional de `gaslessRoutes` con prefix `/gasless` |
| `src/index.ts` | L22 import `kiteClient` con side-effect (top-level await) | Init implícita en import | Gasless signer NO necesita top-level await: lazy on first call |
| `src/routes/dashboard.ts` | L9 `FastifyPluginAsync, FastifyRequest, FastifyReply` + L21-67 plugin async export default | Patrón Fastify route plugin | **Exemplar** para `src/routes/gasless.ts` |
| `src/types/index.ts` | L222-260 sección `// x402 PROTOCOL TYPES` con interfaces tipadas | Convención: secciones banner + interfaces explícitas | Agregar nueva sección `// GASLESS TYPES (WKH-29)` al final |
| `package.json` | L19 `viem: ^2.47.6`, sin `ethers` | Stack viem-only | CD-7 garantizado |
| `.env.example` | L1-37 vars existentes | Estilo de comentarios y agrupación | Agregar bloque `# Gasless (EIP-3009)` |

### Verificación runtime de viem 2.47.6

| Símbolo | Verificación | Resultado |
|---------|--------------|-----------|
| `signTypedData` | usado en `x402-signer.ts:93` | Existe (método de WalletClient) |
| `hexToSignature` | `node -e "require('viem').hexToSignature"` | **EXISTE** (`function`) |
| `parseSignature` | idem | También existe (alternativa) |
| `createWalletClient` / `privateKeyToAccount` / `http` | imports en `x402-signer.ts:7-8` | Existen |
| `requireKiteClient().getBlock(...)` | método estándar de PublicClient viem | Disponible |

### Drift detectado

- `.nexus/project-context.md` menciona stack con **Redis + BullMQ** (L16, L60-62) pero `package.json` NO lo incluye. Para WKH-29 es **irrelevante** (no se usan colas), pero queda registrado como drift documental del proyecto.
- `.nexus/project-context.md` describe estructura `src/lib/viem.ts` (L162) pero el repo real usa `src/lib/kite-chain.ts` + `src/services/kite-client.ts`. Tampoco impacta a WKH-29.

---

## 3. Acceptance Criteria (copia literal del work-item v3)

| AC | Texto resumido |
|----|----------------|
| AC-1 | Sign EIP-3009 + POST a `https://gasless.gokite.ai/testnet` → recibe `txHash` |
| AC-2 | viem `signTypedData()` con domain de `/supported_tokens` + decompose v/r/s con `hexToSignature()` |
| AC-3 | `validAfter` = `block.timestamp - 1`; `validBefore` = `validAfter + 25` |
| AC-4 | Query `/supported_tokens` con cache; fallback hardcoded a PYUSD `0x8E04…2ec9`; valida `value >= minimum_transfer_amount` |
| AC-5 | Feature flag `GASLESS_ENABLED` (PYUSD only en testnet) |
| AC-6 | Errores del relayer logueados sin secretos (CD-1), aislados, no crash |
| AC-7 | `GET /gasless/status` retorna `{enabled, network, supportedToken, operatorAddress}` (sin private key) |

> Texto integral: ver `doc/sdd/018-gasless-aa/work-item.md` §"Acceptance Criteria".

---

## 4. Diseño técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `src/lib/gasless-signer.ts` | CREAR | Core EIP-3009: token discovery + sign + submit + status | `src/lib/x402-signer.ts` |
| `src/lib/gasless-signer.test.ts` | CREAR | Tests unitarios con mocks (fetch, getBlock, signTypedData) | nuevo (no hay tests previos en `src/lib/`) |
| `src/types/index.ts` | MODIFICAR | Nueva sección `// GASLESS TYPES (WKH-29)` | sección `x402 PROTOCOL TYPES` (L222-260) |
| `src/routes/gasless.ts` | CREAR | `GET /status` (handler `GET /gasless/status` con prefix) | `src/routes/dashboard.ts` |
| `src/index.ts` | MODIFICAR | Import + registro condicional `if (process.env.GASLESS_ENABLED === 'true')` | bloque L11-19 + L48-56 |
| `.env.example` | MODIFICAR | Bloque `# Gasless (EIP-3009)` con `GASLESS_ENABLED`, `OPERATOR_PRIVATE_KEY` | bloques existentes |

### 4.2 Tipos a agregar (`src/types/index.ts`)

```ts
// ============================================================
// GASLESS TYPES (WKH-29 — EIP-3009)
// ============================================================

export interface GaslessSupportedToken {
  network: 'testnet' | 'mainnet'
  symbol: string                  // "PYUSD"
  address: `0x${string}`          // 0x8E04…2ec9
  decimals: number                // 18
  eip712Name: string              // "PYUSD"
  eip712Version: string           // "1"
  minimumTransferAmount: string   // wei string ("10000000000000000")
}

export interface GaslessTransferRequest {
  from: `0x${string}`
  to: `0x${string}`
  value: string                   // wei
  validAfter: string              // unix seconds (string)
  validBefore: string             // unix seconds (string)
  tokenAddress: `0x${string}`
  nonce: `0x${string}`            // 0x + 32 random bytes
  v: number
  r: `0x${string}`
  s: `0x${string}`
}

export interface GaslessTransferResponse {
  txHash: `0x${string}`
}

export interface GaslessStatus {
  enabled: boolean
  network: 'kite-testnet'
  supportedToken: GaslessSupportedToken | null
  operatorAddress: `0x${string}` | null   // NUNCA private key
}
```

### 4.3 Estructura de `src/lib/gasless-signer.ts`

#### Constantes (top of file)

```ts
const GASLESS_BASE_URL = 'https://gasless.gokite.ai'
const GASLESS_SUBMIT_URL = `${GASLESS_BASE_URL}/testnet`           // CD-8
const GASLESS_TOKENS_URL = `${GASLESS_BASE_URL}/supported_tokens`
const VALIDITY_WINDOW_SECONDS = 25                                  // CD-6
const FALLBACK_TOKEN: GaslessSupportedToken = { /* PYUSD hardcoded */ }
const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const
```

#### Funciones públicas (firmas exactas)

| # | Firma | Responsabilidad | AC |
|---|-------|-----------------|----|
| 1 | `export async function getSupportedToken(): Promise<GaslessSupportedToken>` | Fetch `/supported_tokens`, cache memoria, fallback hardcoded si falla. NO loggear payload | AC-4 |
| 2 | `export async function signTransferWithAuthorization(opts: { to: \`0x${string}\`; value: bigint }): Promise<GaslessTransferRequest>` | Obtiene token, valida `value >= minimumTransferAmount` (CD-9), `getBlock({blockTag:'latest'})` para `validAfter = ts - 1`, `validBefore = validAfter + 25`, genera nonce, firma EIP-712, decompone con `hexToSignature` | AC-2, AC-3, AC-4 |
| 3 | `export async function submitGaslessTransfer(payload: GaslessTransferRequest): Promise<GaslessTransferResponse>` | `POST` JSON al relayer, parsea response, log solo `txHash` (CD-1). Errores → throw con mensaje sanitizado | AC-1, AC-6 |
| 4 | `export async function getGaslessStatus(): Promise<GaslessStatus>` | Combina feature flag + token discovered + `account.address` (NUNCA private key) | AC-7 |
| 5 | `export function _resetGaslessSigner(): void` `@internal` | Limpia singletons + cache de token (testing) | tests |

#### Helpers privados

| Helper | Propósito |
|--------|-----------|
| `getWalletClient()` | Lazy singleton WalletClient (copia 1:1 del patrón `x402-signer.ts:41-57`) |
| `buildDomain(token)` | Construye `{ name: token.eip712Name, version: token.eip712Version, chainId: kiteTestnet.id, verifyingContract: token.address }` |
| `generateNonce()` | `\`0x${randomBytes(32).toString('hex')}\` as \`0x${string}\`` |
| `assertMinimumValue(value, token)` | Lanza si `value < BigInt(token.minimumTransferAmount)` (CD-9) |
| `sanitizeError(err)` | Stringify sin incluir signature/private key (CD-1) |

#### Imports (verificados)

```ts
import { createWalletClient, http, hexToSignature } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { randomBytes } from 'node:crypto'
import { kiteTestnet } from './kite-chain.js'
import { requireKiteClient } from '../services/kite-client.js'
import type {
  GaslessSupportedToken,
  GaslessTransferRequest,
  GaslessTransferResponse,
  GaslessStatus,
} from '../types/index.js'
```

#### Logging permitido (CD-1)

| Evento | OK loggear | PROHIBIDO loggear |
|--------|------------|-------------------|
| Token discovery | symbol, address, network | full payload |
| Sign | "signing TransferWithAuthorization" | message, signature, private key, nonce |
| Submit OK | `txHash`, status code | request body, signature |
| Submit error | status code, error message string | body, signature, private key |

### 4.4 `src/routes/gasless.ts` (nueva ruta)

```ts
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { getGaslessStatus } from '../lib/gasless-signer.js'

const gaslessRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/status', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const status = await getGaslessStatus()
      return reply.send(status)
    } catch (err) {
      return reply.status(500).send({
        error: err instanceof Error ? err.message : 'gasless status failed',
      })
    }
  })
}

export default gaslessRoutes
```

Response shape (AC-7):

```json
{
  "enabled": true,
  "network": "kite-testnet",
  "supportedToken": { "symbol": "PYUSD", "address": "0x8E04…2ec9", "decimals": 18, ... },
  "operatorAddress": "0xabc…123"
}
```

### 4.5 Registro en `src/index.ts`

Insertar tras la línea 19 (`import dashboardRoutes from './routes/dashboard.js'`):

```ts
import gaslessRoutes from './routes/gasless.js'
```

Insertar tras la línea 55 (`await fastify.register(dashboardRoutes, ...)`):

```ts
if (process.env.GASLESS_ENABLED === 'true') {
  await fastify.register(gaslessRoutes, { prefix: '/gasless' })
  fastify.log.info('Gasless EIP-3009 module enabled (testnet PYUSD)')
}
```

CD-4: feature flag default OFF — sin la env var el bloque no corre y no carga el signer.

### 4.6 Nuevas vars en `.env.example`

```bash
# ─────────────────────────────────────────────────────────────
# Gasless EIP-3009 (WKH-29) — testnet only (PYUSD)
# Relayer: https://gasless.gokite.ai/testnet
# Token: PYUSD 0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9 (chain 2368)
# ─────────────────────────────────────────────────────────────
GASLESS_ENABLED=false
OPERATOR_PRIVATE_KEY=0xYourOperatorPrivateKey
```

> `OPERATOR_PRIVATE_KEY` ya es citada por `x402-signer.ts:44` y `.nexus/project-context.md:270`. La estamos formalizando en `.env.example`.

### 4.7 Happy Path

1. Caller invoca `signTransferWithAuthorization({to, value})`
2. `getSupportedToken()` → cache hit o fetch `/supported_tokens` (fallback PYUSD si falla)
3. `assertMinimumValue(value, token)` (CD-9)
4. `requireKiteClient().getBlock({blockTag:'latest'})` → `ts`
5. `validAfter = ts - 1n`; `validBefore = validAfter + 25n`
6. `generateNonce()` → bytes32
7. `client.signTypedData({domain, types: EIP3009_TYPES, primaryType: 'TransferWithAuthorization', message})`
8. `hexToSignature(sig)` → `{v, r, s}`
9. Retorna `GaslessTransferRequest` listo para `submitGaslessTransfer()`
10. `POST /testnet` → `{ txHash }` → log txHash

### 4.8 Flujo de error

| Falla | Comportamiento |
|-------|----------------|
| `OPERATOR_PRIVATE_KEY` ausente | `getWalletClient()` lanza con mensaje claro (sin la key) |
| `/supported_tokens` 5xx/timeout | Log warn → fallback a `FALLBACK_TOKEN` (PYUSD hardcoded) |
| `value < minimumTransferAmount` | Throw `Error('value below minimum_transfer_amount')` antes de firmar |
| `kiteClient` no inicializado | `requireKiteClient()` lanza (CD-1 OK, mensaje genérico) |
| Relayer 4xx/5xx en submit | Throw con `status + statusText` (sin body sensible), nunca crash |
| `getGaslessStatus()` falla token discovery | Retorna `supportedToken: null`, `enabled: bool`, sin throw |

---

## 5. Mapping AC → Wave / Archivo / Función

| AC | Wave | Archivo | Función responsable |
|----|------|---------|---------------------|
| AC-1 | W1 | `src/lib/gasless-signer.ts` | `submitGaslessTransfer()` |
| AC-2 | W1 | `src/lib/gasless-signer.ts` | `signTransferWithAuthorization()` (signTypedData + hexToSignature) |
| AC-3 | W1 | `src/lib/gasless-signer.ts` | `signTransferWithAuthorization()` (validAfter/validBefore) |
| AC-4 | W1 | `src/lib/gasless-signer.ts` | `getSupportedToken()` + `assertMinimumValue()` |
| AC-5 | W2 | `src/index.ts` | registro condicional `GASLESS_ENABLED` |
| AC-6 | W1+W2 | `gasless-signer.ts` + `routes/gasless.ts` | `sanitizeError()` + try/catch en handler |
| AC-7 | W2 | `src/routes/gasless.ts` | `GET /status` → `getGaslessStatus()` |

---

## 6. Plan de Waves

### Wave 0 — Foundation (tipos + env)
- W0.1: Agregar sección `// GASLESS TYPES (WKH-29)` en `src/types/index.ts` con `GaslessSupportedToken`, `GaslessTransferRequest`, `GaslessTransferResponse`, `GaslessStatus`
- W0.2: Agregar bloque `# Gasless EIP-3009` en `.env.example` con `GASLESS_ENABLED=false` y `OPERATOR_PRIVATE_KEY=`
- Verificación: `npm run build` sin errores

### Wave 1 — Core signer + tests (AC-1..AC-4, AC-6)
- W1.1: Crear `src/lib/gasless-signer.ts` con constantes, helpers privados, 5 funciones públicas, lazy singleton
- W1.2: Crear `src/lib/gasless-signer.test.ts`. Casos mínimos:
  1. `getSupportedToken()` cachea tras primera llamada
  2. `getSupportedToken()` cae a `FALLBACK_TOKEN` si fetch falla
  3. `signTransferWithAuthorization` produce firma EIP-712 válida (mock signTypedData devuelve hex de 65 bytes; verificar que `hexToSignature` es invocado)
  4. `validAfter = blockTimestamp - 1` y `validBefore = validAfter + 25` (mock `getBlock`)
  5. `assertMinimumValue` lanza si `value < minimumTransferAmount`
  6. `submitGaslessTransfer` no propaga body de error (solo status)
  7. `getGaslessStatus()` nunca expone private key
- Verificación: `npm test -- gasless-signer`

### Wave 2 — Route + registration (AC-5, AC-7)
- W2.1: Crear `src/routes/gasless.ts` con `GET /status`
- W2.2: Modificar `src/index.ts`: import + registro condicional con `GASLESS_ENABLED`
- Verificación: `npm run build` + smoke test manual con `GASLESS_ENABLED=true` → `curl :3001/gasless/status`

---

## 7. Constraint Directives (literal del work-item v3 — INVIOLABLES)

| # | Constraint |
|---|-----------|
| CD-1 | NUNCA loggear `OPERATOR_PRIVATE_KEY`, signatures ni payloads sensibles. Solo `txHash` |
| CD-2 | Gasless signer en `src/lib/gasless-signer.ts` — NO mezclar con `x402-signer.ts` |
| CD-3 | TypeScript strict, sin `any` |
| CD-4 | Feature flag `GASLESS_ENABLED` default `false`, opt-in |
| CD-5 | Gasless y x402 son paths independientes. No modificar middleware x402 |
| CD-6 | `validBefore` = `validAfter + 25s` |
| CD-7 | No agregar `ethers.js` |
| CD-8 | Endpoint hardcoded a testnet (`https://gasless.gokite.ai/testnet`) |
| CD-9 | Validar `value >= minimum_transfer_amount` antes de firmar |

### PROHIBIDO adicional (anti-alucinación)
- NO modificar `src/middleware/x402.ts`
- NO modificar `src/lib/x402-signer.ts`
- NO crear `kiteMainnet` chain definition (es WKH-33)
- NO usar `process.env.GASLESS_NETWORK` (removido en v3)
- NO inventar fields del EIP-712 fuera del schema EIP-3009 estándar

---

## 8. Decisiones técnicas (literal DT-1..DT-8 del work-item)

| # | Decisión | Justificación |
|---|----------|---------------|
| DT-1 | EIP-3009 relayer en vez de gokite-aa-sdk | Sin ethers.js, reusa patrón EIP-712 |
| DT-2 | Módulo `gasless-signer.ts` separado de `x402-signer.ts` | Responsabilidades distintas |
| DT-3 | `GASLESS_ENABLED` default `false` | Opt-in, no rompe nada |
| DT-4 | `validAfter = block.timestamp - 1` | Garantiza validez en próximo bloque |
| DT-5 | `hexToSignature()` de viem para v/r/s | Nativo, sin deps |
| DT-6 | Cache `/supported_tokens` en memoria | TTL = vida del proceso |
| DT-7 | Testnet only | Mainnet → WKH-33 |
| DT-8 | Paths gasless/x402 independientes | Tokens distintos en testnet |

### Decisiones nuevas surgidas durante grounding

| # | Decisión | Justificación |
|---|----------|---------------|
| DT-9 | Lazy singleton del WalletClient gasless (no top-level await como `kiteClient`) | El feature es opt-in. Si `GASLESS_ENABLED=false`, el módulo nunca se carga ni valida `OPERATOR_PRIVATE_KEY` |
| DT-10 | Cache de token = `let _tokenCache: GaslessSupportedToken | null = null` con `_resetGaslessSigner()` para tests | Mismo patrón que `_walletClient` en x402-signer |
| DT-11 | `getBlock({ blockTag: 'latest' })` (object form) | Forma idiomática viem 2.x |
| DT-12 | `value: bigint` en API pública (no string) | Type-safety; convertir a string solo en el payload final |

---

## 9. EIP-712 Schema (literal del work-item, verificado en vivo)

```ts
const domain = {
  name: token.eip712Name,            // "PYUSD"
  version: token.eip712Version,      // "1"
  chainId: 2368,                     // kiteTestnet.id
  verifyingContract: token.address as `0x${string}`,  // 0x8E04…2ec9
} as const

const types = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const
```

---

## 10. Anti-Hallucination Checklist (para Dev en F3)

| # | Verificación | Resultado en F2 |
|---|--------------|-----------------|
| 1 | viem `signTypedData` existe en WalletClient | OK — `x402-signer.ts:93` lo usa |
| 2 | viem 2.47.6 exporta `hexToSignature` | OK — `node -e "require('viem').hexToSignature"` retorna `function` |
| 3 | `requireKiteClient()` retorna PublicClient con `.getBlock()` | OK — `kite-client.ts:48-55` retorna `PublicClient` (viem); `getBlock` es método estándar |
| 4 | `kiteTestnet.id === 2368` | OK — `kite-chain.ts:11` |
| 5 | `privateKeyToAccount` desde `viem/accounts` | OK — `x402-signer.ts:8` |
| 6 | `node:crypto.randomBytes` para nonce | OK — `x402-signer.ts:15` |
| 7 | Patrón Fastify route plugin async | OK — `routes/dashboard.ts:21` |
| 8 | No existen dependencias `ethers` en `package.json` | OK |
| 9 | `OPERATOR_PRIVATE_KEY` ya es leída en otro lugar | OK — `x402-signer.ts:44`. Compartir misma var |
| 10 | `block.timestamp` es `bigint` en viem | OK — convención viem 2.x |

### Imports exactos del nuevo módulo (para Dev)

```ts
import { createWalletClient, http, hexToSignature } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { randomBytes } from 'node:crypto'
import { kiteTestnet } from './kite-chain.js'
import { requireKiteClient } from '../services/kite-client.js'
import type {
  GaslessSupportedToken,
  GaslessTransferRequest,
  GaslessTransferResponse,
  GaslessStatus,
} from '../types/index.js'
```

### ASUNCIONES A VERIFICAR EN F3

| # | Asunción | Cómo verificar |
|---|----------|----------------|
| A-1 | Shape exacto de `/supported_tokens` (campos `eip712_name`, `eip712_version`, `minimum_transfer_amount`) | `curl https://gasless.gokite.ai/supported_tokens` antes de codear; si difiere, ajustar parser |
| A-2 | Body exacto que espera `POST /testnet` (snake_case vs camelCase, naming de v/r/s) | Smoke test con request mínimo + leer doc Kite. Si falla 400, ajustar serialización |
| A-3 | Si el relayer requiere header `Content-Type: application/json` o algún auth | Documentar tras smoke test |
| A-4 | Cómo mockear `signTypedData` en vitest sin re-implementar viem | Opción: mock con `vi.spyOn(walletClient, 'signTypedData')` tras `_resetGaslessSigner()` + inyección. Si no, usar wallet de test con PK fija (deterministic) |
| A-5 | `block.timestamp` es `bigint` (asumido); confirmar `Number(ts)` o `ts - 1n` | Tipar como `bigint` y operar con literales `n` |

---

## 11. Plan de Testing

### Framework
- **vitest** (ya configurado, `package.json:25`)
- Convención: `*.test.ts` colocado junto al source (no hay tests previos en `src/lib/`, este sería el primero — patrón nuevo en esa carpeta pero estándar del proyecto)

### Estrategia de mocks (nueva — no hay precedente exacto)

| Dependencia externa | Estrategia |
|---------------------|-----------|
| `fetch` (token discovery + submit) | `vi.stubGlobal('fetch', vi.fn())` con `mockResolvedValueOnce` por caso |
| `requireKiteClient().getBlock` | `vi.mock('../services/kite-client.js', () => ({ requireKiteClient: () => ({ getBlock: vi.fn().mockResolvedValue({ timestamp: 1700000000n }) }) }))` |
| `signTypedData` | Inyectar `OPERATOR_PRIVATE_KEY` de test (PK determinista pública conocida) en `beforeEach` y dejar que viem firme real; alternativa: spy sobre el walletClient tras `_resetGaslessSigner()` |
| `randomBytes` | Dejar real (no afecta determinismo del test si verificás shape, no valor) |

### Casos de test mínimos (W1.2)

1. `getSupportedToken caches the result on second call`
2. `getSupportedToken falls back to PYUSD when fetch rejects`
3. `getSupportedToken falls back when fetch returns non-2xx`
4. `signTransferWithAuthorization sets validAfter = blockTs - 1 and validBefore = validAfter + 25`
5. `signTransferWithAuthorization rejects when value < minimumTransferAmount`
6. `signTransferWithAuthorization decomposes signature into v/r/s via hexToSignature`
7. `submitGaslessTransfer returns txHash on 200`
8. `submitGaslessTransfer throws sanitized error on 5xx (no body leak)`
9. `getGaslessStatus returns operatorAddress but never the private key field`

---

## 12. Scope (literal del work-item)

### IN
- `src/lib/gasless-signer.ts` (nuevo)
- `src/lib/gasless-signer.test.ts` (nuevo)
- `src/types/index.ts` (modificar — agregar tipos)
- `src/routes/gasless.ts` (nuevo)
- `src/index.ts` (modificar — registro condicional)
- `.env.example` (modificar)
- `doc/sdd/018-gasless-aa/` (docs)

### OUT
- gokite-aa-sdk / ethers.js
- Modificar `src/middleware/x402.ts`
- Paymaster / ERC-4337 / Smart accounts
- UI gasless
- Multi-chain (mainnet, USDC.e) → WKH-33
- Convergencia gasless ↔ x402 settlement

---

## 13. Riesgos

| Riesgo | Prob | Impacto | Mitigación |
|--------|------|---------|------------|
| Shape de `/supported_tokens` cambia o difiere | M | M | Fallback hardcoded (CD-9 valida igual). A-1 verificable en F3 |
| Body del POST submit no documentado al 100% | M | M | Smoke test temprano; tests de error sanitizan |
| Mock de viem `signTypedData` complejo | B | B | Usar PK de test determinista; NO mockear viem internals |
| Wallet operadora sin balance PYUSD testnet | M | B | Faucet pre-test; error sanitizado en submit |
| Drift project-context (Redis/BullMQ) confunde Dev | B | B | Documentado aquí; no aplica a este scope |

---

## 14. Dependencias

| Dependencia | Estado |
|-------------|--------|
| `viem ^2.47.6` | OK (instalado, `signTypedData` + `hexToSignature` verificados) |
| `src/lib/kite-chain.ts` (`kiteTestnet`) | OK |
| `src/services/kite-client.ts` (`requireKiteClient`) | OK |
| `src/lib/x402-signer.ts` (patrón) | OK (no se modifica) |
| `https://gasless.gokite.ai` | Externo — verificado activo en work-item v3 |

---

## 15. Implementation Readiness Check

```
[x] Cada AC tiene archivo asociado (tabla §5)
[x] Cada archivo en §4.1 tiene exemplar verificado con Read
[x] Sin [NEEDS CLARIFICATION] bloqueantes (las 5 ASUNCIONES son verificables al iniciar F3)
[x] Constraint Directives ≥ 3 PROHIBIDO (CD-1..CD-9 + sección extra §7)
[x] Context Map ≥ 2 archivos leídos (12 archivos verificados)
[x] Scope IN/OUT explícitos
[x] BD: N/A (no hay cambios DB)
[x] Happy Path completo (§4.7)
[x] Flujo de error definido (§4.8)
[x] Imports exactos verificados (§10)
[x] viem `hexToSignature` verificado en runtime
[x] Patrón lazy singleton verificado en exemplar (`x402-signer.ts:39-57`)
[x] Patrón Fastify plugin verificado en exemplar (`routes/dashboard.ts:21`)
```

**Veredicto: READY FOR SPEC_APPROVED**

Las 5 ASUNCIONES (A-1..A-5) son resolubles en los primeros 10 minutos de F3 con un `curl` y un smoke test. Ninguna bloquea el diseño; todas tienen plan de mitigación.

---

## 16. Referencias

- Work item: `doc/sdd/018-gasless-aa/work-item.md` (v3 post-AR)
- Exemplar EIP-712: `src/lib/x402-signer.ts`
- Exemplar Fastify route: `src/routes/dashboard.ts`
- Exemplar PublicClient: `src/services/kite-client.ts`
- Chain definition: `src/lib/kite-chain.ts`
- Kite docs: https://docs.gokite.ai/kite-chain/stablecoin-gasless-transfer
- Jira post-hackathon: WKH-33 (mainnet USDC.e)

---

*Generado: 2026-04-06 | Architect F2 | SDD-018 sdd.md (post-HU_APPROVED)*
