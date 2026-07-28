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
 * Esto acota el **hop HTTP**. NO cancela el pipeline y NO toca el Map de dedup de
 * Solana. El argumento de "el remedio sería peor que la enfermedad" (estado
 * broadcasteado-pero-no-confirmado) aplica al abort a nivel PIPELINE, no a acotar
 * un hop: un hop abortado antes de que el peer conteste no puede dejar plata en
 * un estado indeterminado.
 *
 * POR QUÉ LOS ADAPTERS DE SETTLEMENT QUEDAN AFUERA (justificación corregida —
 * AR MNR-3 de esta HU): NO es que acotarlos "cancelaría plata en vuelo". Eso es
 * mecánicamente falso: abortar el request HTTP al facilitator **no cancela un
 * broadcast**, sólo deja al gateway CIEGO al resultado (estado `unknown`). La
 * razón real es de alcance y de precedente:
 *   · 4 de los 5 caminos de settle YA están acotados a 30 s en el repo
 *     (`adapters/base/payment.ts:349`, `avalanche:328`, `tempo:281`,
 *     `kite-ozone` modo x402 `:594`), así que ahí no falta nada.
 *   · Los 2 que faltan son `kite-ozone/payment.ts:317` (`/verify`) y `:362`
 *     (`/settle`) en modo **pieverse**, que es el DEFAULT
 *     (`getFacilitatorMode()`, `payment.ts:66`; `.env.example`:
 *     `KITE_FACILITATOR_MODE=pieverse` — "current production path"), o sea el
 *     camino VIVO, no código muerto. Pasar de "sin cota" a "cota + estado
 *     `unknown` manejado" es una decisión de money-path con su propia HU: hay que
 *     definir qué hace el gateway con un settle de resultado desconocido (¿lo
 *     reconcilia?, ¿lo reintenta?, ¿lo marca para revisión?), y eso no se
 *     resuelve poniendo un timeout.
 *
 * QUÉ CUBRE ESTE TECHO, EXACTAMENTE
 * ---------------------------------
 * Todo lo que pasa por `ssrfFetch`: el pre-flight SSRF de cada hop (incluida su
 * fase de DNS — AR BLQ-BAJO-3) + el intercambio HTTP + el consumo del body.
 * NO cubre: el slot del threadpool de libuv que `dns.lookup` ocupa (no acepta
 * `signal`; la carrera acota la ESPERA del gateway, no el slot), ni el egress que
 * no pasa por `ssrfFetch` (settlement, `supabase-js`, viem RPC — ver el detalle
 * en el work-item de la HU).
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
 *   · 60 s < `min(TIMEOUT_COMPOSE_MS, TIMEOUT_ORCHESTRATE_MS)` (180_000 y
 *     120_000), así que respeta la invariante del clamp por construcción.
 */
export const DEFAULT_OUTBOUND_HOP_TIMEOUT_MS = 60_000;

/**
 * Default de `TIMEOUT_COMPOSE_MS` — el 504 del compose
 * (`src/routes/compose.ts:613`). Duplicado a propósito como literal local para
 * NO importar la ruta desde un leaf de `lib/` (evita el ciclo
 * lib → routes → services → lib).
 */
const DEFAULT_COMPOSE_TIMEOUT_MS = 180_000;

/**
 * Default de `TIMEOUT_ORCHESTRATE_MS` — el 504 de `/orchestrate`
 * (`src/routes/orchestrate.ts:80,191,331`), `/inbound` (`inbound.ts:54`) y
 * `/agent-links` (`agent-links.ts:143`). Mismo criterio de literal local.
 *
 * AR MNR-8: esas 3 rutas invocan el MISMO compose que `/compose`, pero con este
 * presupuesto (120 s por default, MÁS CORTO que los 180 s del compose). Clampear
 * sólo contra `TIMEOUT_COMPOSE_MS` dejaba un agujero real: un operador que sube
 * `OUTBOUND_HOP_TIMEOUT_MS` a 180 000 (valor que el clamp ACEPTA) obtenía un
 * techo de hop MAYOR que el 504 de orchestrate.
 */
