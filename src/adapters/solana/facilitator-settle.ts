/**
 * WKH-302 (B1) — el gateway le PIDE al facilitator que firme y transmita el pago
 * SPL en Solana, en vez de firmarlo con una llave propia.
 *
 * Hoy este leg lo firma el gateway con `SOLANA_OPERATOR_PRIVATE_KEY`: una llave
 * capaz de mover fondos viviendo en un servicio que no es el facilitator. En EVM ya
 * lo hace el facilitator. Este cliente es la mitad-gateway de esa mudanza; la ruta
 * dedicada `POST /solana/payout` del facilitator es la otra mitad.
 *
 * ⚠️ POR QUÉ ESTE ARCHIVO ES CASI TODO CLASIFICACIÓN DE ERRORES (AC-10).
 *
 * Al pasar de una firma LOCAL a una llamada HTTP, este leg hereda un modo de falla
 * que antes no tenía: **una red falla de maneras en que una firma local no**. Un 502
 * de un proxy, un timeout, un cuerpo ilegible — todos pueden ocurrir DESPUÉS de que
 * el facilitator ya transmitió. Y en el catálogo de este repo `SETTLE_FAILED`
 * significa literalmente "no se pagó": dispara reembolso al buyer y/o re-envío del
 * hop. Reportar `SETTLE_FAILED` sobre una disposición desconocida es **pagar dos
 * veces por diseño**.
 *
 * De ahí la regla, con LISTA CERRADA y default al lado seguro:
 *   · Sólo los códigos de `PAYOUT_NO_SPEND_CODES` prueban que no se gastó — y esa
 *     lista coincide EXACTAMENTE con los resultados terminales en los que el
 *     facilitator LIBERA la reserva de su tope diario.
 *   · TODO lo demás es `'unknown'`: `PAYOUT_IN_PROGRESS`, `PAYOUT_BROADCAST_FAILED`,
 *     un código que no reconocemos, un cuerpo ilegible, un non-2xx sin código, un
 *     timeout. Un código nuevo que alguien agregue mañana cae solo del lado seguro.
 *
 * Espejo estructural de `settleX402` (`src/adapters/avalanche/payment.ts`).
 */

import {
  classifySettleTransportError,
  FacilitatorSettleError,
} from '../errors.js';

/** Mismo techo de wall-clock que el hop del facilitator EVM. */
const FACILITATOR_TIMEOUT_MS = 30_000;

export interface PayoutViaFacilitatorInput {
  readonly intentId: string;
  readonly payTo: string; // base58
  readonly amountAtomic: string; // decimal string
  readonly network: string; // 'solana:devnet' | 'solana:mainnet'
}

export interface PayoutViaFacilitatorResult {
  readonly signature: string;
  readonly alreadySettled: boolean;
}

/**
 * Códigos del facilitator que prueban que NO hubo gasto (§2.6 / §6.3).
 *
 * LISTA CERRADA POR CONSTRUCCIÓN: es exactamente el conjunto de resultados
 * terminales en los que el facilitator libera la reserva del tope diario. No la
 * amplíes "por si acaso": mover un código a esta lista convierte una incógnita en
 * un "no se pagó", que es el veredicto que dispara reembolso y re-envío.
 *
 * Exportada para que el test la pueda leer y para que un agregado quede visible.
 */
export const PAYOUT_NO_SPEND_CODES = new Set([
  'INVALID_PAYLOAD',
  'NETWORK_MISMATCH',
  'INVALID_AMOUNT',
  'PAYOUT_NOT_ENABLED',
  'PAYOUT_RATE_LIMITED',
  'PAYOUT_DAILY_CAP',
  'PAYOUT_FUNDING_LOW',
  'PAYOUT_RPC_UNAVAILABLE',
  'PAYOUT_STORE_UNAVAILABLE',
  'PAYOUT_INTENT_CONFLICT',
  'PAYOUT_BROADCAST_EXPIRED',
] as const);

/**
 * Error de un payout que el facilitator RECHAZÓ con un código conocido de la lista
 * de "no se gastó".
 *
 * ⚠️ `this.name = 'FacilitatorSettleError'` — SÍ, el nombre del PADRE, y es
 * deliberado. Aguas abajo la disposición se lee POR FORMA (`name` +
 * `valueDisposition`), no por `instanceof`, porque las suites que usan
 * `vi.resetModules()` obtienen otra copia de la clase y el `instanceof` daría
 * `false` justo en la decisión de dinero (ver el docstring de
 * `readSettleValueDisposition` en `adapters/errors.ts`). Si "arreglás" este nombre
 * a `'FacilitatorPayoutError'`, `readSettleValueDisposition` deja de reconocerlo y
 * todo error de payout se aplana a `SETTLE_FAILED`. `payoutCode` viaja como campo
 * extra y se lee también por forma.
 */
export class FacilitatorPayoutError extends FacilitatorSettleError {
  readonly payoutCode: string;

