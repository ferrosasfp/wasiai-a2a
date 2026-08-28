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
 *     falla dominante — en el caso medido de `src/services/compose.ts:751` la
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
 * 14. 🎯 LOS 5 ARCHIVOS DE ESTE GUARDIÁN. No están en `CORTE_A_PATHS`, y son los
 *     citadores más densos del repo: medido con `scanSource` sobre ellos
 *     mismos, **761 tokens** (`sample` 356 · `exceptions` 121 · `citations` 119
 *     · `test` 103 · `scanner` 62) contra 57 en TODO el Corte A. O sea que el
 *     guardián tiene TRECE VECES más citas que el universo que vigila, en
 *     archivos que él mismo no mira.
 *     🔴 **Y ESTE ÍTEM ES EL QUE MEJOR SE DENUNCIA A SÍ MISMO: envejeció EN LA
 *     HU QUE LO ESCRIBIÓ.** Decía «LOS 4 ARCHIVOS … 261 tokens», y WKH-371
 *     agregó el quinto (`cited-lines-guard.sample.ts`, 356 tokens, las 120
 *     etiquetas de la muestra) sin que nada lo avisara: 261 → 761, 2,9×. El
 *     número lo re-derivó el CR de esta HU, no un control. (Foto del
 *     2026-08-28, la sexta —243 · 247 · 260 · 261 · y ahora 761—. Que se mueva
 *     cada vez que alguien escribe prosa acá es exactamente lo que el ítem
 *     denuncia; que haya hecho falta un revisor humano para notarlo, también.
 *     ⚠️ Y ESTE MISMO PÁRRAFO LO MOVIÓ MIENTRAS SE ESCRIBÍA: la primera
 *     derivación dio 752 y el desglose tenía 5 en el grupo del dotfile; al
 *     reescribir el ítem se perdió un literal y ganaron 9 tokens de prosa
 *     nueva, así que la segunda derivación dio 761 con 4. Los números de acá
 *     son los de la ÚLTIMA pasada, corrida después de la última edición.)
 *     **Se decidió declararlo y NO incluirlos, y la razón es medida, no de
 *     esfuerzo** — el desglose de los 761, re-derivado el 2026-08-28 con la
 *     regla escrita al lado de cada categoría:
 *       · **589** son `:N` sueltos (P3/P4) sin archivo: números de línea
 *         citados dentro de la prosa que explica el algoritmo, más los `cite:`
 *         sueltos de las 120 entradas de la muestra. (Regla: `!citeNamesFile`.)
 *       · **49** son literalmente el valor del campo `cite` de una de las 31
 *         entradas de `CITED_LINES` que nombran archivo. Ésos YA tienen
 *         testigo, y mejor que el de acá: `G-C5` verifica esa misma cita contra
 *         el archivo apuntado y `G-C7` se pone rojo si el token desaparece de
 *         su citador. (Regla: el token está en el conjunto de los `cite`
 *         declarados. ⚠️ El «89» anterior salía de otra regla, que nadie
 *         escribió; éste trae la suya.)
 *       · **32** nombran archivos que el ÍNDICE DE GIT no tiene, y son CUATRO
 *         grupos:
 *           — **16** son fixtures en memoria de `G-C2`/`G-C3`
 *             (`./splash.tsx:245` ×5, `foo.ts:42` ×3, `a.ts:1` ×2, `b.ts:2` ×2,
 *             `../../lib/fixture.ts:3` ×2, `./no/existe.ts:1` ×2): ésos no
 *             existen ni pueden existir.
 *           — **8** son `x.io:8443`, que NO es un archivo: es el host y el
 *             puerto de la URL de calibración. La propia HU lo declara ruido
 *             legítimo CON path (ver el barrido de `G-C11`), así que llamarlo
 *             «un archivo que no existe ni puede existir» era generalizar.
 *           — **4** nombran `.nexus/project-context.md`, y son DOS tokens
 *             distintos: 3 × `:6` + 1 × `:6-12`. Ese archivo SÍ existe en disco
 *             y NO está trackeado, así que es —literalmente— el ejemplo de la
 *             segunda salida de emergencia que el candado 2️⃣ declara y no
 *             cierra (`TD-316-CITAS-PROJECT-CONTEXT`).
 *           — **4** nombran `wasiai-remittance-agents/src/manifest/registry.ts`
 *             (`:76` ×2, `:77`, `:275`). Son de OTRO repo, y los agregó
 *             WKH-371 al arreglar dos citas sueltas que resolvían al archivo
 *             equivocado: el arreglo cambia un destino inventado por un path
 *             que este índice no puede verificar (`TD-371-PORTABILIDAD`).
 *         Declararlos a todos exigiría una excusa escrita por cada fixture, o
 *         sea llenar el archivo de excusas de ruido para poder verificar otra
 *         cosa.
 *       · **91** nombran un archivo trackeado; de ésos, 9 son el token
 *         HISTÓRICO `.gitignore:172` —el bug que esta HU arregló, citado como
 *         ejemplo de lo que estaba mal—, que por construcción ya no describe esa
 *         línea. Meter los 5 archivos al corte convertiría cada mención del bug
 *         en una cita rota.
 *     El residuo real —las citas de estos 4 archivos que sí afirman algo sobre
 *     otro archivo— **se verificó A MANO, una por una, y ninguna es falsa**: las
 *     ~20 anteriores las abrió el AR; las que agregó el fix-pack se abrieron al
 *     escribirlas (`fee-split.ts:316` = `const failed = …`, `:320` =
 *     `return settlement;`, `:335` NO menciona `priorTx`, con
 *     `git status --porcelain src/` vacío ⇒ disco = `HEAD`). El segundo
 *     fix-pack (el del re-AR) NO agregó ningún token nuevo que nombre un archivo
 *     trackeado —esa categoría quedó en 36—: sus tokens nuevos son un `cite` ya
 *     declarado y tres del ejemplo que ilustra la segunda salida de emergencia,
 *     que por definición no resuelve.
 *     🪞 EL TERCERO —el fix-pack de prosa del CR, que escribió estas mismas
 *     líneas— SÍ agregó dos, y se declaran acá porque callarlos sería el defecto
 *     que esta HU persigue: `test/readme-parity.test.ts:105` y
 *     `test/scripts-imported-by-tests-are-tracked.test.ts:61`. Las dos se
 *     abrieron al escribirlas y las dos son ciertas (`:105` es el string
 *     `'src/lib/downstream-payment.ts:186-194'` dentro de una línea de código;
 *     `:61` es `function stripComments(source: string): string`). Corregir una
 *     afirmación falsa de este archivo SUBE la deuda de este mismo ítem: 36 → 41
 *     trackeados, 247 → 260 tokens — y el salto necesitó DOS pasadas, porque
 *     escribir el número lo movió. Lo que no tienen es
 *     testigo MECÁNICO, y ésa es la diferencia que este ítem declara: cada vez
 *     que este archivo crece, crece la prosa que nadie confronta. Queda como
 *     `TD-224-CITAS-DEL-PROPIO-GUARDIAN`, y su arreglo NO es agregar los paths:
 *     es un corte que sepa distinguir un token que AFIRMA de uno que es DATO.
 *
 * 15. 🎯 EL DISCRIMINADOR DE CITAS SUELTAS (`classifyBareCite`, WKH-371) DECIDE
 *     A QUÉ ARCHIVO, NO A QUÉ LÍNEA, y ni siquiera eso lo decide siempre.
 *     Medido sobre el perímetro `src`+`test`+`scripts` al commit `19405ba`
 *     (1152 tokens sueltos, sin los 8 archivos auto-referentes): **38 `CITA`,
 *     953 `RUIDO`, 25 `DATO` y 136 `INDECIDIBLE`**. O sea que sobre 8 de cada
 *     10 tokens que NO son ruido, el guardián sigue sin poder decir nada — y
 *     `INDECIDIBLE` es una respuesta legítima, no un error, pero es SILENCIO.
 *     Lo que este discriminador NO cubre, medido y no supuesto:
 *       · **LA LÍNEA.** Un `:839` que nombra el archivo correcto y una línea que
 *         se movió sale `CITA` igual. El número lo cruza `G-C5` con su
 *         `mustContain`, y sólo para las citas DECLARADAS en `CITED_LINES`.
 *       · **LOS DESTINOS CROSS-REPO.** Un contexto
 *         `wasiai-remittance-agents/…/registry.ts:76` apunta afuera del índice
 *         de git de este repo. Si el párrafo nombrara además UN SOLO archivo de
 *         acá, se devolvería ÉSE. ⚠️ **Es un modo PREVISTO y con 0 instancias
 *         medidas**: barridos los 1152 tokens del universo al commit base, los
 *         13 que nombran un repo ajeno en su párrafo salen `RUIDO` (6), `DATO`
 *         (3) o `INDECIDIBLE` (4), y ninguno `CITA`. Decir «es un falso
 *         positivo medido» —como decía este renglón— era publicar un modo
 *         hipotético como medición, que es el defecto que esta HU persigue.
 *       · **LA AUTO-CITA**, que es la forma PRINCIPAL en que este repo escribe
 *         una cita suelta y sigue sin resolverse. La regla D5 se degradó a
 *         `INDECIDIBLE` porque su censo completo —`D5_CENSUS`, 36 sitios
 *         abiertos a mano— midió **17 de 36 que NO son auto-citas** (13
 *         apuntan a otro archivo y 4 no son citas). Queda `TD-371-AUTOCITA`.
 *       · **EL PÁRRAFO CORTADO POR UNA LÍNEA ` *` VACÍA.** El contexto que
 *         decide suele estar del otro lado de un separador de docblock. Es la
 *         causa medida de varios de los `INDECIDIBLE` de arriba.
 *
 * Naming: G-C1..G-C19 (con `G-C17b`, `G-C17c` y `G-C17d`).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CITED_LINES,
  CORTE_A_PATHS,
  DELEGATED_TARGETS,
  type DelegatedTarget,
} from './cited-lines-guard.citations.js';
import {
  D5_CENSUS,
  SCANNER_FALSE_POSITIVES,
  UNANCHORABLE_PROSE,
  UNICITY_EXCEPTIONS,
} from './cited-lines-guard.exceptions.js';
import {
  type BareLabel,
  type BareVerdict,
  type CiteForm,
  type FoundCite,
  citeMatchesTarget,
  citeNamesFile,
  citeTargetIfTracked,
  classifyBareCite,
  isOrderedSubsequence,
  locate,
  normalizeTarget,
  resolveContextTarget,
  resolveSymbolPath,
  scanSource,
  stripComments,
} from './cited-lines-guard.scanner.js';
import {
  RESERVED_SAMPLE,
  SAMPLE_BASE_COMMIT,
  SAMPLE_SEED,
  SELF_REFERENTIAL,
  STRATUM_N,
  drawReservedSample,
  oracleKey,
  sampleFrame,
  siteKey,
} from './cited-lines-guard.sample.js';

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