const DEFAULT_ORCHESTRATE_TIMEOUT_MS = 120_000;

/** Env de ms > 0, o el default si es basura / ausente / ≤ 0. */
function envMsOrDefault(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Techo del request entero: el MÍNIMO de los dos 504 que pueden gobernar un
 * compose (`/compose` y `/orchestrate`|`/inbound`|`/agent-links`). El mínimo,
 * porque el clamp tiene que valer para el caller más estricto: si el techo del
 * hop supera el 504 de orchestrate, ese caller ya recibió su timeout y el worker
 * sigue quemando tiempo downstream, que es exactamente lo que el clamp evita.
 */
function resolveRequestCeilingMs(): number {
  return Math.min(
    envMsOrDefault(process.env.TIMEOUT_COMPOSE_MS, DEFAULT_COMPOSE_TIMEOUT_MS),
    envMsOrDefault(
      process.env.TIMEOUT_ORCHESTRATE_MS,
      DEFAULT_ORCHESTRATE_TIMEOUT_MS,
    ),
  );
}

/**
 * Techo de wall-clock (ms) para UN hop outbound. Configurable con
 * `OUTBOUND_HOP_TIMEOUT_MS`; valor inválido / ausente / ≤ 0 → default seguro.
 *
 * INVARIANTE (clamp): el resultado NUNCA excede el 504 MÁS ESTRICTO de los dos
 * que pueden gobernar un compose — `min(TIMEOUT_COMPOSE_MS,
 * TIMEOUT_ORCHESTRATE_MS)`, ver `resolveRequestCeilingMs`. Un hop con un techo
 * mayor que el request completo no es un techo: el caller ya recibió el 504 y el
 * worker sigue quemando tiempo downstream. Por eso el clamp es duro y silencioso
 * en vez de un warn — un operador que sube `OUTBOUND_HOP_TIMEOUT_MS` por arriba
 * del 504 obtiene el 504 como techo efectivo, no un agujero.
 */
export function resolveOutboundHopTimeoutMs(): number {
  const requested = envMsOrDefault(
    process.env.OUTBOUND_HOP_TIMEOUT_MS,
    DEFAULT_OUTBOUND_HOP_TIMEOUT_MS,
  );
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
 *
 * RETENCIÓN — POR QUÉ NO SE USA EL PATRÓN `controller` + `clearTimeout` (AR
 * MNR-7): `AbortSignal.timeout` NO se puede cancelar, así que cada request retiene
 * su timer + el signal por el presupuesto COMPLETO aunque el fetch termine en
 * 200 ms. Verificado que NO es un leak (el signal del caller no acumula
 * listeners, no hay `MaxListenersExceededWarning`, no hay unhandled rejection con
 * bodies sin consumir): lo que queda vivo es un timer unref'd por request en
 * vuelo, acotado por el rate-limit / la backpressure del proceso.
 *
 * El repo tiene el patrón cancelable en `services/discovery.ts:537-546`
 * (`AbortController` + `clearTimeout` en `.finally`), pero acá NO se puede aplicar
 * sin CAMBIAR el comportamiento observable: `ssrfFetch` DEVUELVE la `Response`
 * con su body sin consumir, y el signal es justamente lo que corta al peer que
 * trickle-feedea ESE body (el `bodyTimeout` no lo ve porque se refresca en cada
 * chunk). Un `clearTimeout` en un `.finally` del hop apagaría el techo antes de
 * que el body se lea — o sea, apagaría el eje B. Se conserva a propósito.
 */
export function outboundWallClockSignal(
  callerSignal?: AbortSignal | null,
  timeoutMs: number = resolveOutboundHopTimeoutMs(),
): AbortSignal {
  const ceiling = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, ceiling]) : ceiling;
}
