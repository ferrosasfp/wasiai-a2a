# Story File — #016: Attestations — Contrato Ozone + Registro por Orchestration

> **Contrato autocontenido para Dev.** Este documento contiene TODO lo necesario para implementar el feature sin leer el SDD.
> **Branch:** `feat/016-attestations`
> **Tiempo estimado:** ~2 horas (3 waves)

---

## 0. Resumen Ejecutivo

**Que se construye:** Un servicio que, al completar una orchestration exitosa con al menos un agente invocado, escribe una attestation on-chain en Ozone (Kite Testnet) y retorna el tx hash en la response.

**Flujo completo:**
```
orchestrate() completa compose exitoso
  -> pipeline.success && pipeline.steps.length > 0
    -> attestationService.write({ orchestrationId, agents, totalCostUsdc, resultHash })
      -> getWalletClient() [reutiliza singleton de x402-signer]
        -> client.writeContract({ abi: ATTESTATION_ABI, functionName: 'attest', args: [...] })
          -> retorna txHash (submit, sin wait receipt)
    -> Promise.race([write, timeout(15s)])
  -> result.attestationTxHash = txHash || undefined
```

---

## 1. Archivos a Crear/Modificar

| # | Archivo | Accion | Wave |
|---|---------|--------|------|
| 1 | `src/lib/attestation-abi.ts` | **CREAR** | W0 |
| 2 | `.env.example` | **MODIFICAR** | W0 |
| 3 | `src/lib/x402-signer.ts` | **MODIFICAR** | W0 |
| 4 | `src/services/attestation.test.ts` | **CREAR** | W1 |
| 5 | `src/services/attestation.ts` | **CREAR** | W1 |
| 6 | `src/services/orchestrate.ts` | **MODIFICAR** | W2 |

**NO tocar ningun otro archivo.** Ver seccion 7 (Prohibiciones).

---

## 2. Wave 0 — Foundation (~30 min)

### W0.1: Crear `src/lib/attestation-abi.ts`

**Exemplar:** Ningun archivo similar existe; es un archivo nuevo autocontenido.

**Codigo completo:**

```typescript
/**
 * ABI minimo del contrato WasiAttestation (Ozone / Kite Testnet).
 * Hardcodeado como `as const` para inferencia de tipos en viem writeContract.
 *
 * Contrato deployado externamente. Este ABI es el contrato de integracion.
 */
export const ATTESTATION_ABI = [
  {
    name: 'attest',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'orchestrationId', type: 'string' },
      { name: 'agents', type: 'string[]' },
      { name: 'totalCostUsdc', type: 'uint256' },
      { name: 'timestamp', type: 'uint256' },
      { name: 'resultHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'getAttestation',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'orchestrationId', type: 'string' },
    ],
    outputs: [
      { name: 'agents', type: 'string[]' },
      { name: 'totalCostUsdc', type: 'uint256' },
      { name: 'timestamp', type: 'uint256' },
      { name: 'resultHash', type: 'bytes32' },
      { name: 'exists', type: 'bool' },
    ],
  },
  {
    name: 'AttestationCreated',
    type: 'event',
    inputs: [
      { name: 'orchestrationId', type: 'string', indexed: true },
      { name: 'resultHash', type: 'bytes32', indexed: false },
    ],
  },
] as const
```

### W0.2: Modificar `.env.example`

**Exemplar:** Ver la seccion `# --- Kite Service Provider (x402)` ya existente en `.env.example`.

**Agregar al final del archivo:**

```env
# ─── Attestation (Ozone) ────────────────────────────────────────────────────
# Direccion del contrato WasiAttestation deployado en Kite Testnet (Ozone).
# Si no esta configurado, las attestations se desactivan silenciosamente.
# Deploy externo: no hay tooling Solidity en este repo.
ATTESTATION_CONTRACT_ADDRESS=0xYourDeployedContractAddress

# Private key del operador para firmar transacciones (x402 + attestations).
# MISMA key que x402 (reutiliza el WalletClient singleton).
# NUNCA commitear el valor real. Solo en .env (que esta en .gitignore).
OPERATOR_PRIVATE_KEY=0xYourOperatorPrivateKey
```

### W0.3: Modificar `src/lib/x402-signer.ts`

