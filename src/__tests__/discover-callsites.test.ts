/**
 * WKH-322 — el mecanismo que cierra la clase "un call-site le manda a
 * `/discover` una clave que `/discover` no acepta".
 *
 * POR QUÉ ESTE ARCHIVO EXISTE
 * --------------------------
 * El recuento de call-sites de la clave `query` creció CUATRO veces: el Story
 * File dijo 4, el AR-1 encontró 6, el fix-pack encontró 8, el AR-2 encontró 10.
 * Cada iteración cerró los casos y ninguna cerró la clase, porque el mecanismo
 * era siempre el mismo: un grep escrito en un `.md` que una persona tiene que
 * re-correr y cruzar a mano. Ese procedimiento falló por DOS causas distintas
 * y **ampliar el grep sólo arregla una**:
 *
 *   1. alcance corto — el grep canónico decía `scripts/ src/ packages/`, y
 *      `mcp-servers/wasiai-x402/` (un cliente HTTP publicado de este mismo
 *      repo) no está en ninguno de los tres;
 *   2. el cruce a mano se abandona — `scripts/smoke-test.sh` SÍ estaba dentro
 *      del alcance y el grep canónico lo matcheaba; se escapó igual.
 *
 * Este test reemplaza las dos mitades del procedimiento por código: enumera los
 * archivos con `git ls-files` (un directorio nuevo entra solo, sin que nadie
 * actualice una lista) y cruza cada clave que viaja hacia `/discover` contra
 * `ALLOWED_DISCOVER_PARAMS`, que es la constante REAL que usa la ruta, no una
 * copia.
 *
 * QUÉ LO PONE ROJO
 * ----------------
 *   - `T-CS-2`: un call-site NUEVO, en cualquier archivo del repo, con una
 *     clave que la ruta rechaza con 400;
 *   - `T-CS-3`: un POST hacia `/discover` cuyo body el extractor NO sabe leer.
 *     "No sé qué manda este call-site" se reporta rojo a propósito: es lo que
 *     impide que una FORMA nueva de escribir la llamada pase en silencio.
 *   - `T-CS-0` / `T-CS-0b` / `T-CS-1`: la herramienta misma, si deja de ver el
 *     repo (o los gitignoreados) o deja de entender alguna forma que hoy
 *     entiende.
 *   - `T-CS-4`: el extractor medido contra formas PLANTADAS, incluidas las que
 *     NO caza. Un mecanismo hay que probarlo por lo que deja pasar, no sólo por
 *     lo que atrapa: las del repo real sólo prueban lo que alguien ya escribió.
 *
 * QUÉ NO CUBRE (límites MEDIDOS, no descuidos)
 * --------------------------------------------
 * ⚠️ LEER ESTO ANTES DE CONFIAR EN EL VERDE. Esta lista existió una vez con UN
 * solo ítem ("claves construidas en runtime") y era falsa: AR-3 plantó 15 formas
 * distintas de mandar un parámetro y CINCO con clave literal y estática pasaron
 * mudas. Una lista de límites que promete de más es peor que no tenerla, porque
 * el revisor siguiente deja de buscar donde ella dice que no hace falta. Las de
 * abajo están medidas una por una, y las que se pueden congelar tienen su caso
 * en `T-CS-4`: si alguien le enseña una forma al extractor, ese test se pone
 * rojo y hay que sacarla de acá.
 *
 * Del extractor (una llamada así pasa MUDA):
 *   - claves construidas en runtime: `params.set(k, v)` con `k` variable, y su
 *     gemela del lado body `{ [k]: v }`. Ningún análisis estático las alcanza.
 *   - un helper propio que reciba las claves de afuera
 *     (`callDiscover({ query })` con el `set(k, v)` en otro archivo): el
 *     extractor no cruza archivos.
 *   - `new URLSearchParams([['query', …]])` — array de pares (el literal de
 *     OBJETO sí se lee).
 *   - la query string CONCATENADA: `'/discover' + '?query=' + v`. `QS_RE` exige
 *     el `?` pegado al path.
 *   - un `params` ENTRECOMILLADO (`"params": {…}`) no se lee como query params,
 *     a propósito: en JSON-RPC esa clave es otra cosa. Un `.json` que documente
 *     un GET con axios queda afuera.
 *
 * Del enumerador (el archivo ni siquiera se abre):
 *   - `git ls-files` NO desciende a SUBMÓDULOS: `contracts/lib/**` son 2104
 *     archivos invisibles para el barrido.
 *   - `readTextFile` descarta EN SILENCIO todo archivo > 2 MiB y todo binario, y
 *     no los suma a `filesScanned`. Un fixture grande no se mira y nadie se
 *     entera.
 *   - los archivos GITIGNOREADOS sí se barren, pero SÓLO en la corrida local:
 *     `actions/checkout` no los materializa, así que en CI no existen. Hoy hay
 *     dos que llaman al endpoint — `scripts/smoke-base-downstream.mjs`
 *     (`.gitignore:72`) y `scripts/smoke-prod-via-app-wasiai.mjs`
 *     (`.gitignore:205`) — y para ellos la corrida del dev antes de commitear es
 *     la única línea de defensa. Ver `T-CS-0b`.
 *   - `doc/sdd/**` y `doc/audit/**`: son reportes donde CITAR la llamada rota
 *     es el objetivo del texto. El resto de los `.md` (README, `docs/**`,
 *     `doc/INTEGRATION.md`) SÍ se verifica: una doc que publique un parámetro
 *     inexistente es el mismo bug de esta HU, escrito en prosa.
 *
 * De la atribución (el dato se lee y se descarta):
 *   - `isForeignHost` descarta como "registry federado ajeno" todo host literal
 *     que no matchee `localhost|127.0.0.1|wasiai|railway|vercel`. Un gateway
 *     self-hosted en un dominio propio se descartaría.
 *   - ventanas que esperan el rechazo (mencionan `UNKNOWN_DISCOVER_PARAM`
 *     cerca): son los tests del propio guard, donde mandar la clave mala es el
 *     punto.
 *   - una mención al endpoint dentro de un COMENTARIO de código no abre ventana
 *     (sí cuenta para la atribución). Un call-site cuya URL sea una variable y
 *     que sólo esté nombrado en un comentario queda afuera.
 *
 * ⚠️ ESTE BARRIDO NO SUSTITUYE LA BÚSQUEDA cuando aparece una forma NUEVA de
 * escribir la llamada. Cubre las formas que sabe leer, que están enumeradas en
 * `T-CS-1` y `T-CS-4`; frente a una sexta forma su verde no significa nada. El
 * modo correcto de subirle la confianza es plantar la forma y medir, no leerlo.
 *
 * SI ESTE TEST DA UN FALSO POSITIVO, no lo silencies con una excepción por
 * archivo: o el extractor está atribuyendo el body al endpoint equivocado
 * (arreglar `nearestEndpointIsTarget`), o el call-site está escrito de una
 * forma que conviene enseñarle. Una lista de archivos exceptuados es
 * exactamente el artefacto que ya falló cuatro veces.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOWED_DISCOVER_PARAMS } from '../lib/discovery-query.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Líneas alrededor de la mención al endpoint que cuentan como el call-site.
 *  Hacia atrás importa: `k6-deep-test.js` arma el body 9 líneas antes del
 *  `http.post`. */
