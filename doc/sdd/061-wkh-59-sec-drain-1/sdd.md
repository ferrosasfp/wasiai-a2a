# SDD — WKH-59 / SEC-DRAIN-1

> Spec Driven Document para `/gasless/transfer` — fix de drain del operator
> wallet. El budget protege la API; el SDD lo extiende para proteger los
> fondos on-chain que la API moviliza.
>
> Input: `doc/sdd/061-wkh-59-sec-drain-1/work-item.md` (HU_APPROVED).
> Output esperado: parche que (a) introduce un helper puro `pyusdWeiToUsd`,
> (b) inyecta el costo real estimado en el `preHandler` de la ruta gasless,
> (c) hace que el middleware consuma ese costo si está presente, (d) cap
> global con `GASLESS_DEFAULT_CAP_USD`.

---

## 1. Context Map (Codebase Grounding)

Archivos leídos para extraer patrones reales (no inventados):

| Archivo | Líneas | Por qué se leyó | Patrón extraído |
|---|---|---|---|
| `src/routes/gasless.ts` | 1-72 | Sitio del bug — handler que recibe `body.value` arbitrario y lo pasa a `transfer()`. | El `preHandler` ya está cableado vía `requirePaymentOrA2AKey` (línea 33-35). El body es parseado en el handler (línea 47). `body.value` se convierte a `BigInt` directamente (línea 55). NO hay validación de magnitud antes del transfer. |
| `src/middleware/a2a-key.ts` | 80-180 | Sitio del placeholder hardcodeado. | Línea 115: `const estimatedCostUsd = 1.0;`. La línea tiene comentario `// DT-2 placeholder cost estimation (MNR-2: single const)` — el placeholder fue documentado como tal, no es accidental, pero la consecuencia (drain) no fue evaluada. El middleware consume `estimatedCostUsd` en (a) `max_spend_per_call_usd` check (línea 156), (b) debit (línea 175), (c) sin afectar el daily_limit (eso lo hace la PG function). |
| `src/services/budget.ts` | 1-86 | Verificar el shape de `debit`. | `debit(keyId, chainId, amountUsd: number)` — recibe USD como `number`, no wei. El downstream PG function `increment_a2a_key_spend` recibe `p_amount_usd NUMERIC`. Compatible con el cómputo en TS. |
| `supabase/migrations/20260406000000_a2a_agent_keys.sql` | 1-148 | Verificar el column name del límite diario (DT-4 work-item). | Línea 16: `daily_limit_usd NUMERIC(18,6)`. **Confirmado: el column es `daily_limit_usd` — NO `max_spend_per_day_usd`**. La PG function `increment_a2a_key_spend` (línea 96-99) ya enforce el límite con `FOR UPDATE`: `IF v_daily_limit IS NOT NULL AND (v_daily_spent + p_amount_usd) > v_daily_limit THEN RAISE EXCEPTION 'DAILY_LIMIT'`. Esto significa que si el middleware llama `debit(..., correctCostUsd)` con el monto real, el daily_limit se enforce automáticamente sin cambios extra. |
| `src/services/fee-charge.ts` | 80-110 | Patrón canónico de "leer env por request con guard rango y fallback". | Función `getProtocolFeeRate()`: `const raw = process.env.X; if (!raw) return DEFAULT; const parsed = Number.parseFloat(raw); if (!Number.isFinite(parsed) \|\| parsed < MIN \|\| parsed > MAX) { console.error(...); return DEFAULT; } return parsed;`. **Este es el exemplar a replicar para `getPyusdUsdRate()` y `getGaslessDefaultCap()`.** |
| `src/middleware/a2a-key.test.ts` | 1-150 | Patrón de mocking del middleware. | Mocks: `identityService.lookupByHash`, `budgetService.{getBalance, debit}`, `getPaymentAdapter`, `getChainConfig`. Helper `makeKeyRow` con todos los campos. AB-WKH-57: preferir `vi.spyOn` sobre `vi.mock` cuando sea posible. |
| `.env.example` | 1-211 | Convención de naming + estructura de docstrings. | Variables agrupadas por sección con `# ─── Section ─────`. Docstrings explican defaults, range, side effects. Replicaremos el estilo en la nueva sección "Gasless Pricing (WKH-59)". |
| `src/lib/gasless-signer.test.ts` | (referenciado) | Confirma decimals=6 para PYUSD en chain 2368. | El token PYUSD en chain 2368 (Kite testnet) usa 6 decimals. `gasless-signer.ts` y `.env.example:75-85` confirman: `X402_PAYMENT_TOKEN=0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9` (PYUSD, 6 decimals). |

