# Story File — [WKH-103] wasiai-agentkey Fase 3: Reputación ERC-8004

> Contrato autocontenido para el Dev. **Si algo NO está acá, NO lo hagas.**
> Fuente: `sdd.md` (SPEC_APPROVED). NO leas el historial de chat.
> Modo QUALITY. TS strict, sin `any`.

---

## 0. Contexto compacto (qué se construye y por qué)

Cierra la tríada ERC-8004 (Identity WKH-100 → Delegation WKH-101 → **Reputation**).
Se computa un **score de reputación 0-100 por agente** a partir de las `a2a_events`
ya emitidas (tasks liquidadas verificables, anti-sybil), se surfacea en `POST /discover`
(sort + enrichment) y en el AgentCard (`GET /agents/:id/agent-card`). Cero gas, cero
escritura on-chain. Adicionalmente, lectura **opcional** del ReputationRegistry
on-chain (env-guarded, read-only, graceful skip) SOLO en el path single-agent.

**Hallazgo de grounding que define TODO** (`compose.ts:276-306` + `event.ts:64-71`):
- El **único** evento que escribe `agent_id` + `cost_usdc>0` es `compose_step` con
  `status='success'`. En él **`agent_id = agent.slug`** (compose.ts:278), NO `agent.id`.
- El catch de compose emite `status:'failed'` con **`costUsdc:0`** (compose.ts:304-306).
  → NO existe en `a2a_events` un evento `failed` con `cost_usdc>0`.
- Eventos `request:*` (middleware tracking) y `orchestrate_goal` van con `agent_id=NULL`
  y/o `cost_usdc=0` → quedan **estructuralmente excluidos** (anti-sybil CD-1).

---

## 1. ⛔ Anti-Hallucination Checklist (leer ANTES de codear)

| # | Verificación | Verdad groundeada |
|---|--------------|-------------------|
| AH-1 | `agent_id` en `a2a_events` = **`agent.slug`**, NO `agent.id`. El service recibe el **slug**. | `compose.ts:278` `agentId: agent.slug` |
| AH-2 | Columnas REALES de `a2a_events`: `agent_id`, `status`, `cost_usdc`, `latency_ms`, `created_at`, `event_type`, `agent_name`, `registry`. NO inventes otras. | `events.sql:6-32` |
| AH-3 | Patrón de query Supabase: `.from('a2a_events').select('status, latency_ms, cost_usdc, agent_id')` + reduce JS. **NUNCA** una query por agente. | `event.ts:113-177` |
| AH-4 | **NO existe Redis en el repo** (no hay `ioredis`/`getRedis()`/`createClient` para cache, no está en `package.json`). El "cache DT-4" se implementa como **Map en-proceso** (patrón lazy-Map de `erc8004-identity.ts:97`). PROHIBIDO importar/inventar un cliente Redis. | `package.json` (sin redis/node-cache); `grep` confirma 0 cache infra en `src/services` |
| AH-5 | Interfaz del **ReputationRegistry on-chain** = **`[VERIFY-AT-IMPL]`**. NO inventes la firma. Verificá en `https://github.com/erc-8004/erc-8004-contracts` (citá commit/tag en el JSDoc, como `erc8004-identity.ts:48-50`). Si NO se confirma → adapter-stub env-guarded + ABI marcado `[VERIFY-AT-IMPL]` + tests con mock del reader (NO RPC real). La feature queda **inactiva por default** (sin env → skip). | DT-6, SDD §11 obs.3 |
| AH-6 | **PROHIBIDO escritura on-chain**: nada de `WalletClient`, `writeContract`, `privateKeyToAccount`. Solo `createPublicClient` + `readContract`. viem v2, NO ethers. | CD-7, CD-8 |
| AH-7 | **PROHIBIDO N+1** en `/discover`: el batch es **UN solo SELECT** con `.in('agent_id', slugs)`. PROHIBIDO loop con 1 query por agente. | CD-12, DT-10 |
| AH-8 | **PROHIBIDO RPC on-chain en el hot-path de `/discover`**. El read on-chain SOLO en AgentCard single-agent y SOLO si env configurada. | CD-13, AC-1 |
| AH-9 | **NO se toca `a2a_agent_keys`** en ningún código de reputación. El score sale 100% de `a2a_events`. → Ownership Guard NO aplica en v1 (confirmado §6). NO importes `budgetService`/`delegationService`. | CD-2, CD-3, DT-5 |
| AH-10 | Campo nuevo `computedReputation?` debe ser **OPCIONAL** en `Agent` y `AgentCard`. Un campo requerido rompe 24+ fixtures en 9 files. Tras tocar tipos, correr `tsc --noEmit` (no solo el build). | CD-14 (WKH-100 §FIX-PACK v3) |
| AH-11 | Backward-compat: agente sin score → campo **OMITIDO** vía spread condicional `...(x !== undefined && { x })`. NUNCA `null`/`undefined` explícito. | CD-9, `agent-card.ts:151` |
| AH-12 | Antes de consumir un export nuevo (`reputationService`, etc.) en código bajo test, `grep "vi.mock('<modulo>'"` en TODO el repo y reflejar el export en TODOS los factory-mocks. Rompen en runtime, no en tsc. | CD-15 (WKH-100 §Wave4) |
| AH-13 | Nuevo arg `computedReputation?` en `buildAgentCard` → revisar TODOS los `toHaveBeenCalledWith` exactos en `agent-card.test.ts` (service+route). Arg opcional rompe matches exactos. | CD-16 (WKH-101 §W4) |
| AH-14 | `biome check --write` (o `npm run format`) en CADA archivo nuevo/tocado ANTES de `npm run lint`. organizeImports incluido. | CD-17 |
| AH-15 | PROHIBIDO propagar `error.message` crudo de Supabase/PG al body del cliente. Compute falla → log server-side + campo omitido (graceful). | CD-18 |

