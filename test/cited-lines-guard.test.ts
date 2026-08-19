/**
 * Guardián: toda cita `archivo:línea` escrita en los 14 archivos del Corte A
 * está DECLARADA A MANO en `test/cited-lines-guard.citations.ts` con (a) el
 * texto que esa línea tiene que contener y (b) el camino de símbolos que la
 * contiene; y `npm test` se pone en ROJO cuando el texto se movió, cuando la
 * declaración es ambigua, cuando el archivo citado es el equivocado, o cuando
 * aparece una cita nueva sin declarar.
 *
 * ⚠️ EL BUG QUE ESTE TEST EXISTE PARA CAZAR (medido, no supuesto).
 * Hoy NINGÚN test de este repo puede ponerse rojo porque un comentario, un
 * docblock o un nombre de test apunten a la línea equivocada. El guardián
 * estructural más nuevo del repo, `test/payment-guards-live-in-one-place.test.ts`,
 * BORRA los comentarios antes de mirar (`codeOnly`, `:45`) — y tiene que
 * hacerlo, su docblock `:16-20` explica el falso positivo que lo obliga. O sea
 * que el agujero no es un descuido: es estructural.
 *
 * Y la tasa de defecto NO es de gente distraída. Los propios artefactos de esta
 * HU se midieron a sí mismos: el SDD encontró 2 citas mal de ~60 propias, una de
 * ellas por copiar un número de otro documento en vez de abrir el archivo — la
 * violación literal de la regla que estaba redactando en ese momento. El Story
 * File encontró una tercera, y de un tipo peor: el SDD había declarado FALSA una
 * cita que era CORRECTA (`tsconfig.json:19`), o sea que aplicar esa «corrección»
 * habría metido una cita falsa dentro de la HU que existe para sacarlas.
 * 3 de ~60 (5 %) en el mejor caso posible: roles dedicados, concentrados,
 * escribiendo el documento que define cómo no cometer ese error.
 *
 * CÓMO DECIDE. El universo de citas NO se declara: se DERIVA en cada corrida,
 * barriendo los 14 paths con las cuatro formas sintácticas del escáner. Lo único
 * escrito a mano es la AFIRMACIÓN sobre cada cita (`mustContain` + `symbolPath`).
 * Esa asimetría es todo el diseño: derivar la afirmación del contenido actual de
 * la línea daría verde siempre, incluso después de que una inserción corriera el
 * archivo y la cita pasara a apuntar a otra cosa — que es justo el accidente que
 * hay que cazar.
 *
 * ── 🎯 EL REGISTRO NO GUARDA LA LÍNEA DEL CITADOR ──────────────────────────
 *
 * La clave es `{from, cite-token}`; la línea del citador se DERIVA. Guardar un
 * `fromLine` sería construir, dentro del arreglo, el defecto que el arreglo
 * arregla. El mensaje de error SÍ imprime la línea derivada; el registro no la
 * guarda.
 *
 * ── LA COBERTURA HONESTA, QUE SE PUBLICA A PROPÓSITO ───────────────────────
 *
 * El corte se aprobó declarando que cubría el **6,0 %** de las anclas de
 * `src`+`test` (45 de 749 medidas por el SDD) y el **0,21 %** del repo entero
 * (~21.300 anclas, de las cuales `doc/` trackeado aporta ~20.550 en 736
 * citadores). Esos dos porcentajes se publican porque el corte se aprobó con
 * ellos, y hay que leerlos con esta advertencia:
 *
 * ⚠️ **EL NUMERADOR Y EL DENOMINADOR SON LOS DOS PISOS, así que el porcentaje no
 * es confiable en NINGUNA de las dos direcciones.** El numerador medido acá no
 * es 45 (ver más abajo), y el denominador 749 salió del MISMO escáner que se
 * comía los dotfiles, así que también está subestimado. La conclusión que sí se
 * sostiene, y es la única que importa: **lo que este guardián NO cubre es la
 * abrumadora mayoría de las citas del repo.**
 *
 * ⛔ LA FRASE PROHIBIDA es «las citas del repo están verificadas». La única
 * frase admisible es: **«estas citas no pueden mentir sin que la suite se
 * caiga»**. Un guardián verde sobre el 6 % que se presenta como cobertura es
 * exactamente la prosa que afirma de más que esta HU existe para cazar.
 *
 * La cobertura crece por TRINQUETE, no por campaña: `G-C4` obliga a declarar
 * cada cita nueva en el momento en que se escribe, que es cuando es barata.
 * Nadie tiene que acordarse de nada.
 *
 * ── ⚠️ TODO NÚMERO DE ACÁ ES UNA FOTO. DERIVALO, NO LO CITES ───────────────
 *
 * 45, 749, 20.550, 6,0 %, 0,21 % son mediciones de un día concreto, y los
 * controles de `G-C1` son PISOS: envejecen en silencio, que es exactamente el
 * defecto de esta clase. Para derivar el número de hoy: correr `scanSource`
 * sobre `CORTE_A_PATHS` y contar (es lo que hace `FOUND`, más abajo). Si este
 * párrafo y `FOUND.length` no coinciden, el que tiene razón es `FOUND.length`.
 *
 * 🔴 Medido en la implementación: barriendo los 14 paths, el total NO es 45,
 * **es 57**, de los cuales 53 son claves `{from, cite}` distintas: 50
 * declaradas + 3 falsos positivos. (Las 4 ocurrencias de diferencia son tokens
 * repetidos dentro del mismo citador — ver el punto 13.)
 *
 * ⚠️ Y el desglose por forma de HOY es **P1=15 · P2=19 · P3=16 · P4=7**, que NO
 * es el que tenía el árbol al empezar: una de las correcciones de esta misma HU
 * (`compose.ts:130` → `src/services/compose.ts:571`) le agregó el directorio al
 * token y lo movió de P2 a P1. Escribí «P1=14 P2=20» acá y **ya estaba viejo por
 * mi propia edición, en la misma sesión**; lo cazó derivarlo, no releerlo. Es el
 * fenómeno de esta HU aplicándose a esta HU, y por eso el desglose se deriva.
 *
 * ANTES de las correcciones, las formas P1, P2 y P3 coincidían EXACTAMENTE,
 * archivo por archivo, con las dos derivaciones previas (14 / 12 / 16). La
 * diferencia entera estaba en dos poblaciones que esas derivaciones no veían:
 *
 *   · **+8 citas REALES a un DOTFILE** (`.gitignore:172` y compañía, en
 *     `test/sdd-index-matches-folders.exceptions.ts`). Los dos escáneres
 *     anteriores exigían un nombre ANTES del punto de la extensión, y
 *     `.gitignore` no lo tiene. Ésta es la falla compartida que el Story File
 *     anticipó al declarar la concordancia entre los dos escáneres previos como
 *     CONCORDANCIA y no como prueba: «los dos salen de la misma spec, pueden
 *     compartir defecto». Compartían éste. **Y las 8 citas están MAL**, las
 *     cinco corridas exactamente +13 líneas.
 *   · **+4 tokens de RUIDO** en la forma P4 (`{reputation:100}`, `minLength:1`,
 *     y dos `:00` de un timestamp ISO). El escáner los reporta A PROPÓSITO en
 *     vez de descartarlos por rango: una heurística «los números chicos no son
 *     líneas» se come mañana una cita real a la línea 80. Van a
 *     `SCANNER_FALSE_POSITIVES` con motivo escrito, o sea al lado RUIDOSO.
 *
 * ⇒ 45 era, textualmente, un PISO. Lo es.
 *
 * ── QUÉ NO CUBRE (declarado, no arreglado — medir antes de creerle a la lista) ──
 *
 *  1. LAS CITAS EN ARCHIVOS NO TRACKEADOS POR GIT. El universo sale del índice
 *     de git a propósito: es lo que un `checkout` trae, así que no depende del
 *     disco de quien corre los tests. El caso medido y grave es
 *     `.nexus/project-context.md`, que NO está en git.
 *     🪞 Y la ironía es un dato, no un chiste: ese archivo es **justamente el
 *     documento que le pide al lector verificar sus citas**, y es el que ningún
 *     guardián de este repo puede alcanzar. Trackearlo NO es la solución
 *     obvia — este repo es PÚBLICO, meterlo en git publica su contenido. La
 *     deuda (`TD-316-CITAS-PROJECT-CONTEXT`) es «revisar qué contiene y recién
 *     después decidir».
 *  2. LAS CITAS EN PROSA SUELTA: «la línea 95», «el guard de más abajo», «el
 *     docblock de arriba». No tienen forma sintáctica, así que ningún patrón las
 *     devuelve. **Es la razón por la que el conteo de este guardián es un PISO y
 *     no un total, y no hay cota superior conocida.** Las que alguien LEA y
 *     decida que no se pueden anclar van a `UNANCHORABLE_PROSE`; esa lista mide
 *     lo que se leyó, no lo que hay.
 *  3. EL VALOR SEMÁNTICO DE LA AFIRMACIÓN. Se verifica que la línea citada diga
 *     lo declarado; NO que la prosa alrededor sea verdadera. Un comentario con
 *     el número BIEN y la conclusión FALSA pasa en verde. Peor: es el modo de
 *     falla dominante — en el caso medido de `src/services/compose.ts:688` la
 *     afirmación de fondo era correcta y lo único falso era el número, que es
 *     justo lo que hace que «abrir y comparar» confirme la mentira.
 *  4. EL 94 % RESTANTE DE `src`+`test` (704 de 749 anclas medidas) y el 99,8 %
 *     del repo. Ver el bloque de cobertura honesta de arriba.
 *  5. LOS 41 PARES `{file,line}` DE `test/ownership-filter-guard.exceptions.ts`.
 *     No es un hueco: es una DELEGACIÓN, y se escribe porque si no se lee igual.
 *     Ya tienen testigo MEJOR que éste — con precisión de línea y en las DOS
 *     direcciones: `G-09` se pone rojo cuando una excepción ya no corresponde a
 *     su sitio y `G-08` cuando un sitio no tiene excepción. Además son
 *     invisibles para este escáner por construcción: cada par se escribe en dos
 *     líneas separadas (`file: 'src/...'` y `line: 1178`), así que nunca produce
 *     el token `archivo:N`.
 *  6. LAS CITAS A `doc/sdd/_INDEX.md` — dueño `G-F1`/`G-F2`. Ver
 *     `DELEGATED_TARGETS`, vigilado por `G-C9`.
 *  7. LA CITA QUE APUNTA A UNA LÍNEA CORRECTA DE UN ARCHIVO QUE DEJÓ DE SER EL
 *     RELEVANTE: el refactor movió el candado a otro módulo y la vieja línea
 *     sigue existiendo, diciendo lo mismo. Verde, y la prosa miente.
 *  8. LOS RANGOS `A-B`. Se verifica que la conjunción caiga DENTRO del rango, no
 *     que las B−A+1 líneas sigan diciendo lo que la prosa afirma del bloque.
 *  9. `README.md`, `doc/INTEGRATION.md` Y LAS ~20.550 ANCLAS DE `doc/`. Corte D,
 *     y hoy es un programa, no una HU.
 * 10. LA CITA QUE SE ESCRIBE EN UN ARCHIVO FUERA DE LOS 14 PATHS. El universo es
 *     EXPLÍCITO: un archivo nuevo no entra solo. Cada corte siguiente tiene que
 *     ampliar `CORTE_A_PATHS`, y mientras no se amplíe **el silencio es real**.
 * 11. UN ARCHIVO QUE TODAVÍA NO ESTÁ EN EL ÍNDICE DE GIT. Consecuencia de la
 *     misma decisión del punto 1: mientras escribís el archivo, el verde que ves
 *     no habla de él. Se cierra solo al hacer `git add`.
 * 12. LAS CITAS DE LOS PROPIOS ARTEFACTOS DE ESTA HU. `doc/sdd/224-…/sdd.md` y
 *     su `story-file.md` viven en `doc/sdd/`, que no está en el universo de
 *     ningún corte. Las 3 citas falsas que esta HU encontró en sus PROPIOS
 *     documentos son la prueba empírica de que eso importa.
 * 13. EL DUPLICADO EXACTO. Cuando el mismo token aparece dos o más veces en el
 *     mismo citador, UNA declaración cubre todas las ocurrencias: son la misma
 *     afirmación repetida (mismo archivo, misma línea, mismo `mustContain`). Lo
 *     que NO se verifica es que la prosa alrededor de cada ocurrencia diga lo
 *     mismo — eso es el punto 3. No se resuelve con un índice posicional a
 *     propósito: un `nth` es un número de posición, o sea la misma clase de dato
 *     frágil que este guardián existe para no volver a guardar.
 *
 * Naming: G-C1..G-C10.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CITED_LINES,
  CORTE_A_PATHS,
  DELEGATED_TARGETS,
} from './cited-lines-guard.citations.js';
import {
  SCANNER_FALSE_POSITIVES,
  UNANCHORABLE_PROSE,
  UNICITY_EXCEPTIONS,
} from './cited-lines-guard.exceptions.js';
import {
  type CiteForm,
  type FoundCite,
  citeMatchesTarget,
  citeNamesFile,
  isOrderedSubsequence,
  locate,
  normalizeTarget,
  resolveSymbolPath,
  scanSource,
} from './cited-lines-guard.scanner.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/** Contra el ÍNDICE de git, no contra el disco: es lo que `checkout` trae. */
function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean);
}

