/**
 * Registry Service — Manages marketplace registrations
 *
 * WKH-7: Migrado de Map en memoria a Supabase PostgreSQL.
 * Todos los métodos son ahora async.
 *
 * IMPORTANTE: auth.value puede contener secrets.
 * NUNCA loguear el campo auth completo ni auth.value.
 */

import type { RegistryConfig, RegistrySchema, RegistryAuth } from '../types/index.js'
import { supabase } from '../lib/supabase.js'

// ── Tipo interno para filas de Supabase ─────────────────────

interface RegistryRow {
  id: string
  name: string
  discovery_endpoint: string
  invoke_endpoint: string
  agent_endpoint: string | null
  schema: RegistrySchema
  auth: RegistryAuth | null
  enabled: boolean
  created_at: string
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
  }
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
  }
}

// ── Service ─────────────────────────────────────────────────

export const registryService = {
  /**
   * List all registries
   */
  async list(): Promise<RegistryConfig[]> {
    const { data, error } = await supabase
      .from('registries')
      .select('*')
      .order('created_at', { ascending: true })

    if (error) throw new Error(`Failed to list registries: ${error.message}`)

    return (data as RegistryRow[]).map(rowToRegistry)
  },

  /**
   * Get a specific registry by ID
   */
  async get(id: string): Promise<RegistryConfig | undefined> {
    const { data, error } = await supabase
      .from('registries')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (error) throw new Error(`Failed to get registry '${id}': ${error.message}`)

    return data ? rowToRegistry(data as RegistryRow) : undefined
  },

  /**
   * Register a new marketplace
   * ID is generated from name (slug)
   */
  async register(config: Omit<RegistryConfig, 'id' | 'createdAt'>): Promise<RegistryConfig> {
    const id = config.name.toLowerCase().replace(/\s+/g, '-')

    const row = registryToRow(config, id)

    const { data, error } = await supabase
      .from('registries')
      .insert(row)
      .select()
      .single()

    if (error) {
      // PK violation = ya existe
      if (error.code === '23505') {
        throw new Error(`Registry '${id}' already exists`)
      }
      throw new Error(`Failed to register: ${error.message}`)
    }

    return rowToRegistry(data as RegistryRow)
  },

  /**
   * Update a registry (partial update)
   * ID cannot be changed
   */
  async update(id: string, updates: Partial<RegistryConfig>): Promise<RegistryConfig> {
    // Construir objeto de actualización con snake_case
    const updateRow: Partial<Omit<RegistryRow, 'id' | 'created_at'>> = {}

    if (updates.name !== undefined) updateRow.name = updates.name
    if (updates.discoveryEndpoint !== undefined) updateRow.discovery_endpoint = updates.discoveryEndpoint
    if (updates.invokeEndpoint !== undefined) updateRow.invoke_endpoint = updates.invokeEndpoint
    if (updates.agentEndpoint !== undefined) updateRow.agent_endpoint = updates.agentEndpoint ?? null
    if (updates.schema !== undefined) updateRow.schema = updates.schema
    if (updates.auth !== undefined) updateRow.auth = updates.auth ?? null
    if (updates.enabled !== undefined) updateRow.enabled = updates.enabled

    const { data, error } = await supabase
      .from('registries')
      .update(updateRow)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      // PGRST116 = no rows matched
      if (error.code === 'PGRST116') {
        throw new Error(`Registry '${id}' not found`)
      }
      throw new Error(`Failed to update registry '${id}': ${error.message}`)
    }

    return rowToRegistry(data as RegistryRow)
  },

  /**
   * Delete a registry
   * Guard: 'wasiai' cannot be deleted
   */
  async delete(id: string): Promise<boolean> {
    if (id === 'wasiai') {
      throw new Error('Cannot delete the WasiAI registry')
    }

    const { data, error } = await supabase
      .from('registries')
      .delete()
      .eq('id', id)
      .select()

    if (error) throw new Error(`Failed to delete registry '${id}': ${error.message}`)

    // data es el array de filas eliminadas; si está vacío, no existía
    return Array.isArray(data) && data.length > 0
  },

  /**
   * Get all enabled registries
   */
  async getEnabled(): Promise<RegistryConfig[]> {
    const { data, error } = await supabase
      .from('registries')
      .select('*')
      .eq('enabled', true)
      .order('created_at', { ascending: true })

    if (error) throw new Error(`Failed to get enabled registries: ${error.message}`)

    return (data as RegistryRow[]).map(rowToRegistry)
  },
}
