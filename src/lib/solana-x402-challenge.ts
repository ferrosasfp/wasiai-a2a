/**
 * EL CHALLENGE SOLANA DEL 402, Y SU VERIFICACION — WKH-314.
 *
 * Puro: **cero red, cero DB, cero reloj propio salvo el que se le pasa**. Lo único que
 * lee del entorno es el secreto del HMAC, y lo lee a través de `chain.ts` (una sola
 * expresión por valor).
 *
 * ── LA REFERENCIA ES UN MAC, NO UNA FILA (DT-13) ────────────────────────────
 *
 * `reference = HMAC-SHA256(secreto, resource|payTo|amountAtomic|mint|caip2|issuedAt|expiresAt|nonce)`
 * codificado en base58 — o sea **una clave pública válida de 32 bytes**, usable como
 * cuenta de la transacción del pagador (que es lo que la hace enlazable con la tx).
 *
 * Persistir cada challenge sería **una escritura por cada 402 en una ruta pública sin
 * autenticar**: amplificación de denegación de servicio gratis, y encima con la base
 * de datos del money-path como víctima. El MAC da infalsificabilidad y expiración con
 * **cero almacenamiento**.
 *
 * ── LAS DOS COSAS QUE ESTAN PROHIBIDAS ACA ──────────────────────────────────
 *
 * 1. **PROHIBIDO comparar la referencia con `===` contra lo que mandó el cliente.**
 *    Se RE-DERIVA con el secreto del servidor y se compara en **tiempo constante**.
 *    Un `===` sobre strings sale antes en el primer byte distinto y filtra, byte a
 *    byte, cuánto acertó el atacante.
 * 2. **PROHIBIDO leer la expiración de un campo sin MAC.** `issuedAt`/`expiresAt`
 *    entran al MAC, así que un cliente que los mueva rompe la referencia y cae en
 *    `reference_mismatch`. Leer el `expiresAt` suelto del sobre sería dejar que el
 *    pagador se auto-extienda el challenge para siempre.
 *    *Esto sería falso si*: la derivación no incluyera `expiresAt` — ahí un sobre con
 *    `expiresAt: 9999999999` pasaría con una referencia legítima de hace un mes.
 * 3. **PROHIBIDO emitir dos challenges con la MISMA referencia** (WKH-314 · AR
 *    BLQ-ALTO-2). Los siete campos anteriores son todos DETERMINISTICOS: dos callers
 *    que piden un 402 por el mismo recurso, al mismo precio y en el mismo segundo
 *    recibían la misma referencia, byte a byte (medido). Y como la firma que aterriza
 *    es pública, el atacante presentaba la firma de la víctima con SU sobre y se
 *    llevaba el servicio: el ledger de uso único **no puede distinguir a los dos
 *    callers**, porque los cinco términos que compara son idénticos. Por eso hay un
 *    `nonce` CRIPTOGRAFICO por emisión, dentro del MAC.
 *    *Esto sería falso si*: el nonce saliera de un contador, del reloj, o de cualquier
 *    cosa que el atacante pueda reproducir pidiendo su propio 402.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { base58Encode } from '../adapters/solana/base58.js';
import {
  getSolanaCaip2,
  getSolanaInboundChallengeSecret,
  getSolanaInboundPayTo,
  getSolanaUsdcMint,
} from '../adapters/solana/chain.js';
import type { SolanaInboundChallenge } from '../adapters/types.js';

/**
 * Cuánto vale un challenge, en segundos.
 *
 * Constante de módulo y NO una env: una env capaz de estirar la ventana de validez es
 * una env capaz de volver eterna una referencia, y esta HU cierra su configuración en
 * tres variables a propósito.
 *
 * El número tiene que cubrir tres cosas EN SERIE: que el pagador abra la wallet y
 * firme, que la transferencia aterrice, y que llegue a `finalized` (la finalidad es
 * precondición del grant — DT-C2). 15 minutos deja margen de sobra para las tres sin
 * volver útil una referencia vieja.
 */
export const SOLANA_CHALLENGE_TTL_SECONDS = 900;

