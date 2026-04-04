# Work Item #012 — WKH-13: POST /orchestrate — Flujo completo

| Campo | Valor |
|-------|-------|
| **#** | 012 |
| **HU** | WKH-13 |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Branch** | feat/wkh-13-orchestrate-full |
| **Objetivo** | Completar el endpoint POST /orchestrate con flujo end-to-end: orchestrationId único, logs estructurados, pago x402 integrado, attestation on-chain en Kite Ozone, protocolFeeUsdc en la respuesta, y timeout 120s global. |

## Acceptance Criteria (EARS)

| # | AC | Formato |
|---|----|----|
| AC1 | WHEN POST /orchestrate recibe un goal, THEN el sistema SHALL generar un `orchestrationId` UUID único por request y propagarlo en logs y respuesta. | Event-Driven |
| AC2 | WHEN cada paso del flujo ocurre (discover, plan, compose, attest), THEN el sistema SHALL emitir un log estructurado `{ orchestrationId, step, timestamp, detail }`. | Event-Driven |
| AC3 | WHEN la orquestación completa exitosamente, THEN la respuesta SHALL incluir `{ answer, reasoning, steps, totalCostUsdc, protocolFeeUsdc, attestationTxHash }`. | Event-Driven |
| AC4 | WHEN se calcula el costo total, THEN `protocolFeeUsdc` SHALL ser 1% de `totalCostUsdc`. | Event-Driven |
| AC5 | WHEN el flujo completo supera 120 segundos, THEN el sistema SHALL lanzar un error de timeout con HTTP 504 y mensaje `Orchestration timeout: exceeded 120s`. | Unwanted |
| AC6 | WHEN la orquestación finaliza, THEN el sistema SHALL registrar on-chain en Kite Ozone el `orchestrationId` + pipeline hash, retornando `attestationTxHash`. | Event-Driven |
| AC7 | WHEN se envía `goal: "Analyze token 0xABC"` con budget > 0, THEN el flujo completo SHALL completar end-to-end en producción Railway sin errores. | Event-Driven |

## Scope IN
- `src/services/orchestrate.ts` — agregar orchestrationId, logs estructurados, protocolFeeUsdc, timeout 120s, attestation
- `src/types/index.ts` — actualizar OrchestrateResult con nuevos campos
- `src/lib/kite-attestation.ts` — CREAR: módulo de attestation on-chain vía viem
- `test/orchestrate.test.ts` — tests del flujo completo (o actualizar si existe)
- `doc/sdd/012-wkh13-orchestrate-full/` — artefactos del pipeline

## Scope OUT
- NO modificar `src/services/llm/planner.ts` (ya implementado)
- NO modificar `src/middleware/x402.ts` (ya implementado)
- NO modificar `src/lib/x402-signer.ts` (ya implementado)
- NO modificar `src/services/compose.ts` (ya implementado)
- NO modificar rutas existentes excepto respuesta de `src/routes/orchestrate.ts`
- NO cambiar estructura de DB
- NO modificar otros endpoints

## Codebase Grounding — Estado actual

### Archivos relevantes leídos
| Archivo | Estado | Relevancia |
|---------|--------|-----------|
| `src/services/orchestrate.ts` | Existe | Servicio principal — agregar orchestrationId, logs, timeout, fee, attestation |
| `src/types/index.ts` | Existe | OrchestrateResult necesita: steps, totalCostUsdc, protocolFeeUsdc, attestationTxHash |
| `src/lib/kite-chain.ts` | Existe | Kite chain config (ID 2368, RPC) — reutilizar para attestation |
| `src/middleware/x402.ts` | Existe | requirePayment ya integrado en /orchestrate route |
| `src/routes/orchestrate.ts` | Existe | Ya tiene requirePayment — agrega kiteTxHash en response |
| `src/lib/kite-attestation.ts` | NO EXISTE | Crear — attestation on-chain |

### Hallazgo crítico — x402 en /orchestrate
El endpoint POST /orchestrate YA tiene `requirePayment` middleware (confirmado en `src/routes/orchestrate.ts`).
El pago x402 YA se exige en el flujo. Lo que falta es:
1. Propagar `request.kiteTxHash` al orchestrateService como paymentTxHash
2. Calcular `totalCostUsdc` desde el pipeline result
3. Calcular `protocolFeeUsdc` = 1% de totalCostUsdc

### OrchestrateResult actual vs esperado
```
Actual:  { answer, reasoning, pipeline, consideredAgents }
Esperado: { answer, reasoning, steps, totalCostUsdc, protocolFeeUsdc, attestationTxHash, orchestrationId }
```

## Missing Inputs
- Contrato de attestation on-chain en Kite Ozone: ¿hay un contrato desplegado o usamos una tx simple? → **Decisión**: usar logging estructurado on-chain via `viem.writeContract` con ABI mínimo, o si no hay contrato → usar `sendTransaction` con calldata codificado del orchestrationId como fallback. Documentar en SDD.
- Forma de calcular `totalCostUsdc` desde pipeline: usar `pipeline.totalCostUsdc` si existe, o `pipeline.steps.reduce(sum, priceUsdc)`.

## Dependencias
- uuid (ya disponible en Node 20+ vía `crypto.randomUUID()`) — sin nueva dependencia
- viem (ya instalado) — para attestation
