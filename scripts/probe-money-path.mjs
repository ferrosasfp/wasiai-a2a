#!/usr/bin/env node
/**
 * @file probe-money-path.mjs
 * @description Sonda del camino del dinero — Corte A: la cotización (WKH-364).
 *
 * `GET /discover/<slug>` → `deriveInput(inputSchema)` → `POST /compose` → `classify()`,
 * contra los servicios VIVOS, con CUATRO CÓDIGOS DE SALIDA DISTINTOS para que el exit
 * code solo ya atribuya la causa:
 *   0 PASS · 2 caída candidata · 3 config de la sonda · 4 contrato cambiado
 *   1 excepción no manejada (defecto de la sonda) · 5 se aceptó un cuerpo inválido
 *
 * La regla central NO es "sondear": es que **cuando no puede derivar un valor, la sonda
 * falla ruidosamente en vez de inventarlo**. El cuerpo se deriva del `inputSchema` que
 * el catálogo publica EN ESA MISMA CORRIDA; ningún campo se copia de memoria. Falsable:
 * si alguien lo hardcodeara, `deriveInput` dejaría de leer su argumento y el caso
 * `enum: ["plin","yape"] → "plin"` de la suite se pone rojo.
 *
 * ⛔ Esta sonda OBSERVA: su único método no-GET es el único `POST /compose`.
 * ⛔ Nunca imprime la credencial, ni entera ni truncada: el repo es PÚBLICO.
 */

import { createHash } from 'node:crypto';

export const BASE_URL = 'https://wasiai-a2a-production.up.railway.app';
export const AGENT_SLUG = 'remit-corridor-fx-solana';

/** Monto de la sonda. NO sale del schema: el schema publica una RESTRICCIÓN, no un monto. */
const DEFAULT_AMOUNT_USD = 25;

/**
 * Techos de espera: decisión de la sonda, no del contrato. El del pipeline es largo
 * porque invoca a un agente remoto y un techo corto convertiría una corrida lenta en
 * una "caída" — el falso rojo que esta HU existe para no producir.
 */
const DISCOVER_TIMEOUT_MS = 15_000;
const COMPOSE_TIMEOUT_MS = 120_000;
const RETRY_WAIT_MS = 2_000;

/**
 * Los 6 códigos del MIDDLEWARE (`src/middleware/a2a-key.ts:105-111`), que viajan con la
 * grafía snake `error_code`. ⚠️ De ESE union se removió `SCOPE_DENIED`, y eso NO quiere
 * decir que `/compose` no lo emita: lo emite el OTRO productor de 403, acá abajo.
 */
const CREDENTIAL_ERROR_CODES = new Set([
  'KEY_NOT_FOUND',
  'KEY_INACTIVE',
  'DAILY_LIMIT',
  'INSUFFICIENT_BUDGET',
  'PER_CALL_LIMIT',
  'CHAIN_NOT_SUPPORTED',
]);

/**
 * El SEGUNDO productor de 403 de `/compose`: la RUTA (`src/routes/compose.ts:1113`), que
 * responde el resultado del pipeline con la grafía camel `errorCode`. Sus cuatro causas
 * (`src/services/authz.ts`) son propiedades de la KEY del caller — registry, slug o
 * categoría fuera de su scope, o costo estimado sobre su tope por llamada — o sea
 * exactamente lo que produce una key de sonda creada con scope propio. Leer eso como
 * caída de producción sería repetir el defecto de origen: mandar a alguien a mirar la
 * infra por una propiedad de la credencial de la sonda.
 */
const SCOPE_ERROR_CODES = new Set(['SCOPE_DENIED']);

/** Los códigos con que el gateway rechaza el CUERPO antes del débito. */
const GATEWAY_BODY_CODES = new Set(['VALIDATION_ERROR', 'ambiguous_step']);

/** Rechazos a nivel conexión: los únicos que se reintentan. */
const CONNECTION_ERRORS = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ECONNRESET',
  'EAI_AGAIN',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const verdict = (klass, exit, message) => ({ klass, exit, message });

// ── Credencial ────────────────────────────────────────────────────────────────

/** Pura. ⛔ El valor que devuelve NO se imprime en ningún camino.
 * @returns {{run: boolean, key?: string, reason?: string}} */
export function readCredential(env = process.env) {
  const key = String(env.A2A_PROBE_KEY ?? '').trim();
  if (key) return { run: true, key };
  return { run: false, reason: 'A2A_PROBE_KEY ausente o vacía' };
}

