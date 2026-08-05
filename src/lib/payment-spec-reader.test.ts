/**
 * payment-spec-reader — unit tests del lector compartido (WKH-241).
 *
 * Módulo leaf puro: sin supabase, sin fastify, sin adapters (solo el resolver
 * puro `normalizeChainSlug`). Estos tests fijan la fidelidad de la extracción
 * (`readPayment` de `discovery.ts` movido TAL CUAL) + el criterio defensivo de
 * chain heredado de WKH-113 SEC-AR BLQ-MED-1.
 */

import { describe, expect, it } from 'vitest';
import {
  isAmbiguousChainAlias,
  normalizeChainSlug,
} from '../adapters/chain-resolver.js';
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

  // ── TD-CHAIN-ALIAS-AMBIGUO: el colapso legacy CD-2 se ELIMINÓ ─────
  // Antes, este literal explícito se reescribía a `'avalanche'` (el alias
  // AMBIGUO), y eso hacía que un agente que declaró bien su entorno se contara
  // como ambiguo en `downstream-payment.ts` — bloqueando la segunda mitad de la
  // postura C (rechazar los ambiguos habría rechazado a los que hicieron lo
  // correcto). El destino NO cambia: los dos normalizan a `avalanche-fuji`.
  it('TD-CHAIN-ALIAS-AMBIGUO: avalanche-testnet sale TAL CUAL (el colapso legacy CD-2 ya no existe)', () => {
    const spec = readPaymentSpec({
      payment: {
        method: 'x402',
        chain: 'avalanche-testnet',
        contract: EVM_PAYTO,
      },
    });
    expect(spec?.chain).toBe('avalanche-testnet');
    // El destino del leg es el MISMO que antes del cambio.
    expect(normalizeChainSlug(spec?.chain ?? '')).toBe('avalanche-fuji');
    // Y deja de contarse como ambiguo, que es el punto del arreglo.
    expect(isAmbiguousChainAlias(spec?.chain ?? '')).toBe(false);
  });

  // ── Fix-pack it2 BLQ-MED-1: los alias MAINNET NO colapsan ─────────
  // ⚠️ CAMBIO INTENCIONAL DE API OBSERVABLE (`/discover`). La iteración anterior
  // colapsaba TODO alias mainnet del namespace a `'avalanche'` (destino Fuji), y
  // eso volvía INEJERCITABLE el opt-in `WASIAI_DOWNSTREAM_MAINNET_ALLOW=avalanche-mainnet`
  // documentado en README/.env.example/docs/networks.md + los 2 runbooks: como
  // este lector es el ÚNICO productor de `Agent.payment`, ningún valor declarable
  // por un agente podía producir `chainKey='avalanche-mainnet'` en el leg. Ahora
  // el reader reporta con fidelidad y el ÚNICO choke-point que decide si se puede
  // pagar en mainnet es el gate fail-CLOSED de `downstream-payment.ts`.
  it('BLQ-MED-1: los alias MAINNET del namespace avalanche salen como su ChainKey (NO colapsan a "avalanche")', () => {
    for (const chain of [
      'avalanche-mainnet',
      '43114',
      ' 43114 ',
      'AVALANCHE-MAINNET',
    ]) {
      const spec = readPaymentSpec({
        payment: { method: 'x402', chain, contract: EVM_PAYTO },
      });
      expect(spec?.chain, `alias=${chain}`).toBe('avalanche-mainnet');
      // Y el leg resuelve a la mainnet REAL → el gate la ve y el opt-in es
      // ejercitable (antes resolvía a Fuji para todos ellos).
      expect(normalizeChainSlug(spec?.chain ?? '')).toBe('avalanche-mainnet');
    }
  });

  it('FIX-1a: los alias testnet del namespace avalanche NO cambian de forma (mismo destino, string crudo intacto)', () => {
    const cases: Array<[string, string]> = [
      ['avalanche-testnet', 'avalanche-testnet'], // sin colapso (TD-CHAIN-ALIAS-AMBIGUO)
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
      chain: 'avalanche-testnet',
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
