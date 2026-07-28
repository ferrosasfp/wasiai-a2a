/**
 * Reconciliation Service — money-path unit tests (WKH-191c, T-5..T-12).
 *
 * Cubre exactly-one-side (settle XOR refund), refund BUDGET-ONLY (NUNCA seam on-chain),
 * idempotencia (claim gana-uno), abort sobre incertidumbre, crash-recovery, flag-gate y
 * drift report-only. `reconciliationService` REAL; supabase + seam + reader on-chain +
 * verify + flag mockeados.
 *
 * NOTA anti-tautología (auto-blindaje 191b): T-8 documenta la exclusión mutua
 * `resolved_settled ⇐ resolving_settle` / `resolved_refunded ⇐ resolving_refund` como
 * INTEGRACIÓN SQL (gating por CHECK/status en el RPC `record_reconciliation_resolution`,
 * ver migración 20260713000002_wkh191c_reconciliation.sql). El test TS asserta la
 * INVARIANTE observable desde el service: nunca pide `resolved_settled` en el lado refund
 * ni `resolved_refunded` en el lado settle. NO usa `expect(true).toBe(true)`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));

vi.mock('../lib/supabase.js', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
}));

const mockIsEscrowSettleEnabled = vi.hoisted(() => vi.fn(() => true));
vi.mock('../adapters/escrow/debit-capture.js', () => ({
  isEscrowSettleEnabled: () => mockIsEscrowSettleEnabled(),
}));

const mockReverify = vi.hoisted(() => vi.fn());
const mockReadEscrowBalance = vi.hoisted(() => vi.fn());
vi.mock('../adapters/escrow/reconciler-onchain.js', () => ({
  reverifyDebitedByTxHash: (...a: unknown[]) => mockReverify(...a),
  readEscrowBalanceAtomic: (...a: unknown[]) => mockReadEscrowBalance(...a),
}));

const mockResolveEscrow = vi.hoisted(() =>
  vi.fn(() => '0x7777777777777777777777777777777777777777'),
);
vi.mock('../adapters/escrow-verifier.js', () => ({
  resolveEscrowContract: () => mockResolveEscrow(),
}));

vi.mock('../adapters/registry.js', () => ({
  getDefaultChainKey: () => 'base-sepolia',
  getAdaptersBundle: () => ({
    payment: { supportedTokens: [{ decimals: 6 }] },
  }),
}));

const mockVerifyDefaultChainSettle = vi.hoisted(() => vi.fn());
vi.mock('../adapters/settle-verifier.js', () => ({
  verifyDefaultChainSettle: (...a: unknown[]) =>
    mockVerifyDefaultChainSettle(...a),
}));

const mockSettleSeam = vi.hoisted(() => vi.fn());
vi.mock('./payment-intent.js', () => ({
  settlePaymentIntentOnChain: (...a: unknown[]) => mockSettleSeam(...a),
}));

import { supabase } from '../lib/supabase.js';
import { reconciliationService } from './reconciliation.js';

const mockRpc = vi.mocked(supabase.rpc);
const mockFrom = vi.mocked(supabase.from);

const INTENT_ID = 'intent-1';
const OWNER = 'tenant-A';
const KEY_ID = 'key-uuid-1';
const PAYTO = '0x2222222222222222222222222222222222222222';
const KEY_ID_HASH =
  '0xabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcab';
const HOP1_TX =
  '0xdeadbeef0000000000000000000000000000000000000000000000000000beef';
const CHAIN_ID = 84532;
const NONCE = '7';
const AMOUNT_ATOMIC = '2000000'; // 2.0 USDC @ 6 dec

// Firma valid en estado pending (fila del SELECT de resolveIntent, con embed intent).
function sigRow(overrides: Record<string, unknown> = {}) {
  return {
    intent_id: INTENT_ID,
    key_id: KEY_ID,
    debit_key_id_hash: KEY_ID_HASH,
    debit_nonce: NONCE,
    debit_amount_atomic: AMOUNT_ATOMIC,
    debit_hop1_tx_hash: HOP1_TX,
    // AR#2 BLQ-BAJO-2(a): el SELECT REAL de `resolveIntent` trae esta columna desde el
    // fix de BLQ-BAJO-1, y el doble no la exponía — así que ningún test podía ver el
    // guard que la mira. Default null (la mayoría de los casos no tienen hop 2 previo).
    debit_resolution_tx_hash: null,
    debit_settle_status: 'reconciliation_pending',
    owner_ref: OWNER,
    a2a_payment_intents: {
      pay_to: PAYTO,
      chain_id: CHAIN_ID,
      owner_ref: OWNER,
    },
    ...overrides,
  };
}

/**
 * Test-double chainable de supabase.from. `sigResult` alimenta las queries sobre
 * `a2a_payment_intent_debit_signatures`; `keyResult` sobre `a2a_agent_keys`. Soporta
 * `.select().eq().in().maybeSingle()` (resolveIntent/readBudget) y el thenable
 * (driftCheck sin maybeSingle).
 */
function wireFrom(opts: {
  sigResult?: { data: unknown; error: unknown };
  keyResult?: { data: unknown; error: unknown };
}) {
  const sigResult = opts.sigResult ?? { data: null, error: null };
  const keyResult = opts.keyResult ?? { data: null, error: null };
  // WKH-196: cols capturadas del .select() sobre la tabla de firmas (dentro del
  // closure — sin símbolo top-level nuevo consumido por la factory vi.mock, CD-8).
  let sigSelectCols: string | null = null;
  // HU-198: el doble de `.in()` IGNORABA sus argumentos, así que ningún test podía
  // ver por qué estados se filtra. Se capturan (col → valores) para poder afirmar la
  // lista real de estados contabilizados en el drift; un doble que descarta los
  // argumentos hace vacuo cualquier test sobre ellos.
  const sigInCalls: Array<{ col: string; values: readonly string[] }> = [];
  mockFrom.mockImplementation(((table: string) => {
    const result = table === 'a2a_agent_keys' ? keyResult : sigResult;
    const b: Record<string, unknown> = {
      select: (cols?: string) => {
        if (table === 'a2a_payment_intent_debit_signatures') {
          sigSelectCols = cols ?? null;
        }
        return b;
      },
      update: () => b,
      eq: () => b,
      in: (col?: string, values?: readonly string[]) => {
        if (table === 'a2a_payment_intent_debit_signatures') {
          sigInCalls.push({ col: col ?? '', values: values ?? [] });
        }
        return b;
      },
      maybeSingle: () => Promise.resolve(result),
      // biome-ignore lint/suspicious/noThenProperty: awaitable supabase builder test double
      then: (resolve: (v: unknown) => void) => resolve(result),
    };
    return b;
    // biome-ignore lint/suspicious/noExplicitAny: test double for supabase builder
  }) as any);
  return {
    sigSelectCols: () => sigSelectCols,
    sigInCalls: () => sigInCalls,
    /** Valores del `.in()` sobre `debit_settle_status` (el filtro de estados). */
    settleStatusFilter: () =>
      sigInCalls.find((c) => c.col === 'debit_settle_status')?.values ?? [],
  };
}

