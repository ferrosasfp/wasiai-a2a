# Final Report — WKH-121: Session Keys server-side (sin EIP-712)

> **Status**: ✅ DONE · **Fecha**: 2026-06-19 · **Branch**: `feat/110-wkh-121-key-sessions`
> **Épica**: E16 (Agent Key robustness vs Kite Passport) · **Modo**: QUALITY AUTO
> Veredicto F4: APROBADO PARA DONE (15/15 ACs PASS).

> Nota de cierre: este report consolida la salida de nexus-docs (el agente entregó el contenido pero no lo persistió; el orquestador lo guarda sin alterarlo).

---

## 1. Resumen ejecutivo

WKH-121 agrega **session keys efímeras derivadas server-side** desde una agent key existente, **sin** wallet EVM ni firma EIP-712. Un caller autenticado con su master key (`wasi_a2a_<…>`) ejecuta `POST /auth/key-session` con `{ ttl_seconds, max_budget_usd, allowed_* }` y recibe un token opaco `wasi_a2a_sess_<random>` (devuelto una sola vez). El token autentica requests posteriores con scope acotado (`⊆ scope(master)`), TTL y budget de sesión propios.

**Por qué**: hoy la Agent Key es un bearer `key_hash` único de larga vida — si se filtra, el blast radius es total (acceso completo + budget completo, hasta el `deactivate`). Con session keys, un token filtrado queda limitado a `{ ttl, max_budget_usd, scopes }`. Es la base de WKH-122 (revocación granular) y WKH-123 (auth por firma).

**Coexistencia preservada**: WKH-101 (delegaciones EIP-712, prefijo `wasi_a2a_session_`) + WKH-121 (server-side, prefijo `wasi_a2a_sess_`) + master (`wasi_a2a_*`) conviven sin colisión (prefijos mutuamente exclusivos). Back-compat total (AC-14/AC-15).

---

## 2. Pipeline ejecutado (QUALITY AUTO)

| Fase | Resultado | Fecha |
|------|-----------|-------|
| F0+F1 (analyst) | work-item.md, 15 ACs EARS, scope refinado (no duplicar WKH-101) | 2026-06-19 |
| **HU_APPROVED** | self-aprobado (clinical review §4.1, delegado por Fernando) | 2026-06-19 |
| F2 (architect) | sdd.md — DT-1..DT-5 resueltos (tabla separada, prefijo `wasi_a2a_sess_`, RPC atómico, scope intersectado, env var) | 2026-06-19 |
| **SPEC_APPROVED** | self-aprobado (clinical review §4.2) | 2026-06-19 |
| F2.5 (architect) | story-file.md autocontenido + SQL completo | 2026-06-19 |
| F3 (dev) | W0-W4, 19 archivos, 89 tests nuevos verde | 2026-06-19 |
| AR (adversary) | **RECHAZADO** — BLQ-ALTO-1 (cap de sesión bypasseado en multi-step) | 2026-06-19 |
| CR (adversary) | APROBADO con 2 MENORs (cosméticos) | 2026-06-19 |
| Story File + (architect) | amplía Scope IN (cadena `keySessionContext` en compose/orchestrate) | 2026-06-19 |
| re-F3 fix-pack (dev) | Wave 5-FIX: cableado end-to-end + T-SESS-MULTISTEP + MENORs | 2026-06-19 |
| RE-AR (adversary) | **APROBADO** — BLQ-ALTO-1 cerrado end-to-end, sin regresiones | 2026-06-19 |
| F4 (qa) | **APROBADO PARA DONE** — 15/15 ACs PASS con evidencia | 2026-06-19 |
| DONE (docs) | este report + _INDEX actualizado | 2026-06-19 |

---

## 3. AC results (del validation.md)

Los 15 ACs PASS con evidencia archivo:línea. Ver `validation.md` para la tabla completa. Resumen:
- Creación/scope/TTL (AC-1, AC-2, AC-3): cubiertos en `key-session.test.ts` + `auth.keySession.test.ts`.
- Middleware (AC-4..AC-7, AC-10, AC-14, AC-15): `a2a-key.test.ts`.
- Débito atómico + multi-step (AC-8, AC-9): `key-session.test.ts` + `compose.test.ts` (T-SESS-MULTISTEP).
- Ownership/sub-delegación/listado (AC-11, AC-12, AC-13): `key-session.test.ts` + `auth.keySession.test.ts`.

Gates: `tsc` exit 0 · `npm test` 1422 pass / 3 skip · `lint` exit 0.

---

## 4. Hallazgos finales

**BLQ-ALTO-1 (RESUELTO)** — El cap `max_budget_usd` de la sesión solo se aplicaba en el step 0 (middleware). En `/compose` y `/orchestrate` multi-step, los steps 1..N caían a la ruta master y debitaban el parent sin chequear el cap de la sesión ni actualizar `spent_usd`.
- **Causa raíz**: el `keySessionContext` (que el middleware ya seteaba y que `budget.debit` ya aceptaba) no se propagaba por los eslabones intermedios: `routes/compose.ts`, `routes/orchestrate.ts`, `ComposeRequest`/`OrchestrateRequest`, `orchestrate.ts`, `compose.ts`. WKH-101 sí había cableado `delegationContext` por esa misma cadena; el Story File original de WKH-121 no incluyó esos archivos en Scope IN.
- **Fix (Wave 5-FIX)**: espejar el cableado de `delegationContext` para `keySessionContext` en los 5 eslabones + test multi-step T-SESS-MULTISTEP que reproduce el bug.

