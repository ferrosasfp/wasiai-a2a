# Story File — #014: Dashboard Analytics (WKH-27)

> SDD: doc/sdd/014-dashboard-analytics/sdd.md
> Fecha: 2026-04-04
> Branch: feat/wkh-27-dashboard

---

## Goal

Construir un dashboard visual servido desde Fastify que muestre KPIs operativos reales: registries, tasks, agentes invocados, pagos on-chain y metricas de performance. Requiere una nueva tabla `a2a_events` para persistir datos de compose que actualmente se pierden, endpoints de agregacion, y UI HTML con auto-refresh. Zero dependencias nuevas en package.json.

## Acceptance Criteria (EARS)

1. WHEN un juez visita `GET /dashboard`, THE sistema SHALL retornar una pagina HTML con: KPI cards (registries, tasks, invocaciones, costo), tabla de tasks recientes, lista de registries, y agentes invocados (derivados de eventos).
2. WHEN un compose ejecuta un step exitoso o fallido, THE sistema SHALL persistir un evento en `a2a_events` con: event_type, agent_id, agent_name, registry, status, latency_ms, cost_usdc, tx_hash.
3. WHEN `GET /dashboard/api/stats` es llamado, THE sistema SHALL retornar JSON con: registries_count, tasks_by_status, events_total, success_rate (%), total_cost_usdc, avg_latency_ms, agents (agentes unicos de eventos).
4. WHEN hay eventos con tx_hash no-null, THE dashboard SHALL mostrar cada hash como link a `${KITE_EXPLORER_URL}/tx/{hash}`.
5. WHILE el dashboard esta abierto, THE sistema SHALL auto-refrescar datos cada 5 segundos via fetch sin recargar la pagina.
6. IF no hay datos (0 events, 0 tasks, 0 registries), THEN THE dashboard SHALL mostrar zeros en KPIs y tablas vacias con mensaje, sin errores JS ni spinners rotos.
7. WHEN `GET /dashboard/api/events` es llamado, THE sistema SHALL retornar los ultimos 20 eventos ordenados por created_at DESC.

## Files to Modify/Create

| # | Archivo | Accion | Que hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `supabase/migrations/20260404200000_events.sql` | Crear | DDL tabla a2a_events con indices (ver seccion Modelo de Datos) | `supabase/migrations/20260403180000_tasks.sql` |
| 2 | `src/types/index.ts` | Modificar | Agregar tipos A2AEvent, EventRow, DashboardStats al final del archivo | Seccion TASK TYPES existente |
| 3 | `src/services/event.ts` | Crear | Service con track(), stats(), recent() | `src/services/task.ts` |
| 4 | `src/static/dashboard.html` | Crear | HTML completo del dashboard con CSS y JS inline | N/A — archivo HTML standalone |
| 5 | `src/routes/dashboard.ts` | Crear | Rutas GET /dashboard (serve HTML), GET /dashboard/api/stats, GET /dashboard/api/events | `src/routes/registries.ts` |
| 6 | `src/services/compose.ts` | Modificar | Agregar import de eventService + hook post-step (ver seccion Hook) | N/A |
| 7 | `src/index.ts` | Modificar | Agregar import + register de dashboardRoutes | Lineas existentes de register |

## Exemplars

### Exemplar 1: Service pattern (task.ts)
**Archivo**: `src/services/task.ts`
**Usar para**: Archivo #3 (`src/services/event.ts`)
**Patron clave**:
- Import types desde `../types/index.js`
- Import supabase desde `../lib/supabase.js`
- Interface `XxxRow` privada con snake_case (mapeo DB)
- Funcion `rowToXxx(row: XxxRow): Xxx` para convertir
- Export `const xxxService = { ... }` como objeto con metodos async
- Queries con `.from('tabla').select('*')` + `.order()` + `.limit()`
- Error handling: `if (error) throw new Error(...)`

### Exemplar 2: Route pattern (registries.ts)
**Archivo**: `src/routes/registries.ts`
**Usar para**: Archivo #5 (`src/routes/dashboard.ts`)
**Patron clave**:
- `import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'`
- `const xxxRoutes: FastifyPluginAsync = async (fastify) => { ... }`
- `export default xxxRoutes`
- Reply con `reply.send({ ... })` para JSON
- Reply con `reply.type('text/html').send(htmlString)` para HTML

### Exemplar 3: Index registration (index.ts)
**Archivo**: `src/index.ts`
**Usar para**: Archivo #7
**Patron clave**:
- `import xxxRoutes from './routes/xxx.js'`
- `await fastify.register(xxxRoutes, { prefix: '/xxx' })`

