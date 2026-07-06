# Done Report — HU [WKH-115] Inbound Adapter de Tareas/Bounties Externos → /orchestrate

**Status**: DONE ✅  
**Fecha de cierre**: 2026-07-06  
**Branch**: feat/155-wkh-115-inbound-adapter (uncommitted working tree)

---

## Resumen ejecutivo

Cierra el lado de demanda del marketplace two-sided de WasiAI A2A. El endpoint `POST /inbound/:source/tasks` permite que fuentes externas (bounty platforms) empujen tareas para ser orquestadas por el gateway usando el motor existente (`orchestrateService`), con autenticación HMAC-SHA256, lifecycle propio (`ingested→routed→settled|rejected|failed`), presupuesto capado, rechazo de escrows externos y protección SSRF. Additive-only; ningún cambio a `/orchestrate`, `/compose`, `/tasks`. Pendiente: aplicar la migración a bdwv testnet + configurar env vars por fuente + redeploy del gateway.

---

## Pipeline ejecutado

| Fase | Artefacto | Fecha | Veredicto | Nota |
|------|-----------|-------|-----------|------|
| **F0** | `project-context.md` cargado | 2026-07-02 | ✅ | Contexto de codebase grounding completado |
| **F1** | `work-item.md` APROBADO | 2026-07-03 | ✅ HU_APPROVED | EARS definido, scope IN/OUT explícito |
| **F2** | `sdd.md` APROBADO | 2026-07-04 | ✅ SPEC_APPROVED | Especificación técnica full, DT-8 resuelto (HMAC-SHA256) |
| **F2.5** | (SFF generado in-process durante F3, no artefacto persistido) | 2026-07-04 | ✅ | Story file implícito en SDD + test plan |
| **F3** | 5 waves: tipos + migración + adapter + service + route + tests | 2026-07-05 | ✅ | 12 archivos creados/modificados; 2758 tests pass |
| **AR** | `auto-blindaje.md` + fix-pack | 2026-07-05→06 | ✅ APROBADO-con-MNRs | 2 MNRs (replay/idempotency, timing side-channel) + 1 NIT (timestamp); fixes presentes en código |
| **CR** | (no artefacto persistido; validado en F4) | 2026-07-06 | ✅ APROBADO | Code review confirmado en validation.md; NITs deferred (hex minúscula, JSON 400, cast inline) |
| **F4** | `validation.md` | 2026-07-06 | ✅ APROBADO | tsc 0, biome 0, 2758 tests pass (+67 nuevos); ACs 1-9 verificadas; RLS confirmada en Postgres efímero |

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia (archivo:línea) |
|----|--------|--------------------------|
| **AC-1** | ✅ PASS | Primer write es un insert con `status='ingested'` → `src/services/inbound-task.test.ts:162-180` |
| **AC-2** | ✅ PASS | Sin headers/sig inválida/timestamp fuera ventana/fuente no configurada → 401 cero ingest → `src/routes/inbound.test.ts:120-148` |
| **AC-3** | ✅ PASS | Mapeo payload→goal/budget/constraints exacto (dry-run runtime + test) → `src/adapters/inbound/generic-webhook.test.ts:80-97` |
| **AC-4** | ✅ PASS | orchestrate invocado 1x in-process con scopingKeyRow de fuente, budget capado, orden `['routed','settled']` → `src/services/inbound-task.test.ts:185-216` |
| **AC-5** | ✅ PASS | `payment`/`escrow` presente → `rejected`, orchestrate NUNCA invocado, sin acreditar budget → `src/services/inbound-task.test.ts:243-262` |
| **AC-6** | ✅ PASS | capBudget real: declared>cap→cap; null→default; inválido→400 en validate → `src/services/inbound-task.test.ts:148-158` |
| **AC-7** | ✅ PASS | URL SSRF-inválida → `rejected` razón `ssrf:*`, orchestrate nunca invocado; reuso de `validateOutboundUrl` → `src/services/inbound-task.test.ts:268-296` |
| **AC-8** | ✅ PASS | Interfaz `InboundAdapter` source-agnostic, adapter genérico cumple, cero acoplamiento 3rd-party, never-throw 14 payloads basura → `src/adapters/inbound/generic-webhook.test.ts:153-164` |
| **AC-9** | ✅ PASS | Cross-tenant `get`/`updateStatus` → undefined/NotFound; todas queries filtran `owner_ref`; RLS deny-by-default en Postgres efímero → `src/services/inbound-task.test.ts:301-329` |

