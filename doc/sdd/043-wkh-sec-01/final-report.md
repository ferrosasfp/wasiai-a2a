# Final Report — WKH-SEC-01: Security Hardening

**HU:** WKH-SEC-01  
**Número SDD:** 043  
**Título:** Security Hardening — HSTS + CORS restrictivo + requireAuth en /registries  
**Rama:** feat/043-wkh-sec-01-hardening  
**Commit:** 8af2155  
**Fecha de cierre:** 2026-04-20  
**Veredicto final:** APROBADO — DONE

---

## 1. Resumen ejecutivo

La HU WKH-SEC-01 cierra tres vulnerabilidades de seguridad detectadas en auditoría (2026-04-20):

1. **Protección de endpoints de escritura en `/registries`** — POST, PATCH, DELETE ahora requieren `x-a2a-key` o `Authorization: Bearer wasi_a2a_*`, reutilizando middleware `requirePaymentOrA2AKey` existente.
2. **CORS env-aware** — Reemplaza wildcard `*` por configuración dinámica que lee `CORS_ALLOWED_ORIGINS` (fail-secure en producción sin valores).
3. **Header HSTS** — Agrega `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` a todas las respuestas.

**Métricas finales:**
- 7 archivos modificados/creados (+387 líneas, -32 líneas neto)
- 7 tests nuevos (350 total, baseline 343 previos PASS)
- 11 Constraint Directives cumplidas
- 0 BLOQUEANTES, 5 MENORES consolidados (deuda técnica aceptada)

---

## 2. Pipeline ejecutado

| Fase | Entrada | Salida | Gate | Status |
|------|---------|--------|------|--------|
| **F0** | Auditoría detecta 3 vulns | project-context.md leído | — | ✅ PASS |
| **F1** | work-item.md + AC EARS | HU_APPROVED | HU_APPROVED | ✅ APROBADO (2026-04-20) |
| **F2** | sdd.md + Constraint Directives | SPEC_APPROVED | SPEC_APPROVED | ✅ APROBADO (2026-04-20) |
| **F2.5** | story-WKH-SEC-01.md (wave única) | 7 archivos en scope IN | — | ✅ GENERADO (2026-04-20) |
| **F3** | Implementación wave 1 | Commit 8af2155 (+387/-32) | — | ✅ COMPLETADO (2026-04-20) |
| **AR** | Ataque empírico | ar-report.md | — | ✅ APROBADO (0 BLOQUEANTES, 5 MENORES) |
| **CR** | Code Review CD-1..CD-11 | cr-report.md | — | ✅ APROBADO (0 BLOQUEANTES, 3 MENORES) |
| **F4** | Validación AC + drift detection | validation.md | — | ✅ APROBADO (todos AC PASS) |
| **DONE** | Consolidación reportes + _INDEX update | final-report.md + PR | — | ✅ PRESENTE |

---

## 3. Acceptance Criteria — Resultado Final

| AC | Descripción | Status | Evidencia |
|---|---|---|---|
| **AC-1** | POST /registries sin auth → 401/403 | ✅ PASS | `src/routes/registries.ts:L47-50` + test `src/routes/registries.test.ts` |
| **AC-2** | DELETE /registries/:id sin auth → 401/403 | ✅ PASS | `src/routes/registries.ts:L129-132` + test `src/routes/registries.test.ts` |
| **AC-2b** | PATCH /registries/:id sin auth → 401/403 | ✅ PASS | `src/routes/registries.ts:L102-105` + test `src/routes/registries.test.ts` |
| **AC-3** | Header HSTS en todas respuestas | ✅ PASS | `src/middleware/security-headers.ts:L12` + test `src/middleware/security-headers.test.ts` |
| **AC-4** | CORS prod + allowlist → rechaza no-listados | ✅ PASS | `src/index.ts:L36-40` + test `src/__tests__/cors.test.ts:L30-70` |
| **AC-5** | CORS dev → wildcard `*` | ✅ PASS | `src/index.ts:L36-40` (branch dev) + test `src/__tests__/cors.test.ts:L71-100` |
| **AC-6** | CORS prod sin allowlist → bloquea todo + warning | ✅ PASS | `src/index.ts:L38` (logging) + test `src/__tests__/cors.test.ts:L101-140` |
| **AC-7** | Todos tests previos pasan + nuevos pasan | ✅ PASS | 350 tests total PASS (343 baseline + 7 nuevos) |

---

## 4. Hallazgos consolidados

### Bloqueantes
**Cantidad:** 0

### Menores (aceptados como deuda técnica)
**Cantidad:** 5 (únicos, consolidados AR + CR)

1. **Mock `update()` faltante en E2E setup** — Tests de registries no pueden mockear `update()` completamente. Nueva HU para mejorar test infrastructure.
2. **Nombre de test legacy AC-3 colisiona nominalmente** — Mitigado con prefijo `describe('security-headers', ...)`. Aceptado.
3. **`prevPaymentWallet` capturado pero no usado** — Ruido cosmético en test, sin impacto en correctitud.
4. **CORS logic duplicada intencionalmente en test** — CD-7: aislamiento de test. Aceptado.
5. **AC-4 vs AC-6 assertion asimétrica (estilo)** — Ambas formas válidas en vitest. Aceptado.

---

## 5. Auto-Blindaje consolidado

### Lecciones extraídas

| Lección | Contexto | Recomendación |
|---------|----------|---------------|
| **Fastify route generics + { preHandler } options** | Cuando agregás `{ preHandler }` como 2do argumento a `fastify.post(...)`, los generics no se propagan. Hay que tiparlos en el call: `fastify.post<{ Body: ... }>(...)`. | Documentar patrón en `.nexus/patterns.md` para futuros desarrolladores. Aplicar en próximas rutas Fastify que mezclen opciones + tipado. |