// ── Derivación del cuerpo ─────────────────────────────────────────────────────

/** Candidatos para una propiedad numérica: el monto de la sonda y las cotas PUBLICADAS. */
function numericCandidates(spec, amount) {
  const out = [amount];
  if (typeof spec.minimum === 'number') out.push(spec.minimum);
  if (typeof spec.maximum === 'number') out.push(spec.maximum);
  // Sólo para enteros se puede cruzar una cota exclusiva sin inventar un delta:
  // el "+1" lo da el TIPO publicado, no la sonda. Para `number` no hay épsilon
  // que no sea inventado, así que ese caso cae en no-derivable a propósito.
  if (spec.type === 'integer') {
    if (typeof spec.exclusiveMinimum === 'number') out.push(spec.exclusiveMinimum + 1);
    if (typeof spec.exclusiveMaximum === 'number') out.push(spec.exclusiveMaximum - 1);
  }
  return out;
}

function satisfiesBounds(v, spec) {
  if (typeof spec.exclusiveMinimum === 'number' && !(v > spec.exclusiveMinimum)) return false;
  if (typeof spec.minimum === 'number' && !(v >= spec.minimum)) return false;
  if (typeof spec.exclusiveMaximum === 'number' && !(v < spec.exclusiveMaximum)) return false;
  if (typeof spec.maximum === 'number' && !(v <= spec.maximum)) return false;
  if (spec.type === 'integer' && !Number.isInteger(v)) return false;
  return true;
}

/** @returns {{ok: true, value: unknown} | {ok: false, detail: string}} */
function deriveValue(spec, amount) {
  if (spec === null || typeof spec !== 'object') return { ok: false, detail: 'spec-no-es-objeto' };
  if ('enum' in spec) {
    if (!Array.isArray(spec.enum) || spec.enum.length === 0) return { ok: false, detail: 'enum-vacio-o-no-array' };
    return { ok: true, value: spec.enum[0] };
  }
  if (spec.type === 'number' || spec.type === 'integer') {
    for (const c of numericCandidates(spec, amount)) {
      if (satisfiesBounds(c, spec)) return { ok: true, value: c };
    }
    return { ok: false, detail: 'cotas-insatisfacibles' };
  }
  if (spec.type === 'string') return { ok: false, detail: 'string-libre-sin-enum' };
  return { ok: false, detail: `tipo-no-derivable:${String(spec.type)}` };
}

/**
 * Deriva el cuerpo del pipeline del `inputSchema` recibido en ESTA corrida. Pura.
 *
 * Lo no derivable y OPCIONAL se omite (omitir un campo opcional es conforme al schema);
 * lo no derivable y REQUERIDO devuelve `{reason:'required-not-derivable', field}` SIN
 * `input`, que es la señal de contrato cambiado. ⛔ Nunca un valor inventado.
 *
 * Con el schema de HOY eso produce exactamente una omisión: `destCountry`, un `string`
 * libre que NO está en `required`. ⚠️ No es una excepción escrita acá —el nombre no
 * aparece en el código, y un test lo verifica— sino el resultado de aplicar la regla al
 * schema de esa corrida: el día que ese campo entre a `required`, la MISMA regla lo
 * convierte en DRIFT ruidoso en vez de inventarle un valor.
 *
 * @returns {{input: object, omitted: string[]} | {omitted: string[], reason: string, field: string, detail: string}}
 */
export function deriveInput(inputSchema, opts = {}) {
  const amount = typeof opts.amountUsd === 'number' ? opts.amountUsd : DEFAULT_AMOUNT_USD;
  const required = Array.isArray(inputSchema?.required) ? inputSchema.required : [];
  const props = inputSchema?.properties;
  const properties = props !== null && typeof props === 'object' ? props : {};
  const input = {};
  const omitted = [];
  for (const [name, spec] of Object.entries(properties)) {
    const d = deriveValue(spec, amount);
    if (d.ok) input[name] = d.value;
    else if (required.includes(name)) return { omitted, reason: 'required-not-derivable', field: name, detail: d.detail };
    else omitted.push(name);
  }
  for (const name of required) {
    if (!(name in input)) return { omitted, reason: 'required-not-derivable', field: name, detail: 'no-esta-en-properties' };
  }
  return { input, omitted };
}

/** Huella del schema, para que un DRIFT conteste "¿cambió el schema hoy?" sin arqueología. */
export function schemaFingerprint(schema) {
  return createHash('sha256').update(canonicalJson(schema)).digest('hex').slice(0, 12);
}

