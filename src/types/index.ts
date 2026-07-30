/**
 * WasiAI A2A Protocol — Types
 */

// AR MENOR-6: `StepResult.downstreamSettle` se tipa con el vocabulario PÚBLICO
// de skip-codes en vez de `string`. Es un ciclo de tipos con
// `lib/downstream-skip-code.ts` (que importa `DownstreamLogger` de acá), pero
// `import type` se borra en runtime → no hay ciclo de módulos real.
import type { PublicDownstreamSkipCode } from '../lib/downstream-skip-code.js';
// HU-203: `ComposeResult.settleRefundWithheld` reusa el vocabulario del módulo que
// TOMA la decisión de retener, para que no puedan divergir. `import type` → sin ciclo
// de módulos en runtime.
import type { SettleWithholdingReason } from '../lib/settle-withholding.js';
// WKH-61: importamos A2AAgentKeyRow del subarchivo para tiparlo en
// ComposeRequest / OrchestrateRequest. El re-export `export * from './a2a-key.js'`
// del bottom mantiene la API pública intacta.
import type {
  A2AAgentKeyRow,
  DelegationDebitContext,
  KeySessionDebitContext,
} from './a2a-key.js';

// ============================================================
// REGISTRY TYPES
// ============================================================

export interface RegistryConfig {
  /** Unique identifier */
  id: string;

  /** Human-readable name */
  name: string;

  /** Discovery endpoint URL */
  discoveryEndpoint: string;

  /** Invoke endpoint URL template (use {agentId} or {slug} as placeholder) */
  invokeEndpoint: string;

  /** Optional: Get single agent endpoint */
  agentEndpoint?: string | undefined;

  /** Schema mapping for API compatibility */
  schema: RegistrySchema;

  /** Authentication config */
  auth?: RegistryAuth | undefined;

  /** Is this registry active? */
  enabled: boolean;

  /** When was it registered */
  createdAt: Date;

  /**
   * Owner identifier (WKH-63 / SEC-REG-1).
   *
   * Default 'system' for canonical entries (e.g. 'wasiai') created by the
   * platform. Service-layer guards (`registryService.update/delete`) treat
   * `owner_ref === 'system'` as immutable (403). For tenant-created entries,
   * holds the caller's `a2a_agent_keys.owner_ref`.
   *
   * Defense-in-depth: enforced in app-layer because Supabase service-role
   * client bypasses RLS. RLS policy tracked in TD-SEC-01.
   */
  ownerRef: string;
}

/**
 * HTTP-safe projection of `RegistryConfig` (HIGH-1, 2026-07-26).
 *
 * `RegistryConfig.auth.value` is a live outbound credential. Every read-path
 * that crosses the HTTP boundary MUST return this type instead of the internal
 * row, produced ONLY by `toRegistryPublic()` in `services/registry.ts`.
 *
 * Redaction is BY CONSTRUCTION, not by omission:
 *   - `auth?: never` makes `RegistryConfig` structurally NON-assignable to
 *     `RegistryPublic` (its `auth?: RegistryAuth | undefined` does not fit
 *     `never`), so `tsc` rejects a handler that forwards the internal row.
 *   - `authConfigured` is REQUIRED, so the internal row also fails the
 *     missing-property check. Two independent compile-time guards.
 *
 * SCOPE OF THE COMPILE-TIME GUARD (MNR-4, AR HIGH-2 — do NOT overstate it):
 * the guard bites on TYPED slots — `const p: RegistryPublic = cfg` (TS2741),
 * `const l: RegistryPublic[] = [cfg]` (TS2741), a function declared
 * `Promise<RegistryPublic[]>` returning `getEnabled()` (TS2322), and an object
 * spread of the internal row (TS2375, because of `auth?: never`). It does NOT
 * bite on `reply.send(...)`: Fastify types `send(payload?: unknown)`, so
 * `reply.send(await registryService.getEnabled())` COMPILES. The real defense at
 * the HTTP sink is (1) every route returning the mapped projection and (2) the
 * generic runtime guard `T-RRED-05` in `routes/registries.redaction.test.ts`,
 * which sweeps every registered GET. See TD-188-4.
 *
 * What replaces the secret: the declared scheme (`authType`) and a boolean
 * saying whether a static credential exists server-side. NEVER a prefix, a
 * suffix, a length or a hash of the value — all of those are attack material.
 *
 * MNR-5: `ownerRef` is NOT here. `GET /registries` is public (no auth) and
 * `types/index.ts` (WKH-141/CD-6) forbids leaking tenant identifiers on public
 * payloads. Internal ownership guards read `ownerRef` from the row returned by
 * `getWithSecrets()` (never crosses HTTP), not from this projection.
 */
export interface RegistryPublic {
  id: string;
  name: string;
  discoveryEndpoint: string;
  invokeEndpoint: string;
  agentEndpoint?: string | undefined;
  schema: RegistrySchema;
  enabled: boolean;
  createdAt: Date;

  /**
   * Redaction guard — structurally forbidden. Never present at runtime.
   * Do NOT relax this to `RegistryAuth`: it is what makes `tsc` reject the
   * internal row in a typed `RegistryPublic` slot (and in a spread of it).
   */
  auth?: never;

  /** Declared outbound auth scheme. Omitted when the registry has no auth. */
  authType?: RegistryAuth['type'] | undefined;

  /**
   * `true` when a static credential is stored server-side for this registry.
   * Carries no information about the credential itself.
   */
  authConfigured: boolean;
}

export interface RegistrySchema {
  /** How to map discovery params */
  discovery: {
    /** Query param for capabilities/tags */
    capabilityParam?: string;
    /** Query param for free text search */
    queryParam?: string;
    /** Query param for limit */
    limitParam?: string;
    /** Query param for max price */
    maxPriceParam?: string;
    /** Path to agents array in response */
    agentsPath?: string;
    /** Field mappings for agent object */
    agentMapping?: AgentFieldMapping;
  };

  /** How to call invoke */
  invoke: {
    method: 'GET' | 'POST';
    /** Field name for input in request body */
    inputField?: string;
    /** Path to result in response */
    resultPath?: string;
  };
}

export type AgentStatus = 'active' | 'inactive' | 'unreachable';

/**
 * Payment specification declared by an agent in its agent card (WKH-55).
 * Pass-through del raw response — no se normaliza chain/method (preservar shape).
 */
export interface AgentPaymentSpec {
  method: string; // e.g. 'x402'
  chain: string; // e.g. 'avalanche'
  // WKH-234: namespace-aware payTo. EVM = `0x${string}`; Solana = base58 mint/
  // owner pubkey (string). La validación de FORMA vive en `wallet-format`
  // (`isValidPayoutWallet`) / `validatePayTo` — este tipo solo relaja la forma.
  contract: `0x${string}` | string; // payTo on-chain address
  asset?: string | undefined; // e.g. 'USDC' (opcional, pass-through)
}

// ============================================================
// SELF-PUBLISHED AGENT TYPES (WKH-134)
// ============================================================

/**
 * Registry id/name sintético para agentes self-published (WKH-134). NO existe
 * como fila en `registries` — se usa como ancla en `Agent.registry`/
 * `registry_id` para que el pipeline de discovery los trate uniformemente y el
 * route `agent-card.ts` construya un `RegistryConfig` sintético (DT-5).
 */
export const SELF_PUBLISHED_REGISTRY_ID = 'self-published';
export const SELF_PUBLISHED_REGISTRY_NAME = 'self-published';

/**
 * Payload de `POST /agents` (WKH-134). El gateway ensambla el Agent Card A2A
 * de salida — NO se pide un Agent Card completo de entrada. El `slug` se deriva
 * server-side del `name` (CD-5); NUNCA se acepta del body.
 */
