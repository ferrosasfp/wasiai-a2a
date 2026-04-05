# SDD-016: Attestations — Contrato Ozone + Registro por Orchestration

> **Work Item:** #016
> **HU:** WKH-8 — [S4-P3] Attestations
> **Branch:** `feat/016-attestations`
> **Fecha:** 2026-04-05
> **Objetivo:** Al completar una orchestration exitosa con al menos un agente invocado, escribir una attestation on-chain en Ozone (Kite Testnet) y retornar el tx hash en la response.

---

## 1. Context Map

Referencia completa en [work-item.md](./work-item.md) secciones 1.1-1.4.

### Resumen de integracion

```
orchestrate.ts ──(post-compose exitoso)──> attestation.ts ──> writeContract() ──> Ozone (Kite Testnet)
                                                │                    │
                                                │                    └── attestation-abi.ts (ABI as const)
                                                │
                                                └── getWalletClient() <── x402-signer.ts (lazy singleton)
```

**Flujo:**
1. `orchestrate.ts` ejecuta compose pipeline normalmente
2. Si `pipeline.success === true` AND `pipeline.steps.length > 0`, invoca `attestationService.write()`
3. `attestationService.write()` verifica feature flag (`ATTESTATION_CONTRACT_ADDRESS`), importa `getWalletClient()` de `x402-signer.ts`, y llama `writeContract` con el ABI de `attestation-abi.ts`
4. `orchestrate.ts` ejecuta `Promise.race([attestationService.write(...), timeout(15_000)])` para no bloquear la response
5. Si el write completa dentro del timeout, `attestationTxHash` se incluye en `OrchestrateResult`; si no, queda `undefined`

**Singleton reutilizado:** La misma instancia `WalletClient` de x402-signer (misma `OPERATOR_PRIVATE_KEY`, misma wallet) se usa para firmar attestations. NO se crea un segundo WalletClient.

---

## 2. Technical Design

### 2.1 `src/lib/attestation-abi.ts` — CREAR

**Proposito:** ABI minimo del contrato `WasiAttestation.sol`, hardcodeado como `as const` para que viem infiera tipos en `writeContract`.

**Exports:**

```typescript
export const ATTESTATION_ABI = [...] as const
```

**Contenido exacto del ABI:**

```typescript
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

**Notas de diseno:**
- Sin imports externos. Archivo autocontenido.
- `as const` es obligatorio para que viem infiera los tipos de `functionName` y `args` en `writeContract`.
- El ABI solo incluye las funciones/eventos que el servicio consume: `attest()` para write y `getAttestation()` para referencia futura.
- El event `AttestationCreated` se incluye para completitud del ABI, aunque el servicio no lo consume directamente.

---

### 2.2 `src/services/attestation.ts` — CREAR

**Proposito:** Servicio que escribe attestations on-chain. Patron: named export como `eventService` en `event.ts`.

**Imports:**

```typescript
import { getWalletClient } from '../lib/x402-signer.js'
import { ATTESTATION_ABI } from '../lib/attestation-abi.js'
```

**Exports:**

```typescript
export const attestationService = {
  write(data: AttestationWriteData): Promise<string | null>
}
```

**Interface interna (NO exportada a types/index.ts):**

```typescript
interface AttestationWriteData {
  orchestrationId: string
  agents: string[]              // pipeline.steps.map(s => s.agent.slug)
  totalCostUsdc: bigint          // BigInt(Math.round(pipeline.totalCostUsdc * 1e6))
  resultHash: `0x${string}`     // keccak256(toHex(JSON.stringify(pipeline.output ?? null)))
}
```

**Logica de `attestationService.write()`:**

```
1. GUARD: const contractAddress = process.env.ATTESTATION_CONTRACT_ADDRESS
   - Si no esta definido -> console.warn('[Attestation] ATTESTATION_CONTRACT_ADDRESS not set - skipping')
   - Retornar null (NO throw)

2. TRY:
   a. const client = getWalletClient()
   b. const txHash = await client.writeContract({
        address: contractAddress as `0x${string}`,
        abi: ATTESTATION_ABI,
        functionName: 'attest',
        args: [
          data.orchestrationId,
          data.agents,
          data.totalCostUsdc,
          BigInt(Math.floor(Date.now() / 1000)),  // timestamp en segundos
          data.resultHash,
        ],
      })
   c. console.log(`[Attestation] tx submitted: ${txHash}`)
   d. return txHash

