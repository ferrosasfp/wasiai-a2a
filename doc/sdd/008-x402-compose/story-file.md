# Story File — WKH-9: x402 Compose Client-Side Payment

| Campo | Valor |
|-------|-------|
| HU | WKH-9 (fusiona WKH-11) |
| SDD | `doc/sdd/008-x402-compose/sdd.md` |
| Branch | `feat/wkh-9-x402-compose` |
| Base | `main` |
| Sizing | M |
| Generado | 2026-04-03 — Architect F2.5 NexusAgil |

---

## Acceptance Criteria

| AC | Descripción |
|----|-------------|
| AC-1 | WHEN compose invoca agente cuyo registry tiene `auth`, SHALL incluir headers según `auth.type` (header/bearer) |
| AC-2 | WHEN compose invoca agente con `priceUsdc > 0`, SHALL generar `X-Payment` header firmado con `OPERATOR_PRIVATE_KEY` |
| AC-3 | WHEN agente responde 2xx con `X-Payment`, SHALL settle on-chain y registrar `txHash` en `StepResult` |
| AC-4 | WHEN `maxBudget` se valida, SHALL usar `agent.priceUsdc` (ya implementado — regression guard) |
| AC-5 | WHEN agente tiene `priceUsdc === 0`, SHALL invocar sin `X-Payment` |
| AC-6 | WHEN sign o settle falla, SHALL marcar step failed con error descriptivo |
| AC-7 | WHEN step completa con pago x402, THEN `StepResult.txHash` contiene hash; WHEN sin pago, THEN `undefined` |

## Constraint Directives

| CD | Constraint |
|----|-----------|
| CD-1 | NUNCA logear `OPERATOR_PRIVATE_KEY`, X-Payment decodificado, ni signature raw. Solo txHash post-settle |
| CD-2 | Resolver RegistryConfig via `registryService.getEnabled().find(r => r.name === agent.registry)` — NO `.get()` |
| CD-3 | x402 signer en `src/lib/x402-signer.ts` — NO mezclar con `kite-client.ts` |
| CD-4 | TypeScript strict, sin `any` |
| CD-5 | Solo settle si agent respondió 2xx |
| CD-6 | Nonce único por autorización (`randomBytes(32)`) |
| CD-7 | Lazy wallet client init — no crashea si `OPERATOR_PRIVATE_KEY` falta al import |
| CD-8 | USDC→wei: `Math.round(priceUsdc * 1e6) * 1e12` (aceptable hackathon) |
| CD-9 | `payTo` DEBE venir de `agent.metadata.payTo` — NO fallback a `KITE_WALLET_ADDRESS`. Throw si falta |

---

## Waves

### Wave 1 — Types + Auth Headers (AC-1, AC-5)

**Archivos:** `src/types/index.ts`, `src/services/compose.ts`

**Tests a pasar:** T-1, T-2, T-6, T-7

**Validación:** `npx tsc --noEmit && npx vitest run src/services/compose.test.ts`

### Wave 2 — x402 Signer + Payment (AC-2, AC-3, AC-6, AC-7)

**Archivos:** `src/lib/x402-signer.ts` (NUEVO), `src/services/compose.ts`

**Tests a pasar:** T-3, T-4, T-5, T-8, T-9

**Validación:** `npx tsc --noEmit && npx vitest run src/services/compose.test.ts`

---

## Archivos Afectados

| Archivo | Acción | Wave |
|---------|--------|------|
| `src/types/index.ts` | MODIFICAR — agregar `txHash` a `StepResult` | 1 |
| `src/services/compose.ts` | MODIFICAR — imports, `buildAuthHeaders`, refactor `invokeAgent` | 1, 2 |
| `src/lib/x402-signer.ts` | CREAR | 2 |
| `src/services/compose.test.ts` | CREAR | 1, 2 |

---

## Código Completo

### 1. `src/types/index.ts` — DIFF

Buscar el bloque:
```typescript
export interface StepResult {
  agent: Agent
  output: unknown
  costUsdc: number
  latencyMs: number
}
```

Reemplazar con:
```typescript
export interface StepResult {
  agent: Agent
  output: unknown
  costUsdc: number
  latencyMs: number
  txHash?: string  // Hash de tx on-chain si hubo pago x402
}
```

---