export interface PublishAgentInput {
  /** Nombre humano — deriva el slug server-side. */
  name: string;
  /** URL real del agente (invokeUrl). SSRF-validada antes de persistir. */
  agentUrl: string;
  /** Capabilities → skills[]. Al menos 1. */
  capabilities: string[];
  /** Descripción opcional (default ''). */
  description?: string;
  /** Precio por invocación en USDC (default 0). */
  priceUsdc?: number;
  /** WKH-106: JSON-Schema de entrada (opt-in discoverable). */
  inputSchema?: Record<string, unknown>;
  /** WKH-106: JSON-Schema de salida (opt-in discoverable). */
  outputSchema?: Record<string, unknown>;
  /** Opt-in para exponer input/outputSchema en el AgentCard. */
  discoverable?: boolean;
  /** WKH-143b: wallet EVM del creator para el creator-split (money-path input). */
  payoutWallet?: string;
  /** WKH-143b: referrer opaco (persistido trimmeado; inerte hasta WKH-143c). */
  referrerRef?: string;
  /**
   * WKH-234: contexto de familia del `payoutWallet` para el guard de publish
   * (namespace-aware). Slug de chain (ej. `solana-devnet`). Ausente → familia
   * `'evm'` → comportamiento byte-idéntico.
   */
  payoutChain?: string;
}

/**
 * Subconjunto mutable de `PublishAgentInput` para `PATCH /agents/:slug`
 * (WKH-134). Todos los campos opcionales; el `slug` (PK) NO cambia.
 */
export interface UpdateAgentInput {
  name?: string;
  agentUrl?: string;
  capabilities?: string[];
  description?: string;
  priceUsdc?: number;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  discoverable?: boolean;
  /** WKH-143b: wallet EVM del creator para el creator-split (money-path input). */
  payoutWallet?: string;
  /** WKH-143b: referrer opaco (persistido trimmeado; inerte hasta WKH-143c). */
  referrerRef?: string;
  /** WKH-234: contexto de familia del `payoutWallet` (namespace-aware). Ausente → EVM. */
  payoutChain?: string;
}

export interface AgentFieldMapping {
  id?: string;
  name?: string;
  slug?: string;
  description?: string;
  capabilities?: string;
  price?: string;
  reputation?: string;
  verified?: string;
  status?: string;
}

export interface RegistryAuth {
  type: 'header' | 'query' | 'bearer';
  key: string;
  value?: string; // If static, otherwise must be provided per-request
}

// ============================================================
// AGENT TYPES
// ============================================================

export interface Agent {
  id: string;
  name: string;
  slug: string;
  description: string;
  capabilities: string[];
  priceUsdc: number;
  reputation?: number;
  registry: string;
  /**
   * WKH-100 FIX v3 (DT-23): PK canónico del registry (`registry.id`, inmutable
   * y único). Ancla del match de identidad ERC-8004 — reemplaza el cruce por
   * `registry` (display name, mutable) que sufría colisión de normalización
   * (BLQ-MED-1). `registry` se mantiene para backward-compat / display.
   */
  registry_id: string;
  invokeUrl: string;
  /** Explains that invocation must go through POST /compose or POST /orchestrate on the gateway */
  invocationNote: string;
  verified: boolean;
  status: AgentStatus;
  metadata?: Record<string, unknown>;
  /** Payment spec del agent card (WKH-55). Undefined si el registry no lo expone. */
  payment?: AgentPaymentSpec | undefined;
  /**
   * WKH-100 (AC-8): ERC-8004 verified identity surfaced from the agent's
   * bound Agent Key. Omitted (not null) when the agent has no bound identity
   * (backward-compat — AC-9/CD-9).
   */
  identity?: AgentCardIdentity;
  /** WKH-103 (AC-1): score off-chain computado. Omitido si 0 tasks (CD-9). */
  computedReputation?: AgentReputation;
  /**
   * WKH-313 (AC-2/DT-3): el agente entró bajo el piso por el CARRIL DE ESTRENO.
   * Omitido (no `null`) salvo que la admisión haya ocurrido de verdad.
   */
  trial?: AgentTrialAdmission;
}

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

/**
 * WKH-313 — contadores CRUDOS del standing de un agente. Salen del MISMO
 * accumulator y de la MISMA query que el score (CD-8): no hay una segunda
 * expresión de la cuenta ni una segunda query.
 *
 * Es un shape de CONTADORES y no la unión discriminada literal de DT-4
 * (`{kind:'scored';reputation} | {kind:'newcomer'} | {kind:'penalized'}`) por
 * una razón concreta: con `N > 1` un agente puede estar a la vez DENTRO del
 * carril (1-2 liquidadas) y TENER reputación real que hay que adjuntar, y esa
 * unión no puede expresar los dos hechos juntos. La clasificación se deriva con
 * una función PURA sobre estos contadores (`lib/trial-standing.ts`
 * `classifyStanding`), que es lo que preserva el espíritu de DT-4/CD-8 (una
 * sola expresión del predicado, una sola expresión del score).
 */
export interface AgentStandingCounters {
  /** Liquidadas pagas, YA capeadas por caller (K) — misma cuenta que el score. */
  tasksSettled: number;
  successCount: number;
  failedCount: number;
  /** El score real. `null` ⟺ `tasksSettled === 0`. NUNCA se fabrica (CD-6/AC-7). */
  reputation: AgentReputation | null;
}

/**
 * WKH-313 — clasificación DERIVADA (función pura, `lib/trial-standing.ts`). NO
 * es campo público de `Agent` (DT-6/CD-10): publicar `penalized` sería una letra
 * escarlata sin contrato.
 */
export type AgentStandingKind = 'scored' | 'newcomer' | 'penalized';

/**
 * WKH-313 — resultado del batch de standing. `degraded` es un TERCER valor
 * EXPLÍCITO: NO es un Map vacío (CD-7). Con `degraded: true` no se admite a
 * NADIE por el carril de estreno, porque "no pude preguntar por el historial" no
 * es "no tiene historial".
 */
export interface AgentStandingBatch {
  degraded: boolean;
  standings: Map<string, AgentStandingCounters>;
}

/**
 * WKH-313 (AC-2/DT-3) — el agente entró bajo el piso por el carril de estreno.
 * El campo SÓLO existe cuando la admisión ocurrió: un piso relajado en silencio
 * es la clase de bug que este repo rechaza por escrito dos veces
 * (`discovery.ts` filtro de `minReputation`, `lib/compose-step-shape.ts`
 * allowlist de constraints). NO lleva `owner_ref` ni la clasificación de
 * standing (CD-10).
 */
export interface AgentTrialAdmission {
  granted: true;
  /** El piso que el caller pidió y que este agente NO alcanza por mérito. */
  under_min_reputation: number;
  /** Liquidadas pagas acumuladas (`0..N-1`). Es el contador que agota el carril. */
  tasks_settled: number;
  /** Las que le quedan de estreno: `N - tasks_settled`. */
  remaining_settled_tasks: number;
}

/**
 * WKH-100 (AC-8): ERC-8004 verified identity surfaced in discovery.
 * `verified` is a literal `true` — the field is ONLY ever surfaced when the
 * binding was verified on-chain server-side (anti-spoof — CD-7).
 *
 * WKH-100 FIX-PACK v2 (MNR-1 / DT-22.4) — CONTRATO DEL BADGE. `verified:true`
 * atesta un vínculo BIDIRECCIONAL probado por TRES anclajes simultáneos:
 *   (i)   el AgentCard del agente DECLARA este token (extractDeclaredTokenId);
 *   (ii)  ese token está bindeado a una Agent Key y fue `ownerOf`-verificado
 *         on-chain al bindear (el caller poseía el token);
 *   (iii) ese binding DECLARA operar ESTE agente vía (agent_registry,
 *         agent_slug) (= Agent.registry + Agent.slug, case-insensitive).
 * Si falta CUALQUIER anclaje → SIN badge. Esto cierra tanto el vector clásico
 * (slug spoof) como el inverso (declarar el token público de otro agente).
 * El shape de salida NO cambia: el fix es de mecanismo de resolución.
 */
export interface AgentCardIdentity {
  erc8004_token_id: string; // = token_id del binding
  chain_id: number; // 8453 | 84532
  verified: true; // literal: solo se surfacea si verificado on-chain
}

// ============================================================
// DISCOVERY TYPES
// ============================================================

