# SDD #072: [BUG] Balance-gate decimals mismatch — PYUSD inbound vs USDC outbound (WKH-67)

> SPEC_APPROVED: no
> Fecha: 2026-04-29
> Tipo: bugfix
> SDD_MODE: bugfix
> Branch: `fix/072-wkh-67-balance-gate-decimals` (desde `main@b095b80`)
> Artefactos: `doc/sdd/072-wkh-67-balance-gate-decimals/`
> Predecesor con regression: `doc/sdd/071-wkh-66-prod-hardening/` (DONE 2026-04-29).
> Approach cementado en F1: **Approach A** — balance-gate INSIDE `payX402Handler` post-probe / pre-cap-guard.

---

## 1. Resumen del bug

WKH-66 (`api/mcp.mjs:106-194`, `runWithBalanceGate`) shippeo el balance-gate del operator wallet (Avalanche C-Chain mainnet, USDC, 6 decimales) **reusando el argumento `args.maxAmountWei`** introducido en WKH-64 AC-11 como sign guard sobre INBOUND PYUSD wei (Kite testnet, 18 decimales). El mismo nombre + dos dimensiones radicalmente distintas (10^18 vs 10^6) es matemáticamente irresoluble: NO existe un único valor que satisfaga ambos checks. Resultado en mainnet: 100% de los `pay_x402` rebotan en `stage:'balance-gate'`.

El fix mueve el balance-gate INSIDE `payX402Handler` post-probe pre-cap-guard, deriva el OUTBOUND USDC wei desde `payload.maxBudget` (USDC number declarado por el caller), y mantiene el cap guard PYUSD intacto sobre `args.maxAmountWei`. Cada guard opera en su propia dimensión sin acoplamiento. El wrapper `runWithBalanceGate` se elimina.

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 072 |
| **Tipo** | bugfix |
| **SDD_MODE** | bugfix |
| **Objetivo** | Separar balance-gate (USDC 6d outbound) y sign guard (PYUSD 18d inbound), restaurar payment path operativo en mainnet, preservar 6 BLQs históricos cerrados (WKH-64/65/66). |
| **Reglas de negocio** | Heredadas de WKH-66: fail-secure inviolable, atomic claim, snapshot freshness 30s, threshold validado, rate-limit fail-open, auth-first ordering. |
| **Scope IN** | `src/handlers.mjs` (modificar `payX402Handler` + `TOOL_DESCRIPTORS.pay_x402.description/inputSchema`), `api/mcp.mjs` (eliminar `runWithBalanceGate` + simplificar case 'pay_x402'), `src/balance-guard.mjs` (export `_usdcToWei` desde `_testHelpers` o nuevo helper público), tests nuevos `tests/handlers-balance-gate.test.mjs`, modificación menor `tests/balance-guard.test.mjs` T-BG-11/T-BG-11b, `README.md` doc. |
| **Scope OUT** | `src/sign.mjs`, `src/url-validator.mjs`, `src/auth.mjs`, `src/log.mjs`, `src/config.mjs`, `src/index.mjs`, `src/kv-client.mjs`, `src/rate-limit.mjs`, `src/cron-auth.mjs`, `src/alerts.mjs`, `src/avax-client.mjs`, `api/cron/*`, `vercel.json`, `package.json`, schema MCP `pay_x402` (NO breaking change), threshold $0.50 USDC, RPC URL, USDC contract address. |
| **Missing Inputs** | 0 sin resolver (los 6 NEEDS CLARIFICATION de F1 quedan resueltos en §10 abajo). |

---

## 3. Reproducción del bug

### Repro steps (ya documentado en work-item.md)

1. Deploy WKH-66 a `wasiai-x402-mcp.vercel.app/api/mcp`.
2. Smoke real con `payload.maxBudget = 0.5` (USDC) y SIN `args.maxAmountWei`.
3. Resultado: `runWithBalanceGate` (`api/mcp.mjs:159-162`) retorna `{ ok: false, stage: 'balance-gate', error: 'maxAmountWei required (balance gate cannot reserve a claim without it)' }`.
4. Variantes:
   - Con `maxAmountWei = 1_000_000_000_000_000_000` (PYUSD wei) → `concurrent claim exceeded` (intenta reservar 10^18 USDC wei = $10^12).
   - Con `maxAmountWei = 100_000` (USDC wei) → pasa el balance-gate pero el cap guard falla con `amount exceeds maxAmountWei guard` (challenge PYUSD = 10^18).

### Actual

100% de `pay_x402` calls rebotan. Deploy funcionalmente broken. ROLLBACK manual a `wasiai-x402-ah0gufv0p` (deploy WKH-65). Cron-job.org disabled.

### Expected (post-fix)

Caller invoca `pay_x402` con `payload: {..., maxBudget: 0.5}` (USDC number) sin pasar `maxAmountWei`. El handler:

1. Sanitize → endpoint validation → probe (sin firma, redirect:'error'),
2. Parsea `accepts[0]`,
3. **Balance-gate INSIDE handler**: deriva `requestedWei = _usdcToWei(0.5)` = `500_000n` USDC wei → `checkBalanceWithClaim({ requestedWei: 500_000n, threshold: 0.5, ... })`,
4. Si OK → cap guard PYUSD (sin cambios) → sign → settle.
5. `releaseClaim` se invoca exactamente una vez en `try/finally` interno, sin importar el outcome de sign/settle.

Retorna `{ ok: true, stage: 'settled', kiteTxHash: '0x...', latencyMs: ... }`.

---

## 4. Context Map (Codebase Grounding)

### 4.1 Archivos leídos

