/**
 * Tests para attestation service — WKH-8
 * Patron: vi.mock para interceptar x402-signer + attestation-abi
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ──────────────────────────────────────────────────────────────
// Mocks — ANTES del import del modulo bajo test
// ──────────────────────────────────────────────────────────────
const mockWriteContract = vi.fn()

vi.mock('../lib/x402-signer.js', () => ({
  getWalletClient: vi.fn(() => ({
    writeContract: mockWriteContract,
  })),
}))

vi.mock('../lib/attestation-abi.js', () => ({
  ATTESTATION_ABI: [],
}))

// ──────────────────────────────────────────────────────────────
// Import del modulo bajo test (DESPUES de los mocks)
// ──────────────────────────────────────────────────────────────
import { attestationService } from './attestation.js'
import { getWalletClient } from '../lib/x402-signer.js'

// ──────────────────────────────────────────────────────────────
// Test data helper
// ──────────────────────────────────────────────────────────────
function makeWriteData() {
  return {
    orchestrationId: 'test-orch-uuid-1234',
    agents: ['agent-alpha', 'agent-beta'],
    totalCostUsdc: BigInt(1_500_000), // 1.5 USDC
    resultHash: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as `0x${string}`,
  }
}

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────
describe('attestation service', () => {
  const ORIGINAL_CONTRACT = process.env.ATTESTATION_CONTRACT_ADDRESS

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.ATTESTATION_CONTRACT_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678'
  })

  afterEach(() => {
    if (ORIGINAL_CONTRACT !== undefined) {
      process.env.ATTESTATION_CONTRACT_ADDRESS = ORIGINAL_CONTRACT
    } else {
      delete process.env.ATTESTATION_CONTRACT_ADDRESS
    }
    vi.restoreAllMocks()
  })

  // ─── T1: Happy path ─────────────────────────────────────
  it('write() retorna txHash cuando writeContract resuelve exitosamente', async () => {
    const expectedHash = '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'
    mockWriteContract.mockResolvedValue(expectedHash)

    const result = await attestationService.write(makeWriteData())

    expect(result).toBe(expectedHash)
    expect(mockWriteContract).toHaveBeenCalledOnce()
    expect(mockWriteContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: '0x1234567890abcdef1234567890abcdef12345678',
        functionName: 'attest',
        args: expect.arrayContaining([
          'test-orch-uuid-1234',
          ['agent-alpha', 'agent-beta'],
          BigInt(1_500_000),
        ]),
      }),
    )
  })

  // ─── T2: Feature flag OFF ────────────────────────────────
  it('write() retorna null cuando ATTESTATION_CONTRACT_ADDRESS no esta configurado', async () => {
    delete process.env.ATTESTATION_CONTRACT_ADDRESS

    const result = await attestationService.write(makeWriteData())

    expect(result).toBeNull()
    expect(mockWriteContract).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('ATTESTATION_CONTRACT_ADDRESS'),
    )
  })

  // ─── T3: writeContract failure ───────────────────────────
  it('write() retorna null y loguea warning cuando writeContract falla', async () => {
    mockWriteContract.mockRejectedValue(new Error('execution reverted'))

    const result = await attestationService.write(makeWriteData())

    expect(result).toBeNull()
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('write failed'),
      expect.stringContaining('execution reverted'),
    )
  })

  // ─── T4: getWalletClient throws ─────────────────────────
  it('write() retorna null cuando getWalletClient lanza error', async () => {
    vi.mocked(getWalletClient).mockImplementationOnce(() => {
      throw new Error('OPERATOR_PRIVATE_KEY not set')
    })

    const result = await attestationService.write(makeWriteData())

    expect(result).toBeNull()
    expect(console.warn).toHaveBeenCalled()
  })
})