const TRACKED: readonly string[] = trackedFiles();
const TRACKED_SET = new Set(TRACKED);

/** Índice basename → paths, para el control positivo del cero (`E-WRONG_FILE`). */
const BY_BASENAME = new Map<string, string[]>();
for (const f of TRACKED) {
  const base = f.slice(f.lastIndexOf('/') + 1);
  const list = BY_BASENAME.get(base);
  if (list === undefined) BY_BASENAME.set(base, [f]);
  else list.push(f);
}

const SRC_CACHE = new Map<string, string>();
function readTracked(rel: string): string {
  const hit = SRC_CACHE.get(rel);
  if (hit !== undefined) return hit;
  const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
  SRC_CACHE.set(rel, src);
  return src;
}

/** El universo: se DERIVA en cada corrida, no se declara. */
const FOUND: readonly FoundCite[] = CORTE_A_PATHS.flatMap((p) =>
  scanSource(readTracked(p), p),
);

const FORMS: readonly CiteForm[] = ['P1', 'P2', 'P3', 'P4'];
const countByForm = (form: CiteForm): number =>
  FOUND.filter((c) => c.form === form).length;

const citeKey = (from: string, cite: string): string => `${from} :: ${cite}`;

const DELEGATED_SET = new Set(DELEGATED_TARGETS.map((d) => d.target));
const DELEGATED_BASENAMES = new Set(
  DELEGATED_TARGETS.map((d) => d.target.slice(d.target.lastIndexOf('/') + 1)),
);

