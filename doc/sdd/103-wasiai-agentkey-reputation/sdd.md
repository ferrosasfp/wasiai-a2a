# SDD — [WKH-103] wasiai-agentkey Fase 3: Reputación ERC-8004

> Estado: **DRAFT → para SPEC_APPROVED**
> Modo: QUALITY (full SDD)
> Input: `doc/sdd/103-wasiai-agentkey-reputation/work-item.md` (11 ACs) + 3 decisiones del humano (NC-1/NC-2/NC-3, bakeadas abajo como DT/CD)

---

## 0. Decisiones del humano (bakeadas — fuente de verdad)

| NC | Decisión del humano | Dónde se baka |
|----|---------------------|---------------|
| NC-1 | Score **0-100 normalizado** desde tasks liquidadas; campo NUEVO `computedReputation` en `Agent`/AgentCard (NO pisar `reputation` upstream del registry) | DT-2, DT-7, CD-10 |
| NC-2 | Off-chain computado + **lectura on-chain OPCIONAL** del ReputationRegistry (env-guarded, graceful skip, read-only sin gas). Interfaz del contrato = `[VERIFY-AT-IMPL]` | DT-3, DT-6, CD-4/CD-7/CD-8 |
| NC-3 | Surfacing **SOLO en /discover + AgentCard** (enrichment), SIN endpoint dedicado | DT-8, CD-11 |

---

## 1. Context Map (archivo:línea — leído y verificado)

| Archivo:línea | Qué extraje | Para qué |
|---------------|-------------|----------|
| `supabase/migrations/20260404200000_events.sql:6-32` | `a2a_events` tiene `agent_id TEXT`, `status TEXT CHECK IN ('success','failed')`, `cost_usdc NUMERIC(12,6) DEFAULT 0`, `latency_ms INTEGER`, `event_type`, `created_at`. Índices existentes: `idx_a2a_events_agent (agent_id)`, `idx_a2a_events_status (status)`, `idx_a2a_events_created (created_at DESC)`. **No hay índice compuesto** que cubra el GROUP BY del score. | Campos REALES para la fórmula + diseño del índice (DT-1, DT-9) |
| `src/services/compose.ts:276-296` | **FUENTE REAL del score**: el evento `compose_step` es el ÚNICO que escribe `agent_id` (= `agent.slug`), `agent_name`, `registry`, `status:'success'`, `cost_usdc: agent.priceUsdc`. El catch (`:298-310`) emite `status:'failed'` con `costUsdc:0`. | **`agent_id` en events = `agent.slug`, NO `agent.id`**. El score se computa por slug. Anti-sybil: solo `success` + `cost_usdc>0` (DT-2, CD-1) |
| `src/services/orchestrate.ts:281,378,455` | Eventos `orchestrate_goal` NO llevan `agent_id` por-agente y su `cost_usdc` agrega. PERO orchestrate llama internamente a `composeService.compose` (`:405`), que emite el `compose_step` per-agente. → invocaciones orquestadas SÍ quedan capturadas vía `compose_step`. | El score se construye SOLO desde `compose_step`; orchestrate queda cubierto transitivamente. No se cuenta doble. |
| `src/middleware/event-tracking.ts:14-90` | Eventos `request:<method>:<route>` (de `/discover`,`/orchestrate`,`/compose`,...) NO tienen `agent_id` y `cost_usdc` queda en el default `0`. | Estos eventos quedan EXCLUIDOS por el filtro `cost_usdc>0 AND agent_id NOT NULL` (CD-1 anti-sybil) — no inflan reputación. |
| `src/services/event.ts:113-194` | `eventService.stats()` ya hace agregación per-agente con un **único SELECT** (`.select('status, latency_ms, cost_usdc, agent_id, agent_name, registry')`) + reducción JS en `agentMap` (`:134-177`). Patrón anti-N+1 ya existente. | Exemplar directo para `attachReputations` batch (DT-10) y para el shape del query. |
| `src/services/discovery.ts:302-323` | Sort `verified-first → reputation desc → price asc` (`:303-309`) usa `(b.reputation ?? 0)`. Enrichment post-limit `attachIdentities(limited)` (`:316`). | Punto de inserción del enrichment de reputación + cómo el score alimenta el sort (AC-6, DT-8). |
| `src/services/discovery.ts:336-355` | `attachIdentities` — batch `Promise.all` post-limit, per-agente `try/catch` que NO rompe discover, sin RPC en serve-time. | Exemplar EXACTO para `attachReputations` (DT-10, CD-5). |
| `src/services/discovery.ts:479-535` | `getAgent(slug, registryId)` — resuelve identity por declaración + bidireccional, `try{}catch{}` graceful. | Punto de inserción del enrichment de reputación en single-agent (agent-card path). |
| `src/services/agent-card.ts:87-153` | `buildAgentCard(agent, registryConfig, baseUrl, identity?)`. Spread condicional `...(identity !== undefined && { identity })` (`:151`). | Exemplar EXACTO del spread condicional para `computedReputation` (AC-3, CD-9). |
| `src/routes/agent-card.ts:55-70` | El route resuelve `identity` ANTES de `buildAgentCard` y la pasa como arg. Graceful (`?? undefined`). | Mismo patrón: el route resuelve `computedReputation` y la pasa al builder (DT-8). |
| `src/adapters/erc8004-identity.ts:1-230` | Adapter viem read-only: ABI inline `as const` (`:51-66`), env-driven `resolveRegistryAddress` per-red + fallback global (`:73-81`), `ADDRESS_RE` (`:70`), lazy client cache `Map` (`:97-111`), `_resetErc8004Reader()` test-only (`:114-116`), `classifyReadError` revert vs transporte (`:130-133`), result tipado `{ ok, reason }` NUNCA throw al handler (`:175-226`), `getBaseChain`/`getBaseNetwork` (`:22`). | Exemplar EXACTO para `erc8004-reputation.ts` (DT-3, DT-6, CD-4/CD-5/CD-7/CD-8). |
| `src/adapters/base/chain.ts:11-47` | `getBaseNetwork()` (env `BASE_NETWORK`), `getBaseChain(network)`, chainIds 8453/84532. Warn-once misconfig. | Reuso directo en el adapter de reputación (mismas chains). |
| `src/services/identity.ts:275-311` | `resolveIdentityForAgent` selecciona SOLO columnas necesarias (`.select('erc8004_identity')` — NUNCA budget, CD-2/DT-19), default seguro `null`. | Patrón de "select mínimo" + default-null para el service de reputación (DT-5, CD-2). |
| `src/types/index.ts:118-148` | `Agent` tiene `reputation?: number` (upstream, `:125`), `identity?: AgentCardIdentity` (`:147`), `registry_id` (`:133`). `AgentCardIdentity` (`:166-170`). | Dónde agregar `computedReputation?: AgentReputation` (DT-7). |
| `src/types/index.ts:543-584` | `AgentCard` tiene `identity?: AgentCardIdentity` (`:583`) como extensión non-breaking. | Dónde agregar `computedReputation?: AgentReputation` en el card (AC-5). |
| `src/types/index.ts:622-654` | `A2AEvent`, `AgentSummary`, `DashboardStats`. | Tipos vecinos para ubicar `AgentReputation`. |
| `.env.example:456-471` | Bloque ERC-8004 existente: per-red + fallback global + `ERC8004_RPC_TIMEOUT_MS`. | Formato exacto a replicar para `ERC8004_REPUTATION_*` (AC-11, CD-4). |
| `doc/sdd/_INDEX.md:89-91` | WKH-100, WKH-101, WKH-102 = últimas 3 DONE. | Fuente del Auto-Blindaje histórico (§9). |