/**
 * 🔴 LAS FALLAS DE UNA DELEGACIÓN, contra un índice de git y un lector
 * INYECTADOS. Es la parte de `G-C9` que tiene que valer para CUALQUIER entrada,
 * y por eso es una función y no una lista de literales adentro del `it(`.
 *
 * La versión anterior de `G-C9` pedía dos cosas por entrada —target trackeado y
 * motivo de 40 caracteres— y verificaba el dueño con literales HARDCODEADOS de
 * la única entrada que existía (`G-F1`, `G-F2`, `CITED_INDEX_LINES`). Medido:
 * una entrada nueva con `ownedBy: 'NADIE. No existe ningún guardián que
 * verifique estas citas.'` sacaba 3 citas reales del universo con el guardián en
 * **10/10 verde**, y como `OCCURRENCES` y `DECLARED` bajan a la par, el
 * invariante estricto de `G-C4` quedaba balanceado y tampoco avisaba. Una
 * delegación es la excusa más barata de escribir —una entrada saca hasta 4
 * claves de una vez— y tenía la cara más respetable: parece una decisión de
 * arquitectura.
 *
 * Pura sobre sus entradas a propósito: `G-C12` la prueba con fixtures en memoria
 * en las DOS direcciones (dueño vivo → 0 fallas; dueño inventado → falla) y
 * `G-C9` la aplica al árbol real. Sin ese par, el control volvería a ser «lo que
 * la lista dice hoy».
 *
 * ⚠️ LO QUE ESTO NO VERIFICA, y hay que leerlo antes de apoyarse en su verde:
 * comprueba que el dueño EXISTA, que CORRA (hay un `*.test.ts` entre sus
 * archivos), que sus controles sigan escritos y que NOMBRE este target. NO
 * comprueba que el dueño efectivamente VERIFIQUE las citas a ese target — es la
 * misma clase de límite que «presencia, no valor» del guardián de ownership.
 * Quien escribe una delegación sigue teniendo que abrir al dueño y leerlo; lo
 * que ya no puede es inventarlo.
 *
 * 🔴 Y ACÁ ESTÁ ESCRITO **CÓMO SE CAE**, que es lo que faltaba. La primera
 * versión hacía los dos `includes()` sobre el fuente CRUDO, así que **un
 * COMENTARIO alcanzaba**. Medido, sin inventar nada: `src/lib/downstream-payment.ts`
 * delegado a `src/lib/money-invariants.fuzz.test.ts` —un archivo que existe,
 * que corre, cuyos controles siguen escritos y que nombra el target en un
 * comentario— sacaba **4 claves del módulo de liquidación del money-path** del
 * universo con el guardián en **12/12 verde**. La delegación es la excusa más
 * BARATA que queda (una entrada saca N claves de una vez, contra 1 de
 * `SCANNER_FALSE_POSITIVES`), así que era la que menos podía conformarse con
 * prosa.
 *
 * DECISIÓN, entre las dos que había: se EXIGE la coincidencia **en código**, no
 * en prosa — `stripComments` antes de los `includes()`. La alternativa era
 * escribir «el comentario cuenta» y dejar que el revisor lo supiera; se
 * descartó porque el defecto que este guardián persigue es exactamente
 * «la prosa dice una cosa y la máquina otra», y aceptar la prosa acá sería
 * escribir la excepción adentro del control que la prohíbe. Instrumento:
 * `stripComments`, el mismo criterio que `codeOnly` en
 * `test/payment-guards-live-in-one-place.test.ts` (Corte A, fuera de scope: no
 * se tocó ni se importó de ahí).
 *
 * ⚠️ Lo que ESTO tampoco cierra, con esas palabras — y acá el costo está
 * MEDIDO, no estimado. La versión anterior de este párrafo decía que el costo
 * «subió de escribir un comentario a escribir código muerto que alguien va a
 * ver en el diff; no bajó a cero». Eso es FALSO, y falso en el sentido
 * peligroso: dice que cuesta MÁS de lo que cuesta (CR `MNR-cr-1`).
 *
 * 1. `stripComments` borra los bloques y las líneas que son SÓLO comentario.
 *    **NO borra el comentario al final de una línea de código.** Medido
 *    llamando a la función: `// <target>` y un bloque que nombre el target se
 *    BORRAN; `const _C = 1; // cubre <target>` SOBREVIVE. O sea que el costo
 *    de esta excusa no es «código muerto»: es **un comentario**, sólo que
 *    pegado al final de una línea de código.
 * 2. Y hay un escalón más abajo: **CERO líneas escritas**. Hoy, en `main`,
 *    `test/readme-parity.test.ts:105` ya nombra `src/lib/downstream-payment.ts`
 *    dentro de un string de una línea de CÓDIGO —sobrevive `stripComments`— y
 *    es un `*.test.ts` que corre. Pero no verifica una sola cita: compara qué
 *    archivos nombran los dos README. Delegarle ese target saca sus 4 claves
 *    del universo sin escribir nada en ningún lado.
 *
 * O sea: la delegación sigue siendo **el interruptor más barato del guardián**
 * —una entrada saca N claves de una vez, contra 1 de `SCANNER_FALSE_POSITIVES`—
 * y su candado sigue siendo de PRESENCIA, no mecánico. Queda ABIERTO y con
 * nombre: `TD-224-DELEGACION-CUESTA-CERO`, y su costo real, medido, es CERO
 * líneas. `G-C12` mide que `stripComments` se APLIQUE; no mide que apagar la
 * delegación sea caro.
 */