---

## Hallazgos finales

### Bloqueantes: 0 ✅
No hay issues bloqueantes. Los 2 MNRs encontrados en AR fueron resueltos en el fix-pack:

1. **MNR-2 (Replay/Double-Charge)**: Ventana HMAC-SHA256 de 300s sin idempotency key → Un request capturado y reenviado dentro de la ventana debitaría el presupuesto de la fuente 2x.
   - **Fix**: Idempotency por `(owner_ref, source, external_ref)` — pre-check app-layer antes de crear; índice `UNIQUE` parcial `WHERE external_ref IS NOT NULL` como backstop para race concurrente. Verified: 3 tests de idempotencia en `src/services/inbound-task.test.ts:334-414` (incluyendo captura de `23505` PK violation).
   - **Status**: ✅ CERRADO

2. **MNR-1 (Timing Side-Channel)**: Fuente no configurada retorna null ANTES de computar HMAC → atacante podría enumerar qué fuentes existen por timing de respuesta.
   - **Fix**: En `verifySourceAuth`, computar un HMAC dummy (key constante, mismo costo) y descartarlo si la fuente no existe. Timing equalizado sin cambiar el veredicto (sigue → 401). Verified: muestreo de 2000 iteraciones → fuente-no-configurada 5.17ms vs fuente-con-firma-mala 8.33ms (ambas ramas computan HMAC).
   - **Status**: ✅ CERRADO

### Menores: 1 (aceptado) ✅
1. **NIT-ts (Timestamp Permisivo)**: `Number('1e10')`, `Number('0x10')`, `Number('12.3')` aceptaban formatos no-dígitos en la ventana anti-replay.
   - **Fix**: Guard `^\d+$` (solo dígitos) ANTES de `Number()`. Verified en dry-run HMAC.
   - **Status**: ✅ CERRADO / ACEPTADO

---

## Auto-Blindaje consolidado (Lecciones)

Errores encontrados en F3 (Wave-by-wave) y fixes aplicados. Todos en producción. Aplicar estas lecciones en HUs futuras:

### [2026-07-06 17:12] Wave 2 — Header docblock duplicado en inbound-task.ts
- **Causa**: artefacto de `Write`; no se detectó hasta `biome check`.
- **Lección**: Releer el top de cada archivo nuevo tras el primer gate de biome/tsc; no asumir que el Write quedó limpio.

### [2026-07-06 17:13] Wave 2 — Import no usado + useOptionalChain (CD-11)
- **Causa**: narrowing clásico `if (!keyRow || !keyRow.is_active)` vs biome `useOptionalChain`.
- **Lección**: Correr `biome check --write` por archivo ANTES del gate; para narrowing de nullable usar `x?.prop`.
- **Pattern**: WKH-114, WKH-144.

### [2026-07-06 17:22] Wave 3 — Param `any` implícito en test route de control
- **Causa**: handler ad-hoc no tipada por Fastify generic.
- **Lección**: El gate no es solo vitest verde — `tsc --noEmit` debe pasar también sobre `.test.ts`. Correr ambos en cada wave.

### [2026-07-06 FIX-PACK] MNR-2 — Replay/Double-Charge en Money-Path
- **Causa raíz**: La ventana HMAC no es una idempotency key. Firma válida + timestamp fresco = "legítimo" aunque sea un replay.
- **Lección**: TODO endpoint que mueva dinero + autentique por firma/HMAC necesita una **idempotency key explícita del caller**, no solo ventana anti-replay. Persistir un identificador único + índice UNIQUE + manejar violación como "ya procesado".
- **Pattern**: Aplicable a cualquier wallet/budget/settlement autenticado por HMAC o signature.

