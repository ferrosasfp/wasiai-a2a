# Story File — WKH-29: Gasless Integration EIP-3009 (testnet only PYUSD)

> SDD: `doc/sdd/018-gasless-aa/sdd.md`
> Work Item: `doc/sdd/018-gasless-aa/work-item.md`
> Fecha: 2026-04-06
> Branch esperado: `feat/018-gasless-aa`
> HU: WKH-29 | Epic: WKH-4 | Sizing: **S** (~100 LOC lib + ~40 LOC route + ~80 LOC tests + ~15 LOC tipos)
> Modo: **QUALITY** | SPEC_APPROVED: si

---

## Goal

Agregar soporte **gasless** (EIP-3009 `TransferWithAuthorization`) para transfers de **PYUSD en Kite Testnet** (chain 2368) via el relayer `https://gasless.gokite.ai/testnet`, reusando el patron viem EIP-712 ya consolidado en `src/lib/x402-signer.ts`. La feature es opt-in (`GASLESS_ENABLED=false` por defecto) y vive aislada del middleware x402 existente. Mainnet (USDC.e) queda fuera de scope (WKH-33).

---

## Acceptance Criteria (EARS — copia literal del SDD §3 / work-item)

- **AC-1** — WHEN the system needs to transfer stablecoins gasless on Kite testnet, THE SYSTEM SHALL sign an EIP-3009 `TransferWithAuthorization` message using the operator wallet and submit it to `https://gasless.gokite.ai/testnet`, receiving a `txHash` in response.
- **AC-2** — WHEN the gasless signer generates the `TransferWithAuthorization` signature, THE SYSTEM SHALL use viem's `signTypedData()` with the EIP-712 domain obtained from `/supported_tokens` (name, version, chainId, verifyingContract) and decompose the signature into `v`, `r`, `s` components via `hexToSignature()`.
- **AC-3** — WHEN constructing the gasless transfer request, THE SYSTEM SHALL set `validAfter = latestBlockTimestamp - 1s`, `validBefore = validAfter + 25s`.
- **AC-4** — WHEN the gasless module needs to determine the supported token, THE SYSTEM SHALL query `GET https://gasless.gokite.ai/supported_tokens`, extract the testnet token, cache it. IF unreachable THE SYSTEM SHALL fall back to hardcoded PYUSD `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9` (decimals: 18, name: "PYUSD", version: "1"). THE SYSTEM SHALL validate `value >= minimum_transfer_amount`.
- **AC-5** — WHEN `GASLESS_ENABLED=true`, THE SYSTEM SHALL register the `/gasless/*` routes and execute transfers via PYUSD. Default OFF.
- **AC-6** — WHEN the relayer returns an error or is unreachable, THE SYSTEM SHALL log sanitized error (CD-1) and return to caller without crashing.
- **AC-7** — WHEN `GET /gasless/status` is called, THE SYSTEM SHALL return `{ enabled, network, supportedToken, operatorAddress }` (NEVER private key).

---

## Pre-flight checks (Anti-Hallucination) — Dev ejecuta ANTES de tocar codigo

```bash
# 1) Confirmar branch
git rev-parse --abbrev-ref HEAD
# esperado: feat/018-gasless-aa
# Si no existe, crear: git checkout -b feat/018-gasless-aa (desde main)

# 2) Confirmar exemplars existen (paths exactos del SDD §2)
ls -la \
  src/lib/x402-signer.ts \
  src/lib/kite-chain.ts \
  src/services/kite-client.ts \
  src/routes/dashboard.ts \
  src/types/index.ts \
  src/index.ts \
  package.json \
  .env.example

# 3) Confirmar deps (viem ^2.47.6, NO ethers)
grep -E '"viem"|"ethers"' package.json
# Esperado: solo "viem": "^2.47.6". Si aparece ethers → PARAR y escalar.

# 4) Confirmar que hexToSignature y signTypedData existen en viem 2.47.6
node -e "console.log(typeof require('viem').hexToSignature)"
# Esperado: "function"

# 5) Smoke test del endpoint /supported_tokens (resuelve A-1)
curl -sS https://gasless.gokite.ai/supported_tokens | head -c 2000
# Confirmar shape real: fields eip712_name, eip712_version, minimum_transfer_amount
# y entrada testnet PYUSD 0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9

# 6) typecheck inicial (baseline limpio)
npx tsc --noEmit
```

