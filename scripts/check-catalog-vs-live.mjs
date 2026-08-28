#!/usr/bin/env node
/**
 * @file check-catalog-vs-live.mjs
 * @description El vigilante del catálogo (WKH-370). **DOS preguntas distintas, y
 * ninguna implica la otra.**
 *
 *   DERIVA      — lo que el catálogo publica de un agente ≠ lo que ese agente
 *                 publica de sí mismo en su manifiesto vivo. Datos PÚBLICOS.
 *   COMPLETITUD — la fila del catálogo está MAL NACIDA: le falta un campo propio.
 *                 Necesita `GET /agents` autenticado.
 *
 * La tesis, que es la razón de existir del chequeo: **una fila mal nacida se ve
 * igual que una sana desde el catálogo**. Las dos filas self-published sin
 * `payout_wallet` tenían deriva CERO — el chequeo de deriva jamás las habría
 * cazado. Por eso las dos mitades corren como dos jobs SIN `needs:`, con clases y
 * códigos de salida distintos, y el verde de una NUNCA cierra el aviso de la otra.
 *
 * SIETE clases con SIETE códigos de salida distintos, para que el exit code solo
 * ya atribuya la causa (patrón de `probe-money-path.mjs`):
 *   0 CONFORME · 1 defecto del propio chequeo · 2 INALCANZABLE · 3 CONFIG
 *   4 DERIVA · 5 INCOMPLETA · 6 UNRESOLVED
 *
 * "No pude preguntar" se parte en TRES porque son preguntas distintas:
 *   INALCANZABLE = el otro no contestó · CONFIG = yo no estoy en condiciones de
 *   preguntar · UNRESOLVED = contestó, pero no puedo confiar en que sea el agente
 *   que creo.
 *
 * ⛔ Este chequeo OBSERVA: su único método HTTP es `GET`. Ningún POST, PATCH,
 *    DELETE ni `/compose`. Costo: 0 USDC.
 * ⛔ Nunca imprime el valor de una wallet, de un `owner_ref` ni de una credencial:
 *    el repo es PÚBLICO. Presencia o ausencia, jamás el valor.
 * ⛔ Se lee la LISTA de `/discover` UNA vez por corrida. Iterar el detalle por
 *    slug cuesta hasta doscientas queries por request y perdió su exención de
 *    rate limit.
 *
 * Env:
 *   CHECK_MODE               `deriva` | `completitud`. Ausente o no reconocido ⇒
 *                            CONFIG(3). ⛔ NO hay default que corra "algo": un
 *                            typo mediría otra cosa en silencio.
 *   A2A_CATALOG_OWNER_KEY    Sólo en modo `completitud`. Ausente ⇒ CONFIG(3)
 *                            nombrándola, y RECHAZADA (401/403) ⇒ la MISMA clase,
 *                            también nombrándola: revocada y ausente son el mismo
 *                            hecho por dos códigos distintos, y reportar la revocada
 *                            como caída del otro lado manda a mirar el deploy en vez
 *                            de rotar el secreto. Nunca se imprime.
 *
 * ── TD-370-OUTPUTSCHEMA-SIN-FUENTE ────────────────────────────────────────────
 * `outputSchema` se CUENTA y se reporta (`outputSchemaPresente=n/n`), y NO entra a
 * la escalera. Medido contra los cinco manifiestos vivos el 2026-08-27: las keys de
 * primer nivel son las mismas ocho en los cinco y `outputSchema` no está en
 * NINGUNO, mientras tres filas del catálogo sí lo traen. O sea: un `outputSchema`
 * escrito a mano que ningún manifiesto respalda. Exigirlo sería exigir un campo SIN
 * fuente de verdad —exactamente el defecto que este chequeo existe para matar— y un
 * control que nace rojo por un criterio inalcanzable es el control que la gente
 * aprende a ignorar. O los agentes lo publican, o el catálogo lo suelta. Este
 * chequeo no lo resuelve: lo hace VISIBLE.
 */

