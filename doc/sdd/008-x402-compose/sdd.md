# SDD-008 — x402 Compose Client-Side Payment

| Campo | Valor |
|-------|-------|
| Work Item | `doc/sdd/008-x402-compose/work-item.md` |
| HU | WKH-9 (fusiona WKH-11) |
| Branch | `feat/wkh-9-x402-compose` |
| Autor | Architect (F2 NexusAgil) |
| Fecha | 2026-04-03 |

---

## 1. Context Map — Patrones Extraídos del Codebase

### 1.1 Auth Headers (discovery.ts:queryRegistry L60-66)
```typescript
// Patrón real extraído:
if (registry.auth?.type === 'header' && registry.auth.value) {
  headers[registry.auth.key] = registry.auth.value
} else if (registry.auth?.type === 'bearer' && registry.auth.value) {
  headers['Authorization'] = `Bearer ${registry.auth.value}`
}
```
→ Reutilizar exactamente este patrón en compose. Falta el caso `type === 'query'` (query param auth) — discovery tampoco lo implementa; para compose ignoramos `query` type (no aplica a POST body invocations).

### 1.2 Registry Resolution
- `Agent.registry` es un **name** (string), NO un id.
- Resolver: `registryService.getEnabled().find(r => r.name === agent.registry)`
- discovery.ts usa `registryService.get(id)` que busca por **id** — distinto patrón.

### 1.3 Wallet Client Pattern (kite-client.ts)
- `kite-client.ts` crea un **PublicClient** (readonly, no firma).
- Para firmar necesitamos **WalletClient** con `createWalletClient` + `privateKeyToAccount` de viem.
- Archivo separado: `src/lib/x402-signer.ts` (CD-3).

### 1.4 x402 Server-Side (middleware/x402.ts)
- `settlePayment(payload: X402PaymentRequest)` → `PieverseSettleResult { txHash, success, error }` — reutilizable as-is para client-side settle.
- `KITE_FACILITATOR_ADDRESS`, `KITE_PAYMENT_TOKEN`, `KITE_NETWORK` — constantes exportadas, reutilizables.

### 1.5 Types (types/index.ts)
- `X402PaymentRequest` — `{ authorization: { from, to, value, validAfter, validBefore, nonce }, signature }` — esto es lo que firmamos y codificamos en base64 para `X-Payment` header.
- `StepResult` — actualmente `{ agent, output, costUsdc, latencyMs }` — falta `txHash`.

### 1.6 Chain (kite-chain.ts)
- `kiteTestnet.id === 2368` — para EIP-712 domain.

---

## 2. Diseño Detallado

### 2.1 Nuevo archivo: `src/lib/x402-signer.ts`

