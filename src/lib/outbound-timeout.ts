/**
 * HU-195 — TECHO DE WALL-CLOCK POR REQUEST OUTBOUND.
 *
 * EL PROBLEMA (pre-existente, MNR-1 del AR de la HU 189)
 * -----------------------------------------------------
 * Antes de esta HU ningún hop outbound del gateway tenía una cota de wall-clock:
 *
 *   · `lib/ssrf-dispatcher.ts` construía `new Agent({ connect: { lookup } })` sin
 *     `headersTimeout` ni `bodyTimeout`, así que regían los defaults de undici 8
 *     (300_000 ms cada uno — `node_modules/undici/lib/dispatcher/client.js:275-276`).
 *   · `middleware/timeout.ts:12-20` sólo MANDA el 504: no hay `AbortController`,
 *     no hay `signal`, no se cancela nada.
 *
 * Y `bodyTimeout` de undici es un timeout de **INACTIVIDAD**, no de wall-clock:
 * `client-h1.js` llama `this.timeout.refresh()` en CADA chunk del body
 * (`onBody`, ~línea 713, y `resume`, ~línea 288). Un endpoint que emita un byte
 * cada 299 s mantiene el socket **y el worker del pipeline** vivos
 * indefinidamente, hasta 5 hops por request.
 *
 * LOS DOS EJES (son distintos — este es el punto del fix)
 * ------------------------------------------------------
 *   A. INACTIVIDAD → `headersTimeout` / `bodyTimeout` en el `Agent`. Corta al
 *      peer que se queda MUDO.
 *   B. WALL-CLOCK TOTAL → `AbortSignal.timeout` en el `fetch`. Corta al peer que
 *      trickle-feedea (un chunk cada 1 s durante una hora NUNCA dispara el eje A).
 *
 * ALCANCE: HOP, NO PIPELINE
 * -------------------------
 * Esto acota el **hop HTTP**. NO cancela el pipeline, NO cancela un settle en
 * vuelo y NO toca el Map de dedup de Solana. El argumento de "el remedio sería
 * peor que la enfermedad" (estado broadcasteado-pero-no-confirmado) aplica al
 * abort a nivel PIPELINE, no a acotar un hop: un hop abortado antes de que el
 * peer conteste no puede dejar plata en un estado indeterminado. Los adapters de
 * settlement (`src/adapters/**\/payment.ts`, `gasless.ts`) quedan DELIBERADAMENTE
 * afuera de esta HU.
 */

/**
 * Default del techo por hop outbound, en ms.
 *
 * POR QUÉ 60_000 (y no el default de undici, 300_000):
 *   · Es el doble de la norma del repo para un hop externo
 *     (`FACILITATOR_TIMEOUT_MS = 30_000` en avalanche/base/tempo,
 *     `X402_FACILITATOR_TIMEOUT_MS = 30_000`, `LLM_TIMEOUT_MS = 30000`), así que
 *     deja headroom de sobra para un agente lento legítimo.
 *   · 60 s × `MAX_COMPOSE_STEPS` (5) = 300 s: el PEOR caso de un run completo
 *     ahora cuesta lo que antes costaba UN SOLO hop.
 *   · 60 s < `TIMEOUT_COMPOSE_MS` (180_000), así que respeta la invariante de
 *     abajo por construcción.
 */
export const DEFAULT_OUTBOUND_HOP_TIMEOUT_MS = 60_000;

/**
 * Default de `TIMEOUT_COMPOSE_MS` — el 504 del compose
 * (`src/routes/compose.ts:613`). Duplicado a propósito como literal local para
 * NO importar la ruta desde un leaf de `lib/` (evita el ciclo
 * lib → routes → services → lib).
 */
const DEFAULT_COMPOSE_TIMEOUT_MS = 180_000;

/** Techo del request entero (el 504). Fallback al default si la env es basura. */
function resolveRequestCeilingMs(): number {
  const n = Number.parseInt(process.env.TIMEOUT_COMPOSE_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_COMPOSE_TIMEOUT_MS;
}

/**
 * Techo de wall-clock (ms) para UN hop outbound. Configurable con
 * `OUTBOUND_HOP_TIMEOUT_MS`; valor inválido / ausente / ≤ 0 → default seguro.
 *
 * INVARIANTE (clamp): el resultado NUNCA excede el techo del request entero
 * (`TIMEOUT_COMPOSE_MS`). Un hop con un techo mayor que el request completo no
 * es un techo: el caller ya recibió el 504 y el worker sigue quemando tiempo
 * downstream. Por eso el clamp es duro y silencioso en vez de un warn — un
 * operador que sube `OUTBOUND_HOP_TIMEOUT_MS` por arriba del 504 obtiene el 504
 * como techo efectivo, no un agujero.
 */
export function resolveOutboundHopTimeoutMs(): number {
  const raw = process.env.OUTBOUND_HOP_TIMEOUT_MS;
  const n = Number.parseInt(raw ?? '', 10);
  const requested =
    Number.isFinite(n) && n > 0 ? n : DEFAULT_OUTBOUND_HOP_TIMEOUT_MS;
  return Math.min(requested, resolveRequestCeilingMs());
}

/**
 * EJE B — devuelve el `signal` de wall-clock para UN request outbound,
 * combinando (si existe) el `signal` del caller con el techo de esta HU.
 *
 * `AbortSignal.any` gana el MÁS CORTO de los dos, así que un caller que ya trae
 * su propio presupuesto (discovery: 5 s; MCP pay-x402: 30 s) NO se relaja: el
 * techo es un piso de seguridad, no un override.
 *
 * El timer de `AbortSignal.timeout` es unref'd (no mantiene vivo el event loop),
 * así que un signal que nunca se aborta no cuelga el proceso ni la suite.
 */
export function outboundWallClockSignal(
  callerSignal?: AbortSignal | null,
  timeoutMs: number = resolveOutboundHopTimeoutMs(),
): AbortSignal {
  const ceiling = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, ceiling]) : ceiling;
}
