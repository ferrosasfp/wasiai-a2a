# Work Item — [WKH-59] [SEC-DRAIN-1] /gasless/transfer permite drain del operator wallet con $1 budget

## Resumen

`POST /gasless/transfer` (`src/routes/gasless.ts:30-67`) está protegido por
`requirePaymentOrA2AKey` pero el middleware **debita un placeholder fijo de
`estimatedCostUsd = 1.0` USD** (`src/middleware/a2a-key.ts:115`) sin importar
cuánto valor on-chain transfiere realmente la request. El handler luego
construye `BigInt(body.value)` (línea 55) y lo envía vía
`getGaslessAdapter().transfer({...})` desde el operator wallet
(`OPERATOR_PRIVATE_KEY`).

Esto permite a cualquier holder de un A2A key con **al menos $1 de budget
PYUSD** (chain 2368) ejecutar transfers de monto arbitrario desde el
operator wallet hacia una dirección controlada por el atacante, drenando
todo el saldo PYUSD del operator wallet con un coste para el atacante de
$1 por request. Equivale a un **bypass total del control de presupuesto**:
el budget protege la API pero NO los fondos on-chain que la API moviliza.

**Severidad**: BLQ-HIGH del security audit 2026-04-27. Afecta directamente
los fondos del operator wallet en mainnet/testnet. Vector activo desde la
introducción de WKH-54 (auth obligatoria pero sin pricing real).

**Vector concreto**:
1. Atacante registra agent key con `daily_limit_usd = 100` y deposita $1
   en chain `2368` (`a2a_agent_keys.budget = {"2368": "1.0"}`).
2. Atacante invoca `POST /gasless/transfer` con
   `{ to: "0xATACKER", value: "999999000000" }` (≈ 999,999 PYUSD en wei
   con 6 decimals).
3. Middleware debita $1 USD del budget → `success: true`.
4. Handler ejecuta `transfer` con `value = 999_999_000_000n` desde el
   operator wallet hacia `0xATACKER`.
5. El operator wallet pierde ~999,999 PYUSD. El atacante gastó $1.

## Sizing

- SDD_MODE: full
- Estimación: M
- Branch sugerido: `feat/061-wkh-59-sec-drain-1`
- Flow: QUALITY

## Skills relevantes

- `security-financial` — debit-before-execute coherente con el costo real
- `service-layer` — separar pricing del middleware (per-route override)

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `POST /gasless/transfer` recibe un body con
  `value` en wei representando un monto en USD ≤ `estimatedCostUsd`
  computed (cap por defecto `GASLESS_DEFAULT_CAP_USD`), the system SHALL
  ejecutar el transfer normalmente y debitar **el costo real estimado en USD**
  (no el placeholder $1).

- **AC-2**: WHEN `POST /gasless/transfer` recibe un body con
  `value` cuya conversión a USD excede `GASLESS_DEFAULT_CAP_USD` (default
  `10`), the system SHALL retornar HTTP 403 con
  `error_code: 'PER_CALL_LIMIT'` y NO ejecutar el transfer.

- **AC-3**: WHEN `POST /gasless/transfer` recibe un body con
  `value` cuya conversión a USD excede el budget restante de la key
  (`budget[2368] - daily_spent_usd`), the system SHALL retornar HTTP 403
  con `error_code: 'INSUFFICIENT_BUDGET'` y NO ejecutar el transfer.

- **AC-4**: WHEN `POST /gasless/transfer` recibe un body con `value`
  cuya conversión excede `daily_limit_usd - daily_spent_usd`, the system
  SHALL retornar HTTP 403 con `error_code: 'DAILY_LIMIT'` y NO ejecutar
  el transfer.

- **AC-5**: WHEN el middleware `requirePaymentOrA2AKey` corre para una
  ruta SIN override de pricing (e.g. `POST /compose`), the system SHALL
  conservar el comportamiento actual (`estimatedCostUsd = 1.0` placeholder)
  — backward-compat con el resto del codebase.

- **AC-6**: WHEN un atacante intenta invocar `POST /gasless/transfer`
  con un body que dispare `BigInt(body.value)` exception (e.g.
  `value="not-a-number"`), the system SHALL retornar HTTP 400 ANTES de
  llamar al middleware o al adapter.