```typescript
/**
 * x402 Client-Side Signer — genera X-Payment header para invocar agentes con pago.
 *
 * Usa viem WalletClient + signTypedData (EIP-712).
 * NUNCA logear privateKey ni signature.
 */
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { kiteTestnet } from './kite-chain.js'
import {
  KITE_FACILITATOR_ADDRESS,
  KITE_PAYMENT_TOKEN,
  KITE_NETWORK,
} from '../middleware/x402.js'
import type { X402PaymentRequest } from '../types/index.js'
import { randomBytes } from 'node:crypto'

// ─── EIP-712 Domain & Types ──────────────────────────────────

const EIP712_DOMAIN = {
  name: 'Kite x402',
  version: '1',
  chainId: kiteTestnet.id, // 2368
  verifyingContract: KITE_FACILITATOR_ADDRESS,
} as const

const EIP712_TYPES = {
  Authorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

// ─── Wallet Client (lazy singleton) ─────────────────────────

let _walletClient: ReturnType<typeof createWalletClient> | null = null

function getWalletClient() {
  if (_walletClient) return _walletClient

  const pk = process.env.OPERATOR_PRIVATE_KEY
  if (!pk) {
    throw new Error('OPERATOR_PRIVATE_KEY not set — x402 client signing disabled')
  }

  const account = privateKeyToAccount(pk as `0x${string}`)
  _walletClient = createWalletClient({
    account,
    chain: kiteTestnet,
    transport: http(process.env.KITE_RPC_URL),
  })

  return _walletClient
}

// ─── Public API ──────────────────────────────────────────────

export interface SignX402Options {
  /** Wallet del service provider (payTo) */
  to: `0x${string}`
  /** Monto en wei (string) */
  value: string
  /** Timeout en segundos (default 300) */
  timeoutSeconds?: number
}

/**
 * Firma una autorización x402 EIP-712 y retorna el X-Payment header (base64).
 *
 * @returns base64-encoded JSON de X402PaymentRequest
 */
export async function signX402Authorization(
  opts: SignX402Options,
): Promise<{ xPaymentHeader: string; paymentRequest: X402PaymentRequest }> {
  const client = getWalletClient()
  const account = client.account!

  const now = Math.floor(Date.now() / 1000)
  const nonce = `0x${randomBytes(32).toString('hex')}` as `0x${string}`

  const authorization = {
    from: account.address,
    to: opts.to,
    value: opts.value,
    validAfter: '0',
    validBefore: String(now + (opts.timeoutSeconds ?? 300)),
    nonce,
  }

  const signature = await client.signTypedData({
    account,
    domain: EIP712_DOMAIN,
    types: EIP712_TYPES,
    primaryType: 'Authorization',
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce as `0x${string}`,
    },
  })

  const paymentRequest: X402PaymentRequest = {
    authorization,
    signature,
    network: KITE_NETWORK,
  }

  const xPaymentHeader = Buffer.from(
    JSON.stringify(paymentRequest),
  ).toString('base64')

  return { xPaymentHeader, paymentRequest }
}

/**
 * Reset del singleton para testing.
 * @internal
 */
export function _resetWalletClient(): void {
  _walletClient = null
}
```

**Decisiones clave:**
- Lazy singleton: no crashea al importar si `OPERATOR_PRIVATE_KEY` falta.
- `signTypedData` convierte `value`/`validAfter`/`validBefore` a `BigInt` en el message (requerimiento viem para uint256).
- `nonce` es `bytes32` random — evita replay.
- `_resetWalletClient()` exportado solo para tests.

### 2.2 Refactor: `src/services/compose.ts`

#### 2.2.1 Nuevos imports
```typescript
import type { RegistryConfig } from '../types/index.js'
import { registryService } from './registry.js'
import { signX402Authorization } from '../lib/x402-signer.js'
import { settlePayment } from '../middleware/x402.js'
import type { X402PaymentRequest } from '../types/index.js'
```

#### 2.2.2 Helper: `buildAuthHeaders`
```typescript
/**
 * Construye headers de autenticación basados en el RegistryConfig.
 * Patrón extraído de discovery.ts:queryRegistry.
 */
function buildAuthHeaders(registry: RegistryConfig | undefined): Record<string, string> {
  const headers: Record<string, string> = {}

  if (!registry?.auth?.value) return headers

  switch (registry.auth.type) {
    case 'header':
      headers[registry.auth.key] = registry.auth.value
      break
    case 'bearer':
      headers['Authorization'] = `Bearer ${registry.auth.value}`
      break
    // 'query' no aplica a POST invocations — skip
  }

  return headers
}
```

#### 2.2.3 Refactor `invokeAgent`

Firma nueva: `async invokeAgent(agent: Agent, input: Record<string, unknown>): Promise<{ output: unknown; txHash?: string }>`