| Archivo | Por qué | Hallazgo / patrón extraído |
|---------|---------|-----------------------------|
| `mcp-servers/wasiai-x402/src/handlers.mjs:262-482` | Estructura actual de `payX402Handler` (probe → cap guard → sign → settle). | El flow tiene 4 bloques numerados (1) probe (línea 297-339), (2) cap guard (línea 359-380), (3) sign (línea 382-417), (4) settle (línea 425-471). El insertion point para balance-gate es **entre línea 343 (`if (!accepts...)`) y línea 359 (`// [2] Cap guard`)**. NO hay try/finally interno hoy — los returns son directos. El handler retorna `{ ok, stage, ...}` con shape estable. |
| `mcp-servers/wasiai-x402/src/balance-guard.mjs:120-261` | API pública de `checkBalanceWithClaim` y `releaseClaim`. | Firma actual: `checkBalanceWithClaim({ operator, chainId, requestedWei: bigint, threshold: number, kvClient, publicClient, usdcAddress, claimTtlSec?, snapshotTtlSec? })`. Retorna `{ ok: true, claimId, claimKey, balanceUsdc, claimedTotalWei }` o `{ ok: false, stage: 'balance-gate', error }`. `_usdcToWei` (línea 70-76) ya está implementado y export-eado vía `_testHelpers` (línea 264). Conversión via string `toFixed(6)` evita float-precision. Validación interna: `requestedWei` ≥ 1n (línea 141). `releaseClaim` (línea 254-261) es best-effort, never throws. |
| `mcp-servers/wasiai-x402/api/mcp.mjs:106-194,222-227` | Wrapper actual `runWithBalanceGate` + call site. | Wrapper hace: (a) deriva `operator` de `cfg.operatorAddress` (b) parsea env `MCP_OPERATOR_CHAIN_ID`, `AVALANCHE_USDC_ADDRESS`, `AVALANCHE_RPC_URL`, `MCP_BALANCE_THRESHOLD_USDC` con guard `Number.isFinite + ≥0` (c) requiere `args.maxAmountWei` non-null (línea 156-167) — **éste es el bug raíz** (d) llama `checkBalanceWithClaim` (e) try/finally con `releaseClaim`. **TODO ESTE BLOQUE SE MUEVE A `payX402Handler`** con `requestedWei` derivado de `payload.maxBudget` en lugar de `args.maxAmountWei`. |
| `mcp-servers/wasiai-x402/src/index.mjs:89-115` | Stdio bootstrap. | El path stdio invoca `payX402Handler(args, cfg)` directamente SIN balance-gate (`src/index.mjs:101-104`). Hoy el stdio NO está protegido por balance-gate — solo HTTP. **Beneficio colateral del fix**: al mover el gate INSIDE `payX402Handler`, ambos transportes quedan protegidos sin tocar `src/index.mjs`. Refuerza CD-3/CD-4 (reuse invariante stdio↔HTTP). |
| `mcp-servers/wasiai-x402/tests/concurrent-stress.test.mjs:32-147` | T-CS-01 + T-CS-02 baseline (concurrent + stale snapshot). | T-CS-01 ataca `checkBalanceWithClaim` directamente con `requestedWei = usdc(0.1)` = 100_000n (USDC 6d). T-CS-02 ataca el mismo módulo con stale snapshot. **Estos tests NO usan `runWithBalanceGate` ni `payX402Handler` — testean `balance-guard.mjs` directamente — por lo cual NO requieren modificación.** El fix no toca `balance-guard.mjs` semánticamente, solo agrega un export. T-CS-01/T-CS-02 SHALL pasar idénticos. |
| `mcp-servers/wasiai-x402/tests/http.test.mjs:624-763` | T-HTTP-13/14/15 (rate limit + balance-gate integration). | T-HTTP-14 (línea 660-718) testea el balance-gate via HTTP transport pasando `maxAmountWei: '100000'` y mockeando RPC con balance 0.4 USDC → rechaza con `below threshold`. **Este test debe ACTUALIZARSE**: el caller ya no pasa `maxAmountWei` para el balance-gate; pasa `payload: {..., maxBudget: 0.5}`. El assert sigue siendo el mismo (`stage:'balance-gate'`, `error:/below threshold/`). T-HTTP-13/15 no se tocan. |
| `mcp-servers/wasiai-x402/tests/balance-guard.test.mjs:286-321` | T-BG-11/T-BG-11b (threshold env validation). | Estos tests importan `runWithBalanceGate` desde `api/mcp.mjs` (línea 20). **Como el wrapper se elimina, estos tests deben re-targetar a `payX402Handler` o moverse al nuevo `tests/handlers-balance-gate.test.mjs`.** La lógica de validación de threshold se mueve dentro de `payX402Handler` (mantener semántica idéntica). T-BG-01 a T-BG-10 NO se tocan (testean `balance-guard.mjs` direct). |
| `mcp-servers/wasiai-x402/tests/tools.test.mjs:175-210` | T29 (AC-3 happy path con cap guard) — exemplar para tests nuevos. | Patrón: `makeFetchFake([{status:402,body:{accepts:[{...,maxAmountRequired:'1000000000000000000'}]}}, {status:200,body:{...}}])` + `globalThis.fetch = fetchFn` + `payX402Handler({endpoint:'/api/v1/x', payload:{...}}, fakeConfig())`. Validates ACs sin tocar HTTP transport. **Este es el exemplar canónico para los tests nuevos del fix.** |
| `doc/sdd/071-wkh-66-prod-hardening/auto-blindaje.md` | 5 lecciones documentadas WKH-66. | Recurrentes a heredar: (a) Redis-TTL ≠ data freshness (BLQ-ALTO-1) — el fix NO debe romper la freshness check; (b) threshold env not validated → `parseFloat` silent NaN — preservar guard `Number.isFinite + ≥0`; (c) test fixtures con `setTimeout` orphan → no aplica este fix; (d) `event:` clobber en log payload — heredado CD-17. |
| `doc/sdd/070-wkh-65-mcp-vercel-deploy/auto-blindaje.md` | 7 lecciones WKH-65. | Recurrentes a heredar: (a) auth-first ordering (DoS via DNS) — el fix NO toca el orden; (b) `event:` in log fields clobbers canonical event — CD-17 inviolable; (c) CORS Vary header — el fix NO toca CORS. |
| `doc/sdd/069-wkh-64-mcp-x402/auto-blindaje.md` | 8 lecciones WKH-64. | Recurrentes a heredar: (a) backslash bypass `isPathOnly` (BLQ-iter2-1) — el fix NO toca `resolveEndpoint`; (b) `redirect:'error'` BLQ-iter3-1 — preservar las 4 llamadas `fetch()` con redirect:'error'; (c) viem internals leak — sign error sanitization sigue intacta; (d) signature 4-char truncation — heredado por log.mjs. |

### 4.2 Patrón de error recurrente identificado (Auto-Blindaje histórico)

Reviewed las últimas 3 HUs DONE con auto-blindaje (069, 070, 071). Patrón recurrente que aplica este fix:

- **Recurrent-1 (4 HUs: 064, 069, 070, 071)**: confianza ciega en input externo / env var / mock fixture sin validación dimensional. Manifestaciones: `parseFloat('abc') → NaN` (071), `event:` clobber payload (069/070), `setTimeout` orphan en mock (071), backslash bypass URL parser (069). **Aplicación a WKH-67**: el bug raíz es exactamente el mismo class — confianza ciega en que `args.maxAmountWei` significa lo mismo en dos contextos. CD-20 nuevo cementa la lección.

- **Recurrent-2 (3 HUs: 069, 070, 071)**: tests que pasan por la razón equivocada (T-CH-11 testing wrong thing en 071, canned-response order en concurrent test de 069). **Aplicación a WKH-67**: los tests nuevos deben verificar que el balance-gate efectivamente corre con el `requestedWei` correcto (USDC 6d), no asumir que pasa porque el assert final coincide.

- **Recurrent-3 (4 HUs)**: `redirect:'error'` + sign error sanitization + PK never leaked. **Aplicación a WKH-67**: mover código de un archivo a otro NO debe romper estos invariants. AR debe verificar que las 4 llamadas `fetch()` siguen con `redirect:'error'` y que el sign catch sigue retornando `'signing failed (see stderr logs)'`.

### 4.3 Exemplars verificados

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `src/handlers.mjs::payX402Handler` (insert balance-gate post-probe) | `api/mcp.mjs::runWithBalanceGate` (líneas 106-194) | Mismo flujo: derivar operator/chainId/usdcAddress/rpcUrl/threshold de cfg+env, llamar `checkBalanceWithClaim`, try/finally con `releaseClaim`. Solo cambia `requestedWei` (de `args.maxAmountWei` → `_usdcToWei(payload.maxBudget)`) y la ubicación del bloque. |
| `tests/handlers-balance-gate.test.mjs` (NEW) | `tests/tools.test.mjs:175-210` (T29 happy path) | Mismo patrón: `makeFetchFake` → override `globalThis.fetch` → `setKvClientForTesting(createKvMock())` → `process.env.MCP_BALANCE_THRESHOLD_USDC = '0.5'` → llamar `payX402Handler({endpoint, payload:{maxBudget}}, fakeConfig())`. Para mock de RPC (eth_call), patrón de `tests/http.test.mjs:673-684` (intercept `globalThis.fetch` para `avax.network`). |
| Test de validación `payload.maxBudget` adversarial | `tests/balance-guard.test.mjs:286-321` (T-BG-11 NaN/negative threshold) | Pattern: `process.env.X = 'abc' → assert.equal(result.stage, 'balance-gate') + assert.match(result.error, /invalid/i) + assert.equal(handlerCalled, false)`. Aplicar a `payload.maxBudget = NaN/Infinity/-1/0/'string'/null/{}/[]`. |
| Test concurrent stress sin modificar T-CS-01/02 | N/A — no se tocan | T-CS-01/02 testean `checkBalanceWithClaim` directamente con `requestedWei: usdc(0.1)` (USDC 6d). El fix NO cambia la API del módulo, solo dónde se invoca. Pasan idénticos. |
| Update T-HTTP-14 (balance-gate via HTTP) | T-HTTP-14 actual (`tests/http.test.mjs:660-718`) | Cambiar el body del JSON-RPC: en lugar de `arguments: { endpoint, maxAmountWei: '100000' }`, pasar `arguments: { endpoint, payload: { maxBudget: 0.1 } }`. RPC mock + assert se preservan. |

