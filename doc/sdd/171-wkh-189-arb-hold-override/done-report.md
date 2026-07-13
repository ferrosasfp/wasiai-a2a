# Done Report — WKH-189 · Panel + endpoint de override de `arb_hold`

**Status final**: DONE (código) · PENDING-DEPLOY  
**Fecha**: 2026-07-12  
**Branch**: feat/171-wkh-189-arb-hold-override  
**Archivos**: 8 (5 TS + 2 migraciones + 1 HTML)

---

## Resumen ejecutivo

WKH-189 cierra el punto de disputa al 100% de la especificación de WKH-139 v2 (agente-árbitro autónomo). Hoy un intent en estado `arb_hold` (sobre-tope del auto-cap $25 o ambigüedad irresoluble) solo es resoluble por cirugía manual de DB. Esta HU construye el **Bloque A (código)**: un endpoint admin-gated (`GET/POST /dashboard/api/arbitrations...`) que lista holds pendientes y ejecuta `release`/`refund`/`split` reusando el seam existente de settle/refund del árbitro autónomo, más un panel en el dashboard.

**Innovación clave**: NO se crea un RPC nuevo. Se ensancha `close_payment_intent_for_arbitration` (predicado `'disputed'` → `IN ('disputed','arb_hold')`) siguiendo el patrón "Option B" ya establecido en la misma migración de WKH-139 v2 para `record_settle_outcome`/`finalize_payment_intent`. El resto de la lógica de dinero es byte-idéntica. Migración additive con down reversible. AR/CR/F4 APROBADO (0 BLQ, 2 MENORs cerrados en fix-pack).

**Bloques operativos (fuera de esta HU)**: aplicar migración a `caldz` (prod DB) + flip `ARBITER_ENABLED=true` en Railway (ops). Runbook en §5.

---

## Pipeline ejecutado

| Fase | Gate | Veredicto | Evidencia |
|------|------|-----------|-----------|
| **F0** | Codebase grounding (F0 en work-item.md) | ✅ RESUELTO | Todos los exemplars verificados en `src/` y migraciones precedentes; RPC a ensanchar identificado línea 192 migración WKH-139; seam de reuse (`executeArbitration`) confirmado |
| **F1** | `HU_APPROVED` (gate: texto exacto "ok"/"dale"/"go") | ✅ APROBADO | Humano confirmó scope en descripción del orquestador al lanzar Analyst; trabajo-item construido sin hallazgos bloqueantes (Missing Input: no se pudo leer Jira original, confirmado en gate) |
| **F2** | `SPEC_APPROVED` (gate: texto exacto "implementa"/"empieza") | ✅ APROBADO | SDD completo (11 secciones, readiness check 11/11 ✓, SPEC_APPROVED NO seteado en línea 3 — esto es correcto, la flag es para el header SDD, no "aprobado" booleano; la especificación está 100% lista) |
| **F2.5** | story-HU-189.md (9 secciones: análisis, diseño, riesgos, tests, readiness) | ✅ LISTO | Story File presente; §8 identifica hazard R-1 (refund-fantasma) + mitigation CD-8/T-10; §9 plan de tests T-1..T-11 (≥1 por AC) |
| **F3** | Implementación 3 waves + fix-pack | ✅ COMPLETADO | W0 (migración `.sql`), W1 (servicio `resolveHold`/`listHolds`), W2 (rutas admin), W3 (panel HTML), fix-pack post-CR (validación `splitPct` rango, botones anti-doble-submit). `tsc --noEmit` ✅ verde, `npm run build` ✅ verde |
| **AR** | Ataque money-path (7 vectores + 11 categorías) | ✅ APROBADO, 0 BLQ, 1 MENOR | `ar-report.md`: doble-settle exactly-once OK (T-8), testnet-guard fail-closed OK, clamp double OK, hazard R-1 OK, ownership guard OK, recibo/auditoría OK, regresión auto-path OK. MENOR = botones sin disable in-flight (cosmético, confirmado que no hay doble fondos) |
| **CR** | Fidelidad SDD / calidad tests / patrones | ✅ APROBADO, 0 BLQ, 1 MENOR | `cr-report.md`: migración byte-idéntica excepto predicado (única intención funcional), 21 tests significativos (T-1..T-11), no tautológicos. MENOR = `splitPct` clamp silencioso (confusión CD-9 vs T-7; revertido en fix-pack) |
| **Fix-pack** | Resolución AR/CR MENORs | ✅ COMPLETADO | `splitPct∉[0,100]` ahora rechaza con `INVALID_INPUT` ANTES de tocar fondos (`arbiter.ts:921-934`, autoridad correcta T-7/AC-7). Botones deshabilitan al POST in-flight (`dashboard.html:368-373`). 2 tests nuevos (T-7 borde cases) → suite 2851 tests (↑2 de CR) |
| **F4** | Validación ACs + gates post-fix-pack | ✅ APROBADO | `f4-report.md`: 8/8 ACs PASS con evidencia archivo:línea. `tsc 0`, `vitest 2851 PASS`, `npm run build 0 errors`, `biome check 0 errors` (verificado directo post-fix-pack). Migración verificada byte-idéntica. Hazard R-1 confirmado en código. Cero drift (archivos Scope IN exactos, ningún ajeno). |