### 3 observaciones del SDD incorporadas
- **OBS-1 (success_rate modulador):** `success_rate` NO se computa sobre `cost_usdc>0`
  (sería siempre 1.0). Se computa sobre el universo `compose_step` del slug (success+failed
  por `agent_id`, **sin** filtro de costo) como **modulador** del score. La BASE
  (`tasks_settled`) SÍ exige `cost_usdc>0` (CD-1 intacto). Ver W1 fórmula.
- **OBS-2 (sort pre-limit):** el batch-compute del score corre sobre `allAgents` **ANTES**
  del sort y del `slice(limit)`, en 1 query agregado indexable (no N+1). Así `page = top-N
  por reputación real`. El enrichment de `identity` queda post-limit (no afecta sort).
- **OBS-3 (W3 stub si contrato no confirmado):** si la interfaz del ReputationRegistry no
  se confirma en el repo oficial, W3 queda como adapter-stub env-guarded (inactivo) sin
  afectar el core off-chain (W1/W2). No bloquea.

---

## 2. Orden de waves (W0 serial primero, luego W1→W2/W3→W4)

```
W0 (serial)  → tipos + migration + .env.example          [gate: tsc --noEmit verde]
W1           → src/services/reputation.ts + tests          [núcleo off-chain]
W2           → discovery.ts + agent-card.ts + route + tests [enrichment off-chain]
W3 (paralelo a W2 tras W1; coordinar agent-card.ts route)  → adapter on-chain opcional + tests
W4           → integración (no-N+1, sort, backward-compat) + gate final
```

---

## 3. Scope IN — archivos exactos

**Nuevos (5):**
- `src/services/reputation.ts`
- `src/services/reputation.test.ts`
- `src/adapters/erc8004-reputation.ts` (W3)
- `src/adapters/erc8004-reputation.test.ts` (W3)
- `supabase/migrations/<ts>_reputation_index.sql`

**Modificados (5):**
- `src/types/index.ts`
- `src/services/discovery.ts`
- `src/services/agent-card.ts`
- `src/routes/agent-card.ts`
- `.env.example`

**Tests tocados (mocks — CD-15/CD-16):**
- `src/services/discovery.test.ts`
- `src/services/agent-card.test.ts`
- `src/routes/agent-card.test.ts`

**PROHIBIDO tocar nada fuera de esta lista.** Sin endpoint dedicado (CD-11). Sin Validation Registry.

---

## W0 — Contratos (SERIAL, primero)

### Objetivo
Definir el contrato de tipos, el índice DB y las env vars. Gate: `tsc --noEmit` verde.

### Cubre
AC-5 (shape), AC-11 (env), DT-7, DT-9, CD-4, CD-6, CD-14.

### Archivos y cambios exactos

**`src/types/index.ts`** — agregar el tipo `AgentReputation` (cerca de `AgentCardIdentity`, ~`:170`):

```ts
/**
 * WKH-103 (AC-5): score de reputación computado off-chain desde a2a_events
 * (tasks liquidadas: status='success' AND cost_usdc>0, anti-sybil CD-1).
 * Campo NUEVO — NO pisa Agent.reputation (upstream del registry). Surfacing
 * SOLO en /discover (off-chain) y AgentCard (off-chain + on-chain opcional).
 */
export interface AgentReputation {
  /** 0-100 entero, determinista (DT-2). */
  score: number;
  /** COUNT de eventos liquidados (status='success' AND cost_usdc>0). */
  tasks_settled: number;
  /** 0-1, 2 decimales — modulador success/(success+failed) (OBS-1). */
  success_rate: number;
  /** SUM(cost_usdc) liquidado, 6 decimales. */
  total_volume_usdc: number;
  /** AVG(latency_ms) entero — OMITIDO si no hay latency (no null). */
  avg_latency_ms?: number;
  /** 'hybrid' solo si AC-7 incorporó read on-chain OK; si no, 'off-chain'. */
  source: 'off-chain' | 'hybrid';
  /**
   * Valor crudo verificado on-chain (AC-7). Shape [VERIFY-AT-IMPL] contra el
   * repo oficial del ReputationRegistry. OMITIDO si no se leyó on-chain.
   * NO altera `score` en v1 (additive, DT-3.1).
   */
  onchain?: { value: string; chain_id: number };
}
```

