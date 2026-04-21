# SDD — WKH-44 · 1% Protocol Fee Real Charge

**Work item**: `doc/sdd/044-wkh-44-protocol-fee/work-item.md`
**Branch**: `feat/044-wkh-44-protocol-fee-real-charge`
**Modo**: QUALITY · SDD full · Estimación M
**Fecha SDD**: 2026-04-20

---

## 1. Resumen técnico

La HU convierte el "display-only" `protocolFeeUsdc` de `orchestrate.ts:389-391` en un cobro real on-chain:

1. El rate pasa de **constante literal** (`PROTOCOL_FEE_RATE = 0.01` en `orchestrate.ts:26`) a **lectura por request** desde `process.env.PROTOCOL_FEE_RATE`, con safety-guards de rango y NaN (AC-9/AC-10, CD-G).
2. El fee se **deduce del budget antes** de invocar `composeService.compose(...)` — el compose ve `maxBudget = budget − fee` (AC-1).
3. El `protocolFeeUsdc` del `OrchestrateResult` pasa a representar el **monto real cobrado** = `budget * rate` (no `pipeline.totalCostUsdc * rate` como hoy) (AC-3, DT-3).
4. **Post-compose**, si `pipeline.success === true` **y** `WASIAI_PROTOCOL_FEE_WALLET` está seteado, se dispara un transfer EIP-712 via `paymentAdapter.sign() + settle()` (AC-2, DT-1/DT-2).
5. El transfer es **best-effort**: cualquier fallo se registra en `OrchestrateResult.feeChargeError` y se loguea a `console.error`, pero NO interrumpe la respuesta 200 (AC-6, CD-4).
6. **Idempotencia**: antes de disparar el transfer, el servicio verifica contra una tabla dedicada `a2a_protocol_fees` (unique constraint en `orchestration_id`); si ya existe un registro "charged" o "pending", no se vuelve a cobrar (AC-8, CD-6, DT-6).
7. Toda la lógica de cobro vive en un helper aislado `src/services/fee-charge.ts` para mockeo trivial en tests (DT-4, CD-A).

El paymentAdapter **no** se modifica (CD-5). La firma pública de `PaymentAdapter` en `src/adapters/types.ts:78-91` queda intacta.

---

## 2. Context Map — archivos leídos + patrones extraídos

