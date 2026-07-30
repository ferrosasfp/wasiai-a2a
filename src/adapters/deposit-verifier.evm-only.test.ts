/**
 * WKH-315 · AC-14 / CD-5 — el landmine de `resolveTreasury` se cierra con el
 * COMPILADOR, y este archivo es la prueba de eso.
 *
 * ── QUE LANDMINE ──────────────────────────────────────────────────────────────
 *
 * `resolveTreasury('solana-devnet')` NO fallaba: era peor. Buscaba
 * `A2A_DEPOSIT_TREASURY_SOLANA`, lo testeaba contra `/^0x[0-9a-fA-F]{40}$/` — que
 * una pubkey base58 no puede pasar — y caía al fallback
 * `privateKeyToAccount(OPERATOR_PRIVATE_KEY).address`. O sea que devolvía **una
 * dirección EVM como destino esperado de un depósito Solana, en silencio**. Un
 * caller que confiara en ese valor mandaría USDC de devnet a un string que en
 * Solana no significa nada, y el gateway no tendría cómo notarlo.
 *
 * ── POR QUE EL TEST ES DE COMPILACION Y NO DE RUNTIME ────────────────────────
 *
 * Un test de runtime que afirmara "esto devuelve basura" documentaría el bug en vez
 * de cerrarlo, y no impediría que un dev futuro lo llamara igual. La garantía que
 * AC-14 pide es que el reuso ingenuo **NO COMPILE**, y eso no se puede afirmar con
 * un `expect`: se afirma con `@ts-expect-error`.
 *
 * ⚠️ COMO MATA ESTE TEST. `@ts-expect-error` es una aserción INVERTIDA: si la línea
 * de abajo **compilara**, `tsc` emitiría `Unused '@ts-expect-error' directive` y el
 * typecheck se pondría ROJO. O sea que el mutante que revierte `EvmChainKey` a
 * `ChainKey` (M18) no rompe un `expect`: rompe `npx tsc --noEmit`. Por eso el gate
 * de esta HU es el typecheck COMPLETO (incluyendo tests) y no `npm run build`, que
 * los excluye — lección de WKH-196.
 */

import { describe, expect, it } from 'vitest';
import { getChainVmFamily } from './chain-resolver.js';
import { isEvmChainKey, resolveTreasury } from './deposit-verifier.js';
import type { ChainKey } from './types.js';

/** Todos los `ChainKey` del repo. Enumerados A MANO a propósito: si alguien agrega
 * una cadena y no la suma acá, el test de exhaustividad de abajo no la cubre y hay
 * que enterarse — no seguirla en silencio desde el mapa que se está verificando. */
const ALL_CHAIN_KEYS = [
  'kite-ozone-testnet',
  'kite-mainnet',
  'avalanche-fuji',
  'avalanche-mainnet',
  'base-sepolia',
  'base-mainnet',
  'tempo-testnet',
  'solana-devnet',
] as const satisfies readonly ChainKey[];

describe('WKH-315 · AC-14 — resolveTreasury es EVM-only por tipos', () => {
  it("T-315-15 (COMPILE-TIME): `resolveTreasury('solana-devnet')` NO COMPILA", () => {
    // El cuerpo NUNCA se ejecuta (nadie invoca `neverCall`): la aserción es el
    // `@ts-expect-error`, que sólo se satisface si la línea siguiente es un error
    // de tipos. Ejecutarlo, además, leería env y devolvería la address EVM del
    // fallback — exactamente el valor que este test existe para volver inalcanzable.
    const neverCall = () => {
      // @ts-expect-error AC-14/CD-5: 'solana-devnet' NO es un EvmChainKey. Si esta
      // línea llegara a compilar, el landmine del fallback EVM estaría reabierto y
      // este directive quedaría "unused" ⇒ `tsc --noEmit` ROJO.
      return resolveTreasury('solana-devnet');
    };
    // Aserción de andamiaje: prueba que la closure existe (y por lo tanto que la
    // línea de arriba fue efectivamente type-checkeada, no eliminada por dead-code).
    expect(typeof neverCall).toBe('function');
  });

  it('T-315-15b: `resolveTreasury` SI acepta un EvmChainKey (el narrowing no rompió el camino EVM)', () => {
    // Sin esta mitad, un `EvmChainKey` mal definido (p.ej. `never`) haría pasar el
    // test de arriba sin que nada funcione.
    const saved = process.env.A2A_DEPOSIT_TREASURY_AVALANCHE;
    process.env.A2A_DEPOSIT_TREASURY_AVALANCHE =
      '0x1111111111111111111111111111111111111111';
    try {
      expect(resolveTreasury('avalanche-fuji')).toBe(
        '0x1111111111111111111111111111111111111111',
      );
    } finally {
      if (saved === undefined)
        delete process.env.A2A_DEPOSIT_TREASURY_AVALANCHE;
      else process.env.A2A_DEPOSIT_TREASURY_AVALANCHE = saved;
    }
  });

  it('T-315-15c: `isEvmChainKey` coincide con `getChainVmFamily` para TODAS las cadenas', () => {
    // El guard NO re-implementa el criterio: delega en la proyección exhaustiva y
    // PURA `getChainVmFamily`. Este test canda esa delegación — un segundo criterio
    // paralelo que divergiera sería exactamente el bug que `EvmChainKey` evita.
    for (const k of ALL_CHAIN_KEYS) {
      expect(isEvmChainKey(k), k).toBe(getChainVmFamily(k) === 'evm');
    }
  });

  it("T-315-15d: `isEvmChainKey('solana-devnet')` es false y ninguna otra cadena de hoy lo es", () => {
    expect(isEvmChainKey('solana-devnet')).toBe(false);
    const nonEvm = ALL_CHAIN_KEYS.filter((k) => !isEvmChainKey(k));
    expect(nonEvm).toEqual(['solana-devnet']);
  });
});