### Hallazgo decisivo del grounding (define la fórmula)
> El **único** evento que escribe `agent_id` + `cost_usdc>0` es `compose_step` con `status='success'` (`compose.ts:276-296`). En él, `agent_id = agent.slug`. Por lo tanto:
> 1. El score se computa **por slug** (no por `agent.id`). El service recibe el slug.
> 2. La fórmula usa SOLO los campos que existen: `status`, `cost_usdc`, `latency_ms`, `agent_id`, `created_at`.
> 3. Los eventos `request:*` y `orchestrate_goal` quedan **naturalmente excluidos** (sin `agent_id` y/o `cost_usdc=0`) → anti-sybil estructural (CD-1).

---

## 2. Decisiones Técnicas (DT)

### DT-1 — Score off-chain desde `a2a_events`, cero gas (carry-forward work-item DT-1)
Server read-only frente a ERC-8004 (CD-8). El score se computa en DB local; la lectura on-chain es additive/opcional. Determinista y reproducible.

### DT-2 — Fórmula EXACTA del score (NC-1 → opción b, 0-100 normalizado)
Definición **determinista** sobre `a2a_events`, filtrando ÚNICAMENTE:
```
WHERE agent_id = <slug>           -- agent_id REAL = agent.slug (compose.ts:278)
  AND agent_id IS NOT NULL        -- AC-9
  AND status   = 'success'        -- AC-2 / CD-1
  AND cost_usdc > 0               -- AC-2 / CD-1 (anti-sybil: solo tasks liquidadas)
```
Sobre ese conjunto se computa:
- `tasks_settled` = `COUNT(*)` de filas que cumplen el filtro (eventos liquidados).
- `total_volume_usdc` = `SUM(cost_usdc)` (auditable, informativo).
- `avg_latency_ms` = `AVG(latency_ms)` ignorando NULL (informativo, opcional en el shape).
- `success_rate` = `tasks_settled_success / total_attempts_with_cost`, donde `total_attempts_with_cost` cuenta eventos `compose_step` del slug con `cost_usdc>0` en **ambos** estados... **PROBLEMA DE GROUNDING**: el catch de compose (`compose.ts:299-307`) emite `status:'failed'` con **`costUsdc:0`**. Por ende NO existe en `a2a_events` un evento `failed` con `cost_usdc>0` para ese agente. → `success_rate` calculado sobre `cost_usdc>0` sería siempre `1.0` (degenerado).
  **Resolución (determinista, sin inventar):** `success_rate` se computa sobre el universo `compose_step` del slug **con `agent_id` no nulo** (sin el filtro `cost_usdc>0`), es decir `success_count / (success_count + failed_count)` donde failed son los `compose_step` con `status='failed'` para ese `agent_id`. Esto SÍ es señal real (un agente que falla mucho baja su `success_rate`) y NO viola CD-1 porque `success_rate` es un **modulador**, no la base del score: la base (`tasks_settled`) sigue exigiendo `cost_usdc>0`. Si el agente no tiene NINGÚN `compose_step` (ni success ni failed), `success_rate` no se computa (no hay denominador) y el score es `null` (0 tasks).