| Archivo | Líneas relevantes | Por qué | Patrón extraído |
|---------|-------------------|---------|-----------------|
| `src/services/orchestrate.ts` | 1-424 | Punto de integración principal | Constante literal `PROTOCOL_FEE_RATE = 0.01` en L26; cálculo display-only L389-391; pasa `maxBudget: budget` a `composeService.compose(...)` en L384; `OrchestrateResult` se arma en L414-421. Tiene dos early-returns (no-agents L243-256, no-budget L342-355) que también deben propagar `protocolFeeUsdc=0`. |
| `src/services/compose.ts` | 36-153, 164-224 | Consumidor del `maxBudget`; patrón de `paymentAdapter.sign() + settle()` | Operador firma EIP-712 con SU propia wallet vía `OPERATOR_PRIVATE_KEY` (L191-197) y la settle va al facilitator Pieverse (L209-218). El operator paga de su balance. |
| `src/services/orchestrate.test.ts` | 1-363 | Estructura de tests (mocks de `discoveryService`, `composeService`, `eventService`, `@anthropic-ai/sdk`) | Pattern: `vi.mock('./compose.js', ...)` + `vi.mocked(composeService.compose).mockResolvedValue(...)`. Tests T-1..T-10 existentes deben seguir pasando (AC-4). |
| `src/adapters/kite-ozone/payment.ts` | 110-275 | Firma `sign()` y `settle()` que se reutilizan | `sign({to, value, timeoutSeconds?})` retorna `{xPaymentHeader, paymentRequest}`; `settle({authorization, signature, network})` retorna `{txHash, success, error?}`. `value` es string wei; `to` es `0x${string}`. |
| `src/adapters/types.ts` | 78-91 | Interfaz `PaymentAdapter` — NO tocar (CD-5) | Contract: `sign + settle + verify + quote + getScheme + getNetwork + getToken + getMaxTimeoutSeconds + getMerchantName + name + chainId + supportedTokens`. |
| `src/adapters/registry.ts` | 37-41 | Accesor singleton `getPaymentAdapter()` | Siempre usar `getPaymentAdapter()` — tirará si `initAdapters()` no corrió; para tests se mockea el módulo entero. |
| `src/adapters/__tests__/payment.contract.test.ts` | 1-220 | Patrón de mock del adapter en tests | `vi.mock('../../adapters/kite-ozone/payment.js', ...)` + `_resetWalletClient()` en beforeEach; `mockFetch` global para Pieverse. |
| `src/services/compose.test.ts` | 12-17 | Patrón para mockear `getPaymentAdapter()` directamente | `vi.mock('../adapters/registry.js', () => ({ getPaymentAdapter: () => ({ sign: mockSign, settle: mockSettle }) }))`. **Este es el patrón que adopta `fee-charge.test.ts`**. |
| `src/types/index.ts` | 211-219 | `OrchestrateResult` actual | Fields: `orchestrationId`, `answer`, `reasoning`, `pipeline`, `consideredAgents`, `protocolFeeUsdc`, `attestationTxHash?`. Se agrega `feeChargeError?: string` y (opcional) `feeChargeTxHash?: string`. |
| `src/routes/orchestrate.ts` | 78-81 | Handler del POST /orchestrate | Hace `reply.send({ kiteTxHash, ...result })` — el spread expone automáticamente cualquier campo nuevo del result (CD-C, confirma Scope OUT). |
| `src/services/event.ts` | 47-85 | Pattern para tabla Supabase (`a2a_events`) | `supabase.from('a2a_events').insert(row).select().single()`. Row usa snake_case, dominio usa camelCase. Errores retornan `{data, error}`, lanzar con `throw new Error(...)` si `error`. |
| `src/services/task.ts` | 40-78 | Pattern CRUD Supabase | Tabla `tasks` (sin prefijo a2a_). Migraciones viven en `supabase/migrations/*.sql`. |
| `src/lib/supabase.ts` | 1-39 | Singleton client | `import { supabase } from '../lib/supabase.js'`. Usa `SUPABASE_SERVICE_KEY` (bypasea RLS). |
| `supabase/migrations/20260403180000_tasks.sql` | 1-43 | Pattern de migration | `CREATE TABLE IF NOT EXISTS`, `gen_random_uuid()` DEFAULT, `TIMESTAMPTZ NOT NULL DEFAULT NOW()`, trigger `trigger_set_updated_at()`. |
| `supabase/migrations/20260404200000_events.sql` | 1-32 | Pattern de tabla con prefijo `a2a_` | Confirmo que prefijo `a2a_` se usa para tablas nuevas del servicio A2A (events, protocol_fees). |
| `src/middleware/a2a-key.ts` | 1-80 | Middleware de auth que corre antes del handler | Cuando cliente paga via x402, los KXUSD van a `KITE_WALLET_ADDRESS` (merchant wallet del gateway). **No al operator**. Confirmado en `requirePayment()` (ver sección 5, M-4). |
| `.env.example` | 44-74 | Convenciones de env vars Kite/x402 | Valores hardcodeados con comments explicativos; defaults en código; vars opcionales explícitas. |
| `doc/sdd/WKH-MCP-X402/auto-blindaje.md` | L4-32, L76-88 | Auto-blindaje histórico | **CD-heredado**: usar `import { Ajv } from 'ajv'` (named export) bajo Node16 ESM; **tipado explícito de `let` antes del try/catch** (ej `let signResult: SignResult;`) para evitar `noImplicitAnyLet` de biome. |
| `doc/sdd/043-wkh-sec-01/auto-blindaje.md` | L4-7 | Auto-blindaje histórico | **CD-heredado**: cuando se agrega `{preHandler}` en rutas Fastify, tipar generics en `fastify.post<{Body:...}>(...)` — pero WKH-44 no modifica rutas, así que no aplica directo. |

---

## 3. Decisiones técnicas (DT)

### DT-1 (heredada del work item) — Momento del cobro: post-compose, solo si `pipeline.success=true`
Resuelto en work item. Confirmado: el budget se reduce antes del compose (`maxBudget = budget − fee`), pero el transfer on-chain ocurre post-compose y solo bajo éxito.

### DT-2 (heredada) — Mecanismo: `paymentAdapter.sign() + settle()`
Confirmado que la firma del adapter no requiere cambios. `sign({to: WASIAI_PROTOCOL_FEE_WALLET, value: feeWei})` + `settle({authorization, signature, network})` devuelve `txHash`.

### DT-3 (heredada) — Fee sobre `budget` (no sobre `totalCostUsdc`)
`feeUsdc = budget * rate`. Predecible para el usuario. Resuelto por humano (M-1).

### DT-4 (heredada) — Aislar en `src/services/fee-charge.ts`
Helper exporta función pura `chargeProtocolFee(params): Promise<FeeChargeResult>`. Se mockea en `orchestrate.test.ts`.

### DT-5 (heredada) — Rate desde env var, por request
`getProtocolFeeRate()` lee `process.env.PROTOCOL_FEE_RATE` **cada vez que se invoca**. No hay cache en memoria. Validación: `Number.isFinite(n) && n >= 0 && n <= 0.10`. Fuera de rango → `console.error` + fallback `0.01`. Default si unset → `0.01` (sin error).

### DT-6 **(nueva) — Mecanismo de idempotencia: tabla dedicada `a2a_protocol_fees`**
**Decisión**: crear nueva tabla `a2a_protocol_fees` con unique constraint en `orchestration_id`. NO Redis, NO reutilizar `tasks`.