function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

// ── Lo que se afirma de un 2xx ────────────────────────────────────────────────

/**
 * `success === true` y los dos campos numéricos finitos y > 0, CRUZADOS contra los
 * nombres que el `outputSchema` publica en la misma corrida: si el catálogo ya no los
 * declara, el resultado es contrato cambiado y no un verde.
 *
 * ⛔ Ninguna banda de valor: una banda FX es un generador de falsos rojos con fecha de
 * vencimiento. ⛔ Ninguna afirmación sobre corredor, país ni moneda.
 * @returns {{ok: true} | {ok: false, drift?: boolean, field?: string, reason: string}}
 */
export function assertQuoteShape(body, outputSchema) {
  if (body?.success !== true) return { ok: false, reason: 'success !== true' };
  const out = body?.steps?.[0]?.output;
  const declared = outputSchema?.properties ?? {};
  for (const field of ['rate', 'netDeliveredLocal']) {
    if (!(field in declared)) return { ok: false, drift: true, field, reason: 'no declarado en outputSchema' };
    const v = out?.[field];
    if (typeof v !== 'number' || !Number.isFinite(v) || !(v > 0)) {
      return { ok: false, field, reason: 'no es un número finito > 0' };
    }
  }
  return { ok: true };
}

// ── La escalera ───────────────────────────────────────────────────────────────

/**
 * Primera fila que matchea, gana. Pura: la escalera de §5 del Story File, ejecutable.
 *
 * El discriminante de las filas 6 y 7 es el **VALOR** de `agentFailure`, no su presencia
 * (`src/types/index.ts:1269-1284`): `INPUT_REJECTED` es la sonda vieja; `AGENT_ERROR` es
 * el agente fallando, o sea camino del dinero roto. AUSENTE es "no sé qué contestó el
 * agente en el intento que decidió" ⇒ fila 9, la regla por defecto.
 * ⛔ El status del agente NO se recupera re-parseando el string de `error`.
 */
export function classify(obs) {
  const v = ladder(obs);
  if (!obs.selfTestField) return v;
  // El interruptor de self-test no puede terminar en 0 JAMÁS, y tampoco puede afirmar
  // algo que no se midió. Hay DOS formas de no haberlo medido y las dos son config:
  //   (a) nunca se envió el cuerpo roto (la corrida cortó antes del pipeline);
  //   (b) el campo que se pidió romper NO estaba en el cuerpo derivado, así que
  //       borrarlo fue un no-op: salió entero, conforme, y el gateway lo aceptó con
  //       razón. Sin (b), un typo en el interruptor compra un hallazgo FABRICADO.
  if (obs.selfTestFieldPresent === false) {
    return verdict('CONFIG', 3, 'CONFIG: se pidió romper un campo que la derivación NO produjo — el cuerpo habría salido entero, así que no se envió nada');
  }
  if (v.klass === 'PASS') {
    return verdict('SELF-TEST', 5, 'SELF-TEST: el gateway aceptó un cuerpo que viola el schema publicado');
  }
  if (v.exit === 0) return verdict('CONFIG', 3, 'CONFIG: se pidió una corrida de self-test y no llegó a enviarse ningún cuerpo');
  return v;
}

