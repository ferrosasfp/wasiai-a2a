# F4 QA Report — WKH-189 · Panel + endpoint de override de `arb_hold`

**Veredicto**: APROBADO — 8/8 ACs PASS con evidencia. **DONE (código) · PENDING-DEPLOY**
(migración `20260712000000_wkh189_arb_hold_override.sql` no aplicada a `caldz`,
mismo patrón que filas 167-170/`_INDEX.md` — ops de activación fuera de esta HU).
**Fecha**: 2026-07-12
**Reviewer**: nexus-qa

---

## 1. Gates (ejecutados por mí, no re-uso ciego del CR)

| Gate | Resultado |
|---|---|
| `npx tsc --noEmit` | verde, exit 0 |
| `npx vitest run` | **2851 passed / 10 skipped / 0 failed** (157/161 files, 4 skipped) — sube de 2849 (CR) a 2851 por los 2 tests nuevos del fix-pack (`splitPct<0`/`splitPct>100` → INVALID_INPUT, T-7) |
| `npm run build` | verde, exit 0 (`tsc -p tsconfig.build.json` + copy static) |
| `biome check` (5 TS tocados + `src/` completo) | verde, 0 errores — nota: `npx biome`/`biome` vía shell wrapper devolvió un falso `2 errors`/`npm error` (interferencia del hook rtk); invocado directo (`node_modules/@biomejs/biome/bin/biome`) confirma limpio en los 5 archivos y en los 313 archivos de `src/` |

CR y AR ya habían confirmado tsc/vitest/biome verdes (2849 tests, previo al fix-pack). Re-ejecuté completo porque el fix-pack tocó `arbiter.ts`/`arbiter.test.ts`/`dashboard.html` después del CR — no es overlap, es la verificación obligatoria post-fix-pack.

---

## 2. AC Verification (8 ACs, evidencia archivo:línea)

| AC | Texto (resumen) | Status | Evidencia |
|---|---|---|---|
| AC-1 | GET admin-gated lista `arb_hold` con evidencia (`decision`,`method`,`ambiguity_reason`,`at_stake_usd`,`chain_id`,`created_at`,`intent_id`) | **PASS** | `src/services/arbiter.ts:879-895` (`listHolds`, query `.eq('status','arb_hold')` + embed `a2a_arbitrations(...)`); ruta `src/routes/dashboard.ts:176-194` (`GET /api/arbitrations/holds`, `preHandler: requireAdminToken`); test `src/routes/dashboard.test.ts:167-203` (`T-1`, 2 owners cross-tenant, `total===2`) |
| AC-2 | POST resolve ejecuta por primitivos existentes (`executeArbitration`), transiciona `arb_hold→arb_closing→settled\|refunded\|failed` | **PASS** | `arbiter.ts:1009-1011` (`resolveHold` delega en `this.executeArbitration`, CD-1); ruta `dashboard.ts:202-250`; test `arbiter.test.ts:920-945` (`T-2`, `release`→`settleUsd=10`,`db.row.status==='settled'`,`receiptType:'arbitration_release'`) |
| AC-3 | Recibo inmutable + `method='admin_override'`,`resolved_by`,`resolved_at`,`resolution_note`, preservando `ambiguity_reason`/`llm_reasoning` originales | **PASS** | `arbiter.ts:968-984` (lee fila original best-effort), `arbiter.ts:995-1006` (`ArbMeta` con los 3 campos), `upsertArbitrationRow` en `arbiter.ts:261-292` persiste las 3 columnas; test `arbiter.test.ts:948-990` (`T-3`, `upserted` incluye `ambiguity_reason:'proof_chain_tamper'`/`llm_reasoning:'seed reasoning'` preservados del hold seed + `receiptType:'arbitration_split'`) |
| AC-4 | `intent_id` no en `arb_hold` (inexistente/ya resuelto) → rechazo 404/409 sin mover fondos | **PASS** | `arbiter.ts:948` (`!data → INTENT_NOT_FOUND`), `arbiter.ts:956-958` (`status!=='arb_hold' → INTENT_NOT_OPEN`); mapeo HTTP `dashboard.ts:38-41` (404/409); test `arbiter.test.ts:994-1036` (`T-4`, 3 casos: inexistente/settled/open, `mockSettle` no invocado) |
| AC-5 | Sin `X-Admin-Token` válido → 401/403 en GET y POST, sin disclosure cross-tenant | **PASS** | `dashboard.ts:59-89` (`requireAdminToken`, `timingSafeEqual`, fail-closed en prod si no configurado); test `dashboard.test.ts:206-226` (`T-5`, GET+POST sin header → 401, `mockListHolds`/`mockResolveHold` NO invocados) |
| AC-6 | Chain no-testnet → `CHAIN_NOT_SUPPORTED` fail-closed, sin mover fondos | **PASS** | `arbiter.ts:960-963` (`TESTNET_CHAIN_IDS.has(chain_id)`, previo a computar `settleUsd` y al RPC); test `arbiter.test.ts:1039-1057` (`T-6`, `chain_id:1` → `CHAIN_NOT_SUPPORTED`, `mockSettle` no invocado, `db.refunds===[]`) |
| AC-7 | Clamp `settleUsd` a `[0, authorized_usd]`, nunca excede deposit | **PASS** | Doble clamp: app-layer `arbiter.ts:987-993` (`Math.min(Math.max(0,rawUsd),depositUsd)`) + RPC `20260712000000_wkh189_arb_hold_override.sql:77` (`GREATEST(0, LEAST(v_auth, COALESCE(p_arb_amount,0)))`, byte-idéntico al original); **fix-pack**: `splitPct∉[0,100]` ahora rechaza con `INVALID_INPUT` ANTES de tocar fondos (`arbiter.ts:921-934`, comentario cita **T-7/AC-7**, no CD-9 — ver §5); tests `arbiter.test.ts:1061-1152` (`T-7`: `splitPct=500→INVALID_INPUT` L1079-1095, `splitPct=-5→INVALID_INPUT` L1097-1112, bordes `0`/`100` válidos L1114-1137, `release` no excede deposit L1139-1151) |
| AC-8 | `ARBITER_ENABLED!=='true'` → niega panel/endpoints (401/403/404) sin filtrar existencia | **PASS** | `dashboard.ts:180-182` (GET) y `206-208` (POST): `if (!isArbiterEnabled()) return 404 {error_code:'NOT_FOUND'}` — chequeo DESPUÉS de `requireAdminToken` (preHandler), o sea sin token es 401 (no revela ni el flag ni el 404); test `dashboard.test.ts:229-250` (`T-9`, flag OFF con token válido → 404 byte-idéntico en ambas rutas) |