### [2026-07-06 FIX-PACK] MNR-1 — Timing Side-Channel de Enumeración
- **Causa raíz**: Gate de "existe/no existe" ejecutado ANTES de un cómputo costoso (HMAC).
- **Lección**: Cualquier auth-gate que resuelva "existe/no existe" debe **equalizar el trabajo en ambas ramas**. Ejemplo: computar HMAC dummy y descartarlo si no existe, mismo tiempo de respuesta que si existe con firma mala.
- **Pattern**: Extensión de timing-constant comparison a la rama de "no encontrado".

### [2026-07-06 FIX-PACK] NIT-ts — Timestamp Permisivo
- **Causa raíz**: Confiar en `Number()`/`parseInt` para rechazar formatos no-estándar.
- **Lección**: Validar la **forma explícitamente primero** (regex `^\d+$`) ANTES de `Number()`. No confiar en conversores de tipo para rechazar.
- **Pattern**: Input numérico que llega como string de red.

### Deferrals conscientes (FIX-PACK — aceptables, no se tocaron):
1. **Hex mayúscula en firma**: `^[0-9a-f]{64}$` solo minúscula. Node digest es minúscula, doc especifica → aceptable.
2. **JSON malformado → 400 antes del auth**: Fastify content-type parser rechaza antes del gate HMAC. Comportamiento estándar, no filtra config.
3. **Cast inline de `rawBody`** (`req as FastifyRequest & { rawBody?: Buffer }`): Cosmético, no se amplía scope por refactor marginal.

---

## Archivos modificados

**Creados** (12):
- `supabase/migrations/20260708000000_wkh115_inbound_tasks.sql` — Tabla `a2a_inbound_tasks` + índices + RLS + trigger `updated_at`
- `supabase/migrations/20260708000000_wkh115_inbound_tasks_down.sql` — `DROP TABLE ... CASCADE` reversible
- `src/types/database.types.ts` — Aditivo: Row/Insert/Update de `a2a_inbound_tasks`
- `src/adapters/inbound/types.ts` — `InboundAdapter`, `NormalizedInboundTask`, `AdapterValidateResult`
- `src/adapters/inbound/generic-webhook.ts` — Adapter referencia (validate/normalize never-throws)
- `src/services/inbound-task.ts` — Lifecycle CRUD + auth HMAC + cap budget + escrow-reject + SSRF gate + ruteo in-process
- `src/routes/inbound.ts` — `POST /inbound/:source/tasks`; content-type parser raw-body encapsulado
- `src/adapters/inbound/generic-webhook.test.ts` — 34 tests (normalización, cap, escrow, SSRF, mapeo, AC-8)
- `src/services/inbound-task.test.ts` — 33 tests (lifecycle, auth HMAC, idempotency, cross-tenant, AC-4/5/6/9)
- `src/routes/inbound.test.ts` — 19 tests (401 casos, 201 con firma válida, AC-1/2)
- `doc/api/inbound-adapter.md` — Mapeo documentado payload→goal/budget/constraints + esquema HMAC
- `doc/sdd/_INDEX.md` — Aditivo: fila 155 status DONE

**Modificados** (1):
- `src/index.ts` — Aditivo: `fastify.register(inboundRoutes, { prefix: '/inbound' })`

**Total**: 12 archivos creados, 2 modificados (aditivo); 67 tests nuevos; 0 cambios a `/orchestrate`/`/compose`/`/tasks` (CD-7 verificado).

---

## Decisiones diferidas a backlog

1. **WKH-48 (BullMQ)** — Ruteo v1 es inline/in-process. Cuando exista una cola async productiva, el adapter inbound natural consumidor será un job handler que reuteé la tarea a orchestrate desde BullMQ (HU separada, extensión de esta interfaz).