export interface DiscoveryQuery {
  capabilities?: string[] | undefined;
  query?: string | undefined;
  maxPrice?: number | undefined;
  minReputation?: number | undefined;
  /**
   * WKH-313 (AC-8) — OPT-IN del consumidor al carril de estreno. `true` admite,
   * bajo `minReputation`, a agentes sin historial (`newcomer`) que además pasen
   * el techo `T` y el cupo `M` por publicador (`lib/trial-standing.ts`).
   *
   * DEFAULT = NO ADMITIR. Ausente/`false` ⟹ el comportamiento de hoy byte por
   * byte, incluido el costo de I/O (CD-9: cero queries nuevas). El que puso el
   * piso es el que come el riesgo, así que es el que decide relajarlo: que el
   * gateway ignore por su cuenta un piso que el caller pidió es el MISMO defecto
   * que este repo ya rechaza por escrito, con el signo invertido y sobre el
   * camino del dinero.
   *
   * El agente admitido NO recibe score fabricado: conserva su puntaje real (0)
   * y por lo tanto ordena ÚLTIMO (CD-6).
   *
   * ⚠️ AR fix-pack BLQ-ALTO-1 — cómo se sostiene ese "ordena ÚLTIMO". Sin score
   * computado el ranking cae al `Agent.reputation` del card, y la PRIMERA clave del
   * sort es `Agent.verified`: los dos los AUTO-REPORTA el agente (`mapAgent`), así
   * que un federado que declarara `{reputation:100, verified:true}` ordenaba
   * PRIMERO y `/compose` toma `agents[0]`. Por eso el admitido llega al sort, y sale
   * en la respuesta, con `verified: false` y `reputation` = su score REAL
   * (`computedReputation?.score ?? 0`). El comparador NO se tocó: se corrigió lo que
   * se le da de comer.
   */
  allowTrial?: boolean | undefined;
  limit?: number | undefined;
  registry?: string | undefined; // Filter to specific registry
  verified?: boolean | undefined;
  includeInactive?: boolean | undefined;
  /**
   * HU-208 (port de WAS-187 AC-7): el alcance del LLAMADOR, para que un agente
   * que su credencial estructuralmente no puede invocar no sea candidato.
   *
   * Es la fila efectiva de la key (`request.a2aKeyRow`) y NO un shape propio a
   * propósito: el filtro llama a `authzService.checkScoping`, EXACTAMENTE la
   * misma función que después hace cumplir el alcance en
   * `composeService.compose`. Con dos predicados distintos, el selector podría
   * elegir un agente que el ejecutor rechaza (403 sobre un agente que el
   * llamador nunca nombró).
   *
   * `undefined` (llamador x402 anónimo, sin credencial) → sin filtro: no hay
   * alcance que aplicar.
   */
  scope?: A2AAgentKeyRow | undefined;
}

export interface DiscoveryResult {
  agents: Agent[];
  total: number;
  registries: string[];
  /**
   * HU-208: cuántos candidatos descartó cada filtro de CANDIDATURA. Aditivo y
   * opcional (los callers que no lo leen no cambian). Existe para que un
   * conjunto vacío pueda explicarse: sin este dato, "no hay agente" y "hay uno
   * pero tu credencial no lo alcanza" son el mismo mensaje, y mandan a buscar el
   * problema al lugar equivocado.
   */
  excluded?: {
    scope: number;
    /**
     * WKH-313 (AC-3): cuántos candidatos descartó el piso de `minReputation`,
     * contados PRE-sort y PRE-`slice` (o sea sobre los matches reales, no sobre
     * la página). Un agente admitido por el carril de estreno NO se cuenta acá:
     * pasó el filtro.
     */
    reputation: number;
    /**
     * WKH-313 (AC-3): cuántos candidatos se habrían admitido por el carril de
     * estreno.
     *
     * ⚠️ SEMÁNTICA QUE CAMBIA CON EL OPT-IN, y hay que decirlo:
     *   · con `allowTrial: true` es EXACTO y coincide con la cantidad de badges
     *     `trial` en `agents` (T-17);
     *   · sin `allowTrial` es una COTA SUPERIOR (pre-cupo): CD-9 prohíbe la
     *     query del ancla de publicación en el camino por defecto, y sin anclas
     *     el cupo `M` por publicador no se puede aplicar.
     * Un contador que a veces es exacto y a veces una cota, sin decirlo, es la
     * clase de dato que se lee mal.
     */
    trialAvailable: number;
  };
}

// ============================================================
// COMPOSE TYPES
// ============================================================

/** WKH-114: veredicto de verificación de completitud por step. */
export type StepVerdict = 'pass' | 'fail' | 'unverified';
/** WKH-114 (DT-5, análogo a ArbiterMethod): origen del veredicto. */
export type VerificationMethod = 'rules' | 'llm' | 'none';
/** WKH-114: completitud a nivel pipeline, DISTINTA de `success`. */
export type PipelineVerificationStatus =
  | 'verified'
  | 'incomplete'
  | 'unverified';

/** WKH-114: resultado de evaluar el output de un step contra sus AC. */
export interface StepAcceptance {
  /** Los AC efectivamente evaluados (post-substitución de default si el step no traía). */
  criteria: string[];
  verdict: StepVerdict;
  method: VerificationMethod;
  /** Presente SOLO cuando verdict === 'fail'. Subconjunto de `criteria`. */
  failedCriteria?: string[];
}

/**
 * HU-208: restricciones del CONJUNTO DE CANDIDATOS de un step declarado por
 * `capability`. Port de `ComposeStep.constraints` de WAS-187 (wasiai-v2
 * `sdd-187.md` §1.1) menos `min_performance`, que allá ordenaba por una columna
 * `performance_score` que acá NO existe: nuestro `AgentReputation.score` YA se
 * deriva de tasks liquidadas + success_rate + latencia, o sea que es la señal de
 * performance operacional. Portar un segundo score habría creado dos
 * definiciones de "el mejor", que es el error que esta HU existe para no cometer.
 *
 * ⚠️ Las dos se aplican como filtros PRE-SORT dentro de
 * `discoveryService.runDiscoveryPipeline`, NUNCA como post-filtro sobre la página
 * ya recortada. La razón está en `resolveCapabilityStep` (services/
 * capability-resolver.ts) y es lo que mantiene el residual TD-189-1 FUERA del
 * camino del dinero. No mover estos filtros aguas abajo del `slice`.
 */
export interface ComposeStepConstraints {
  /** Techo de precio por llamada en USD. Mapea a `DiscoveryQuery.maxPrice`. */
  max_price_usdc?: number;
  /**
   * Piso de reputación COMPUTADA (0-100, off-chain, derivada de tasks
   * liquidadas). Mapea a `DiscoveryQuery.minReputation`, que deliberadamente NO
   * usa el `reputation` auto-reportado por el registry (ver discovery.ts).
   */
  min_reputation?: number;
  /**
   * WKH-313 (DT-7) — opt-in al CARRIL DE ESTRENO para este step. `snake_case`
   * como sus dos hermanas. Mapea a `DiscoveryQuery.allowTrial`.
   *
   * Ausente/`false` = comportamiento de hoy. `true` admite bajo `min_reputation`
   * a un agente sin historial, que igual ordena ÚLTIMO porque su score real
   * sigue siendo 0 y porque el pipeline le neutraliza los dos campos que el card
   * auto-reporta (`verified` y `reputation` — ver `DiscoveryQuery.allowTrial`).
   * No-booleano ⟹ 400 `VALIDATION_ERROR`.
   */
  allow_trial?: boolean;
}

export interface ComposeStep {
  /**
   * Agent ID or slug.
   *
   * HU-208: pasó a OPCIONAL porque un step puede declararse por `capability` y
   * dejar que el gateway elija el agente. Es MUTUAMENTE EXCLUYENTE con
   * `capability`: traer las dos, o ninguna, es un 400 (`validateComposeBody`).
   */
  agent?: string;
  /**
   * HU-208: la CAPACIDAD requerida; el gateway resuelve qué agente la cumple
   * mejor con el ranking que ya existe (verified → reputación → precio).
   * Mutuamente excluyente con `agent`.
   */
  capability?: string;
  /** HU-208: filtros del conjunto de candidatos. Sólo aplica junto a `capability`. */
  constraints?: ComposeStepConstraints;
  /** Registry name (optional, will search all if not specified) */
  registry?: string;
  /** Input for this step */
  input: Record<string, unknown>;
  /** Use output from previous step */
  passOutput?: boolean;
  /**
   * WKH-305: mapeo de campos puntuales desde la salida del step INMEDIATAMENTE
   * anterior hacia el input de este step. `{ claveDestino: claveOrigen }`, o sea
   * `input[destino] = salidaAnterior[origen]`.
   *
   * Lookup de UNA clave de primer nivel por entrada: sin dot-paths, sin
   * expresiones, sin defaults, sin acceso a steps anteriores al inmediato. Lo
   * valida `lib/compose-input-mapping.ts` en DOS puntos, los dos pre-cobro:
   * `validateComposeStepShape` (borde HTTP) y `resolveStepInput` (service).
   *
   * Coexiste con `passOutput` (que inyecta el objeto entero bajo
   * `previousOutput`); la clave destino `previousOutput` está prohibida para que
   * no haya dos escritores del mismo campo.
   */
  inputFromPrevious?: Record<string, string>;
  /** WKH-114: AC adjuntos en plan-time o por el caller. */
  acceptanceCriteria?: string[];
}

