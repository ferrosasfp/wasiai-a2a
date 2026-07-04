/**
 * Arbiter rules engine — unit tests (WKH-139 v2, W4.1)
 *
 * Motor puro: 3 desenlaces inequívocos + las 3 ambigüedades genuinas.
 * Sin I/O ni mocks (la función es pura).
 */

import { describe, expect, it } from 'vitest';
import type { DisputeEvidence } from '../../types/arbiter.js';
import { classify } from './rules.js';

function ev(over: Partial<DisputeEvidence>): DisputeEvidence {
  return {
    intentId: 'i1',
    authorizedUsd: 10,
    consumedUsd: 0,
    chainId: 2368,
    payTo: '0xabc',
    sellerRef: 'reg/agent',
    voucherCount: 0,
    vouchersTotalUsd: 0,
    proofChainOk: true,
    receiptSettleTotalUsd: null,
    ...over,
  };
}

describe('arbiter rules — desenlaces inequívocos', () => {
  it('consumed==0 → refund (settle 0)', () => {
    const r = classify(ev({ consumedUsd: 0, voucherCount: 0 }));
    expect(r).toEqual({ decision: 'refund', settleUsd: 0 });
  });

  it('consumed>=deposit → release (settle=deposit, clamp)', () => {
    const r = classify(
      ev({ consumedUsd: 10, voucherCount: 2, vouchersTotalUsd: 10 }),
    );
    expect(r).toEqual({ decision: 'release', settleUsd: 10 });
  });

  it('consumed>deposit → release clampeado al deposit', () => {
    const r = classify(
      ev({ consumedUsd: 12, voucherCount: 3, vouchersTotalUsd: 12 }),
    );
    expect(r).toEqual({ decision: 'release', settleUsd: 10 });
  });

  it('0<consumed<deposit con ledger corroborando → split (settle=consumed)', () => {
    const r = classify(
      ev({ consumedUsd: 3.7, voucherCount: 2, vouchersTotalUsd: 3.7 }),
    );
    expect(r).toEqual({ decision: 'split', settleUsd: 3.7 });
  });
});

describe('arbiter rules — ambigüedades genuinas (escalan a LLM)', () => {
  it('!proofChainOk → ambiguous(proof_chain_tampered) [gana sobre todo]', () => {
    const r = classify(
      ev({
        proofChainOk: false,
        consumedUsd: 5,
        voucherCount: 2,
        vouchersTotalUsd: 5,
      }),
    );
    expect(r).toEqual({ ambiguous: true, reason: 'proof_chain_tampered' });
  });

  it('consumed>0 & voucherCount==0 → ambiguous(evidence_incomplete)', () => {
    const r = classify(ev({ consumedUsd: 4, voucherCount: 0 }));
    expect(r).toEqual({ ambiguous: true, reason: 'evidence_incomplete' });
  });

  it('receipt vs consumed mismatch → ambiguous(meter_receipt_mismatch)', () => {
    const r = classify(
      ev({
        consumedUsd: 4,
        voucherCount: 2,
        vouchersTotalUsd: 4,
        receiptSettleTotalUsd: 9, // contradice el meter
      }),
    );
    expect(r).toEqual({ ambiguous: true, reason: 'meter_receipt_mismatch' });
  });

  it('ledger NO corrobora consumed (split sin respaldo) → ambiguous(meter_receipt_mismatch)', () => {
    const r = classify(
      ev({ consumedUsd: 4, voucherCount: 2, vouchersTotalUsd: 9 }),
    );
    expect(r).toEqual({ ambiguous: true, reason: 'meter_receipt_mismatch' });
  });
});