### 4.4 Estado de BD relevante

N/A. Este fix NO toca Supabase ni Postgres. Solo Upstash Redis (KV) que ya existe.

### 4.5 Componentes reutilizables encontrados

- `_usdcToWei(usdcNumber)` en `src/balance-guard.mjs:70-76` ya existe — **promover de `_testHelpers` a export público** o exportar directamente. NO crear duplicado en `src/handlers.mjs`.
- `getKvClient()` en `src/kv-client.mjs` — reusar (ya importado en api/mcp.mjs:52).
- `getAvaxClient(rpcUrl)` en `src/avax-client.mjs` — reusar (singleton).
- `checkBalanceWithClaim` y `releaseClaim` — reusar sin modificar.

---

## 5. Análisis de causa raíz

### 5.1 Dónde está el bug

| Archivo | Línea/zona | Qué está mal |
|---------|-----------|-------------|
| `api/mcp.mjs` | 154-167 (extracción de `requestedWei`) | Lee `args.maxAmountWei` y lo trata como USDC 6d wei. PERO `args.maxAmountWei` semánticamente es PYUSD 18d wei (sign guard cap, AC-11 WKH-64). |
| `api/mcp.mjs` | 159-162 | Si `args.maxAmountWei == null` → reject ANTES del probe. Esto fuerza al caller a setear el arg, pero el caller no puede saber qué decimales pasar (PYUSD o USDC). |
| `src/handlers.mjs` | 359-380 | Cap guard usa `args.maxAmountWei` correctamente como PYUSD 18d. Sin cambios necesarios — el bug NO está acá; el bug está en el reuse del arg en `api/mcp.mjs`. |

### 5.2 Causa raíz

**Acoplamiento dimensional incorrecto**: WKH-66 asumió que `args.maxAmountWei` era un cap "natural" para usar como `requestedWei` del balance-gate sin verificar que la dimensión coincidiera con USDC outbound (6 decimales). El arg fue diseñado en WKH-64 para INBOUND PYUSD (18 decimales) — su único uso correcto es el cap guard pre-firma.

La fuente correcta del OUTBOUND USDC budget existe desde el flow `compose` original: `payload.maxBudget` (USDC number, declarado por el caller). Esta source-of-truth NO se usa en WKH-66.

### 5.3 Fix propuesto (sin código)

1. **Eliminar `runWithBalanceGate`** wrapper de `api/mcp.mjs` (líneas 106-194). El call site (líneas 222-227) se reduce a `payX402Handler(args, cfg)` directo (alineado con el path stdio en `src/index.mjs:101-104`).

2. **Insertar balance-gate INSIDE `payX402Handler`** entre el probe parsing (`src/handlers.mjs:343`) y el cap guard (`src/handlers.mjs:359`):
   - Validar `payload.maxBudget` con `Number.isFinite(x) && x > 0 && x < 1_000_000` (CD-22 nuevo).
   - Convertir `requestedWei = _usdcToWei(payload.maxBudget)`.
   - Derivar threshold/operator/chainId/usdcAddress/rpcUrl de cfg + env (mismo código que el wrapper actual).
   - Llamar `checkBalanceWithClaim({ requestedWei, threshold, ... })`.
   - Si `ok:false` → return tal cual.
   - Si `ok:true` → guardar `gate.claimKey` + `requestedWei` para release.

3. **Wrappear el resto del handler en `try { sign + settle } finally { releaseClaim }`** para garantizar AC-6 (release exactly-once).

4. **Validación de `payload.maxBudget`** ocurre **DESPUÉS del probe** (no antes — DT-5 resuelto en §10): el probe es input-agnostic (solo necesita endpoint válido) y free endpoints (200) no deben fallar por falta de maxBudget. Tras el probe, si stage = `'free'`, retornar sin validar `maxBudget`. Si stage = `'probe-non-402'`, retornar sin validar. Si tenemos `accepts[0]` válido, ENTONCES validar `payload.maxBudget` y correr el balance-gate.

5. **Update `TOOL_DESCRIPTORS.pay_x402`** (`src/handlers.mjs:514-530`) para documentar la separación de decimales en `description` e `inputSchema.properties.payload.properties.maxBudget`.

---

## 6. Acceptance Criteria (heredados literal de work-item.md, EARS)

> Los 15 ACs del work-item están aprobados (HU_APPROVED). NO se reformulan acá. Se referencian por número y se mapean a tests/waves en §9.

- **AC-1** Happy path: `payload.maxBudget=0.5` sin `maxAmountWei` → settled.
- **AC-2** Balance-gate opera EXCLUSIVAMENTE sobre USDC 6d outbound, derivado de `payload.maxBudget`.
- **AC-3** Sign guard opera EXCLUSIVAMENTE sobre PYUSD 18d inbound (sin cambios WKH-64 AC-11).
- **AC-4** `payload.maxBudget` undefined/null/NaN/string/≤0/>balance → reject `stage:'balance-gate'`.
- **AC-5** Ordering: input → endpoint validation → probe → parse `accepts[0]` → balance-gate → cap guard → sign → settle.
- **AC-6** `releaseClaim` exactamente UNA VEZ (try/finally interno).
- **AC-7** Fail-secure: balance read fail / KV null / `payload.maxBudget` invalid → reject pre-sign.
- **AC-8** Sin regresión BLQs históricos (WKH-64 W-BLQ-1..5, WKH-65 W-BLQ-iter3-1, WKH-66 W-BLQ-ALTO-1).
- **AC-9** `npm test` baseline ≥173 + nuevos del fix → 100% pass.
- **AC-10** Sec invariants: timing-safe bearer, rate-limit fail-open, balance-gate fail-secure, auth-first, no leak secrets.
- **AC-11** Re-deploy a Vercel con URL distinta al rolled-back.
- **AC-12** Smoke real ≤ $0.10 USDC mainnet, 1 tx documentada en done-report.
- **AC-13** Cron-job.org re-enable post-deploy.
- **AC-14** auto-blindaje.md con lección decimals separation.
- **AC-15** done-report.md con PR + deploy + tx hash + balance pre/post.

---

## 7. Diseño técnico