```typescript
async invokeAgent(
  agent: Agent,
  input: Record<string, unknown>,
): Promise<{ output: unknown; txHash?: string }> {
  // 1. Resolver RegistryConfig
  const registries = await registryService.getEnabled()
  const registry = registries.find(r => r.name === agent.registry)

  // 2. Auth headers
  const authHeaders = buildAuthHeaders(registry)

  // 3. x402 payment header (proactive, sin roundtrip 402)
  let paymentRequest: X402PaymentRequest | undefined
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...authHeaders,
  }

  if (agent.priceUsdc > 0) {
    // payTo: agente metadata o wallet del registry — usar agent.metadata?.payTo o KITE_WALLET_ADDRESS como fallback
    const payTo = agent.metadata?.payTo as string | undefined
    if (!payTo) {
      throw new Error(`No payTo address for agent ${agent.slug} — agent metadata must include payTo`)
    }

    // Convertir USDC a wei (6 decimals para Test USDT / USDC)
    const valueWei = String(BigInt(Math.round(agent.priceUsdc * 1e6)) * BigInt(1e12))

    const result = await signX402Authorization({
      to: payTo as `0x${string}`,
      value: valueWei,
    })
    headers['X-Payment'] = result.xPaymentHeader
    paymentRequest = result.paymentRequest
  }

  // 4. Invoke
  const response = await fetch(agent.invokeUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ input }),
  })

  if (!response.ok) {
    throw new Error(`Agent ${agent.slug} returned ${response.status}`)
  }

  const data = await response.json()
  const output = data.result ?? data

  // 5. Settle on-chain (solo si pago y 2xx)
  let txHash: string | undefined
  if (paymentRequest) {
    const settleResult = await settlePayment(paymentRequest)
    if (!settleResult.success) {
      throw new Error(`x402 settle failed for ${agent.slug}: ${settleResult.error ?? 'unknown'}`)
    }
    txHash = settleResult.txHash
    console.log(`[Compose] x402 settled for ${agent.slug} — txHash: ${txHash}`)
  }

  return { output, txHash }
}
```

#### 2.2.4 Actualizar `compose()` para consumir `{ output, txHash }`

En el bloque try del loop:
```typescript
const { output, txHash } = await this.invokeAgent(agent, input)
const latencyMs = Date.now() - startTime

const result: StepResult = {
  agent,
  output,
  costUsdc: agent.priceUsdc,
  latencyMs,
  txHash,
}
```

### 2.3 Cambio de tipos: `src/types/index.ts`

```typescript
export interface StepResult {
  agent: Agent
  output: unknown
  costUsdc: number
  latencyMs: number
  txHash?: string  // ← NUEVO: hash de la tx on-chain si hubo pago x402
}
```

---

## 3. Tests — `src/services/compose.test.ts`

### T-1: Auth headers — bearer
- Mock `registryService.getEnabled()` → registry con `auth: { type: 'bearer', key: 'Authorization', value: 'test-token' }`
- Mock `fetch` → capture headers
- Invoke agent con `priceUsdc: 0`
- **Assert:** `Authorization: Bearer test-token` presente, NO `X-Payment`

### T-2: Auth headers — header type
- Registry con `auth: { type: 'header', key: 'X-API-Key', value: 'abc123' }`
- **Assert:** `X-API-Key: abc123` presente

### T-3: x402 payment — happy path
- Agent con `priceUsdc: 1.0`, `metadata.payTo: '0xABC...'`
- Mock `signX402Authorization` → `{ xPaymentHeader: 'base64mock', paymentRequest: {...} }`
- Mock `fetch` → 200
- Mock `settlePayment` → `{ success: true, txHash: '0xDEAD' }`
- **Assert:** `X-Payment` header presente, `settlePayment` llamado, result.txHash === '0xDEAD'

### T-4: x402 — settle failure
- Same setup, `settlePayment` → `{ success: false, error: 'insufficient funds' }`
- **Assert:** throw con mensaje "x402 settle failed"

### T-5: x402 — agent returns non-2xx (no settle)
- Mock `fetch` → 500
- **Assert:** throw, `settlePayment` NOT called (CD-5)

### T-6: No registry found — still invokes
- `registryService.getEnabled()` → `[]`
- Agent con `priceUsdc: 0`
- **Assert:** invoca sin auth headers, no error

### T-7: Budget check con priceUsdc (regression)
- 2-step pipeline: step1 priceUsdc=0.5, step2 priceUsdc=0.6, maxBudget=1.0
- **Assert:** step2 fails budget check

### T-8: payTo missing → error
- Agent con `priceUsdc: 1.0`, sin `metadata.payTo`
- **Assert:** throw con mensaje "No payTo address"

### T-9: Private key not logged
- Verify que `console.log` nunca recibe string conteniendo private key ni signature raw.
- (Implementar via spy on console.log + regex guard)