- En `Agent` (`:118-148`) agregar como **opcional** (CD-14), después de `identity?`:
  ```ts
  /** WKH-103 (AC-1): score off-chain computado. Omitido si 0 tasks (CD-9). */
  computedReputation?: AgentReputation;
  ```
- En `AgentCard` (`:543-584`) agregar como **opcional**, después de `identity?`:
  ```ts
  /** WKH-103 (AC-5): reputación computada. Non-breaking optional extension. */
  computedReputation?: AgentReputation;
  ```
- **NO tocar** `Agent.reputation?: number` (`:125`) — se conserva intacto (CD-10).

**`supabase/migrations/<ts>_reputation_index.sql`** — `<ts>` = timestamp `YYYYMMDDHHmmss` mayor que la última migration existente. Contenido EXACTO:

```sql
-- WKH-103 (DT-9): índice parcial para el GROUP BY del score de reputación.
-- Cubre el filtro (agent_id, status) + INCLUDE de las columnas del aggregate
-- para evitar heap-fetch. WHERE agent_id IS NOT NULL → parcial (excluye los
-- eventos request:* / orchestrate_goal sin agente). Idempotente, sin DROP.
CREATE INDEX IF NOT EXISTS idx_a2a_events_reputation
  ON a2a_events (agent_id, status)
  INCLUDE (cost_usdc, latency_ms, created_at)
  WHERE agent_id IS NOT NULL;
```
> `INCLUDE` requiere PG 11+ (Supabase OK). NO modificar índices existentes. Pre-flight runbook WKH-78 aplica al deploy.

**`.env.example`** — agregar tras el bloque ERC-8004 Identity (`:471`), replicando el formato de `:456-471`:

```bash
# ── ERC-8004 Reputation Registry (WKH-103, Fase 3) ──────────────────────────
# Address del ReputationRegistry ERC-8004 por red. El server lo lee read-only
# con viem (NUNCA escribe). Resolución: per-red → fallback global
# ERC8004_REPUTATION_REGISTRY_ADDRESS. Ausente/inválida → REGISTRY_NOT_CONFIGURED
# (la lectura on-chain queda inactiva; el score off-chain sigue funcionando).
# La interfaz del contrato es [VERIFY-AT-IMPL] — verificar el repo oficial antes
# de activar en prod.
ERC8004_REPUTATION_REGISTRY_ADDRESS_BASE_MAINNET=
ERC8004_REPUTATION_REGISTRY_ADDRESS_BASE_SEPOLIA=
# Fallback global si no hay per-red (opcional).
ERC8004_REPUTATION_REGISTRY_ADDRESS=

# Factor de escala del score 0-100: raw = min(tasks_settled / FACTOR, 1).
# Number.parseInt, validado > 0; fallback al default 50 si inválido.
REPUTATION_SCALE_FACTOR=50

# TTL (ms) del cache en-proceso del score off-chain (DT-4). Default 60000.
# NO hay Redis: el cache es un Map en memoria del proceso. 0/inválido → default.
REPUTATION_CACHE_TTL_MS=60000
```

### DoD W0
- [ ] `tsc --noEmit` → 0 errores (CD-14, gate obligatorio).
- [ ] `biome check --write` en `index.ts` (CD-17).
- [ ] Migration con `<ts>` real, idempotente, sin DROP.

---

## W1 — Service de cómputo off-chain (núcleo)

### Objetivo
`src/services/reputation.ts`: computa el score determinista desde `a2a_events`, con cache en-proceso. Lee SOLO `a2a_events`.

### Cubre
AC-1, AC-2, AC-9, DT-2, DT-4, DT-5, DT-10, DT-11, CD-1, CD-2, CD-6, CD-12, CD-18.

### Firmas EXACTAS (TS strict, sin `any`)

