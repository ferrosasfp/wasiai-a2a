# Report — HU WKH-142 Guard de Importe Negativo en el Money-Path

**Status**: **DONE** (veredicto F4: 5/5 ACs PASS con evidencia en Postgres efímero + 2516 tests)
**Date**: 2026-07-04
**Branch**: `fix/143-wkh-142-negative-amount-guard` @ commit `a23cff0`
**PR**: #164 (MERGEABLE, CI verde tras lint fix)

---

## Resumen ejecutivo

WKH-142 cierra la **defensa final** contra importes negativos en el money-path. Follow-up de seguridad de WKH-134 (publish self-serve). El vector: un `p_amount_usd` negativo que llegara al RPC de débito (`increment_a2a_key_spend`) **sumaría** al budget prepago en vez de restar (`new_bal = current − (−X)`), neutralizando el check de fondos y el daily-limit. 

**Defensa implementada** (3 capas):
1. **DB choke-point único** (`increment_a2a_key_spend`): guard `IF p_amount_usd IS NULL OR < 0 OR = 'NaN'::numeric THEN RAISE EXCEPTION 'INVALID_AMOUNT'` antes de mutar budget. Los 4 RPCs de débito heredan vía `PERFORM` (sin duplicar).
2. **App-layer** (`compose.ts`): `isInvalid` rechaza `agent.priceUsdc < 0` con fallback `PLACEHOLDER_FEE_USD`.
3. **DB constraint** (`a2a_agents`): `CHECK (price_usdc >= 0 AND price_usdc <> 'NaN'::numeric)` con clamp defensivo de datos preexistentes en la MISMA transacción de migración.

**Error code estable** (`DEBIT_INVALID_AMOUNT`): mapeado en las 4 rutas de `budgetService.debit` (master, master-dest, session, delegación) para consistencia de contrato.

**Entregas**: 2 migraciones SQL (UP/DOWN), 5 archivos TS (errors, budget, delegation, key-session, compose), 7 suites de test (2516 tests, 2516 PASS).

---

## Pipeline ejecutado

| Fase | Estado | Fecha | Veredicto / Hito |
|------|--------|-------|------------------|
| F0 | ✅ COMPLETO | 2026-07-04 | Grounding verificado: choke-point confirmado (los 3 RPC hermanos → `PERFORM increment_a2a_key_spend`); exemplars leídos (sec02b, wkh134, error classes); Missing Input resuelto (error code estable) |
| F1 | ✅ HU_APPROVED | 2026-07-04 | work-item.md: AC-1..AC-5, DT-1..DT-4, CD-1..CD-5 bloquados; Scope IN/OUT explícito |
| F2 | ✅ SPEC_APPROVED | 2026-07-04 | sdd.md: DT-5..DT-8, CD-6..CD-9, plan de tests (T1..T9), ejemplares verificados, readiness check ✅; Missing Input **DT-6 resuelto**: código estable `DEBIT_INVALID_AMOUNT`, mapeo en 4 rutas |
| F2.5 | ✅ LISTO | 2026-07-04 | story-HU-142.md: contrato de implementación, waves W0/W1/W2/W3, anti-hallucination checklist |
| F3 | ✅ IMPLEMENTADO | 2026-07-04 | Waves completadas: W0 (migración UP/DOWN), W1 (error code + mapeo 4 rutas), W2 (compose fix), W3 (tests). Commit único `33a49af` + fix-pack `a23cff0` (MNR-1: NaN en CHECK; MNR-2 comentarios INVALID_AMOUNT; MNR-3 errors.test.ts drift) |
| AR | ✅ OK, 1 MENOR | 2026-07-04 | Adversarial Review **no hay reporte AR formal** (pipeline "auto"). Drift detection cero: 15 archivos modificados = exactamente Scope IN (migraciones UP/DOWN, errors.ts, budget.ts, delegation.ts, key-session.ts, compose.ts, 7 test files). CD-2 (refund intactas): ✅. CD-7 (INVALID_AMOUNT aparece 1 vez UP, 0 DOWN): ✅. CD-4 (hardening re-aplicado): ✅. HALLAZGO MENOR: el mapeo de `INVALID_AMOUNT` en las 4 rutas aplica antes del fallback (correcto), pero la propagación del msg crudo fue verificada como bloqueada por el patrón `success:false` / `throw new Error()` (dinero seguro, solo un issue de observabilidad). |
| CR | ✅ OK, 1 MENOR | 2026-07-04 | Code Review **no hay reporte CR formal** (pipeline "auto"). Calidad de código: TypeScript strict (tsc ✅), tests cobertura (2516/2516), lint (biome ✅ tras fix-pack). El único MENOR: los comentarios de SQL incluyeron literal `INVALID_AMOUNT` rompiéndose con el test "aparece exactamente 1 vez"; solucionado con comentarios reescritos ("el prefijo del guard", "el guard de importe negativo"). |
| F4 | ✅ 5/5 ACs PASS | 2026-07-04 | **Verificación en Postgres 15 efímero real (Docker, roles + migraciones hasta 20260707)**: R1-R12 (tests runtime); R10 reversibilidad CRÍTICA (applied down → mutadas filas a -1/NaN → applied up → clamp verifica, constraint no falla) confirma CD-3. R11: el down REPRODUCE exactamente el bug original (`p_amount_usd = -2` SUMA al balance sin el guard, `9.0 → 11.0`). R13: hardening preservado (search_path, REVOKE/GRANT). R1-R5: débito negativo/NaN/NULL rechazados; 0 pasa válido; positivo (1.0) acepta. Suites unit (test coverage): T1-T9 PASS, no-regresión. **AC-5 verificación real** (INSERT directo rechazo `23514`): ✅ R7/R8. |

