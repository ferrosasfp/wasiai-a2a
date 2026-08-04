/**
 * Límites de fetch/pool de discovery (fix-pack P1, hallazgo 1 + AR BLQ-BAJO-1).
 *
 * Vive en un módulo LEAF (cero imports) por la misma razón que
 * `discovery-query.ts` y `downstream-skip-code.ts`: `services/compose.ts` necesita
 * el tamaño del pool, y media docena de suites mockean `../services/discovery.js`
 * COMPLETO con factories sin `importOriginal` (`e2e/setup.ts`,
 * `e2e/compose-flow.test.ts`, ...), así que un export nuevo del service que
 * `compose.ts` consuma quedaría `undefined` ahí. Ya pasó dos veces en este
 * fix-pack (12 y 84 tests rotos) — ver `auto-blindaje.md`.
 *
 * ─── El bug original (hallazgo 1) ────────────────────────────────────────
 * `queryRegistry` reenviaba el `limit` DEL CALLER como límite de fetch upstream
 * (`schema.discovery.limitParam`), truncando el candidate-set ANTES de los
 * filtros locales (status/verified/caps/free-text/maxPrice — que existen justo
 * porque "upstream may not support all filter params"). Cada agente descartado
 * localmente era un slot de la página que ya no se podía rellenar: la página salía
 * corta y `total` subestimaba los matches. Medido: `limit=5` devolvía 2.
 *
 * Ahora el upstream recibe un límite de OVER-FETCH independiente del page size.
 * Monótono DENTRO DE `resolveUpstreamFetchLimit`: si el caller pide más que el
 * over-fetch, gana el caller (nunca under-fetch).
 *
 * ⚠️ WKH-318 corte B — esa monotonía es de la FUNCIÓN, no del call-site, y el
 * puntero va acá porque sin él "nunca under-fetch" se lee como garantía de
 * extremo a extremo. Input que la falsifica en el call-site: registry con
 * `maxLimit: 100` + `GET /discover?limit=150` ⇒ `queryRegistry` aplica después
 * `clampToRegistryMaxLimit` y envía `100`, o sea MENOS de lo que el caller
 * pidió. Es deliberado: el registry no puede dar más sin paginar y paginar está
 * descartado (TD-318-2, se detecta pero no se pagina), y el recorte no se
 * esconde — sale como `truncated`/`page_full` en `sources[]`.
 */

/** Over-fetch por registry cuando el caller manda `limit`. */
const DEFAULT_UPSTREAM_FETCH_LIMIT = 200;

/**
 * Piso histórico del pool que `/compose` usa para resolver por slug e hidratar
 * `payment.chain` (era el `discover({ limit: 50 })` hardcodeado).
 */
const COMPOSE_POOL_MIN_LIMIT = 50;

/**
 * Límite a reenviar al registry upstream. NO es el page size.
 * `max(pageLimit, DISCOVERY_UPSTREAM_FETCH_LIMIT ?? 200)`.
 * Patrón de env de `resolveScaleFactor` (services/reputation.ts): valor
 * inválido/ausente → default (nunca NaN en la query string).
 *
 * Idempotente por construcción (`max(max(a,b), b) === max(a,b)`), SIN condiciones:
 * si el page size YA es el over-fetch, el fetch que se le pide a CADA registry es
 * exactamente ese número. Eso es todo lo que esta función garantiza — la
 * alineación page-size ↔ candidatos disponibles NO se sigue de acá, porque el
 * `slice` del page size es GLOBAL y el fetch es POR REGISTRY (ver la precondición
 * en `resolveComposeAgentPoolLimit`).
 */
export function resolveUpstreamFetchLimit(pageLimit: number): number {
  const raw = process.env.DISCOVERY_UPSTREAM_FETCH_LIMIT;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const base = Number.isFinite(n) && n > 0 ? n : DEFAULT_UPSTREAM_FETCH_LIMIT;
  return Math.max(pageLimit, base);
}

