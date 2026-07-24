/**
 * Published Agent Service — Self-serve single-agent publishing (WKH-134).
 *
 * Clon estructural de `registry.ts`. Un dev individual publica UN agente
 * (URL + Agent Card mínima) sin operar un marketplace entero. La discovery
 * mergea estas filas (`a2a_agents`) con un SELECT (sin fetch outbound) y las
 * pasa por el MISMO pipeline que los agentes de marketplace (mismo shape
 * `Agent`, CD-6).
 *
 * Seguridad reusada (NO reinventar):
 *   - SSRF: `validateRegistryUrl` en write-time (route) + defense-in-depth (acá).
 *   - Ownership/anti-IDOR (WKH-53/63): `owner_ref` + `OwnershipMismatchError`
 *     + `logOwnershipMismatch`. Toda mutación filtra por `.eq('owner_ref', ...)`
 *     (el cliente Supabase usa SERVICE_KEY → BYPASSRLS; el guard vive en la app).
 *
 * El slug (PK) se deriva server-side del `name` (CD-5). NUNCA se acepta del body.
 */

import { parsePriceSafe } from '../lib/price.js';
import { supabase } from '../lib/supabase.js';
import {
  SSRFViolationError,
  validateRegistryUrl,
} from '../lib/url-validator.js';
import { normalizeChainSlug } from '../adapters/chain-resolver.js';
import {
  isValidPayoutWallet,
  type WalletNamespace,
} from '../lib/wallet-format.js';
import type { Database, Json } from '../types/database.types.js';
import type {
  Agent,
  PublishAgentInput,
  UpdateAgentInput,
} from '../types/index.js';
import {
  SELF_PUBLISHED_REGISTRY_ID,
  SELF_PUBLISHED_REGISTRY_NAME,
} from '../types/index.js';
import {
  logOwnershipMismatch,
  OwnershipMismatchError,
} from './security/errors.js';

// ── Tipo interno para filas de Supabase ─────────────────────

interface AgentRow {
  slug: string;
  name: string;
  description: string;
  capabilities: Json;
  agent_url: string;
  price_usdc: number;
  metadata: Json | null;
  enabled: boolean;
  owner_ref: string;
  created_at: string;
}

/**
 * Registro publicado — shape de respuesta de `publish`/`update`/`listMine`.
 * NO es el `Agent` de discovery (ese lo emite `mapRowToAgent`).
 */
export interface PublishedAgentRecord {
  slug: string;
  name: string;
  description: string;
  agentUrl: string;
  capabilities: string[];
  priceUsdc: number;
  enabled: boolean;
  discoverable: boolean;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  createdAt: string;
}

// Nota de invocación estática — idéntica a discovery.ts mapAgent (CD-6).
const INVOCATION_NOTE =
  'The invokeUrl is an internal reference. To invoke this agent, use POST /compose or POST /orchestrate on the WasiAI A2A gateway.';

// ── Helpers de narrowing JSONB (CD-8: cast SOLO en el borde) ─

/** Narrowing acotado de `capabilities` JSONB → string[]. */
function readCapabilities(raw: Json): string[] {
  return Array.isArray(raw) ? raw.map((c) => String(c)) : [];
}

/** Narrowing acotado de `metadata` JSONB → objeto (o {}). */
function readMetadataObject(raw: Json | null): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

/** Lee un campo JSON-Schema-like del metadata (objeto plano o undefined). */
function readSchema(
  meta: Record<string, unknown>,
  field: 'inputSchema' | 'outputSchema',
): Record<string, unknown> | undefined {
  const v = meta[field];
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return undefined;
}

// ── Mappers ─────────────────────────────────────────────────

/** Row → `Agent` (mismo shape que discovery.ts mapAgent — CD-6). */
function mapRowToAgent(row: AgentRow): Agent {
  return {
    id: row.slug,
    name: row.name,
    slug: row.slug,
    description: row.description,
    capabilities: readCapabilities(row.capabilities),
    // Read-boundary safeguard (WKH-134 BLQ-1): clampea negativos/no-finitos
    // ya persistidos en DB — mismo safeguard que la ruta de registries. Evita
    // que un price_usdc negativo se propague al débito prepago vía /compose.
    priceUsdc: parsePriceSafe(row.price_usdc),
    registry: SELF_PUBLISHED_REGISTRY_NAME,
    registry_id: SELF_PUBLISHED_REGISTRY_ID,
    invokeUrl: row.agent_url,
    invocationNote: INVOCATION_NOTE,
    verified: false,
    status: 'active',
    metadata: readMetadataObject(row.metadata),
  };
}