- **Score normalizado 0-100 (determinista):**
  ```
  raw   = min(tasks_settled / REPUTATION_SCALE_FACTOR, 1)   // ∈ [0,1]
  score = round( raw * 100 * success_rate )                 // ∈ [0,100], entero
  ```
  con `REPUTATION_SCALE_FACTOR` desde env `REPUTATION_SCALE_FACTOR` (default `50` — Number.parseInt, validado `>0`, fallback al default si inválido; patrón `resolveTimeoutMs`, `erc8004-identity.ts:89-93`). `success_rate` default `1` cuando hay tasks_settled pero no se pudo derivar (no debería ocurrir, pero blinda contra divide-by-zero).
- **Determinismo:** misma data → mismo score. Sin random, sin timestamp en la fórmula (solo se lee `created_at` si se agrega una ventana temporal — ver DT-2.1). Redondeo `Math.round` único.

> **DT-2.1 — Ventana temporal:** v1 NO aplica ventana (todo el historial cuenta). Documentado como TD si se quiere "reputación reciente". `created_at` queda en el índice para habilitarlo sin migración futura.

#### Shape de `computedReputation` (lo que se expone)
```ts
interface AgentReputation {
  score: number;            // 0-100 entero (DT-2)
  tasks_settled: number;    // COUNT eventos liquidados (success + cost>0)
  success_rate: number;     // 0-1, 2 decimales — modulador (DT-2)
  total_volume_usdc: number;// SUM(cost_usdc) liquidado, 6 decimales
  avg_latency_ms?: number;  // AVG(latency_ms) — OMITIDO si no hay latency (no null)
  source: 'off-chain' | 'hybrid'; // 'hybrid' solo si AC-7 incorporó on-chain
}
```

### DT-3 — Adapter on-chain OPCIONAL `erc8004-reputation.ts` (NC-2 → opción b)
Read-only, env-guarded, graceful skip. Clon estructural de `erc8004-identity.ts`:
- ABI inline `as const` con la firma del ReputationRegistry **`[VERIFY-AT-IMPL]`** (ver DT-6) — NO se inventa.
- `resolveReputationRegistryAddress(network)`: per-red (`ERC8004_REPUTATION_REGISTRY_ADDRESS_BASE_MAINNET` / `_BASE_SEPOLIA`) → fallback global (`ERC8004_REPUTATION_REGISTRY_ADDRESS`). `ADDRESS_RE` reusado. Ausente/inválida → `REGISTRY_NOT_CONFIGURED` (skip sin RPC).
- Lazy client cache propio `Map<'base-mainnet'|'base-sepolia', PublicClient>` + `_resetErc8004ReputationReader()` test-only.
- `classifyReadError` (revert → `NOT_FOUND`, transporte → `RPC_UNAVAILABLE`).
- Resultado tipado `{ ok: boolean; reason?: ...; ... }`. **NUNCA throw** al caller (CD-5/AC-8).
- Reusa `getBaseChain`/`getBaseNetwork`/`resolveRpcUrl` (mismas chains 8453/84532).

### DT-3.1 — Cómo combina on-chain con off-chain (AC-7)
v1 mantiene el score off-chain como **base canónica**. El read on-chain es **additive y no-destructivo**:
- Si el adapter NO está configurado (`REGISTRY_NOT_CONFIGURED`) o falla (`RPC_UNAVAILABLE`): `computedReputation.source = 'off-chain'`, **sin** campos on-chain (omitidos). AC-8 graceful.
- Si responde OK: se agrega `source = 'hybrid'` + un sub-campo `onchain` con el valor crudo verificado (shape `[VERIFY-AT-IMPL]`). **El `score` 0-100 NO se altera** en v1 (no se mezcla on-chain en la fórmula hasta confirmar la semántica del valor on-chain). Esto evita inventar una combinación numérica sobre un contrato no verificado.
- **Crítico:** el read on-chain NO ocurre en el hot-path de `/discover` (AC-1: "sin llamadas RPC on-chain en el hot-path"). Se ejecuta SOLO en el path single-agent del AgentCard, y SOLO si la env está configurada. En `/discover` (batch), `source` siempre `'off-chain'`. Ver DT-8.

### DT-4 — Cache Redis del score (carry-forward work-item DT-4)
`reputationService` cachea por slug con TTL `REPUTATION_CACHE_TTL_MS` (default 60000, Number.parseInt validado). Si Redis no disponible → skip cache, compute directo (graceful). Key namespaced: `reputation:v1:<slug>`. **Cache solo del score off-chain** (determinista); el read on-chain NO se cachea en v1 (additive, single-agent, bajo volumen).

### DT-5 — Separación de concerns (carry-forward work-item DT-5)
`reputationService` lee SOLO `a2a_events`. NO importa `budgetService`/`delegationService`. NUNCA toca `a2a_agent_keys` ni columnas `budget`/`funding_wallet`/`daily_*` (CD-2). Select mínimo (patrón `identity.ts:283`).

### DT-6 — Interfaz del ReputationRegistry = `[VERIFY-AT-IMPL]` (NC-2 / work-item DT-6)
La firma exacta (`getReputation(address)→uint256`, `reputationOf(uint256)`, `getSummary(...)`, u otra) **NO se asume**. El Dev DEBE verificar en https://github.com/erc-8004/erc-8004-contracts (commit/tag a citar en el JSDoc del adapter, igual que `erc8004-identity.ts:48-50`) ANTES de implementar el ABI. Si el contrato no está confirmado/desplegado: el adapter se implementa con el env guard + graceful skip y un ABI marcado `[VERIFY-AT-IMPL]`, y los tests usan mock del reader (NO RPC real). El env guard hace que la feature esté **inactiva por default** (sin var → skip), por lo que NO bloquea si el contrato no existe aún.

