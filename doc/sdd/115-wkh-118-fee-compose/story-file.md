# Story File — #115: [WKH-118] FEE-COMPOSE — Cobro del 1% protocol fee en `/compose`

> SDD: doc/sdd/115-wkh-118-fee-compose/sdd.md
> Fecha: 2026-06-20
> Branch: feat/115-wkh-118-fee-compose

---

## Goal

Cobrar el 1% protocol fee en `POST /compose`, espejo exacto del cobro ya
operativo en `/orchestrate`. El cobro es **best-effort** (nunca rompe la
respuesta 200), **idempotente por `request.id`** (UUID v4 del HTTP request),
y se calcula sobre `result.totalCostUsdc` (lo efectivamente gastado en el
pipeline). Reusa `chargeProtocolFee` + `getProtocolFeeRate` + `receiptService.emit`
SIN modificarlos. **Cero migraciones, cero cambios al service, cero cambios a
`fee-charge.ts`/`orchestrate.ts`/tipos.** El response body de compose NO cambia.

---

## Acceptance Criteria (EARS)

> Copiados del SDD aprobado. QA los verifica en F4.

1. **AC-1**: WHEN un pipeline `/compose` completa con `result.success === true`,
   THE sistema SHALL llamar `chargeProtocolFee` con `orchestrationId = request.id`
   (UUID v4), `budgetUsdc = result.totalCostUsdc`, y `feeRate = getProtocolFeeRate()`.
2. **AC-2**: WHILE `chargeProtocolFee` se ejecuta tras un compose exitoso, THE
   sistema SHALL NO bloquear ni rechazar la respuesta HTTP 200 — el cobro es
   best-effort (cualquier fallo capturado en variable local, la respuesta procede).
3. **AC-3**: IF `chargeProtocolFee` retorna `{ status: 'already-charged' }` para
   un `request.id`, THEN THE sistema SHALL tratarlo como no-op (sin doble débito,
   sin error), idéntico al patrón de orchestrate.
4. **AC-4**: IF `WASIAI_PROTOCOL_FEE_WALLET` está unset o vacío, THEN
   `chargeProtocolFee` retorna `{ status: 'skipped', reason: 'WALLET_UNSET' }` y la
   respuesta de compose SHALL NO incluir campo de error de fee.
5. **AC-5**: WHEN `result.success === false`, THE sistema SHALL NO llamar
   `chargeProtocolFee` — el fee solo se cobra sobre pipelines completados.
6. **AC-6**: WHEN `chargeProtocolFee` retorna `{ status: 'charged' }` y
   `request.a2aKeyRow?.owner_ref` está presente, THE sistema SHALL emitir un recibo
   `protocol_fee` vía `receiptService.emit` (fire-and-forget, best-effort).
7. **AC-7**: WHEN dos requests concurrentes con el mismo `request.id` intentan
   cobrar el fee, THE sistema SHALL resolver idempotentemente vía la PK
   `a2a_protocol_fees.orchestration_id` (unique violation → `already-charged`) sin
   doble cobro.

---

## Files to Modify/Create

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `src/routes/compose.ts` | Modificar | Agregar imports de `chargeProtocolFee`, `getProtocolFeeRate` (`../services/fee-charge.js`) y `receiptService` (`../services/receipt.js`). Insertar el **bloque exacto** (ver §Exemplar 1) entre L233 (cierre del `if (!result.success)`) y L235 (`const kiteTxHash = ...`). El response final queda **inalterado**. | `src/services/orchestrate.ts:437-482` |
| 2 | `src/routes/compose.fee.test.ts` | Crear | Test del route con mocks de `../services/fee-charge.js` + `../services/receipt.js` (además de los mocks de middleware/compose que ya usa `compose.test.ts`). ≥1 test por AC-1..AC-7 + 1 test de regresión CD-4. | `src/routes/compose.test.ts` |

---

## Exemplars

### Exemplar 1: Bloque fee + recibo (a replicar en `compose.ts`)
**Archivo origen del patrón**: `src/services/orchestrate.ts:437-482`
**Usar para**: Archivo #1 (`src/routes/compose.ts`)

El orchestrate hace esto (NO copiar tal cual — tiene `scopingKeyRow` y `budget`
que NO aplican acá, ver el bloque adaptado abajo):