const WINDOW_BACK = 12;
const WINDOW_FWD = 15;

const EXCLUDED_PREFIXES = ['doc/sdd/', 'doc/audit/'];

/** Este archivo: está lleno de patrones de call-site porque ES el extractor.
 *  Escanearse a sí mismo mide la herramienta contra su propia definición. */
const SELF = 'src/__tests__/discover-callsites.test.ts';

const BINARY_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.pdf',
  '.woff',
  '.woff2',
  '.ttf',
  '.zip',
  '.gz',
  '.wasm',
  '.mp4',
  '.webp',
  '.svg',
]);

/** Los dos caminos por los que un parámetro llega al guard de `/discover`:
 *  directo, o por el passthrough de `wasiai-v2` (`appendSearchParams` copia
 *  toda clave verbatim hacia a2a). */
const TARGET_RE =
  /\/discover(?![A-Za-z0-9_-])|\/api\/v1\/capabilities(?![A-Za-z0-9_-])/g;

/** Otros endpoints del repo. Sirven para decidir a QUIÉN pertenece un body:
 *  un `JSON.stringify({goal, budget})` de `/orchestrate` que casualmente cae
 *  cerca de una mención a `/discover` no es un parámetro de `/discover`. */
const OTHER_ENDPOINT_RE =
  /\/(?:api\/v1\/)?(?:orchestrate|compose|agent-keys|agents|registries|tasks|health|auth|gasless|dashboard|invoke|settle|verify|mcp|escrow|events|well-known)(?![A-Za-z0-9_])/g;

/** `?a=1&b=2` colgado del path. */
const QS_RE =
  /(?:\/discover|\/api\/v1\/capabilities)\?([A-Za-z0-9_%$={}.:\-+&[\]]*)/g;
