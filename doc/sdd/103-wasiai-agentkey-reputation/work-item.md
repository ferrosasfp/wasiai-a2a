# Work Item — [WKH-103] wasiai-agentkey Fase 3: Reputación ERC-8004

## Resumen

Cierra la tríada ERC-8004 para wasiai-agentkey: **Identity (WKH-100, DONE) → Delegation (WKH-101, DONE) → Reputation**. Se computa un score de reputación para agentes a partir de las `a2a_events` ya emitidas (tasks liquidadas verificables, anti-sybil) y se surfacea en `/discover` y en el AgentCard — sin gas, sin escritura on-chain en esta fase (off-chain computed). Adicionalmente, se lee el `ReputationRegistry` ERC-8004 on-chain para enriquecer el score con attestations ajenas (read-only). Validation Registry queda OUT (Fase 4).

## Sizing

- **SDD_MODE:** full
- **Estimación:** M (1-2 semanas, 4-6 waves)
- **Smart Sizing:** QUALITY — toca tipos compartidos, dos caminos de enriquecimiento (off-chain compute + on-chain read), integración con el pipeline de discovery ya hardened, y superficie ERC-8004 nueva
- **Branch sugerido:** `feat/103-wasiai-agentkey-reputation`

## Skills Router

- `blockchain/evm-read` — viem read-only vs ReputationRegistry on-chain (lectura eventos, score)
- `data/aggregation` — compute off-chain score de `a2a_events` por `agent_id`

---

## Grounding (archivo:línea)

| Componente | Archivo | Referencia |
|---|---|---|
| Tabla `a2a_events` | `supabase/migrations/20260404200000_events.sql:6-32` | Columnas: `agent_id`, `status`, `cost_usdc`, `latency_ms`, `created_at` — fuente de score |
| Service `eventService.track()` | `src/services/event.ts:52-85` | Emite eventos en `/discover`, `/orchestrate`, `/compose`, `/auth/agent-signup`, `/gasless/status` |
| Middleware tracking | `src/middleware/event-tracking.ts:14-19` | Prefijos trackeados: `/discover`, `/orchestrate`, `/compose`, `/auth/agent-signup`, `/gasless/status` |
| `Agent.reputation` campo existente | `src/types/index.ts:125` | `reputation?: number` — ya existe en el tipo `Agent` (pasado como raw del registry upstream) |
| Sort por reputation | `src/services/discovery.ts:303-309` | `(b.reputation ?? 0) - (a.reputation ?? 0)` — ya se usa en ordenamiento de `/discover` |
| `Agent.identity` campo existente | `src/types/index.ts:147` | `identity?: AgentCardIdentity` — patrón a replicar para `reputation` enrichment |
| `attachIdentities()` en discovery | `src/services/discovery.ts:336-355` | Patrón de enriquecimiento post-limit; replicar con `attachReputations()` |
| `buildAgentCard()` con identity | `src/services/agent-card.ts:87-153` | Spread condicional `...(identity !== undefined && { identity })` — mismo patrón para reputation |
| ERC-8004 reader (viem) | `src/adapters/erc8004-identity.ts:1-230` | Lazy client cache, env-driven, CD-13/CD-14 — patrón a seguir para ReputationRegistry reader |
| Ownership Guard obligatorio | `CLAUDE.md:Security Conventions` | Todo query sobre `a2a_agent_keys` debe incluir `.eq('owner_ref', ...)` — aplica si la HU lee esa tabla |
| `identityService.resolveIdentityForAgent()` | `src/services/identity.ts:275-311` | Selecciona SOLO columnas necesarias (CD-2: NUNCA budget) — patrón a replicar |
| `ERC8004_ALLOWED_CHAINS` | `src/services/discovery.ts:116` | Base mainnet 8453 + sepolia 84532 — chains permitidos para ERC-8004; ReputationRegistry puede ser cross-chain |

---

## Acceptance Criteria (EARS)

### Core: score off-chain computado

**AC-1** — WHEN `GET /agents/:id/agent-card` o `POST /discover` es invocado, the system SHALL enriquecer el campo `reputation` del `Agent` con el score calculado desde `a2a_events` (columnas `status`, `cost_usdc`, `latency_ms`, `agent_id`) en la base de datos local, sin llamadas RPC on-chain en el hot-path de discovery.