**Transferibilidad:** Aplicable a cualquier ruta futura que use Fastify + TypeScript + preHandler.

---

## 6. Métricas finales

### Código
- **Archivos modificados/creados:** 7
- **Líneas agregadas:** +387
- **Líneas removidas:** -32
- **Neto:** +355

### Cobertura de tests
| Suite | Nuevo | Total | Pass | Fail |
|-------|-------|-------|------|------|
| registries auth | 3 | 3 | 3 | 0 |
| CORS behavior | 3 | 3 | 3 | 0 |
| HSTS header | 1 | 1 | 1 | 0 |
| Baseline | 0 | 343 | 343 | 0 |
| **Total** | **7** | **350** | **350** | **0** |

### Constraint Directives
- **Total CD:** 11 (definidas en SDD §4.2)
- **Cumplidas:** 11
- **Verificadas con:** Código source + test quality review

### Lint & Quality
- **New TypeScript errors:** 0
- **New linting errors:** 0
- **Baseline lint errors:** 6 (pre-existentes, no tocados)
- **Code duplications:** 1 intencional (CD-7 — CORS test aislamiento)

---

## 7. Archivos del Scope IN

| Archivo | Acción | Líneas | Cambios |
|---------|--------|--------|---------|
| `src/routes/registries.ts` | Modificado | L47-50, L102-105, L129-132 | Agregadas 3 `preHandler` + `requirePaymentOrA2AKey` |
| `src/index.ts` | Modificado | L36-40 | CORS env-aware con `split/trim` + logging |
| `src/middleware/security-headers.ts` | Modificado | L12 | HSTS header `reply.header(...)` |
| `src/middleware/security-headers.test.ts` | Extendido | L15-25 | Test AC-3 |
| `src/routes/registries.test.ts` | Nuevo | 150 líneas | Tests AC-1, AC-2, AC-2b |
| `src/__tests__/cors.test.ts` | Nuevo | 140 líneas | Tests AC-4, AC-5, AC-6 |
| `.env.example` | Extendido | +5 líneas | Documentación `CORS_ALLOWED_ORIGINS` |

---

## 8. Veredictos por fase

| Fase | Veredicto | Detalles |
|------|-----------|----------|
| **AR (Adversarial Review)** | ✅ APROBADO | 0 BLOQUEANTES, 5 MENORES. Ataque empírico verificó AC 1-7 + edge cases. |
| **CR (Code Review)** | ✅ APROBADO | CD-1..CD-11 verificadas. 7 tests nuevos con mocks/assertions correctas. |
| **F4 (QA/Validation)** | ✅ APROBADO | Todos AC satisfechos. Drift detection OK. Baseline 343 tests PASS. |

---

## 9. Decisiones diferidas a backlog

No hay spinoffs nuevos. Todos los MENORES se documentan para housekeeping futuro:

- **HU futura:** "Mejorar E2E test infrastructure — agregar mock `registriesService.update()`"
- **HU futura:** "Test style guide — estandarizar assertion format (AC-4 vs AC-6)"

---

## 10. Lecciones para próximas HUs

### Patrón documentado
1. **Fastify + TypeScript generics:** Usar `fastify.post<{ Body: ... }>(...)` cuando tengas `{ preHandler }` + tipado. Patrón ya está en `src/routes/compose.ts:19` — copiar ese style.

### Proceso
2. **Security headers en middleware:** El hook `onSend` es el lugar correcto. No duplicar en cada ruta (CD-7: no duplicar CORS logic en tests, pero sí en headers).
3. **Env-aware CORS:** `split(',').map(s => s.trim())` es el patrón para listas CSV en env vars. Reutilizar en futuras features que lean listas de valores.
4. **Auth en endpoints de escritura:** Patrón `requirePaymentOrA2AKey` es estable. Usar `description: 'WasiAI <Service> — ...'` nomencia para consistencia.

---

## 11. Referencias

**Artefactos de la HU:**
- `doc/sdd/043-wkh-sec-01/work-item.md` — HU_APPROVED
- `doc/sdd/043-wkh-sec-01/sdd.md` — SPEC_APPROVED
- `doc/sdd/043-wkh-sec-01/story-WKH-SEC-01.md` — Story File (F2.5)
- `doc/sdd/043-wkh-sec-01/ar-report.md` — AR APROBADO
- `doc/sdd/043-wkh-sec-01/cr-report.md` — CR APROBADO
- `doc/sdd/043-wkh-sec-01/validation.md` — F4 APROBADO
- `doc/sdd/043-wkh-sec-01/auto-blindaje.md` — Lecciones F3

**Commit:**
- `feat/043-wkh-sec-01-hardening:8af2155` — Implementación F3

**Index:**
- `doc/sdd/_INDEX.md` — Entrada 043 DONE

---

## 12. Conclusión

**WKH-SEC-01 está COMPLETADO y APROBADO.**

Todas las vulnerabilidades de seguridad identificadas en auditoría han sido cerradas siguiendo la metodología NexusAgil QUALITY pipeline. Los 7 tests nuevos protegen los 3 fixes (auth, CORS, HSTS) con cobertura 100%. Los 5 hallazgos MENORES son de baja severidad y aceptados como deuda técnica para housekeeping futuro.

La HU está lista para merge a `main` y deployable a producción.

---

**Generado por nexus-docs (DONE phase) | 2026-04-20**  
**Pipeline: F1 ✅ → F2 ✅ → F2.5 ✅ → F3 ✅ → AR ✅ → CR ✅ → F4 ✅ → DONE ✅**