import { createHash } from 'node:crypto';

export const BASE_URL = 'https://wasiai-a2a-production.up.railway.app';

/**
 * El discriminante del universo. NO es el host: es el campo `registry` que el
 * mapper de agentes self-published pone como literal. Los federados salen del
 * conjunto CON MOTIVO ESCRITO, nunca en silencio: su manifiesto no existe (el
 * upstream contesta 404 con cuerpo HTML), y callarlo haría pasar por "medido" lo
 * que nunca se midió.
 */
export const SELF_PUBLISHED = 'self-published';

/** La unión catálogo↔manifiesto se VERIFICA, no se confía. Ver `deriveManifestUrl`. */
export const INVOKE_SUFFIX = '/invoke';
export const MANIFEST_SUFFIX = '/manifest';

/** Los dos modos. ⛔ Sin default: ausente o no reconocido ⇒ CONFIG(3). */
export const MODOS = ['deriva', 'completitud'];

/**
 * Las SIETE clases con sus códigos. `DEFECTO` (1) no se emite nunca por la
 * escalera: queda reservado para una excepción no manejada, que es un defecto del
 * propio chequeo y no una afirmación sobre el catálogo.
 */
export const CLASES = {
  CONFORME: 0,
  DEFECTO: 1,
  INALCANZABLE: 2,
  CONFIG: 3,
  DERIVA: 4,
  INCOMPLETA: 5,
  UNRESOLVED: 6,
};

const LISTA_TIMEOUT_MS = 20_000;
const MANIFIESTO_TIMEOUT_MS = 15_000;
const RETRY_WAIT_MS = 2_000;

/** Rechazos a nivel conexión: los únicos que se reintentan. */
const CONNECTION_ERRORS = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ECONNRESET',
  'EAI_AGAIN',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const verdict = (klass, message) => ({
  klass,
  exit: CLASES[klass],
  message: `${klass}: ${message}`,
});

// ── Contrato puro: modo, credencial, huellas, unión ───────────────────────────

/** @returns {'deriva'|'completitud'|null} `null` = ausente o no reconocido. */
export function readMode(env = process.env) {
  const raw = String(env.CHECK_MODE ?? '').trim();
  return MODOS.includes(raw) ? raw : null;
}

/**
 * Pura. ⛔ El valor que devuelve NO se imprime en ningún camino, y `emit` no lo
 * puede tocar: no recibe ni la credencial ni nada derivado de ella.
 * @returns {{run: boolean, key?: string, reason?: string}}
 */
export function readCredential(env = process.env) {
  const key = String(env.A2A_CATALOG_OWNER_KEY ?? '').trim();
  if (key) return { run: true, key };
  return { run: false, reason: 'A2A_CATALOG_OWNER_KEY ausente o vacía' };
}

/** Huella de un valor, para que un hallazgo traiga las DOS y no haya arqueología. */
export function schemaFingerprint(v) {
  return createHash('sha256').update(canonicalJson(v)).digest('hex').slice(0, 12);
}

export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * La URL del manifiesto sale del `invokeUrl` publicado, reemplazando el sufijo.
 *
 * ⛔ PROHIBIDO asumir que el último segmento de la URL es el slug: medido el
 * 2026-08-27, es FALSO en dos de cinco. Y ⛔ prohibido adivinar otra forma de URL:
 * si el `invokeUrl` no termina en el sufijo esperado, la unión no se pudo resolver
 * y eso NO es deriva.
 * @returns {{ok: true, url: string} | {ok: false, motivo: string}}
 */
export function deriveManifestUrl(invokeUrl) {
  const url = typeof invokeUrl === 'string' ? invokeUrl.trim() : '';
  if (!url.endsWith(INVOKE_SUFFIX)) {
    return { ok: false, motivo: `el invokeUrl no termina en ${INVOKE_SUFFIX}` };
  }
  return { ok: true, url: url.slice(0, -INVOKE_SUFFIX.length) + MANIFEST_SUFFIX };
}