- **AC-7**: WHEN se ejecuta exitosamente el transfer, the system SHALL
  loguear (con `request.log.info` estructurado) los campos
  `{ keyId, estimatedCostUsd, actualValueWei, to, txHash }` para
  auditoría.

- **AC-8**: WHEN `PYUSD_USD_RATE` env var no está seteada o tiene un valor
  inválido (NaN, negativo, fuera del rango `[0, 100]`), the system SHALL
  usar `1.0` como fallback (PYUSD es stablecoin 1:1 USD por diseño) y
  loguear un warn estructurado.

- **AC-9**: WHEN `GASLESS_DEFAULT_CAP_USD` env var no está seteada o tiene
  un valor inválido (NaN, ≤0, > 10000), the system SHALL usar `10` como
  fallback y loguear un warn estructurado.

## Scope IN

- `src/lib/price.ts` — **NUEVO**. Helper puro `pyusdWeiToUsd(valueWei: bigint): number`
  + `getPyusdUsdRate(): number` (lee env, fallback 1.0, range [0, 100]).
  Sin dependencias de Fastify/DB.
- `src/lib/price.test.ts` — **NUEVO**. Unit tests del helper puro.
- `src/routes/gasless.ts` — **MOD**. El `preHandler` agrega un step que
  computa `estimatedCostUsd = pyusdWeiToUsd(BigInt(body.value))` y lo
  guarda en un campo del request (e.g. `request.gaslessEstimatedCostUsd`)
  ANTES de ejecutar `requirePaymentOrA2AKey`. Se valida cap
  `≤ GASLESS_DEFAULT_CAP_USD` retornando 403 PER_CALL_LIMIT antes del
  middleware.
- `src/routes/gasless.test.ts` — **NUEVO**. Tests de integración con
  `fastify.inject` cubriendo AC-1..AC-7.
- `src/middleware/a2a-key.ts` — **MOD**. El placeholder `estimatedCostUsd = 1.0`
  (línea 115) cambia a leer **un campo opcional del request**
  (`request.gaslessEstimatedCostUsd` u análogo) y, si está presente,
  lo usa; sino mantiene el placeholder $1 (backward-compat).
- `src/middleware/a2a-key.test.ts` — **MOD**. Agregar 2 tests cubriendo:
  (a) middleware sin el campo extra → debit $1 (regresión); (b)
  middleware con el campo extra a $5 → debit $5.
- `.env.example` — **MOD**. Agregar `PYUSD_USD_RATE` y
  `GASLESS_DEFAULT_CAP_USD` con docs explicativos.

## Scope OUT

- NO modificar el shape de la tabla `a2a_agent_keys`.
- NO modificar la lógica del adapter `getGaslessAdapter()` ni el flow
  EIP-3009 (W4 sigue intacto).
- NO cambiar el comportamiento del middleware para rutas distintas a
  `/gasless/transfer` (`/compose`, `/orchestrate`, `/auth/*`, etc.).
- NO agregar oracle on-chain de precio (PYUSD es 1:1 USD por diseño,
  diferencia cubierta por `PYUSD_USD_RATE` env override para futuros
  depegs).
- NO modificar `daily_limit_usd` ni el column name en DB; el SDD usa
  el nombre real `daily_limit_usd` (NO `max_spend_per_day_usd` que es
  un nombre que NO existe en el schema).
- NO romper baseline de 532 tests verde (CD-4 estricto).

## Decisiones técnicas

- **DT-1**: Conversión wei → USD para PYUSD. PYUSD tiene 6 decimals
  on-chain; precio nominal 1.0 USD. Fórmula:
  `valueUsd = Number(valueWei) / 1e6 * PYUSD_USD_RATE`. Para evitar
  pérdida de precisión en BigInt → Number (PYUSD raramente excede
  `Number.MAX_SAFE_INTEGER`), el helper acepta hasta `2^53` wei y retorna
  Infinity para magnitudes superiores (que el cap rechazará). [resuelto en F2]

