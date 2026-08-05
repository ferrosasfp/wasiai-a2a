/**
 * Chain resolver tests (WKH-MULTICHAIN / 086).
 *
 * Covers normalization aliases (DT-E), priority order (DT-1 header > manifest),
 * and CD-14 / CD-19 invariants (total function, no silent fallback, safe with
 * arbitrary input).
 */
import { describe, expect, it } from 'vitest';

import { normalizeChainSlug, resolveChainKey } from '../chain-resolver.js';

describe('normalizeChainSlug', () => {
  it('maps canonical slugs to themselves', () => {
    expect(normalizeChainSlug('kite-ozone-testnet')).toBe('kite-ozone-testnet');
    expect(normalizeChainSlug('kite-mainnet')).toBe('kite-mainnet');
    expect(normalizeChainSlug('avalanche-fuji')).toBe('avalanche-fuji');
    expect(normalizeChainSlug('avalanche-mainnet')).toBe('avalanche-mainnet');
  });

  it('maps numeric chainId strings to canonical slugs', () => {
    expect(normalizeChainSlug('43113')).toBe('avalanche-fuji');
    expect(normalizeChainSlug('43114')).toBe('avalanche-mainnet');
    expect(normalizeChainSlug('2368')).toBe('kite-ozone-testnet');
    expect(normalizeChainSlug('2366')).toBe('kite-mainnet');
  });

  it('maps avalanche aliases (avalanche, fuji, avalanche-testnet) to fuji', () => {
    expect(normalizeChainSlug('avalanche')).toBe('avalanche-fuji');
    expect(normalizeChainSlug('fuji')).toBe('avalanche-fuji');
    expect(normalizeChainSlug('avalanche-testnet')).toBe('avalanche-fuji');
  });

  it('maps kite-testnet alias to kite-ozone-testnet', () => {
    expect(normalizeChainSlug('kite-testnet')).toBe('kite-ozone-testnet');
  });

  it('lowercases and trims input', () => {
    expect(normalizeChainSlug('  Avalanche-Fuji  ')).toBe('avalanche-fuji');
    expect(normalizeChainSlug('FUJI')).toBe('avalanche-fuji');
  });

  it('returns undefined for unknown slugs', () => {
    expect(normalizeChainSlug('ethereum-mainnet')).toBeUndefined();
    expect(normalizeChainSlug('polygon')).toBeUndefined();
    expect(normalizeChainSlug('1')).toBeUndefined(); // ethereum mainnet chainId
  });

  it('returns undefined for empty string', () => {
    expect(normalizeChainSlug('')).toBeUndefined();
    expect(normalizeChainSlug('   ')).toBeUndefined();
  });

  it('CD-19 — does not return values for Object prototype keys', () => {
    // Object.prototype methods must not be reachable as aliases.
    expect(normalizeChainSlug('toString')).toBeUndefined();
    expect(normalizeChainSlug('constructor')).toBeUndefined();
    expect(normalizeChainSlug('__proto__')).toBeUndefined();
    expect(normalizeChainSlug('hasOwnProperty')).toBeUndefined();
  });

  // ⚠️ La vieja DT-7 mapeaba `base` → `base-mainnet` ("convención comunidad").
  // Se revirtió por la simetría de alias ambiguos: `base` era el único alias
  // BARE que caía en dinero real mientras `avalanche`/`tempo`/`solana` caían a
  // testnet. Ver el bloque de `SLUG_ALIASES` en `chain-resolver.ts`.
  it('maps base aliases (base, base-testnet) to base-sepolia', () => {
    expect(normalizeChainSlug('base')).toBe('base-sepolia');
    expect(normalizeChainSlug('base-mainnet')).toBe('base-mainnet');
    expect(normalizeChainSlug('base-sepolia')).toBe('base-sepolia');
    expect(normalizeChainSlug('base-testnet')).toBe('base-sepolia');
  });

  it('maps Base numeric chainIds to canonical slugs', () => {
    expect(normalizeChainSlug('8453')).toBe('base-mainnet');
    expect(normalizeChainSlug('84532')).toBe('base-sepolia');
  });

  it('lowercases and trims Base input', () => {
    expect(normalizeChainSlug('  Base-Sepolia  ')).toBe('base-sepolia');
    expect(normalizeChainSlug('BASE-MAINNET')).toBe('base-mainnet');
  });

  // ── WKH-090 (AC-4): tempo-testnet aliases (estáticos, resolver puro CD-7) ──
  it('maps tempo aliases (tempo-testnet, tempo) to tempo-testnet', () => {
    expect(normalizeChainSlug('tempo-testnet')).toBe('tempo-testnet');
    expect(normalizeChainSlug('tempo')).toBe('tempo-testnet');
  });

  it('maps Tempo numeric chainId 42429 to tempo-testnet', () => {
    expect(normalizeChainSlug('42429')).toBe('tempo-testnet');
  });

  it('lowercases and trims Tempo input', () => {
    expect(normalizeChainSlug('  TEMPO  ')).toBe('tempo-testnet');
    expect(normalizeChainSlug('Tempo-Testnet')).toBe('tempo-testnet');
  });

  // CD-2: NO existe tempo-mainnet como alias.
  it('does NOT resolve tempo-mainnet (CD-2 testnet-only)', () => {
    expect(normalizeChainSlug('tempo-mainnet')).toBeUndefined();
  });

  it('returns undefined for non-string input (defensive cast)', () => {
    // Simulates careless callers passing through JSON-parsed values.
    // The TS type is `string`, but the runtime guard MUST cover non-strings
    // because TS contract is erased at runtime (CD-19).
    expect(normalizeChainSlug(undefined as unknown as string)).toBeUndefined();
    expect(normalizeChainSlug(null as unknown as string)).toBeUndefined();
    expect(normalizeChainSlug(43113 as unknown as string)).toBeUndefined();
  });
});