---

## Acceptance Criteria — resultado final

| AC | Texto EARS (resumen) | Status | Evidencia archivo:línea |
|----|---|---|---|
| AC-1 | `increment_a2a_key_spend` con `p_amount_usd < 0`/NULL/NaN → RAISE `INVALID_AMOUNT` ANTES de tocar `budget`/`daily_spent_usd` | ✅ PASS | Código: `supabase/migrations/20260707000000_wkh142_negative_amount_guard.sql:60-65` (guard entre ownership-guard line 49 e `is_active` line 51). Test: `test/negative-amount-guard.migration.test.ts` (T1 + AC-1 comportamiento); `src/services/money-path.concurrency.test.ts` (T2 negativo rechazado, balance sin cambios). Runtime: R1/R2/R3/R4 (§1 validation.md) — `-1`, `NaN`, `NULL` lanzan excepción; `0` válido; positivo `1.0` resta correctamente |
| AC-2 | Los otros 3 RPC de débito heredan `INVALID_AMOUNT` vía `PERFORM increment_a2a_key_spend` (sin re-implementar) | ✅ PASS | Código: choke-point confirmado. `debit_with_dest_policy`, `debit_session_and_parent`, `debit_delegation_and_parent` SIGUEN haciendo `PERFORM increment_a2a_key_spend(...)` (confirmado: no redefinidos en la migración, DT-1). Test: T3 (CD-7 INVALID_AMOUNT aparece exactamente 1 vez UP). Runtime: R6 — `debit_with_dest_policy(..., -5, ...)` rechazado con `CONTEXT: ... PL/pgSQL function debit_with_dest_policy line 54 at PERFORM`, mostrando herencia del guard |
| AC-3 | `compose.isInvalid` trata `agent.priceUsdc < 0` como inválido (fallback `PLACEHOLDER_FEE_USD`) | ✅ PASS | Código: `src/services/compose.ts:210` (`agent.priceUsdc < 0 \|\| ...` agregado). Test: T4 (per-step negativo priceUsdc cae a fallback + warn reason). Runtime: no ejercitado en Postgres efímero (es app-layer), pero unit test + integración en compose.test.ts verifica que `-1` nunca llega a `budgetService.debit` |
| AC-4 | Migración clampea `price_usdc < 0 → 0` ANTES del `ADD CONSTRAINT` (misma tx) | ✅ PASS | Código: `supabase/migrations/20260707000000_wkh142_negative_amount_guard.sql` L~126 (`UPDATE` clamp) precede L~129 (`ALTER TABLE ADD CONSTRAINT`); ambos dentro de `BEGIN;`/`COMMIT;`. Test: T5 (indexOf UPDATE < indexOf ADD CONSTRAINT en el archivo). Runtime: R10 (§1) — aplicado down, mutadas filas a -1/NaN, re-aplicado up: log muestra `UPDATE 2` (clamp) antes de `ALTER TABLE ADD CONSTRAINT` (éxito); confirma CD-3 |
| AC-5 | INSERT/UPDATE directo con `price_usdc < 0` rechazado por Postgres (`23514`/constraint violation) | ✅ PASS | Código: `supabase/migrations/20260707000000_wkh142_negative_amount_guard.sql:129` (`ALTER TABLE public.a2a_agents ADD CONSTRAINT a2a_agents_price_usdc_nonneg CHECK (price_usdc >= 0 AND price_usdc <> 'NaN'::numeric)`). Test: T6 (constraint presente en UP, drop en down). Runtime: R7/R8 (§1) — `INSERT a2a_agents (..., price_usdc=-1)` rechazado con `ERROR: 23514 new row violates check constraint "a2a_agents_price_usdc_nonneg"` (SQLSTATE exacto verificado con VERBOSITY verbose); idem para `'NaN'::numeric`. R9: `INSERT price_usdc=1.0` éxito |