// ── El universo ───────────────────────────────────────────────────────────────

/**
 * Parte el catálogo en elegibles y excluidos. ⛔ El número de agentes NO se
 * hardcodea: se deriva en cada corrida. Y ⛔ ningún agente sale del conjunto en
 * silencio: cada exclusión lleva su motivo, porque "no lo pude medir" no es
 * "está bien".
 * @returns {{elegibles: object[], excluidos: {slug: string, motivo: string}[]}}
 */
export function derivarUniverso(agentes) {
  const elegibles = [];
  const excluidos = [];
  for (const a of Array.isArray(agentes) ? agentes : []) {
    const slug = typeof a?.slug === 'string' ? a.slug : '(sin slug)';
    if (a?.registry === SELF_PUBLISHED) elegibles.push(a);
    else {
      excluidos.push({
        slug,
        motivo: `registry=${String(a?.registry ?? 'desconocido')} no publica manifiesto propio`,
      });
    }
  }
  return { elegibles, excluidos };
}

// ── Las dos mitades, puras ────────────────────────────────────────────────────

/**
 * Los CINCO campos comparables, y las dos trampas que decidieron cuáles son.
 *
 * ⚠️ `inputSchema` vive en TRES formas distintas: bajo `metadata` en `/discover`,
 * en la RAÍZ del manifiesto, y en la RAÍZ del registro de `GET /agents`. Mirar la
 * raíz de `/discover` devuelve "cero de veintinueve publican schema", que es FALSO.
 * ⚠️ El `payment` de la RAÍZ de `/discover` es DERIVADO: lo produce el lector de
 * specs y trae dos keys que el manifiesto no tiene. Comparar ése fabrica deriva en
 * los cinco. Se compara `metadata.payment`.
 * ⛔ `description` queda EXCLUIDO: prosa larga, generador de falsos rojos sin valor.
 * ⛔ `outputSchema` queda EXCLUIDO por TD-370-OUTPUTSCHEMA-SIN-FUENTE.
 *
 * @returns {{campo: string, catalogo: string, manifiesto: string}[]}
 */
export function compararAgente(fila, manifiesto) {
  const meta = fila?.metadata && typeof fila.metadata === 'object' ? fila.metadata : {};
  const conjunto = (v) =>
    Array.isArray(v) ? [...new Set(v.map(String))].sort() : v;
  const pares = [
    ['inputSchema', meta.inputSchema, manifiesto?.inputSchema],
    ['payment', meta.payment, manifiesto?.payment],
    ['capabilities', conjunto(fila?.capabilities), conjunto(manifiesto?.capabilities)],
    ['priceUsdc', fila?.priceUsdc, manifiesto?.priceUsdc],
    ['name', fila?.name, manifiesto?.name],
  ];
  const difs = [];
  for (const [campo, izq, der] of pares) {
    const a = canonicalJson(izq);
    const b = canonicalJson(der);
    if (a !== b) {
      difs.push({
        campo,
        catalogo: schemaFingerprint(izq),
        manifiesto: schemaFingerprint(der),
      });
    }
  }
  return difs;
}

/**
 * ¿La fila está MAL NACIDA? Pregunta independiente de la deriva: una fila sin
 * `payout_wallet` coincide con su manifiesto en los cinco campos y aun así está
 * rota. Ninguna de las dos mitades es condición de la otra.
 *
 * ⚠️ `owner_ref` — la comprobación es CASI VACUA y se declara vacua. La columna es
 * `NOT NULL` por tipo, así que no existe input que ponga roja una comprobación de
 * PRESENCIA; lo único que el tipo no descarta es una cadena de espacios. Y hay una
 * segunda vacuidad, más grande: el registro que devuelve `GET /agents` NO publica
 * el `owner_ref` (nunca debe: el repo es público), así que en la corrida real esta
 * rama NO se evalúa nunca. Se escribe igual, con el límite dicho en voz alta, para
 * que el día que ese campo se publique el chequeo ya lo mire — y para no disfrazar
 * de protección algo que hoy no protege nada.
 *
 * ⚠️ Un dato AUSENTE no es un dato bueno. Si el registro no viene, o no trae el
 * booleano de payout, el agente sale `sin-dato` y NUNCA "completo": el exit 0 no
 * puede afirmar lo que no se midió.
 *
 * @returns {{estado: 'sin-dato', motivo: string} | {estado: 'incompleta', faltantes: string[]} | {estado: 'completa'}}
 */