/** `url.searchParams.set('q', …)`. */
const SP_RE =
  /(?:searchParams|params|qs|search)\s*\.\s*(?:set|append)\s*\(\s*['"`]([^'"`]+)['"`]/g;
/** `body.q = …`, `payload['q'] = …`. */
const MEMBER_RE =
  /\b(?:body|payload|params|filters|query)\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"`]([^'"`]+)['"`]\s*\])\s*=(?!=)/g;
/** Anclas tras las cuales un `{` es el cuerpo de un request.
 *
 *  Las comillas alrededor del nombre son opcionales a propósito (AR-3
 *  `BLQ-BAJO-1`): un fixture `.json` escribe `"body": { "query": … }` y sin eso
 *  el ancla no matcheaba — el `\b` de `\bbody` sí entra adentro de las comillas,
 *  pero después venía un `"` donde el regex esperaba el `:`. Medido: el fixture
 *  `.json` pasaba MUDO y el `.yaml` equivalente (sin comillas) no. */
const BODY_ANCHOR_RE =
  /(?:JSON\.stringify\s*\(|--data(?:-raw|-binary)?\s+'|--data(?:-raw|-binary)?\s+"|-d\s+'|-d\s+"|["'`]?\bbody\b["'`]?\s*[:=]\s*|["'`]?\bpayload\b["'`]?\s*[:=]\s*|["'`]?\bjson\b["'`]?\s*[:=]\s*)/g;
/** Anclas tras las cuales un `{` son QUERY PARAMS, no un body (AR-3
 *  `BLQ-BAJO-1`): `new URLSearchParams({ q: … })` y el `params: { … }` de
 *  axios/got. Las dos pasaban mudas y ninguna estaba declarada como límite.
 *
 *  Van aparte de `BODY_ANCHOR_RE` por dos razones, no por estética: el `how` que
 *  reportan es `searchParams` (que es lo que son), y NO cuentan como "body
 *  leído" para el chequeo de POSTs opacos — un `params:` no responde por lo que
 *  viaja en el cuerpo. */
const QUERY_OBJECT_ANCHOR_RE =
  /(?:new\s+URLSearchParams\s*\(|\bparams\s*[:=]\s*)/g;
/** Construcciones que EMITEN un request (no que lo registran: `app.post` no). */
const REQUEST_CALL_RE =
  /(?:\bfetch\s*\(|\binject\s*\(|\bhttp\s*\.\s*(?:post|request)\s*\(|\baxios\s*\.\s*post\s*\(|-X\s+POST|--request\s+POST)/g;

const CODE_EXTS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.sh',
  '.bash',
  '.py',
];

interface Hit {
  file: string;
  line: number;
  key: string;
  how: string;
  snippet: string;
}
interface OpaquePost {
  file: string;
  line: number;
  snippet: string;
  /** `'no-body'`: no se encontró ningún literal. `'partial-body'`: se encontró
   *  uno pero tenía un spread / clave computada / token no resoluble adentro. */
  reason: 'no-body' | 'partial-body';
}

// ── Enumeración de archivos ────────────────────────────────────────────────

function gitLsFiles(args: string[]): string[] {
  // Si git no está, esto tira — un barrido vacío que pasa en verde es
  // justamente el modo de falla que este archivo viene a matar.
  const out = execFileSync('git', ['ls-files', '-z', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

/**
 * Exclusiones de VOLUMEN (no de criterio) para la enumeración de gitignoreados:
 * sin ellas `git ls-files --ignored` trae 38.134 entradas, casi todas de
 * `node_modules/`, y cuesta 450 ms. Con ellas son 267 y cuesta 36 ms.
 */
const IGNORED_VOLUME_EXCLUDES = [
  ':(exclude)node_modules/**',
  ':(exclude)**/node_modules/**',
  ':(exclude)dist/**',
  ':(exclude)**/dist/**',
  ':(exclude)coverage/**',
  ':(exclude)**/coverage/**',
];

function repoFiles(): string[] {
  // `git ls-files` en vez de una lista de directorios: el caso `mcp-servers/`
  // entra solo.
  // `--others --exclude-standard` suma los archivos NUEVOS todavía sin
  // commitear: un call-site recién escrito tiene que ponerse rojo en la
  // corrida local, no recién en CI después del commit.
  const tracked = gitLsFiles(['--cached', '--others', '--exclude-standard']);
  // ⚠️ `--ignored` suma los GITIGNOREADOS que existan en esta copia (AR-3
  // `BLQ-BAJO-3`). Hoy hay dos que llaman al endpoint:
  // `scripts/smoke-base-downstream.mjs:116` (`body: { q: GOAL }`) y
  // `scripts/smoke-prod-via-app-wasiai.mjs:85` (`capabilities?limit=20`). El
  // primero FIGURA en el inventario de call-sites del AR-2: un revisor humano
  // contó como call-site un archivo que el guard automático era
  // estructuralmente incapaz de mirar — justo la asimetría que este mecanismo
  // vino a eliminar. Verificado: cambiarle la clave a `query` dejaba `npm test`
  // en verde.
  // En CI estos archivos NO existen (`actions/checkout` no materializa
  // ignorados), así que para ELLOS la corrida local es la única línea de
  // defensa. Declarado en "QUÉ NO CUBRE".
  const ignored = gitLsFiles([
    '--others',
    '--ignored',
    '--exclude-standard',
    '--',
    ...IGNORED_VOLUME_EXCLUDES,
  ]);
  return [...tracked, ...ignored]
    .filter((f) => f !== SELF)
    .filter((f) => !EXCLUDED_PREFIXES.some((p) => f.startsWith(p)))
    .filter((f) => {
      const dot = f.lastIndexOf('.');
      return dot === -1 || !BINARY_EXTS.has(f.slice(dot).toLowerCase());
    });
}

function readTextFile(rel: string): string | null {
  const abs = join(REPO_ROOT, rel);
  try {
    if (statSync(abs).size > 2 * 1024 * 1024) return null; // lockfiles, snapshots
    const buf = readFileSync(abs);
    if (buf.includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

// ── Utilidades ─────────────────────────────────────────────────────────────

function lineOf(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((lineStarts[mid] as number) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Claves de nivel 1 del objeto literal (JS o JSON) que abre en `open`, MÁS un
 * flag `unresolved` que dice si quedó algo sin leer.
 *
 * ⚠️ EL FLAG NO ES DECORATIVO — es la diferencia entre "¿leí algo?" y "¿leí
 * TODO?" (AR-3 `BLQ-BAJO-2`). Sin él, `JSON.stringify({ ...extraFilters, limit: 5 })`
 * devolvía `['limit']`, el POST contaba como "body leído" y el `query` que sale
 * de verdad por el cable no aparecía **ni como hit ni como rojo**: verde mudo.
 * Eso es la negación exacta de lo que `T-CS-3` promete.
 *
 * Cae en `unresolved` todo lo que ocupe una posición de clave y no resuelva a un
 * nombre estático: el spread (`...x`), la clave computada (`[k]: v`), una llamada
 * (`...toFilters()`), y en general cualquier token que el extractor no sepa
 * nombrar. El shorthand (`{ q, limit }`) SÍ resuelve: la clave es el nombre del
 * identificador.
 */
function topLevelKeys(
  text: string,
  open: number,
): { keys: Array<{ key: string; offset: number }>; unresolved: boolean } {
  const keys: Array<{ key: string; offset: number }> = [];
  let unresolved = false;
  const IDENT = /^[A-Za-z_$][\w$-]*/;
  let depth = 0;
  let atKeyPos = false;
  let i = open;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') {
      // `{ [k]: v }` — clave computada. NO marca `unresolved`, a propósito y
      // medido: es exactamente la misma "clave construida en runtime" que ya
      // está declarada como límite del lado GET (`params.set(KEY, x)`), y
      // ningún análisis estático la alcanza por ninguno de los dos caminos.
      // Marcarla roja no daría un arreglo posible: daría una excepción.
      // Distinta del spread, que SÍ marca: el spread esconde claves que son
      // ESTÁTICAS, sólo que escritas en otro lado del repo — o sea justo lo que
      // este barrido existe para encontrar.
      // Hoy la única del repo es `routes/discover.minreputation.test.ts:732`
      // (`payload: { [name]: value }`, el `it.each` POSITIVO del propio guard).
      depth += 1;
      atKeyPos = c === '{' && depth === 1;
      i += 1;
      continue;
    }
    if (c === '}' || c === ']' || c === ')') {
      depth -= 1;
      if (depth <= 0) break;
      i += 1;
      continue;
    }
    if (c === ',' && depth === 1) {
      atKeyPos = true;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < text.length && text[j] !== quote) {
        if (text[j] === '\\') j += 1;
        j += 1;
      }
      if (atKeyPos && depth === 1) {
        if (/^\s*:/.test(text.slice(j + 1, j + 8))) {
          keys.push({ key: text.slice(i + 1, j), offset: i + 1 });
        } else {
          // Una cadena en posición de clave que no abre un `key: value`. No sé
          // qué es; no puedo afirmar que el body esté leído.
          unresolved = true;
        }
      }
      atKeyPos = false;
      i = j + 1;
      continue;
    }
    if (atKeyPos && depth === 1 && !/\s/.test(c)) {
      const m = text.slice(i, i + 80).match(IDENT);
      if (m) {
        const ident = m[0] as string;
        const after = text.slice(i + ident.length, i + ident.length + 8);
        if (/^\s*:/.test(after)) {
          keys.push({ key: ident, offset: i });
        } else if (/^\s*[,}]/.test(after)) {
          // Shorthand `{ q, limit }`: la clave ES el identificador. Resuelve.
          keys.push({ key: ident, offset: i });
        } else {
          // `foo()`, `a.b`, un operador… ocupa la posición de clave y no la sé
          // nombrar.
          unresolved = true;
        }
        i += ident.length;
      } else {
        unresolved = true; // spread `...x`, y cualquier token no identificador
        i += 1;
      }
      atKeyPos = false;
      continue;
    }
    i += 1;
  }
  return { keys, unresolved };
}

function allMatchOffsets(text: string, re: RegExp): number[] {
  const out: number[] = [];
  re.lastIndex = 0;
  let m = re.exec(text);
  while (m !== null) {
    out.push(m.index);
    m = re.exec(text);
  }
  return out;
}

/**
 * `https://example.com/discover` es el endpoint de OTRO registry federado, no
 * el nuestro. Se descarta cuando el host que precede al path es un literal
 * ajeno (uno interpolado — `${BASE_URL}/discover` — no lo es).
 */
function isForeignHost(text: string, at: number): boolean {
  const before = text.slice(Math.max(0, at - 120), at);
  // `discoveryEndpoint: 'http://…/discover'` describe, por definición del campo,
  // el `/discover` de OTRO registry federado. Nunca es una llamada al nuestro.
  if (/(?:discovery|invoke)_?[Ee]ndpoint\s*[:=]\s*['"`][^'"`]*$/.test(before))
    return true;
  const m = before.match(/https?:\/\/([^/'"`\s)]+)$/);
  if (!m) return false;
  const host = m[1] as string;
  if (host.includes('$') || host.includes('{')) return false;
  return !/localhost|127\.0\.0\.1|wasiai|railway|vercel/i.test(host);
}

// ── Escaneo de un archivo ──────────────────────────────────────────────────

function scanFile(
  rel: string,
  text: string,
): { hits: Hit[]; opaquePosts: OpaquePost[] } {
  const hits: Hit[] = [];
  const opaquePosts: OpaquePost[] = [];
  const isCode = CODE_EXTS.some((e) => rel.endsWith(e));
  const lines = text.split('\n');
  const lineStarts: number[] = [];
  {
    let acc = 0;
    for (const l of lines) {
      lineStarts.push(acc);
      acc += l.length + 1;
    }
  }

  const targets = allMatchOffsets(text, TARGET_RE).filter(
    (o) => !isForeignHost(text, o),
  );
  if (targets.length === 0) return { hits, opaquePosts };
  const others = allMatchOffsets(text, OTHER_ENDPOINT_RE).filter(
    (o) => !targets.includes(o),
  );

  /**
   * ¿La mención al endpoint está dentro de un COMENTARIO de un archivo de
   * código? Un comentario nunca ES un call-site: es prosa, y la prosa la
   * verifica el barrido de `.md` por su cuenta.
   *
   * ⚠️ EXISTE POR UN FALSO POSITIVO REAL, destapado al empezar a ver los
   * gitignoreados: `scripts/smoke-prod-via-app-wasiai.mjs:82` tiene el
   * comentario `// Step 1: GET /api/v1/capabilities (… should hit a2a
   * /discover)`. Esa línea abría una ventana de 12 líneas hacia atrás que
   * alcanzaba el helper x402 de la línea 71, y el barrido reportaba `network`
   * como parámetro de `/discover`. La llamada REAL está en la línea 85, a 14
   * líneas del helper: fuera de la ventana, como corresponde.
   *
   * ⚠️ Apaga sólo la VENTANA, no la atribución: la mención comentada se sigue
   * usando en `nearestEndpointIsTarget` para decidir a quién pertenece un dato.
   * Un comentario que nombra el endpoint sigue siendo evidencia de a qué
   * endpoint apunta el código de al lado; lo que no es, es un call-site.
   *
   * Se probó primero el arreglo "el body tiene que tener un emisor
   * (`fetch(`/`http.post(`) cerca" y se DESCARTÓ por medición: escondía
   * `scripts/smoke-base-downstream.mjs:116`, que manda el body a través de un
   * helper `api(path, { body })` propio — o sea que habría tapado justo el
   * call-site que `BLQ-BAJO-3` pide destapar.
   */
  const isProseMention = (off: number): boolean => {
    if (!isCode) return false;
    const ln = lineOf(lineStarts, off);
    const line = lines[ln] as string;
    const before = line.slice(0, off - (lineStarts[ln] as number));
    if (/^\s*(?:\*|\/\/|#)/.test(line)) return true; // JSDoc, `//`, `#`
    // `//` que no venga de un `https://`.
    return /(?:^|[^:])\/\//.test(before) || /(?:^|\s)#/.test(before);
  };

  const active = new Set<number>();
  for (const o of targets) {
    if (isProseMention(o)) continue;
    const ln = lineOf(lineStarts, o);
    for (
      let k = Math.max(0, ln - WINDOW_BACK);
      k <= Math.min(lines.length - 1, ln + WINDOW_FWD);
      k += 1
    ) {
      active.add(k);
    }
  }

  const nearest = (arr: number[], off: number): number =>
    arr.reduce(
      (best, o) => (Math.abs(o - off) < Math.abs(best - off) ? o : best),
      Number.MAX_SAFE_INTEGER / 2,
    );

  /** El dato pertenece a `/discover` sólo si es el endpoint MÁS CERCANO. */
  const nearestEndpointIsTarget = (off: number): boolean =>
    Math.abs(nearest(targets, off) - off) <=
    Math.abs(nearest(others, off) - off);

  /** Ventana de un TEST que documenta el rechazo: ahí mandar la clave mala es
   *  el punto del test. Restringido a archivos `*.test.*` a propósito: en
   *  código normal un comentario que nombre el error NO puede apagar el
   *  chequeo (se probó: alcanzaba con mencionarlo arriba del call-site). */
  const isTestFile = /\.test\.(ts|tsx|js|mjs|cjs)$/.test(rel);
  const expectsRejection = (ln: number): boolean => {
    if (!isTestFile) return false;
    const from = Math.max(0, ln - 8);
    const to = Math.min(lines.length - 1, ln + 8);
    return /UNKNOWN_DISCOVER_PARAM|INVALID_DISCOVER_BODY/.test(
      lines.slice(from, to + 1).join('\n'),
    );
  };

  const push = (offset: number, key: string, how: string): void => {
    const ln = lineOf(lineStarts, offset);
    if (!active.has(ln)) return;
    if (
      key === '' ||
      key.includes('${') ||
      key.includes('$(') ||
      key.includes('%') ||
      key.startsWith('$')
    )
      return;
    if (!nearestEndpointIsTarget(offset)) return;
    if (expectsRejection(ln)) return;
    hits.push({
      file: rel,
      line: ln + 1,
      key,
      how,
      snippet: (lines[ln] as string).trim().slice(0, 160),
    });
  };

  // 1. Query strings literales.
  QS_RE.lastIndex = 0;
  let q = QS_RE.exec(text);
  while (q !== null) {
    if (!isForeignHost(text, q.index)) {
      for (const pair of (q[1] as string).split('&')) {
        push(q.index, (pair.split('=')[0] as string).trim(), 'query string');
      }
    }
    q = QS_RE.exec(text);
  }

  // 2. searchParams.set/append y asignaciones al body.
  for (const re of [SP_RE, MEMBER_RE]) {
    re.lastIndex = 0;
    let r = re.exec(text);
    while (r !== null) {
      const key = (r[1] ?? r[2]) as string | undefined;
      if (key)
        push(
          r.index,
          key,
          re === SP_RE ? 'searchParams' : 'asignación al body',
        );
      r = re.exec(text);
    }
  }

  // 3. Cuerpos JSON.
  /** `unresolved`: el literal existía pero quedó algo adentro sin leer. */
  const bodyAnchors: Array<{ offset: number; unresolved: boolean }> = [];
  BODY_ANCHOR_RE.lastIndex = 0;
  let a = BODY_ANCHOR_RE.exec(text);
  while (a !== null) {
    const anchor = a[0] as string;
    const rest = text.slice(a.index + anchor.length);
    const braceRel = rest.search(/\S/);
    const lineText = lines[lineOf(lineStarts, a.index)] as string;
    // `{ status: 200, body: { agents: [] } }` es una RESPUESTA canned de un
    // mock, no un request: el `body:` con un `status` hermano no es nuestro.
    const isCannedResponse = /\bstatus(?:Code)?\s*:/.test(
      lineText.slice(0, lineText.indexOf(anchor.trim()) + 1),
    );
    if (braceRel !== -1 && rest[braceRel] === '{' && !isCannedResponse) {
      const open = a.index + anchor.length + braceRel;
      const parsed = topLevelKeys(text, open);
      bodyAnchors.push({ offset: a.index, unresolved: parsed.unresolved });
      for (const { key, offset } of parsed.keys) push(offset, key, 'body JSON');
    }
    a = BODY_ANCHOR_RE.exec(text);
  }

  // 3b. Objetos que se convierten en QUERY STRING (`new URLSearchParams({…})`,
  //     `params: {…}`). No entran en `bodyAnchors`: no son un cuerpo.
  QUERY_OBJECT_ANCHOR_RE.lastIndex = 0;
  let qo = QUERY_OBJECT_ANCHOR_RE.exec(text);
  while (qo !== null) {
    const anchor = qo[0] as string;
    const rest = text.slice(qo.index + anchor.length);
    const braceRel = rest.search(/\S/);
    if (braceRel !== -1 && rest[braceRel] === '{') {
      const open = qo.index + anchor.length + braceRel;
      for (const { key, offset } of topLevelKeys(text, open).keys)
        push(offset, key, 'searchParams');
    }
    qo = QUERY_OBJECT_ANCHOR_RE.exec(text);
  }

  // 4. POSTs opacos (sólo en código): hay un request POST hacia el endpoint y
  //    NO se pudo leer ningún body cerca. No poder leerlo es rojo.
  if (isCode) {
    const requestCalls = allMatchOffsets(text, REQUEST_CALL_RE);
    /** Cada body pertenece a UNA sola llamada: la más cercana. Sin esto, el
     *  body de la llamada de arriba "cubre" a la de abajo y un POST opaco pasa
     *  en verde — probado a mano con un call-site plantado. */
    const ownerOf = (off: number): number => nearest(requestCalls, off);
    REQUEST_CALL_RE.lastIndex = 0;
    let c = REQUEST_CALL_RE.exec(text);
    while (c !== null) {
      const construct = c[0] as string;
      // El span se corta al final del objeto de opciones: sin el corte, el
      // `method: 'POST'` del test SIGUIENTE convertía en POST a un GET.
      const rawSpan = text.slice(c.index, c.index + 400);
      const endRel = rawSpan.search(/\}\)|\);|\n\s*\n/);
      const span = endRel === -1 ? rawSpan : rawSpan.slice(0, endRel);
      // 120 chars: el target tiene que ser el ARGUMENTO URL de la llamada, no
      // una mención suelta más abajo (un `http.post('/orchestrate')` seguido de
      // un array que nombra `/discover` no es un POST a /discover).
      const hitsTarget = targets.some(
        (o) => o > c!.index && o < c!.index + 120 && nearestEndpointIsTarget(o),
      );
      const isPost =
        /post|POST/.test(construct) || /method\s*:\s*['"`]POST/.test(span);
      if (hitsTarget && isPost) {
        const own = c.index;
        const ownedAnchors = bodyAnchors.filter(
          (b) => ownerOf(b.offset) === own && Math.abs(b.offset - own) < 900,
        );
        const hasAssignedBody = hits.some(
          (h) =>
            h.how === 'asignación al body' &&
            ownerOf(lineStarts[h.line - 1] as number) === own &&
            Math.abs((lineStarts[h.line - 1] as number) - own) < 900,
        );
        // "¿Leí TODO?", no "¿leí algo?" (AR-3 `BLQ-BAJO-2`): un literal con un
        // spread adentro deja de contar como body leído aunque haya rendido
        // otras claves. Un `hasBody` booleano hacía pasar en verde justo el
        // caso en el que el extractor sabe A MEDIAS.
        const partiallyRead = ownedAnchors.some((b) => b.unresolved);
        const hasBody =
          (ownedAnchors.length > 0 || hasAssignedBody) && !partiallyRead;
        const ln = lineOf(lineStarts, c.index);
        // Los tests del propio guard mandan bodies deliberadamente ilegibles
        // (`payload: [1,2]`, un primitivo): que no tengan claves es el punto.
        if (!hasBody && !expectsRejection(ln)) {
          opaquePosts.push({
            file: rel,
            line: ln + 1,
            snippet: (lines[ln] as string).trim().slice(0, 160),
            reason: partiallyRead ? 'partial-body' : 'no-body',
          });
        }
      }
      c = REQUEST_CALL_RE.exec(text);
    }
  }

  return { hits, opaquePosts };
}

function scanRepo(): {
  hits: Hit[];
  opaquePosts: OpaquePost[];
  filesScanned: number;
} {
  const hits: Hit[] = [];
  const opaquePosts: OpaquePost[] = [];
  let filesScanned = 0;
  for (const rel of repoFiles()) {
    const text = readTextFile(rel);
    if (text === null) continue;
    filesScanned += 1;
    if (!text.includes('/discover') && !text.includes('/api/v1/capabilities'))
      continue;
    const r = scanFile(rel, text);
    hits.push(...r.hits);
    opaquePosts.push(...r.opaquePosts);
  }
  return { hits, opaquePosts, filesScanned };
}

// ── Los tests ──────────────────────────────────────────────────────────────

const scan = scanRepo();

describe('WKH-322 · call-sites de /discover en todo el repo', () => {
  it('T-CS-0: el barrido cubre el repo entero, `mcp-servers/` incluido', () => {
    // Anti-vacuidad: un barrido que no barre nada pasa en verde y en la salida
    // se lee igual que un éxito.
    expect(scan.filesScanned).toBeGreaterThan(200);
    const files = new Set(scan.hits.map((h) => h.file));
    // Los cuatro lugares donde hoy vive un call-site. `mcp-servers/` es el que
    // el grep canónico del auto-blindaje dejaba afuera por construcción.
    expect([...files].some((f) => f.startsWith('mcp-servers/'))).toBe(true);
    expect([...files].some((f) => f.startsWith('scripts/'))).toBe(true);
    expect([...files].some((f) => f.startsWith('src/'))).toBe(true);
    expect([...files].some((f) => f.endsWith('.md'))).toBe(true);
  });

  it('T-CS-0b: los gitignoreados que existan en esta copia entran al barrido', () => {
    // AR-3 `BLQ-BAJO-3`. Sin esto, sacar la rama `--ignored` de `repoFiles()`
    // no pone nada en rojo y `scripts/smoke-base-downstream.mjs` vuelve a ser
    // invisible para el guard mientras los humanos lo siguen contando como
    // call-site en el inventario.
    //
    // ⚠️ EN CI ESTA ASERCIÓN ES VACUA, y se declara en vez de esconderse:
    // `actions/checkout` no materializa archivos ignorados, así que la lista es
    // vacía y no hay nada que verificar. Para los gitignoreados, la corrida
    // LOCAL del dev es la única línea de defensa que existe.
    const ignoredOnDisk = gitLsFiles([
      '--others',
      '--ignored',
      '--exclude-standard',
      '--',
      ...IGNORED_VOLUME_EXCLUDES,
    ]).filter((f) => CODE_EXTS.some((e) => f.endsWith(e)));
    const enumerated = new Set(repoFiles());
    expect(
      ignoredOnDisk.filter((f) => !enumerated.has(f)),
      'Hay archivos gitignoreados de código en esta copia que el barrido NO enumera.\n' +
        'Un call-site ahí adentro es invisible para este guard aunque un humano lo\n' +
        'cuente en el inventario, que es la asimetría que el mecanismo vino a matar.\n',
    ).toEqual([]);
  });

  it('T-CS-1: el extractor sabe leer las 4 formas de escribir un call-site', () => {
    // No congela los call-sites (eso sería congelar el pasado): congela la
    // capacidad de LEER cada forma. Si alguien simplifica el extractor y deja
    // de entender una, esto se pone rojo antes de que un call-site se escape.
    const hows = new Set(scan.hits.map((h) => h.how));
    expect(hows).toContain('query string'); // `/discover?q=price&limit=5`
    expect(hows).toContain('searchParams'); // `url.searchParams.set('q', …)`
    expect(hows).toContain('body JSON'); // `JSON.stringify({ q: '' })`, `-d '{"q":…}'`
    expect(hows).toContain('asignación al body'); // `body.q = query.q`
  });

  it('T-CS-2: ninguna clave enviada a /discover queda fuera de ALLOWED_DISCOVER_PARAMS', () => {
    const bad = scan.hits.filter((h) => !ALLOWED_DISCOVER_PARAMS.has(h.key));
    const detail = bad
      .map(
        (h) =>
          `  ${h.file}:${h.line}  clave '${h.key}' (${h.how})\n      ${h.snippet}`,
      )
      .join('\n');
    expect(
      bad,
      `Hay ${bad.length} call-site(s) mandando a /discover una clave que la ruta rechaza\n` +
        `con 400 UNKNOWN_DISCOVER_PARAM. Aceptadas: ${[...ALLOWED_DISCOVER_PARAMS].join(', ')}\n${detail}\n`,
    ).toEqual([]);
  });

  it('T-CS-3: no hay POST hacia /discover cuyo cuerpo el barrido no pueda leer', () => {
    const detail = scan.opaquePosts
      .map((o) => `  ${o.file}:${o.line}  [${o.reason}]\n      ${o.snippet}`)
      .join('\n');
    expect(
      scan.opaquePosts,
      'Hay POST(s) hacia /discover cuyo body este test no supo extraer ENTERO, así que no\n' +
        'puede afirmar nada sobre sus claves. "No sé" se reporta rojo a propósito: es lo\n' +
        'que impide que una FORMA nueva de escribir la llamada se cuele sin revisar.\n' +
        '  · `no-body`      → no se encontró ningún literal cerca del request.\n' +
        '  · `partial-body` → SÍ hay literal, pero adentro quedó un spread o un token\n' +
        '                     no resoluble: las claves leídas son un subconjunto de las\n' +
        '                     que salen por el cable.\n' +
        'Arreglo: escribir el body como literal junto al call-site, o enseñarle la forma\n' +
        `nueva al extractor (BODY_ANCHOR_RE / MEMBER_RE / topLevelKeys).\n${detail}\n`,
    ).toEqual([]);
  });
});

// ── El extractor medido contra formas plantadas ────────────────────────────

/**
 * `T-CS-4` — el mecanismo probado por lo que NO caza, no sólo por lo que caza.
 *
 * POR QUÉ EXISTE (AR-3): los tests de arriba miden el extractor contra el repo
 * REAL, así que sólo prueban las formas que hoy alguien escribió. AR-3 plantó 15
 * formas distintas en un directorio nuevo y encontró que varias pasaban MUDAS
 * sin estar declaradas. Un barrido que pasa en verde sobre un repo que no tiene
 * la forma peligrosa no dice nada sobre esa forma.
 *
 * Cada caso de acá es una de esas formas, congelada como fixture: el fixture le
 * entra a `scanFile` directo, así que el caso vive para siempre y no depende de
 * que alguien deje un archivo plantado en el árbol. Los casos marcados
 * "límite declarado" documentan mecánicamente lo que el barrido NO ve — si algún
 * día alguien se lo enseña, ESE test se pone rojo y hay que sacarlo de la lista
 * de límites del docstring de arriba, que es exactamente el acoplamiento que
 * faltaba.
 */
const FIXTURE = 'planted/fixture.mjs';
const scanText = (src: string) => scanFile(FIXTURE, src);

describe('WKH-322 · T-CS-4: el extractor contra formas plantadas', () => {
  it('un body con SPREAD se reporta `partial-body` aunque haya rendido otras claves', () => {
    // ⚠️ El caso exacto de AR-3 `BLQ-BAJO-2`. Antes del fix esto salía VERDE con
    // un solo hit (`limit`) y el `query` que sale por el cable no aparecía ni
    // como hit ni como rojo.
    const r = scanText(
      [
        'await fetch("https://gw.wasiai.io/discover", {',
        '  method: "POST",',
        '  body: JSON.stringify({ ...extraFilters, limit: 5 }),',
        '});',
      ].join('\n'),
    );
    expect(r.opaquePosts.map((o) => o.reason)).toEqual(['partial-body']);
    // Y lo que SÍ pudo leer se sigue reportando: el rojo no reemplaza al hit.
    expect(r.hits.map((h) => h.key)).toContain('limit');
  });

  it('CONTROL: el mismo body SIN spread se lee entero y no reporta nada', () => {
    // Sin este control, el caso de arriba pasaría igual con un extractor que
    // declare `partial-body` para TODO body.
    const r = scanText(
      [
        'await fetch("https://gw.wasiai.io/discover", {',
        '  method: "POST",',
        '  body: JSON.stringify({ q: "oracle", limit: 5 }),',
        '});',
      ].join('\n'),
    );
    expect(r.opaquePosts).toEqual([]);
    expect(r.hits.map((h) => h.key).sort()).toEqual(['limit', 'q']);
  });

  it('el shorthand `{ q, limit }` resuelve: la clave ES el identificador', () => {
    const r = scanText(
      [
        'await fetch("https://gw.wasiai.io/discover", {',
        '  method: "POST",',
        '  body: JSON.stringify({ q, limit }),',
        '});',
      ].join('\n'),
    );
    expect(r.opaquePosts).toEqual([]);
    expect(r.hits.map((h) => h.key).sort()).toEqual(['limit', 'q']);
  });

  it('un body que es una VARIABLE se reporta `no-body` (no hay literal que leer)', () => {
    const r = scanText(
      [
        'await fetch("https://gw.wasiai.io/discover", {',
        '  method: "POST",',
        '  body: JSON.stringify(filters),',
        '});',
      ].join('\n'),
    );
    expect(r.opaquePosts.map((o) => o.reason)).toEqual(['no-body']);
  });

  it('LÍMITE DECLARADO: la clave COMPUTADA `{ [k]: v }` pasa muda', () => {
    // No es un descuido: es la misma clave-construida-en-runtime que el límite
    // ya declarado del lado GET (`params.set(KEY, x)`). Está acá para que el
    // límite sea MEDIBLE y no sólo una frase. Si alguien enseña esta forma,
    // este test se pone rojo y hay que actualizar "QUÉ NO CUBRE".
    const r = scanText(
      [
        'await fetch("https://gw.wasiai.io/discover", {',
        '  method: "POST",',
        '  body: JSON.stringify({ [name]: value }),',
        '});',
      ].join('\n'),
    );
    expect(r.hits).toEqual([]);
    expect(r.opaquePosts).toEqual([]);
  });

  // ── Las formas que AR-3 plantó y pasaban MUDAS ───────────────────────────
  // Las cuatro de abajo se enseñaron en este fix-pack. Antes rendían CERO hits.

  it('`new URLSearchParams({ query })` ahora se lee (antes: mudo)', () => {
    const r = scanText(
      [
        'const qs = new URLSearchParams({ query: "oracle", limit: "5" });',
        'await fetch("https://gw.wasiai.io/discover?" + qs);',
      ].join('\n'),
    );
    expect(r.hits.map((h) => `${h.key}:${h.how}`).sort()).toEqual([
      'limit:searchParams',
      'query:searchParams',
    ]);
  });

  it('el `params: { … }` de axios ahora se lee (antes: mudo)', () => {
    const r = scanText(
      [
        'await axios.get("https://gw.wasiai.io/discover", {',
        '  params: { query: "oracle" },',
        '});',
      ].join('\n'),
    );
    expect(r.hits.map((h) => h.key)).toEqual(['query']);
  });

  it('CONTRA-CASO: el `"params"` ENTRECOMILLADO de JSON-RPC NO es query params', () => {
    // ⚠️ Sin este caso el par de arriba se "arregla" con un ancla que también
    // matchea `"params": {` — y entonces `docs/mcp-integration.md:333` reporta
    // `arguments` como parámetro de /discover. Medido: pasó de verdad al
    // enseñar la forma de axios. La distinción es el ENTRECOMILLADO: en JS la
    // opción de axios es un identificador pelado, en JSON/JSON-RPC la clave va
    // entre comillas.
    const r = scanFile(
      'planted/fixture.md',
      [
        "curl -X POST https://gw.wasiai.io/api/mcp -d '{",
        '  "method": "tools/call",',
        '  "params": { "name": "discover_agents", "arguments": { "query": "x" } }',
        "}'",
        '',
        'La tool `discover_agents` llama a /discover por dentro.',
      ].join('\n'),
    );
    expect(r.hits.map((h) => h.key)).not.toContain('arguments');
  });

  it('un `"body"` ENTRECOMILLADO (fixture .json) ahora se lee (antes: mudo)', () => {
    // `\b` sí entra adentro de las comillas, pero después venía un `"` donde el
    // ancla esperaba el `:`. Por eso el `.yaml` equivalente SÍ se leía y el
    // `.json` no: una asimetría que nadie había medido.
    const r = scanFile(
      'planted/fixture.json',
      '{ "request": { "url": "https://gw.wasiai.io/discover", "body": { "query": "oracle" } } }',
    );
    expect(r.hits.map((h) => h.key)).toEqual(['query']);
  });

  it('LÍMITE DECLARADO: `new URLSearchParams([["query", …]])` (array de pares)', () => {
    const r = scanText(
      [
        'const qs = new URLSearchParams([["query", "oracle"]]);',
        'await fetch("https://gw.wasiai.io/discover?" + qs);',
      ].join('\n'),
    );
    expect(r.hits).toEqual([]);
  });

  it('LÍMITE DECLARADO: la query string CONCATENADA `"/discover" + "?query=" + v`', () => {
    // `QS_RE` exige el `?` pegado al path. Enseñar "cualquier literal que
    // empiece con `?` cerca de una mención al endpoint" traería ruido de todo
    // el repo; queda declarado en vez de adivinado.
    const r = scanText(
      'await fetch("https://gw.wasiai.io" + "/discover" + "?query=" + t);',
    );
    expect(r.hits).toEqual([]);
  });
});