**AC-2** — WHILE el score de reputación es calculado, the system SHALL derivarlo ÚNICAMENTE de eventos de `a2a_events` cuyo `status = 'success'` Y `cost_usdc > 0` (tasks liquidadas verificables), NUNCA de auto-reportes o eventos sin costo registrado (anti-sybil, CD-1).

**AC-3** — WHEN un agente no tiene entradas en `a2a_events` (score cero o sin historial), the system SHALL omitir el campo `reputation` en el AgentCard y retornar el agente sin ese campo (backward-compatible, no null), igual que el patrón `identity` en `src/services/agent-card.ts:149-152`.

**AC-4** — IF el cómputo del score de reputación falla (error DB, timeout), THEN the system SHALL continuar el discovery/agent-card sin ese campo (degradación graceful), NUNCA propagar la excepción al caller ni bloquear la respuesta.

### Surfacing en AgentCard y discovery

**AC-5** — WHEN el score de reputación es positivo (> 0), the system SHALL surfacearlo en el AgentCard bajo una clave `reputation` con al menos los sub-campos: `score` (número normalizado `[NEEDS CLARIFICATION: rango 0-1 vs 0-100 vs raw count]`), `tasks_settled` (count de eventos liquidados), y opcionalmente `avg_latency_ms`.

**AC-6** — WHEN `POST /discover` retorna la lista de agentes, the system SHALL mantener el ordenamiento actual (verified-first, luego reputation desc, luego price asc) — `src/services/discovery.ts:303-309` — usando el score calculado en AC-1/AC-2 cuando esté disponible, fallando al valor previo del campo `reputation` upstream cuando no.

### Lectura on-chain ReputationRegistry (read-only, opcional)

**AC-7** — `[NEEDS CLARIFICATION: ON/OFF]` WHERE la env var `ERC8004_REPUTATION_REGISTRY_ADDRESS` está configurada, the system SHALL leer attestations del `ReputationRegistry` ERC-8004 vía viem read-only (mismas cadenas Base mainnet 8453 + sepolia 84532), y opcionalmente incorporarlas al score surfaceado. Si la var NO está configurada, el campo on-chain se omite sin error.

**AC-8** — IF el RPC del ReputationRegistry no responde o falla, THEN the system SHALL retornar el score off-chain computado sin campo on-chain, NUNCA retornar error 5xx al caller (degradación graceful igual que `src/adapters/erc8004-identity.ts:130-133`).

### Constraint: anti-sybil y ownership

**AC-9** — the system SHALL computar el score de reputación SOLO basado en `a2a_events` con `agent_id` no nulo, trazables a invocaciones reales del sistema (CD-1). PROHIBIDO usar eventos de tipo `request:*` sin `cost_usdc > 0` como señal de reputación.

**AC-10** — IF algún endpoint de reputación (si se agrega GET /auth/reputation o similar) toca `a2a_agent_keys`, THEN the system SHALL aplicar Ownership Guard completo (`.eq('id', keyId).eq('owner_ref', ownerId)`) conforme a `CLAUDE.md:Security Conventions` (CD-3).

### Vars de entorno y sin hardcodes

**AC-11** — the system SHALL leer la dirección del `ReputationRegistry` ERC-8004 exclusivamente desde variables de entorno (p.ej. `ERC8004_REPUTATION_REGISTRY_ADDRESS_BASE_MAINNET`, `ERC8004_REPUTATION_REGISTRY_ADDRESS_BASE_SEPOLIA`), sin hardcodear ninguna dirección de contrato en el código (CD-4).

---

## Scope IN

- `src/services/reputation.ts` (nuevo) — service que computa el score desde `a2a_events`, con método `computeReputationForAgent(agentId: string): Promise<ReputationScore | null>` y cache opcional en Redis
- `src/adapters/erc8004-reputation.ts` (nuevo) — viem reader para ReputationRegistry on-chain (read-only, mismo patrón que `erc8004-identity.ts`) — SOLO si AC-7 se activa
- `src/services/discovery.ts` — `attachReputations()` post-limit (patrón `attachIdentities`, línea 336)
- `src/services/agent-card.ts` — spread condicional `...(reputation !== undefined && { reputation })` en `buildAgentCard()`
- `src/types/index.ts` — tipo `AgentReputation` (score, tasks_settled, avg_latency_ms, fuente: 'off-chain' | 'hybrid')
- `.env.example` — documentar vars `ERC8004_REPUTATION_REGISTRY_ADDRESS_*`
- `supabase/migrations/YYYYMMDD_reputation_index.sql` (nuevo) — índice sobre `a2a_events(agent_id, status, cost_usdc)` para acelerar el compute
- Tests unitarios + e2e del servicio reputation y del enriquecimiento en discovery

