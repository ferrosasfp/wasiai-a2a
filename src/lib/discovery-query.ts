/**
 * Validación de parámetros de query de `/discover` (fix-pack P1, hallazgo 2).
 *
 * Vive en un módulo LEAF (sin imports de services/DB), por el mismo motivo que
 * `payment-spec-reader.ts` (WKH-241): los tests de `routes/discover.ts` mockean
 * `../services/discovery.js` COMPLETO con una factory sin `importOriginal`, así
 * que cualquier export nuevo del service que la ruta consuma queda `undefined`
 * en esos tests. Un validador de input no es lógica de service — acá no rompe a
 * nadie y la ruta lo importa directo.
 */

/** Escala canónica del score de reputación (`AgentReputation.score`: 0-100). */
export const MIN_REPUTATION_FLOOR = 0;
export const MIN_REPUTATION_CEIL = 100;

/**
 * `minReputation` inválido. La ruta la mapea a 400 `INVALID_MIN_REPUTATION`.
 *
 * Razón de ser: `parseFloat('abc')` es `NaN` y `NaN != null` es `true`, así que
 * un valor basura LLEGABA al `DiscoveryQuery`. Con el filtro implementado,
 * `score >= NaN` es siempre `false` → 0 resultados con HTTP 200 y sin
 * explicación: sería cambiar un P1 silencioso (un filtro que no filtra) por otro
 * (un filtro que vacía la respuesta).
 */
export class InvalidMinReputationError extends Error {
  readonly code = 'INVALID_MIN_REPUTATION' as const;
  constructor(readonly received: unknown) {
    super(
      `minReputation must be a number between ${MIN_REPUTATION_FLOOR} and ${MIN_REPUTATION_CEIL} (gateway-computed off-chain reputation score scale)`,
    );
    this.name = 'InvalidMinReputationError';
  }
}

/**
 * Normaliza y VALIDA el `minReputation` entrante (string del query string o
 * number del body JSON). Ausente/vacío → `undefined` (no filtra). Cualquier otra
 * cosa que no sea un número finito en `[0, 100]` → lanza
 * `InvalidMinReputationError`.
 *
 * NB: la escala es 0-100 (el `score` de `AgentReputation`), NO 0-1 — el JSDoc de
 * la ruta decía 0-1 y estaba mal.
 */
export function parseMinReputation(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  // `Number('12abc')` es NaN, a diferencia de `parseFloat('12abc')` que devuelve
  // 12 y aceptaría basura en silencio. `Number('')` es 0, ya descartado arriba.
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (
    !Number.isFinite(n) ||
    n < MIN_REPUTATION_FLOOR ||
    n > MIN_REPUTATION_CEIL
  ) {
    throw new InvalidMinReputationError(raw);
  }
  return n;
}

/**
 * `limit` inválido. La ruta la mapea a 400 `INVALID_LIMIT`.
 *
 * Razón de ser (fix-pack P1 AR MENOR-4): `doc/INTEGRATION.md` promete «when you
 * pass a `limit`, you get exactly `min(limit, total)` agents» y el código NO lo
 * cumplía para los valores degenerados, en silencio:
 *   · `limit=0`  → `query.limit` es falsy ⇒ NO se manda `limitParam` upstream Y
 *     el `slice` se saltea ⇒ devuelve TODO el catálogo (medido: 10 de 10).
 *   · `limit=-3` → `slice(0, -3)` cuenta desde el final ⇒ devuelve `total - 3`
 *     (medido: 7 de 10).
 *   · `limit=abc` → `parseInt` da NaN ⇒ `query.limit` falsy ⇒ devuelve todo.
 * Preexistente (idéntico en `main`), pero el doc que lo contradice se agregó en
 * este mismo fix-pack, y el fix-pack sí validó `minReputation`: dejar el doc
 * mintiendo sobre una de las dos perillas era incoherente.
 */
export class InvalidLimitError extends Error {
  readonly code = 'INVALID_LIMIT' as const;
  constructor(readonly received: unknown) {
    super('limit must be a safe integer >= 1 (<= 2^53-1)');
    this.name = 'InvalidLimitError';
  }
}