  constructor(message: string, payoutCode: string) {
    // Un código de la lista cerrada ⟹ el facilitator falló ANTES de firmar.
    super(message, 'not-sent');
    this.name = 'FacilitatorSettleError';
    this.payoutCode = payoutCode;
  }
}

/**
 * URL del facilitator de Solana. SIN default hardcodeado, a diferencia del de
 * Avalanche: esto apunta a una TESORERÍA. Si no hay URL configurada, el request
 * nunca salió y ésa es una disposición DEFINIDA (`'not-sent'`), no una incógnita.
 */
function getFacilitatorUrl(): string | undefined {
  const url =
    process.env.SOLANA_FACILITATOR_URL?.trim() ||
    process.env.WASIAI_FACILITATOR_URL?.trim();
  return url && url.length > 0 ? url.replace(/\/+$/, '') : undefined;
}

function getFacilitatorApiKey(): string | undefined {
  return (
    process.env.SOLANA_FACILITATOR_API_KEY?.trim() ||
    process.env.FACILITATOR_API_KEY?.trim() ||
    undefined
  );
}

/** Cuerpo de error del facilitator: `{ error: { code, message, http } }`. */
interface PayoutErrorBody {
  error?: { code?: unknown; message?: unknown };
}

/** Cuerpo 200 del facilitator (§6.2). */
interface PayoutOkBody {
  signature?: unknown;
  alreadySettled?: unknown;
}

/**
 * Pide el payout al facilitator. LANZA SIEMPRE en el camino de error (nunca
 * devuelve un "falló" implícito) para que la disposición del valor viaje tipada
 * hasta quien decide, en vez de aplanarse en un booleano.
 */
export async function payoutViaFacilitator(
  input: PayoutViaFacilitatorInput,
): Promise<PayoutViaFacilitatorResult> {
  const facilitatorUrl = getFacilitatorUrl();
  if (facilitatorUrl === undefined) {
    throw new FacilitatorSettleError(
      'SOLANA_FACILITATOR_URL is not configured — no payout request was sent',
      'not-sent',
    );
  }

  const apiKey = getFacilitatorApiKey();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let response: Response;
  try {
    response = await fetch(`${facilitatorUrl}/solana/payout`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        intentId: input.intentId,
        payTo: input.payTo,
        amountAtomic: input.amountAtomic,
        network: input.network,
      }),
      signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
    });
  } catch (err) {
    // Paso 1 — sólo ENOTFOUND/EAI_AGAIN/ECONNREFUSED/ERR_INVALID_URL prueban que
    // no se estableció el intercambio. Timeout y abort caen a 'unknown' A
    // PROPÓSITO: el request ya había salido cuando el reloj se cumplió.
    const disposition = classifySettleTransportError(err);
    throw new FacilitatorSettleError(
      `Facilitator network error on /solana/payout: ${err instanceof Error ? err.message : String(err)}`,
      disposition,
    );
  }

  // Paso 2 — cuerpo ilegible ⟹ 'unknown', CUALQUIERA sea el status. Un cuerpo que
  // no entendemos no puede emitir el veredicto más fuerte ("no se pagó").
  const body = (await response.json().catch(() => null)) as
    | (PayoutErrorBody & PayoutOkBody)
    | null;
  if (body === null) {
    throw new FacilitatorSettleError(
      `Facilitator returned HTTP ${response.status} on /solana/payout (no JSON body)`,
      'unknown',
    );
  }

  // Paso 3 — non-2xx: sólo la lista cerrada prueba que no se gastó.
  if (!response.ok) {
    const rawCode = body.error?.code;
    const code = typeof rawCode === 'string' ? rawCode : undefined;
    const message =
      typeof body.error?.message === 'string'
        ? body.error.message
        : 'no error message in body';
    if (
      code !== undefined &&
      (PAYOUT_NO_SPEND_CODES as Set<string>).has(code)
    ) {
      throw new FacilitatorPayoutError(
        `Facilitator rejected /solana/payout with ${code} (HTTP ${response.status}): ${message}`,
        code,
      );
    }
    throw new FacilitatorSettleError(
      `Facilitator returned HTTP ${response.status} on /solana/payout${
        code === undefined ? '' : ` with ${code}`
      }: ${message}`,
      'unknown',
    );
  }

  // Paso 4 — 2xx: exigimos una firma legible. Un 2xx con veredicto ilegible es
  // 'unknown', no un éxito y tampoco un fracaso.
  const signature = body.signature;
  if (typeof signature !== 'string' || signature.length === 0) {
    throw new FacilitatorSettleError(
      `Facilitator returned HTTP ${response.status} on /solana/payout without a signature`,
      'unknown',
    );
  }

  return { signature, alreadySettled: body.alreadySettled === true };
}

/**
 * Lee `payoutCode` de un error POR FORMA (nunca por `instanceof`, mismo motivo que
 * `readSettleValueDisposition`). Devuelve `undefined` si el error no lo trae.
 */
export function readPayoutCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const candidate = err as { payoutCode?: unknown };
  return typeof candidate.payoutCode === 'string'
    ? candidate.payoutCode
    : undefined;
}
