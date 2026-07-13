# AR Report — WKH-189: Panel + endpoint de override de `arb_hold`

> Fase: Adversarial Review (F3 → AR)
> Fecha: 2026-07-12
> Reviewer: nexus-adversary
> Input: story-HU-189.md + sdd.md + `git diff` (uncommitted) sobre 8 archivos Scope IN
> Verificación ejecutable: `npx tsc --noEmit` = **verde (exit 0)**; `npm test` = **2849 passed | 10 skipped (161 files)**.

## Veredicto global: **APROBADO** (0 BLOQUEANTES, 1 MENOR)

Money-path limpio. El ensanche del RPC es byte-idéntico al original de WKH-139 salvo
el predicado (verificado por `diff` del bloque de dinero: única diferencia funcional
`IF v_status = 'disputed'` → `IF v_status IN ('disputed','arb_hold')`; el resto son
comentarios reformulados, cero cambio de lógica). Exactly-once, testnet fail-closed,
clamp `[0,deposit]`, ownership guard e invariante R-1 confirmados en el código real.

---

## Ataques money-path solicitados (7 vectores)

### 1. Doble-settle / exactly-once — OK
- `resolveHold` NO hace `UPDATE` de status en la app (CD-3); la única transición
  `arb_hold→arb_closing` la hace el RPC bajo `SELECT ... FOR UPDATE`
  (migración `20260712...override.sql:66-68`).
- `executeArbitration` se invoca sin 5º arg → `allowStaleRecovery=false` (arbiter.ts:1007).
  Un segundo override que caiga en la rama recovery (`prev_status='arb_closing'`,
  `settle_outcome=NULL`) es no-op in-flight (arbiter.ts:662-668). Probado por **T-8**
  (arbiter.test.ts:1110-1151): `mockSettle` NO llamado, `db.refunds === []`.
- Panel: `resolveHoldUI` (dashboard.html:349) usa `confirm()` síncrono + el advisory
  status-check en `resolveHold` (arbiter.ts:952-954) devuelve `INTENT_NOT_OPEN` (409)
  al segundo submit. Doble-click NO produce doble movimiento de fondos.

### 2. Bypass del cap / testnet-guard — OK
- El testnet-guard es **fail-closed y previo a tocar status/RPC**:
  `if (!TESTNET_CHAIN_IDS.has(intentRow.chain_id)) throw CHAIN_NOT_SUPPORTED`
  (arbiter.ts:957-959), antes de computar `settleUsd` y antes del RPC. Un intent
  mainnet en `arb_hold` NO puede mover fondos. Probado por **T-6** (arbiter.test.ts:1038-1056).
- El ensanche del predicado NO abre puerta a mainnet: el RPC no valida chain (nunca
  lo hizo); el gate testnet vive en la capa de servicio, replicado idéntico al de
  `openDispute`. `TESTNET_CHAIN_IDS` (2368/43113/84532) intacto (CD-2).
- El cap `ARBITER_AUTO_CAP_USD` NO se consulta en `resolveHold` (CD-9) — por diseño;
  el único límite es el clamp. Probado por **T-7** (deposit 1000 con cap=25 ejecuta).

### 3. Clamp / crear plata — OK
- Doble clamp: app-layer `Math.min(Math.max(0, rawUsd), depositUsd)` (arbiter.ts:989)
  + RPC `GREATEST(0, LEAST(v_auth, COALESCE(p_arb_amount,0)))` (migración:77, byte-idéntico).
- `splitPct=150` → `rawUsd=1.5*dep` → clamp a `dep`, residual 0. Probado por **T-7**
  (arbiter.test.ts:1079-1093, `settleUsd===1000`, `residualUsd===0`).
- `splitPct` negativo → `rawUsd<0` → `Math.max(0,...)=0` → settle 0 (equivale a refund),
  residual = deposit. Nunca settle negativo ni refund > deposit.
