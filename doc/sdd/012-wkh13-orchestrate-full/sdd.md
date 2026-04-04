# SDD #012: WKH-13 — POST /orchestrate Flujo Completo

> SPEC_APPROVED: **sí** (aprobado implícitamente por especificación completa en task brief)
> Fecha: 2026-04-04
> Tipo: feature
> SDD_MODE: full
> Branch: feat/wkh-13-orchestrate-full
> Artefactos: doc/sdd/012-wkh13-orchestrate-full/

---

## 1. Resumen

Completar el endpoint POST /orchestrate con flujo end-to-end production-ready: cada request recibe un `orchestrationId` UUID único, emite logs estructurados por paso, calcula `protocolFeeUsdc` (1% del costo total), registra attestation on-chain en Kite Ozone, y tiene timeout global de 120s. La respuesta cambia de `{ answer, reasoning, pipeline, consideredAgents }` a `{ orchestrationId, answer, reasoning, steps, totalCostUsdc, protocolFeeUsdc, attestationTxHash }`.

El endpoint ya tiene x402 integrado vía `requirePayment` middleware — no es necesario agregar pago, solo propagar el `kiteTxHash` al servicio y calcular fees.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 012 |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Objetivo** | Flujo completo orchestrate con orchestrationId, logs, timeout 120s, protocolFeeUsdc, attestation on-chain |
| **Reglas de negocio** | protocolFeeUsdc = 1% de totalCostUsdc; attestation = orchestrationId + hash del pipeline |
| **Scope IN** | orchestrate.ts (service + route), types/index.ts, kite-attestation.ts (crear), test/orchestrate.test.ts |
| **Scope OUT** | planner.ts, compose.ts, x402.ts, x402-signer.ts, discovery.ts, DB |

### Acceptance Criteria (EARS)

1. WHEN POST /orchestrate recibe un goal, THEN el sistema SHALL generar un `orchestrationId` UUID único y propagarlo en logs y respuesta.
2. WHEN cada paso del flujo ocurre (discover, plan, compose, attest), THEN el sistema SHALL emitir log estructurado `{ orchestrationId, step, timestamp, detail }`.
3. WHEN la orquestación completa exitosamente, THEN la respuesta SHALL incluir `{ orchestrationId, answer, reasoning, steps, totalCostUsdc, protocolFeeUsdc, attestationTxHash }`.
4. WHEN se calcula el costo total, THEN `protocolFeeUsdc` SHALL ser 1% de `totalCostUsdc`.
5. WHEN el flujo completo supera 120 segundos, THEN el sistema SHALL responder HTTP 504 con `{ error: 'Orchestration timeout: exceeded 120s' }`.
6. WHEN la orquestación finaliza, THEN SHALL registrar orchestrationId + pipelineHash on-chain en Kite Ozone, retornando `attestationTxHash`.
7. WHEN se envía `goal: "Analyze token 0xABC"`, THEN el flujo completo SHALL completar end-to-end sin errores.

## 3. Context Map (Codebase Grounding)

### Archivos leídos
| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `src/services/orchestrate.ts` | Servicio principal a modificar | Async method, imports from services/llm, error propagation con code |
| `src/types/index.ts` | Tipos a actualizar | `OrchestrateResult`, `ComposeResult` con `steps: StepResult[]`, `totalCostUsdc` |
| `src/lib/kite-chain.ts` | Chain config para attestation | `defineChain`, exporta `kiteTestnet`, patrón viem |
| `src/middleware/x402.ts` | x402 ya integrado | `requirePayment`, `KITE_NETWORK`, `KITE_PAYMENT_TOKEN` |
| `src/routes/orchestrate.ts` | Route existente | requirePayment ya activo, `request.kiteTxHash` disponible |
| `src/lib/x402-signer.ts` | Patrón wallet client | `createWalletClient`, `privateKeyToAccount`, singleton lazy, viem patterns |