/** Configura supabase.rpc por nombre (claim_reconciliation / record_reconciliation_resolution). */
function wireRpc(opts: {
  claim?: { data: unknown; error: unknown };
  record?: { data: unknown; error: unknown };
}) {
  mockRpc.mockImplementation(((name: string) => {
    if (name === 'claim_reconciliation') {
      return Promise.resolve(opts.claim ?? { data: null, error: null });
    }
    if (name === 'record_reconciliation_resolution') {
      return Promise.resolve(
        opts.record ?? { data: [{ applied: true }], error: null },
      );
    }
    return Promise.resolve({ data: null, error: null });
    // biome-ignore lint/suspicious/noExplicitAny: test double for supabase builder
  }) as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsEscrowSettleEnabled.mockReturnValue(true);
  mockResolveEscrow.mockReturnValue(
    '0x7777777777777777777777777777777777777777',
  );
});

// ── T-5: confirmed → SETTLE (hop2 al seller), NO refund ──────────
describe('T-5 resolveIntent confirmed → resolved_settled', () => {
  it('llama el seam con payTo=seller, flip resolved_settled, sin refund on-chain', async () => {
    mockReverify.mockResolvedValue('confirmed');
    wireFrom({ sigResult: { data: sigRow(), error: null } });
    wireRpc({
      claim: {
        data: [
          {
            claimed: true,
            resolution_tx_hash: null,
            amount_atomic: AMOUNT_ATOMIC,
          },
        ],
        error: null,
      },
    });
    mockSettleSeam.mockResolvedValue({
      status: 'settled',
      txHash: '0xsettletx',
      finalAmountUsd: 2,
    });

    const out = await reconciliationService.resolveIntent(INTENT_ID);

    expect(out).toEqual({
      status: 'settled',
      side: 'settle',
      txHash: '0xsettletx',
    });
    // seam invocado con el seller como destino y monto USD derivado del atomic.
    expect(mockSettleSeam).toHaveBeenCalledTimes(1);
    expect(mockSettleSeam).toHaveBeenCalledWith(
      expect.objectContaining({
        payTo: PAYTO,
        finalAmountUsd: 2,
        chainId: CHAIN_ID,
      }),
    );
    // flip terminal resolved_settled, sin refund (p_refund_amount_usd null).
    const recCall = mockRpc.mock.calls.find(
      (c) => c[0] === 'record_reconciliation_resolution',
    );
    expect(recCall?.[1]).toMatchObject({
      p_terminal_status: 'resolved_settled',
      p_tx_hash: '0xsettletx',
      p_refund_amount_usd: null,
    });
  });
});

// ── T-6: not_confirmed → REFUND BUDGET-ONLY, NUNCA seam on-chain ──
describe('T-6 resolveIntent not_confirmed → refund budget-only', () => {
  it('NO invoca settlePaymentIntentOnChain; record con refund>0 y tx null', async () => {
    mockReverify.mockResolvedValue('not_confirmed');
    wireFrom({ sigResult: { data: sigRow(), error: null } });
    wireRpc({
      claim: {
        data: [
          {
            claimed: true,
            resolution_tx_hash: null,
            amount_atomic: AMOUNT_ATOMIC,
          },
        ],
        error: null,
      },
    });

    const out = await reconciliationService.resolveIntent(INTENT_ID);

    expect(out).toEqual({ status: 'refunded', side: 'refund', txHash: null });
    // MONEY-SAFETY CRÍTICO: el refund JAMÁS mueve fondos on-chain.
    expect(mockSettleSeam).not.toHaveBeenCalled();
    const recCall = mockRpc.mock.calls.find(
      (c) => c[0] === 'record_reconciliation_resolution',
    );
    expect(recCall?.[1]).toMatchObject({
      p_terminal_status: 'resolved_refunded',
      p_tx_hash: null,
      p_refund_amount_usd: 2, // == finalAmountUsd (formatUnits(2000000, 6))
    });
  });
});

// ── T-7: idempotencia — claim ya perdido → already_resolved ──────
describe('T-7 resolveIntent idempotente (claim gana-uno)', () => {
  it('claim {claimed:false} → already_resolved, sin 2º side-effect', async () => {
    mockReverify.mockResolvedValue('confirmed');
    wireFrom({ sigResult: { data: sigRow(), error: null } });
    wireRpc({ claim: { data: [{ claimed: false }], error: null } });

    const out = await reconciliationService.resolveIntent(INTENT_ID);

    expect(out).toEqual({ status: 'already_resolved' });
    expect(mockSettleSeam).not.toHaveBeenCalled();
    const recCall = mockRpc.mock.calls.find(
      (c) => c[0] === 'record_reconciliation_resolution',
    );
    expect(recCall).toBeUndefined(); // no flip terminal 2º
  });
});

// ── T-8: exactly-one-side (INTEGRACIÓN SQL documentada) ──────────
describe('T-8 exactly-one-side / mutua exclusión', () => {
  // El gating DB-level `resolved_settled ⇐ resolving_settle` y
  // `resolved_refunded ⇐ resolving_refund` (CHECK single-valued + status-gate) vive en el
  // RPC record_reconciliation_resolution (migración 20260713000002_wkh191c_reconciliation.sql):
  // un flip desde el marker OPUESTO devuelve applied=false y NO cruza lados. Eso NO es
  // simulable sin Postgres. Acá se asserta la INVARIANTE observable en el service: el lado
  // derivado del veredicto on-chain determina UNÍVOCAMENTE el terminal pedido — el service
  // NUNCA pide resolved_settled en refund ni resolved_refunded en settle.
  it('settle-side pide SOLO resolved_settled; refund-side pide SOLO resolved_refunded', async () => {
    // settle side.
    mockReverify.mockResolvedValue('confirmed');
    wireFrom({ sigResult: { data: sigRow(), error: null } });
    wireRpc({
      claim: {
        data: [
          {
            claimed: true,
            resolution_tx_hash: null,
            amount_atomic: AMOUNT_ATOMIC,
          },
        ],
        error: null,
      },
    });
    mockSettleSeam.mockResolvedValue({
      status: 'settled',
      txHash: '0xsettletx',
      finalAmountUsd: 2,
    });
    await reconciliationService.resolveIntent(INTENT_ID);
    const settleCall = mockRpc.mock.calls.find(
      (c) => c[0] === 'record_reconciliation_resolution',
    );
    expect(settleCall?.[1]).toMatchObject({
      p_terminal_status: 'resolved_settled',
    });

    // refund side (nueva corrida).
    vi.clearAllMocks();
    mockIsEscrowSettleEnabled.mockReturnValue(true);
    mockResolveEscrow.mockReturnValue(
      '0x7777777777777777777777777777777777777777',
    );
    mockReverify.mockResolvedValue('not_confirmed');
    wireFrom({ sigResult: { data: sigRow(), error: null } });
    wireRpc({
      claim: {
        data: [
          {
            claimed: true,
            resolution_tx_hash: null,
            amount_atomic: AMOUNT_ATOMIC,
          },
        ],
        error: null,
      },
    });
    await reconciliationService.resolveIntent(INTENT_ID);
    const refundCall = mockRpc.mock.calls.find(
      (c) => c[0] === 'record_reconciliation_resolution',
    );
    expect(refundCall?.[1]).toMatchObject({
      p_terminal_status: 'resolved_refunded',
    });
    // el service jamás pidió el terminal del lado opuesto.
    expect(refundCall?.[1]).not.toMatchObject({
      p_terminal_status: 'resolved_settled',
    });
  });
});