**Alternativas consideradas**:
| Opción | Pros | Contras | Veredicto |
|--------|------|---------|-----------|
| (a) Redis SET + TTL | Latencia baja, simple | Redis NO está implementado hoy (WKH-47 pendiente). Introducirlo en WKH-44 extiende el scope. | ❌ Rechazada |
| (b) Columna `fee_charged_at` en tabla `tasks` | Reutiliza infra existente | `tasks` es A2A-protocol (contextId, status A2A); mezclar billing con task-state acopla dominios. `orchestrationId` NO tiene row en `tasks` necesariamente (orchestrate no crea una task explícita). | ❌ Rechazada |
| (c) **Tabla dedicada `a2a_protocol_fees`** con unique `orchestration_id` | Separación de dominios, auditable, permite estados `pending/charged/failed`, guarda `tx_hash`, DB-level unique constraint garantiza idempotencia atómica. | Una migration más. | ✅ **Elegida** |

**Esquema** (ver §5.3):
```sql
CREATE TABLE IF NOT EXISTS a2a_protocol_fees (
  orchestration_id  UUID        PRIMARY KEY,   -- unique constraint natural
  budget_usdc       NUMERIC(18,6) NOT NULL,
  fee_rate          NUMERIC(6,4)  NOT NULL,    -- ej 0.01
  fee_usdc          NUMERIC(18,6) NOT NULL,
  fee_wallet        TEXT          NOT NULL,    -- WASIAI_PROTOCOL_FEE_WALLET snapshot
  status            TEXT          NOT NULL CHECK (status IN ('pending','charged','failed','skipped')),
  tx_hash           TEXT,
  error_message     TEXT,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_a2a_protocol_fees_status ON a2a_protocol_fees(status);
CREATE INDEX idx_a2a_protocol_fees_created ON a2a_protocol_fees(created_at DESC);
```

**Flujo idempotente** en `fee-charge.ts::chargeProtocolFee`:
1. `SELECT status FROM a2a_protocol_fees WHERE orchestration_id = :id` — si existe:
   - `status='charged'` → retornar `{already: true, txHash}` (idempotent no-op).
   - `status='pending'` → retornar `{already: true, inProgress: true}` (evita race en retries concurrentes).
   - `status='failed'` → permitir retry (AC-8 nota: idempotencia previene **double-charge**, no prohíbe retry de failed).
2. `INSERT ... ON CONFLICT (orchestration_id) DO NOTHING` con status=`pending` — si conflict → otro request ya empezó, abortar.
3. Ejecutar `sign() + settle()`.
4. `UPDATE ... SET status='charged', tx_hash=..., updated_at=NOW()` si éxito, o `status='failed', error_message=...` si falla.

El paso 2 es la barrera de carreras (concurrency-safe a nivel DB). El unique constraint en PK hace el INSERT idempotent atómicamente.

### DT-7 **(nueva) — Flujo de fondos: operator paga el fee de SU balance; cliente paga la merchant wallet del gateway**

Verificado leyendo código:
- **Cliente → Gateway**: cuando el cliente invoca `POST /orchestrate`, el middleware `requirePaymentOrA2AKey` (`src/middleware/a2a-key.ts:1-80`) o bien usa un A2A key (no requiere pago x402) o bien exige un pago x402 via header `PAYMENT-SIGNATURE`. Ese pago va a **`KITE_WALLET_ADDRESS`** (ver `.env.example:47`, es la "Wallet address on Kite testnet que recibe los pagos"). NO va al operator.
- **Gateway → Agent**: en `composeService.invokeAgent` (`src/services/compose.ts:188-197`), el operator firma EIP-712 con **`OPERATOR_PRIVATE_KEY`** (su wallet propia) para pagar al agent (el `payTo` es `agent.metadata.payTo`). El operator paga de su balance de KXUSD.
- **Gateway → Protocol Fee Wallet (nuevo en WKH-44)**: análogamente, el operator firmará EIP-712 con **`OPERATOR_PRIVATE_KEY`** para transferir el fee a `WASIAI_PROTOCOL_FEE_WALLET`. El operator paga de su balance.

**Implicación operacional**: el operator debe tener saldo suficiente de KXUSD para cubrir:
1. Agent invocations (ya cubierto por lógica existente)
2. Protocol fee transfers (nuevo)

Este modelo es consistente con la arquitectura actual donde el gateway actúa como "pagador central" que recibe del cliente (via merchant wallet) y paga a los destinatarios (agents, protocol fee wallet) desde la wallet del operator. No requiere 2FA del cliente ni firmas adicionales del lado usuario.