- **DT-2**: Cap por defecto. Sin cap, un atacante con $10K de budget
  podría drenar $10K. El cap `GASLESS_DEFAULT_CAP_USD = 10` (configurable)
  acota cada call individualmente a $10 USD (PYUSD). Las rutas existentes
  ya tienen `max_spend_per_call_usd` opcional por key; el cap GLOBAL es un
  límite adicional para esta ruta de alto riesgo. Range válido `(0, 10000]`.
  [resuelto en F2]

- **DT-3**: Separación route-vs-middleware. El cómputo del costo real
  vive en el `preHandler` de la ruta `/gasless/transfer` (donde el body
  está parseado) y se "inyecta" como un campo del request que el
  middleware consume. Razón: el middleware no debería conocer la semántica
  de cada ruta (qué representa "value", qué token, qué decimals).
  Alternativa descartada: refactor del middleware a "factory con cost
  estimator" — scope creep para un fix de seguridad. [resuelto en F2]

- **DT-4**: Schema column name. El campo de límite diario en
  `a2a_agent_keys` es **`daily_limit_usd`** (verificado en
  `supabase/migrations/20260406000000_a2a_agent_keys.sql:16`) —
  **NO** `max_spend_per_day_usd`. La PG function `increment_a2a_key_spend`
  ya enforce este límite atómicamente con `FOR UPDATE`. **No tocar la
  migration.** [resuelto en F2]

- **DT-5**: Post-tx accounting. PYUSD es stablecoin pegada 1:1 → el
  costo real estimado pre-tx coincide con el costo real post-tx (no hay
  slippage, no hay gas pagado por el caller en gasless). Por construcción,
  `actualCostUsd === estimatedCostUsd`. NO es necesario un debit
  correctivo post-tx. [resuelto en F2]

## Constraint Directives

- **CD-1**: PROHIBIDO debitar `1.0` USD fijo cuando la ruta moviliza
  fondos on-chain de monto arbitrario controlado por el caller. El debit
  DEBE reflejar el costo real estimado en USD del transfer.

- **CD-2**: PROHIBIDO ejecutar `getGaslessAdapter().transfer(...)` sin
  haber validado el cap `GASLESS_DEFAULT_CAP_USD` y sin haber pasado por
  el debit del middleware con el costo correcto.

- **CD-3**: OBLIGATORIO mantener backward-compat: rutas distintas a
  `/gasless/transfer` siguen recibiendo `estimatedCostUsd = 1.0`
  placeholder en el middleware (no podemos romper 532 tests existentes).

- **CD-4**: OBLIGATORIO baseline 532 tests verde. ~20 tests nuevos
  (T-PRICE-1..10 + T-DRAIN-1..8 + T-MW-GASLESS-1..2) → ~552 total.

- **CD-5**: PROHIBIDO hardcodear el cap, el rate o el chain id.
  `GASLESS_DEFAULT_CAP_USD` y `PYUSD_USD_RATE` son env vars con
  fallback explícito y guard `Number.isFinite`.

- **CD-6**: PROHIBIDO usar `any` o `as unknown as X` en el helper de
  pricing. Tipos estrictos: `(valueWei: bigint) => number`.

## Missing Inputs

- [resuelto en F2] Confirmar que `decimals(PYUSD on chain 2368) === 6`
  (canonical PYUSD spec en testnet) — verificable en
  `.env.example:75-79` y en `gasless-signer.ts`.

- [resuelto en F2] Confirmar si el cap por defecto `$10` es suficientemente
  conservador para los casos de uso reales del operator wallet — el
  hackathon usa transfers de monto bajo, $10 es razonable. Un caller que
  necesite más DEBE elevarlo vía env (`GASLESS_DEFAULT_CAP_USD=50`) o
  refactor futuro para per-key override.

## Análisis de paralelismo

- HU bloqueante para cualquier deploy a producción que tenga
  `GASLESS_ENABLED=true` y un balance no-trivial en el operator wallet.
- No bloquea otras HUs activas (no toca compose/orchestrate/registries).
- Puede ejecutarse en paralelo con WKH-60 (SEC-RCE-1, transform cache)
  y WKH-63 (SEC-REG-1, registries CRUD).
