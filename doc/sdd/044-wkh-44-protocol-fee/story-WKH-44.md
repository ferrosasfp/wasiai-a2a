# Story File — WKH-44 · 1% Protocol Fee Real Charge

> **Contrato self-contained para el Dev (F3).** Esta es la ÚNICA fuente de verdad para la implementación.
> Si algo NO está acá, NO se hace. Si encontrás ambigüedad, parar y escalar al orquestador — NO inventar.

---

## 0. Cabecera

| Campo | Valor |
|-------|-------|
| HU | **WKH-44** · 1% Protocol Fee Real Charge |
| Branch | `feat/044-wkh-44-protocol-fee-real-charge` |
| Base branch | `main` |
| Sizing | **QUALITY / M** (SDD full) |
| Pipeline | F0-F1 → F2 → **F2.5** → **F3** → AR → CR → F4 → DONE |
| Fecha Story File | 2026-04-20 |
| SDD aprobado | `doc/sdd/044-wkh-44-protocol-fee/sdd.md` |
| Work item | `doc/sdd/044-wkh-44-protocol-fee/work-item.md` |

---

## 1. Objetivo (3-5 líneas)

Convertir el `protocolFeeUsdc` "display-only" en `orchestrate.ts:389-391` en un cobro real on-chain.
El fee (1% por defecto) se **deduce del budget antes** del compose (el agente ve `maxBudget = budget − fee`) y
**post-compose** se dispara un transfer EIP-712 (`paymentAdapter.sign()` + `settle()`) hacia
`WASIAI_PROTOCOL_FEE_WALLET`. El transfer es **best-effort**: cualquier fallo se reporta en
`OrchestrateResult.feeChargeError` pero NO rompe la respuesta 200. El rate pasa de constante literal
a lectura por request desde `process.env.PROTOCOL_FEE_RATE`. Idempotencia vía tabla dedicada
`a2a_protocol_fees` con PK natural en `orchestration_id`.

---

## 2. Pre-requisitos de ambiente

- [ ] Node.js **20+** instalado (`node --version` → `v20.x.x` o superior).
- [ ] Dependencias al día (`npm install` ejecutado sin errores).
- [ ] Branch creada desde `main` actualizado (`git checkout main && git pull && git checkout -b feat/044-wkh-44-protocol-fee-real-charge`).
- [ ] Acceso a Supabase dev para aplicar migration (`.env` con `SUPABASE_URL` y `SUPABASE_SERVICE_KEY` del entorno dev, o `supabase db push` configurado).
- [ ] Tests baseline verdes en `main`: `npm test` → 350+ passing antes de empezar.
- [ ] Lectura **obligatoria** del SDD completo (`doc/sdd/044-wkh-44-protocol-fee/sdd.md`) y del work-item.

---

## 3. Scope IN / OUT (copiado del work-item + precisiones del SDD)

### Scope IN (archivos a tocar)

| Archivo | Acción | Wave |
|---------|--------|------|
| `src/services/fee-charge.ts` | **NUEVO** — helper aislado (`getProtocolFeeRate`, `chargeProtocolFee`, tipos, `ProtocolFeeError`) | W1 (skeleton) + W2 (impl) |
| `src/services/fee-charge.test.ts` | **NUEVO** — tests unitarios del helper (FT-1..FT-16) | W1 + W2 |
| `src/types/index.ts` | **MODIFICAR** L211-219 — agregar `feeChargeError?: string;` y `feeChargeTxHash?: string;` a `OrchestrateResult` | W1 |
| `.env.example` | **MODIFICAR** — agregar `WASIAI_PROTOCOL_FEE_WALLET=` y `PROTOCOL_FEE_RATE=0.01` con comments (DT-7) | W1 |
| `supabase/migrations/20260420XXXXXX_a2a_protocol_fees.sql` | **NUEVO** — tabla con PK en `orchestration_id`, status enum, índices, trigger `updated_at` | W1 |
| `src/services/orchestrate.ts` | **MODIFICAR** — eliminar `PROTOCOL_FEE_RATE` literal (L26), usar `getProtocolFeeRate()`, deducir fee del budget, invocar `chargeProtocolFee` post-compose, safety guard AC-7 | W3 |
| `src/services/orchestrate.test.ts` | **MODIFICAR** — actualizar T-2 y T-7 (nueva semántica), agregar T-11..T-20 | W3 |

### Scope OUT (PROHIBIDO tocar)

- `src/adapters/kite-ozone/payment.ts` — NO modificar (CD-5).
- `src/adapters/types.ts` — NO tocar la interfaz `PaymentAdapter` (CD-5).
- `src/routes/orchestrate.ts` — el spread `{kiteTxHash, ...result}` expone los campos nuevos automáticamente. SIN cambios.
- Lógica de `compose`, `discovery`, o LLM planning — ninguna modificación.
- Integración con `POST /compose` — solo `/orchestrate`.
- Validación on-chain live con Pieverse — bloqueado por WKH-45. F4 lo documenta con evidencia, aquí se valida solo via mock.
- UI admin o DB-backed config del rate — post-MVP.

---

## 4. Pasos atómicos por wave

### WAVE 1 — Fundaciones (no toca lógica de negocio)

> **Objetivo**: skeleton + migration + env vars + tests del rate reader. Al final de W1 el código compila, los tests nuevos de `getProtocolFeeRate` pasan, y `orchestrate.ts` sigue intacto.