**Documentar en `.env.example`**:
```bash
# Protocol Fee (WKH-44) — el gateway cobra un % del budget de /orchestrate como fee
# del protocolo. El operator (OPERATOR_PRIVATE_KEY) firma EIP-712 y transfiere KXUSD
# desde SU wallet hacia WASIAI_PROTOCOL_FEE_WALLET. Si la var está vacía, el fee
# NO se transfiere (log warn, orchestrate continúa).
# IMPORTANTE: la wallet del operator debe tener saldo suficiente de KXUSD.
WASIAI_PROTOCOL_FEE_WALLET=

# Rate del fee en decimal (default 0.01 = 1%). Rango válido [0.0, 0.10].
# Fuera de rango o no parseable → fallback 0.01 con console.error.
# Se lee por request; un restart de Railway basta para aplicar un nuevo valor.
PROTOCOL_FEE_RATE=0.01
```

### DT-8 — Formato del monto en wei
KXUSD tiene **18 decimals** (ver `src/adapters/kite-ozone/payment.ts:118` `decimals: 18`, y `src/services/compose.ts:188-190` usa `BigInt(Math.round(priceUsdc * 1e6)) * BigInt(1e12)` para convertir USDC a wei).

**Formato adoptado en `fee-charge.ts`**:
```ts
// feeUsdc es number (ej 0.01). Queremos string wei.
// Multiplicar por 1e6 (micro-USDC) con Math.round, luego * 1e12 para 18-decimals.
// Patrón idéntico a compose.ts:188-190 para consistencia.
const feeWei = String(BigInt(Math.round(feeUsdc * 1e6)) * BigInt(1e12));
```

### DT-9 — Propagación del `feeChargeError` al response
Modificar el tipo `OrchestrateResult` (un solo lugar) agregando `feeChargeError?: string` y `feeChargeTxHash?: string` (este último facilita debugging y audit en F4). El handler `src/routes/orchestrate.ts:81` hace `reply.send({ kiteTxHash, ...result })` — el spread expone automáticamente los campos nuevos sin cambios al handler. Confirma Scope OUT del work item.

### DT-10 — Safety guard AC-7 ubicación
La guarda `if (fee > budget) throw new Error(...)` se evalúa al inicio de `orchestrateService.orchestrate()`, **antes** de `discoveryService.discover`. Razón: si el rate está corrupto (ej env mal seteado a `1.5`), queremos cortar sin gastar discovery. El error propaga al errorBoundary de la ruta vía el patrón existente en L283 (`throw new Error(...)`). El handler `routes/orchestrate.ts:82-94` adjunta `orchestrationId` al error, y el errorBoundary global traduce a 400 (requiere confirmar en CR que el errorBoundary mapea `Error` → 400 cuando el mensaje empieza con `Invalid protocol fee rate`... si no, usar una subclass de Error específica).

**Decisión definitiva**: lanzar `const err = new Error('Protocol fee exceeds budget: ...'); (err as any).statusCode = 400; throw err;` — Fastify respeta `statusCode` en errores crudos. NO usar `(err as any)` (viola CD-1): se define un tipo local `class ProtocolFeeError extends Error { statusCode = 400; }` en `fee-charge.ts`.

### DT-11 — Early-returns de `orchestrate.ts` también cargan el rate
Los dos early-returns (no-agents L243-256, no-budget L342-355) actualmente devuelven `protocolFeeUsdc: 0`. Se mantiene ese valor (el orchestrate no ejecutó nada, no hay cobro), pero **antes de esos returns** se debe haber validado `fee <= budget` (AC-7) — si el rate está corrupto, fallamos rápido sin importar si había agents o no.

---

## 4. Constraint Directives (CD)

### Heredadas del work item

- **CD-1**: PROHIBIDO `any` explícito. Todo tipado estricto (`tsconfig.json` strict + biome `noExplicitAny`).
- **CD-2**: `WASIAI_PROTOCOL_FEE_WALLET` **opcional**. Sin él → skip silencioso con `console.warn('[FeeCharge] WASIAI_PROTOCOL_FEE_WALLET not set, skipping fee transfer')`.
- **CD-3**: PROHIBIDO `feeUsdc > budget`. Si ocurre, lanzar `ProtocolFeeError` con `statusCode=400` antes de discovery.
- **CD-4**: PROHIBIDO que el fallo del transfer rompa el orchestrate. Response HTTP 200; `feeChargeError` en el body.
- **CD-5**: PROHIBIDO modificar `src/adapters/types.ts::PaymentAdapter`.
- **CD-6**: OBLIGATORIO idempotencia — implementada via `a2a_protocol_fees.orchestration_id` unique PK (DT-6).
- **CD-7**: PROHIBIDO `ethers.js`. Solo `viem` (ya cumplido porque reusamos el paymentAdapter existente).
- **CD-8**: OBLIGATORIO agregar `WASIAI_PROTOCOL_FEE_WALLET=` y `PROTOCOL_FEE_RATE=0.01` en `.env.example` con los comments de DT-7.
- **CD-G** (crítica): PROHIBIDO `PROTOCOL_FEE_RATE` como constante literal en módulo. OBLIGATORIO leer `process.env.PROTOCOL_FEE_RATE` **dentro de la función** que la usa (no a nivel top-level del módulo). Razón: permitir cambiar el valor via Railway env restart sin redeploy (AC-9/AC-10).

