/**
 * payment-spec-reader — unit tests del lector compartido (WKH-241).
 *
 * Módulo leaf puro: sin supabase, sin fastify, sin adapters (solo el resolver
 * puro `normalizeChainSlug`). Estos tests fijan la fidelidad de la extracción
 * (`readPayment` de `discovery.ts` movido TAL CUAL) + el criterio defensivo de
 * chain heredado de WKH-113 SEC-AR BLQ-MED-1.
 */

import { describe, expect, it } from 'vitest';
import { normalizeChainSlug } from '../adapters/chain-resolver.js';
import { readPaymentSpec } from './payment-spec-reader.js';
import { isValidPayoutWallet } from './wallet-format.js';

const EVM_PAYTO = '0x000000000000000000000000000000000000aBcD';
// pubkey base58 de 32 bytes (formato válido para la familia Solana).
const SOL_PAYTO = 'So11111111111111111111111111111111111111112';

describe('readPaymentSpec — extracción del payment spec (WKH-241)', () => {
  // ── AC-1: shape completo, chain reconocida ───────────────────────
  it('AC-1: payment con method/chain/contract y chain solana-devnet → spec expuesto', () => {
    const spec = readPaymentSpec({
      payment: {
        method: 'x402',
        chain: 'solana-devnet',
        contract: SOL_PAYTO,
        asset: 'USDC',
      },
    });
    expect(spec).toEqual({
      method: 'x402',
      chain: 'solana-devnet',
      contract: SOL_PAYTO,
      asset: 'USDC',
    });
  });

  it('AC-1: chain EVM reconocida (avalanche-fuji) pass-through', () => {
    const spec = readPaymentSpec({
      payment: { method: 'x402', chain: 'avalanche-fuji', contract: EVM_PAYTO },
    });
    expect(spec?.chain).toBe('avalanche-fuji');
    expect(spec?.contract).toBe(EVM_PAYTO);
    expect(spec?.asset).toBeUndefined();
  });

  // ── Fidelidad de la extracción movida tal cual (CD-2) ────────────
  it('preserva la normalización legacy avalanche-testnet/-mainnet → "avalanche" (CD-7)', () => {
    for (const chain of ['avalanche-testnet', 'avalanche-mainnet']) {
      const spec = readPaymentSpec({
        payment: { method: 'x402', chain, contract: EVM_PAYTO },
      });
      expect(spec?.chain).toBe('avalanche');
    }
  });

  // ── Fix-pack AR-profundo FIX 1(a): colapso NAMESPACE-aware ────────
  // El colapso comparaba STRINGS CRUDOS, así que los alias NUMÉRICOS del mismo
  // namespace escapaban: `'43114'` pasaba crudo y `downstream-payment.ts` lo
  // re-normalizaba a `avalanche-mainnet` (DINERO REAL) mientras
  // `'avalanche-mainnet'` colapsaba a `'avalanche'` → Fuji. Ahora TODO alias del
  // namespace avalanche tiene un único destino.
  it('FIX-1a: TODO alias que resuelve a avalanche-mainnet colapsa a "avalanche" (incl. el numérico 43114)', () => {
    for (const chain of [
      'avalanche-mainnet',
      '43114',
      ' 43114 ',
      'AVALANCHE-MAINNET',
    ]) {
      const spec = readPaymentSpec({
        payment: { method: 'x402', chain, contract: EVM_PAYTO },
      });
      expect(spec?.chain, `alias=${chain} debe colapsar a 'avalanche'`).toBe(
        'avalanche',
      );
      // El destino del leg downstream es el MISMO para todos ellos (Fuji): ya no
      // hay un alias que se escape a la red de dinero real.
      expect(normalizeChainSlug(spec?.chain ?? '')).toBe('avalanche-fuji');
    }
  });

  it('FIX-1a: los alias testnet del namespace avalanche NO cambian de forma (mismo destino, string crudo intacto)', () => {
    const cases: Array<[string, string]> = [
      ['avalanche-testnet', 'avalanche'], // literal legacy (byte-identidad CD-2)
      ['avalanche', 'avalanche'],
      ['avalanche-fuji', 'avalanche-fuji'],
      ['fuji', 'fuji'],
      ['43113', '43113'],
    ];
    for (const [raw, expected] of cases) {
      const spec = readPaymentSpec({
        payment: { method: 'x402', chain: raw, contract: EVM_PAYTO },
      });
      expect(spec?.chain, `chain=${raw}`).toBe(expected);
      expect(normalizeChainSlug(spec?.chain ?? '')).toBe('avalanche-fuji');
    }
  });

  it('FIX-1a: kite/base/tempo/solana siguen pass-through (cada alias ya tiene destino único)', () => {
    const cases: Array<[string, string]> = [
      ['kite-ozone-testnet', 'kite-ozone-testnet'],
      ['kite-mainnet', 'kite-mainnet'],
      ['base-sepolia', 'base-sepolia'],
      ['base-mainnet', 'base-mainnet'],
      ['8453', '8453'],
      ['tempo-testnet', 'tempo-testnet'],
      ['solana-devnet', 'solana-devnet'],
    ];
    for (const [raw, expected] of cases) {
      const spec = readPaymentSpec({
        payment: { method: 'x402', chain: raw, contract: EVM_PAYTO },
      });
      expect(spec?.chain, `chain=${raw}`).toBe(expected);
    }
  });

  it('preserva los fallbacks de schema-drift v2 (protocol → method, chain top-level)', () => {
    const spec = readPaymentSpec({
      chain: 'avalanche-testnet',
      payment: { protocol: 'x402', contract: EVM_PAYTO },
    });
    expect(spec).toEqual({
      method: 'x402',
      chain: 'avalanche',
      contract: EVM_PAYTO,
      asset: undefined,
    });
  });

  // ── AC-2: sin spec → undefined ───────────────────────────────────
  it('AC-2: sin key `payment` (o no-objeto) → undefined', () => {
    expect(readPaymentSpec({})).toBeUndefined();
    expect(readPaymentSpec({ payment: null })).toBeUndefined();
    expect(readPaymentSpec({ payment: 'x402' })).toBeUndefined();
    expect(
      readPaymentSpec({ inputSchema: {}, discoverable: true }),
    ).toBeUndefined();
  });

  it('AC-2: campos críticos ausentes (method/chain/contract) → undefined', () => {
    expect(
      readPaymentSpec({ payment: { chain: 'avalanche', contract: EVM_PAYTO } }),
    ).toBeUndefined();
    expect(
      readPaymentSpec({ payment: { method: 'x402', contract: EVM_PAYTO } }),
    ).toBeUndefined();
    expect(
      readPaymentSpec({ payment: { method: 'x402', chain: 'avalanche' } }),
    ).toBeUndefined();
  });

  // ── AC-3: chain desconocida → sin fallback silencioso ────────────
  it('AC-3: chain no resoluble por normalizeChainSlug → undefined (sin fallback a la chain default)', () => {
    for (const chain of [
      'polygon',
      'solana-mainnet',
      'not-a-chain',
      '',
      '999999',
    ]) {
      const spec = readPaymentSpec({
        payment: { method: 'x402', chain, contract: EVM_PAYTO },
      });
      expect(spec, `chain=${chain} debe ser rechazada`).toBeUndefined();
    }
  });

  // ── AC-5 (DT-3): el FORMATO del contract no se valida en read-time ─
  it('AC-5/DT-3: contract malformado se pasa tal cual (el guard de forma es settle-time)', () => {
    const bad = 'abc'; // charset base58 válido pero NO 32 bytes
    const spec = readPaymentSpec({
      payment: { method: 'x402', chain: 'solana-devnet', contract: bad },
    });
    // Read-time: pass-through (no se duplica el validador — CD-1/Scope OUT).
    expect(spec?.contract).toBe(bad);
    // Settle-time: el MISMO validador puro de familia que usa
    // `settleSolanaLeg` (downstream-payment.ts:132 → isValidSolanaAddress)
    // lo rechaza ⇒ skip-code INVALID_PAY_TO_FORMAT, sin mover fondos.
    expect(isValidPayoutWallet(bad, 'solana')).toBe(false);
    expect(isValidPayoutWallet(SOL_PAYTO, 'solana')).toBe(true);
  });
});