```ts
// orchestrate.ts:437-482 — PATRÓN, NO copiar literal
if (pipeline.success) {
  const feeResult = await chargeProtocolFee({
    orchestrationId,
    budgetUsdc: budget,
    feeRate,
  });
  if (feeResult.status === 'failed') {
    feeChargeError = feeResult.error;
    console.error('[Orchestrate] fee charge failed:', feeResult.error);
  } else if (
    feeResult.status === 'charged' ||
    feeResult.status === 'already-charged'
  ) {
    feeChargeTxHash = feeResult.txHash;
    if (feeResult.status === 'charged' && request.scopingKeyRow?.owner_ref) {
      receiptService.emit({ /* ... */ }).catch((e) => console.warn(/* ... */));
    }
  }
  // 'skipped' → ambos undefined (wallet unset).
}
```

**BLOQUE EXACTO a insertar en `compose.ts`** (entre L233 y L235, path
`result.success === true` ya garantizado porque el branch `!result.success`
hizo `return` en L229-233). Diferencias obligatorias respecto a orchestrate:
`budgetUsdc: result.totalCostUsdc` (CD-C), `orchestrationId: request.id` (CD-B),
`request.a2aKeyRow` en vez de `scopingKeyRow` (CD-5), `chainId: request.resolvedChainId ?? 0`,
y todo el bloque envuelto en `try/catch` para blindar best-effort al 100% (R-1):

```ts
// WKH-118: best-effort 1% protocol fee post-compose (espejo orchestrate.ts:437-482).
// Idempotencia por request.id; base = result.totalCostUsdc. NUNCA rompe el 200
// (CD-1): todo error queda en variables locales + console. El response NO cambia (CD-4).
let feeChargeError: string | undefined;
let feeChargeTxHash: string | undefined;
try {
  const feeResult = await chargeProtocolFee({
    orchestrationId: request.id,
    budgetUsdc: result.totalCostUsdc,
    feeRate: getProtocolFeeRate(),
  });
  if (feeResult.status === 'failed') {
    feeChargeError = feeResult.error;
    console.error('[Compose] fee charge failed:', feeResult.error);
  } else if (
    feeResult.status === 'charged' ||
    feeResult.status === 'already-charged'
  ) {
    feeChargeTxHash = feeResult.txHash;
    // WKH-124: emit protocol_fee receipt SOLO si charged + owner_ref presente.
    // Fire-and-forget (CD-6/CD-7): su fallo/latencia NUNCA afecta el 200.
    if (feeResult.status === 'charged' && request.a2aKeyRow?.owner_ref) {
      receiptService
        .emit({
          ownerRef: request.a2aKeyRow.owner_ref,
          agentKeyId: request.a2aKeyRow.id,
          sessionId: null,
          delegationId: null,
          receiptType: 'protocol_fee',
          amountUsd: feeResult.feeUsdc,
          chainId: request.resolvedChainId ?? 0,
          txHash: feeResult.txHash ?? null,
          counterparty: process.env.WASIAI_PROTOCOL_FEE_WALLET ?? null,
          orchestrationId: request.id,
        })
        .catch((e) =>
          console.warn(
            '[receipts] emit failed',
            e instanceof Error ? e.message : e,
          ),
        );
    }
  }
  // 'skipped' → ambos undefined (wallet unset) — sin error, sin recibo (AC-4).
} catch (e) {
  // R-1: chargeProtocolFee puede throw ProtocolFeeError (feeUsdc > budget).
  // Con feeRate ≤ 0.10 es prácticamente imposible, pero capturamos para
  // blindar CD-1 al 100%. La respuesta 200 procede igual.
  feeChargeError = e instanceof Error ? e.message : String(e);
  console.error('[Compose] fee charge threw:', feeChargeError);
}

const kiteTxHash = request.paymentTxHash;
return reply.send({ kiteTxHash, ...result });
```

**Notas de tipos (TS strict, verificadas contra el código real):**
- `feeChargeError` / `feeChargeTxHash` son variables locales SOLO para
  logging/recibo. **NO se serializan en el response** (CD-4). Quedan declaradas
  con `let ... : string | undefined`. Es esperable que biome marque
  `feeChargeError`/`feeChargeTxHash` como "asignadas pero no leídas" —
  para evitar el warning, podés asignarlas y loguearlas (ya lo hacés con
  `console.error`/`console.warn`), o si el linter sigue molesto, declarar
  solo las que efectivamente uses. Replicá el patrón de orchestrate (que las
  declara ambas). Si biome bloquea, mantené solo las usadas y reportá.