**8/8 PASS.**

---

## 3. Migración — verificación byte-a-byte contra el original WKH-139

Comparé línea a línea `20260712000000_wkh189_arb_hold_override.sql:31-107`
(`CREATE OR REPLACE FUNCTION close_payment_intent_for_arbitration`) contra
`20260704100000_wkh139_arbiter.sql:149-211` (mismo cuerpo original):

- Firma, `DECLARE`, `SELECT ... FOR UPDATE`, ownership check
  (`v_owner IS DISTINCT FROM p_owner_ref`), clamp (`v_arb := GREATEST(0,
  LEAST(v_auth, COALESCE(p_arb_amount,0)))`), rama recovery `arb_closing`
  (L87-89 vs L201-204), `RETURN NEXT`/`RETURN`, `LANGUAGE plpgsql SECURITY
  DEFINER`: **byte-idénticos**.
- **Única diferencia funcional**: L81 `IF v_status IN ('disputed','arb_hold')
  THEN` vs el original `IF v_status = 'disputed' THEN` (L192 del original).
  El resto de la diferencia es reformulación de comentarios.
- `SECURITY DEFINER` + `SET search_path = public, pg_temp` (L109-110) +
  `REVOKE ... FROM PUBLIC, anon, authenticated` + `GRANT ... TO service_role`
  (L111-114): presentes, idénticos al patrón WKH-139.
- Test estructural propio: `arbiter.test.ts:1244-1250` (`T-11`) asserta que el
  predicado ensanchado aparece **exactamente una vez** como sentencia completa
  (no substring) y que el predicado angosto original NO aparece en el `up`.

**Down reversible**: `20260712000000_wkh189_arb_hold_override_down.sql:14-61`
restaura el RPC al predicado `= 'disputed'` (verbatim del original), restaura
el `CHECK` sin `admin_override` (L64-66), dropea las 3 columnas (L69-71), todo
en `BEGIN/COMMIT`. Caveat documentado en el header (L6-8): si existen filas
`admin_override` o intents `arb_hold` pendientes al aplicar el down, el
`CHECK` restaurado los rechazaría — nota-ops esperada, no defecto (mismo
patrón que el down de WKH-139). Confirmado también por
`arbiter.test.ts:1264-1268` (T-11 down: contiene `= 'disputed'`, no contiene
el predicado ensanchado).

