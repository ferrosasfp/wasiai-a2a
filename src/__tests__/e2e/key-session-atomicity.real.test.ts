/**
 * Atomicidad real de debit_session_and_parent (WKH-121 AC-8).
 *
 * Ejercita Postgres REAL — NO mocks. Verifica que dos débitos concurrentes
 * contra la misma session key, individualmente válidos pero juntos excediendo
 * max_budget_usd, resulten en EXACTAMENTE uno OK y uno rechazado con
 * SESSION_BUDGET_EXHAUSTED, y que spent_usd quede en M (no 2M). Esto prueba el
 * FOR UPDATE (no-double-spend) que un mock jamás verifica.
 *
 * CÓMO CORRERLO (manual / CI-integración):
 *   INTEGRATION_TEST_DB_URL=<supabase-url> \
 *   INTEGRATION_TEST_SERVICE_KEY=<service_role_key> \
 *   npx vitest run src/__tests__/e2e/key-session-atomicity.real.test.ts
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
    '[key-session-atomicity.real] SKIP — requiere Postgres real. Setear ' +
      'INTEGRATION_TEST_DB_URL + INTEGRATION_TEST_SERVICE_KEY para ejecutarlo.',
  );
}

describe.skipIf(!ENABLED)('debit_session_and_parent — atomicidad real', () => {
  // Cliente real creado en beforeAll (NO en el cuerpo del describe: con
  // describe.skipIf el cuerpo igual se evalúa, y createClient('') lanzaría).
  let supabase: SupabaseClient;

  // Prefijo de test para cleanup seguro (patrón owner_ref-prefix WKH-35).
  const TEST_PREFIX = `wkh121-race-${Date.now()}`;
  const ownerRef = `${TEST_PREFIX}-owner`;
  const chainId = 84532; // chainId de prueba (no limitante)
  const M = 1.0; // monto de cada débito
  const MAX_BUDGET = 1.5; // 1.0 pasa; 1.0 + 1.0 = 2.0 > 1.5 → el 2º viola

  let keyId: string;
  let sessionId: string;

  beforeAll(async () => {
    supabase = createClient(DB_URL as string, SERVICE_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: keyRow, error: keyErr } = await supabase
      .from('a2a_agent_keys')
      .insert({
        owner_ref: ownerRef,
        key_hash: `${TEST_PREFIX}-keyhash`,
        budget: { [String(chainId)]: '100.0' }, // budget holgado, no limita
        is_active: true,
      })
      .select('id')
      .single();
    if (keyErr) throw keyErr;
    keyId = keyRow?.id as string;

    const { data: sessRow, error: sessErr } = await supabase
      .from('a2a_key_sessions')
      .insert({
        key_id: keyId,
        owner_ref: ownerRef,
        session_token_hash: `${TEST_PREFIX}-tokenhash`,
        ttl_seconds: 3600,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        max_budget_usd: MAX_BUDGET,
        spent_usd: 0,
      })
      .select('id')
      .single();
    if (sessErr) throw sessErr;
    sessionId = sessRow?.id as string;
  });

  afterAll(async () => {
    // Cleanup por IDs prefijados. NO dejar basura en la DB compartida.
    if (sessionId) {
      await supabase.from('a2a_key_sessions').delete().eq('id', sessionId);
    }
    if (keyId) {
      await supabase.from('a2a_agent_keys').delete().eq('id', keyId);
    }
  });

  it('two concurrent debits → exactly 1 OK + 1 BUDGET_EXHAUSTED, spent_usd = M (no-double-spend, AC-8)', async () => {
    const debit = () =>
      supabase.rpc('debit_session_and_parent', {
        p_session_id: sessionId,
        p_owner_ref: ownerRef,
        p_key_id: keyId,
        p_chain_id: chainId,
        p_amount_usd: M,
      });

    // Concurrencia real contra el lock FOR UPDATE — NO await secuencial.
    const [r1, r2] = await Promise.allSettled([debit(), debit()]);

    const outcomes = [r1, r2].map((r) =>
      r.status === 'fulfilled' && r.value.error == null
        ? { ok: true, total: r.value.data }
        : {
            ok: false,
            msg:
              r.status === 'fulfilled'
                ? String(r.value.error?.message ?? '')
                : String((r.reason as Error)?.message ?? ''),
          },
    );
    const okCount = outcomes.filter((o) => o.ok).length;
    const failOutcome = outcomes.find((o) => !o.ok);

    expect(okCount).toBe(1); // exactamente uno gana
    expect(failOutcome).toBeDefined();
    expect(failOutcome?.msg).toContain('SESSION_BUDGET_EXHAUSTED');

    // no-double-spend: re-leer spent_usd bajo la realidad post-tx.
    const { data: after } = await supabase
      .from('a2a_key_sessions')
      .select('spent_usd')
      .eq('id', sessionId)
      .single();
    expect(Number(after?.spent_usd)).toBe(M); // M, NO 2M (el 2º ROLLBACK)
  });
});