### DT-7 — Campo NUEVO `computedReputation`, NO pisar `reputation` upstream (NC-1)
- `Agent.computedReputation?: AgentReputation` (nuevo, **opcional** → no rompe los 24+ fixtures que construyen `Agent`; ver Auto-Blindaje WKH-100 §FIX-PACK v3: campo opcional = blast-radius cero en tsc).
- `AgentCard.computedReputation?: AgentReputation` (nuevo, opcional, extensión non-breaking igual que `identity?`).
- `Agent.reputation?: number` (upstream) se **conserva intacto**.

### DT-8 — Enrichment + ordenamiento (NC-3 / AC-1 / AC-6)
- **`/discover` (batch):** nuevo `attachReputations(agents: Agent[])` post-limit (gemelo de `attachIdentities`, `discovery.ts:336`), invocado tras `attachIdentities` en `discover()` (`discovery.ts:316`). **Solo off-chain** (sin RPC en hot-path, AC-1). Computa el batch eficientemente (DT-10).
- **Sort (AC-6):** se mantiene `verified-first → reputation desc → price asc`. El sort usa el score computado **cuando esté disponible**, con fallback al `reputation` upstream:
  `repValue(a) = a.computedReputation?.score ?? a.reputation ?? 0`.
  **Orden de operaciones:** el sort vive en `discovery.ts:303-309` y corre ANTES del `slice(limit)` (`:312`); pero `attachReputations` corre POST-limit (`:316`). → Para que el sort use el score, el batch-compute del score debe ocurrir **antes del sort** (sobre `allAgents`), no post-limit. **Decisión:** se computa el score en batch **antes del sort** (sobre `allAgents` ya filtrados, pre-limit), pero el cómputo es un único query agregado (DT-10), no N queries → sigue cumpliendo AC-1 (sin RPC, un solo round-trip). El enrichment de `identity` se mantiene post-limit (no afecta sort). El read on-chain (si aplicara) NUNCA va acá.
  > Trade-off documentado: computar score pre-sort sobre `allAgents` (no solo la página) es 1 query agregado sobre el set filtrado; con índice (DT-9) es indexable y barato. Alternativa rechazada: sort solo por upstream + re-sort post-enrich (rompería el contrato "page = top-N por reputación real").
- **AgentCard (single):** el route `agent-card.ts` resuelve `computedReputation` (off-chain + on-chain opcional si env) ANTES de `buildAgentCard` y la pasa como nuevo arg (gemelo de `identity`, `agent-card.ts:55-70`).
- **`buildAgentCard`:** spread condicional `...(computedReputation !== undefined && { computedReputation })` (gemelo de `:151`).
- **NO endpoint dedicado** (NC-3). No se agrega `GET /auth/reputation`.

### DT-9 — Índice DB para el GROUP BY del score (migration nueva)
Los índices existentes (`idx_a2a_events_agent` solo `agent_id`, `idx_a2a_events_status` solo `status`) no cubren el filtro compuesto. Nueva migration `supabase/migrations/<ts>_reputation_index.sql`:
```sql
-- Covering-ish index para el score: filtro (agent_id, status) + cost_usdc>0,
-- agregando latency/cost/created_at para evitar heap-fetch en el aggregate.
CREATE INDEX IF NOT EXISTS idx_a2a_events_reputation
  ON a2a_events (agent_id, status)
  INCLUDE (cost_usdc, latency_ms, created_at)
  WHERE agent_id IS NOT NULL;
```
> `INCLUDE` requiere PG 11+ (Supabase ✓). El `WHERE agent_id IS NOT NULL` lo hace parcial (excluye los eventos `request:*`/`orchestrate_goal` sin agente → índice más chico). Idempotente (`IF NOT EXISTS`). Sin `DROP`. Pre-flight runbook WKH-78 aplica al deploy.

### DT-10 — Agregación eficiente anti-N+1 (lección WKH-100)
- **Batch (`attachReputations`):** UN solo SELECT para toda la página, NO N queries. Patrón directo de `eventService.stats()` (`event.ts:113-194`):
  ```
  SELECT agent_id, status, cost_usdc, latency_ms
    FROM a2a_events
   WHERE agent_id = ANY($slugs)   -- los slugs de la página
     AND agent_id IS NOT NULL
  ```
  (Supabase: `.in('agent_id', slugs)`.) Reducción a `Map<slug, accumulator>` en JS (igual `agentMap`), luego se computa el score por slug. **1 round-trip por página**, no por agente. El índice DT-9 lo hace indexable.
- **Single (`computeReputationForAgent`):** 1 query por slug (`.eq('agent_id', slug)`), con cache Redis (DT-4). Usado por el path AgentCard.
- **Anti-N+1 (CD-AR/CR):** PROHIBIDO un loop que haga 1 query por agente en discover. El batch DEBE ser un único query con `IN`.

### DT-11 — Backward-compat / graceful (CD-5, CD-9)
- 0 tasks → `computeReputationForAgent` retorna `null` → campo `computedReputation` **omitido** (no null, no undefined explícito) vía spread condicional (AC-3).
- Error DB/timeout en el compute → `try/catch` per-agente → agente sin el campo, NUNCA rompe discover/agent-card (AC-4). Patrón `attachIdentities` (`discovery.ts:349-351`).
- Error RPC on-chain → `source='off-chain'`, sin campo on-chain (AC-8). NUNCA 5xx.