### 7.1 Archivos a modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `src/balance-guard.mjs` | Modificar (mínimo) | Promover `_usdcToWei` a export público (renombrar a `usdcToWei` o exportar directo). NO cambiar firma de `checkBalanceWithClaim` ni `releaseClaim`. | Patrón de exports `getOperatorBalance`, `releaseClaim` — `export function usdcToWei(usdcNumber)`. |
| `src/handlers.mjs` | Modificar | (a) Insertar balance-gate INSIDE `payX402Handler` entre línea ~343 y ~359. (b) Wrappear sign+settle en try/finally para `releaseClaim`. (c) Update `TOOL_DESCRIPTORS.pay_x402.description` + `inputSchema` para docs decimals separation. | `api/mcp.mjs::runWithBalanceGate` (líneas 106-194) provee la mecánica completa que se mueve. |
| `api/mcp.mjs` | Modificar | (a) Eliminar `runWithBalanceGate` (líneas 106-194). (b) Eliminar imports `checkBalanceWithClaim`, `releaseClaim` (línea 54-57) — ya no se usan acá. (c) Mantener `getAvaxClient` import si sigue usándose (chequear); si no, eliminar. (d) Simplificar case 'pay_x402' (línea 222-227) a `payX402Handler(args, cfg)`. | El path stdio (`src/index.mjs:101-104`) ya es la forma simplificada — copiar ese patrón. |
| `tests/handlers-balance-gate.test.mjs` | Crear | ≥8 tests cubriendo AC-1..AC-7 + invariants concurrency. | `tests/tools.test.mjs:175-210` (T29 makeFetchFake + payX402Handler). Para validación adversarial inputs: `tests/balance-guard.test.mjs:286-321` (T-BG-11). |
| `tests/balance-guard.test.mjs` | Modificar (mínimo) | T-BG-11/T-BG-11b importan `runWithBalanceGate` que se elimina. Decisión: **mover ambos tests a `tests/handlers-balance-gate.test.mjs`** y re-targetar al nuevo flow `payX402Handler`. T-BG-01..T-BG-10 NO se tocan. | T-BG-11 actual provee la lógica; copiar y adaptar imports. |
| `tests/http.test.mjs` | Modificar (mínimo) | T-HTTP-14 (línea 660-718): cambiar JSON-RPC body — `arguments: { endpoint, payload: { maxBudget: 0.1 } }` en lugar de `arguments: { endpoint, maxAmountWei: '100000' }`. T-HTTP-13 (rate-limit) y T-HTTP-15 (discover_agents bypass) NO se tocan. | Tests existentes preservan setup completo. |
| `README.md` | Modificar | Sección "Tools / pay_x402": documentar `payload.maxBudget` (USDC number, OBLIGATORIO si endpoint requiere pago) como source-of-truth para balance-gate; `args.maxAmountWei` (PYUSD wei opcional) solo cap defensivo del sign guard. Ejemplos con/sin `maxAmountWei`. | Sección actual de `pay_x402` en README. |

### 7.2 Insertion point exacto en `payX402Handler`

```
Línea ~343 (post probe parsing, post `if (!accepts || !accepts.payTo || !accepts.maxAmountRequired)`)
  ↓
[NUEVO BLOQUE]
[2-pre] Validate payload.maxBudget (CD-22):
  if (!Number.isFinite(maxBudget) || maxBudget <= 0 || maxBudget >= 1_000_000)
    return { ok:false, stage:'balance-gate', error:'invalid or missing payload.maxBudget' }

[2-pre] Derive balance-gate inputs:
  threshold = parseFloat(MCP_BALANCE_THRESHOLD_USDC ?? '0.50')
  if (!Number.isFinite(threshold) || threshold < 0)
    return { ok:false, stage:'balance-gate', error:'invalid threshold config' }
  chainId = parseInt(MCP_OPERATOR_CHAIN_ID ?? '43114', 10)
  usdcAddress = AVALANCHE_USDC_ADDRESS ?? '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'
  rpcUrl = AVALANCHE_RPC_URL ?? 'https://api.avax.network/ext/bc/C/rpc'
  operator = cfg.operatorAddress  (si missing → reject 'operator derivation failed')

[2-pre] Convert + claim:
  requestedWei = usdcToWei(maxBudget)  // imported from balance-guard.mjs
  kv = getKvClient()
  publicClient = getAvaxClient(rpcUrl)
  gate = await checkBalanceWithClaim({ operator, chainId, requestedWei, threshold, kvClient:kv, publicClient, usdcAddress })
  if (!gate.ok) return gate
  ↓
[INICIO try block para release]
  ↓
Línea ~359-380: [2] Cap guard PYUSD (UNCHANGED — sigue usando args.maxAmountWei)
Línea ~382-417: [3] Sign (UNCHANGED)
Línea ~425-471: [4] Settle (UNCHANGED)
  ↓
[FIN try block, INICIO finally]
  await releaseClaim({ claimKey: gate.claimKey, requestedWei, kvClient: kv })
[FIN finally]
  ↓
return result
```

### 7.3 Try/finally scope (DT-4 resuelto en §10)

El `try` envuelve **desde después del balance-gate exitoso HASTA el return final**, abarcando: cap guard, sign, settle, success path. El `finally` invoca `releaseClaim` exactamente una vez. Razón: AC-6 explicit "exactly UNA VEZ" — incluye happy path (success). El claim queda reservado durante todo el flow critical (sign + settle); si se libera antes del settle, una segunda call concurrente podría INCRBY hasta el límite mientras el primer settle aún corre, drainando la wallet.

**NOTA importante**: el cap guard puede retornar early (línea 372-380 actual: `if (guard !== undefined && requested > guard)`). Ese return DEBE pasar por el `finally` para liberar el claim. Patrón:

```
try {
  // cap guard return ⇒ throw or return inside try
  // sign return ⇒ same
  // settle return (incluye success) ⇒ same
} finally {
  await releaseClaim({...})  // siempre corre
}
```

### 7.4 Validación de `payload.maxBudget` — orden (DT-5 resuelto)

**Orden**: validación se ejecuta **DESPUÉS del probe**, ANTES del balance-gate (no antes del probe).

Razón:
1. Endpoint puede ser free (200) — el caller razonablemente puede invocar `pay_x402` sin saber si el endpoint es free; rechazar pre-probe por `maxBudget` faltante penaliza ese caso legítimo.
2. Endpoint puede no ser x402 (probe-non-402) — mismo razonamiento.
3. Endpoint puede ser inválido (validation error pre-probe) — ya lo rechazamos en líneas 271-293 sin llegar al balance-gate.
4. Solo si `accepts[0]` es válido, el balance-gate aplica → la validación de `maxBudget` es necesaria entonces.

Esto evita un breaking change para casos free + reduce falsa-fricción.

### 7.5 Source-of-truth para `requestedWei` (DT-6 resuelto)

**Decisión**: `payload.maxBudget` (USDC number declarado por caller) — NO `accepts[0].maxAmountRequired` traducido.

Razón:
1. `accepts[0].maxAmountRequired` está en moneda INBOUND (PYUSD wei sobre Kite). Traducirlo a USDC requiere oracle PYUSD/USDC → caja de Pandora (latency, oracle SSRF, oracle freshness).
2. `payload.maxBudget` es el ceiling natural declarado: "yo (caller) NO quiero gastar más de X USDC". El balance-gate reserva exactamente ese ceiling.
3. Si el caller miente (declara `maxBudget=999` con balance $4.756 USDC) — el balance-gate rechaza con `concurrent claim exceeded` o `below threshold`. El caller no puede drain.
4. Si el caller subdeclara (`maxBudget=0.01` pero `accepts[0].maxAmountRequired=$1 PYUSD ≈ $1 USDC`) — el sign guard PYUSD sobre `args.maxAmountWei` (si está seteado) atrapa esto. Sin `maxAmountWei`, el caller acepta gastar lo que el endpoint pida en INBOUND, pero la wallet está protegida porque el `maxBudget` ya reservó el OUTBOUND. **Esto es semánticamente correcto**: el OUTBOUND es lo que la operator wallet paga; el INBOUND es lo que el caller percibe. Documentar en README explícito.

### 7.6 maxAmountWei descriptor update (DT-9 resuelto)

Update `TOOL_DESCRIPTORS.pay_x402` (`src/handlers.mjs:514-530`):