### Nuevas del SDD

- **CD-A**: OBLIGATORIO exportar `getProtocolFeeRate(): number` desde `src/services/fee-charge.ts` (o un módulo helper). Esta función es la ÚNICA autorizada para leer `process.env.PROTOCOL_FEE_RATE`. Toda la lógica de orchestrate la consume. No duplicar la lectura en múltiples lugares.

- **CD-B**: OBLIGATORIO que `chargeProtocolFee()` sea **fire-and-forget compatible**: retorna `Promise<FeeChargeResult>` que jamás rechaza. Internamente captura todos los errores (network, Pieverse, DB) y los reporta en `FeeChargeResult.status='failed' + error`. El caller (`orchestrate.ts`) hace `const result = await chargeProtocolFee(...)` y no necesita try/catch.

- **CD-C**: OBLIGATORIO que **ningún test** invoque `paymentAdapter` real ni haga fetch a Pieverse. Todos los tests de `fee-charge.test.ts` mockean `getPaymentAdapter` con `vi.mock('../adapters/registry.js', ...)` (patrón de `src/services/compose.test.ts:15-17`).

- **CD-D**: OBLIGATORIO que `orchestrate.ts` SIEMPRE devuelva `protocolFeeUsdc` = `budget * rate` (monto que se intentó cobrar o se skipeó), no cero cuando skipea. El cero solo se devuelve en los early-returns (no-agents, no-budget) porque ahí el orchestrate NO ejecutó el pipeline. El cálculo debe coincidir con AC-3.

- **CD-E**: OBLIGATORIO `Number.isFinite()` check en `getProtocolFeeRate()` antes de comparar rangos. `parseFloat("abc")` retorna `NaN`, y `NaN > 0.10` es `false` (NaN es falso en comparaciones), así que una guarda ingenua `if (rate < 0 || rate > 0.10)` dejaría pasar NaN. Referencia de auto-blindaje: WKH-MCP-X402#MNR-1 (mismo patrón con `parseInt`).

- **CD-F**: OBLIGATORIO tipado explícito de `let` declarados antes de try/catch con asignación dentro. Ej: `let signResult: SignResult;` NO `let signResult;`. Referencia: auto-blindaje WKH-MCP-X402 Wave 3 (biome `noImplicitAnyLet`).

- **CD-H**: PROHIBIDO alterar los tests existentes T-1..T-10 de `orchestrate.test.ts` salvo para actualizar T-2 y T-7 que checan `protocolFeeUsdc` (cambia la semántica: pasa de `totalCostUsdc * 0.01` a `budget * 0.01`). Los cambios deben ser mínimos y documentados inline.

- **CD-I**: OBLIGATORIO que la migration `20260420XXXXXX_a2a_protocol_fees.sql` use el mismo pattern que `20260404200000_events.sql` (IF NOT EXISTS, gen_random_uuid, TIMESTAMPTZ DEFAULT NOW, índices separados, trigger updated_at si hace falta).

- **CD-J**: PROHIBIDO asumir que `orchestrationId` ya existe como row en `tasks` o cualquier otra tabla. La idempotency check en `a2a_protocol_fees` es self-contained — el primer request crea el row, no hace FK a nada.

---

## 5. Waves de implementación

### Wave 1 — Fundaciones (serial, sin lógica de negocio)

**Archivos**:
- `src/services/fee-charge.ts` (nuevo) — **solo** skeleton: `getProtocolFeeRate()`, tipos `FeeChargeParams`, `FeeChargeResult`, `ProtocolFeeError`. SIN lógica de cobro todavía.
- `src/types/index.ts` (modificar L211-219) — agregar `feeChargeError?: string; feeChargeTxHash?: string;` a `OrchestrateResult`.
- `.env.example` — agregar `WASIAI_PROTOCOL_FEE_WALLET=` y `PROTOCOL_FEE_RATE=0.01` con comments de DT-7.
- `supabase/migrations/20260420XXXXXX_a2a_protocol_fees.sql` (nuevo) — tabla DT-6.
- `src/services/fee-charge.test.ts` (nuevo) — tests **solo** de `getProtocolFeeRate()` (AC-9: parseo, rango, default, NaN).

**Entregables de Wave 1**:
- `getProtocolFeeRate()` testeado exhaustivamente (unset, valid, NaN, negativo, >0.10, string raro).
- Tipo `OrchestrateResult` extendido (compila pero nada lo popula todavía).
- Migration corre sin errores (aplicar en Supabase dev).

**Mergeable**: sí. No toca lógica de negocio; `orchestrate.ts` sigue idéntico.
**Tests suma**: +~8 tests de `getProtocolFeeRate`.

### Wave 2 — Fee charge helper con idempotencia