/**
 * HU-208: step cuyo agente YA ESTÁ RESUELTO a un slug concreto.
 *
 * ⚠️ ESTE TIPO ES UN GUARD DE DINERO, no azúcar sintáctica. `ComposeRequest.steps`
 * lo exige, así que `composeService.compose` NO PUEDE recibir un step sin
 * resolver: intentarlo es un error de compilación, no un bug de runtime.
 *
 * Por qué importa: `composeService.resolveAgent` re-resuelve cada step por su
 * cuenta. Si la resolución por capacidad viviera ahí, correría por SEGUNDA vez
 * después de que el precio ya se cotizó y el step-0 ya se debitó, sobre entradas
 * de ranking que cambian solas (fetch en vivo a los registries +
 * `computeReputationBatch` contra la DB) — y podría elegir OTRO agente. El
 * llamador habría pagado por un pipeline y recibido otro. La resolución ocurre
 * UNA sola vez, en el preHandler, y desde ahí el step es indistinguible de uno
 * que el llamador nombró a mano.
 */
export interface ResolvedComposeStep extends ComposeStep {
  agent: string;
  /**
   * HU-208: procedencia. Presente SÓLO si el gateway eligió este agente a partir
   * de una `capability`; ausente si el llamador lo nombró. Es la información que
   * de verdad falta en la respuesta — el agente resuelto YA viaja entero en
   * `StepResult.agent`, así que un `resolved_slug` (WAS-187 AC-5) sería
   * redundante; lo que no se puede reconstruir es QUIÉN eligió.
   */
  resolvedFrom?: { capability: string };
}

export interface ComposeRequest {
  /**
   * HU-208: `ResolvedComposeStep[]`, no `ComposeStep[]`. Ver el docstring del
   * tipo — es el guard de compilación que impide que un step por capacidad
   * llegue sin resolver al ejecutor.
   */
  steps: ResolvedComposeStep[];
  /** Max budget in USDC */
  maxBudget?: number | undefined;
  /** Propagated to agent invocations as header `x-a2a-key` (WKH-MCP-X402) */
  a2aKey?: string | undefined;
  /**
   * WKH-61: row de la a2a_agent_keys del caller, para scoping post-resolve.
   * Cuando está presente, composeService chequea allowed_registries /
   * allowed_agent_slugs / allowed_categories contra el Agent real de cada step.
   * Cuando es undefined (path x402), el check no se ejecuta.
   */
  scopingKeyRow?: A2AAgentKeyRow | undefined;
  /**
   * WKH-59 (real-price-debit) DT-D: chainId resuelto por el middleware
   * (request.resolvedChainId). composeService lo usa para debit per-step
   * (steps 2..N) via budgetService.debit. Cuando undefined (path x402 o
   * defensive skip), el debit per-step se omite.
   */
  chainId?: number | undefined;
  /**
   * WKH-59 (real-price-debit) BLQ-MED-1 fix: logger opcional para emitir
   * `compose-price.fallback per-step` warn cuando priceUsdc=0/null en
   * steps 2..N (CD-4 fallback honesto). El service NO se acopla a Fastify
   * — se reusa el shape `DownstreamLogger` que ya consume WKH-55. La ruta
   * `/compose` pasa `request.log` (Pino), que es estructuralmente
   * compatible. Cuando undefined → fallback a `console.warn`.
   */
  logger?: DownstreamLogger | undefined;
  /**
   * WKH-101 (DT-11): contexto de delegación para el débito per-step (steps 2..N).
   * Cuando está presente, budgetService.debit enruta al RPC atómico
   * debit_delegation_and_parent (AC-7 per-step + AC-8/AC-9). undefined → master
   * key (camino actual increment_a2a_key_spend, CD-5 intacto).
   */
  delegationContext?: DelegationDebitContext | undefined;
  /**
   * WKH-121 (BLQ-ALTO-1): contexto de key-session para el débito per-step
   * (steps 1..N). Cuando está presente, budgetService.debit enruta al RPC
   * atómico debit_session_and_parent y respeta el cap max_budget_usd de la
   * sesión (AC-8/AC-9). undefined → no es una sesión server-side. Espejo de
   * `delegationContext`; mutuamente exclusivo con él en runtime.
   */
  keySessionContext?: KeySessionDebitContext | undefined;
  /**
   * WKH-303: precios CONGELADOS por step, provenientes de un quote firmado que el caller
   * redimió en `/orchestrate/execute`. Índice = índice del step.
   *
   * Cuando `frozenStepPricesUsd[i]` es finito y `> 0`, el débito AL CALLER de ese step usa
   * ese precio en vez del precio vivo del agente: es la garantía de precio que se le dio en
   * `/plan`. Su ausencia (o un valor 0/negativo/NaN) = EXACTAMENTE el comportamiento de hoy.
   *
   * Solo afecta el monto debitado al caller. NO cambia el settle downstream al agente (que
   * sigue cobrando su precio vivo) ni la base del protocol fee (que es el costo ejecutado).
   */
  frozenStepPricesUsd?: readonly number[] | undefined;
}

export interface ComposeResult {
  success: boolean;
  output: unknown;
  steps: StepResult[];
  totalCostUsdc: number;
  totalLatencyMs: number;
  error?: string;
  /**
   * WKH-61: discriminator para que el route handler mapee a 403 (`SCOPE_DENIED`).
   * WKH-125: `DEST_CAP_EXCEEDED` → 402 (cap por destino excedido mid-pipeline).
   * WKH-305: `INPUT_MAPPING_FAILED` → **400**, por el `default` que YA existe en
   * el mapeo de status de `routes/compose.ts` (`let status = 400`). NO agrega una
   * rama de status nueva: un mapeo irresoluble es un body que el gateway no puede
   * satisfacer, o sea el mismo 400 de siempre.
   */
  errorCode?: 'SCOPE_DENIED' | 'DEST_CAP_EXCEEDED' | 'INPUT_MAPPING_FAILED';
  /** WKH-61: target denegado, para debugging. `category` se omite si el agent no la expone. */
  scopeDeniedTarget?: {
    registry: string;
    agent_slug: string;
    category?: string;
  };
  /**
   * WKH-305: detalle accionable del fallo de `inputFromPrevious`. Paralelo exacto
   * de `scopeDeniedTarget`: el `error` en texto también nombra step, campo y
   * origen, pero un cliente no debería tener que parsearlo para reaccionar.
   *
   * No filtra nada sensible: `field` y `source` son los nombres de clave que el
   * propio llamador declaró en su body.
   */
  inputMappingFailure?: {
    step: number;
    reason:
      | 'INVALID_MAPPING_SHAPE'
      | 'PREVIOUS_OUTPUT_NOT_OBJECT'
      | 'SOURCE_FIELD_MISSING';
    /** Clave destino. */
    field?: string;
    /** Clave origen leída de la salida del step anterior. */
    source?: string;
  };
  /** WKH-114: completitud a nivel pipeline (AC-5), DISTINTA de success. */
  verificationStatus?: PipelineVerificationStatus;
  /**
   * HU-203: el step que abortó el pipeline lo hizo con un settle cuyo resultado NO se
   * conoce (hay evidencia de broadcast, o el facilitator no dio un veredicto legible).
   * Presente ⟹ la plata del caller pudo haber salido de verdad.
   *
   * Existe porque el débito del step 0 lo hace y lo reembolsa `services/orchestrate.ts`,
   * NO `compose` (el guard `i > 0` de compose es la única defensa contra el doble
   * débito del step 0). Sin este campo, compose podía retener el reembolso de su step y
   * orchestrate devolvía igual el del step 0, que es la misma pérdida.
   *
   * `step` es LOAD-BEARING: orchestrate sólo debe saltear SU reembolso cuando el settle
   * sin resolver fue el del step 0. Si fue el de un step posterior, el residuo del
   * step 0 sigue siendo plata del caller que nunca se gastó y devolverla es correcto.
   */
  settleRefundWithheld?: {
    step: number;
    reason: SettleWithholdingReason;
    txHash: string | null;
  };
}