export function evaluarCompletitud(fila, registro) {
  if (registro === undefined || registro === null) {
    return {
      estado: 'sin-dato',
      motivo: 'el listado autenticado no devolvió esta fila (puede ser de otro owner)',
    };
  }
  if (typeof registro.hasPayoutWallet !== 'boolean') {
    return {
      estado: 'sin-dato',
      motivo: 'el registro no publica el booleano de billetera de cobro',
    };
  }
  const meta = fila?.metadata && typeof fila.metadata === 'object' ? fila.metadata : {};
  const faltantes = [];
  const schema = meta.inputSchema;
  if (schema === undefined || schema === null) faltantes.push('metadata.inputSchema');
  if (registro.hasPayoutWallet === false) faltantes.push('payoutWallet');
  if (typeof registro.ownerRef === 'string' && registro.ownerRef.trim() === '') {
    faltantes.push('ownerRef');
  }
  return faltantes.length > 0 ? { estado: 'incompleta', faltantes } : { estado: 'completa' };
}

// ── La escalera ───────────────────────────────────────────────────────────────

/**
 * Primera fila que matchea, gana. **Pura.**
 *
 * ⚠️ La fila 0 mira un hecho POSITIVO (`listadoInalcanzable === true`, o sea "se
 * intentó leer y no se pudo"), nunca la ausencia de un hecho. Con la ausencia, un
 * corte temprano por configuración —que no llega a pedir nada— saldría clasificado
 * como caída del otro lado, que es acusar a producción de un defecto propio. En
 * modo `completitud` hay DOS listados (el público y el autenticado) y cualquiera
 * de los dos que no conteste enciende esta fila.
 *
 * ⚠️ La fila 10 va ANTES que la 11 a propósito: una fila incompleta NO se reporta
 * como sana ni aunque su deriva sea cero, y si coexisten manda la que cuesta
 * dinero. El orden no esconde nada: la línea de salida lleva SIEMPRE los seis
 * contadores, así que el exit atribuye y la línea enumera. Ese mismo principio es
 * el que guardan las filas 8 y 9: una acusación al catálogo no se puede tapar con
 * un "no pude preguntar" que convive con ella.
 *
 * ⚠️ La fila 4b no está en la escalera del contrato y se numera así, y no como una
 * fila nueva, para no correr los números de las demás: es la hermana de la 4 —misma
 * clase, misma variable nombrada— y una credencial rechazada es el mismo hecho que
 * una ausente.
 *
 * ⚠️ La fila 13 pregunta sólo por `comparados`, y es deliberado: las filas 8 a 12
 * ya sacaron del camino todo lo que no está sano. Re-preguntarlo acá haría que
 * mover la fila 10 abajo no rompiera nada, y ese mutante tiene que poder matarse.
 *
 * ⛔ La fila 14, el default, JAMÁS es la clase buena: la única clase que no debe
 * alcanzarse por omisión no puede ser la que dice que todo anda.
 */