```ts
import { supabase } from '../lib/supabase.js';
import type { AgentReputation } from '../types/index.js';

// ── Env helpers (patrón resolveTimeoutMs, erc8004-identity.ts:89-93) ──
function resolveScaleFactor(): number {
  const raw = process.env.REPUTATION_SCALE_FACTOR;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 50;
}
function resolveCacheTtlMs(): number {
  const raw = process.env.REPUTATION_CACHE_TTL_MS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

// ── Cache en-proceso (NO Redis — AH-4). Patrón lazy-Map adapters. ──
interface CacheEntry { value: AgentReputation | null; expiresAt: number; }
const _cache = new Map<string, CacheEntry>();

/** TEST-ONLY — limpia el cache (patrón _resetErc8004Reader). */
export function _resetReputationCache(): void {
  _cache.clear();
}

// ── Acumulador interno del reduce JS (patrón agentMap, event.ts:134) ──
interface RepAccumulator {
  settledCount: number;      // success AND cost_usdc>0
  settledVolume: number;     // SUM(cost_usdc) de los liquidados
  settledLatencySum: number; // SUM(latency_ms) de los liquidados (no null)
  settledLatencyCount: number;
  successCount: number;      // status='success' (cualquier costo)
  failedCount: number;       // status='failed'
}

/** Filas que pedimos a Supabase (select mínimo, DT-5/CD-2). */
interface RepRow {
  agent_id: string | null;
  status: string;
  cost_usdc: number | string | null;
  latency_ms: number | null;
}

export interface ReputationService {
  /**
   * Single-agent (path AgentCard). 1 query por slug + cache en-proceso (DT-4).
   * Retorna null si 0 tasks liquidadas (→ campo omitido por el caller, CD-9).
   */
  computeReputationForAgent(slug: string): Promise<AgentReputation | null>;

  /**
   * Batch (path /discover). UN solo SELECT con .in('agent_id', slugs) (CD-12).
   * Retorna Map<slug, AgentReputation> SOLO para slugs con score (>0 tasks).
   * Slugs sin tasks NO aparecen en el Map (caller omite el campo).
   */
  computeReputationBatch(slugs: string[]): Promise<Map<string, AgentReputation>>;
}

export const reputationService: ReputationService = { /* ... */ };
```

### Fórmula EXACTA (determinista, DT-2 + OBS-1)

Dado el acumulador de un slug:
```
tasks_settled     = settledCount                          // success AND cost_usdc>0
total_volume_usdc = round(settledVolume, 6 decimales)
avg_latency_ms    = settledLatencyCount > 0
                      ? Math.round(settledLatencySum / settledLatencyCount)
                      : undefined                          // OMITIDO, no null

denom        = successCount + failedCount
success_rate = denom > 0 ? round(successCount / denom, 2 decimales) : 1
               // modulador OBS-1. denom usa compose_step success+failed del slug.

raw   = Math.min(tasks_settled / resolveScaleFactor(), 1)  // ∈ [0,1]
score = Math.round(raw * 100 * success_rate)               // ∈ [0,100] entero

source = 'off-chain'   // W1 nunca pone 'hybrid' (eso es W3 single-agent)
```
**Regla de 0 tasks:** si `tasks_settled === 0` → la función retorna **`null`** (no objeto).
El caller (W2) omite el campo vía spread condicional.

### SQL/Query EXACTO

**Batch (`computeReputationBatch`)** — 1 query (CD-12):
```ts
const { data, error } = await supabase
  .from('a2a_events')
  .select('agent_id, status, cost_usdc, latency_ms')
  .in('agent_id', slugs);          // SOLO los slugs de la página/set (AH-7, T-BATCH-PAGE)
// NOTA: el filtro agent_id NOT NULL es implícito (slugs no contiene null).
// status y cost_usdc se filtran en el reduce JS, NO en SQL, porque necesitamos
// success+failed para success_rate (OBS-1) Y success+cost>0 para tasks_settled.
if (error) {
  // CD-18: log server-side, NUNCA propagar error.message al caller.
  // Batch falla → retornar Map vacío (caller deja a los agentes sin el campo, AC-4).
  logger.error(...); return new Map();
}
```
Reduce JS por `agent_id` en `Map<slug, RepAccumulator>` (patrón `agentMap`, `event.ts:146-177`):
- por cada fila con `status==='success' && Number(cost_usdc)>0`: `settledCount++`, `settledVolume += Number(cost_usdc)`, latency si no null.
- por cada fila `status==='success'`: `successCount++`.
- por cada fila `status==='failed'`: `failedCount++`.
Luego aplicar la fórmula por slug; solo agregar al Map de salida los slugs con `tasks_settled>0`.

**Single (`computeReputationForAgent`)** — cache + 1 query:
```ts
const ttl = resolveCacheTtlMs();
const hit = _cache.get(slug);
if (hit && hit.expiresAt > Date.now()) return hit.value;   // cache hit (T-CACHE)

const { data, error } = await supabase
  .from('a2a_events')
  .select('agent_id, status, cost_usdc, latency_ms')
  .eq('agent_id', slug);
if (error) { logger.error(...); return null; }             // AC-4/CD-18, NO cachear el fallo
// ... mismo reduce + fórmula ...
const result = tasks_settled > 0 ? rep : null;
_cache.set(slug, { value: result, expiresAt: Date.now() + ttl });
return result;
```
> Redis ausente NO es un error (AH-4): el Map siempre existe. NO try/catch alrededor de "Redis"; no hay Redis.