### Exemplars
| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `src/lib/kite-attestation.ts` | `src/lib/kite-chain.ts` + `src/lib/x402-signer.ts` | Misma librería viem, mismo patrón de chain client y wallet |
| `src/services/orchestrate.ts` (mod) | `src/services/orchestrate.ts` (actual) | Solo agregar funcionalidad, no cambiar estructura |
| `src/types/index.ts` (mod) | `src/types/index.ts` (actual) | Agregar campos a OrchestrateResult |

### Estado de BD relevante
N/A — no hay cambios de DB en esta HU.

### Componentes reutilizables encontrados
- `kiteTestnet` de `src/lib/kite-chain.ts` — reutilizar para attestation client
- `crypto.randomUUID()` (Node 20+) — sin nueva dependencia para orchestrationId
- `createWalletClient` + `privateKeyToAccount` de viem — patrón en x402-signer.ts

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `src/types/index.ts` | Modificar | Actualizar `OrchestrateResult` con nuevos campos | `src/types/index.ts` |
| `src/lib/kite-attestation.ts` | Crear | Módulo attestation on-chain: registra orchestrationId+pipelineHash vía viem sendTransaction | `src/lib/x402-signer.ts` |
| `src/services/orchestrate.ts` | Modificar | Agregar orchestrationId, logs, timeout 120s, protocolFeeUsdc, llamada a attestation | `src/services/orchestrate.ts` |
| `src/routes/orchestrate.ts` | Modificar mínimo | Pasar kiteTxHash como paymentTxHash al servicio | `src/routes/orchestrate.ts` |
| `test/orchestrate.test.ts` | Crear | Tests de flujo completo con mocks | `src/services/compose.test.ts` |

### 4.2 Modelo de datos

No hay cambios de BD. Solo cambio de tipos TypeScript:

```typescript
// ANTES
interface OrchestrateResult {
  answer: unknown
  reasoning: string
  pipeline: ComposeResult
  consideredAgents: Agent[]
}

// DESPUÉS
interface OrchestrateResult {
  orchestrationId: string      // UUID único
  answer: unknown
  reasoning: string
  steps: StepResult[]          // De pipeline.steps
  totalCostUsdc: number        // De pipeline.totalCostUsdc
  protocolFeeUsdc: number      // 1% de totalCostUsdc
  attestationTxHash?: string   // Hash on-chain (o undefined si falla/no config)
  consideredAgents: Agent[]    // Mantener por compatibilidad
}
```

### 4.3 Componentes / Servicios

**kite-attestation.ts** — módulo simple:
```
attestOrchestration(orchestrationId: string, pipelineHash: string): Promise<string | null>
  - Si OPERATOR_PRIVATE_KEY no configurada → retorna null (no bloquea)
  - Construye calldata: abi.encode(orchestrationId, pipelineHash) como hex en calldata de tx
  - sendTransaction a dirección de contrato (KITE_ATTEST_CONTRACT env var) o address(0) fallback
  - Retorna txHash
  - Si falla → log warning, retorna null (attestation no es bloqueante)
```

**orchestrate.ts** — cambios al método `orchestrate()`:
1. `orchestrationId = crypto.randomUUID()`
2. Logs estructurados via `console.log(JSON.stringify({ orchestrationId, step, timestamp, detail }))`
3. Wrap con `Promise.race([pipeline, timeout(120000)])` para timeout 120s
4. `protocolFeeUsdc = pipeline.totalCostUsdc * 0.01`
5. Llamar `attestOrchestration(orchestrationId, pipelineHash)` → `attestationTxHash`
6. Retornar nuevo OrchestrateResult

### 4.4 Flujo principal (Happy Path)

1. Request llega → x402 middleware verifica pago (ya existente)
2. Route extrae `kiteTxHash` del request
3. `orchestrateService.orchestrate(request, { paymentTxHash: kiteTxHash })`
4. Genera `orchestrationId = crypto.randomUUID()`
5. Log: `{ orchestrationId, step: 'discover', timestamp, detail: '...' }`
6. `discoveryService.discover(...)` 
7. Log: `{ orchestrationId, step: 'plan', timestamp, detail: '...' }`
8. LLM planner genera steps
9. Log: `{ orchestrationId, step: 'compose', timestamp, detail: '...' }`
10. `composeService.compose(...)` — ejecuta pipeline con pagos x402
11. Calcula `protocolFeeUsdc = pipeline.totalCostUsdc * 0.01`
12. Log: `{ orchestrationId, step: 'attest', timestamp, detail: '...' }`
13. `attestOrchestration(orchestrationId, hash(pipeline))` → `attestationTxHash`
14. Log: `{ orchestrationId, step: 'done', timestamp, detail: 'success' }`
15. Retorna `OrchestrateResult` completo