function ladder(obs) {
  const d = obs.discover ?? {};
  const c = obs.compose ?? {};
  const body = c.body ?? {};
  // 0
  if (!obs.credentialPresent) {
    if (obs.githubEventName === 'pull_request') {
      return verdict('SKIP', 0, 'SKIP: credencial de sonda ausente (A2A_PROBE_KEY) — un pull_request DESDE UN FORK no recibe el secret del repo; esto NO dice nada sobre producción');
    }
    return verdict('CONFIG', 3, 'CONFIG: credencial de sonda ausente (A2A_PROBE_KEY) — esto NO dice nada sobre producción');
  }
  // 0-bis — un `PROBE_AMOUNT_USD` no numérico es un typo del OPERADOR, no un cambio del
  // catálogo: `Number('veinticinco')` da NaN, ninguna cota publicada lo satisface, y sin
  // esta fila la sonda salía por la 3 diciendo "el contrato publicado cambió".
  if (obs.amountInvalid) {
    return verdict('CONFIG', 3, 'CONFIG: PROBE_AMOUNT_USD no es un número — es configuración de la sonda, no del catálogo');
  }
  // 1
  if (d.networkError || (typeof d.status === 'number' && d.status >= 500)) {
    return verdict('DOWN', 2, `DOWN: /discover inalcanzable (${d.networkError ?? d.status})`);
  }
  // 2
  if (d.status === 404 || (d.status === 200 && !d.inputSchema)) {
    return verdict('DRIFT', 4, `DRIFT: el catálogo ya no publica el inputSchema de ${AGENT_SLUG}`);
  }
  // 2-bis — CUALQUIER otra respuesta de /discover que no sea 200. Sin esta fila, un 403
  // de WAF, un 429 del borde o un 302 caían al final de la escalera. El borde contesta
  // esos códigos, no sólo 5xx, y ahí el catálogo no se pudo leer: no se sabe nada.
  if (d.status !== 200) {
    return verdict('DOWN', 2, `DOWN: /discover no contestó 200 (${typeof d.status === 'number' ? d.status : 'sin status'})`);
  }
  // 3
  if (obs.derive?.reason) {
    return verdict('DRIFT', 4, `DRIFT: campo requerido no derivable: ${obs.derive.field} (${obs.derive.detail}) — la sonda NO inventa valores`);
  }
  const is2xx = typeof c.status === 'number' && c.status >= 200 && c.status < 300;
  // 4 — los DOS productores de 403, con sus DOS grafías. Mirar una sola convertía un
  // rechazo por scope (una propiedad de la key de la sonda) en "producción caída".
  const code403 =
    typeof body.error_code === 'string' ? body.error_code : typeof body.errorCode === 'string' ? body.errorCode : null;
  if (c.status === 403 && code403 !== null && (CREDENTIAL_ERROR_CODES.has(code403) || SCOPE_ERROR_CODES.has(code403))) {
    return verdict('CONFIG', 3, `CONFIG: la credencial de la sonda (${code403}) — producción no está implicada`);
  }
  // 5
  if (c.status === 402) return verdict('CONFIG', 3, 'CONFIG: la credencial no fue aceptada (402)');
  if (typeof c.status === 'number' && !is2xx) {
    // 6
    if (body.agentFailure === 'INPUT_REJECTED') {
      return verdict('DRIFT', 4, 'DRIFT: el agente rechazó el input DERIVADO del schema publicado');
    }
    // 7
    if (body.agentFailure === 'AGENT_ERROR') {
      return verdict('DOWN', 2, 'DOWN: el agente contestó un error que no es sobre el pedido');
    }
    // 8
    const gwCode = GATEWAY_BODY_CODES.has(body.code) ? body.code : GATEWAY_BODY_CODES.has(body.errorCode) ? body.errorCode : null;
    if (gwCode) return verdict('DRIFT', 4, `DRIFT: el gateway rechazó el cuerpo de la sonda (${gwCode})`);
  }
  // 9
  if (c.networkError || (typeof c.status === 'number' && !is2xx)) {
    return verdict('DOWN', 2, 'DOWN: candidata a caída real — no hay campo estructurado que atribuya la causa');
  }
  // 10 — y su carve-out de §7: si el catálogo ya no declara el campo, es contrato
  // cambiado y NO una caída. Afirmar lo contrario repetiría el defecto de origen.
  if (is2xx && obs.quote && obs.quote.ok !== true) {
    if (obs.quote.drift) {
      return verdict('DRIFT', 4, `DRIFT: el outputSchema publicado ya no declara ${obs.quote.field}`);
    }
    return verdict('DOWN', 2, `DOWN: 200 con una cotización que no es una cotización (${obs.quote.field ?? ''} ${obs.quote.reason})`.replace('( ', '('));
  }
  // 11 — PASS es INALCANZABLE salvo tras un 2xx de `/compose` con la forma verificada.
  if (is2xx && obs.quote?.ok === true) {
    return verdict('PASS', 0, 'PASS: el camino del dinero cotiza');
  }
  // 12 — el default, y NO es PASS: la única clase que jamás debe alcanzarse por omisión
  // no puede ser la que dice que todo anda. Un camino que nadie previó sale ruidoso.
  return verdict('DOWN', 2, 'DOWN: la sonda no llegó a observar un 2xx de /compose con una cotización verificada');
}

// ── Red ───────────────────────────────────────────────────────────────────────

/** Sólo un rechazo a nivel conexión se reintenta; el timeout, sólo donde es idempotente. */
export function isRetryable(err, retryOnTimeout) {
  if (err?.name === 'AbortError') return retryOnTimeout === true;
  return CONNECTION_ERRORS.has(err?.cause?.code ?? err?.code);
}