**Exemplar:** El propio archivo `x402-signer.ts`. La funcion `getWalletClient()` esta en la linea que dice `function getWalletClient() {`.

**Cambio exacto (una sola linea):**

```diff
- function getWalletClient() {
+ export function getWalletClient() {
```

**Nada mas.** No cambiar la logica interna, no mover la funcion, no agregar parametros.

### Verificacion W0

```bash
npx tsc --noEmit
```

Debe pasar sin errores. Si `tsc` falla, revisar que el `as const` del ABI tenga la estructura correcta.

---

## 3. Wave 1 — Attestation Service + Tests (~45 min, test-first)

### W1.1: Crear `src/services/attestation.test.ts`

**Exemplar:** `src/services/kite-client.test.ts` — patron de mock de viem, `vi.mock`, `beforeEach`/`afterEach` para env vars.

**Codigo completo de referencia:**

```typescript
/**
 * Tests para attestation service — WKH-8
 * Patron: vi.mock para interceptar x402-signer + attestation-abi
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ──────────────────────────────────────────────────────────────
// Mocks — ANTES del import del modulo bajo test
// ──────────────────────────────────────────────────────────────
const mockWriteContract = vi.fn()

vi.mock('../lib/x402-signer.js', () => ({
  getWalletClient: vi.fn(() => ({
    writeContract: mockWriteContract,
  })),
}))

vi.mock('../lib/attestation-abi.js', () => ({
  ATTESTATION_ABI: [],
}))

// ──────────────────────────────────────────────────────────────
// Import del modulo bajo test (DESPUES de los mocks)
// ──────────────────────────────────────────────────────────────
import { attestationService } from './attestation.js'
import { getWalletClient } from '../lib/x402-signer.js'

// ──────────────────────────────────────────────────────────────
// Test data helper
// ──────────────────────────────────────────────────────────────
function makeWriteData() {
  return {
    orchestrationId: 'test-orch-uuid-1234',
    agents: ['agent-alpha', 'agent-beta'],
    totalCostUsdc: BigInt(1_500_000), // 1.5 USDC
    resultHash: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as `0x${string}`,
  }
}

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────
describe('attestation service', () => {
  const ORIGINAL_CONTRACT = process.env.ATTESTATION_CONTRACT_ADDRESS

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.ATTESTATION_CONTRACT_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678'
  })

  afterEach(() => {
    if (ORIGINAL_CONTRACT !== undefined) {
      process.env.ATTESTATION_CONTRACT_ADDRESS = ORIGINAL_CONTRACT
    } else {
      delete process.env.ATTESTATION_CONTRACT_ADDRESS
    }
    vi.restoreAllMocks()
  })

  // ─── T1: Happy path ─────────────────────────────────────
  it('write() retorna txHash cuando writeContract resuelve exitosamente', async () => {
    const expectedHash = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'
    mockWriteContract.mockResolvedValue(expectedHash)

    const result = await attestationService.write(makeWriteData())

    expect(result).toBe(expectedHash)
    expect(mockWriteContract).toHaveBeenCalledOnce()
    expect(mockWriteContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: '0x1234567890abcdef1234567890abcdef12345678',
        functionName: 'attest',
        args: expect.arrayContaining([
          'test-orch-uuid-1234',
          ['agent-alpha', 'agent-beta'],
          BigInt(1_500_000),
        ]),
      }),
    )
  })

  // ─── T2: Feature flag OFF ────────────────────────────────
  it('write() retorna null cuando ATTESTATION_CONTRACT_ADDRESS no esta configurado', async () => {
    delete process.env.ATTESTATION_CONTRACT_ADDRESS

    const result = await attestationService.write(makeWriteData())

    expect(result).toBeNull()
    expect(mockWriteContract).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('ATTESTATION_CONTRACT_ADDRESS'),
    )
  })

  // ─── T3: writeContract failure ───────────────────────────
  it('write() retorna null y loguea warning cuando writeContract falla', async () => {
    mockWriteContract.mockRejectedValue(new Error('execution reverted'))

    const result = await attestationService.write(makeWriteData())

    expect(result).toBeNull()
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('write failed'),
      expect.stringContaining('execution reverted'),
    )
  })

  // ─── T4: getWalletClient throws ─────────────────────────
  it('write() retorna null cuando getWalletClient lanza error', async () => {
    vi.mocked(getWalletClient).mockImplementationOnce(() => {
      throw new Error('OPERATOR_PRIVATE_KEY not set')
    })

    const result = await attestationService.write(makeWriteData())

    expect(result).toBeNull()
    expect(console.warn).toHaveBeenCalled()
  })
})
```