/** Row → registro publicado (respuesta de publish/update/listMine). */
function mapRowToRecord(row: AgentRow): PublishedAgentRecord {
  const meta = readMetadataObject(row.metadata);
  const inputSchema = readSchema(meta, 'inputSchema');
  const outputSchema = readSchema(meta, 'outputSchema');
  const record: PublishedAgentRecord = {
    slug: row.slug,
    name: row.name,
    description: row.description,
    agentUrl: row.agent_url,
    capabilities: readCapabilities(row.capabilities),
    // Mismo clamp de read-boundary que mapRowToAgent (WKH-134 BLQ-1).
    priceUsdc: parsePriceSafe(row.price_usdc),
    enabled: row.enabled,
    discoverable: meta.discoverable === true,
    createdAt: row.created_at,
  };
  if (inputSchema !== undefined) record.inputSchema = inputSchema;
  if (outputSchema !== undefined) record.outputSchema = outputSchema;
  return record;
}

/**
 * Construye el objeto `metadata` (JSONB) a partir de los campos WKH-106.
 * Retorna null si no hay ninguno (columna nullable).
 */
function buildMetadata(source: {
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  discoverable?: boolean;
}): Record<string, unknown> | null {
  const meta: Record<string, unknown> = {};
  if (source.inputSchema !== undefined) meta.inputSchema = source.inputSchema;
  if (source.outputSchema !== undefined)
    meta.outputSchema = source.outputSchema;
  if (source.discoverable !== undefined)
    meta.discoverable = source.discoverable;
  return Object.keys(meta).length > 0 ? meta : null;
}

// ── Write-boundary guards (WKH-134 BLQ-1 / MNR-1 / MNR-2) ────

/**
 * Write-boundary guard de precio (money-path). A diferencia de
 * `parsePriceSafe` (que clampea en el READ boundary), acá se RECHAZA: un
 * precio presente que no sea un `number` finito `>= 0` es un input inválido
 * que NO debe persistirse (un negativo inflaría el débito prepago vía
 * /compose + increment_a2a_key_spend). Defense-in-depth: el route ya devolvió
 * 422 antes.
 */
function assertValidPriceUsdc(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('Invalid priceUsdc: must be a finite number >= 0');
  }
}

/**
 * WKH-234 — resuelve la familia (namespace) del `payoutWallet` desde el slug de
 * chain. Ausente → `'evm'` (byte-idéntico WKH-143b). `solana-devnet` → `'solana'`.
 * Chain desconocida → rechazo (AC-6). Usa el resolver PURO `normalizeChainSlug`.
 */
function resolvePayoutNamespace(
  payoutChain: string | undefined,
): WalletNamespace {
  if (payoutChain === undefined) return 'evm';
  const slug = normalizeChainSlug(payoutChain);
  if (slug === undefined) {
    throw new Error(`Invalid payoutChain: unknown chain '${payoutChain}'`);
  }
  return slug === 'solana-devnet' ? 'solana' : 'evm';
}

/**
 * Write-boundary guard de `payoutWallet` (WKH-143b, money-path). Defense-in-depth:
 * el route ya devolvió 422. Valida con EXACTAMENTE el mismo criterio que
 * `resolveRecipients` (CD-1). Un valor inválido persistido rompería el settle.
 *
 * WKH-234: namespace-aware. `payoutChain` ausente → familia `'evm'` → criterio
 * EVM byte-idéntico. `solana-devnet` → valida base58 (32 bytes). Base58 inválido
 * → mismo error de formato (AC-5); chain desconocida → rechazo (AC-6).
 */
function assertValidPayoutWallet(value: unknown, payoutChain?: string): void {
  if (value === undefined) return;
  const ns = resolvePayoutNamespace(payoutChain);
  if (!(typeof value === 'string' && isValidPayoutWallet(value, ns))) {
    throw new Error('Invalid payoutWallet');
  }
}

/**
 * Write-boundary guard de `referrerRef` (WKH-143b). String no-vacío tras `trim()`
 * y `<= 200` chars. Defense-in-depth (el route ya devolvió 422).
 */
function assertValidReferrerRef(value: unknown): void {
  if (value === undefined) return;
  if (
    !(
      typeof value === 'string' &&
      value.trim().length >= 1 &&
      value.trim().length <= 200
    )
  ) {
    throw new Error('Invalid referrerRef');
  }
}

