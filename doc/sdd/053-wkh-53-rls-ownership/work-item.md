# Work Item — [WKH-53] Supabase RLS + ownership checks en queries (wasiai-a2a)

## Resumen

Corregir una vulnerabilidad de cross-tenant data leak: el cliente Supabase usa
`SUPABASE_SERVICE_KEY` que bypassea RLS, y ninguna query de servicio filtra por
owner. Cualquier `x-a2a-key` autenticada puede leer o modificar datos de cualquier
otro owner. Esta HU introduce ownership guards a nivel app (app-layer), un helper
reutilizable, y un suite de tests de seguridad que previene regresiones.

## Sizing

- SDD_MODE: full
- Estimación: M (2–3h Dev — helper + ~4 queries + test suite)
- Branch sugerido: `feat/wkh-53-rls-ownership`
- Clasificación NexusAgil: QUALITY (toca path de seguridad + datos sensibles; requiere AR+CR obligatorios)

---

## F0 — Codebase Grounding (hallazgos)

### Confirmación de la vulnerabilidad

**`src/lib/supabase.ts:12`** — usa `SUPABASE_SERVICE_KEY` que bypasea RLS. Confirmado. El comentario en el archivo dice literalmente _"Usa SUPABASE_SERVICE_KEY (no anon key) para bypasear RLS"_.

### Tablas sensibles y estado de ownership guards (por migración)

| Tabla | Columna owner | Tiene owner en schema | Queries sin `.eq(owner)` |
|-------|---------------|----------------------|--------------------------|
| `a2a_agent_keys` | `owner_ref TEXT NOT NULL` | SI | SI — `budget.ts:17-18` (getBalance), `identity.ts:79` (deactivate) |
| `a2a_events` | **NO TIENE** columna owner | NO | N/A — tabla de telemetría global, sin owner |
| `tasks` | **NO TIENE** columna owner | NO | Todas las queries son sin owner — ver análisis más abajo |
| `registries` | **NO TIENE** columna owner | NO | N/A — recurso global/admin |
| `a2a_protocol_fees` | `orchestration_id` (no es owner) | NO | N/A — tabla interna, no expuesta por API |
| `a2a_transform_cache` | sin owner | NO | N/A — cache técnico |

### Análisis detallado por tabla

#### `a2a_agent_keys` — TIENE owner, FALTA el guard

La migración `20260406000000_a2a_agent_keys.sql` define `owner_ref TEXT NOT NULL`. Es la columna de ownership real. El middleware `src/middleware/a2a-key.ts` resuelve `keyRow` (incluyendo su `id` y `owner_ref`) y lo adjunta a `request.a2aKeyRow`. Los servicios que operan sobre esta tabla sin filtrar por `owner_ref`:

- `src/services/budget.ts:15-26` — `getBalance(keyId)`: query `.eq('id', keyId)` sin verificar que `keyId` pertenece al caller. Un agente con key A puede leer el balance de cualquier `keyId` conocido.
- `src/services/budget.ts` — `debit` y `registerDeposit`: usan `keyId` vía RPC; la función PG `increment_a2a_key_spend` solo verifica `is_active`, no `owner_ref`.
- `src/services/identity.ts:79-86` — `deactivate(keyId)`: `.update({is_active:false}).eq('id', keyId)` sin owner check. Un agente puede desactivar cualquier key ajena si conoce el `keyId`.

**Nota:** `lookupByHash` busca por `key_hash`, que es secreto (no adivinable). No es un vector de cross-tenant real, pero es buena práctica verificar que el hash coincida con un owner consistente.

#### `tasks` — SIN owner, SIN guard posible hoy

La tabla `tasks` (migración `20260403180000_tasks.sql`) no tiene columna de owner. No hay `owner_id`, `agent_key_id`, ni `created_by`. El `GET /tasks/:id` expone tasks de cualquier tenant.

