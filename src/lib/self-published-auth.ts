/**
 * Credencial OUTBOUND del gateway hacia agentes SELF-PUBLISHED.
 *
 * ── EL AGUJERO QUE CIERRA ────────────────────────────────────────────────────
 * `services/compose.ts:invokeAgent` resuelve las cabeceras de auth buscando la
 * fila del registry del agente (`registries.find(r => r.name === agent.registry)`).
 * Para un agente self-published `agent.registry` es `'self-published'`, un nombre
 * SINTÉTICO (`types/index.ts:217-218`) que NO existe como fila en `registries`:
 * el `find` devuelve `undefined`, `buildAuthHeaders(undefined)` devuelve `{}` y
 * `registryIsSystemTrusted` es `false`. O sea: HOY NINGÚN agente self-published
 * puede recibir una credencial del gateway, y no es el caso de un agente puntual
 * sino de toda la superficie self-published.
 *
 * ── POR QUÉ ESTO NO PUEDE SER "MANDARLE EL BEARER A LOS SELF-PUBLISHED" ───────
 * Un agente self-published lo publica CUALQUIER caller autenticado
 * (`POST /agents`), y su `agentUrl` apunta a un host que nosotros no controlamos
 * (el guard SSRF sólo bloquea IPs privadas: un dominio PÚBLICO del atacante pasa,
 * y `url-validator.ts:251` incluso admite `http:`). Mandar una credencial "a los
 * self-published" es filtrarle el secreto a todo el que publique un agente.
 *
 * Es EXACTAMENTE el vector que el fix C1 (audit 2026-07-01) cerró del lado de los
 * registries auto-registrados, un escalón más abajo. Por eso el predicado que
 * habilita el envío tiene que ser uno que el publicador NO pueda influir:
 *
 *   - `agent.registry_id === 'self-published'` NO sirve como guard: el `registry_id`
 *     de un agente federado sale del registry que lo sirve, y `'self-published'` no
 *     tiene fila propia, así que un atacante puede `POST /registries` con
 *     name `self-published` y sus agentes federados salen con ese `registry_id`.
 *   - `owner_ref` del publicador sí es infalsificable (`routes/agents.ts:265` lo
 *     toma de la a2a-key), pero NO viaja en el `Agent` de discovery (CD-10) y
 *     leerlo obligaría a un SELECT extra por step en la ruta más caliente.
 *
 * ── EL GUARD ELEGIDO: UN SECRETO POR DESTINO, DECLARADO POR EL OPERADOR ───────
 * `A2A_SELF_PUBLISHED_OUTBOUND_AUTH` es un JSON `{ "<host>": "<secreto>" }`. El
 * bearer viaja SÓLO si el host del `invokeUrl` es una clave del mapa, y viaja el
 * secreto DE ESE HOST (no uno compartido: el host A no puede reusar el suyo
 * contra el host B). Un atacante no puede meterse en el mapa porque el mapa es
 * una env var del deploy, no un dato que se publique por API.
 *
 * Propiedades que sostienen el diseño:
 *   1. FAIL-CLOSED POR DEFECTO. Variable ausente → mapa vacío → NADIE recibe nada
 *      → el comportamiento es byte-idéntico al de hoy. El cambio es INERTE hasta
 *      que un operador nombre destinos, uno por uno.
 *   2. SÓLO SOBRE TLS. Un `http://` en el mapa NO recibe el secreto (mandarlo en
 *      claro sería filtrarlo en el camino). `url-validator` admite `http:`, así
 *      que este guard es aditivo y no redundante.
 *   3. NUNCA la credencial del CALLER. Este módulo emite el secreto del GATEWAY
 *      hacia el destino. El `x-a2a-key` del caller sigue gobernado por C1 y sigue
 *      SIN viajar a self-published (`compose.ts` no toca `registryIsSystemTrusted`).
 *
 * ── MAL ESCRITA → NO ARRANCA ─────────────────────────────────────────────────
 * Mismo criterio que `A2A_DEPOSIT_MIN_USDC` (`lib/env.ts:107`): una variable
 * PRESENTE pero ilegible es el caso en el que el operador CREE tener la credencial
 * puesta. Si degradara a `{}` en silencio, el síntoma sería un 401 eterno del otro
 * lado y nadie miraría acá. Ausente, en cambio, es un estado válido y silencioso.
 */