### W1.2: Crear `src/services/attestation.ts`

**Exemplar:** `src/services/event.ts` — patron de named export `export const xService = { ... }`.

**Codigo completo de referencia:**

```typescript
/**
 * Attestation Service — Write attestations on-chain (Ozone / Kite Testnet)
 *
 * WKH-8: Attestations
 *
 * Feature flag: si ATTESTATION_CONTRACT_ADDRESS no esta configurado,
 * el servicio retorna null silenciosamente (no throw).
 *
 * Reutiliza getWalletClient() de x402-signer.ts (mismo OPERATOR_PRIVATE_KEY).
 * Solo submit (writeContract). NO llama waitForTransactionReceipt.
 */

import { getWalletClient } from '../lib/x402-signer.js'
import { ATTESTATION_ABI } from '../lib/attestation-abi.js'

// ── Tipos internos ──────────────────────────────────────────

interface AttestationWriteData {
  orchestrationId: string
  agents: string[]
  totalCostUsdc: bigint
  resultHash: `0x${string}`
}

// ── Service ─────────────────────────────────────────────────

export const attestationService = {
  /**
   * Write an attestation on-chain.
   *
   * @returns tx hash if successful, null if skipped or failed
   */
  async write(data: AttestationWriteData): Promise<string | null> {
    const contractAddress = process.env.ATTESTATION_CONTRACT_ADDRESS
    if (!contractAddress) {
      console.warn('[Attestation] ATTESTATION_CONTRACT_ADDRESS not set — skipping')
      return null
    }

    try {
      const client = getWalletClient()

      const txHash = await client.writeContract({
        address: contractAddress as `0x${string}`,
        abi: ATTESTATION_ABI,
        functionName: 'attest',
        args: [
          data.orchestrationId,
          data.agents,
          data.totalCostUsdc,
          BigInt(Math.floor(Date.now() / 1000)),
          data.resultHash,
        ],
      })

      console.log(`[Attestation] tx submitted: ${txHash}`)
      return txHash
    } catch (err) {
      console.warn(
        '[Attestation] write failed:',
        err instanceof Error ? err.message : err,
      )
      return null
    }
  },
}
```

### Verificacion W1

```bash
npx tsc --noEmit && npx vitest run src/services/attestation.test.ts
```

Deben pasar los 4 tests (T1-T4). Si `tsc` falla, revisar los imports y las extensiones `.js`.

---

## 4. Wave 2 — Orchestrate Hook + QA (~45 min)

### W2.1: Modificar `src/services/orchestrate.ts`

**Exemplar:** El propio archivo `orchestrate.ts`, patron de `eventService.track({...}).catch(...)`.

#### Cambio 1: Agregar imports

**Donde:** Despues de la linea `import { eventService } from './event.js'` (ultima linea de imports actual).

**Agregar:**

```typescript
import { keccak256, toHex } from 'viem'
import { attestationService } from './attestation.js'
```

#### Cambio 2: Hook post-compose

**Donde:** Dentro de la funcion `orchestrate()`, DESPUES de:

```typescript
    const protocolFeeUsdc = Number((pipeline.totalCostUsdc * PROTOCOL_FEE_RATE).toFixed(6))
```

Y ANTES de:

```typescript
    const totalLatencyMs = Date.now() - startTime
```

**Insertar este bloque exacto:**

