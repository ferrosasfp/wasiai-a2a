# SDD #014: Dashboard Analytics — WKH-27

> SPEC_APPROVED: no
> Fecha: 2026-04-04
> Tipo: feature
> SDD_MODE: full
> Branch: feat/wkh-27-dashboard
> Artefactos: doc/sdd/014-dashboard-analytics/

---

## 1. Resumen

Construir un dashboard visual servido desde el mismo servidor Fastify que muestre en tiempo real: registries registrados, agent cards disponibles, estado de tasks, pagos on-chain (txHash) y metricas de performance por agente (latencia, costo, tasa de exito). Requiere crear una tabla `a2a_events` para persistir datos que actualmente se pierden tras cada compose/orchestrate, endpoints de agregacion, y una UI HTML con auto-refresh.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 014 |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Objetivo** | Dashboard visual para jueces del hackathon Kite con KPIs operativos reales |
| **Reglas de negocio** | Sin datos simulados (project-context regla #2). Solo datos reales de Supabase y eventos persistidos. |
| **Scope IN** | Tabla a2a_events, event service, hook en compose, rutas dashboard, HTML estatico |
| **Scope OUT** | WebSockets, auth en dashboard, graficos historicos, chart libraries, framework frontend |
| **Missing Inputs** | N/A |

### Acceptance Criteria (EARS)

1. WHEN un juez visita `GET /dashboard`, THE sistema SHALL retornar una pagina HTML con: KPI cards (registries, tasks, invocaciones, costo), tabla de tasks recientes, lista de registries, y lista de agent cards descubiertos.
2. WHEN un compose ejecuta un step exitoso o fallido, THE sistema SHALL persistir un evento en `a2a_events` con: event_type, agent_id, agent_name, registry, status, latency_ms, cost_usdc, tx_hash.
3. WHEN `GET /dashboard/api/stats` es llamado, THE sistema SHALL retornar JSON con: registries_count, tasks_by_status, events_total, success_rate (%), total_cost_usdc, avg_latency_ms.
4. WHEN hay eventos con tx_hash no-null, THE dashboard SHALL mostrar cada hash como link a `https://testnet.kitescan.ai/tx/{hash}`.
5. WHILE el dashboard esta abierto, THE sistema SHALL auto-refrescar datos cada 5 segundos via fetch sin recargar la pagina.
6. IF no hay datos (0 events, 0 tasks, 0 registries), THEN THE dashboard SHALL mostrar zeros en KPIs y tablas vacias con mensaje, sin errores JS ni spinners rotos.
7. WHEN `GET /dashboard/api/events` es llamado, THE sistema SHALL retornar los ultimos 20 eventos ordenados por created_at DESC.

## 3. Context Map (Codebase Grounding)

### Archivos leidos

| Archivo | Por que | Patron extraido |
|---------|---------|-----------------|
| `src/services/task.ts` | Exemplar para nuevo service | `TaskRow` interface, `rowToTask()` helper, singleton export, Supabase CRUD |
| `src/services/registry.ts` | Datos disponibles | `list()`, `getEnabled()` — consumibles directo |
| `src/routes/compose.ts` | Punto de hook para eventos | `preHandler: requirePayment()`, response con `kiteTxHash` |
| `src/services/compose.ts` | Datos de StepResult | `invokeAgent()` retorna `{ output, txHash }`, calcula `latencyMs`, `costUsdc` |
| `src/routes/orchestrate.ts` | Punto de hook para eventos | Similar a compose |
| `src/index.ts` | Patron de registro de rutas | `fastify.register(routes, { prefix })` |
| `src/types/index.ts` | Tipos existentes | `StepResult`, `Task`, `TaskState`, `RegistryConfig` |
| `src/lib/supabase.ts` | Cliente DB | Singleton `supabase`, `createClient()` con service key |

### Exemplars

| Para crear/modificar | Seguir patron de | Razon |
|---------------------|------------------|-------|
| `src/services/event.ts` | `src/services/task.ts` | Mismo patron: Row interface, rowTo*() helper, service object con metodos async |
| `src/routes/dashboard.ts` | `src/routes/registries.ts` | Mismo patron: FastifyPluginAsync, export default |

### Estado de BD relevante

| Tabla | Existe | Columnas relevantes |
|-------|--------|---------------------|
| `registries` | Si | id, name, discovery_endpoint, enabled, created_at |
| `tasks` | Si | id, status, messages, artifacts, created_at |
| `kite_schema_transforms` | Si | source_agent_id, target_agent_id, hit_count |
| `a2a_events` | **No — crear** | Ver seccion 4.2 |

### Componentes reutilizables encontrados

- `supabase` singleton en `src/lib/supabase.ts` — reutilizar, no crear nuevo cliente
- `TASK_STATES` array en `src/types/index.ts` — reutilizar para validacion
- Patron `rowTo*()` en task.ts y registry.ts — seguir para events

## 4. Diseno Tecnico

### 4.1 Archivos a crear/modificar

| Archivo | Accion | Descripcion | Exemplar |
|---------|--------|-------------|----------|
| `supabase/migrations/20260404200000_events.sql` | Crear | DDL tabla a2a_events + indices | `20260403180000_tasks.sql` |
| `src/types/index.ts` | Modificar | Agregar tipos A2AEvent, EventRow, DashboardStats | Seccion existente de Task types |
| `src/services/event.ts` | Crear | Service: track(), stats(), recent() | `src/services/task.ts` |
| `src/routes/dashboard.ts` | Crear | Rutas /dashboard + /dashboard/api/* + HTML inline | `src/routes/registries.ts` |
| `src/services/compose.ts` | Modificar | Hook post-step: llamar eventService.track() | N/A — agregar 1 import + ~5 lineas |
| `src/index.ts` | Modificar | Registrar dashboardRoutes con prefix /dashboard | Lineas existentes de register |

### 4.2 Modelo de datos

```sql
CREATE TABLE IF NOT EXISTS a2a_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL DEFAULT 'compose_step',
  agent_id TEXT,
  agent_name TEXT,
  registry TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  latency_ms INTEGER,
  cost_usdc NUMERIC(12,6) DEFAULT 0,
  tx_hash TEXT,
  goal TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_a2a_events_created ON a2a_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_a2a_events_agent ON a2a_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_a2a_events_status ON a2a_events(status);
```

### 4.3 Servicios

**eventService** (src/services/event.ts):

- `track(event)`: Inserta fila en a2a_events. Fire-and-forget (no bloquea compose).
- `stats()`: Query agregada: COUNT(*), success rate, SUM(cost_usdc), AVG(latency_ms). Incluye conteo de registries y tasks by status.
- `recent(limit=20)`: SELECT * FROM a2a_events ORDER BY created_at DESC LIMIT N.

**Tipos nuevos** (src/types/index.ts):

- `A2AEvent { id, eventType, agentId, agentName, registry, status, latencyMs, costUsdc, txHash, goal, metadata, createdAt }`
- `DashboardStats { registriesCount, tasksByStatus, eventsTotal, successRate, totalCostUsdc, avgLatencyMs }`

### 4.4 Flujo principal (Happy Path)

1. Agente Claude ejecuta `POST /compose` con 2 steps
2. compose.ts ejecuta step 1 -> invokeAgent() -> obtiene output + txHash + latencyMs
3. **Nuevo:** compose.ts llama `eventService.track()` con datos del step (fire-and-forget)
4. compose.ts ejecuta step 2 -> mismo flujo
5. Juez abre `GET /dashboard` -> ve HTML con KPIs y tabla de eventos
6. Dashboard hace fetch a `/dashboard/api/stats` -> muestra 2 invocaciones, costo total, latencia promedio
7. Dashboard hace fetch a `/dashboard/api/events` -> muestra tabla con ambos steps, links a KiteScan
8. Auto-refresh cada 5s actualiza datos

### 4.5 Flujo de error

1. Si Supabase falla al insertar evento -> log error, NO bloquear el compose (fire-and-forget)
2. Si `/dashboard/api/stats` falla -> dashboard muestra "Error loading stats" en la UI, no crashea
3. Si no hay eventos -> KPIs muestran 0, tabla muestra "No events yet"

### 4.6 Microcopy

| Elemento | Texto exacto | Contexto |
|----------|-------------|----------|
| Titulo pagina | "WasiAI A2A — Dashboard" | Header del HTML |
| KPI: Registries | "Registries" | Card KPI |
| KPI: Tasks | "Tasks" | Card KPI |
| KPI: Invocations | "Agent Invocations" | Card KPI |
| KPI: Success Rate | "Success Rate" | Card KPI, muestra N% |
| KPI: Total Cost | "Total Cost (USDC)" | Card KPI |
| KPI: Avg Latency | "Avg Latency (ms)" | Card KPI |
| Tabla eventos vacia | "No events recorded yet" | Cuando 0 eventos |
| Tabla tasks vacia | "No tasks yet" | Cuando 0 tasks |
| Tabla registries vacia | "No registries configured" | Cuando 0 registries |
| Footer | "Auto-refresh: 5s" | Bottom del dashboard |

### 4.7 Rutas

| Ruta | Metodo | Retorna | Auth |
|------|--------|---------|------|
| `/dashboard` | GET | HTML estatico | No |
| `/dashboard/api/stats` | GET | JSON DashboardStats | No |
| `/dashboard/api/events` | GET | JSON A2AEvent[] | No |

## 5. Constraint Directives (Anti-Alucinacion)

### OBLIGATORIO seguir
- Patron de service: seguir `src/services/task.ts` (Row interface, rowTo helper, service object)
- Patron de rutas: seguir `src/routes/registries.ts` (FastifyPluginAsync, export default)
- Imports: solo modulos que EXISTEN en el proyecto
- Supabase client: reutilizar singleton de `src/lib/supabase.ts`
- SQL migration: seguir convencion de naming `YYYYMMDDHHMMSS_nombre.sql`
- HTML: vanilla JS, sin dependencias externas, CSS inline o en style tag

### PROHIBIDO
- NO agregar dependencias nuevas al package.json (ni React, ni chart.js, ni nada)
- NO crear un proyecto frontend separado
- NO usar WebSockets ni SSE para el auto-refresh
- NO bloquear el pipeline de compose esperando el insert de evento
- NO hardcodear URLs de Supabase o Kite Explorer — usar constantes
- NO modificar la logica de negocio existente de compose (solo agregar hook post-step)
- NO agregar auth al dashboard (hackathon — acceso publico)
- NO simular datos — solo datos reales de la DB

## 6. Scope

**IN:**
- Migracion SQL: tabla `a2a_events`
- Service: `src/services/event.ts`
- Rutas: `src/routes/dashboard.ts`
- HTML dashboard inline en el route handler
- Hook en compose.ts para persistir eventos
- Registro de ruta en index.ts
- Tipos nuevos en types/index.ts

**OUT:**
- Modificar orchestrate.ts (solo compose por ahora, extensible despues)
- Dashboard con framework (React, Vue, etc.)
- Graficos historicos con chart libraries
- Auth/permisos en el dashboard
- WebSockets/SSE
- Tests para el dashboard HTML (no testeable con vitest)

## 7. Riesgos

| Riesgo | Probabilidad | Impacto | Mitigacion |
|--------|-------------|---------|------------|
| Fire-and-forget pierde evento si Supabase falla | Baja | Bajo | Log error, datos no criticos para operacion |
| HTML inline en route se vuelve dificil de mantener | Media | Bajo | Aceptable para hackathon. Extraer a archivo si crece |
| Auto-refresh 5s genera carga en Supabase | Baja | Bajo | Queries simples con indices, 1 usuario (juez) |

## 8. Dependencias

- WKH-23 (Tasks DB) — DONE
- Tabla `registries` — existe
- Tabla `tasks` — recien migrada

## 9. Missing Inputs

N/A — todo disponible.

## 10. Uncertainty Markers

Ninguno. Todo resuelto.

---

## Waves de Implementacion

### Wave 0 (Serial Gate — DB)
- [ ] W0.1: Crear y ejecutar migracion `a2a_events`
- [ ] W0.2: Agregar tipos `A2AEvent`, `EventRow`, `DashboardStats` en `src/types/index.ts`

### Wave 1 (Parallelizable — Services + Routes)
- [ ] W1.1: Crear `src/services/event.ts` (track, stats, recent)
- [ ] W1.2: Crear `src/routes/dashboard.ts` (HTML + API endpoints)

### Wave 2 (Integracion)
- [ ] W2.1: Hook en `src/services/compose.ts` — llamar eventService.track() post-step
- [ ] W2.2: Registrar dashboardRoutes en `src/index.ts`

### Wave 3 (Verificacion)
- [ ] W3.1: Test manual: abrir /dashboard, verificar KPIs, verificar auto-refresh
- [ ] W3.2: Test: crear evento via compose, verificar aparece en dashboard

### Verificacion Incremental

| Wave | Verificacion al completar |
|------|--------------------------|
| W0 | Tabla existe en Supabase, typecheck pasa |
| W1 | typecheck + import sin errores |
| W2 | typecheck + servidor arranca + /dashboard responde |
| W3 | QA visual + datos reales aparecen |

### Estimacion

- Archivos nuevos: 3 (migration, event.ts, dashboard.ts)
- Archivos modificados: 3 (types, compose, index)
- Tests nuevos: 1 (event.test.ts)
- Lineas estimadas: ~400

---

*SDD generado por NexusAgil — FULL*
