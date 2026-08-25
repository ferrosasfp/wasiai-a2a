/**
 * WKH-335 — el status HTTP del agente invocado, clasificado en vez de sepultado.
 *
 * Módulo LEAF: cero imports de runtime (sólo `import type`). Mismo motivo que
 * `discovery-sources.ts:1-9` — lo necesita `services/compose.ts`, y media docena
 * de suites mockean los módulos gordos del money-path COMPLETOS con factories sin
 * `importOriginal`, así que un export traído de uno de ellos llegaría `undefined`
 * bajo test.
 */
import type { AgentFailureKind } from '../types/index.js';

/**
 * Error de un agente invocado que respondió con un status no-2xx.
 *
 * Existe para que los dos `return` de error de `services/compose.ts` puedan
 * clasificar el fallo sin parsear el mensaje. El `message` se mantiene
 * BYTE-IDÉNTICO al `Error` genérico que había antes
 * (`Agent ${slug} returned ${status}` + `: ${detail}` sólo si hay detalle) para
 * no romper `parseFieldErrors`, la máquina de reintento adaptativo, ni ningún
 * test que assertee sobre `result.error` (CD-9).
 *
 * Ese byte-por-byte NO se sostiene leyendo el diff: lo mide
 * `agent-http-error.test.ts` pasando el `.message` de una instancia por
 * `parseFieldErrors` y exigiendo los mismos campos que devuelve para el literal
 * equivalente.
 */
export class AgentHttpError extends Error {
  public readonly status: number;
  public readonly kind: AgentFailureKind;

  constructor(agentSlug: string, status: number, detail: string) {
    super(
      `Agent ${agentSlug} returned ${status}${detail ? `: ${detail}` : ''}`,
    );
    this.name = 'AgentHttpError';
    this.status = status;
    this.kind = classifyAgentFailure(status);
  }
}

/**
 * Traduce el status HTTP del agente invocado a la clase que expone
 * `ComposeResult.agentFailure`.
 *
 * Contrato:
 *  - PURA: no hace I/O y no lee nada de afuera.
 *  - TOTAL: NUNCA lanza para NINGÚN `number` — incluidos `NaN`, negativos y `0`.
 *    Mismo contrato "NEVER throws" que declara `field-error-parser.ts:12-13`.
 *
 * Clasificación — **allow-list, no deny-list** (CD-13):
 *
 * | status | kind | por qué |
 * |---|---|---|
 * | 400 | `INPUT_REJECTED` | medido en producción el 2026-08-04 contra `/api/a2a/quote` de Chaski. Son DOS hechos de DOS capas y fusionarlos borra el defecto que esta HU cierra: **el agente** contestó `400 fx_amount_below_minimum` y `400 fx_amount_above_maximum`, y **la ruta que lo llamaba** devolvió `502 a2a_upstream_error` para los dos POST (`{"amountUsd":2}` y `{"amountUsd":50000}`). El `400` de la primera columna es el DEL AGENTE. Monto fuera del rango del corredor: lo corrige quien llama. ⚠️ Escrito acá y no como cita `archivo:línea` del otro repo A PROPÓSITO: es cross-repo y NINGÚN guard de ninguno de los dos puede verificarla nunca (la medición vive en el docblock de cabecera de `chaski-v3/src/application/agent-rejections.ts`). |
 * | 422 | `INPUT_REJECTED` | forma Zod; es la que ya usa toda la máquina de reintento adaptativo |
 * | 401, 403 | `AGENT_ERROR` | credencial NUESTRA, no el pedido de quien llama |
 * | 402 | `AGENT_ERROR` | saldo NUESTRO |
 * | 404 | `AGENT_ERROR` | `invokeUrl` viejo del catálogo es config, no input |
 * | 408, 429 | `AGENT_ERROR` | reintentar tras esperar SÍ puede servir |
 * | resto de 4xx / 5xx / <400 | `AGENT_ERROR` | plausibles pero NO medidos |
 *
 * **Por qué allow-list**: empezar por *"todo 4xx es INPUT_REJECTED salvo una
 * lista"* se cae solo — cada excepción olvidada produce exactamente el defecto
 * que esta HU arregla, pero INVERTIDO: decirle a la persona *"revisá el monto"*
 * cuando lo que pasó fue que NUESTRA Agent Key se quedó sin saldo (402), NUESTRA
 * credencial venció (401) o el `invokeUrl` del catálogo quedó viejo (404).
 * Cambiar "el sistema se cayó" por "es culpa tuya" no es un arreglo. Con
 * allow-list, olvidarse de un status deja el comportamiento de HOY, que es el
 * bucket vago y genérico.
 *
 * **Cómo se extiende la allow-list**: con un status MEDIDO contra un agente real
 * del catálogo devolviéndolo para un input que la persona puede corregir sola.
 * Los dos que están adentro entraron por eso; los que no están, no se midieron.
 *
 * **El 429 es `AGENT_ERROR` y eso es la decisión, no una omisión**: la semántica
 * que el campo promete es *"reintentar con el MISMO input no puede cambiar el
 * resultado"*, y para un rate-limit eso es FALSO. `AGENT_ERROR` termina en
 * *"Algo salió mal. Intentá de nuevo."*, que para un 429 es vago y CIERTO. Ídem
 * el 408.
 *
 * ⛔ **NO unificar con `parseFieldErrors`** (`field-error-parser.ts:31`, que
 * gatea el reintento con `400 <= status < 500`). Los dos números divergen A
 * PROPÓSITO porque las preguntas son distintas:
 *  - la compuerta del retry pregunta *"¿vale la pena reintentar con un input
 *    REGENERADO POR UN LLM?"* — un 403 con `fieldErrors` legibles califica;
 *  - este clasificador pregunta *"¿reintentar con el MISMO input puede cambiar
 *    algo?"* — un 403 no califica.
 * Unificarlos rompe uno de los dos.
 */
export function classifyAgentFailure(status: number): AgentFailureKind {
  return status === 400 || status === 422 ? 'INPUT_REJECTED' : 'AGENT_ERROR';
}