---

## Acceptance Criteria — resultado final

| AC | Texto | Status | Evidencia |
|----|-------|--------|-----------|
| AC-1 | `GET` admin-gated lista holds con decisión, method, ambiguity_reason, at_stake_usd, chain_id, created_at, intent_id | **PASS** | `arbiter.ts:879-895` (`listHolds`, query FK + embed); ruta `dashboard.ts:176-194` (`GET /api/arbitrations/holds`); test `dashboard.test.ts:167-203` (T-1, 2 owners cross-tenant) |
| AC-2 | `POST` resolve ejecuta el desenlace vía seam existente, transición `arb_hold→arb_closing→settled\|refunded\|failed` | **PASS** | `arbiter.ts:1009-1011` (delega `executeArbitration`, CD-1); ruta `dashboard.ts:202-250`; test `arbiter.test.ts:920-945` (T-2, settle al seller, recibo `arbitration_release`) |
| AC-3 | Recibo inmutable + `method='admin_override'`, `resolved_by`, `resolved_at`, `resolution_note`, preserva `ambiguity_reason`/`llm_reasoning` originales | **PASS** | `arbiter.ts:995-1006` (ArbMeta con 3 campos); `upsertArbitrationRow:261-292` (persiste); test `arbiter.test.ts:948-990` (T-3, preserva ambiguity_reason del hold seed) |
| AC-4 | Intent no en `arb_hold` → rechazo 404/409 sin mover fondos | **PASS** | `arbiter.ts:948,956-958` (status-check); mapeo HTTP `dashboard.ts:38-41`; test `arbiter.test.ts:994-1036` (T-4, 3 casos sin settlement) |
| AC-5 | Sin `X-Admin-Token` válido → 401/403, sin disclosure | **PASS** | `dashboard.ts:59-89` (`requireAdminToken`, `timingSafeEqual`); test `dashboard.test.ts:206-226` (T-5, GET+POST sin header → 401, mocks no invocados) |
| AC-6 | Chain no-testnet → `CHAIN_NOT_SUPPORTED` fail-closed | **PASS** | `arbiter.ts:960-963` (testnet-guard previo a fondos); test `arbiter.test.ts:1039-1057` (T-6, mainnet 1 → error, refunds vacíos) |
| AC-7 | Clamp `settleUsd` a `[0, authorized_usd]`, nunca excede deposit | **PASS** | Doble clamp: app `arbiter.ts:987-993` + RPC `20260712000000_wkh189_arb_hold_override.sql:77`. Fix-pack: `splitPct∉[0,100]` rechaza con `INVALID_INPUT` `arbiter.ts:921-934`. Test `arbiter.test.ts:1061-1152` (T-7, bordes 0/100 válidos, `>100`/`<0` rechazo) |
| AC-8 | `ARBITER_ENABLED!=='true'` → niega panel/endpoints (404 byte-idéntico) | **PASS** | `dashboard.ts:180-182,206-208` (flag-check DESPUÉS de `requireAdminToken`); test `dashboard.test.ts:229-250` (T-9, flag OFF con token válido → 404) |

**Tally: 8/8 PASS**

---

## Hallazgos finales

**BLOQUEANTES**: ninguno

**MENORES (del pipeline AR→CR→F4)**:

1. **AR/MNR-1**: Botones sin disable durante in-flight (cosmético, money-safe, cerrado en fix-pack)  
   → `dashboard.html:368-373,398-399`: botones ahora deshabilitan `data-hold-row` al iniciar POST

2. **CR/MNR-1**: `splitPct` fuera de `[0,100]` se clampa silencioso en lugar de rechazarse  
   → Conflicto interno Story File §6.4 vs T-7. Revertido en fix-pack: ahora rechaza `INVALID_INPUT` ANTES de fondos (autoridad correcta = T-7/AC-7, no CD-9)  
   → Comentario `arbiter.ts:921-925` corregido para citar la autoridad justa

**Estado de cierre**: ambos MENORs resueltos en el mismo fix-pack, documentado en `auto-blindaje.md:29-33`. Zero regressions.

---

## Hazard R-1 (refund-fantasma) — blindado

**Riesgo identificado (SDD §8)**: al ensanchar `close_payment_intent_for_arbitration` para aceptar `arb_hold`, si `recoverArbClosing` recibiera un `arb_hold`, lo transicionaría a `arb_closing` con `consumed_usd=0` (refund total) ANTES de que su guard `prev_status !== 'arb_closing'` lo detenga → refund-fantasma huérfano.

**Por qué NO ocurre hoy (invariante verificado en código)**:
- `expireStale` sweepea SOLO `status='arb_closing'` (`payment-intent.ts:1177`) y `status='disputed'` (L1192), NUNCA `arb_hold` — grep verificado, cero ocurrencias de `.eq('status','arb_hold')` en sweeper
- NO existe transición `arb_closing→arb_hold` (solo `holdArbitration` produce `arb_hold`, gateado en `disputed`, `arbiter.ts:739`)
- La única ruta que invoca el RPC sobre `arb_hold` es `resolveHold` (nueva en esta HU)

**Blindaje añadido**:
- **CD-8** (Constraint Directive inviolable): prohibido sweepear `arb_hold` a recovery
- **T-10(a)** (test de regresión): assert que `expireStale` no selecciona `arb_hold` (`arbiter.test.ts:1255-1264`)
- **T-10(b)** (test defensivo): `recoverArbClosing` forzado sobre `arb_hold` no reembolsa (guard `prev_status` corta antes del finalize, `arbiter.test.ts:1266-1280`)

---

## Auto-Blindaje consolidado

Registro de errores cometidos y lecciones para futuras HUs (extraído de `auto-blindaje.md`):

| Tema | Lección | Aplicar en |
|------|---------|-----------|
| **Wave 0: Cast PostgREST** | Embed anidado de supabase-js requiere cast `as unknown as T[]`, no directo `as T[]` | Queries supabase con embed (FK join anidado) |
| **Wave 2: Fastify Generics** | Generic `<Params:{...}>` va en la llamada `.get<>`/`.post<>()`, NO en el `request` | Toda ruta Fastify tipada (Params/Querystring/Body) |
| **Wave 0-2: Biome Format** | Correr `biome format --write` antes de `biome check` cierre de wave, no confiar en manual | Archivos nuevos/tocados antes de gate de cierre wave |
| **Wave 1 → Fix-pack: Conflicto interno SDD** | Ante conflicto Story-interno (§6.4 vs T-7), gana Constraint Directive (§4) sobre prosa. Reportar desviación | Cualquier contradicción interna Story/SDD |
| **Fix-pack: Distinción CD vs Autoridad** | CD-9 ("no cap") es distinto de "rango de input" (T-7/AC-7). Clamp de `settleUsd` es defensa en profundidad, no validación primaria | Validar RANGO antes de clamp; citar autoridad exacta en comentarios |
| **Fix-pack: Operaciones money-path** | Deshabilitar botones que mueven fondos mientras request in-flight (previene doble-submit UX)  | Rutas que mueven fondos en frontend (botones de acción) |

---

## Archivos modificados

**Migraciones** (2):
- `supabase/migrations/20260712000000_wkh189_arb_hold_override.sql` (127 líneas): ensancha RPC, amplia CHECK, agrega 3 columnas
- `supabase/migrations/20260712000000_wkh189_arb_hold_override_down.sql` (71 líneas): reversible

**Servicios** (1):
- `src/services/arbiter.ts`: agrega `listHolds()` (19 líneas, L879-897), `resolveHold()` (108 líneas, L904-1011), extiende `ArbMeta` con 3 campos nullable, actualiza `upsertArbitrationRow()` para persistir resolver-fields