/**
 * Normaliza y VALIDA el `limit` entrante (string del query string o number del
 * body JSON). Ausente/vacío → `undefined` (sin page size: se devuelven todos los
 * matches, comportamiento de hoy). Cualquier otra cosa que no sea un entero
 * finito `>= 1` → lanza `InvalidLimitError`.
 *
 * NO se impone techo de MAGNITUD: el over-fetch (`resolveUpstreamFetchLimit`) es
 * monótono a propósito — un caller que pide `limit=500` fetchea 500. Meter un techo
 * acá sería reintroducir el bug de clase "esconder agentes" que arregló el
 * hallazgo 1.
 *
 * `Number.isSafeInteger` (no `isInteger`) — AR it3 MENOR-3. Mismo agujero de clase
 * que el `limit=0`: `Number.isInteger(1e21)` es `true`, así que `?limit=1e21`
 * pasaba, `Math.max(1e21, 200).toString()` da `'1e+21'` y ESO se manda como
 * `limitParam` upstream (`discovery.ts:509-514`); un registry que rechaza el
 * parámetro tira, el `catch` del fanout (`discovery.ts:267-287`) lo degrada a `[]`
 * y el caller recibe **HTTP 200 con 0 agentes**, violando en silencio el
 * `min(limit, total)` que promete `doc/INTEGRATION.md:203-210`. El bound cierra
 * exactamente eso: todo entero seguro (≤ 2^53-1) tiene representación decimal plana
 * en `String()` (la notación científica arranca en 1e21), y a partir de ahí el
 * número ya no es representable de forma exacta como page size.
 *
 * NO es un guard de memoria/CPU: no hay `new Array(limit)` y `slice(0, limit)` no
 * preasigna.
 */
export function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) throw new InvalidLimitError(raw);
  return n;
}

/**
 * WKH-313 — `allowTrial` inválido. La ruta la mapea a 400 `INVALID_ALLOW_TRIAL`.
 *
 * Razón de ser, y es la misma clase de bug que `minReputation`: `allowTrial` es
 * el OPT-IN a admitir un agente sin historial bajo el piso del caller. Con un
 * `Boolean(raw)`, `?allowTrial=false` (string no vacío) y `?allowTrial=maybe`
 * serían `true` — o sea que un caller que escribió mal el parámetro, o que quiso
 * apagarlo explícitamente, terminaría ACEPTANDO un candidato en estreno sobre el
 * camino del dinero sin haberlo pedido. Un flag de riesgo no se adivina.
 */
export class InvalidAllowTrialError extends Error {
  readonly code = 'INVALID_ALLOW_TRIAL' as const;
  constructor(readonly received: unknown) {
    super(
      "allowTrial must be a boolean ('true' or 'false'); it opts IN to admitting agents with no settled history below your minReputation floor",
    );
    this.name = 'InvalidAllowTrialError';
  }
}

/**
 * Normaliza y VALIDA el `allowTrial` entrante (string del query string o boolean
 * del body JSON).
 *
 *   ausente / `null` / `''`     → `undefined` (no opta: comportamiento de hoy)
 *   `true`  / `'true'`          → `true`
 *   `false` / `'false'`         → `undefined` (idem: no opta)
 *   cualquier otra cosa         → `InvalidAllowTrialError`
 *
 * `false` colapsa a `undefined` a propósito: los dos significan exactamente lo
 * mismo (no admitir), y el service tiene UN solo camino por defecto en vez de
 * dos que hay que mantener idénticos.
 */
export function parseAllowTrial(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return undefined;
  throw new InvalidAllowTrialError(raw);
}