3. CATCH (err):
   a. console.warn('[Attestation] write failed:', err instanceof Error ? err.message : err)
   b. return null (NO throw, NO re-throw)
```

**Decisiones de diseno:**
- **NO `waitForTransactionReceipt`**: `writeContract` retorna el tx hash inmediatamente tras el submit. El receipt no es necesario.
- **NO supabase**: Sin persistencia off-chain. Diferido post-hackathon.
- **NO retry**: Si falla, falla silenciosamente. Sin retry logic.
- **Guard por env var**: Feature flag natural. Si `ATTESTATION_CONTRACT_ADDRESS` no esta, el servicio es no-op.
- **`timestamp`**: Se genera dentro del servicio (`Math.floor(Date.now() / 1000)`) para que refleje el momento del submit, no el del inicio de la orchestration.
- La interface `AttestationWriteData` es interna al archivo (NO se exporta a `types/index.ts`). Si en el futuro se necesita reutilizar, se movera.

---

### 2.3 `src/services/orchestrate.ts` — MODIFICAR

**Proposito:** Agregar hook post-compose exitoso que invoca `attestationService.write()` con `Promise.race` y timeout de 15s.

#### Cambio 1: Imports nuevos (al inicio del archivo)

Agregar despues de los imports existentes:

```typescript
import { keccak256, toHex } from 'viem'
import { attestationService } from './attestation.js'
```

#### Cambio 2: Hook post-compose

**Ubicacion exacta:** Despues de la linea `const protocolFeeUsdc = Number((pipeline.totalCostUsdc * PROTOCOL_FEE_RATE).toFixed(6))` y ANTES de `const totalLatencyMs = Date.now() - startTime`.

Insertar:

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

#### Cambio 3: Incluir `attestationTxHash` en el return

En el objeto `return` al final de la funcion `orchestrate()`, agregar el campo:

```typescript
    return {
      orchestrationId,
      answer: pipeline.output,
      reasoning,
      pipeline,
      consideredAgents: discovered.agents,
      protocolFeeUsdc,
      attestationTxHash,   // <-- NUEVO: undefined si timeout/fallo/skip
    }
