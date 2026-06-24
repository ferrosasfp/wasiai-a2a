/**
 * Reversión real del dest-cap por refund_with_dest_policy (WKH-129 AC-1/AC-3/AC-4/AC-5,
 * CD-1/CD-2/CD-4/CD-5/CD-10/CD-13).
 *
 * Ejercita Postgres REAL — NO mocks. Espeja refund-atomicity.real.test.ts. Verifica:
 *   - tras debit_with_dest_policy el SUM del cap por (key,dest) = X;
 *   - tras refund_with_dest_policy con el mismo (key,chain,amount,owner,dest) el SUM
 *     vuelve a 0 (la fila compensatoria -X lo descuenta — CD-10), budget acreditado
 *     de vuelta y daily_spent revertido con clamp 0;
 *   - p_owner_ref ajeno → OWNERSHIP_MISMATCH y ROLLBACK total (ledger/key intactos);
 *   - p_amount_usd <= 0 / NULL → no-op: NO inserta fila en el ledger, NO toca budget/daily.
 *
 * CÓMO CORRERLO (manual / CI-integración):
 *   INTEGRATION_TEST_DB_URL=<supabase-url> \
 *   INTEGRATION_TEST_SERVICE_KEY=<service_role_key> \
 *   npx vitest run src/__tests__/e2e/refund-with-dest-cap.real.test.ts
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
    '[refund-with-dest-cap.real] SKIP — requiere Postgres real. Setear ' +
      'INTEGRATION_TEST_DB_URL + INTEGRATION_TEST_SERVICE_KEY para ejecutarlo.',
  );
}

describe.skipIf(!ENABLED)(
  'refund_with_dest_policy — reversión real del dest-cap',
  () => {
    let supabase: SupabaseClient;

    const TEST_PREFIX = `wkh129-refund-dest-${Date.now()}`;
    const ownerRef = `${TEST_PREFIX}-owner`;
    const destination = `${TEST_PREFIX}/corridor`;
    const chainId = 84532;

    let keyId: string;

    // Suma del cap por (key, destination): el mismo COALESCE(SUM(amount_usd),0) que usa
    // debit_with_dest_policy (sin filtro de signo → una fila negativa lo descuenta).
    async function capSum(): Promise<number> {
      const { data, error } = await supabase
        .from('a2a_key_dest_spend_ledger')
        .select('amount_usd')
        .eq('key_id', keyId)
        .eq('destination', destination);
      if (error) throw error;
      return (data ?? []).reduce(
        (acc: number, row: { amount_usd: string | number }) =>
          acc + Number(row.amount_usd),
        0,
      );
    }

    async function ledgerRowCount(): Promise<number> {
      const { count, error } = await supabase
        .from('a2a_key_dest_spend_ledger')
        .select('id', { count: 'exact', head: true })
        .eq('key_id', keyId)
        .eq('destination', destination);
      if (error) throw error;
      return count ?? 0;
    }

    beforeAll(async () => {
      supabase = createClient(DB_URL as string, SERVICE_KEY as string, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      // Estado inicial: budget 5.0 en la chain, daily_spent 0.0.
      const { data: keyRow, error: keyErr } = await supabase
        .from('a2a_agent_keys')
        .insert({
          owner_ref: ownerRef,
          key_hash: `${TEST_PREFIX}-keyhash`,
          budget: { [String(chainId)]: '5.0' },
          daily_spent_usd: 0.0,
          is_active: true,
        })
        .select('id')
        .single();
      if (keyErr) throw keyErr;
      keyId = keyRow?.id as string;

      // Política de destino activa (rolling, ventana amplia → débito + reversa caen en la
      // misma ventana, DT-3 / AC-4).
      const { error: polErr } = await supabase
        .from('a2a_key_spend_policies')
        .insert({
          key_id: keyId,
          owner_ref: ownerRef,
          destination,
          max_usd: 1.0,
          window_type: 'rolling',
          window_secs: 3600,
        });
      if (polErr) throw polErr;
    });

    afterAll(async () => {
      if (keyId) {
        // ON DELETE CASCADE limpia policies + ledger.
        await supabase.from('a2a_agent_keys').delete().eq('id', keyId);
      }
    });

    // T-RWD-REAL-1 (AC-1/AC-4): debit → SUM=X; refund mismo (key,chain,amount,owner,dest)
    // → SUM vuelve a 0; budget acreditado de vuelta; daily revertido (clamp 0).
    it('T-RWD-REAL-1 refund reverts cap SUM to 0 and credits budget/daily', async () => {
      // 1. Débito de 0.30 vía debit_with_dest_policy → fila +0.30 en el ledger.
      const { error: debitErr } = await supabase.rpc('debit_with_dest_policy', {
        p_key_id: keyId,
        p_chain_id: chainId,
        p_amount_usd: 0.3,
        p_owner_ref: ownerRef,
        p_destination: destination,
      });
      expect(debitErr).toBeNull();
      expect(await capSum()).toBeCloseTo(0.3, 6);

      // Estado post-débito: budget 5.0 → 4.7; daily_spent 0.0 → 0.30.
      const { data: mid } = await supabase
        .from('a2a_agent_keys')
        .select('budget, daily_spent_usd')
        .eq('id', keyId)
        .single();
      const midBudget = (mid?.budget ?? {}) as Record<string, string>;
      expect(Number(midBudget[String(chainId)])).toBeCloseTo(4.7, 6);
      expect(Number(mid?.daily_spent_usd)).toBeCloseTo(0.3, 6);

      // 2. Refund con el MISMO (key,chain,amount,owner,dest) → fila -0.30 → SUM = 0.
      const { error: refundErr } = await supabase.rpc(
        'refund_with_dest_policy',
        {
          p_key_id: keyId,
          p_chain_id: chainId,
          p_amount_usd: 0.3,
          p_owner_ref: ownerRef,
          p_destination: destination,
        },
      );
      expect(refundErr).toBeNull();
      expect(await capSum()).toBeCloseTo(0, 6); // CD-10: headroom restaurado

      // 3. budget acreditado de vuelta (4.7 → 5.0); daily revertido (0.30 → 0.0).
      const { data: after } = await supabase
        .from('a2a_agent_keys')
        .select('budget, daily_spent_usd')
        .eq('id', keyId)
        .single();
      const budget = (after?.budget ?? {}) as Record<string, string>;
      expect(Number(budget[String(chainId)])).toBeCloseTo(5.0, 6);
      expect(Number(after?.daily_spent_usd)).toBe(0);
    });

    // T-RWD-REAL-2 (AC-3): p_owner_ref ajeno → OWNERSHIP_MISMATCH, ROLLBACK total
    // (no inserta fila, no toca la key).
    it('T-RWD-REAL-2 rejects OWNERSHIP_MISMATCH and rolls back', async () => {
      const beforeCount = await ledgerRowCount();
      const { data: before } = await supabase
        .from('a2a_agent_keys')
        .select('budget, daily_spent_usd')
        .eq('id', keyId)
        .single();

      const { error } = await supabase.rpc('refund_with_dest_policy', {
        p_key_id: keyId,
        p_chain_id: chainId,
        p_amount_usd: 0.3,
        p_owner_ref: 'not-the-owner',
        p_destination: destination,
      });
      expect(error).not.toBeNull();
      expect(String(error?.message)).toContain('OWNERSHIP_MISMATCH');

      // ROLLBACK total: ni fila nueva ni cambios en la key.
      expect(await ledgerRowCount()).toBe(beforeCount);
      const { data: after } = await supabase
        .from('a2a_agent_keys')
        .select('budget, daily_spent_usd')
        .eq('id', keyId)
        .single();
      expect(after?.budget).toEqual(before?.budget);
      expect(Number(after?.daily_spent_usd)).toBe(
        Number(before?.daily_spent_usd),
      );
    });

    // T-RWD-REAL-3 (AC-5): p_amount_usd <= 0 (y NULL) → no-op: sin INSERT en el ledger,
    // sin tocar budget/daily.
    it('T-RWD-REAL-3 no-ops for amount <= 0 and NULL (no insert, no key change)', async () => {
      const beforeCount = await ledgerRowCount();
      const { data: before } = await supabase
        .from('a2a_agent_keys')
        .select('budget, daily_spent_usd')
        .eq('id', keyId)
        .single();

      for (const amount of [0, -0.5, null]) {
        const { error } = await supabase.rpc('refund_with_dest_policy', {
          p_key_id: keyId,
          p_chain_id: chainId,
          p_amount_usd: amount,
          p_owner_ref: ownerRef,
          p_destination: destination,
        });
        expect(error).toBeNull(); // no-op limpio, sin excepción
      }

      expect(await ledgerRowCount()).toBe(beforeCount);
      const { data: after } = await supabase
        .from('a2a_agent_keys')
        .select('budget, daily_spent_usd')
        .eq('id', keyId)
        .single();
      expect(after?.budget).toEqual(before?.budget);
      expect(Number(after?.daily_spent_usd)).toBe(
        Number(before?.daily_spent_usd),
      );
    });

    // T-RWD-REAL-4 (fix-pack AR MNR-1): si NO hay política para el destino, el
    // refund reembolsa budget/daily PERO NO inserta fila en el ledger (simetría
    // con debit_with_dest_policy, que solo inserta IF v_has_policy). Evita filas
    // -X huérfanas que debilitarían una política FUTURA sobre ese destino.
    it('T-RWD-REAL-4 does NOT insert a ledger row when no policy exists for the dest', async () => {
      const noPolicyDest = `${TEST_PREFIX}/no-policy-vendor`;
      const rowsBefore = await supabase
        .from('a2a_key_dest_spend_ledger')
        .select('id', { count: 'exact', head: true })
        .eq('key_id', keyId)
        .eq('destination', noPolicyDest);
      const { data: before } = await supabase
        .from('a2a_agent_keys')
        .select('budget')
        .eq('id', keyId)
        .single();
      const balBefore = Number(
        (before?.budget as Record<string, string>)?.[String(chainId)] ?? 0,
      );

      const { error } = await supabase.rpc('refund_with_dest_policy', {
        p_key_id: keyId,
        p_chain_id: chainId,
        p_amount_usd: 0.02,
        p_owner_ref: ownerRef,
        p_destination: noPolicyDest,
      });
      expect(error).toBeNull();

      // Sin política → NINGUNA fila en el ledger para ese destino.
      const rowsAfter = await supabase
        .from('a2a_key_dest_spend_ledger')
        .select('id', { count: 'exact', head: true })
        .eq('key_id', keyId)
        .eq('destination', noPolicyDest);
      expect(rowsAfter.count ?? 0).toBe(rowsBefore.count ?? 0);

      // Pero el budget SÍ se acredita (el dinero siempre se reembolsa).
      const { data: after } = await supabase
        .from('a2a_agent_keys')
        .select('budget')
        .eq('id', keyId)
        .single();
      const balAfter = Number(
        (after?.budget as Record<string, string>)?.[String(chainId)] ?? 0,
      );
      expect(balAfter).toBeCloseTo(balBefore + 0.02, 6);
    });
  },
);
