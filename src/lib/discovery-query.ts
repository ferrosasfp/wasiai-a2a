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
    super('limit must be an integer >= 1');
    this.name = 'InvalidLimitError';
  }
}

/**
 * Normaliza y VALIDA el `limit` entrante (string del query string o number del
 * body JSON). Ausente/vacío → `undefined` (sin page size: se devuelven todos los
 * matches, comportamiento de hoy). Cualquier otra cosa que no sea un entero
 * finito `>= 1` → lanza `InvalidLimitError`.
 *
 * NO se impone techo: el over-fetch (`resolveUpstreamFetchLimit`) es monótono a
 * propósito — un caller que pide `limit=500` fetchea 500. Meter un techo acá
 * sería reintroducir el bug de clase "esconder agentes" que arregló el hallazgo 1.
 */
export function parseLimit(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new InvalidLimitError(raw);
  return n;
}
