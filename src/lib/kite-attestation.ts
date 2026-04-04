/**
 * Kite Attestation — Registra orchestrationId + pipelineHash on-chain en Kite Ozone.
 *
 * No bloqueante: si falla o OPERATOR_PRIVATE_KEY no está configurada → log warning + return null.
 * Usa viem sendTransaction con calldata codificado (sin contrato específico).
 * Destino: env KITE_ATTEST_CONTRACT o address(0) como fallback.
 *
 * NUNCA loggear private key ni signature (CD-1).
 */
import { createWalletClient, http, keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { kiteTestnet } from './kite-chain.js'

// ─── Wallet Client (lazy singleton) ─────────────────────────

let _walletClient: ReturnType<typeof createWalletClient> | null = null

function getWalletClient(): ReturnType<typeof createWalletClient> {
  if (_walletClient) return _walletClient

  const pk = process.env.OPERATOR_PRIVATE_KEY
  if (!pk) {
    throw new Error('OPERATOR_PRIVATE_KEY not set — attestation disabled')
  }

  const account = privateKeyToAccount(pk as `0x${string}`)
  _walletClient = createWalletClient({
    account,
    chain: kiteTestnet,
    transport: http(process.env.KITE_RPC_URL ?? 'https://rpc-testnet.gokite.ai/'),
  })
  return _walletClient
}

// ─── Public API ───────────────────────────────────────────────

/**
 * Calcula el hash keccak256 del pipeline para usar como attestation fingerprint.
 */
export function computePipelineHash(pipeline: unknown): string {
  const json = JSON.stringify(pipeline)
  return keccak256(toHex(json))
}

/**
 * Registra orchestrationId + pipelineHash on-chain en Kite Ozone.
 *
 * Estrategia: sendTransaction con calldata = hex(`${orchestrationId}:${pipelineHash}`)
 * Contrato destino: KITE_ATTEST_CONTRACT env var, o address(0) si no configurado.
 *
 * @returns txHash si exitoso, null si falla o no hay configuración.
 */
export async function attestOrchestration(
  orchestrationId: string,
  pipelineHash: string,
): Promise<string | null> {
  try {
    const client = getWalletClient()
    const to = (process.env.KITE_ATTEST_CONTRACT as `0x${string}`) ??
      '0x0000000000000000000000000000000000000000'

    // Calldata: UTF-8 hex de "orchestrationId:pipelineHash"
    const calldata = toHex(`${orchestrationId}:${pipelineHash}`)

    const account = (client as ReturnType<typeof createWalletClient> & { account: ReturnType<typeof privateKeyToAccount> }).account
    const txHash = await client.sendTransaction({
      account,
      to,
      data: calldata,
      value: 0n,
      chain: kiteTestnet,
    })

    console.log(JSON.stringify({
      orchestrationId,
      step: 'attest-on-chain',
      timestamp: new Date().toISOString(),
      detail: {
        txHash,
        contract: to,
        explorer: `https://testnet.kitescan.ai/tx/${txHash}`,
      },
    }))

    return txHash
  } catch (err) {
    console.warn(
      '[kite-attestation] Attestation failed (non-blocking):',
      err instanceof Error ? err.message : String(err),
    )
    return null
  }
}