- `residualMicro = Math.max(0, depositMicro - arbMicro)` (arbiter.ts:503) nunca negativo.
- `splitPct` no-finito/undefined en split → `INVALID_INPUT` (arbiter.ts:925-930); un
  `"50"` string desde JSON también cae en `!Number.isFinite` → rechazado.

### 4. Hazard R-1 (refund-fantasma) — OK
- `expireStale` sweepea SOLO `arb_closing` (payment-intent.ts:1177) y `disputed`
  (payment-intent.ts:1192); **NUNCA** `arb_hold`. Confirmado por grep + **T-10(a)**
  (arbiter.test.ts:1155-1164, assert `NOT toContain(".eq('status','arb_hold')")`).
- `recoverArbClosing` forzado sobre `arb_hold` NO reembolsa: el guard
  `prev_status !== 'arb_closing' return` corta antes del finalize. Probado por
  **T-10(b)** (arbiter.test.ts:1166-1180, `db.refunds===[]`).
- La ÚNICA ruta que invoca el RPC sobre `arb_hold` es `resolveHold`. El caso
  `resolveHold(refund)` (p_arb_amount=0) transiciona `arb_hold→arb_closing→settled`
  con refund total = decisión admin **deliberada**, no fantasma. No hay otra ruta
  (nueva ni vieja) que llame el RPC con arb_amount=0 sobre un `arb_hold`.

### 5. Ownership / admin-scope — OK
- Ambas rutas: `preHandler: requireAdminToken` (dashboard.ts:204, 172-ish) +
  `if (!isArbiterEnabled()) return 404 {error_code:'NOT_FOUND'}` como primera línea
  (dashboard.ts:206-208 y análogo en GET). Sin token → 401 (timingSafeEqual), sin
  disclosure. Probado por **T-5** (401 sin token, mocks no invocados) y **T-9**
  (404 byte-idéntico con `ARBITER_ENABLED != 'true'` incluso con token válido).
- `listHolds` cross-tenant es excepción DELIBERADA (CD-5), documentada en JSDoc
  (arbiter.ts:870-878) como superficie de alto privilegio. Ningún caller no-admin
  la alcanza (gate en la ruta).
- `owner_ref` se lee del row real del intent (arbiter.ts:961) y se pasa a
  `executeArbitration`/RPC (CD-4). Nunca del request.

### 6. Recibo / auditoría — OK
- `resolveHold` construye `ArbMeta` con `method:'admin_override'`, `resolvedBy`,
  `resolvedAt: new Date().toISOString()`, `resolutionNote` (arbiter.ts:992-1003) y
  delega en `executeArbitration` → `emitAndRecord` (recibo inmutable vía
  `receiptTypeFor(decision)`) + `upsertArbitrationRow` persiste las 3 columnas
  nuevas (arbiter.ts:277-279). Preserva `ambiguity_reason`/`llm_reasoning` del hold
  original (leídos best-effort, arbiter.ts:968-980). Probado por **T-3**.

### 7. Regresión del auto-path — OK
- `ArbMeta` extendido; TODAS las construcciones del auto-path pasan los 3 campos
  `= null`: LLM-null hold (arbiter.ts:431-433), meta base rules/llm (463-465),
  recoveryMeta (742-744). Los spreads `{...meta, decision:'hold'}` heredan los null.
- `tsc --noEmit` verde; los 88 tests WKH-139 + toda la suite (2849) verdes. El
  auto-path (openDispute/resolveDispute) no cambia de comportamiento (columnas NULL,
  additive).

---

## 11 categorías de ataque