/** Qué falta para poder emitir un challenge. Nunca un `null` pelado. */
export type SolanaChallengeBuild =
  | { ok: true; challenge: SolanaInboundChallenge }
  /** Falta config. El camino no existe; NO es un rechazo del pagador. */
  | { ok: false; reason: 'not_configured'; detail: string };

/** Veredicto de la referencia que presentó el pagador (P2). */
export type SolanaChallengeVerdict =
  /** La referencia re-deriva y el challenge no venció. */
  | { state: 'valid' }
  /** No re-deriva: forjada, de otro recurso, de otro monto, o manipulada. */
  | { state: 'reference_mismatch'; detail: string }
  /** Re-deriva (o sea, la firmamos nosotros) pero ya venció. */
  | { state: 'expired'; detail: string }
  /** El sobre no trae los campos con la forma mínima para poder re-derivar. */
  | { state: 'malformed'; detail: string }
  /** Falta config del servidor. NUNCA se lee como "la referencia está bien". */
  | { state: 'not_configured'; detail: string };

/**
 * El material que entra al MAC. **UNA sola función** para derivar y para verificar:
 * si hubiera dos, un cambio en una haría que ningún pago volviera a validar (o, peor,
 * que validara uno que no debería).
 *
 * El separador es `|` y los campos no lo contienen: `resource` es una URL, los montos
 * son dígitos y las direcciones son base58. Aun así el orden es fijo y la lista es
 * cerrada, así que no hay ambigüedad de concatenación posible entre dos tuplas
 * distintas.
 */
function referenceMaterial(c: {
  resource: string;
  payTo: string;
  maxAmountRequired: string;
  mint: string;
  network: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}): string {
  return [
    c.resource,
    c.payTo,
    c.maxAmountRequired,
    c.mint,
    c.network,
    String(c.issuedAt),
    String(c.expiresAt),
    c.nonce,
  ].join('|');
}

/**
 * Bytes de entropía por emisión. 16 bytes = 128 bits: la probabilidad de que dos
 * challenges colisionen es despreciable frente a la de que colisione el HMAC mismo, y
 * la referencia sigue siendo la salida de SHA-256 (32 bytes), así que su forma no
 * cambia.
 */
const CHALLENGE_NONCE_BYTES = 16;

/**
 * El nonce del challenge. `randomBytes` (CSPRNG del sistema), **nunca** `Math.random`,
 * ni un contador, ni el reloj: lo único que este valor tiene que garantizar es que el
 * atacante no pueda reproducirlo pidiendo su propio 402.
 *
 * Se codifica en base58 por la misma razón que la referencia: el material del MAC se
 * junta con `|`, y el alfabeto base58 no lo contiene.
 */
function newChallengeNonce(): string {
  return base58Encode(new Uint8Array(randomBytes(CHALLENGE_NONCE_BYTES)));
}

/** HMAC-SHA256 → 32 bytes → base58. El resultado ES una pubkey válida. */
function deriveReference(secret: string, material: string): string {
  const mac = createHmac('sha256', secret).update(material, 'utf8').digest();
  return base58Encode(new Uint8Array(mac));
}

/**
 * Emite el challenge del 402. **El monto entra ya resuelto**: quien llama lo obtiene
 * de UNA sola resolución y se lo pasa al challenge y al binding, para que no puedan
 * divergir (CD-11).
 */