/**
 * WKH-318 corte B — ¿el `maxLimit` que declaró un registry es usable como techo?
 *
 * El parámetro es `unknown` A PROPÓSITO, aunque
 * `RegistrySchema.discovery.maxLimit` esté tipado `number | undefined`
 * (`types/index.ts:160`). El valor viene de una columna `jsonb` que
 * `services/registry.ts:92` asigna directo (`schema: row.schema`) con un
 * `as unknown as` acotado (`:153-155`), y el write-path NO valida: `POST
 * /registries` sólo chequea la PRESENCIA de `schema` (`routes/registries.ts:69`)
 * y lo guarda tal cual (`:251`), sin `zod` ni equivalente. En runtime esto puede
 * llegar como `"100"`, `0`, `-5`, `1.5`, `null` o `{}`. Tipar el parámetro
 * `number | undefined` haría que este guard parezca código muerto que tsc ya
 * garantiza; el `unknown` es lo que documenta la desconfianza en la firma.
 *
 * Qué corta, con el input concreto: `Math.min(200, "100")` devuelve `100`
 * (coerción de JS) y `Math.min(200, "abc")` devuelve `NaN`, que terminaría como
 * `?limit=NaN` en la query string — el mismo hazard que el docstring de
 * `resolveUpstreamFetchLimit` ya nombra. El `typeof` las corta antes del
 * `Math.min`.
 */
export function isUsableRegistryMaxLimit(declared: unknown): boolean {
  return (
    typeof declared === 'number' && Number.isInteger(declared) && declared >= 1
  );
}

/**
 * WKH-318 corte B — techo del registry aplicado al over-fetch.
 *
 * Opción A, decidida en F2: **sin declaración usable no hay clamp**. Un registry
 * que no declara `maxLimit` (o que declara basura) recibe exactamente el mismo
 * número que recibía antes de esta HU. No hay default de 100: `100` no es un
 * estándar, es el techo de UN servidor (`wasiai-v2`), y aplicarlo a un registry
 * cuyo techo real es 1000 cambiaría un `400` ruidoso y publicado en `sources[]`
 * por un recorte MUDO del pool de ranking (200 → 100 filas).
 *
 * Techo inválido ⇒ sin clamp, nunca fail-closed (CD-13): con `maxLimit: 0` un
 * fail-closed mandaría `?limit=0`, el registry devolvería 0 filas y el catálogo
 * quedaría casi vacío en silencio. Ignorar el valor deja que el registry
 * conteste; si su techo real es menor, contesta `400`, que es visible.
 *
 * NO reimplementa el predicado: llama a `isUsableRegistryMaxLimit`, que es la
 * única expresión de "este techo sirve" (el call-site necesita el MISMO
 * predicado para decidir si emite el `warn`, y dos copias divergen).
 */
export function clampToRegistryMaxLimit(
  fetchLimit: number,
  declared: unknown,
): number {
  if (!isUsableRegistryMaxLimit(declared)) return fetchLimit;
  // El `as number` está cubierto por la línea de arriba: el guard devuelve
  // `boolean` (no un type predicate) porque su firma es parte del contrato de
  // esta HU, así que tsc no propaga el narrowing solo.
  return Math.min(fetchLimit, declared as number);
}

