# SDD #115: [WKH-118] FEE-COMPOSE — Cobro del 1% protocol fee en `/compose`

> SPEC_APPROVED: no
> Fecha: 2026-06-20
> Tipo: feature
> SDD_MODE: full
> Branch: feat/115-wkh-118-fee-compose
> Artefactos: doc/sdd/115-wkh-118-fee-compose/

---

## 1. Resumen

Extender el cobro best-effort del 1% protocol fee al endpoint `/compose`,
replicando el patrón ya operativo en `/orchestrate` (WKH-44 + recibo WKH-124).
Hoy `chargeProtocolFee` solo se invoca dentro de `orchestrateService`; las
composiciones explícitas vía `POST /compose` no generan revenue. El cobro se
inserta en el **route handler** `src/routes/compose.ts` (no en el service),
inmediatamente después de un compose exitoso (`result.success === true`), usando
`request.id` (UUID v4) como clave de idempotencia y `result.totalCostUsdc` como
base del fee. Es best-effort (nunca rompe el 200), idempotente por PK en
`a2a_protocol_fees`, y emite un recibo `protocol_fee` fire-and-forget cuando hay
`owner_ref`. **Cero migraciones, cero cambios al service de compose, cero cambios
a `fee-charge.ts`.**

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 115 (WKH-118) |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Objetivo** | Cobrar el 1% protocol fee en `/compose` igual que en `/orchestrate`, best-effort e idempotente, reusando `chargeProtocolFee`. |
| **Reglas de negocio** | Fee = 1% (`getProtocolFeeRate()`) sobre `result.totalCostUsdc`. Solo en pipelines exitosos. Best-effort (nunca rompe el 200). Idempotente por `request.id`. Recibo fire-and-forget si hay `owner_ref`. |
| **Scope IN** | `src/routes/compose.ts` (bloque fee + recibo) + `src/routes/compose.fee.test.ts` (nuevo). |
| **Scope OUT** | `src/services/compose.ts`, `src/services/fee-charge.ts`, `src/services/orchestrate.ts`, migraciones DB, dashboard/analytics, nuevos campos en el response body. |
| **Missing Inputs** | Ambos resueltos en F2 (ver §9). |

### Acceptance Criteria (EARS)

- **AC-1**: WHEN un pipeline `/compose` completa con `result.success === true`,
  THE sistema SHALL llamar `chargeProtocolFee` con `orchestrationId = request.id`
  (UUID v4), `budgetUsdc = result.totalCostUsdc`, y `feeRate = getProtocolFeeRate()`.
- **AC-2**: WHILE `chargeProtocolFee` se ejecuta tras un compose exitoso, THE
  sistema SHALL NO bloquear ni rechazar la respuesta HTTP 200 — el cobro es
  best-effort (cualquier fallo capturado en variable local, la respuesta procede).
- **AC-3**: IF `chargeProtocolFee` retorna `{ status: 'already-charged' }` para
  un `request.id`, THEN THE sistema SHALL tratarlo como no-op (sin doble débito,
  sin error), idéntico al patrón de orchestrate.
- **AC-4**: IF `WASIAI_PROTOCOL_FEE_WALLET` está unset o vacío, THEN
  `chargeProtocolFee` retorna `{ status: 'skipped', reason: 'WALLET_UNSET' }` y la
  respuesta de compose SHALL NO incluir campo de error de fee.
- **AC-5**: WHEN `result.success === false`, THE sistema SHALL NO llamar
  `chargeProtocolFee` — el fee solo se cobra sobre pipelines completados.
- **AC-6**: WHEN `chargeProtocolFee` retorna `{ status: 'charged' }` y
  `request.a2aKeyRow?.owner_ref` está presente, THE sistema SHALL emitir un recibo
  `protocol_fee` vía `receiptService.emit` (fire-and-forget, best-effort).
- **AC-7**: WHEN dos requests concurrentes con el mismo `request.id` intentan
  cobrar el fee, THE sistema SHALL resolver idempotentemente vía la PK
  `a2a_protocol_fees.orchestration_id` (unique violation → `already-charged`) sin
  doble cobro.