**Archivos**:
- `src/services/fee-charge.ts` — implementar `chargeProtocolFee(params): Promise<FeeChargeResult>`:
  - Params: `{ orchestrationId: string; budgetUsdc: number; feeRate: number; }`
  - Lee `WASIAI_PROTOCOL_FEE_WALLET` de env; si vacío → return `{status: 'skipped', reason: 'WALLET_UNSET'}` sin tocar DB.
  - Query idempotency `a2a_protocol_fees` WHERE orchestration_id.
  - INSERT con `status='pending'` (ON CONFLICT DO NOTHING).
  - `getPaymentAdapter().sign({to, value: feeWei})` → `settle(...)`.
  - UPDATE a `charged` + `tx_hash`, o `failed` + `error_message`.
  - Retorna `{status, feeUsdc, txHash?, error?}`. **Jamás rechaza** (CD-B).
- `src/services/fee-charge.test.ts` — agregar tests:
  - skip cuando wallet unset
  - happy path: sign+settle exitosos, row `charged`, tx_hash propagado
  - idempotent: segunda llamada retorna `{already: true, txHash}` sin invocar sign
  - race condition: 2 llamadas concurrentes → solo una invoca sign (via unique PK)
  - settle falla → row `failed`, error propagado
  - sign falla → row `failed`, error propagado
  - DB falla → log error, retorna `{status: 'failed', error: 'DB_ERROR'}` (no rompe caller)

**Mergeable**: sí. `chargeProtocolFee` existe y es testeado pero **no se invoca desde orchestrate** aún.
**Tests suma**: +~7 tests de `chargeProtocolFee`.

### Wave 3 — Integración en orchestrate + migración del rate

**Archivos**:
- `src/services/orchestrate.ts`:
  - **Eliminar** `const PROTOCOL_FEE_RATE = 0.01;` de L26 (CD-G).
  - Al inicio de `orchestrate()`: `const feeRate = getProtocolFeeRate();` y `const feeUsdc = Number((budget * feeRate).toFixed(6));`.
  - Safety guard (DT-10): `if (feeUsdc > budget) throw new ProtocolFeeError(...)`.
  - Reemplazar L384 `maxBudget: budget` por `maxBudget: budget - feeUsdc`.
  - Reemplazar L389-391 (display-only fee) por `protocolFeeUsdc = feeUsdc` (ya calculado arriba).
  - Post-compose (después de L391, antes de L414): si `pipeline.success`, `await chargeProtocolFee({orchestrationId, budgetUsdc: budget, feeRate})` y popular `feeChargeError`/`feeChargeTxHash` del result.
  - Early-returns L243-256 y L342-355: mantener `protocolFeeUsdc: 0` (no se ejecutó pipeline) pero **evaluar la safety guard antes** para capturar rates corruptos.
- `src/services/orchestrate.test.ts`:
  - Actualizar T-2 y T-7 para la nueva semántica (`budget * 0.01` en vez de `totalCostUsdc * 0.01`).
  - Agregar tests nuevos T-11..T-20 (ver §6).
  - Mock `fee-charge.ts`: `vi.mock('./fee-charge.js', ...)` con `chargeProtocolFee` y `getProtocolFeeRate` mockeables.

**Mergeable**: sí — al merge, el feature está **completo**. Si `WASIAI_PROTOCOL_FEE_WALLET` queda vacío en Railway, no hay cambio de comportamiento observable (skip silencioso). Cuando el operator lo setee, el cobro empieza.

**Tests suma**: +~10 tests nuevos en `orchestrate.test.ts`.

---

## 6. Plan de tests (mapeo AC ↔ test)

### Tests nuevos en `src/services/fee-charge.test.ts`