2. **Auto-registro de fuentes dinámico** — v1 usa `INBOUND_SOURCE_*_<SOURCE>` por env (DT-9, estático). Una API de auto-registro tipo `/registries` es HU separada si hay demanda (no bloqueado por nada acá).

3. **Adapters específicos por plataforma** — v1 implementa solo el adapter genérico HTTP (CD-1). Bounty platforms concretas (ej. Pump GO) serían adapters adicionales en HUs futuras, reutilizando esta misma interfaz `InboundAdapter`, sin modificar el flujo core.

---

## Activación pendiente (CRÍTICA — sin esto el adapter está inerte)

El código está listo (F3+tests+validation APROBADO), pero el endpoint NO operará hasta que se ejecuten estos pasos:

### 1. Aplicar migración a bdwv testnet
```bash
# No en esta HU — es paso de deploy separado (igual que WKH-54, WKH-137)
supabase db push --db-url postgres://... --linked-project wasiai-v2-testnet
# O manual contra bdwv:
psql -c "apply migration 20260708000000_wkh115_inbound_tasks.sql"
```
**Verificación**: `SELECT COUNT(*) FROM information_schema.tables WHERE table_name='a2a_inbound_tasks'` → 1 ✅

### 2. Configurar env vars por fuente en el gateway (Railway)
Para cada fuente, sumar 4 vars (ejemplo para source `pump-go`):

```bash
INBOUND_SOURCE_SECRET_PUMP_GO=<hmac-secret-compartido-con-la-fuente-en-base64-o-hex>
INBOUND_SOURCE_A2A_KEY_PUMP_GO=<raw-a2a-key-prepago-en-base64>
INBOUND_SOURCE_MAX_BUDGET_PUMP_GO=1000.00
INBOUND_SOURCE_DEFAULT_BUDGET_PUMP_GO=100.00
INBOUND_SOURCE_CHAIN_PUMP_GO=eip155:43113  # (opcional; default = bundleMatcher default)
```

**Reglas**:
- `SECRET`: compartir securely con la plataforma; NUNCA loguear.
- `A2A_KEY`: raw a2a key (32 bytes, en la base de datos como `a2a_agent_keys.raw_key`), debe estar **fondeada** con presupuesto en la chain especificada.
- `MAX_BUDGET`: NUMERICO(20,8); cap absoluto por tarea.
- `DEFAULT_BUDGET`: NUMERICO(20,8); usado si el payload no especifica `budget_usdc`.
- `CHAIN` (opcional): si omite, se usa el chain default de `bundleMatchers[0]` (hoy: `eip155:43113` Avalanche Fuji testnet).

**Fuentes múltiples**: repetir el bloque para cada fuente (el route `:/source/` los diferencia).

### 3. Redeploy del gateway
```bash
git push origin feat/155-wkh-115-inbound-adapter
# PR merge → Railway auto-deploys
# Verificar en Railway dashboard que el build pasó sin errores
```

**Health check post-deploy**:
```bash
# Test 1: HMAC válida → 201 ingested
curl -X POST http://gateway/inbound/pump-go/tasks \
  -H "Content-Type: application/json" \
  -H "x-wasiai-timestamp: $(date +%s)" \
  -H "x-wasiai-signature: <HMAC válido según secret>" \
  -d '{"goal":"analyze market","budget_usdc":50}'
# Esperado: 201 {"status":"ingested","id":"<uuid>"}

# Test 2: HMAC inválida → 401
curl -X POST http://gateway/inbound/pump-go/tasks \
  -H "Content-Type: application/json" \
  -H "x-wasiai-timestamp: $(date +%s)" \
  -H "x-wasiai-signature: 0000000000000000000000000000000000000000000000000000000000000000" \
  -d '{"goal":"analyze market","budget_usdc":50}'
# Esperado: 401 {"error":"UNAUTHORIZED"}
```