---

## 2. Decisiones técnicas (DT)

### DT-A — `PYUSD_USD_RATE` env + helper puro `getPyusdUsdRate()`

**Decisión**: nueva env var `PYUSD_USD_RATE` (default `"1.0"`). Helper
puro `getPyusdUsdRate()` en `src/lib/price.ts` lee `process.env.PYUSD_USD_RATE`
por request, con guard `Number.isFinite` + range `[0, 100]`. Fuera de rango
o no parseable → fallback `1.0` + `console.warn` estructurado.

**Justificación**:
- PYUSD es stablecoin USD por diseño → 1:1 es el rate correcto.
- Defensa-en-profundidad para escenarios de depeg temporal o tokens
  test con rate distinto: el operator puede setear `PYUSD_USD_RATE=0.97`
  y el cómputo USD se ajusta sin redeploy.
- Range `[0, 100]` cubre escenarios razonables (0 = depeg total → todos
  los transfers se vuelven "gratis" en USD pero el cap por wei sigue
  protegiendo; 100 = límite alto defensivo contra typos como `100000`).
- Patrón idéntico a `getProtocolFeeRate()` en `src/services/fee-charge.ts:90-110`
  → consistencia de codebase.

**API del helper**:
```text
// src/lib/price.ts
export function getPyusdUsdRate(): number  // env-backed, [0, 100], fallback 1.0
export function pyusdWeiToUsd(valueWei: bigint): number  // valueWei/1e6 * rate
```

### DT-B — `GASLESS_DEFAULT_CAP_USD` env + helper `getGaslessDefaultCapUsd()`

**Decisión**: nueva env var `GASLESS_DEFAULT_CAP_USD` (default `"10"`).
Helper `getGaslessDefaultCapUsd()` en `src/lib/price.ts`. Range `(0, 10000]`.
Fuera → fallback 10 + warn.

**Justificación**:
- El cap es un límite **GLOBAL para la ruta** — independiente de la key.
- Default `$10` es conservador para hackathon: evita drains catastróficos
  manteniendo casos de uso normales (transfers de demo).
- Range `(0, 10000]` impide accidentes (`-1`, `Infinity`, `0` que
  efectivamente bloquearía la ruta).
- El operator que necesite mover montos mayores eleva el env var
  conscientemente.

**API**:
```text
// src/lib/price.ts
export function getGaslessDefaultCapUsd(): number  // env-backed, (0, 10000], fallback 10
```

### DT-C — Separación de responsabilidades route vs middleware

**Decisión**: el `preHandler` de `/gasless/transfer` se compone de DOS
stages:
1. **Stage A (NUEVO)**: parsea body, valida shape, computa `estimatedCostUsd`,
   valida cap. Si OK, escribe `request.gaslessEstimatedCostUsd: number`.
2. **Stage B (EXISTENTE)**: `requirePaymentOrA2AKey({...})`. Lee
   `request.gaslessEstimatedCostUsd` SI está presente; sino usa `1.0`.

**Justificación**:
- El middleware NO conoce la semántica de cada ruta (qué representa el
  body, qué decimals usa, qué token). Que la ruta inyecte el costo
  preserva la separación.
- Backward-compat: rutas existentes (`/compose`, `/orchestrate`, etc.) NO
  setean el campo → middleware usa el placeholder $1 → los 532 tests
  existentes siguen verde.
- Patrón escalable: cualquier ruta futura que mueva fondos arbitrarios
  (`/gasless/multi-transfer`, `/x402/refund`) sigue el mismo patrón.