---

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón / hallazgo extraído |
|---------|---------|----------------------------|
| `src/routes/compose.ts:140-239` | Punto de inserción del cobro (route handler `POST /`). | El `result` de compose está en `compose.ts:194-214`. Guards `if (reply.sent) return` en L186 y **L217** (post-compose). `result.success` se chequea en L219. Respuesta éxito en **L235-236**: `reply.send({ kiteTxHash, ...result })`. El caller row está en `request.a2aKeyRow` (Fastify decoration, propagado a `scopingKeyRow` en L199). `request.id` es UUID v4 (genReqId). `request.resolvedChainId` disponible (L208). `request.paymentTxHash` = `kiteTxHash` (L235). |
| `src/services/orchestrate.ts:432-482` | EXEMPLAR exacto del bloque fee + recibo WKH-124. | `if (pipeline.success) { feeResult = await chargeProtocolFee({orchestrationId, budgetUsdc: budget, feeRate}); if 'failed' → capturar error+console.error; else if 'charged'|'already-charged' → feeChargeTxHash; si 'charged' && owner_ref → receiptService.emit({...}).catch(warn) }`. **OJO**: orchestrate usa `request.scopingKeyRow?.owner_ref` porque es un DTO; en el route de compose el row es `request.a2aKeyRow` (ver CD-7). |
| `src/services/fee-charge.ts:1-338` | Firma, retorno y MECANISMO real de `chargeProtocolFee` + `getProtocolFeeRate`. | `chargeProtocolFee({orchestrationId, budgetUsdc, feeRate}): Promise<FeeChargeResult>`. Union por `status`: `'charged'`(feeUsdc,txHash) \| `'already-charged'`(feeUsdc,txHash?,inProgress?) \| `'skipped'`(feeUsdc,reason:'WALLET_UNSET') \| `'failed'`(feeUsdc,error). **El transfer sale del wallet del PaymentAdapter server-side** (`getPaymentAdapter().sign({to: walletAddress, value: feeWei})` + `.settle(...)`, L250-267): NO del budget del caller. `budgetUsdc` solo computa `feeUsdc = budget*rate` (L158) y es el techo del safety-guard (L162). PUEDE throw `ProtocolFeeError` (HTTP 400) SOLO si `feeUsdc > budgetUsdc`. |
| `src/types/index.ts:287-298` | Confirmar nombre del campo de monto. | `ComposeResult.totalCostUsdc: number` (L291) — suma acumulada de `agent.priceUsdc` de los steps exitosos. Confirmado: el campo se llama **`totalCostUsdc`** (no `totalCost`; `totalCost` es la variable local interna en `compose.ts`). |
| `src/services/compose.ts:67,215,339` | Confirmar que `totalCostUsdc` se retorna. | `let totalCost = 0` (L67); `totalCost += agent.priceUsdc` por step (L215); retornado como `totalCostUsdc: totalCost` (L339 happy path + L78/97/116/178/329 paths de error). Siempre presente en `ComposeResult`. |
| `src/services/receipt.ts:96-188` | Firma de `receiptService.emit`. | `emit(input: EmitReceiptInput): Promise<void>` — NUNCA throw (best-effort interno), pero el call-site igual debe `.catch(warn)` (espejo orchestrate). Guards internos: skip si `!ownerRef` o `RECEIPT_SIGNING_SECRET` unset. |
| `src/types/receipt.ts:9,36-47` | Shape de `EmitReceiptInput` + `ReceiptType`. | `ReceiptType` incluye `'protocol_fee'` (L9). `EmitReceiptInput`: `{ownerRef, agentKeyId, sessionId, delegationId, receiptType, amountUsd, chainId, txHash, counterparty, orchestrationId}`. |
| `supabase/migrations/20260421015829_a2a_protocol_fees.sql:7-19` | Confirmar que `orchestration_id` es UUID genérico. | `orchestration_id UUID PRIMARY KEY` — sin FK, sin CHECK semántico. Acepta cualquier UUID v4. Cero migración necesaria. |
| `src/middleware/request-id.ts:9-10` | Confirmar `request.id` es UUID v4. | `genReqId = () => crypto.randomUUID()` → `request.id` es UUID v4 garantizado. |
| `src/middleware/a2a-key.ts:56-68` | Confirmar decorations en el request del route. | `request.a2aKeyRow?: A2AAgentKeyRow` (L58), `request.resolvedChainId?: number` (L62) — disponibles en el route de compose. |
| `src/middleware/x402.ts:37-39, 280` | Confirmar `request.paymentTxHash`. | `request.paymentTxHash?: string` (L39), seteado en L280 = `kiteTxHash`. |
| `src/routes/compose.test.ts:1-196` | EXEMPLAR del test del route (mocks de middleware + composeService). | Mocks: `a2a-key.js` (pass-through que setea `a2aKeyRow`), `timeout.js` (no-op), `rate-limit.js` (no-op), `agent-price.js`, `compose.js`. `app.inject({method:'POST', url:'/compose', headers:{'x-a2a-key':...}, payload:{steps:[...]}})`. Patrón a extender con mocks de `fee-charge.js` + `receipt.js`. |
| `src/routes/orchestrate.test.ts:28-67` | Cómo se mockean middlewares + service. | Confirmó que el route-test mockea por módulo. Para compose mockearemos también `fee-charge.js` y `receipt.js` (la lógica de fee vive en el route, no en el service). |

