/**
 * Tests para kite-client (adapter) -- WKH-5
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Structured logger mock ─────────────────────────────────
// kite-ozone/client.ts logs connect/warn/error via getLogger('kite-ozone').
// Mock it so tests assert log emission (object-first / message-second) instead
// of spying on console. hoisted so the factory can reference it; survives the
// vi.resetModules() in importKiteClient (module mock registry is not reset).
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({
  getLogger: () => logSpy,
}));

const mockGetChainId = vi.fn();

vi.mock('viem', () => ({
  createPublicClient: vi.fn(() => ({ getChainId: mockGetChainId })),
  http: vi.fn((url: string) => ({ type: 'http', url })),
  defineChain: vi.fn((chain: unknown) => chain),
}));

async function importKiteClient(rpcUrl: string | undefined) {
  vi.resetModules();
  if (rpcUrl !== undefined) {
    process.env.KITE_RPC_URL = rpcUrl;
  } else {
    delete process.env.KITE_RPC_URL;
  }
  const mod = await import('../adapters/kite-ozone/client.js');
  mod._resetClient();
  await mod.initClient(rpcUrl);
  return {
    kiteClient: mod.getClient(),
    requireKiteClient: () => mod.requireClient(),
  };
}

describe('kite-client', () => {
  const ORIGINAL_ENV = process.env.KITE_RPC_URL;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (ORIGINAL_ENV !== undefined) {
      process.env.KITE_RPC_URL = ORIGINAL_ENV;
    } else {
      delete process.env.KITE_RPC_URL;
    }
    vi.restoreAllMocks();
  });

  it('AC-1: inicializa kiteClient automaticamente al importar el modulo', async () => {
    mockGetChainId.mockResolvedValue(2368);
    const { kiteClient } = await importKiteClient(
      'https://rpc-testnet.gokite.ai/',
    );
    expect(kiteClient).not.toBeNull();
  });

  it('AC-2: exporta el mismo singleton en importaciones multiples', async () => {
    mockGetChainId.mockResolvedValue(2368);
    const mod1 = await importKiteClient('https://rpc-testnet.gokite.ai/');
    const mod2 = await import('../adapters/kite-ozone/client.js');
    expect(mod1.kiteClient).toBe(mod2.getClient());
  });

  it('AC-3: loguea "Kite Ozone Testnet connected" con chainId 2368 cuando conecta', async () => {
    mockGetChainId.mockResolvedValue(2368);
    await importKiteClient('https://rpc-testnet.gokite.ai/');
    // object-first / message-second: chainId lives in the structured context.
    expect(logSpy.info).toHaveBeenCalledWith(
      { chainId: 2368 },
      'Kite Ozone Testnet connected',
    );
  });

  it('AC-4: kiteClient es null y loguea warning cuando KITE_RPC_URL no esta configurado', async () => {
    const { kiteClient } = await importKiteClient(undefined);
    expect(kiteClient).toBeNull();
    expect(logSpy.warn).toHaveBeenCalledWith(
      'KITE_RPC_URL not set — Kite features disabled',
    );
  });

  it('AC-5: cuando la conexion RPC falla, kiteClient es null y loguea el error sin crashear', async () => {
    const rpcError = new Error('connection refused');
    mockGetChainId.mockRejectedValue(rpcError);
    const { kiteClient } = await importKiteClient(
      'https://rpc-testnet.gokite.ai/',
    );
    expect(kiteClient).toBeNull();
    // object-first / message-second: the error lives in the structured context.
    expect(logSpy.error).toHaveBeenCalledWith(
      { err: rpcError },
      'Kite client init failed',
    );
  });

  it('AC-6: kiteClient.getChainId() retorna 2368', async () => {
    mockGetChainId.mockResolvedValue(2368);
    const { kiteClient } = await importKiteClient(
      'https://rpc-testnet.gokite.ai/',
    );
    expect(kiteClient).not.toBeNull();
    const chainId = await kiteClient?.getChainId();
    expect(chainId).toBe(2368);
    expect(typeof chainId).toBe('number');
  });

  it('requireKiteClient() retorna el cliente cuando esta inicializado', async () => {
    mockGetChainId.mockResolvedValue(2368);
    const { requireKiteClient } = await importKiteClient(
      'https://rpc-testnet.gokite.ai/',
    );
    expect(() => requireKiteClient()).not.toThrow();
    expect(requireKiteClient()).not.toBeNull();
  });

  it('requireKiteClient() lanza Error cuando kiteClient es null', async () => {
    const { requireKiteClient } = await importKiteClient(undefined);
    expect(() => requireKiteClient()).toThrow(
      'Kite client not initialized. Call initAdapters() first.',
    );
  });
});