## Scope OUT

- **Validation Registry ERC-8004** — explícitamente fuera; Fase 4 / HU futura
- **Escritura on-chain al ReputationRegistry** (write/attest) — fuera en esta fase; requiere gas + custody. Si el humano lo decide, se convierte en Fase 3b o HU separada [NEEDS CLARIFICATION]
- **Sistema de votación / peer review / feedback arbitrario** — fuera; reputación SOLO de tasks verificables (CD-1)
- **UI/dashboard update** — fuera; el score se surfacea via API (AgentCard, /discover); dashboard puede consumirlo luego
- **RLS Postgres en `a2a_events`** — fuera; tracked en WKH-SEC-02

---

## Decisiones técnicas (DT)

**DT-1:** Score computado off-chain desde `a2a_events`, no on-chain. Motivo: el servidor ya es read-only en ERC-8004 (CD-8 de WKH-100); escribir al ReputationRegistry requeriría WalletClient + gas + custodia del operator, ampliando la superficie de ataque y contradiciendo el "server read-only" establecido en Fase 1. Off-chain computed es cero gas, determinista, auditablemente reproducible. La lectura de attestations on-chain es additive/opcional.

**DT-2: `[NEEDS CLARIFICATION]` — Métrica exacta del score.** Opciones:
  - (a) `tasks_settled` count puro (count de eventos con status='success' AND cost_usdc>0 por agent_id)
  - (b) score normalizado 0-100: `min(tasks_settled / REPUTATION_SCALE_FACTOR, 100)` con `REPUTATION_SCALE_FACTOR` desde env
  - (c) score ponderado: tasks_settled × avg_cost_usdc (señal de "valor liquidado")
  - Recomendación preliminar: (b) — simple, legible, normalizable, `REPUTATION_SCALE_FACTOR=50` como default razonable para los volúmenes actuales

**DT-3: `[NEEDS CLARIFICATION]` — Lectura on-chain del ReputationRegistry (AC-7).** ¿Activar o dejar como placeholder con env guard? El spec ERC-8004 define `ReputationRegistry`; las addresses mencionadas en la HU deben verificarse en el repo https://github.com/erc-8004/erc-8004-contracts — marcar `[VERIFY-AT-IMPL]` en el adapter. Si el humano no confirma el contrato, el adapter se implementa con env guard y ABI `[VERIFY-AT-IMPL]`. Recomendación: implementar el env guard + graceful skip para tener la extensión lista sin bloquear si el contrato no está desplegado.

**DT-4:** Cache Redis para el score computado. La query a `a2a_events` puede ser costosa con volumen; cachear por `agentId` con TTL configurable (`REPUTATION_CACHE_TTL_MS`, default 60000ms). Si Redis no está disponible, skip cache y compute directo (degradación graceful).

**DT-5:** Separación de concerns: `reputationService` NO importa `budgetService`, `delegationService` ni accede a columnas `budget`/`funding_wallet` de `a2a_agent_keys` (CD-2 carry-forward de WKH-100). Lee solo `a2a_events`.

**DT-6:** Interface del ReputationRegistry on-chain: `[VERIFY-AT-IMPL]`. Las firmas exactas (`getReputation(address) → uint256`, `reputationOf(tokenId)`, u otra) deben verificarse en https://github.com/erc-8004/erc-8004-contracts antes de implementar. NO asumir la firma — el adapter debe citar el commit/tag del repo oficial.

**DT-7:** `AgentReputation` vs `Agent.reputation: number`. El tipo existente `Agent.reputation?: number` (src/types/index.ts:125) es el campo upstream del registry. La Fase 3 computa un score propio; decisión sobre si sobreescribir ese campo o añadir `computedReputation?: AgentReputation` depende del humano `[NEEDS CLARIFICATION]`. Recomendación: agregar `computedReputation?: AgentReputation` como campo adicional, no pisar el `reputation` upstream (backward-compat).

---

## Constraint Directives (CD)

**CD-1:** PROHIBIDO usar auto-reportes, votos externos, eventos sin `cost_usdc > 0`, o cualquier dato que no sea verificable desde `a2a_events` como fuente de reputación. El score DEBE derivar ÚNICAMENTE de tasks liquidadas en el propio sistema.