/** ¿Esta cita apunta a un target cuyo dueño es OTRO guardián? */
function isDelegated(c: FoundCite): boolean {
  if (c.path === undefined) return false;
  if (DELEGATED_SET.has(c.path)) return true;
  const base = c.path.slice(c.path.lastIndexOf('/') + 1);
  return !c.path.includes('/') && DELEGATED_BASENAMES.has(base);
}

const DECLARED = new Map(CITED_LINES.map((e) => [citeKey(e.from, e.cite), e]));
const FALSE_POSITIVE_KEYS = new Set(
  SCANNER_FALSE_POSITIVES.map((e) => citeKey(e.from, e.cite)),
);
const UNICITY_KEYS = new Set(UNICITY_EXCEPTIONS.map((e) => citeKey(e.from, e.cite)));

/**
 * Las ocurrencias VIVAS por clave. Una misma clave puede aparecer más de una vez
 * en el mismo citador (el mismo token repetido): UNA declaración las cubre a
 * todas, porque son la misma afirmación repetida. Lo que NO se hace es guardar
 * un índice posicional para distinguirlas — sería volver a guardar un número de
 * posición, que es la clase de dato frágil que este guardián no vuelve a tocar.
 */
const OCCURRENCES = new Map<string, FoundCite[]>();
for (const c of FOUND) {
  if (isDelegated(c)) continue;
  const k = citeKey(c.file, c.cite);
  const list = OCCURRENCES.get(k);
  if (list === undefined) OCCURRENCES.set(k, [c]);
  else list.push(c);
}

// ── El algoritmo de los NUEVE códigos de fallo ─────────────────────────────

interface Finding {
  readonly code: string;
  readonly key: string;
  readonly message: string;
}

/** ¿Cuántas líneas tiene el archivo, contadas como las cuenta el escáner? */
const lineCount = (src: string): number => src.split('\n').length;

/**
 * Evalúa UNA entrada declarada, en el orden de §7.4. El orden importa: si el
 * archivo citado no existe, un cero de `locate` no significa «el ancla
 * desapareció», significa que no se buscó en ningún lado.
 */
function evaluate(entry: (typeof CITED_LINES)[number]): Finding[] {
  const key = citeKey(entry.from, entry.cite);
  const out: Finding[] = [];

  // (1) El archivo citado existe y está trackeado.
  if (!TRACKED_SET.has(entry.target)) {
    return [
      {
        code: 'E-TARGET_MISSING',
        key,
        message:
          `el archivo citado \`${entry.target}\` no existe, o no está trackeado por git. ` +
          'Un cero de grep acá NO significa «el ancla desapareció»: significa que no se ' +
          'buscó en ningún lado.',
      },
    ];
  }

  // (2) El token y el `target` declarado hablan del mismo archivo (DT-11).
  if (!citeMatchesTarget(entry.from, entry.cite, entry.target)) {
    out.push({
      code: 'E-CITE_TARGET_MISMATCH',
      key,
      message:
        `la entrada dice \`target: '${entry.target}'\` y el token cita \`${entry.cite}\`: ` +
        'o la entrada se copió de otra y no se corrigió, o el comentario cambió de archivo.',
    });
    return out;
  }

  const targetSrc = readTracked(entry.target);
  const total = lineCount(targetSrc);

  // (3) La línea citada existe dentro del archivo.
  const last = entry.endLine ?? entry.line;
  if (entry.line > total || last > total) {
    out.push({
      code: 'E-LINE_OUT_OF_RANGE',
      key,
      message: `la línea citada está FUERA del archivo: \`${entry.target}\` tiene ${total} líneas.`,
    });
    return out;
  }

  const hits = locate(targetSrc, entry.target, entry.mustContain, entry.symbolPath);

  // (4) La declaración distingue UNA línea. La excepción acota SÓLO esto.
  if (hits.length > 1) {
    if (!UNICITY_KEYS.has(key)) {
      out.push({
        code: 'E-NEEDLE_VACUOUS',
        key,
        message:
          `tu declaración matchea las líneas [${hits.join(', ')}] de \`${entry.target}\`: no puede ` +
          'distinguir la correcta de la equivocada, así que estaría verde apuntando a cualquiera ' +
          'de ellas. Escalera: (1) alargá la conjunción de `mustContain`; (2) si la línea es ' +
          'intrínsecamente no identificable, la cita está mal y se RE-APUNTA a la línea de la ' +
          'FIRMA del símbolo que la contiene; (3) recién ahí, una entrada en ' +
          '`UNICITY_EXCEPTIONS` con el motivo de ESE sitio.',
      });
    }
    // Con excepción de unicidad, la conjunción SIGUE obligada a caer en la
    // línea citada (CD-14: la excepción acota la unicidad, nunca el match).
    if (!hits.includes(entry.line) && !hits.some((h) => h >= entry.line && h <= last)) {
      out.push({
        code: 'E-LINE_MOVED',
        key,
        message:
          `la cita tiene una excepción de UNICIDAD, pero ninguno de sus hits [${hits.join(', ')}] ` +
          `cae en la línea citada (:${entry.line}). La excepción acota la unicidad, NUNCA el match.`,
      });
    }
    return out;
  }

  if (hits.length === 1) {
    const hit = hits[0] as number;
    // (5) El ancla está, pero en otra línea: el archivo se corrió.
    if (hit < entry.line || hit > last) {
      out.push({
        code: 'E-LINE_MOVED',
        key,
        message:
          `se corrió el archivo: tu ancla está ahora en \`${entry.target}:${hit}\` y la cita dice ` +
          `\`:${entry.line}\`. Re-apuntá la cita de \`${entry.from}\`. ` +
          '⚠️ ABRÍ esa línea antes de copiar este número: el mensaje deriva de una needle escrita ' +
          'a mano, así que dice dónde está la needle, NO que la prosa alrededor siga siendo cierta.',
      });
    }
    return out;
  }

  // (6) CERO hits. 🎯 ACÁ VIVE EL CONTROL POSITIVO DEL CERO, DENTRO DEL
  // ALGORITMO: antes de decir «no está», se busca en los HERMANOS con el mismo
  // basename. Un cero sin control positivo se lee como «ya no está» cuando lo
  // que pasa es que el ARCHIVO citado es el equivocado.
  const base = entry.target.slice(entry.target.lastIndexOf('/') + 1);
  const siblings = (BY_BASENAME.get(base) ?? []).filter((f) => f !== entry.target);
  const enHermanos = siblings.flatMap((f) => {
    const hs = locate(readTracked(f), f, entry.mustContain, entry.symbolPath);
    return hs.map((h) => `${f}:${h}`);
  });

  if (enHermanos.length === 1) {
    out.push({
      code: 'E-WRONG_FILE',
      key,
      message:
        `el ARCHIVO citado está mal, no la línea: tu ancla vive en \`${enHermanos[0]}\`. ` +
        `Buscar en \`${entry.target}\` da CERO, y ese cero NO es «ya no está»: hay ` +
        `${siblings.length + 1} archivo(s) con el basename \`${base}\` en el índice de git.`,
    });
    return out;
  }

  // (7) Cero acá y cero en los hermanos: el ancla desapareció de verdad.
  out.push({
    code: 'E-ANCHOR_GONE',
    key,
    message:
      `el ancla desapareció del repo: cero hits en \`${entry.target}\` y cero en los ` +
      `${siblings.length} archivo(s) con el mismo basename` +
      (enHermanos.length > 1 ? ` (hay ${enHermanos.length} candidatos ambiguos: ${enHermanos.join(', ')})` : '') +
      '. Antes de re-apuntar, RELEÉ la prosa: puede que la afirmación también sea falsa ahora, ' +
      'no sólo el número.',
  });
  return out;
}