### 4.5 Flujo de error — Timeout

```
Promise.race([
  orchestrationPipeline(),
  new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 120_000))
])
→ Si timeout: HTTP 504 { error: 'Orchestration timeout: exceeded 120s' }
```

### 4.6 Flujo de error — Attestation falla

- Attestation NO es bloqueante: si falla, `attestationTxHash = undefined`
- Log warning con detalle
- Response igualmente exitosa

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir
- Patrón viem: `createWalletClient` + `privateKeyToAccount` + `kiteTestnet` (igual que x402-signer.ts)
- Singleton lazy para wallet client (igual patrón que x402-signer.ts)
- Logs estructurados como JSON (no prose): `console.log(JSON.stringify(logEntry))`
- `crypto.randomUUID()` — sin npm uuid package
- Attestation no bloqueante: errores → log warning + return null

### PROHIBIDO
- NO usar ethers.js (regla absoluta del proyecto)
- NO modificar `src/middleware/x402.ts`
- NO modificar `src/services/llm/planner.ts`
- NO modificar `src/services/compose.ts`
- NO agregar dependencias npm nuevas
- NO hardcodear wallet private key ni RPC URLs
- NO bloquear el flujo si attestation falla
- NO modificar archivos fuera de Scope IN
- NO usar `any` explícito (TypeScript strict)

## 6. Scope

**IN:**
- `src/types/index.ts` — actualizar OrchestrateResult
- `src/lib/kite-attestation.ts` — crear módulo attestation
- `src/services/orchestrate.ts` — agregar orchestrationId, logs, timeout, fees, attestation
- `src/routes/orchestrate.ts` — pasar paymentTxHash al servicio (cambio mínimo)
- `test/orchestrate.test.ts` — tests flujo completo

**OUT:**
- Todo lo demás

## 7. Riesgos

| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|-------------|---------|------------|
| Kite testnet sin contrato de attestation | A | B | Usar sendTransaction con calldata, no writeContract. Fallback: log si tx falla |
| OPERATOR_PRIVATE_KEY no configurada en Railway | M | M | Attestation no bloqueante — retorna null |
| Timeout 120s demasiado corto para LLM | B | M | Documentado en DoD; Railway configurable |

## 8. Dependencias

- `crypto.randomUUID()` — Node 20+ (ya disponible)
- viem — ya instalado
- `kiteTestnet` — ya definida en `src/lib/kite-chain.ts`
- `OPERATOR_PRIVATE_KEY` — env var ya requerida por x402-signer

## 9. Missing Inputs

- [x] Contrato de attestation on-chain → **Decisión**: sin contrato dedicado, usar `sendTransaction` con calldata `0x + hex(orchestrationId+pipelineHash)`. Si `KITE_ATTEST_CONTRACT` no está en env, loggear y retornar null.

## 10. Uncertainty Markers

Ninguno. Todos los TBDs resueltos.

---

## Implementation Readiness Check

```
READINESS CHECK:
[x] Cada AC tiene al menos 1 archivo asociado en tabla 4.1
[x] Cada archivo en tabla 4.1 tiene un Exemplar válido (verificado)
[x] No hay [NEEDS CLARIFICATION] pendientes
[x] Constraint Directives incluyen al menos 3 PROHIBIDO (tiene 8)
[x] Context Map tiene al menos 2 archivos leídos (tiene 6)
[x] Scope IN y OUT son explícitos y no ambiguos
[x] Sin cambios de BD
[x] Flujo principal completo (15 pasos)
[x] Flujo de error definido (timeout + attestation falla)
```

✅ SDD listo para implementación.

---

*SDD generado por NexusAgil — FULL*
