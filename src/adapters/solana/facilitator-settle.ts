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
 *   · Sólo los códigos de `PAYOUT_NO_SPEND_CODES` prueban que no se gastó. El
 *     criterio es "¿este código demuestra que el INTENT no fue pagado?", NO "¿el
 *     facilitator liberó su reserva?" — ver el docstring de la constante, donde está
 *     explicado por qué esa segunda formulación (la que decía acá) es falsa y
 *     seguirla agrega un doble pago.
 *   · TODO lo demás es `'unknown'`: `PAYOUT_IN_PROGRESS`, `PAYOUT_BROADCAST_FAILED`,
 *     `PAYOUT_STORE_UNAVAILABLE`, un código que no reconocemos, un cuerpo ilegible,
 *     un non-2xx sin código, un timeout. Un código nuevo que alguien agregue mañana
 *     cae solo del lado seguro.
 *
 * Espejo estructural de `settleX402` (`src/adapters/avalanche/payment.ts`).
 */

import { getLogger } from '../../lib/logger.js';
import {
  classifySettleTransportError,
  FacilitatorSettleError,
} from '../errors.js';

const log = getLogger('solana-facilitator-payout-route');

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
 * ⚠️ EL CRITERIO NO ES "¿el facilitator liberó su reserva?" — eso decía este
 * comentario y ERA FALSO (AR menor). `PAYOUT_IN_PROGRESS` libera la reserva y NO
 * está en esta lista, correctamente. Quien "arregle" esa inconsistencia siguiendo
 * la regla escrita metería acá justo el código que significa **"otro request puede
 * estar pagando ahora mismo"**, y eso es un doble pago.
 *
 * EL CRITERIO REAL, y el único que importa: **este código, ¿demuestra que el
 * INTENT no fue pagado?** No "¿falló este request?" — son cosas distintas. Un
 * request puede fallar sobre un intent que ya está pagado o pagándose.
 *
 * Por eso NO están acá:
 *  · `PAYOUT_IN_PROGRESS`      — otro intento puede estar pagando.
 *  · `PAYOUT_BROADCAST_FAILED` — se transmitió y no se pudo confirmar.
 *  · `PAYOUT_BROADCAST_UNKNOWN`— se transmitió; suerte indeterminada.
 *  · `PAYOUT_STORE_UNAVAILABLE`— (AR BLQ-3) el ledger del facilitator se cayó.
 *    Responde sobre ESTE request, no sobre el intent: se emite con el ledger
 *    caído (donde el intent puede estar pagado de antes) y también cuando el
 *    perdedor de un CAS pierde mientras el ganador transmite.
 *
 * `PAYOUT_BROADCAST_EXPIRED` SÍ está, y sólo es legítimo porque el facilitator
 * garantiza que ya no lo emite después de un envío exitoso (ahí usa
 * `PAYOUT_BROADCAST_UNKNOWN`). Esa garantía tiene test propio del lado del
 * facilitator; si alguna vez se rompe, este código tiene que salir de la lista.
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

