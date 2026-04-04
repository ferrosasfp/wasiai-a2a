# Story File #012 — WKH-13: POST /orchestrate Flujo Completo

> **DEV: Lee SOLO este documento. No leas el SDD ni el Work Item.**
> Si algo no está claro → escala a Architect, no inventes.

---

## Goal

Completar POST /orchestrate con flujo end-to-end production-ready: orchestrationId único por request, logs estructurados por paso, timeout global 120s, protocolFeeUsdc (1% del costo), attestation on-chain en Kite Ozone, y respuesta actualizada.

---

## Acceptance Criteria

1. WHEN POST /orchestrate recibe goal → SHALL generar orchestrationId UUID único
2. WHEN cada paso ocurre (discover/plan/compose/attest) → SHALL emitir log `{ orchestrationId, step, timestamp, detail }`
3. WHEN orquestación completa → SHALL retornar `{ orchestrationId, answer, reasoning, steps, totalCostUsdc, protocolFeeUsdc, attestationTxHash }`
4. WHEN totalCostUsdc calculado → protocolFeeUsdc SHALL ser exactamente 1%
5. WHEN flujo supera 120s → SHALL responder HTTP 504 `{ error: 'Orchestration timeout: exceeded 120s' }`
6. WHEN orquestación finaliza → SHALL registrar orchestrationId+pipelineHash on-chain en Kite Ozone
7. WHEN goal = "Analyze token 0xABC" → flujo completo SHALL correr sin errores

---

## Files to Create/Modify

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `src/types/index.ts` | Modificar | Actualizar OrchestrateResult | `src/types/index.ts` |
| `src/lib/kite-attestation.ts` | CREAR | Attestation on-chain vía viem | `src/lib/x402-signer.ts` |
| `src/services/orchestrate.ts` | Modificar | orchestrationId + logs + timeout + fees + attestation | `src/services/orchestrate.ts` |
| `src/routes/orchestrate.ts` | Modificar mínimo | Pasar kiteTxHash al servicio | `src/routes/orchestrate.ts` |
| `test/orchestrate.test.ts` | CREAR | Tests del flujo completo | `src/services/compose.test.ts` |

---

## Exemplars (código real del proyecto)

### Patrón wallet client (de src/lib/x402-signer.ts)
```typescript
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { kiteTestnet } from './kite-chain.js'

let _walletClient: ReturnType<typeof createWalletClient> | null = null

function getWalletClient() {
  if (_walletClient) return _walletClient
  const pk = process.env.OPERATOR_PRIVATE_KEY
  if (!pk) throw new Error('OPERATOR_PRIVATE_KEY not set')
  const account = privateKeyToAccount(pk as `0x${string}`)
  _walletClient = createWalletClient({ account, chain: kiteTestnet, transport: http() })
  return _walletClient
}
```

### Patrón de test con mocks (de src/services/compose.test.ts)
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('./registry.js', () => ({ registryService: { getEnabled: vi.fn() } }))
vi.mock('./discovery.js', () => ({ discoveryService: { discover: vi.fn() } }))

beforeEach(() => { vi.resetAllMocks() })

it('should do X', async () => {
  vi.mocked(discoveryService.discover).mockResolvedValue({ agents: [...] })
  const result = await orchestrateService.orchestrate({ goal: 'test', budget: 1 })
  expect(result.orchestrationId).toBeDefined()
})
```

### OrchestrateResult actual (de src/types/index.ts)
```typescript
export interface OrchestrateResult {
  answer: unknown
  reasoning: string
  pipeline: ComposeResult
  consideredAgents: Agent[]
}
```

### ComposeResult (de src/types/index.ts)
```typescript
export interface ComposeResult {
  success: boolean
  output: unknown
  steps: StepResult[]
  totalCostUsdc: number
  totalLatencyMs: number
  error?: string
}
```

---

## Waves de Implementación

### Wave 0 — Tipos (prerrequisito)

**W0.1** — Actualizar `src/types/index.ts`:
```typescript
// Reemplazar OrchestrateResult existente:
export interface OrchestrateResult {
  orchestrationId: string
  answer: unknown
  reasoning: string
  steps: StepResult[]           // de pipeline.steps
  totalCostUsdc: number         // de pipeline.totalCostUsdc
  protocolFeeUsdc: number       // 1% de totalCostUsdc
  attestationTxHash?: string    // null si attestation no configurada o falla
  consideredAgents: Agent[]     // mantener por compatibilidad
}
```
Verificar: `npm run typecheck` sin errores (esperados — orchestrate.ts aún no actualizado).

---

### Wave 1 — Crear kite-attestation.ts

**W1.1** — Crear `src/lib/kite-attestation.ts`:

Seguir patrón de `src/lib/x402-signer.ts`.

```typescript
/**
 * Kite Attestation — Registra orchestrationId + pipelineHash on-chain en Kite Ozone.
 * No bloqueante: si falla → log warning + return null.
 */