**Estado de aplicación**: la migración NO está aplicada a ningún remoto
(sigue como archivo `.sql` sin trackear en git, `PENDING-DEPLOY`). Es
consistente con el Scope OUT explícito del work-item ("ops de activación...
fuera de esta HU") — no es un FAIL, es el estado esperado de esta HU
`código-only`. DB state verification en vivo **NO APLICA** (no hay servidor
remoto con esta migración aplicada para consultar `information_schema` /
`schema_migrations`).

---

## 4. Hazard R-1 / CD-8 (refund-fantasma) — verificado en el código, no solo el test

Grep manual sobre `src/services/payment-intent.ts`:
- `expireStale` sólo sweepea `.eq('status', 'arb_closing')` (L1177) y
  `.eq('status', 'disputed')` (L1189-1192) — **cero** ocurrencias de
  `.eq('status', 'arb_hold')` en todo el archivo.
- El guard preexistente de WKH-139 (`payment-intent.ts:577-588`, cierre
  normal de sesión) ya trataba `arb_hold` como estado no-cerrable
  (`INTENT_NOT_OPEN`) — no modificado por esta HU, confirma que el invariante
  viene heredado y sigue intacto.
- Test que blinda esto contra regresión futura: `arbiter.test.ts:1199-1208`
  (T-10a, assert `not.toContain(".eq('status','arb_hold')")`) +
  `arbiter.test.ts:1210-1224` (T-10b, `recoverArbClosing` forzado sobre
  `arb_hold` no reembolsa — el guard `prev_status!=='arb_closing'` en
  `applyRecovery` (`arbiter.ts:662-668`) corta antes del finalize).

**Confirmado**: el ensanche del predicado en el RPC de cierre NO abre una
ruta nueva hacia el refund-fantasma; la única vía que invoca el RPC sobre
`arb_hold` es `resolveHold`.

---

## 5. Drift Detection

- **Scope**: archivos tocados = `src/routes/dashboard.ts`,
  `src/routes/dashboard.test.ts`, `src/services/arbiter.ts`,
  `src/services/arbiter.test.ts`, `src/types/arbiter.ts`,
  `src/static/dashboard.html` + 2 migraciones nuevas — exactamente el Scope
  IN del work-item. `doc/sdd/_INDEX.md` (+2 líneas) es la fila placeholder de
  F1 (status `in progress`, a actualizar por `nexus-docs` en DONE) — no es
  drift de código. Sin archivos fuera de scope.
- **Wave order**: confirmado por `auto-blindaje.md` (W0→W1→W2, y el fix-pack
  post-CR como wave adicional documentada con timestamp).
- **splitPct (fix-pack)**: confirmado en código real que la resolución final
  es **rechazo** (`INVALID_INPUT`), no clamp silencioso — revierte la
  desviación original de Wave 1. El comentario en `arbiter.ts:921-925` ahora
  cita correctamente **T-7/AC-7** como la autoridad del rango `[0,100]`
  (`"CD-9 gobierna el auto-cap, no este rango"`), corrigiendo el MNR-1 del CR
  (que había señalado la cita débil a CD-9). El clamp `[0,deposit]` de
  `settleUsd` queda como defensa en profundidad explícita, no primaria.
- **Botones anti-doble-submit (fix-pack)**: confirmado en
  `dashboard.html:368-373,398-399` (`resolveHoldUI`) — los 3 botones de la
  fila (`data-hold-row`) se deshabilitan al iniciar el POST y se rehabilitan
  en el `finally`, cerrando el MNR-1 del AR.
- **No re-abrió** ningún hallazgo nuevo durante mi revisión de código —
  ambos fix-packs están completos y coherentes con lo que AR/CR pidieron.

**Drift: none** (ambos MENORes cerrados correctamente, sin desviación nueva).

---

## 6. Gate Confirmation

`tsc`/`vitest`/`build`/`biome` re-ejecutados por mí (no solo leídos del CR)
porque el fix-pack modificó código después del CR report — ver §1. Todos
verdes, superset del resultado de CR (2851 ≥ 2849, +2 tests del fix-pack).

---

## 7. AR/CR follow-up

- AR: APROBADO, 0 BLQ, 1 MNR (botones sin disable durante in-flight) → **cerrado** (§5).
- CR: APROBADO, 0 BLQ, 1 MNR (`splitPct` fuera de rango, clamp silencioso) → **cerrado** (§5).
- Ambos MNR resueltos en el mismo fix-pack, documentado en `auto-blindaje.md:29-33`.

---

## Veredicto final

**8/8 ACs PASS con evidencia archivo:línea. 0 drift. 0 findings nuevos.
Gates verdes (tsc/vitest 2851/build/biome, ejecutados por mí post-fix-pack).
Migración verificada byte-idéntica excepto el predicado (única diferencia
funcional intencional). Invariante R-1/CD-8 confirmado en código, no solo en
test. Down reversible.**

Listo para DONE, con el estado heredado **`DONE (código) · PENDING-DEPLOY`**
(mismo patrón que filas 167-170 del `_INDEX.md`) — falta aplicar la
migración a `caldz` + flip `ARBITER_ENABLED=true` en Railway, explícitamente
fuera de scope de esta HU (Scope OUT del work-item).