| # | AC cubierto | Test | Qué mockear |
|---|-------------|------|-------------|
| FT-1 | AC-9 | `getProtocolFeeRate()` retorna 0.01 si `PROTOCOL_FEE_RATE` unset | `delete process.env.PROTOCOL_FEE_RATE` |
| FT-2 | AC-9 | retorna 0.05 si env var = "0.05" | `process.env.PROTOCOL_FEE_RATE = '0.05'` |
| FT-3 | AC-9 | retorna 0.01 + console.error si env var = "abc" (NaN) | stub `console.error` |
| FT-4 | AC-9 | retorna 0.01 + console.error si env var = "-0.01" (negativo) | stub `console.error` |
| FT-5 | AC-9 | retorna 0.01 + console.error si env var = "0.5" (>0.10) | stub `console.error` |
| FT-6 | AC-10 | cada llamada re-lee env (no cache) — setear a 0.02, call, setear a 0.03, call, ambos reflejan | — |
| FT-7 | AC-9 boundary | retorna 0.10 si env var = "0.10" (borde superior permitido) | — |
| FT-8 | AC-9 boundary | retorna 0.0 si env var = "0.0" (borde inferior permitido) | — |
| FT-9 | AC-5, CD-2 | `chargeProtocolFee` retorna `{status:'skipped'}` si `WASIAI_PROTOCOL_FEE_WALLET` unset, sin tocar DB | `delete process.env.WASIAI_PROTOCOL_FEE_WALLET`, stub `console.warn` |
| FT-10 | AC-2 happy path | sign+settle exitosos → row `charged` en DB, retorna `{status:'charged', txHash:'0xABC'}` | mock `getPaymentAdapter`, mock `supabase` |
| FT-11 | AC-8 idempotency | segunda llamada retorna `{already:true, txHash}` sin invocar `sign` | primera llamada inserta row `charged`; verificar `mockSign` NOT called en 2da |
| FT-12 | AC-8 race | INSERT falla con conflict → retorna `{already:true, inProgress:true}` sin invocar `sign` | mock supabase.insert retornando error PostgreSQL unique violation |
| FT-13 | AC-6 settle fail | settle retorna `success:false` → row `failed`, retorna `{status:'failed', error:...}` | mock `mockSettle.mockResolvedValue({success:false, error:'net'})` |
| FT-14 | AC-6 sign fail | sign lanza → captured, row `failed`, retorna `{status:'failed', error:...}` | `mockSign.mockRejectedValue(new Error('sig'))` |
| FT-15 | CD-B never rejects | DB error → retorna `{status:'failed'}`, NO rechaza la promise | mock supabase retornando error |
| FT-16 | DT-8 wei conversion | fee=0.01 USDC → feeWei = "10000000000000000" (1e16 wei, 18 decimals) | verificar `mockSign.mock.calls[0][0].value` |

### Tests nuevos/actualizados en `src/services/orchestrate.test.ts`

| # | AC cubierto | Test | Qué mockear |
|---|-------------|------|-------------|
| T-2 (actualizado) | AC-3 | `protocolFeeUsdc` = `budget * 0.01` (antes era `totalCostUsdc * 0.01`) | — |
| T-7 (actualizado) | AC-3 | protocolFeeUsdc recalculado con budget=20 → 0.2 (era 0.1 sobre totalCost=10) | — |
| T-11 | AC-1 | `composeService.compose` recibe `maxBudget = budget - feeUsdc` (budget=1.00, fee=0.01 → maxBudget=0.99) | spy `composeService.compose` |
| T-12 | AC-2 | si `pipeline.success=true` + wallet seteado → `chargeProtocolFee` invocado 1x con params correctos | `vi.mock('./fee-charge.js')`, verificar `mockChargeFee` |
| T-13 | AC-2 (no charge on fail) | si `pipeline.success=false` → `chargeProtocolFee` NO invocado | `composeService.compose` retorna `success:false` |
| T-14 | AC-5 | `feeChargeError` NO presente + `feeChargeTxHash` NO presente cuando wallet unset (status skipped) | `mockChargeFee.mockResolvedValue({status:'skipped'})` |
| T-15 | AC-6 | si `chargeProtocolFee` retorna `{status:'failed', error:'...'}` → result tiene `feeChargeError: string` y status HTTP 200 | `mockChargeFee.mockResolvedValue({status:'failed', error:'net'})` |
| T-16 | AC-7 | budget=1, rate=1.5 (forzado via env) → throw ProtocolFeeError con statusCode=400 antes de discovery | `process.env.PROTOCOL_FEE_RATE='1.5'` (pero nótese CD-E: getProtocolFeeRate lo rechaza y devuelve 0.01; test alternativo: mock `getProtocolFeeRate` para retornar 1.5 y verificar guard) |
| T-17 | AC-8 | 2 llamadas a orchestrate con mismo orchestrationId → chargeProtocolFee invocado 2x pero solo 1 transfer (la 2da retorna `already:true`) | mock `chargeProtocolFee` con fixture idempotent |
| T-18 | AC-10 | cambiar `PROTOCOL_FEE_RATE` entre llamadas refleja en `protocolFeeUsdc` del response | 1a llamada rate=0.01, 2a rate=0.02 |
| T-19 | AC-9 default | `PROTOCOL_FEE_RATE` unset → fee calculado con 0.01 | `delete process.env.PROTOCOL_FEE_RATE` |
| T-20 | CD-D | early-return no-agents sigue devolviendo `protocolFeeUsdc: 0` (no ejecutó pipeline) | `discover.discover` retorna `[]` |

### Regresión baseline (AC-4)
- Ejecutar `pnpm test` después de cada wave. **Debe** pasar 350/350 original + nuevos.
- Si un test histórico rompe (ej contract test de adapter), revertir y ajustar sin tocar fixtures compartidos.

### Tests NO cubiertos (documentar en F4)
- **AC-2 on-chain validation**: bloqueado por WKH-45 (Pieverse `/v2/verify` HTTP 500). Documentar en F4 con evidencia; validar solo vía mock del paymentAdapter.

---

## 7. Exemplars verificados

Todos los paths confirmados con Read/Glob al momento del SDD (2026-04-20):