- `description`: "Execute a full x402 payment flow: probe → balance-gate (USDC outbound) → sign EIP-3009 → retry. **Required**: payload.maxBudget (USDC number). **Optional**: maxAmountWei (PYUSD wei BigInt-string, defensive cap on INBOUND challenge)."
- `inputSchema.properties.payload`: agregar `properties.maxBudget: { type: 'number', description: 'OUTBOUND budget cap in USDC (e.g. 0.5). Required when endpoint requires payment. Used by balance-gate to reserve a claim against operator wallet (Avalanche C-Chain mainnet, USDC 6 decimals).' }`. NOTA: `payload` es type `object` con `additionalProperties: true` hoy (caller puede pasar cualquier body); agregar `maxBudget` como property documentada NO rompe el schema.
- `inputSchema.properties.maxAmountWei`: actualizar description: "Defensive cap on INBOUND challenge (e.g. PYUSD 18 decimals on Kite testnet). Optional. Independent of payload.maxBudget — guards against anomalous 402 challenges. Priority: per-call > MCP_MAX_AMOUNT_WEI_DEFAULT > undefined."

### 7.7 Smoke script (DT-7 resuelto)

**One-shot, NO idempotente**. CD-24 nuevo lo cementa. Reuse `mcp-servers/wasiai-x402/scripts/smoke-prod.mjs` o equivalente existente (verificar en F2.5/F3). Cada run cuesta plata real; protección via comment header explícito + revisión humana antes de re-run. NO en CI.

### 7.8 Cron re-enable (DT-8 resuelto)

`node scripts/setup-cronjob.mjs` (idempotente, WKH-66 AC-W1-1). NO se requiere script nuevo. F4 QA verifica via dashboard cron-job.org o re-ejecutando el script.

---

## 8. Constraint Directives

> Heredados literales de work-item.md (CD-1..CD-25). Ratificados por architect. NO se modifican en F2.

### CDs específicos a destacar para el Dev (subset crítico)

- **CD-1 (UPDATED WKH-67)**: PERMITIDO modificar `src/handlers.mjs` y `src/balance-guard.mjs` SOLO en el scope estricto del fix. Cualquier cambio fuera del insertion point post-probe / pre-cap-guard en `payX402Handler` y fuera del export de `usdcToWei` en `balance-guard.mjs` es BLOQUEANTE.
- **CD-20 (NEW)**: PROHIBIDO usar el mismo argumento como input de DOS guards en cadenas/decimales distintos. AR debe grep `args.maxAmountWei` (solo cap guard) y `payload.maxBudget` (solo balance-gate) — cross-uso es BLOQUEANTE.
- **CD-21 (NEW)**: balance-gate DESPUÉS del probe Y ANTES del cap guard. Otra ubicación es BLOQUEANTE.
- **CD-22 (NEW)**: validación `Number.isFinite(maxBudget) && maxBudget > 0 && maxBudget < 1_000_000`.
- **CD-23 (NEW)**: `releaseClaim` exactly-once via try/finally interno.
- **CD-24 (NEW)**: smoke ≤ $0.10 USDC, one-shot, documentado en done-report.
- **CD-25 (NEW)**: `auto-blindaje.md` OBLIGATORIO con lección decimals separation.

### Anti-Hallucination heredado (CD recurrente)

- **CD-recurrent-1**: NO inventar APIs. `_usdcToWei` ya existe en balance-guard.mjs:70 — usar (promover a public export). NO crear duplicado.
- **CD-recurrent-2**: las 4 llamadas `fetch()` en `src/handlers.mjs` (probe en discoverAgents línea 146, probe en getPaymentQuote línea 213, probe en payX402 línea 299, settle en payX402 línea 433) DEBEN preservar `redirect:'error'`.
- **CD-recurrent-3**: NO log `event:` dentro de payload de `log.{info,warn,error}` (CD-17 heredado). Logger toma event name del primer arg.
- **CD-recurrent-4**: sign error catch (`src/handlers.mjs:401-417`) preserva sanitización viem (BLQ-2 WKH-64) — solo `'OPERATOR_PRIVATE_KEY missing at sign-time'` se passthrough; resto → `'signing failed (see stderr logs)'`.
- **CD-recurrent-5**: signature truncation 4 chars en logs (`src/log.mjs` heredado).
- **CD-recurrent-6**: snapshot freshness 30s preserved (BLQ-ALTO-1 fix WKH-66) — el balance-gate llama `checkBalanceWithClaim` que ya implementa esto. NO tocar `src/balance-guard.mjs:148-184`.

---

## 9. Plan de Waves

### Wave 0 — Serial Gate (precondiciones)

- [ ] W0.1: Verificar branch `fix/072-wkh-67-balance-gate-decimals` desde `main@b095b80` (commit con regression). Confirmar baseline `npm test` antes del fix → 173+ tests pasando con el bug presente (los tests actuales NO ejercitan el escenario AC-1 happy path con `payload.maxBudget` sin `maxAmountWei`, así que el bug pasa unnoticed).
- [ ] W0.2: Verificar que `_usdcToWei` existe en `src/balance-guard.mjs:70-76` y está exportado solo via `_testHelpers` (línea 264). Confirmar exemplar para promoción.

### Wave 1 — Refactor exports (paralelizable post-W0)

- [ ] W1.1: `src/balance-guard.mjs` — promover `_usdcToWei` a export público. Decisión architect: agregar línea `export { _usdcToWei as usdcToWei };` o cambiar `function _usdcToWei(...)` a `export function usdcToWei(...)`. Recomendación: opción 2 (rename + export). Adaptar uso interno en `_testHelpers` y línea 217 (`thresholdWei = _usdcToWei(threshold)` → `usdcToWei(threshold)`). Ejecutar `npm test` — T-BG-01..T-BG-10 + T-CS-01/T-CS-02 deben seguir pasando idénticos.

### Wave 2 — Insertar balance-gate en handler (depende de W1)

- [ ] W2.1: `src/handlers.mjs` — agregar imports al tope: `import { checkBalanceWithClaim, releaseClaim, usdcToWei } from './balance-guard.mjs';`, `import { getKvClient } from './kv-client.mjs';`, `import { getAvaxClient } from './avax-client.mjs';`.
- [ ] W2.2: `src/handlers.mjs::payX402Handler` — insertar bloque `[1.5] Balance-gate` entre línea 343 y 359 según §7.2. Validar `payload.maxBudget`. Llamar `checkBalanceWithClaim`. Capturar `gate.claimKey` + `requestedWei`.
- [ ] W2.3: `src/handlers.mjs::payX402Handler` — wrappear el bloque cap guard + sign + settle + return final en try/finally con `releaseClaim` (CD-23). Cuidado: cada return existente dentro del try sigue retornando; el finally se ejecuta siempre.
- [ ] W2.4: `src/handlers.mjs::TOOL_DESCRIPTORS` — update `pay_x402` description + inputSchema.properties.payload.maxBudget + maxAmountWei description según §7.6.

### Wave 3 — Eliminar wrapper en api/mcp.mjs (depende de W2)

- [ ] W3.1: `api/mcp.mjs` — eliminar funcion completa `runWithBalanceGate` (líneas 106-194). Eliminar imports `checkBalanceWithClaim, releaseClaim, getAvaxClient` (líneas 54-58) si no se usan en otro lado del archivo.
- [ ] W3.2: `api/mcp.mjs::buildServer` — case `'pay_x402'` (línea 222-227) reduce a `const r = await payX402Handler(args, cfg); return asToolResult(r);` (alineado con stdio path en `src/index.mjs:101-104`).

### Wave 4 — Tests (paralelizable post-W3)

