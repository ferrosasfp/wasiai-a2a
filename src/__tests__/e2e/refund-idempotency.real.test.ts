/**
 * HU-194: idempotencia REAL de `refund_a2a_key_spend` contra Postgres.
 *
 * Los tests unitarios (`money-path.concurrency.test.ts` R6) MODELAN la semántica
 * del claim; este archivo la ejercita de verdad: `a2a_refund_applications`,
 * `refund_idem_claim` y el `p_idem_key` de las RPC, tal como quedaron en la
 * migración `20260727000000_hu194_refund_idempotency`.
 *
 * COBERTURA: R1..R6 → `refund_a2a_key_spend` (camino master). R7 →
 * `refund_with_dest_policy` (que además de acreditar inserta la fila
 * compensatoria del dest-cap: un reintento no debe revertir el cap dos veces).
 * R8 → `refund_delegation_and_parent` (dual-ledger: el claim vive en la función
 * más externa y convive con el `PERFORM … FOR UPDATE` que normaliza el orden de
 * locks; un reintento no debe decrementar `total_spent` dos veces).
 * `refund_session_and_parent` es el gemelo estructural de R8 (mismo bloque, otra
 * tabla) y queda cubierto por analogía, no por ejecución.
 *
 * Los fixtures que hacen falta los crea el `beforeAll`: una política de gasto para
 * el destino (sin política `refund_with_dest_policy` NO inserta la compensatoria y
 * R7 sería vacuo) y una delegación con `total_spent > 0`. Todo cuelga de la key de
 * test y se borra por CASCADE.
 *
 * CÓMO CORRERLO (manual / CI-integración) — REQUIERE la migración aplicada:
 *   INTEGRATION_TEST_DB_URL=<supabase-url> \
 *   INTEGRATION_TEST_SERVICE_KEY=<service_role_key> \
 *   npx vitest run src/__tests__/e2e/refund-idempotency.real.test.ts
 *
 * El RPC tiene REVOKE EXECUTE FROM anon/authenticated → REQUIERE service_role.
 * Sin INTEGRATION_TEST_DB_URL → todo el describe se skippea con warn.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_URL = process.env.INTEGRATION_TEST_DB_URL;
const SERVICE_KEY = process.env.INTEGRATION_TEST_SERVICE_KEY;
const ENABLED = !!DB_URL && !!SERVICE_KEY;

if (!ENABLED) {
  console.warn(
    '[refund-idempotency.real] SKIP — requiere Postgres real con la migración ' +
      'HU-194 aplicada. Setear INTEGRATION_TEST_DB_URL + ' +
      'INTEGRATION_TEST_SERVICE_KEY para ejecutarlo.',
  );
}

describe.skipIf(!ENABLED)('HU-194 — refund idempotente (Postgres real)', () => {
  let supabase: SupabaseClient;

  const TEST_PREFIX = `hu194-idem-${Date.now()}`;
  const ownerRef = `${TEST_PREFIX}-owner`;
  const chainId = 84532;
  const idemKeys: string[] = [];
  // AR MNR-3: destino con política, para que `refund_with_dest_policy` inserte la
  // fila compensatoria del dest-cap (sin política el INSERT no ocurre y el test
  // sería vacuo justo en la parte que importa).
  const destination = `${TEST_PREFIX}-reg/agent`;

  let keyId: string;
  let delegationId: string;

  async function balance(): Promise<number> {
    const { data } = await supabase
      .from('a2a_agent_keys')
      .select('budget')
      .eq('id', keyId)
      .single();
    const budget = (data?.budget ?? {}) as Record<string, string>;
    return Number.parseFloat(budget[String(chainId)] ?? '0');
  }

  function refund(
    amount: number,
    idemKey: string | null,
  ): PromiseLike<{ data: number | null; error: { message: string } | null }> {
    if (idemKey) idemKeys.push(idemKey);
    return supabase.rpc('refund_a2a_key_spend', {
      p_key_id: keyId,
      p_chain_id: chainId,
      p_amount_usd: amount,
      p_owner_ref: ownerRef,
      p_idem_key: idemKey,
    }) as unknown as PromiseLike<{
      data: number | null;
      error: { message: string } | null;
    }>;
  }

  /** Suma del ledger del dest-cap para este (key, destination). */
  async function destLedgerSum(): Promise<number> {
    const { data } = await supabase
      .from('a2a_key_dest_spend_ledger')
      .select('amount_usd')
      .eq('key_id', keyId)
      .eq('destination', destination);
    return (data ?? []).reduce(
      (acc: number, row: { amount_usd: number | string }) =>
        acc + Number(row.amount_usd),
      0,
    );
  }

  /** `total_spent` de la delegación (el 2º ledger del refund dual-ledger). */
  async function delegationTotalSpent(): Promise<number> {
    const { data } = await supabase
      .from('a2a_delegations')
      .select('total_spent')
      .eq('id', delegationId)
      .single();
    return Number(data?.total_spent ?? 0);
  }

  type RpcResult = PromiseLike<{
    data: number | null;
    error: { message: string } | null;
  }>;

  function refundWithDest(amount: number, idemKey: string | null): RpcResult {
    if (idemKey) idemKeys.push(idemKey);
    return supabase.rpc('refund_with_dest_policy', {
      p_key_id: keyId,
      p_chain_id: chainId,
      p_amount_usd: amount,
      p_owner_ref: ownerRef,
      p_destination: destination,
      p_idem_key: idemKey,
    }) as unknown as RpcResult;
  }

  function refundDelegation(amount: number, idemKey: string | null): RpcResult {
    if (idemKey) idemKeys.push(idemKey);
    return supabase.rpc('refund_delegation_and_parent', {
      p_delegation_id: delegationId,
      p_owner_ref: ownerRef,
      p_key_id: keyId,
      p_chain_id: chainId,
      p_amount_usd: amount,
      p_destination: null,
      p_idem_key: idemKey,
    }) as unknown as RpcResult;
  }

  beforeAll(async () => {
    supabase = createClient(DB_URL as string, SERVICE_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: keyRow, error: keyErr } = await supabase
      .from('a2a_agent_keys')
      .insert({
        owner_ref: ownerRef,
        key_hash: `${TEST_PREFIX}-keyhash`,
        budget: { [String(chainId)]: '0' },
        daily_spent_usd: 10,
        is_active: true,
      })
      .select('id')
      .single();
    if (keyErr) throw keyErr;
    keyId = keyRow?.id as string;

    // AR MNR-3 (a): política para el destino → `refund_with_dest_policy` SÍ
    // inserta la fila compensatoria negativa del dest-cap (si no hay política, el
    // INSERT no ocurre por simetría con el débito).
    const { error: polErr } = await supabase
      .from('a2a_key_spend_policies')
      .insert({
        key_id: keyId,
        owner_ref: ownerRef,
        destination,
        max_usd: 100,
        window_type: 'total',
      });
    if (polErr) throw polErr;

    // AR MNR-3 (b): delegación con `total_spent` > 0, para poder observar que el
    // 2º ledger se decrementa UNA sola vez.
    const { data: delRow, error: delErr } = await supabase
      .from('a2a_delegations')
      .insert({
        key_id: keyId,
        owner_ref: ownerRef,
        session_key_address: `0x${'1'.repeat(40)}`,
        session_token_hash: `${TEST_PREFIX}-deltoken`,
        policy: { max_total_amount: '100' },
        total_spent: 5,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        typed_data_raw: {},
        nonce: `0x${'00'.repeat(32)}`,
      })
      .select('id')
      .single();
    if (delErr) throw delErr;
    delegationId = delRow?.id as string;
  });

  afterAll(async () => {
    if (idemKeys.length > 0) {
      await supabase
        .from('a2a_refund_applications')
        .delete()
        .in('idem_key', idemKeys);
    }
    if (keyId) {
      await supabase.from('a2a_agent_keys').delete().eq('id', keyId);
    }
  });

  it('T-194-R1: la MISMA clave dos veces acredita UNA sola vez (y devuelve 1 en ambas)', async () => {
    const before = await balance();
    const key = `${TEST_PREFIX}:r1`;

    const first = await refund(1, key);
    expect(first.error).toBeNull();
    expect(first.data).toBe(1);
    expect(await balance()).toBeCloseTo(before + 1, 6);

    // Segundo intento (lo que hace el sweep tras una respuesta perdida).
    const second = await refund(1, key);
    expect(second.error).toBeNull();
    // "Ya aplicada" también reporta >=1: la plata SÍ está de vuelta, que es lo
    // que el contrato `reverted` significa para el sweep y para el retry de
    // /compose.
    expect(second.data).toBe(1);
    expect(await balance()).toBeCloseTo(before + 1, 6);
  });

  it('T-194-R2: deja el marcador en a2a_refund_applications', async () => {
    const key = `${TEST_PREFIX}:r2`;
    await refund(0.25, key);

    const { data } = await supabase
      .from('a2a_refund_applications')
      .select('key_id, chain_id, amount_usd, owner_ref')
      .eq('idem_key', key)
      .single();

    expect(data?.key_id).toBe(keyId);
    expect(data?.chain_id).toBe(chainId);
    expect(Number(data?.amount_usd)).toBeCloseTo(0.25, 6);
    expect(data?.owner_ref).toBe(ownerRef);
  });

  it('T-194-R3: claves DISTINTAS acreditan las DOS veces (no colapsa refunds legítimos)', async () => {
    const before = await balance();
    await refund(1, `${TEST_PREFIX}:r3:d1`);
    await refund(1, `${TEST_PREFIX}:r3:d2`);
    expect(await balance()).toBeCloseTo(before + 2, 6);
  });

  it('T-194-R4: misma clave con OTRO monto → REFUND_IDEM_AMOUNT_MISMATCH, sin acreditar', async () => {
    const key = `${TEST_PREFIX}:r4`;
    await refund(1, key);
    const before = await balance();

    const res = await refund(2, key);

    expect(res.error?.message).toContain('REFUND_IDEM_AMOUNT_MISMATCH');
    expect(await balance()).toBeCloseTo(before, 6);
  });

  it('T-194-R5: sin clave (NULL) el comportamiento es el de antes — crédito ciego', async () => {
    // Back-compat de las filas del outbox encoladas antes de la migración y de
    // los callers SQL de 4 args (arbiter).
    const before = await balance();
    await refund(1, null);
    await refund(1, null);
    expect(await balance()).toBeCloseTo(before + 2, 6);
  });

  it('T-194-R6: dos llamadas CONCURRENTES con la misma clave → un solo crédito', async () => {
    const before = await balance();
    const key = `${TEST_PREFIX}:r6`;

    const [a, b] = await Promise.all([refund(1, key), refund(1, key)]);

    // La serialización la da el PRIMARY KEY de a2a_refund_applications, no la app.
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect(await balance()).toBeCloseTo(before + 1, 6);
  });

  // ══════════════════════════════════════════════════════════════
  // AR MNR-3 — las funciones de MAYOR riesgo del fix, que R1..R6 no tocaban:
  // `refund_with_dest_policy` (fila compensatoria del dest-cap) y los wrappers
  // dual-ledger (donde hubo que normalizar el orden de locks y donde el claim
  // convive con el `PERFORM … FOR UPDATE` nuevo). Un reintento que revirtiera el
  // dest-cap o el `total_spent` DOS veces regala headroom, aunque el budget no se
  // duplique: es dinero igual.
  // ══════════════════════════════════════════════════════════════

  it('T-194-R7: refund_with_dest_policy — misma clave 2 veces: un crédito Y el dest-cap revertido UNA vez', async () => {
    const before = await balance();
    const ledgerBefore = await destLedgerSum();
    const key = `${TEST_PREFIX}:r7`;

    const first = await refundWithDest(1, key);
    expect(first.error).toBeNull();
    // ROW_COUNT del INSERT compensatorio (contrato A2: el dest-cap se revirtió).
    expect(first.data).toBe(1);
    expect(await balance()).toBeCloseTo(before + 1, 6);
    expect(await destLedgerSum()).toBeCloseTo(ledgerBefore - 1, 6);

    const second = await refundWithDest(1, key);
    expect(second.error).toBeNull();
    // "Ya aplicada" ⟹ RETURN 1 sin re-acreditar NI re-insertar la compensatoria.
    expect(second.data).toBe(1);
    expect(await balance()).toBeCloseTo(before + 1, 6);
    // LA ASERCIÓN QUE IMPORTA: -1, no -2. Un segundo INSERT liberaría headroom del
    // cap por destino que nunca se gastó.
    expect(await destLedgerSum()).toBeCloseTo(ledgerBefore - 1, 6);
  });

  it('T-194-R8: refund_delegation_and_parent — misma clave 2 veces: un crédito Y total_spent decrementado UNA vez', async () => {
    const before = await balance();
    const totalBefore = await delegationTotalSpent();
    const key = `${TEST_PREFIX}:r8`;

    const first = await refundDelegation(1, key);
    expect(first.error).toBeNull();
    expect(first.data).toBe(1);
    expect(await balance()).toBeCloseTo(before + 1, 6);
    expect(await delegationTotalSpent()).toBeCloseTo(totalBefore - 1, 6);

    const second = await refundDelegation(1, key);
    expect(second.error).toBeNull();
    expect(second.data).toBe(1);
    // Dual-ledger: NI el budget del parent NI el contador de la delegación se
    // mueven de nuevo. Si el claim viviera sólo en el parent, `total_spent` bajaría
    // a totalBefore - 2 (el skew M1 al revés) sin doble crédito visible.
    expect(await balance()).toBeCloseTo(before + 1, 6);
    expect(await delegationTotalSpent()).toBeCloseTo(totalBefore - 1, 6);
  });
});
