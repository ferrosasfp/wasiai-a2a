/**
 * Identity Service — A2A Agent Key management
 * WKH-34: Agentic Economy Primitives L3
 */

import crypto from 'node:crypto';
import { supabase } from '../lib/supabase.js';
import { asAgentKeyRow } from '../types/a2a-key.js';
import type { Database, Json } from '../types/database.types.js';
import type {
  A2AAgentKeyRow,
  AgentCardIdentity,
  AgentSignupResponse,
  CreateKeyInput,
  Erc8004IdentityBinding,
} from '../types/index.js';
import {
  Erc8004TokenAlreadyBoundError,
  FundingWalletAlreadyBoundError,
  logOwnershipMismatch,
  OwnershipMismatchError,
} from './security/errors.js';

/**
 * WKH-100 FIX v3 (DT-23 §12.4): canoniza slug de forma determinista en AMBOS
 * lados del match. El binding ya validó SLUG_RE; el slug del Agent puede venir
 * sin canonizar del upstream. Idempotente.
 */
function normalizeSlug(s: string): string {
  return s.trim().toLowerCase();
}

// ── ERC-8004 identity helper (WKH-100, AC-6) ─────────────────

/**
 * Derived, pure check: a key has a verified ERC-8004 identity iff its
 * `erc8004_identity` JSONB is non-null (DT-17). No RPC — the on-chain verify
 * already happened at bind-time. Used by the middleware / resolveCallerKey to
 * set the transient `erc8004_verified` flag.
 */
export function isIdentityVerified(
  row: Pick<A2AAgentKeyRow, 'erc8004_identity'>,
): boolean {
  return row.erc8004_identity != null;
}

// ── Service ─────────────────────────────────────────────────