---

## 4. Constraint Directives

| # | Constraint | Cómo se cumple |
|---|-----------|----------------|
| CD-1 | No logear OPERATOR_PRIVATE_KEY, X-Payment decoded, signature | Solo se logea `txHash` post-settle. Signer no logea nada. T-8 verifica. |
| CD-2 | Resolver RegistryConfig via `getEnabled().find(r => r.name === agent.registry)` | Implementado en `invokeAgent()` §2.2.3 paso 1 |
| CD-3 | x402 signer en `src/lib/x402-signer.ts`, separado de kite-client.ts | Archivo nuevo dedicado §2.1 |
| CD-4 | TypeScript strict, sin `any` | Todos los tipos explícitos, interfaces usadas |
| CD-5 | Solo settle si agent respondió 2xx | Settle después del `if (!response.ok)` throw §2.2.3 paso 5 |
| CD-6 (adicional) | Nonce único por autorización | `randomBytes(32)` en signer |
| CD-7 (adicional) | Lazy wallet client init | No crashea si OPERATOR_PRIVATE_KEY falta al import |
| CD-8 (adicional) | USDC→wei precision usa Math.round — aceptable hackathon, producción usar decimal lib | Math.round(priceUsdc * 1e6) |
| CD-9 (adicional) | payTo DEBE venir de agent.metadata — NO fallback a KITE_WALLET_ADDRESS | throw si falta |

---

## 5. Wave Plan

### Wave 1 — Types + Auth Headers (AC-1, AC-5)
**Archivos:** `src/types/index.ts`, `src/services/compose.ts`
**Cambios:**
1. Agregar `txHash?: string` a `StepResult`
2. Agregar `buildAuthHeaders()` helper
3. Refactor `invokeAgent` signature → `Promise<{ output, txHash? }>`
4. Implementar registry resolution + auth headers (sin x402 aún)
5. Actualizar `compose()` loop para new return type
**Tests:** T-1, T-2, T-6, T-7
**Validación:** `tsc --noEmit` + tests pass

### Wave 2 — x402 Signer + Payment (AC-2, AC-3, AC-6, AC-7)
**Archivos:** `src/lib/x402-signer.ts` (nuevo), `src/services/compose.ts`
**Cambios:**
1. Crear `x402-signer.ts` completo
2. Agregar x402 logic en `invokeAgent()` (sign + header + settle)
**Tests:** T-3, T-4, T-5, T-8
**Validación:** `tsc --noEmit` + all tests pass

### Wave 3 — Integration Smoke (AC-4)
**Validación manual:**
1. Verificar budget check end-to-end (T-7 ya cubre unit)
2. Smoke test con agente real en Kite testnet (si disponible)
3. Verificar txHash aparece en ComposeResult.steps

---

## 6. Readiness Check

| Criterio | Estado |
|----------|--------|
| Todos los AC cubiertos por diseño | ✅ AC-1→AC-7 |
| Todos los AC cubiertos por tests | ✅ T-1→T-8 |
| CDs del Work Item cubiertos | ✅ CD-1→CD-5 + 2 adicionales |
| Archivos a modificar identificados | ✅ 4 archivos (1 nuevo) |
| Sin dependencias npm nuevas | ✅ Solo viem (ya instalado) + node:crypto (built-in) |
| Sin cambios a server-side middleware | ✅ Solo reutiliza exports |
| Wave plan con validación por wave | ✅ |
| Anti-hallucination: todos los patrones extraídos de código real | ✅ |

---

## 7. Archivos Afectados (Resumen)

| Archivo | Acción | Wave |
|---------|--------|------|
| `src/types/index.ts` | Modificar — `StepResult.txHash` | 1 |
| `src/services/compose.ts` | Modificar — auth + x402 + registry resolution | 1, 2 |
| `src/lib/x402-signer.ts` | **Crear** — EIP-712 signer | 2 |
| `src/services/compose.test.ts` | **Crear** — 8 tests | 1, 2 |

---

*SDD generado por Architect+Adversary — F2 NexusAgil | 2026-04-03*