**Si CUALQUIER check falla → PARAR y escalar a Architect. No improvisar.**

---

## Files to Modify/Create

| # | Archivo | Accion | Que hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `src/types/index.ts` | Modificar | Agregar seccion `// GASLESS TYPES (WKH-29)` al final con 4 interfaces | `src/types/index.ts` L222-260 (seccion x402 PROTOCOL TYPES) |
| 2 | `.env.example` | Modificar | Agregar bloque `# Gasless EIP-3009 (WKH-29)` | bloques existentes (estilo) |
| 3 | `src/lib/gasless-signer.ts` | Crear | Core EIP-3009: lazy singleton, token discovery, sign, submit, status, reset helper | `src/lib/x402-signer.ts` (1:1 patron) |
| 4 | `src/lib/gasless-signer.test.ts` | Crear | Tests unitarios vitest (9 casos) con mocks de fetch + getBlock | nuevo (primer test en `src/lib/`) |
| 5 | `src/routes/gasless.ts` | Crear | Fastify plugin con `GET /status` | `src/routes/dashboard.ts` L9, L21-67 |
| 6 | `src/index.ts` | Modificar | Import + `fastify.register(gaslessRoutes, { prefix: '/gasless' })` condicional a `GASLESS_ENABLED==='true'` | `src/index.ts` L11-19, L48-56 |

---

## Exemplars (referencia obligatoria — NO inventar)

### Exemplar 1: Lazy singleton WalletClient + EIP-712 sign
**Archivo**: `src/lib/x402-signer.ts`
**Lineas clave** (del SDD §2):
- **L7-9**: imports `createWalletClient, http` + `privateKeyToAccount` desde `viem/accounts`
- **L39-57**: `_walletClient` lazy singleton + `getWalletClient()` con guard de `OPERATOR_PRIVATE_KEY`
- **L82**: `randomBytes(32).toString('hex')` nonce (node:crypto)
- **L93-106**: `client.signTypedData({ account, domain, types, primaryType, message })` con `BigInt(...)` para uint256 y `nonce as \`0x${string}\``
- **L125-127**: `_resetWalletClient()` `@internal` para tests

**Usar para**: `src/lib/gasless-signer.ts` (replicar 1:1 el patron singleton + firma).

### Exemplar 2: Chain definition
**Archivo**: `src/lib/kite-chain.ts`
**Lineas clave**: L10-33 `kiteTestnet = defineChain({ id: 2368, ... })`
**Usar para**: pasar `chain: kiteTestnet` a `createWalletClient` y `chainId: kiteTestnet.id` en el domain EIP-712.

### Exemplar 3: PublicClient para getBlock
**Archivo**: `src/services/kite-client.ts`
**Lineas clave**: L19-42 `initKiteClient()` + L48-55 `requireKiteClient()` guard
**Usar para**: `requireKiteClient().getBlock({ blockTag: 'latest' })` → `block.timestamp` (bigint) para `validAfter` (AC-3).

### Exemplar 4: Fastify route plugin async
**Archivo**: `src/routes/dashboard.ts`
**Lineas clave**: L9 imports `FastifyPluginAsync, FastifyRequest, FastifyReply` + L21-67 `const xxxRoutes: FastifyPluginAsync = async (fastify) => { ... }; export default xxxRoutes`
**Usar para**: `src/routes/gasless.ts` — mismo shape.

### Exemplar 5: Registro de rutas
**Archivo**: `src/index.ts`
**Lineas clave**: L11-19 imports de rutas, L48-56 `await fastify.register(routes, { prefix })`
**Usar para**: insertar `import gaslessRoutes from './routes/gasless.js'` tras L19 y bloque condicional tras L55.

---

## Contrato de Integración ⚠️ BLOQUEANTE

Esta HU tiene comunicacion con un servicio externo (Kite Gasless Relayer). Contratos:

### A) A2A service → `GET https://gasless.gokite.ai/supported_tokens`

**Request**: sin body, sin headers especiales.

**Response 2xx** (shape ASUMIDO — verificar en A-1 via curl en pre-flight):
```json
{
  "testnet": [
    {
      "symbol": "PYUSD",
      "address": "0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9",
      "decimals": 18,
      "eip712_name": "PYUSD",
      "eip712_version": "1",
      "minimum_transfer_amount": "10000000000000000"
    }
  ],
  "mainnet": [ /* ignorar en esta HU */ ]
}
```