import { createWalletClient, http, createPublicClient, encodePacked, keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { kiteTestnet } from './kite-chain.js'

let _walletClient: ReturnType<typeof createWalletClient> | null = null

function getWalletClient() {
  if (_walletClient) return _walletClient
  const pk = process.env.OPERATOR_PRIVATE_KEY
  if (!pk) throw new Error('OPERATOR_PRIVATE_KEY not set')
  const account = privateKeyToAccount(pk as `0x${string}`)
  _walletClient = createWalletClient({ account, chain: kiteTestnet, transport: http() })
  return _walletClient
}

/**
 * Calcula el hash del pipeline para attestation.
 * Input: cualquier objeto serializable → keccak256 de su JSON.
 */
export function computePipelineHash(pipeline: unknown): string {
  const json = JSON.stringify(pipeline)
  return keccak256(toHex(json))
}

/**
 * Registra orchestrationId + pipelineHash on-chain.
 * Usa sendTransaction con calldata codificado (sin contrato específico).
 * Destino: KITE_ATTEST_CONTRACT env var o address(0) si no está configurada.
 * 
 * Retorna txHash si exitoso, null si falla o no hay OPERATOR_PRIVATE_KEY.
 */
export async function attestOrchestration(
  orchestrationId: string,
  pipelineHash: string,
): Promise<string | null> {
  try {
    const client = getWalletClient()
    const to = (process.env.KITE_ATTEST_CONTRACT as `0x${string}`) ?? '0x0000000000000000000000000000000000000000'
    // Calldata: bytes(orchestrationId) + bytes(pipelineHash)
    const calldata = toHex(`${orchestrationId}:${pipelineHash}`)
    const txHash = await client.sendTransaction({ to, data: calldata, value: 0n })
    console.log(JSON.stringify({
      orchestrationId,
      step: 'attest-sent',
      timestamp: new Date().toISOString(),
      detail: { txHash, contract: to },
    }))
    return txHash
  } catch (err) {
    console.warn('[kite-attestation] Attestation failed (non-blocking):', err instanceof Error ? err.message : String(err))
    return null
  }
}
```

Verificar: typecheck.

---

### Wave 2 — Actualizar orchestrate.ts (depende W0 + W1)

**W2.1** — Re-leer `src/services/orchestrate.ts` actual antes de editar.

Modificar el método `orchestrate()`:

1. Importar `attestOrchestration` y `computePipelineHash` desde `'../lib/kite-attestation.js'`
2. Al inicio del método: `const orchestrationId = crypto.randomUUID()`
3. Helper de log estructurado (función local inline):
   ```typescript
   const log = (step: string, detail: Record<string, unknown> = {}) => {
     console.log(JSON.stringify({ orchestrationId, step, timestamp: new Date().toISOString(), detail }))
   }
   ```
4. Wrap todo el pipeline en `Promise.race`:
   ```typescript
   const TIMEOUT_MS = 120_000
   const timeoutPromise = new Promise<never>((_, reject) =>
     setTimeout(() => reject(Object.assign(new Error('TIMEOUT'), { code: 'ORCHESTRATION_TIMEOUT' })), TIMEOUT_MS)
   )
   const pipeline = this._runPipeline(orchestrationId, request, log)
   const result = await Promise.race([pipeline, timeoutPromise])
   return result
   ```
5. Extraer lógica del pipeline a método privado `_runPipeline(orchestrationId, request, log)`:
   - `log('discover', { query: goal })`
   - `const discovered = await discoveryService.discover(...)`
   - `log('plan', { agentsFound: discovered.agents.length })`
   - LLM planning...
   - `log('compose', { steps: steps.length })`
   - `const pipeline = await composeService.compose(...)`
   - `const protocolFeeUsdc = pipeline.totalCostUsdc * 0.01`
   - `const pipelineHash = computePipelineHash(pipeline)`
   - `log('attest', { pipelineHash })`
   - `const attestationTxHash = await attestOrchestration(orchestrationId, pipelineHash) ?? undefined`
   - `log('done', { totalCostUsdc: pipeline.totalCostUsdc, attestationTxHash })`
   - Return:
     ```typescript
     return {
       orchestrationId,
       answer: pipeline.output,
       reasoning,
       steps: pipeline.steps,
       totalCostUsdc: pipeline.totalCostUsdc,
       protocolFeeUsdc,
       attestationTxHash,
       consideredAgents: discovered.agents,
     }
     ```

Verificar: typecheck.

---

### Wave 3 — Route + Tests

**W3.1** — Actualizar `src/routes/orchestrate.ts` mínimamente:

El handler ya tiene `request.kiteTxHash`. Solo actualizar el return del handler para incluir los nuevos campos (ya vendrán de `orchestrateService.orchestrate()`). Remover el `kiteTxHash, ...result` spread manual porque ahora viene en result como `attestationTxHash`.

Cambio concreto en handler:
```typescript
// ANTES:
const kiteTxHash = request.kiteTxHash
return reply.send({ kiteTxHash, ...result })

// DESPUÉS:
return reply.send(result)
// (orchestrationId y attestationTxHash ya vienen en result)
```

También agregar manejo del timeout error en el catch block:
```typescript
if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ORCHESTRATION_TIMEOUT') {
  return reply.status(504).send({ error: 'Orchestration timeout: exceeded 120s' })
}
```

**W3.2** — Crear `test/orchestrate.test.ts`:

Tests con vitest. Mockear: discoveryService, composeService, kite-attestation.

Tests requeridos:
1. T-1: `orchestrate()` retorna orchestrationId válido (UUID)
2. T-2: response incluye `protocolFeeUsdc = totalCostUsdc * 0.01`
3. T-3: response incluye `steps` del pipeline
4. T-4: timeout 120s → Error con code ORCHESTRATION_TIMEOUT
5. T-5: attestation falla → orquestación igual exitosa, `attestationTxHash = undefined`

Verificar: `npm run test` pasa.

---

### Wave 4 — Verificación Final

**W4.1** — Ejecutar suite completa:
```bash
npm run typecheck
npm run test
npm run build
```

---

## Constraint Directives

### OBLIGATORIO
- `crypto.randomUUID()` para orchestrationId (no npm uuid)
- Logs como `console.log(JSON.stringify({...}))` — formato JSON estricto
- `viem` para todo lo blockchain — NO ethers.js
- Attestation no bloqueante — errores no interrumpen el flujo
- Singleton lazy para wallet client (patrón de x402-signer.ts)

### PROHIBIDO
- NO modificar `src/middleware/x402.ts`
- NO modificar `src/services/llm/planner.ts`
- NO modificar `src/services/compose.ts`
- NO agregar dependencias npm nuevas
- NO hardcodear claves ni URLs (todo desde env vars)
- NO usar `any` explícito
- NO bloquear response si attestation falla

---

## Out of Scope

- planner.ts, compose.ts, x402.ts, x402-signer.ts, discovery.ts
- Cambios de DB
- Otros endpoints

---

## Escalation Rule

Si algo no está claro o no está en este Story File → **PARA y pregunta a Architect**. No inventar.