**Alternativa descartada**:
- Factory del middleware con `costEstimator?: (req) => number` → más
  flexible pero requiere refactor + más tests + scope creep para un fix
  de seguridad. Si emerge un segundo caso, se hace ese refactor; hoy
  uno solo.

### DT-D — Augmentación de FastifyRequest

**Decisión**: declarar el campo opcional en el módulo Fastify:

```text
// dentro de src/middleware/a2a-key.ts (mismo módulo donde ya hay augment)
declare module 'fastify' {
  interface FastifyRequest {
    a2aKeyRow?: A2AAgentKeyRow;        // existente (línea 22-26)
    gaslessEstimatedCostUsd?: number;  // NUEVO — DT-C
  }
}
```

**Justificación**:
- Centraliza augmentations en un módulo. Si en el futuro emerge un
  segundo caso, agregar otro campo a la misma `interface FastifyRequest`.
- Tipo estricto `number | undefined` (CD-1: cero `any`).

### DT-E — Validación del body antes del cómputo de costo

**Decisión**: el Stage A del `preHandler` valida en este orden:
1. `body?.to` y `body?.value` están presentes y son strings → 400 si no.
2. `try { BigInt(body.value) }` → 400 si throws (AC-6).
3. `pyusdWeiToUsd(valueWei)` → si `Infinity` (overflow safe-int), 403
   PER_CALL_LIMIT.
4. `estimatedCostUsd > GASLESS_DEFAULT_CAP_USD` → 403 PER_CALL_LIMIT
   con shape: `{ error: 'Transfer exceeds gasless cap', error_code: 'PER_CALL_LIMIT', cap_usd: number, requested_usd: number }`.

**Justificación**:
- Validación temprana: rechazar antes del middleware ahorra hashing,
  lookup DB y debit innecesarios.
- Shape consistente con los 403 del middleware (`error`, `error_code`).

### DT-F — Schema column name (DT-4 del work-item)

**Decisión**: el column es **`daily_limit_usd`** (línea 16 de la migration).
La PG function `increment_a2a_key_spend` (línea 56-121) ya enforce el
daily limit atómicamente. Si pasamos el `estimatedCostUsd` correcto (no $1
fijo) al `debit`, la PG function lo suma a `daily_spent_usd` y lanza
`DAILY_LIMIT` si excede — sin cambios extra en DB ni en service.

**Justificación**:
- Verificado en `src/middleware/a2a-key.ts:135` (TS layer también lee
  `keyRow.daily_limit_usd`) y en la migration original.
- **No tocar la migration. No tocar `budget.ts`. No tocar la PG function.**

### DT-G — Post-tx accounting

**Decisión**: NO necesitamos un debit correctivo post-tx. PYUSD es
stablecoin 1:1 → `actualCostUsd === estimatedCostUsd` por construcción.

**Justificación**:
- Pre-debit (líneas 165-176 de `a2a-key.ts`) ya cobra optimisticamente
  el costo correcto. Si el transfer falla on-chain, el debit ya se
  hizo (mismo comportamiento que el resto del codebase, ver BLQ-1/2/3
  fix WKH-34-W4).
- Para tokens con slippage (no es el caso de PYUSD), un futuro WKH
  podría agregar reconciliación post-tx. Hoy out of scope.

### DT-H — Logging estructurado (AC-7)

**Decisión**: en éxito, el handler loguea con `request.log.info`:
```text
request.log.info(
  {
    keyId: request.a2aKeyRow?.id,
    estimatedCostUsd: request.gaslessEstimatedCostUsd,
    actualValueWei: body.value,
    to: body.to,
    txHash: result.txHash ?? null,
  },
  'gasless transfer executed',
);
```

**Justificación**:
- Trail de auditoría para responder al security audit (qué key drenó qué
  monto, cuándo).
- Pino structured logging, mismo patrón que los `request.log.error` del
  resto del archivo.

---

## 3. Constraint Directives (CD)

Heredados del work-item + específicos del SDD:

- **CD-1** (heredado): PROHIBIDO debitar `1.0` USD fijo cuando la ruta
  moviliza fondos on-chain de monto arbitrario controlado por el caller.
