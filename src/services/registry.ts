/**
 * Registry Service — Manages marketplace registrations
 *
 * WKH-7: Migrado de Map en memoria a Supabase PostgreSQL.
 * Todos los métodos son ahora async.
 *
 * IMPORTANTE: auth.value puede contener secrets.
 * NUNCA loguear el campo auth completo ni auth.value.
 *
 * HIGH-1 (2026-07-26): los read-paths que cruzan HTTP devuelven `RegistryPublic`
 * (sin `auth`), producido por `toRegistryPublic()`. Los métodos que SÍ exponen
 * la credencial llevan el sufijo `WithSecrets` (más `getEnabled`, cuyo consumo
 * es exclusivamente el fanout outbound). Ver `types/index.ts:RegistryPublic`
 * para el racional de por qué el compilador bloquea el leak.
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
import type { Database, Json } from '../types/database.types.js';
import type {
  RegistryAuth,
  RegistryConfig,
  RegistryPublic,
  RegistrySchema,
} from '../types/index.js';
import { SELF_PUBLISHED_REGISTRY_ID } from '../types/index.js';
import {
  logOwnershipMismatch,
  OwnershipMismatchError,
} from './security/errors.js';

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

// ── Namespaces RESERVADOS (WKH-366 / fix-pack AR/BLQ-ALTO-1) ─────────────────
//
// 🔴 QUÉ CIERRA, MEDIDO Y NO SUPUESTO. `self-published` es el `registry_id`
// SINTÉTICO que este gateway le pone a los agentes publicados con `POST /agents`
// (`SELF_PUBLISHED_REGISTRY_ID`, `types/index.ts`). Su docblock dice, textual, que
// "NO existe como fila en `registries`" — y ahí estaba el problema: no existir no
// es lo mismo que estar reservado. `POST /registries` deriva el id del `name`
// (`name.toLowerCase().replace(/\s+/g,'-')`) y no tenía blocklist, así que
// **cualquier caller autenticado podía crear una fila REAL llamada
// `self-published` y apropiarse del namespace sintético del propio gateway**.
//
// ⚠️ ESTO ARREGLA MÁS QUE LA HU QUE LO TRAJO. El disparador fue WKH-366 (un
// consumidor de KYC comparaba `agent.registry === "self-published"` para decidir
// un desembolso), pero el agujero no es de esa HU: todo camino que trate a
// `self-published` como "esto lo publicamos nosotros" hereda la misma confusión.
// Hay al menos dos más en este repo, y ninguno de los dos es de WKH-366:
// `agent-split-context.ts` (reparto de fee) y `discovery.ts` (armado del registry
// sintético para el agent card). ⛔ Por eso la reserva vive acá, en la puerta, y
// no en el consumidor que la descubrió.
//
// ⚠️ Y ES DEFENSA EN PROFUNDIDAD, NO EL ARREGLO DEL BLOQUEANTE. El vector
// principal del AR era otro —apropiarse del SLUG de un agente vía `POST /agents`,
// cuya fila nace con este `registry_id` hardcodeado— y eso NO se cierra desde
// acá. Se cierra del lado del consumidor, cruzando el `invokeUrl` contra una env
// del deploy. Escribir "reservamos el nombre ⇒ el registry ya es confiable" sería
// exactamente la afirmación de más que el AR vino a marcar.
//
// MEDICIÓN PREVIA A RESERVAR (2026-08-26, contra el catálogo VIVO de Railway):
//   · `GET /registries`               → `total: 1`, y la única fila es `wasiai`.
//   · `GET /registries/self-published` → **404**.
//   ⇒ No hay ninguna fila existente que este rechazo rompa. Si la hubiera, el
//     cambio habría que discutirlo, no forzarlo.
export const RESERVED_REGISTRY_IDS: ReadonlySet<string> = new Set([
  SELF_PUBLISHED_REGISTRY_ID,
]);

/**
 * ¿El `name` derivaría a un id reservado?
 *
 * 🔴 NORMALIZA IGUAL QUE LA DERIVACIÓN DEL PK, y eso es lo único que hace que el
 * check no se esquive: comparar contra el `name` crudo dejaría pasar
 * `"Self Published"` y `"SELF-PUBLISHED"`, que producen EXACTAMENTE el mismo id.
 * El `.trim()` extra sólo adelanta el rechazo de `" self-published "` (que hoy
 * muere igual, pero DESPUÉS del cobro, en el guard de whitespace de `register`).
 */
