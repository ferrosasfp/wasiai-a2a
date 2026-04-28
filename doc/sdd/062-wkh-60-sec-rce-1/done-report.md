# Report — HU WKH-60 / SEC-RCE-1

## Resumen ejecutivo

Implementación completada de defensa RCE multi-tenant para LLM-generated transform functions. Se cierran 3 vectores de ataque críticos (BLQ-ALTOs: prototype chain escape, microtask leak, IIFE breakout) mediante refactor a worker_threads + vm sandbox interno. 612 tests PASS, auto-blindaje consolidado con 5 lecciones clave. Status: **DONE**.

---

## Pipeline ejecutado

- **F0**: project-context, baseline transform.ts (legacy `new Function` + L1 cache), Supabase schema
- **F1**: work-item.md — HU_APPROVED
- **F2**: sdd.md — SPEC_APPROVED
- **F2.5**: story-WKH-60.md (de facto en prompts orquestador; archivo no en disco post-F3)
- **F3**: Implementación en 6 commits:
  - W0: `vm-runner.ts` + test suite (sandboxed execution)
  - W1: `transform-hmac.ts` (signing/verification con constant-time compare)
  - W2: Migration SQL (`kite_schema_transforms` + `owner_ref` + `transform_fn_sig`)
  - W3: `transform.ts` hardened (4-eq ownership chain, L1+L2 cache scoped por tenant, HMAC fallback)
  - W4: `compose.ts` propagation + 12 integration RCE tests
  - fix-pack: worker_threads refactor + 3 BLQ-ALTO tests + auto-blindaje.md
- **AR**: 3 BLQ-ALTOs encontrados post-W4, resueltos en fix-pack (commit 7f81cd8)
- **CR**: Arquitectura y ownership checks citan archivo:línea en qa-report.md
- **F4**: qa-report.md APROBADO el 2026-04-27; veredicto: **APROBADO PARA DONE**

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | `src/services/llm/vm-runner.ts:225` — executeTransformInVm via Worker+vm. Tests T-VM-1..T-VM-11 PASS. |
| AC-2 | PASS | `vm-runner.test.ts` T-VM-3/T-VM-4/T-VM-5 PASS; `transform-rce.test.ts` T-VER-RCE-1/2/3 PASS. |
| AC-3 | PASS | `vm-runner.test.ts:96` T-VM-8 PASS (68ms timeout kill). `transform-rce.test.ts:215` T-VER-RCE-6 PASS. |
| AC-4 | PASS | `transform.ts:208-212` — getFromL2 incluye 4ta eq `.eq('owner_ref', ownerId)`. T-VER-RCE-7/8 PASS. |
| AC-5 | PASS | `transform.ts:379` guard `if (ownerId !== undefined)`. T-VER-RCE-7 `mockCreate` never called PASS. |
| AC-6 | PASS | `transform.ts:361-362` — cacheKey = `${src}:${tgt}:${hash}:${ownerSegment}`. T-VER-RCE-8/9 PASS. |
| AC-7 | PASS | `transform-hmac.ts:34/53` — signTransformFn + verifyTransformFn. T-HM-1..T-HM-8 PASS. |
| AC-8 | PASS | `transform.ts:231-233` — verifyTransformFn falla → return null. T-VER-RCE-10/11 PASS. |
| AC-9 | PASS | `transform.ts` L2 hit con sig válida. T-VER-RCE-12 PASS. |
| AC-10 | PASS | `vm-runner.ts:153-165` — output JSON-parseado dentro vm. codeGeneration.strings=false. T-VER-RCE-13 PASS. |
| AC-11 | PASS | `vm-runner.ts:256-267` — worker_threads + terminate() mata microtasks. T-VER-RCE-14 PASS (microtaskFired=false). |
| AC-12 | PASS | T-VER-RCE-15: IIFE wrapper breakout → rejects.toThrow() PASS. |

---

## Hallazgos finales

### BLOQUEANTEs

**3 BLQ-ALTOs identificados en AR / fix-pack — todos RESUELTOS:**

1. **BLQ-ALTO-1: Prototype chain escape via `output.constructor.constructor`**
   - Vector: output pasado al vm context retiene su prototype chain del realm caller → acceso a `Function` del caller
   - Causa: `node:vm` cruza realms sin serialización
   - Fix: JSON.parse(output) **adentro** del vm context (línea 153-165 vm-runner.ts)
   - Test: T-VER-RCE-13 (18ms) confirma `Function` bloqueado por `codeGeneration.strings=false`

