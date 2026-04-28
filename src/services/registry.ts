/**
 * Registry Service — Manages marketplace registrations
 *
 * WKH-7: Migrado de Map en memoria a Supabase PostgreSQL.
 * Todos los métodos son ahora async.
 *
 * IMPORTANTE: auth.value puede contener secrets.
 * NUNCA loguear el campo auth completo ni auth.value.
 *
 * WKH-63 (SEC-REG-1): register/update/delete reciben `ownerRef` y aplican
 * ownership guard en app-layer. La fila pre-existente 'wasiai' se trata
 * como `owner_ref='system'` (back-fill de la migration) y se rechaza con
 * 403 al intentar mutar. Filas con otro `owner_ref` que NO matchean el
 * caller se rechazan con `OwnershipMismatchError` (mapeado a 404 en la
 * route — disclosure-safe). El guard hardcoded `id === 'wasiai'` se elimina
 * en favor del check sobre `owner_ref === SYSTEM_OWNER_REF`.
 */

import { supabase } from '../lib/supabase.js';
import {
  SSRFViolationError,
  validateRegistryUrl,
} from '../lib/url-validator.js';
import type {
  RegistryAuth,
  RegistryConfig,
  RegistrySchema,
} from '../types/index.js';
import { OwnershipMismatchError } from './security/errors.js';

// ── Constantes ──────────────────────────────────────────────

/**
 * Sentinel owner_ref para registries canónicas creadas por la plataforma
 * (e.g. 'wasiai'). Inmutables: cualquier intento de update/delete contra
 * filas con este owner_ref retorna 403.
 *
 * Este valor coincide con el DEFAULT de la migration W0
 * (`ADD COLUMN owner_ref TEXT NOT NULL DEFAULT 'system'`), por lo que las
 * filas pre-existentes quedan automáticamente protegidas tras el ALTER.
 */
export const SYSTEM_OWNER_REF = 'system';

/**
 * Error específico para violación de inmutabilidad sobre filas system.
 * El route handler lo mapea a 403 con el mensaje "System registry is immutable".
 */
export class SystemRegistryImmutableError extends Error {
  readonly code = 'SYSTEM_REGISTRY_IMMUTABLE' as const;
  constructor() {
    super('System registry is immutable');
    this.name = 'SystemRegistryImmutableError';
  }
}

// ── Tipo interno para filas de Supabase ─────────────────────

interface RegistryRow {
  id: string;
  name: string;
  discovery_endpoint: string;
  invoke_endpoint: string;
  agent_endpoint: string | null;
  schema: RegistrySchema;
  auth: RegistryAuth | null;
  enabled: boolean;
  created_at: string;
  /** WKH-63: ownership column. NOT NULL DEFAULT 'system' en DB. */
  owner_ref: string;
}

// ── Helper: Row → RegistryConfig ────────────────────────────

function rowToRegistry(row: RegistryRow): RegistryConfig {
  return {
    id: row.id,
    name: row.name,
    discoveryEndpoint: row.discovery_endpoint,
    invokeEndpoint: row.invoke_endpoint,
    agentEndpoint: row.agent_endpoint ?? undefined,
    schema: row.schema,
    auth: row.auth ?? undefined,
    enabled: row.enabled,
    createdAt: new Date(row.created_at),
    ownerRef: row.owner_ref,
  };
}

// ── Helper: RegistryConfig → columnas para INSERT/UPDATE ────

function registryToRow(
  config: Omit<RegistryConfig, 'id' | 'createdAt'>,
  id: string,
): Omit<RegistryRow, 'created_at'> & { id: string } {
  return {
    id,
    name: config.name,
    discovery_endpoint: config.discoveryEndpoint,
    invoke_endpoint: config.invokeEndpoint,
    agent_endpoint: config.agentEndpoint ?? null,
    schema: config.schema,
    auth: config.auth ?? null,
    enabled: config.enabled,
    owner_ref: config.ownerRef,
  };
}

// ── Service ─────────────────────────────────────────────────