**Paso 1.1 — Crear branch**
```
git checkout main
git pull origin main
git checkout -b feat/044-wkh-44-protocol-fee-real-charge
```

**Paso 1.2 — Crear `src/services/fee-charge.ts` (SKELETON)**
- Exportar `getProtocolFeeRate(): number` (ver §5 shape).
- Exportar tipos `FeeChargeParams`, `FeeChargeResult` (discriminated union por `status`), `ProtocolFeeError extends Error`.
- Exportar `chargeProtocolFee(params: FeeChargeParams): Promise<FeeChargeResult>` como **stub** que lanza `new Error('NOT_IMPLEMENTED')` o retorna `Promise.resolve({ status: 'failed', error: 'NOT_IMPLEMENTED' })`. La lógica real entra en W2.
- **CD-F**: cualquier `let` declarado antes de `try/catch` debe tener anotación explícita (ej `let signResult: SignResult;`).
- **CD-1**: nada de `any` explícito.

**Paso 1.3 — Modificar `src/types/index.ts` (L211-219)**
- Agregar a `OrchestrateResult`:
  ```ts
  feeChargeError?: string;
  feeChargeTxHash?: string;
  ```
- NO tocar otros campos. Mantener orden existente; agregar al final después de `attestationTxHash?`.

**Paso 1.4 — Crear migration `supabase/migrations/YYYYMMDDHHMMSS_a2a_protocol_fees.sql`**
- **Timestamp**: generar con `date +%Y%m%d%H%M%S` al momento de crear el archivo (ej `20260420143000_a2a_protocol_fees.sql`).
- **Patrón**: mismo que `20260404200000_events.sql` y `20260403180000_tasks.sql`.
- **Columnas obligatorias** (schema exacto del SDD §3 DT-6):
  - `orchestration_id` UUID PRIMARY KEY
  - `budget_usdc` NUMERIC(18,6) NOT NULL
  - `fee_rate` NUMERIC(6,4) NOT NULL
  - `fee_usdc` NUMERIC(18,6) NOT NULL
  - `fee_wallet` TEXT NOT NULL  *(snapshot de `WASIAI_PROTOCOL_FEE_WALLET`)*
  - `status` TEXT NOT NULL CHECK(`pending | charged | failed | skipped`)
  - `tx_hash` TEXT  *(nullable)*
  - `error_message` TEXT  *(nullable)*
  - `created_at` TIMESTAMPTZ NOT NULL DEFAULT NOW()
  - `updated_at` TIMESTAMPTZ NOT NULL DEFAULT NOW()
- **Índices**: `idx_a2a_protocol_fees_status` (on `status`), `idx_a2a_protocol_fees_created` (on `created_at DESC`).
- **Trigger `updated_at`**: reutilizar `trigger_set_updated_at()` ya definida en `20260403180000_tasks.sql:7-13`. Patrón (verificado en `20260406000000_a2a_agent_keys.sql:46-50`):
  ```sql
  DROP TRIGGER IF EXISTS set_updated_at ON a2a_protocol_fees;
  CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON a2a_protocol_fees
    FOR EACH ROW
    EXECUTE FUNCTION trigger_set_updated_at();
  ```