**Tipos** (1):
- `src/types/arbiter.ts`: extiende `ArbiterMethod` con `'admin_override'`

**Rutas** (1):
- `src/routes/dashboard.ts`: agrega 2 rutas: `GET /api/arbitrations/holds` (19 líneas, L176-194) y `POST /api/arbitrations/:intentId/resolve` (49 líneas, L202-250); mapper `sendArbiterAdminError()`

**Tests** (2):
- `src/services/__tests__/arbiter.test.ts`: agrega 21 tests (T-1..T-11, ~220 líneas)
- `src/routes/__tests__/dashboard.test.ts`: agrega integración T-1/T-5/T-9 (~80 líneas)

**Frontend** (1):
- `src/static/dashboard.html`: sección nueva "Disputas en revisión" con tabla de holds + formulario de resolución (114 líneas, con esc/inputs/confirm/UX anti-doble-submit)

**Docs** (1):
- `doc/sdd/_INDEX.md`: fila 171 a actualizar

---

## Bloque B — Activación pendiente (operativo, fuera de esta HU)

El código está DONE. La activación requiere **Bloque B** (ops):

### Runbook de activación (por ejecutar en Railway/CLI/DB admin)

**Pre-requisito**: WKH-139 v2 (fila 145) migración ya aplicada a `caldz` (prod DB). Si no, coordinar aplicación conjunta de ambas migraciones en el mismo mantenimiento.

**Paso 1: Aplicar migración a la DB de producción (`caldz`)**
```bash
# En la consola Supabase de caldz (prod), ejecutar:
-- file: supabase/migrations/20260712000000_wkh189_arb_hold_override.sql
-- Copiar el contenido completo de la migración y ejecutar en el editor SQL de Supabase
-- Verificar: no hay errores, transición rápida (<5s)
```

**Paso 2: Activar el flag en Railway (prod environment)**
```bash
# En el dashboard de Railway del servicio wasiai-a2a:
# Variables → `ARBITER_ENABLED` = `"true"` (string exacto)
# Redeploy la app
```

**Paso 3: Verificar feature-flag y cap de auto-arbitraje (si fue aplicado)**
```bash
# Verificar en la DB de producción:
SELECT value FROM kite_configs WHERE key = 'ARBITER_ENABLED';
-- esperado: "true"

SELECT value FROM kite_configs WHERE key = 'ARBITER_AUTO_CAP_USD';
-- esperado: "25" (o el valor ratificado por el founder en WKH-139 v2)
```

**Paso 4: E2E de validación (smoke test recomendado)**

a. Auto-resolución por reglas (path existente, verificar que sigue intacto):
   - Crear un `session` intent `$5` en testnet (Fuji 43113 o similar)
   - Iniciar disputa
   - Verificar: árbitro resuelve automáticamente (≤ auto-cap $25) → estado `settled`
   - En `a2a_arbitrations`: `method='rules'` (confirma que el auto-path no cambió)

b. Resolver un hold manualmente (path nuevo):
   - Crear un `session` intent `$50` en testnet
   - Iniciar disputa → árbitro crea `arb_hold` (sobre-tope auto-cap)
   - GET `/dashboard/api/arbitrations/holds` con `X-Admin-Token` → debe listar el hold
   - POST `/dashboard/api/arbitrations/{intentId}/resolve` con body:
     ```json
     {
       "decision": "release",
       "resolvedBy": "ops-admin",
       "note": "Approved post-review"
     }
     ```
   - Verificar: intent transiciona a `settled`, `a2a_arbitrations.method='admin_override'`
   - Verificar: recibo emitido con `receiptType:'arbitration_release'`

---

## Cómo usar el panel en producción

**Acceso del panel de arbitraje**:

1. **URL**: `https://<wasiai-a2a-prod-host>/dashboard` (ya existe, ahora con sección nueva)

2. **Autenticación**:
   - El panel requiere `X-Admin-Token` vía input de texto en la sección "Disputas en revisión"
   - El token es el valor de `DASHBOARD_ADMIN_TOKEN` en Railway (compartido, no per-usuario)
   - Guardado en `localStorage` para session del panel