export function classify(obs) {
  const modo = obs.modo ?? null;
  // 0
  if (obs.listadoInalcanzable === true) {
    return verdict('INALCANZABLE', `no se pudo leer el listado que esta mitad necesita (${obs.detalleListado ?? 'sin detalle'}) — esto NO dice que el catálogo esté mal`);
  }
  // 1
  if (modo === null) {
    return verdict('CONFIG', 'CHECK_MODE ausente o no reconocido — el chequeo no está en condiciones de afirmar nada, y no hay default que corra "algo"');
  }
  // 2
  if (obs.agentes === 0) {
    return verdict('CONFIG', 'el catálogo no devolvió ni un agente — acusa al instrumento, no a producción');
  }
  // 3
  if (obs.elegibles === 0) {
    return verdict('CONFIG', 'ningún agente elegible tras derivar el universo self-published — no hay nada que medir');
  }
  // 4
  if (modo === 'completitud' && obs.credencialPresente !== true) {
    return verdict('CONFIG', 'falta la credencial A2A_CATALOG_OWNER_KEY — la completitud NO se verificó, y un sin dato jamás sale por exit 0');
  }
  // 4b — la hermana de la 4, y sale por la MISMA clase que ella a propósito: una
  // credencial ausente y una credencial rechazada son el mismo hecho —"no estoy en
  // condiciones de preguntar"— por dos códigos distintos. Nombra la variable, igual
  // que la 4, porque lo que hay que hacer es rotar el secreto.
  if (modo === 'completitud' && obs.credencialRechazada !== undefined) {
    return verdict('CONFIG', `el listado propio rechazó la credencial A2A_CATALOG_OWNER_KEY (${obs.credencialRechazada}) — hay que rotarla; la completitud NO se verificó y un sin dato jamás sale por exit 0`);
  }
  // 5
  if (modo === 'deriva' && obs.conSchemaEnMetadata === 0) {
    return verdict('CONFIG', 'ningún elegible publica su inputSchema bajo metadata — un cero uniforme acusa al instrumento que lo buscó donde no vive');
  }
  // 6
  if (modo === 'completitud' && obs.sinDato === obs.elegibles) {
    return verdict('CONFIG', 'no se pudo medir NI UNO de los elegibles — "no lo pude medir" no es "está bien"');
  }
  // 7 — anti-vacuidad, CON un guard explícito, y el guard NO es un adorno.
  //
  // ⚠️ MEDIDO: la escalera del contrato pone esta fila ANTES que las dos de abajo,
  // y con ese orden literal hay dos casos reales que salen mal atribuidos: si NINGÚN
  // manifiesto contesta, o si NINGUNA unión se puede verificar, `comparados` queda en
  // cero y el chequeo contesta "no comparé nada" —una clase que dice textualmente que
  // acusa al INSTRUMENTO— cuando lo que pasó es que el otro lado no contestó. El
  // orden de las filas se deja intacto para que se pueda auditar contra el contrato;
  // lo que se agrega es la condición que faltaba: esta fila responde "no comparé
  // nada" SÓLO cuando ninguna de las dos de abajo tiene una respuesta mejor. Es
  // equivalente a evaluar las filas 8 y 9 primero, y preserva entero lo que esta
  // fila existe para garantizar: un chequeo que no ejecutó nada JAMÁS sale verde.
  if (obs.comparados === 0 && obs.inalcanzables === 0 && obs.unresolved === 0) {
    return verdict('CONFIG', 'el chequeo terminó sin haber comparado ni un par — un chequeo que no ejecutó nada no afirma nada');
  }
  // 8 y 9 — con el MISMO guard que la fila 7, y por el mismo motivo.
  //
  // ⚠️ MEDIDO: con la condición literal del contrato, un solo manifiesto caído
  // conviviendo con cuatro derivas REALES sale `exit=2` diciendo textualmente "esto NO
  // dice que el catálogo esté mal" **en la misma línea que dice `derivas=4`**. O sea:
  // el mensaje afirma que el catálogo está bien mientras el contador lo desmiente, y
  // quien confía en el exit code —que es lo que AC-8 le pide— se pierde las cuatro.
  // Un manifiesto flaky enmascararía la señal todos los días.
  //
  // El principio que lo resuelve ya estaba escrito para la fila 10 y sólo faltaba
  // aplicarlo acá: **si coexisten, manda la que cuesta dinero**. Y se aplica igual que
  // en la fila 7 —agregando la condición que faltaba, sin mover las filas de lugar—
  // para que la escalera se siga pudiendo auditar contra el contrato del W0 renglón
  // por renglón. Es equivalente a evaluar 10 y 11 primero, y no pierde nada: cuando
  // NO coexisten (que es el caso de todos los días) estas dos filas siguen ganando, y
  // la línea de salida lleva SIEMPRE los seis contadores.
  const acusaAlCatalogo = obs.incompletas > 0 || obs.derivas > 0;
  // 8
  if (obs.inalcanzables > 0 && !acusaAlCatalogo) {
    return verdict('INALCANZABLE', `${obs.inalcanzables} elegible(s) no contestaron — esto NO dice que el catálogo esté mal`);
  }
  // 9
  if (obs.unresolved > 0 && !acusaAlCatalogo) {
    return verdict('UNRESOLVED', `${obs.unresolved} elegible(s) cuya unión con su manifiesto no se pudo verificar — de ésos no se comparó ni un campo`);
  }
  // 10
  if (obs.incompletas > 0) {
    return verdict('INCOMPLETA', `${obs.incompletas} fila(s) mal nacida(s): les falta un campo propio, lo cual NO dice que difieran de su manifiesto`);
  }
  // 11
  if (obs.derivas > 0) {
    return verdict('DERIVA', `${obs.derivas} elegible(s) con al menos un campo distinto entre el catálogo y su manifiesto vivo`);
  }
  // 12
  if (obs.sinDato > 0) {
    return verdict('CONFIG', `${obs.sinDato} elegible(s) sin dato — lo medido salió bien, pero lo NO medido no se declara sano`);
  }
  // 13
  if (obs.comparados > 0) {
    return verdict('CONFORME', 'se comparó al menos un par y todo lo elegible está al día — no dice nada de los excluidos');
  }
  // 14
  return verdict('INALCANZABLE', 'el chequeo no llegó a ningún estado previsto — por omisión jamás se declara sano');
}