// ── T-9: flag OFF → cero side-effect ni lectura de dinero ────────
describe('T-9 resolveIntent flag OFF', () => {
  it('ESCROW_SETTLE_ENABLED OFF → flag_off, sin tocar supabase/seam', async () => {
    mockIsEscrowSettleEnabled.mockReturnValue(false);

    const out = await reconciliationService.resolveIntent(INTENT_ID);

    expect(out).toEqual({ status: 'flag_off' });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockReverify).not.toHaveBeenCalled();
    expect(mockSettleSeam).not.toHaveBeenCalled();
  });
});

// ── T-10: indeterminate → abort, no mueve dinero ─────────────────
describe('T-10 resolveIntent indeterminate (RPC caído)', () => {
  it('reverify indeterminate → abort, claim/seam/refund no invocados', async () => {
    mockReverify.mockResolvedValue('indeterminate');
    wireFrom({ sigResult: { data: sigRow(), error: null } });

    const out = await reconciliationService.resolveIntent(INTENT_ID);

    expect(out).toEqual({ status: 'indeterminate' });
    expect(mockRpc).not.toHaveBeenCalled(); // ni claim ni record
    expect(mockSettleSeam).not.toHaveBeenCalled();
  });
});

// ── T-11: crash-recovery — tx previa válida → NO re-envía ────────
describe('T-11 resolveIntent crash-recovery', () => {
  it('claim trae tx previa + verify ok:true → NO re-envía seam, flip terminal', async () => {
    mockReverify.mockResolvedValue('confirmed');
    wireFrom({ sigResult: { data: sigRow(), error: null } });
    wireRpc({
      claim: {
        data: [
          {
            claimed: true,
            resolution_tx_hash: '0xpriorsettle',
            amount_atomic: AMOUNT_ATOMIC,
          },
        ],
        error: null,
      },
    });
    mockVerifyDefaultChainSettle.mockResolvedValue({ ok: true });

    const out = await reconciliationService.resolveIntent(INTENT_ID);

    expect(mockSettleSeam).not.toHaveBeenCalled(); // NO re-enviar (evita double-move)
    expect(out).toMatchObject({ status: 'settled', side: 'settle' });
    const recCall = mockRpc.mock.calls.find(
      (c) => c[0] === 'record_reconciliation_resolution',
    );
    expect(recCall?.[1]).toMatchObject({
      p_terminal_status: 'resolved_settled',
      p_tx_hash: '0xpriorsettle',
    });
  });

  it('claim trae tx previa + verify warn (RPC down) → abort indeterminate', async () => {
    mockReverify.mockResolvedValue('confirmed');
    wireFrom({ sigResult: { data: sigRow(), error: null } });
    wireRpc({
      claim: {
        data: [
          {
            claimed: true,
            resolution_tx_hash: '0xpriorsettle',
            amount_atomic: AMOUNT_ATOMIC,
          },
        ],
        error: null,
      },
    });
    mockVerifyDefaultChainSettle.mockResolvedValue({ ok: true, warn: true });

    const out = await reconciliationService.resolveIntent(INTENT_ID);

    expect(out).toEqual({ status: 'indeterminate' });
    expect(mockSettleSeam).not.toHaveBeenCalled();
    const recCall = mockRpc.mock.calls.find(
      (c) => c[0] === 'record_reconciliation_resolution',
    );
    expect(recCall).toBeUndefined();
  });
});