### Exemplars

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| Bloque fee + recibo en `src/routes/compose.ts` | `src/services/orchestrate.ts:432-482` | Mismo flujo: charge → switch por status → emit recibo fire-and-forget. **Diferencias obligatorias**: (a) `budgetUsdc: result.totalCostUsdc` (no `budget`); (b) `orchestrationId: request.id` (no un UUID generado); (c) `request.a2aKeyRow?.owner_ref` (no `scopingKeyRow`); (d) `chainId: request.resolvedChainId ?? 0`. |
| `src/routes/compose.fee.test.ts` (nuevo) | `src/routes/compose.test.ts:1-196` | Misma infra de mocks de middleware + `compose.js`; agregar mocks de `../services/fee-charge.js` y `../services/receipt.js`. |

### Estado de BD relevante

| Tabla | Existe | Columnas relevantes |
|-------|--------|---------------------|
| `a2a_protocol_fees` | Sí | `orchestration_id UUID PK` (genérico, acepta `request.id`), `budget_usdc`, `fee_rate`, `fee_usdc`, `status`, `tx_hash`. **Sin cambios.** |
| `a2a_receipts` | Sí (WKH-124) | Consumida vía `receiptService.emit` → RPC `insert_receipt`. **Sin cambios.** |

### Componentes reutilizables encontrados

- `chargeProtocolFee` + `getProtocolFeeRate` en `src/services/fee-charge.ts` — reutilizar sin tocar (CD-2).
- `receiptService.emit` en `src/services/receipt.ts` — reutilizar sin tocar.

---

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `src/routes/compose.ts` | Modificar | Importar `chargeProtocolFee`, `getProtocolFeeRate` de `../services/fee-charge.js` y `receiptService` de `../services/receipt.js`. Insertar bloque best-effort entre L233 (cierre del `if (!result.success)`) y L235 (la respuesta éxito), dentro del path `result.success === true`. Cubre AC-1..AC-7. | `src/services/orchestrate.ts:432-482` |
| `src/routes/compose.fee.test.ts` | Crear | Test del route con mocks de `fee-charge.js` + `receipt.js`. ≥1 test por AC. | `src/routes/compose.test.ts` |

### 4.2 Modelo de datos

N/A — cero cambios de schema. `a2a_protocol_fees.orchestration_id` ya es `UUID PRIMARY KEY` genérico (acepta `request.id`). `a2a_receipts` se escribe vía RPC existente.

### 4.3 Componentes / Servicios

No se crean servicios nuevos. El cobro vive en el **route handler** (DT-3), no en `composeService`, porque `request.id` es un artefacto HTTP y agregarlo al `ComposeRequest` mezclaría preocupaciones (igual razonamiento que el work-item DT-3).

**Punto de inserción exacto** — dentro del handler `POST /` de `src/routes/compose.ts`, en el bloque que sigue al `if (!result.success) { return ... }` (cierra en L233) y antes de `return reply.send({ kiteTxHash, ...result })` (L235-236):

```
// (post-compose, result.success === true garantizado aquí — el branch
//  !result.success ya hizo return en L229-233)
// 1. chargeProtocolFee({ orchestrationId: request.id, budgetUsdc: result.totalCostUsdc, feeRate: getProtocolFeeRate() })
// 2. switch por status (mismo shape que orchestrate.ts:443-481)
// 3. si 'charged' && request.a2aKeyRow?.owner_ref → receiptService.emit({...}).catch(warn)
// 4. construir la respuesta existente IGUAL (no se agregan campos, DT-5)
const kiteTxHash = request.paymentTxHash;
return reply.send({ kiteTxHash, ...result });
```