/**
 * WKH-322 — las ÚNICAS claves que `/discover` (GET y POST, la ruta raíz) acepta.
 *
 * Las 9 primeras son exactamente las que la ruta ya leía antes de esta HU
 * (`routes/discover.ts`, tipo `Querystring` del GET y tipo `Body` del POST). La
 * décima, `min_reputation`, es el ALIAS que agrega WKH-322.
 *
 * Se exporta (mismo motivo que `ALLOWED_STEP_CONSTRAINTS` en
 * `compose-step-shape.ts:39-48`) para que los tests NEGATIVOS lean ESTA lista y
 * no una copia literal. Los tests POSITIVOS, en cambio, enumeran los nombres a
 * mano: un test que itere esta constante mide la constante contra sí misma, así
 * que agregar `pepito` acá lo haría pasar afirmando que `pepito` es público.
 *
 * ⚠️ Agregar una clave acá es una decisión de PRODUCTO, no un detalle de
 * validación: cada nombre nuevo hay que mantenerlo, documentarlo y testearlo
 * mientras exista la API.
 *
 * ⚠️ Y hay que tocar OTROS TRES lugares, porque nada los ata mecánicamente a
 * este Set (CR MNR-3): los tipos `Querystring` y `Body` de `routes/discover.ts`,
 * y la tabla de parámetros de `doc/INTEGRATION.md`. Los dos modos de falla NO
 * son simétricos: agregarla al tipo y olvidarla acá da un 400 ruidoso que se
 * descubre solo; agregarla ACÁ y olvidarse del resto hace que la ruta la acepte
 * y **nadie la lea** — 200 sin efecto, la clase de bug de WKH-322 reintroducida
 * por la puerta de atrás. Ningún test lo caza: `T-R30` enumera a mano a
 * propósito (CD-10), así que una clave nueva en este Set no pone nada en rojo.
 *
 * El orden de declaración es FIJO — el del contrato de W0.3 — porque el mensaje
 * del 400 se construye uniendo este Set, y un `Set` de JS itera en orden de
 * inserción: reordenar acá cambia el mensaje que ve el caller.
 *
 * Es *aproximadamente* alfabético, no alfabético (CR MNR-1): `minReputation` va
 * antes que `min_reputation`, y `sort()` los pone al revés — `'_'` (0x5F) es
 * menor que `'r'` (0x72), tanto en ASCII case-insensitive como con
 * `localeCompare(…, { sensitivity: 'base' })`. Están en ese orden a propósito,
 * para que el nombre canónico se lea primero y el alias después.
 *
 * Por qué está `min_reputation` y por qué NO están `capability` ni `query`:
 * - `min_reputation` YA es contrato público de esta misma API en otra superficie
 *   (`compose-step-shape.ts:51`, `constraints.min_reputation` de `/compose`). Un
 *   caller que leyó esa mitad de la documentación escribía el nombre "correcto" y
 *   `/discover` lo descartaba: el 400 sin este alias le cobraría una
 *   inconsistencia nuestra.
 * - `capability` (singular) y `query` no son contrato de ninguna superficie.
 *   `capability` es un singular plausible, y `query` es el nombre INTERNO del
 *   campo de texto libre del tipo `DiscoveryQuery` (`types/index.ts`), que la
 *   ruta traduce desde el `q` público. Aliasar por plausibilidad haría que el
 *   número de nombres válidos crezca con la imaginación de los callers.
 */
export const ALLOWED_DISCOVER_PARAMS: ReadonlySet<string> = new Set([
  'allowTrial',
  'capabilities',
  'includeInactive',
  'limit',
  'maxPrice',
  'minReputation',
  'min_reputation',
  'q',
  'registry',
  'verified',
]);

/**
 * Largo máximo del nombre de parámetro que el 400 devuelve textualmente
 * (AR MNR-4 de WKH-322).
 *
 * El nombre lo elige el caller: en un `POST /discover` una clave JSON puede
 * medir cientos de KB, porque `src/index.ts` construye Fastify sin `bodyLimit`
 * y el default son 1 MiB. Sin cota, **el cuerpo del 400 crecía con el input del
 * atacante** (amplificación ~1x hacia la respuesta). Eso, y sólo eso, es lo que
 * esta cota resuelve; está medido en `T-R35`/`T-R35b`.
 *
 * Lo que esta cota NO hace, para que nadie lo lea como cerrado (AR-2 MNR-1):
 * en `GET /discover?<nombre gigante>=1` el logger de Fastify (`src/index.ts:95`)
 * escribe `req.url` **completo**, con el nombre adentro, antes de llegar acá. La
 * cota vive en la respuesta, no en el request, así que esa línea de log sigue
 * creciendo con el input. Deuda con nombre: **TD-322-4** (`sdd.md`).
 * En POST no hay línea equivalente: el 400 sale por `reply.send()` sin log
 * (`routes/discover.ts:89-102`), un `reply.send()` no dispara el
 * `setErrorHandler` (`middleware/error-boundary.ts:72`) y `event-tracking.ts:117`
 * persiste `url.split('?')[0]`, o sea sin query string.
 *
 * 64 es holgado para todo nombre legítimo: el más largo de la allowlist es
 * `includeInactive`, de 15 unidades, y el 400 existe para que el caller
 * reconozca su typo — a las 64 unidades ya lo reconoció.
 */
