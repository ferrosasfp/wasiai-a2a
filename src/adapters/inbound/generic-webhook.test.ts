/**
 * Generic Webhook Inbound Adapter — unit tests (WKH-115).
 *
 * Cubre AC-3 (mapeo payload→goal/budget/constraints), AC-6 parcial (budget
 * declarado válido/inválido), AC-8 (interfaz source-agnostic + never-throws),
 * CD-9 (validate/normalize NUNCA throwean sobre payloads basura).
 */

import { describe, expect, it } from 'vitest';
import { genericWebhookAdapter, getInboundAdapter } from './generic-webhook.js';

describe('genericWebhookAdapter.validate (AC-3, AC-6, CD-9)', () => {
  it('acepta un payload válido (goal presente)', () => {
    expect(genericWebhookAdapter.validate({ goal: 'do a thing' })).toEqual({
      ok: true,
    });
  });

  it('AC-3: goal ausente → !ok', () => {
    const r = genericWebhookAdapter.validate({ budget_usdc: 5 });
    expect(r.ok).toBe(false);
  });

  it('AC-3: goal vacío tras trim → !ok', () => {
    const r = genericWebhookAdapter.validate({ goal: '   ' });
    expect(r.ok).toBe(false);
  });

  it('AC-3: goal no-string → !ok', () => {
    const r = genericWebhookAdapter.validate({ goal: [] });
    expect(r.ok).toBe(false);
  });

  it('AC-6: budget_usdc negativo → !ok', () => {
    const r = genericWebhookAdapter.validate({ goal: 'x', budget_usdc: -1 });
    expect(r.ok).toBe(false);
  });

  it('AC-6: budget_usdc NaN → !ok', () => {
    const r = genericWebhookAdapter.validate({ goal: 'x', budget_usdc: NaN });
    expect(r.ok).toBe(false);
  });

  it('AC-6: budget_usdc Infinity → !ok', () => {
    const r = genericWebhookAdapter.validate({
      goal: 'x',
      budget_usdc: Infinity,
    });
    expect(r.ok).toBe(false);
  });

  it('AC-6: budget_usdc string → !ok', () => {
    const r = genericWebhookAdapter.validate({
      goal: 'x',
      budget_usdc: 'NaN',
    });
    expect(r.ok).toBe(false);
  });

  it('AC-6: budget_usdc ausente → ok (usará default)', () => {
    expect(genericWebhookAdapter.validate({ goal: 'x' })).toEqual({ ok: true });
  });

  // CD-9: never-throws sobre payloads basura.
  it.each([
    [[]],
    [null],
    [42],
    ['str'],
    [undefined],
    [true],
  ])('CD-9: validate never-throws sobre %p', (garbage) => {
    expect(() => genericWebhookAdapter.validate(garbage)).not.toThrow();
    const r = genericWebhookAdapter.validate(garbage);
    expect(r.ok).toBe(false);
  });
});

describe('genericWebhookAdapter.normalize (AC-3, AC-6, CD-9)', () => {
  it('AC-3: mapeo completo payload→NormalizedInboundTask', () => {
    const n = genericWebhookAdapter.normalize({
      goal: '  build a report  ',
      id: 'ext-42',
      budget_usdc: 3.5,
      constraints: { deadline: '2026-01-01' },
      callback_url: 'https://example.com/cb',
      artifact_url: 'https://example.com/art',
    });
    expect(n).toEqual({
      goal: 'build a report',
      externalRef: 'ext-42',
      budgetUsdc: 3.5,
      constraints: { deadline: '2026-01-01' },
      embeddedUrls: ['https://example.com/cb', 'https://example.com/art'],
      declaresExternalEscrow: false,
    });
  });

  it('AC-3: id no-string → externalRef null', () => {
    const n = genericWebhookAdapter.normalize({ goal: 'x', id: 99 });
    expect(n.externalRef).toBeNull();
  });

  it('AC-6: budget ausente → budgetUsdc null', () => {
    const n = genericWebhookAdapter.normalize({ goal: 'x' });
    expect(n.budgetUsdc).toBeNull();
  });

  it('AC-3: constraints no-object → {}', () => {
    const n = genericWebhookAdapter.normalize({ goal: 'x', constraints: 5 });
    expect(n.constraints).toEqual({});
  });

  it('AC-5: payment presente → declaresExternalEscrow true', () => {
    const n = genericWebhookAdapter.normalize({
      goal: 'x',
      payment: { amount: 10 },
    });
    expect(n.declaresExternalEscrow).toBe(true);
  });

  it('AC-5: escrow presente → declaresExternalEscrow true', () => {
    const n = genericWebhookAdapter.normalize({ goal: 'x', escrow: 'addr' });
    expect(n.declaresExternalEscrow).toBe(true);
  });

  it('AC-5: payment null → NO escrow', () => {
    const n = genericWebhookAdapter.normalize({ goal: 'x', payment: null });
    expect(n.declaresExternalEscrow).toBe(false);
  });

  it('AC-7: callback_url no-string se ignora', () => {
    const n = genericWebhookAdapter.normalize({ goal: 'x', callback_url: 12 });
    expect(n.embeddedUrls).toEqual([]);
  });

  // CD-9: never-throws + defaults seguros sobre basura.
  it.each([
    [[]],
    [null],
    [42],
    ['str'],
    [{ constraints: 5 }],
    [{ goal: [] }],
  ])('CD-9: normalize never-throws sobre %p', (garbage) => {
    expect(() => genericWebhookAdapter.normalize(garbage)).not.toThrow();
    const n = genericWebhookAdapter.normalize(garbage);
    expect(n.embeddedUrls).toEqual([]);
    expect(n.constraints).toEqual({});
  });
});

describe('getInboundAdapter (AC-8)', () => {
  it('cumple la interfaz InboundAdapter', () => {
    const a = getInboundAdapter('anything');
    expect(typeof a.validate).toBe('function');
    expect(typeof a.normalize).toBe('function');
    expect(typeof a.source).toBe('string');
  });

  it('source desconocido → adapter genérico (v1)', () => {
    expect(getInboundAdapter('unknown-platform')).toBe(genericWebhookAdapter);
  });
});