**Comportamiento x402 vs agent-key (RESUELTO — flag del orquestador):**

`chargeProtocolFee` transfiere el fee desde el **wallet server-side del
PaymentAdapter** (`getPaymentAdapter().sign({to: WASIAI_PROTOCOL_FEE_WALLET,
value: feeWei}) + .settle(...)`, `fee-charge.ts:250-267`). El `budgetUsdc`
**solo** se usa para (a) calcular `feeUsdc = budgetUsdc * feeRate` y (b) el
safety-guard `feeUsdc > budgetUsdc`. **NO sale del budget del caller ni de
`a2a_agent_keys`.** Por lo tanto:

- **Caller agent-key** (`request.a2aKeyRow` presente): el fee se cobra normal y
  además se emite el recibo `protocol_fee` (hay `owner_ref`).
- **Caller x402 puro** (sin `a2aKeyRow`): el fee se cobra **igual** (sale del
  operator wallet, no depende del caller). El recibo **NO se emite** (no hay
  `owner_ref`) — exactamente el mismo comportamiento condicional que orchestrate
  (`if (... && request.a2aKeyRow?.owner_ref)`). No hay caso en que el fee no se
  pueda cobrar por tipo de caller. El único skip es por `WALLET_UNSET` (AC-4).

→ El cobro es **owner-agnóstico y consistente en ambos paths**. La única
ramificación es la emisión del recibo, gateada por `owner_ref`.

### 4.4 Flujo principal (Happy Path) — agent-key caller

1. `POST /compose` con steps válidos y `x-a2a-key` → middleware setea `request.a2aKeyRow`.
2. `composeService.compose(...)` retorna `result.success === true`, `result.totalCostUsdc = X`.
3. Guard `if (reply.sent) return` (L217) — no disparó timeout.
4. `result.success === true` → bloque fee: `chargeProtocolFee({ orchestrationId: request.id, budgetUsdc: result.totalCostUsdc, feeRate: getProtocolFeeRate() })`.
5. `feeResult.status === 'charged'` → `request.a2aKeyRow?.owner_ref` presente → `receiptService.emit({ receiptType: 'protocol_fee', amountUsd: feeResult.feeUsdc, chainId: request.resolvedChainId ?? 0, txHash: feeResult.txHash ?? null, counterparty: WASIAI_PROTOCOL_FEE_WALLET ?? null, orchestrationId: request.id, ownerRef, agentKeyId: request.a2aKeyRow.id, sessionId: null, delegationId: null }).catch(warn)`.
6. `return reply.send({ kiteTxHash, ...result })` — **respuesta inalterada** (DT-5).

### 4.5 Flujo de error (best-effort)

1. `chargeProtocolFee` retorna `{status:'failed'}` → capturar en variable local `feeChargeError` + `console.error` → la respuesta 200 procede igual (CD-1, AC-2).
2. `chargeProtocolFee` retorna `{status:'skipped', reason:'WALLET_UNSET'}` → no-op, sin error en response (AC-4).
3. `chargeProtocolFee` retorna `{status:'already-charged'}` → no-op (AC-3, AC-7).
4. `ProtocolFeeError` (caso `feeUsdc > totalCostUsdc`): **prácticamente imposible** con `feeRate ∈ [0, 0.10]` (1% de X nunca supera X para X ≥ 0). Aun así, el bloque debe estar envuelto de modo que un throw NO rompa el 200 (CD-1) → ver Riesgo R-1.
5. `receiptService.emit` falla → `.catch(warn)`, no afecta el 200 (CD-6).

---

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir

- **CD-A**: Reutilizar `chargeProtocolFee` y `getProtocolFeeRate` de
  `src/services/fee-charge.ts` y `receiptService` de `src/services/receipt.js`
  SIN modificarlos. (hereda CD-2 del work-item)
- **CD-B**: El `orchestrationId` pasado a `chargeProtocolFee` DEBE ser
  `request.id` (UUID v4 del HTTP request). NO generar un UUID nuevo. (hereda CD-5)