export const MAX_ECHOED_PARAM_NAME_LENGTH = 64;

/**
 * Devuelve el nombre recibido ENTRE COMILLAS y acotado a
 * `MAX_ECHOED_PARAM_NAME_LENGTH`.
 *
 * Devuelve el fragmento entrecomillado completo, y no sólo el nombre, para que
 * la nota de truncado quede FUERA de las comillas: adentro, un caller (o un
 * grep) no podría distinguir el nombre de la anotación del server.
 *
 * Cuando trunca lo DICE, con el largo original: un caller cuyo nombre real mide
 * 200 caracteres tiene que poder distinguir "me lo recortaron" de "el server
 * cree que mi parámetro se llama así". Un truncado mudo sería la misma clase de
 * silencio que WKH-322 cierra, dentro del mensaje del error que la cierra.
 *
 * El nombre completo sigue disponible en la propiedad `received` de la
 * excepción, que NO viaja al caller: la ruta manda sólo `message` y `code`
 * (`discover.ts:98`).
 *
 * La unidad es la **unidad UTF-16**, y el mensaje lo dice con esa palabra
 * (AR-2 MNR-4): `String#length` cuenta unidades, no caracteres — 40 emojis dan
 * `length === 80`, y anunciar "80 characters" erosiona justo la distinción que
 * este anuncio existe para dar. El corte, en cambio, respeta el par suplente:
 * `slice(0, 64)` a secas puede dejar un suplente alto suelto y devolver un
 * string mal formado.
 */
function describeReceivedParamName(received: unknown): string {
  const name = String(received);
  if (name.length <= MAX_ECHOED_PARAM_NAME_LENGTH) return `'${name}'`;
  let cut = name.slice(0, MAX_ECHOED_PARAM_NAME_LENGTH);
  const lastUnit = cut.charCodeAt(cut.length - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) cut = cut.slice(0, -1);
  return `'${cut}' (truncated; the name sent was ${name.length} UTF-16 code units long)`;
}

/**
 * Clave de query/body que `/discover` no reconoce. La ruta la mapea a 400
 * `UNKNOWN_DISCOVER_PARAM`.
 *
 * Razón de ser: antes de WKH-322 la ruta leía por nombre las claves que le
 * interesaban y las demás no existían para ella, así que `?capability=x`
 * (singular) devolvía HTTP 200 con el catálogo entero — 23 agentes donde el
 * nombre correcto devolvía 1 — sin una sola señal de que el filtro no se aplicó.
 *
 * `/compose` ya rechaza toda clave desconocida en `step.constraints`
 * (`compose-step-shape.ts:176-185`), y ahí quedó escrito por qué: *"Decirle que
 * no se soporta es honesto; ignorarlo, no."* Lo que faltaba era la simetría, y la
 * asimetría era perversa: la superficie que COBRA era estricta y la GRATUITA era
 * permisiva — y la gratuita es donde el integrador decide a quién pagarle. Un
 * parámetro ignorado en la consulta gratis se paga en la llamada siguiente.
 *
 * Alcance de este guard, para que no se lea de más: cubre las dos rutas raíz
 * (`GET /discover` y `POST /discover`). `GET /discover/:slug` NO lo usa y sigue
 * descartando sus query params desconocidos (deuda TD-322-1).
 */
export class UnknownDiscoverParamError extends Error {
  readonly code = 'UNKNOWN_DISCOVER_PARAM' as const;
  constructor(readonly received: unknown) {
    super(
      `unknown parameter ${describeReceivedParamName(received)}. Accepted parameters: ${[
        ...ALLOWED_DISCOVER_PARAMS,
      ].join(', ')}`,
    );
    this.name = 'UnknownDiscoverParamError';
  }
}

