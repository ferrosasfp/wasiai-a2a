/**
 * Delegation Service — WKH-101 (Fase 2: EIP-712 session keys)
 *
 * El owner de una Agent Key (master key) firma un typed-data EIP-712 con una
 * policy de gasto y autoriza una session key efímera. Este service:
 *   1. recupera el firmante con viem `recoverTypedDataAddress`,
 *   2. exige que sea el `funding_wallet` bindeado de la key (ancla EXCLUSIVA, CD-11),
 *   3. emite un token opaco `wasi_a2a_session_<random>` (persiste SOLO su SHA-256),
 *   4. provee lookup hot-path, listado, revocación, y el débito atómico doble.
 *
 * Atomicidad (CD-12): el check+debit de `total_spent` y del parent budget ocurre
 * DENTRO del RPC `debit_delegation_and_parent` bajo FOR UPDATE. El service solo
 * invoca `supabase.rpc(...)` y mapea errores por prefijo de mensaje (mismo patrón
 * que budgetService.registerDeposit).
 */

import crypto from 'node:crypto';
import { recoverTypedDataAddress } from 'viem';
import { supabase } from '../lib/supabase.js';
import type {
  A2AAgentKeyRow,
  CreateDelegationInput,
  CreateDelegationResponse,
  DelegationEip712Domain,
  DelegationListItem,
  DelegationRow,
  DelegationStatus,
  DelegationTypedData,
} from '../types/index.js';
import {
  AgentKeyBudgetExhaustedError,
  DelegationExpiredError,
  DelegationNonceReplayError,
  DelegationRevokedError,
  DelegationSignerMismatchError,
  DelegationTotalLimitExceededError,
  logOwnershipMismatch,
  OwnershipMismatchError,
} from './security/errors.js';

const SESSION_TOKEN_PREFIX = 'wasi_a2a_session_';

// ── EIP-712 builders (CD-6, leen env) ──────────────────────────

/** Domain del server. `verifyingContract` se omite a propósito (NC-3). */
function buildDomain(): DelegationEip712Domain {
  return {
    name: process.env.DELEGATION_EIP712_NAME ?? 'WasiAI-a2a Delegation',
    version: process.env.DELEGATION_EIP712_VERSION ?? '1',
    chainId: Number(process.env.KITE_CHAIN_ID),
  };
}

// types EIP-712. [VERIFY-AT-IMPL] confirmado contra viem 2.50.4
// (node_modules/viem/_types/utils/signature/recoverTypedDataAddress.d.ts):
//   recoverTypedDataAddress<const typedData extends TypedData | Record<...>>(
//     { domain, types, primaryType, message, signature }): Promise<Address>
// El campo `EIP712Domain` NO se incluye en `types` (viem lo infiere del domain);
// `as const` basta para tipar sin `any`/`as unknown` (CD-7).
const DELEGATION_TYPES = {
  Delegation: [
    { name: 'session_key', type: 'address' },
    { name: 'policy', type: 'DelegationPolicy' },
    { name: 'nonce', type: 'bytes32' },
  ],
  DelegationPolicy: [
    { name: 'max_amount_per_tx', type: 'string' },
    { name: 'max_total_amount', type: 'string' },
    { name: 'expires_at', type: 'uint64' },
    { name: 'allowed_chains', type: 'uint256[]' },
    { name: 'allowed_agent_slugs', type: 'string[]' },
    { name: 'allowed_registries', type: 'string[]' },
  ],
} as const;

// ── Helper PURO (AC-7) — POR STEP ──────────────────────────────

/**
 * Compara `stepCostUsd` (number, del pipeline) vs `maxAmountPerTx` (string de la
 * policy firmada). Devuelve true si el costo SUPERA el límite (caller → 403).
 *
 * CD-AB-3: el riesgo de pérdida float64 está en el lado del STRING de la policy.
 * La policy se valida a 2 decimales máx al crear (decimal USD), y `stepCostUsd`
 * ya es un `number` del pipeline. Comparamos en unidades enteras de micro-USD
 * (×1e6) con `Math.round` para evitar el error binario de `0.1 + 0.2 !== 0.3`
 * sin convertir el string a float64 de forma lossy. Inputs no numéricos en el
 * string → se tratan como límite 0 (deniega — fail-secure).
 */