/**
 * Guards de whitespace del `name` — idénticos a `publish` (WKH-100 colisión de
 * normalización). En PATCH el `slug` (PK) es INMUTABLE: actualizar `name` NO
 * re-deriva el slug, así que `name` y `slug` pueden DIVERGIR tras un PATCH.
 * Igual se validan los mismos guards para mantener el `name` limpio.
 */
function assertValidName(name: string): void {
  if (name !== name.trim()) {
    throw new Error('Invalid agent name: leading/trailing whitespace');
  }
  if (/\s\s/.test(name)) {
    throw new Error('Invalid agent name: collapsible internal whitespace');
  }
}

/**
 * Filtra `capabilities` a elementos string y exige `length >= 1`. Devuelve el
 * array saneado. Lanza si no queda ningún string (MNR-1).
 */
function sanitizeCapabilities(raw: unknown): string[] {
  const arr = Array.isArray(raw)
    ? raw.filter((c) => typeof c === 'string')
    : [];
  if (arr.length < 1) {
    throw new Error('Invalid capabilities: expected a non-empty string[]');
  }
  return arr as string[];
}

// ── Service ─────────────────────────────────────────────────

export const publishedAgentService = {
  /**
   * Get the raw row by slug (colisión pre-check + pre-fetch de ownership).
   */
  async getRow(slug: string): Promise<AgentRow | null> {
    const { data, error } = await supabase
      .from('a2a_agents')
      .select('*')
      .eq('slug', slug)
      .maybeSingle();

    if (error)
      throw new Error(`Failed to get agent '${slug}': ${error.message}`);

    return data ? (data as unknown as AgentRow) : null;
  },

  /**
   * WKH-143 (DT-4/CD-5) — lee SOLO las columnas de ownership/payout de un agente
   * self-published, para resolver su leg de creator en los splits. Query espejo
   * de `getRow` pero seleccionando EXCLUSIVAMENTE `owner_ref, payout_wallet,
   * referrer_ref` — esas columnas JAMÁS entran a `AgentRow` ni a un shape público
   * (`mapRowToAgent`/`mapRowToRecord`), preservando CD-5. Uso server-side
   * exclusivo desde `resolveAgentSplitContext`.
   */
  async getSplitContextRow(slug: string): Promise<{
    ownerRef: string;
    payoutWallet: string | null;
    referrerRef: string | null;
  } | null> {
    const { data, error } = await supabase
      .from('a2a_agents')
      .select('owner_ref, payout_wallet, referrer_ref')
      .eq('slug', slug)
      .maybeSingle();

    if (error)
      throw new Error(
        `Failed to get split context for agent '${slug}': ${error.message}`,
      );

    return data
      ? {
          ownerRef: data.owner_ref,
          payoutWallet: data.payout_wallet,
          referrerRef: data.referrer_ref,
        }
      : null;
  },

  /**
   * Publish a new self-served agent. `ownerRef` proviene del route handler
   * (`request.a2aKeyRow.owner_ref`).
   */
  async publish(
    input: PublishAgentInput,
    ownerRef: string,
  ): Promise<PublishedAgentRecord> {
    // Defense-in-depth (CD-1): re-validar la URL aunque el route ya validó.
    // El service lanza Error (no SSRFViolationError) → mensaje uniforme.
    try {
      await validateRegistryUrl(input.agentUrl);
    } catch (err) {
      if (err instanceof SSRFViolationError) {
        throw new Error(`Invalid agentUrl: ${err.reason}`);
      }
      throw err;
    }

    // Validar mínimos (defense-in-depth; el route ya devolvió 400 antes).
    if (
      !input.name ||
      !input.agentUrl ||
      !Array.isArray(input.capabilities) ||
      input.capabilities.length < 1
    ) {
      throw new Error('Missing required fields: name, agentUrl, capabilities');
    }

    // Write-boundary guards (WKH-134 BLQ-1 / MNR-1): rechazar precio inválido
    // y saneá capabilities a string[] no vacío ANTES de persistir.
    assertValidPriceUsdc(input.priceUsdc);
    // WKH-143b: defense-in-depth de los inputs money-path (el route ya devolvió
    // 422). Ausentes → no-op → columnas NULL (AC-5).
    assertValidPayoutWallet(input.payoutWallet, input.payoutChain);
    assertValidReferrerRef(input.referrerRef);
    const capabilities = sanitizeCapabilities(input.capabilities);

    // Slug server-side (CD-5): guards de whitespace idénticos a
    // registryService.register (WKH-100 colisión de normalización).
    assertValidName(input.name);
    const slug = input.name.toLowerCase().replace(/\s+/g, '-');

    // Pre-check de colisión de PK (cualquier owner). El 23505 del insert es
    // la defensa final por race.
    const clash = await this.getRow(slug);
    if (clash) {
      throw new Error(`Agent '${slug}' already exists`);
    }

    const metadata = buildMetadata(input);
    const row: Database['public']['Tables']['a2a_agents']['Insert'] = {
      slug,
      name: input.name,
      description: input.description ?? '',
      // CD-8: narrowing acotado — JSONB en el borde Supabase (ya saneado).
      capabilities: capabilities as unknown as Json,
      agent_url: input.agentUrl,
      price_usdc: input.priceUsdc ?? 0,
      metadata: (metadata ?? null) as unknown as Json,
      enabled: true,
      owner_ref: ownerRef,
    };
    // WKH-143b: persistencia condicional (exactOptionalPropertyTypes, CD-4).
    // Ausente → columna NULL (AC-5). referrerRef re-trimeado (idempotente).
    if (input.payoutWallet !== undefined)
      row.payout_wallet = input.payoutWallet;
    if (input.referrerRef !== undefined)
      row.referrer_ref = input.referrerRef.trim();

    const { data, error } = await supabase
      .from('a2a_agents')
      .insert(row)
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new Error(`Agent '${slug}' already exists`);
      }
      throw new Error(`Failed to publish agent: ${error.message}`);
    }

    return mapRowToRecord(data as unknown as AgentRow);
  },

  /**
   * List enabled self-published agents as `Agent[]` (para discovery merge).
   * NO filtra por owner — es la vista pública descubrible.
   */
  async listAsAgents(): Promise<Agent[]> {
    const { data, error } = await supabase
      .from('a2a_agents')
      .select('*')
      .eq('enabled', true)
      .order('created_at', { ascending: true });

    if (error)
      throw new Error(`Failed to list published agents: ${error.message}`);

    return (data as unknown as AgentRow[]).map(mapRowToAgent);
  },

  /**
   * Resolve a single self-published agent by slug as `Agent` (discovery
   * local-first). Retorna null si no existe o está deshabilitado.
   */
  async getBySlugAsAgent(slug: string): Promise<Agent | null> {
    const { data, error } = await supabase
      .from('a2a_agents')
      .select('*')
      .eq('slug', slug)
      .eq('enabled', true)
      .maybeSingle();

    if (error)
      throw new Error(
        `Failed to get published agent '${slug}': ${error.message}`,
      );

    return data ? mapRowToAgent(data as unknown as AgentRow) : null;
  },

  /**
   * List the caller's OWN published agents (GET /agents list-mine). Filtra
   * por owner_ref; incluye deshabilitados (vista del dueño).
   */
  async listMine(ownerRef: string): Promise<PublishedAgentRecord[]> {
    const { data, error } = await supabase
      .from('a2a_agents')
      .select('*')
      .eq('owner_ref', ownerRef)
      .order('created_at', { ascending: true });

    if (error) throw new Error(`Failed to list own agents: ${error.message}`);

    return (data as unknown as AgentRow[]).map(mapRowToRecord);
  },

  /**
   * Update a self-published agent (partial). El slug (PK) no cambia.
   *
   * Ownership guard (WKH-63 pattern):
   *   1. Pre-fetch por slug. Si no existe → OwnershipMismatchError (404,
   *      disclosure-safe: no distingue "no existe" de "es de otro owner").
   *   2. Si owner_ref !== caller → OwnershipMismatchError (404).
   *   3. UPDATE filtrado por (slug, owner_ref) — TOCTOU defense-in-depth.
   */
  async update(
    slug: string,
    updates: UpdateAgentInput,
    ownerRef: string,
  ): Promise<PublishedAgentRecord> {
    const existing = await this.getRow(slug);
    if (!existing) {
      logOwnershipMismatch({
        op: 'agentPublishUpdate',
        resourceId: slug,
        callerOwnerRef: ownerRef,
      });
      throw new OwnershipMismatchError();
    }
    if (existing.owner_ref !== ownerRef) {
      logOwnershipMismatch({
        op: 'agentPublishUpdate',
        resourceId: slug,
        callerOwnerRef: ownerRef,
        actualOwnerRef: existing.owner_ref,
      });
      throw new OwnershipMismatchError();
    }

    // Defense-in-depth (CD-1): re-validar agentUrl si viene en el patch.
    if (typeof updates.agentUrl === 'string') {
      try {
        await validateRegistryUrl(updates.agentUrl);
      } catch (err) {
        if (err instanceof SSRFViolationError) {
          throw new Error(`Invalid agentUrl: ${err.reason}`);
        }
        throw err;
      }
    }

    // Write-boundary guards (WKH-134 BLQ-1 / MNR-1 / MNR-2). El slug (PK) NO
    // cambia aunque cambie el `name` — name/slug pueden divergir tras el PATCH.
    if (updates.priceUsdc !== undefined)
      assertValidPriceUsdc(updates.priceUsdc);
    // WKH-143b: defense-in-depth de los inputs money-path (el route ya devolvió
    // 422). Corre DESPUÉS del guard de ownership de arriba.
    if (updates.payoutWallet !== undefined)
      assertValidPayoutWallet(updates.payoutWallet, updates.payoutChain);
    if (updates.referrerRef !== undefined)
      assertValidReferrerRef(updates.referrerRef);

    const updateRow: Database['public']['Tables']['a2a_agents']['Update'] = {};
    if (updates.name !== undefined) {
      assertValidName(updates.name);
      updateRow.name = updates.name;
    }
    if (updates.description !== undefined)
      updateRow.description = updates.description;
    if (updates.capabilities !== undefined)
      updateRow.capabilities = sanitizeCapabilities(
        updates.capabilities,
      ) as unknown as Json;
    if (updates.agentUrl !== undefined) updateRow.agent_url = updates.agentUrl;
    if (updates.priceUsdc !== undefined)
      updateRow.price_usdc = updates.priceUsdc;
    // WKH-143b: persistencia condicional. El UPDATE final ya filtra por
    // `.eq('slug', slug).eq('owner_ref', ownerRef)` → heredan el ownership guard
    // sin código nuevo (AC-2/AC-6/CD-2). referrerRef persistido trimeado (DT-2).
    if (updates.payoutWallet !== undefined)
      updateRow.payout_wallet = updates.payoutWallet;
    if (updates.referrerRef !== undefined)
      updateRow.referrer_ref = updates.referrerRef.trim();

    // Merge de metadata (inputSchema/outputSchema/discoverable) sobre lo
    // existente — el patch parcial no debe borrar los campos no provistos.
    if (
      updates.inputSchema !== undefined ||
      updates.outputSchema !== undefined ||
      updates.discoverable !== undefined
    ) {
      const meta = readMetadataObject(existing.metadata);
      if (updates.inputSchema !== undefined)
        meta.inputSchema = updates.inputSchema;
      if (updates.outputSchema !== undefined)
        meta.outputSchema = updates.outputSchema;
      if (updates.discoverable !== undefined)
        meta.discoverable = updates.discoverable;
      updateRow.metadata = meta as unknown as Json;
    }

    const { data, error } = await supabase
      .from('a2a_agents')
      .update(updateRow)
      .eq('slug', slug)
      .eq('owner_ref', ownerRef)
      .select()
      .single();

    if (error) {
      // PGRST116 = no rows matched (race: cambió el owner_ref entre pre-fetch
      // y UPDATE). Tratar como no-encontrado (404).
      if (error.code === 'PGRST116') {
        logOwnershipMismatch({
          op: 'agentPublishUpdate',
          resourceId: slug,
          callerOwnerRef: ownerRef,
        });
        throw new OwnershipMismatchError();
      }
      throw new Error(`Failed to update agent '${slug}': ${error.message}`);
    }

    return mapRowToRecord(data as unknown as AgentRow);
  },

  /**
   * Delete (unpublish) a self-published agent. Mismo guard de ownership que
   * `update`. Retorna true si borró, false si no existía (solo en race).
   */
  async delete(slug: string, ownerRef: string): Promise<boolean> {
    const existing = await this.getRow(slug);
    if (!existing) {
      logOwnershipMismatch({
        op: 'agentPublishDelete',
        resourceId: slug,
        callerOwnerRef: ownerRef,
      });
      throw new OwnershipMismatchError();
    }
    if (existing.owner_ref !== ownerRef) {
      logOwnershipMismatch({
        op: 'agentPublishDelete',
        resourceId: slug,
        callerOwnerRef: ownerRef,
        actualOwnerRef: existing.owner_ref,
      });
      throw new OwnershipMismatchError();
    }

    const { data, error } = await supabase
      .from('a2a_agents')
      .delete()
      .eq('slug', slug)
      .eq('owner_ref', ownerRef)
      .select();

    if (error)
      throw new Error(`Failed to delete agent '${slug}': ${error.message}`);

    return Array.isArray(data) && data.length > 0;
  },
};