export function isReservedRegistryName(name: unknown): boolean {
  if (typeof name !== 'string') return false;
  return RESERVED_REGISTRY_IDS.has(
    name.trim().toLowerCase().replace(/\s+/g, '-'),
  );
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

// ── Helper: RegistryConfig → RegistryPublic (HIGH-1) ────────

/**
 * HIGH-1 (2026-07-26): único productor de `RegistryPublic`.
 *
 * `registries.auth.value` es una credencial outbound viva. `GET /registries`
 * devolvía `list()` verbatim y la exponía en claro a cualquier caller (endpoint
 * público, sin auth). El fix no es un `delete row.auth.value` en la ruta — eso
 * lo olvida el próximo endpoint — sino que el tipo que sale por HTTP NO PUEDE
 * contener el secreto (`RegistryPublic.auth?: never` + `authConfigured`
 * requerido → `RegistryConfig` no es asignable a `RegistryPublic`).
 *
 * En lugar del secreto se expone el esquema declarado (`authType`) y si hay o
 * no credencial configurada. NUNCA prefijo, sufijo, largo ni hash del valor.
 *
 * MNR-5 (AR HIGH-2): tampoco sale `ownerRef`. `GET /registries` es PÚBLICO (sin
 * auth) y la convención del repo (`types/index.ts`, WKH-141/CD-6) prohíbe
 * explícitamente exponer identificadores de tenant en payloads públicos:
 * enumerar `owner_ref` mapea qué tenant registró qué marketplace. Era
 * pre-existente (`list()` ya lo devolvía), pero acuñar el tipo público es el
 * momento de dropearlo. Los guards de ownership internos (`update`/`delete`)
 * leen `ownerRef` de `getWithSecrets()`, que nunca cruza HTTP.
 */
export function toRegistryPublic(registry: RegistryConfig): RegistryPublic {
  const value = registry.auth?.value;
  return {
    id: registry.id,
    name: registry.name,
    discoveryEndpoint: registry.discoveryEndpoint,
    invokeEndpoint: registry.invokeEndpoint,
    ...(registry.agentEndpoint !== undefined && {
      agentEndpoint: registry.agentEndpoint,
    }),
    schema: registry.schema,
    enabled: registry.enabled,
    createdAt: registry.createdAt,
    ...(registry.auth?.type !== undefined && { authType: registry.auth.type }),
    authConfigured: typeof value === 'string' && value.length > 0,
  };
}

// ── Helper: RegistryConfig → columnas para INSERT/UPDATE ────

function registryToRow(
  config: Omit<RegistryConfig, 'id' | 'createdAt'>,
  id: string,
): Database['public']['Tables']['registries']['Insert'] {
  return {
    id,
    name: config.name,
    discovery_endpoint: config.discoveryEndpoint,
    invoke_endpoint: config.invokeEndpoint,
    agent_endpoint: config.agentEndpoint ?? null,
    // M9: `schema`/`auth` son jsonb (`Json`); el dominio usa interfaces sin
    // index signature → narrowing acotado a esos dos campos.
    schema: config.schema as unknown as Json,
    auth: (config.auth ?? null) as unknown as Json,
    enabled: config.enabled,
    owner_ref: config.ownerRef,
  };
}

// ── Service ─────────────────────────────────────────────────

export const registryService = {
  /**
   * List all registries (público — visibilidad no cambia con WKH-63).
   *
   * HIGH-1: devuelve `RegistryPublic[]` — SIN `auth.value`. No existe variante
   * `listWithSecrets`: ningún consumidor necesita las credenciales de TODAS
   * las registries a la vez (el fanout outbound usa `getEnabled`).
   */
  async list(): Promise<RegistryPublic[]> {
    const { data, error } = await supabase
      .from('registries')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) throw new Error(`Failed to list registries: ${error.message}`);

    // M9: narrowing acotado — `schema`/`auth` jsonb (`Json`) → shapes de dominio.
    return (data as unknown as RegistryRow[])
      .map(rowToRegistry)
      .map(toRegistryPublic);
  },

  /**
   * Get a specific registry by ID (público — visibilidad no cambia).
   *
   * HIGH-1: devuelve `RegistryPublic` — SIN `auth.value`. Este es el método
   * por defecto para rutas HTTP y checks de existencia. Si necesitás la
   * credencial para un fetch outbound — o el `ownerRef` para un guard de
   * ownership (MNR-5: ya no viaja en la proyección pública) — usá
   * `getWithSecrets`, cuyo nombre hace explícito que el resultado NO puede
   * cruzar el borde HTTP.
   */
  async get(id: string): Promise<RegistryPublic | undefined> {
    const registry = await this.getWithSecrets(id);
    return registry ? toRegistryPublic(registry) : undefined;
  },

  /**
   * ⚠️ INTERNO — devuelve la fila COMPLETA, con `auth.value` en claro.
   *
   * HIGH-1: usar SOLO para construir headers de un fetch outbound
   * (`discovery.fetchFromRegistry`). El resultado NUNCA debe llegar a
   * `reply.send()`: pasalo por `toRegistryPublic()` primero (el tipo
   * `RegistryPublic` no lo acepta directamente, así que `tsc` te avisa).
   */
  async getWithSecrets(id: string): Promise<RegistryConfig | undefined> {
    const { data, error } = await supabase
      .from('registries')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error)
      throw new Error(`Failed to get registry '${id}': ${error.message}`);

    // M9: narrowing acotado — `schema`/`auth` jsonb → shapes de dominio.
    return data ? rowToRegistry(data as unknown as RegistryRow) : undefined;
  },

  /**
   * Register a new marketplace.
   * ID is generated from name (slug). El `ownerRef` lo provee el route
   * handler desde `request.a2aKeyRow.owner_ref` (WKH-63).
   *
   * HIGH-1: la respuesta es `RegistryPublic` — el echo-back del row insertado
   * tampoco repite `auth.value` (aunque el caller lo acabe de enviar, el
   * response body queda en logs/proxies del cliente).
   */
  async register(
    config: Omit<RegistryConfig, 'id' | 'createdAt' | 'ownerRef'>,
    ownerRef: string,
  ): Promise<RegistryPublic> {
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

    // WKH-100 FIX v3 (DT-23.4 / BLQ-MED-1): name → PK debe ser inyectivo.
    // El PK colapsa whitespace (`.replace(/\s+/g,'-')`) mientras el match
    // histórico hacía `.trim()`; nombres con whitespace de borde o interno
    // colapsable producían PKs distintos del esperado, habilitando colisión
    // de normalización (badge spoofing). Rechazarlos en el origen.
    if (config.name !== config.name.trim()) {
      throw new Error('Invalid registry name: leading/trailing whitespace');
    }
    if (/\s\s/.test(config.name)) {
      throw new Error('Invalid registry name: collapsible internal whitespace');
    }

    // WKH-366 fix-pack: namespace reservado. El guard REAL es `registerBodyCheck`
    // (pre-cobro, en la route); esto es defense-in-depth con la MISMA función
    // pura, por si alguien reordena la cadena de preHandlers o llama al service
    // directo. Mismo patrón —y mismo `throw new Error` ⇒ 400 en la route— que la
    // colisión de PK de tres líneas más abajo: no se estrena un status nuevo.
    if (isReservedRegistryName(config.name)) {
      throw new Error(`Registry name '${config.name}' is reserved`);
    }

    const id = config.name.toLowerCase().replace(/\s+/g, '-');

    // Pre-check de colisión de PK (DT-23.4): rechazar si ya existe. El `23505`
    // del insert se mantiene como defensa final por race.
    const clash = await this.get(id);
    if (clash) {
      throw new Error(`Registry '${id}' already exists`);
    }

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

    // M9: narrowing acotado — `schema`/`auth` jsonb → shapes de dominio.
    return toRegistryPublic(rowToRegistry(data as unknown as RegistryRow));
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
  ): Promise<RegistryPublic> {
    // 1+2+3+4: pre-fetch + ownership/system check.
    // MNR-5: `getWithSecrets` (misma query que `get`) porque el guard necesita
    // `ownerRef`, que ya NO viaja en la proyección pública. `existing` es
    // INTERNO: sólo se le leen `ownerRef`; el response se construye abajo con
    // `toRegistryPublic(...)` sobre la fila fresca del UPDATE.
    const existing = await this.getWithSecrets(id);
    if (!existing) {
      logOwnershipMismatch({
        op: 'registryUpdate',
        resourceId: id,
        callerOwnerRef: ownerRef,
      });
      throw new OwnershipMismatchError();
    }
    if (existing.ownerRef === SYSTEM_OWNER_REF) {
      throw new SystemRegistryImmutableError();
    }
    if (existing.ownerRef !== ownerRef) {
      logOwnershipMismatch({
        op: 'registryUpdate',
        resourceId: id,
        callerOwnerRef: ownerRef,
        actualOwnerRef: existing.ownerRef,
      });
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

    // Construir objeto de actualización con snake_case.
    // M9: tipado contra el Update real; `schema`/`auth` jsonb → narrowing acotado.
    const updateRow: Database['public']['Tables']['registries']['Update'] = {};

    if (updates.name !== undefined) updateRow.name = updates.name;
    if (updates.discoveryEndpoint !== undefined)
      updateRow.discovery_endpoint = updates.discoveryEndpoint;
    if (updates.invokeEndpoint !== undefined)
      updateRow.invoke_endpoint = updates.invokeEndpoint;
    if (updates.agentEndpoint !== undefined)
      updateRow.agent_endpoint = updates.agentEndpoint ?? null;
    if (updates.schema !== undefined)
      updateRow.schema = updates.schema as unknown as Json;
    if (updates.auth !== undefined)
      updateRow.auth = (updates.auth ?? null) as unknown as Json;
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
        logOwnershipMismatch({
          op: 'registryUpdate',
          resourceId: id,
          callerOwnerRef: ownerRef,
        });
        throw new OwnershipMismatchError();
      }
      throw new Error(`Failed to update registry '${id}': ${error.message}`);
    }

    // M9: narrowing acotado — `schema`/`auth` jsonb → shapes de dominio.
    // HIGH-1: el PATCH devolvía la fila entera, incluida la credencial que el
    // caller NO tocó en este request.
    return toRegistryPublic(rowToRegistry(data as unknown as RegistryRow));
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
    // MNR-5: ver `update` — el guard lee `ownerRef`, que ya no está en la
    // proyección pública. Nada de `existing` se devuelve al caller.
    const existing = await this.getWithSecrets(id);
    if (!existing) {
      logOwnershipMismatch({
        op: 'registryDelete',
        resourceId: id,
        callerOwnerRef: ownerRef,
      });
      throw new OwnershipMismatchError();
    }
    if (existing.ownerRef === SYSTEM_OWNER_REF) {
      throw new SystemRegistryImmutableError();
    }
    if (existing.ownerRef !== ownerRef) {
      logOwnershipMismatch({
        op: 'registryDelete',
        resourceId: id,
        callerOwnerRef: ownerRef,
        actualOwnerRef: existing.ownerRef,
      });
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
   * ⚠️ INTERNO — devuelve filas COMPLETAS, con `auth.value` en claro.
   *
   * Usado por el fanout outbound (`discovery`, `compose`) y por
   * `routes/agent-card.ts`, que solo lee `auth.type` vía
   * `agentCardService.resolveAuthSchemes`. HIGH-1: ninguna ruta devuelve este
   * resultado verbatim; si agregás un read-path que lo haga, mapealo con
   * `toRegistryPublic()` (y el test `registries.redaction.test.ts` lo caza).
   */
  async getEnabled(): Promise<RegistryConfig[]> {
    const { data, error } = await supabase
      .from('registries')
      .select('*')
      .eq('enabled', true)
      .order('created_at', { ascending: true });

    if (error)
      throw new Error(`Failed to get enabled registries: ${error.message}`);

    // M9: narrowing acotado — `schema`/`auth` jsonb → shapes de dominio.
    return (data as unknown as RegistryRow[]).map(rowToRegistry);
  },
};