// ── Red ───────────────────────────────────────────────────────────────────────

/** Sólo un rechazo a nivel conexión se reintenta; el timeout, sólo donde es idempotente. */
export function isRetryable(err, retryOnTimeout) {
  if (err?.name === 'AbortError') return retryOnTimeout === true;
  return CONNECTION_ERRORS.has(err?.cause?.code ?? err?.code);
}

/** ⛔ Nunca devuelve el cuerpo crudo hacia el issue: sólo status y JSON parseado. */
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

/**
 * @returns {Promise<number>} el código de salida. Imprime UNA línea de clase.
 *
 * `escribir` es un parámetro y no una llamada directa a `process.stdout` para que
 * la suite pueda LEER la línea emitida sin parchear un global: sin eso, el control
 * positivo de que el chequeo efectivamente ejecutó —que la línea traiga
 * `comparados` mayor que cero— no tendría cómo mirarse, y un rojo sin ese control
 * no prueba que el chequeo haya corrido.
 */
export async function main(env = process.env, escribir = (s) => process.stdout.write(s)) {
  const t0 = Date.now();
  const obs = {
    modo: readMode(env),
    agentes: 0,
    elegibles: 0,
    credencialPresente: false,
    conSchemaEnMetadata: 0,
    comparados: 0,
    derivas: 0,
    incompletas: 0,
    unresolved: 0,
    inalcanzables: 0,
    sinDato: 0,
  };
  const extra = { excluidos: [], hallazgos: [], conOutputSchema: 0 };
  // El modo se valida ANTES de pedir nada: un typo es un defecto de configuración
  // y no justifica salir a molestar a un servicio.
  if (obs.modo === null) return emit(classify(obs), obs, extra, t0, escribir);

  const lista = await request(`${BASE_URL}/discover`, { method: 'GET' }, LISTA_TIMEOUT_MS, true);
  if (lista.status !== 200 || !Array.isArray(lista.body?.agents)) {
    obs.listadoInalcanzable = true;
    // Un `200` con un cuerpo del que no sale la lista —HTML de un proxy, o un
    // `agents` que no es un array— NO es "no contestó": contestó y rompió su
    // contrato. La clase es la misma porque el listado quedó sin leer igual, pero el
    // detalle lo dice, porque son dos cosas distintas de arreglar y `catalogo=0` no
    // alcanza para desambiguarlas.
    obs.detalleListado =
      lista.status === 200
        ? '/discover 200 con un cuerpo del que no sale la lista de agentes'
        : `/discover ${lista.networkError ?? lista.status ?? 'sin status'}`;
    return emit(classify(obs), obs, extra, t0, escribir);
  }
  const agentes = lista.body.agents;
  obs.agentes = agentes.length;
  const universo = derivarUniverso(agentes);
  extra.excluidos = universo.excluidos;
  obs.elegibles = universo.elegibles.length;
  for (const fila of universo.elegibles) {
    const meta = fila?.metadata && typeof fila.metadata === 'object' ? fila.metadata : {};
    if (meta.inputSchema !== undefined && meta.inputSchema !== null) obs.conSchemaEnMetadata += 1;
    if (meta.outputSchema !== undefined && meta.outputSchema !== null) extra.conOutputSchema += 1;
  }
  if (obs.elegibles === 0) return emit(classify(obs), obs, extra, t0, escribir);

  if (obs.modo === 'deriva') {
    // El cero uniforme se corta ANTES de salir a la red: si ningún elegible
    // publica el schema donde vive, lo roto es el instrumento y no hay nada que
    // preguntarle a cinco servicios.
    if (obs.conSchemaEnMetadata === 0) return emit(classify(obs), obs, extra, t0, escribir);
    await medirDeriva(universo.elegibles, obs, extra);
  } else {
    const cred = readCredential(env);
    obs.credencialPresente = cred.run;
    if (!cred.run) return emit(classify(obs), obs, extra, t0, escribir);
    const propios = await request(
      `${BASE_URL}/agents`,
      { method: 'GET', headers: { 'x-a2a-key': cred.key } },
      LISTA_TIMEOUT_MS,
      true,
    );
    // Una credencial RECHAZADA y una credencial AUSENTE son EL MISMO HECHO por dos
    // códigos distintos: yo no estoy en condiciones de preguntar. El otro lado sí
    // contestó —contestó que no me conoce—, así que llamarlo INALCANZABLE acusaría a
    // producción de un defecto que es mío, y con la key rotada —operación rutinaria—
    // el humano miraría el deploy en vez de rotar el secreto.
    if (propios.status === 401 || propios.status === 403) {
      obs.credencialRechazada = propios.status;
      return emit(classify(obs), obs, extra, t0, escribir);
    }
    if (propios.status !== 200) {
      obs.listadoInalcanzable = true;
      obs.detalleListado = `/agents ${propios.networkError ?? propios.status ?? 'sin status'}`;
      return emit(classify(obs), obs, extra, t0, escribir);
    }
    medirCompletitud(universo.elegibles, propios.body, obs, extra);
  }
  return emit(classify(obs), obs, extra, t0, escribir);
}