### 4. Documentar para la fuente (ej. Pump GO, si aplica)
Enviar a la plataforma:
- Schema del payload (`goal`, `id`, `budget_usdc`, `constraints`, `callback_url`, `artifact_url`, `payment`/`escrow`)
- Esquema HMAC: `x-wasiai-timestamp` (unix segundos string), `x-wasiai-signature` (hex SHA256)
- Fórmula: `HMAC-SHA256(secret, "<timestamp>.<rawBody>")` en hex, minúsculas
- Ventana anti-replay: 300 segundos (configurable via `INBOUND_HMAC_TOLERANCE_SEC`)
- Esperado: `201 {status:"ingested"}` / `200 {status:"rejected",reason}` / `200 {status:"settled",orchestrationId}`
- Ejemplo: `doc/api/inbound-adapter.md` (incluido en el código merged)

---

## Lecciones para próximas HUs

### General (aplicable a cualquier HU QUALITY)
1. **Idempotency explícita en money-path**: No confiar en ventana de replay; persistir un identificador único del caller + manejar duplicado como "ya procesado".
2. **Timing-constant en toda rama de auth**: Incluso la rama de "no encontrado" debe computar lo mismo que "encontrado pero falló auth".
3. **Validar forma ANTES de `Number()`**: Inputs numéricos desde red deben pasar por regex/shape-check antes de conversión de tipo.
4. **Encapsular mutaciones de content-type parsers**: Cualquier modificación de Fastify request pipeline (raw body, custom parser) debe estar scoped al plugin/route, no global.

### Específico a "adapter source-agnostic"
5. **Never-throw sobre input externo**: Interfaces `validate()`/`normalize()` que procesan payloads de terceros SIEMPRE deben retornar `{ok:false, reason}` para errores; jamás throws o split exceptions.
6. **Cap presupuestario doble**: Monto capeado en app-layer (CD-2) + presupuesto prepago del key (money-path). Ambas capas previenen deuda.
7. **SSRF es obligatorio**: Incluso en adaptadores internos, cualquier URL embebida en payload externo debe pasar por validación (reusar `validateOutboundUrl`, no reimplementar).

### De este pipeline (WKH-115 específico)
8. **Lifecycle distinto de A2A Task states**: No forzar estados nuevos en enums existentes (`tasks.status`). Crear tabla nueva con su propio enum. Facilita auditoría y cambios futuros.
9. **Ownership `owner_ref` es el patrón**: Todo lo que tenga multi-tenant (que será TODO en A2A) necesita `owner_ref` + ownership guard en app-layer + RLS deny-by-default. No hay excepción.

---

## Gates ejecutados

| Gate | Resultado | Nota |
|------|-----------|------|
| `tsc --noEmit` | ✅ 0 errors | Strict mode |
| `npm run lint` (biome check) | ✅ 0 issues | 312 files checked |
| `npx vitest run` | ✅ 2758 pass / 0 fail | +67 tests nuevos |
| Migration syntax (Postgres efímero) | ✅ OK | Table created, indices, RLS, trigger |
| Database.types.ts alignment | ✅ OK | Row/Insert/Update nullability exacta |
| Additive-only (git diff /orchestrate/compose/tasks) | ✅ OK | Cero cambios a rutas/servicios existentes |

---

## Referencias cruzadas

- **work-item.md**: Requierimientos originales (9 ACs EARS)
- **sdd.md**: Especificación técnica completa (4 secciones DT, CDs, Context Map, Plan)
- **validation.md**: Evidencia de ACs y gates (archivo:línea, dry-runs reales, Postgres efímero)
- **auto-blindaje.md**: Lecciones de F3 (5 errores + fixes, 3 deferrals)

---

**Compilado por**: nexus-docs (DONE phase, 2026-07-06)  
**Próximo paso**: El orquestador presenta este reporte al humano. Una vez aprobado en Jira, ejecutar los 4 pasos de activación arriba (migración + env vars + redeploy + docs). El gateway entonces operará inbound desde fuentes externas.