/** (8) y (9): el símbolo contenedor. Se evalúan aparte porque son AC-4. */
function evaluateSymbol(entry: (typeof CITED_LINES)[number]): Finding[] {
  const key = citeKey(entry.from, entry.cite);
  if (!TRACKED_SET.has(entry.target)) return [];
  const targetSrc = readTracked(entry.target);
  if (entry.line > lineCount(targetSrc)) return [];
  const actual = resolveSymbolPath(targetSrc, entry.target, entry.line);

  // (9) `symbolPath: []` NO es un escape. Si el resolver devuelve algo y la
  // entrada declara `[]`, es rojo: sin esto, las 45 entradas se declararían con
  // `[]` el primer día de fricción y AC-4 quedaría apagado.
  if (entry.symbolPath.length === 0) {
    if (actual.length === 0) return [];
    return [
      {
        code: 'E-SYMBOL_OMITTED',
        key,
        message:
          `la entrada declara \`symbolPath: []\` pero el resolver SÍ devuelve un camino en ` +
          `\`${entry.target}:${entry.line}\`: [${actual.join(' > ')}]. ` +
          '`[]` se admite sólo cuando el resolver no devuelve nada (target sin símbolos, o ' +
          'docblock de cabecera).',
      },
    ];
  }

  // (8) El camino declarado es SUBSECUENCIA ORDENADA del real.
  if (!isOrderedSubsequence(entry.symbolPath, actual)) {
    return [
      {
        code: 'E-SYMBOL_DRIFT',
        key,
        message:
          `la línea \`${entry.target}:${entry.line}\` cae dentro de [${actual.join(' > ')}] y la ` +
          `entrada declara [${entry.symbolPath.join(' > ')}]. O la cita se movió a otro símbolo ` +
          'con el mismo texto, o el símbolo se renombró.',
      },
    ];
  }
  return [];
}

const FINDINGS: readonly Finding[] = CITED_LINES.flatMap(evaluate);
const SYMBOL_FINDINGS: readonly Finding[] = CITED_LINES.flatMap(evaluateSymbol);
const show = (f: Finding): string => `${f.key}\n      ${f.code} · ${f.message}`;