**Fallback (AC-4)** si la llamada falla o devuelve non-2xx:
```ts
const FALLBACK_TOKEN: GaslessSupportedToken = {
  network: 'testnet',
  symbol: 'PYUSD',
  address: '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9',
  decimals: 18,
  eip712Name: 'PYUSD',
  eip712Version: '1',
  minimumTransferAmount: '10000000000000000', // 0.01 PYUSD (18 dec)
}
```

### B) A2A service → `POST https://gasless.gokite.ai/testnet`

**Headers**: `Content-Type: application/json`

**Request body** (camelCase — verificar exacto en A-2 con smoke test; si el relayer exige snake_case, ajustar serializacion localmente SIN cambiar los tipos publicos):
```json
{
  "from": "0x...",
  "to": "0x...",
  "value": "10000000000000000",
  "validAfter": "1700000000",
  "validBefore": "1700000025",
  "tokenAddress": "0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9",
  "nonce": "0x<64 hex>",
  "v": 27,
  "r": "0x...",
  "s": "0x..."
}
```

**Response 2xx**:
```json
{ "txHash": "0x..." }
```

**Errores**:
| HTTP | Cuando | Comportamiento |
|------|--------|----------------|
| 4xx | Payload invalido o value < minimum | Throw `Error('gasless submit failed: <status> <statusText>')` — NUNCA incluir body ni signature (CD-1) |
| 5xx | Relayer caido | Throw sanitizado; NO crash; `getGaslessStatus()` debe seguir funcionando con `supportedToken: null` |
| timeout / network | fetch rechaza | Throw sanitizado |

### C) Cliente HTTP → `GET /gasless/status`

**Response 200** (AC-7):
```json
{
  "enabled": true,
  "network": "kite-testnet",
  "supportedToken": {
    "network": "testnet",
    "symbol": "PYUSD",
    "address": "0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9",
    "decimals": 18,
    "eip712Name": "PYUSD",
    "eip712Version": "1",
    "minimumTransferAmount": "10000000000000000"
  },
  "operatorAddress": "0xabc...123"
}
```

**PROHIBIDO** incluir en la respuesta: `privateKey`, `OPERATOR_PRIVATE_KEY`, signature, nonce, o cualquier material sensible.

---

## Constraint Directives (literal del work-item v3 — INVIOLABLES)

### OBLIGATORIO
- **CD-1** NUNCA loggear `OPERATOR_PRIVATE_KEY`, signatures ni payloads sensibles. Solo `txHash`, symbol, address, status code, error message string.
- **CD-2** Gasless signer en `src/lib/gasless-signer.ts` — NO mezclar con `x402-signer.ts`.
- **CD-3** TypeScript strict, sin `any` explicito.
- **CD-4** Feature flag `GASLESS_ENABLED` default `false`, opt-in. Sin la env var, el bloque de registro no corre ni carga el signer.
- **CD-5** Gasless y x402 son paths independientes. NO modificar middleware x402.
- **CD-6** `validBefore = validAfter + 25s` (dentro del limite de 30s del relayer).
- **CD-7** NO agregar `ethers.js` como dependencia.
- **CD-8** Endpoint hardcoded a testnet: `https://gasless.gokite.ai/testnet`.
- **CD-9** Validar `value >= minimum_transfer_amount` ANTES de firmar.

### PROHIBIDO (adicional anti-alucinacion — SDD §7)
- NO modificar `src/middleware/x402.ts`
- NO modificar `src/lib/x402-signer.ts`
- NO crear `kiteMainnet` chain definition (es WKH-33)
- NO usar `process.env.GASLESS_NETWORK` (removido en v3)
- NO inventar fields del EIP-712 fuera del schema EIP-3009 estandar
- NO expandir scope a mainnet / USDC.e
- NO agregar dependencias npm nuevas
- NO tocar archivos fuera de la tabla "Files to Modify/Create"

---

## Imports exactos de viem (verificados en F2 — copiar literal)