**MENORs**:
- MNR-1 AR (test multi-step faltaba) → CERRADO (T-SESS-MULTISTEP).
- MNR-3 CR (`SessionNotAllowedError` declarada pero no instanciada) → CERRADO (consumida en `auth.ts:1118`; clase conservada para WKH-122).
- MNR-4 CR (type `KeySessionErrorCode` sin consumidores) → CERRADO (eliminado; canónico `KeySessionMiddlewareErrorCode`).
- MNR-2 AR (per-call limit del parent no aplica bajo sesión, paridad WKH-101) → DIFERIDO a backlog (no es AC).

---

## 5. Auto-Blindaje consolidado

- **AB-1 (aridad de aserciones de mock)**: al agregar el arg `keySessionContext?` a `budget.debit`, las aserciones `mockDebit.toHaveBeenCalledWith(...)` existentes en `compose.test.ts` y `orchestrate.billing.test.ts` fallaron por aridad. Fix: agregar el trailing `undefined` esperado. Lección: extender una firma con param opcional rompe aserciones de mock posicionales exactas — actualizarlas en el mismo cambio.
- Patrones heredados aplicados (de WKH-101/104/117): mapeo completo de RAISE→error class sin leak de PG; path interno sin `/auth`; validar amounts/ttl en el parser; `logOwnershipMismatch` forma objeto; `delete process.env` + setup en `beforeAll` para tests gateados.

Ver `auto-blindaje.md` para el detalle.

---

## 6. Archivos creados/modificados

**Creados**:
- `supabase/migrations/20260603000000_a2a_key_sessions.sql` (tabla + 2 índices + RPC `debit_session_and_parent` + hardening) + `_down.sql`
- `src/services/key-session.ts` (service)
- `src/services/key-session.test.ts`, `src/routes/auth.keySession.test.ts`, `src/__tests__/e2e/key-session-atomicity.real.test.ts` (gated)

**Modificados**:
- `src/types/a2a-key.ts` (tipos KeySession*), `src/types/index.ts` (`keySessionContext?` en ComposeRequest/OrchestrateRequest)
- `src/services/security/errors.ts` (4 error classes + OwnershipOp)
- `src/middleware/a2a-key.ts` (branch `wasi_a2a_sess_*` insertado entre WKH-101 y master)
- `src/services/budget.ts` (`debit` acepta `keySessionContext?`)
- `src/services/compose.ts`, `src/services/orchestrate.ts`, `src/routes/compose.ts`, `src/routes/orchestrate.ts` (propagación Wave 5-FIX)
- `src/routes/auth.ts` (endpoints POST/GET /key-session)
- `.env.example` (`SESSION_MAX_TTL_SECONDS`)
- Tests: `src/middleware/a2a-key.test.ts`, `src/services/compose.test.ts`, `src/services/orchestrate.billing.test.ts`

---

## 7. Spinoffs / decisiones diferidas a backlog

- **WKH-122** (revocación granular por sesión): desbloqueado — la tabla `a2a_key_sessions` ya tiene `revoked_at TIMESTAMPTZ`; solo falta `DELETE /auth/key-session/:id` + lista de revocación en el middleware.
- **WKH-123** (auth por firma/passkey): desbloqueado — el token de sesión ya existe; agregar capa de firma encima.
- **WKH-124 / WKH-125** (recibos inmutables / constraints por destino): independientes, sin dependencia de WKH-121.
- **MNR-2 AR** (per-call limit del parent bajo sesión, paridad WKH-101): deuda menor.

---

## 8. Lecciones para próximas HUs

1. **Cuando se agrega un contexto de auth nuevo (como `keySessionContext`), hay que cablear TODA la cadena de propagación per-step, no solo el middleware.** El patrón ya existía para `delegationContext` (WKH-101) — el grounding de F0/F2 debe incluir explícitamente los eslabones intermedios (`compose.ts`, `orchestrate.ts`, los route call-sites, y los tipos `ComposeRequest`/`OrchestrateRequest`) en el Scope IN. El AR lo cazó, pero hubiera sido más barato en F2.
2. **El AR justificó su existencia**: encontró un BLQ-ALTO real (cap de seguridad bypasseado) que la suite de F3 no detectaba por falta de un test multi-step. Confirma el valor de la ruta QUALITY para HUs de identidad/pago.
3. **Tabla separada > extender tabla DONE en prod**: DT-1 eligió `a2a_key_sessions` separada en vez de extender `a2a_delegations` — riesgo de regresión 0 sobre WKH-101. Buen default cuando coexisten dos variantes de un mismo concepto.

---

## 9. Pendiente operativo (NO bloquea DONE)

- Aplicar la migración `20260603000000_a2a_key_sessions.sql` al Supabase de prod (Railway) — TESTNET, nunca mainnet.
- Setear `SESSION_MAX_TTL_SECONDS` en Railway (opcional; hay fail-safe a 86400).
- Merge del branch `feat/110-wkh-121-key-sessions` (decisión del humano).