describe('cited lines guard — las citas `archivo:línea` del Corte A', () => {
  // ══════════════════════════════════════════════════════════════
  // CONTROL DE ARMADO (G-C1) Y ANTI-VACUIDAD DEL INSTRUMENTO (G-C2, G-C3)
  // Sin estos, un escáner roto deja el universo vacío y G-C4 pasa en verde sin
  // verificar nada: la falla silenciosa de siempre, adentro del guardián que
  // existe para cazar una falla silenciosa.
  // ══════════════════════════════════════════════════════════════

  it('G-C1: el universo se derivó del índice de git y no es trivial', () => {
    // Input que lo pone en rojo: borrar un path de `CORTE_A_PATHS` (el conteo
    // deja de ser 14). Un `git ls-files` que devuelva vacío (0 archivos
    // trackeados). Romper el regex de una forma (esa forma cae a 0).
    //
    // 🔴 EL PISO POR FORMA NO ES DECORACIÓN. Sin él, romper el regex de P4 sólo
    // bajaría el total y el guardián seguiría verde — y adentro de P4 está la
    // cita falsa del guard anti-doble-débito del camino del dinero
    // (`src/services/compose.ts:688`), que es invisible a las otras tres formas
    // porque se escribe `:208`, sin backticks. Ése es exactamente el modo de
    // falla que dejó pasar el barrido anterior.
    expect(TRACKED.length).toBeGreaterThan(500);
    expect(CORTE_A_PATHS.length).toBe(14);

    const faltantes = CORTE_A_PATHS.filter((p) => !TRACKED_SET.has(p));
    expect(
      faltantes,
      'Hay paths del Corte A que NO están en el índice de git. El universo de este\n' +
        'guardián se deriva del índice a propósito (es lo que un `checkout` trae), así\n' +
        'que un path que no está ahí NO se barre y su silencio no lo avisa nada.\n' +
        'Arreglo: `git add` el archivo, o sacarlo de `CORTE_A_PATHS` con motivo escrito.\n',
    ).toEqual([]);

    // El piso del total. Es un PISO, no la medición del día: la medición del día
    // es `FOUND.length` y se deriva acá arriba. Un piso pegado a la medición
    // pone en rojo cada comentario que alguien borra.
    expect(FOUND.length).toBeGreaterThanOrEqual(40);

    // Y cada una de las CUATRO formas tiene población real.
    const vacias = FORMS.filter((f) => countByForm(f) === 0);
    expect(
      vacias,
      'Hay formas de cita cuyo barrido devolvió CERO. Un cero acá no es "no hay":\n' +
        'es casi siempre un regex roto, y el guardián sigue verde porque el total todavía\n' +
        `supera el piso.\nDistribución de hoy: ${FORMS.map((f) => `${f}=${countByForm(f)}`).join(' ')}\n`,
    ).toEqual([]);

    // Control de armado de este mismo test: `CORTE_A_PATHS` sin duplicados, o
    // el conteo de 14 mentiría sobre cuántos archivos distintos se barren.
    expect(new Set(CORTE_A_PATHS).size).toBe(CORTE_A_PATHS.length);
  });

  it('G-C2: el escáner encuentra las CUATRO formas y no reporta el falso positivo conocido', () => {
    // Fixtures EN MEMORIA con la respuesta conocida de antemano. Sin esto, el
    // único test del escáner sería "lo que el escáner encuentra hoy", que es un
    // instrumento comparándose contra su propia salida: da verde con cualquier
    // implementación, incluida la que no encuentra nada.
    //
    // Input que lo pone en rojo: un escáner que NO REPORTE NUNCA (los positivos
    // quedan en 0). Uno que REPORTE SIEMPRE (`::1` aparece). Quitar el `./` del
    // regex (el caso `./splash.tsx:245` desaparece — es una cita que otro repo
    // perdió de verdad, por exactamente eso). Quitar el soporte de dotfile (el
    // caso `.gitignore:172` deja de traer nombre de archivo y cae a P4).
    const one = (src: string): FoundCite => {
      const hits = scanSource(src, 'src/lib/fixture.ts');
      expect(hits, `fixture sin exactamente 1 cita: ${src}`).toHaveLength(1);
      return hits[0] as FoundCite;
    };

    const p1 = one('// ver src/services/agent.ts:721');
    expect(p1.form).toBe('P1');
    expect(p1.path).toBe('src/services/agent.ts');
    expect(p1.num).toBe(721);

    const rel = one('// ver ./splash.tsx:245');
    expect(rel.form).toBe('P1');
    expect(rel.path).toBe('./splash.tsx');
    expect(normalizeTarget('src/lib/fixture.ts', rel.cite)).toBe('src/lib/splash.tsx');

    const up = one('// ver ../adapters/solana/chain.ts:84');
    expect(up.form).toBe('P1');
    expect(normalizeTarget('src/lib/fixture.ts', up.cite)).toBe(
      'src/adapters/solana/chain.ts',
    );

    const p2 = one('// ver agent.ts:721');
    expect(p2.form).toBe('P2');
    expect(p2.path).toBe('agent.ts');
    // Un token P2 no nombra directorio: no se puede resolver sin inventar una
    // raíz. Lo resuelve el humano en `target`, y el guardián cruza consistencia.
    expect(normalizeTarget('src/lib/fixture.ts', p2.cite)).toBeNull();

    // Un DIRECTORIO que empieza con punto. Es lo que se pierde si alguien le
    // saca el `.` a la clase de caracteres del segmento: el token sigue
    // matcheando pero DECAPITADO (`nexus/project-context.md`), o sea que el
    // cruce contra el `target` declarado empieza a fallar por el archivo
    // equivocado en vez de avisar que el patrón se rompió.
    const dotDir = one('// ver .nexus/project-context.md:6-12');
    expect(dotDir.form).toBe('P1');
    expect(dotDir.path).toBe('.nexus/project-context.md');
    expect(dotDir.endNum).toBe(12);

    const dot = one('// ver `.gitignore:172`');
    expect(dot.form).toBe('P2');
    expect(dot.path).toBe('.gitignore');
    expect(dot.num).toBe(172);

    const p3 = one('// ver `:692`');
    expect(p3.form).toBe('P3');
    expect(p3.cite).toBe('`:692`');
    expect(p3.num).toBe(692);

    const p4 = one('// guard i>0 de :208');
    expect(p4.form).toBe('P4');
    expect(p4.cite).toBe(':208');
    expect(p4.num).toBe(208);

    const rango = one('// ver types/index.ts:203-225');
    expect(rango.num).toBe(203);
    expect(rango.endNum).toBe(225);

    // EL FALSO POSITIVO MEDIDO: `::1` (IPv6, vive en `src/types/index.ts`).
    // La regla es sintáctica y estrecha: el carácter previo a los `:` no puede
    // ser `:`. Un escáner que reporte siempre falla acá.
    expect(scanSource("const local = '::1';", 'src/lib/fixture.ts')).toEqual([]);

    // Y el ruido SÍ se reporta, a propósito. Descartar `:8443` por rango sería
    // inventar una heurística que mañana se come una cita real a la línea 80.
    // El ruido cae del lado RUIDOSO: se exceptúa a mano, no se adivina.
    const puerto = one("const url = 'https://x:8443/y';");
    expect(puerto.form).toBe('P4');
    expect(puerto.num).toBe(8443);

    // Control de armado de este mismo test: un escáner que no reporte nunca
    // haría que TODOS los `one(...)` de arriba fallen, pero los dos `toEqual([])`
    // pasarían. Este par cierra esa asimetría.
    expect(scanSource('// sin ninguna cita acá', 'src/lib/fixture.ts')).toEqual([]);
    expect(scanSource('// dos: a.ts:1 y b.ts:2', 'src/lib/fixture.ts')).toHaveLength(2);
  });

  it('G-C3: el resolver de símbolos no es vacuo y respeta la whitelist de kinds', () => {
    // Input que lo pone en rojo: un resolver que devuelva SIEMPRE `[]` (los
    // positivos fallan). Uno SIN whitelist de kinds, que baja hasta el nodo más
    // interno y devuelve nombres de EXPRESIÓN (`add`, `from`, `request`) que
    // ningún humano escribiría a mano — esa variante se descartó MIDIENDO:
    // fallaba en 4 de 5 casos reales. Uno que use `getStart()` en vez del full
    // start: el docblock deja de mapear a la declaración que documenta, y en
    // este repo casi todas las citas viven en docblocks.
    const clase = [
      'export class C {',
      '  m(): void {',
      '    doSomething();',
      '  }',
      '}',
    ].join('\n');
    expect(resolveSymbolPath(clase, 'src/lib/fixture.ts', 3)).toEqual(['C', 'm']);

    // Docblock de CABECERA: antes de cualquier declaración nombrable. `[]` es la
    // respuesta correcta, y es el único caso en que `symbolPath: []` se admite.
    const cabecera = [
      '/**',
      ' * Un docblock de cabecera, en la línea 2.',
      ' */',
      "import { x } from './x.js';",
      'export function f(): void {}',
    ].join('\n');
    expect(resolveSymbolPath(cabecera, 'src/lib/fixture.ts', 2)).toEqual([]);

    // El docblock de una FUNCIÓN sí mapea a la función: es el full start. Con
    // `getStart()` esto daría `[]` y las citas de docblock quedarían huérfanas.
    const docDeFuncion = [
      "import { x } from './x.js';",
      '/**',
      ' * Documenta `f`, en la línea 3.',
      ' */',
      'export function f(): void {}',
    ].join('\n');
    expect(resolveSymbolPath(docDeFuncion, 'src/lib/fixture.ts', 3)).toEqual(['f']);

    // Los bloques de vitest se nombran por su string literal: es lo que un
    // humano escribiría, y es lo que se lee en la salida de CI.
    const test = [
      "describe('el guardián', () => {",
      "  it('AG-01: hace la cosa', () => {",
      '    expect(1).toBe(1);',
      '  });',
      '});',
    ].join('\n');
    expect(resolveSymbolPath(test, 'test/fixture.test.ts', 3)).toEqual([
      'el guardián',
      'AG-01: hace la cosa',
    ]);

    // `PropertySignature` anidada a 3 niveles de type literal: es la forma del
    // archivo de tipos generado, y el caso que FUERZA el `symbolPath`
    // (`owner_ref: string;` aparece 66 veces en `src/types/database.types.ts`,
    // así que sin ámbito esa cita es indeclarable).
    const tipos = [
      'export type Database = {',
      '  public: {',
      '    Tables: {',
      '      registries: {',
      '        Row: {',
      '          owner_ref: string;',
      '        };',
      '      };',
      '    };',
      '  };',
      '};',
    ].join('\n');
    expect(resolveSymbolPath(tipos, 'src/types/fixture.ts', 6)).toEqual([
      'Database',
      'public',
      'Tables',
      'registries',
      'Row',
      'owner_ref',
    ]);

    // LA WHITELIST, medida: el nodo más interno de una cadena de llamadas trae
    // `add` / `failedCallers`, que es la variante descartada. El resolver tiene
    // que quedarse en la declaración contenedora.
    const cadena = [
      'function accumulateRow(): void {',
      '  failedCallers.add(ANON_CALLER_BUCKET);',
      '}',
    ].join('\n');
    expect(resolveSymbolPath(cadena, 'src/services/fixture.ts', 2)).toEqual([
      'accumulateRow',
    ]);

    // Targets SIN símbolos TS: el resolver devuelve `[]` y el guard exige `[]`.
    expect(resolveSymbolPath('# titulo\ntexto', 'CLAUDE.md', 2)).toEqual([]);
    expect(resolveSymbolPath('{"a": 1}', 'tsconfig.json', 1)).toEqual([]);

    // La SUBSECUENCIA ordenada, que es la regla de comparación de `G-C6`.
    // No es sufijo (esa variante se descartó midiendo) ni igualdad.
    expect(isOrderedSubsequence(['registries', 'Row'], ['Database', 'public', 'Tables', 'registries', 'Row', 'owner_ref'])).toBe(true);
    expect(isOrderedSubsequence(['Row', 'registries'], ['Database', 'registries', 'Row'])).toBe(false);
    expect(isOrderedSubsequence([], ['lo', 'que', 'sea'])).toBe(true);
    expect(isOrderedSubsequence(['noEsta'], ['a', 'b'])).toBe(false);

    // Y `locate` combina las dos condiciones. Control de vacuidad sobre el
    // mecanismo, no sobre un fixture de juguete: con una needle perezosa la
    // conjunción matchea de más y `locate` devuelve más de una línea.
    const dos = ['function f() {', '  if (i > 0) a();', '}', 'function g() {', '  if (i > 0) b();', '}'].join('\n');
    expect(locate(dos, 'src/lib/fixture.ts', ['i > 0'], [])).toEqual([2, 5]);
    expect(locate(dos, 'src/lib/fixture.ts', ['i > 0'], ['g'])).toEqual([5]);
  });

  // ══════════════════════════════════════════════════════════════
  // EL GUARDIÁN PROPIAMENTE DICHO (G-C4..G-C9)
  // ══════════════════════════════════════════════════════════════

  it('G-C4: toda cita que el barrido encuentra está DECLARADA (el universo se deriva)', () => {
    // Input que lo pone en rojo: agregar `// ver foo.ts:42` a cualquiera de los
    // 14 paths. Se pone rojo con el archivo citador, su línea DERIVADA y el
    // token — sin que el registro haya guardado nunca esa línea.
    const huerfanas = [...OCCURRENCES.entries()]
      .filter(([k]) => !DECLARED.has(k) && !FALSE_POSITIVE_KEYS.has(k))
      .flatMap(([, cs]) => cs.map((c) => `${c.file}:${c.line} · ${c.form} · ${c.cite}`))
      .sort();
    expect(
      huerfanas,
      `Hay ${huerfanas.length} cita(s) \`archivo:línea\` sin declarar en los archivos del Corte A.\n` +
        'Una cita sin declarar no puede ponerse roja cuando el archivo citado se corra: es\n' +
        'exactamente el agujero que este guardián existe para cerrar, y se cierra en el momento\n' +
        'en que la cita se escribe, que es cuando es barato.\n' +
        'Arreglo: ABRÍ la línea citada, leela, y agregá una entrada a `CITED_LINES` con el texto\n' +
        'que esa línea tiene que contener y el camino de símbolos que la contiene. NO copies el\n' +
        'texto de ningún documento ni de la salida de ningún escáner.\n' +
        'Si el token NO es una cita (un puerto, un offset), va a `SCANNER_FALSE_POSITIVES` con\n' +
        `el motivo escrito.\nHallazgos:\n${huerfanas.map((h) => `  ${h}`).join('\n')}\n`,
    ).toEqual([]);

    // EL INVARIANTE ESTRICTO. Sin él, una entrada declarada cuyo sitio ya no
    // existe en el fuente no se nota: el conjunto de huérfanas sigue vacío y el
    // registro se va llenando de permisos que ya nadie revisa. (Es AC-8, y por
    // eso además existe G-C7, que lo dice con nombres.)
    expect(
      OCCURRENCES.size,
      'El número de claves `{from, cite}` VIVAS dejó de coincidir con el de entradas\n' +
        'declaradas + falsos positivos. O hay una declaración cuyo sitio desapareció, o una\n' +
        'clave se declaró dos veces.\n',
    ).toBe(DECLARED.size + FALSE_POSITIVE_KEYS.size);

    // Ninguna clave está en DOS cajas a la vez: una cita no puede ser al mismo
    // tiempo una afirmación declarada y un falso positivo del escáner.
    const enDos = [...DECLARED.keys()].filter((k) => FALSE_POSITIVE_KEYS.has(k));
    expect(enDos, 'Hay claves declaradas Y marcadas como falso positivo a la vez.').toEqual([]);

    // Control de armado de este mismo test: si el barrido no encontrara nada,
    // `huerfanas` sería vacío por vacuidad y esto pasaría sin medir nada.
    expect(OCCURRENCES.size).toBeGreaterThanOrEqual(35);
  });

  it('G-C5: el ancla citada sigue ahí, es única, y el archivo citado es el correcto', () => {
    // Input que lo pone en rojo, uno por código:
    //  · mover de sitio la línea anclada           -> E-LINE_MOVED (con el número nuevo)
    //  · declarar `mustContain: ['i > 0']`         -> E-NEEDLE_VACUOUS (5 hits reales)
    //  · `line: 99999`                             -> E-LINE_OUT_OF_RANGE
    //  · `target: 'src/routes/compose.ts'`         -> E-WRONG_FILE apuntando a services/
    //  · `target: 'src/no/existe.ts'`              -> E-TARGET_MISSING
    //  · cambiar el `target` sin cambiar el token  -> E-CITE_TARGET_MISMATCH
    const malas = FINDINGS.map(show);
    expect(
      malas,
      `Hay ${FINDINGS.length} cita(s) declarada(s) que ya no describen lo que hay en el archivo\n` +
        'citado. Cada código dice qué clase de falla es, y la distinción importa:\n' +
        '  E-TARGET_MISSING       el archivo no existe -> un cero de grep NO es "ya no está"\n' +
        '  E-CITE_TARGET_MISMATCH el token y el `target` declarado no hablan del mismo archivo\n' +
        '  E-LINE_OUT_OF_RANGE    la línea citada está fuera del archivo\n' +
        '  E-NEEDLE_VACUOUS       la declaración matchea más de una línea: no distingue nada\n' +
        '  E-LINE_MOVED           el ancla sigue en el repo, en otra línea\n' +
        '  E-WRONG_FILE           el ancla vive en un archivo HERMANO con el mismo basename\n' +
        '  E-ANCHOR_GONE          cero acá y cero en los hermanos: releé la prosa, no sólo el número\n' +
        `Hallazgos:\n${malas.map((m) => `  ${m}`).join('\n')}\n`,
    ).toEqual([]);

    // Control de armado: si `CITED_LINES` estuviera vacío, lo de arriba pasaría
    // sin evaluar una sola cita.
    expect(CITED_LINES.length).toBeGreaterThanOrEqual(35);
  });

  it('G-C6: la línea citada sigue cayendo dentro del símbolo declarado', () => {
    // Input que lo pone en rojo: mover la cita a otra línea DEJANDO la needle
    // (el resolver da otro símbolo -> E-SYMBOL_DRIFT). Vaciar un `symbolPath`
    // que el resolver sí resuelve -> E-SYMBOL_OMITTED.
    //
    // Y la razón por la que esto es OBLIGATORIO no es "por si acaso": es lo
    // único que hace la unicidad SATISFACIBLE. `owner_ref: string;` aparece 66
    // veces en `src/types/database.types.ts`, así que sin ámbito la cita de
    // `CLAUDE.md:212` —correcta, normativa, del criterio de seguridad del
    // repo— sería INDECLARABLE.
    const malas = SYMBOL_FINDINGS.map(show);
    expect(
      malas,
      `Hay ${SYMBOL_FINDINGS.length} cita(s) cuyo camino de símbolos declarado ya no describe\n` +
        'dónde cae la línea citada. Esto se pone rojo INCLUSO cuando el `mustContain` sigue\n' +
        'matcheando, que es el caso en que el texto se duplicó en otro símbolo.\n' +
        `Hallazgos:\n${malas.map((m) => `  ${m}`).join('\n')}\n`,
    ).toEqual([]);

    // Control de armado: si TODAS las entradas declararan `[]`, este control no
    // mediría nada. Al menos una parte sustantiva tiene camino real.
    const conCamino = CITED_LINES.filter((e) => e.symbolPath.length > 0);
    expect(conCamino.length).toBeGreaterThanOrEqual(10);
  });

  it('G-C7: ninguna entrada del registro sobrevive a su sitio citador', () => {
    // Input que lo pone en rojo: borrar el comentario que hace la cita y dejar
    // la entrada. Simétrico de G-09 en `ownership-filter-guard.test.ts`: una
    // lista que se pudre va perdiendo alcance sin avisar, y cada entrada muerta
    // es una afirmación que ya nadie confronta con el código.
    const muertas = [
      ...CITED_LINES.filter((e) => !OCCURRENCES.has(citeKey(e.from, e.cite))).map(
        (e) => `CITED_LINES · ${citeKey(e.from, e.cite)}`,
      ),
      ...SCANNER_FALSE_POSITIVES.filter(
        (e) => !OCCURRENCES.has(citeKey(e.from, e.cite)),
      ).map((e) => `SCANNER_FALSE_POSITIVES · ${citeKey(e.from, e.cite)}`),
      ...UNICITY_EXCEPTIONS.filter(
        (e) => !OCCURRENCES.has(citeKey(e.from, e.cite)),
      ).map((e) => `UNICITY_EXCEPTIONS · ${citeKey(e.from, e.cite)}`),
    ].sort();
    expect(
      muertas,
      'Hay entradas cuyo token ya no aparece en su archivo citador: o el comentario se\n' +
        'borró, o el token cambió de texto (por ejemplo, al corregir el número).\n' +
        'Arreglo: borrar la entrada si la cita desapareció, o actualizar el campo `cite` si el\n' +
        'token cambió. NO dejarla "por las dudas".\n',
    ).toEqual([]);
  });

  it('G-C8: forma y motivo de cada entrada, validados en RUNTIME', () => {
    // Validado en RUNTIME y no por tipo, y la diferencia importa: medido,
    // `tsconfig.json:19` es `include: ["src/**\/*"]` y `package.json:11` es
    // `"lint": "biome check src/"`, así que a este archivo NO lo typechequea CI
    // ni lo lintea nadie. Un `mustContain: []` compila en el editor, no rompe
    // CI y ENTRARÍA AL REPO.
    //
    // Input que lo pone en rojo: `mustContain: []`, o con una needle de 2
    // caracteres (matchea en todos lados). `line: 0`. Dos excepciones con el
    // mismo motivo palabra por palabra. Una entrada de `UNICITY_EXCEPTIONS` sin
    // su declaración en `CITED_LINES`.
    const malas: string[] = [];
    for (const e of CITED_LINES) {
      const k = citeKey(e.from, e.cite);
      if (!CORTE_A_PATHS.includes(e.from)) malas.push(`${k} · \`from\` fuera de CORTE_A_PATHS`);
      if (typeof e.target !== 'string' || e.target.length === 0) malas.push(`${k} · \`target\` vacío`);
      if (!Number.isInteger(e.line) || e.line < 1) malas.push(`${k} · \`line\` no es un entero >= 1`);
      if (e.endLine !== undefined && (!Number.isInteger(e.endLine) || e.endLine < e.line)) {
        malas.push(`${k} · \`endLine\` no es un entero >= \`line\``);
      }
      if (e.mustContain.length === 0) malas.push(`${k} · \`mustContain\` VACÍO: no afirma nada`);
      const cortas = e.mustContain.filter((n) => n.trim().length < 4);
      if (cortas.length > 0) malas.push(`${k} · needles demasiado cortas: ${JSON.stringify(cortas)}`);
      // `targetReason` es obligatorio cuando el token NO nombra archivo (P3/P4)
      // y el target no es el propio citador: es el único caso en que nada
      // mecánico puede cruzar el token contra el `target` (DT-11).
      if (!citeNamesFile(e.cite) && e.target !== e.from && (e.targetReason ?? '').trim().length < 20) {
        malas.push(
          `${k} · falta \`targetReason\`: el token no nombra archivo y el target (${e.target}) no ` +
            'es el citador, así que NADA mecánico puede cruzar los dos. El motivo va escrito.',
        );
      }
    }

    const motivos: string[] = [];
    for (const [nombre, lista] of [
      ['UNICITY_EXCEPTIONS', UNICITY_EXCEPTIONS.map((e) => ({ k: citeKey(e.from, e.cite), reason: e.reason }))],
      ['SCANNER_FALSE_POSITIVES', SCANNER_FALSE_POSITIVES.map((e) => ({ k: citeKey(e.from, e.cite), reason: e.reason }))],
      ['UNANCHORABLE_PROSE', UNANCHORABLE_PROSE.map((e) => ({ k: `${e.from} :: ${e.quote}`, reason: e.reason }))],
    ] as const) {
      for (const e of lista) {
        if (typeof e.reason !== 'string' || e.reason.trim().length < 40) {
          malas.push(`${nombre} · ${e.k} · motivo vacío o demasiado corto para decir algo`);
        }
        motivos.push(e.reason.trim());
      }
    }
    // Un motivo genérico repetido es el fracaso de este archivo aunque todo esté
    // en verde: si dos sitios comparten motivo palabra por palabra, uno de los
    // dos no se leyó.
    expect(new Set(motivos).size, 'Hay motivos repetidos palabra por palabra.').toBe(motivos.length);

    // 🔴 CD-14, EL CANDADO QUE IMPIDE EL INTERRUPTOR DE APAGADO. Una excepción
    // de unicidad acota SÓLO el `hits === 1`. La cita sigue OBLIGADA a estar
    // declarada, a que el archivo exista, a que la línea exista y a que la
    // conjunción matchee ESA línea. Sin esto, cualquiera que vea un rojo
    // escribe una excepción y el guardián deja de medir.
    for (const e of UNICITY_EXCEPTIONS) {
      const k = citeKey(e.from, e.cite);
      if (!DECLARED.has(k)) {
        malas.push(
          `UNICITY_EXCEPTIONS · ${k} · exceptúa la unicidad de una cita que NO está declarada en ` +
            '`CITED_LINES`. La excepción acota la unicidad, NUNCA la declaración.',
        );
      }
    }

    expect(
      malas.sort(),
      'Hay entradas cuya FORMA no se sostiene en runtime. Nada de esto lo caza el editor:\n' +
        'este archivo no lo typechequea CI ni lo lintea nadie.\n',
    ).toEqual([]);
  });

  it('G-C9: la delegación tiene dueño VIVO', () => {
    // Input que lo pone en rojo: borrar `G-F2` de
    // `test/sdd-index-matches-folders.test.ts`, o borrar `CITED_INDEX_LINES` de
    // su archivo de excepciones.
    //
    // 🔴 Sin este control, borrar `G-F2` dejaría las citas `_INDEX.md:N` sin
    // dueño Y sin que nada avise: `G-C4` las seguiría descartando en silencio
    // por estar en `DELEGATED_TARGETS`, o sea que la delegación se convertiría
    // en un agujero con cara de decisión.
    //
    // ⚠️ La población de citas delegadas hoy es 0, y este control NO afirma que
    // sea > 0: eso sería un candado que se pudre solo el día que alguien borre
    // la última. Lo que afirma es que el dueño existe.
    const muertos: string[] = [];
    for (const d of DELEGATED_TARGETS) {
      if (!TRACKED_SET.has(d.target)) muertos.push(`${d.target} · el target delegado no está en git`);
      if (d.reason.trim().length < 40) muertos.push(`${d.target} · motivo demasiado corto`);
    }
    const excSrc = readTracked('test/sdd-index-matches-folders.exceptions.ts');
    const testSrc = readTracked('test/sdd-index-matches-folders.test.ts');
    if (!excSrc.includes('export const CITED_INDEX_LINES')) {
      muertos.push('CITED_INDEX_LINES ya no se exporta desde test/sdd-index-matches-folders.exceptions.ts');
    }
    for (const g of ["it('G-F1", "it('G-F2"]) {
      if (!testSrc.includes(g)) muertos.push(`${g} ya no existe en test/sdd-index-matches-folders.test.ts`);
    }
    expect(
      muertos,
      'La delegación declarada en `DELEGATED_TARGETS` perdió a su dueño. Las citas a ese\n' +
        'target quedan sin verificar por NADIE, y este guardián las sigue descartando.\n' +
        'Arreglo: o se restituye el guardián dueño, o esas citas pasan a declararse acá.\n',
    ).toEqual([]);

    // Control de armado: una lista vacía haría pasar lo de arriba por vacuidad.
    expect(DELEGATED_TARGETS.length).toBeGreaterThanOrEqual(1);
  });

  // ══════════════════════════════════════════════════════════════
  // EL GUARDIÁN DECLARA LO QUE NO CUBRE (G-C10)
  // ══════════════════════════════════════════════════════════════

  it('G-C10: el docblock declara por escrito qué NO cubre este guardián', () => {
    // Input que lo pone en rojo: borrar la sección de no-cobertura, o bajarla de
    // 8 ítems, o sacarle cualquiera de los tres literales que el AC exige.
    //
    // Esto NO es ceremonia: un guardián verde sobre el 6 % de las anclas se lee
    // como "las citas del repo están verificadas" si nadie escribió al lado qué
    // queda afuera. Merece su propio `it(` y no un assert escondido dentro de
    // otro control, porque el lugar donde tiene que leerse es la salida de CI.
    const self = readTracked('test/cited-lines-guard.test.ts');
    const marca = 'QUÉ NO CUBRE';
    expect(self.includes(marca), 'falta la sección de no-cobertura').toBe(true);

    const seccion = self.slice(self.indexOf(marca), self.indexOf('Naming: G-C1'));
    const items = seccion.match(/^\s*\*\s{0,2}\d+\.\s/gm) ?? [];
    expect(
      items.length,
      `La sección de no-cobertura tiene ${items.length} ítems numerados y hacen falta al\n` +
        'menos 8. Cada ítem es un silencio que alguien LEYÓ y decidió dejar; sin escribirlo,\n' +
        'el verde de este archivo se lee como cobertura.\n',
    ).toBeGreaterThanOrEqual(8);

    // Los TRES literales que el criterio de aceptación exige nombrar.
    for (const literal of ['NO TRACKEADOS POR GIT', 'PROSA SUELTA', 'VALOR SEMÁNTICO']) {
      expect(
        seccion.includes(literal),
        `La sección de no-cobertura no nombra «${literal}», que es uno de los tres\n` +
          'que el criterio de aceptación exige declarar explícitamente.\n',
      ).toBe(true);
    }

    // Los DOS porcentajes de cobertura honesta, y la frase prohibida declarada
    // como prohibida. Un guardián que no publica su cobertura afirma de más.
    expect(self.includes('6,0 %')).toBe(true);
    expect(self.includes('0,21 %')).toBe(true);
    expect(self.includes('LA FRASE PROHIBIDA')).toBe(true);

    // Control de armado de este mismo test: si `self` viniera vacío, todos los
    // `includes` de arriba serían false y esto no haría falta — pero si viniera
    // con el archivo equivocado, pasarían por casualidad. Esto lo ancla.
    expect(self.includes('Naming: G-C1..G-C10')).toBe(true);
  });
});