---

## 3. Constraint Directives (CD)

Heredados del work-item (CD-1..CD-9) + nuevos del SDD (CD-10..CD-13).

| CD | Directiva |
|----|-----------|
| **CD-1** | PROHIBIDO usar auto-reportes, votos, eventos sin `cost_usdc>0`, o cualquier fuente que no sean `a2a_events` con `status='success' AND cost_usdc>0 AND agent_id NOT NULL`. (work-item CD-1 / AC-2 / AC-9) |
| **CD-2** | PROHIBIDO tocar `budget`/`funding_wallet`/`daily_spent_usd`/`daily_limit_usd` de `a2a_agent_keys` en cualquier código de reputación. Reputación desacoplada de pagos. |
| **CD-3** | OBLIGATORIO Ownership Guard `.eq('id', keyId).eq('owner_ref', ownerId)` SI algún código tocara `a2a_agent_keys` por id. (No aplica en v1: NO se toca esa tabla — ver §7.) |
| **CD-4** | PROHIBIDO hardcodear direcciones del ReputationRegistry. OBLIGATORIO env per-red + fallback global (patrón `erc8004-identity.ts:73-81`). (AC-11) |
| **CD-5** | OBLIGATORIO degradación graceful en TODO path de enrichment: error DB/RPC → campo omitido, NUNCA 5xx. (AC-4/AC-8) |
| **CD-6** | PROHIBIDO `any` explícito / `as unknown` en prod. TS strict. |
| **CD-7** | PROHIBIDO ethers.js. viem v2 para todo read on-chain. |
| **CD-8** | PROHIBIDO escritura on-chain (WalletClient, writeContract, privateKeyToAccount). Server read-only frente a ERC-8004. |
| **CD-9** | OBLIGATORIO backward-compat: agente sin score → campo `computedReputation` OMITIDO (spread condicional), nunca `null`/`undefined` explícito. (AC-3) |
| **CD-10** *(nuevo)* | PROHIBIDO pisar/escribir `Agent.reputation` (upstream del registry). El score propio vive SOLO en `computedReputation`. El sort puede LEER `reputation` como fallback pero NUNCA reasignarlo. (NC-1) |
| **CD-11** *(nuevo)* | PROHIBIDO agregar endpoint dedicado de reputación (`GET /auth/reputation`, etc.). Surfacing SOLO en `/discover` + AgentCard. (NC-3) |
| **CD-12** *(nuevo, anti-N+1 — Auto-Blindaje carry)* | PROHIBIDO en discover hacer 1 query por agente. El batch DEBE ser UN único SELECT con `IN(slugs)`. (DT-10) |
| **CD-13** *(nuevo, hot-path)* | PROHIBIDO RPC on-chain en el hot-path de `/discover` (AC-1). El read on-chain solo en AgentCard single-agent y solo si env configurada. |

### Auto-Blindaje carry-forward (ver §9 para detalle):
| CD | Origen | Directiva |
|----|--------|-----------|
| **CD-14** | WKH-100 §FIX-PACK v3 | El campo nuevo en `Agent`/`AgentCard` DEBE ser **opcional** (`computedReputation?`). Un campo requerido rompería 24+ fixtures en 9 files. Si por algún motivo se hace requerido, correr `tsc --noEmit` (no solo el build) y presupuestar la actualización de TODOS los fixtures. |
| **CD-15** | WKH-100 §Wave4/FIX-PACK BLQ-MED-1 | Antes de agregar/consumir un export nuevo (`reputationService`, `extractReputation`, `getErc8004ReputationReader`), grep `vi.mock('<modulo>'` en TODO el repo y reflejar el nuevo export en TODOS los factory-mocks que reemplazan ese módulo (rompen en runtime, no en tsc). Aplica a tests de `discovery`, `agent-card` (route+service), `event`. |
| **CD-16** | WKH-101 §W4 / WKH-101 carry | Al agregar un arg nuevo a `buildAgentCard` (`computedReputation?`), revisar TODAS las aserciones `toHaveBeenCalledWith` y construcciones del card en tests (`agent-card.test.ts` route+service). Arg opcional `undefined` rompe matches exactos. |
| **CD-17** | WKH-101 §W5 / WKH-102 | Correr `biome check --write` (o `npm run format`) en CADA archivo nuevo/tocado ANTES de `npm run lint`. organizeImports incluido. |
| **CD-18** | WKH-101 §AR fix-pack | PROHIBIDO propagar `error.message` crudo de Supabase/PG al body del cliente. Errores del compute → log server-side + campo omitido (graceful), nunca el mensaje raw. |

---

## 4. Waves de implementación

> **W0 es serial** (tipos + migration + env = contrato). W1+ paralelizables. Tests al final de cada wave.