export interface StepResult {
  agent: Agent;
  output: unknown;
  costUsdc: number;
  latencyMs: number;
  /**
   * HU-208: procedencia del agente de ESTE step. Presente SÓLO cuando el gateway
   * lo eligió a partir de una `capability`; ausente cuando el llamador lo nombró.
   * Cambio de contrato ADITIVO.
   *
   * El agente elegido YA viaja entero en `agent` (esa es la forma que la
   * respuesta ya tenía y que se respeta), así que repetir el slug — el
   * `resolved_slug` de WAS-187 AC-5 — no agregaría nada. Lo que no se puede
   * reconstruir desde la respuesta es si el llamador lo pidió o el gateway lo
   * decidió, y eso es justo lo que hace auditable una elección server-side.
   */
  resolvedFrom?: { capability: string };
  txHash?: string | undefined; // Hash de tx on-chain si hubo pago x402
  /** @deprecated Use bridgeType. Kept for backward-compat (WKH-56 DT-3). */
  cacheHit?: boolean | 'SKIPPED';
  /** Latency of bridge resolution (ms). Includes A2A fast-path or maybeTransform. */
  transformLatencyMs?: number;
  /** Bridge type for the transition step→step+1. WKH-56. */
  bridgeType?: BridgeType | undefined;
  /** Hash de la tx downstream Fuji USDC settle (WKH-55) */
  downstreamTxHash?: string;
  /** Block number en Fuji donde se confirmo el downstream settle (WKH-55) */
  downstreamBlockNumber?: number;
  /** Atomic units (string, 6-dec USDC) que se settearon downstream (WKH-55) */
  downstreamSettledAmount?: string;
  /**
   * Fix-pack P1 (hallazgo 4): estado del leg downstream cuando NO se settleó.
   * Formato `"skipped:<PublicDownstreamSkipCode>"` (p.ej.
   * `"skipped:NO_PAYMENT_FIELD"`, `"skipped:NOT_CONFIGURED"`).
   *
   * Antes el motivo del skip quedaba SÓLO en los logs del servidor y la
   * respuesta HTTP no lo decía. Cambio de contrato ADITIVO: presente sólo en el
   * caso skip; en el caso exitoso se poblan `downstreamTxHash` /
   * `downstreamBlockNumber` / `downstreamSettledAmount` como siempre.
   *
   * ⚠️ El código es del vocabulario PÚBLICO (`toPublicSkipCode`), NO el
   * `DownstreamSkipCode` interno: los códigos que revelan config del gateway,
   * fondos del operador o sus claves se genericizan a `NOT_CONFIGURED` /
   * `UNAVAILABLE`. Ver el `Record` exhaustivo en
   * `src/lib/downstream-skip-code.ts` (AR MENOR-6: este puntero decía
   * `downstream-payment.ts`, de donde el mapeo se movió para no romper las suites
   * que lo mockean completo).
   *
   * Tipado como template literal del vocabulario público (AR MENOR-6): con
   * `string` la exhaustividad del `Record` se perdía justo en el borde de la API,
   * que es donde importa que el contrato sea el cerrado.
   */
  downstreamSettle?: `skipped:${PublicDownstreamSkipCode}`;
  /** WKH-57: telemetry del bridge LLM. Presente solo si bridgeType==='LLM'. */
  transformLLM?: LLMBridgeStats;
  /** WKH-114: veredicto evaluado (AC-4). */
  acceptance?: StepAcceptance;
}

// ============================================================
// SCHEMA TRANSFORM TYPES (WKH-14)
// ============================================================

/**
 * WKH-57: telemetry del path LLM. Presente sii bridgeType==='LLM'.
 *
 * tokensIn/tokensOut son SUMA de attempts cuando hubo retry (retries===1).
 * costUsd se computa con PRICING_USD_PER_M_TOKENS centralizado (CD-6).
 */
export interface LLMBridgeStats {
  /** Modelo Anthropic invocado (env-driven vía llm/models.ts; WKH-135). */
  model: string;
  /** Total tokens de input cobrados por Anthropic (suma de attempts si hubo retry). */
  tokensIn: number;
  /** Total tokens de output cobrados por Anthropic. */
  tokensOut: number;
  /** 0 = first attempt OK; 1 = second attempt OK (retry exitoso). */
  retries: 0 | 1;
  /** Costo USD computado a partir de PRICING_USD_PER_M_TOKENS. */
  costUsd: number;
}

/** Result of a maybeTransform call */
export interface TransformResult {
  transformedOutput: unknown;
  /** @deprecated Use bridgeType. true = cache hit, false = LLM generated, 'SKIPPED' = schemas compatible */
  cacheHit: boolean | 'SKIPPED';
  /**
   * WKH-56: explicit bridge type derived from cache layer used.
   *
   * Optional in W0 to keep the wave standalone-mergeable (CD-9).
   * W1 populates this in every return of `maybeTransform` and downstream
   * consumers (compose.ts) treat it as always present after W1+.
   *
   * WKH-57 NO tightener a required (AB-WKH-56-2).
   */
  bridgeType?: BridgeType; // 'SKIPPED' | 'CACHE_L1' | 'CACHE_L2' | 'LLM'
  latencyMs: number;
  /** WKH-57: telemetry del path LLM. undefined si bridgeType !== 'LLM'. */
  llm?: LLMBridgeStats;
}