/**
 * Los dos nombres de reputación llegaron juntos con valores normalizados
 * distintos. La ruta la mapea a 400 `CONFLICTING_MIN_REPUTATION`.
 *
 * Se eligió 400 y no una regla de precedencia con un caso concreto:
 * `?minReputation=0&min_reputation=5` (default de plantilla + override explícito)
 * bajo "gana el camelCase" devolvería `0`, o sea el piso explícito del caller
 * descartado en silencio — la misma clase de bug que WKH-322 cierra, con el signo
 * invertido.
 */
export class ConflictingMinReputationError extends Error {
  readonly code = 'CONFLICTING_MIN_REPUTATION' as const;
  constructor(readonly received: unknown) {
    super(
      'minReputation and min_reputation are aliases and were sent with different values; send only one (they are the same filter, so two different values cannot both be honored)',
    );
    this.name = 'ConflictingMinReputationError';
  }
}

/**
 * El body del `POST /discover` llegó con una forma que no tiene claves nombradas
 * (array o primitivo). La ruta la mapea a 400 `INVALID_DISCOVER_BODY`.
 *
 * Tiene código propio, y no reutiliza `UNKNOWN_DISCOVER_PARAM`, porque la causa es
 * otra: sobre `[1,2]`, `Object.keys` devuelve `['0','1']` y el mensaje diría
 * `unknown parameter '0'` — ruidoso e incomprensible. `null`/`undefined` NO caen
 * acá: se tratan como body vacío, que es el comportamiento vigente.
 */
export class InvalidDiscoverBodyError extends Error {
  readonly code = 'INVALID_DISCOVER_BODY' as const;
  constructor(readonly received: unknown) {
    super('request body must be a JSON object of discover parameters');
    this.name = 'InvalidDiscoverBodyError';
  }
}

/**
 * Lanza `UnknownDiscoverParamError` si `raw` trae UNA clave fuera de
 * `ALLOWED_DISCOVER_PARAMS`. El mensaje nombra esa clave Y enumera las aceptadas,
 * para que el caller pueda corregir sin abrir la documentación: un 400 que no
 * dice el nombre bueno convierte un typo de un carácter en media hora de
 * búsqueda.
 *
 * Determinismo: el mismo objeto de entrada produce siempre el mismo mensaje. Lo
 * que NO se promete es que la clave reportada sea "la primera que escribió el
 * caller": `Object.keys` enumera primero las claves con forma de índice entero,
 * en orden numérico, antes que las demás, así que con `?1=a&capability=b` el
 * error reporta `'1'`. (Tampoco se ordena alfabéticamente: eso escondería todavía
 * más la clave que el caller lee primero.)
 */
export function assertKnownDiscoverParams(raw: Record<string, unknown>): void {
  const unknownKey = Object.keys(raw).find(
    (k) => !ALLOWED_DISCOVER_PARAMS.has(k),
  );
  if (unknownKey !== undefined) throw new UnknownDiscoverParamError(unknownKey);
}

/**
 * Colapsa los dos nombres del piso de reputación (`minReputation` camelCase y su
 * alias `min_reputation`) en UN valor.
 *
 * Los dos crudos pasan por `parseMinReputation`, el MISMO validador de rango
 * `[0,100]`: un valor inválido por cualquiera de los dos nombres da el mismo
 * `InvalidMinReputationError`, y aguas abajo de esta función hay un solo camino
 * (el campo `minReputation` del `DiscoveryQuery`), así que las dos ramas no
 * pueden divergir en el filtrado.
 *
 * La comparación de conflicto es entre los valores NORMALIZADOS, no entre los
 * crudos: `('5', 5)` y `('5', '5.0')` colapsan a `5` sin conflicto. Un vacío
 * (`''`/`null`/ausente) parsea a `undefined` y cuenta como ausente, así que
 * `?minReputation=5&min_reputation=` devuelve `5`.
 */
export function resolveMinReputation(
  camelRaw: unknown,
  snakeRaw: unknown,
): number | undefined {
  const camel = parseMinReputation(camelRaw);
  const snake = parseMinReputation(snakeRaw);
  if (camel !== undefined && snake !== undefined && camel !== snake) {
    throw new ConflictingMinReputationError({
      minReputation: camel,
      min_reputation: snake,
    });
  }
  return camel ?? snake;
}
