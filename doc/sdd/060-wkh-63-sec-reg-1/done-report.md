# Report — WKH-63 / SEC-REG-1 — registries CRUD sin ownership

**Status Final**: DONE
**Fecha de cierre**: 2026-04-27
**Branch**: `feat/060-wkh-63-sec-reg-1`
**Commits**: 6 (W0–W4 original + 1 fix-pack BLQ-ALTO-1)
**Tests**: 577 passed / 0 failed

---

## Resumen ejecutivo

Implementamos ownership guard en la tabla `registries` para cerrar cross-tenant IDOR donde cualquier x402 payer podía modificar registries de otro. Se identificó y resolvió BLQ-ALTO-1 (sentinel compartido `'x402-anonymous'`) en fix-pack post-AR. Sistema completamente testeado (8 ACs, 20 tests nuevos de ownership, 577 tests en total) y listo para merge. Migración DDL lista; operador debe verificar apply en Supabase remoto (no bloqueante).

---

## Pipeline ejecutado

| Fase | Status | Evidencia |
|------|--------|-----------|
| **F0: project-context** | DONE | `.nexus/project-context.md` cargado. Contexto WasiAI A2A completo. |
| **F1: work-item.md** | SKIPPED | No existe. Artefacto fue reemplazado por prompt del orquestador. Documentado en auto-blindaje.md (F2.5 saltada). |
| **F2: sdd.md** | IMPLICIT | No existe disco. Especificación derivada de BACKLOG + commit messages de las 5 waves. |
| **F2.5: story-WKH-63.md** | SKIPPED | Nunca generado. F2.5 no fue ejecutada. Las 5 waves se implementaron basándose en prompt de orquestador + ejemplares previos (WKH-53, WKH-61, WKH-62). |
| **F3: implementación (W0–W4)** | DONE | 5 waves ejecutadas: W0 (migration), W1 (types), W2 (service), W3 (routes), W4 (tests) |
| **F3.1: fix-pack post-AR** | DONE | Commit e2b8699: BLQ-ALTO-1 resuelto + MNR-1 + MNR-2 |
| **AR: Adversarial Review** | APROBADO | BLQ-ALTO-1 (sentinel) identificado y cerrado. Patrón ownership reforzado. |
| **CR: Code Review** | APROBADO | Guard correctness, test coverage, lint/type, telemetría completa. |
| **F4: QA Validation** | APROBADO | 8 ACs verificados con evidencia archivo:línea. 577/577 tests pass. tsc clean. |

---

## Acceptance Criteria — Resultado Final

