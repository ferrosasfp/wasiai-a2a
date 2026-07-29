/**
 * Caller Scope — HU-208 · lectura SOLO-LECTURA del alcance de la credencial,
 * disponible ANTES del middleware de pago.
 *
 * ─── El problema de orden que resuelve ───────────────────────────────────
 * La resolución por capacidad tiene que ocurrir ANTES de `requirePaymentOrA2AKey`
 * (ahí se cotiza el precio del pipeline y se debita el step-0: si resolviéramos
 * después, el llamador pagaría por un pipeline y recibiría otro — ver el
 * docstring de `ResolvedComposeStep`). Pero el alcance de la credencial es
 * justamente lo que ESE middleware resuelve y deja en `request.a2aKeyRow`, así
 * que en el momento en que hay que elegir el agente todavía no existe.
 *
 * Este módulo hace la lectura por adelantado, SIN debitar, SIN resolver chain,
 * SIN responder nada.
 *
 * ─── Por qué esto no duplica la autenticación ────────────────────────────
 * No re-implementa el cálculo del alcance: reusa los MISMOS builders puros que
 * usa el middleware (`buildDelegationEffectiveRow` / `buildSessionEffectiveRow`,
 * exportados en `middleware/a2a-key.ts` justamente como "fuente única", WKH-173
 * DT-B) sobre los MISMOS lookups. Si el cálculo del alcance efectivo cambia, este
 * archivo cambia con él porque llama al mismo código.
 *
 * ─── ⚠️ INVARIANTE DE SEGURIDAD: esto NO autoriza nada ───────────────────
 * Lo que devuelve alimenta un FILTRO DE CANDIDATOS, no una decisión de acceso. El
 * alcance se sigue HACIENDO CUMPLIR donde siempre: `authzService.checkScoping`
 * dentro de `composeService.compose`, post-resolveAgent, que esta HU no toca.
 *
 * De ahí que fallar acá sea seguro y por eso todos los caminos de error devuelven
 * `undefined` (sin filtro) en vez de rechazar:
 *   · si devuelve el alcance correcto → el mejor candidato ALCANZABLE;
 *   · si devuelve `undefined` o algo desactualizado → se elige el mejor global y
 *     el ejecutor lo rechaza con 403, que es EXACTAMENTE el comportamiento
 *     anterior a esta HU.
 * En ninguna rama puede CONCEDER acceso a un agente fuera de alcance. Un fallo de
 * este módulo degrada la ergonomía, nunca la autorización.
 *
 * Tampoco valida la credencial (revocada, expirada, sin saldo): de eso se ocupa
 * el middleware inmediatamente después, y adelantar esos rechazos acá duplicaría
 * la política de auth en dos lugares.
 */

import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import {
  buildDelegationEffectiveRow,
  buildSessionEffectiveRow,
  extractRawKey,
} from '../middleware/a2a-key.js';
import type { A2AAgentKeyRow } from '../types/index.js';
import { delegationService } from './delegation.js';
import { identityService } from './identity.js';
import { keySessionService } from './key-session.js';

function sha256Hex(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Devuelve la fila EFECTIVA de la credencial del llamador, o `undefined` si no
 * hay credencial (llamador x402 anónimo → sin alcance que aplicar) o si no se
 * puede leer.
 *
 * Espeja el dispatch del middleware: `wasi_a2a_session_*` (delegación) >
 * `wasi_a2a_sess_*` (key-session) > master. Los prefijos son mutuamente
 * excluyentes en ese orden (`'wasi_a2a_session_x'.startsWith('wasi_a2a_sess_')`
 * es `false`), igual que en `requirePaymentOrA2AKey`.
 */
export async function resolveCallerScope(
  request: FastifyRequest,
): Promise<A2AAgentKeyRow | undefined> {
  // Si el middleware ya corrió (no es el caso en la cadena de `/compose`, pero
  // sí lo sería si alguien reordena), su fila manda: es la autoritativa.
  if (request.a2aKeyRow) return request.a2aKeyRow;

  const rawKey = extractRawKey(request);
  if (!rawKey) return undefined; // x402 anónimo → sin alcance.

  try {
    const hash = sha256Hex(rawKey);

    if (rawKey.startsWith('wasi_a2a_session_')) {
      const delegation = await delegationService.lookupByTokenHash(hash);
      if (!delegation) return undefined;
      const parentKey = await delegationService.getParentKey(delegation.key_id);
      if (!parentKey) return undefined;
      return buildDelegationEffectiveRow(parentKey, delegation);
    }

    if (rawKey.startsWith('wasi_a2a_sess_')) {
      const session = await keySessionService.lookupByTokenHash(hash);
      if (!session) return undefined;
      const parentKey = await keySessionService.getParentKey(session.key_id);
      if (!parentKey) return undefined;
      return buildSessionEffectiveRow(parentKey, session);
    }

    return (await identityService.lookupByHash(hash)) ?? undefined;
  } catch {
    // Degradación deliberada (ver la invariante de arriba): sin alcance legible
    // se elige el mejor global y el ejecutor sigue haciendo cumplir el alcance.
    return undefined;
  }
}
