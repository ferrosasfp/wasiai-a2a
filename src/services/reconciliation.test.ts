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