### W0 — Contratos (serial, primero)
| Archivo | Acción |
|---------|--------|
| `src/types/index.ts` | NUEVO `AgentReputation` (shape DT-2); `Agent.computedReputation?: AgentReputation`; `AgentCard.computedReputation?: AgentReputation`. **Opcionales** (CD-14). |
| `supabase/migrations/<ts>_reputation_index.sql` | NUEVO índice parcial `idx_a2a_events_reputation` (DT-9). Idempotente. |
| `.env.example` | NUEVO bloque ERC-8004 ReputationRegistry (`ERC8004_REPUTATION_REGISTRY_ADDRESS_BASE_MAINNET/_BASE_SEPOLIA/` + global) + `REPUTATION_SCALE_FACTOR=50` + `REPUTATION_CACHE_TTL_MS=60000`. Formato `.env.example:456-471`. |
| `tsc --noEmit` | Gate W0: 0 errores tras tipos (CD-14). |

### W1 — Service de cómputo off-chain (núcleo)
| Archivo | Acción |
|---------|--------|
| `src/services/reputation.ts` | NUEVO. `computeReputationForAgent(slug): Promise<AgentReputation|null>` (1 query + cache Redis DT-4); `computeReputationBatch(slugs: string[]): Promise<Map<string, AgentReputation>>` (1 query `IN`, DT-10). Fórmula DT-2. Lee SOLO `a2a_events` (CD-1/CD-2/DT-5). `_resetReputationCache()` test-only. |
| Tests | `src/services/reputation.test.ts` — ver §6. |

### W2 — Enrichment en discovery + AgentCard
| Archivo | Acción |
|---------|--------|
| `src/services/discovery.ts` | NUEVO `attachReputations(agents)` (batch, gemelo `attachIdentities`). Computar score batch ANTES del sort (DT-8); sort usa `computedReputation?.score ?? reputation ?? 0`. Single-agent: enriquecer en `getAgent` (graceful). |
| `src/services/agent-card.ts` | `buildAgentCard(...)` nuevo arg `computedReputation?` + spread condicional (gemelo `:151`). |
| `src/routes/agent-card.ts` | Resolver `computedReputation` antes de `buildAgentCard` (off-chain; on-chain opcional W3). |
| Tests | `discovery.test.ts`, `agent-card.test.ts` (service+route) — mocks (CD-15/CD-16). |

### W3 — Adapter on-chain OPCIONAL (NC-2, env-guarded)
| Archivo | Acción |
|---------|--------|
| `src/adapters/erc8004-reputation.ts` | NUEVO. Reader viem read-only env-guarded (DT-3/DT-6). ABI `[VERIFY-AT-IMPL]` (citar commit/tag del repo oficial). Resultado tipado, nunca throw. `_resetErc8004ReputationReader()`. |
| `src/routes/agent-card.ts` | Si env configurada → enriquecer `source='hybrid'` + `onchain` (additive, no altera score). Graceful (AC-8). |
| Tests | `src/adapters/erc8004-reputation.test.ts` — mock del reader (no RPC real). |

### W4 — Tests de integración + cierre
| Archivo | Acción |
|---------|--------|
| `discovery.test.ts` / e2e | N agentes sin N+1; sort con score; backward-compat. |
| `tsc --noEmit` + `biome check --write` + suite verde | Gate final (CD-17). |

> W3 puede ir en paralelo con W2 una vez W1 cerrado (no comparten archivos salvo `agent-card.ts` route — coordinar o secuenciar route).

---

## 5. Exemplars verificados (Glob/Read confirmados)

| Exemplar | Path | Verificado |
|----------|------|-----------|
| Adapter viem read-only env-guarded | `src/adapters/erc8004-identity.ts` | ✓ Read (230 líneas) |
| Enrichment batch post-limit graceful | `src/services/discovery.ts:336-355` | ✓ Read |
| Agregación per-agente single-query | `src/services/event.ts:113-194` | ✓ Read |
| Spread condicional en card | `src/services/agent-card.ts:151` | ✓ Read |
| Route resuelve enrichment antes de build | `src/routes/agent-card.ts:55-70` | ✓ Read |
| Select mínimo + default null | `src/services/identity.ts:275-311` | ✓ Read |
| Base chain helpers | `src/adapters/base/chain.ts` | ✓ Read |
| Bloque env ERC-8004 | `.env.example:456-471` | ✓ Read |
| Schema `a2a_events` | `supabase/migrations/20260404200000_events.sql` | ✓ Read |
| Fuente real del evento (compose_step) | `src/services/compose.ts:276-310` | ✓ Read |
| Tests co-locados | `src/services/discovery.test.ts`, `src/adapters/erc8004-identity.test.ts`, `src/services/agent-card.test.ts`, `src/routes/agent-card.test.ts` | ✓ Glob confirmados |

> NO se referencia ningún path/función/firma del ReputationRegistry on-chain: queda `[VERIFY-AT-IMPL]` (DT-6).

---

## 6. Plan de Tests (≥1 por AC — 11 ACs — + casos del orquestador)

`reputation.test.ts` mockea `supabase` (patrón `identity.test.ts`/`event` mock). `discovery.test.ts`/`agent-card.test.ts` mockean `reputationService` (CD-15). `erc8004-reputation.test.ts` mockea el reader (CD-15).