- **CD-2** (heredado): PROHIBIDO ejecutar `transfer()` sin haber pasado
  el cap + el debit con el costo correcto.
- **CD-3** (heredado): OBLIGATORIO backward-compat con rutas existentes
  (placeholder $1 si no se setea el campo del request).
- **CD-4** (heredado): baseline 532 verde, ~20 tests nuevos.
- **CD-5** (heredado): PROHIBIDO hardcodes de cap/rate/chain.
- **CD-6** (heredado): PROHIBIDO `any` o `as unknown as X`.
- **CD-7** (NUEVO): PROHIBIDO leer el body en el middleware. El
  middleware permanece body-agnostic; el costo se inyecta vía
  `request.gaslessEstimatedCostUsd`.
- **CD-8** (NUEVO): PROHIBIDO emitir `console.log` desde `src/lib/price.ts`.
  Solo `console.warn` o `console.error` en path de error (mismo patrón
  que `fee-charge.ts:103`). Helpers son puros y testables sin Fastify.
- **CD-9** (NUEVO): OBLIGATORIO usar `Number.isFinite` (no `isNaN`,
  no `Number.isNaN`) — coincide con AB-WKH-57 sobre guards numéricos.
- **CD-10** (NUEVO): OBLIGATORIO el helper `pyusdWeiToUsd` retorna
  `Infinity` (no throws) cuando `valueWei > Number.MAX_SAFE_INTEGER`.
  El caller (route preHandler) lo trata como overflow → 403.
- **CD-11** (NUEVO, de Auto-Blindaje histórico AB-WKH-57-W2): cualquier
  test que toque mocks de Supabase debe verificar que el chain de `.eq()`
  está completo. **No aplica directamente acá** (no tocamos Supabase),
  pero sí aplica a los tests del middleware si extienden mocks existentes.
- **CD-12** (NUEVO, de AB-WKH-44 — referencia: WKH-44 auto-blindaje):
  los tests de `pyusdWeiToUsd` y env helpers DEBEN cubrir explícitamente
  los siguientes edge cases: env vacío `""`, env `undefined`, env `"NaN"`,
  env `"Infinity"`, env negativo, env fuera de rango, env válido. Mismo
  spectrum que cubre `getProtocolFeeRate.test.ts` — replicar el patrón.

---

## 4. Waves de implementación

### W0 — Tipos + ajuste de contrato del middleware (serial)

**Objetivo**: extender la augmentation de `FastifyRequest` y ajustar el
middleware para leer el campo opcional sin romper nada.

**Archivos**:
- `src/middleware/a2a-key.ts` — agregar `gaslessEstimatedCostUsd?: number`
  al `declare module 'fastify'` (líneas 22-26). Cambiar línea 115
  `const estimatedCostUsd = 1.0;` por:
  ```text
  const estimatedCostUsd =
    typeof request.gaslessEstimatedCostUsd === 'number'
      ? request.gaslessEstimatedCostUsd
      : 1.0;
  ```

**Tests W0**: ejecutar baseline `npm test` → debe seguir 532 verde
(la lectura es opcional, ningún caller existente la setea).

### W1 — Helper puro `src/lib/price.ts`

**Objetivo**: crear el helper puro y sus tests unitarios. Sin acoplar a
Fastify/DB.

**Archivos**:
- `src/lib/price.ts` (NUEVO) — `getPyusdUsdRate()`, `pyusdWeiToUsd()`,
  `getGaslessDefaultCapUsd()`. Constantes `PYUSD_DECIMALS = 6`,
  `DEFAULT_PYUSD_RATE = 1.0`, `DEFAULT_GASLESS_CAP_USD = 10`,
  `MAX_PYUSD_RATE = 100`, `MAX_GASLESS_CAP_USD = 10000`.
- `src/lib/price.test.ts` (NUEVO) — tests T-PRICE-1..T-PRICE-10
  (ver §5).

**Paralelizable con W0**: NO (W0 es serial pre-requisito? actually W1
no depende de W0, los tests de price son aislados → SE PUEDE PARALELIZAR).