```

**Notas de diseno:**
- **`Promise.race` con timeout**: El timeout retorna `null`, no un error. Esto permite que si `attestationService.write()` tarda mas de 15s, el resultado sea `null` (y `attestationTxHash` quede `undefined`).
- **Guard `pipeline.steps.length > 0`**: Solo se atestigua si al menos un agente fue invocado. Orchestrations vacias (sin steps) no generan attestation.
- **`keccak256(toHex(JSON.stringify(pipeline.output ?? null)))`**: Se computa en orchestrate porque el output esta disponible como `pipeline.output`. El servicio de attestation recibe el hash ya computado.
- **`BigInt(Math.round(pipeline.totalCostUsdc * 1e6))`**: Conversion de float USDC a BigInt con 6 decimales. `Math.round` para evitar problemas de precision de punto flotante.
- **El try/catch externo** captura cualquier error no anticipado (incluyendo si `getWalletClient` lanza por falta de `OPERATOR_PRIVATE_KEY`). Esto garantiza que la response de orchestrate NUNCA se bloquea por un error de attestation.
- **NO modifica los early returns** (no agents found, no budget): Esos paths ya retornan `OrchestrateResult` sin `attestationTxHash` (queda `undefined` por el tipo optional).

---

### 2.4 `src/lib/x402-signer.ts` — MODIFICAR

**Proposito:** Exportar `getWalletClient()` que actualmente es funcion privada (module-scoped).

**Cambio unico:**

```diff
- function getWalletClient() {
+ export function getWalletClient() {
```

**Impacto:**
- Cero cambios de logica. Solo se agrega `export` a la firma de la funcion.
- `_resetWalletClient()` ya es `export` (para tests).
- La funcion `signX402Authorization()` sigue funcionando identicamente (ya la invoca internamente).
- El servicio de attestation la importara como: `import { getWalletClient } from '../lib/x402-signer.js'`

---

### 2.5 `.env.example` — MODIFICAR

**Proposito:** Documentar las variables de entorno necesarias para attestations.

**Agregar al final del archivo**, despues de la seccion `Kite Service Provider (x402)`:

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

**Nota:** `OPERATOR_PRIVATE_KEY` ya existe en `.env` real (usada por x402-signer) pero NO esta documentada en `.env.example`. Se agrega para completitud.

---

### 2.6 `src/services/attestation.test.ts` — CREAR

**Proposito:** Tests unitarios del servicio de attestation. Patron seguido: `kite-client.test.ts` con `vi.mock('viem')`.

**Estrategia de mocking:**
- `vi.mock('../lib/x402-signer.js')` para interceptar `getWalletClient` y retornar un mock de WalletClient con `writeContract` mockeado
- `vi.mock('../lib/attestation-abi.js')` para proveer un ABI mock (el ABI real no afecta tests unitarios)
- Manipulacion de `process.env.ATTESTATION_CONTRACT_ADDRESS` por test

**Tests esperados:**

| Test ID | Nombre | Que verifica |
|---------|--------|-------------|
| T1 | `write() retorna txHash cuando writeContract resuelve` | Happy path: env var presente, writeContract retorna hash, servicio retorna el mismo hash |
| T2 | `write() retorna null cuando ATTESTATION_CONTRACT_ADDRESS no esta` | Feature flag: sin env var, writeContract nunca se llama, retorna null, loguea warning |
| T3 | `write() retorna null y loguea warning cuando writeContract falla` | Error handling: writeContract lanza, servicio retorna null, no re-throw |
| T4 | `write() retorna null cuando getWalletClient lanza` | Error en WalletClient (ej: OPERATOR_PRIVATE_KEY falta): servicio retorna null, no re-throw |

**Patron de cada test (exemplar basado en kite-client.test.ts):**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock de x402-signer ANTES del import del modulo bajo test
const mockWriteContract = vi.fn()
vi.mock('../lib/x402-signer.js', () => ({
  getWalletClient: vi.fn(() => ({
    writeContract: mockWriteContract,
  })),
}))

vi.mock('../lib/attestation-abi.js', () => ({
  ATTESTATION_ABI: [],
}))

import { attestationService } from './attestation.js'
import { getWalletClient } from '../lib/x402-signer.js'

describe('attestation service', () => {
  const ORIGINAL_ENV = process.env.ATTESTATION_CONTRACT_ADDRESS

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.ATTESTATION_CONTRACT_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678'
  })

  afterEach(() => {
    if (ORIGINAL_ENV !== undefined) {
      process.env.ATTESTATION_CONTRACT_ADDRESS = ORIGINAL_ENV
    } else {
      delete process.env.ATTESTATION_CONTRACT_ADDRESS
    }
    vi.restoreAllMocks()
  })

  // T1: Happy path
  it('write() retorna txHash cuando writeContract resuelve', async () => {
    const expectedHash = '0xabc123...'
    mockWriteContract.mockResolvedValue(expectedHash)

    const result = await attestationService.write({
      orchestrationId: 'test-uuid',
      agents: ['agent-1', 'agent-2'],
      totalCostUsdc: BigInt(1500000),
      resultHash: '0xdeadbeef...' as `0x${string}`,
    })

    expect(result).toBe(expectedHash)
    expect(mockWriteContract).toHaveBeenCalledOnce()
    expect(mockWriteContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'attest',
        args: expect.arrayContaining(['test-uuid']),
      }),
    )
  })

  // T2: Feature flag off
  it('write() retorna null cuando ATTESTATION_CONTRACT_ADDRESS no esta', async () => {
    delete process.env.ATTESTATION_CONTRACT_ADDRESS

    const result = await attestationService.write({
      orchestrationId: 'test-uuid',
      agents: ['agent-1'],
      totalCostUsdc: BigInt(1000000),
      resultHash: '0xabc...' as `0x${string}`,
    })

    expect(result).toBeNull()
    expect(mockWriteContract).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('ATTESTATION_CONTRACT_ADDRESS'),
    )
  })

  // T3: writeContract failure
  it('write() retorna null y loguea warning cuando writeContract falla', async () => {
    mockWriteContract.mockRejectedValue(new Error('revert'))

    const result = await attestationService.write({
      orchestrationId: 'test-uuid',
      agents: ['agent-1'],
      totalCostUsdc: BigInt(1000000),
      resultHash: '0xabc...' as `0x${string}`,
    })

    expect(result).toBeNull()
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('write failed'),
      expect.any(String),
    )
  })

  // T4: getWalletClient throws
  it('write() retorna null cuando getWalletClient lanza', async () => {
    vi.mocked(getWalletClient).mockImplementationOnce(() => {
      throw new Error('OPERATOR_PRIVATE_KEY not set')
    })

    const result = await attestationService.write({
      orchestrationId: 'test-uuid',
      agents: ['agent-1'],
      totalCostUsdc: BigInt(1000000),
      resultHash: '0xabc...' as `0x${string}`,
    })

    expect(result).toBeNull()
    expect(console.warn).toHaveBeenCalled()
  })
})
```

---

## 3. Constraint Directives

### Prohibiciones absolutas

| # | Prohibicion | Razon |
|---|------------|-------|
| CD-1 | NO modificar `compose.ts` | Fuera de scope. Compose no sabe de attestations. |
| CD-2 | NO modificar `discovery.ts` | Fuera de scope. Discovery no sabe de attestations. |
| CD-3 | NO modificar `event.ts` | Fuera de scope. Event tracking es independiente. |
| CD-4 | NO crear tabla Supabase ni migracion SQL | Diferido post-hackathon. Sin consumidor. |
| CD-5 | NO crear endpoint GET /attestations | Diferido post-hackathon. |
| CD-6 | NO crear `src/routes/attestations.ts` | Diferido post-hackathon. Sin ruta que registrar. |
| CD-7 | NO modificar `src/index.ts` | No hay ruta nueva que registrar. |
| CD-8 | NO llamar `waitForTransactionReceipt` | Solo submit. El receipt no es necesario. Performance. |
| CD-9 | NO crear WalletClient nuevo | Reutilizar `getWalletClient()` de `x402-signer.ts`. |
| CD-10 | NO importar `supabase` en attestation service | Sin persistencia off-chain en esta version. |
| CD-11 | NO modificar `src/types/index.ts` | `attestationTxHash` ya existe en `OrchestrateResult`. |
| CD-12 | SI `ATTESTATION_CONTRACT_ADDRESS` no esta en env, retornar `null` silenciosamente, NO throw | Feature flag natural. El servicio es opt-in. |
| CD-13 | La attestation NO debe bloquear la response de orchestrate | `Promise.race` + timeout 15s + try/catch externo. |
| CD-14 | NO logear `OPERATOR_PRIVATE_KEY` ni datos sensibles | Seguridad basica. |
| CD-15 | NO agregar dependencias npm nuevas | `viem` ya esta en `package.json`. Todo lo necesario ya existe. |

---

## 4. Readiness Check

### Pre-condiciones verificadas

| # | Condicion | Estado | Evidencia |
|---|-----------|--------|-----------|
| 1 | `viem ^2.47.6` soporta `writeContract` | OK | `package.json` verificado |
| 2 | `OrchestrateResult.attestationTxHash?: string` existe | OK | `src/types/index.ts` — campo ya presente |
| 3 | `getWalletClient()` existe en `x402-signer.ts` | OK | Verificado. Solo falta agregar `export`. |
| 4 | `_resetWalletClient()` ya es export | OK | Verificado. Para tests. |
| 5 | `kiteTestnet` chain definido con RPC | OK | `src/lib/kite-chain.ts` |
| 6 | Patron fire-and-forget existe en orchestrate | OK | `eventService.track({...}).catch(...)` |
| 7 | Patron de test con `vi.mock('viem')` existe | OK | `kite-client.test.ts` |
| 8 | `.env.example` es modificable | OK | Sin conflictos esperados |

### Bloqueantes

| # | Bloqueante | Estado | Impacto en desarrollo |
|---|-----------|--------|----------------------|
| 1 | Contrato `WasiAttestation.sol` deployado | PENDIENTE | NO bloquea desarrollo. Feature flag via env var. Tests con mocks. |
| 2 | OPERATOR wallet con KITE balance | PROBABLE OK | Ya se usa para x402. Verificar balance pre-demo. |

### Veredicto

**LISTO PARA IMPLEMENTAR.** Todas las pre-condiciones de codigo estan satisfechas. La dependencia del contrato deployado no bloquea el desarrollo gracias al feature flag. Los tests se escriben con mocks de viem.

---

*SDD generado por NexusAgil — F2 (Architect)*
*Fecha: 2026-04-05*