## Contrato de Integracion — BLOQUEANTE

### Dashboard HTML -> Dashboard API

**GET /dashboard/api/stats**

Response exitoso (200):
```json
{
  "registriesCount": 2,
  "tasksByStatus": {
    "submitted": 0,
    "working": 1,
    "completed": 5,
    "failed": 0,
    "canceled": 0
  },
  "eventsTotal": 12,
  "successRate": 83.3,
  "totalCostUsdc": 0.045,
  "avgLatencyMs": 1250,
  "agents": [
    { "agentId": "summarizer", "agentName": "Summarizer", "registry": "wasiai", "invocations": 5, "avgLatencyMs": 800, "totalCostUsdc": 0.02 }
  ]
}
```

**GET /dashboard/api/events**

Response exitoso (200):
```json
{
  "events": [
    {
      "id": "uuid",
      "eventType": "compose_step",
      "agentId": "summarizer",
      "agentName": "Summarizer",
      "registry": "wasiai",
      "status": "success",
      "latencyMs": 1200,
      "costUsdc": 0.005,
      "txHash": "0xabc...",
      "goal": null,
      "createdAt": "2026-04-04T20:00:00Z"
    }
  ],
  "total": 1
}
```

### Dashboard HTML -> Endpoints existentes

El dashboard JS tambien consume:
- `GET /registries` — retorna `{ registries: [...], total: N }`
- `GET /tasks` — endpoint existente para lista de tasks

NO crear endpoints duplicados para registries/tasks.

## Modelo de Datos

### Tabla a2a_events (migracion SQL)

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

### Tipos TypeScript (agregar al final de src/types/index.ts)

```typescript
// ============================================================
// EVENT TYPES (WKH-27 Dashboard)
// ============================================================

export interface A2AEvent {
  id: string
  eventType: string
  agentId: string | null
  agentName: string | null
  registry: string | null
  status: 'success' | 'failed'
  latencyMs: number | null
  costUsdc: number
  txHash: string | null
  goal: string | null
  metadata: Record<string, unknown>
  createdAt: Date
}

export interface AgentSummary {
  agentId: string
  agentName: string
  registry: string
  invocations: number
  avgLatencyMs: number
  totalCostUsdc: number
}

export interface DashboardStats {
  registriesCount: number
  tasksByStatus: Record<string, number>
  eventsTotal: number
  successRate: number
  totalCostUsdc: number
  avgLatencyMs: number
  agents: AgentSummary[]
}
```

## Hook en compose.ts — Ubicacion exacta

### Import (agregar al inicio)
```typescript
import { eventService } from './event.js'
```

### Tracking en exito (dentro del for loop, DESPUES de `results.push(result)`)
```typescript
// Track event (fire-and-forget)
eventService.track({
  eventType: 'compose_step',
  agentId: agent.slug,
  agentName: agent.name,
  registry: agent.registry,
  status: 'success',
  latencyMs: latencyMs,
  costUsdc: agent.priceUsdc,
  txHash: txHash,
}).catch(err => console.error('[Compose] event tracking failed:', err))
```

### Tracking en fallo (dentro del catch, ANTES del return)
```typescript
// Track failed event (fire-and-forget)
eventService.track({
  eventType: 'compose_step',
  agentId: agent.slug,
  agentName: agent.name,
  registry: agent.registry,
  status: 'failed',
  latencyMs: Date.now() - startTime,
  costUsdc: 0,
}).catch(err => console.error('[Compose] event tracking failed:', err))
```

### NO trackear en budget exceeded (el agente nunca fue invocado)

## Constraint Directives

### OBLIGATORIO
- Seguir patron de `src/services/task.ts` para event.ts (Row interface, rowTo helper, service object)
- Seguir patron de `src/routes/registries.ts` para dashboard.ts (FastifyPluginAsync, export default)
- Imports: solo modulos que EXISTEN — usar `.js` extension en imports
- Supabase client: reutilizar singleton de `src/lib/supabase.ts`
- SQL migration: nombrar `20260404200000_events.sql`
- HTML en archivo separado `src/static/dashboard.html`, leido con `fs.readFileSync` al startup del route
- Constante para Kite Explorer: `const KITE_EXPLORER_URL = process.env.KITE_EXPLORER_URL || 'https://testnet.kitescan.ai'`
- Fire-and-forget con `.catch()`: `eventService.track(...).catch(err => console.error(...))`
- CSS: usar Pico CSS via CDN (`<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">`) para visual limpio