### CD-1 / anti-sybil (groundeado)
- `tasks_settled` exige `status='success' AND cost_usdc>0`. Eventos `request:*` y
  `orchestrate_goal` tienen `agent_id=NULL` → ni siquiera entran al batch (`.in` por slugs)
  y en single-agent no matchean `agent_id`. Un `compose_step` success con `cost_usdc=0`
  NO suma a `settledCount`. Solo-fallidos → `settledCount=0` → score null.

### Tests W1 — `src/services/reputation.test.ts`
Mockea `supabase` (patrón `identity.test.ts`/`event` mock; `mockImplementation`+contador, NO `mockReturnValueOnce` encadenado — lección WKH-100). Cada test resetea con `_resetReputationCache()` en `beforeEach`.

| Test | Cubre |
|------|-------|
| T-AC2 | success con `cost_usdc=0` NO suma a `tasks_settled`; solo `success AND cost>0` cuenta | AC-2, CD-1 |
| T-AC9 | filas con `agent_id=null` / `event_type='request:*'`/`orchestrate_goal` no entran (no matchean slug) | AC-9, CD-1 |
| T-AC5 | score>0 → objeto con `{score(0-100), tasks_settled, success_rate, total_volume_usdc}` | AC-5, DT-2 |
| T-FORMULA | misma data → mismo score; cambiar `REPUTATION_SCALE_FACTOR` cambia el score; `raw` clampa → score ≤ 100 | DT-2 |
| T-SUCCESS-RATE | success+failed → `success_rate<1` modula el score hacia abajo (OBS-1) | DT-2 |
| T-ANTI-SYBIL | solo-fallidos → `tasks_settled=0` → retorna `null` | AC-2/AC-9, CD-1 |
| T-0-TASKS | sin eventos → `null` | AC-3, CD-9 |
| T-NO-N+1 | `computeReputationBatch([s1,s2,s3])` → `supabase.from` llamado **EXACTAMENTE 1 vez** con `.in` | DT-10, CD-12 |
| T-BATCH-PAGE | el `.in` recibe SOLO los slugs pasados (no full-scan) | DT-10 |
| T-CACHE | 2ª llamada single mismo slug dentro de TTL → 0 queries adicionales (assert call count) | DT-4 |
| T-AC4 | `supabase` devuelve `{error}` / lanza → batch retorna Map vacío y single retorna null, sin throw, sin propagar `error.message` | AC-4, CD-5, CD-18 |
| T-AC10 | test-guard: el módulo NO importa `budgetService`/`delegationService` ni hace `.from('a2a_agent_keys')` (assert string del source o spy de supabase.from arg) | AC-10, CD-2/CD-3 |

### DoD W1
- [ ] `tsc --noEmit` verde; sin `any`.
- [ ] Tests W1 verdes.
- [ ] `biome check --write` en `reputation.ts` + test (CD-17).
- [ ] Confirmado: 0 imports de budget/delegation/redis (AH-4, AH-9).

---

## W2 — Enrichment en discovery + AgentCard (off-chain)

### Objetivo
Cablear el score al sort + enrichment de `/discover` y al AgentCard single-agent. Solo off-chain (sin RPC, AH-8).

### Cubre
AC-1, AC-3, AC-4, AC-5, AC-6, DT-7, DT-8, DT-10, DT-11, CD-5, CD-9, CD-10, CD-12, CD-13, CD-14, CD-15, CD-16.

### Archivos y cambios exactos

**`src/services/discovery.ts`**
1. Importar `reputationService` (CD-15: reflejar en factory-mocks de `discovery.test.ts`).
2. **Batch-compute ANTES del sort** (OBS-2). En `discover()`, justo antes del sort (`:303`),
   sobre `allAgents` ya filtrados (pre-limit):
   ```ts
   // WKH-103 (DT-8/OBS-2): score batch pre-sort, 1 query (CD-12). Sin RPC (CD-13).
   await this.attachReputations(allAgents);
   ```
3. **Nuevo método `attachReputations`** (gemelo de `attachIdentities`, `:336-355`), batch graceful:
   ```ts
   /**
    * WKH-103 (DT-8/DT-10): enriquece computedReputation en batch con UN solo
    * query (CD-12). Sin RPC on-chain (CD-13). Fallo DB → agentes sin el campo,
    * NUNCA rompe discover (AC-4/CD-5).
    */
   async attachReputations(agents: Agent[]): Promise<Agent[]> {
     try {
       const slugs = agents.map((a) => a.slug);
       const repMap = await reputationService.computeReputationBatch(slugs);
       for (const a of agents) {
         const rep = repMap.get(a.slug);
         if (rep) a.computedReputation = rep; // omitido si no hay (CD-9)
       }
     } catch {
       /* DB fail → sin reputación, NO rompe discover (AC-4) */
     }
     return agents;
   }
   ```