**Decisión de scope (DT-B resolution):** Las tasks son recursos internos del protocolo A2A (creados por la ejecución, no por el caller directamente). El endpoint `GET /tasks/:id` usa el `taskId` como "shared secret" (UUID v4 = 122 bits de entropía). Agregar ownership a `tasks` requeriría cambios en el schema (nueva columna), en la lógica de creación, y en los tipos — excede el scope de esta HU que solo agrega `.eq()` sin reescribir. **Marcado como fuera de scope; candidato a WKH-SEC-02.**

#### `a2a_events` — SIN owner, tabla de telemetría global

Los eventos son telemetría del gateway, no recursos del agente. No modelan ownership por diseño (cualquier call genera eventos). Fuera de scope de esta HU.

#### `registries` — recurso global con auth ya en middleware

El CRUD de registries ya tiene `requirePaymentOrA2AKey` en todos los mutating endpoints (WKH-SEC-01). No tiene ownership por diseño: el registro de marketplaces es una operación admin. Fuera de scope.

### Conclusión del mapeo exhaustivo

El único vector de cross-tenant real en esta HU es `a2a_agent_keys` con `owner_ref`. Las operaciones vulnerables concretas son:

1. `budgetService.getBalance(keyId)` — lectura de balance ajeno
2. `identityService.deactivate(keyId)` — desactivar key ajena
3. Indirectamente: cualquier ruta que exponga `GET /auth/keys/:id` o similar que llame a estos servicios con un `keyId` controlable por el caller

### Sobre DT-C (contract test AST vs runtime)

El tooling actual es **vitest** con mocks de supabase. Un test AST/static analysis requeriría instalar un parser de TypeScript adicional (ts-morph, etc.) fuera del stack establecido. El patrón vigente en el proyecto es test runtime con mocks del builder de supabase-js (ver `budget.test.ts`, `identity.test.ts`). Se usa el mismo patrón: **runtime tests que verifican que `.eq('owner_ref', ownerId)` es llamado** con mock del builder. Viable y consistente con las convenciones del proyecto.

---

## Acceptance Criteria (EARS)

- **AC-1**: WHEN un request autenticado con `x-a2a-key` del owner A llama a `budgetService.getBalance(keyId)` y `keyId` pertenece al owner B, THEN el sistema SHALL retornar error 403/404 (nunca el balance de B).

- **AC-2**: WHEN un request autenticado con `x-a2a-key` del owner A llama a `identityService.deactivate(keyId)` y `keyId` pertenece al owner B, THEN el sistema SHALL retornar error 403/404 y la key de B SHALL permanecer activa en DB.

- **AC-3**: WHEN `budgetService.getBalance(keyId)` es llamado con un `ownerId`, THEN el sistema SHALL incluir `.eq('owner_ref', ownerId)` en la query a `a2a_agent_keys`, verificable en test unitario con mock del builder.

- **AC-4**: WHEN `identityService.deactivate(keyId)` es llamado con un `ownerId`, THEN el sistema SHALL incluir `.eq('owner_ref', ownerId)` en la query de UPDATE a `a2a_agent_keys`, verificable en test unitario con mock del builder.

- **AC-5**: WHILE el test suite `src/services/security/ownership.test.ts` corre, the system SHALL ejecutar ≥1 test negativo por operación protegida (getBalance, deactivate) que afirme que un `ownerId` ajeno resulta en respuesta vacía/error y nunca en data del otro owner.

- **AC-6**: WHEN se agrega un nuevo test al suite `ownership.test.ts` con dos owners distintos (A y B), THEN todos los tests SHALL pasar: key A no puede ver ni modificar datos de key B.

- **AC-7**: WHEN el baseline de tests existentes corre después de aplicar el cambio, THEN el 100% de los tests anteriores SHALL seguir en PASS (cero regresión).

- **AC-8**: WHEN un developer agrega una nueva query sobre `a2a_agent_keys` en `services/*.ts` sin el `.eq('owner_ref', ownerId)`, THEN el patrón SHALL estar documentado en `CLAUDE.md` (Golden Path o Security Conventions) de forma que el PR reviewer pueda detectarlo manualmente.

---

## Scope IN

