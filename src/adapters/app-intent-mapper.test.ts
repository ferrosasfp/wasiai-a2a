/**
 * Tests del APP Intent Mapper (WKH-141).
 *
 * AC-3/CD-1 (no inbound): invariante estructural. Este mapper NUNCA se importa
 * desde una route handler como parser de un payload APP ajeno — es outbound-only
 * (declaración + mapeo interno). No hay endpoint que testear positivamente; el AR
 * lo verifica por inspección. Estos tests cubren pureza, allow-list (no-leak),
 * asignación condicional (CD-7) y anti-overclaim (CD-8).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APP_ALIGNMENT_DISCLAIMER,
  getSupportedAppIntents,
  mapChargeToApp,
  mapSessionToApp,
  mapUptoToApp,
} from './app-intent-mapper.js';

const FORBIDDEN_LEAK_KEYS = [
  'ownerRef',
  'buyerWallet',
  'keyId',
  'sellerRef',
  'payTo',
  'capSignature',
  'funding_wallet',
  'typedData',
  'budget',
];

describe('app-intent-mapper', () => {
  // ── AC-2: vocabulary + intent + envelopeVersion ──

  it('mapChargeToApp: known input → envelope with vocabulary/intent/version', () => {
    const env = mapChargeToApp({
      status: 'settled',
      amountUsd: 1.5,
      chainId: 84532,
      txHash: '0xabc',
    });
    expect(env.vocabulary).toBe('app');
    expect(env.intent).toBe('charge');
    expect(env.envelopeVersion).toBeTruthy();
    expect(env.amountUsd).toBe(1.5);
    expect(env.chainId).toBe(84532);
    expect(env.txHash).toBe('0xabc');
    expect(env.status).toBe('settled');
  });

  it('mapSessionToApp: known input → envelope with intent session + expiresAt', () => {
    const env = mapSessionToApp({
      status: 'in_progress',
      amountUsd: 2,
      expiresAt: '2026-07-05T00:00:00Z',
    });
    expect(env.vocabulary).toBe('app');
    expect(env.intent).toBe('session');
    expect(env.envelopeVersion).toBeTruthy();
    expect(env.expiresAt).toBe('2026-07-05T00:00:00Z');
  });

  it('mapUptoToApp: known input → envelope with intent upto', () => {
    const env = mapUptoToApp({
      status: 'settled',
      amountUsd: 5,
      chainId: 8453,
      txHash: null,
      expiresAt: '2026-07-06T00:00:00Z',
    });
    expect(env.vocabulary).toBe('app');
    expect(env.intent).toBe('upto');
    expect(env.envelopeVersion).toBeTruthy();
    expect(env.txHash).toBeNull();
    expect(env.expiresAt).toBe('2026-07-06T00:00:00Z');
  });

  // ── AC-6 / CD-3: alignment + honest disclaimer ──

  it('every envelope carries alignment:conceptual + non-empty honest disclaimer', () => {
    const envelopes = [
      mapChargeToApp({}),
      mapSessionToApp({}),
      mapUptoToApp({}),
    ];
    for (const env of envelopes) {
      expect(env.alignment).toBe('conceptual');
      expect(env.disclaimer.length).toBeGreaterThan(0);
      const lower = env.disclaimer.toLowerCase();
      expect(lower).not.toContain('certified');
      expect(lower).not.toContain('certificado');
      expect(lower).not.toContain('100%');
    }
  });

  it('the exported disclaimer constant is honest (no certified/100%)', () => {
    const lower = APP_ALIGNMENT_DISCLAIMER.toLowerCase();
    expect(lower).not.toContain('certified');
    expect(lower).not.toContain('certificado');
    expect(lower).not.toContain('100%');
  });

  // ── CD-6: allow-list, no financial owner data leaks ──

  it('no-leak: envelope never propagates forbidden owner/financial fields', () => {
    // Hostile input carrying extra sensitive fields via cast. The allow-list
    // must drop them — the envelope only carries whitelisted fields.
    const hostile = {
      status: 'settled',
      amountUsd: 1,
      chainId: 84532,
      txHash: '0xdef',
      ownerRef: 'owner-secret',
      buyerWallet: '0xbuyer',
      keyId: 'key-secret',
      sellerRef: 'seller-secret',
      payTo: '0xpay',
      capSignature: '0xsig',
      funding_wallet: '0xfund',
      typedData: { foo: 'bar' },
      budget: '9999',
      error: 'internal boom',
    } as unknown as Parameters<typeof mapChargeToApp>[0];

    for (const map of [mapChargeToApp, mapSessionToApp, mapUptoToApp]) {
      const env = map(hostile as never);
      const serialized = JSON.stringify(env);
      for (const key of FORBIDDEN_LEAK_KEYS) {
        expect(serialized).not.toContain(key);
      }
      expect(serialized).not.toContain('internal boom');
    }
  });

  // ── CD-5 / AC-2: structural purity ──

  it('purity: module source imports no infra and uses no process.env', () => {
    const src = readFileSync(
      fileURLToPath(new URL('./app-intent-mapper.ts', import.meta.url)),
      'utf8',
    );
    // Strip the module docblock (which legitimately names the forbidden libs
    // when describing the CDs) so the assertion targets real code only.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toContain('process.env');
    expect(code).not.toMatch(/from ['"](viem|node:fs|node:crypto)['"]/);
    expect(code).not.toMatch(/require\(/);
    expect(code).not.toMatch(/\bfetch\(/);
  });

  it('purity: deterministic — same input yields deep-equal output', () => {
    const input = { status: 'settled' as const, amountUsd: 3, chainId: 8453 };
    expect(mapChargeToApp(input)).toEqual(mapChargeToApp(input));
  });

  // ── CD-7: conditional assignment — absent optionals are OMITTED ──

  it('absent optionals are omitted (not enumerable) while non-optionals stay', () => {
    const env = mapChargeToApp({});
    // The 5 non-optional fields are always present.
    expect(env.vocabulary).toBe('app');
    expect(env.envelopeVersion).toBeTruthy();
    expect(env.intent).toBe('charge');
    expect(env.alignment).toBe('conceptual');
    expect(env.disclaimer).toBeTruthy();
    // Absent optionals must NOT be enumerable keys (no `x: undefined`).
    expect('status' in env).toBe(false);
    expect('amountUsd' in env).toBe(false);
    expect('chainId' in env).toBe(false);
    expect('txHash' in env).toBe(false);
    expect('expiresAt' in env).toBe(false);
  });

  it('session/upto omit expiresAt when absent', () => {
    expect('expiresAt' in mapSessionToApp({})).toBe(false);
    expect('expiresAt' in mapUptoToApp({})).toBe(false);
  });

  // ── CD-8: anti-overclaim, no escrow ──

  it('getSupportedAppIntents returns exactly charge/session/upto (no escrow)', () => {
    const intents = getSupportedAppIntents().map((d) => d.intent);
    expect(intents).toEqual(['charge', 'session', 'upto']);
    expect(intents).not.toContain('escrow');
    for (const d of getSupportedAppIntents()) {
      expect(d.alignment).toBe('conceptual');
    }
  });
});
