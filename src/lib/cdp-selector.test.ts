/**
 * CDP Facilitator Selector tests — WKH-106 BASE-03.
 *
 * Pure function (CD-6): tests pass values explicitly, never mock env vars.
 * Coverage AC-2, AC-5, AC-7, CD-5.
 */

import { describe, expect, it } from 'vitest';
import type { ChainKey } from '../adapters/types.js';
import { selectFacilitatorUrl } from './cdp-selector.js';

describe('selectFacilitatorUrl', () => {
  const CDP_URL = 'https://x402.org/facilitator';
  const MANIFEST_URL = 'https://wasiai-facilitator.example.com';

  describe('CD-5 — Kite / Avalanche untouched (selector inactive)', () => {
    const nonBaseChains: ChainKey[] = [
      'kite-ozone-testnet',
      'kite-mainnet',
      'avalanche-fuji',
      'avalanche-mainnet',
    ];

    for (const chainKey of nonBaseChains) {
      it(`returns manifest URL for ${chainKey} even when CDP env is set (AC-7)`, () => {
        const url = selectFacilitatorUrl({
          chainKey,
          cdpFacilitatorUrl: CDP_URL,
          agentManifestFacilitatorUrl: MANIFEST_URL,
        });
        expect(url).toBe(MANIFEST_URL);
      });

      it(`returns undefined for ${chainKey} when both CDP env and manifest absent`, () => {
        const url = selectFacilitatorUrl({
          chainKey,
          cdpFacilitatorUrl: CDP_URL,
        });
        expect(url).toBeUndefined();
      });
    }
  });

  describe('AC-2 — Base chain with CDP env set → CDP URL', () => {
    const baseChains: ChainKey[] = ['base-mainnet', 'base-sepolia'];

    for (const chainKey of baseChains) {
      it(`returns CDP URL for ${chainKey} when CDP env set`, () => {
        const url = selectFacilitatorUrl({
          chainKey,
          cdpFacilitatorUrl: CDP_URL,
          agentManifestFacilitatorUrl: MANIFEST_URL,
        });
        expect(url).toBe(CDP_URL);
      });

      it(`returns CDP URL for ${chainKey} even when manifest URL absent`, () => {
        const url = selectFacilitatorUrl({
          chainKey,
          cdpFacilitatorUrl: CDP_URL,
        });
        expect(url).toBe(CDP_URL);
      });
    }
  });

  describe('AC-5 — Base chain WITHOUT CDP env → manifest URL (or undefined)', () => {
    it('returns manifest URL on base-mainnet when CDP env absent', () => {
      const url = selectFacilitatorUrl({
        chainKey: 'base-mainnet',
        agentManifestFacilitatorUrl: MANIFEST_URL,
      });
      expect(url).toBe(MANIFEST_URL);
    });

    it('returns manifest URL on base-sepolia when CDP env is empty string', () => {
      const url = selectFacilitatorUrl({
        chainKey: 'base-sepolia',
        cdpFacilitatorUrl: '',
        agentManifestFacilitatorUrl: MANIFEST_URL,
      });
      expect(url).toBe(MANIFEST_URL);
    });

    it('returns undefined on base-mainnet when both CDP env and manifest absent (adapter default applies)', () => {
      const url = selectFacilitatorUrl({ chainKey: 'base-mainnet' });
      expect(url).toBeUndefined();
    });
  });

  describe('CD-6 — purity', () => {
    it('does not mutate input', () => {
      const input = {
        chainKey: 'base-mainnet' as ChainKey,
        cdpFacilitatorUrl: CDP_URL,
        agentManifestFacilitatorUrl: MANIFEST_URL,
      };
      const snapshot = JSON.stringify(input);
      selectFacilitatorUrl(input);
      expect(JSON.stringify(input)).toBe(snapshot);
    });

    it('is deterministic — same input returns same output', () => {
      const input = {
        chainKey: 'base-sepolia' as ChainKey,
        cdpFacilitatorUrl: CDP_URL,
      };
      const a = selectFacilitatorUrl(input);
      const b = selectFacilitatorUrl(input);
      const c = selectFacilitatorUrl(input);
      expect(a).toBe(b);
      expect(b).toBe(c);
    });
  });
});