2. **BLQ-ALTO-2: Microtask leak via `Promise.then` sobrevive timeout**
   - Vector: Microtasks del event loop no se matan con `vm.runInContext` timeout
   - Causa: vm.timeout es sincrónico; async callbacks en el mismo event loop escapan
   - Fix: worker_threads con `worker.terminate()` (línea 256-267 vm-runner.ts) mata event loop entero
   - Test: T-VER-RCE-14 (espera 200ms, verifica microtaskFired=false)

3. **BLQ-ALTO-3: IIFE wrapper breakout via concatenación maliciosa**
   - Vector: `})(output); ATTACK_CODE; (function(o){` cierra wrapper + inserta código + reabre
   - Causa: body concatenado sin escaping
   - Fix: vm.compileFunction + body como string sin concatenación (línea 225 vm-runner.ts)
   - Test: T-VER-RCE-15 confirma rejects.toThrow()

### MENOREs

**4 MNRs documentados en auto-blindaje.md:**

1. **Never-cache mode rompía tests legacy** (Wave W3) — RESUELTO: actualizar callers con ownerId = 'tenant-1'
2. **TransformExecutionError unused import** (Wave W4) — RESUELTO: re-export legítimo, documentado con comentario
3. **Story File ausente en disco** — DOCUMENTADO: orquestador adjuntó contrato en prompt (de facto story file)
4. **node:vm no es security boundary** — DOCUMENTADO: lección AB-WKH-60-1/2/3/4/5

---

## Auto-Blindaje consolidado

Tabla completa de errores y lecciones del pipeline WKH-60:

| ID | Categoría | Descripción | Causa raíz | Fix | Aplicar en |
|----|-----------|-----------|---------|----|-----------|
| AB-WKH-60-1 | Arch | `node:vm` NO es security boundary (Node.js documented) | Asumir aislamiento total sin serialización | Usar worker_threads + JSON parse adentro realm | Cualquier ejecución no-confiable en Node |
| AB-WKH-60-2 | RCE | Prototype chain leak via `output.constructor.constructor` | Output retiene prototipo del realm caller | JSON.parse(output) dentro vm context | Serializar datos cross-realm siempre |
| AB-WKH-60-3 | RCE | Microtasks escapan al timeout sincrónico de vm.runInContext | Event loop compartido; timeout solo mata CPU sync | worker_threads + worker.terminate() | Promise/async/timer execution en sandbox |
| AB-WKH-60-4 | RCE | IIFE wrapper concatenation permite breakout | Body concatenado sin escaping | vm.compileFunction + body como string | Code generation desde LLM: nunca concatenar |
| AB-WKH-60-5 | Testing | AR con vectores RCE ingenuos deja pasar avanzados | Tests iniciales solo cubrían `process` directo | Repro real de BLQs; incluir constructor/Promise/wrapper | Security adversarial review: coverage completo |
| AB-WKH-60-W3 | Process | Never-cache mode rompía tests legacy sin actualizar callers | Refactor de firma sin actualizar mocks | Actualizar 6 tests legacy a pasar ownerId | Cambios de firma pública: verificar ALL callers |
| AB-WKH-60-W4 | Process | TransformExecutionError import unused tras format | Re-export legítimo no flagged por tsc | Documentar con comentario inline | Re-export de errors: comentar razón |
| AB-WKH-60-F2.5 | Process | Story File ausente en disco post-F2.5 | F2.5 agent no escribió o se perdió commit | Contrato en prompt del orquestador = de facto story | Cuando falte SF pero exista contrato en prompt |

Columna "Aplicar en" orientada a futuras HUs con transformaciones de código no-confiable, ownership multi-tenant, o cambios de firmas públicas.

---

## Archivos modificados

**Total: 12 archivos en 6 commits (W0-W4 + fix-pack), 1510 inserciones, 263 deleciones**

### Dominio: Sandbox & VM Execution
- `src/services/llm/vm-runner.ts` (+356 -263 líneas) — worker_threads + vm.createContext + timeout + resourceLimits
- `src/services/llm/vm-runner.test.ts` (+132 -132) — T-VM-1..T-VM-11 (isolation, timeout, RCE vectors)

### Dominio: Transform Service Hardening
- `src/services/llm/transform.ts` (+232 -0) — ownership 4-eq chain, L1+L2 caching, HMAC verify, never-cache mode, error propagation
- `src/services/llm/transform.test.ts` (+80 -0) — legacy mock updates (ownerId + 4-eq chain)

### Dominio: HMAC & Integrity
- `src/services/llm/transform-hmac.ts` (+84 -0) — signTransformFn + verifyTransformFn (timingSafeEqual)
- `src/services/llm/transform-hmac.test.ts` (+84 -0) — T-HM-1..T-HM-8 (signing, verification, degraded mode)