export function buildSolanaChallenge(args: {
  resource: string;
  amountAtomic: string;
  nowSeconds?: number;
}): SolanaChallengeBuild {
  const secret = getSolanaInboundChallengeSecret();
  if (secret === null) {
    return {
      ok: false,
      reason: 'not_configured',
      detail:
        'SOLANA_X402_INBOUND_CHALLENGE_SECRET is unset or shorter than the required minimum',
    };
  }
  const payTo = getSolanaInboundPayTo();
  if (payTo === null) {
    return {
      ok: false,
      reason: 'not_configured',
      detail:
        'SOLANA_X402_INBOUND_PAY_TO is unset or is not a 32-byte base58 pubkey',
    };
  }
  const issuedAt = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + SOLANA_CHALLENGE_TTL_SECONDS;
  const base = {
    network: getSolanaCaip2(),
    mint: getSolanaUsdcMint(),
    maxAmountRequired: args.amountAtomic,
    payTo,
    resource: args.resource,
    issuedAt,
    expiresAt,
    // La ÚNICA parte no determinística del challenge, y la que hace que dos callers
    // simultáneos con términos idénticos no compartan referencia (ver regla 3).
    nonce: newChallengeNonce(),
  };
  return {
    ok: true,
    challenge: {
      ...base,
      reference: deriveReference(secret, referenceMaterial(base)),
    },
  };
}

/**
 * Re-deriva la referencia con el secreto del servidor y la compara **en tiempo
 * constante** contra la que presentó el pagador; después chequea la expiración
 * **usando los timestamps que vienen del MAC**.
 *
 * ⚠️ EL ORDEN NO ES DECORATIVO. Primero la referencia, después la expiración: si se
 * chequeara la expiración antes, un sobre con timestamps inventados recibiría
 * `expired` —una respuesta sobre un challenge que este servidor nunca emitió— en vez
 * de `reference_mismatch`, que es lo que de verdad pasó.
 *
 * ⚠️ Y ESTO NO TOCA LA RED. Es la defensa barata contra el que copia una firma del
 * explorer y contra el que quiere que le paguemos el rate-limit del nodo: una
 * referencia forjada se rechaza sin gastar una sola llamada al RPC.
 */
export function verifySolanaChallengeReference(args: {
  presented: {
    reference: unknown;
    payTo: unknown;
    amountAtomic: unknown;
    mint: unknown;
    issuedAt: unknown;
    expiresAt: unknown;
    /** El eco del `extra.nonce` que publicó el 402. Entra al MAC como todo lo demás. */
    nonce: unknown;
  };
  resource: string;
  network: string;
  nowSeconds?: number;
}): SolanaChallengeVerdict {
  const secret = getSolanaInboundChallengeSecret();
  if (secret === null) {
    return {
      state: 'not_configured',
      detail:
        'SOLANA_X402_INBOUND_CHALLENGE_SECRET is unset or shorter than the required minimum',
    };
  }
  const p = args.presented;
  if (
    typeof p.reference !== 'string' ||
    typeof p.payTo !== 'string' ||
    typeof p.amountAtomic !== 'string' ||
    typeof p.mint !== 'string' ||
    typeof p.nonce !== 'string' ||
    !Number.isInteger(p.issuedAt) ||
    !Number.isInteger(p.expiresAt)
  ) {
    return {
      state: 'malformed',
      detail:
        'the payment envelope is missing a field needed to re-derive the reference (reference/payTo/amountAtomic/mint/nonce must be strings, issuedAt/expiresAt integers)',
    };
  }
  const expected = deriveReference(
    secret,
    referenceMaterial({
      resource: args.resource,
      payTo: p.payTo,
      maxAmountRequired: p.amountAtomic,
      mint: p.mint,
      network: args.network,
      issuedAt: p.issuedAt as number,
      expiresAt: p.expiresAt as number,
      nonce: p.nonce,
    }),
  );
  if (!constantTimeEquals(expected, p.reference)) {
    return {
      state: 'reference_mismatch',
      detail:
        'the presented reference does not re-derive from this server secret for these terms',
    };
  }
  // A partir de acá los timestamps son NUESTROS: los firmamos con el MAC.
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (now > (p.expiresAt as number)) {
    return {
      state: 'expired',
      detail: `the challenge expired at ${String(p.expiresAt)} (now ${now})`,
    };
  }
  return { state: 'valid' };
}

/**
 * Comparación en TIEMPO CONSTANTE de dos strings base58.
 *
 * `timingSafeEqual` **lanza** si los largos difieren, así que el largo se compara
 * antes — y esa comparación sí filtra el largo, que es público (una referencia siempre
 * es base58 de 32 bytes). Lo que no puede filtrarse es el CONTENIDO.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