```ts
// src/lib/gasless-signer.ts
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

```ts
// src/routes/gasless.ts
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { getGaslessStatus } from '../lib/gasless-signer.js'
```

```ts
// src/index.ts (agregar tras L19)
import gaslessRoutes from './routes/gasless.js'
```

**Regla**: si Dev necesita un simbolo de viem que NO esta en esta lista, PARAR y escalar. NO inventar imports.

---

## EIP-712 Schema TypeScript (literal del SDD §9)

```ts
// Domain — se obtiene del token descubierto
const domain = {
  name: token.eip712Name,              // "PYUSD"
  version: token.eip712Version,        // "1"
  chainId: kiteTestnet.id,             // 2368
  verifyingContract: token.address,    // 0x8E04...2ec9
} as const

// Types — EIP-3009 TransferWithAuthorization
const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from',        type: 'address' },
    { name: 'to',          type: 'address' },
    { name: 'value',       type: 'uint256' },
    { name: 'validAfter',  type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce',       type: 'bytes32' },
  ],
} as const
```

---

## Tipos TypeScript a agregar en `src/types/index.ts`

Seccion nueva al final del archivo (literal del SDD §4.2):

```ts
// ============================================================
// GASLESS TYPES (WKH-29 — EIP-3009)
// ============================================================