/** La mitad PÚBLICA. Cero credenciales, y la unión se verifica en cuatro pasos. */
async function medirDeriva(elegibles, obs, extra) {
  for (const fila of elegibles) {
    const slug = String(fila?.slug ?? '(sin slug)');
    const destino = deriveManifestUrl(fila?.invokeUrl);
    if (!destino.ok) {
      obs.unresolved += 1;
      extra.hallazgos.push(`${slug} tipo=unresolved motivo=${destino.motivo}`);
      continue;
    }
    const res = await request(destino.url, { method: 'GET' }, MANIFIESTO_TIMEOUT_MS, true);
    if (res.status !== 200 || res.body === null || typeof res.body !== 'object') {
      obs.inalcanzables += 1;
      extra.hallazgos.push(`${slug} tipo=inalcanzable motivo=el manifiesto contestó ${res.networkError ?? res.status ?? 'sin status'}`);
      continue;
    }
    // El manifiesto se AUTODECLARA. Si el slug que declara no es el del catálogo,
    // la unión no se resolvió y ⛔ NO se compara ni un campo: comparar acá sería
    // comparar contra el agente equivocado y publicarlo como deriva.
    if (res.body.slug !== fila?.slug) {
      obs.unresolved += 1;
      extra.hallazgos.push(`${slug} tipo=unresolved motivo=el manifiesto se declara con otro slug`);
      continue;
    }
    obs.comparados += 1;
    const difs = compararAgente(fila, res.body);
    if (difs.length > 0) {
      obs.derivas += 1;
      for (const d of difs) {
        extra.hallazgos.push(`${slug} tipo=deriva campo=${d.campo} catalogo=${d.catalogo} manifiesto=${d.manifiesto}`);
      }
    }
  }
}