/**
 * ⛔ GUARD DE ARRANQUE — `SOLANA_SETTLE_VIA_FACILITATOR=true` SIN URL de facilitator.
 *
 * Lo que pasa hoy sin este guard, medido: `.env.example` entrega las dos variables
 * pegadas y en el estado inerte (`SOLANA_SETTLE_VIA_FACILITATOR=false` y
 * `SOLANA_FACILITATOR_URL=` VACÍA). Encender la primera es una línea; la segunda no
 * pide nada al arrancar. Con la bandera en `'true'` y sin URL, `settle()` reclama el
 * intent, entra a `settleViaFacilitator` y muere acá abajo (`'not-sent'`) — **un leg
 * por vez, en producción, sin una sola señal en el arranque**, y con la fila del
 * ledger ya reclamada. El camino local NO lo cubre a propósito (CD-15): con la
 * bandera ON el gateway no vuelve a ser camino de dinero ni como fallback.
 *
 * Por eso el corte va ACÁ y no en un comentario: el bloque `⛔` de
 * `payment.ts` (`settleViaFacilitator`) ya decía "condición previa a encender", y
 * una prosa que nadie hace cumplir no impide un redeploy con una variable a medias.
 *
 * ── LO QUE ESTE GUARD **NO** PRUEBA (y no hay que leerle de más) ──────────────
 * Que haya una URL NO prueba que del otro lado exista `POST /solana/payout`: en el
 * facilitator esa ruta es opt-in por env propia y, sin ella, **no se registra y
 * devuelve 404** (`wasiai-facilitator/src/routes/solana-payout.ts`). Ese 404 llega
 * acá como `'unknown'` (paso 3, código ausente), y eso se deja EXACTAMENTE COMO
 * ESTÁ: un 404 puede venir de un proxy intermedio y no demuestra que el intent no
 * se haya pagado. Este guard cierra la puerta que sí es config nuestra —
 * "encendí la bandera y no dije a dónde" — y ninguna otra.
 *
 * WKH-342 — lo de arriba SIGUE SIENDO CIERTO PALABRA POR PALABRA de este guard, que no
 * cambió: es el piso, y la que pregunta por la ruta es otra cosa (`probePayoutRoute` /
 * `ensurePayoutRouteReady`, más abajo). Y esa otra cosa tampoco lee la existencia de un
 * status code: la lee de un 200 sano donde el facilitator ENUMERÓ sus rutas dedicadas.
 * El 404 del POST real sigue cayendo en `'unknown'` exactamente como antes; el 404 sobre
 * el `/supported` del sondeo es `route_unaskable/probe_http_error` y deja pasar.
 *
 * La comparación es la MISMA literal `=== 'true'` que usa la ramificación de
 * `settle()` (`payment.ts`): si el guard fuera más laxo (`Boolean(...)`), rompería
 * el arranque de configs que toman el camino legado y funcionan.
 */
