/**
 * Registry tests — adapter resolution (multi-chain).
 *
 * Covers:
 *   - WASIAI_A2A_CHAIN (legacy single) — backward-compat path (CD-2)
 *   - WASIAI_A2A_CHAINS (CSV) — multi-chain init
 *   - Unsupported chain → throws with full SUPPORTED list
 *   - CD-13 conflict warning when both env vars are set
 *   - New getters: getAdaptersBundle, getInitializedChainKeys, getDefaultChainKey
 *
 * Wave 0 only wires `kite-ozone-testnet`. Avalanche / mainnet branches are
 * exercised in Wave 1 / Wave 5 tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Structured logger mock ─────────────────────────────────
// registry.ts logs the init message + the CD-13 conflict warning via
// getLogger('registry'). Mock it so tests assert log emission (object-first /
// message-second) instead of spying on console. Named `loggerSpy` to avoid
// colliding with the local `logSpy` (console.log spy) some tests still declare.
const loggerSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../../lib/logger.js', () => ({
  getLogger: () => loggerSpy,
}));

// Mock the kite-ozone factory to avoid real client init.
// Shape matches the new AdaptersBundle interface.
// W5: accepts `opts?: { network?: 'testnet' | 'mainnet' }` to mirror the real
// factory signature. When `network === 'mainnet'`, returns the Kite mainnet
// bundle (chainId 2366) so the registry dispatch test can verify wiring.
//
// ⚠️ FIDELIDAD (fix-pack it2 MNR-3): este mock reproduce las DOS temporalidades
// del factory real, porque su divergencia es un bug de dinero probado con un
// probe de factories reales (2026-07-26):
//   · `chainConfig` se resuelve DENTRO del try, con `KITE_NETWORK` ya mutada por
//     `opts.network` ⇒ sigue a `opts` y, sin `opts`, a `KITE_NETWORK`.
//   · el ADAPTER lee `KITE_NETWORK` en CALL-TIME (getter `chainId` →
//     `getKiteChain()`), y el `finally` del factory YA restauró la env ⇒ con
//     `opts.network='mainnet'` y `KITE_NETWORK` ausente el adapter reporta 2368
//     (PYUSD de testnet) aunque el `chainConfig` diga 2366.
// La versión anterior del mock derivaba AMBOS de `opts`, lo que ocultaba ese
// drift inverso y daba verde a configuraciones que en real quedan rotas.
// Pinneado con el adapter real en `payment.mainnet.test.ts`.
vi.mock('../kite-ozone/index.js', () => ({
  createKiteOzoneAdapters: vi.fn(
    async (opts?: { network?: 'testnet' | 'mainnet' }) => {
      const network =
        opts?.network ??
        (process.env.KITE_NETWORK === 'mainnet' ? 'mainnet' : 'testnet');
      const chainId = network === 'mainnet' ? 2366 : 2368;
      const name = network === 'mainnet' ? 'KiteAI Mainnet' : 'KiteAI Testnet';
      const explorerUrl =
        network === 'mainnet'
          ? 'https://kitescan.ai'
          : 'https://testnet.kitescan.ai';
      return {
        payment: {
          name: 'kite-ozone',
          vmFamily: 'evm',
          // call-time, igual que el adapter real (NO congelado en el factory).
          get chainId() {
            return process.env.KITE_NETWORK === 'mainnet' ? 2366 : 2368;
          },
        },
        attestation: { name: 'kite-ozone', chainId },
        gasless: { name: 'kite-ozone', chainId },
        identity: null,
        chainConfig: { name, chainId, explorerUrl },
      };
    },
  ),
}));

// Mock the avalanche factory — returns a fuji or mainnet bundle stub depending
// on `opts.network`. Real adapters covered by avalanche.test.ts.
vi.mock('../avalanche/index.js', () => ({
  createAvalancheAdapters: vi.fn(
    async (opts?: { network?: 'fuji' | 'mainnet' }) => {
      const network = opts?.network ?? 'fuji';
      const chainId = network === 'mainnet' ? 43114 : 43113;
      const name = network === 'mainnet' ? 'Avalanche' : 'Avalanche Fuji';
      const explorerUrl =
        network === 'mainnet'
          ? 'https://snowtrace.io'
          : 'https://testnet.snowtrace.io';
      return {
        payment: { name: 'avalanche', chainId, vmFamily: 'evm' },
        attestation: { name: 'avalanche', chainId },
        gasless: { name: 'avalanche', chainId },
        identity: null,
        chainConfig: { name, chainId, explorerUrl },
      };
    },
  ),
}));

// Mock the base factory — returns a testnet or mainnet bundle stub depending
// on `opts.network`. Real adapters covered by base.test.ts.
vi.mock('../base/index.js', () => ({
  createBaseAdapters: vi.fn(
    async (opts?: { network?: 'testnet' | 'mainnet' }) => {
      const network = opts?.network ?? 'testnet';
      const chainId = network === 'mainnet' ? 8453 : 84532;
      const name = network === 'mainnet' ? 'Base' : 'Base Sepolia';
      const explorerUrl =
        network === 'mainnet'
          ? 'https://basescan.org'
          : 'https://sepolia.basescan.org';
      return {
        payment: { name: 'base', chainId, vmFamily: 'evm' },
        attestation: { name: 'base', chainId },
        gasless: { name: 'base', chainId },
        identity: null,
        chainConfig: { name, chainId, explorerUrl },
      };
    },
  ),
}));

// Mock the tempo factory — returns a testnet bundle stub (WKH-090). Real
// adapters covered by tempo.payment.contract.test.ts. Mirrors kite/base/avax.
vi.mock('../tempo/index.js', () => ({
  createTempoAdapters: vi.fn(async (_opts?: { network?: 'testnet' }) => {
    const chainId = 42429;
    return {
      payment: { name: 'tempo', chainId, vmFamily: 'evm' },
      attestation: { name: 'tempo', chainId },
      gasless: { name: 'tempo', chainId },
      identity: null,
      chainConfig: {
        name: 'Tempo Testnet',
        chainId,
        explorerUrl: 'https://explore.tempo.xyz',
      },
    };
  }),
}));

// Mock the solana factory — returns a devnet bundle stub (WKH-234). Real
// adapters covered by solana/payment.test.ts. Mirrors kite/base/avax/tempo.
vi.mock('../solana/index.js', () => ({
  createSolanaAdapters: vi.fn(async (_opts?: { network?: 'devnet' }) => ({
    payment: {
      name: 'solana',
      vmFamily: 'solana',
      caip2ChainId: 'solana:test',
    },
    attestation: { name: 'solana', chainId: 900001 },
    gasless: { name: 'solana', chainId: 900001 },
    identity: null,
    chainConfig: {
      name: 'Solana Devnet',
      chainId: 900001,
      explorerUrl: 'https://explorer.solana.com?cluster=devnet',
    },
  })),
}));

import {
  _resetRegistry,
  getAdaptersBundle,
  getAttestationAdapter,
  getChainConfig,
  getDefaultChainKey,
  getGaslessAdapter,
  getIdentityBindingAdapter,
  getInitializedChainKeys,
  getPaymentAdapter,
  initAdapters,
} from '../registry.js';

describe('adapter registry', () => {
  beforeEach(() => {
    _resetRegistry();
    vi.clearAllMocks();
    delete process.env.WASIAI_A2A_CHAIN;
    delete process.env.WASIAI_A2A_CHAINS;
    // it2 MNR-3: el mock del factory Kite es fiel a `KITE_NETWORK` (call-time),
    // así que un valor ambiente filtrado cambiaría el destino del bundle.
    delete process.env.KITE_NETWORK;
    // WKH-090 — CD-1: flag default OFF en cada test (byte-idéntico baseline).
    delete process.env.TEMPO_ADAPTER_ENABLED;
  });

  it('default WASIAI_A2A_CHAIN resolves to kite-ozone adapters', async () => {
    await initAdapters();

    const adapter = getPaymentAdapter();
    expect(adapter.name).toBe('kite-ozone');
    expect(adapter.chainId).toBe(2368);
  });

  it('unsupported chain throws error listing supported chains', async () => {
    process.env.WASIAI_A2A_CHAIN = 'ethereum-mainnet';

    await expect(initAdapters()).rejects.toThrow(
      "Unsupported chain 'ethereum-mainnet'. Supported: kite-ozone-testnet, kite-mainnet, avalanche-fuji, avalanche-mainnet, base-sepolia, base-mainnet",
    );
  });

  it('getChainConfig() returns { name, chainId, explorerUrl }', async () => {
    await initAdapters();

    const config = getChainConfig();
    expect(config).toHaveProperty('name');
    expect(config).toHaveProperty('chainId');
    expect(config).toHaveProperty('explorerUrl');
    expect(config.chainId).toBe(2368);
    expect(config.name).toBe('KiteAI Testnet');
  });

  it('get*Adapter() throws if initAdapters() not called', () => {
    expect(() => getPaymentAdapter()).toThrow('Adapters not initialized');
    expect(() => getAttestationAdapter()).toThrow('Adapters not initialized');
    expect(() => getGaslessAdapter()).toThrow('Adapters not initialized');
    expect(() => getChainConfig()).toThrow('Adapters not initialized');
  });

  it('getIdentityBindingAdapter() throws not implemented for kite-ozone', async () => {
    await initAdapters();

    expect(() => getIdentityBindingAdapter()).toThrow(
      'IdentityBindingAdapter not implemented for kite-ozone-testnet',
    );
  });

  // ─── AC-2: legacy WASIAI_A2A_CHAIN (single) preserves byte-identical behaviour ───
  describe('AC-2 — legacy single-chain backward compatibility', () => {
    it('only WASIAI_A2A_CHAIN=kite-ozone-testnet initializes a single bundle as default', async () => {
      process.env.WASIAI_A2A_CHAIN = 'kite-ozone-testnet';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual(['kite-ozone-testnet']);
      expect(getDefaultChainKey()).toBe('kite-ozone-testnet');

      const config = getChainConfig();
      expect(config).toEqual({
        name: 'KiteAI Testnet',
        chainId: 2368,
        explorerUrl: 'https://testnet.kitescan.ai',
      });
    });

    it('logs the canonical init message including the chain slug', async () => {
      loggerSpy.info.mockClear();
      process.env.WASIAI_A2A_CHAIN = 'kite-ozone-testnet';
      await initAdapters();

      // object-first / message-second: the chain keys live in the structured ctx.
      expect(loggerSpy.info).toHaveBeenCalledWith(
        { chainKeys: ['kite-ozone-testnet'] },
        'Adapters initialized',
      );
    });
  });

  // ─── AC-1: CSV multi-chain init ───
  describe('AC-1 — multi-chain CSV init', () => {
    it('WASIAI_A2A_CHAINS with a single slug initializes one bundle', async () => {
      process.env.WASIAI_A2A_CHAINS = 'kite-ozone-testnet';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual(['kite-ozone-testnet']);
      expect(getDefaultChainKey()).toBe('kite-ozone-testnet');
    });

    it('trims and lowercases CSV entries', async () => {
      process.env.WASIAI_A2A_CHAINS = '  KITE-OZONE-TESTNET  ';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual(['kite-ozone-testnet']);
    });

    it('default chain is the first CSV entry', async () => {
      process.env.WASIAI_A2A_CHAINS = 'kite-ozone-testnet';
      await initAdapters();

      expect(getDefaultChainKey()).toBe('kite-ozone-testnet');
    });

    it('logs the canonical multi-chain init message', async () => {
      loggerSpy.info.mockClear();
      process.env.WASIAI_A2A_CHAINS = 'kite-ozone-testnet';
      await initAdapters();

      expect(loggerSpy.info).toHaveBeenCalledWith(
        { chainKeys: ['kite-ozone-testnet'] },
        'Adapters initialized',
      );
    });
  });

  // ─── AC-3: unsupported chain in CSV ───
  it('AC-3 — WASIAI_A2A_CHAINS with unsupported slug throws with full list', async () => {
    process.env.WASIAI_A2A_CHAINS = 'ethereum-mainnet';

    await expect(initAdapters()).rejects.toThrow(
      "Unsupported chain 'ethereum-mainnet'. Supported: kite-ozone-testnet, kite-mainnet, avalanche-fuji, avalanche-mainnet, base-sepolia, base-mainnet",
    );
  });

  // ─── CD-13: conflict warning when both env vars are set ───
  it('CD-13 — when both env vars are set, logs WARNING and uses WASIAI_A2A_CHAINS', async () => {
    loggerSpy.warn.mockClear();
    process.env.WASIAI_A2A_CHAINS = 'kite-ozone-testnet';
    process.env.WASIAI_A2A_CHAIN = 'kite-ozone-testnet';

    await initAdapters();

    // object-first / message-second: the chosen CSV value is in the structured ctx.
    expect(loggerSpy.warn).toHaveBeenCalledWith(
      { chains: 'kite-ozone-testnet' },
      'both WASIAI_A2A_CHAINS and WASIAI_A2A_CHAIN are set. Using WASIAI_A2A_CHAINS (singular ignored)',
    );
    expect(getDefaultChainKey()).toBe('kite-ozone-testnet');
  });

  // ─── New getters introduced in W0 ───
  describe('new W0 getters', () => {
    it('getAdaptersBundle(default) returns the default bundle', async () => {
      await initAdapters();
      const bundle = getAdaptersBundle();
      expect(bundle).toBeDefined();
      expect(bundle?.chainConfig.chainId).toBe(2368);
    });

    it('getAdaptersBundle(slug) returns the matching bundle', async () => {
      await initAdapters();
      const bundle = getAdaptersBundle('kite-ozone-testnet');
      expect(bundle).toBeDefined();
      expect(bundle?.chainConfig.chainId).toBe(2368);
    });

    it('getAdaptersBundle(unknown) returns undefined (no throw)', async () => {
      await initAdapters();
      const bundle = getAdaptersBundle('avalanche-fuji');
      expect(bundle).toBeUndefined();
    });

    it('getAdaptersBundle() returns undefined before init', () => {
      const bundle = getAdaptersBundle();
      expect(bundle).toBeUndefined();
    });

    it('getInitializedChainKeys() returns slugs in CSV order', async () => {
      process.env.WASIAI_A2A_CHAINS = 'kite-ozone-testnet';
      await initAdapters();
      expect(getInitializedChainKeys()).toEqual(['kite-ozone-testnet']);
    });

    it('getDefaultChainKey() returns null before init', () => {
      expect(getDefaultChainKey()).toBeNull();
    });
  });

  // ─── W1: avalanche-fuji factory wiring ───
  describe('W1 — avalanche-fuji factory dispatch', () => {
    it('WASIAI_A2A_CHAINS=avalanche-fuji → initialized with chainId 43113', async () => {
      process.env.WASIAI_A2A_CHAINS = 'avalanche-fuji';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual(['avalanche-fuji']);
      expect(getDefaultChainKey()).toBe('avalanche-fuji');

      const config = getChainConfig();
      expect(config).toEqual({
        name: 'Avalanche Fuji',
        chainId: 43113,
        explorerUrl: 'https://testnet.snowtrace.io',
      });
    });

    it('CSV kite-ozone-testnet,avalanche-fuji → both bundles present, default = first', async () => {
      process.env.WASIAI_A2A_CHAINS = 'kite-ozone-testnet,avalanche-fuji';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual([
        'kite-ozone-testnet',
        'avalanche-fuji',
      ]);
      expect(getDefaultChainKey()).toBe('kite-ozone-testnet');

      const kite = getAdaptersBundle('kite-ozone-testnet');
      expect(kite?.chainConfig.chainId).toBe(2368);

      const fuji = getAdaptersBundle('avalanche-fuji');
      expect(fuji?.chainConfig.chainId).toBe(43113);
      expect(fuji?.chainConfig.name).toBe('Avalanche Fuji');
    });

    it('logs the canonical multi-chain init message with both slugs', async () => {
      loggerSpy.info.mockClear();
      process.env.WASIAI_A2A_CHAINS = 'kite-ozone-testnet,avalanche-fuji';
      await initAdapters();

      expect(loggerSpy.info).toHaveBeenCalledWith(
        { chainKeys: ['kite-ozone-testnet', 'avalanche-fuji'] },
        'Adapters initialized',
      );
    });

    it('getPaymentAdapter("avalanche-fuji") returns the avalanche payment adapter', async () => {
      process.env.WASIAI_A2A_CHAINS = 'kite-ozone-testnet,avalanche-fuji';
      await initAdapters();

      const adapter = getPaymentAdapter('avalanche-fuji');
      expect(adapter.name).toBe('avalanche');
      expect(adapter.chainId).toBe(43113);
    });
  });

  // ─── W5: mainnet wiring (kite-mainnet + avalanche-mainnet) ───
  describe('W5 — mainnet wiring (kite-mainnet + avalanche-mainnet)', () => {
    // it2 MNR-3: la activación COHERENTE de Kite mainnet exige el slug
    // `kite-mainnet` Y `KITE_NETWORK=mainnet` (el adapter la lee en call-time —
    // TD-NEW-KITE-PARAMS). Con el slug solo, el adapter queda en 2368/PYUSD y
    // `assertChainEnvironmentCoherent` ahora LANZA (ver T-it2-MNR-3-reg).
    beforeEach(() => {
      process.env.KITE_NETWORK = 'mainnet';
    });

    it('WASIAI_A2A_CHAINS=kite-mainnet (+KITE_NETWORK=mainnet) → initialized with chainId 2366', async () => {
      process.env.WASIAI_A2A_CHAINS = 'kite-mainnet';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual(['kite-mainnet']);
      expect(getDefaultChainKey()).toBe('kite-mainnet');

      const config = getChainConfig();
      expect(config).toEqual({
        name: 'KiteAI Mainnet',
        chainId: 2366,
        explorerUrl: 'https://kitescan.ai',
      });
    });

    it('CSV kite-mainnet,avalanche-mainnet → both bundles present, default = kite-mainnet', async () => {
      process.env.WASIAI_A2A_CHAINS = 'kite-mainnet,avalanche-mainnet';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual([
        'kite-mainnet',
        'avalanche-mainnet',
      ]);
      expect(getDefaultChainKey()).toBe('kite-mainnet');

      const kite = getAdaptersBundle('kite-mainnet');
      expect(kite?.chainConfig.chainId).toBe(2366);
      expect(kite?.chainConfig.name).toBe('KiteAI Mainnet');

      const avax = getAdaptersBundle('avalanche-mainnet');
      expect(avax?.chainConfig.chainId).toBe(43114);
      expect(avax?.chainConfig.name).toBe('Avalanche');
    });

    // ─── Fix-pack it2 BLQ-ALTO-1: fail-loud ante slug ↔ destino incoherentes ──
    // `KITE_NETWORK=mainnet` (lo instruían los dos runbooks) hace que el bundle
    // del slug `kite-ozone-testnet` — que se construye SIN `opts` — apunte a
    // chainId 2366 (Kite MAINNET, USDC.e). Ese "slug testnet en mainnet" rompía
    // DOS gates de dinero: el opt-in del leg downstream y el fail-CLOSED del
    // settle re-verify de WKH-144 (ambos clasifican por el string del slug).
    // it2 MNR-3: ya NO se simula con `mockResolvedValueOnce` — el mock del
    // factory es fiel a `KITE_NETWORK` (ver su comentario arriba), así que el
    // input lo produce el mismo mecanismo que en real (el env, no un fixture).
    it('T-it2-ALTO-1-reg: initAdapters LANZA si el bundle de un slug testnet apunta a un chainId mainnet (KITE_NETWORK=mainnet)', async () => {
      process.env.WASIAI_A2A_CHAINS = 'kite-ozone-testnet';

      await expect(initAdapters()).rejects.toThrow(
        /Incoherent chain config for 'kite-ozone-testnet'.*testnet.*mainnet.*2366/s,
      );
      // El bundle incoherente NUNCA queda alcanzable por el money-path.
      expect(getInitializedChainKeys()).toEqual([]);
    });

    it('T-it2-ALTO-1-reg-b: el arranque coherente NO rompe (kite-mainnet en 2366, chainConfig Y adapter)', async () => {
      process.env.WASIAI_A2A_CHAINS = 'kite-mainnet';
      await initAdapters();
      const bundle = getAdaptersBundle('kite-mainnet');
      expect(bundle?.chainConfig.chainId).toBe(2366);
      expect(getPaymentAdapter('kite-mainnet').chainId).toBe(2366);
    });

    // ─── it2 MNR-3: drift INVERSO (chainConfig ↔ adapter en call-time) ────────
    // El AR probó que seguir el hint viejo al pie de la letra ("no setees
    // KITE_NETWORK, agregá el slug kite-mainnet") produce un bundle roto: el
    // proceso arranca con `chainConfig.chainId=2366` (sin drift de slug) pero
    // `getPaymentAdapter('kite-mainnet').chainId === 2368` y `getToken()`
    // devuelve el PYUSD de TESTNET, porque el `finally` del factory ya restauró
    // `KITE_NETWORK` y el adapter la lee en call-time (TD-NEW-KITE-PARAMS).
    // Dirección SEGURA (el gate clasifica chainConfig ⇒ trata el leg como
    // mainnet y exige opt-in; el dinero sería testnet) ⇒ log.error ruidoso y el
    // arranque sigue. NO se convierte en throw a propósito: volvería
    // no-arrancable una config que hoy arranca (ver el comentario de
    // `assertChainEnvironmentCoherent`).
    it('T-it2-MNR-3-reg: el drift inverso (slug kite-mainnet sin KITE_NETWORK=mainnet) se LOGUEA como error y NO rompe el arranque', async () => {
      delete process.env.KITE_NETWORK;
      loggerSpy.error.mockClear();
      process.env.WASIAI_A2A_CHAINS = 'kite-mainnet';

      await initAdapters();

      expect(getInitializedChainKeys()).toEqual(['kite-mainnet']);
      expect(loggerSpy.error).toHaveBeenCalledWith(
        expect.objectContaining({
          chainKey: 'kite-mainnet',
          code: 'ADAPTER_CHAIN_ID_DRIFT',
          chainConfigChainId: 2366,
          adapterChainId: 2368,
        }),
        expect.stringContaining('MISCONFIGURED'),
      );
      // El bundle es exactamente el que el AR reportó: config mainnet, firma testnet.
      expect(getChainConfig('kite-mainnet').chainId).toBe(2366);
      expect(getPaymentAdapter('kite-mainnet').chainId).toBe(2368);
    });

    it('T-it2-MNR-3-reg-b: la remediación del log dice la VERDAD (slug + KITE_NETWORK=mainnet, sin slug testnet)', async () => {
      delete process.env.KITE_NETWORK;
      loggerSpy.error.mockClear();
      process.env.WASIAI_A2A_CHAINS = 'kite-mainnet';

      await initAdapters();

      const [ctx] = loggerSpy.error.mock.calls[0] as [{ remediation: string }];
      expect(ctx.remediation).toMatch(
        /set BOTH 'WASIAI_A2A_CHAINS=kite-mainnet'.*AND 'KITE_NETWORK=mainnet'/s,
      );
      // El hint viejo ("agregá el slug en vez de setear KITE_NETWORK") era el que
      // producía este mismo bundle roto: no puede volver.
      expect(ctx.remediation).not.toMatch(/Do NOT set KITE_NETWORK=mainnet/);
    });

    it('T-it2-MNR-3-reg-c: la coexistencia de los dos slugs Kite queda cubierta (throw con KITE_NETWORK=mainnet, drift logueado sin ella)', async () => {
      // (a) con KITE_NETWORK=mainnet el slug TESTNET apunta a 2366 → THROW.
      process.env.WASIAI_A2A_CHAINS = 'kite-ozone-testnet,kite-mainnet';
      await expect(initAdapters()).rejects.toThrow(
        /Incoherent chain config for 'kite-ozone-testnet'/,
      );

      // (b) sin KITE_NETWORK arranca, pero el rail `kite-mainnet` queda firmando
      //     en 2368 y eso se reporta (no hay config coherente para los 2 slugs
      //     a la vez — TD-NEW-KITE-PARAMS).
      _resetRegistry();
      delete process.env.KITE_NETWORK;
      loggerSpy.error.mockClear();
      await initAdapters();
      expect(loggerSpy.error).toHaveBeenCalledWith(
        expect.objectContaining({ chainKey: 'kite-mainnet' }),
        expect.stringContaining('MISCONFIGURED'),
      );
      expect(getPaymentAdapter('kite-ozone-testnet').chainId).toBe(2368);
      expect(getPaymentAdapter('kite-mainnet').chainId).toBe(2368);
    });

    // Dirección PELIGROSA (adapter mainnet + chainConfig testnet): el gate del
    // leg clasifica `chainConfig` ⇒ pasaría SIN opt-in mientras el adapter firma
    // dinero real. Hoy NINGÚN factory la produce (el registry nunca pasa
    // `{network:'testnet'}`), así que el input se construye a mano A PROPÓSITO y
    // se documenta como defensa para el próximo adapter que lea env en
    // call-time — NO como un control que hoy proteja algo alcanzable.
    it('T-it2-MNR-3-reg-d: adapter MAINNET con chainConfig testnet ⇒ LANZA (hoy inalcanzable; defensa para futuros adapters env-driven)', async () => {
      delete process.env.KITE_NETWORK;
      const { createKiteOzoneAdapters } = await import(
        '../kite-ozone/index.js'
      );
      vi.mocked(createKiteOzoneAdapters).mockResolvedValueOnce({
        payment: {
          name: 'kite-ozone',
          chainId: 2366,
          vmFamily: 'evm',
        } as unknown as Awaited<
          ReturnType<typeof createKiteOzoneAdapters>
        >['payment'],
        attestation: { name: 'kite-ozone', chainId: 2368 } as never,
        gasless: { name: 'kite-ozone', chainId: 2368 } as never,
        identity: null,
        chainConfig: {
          name: 'KiteAI Testnet',
          chainId: 2368,
          explorerUrl: 'https://testnet.kitescan.ai',
        },
      });
      process.env.WASIAI_A2A_CHAINS = 'kite-ozone-testnet';

      await expect(initAdapters()).rejects.toThrow(
        /chainConfig\.chainId is 2368 \(testnet\) but its payment adapter signs on 2366 \(MAINNET\)/,
      );
      expect(getInitializedChainKeys()).toEqual([]);
    });

    it('logs the canonical multi-chain init message with mainnet slugs', async () => {
      loggerSpy.info.mockClear();
      process.env.WASIAI_A2A_CHAINS = 'kite-mainnet,avalanche-mainnet';
      await initAdapters();

      expect(loggerSpy.info).toHaveBeenCalledWith(
        { chainKeys: ['kite-mainnet', 'avalanche-mainnet'] },
        'Adapters initialized',
      );
    });

    it('getPaymentAdapter("kite-mainnet") returns chainId 2366', async () => {
      process.env.WASIAI_A2A_CHAINS = 'kite-mainnet';
      await initAdapters();

      const adapter = getPaymentAdapter('kite-mainnet');
      expect(adapter.name).toBe('kite-ozone');
      expect(adapter.chainId).toBe(2366);
    });

    it('registry passes opts.network=mainnet to createKiteOzoneAdapters factory', async () => {
      const factoryModule = await import('../kite-ozone/index.js');
      const factorySpy = factoryModule.createKiteOzoneAdapters as ReturnType<
        typeof vi.fn
      >;
      factorySpy.mockClear();

      process.env.WASIAI_A2A_CHAINS = 'kite-mainnet';
      await initAdapters();

      expect(factorySpy).toHaveBeenCalledTimes(1);
      expect(factorySpy).toHaveBeenCalledWith({ network: 'mainnet' });
    });

    it('registry calls createKiteOzoneAdapters without opts for legacy testnet (CD-2)', async () => {
      const factoryModule = await import('../kite-ozone/index.js');
      const factorySpy = factoryModule.createKiteOzoneAdapters as ReturnType<
        typeof vi.fn
      >;
      factorySpy.mockClear();

      // El path legacy testnet exige `KITE_NETWORK` ausente (con `mainnet` el
      // bundle de este slug apunta a 2366 y el arranque LANZA — T-it2-ALTO-1-reg).
      delete process.env.KITE_NETWORK;
      process.env.WASIAI_A2A_CHAINS = 'kite-ozone-testnet';
      await initAdapters();

      expect(factorySpy).toHaveBeenCalledTimes(1);
      // The legacy testnet path MUST invoke the factory with no arguments,
      // preserving the pre-W5 byte-identical contract.
      expect(factorySpy).toHaveBeenCalledWith();
    });
  });

  // ─── WKH-104 / BASE-01: base-sepolia + base-mainnet factory dispatch ───
  describe('WKH-104 — Base factory dispatch', () => {
    it('AC-1 — WASIAI_A2A_CHAINS=base-sepolia → initialized with chainId 84532', async () => {
      process.env.WASIAI_A2A_CHAINS = 'base-sepolia';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual(['base-sepolia']);
      expect(getDefaultChainKey()).toBe('base-sepolia');

      const config = getChainConfig();
      expect(config).toEqual({
        name: 'Base Sepolia',
        chainId: 84532,
        explorerUrl: 'https://sepolia.basescan.org',
      });
    });

    it('AC-2 — WASIAI_A2A_CHAINS=base-mainnet → initialized with chainId 8453', async () => {
      process.env.WASIAI_A2A_CHAINS = 'base-mainnet';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual(['base-mainnet']);
      expect(getDefaultChainKey()).toBe('base-mainnet');

      const config = getChainConfig();
      expect(config).toEqual({
        name: 'Base',
        chainId: 8453,
        explorerUrl: 'https://basescan.org',
      });
    });

    it('registry passes opts.network=testnet to createBaseAdapters for base-sepolia', async () => {
      const factoryModule = await import('../base/index.js');
      const factorySpy = factoryModule.createBaseAdapters as ReturnType<
        typeof vi.fn
      >;
      factorySpy.mockClear();

      process.env.WASIAI_A2A_CHAINS = 'base-sepolia';
      await initAdapters();

      expect(factorySpy).toHaveBeenCalledTimes(1);
      expect(factorySpy).toHaveBeenCalledWith({ network: 'testnet' });
    });

    it('registry passes opts.network=mainnet to createBaseAdapters for base-mainnet', async () => {
      const factoryModule = await import('../base/index.js');
      const factorySpy = factoryModule.createBaseAdapters as ReturnType<
        typeof vi.fn
      >;
      factorySpy.mockClear();

      process.env.WASIAI_A2A_CHAINS = 'base-mainnet';
      await initAdapters();

      expect(factorySpy).toHaveBeenCalledTimes(1);
      expect(factorySpy).toHaveBeenCalledWith({ network: 'mainnet' });
    });

    it('CSV multi-chain con base-sepolia coexiste con kite + avalanche', async () => {
      process.env.WASIAI_A2A_CHAINS =
        'kite-ozone-testnet,avalanche-fuji,base-sepolia';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual([
        'kite-ozone-testnet',
        'avalanche-fuji',
        'base-sepolia',
      ]);
      expect(getDefaultChainKey()).toBe('kite-ozone-testnet');

      const base = getAdaptersBundle('base-sepolia');
      expect(base?.chainConfig.chainId).toBe(84532);
    });

    it('AC-6 — unsupported slug "base-typo" throws with Base in supported list', async () => {
      process.env.WASIAI_A2A_CHAINS = 'base-typo';
      await expect(initAdapters()).rejects.toThrow(
        /Supported:.*base-sepolia, base-mainnet/,
      );
    });
  });

  // ─── WKH-090 / HU-090: Tempo rail behind TEMPO_ADAPTER_ENABLED (default OFF) ───
  describe('WKH-090 — Tempo rail (flag-gated)', () => {
    afterEach(() => {
      delete process.env.TEMPO_ADAPTER_ENABLED;
    });

    // ── AC-1: flag ON + CSV incluye tempo-testnet → bundle completo, coexiste ──
    it('AC-1 — flag ON + WASIAI_A2A_CHAINS includes tempo-testnet → full bundle', async () => {
      process.env.TEMPO_ADAPTER_ENABLED = 'true';
      process.env.WASIAI_A2A_CHAINS = 'base-sepolia,tempo-testnet';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual([
        'base-sepolia',
        'tempo-testnet',
      ]);

      const tempo = getAdaptersBundle('tempo-testnet');
      expect(tempo).toBeDefined();
      expect(tempo?.payment.name).toBe('tempo');
      expect(tempo?.attestation.name).toBe('tempo');
      expect(tempo?.gasless.name).toBe('tempo');
      expect(tempo?.chainConfig.chainId).toBe(42429);

      // Los rails existentes quedan intactos (CD-6).
      const base = getAdaptersBundle('base-sepolia');
      expect(base?.chainConfig.chainId).toBe(84532);
      expect(base?.payment.name).toBe('base');
    });

    it('AC-1 — registry passes opts.network=testnet to createTempoAdapters', async () => {
      process.env.TEMPO_ADAPTER_ENABLED = 'true';
      const factoryModule = await import('../tempo/index.js');
      const factorySpy = factoryModule.createTempoAdapters as ReturnType<
        typeof vi.fn
      >;
      factorySpy.mockClear();

      process.env.WASIAI_A2A_CHAINS = 'tempo-testnet';
      await initAdapters();

      expect(factorySpy).toHaveBeenCalledTimes(1);
      expect(factorySpy).toHaveBeenCalledWith({ network: 'testnet' });
    });

    // ── AC-2: no-op byte-idéntico con flag OFF ──
    it('AC-2 — flag OFF: 6-rail CSV initializes identical to baseline; no tempo bundle', async () => {
      // Baseline: los 6 rails sin el flag.
      process.env.WASIAI_A2A_CHAINS =
        'kite-ozone-testnet,kite-mainnet,avalanche-fuji,avalanche-mainnet,base-sepolia,base-mainnet';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual([
        'kite-ozone-testnet',
        'kite-mainnet',
        'avalanche-fuji',
        'avalanche-mainnet',
        'base-sepolia',
        'base-mainnet',
      ]);
      // Tempo NO se importa ni inicializa con flag OFF.
      expect(getAdaptersBundle('tempo-testnet')).toBeUndefined();
    });

    it('AC-2 — flag OFF: createTempoAdapters is never invoked', async () => {
      const factoryModule = await import('../tempo/index.js');
      const factorySpy = factoryModule.createTempoAdapters as ReturnType<
        typeof vi.fn
      >;
      factorySpy.mockClear();

      process.env.WASIAI_A2A_CHAINS = 'base-sepolia';
      await initAdapters();

      expect(factorySpy).not.toHaveBeenCalled();
    });

    // ── AC-5: flag OFF fuerza CHAIN_NOT_SUPPORTED (double-guard) ──
    it('AC-5 — flag OFF + tempo-testnet in CSV → fail-fast boot (Unsupported chain)', async () => {
      process.env.WASIAI_A2A_CHAINS = 'tempo-testnet';
      await expect(initAdapters()).rejects.toThrow(
        /Unsupported chain 'tempo-testnet'/,
      );
    });

    it('AC-5 — flag OFF: getAdaptersBundle(tempo-testnet) is undefined (guard 2)', async () => {
      process.env.WASIAI_A2A_CHAINS = 'base-sepolia';
      await initAdapters();
      expect(getAdaptersBundle('tempo-testnet')).toBeUndefined();
    });

    it('AC-5 — flag OFF error message lists exactly the 6 baseline rails (CD-6)', async () => {
      process.env.WASIAI_A2A_CHAINS = 'tempo-testnet';
      await expect(initAdapters()).rejects.toThrow(
        "Unsupported chain 'tempo-testnet'. Supported: kite-ozone-testnet, kite-mainnet, avalanche-fuji, avalanche-mainnet, base-sepolia, base-mainnet",
      );
    });

    it('flag ON error message includes tempo-testnet in the supported list', async () => {
      process.env.TEMPO_ADAPTER_ENABLED = 'true';
      process.env.WASIAI_A2A_CHAINS = 'nonexistent-chain';
      await expect(initAdapters()).rejects.toThrow(
        /Supported:.*base-mainnet, tempo-testnet/,
      );
    });
  });

  // ─── WKH-234: Solana rail behind SOLANA_ADAPTER_ENABLED (default OFF) ───
  describe('WKH-234 — Solana rail (flag-gated)', () => {
    afterEach(() => {
      delete process.env.SOLANA_ADAPTER_ENABLED;
    });

    // ── AC-4: flag OFF → byte-idéntico, sin solana-devnet en el set soportado ──
    it('AC-4 — flag OFF: getSupportedChains excludes solana-devnet (error lists exactly the 6 baseline rails)', async () => {
      process.env.WASIAI_A2A_CHAINS = 'solana-devnet';
      await expect(initAdapters()).rejects.toThrow(
        "Unsupported chain 'solana-devnet'. Supported: kite-ozone-testnet, kite-mainnet, avalanche-fuji, avalanche-mainnet, base-sepolia, base-mainnet",
      );
    });

    it('AC-4 — flag OFF: getAdaptersBundle(solana-devnet) is undefined; createSolanaAdapters never invoked', async () => {
      const factoryModule = await import('../solana/index.js');
      const factorySpy = factoryModule.createSolanaAdapters as ReturnType<
        typeof vi.fn
      >;
      factorySpy.mockClear();

      process.env.WASIAI_A2A_CHAINS = 'base-sepolia';
      await initAdapters();

      expect(getAdaptersBundle('solana-devnet')).toBeUndefined();
      expect(factorySpy).not.toHaveBeenCalled();
    });

    // ── flag ON → bundle Solana coexiste, factory recibe network=devnet ──
    it('flag ON + WASIAI_A2A_CHAINS includes solana-devnet → full bundle, coexists with EVM', async () => {
      process.env.SOLANA_ADAPTER_ENABLED = 'true';
      const factoryModule = await import('../solana/index.js');
      const factorySpy = factoryModule.createSolanaAdapters as ReturnType<
        typeof vi.fn
      >;
      factorySpy.mockClear();

      process.env.WASIAI_A2A_CHAINS = 'base-sepolia,solana-devnet';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual([
        'base-sepolia',
        'solana-devnet',
      ]);
      const solana = getAdaptersBundle('solana-devnet');
      expect(solana).toBeDefined();
      expect(solana?.payment.name).toBe('solana');
      expect(solana?.chainConfig.chainId).toBe(900001);
      expect(factorySpy).toHaveBeenCalledWith({ network: 'devnet' });

      // EVM rail intacto (AC-4 byte-idéntico).
      const base = getAdaptersBundle('base-sepolia');
      expect(base?.chainConfig.chainId).toBe(84532);
    });

    it('flag ON error message includes solana-devnet in the supported list', async () => {
      process.env.SOLANA_ADAPTER_ENABLED = 'true';
      process.env.WASIAI_A2A_CHAINS = 'nonexistent-chain';
      await expect(initAdapters()).rejects.toThrow(
        /Supported:.*base-mainnet.*solana-devnet/,
      );
    });
  });
});
