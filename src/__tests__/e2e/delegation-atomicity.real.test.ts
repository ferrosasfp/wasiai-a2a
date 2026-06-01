/**
 * Atomicidad real de debit_delegation_and_parent (WKH-104 TD-RACE-TEST).
 *
 * Ejercita Postgres REAL — NO mocks (CD-3/CD-4). Verifica que dos débitos
 * concurrentes contra la misma delegación, individualmente válidos pero juntos
 * excediendo max_total_amount, resulten en EXACTAMENTE uno OK y uno rechazado
 * con DELEGATION_TOTAL_LIMIT_EXCEEDED, y que total_spent quede en M (no 2M).
 * Esto prueba el FOR UPDATE (no-double-spend) que un mock jamás verifica.
 *
 * CÓMO CORRERLO (manual / CI-integración) — CD-14:
 *   INTEGRATION_TEST_DB_URL=<supabase-url> \
 *   INTEGRATION_TEST_SERVICE_KEY=<service_role_key> \
 *   npx vitest run src/__tests__/e2e/delegation-atomicity.real.test.ts
 *
 * El RPC tiene REVOKE EXECUTE FROM anon/authenticated → REQUIERE service_role.
 * Sin INTEGRATION_TEST_DB_URL → todo el describe se skippea con warn (AC-8).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DB_URL = process.env.INTEGRATION_TEST_DB_URL;
const SERVICE_KEY = process.env.INTEGRATION_TEST_SERVICE_KEY;
const ENABLED = !!DB_URL && !!SERVICE_KEY;

if (!ENABLED) {
  console.warn(
    '[delegation-atomicity.real] SKIP — requiere Postgres real. Setear ' +
      'INTEGRATION_TEST_DB_URL + INTEGRATION_TEST_SERVICE_KEY para ejecutarlo.',
  );
}

describe.skipIf(!ENABLED)(
  'debit_delegation_and_parent — atomicidad real',
  () => {
    // Cliente real creado en beforeAll (NO en el cuerpo del describe: con
    // describe.skipIf el cuerpo igual se evalúa, y createClient('') lanzaría).
    let supabase: SupabaseClient;

    // Prefijo de test para cleanup seguro (patrón owner_ref-prefix WKH-35).
    const TEST_PREFIX = `wkh104-race-${Date.now()}`;
    const ownerRef = `${TEST_PREFIX}-owner`;
    const chainId = 84532; // chainId de prueba (no limitante)
    const M = 1.0; // monto de cada débito
    const MAX_TOTAL = 1.5; // 1.0 pasa; 1.0 + 1.0 = 2.0 > 1.5 → el 2º viola

    let keyId: string;
    let delegationId: string;

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

      const hex40 = `0x${TEST_PREFIX.replace(/[^0-9a-f]/gi, '0')
        .slice(0, 40)
        .padEnd(40, '0')}`;
      const hex64 = `0x${TEST_PREFIX.replace(/[^0-9a-f]/gi, '0')
        .slice(0, 64)
        .padEnd(64, '0')}`;

      const { data: delRow, error: delErr } = await supabase
        .from('a2a_delegations')
        .insert({
          key_id: keyId,
          owner_ref: ownerRef,
          session_key_address: hex40,
          session_token_hash: `${TEST_PREFIX}-tokenhash`,
          policy: {
            max_total_amount: MAX_TOTAL,
            allowed_chains: [],
            max_amount_per_tx: M,
            max_calls: null,
          },
          total_spent: 0,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          typed_data_raw: { test: true },
          nonce: hex64,
        })
        .select('id')
        .single();
      if (delErr) throw delErr;
      delegationId = delRow?.id as string;
    });

    afterAll(async () => {
      // CD-13: cleanup por IDs prefijados. NO dejar basura en la DB compartida.
      if (delegationId) {
        await supabase.from('a2a_delegations').delete().eq('id', delegationId);
      }
      if (keyId) {
        await supabase.from('a2a_agent_keys').delete().eq('id', keyId);
      }
    });

    it('two concurrent debits → exactly 1 OK + 1 LIMIT_EXCEEDED, total_spent = M (no-double-spend, AC-6/AC-7)', async () => {
      const debit = () =>
        supabase.rpc('debit_delegation_and_parent', {
          p_delegation_id: delegationId,
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
      expect(failOutcome?.msg).toContain('DELEGATION_TOTAL_LIMIT_EXCEEDED');

      // no-double-spend: re-leer total_spent bajo la realidad post-tx.
      const { data: after } = await supabase
        .from('a2a_delegations')
        .select('total_spent')
        .eq('id', delegationId)
        .single();
      expect(Number(after?.total_spent)).toBe(M); // M, NO 2M (el 2º ROLLBACK)
    });
  },
);