- [ ] W4.1: `tests/handlers-balance-gate.test.mjs` (NEW) — crear con tests T-FIX-01..T-FIX-10:
  - T-FIX-01 (AC-1): `payload.maxBudget=0.5`, sin `maxAmountWei`, balance OK → settled.
  - T-FIX-02 (AC-2): balance-gate compara con USDC balance real (no PYUSD). Setup: mock RPC con balance 0.4 USDC, `payload.maxBudget=0.05` (debajo threshold $0.50) → reject `below threshold`. Verificar que `requestedWei` enviado a `checkBalanceWithClaim` = 50_000n (USDC 6d), NO 50_000_000_000_000_000n.
  - T-FIX-03 (AC-3 sign-guard regression): `payload.maxBudget=0.5` + `maxAmountWei='100000000000000000'` (10^17 PYUSD wei) + accepts.maxAmountRequired='1000000000000000000' (10^18) → reject `stage:'sign', error:'amount exceeds maxAmountWei guard'`. Verifica que el sign guard sigue funcionando idéntico a WKH-64 AC-11.
  - T-FIX-04 (AC-5 ordering): spy/mock fetch + `checkBalanceWithClaim` + `signX402Envelope` calls — verify order via call-log: probe → balance-gate → cap guard (implícito si pasa) → sign → settle. Si balance-gate rechaza, NO llamar sign.
  - T-FIX-05 (AC-6 release on success): `payload.maxBudget=0.1`, balance OK, settle 200 → `kv.decrby` invocado UNA VEZ con requestedWei = 100_000n.
  - T-FIX-06 (AC-6 release on settle error): mismo setup, settle 400 → `kv.decrby` invocado UNA VEZ.
  - T-FIX-07 (AC-6 release on sign error): mock signX402Envelope throw → `kv.decrby` invocado UNA VEZ.
  - T-FIX-08 (AC-7 invalid maxBudget): `payload.maxBudget=NaN/Infinity/-1/0/'string'/null/undefined/{}` → reject `stage:'balance-gate', error:/invalid or missing payload.maxBudget/`. NO invoca probe? — NO, **se invoca el probe primero** (§7.4). Re-leer DT-5: validar `maxBudget` POST-probe. Solo si `accepts[0]` válido entonces validar maxBudget. Para tests: setup probe → 402 con `accepts[0]` válido, luego maxBudget inválido → reject `balance-gate`.
  - T-FIX-09 (AC-7 KV null fail-secure): `kvClient = null` → `checkBalanceWithClaim` retorna `{ ok:false, error:'balance check unavailable' }` → handler propaga reject. NO firma.
  - T-FIX-10 (AC-7 invalid threshold env): `MCP_BALANCE_THRESHOLD_USDC = 'abc'` → reject `stage:'balance-gate', error:/invalid threshold/i`. (Heredado de T-BG-11 actual, re-targetado.)
  - T-FIX-11 (free endpoint): probe 200 → `stage:'free'` SIN ejercitar balance-gate ni validación maxBudget. Verificar `kv.incrby` nunca invocado.
- [ ] W4.2: `tests/handlers-balance-gate.test.mjs` — agregar T-FIX-12..14 adversarial:
  - T-FIX-12 (CD-22 adversarial): `payload.maxBudget = Infinity / 1e308 / -1 / 0 / [0.5] / Symbol() / {valueOf:()=>0.5}` → reject. (Cubre V9 del work-item.)
  - T-FIX-13 (V1 drain primitive prevention): caller declara `payload.maxBudget=999` con balance $4.756 USDC → reject `concurrent claim exceeded` o `below threshold` (deps de cuál threshold check llega primero — verificar comportamiento actual de checkBalanceWithClaim con balanceUsdc < threshold + maxBudget).
  - T-FIX-14 (V7 maxBudget vs maxAmountRequired desalineados): `payload.maxBudget=0.5` USDC + `accepts.maxAmountRequired=10^18` (PYUSD wei) sin `maxAmountWei` seteado → balance-gate aprueba (gasta hasta $0.50 OUTBOUND), cap guard pasa porque `cfg.maxAmountWeiDefault = undefined` → sign procede. Comportamiento documentado: el OUTBOUND budget está cubierto; el caller acepta el INBOUND. Este test PASA y documenta el contrato — NO es regression.
- [ ] W4.3: `tests/balance-guard.test.mjs` — eliminar T-BG-11/T-BG-11b (movidos a `tests/handlers-balance-gate.test.mjs` como T-FIX-10) o re-targetar imports. Eliminar import `runWithBalanceGate` (línea 20). NO tocar T-BG-01..T-BG-10.
- [ ] W4.4: `tests/http.test.mjs` T-HTTP-14 — update body JSON-RPC a `arguments: { endpoint, payload: { maxBudget: 0.1 } }`. T-HTTP-13/T-HTTP-15 NO se tocan.
- [ ] W4.5: `tests/concurrent-stress.test.mjs` — verificar que T-CS-01/T-CS-02 NO requieren cambios (testean `checkBalanceWithClaim` directo). Si fallan, investigar — NO es esperado.
- [ ] W4.6: `npm test` full suite. Esperado: ≥173 (baseline) + 11-14 nuevos = 184-187 tests pasando. 0 fail. 0 skip.

### Wave 5 — Documentación + smoke prep (paralelizable post-W4)

- [ ] W5.1: `README.md` — actualizar sección `pay_x402`. Documentar `payload.maxBudget` como source-of-truth OUTBOUND y `maxAmountWei` como cap defensivo INBOUND opcional.
- [ ] W5.2: Verificar smoke script en `mcp-servers/wasiai-x402/scripts/`. Si existe (`smoke-prod.mjs` u otro), validar que el body JSON-RPC sea `arguments: { endpoint, payload: { maxBudget: <number> } }`. Si no existe, NO crearlo en F3 — postponer a F4 QA.
- [ ] W5.3: NO ejecutar smoke real en F3. Smoke se ejecuta en gate humano post-merge (AC-12) por orquestador.

### Wave 6 — F4 / DONE (post-merge, fuera de F3)

- [ ] W6.1: F4 QA ejecuta full test suite + smoke real $0.061 USDC mainnet (AC-12).
- [ ] W6.2: Re-enable cron-job.org via `node scripts/setup-cronjob.mjs` (AC-13).
- [ ] W6.3: Escribir `auto-blindaje.md` con lección decimals separation (AC-14, CD-25).
- [ ] W6.4: Escribir `done-report.md` con tx hash + balance pre/post (AC-15).

### Dependencias entre Waves

| Wave | Depende de | Razón |
|------|-----------|-------|
| W1 | W0 | Branch + baseline antes de tocar código. |
| W2 | W1 | `usdcToWei` debe estar exportado public para que `handlers.mjs` lo importe. |
| W3 | W2 | El handler debe estar gating internamente antes de eliminar el wrapper externo. Si no, hay ventana de runs sin gate. |
| W4 | W3 | Tests fallan si la wave 3 no está hecha (T-HTTP-14 actual passes con el wrapper presente; los nuevos T-FIX-* requieren handler-internal gate). |
| W5 | W4 | Doc + smoke prep solo después de tests verdes. |
| W6 | merge to main + deploy | F4 QA fuera de F3 scope. |

---

## 10. Decisiones técnicas (DTs F2 — resoluciones)