/**
 * Page size del pool de agentes que `/compose` usa para (a) hidratar el
 * `payment.chain` real (WKH-113/BASE-08, CD-5/CD-10 — `getAgent` de v2 hardcodea
 * `chain=avalanche`) y (b) resolver un step por slug cuando `getAgent` falla.
 *
 * ⚠️ AR BLQ-BAJO-1 — POR QUÉ ESTO NO PUEDE SER UN NÚMERO SUELTO.
 * `compose.resolveAgent` pedía `discover({ limit: 50 })`, o sea el TOP-50
 * RANKEADO (verified-first → reputación desc → precio asc). Cuando el hallazgo 1
 * hizo que el ranking se calcule sobre ≤200 filas por registry en vez de ≤50
 * (mismos 50 slots, 4× candidatos), la MEMBRESÍA de ese top-50 cambió: un agente
 * que antes entraba podía quedar afuera. Reproducido con 150 activos y el target
 * como el más caro (último por `price asc`):
 *
 *   pool de 50  → el agente no está → `payment.chain` NO se hidrata → queda el
 *   default de `getAgent` (`avalanche`) → el leg downstream se saltea (guard de
 *   familia del payTo / `NO_PAYMENT_FIELD`) o apunta al rail equivocado:
 *   **el agente no se cobra, en silencio**. Justo el caso que WKH-113 existe
 *   para cubrir (Base, Solana).
 *
 * Un pool para BUSCAR POR SLUG no debe ser un ranking top-N. Se alinea al
 * over-fetch: `resolveUpstreamFetchLimit(50)` (default 200) pide a cada registry
 * el mismo número que después usa de page size.
 *
 * ⚠️ PRECONDICIÓN de la alineación (AR it3 BLQ-BAJO-1) — leerla PEGADA a la
 * afirmación, no en otra sección. Vale mientras
 *
 *     (unión de las filas que aportan TODAS las fuentes) <= la ventana de
 *     over-fetch,
 *
 * o sea, en la práctica: **una** sola fuente contribuyente con `limitParam`
 * declarado. Por qué:
 *   · El fetch es POR REGISTRY pero el `slice` es GLOBAL: `discovery.ts:293`
 *     concatena las filas de todos los registries + las self-published locales, y
 *     `discovery.ts:399` corta `slice(0, query.limit)` sobre el TOTAL. Con N
 *     fuentes el fetch puede traer 200·N filas y el slice conserva 200 ⇒ el slice
 *     SÍ descarta candidatos que el fetch trajo, y el ranking (verified-first →
 *     reputación desc → precio asc) decide cuáles.
 *   · `limitParam` es OPCIONAL (`types/index.ts:134`) y el gate es
 *     `query.limit && schema.limitParam` (`discovery.ts:509`): un registry sin
 *     `limitParam` — creable por cualquier caller vía `POST /registries` —
 *     devuelve su paginación default y para esa fuente la alineación no existe.
 *
 * Fuera de esa precondición el pool NO es superconjunto del de `main`: con 2
 * registries de 400 filas cada uno cuyas primeras 50 son `verified:false` y el
 * resto `verified:true`, el ranking llena los 200 slots con filas de esos dos y el
 * agente target de un tercer registry queda afuera (medido por el AR: `pool=200`,
 * `total=401`, `idx=-1`, mientras el mimic de `main` con pool 50 lo encontraba).
 * Con UNA fuente la propiedad sí se sostiene (el fetch de 200 filas en orden de
 * registry contiene las 50 que traía antes). Hoy los registries reales tienen ~32
 * agentes cada uno, muy por debajo de la ventana, así que el caso no es alcanzable
 * en prod; queda como residual explícito en TD-189-1 (work-item), no como
 * propiedad del código.
 *
 * Por qué NO `discover({})` (la otra opción del AR): sin `limit` no se manda
 * `limitParam`, así que el tamaño del pool lo decide el DEFAULT DE PAGINACIÓN DEL
 * REGISTRY. Un registry que pagina de a 25 devolvería 25 filas — PEOR que hoy y
 * fuera de nuestro control. El límite explícito mantiene el pool acotado y
 * gobernado por una env nuestra.
 *
 * El piso de 50 preserva el pool histórico si el operador baja
 * `DISCOVERY_UPSTREAM_FETCH_LIMIT` por debajo (y con una sola fuente la alineación
 * se mantiene: `resolveUpstreamFetchLimit(50)` sería 50 y el fetch también 50).
 */
export function resolveComposeAgentPoolLimit(): number {
  return resolveUpstreamFetchLimit(COMPOSE_POOL_MIN_LIMIT);
}

/**
 * WKH-318 corte B — ¿el número que quedó después del clamp cae por debajo del
 * piso histórico del pool de `/compose` (el `COMPOSE_POOL_MIN_LIMIT` de arriba)?
 *
 * Existe para que `queryRegistry` no escriba `sent < 50` a mano: sería la
 * segunda expresión del mismo concepto y las dos divergen apenas alguien mueva
 * la constante.
 *
 * Sólo alimenta un `warn` (`REGISTRY_MAX_LIMIT_BELOW_COMPOSE_POOL`). NO impide
 * el clamp y NO pone un piso: mandarle 50 a un registry que declaró 10 devuelve
 * `400` y se pierde la fuente ENTERA en vez de quedarnos con sus 10 filas. La
 * declaración del registry gana; el costo se declara en vez de esconderse.
 * Cuál es ese costo, con el input: registry con `maxLimit: 10` y 200 agentes
 * activos ⇒ el pool de esa fuente baja a 10 filas, el agente que quede afuera no
 * hidrata `payment.chain` y su leg downstream se saltea en silencio (clase
 * WKH-113 / BLQ-BAJO-1). Queda como TD-318B-2.
 */
export function clampFallsBelowComposePoolFloor(sent: number): boolean {
  return sent < COMPOSE_POOL_MIN_LIMIT;
}