```typescript
    // Step 4.5: Attestation (best-effort, non-blocking)
    let attestationTxHash: string | undefined

    if (pipeline.success && pipeline.steps.length > 0) {
      try {
        const attestationData = {
          orchestrationId,
          agents: pipeline.steps.map(s => s.agent.slug),
          totalCostUsdc: BigInt(Math.round(pipeline.totalCostUsdc * 1e6)),
          resultHash: keccak256(toHex(JSON.stringify(pipeline.output ?? null))),
        }

        let attestationTimeoutId: ReturnType<typeof setTimeout>
        const timeoutPromise = new Promise<null>((resolve) => {
          attestationTimeoutId = setTimeout(() => resolve(null), 15_000)
        })

        const txHash = await Promise.race([
          attestationService.write(attestationData),
          timeoutPromise,
        ])
        clearTimeout(attestationTimeoutId!)

        if (txHash) {
          attestationTxHash = txHash
        }
      } catch (err) {
        console.warn(
          '[Orchestrate] attestation failed:',
          err instanceof Error ? err.message : err,
        )
      }
    }
```

#### Cambio 3: Agregar `attestationTxHash` al return

**Donde:** En el objeto `return` final de la funcion `orchestrate()`, agregar el campo `attestationTxHash`.

**Antes:**

```typescript
    return {
      orchestrationId,
      answer: pipeline.output,
      reasoning,
      pipeline,
      consideredAgents: discovered.agents,
      protocolFeeUsdc,
    }
```

**Despues:**

```typescript
    return {
      orchestrationId,
      answer: pipeline.output,
      reasoning,
      pipeline,
      consideredAgents: discovered.agents,
      protocolFeeUsdc,
      attestationTxHash,
    }
```

### Verificacion W2

```bash
# Full QA
npm run lint && npm run test && npm run build
```

**Verificacion manual adicional:**

1. **Sin `ATTESTATION_CONTRACT_ADDRESS`:** Iniciar el server sin la env var. Ejecutar una orchestration. Debe funcionar identicamente a antes (sin errores, sin warnings de attestation excepto el skip).
2. **Con `ATTESTATION_CONTRACT_ADDRESS` invalido:** Poner una address aleatoria. Ejecutar orchestration. Debe completar normalmente, `attestationTxHash` queda `undefined`, se loguea warning de write failed.
3. **Verificar type checking:** `attestationTxHash` debe aparecer en la response JSON cuando existe.

---

## 5. Tests Esperados

### 5.1 Archivo: `src/services/attestation.test.ts`

| Test | Nombre exacto | Que verifica | Patron |
|------|---------------|-------------|--------|
| T1 | `write() retorna txHash cuando writeContract resuelve exitosamente` | Happy path: env var presente, mock writeContract retorna hash, servicio retorna el mismo hash | Mock `getWalletClient` retorna `{ writeContract: mockFn }` |
| T2 | `write() retorna null cuando ATTESTATION_CONTRACT_ADDRESS no esta configurado` | Feature flag: delete env var, llamar write, verificar retorna null y NO llama writeContract | `delete process.env.ATTESTATION_CONTRACT_ADDRESS` |
| T3 | `write() retorna null y loguea warning cuando writeContract falla` | Error handling: mock writeContract que lanza error, verificar retorna null y loguea | `mockWriteContract.mockRejectedValue(...)` |
| T4 | `write() retorna null cuando getWalletClient lanza error` | Guard de WalletClient: mock `getWalletClient` que lanza, verificar retorna null | `vi.mocked(getWalletClient).mockImplementationOnce(() => { throw ... })` |

### 5.2 Tests existentes que NO deben romperse

- `src/services/kite-client.test.ts` — NO se modifica kite-client
- Todos los tests en `src/services/` y `src/lib/` — la modificacion a `x402-signer.ts` es solo agregar `export` (no cambia comportamiento)
- Tests de `orchestrate.ts` (si existen) — el nuevo hook solo se activa post-compose exitoso con steps

---

## 6. Datos de Referencia Rapida

### Imports necesarios por archivo

| Archivo | Importa de | Que importa |
|---------|------------|-------------|
| `attestation.ts` | `../lib/x402-signer.js` | `getWalletClient` |
| `attestation.ts` | `../lib/attestation-abi.js` | `ATTESTATION_ABI` |
| `orchestrate.ts` | `viem` | `keccak256`, `toHex` |
| `orchestrate.ts` | `./attestation.js` | `attestationService` |

### Conversion de datos clave

