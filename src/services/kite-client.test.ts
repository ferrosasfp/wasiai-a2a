/**
 * Tests para kite-client.ts — WKH-5
 * Cubre los 6 ACs de la HU.
 *
 * Estrategia: vi.mock intercepta 'viem' para que createPublicClient
 * retorne un cliente mockeado — sin llamadas RPC reales.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ──────────────────────────────────────────────────────────────
// Mock de viem — debe estar ANTES del import del módulo bajo test
// ──────────────────────────────────────────────────────────────
const mockGetChainId = vi.fn()

vi.mock('viem', () => ({
  createPublicClient: vi.fn(() => ({
    getChainId: mockGetChainId,
  })),
  http: vi.fn((url: string) => ({ type: 'http', url })),
  defineChain: vi.fn((chain: unknown) => chain),
}))

// ──────────────────────────────────────────────────────────────
// Helper para reimportar el módulo con env vars controladas.
// Necesario porque kite-client.ts usa top-level await —
// el módulo se evalúa una vez por import. resetModules fuerza
// re-evaluación para cada test.
// ──────────────────────────────────────────────────────────────
async function importKiteClient(rpcUrl: string | undefined) {
  vi.resetModules()

  // Re-registrar el mock de viem después del resetModules
  vi.mock('viem', () => ({
    createPublicClient: vi.fn(() => ({
      getChainId: mockGetChainId,
    })),
    http: vi.fn((url: string) => ({ type: 'http', url })),
    defineChain: vi.fn((chain: unknown) => chain),
  }))

  if (rpcUrl !== undefined) {
    process.env.KITE_RPC_URL = rpcUrl
  } else {
    delete process.env.KITE_RPC_URL
  }

  return import('./kite-client.js')
}

// ──────────────────────────────────────────────────────────────

describe('kite-client', () => {
  const ORIGINAL_ENV = process.env.KITE_RPC_URL

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    if (ORIGINAL_ENV !== undefined) {
      process.env.KITE_RPC_URL = ORIGINAL_ENV
    } else {
      delete process.env.KITE_RPC_URL
    }
    vi.restoreAllMocks()
  })

  // AC-1: kiteClient se inicializa automáticamente al importar
  it('AC-1: inicializa kiteClient automáticamente al importar el módulo', async () => {
    mockGetChainId.mockResolvedValue(2368)

    const { kiteClient } = await importKiteClient('https://rpc-testnet.gokite.ai/')

    expect(kiteClient).not.toBeNull()
  })

  // AC-2: Singleton — misma instancia para todos los importadores
  it('AC-2: exporta el mismo singleton en importaciones múltiples', async () => {
    mockGetChainId.mockResolvedValue(2368)

    const mod1 = await importKiteClient('https://rpc-testnet.gokite.ai/')
    // Segunda importación usa el módulo ya cacheado — misma instancia
    const mod2 = await import('./kite-client.js')

    expect(mod1.kiteClient).toBe(mod2.kiteClient)
  })

  // AC-3: Log correcto al conectar exitosamente
  it('AC-3: loguea "Kite Ozone Testnet connected | chainId: 2368" cuando conecta', async () => {
    mockGetChainId.mockResolvedValue(2368)

    await importKiteClient('https://rpc-testnet.gokite.ai/')

    expect(console.log).toHaveBeenCalledWith(
      'Kite Ozone Testnet connected | chainId: 2368'
    )
  })

  // AC-4: kiteClient es null y warn cuando KITE_RPC_URL no está
  it('AC-4: kiteClient es null y loguea warning cuando KITE_RPC_URL no está configurado', async () => {
    const { kiteClient } = await importKiteClient(undefined)

    expect(kiteClient).toBeNull()
    expect(console.warn).toHaveBeenCalledWith(
      'KITE_RPC_URL not set — Kite features disabled'
    )
  })

  // AC-5: Fallo de conexión — kiteClient es null, no crashea el servidor
  it('AC-5: cuando la conexión RPC falla, kiteClient es null y loguea el error sin crashear', async () => {
    const rpcError = new Error('connection refused')
    mockGetChainId.mockRejectedValue(rpcError)

    const { kiteClient } = await importKiteClient('https://rpc-testnet.gokite.ai/')

    expect(kiteClient).toBeNull()
    expect(console.error).toHaveBeenCalledWith(
      'Kite client init failed:',
      rpcError
    )
  })

  // AC-6: getChainId retorna 2368
  it('AC-6: kiteClient.getChainId() retorna 2368', async () => {
    mockGetChainId.mockResolvedValue(2368)

    const { kiteClient } = await importKiteClient('https://rpc-testnet.gokite.ai/')

    expect(kiteClient).not.toBeNull()
    const chainId = await kiteClient!.getChainId()
    expect(chainId).toBe(2368)
    expect(typeof chainId).toBe('number')
  })

  // requireKiteClient — happy path
  it('requireKiteClient() retorna el cliente cuando está inicializado', async () => {
    mockGetChainId.mockResolvedValue(2368)

    const { requireKiteClient } = await importKiteClient('https://rpc-testnet.gokite.ai/')

    expect(() => requireKiteClient()).not.toThrow()
    expect(requireKiteClient()).not.toBeNull()
  })

  // requireKiteClient — error cuando kiteClient es null
  it('requireKiteClient() lanza Error cuando kiteClient es null', async () => {
    const { requireKiteClient } = await importKiteClient(undefined)

    expect(() => requireKiteClient()).toThrow(
      'Kite client not initialized. Check KITE_RPC_URL env var.'
    )
  })
})