4. **Sort (AC-6)** — modificar `repDiff` (`:306`) para leer el score con fallback (CD-10, NO reasignar `reputation`):
   ```ts
   const repValue = (x: Agent) => x.computedReputation?.score ?? x.reputation ?? 0;
   const repDiff = repValue(b) - repValue(a);
   ```
5. **Single-agent (`getAgent`, `:479-535`)**: enriquecer graceful (off-chain) antes de retornar el agente, dentro de su `try/catch` existente:
   ```ts
   // WKH-103: off-chain score (sin RPC). On-chain opcional se resuelve en el route (W3).
   try {
     const rep = await reputationService.computeReputationForAgent(agent.slug);
     if (rep) agent.computedReputation = rep;
   } catch { /* sin reputación, no rompe */ }
   ```
   > El enrichment de `identity` se mantiene post-limit (`:316`, no afecta sort). NO mover.

**`src/services/agent-card.ts`** — `buildAgentCard` (`:87-153`):
- Nuevo arg opcional al final de la firma (después de `identity?`):
  ```ts
  buildAgentCard(
    agent: Agent,
    registryConfig: RegistryConfig,
    baseUrl: string,
    identity?: AgentCardIdentity,
    computedReputation?: AgentReputation,   // WKH-103 AC-5
  ): AgentCard {
  ```
- Spread condicional en el return (gemelo de `:151`, después de `...(identity ...)`):
  ```ts
  ...(computedReputation !== undefined && { computedReputation }),
  ```

**`src/routes/agent-card.ts`** (`:55-70`): resolver `computedReputation` ANTES de `buildAgentCard` y pasarlo. En W2 solo off-chain (W3 agrega on-chain opcional):
```ts
// WKH-103 (DT-8): score off-chain resuelto antes del build. Graceful (AC-4).
let computedReputation: AgentReputation | undefined;
try {
  computedReputation =
    (await reputationService.computeReputationForAgent(agent.slug)) ?? undefined;
} catch {
  computedReputation = undefined; // sin reputación, NUNCA 5xx (CD-5)
}
const card = agentCardService.buildAgentCard(
  agent, registryConfig, baseUrl, identity ?? undefined, computedReputation,
);
```
> Si `getAgent` ya enriqueció `agent.computedReputation`, el route puede reusar
> `agent.computedReputation` en vez de recomputar — **elegí UNA fuente** para no duplicar
> queries (preferí computar en el route y NO en `getAgent`, o viceversa; documentá la decisión).
> Default sugerido: computar en el **route** (más cerca del on-chain de W3) y NO en `getAgent`.

### Tests W2
- `discovery.test.ts`: mock `reputationService` (CD-15 — grep `vi.mock` y reflejar el nuevo export).
  - T-AC1: discover enriquece `computedReputation` desde el batch, **sin** RPC on-chain.
  - T-AC6: sort verified-first → score desc (usando `computedReputation.score`) → price asc; fallback a `reputation` upstream cuando no hay score.
  - T-AC4: `computeReputationBatch` lanza → discover responde sin el campo, sin 5xx.
  - T-NO-N+1 (integración): N agentes → `computeReputationBatch` llamado 1 vez con todos los slugs.
- `agent-card.test.ts` (service): T-AC5 (card expone `computedReputation`), T-AC3 (0 tasks → campo omitido, snapshot sin la key), T-BACKWARD (agente legacy sin score = shape previo exacto). Revisar `toHaveBeenCalledWith` (CD-16).
- `agent-card.test.ts` (route): mock `reputationService`; T-AC4 (compute lanza → 200 sin campo).

### DoD W2
- [ ] `tsc --noEmit` verde.
- [ ] Tests W2 verdes; factory-mocks actualizados (CD-15); `toHaveBeenCalledWith` revisados (CD-16).
- [ ] `biome check --write` en archivos tocados.
- [ ] Verificado: 0 RPC on-chain en el path `/discover` (AH-8).

---

## W3 — Adapter on-chain OPCIONAL (env-guarded, NC-2)

### Objetivo
`src/adapters/erc8004-reputation.ts`: reader viem read-only env-guarded. Enriquece `source='hybrid'` + `onchain` SOLO en AgentCard single-agent y SOLO si env configurada. Graceful skip. **El score 0-100 NO cambia** (additive, DT-3.1).

### Cubre
AC-7, AC-8, AC-11, DT-3, DT-3.1, DT-6, CD-4, CD-5, CD-7, CD-8, CD-13.

### Firmas EXACTAS — clon estructural de `erc8004-identity.ts`