### W2 — Route preHandler `/gasless/transfer`

**Objetivo**: el handler `POST /gasless/transfer` adquiere un nuevo
preHandler-stage A que valida, computa y setea
`request.gaslessEstimatedCostUsd`. El stage B (middleware) ya está
preparado por W0.

**Archivos**:
- `src/routes/gasless.ts` — modificar el `preHandler` (línea 33-35) de
  ser un solo `requirePaymentOrA2AKey({...})` a ser un array:
  ```text
  preHandler: [
    gaslessCostEstimatorPreHandler,  // NUEVO — stage A
    ...requirePaymentOrA2AKey({ description: '...' }), // stage B
  ],
  ```
  Definir `gaslessCostEstimatorPreHandler` arriba en el mismo módulo
  (función pura — recibe `request, reply`, llama helpers de
  `src/lib/price.ts`, valida, setea o 400/403).

**Paralelizable con W3**: SI (W3 es tests de gasless route, depende de W2).

### W3 — Tests de integración `src/routes/gasless.test.ts`

**Objetivo**: tests con `fastify.inject` cubriendo AC-1..AC-7 +
edge cases.

**Archivos**:
- `src/routes/gasless.test.ts` (NUEVO) — tests T-DRAIN-1..T-DRAIN-8
  (ver §5).

### W4 — Tests del middleware actualizados

**Objetivo**: agregar 2 tests al `src/middleware/a2a-key.test.ts`
verificando que el middleware lee correctamente el campo opcional.

**Archivos**:
- `src/middleware/a2a-key.test.ts` — agregar `describe('WKH-59 cost
  estimation injection', ...)` con 2 tests T-MW-GASLESS-1..2.

### W5 — Documentación `.env.example`

**Objetivo**: documentar las dos nuevas env vars en `.env.example`.

**Archivos**:
- `.env.example` — nueva sección `# ─── Gasless Pricing (WKH-59) ────`
  con `PYUSD_USD_RATE=1.0` y `GASLESS_DEFAULT_CAP_USD=10` + docstrings
  estilo `fee-charge.ts:80-110`.

---

## 5. Plan de tests (20 tests nuevos)

### T-PRICE-* — Helpers puros (`src/lib/price.test.ts`)

| ID | Caso | Esperado |
|---|---|---|
| T-PRICE-1 | `getPyusdUsdRate()` con env unset | retorna `1.0` |
| T-PRICE-2 | `getPyusdUsdRate()` con `PYUSD_USD_RATE=""` | retorna `1.0` (no warn) |
| T-PRICE-3 | `getPyusdUsdRate()` con `PYUSD_USD_RATE="abc"` | retorna `1.0` + warn |
| T-PRICE-4 | `getPyusdUsdRate()` con `PYUSD_USD_RATE="-1"` | retorna `1.0` + warn (out of range) |
| T-PRICE-5 | `getPyusdUsdRate()` con `PYUSD_USD_RATE="0.97"` | retorna `0.97` |
| T-PRICE-6 | `pyusdWeiToUsd(1_000_000n)` con rate=1.0 | retorna `1.0` (1 PYUSD = $1) |
| T-PRICE-7 | `pyusdWeiToUsd(0n)` | retorna `0` |
| T-PRICE-8 | `pyusdWeiToUsd(2n ** 60n)` (overflow) | retorna `Infinity` (no throws) |
| T-PRICE-9 | `getGaslessDefaultCapUsd()` con env unset | retorna `10` |
| T-PRICE-10 | `getGaslessDefaultCapUsd()` con `GASLESS_DEFAULT_CAP_USD="0"` | retorna `10` + warn (range exclusive) |

### T-DRAIN-* — Integración route (`src/routes/gasless.test.ts`)