export interface GaslessSupportedToken {
  network: 'testnet' | 'mainnet'
  symbol: string                  // "PYUSD"
  address: `0x${string}`          // 0x8E04...2ec9
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

---

## Variables de entorno nuevas (`.env.example`)

Agregar bloque al final del archivo:

```bash
# ─────────────────────────────────────────────────────────────
# Gasless EIP-3009 (WKH-29) — testnet only (PYUSD)
# Relayer: https://gasless.gokite.ai/testnet
# Token: PYUSD 0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9 (chain 2368)
# ─────────────────────────────────────────────────────────────
GASLESS_ENABLED=false
OPERATOR_PRIVATE_KEY=0xYourOperatorPrivateKey
```

> `OPERATOR_PRIVATE_KEY` ya es leida por `src/lib/x402-signer.ts:44`. Se comparte la misma var.

---

## Estructura obligatoria de `src/lib/gasless-signer.ts`

### Constantes (top of file)
```ts
const GASLESS_BASE_URL = 'https://gasless.gokite.ai'
const GASLESS_SUBMIT_URL = `${GASLESS_BASE_URL}/testnet`           // CD-8
const GASLESS_TOKENS_URL = `${GASLESS_BASE_URL}/supported_tokens`
const VALIDITY_WINDOW_SECONDS = 25n                                 // CD-6 (bigint)
const FALLBACK_TOKEN: GaslessSupportedToken = { /* PYUSD — ver Contrato A */ }
const EIP3009_TYPES = { /* ver §EIP-712 Schema */ } as const
```

### Estado del modulo (singletons)
```ts
let _walletClient: ReturnType<typeof createWalletClient> | null = null
let _tokenCache: GaslessSupportedToken | null = null
```

### Funciones publicas (firmas EXACTAS)

| # | Firma | AC | Notas |
|---|-------|----|----|
| 1 | `export async function getSupportedToken(): Promise<GaslessSupportedToken>` | AC-4 | Fetch con cache; fallback hardcoded si fetch rechaza o status >=400 |
| 2 | `export async function signTransferWithAuthorization(opts: { to: \`0x${string}\`; value: bigint }): Promise<GaslessTransferRequest>` | AC-2, AC-3, AC-4 | Orquesta: token → assertMin → getBlock → validAfter/Before → nonce → sign → hexToSignature |
| 3 | `export async function submitGaslessTransfer(payload: GaslessTransferRequest): Promise<GaslessTransferResponse>` | AC-1, AC-6 | POST JSON; sanitizar errores; log solo txHash |
| 4 | `export async function getGaslessStatus(): Promise<GaslessStatus>` | AC-7 | Nunca throw; si token discovery falla → `supportedToken: null` |
| 5 | `export function _resetGaslessSigner(): void` (`@internal`) | tests | Limpia `_walletClient` y `_tokenCache` |

### Helpers privados (no exportar)
- `getWalletClient()` — lazy singleton (copia 1:1 del patron `x402-signer.ts` L39-57). Guard: si `!process.env.OPERATOR_PRIVATE_KEY` → throw `Error('OPERATOR_PRIVATE_KEY is required for gasless signer')` (sin incluir el valor).
- `buildDomain(token)` — retorna `{ name, version, chainId: kiteTestnet.id, verifyingContract: token.address } as const`.
- `generateNonce()` — `` `0x${randomBytes(32).toString('hex')}` as `0x${string}` ``.
- `assertMinimumValue(value: bigint, token: GaslessSupportedToken)` — throw `Error('value below minimum_transfer_amount')` si `value < BigInt(token.minimumTransferAmount)` (CD-9).
- `sanitizeError(err: unknown): string` — extrae solo `status + statusText + message.substring(0, 120)`; NUNCA incluye body, signature, private key, nonce.

### Logging permitido (CD-1)

| Evento | OK loggear | PROHIBIDO |
|--------|------------|-----------|
| Token discovery | symbol, address, network | full payload |
| Sign | `"signing TransferWithAuthorization"` | message, signature, private key, nonce |
| Submit OK | `txHash`, status code | request body, signature |
| Submit error | status code, error message | body, signature, private key |

---

## Resolucion de ASUNCIONES A VERIFICAR (SDD §10)

| # | Asuncion | Como resolver | Cuando (wave) |
|---|----------|---------------|---------------|
| **A-1** | Shape exacto de `/supported_tokens` (fields snake_case `eip712_name`, `eip712_version`, `minimum_transfer_amount`) | `curl https://gasless.gokite.ai/supported_tokens` en pre-flight. Si difiere del contrato asumido, ajustar SOLO el parser en `getSupportedToken()` — los tipos publicos (camelCase) NO cambian | **W0 / pre-flight** antes de W1.1 |
| **A-2** | Body exacto que espera `POST /testnet` (snake_case vs camelCase en v/r/s, `token_address` vs `tokenAddress`) | Smoke test con request minimo + leer doc Kite. Si 400, ajustar serializacion local en `submitGaslessTransfer()`. Los tipos TS publicos permanecen camelCase | **W1.1** (antes de escribir `submitGaslessTransfer`) |
| **A-3** | Headers requeridos por el relayer (auth, content-type) | Smoke test. Default: solo `Content-Type: application/json`. Si requiere auth → PARAR y escalar (no hay credenciales previstas) | **W1.1** |
| **A-4** | Como mockear `signTypedData` en vitest sin re-implementar viem | Usar PK determinista de test (`0x` + 64 hex conocidos) en `beforeEach` tras `_resetGaslessSigner()` y dejar que viem firme real. NO mockear internals de viem | **W1.2** |
| **A-5** | `block.timestamp` es `bigint` en viem 2.x | Confirmado en SDD §10 check #10. Tipar como `bigint`, operar con literales `n` (`ts - 1n`, `validAfter + 25n`). Convertir a string solo en el payload final | **W1.1** |

**Regla**: si tras ejecutar los smoke tests alguna asuncion NO se resuelve → PARAR y escalar a Architect. NO hardcodear guess.

---

## Plan de Waves

### Wave -1 — Environment Gate (OBLIGATORIO, correr ANTES de W0)

Ver seccion "Pre-flight checks" arriba. Si cualquier check falla → PARAR.

### Wave 0 — Foundation (tipos + env)

**Objetivo**: poner tipos y env vars en su lugar para que W1 compile.

**Archivos**:
- `src/types/index.ts` — agregar seccion GASLESS TYPES (ver §Tipos TypeScript)
- `.env.example` — agregar bloque Gasless (ver §Variables de entorno)

**DoD W0**:
- [ ] `npx tsc --noEmit` pasa sin errores
- [ ] `grep -n 'GASLESS TYPES' src/types/index.ts` retorna match
- [ ] `grep -n 'GASLESS_ENABLED' .env.example` retorna match

**Verificacion incremental antes de W1**: releer `src/lib/x402-signer.ts` L7-9, L39-57, L82, L93-106, L125-127 (el exemplar completo).

---

### Wave 1 — Core signer + tests (AC-1..AC-4, AC-6)

**Objetivo**: implementar `gasless-signer.ts` completo + su suite de tests.

**Archivos**:
- `src/lib/gasless-signer.ts` (crear)
- `src/lib/gasless-signer.test.ts` (crear)

**Orden sugerido** (test-first donde aplique):
1. Escribir esqueleto de tipos/constantes + `getWalletClient()` lazy singleton (copia 1:1 de x402-signer.ts)
2. `_resetGaslessSigner()`
3. `getSupportedToken()` + tests 1-3
4. `assertMinimumValue()` + helper `buildDomain()` + `generateNonce()`
5. `signTransferWithAuthorization()` + tests 4-6
6. `submitGaslessTransfer()` + tests 7-8
7. `getGaslessStatus()` + test 9

**DoD W1**:
- [ ] `npx tsc --noEmit` pasa
- [ ] `npx vitest run src/lib/gasless-signer.test.ts` — 9 tests verde
- [ ] Ningun log contiene `OPERATOR_PRIVATE_KEY`, signature, ni body del relayer (grep manual sobre `console.*`/`fastify.log.*` en el archivo)
- [ ] No hay `any` explicito (`grep -n ': any' src/lib/gasless-signer.ts` vacio)

**Verificacion incremental antes de W2**: releer `src/routes/dashboard.ts` L9, L21-67 y `src/index.ts` L11-19, L48-56.

---

### Wave 2 — Route + registration (AC-5, AC-7)

**Objetivo**: exponer `GET /gasless/status` y registrar condicional en Fastify.

**Archivos**:
- `src/routes/gasless.ts` (crear)
- `src/index.ts` (modificar)

**Cambios concretos en `src/index.ts`**:

1. **Tras L19** (import dashboardRoutes):
   ```ts
   import gaslessRoutes from './routes/gasless.js'
   ```

2. **Tras L55** (ultimo `await fastify.register(...)` existente):
   ```ts
   if (process.env.GASLESS_ENABLED === 'true') {
     await fastify.register(gaslessRoutes, { prefix: '/gasless' })
     fastify.log.info('Gasless EIP-3009 module enabled (testnet PYUSD)')
   }
   ```

**Contenido literal de `src/routes/gasless.ts`**:
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

**DoD W2**:
- [ ] `npx tsc --noEmit` pasa
- [ ] `npx vitest run` pasa toda la suite (no rompe tests existentes)
- [ ] Smoke manual con `GASLESS_ENABLED=true` + `OPERATOR_PRIVATE_KEY=0x...`: `curl http://localhost:3001/gasless/status` retorna JSON con shape AC-7
- [ ] Con `GASLESS_ENABLED=false` (default): `curl http://localhost:3001/gasless/status` devuelve 404 (ruta NO registrada)
- [ ] Response del smoke NO contiene `privateKey`, `OPERATOR_PRIVATE_KEY`, signature

---

### Wave 3 — Verificacion final

- [ ] `npx tsc --noEmit`
- [ ] `npx vitest run`
- [ ] `grep -rn 'OPERATOR_PRIVATE_KEY' src/lib/gasless-signer.ts src/routes/gasless.ts` — solo aparece como lectura de env, nunca en logs
- [ ] `grep -rn 'ethers' package.json src/lib/gasless-signer.ts` — vacio
- [ ] `grep -rn ': any' src/lib/gasless-signer.ts src/routes/gasless.ts` — vacio
- [ ] Todos los ACs mapeados (ver tabla) tienen test PASS o smoke PASS

---

## Tests requeridos — `src/lib/gasless-signer.test.ts` (W1.2)

**Framework**: vitest. **Patron**: `describe('gasless-signer', () => { beforeEach(() => { _resetGaslessSigner(); vi.restoreAllMocks() }); ... })`.

**Setup comun**:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
// PK de test determinista (publica — solo para tests)
const TEST_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
process.env.OPERATOR_PRIVATE_KEY = TEST_PK
```

### Casos (9 tests)

1. **`it('should cache getSupportedToken result on second call')`**
   - Mock: `vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ testnet: [FALLBACK_SHAPE] }) }))`
   - Llamar `getSupportedToken()` dos veces
   - Assert: `fetch` fue invocado exactamente 1 vez
   - Assert: ambos resultados son `===` (misma referencia)

2. **`it('should fall back to PYUSD when fetch rejects')`**
   - Mock: `fetch` rechaza con `new Error('network down')`
   - Llamar `getSupportedToken()`
   - Assert: resultado === `FALLBACK_TOKEN` (symbol `PYUSD`, address `0x8E04...2ec9`)
   - Assert: NO throw

3. **`it('should fall back when fetch returns non-2xx')`**
   - Mock: `fetch` resolves `{ ok: false, status: 503 }`
   - Assert: resultado === fallback, NO throw

4. **`it('should set validAfter = blockTs - 1 and validBefore = validAfter + 25')`**
   - Mock: `vi.mock('../services/kite-client.js', () => ({ requireKiteClient: () => ({ getBlock: vi.fn().mockResolvedValue({ timestamp: 1700000000n }) }) }))`
   - Mock fetch del token (happy path)
   - Llamar `signTransferWithAuthorization({ to: '0x...', value: 20000000000000000n })`
   - Assert: `result.validAfter === '1699999999'`
   - Assert: `result.validBefore === '1700000024'`

5. **`it('should reject when value < minimumTransferAmount')`**
   - Mock fetch token con `minimumTransferAmount: '10000000000000000'`
   - Mock getBlock
   - Llamar con `value: 1n`
   - Assert: `.rejects.toThrow(/minimum_transfer_amount/)`

6. **`it('should decompose signature into v/r/s via hexToSignature')`**
   - Mocks token + getBlock
   - Llamar con `value: 20000000000000000n`
   - Assert: `typeof result.v === 'number'`
   - Assert: `result.r.startsWith('0x')` y `result.s.startsWith('0x')`
   - Assert: `result.nonce.length === 66` (0x + 64 hex)

7. **`it('should return txHash from submitGaslessTransfer on 200')`**
   - Mock fetch submit: `{ ok: true, json: async () => ({ txHash: '0xdeadbeef' }) }`
   - Llamar con payload minimo valido
   - Assert: `result.txHash === '0xdeadbeef'`

8. **`it('should throw sanitized error on 5xx without leaking body')`**
   - Mock fetch submit: `{ ok: false, status: 500, statusText: 'Internal', text: async () => 'SECRET_BODY' }`
   - Llamar submit
   - Assert: `.rejects.toThrow()` con mensaje que contiene `'500'` pero NO `'SECRET_BODY'`

9. **`it('should return operatorAddress in getGaslessStatus but never the private key')`**
   - Mock token discovery OK
   - Llamar `getGaslessStatus()`
   - Assert: `result.operatorAddress` empieza con `0x`, length 42
   - Assert: `JSON.stringify(result)` NO contiene el TEST_PK ni `'privateKey'`

---

## Tests requeridos — W2 (smoke manual o integration opcional)

Al no haber precedente de tests de ruta Fastify en este scope, W2 se valida con **smoke manual** documentado en DoD. Tests automatizados de la ruta son opcionales y NO bloquean F4 si el smoke pasa.

Si Dev decide agregarlos (opcional):
- **`routes/gasless.status.test.ts`** — usar `fastify.inject({ method: 'GET', url: '/gasless/status' })`
  - Con `GASLESS_ENABLED=true` → 200, shape AC-7
  - Response NO contiene `privateKey` ni `OPERATOR_PRIVATE_KEY`
  - Con `GASLESS_ENABLED=false` (otro test) → 404

---

## Mapping AC → Wave / Archivo / Test

| AC | Wave | Archivo | Test / Verificacion |
|----|------|---------|---------------------|
| AC-1 | W1 | `src/lib/gasless-signer.ts` — `submitGaslessTransfer()` | Test 7 |
| AC-2 | W1 | `src/lib/gasless-signer.ts` — `signTransferWithAuthorization()` + `hexToSignature` | Test 6 |
| AC-3 | W1 | `src/lib/gasless-signer.ts` — `signTransferWithAuthorization()` (validAfter/Before) | Test 4 |
| AC-4 | W1 | `src/lib/gasless-signer.ts` — `getSupportedToken()` + `assertMinimumValue()` | Tests 1, 2, 3, 5 |
| AC-5 | W2 | `src/index.ts` — registro condicional | Smoke DoD W2 (enabled=true → 200; enabled=false → 404) |
| AC-6 | W1 + W2 | `gasless-signer.ts` + `routes/gasless.ts` | Test 8 + try/catch en handler |
| AC-7 | W2 | `src/routes/gasless.ts` + `getGaslessStatus()` | Test 9 + smoke DoD W2 |

---

## Comandos de verificacion (por wave)

```bash
# Tras W0
npx tsc --noEmit