export const registryService = {
  /**
   * List all registries (público — visibilidad no cambia con WKH-63).
   */
  async list(): Promise<RegistryConfig[]> {
    const { data, error } = await supabase
      .from('registries')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) throw new Error(`Failed to list registries: ${error.message}`);

    return (data as RegistryRow[]).map(rowToRegistry);
  },

  /**
   * Get a specific registry by ID (público — visibilidad no cambia).
   */
  async get(id: string): Promise<RegistryConfig | undefined> {
    const { data, error } = await supabase
      .from('registries')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error)
      throw new Error(`Failed to get registry '${id}': ${error.message}`);

    return data ? rowToRegistry(data as RegistryRow) : undefined;
  },

  /**
   * Register a new marketplace.
   * ID is generated from name (slug). El `ownerRef` lo provee el route
   * handler desde `request.a2aKeyRow.owner_ref` (WKH-63).
   */
  async register(
    config: Omit<RegistryConfig, 'id' | 'createdAt' | 'ownerRef'>,
    ownerRef: string,
  ): Promise<RegistryConfig> {
    // Defense-in-depth (WKH-62): re-validate even if the route handler
    // bypassed the SSRF guard. The service throws Error (not
    // SSRFViolationError) so callers see a uniform message.
    for (const field of ['discoveryEndpoint', 'invokeEndpoint'] as const) {
      try {
        await validateRegistryUrl(config[field]);
      } catch (err) {
        if (err instanceof SSRFViolationError) {
          throw new Error(`Invalid ${field}: ${err.reason}`);
        }
        throw err;
      }
    }

    const id = config.name.toLowerCase().replace(/\s+/g, '-');

    const row = registryToRow({ ...config, ownerRef }, id);

    const { data, error } = await supabase
      .from('registries')
      .insert(row)
      .select()
      .single();

    if (error) {
      // PK violation = ya existe
      if (error.code === '23505') {
        throw new Error(`Registry '${id}' already exists`);
      }
      throw new Error(`Failed to register: ${error.message}`);
    }

    return rowToRegistry(data as RegistryRow);
  },

  /**
   * Update a registry (partial update).
   * ID cannot be changed.
   *
   * WKH-63 ownership guard:
   *   1. Pre-fetch fila por id.
   *   2. Si no existe → throw `OwnershipMismatchError` (route → 404).
   *      Disclosure-safe: NO distingue "no existe" de "existe pero es
   *      de otro owner" — la URL leak vía status code se evita así.
   *   3. Si existe y `owner_ref === SYSTEM_OWNER_REF` →
   *      `SystemRegistryImmutableError` (route → 403).
   *   4. Si existe y `owner_ref !== ownerRef` (caller) →
   *      `OwnershipMismatchError` (route → 404).
   *   5. Si matchea, ejecutar UPDATE filtrado por (id, owner_ref).
   *
   * El guard hardcoded `id === 'wasiai'` se elimina — la fila 'wasiai'
   * tiene `owner_ref='system'` (back-fill W0) y queda protegida por (3).
   */
  async update(
    id: string,
    updates: Partial<Omit<RegistryConfig, 'id' | 'createdAt' | 'ownerRef'>>,
    ownerRef: string,
  ): Promise<RegistryConfig> {
    // 1+2+3+4: pre-fetch + ownership/system check
    const existing = await this.get(id);
    if (!existing) {
      throw new OwnershipMismatchError();
    }
    if (existing.ownerRef === SYSTEM_OWNER_REF) {
      throw new SystemRegistryImmutableError();
    }
    if (existing.ownerRef !== ownerRef) {
      throw new OwnershipMismatchError();
    }

    // Defense-in-depth (WKH-62): re-validate URL fields when present in
    // the partial update.
    for (const field of ['discoveryEndpoint', 'invokeEndpoint'] as const) {
      const value = updates[field];
      if (typeof value !== 'string') continue;
      try {
        await validateRegistryUrl(value);
      } catch (err) {
        if (err instanceof SSRFViolationError) {
          throw new Error(`Invalid ${field}: ${err.reason}`);
        }
        throw err;
      }
    }

    // Construir objeto de actualización con snake_case
    const updateRow: Partial<Omit<RegistryRow, 'id' | 'created_at'>> = {};

    if (updates.name !== undefined) updateRow.name = updates.name;
    if (updates.discoveryEndpoint !== undefined)
      updateRow.discovery_endpoint = updates.discoveryEndpoint;
    if (updates.invokeEndpoint !== undefined)
      updateRow.invoke_endpoint = updates.invokeEndpoint;
    if (updates.agentEndpoint !== undefined)
      updateRow.agent_endpoint = updates.agentEndpoint ?? null;
    if (updates.schema !== undefined) updateRow.schema = updates.schema;
    if (updates.auth !== undefined) updateRow.auth = updates.auth ?? null;
    if (updates.enabled !== undefined) updateRow.enabled = updates.enabled;

    // 5: UPDATE filtrado también por owner_ref como defense-in-depth
    // (TOCTOU: fila pudo cambiar entre el pre-fetch y el UPDATE).
    const { data, error } = await supabase
      .from('registries')
      .update(updateRow)
      .eq('id', id)
      .eq('owner_ref', ownerRef)
      .select()
      .single();

    if (error) {
      // PGRST116 = no rows matched (race: alguien cambió el owner_ref).
      if (error.code === 'PGRST116') {
        throw new OwnershipMismatchError();
      }
      throw new Error(`Failed to update registry '${id}': ${error.message}`);
    }

    return rowToRegistry(data as RegistryRow);
  },

  /**
   * Delete a registry.
   *
   * WKH-63 ownership guard: misma lógica que `update` (pre-fetch + check).
   * El guard hardcoded `id === 'wasiai'` se elimina — la fila 'wasiai'
   * tiene `owner_ref='system'` (back-fill W0) y queda protegida.
   *
   * Returns true si se borró, false si no existía. (En la práctica el flujo
   * pre-fetch ya transforma el "no existe" en `OwnershipMismatchError`, así
   * que `false` solo aparece en una race condition.)
   */
  async delete(id: string, ownerRef: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) {
      throw new OwnershipMismatchError();
    }
    if (existing.ownerRef === SYSTEM_OWNER_REF) {
      throw new SystemRegistryImmutableError();
    }
    if (existing.ownerRef !== ownerRef) {
      throw new OwnershipMismatchError();
    }

    const { data, error } = await supabase
      .from('registries')
      .delete()
      .eq('id', id)
      .eq('owner_ref', ownerRef)
      .select();

    if (error)
      throw new Error(`Failed to delete registry '${id}': ${error.message}`);

    // data es el array de filas eliminadas; si está vacío, no existía
    // (race con otro DELETE concurrente).
    return Array.isArray(data) && data.length > 0;
  },

  /**
   * Get all enabled registries (público — usado por discovery).
   */
  async getEnabled(): Promise<RegistryConfig[]> {
    const { data, error } = await supabase
      .from('registries')
      .select('*')
      .eq('enabled', true)
      .order('created_at', { ascending: true });

    if (error)
      throw new Error(`Failed to get enabled registries: ${error.message}`);

    return (data as RegistryRow[]).map(rowToRegistry);
  },
};
