/**
 * Ranking Tiebreak — HU-208 · desempate ALEATORIO del ranking de discovery.
 *
 * ─── El sesgo que corrige ────────────────────────────────────────────────
 * El comparador de `runDiscoveryPipeline` ordena por verified → reputación →
 * precio. Cuando los tres criterios EMPATAN, el ganador lo decidía el orden del
 * arreglo, que sale de cómo se concatenaron las fuentes (`results.flat()` +
 * self-published). Eso es un sesgo POSICIONAL invisible: el agente que quedó
 * primero por un accidente de implementación gana siempre, y para siempre.
 *
 * Dos agentes con idéntica identidad, reputación y precio merecen la misma
 * chance. Un marketplace que ante un empate devuelve siempre al mismo está
 * repartiendo ingresos por el orden de un `concat`.
 *
 * ─── Por qué un valor POR AGENTE y no un `shuffle` previo ────────────────
 * Las dos opciones funcionan, pero esta es la correcta acá:
 *
 *  1. NO SE PUEDE llamar al aleatorio DENTRO del comparador. `Array.sort` exige
 *     una relación de orden consistente: si `cmp(a,b)` devuelve cosas distintas
 *     cada vez que se lo invoca, el resultado del sort queda INDEFINIDO por
 *     especificación (V8 puede incluso devolver un arreglo con elementos
 *     duplicados o perdidos). Por eso el valor se asigna UNA sola vez por
 *     agente, ANTES de ordenar, y el comparador se limita a leerlo: la relación
 *     vuelve a ser total, antisimétrica y transitiva, y el orden es estable
 *     dentro de una misma request.
 *
 *  2. Un `shuffle` previo + sort estable daría el mismo reparto, pero apoyado en
 *     una propiedad IMPLÍCITA (que el sort de V8 sea estable) y en un lugar
 *     distinto del criterio. Quien lea el comparador no vería el desempate por
 *     ningún lado, y un re-sort en otra capa lo desharía en silencio. Acá el
 *     desempate está escrito donde vive el criterio.
 *
 * ─── Determinismo en tests ───────────────────────────────────────────────
 * La fuente de aleatoriedad es INYECTABLE. Un test que no la fije y dependa del
 * orden entre empatados sería un flake, y un flake en el ranking es
 * particularmente feo: aparece una vez cada tantas corridas y manda a investigar
 * el lugar equivocado.
 */

/** Fuente de aleatoriedad. Reemplazable SOLO desde tests. */
let randomSource: () => number = Math.random;

/**
 * TEST-ONLY: fija la fuente de aleatoriedad para volver determinista el
 * desempate. NO importar desde código de producción.
 * (Mismo patrón que `_resetFallbackWarnDedup` / `_resetAgentPriceCache`.)
 */
export function _setTiebreakRandomSource(fn: () => number): void {
  randomSource = fn;
}

/** TEST-ONLY: restaura `Math.random`. */
export function _resetTiebreakRandomSource(): void {
  randomSource = Math.random;
}

/**
 * Asigna a cada elemento un valor de desempate, UNA sola vez.
 *
 * Se devuelve un `Map` en vez de escribir el valor en el objeto a propósito: el
 * `Agent` se serializa en la respuesta de `/discover`, y un campo interno de
 * ranking no tiene por qué viajar al cliente (ni volverse contrato accidental).
 */
export function assignTiebreaks<T extends object>(items: T[]): Map<T, number> {
  const map = new Map<T, number>();
  for (const item of items) {
    map.set(item, randomSource());
  }
  return map;
}

/**
 * Último criterio del comparador: desempata por el valor ya asignado.
 *
 * Devuelve 0 si a algún elemento le falta valor (imposible por construcción, pero
 * un `undefined` propagado a una resta daría `NaN`, y un `NaN` en un comparador
 * vuelve a dejar el sort indefinido — exactamente el bug que este módulo evita).
 */
export function compareTiebreak<T extends object>(
  tiebreaks: Map<T, number>,
  a: T,
  b: T,
): number {
  const ta = tiebreaks.get(a);
  const tb = tiebreaks.get(b);
  if (typeof ta !== 'number' || typeof tb !== 'number') return 0;
  return ta - tb;
}