# Tras W1
npx tsc --noEmit
npx vitest run src/lib/gasless-signer.test.ts
grep -n ': any' src/lib/gasless-signer.ts           # debe estar vacio
grep -nE 'log.*(privateKey|signature|body)' src/lib/gasless-signer.ts  # debe estar vacio

# Tras W2
npx tsc --noEmit
npx vitest run

# Smoke manual W2
GASLESS_ENABLED=true OPERATOR_PRIVATE_KEY=0x<test-pk> npm run dev &
curl -sS http://localhost:3001/gasless/status | jq .
# Verificar shape AC-7 y que NO aparece "privateKey" ni el PK en la respuesta
kill %1
```

---

## Anti-Hallucination Protocol para Dev

1. **Antes de cada funcion nueva**: releer el exemplar referenciado en la tabla de archivos. NO escribir de memoria.
2. **Si una API de viem no aparece en `x402-signer.ts`** → verificar contra `node -e "console.log(Object.keys(require('viem')))"` o SALTAR la feature y escalar. NUNCA inventar metodos/firmas.
3. **NUNCA inventar fields del relayer**. Usar exactamente los del contrato del work-item y verificar en pre-flight con curl (A-1, A-2).
4. **Si un test requiere mock de viem internals** → PARAR. Usar PK determinista en su lugar (A-4).
5. **Si algo no esta en este Story File** → PARAR y escalar a Architect. No inventar, no asumir, no improvisar.

---

## Out of Scope — Lo que Dev NO debe tocar

**Archivos EXPLICITAMENTE prohibidos**:
- `src/middleware/x402.ts` (CD-5)
- `src/lib/x402-signer.ts` (CD-2)
- `src/services/kite-client.ts` (solo importar, NO modificar)
- `src/lib/kite-chain.ts` (solo importar `kiteTestnet`, NO agregar `kiteMainnet`)
- **Cualquier otro archivo del repo** no listado en "Files to Modify/Create"

**Features fuera de scope**:
- Mainnet / USDC.e / chain 2366 → WKH-33
- Paymaster / ERC-4337 / Smart accounts
- UI gasless
- Convergencia gasless ↔ x402 settlement
- Modificar tests existentes
- "Mejorar" codigo adyacente
- Refactors no solicitados

---

## BLOQUE PROHIBIDO para el sub-agente Dev (copiar en prompt de F3)

```
⛔ PROHIBIDO EN F3 — WKH-29:
❌ NO tocar archivos fuera del scope listado en "Files to Modify/Create" del story-file.md
❌ NO agregar dependencias npm nuevas (ni ethers, ni ninguna)
❌ NO usar `any` explicito (CD-3)
❌ NO usar ethers.js bajo ninguna circunstancia (CD-7)
❌ NO logear OPERATOR_PRIVATE_KEY, signatures, private keys, nonces ni payloads sensibles (CD-1)
❌ NO modificar work-item.md, sdd.md ni story-file.md (artefactos inmutables)
❌ NO expandir scope a mainnet / USDC.e / chain 2366 (es WKH-33)
❌ NO modificar src/middleware/x402.ts ni src/lib/x402-signer.ts (CD-2, CD-5)
❌ NO saltar el Anti-Hallucination pre-flight (Wave -1)
❌ NO inventar imports de viem que no aparezcan en los exemplars verificados
❌ NO inventar fields del relayer — verificar A-1 y A-2 con curl
❌ NO preguntar "continuo?" — seguir el plan de waves hasta DoD de cada una
```

---

## Escalation Rule

**Si algo NO esta en este Story File, Dev PARA y escala a Architect.**
No inventar. No asumir. No improvisar.

Situaciones de escalation:
- Exemplar referenciado ya no existe / cambio
- Import de viem necesario no esta en la lista verificada
- `curl /supported_tokens` devuelve shape incompatible con el contrato (A-1 falla)
- Smoke POST devuelve error que requiere cambios en la firma de los tipos publicos
- Un AC es ambiguo tras releer esta historia
- Un cambio requiere tocar archivos fuera de la tabla
- Test requiere mock que esta Story File no documenta

---

*Generado: 2026-04-06 | Architect F2.5 | story-file.md (post-SPEC_APPROVED)*