- **CD-C**: El `budgetUsdc` pasado a `chargeProtocolFee` DEBE ser
  `result.totalCostUsdc`. PROHIBIDO usar `body.maxBudget`. (hereda CD-3)
- **CD-D**: El bloque se ejecuta SOLO dentro del path `result.success === true`
  (tras el `return` del branch `!result.success`). (hereda CD-4)
- **CD-E**: El recibo `protocol_fee` DEBE ser fire-and-forget:
  `receiptService.emit({...}).catch((e) => console.warn(...))`. PROHIBIDO
  `await`-earlo de forma que su latencia/fallo afecte el 200. (hereda CD-6)
- **CD-F**: Pattern del bloque fee = espejo de `orchestrate.ts:443-481`
  (switch por `status`, `feeChargeError`/`feeChargeTxHash` en variables locales).

### PROHIBIDO

- **CD-1**: PROHIBIDO que el fallo de `chargeProtocolFee` o `receiptService.emit`
  interrumpa la respuesta 200 de compose. Todo error → variable local +
  `console.error`/`console.warn`; la respuesta se construye independientemente.
  (hereda CD-1 del work-item)
- **CD-2**: PROHIBIDO copiar/duplicar el bloque EIP-712 sign+settle en el route.
- **CD-3**: PROHIBIDO modificar `src/services/compose.ts`, `src/services/fee-charge.ts`,
  `src/services/orchestrate.ts`, `src/types/index.ts` o agregar migración.
- **CD-4**: PROHIBIDO agregar campos nuevos al response body de compose
  (`feeChargeError`, `feeChargeTxHash`, `protocolFeeUsdc`). El response queda
  `{ kiteTxHash, ...result }` exactamente como hoy (DT-5). Las variables locales
  `feeChargeError`/`feeChargeTxHash` existen SOLO para logging/recibo, no se
  serializan.
