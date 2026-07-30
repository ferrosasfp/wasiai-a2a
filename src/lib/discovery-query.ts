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