/** La mitad AUTENTICADA. Cruza los elegibles del catálogo contra el listado propio. */
function medirCompletitud(elegibles, cuerpo, obs, extra) {
  const registros = new Map();
  const lista = Array.isArray(cuerpo) ? cuerpo : Array.isArray(cuerpo?.agents) ? cuerpo.agents : [];
  for (const r of lista) if (typeof r?.slug === 'string') registros.set(r.slug, r);
  for (const fila of elegibles) {
    const slug = String(fila?.slug ?? '(sin slug)');
    const r = evaluarCompletitud(fila, registros.get(fila?.slug));
    if (r.estado === 'sin-dato') {
      obs.sinDato += 1;
      extra.hallazgos.push(`${slug} tipo=sin-dato motivo=${r.motivo}`);
      continue;
    }
    obs.comparados += 1;
    if (r.estado === 'incompleta') {
      obs.incompletas += 1;
      extra.hallazgos.push(`${slug} tipo=incompleta faltantes=[${r.faltantes.join(',')}]`);
    }
  }
}

/**
 * UNA línea de clase, más los hallazgos y la lista de excluidos.
 * ⛔ Acá no entra ningún valor de credencial ni de billetera: sólo contadores,
 * slugs, nombres de campo y huellas. El repo es PÚBLICO.
 */
function emit(v, obs, extra, t0, escribir) {
  for (const h of extra.hallazgos) escribir(`HALLAZGO: ${h}\n`);
  if (extra.excluidos.length > 0) {
    escribir(`EXCLUIDOS: ${extra.excluidos.map((e) => `${e.slug}=${e.motivo}`).join('; ')}\n`);
  }
  escribir(
    `${v.message} | modo=${obs.modo ?? '-'} catalogo=${obs.agentes} elegibles=${obs.elegibles}` +
      ` comparados=${obs.comparados} derivas=${obs.derivas} incompletas=${obs.incompletas}` +
      ` unresolved=${obs.unresolved} inalcanzables=${obs.inalcanzables} sindato=${obs.sinDato}` +
      ` excluidos=${extra.excluidos.length}` +
      ` outputSchemaPresente=${extra.conOutputSchema}/${obs.elegibles} durationMs=${Date.now() - t0}\n`,
  );
  return v.exit;
}

// Only auto-run when invoked directly (not when imported by the vitest wrapper).
const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // exit 1 queda reservado para esto: un defecto del propio chequeo, que no es
      // ninguna de las seis clases y por eso no se confunde con ellas.
      process.stderr.write(`[check-catalog] excepción no manejada: ${err?.message ?? String(err)}\n`);
      process.exit(CLASES.DEFECTO);
    });
}