---

## Hallazgos finales

### BLOQUEANTEs
- **Ninguno**. El guard funciona como especificado en las 4 rutas + el constraint + la app-layer.

### MENOREs (aceptados como deuda técnica)
1. **Mapeo observabilidad msg crudo** (CR MENOR): El msg crudo de Postgres (`"INVALID_AMOUNT: p_amount_usd -1 must be a non-negative number"`) nunca llega al cliente (bloqueado por pattern `success:false` / `throw new Error()` + contrato code `DEBIT_INVALID_AMOUNT`), pero en los logs internos de error el detalle de PG es legible. No es un hallazgo de seguridad (el dinero está seguro), pero flag para futuras HUs: considerar redactar el mensaje de excepción del RPC para evitar detalles no-público de input en los logs. *Aceptado como Follow-up técnico si surge.*

2. **Comentarios de código tocaron el literal INVALID_AMOUNT** (CR MENOR, YA SOLUCIONADO en fix-pack `a23cff0`): Los comentarios de la migración mencionaban `INVALID_AMOUNT` lo que rompía el test "aparece exactamente 1 vez". Solucionado: comentarios reescritos sin el literal (describen la función, no repiten el código). Esta fue la causa real del gate de lint rojo en CI (falso positivo de configuración) — se actualizó la lógica del test y los comentarios. No afecta la seguridad del artefacto final.

### Deuda técnica diferida (Scope OUT, follow-ups)
- **CHECK en `a2a_agent_keys.daily_limit_usd` / `max_spend_per_call_usd`** (identificado en WKH-142 F0, Scope OUT): Esos NUMERIC del owner podrían validarse como `>= 0` pero el riesgo es MENOR (el owner se configura a sí mismo, no un tercero). Futura HU si se requiere. No bloqueante.
- **JSONB `budget` sin validación de valores internos**: El `budget` de `a2a_agent_keys` es `{chain_id: monto}` — validar valores internos requeriría trigger/función de Postgres, no un CHECK simple. Out of scope de WKH-142 (ya implícitamente N/A en work-item). Seguimiento separado si se requiere.

---

## Auto-Blindaje consolidado

Lecciones acumuladas del pipeline (documentadas en `auto-blindaje.md` + este reporte):

| # | Tema | Lección | Aplicar en próximas HUs |
|----|------|---------|------------------------|
| 1 | **Test SQL extensibles** | Aserciones `toContain()` que incluyen delimitadores de cierre (ej. `CHECK (price_usdc >= 0)` con `)`) acopla el test a la forma exacta del predicado. Solución: usar substring sin delimitadores de cierre (`CHECK (price_usdc >= 0` sin `)`) y tests dedicados para predicados complejos (ej. MNR-1 NaN). | Cualquier test migración que valide cláusulas SQL extensibles |
| 2 | **Conteo exacto de tokens en migración** | El CD "aparece exactamente N veces" es sensible a comentarios. NO mencionés el literal del error code/función dentro de comentarios si hay un CD de conteo; describir la función con palabras en lugar. | CDsN sobre apariciones de tokens en migraciones SQL |
| 3 | **Error class drift en errors.test.ts** | `errors.test.ts` tiene contrato `ERROR_CONTRACT` que valida TODAS las clases exportadas que extienden `Error`. Cualquier clase nueva DEBE agregarse a la tabla o el suite falla (fail-on-drift intencional). | Cualquier HU que agregue `export class XError extends Error` en `security/errors.ts` |
| 4 | **Choke-point único en DB** | El guard de `increment_a2a_key_spend` se aplica a todos los 4 RPCs de débito sin duplicar, vía `PERFORM`. Ventaja: mantenimiento centrado, sin divergencia. Riesgo: error en la función madre rompe TODOS los débitos. Mitigación: DT-2 (copia literal + un IF agregado, sin tocar lógica) + tests de no-regresión. | Cualquier HU que toque RPCs de choke-point crítico |
| 5 | **Migración auto-suficiente con clamp** | El `UPDATE ... SET price_usdc = 0 WHERE price_usdc < 0` dentro de la MISMA transacción del `ALTER TABLE ADD CONSTRAINT` neutraliza el riesgo de "filas negativas preexistentes rompen migration". Reproducible en dev/staging/prod sin script manual previo. | Cualquier HU que agregue CHECK sobre NUMERIC con riesgo de datos preexistentes "malos" |

---

## Archivos modificados

Git diff final: `fix/143-wkh-142-negative-amount-guard` → main

**Migraciones** (2 archivos, W0):
- `supabase/migrations/20260707000000_wkh142_negative_amount_guard.sql` (UP: función + hardening + clamp + constraint)
- `supabase/migrations/20260707000000_wkh142_negative_amount_guard_down.sql` (DOWN: drop constraint + restore función)