| ID | Caso | Esperado | AC |
|---|---|---|---|
| T-DRAIN-1 | Body válido, value=`5_000_000` ($5), key con $100 budget | HTTP 200, debit=$5 | AC-1 |
| T-DRAIN-2 | Body con value=`50_000_000` ($50) > cap $10 default | HTTP 403, `error_code: 'PER_CALL_LIMIT'`, NO transfer | AC-2 |
| T-DRAIN-3 | Body con value=`5_000_000` ($5), key con budget $1 (insuficiente) | HTTP 403, `error_code: 'INSUFFICIENT_BUDGET'`, NO transfer | AC-3 |
| T-DRAIN-4 | Body con value=`5_000_000` ($5), key con `daily_limit_usd=2` y `daily_spent_usd=0` | HTTP 403, `error_code: 'DAILY_LIMIT'` (la PG function la genera) | AC-4 |
| T-DRAIN-5 | Body con value=`"not-a-bigint"` | HTTP 400 antes del middleware | AC-6 |
| T-DRAIN-6 | Body sin `value` (`{ to: "0x..." }`) | HTTP 400 | AC-6 |
| T-DRAIN-7 | Body válido, transfer exitoso | logueo estructurado de `{keyId, estimatedCostUsd, actualValueWei, to, txHash}` (verificar via `app.log` spy) | AC-7 |
| T-DRAIN-8 | Body con value cuya conversión USD == cap exacto ($10.00 con rate=1.0) | HTTP 200 (límite inclusivo) | AC-2 boundary |

### T-MW-GASLESS-* — Middleware (`src/middleware/a2a-key.test.ts`)

| ID | Caso | Esperado | AC |
|---|---|---|---|
| T-MW-GASLESS-1 | Request SIN `gaslessEstimatedCostUsd` (rutas normales) | middleware debita $1 (placeholder, regresión) | AC-5 |
| T-MW-GASLESS-2 | Request CON `gaslessEstimatedCostUsd=5.0` | middleware debita $5 | AC-1 (vía middleware) |

---

## 6. Exemplars verificados

| Patrón | Exemplar | Uso |
|---|---|---|
| Env-backed helper con guard + fallback | `src/services/fee-charge.ts:90-110` (`getProtocolFeeRate`) | Replicar shape para `getPyusdUsdRate` y `getGaslessDefaultCapUsd` |
| Debit per-request | `src/services/budget.ts:47-63` (`debit(keyId, chainId, amountUsd)`) | El middleware ya lo usa; pasamos costo correcto, no tocamos el service |
| Augment FastifyRequest | `src/middleware/a2a-key.ts:22-26` (`a2aKeyRow?`) | Replicar pattern para `gaslessEstimatedCostUsd?` |
| Pino structured log | `src/routes/gasless.ts:19-23` (`fastify.log.error({errorClass}, ...)`) | Replicar para AC-7 success log |
| Test mock spyOn | `src/middleware/a2a-key.test.ts:31-37` (`vi.mock('../services/budget.js')`) | Reusar mocks existentes para T-MW-GASLESS-* |
| 403 shape consistency | `src/middleware/a2a-key.ts:38-45` (`send403`) | Replicar shape `{error, error_code}` en el preHandler stage A |

---

## 7. Readiness Check (F2 → SPEC_APPROVED)

- [x] Todos los archivos referenciados existen y fueron leídos.
- [x] Todos los `[NEEDS CLARIFICATION]` del work-item están resueltos
      (DT-1 → DT-A, DT-2 → DT-B, DT-3 → DT-C, DT-4 → DT-F, DT-5 → DT-G).
- [x] Constraint Directives heredados + nuevos (CD-1 a CD-12).
- [x] Waves W0..W5 con paths exactos.
- [x] 20 tests planeados (T-PRICE-1..10, T-DRAIN-1..8, T-MW-GASLESS-1..2).
- [x] Exemplars verificados con `Read`.
- [x] Stack respetado: viem only (no se toca el adapter), TypeScript strict,
      Fastify preHandlers, vitest, Pino logging, env-backed config.
- [x] Auto-Blindaje histórico revisado: AB-WKH-57 (mock chain con
      múltiples `.eq` — N/A directamente, aplica solo si extendemos
      mocks de Supabase), AB-WKH-44 (env guard pattern — patrón replicado),
      AB-WKH-61 (timing post-resolve — no aplica, esto es bug de pricing,
      no de scoping).

**SDD listo para SPEC_APPROVED.**