| Path | Líneas | Confirmado |
|------|--------|-----------|
| `src/services/orchestrate.ts` | L26 (`PROTOCOL_FEE_RATE`), L384 (`maxBudget`), L389-391 (fee compute), L414-421 (result) | ✅ |
| `src/services/orchestrate.test.ts` | L11-45 (mocks), T-2/T-7 (fee asserts) | ✅ |
| `src/services/compose.ts` | L188-197 (`sign()`), L209-218 (`settle()`) | ✅ |
| `src/services/compose.test.ts` | L15-17 (**patrón de mock `getPaymentAdapter`**) | ✅ |
| `src/services/event.ts` | L47-85 (pattern Supabase insert) | ✅ |
| `src/services/task.ts` | L40-78 (pattern Supabase CRUD, tabla `tasks`) | ✅ |
| `src/adapters/types.ts` | L78-91 (interfaz `PaymentAdapter` NO tocar) | ✅ |
| `src/adapters/kite-ozone/payment.ts` | L110-275 (impl) | ✅ |
| `src/adapters/registry.ts` | L37-41 (`getPaymentAdapter`) | ✅ |
| `src/adapters/__tests__/payment.contract.test.ts` | L33-220 (pattern mock adapter) | ✅ |
| `src/types/index.ts` | L211-219 (`OrchestrateResult`) | ✅ |
| `src/routes/orchestrate.ts` | L81 (`reply.send({kiteTxHash, ...result})`) | ✅ |
| `src/lib/supabase.ts` | L38 (export singleton) | ✅ |
| `src/middleware/a2a-key.ts` | L1-80 (middleware de auth) | ✅ |
| `.env.example` | L47 (`KITE_WALLET_ADDRESS`), L86 (`OPERATOR_PRIVATE_KEY`) | ✅ |
| `supabase/migrations/20260403180000_tasks.sql` | L1-43 (pattern migration tabla sin prefijo) | ✅ |
| `supabase/migrations/20260404200000_events.sql` | L1-32 (pattern tabla con prefijo `a2a_`) | ✅ |

---

## 8. Readiness Check

| Item | Estado |
|------|--------|
| Exemplars leídos y verificados | ✅ |
| Decisiones DT-1..DT-5 heredadas confirmadas | ✅ |
| DT-6 idempotencia resuelta (tabla dedicada `a2a_protocol_fees`) | ✅ |
| DT-7 flujo de fondos resuelto (operator paga desde su wallet) | ✅ |
| DT-8..DT-11 nuevas decisiones documentadas | ✅ |
| CDs del work-item heredados | ✅ |
| CDs nuevos del SDD (A-J) definidos | ✅ |
| Waves independientes y mergeables definidas (3 waves) | ✅ |
| Plan de tests cubre AC-1..AC-10 | ✅ |
| Regresión baseline 350/350 contemplada (AC-4) | ✅ |
| `[NEEDS CLARIFICATION]` restantes | ❌ (ninguno — todo resuelto) |
| Auto-blindaje histórico consultado (WKH-MCP-X402, WKH-SEC-01) | ✅ (CD-E, CD-F heredados de WKH-MCP-X402) |
| Scope OUT respetado (no tocar `PaymentAdapter` ni router handler) | ✅ |

**Veredicto**: **READY FOR SPEC_APPROVED**. No hay TBDs; todas las decisiones técnicas están documentadas con justificación y referencia a código real. El Dev puede empezar Wave 1 inmediatamente tras el gate.

---

## 9. Riesgos conocidos + mitigaciones

| Riesgo | Mitigación |
|--------|-----------|
| Operator sin saldo de KXUSD → settle falla | CD-4 (best-effort) lo maneja: row `failed`, `feeChargeError` en response, 200 OK. Operator debe monitorear balance. Fuera de scope de WKH-44 documentar alerting. |
| Pieverse `/v2/settle` HTTP 500 (análogo a WKH-45) | Mismo patrón: row `failed`, `feeChargeError`, 200 OK. F4 documenta la limitación. |
| Race condition en idempotency | Unique PK en `a2a_protocol_fees.orchestration_id` garantiza atomicidad a nivel DB (PostgreSQL ACID). El INSERT ON CONFLICT es la barrera. |
| Rate corrupto en Railway (ej "0.5") | CD-E + AC-9: `getProtocolFeeRate()` rechaza y usa default 0.01, loguea error. No se propaga fee mal calculado. |
| Migration no aplicada en Railway antes del deploy | DevOps checklist: correr migration antes de merge a main (estándar del proyecto, `supabase db push`). F4 verifica. |
| Tests históricos T-2/T-7 rompen | Modificación mínima documentada inline; CD-H lo autoriza explícitamente. |
| `statusCode` en Error no respetado por errorBoundary global | DT-10: definir `ProtocolFeeError` class con `statusCode = 400`. Si el errorBoundary no lo respeta, F3 ajusta; Dev verifica con test T-16. |
