/**
 * WKH-314 — unit del challenge Solana (`solana-x402-challenge.ts`). T-CHAL-*.
 *
 * ── QUE MIDE ESTA SUITE ────────────────────────────────────────────────────
 *
 * La referencia es lo único que ata una transferencia on-chain a ESTE cobro. Si se
 * puede forjar, cualquier transferencia hecha a nuestra wallet por cualquier motivo
 * compra cualquier servicio. Por eso los tests de acá no miran "devuelve un string":
 * miran que un string que NO salió de nuestro secreto **no valide**, y que un
 * `expiresAt` que el cliente movió **no extienda nada**.
 *
 * ── EL GEMELO POSITIVO DE CADA NEGATIVO (CD-A4) ────────────────────────────
 *
 * Cada test que espera un rechazo tiene su gemelo que espera `valid` con el MISMO
 * fixture salvo el campo bajo prueba. Sin eso, un `verifySolanaChallengeReference` que
 * devolviera `reference_mismatch` SIEMPRE pasaría la mitad de la suite.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { base58DecodeToBytes } from '../adapters/solana/base58.js';
import { _resetSolanaChain } from '../adapters/solana/chain.js';
import {
  buildSolanaChallenge,
  SOLANA_CHALLENGE_TTL_SECONDS,
  verifySolanaChallengeReference,
} from './solana-x402-challenge.js';

const SECRET = 'a'.repeat(48);
const PAY_TO = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const RESOURCE = 'https://gw.example/compose';
const NOW = 1_700_000_000;

function setEnv(): void {
  process.env.SOLANA_X402_INBOUND_CHALLENGE_SECRET = SECRET;
  process.env.SOLANA_X402_INBOUND_PAY_TO = PAY_TO;
  process.env.SOLANA_USDC_MINT_DEVNET = MINT;
  process.env.SOLANA_CAIP2_CHAIN_ID = CAIP2;
}

/** El challenge emitido, o una explosión ruidosa: un `!` escondería el motivo. */
function issued(nowSeconds = NOW) {
  const built = buildSolanaChallenge({
    resource: RESOURCE,
    amountAtomic: '1000000',
    nowSeconds,
  });
  if (!built.ok) throw new Error(`challenge not built: ${built.detail}`);
  return built.challenge;
}

function envelopeOf(c: ReturnType<typeof issued>) {
  return {
    reference: c.reference,
    payTo: c.payTo,
    amountAtomic: c.maxAmountRequired,
    mint: c.mint,
    issuedAt: c.issuedAt,
    expiresAt: c.expiresAt,
    nonce: c.nonce,
  };
}