- **CD-5 (anti-recurrencia — ref: WKH-124 auto-blindaje #1)**: En el route de
  compose el row del caller es **`request.a2aKeyRow`**, NO `request.scopingKeyRow`.
  `scopingKeyRow` es el campo del DTO `OrchestrateRequest`/`ComposeRequest`, no
  existe como decoration del `FastifyRequest` del route. El exemplar de orchestrate
  usa `scopingKeyRow` porque allí el cobro vive en el service (DTO); acá vive en
  el route (Fastify request). Usar `request.a2aKeyRow?.owner_ref` y
  `request.a2aKeyRow.id` para el recibo (consistente con AC-6 del work-item).
- **CD-6 (anti-recurrencia — ref: WKH-123 auto-blindaje #2)**: Tras agregar los
  imports en `compose.ts`, correr `npm run format` (biome organizeImports) ANTES
  de `npm run lint`. El orden del proyecto es format → lint.
- **CD-7**: PROHIBIDO `await`-ear el resultado del `emit` del recibo dentro del
  path crítico de la respuesta.

---

## 6. Scope

**IN:**
- `src/routes/compose.ts`: imports + bloque best-effort fee/recibo post-compose-éxito.
- `src/routes/compose.fee.test.ts` (nuevo): cobertura ≥1 test por AC-1..AC-7.

**OUT:**
- `src/services/compose.ts` — NO se modifica (no recibe `composeId`).
- `src/services/fee-charge.ts` — NO se modifica (se reutiliza).
- `src/services/orchestrate.ts` — NO se toca.
- `src/types/index.ts` — NO se toca (no se agregan campos al response).
- `supabase/migrations/` — NO se agrega migración.
- Dashboard / analytics — fuera de scope.
- Exponer `protocolFeeUsdc`/`feeChargeTxHash` en el response — descartado (DT-5, ver §9 Missing #1).

---

## 7. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| **R-1**: `chargeProtocolFee` puede `throw ProtocolFeeError` si `feeUsdc > budgetUsdc` (fee-charge.ts:162). Con `feeRate ≤ 0.10` esto no ocurre para `totalCostUsdc ≥ 0`, pero un throw rompería el 200. | B | A | Espejo de orchestrate: orchestrate NO envuelve el call en try/catch porque confía en el guard. **Recomendación defensiva**: el Dev PUEDE envolver el bloque fee completo en try/catch (capturando en `feeChargeError`) para blindar CD-1 al 100% aun ante throws inesperados. Esto es additive y consistente con best-effort. Decisión final del Dev/Story File. |
| **R-2**: `totalCostUsdc === 0` (pipeline gratuito/0 steps) → `feeUsdc = 0`, guard `0 > 0` es false → se cobra fee de $0 (transfer de valor 0). | M | B | Comportamiento confirmado = idéntico a orchestrate (se procesa fee $0, no se skipea). RESUELTO en §9 Missing #2: NO se agrega skip especial — consistencia con orchestrate. `chargeProtocolFee` inserta el row y hace settle de value 0 (auditable). |
| **R-3**: El Dev copia `scopingKeyRow` del exemplar de orchestrate → TS error (no existe en `FastifyRequest`). | M | M | CD-5 explícito + test AC-6 que verifica `emit` se llama con `ownerRef` del `a2aKeyRow`. |
| **R-4**: El Dev `await`-ea el recibo o lo serializa en el response. | B | M | CD-4 + CD-7 + test que verifica el response NO contiene campos de fee. |

---

## 8. Dependencias

- WKH-44 (DONE): `chargeProtocolFee` + `getProtocolFeeRate` + tabla `a2a_protocol_fees`.
- WKH-124 (DONE): `receiptService.emit` + tabla `a2a_receipts` + `ReceiptType 'protocol_fee'`.
- Sin dependencias salientes: el cambio es additive, no altera contratos públicos de `/compose`.

---

## 9. Missing Inputs — resueltos en F2

- **#1 (DT-5)**: ¿Exponer `protocolFeeUsdc`/`feeChargeTxHash` en el response de
  compose? **RESUELTO: NO.** Se mantiene el response actual `{ kiteTxHash, ...result }`.
  Razón: (a) opacidad del fee es por diseño en compose (el caller ya recibe
  `totalCostUsdc`); (b) agregar campos rompería la simetría mínima del scope y
  obligaría a tocar tipos. Si producto lo requiere luego, es un TD additive
  trivial (CD-4 lo bloquea por ahora). Esto difiere de orchestrate (que sí los
  expone), pero compose nunca los expuso → mantenerlo consistente con compose.
- **#2 (test strategy)**: ¿mock o integration? **RESUELTO: mock.** Test del route
  con `vi.mock` de `../services/fee-charge.js` (stub de `chargeProtocolFee` +
  `getProtocolFeeRate`) y `../services/receipt.js` (`receiptService.emit` espía),
  espejo de `src/routes/compose.test.ts`. Sin tocar Supabase real.

---

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| (ninguno) | — | No quedan `[NEEDS CLARIFICATION]`. R-1 es una recomendación defensiva opcional, no un bloqueante. | No |

> No hay markers bloqueantes. SDD listo para SPEC_APPROVED.

---

## 11. Plan de Implementación (Waves)

> Feature chico: 1 archivo modificado + 1 test nuevo. W0 vacío (no hay tipos/contratos nuevos).

### Wave 0 (Serial Gate)
- N/A — no se introducen tipos, contratos ni migraciones nuevas. `FeeChargeResult`,
  `EmitReceiptInput`, `ComposeResult.totalCostUsdc` ya existen.

### Wave 1 (Implementación — route handler)
- [ ] **W1.1**: En `src/routes/compose.ts` agregar imports de `chargeProtocolFee`,
  `getProtocolFeeRate` (`../services/fee-charge.js`) y `receiptService`
  (`../services/receipt.js`). Insertar el bloque best-effort fee+recibo entre
  L233 y L235 (path `result.success === true`). → Exemplar: `orchestrate.ts:432-482`.
  Aplicar CD-5 (usar `request.a2aKeyRow`), CD-C (`result.totalCostUsdc`),
  CD-B (`request.id`), CD-4 (response inalterado). Correr `npm run format` antes de lint (CD-6).

### Wave 2 (Tests — depende de W1)
- [ ] **W2.1**: Crear `src/routes/compose.fee.test.ts` con mocks de `fee-charge.js`
  + `receipt.js` (espejo de `compose.test.ts`). ≥1 test por AC-1..AC-7. → Depende de W1.1.

### Wave 3 (Verificación final)
- [ ] **W3.1**: `npm run format` → `npm run lint` → `npm run typecheck` (o `tsc --noEmit`) → `npm test`. Confirmar 0 errores y todos los AC-tests verdes.

### Archivos involucrados

| Archivo | Existe | Acción | Wave | Exemplar |
|---------|--------|--------|------|----------|
| `src/routes/compose.ts` | Sí | Modificar | W1.1 | `src/services/orchestrate.ts:432-482` |
| `src/routes/compose.fee.test.ts` | No | Crear | W2.1 | `src/routes/compose.test.ts` |

### Test Plan

| Test | AC que cubre | Wave | Framework |
|------|-------------|------|-----------|
| `T-FEE-1`: compose `success:true` → `chargeProtocolFee` llamado con `{orchestrationId: <request.id UUID>, budgetUsdc: result.totalCostUsdc, feeRate}` | AC-1 | W2.1 | vitest |
| `T-FEE-2`: `chargeProtocolFee` rechaza/retorna `failed` → respuesta sigue 200, body sin campo de error de fee | AC-2 | W2.1 | vitest |
| `T-FEE-3`: `chargeProtocolFee` → `already-charged` → 200, no-op, sin doble efecto | AC-3 | W2.1 | vitest |
| `T-FEE-4`: `chargeProtocolFee` → `skipped/WALLET_UNSET` → 200, sin error en response, sin recibo | AC-4 | W2.1 | vitest |
| `T-FEE-5`: compose `success:false` → `chargeProtocolFee` NUNCA llamado | AC-5 | W2.1 | vitest |
| `T-FEE-6`: `charged` + `a2aKeyRow.owner_ref` presente → `receiptService.emit` llamado con `receiptType:'protocol_fee'`, `ownerRef`, `agentKeyId`. Variante x402 (sin `a2aKeyRow`) → emit NO llamado | AC-6 | W2.1 | vitest |
| `T-FEE-7`: segunda llamada con mismo `request.id` mock-eando `already-charged` → resuelve idempotente sin doble emit/charge (idempotencia delegada a la PK; el test verifica el manejo del status `already-charged`) | AC-7 | W2.1 | vitest |
| `T-FEE-8` (CD-4 regresión): response body de un compose exitoso NO contiene `feeChargeError`/`feeChargeTxHash`/`protocolFeeUsdc` | CD-4 | W2.1 | vitest |

> Nota AC-7: la idempotencia real ocurre en la PK de `a2a_protocol_fees`
> (`fee-charge.ts`, ya testeado en `fee-charge.test.ts`). El test del route
> verifica que el route maneja `already-charged` como no-op (no que la DB la
> garantice — eso es scope de fee-charge, OUT acá).

### Verificación Incremental

| Wave | Verificación |
|------|--------------|
| W1 | `npm run format` + `npm run lint` + `tsc --noEmit` |
| W2 | `npm test src/routes/compose.fee.test.ts` |
| W3 | format → lint → typecheck → `npm test` completo |

### Estimación

- Archivos nuevos: 1 (`compose.fee.test.ts`)
- Archivos modificados: 1 (`compose.ts`)
- Tests nuevos: 8
- Líneas estimadas: ~50 en `compose.ts`, ~250 en el test.

---

## Implementation Readiness Check

```
[x] Cada AC (1-7) tiene ≥1 archivo asociado en tabla 4.1 (compose.ts + compose.fee.test.ts)
[x] Cada archivo en 4.1 tiene Exemplar verificado con Read (orchestrate.ts:432-482 / compose.test.ts)
[x] No hay [NEEDS CLARIFICATION] pendientes (ambos Missing Inputs resueltos en §9)
[x] Constraint Directives incluyen ≥3 PROHIBIDO (CD-1..CD-7 → 7 PROHIBIDO + 6 OBLIGATORIO)
[x] Context Map tiene ≥2 archivos leídos (12 archivos con line ranges reales)
[x] Scope IN y OUT explícitos y no ambiguos
[x] BD: tablas verificadas que existen (a2a_protocol_fees PK genérica, a2a_receipts)
[x] Flujo principal (Happy Path) completo (§4.4)
[x] Flujo de error definido (§4.5, 5 casos)
[x] Comportamiento x402-vs-agent-key resuelto y groundeado (§4.3)
[x] Nombre real del campo de monto confirmado: ComposeResult.totalCostUsdc (types/index.ts:291)
```

---

*SDD generado por NexusAgil — FULL — WKH-118*