```ts
import { type Chain, createPublicClient, http, type PublicClient } from 'viem';
import { getBaseChain, getBaseNetwork } from './base/chain.js';

// ── Result types (patrón Erc8004ReadReason, erc8004-identity.ts:26-44) ──
export type Erc8004ReputationReadReason =
  | 'RPC_UNAVAILABLE'
  | 'REGISTRY_NOT_CONFIGURED'
  | 'NOT_FOUND'
  | 'CHAIN_MISMATCH';

export interface Erc8004ReputationResult {
  ok: boolean;
  reason?: Erc8004ReputationReadReason;
  /** Valor crudo on-chain. Shape exacto [VERIFY-AT-IMPL]. */
  value?: string;
  chainId?: number;
}

// ── ABI [VERIFY-AT-IMPL] — NO inventar la firma ──────────────────────
// TODO(VERIFY-AT-IMPL): verificar firma real en
// https://github.com/erc-8004/erc-8004-contracts (citar commit/tag aquí).
// Hasta confirmar, este ABI es un PLACEHOLDER read-only. La feature queda
// inactiva por default (sin env → REGISTRY_NOT_CONFIGURED → skip sin RPC).
const ERC8004_REPUTATION_ABI = [
  // [VERIFY-AT-IMPL] firma read-only del ReputationRegistry
] as const;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
type BaseNet = 'mainnet' | 'testnet';

function resolveReputationRegistryAddress(network: BaseNet): `0x${string}` | null {
  const perNet =
    network === 'mainnet'
      ? process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS_BASE_MAINNET
      : process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS_BASE_SEPOLIA;
  const raw = perNet ?? process.env.ERC8004_REPUTATION_REGISTRY_ADDRESS;
  if (raw && ADDRESS_RE.test(raw)) return raw as `0x${string}`;
  return null; // → REGISTRY_NOT_CONFIGURED
}

// Lazy client cache PROPIO (NO compartir con erc8004-identity — DT-3).
const _clients = new Map<'base-mainnet' | 'base-sepolia', PublicClient>();

/** TEST-ONLY — limpia el cache. */
export function _resetErc8004ReputationReader(): void {
  _clients.clear();
}

export interface Erc8004ReputationReader {
  /** Lee el score/attestation on-chain. NUNCA throw — retorna {ok:false,reason}. */
  read(args: { /* [VERIFY-AT-IMPL]: address | tokenId */ }): Promise<Erc8004ReputationResult>;
}

export const erc8004ReputationReader: Erc8004ReputationReader = { /* ... */ };
```

Reglas:
- Reusá `getBaseNetwork`/`getBaseChain` + `resolveRpcUrl(network)` (env `BASE_*_RPC_URL`) + `resolveTimeoutMs` (replicá el de identity o reusá un helper local).
- `classifyReadError`: `ContractFunctionExecutionError` → `NOT_FOUND`; resto → `RPC_UNAVAILABLE`.
- Defensivo `getChainId()` != esperado → `CHAIN_MISMATCH` (como `resolveContext`, `:139-163`).
- **NUNCA throw** al caller. Solo `createPublicClient`/`readContract` (CD-8: sin WalletClient/writeContract).

**`src/routes/agent-card.ts`** — tras resolver el off-chain (W2), si env configurada, enriquecer additive (AC-7/DT-3.1):
```ts
// WKH-103 W3 (AC-7): read on-chain OPCIONAL. SOLO aquí (single-agent), NUNCA en /discover (CD-13).
if (computedReputation && resolveReputationRegistryAddress(getBaseNetwork())) {
  const onchain = await erc8004ReputationReader.read({ /* [VERIFY-AT-IMPL] */ });
  if (onchain.ok && onchain.value !== undefined) {
    computedReputation = {
      ...computedReputation,
      source: 'hybrid',
      onchain: { value: onchain.value, chain_id: onchain.chainId ?? 0 },
    };
  }
  // onchain falla → se deja source='off-chain' sin campo onchain (AC-8). NUNCA 5xx.
}
```
> NO se altera `score`. NO se cachea el read on-chain (DT-4).

### Tests W3 — `src/adapters/erc8004-reputation.test.ts`
Mock del reader / del `createPublicClient` (NO RPC real). `_resetErc8004ReputationReader()` en `beforeEach`.

| Test | Cubre |
|------|-------|
| T-AC7-on | env set + reader OK → `source='hybrid'` + `onchain` presente (route single-agent) | AC-7, DT-3.1 |
| T-AC7-off | env ausente → `resolveReputationRegistryAddress` null → skip sin RPC, `source='off-chain'`, sin campo onchain | AC-7/AC-8, CD-13 |
| T-AC8 | reader `RPC_UNAVAILABLE` → score off-chain devuelto, sin onchain, sin 5xx | AC-8, CD-5 |
| T-AC11 | address SOLO de env per-red/global; grep: 0 addresses hardcodeadas | AC-11, CD-4 |
| T-VERIFY-IMPL | documenta el `[VERIFY-AT-IMPL]`; mockea el reader; NO golpea RPC real | DT-6 |

> Mock del módulo on-chain en `agent-card.test.ts` route (CD-15: reflejar el nuevo export).