### PROHIBIDO
- NO agregar dependencias nuevas al package.json
- NO crear proyecto frontend separado
- NO usar WebSockets ni SSE
- NO bloquear compose esperando el insert de evento (siempre fire-and-forget con .catch)
- NO hardcodear URLs de Supabase
- NO modificar logica de negocio de compose (solo agregar hook post-step)
- NO agregar auth al dashboard
- NO simular datos — solo datos reales de la DB
- NO crear endpoints duplicados para /registries o /tasks
- NO poner HTML inline en el route handler — separar a archivo .html

## Test Expectations

| Test | ACs que cubre | Framework | Tipo |
|------|--------------|-----------|------|
| Test manual via browser | AC1, AC4, AC5, AC6 | Manual | E2E visual |
| Test manual via curl | AC3, AC7 | curl | Integration |
| Verificar tabla en Supabase | AC2 | Supabase CLI | DB |

No se requiere vitest para esta HU — el dashboard es UI y los endpoints de API son lectura pura.

## Waves

### Wave -1: Environment Gate

```bash
# Verificar deps instaladas
cd /home/ferdev/.openclaw/workspace/wasiai-a2a && npm install 2>/dev/null

# Verificar env vars
echo "SUPABASE_URL=${SUPABASE_URL:?FALTA}"
echo "SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY:?FALTA}"

# Verificar archivos base existen
ls src/services/task.ts src/services/compose.ts src/routes/registries.ts src/index.ts src/types/index.ts

# Verificar tabla a2a_events NO existe aun
# (se crea en W0.1)
```

### Wave 0 (Serial Gate — DB + Types)
- [ ] W0.1: Crear `supabase/migrations/20260404200000_events.sql` y ejecutar migracion
- [ ] W0.2: Agregar tipos `A2AEvent`, `AgentSummary`, `DashboardStats` en `src/types/index.ts`
- Verificacion: tabla existe en Supabase + `npx tsc --noEmit` pasa

### Wave 1 (Parallelizable — Service + HTML + Routes)
- [ ] W1.1: Crear `src/services/event.ts` con track(), stats(), recent() -> Exemplar 1
- [ ] W1.2: Crear `src/static/dashboard.html` con UI completa (KPIs, tablas, auto-refresh)
- [ ] W1.3: Crear `src/routes/dashboard.ts` con GET /, GET /api/stats, GET /api/events -> Exemplar 2
- Verificacion: `npx tsc --noEmit` pasa

### Wave 2 (Integracion)
- [ ] W2.1: Hook en `src/services/compose.ts` — import eventService + track post-step (ver seccion Hook)
- [ ] W2.2: Registrar dashboardRoutes en `src/index.ts` -> Exemplar 3
- Verificacion: `npx tsc --noEmit` pasa + servidor arranca + GET /dashboard responde HTML

### Wave 3 (Verificacion)
- [ ] W3.1: Abrir http://localhost:3001/dashboard — verificar KPIs en 0, tablas vacias con mensaje
- [ ] W3.2: Verificar auto-refresh (datos cambian cada 5s sin recargar)
- [ ] W3.3: Verificar GET /dashboard/api/stats retorna JSON correcto
- [ ] W3.4: Verificar GET /dashboard/api/events retorna JSON correcto

### Verificacion Incremental

| Wave | Verificacion al completar |
|------|--------------------------|
| W-1 | Entorno OK, archivos base existen |
| W0 | Tabla en Supabase + typecheck pasa |
| W1 | typecheck pasa, imports resuelven |
| W2 | servidor arranca + /dashboard responde 200 |
| W3 | QA visual + APIs retornan datos correctos |

## Out of Scope

- NO tocar orchestrate.ts (evento solo en compose por ahora)
- NO tocar middleware/x402.ts
- NO tocar services/discovery.ts ni services/registry.ts
- NO agregar graficos historicos ni chart libraries
- NO implementar auth/permisos en dashboard
- NO crear tests automatizados (vitest) para esta HU
- NO "mejorar" codigo adyacente

## Escalation Rule

> **Si algo no esta en este Story File, Dev PARA y pregunta a Architect.**
> No inventar. No asumir. No improvisar.

Situaciones de escalation:
- Un archivo del exemplar ya no existe
- Un import que necesito no esta disponible
- La tabla de BD tiene columnas diferentes a lo esperado
- Hay ambiguedad en un AC
- El cambio requiere tocar archivos fuera de la tabla

---

*Story File generado por NexusAgil — F2.5*