/** Row in kite_schema_transforms table */
export interface SchemaTransformEntry {
  id: string;
  sourceAgentId: string;
  targetAgentId: string;
  transformFn: string;
  hitCount: number;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================
// ORCHESTRATE TYPES
// ============================================================

export interface OrchestrateRequest {
  /** Natural language goal */
  goal: string;
  /** Max budget in USDC */
  budget: number;
  /** Preferred capabilities (hints) */
  preferCapabilities?: string[] | undefined;
  /** Max agents to use */
  maxAgents?: number | undefined;
  /** Propagated downstream to compose/invokeAgent as header `x-a2a-key` (WKH-MCP-X402) */
  a2aKey?: string | undefined;
  /** WKH-61: row de a2a_agent_keys, propagado a composeService.compose. */
  scopingKeyRow?: A2AAgentKeyRow | undefined;
  /** WKH-101 (DT-11): contexto de delegación propagado a composeService.compose. */
  delegationContext?: DelegationDebitContext | undefined;
  /**
   * WKH-121 (BLQ-ALTO-1): contexto de key-session propagado a
   * composeService.compose para que el cap de sesión se respete en los steps
   * 1..N (AC-8/AC-9). Espejo de `delegationContext`.
   */
  keySessionContext?: KeySessionDebitContext | undefined;
  /**
   * chainId resuelto (request.resolvedChainId), propagado a compose para que el
   * débito per-step de steps 1..N funcione. WKH-102 (DT-1): se propaga SIEMPRE
   * (master y delegación, single-chain semantics — modelo WKH-59), no solo bajo
   * delegación. El guard `i>0` de compose.ts:130 protege el step 0 contra
   * double-charge (CD-1, intacto).
   */
  chainId?: number | undefined;
  /**
   * WKH-303: precios CONGELADOS por step de un quote firmado redimido en
   * `/orchestrate/execute`. Se propaga tal cual a `composeService.compose` para que los
   * steps 1..N se debiten al precio pactado. Índice = índice del step.
   *
   * Ausente = comportamiento de hoy (precio vivo). Solo afecta el débito al caller.
   */
  frozenStepPricesUsd?: readonly number[] | undefined;
}

export interface OrchestrateResult {
  orchestrationId: string;
  answer: unknown;
  reasoning: string;
  pipeline: ComposeResult;
  consideredAgents: Agent[];
  protocolFeeUsdc: number;
  attestationTxHash?: string;
  /** WKH-44: error string propagado cuando el fee charge best-effort falla. */
  feeChargeError?: string;
  /** WKH-44: tx hash del transfer EIP-712 del protocol fee (si tuvo éxito). */
  feeChargeTxHash?: string;
  /** WKH-127 (AC-8): true si el credit-back falló; flag para reconciliación manual. */
  refundError?: boolean;
  /** WKH-127 (AC-4): true si se aplicó el fallback $1 por plannedCost===0; el route setea x-debit-fallback. */
  debitFallback?: boolean;
  /** WKH-127: saldo post-débito (y post-refund) real; el route lo escribe en x-a2a-remaining-budget. */
  remainingBudgetUsd?: string;
}

// WKH-131 (HU-128): /orchestrate/plan + /orchestrate/execute split.
export type OrchestratePlanStatus =
  | 'ready'
  | 'insufficient_funds'
  | 'no_agents'
  | 'budget_exhausted'
  | 'no_relevant_agent';
// circuit_open: DIFERIDO (DT-3). NO agregar en esta HU.

export interface OrchestratePlanResult {
  orchestrationId: string;
  planStatus: OrchestratePlanStatus;
  /**
   * Steps del plan ejecutable; [] en early-returns.
   *
   * HU-208: `ResolvedComposeStep[]` — el planner los construye a partir de
   * agentes YA resueltos por discovery (`orchestrate.ts` mapea `agent.slug`), así
   * que el tipo describe lo que el código ya garantizaba. Necesario además
   * porque estos steps se le pasan a `composeService.compose`.
   */
  steps: ResolvedComposeStep[];
  /** Precio resuelto server-side por step; [] en early-returns. */
  costPerStep: number[];
  /** sum(costPerStep) — informativo, NO base del débito. */
  totalCostUsdc: number;
  /** WKH-132: fee REAL cost-based = round(totalCostUsdc × getProtocolFeeRate()).
   *  Reconcilia con feeRatePercent por construcción. NO es el residual del techo.
   *  0 en early-returns. */
  protocolFeeUsdc: number;
  /** Cap del execute (§4.3.4 SDD); espejo de augmentX402ChallengeAmount. TECHO de
   *  seguridad: maxQuotedCostUsdc ≥ totalCostUsdc + protocolFeeUsdc (puede exceder
   *  cuando algún step aún no cotizó precio → PLACEHOLDER_FEE_USD headroom). */
  maxQuotedCostUsdc: number;
  reasoning: string;
  consideredAgents: Agent[];
  // Internos que executeApprovedPlan necesita del plan (el route NO los serializa
  // al cliente; el route hace pick de los públicos). Ver §6.
  plannedCostUsd: number;
  feeUsdc: number;
  usedFallback: boolean;
  debitFallback: boolean;
  /** Row billable del path master (undefined si deleg/session/x402). */
  billingKeyRow: A2AAgentKeyRow | undefined;
  /** discovered.agents — necesario para consideredAgents en execute. */
  discoveredAgents: Agent[];
  /**
   * Interno: balance leído en el no-funds early-return (read-only getBalance,
   * CD-1). Lo usa SOLO mapPlanEarlyReturnToOrchestrateResult para reconstruir
   * `remainingBudgetUsd` byte-idéntico al atómico. No se serializa al cliente.
   */
  remainingBudgetUsd?: string;
  /**
   * WKH-151 (telemetría additive): true si el broaden-retry sin-caps disparó en
   * planOrchestration. Viaja a executeApprovedPlan para marcar el evento
   * `orchestrate_goal` (confirma en bdwv que el retry resolvió el $0). Interno;
   * el route NO lo serializa al cliente.
   */
  broadenRetryUsed?: boolean;
  /**
   * WKH-151 (telemetría additive): agentes que trajo el retry sin-caps (null si
   * no hubo retry). Interno; NO se serializa al cliente.
   */
  retryAgentCount?: number | null;
}

export interface OrchestrateExecuteRequest extends OrchestrateRequest {
  /** El plan aprobado por el cliente (steps re-resueltos server-side, AC-4). */
  orchestrationId: string;
  /**
   * HU-208: `ResolvedComposeStep[]`. El JSON schema de la ruta ya exige
   * `agent: {type:'string', minLength:1}` en cada step (`routes/orchestrate.ts`),
   * así que el tipo refleja una invariante que Fastify ya hace cumplir en el
   * borde. `/orchestrate` NO acepta steps por capacidad en esta HU.
   */
  steps: ResolvedComposeStep[];
  /** Cap aprobado por el cliente; gate AC-3. */
  maxQuotedCostUsdc: number;
}

// ============================================================
// AGENT LINK TYPES (WKH-137 — invocation links)
// ============================================================

/**
 * Row de `a2a_agent_links`. Las columnas NUMERIC (`max_price_usdc`,
 * `consumed_cost_usdc`) llegan como `string` en runtime desde Supabase, aunque
 * el tipo generado las declare `number` (mismo criterio que KeySessionRow).
 */
export interface AgentLinkRow {
  id: string;
  token_hash: string;
  owner_ref: string;
  key_id: string;
  slug: string;
  registry: string | null;
  max_price_usdc: string;
  chain_id: number;
  status: 'open' | 'redeeming' | 'redeemed' | 'failed';
  redeemed_at: string | null;
  settle_tx_hash: string | null;
  consumed_cost_usdc: string | null;
  expires_at: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

/** Body del `POST /agents/:slug/link` (mint). `slug` sale del path, NUNCA de acá. */
export interface CreateAgentLinkInput {
  /** Cap de precio server-side (decimal > 0). */
  maxPriceUsdc: string;
  /** TTL en segundos (entero > 0, <= LINK_MAX_TTL_SECONDS). Opcional. */
  ttlSeconds?: number;
}

/** Response 201 del mint. El `token` viaja UNA sola vez (nunca recuperable). */
export interface MintAgentLinkResponse {
  link_id: string;
  token: string;
  slug: string;
  max_price_usdc: string;
  expires_at: string;
}

/**
 * Shape PÚBLICO del redeem (WKH-137, BLQ-1). El redeem es público (auth por
 * posesión del token); el redeemer es un tercero, NO el owner del link. Por eso
 * NO se le devuelve el `OrchestrateResult` completo — ese arrastra telemetría de
 * billing del owner (`remainingBudgetUsd`, `feeChargeError`, `feeChargeTxHash`,
 * `refundError`, `debitFallback`) que filtraría el saldo financiero de un tenant
 * ajeno (viola AC-7 / cross-tenant leak). Este shape acotado expone SOLO lo que
 * el canal externo necesita: id de orquestación, la respuesta del agente, el fee
 * de protocolo y el resultado (success + output) del pipeline.
 */
export interface RedeemResult {
  orchestrationId: string;
  /** Respuesta del agente (equivalente a OrchestrateResult.answer). */
  answer: unknown;
  /** Fee de protocolo cobrado por esta invocación (informativo). */
  protocolFeeUsdc: number;
  /** Resultado acotado del pipeline: éxito + output del agente. SIN steps/txHash
   *  ni telemetría de billing del owner. */
  pipeline: {
    success: boolean;
    output: unknown;
  };
}

/** Fila del link devuelta por el RPC `claim_agent_link` (open→redeeming). */
export interface AgentLinkClaim {
  id: string;
  owner_ref: string;
  key_id: string;
  slug: string;
  registry: string | null;
  max_price_usdc: string;
  chain_id: number;
}

// ============================================================
// DOWNSTREAM PAYMENT LOGGER (WKH-55)
// ============================================================

/**
 * Structural logger interface used by `signAndSettleDownstream` and any
 * caller that wants to plumb a Pino-like logger into the downstream
 * payment flow without taking a hard dependency on Pino itself.
 *
 * Canonical home (TD-WKH-55-4 / CR-MNR-3): defined here in `types/index.ts`
 * and consumed via re-export from `src/lib/downstream-payment.ts` and
 * `src/services/compose.ts` to avoid duplicate definitions.
 */
export interface DownstreamLogger {
  warn: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
}

// ============================================================
// PAYMENT TYPES (chain-agnostic)
// ============================================================

export interface PaymentAuth {
  xPayment: string; // Base64 encoded x402 payload
}

// ============================================================
// x402 PROTOCOL TYPES (Kite Testnet)
// ============================================================

/**
 * Payload dentro del array "accepts" de una respuesta 402.
 * Describe el pago que el cliente debe realizar.
 */
export interface X402PaymentPayload {
  scheme: string;
  network: string;
  /** Monto máximo requerido en wei */
  maxAmountRequired: string;
  /** URL del endpoint que requiere pago */
  resource: string;
  description: string;
  mimeType: string;
  outputSchema?: {
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
  };
  /** Wallet address del service provider que recibe el pago */
  payTo: string;
  maxTimeoutSeconds: number;
  /** Contract address del token de pago */
  asset: string;
  extra: null | Record<string, unknown>;
  merchantName: string;
}

/**
 * Body completo de una respuesta HTTP 402 conforme a x402.
 */
export interface X402Response {
  error: string;
  accepts: X402PaymentPayload[];
  x402Version: 2;
}

/**
 * Payload decodificado del header X-Payment (base64 JSON).
 * Generado por el cliente (wallet del pagador firmando EIP-712) al responder
 * a un 402 Payment Required. Ver `doc/architecture/CHAIN-ADAPTIVE.md` §L2
 * para cómo cada adapter de cadena verifica este payload.
 */
export interface X402PaymentRequest {
  authorization: {
    from: string; // Wallet address del pagador
    to: string; // Wallet address del service provider
    value: string; // Monto en wei
    validAfter: string; // Unix timestamp (string) — "0" si inmediato
    validBefore: string; // Unix timestamp (string) — deadline de expiración
    nonce: string; // 0x... nonce único para esta autorización
  };
  signature: string; // Firma EIP-712 del pagador
  network?: string; // "kite-testnet" (opcional)
}

// NOTE: Pieverse types used by kite-ozone adapter only. Will move to adapters/kite-ozone/types.ts post-hackathon.

/**
 * Request body para POST /v2/verify en Pieverse (v2 envelope).
 */
export interface PieverseVerifyRequest {
  paymentPayload: {
    x402Version: 2;
    scheme: string;
    network: string;
    payload: {
      authorization: X402PaymentRequest['authorization'];
      signature: string;
    };
  };
  paymentRequirements: {
    x402Version: 2;
    scheme: string;
    network: string;
    maxAmountRequired: string;
    payTo: string;
    asset: string;
    extra: null | Record<string, unknown>;
  };
}

/**
 * Response de POST /v2/verify en Pieverse.
 */
export interface PieverseVerifyResponse {
  valid: boolean;
  error?: string;
}

/**
 * Request body para POST /v2/settle en Pieverse (v2 envelope).
 */
export interface PieverseSettleRequest {
  paymentPayload: {
    x402Version: 2;
    scheme: string;
    network: string;
    payload: {
      authorization: X402PaymentRequest['authorization'];
      signature: string;
    };
  };
  paymentRequirements: {
    x402Version: 2;
    scheme: string;
    network: string;
    maxAmountRequired: string;
    payTo: string;
    asset: string;
    extra: null | Record<string, unknown>;
  };
}

/**
 * Response de POST /v2/settle en Pieverse.
 */
export interface PieverseSettleResult {
  txHash: string;
  success: boolean;
  error?: string;
}

// ============================================================
// AGENT CARD TYPES (Google A2A Protocol)
// ============================================================

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
}

export interface AgentCard {
  name: string;
  description: string;
  url: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    /** WKH-56: agent natively speaks Google A2A v1 (Message{role,parts}). */
    a2aCompliant?: boolean;
  };
  skills: AgentSkill[];
  inputModes: string[];
  outputModes: string[];
  authentication: {
    schemes: string[];
  };
  /** Explains that agent invocations must go through POST /compose or POST /orchestrate on the gateway */
  invocationNote?: string;
  /**
   * WKH-106 (BASE-03): JSON Schema describing the agent's input shape.
   * Surfaced ONLY when `agent.metadata.discoverable === true` (CD-1 opt-in).
   * Non-breaking extension — consumers that don't understand the field MUST
   * ignore it (DT-6).
   *
   * Validated at build-time via `declareDiscoveryExtension` from
   * `@x402/extensions/bazaar` + AJV `ajv.compile()` for syntactic JSON
   * Schema correctness. If validation fails, the route handler MUST return
   * HTTP 422 (CD-7).
   */
  inputSchema?: Record<string, unknown>;
  /**
   * WKH-106 (BASE-03): JSON Schema describing the agent's output shape.
   * Same opt-in semantics and validation rules as `inputSchema`.
   */
  outputSchema?: Record<string, unknown>;
  /**
   * WKH-100 (AC-8): ERC-8004 verified identity. Surfaced ONLY when the agent
   * has a bound, on-chain-verified Agent Key identity. Non-breaking optional
   * extension — consumers that don't understand it MUST ignore it (DT-6).
   */
  identity?: AgentCardIdentity;
  /** WKH-103 (AC-5): reputación computada. Non-breaking optional extension. */
  computedReputation?: AgentReputation;
  /**
   * WKH-141: APP-compatible payment intents declaration. Non-breaking optional
   * extension — consumers que no la entienden la ignoran (DT-6). alignment/disclaimer
   * NO opcionales: honestidad horneada (AC-6/CD-3).
   */
  paymentIntents?: {
    vocabulary: 'app';
    supported: AppIntentName[];
    alignment: 'conceptual';
    disclaimer: string;
  };
}