function delegationFindings(
  d: DelegatedTarget,
  tracked: ReadonlySet<string>,
  read: (rel: string) => string | null,
): string[] {
  const out: string[] = [];
  const tag = `DELEGATED_TARGETS · ${d.target}`;
  // Lecturas defensivas: a este archivo no lo typechequea CI, así que una
  // entrada a la que le falte un campo tiene que dar un mensaje, no un TypeError.
  const ownedBy = typeof d.ownedBy === 'string' ? d.ownedBy : '';
  const reason = typeof d.reason === 'string' ? d.reason : '';
  const ownerFiles = (Array.isArray(d.ownerFiles) ? d.ownerFiles : []).filter(
    (f): f is string => typeof f === 'string' && f.length > 0,
  );
  const ownerControls = (Array.isArray(d.ownerControls) ? d.ownerControls : []).filter(
    (c): c is string => typeof c === 'string',
  );

  if (typeof d.target !== 'string' || !tracked.has(d.target)) {
    out.push(`${tag} · el target delegado no está en el índice de git`);
  }
  if (reason.trim().length < 40) out.push(`${tag} · motivo demasiado corto`);

  const sources = new Map<string, string>();
  for (const f of ownerFiles) {
    if (!tracked.has(f)) {
      out.push(`${tag} · el archivo del dueño \`${f}\` no está en el índice de git`);
      continue;
    }
    const src = read(f);
    // 🔴 `stripComments` acá y no en el `read`: lo que se guarda es el CÓDIGO del
    // dueño. Un comentario que nombra el target o que menciona un control ya
    // borrado no cuenta — ver la decisión escrita en el docblock de arriba.
    if (src === null) out.push(`${tag} · no se pudo leer el archivo del dueño \`${f}\``);
    else sources.set(f, stripComments(src));
  }

  if (ownerFiles.length === 0) {
    out.push(
      `${tag} · sin \`ownerFiles\`: el dueño es una FRASE («${ownedBy.slice(0, 40)}…») y nada lo abre. ` +
        'Una delegación sin archivo que abrir es un agujero con cara de decisión.',
    );
  } else if (![...sources.keys()].some((f) => f.endsWith('.test.ts'))) {
    out.push(
      `${tag} · ninguno de los \`ownerFiles\` legibles es un \`*.test.ts\`: un dueño que no CORRE no es un dueño.`,
    );
  }

  if (ownerFiles.length > 0 && !ownerFiles.some((f) => ownedBy.includes(f))) {
    out.push(
      `${tag} · \`ownedBy\` no nombra ninguno de sus \`ownerFiles\`: la prosa y la máquina están ` +
        'diciendo cosas distintas, que es el defecto que este guardián persigue.',
    );
  }

  if (ownerControls.length === 0) {
    out.push(`${tag} · sin \`ownerControls\`: nada prueba que el dueño siga teniendo controles vivos.`);
  }
  const all = [...sources.values()];
  for (const c of ownerControls) {
    if (c.trim().length < 4) {
      out.push(`${tag} · el control \`${c}\` es demasiado corto para identificar nada`);
    } else if (!all.some((s) => s.includes(c))) {
      out.push(
        `${tag} · el control \`${c}\` ya NO existe en el CÓDIGO de ` +
          `[${[...sources.keys()].join(', ')}] (los comentarios no cuentan). ` +
          'Las citas a este target quedaron sin dueño y este guardián las sigue descartando.',
      );
    }
  }

  if (typeof d.target === 'string' && !all.some((s) => s.includes(d.target))) {
    out.push(
      `${tag} · ninguno de los \`ownerFiles\` NOMBRA \`${d.target}\` EN CÓDIGO: lo menciona la prosa ` +
        'o no lo menciona nadie. Un archivo que nombra el target en un comentario y no lo vigila ' +
        'es la delegación más barata que existe, y saca N claves del universo de una vez.',
    );
  }
  return out;
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
    // (`src/services/compose.ts:751`), que es invisible a las otras tres formas
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

    // 🔴 CD-14, EL CANDADO QUE IMPIDE EL INTERRUPTOR DE APAGADO — Y VALE PARA
    // LAS TRES LISTAS DE `exceptions.ts`, no sólo para la primera.
    //
    // 1️⃣ Una excepción de unicidad acota SÓLO el `hits === 1`. La cita sigue
    // OBLIGADA a estar declarada, a que el archivo exista, a que la línea exista
    // y a que la conjunción matchee ESA línea. Sin esto, cualquiera que vea un
    // rojo escribe una excepción y el guardián deja de medir.
    for (const e of UNICITY_EXCEPTIONS) {
      const k = citeKey(e.from, e.cite);
      if (!DECLARED.has(k)) {
        malas.push(
          `UNICITY_EXCEPTIONS · ${k} · exceptúa la unicidad de una cita que NO está declarada en ` +
            '`CITED_LINES`. La excepción acota la unicidad, NUNCA la declaración.',
        );
      }
    }

    // 2️⃣ `SCANNER_FALSE_POSITIVES` es la lista que exceptúa TODO: la clave sale
    // del conjunto de huérfanas de `G-C4` Y del invariante estricto. Medido: sin
    // este candado, mover una cita REAL, con path y normativa
    // (`CLAUDE.md :: src/types/database.types.ts:2567`) desde `CITED_LINES` hasta
    // acá, con una excusa plausible de 40 caracteres, dejaba el guardián en
    // 10/10 VERDE. Ninguno de los otros controles lo notaba: el token se sigue
    // encontrando, sólo se deja de verificar, así que ni `FOUND.length` ni el
    // invariante se mueven un milímetro.
    //
    // ⚠️ La regla NO es «ningún token con path» — `https://x.io:8443/y` produce
    // un P2 con path (`x.io`) que es ruido legítimo. La regla es «ningún token
    // que nombre un archivo TRACKEADO POR GIT», y las dos direcciones las mide
    // `G-C11` con fixtures en memoria.
    //
    // 🚧 ACOTAR NO ES CERRAR — y son DOS salidas, no una:
    //
    //   (a) UN TOKEN SIN ARCHIVO. Un `:N` suelto (P3/P4) se puede seguir
    //       moviendo acá con una excusa, porque nada mecánico separa un `:336`
    //       que cita una línea de un `:8443` que es un puerto.
    //   (b) UN TOKEN QUE SÍ NOMBRA UN ARCHIVO, PERO QUE NO ESTÁ EN EL ÍNDICE DE
    //       GIT. `citeTargetIfTracked` pregunta por el ÍNDICE, no por el disco,
    //       así que un archivo que existe pero nadie trackeó devuelve `null` y
    //       también se puede declarar ruido. Repro medida: una cita a
    //       `.nexus/project-context.md:6` escrita en un archivo del Corte A, más
    //       su entrada acá, deja el guardián en 12/12 VERDE.
    //       🔴 Y la asimetría es lo que lo hace un defecto y no una elección: la
    //       MISMA cita declarada en `CITED_LINES` pone el guardián en ROJO
    //       (`E-TARGET_MISSING`). Declarada ruido, pasa en verde.
    //       NO se cierra leyendo el disco A PROPÓSITO: el índice es lo que un
    //       `checkout` trae, y un guardián que dependa de qué archivos sueltos
    //       tenga cada quien en su working tree da distinto en CI que en local.
    //       Población hoy dentro del Corte A: 0. Es una frase que falta, no un
    //       agujero abierto — `TD-316-CITAS-PROJECT-CONTEXT`.
    //
    // Cuánto cubre el candado: `CITED_LINES.filter(citeNamesFile)` sobre
    // `CITED_LINES.length`. Al 2026-08-19 eran 31 de 50 — es una FOTO, no la
    // cites: derivala con `citeNamesFile` sobre `CITED_LINES`, que es la única
    // fuente que no envejece. Las otras 19 dependen de que quien escriba la
    // excusa la escriba en serio, y de que quien revise la lea.
    const ruidoQueNombraArchivoTrackeado = (
      lista: readonly { readonly from: string; readonly cite: string }[],
    ): string[] =>
      lista.flatMap((e) => {
        const hit = citeTargetIfTracked(e.from, e.cite, TRACKED_SET, BY_BASENAME);
        return hit === null
          ? []
          : [
              `SCANNER_FALSE_POSITIVES · ${citeKey(e.from, e.cite)} · el token NOMBRA un archivo que ` +
                `EXISTE en el índice de git (\`${hit}\`), así que no es ruido del escáner: es una ` +
                'AFIRMACIÓN sobre el repo. Va a `CITED_LINES` con su `mustContain`, o se corrige el ' +
                'comentario. Esta lista es la única que exceptúa TODO, y por eso es la que no admite ' +
                'excusas: apagar una cita real acá es indistinguible de un guardián sano.',
            ];
      });

    const hallazgosDelRuidoReal = ruidoQueNombraArchivoTrackeado(SCANNER_FALSE_POSITIVES);
    malas.push(...hallazgosDelRuidoReal);

    // ══ EL TESTIGO NEGATIVO DE ESTE CANDADO, SOBRE EL REGISTRO REAL ══════════
    //
    // 🔴 POR QUÉ ACÁ ADENTRO Y NO EN `G-C11`. `G-C11` prueba la REGLA
    // (`citeTargetIfTracked`) con fixtures en memoria; NADA probaba que `G-C8`
    // la APLIQUE al registro real. La diferencia no es teórica: se midieron dos
    // arreglos truchos que dejaban el guardián en 12/12 VERDE con `G-C11`
    // intacto —
    //   · TRUCHO A: una línea de filtro adentro de este barrido
    //     (`if (e.reason.trim().length > 150) continue;`) más la cita real
    //     movida acá con una excusa larga. La regla sigue perfecta; deja de
    //     aplicarse.
    //   · TRUCHO B: hacer que `citeTargetIfTracked` resuelva SÓLO los basenames
    //     que los fixtures de `G-C11` usan. Los 6 casos positivos de `G-C11`
    //     son justo ésos, así que sigue verde, y `downstream-payment.ts:772`
    //     —money-path— se puede declarar ruido.
    //
    // Cómo los mata este testigo, que es lo que hay que leer antes de tocarlo:
    //
    //  1. Los canarios son citas REALES del registro, con su `from` y su token
    //     originales — no fixtures. Un `citeTargetIfTracked` que sólo resuelva
    //     un puñado de basenames deja de resolver la mayoría de los canarios y
    //     la resta no da. (Al 2026-08-19: 18 basenames distintos, FOTO.)
    //  2. Cada canario se emite UNA VEZ POR CADA `reason` que hoy vive en
    //     `SCANNER_FALSE_POSITIVES`, leído en RUNTIME. Un filtro por `reason`
    //     que esconda una entrada nueva esconde también a los canarios que
    //     llevan ESA MISMA `reason`, y la resta no da.
    //  3. Los canarios se barren EN LA MISMA LLAMADA que las entradas reales,
    //     appendeados. Un `continue` por índice, o un `break`, o un `slice`,
    //     recorta a los canarios igual que a las entradas.
    //  4. Se compara el DELTA contra la corrida sin canarios, no un número
    //     escrito a mano: el testigo no se pudre cuando la lista real cambie.
    //
    // Lo que este testigo NO cierra, con esas palabras: un mutante que
    // discrimine por el CONTENIDO del token (por ejemplo, ignorar exactamente
    // el único token que se quiere apagar) sigue pasando. Lo que dejó de ser
    // posible es apagar el candado ENTERO, o filtrarlo por `reason`.
    //
    // 🔴 Y SÓLO por `reason`. Este párrafo decía «o por un campo de la
    // entrada», y eso era FALSO para el campo `from` (CR `MNR-cr-2`). El
    // testigo emite un canario por cada `reason` REAL, pero los canarios
    // llevan el `from` de las citas que siguen en `CITED_LINES`: una cita que
    // el atacante SACA de `CITED_LINES` deja de aportar su `from`. Repro
    // medida, 12/12 VERDE: mover `src/services/agent.payment.test.ts ::
    // downstream-payment.ts:247` —la FIRMA de `settleSolanaLeg`, money-path—
    // a `SCANNER_FALSE_POSITIVES` con una excusa larga, más una línea en el
    // barrido de arriba: `if (e.from === 'src/services/agent.payment.test.ts')
    // return [];`. Cuesta exactamente lo mismo que el TRUCHO A que este
    // testigo acaba de cerrar. Funciona porque ese citador aporta EXACTAMENTE
    // 1 canario, y derivado hoy 3 de los 11 citadores están así:
    // `src/services/agent.ts`, `src/services/agent.payment.test.ts` y
    // `src/routes/agents.publish.test.ts` (FOTO del 2026-08-19 — derivala
    // agrupando `citasQueNombranArchivo` por `from`).
    // El arreglo —emitir también un canario por cada `from` real, el mismo
    // patrón que ya se usa para `reason`— NO se hizo en esta HU: queda
    // ABIERTO como `TD-224-CANARIOS-POR-FROM`.
    const citasQueNombranArchivo = CITED_LINES.filter(
      (c) =>
        citeNamesFile(c.cite) &&
        TRACKED_SET.has(c.target) &&
        citeMatchesTarget(c.from, c.cite, c.target),
    );
    // Control de vacuidad: sin canarios, la resta de abajo daría 0 === 0 y este
    // testigo aplaudiría cualquier implementación. El piso es 10 y no el número
    // de hoy a propósito — un `toBe(31)` se pudre con la primera cita que
    // alguien agregue o borre.
    expect(
      citasQueNombranArchivo.length,
      'No quedan citas declaradas que nombren un archivo trackeado, así que el testigo del\n' +
        'candado 2️⃣ se quedó sin material y estaría pasando por vacuidad.\n',
    ).toBeGreaterThanOrEqual(10);

    const CANARIOS = [
      // El canario base: no depende de que la lista de ruido tenga entradas.
      ...citasQueNombranArchivo.map((c) => ({
        from: c.from,
        cite: c.cite,
        reason: 'canario sintético: esta entrada no existe en disco, sólo dentro de este assert',
      })),
      // Y uno por cada `reason` REAL de la lista, leído en runtime: es lo que
      // hace que un filtro por `reason` no pueda esconder una entrada nueva.
      ...SCANNER_FALSE_POSITIVES.flatMap((e) =>
        citasQueNombranArchivo.map((c) => ({ from: c.from, cite: c.cite, reason: e.reason })),
      ),
    ];
    const conCanarios = ruidoQueNombraArchivoTrackeado([...SCANNER_FALSE_POSITIVES, ...CANARIOS]);
    expect(
      conCanarios.length - hallazgosDelRuidoReal.length,
      'EL CANDADO 2️⃣ DEJÓ DE APLICARSE AL REGISTRO REAL.\n' +
        'Se metieron citas REALES de `CITED_LINES` en el barrido de `SCANNER_FALSE_POSITIVES` y el\n' +
        'barrido NO las marcó. O `citeTargetIfTracked` dejó de resolver, o el bucle de arriba\n' +
        'ganó un filtro que saltea entradas. `G-C11` puede seguir verde: prueba la REGLA, no su\n' +
        'aplicación — que es exactamente el agujero que este assert existe para tapar.\n',
    ).toBe(CANARIOS.length);
    // 🚧 LO QUE ESTE TESTIGO NO SE APLICA A SÍ MISMO — declarado, NO cerrado.
    // El esperado (`CANARIOS.length`) se deriva del PROPIO conjunto de
    // canarios. Eso lo hace inmortal a los cambios del registro —que es para
    // lo que se eligió— y CIEGO a que el conjunto se achique. Repro medida
    // (CR `MNR-cr-3`), 12/12 VERDE: borrar las 5 líneas del bloque de canarios
    // por `reason` de acá arriba —las que un comentario declara como lo que
    // mata el filtro por `reason`— deja el guardián en 12/12 sin que nada se
    // ponga rojo; y con ese bloque borrado, el TRUCHO A vuelve a pasar. El
    // único piso es el `toBeGreaterThanOrEqual(10)` de arriba, que cubre SÓLO
    // los canarios base y no dice nada de los canarios por `reason`.
    // Es un RESIDUAL, no un agujero: exige editar el guardián. Se declara y no
    // se arregla A PROPÓSITO — cerrar el meta-nivel (un assert de armado del
    // propio testigo, derivado, del estilo del que ya existe en `G-C11`) es la
    // HU siguiente, no ésta. Queda con nombre: `TD-224-QUIEN-VIGILA-AL-TESTIGO`.

    // 3️⃣ `UNANCHORABLE_PROSE` es para prosa SIN forma sintáctica. Si el `quote`
    // contiene algo que el propio escáner sabe encontrar, entonces se puede
    // anclar por definición. Esta lista no saca nada del universo (no puede
    // apagar un rojo), pero sí es donde terminaría archivándose lo que da
    // trabajo declarar.
    for (const e of UNANCHORABLE_PROSE) {
      const dentro = scanSource(e.quote, e.from);
      if (dentro.length > 0) {
        malas.push(
          `UNANCHORABLE_PROSE · ${e.from} :: ${e.quote} · el \`quote\` contiene ` +
            `${dentro.length} token(s) que el escáner SÍ encuentra (${dentro.map((c) => c.cite).join(', ')}): ` +
            'no es prosa suelta, es una cita con forma. Va a `CITED_LINES`.',
        );
      }
    }

    expect(
      malas.sort(),
      'Hay entradas cuya FORMA no se sostiene en runtime. Nada de esto lo caza el editor:\n' +
        'este archivo no lo typechequea CI ni lo lintea nadie.\n',
    ).toEqual([]);
  });

  it('G-C9: la delegación tiene dueño VIVO, verificado POR ENTRADA', () => {
    // Input que lo pone en rojo: borrar `G-F2` de
    // `test/sdd-index-matches-folders.test.ts`, o borrar `CITED_INDEX_LINES` de
    // su archivo de excepciones. Y —esto es lo que ANTES no pasaba— agregar una
    // entrada nueva con un dueño inventado: `ownedBy: 'NADIE…'` sin
    // `ownerFiles`, o con `ownerFiles` que no nombran el target.
    //
    // 🔴 Sin este control, borrar `G-F2` dejaría las citas `_INDEX.md:N` sin
    // dueño Y sin que nada avise: `G-C4` las seguiría descartando en silencio
    // por estar en `DELEGATED_TARGETS`, o sea que la delegación se convertiría
    // en un agujero con cara de decisión.
    //
    // 🔴 Y con la versión hardcodeada de este control —tres literales de
    // `_INDEX.md` escritos a mano— la delegación era EL SEGUNDO INTERRUPTOR DE
    // APAGADO: cualquier entrada NUEVA pasaba sin que su dueño se mirara. Ahora
    // cada entrada se evalúa con `delegationFindings`, que es la misma función
    // que `G-C12` prueba en las dos direcciones con fixtures en memoria.
    //
    // ⚠️ La población de citas delegadas hoy es 0, y este control NO afirma que
    // sea > 0: eso sería un candado que se pudre solo el día que alguien borre
    // la última. Lo que afirma es que el dueño existe, corre, y nombra al target.
    const leer = (rel: string): string | null => {
      try {
        return readTracked(rel);
      } catch {
        return null;
      }
    };
    const muertos = DELEGATED_TARGETS.flatMap((d) =>
      delegationFindings(d, TRACKED_SET, leer),
    ).sort();
    expect(
      muertos,
      'La delegación declarada en `DELEGATED_TARGETS` perdió a su dueño, o nunca lo tuvo.\n' +
        'Las citas a ese target quedan sin verificar por NADIE, y este guardián las sigue\n' +
        'descartando ANTES de todo (`isDelegated`), así que el silencio es total: ni el\n' +
        'conjunto de huérfanas ni el invariante estricto de `G-C4` se mueven.\n' +
        'Arreglo: o se restituye el guardián dueño, o esas citas pasan a declararse acá.\n' +
        `Hallazgos:\n${muertos.map((m) => `  ${m}`).join('\n')}\n`,
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

    // 🪞 SE MIRA EL DOCBLOCK, NO EL ARCHIVO ENTERO, y esto NO es cosmético:
    // medido con un mutante, `expect(self.includes('<literal>'))` es un control
    // que NO PUEDE ponerse rojo JAMÁS, porque el literal que busca está escrito
    // en la misma línea que lo busca. Reemplacé el literal por
    // `ZZ-NUMERO-QUE-NO-EXISTE-EN-NINGUN-LADO` —una cadena que no está en ningún
    // otro lugar del repo— y el control siguió **10/10 verde**: se satisfacía a
    // sí mismo. Es un guardián comparándose contra su propia salida, adentro del
    // guardián que existe para cazar prosa que nadie confronta. Recortando la
    // cabecera (todo lo que está ANTES del primer `import`), los `includes` se
    // evalúan contra la PROSA y no contra el assert.
    const cabecera = self.slice(0, self.indexOf('\nimport {'));
    expect(
      cabecera.length,
      'No se pudo recortar el docblock de cabecera: sin el recorte, todos los `includes`\n' +
        'de este control se satisfacen solos.\n',
    ).toBeGreaterThan(1000);

    const marca = 'QUÉ NO CUBRE';
    expect(cabecera.includes(marca), 'falta la sección de no-cobertura').toBe(true);

    const seccion = cabecera.slice(cabecera.indexOf(marca), cabecera.indexOf('Naming: G-C1'));
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
    //
    // ⚠️ SE CLAVA LA FORMA, NO LOS DÍGITOS, y la razón es un candado que se
    // pudría solo: acá había `expect(self.includes('6,0 %'))` y
    // `expect(self.includes('0,21 %'))` sobre dos números que el bloque de
    // arriba declara NO CONFIABLES en ninguna de las dos direcciones, y que una
    // deuda registrada (`TD-316-CITAS-DOTFILE-EN-OTROS-CORTES`) se compromete a
    // RE-DERIVAR. El día que alguien cumpla esa deuda, el porcentaje correcto
    // entra en conflicto con el literal y el rojo no señala nada falso: señala
    // que el candado apunta a un número que su propio autor declaró equivocado.
    // Lo normativo de AC-10 es que la cobertura se PUBLIQUE con su advertencia,
    // no cuánto da hoy.
    const cobertura = cabecera.slice(
      cabecera.indexOf('LA COBERTURA HONESTA'),
      cabecera.indexOf(marca),
    );
    const porcentajes = cobertura.match(/\d+,\d+ %/g) ?? [];
    expect(
      porcentajes.length,
      'El bloque de cobertura honesta tiene que publicar los DOS porcentajes (el de\n' +
        '`src`+`test` y el del repo entero). Se verifica que estén publicados, NO cuánto dan:\n' +
        'clavar los dígitos es un candado que se pudre el día que alguien re-derive el\n' +
        'denominador, que es una deuda registrada.\n',
    ).toBeGreaterThanOrEqual(2);
    expect(
      cobertura.includes('LOS DOS PISOS'),
      'Falta la advertencia de que numerador y denominador son PISOS. Un porcentaje\n' +
        'publicado sin ella se lee como una medición, y no lo es.\n',
    ).toBe(true);
    expect(
      cabecera.includes('LA FRASE PROHIBIDA'),
      'El docblock dejó de declarar cuál es la frase PROHIBIDA. Es la mitad normativa de\n' +
        'AC-10: publicar un porcentaje sin decir cómo NO se puede leer es afirmar de más.\n',
    ).toBe(true);

    // Control de armado de este mismo test: si `cabecera` viniera vacía o del
    // archivo equivocado, los `includes` de arriba pasarían por casualidad o
    // fallarían todos juntos. Esto lo ancla al archivo correcto.
    expect(cabecera.includes('Naming: G-C1..G-C19')).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════
  // LOS TESTIGOS DE LOS DOS CANDADOS (G-C11, G-C12)
  // Un candado sin testigo es una línea de código que nadie midió: la primera
  // versión de CD-14 se aplicó a la lista equivocada y las otras dos listas
  // quedaron siendo el interruptor de apagado. Estos dos controles prueban la
  // REGLA con fixtures en memoria y en las DOS direcciones — el caso malo tiene
  // que morir y el caso bueno tiene que seguir pasando.
  //
  // 🔴 Y EL MISMO ESTÁNDAR, APLICADO A ESTOS DOS: un testigo de la REGLA no es
  // un testigo de su APLICACIÓN. Estos dos usan fixtures en memoria a propósito
  // —es lo que los hace independientes del árbol—, y por eso mismo NO ven si el
  // guardián sigue LLAMÁNDOLOS sobre el registro real. Se midieron dos arreglos
  // truchos que dejaban a `G-C11` en verde con el candado apagado (un filtro
  // adentro del barrido de `G-C8`; un `citeTargetIfTracked` que resuelve sólo
  // los basenames que los fixtures de acá usan). Quien cubre eso es el testigo
  // NEGATIVO que vive adentro de `G-C8`, sobre el registro real, y hacen falta
  // los dos: el de acá dice qué responde la función, el de allá dice que se la
  // sigue preguntando. Lo mismo vale para `G-C12` y su aplicación en `G-C9`.
  // ══════════════════════════════════════════════════════════════

  it('G-C11: el candado de `SCANNER_FALSE_POSITIVES` mata la cita real y deja pasar el ruido', () => {
    // El universo de git de juguete, para que el fixture no dependa del árbol.
    const tracked = new Set([
      'src/types/database.types.ts',
      'src/lib/fixture.ts',
      'src/lib/splash.tsx',
      '.gitignore',
      'CLAUDE.md',
    ]);
    const byBase = new Map<string, readonly string[]>();
    for (const f of tracked) {
      const b = f.slice(f.lastIndexOf('/') + 1);
      byBase.set(b, [...(byBase.get(b) ?? []), f]);
    }
    const T = (from: string, token: string): string | null =>
      citeTargetIfTracked(from, token, tracked, byBase);

    // 🔴 EL CASO MALO — el mutante medido que dejaba 10/10 verde: la cita real,
    // P1, normativa, del criterio de seguridad del repo, movida a la lista de
    // ruido con una excusa plausible. Tiene que resolver a un archivo trackeado.
    expect(T('CLAUDE.md', 'src/types/database.types.ts:2567')).toBe(
      'src/types/database.types.ts',
    );
    // Y sus variantes: P2 por basename, `./` y `../` resueltos contra el citador,
    // y el sufijo alineado por segmento que `citeMatchesTarget` acepta.
    expect(T('CLAUDE.md', 'database.types.ts:2567')).toBe('src/types/database.types.ts');
    expect(T('src/lib/fixture.ts', './splash.tsx:245')).toBe('src/lib/splash.tsx');
    expect(T('src/lib/x/y.ts', '../../lib/fixture.ts:3')).toBe('src/lib/fixture.ts');
    expect(T('CLAUDE.md', 'types/database.types.ts:2567')).toBe('src/types/database.types.ts');
    expect(T('CLAUDE.md', '.gitignore:185')).toBe('.gitignore');

    // ✅ EL CASO BUENO — LA CALIBRACIÓN, y es la mitad que hace que la regla sea
    // usable: `https://x.io:8443/y` produce un token P2 CON PATH (`x.io`) que es
    // ruido legítimo del escáner. Si la regla fuera «ningún token con path», este
    // caso quedaría sin poder declararse y el arreglo sería peor que el bug.
    const url = scanSource("const u = 'https://x.io:8443/y';", 'src/lib/fixture.ts');
    expect(url).toHaveLength(1);
    expect((url[0] as FoundCite).form).toBe('P2');
    expect((url[0] as FoundCite).path).toBe('x.io');
    expect(T('src/lib/fixture.ts', (url[0] as FoundCite).cite)).toBeNull();

    // Y el resto del ruido que hoy está declarado: los `:N` sueltos no nombran
    // archivo, así que el candado no les cuesta nada.
    expect(T('src/types/index.ts', ':100')).toBeNull();
    expect(T('src/types/index.ts', ':1')).toBeNull();
    expect(T('src/services/agent.payment.test.ts', ':00')).toBeNull();
    expect(T('src/lib/fixture.ts', '`:692`')).toBeNull();
    // Un archivo que NO existe en el índice tampoco es una afirmación verificable.
    expect(T('src/lib/fixture.ts', 'foo.ts:42')).toBeNull();
    expect(T('src/lib/fixture.ts', './no/existe.ts:1')).toBeNull();

    // Control de armado de este mismo test: una función que devolviera SIEMPRE
    // `null` pasaría todos los `toBeNull()` de arriba, y una que devolviera
    // siempre un string pasaría los otros. Están los dos lados, y este par lo
    // deja explícito.
    expect(T('CLAUDE.md', 'CLAUDE.md:212')).toBe('CLAUDE.md');
    expect(T('CLAUDE.md', ':212')).toBeNull();
  });

  it('G-C12: el candado de la delegación mata al dueño inventado y deja pasar al real', () => {
    const tracked = new Set([
      'doc/sdd/_INDEX.md',
      'test/sdd-index-matches-folders.test.ts',
      'test/sdd-index-matches-folders.exceptions.ts',
      'src/services/discovery.ts',
      'test/otro-guardian.test.ts',
      'test/dueno-de-comentario.test.ts',
    ]);
    const FUENTES: Record<string, string> = {
      'test/sdd-index-matches-folders.test.ts':
        "const INDEX_REL = 'doc/sdd/_INDEX.md';\nit('G-F1: …', () => {});\nit('G-F2: …', () => {});",
      'test/sdd-index-matches-folders.exceptions.ts':
        "// citas a doc/sdd/_INDEX.md\nexport const CITED_INDEX_LINES = [];",
      'test/otro-guardian.test.ts': "it('X-01: no habla de ningún target delegado', () => {});",
      // 🔴 El dueño REPURPOSADO: existe, corre, su control sigue escrito, y
      // nombra el target… en un comentario. Es la forma exacta del exploit
      // medido con `src/lib/money-invariants.fuzz.test.ts`.
      'test/dueno-de-comentario.test.ts':
        '/**\n * Invariantes del money-path sobre src/services/discovery.ts.\n */\n' +
        "// también menciona src/services/discovery.ts acá\n" +
        "it('X-02: un invariante que no verifica ninguna cita', () => {});\n" +
        '// el control viejo era X-03, ya no existe\n',
    };
    const leer = (rel: string): string | null => FUENTES[rel] ?? null;
    const bueno: DelegatedTarget = {
      target: 'doc/sdd/_INDEX.md',
      ownedBy: 'G-F1/G-F2 en test/sdd-index-matches-folders.test.ts',
      ownerFiles: [
        'test/sdd-index-matches-folders.test.ts',
        'test/sdd-index-matches-folders.exceptions.ts',
      ],
      ownerControls: ["it('G-F1", "it('G-F2", 'export const CITED_INDEX_LINES'],
      reason: 'x'.repeat(41),
    };

    // ✅ EL CASO BUENO: el dueño existe, corre, sus controles están escritos y
    // nombra al target. Cero hallazgos.
    expect(delegationFindings(bueno, tracked, leer)).toEqual([]);

    // 🔴 EL CASO MALO MEDIDO: el mutante que sacaba 3 citas reales del universo
    // con 10/10 verde. Sin `ownerFiles`, el dueño es una frase.
    const inventado = {
      target: 'src/services/discovery.ts',
      ownedBy: 'NADIE. No existe ningún guardián que verifique estas citas.',
      reason: 'x'.repeat(41),
    } as unknown as DelegatedTarget;
    expect(delegationFindings(inventado, tracked, leer).length).toBeGreaterThan(0);

    // Y las variantes con MEJOR cara, que son las que hay que cazar: un dueño
    // que existe pero no habla de este target; un `ownerFiles` que no corre; un
    // control que ya no está; una prosa que nombra un archivo que no declaró.
    const noHablaDelTarget: DelegatedTarget = {
      ...bueno,
      target: 'src/services/discovery.ts',
      ownedBy: 'G-F1 en test/sdd-index-matches-folders.test.ts',
    };
    expect(delegationFindings(noHablaDelTarget, tracked, leer)).toEqual([
      expect.stringContaining('EN CÓDIGO'),
    ]);

    // 🔴 EL TERCER INTERRUPTOR, y el más barato de todos: el dueño REPURPOSADO.
    // Existe, CORRE, su control sigue escrito, y nombra el target — pero lo
    // nombra en un COMENTARIO. Con los `includes()` sobre el fuente crudo esto
    // daba CERO hallazgos y sacaba N claves del universo de una vez; medido con
    // `src/lib/money-invariants.fuzz.test.ts` sobre
    // `src/lib/downstream-payment.ts`: 4 claves del módulo de liquidación del
    // money-path, con el guardián en 12/12 VERDE.
    const duenoDeComentario: DelegatedTarget = {
      target: 'src/services/discovery.ts',
      ownedBy: 'los invariantes de test/dueno-de-comentario.test.ts',
      ownerFiles: ['test/dueno-de-comentario.test.ts'],
      ownerControls: ["it('X-02"],
      reason: 'x'.repeat(41),
    };
    expect(delegationFindings(duenoDeComentario, tracked, leer)).toEqual([
      expect.stringContaining('EN CÓDIGO'),
    ]);

    // Y la otra mitad del mismo cambio: un `ownerControl` que sólo sobrevive en
    // un comentario tampoco cuenta. Un control BORRADO cuyo nombre quedó en la
    // prosa («el control viejo era X-03») es indistinguible de uno vivo si se
    // mira el fuente crudo.
    const controlSoloEnComentario: DelegatedTarget = {
      ...duenoDeComentario,
      ownerControls: ["it('X-02", 'X-03'],
    };
    expect(delegationFindings(controlSoloEnComentario, tracked, leer)).toEqual([
      expect.stringContaining('X-03` ya NO existe en el CÓDIGO'),
      expect.stringContaining('EN CÓDIGO'),
    ]);

    // ✅ LA CALIBRACIÓN DE ESTE MISMO CAMBIO: exigir CÓDIGO no puede romper al
    // dueño real. El bueno de arriba nombra `doc/sdd/_INDEX.md` en una línea de
    // código (`const INDEX_REL = …`) y sus tres controles son `it(`/`export
    // const`, no prosa. Si `stripComments` borrara de más, este caso sería el
    // primero en caerse.
    expect(delegationFindings(bueno, tracked, leer)).toEqual([]);

    const duenoQueNoCorre: DelegatedTarget = {
      ...bueno,
      ownedBy: 'CITED_INDEX_LINES en test/sdd-index-matches-folders.exceptions.ts',
      ownerFiles: ['test/sdd-index-matches-folders.exceptions.ts'],
      ownerControls: ['export const CITED_INDEX_LINES'],
    };
    // ⚠️ Dos hallazgos, no uno, y el segundo es la MEDICIÓN del cambio a
    // código-y-no-prosa: este `ownerFiles` nombra `doc/sdd/_INDEX.md` sólo en su
    // línea de comentario, así que además de no correr, tampoco declara el
    // target en código. Con los `includes()` sobre el fuente crudo daba uno solo.
    expect(delegationFindings(duenoQueNoCorre, tracked, leer)).toEqual([
      expect.stringContaining('no CORRE'),
      expect.stringContaining('EN CÓDIGO'),
    ]);

    const controlBorrado: DelegatedTarget = {
      ...bueno,
      ownerControls: ["it('G-F1", "it('G-F3"],
    };
    expect(delegationFindings(controlBorrado, tracked, leer)).toEqual([
      expect.stringContaining("G-F3` ya NO existe"),
    ]);

    const prosaQueNoCoincide: DelegatedTarget = {
      ...bueno,
      ownedBy: 'algún guardián por ahí',
    };
    expect(delegationFindings(prosaQueNoCoincide, tracked, leer)).toEqual([
      expect.stringContaining('no nombra ninguno de sus `ownerFiles`'),
    ]);

    const archivoFantasma: DelegatedTarget = {
      ...bueno,
      ownedBy: 'test/no-existe.test.ts',
      ownerFiles: ['test/no-existe.test.ts'],
    };
    expect(delegationFindings(archivoFantasma, tracked, leer).length).toBeGreaterThan(0);

    // Control de armado de este mismo test: una función que devolviera SIEMPRE
    // hallazgos haría fallar el caso bueno, y una que no devolviera NINGUNO
    // haría fallar los seis malos. Los dos lados están medidos arriba.
    expect(delegationFindings(bueno, tracked, leer)).toHaveLength(0);
  });

  // ══════════════════════════════════════════════════════════════
  // EL DISCRIMINADOR DE CITAS SUELTAS (G-C13..G-C17c) — WKH-371
  //
  // 🔴 QUÉ AGUJERO TAPAN. `citeMatchesTarget` abre con `if (raw === null)
  // return true`, y `citePathOf` devuelve `null` para TODO token P3/P4. O sea
  // que el cruce mecánico entre un `:N` suelto y el `target` declarado a mano
  // devolvía `true` sin mirar nada: `E-CITE_TARGET_MISMATCH` no podía dispararse
  // jamás para esas entradas. `classifyBareCite` es lo que permite cruzarlas.
  //
  // 🔴 Y EL ESTÁNDAR QUE SE APLICAN A SÍ MISMOS. `G-C13`..`G-C16` usan fixtures
  // EN MEMORIA con la respuesta escrita antes — es lo que los hace
  // independientes del árbol, y por eso mismo NO prueban nada sobre el árbol.
  // Quien mide contra el árbol es `G-C17` (el oráculo que ya existía en el repo
  // desde agosto) y `G-C17b` (la muestra reservada, etiquetada a mano en un
  // commit ANTERIOR a que `classifyBareCite` existiera). Hacen falta los cuatro:
  // los primeros dicen qué contesta la función, los últimos dicen cuánto acierta.
  // ══════════════════════════════════════════════════════════════

  /** El índice de git de juguete que usan los fixtures en memoria. */
  const toyTracked = new Set([
    'src/services/agent.ts',
    'src/types/agent.ts',
    'src/services/compose.ts',
    'src/lib/fixture.ts',
    'src/adapters/chain-resolver.ts',
    // Los DOS homónimos del fixture.
    //
    // ⚠️ Acá había dos rutas INVENTADAS bajo el directorio de documentos, con
    // el basename que en este repo es el caso real —el de los documentos de
    // HU, que tiene más de cien candidatos en el índice—. Lo puso rojo OTRO
    // guardián, `test/docs-referenced-by-code-exist.test.ts`, que verifica que
    // todo path con forma de documento nombrado por el código EXISTA. Y no
    // alcanzó con cambiar el fixture: ese guardián es TEXTUAL, así que la
    // primera versión de este mismo comentario —que citaba las dos rutas para
    // explicar el arreglo— lo volvió a poner rojo. Por eso acá no se escriben.
    //
    // Se cambió el NOMBRE, no la propiedad: lo único que este fixture necesita
    // es un basename con más de un candidato.
    'src/uno/homonimo.ts',
    'src/otro/homonimo.ts',
  ]);
  const toyByBase = new Map<string, string[]>();
  for (const f of toyTracked) {
    const b = f.slice(f.lastIndexOf('/') + 1);
    toyByBase.set(b, [...(toyByBase.get(b) ?? []), f]);
  }
  /** Clasifica el ÚNICO token suelto de un fixture en memoria. */
  const clasificar = (src: string, file = 'src/lib/fixture.ts'): BareVerdict => {
    const sueltos = scanSource(src, file).filter((h) => h.form === 'P3' || h.form === 'P4');
    expect(sueltos, `el fixture no tiene exactamente 1 token suelto: ${src}`).toHaveLength(1);
    return classifyBareCite(sueltos[0] as FoundCite, src, toyTracked, toyByBase);
  };

  it('G-C13: la cascada emite EXACTAMENTE una de las cuatro clases, y las cuatro son alcanzables', () => {
    // Input que lo pone en rojo: una cascada que devuelva `CITA` también para
    // `D1` deja la clase RUIDO vacía y este test lo nombra. Una que devuelva
    // siempre `INDECIDIBLE` deja vacías tres.
    const casos: ReadonlyArray<readonly [BareLabel, string]> = [
      ['RUIDO', "const u = 'http://localhost:3001/x';"],
      ['DATO', "const e = { cite: ':692' };"],
      ['CITA', '// el guard de `src/services/agent.ts:12` y su hermano de `:20`'],
      ['INDECIDIBLE', '// `src/services/agent.ts:12` y `src/services/compose.ts:9`, y el `:20`'],
    ];
    const vistas = new Set<BareLabel>();
    for (const [esperada, src] of casos) {
      const v = clasificar(src);
      expect(v.label, `fixture «${src}» salió ${v.label} (${v.why})`).toBe(esperada);
      // `target` presente si Y SÓLO SI es CITA. Sin las dos direcciones, una
      // implementación que devolviera siempre `target` pasaría la mitad.
      expect(v.target !== undefined, `target incoherente con label=${v.label}`).toBe(
        v.label === 'CITA',
      );
      expect(v.why.length, 'un veredicto sin motivo legible no es auditable').toBeGreaterThan(20);
      vistas.add(v.label);
    }
    expect(
      [...vistas].sort(),
      'Alguna de las cuatro clases quedó INALCANZABLE con estos fixtures. Una clase que\n' +
        'ningún input produce es código muerto que se lee como cobertura.\n',
    ).toEqual(['CITA', 'DATO', 'INDECIDIBLE', 'RUIDO']);
  });

  it('G-C14: las DOS direcciones — el puerto sigue siendo ruido y la cita real resuelve su destino', () => {
    // Calcado de `G-C11`: un control de una sola dirección lo pasa una función
    // constante. Acá el caso malo tiene que morir Y el caso bueno tiene que
    // seguir pasando.
    //
    // Input que lo pone en rojo: (a) aflojar D1 —sacarle el chequeo del carácter
    // anterior— y el puerto pasa a CITA; (b) endurecer D3 —exigir que el
    // contexto traiga `:N` y borrar D3b— y la cita cae a INDECIDIBLE.
    const puerto = clasificar("const url = 'http://localhost:3001/x';");
    expect(puerto.label, `se esperaba RUIDO para el puerto y salió ${puerto.label}`).toBe('RUIDO');
    expect(puerto.rule).toBe('D1');

    const conNumero = clasificar('// ver `src/services/agent.ts:12`, y el guard de `:20`');
    expect(conNumero.label, `se esperaba CITA y salió ${conNumero.label}: ${conNumero.why}`).toBe(
      'CITA',
    );
    expect(conNumero.target).toBe('src/services/agent.ts');
    expect(conNumero.rule).toBe('D3a');

    // D3b: el contexto nombra el archivo SIN número de línea. Es la mitad que
    // se pierde si alguien «endurece» la regla exigiendo un `:N` en el contexto.
    const sinNumero = clasificar('// `src/adapters/chain-resolver.ts` resuelve la cadena en `:20`');
    expect(sinNumero.label, `se esperaba CITA por D3b: ${sinNumero.why}`).toBe('CITA');
    expect(sinNumero.target).toBe('src/adapters/chain-resolver.ts');
    expect(sinNumero.rule).toBe('D3b');

    // Y el backtick NO decide: el mismo puerto backtickeado sigue sin ser cita,
    // y la misma cita sin backticks sigue siéndolo.
    expect(clasificar('// el puerto por defecto es `:443` del esquema').label).not.toBe('CITA');
    expect(clasificar('// ver src/services/agent.ts:12 y el guard de :20').target).toBe(
      'src/services/agent.ts',
    );
  });

  it('G-C15: con HOMÓNIMOS el veredicto es INDECIDIBLE, nunca `candidates[0]`', () => {
    // 🔴 EL DEFECTO QUE ESTE CONTROL EXISTE PARA IMPEDIR está a la vista en
    // `citeTargetIfTracked`: `if (!raw.includes('/')) return candidates[0] ?? null;`
    // Con un basename homónimo elige el primero EN SILENCIO. Ese comportamiento
    // es aceptable ahí —verifica un `target` que un humano ya decidió— e
    // inaceptable acá, donde no hay nadie que lo haya decidido.
    //
    // Input que lo pone en rojo, y es un SITIO QUE EXISTE: dentro de `add()`,
    // en `scanContext` (`test/cited-lines-guard.scanner.ts`), sustituir la
    // llamada a `mentionCandidates` por `citeTargetIfTracked`. Ése es el ÚNICO
    // punto de resolución de la cascada.
    // ⚠️ La versión anterior de este comentario decía «sustituir
    // `resolveContextTarget` por `citeTargetIfTracked` en D3b», y eso NO ES UN
    // SITIO DEL CÓDIGO: `classifyBareCite` llama a `scanContext` directo y
    // nunca a `resolveContextTarget`. Un input rojo que nombra una sustitución
    // inexistente no se puede correr, o sea que no es falsable.
    // Corrido el mutante real, `G-C15` muere con su motivo propio:
    //   AssertionError: se esperaba INDECIDIBLE por AMBIGUOUS y se obtuvo CITA
    //   con target `src/uno/homonimo.ts`: D3b: el párrafo nombra un solo
    //   archivo trackeado, sin número de línea: `src/uno/homonimo.ts`.
    // (El mismo mutante también mata `G-C17`, `G-C17b` y `G-C18`, lo cual es
    // esperable —toca la resolución entera— y por eso el mensaje de arriba, que
    // nombra el homónimo del fixture, es lo que prueba que el rojo es de ACÁ.)
    const candidatos = toyByBase.get('homonimo.ts') ?? [];
    // ⛔ El assert es `> 1`, NUNCA un dígito: clavar el número de homónimos es un
    // candado que se pudre solo el día que alguien agrega otro archivo con ese
    // nombre — y en este repo eso pasa cada vez que se abre una HU.
    expect(
      candidatos.length,
      'El fixture dejó de tener homónimos, así que este control no prueba nada.\n',
    ).toBeGreaterThan(1);

    const v = clasificar('// como explica `homonimo.ts`, el criterio está en `:20`');
    expect(
      v.label,
      `se esperaba INDECIDIBLE por AMBIGUOUS y se obtuvo ${v.label}` +
        `${v.target === undefined ? '' : ` con target \`${v.target}\``}: ${v.why}`,
    ).toBe('INDECIDIBLE');
    expect(v.target).toBeUndefined();
    expect(v.rule).toBe('D7');

    // La OTRA mitad, y es la que hace que la regla sea usable: si el párrafo
    // trae además un contexto NO ambiguo, gana el no ambiguo. Medido: la
    // versión gruesa —cualquier nombre ambiguo ⇒ indecidible— baja el recall a
    // la mitad, porque casi todo párrafo largo menciona de paso algún `index.ts`.
    const mixto = clasificar(
      '// como explica `homonimo.ts`, el guard de `src/adapters/chain-resolver.ts` está en `:20`',
    );
    expect(mixto.label, `el contexto no ambiguo tenía que ganar: ${mixto.why}`).toBe('CITA');
    expect(mixto.target).toBe('src/adapters/chain-resolver.ts');

    // Y el resolvedor NUNCA devuelve `string | null` con homónimos: el tipo es
    // lo que hace imposible confundir «no hay contexto» con «hay demasiado».
    expect(
      resolveContextTarget('ver `homonimo.ts`', 'src/lib/fixture.ts', toyTracked, toyByBase, 'bare'),
    ).toBe('AMBIGUOUS');
    expect(
      resolveContextTarget('ver `nada.xyz`', 'src/lib/fixture.ts', toyTracked, toyByBase, 'bare'),
    ).toBeNull();
  });

  it('G-C16: los OCHO auto-referentes están DECLARADOS y son disjuntos del Corte A, y este control no se lee a sí mismo', () => {
    // 🔴 SON OCHO, NO SIETE. Los 7 de `DT-11` son los dos guardianes cuyos `:N`
    // sueltos son el REGISTRO de citas ajenas. El octavo es
    // `test/cited-lines-guard.sample.ts`, que contiene el `target` que el
    // clasificador tiene que producir: si entrara al universo, el clasificador
    // leería la respuesta.
    //
    // Input que lo pone en rojo: meter `test/cited-lines-guard.citations.ts` al
    // universo. El token se resuelve leyendo su propio campo `target:`.
    //
    // ⚠️ QUÉ ASSERTA ESTE CONTROL, DICHO SIN AFIRMAR DE MÁS. Los tres `expect`
    // de abajo verifican PERTENENCIA A UNA LISTA (`SELF_REFERENTIAL`), no que
    // el clasificador no mire esos archivos: quien arma el universo es el
    // llamador, y este `it` no lo ejecuta. Decir «están fuera del universo» —
    // como decía el título de este control— es afirmar más de lo que se mide.
    // Lo que sí se agrega debajo es la única consecuencia estructural que se
    // puede verificar acá: la DISJUNCIÓN con el Corte A.
    expect(SELF_REFERENTIAL.length).toBe(8);
    expect(new Set(SELF_REFERENTIAL).size).toBe(SELF_REFERENTIAL.length);
    for (const f of SELF_REFERENTIAL) {
      expect(TRACKED_SET.has(f), `archivo auto-referente que no existe: ${f}`).toBe(true);
    }

    // 🔴 `CORTE_A_PATHS ∩ SELF_REFERENTIAL = ∅`, y hasta hoy no la verificaba
    // NADIE. La ataja de rebote `G-C4` —un archivo auto-referente dentro del
    // corte llenaría el barrido de citas no declaradas—, pero de rebote y con
    // otro mensaje. Un archivo en las dos listas es una contradicción del
    // contrato: el corte dice «esto se vigila», la otra lista dice «esto
    // contiene la respuesta».
    // Input que lo pone en rojo: agregar cualquiera de los 8 a `CORTE_A_PATHS`.
    const enLasDos = CORTE_A_PATHS.filter((p) => SELF_REFERENTIAL.includes(p));
    expect(
      enLasDos,
      'Un archivo declarado a la vez en `CORTE_A_PATHS` y en `SELF_REFERENTIAL`.\n' +
        'Las dos declaraciones se contradicen: el corte lo vigila y la otra lista dice\n' +
        'que contiene el `target` que el clasificador tendría que producir.\n',
    ).toEqual([]);
    for (const f of [
      'test/cited-lines-guard.citations.ts',
      'test/cited-lines-guard.exceptions.ts',
      'test/cited-lines-guard.sample.ts',
    ]) {
      expect(
        SELF_REFERENTIAL.includes(f),
        `archivo auto-referente DENTRO del universo del clasificador: ${f}\n` +
          'Contiene el `target` que el clasificador tiene que producir; leerlo como\n' +
          'contexto es un control comparándose contra su propia salida.\n',
      ).toBe(true);
    }

    // Y la demostración de POR QUÉ, con un fixture en memoria que imita la forma
    // de una entrada de estos registros: el destino está escrito DOS LÍNEAS
    // debajo del token, dentro del mismo literal de objeto, o sea dentro del
    // mismo párrafo. Sin la exclusión, el clasificador «acierta» leyendo la
    // respuesta que el archivo ya trae escrita.
    //
    // ⚠️ El token del fixture va en la PROSA de un `reason:`, no en el campo
    // `cite:`. Medido: un `cite: ':20'` lo caza D2 —el carácter anterior es una
    // comilla— y nunca llega a mirar el contexto, así que un fixture con esa
    // forma NO reproduce el defecto y este control quedaría decorativo. Lo que
    // sí lo reproduce es el `` `:20` `` que estos archivos escriben backtickeado
    // adentro de sus motivos, que es como está escrita la mitad de este repo.
    const entradaFalsa = [
      '  {',
      "    file: 'test/no-trackeado.ts',",
      "    verdict: 'OTRO',",
      "    realTarget: 'src/services/agent.ts',",
      "    reason: 'lo que se cita en `:20` vive en el otro archivo',",
      '  },',
    ].join('\n');
    const leyendoLaRespuesta = clasificar(entradaFalsa, 'test/cited-lines-guard.citations.ts');
    expect(
      leyendoLaRespuesta.target,
      'El fixture dejó de reproducir el defecto, así que la exclusión de los 8 ya no\n' +
        'está justificada por nada medido y este control pasó a ser decorativo.\n',
    ).toBe('src/services/agent.ts');
  });

  it('G-C17: el ORÁCULO preexistente — recall sobre el piso publicado y CERO destinos mal resueltos', () => {
    // 🔴 POR QUÉ ESTE ORÁCULO Y NO OTRO: las entradas P3/P4 de `CITED_LINES` se
    // etiquetaron a mano entre el 2026-08-19 y el 2026-08-27, en OTRAS HUs,
    // antes de que existiera ningún clasificador. No se pueden haber escrito
    // mirando su salida. Medir la cascada contra el archivo del que salieron sus
    // reglas dio 100 % en el F1 de esta HU, y contra este oráculo dio 21 %.
    const bare = CITED_LINES.filter((c) => !citeNamesFile(c.cite));
    expect(bare.length, 'el oráculo se quedó sin entradas P3/P4').toBeGreaterThanOrEqual(19);

    let aciertos = 0;
    const malResueltos: string[] = [];
    for (const c of bare) {
      const src = readTracked(c.from);
      const hit = scanSource(src, c.from).find(
        (h) => h.cite === c.cite && (h.form === 'P3' || h.form === 'P4'),
      );
      if (hit === undefined) continue;
      const v = classifyBareCite(hit, src, TRACKED_SET, BY_BASENAME);
      if (v.label !== 'CITA') continue;
      if (v.target === c.target) aciertos += 1;
      else malResueltos.push(`${c.from} :: ${c.cite} → declarado ${c.target}, resuelto ${v.target}`);
    }

    // 🔴 CERO destinos mal resueltos es el invariante DURO. Un `INDECIDIBLE` de
    // más pide que alguien mire; un destino inventado pasa los controles.
    expect(
      malResueltos,
      'El clasificador afirmó un destino DISTINTO del que un humano declaró a mano.\n' +
        'Eso no es menos recall: es una afirmación falsa con cara de medición.\n',
    ).toEqual([]);

    // ⚠️ PISO, no igualdad. Un test que exigiera «exactamente N» se pone rojo el
    // día que alguien escriba una cita nueva, y ese rojo no señala nada falso:
    // es la fricción que termina con alguien borrando el guardián.
    //
    // 🔴 EL PISO ES 2 Y LA MEDICIÓN ES 6, Y ESA DISTANCIA ESTÁ MEDIDA, no
    // elegida a ojo. Hasta el fix-pack 1 el piso era 6 —EXACTAMENTE el valor
    // medido—, con este mismo comentario al lado prometiendo margen. Margen
    // cero: una sola cita que dejara de resolver ponía el gate rojo sin que
    // nada estuviera mal. Es el candado que se pudre solo, con la etiqueta de
    // que no se pudre.
    //
    // Cómo se eligió el 2, y por qué NO es 4 —que fue el primer intento—:
    //   · los 6 aciertos salen de **4 párrafos**, no de 6: `types/index.ts` 1 ·
    //     `operator-address.ts` **2** · `payment-guards-…` **2** · `CLAUDE.md` 1.
    //   · el clasificador decide POR PÁRRAFO, así que UNA edición de prosa
    //     legítima cuesta hasta **2**, no 1. Medido con un mutante: agregando
    //     `src/services/budget.ts` al párrafo de `operator-address.ts` —una
    //     mención de paso, de las que cualquier HU escribe— el número cae de
    //     **6 a 4** de una sola vez. Con piso 4 el margen volvía a ser cero.
    //   · dos ediciones así cuestan 4 ⇒ el piso tiene que aguantar 6 − 4 = 2.
    // Y sigue siendo un control real: el modo de falla que importa —que el
    // clasificador deje de resolver— lleva el número a 0 ó 1.
    // ⛔ El piso NO se sube para que un número publicado dé. Y el invariante
    // DURO de este `it` no es éste: es el `toEqual([])` de arriba.
    expect(
      aciertos,
      `El recall del clasificador sobre el oráculo cayó a ${aciertos}/${bare.length}, por\n` +
        'debajo del piso 2. La medición publicada en `doc/sdd/232-…/censo.md` §7.3 es 6/19,\n' +
        'repartida en 4 párrafos; el piso aguanta perder los dos más grandes.\n' +
        'Si el clasificador cambió a propósito, se re-mide y se re-publica el censo; si\n' +
        'no, algo se rompió.\n',
    ).toBeGreaterThanOrEqual(2);

    // Y el otro lado: las 4 ocurrencias que un humano declaró RUIDO a mano en
    // `SCANNER_FALSE_POSITIVES` no pueden salir CITA.
    for (const fp of SCANNER_FALSE_POSITIVES) {
      const src = readTracked(fp.from);
      for (const h of scanSource(src, fp.from)) {
        if (h.cite !== fp.cite || (h.form !== 'P3' && h.form !== 'P4')) continue;
        const v = classifyBareCite(h, src, TRACKED_SET, BY_BASENAME);
        expect(
          v.label,
          `${fp.from}:${h.line} ${fp.cite} está declarado RUIDO a mano y salió ${v.label}`,
        ).not.toBe('CITA');
      }
    }
  });

  it('G-C17d: el SORTEO tiene testigo — el marco se re-deriva y los 120 sitios son los que salieron', () => {
    // 🔴 EL AGUJERO QUE ESTE CONTROL CIERRA, y lo falsificó el AR de esta HU:
    // `sampleFrame`, `drawReservedSample`, `xorshift32`, `seedFrom`,
    // `SAMPLE_SEED` y `STRATUM_N` estaban EXPORTADOS, DOCUMENTADOS Y SIN UN
    // SOLO LLAMADOR. O sea que el mecanismo anti-cherry-pick de AC-2 —lo que
    // garantiza que «nadie elige qué se etiqueta»— era código muerto, y toda la
    // propiedad descansaba en el orden de los commits, que es prosa auditable a
    // mano y no un guardián.
    //
    // La falsificación, ejecutada por el AR en dos ediciones y un commit:
    // cambiar la etiqueta de un sitio de `CITA` a `RUIDO` y ajustar el tuple
    // publicado de `fn:44` a `fn:43`. Resultado: 20 tests VERDES. Un falso
    // negativo desapareció del registro y ningún control se enteró.
    //
    // Lo que este `it` agrega es lo único que esa maniobra no puede sobrevivir:
    // los 120 `siteKey` de `RESERVED_SAMPLE` tienen que ser EXACTAMENTE los que
    // el sorteo produce sobre el marco re-derivado del commit base. Cambiar una
    // ETIQUETA sigue pasando por acá —este control mira los SITIOS, no las
    // etiquetas, y eso va dicho para no afirmar de más—, pero SUSTITUIR un
    // sitio por otro, que es como se saca de la muestra un caso incómodo, se
    // pone rojo con los dos `siteKey` al lado.
    //
    // Input que lo pone en rojo: reemplazar un sitio de `RESERVED_SAMPLE` por
    // otro del marco. Verificado con el mutante M1 del fix-pack 1.
    const paths = execFileSync(
      'git',
      ['ls-tree', '-r', '-z', '--name-only', SAMPLE_BASE_COMMIT, '--', 'src', 'test', 'scripts'],
      { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
      .split('\0')
      .filter(Boolean);

    // Un solo proceso para los 611 blobs: `git show` por archivo tarda ~30× más
    // y este control tiene que costar poco para que nadie lo borre por lento.
    const batch = execFileSync('git', ['cat-file', '--batch'], {
      cwd: REPO_ROOT,
      input: `${paths.map((p) => `${SAMPLE_BASE_COMMIT}:${p}`).join('\n')}\n`,
      maxBuffer: 512 * 1024 * 1024,
    });
    const sources = new Map<string, string>();
    let off = 0;
    for (const p of paths) {
      // Cabecera `<oid> SP <type> SP <size> LF`, después el contenido y un LF.
      const nl = batch.indexOf(0x0a, off);
      const size = Number(batch.toString('utf8', off, nl).split(' ')[2]);
      sources.set(p, batch.toString('utf8', nl + 1, nl + 1 + size));
      off = nl + 1 + size + 1;
    }
    expect(sources.size, 'el perímetro del marco cambió de tamaño').toBe(paths.length);

    // El oráculo preexistente sale del marco: medirse dos veces contra las
    // mismas ocurrencias no agrega información. Es la resta del `1152 → 1130`.
    const oracleKeys = new Set<string>();
    for (const c of CITED_LINES) {
      if (!citeNamesFile(c.cite)) oracleKeys.add(oracleKey(c.from, c.cite));
    }
    for (const f of SCANNER_FALSE_POSITIVES) oracleKeys.add(oracleKey(f.from, f.cite));

    const frame = sampleFrame(sources, oracleKeys);
    // ⛔ PISOS, no igualdades: el marco es una foto del commit base y su tamaño
    // exacto se publica en el censo (§7.1: 1130 = P3 130 + P4 1000). Lo que sí
    // es estructural es que cada estrato tenga con qué llenar los 60.
    expect(frame.filter((s) => s.form === 'P3').length).toBeGreaterThanOrEqual(STRATUM_N);
    expect(frame.filter((s) => s.form === 'P4').length).toBeGreaterThanOrEqual(STRATUM_N);

    const sorteados = drawReservedSample(frame, SAMPLE_SEED).map(siteKey);
    const declarados = RESERVED_SAMPLE.map(siteKey);
    const sobran = declarados.filter((k) => !sorteados.includes(k));
    const faltan = sorteados.filter((k) => !declarados.includes(k));
    expect(
      { sobran, faltan },
      'Los sitios de `RESERVED_SAMPLE` dejaron de ser los que el sorteo produce sobre el\n' +
        'marco derivado del commit base. Alguien eligió a mano qué se etiqueta, que es\n' +
        'exactamente lo que AC-2 prohíbe — o el marco cambió, y entonces se re-sortea y se\n' +
        're-etiqueta, no se ajusta la lista.\n',
    ).toEqual({ sobran: [], faltan: [] });
  });

  it('G-C17b: la MUESTRA RESERVADA — los números se re-derivan, no se leen del censo', () => {
    // 🔴 LA CEGUERA NO SE PROMETE: SE GARANTIZA POR ORDEN DE COMMITS. En el
    // commit que trae estas 120 etiquetas, `classifyBareCite` no existe en el
    // árbol. Se comprueba con
    //   git show <ese commit>:test/cited-lines-guard.scanner.ts | grep -c classifyBareCite
    //
    // 🔴 Y LOS FUENTES SE LEEN DEL COMMIT BASE, no del árbol de hoy (CD-21). Sin
    // eso, este control sería un candado que se pudre solo: cualquiera que
    // inserte una línea en alguno de los ~50 archivos de la muestra correría las
    // 120 posiciones y lo pondría rojo sin que nada estuviera mal.
    //
    // Input que lo pone en rojo: editar una etiqueta de `RESERVED_SAMPLE` sin
    // tocar el censo — el número derivado deja de coincidir con el publicado.
    expect(RESERVED_SAMPLE.length).toBe(120);
    const src = new Map<string, string>();
    for (const s of RESERVED_SAMPLE) {
      if (src.has(s.file)) continue;
      src.set(
        s.file,
        execFileSync('git', ['show', `${SAMPLE_BASE_COMMIT}:${s.file}`], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        }),
      );
    }

    const stats = { P3: { tp: 0, fp: 0, fn: 0 }, P4: { tp: 0, fp: 0, fn: 0 } };
    const ausentes: string[] = [];
    for (const s of RESERVED_SAMPLE) {
      const texto = src.get(s.file) as string;
      let n = 0;
      let hit: FoundCite | undefined;
      for (const h of scanSource(texto, s.file)) {
        if (h.line !== s.line || h.cite !== s.cite) continue;
        if (h.form !== 'P3' && h.form !== 'P4') continue;
        if (n === s.nth) {
          hit = h;
          break;
        }
        n += 1;
      }
      if (hit === undefined) {
        ausentes.push(siteKey(s));
        continue;
      }
      const v = classifyBareCite(hit, texto, TRACKED_SET, BY_BASENAME);
      const st = stats[s.form];
      const pred = v.label === 'CITA';
      const real = s.label === 'CITA';
      if (pred && real && v.target === s.target) st.tp += 1;
      else if (pred && real) {
        st.fp += 1;
        st.fn += 1;
      } else if (pred) st.fp += 1;
      else if (real) st.fn += 1;
    }
    expect(
      ausentes,
      'Sitios de la muestra que ya no existen AL COMMIT BASE. Como los fuentes se leen\n' +
        'de ese commit, esto no puede pasar por una edición de hoy: significa que la\n' +
        'muestra y el commit base dejaron de corresponderse.\n',
    ).toEqual([]);

    // Los números PUBLICADOS en `doc/sdd/232-…/censo.md`, re-derivados acá. Si
    // alguien cambia una etiqueta y no re-publica, esto lo dice con los dos
    // números al lado.
    const publicado = { P3: { tp: 13, fp: 1, fn: 44 }, P4: { tp: 1, fp: 0, fn: 1 } };
    for (const form of ['P3', 'P4'] as const) {
      expect(
        stats[form],
        `El estrato ${form} declara ${JSON.stringify(publicado[form])} en el censo y la\n` +
          `derivación de esta corrida da ${JSON.stringify(stats[form])}.\n` +
          'Uno de los dos está viejo: se re-mide y se re-publica, no se ajusta el número.\n',
      ).toEqual(publicado[form]);
    }
    // ⛔ Y el invariante que NO es una foto: cero destinos inventados en P4, que
    // es el estrato masivo. Éste no se re-publica: se arregla.
    expect(stats.P4.fp).toBe(0);
  });

  it('G-C17c: el censo de D5 tiene una entrada por sitio, y su veredicto es el que degradó la regla', () => {
    // 🔴 D5 ESTÁ DEGRADADA A `INDECIDIBLE`, y este control es lo que impide que
    // alguien la vuelva a encender sin re-hacer el censo. El umbral se escribió
    // ANTES de medir (CD-19): más de 21 % de destinos equivocados y D5 se cae.
    //
    // Input que lo pone en rojo: volver a emitir `CITA` desde D5 — la lista de
    // sitios sigue igual pero el clasificador deja de decir `INDECIDIBLE`.
    const sitios = new Map<string, string>();
    for (const e of D5_CENSUS) {
      const k = `${e.file} :: ${e.line} :: ${e.cite}`;
      expect(sitios.has(k), `entrada duplicada en el censo de D5: ${k}`).toBe(false);
      sitios.set(k, e.verdict);
      expect(e.reason.length, `motivo demasiado corto para ${k}`).toBeGreaterThan(40);
      expect(
        e.realTarget !== undefined,
        `\`realTarget\` incoherente con verdict=${e.verdict} en ${k}`,
      ).toBe(e.verdict === 'OTRO');
    }

    const equivocados = D5_CENSUS.filter((e) => e.verdict !== 'AUTO').length;
    const tasa = equivocados / D5_CENSUS.length;
    expect(
      tasa,
      `El censo de D5 declara ${equivocados} destinos equivocados sobre ${D5_CENSUS.length}\n` +
        `(${(tasa * 100).toFixed(0)} %). El umbral escrito ANTES de medir era 21 %.\n` +
        'Si esto bajó del umbral, D5 se puede volver a encender — pero re-midiendo el\n' +
        'censo entero, no editando este número.\n',
    ).toBeGreaterThan(0.21);

    // Y la consecuencia mecánica: mientras el censo esté por encima del umbral,
    // NINGÚN sitio de D5 puede salir `CITA`.
    //
    // 🔴 «NINGUNO» SON LOS 36, NO LOS 6 PRIMEROS. Hasta el fix-pack 1 este
    // bucle corría sobre `D5_CENSUS.slice(0, 6)` con la palabra «NINGÚN»
    // escrita al lado: la afirmación cubría 6 veces menos de lo que decía, y
    // los 30 sitios de la cola no los miraba nadie. Los fuentes se leen una
    // sola vez por archivo, así que los 36 cuestan lo mismo que los 6.
    const d5src = new Map<string, string>();
    for (const e of D5_CENSUS) {
      let texto = d5src.get(e.file);
      if (texto === undefined) {
        texto = execFileSync('git', ['show', `${SAMPLE_BASE_COMMIT}:${e.file}`], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        });
        d5src.set(e.file, texto);
      }
      const hit = scanSource(texto, e.file).find((h) => h.line === e.line && h.cite === e.cite);
      expect(hit, `sitio del censo de D5 ausente al commit base: ${e.file}:${e.line}`).toBeDefined();
      const v = classifyBareCite(hit as FoundCite, texto, TRACKED_SET, BY_BASENAME);
      expect(v.rule, `${e.file}:${e.line} dejó de llegar a D5`).toBe('D5');
      expect(
        v.label,
        `${e.file}:${e.line} volvió a salir CITA desde D5, con el censo todavía en rojo`,
      ).toBe('INDECIDIBLE');
    }
  });

  it('G-C18: el cruce mecánico de los `:N` SUELTOS contra el `target` declarado (E-BARE_TARGET_MISMATCH)', () => {
    // 🔴 EL AGUJERO QUE ESTE CONTROL CIERRA, y estaba a la vista:
    //
    //   citeMatchesTarget(fromFile, token, target)  →  if (raw === null) return true;
    //
    // `citePathOf` devuelve `null` para TODO token P3/P4 —no nombran archivo—,
    // así que ese `return true` contesta que SÍ sin mirar nada. Medido antes de
    // escribir este control, sobre las 19 entradas P3/P4 del registro:
    //
    //   citeMatchesTarget('src/lib/operator-address.ts', '`:95`', 'CLAUDE.md')            → true
    //   citeMatchesTarget('src/lib/operator-address.ts', '`:95`', 'src/no/existe.ts')     → true
    //   las 19, contra un target inventado                                               → true
    //
    // O sea: `E-CITE_TARGET_MISMATCH` NO PODÍA DISPARARSE JAMÁS para ninguna de
    // ellas, y sus `target` dependían enteramente de la prosa del `targetReason`.
    //
    // ⚠️ ESO NO QUIERE DECIR QUE ESAS ENTRADAS NO TUVIERAN NINGÚN TESTIGO, y
    // decirlo al revés sería afirmar de más: `G-C5` ya cruza `mustContain`
    // contra `target:line` (`E-TARGET_MISSING`, `E-LINE_OUT_OF_RANGE`,
    // `E-WRONG_FILE`, `E-ANCHOR_GONE`, `E-LINE_MOVED`) y `G-C6` cruza
    // `symbolPath`. Lo que faltaba es lo que ESTE control agrega: cruzar el
    // token contra el CONTEXTO en que está escrito, o sea preguntar si el
    // párrafo sostiene el destino que el humano declaró.
    //
    // COSTO: CERO declaraciones nuevas. No se amplía `CORTE_A_PATHS` ni
    // `CITED_LINES`: el control se monta sobre lo que ya está declarado.
    //
    // Input que lo pone en rojo: cambiar el PÁRRAFO de un citador para que
    // nombre un archivo distinto del `target` declarado. Ver el mutante en las
    // notas de la HU — y ojo con el mutante OBVIO (cambiarle el `target` a la
    // entrada), que se pone rojo hoy por `G-C5`/`E-ANCHOR_GONE` y por lo tanto
    // NO prueba nada sobre este control.
    const bare = CITED_LINES.filter((c) => !citeNamesFile(c.cite));
    expect(bare.length, 'el registro se quedó sin entradas P3/P4').toBeGreaterThanOrEqual(19);

    // El control POSITIVO del propio control: la vacuidad que motiva todo esto
    // sigue siendo real, así que este `it` no está midiendo algo ya cubierto.
    for (const c of bare.slice(0, 3)) {
      expect(
        citeMatchesTarget(c.from, c.cite, 'src/no/existe/en/ningun/lado.ts'),
        `\`citeMatchesTarget\` dejó de ser vacuo para ${c.cite}. Si alguien la arregló, este\n` +
          'control puede ser redundante — pero hay que MEDIRLO antes de borrarlo.\n',
      ).toBe(true);
    }

    const hallazgos: string[] = [];
    let conTestigo = 0;
    for (const c of bare) {
      const src = readTracked(c.from);
      const hit = scanSource(src, c.from).find(
        (h) => h.cite === c.cite && (h.form === 'P3' || h.form === 'P4'),
      );
      if (hit === undefined) continue;
      const v = classifyBareCite(hit, src, TRACKED_SET, BY_BASENAME);
      // `INDECIDIBLE` NO es un hallazgo: significa que el contexto no alcanza y
      // que sigue rigiendo el `targetReason` escrito a mano, como hasta hoy.
      if (v.label !== 'CITA') continue;
      conTestigo += 1;
      if (v.target !== c.target) {
        hallazgos.push(
          `E-BARE_TARGET_MISMATCH  ${c.from}:${hit.line} ${c.cite}\n` +
            `    target declarado a mano : ${c.target}\n` +
            `    destino del contexto    : ${v.target}\n` +
            `    ${v.why}`,
        );
      }
    }

    expect(
      hallazgos,
      'El PÁRRAFO en que está escrita una cita suelta apunta a un archivo distinto del que\n' +
        'la entrada declara. Una de las dos cosas está mal, y ninguna de las dos la ve\n' +
        '`citeMatchesTarget`, que para estos tokens devuelve `true` sin mirar.\n\n' +
        `${hallazgos.join('\n')}\n`,
    ).toEqual([]);

    // ⚠️ PISO, no igualdad, y por la misma razón que en `G-C17`: cuántas de las
    // 19 llegan a tener testigo mecánico depende de cómo esté escrita la prosa
    // de cada citador, y eso cambia con cada HU que toque uno de esos archivos.
    // Clavar el número sería un candado que se pudre solo.
    //
    // 🔴 PISO 2, MEDICIÓN 6 — el mismo cambio, el mismo motivo y la misma
    // medición que en `G-C17`: el piso anterior (6) estaba clavado sobre el
    // valor medido, o sea con margen CERO, prometiendo margen en el comentario
    // de al lado. Los 6 salen de 4 párrafos y una sola edición de prosa cuesta
    // hasta 2 (medido: 6 → 4 con una mención de paso). Ver `G-C17`.
    expect(
      conTestigo,
      `Sólo ${conTestigo} de las ${bare.length} entradas P3/P4 tienen testigo mecánico, por debajo\n` +
        'del piso 2. La medición publicada en `doc/sdd/232-wkh-371-…/censo.md` §10.2 es 6\n' +
        'de 19, repartida en 4 párrafos.\n' +
        'El resto sigue dependiendo del `targetReason` escrito a mano, que es prosa.\n',
    ).toBeGreaterThanOrEqual(2);
  });

  it('G-C19: los archivos de este guardián PASAN por un typecheck — el gate del repo no los mira', () => {
    // 🔴 EL AGUJERO, MEDIDO Y CONFIRMADO POR DOS REVISORES: `tsconfig.json`
    // declara `"include": ["src/**/*"]` y `npm run lint` corre `biome check
    // src/`. Los dos sub-gates de tipos y de estilo del repo son
    // ESTRUCTURALMENTE CIEGOS a `test/`: de las líneas de este guardián,
    // `tsc` typechequea CERO. El único control que corría sobre ellas era
    // `vitest`, que transpila sin typechequear — o sea que `tsc 0 · lint 520`
    // es un resultado verdadero que NO habla de este archivo.
    //
    // Control positivo, corrido antes de escribir este `it`: inyectando
    // `const x: BareLabel = 'NO_EXISTE';` en el escáner,
    //   tsc -p tsconfig.json      --noEmit  → exit 0   (ciego)
    //   tsc -p tsconfig.guards.json --noEmit → exit 2   error TS2322
    //
    // ⚠️ SE CORRE EL BINARIO DIRECTO, NO `npx tsc`. Bajo el hook de este
    // entorno `npx tsc` imprime «TypeScript compilation completed» y TAPA el
    // exit code, hasta para `--version`. Un gate leído por su salida en vez de
    // por su código sale verde siempre.
    //
    // Input que lo pone en rojo: cualquier error de tipos en uno de los 5
    // archivos del `include` de `tsconfig.guards.json`.
    const tsc = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    expect(existsSync(tsc), `no está el compilador en ${tsc}`).toBe(true);

    let salida = '';
    let code = 0;
    try {
      salida = execFileSync(process.execPath, [tsc, '-p', 'tsconfig.guards.json', '--noEmit'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      code = err.status ?? 1;
      salida = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    expect(
      { code, salida },
      'Los archivos de este guardián no typechequean bajo el `strict` del propio repo.\n' +
        '⚠️ Y esto NO lo dice `npm run lint` ni `tsc -p tsconfig.json`: ninguno de los dos\n' +
        'mira `test/`. Ver el docblock de `tsconfig.guards.json`.\n',
    ).toEqual({ code: 0, salida: '' });
  });
});
