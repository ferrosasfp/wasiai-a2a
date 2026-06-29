/**
 * x402 INBOUND anti-replay — M1 (audit 2026-06-24)
 *
 * Defensa en profundidad SOBRE el nonce on-chain EIP-3009 del x402 inbound. El
 * facilitator externo ya hace anti-replay; esto agrega una segunda línea local
 * (espeja `checkAndRecordNonce` de signed-auth.ts: UNIQUE(network, nonce) →
 * 23505 = replay).
 *
 * Fail-open CONSERVADOR (documentado): si el INSERT falla por una razón distinta
 * al UNIQUE (p. ej. DB down), NO bloqueamos el pago. Justificación: el
 * `authorization.nonce` EIP-3009 ya es single-use a nivel token on-chain, así
 * que esta tabla nunca es la única defensa del replay; un blip de DB no debe
 * tumbar pagos legítimos. El evento se loguea para visibilidad.
 */

import { getLogger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';

const log = getLogger('x402-nonce');

export type X402NonceResult =
  | { kind: 'fresh' } // nonce nuevo, registrado → seguir con settle()
  | { kind: 'replay' } // (network, nonce) ya visto → rechazar (X402_REPLAY)
  | { kind: 'unavailable' }; // DB down u otro error → fail-open (no bloquear)

/**
 * Registra el `nonce` inbound para `network`. UNIQUE(network, nonce) garantiza
 * atomicidad: 23505 → ya visto (replay). Cualquier otro error de DB → fail-open
 * (`unavailable`), NUNCA throw (no debe romper un pago legítimo ante blip de DB).
 */
export async function checkAndRecordX402Nonce(
  network: string,
  nonce: string,
): Promise<X402NonceResult> {
  const { error } = await supabase
    .from('a2a_x402_nonces')
    .insert({ network, nonce });

  if (error) {
    if (error.code === '23505') return { kind: 'replay' };
    // Fail-open conservador: log + seguir. El nonce EIP-3009 on-chain sigue
    // siendo single-use; esta tabla es solo defensa en profundidad.
    log.warn(
      {
        network,
        detail: error.message,
      },
      'record failed, failing open',
    );
    return { kind: 'unavailable' };
  }
  return { kind: 'fresh' };
}