// ============================================================
// APP BRIDGE TYPES (WKH-141) — outbound declaration + internal mapping
// ============================================================

/**
 * WKH-141: vocabulary de intents de APP (OKX Agent Payments Protocol) que el
 * gateway puede settlear. SOLO estos 3 (CD-8: `escrow` NUNCA se declara).
 */
export type AppIntentName = 'charge' | 'session' | 'upto';

/**
 * WKH-141: sobre versionado con vocabulario APP producido por el mapper interno
 * puro. `vocabulary`/`envelopeVersion`/`intent`/`alignment`/`disclaimer` NO son
 * opcionales — la honestidad del alineamiento conceptual está horneada en el tipo
 * (AC-6/CD-3). Los opcionales se ASIGNAN condicionalmente (CD-7).
 */
export interface AppIntentEnvelope {
  vocabulary: 'app';
  envelopeVersion: string;
  intent: AppIntentName;
  alignment: 'conceptual';
  status?: 'settled' | 'failed' | 'in_progress' | 'challenge' | undefined;
  amountUsd?: number | undefined;
  chainId?: number | undefined;
  txHash?: string | null | undefined;
  expiresAt?: string | undefined;
  disclaimer: string;
}

/**
 * WKH-141: descriptor estático de un intent soportado, para poblar el Agent Card.
 */
export interface AppIntentDescriptor {
  intent: AppIntentName;
  alignment: 'conceptual';
}

/**
 * WKH-141: input allow-listed para `mapChargeToApp`. SOLO campos no sensibles —
 * NUNCA ownerRef/buyerWallet/keyId/sellerRef/payTo/capSignature/funding_wallet/
 * typedData/budget/error interno (CD-6).
 */
export interface ChargeMapInput {
  status?: 'settled' | 'failed' | 'in_progress' | 'challenge' | undefined;
  amountUsd?: number | undefined;
  chainId?: number | undefined;
  txHash?: string | null | undefined;
}

/**
 * WKH-141: input allow-listed para `mapSessionToApp` (CD-6).
 */
export interface SessionMapInput {
  status?: 'settled' | 'failed' | 'in_progress' | 'challenge' | undefined;
  amountUsd?: number | undefined;
  chainId?: number | undefined;
  txHash?: string | null | undefined;
  expiresAt?: string | undefined;
}

/**
 * WKH-141: input allow-listed para `mapUptoToApp` (CD-6).
 */
export interface UptoMapInput {
  status?: 'settled' | 'failed' | 'in_progress' | 'challenge' | undefined;
  amountUsd?: number | undefined;
  chainId?: number | undefined;
  txHash?: string | null | undefined;
  expiresAt?: string | undefined;
}

// ============================================================
// TASK TYPES (Google A2A Protocol)
// ============================================================