| AC | Descripción | Status | Evidencia |
|----|-------------|--------|-----------|
| AC-1 | WHEN `registryService.register` es llamado con un `ownerRef`, the system SHALL persistir ese valor en `registries.owner_ref`. | **PASS** | `src/services/registry.ownership.test.ts:119` — T-SVC-01. 577/577 tests pass. |
| AC-2 | WHEN `registryService.update` recibe `ownerRef` y la fila pertenece a otro tenant, the system SHALL lanzar `OwnershipMismatchError` (HTTP 404). | **PASS** | `src/services/registry.ownership.test.ts:153,181` — T-SVC-02, T-SVC-04. Route: `src/routes/registries.ownership.test.ts:165` T-OWN-03, T-OWN-06. |
| AC-3 | WHEN `registryService.update` o `delete` intenta mutar `owner_ref='system'`, the system SHALL lanzar `SystemRegistryImmutableError` (HTTP 403). | **PASS** | `src/services/registry.ownership.test.ts:165,257` — T-SVC-03, T-SVC-08. Route: `src/routes/registries.ownership.test.ts:180,234` T-OWN-04, T-OWN-08. |
| AC-4 | WHEN `registryService.delete` recibe `ownerRef` y la fila pertenece a otro tenant, the system SHALL lanzar `OwnershipMismatchError` (HTTP 404). | **PASS** | `src/services/registry.ownership.test.ts:273` — T-SVC-09. Route: `src/routes/registries.ownership.test.ts:221` T-OWN-07. |
| AC-5 | WHEN un caller actualiza su propia registry, the system SHALL ejecutar UPDATE/DELETE con filtro `(id, owner_ref)` para defensa TOCTOU. | **PASS** | `src/services/registry.ownership.test.ts:197,289` — T-SVC-05 (UPDATE), T-SVC-10 (DELETE). Código: `src/services/registry.ts:226,303` `.eq('owner_ref', ownerRef)` siempre junto a `.eq('id', id)`. |
| AC-6 | WHEN un caller llega vía x402 puro (sin a2a-key), the system SHALL rechazar POST/PATCH/DELETE con HTTP 403 `A2A_KEY_REQUIRED`. GET sigue público. | **PASS** | `src/routes/registries.ownership.test.ts:140,288` — T-OWN-02 (POST), T-OWN-11 (POST+PATCH+DELETE). Service mock no invocado: `expect(mockRegister).not.toHaveBeenCalled()`. |
| AC-7 | WHEN se produce `OwnershipMismatchError` en registries, the system SHALL loguear con `logOwnershipMismatch` (paridad con WKH-53). | **PASS** | `src/services/security/errors.ts:21-24` — `OwnershipOp` extendido. `src/services/registry.ts:214,225,276,303,314` — 5 paths instrumentados. Verificado en stderr durante test runs. |
| AC-8 | WHEN `RegistryConfig` incluye `ownerRef: string`, all existing tests SHALL compilar sin cambio funcional. | **PASS** | `tsc --noEmit` exit 0. 4 archivos de test modificados solo en fixtures: `agent-card.test.ts`, `compose.test.ts`, `discovery.test.ts`, `discovery.ssrf.test.ts`. 577/577 tests pass. |

---

## Hallazgos finales

### BLOQUEANTEs
- ✅ **BLQ-ALTO-1** (cross-tenant IDOR via `'x402-anonymous'`): **RESUELTO** en commit e2b8699
  - Fix: rechazar POST/PATCH/DELETE vía x402 puro con `403 A2A_KEY_REQUIRED`
  - Test: T-OWN-02, T-OWN-11
  - Patrón: nunca usar sentinels compartidos como ownerRef

### MENOREs
- ✅ **MNR-1** (telemetría incompleta ownership mismatch): **RESUELTO** en e2b8699
  - Extender `OwnershipOp`, agregar overload objeto, instrumentar 5 paths
  - Paridad con patrón WKH-53
- ✅ **MNR-2** (migration DDL sin transacción): **RESUELTO** en e2b8699
  - Wrap `BEGIN;`/`COMMIT;` en `supabase/migrations/20260427210000_registries_owner_ref.sql`
  - Robustez para fallos parciales

### OBSERVACIONEs pre-existentes (out-of-scope, documentadas)
- **OBS-1**: GET/POST enumeration de registries (abierto en WKH-62/WKH-63 backlog, WKH-SEC-02 agenda RLS Postgres-level)
- **OBS-2**: DB apply no verificable en sandbox — operador debe ejecutar query de confirmación (qa-report.md sección 1.1)
- **OBS-3**: F2.5 saltada (process gap, no TD técnico) — documentado en auto-blindaje.md

---

## Auto-Blindaje consolidado

Lecciones extraídas durante F3 y fix-pack, aplicables a futuras HUs:

| Fecha | Tema | Error / Descubrimiento | Causa Raíz | Fix / Patrón | Aplicar en |
|-------|------|------------------------|-----------|-------------|-----------|
| 2026-04-27 21:45 | Story File ausente al iniciar F3 | `doc/sdd/060-wkh-63-sec-reg-1/story-WKH-63.md` no existe en disco | F2.5 fue saltada; orquestador pasó waves por prompt | Proceder con prompt como substitute, documentar para QA | **Futuras HUs**: verificar `ls doc/sdd/NNN-titulo/story-*.md` antes de lanzar `nexus-dev`. Si falla, lanzar `/nexus-p3-f2-5 WKH-XX` primero. |
| 2026-04-27 22:00 | BLQ-ALTO-1: sentinel compartido `'x402-anonymous'` = cross-tenant IDOR | Cualquier x402 payer (atacante con $1 USDC) podía modificar registries de otro x402 payer porque ambos caían al sentinel → `'x402-anonymous' === 'x402-anonymous'` pasaba ownership guard | Confusión sobre identidad: un sentinel compartido NO es una identidad — colapsa todos los anónimos en un mismo "tenant", lo opuesto a lo que ownership guard necesita | Rechazar POST/PATCH/DELETE (`403 A2A_KEY_REQUIRED`) cuando `request.a2aKeyRow` undefined. Guard corta antes del service. Test T-OWN-11. | **Futuras HUs con ownership**: regla: **nunca usar sentinels compartidos como ownerRef**. Si no hay tenant identity verificable (a2a-key con propiedad criptográfica/exclusiva), rechazar la mutación — no normalizar a sentinel. |
| 2026-04-27 22:00 | MNR-1: logOwnershipMismatch sin overload para registries | 5 paths `OwnershipMismatchError` en registry.ts silenciosos, sin telemetría. Drift vs patrón WKH-53 (budget.ts, identity.ts sí logueaban) | Función `logOwnershipMismatch` tenía tipos hardcodeados a `'getBalance' \| 'deactivate'`. No se extendió para WKH-63. | Extender `OwnershipOp` a `'getBalance' \| 'deactivate' \| 'registryUpdate' \| 'registryDelete'`. Agregar overload objeto con `{op, resourceId, callerOwnerRef, actualOwnerRef?}`. Hashear `actualOwnerRef` para diagnóstico. Instrumentar 5 paths. | **Futuras HUs con ownership**: cuando se agregue tabla nueva con `owner_ref`, extender `OwnershipOp` con literal nuevo + llamar `logOwnershipMismatch({...})` en TODOS los paths con `OwnershipMismatchError`. AR/CR verificar paridad logging. |
| 2026-04-27 22:00 | MNR-2: migration DDL sin transacción | `ALTER TABLE` + `CREATE INDEX` sin `BEGIN/COMMIT`. Si `CREATE INDEX` fallaba, columna quedaba sin índice → estado parcial difícil de auditar. Siguiente corrida saltaría ALTER (por `IF NOT EXISTS`) sin recrear índice. | Mecánica DDL sin considerar atomicity. PostgreSQL soporta DDL transaccional (a diferencia de MySQL) — oportunidad perdida. | Wrap DDL entre `BEGIN;` (línea 31) y `COMMIT;` (línea 41). Idempotencia preservada por `IF NOT EXISTS`. | **TODA migration `.sql` futura**: open con `BEGIN;`, close con `COMMIT;`. Template debería traerlo by default. Para DDL no-transaccional (CREATE INDEX CONCURRENTLY), separar en migration aparte. |

---

## Archivos modificados

```
doc/sdd/060-wkh-63-sec-reg-1/
├── auto-blindaje.md                                      [ARTEFACTO F3]
├── ar-cr-report.md                                       [ARTEFACTO AR/CR]
├── qa-report.md                                          [ARTEFACTO F4]
└── done-report.md                                        [este archivo]

src/routes/
├── agent-card.test.ts                                    [fixture ownerRef: 'system']
├── registries.ownership.test.ts                          [20 tests nuevos W4]
├── registries.ssrf.test.ts                               [actualizar contrato 3-arg]
└── registries.ts                                         [route handler + A2A_KEY guard]

src/services/
├── registry.ownership.test.ts                            [20 tests nuevos W4]
├── registry.ts                                           [ownership guards W2]
├── compose.test.ts                                       [fixture ownerRef: 'system']
├── discovery.test.ts                                     [fixture ownerRef: 'system']
├── discovery.ssrf.test.ts                                [fixture ownerRef: 'system']
└── security/errors.ts                                    [extender OwnershipOp + overload MNR-1]

src/types/
└── index.ts                                              [RegistryConfig.ownerRef W1]

supabase/migrations/
└── 20260427210000_registries_owner_ref.sql               [migration + BEGIN/COMMIT MNR-2]

scripts/
└── apply-registries-owner-ref-migration.mjs              [apply script W0]
```