| DT | Pregunta F1 | Resolución F2 architect | Razón |
|----|-------------|------------------------|-------|
| **DT-1** | balance-gate inside handler vs wrapper | INSIDE `payX402Handler` (cementado F1). | Approach A — separación natural de concerns. |
| **DT-2** | source de OUTBOUND USDC wei | `payload.maxBudget` → `usdcToWei` (cementado F1). | Source-of-truth declarada por caller, ya existe en flow `compose`. |
| **DT-3** | sign guard sigue usando args.maxAmountWei (cementado F1). | Sin cambios — preserva WKH-64 AC-11 idéntico. |
| **DT-4** | scope try/finally interno | El `try` envuelve **cap guard + sign + settle + return final**. El `finally` siempre ejecuta `releaseClaim`. Ver §7.3. | AC-6 dice "exactly UNA VEZ" — incluye happy path. El claim debe vivir hasta el último return para evitar drain ventana. |
| **DT-5** | validar maxBudget pre o post probe | **POST-probe**, ANTES del balance-gate. Ver §7.4. | (a) free endpoints (200) no deben fallar por maxBudget faltante; (b) probe es input-agnostic; (c) solo si `accepts[0]` válido aplica el balance-gate, así que solo entonces aplica la validación. |
| **DT-6** | maxAmountRequired oracle vs maxBudget declarado | **`payload.maxBudget`** (sin oracle). Ver §7.5. | Oracle PYUSD/USDC es caja de Pandora; `maxBudget` es ceiling natural; el caller que miente solo se daña a sí mismo (rechazo `concurrent claim exceeded`). |
| **DT-7** | smoke idempotente o one-shot | **One-shot**, documentado en done-report, NO en CI. | CD-24 lo cementa. Cada run cuesta plata real. Re-runs requieren autorización humana explícita. |
| **DT-8** | cron re-enable manual o automatizado | **Automatizado** via `node scripts/setup-cronjob.mjs` (existing, idempotente WKH-66 AC-W1-1). NO script nuevo. | Reuse + idempotente. |
| **DT-9** | tools/list descriptors update | **SÍ — actualizar** `description` y `inputSchema.properties.payload.maxBudget` + `inputSchema.properties.maxAmountWei`. Ver §7.6. | Schema es la única forma de comunicar el contract a Claude managed agents. Sin update, los callers seguirán confundidos. |

---

## 11. Plan de Tests

### Test plan canonical — ≥1 test por AC

| AC | Test(s) | Wave | Framework | Archivo |
|----|---------|------|-----------|---------|
| AC-1 | T-FIX-01 | W4.1 | node:test | `tests/handlers-balance-gate.test.mjs` |
| AC-2 | T-FIX-02 | W4.1 | node:test | idem |
| AC-3 | T-FIX-03 + T35 (existente) | W4.1 | node:test | idem + `tests/tools.test.mjs` |
| AC-4 | T-FIX-08 + T-FIX-12 | W4.1, W4.2 | node:test | idem |
| AC-5 | T-FIX-04 | W4.1 | node:test | idem |
| AC-6 | T-FIX-05 + T-FIX-06 + T-FIX-07 | W4.1 | node:test | idem |
| AC-7 | T-FIX-08 + T-FIX-09 + T-FIX-10 | W4.1 | node:test | idem |
| AC-8 | T-CS-01, T-CS-02, T-BG-09, T-BG-10, T-X1..T-X5, T-Y1, T-Z1 (existentes, sin modificar) | W4.5/W4.6 | node:test | tests existentes |
| AC-9 | `npm test` full suite | W4.6 | node:test | todos |
| AC-10 | T-HTTP-01..T-HTTP-13 + AUTH-04/07 + audit-stderr (existentes) | W4.6 | node:test | tests existentes |
| AC-11 | F4 manual (Vercel deploy URL check) | W6 | manual | N/A — gate humano |
| AC-12 | Smoke real $0.061 USDC | W6 | smoke script | `scripts/smoke-prod.mjs` (verificar existencia) |
| AC-13 | `node scripts/setup-cronjob.mjs` + dashboard verify | W6 | manual | N/A |
| AC-14 | Existencia de `auto-blindaje.md` con lección decimals | W6 | manual | doc |
| AC-15 | Existencia de `done-report.md` | W6 | manual | doc |

### Tests adversariales (cubre §13 Adversary directives)

| Vector | Test |
|--------|------|
| V1 Drain primitive (caller miente sobre maxBudget) | T-FIX-13 |
| V2 PYUSD vs USDC decimals confusion | T-FIX-02, T-FIX-03 |
| V3 Race probe-vs-balance | T-CS-01 (existente cubre claim atomicity) + T-FIX-04 (ordering) |
| V4 Concurrent claim contention | T-CS-01 (existente, no se toca) |
| V5 Regression WKH-64 (5 BLQs) | T-X1..T-X5 + T-Y1 + T-Z1 + T-MNR-iter2-1 (todos existentes) |
| V6 Regression WKH-65 (BLQ-iter3-1 redirect:'error') | T-X11..T-X14 (existentes) |
| V7 Regression WKH-66 (BLQ-ALTO-1 stale snapshot) | T-BG-09, T-BG-10, T-CS-02 (existentes, no se tocan) |
| V8 CD-1 lift mal contenido | AR diff line-by-line + T-FIX-04 (ordering verifica que probe/sign/settle siguen idénticos) |
| V9 maxBudget adversarial inputs | T-FIX-12 (NaN, Infinity, -1, 0, string, null, {}, [], Symbol) |
| V10 Orphan claim | T-FIX-05/06/07 (release on each return path) |

### Verificación incremental

| Wave | Verificación al completar |
|------|---------------------------|
| W0 | `git status` clean, `npm test` baseline OK |
| W1 | `npm test -- tests/balance-guard.test.mjs` + `tests/concurrent-stress.test.mjs` pasando |
| W2 | (no test independiente) — bloqueado por W3+W4 |
| W3 | `npm test -- tests/http.test.mjs` (T-HTTP-13/15 OK; T-HTTP-14 fallará hasta W4.4) |
| W4 | `npm test` full suite 100% pass (≥184 tests) |
| W5 | README diff visual review |
| W6 | F4 QA gate humano |

---

## 12. Riesgos

| Riesgo | Prob | Impacto | Mitigación |
|--------|------|---------|------------|
| Try/finally mal estructurado → claim huérfano o doble-release | M | A | T-FIX-05/06/07 cubren cada path. AR debe verificar que cada `return` interno pasa por el `finally`. |
| `payload.maxBudget` validation con bypass (p.ej. `valueOf` trick) | M | M | CD-22 + T-FIX-12 cubren NaN/Infinity/coerce. Usar `Number.isFinite(x) && typeof x === 'number'` para rechazar objetos con `valueOf`. |
| Eliminación de `runWithBalanceGate` rompe alguna importación externa | B | M | Grep antes: solo `tests/balance-guard.test.mjs` lo importa. Esos tests se mueven en W4.3. |
| Promoción de `_usdcToWei` a public rompe `_testHelpers` | B | B | Re-export como `_testHelpers = { _weiToUsdc, _usdcToWei: usdcToWei }` o equivalente. Tests existentes que importan `_testHelpers` siguen funcionando. |
| TOOL_DESCRIPTORS update causa schema-break en Claude consumer | B | B | Approach A NO cambia el shape de `inputSchema` — solo agrega `payload.maxBudget` como property documentada. `additionalProperties` en `payload` permanece flexible. |
| Smoke real costoso re-ejecutado por error | M | A | CD-24 + comment header en script + F4 ejecuta exactamente una vez con autorización humana. |
| Stdio path NO está cubierto por tests integration | B | M | T-FIX-* unit tests cubren handler directo (no transport-specific). T-HTTP-14 cubre HTTP path. Stdio queda implícitamente cubierto porque ambos transports llaman al mismo handler. |
| Snapshot freshness regression | B | A | NO se toca `src/balance-guard.mjs:148-184`. T-BG-09/10/T-CS-02 detectan regression. |

---

## 13. Adversary Directives (sección obligatoria)

> AR debe atacar cada uno de estos vectores. BLOQUEANTE si encuentra gap.