- **CD-I**: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP TRIGGER IF EXISTS` — todo idempotente.

**Paso 1.5 — Aplicar migration a Supabase dev**
- `supabase db push` (si usás Supabase CLI local con link), o
- ejecutar manual via `psql` / Supabase SQL editor apuntando al proyecto dev.
- Verificar: `SELECT * FROM a2a_protocol_fees LIMIT 1;` debe retornar 0 rows sin error.

**Paso 1.6 — Actualizar `.env.example`**
- Agregar **al final del archivo** (o después del bloque x402 que termina en L74), el bloque exacto definido en SDD §3 DT-7:
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

**Paso 1.7 — Tests `src/services/fee-charge.test.ts` (solo `getProtocolFeeRate`)**
- Crear archivo nuevo. Suite: `describe('getProtocolFeeRate', ...)`.
- Implementar **FT-1..FT-8** (del SDD §6):
  - FT-1: unset → `0.01` (no error)
  - FT-2: `'0.05'` → `0.05`
  - FT-3: `'abc'` → `0.01` + `console.error` llamado (usar `vi.spyOn(console, 'error')`)
  - FT-4: `'-0.01'` → `0.01` + `console.error`
  - FT-5: `'0.5'` → `0.01` + `console.error`
  - FT-6: sin cache — setear `0.02` → call → setear `0.03` → call → ambas reflejan
  - FT-7 borde superior: `'0.10'` → `0.10` (acepta)
  - FT-8 borde inferior: `'0.0'` → `0.0` (acepta)
- **Patrón de setup/teardown**:
  ```ts
  const originalEnv = process.env.PROTOCOL_FEE_RATE;
  beforeEach(() => { delete process.env.PROTOCOL_FEE_RATE; });
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PROTOCOL_FEE_RATE;
    else process.env.PROTOCOL_FEE_RATE = originalEnv;
  });
  ```
- **CD-E**: el test FT-3 valida que `Number.isFinite()` se usa (NaN no pasa la guarda de rango).

**Paso 1.8 — Validación local**
- `npm run lint` → 0 errores (biome).
- `npx tsc --noEmit` → 0 errores de tipos.
- `npm test` → **baseline 350+ mantenido + 8 tests nuevos = 358+ passing**.

**Paso 1.9 — Commit W1 (opcional, el Dev decide 1 vs 3 commits)**
- Si 3 commits: usar mensaje `feat(WKH-44): wave 1 — fee-charge skeleton + migration + env vars`.
- Si 1 commit final al final de W3: **no commitear todavía**, continuar a W2.

**Definition of Done W1**:
- [ ] `fee-charge.ts` exporta `getProtocolFeeRate`, tipos, `ProtocolFeeError`, y stub `chargeProtocolFee`.
- [ ] `OrchestrateResult` tiene `feeChargeError?` y `feeChargeTxHash?`.
- [ ] Migration aplicada en Supabase dev (tabla verificable).
- [ ] `.env.example` contiene ambas vars con comments.
- [ ] 8 tests nuevos de `getProtocolFeeRate` pasan. Baseline no rompió.
- [ ] `tsc` y `lint` clean.

---

### WAVE 2 — Implementación de `chargeProtocolFee`

> **Objetivo**: implementar el helper completo con idempotencia DB, sign+settle, best-effort. Al final de W2, `chargeProtocolFee` está testeado pero **NO se invoca aún** desde `orchestrate.ts`.

**Paso 2.1 — Implementar `chargeProtocolFee` en `src/services/fee-charge.ts`**
- Params exactos: `{ orchestrationId: string; budgetUsdc: number; feeRate: number; }` (ver §5 shape).
- Retorno: `Promise<FeeChargeResult>` discriminated union (ver §5 shape).
- **Flujo obligatorio** (SDD §3 DT-6):
  1. Leer `process.env.WASIAI_PROTOCOL_FEE_WALLET`. Si vacío → `console.warn('[FeeCharge] WASIAI_PROTOCOL_FEE_WALLET not set, skipping fee transfer')` y retornar `{ status: 'skipped', reason: 'WALLET_UNSET', feeUsdc }` **sin tocar DB**.
  2. Calcular `feeUsdc = Number((budgetUsdc * feeRate).toFixed(6))`.
  3. Calcular `feeWei = String(BigInt(Math.round(feeUsdc * 1e6)) * BigInt(1e12))` — patrón de `compose.ts:188-190` (DT-8, 18 decimals).
  4. Query idempotency: `supabase.from('a2a_protocol_fees').select('status, tx_hash').eq('orchestration_id', orchestrationId).maybeSingle()`.
     - Si `status='charged'` → retornar `{ status: 'already-charged', feeUsdc, txHash }`.
     - Si `status='pending'` → retornar `{ status: 'already-charged', feeUsdc, inProgress: true }` (evita race en retries).
     - Si `status='failed'` → permitir retry (avanza al paso 5).
  5. `INSERT ... ON CONFLICT (orchestration_id) DO NOTHING` con `status='pending'`, todos los campos snapshot (budget, rate, fee, wallet). Si conflict (0 rows affected) → otro request ya empezó → retornar `{ status: 'already-charged', feeUsdc, inProgress: true }`.
  6. `getPaymentAdapter().sign({ to: WASIAI_PROTOCOL_FEE_WALLET as \`0x\${string}\`, value: feeWei })` → `settle({ authorization, signature, network })` — usar **exactamente** la firma del adapter existente en `src/adapters/kite-ozone/payment.ts:110-275`. NO inventar params.
  7. Si settle exitoso: `UPDATE a2a_protocol_fees SET status='charged', tx_hash=<txHash>, updated_at=NOW() WHERE orchestration_id=:id`. Retornar `{ status: 'charged', feeUsdc, txHash }`.
  8. Si sign o settle fallan (o lanzan): capturar en try/catch, `UPDATE ... SET status='failed', error_message=<msg>`. Retornar `{ status: 'failed', feeUsdc, error: <msg> }`.
- **CD-B**: la función **JAMÁS rechaza** la promise. Cualquier excepción (DB, network, sign) se captura y retorna `{ status: 'failed', ... }`.
- **CD-F**: `let signResult: SignResult;` con tipo explícito antes del `try` donde se asigna.
- **CD-1**: nada de `any`.
- **CD-7**: solo `viem` (el adapter ya lo usa internamente — reusarlo, no importar ethers).

**Paso 2.2 — Extender `src/services/fee-charge.test.ts` con FT-9..FT-16**
- **Patrón de mock** (exacto al de `src/services/compose.test.ts:15-17`, verificado):
  ```ts
  const mockSign = vi.fn();
  const mockSettle = vi.fn();
  vi.mock('../adapters/registry.js', () => ({
    getPaymentAdapter: () => ({ sign: mockSign, settle: mockSettle }),
  }));
  ```
- **Mock de supabase** (ver `src/services/event.ts:47-85` para el shape real):
  - Mockear `src/lib/supabase.js` → `{ supabase: { from: vi.fn() ... } }` con chain de `select`, `eq`, `insert`, `update`, `maybeSingle`, `single`.
  - Usar builder pattern para controlar respuestas por test.
- **Tests requeridos** (SDD §6):
  - **FT-9** (AC-5, CD-2): wallet unset → `{status:'skipped'}`, DB NO llamado, `console.warn` sí.
  - **FT-10** (AC-2 happy path): sign+settle OK → row `charged`, retorna `{status:'charged', feeUsdc, txHash:'0xABC'}`.
  - **FT-11** (AC-8 idempotent): 1er query retorna `{status:'charged', tx_hash:'0xEXISTING'}` → retorna `{status:'already-charged', txHash:'0xEXISTING'}`, `mockSign` NOT called.
  - **FT-12** (AC-8 race): INSERT con conflict (supabase retorna `error.code='23505'` o `data=[]`) → retorna `{status:'already-charged', inProgress:true}`, `mockSign` NOT called.
  - **FT-13** (AC-6 settle fail): `mockSettle.mockResolvedValue({success:false, error:'net'})` → UPDATE `failed`, retorna `{status:'failed', error}`.
  - **FT-14** (AC-6 sign fail): `mockSign.mockRejectedValue(new Error('sig'))` → UPDATE `failed`, retorna `{status:'failed', error}`.
  - **FT-15** (CD-B never rejects): supabase lanza → capturado, retorna `{status:'failed', error:'DB_ERROR'}`, promise NO rechaza.
  - **FT-16** (DT-8 wei conversion): `feeUsdc=0.01` → verificar `mockSign.mock.calls[0][0].value === '10000000000000000'` (1e16 wei, 18 decimals).

**Paso 2.3 — Validación local**
- `npm run lint` → 0 errores.
- `npx tsc --noEmit` → 0 errores.
- `npm test` → baseline + W1 (8) + W2 (8) = **366+ passing**.

**Paso 2.4 — Commit W2 (opcional)**
- Mensaje: `feat(WKH-44): wave 2 — chargeProtocolFee helper with DB idempotency`.

**Definition of Done W2**:
- [ ] `chargeProtocolFee` implementado completo con flujo idempotente (query → insert → sign+settle → update).
- [ ] 8 tests nuevos (FT-9..FT-16) pasan.
- [ ] `chargeProtocolFee` **no** se invoca aún desde `orchestrate.ts` (eso es W3).
- [ ] `tsc` y `lint` clean. Baseline + W1 + W2 verde.

---

### WAVE 3 — Integración en `orchestrate.ts` + migración del rate

> **Objetivo**: el feature queda completo. Al merge, si `WASIAI_PROTOCOL_FEE_WALLET` está vacío en Railway, no hay cambio observable. Cuando se setee, el cobro arranca automáticamente.

**Paso 3.1 — Modificar `src/services/orchestrate.ts`**

Cambios exactos:
- **Eliminar L26**: `const PROTOCOL_FEE_RATE = 0.01;` → **REMOVER** (CD-G).
- **Agregar imports** (arriba del módulo): `import { chargeProtocolFee, getProtocolFeeRate, ProtocolFeeError } from './fee-charge.js';`
- **Al inicio del método `orchestrate(request)`** (después de generar `orchestrationId`, antes de `discoveryService.discover`):
  ```ts
  const feeRate = getProtocolFeeRate();
  const feeUsdc = Number((budget * feeRate).toFixed(6));
  if (feeUsdc > budget) {
    throw new ProtocolFeeError(
      `Protocol fee (${feeUsdc}) exceeds budget (${budget}) — check PROTOCOL_FEE_RATE env var.`
    );
  }
  ```
  (DT-10: `ProtocolFeeError` tiene `statusCode = 400`; Fastify lo respeta vía error serialization.)
- **Reemplazar L384** `maxBudget: budget` → `maxBudget: budget - feeUsdc` (AC-1).
- **Reemplazar L389-391** (el cálculo display-only basado en `pipeline.totalCostUsdc * PROTOCOL_FEE_RATE`) → eliminar; ya tenemos `feeUsdc` calculado arriba. `protocolFeeUsdc` del result pasa a ser `feeUsdc` (AC-3, CD-D).
- **Agregar post-compose** (después del `eventService.track` de L396-412, antes del `return` de L414):
  ```ts
  let feeChargeError: string | undefined;
  let feeChargeTxHash: string | undefined;
  if (pipeline.success) {
    const feeResult = await chargeProtocolFee({
      orchestrationId,
      budgetUsdc: budget,
      feeRate,
    });
    if (feeResult.status === 'failed') {
      feeChargeError = feeResult.error;
      console.error('[Orchestrate] fee charge failed:', feeResult.error);
    } else if (feeResult.status === 'charged' || feeResult.status === 'already-charged') {
      feeChargeTxHash = feeResult.txHash;
    }
    // 'skipped' → no error, no txHash → ambos undefined
  }
  ```
- **Modificar el `return` final** (L414-421): agregar spread de los nuevos campos:
  ```ts
  return {
    orchestrationId,
    answer: pipeline.output,
    reasoning,
    pipeline,
    consideredAgents: discovered.agents,
    protocolFeeUsdc: feeUsdc,
    ...(feeChargeError !== undefined && { feeChargeError }),
    ...(feeChargeTxHash !== undefined && { feeChargeTxHash }),
  };
  ```
- **Early-returns** (DT-11, CD-D):
  - L243-256 (no-agents) y L342-355 (no-budget): **mantener** `protocolFeeUsdc: 0` (no ejecutó pipeline).
  - **PERO**: la safety guard `if (feeUsdc > budget) throw ...` debe estar **antes** de esos early-returns para capturar rates corruptos incluso si no hay agents.

**Paso 3.2 — Modificar `src/services/orchestrate.test.ts`**

- **Agregar mock del helper** (arriba, junto a los otros `vi.mock`):
  ```ts
  vi.mock('./fee-charge.js', async () => {
    const actual = await vi.importActual<typeof import('./fee-charge.js')>('./fee-charge.js');
    return {
      ...actual,
      chargeProtocolFee: vi.fn(),
      getProtocolFeeRate: vi.fn().mockReturnValue(0.01),
    };
  });
  ```
- **Actualizar T-2** (AC-3 nueva semántica): `protocolFeeUsdc` pasa de `totalCostUsdc * 0.01` a `budget * 0.01`. Comentar inline: `// WKH-44: fee ahora sobre budget, no sobre totalCostUsdc`.
- **Actualizar T-7** (AC-3): mismo ajuste. Si budget=20 → `protocolFeeUsdc=0.2` (antes 0.1 sobre totalCost=10).
- **Agregar T-11..T-20** (SDD §6 tabla 2):
  - **T-11** (AC-1): spy en `composeService.compose` → verificar `maxBudget === budget - feeUsdc` (ej budget=1.00, feeRate=0.01 → maxBudget=0.99).
  - **T-12** (AC-2): `pipeline.success=true` + wallet seteado → `chargeProtocolFee` invocado 1x con `{orchestrationId, budgetUsdc: budget, feeRate}`.
  - **T-13** (AC-2 no-charge): `pipeline.success=false` → `chargeProtocolFee` NO invocado.
  - **T-14** (AC-5): `chargeProtocolFee.mockResolvedValue({status:'skipped', feeUsdc:0.01})` → result NO tiene `feeChargeError` ni `feeChargeTxHash`.
  - **T-15** (AC-6): `mockResolvedValue({status:'failed', feeUsdc:0.01, error:'net'})` → `feeChargeError === 'net'`, HTTP 200 (sin throw).
  - **T-16** (AC-7): `getProtocolFeeRate.mockReturnValue(1.5)` + budget=1 → throw `ProtocolFeeError` con `statusCode=400` ANTES de `discoveryService.discover`. Verificar `discover` NOT called.
  - **T-17** (AC-8): 2 llamadas a `orchestrate` con el mismo `orchestrationId` → `chargeProtocolFee` invocado 2x; 2da retorna `{status:'already-charged', txHash:'0xPREV'}` → `feeChargeTxHash` presente en ambas.
  - **T-18** (AC-10): cambiar retorno de `getProtocolFeeRate` entre llamadas (0.01 → 0.02) → `protocolFeeUsdc` refleja el cambio.
  - **T-19** (AC-9 default): `getProtocolFeeRate.mockReturnValue(0.01)` (simulando env unset) → fee calculado con 0.01.
  - **T-20** (CD-D early-return): `discoveryService.discover` retorna `{agents:[]}` → early-return con `protocolFeeUsdc: 0`.

**Paso 3.3 — Validación local**
- `npm run lint` → 0 errores.
- `npx tsc --noEmit` → 0 errores.
- `npm test` → **baseline 350 + W1 (8) + W2 (8) + W3 (10) + actualizaciones T-2/T-7 = 376+ passing**.
- Arrancar server local (`npm run dev`) y hacer smoke test del endpoint `/orchestrate` con un payload válido — verificar que el response incluye `protocolFeeUsdc` y que no hay errores de tipo en runtime.

**Paso 3.4 — Commit W3 (o commit único)**
- Si 3 commits: `feat(WKH-44): wave 3 — integrate fee charge in orchestrate + remove hardcoded rate`.
- Si 1 commit único: usar el mensaje largo del §11.

**Paso 3.5 — Push branch (NO mergear)**
```
git push -u origin feat/044-wkh-44-protocol-fee-real-charge
```
El merge a `main` lo decide el humano tras AR + CR + F4 + DONE.

**Definition of Done W3**:
- [ ] `PROTOCOL_FEE_RATE = 0.01` literal **eliminado** del módulo (CD-G).
- [ ] `orchestrate.ts` invoca `getProtocolFeeRate()` y `chargeProtocolFee(...)` correctamente.
- [ ] `maxBudget` pasado a compose = `budget - feeUsdc`.
- [ ] `protocolFeeUsdc` del result = `budget * feeRate` (no cero salvo early-return).
- [ ] `feeChargeError` / `feeChargeTxHash` se propagan correctamente.
- [ ] 376+ tests pasan.
- [ ] Branch pusheada. **No** mergeada.

---

## 5. Snippets de referencia (SHAPE — no copy-paste literal)

> Estos snippets muestran la **forma** esperada. El Dev debe adaptarlos al estilo del codebase.

### 5.1 `getProtocolFeeRate` — firma + safety guard

```ts
/** Lee PROTOCOL_FEE_RATE del env por-request. Rango [0.0, 0.10]. Default 0.01. */
export function getProtocolFeeRate(): number {
  const raw = process.env.PROTOCOL_FEE_RATE;
  if (raw === undefined || raw === '') return 0.01;

  const parsed = Number.parseFloat(raw);

  // CD-E: Number.isFinite rechaza NaN e Infinity (parseFloat("abc") → NaN).
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 0.10) {
    console.error(
      `[FeeCharge] Invalid PROTOCOL_FEE_RATE="${raw}" (must be finite number in [0.0, 0.10]); falling back to 0.01`
    );
    return 0.01;
  }

  return parsed;
}
```

### 5.2 `chargeProtocolFee` — firma + shape del resultado

```ts
export interface FeeChargeParams {
  orchestrationId: string;
  budgetUsdc: number;
  feeRate: number;
}

/** Discriminated union — el caller hace switch/if por `status`. */
export type FeeChargeResult =
  | { status: 'charged'; feeUsdc: number; txHash: string }
  | { status: 'already-charged'; feeUsdc: number; txHash?: string; inProgress?: boolean }
  | { status: 'skipped'; feeUsdc: number; reason: 'WALLET_UNSET' }
  | { status: 'failed'; feeUsdc: number; error: string };

export class ProtocolFeeError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolFeeError';
  }
}

/**
 * Transfer del fee via EIP-712 sign + settle. Best-effort, nunca rechaza (CD-B).
 * Idempotencia DB-level via PK en `a2a_protocol_fees.orchestration_id`.
 */
export async function chargeProtocolFee(
  params: FeeChargeParams,
): Promise<FeeChargeResult> {
  // ... flujo descripto en Paso 2.1 (skip → query → insert pending → sign+settle → update)
}
```

### 5.3 Patrón INSERT ON CONFLICT DO NOTHING (idempotency barrier)

```ts
// Supabase builder — el DO NOTHING se emula con ignoreDuplicates en upsert,
// o bien chequeando el error code 23505 tras un insert normal.
const { data: inserted, error: insertErr } = await supabase
  .from('a2a_protocol_fees')
  .insert({
    orchestration_id: orchestrationId,
    budget_usdc: budgetUsdc,
    fee_rate: feeRate,
    fee_usdc: feeUsdc,
    fee_wallet: walletAddress,
    status: 'pending',
  })
  .select('orchestration_id')
  .maybeSingle();

if (insertErr) {
  // Postgres unique_violation (23505) — otro request ya insertó el pending.
  if (insertErr.code === '23505') {
    return { status: 'already-charged', feeUsdc, inProgress: true };
  }
  // Otro error de DB → propagar como failed (CD-B, nunca rechazar).
  return { status: 'failed', feeUsdc, error: `DB_ERROR: ${insertErr.message}` };
}
```

### 5.4 Spread en `orchestrate.ts` para exponer `feeChargeError` / `feeChargeTxHash`

```ts
return {
  orchestrationId,
  answer: pipeline.output,
  reasoning,
  pipeline,
  consideredAgents: discovered.agents,
  protocolFeeUsdc: feeUsdc,
  // Spread condicional: solo aparecen en el body si hay valor real.
  ...(feeChargeError !== undefined && { feeChargeError }),
  ...(feeChargeTxHash !== undefined && { feeChargeTxHash }),
};
```

### 5.5 Tipo `let` explícito antes de `try/catch` (CD-F)

```ts
// ✅ BIEN — tipo explícito, biome no se queja.
let signResult: { xPaymentHeader: string; paymentRequest: X402PaymentRequest };
try {
  signResult = await adapter.sign({ to: walletAddress, value: feeWei });
} catch (err) {
  // ... manejar
}

// ❌ MAL — biome noImplicitAnyLet dispara.
let signResult;
try {
  signResult = await adapter.sign(...);
} catch (err) { ... }
```

---

## 6. Tests esperados (lista exacta por archivo)

### `src/services/fee-charge.test.ts` — 16 tests nuevos

| # | Test name (sugerido) | Cubre |
|---|----------------------|-------|
| FT-1 | `getProtocolFeeRate returns 0.01 when env var unset` | AC-9 |
| FT-2 | `getProtocolFeeRate parses valid "0.05"` | AC-9 |
| FT-3 | `getProtocolFeeRate falls back to 0.01 + console.error on NaN input` | AC-9, CD-E |
| FT-4 | `getProtocolFeeRate falls back to 0.01 + console.error on negative` | AC-9 |
| FT-5 | `getProtocolFeeRate falls back to 0.01 + console.error on > 0.10` | AC-9 |
| FT-6 | `getProtocolFeeRate re-reads env on every call (no cache)` | AC-10 |
| FT-7 | `getProtocolFeeRate accepts boundary 0.10` | AC-9 boundary |
| FT-8 | `getProtocolFeeRate accepts boundary 0.0` | AC-9 boundary |
| FT-9 | `chargeProtocolFee skips when WASIAI_PROTOCOL_FEE_WALLET unset` | AC-5, CD-2 |
| FT-10 | `chargeProtocolFee happy path: sign+settle → row charged + txHash` | AC-2 |
| FT-11 | `chargeProtocolFee returns already-charged on second call (idempotent)` | AC-8 |
| FT-12 | `chargeProtocolFee handles insert conflict as already-charged (race)` | AC-8 |
| FT-13 | `chargeProtocolFee marks failed when settle returns success:false` | AC-6 |
| FT-14 | `chargeProtocolFee marks failed when sign throws` | AC-6 |
| FT-15 | `chargeProtocolFee never rejects even on DB error` | CD-B |
| FT-16 | `chargeProtocolFee converts feeUsdc=0.01 to feeWei="10000000000000000"` | DT-8 |

### `src/services/orchestrate.test.ts` — 2 actualizados + 10 nuevos

| # | Test name (sugerido) | Cubre |
|---|----------------------|-------|
| T-2 (upd) | `... protocolFeeUsdc = budget * 0.01` *(era totalCostUsdc \* 0.01)* | AC-3 |
| T-7 (upd) | `... protocolFeeUsdc = 0.2 when budget=20` | AC-3 |
| T-11 | `compose receives maxBudget = budget - feeUsdc` | AC-1 |
| T-12 | `chargeProtocolFee invoked when pipeline.success=true + wallet set` | AC-2 |
| T-13 | `chargeProtocolFee NOT invoked when pipeline.success=false` | AC-2 |
| T-14 | `result has no feeChargeError/feeChargeTxHash when wallet unset (skipped)` | AC-5 |
| T-15 | `result.feeChargeError present + HTTP 200 when fee charge fails` | AC-6 |
| T-16 | `throws ProtocolFeeError 400 when feeUsdc > budget (before discovery)` | AC-7 |
| T-17 | `second call with same orchestrationId returns already-charged (no double-charge)` | AC-8 |
| T-18 | `PROTOCOL_FEE_RATE change reflected in next orchestrate (no cache)` | AC-10 |
| T-19 | `fee calculated with default 0.01 when env unset` | AC-9 |
| T-20 | `early-return no-agents keeps protocolFeeUsdc=0` | CD-D |

### Regresión baseline (AC-4)
- `npm test` → 350+ baseline + 26 nuevos (16 fee-charge + 10 orchestrate) = **376+ passing**.
- Si algún test baseline rompe → revertir cambios y consultar; NO "arreglar" tests existentes salvo T-2/T-7 documentados (CD-H).

### Tests NO cubiertos en F3 (documentar en F4)
- **AC-2 on-chain validation live** → bloqueado por WKH-45. F4 lo reporta con evidencia y valida solo vía mock.

---

## 7. Anti-Hallucination Checklist (OBLIGATORIO antes de cada paso)

- [ ] Antes de tocar `orchestrate.ts`, **leer `src/services/orchestrate.ts` L1-50, L380-423** (imports + puntos de inyección confirmados en SDD §2).
- [ ] Antes de tocar `fee-charge.ts`, **leer `src/services/compose.test.ts:15-17`** — ese es el patrón exacto de mock del `paymentAdapter`.
- [ ] Antes de llamar `sign()` / `settle()`, **leer `src/adapters/kite-ozone/payment.ts:110-275`** — NO inventar firma del adapter, usar la real verificada en SDD §2.
- [ ] Antes de importar `supabase`, **leer `src/lib/supabase.ts:38`** — el export es `supabase` (singleton), usar `import { supabase } from '../lib/supabase.js'`.
- [ ] Antes de crear la migration, **leer `supabase/migrations/20260403180000_tasks.sql` completo + `20260404200000_events.sql`** — el pattern (trigger, índices, IF NOT EXISTS) no se inventa.
- [ ] Antes de modificar `OrchestrateResult`, **leer `src/types/index.ts:211-219`** — agregar al final, NO reordenar campos existentes.
- [ ] Antes de agregar env vars, **leer `.env.example` completo** — respetar el estilo de comments (`# ─── Block ───`, explicación, default inline).
- [ ] NO inventar una interfaz nueva de `PaymentAdapter` — usar **exactamente** la de `src/adapters/types.ts:78-91`.
- [ ] NO crear un nuevo cliente Supabase — usar el singleton de `src/lib/supabase.ts`.
- [ ] NO introducir dependencias nuevas (`npm install` NO debe ejecutarse con paquetes adicionales).
- [ ] NO usar `ethers.js` (CD-7). Solo `viem`, ya integrado vía el adapter.
- [ ] NO cachear el rate in-memory — `getProtocolFeeRate()` siempre re-lee `process.env` (AC-10, CD-G).

---

## 8. Constraint Directives activas (checklist durante F3)

Heredadas del work-item:
- [ ] **CD-1**: sin `any` explícito (tsconfig strict + biome `noExplicitAny`).
- [ ] **CD-2**: `WASIAI_PROTOCOL_FEE_WALLET` opcional, skip silencioso + `console.warn` si unset.
- [ ] **CD-3**: `feeUsdc > budget` → `ProtocolFeeError` 400, antes de discovery.
- [ ] **CD-4**: fallo del transfer NO rompe orchestrate (HTTP 200 siempre).
- [ ] **CD-5**: NO modificar `src/adapters/types.ts::PaymentAdapter`.
- [ ] **CD-6**: idempotencia DB via `a2a_protocol_fees.orchestration_id` PK.
- [ ] **CD-7**: prohibido `ethers`, solo `viem`.
- [ ] **CD-8**: `.env.example` contiene ambas vars con comments DT-7.
- [ ] **CD-G**: `PROTOCOL_FEE_RATE` literal ELIMINADO del módulo; solo `getProtocolFeeRate()` lo lee.

Nuevas del SDD:
- [ ] **CD-A**: `getProtocolFeeRate()` es la ÚNICA función autorizada a leer `process.env.PROTOCOL_FEE_RATE`.
- [ ] **CD-B**: `chargeProtocolFee` retorna promise que **jamás** rechaza.
- [ ] **CD-C**: ningún test invoca payment adapter real ni hace fetch a Pieverse; todo mockeado.
- [ ] **CD-D**: `protocolFeeUsdc` = `budget * rate` en el happy path; solo cero en early-returns (no-agents, no-budget).
- [ ] **CD-E**: `Number.isFinite()` en el guard de rate (previene NaN passando a través de `> 0.10`).
- [ ] **CD-F**: `let signResult: SignResult;` con tipo explícito antes de try/catch (biome `noImplicitAnyLet`, ref auto-blindaje WKH-MCP-X402 Wave 3).
- [ ] **CD-H**: tests T-1..T-10 intactos salvo T-2 y T-7 (documentados inline).
- [ ] **CD-I**: migration con patrón `20260404200000_events.sql` (IF NOT EXISTS, índices separados, trigger updated_at).
- [ ] **CD-J**: idempotency table self-contained — sin FK a `tasks` ni a nada; el primer request la puebla.

---

## 9. Criterios de hecho (DoD de la HU completa)

- [ ] Tests baseline **350+** siguen pasando (AC-4).
- [ ] **+26 tests nuevos**: 16 en `fee-charge.test.ts` + 10 en `orchestrate.test.ts` + 2 updates T-2/T-7.
- [ ] Total suite: **376+ passing**, 0 failing, 0 skipped (salvo los pre-existentes).
- [ ] `npx tsc --noEmit` → 0 errores.
- [ ] `npm run lint` → 0 errores.
- [ ] Migration `YYYYMMDDHHMMSS_a2a_protocol_fees.sql` aplicada en Supabase dev; `SELECT * FROM a2a_protocol_fees LIMIT 1;` responde sin error.
- [ ] `.env.example` contiene `WASIAI_PROTOCOL_FEE_WALLET=` y `PROTOCOL_FEE_RATE=0.01` con comments DT-7.
- [ ] `src/services/orchestrate.ts` **NO** contiene `const PROTOCOL_FEE_RATE = 0.01` literal (CD-G verificable con grep).
- [ ] Commits convencionales: 3 por wave **o** 1 commit único con el mensaje del §11.
- [ ] Branch `feat/044-wkh-44-protocol-fee-real-charge` pusheada a remote. **NO** mergeada.
- [ ] Reporte al orquestador con paths de archivos modificados + resumen por wave.

---

## 10. Mensajes de commit sugeridos

### Opción A — 3 commits (uno por wave)

**W1**:
```
feat(WKH-44): wave 1 — fee-charge skeleton + migration + env vars

- src/services/fee-charge.ts: getProtocolFeeRate + tipos + stub chargeProtocolFee
- src/types/index.ts: OrchestrateResult extendido con feeChargeError/feeChargeTxHash
- supabase/migrations/*_a2a_protocol_fees.sql: tabla idempotency con PK natural
- .env.example: WASIAI_PROTOCOL_FEE_WALLET + PROTOCOL_FEE_RATE
- src/services/fee-charge.test.ts: 8 tests de getProtocolFeeRate (FT-1..FT-8)
```

**W2**:
```
feat(WKH-44): wave 2 — chargeProtocolFee helper with DB idempotency

- src/services/fee-charge.ts: implementación completa (sign+settle+upsert)
- Idempotencia via ON CONFLICT DO NOTHING en a2a_protocol_fees.orchestration_id
- Best-effort: jamás rechaza, reporta status via discriminated union
- +8 tests (FT-9..FT-16)
```

**W3**:
```
feat(WKH-44): wave 3 — integrate fee charge in orchestrate + remove hardcoded rate

- src/services/orchestrate.ts: elimina const PROTOCOL_FEE_RATE = 0.01 (CD-G)
- Usa getProtocolFeeRate() y chargeProtocolFee() post-compose si pipeline.success
- Deduce fee del budget antes del compose (AC-1)
- protocolFeeUsdc ahora = budget * rate (AC-3, semántica nueva)
- Safety guard AC-7 antes de discovery
- +10 tests (T-11..T-20), 2 actualizados (T-2, T-7)
```

### Opción B — 1 commit único

```
feat(WKH-44): protocol fee real charge — deduct from budget + transfer to Kite wallet

- getProtocolFeeRate() reads PROTOCOL_FEE_RATE env (default 0.01, range [0.0, 0.10])
- New table a2a_protocol_fees for DB-based idempotency
- fee-charge.ts helper — signs EIP-712 via PaymentAdapter, fail-safe, never rejects
- orchestrate.ts — deducts fee from budget pre-compose, charges post-compose on success
- +26 tests (16 fee-charge + 10 orchestrate), 376/376 passing

Closes WKH-44 (AC-2 on-chain validation pending WKH-45 Pieverse fix)
```

---

## 11. Referencias rápidas

| Tema | Archivo:línea |
|------|---------------|
| SDD completo | `doc/sdd/044-wkh-44-protocol-fee/sdd.md` |
| Work item + ACs EARS | `doc/sdd/044-wkh-44-protocol-fee/work-item.md` |
| Constante literal a eliminar | `src/services/orchestrate.ts:26` |
| Punto de inyección `maxBudget` | `src/services/orchestrate.ts:384` |
| Display-only fee a migrar | `src/services/orchestrate.ts:389-391` |
| Return de `orchestrate` | `src/services/orchestrate.ts:414-421` |
| Interfaz `PaymentAdapter` (NO tocar) | `src/adapters/types.ts:78-91` |
| Impl `sign()` + `settle()` del adapter | `src/adapters/kite-ozone/payment.ts:110-275` |
| Accesor singleton | `src/adapters/registry.ts:37-41` |
| Supabase client singleton | `src/lib/supabase.ts:38` |
| Pattern mock `getPaymentAdapter` | `src/services/compose.test.ts:15-17` |
| Pattern INSERT Supabase | `src/services/event.ts:47-85` |
| Pattern migration con trigger | `supabase/migrations/20260403180000_tasks.sql:7-42` |
| Pattern tabla con prefijo `a2a_` | `supabase/migrations/20260404200000_events.sql` |
| Auto-blindaje heredado (CD-E/F) | `doc/sdd/WKH-MCP-X402/auto-blindaje.md` |

---

**FIN DEL STORY FILE — WKH-44**