- `chargeProtocolFee` es `async` → `await`-eala (sí se espera su resultado,
  pero su throw está capturado por el `try/catch`). El **recibo** NO se
  `await`-ea (fire-and-forget con `.catch`).

**Firma real de `chargeProtocolFee`** (`src/services/fee-charge.ts:152-155`):
```ts
chargeProtocolFee(params: { orchestrationId: string; budgetUsdc: number; feeRate: number }): Promise<FeeChargeResult>
```
**`FeeChargeResult`** (`fee-charge.ts:38-47`) — discriminated union por `status`:
```ts
| { status: 'charged'; feeUsdc: number; txHash: string }
| { status: 'already-charged'; feeUsdc: number; txHash?: string; inProgress?: boolean }
| { status: 'skipped'; feeUsdc: number; reason: 'WALLET_UNSET' }
| { status: 'failed'; feeUsdc: number; error: string }
```
**`getProtocolFeeRate()`** (`fee-charge.ts:90`): `(): number`.
**`receiptService.emit`** (`src/services/receipt.ts:109`): `emit(input: EmitReceiptInput): Promise<void>` — NUNCA throw (best-effort interno), igual aplicamos `.catch` en el call-site (espejo orchestrate).
**`EmitReceiptInput`** (`src/types/receipt.ts:36-47`): exactamente los 10 campos usados arriba (`ownerRef`, `agentKeyId`, `sessionId`, `delegationId`, `receiptType`, `amountUsd`, `chainId`, `txHash`, `counterparty`, `orchestrationId`). `amountUsd: number | string` → pasamos `feeResult.feeUsdc` (number). `receiptType: 'protocol_fee'` es valor válido de `ReceiptType` (`types/receipt.ts:9`).

### Exemplar 2: Estructura del test del route
**Archivo**: `src/routes/compose.test.ts:1-196`
**Usar para**: Archivo #2 (`src/routes/compose.fee.test.ts`)
**Patrón clave** (copiá la infra de mocks tal cual y agregá los dos mocks nuevos):
- Mock de `../middleware/a2a-key.js` → handler pass-through que setea
  `request.a2aKeyRow = nextKeyRow` (variable mutable de scope de módulo). Así
  controlás `owner_ref`/`id` por test, y el caso x402 = `nextKeyRow = undefined`.
- Mock de `../middleware/timeout.js` (no-op), `../middleware/rate-limit.js`
  (`orchestrateRateLimit: () => false`), `../services/agent-price.js`
  (`resolveAgentPriceUsdc: vi.fn()` → `mockResolvedValue(0.001)` en `beforeEach`
  para que el preHandler no haga 404), `../services/compose.js`
  (`composeService.compose: vi.fn()`).
- **NUEVO** mock de `../services/fee-charge.js`:
  ```ts
  vi.mock('../services/fee-charge.js', () => ({
    chargeProtocolFee: vi.fn(),
    getProtocolFeeRate: vi.fn(() => 0.01),
  }));
  ```
- **NUEVO** mock de `../services/receipt.js`:
  ```ts
  vi.mock('../services/receipt.js', () => ({
    receiptService: { emit: vi.fn().mockResolvedValue(undefined) },
  }));
  ```
- Importá los mockeados y tipalos con `vi.mocked(...)` después de los `vi.mock`.
- App: `Fastify()` + `app.register(composeRoutes, { prefix: '/compose' })` +
  `app.ready()` en `beforeAll`, `app.close()` en `afterAll`,
  `vi.clearAllMocks()` + reset de `nextKeyRow` + `mockResolvePrice.mockResolvedValue(0.001)`
  en `beforeEach`.
- Invocación: `app.inject({ method: 'POST', url: '/compose', headers: { 'x-a2a-key': 'wasi_a2a_test' }, payload: { steps: [{ agent: 'a1', input: {} }] } })`.
- Default `composeService.compose` → `{ success: true, output: 'ok', steps: [], totalCostUsdc: 0.05, totalLatencyMs: 5 }`. Sobreescribí por test con `mockResolvedValueOnce`.

---

## Constraint Directives

### OBLIGATORIO
- **CD-A**: Reutilizar `chargeProtocolFee` + `getProtocolFeeRate` de
  `src/services/fee-charge.ts` y `receiptService` de `src/services/receipt.ts`
  SIN modificarlos.
- **CD-B**: `orchestrationId` pasado a `chargeProtocolFee` DEBE ser `request.id`
  (UUID v4 del HTTP request). **NO generar un UUID nuevo** (no `crypto.randomUUID()`).