/** ⛔ Nunca devuelve el cuerpo crudo hacia el issue: sólo el código del rechazo. */
async function request(url, init, timeoutMs, retryOnTimeout) {
  for (let attempt = 0; ; attempt += 1) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ac.signal });
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch (err) {
      if (attempt === 0 && isRetryable(err, retryOnTimeout)) {
        await sleep(RETRY_WAIT_MS);
        continue;
      }
      return { networkError: err?.cause?.code ?? err?.code ?? err?.name ?? 'error-de-red' };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

/** @returns {Promise<number>} el código de salida. Imprime UNA línea de clase a stdout. */
export async function main(env = process.env) {
  const t0 = Date.now();
  const obs = {
    credentialPresent: false,
    githubEventName: env.GITHUB_EVENT_NAME,
    selfTestField: String(env.PROBE_SELF_TEST_OMIT_REQUIRED ?? '').trim() || null,
  };
  const facts = { schemaSha256: '-', omitted: [], httpStatus: '-', agentFailure: '-' };
  const cred = readCredential(env);
  obs.credentialPresent = cred.run;
  if (!cred.run) return emit(classify(obs), facts, t0);

  obs.discover = await request(`${BASE_URL}/discover/${AGENT_SLUG}`, { method: 'GET' }, DISCOVER_TIMEOUT_MS, true);
  facts.httpStatus = obs.discover.status ?? '-';
  const card = obs.discover.body ?? {};
  obs.discover.inputSchema = card.metadata?.inputSchema ?? null;
  if (!obs.discover.inputSchema) return emit(classify(obs), facts, t0);
  facts.schemaSha256 = schemaFingerprint(obs.discover.inputSchema);

  const amountUsd = Number(env.PROBE_AMOUNT_USD ?? DEFAULT_AMOUNT_USD);
  if (!Number.isFinite(amountUsd)) {
    obs.amountInvalid = true;
    return emit(classify(obs), facts, t0);
  }
  const derived = deriveInput(obs.discover.inputSchema, { amountUsd });
  facts.omitted = derived.omitted;
  if (derived.reason) {
    obs.derive = derived;
    return emit(classify(obs), facts, t0);
  }

  const input = { ...derived.input };
  if (obs.selfTestField) {
    // ⛔ Borrar un campo que el cuerpo derivado no tiene es un no-op SILENCIOSO: el
    // cuerpo saldría entero, el gateway lo aceptaría con razón, y la sonda pagaría por
    // acusarlo de aceptar algo inválido. Se corta ANTES del pipeline, y sin gastar.
    obs.selfTestFieldPresent = obs.selfTestField in input;
    if (!obs.selfTestFieldPresent) return emit(classify(obs), facts, t0);
    process.stdout.write('SELF-TEST: corrida DELIBERADAMENTE rota — NO mide producción\n');
    delete input[obs.selfTestField];
  }

  // El ÚNICO método no-GET de esta sonda. Sin reintento ante timeout: un POST que
  // expiró pudo haberse ejecutado del otro lado, y repetirlo paga dos veces.
  obs.compose = await request(
    `${BASE_URL}/compose`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-a2a-key': cred.key },
      body: JSON.stringify({ steps: [{ agent: AGENT_SLUG, input }] }),
    },
    COMPOSE_TIMEOUT_MS,
    false,
  );
  facts.httpStatus = obs.compose.status ?? '-';
  facts.agentFailure = obs.compose.body?.agentFailure ?? '-';
  obs.quote = assertQuoteShape(obs.compose.body, card.metadata?.outputSchema);
  return emit(classify(obs), facts, t0);
}

function emit(v, facts, t0) {
  process.stdout.write(
    `${v.message} | agent=${AGENT_SLUG} schemaSha256=${facts.schemaSha256}` +
      ` omitted=[${facts.omitted.join(',')}] httpStatus=${facts.httpStatus}` +
      ` agentFailure=${facts.agentFailure} durationMs=${Date.now() - t0}\n`,
  );
  return v.exit;
}

// Only auto-run when invoked directly (not when imported by the vitest wrapper).
const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // exit 1 queda reservado para esto: un defecto de la sonda, que no es
      // ninguna de las cuatro clases y por eso no se confunde con ellas.
      process.stderr.write(`[probe] excepción no manejada: ${err?.message ?? String(err)}\n`);
      process.exit(1);
    });
}
