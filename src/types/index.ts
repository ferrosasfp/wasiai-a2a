/**
 * WasiAI A2A Protocol — Types
 */

// AR MENOR-6: `StepResult.downstreamSettle` se tipa con el vocabulario PÚBLICO
// de skip-codes en vez de `string`. Es un ciclo de tipos con
// `lib/downstream-skip-code.ts` (que importa `DownstreamLogger` de acá), pero
// `import type` se borra en runtime → no hay ciclo de módulos real.
import type {
  DownstreamSkipCode,
  PublicDownstreamSkipCode,
} from '../lib/downstream-skip-code.js';
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
    /**
     * WKH-318: techo de `limit` que este registro acepta, DECLARADO por el
     * registrante.
     *
     * Desde el corte B lo lee `queryRegistry`, y sólo ahí. Las tres ramas:
     *
     * · **Declarado y usable** (entero `>= 1`) ⇒ el límite que sale por la red
     *   es `min(over-fetch, maxLimit)`. Input: `maxLimit: 100` +
     *   `discover({ limit: 500 })` ⇒ se envía `?limit=100`.
     * · **Ausente** ⇒ NO se clampea nada, comportamiento byte-idéntico al
     *   anterior al corte B. No hay default: `100` es el techo de un servidor
     *   concreto, no un estándar, y aplicarlo a un registro que acepta 1000
     *   recortaría su pool de ranking en silencio.
     * · **Declarado e inválido** (`"100"`, `0`, `-5`, `1.5`, `null`, `{}` — la
     *   columna es `jsonb` y el write-path de `POST /registries` no valida) ⇒
     *   tampoco se clampea, y se emite `warn REGISTRY_MAX_LIMIT_INVALID`. No
     *   falla cerrado: con `maxLimit: 0`, mandar `?limit=0` vaciaría el catálogo
     *   en silencio. `undefined` (ausencia) NO warnea; `null` (declaración
     *   basura) sí.
     *
     * ⚠️ Residual honesto (TD-318B-1): esto NO cierra el truncamiento silencioso
     * en general, sólo para los registros que declaran el campo. Input que lo
     * demuestra: un registro SIN `maxLimit` que recibe `limit=200`, devuelve 100
     * filas y no manda cursor ⇒ `100 < 200` ⇒ `completenessProven = true` ⇒
     * `state: 'ok'`, exactamente como antes, aunque haya clampeado en silencio.
     */
    maxLimit?: number;
    /**
     * WKH-318: path (dot-notation, `getNestedValue`) al cursor de paginación en
     * la respuesta del registro. Cuando está declarado Y llega no-nulo, la
     * fuente se reporta `truncated` con evidencia `cursor` (exacta). No se
     * pagina (TD-318-2): se DETECTA.
     */
    nextCursorPath?: string;
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
  /**
   * ⚠️ EL NOMBRE MIENTE — leer antes de usarlo. `contract` NO es un contrato ni un
   * token: es **la dirección de la billetera que COBRA** (el `payTo` del leg de
   * salida). El valor va tal cual al destinatario del transfer:
   * `downstream-payment.ts:772` lo pasa por `validatePayTo` y `:922` lo firma como
   * `to`. Poner acá la dirección de un token manda el pago al contrato del token.
   *
   * QUÉ NO ES:
   *  · NO es el mint / la dirección del token. El token lo fija el adapter de la
   *    chain (`adapters/<chain>/payment.ts`), NO la ficha del agente.
   *  · `asset` (abajo) tampoco lo elige: es sólo una etiqueta pass-through
   *    (`'USDC'`) que ningún camino de dinero lee.
   *
   * El nombre se conserva porque es campo de una respuesta PÚBLICA que consumen
   * otros servicios y agentes ya publicados (`/discover`): renombrarlo es un
   * cambio de contrato con costo para terceros. Esta confusión ya produjo un
   * bloqueante rojo FALSO (se leyó el valor como identificador del token, no
   * existía como token, y parecía un bug de producción).
   *
   * WKH-234: namespace-aware. EVM = `0x${string}`; Solana = pubkey base58 del
   * dueño de la cuenta que cobra. La validación de FORMA vive en `wallet-format`
   * (`isValidPayoutWallet`) / `validatePayTo` — este tipo sólo relaja la forma.
   */
  contract: `0x${string}` | string; // payTo: billetera de cobro, NO el token
  /** Etiqueta del símbolo declarado (e.g. 'USDC'). Pass-through: no decide nada. */
  asset?: string | undefined;
  /**
   * Rail CANÓNICO al que el gateway resuelve `chain` (`normalizeChainSlug`).
   * DERIVADO por el gateway, no declarado: el agente sigue escribiendo lo que
   * escribía y ninguna ficha publicada cambia.
   *
   * Existe porque `chain` es lo que el agente ESCRIBIÓ, y varios alias no dicen su
   * entorno: hoy 16 de los 25 agentes del catálogo vivo declaran `avalanche`, que
   * a un lector le suena a la red real y resuelve a `avalanche-fuji`.
   */
  resolvedChain?: string | undefined;
  /**
   * Entorno del rail de `resolvedChain`. DERIVADO por el gateway.
   *
   * GARANTÍA (falsable, y con un guard que la sostiene): o el pago cae en ESTE
   * entorno, o no hay pago. El leg downstream compara el entorno del slug contra
   * el destino REAL del bundle antes de firmar y, si no coinciden, no paga
   * (`findChainEnvironmentDrift` → `CHAIN_ENVIRONMENT_DRIFT`,
   * `downstream-payment.ts:711-735`, `return null`).
   *
   * Lo que NO afirma: no dice a qué chainId apunta el deploy. Eso puede derivar
   * por config (p. ej. `KITE_NETWORK`), y ese caso es justamente el que el guard
   * corta en vez de pagar.
   *
   * ⚠️ POR QUÉ LOS DOS SON OPCIONALES, y qué NO significa. Esta misma interfaz
   * describe también la ficha CRUDA que declara el agente, donde estos campos no
   * existen (así la construyen los fixtures de test). En el camino de PRODUCCIÓN
   * no faltan nunca: `readPaymentSpec` es el ÚNICO productor de `Agent.payment`
   * (`payment-spec-reader.ts`, consumido por `discovery.mapAgent` y
   * `agent.mapRowToAgent`) y los setea siempre. Falsable: sería falso si un
   * agente de `/discover` con bloque `payment` no trajera `network` — lo fija
   * `payment-spec-reader.test.ts`.
   */
  network?: 'testnet' | 'mainnet' | undefined;
}