- **CD-C**: `budgetUsdc` DEBE ser `result.totalCostUsdc`. **PROHIBIDO** usar
  `body.maxBudget`.
- **CD-D**: El bloque corre SOLO en el path `result.success === true` (tras el
  `return` del branch `!result.success` en L229-233).
- **CD-E (recibo fire-and-forget)**: el recibo `protocol_fee` se emite con
  `receiptService.emit({...}).catch((e) => console.warn(...))`. **PROHIBIDO**
  `await`-earlo.
- **CD-F**: El bloque = espejo de `orchestrate.ts:437-481` (switch por `status`,
  `feeChargeError`/`feeChargeTxHash` en variables locales).
- **CD-5 (anti-recurrencia — ref: WKH-124 auto-blindaje #1)**: En el route de
  compose el row del caller es **`request.a2aKeyRow`**, NO `request.scopingKeyRow`.
  `scopingKeyRow` es campo del DTO `ComposeRequest`, NO existe como decoration del
  `FastifyRequest`. El exemplar de orchestrate usa `scopingKeyRow` porque allí el
  cobro vive en el service (DTO). Acá vive en el route → usá
  `request.a2aKeyRow?.owner_ref` y `request.a2aKeyRow.id`. **Copiar `scopingKeyRow`
  del exemplar = TS error garantizado.**
- **R-1 (blindaje)**: Envolvé el bloque completo de `chargeProtocolFee` en
  `try/catch` (capturando en `feeChargeError`). `chargeProtocolFee` puede `throw
  ProtocolFeeError` si `feeUsdc > budgetUsdc` (`fee-charge.ts:162`). Con feeRate ≤
  0.10 no ocurre, pero el try/catch blinda CD-1 al 100%.
- **CD-6 (orden de tooling — ref: WKH-123 auto-blindaje #2)**: tras agregar los
  imports, correr `npm run format` (biome organizeImports) **ANTES** de
  `npm run lint`. El orden del proyecto es **format → lint**.

### PROHIBIDO
- **CD-1**: PROHIBIDO que el fallo de `chargeProtocolFee` o `receiptService.emit`
  interrumpa la respuesta 200 de compose. Todo error → variable local +
  `console.error`/`console.warn`; la respuesta se construye independientemente.
- **CD-2**: PROHIBIDO copiar/duplicar el bloque EIP-712 sign+settle en el route.
  Reusar `chargeProtocolFee`.
- **CD-3-files**: PROHIBIDO modificar `src/services/compose.ts`,
  `src/services/fee-charge.ts`, `src/services/orchestrate.ts`,
  `src/types/index.ts`, `src/types/receipt.ts`, `src/services/receipt.ts`, o
  agregar migración.
- **CD-4 (response inalterado)**: PROHIBIDO agregar campos al response body de
  compose (`feeChargeError`, `feeChargeTxHash`, `protocolFeeUsdc`). El response
  queda **exactamente** `{ kiteTxHash, ...result }` como hoy. Las variables
  locales existen SOLO para logging/recibo, NO se serializan.
- **CD-7**: PROHIBIDO `await`-ear el resultado del `emit` del recibo en el path
  crítico de la respuesta.
- **TS strict**: cero `any` explícito. Narrowing por `feeResult.status` (la union
  ya garantiza el narrowing — usá `if`/`else if` por `status`).
- **NO dependencias nuevas**: no instalar paquetes. Todo lo necesario ya existe.

---

## Test Expectations

| Test | ACs que cubre | Framework | Tipo |
|------|--------------|-----------|------|
| `src/routes/compose.fee.test.ts` :: T-FEE-1 | AC-1 | vitest | integration (route + inject) |
| ... :: T-FEE-2 | AC-2 | vitest | integration |
| ... :: T-FEE-3 | AC-3 | vitest | integration |
| ... :: T-FEE-4 | AC-4 | vitest | integration |
| ... :: T-FEE-5 | AC-5 | vitest | integration |
| ... :: T-FEE-6 | AC-6 | vitest | integration |
| ... :: T-FEE-7 | AC-7 | vitest | integration |
| ... :: T-FEE-8 | CD-4 (regresión) | vitest | integration |

### Detalle de cada test (≥1 por AC)

- **T-FEE-1 (AC-1)**: `compose → success:true` con `totalCostUsdc: 0.5`;
  `chargeProtocolFee.mockResolvedValueOnce({ status: 'charged', feeUsdc: 0.005, txHash: '0xfee' })`.
  Assert: `res.statusCode === 200` y `mockChargeFee` llamado con
  `{ orchestrationId: <string UUID>, budgetUsdc: 0.5, feeRate: 0.01 }`. Verificá
  el shape con `expect.objectContaining({ budgetUsdc: 0.5, feeRate: 0.01, orchestrationId: expect.any(String) })`.
  (El `orchestrationId` es `request.id`, un UUID generado por Fastify — no podés
  predecir el valor; asseguralo como string no vacío.)
- **T-FEE-2 (AC-2 best-effort)**: dos variantes —
  (a) `chargeProtocolFee.mockRejectedValueOnce(new Error('boom'))` (throw) →
  `res.statusCode === 200`, `res.json().success === true`, body sin campo de
  error de fee; (b) `mockResolvedValueOnce({ status: 'failed', feeUsdc: 0.005, error: 'settle failed' })`
  → igual 200, body intacto.
- **T-FEE-3 (AC-3 idempotencia / already-charged)**:
  `mockResolvedValueOnce({ status: 'already-charged', feeUsdc: 0.005, txHash: '0xprev' })`
  → `res.statusCode === 200`, sin error en body, `receiptService.emit` NO
  llamado (already-charged no es 'charged' → no emite recibo).
- **T-FEE-4 (AC-4 wallet unset)**:
  `mockResolvedValueOnce({ status: 'skipped', feeUsdc: 0.005, reason: 'WALLET_UNSET' })`
  → `res.statusCode === 200`, body sin campo de error de fee, `receiptService.emit`
  NO llamado.
- **T-FEE-5 (AC-5 success:false)**: `compose → { success: false, error: '...', totalCostUsdc: 0 }`
  → `res.statusCode === 400` (o el mapeo correspondiente) y
  `expect(mockChargeFee).not.toHaveBeenCalled()`.
- **T-FEE-6 (AC-6 recibo)**: dos variantes —
  (a) **agent-key**: `nextKeyRow = { id: 'k1', owner_ref: 'o1' }`,
  `chargeProtocolFee → { status: 'charged', feeUsdc: 0.005, txHash: '0xfee' }`
  → `receiptService.emit` llamado UNA vez con
  `expect.objectContaining({ receiptType: 'protocol_fee', ownerRef: 'o1', agentKeyId: 'k1', amountUsd: 0.005, orchestrationId: expect.any(String) })`;
  (b) **x402 puro**: `nextKeyRow = undefined` (sin `a2aKeyRow.owner_ref`),
  `charged` → `expect(mockEmit).not.toHaveBeenCalled()` (el fee igual se "cobra"
  pero sin recibo).
  > Nota: como `emit` es fire-and-forget (no se `await`-ea), en el test podés
  > necesitar un microtask flush (`await new Promise((r) => setImmediate(r))` o
  > `await Promise.resolve()`) después del inject para que el `.catch`/llamada
  > se registre. Si la aserción de `emit` es flaky, agregá ese flush antes del
  > `expect`.
- **T-FEE-7 (AC-7 concurrencia idempotente)**: segunda llamada mockeando
  `{ status: 'already-charged', feeUsdc: 0.005, txHash: '0xprev', inProgress: true }`
  → `res.statusCode === 200`, sin doble efecto (no emite recibo, no error). El
  test verifica que el route maneja `already-charged` como no-op (la idempotencia
  real vive en la PK de `a2a_protocol_fees`, ya testeada en `fee-charge.test.ts`,
  OUT acá).
- **T-FEE-8 (CD-4 regresión)**: `compose success:true`, `charged` → assert que
  `res.json()` NO contiene `feeChargeError`, `feeChargeTxHash`, ni
  `protocolFeeUsdc`. El body es `{ kiteTxHash, ...result }`:
  `expect(res.json()).not.toHaveProperty('feeChargeError')` (x3).

### Criterio Test-First
APIs / route handler con lógica condicional → **Test-first: Sí**. Escribí el
test (W2) puede ir después de la impl mínima (W1) dado que es un route handler,
pero el suite DEBE quedar verde y cubrir los 7 ACs + CD-4 antes de cerrar.

---

## Waves

### Wave -1: Environment Gate (verificar ANTES de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
# Dependencias instaladas
npm install 2>/dev/null || echo "Sin package.json"
# Archivos base del Scope IN existen
ls src/routes/compose.ts src/services/fee-charge.ts src/services/receipt.ts \
   src/services/orchestrate.ts src/types/receipt.ts src/routes/compose.test.ts \
   2>/dev/null || echo "FALTA archivo base"
# Confirmar exports a importar
grep -n "export function getProtocolFeeRate\|export async function chargeProtocolFee" src/services/fee-charge.ts
grep -n "export const receiptService" src/services/receipt.ts
```

**Si algo falla en Wave -1:** PARAR y reportar al orquestador. No implementar
sobre un entorno roto.

### Wave 0 (Serial Gate)
- N/A — no se introducen tipos, contratos ni migraciones nuevas.
  `FeeChargeResult`, `EmitReceiptInput`, `ComposeResult.totalCostUsdc` ya existen.

### Wave 1 (Implementación — route handler)
- [ ] **W1.1**: En `src/routes/compose.ts`:
  1. Agregar al bloque de imports:
     ```ts
     import {
       chargeProtocolFee,
       getProtocolFeeRate,
     } from '../services/fee-charge.js';
     import { receiptService } from '../services/receipt.js';
     ```
  2. Insertar el **BLOQUE EXACTO** (§Exemplar 1) entre la L233 (`}` que cierra
     el `if (!result.success)`) y la L235 (`const kiteTxHash = ...`). El
     `return reply.send({ kiteTxHash, ...result })` queda **idéntico**.
  - Aplicar CD-B (`request.id`), CD-C (`result.totalCostUsdc`), CD-5
    (`request.a2aKeyRow`), CD-E/CD-7 (recibo `.catch`), R-1 (try/catch),
    CD-4 (response inalterado).

### Wave 2 (Tests — depende de W1)
- [ ] **W2.1**: Crear `src/routes/compose.fee.test.ts` (§Exemplar 2). Mocks de
  middleware + `compose.js` + **`fee-charge.js`** + **`receipt.js`**. Implementar
  T-FEE-1..T-FEE-8. Depende de W1.1.

### Wave 3 (Verificación final)
- [ ] **W3.1**: en este orden exacto (CD-6):
  ```bash
  npm run format    # biome organizeImports — ANTES de lint
  npm run lint
  npx tsc --noEmit  # o npm run typecheck si existe
  npm test
  ```
  Confirmar: 0 errores TS, 0 errores lint, suite COMPLETA verde (incluido
  `compose.test.ts` y `orchestrate.test.ts` sin regresión).

### Verificación Incremental

| Wave | Verificación al completar |
|------|--------------------------|
| W1 | `npm run format` + `npm run lint` + `npx tsc --noEmit` (0 errores) |
| W2 | `npm test src/routes/compose.fee.test.ts` (8 tests verdes) |
| W3 | format → lint → typecheck → `npm test` completo sin regresión |

---

## Out of Scope

> Lo que Dev NO debe tocar bajo ninguna circunstancia.

- `src/services/compose.ts` — NO se modifica (el cobro vive en el route, no en el service).
- `src/services/fee-charge.ts` — NO se modifica (se reutiliza).
- `src/services/orchestrate.ts` — NO se toca.
- `src/services/receipt.ts` — NO se toca.
- `src/types/index.ts` / `src/types/receipt.ts` — NO se tocan (no se agregan campos).
- `supabase/migrations/` — NO se agrega migración.
- NO exponer `protocolFeeUsdc`/`feeChargeTxHash` en el response (DT-5 / CD-4).
- NO agregar dashboard/analytics.
- NO "mejorar" código adyacente del route (preHandlers WKH-59/125, etc.).
- NO agregar skip especial para `totalCostUsdc === 0` (se procesa fee $0,
  consistente con orchestrate — R-2 del SDD).

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala al Architect.**
> No inventar. No asumir. No improvisar.

Situaciones de escalation:
- `chargeProtocolFee` / `getProtocolFeeRate` / `receiptService.emit` tienen una
  firma distinta a la documentada en §Exemplar 1.
- `request.a2aKeyRow` o `request.resolvedChainId` no existen como decoration del
  `FastifyRequest` (deberían — verificados en `src/types/index.ts` /
  `src/middleware/a2a-key.ts`).
- biome bloquea por `feeChargeError`/`feeChargeTxHash` no leídas y no hay forma
  limpia de satisfacer el linter sin tocar el comportamiento.
- Cualquier AC requiere tocar un archivo fuera de la tabla "Files to Modify/Create".

---

*Story File generado por NexusAgil — F2.5 — WKH-118*
