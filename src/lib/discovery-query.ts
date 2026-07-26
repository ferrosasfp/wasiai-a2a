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