/** Nombre de la env var. Único lugar donde se escribe (sin literales sueltos). */
export const SELF_PUBLISHED_AUTH_ENV = 'A2A_SELF_PUBLISHED_OUTBOUND_AUTH';

/**
 * Estado PÚBLICO de la variable. NO lleva los secretos: el mapa resuelto vive
 * sólo en el resultado interno de `parseEnv`, para que ningún consumidor pueda
 * loguear el status completo y arrastrar una credencial al log.
 */
export type SelfPublishedAuthEnvStatus =
  /** Variable ausente o vacía. Estado válido: nadie recibe credencial. */
  | { state: 'absent' }
  /** Mapa legible. `hosts` = destinos declarados (>= 1). */
  | { state: 'configured'; hosts: string[] }
  /** Presente pero inservible. `reason` es apto para el mensaje de arranque. */
  | { state: 'invalid'; reason: string };

/** Resultado INTERNO: igual que el público pero con el mapa host → secreto. */
type ParsedEnv =
  | { state: 'absent' }
  | { state: 'configured'; hosts: string[]; secrets: Map<string, string> }
  | { state: 'invalid'; reason: string };

/**
 * Canonicaliza una clave del mapa a un `hostname` comparable con el que produce
 * `new URL(invokeUrl).hostname` (minúsculas, punycode, sin punto final).
 *
 * Rechaza (devolviendo `null`) cualquier clave que no sea EXACTAMENTE un host:
 * con esquema, con puerto, con userinfo, con path/query/fragment. Un `host:8443`
 * aceptado como clave sería un destino que nunca matchea (el `hostname` del URL
 * no lleva puerto) — es decir, credencial que nunca sale, en silencio.
 */
function canonicalizeHostKey(raw: string): string | null {
  if (raw.trim() !== raw || raw.length === 0) return null;
  if (raw.includes('/') || raw.includes('@') || raw.includes(':')) return null;
  let parsed: URL;
  try {
    parsed = new URL(`https://${raw}`);
  } catch {
    return null;
  }
  if (parsed.port !== '') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
    return null;
  }
  if (parsed.hostname.length === 0) return null;
  return parsed.hostname;
}

/**
 * Lee y valida la env var. NO cachea, a propósito y por el mismo motivo que
 * `isProduction()` (`lib/env.ts:7`): el valor se evalúa en cada llamada para que
 * la semántica no dependa del momento del import. El costo (un `JSON.parse` de
 * un objeto de pocas claves) es despreciable frente al request HTTP saliente que
 * está a punto de ocurrir en la misma línea.
 */
function parseEnv(): ParsedEnv {
  const raw = process.env[SELF_PUBLISHED_AUTH_ENV];
  if (raw === undefined || raw.trim().length === 0) return { state: 'absent' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      state: 'invalid',
      reason: 'no es JSON válido',
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      state: 'invalid',
      reason: 'no es un objeto JSON plano { "<host>": "<secreto>" }',
    };
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    return {
      state: 'invalid',
      reason:
        'es un mapa VACÍO, que no le da la credencial a nadie. Si la intención ' +
        'es no mandar credencial a ningún agente self-published, borrá la ' +
        'variable en vez de dejarla en {} (ausente es el estado válido para eso)',
    };
  }

  const hosts: string[] = [];
  const secrets = new Map<string, string>();
  for (const [key, value] of entries) {
    const host = canonicalizeHostKey(key);
    if (host === null) {
      return {
        state: 'invalid',
        reason: `la clave "${key}" no es un host (se espera sólo el host, sin esquema, sin puerto, sin path)`,
      };
    }
    if (hosts.includes(host)) {
      return {
        state: 'invalid',
        reason: `el host "${host}" aparece dos veces (las claves se comparan canonicalizadas: minúsculas + punycode)`,
      };
    }
    if (typeof value !== 'string' || value.length === 0) {
      return {
        state: 'invalid',
        reason: `el secreto de "${host}" no es un string no vacío`,
      };
    }
    if (value.trim() !== value) {
      // No se trimea en silencio: un secreto con espacios de borde es un error
      // de pegado, y "arreglarlo" callado manda una credencial DISTINTA de la
      // que el operador cree haber puesto.
      return {
        state: 'invalid',
        reason: `el secreto de "${host}" tiene espacios al principio o al final (probable error de pegado; el valor NO se trimea en silencio)`,
      };
    }
    hosts.push(host);
    secrets.set(host, value);
  }

  return { state: 'configured', hosts, secrets };
}

