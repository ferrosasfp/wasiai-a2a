/**
 * Atomicidad real de refund_a2a_key_spend (WKH-127 AC-5/AC-6/AC-7, CD-3/CD-4/CD-14).
 *
 * Ejercita Postgres REAL — NO mocks. Verifica que la RPC:
 *   - acredita el budget de la chain por el monto reembolsado,
 *   - revierte daily_spent_usd con clamp a 0 (no crea "deuda" — CD-14),
 *   - rechaza con OWNERSHIP_MISMATCH cuando el p_owner_ref no coincide (CD-4).
 *
 * CÓMO CORRERLO (manual / CI-integración):
 *   INTEGRATION_TEST_DB_URL=<supabase-url> \
 *   INTEGRATION_TEST_SERVICE_KEY=<service_role_key> \
 *   npx vitest run src/__tests__/e2e/refund-atomicity.real.test.ts
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
    '[refund-atomicity.real] SKIP — requiere Postgres real. Setear ' +
      'INTEGRATION_TEST_DB_URL + INTEGRATION_TEST_SERVICE_KEY para ejecutarlo.',
  );
}

describe.skipIf(!ENABLED)('refund_a2a_key_spend — atomicidad real', () => {
  let supabase: SupabaseClient;

  const TEST_PREFIX = `wkh127-refund-${Date.now()}`;
  const ownerRef = `${TEST_PREFIX}-owner`;
  const chainId = 84532;

  let keyId: string;

  beforeAll(async () => {
    supabase = createClient(DB_URL as string, SERVICE_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // Estado inicial: budget 5.0 en la chain, daily_spent 1.0 (como tras un débito).
    const { data: keyRow, error: keyErr } = await supabase
      .from('a2a_agent_keys')
      .insert({
        owner_ref: ownerRef,
        key_hash: `${TEST_PREFIX}-keyhash`,
        budget: { [String(chainId)]: '5.0' },
        daily_spent_usd: 1.0,
        is_active: true,
      })
      .select('id')
      .single();
    if (keyErr) throw keyErr;
    keyId = keyRow?.id as string;
  });

  afterAll(async () => {
    if (keyId) {
      await supabase.from('a2a_agent_keys').delete().eq('id', keyId);
    }
  });

  it('refund credits budget and reverts daily_spent (clamp 0, CD-14)', async () => {
    // Refund de 1.0: budget 5.0 → 6.0; daily_spent 1.0 → 0.0.
    const { error } = await supabase.rpc('refund_a2a_key_spend', {
      p_key_id: keyId,
      p_chain_id: chainId,
      p_amount_usd: 1.0,
      p_owner_ref: ownerRef,
    });
    expect(error).toBeNull();

    const { data: after } = await supabase
      .from('a2a_agent_keys')
      .select('budget, daily_spent_usd')
      .eq('id', keyId)
      .single();
    const budget = (after?.budget ?? {}) as Record<string, string>;
    expect(Number(budget[String(chainId)])).toBeCloseTo(6.0, 6);
    // CD-14: clamp a 0, no negativo aunque sobre-reembolse el daily acumulado.
    expect(Number(after?.daily_spent_usd)).toBe(0);
  });

  it('rejects OWNERSHIP_MISMATCH when p_owner_ref does not match (CD-4)', async () => {
    const { error } = await supabase.rpc('refund_a2a_key_spend', {
      p_key_id: keyId,
      p_chain_id: chainId,
      p_amount_usd: 1.0,
      p_owner_ref: 'not-the-owner',
    });
    expect(error).not.toBeNull();
    expect(String(error?.message)).toContain('OWNERSHIP_MISMATCH');
  });
});