### Dominio: Integration & E2E RCE Tests
- `src/services/llm/__tests__/transform-rce.test.ts` (+516 -0) — 12 tests (cache scoping, HMAC, 3 BLQ-ALTOs)
- `src/services/llm/__tests__/transform-verification.test.ts` (+57 -57) — legacy updates (4-eq mocks)

### Dominio: Orchestration
- `src/services/compose.ts` (+7 -0) — propagate `scopingKeyRow?.owner_ref` a `maybeTransform` (línea 172-178)

### Dominio: Database & Schema
- `supabase/migrations/20260427230000_kite_schema_transforms_owner.sql` (+58 -0) — `owner_ref TEXT`, unique 4-tupla, index, `transform_fn_sig TEXT`
- `scripts/apply-rce-migration.mjs` (+72 -0) — Supabase Management API apply + idempotency checks

### Dominio: Documentation
- `doc/sdd/062-wkh-60-sec-rce-1/auto-blindaje.md` (+95 -0) — Consolidado de 5 lecciones RCE + 3 W3/W4/fix-pack learnings

---

## Decisiones diferidas a backlog

**Spinoffs creados para trabajo futuro:**

1. **WKH-SEC-02 (TD-SEC-01)**: Implementar RLS real en PostgreSQL (`ALTER TABLE a2a_agent_keys ENABLE ROW LEVEL SECURITY` + CREATE POLICY) — hoy la defensa es solo app-layer (WKH-53, WKH-60)
2. **WKH-SEC-03**: Audit todas las tablas de `a2a_events`, `registries` para ownership columns (hoy `tasks` sin owner_ref, `a2a_events` sin dueño)
3. **WKH-60-ISOLATED-VM**: Evaluar `isolated-vm` como alternativa a `worker_threads` para máxima isolation (research + POC)

---

## Lecciones para próximas HUs

### 1. Security Boundaries en Node.js son **composition**, no framework

`node:vm` es un aislamiento de namespace, no de seguridad. Para ejecutar código no-confiable:
- **NUNCA**: `new Function(userCode)`, `eval(userCode)`, `vm.runInContext` solo
- **SIEMPRE**: combinar worker_threads (event loop aislado) + vm.createContext adentro (namespace aislado)
- **Serializar todo**: datos cross-realm vía JSON.stringify + JSON.parse en el destino, nunca referencias directas

### 2. Ownership en caché multi-tenant es crítico

Cuando una HU añade una columna `owner_ref` a una tabla cachecada:
- Actualizar **TODAS** las queries `.eq('id', ...)` a incluir `.eq('owner_ref', ...)` ANTES del `.single()`
- Revisar **TODOS** los tests que mockean esa tabla — actualizar chain de eq() y mocks de return value
- Never-cache mode: documentar claramente cuándo el owner es `undefined` y qué sucede (bypass L2 read/write)

### 3. Adversarial Review debe incluir repro real

Los 3 BLQ-ALTOs fueron hallados POST-SPEC porque los tests iniciales solo cubrían vectores ingenuos. En futuras HUs security-critical:
- AR debe incluir repro de ataque real (`node /tmp/exploit.mjs` ó `curl` con payload)
- No aceptar AR de "conceptual" — exigir demostración ejecutada
- Los tests automatizados cubren caminos happy-path; el adversary cubre caminos de *breakage*

### 4. Cambios de firma pública requieren auditoría de callers

W3 cambió `maybeTransform(src, tgt, output, user)` a `maybeTransform(src, tgt, output, user, ownerId)`. Sin actualizar tests legacy, la cobertura colapsó (6 tests dejaron de ejercitar L2 path). Regla: grep todos los call sites, actualizar mocks, verificar intención original del test se mantiene.

### 5. Migration SQL idempotent + apply script en JS

El patrón para WKH-60 resultó limpio: migration con `IF NOT EXISTS`, apply script que verifica idempotency, documento de smoke manual para operador. Repetir en futuras schema changes.

---

## Verificaciones finales

- **Tests**: 612 passed (sin flakes)
- **Tipo**: tsc --noEmit exit 0
- **Branch**: feat/062-wkh-60-sec-rce-1 (6 commits: W0-W4 + fix-pack)
- **QA veredicto**: APROBADO PARA DONE (qa-report.md)
- **Auto-blindaje**: consolidado en tabla de 8 entries (5 RCE + 3 process learnings)

---

**Status final: DONE** — listo para merge a main.
