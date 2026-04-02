/**
 * Kite Client — Singleton PublicClient para KiteAI Testnet
 *
 * Patrón: named export, singleton por módulo ES.
 * Top-level await: requiere "module": "ESNext" (ya en tsconfig).
 *
 * Exports:
 *   kiteClient         — PublicClient | null (null si KITE_RPC_URL no está configurado)
 *   requireKiteClient  — () => PublicClient (lanza si kiteClient es null)
 */
import { createPublicClient, http } from 'viem'
import type { PublicClient } from 'viem'
import { kiteTestnet } from '../lib/kite-chain.js'

/**
 * Inicializa el PublicClient.
 * El parámetro rpcUrl permite inyectar el valor en tests sin tocar process.env globalmente.
 */
async function initKiteClient(
  rpcUrl: string | undefined = process.env.KITE_RPC_URL
): Promise<PublicClient | null> {
  if (!rpcUrl) {
    console.warn('KITE_RPC_URL not set — Kite features disabled')
    return null
  }

  try {
    const client = createPublicClient({
      chain: kiteTestnet,
      transport: http(rpcUrl),
    })

    const chainId = await client.getChainId()
    console.log(`Kite Ozone Testnet connected | chainId: ${chainId}`)
    return client
  } catch (err) {
    console.error('Kite client init failed:', err)
    return null
  }
}

export const kiteClient: PublicClient | null = await initKiteClient()

/**
 * Obtiene el kiteClient o lanza un error descriptivo.
 * Usa esta función en cualquier servicio que requiera conexión activa a Kite.
 */
export function requireKiteClient(): PublicClient {
  if (!kiteClient) {
    throw new Error(
      'Kite client not initialized. Check KITE_RPC_URL env var.'
    )
  }
  return kiteClient
}
