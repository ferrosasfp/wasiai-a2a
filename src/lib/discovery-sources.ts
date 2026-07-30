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
} from '../types/index.js';

/**
 * Error de un registro que respondió con un status no-2xx.
 *
 * Existe para que el fanout pueda clasificar `http_error` sin parsear el mensaje.
 * El `message` se mantiene BYTE-IDÉNTICO al `Error` genérico que había antes
 * (`Registry ${name} returned ${status}`) para no romper ningún test que lo asserte.
 *
 * ⚠️ Se sigue tirando FUERA de `cb.execute` (`discovery.ts:631`). Esta HU NO
 * cambia la semántica del circuit breaker — ver TD-318-1.
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
 * Roll-up. Precedencia: `partial` > `truncated` > `complete`.
 *
 * Sin fuentes (ningún registro habilitado, sólo self-published) ⇒ `complete`:
 * no hay nada que haya fallado. Eso NO es una suposición optimista — es que el
 * conjunto de cosas que podrían haber fallado está vacío.
 */
export function buildCatalogStatus(
  sources: readonly DiscoverySource[],
): CatalogStatus {
  if (sources.some((s) => s.state === 'failed')) return 'partial';
  if (sources.some((s) => s.state === 'truncated')) return 'truncated';
  return 'complete';
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