describe('resolveChainKey', () => {
  it('priority — header overrides manifest', () => {
    expect(
      resolveChainKey({
        headerOverride: 'avalanche-fuji',
        agentManifestChain: 'kite-ozone-testnet',
      }),
    ).toBe('avalanche-fuji');
  });

  it('priority — uses manifest when header is absent', () => {
    expect(
      resolveChainKey({
        agentManifestChain: 'avalanche-testnet',
      }),
    ).toBe('avalanche-fuji');
  });

  it('returns undefined when both are absent (caller falls back to default)', () => {
    expect(resolveChainKey({})).toBeUndefined();
  });

  it('CD-14 — header present but invalid returns undefined (NOT silent fallback)', () => {
    // The caller is responsible for translating this into a 400 response.
    expect(
      resolveChainKey({
        headerOverride: 'ethereum-mainnet',
        agentManifestChain: 'avalanche-fuji',
      }),
    ).toBeUndefined();
  });

  it('header chainId numeric resolves to canonical slug', () => {
    expect(resolveChainKey({ headerOverride: '43113' })).toBe('avalanche-fuji');
    expect(resolveChainKey({ headerOverride: '2368' })).toBe(
      'kite-ozone-testnet',
    );
  });

  it('manifest invalid returns undefined when header absent', () => {
    expect(
      resolveChainKey({ agentManifestChain: 'ethereum-mainnet' }),
    ).toBeUndefined();
  });

  it('header chainId 84532 numeric resolves to base-sepolia', () => {
    expect(resolveChainKey({ headerOverride: '84532' })).toBe('base-sepolia');
  });

  it('header chainId 8453 numeric resolves to base-mainnet', () => {
    expect(resolveChainKey({ headerOverride: '8453' })).toBe('base-mainnet');
  });

  // ── WKH-090 (AC-4 / AC-6): tempo resuelve solo por slug explícito ──
  it('header tempo-testnet resolves to tempo-testnet (priority header>manifest)', () => {
    expect(
      resolveChainKey({
        headerOverride: 'tempo-testnet',
        agentManifestChain: 'base-sepolia',
      }),
    ).toBe('tempo-testnet');
  });

  it('manifest tempo alias resolves to tempo-testnet when header absent', () => {
    expect(resolveChainKey({ agentManifestChain: 'tempo' })).toBe(
      'tempo-testnet',
    );
  });

  it('header numeric 42429 resolves to tempo-testnet', () => {
    expect(resolveChainKey({ headerOverride: '42429' })).toBe('tempo-testnet');
  });

  // AC-6: el resolver NO tiene auto-routing (costo/latencia/geografía). Solo
  // traduce el slug explícito — cubierto por la ausencia de cualquier branch
  // que no sea header > manifest.
  it('AC-6 — no auto-routing: without an explicit slug, resolver returns undefined', () => {
    expect(resolveChainKey({})).toBeUndefined();
  });
});