**TypeScript** (5 archivos, W1+W2):
- `src/services/security/errors.ts` (+ `InvalidDebitAmountError`)
- `src/services/budget.ts` (mapeo INVALID_AMOUNT → DEBIT_INVALID_AMOUNT en 4 rutas)
- `src/services/delegation.ts` (throw `InvalidDebitAmountError` en mapeo msg)
- `src/services/key-session.ts` (throw `InvalidDebitAmountError` en mapeo msg)
- `src/services/compose.ts:210` (|| agent.priceUsdc < 0 agregado)

**Tests** (7 archivos, W3):
- `test/negative-amount-guard.migration.test.ts` (nuevo, T1-T6 estructurales)
- `src/services/money-path.concurrency.test.ts` (extendido, T2 comportamiento)
- `src/services/budget.test.ts` (extendido, T7-T9 error code + no-regresión)
- `src/services/compose.test.ts` (extendido, T4 per-step negativo)
- `src/services/delegation.test.ts` (extendido, T8 mapeo InvalidDebitAmountError)
- `src/services/key-session.test.ts` (extendido, T8 mapeo)
- `src/services/errors.test.ts` (actualizado, ERROR_CONTRACT con `InvalidDebitAmountError`)

**Documentación** (1 archivo, artefacto de proceso):
- `doc/sdd/143-wkh-142-negative-amount-guard/auto-blindaje.md` (lecciones M1-M3 finales)

---

## Decisiones diferidas a backlog

Ninguna. Todo lo planeado se completó. Los siguientes temas quedan explícitamente para HUs futuras (no bloqueantes):
- **WKH-148** (sugerida, no creada aún): CHECK en `daily_limit_usd`/`max_spend_per_call_usd` de `a2a_agent_keys`.
- **WKH-149** (sugerida): JSONB `budget` con validación de valores internos (trigger).

---

## Lecciones para próximas HUs

1. **Test estructurales sensibles a forma**: Los tests de migración basados en regex/substring deben desacoplarse de delimitadores si la cláusula SQL es extensible (ej. `CHECK (columna >= 0 AND columna <> 'NaN')`). Usar substrings sin cierre y tests dedicados.

2. **Conteo de tokens con CDs**: Los CDs del tipo "aparece exactamente N veces" deben ser interpretados como "en el código ejecutable" (ej. `RAISE`, `UPDATE`, `ALTER`), no en comentarios. Documentar esto en la próxima HU similar.

3. **Error class inventory governance**: Toda clase nueva que extienda `Error` en `security/errors.ts` DEBE registrarse en `ERROR_CONTRACT` de `errors.test.ts` — no es un extra, es un gate obligatorio (`fail-on-drift`).

4. **Migración bidireccional verificable**: El DOWN debe reproducir el estado pre-HU fielmente (en WKH-142: el down remove el guard y el constraint, permitiendo filas negativas; re-aplicar el up confirma que el clamp las neutraliza). Esto valida que la migración es verdaderamente reversible.

5. **Choke-point único vs riesgo**: Centralizar un guard en UNA función (ej. `increment_a2a_key_spend`) reduce duplicidad y surface pero aumenta el riesgo de that un error lo rompe todo. Mitigar con: copia literal del cuerpo + un IF agregado (no reescritura), tests de no-regresión, verificación en Postgres efímero ANTES de merge.

---

## Status Final

**HU WKH-142: DONE**

Todas las ACs pasadas con evidencia en Postgres efímero real (no mockups). El guard se aplica en las 4 rutas de débito sin duplicación. El error code es estable y mapeado. La migración es auto-suficiente y bidireccional.

**⚠️ ALERTA CRÍTICA — Migración PENDIENTE de aplicar a PROD (caldz mainnet)**

El código está DONE, pero la **migración NO está aplicada en caldz** (mainnet). La HU está completa cuando:
1. PR #164 mergeado a main (CI verde, MERGEABLE hoy)
2. **Migración aplicada a caldz con `supabase/migrations/20260707000000_wkh142_negative_amount_guard.sql`** (ops task, fuera de scope de esta HU)
3. Validación post-apply en caldz (verificar que el guard funciona con un pequeño débito real en staging)

Hasta entonces: **el vector no está cerrado en PROD**. El publish boundary de WKH-134 lo cierra en el lado inbound (validación + clamp en read), pero el guard en el choke-point es la defensa en profundidad del débito. **Sin la migración, no activada.**

---

**Fecha de cierre**: 2026-07-04
**Reportado por**: nexus-docs (fase DONE)
**Siguiente paso**: humano revisa este report, aprueba merge de #164, ops aplica migración a caldz, notifica verificación.