// ── T-12: driftCheck — report-only, sin escritura ────────────────
describe('T-12 driftCheck report-only', () => {
  it('reporta sum vs escrowBalance + delta + exceedsThreshold, sin RPC de escritura', async () => {
    // 2 firmas de la MISMA key → sum = 3.0 atomic.
    wireFrom({
      sigResult: {
        data: [
          {
            key_id: KEY_ID,
            debit_key_id_hash: KEY_ID_HASH,
            debit_amount_atomic: '2000000',
            owner_ref: OWNER,
            a2a_payment_intents: { chain_id: CHAIN_ID },
          },
          {
            key_id: KEY_ID,
            debit_key_id_hash: KEY_ID_HASH,
            debit_amount_atomic: '1000000',
            owner_ref: OWNER,
            a2a_payment_intents: { chain_id: CHAIN_ID },
          },
        ],
        error: null,
      },
      keyResult: {
        data: { budget: { [String(CHAIN_ID)]: '5.0' } },
        error: null,
      },
    });
    // escrowBalance on-chain = 3.5 atomic → delta = 3.5 - 3.0 = +0.5.
    mockReadEscrowBalance.mockResolvedValue(3_500_000n);

    const rows = await reconciliationService.driftCheck();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key_id: KEY_ID,
      sumDebitedAtomic: '3000000',
      escrowBalanceAtomic: '3500000',
      budgetUsd: '5.0',
      deltaAtomic: '500000',
      exceedsThreshold: true, // threshold default 0 → cualquier delta ≠ 0
    });
    // report-only: NUNCA escribe (ni claim ni record ni refund).
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('escrowBalance null (RPC caído) → delta null, NO exceedsThreshold', async () => {
    wireFrom({
      sigResult: {
        data: [
          {
            key_id: KEY_ID,
            debit_key_id_hash: KEY_ID_HASH,
            debit_amount_atomic: '2000000',
            owner_ref: OWNER,
            a2a_payment_intents: { chain_id: CHAIN_ID },
          },
        ],
        error: null,
      },
      keyResult: { data: null, error: null },
    });
    mockReadEscrowBalance.mockResolvedValue(null);

    const rows = await reconciliationService.driftCheck();

    expect(rows[0]).toMatchObject({
      escrowBalanceAtomic: null,
      deltaAtomic: null,
      exceedsThreshold: false,
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WKH-196 — pérdida de precisión uint256 al leer NUMERIC(78,0) sin cast `::text`
// ════════════════════════════════════════════════════════════════════════════

// ── T-NEW-6: resolveIntent cast-presence + round-trip del nonce del incidente ──
describe('T-NEW-6 resolveIntent cast-presence + round-trip nonce (AC-4/AC-6, WKH-196)', () => {
  it('select castea nonce/amount ::text y el nonce > 2^53 sobrevive exacto a claim/reverify', async () => {
    mockReverify.mockResolvedValue('confirmed');
    const wired = wireFrom({
      sigResult: {
        data: sigRow({ debit_nonce: '4312989337224638380' }),
        error: null,
      },
    });
    wireRpc({
      claim: {
        data: [
          {
            claimed: true,
            resolution_tx_hash: null,
            amount_atomic: AMOUNT_ATOMIC,
          },
        ],
        error: null,
      },
    });
    mockSettleSeam.mockResolvedValue({
      status: 'settled',
      txHash: '0xsettletx',
      finalAmountUsd: 2,
    });

    await reconciliationService.resolveIntent(INTENT_ID);

    // (a) cast-presence: el select castea ambas columnas NUMERIC(78,0).
    const cols = wired.sigSelectCols();
    expect(cols).toContain('debit_nonce::text');
    expect(cols).toContain('debit_amount_atomic::text');
    // (b) round-trip: claim_reconciliation recibe el nonce string EXACTO.
    const claimCall = mockRpc.mock.calls.find(
      (c) => c[0] === 'claim_reconciliation',
    );
    expect(claimCall?.[1]).toMatchObject({ p_nonce: '4312989337224638380' });
    // reverify recibe el nonce reconstruido como bigint EXACTO (bug: 4312989337224638464n).
    expect(mockReverify).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: 4312989337224638380n }),
    );
  });
});

// ── T-NEW-7: listPending mapea el nonce > 2^53 string exacto ──
describe('T-NEW-7 listPending round-trip nonce (AC-4, WKH-196)', () => {
  it('el item del output preserva nonce="4312989337224638380" exacto', async () => {
    wireFrom({
      sigResult: {
        data: [sigRow({ debit_nonce: '4312989337224638380' })],
        error: null,
      },
    });
    const rows = await reconciliationService.listPending();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.nonce).toBe('4312989337224638380');
  });
});

// ════════════════════════════════════════════════════════════════════
// HU-198 fix-pack (AR BLQ-MEDIO-4) · `resolving_settle` TIENE que seguir siendo
// visible y resoluble. Es LA invariante que sostiene el diseño entero: el estado se
// eligió porque no se auto-reclama PERO sigue en la superficie del humano. Si
// desaparece de `PENDING_STATUSES`, la fila se vuelve un limbo que nadie mira —
// peor que el bug original (una fila con plata posiblemente duplicada, invisible).
// El AR probó que borrar esa entrada NO ponía nada rojo: 3714 passed, 0 failed.
// ════════════════════════════════════════════════════════════════════
describe('HU-198 fix-pack: resolving_settle sigue en la superficie de reconciliación', () => {
  it('T-198-Pending-List: listPending() filtra por un set que INCLUYE resolving_settle', async () => {
    const wired = wireFrom({ sigResult: { data: [], error: null } });

    await reconciliationService.listPending();

    const statuses = wired.settleStatusFilter();
    // El estado durable del hop 2 desconocido: sin esto no aparece en el panel.
    expect(statuses).toContain('resolving_settle');
    // Y los otros pendientes no se perdieron en el camino.
    expect(statuses).toContain('hop1_confirmed');
    expect(statuses).toContain('reconciliation_pending');
    expect(statuses).toContain('resolving_refund');
  });

  it('T-198-Pending-Resolve: resolveIntent() acepta una fila resolving_settle (no tira NOT_PENDING)', async () => {
    // La otra mitad: `listPending` y `resolveIntent` comparten PENDING_STATUSES, así
    // que si el estado se cae de la lista el humano tampoco puede resolverla — ve el
    // botón (o no) y el POST responde NOT_PENDING. Se afirma el FILTRO que la query
    // manda, que es lo que decide si la fila es alcanzable.
    const wired = wireFrom({
      sigResult: {
        data: sigRow({ debit_settle_status: 'resolving_settle' }),
        error: null,
      },
    });
    mockReverify.mockResolvedValue('indeterminate');

    await reconciliationService.resolveIntent(INTENT_ID);

    expect(wired.settleStatusFilter()).toContain('resolving_settle');
  });

  it('T-198-Pending-Shared: listPending y resolveIntent usan EL MISMO set de estados', async () => {
    // Candado anti-divergencia: las dos superficies tienen que moverse juntas. Si
    // alguien agrega un estado a una sola, el humano ve una fila que no puede
    // resolver (o al revés, puede resolver algo que no ve).
    const a = wireFrom({ sigResult: { data: [], error: null } });
    await reconciliationService.listPending();
    const listStatuses = [...a.settleStatusFilter()];

    const b = wireFrom({
      sigResult: {
        data: sigRow({ debit_settle_status: 'resolving_settle' }),
        error: null,
      },
    });
    mockReverify.mockResolvedValue('indeterminate');
    await reconciliationService.resolveIntent(INTENT_ID);
    const resolveStatuses = [...b.settleStatusFilter()];

    expect(listStatuses.length).toBeGreaterThan(0);
    expect([...resolveStatuses].sort()).toEqual([...listStatuses].sort());
  });
});

// ── T-NEW-8: driftCheck round-trip amount > 2^53 + cast-presence (SOLO amount, CD-6) ──
describe('T-NEW-8 driftCheck round-trip amount + cast-presence (AC-2/AC-4/CD-6, WKH-196)', () => {
  it('sumDebitedAtomic exacto y el select castea SOLO debit_amount_atomic::text', async () => {
    const wired = wireFrom({
      sigResult: {
        data: [
          {
            key_id: KEY_ID,
            debit_key_id_hash: KEY_ID_HASH,
            debit_amount_atomic: '4312989337224638380',
            owner_ref: OWNER,
            a2a_payment_intents: { chain_id: CHAIN_ID },
          },
        ],
        error: null,
      },
      keyResult: { data: null, error: null },
    });
    mockReadEscrowBalance.mockResolvedValue(null);

    const rows = await reconciliationService.driftCheck();

    // round-trip: la suma bigint del amount NUMERIC(78,0) es EXACTA.
    expect(rows[0]?.sumDebitedAtomic).toBe('4312989337224638380');
    // cast-presence: driftCheck NO trae debit_nonce → castea SOLO el amount (CD-6).
    const cols = wired.sigSelectCols();
    expect(cols).toContain('debit_amount_atomic::text');
    expect(cols).not.toContain('debit_nonce::text');
  });

  // ── HU-198: el reporte de drift no se puede callar un débito vigente ──
  it('T-198-Drift: cuenta resolving_settle (débito vigente) y NO resolving_refund', async () => {
    // `resolving_settle` pasó a ser un estado DURADERO (el hop 2 de resultado
    // desconocido). Ahí el débito del hop 1 está vigente y sin reembolsar, así que
    // omitirlo hacía que el drift SUB-DECLARARA justo los casos que hay que mirar.
    // `resolving_refund` queda afuera a propósito: ese débito se está revirtiendo.
    const wired = wireFrom({
      sigResult: { data: [], error: null },
      keyResult: { data: null, error: null },
    });

    await reconciliationService.driftCheck();

    const statuses = wired.settleStatusFilter();
    expect(statuses).toContain('hop1_confirmed');
    expect(statuses).toContain('settled');
    expect(statuses).toContain('reconciliation_pending');
    expect(statuses).toContain('resolving_settle');
    expect(statuses).not.toContain('resolving_refund');
  });
});

// ── T-NEW-9: driftCheck amount safe (< 2^53) byte-idéntico (CD-1) ──
describe('T-NEW-9 driftCheck safe amount byte-idéntico (AC-5/CD-1, WKH-196)', () => {
  it('debit_amount_atomic="3000000000000000000" → sumDebitedAtomic idéntico', async () => {
    wireFrom({
      sigResult: {
        data: [
          {
            key_id: KEY_ID,
            debit_key_id_hash: KEY_ID_HASH,
            debit_amount_atomic: '3000000000000000000',
            owner_ref: OWNER,
            a2a_payment_intents: { chain_id: CHAIN_ID },
          },
        ],
        error: null,
      },
      keyResult: { data: null, error: null },
    });
    mockReadEscrowBalance.mockResolvedValue(null);

    const rows = await reconciliationService.driftCheck();

    expect(rows[0]?.sumDebitedAtomic).toBe('3000000000000000000');
  });
});

// ── BLQ-ALTO-1: doble hop2 (double-pay al seller) por resolve concurrente ──
describe('BLQ-ALTO-1 race del doble hop2 (claim exclusivo + lease)', () => {
  // Emula el contrato REAL de claim_reconciliation + record_reconciliation_resolution +
  // el lease (UPDATE de debit_resolution_tx_hash) contra una fila EN MEMORIA, espejo del
  // WHERE de la migración 20260713000002_wkh191c_reconciliation.sql. Reproduce la race de
  // dos resoluciones del MISMO intent sobre resolving_settle.
  //   · fixed=true  → claim post-fix: re-claim de resolving_settle SOLO con tx previa.
  //   · fixed=false → claim pre-fix (buggy): re-claim de resolving_settle INCONDICIONAL.
  interface MemRow {
    status: string;
    tx: string | null;
  }
  /**
   * `raceLostClaim`: el claim devuelve `claimed:false` AUNQUE el estado de la fila lo
   * habilitaría. Simula la RACE real: entre el SELECT de `resolveIntent` y el
   * `claim_reconciliation`, otro run flipeó la fila a un terminal. En esa ventana el
   * `row` que leyó el service dice `resolving_settle` (con o sin tx) y el claim pierde.
   *
   * Existe por AR#2 BLQ-BAJO-2(a): sin esto, el contra-ejemplo "resolving_settle CON tx"
   * hacía GANAR el claim, así que el `if (!claimRow || claimRow.claimed === false)` no se
   * ejecutaba y el test pasaba por una razón ajena al código que decía candar.
   */
  function harness(
    row: MemRow,
    opts: { fixed: boolean; raceLostClaim?: boolean },
  ): () => number {
    mockReverify.mockResolvedValue('confirmed');
    mockVerifyDefaultChainSettle.mockResolvedValue({ ok: true });
    let seamCalls = 0;
    mockSettleSeam.mockImplementation(async () => {
      seamCalls += 1;
      return {
        status: 'settled',
        txHash: `0xsettle${seamCalls}`,
        finalAmountUsd: 2,
      };
    });
    mockFrom.mockImplementation(((table: string) => {
      let patch: Record<string, unknown> | undefined;
      const b: Record<string, unknown> = {
        select: () => b,
        update: (p: Record<string, unknown>) => {
          patch = p;
          return b;
        },
        eq: () => b,
        in: () => b,
        maybeSingle: () =>
          Promise.resolve({
            data: sigRow({
              debit_settle_status: row.status,
              debit_hop1_tx_hash: HOP1_TX,
              // Fidelidad con el SELECT real: la tx del hop 2 que la fila tenga.
              debit_resolution_tx_hash: row.tx,
            }),
            error: null,
          }),
        // biome-ignore lint/suspicious/noThenProperty: awaitable supabase builder test double
        then: (resolve: (v: unknown) => void) => {
          // Lease: la primera vez que se persiste la tx sobre resolving_settle, la fija.
          if (
            table === 'a2a_payment_intent_debit_signatures' &&
            typeof patch?.debit_resolution_tx_hash === 'string' &&
            row.status === 'resolving_settle'
          ) {
            row.tx = patch.debit_resolution_tx_hash;
          }
          resolve({ data: null, error: null });
        },
      };
      return b;
      // biome-ignore lint/suspicious/noExplicitAny: test double for supabase builder
    }) as any);
    mockRpc.mockImplementation(((
      name: string,
      args: Record<string, unknown>,
    ) => {
      if (name === 'claim_reconciliation') {
        const target =
          args.p_side === 'settle' ? 'resolving_settle' : 'resolving_refund';
        const fresh =
          row.status === 'hop1_confirmed' ||
          row.status === 'reconciliation_pending';
        // WHERE del re-claim (migración): settle exige tx previa; refund siempre.
        const reclaim =
          row.status === target &&
          (opts.fixed ? args.p_side === 'refund' || row.tx !== null : true);
        if (opts.raceLostClaim) {
          // La race: el claim pierde sin tocar el estado que el SELECT ya leyó.
          return Promise.resolve({ data: [{ claimed: false }], error: null });
        }
        if (fresh || reclaim) {
          row.status = target;
          return Promise.resolve({
            data: [
              {
                claimed: true,
                resolution_tx_hash: row.tx,
                amount_atomic: AMOUNT_ATOMIC,
              },
            ],
            error: null,
          });
        }
        return Promise.resolve({ data: [{ claimed: false }], error: null });
      }
      if (name === 'record_reconciliation_resolution') {
        const required =
          args.p_terminal_status === 'resolved_settled'
            ? 'resolving_settle'
            : 'resolving_refund';
        if (row.status === required) {
          row.status = args.p_terminal_status as string;
          if (typeof args.p_tx_hash === 'string' && row.tx === null) {
            row.tx = args.p_tx_hash;
          }
          return Promise.resolve({ data: [{ applied: true }], error: null });
        }
        return Promise.resolve({ data: [{ applied: false }], error: null });
      }
      return Promise.resolve({ data: null, error: null });
      // biome-ignore lint/suspicious/noExplicitAny: test double for supabase builder
    }) as any);
    return () => seamCalls;
  }

  it('resolving_settle SIN tx previa: el claim exclusivo pierde → NO re-envía el hop2 (fix)', async () => {
    // 2º run concurrente (o crash pre-envío): la fila ya está en resolving_settle, tx null.
    const seam = harness(
      { status: 'resolving_settle', tx: null },
      { fixed: true },
    );
    const out = await reconciliationService.resolveIntent(INTENT_ID);
    // AR BLQ-BAJO-1: antes esto devolvía `already_resolved`, y era una respuesta FALSA
    // sobre una fila NO resuelta con plata posiblemente duplicada — encima en la única
    // herramienta que el humano tiene para resolverla. La propiedad de dinero (cero
    // re-envíos) no cambió; lo que cambió es que el operador ahora se entera.
    expect(out).toEqual({ status: 'awaiting_manual_settle_evidence' });
    expect(seam()).toBe(0); // exactamente-cero re-envíos → sin double-pay
    expect(mockSettleSeam).not.toHaveBeenCalled();
  });

  // ── AR#2 BLQ-BAJO-2(a): el par que hace load-bearing al `&& !tx` ──
  //
  // La versión anterior de este contra-ejemplo era VACUA: usaba `fixed:true` con tx, y
  // en esa combinación el claim GANA, así que la rama `claimed === false` (la que
  // contiene el guard) nunca corría. Borrar `&& !row.debit_resolution_tx_hash` dejaba la
  // suite entera verde. Ahora los dos casos entran por la MISMA rama (claim perdido por
  // la race) y se diferencian SÓLO por la presencia de la tx, que es lo que el guard
  // mira.
  it('AR#2: claim perdido + resolving_settle SIN tx → awaiting_manual_settle_evidence', async () => {
    harness(
      { status: 'resolving_settle', tx: null },
      { fixed: true, raceLostClaim: true },
    );
    const out = await reconciliationService.resolveIntent(INTENT_ID);
    expect(out.status).toBe('awaiting_manual_settle_evidence');
  });

  it('AR#2: claim perdido + resolving_settle CON tx → already_resolved (hay evidencia que verificar)', async () => {
    // Con tx previa el caso NO es "esperando evidencia": la evidencia existe y el
    // crash-recovery del propio reconciliador la re-verifica. Reportar "esperá evidencia
    // manual" acá mandaría al operador a buscar algo que ya está en la fila.
    harness(
      { status: 'resolving_settle', tx: HOP1_TX },
      { fixed: true, raceLostClaim: true },
    );
    const out = await reconciliationService.resolveIntent(INTENT_ID);
    expect(out.status).toBe('already_resolved');
    expect(out.status).not.toBe('awaiting_manual_settle_evidence');
  });

  it('CONTROL (sin el fix): claim pre-fix re-claima resolving_settle → RE-ENVÍA el hop2 (double-pay)', async () => {
    // Reproduce el BLQ: con la semántica pre-fix el 2º run gana el claim y re-envía → 2ª
    // transferencia real al seller. Documenta el re-envío que el claim exclusivo elimina.
    const seam = harness(
      { status: 'resolving_settle', tx: null },
      { fixed: false },
    );
    await reconciliationService.resolveIntent(INTENT_ID);
    expect(seam()).toBe(1); // el hop2 se re-envía → double-pay en producción
    expect(mockSettleSeam).toHaveBeenCalledTimes(1);
  });

  it('crash-recovery CON lease (tx previa): re-verifica on-chain y NO re-envía', async () => {
    // Run previo murió tras el envío pero dejó el lease → el retry re-claima y verifica.
    const seam = harness(
      { status: 'resolving_settle', tx: '0xpriorlease' },
      { fixed: true },
    );
    const out = await reconciliationService.resolveIntent(INTENT_ID);
    expect(mockVerifyDefaultChainSettle).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: '0xpriorlease' }),
    );
    expect(seam()).toBe(0); // verify ok:true → skipResend → cero re-envíos
    expect(out).toMatchObject({ status: 'settled', side: 'settle' });
  });

  it('entrada fresca settle: envía UNA vez, persiste el lease y flipea terminal', async () => {
    const row: MemRow = { status: 'hop1_confirmed', tx: null };
    const seam = harness(row, { fixed: true });
    const out = await reconciliationService.resolveIntent(INTENT_ID);
    expect(seam()).toBe(1); // hop2 enviado exactamente una vez
    expect(row.tx).toBe('0xsettle1'); // lease persistido antes del flip terminal
    expect(row.status).toBe('resolved_settled');
    expect(out).toMatchObject({ status: 'settled', side: 'settle' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// HU-201 (AR BLQ-MEDIO-2) — `listAmbiguous`: la superficie de los deposits RETENIDOS.
//
// POR QUÉ ES BLOQUEANTE Y NO COSMÉTICO: HU-201 mandó los HTTP non-2xx a `ambiguous` ⟹
// `failed_ambiguous` ⟹ el deposit del buyer NO se reembolsa. En el camino NO-ESCROW —el
// DEFAULT— esas filas eran INVISIBLES: `listPending()` lee la tabla de firmas (que sin
// escrow no existe) y `resolveIntent()` corta en el gate del flag. O sea que el fix
// cambiaba "reembolso indebido RUIDOSO" por "retención SILENCIOSA".
//
// Y el modo de falla ya ocurrió en este repo: el facilitator exigiendo un Bearer que el
// adapter no mandaba ⟹ 401 en el 100% de los settles. Antes era auto-sanante (todos los
// buyers reembolsados); con HU-201 sería el 100% de los deposits retenidos.
// ════════════════════════════════════════════════════════════════════════════
describe('HU-201 listAmbiguous (superficie de los deposits retenidos)', () => {
  interface Captured {
    table: string | null;
    cols: string | null;
    countOpt: string | null;
    eqCalls: Array<[string, unknown]>;
    orderCalls: Array<[string, unknown]>;
    limitCalls: number[];
  }

  /**
   * Doble propio: el `wireFrom` compartido no soporta `.order()`/`.limit()` ni el
   * `count`. Captura la FORMA de la query — sin eso, un test que sólo mira el mapeo
   * no distinguiría una query correcta de una que lee la tabla equivocada.
   */
  function wireIntents(rows: unknown[], count: number | null) {
    const cap: Captured = {
      table: null,
      cols: null,
      countOpt: null,
      eqCalls: [],
      orderCalls: [],
      limitCalls: [],
    };
    mockFrom.mockImplementation(((table: string) => {
      cap.table = table;
      const b: Record<string, unknown> = {
        select: (cols?: string, opts?: { count?: string }) => {
          cap.cols = cols ?? null;
          cap.countOpt = opts?.count ?? null;
          return b;
        },
        eq: (col: string, val: unknown) => {
          cap.eqCalls.push([col, val]);
          return b;
        },
        order: (col: string, opts?: unknown) => {
          cap.orderCalls.push([col, opts]);
          return b;
        },
        limit: (n: number) => {
          cap.limitCalls.push(n);
          return Promise.resolve({ data: rows, error: null, count });
        },
        // biome-ignore lint/suspicious/noThenProperty: awaitable supabase builder test double
        then: (resolve: (v: unknown) => void) =>
          resolve({ data: rows, error: null, count }),
      };
      return b;
      // biome-ignore lint/suspicious/noExplicitAny: test double for supabase builder
    }) as any);
    return cap;
  }

  function ambiguousRow(overrides: Record<string, unknown> = {}) {
    return {
      id: INTENT_ID,
      owner_ref: OWNER,
      key_id: KEY_ID,
      intent_type: 'session',
      status: 'failed',
      chain_id: CHAIN_ID,
      pay_to: PAYTO,
      authorized_usd: '10.00000000',
      consumed_usd: '4.00000000',
      settle_outcome: 'failed_ambiguous',
      error_message:
        'RECONCILE: settle failed WITH a broadcast hash (0xBROADCASTED): boom',
      updated_at: '2026-07-28T00:00:00.000Z',
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsEscrowSettleEnabled.mockReturnValue(true);
  });

  it('T-201-AMB-QUERY: lee `a2a_payment_intents` filtrando por settle_outcome=failed_ambiguous', async () => {
    const cap = wireIntents([ambiguousRow()], 1);

    await reconciliationService.listAmbiguous();

    // La tabla importa: `listPending` lee la de FIRMAS, que en el camino no-escrow
    // (el default) no tiene fila. Si esta query leyera ahí, la lista sería vacía
    // justo en el caso que existe para cubrir.
    expect(cap.table).toBe('a2a_payment_intents');
    expect(cap.eqCalls).toContainEqual(['settle_outcome', 'failed_ambiguous']);
  });

  it('T-201-AMB-FLAG-OFF: funciona con ESCROW_SETTLE_ENABLED OFF — que es el caso que existe para cubrir', async () => {
    // ÉSTE es el candado central. El camino que produce estas filas es el NO-escrow,
    // o sea el que corre con el flag OFF. Si alguien "unificara" esta lista con el
    // gate de `resolveIntent()` (`if (!isEscrowSettleEnabled()) return flag_off`),
    // volvería a quedar vacía exactamente cuando importa, y en silencio.
    mockIsEscrowSettleEnabled.mockReturnValue(false);
    wireIntents([ambiguousRow()], 1);

    const out = await reconciliationService.listAmbiguous();

    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.intent_id).toBe(INTENT_ID);
  });

  it('T-201-AMB-EVIDENCE: expone el error_message, que es DONDE VIVE el hash de broadcast', async () => {
    // No hay columna para el hash (sería una migración). El humano que reconcilia lo
    // saca de acá; si el mapeo lo dropeara, la fila sería inaccionable.
    wireIntents([ambiguousRow()], 1);

    const out = await reconciliationService.listAmbiguous();

    expect(out.rows[0]?.error_message).toContain('0xBROADCASTED');
    // Y el monto retenido, que es de lo que se trata la revisión.
    expect(out.rows[0]?.authorizedUsd).toBe('10.00000000');
    expect(out.rows[0]?.consumedUsd).toBe('4.00000000');
  });

  it('T-201-AMB-NUMERIC: los NUMERIC se piden con `::text` (WKH-196: PostgREST redondea)', async () => {
    const cap = wireIntents([], 0);

    await reconciliationService.listAmbiguous();

    expect(cap.cols).toContain('authorized_usd::text');
    expect(cap.cols).toContain('consumed_usd::text');
  });

  it('T-201-AMB-TRUNCATED: una lista acotada lo DECLARA (total exacto), no se calla filas', async () => {
    // Un reporte de plata retenida que se trunca en silencio afirma algo falso sobre
    // su propia completitud — el mismo error que este archivo ya documenta para el
    // drift. Se pide `count: 'exact'` y se compara contra las filas devueltas.
    const cap = wireIntents([ambiguousRow(), ambiguousRow({ id: 'i2' })], 500);

    const out = await reconciliationService.listAmbiguous();

    expect(cap.countOpt).toBe('exact');
    expect(out.total).toBe(500);
    expect(out.truncated).toBe(true);
  });

  it('T-201-AMB-NOT-TRUNCATED: si entran todas, no se declara truncada', async () => {
    wireIntents([ambiguousRow()], 1);

    const out = await reconciliationService.listAmbiguous();

    expect(out.total).toBe(1);
    expect(out.truncated).toBe(false);
  });

  it('T-201-AMB-ERROR: un fallo de la query NO devuelve una lista vacía (eso mentiría "no hay nada retenido")', async () => {
    mockFrom.mockImplementation(((_table: string) => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        order: () => b,
        limit: () =>
          Promise.resolve({
            data: null,
            error: { message: 'boom' },
            count: null,
          }),
      };
      return b;
      // biome-ignore lint/suspicious/noExplicitAny: test double for supabase builder
    }) as any);

    await expect(reconciliationService.listAmbiguous()).rejects.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════
// HU-202 — LEASE DEL HOP 2. El lado settle del reconciliador no puede re-enviar un
// pago cuando existe un intento de hop 2 persistido y sin resolver.
//
// QUÉ MIDEN ESTOS TESTS: **si sale o no un segundo pago al seller**
// (`mockSettleSeam`), y **si se reembolsa o no** al buyer. No miden qué función se
// llamó ni con qué nombre de estado. Las dos direcciones están cubiertas a propósito:
// sobre-corregir acá deja al seller sin cobrar y nadie mira esas filas.
//
// EL DOBLE DEL CLAIM NO ESTÁ HARDCODEADO. `claimPredicate` es un MODELO FIEL del
// `WHERE` de `claim_reconciliation` (migración 20260729000000), así que estos tests
// derivan `claimed` del ESTADO DE LA FILA en vez de que el test elija la respuesta que
// le conviene — que sería asumir justo lo que hay que probar. La correspondencia entre
// el modelo y el SQL real la canda `test/hu202-hop2-lease.migration.test.ts`.
// ════════════════════════════════════════════════════════════════════
describe('HU-202 lease del hop 2: qué re-envía y qué no el reconciliador', () => {
  type LeaseRowState = {
    debit_settle_status: string;
    debit_resolution_tx_hash: string | null;
    debit_hop2_attempted_at: string | null;
  };

  /**
   * Modelo del `WHERE` del UPDATE de `claim_reconciliation` (20260729000000), traducido
   * 1-a-1 desde el SQL:
   *
   *   AND (p_side='refund' OR hop2_attempted_at IS NULL OR resolution_tx IS NOT NULL)
   *   AND ( status IN ('hop1_confirmed','reconciliation_pending')
   *         OR (status = v_target AND (p_side='refund' OR resolution_tx IS NOT NULL))
   *         OR (p_side='refund' AND status='resolving_settle') )
   */
  function claimPredicate(
    row: LeaseRowState,
    side: 'settle' | 'refund',
  ): boolean {
    const target = side === 'settle' ? 'resolving_settle' : 'resolving_refund';
    const leaseGuard =
      side === 'refund' ||
      row.debit_hop2_attempted_at === null ||
      row.debit_resolution_tx_hash !== null;
    const stateGuard =
      ['hop1_confirmed', 'reconciliation_pending'].includes(
        row.debit_settle_status,
      ) ||
      (row.debit_settle_status === target &&
        (side === 'refund' || row.debit_resolution_tx_hash !== null)) ||
      (side === 'refund' && row.debit_settle_status === 'resolving_settle');
    return leaseGuard && stateGuard;
  }

  /** Cablea el claim para que RESPONDA COMO EL SQL sobre esa fila. */
  function wireClaimFromRow(row: LeaseRowState) {
    mockRpc.mockImplementation(((
      name: string,
      args: Record<string, string>,
    ) => {
      if (name === 'claim_reconciliation') {
        const claimed = claimPredicate(row, args.p_side as 'settle' | 'refund');
        return Promise.resolve({
          data: [
            {
              claimed,
              resolution_tx_hash: claimed ? row.debit_resolution_tx_hash : null,
              amount_atomic: claimed ? AMOUNT_ATOMIC : null,
            },
          ],
          error: null,
        });
      }
      if (name === 'record_reconciliation_resolution') {
        return Promise.resolve({ data: [{ applied: true }], error: null });
      }
      return Promise.resolve({ data: null, error: null });
      // biome-ignore lint/suspicious/noExplicitAny: test double for supabase builder
    }) as any);
  }

  /** Corre `resolveIntent` sobre una fila en ese estado y devuelve qué pasó con la plata. */
  async function resolveWithRow(row: LeaseRowState, verdict = 'confirmed') {
    mockReverify.mockResolvedValue(verdict);
    wireFrom({ sigResult: { data: sigRow(row), error: null } });
    wireClaimFromRow(row);
    mockSettleSeam.mockResolvedValue({
      status: 'settled',
      txHash: '0xSECOND_PAYMENT',
      finalAmountUsd: 2,
    });
    const out = await reconciliationService.resolveIntent(INTENT_ID);
    const recordCall = mockRpc.mock.calls.find(
      (c) => c[0] === 'record_reconciliation_resolution',
    )?.[1] as { p_refund_amount_usd?: number | null } | undefined;
    return {
      out,
      /** ¿SALIÓ un segundo pago al seller? Es la pregunta de dinero de esta HU. */
      secondPaymentSent: mockSettleSeam.mock.calls.length > 0,
      /** ¿Se acreditó budget al buyer? */
      refundedUsd: recordCall?.p_refund_amount_usd ?? null,
    };
  }

  // La fila leaseada: el hop 2 se intentó y no hay tx de resolución que verificar.
  const LEASED: LeaseRowState = {
    debit_settle_status: 'resolving_settle',
    debit_resolution_tx_hash: null,
    debit_hop2_attempted_at: '2026-07-29T10:00:00.000Z',
  };

  it('AC-1 (F, el peor: nadie se murió) — con el hop 2 EN VUELO, resolver el intent NUNCA manda un segundo pago', async () => {
    // El caso F NO necesita ningún crash: `record_debit_hop1` dejaba la fila en
    // `hop1_confirmed` durante TODA la ventana del hop 2, y un click en el dashboard
    // durante un settle lento normal la re-enviaba. Con el lease la fila está leaseada
    // durante esa ventana.
    const r = await resolveWithRow(LEASED);

    expect(r.secondPaymentSent).toBe(false);
    expect(r.refundedUsd).toBeNull();
    // Y el operador recibe una instrucción, no un "ya está" que lo mande a otra cosa.
    expect(r.out.status).toBe('awaiting_manual_settle_evidence');
  });

  it('AC-2 (B) — si el proceso murió DESPUÉS de que el request del hop 2 salió, NUNCA se re-envía sin verificar antes una tx on-chain', async () => {
    // B deja exactamente el mismo rastro que F: lease tomado, sin tx de resolución.
    const r = await resolveWithRow(LEASED);
    expect(r.secondPaymentSent).toBe(false);
  });

  it('AC-3 (C) — si el hop 2 pagó pero el flip terminal falló, NUNCA se re-envía automáticamente', async () => {
    // C: el settle aterrizó y el txHash se perdió sin persistirse. El lease sobrevive al
    // fallo del flip, así que la fila queda igual de intocable.
    const r = await resolveWithRow(LEASED);
    expect(r.secondPaymentSent).toBe(false);
  });

  it('AC-4 (G) — una fila estampada que quedó con un status auto-reclamable TAMPOCO se re-envía (el guard no depende del status)', async () => {
    // G es el caso en que el estado del ciclo de vida no quedó donde se creía. El guard
    // del stamp es el que hace que el candado no cuelgue de un string: mismo `status`
    // que el agujero original, pero con el hecho del hop 2 persistido.
    const r = await resolveWithRow({
      debit_settle_status: 'hop1_confirmed',
      debit_resolution_tx_hash: null,
      debit_hop2_attempted_at: '2026-07-29T10:00:00.000Z',
    });

    expect(r.secondPaymentSent).toBe(false);
  });

  it('AC-5 (A) — LA DIRECCIÓN CONTRARIA: sin ningún intento de hop 2 persistido, el seller SÍ cobra solo', async () => {
    // Si esto se pusiera rojo, el fix habría cambiado un doble pago por un seller que
    // nunca cobra — y nadie mira esas filas. Es la mitad que hace que el lease valga.
    const r = await resolveWithRow({
      debit_settle_status: 'hop1_confirmed',
      debit_resolution_tx_hash: null,
      debit_hop2_attempted_at: null,
    });

    expect(r.secondPaymentSent).toBe(true);
    expect(r.out.status).toBe('settled');
    expect(r.out.txHash).toBe('0xSECOND_PAYMENT');
  });

  it('AC-6 (D) — LA DIRECCIÓN CONTRARIA: tras un rechazo inequívoco (lease liberado), el seller SÍ cobra solo', async () => {
    // `settleEscrowAware` libera el lease con el veredicto `unequivocal`: baja a
    // `reconciliation_pending` y limpia el stamp. Si el stamp NO se limpiara, el rechazo
    // NORMAL del facilitator dejaría al seller sin cobrar automáticamente.
    const r = await resolveWithRow({
      debit_settle_status: 'reconciliation_pending',
      debit_resolution_tx_hash: null,
      debit_hop2_attempted_at: null,
    });

    expect(r.secondPaymentSent).toBe(true);
    expect(r.out.status).toBe('settled');
  });

  it('AC-7 (refund) — el lease NUNCA bloquea el reembolso del buyer cuando el hop 1 no movió fondos', async () => {
    // Asimetría deliberada (MNR-4 de HU-198): el refund es budget-only, idempotente y no
    // manda ningún hop 2, así que no puede doble-pagar. Bloquearlo dejaría al único actor
    // sin culpa —el buyer— con el débito off-chain puesto para siempre.
    const r = await resolveWithRow(LEASED, 'not_confirmed');

    expect(r.secondPaymentSent).toBe(false); // NUNCA un transfer en el lado refund
    expect(r.refundedUsd).toBe(2); // el budget del buyer SÍ vuelve
    expect(r.out.status).toBe('refunded');
  });

  it('AC-1b — una fila leaseada CON tx de hop 2 sí se re-claima, pero para VERIFICARLA on-chain, no para re-enviar a ciegas', async () => {
    // Cuando hay hash hay algo que verificar: el crash-recovery de `resolveIntent` lo
    // re-verifica ANTES de decidir. Con verify OK el efecto es el flip terminal SIN un
    // segundo pago.
    mockVerifyDefaultChainSettle.mockResolvedValue({ ok: true, warn: false });
    const r = await resolveWithRow({
      debit_settle_status: 'resolving_settle',
      debit_resolution_tx_hash: '0xPREVIOUS_HOP2',
      debit_hop2_attempted_at: '2026-07-29T10:00:00.000Z',
    });

    expect(r.secondPaymentSent).toBe(false);
    expect(r.out.status).toBe('settled');
    expect(r.out.txHash).toBe('0xPREVIOUS_HOP2');
  });

  it('AC-8 (superficie) — una fila leaseada viaja con CUÁNDO se intentó el hop 2, no sólo con su estado', async () => {
    // Sin la edad, un settle en vuelo de hace 2 segundos y un hop 2 parado de hace 40
    // minutos se ven idénticos en el panel: la lista se satura de ruido transitorio y
    // deja de mirarse. La superficie es parte del fix.
    const wired = wireFrom({
      sigResult: {
        data: [
          sigRow({
            debit_settle_status: 'resolving_settle',
            debit_hop2_attempted_at: '2026-07-29T10:00:00.000Z',
          }),
        ],
        error: null,
      },
    });

    const rows = await reconciliationService.listPending();

    expect(rows[0]?.hop2_attempted_at).toBe('2026-07-29T10:00:00.000Z');
    // Y la query pide la columna de verdad (si no, el campo sería SIEMPRE null en prod).
    expect(wired.sigSelectCols()).toContain('debit_hop2_attempted_at');
  });

  it('AC-8b (superficie) — una fila SIN intento de hop 2 NUNCA se presenta como si lo hubiera tenido', async () => {
    wireFrom({
      sigResult: {
        data: [sigRow({ debit_settle_status: 'hop1_confirmed' })],
        error: null,
      },
    });

    const rows = await reconciliationService.listPending();

    expect(rows[0]?.hop2_attempted_at).toBeNull();
  });

  it('AC-9 (superficie) — la lista de pendientes NUNCA devuelve vacío cuando la query falló', async () => {
    // Invariante heredada de HU-201: un `[]` silencioso sobre plata retenida afirma una
    // completitud falsa. Tiene que TIRAR.
    wireFrom({
      sigResult: { data: null, error: { message: 'boom' } },
    });

    await expect(reconciliationService.listPending()).rejects.toThrow();
  });
});