### 2. `src/lib/x402-signer.ts` — ARCHIVO NUEVO

```typescript
/**
 * x402 Client-Side Signer — genera X-Payment header para invocar agentes con pago.
 *
 * Usa viem WalletClient + signTypedData (EIP-712).
 * NUNCA logear privateKey ni signature (CD-1).
 */
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { kiteTestnet } from './kite-chain.js'
import {
  KITE_FACILITATOR_ADDRESS,
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

---

### 3. `src/services/compose.ts` — CÓDIGO COMPLETO (reemplaza archivo entero)

```typescript
/**
 * Compose Service — Execute multi-agent pipelines
 */

import type {
  Agent,
  ComposeRequest,
  ComposeResult,
  ComposeStep,
  StepResult,
  RegistryConfig,
  X402PaymentRequest,
} from '../types/index.js'
import { discoveryService } from './discovery.js'
import { registryService } from './registry.js'
import { signX402Authorization } from '../lib/x402-signer.js'
import { settlePayment } from '../middleware/x402.js'

// ─── Helpers ─────────────────────────────────────────────────

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

// ─── Service ─────────────────────────────────────────────────

export const composeService = {
  /**
   * Execute a composed pipeline
   */
  async compose(request: ComposeRequest): Promise<ComposeResult> {
    const { steps, maxBudget } = request
    const results: StepResult[] = []
    let totalCost = 0
    let totalLatency = 0
    let lastOutput: unknown = null

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]

      // Resolve agent
      const agent = await this.resolveAgent(step)
      if (!agent) {
        return {
          success: false,
          output: null,
          steps: results,
          totalCostUsdc: totalCost,
          totalLatencyMs: totalLatency,
          error: `Agent not found: ${step.agent}`,
        }
      }

      // Check budget
      if (maxBudget && totalCost + agent.priceUsdc > maxBudget) {
        return {
          success: false,
          output: null,
          steps: results,
          totalCostUsdc: totalCost,
          totalLatencyMs: totalLatency,
          error: `Budget exceeded: would need ${totalCost + agent.priceUsdc}, max is ${maxBudget}`,
        }
      }

      // Prepare input
      const input = step.passOutput && lastOutput
        ? { ...step.input, previousOutput: lastOutput }
        : step.input

      // Invoke agent
      const startTime = Date.now()
      try {
        const { output, txHash } = await this.invokeAgent(agent, input)
        const latencyMs = Date.now() - startTime

        const result: StepResult = {
          agent,
          output,
          costUsdc: agent.priceUsdc,
          latencyMs,
          txHash,
        }

        results.push(result)
        totalCost += agent.priceUsdc
        totalLatency += latencyMs
        lastOutput = output

      } catch (err) {
        return {
          success: false,
          output: null,
          steps: results,
          totalCostUsdc: totalCost,
          totalLatencyMs: totalLatency,
          error: `Step ${i} failed: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }

    return {
      success: true,
      output: lastOutput,
      steps: results,
      totalCostUsdc: totalCost,
      totalLatencyMs: totalLatency,
    }
  },

  /**
   * Resolve agent from step
   */
  async resolveAgent(step: ComposeStep): Promise<Agent | null> {
    // Try to get directly by slug
    const agent = await discoveryService.getAgent(step.agent, step.registry)
    if (agent) return agent

    // Try discovery
    const result = await discoveryService.discover({
      query: step.agent,
      limit: 1,
      registry: step.registry,
    })

    return result.agents[0] ?? null
  },

  /**
   * Invoke an agent with auth headers + x402 payment
   */
  async invokeAgent(
    agent: Agent,
    input: Record<string, unknown>,
  ): Promise<{ output: unknown; txHash?: string }> {
    // 1. Resolver RegistryConfig (CD-2)
    const registries = await registryService.getEnabled()
    const registry = registries.find((r: RegistryConfig) => r.name === agent.registry)

    // 2. Auth headers
    const authHeaders = buildAuthHeaders(registry)

    // 3. Build headers
    let paymentRequest: X402PaymentRequest | undefined
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...authHeaders,
    }

    // 4. x402 payment header (proactive, sin roundtrip 402)
    if (agent.priceUsdc > 0) {
      // CD-9: payTo MUST come from agent.metadata — NO fallback
      const payTo = agent.metadata?.payTo as string | undefined
      if (!payTo) {
        throw new Error(
          `No payTo address for agent ${agent.slug} — agent metadata must include payTo`,
        )
      }

      // USDC → wei (6 decimals USDC × 1e12 = 18 decimals wei) (CD-8)
      const valueWei = String(BigInt(Math.round(agent.priceUsdc * 1e6)) * BigInt(1e12))

      const result = await signX402Authorization({
        to: payTo as `0x${string}`,
        value: valueWei,
      })
      headers['X-Payment'] = result.xPaymentHeader
      paymentRequest = result.paymentRequest
    }

    // 5. Invoke
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

    // 6. Settle on-chain (CD-5: solo si pago Y 2xx)
    let txHash: string | undefined
    if (paymentRequest) {
      const settleResult = await settlePayment(paymentRequest)
      if (!settleResult.success) {
        throw new Error(
          `x402 settle failed for ${agent.slug}: ${settleResult.error ?? 'unknown'}`,
        )
      }
      txHash = settleResult.txHash
      // CD-1: solo logear txHash, nunca signature ni payment decoded
      console.log(`[Compose] x402 settled for ${agent.slug} — txHash: ${txHash}`)
    }

    return { output, txHash }
  },
}
```

---

### 4. `src/services/compose.test.ts` — ARCHIVO NUEVO

```typescript
/**
 * Tests for Compose Service — auth headers + x402 payment
 *
 * 9 tests: T-1 through T-9
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type {
  Agent,
  RegistryConfig,
  X402PaymentRequest,
} from '../types/index.js'

// ─── Mocks ───────────────────────────────────────────────────

// Mock registryService
vi.mock('./registry.js', () => ({
  registryService: {
    getEnabled: vi.fn(),
  },
}))

// Mock x402-signer
vi.mock('../lib/x402-signer.js', () => ({
  signX402Authorization: vi.fn(),
}))

// Mock settlePayment
vi.mock('../middleware/x402.js', () => ({
  settlePayment: vi.fn(),
}))

// Mock discoveryService
vi.mock('./discovery.js', () => ({
  discoveryService: {
    getAgent: vi.fn(),
    discover: vi.fn(),
  },
}))

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Import after mocks
import { composeService } from './compose.js'
import { registryService } from './registry.js'
import { signX402Authorization } from '../lib/x402-signer.js'
import { settlePayment } from '../middleware/x402.js'
import { discoveryService } from './discovery.js'

// ─── Fixtures ────────────────────────────────────────────────

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    slug: 'test-agent',
    description: 'A test agent',
    capabilities: ['test'],
    priceUsdc: 0,
    registry: 'test-registry',
    invokeUrl: 'https://example.com/invoke',
    metadata: {},
    ...overrides,
  }
}

function makeRegistry(overrides: Partial<RegistryConfig> = {}): RegistryConfig {
  return {
    id: 'reg-1',
    name: 'test-registry',
    discoveryEndpoint: 'https://example.com/discover',
    invokeEndpoint: 'https://example.com/invoke/{slug}',
    schema: {
      discovery: {},
      invoke: { method: 'POST' },
    },
    enabled: true,
    createdAt: new Date(),
    ...overrides,
  }
}

function mockFetchOk(data: unknown = { result: 'ok' }) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => data,
  })
}

function mockFetchError(status: number) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => ({ error: 'fail' }),
  })
}

// ─── Setup ───────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  // Default: discoveryService.getAgent returns the agent directly
  vi.mocked(discoveryService.getAgent).mockImplementation(async () => null)
  vi.mocked(discoveryService.discover).mockImplementation(async () => ({
    agents: [],
    total: 0,
    registries: [],
  }))
})

// ─── Tests ───────────────────────────────────────────────────

describe('composeService.invokeAgent', () => {
  // T-1: Auth headers — bearer
  it('T-1: includes Bearer auth header from registry', async () => {
    const registry = makeRegistry({
      auth: { type: 'bearer', key: 'Authorization', value: 'test-token' },
    })
    vi.mocked(registryService.getEnabled).mockResolvedValue([registry])

    const agent = makeAgent({ priceUsdc: 0 })
    mockFetchOk()

    await composeService.invokeAgent(agent, { q: 'hello' })

    const callHeaders = mockFetch.mock.calls[0][1].headers
    expect(callHeaders['Authorization']).toBe('Bearer test-token')
    expect(callHeaders['X-Payment']).toBeUndefined()
  })

  // T-2: Auth headers — header type
  it('T-2: includes custom header auth from registry', async () => {
    const registry = makeRegistry({
      auth: { type: 'header', key: 'X-API-Key', value: 'abc123' },
    })
    vi.mocked(registryService.getEnabled).mockResolvedValue([registry])

    const agent = makeAgent({ priceUsdc: 0 })
    mockFetchOk()

    await composeService.invokeAgent(agent, { q: 'hello' })

    const callHeaders = mockFetch.mock.calls[0][1].headers
    expect(callHeaders['X-API-Key']).toBe('abc123')
  })

  // T-3: x402 payment — happy path
  it('T-3: generates X-Payment header and settles on success', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([])

    const mockPaymentRequest: X402PaymentRequest = {
      authorization: {
        from: '0xAAA',
        to: '0xBBB',
        value: '1000000000000000000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: '0x1234',
      },
      signature: '0xSIG',
      network: 'kite-testnet',
    }

    vi.mocked(signX402Authorization).mockResolvedValue({
      xPaymentHeader: 'base64mock',
      paymentRequest: mockPaymentRequest,
    })

    vi.mocked(settlePayment).mockResolvedValue({
      success: true,
      txHash: '0xDEADBEEF',
    })

    const agent = makeAgent({
      priceUsdc: 1.0,
      metadata: { payTo: '0xBBB' },
    })
    mockFetchOk()

    const result = await composeService.invokeAgent(agent, { q: 'hello' })

    // X-Payment header sent
    const callHeaders = mockFetch.mock.calls[0][1].headers
    expect(callHeaders['X-Payment']).toBe('base64mock')

    // Settle called
    expect(settlePayment).toHaveBeenCalledWith(mockPaymentRequest)

    // txHash returned
    expect(result.txHash).toBe('0xDEADBEEF')
    expect(result.output).toBe('ok')
  })

  // T-4: x402 — settle failure
  it('T-4: throws when settle fails', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([])
    vi.mocked(signX402Authorization).mockResolvedValue({
      xPaymentHeader: 'base64mock',
      paymentRequest: {
        authorization: {
          from: '0xAAA', to: '0xBBB', value: '1', validAfter: '0',
          validBefore: '9999999999', nonce: '0x1234',
        },
        signature: '0xSIG',
        network: 'kite-testnet',
      },
    })
    vi.mocked(settlePayment).mockResolvedValue({
      success: false,
      txHash: '',
      error: 'insufficient funds',
    })

    const agent = makeAgent({
      priceUsdc: 1.0,
      metadata: { payTo: '0xBBB' },
    })
    mockFetchOk()

    await expect(
      composeService.invokeAgent(agent, { q: 'hello' }),
    ).rejects.toThrow('x402 settle failed')
  })

  // T-5: agent returns non-2xx — no settle (CD-5)
  it('T-5: does not settle when agent returns non-2xx', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([])
    vi.mocked(signX402Authorization).mockResolvedValue({
      xPaymentHeader: 'base64mock',
      paymentRequest: {
        authorization: {
          from: '0xAAA', to: '0xBBB', value: '1', validAfter: '0',
          validBefore: '9999999999', nonce: '0x1234',
        },
        signature: '0xSIG',
        network: 'kite-testnet',
      },
    })

    const agent = makeAgent({
      priceUsdc: 1.0,
      metadata: { payTo: '0xBBB' },
    })
    mockFetchError(500)

    await expect(
      composeService.invokeAgent(agent, { q: 'hello' }),
    ).rejects.toThrow('returned 500')

    expect(settlePayment).not.toHaveBeenCalled()
  })

  // T-6: No registry found — still invokes without auth headers
  it('T-6: invokes without auth headers when registry not found', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([])

    const agent = makeAgent({ priceUsdc: 0 })
    mockFetchOk()

    const result = await composeService.invokeAgent(agent, { q: 'hello' })

    const callHeaders = mockFetch.mock.calls[0][1].headers
    expect(callHeaders['Content-Type']).toBe('application/json')
    expect(callHeaders['Authorization']).toBeUndefined()
    expect(result.output).toBe('ok')
  })

  // T-7: Budget check with priceUsdc (regression)
  it('T-7: budget check rejects when cost exceeds maxBudget', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([])

    const agent1 = makeAgent({ slug: 'a1', priceUsdc: 0.5 })
    const agent2 = makeAgent({ slug: 'a2', priceUsdc: 0.6 })

    vi.mocked(discoveryService.getAgent)
      .mockResolvedValueOnce(agent1)
      .mockResolvedValueOnce(agent2)

    // Mock invokeAgent fetch for step 1 only (step 2 should be budget-rejected)
    mockFetchOk({ result: 'step1-done' })

    const result = await composeService.compose({
      steps: [
        { agent: 'a1', input: {} },
        { agent: 'a2', input: {} },
      ],
      maxBudget: 1.0,
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Budget exceeded')
    expect(result.steps).toHaveLength(1)
  })

  // T-8: payTo missing → error (CD-9)
  it('T-8: throws when agent.metadata.payTo is missing', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([])

    const agent = makeAgent({
      priceUsdc: 1.0,
      metadata: {}, // no payTo!
    })

    await expect(
      composeService.invokeAgent(agent, { q: 'hello' }),
    ).rejects.toThrow('No payTo address')
  })

  // T-9: Private key / signature never logged (CD-1)
  it('T-9: console.log never receives private key or raw signature', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    vi.mocked(registryService.getEnabled).mockResolvedValue([])
    vi.mocked(signX402Authorization).mockResolvedValue({
      xPaymentHeader: 'base64mock',
      paymentRequest: {
        authorization: {
          from: '0xAAA', to: '0xBBB', value: '1', validAfter: '0',
          validBefore: '9999999999', nonce: '0x1234',
        },
        signature: '0xSECRET_SIG_VALUE',
        network: 'kite-testnet',
      },
    })
    vi.mocked(settlePayment).mockResolvedValue({
      success: true,
      txHash: '0xTXHASH',
    })

    const agent = makeAgent({
      priceUsdc: 1.0,
      metadata: { payTo: '0xBBB' },
    })
    mockFetchOk()

    // Set a fake private key in env
    const originalPK = process.env.OPERATOR_PRIVATE_KEY
    process.env.OPERATOR_PRIVATE_KEY = '0xDEAD_PRIVATE_KEY_NEVER_LOG'

    try {
      await composeService.invokeAgent(agent, { q: 'hello' })
    } finally {
      process.env.OPERATOR_PRIVATE_KEY = originalPK
    }

    // Check no log call contains private key or raw signature
    for (const call of logSpy.mock.calls) {
      const logStr = call.join(' ')
      expect(logStr).not.toContain('DEAD_PRIVATE_KEY_NEVER_LOG')
      expect(logStr).not.toContain('SECRET_SIG_VALUE')
    }

    logSpy.mockRestore()
  })
})
```

---

## DoD (Definition of Done)

- [ ] `npx tsc --noEmit` — zero errors
- [ ] `npx vitest run src/services/compose.test.ts` — 9/9 pass
- [ ] No `any` en código nuevo
- [ ] `OPERATOR_PRIVATE_KEY` y signature nunca aparecen en logs
- [ ] `payTo` sin fallback — throw si falta (CD-9)
- [ ] Settle solo post-2xx (CD-5)
- [ ] PR a `feat/wkh-9-x402-compose` desde `main`

---

## Exemplar: Invocación con pago x402

```
Agent: { slug: 'kite-summarizer', priceUsdc: 0.5, metadata: { payTo: '0xABC...' }, registry: 'kite' }

1. resolveRegistry → RegistryConfig con auth: { type: 'bearer', value: 'api-key-123' }
2. buildAuthHeaders → { Authorization: 'Bearer api-key-123' }
3. priceUsdc > 0 → signX402Authorization({ to: '0xABC...', value: '500000000000000000' })
4. headers = { Content-Type, Authorization: 'Bearer api-key-123', X-Payment: 'eyJ...' }
5. fetch(invokeUrl, { headers, body }) → 200
6. settlePayment(paymentRequest) → { success: true, txHash: '0xDEAD...' }
7. return { output: ..., txHash: '0xDEAD...' }
```

---

*Story File generado por Architect — F2.5 NexusAgil | 2026-04-03*
