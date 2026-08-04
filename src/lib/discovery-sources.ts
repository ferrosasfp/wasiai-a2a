/**
 * WKH-318 — el vocabulario de la honestidad del catálogo.
 *
 * Módulo LEAF: CERO imports de runtime (sólo `import type`). Ver el docstring de
 * `discovery-fetch-limit.ts:1-11` — `routes/compose.ts` y `services/compose.ts`
 * necesitan estas funciones, y media docena de suites mockean
 * `../services/discovery.js` COMPLETO con factories sin `importOriginal`, así que
 * un export nuevo del service quedaría `undefined` ahí.
 */
import type {
  CatalogStatus,
  DiscoverySource,
  DiscoverySourceFailure,
  FailedSourceRef,
  ReportedTotal,
} from '../types/index.js';

/**
 * Error de un registro que respondió con un status no-2xx.
 *
 * Existe para que el fanout pueda clasificar `http_error` sin parsear el mensaje.
 * El `message` se mantiene BYTE-IDÉNTICO al `Error` genérico que había antes
 * (`Registry ${name} returned ${status}`) para no romper ningún test que lo asserte.
 *
 * ⚠️ Se sigue tirando FUERA de `cb.execute` — buscá `throw new RegistryHttpError`
 * en `services/discovery.ts` (por texto, no por número de línea: esta misma HU ya
 * movió esa función y dejó el puntero viejo apuntando a otra). Esta HU NO cambia
 * la semántica del circuit breaker — ver TD-318-1.
 */
export class RegistryHttpError extends Error {
  public readonly status: number;
  constructor(registryName: string, status: number) {
    super(`Registry ${registryName} returned ${status}`);
    this.name = 'RegistryHttpError';
    this.status = status;
  }
}

/**
 * Roll-up. Precedencia: `partial` > `truncated` > `unverified` > `complete`.
 *
 * El orden es "de lo más conocido y peor, a lo menos conocido": una fuente caída
 * (sabemos que falta) manda sobre una truncada (sabemos que falta menos), y
 * cualquiera de las dos manda sobre no-saber. `unverified` va último entre los
 * no-completos porque es el único que no afirma nada.
 *
 * `complete` es el ÚNICO valor que afirma algo fuerte —"todas las fuentes
 * probaron haber dado todo"— y por eso es el que necesita que NADA lo contradiga
 * y que nadie se haya quedado sin poder probarlo.
 *
 * Sin fuentes (ningún registro habilitado y ninguna fuente local consultada) ⇒
 * `complete`: no hay nada que haya fallado NI nada cuya completitud haya quedado
 * sin probar. Eso NO es una suposición optimista — es que el conjunto de cosas
 * que podrían haber fallado está vacío.
 */
export function buildCatalogStatus(
  sources: readonly DiscoverySource[],
): CatalogStatus {
  if (sources.some((s) => s.state === 'failed')) return 'partial';
  if (sources.some((s) => s.state === 'truncated')) return 'truncated';
  if (sources.some((s) => s.state === 'unverified')) return 'unverified';
  return 'complete';
}

/**
 * HU-323 — LA ÚNICA expresión de "este total se sabe" (mismo criterio CD-11 que
 * `isCatalogComplete`).
 *
 * `total` sale de contar el conjunto candidato. Ese conteo sólo es EL TOTAL si el
 * conjunto candidato tiene todo lo que hay; cuando el catálogo llegó recortado, el
 * mismo número deja de ser un total y pasa a ser una cota inferior. Publicarlo
 * igual, con el nombre `total`, es rellenar un dato desconocido con el que hay a
 * mano.
 *
 * Los dos estados que PRUEBAN que falta algo:
 *   · `truncated` — una fuente declaró que hay más filas (cursor) o su página
 *     llegó llena hasta el límite que le enviamos.
 *   · `partial`   — una fuente no se pudo consultar; sus matches no están
 *     contados y no hay forma de saber cuántos eran.
 *
 * `unverified` queda AFUERA a propósito, y la distinción es la misma que la del
 * roll-up (`buildCatalogStatus`): es "no pude probar que no falta", no "sé que
 * falta". No hay evidencia de ninguna fila ausente. Meterlo acá haría que `total`
 * fuera `'unknown'` en todo camino contra un registro que no declara cursor,
 * o sea casi siempre, y un campo que nunca tiene número no informa nada.
 * `complete` es, por definición, el caso en que el conteo SÍ es el total.
 */
export function resolveReportedTotal(
  counted: number,
  status: CatalogStatus,
): ReportedTotal {
  return status === 'truncated' || status === 'partial' ? 'unknown' : counted;
}

/**
 * Clasifica el motivo por el que no se pudo consultar una fuente.
 *
 * Se clasifica por `err.name` y NO por `instanceof`, a propósito: importar
 * `url-validator.js` o `circuit-breaker.js` acá rompería la propiedad de módulo
 * leaf. Las dos clases setean `this.name` en su constructor
 * (`url-validator.ts:65`, `circuit-breaker.ts:27`), así que el nombre es
 * estructuralmente confiable.
 *
 * Default `'unknown'`: un motivo que no reconocemos sigue siendo un FALLO. Nunca
 * degrada a `ok`.
 */
export function classifyFetchFailure(err: unknown): DiscoverySourceFailure {
  if (!(err instanceof Error)) return 'unknown';
  switch (err.name) {
    case 'SSRFViolationError':
      return 'ssrf_blocked';
    case 'CircuitOpenError':
      return 'circuit_open';
    case 'RegistryHttpError':
      return 'http_error';
    case 'AbortError':
    case 'TimeoutError':
      return 'timeout';
    default:
      return 'unknown';
  }
}

/**
 * LA ÚNICA expresión de "el catálogo está completo" (CD-11).
 *
 * FAIL-CLOSED (CD-13): `undefined` NO es completo. Una respuesta previa a esta
 * HU, o un mock que no setea el campo, se lee como *no sé* — y en modo estricto
 * *no sé* se rechaza. Escribir `!== 'partial'` acá reintroduce exactamente el bug
 * que esta HU mata.
 */
export function isCatalogComplete(
  result: { catalogStatus?: CatalogStatus } | null | undefined,
): boolean {
  return result?.catalogStatus === 'complete';
}

/** Proyección mínima de las fuentes caídas, para los cuerpos de error del money-path. */
export function listFailedSources(
  sources: readonly DiscoverySource[],
): FailedSourceRef[] {
  return sources
    .filter((s) => s.state === 'failed')
    .map((s) => ({ name: s.name, failure: s.failure ?? 'unknown' }));
}

/**
 * Mensaje del rechazo. Nombra la FUENTE y el MOTIVO, y nunca dice "no agents"
 * (CD-15): el motivo es *no pude preguntar*, no *pregunté y no hay*.
 */
export function describeIncompleteCatalog(
  failed: readonly FailedSourceRef[],
): string {
  if (failed.length === 0) {
    return 'The agent catalog is incomplete (a source returned a truncated page) and this request asked for a complete one';
  }
  const list = failed.map((f) => `'${f.name}' (${f.failure})`).join(', ');
  return `Could not query registry ${list}; the agent catalog is incomplete and this request asked for a complete one`;
}
