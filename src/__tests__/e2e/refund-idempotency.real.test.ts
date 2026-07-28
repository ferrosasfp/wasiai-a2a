/**
 * HU-194: idempotencia REAL de `refund_a2a_key_spend` contra Postgres.
 *
 * Los tests unitarios (`money-path.concurrency.test.ts` R6) MODELAN la semántica
 * del claim; este archivo la ejercita de verdad: `a2a_refund_applications`,
 * `refund_idem_claim` y el `p_idem_key` de la RPC, tal como quedaron en la
 * migración `20260727000000_hu194_refund_idempotency`.
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

  let keyId: string;

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
});