**CD-2:** PROHIBIDO tocar columnas `budget`, `funding_wallet`, `daily_spent_usd`, `daily_limit_usd` de `a2a_agent_keys` en ningún service o query relacionado con reputación. La reputación es desacoplada del sistema de pagos.

**CD-3:** OBLIGATORIO Ownership Guard si cualquier endpoint nuevo toca `a2a_agent_keys` por `id`: `.eq('id', keyId).eq('owner_ref', ownerId)` (conforme `CLAUDE.md:Security Conventions`, WKH-53).

**CD-4:** PROHIBIDO hardcodear direcciones de contrato del ReputationRegistry. OBLIGATORIO leer desde env vars por red/entorno (patrón `src/adapters/erc8004-identity.ts:73-80`).

**CD-5:** OBLIGATORIO degradación graceful en TODOS los paths de enriquecimiento (AC-4, AC-8): error de DB o RPC → campo `reputation`/`computedReputation` omitido, NUNCA error 5xx propagado al caller.

**CD-6:** PROHIBIDO `any` explícito en TypeScript. OBLIGATORIO TS strict en todos los archivos nuevos/modificados.

**CD-7:** PROHIBIDO ethers.js. OBLIGATORIO viem v2 para cualquier lectura on-chain del ReputationRegistry.

**CD-8:** PROHIBIDO escritura on-chain (WalletClient, writeContract, privateKeyToAccount) en esta fase. El server es read-only frente a ERC-8004.

**CD-9:** OBLIGATORIO backward-compat: agentes sin score de reputación no deben recibir el campo `computedReputation` en ningún shape (omitido, no `null`, no `undefined` explícito — patrón spread condicional de WKH-100/WKH-106).

---

## Missing Inputs / Needs Clarification

Los siguientes puntos requieren decisión del humano antes de HU_APPROVED. Máximo 3 preguntas:

### [NC-1] Métrica exacta del score y su shape en el AgentCard

Tres opciones:
- **(a) count puro:** `tasks_settled` — más simple, interpretable, no normalizado
- **(b) score 0-100 normalizado:** `min(tasks_settled / SCALE_FACTOR, 100)` — legible, portable entre agentes con distinto volumen
- **(c) weighted:** tasks_settled ponderado por `avg_cost_usdc` — más rico pero más opaco

Y el shape en el AgentCard: ¿`Agent.computedReputation` nuevo (recomendado para no pisar el `reputation` upstream), o sobreescribir `Agent.reputation: number`?

**Recomendación:** opción (b) + campo nuevo `computedReputation` — no rompe consumers actuales, interpretable.

### [NC-2] Lectura on-chain del ReputationRegistry (AC-7): ¿activar en esta fase?

El ReputationRegistry ERC-8004 existe on-chain. Se puede implementar lectura vía viem (read-only, cero gas) para enriquecer el score con attestations ajenas (ej. verificación por terceros). La interface exacta del contrato requiere verificar el repo oficial antes de implementar.

Opciones:
- **(a) Solo off-chain computed** — menor scope, cero dependencia nueva de contrato, listo más rápido
- **(b) Off-chain computed + lectura on-chain opcional** (env guard, graceful skip si no configurado) — mayor valor, mayor alcance Fase 3

**Recomendación:** opción (b) con env guard — si el humano no configura la var, la feature está inactiva y no bloquea. Si el contrato no está confirmado, el adapter se implementa con `[VERIFY-AT-IMPL]` y mock en tests.

### [NC-3] ¿Endpoint GET /auth/reputation dedicado, o solo enriquecimiento en /discover + AgentCard?

Opciones:
- **(a) Solo enriquecimiento en /discover y AgentCard** — el score se lee en esos contextos; ningún endpoint nuevo dedicado
- **(b) También GET /auth/reputation/:agentId o GET /auth/me con reputation** — permite que el owner vea su propio score

**Recomendación:** opción (a) para scope mínimo; si el humano quiere el endpoint dedicado, se agrega como AC adicional.

---

## Análisis de paralelismo

- **Bloquea:** ninguna HU conocida actualmente. WKH-103 es aditiva.
- **Depende de:** WKH-100 (DONE) y WKH-101 (DONE) — pre-requisitos satisfechos.
- **Puede ir en paralelo con:** cualquier HU que no toque `src/services/discovery.ts` ni `src/services/agent-card.ts`. Si hay HU en vuelo que modifique esos archivos, coordinar merge.
- **Validación Registry (Fase 4):** WKH-103 NO bloquea Fase 4 — Validation Registry es independiente.