/**
 * WKH-316 — lo que un agente DECLARA al publicar por API (`POST /agents` /
 * `PATCH /agents/:slug`). Es el lado ESCRITOR del bloque `payment`; el lector
 * (`readPaymentSpec`) ya existía desde WKH-241.
 *
 * NO es `AgentPaymentSpec` (arriba): ese tipo tiene además `resolvedChain` y
 * `network`, que los DERIVA el gateway en cada lectura
 * (`lib/payment-spec-reader.ts:212-213`) y que el caller NO puede escribir. Por
 * eso este tipo tiene 4 campos y aquél 6: si el input los aceptara, un caller
 * podría dejar `resolvedChain: 'avalanche-mainnet'` envenenado dentro del JSONB
 * `a2a_agents.metadata` — `/discover` no cambiaría (el lector los recomputa
 * siempre), pero el valor quedaría ahí para todo consumidor del bloque crudo.
 *
 * El validador de estos 4 campos es `lib/payment-spec-writer.ts`
 * (`validatePaymentBlock`), único choke-point del write path.
 */
export interface AgentPaymentSpecInput {
  /** Debe ser EXACTAMENTE `'x402'`: sin trim, sin lowercase. */
  method: string;
  /** Alias de chain que `normalizeChainSlug` conozca Y riel inicializado. */
  chain: string;
  /**
   * ⚠️ EL NOMBRE MIENTE — es la BILLETERA DE COBRO (el `payTo`), NO un token ni
   * un contrato. El porqué del nombre, y el bloqueante rojo falso que ya
   * produjo, están en el docblock de `AgentPaymentSpec.contract` (`:203-225`).
   */
  contract: string;
  /** Etiqueta. Se compara case-insensitive con `supportedTokens[0].symbol`. */
  asset?: string;
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
  /**
   * WKH-316: bloque `payment` declarado. Opcional — omitirlo se comporta
   * byte-idéntico a hoy. NO se deriva de `payoutWallet`/`payoutChain` ni al
   * revés: `payoutWallet` es la pata del creator-split, `payment.contract` es
   * el payTo del precio completo.
   */
  payment?: AgentPaymentSpecInput;
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
  /**
   * WKH-316: bloque `payment` declarado.
   *
   * Los tres estados son distintos y NO se pueden colapsar:
   *  · ausente / `undefined` → no se toca el bloque que ya haya;
   *  · objeto → se valida y se reemplaza;
   *  · `null` EXPLÍCITO → se BORRA la key `payment` de `metadata`.
   */
  payment?: AgentPaymentSpecInput | null;
  /**
   * BAJA / ALTA del agente (`a2a_agents.enabled`). `false` lo saca de circulación:
   * deja de aparecer en `/discover` y deja de ser elegible en `/compose`.
   *
   * POR QUÉ EXISTE ESTE CAMPO. La columna `enabled` ya estaba, y el lado LECTOR ya
   * la respetaba en las tres queries que alimentan discovery
   * (`services/agent.ts` `listAsAgents` / `getBySlugAsAgent` / `listPublisherAnchors`),
   * pero NO había ningún productor: `publish` la escribe `true`
   * (`services/agent.ts:399`) y ningún camino la podía volver a `false`. Era un
   * control cableado del lado que lee y sin nadie del lado que escribe: un agente
   * self-published nacía activo y la única baja posible era DESTRUCTIVA
   * (`DELETE /agents/:slug`), que además de borrarlo pierde su `created_at` (ancla
   * del carril de estreno) y su `payout_wallet`, y libera el slug para que lo tome
   * otro. Esto es la baja REVERSIBLE que faltaba.
   *
   * El ownership NO necesita código nuevo: el `UPDATE` de `update()` ya filtra por
   * `.eq('slug', …).eq('owner_ref', …)` y el pre-fetch ya rechaza cross-owner con
   * `OwnershipMismatchError` → 404 disclosure-safe.
   */
  enabled?: boolean;
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
  /**
   * AR fix-pack BLQ-MED-2 — CALLERS DISTINTOS con al menos un `failed`.
   *
   * ⚠️ Los eventos SIN `caller_ref_hash` NO cuentan acá. El bucket `'__anon__'`
   * se EXCLUYE (`reputation.ts:189`, CR MNR-2), y esto es lo contrario de lo
   * que hace el cap anti-sybil, que sí lo agrupa. La razón: una llamada x402
   * anónima no exige registrarse, así que si el anónimo contara, un atacante con
   * UNA identidad más llamadas anónimas juntaría dos buckets y anularía el carril
   * igual. Excluirlo es lo que hace que el ataque cueste dos identidades
   * registradas distintas y no una.
   *
   * Es el contador que ANULA el carril de estreno, y es distinto de `failedCount`
   * a propósito: con el crudo, UN solo fallo transitorio (el agente caído treinta
   * segundos, un timeout de red) mataba el carril PARA SIEMPRE, y un tercero podía
   * quemárselo a un competidor con una sola llamada barata. `failedCount` se
   * conserva intacto porque es lo que alimenta `success_rate` en la fórmula del
   * score, que no se toca.
   */
  failedCallerCount: number;
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

// ============================================================
// WKH-318 — HONESTIDAD DEL CATÁLOGO FEDERADO
// ============================================================

/**
 * Cuatro estados por fuente. Un booleano ya habría perdido el tercero; el cuarto
 * lo perdía el triplete, y es el que se lleva el caso REAL de producción.
 *
 * `ok` exige EVIDENCIA POSITIVA de completitud. No alcanza con que la fuente
 * haya contestado: hay que poder demostrar que lo que trajo es todo lo que tenía
 * para esta query. Hoy esa prueba puede venir de dos lados, y de ninguno más:
 *
 *   · el registro declara `nextCursorPath` y el cursor llega vacío ⇒ él mismo
 *     dice "no hay más" (exacto);
 *   · se le envió un límite y devolvió MENOS filas que ese límite ⇒ la página no
 *     se llenó, así que no quedó nada afuera.
 *
 * Sin ninguna de las dos, el estado es `unverified` — NO `ok`. Es el caso que el
 * AR midió: el registro real se siembra sin `nextCursorPath`
 * (`20260401000000_kite_registries.sql:44-66`) y `/capabilities` llama a
 * `discover({})` sin `limit`, así que no se manda `limitParam`. Ahí no hay
 * evidencia OBTENIBLE, y afirmar `ok`/`complete` es exactamente la clase de
 * mentira que esta HU existe para matar: la respuesta afirmaría más de lo que la
 * evidencia sostiene, sobre 20 de 22 agentes.
 */
export type DiscoverySourceState =
  /** respondió, y hay EVIDENCIA de que lo que trajo es todo lo que tiene */
  | 'ok'
  /** respondió, y hay EVIDENCIA de que hay más filas que NO trajimos */
  | 'truncated'
  /**
   * respondió, pero NO hay forma de saber si trajo todo. No es una sospecha de
   * truncamiento: es la ausencia de evidencia en las dos direcciones, y decirlo
   * es más honesto que elegir una.
   */
  | 'unverified'
  /** NO se la pudo consultar */
  | 'failed';

export type DiscoverySourceFailure =
  | 'http_error'
  | 'timeout'
  | 'ssrf_blocked'
  | 'circuit_open'
  | 'bad_payload'
  | 'unknown';

export interface DiscoverySource {
  name: string;
  state: DiscoverySourceState;
  /**
   * Filas que la fuente aportó al conjunto candidato, ANTES de los filtros
   * locales (status/verified/caps/free-text/maxPrice/scope/minReputation).
   *
   * `null` cuando `state === 'failed'` — NUNCA 0 (CD-14). Un 0 significa "le
   * pregunté y no tiene"; `null` significa "no pude preguntarle". En
   * `unverified` hay número: la fuente contestó y esas filas entraron; lo que no
   * se sabe es si eran todas.
   *
   * POR QUÉ PRE-FILTRO: medido en producción, `?capabilities=remit.quote&limit=10`
   * devuelve 0 agentes con las dos fuentes sanas. Si "aportó" se contara
   * post-filtro, una query selectiva reportaría fuentes desaparecidas y el
   * caller leería degradación donde sólo hubo un filtro.
   */
  rows: number | null;
  /** Sólo cuando `state === 'failed'`. */
  failure?: DiscoverySourceFailure;
  /** Sólo cuando `state === 'truncated'`. `cursor` es exacta; `page_full` es heurística. */
  truncationEvidence?: 'cursor' | 'page_full';
}

/**
 * Roll-up de request. El mismo cuarteto, un nivel más arriba.
 *
 * `complete` significa "TODAS las fuentes probaron haber dado todo", no "ninguna
 * se quejó". Si una sola no pudo probarlo, el roll-up es `unverified`: el caller
 * se entera de que la respuesta no alcanza para afirmar completitud, que es
 * distinto de saber que falta algo.
 */
export type CatalogStatus = 'complete' | 'unverified' | 'truncated' | 'partial';

/** Referencia mínima de una fuente caída, para los cuerpos de error del money-path. */
export interface FailedSourceRef {
  name: string;
  failure: DiscoverySourceFailure;
}

/**
 * Lo que `queryRegistry` devuelve ahora. Antes devolvía `Agent[]` y toda la
 * información sobre CÓMO le fue a la fuente se perdía en el `.catch(() => [])`
 * del fanout.
 */
export interface RegistryFetchOutcome {
  agents: Agent[];
  state: DiscoverySourceState;
  rows: number | null;
  failure?: DiscoverySourceFailure;
  truncationEvidence?: 'cursor' | 'page_full';
}

/**
 * HU-323 — el valor publicado de `total`, con su tercer estado.
 *
 * `'unknown'` (string, TRUTHY) y no `null`/campo ausente, por la misma razón por
 * la que `/health` publica `strandedExposureBreached: 'unknown'` en vez de omitir
 * el campo cuando el umbral está puesto pero es ilegible (`services/stranded-alert.ts`,
 * commit bfe9a55): un valor falsy o un campo que desaparece se leen como "no hay
 * problema" — `total ?? 0` y `total || 0` darían **0**, que es una afirmación
 * MÁS falsa que el número recortado que se está sacando. Truthy obliga a que
 * quien lo consuma se entere.
 *
 * Sigue existiendo un número para quien necesita uno: `DiscoveryResult.totalAtLeast`.
 */
export type ReportedTotal = number | 'unknown';

export interface DiscoveryResult {
  agents: Agent[];
  /**
   * Matches de TODOS los filtros, PRE-`limit` (denominador de paginación), o
   * `'unknown'` cuando el catálogo se sabe INCOMPLETO y por lo tanto nadie puede
   * saber el total sin paginar.
   *
   * ⚠️ HU-323 — POR QUÉ ESTE CAMPO PUEDE NO SER UN NÚMERO. Antes era
   * `allAgents.length` SIEMPRE, incluso con `catalogStatus: 'truncated'`. Medido
   * en producción el 2026-08-04: `GET /discover` devolvía `total: 23` sobre un
   * catálogo de 25, porque la fuente federada había cortado en su página default
   * de 20. Al lado de `catalogStatus: 'truncated'` eso no es una mentira, pero es
   * ambiguo: un cliente que lee sólo `total` se lleva 23 como si fuera el total.
   * Rellenar un dato desconocido con el que hay a mano es exactamente lo que la
   * doctrina de este repo prohíbe.
   *
   * CUÁNDO es `'unknown'`, y quién lo decide: `resolveReportedTotal`
   * (`lib/discovery-sources.ts`) es la ÚNICA expresión de la regla — un
   * `catalogStatus` que PRUEBA que falta algo (`truncated`: una fuente declaró
   * que hay más filas; `partial`: una fuente no se pudo consultar).
   * `unverified` NO entra: ahí no hay evidencia de que falte nada, sólo falta de
   * evidencia de que no falte, y hacerlo `'unknown'` dejaría a `total` sin número
   * en casi todo camino que no declare cursor.
   */
  total: ReportedTotal;
  /**
   * HU-323 — COTA INFERIOR del total: los matches que efectivamente se contaron.
   * SIEMPRE un número, y siempre `total >= totalAtLeast` en el sentido de la
   * realidad (`total === totalAtLeast` cuando `total` es un número).
   *
   * Es, byte por byte, el valor que `total` traía antes de esta HU. Existe para
   * que sacarle el número a `total` no pierda información y para que el
   * consumidor que necesita un entero (una barra de progreso, un log) tenga uno
   * cuyo NOMBRE ya dice que es una cota y no un total.
   *
   * También es el que consume la lógica interna: el gate del broaden-retry de
   * WKH-157 (`services/discovery.ts`) preguntaba `result.total === 0` y ahora
   * pregunta `result.totalAtLeast === 0` — la MISMA expresión sobre el MISMO
   * número, para que el backstop del flujo estrella no cambie de conducta por un
   * cambio de presentación.
   */
  totalAtLeast: number;
  /**
   * WKH-318: las fuentes que **aportaron filas** al conjunto candidato, NO las
   * fuentes configuradas. El tipo (`string[]`) y el nombre no cambian; el valor
   * **sólo se acorta cuando una fuente realmente no aportó nada**.
   *
   * ⚠️ CR MNR-C: acá decía además "en el camino sano el valor es byte-idéntico".
   * Es FALSO, y lo prueba `T-SRC-02`: un registro habilitado que responde 200 con
   * `[]` es camino sano —no falló nada— y aun así sale de la lista, porque no
   * aportó filas. La frase venía del §2.1 del story file, que se contradice con
   * la advertencia de su propio W1.3; manda la específica. Lo que sí es
   * byte-idéntico es el camino en el que **todas** las fuentes aportan.
   */
  registries: string[];
  /** WKH-318: estado POR FUENTE. Requerido: ningún constructor puede omitirlo. */
  sources: DiscoverySource[];
  /**
   * WKH-318: roll-up. Precedencia
   * `partial` > `truncated` > `unverified` > `complete`.
   * Sin ninguna fuente consultada ⇒ `complete`: no hay nada que haya fallado ni
   * nada cuya completitud haya quedado sin probar.
   */
  catalogStatus: CatalogStatus;
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
     *     `trial` en `agents` (T-17) — SALVO con slugs repetidos entre
     *     registries, donde puede quedar POR DEBAJO de la cantidad de badges (el
     *     conjunto de admitidos se indexa por slug pelado; residual MNR-8 en el
     *     `residuales.md` de la HU);
     *   · sin `allowTrial` es una COTA SUPERIOR (pre-cupo): CD-9 prohíbe la
     *     query del ancla de publicación en el camino por defecto, y sin anclas
     *     el cupo `M` por publicador no se puede aplicar.
     * Un contador que a veces es exacto y a veces una cota, sin decirlo, es la
     * clase de dato que se lee mal.
     *
     * ⚠️ Y HAY UN TERCER CASO, que este docstring no nombraba y que el número no
     * distinguía: **sin `minReputation` el carril NO SE EVALÚA** y esto queda en
     * su `0` inicial. Ese `0` no es exacto ni una cota: es "nunca se calculó".
     * Leerlo requiere mirar `trialEvaluated` primero — ver ahí.
     */
    trialAvailable: number;
    /**
     * ¿Se evaluó el carril de estreno en esta consulta?
     *
     * `false` ⟺ el caller NO mandó `minReputation`. El bloque que aplica el piso
     * es el mismo que lee `allowTrial` (`services/discovery.ts`, guard
     * `if (query.minReputation != null)`), así que sin piso **`allowTrial` no
     * ejecuta nada**: viaja, se acepta, y el carril no corre.
     *
     * POR QUÉ ES UN CAMPO Y NO UN DETALLE. Sin esto, un caller que mandó
     * `allowTrial: true` recibía `trialAvailable: 0` y no tenía forma de
     * distinguir "miré y ninguno califica" de "no miré". Son dos acciones
     * distintas: en el primer caso no hay nada que hacer y en el segundo hay que
     * mandar TAMBIÉN `minReputation`. Es el mismo tercer valor que
     * `standingUnavailable` cubre para el otro "no pude": un `0` fabricado se lee
     * como una respuesta.
     *
     * El costo de no tenerlo está medido: el integrador de Chaski tuvo que leer
     * el fuente del gateway para descubrir que su parámetro era letra muerta
     * (`chaski-v3/src/infrastructure/a2a/gateway-client.ts`, comentario de
     * `FX_MIN_REPUTATION`: «Medido en el gateway, no asumido»).
     *
     * ⚠️ NO dice si el caller pidió el carril: dice si el gateway lo evaluó. Con
     * `allowTrial` ausente y `minReputation` presente vale `true`, y ahí
     * `trialAvailable` es la cota superior de siempre.
     */
    trialEvaluated: boolean;
    /**
     * AR fix-pack BLQ-BAJO-4 — la lectura del HISTORIAL falló
     * (`AgentStandingBatch.degraded`). Sin este dato, un batch degradado deja a
     * TODOS los agentes sin score, el filtro los cuenta 0 y los excluye a todos, y
     * el conjunto vacío se explica como "ninguno alcanza el `min_reputation` que
     * pediste" — que es una afirmación sobre los agentes cuando la verdad es una
     * sobre el gateway: "no pude preguntar".
     *
     * Es exactamente el defecto de clase que esta HU existe para cerrar (el AC del
     * vacío que se explica), reaparecido DENTRO del diagnóstico. Con `true`, el
     * número de `reputation` sigue siendo real (esos agentes SÍ se excluyeron) pero
     * el motivo que se le cuenta al consumidor cambia.
     *
     * Se llama `standingUnavailable` y no `degraded` a propósito: `degraded` es el
     * nombre del campo INTERNO del batch, que no sale nunca en la respuesta (T-16).
     */
    standingUnavailable: boolean;
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
   * Array PRESTADO por el caller para recibir el motivo INTERNO de cada leg
   * downstream que NO se pagó (uno por step salteado, en orden de ejecución).
   *
   * POR QUÉ ES UN INPUT Y NO UN CAMPO DEL `ComposeResult`. Los dos routes hacen
   * `reply.send({ …, ...result })` sin schema de respuesta, así que TODO lo que
   * viva en el resultado sale por HTTP al caller — y estos códigos son
   * justamente los que `toPublicSkipCode` genericiza para no filtrar flags,
   * allow-list de mainnet ni estado de la wallet del operador. Prestando el
   * array la fuga es imposible POR CONSTRUCCIÓN: no hay nada que borrar antes de
   * responder ni un route futuro que se pueda olvidar de borrarlo.
   *
   * Es el mismo patrón (y por el mismo tipo de razón) que el `results` prestado
   * de `composeService.execute`, documentado en `services/compose.ts`.
   *
   * Ausente ⟹ compose no anota nada y el comportamiento es idéntico al de antes.
   */
  downstreamSkipCauses?: DownstreamSkipCode[] | undefined;
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
  /**
   * WKH-318: el caller declara su tolerancia a un catálogo parcial. `true` ⇒ si
   * el catálogo no es `complete`, se aborta ANTES del primer `invokeAgent` y el
   * route reembolsa el step-0. Ausente/`false` ⇒ comportamiento de hoy.
   */
  requireCompleteCatalog?: boolean | undefined;
  /**
   * WKH-360 (AC-5/AC-6): la traza de contratación ENTRANTE, ya validada por el
   * preHandler `contractingGuard` y poblada por el route. Índice 0 = el primer
   * coordinador de la cadena.
   *
   * ⚠️ VIAJA EN EL REQUEST Y NO EN EL `ComposeResult`, a propósito y por el mismo
   * motivo que `downstreamSkipCauses` (ver su docstring más arriba): los dos
   * routes hacen `reply.send({ …, ...result })` sin schema de respuesta, así que
   * TODO lo que viva en el resultado sale por HTTP al caller. Una traza de
   * contratación en la respuesta le contaría a cualquier caller qué otros
   * coordinadores están en la cadena.
   *
   * Ausente ⟹ cadena vacía ⟹ comportamiento idéntico al de antes de esta HU, que
   * es el 100% del tráfico de hoy.
   */
  contractingChain?: string[] | undefined;
  /**
   * WKH-360 (AC-6): la profundidad de contratación ENTRANTE ya validada.
   *
   * Ausente ⟹ 0 (caller directo). "Ausente" e "ilegible" NO son lo mismo: un
   * valor presente que no se puede leer se RECHAZA en el preHandler y nunca llega
   * acá, porque degradarlo a 0 sería un reseteo del contador a pedido de un
   * tercero. Ver `src/lib/contracting-chain.ts`.
   */
  contractingDepth?: number | undefined;
  /**
   * WKH-360 (AC-4, fix-pack AR/CR BLQ-MED-1): el `Host` por el que ENTRÓ la
   * petición HTTP, para que el guard anti-bucle tenga identidad propia sin ninguna
   * configuración.
   *
   * ⚠️ **POR QUÉ EXISTE ESTE CAMPO Y NO SE RESUELVE ABAJO.** El conjunto de
   * identidad se arma con `BASE_URL` → `A2A_SELF_HOSTS` → el `Host` del request.
   * Las dos primeras son envs y el leaf las lee solo; la tercera necesita un
   * `FastifyRequest`, **y los services no tienen ninguno**. Sin este campo, con las
   * dos envs ausentes el conjunto queda `[]`, `isSelfDestination` devuelve `false`
   * por conjunto vacío y los guards de los steps 1..N —donde vive el costo `5^k`—
   * quedan INERTES. Medido: sin las dos envs se cobraba el step y salía la
   * invocación contra nosotros mismos.
   *
   * Viaja por el MISMO canal que `contractingChain`: un campo del request que el
   * route puebla con `request.hostname` (fastify 5, sin puerto).
   *
   * **Monótono para el conjunto de identidad, CON `A2A_SELF_HOSTS` o `BASE_URL`
   * puestas**: ahí agrandarlo sólo puede producir MÁS rechazos. Un caller que forja
   * `Host: victima.com` consigue que el gateway se **niegue** a llamar a
   * `victima.com` en SU PROPIA petición — auto-DoS de un request, no un bypass, y
   * no puede vaciar lo que las envs declararon (`T-L1-2d`).
   *
   * ⛔ **SIN LAS DOS ENVS ESA MONOTONÍA NO ES UNA GARANTÍA** (AR-it2/BLQ-MED-2): el
   * conjunto es `[canonicalizeHost(hint)]`, o sea que el caller no lo agranda, lo
   * **DEFINE** — y con un `Host` ilegible lo deja en `[]` y el guard vuelve al
   * estado inerte (medido: `'a b'`, `'http://x'`, `'::1'`, `''`; testigo
   * `T-L1-2e`). Lo que el hint cubre ahí es el bucle **accidental**, no el hostil.
   * (Ver también la salvedad sobre `canonicalId` en `resolveSelfHosts`: ese eslabón
   * lo emitimos NOSOTROS hacia terceros y sin config lo elige el caller.)
   */
  selfHostHint?: string | undefined;
  /**
   * WKH-225 — la autorización para que un step de ESTE pipeline pueda quedar
   * ESPERANDO a una persona en vez de tener que terminar dentro del request.
   *
   * ⛔ LO CONSTRUYE UN SOLO ARCHIVO: `src/routes/compose.ts`. Clavado por
   * `T-SUSP-CALLSITE`, que lee el fuente de `src/services/orchestrate.ts` y
   * exige que la cadena `suspension` no aparezca ahí. `/orchestrate` queda
   * afuera POR CONSTRUCCIÓN, no por acuerdo: sin este campo, el lector del
   * sobre del agente ni siquiera corre.
   *
   * Ausente ⇒ el pipeline se comporta EXACTAMENTE como hoy: cero filas, cero
   * queries, cero claves nuevas en el `ComposeResult` (AC-9). Y ausente es el
   * 100 % del tráfico mientras la bandera `COMPOSE_SUSPEND_ENABLED` no sea el
   * string `'true'`.
   *
   * También queda ausente cuando el caller NO es bindeable (x402 puro /
   * anónimo): sin credencial exacta no hay a qué atar el token de reanudación,
   * y un token que cualquiera puede redimir no es una credencial. Fail-closed.
   */
  suspension?: {
    /** La credencial EXACTA a la que queda atado el token de reanudación. */
    caller: ResumeCaller;
    /**
     * `owner_ref` del caller autenticado. Es el valor con el que se filtra
     * TODA lectura y escritura de la fila (Ownership Guard app-layer): el
     * cliente de Supabase usa la service key y bypassea RLS.
     */
    ownerRef: string;
    /** `id` de la agent key que pagó este pipeline. Ancla la fila a esa key. */
    keyId: string;
    /**
     * TTL pedido por el caller, en segundos. Ausente ⇒ el máximo configurado.
     * El piso y el techo los hace cumplir el CHECK de la columna, no esta
     * prosa.
     */
    ttlSeconds?: number;
    /**
     * CD-15 — instante (epoch en milisegundos) en que vence la garantía del
     * quote que congeló los precios de este run. Presente SÓLO si hubo
     * congelamiento.
     *
     * Postgres toma el `LEAST` entre su propio vencimiento y éste, así que un
     * pipeline reanudado NUNCA puede debitar un precio congelado cuya garantía
     * ya venció. El recorte lo hace la base, no este proceso: es el mismo
     * motivo por el que `expires_at` tampoco lo escribe Node.
     */
    frozenPricesExpireAtMs?: number;
  };
}

export interface ComposeResult {
  success: boolean;
  output: unknown;
  steps: StepResult[];
  totalCostUsdc: number;
  totalLatencyMs: number;
  error?: string;
  /**
   * WKH-225 — el pipeline no terminó ni falló: quedó ESPERANDO. Presente sólo
   * cuando un step devolvió el sobre de suspensión y el estado se persistió.
   *
   * 🔴 `success` SIGUE SIENDO `true` cuando esto está presente, y no es estilo
   * (CD-2). Con `success:false` la envoltura de `compose()` llamaría a
   * `recordStrandedRunIfAny` y CADA suspensión normal emitiría un evento
   * `compose_stranded_payment`, que la alerta de exposición varada acumula y
   * publica en `/health` como camino degradado. Un KYC funcionando bien haría
   * sonar la alarma de plata varada, que es exactamente el daño que esa alerta
   * declara combatir. Con `success:true` esa línea es un no-op y no hay diff.
   *
   * ⚠️ `{success:true, suspended}` NO es un estado imposible mal modelado: ES el
   * estado suspendido. El imposible es el otro —`{success:false, suspended}`— y
   * ningún camino lo produce (testigo `T-SUSP-IMPOSSIBLE`).
   *
   * Cambio de contrato ESTRICTAMENTE ADITIVO: este objeto sale por HTTP sin
   * schema de respuesta y lo leen consumidores fuera de este repo, así que
   * `success` no cambia de tipo ni de significado para nadie que no lo mire.
   */
  suspended?: ComposeSuspension;
  /**
   * WKH-225 — el token con el que se reanuda. Presente EXACTAMENTE cuando
   * `suspended` lo está, y viaja una sola vez: no es recuperable después.
   *
   * ⛔ POR QUÉ NO ESTÁ DENTRO DE `ComposeSuspension`. Ese objeto es el que se
   * ECHA hacia afuera y el que un cliente guarda o loguea entero; éste es la
   * CREDENCIAL. Separarlos hace que "mostrar el estado de la suspensión" y
   * "entregar la credencial" sean dos decisiones distintas en vez de una sola
   * que se toma por descuido.
   *
   * ⛔ NUNCA en una query string, NUNCA en una URL, NUNCA en un log, NUNCA en un
   * mensaje de error. Lo único de este camino que se puede escribir en un canal
   * de operador es el `runId`.
   */
  resumeToken?: string;
  /**
   * WKH-61: discriminator para que el route handler mapee a 403 (`SCOPE_DENIED`).
   * WKH-125: `DEST_CAP_EXCEEDED` → 402 (cap por destino excedido mid-pipeline).
   * WKH-305: `INPUT_MAPPING_FAILED` → **400**, por el `default` que YA existe en
   * el mapeo de status de `routes/compose.ts` (`let status = 400`). NO agrega una
   * rama de status nueva: un mapeo irresoluble es un body que el gateway no puede
   * satisfacer, o sea el mismo 400 de siempre.
   *
   * WKH-360: `CONTRACTING_LOOP_DETECTED` y `CONTRACTING_DEPTH_EXCEEDED` → **400**
   * por ese MISMO `default`, exactamente como `INPUT_MAPPING_FAILED`. Tampoco
   * agregan rama de status, y eso es deliberado: estrenar un `508 Loop Detected`
   * sumaría un código que ningún cliente de este ecosistema maneja a cambio de
   * cero información que el `errorCode` no dé.
   *
   * ⚠️ El STRING de los dos sale de `src/lib/contracting-chain.ts` (CD-19), no de
   * un literal escrito acá: el mismo bucle se reporta como `error_code` (snake) si
   * lo caza un preHandler y como `errorCode` (camel) si lo caza el loop del
   * pipeline, y lo que ata las dos superficies es que el VALOR sea una sola
   * constante. Un cliente matchea un solo string aunque mire dos claves.
   */
  errorCode?:
    | 'SCOPE_DENIED'
    | 'DEST_CAP_EXCEEDED'
    | 'INPUT_MAPPING_FAILED'
    | 'CONTRACTING_LOOP_DETECTED'
    | 'CONTRACTING_DEPTH_EXCEEDED';
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
  /** WKH-318: las fuentes que no se pudieron consultar en este pipeline. */
  failedSources?: FailedSourceRef[];
  /** WKH-318: roll-up del catálogo con el que se armó el pool de este pipeline. */
  catalogStatus?: CatalogStatus;
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
  /**
   * @deprecated HU-DOUBLE-PAY — `compose` YA NO LO POBLA, en ningún camino.
   *
   * Era el hash del SEGUNDO leg de salida de `invokeAgent` (el mal llamado "sign
   * inbound x402"), que le pagaba al agente una segunda vez desde el wallet del
   * operador y sólo corría con `!a2aKey`. Ese leg se borró; el hash del ÚNICO
   * pago al agente es `downstreamTxHash`.
   *
   * El campo se conserva en el tipo por compatibilidad de CABLE (lo leen
   * consumidores fuera de este repo y el mapper de `mcp/tools/orchestrate.ts`) y
   * porque `lib/stranded-payment.ts` lo lee al releer filas VIEJAS, donde sí
   * tiene valor. En una respuesta nueva sale SIEMPRE ausente.
   */
  txHash?: string | undefined;
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
  /**
   * WKH-360 (AC-11): el fee de orquestación que declaró el EJECUTOR de este step,
   * cuando ese ejecutor es a su vez un coordinador.
   *
   * Se **LEE**, no se estima. La señal de que el agente es un coordinador es que
   * su respuesta trae el MISMO sobre que nosotros emitimos (`protocolFeeStatus`):
   *  · sin `protocolFeeStatus` ⟹ este campo queda **AUSENTE** (no es un
   *    coordinador). Ésta es la rama que preserva AC-8 para el 100% del tráfico de
   *    hoy: los 25 agentes descubribles en prod no emiten ese campo.
   *  · declaró un monto cobrado ⟹ `{ declared: true, usdc }`.
   *  · lo declaró pero sin monto usable ⟹ `{ declared: false }`.
   *
   * ⛔ **NUNCA `usdc: 0`** (CD-5). "No lo declaró" no es "cobró cero": un cero
   * fabricado es una afirmación falsa con formato de dato. El tercer valor es
   * explícito.
   *
   * Este campo SÍ es público a propósito (viaja en el `ComposeResult` y sale por
   * HTTP): el punto de AC-11 es que el fee en cascada sea VISIBLE para quien paga.
   */
  coordinatorFee?:
    | { declared: true; usdc: number }
    | { declared: false }
    | undefined;
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
   * Array PRESTADO para los motivos INTERNOS de skip del leg downstream. Se
   * propaga tal cual a `composeService.compose`; ver el docstring del campo
   * homónimo en `ComposeRequest` para por qué es un input y no un campo del
   * resultado.
   */
  downstreamSkipCauses?: DownstreamSkipCode[] | undefined;
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
   * delegación. El guard `i>0` de src/services/compose.ts:602 protege el step 0 contra
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
  /**
   * WKH-318: la tolerancia del caller a un catálogo parcial. `true` ⇒ el planner
   * hace early-return `catalog_incomplete` (cero débito por construcción) y el
   * flag baja a compose para la capa 2 (TOCTOU).
   */
  requireCompleteCatalog?: boolean | undefined;
  /**
   * WKH-360 (AC-5/AC-7): la traza de contratación ENTRANTE, ya validada por el
   * preHandler `contractingGuard` de las TRES rutas de orchestrate. Se propaga tal
   * cual a `composeService.compose`, que es quien EMITE la traza saliente con
   * nuestro eslabón y la profundidad incrementada.
   *
   * Ausente ⇒ cadena vacía / profundidad 0 ⇒ comportamiento idéntico al de hoy.
   */
  contractingChain?: string[] | undefined;
  /** WKH-360 (AC-6): profundidad de contratación entrante, ya validada. */
  contractingDepth?: number | undefined;
  /**
   * WKH-360 (AC-4, fix-pack AR/CR BLQ-MED-1): el `Host` por el que entró la
   * petición. Lo puebla el route con `request.hostname` y lo consumen el SITIO 2
   * (acá, el step-0 de las tres rutas de orchestrate) y —propagado a
   * `ComposeRequest.selfHostHint`— los SITIOS 3 y 4. Ver el docstring largo en
   * `ComposeRequest`.
   */
  selfHostHint?: string | undefined;
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
  /** WKH-318: las fuentes que no se pudieron consultar al armar el catálogo. */
  failedSources?: FailedSourceRef[];
}

// WKH-131 (HU-128): /orchestrate/plan + /orchestrate/execute split.
export type OrchestratePlanStatus =
  | 'ready'
  | 'insufficient_funds'
  | 'no_agents'
  /**
   * WKH-318: NO se colapsa con `no_agents`. `no_agents` = *pregunté y no hay*;
   * `catalog_incomplete` = *no pude preguntar*, y el caller pidió
   * explícitamente un catálogo completo (CD-15).
   */
  | 'catalog_incomplete'
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
  /**
   * WKH-318: las fuentes que no se pudieron consultar. Presente en el
   * early-return `catalog_incomplete`; el route lo propaga al cliente.
   */
  failedSources?: FailedSourceRef[];
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
// SUSPENDED RUN TYPES (WKH-225 — paso suspendible y reanudable)
// ============================================================

/**
 * La credencial EXACTA a la que queda atada una reanudación.
 *
 * Espejo deliberado de `QuoteCaller` (`services/orchestrate-quote.ts`), con la
 * MISMA precedencia (delegación → sesión → key) y por el mismo motivo: si se
 * invirtiera, un pipeline suspendido bajo delegación quedaría atado a la key
 * padre y podría reanudarlo cualquier otra sesión de esa key.
 *
 * Es un tipo propio y no un alias del de quote a propósito: el módulo de firma
 * de la reanudación es LEAF (sólo `node:crypto`) y no puede importar nada del
 * grafo de servicios. Que las dos formas coincidan es la intención; que
 * compartan módulo, no.
 */
export interface ResumeCaller {
  kind: 'delegation' | 'session' | 'key';
  id: string;
}

/**
 * Lo que el caller recibe cuando un step suspendió el pipeline.
 *
 * ⛔ El `artifact` NO se interpreta, NO se reescribe, NO se valida contra una
 * allowlist propia y NO se loguea (CD-21). Es lo que devolvió el agente, tal
 * cual: típicamente una URL a la que va una persona. El gateway sabe que hay
 * que esperar; no sabe a qué.
 *
 * ⛔ Y el identificador de reanudación NO está acá. `runId` es el `id` de la
 * fila —sirve para correlacionar y para pedir estado—, no la credencial: el
 * token firmado viaja en su propio campo de la respuesta HTTP y jamás en una
 * URL, una query string, un log ni un mensaje de error (CD-8).
 */
export interface ComposeSuspension {
  /** `id` de la fila de `a2a_suspended_runs`. NO es el token. */
  runId: string;
  /** Índice del step que suspendió. Ese step SÍ se ejecutó y SÍ se pagó. */
  step: number;
  /** Lo que devolvió el agente, TAL CUAL. El gateway no lo interpreta. */
  artifact: unknown;
  /**
   * ISO-8601. Lo escribió POSTGRES con un trigger (CD-19), nunca este proceso:
   * es el único punto donde una deriva de reloj entre Node y la base podría
   * volver reanudable un run vencido, porque la LECTURA compara los dos lados
   * contra el mismo reloj y la ESCRITURA no.
   */
  expiresAt: string;
  /**
   * Vocabulario del estándar A2A para el estado human-in-the-loop. Constante,
   * para que el cliente no tenga que aprender un nombre nuestro.
   *
   * ⚠️ NO es el `status` de la fila. El de la fila es `'suspended'`, y son dos
   * cosas distintas A PROPÓSITO: uno es protocolo hacia afuera, el otro es la
   * máquina de estados de una tabla nuestra.
   */
  state: 'input-required';
}

/**
 * Fila de `a2a_suspended_runs`.
 *
 * Las columnas NUMERIC (`total_cost_usdc`) llegan como `string` en runtime desde
 * Supabase aunque el tipo generado las declare `number` — mismo criterio que
 * `AgentLinkRow` y `KeySessionRow`, y la razón por la que se seleccionan con
 * `::text` (WKH-196: PostgREST entrega los NUMERIC como número JSON y
 * `JSON.parse` redondea).
 *
 * Los cuatro JSONB se tipan `unknown` a propósito: son datos que salieron de
 * una fila y vuelven a entrar al pipeline. Tiparlos como lo que esperamos que
 * sean convertiría una fila corrupta en un `any` que nadie mira.
 */
export interface SuspendedRunRow {
  id: string;
  token_hash: string;
  owner_ref: string;
  key_id: string;
  caller_kind: 'delegation' | 'session' | 'key';
  caller_id: string;
  compose_run_id: string;
  step_index: number;
  steps_json: unknown;
  last_output: unknown;
  remaining_steps: unknown;
  frozen_step_prices: unknown;
  total_cost_usdc: string;
  total_latency_ms: number;
  contracting_chain: unknown;
  contracting_depth: number;
  self_host_hint: string | null;
  chain_id: number | null;
  status: 'suspended' | 'resuming' | 'resumed' | 'failed' | 'expired';
  ttl_seconds: number;
  expires_at: string;
  resumed_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Fila devuelta por el RPC `claim_suspended_run` (suspended→resuming).
 *
 * Trae TODO lo que hace falta para reconstruir el `ComposeRequest` de la cola
 * del pipeline, y en particular los tres campos de la traza de contratación
 * (`contracting_chain`, `contracting_depth`, `self_host_hint`). Sin ellos la
 * reanudación arrancaría con cadena vacía y profundidad 0, o sea reiniciando el
 * contador del guard anti-bucle a pedido de quien reanuda — que es exactamente
 * el bypass que esta HU tendría que abrir y no abre (CD-17).
 *
 * ⛔ NO trae `token_hash` ni nada derivado del token: el claim ya lo consumió.
 */
export interface SuspendedRunClaim {
  id: string;
  owner_ref: string;
  key_id: string;
  caller_kind: 'delegation' | 'session' | 'key';
  caller_id: string;
  compose_run_id: string;
  step_index: number;
  steps_json: unknown;
  last_output: unknown;
  remaining_steps: unknown;
  frozen_step_prices: unknown;
  total_cost_usdc: string;
  total_latency_ms: number;
  contracting_chain: unknown;
  contracting_depth: number;
  self_host_hint: string | null;
  chain_id: number | null;
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
  /**
   * WKH-360 (AC-1c): el endpoint CONCRETO con el que se contrata esta skill.
   *
   * Extensión ADITIVA — un consumidor que no la entiende la ignora (DT-6). Sale
   * del prefijo con el que la ruta está registrada, y como `tsc` no ata un path
   * literal al registro de rutas, el control es MECÁNICO: `T-CARD-3` arranca la
   * app con `fastify.inject()` y verifica que cada `endpoint` declarado responda
   * distinto de 404.
   */
  endpoint?: { method: 'POST'; path: string };
  /**
   * WKH-360 (AC-1a): cómo se paga esta skill.
   *
   * ⚠️ NO hay `priceUsdc` por skill, y su ausencia es deliberada: declarar un
   * precio fijo sería **fabricar una oferta** (justo lo que AC-3 prohíbe). Los
   * precios de los agentes son pass-through y el gateway cobra una TASA sobre el
   * costo realmente ejecutado, así que el precio de un pipeline concreto se
   * COTIZA en `POST /orchestrate/plan` (que devuelve `costPerStep`,
   * `totalCostUsdc`, `protocolFeeUsdc` y `maxQuotedCostUsdc`, y no cobra). La
   * carta declara el MODELO y apunta al COTIZADOR — que es lo que AC-1 admite con
   * su "o la forma de obtenerlo".
   */
  pricing?:
    | { model: 'free' }
    | {
        model: 'protocol-fee-on-executed-cost';
        feeRatePercent: number;
        quoteEndpoint: string;
      };
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
  /**
   * WKH-360 (AC-1): cómo contratar a este gateway COMO AGENTE, es decir el
   * contrato de la traza de contratación que otro coordinador tiene que hablar.
   *
   * Extensión ADITIVA — quien no la entiende la ignora (DT-6).
   *
   * `bestEffortNote` NO es adorno: publica, en la carta, que la detección de
   * bucles transitivos depende de que los intermediarios reenvíen los headers. Sin
   * ese texto la carta induciría a creer que declarar los headers alcanza para
   * estar cubierto. Sale de `CONTRACTING_LAYER2_BEST_EFFORT_NOTE`
   * (`src/lib/contracting-chain.ts`), que es la MISMA constante que va al body del
   * error, para que la promesa publicada y la emitida no puedan divergir.
   */
  contracting?: {
    depthMax: number;
    chainHeader: string;
    depthHeader: string;
    bestEffortNote: string;
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