| Dato | Origen | Conversion | Tipo final |
|------|--------|-----------|------------|
| `agents` | `pipeline.steps` | `.map(s => s.agent.slug)` | `string[]` |
| `totalCostUsdc` | `pipeline.totalCostUsdc` (float) | `BigInt(Math.round(value * 1e6))` | `bigint` |
| `resultHash` | `pipeline.output` (any) | `keccak256(toHex(JSON.stringify(output ?? null)))` | `` `0x${string}` `` |
| `timestamp` | `Date.now()` | `BigInt(Math.floor(Date.now() / 1000))` | `bigint` |

### Variables de entorno

| Variable | Requerida | Default | Comportamiento si falta |
|----------|-----------|---------|------------------------|
| `ATTESTATION_CONTRACT_ADDRESS` | No | (ninguno) | Attestation se desactiva silenciosamente, retorna null |
| `OPERATOR_PRIVATE_KEY` | Si (para x402 tambien) | (ninguno) | `getWalletClient()` lanza error, catch en attestation retorna null |
| `KITE_RPC_URL` | Si (ya existe) | (ninguno) | WalletClient usa esta URL para el transport |

---

## 7. Prohibiciones Explicitas

**LEE ESTA SECCION COMPLETA ANTES DE EMPEZAR.**

| # | PROHIBIDO | Por que |
|---|-----------|---------|
| 1 | Modificar `src/services/compose.ts` | Fuera de scope. Compose no sabe de attestations. |
| 2 | Modificar `src/services/discovery.ts` | Fuera de scope. |
| 3 | Modificar `src/services/event.ts` | Fuera de scope. Event tracking es independiente. |
| 4 | Crear tabla Supabase / migracion SQL | Diferido post-hackathon. |
| 5 | Crear `src/routes/attestations.ts` | Diferido post-hackathon. No hay endpoint GET. |
| 6 | Modificar `src/index.ts` | No hay ruta nueva. |
| 7 | Llamar `waitForTransactionReceipt` | Solo submit. Performance. |
| 8 | Crear un nuevo `WalletClient` | Reutilizar `getWalletClient()` de x402-signer. |
| 9 | Importar `supabase` en attestation service | Sin persistencia off-chain. |
| 10 | Modificar `src/types/index.ts` | `attestationTxHash` ya existe en `OrchestrateResult`. |
| 11 | Hacer `throw` cuando falta `ATTESTATION_CONTRACT_ADDRESS` | Retornar `null` silenciosamente. Feature flag. |
| 12 | Bloquear la response de orchestrate por attestation | `Promise.race` + timeout 15s. |
| 13 | Agregar dependencias npm nuevas | `viem` ya esta. Todo lo necesario existe. |
| 14 | Logear `OPERATOR_PRIVATE_KEY` | Seguridad. |
| 15 | Crear subdirectorio `src/services/kite/` | Patron flat (`event.ts`, `compose.ts`). Usar `src/services/attestation.ts`. |
| 16 | Exportar `AttestationWriteData` a `types/index.ts` | Es interface interna del servicio. |
| 17 | Agregar retry logic | Fuera de scope. Si falla, falla silenciosamente. |

---

## 8. Escalation Rule

> **Si algo no esta en este Story File, Dev PARA y pregunta a Architect.**
> No inventar. No asumir. No improvisar.
> Si encuentras un problema no documentado aqui, escala antes de resolverlo por tu cuenta.

---

## 9. Checklist Final Pre-PR

- [ ] `npx tsc --noEmit` pasa sin errores
- [ ] `npx vitest run src/services/attestation.test.ts` — 4 tests pasan
- [ ] `npm run test` — todos los tests pasan (incluyendo los existentes)
- [ ] `npm run lint` — sin errores de lint
- [ ] `npm run build` — build exitoso
- [ ] Sin `ATTESTATION_CONTRACT_ADDRESS` en env: server arranca, orchestrate funciona, sin crash
- [ ] Con `ATTESTATION_CONTRACT_ADDRESS` invalido: orchestrate completa, `attestationTxHash` es `undefined`, warning en logs
- [ ] No se modificaron archivos fuera del scope (verificar con `git diff --name-only`)
- [ ] `attestationTxHash` aparece en la response JSON de orchestrate (cuando hay tx)
- [ ] No se commiteo `.env` con valores reales

---

*Story File generado por NexusAgil — F2.5 (Architect)*
*Fecha: 2026-04-05*