| Artefacto | Cambio |
|-----------|--------|
| `src/services/budget.ts` | Agregar parámetro `ownerId: string` a `getBalance()` + `.eq('owner_ref', ownerId)` en la query |
| `src/services/identity.ts` | Agregar parámetro `ownerId: string` a `deactivate()` + `.eq('owner_ref', ownerId)` en el UPDATE |
| `src/services/security/ownership.test.ts` | Nuevo test suite (crear) con ≥2 tests negativos (cross-owner, getBalance + deactivate) |
| `src/services/budget.test.ts` | Actualizar tests de `getBalance` y `debit` para pasar `ownerId` al helper si la firma cambia |
| `src/services/identity.test.ts` | Actualizar test de `deactivate` para reflejar la nueva firma |
| `CLAUDE.md` | Agregar sección "Security Conventions — Ownership Guard" con el patrón obligatorio |
| Callers de `getBalance` y `deactivate` (middleware + routes) | Pasar `keyRow.owner_ref` como `ownerId` al llamar a los servicios modificados |

### Callers identificados que necesitan actualización

- `src/middleware/a2a-key.ts:196` — llama `budgetService.getBalance(keyRow.id, chainId)` → pasar `keyRow.owner_ref`
- Cualquier route que llame `identityService.deactivate(keyId)` → verificar y pasar `owner_ref` del request autenticado

## Scope OUT

- Migrations SQL con `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` (candidato TD-SEC-01 / WKH-SEC-02)
- Cambio del auth model (`x-a2a-key` → JWT Supabase)
- Ownership guards en tabla `tasks` (no tiene columna owner — requiere schema change, candidato WKH-SEC-02)
- Ownership guards en `a2a_events` (telemetría global, sin owner por diseño)
- Ownership guards en `registries` (recurso global admin, ya protegido por auth middleware)
- Ownership guards en `a2a_protocol_fees` (tabla interna, no expuesta por API pública)
- Refactor completo de los servicios (solo agregar `.eq('owner_ref', ownerId)` y ajustar firmas)
- Cambiar el nombre de la columna (se confirma que es `owner_ref` en la migración real — DT-B resuelto)

---

## Decisiones técnicas (DT-N)

- **DT-A (RESUELTO)**: No se crea un helper `ownedBy(keyId)` separado. El patrón es inline: los métodos que toquen `a2a_agent_keys` con operaciones sensibles reciben `ownerId: string` como parámetro explícito y agregan `.eq('owner_ref', ownerId)` en la query chain. Es más legible, preserva el tipo del builder nativo de supabase-js (sin wrapper que rompa la inferencia de tipos), y es consistente con el patrón ya usado en el codebase (ver `identity.ts` con `.eq('key_hash', keyHash)`).

- **DT-B (RESUELTO)**: La columna de ownership en `a2a_agent_keys` es `owner_ref TEXT NOT NULL` (confirmado en migración `20260406000000_a2a_agent_keys.sql:11`). No es `user_id`, `owner_id`, ni `agent_key_id`. El valor de `owner_ref` se accede desde `request.a2aKeyRow.owner_ref` que ya está disponible en cualquier handler post-middleware.

- **DT-C (RESUELTO)**: Los tests de contrato de ownership se implementan como **runtime tests con mock del builder de supabase-js** (mismo patrón que `budget.test.ts` y `identity.test.ts`). No se usa AST parsing (requeriría dependencia extra fuera del stack). El test verifica que `.eq('owner_ref', <expectedOwnerId>)` fue llamado en el mock del builder.

- **DT-D**: El parámetro `ownerId` es el `owner_ref` del `A2AAgentKeyRow` del caller autenticado, disponible en `request.a2aKeyRow.owner_ref`. Cualquier operación que modifique o lea datos de `a2a_agent_keys` por `id` debe cruzar con `owner_ref` del caller para validar que el recurso le pertenece.