export function exceedsPerTxLimit(
  maxAmountPerTx: string,
  stepCostUsd: number,
): boolean {
  // Parse del string a micro-USD entero sin float64 (parser decimal manual).
  const limitMicro = decimalStringToMicroUsd(maxAmountPerTx);
  if (limitMicro === null) return true; // string inválido → fail-secure (deniega)
  const costMicro = Math.round(stepCostUsd * 1_000_000);
  return costMicro > limitMicro;
}

/**
 * Convierte un string decimal USD (p.ej. "0.50", "100", "1.234567") a un entero
 * de micro-USD (×1e6) SIN pasar por float64. Devuelve null si el formato es
 * inválido. Trunca a 6 decimales (precisión micro-USD).
 */
function decimalStringToMicroUsd(raw: string): number | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [intPart, fracPartRaw = ''] = s.split('.');
  const fracPart = `${fracPartRaw}000000`.slice(0, 6); // pad/truncate a 6 dec
  const micro = Number(intPart) * 1_000_000 + Number(fracPart);
  return Number.isFinite(micro) ? micro : null;
}

// ── Service ────────────────────────────────────────────────────

export const delegationService = {
  /**
   * Recupera el firmante del typed-data EIP-712 (AC-1/AC-3).
   * Valida domain == server domain ANTES de recuperar (domain binding, DT-1).
   * Throws DelegationSignerMismatchError si el domain diverge o el recover falla.
   */
  async verifyTypedData(
    typedData: DelegationTypedData,
    signature: string,
  ): Promise<`0x${string}`> {
    // Domain binding (DT-1): el domain del cliente DEBE coincidir con el server.
    const serverDomain = buildDomain();
    if (
      typedData.domain.name !== serverDomain.name ||
      typedData.domain.version !== serverDomain.version ||
      typedData.domain.chainId !== serverDomain.chainId
    ) {
      throw new DelegationSignerMismatchError();
    }

    try {
      // Usamos los types del SERVER (canónicos) — no los del cliente — para que
      // el hash sea determinista. El message del cliente llega como JSON, por lo
      // que los campos `uint64`/`uint256[]` vienen como `number`; viem infiere
      // esos tipos EIP-712 como `bigint`, así que los convertimos al pasar (los
      // valores numéricos NO se reconstruyen, solo se re-tipan a bigint).
      const m = typedData.message;
      const recovered = await recoverTypedDataAddress({
        domain: {
          name: serverDomain.name,
          version: serverDomain.version,
          chainId: serverDomain.chainId,
        },
        types: DELEGATION_TYPES,
        primaryType: 'Delegation',
        message: {
          session_key: m.session_key,
          policy: {
            max_amount_per_tx: m.policy.max_amount_per_tx,
            max_total_amount: m.policy.max_total_amount,
            expires_at: BigInt(m.policy.expires_at),
            allowed_chains: m.policy.allowed_chains.map((c) => BigInt(c)),
            allowed_agent_slugs: m.policy.allowed_agent_slugs,
            allowed_registries: m.policy.allowed_registries,
          },
          nonce: m.nonce,
        },
        signature: signature as `0x${string}`,
      });
      return recovered;
    } catch {
      throw new DelegationSignerMismatchError();
    }
  },

  /**
   * Crea la delegación (AC-1/AC-3/AC-4). El handler ya validó funding_wallet (AC-2).
   * verifyTypedData → comparar signer.toLowerCase() === parentKey.funding_wallet →
   * validar policy ≡ typed_data.message.policy y expires_at coherente → generar
   * token + hash → INSERT (23505 → DelegationNonceReplayError).
   * `owner_ref`/`key_id` salen de parentKey, NUNCA del request.
   */
  async create(
    parentKey: A2AAgentKeyRow,
    input: CreateDelegationInput,
  ): Promise<CreateDelegationResponse> {
    // 1. Recuperar firmante (domain binding adentro).
    const signer = await this.verifyTypedData(
      input.typed_data,
      input.signature,
    );

    // 2. Ancla = funding_wallet EXCLUSIVO (CD-11). funding_wallet ya validado
    //    no-null en el handler; defensa adicional acá.
    const fundingWallet = parentKey.funding_wallet;
    if (!fundingWallet) {
      throw new DelegationSignerMismatchError();
    }
    if (signer.toLowerCase() !== fundingWallet.toLowerCase()) {
      throw new DelegationSignerMismatchError();
    }

    // 3. La policy firmada (en el typed-data) es la que gobierna (CD-3): debe
    //    coincidir con input.policy.
    if (!policiesEqual(input.policy, input.typed_data.message.policy)) {
      throw new DelegationSignerMismatchError();
    }

    // 4. expires_at futuro (epoch seconds → ISO).
    const policy = input.typed_data.message.policy;
    const expiresAtMs = policy.expires_at * 1000;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new DelegationSignerMismatchError();
    }
    const expiresAtIso = new Date(expiresAtMs).toISOString();

    // 5. Token opaco + hash (DT-5). Solo el hash se persiste.
    const token = `${SESSION_TOKEN_PREFIX}${crypto.randomBytes(48).toString('hex')}`;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // 6. INSERT. owner_ref/key_id desde parentKey (NUNCA del request).
    const row: Record<string, unknown> = {
      key_id: parentKey.id,
      owner_ref: parentKey.owner_ref,
      session_key_address: input.session_key_address.toLowerCase(),
      session_token_hash: tokenHash,
      policy,
      expires_at: expiresAtIso,
      typed_data_raw: input.typed_data,
      nonce: input.typed_data.message.nonce,
    };

    const { data, error } = await supabase
      .from('a2a_delegations')
      .insert(row)
      .select('id')
      .single();

    if (error) {
      // UNIQUE(key_id, nonce) → anti-replay (AC-4/CD-4).
      if (error.code === '23505') {
        throw new DelegationNonceReplayError();
      }
      throw new Error(`Failed to create delegation: ${error.message}`);
    }

    return {
      delegation_id: (data as { id: string }).id,
      session_token: token, // plano, SOLO acá (nunca se vuelve a exponer)
      expires_at: expiresAtIso,
      policy,
    };
  },

  /**
   * Lookup del hot path por hash del token (AC-5).
   * NOTA PARA AR-CR: NO lleva .eq('owner_ref', ...) a propósito (DT-6) — el caller
   * se autentica CON el token; el owner se deriva del row. Igual que
   * identityService.lookupByHash (identity.ts:89-103). NO es IDOR.
   * PGRST116 → null.
   */
  async lookupByTokenHash(hash: string): Promise<DelegationRow | null> {
    const { data, error } = await supabase
      .from('a2a_delegations')
      .select('*')
      .eq('session_token_hash', hash)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new Error(`Failed to lookup delegation: ${error.message}`);
    }

    return data as DelegationRow;
  },

  /**
   * Carga la parent key del branch de delegación (DT-9). Lectura interna
   * server-side, sin owner gate (el caller no eligió el key_id — sale del row de
   * la delegación que autenticó con su token).
   * NOTA PARA AR-CR: no es IDOR (key_id proviene del row de la delegación).
   * PGRST116 → null.
   */
  async getParentKey(keyId: string): Promise<A2AAgentKeyRow | null> {
    const { data, error } = await supabase
      .from('a2a_agent_keys')
      .select('*')
      .eq('id', keyId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw new Error(`Failed to load parent key: ${error.message}`);
    }

    return data as A2AAgentKeyRow;
  },

  /** Listado del owner con status derivado (AC-11). Ownership Guard: .eq('owner_ref', ownerRef). */
  async list(ownerRef: string): Promise<DelegationListItem[]> {
    const { data, error } = await supabase
      .from('a2a_delegations')
      .select(
        'id, session_key_address, policy, expires_at, total_spent, revoked_at',
      )
      .eq('owner_ref', ownerRef)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to list delegations: ${error.message}`);
    }

    const rows = (data ?? []) as Array<
      Pick<
        DelegationRow,
        | 'session_key_address'
        | 'policy'
        | 'expires_at'
        | 'total_spent'
        | 'revoked_at'
      > & { id: string }
    >;

    const now = Date.now();
    return rows.map((r) => {
      let status: DelegationStatus = 'active';
      if (r.revoked_at !== null) {
        status = 'revoked';
      } else if (now >= new Date(r.expires_at).getTime()) {
        status = 'expired';
      }
      return {
        delegation_id: r.id,
        session_key_address: r.session_key_address,
        policy: r.policy,
        expires_at: r.expires_at,
        total_spent: r.total_spent,
        revoked_at: r.revoked_at,
        status,
      };
    });
  },

  /**
   * Revoca (AC-10/AC-12). Ownership Guard: UPDATE revoked_at=now()
   * .eq('id', delegationId).eq('owner_ref', ownerRef).select('id').
   * 0 rows → logOwnershipMismatch + OwnershipMismatchError.
   * Idempotente: si ya estaba revocada, devolver OK (no error) — el UPDATE matchea
   * igual el row del owner y refresca revoked_at; el row sigue siendo del owner.
   */
  async revoke(delegationId: string, ownerRef: string): Promise<void> {
    const { data, error } = await supabase
      .from('a2a_delegations')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', delegationId)
      .eq('owner_ref', ownerRef)
      .select('id');

    if (error) {
      throw new Error(`Failed to revoke delegation: ${error.message}`);
    }

    if (!data || data.length === 0) {
      logOwnershipMismatch({
        op: 'delegationRevoke',
        resourceId: delegationId,
        callerOwnerRef: ownerRef,
      });
      throw new OwnershipMismatchError();
    }
  },

  /**
   * Débito atómico doble (AC-8/AC-9/CD-12). SOLO invoca el RPC; mapea errores
   * por prefijo de mensaje (patrón budget.ts:91-101). Devuelve el nuevo total_spent.
   */
  async debitDelegationAndParent(
    delegationId: string,
    ownerRef: string,
    keyId: string,
    chainId: number,
    amountUsd: number,
  ): Promise<string> {
    const { data, error } = await supabase.rpc('debit_delegation_and_parent', {
      p_delegation_id: delegationId,
      p_owner_ref: ownerRef,
      p_key_id: keyId,
      p_chain_id: chainId,
      p_amount_usd: amountUsd,
    });

    if (error) {
      const msg = error.message;
      if (msg.includes('DELEGATION_TOTAL_LIMIT_EXCEEDED')) {
        throw new DelegationTotalLimitExceededError();
      }
      if (msg.includes('INSUFFICIENT_BUDGET')) {
        throw new AgentKeyBudgetExhaustedError();
      }
      if (msg.includes('DELEGATION_REVOKED')) {
        throw new DelegationRevokedError();
      }
      if (msg.includes('DELEGATION_EXPIRED')) {
        throw new DelegationExpiredError();
      }
      if (msg.includes('OWNERSHIP_MISMATCH')) {
        logOwnershipMismatch({
          op: 'delegationRevoke',
          resourceId: delegationId,
          callerOwnerRef: ownerRef,
        });
        throw new OwnershipMismatchError();
      }
      throw new Error(`Failed to debit delegation: ${msg}`);
    }

    return String(data);
  },
};

/**
 * Igualdad estructural de dos policies (CD-3). Compara escalares y arrays (orden
 * sensible — el array firmado debe coincidir exactamente con el del request).
 */
function policiesEqual(
  a: CreateDelegationInput['policy'],
  b: CreateDelegationInput['policy'],
): boolean {
  if (
    a.max_amount_per_tx !== b.max_amount_per_tx ||
    a.max_total_amount !== b.max_total_amount ||
    a.expires_at !== b.expires_at
  ) {
    return false;
  }
  return (
    arraysEqual(a.allowed_chains, b.allowed_chains) &&
    arraysEqual(a.allowed_agent_slugs, b.allowed_agent_slugs) &&
    arraysEqual(a.allowed_registries, b.allowed_registries)
  );
}

function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