### DoD W3
- [ ] `tsc --noEmit` verde; sin `any`; sin WalletClient/writeContract/privateKeyToAccount (AH-6).
- [ ] Tests W3 verdes (mock, no RPC real).
- [ ] ABI/firma marcados `[VERIFY-AT-IMPL]` con cita al repo oficial; feature inactiva sin env.
- [ ] `biome check --write` en adapter + tests.
- [ ] **Coordinación**: `agent-card.ts` route lo tocan W2 y W3 → secuenciar (W2 antes que W3 en ese file).

---

## W4 — Integración + cierre

### Objetivo
Verificar el comportamiento end-to-end y cerrar gates.

### Cubre
AC-1, AC-6, CD-12, CD-13, CD-14, CD-17.

### Tests (en `discovery.test.ts` / e2e existente)
| Test | Cubre |
|------|-------|
| T-NO-N+1 (e2e) | N agentes en discover → `computeReputationBatch` llamado 1 vez (assert nº de `supabase.from('a2a_events')`); PROHIBIDO crecer con N | CD-12 |
| T-AC6 (e2e) | discover devuelve la página ordenada por score real (verified → score desc → price asc) | AC-6 |
| T-BACKWARD (e2e) | agentes sin eventos → respuesta sin `computedReputation`, shape previo intacto | CD-9 |
| T-AC1 (e2e) | discover NO hace RPC on-chain (mock del reader assert 0 calls) | AC-1, CD-13 |

### DoD W4 (gate final)
- [ ] `tsc --noEmit` → 0 errores (CD-14).
- [ ] `biome check --write` en TODOS los archivos tocados, luego `npm run lint` verde (CD-17).
- [ ] Suite completa verde (`npm test`).
- [ ] Migration aplicable e idempotente.
- [ ] Confirmado: 0 RPC en hot-path discover; on-chain solo single-agent + env (CD-13).

---

## 4. Done Definition (HU completa)
- [ ] Los 5 archivos nuevos + 5 modificados + 3 tests de mock tocados según Scope IN (nada fuera).
- [ ] 11 ACs cubiertos con ≥1 test cada uno (21 tests del SDD §6 mapeados a W1-W4).
- [ ] `tsc --noEmit` + `npm run lint` + `npm test` verdes.
- [ ] Sin `any`, sin hardcodes de address, sin Redis inventado, sin WalletClient.
- [ ] `Agent.reputation` upstream intacto (CD-10); `a2a_agent_keys` NO tocada (CD-2/CD-3).
- [ ] Sin endpoint dedicado, sin Validation Registry (CD-11, Scope OUT).
- [ ] `[VERIFY-AT-IMPL]` documentado en el adapter con cita al repo oficial (DT-6).

---

## 5. CD resumidas (referencia rápida)

| CD | Una línea |
|----|-----------|
| CD-1 | Score SOLO de `a2a_events` `status='success' AND cost_usdc>0 AND agent_id NOT NULL`. |
| CD-2 | PROHIBIDO tocar `budget`/`funding_wallet`/`daily_*` de `a2a_agent_keys`. |
| CD-3 | Ownership Guard si tocaras `a2a_agent_keys` (NO aplica v1). |
| CD-4 | Address del registry SOLO de env per-red + fallback global. |
| CD-5 | Graceful en TODO enrichment: error → campo omitido, NUNCA 5xx. |
| CD-6 | Sin `any`/`as unknown`. TS strict. |
| CD-7 | viem v2, PROHIBIDO ethers. |
| CD-8 | PROHIBIDO escritura on-chain. |
| CD-9 | Sin score → campo OMITIDO (spread condicional), nunca null/undefined. |
| CD-10 | NO pisar `Agent.reputation` upstream; el sort lo LEE como fallback. |
| CD-11 | PROHIBIDO endpoint dedicado. Solo /discover + AgentCard. |
| CD-12 | Batch = UN solo SELECT con `IN(slugs)`. PROHIBIDO 1 query por agente. |
| CD-13 | PROHIBIDO RPC on-chain en hot-path /discover; solo AgentCard single + env. |
| CD-14 | Campo nuevo OPCIONAL; correr `tsc --noEmit`. |
| CD-15 | Grep `vi.mock` y reflejar exports nuevos en factory-mocks. |
| CD-16 | Revisar `toHaveBeenCalledWith` por arg nuevo en `buildAgentCard`. |
| CD-17 | `biome check --write` antes de `npm run lint`. |
| CD-18 | NUNCA propagar `error.message` crudo de PG/Supabase al body. |

---

> **Drift flag para el orquestador/humano:** la `sdd.md` DT-4 dice "Cache Redis".
> El grounding confirma que **NO existe Redis** en el repo (sin dep, sin cliente, sin infra).
> Este Story File baka DT-4 como **cache Map en-proceso** (TTL env, patrón lazy-Map de los
> adapters), 100% compatible con el intento de DT-4 (cachear el score por slug, graceful sin
> Redis). NO es un cambio de scope; es un grounding del "cómo". Si el humano quiere Redis real,
> es una HU separada (agrega dependencia + infra).