| # | Categoría | Veredicto | Nota |
|---|-----------|-----------|------|
| 1 | Security | **OK** | Admin-gated (requireAdminToken), ownership guard app-layer, testnet fail-closed pre-status, errores disclosure-safe (sin mensaje crudo). |
| 2 | Error Handling | **OK** | try/catch en ambas rutas + `resolveHold`/`listHolds`; `log.error` con detail; `INTERNAL` en fallos de query; `if(!ok) throw` en finalize. |
| 3 | Data Integrity | **OK** | Exactly-once `FOR UPDATE` + status-gate + `allowStaleRecovery=false`; clamp doble; recovery idempotente. T-8/T-10. |
| 4 | Performance | **OK** | Queries puntuales; filtro `status='arb_hold'` + embed FK; sin N+1 (listHolds 1 query con embed). |
| 5 | Integration | **OK** | Migración additive, down reversible; sin breaking changes; `record_settle_outcome`/`finalize` intactos (CD-6). 2849 tests verdes. |
| 6 | Type Safety | **OK** | `tsc` verde; convención `T\|null`; único cast `as unknown as HoldIntentRow[]` justificado (shape del embed PostgREST). Sin `any`. |
| 7 | Test Coverage | **OK** | T-1..T-11; mocks in-memory FIELES a la semántica SQL (RPC mock replica clamp+predicado, arbiter.test.ts:204-226); tests negativos (T-4/T-5/T-6/T-9). |
| 8 | Scope Drift | **OK** | Solo los 8 archivos Scope IN + 2 migraciones. Nada fuera de scope. |
| 9 | Destructive Migrations | **OK** | Additive: `ADD COLUMN IF NOT EXISTS` nullable (sin NOT NULL sobre tabla con data), `CREATE OR REPLACE`, wrap `BEGIN/COMMIT`. Down reversible con nota-ops documentada (restaurar CHECK falla si hay filas `admin_override` — caveat esperado, no defecto). |
| 10 | RPC SECURITY DEFINER | **OK** | `SECURITY DEFINER` + `SET search_path=public,pg_temp` (migración:109-110); `REVOKE ... FROM PUBLIC,anon,authenticated` + `GRANT ... service_role` (111-114); owner-check interno (`v_owner IS DISTINCT FROM p_owner_ref`); sin SQL dinámico. |
| 11 | Cache Invalidation | **N/A** | No introduce cache de datos de tenant. `localStorage` solo guarda el admin-token (no PII/tenant). El panel carga on-demand, excluido del auto-refresh de 5s. |

---

## Findings

### MNR-1 — Test Coverage / UX (MENOR, no bloquea)
- **Archivo:línea**: `src/static/dashboard.html:349-377` (`resolveHoldUI`).
- **Descripción**: los botones Liberar/Reembolsar/Dividir no se deshabilitan mientras
  el POST está in-flight. Un doble-click rápido puede disparar un segundo POST.
- **Por qué NO es bloqueante**: el segundo request es money-safe — el advisory
  `status !== 'arb_hold'` en `resolveHold` (arbiter.ts:952) devuelve `INTENT_NOT_OPEN`
  (409), y aun en carrera el status-gate del RPC (`FOR UPDATE`) hace no-op in-flight.
  No hay doble movimiento de fondos (T-8 lo prueba a nivel servicio).
- **Impacto**: cosmético — un alert "No se pudo resolver: INTENT_NOT_OPEN" tras el
  segundo click, y un request extra al backend.
- **Sugerencia**: deshabilitar los 3 botones de la fila durante el `await` del POST
  (o remover la fila optimísticamente). Backlog; no bloquea DONE.

---

## Observaciones (no findings)
- `esc()` (dashboard.html:151) escapa `<>&` vía textNode pero no comillas; el
  `intentId` interpolado en `onclick='...'` es un UUID de columna `uuid` (no puede
  contener comillas) → no explotable. `ambiguityReason`/`method` son valores
  controlados del árbitro en contexto de texto HTML → escape suficiente.
- Nota-ops del down: si se aplica con filas `admin_override` existentes, el `ADD
  CONSTRAINT CHECK` restaurado falla (validación PG estándar). Ya documentado en el
  header del `.sql` down. Esta HU es `DONE (código) · PENDING-DEPLOY`.

## Cierre
- 0 BLOQUEANTES (ALTO/MEDIO/BAJO). 1 MENOR (backlog).
- Gate AR: **APROBADO**. Habilitado para CR.