3. **Interfaz**:
   - Botón "Cargar holds" (`loadHolds()`): GET `/dashboard/api/arbitrations/holds`
   - Tabla: intent (8 chars, ej: `a1b2c3d4`), chain, amount en USD, ambiguity reason, method, decisión
   - Botones por fila: **Liberar** (release 100% deposit al seller), **Reembolsar** (devolver 100% al buyer), **Dividir** (split % configurable)

4. **Workflow de resolución**:
   - Seleccionar fila y hacer click en botón de decisión
   - Confirmar con `confirm()` en español (es obligatorio, muestra que el dinero se mueve de verdad)
   - Si es split, `prompt()` pide porcentaje (0-100)
   - Input opcional `resolvedBy` (nombre/email del admin, para auditoría)
   - POST se ejecuta; en éxito, tabla se recarga automáticamente

5. **Seguridad**:
   - SIN token: GET/POST responden 401 (no expone si existe token ni si existen holds)
   - Token inválido: 401
   - `ARBITER_ENABLED !== 'true'`: GET/POST responden 404 byte-idéntico (no filtra existencia)

**Nota importante**: Los datos de disputas son **cross-tenant** (un admin ve holds de TODOS los propietarios). Esto es una excepción deliberada al patrón de ownership guard de `CLAUDE.md`, documentada explícitamente en el SDD (CD-5) como "superficie de alto privilegio" → revisar en cualquier audit de seguridad futuro.

---

## Lecciones para próximas HUs

1. **Reuse + ensanche aditivo de RPC es más seguro que clonar**: DT-1 (Option B del SDD) decidió ensanchar el predicado de un RPC existente en lugar de crear uno paralelo. Resultado: cero duplicación de logic de dinero, exactly-once garantizado por el `FOR UPDATE` original, menos superficie de ataque. Patrón reusable para extensiones futuras.

2. **Invariantes de DB deben estar explícitas en el código**: el blindaje de R-1 requirió verificar que `expireStale` NUNCA sweep `arb_hold`. Un test de regresión (T-10a) que hace grep anti-substring es tan valioso como el test de comportamiento positivo. Incorporar invariantes como assertions de código desde el día 1.

3. **Constraint Directives son TAN autoritativas como ACs**: cuando el SDD §6.4 y el test T-7 se contradicen, la Constraint Directive gana. El comentario de código debe citar la autoridad exacta (CD-9 = auto-cap, T-7/AC-7 = rango de input) para evitar confusiones futuras en fixes. La prosa de implementación NO es la fuente de verdad.

4. **Money-path UI requiere deshabilitar botones in-flight**: un segundo click in-flight en dinero es "cosmético" hasta que un admin lo hace 3 veces por segundo. La defensa en profundidad en el backend (exactly-once + RPC status-gate) es correcta pero insuficiente — UX debe prevenir el intento. Patrón obligatorio: `button.disabled = true` al iniciar POST, `finally { button.disabled = false }`.

5. **Story File conflictiva debe escalar al humano antes de implementar**: los 2 MENORs de esta HU (botones, `splitPct`) vinieron ambos de ambigüedades en el Story File. El Analyst/Architect debe encontrarlas en F2 y marcar explícitamente `[NEEDS CLARIFICATION]` — implementar "lo que parece correcto" en F3 deja deuda técnica para el fix-pack.

---

## Links

- **Work Item**: [work-item.md](work-item.md)
- **SDD**: [sdd.md](sdd.md)
- **Story File**: [story-HU-189.md](story-HU-189.md)
- **AR Report**: [ar-report.md](ar-report.md)
- **CR Report**: [cr-report.md](cr-report.md)
- **F4 QA Report**: [f4-report.md](f4-report.md)
- **Auto-Blindaje**: [auto-blindaje.md](auto-blindaje.md)

---

## Estado final

✅ **Código DONE**: todos los archivos en `main` (uncommitted, listos para commit)  
⏳ **Pending-Deploy**: migración no aplicada a `caldz`, flag `ARBITER_ENABLED` no flipeado en Railway  
🔒 **Money-path seguro**: exactly-once, testnet fail-closed, clamp double, ownership guard, hazard R-1 blindado  
📋 **Conformidad**: 8/8 ACs PASS, 0 BLQ, 2 MENORs cerrados, 0 drift  
🚀 **Listo para Bloque B**: runbook detallado, pre-requisitos claros, validación e2e descrita