/**
 * Estado público de la variable (sin secretos). Envoltura de `parseEnv` para los
 * consumidores que sólo necesitan saber en qué estado quedó la configuración.
 */
export function classifySelfPublishedAuthEnv(): SelfPublishedAuthEnvStatus {
  const parsed = parseEnv();
  if (parsed.state !== 'configured') return parsed;
  return { state: 'configured', hosts: parsed.hosts };
}

/**
 * Assertion de arranque. Presente-pero-ilegible → THROW (no bootea, y la revisión
 * anterior sigue sirviendo). Ausente → no-op silencioso: es un estado válido.
 *
 * Devuelve la lista de destinos declarados (vacía si la variable está ausente)
 * para que el arranque pueda LOGUEAR a quién se le va a mandar credencial. Los
 * SECRETOS nunca salen de este módulo hacia el log: sólo los hosts.
 */
export function assertSelfPublishedAuthEnv(): string[] {
  const status = classifySelfPublishedAuthEnv();
  if (status.state === 'absent') return [];
  if (status.state === 'invalid') {
    throw new Error(
      `${SELF_PUBLISHED_AUTH_ENV} está MAL ESCRITA: ${status.reason}. ` +
        'La variable ESTÁ presente, así que no es un olvido: es el valor lo que el ' +
        'gateway no puede leer, y con el ilegible NINGÚN agente self-published recibe ' +
        'credencial (el síntoma del otro lado es un 401 permanente, que no apunta acá). ' +
        'Formato esperado: un objeto JSON plano de host a secreto, por ejemplo ' +
        '{"agents.example.com":"<secreto>"}. La clave es SÓLO el host (sin esquema, ' +
        'sin puerto, sin path) y el destino debe ser https. Para no mandar credencial ' +
        'a nadie, borrá la variable. Ver .env.example. Se rechaza el arranque para no ' +
        'quedar con la credencial apagada y sin aviso.',
    );
  }
  return status.hosts;
}

/**
 * Resuelve las cabeceras de auth OUTBOUND para el `invokeUrl` de un agente
 * self-published. `{}` (sin credencial) en todos estos casos:
 *   - variable ausente, vacía o ilegible (fail-closed);
 *   - `invokeUrl` no parseable;
 *   - `invokeUrl` que no es https (no se manda un secreto en claro);
 *   - host del `invokeUrl` NO declarado en el mapa.
 *
 * El `Bearer` emitido es el MISMO shape que produce `buildAuthHeaders` para un
 * registry `auth.type === 'bearer'` (`compose.ts:180-182`): el destino no tiene
 * que distinguir de dónde salió.
 */
export function resolveSelfPublishedAuthHeaders(
  invokeUrl: string,
): Record<string, string> {
  const parsed = parseEnv();
  if (parsed.state !== 'configured') return {};

  let target: URL;
  try {
    target = new URL(invokeUrl);
  } catch {
    return {};
  }
  // Sólo sobre TLS: `url-validator.ts:251` admite `http:`, así que sin este
  // chequeo un destino declarado en el mapa pero servido en claro filtraría el
  // secreto en tránsito.
  if (target.protocol !== 'https:') return {};

  const secret = parsed.secrets.get(target.hostname);
  if (secret === undefined) return {};
  return { Authorization: `Bearer ${secret}` };
}