| # | Test | Cubre |
|---|------|-------|
| T-AC1 | `/discover` y agent-card enriquecen `computedReputation` desde `a2a_events`, sin RPC on-chain en el batch | AC-1, CD-13 |
| T-AC2 | Score deriva SOLO de `status='success' AND cost_usdc>0`; un evento success con `cost_usdc=0` NO suma | AC-2, CD-1 |
| T-AC3 | Agente con 0 eventos → `computedReputation` OMITIDO en el card (no null, no key) | AC-3, CD-9, CD-14 |
| T-AC4 | `supabase` lanza/timeout en compute → discover/agent-card responde sin el campo, sin 5xx | AC-4, CD-5, CD-18 |
| T-AC5 | Score>0 → card expone `computedReputation.{score(0-100), tasks_settled, success_rate, total_volume_usdc}` | AC-5, DT-2 |
| T-AC6 | Sort: verified-first, luego score desc (usando `computedReputation.score`), luego price asc; fallback a `reputation` upstream cuando no hay score | AC-6, DT-8, CD-10 |
| T-AC7-on | env `ERC8004_REPUTATION_REGISTRY_ADDRESS_*` set + reader mock OK → `source='hybrid'` + `onchain` presente (agent-card single) | AC-7, DT-3.1 |
| T-AC7-off | env ausente → `source='off-chain'`, sin campo on-chain, sin error | AC-7, AC-8, DT-3.1, CD-13 |
| T-AC8 | reader on-chain falla (`RPC_UNAVAILABLE`) → score off-chain devuelto, sin on-chain, sin 5xx | AC-8, CD-5 |
| T-AC9 | Eventos con `agent_id=NULL` o `event_type='request:*'`/`orchestrate_goal` (sin agent_id) NO cuentan | AC-9, CD-1 |
| T-AC10 | (N/A en v1: no se toca `a2a_agent_keys`) — test-guard: el service NO importa `budgetService` ni hace `.from('a2a_agent_keys')` | AC-10, CD-2/CD-3 |
| T-AC11 | Dirección on-chain leída SOLO de env per-red/global; ninguna address hardcodeada (grep + test env-driven) | AC-11, CD-4 |
| T-FORMULA | Determinismo: misma data → mismo score; `REPUTATION_SCALE_FACTOR` desde env cambia el score; `score` clampa a 100 | DT-2 |
| T-ANTI-SYBIL | Solo-fallidos (todos `compose_step` `status='failed'`) → `tasks_settled=0` → score null; auto-reporte (`request:*`) no infla | AC-2/AC-9, CD-1 |
| T-SUCCESS-RATE | Agente con success+failed → `success_rate<1` modula el score hacia abajo | DT-2 |
| T-NO-N+1 | `attachReputations` con N agentes hace EXACTAMENTE 1 query (`supabase.from` llamado 1 vez con `.in`) | DT-10, CD-12 |
| T-BATCH-PAGE | El batch query usa `IN(slugs)` con SOLO los slugs de la página/set, no full-scan | DT-10 |
| T-BACKWARD | Card de un agente legacy (sin reputación) tiene shape EXACTO previo (snapshot sin la key) | CD-9, AC-3 |
| T-CACHE | 2ª llamada a `computeReputationForAgent` mismo slug dentro de TTL → 0 queries adicionales (cache hit); Redis caído → compute directo sin throw | DT-4 |
| T-VERIFY-IMPL | `erc8004-reputation.test.ts` documenta el `[VERIFY-AT-IMPL]` y mockea el reader; NO golpea RPC real | DT-6 |

---

## 7. CD Coverage Map

| CD | Cubierto por |
|----|--------------|
| CD-1 | DT-2 (filtro), T-AC2, T-AC9, T-ANTI-SYBIL |
| CD-2 | DT-5, T-AC10 (test-guard no-import) |
| CD-3 | N/A v1 (NO se toca `a2a_agent_keys`) — confirmado: el service lee SOLO `a2a_events` |
| CD-4 | DT-3, T-AC11, T-AC7-off |
| CD-5 | DT-11, T-AC4, T-AC8 |
| CD-6 | TS strict, tipos en W0 |
| CD-7 | viem en adapter (DT-3), reuso `erc8004-identity` |
| CD-8 | DT-3 read-only, T-VERIFY-IMPL (sin WalletClient) |
| CD-9 | spread condicional (DT-7/DT-11), T-AC3, T-BACKWARD |
| CD-10 | DT-8 sort lee/no-escribe `reputation`, T-AC6 |
| CD-11 | DT-8 (sin endpoint), revisión de Scope IN |
| CD-12 | DT-10, T-NO-N+1, T-BATCH-PAGE |
| CD-13 | DT-3.1/DT-8, T-AC1, T-AC7-off |
| CD-14 | DT-7 (opcional), W0 gate tsc, T-AC3 |
| CD-15 | §4 mocks, T-AC1/T-AC6 (mock factory updates) |
| CD-16 | W2 (arg `buildAgentCard`), T-AC5 |
| CD-17 | W4 gate biome |
| CD-18 | DT-11, T-AC4 |

---

## 8. Archivos: nuevos vs modificados

**Nuevos (5):**
- `src/services/reputation.ts`
- `src/adapters/erc8004-reputation.ts` (W3, opcional)
- `supabase/migrations/<ts>_reputation_index.sql`
- `src/services/reputation.test.ts`
- `src/adapters/erc8004-reputation.test.ts`

**Modificados (5):**
- `src/types/index.ts` (`AgentReputation`, `Agent.computedReputation?`, `AgentCard.computedReputation?`)
- `src/services/discovery.ts` (`attachReputations`, sort, `getAgent`)
- `src/services/agent-card.ts` (`buildAgentCard` arg + spread)
- `src/routes/agent-card.ts` (resolver reputation pre-build)
- `.env.example` (bloque ReputationRegistry + scale + TTL)

**Tests tocados (mocks — CD-15/CD-16):** `src/services/discovery.test.ts`, `src/services/agent-card.test.ts`, `src/routes/agent-card.test.ts`.