export function assertFacilitatorPayoutConfigured(): void {
  if (process.env.SOLANA_SETTLE_VIA_FACILITATOR !== 'true') return;
  if (getFacilitatorUrl() !== undefined) return;
  throw new Error(
    `SOLANA_SETTLE_VIA_FACILITATOR is 'true' but no facilitator URL is configured. ` +
      `Refusing to start — with the flag on the gateway NEVER signs a Solana payout ` +
      `itself (no local fallback, by design), so every downstream payout leg would ` +
      `die fail-closed at request time with 'no payout request was sent', one leg at ` +
      `a time and with no signal at boot. Set SOLANA_FACILITATOR_URL (or ` +
      `WASIAI_FACILITATOR_URL) to the facilitator that serves POST /solana/payout, or ` +
      `set SOLANA_SETTLE_VIA_FACILITATOR to 'false' to keep the locally-signed path.`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// WKH-342 — SONDEO DE LA RUTA DEDICADA: preguntarle al facilitator, no al string
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * El id que `GET /supported` del facilitator publica en `dedicatedRoutes` cuando la
 * ruta de tesorería está registrada (`wasiai-facilitator/src/core/supported.ts`,
 * tipo `DedicatedRouteId`). Es el par método+path tal cual, no un alias: tiene que
 * coincidir con el `fetch` de `payoutViaFacilitator`, que va a
 * `${facilitatorUrl}/solana/payout` con `method: 'POST'`.
 */
const PAYOUT_ROUTE_ID = 'POST /solana/payout';

/**
 * Techo del SONDEO, y a propósito NO es `FACILITATOR_TIMEOUT_MS` (30 s).
 *
 * Ese techo de 30 s es para un request que FIRMA Y TRANSMITE: vale esperarlo. Este
 * sondeo es un `GET` a un endpoint de discovery que no toca la cadena, y encima corre
 * en el camino perezoso de un leg de dinero — sumarle 30 s de espera a un pago para
 * averiguar si la ruta existe cambiaría un problema de configuración por un problema
 * de latencia. Si el facilitator no puede contestar un `/supported` en 5 s, el
 * veredicto correcto es "no pude preguntar" y se sigue igual.
 */
const PAYOUT_ROUTE_PROBE_TIMEOUT_MS = 5_000;

/**
 * TTL del veredicto POSITIVO (ms). 300 s, y ACÁ ME APARTO del exemplar a propósito:
 * `ensureSolanaSchemaReady` cachea su `ok:true` PARA SIEMPRE
 * (`schema-preflight.ts:233-235`) y tiene razón, porque su sujeto es NUESTRA base —
 * revertir esa migración es una acción de operador que viene con un restart nuestro,
 * así que el cache se limpia solo.
 *
 * Acá el sujeto es OTRO SERVICIO, que redespliega sin avisarnos y sin reiniciarnos.
 * Un `route_registered` eterno significa que si mañana el operador del facilitator
 * apaga `SOLANA_PAYOUT_ENABLED`, este proceso sigue creyendo por siempre que la ruta
 * está — y el gate queda mintiendo hasta el próximo deploy nuestro. Con 300 s, el
 * peor caso es 5 minutos de creencia vieja, y el costo de equivocarse en esa ventana
 * es el comportamiento de HOY (el POST real va, el 404 cae en `'unknown'`), no un
 * doble pago.
 */
const PAYOUT_ROUTE_POSITIVE_TTL_MS = 300_000;

/**
 * TTL de todo veredicto NO positivo (ms). 60 s, mismo número que
 * `RETRY_MS_DEFAULT` del preflight de esquema, y por el mismo motivo: cachear un
 * negativo para siempre dejaría el leg apagado hasta el próximo deploy por un blip
 * transitorio, y no cachear nada haría un sondeo por request contra un facilitator
 * caído.
 */
const PAYOUT_ROUTE_NEGATIVE_TTL_MS = 60_000;

/**
 * POR QUÉ "NO PUDE PREGUNTAR" TIENE SU PROPIO ESTADO Y SUS PROPIAS RAZONES.
 *
 * Cada una nombra una CAUSA distinta con una ACCIÓN distinta del operador. Molde:
 * `SolanaSchemaFailure` (`schema-preflight.ts:72-91`). Colapsarlas en un booleano
 * volvería a hacer indistinguible "el facilitator me dijo que no la tiene" de "no
 * pude hablar con el facilitator", que es exactamente el defecto que esta HU corrige.
 */
export type UnaskableReason =
  /**
   * El `fetch` del sondeo rechazó: DNS, connection refused, timeout, abort. Acción:
   * mirar la red y si el facilitator está vivo. NO se clasifica con
   * `classifySettleTransportError` — esa función decide la disposición del VALOR
   * (`'not-sent'` vs `'unknown'`) y el sondeo no manda valor: ahí `'not-sent'` sería
   * trivialmente cierto en los tres desenlaces, o sea información cero.
   */
  | 'transport_error'
  /**
   * Status ≠ 200, **incluido un 404 sobre `/supported` mismo**. Acción: hay un proxy
   * en el medio, o la URL apunta a otra cosa. Que un 404 caiga acá y no en
   * `route_absent` es el candado central: un 404 lo puede emitir cualquier
   * intermediario y no es el facilitator enumerando sus rutas.
   */
  | 'probe_http_error'
  /** 200 pero el cuerpo no es JSON, o no es un objeto. Acción: ídem — alguien reescribió la respuesta. */
  | 'body_unreadable'
  /**
   * 200 sano y `dedicatedRoutes` NO es un array (típicamente ausente). Acción: el
   * facilitator es ANTERIOR a la mitad A de WKH-342 — desplegá A. Este es el estado
   * en el que vive el sistema entre el deploy de B y el de A, y por eso tiene que
   * dejar pasar: si bloqueara, la mitad B sola cortaría los pagos.
   */
  | 'field_absent';

/**
 * TRES desenlaces, nunca dos.
 *
 * - `route_registered` — 200 + JSON parseable + `dedicatedRoutes` es array Y contiene
 *   el id. El sistema sigue y hace el POST.
 * - `route_absent` — 200 + JSON parseable + `dedicatedRoutes` es array y NO contiene
 *   el id. Determinación NEGATIVA, y la única que puede emitirla es el facilitator
 *   real contestando bien: rechaza el leg ANTES del POST.
 * - `route_unaskable` — todo lo demás. NO es una determinación sobre la ruta: es la
 *   ausencia de una. Deja pasar al POST real.
 *
 * ⚠️ Es una unión discriminada y no un booleano ni un `boolean | undefined` a
 * propósito. Un booleano fuerza a elegir a qué lado va "no sé" y borra la pregunta;
 * un `boolean | undefined` conserva el tercer valor pero pierde la razón, o sea la
 * acción del operador.
 */
export type PayoutRouteVerdict =
  | { readonly state: 'route_registered' }
  | { readonly state: 'route_absent'; readonly detail: string }
  | {
      readonly state: 'route_unaskable';
      readonly reason: UnaskableReason;
      readonly detail: string;
    };

let _routeCached: PayoutRouteVerdict | null = null;
let _routeCachedAt = 0;
let _routeInFlight: Promise<PayoutRouteVerdict> | null = null;

/** TEST-ONLY — limpia el veredicto memoizado. Espejo de `_resetSolanaSchemaPreflight`. */
export function _resetPayoutRoutePreflight(): void {
  _routeCached = null;
  _routeCachedAt = 0;
  _routeInFlight = null;
}

/**
 * La MISMA literal `=== 'true'` que usa `assertFacilitatorPayoutConfigured` (arriba) y
 * la ramificación de `settle()` en `payment.ts`. Un `Boolean(process.env.X)` mandaría
 * a la red a toda config que tenga la variable en `'false'`, `'0'` o `''` — o sea a
 * las que toman el camino legado y hoy funcionan.
 *
 * El criterio vive DENTRO de este módulo, no en el call-site del warm-up: este archivo
 * es el dueño de esos nombres de env (mismo motivo textual que
 * `src/adapters/registry.ts:135-138`), y un gate duplicado en `src/index.ts` podría
 * divergir de este.
 */
function isPayoutViaFacilitatorOn(): boolean {
  return process.env.SOLANA_SETTLE_VIA_FACILITATOR === 'true';
}

/**
 * Le PREGUNTA al facilitator. NUNCA lanza: todo camino devuelve un veredicto.
 *
 * `facilitatorUrl` entra por parámetro (ya normalizada por `getFacilitatorUrl`) para
 * que este cuerpo no tenga que decidir qué hacer sin URL — ese caso lo resuelve
 * `ensurePayoutRouteReady`, que ni siquiera sondea.
 */
async function probePayoutRoute(
  facilitatorUrl: string,
): Promise<PayoutRouteVerdict> {
  const probeUrl = `${facilitatorUrl}/supported`;
  let response: Response;
  try {
    response = await fetch(probeUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(PAYOUT_ROUTE_PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      state: 'route_unaskable',
      reason: 'transport_error',
      detail: `GET ${probeUrl} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (response.status !== 200) {
    return {
      state: 'route_unaskable',
      reason: 'probe_http_error',
      detail: `GET ${probeUrl} answered HTTP ${response.status} — a status code is not the facilitator enumerating its routes, and a 404 here is what an intermediate proxy looks like`,
    };
  }

  const body = (await response.json().catch(() => null)) as unknown;
  // Un array TAMBIÉN es `body_unreadable`, no `field_absent`: en un array
  // `body.dedicatedRoutes` es `undefined` y leerlo como "campo ausente" atribuiría al
  // facilitator una respuesta que no dio. Lo que hay del otro lado es otra cosa
  // contestando.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      state: 'route_unaskable',
      reason: 'body_unreadable',
      detail: `GET ${probeUrl} answered HTTP 200 with a body that is not a JSON object`,
    };
  }

  const routes = (body as { dedicatedRoutes?: unknown }).dedicatedRoutes;
  // ⚠️ `Array.isArray`, NUNCA truthiness ni `.length`. `[]` y `undefined` son los dos
  // falsy y son desenlaces OPUESTOS: `[]` es el facilitator diciendo "ninguna de las
  // tres", `undefined` es "este facilitator no contesta esa pregunta".
  if (!Array.isArray(routes)) {
    return {
      state: 'route_unaskable',
      reason: 'field_absent',
      detail: `GET ${probeUrl} answered HTTP 200 but dedicatedRoutes is not an array — this facilitator predates WKH-342, so it cannot say whether ${PAYOUT_ROUTE_ID} exists. Deploy the facilitator half.`,
    };
  }

  // ⚠️ AR BLQ-BAJO-1 — LA MISMA DISCIPLINA, UN NIVEL MÁS ADENTRO.
  //
  // Arriba se aplica dos veces "forma que no entiendo ⟹ `unaskable`": al CUERPO (`:360`)
  // y al CAMPO (`:372`). Faltaba el tercer nivel, los ELEMENTOS — y el nivel que falta es
  // el que decide, porque `['POST /solana/payout'].includes(…)` sobre
  // `[{ id: 'POST /solana/payout' }]` da `false` y ese `false` caía directo en
  // `route_absent`, que CORTA EL PAGO.
  //
  // MEDIDO antes del fix, con `{"dedicatedRoutes":[{"id":"POST /solana/payout"}]}`:
  // veredicto `route_absent`, `detail` con `as [[object Object]]`, el leg muerto en
  // `'not-sent'` y `urls = ["…/supported"]` — CERO POST, con la ruta servida del otro
  // lado. Un cambio de una línea en el vecino (publicar objetos en vez de strings) apagaba
  // todo el payout Solana fail-closed sin un test rojo en ninguno de los dos repos.
  //
  // Un array cuyos elementos no son strings NO es el facilitator enumerando rutas: es otra
  // cosa contestando. Eso es `body_unreadable`, igual que un cuerpo que no es objeto.
  if (!routes.every((route): route is string => typeof route === 'string')) {
    return {
      state: 'route_unaskable',
      reason: 'body_unreadable',
      detail: `GET ${probeUrl} answered HTTP 200 with a dedicatedRoutes array whose elements are not all strings (${routes.map((r) => typeof r).join(', ')}) — that is not this facilitator enumerating its routes, so it cannot be read as "the route is missing"`,
    };
  }

  // Comparación NORMALIZADA (verbo en mayúsculas, espacios colapsados), y la dirección de
  // la tolerancia importa: normalizar sólo puede convertir un `route_absent` en un
  // `route_registered`, nunca al revés. O sea que sólo puede hacer que el gate DEJE PASAR
  // de más, cuyo peor caso es el comportamiento de hoy (el POST sale, y su 404 cae en
  // `'unknown'`); si fuera al revés estaría agregando cortes de pago por una diferencia de
  // capitalización, que no es evidencia de que la ruta no exista.
  // MEDIDO antes del fix: `['post /solana/payout']` ⟹ `route_absent`, cero POST.
  const normalize = (route: string): string =>
    route.trim().replace(/\s+/g, ' ').toUpperCase();
  const wanted = normalize(PAYOUT_ROUTE_ID);
  if (routes.some((route) => normalize(route) === wanted)) {
    return { state: 'route_registered' };
  }

  // Único camino a `route_absent`: 200 + objeto + `dedicatedRoutes` array + TODOS los
  // elementos strings + ninguno igual (normalizado) al id. Sólo el facilitator real,
  // contestando bien, llega hasta acá.
  return {
    state: 'route_absent',
    detail: `GET ${probeUrl} enumerated its dedicated routes as [${routes.join(', ')}] and ${PAYOUT_ROUTE_ID} is not among them`,
  };
}

/**
 * AR MNR-2 — el logger del veredicto, con `switch` EXHAUSTIVO.
 *
 * El `if/else if` que había acá aceptaba un estado nuevo en silencio: MEDIDO, agregar un
 * cuarto miembro al union dejaba `tsc --noEmit` en exit 0 y ese estado no matcheaba ni la
 * rama `error` ni la `warn`, o sea **telemetría cero** para el caso nuevo. Caía del lado
 * permisivo, que por la asimetría del gate es el correcto — pero mudo, y un desenlace del
 * money-path que no se loguea es un desenlace que nadie va a ver.
 *
 * El `default` con `never` convierte eso en un error de compilación: quien agregue un
 * estado tiene que decidir explícitamente si suena y con qué nivel.
 *
 * Mutante de una línea que restauraría el silencio: cambiar el `default` por
 * `default: return;` (o borrar la anotación `: never`) — ahí `tsc` vuelve a aceptar un
 * estado nuevo sin tratarlo.
 */
function logRouteVerdict(verdict: PayoutRouteVerdict): void {
  switch (verdict.state) {
    case 'route_registered':
      // Silencio a propósito: es el caso sano y suena una vez por TTL en cada proceso.
      return;
    case 'route_absent':
      log.error(
        { detail: verdict.detail },
        'SOLANA PAYOUT ROUTE IS NOT REGISTERED ON THE CONFIGURED FACILITATOR — every payout leg will be refused BEFORE any request is sent (fail-closed, no value moves). The facilitator answered normally and did not list POST /solana/payout: turn SOLANA_PAYOUT_ENABLED on in the facilitator (it also needs its own operator key, distinct from the fee-payer and release-authority keys), or point SOLANA_FACILITATOR_URL at a facilitator that serves that route.',
      );
      return;
    case 'route_unaskable':
      log.warn(
        { reason: verdict.reason, detail: verdict.detail },
        'could not ask the facilitator whether POST /solana/payout exists — proceeding with the real payout request, which is exactly the behaviour that predates WKH-342 (a 404 there lands on the unknown disposition: no refund, no re-send, human review). This is NOT evidence that the route is missing.',
      );
      return;
    default: {
      // COMPILE-TIME: si esta asignación no compila, alguien agregó un estado al union y
      // no dijo si suena. Ése es el punto de MNR-2.
      const exhaustive: never = verdict;
      // RUNTIME: inalcanzable mientras el `never` compile, y aun así NO se lanza. Este
      // logger corre dentro del `.then` del veredicto, así que un `throw` acá rechazaría
      // la promise que el gate perezoso `await`ea, y un error sin clasificar en un camino
      // de dinero es peor que un estado sin tratar. Suena y sigue: el lado permisivo es el
      // mismo que elige la asimetría del gate.
      log.error(
        { verdict: JSON.stringify(exhaustive) },
        'unhandled payout route verdict — the probe produced a state this logger does not know. Treated as non-blocking (the gate only cuts on route_absent), but it is a code defect: add the case.',
      );
      return;
    }
  }
}

/**
 * Veredicto memoizado, single-flight, con TTL DOBLE. Mecánica copiada de
 * `ensureSolanaSchemaReady` (`schema-preflight.ts:240-275`).
 *
 * Devuelve `null` —y no un veredicto— cuando el gate NO ESTÁ ARMADO, que son dos
 * casos y ninguno habla de la ruta:
 *   · bandera distinta de `'true'` ⟹ este proceso no usa el facilitator para el
 *     payout, así que preguntarle sería una llamada de red gratis en un camino que no
 *     la necesita (AC-5: cero `fetch`);
 *   · sin URL configurada ⟹ la decisión ya está tomada aguas arriba y es MÁS FUERTE:
 *     `payoutViaFacilitator` corta con `'not-sent'` antes de llegar acá
 *     (`:203-209` del original), y el arranque ya falló por
 *     `assertFacilitatorPayoutConfigured`.
 *
 * `null` NO es un cuarto desenlace del sondeo: es "no se sondeó". Meterlo dentro de
 * `route_unaskable` haría que cada llamada del camino legado emitiera un `warn` sobre
 * un facilitator que nadie pensaba usar.
 */
export async function ensurePayoutRouteReady(): Promise<PayoutRouteVerdict | null> {
  if (!isPayoutViaFacilitatorOn()) return null;
  const facilitatorUrl = getFacilitatorUrl();
  if (facilitatorUrl === undefined) return null;

  if (_routeCached !== null) {
    const ttlMs =
      _routeCached.state === 'route_registered'
        ? PAYOUT_ROUTE_POSITIVE_TTL_MS
        : PAYOUT_ROUTE_NEGATIVE_TTL_MS;
    if (Date.now() - _routeCachedAt < ttlMs) return _routeCached;
  }
  if (_routeInFlight !== null) return _routeInFlight;

  /**
   * CR MNR-3(b) — UN SOLO camino de commit para los dos desenlaces de la promise.
   *
   * Antes la rama `onRejected` cacheaba su `route_unaskable` **sin pasar por
   * `logRouteVerdict`**, y eso la volvía la ÚNICA excepción a la frase que motiva el
   * `switch` exhaustivo ("todo veredicto suena con su nivel"). Inalcanzable hoy —
   * `probePayoutRoute` es no-throw— pero una excepción viva a la regla de al lado es
   * justo lo que hace que la regla deje de leerse. Se cierra en vez de declararse:
   * memoizar y loguear ocurren en el mismo lugar, así que no pueden divergir.
   */
  const commit = (verdict: PayoutRouteVerdict): PayoutRouteVerdict => {
    _routeCached = verdict;
    _routeCachedAt = Date.now();
    _routeInFlight = null;
    logRouteVerdict(verdict);
    return verdict;
  };

  const run = probePayoutRoute(facilitatorUrl).then(
    commit,
    // `probePayoutRoute` ya es no-throw; esto es defensa en profundidad para que el
    // gate de un camino de dinero no pueda rechazar la promise NUNCA.
    (err: unknown) =>
      commit({
        state: 'route_unaskable',
        reason: 'transport_error',
        detail: err instanceof Error ? err.message : String(err),
      }),
  );
  _routeInFlight = run;
  return run;
}

/**
 * Warm-up del arranque (`src/index.ts`). Fire-and-forget A PROPÓSITO, igual que
 * `warmSolanaSchemaPreflight`: el objetivo es que la alarma suene AL ARRANCAR en vez
 * de en medio de una transferencia, no que el vecino pueda impedirnos levantar.
 *
 * ⚠️ EL GATE DE LA BANDERA VIVE ACÁ ADENTRO, y en eso me aparto de los dos warm-ups
 * vecinos de `src/index.ts` (`if (isEscrowSettleEnabled()) …` en `:338` y
 * `if (process.env.SOLANA_ADAPTER_ENABLED === 'true') …` en `:345`), que lo llevan en
 * el call-site. Motivo: el gate perezoso de `payoutViaFacilitator` consulta el MISMO
 * `ensurePayoutRouteReady()`, así que si el criterio estuviera en `index.ts` habría
 * dos copias de la condición y podrían divergir — y divergir acá significa que el
 * warm-up y el gate opinan distinto sobre si hay que sondear.
 *
 * Por qué NO bloquea el arranque, medido: `railway.json:10` de este repo trae
 * `restartPolicyType: 'ON_FAILURE'` SIN `restartPolicyMaxRetries` (el facilitator sí
 * lo trae) y `healthcheckTimeout: 60`. Un sondeo bloqueante contra un facilitator
 * caído dos minutos dejaría al gateway en un ciclo de reinicios por un vecino.
 *
 * El único fallo de arranque de este archivo sigue siendo el de
 * `assertFacilitatorPayoutConfigured`: bandera en `'true'` y sin URL.
 */
export function warmPayoutRoutePreflight(): void {
  void ensurePayoutRouteReady().catch(() => {});
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

  // ── Paso 0 (WKH-342) — el gate PEREZOSO. Va acá y no en el arranque por las mismas
  // tres razones que el preflight de esquema (`schema-preflight.ts:33-45`): no rompe el
  // arranque de quien no usa este camino, no hay ventana TOCTOU contra el proceso ya
  // vivo, y no es una consulta por request (veredicto memoizado, compartido con el
  // warm-up del arranque — no pueden divergir).
  //
  // ⚠️ LA ASIMETRÍA, y va al revés de lo que la intuición pide: SÓLO `route_absent`
  // corta. `route_unaskable` DEJA PASAR, porque los dos errores no cuestan lo mismo:
  //   · bloquear con "no sé" convierte un blip del vecino en un corte de pagos NUESTRO,
  //     autoinfligido, con el facilitator posiblemente sano;
  //   · dejar pasar tiene el costo ACOTADO Y YA CONOCIDO: el POST real hereda intacta la
  //     clasificación de los pasos 1-4 de abajo, donde un 404 mudo cae en `'unknown'`
  //     (paso 3, código ausente) ⟹ ni refund ni re-envío, revisión humana. O sea que el
  //     peor caso de `route_unaskable` ES EL COMPORTAMIENTO DE HOY, no uno peor: no hay
  //     doble pago en esa rama.
  // Y ojo con la comparación fácil: en `schema-preflight.ts:148-160` la decisión es la
  // CONTRARIA (no medir ⟹ cortar) porque allá permitir de más habilita un segundo pago
  // irreversible. Acá no medir sólo POSTERGA una determinación. La regla es la misma —el
  // default va del lado del error barato— y por eso el resultado es distinto. No los
  // unifiques.
  const routeVerdict = await ensurePayoutRouteReady();
  if (routeVerdict !== null && routeVerdict.state === 'route_absent') {
    // MISMA construcción que la rama sin URL de arriba: `FacilitatorSettleError` con
    // `'not-sent'`. Cero disposiciones nuevas, cero códigos nuevos, cero `SettleResult`
    // fabricado — el sondeo decide sobre la CAPACIDAD, nunca sobre el valor de un pago
    // concreto, y acá el request no salió, que es un hecho y no una inferencia.
    throw new FacilitatorSettleError(
      `Facilitator at ${facilitatorUrl} does not serve ${PAYOUT_ROUTE_ID} — no payout request was sent. ${routeVerdict.detail}`,
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
