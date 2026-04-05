/**
 * Attestation Service — Write attestations on-chain (Ozone / Kite Testnet)
 *
 * WKH-8: Attestations
 *
 * Feature flag: si ATTESTATION_CONTRACT_ADDRESS no esta configurado,
 * el servicio retorna null silenciosamente (no throw).
 *
 * Reutiliza getWalletClient() de x402-signer.ts (mismo OPERATOR_PRIVATE_KEY).
 * Solo submit (writeContract). NO llama waitForTransactionReceipt.
 */

import { getWalletClient } from '../lib/x402-signer.js'
import { ATTESTATION_ABI } from '../lib/attestation-abi.js'

// ── Tipos internos ──────────────────────────────────────────

interface AttestationWriteData {
  orchestrationId: string
  agents: string[]
  totalCostUsdc: bigint
  resultHash: `0x${string}`
}

// ── Service ─────────────────────────────────────────────────

export const attestationService = {
  /**
   * Write an attestation on-chain.
   *
   * @returns tx hash if successful, null if skipped or failed
   */
  async write(data: AttestationWriteData): Promise<string | null> {
    const contractAddress = process.env.ATTESTATION_CONTRACT_ADDRESS
    if (!contractAddress) {
      console.warn('[Attestation] ATTESTATION_CONTRACT_ADDRESS not set — skipping')
      return null
    }

    try {
      const client = getWalletClient()

      const txHash = await client.writeContract({
        chain: client.chain,
        account: client.account!,
        address: contractAddress as `0x${string}`,
        abi: ATTESTATION_ABI,
        functionName: 'attest',
        args: [
          data.orchestrationId,
          data.agents,
          data.totalCostUsdc,
          BigInt(Math.floor(Date.now() / 1000)),
          data.resultHash,
        ],
      })

      console.log(`[Attestation] tx submitted: ${txHash}`)
      return txHash
    } catch (err) {
      console.warn(
        '[Attestation] write failed:',
        err instanceof Error ? err.message : err,
      )
      return null
    }
  },
}