---

## 9. Auto-Blindaje histórico aplicado (últimas 3 DONE: WKH-100/101/102)

| Lección | HU#auto-blindaje | Bakeado en |
|---------|------------------|-----------|
| Campo REQUERIDO nuevo en `Agent` rompe 24 fixtures/9 files; usar opcional + `tsc --noEmit` | WKH-100 §FIX-PACK v3 | **CD-14**, DT-7 |
| Export nuevo consumido por código bajo test rompe factory-mocks silenciosamente (runtime, no tsc); grep `vi.mock('<modulo>'` | WKH-100 §Wave4 + §FIX-PACK BLQ-MED-1 | **CD-15** |
| Mockear N queries a supabase con `mockImplementation`+contador, no `mockReturnValueOnce` encadenado; cast `as unknown as` | WKH-100 §FIX-PACK BLQ-MED-1 | §6 (reputation.test.ts hace ≥1 query) |
| Arg opcional nuevo en fn mockeada rompe `toHaveBeenCalledWith` exactos | WKH-101 §W4 | **CD-16** |
| `biome check --write` antes de `npm run lint` en cada archivo nuevo | WKH-101 §W5 + WKH-102 | **CD-17** |
| Nunca propagar `error.message` crudo de PG/Supabase al body | WKH-101 §AR fix-pack | **CD-18** |
| `[VERIFY-AT-IMPL]` confirmado leyendo el repo/types reales antes de tipar (no inventar firma) | WKH-101 §W1 (viem EIP-712) | **DT-6** |

> **Patrón recurrente (≥2 HUs):** modificar un tipo compartido / agregar export → rompe fixtures/mocks fuera del in-scope literal, solo visible en runtime o `tsc --noEmit`. → CD-14 + CD-15 + CD-16 lo previenen explícitamente.

---

## 10. [NEEDS CLARIFICATION] — estado

**NINGUNO pendiente.** Los 3 NC del work-item fueron resueltos por el humano y bakeados (§0). Los `[NEEDS CLARIFICATION]` que el work-item dejaba abiertos (DT-2 métrica, DT-3 on/off, DT-7 shape, AC-5 rango, AC-7 ON/OFF) están todos cerrados:
- AC-5 rango → **0-100** (NC-1).
- AC-7 ON/OFF → **ON con env guard, off-chain base + on-chain additive** (NC-2).
- DT-7 shape → **`computedReputation` nuevo, no pisar upstream** (NC-1).

El único `[VERIFY-AT-IMPL]` restante (interfaz del ReputationRegistry, DT-6) NO es un NEEDS CLARIFICATION del SDD: es una verificación que el Dev hace en F3 contra el repo oficial, con env guard + graceful skip que hace la feature inactiva por default si no se confirma. NO bloquea SPEC_APPROVED.

---

## 11. Readiness Check

| Ítem | Estado |
|------|--------|
| Todos los exemplars verificados con Read/Glob (paths reales) | ✅ §5 |
| Campos REALES de `a2a_events` confirmados (no inventados) | ✅ `agent_id`,`status`,`cost_usdc`,`latency_ms`,`created_at` (`events.sql:6-32`) |
| Fuente del score groundeada (`compose_step`, `agent_id`=slug) | ✅ `compose.ts:276-296` |
| Fórmula determinista + 0-tasks definido | ✅ DT-2 (score null si 0 tasks) |
| Anti-N+1 diseñado (1 query batch con `IN`) + índice | ✅ DT-9, DT-10, CD-12 |
| Adapter on-chain env-guarded + graceful + `[VERIFY-AT-IMPL]` | ✅ DT-3, DT-6, CD-13 |
| Sort preserva contrato actual usando score | ✅ DT-8, T-AC6 |
| Backward-compat (campo opcional + spread condicional) | ✅ DT-7, CD-9, CD-14 |
| ≥1 test por AC (11) + casos del orquestador | ✅ §6 (21 tests) |
| CD coverage completo | ✅ §7 |
| Auto-Blindaje histórico aplicado | ✅ §9 |
| `[NEEDS CLARIFICATION]` pendientes | ✅ Ninguno |
| 3 decisiones del humano bakeadas | ✅ §0 |

**Veredicto: READY para SPEC_APPROVED.**

### Observaciones para el clinical review
1. **DT-2 `success_rate`**: el grounding reveló que NO existe en `a2a_events` un evento `failed` con `cost_usdc>0` (el catch de compose emite `cost_usdc:0`). Por eso `success_rate` se computa sobre el universo `compose_step` del slug (success+failed por `agent_id`, sin el filtro de costo), usado SOLO como modulador. La BASE del score (`tasks_settled`) sí exige `cost_usdc>0` (CD-1 intacto). Confirmar que este modulador es aceptable; alternativa: omitir `success_rate` del score y exponerlo solo informativo.
2. **DT-8 sort pre-limit**: para que el sort use el score, el batch-compute corre sobre `allAgents` (set filtrado pre-limit), no solo la página. Es 1 query agregado indexable (no N+1), pero sobre un set potencialmente mayor que `limit`. Aceptado como trade-off para mantener "page = top-N por reputación real".
3. **DT-6**: la interfaz del ReputationRegistry queda `[VERIFY-AT-IMPL]`. Si el contrato oficial no expone una firma read-only simple, W3 puede quedar como adapter-stub env-guarded (inactivo) sin afectar el core off-chain (W1/W2).