describe('WKH-314 · challenge Solana del 402', () => {
  beforeEach(() => {
    _resetSolanaChain();
    setEnv();
  });

  it('T-CHAL-01 · la tupla del 402 sale completa y con las formas correctas', () => {
    const c = issued();
    expect(c.network).toBe(CAIP2);
    expect(c.mint).toBe(MINT);
    // Unidades ATOMICAS, como string. Un number acá es el bug de WKH-196.
    expect(c.maxAmountRequired).toBe('1000000');
    expect(typeof c.maxAmountRequired).toBe('string');
    expect(c.payTo).toBe(PAY_TO);
    // La referencia es base58 de 32 bytes EXACTOS: o sea, una cuenta usable.
    expect(base58DecodeToBytes(c.reference)).toHaveLength(32);
    // `expiresAt` es ABSOLUTO (un instante), no una duración.
    expect(c.expiresAt).toBe(NOW + SOLANA_CHALLENGE_TTL_SECONDS);
    expect(c.issuedAt).toBe(NOW);
    // El nonce se PUBLICA (el pagador tiene que eco-repetirlo) y es base58 de 16 bytes.
    expect(base58DecodeToBytes(c.nonce)).toHaveLength(16);
  });

  it('T-CHAL-02 · la referencia cambia entre dos 402 emitidos en instantes distintos', () => {
    expect(issued(NOW).reference).not.toBe(issued(NOW + 1).reference);
  });

  it('T-CHAL-02b 💰 · dos 402 del MISMO segundo, recurso y monto dan referencias DISTINTAS', () => {
    // ⚠️ ESTE TEST AFIRMABA LO CONTRARIO, Y LA RAZON QUE LO SOSTENIA ERA FALSA. Decía
    // que la colisión era "inofensiva porque el uso único vive en la FIRMA". El AR de
    // WKH-314 (BLQ-ALTO-2) midió que **el ledger de uso único no puede distinguir a los
    // dos callers**: los cinco términos que compara el store
    // —`reference, resource, pay_to, amount_atomic, mint`— salen byte-idénticos, y la
    // firma de la víctima es pública desde que aterriza. El atacante presentaba la firma
    // ajena con SU sobre y se llevaba el servicio; la víctima recibía `PROOF_REPLAY`
    // sobre USDC que ya había transferido.
    // Por eso el material del MAC lleva un `nonce` por emisión.
    const a = issued(NOW);
    const b = issued(NOW);
    // La PRECONDICION: todo lo demás es idéntico, medido y no supuesto.
    expect(a.issuedAt).toBe(b.issuedAt);
    expect(a.maxAmountRequired).toBe(b.maxAmountRequired);
    expect(a.payTo).toBe(b.payTo);
    expect(a.mint).toBe(b.mint);
    expect(a.resource).toBe(b.resource);
    // Y lo único que cambia, que es lo que rompe el ataque.
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.reference).not.toBe(b.reference);
  });

  it('T-CHAL-02c · el `nonce` tiene entropía de verdad: 200 emisiones, 200 valores', () => {
    // Un "nonce" derivado del reloj, de un contador o de `Math.random` pasaría T-CHAL-02b
    // y seguiría siendo reproducible por el atacante. Acá se mide la propiedad que
    // importa: que no se repita, y que no sea el instante.
    const nonces = new Set<string>();
    for (let i = 0; i < 200; i++) nonces.add(issued(NOW).nonce);
    expect(nonces.size).toBe(200);
    expect([...nonces].every((n) => !n.includes(String(NOW)))).toBe(true);
  });

  it('T-CHAL-03 · el monto entra al MAC: dos montos distintos ⇒ referencias distintas', () => {
    const a = buildSolanaChallenge({
      resource: RESOURCE,
      amountAtomic: '1000000',
      nowSeconds: NOW,
    });
    const b = buildSolanaChallenge({
      resource: RESOURCE,
      amountAtomic: '2000000',
      nowSeconds: NOW,
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.challenge.reference).not.toBe(b.challenge.reference);
  });

  it('T-CHAL-04 · sin secreto no se emite challenge, y el motivo lo dice', () => {
    process.env.SOLANA_X402_INBOUND_CHALLENGE_SECRET = '';
    const built = buildSolanaChallenge({
      resource: RESOURCE,
      amountAtomic: '1',
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toBe('not_configured');
  });

  it('T-CHAL-05 · un secreto más corto que el mínimo NO alcanza (no es "hay secreto")', () => {
    process.env.SOLANA_X402_INBOUND_CHALLENGE_SECRET = 'corto';
    const built = buildSolanaChallenge({
      resource: RESOURCE,
      amountAtomic: '1',
    });
    expect(built.ok).toBe(false);
  });

  // ── La verificación ──────────────────────────────────────────────────────

  it('T-CHAL-06 · GEMELO POSITIVO: la referencia que emitimos valida', () => {
    const c = issued();
    const v = verifySolanaChallengeReference({
      presented: envelopeOf(c),
      resource: RESOURCE,
      network: CAIP2,
      nowSeconds: NOW + 5,
    });
    expect(v.state).toBe('valid');
  });

  it('T-CHAL-07 · una referencia FORJADA no valida (y no dice "expired")', () => {
    const c = issued();
    const v = verifySolanaChallengeReference({
      presented: { ...envelopeOf(c), reference: PAY_TO },
      resource: RESOURCE,
      network: CAIP2,
      nowSeconds: NOW + 5,
    });
    // El motivo importa tanto como el rechazo: `expired` sería una afirmación sobre un
    // challenge que este servidor nunca emitió.
    expect(v.state).toBe('reference_mismatch');
  });

  it('T-CHAL-08 · la MISMA referencia contra OTRO recurso no valida', () => {
    const c = issued();
    const v = verifySolanaChallengeReference({
      presented: envelopeOf(c),
      resource: 'https://gw.example/orchestrate',
      network: CAIP2,
      nowSeconds: NOW + 5,
    });
    expect(v.state).toBe('reference_mismatch');
  });

  it('T-CHAL-09 · estirar `expiresAt` en el sobre NO extiende el challenge', () => {
    const c = issued();
    const v = verifySolanaChallengeReference({
      // El cliente se auto-regala un siglo. Como `expiresAt` está DENTRO del MAC, la
      // referencia deja de re-derivar y cae acá, no en `valid`.
      presented: { ...envelopeOf(c), expiresAt: NOW + 3_000_000_000 },
      resource: RESOURCE,
      network: CAIP2,
      nowSeconds: NOW + 2_000_000,
    });
    expect(v.state).toBe('reference_mismatch');
  });

  it('T-CHAL-10 · un challenge legítimo VENCIDO da `expired`, no `reference_mismatch`', () => {
    const c = issued();
    const v = verifySolanaChallengeReference({
      presented: envelopeOf(c),
      resource: RESOURCE,
      network: CAIP2,
      nowSeconds: c.expiresAt + 1,
    });
    expect(v.state).toBe('expired');
  });

  it('T-CHAL-10b · GEMELO POSITIVO del borde: exactamente en `expiresAt` todavía vale', () => {
    const c = issued();
    const v = verifySolanaChallengeReference({
      presented: envelopeOf(c),
      resource: RESOURCE,
      network: CAIP2,
      nowSeconds: c.expiresAt,
    });
    expect(v.state).toBe('valid');
  });

  it('T-CHAL-11 · un sobre sin los campos mínimos es `malformed`, no `reference_mismatch`', () => {
    const c = issued();
    for (const broken of [
      { ...envelopeOf(c), reference: 42 },
      { ...envelopeOf(c), payTo: null },
      { ...envelopeOf(c), amountAtomic: 1000000 },
      { ...envelopeOf(c), issuedAt: '1700000000' },
      { ...envelopeOf(c), expiresAt: undefined },
      // El `nonce` es tan obligatorio como el resto: sin él no hay nada que re-derivar.
      { ...envelopeOf(c), nonce: undefined },
      { ...envelopeOf(c), nonce: 7 },
    ]) {
      const v = verifySolanaChallengeReference({
        presented: broken as never,
        resource: RESOURCE,
        network: CAIP2,
        nowSeconds: NOW,
      });
      expect(v.state).toBe('malformed');
    }
  });

  it('T-CHAL-12 · sin secreto, la verificación NUNCA dice `valid`', () => {
    const c = issued();
    process.env.SOLANA_X402_INBOUND_CHALLENGE_SECRET = '';
    const v = verifySolanaChallengeReference({
      presented: envelopeOf(c),
      resource: RESOURCE,
      network: CAIP2,
      nowSeconds: NOW,
    });
    expect(v.state).toBe('not_configured');
  });

  it('T-CHAL-13 · con OTRO secreto, una referencia legítima deja de validar', () => {
    const c = issued();
    process.env.SOLANA_X402_INBOUND_CHALLENGE_SECRET = 'b'.repeat(48);
    const v = verifySolanaChallengeReference({
      presented: envelopeOf(c),
      resource: RESOURCE,
      network: CAIP2,
      nowSeconds: NOW,
    });
    expect(v.state).toBe('reference_mismatch');
  });
});