export const TASK_STATES = [
  'submitted',
  'working',
  'completed',
  'failed',
  'canceled',
  'input-required',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_STATES: readonly TaskState[] = [
  'completed',
  'failed',
  'canceled',
] as const;

export interface Task {
  id: string;
  contextId: string | null;
  status: TaskState;
  messages: unknown[];
  artifacts: unknown[];
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================
// EVENT TYPES (WKH-27 Dashboard)
// ============================================================

export interface A2AEvent {
  id: string;
  eventType: string;
  agentId: string | null;
  agentName: string | null;
  registry: string | null;
  status: 'success' | 'failed';
  latencyMs: number | null;
  costUsdc: number;
  txHash: string | null;
  goal: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface AgentSummary {
  agentId: string;
  agentName: string;
  registry: string;
  invocations: number;
  avgLatencyMs: number;
  totalCostUsdc: number;
}

export interface DashboardStats {
  registriesCount: number;
  tasksByStatus: Record<string, number>;
  eventsTotal: number;
  successRate: number;
  totalCostUsdc: number;
  avgLatencyMs: number;
  agents: AgentSummary[];
}

// ============================================================
// GASLESS TYPES (WKH-29 — EIP-3009)
// ============================================================

export interface GaslessSupportedToken {
  network: 'testnet' | 'mainnet';
  symbol: string; // "PYUSD"
  address: `0x${string}`; // 0x8E04...2ec9
  decimals: number; // 18
  eip712Name: string; // "PYUSD"
  eip712Version: string; // "1"
  minimumTransferAmount: string; // wei string ("10000000000000000")
}

export interface GaslessTransferRequest {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string; // wei
  validAfter: string; // unix seconds (string)
  validBefore: string; // unix seconds (string)
  tokenAddress: `0x${string}`;
  nonce: `0x${string}`; // 0x + 32 random bytes
  v: number;
  r: `0x${string}`;
  s: `0x${string}`;
}

export interface GaslessTransferResponse {
  txHash: `0x${string}`;
}

export type GaslessFundingState =
  | 'disabled'
  | 'unconfigured'
  | 'unfunded'
  | 'ready';

export interface GaslessStatus {
  enabled: boolean;
  network: string;
  supportedToken: GaslessSupportedToken | null;
  operatorAddress: `0x${string}` | null; // NUNCA private key
  /** Degradation state: disabled | unconfigured | unfunded | ready (WKH-38) */
  funding_state: GaslessFundingState;
  /** Chain ID for the gasless network */
  chain_id?: number;
  /** Gasless relayer base URL */
  relayer?: string;
  /** Documentation link */
  documentation?: string;
}

// ============================================================
// A2A PROTOCOL TYPES (Google A2A v1 — WKH-56)
// ============================================================

/** Discriminated union por kind. Google A2A v1. */
export type A2APart = A2ATextPart | A2ADataPart | A2AFilePart;

export interface A2ATextPart {
  kind: 'text';
  text: string;
}

export interface A2ADataPart {
  kind: 'data';
  data: unknown;
}

export interface A2AFilePart {
  kind: 'file';
  file: {
    name?: string;
    mimeType?: string;
    bytes?: string; // base64
    uri?: string;
  };
}

export interface A2AMessage {
  /** Optional client-side correlator. NO se valida en isA2AMessage. */
  messageId?: string;
  role: 'agent' | 'user' | 'tool';
  parts: A2APart[]; // non-empty (validado en isA2AMessage)
}

// ============================================================
// BRIDGE TYPES (WKH-56)
// ============================================================

export type BridgeType =
  | 'A2A_PASSTHROUGH'
  | 'SKIPPED'
  | 'CACHE_L1'
  | 'CACHE_L2'
  | 'LLM';

// ============================================================
// PAYMENT INTENTS (WKH-135) — `session` (metered) + `upto` (dual-signed cap)
// ============================================================

/** Row de a2a_payment_intents (dominio). NUMERIC → number desde el RPC. */
export interface PaymentIntentRow {
  id: string;
  intent_type: 'session' | 'upto';
  owner_ref: string;
  key_id: string;
  buyer_wallet: string | null;
  seller_ref: string;
  pay_to: string;
  chain_id: number;
  authorized_usd: number;
  consumed_usd: number;
  cap_signature: string | null;
  cap_nonce: string | null;
  status: 'open' | 'closing' | 'settled' | 'refunded' | 'expired' | 'failed';
  settle_tx_hash: string | null;
  residual_usd: number | null;
  expires_at: string;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

/** Row de a2a_payment_vouchers (ledger append-only, solo session). */
export interface PaymentVoucherRow {
  id: string;
  intent_id: string;
  owner_ref: string;
  voucher_id: string;
  amount_usd: number;
  voucher_signature: string | null;
  created_at: string;
}

/** Domain EIP-712 del cap `upto` (mirror de DelegationEip712Domain). */
export interface UptoEip712Domain {
  name: string;
  version: string;
  chainId: number;
}

/** Mensaje EIP-712 del cap (primaryType = "UptoCap"). */
export interface UptoCapMessage {
  seller_ref: string;
  cap: string; // decimal USD como string (sin float64)
  chain_id: number; // uint256
  nonce: `0x${string}`; // bytes32 hex
  expires_at: number; // uint64 epoch seconds
}

/** typed-data completo del cap `upto` recibido del cliente. */
export interface UptoCapTypedData {
  domain: UptoEip712Domain;
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  primaryType: string; // debe ser 'UptoCap'
  message: UptoCapMessage;
}

/** Input de openSession (paymentIntentService). intentId server-side (CD-1). */
export interface OpenSessionInput {
  intentId: string;
  keyId: string;
  ownerRef: string;
  buyerWallet: string | null;
  sellerRef: string;
  payTo: string;
  chainId: number;
  depositUsd: number;
  ttlSeconds?: number;
}

/** Input de addVoucher (idempotente por voucherId). */
export interface AddVoucherInput {
  intentId: string;
  ownerRef: string;
  voucherId: string;
  amountUsd: number;
}

/** Input de createUpto (cap dual-firmado, NO reserva). */
export interface CreateUptoInput {
  intentId: string;
  keyId: string;
  ownerRef: string;
  buyerWallet: string; // funding_wallet (ancla de la firma, no-null)
  sellerRef: string;
  payTo: string;
  chainId: number;
  capUsd: number;
  capSignature: string;
  capNonce: string;
  typedData: UptoCapTypedData;
}

/**
 * Resultado del settle on-chain (seam WKH-136). `finalAmountUsd` = el monto
 * cobrado al seller. Los campos session (consumed/residual) y upto (cappedAt)
 * los completa closeSession/settleUpto respectivamente. CD-7: nunca throw.
 */
export interface SettleOutcome {
  /**
   * 'in_progress' (BLQ-MED-1): un close/settle concurrente aterrizó sobre un intent
   * 'closing' cuyo veredicto AÚN no se persistió (settle_outcome=NULL) = otro caller
   * está settleando in-flight. NO se finaliza ni se mueve dinero; el caller in-flight
   * (o expireStale tras CLOSING_STALE_SECONDS) lo completa con el veredicto real.
   */
  status: 'settled' | 'failed' | 'in_progress';
  txHash: string | null;
  finalAmountUsd: number;
  consumedUsd?: number | undefined;
  residualUsd?: number | undefined;
  cappedAt?: boolean | undefined;
  error?: string | undefined;
  /**
   * Sólo definido cuando status==='failed'. Discrimina el subcaso money-path
   * (BLQ-ALTO-1) para decidir si el débito/deposit se puede refundar:
   *   - 'unequivocal': ninguna tx se envió/confirmó (el sign() lanzó o
   *     settle.success===false) → es CIERTO que NO hubo transfer → refund seguro
   *     (invariante budget_post == budget_pre).
   *   - 'ambiguous': el transfer PUDO ocurrir on-chain (el settle() lanzó tras un
   *     posible broadcast, o verifyDefaultChainSettle contradijo el settle) → NO
   *     refundar (evita doble-gasto); el caller lo marca reconciliable + log.warn.
   */
  failureKind?: 'unequivocal' | 'ambiguous' | undefined;
}

// ============================================================
// A2A AGENT KEY TYPES (WKH-34)
// ============================================================

export * from './a2a-key.js';