---

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO cambiar el auth model — sigue siendo `x-a2a-key` + `identityService.lookupByHash`. NO introducir JWT ni sesiones Supabase.
- **CD-2**: PROHIBIDO refactorizar servicios completos — solo agregar `.eq('owner_ref', ownerId)` y ajustar las firmas de los métodos afectados. La lógica de negocio existente NO se toca.
- **CD-3**: OBLIGATORIO TypeScript strict — sin `any` explícito. El parámetro `ownerId` es `string` (no `string | undefined`). Si un caller no tiene `owner_ref`, es un error de programación, no un caso manejable silenciosamente.
- **CD-4**: OBLIGATORIO ≥1 test negativo por operación protegida en `ownership.test.ts`. "Negativo" = test que afirma que un owner ajeno recibe vacío/error, nunca data del otro owner.
- **CD-5**: PROHIBIDO tocar migrations SQL de RLS (fuera de scope — candidato a TD-SEC-01).
- **CD-6**: OBLIGATORIO actualizar todos los callers de `getBalance` e `deactivate` que no pasen `ownerId` — el compilador TypeScript (strict) detectará los callers rotos si la firma cambia correctamente.
- **CD-7**: El nuevo test suite DEBE vivir en `src/services/security/` (separado de los tests unitarios funcionales existentes) para que sea identificable como "security test suite" en el pipeline de CI.

---

## Missing Inputs

- [resuelto en F0] Nombre de columna owner en `a2a_agent_keys` → es `owner_ref` (confirmado)
- [resuelto en F0] Scope de tablas sensibles → solo `a2a_agent_keys` tiene ownership real en el schema actual
- [resuelto en F0] Patrón de test preferido → runtime mock, consistente con codebase
- [NEEDS CLARIFICATION] La ruta `DELETE /auth/keys/:id` o similar: no se encontró en el glob de routes. Si existe una ruta que expone `deactivate(keyId)` directamente, el Architect debe mapearla en F2 y asegurarse de que pasa `request.a2aKeyRow.owner_ref` como `ownerId`.

---

## Análisis de paralelismo

- **WKH-025** (feat/025-a2a-key-middleware, in progress): toca `src/middleware/a2a-key.ts` que llama a `budgetService.getBalance`. Esta HU cambia la firma de `getBalance` para requerir `ownerId`. **Hay riesgo de conflicto de merge** si WKH-025 no está cerrado cuando se inicia WKH-53. Recomendación: esperar a que WKH-025 llegue a DONE antes de iniciar F3 de esta HU, o coordinar el cambio de firma explícitamente.
- **WKH-029** (feat/029-e2e-tests, in progress): suite de tests E2E. No toca los servicios afectados directamente, pero si sus tests llaman a `getBalance` directamente, habrá ajuste de firma. Bajo riesgo, manejable en F3.
- **WKH-026** (hardening, in progress): no toca `budget.ts` ni `identity.ts`. Sin conflicto esperado.
- Esta HU NO bloquea ninguna otra HU conocida — es un fix de seguridad aditivo.

---

## Riesgos identificados

| Riesgo | Probabilidad | Impacto | Mitigación |
|--------|-------------|---------|------------|
| `budgetService.debit` y `registerDeposit` usan RPC PG que internamente no verifica `owner_ref` | Media | Medio | La función PG `increment_a2a_key_spend` verifica `is_active` pero no `owner_ref`. Si el `keyId` es válido pero de otro owner, el debit pasa. Mitigación: el middleware ya resuelve el `keyRow` y pasa su `id` al debit — el caller del middleware siempre es el dueño de la key. El vector real de cross-tenant en `debit` requiere que el caller haya obtenido un `keyId` ajeno. Este riesgo residual se documenta como TD-SEC-01 para cuando se implemente RLS real. |
| Callers desconocidos de `deactivate` | Baja | Alto | El compilador TypeScript detectará todos los callers al cambiar la firma. El Architect confirma en F2. |
| Tests existentes que mockean el builder pueden necesitar ajuste | Alta | Bajo | `budget.test.ts` y `identity.test.ts` ya usan el patrón mock — solo hay que agregar el parámetro `ownerId` al setup de los tests existentes. |