**Dominio**: Security (ownership guard + cross-tenant IDOR closure)
**Scope**: Localizados a registries CRUD. Cambios en test fixtures son necesarios para AC-8 (tipo consistency).

---

## Decisiones diferidas a backlog

Ninguna spinoff creada. Los hallazgos pre-existentes se documentan:

1. **WKH-SEC-02** (existente): RLS Postgres-level para enforcement en DB-layer (hoy solo app-layer). Prioridad: HIGH
2. **WKH-54** (existente): Agregar `owner_ref` a `tasks` + RPC update. Aprovechar patrón WKH-63 completo (ownership guard + logging)
3. **OBS-1** (backlog): GET/POST enumeration de registries. Requiere scope check en discover endpoint (WKH-61 mitiga parcialmente). Prioridad: MEDIUM

---

## Lecciones para próximas HUs

### 1. Nunca saltees F2.5
**Contexto**: esta HU no tuvo `story-WKH-63.md` porque F2.5 fue saltada. Las waves se implementaron basándose en prompt del orquestador.

**Lección**: F2.5 genera Story File que estructura SDD en waves, timings, y aceptación. Sin eso, el dev team improvisa. Si la arquitectura lo prohíbe, documentá explícitamente por qué.

**Aplicar**: antes de lanzar `/nexus-p4-f3 WKH-XX`, verificar `ls doc/sdd/NNN-titulo/story-*.md`. Si no existe, lanzar `/nexus-p3-f2-5 WKH-XX` primero (no saltees pasos del pipeline).

### 2. Sentinels compartidos colapsan tenants
**Contexto**: BLQ-ALTO-1 surgió de pensar que un sentinel `'x402-anonymous'` era suficiente identidad. No — un sentinel compartido anula la diferencia entre múltiples tenants.

**Lección**: en ownership guard, identity DEBE ser:
- Criptográficamente vinculada (a2a-key con privkey verificable) O
- Exclusiva a un só usuario/tenant (uid único)

Un sentinel NUNCA. Si no hay identity verificable, rechazá la operación en la route handler ANTES del service.

**Aplicar**: futuras tablas con ownership (WKH-54 tasks, etc.). Regla: **rechazo > sentinels**.

### 3. Telemetría debe estar en TODOS los paths de error
**Contexto**: MNR-1 = los 5 paths de `OwnershipMismatchError` en registry silenciosos.

**Lección**: cuando se agrega una columna de ownership, los paths de error son oportunidades de telemetría + detección de ataques. No dejes ninguno sin logueo.

**Aplicar**: futuras HUs. AR/CR checklist: "all `OwnershipMismatchError` paths logged?"

### 4. DDL transaccional es gratis en PostgreSQL
**Contexto**: MNR-2 = migration sin `BEGIN/COMMIT`. PostgreSQL lo soporta nativamente.

**Aplicar**: template de migration debería traer `BEGIN;` / `COMMIT;` por default. Cero excusas para no usar.

---

## Verificación final (operador)

Antes de considerá DONE al 100%:

1. ✅ **Branch compilable**: `git checkout feat/060-wkh-63-sec-reg-1 && npm run build` → exit 0
2. ✅ **Tests pass**: `npm test` → 577/577 pass
3. ✅ **Lint clean**: biome format + lint OK
4. ⏳ **DB migration applied** (pendiente operador):
   ```sql
   SELECT column_name, data_type, is_nullable, column_default
   FROM information_schema.columns
   WHERE table_name = 'registries' AND column_name = 'owner_ref';
   -- Expected: data_type='text', is_nullable='NO', column_default='system'
   ```
5. ✅ **Documentación completa**: auto-blindaje.md, ar-cr-report.md, qa-report.md, done-report.md en disco

---

**Conclusión**: WKH-63 / SEC-REG-1 está **LISTO PARA MERGE**. Ownership guard cierra cross-tenant IDOR. BLQ-ALTO-1 resuelto. Patrón ownership documentado para futuras HUs. Operador debe verificar DB migration remota (no bloqueante).