| # | Vector | Cómo atacar | Test que debería atrapar |
|---|--------|-------------|--------------------------|
| V1 | Drain primitive re-introduction | Caller declara `payload.maxBudget=999` con balance $4.756 USDC. ¿El balance-gate rechaza? ¿O `INCRBY 999_000_000` excede el ledger pero NO el balance comparison (balance >> 999_000_000n no — pero `claimedTotalWei > maxClaimableWei` debería ser true)? Verify: `maxClaimableWei = balanceWei - thresholdWei = 4_756_000n - 500_000n = 4_256_000n`. `requestedWei = 999_000_000n` → `claimedTotalWei > maxClaimableWei` (post-INCRBY) → rechaza con CAS-revert. ✓ | T-FIX-13 |
| V2 | PYUSD vs USDC decimals confusion | ¿`requestedWei` que llega a `checkBalanceWithClaim` es 6d (USDC) y NO 18d (PYUSD)? Spy el call y verify magnitud. | T-FIX-02 |
| V3 | Race probe-vs-balance | Probe consume tiempo. Entre probe y balance-gate, ¿la balance puede cambiar? Sí, pero `checkBalanceWithClaim` lee balance en el momento de la llamada (snapshot fresh ≤30s o RPC). El claim atómico KV serializa concurrent calls. ¿Hay ventana donde 10 calls concurrentes tras el probe ven snapshot stale? T-CS-02 cubre stale snapshot. T-CS-01 cubre concurrent. | T-CS-01 + T-CS-02 + T-FIX-04 |
| V4 | Concurrent claim contention sigue OK | ¿Mover el balance-gate del wrapper al handler rompe la atomicidad? NO — `checkBalanceWithClaim` es el mismo módulo, mismo INCRBY. T-CS-01 NO requiere cambio (testea `checkBalanceWithClaim` direct). | T-CS-01 |
| V5 | Regression WKH-64 (5 BLQs) | ¿isPathOnly + resolveEndpoint + redirect:'error' + sign sanitization + signature truncation siguen intactos? AR debe grep `redirect: 'error'` (4 ocurrencias en `src/handlers.mjs` líneas 149, 220, 305, 444), `'signing failed (see stderr logs)'` (línea 415), `TRUNCATE_KEYS_SHORT` (en log.mjs). | Tests T-X1..T-X5, T-Y1, T-Z1 (NO se tocan) |
| V6 | Regression WKH-65 (BLQ-iter3-1) | `redirect:'error'` en las 4 fetch — verificar que el insertion del balance-gate NO modifica esas líneas. | Tests T-X11..T-X14 (NO se tocan) |
| V7 | Regression WKH-66 (BLQ-ALTO-1) | snapshot freshness 30s — verificar que `src/balance-guard.mjs` NO se modifica fuera del export `usdcToWei`. AR debe diff `src/balance-guard.mjs` línea por línea. | T-BG-09, T-BG-10, T-CS-02 (NO se tocan) |
| V8 | CD-1 lift mal contenido | AR debe diff PR completo y verificar que SOLO se tocan: `src/handlers.mjs` (insertion + try/finally + descriptors), `src/balance-guard.mjs` (export usdcToWei), `api/mcp.mjs` (eliminar runWithBalanceGate + simplify case 'pay_x402'), tests, README. CUALQUIER cambio en `src/sign.mjs`, `src/url-validator.mjs`, `src/auth.mjs`, `src/log.mjs`, `src/config.mjs`, `src/index.mjs`, `src/kv-client.mjs`, `src/rate-limit.mjs`, `src/cron-auth.mjs`, `src/alerts.mjs`, `src/avax-client.mjs`, `api/cron/*`, `vercel.json`, `package.json` es BLOQUEANTE. | AR diff manual |
| V9 | maxBudget adversarial inputs | NaN, Infinity, -Infinity, -1, 0, 1e308, '0.5' (string), null, undefined, {}, [], [0.5], Symbol(), `{valueOf:()=>0.5}`, prototype pollution `__proto__:{maxBudget:0.5}`. CD-22 dice `Number.isFinite(x) && x > 0 && x < 1_000_000`. ¿Falta `typeof x === 'number'`? Sin él, `valueOf` trick podría pasar `Number.isFinite` después de coerción. **AR debe pedir que CD-22 incluya `typeof x === 'number'` explícito** O documentar que `Number.isFinite` no coerce. Spec: `Number.isFinite('0.5')` → false (no coerce — bien). `Number.isFinite({valueOf:()=>0.5})` → false (no coerce — bien). **Confirmado: `Number.isFinite` NO coerce. Solo acepta number primitive.** ✓ | T-FIX-12 |
| V10 | Orphan claim | ¿Cada return path del handler post-balance-gate-OK pasa por finally? AR enumera: cap guard reject, sign exception, settle exception, redirect-refused, settle 4xx/5xx, settle 200 (success). Total: 6 paths. Cada uno DEBE pasar por finally. | T-FIX-05/06/07 + AR diff |

---

## 14. Dependencias

- **Externa**: Branch `fix/072-wkh-67-balance-gate-decimals` desde `main@b095b80`. NO mergear hasta F4 QA + smoke OK.
- **Interna**: WKH-66 (`071-wkh-66-prod-hardening`) DONE — proveyó `src/balance-guard.mjs` + KV mocks + concurrent stress tests.
- **Predecesor con regression**: este fix invalida el rollback `wasiai-x402-ah0gufv0p`. El re-deploy post-merge restaura URL canonical.
- **Sucesores potenciales**: WKH-68+ (futuras chains downstream) reusarán el patrón "balance-gate per outbound chain con su decimals helper" (CD-20).

---

## 15. Missing Inputs / Uncertainty Markers

> **0 NEEDS CLARIFICATION sin resolver.** Todos los DTs F1 abiertos están resueltos en §10.

| Marker | Estado |
|--------|--------|
| DT-4 try/finally scope | RESUELTO §7.3 — try envuelve cap+sign+settle+return; finally exactly-once. |
| DT-5 validar maxBudget pre o post probe | RESUELTO §7.4 — POST-probe. |
| DT-6 oracle vs declared budget | RESUELTO §7.5 — `payload.maxBudget` declarado, sin oracle. |
| DT-7 smoke idempotente | RESUELTO — one-shot, CD-24. |
| DT-8 cron re-enable | RESUELTO — `setup-cronjob.mjs` existing. |
| DT-9 tools/list descriptors | RESUELTO §7.6 — actualizar description + inputSchema. |
| Smoke script ubicación | TBD F2.5/F3 — verificar `mcp-servers/wasiai-x402/scripts/`. NO bloquea F2. |

---

## 16. Implementation Readiness Check

```
READINESS CHECK:
[X] Cada AC (15 total) tiene al menos 1 test asociado en tabla §11.
[X] Cada archivo en §7.1 tiene un Exemplar válido (verificado con Glob/Read).
[X] No hay [NEEDS CLARIFICATION] pendientes. Los 6 DTs F1 abiertos están resueltos en §10.
[X] Constraint Directives incluyen 25 (heredados + nuevos), con ≥3 PROHIBIDO explícitos en CD-1, CD-20, CD-21, CD-22, CD-23.
[X] Context Map (§4.1) tiene 11 archivos leídos con cita archivo:línea.
[X] Scope IN y OUT son explícitos (heredados literal de work-item.md §Scope IN/OUT).
[X] BD: N/A (no toca Supabase ni nuevas tablas).
[X] Flujo principal (Happy Path) — §3 Expected + §7.2 insertion point.
[X] Flujo de error definido — §7.3 try/finally + ACs 4/7 (8 sub-casos).
[X] Auto-blindaje histórico revisado (069+070+071) — patrones aplicados en §4.2.
[X] CD-1 lift de WKH-66 documentado explícitamente (§8 + §13 V8).
[X] Adversary directives 10 vectores (§13).
[X] Tests adversariales mapeados (§11 + §13).
[X] Waves 6 con dependencias (§9).
```

**Architect verdict**: SDD listo para SPEC_APPROVED. F2.5 (Story File) puede comenzar inmediatamente tras gate.

---

*SDD generado por NexusAgil — Architect F2 — 2026-04-29*