export const identityService = {
  /**
   * Create a new agent key. Returns the plaintext key exactly once.
   * The plaintext is NEVER stored or logged (CD-4).
   */
  async createKey(input: CreateKeyInput): Promise<AgentSignupResponse> {
    // 1. Generate 32 random bytes -> 64 hex chars
    const randomHex = crypto.randomBytes(32).toString('hex');
    const plaintext = `wasi_a2a_${randomHex}`;

    // 2. Compute SHA-256 hash
    const keyHash = crypto.createHash('sha256').update(plaintext).digest('hex');

    // 3. Insert row (tipado contra el Insert real de la tabla — M9)
    const row: Database['public']['Tables']['a2a_agent_keys']['Insert'] = {
      key_hash: keyHash,
      owner_ref: input.owner_ref,
      display_name: input.display_name ?? null,
      daily_limit_usd: input.daily_limit_usd ?? null,
      allowed_registries: input.allowed_registries ?? null,
      allowed_agent_slugs: input.allowed_agent_slugs ?? null,
      allowed_categories: input.allowed_categories ?? null,
      max_spend_per_call_usd: input.max_spend_per_call_usd ?? null,
    };

    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .insert(row)
      .select('id')
      .single();

    if (error) throw new Error(`Failed to create agent key: ${error.message}`);

    return {
      key: plaintext,
      key_id: data.id, // M9: fila tipada (.select('id')), sin cast
    };
  },

  /**
   * Look up an agent key row by its SHA-256 hash.
   */
  async lookupByHash(keyHash: string): Promise<A2AAgentKeyRow | null> {
    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .select('*')
      .eq('key_hash', keyHash)
      .single();

    if (error) {
      // PGRST116 = "no rows found" — not an error, just null
      if (error.code === 'PGRST116') return null;
      throw new Error(`Failed to lookup agent key: ${error.message}`);
    }

    return asAgentKeyRow(data);
  },

  /**
   * Deactivate an agent key by setting is_active = false.
   * updated_at is handled by the DB trigger.
   */
  async deactivate(keyId: string, ownerId: string): Promise<void> {
    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .update({ is_active: false })
      .eq('id', keyId)
      .eq('owner_ref', ownerId)
      .select('id');

    if (error)
      throw new Error(`Failed to deactivate agent key: ${error.message}`);

    if (!data || data.length === 0) {
      logOwnershipMismatch('deactivate', keyId, ownerId);
      throw new OwnershipMismatchError();
    }
  },

  /**
   * Toggle `require_signature` on a master key (WKH-123, AC-10). Ownership Guard
   * (CLAUDE.md / CD-4): UPDATE filtered by id AND owner_ref so a caller can only
   * flip ITS OWN key. `ownerRef` is required (NEVER `string | undefined`).
   * 0 rows matched → logOwnershipMismatch + OwnershipMismatchError (403). The
   * route validates `funding_wallet` is bound before enabling (AC-9 surface).
   */
  async setRequireSignature(
    keyId: string,
    ownerRef: string,
    value: boolean,
  ): Promise<void> {
    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .update({ require_signature: value })
      .eq('id', keyId)
      .eq('owner_ref', ownerRef)
      .select('id');

    if (error) {
      throw new Error(`Failed to set require_signature: ${error.message}`);
    }

    if (!data || data.length === 0) {
      logOwnershipMismatch({
        op: 'requireSignature',
        resourceId: keyId,
        callerOwnerRef: ownerRef,
      });
      throw new OwnershipMismatchError();
    }
  },

  /**
   * Bind a funding wallet to a key (WKH-35 FIX-1). The caller proved control
   * of `wallet` (signature verified at the route). Stored lowercase.
   *
   * Ownership Guard (CLAUDE.md): UPDATE filtered by id AND owner_ref so a
   * caller can only bind a wallet to ITS OWN key. If no row matches the
   * (id, owner_ref) pair → OwnershipMismatchError. If `wallet` is already
   * bound to another key, the partial UNIQUE index raises 23505 →
   * FundingWalletAlreadyBoundError. Returns the stored (lowercase) wallet.
   */
  async bindFundingWallet(
    keyId: string,
    ownerId: string,
    wallet: string,
  ): Promise<string> {
    const normalized = wallet.toLowerCase();

    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .update({ funding_wallet: normalized })
      .eq('id', keyId)
      .eq('owner_ref', ownerId)
      .select('id');

    if (error) {
      // Partial UNIQUE(funding_wallet) violation: wallet ya bound a otra key.
      if (error.code === '23505') {
        throw new FundingWalletAlreadyBoundError();
      }
      throw new Error(`Failed to bind funding wallet: ${error.message}`);
    }

    if (!data || data.length === 0) {
      logOwnershipMismatch('deactivate', keyId, ownerId);
      throw new OwnershipMismatchError();
    }

    return normalized;
  },

  /**
   * WKH-315 (AC-7 / AC-8) — bind de la funding wallet **Solana** a una key.
   *
   * Copia de `bindFundingWallet` con UNA diferencia, y es la que importa: **no hay
   * `toLowerCase()` en ningún punto**. La pubkey se persiste y se devuelve
   * BYTE-EXACTA, tal como llegó.
   *
   * ⚠️ POR QUE NO SE NORMALIZA LA CAJA, Y POR QUE ES UNA COLUMNA APARTE.
   *
   * base58 usa mayúsculas y minúsculas como SIMBOLOS DISTINTOS. Bajar de caja una
   * pubkey no la "normaliza": la **destruye**, y peor, mapea pubkeys diferentes al
   * mismo valor almacenado — o sea colisiones en un índice UNIQUE que existe para
   * impedir que dos keys reclamen la misma wallet. En Postgres la igualdad de `TEXT`
   * ya es byte-exacta, así que el índice es case-sensitive sin hacer nada.
   *
   * Y por eso es una COLUMNA NUEVA en vez de reusar `funding_wallet`: ese campo se
   * persiste lowercase desde la app y su migración lo declara CONTRATO. Cambiarlo
   * tocaría el camino EVM (CD-1). Además, con una sola columna un owner no podría
   * tener las dos wallets bindeadas a la vez.
   *
   * El resto es idéntico: Ownership Guard (`UPDATE` filtrado por `id` **y**
   * `owner_ref`, porque el cliente usa `SUPABASE_SERVICE_KEY` y bypassa RLS), 0 filas
   * ⇒ `OwnershipMismatchError`, `23505` del UNIQUE parcial ⇒
   * `FundingWalletAlreadyBoundError`.
   *
   * `bindFundingWallet` **no se toca**.
   */
  async bindSolanaFundingWallet(
    keyId: string,
    ownerId: string,
    pubkey: string,
  ): Promise<string> {
    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .update({ funding_wallet_solana: pubkey })
      .eq('id', keyId)
      .eq('owner_ref', ownerId)
      .select('id');

    if (error) {
      // UNIQUE parcial (funding_wallet_solana) violado: la pubkey ya está bindeada a
      // otra key.
      if (error.code === '23505') {
        throw new FundingWalletAlreadyBoundError();
      }
      throw new Error(`Failed to bind solana funding wallet: ${error.message}`);
    }

    if (!data || data.length === 0) {
      // ⚠️ `'deactivate'` NO describe lo que pasó: esto es un fallo de ownership del
      // BIND Solana. Se reusa esa etiqueta porque `OwnershipOp` (`errors.ts`) no
      // expone una op de funding-wallet y ese archivo está fuera del scope de la HU —
      // el mismo criterio, y el mismo comentario, que `bindPassport` (`:289`) y
      // `bindErc8004Identity` (`:357`). El logger es PII-safe igual. Sin esta nota, un
      // campo que MIENTE en un log de seguridad queda sin explicación al lado (fix-pack
      // CR · MNR-8). Deuda chica y real: un `OwnershipOp` con la op verdadera.
      logOwnershipMismatch('deactivate', keyId, ownerId);
      throw new OwnershipMismatchError();
    }

    return pubkey;
  },

  /**
   * Bind a Kite Agent Passport address to a key (WKH-117, AC-8).
   *
   * Ownership Guard (CLAUDE.md / CD-3): UPDATE filtered by id AND owner_ref so
   * a caller can only bind a passport to ITS OWN key. 0 rows matched →
   * OwnershipMismatchError. `ownerId` is required (NEVER `string | undefined`).
   * Stores `{ address (lowercase), bound_at (ISO) }` in the `kite_passport`
   * JSONB. Read-only on every auth/debit path (AC-9) — never an auth signal.
   */
  async bindPassport(
    keyId: string,
    ownerId: string,
    passportAddress: string,
  ): Promise<{ address: string; bound_at: string }> {
    const normalized = passportAddress.toLowerCase();
    const boundAt = new Date().toISOString();

    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .update({ kite_passport: { address: normalized, bound_at: boundAt } })
      .eq('id', keyId)
      .eq('owner_ref', ownerId)
      .select('id');

    if (error) {
      throw new Error(`Failed to bind passport: ${error.message}`);
    }

    if (!data || data.length === 0) {
      // Reusa la op 'deactivate' del overload posicional legacy, igual que
      // bindFundingWallet (OwnershipOp no expone una op de passport y errors.ts
      // está fuera de scope; el logger es PII-safe igual).
      logOwnershipMismatch('deactivate', keyId, ownerId);
      throw new OwnershipMismatchError();
    }

    return { address: normalized, bound_at: boundAt };
  },

  /**
   * Bind an on-chain-verified ERC-8004 identity to a key (WKH-100, AC-1).
   *
   * The handler already verified `ownerOf(token_id) == funding_wallet`
   * server-side (CD-7/CD-10) and built the `binding`. Here we only persist the
   * JSONB. Ownership Guard (CLAUDE.md / CD-3): UPDATE filtered by id AND
   * owner_ref so a caller can only bind identity to ITS OWN key; 0 rows →
   * OwnershipMismatchError. This method NEVER touches `budget` /
   * `increment_a2a_key_spend` / `register_a2a_key_deposit` (CD-2/AC-12), and
   * does NOT re-check idempotency (that is the handler's job — DT-8).
   *
   * WKH-100 FIX-PACK (BLQ-MED-1 / DT-21.6): UNICIDAD token↔key activa. Antes de
   * persistir, pre-check app-layer: si OTRA key activa (`id != keyId`) ya tiene
   * el mismo `token_id`+`chain_id` bindeado → `Erc8004TokenAlreadyBoundError`
   * (handler → 409, sin write). El re-bind del MISMO owner sobre su MISMA key
   * (idempotencia AC-5) NO colisiona porque se excluye `id == keyId`. El SELECT
   * del pre-check trae SOLO `id`+`erc8004_identity` — NUNCA budget (CD-2). Si en
   * el futuro se agrega el índice parcial UNIQUE, el `23505` también se mapea a
   * este error (defensa en profundidad, igual que `bindFundingWallet`).
   */
  async bindErc8004Identity(
    keyId: string,
    ownerId: string,
    binding: Erc8004IdentityBinding,
  ): Promise<Erc8004IdentityBinding> {
    // Pre-check de unicidad (DT-21.6): otra key activa con el mismo token+chain.
    const { data: clashing, error: clashErr } = await supabase
      .from('a2a_agent_keys')
      .select('id') // SOLO id — NUNCA budget/funding_wallet (CD-2)
      .eq('is_active', true)
      .neq('id', keyId)
      .eq('erc8004_identity->>token_id', binding.token_id)
      .eq('erc8004_identity->>chain_id', String(binding.chain_id))
      .limit(1);

    if (clashErr)
      throw new Error(
        `Failed to check erc8004 token uniqueness: ${clashErr.message}`,
      );
    if (clashing && clashing.length > 0) {
      throw new Erc8004TokenAlreadyBoundError();
    }

    const { data, error } = await supabase
      .from('a2a_agent_keys')
      // M9: narrowing acotado al campo jsonb. `Erc8004IdentityBinding` es una
      // interface sin index signature → no asignable a `Json` directamente.
      .update({ erc8004_identity: binding as unknown as Json }) // escribe el JSONB completo; NO toca budget (CD-2)
      .eq('id', keyId)
      .eq('owner_ref', ownerId) // Ownership Guard COMPLETO (CD-3)
      .select('id');

    if (error) {
      // Hardening: partial UNIQUE((token_id),(chain_id)) WHERE is_active → 23505.
      if (error.code === '23505') {
        throw new Erc8004TokenAlreadyBoundError();
      }
      throw new Error(`Failed to bind erc8004 identity: ${error.message}`);
    }

    if (!data || data.length === 0) {
      logOwnershipMismatch('deactivate', keyId, ownerId); // DT-13: reusa label existente
      throw new OwnershipMismatchError();
    }

    return binding;
  },

  /**
   * Reverse-lookup PÚBLICO de identidad por el match BIDIRECCIONAL completo
   * (WKH-100 FIX-PACK v2, MNR-1 / DT-22). SUPERSEDE `resolveIdentityForToken`.
   *
   * El badge `verified:true` exige TRES anclajes simultáneos (ver
   * `AgentCardIdentity` en types/index.ts):
   *   (i)   el AgentCard del agente DECLARA este token (lo provee el caller vía
   *         `extractDeclaredTokenId` en discovery → `tokenId`+`chainId`);
   *   (ii)  ese token está bindeado + `ownerOf`-verificado localmente al
   *         bindear (el verify on-chain ya ocurrió, auth.ts);
   *   (iii) ESE binding DECLARA operar ESTE agente vía
   *         `(agent_registry, agent_slug)` == `(agentRegistryId, agentSlug)`.
   * Si falta CUALQUIER anclaje → null (SIN badge). Esto cierra el vector
   * inverso (MNR-1): un atacante que declara el token público de la víctima en
   * su propia card NO obtiene badge porque el binding de la víctima declara
   * operar (regVíctima, slugVíctima), no (regAtacante, slugAtacante).
   *
   * WKH-100 FIX v3 (DT-23 / BLQ-MED-1): el ancla del lado-binder es el **PK
   * `id` del registry** (`agentRegistryId`), NO el display name. El match de
   * registry es por **igualdad ESTRICTA** (`b.agent_registry === agentRegistryId`)
   * SIN `.trim().toLowerCase()`: ambos lados ya son el PK canónico (único +
   * inmutable), así que re-normalizar reintroduciría la no-inyectividad que
   * permitía el badge spoofing por colisión de normalización del name
   * (`"WasiAI "` y `"WasiAI"` colapsaban al mismo token tras `.trim()`). El
   * slug SÍ se canoniza vía `normalizeSlug` en ambos lados (el slug upstream
   * puede no venir canonizado), discriminando SOLO dentro de un mismo
   * `registry_id`.
   *
   * Bindings legacy v1 (sin `agent_registry`/`agent_slug`) → null (default
   * seguro, AC-9). La key NO se degrada.
   *
   * DT-19 / NOTA PARA AR-CR: este SELECT NO lleva `.eq('owner_ref', ...)` **a
   * propósito**. Es lectura PÚBLICA (no por `keyId` del caller) que devuelve
   * SOLO `{ token_id, chain_id, verified }` — datos públicamente verificables
   * on-chain. NUNCA trae `budget` / `funding_wallet` / PII (CD-2). NO es IDOR.
   *
   * MNR-1 (perf): la igualdad por `token_id`+`chain_id` es indexable
   * (uq_a2a_agent_keys_erc8004_token, FPv2.7). Se usa el FALLBACK determinista
   * en JS (independiente del soporte de operadores JSONB `->>` de la versión
   * instalada de PostgREST): traer candidatas activas con identity no-null y
   * cruzar los 4 campos en JS. La page de discover solo invoca esto para
   * agentes con declaración válida (skip si no).
   */
  async resolveIdentityForAgent(
    tokenId: string,
    chainId: number,
    agentRegistryId: string,
    agentSlug: string,
  ): Promise<AgentCardIdentity | null> {
    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .select('erc8004_identity') // SOLO esta columna — NUNCA budget (CD-2/DT-19)
      .eq('is_active', true) // solo keys activas surfacean
      .not('erc8004_identity', 'is', null);

    if (error || !data) return null;

    const nSlug = normalizeSlug(agentSlug);

    for (const row of data) {
      // M9: narrowing acotado del campo jsonb (DB lo tipa `Json`; el dominio
      // modela el shape Erc8004IdentityBinding).
      const b = row.erc8004_identity as Erc8004IdentityBinding | null;
      if (!b) continue;
      // Lado token/agente: el token DECLARADO por el agente está bindeado.
      if (b.token_id !== tokenId || b.chain_id !== chainId) continue;
      // Lado binder: el binding debe declarar operar ESTE agente. Sin ancla
      // (binding v1) → sin badge (default seguro, AC-9).
      if (!b.agent_registry || !b.agent_slug) continue;
      // DT-23: igualdad ESTRICTA del PK (sin normalizar → inyectivo).
      if (b.agent_registry !== agentRegistryId) continue;
      if (normalizeSlug(b.agent_slug) !== nSlug) continue;
      return {
        erc8004_token_id: b.token_id,
        chain_id: b.chain_id,
        verified: true,
      };
    }
    return null;
  },

  /**
   * WKH-133 (DT-6): resuelve el `agentId` on-chain ERC-8004 (token_id) de un
   * agente de discovery por su `slug` + `chainId`, SOLO vía binding verificado.
   *
   * Devuelve el token_id como `bigint` SOLO si hay EXACTAMENTE 1 binding activo
   * cuyo `agent_slug` (canonizado) coincide con `slug` en la `chainId` dada. Con
   * 0 o >1 matches → `null` (fail-safe CD-9: nunca se escribe feedback al agente
   * equivocado; una colisión de slug entre registries es ambigua → skip). Los
   * bindings v1 sin `agent_slug` (ancla) → skip.
   *
   * DT-19 / NOTA PARA AR-CR: este SELECT trae SOLO `erc8004_identity` — NUNCA
   * `budget`/`funding_wallet`/PII (CD-2). No es lectura por `keyId` del caller ni
   * expone nada por ruta HTTP; NO es IDOR. Sin throw: ante error de DB → null.
   */
  async resolveErc8004AgentId(
    slug: string,
    chainId: number,
  ): Promise<bigint | null> {
    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .select('erc8004_identity') // SOLO esta columna — NUNCA budget (CD-2/DT-19)
      .eq('is_active', true)
      .not('erc8004_identity', 'is', null);
    if (error || !data) return null;

    const nSlug = normalizeSlug(slug);
    const matches: bigint[] = [];
    for (const row of data) {
      const b = row.erc8004_identity as Erc8004IdentityBinding | null;
      if (!b) continue;
      if (!b.agent_slug) continue; // binding v1 sin ancla → skip (CD-9)
      if (normalizeSlug(b.agent_slug) !== nSlug) continue;
      if (b.chain_id !== chainId) continue;
      // AR MNR-1: `BigInt(...)` lanza (SyntaxError) ante un token_id no-numérico
      // (binding corrupto). Fail-safe CD-9: skip ese binding, NUNCA throw.
      let tokenId: bigint;
      try {
        tokenId = BigInt(b.token_id); // token_id: string decimal (anti-precision-loss)
      } catch {
        continue;
      }
      matches.push(tokenId);
    }
    // Exactamente 1 → escribir. 0 o >1 → null (fail-safe, CD-9).
    if (matches.length === 1) {
      const only = matches[0];
      if (only === undefined) return null; // CD-11: guard explícito, sin `!`
      return only;
    }
    return null;
  },
};
