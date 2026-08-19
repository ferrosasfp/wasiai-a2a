/**
 * Escáner de citas `archivo:línea` — FUNCIONES PURAS SOBRE TEXTO.
 *
 * Lo consume `test/cited-lines-guard.test.ts`. Vive separado y sin tocar el
 * disco por la misma razón que `test/ownership-filter-guard.scanner.ts`: si el
 * escáner sólo se pudiera invocar sobre el árbol real, sus propios tests serían
 * «lo que el escáner encuentra hoy», que es un instrumento comparándose contra
 * su propia salida — da verde con cualquier implementación, incluida la que no
 * encuentra nada. Siendo puras, G-C2 y G-C3 les pasan fixtures en memoria con
 * la respuesta conocida de antemano.
 *
 * Exemplar: `test/ownership-filter-guard.scanner.ts` (mismo patrón «parser puro
 * del texto + wrapper que lee el disco»).
 *
 * ── LO QUE ESTE ESCÁNER NO VE (medido, no arreglado) ──────────────────────
 *
 *  (a) LA PROSA SUELTA. «la línea 95», «el guard de más abajo», «el docblock de
 *      arriba» no tienen forma sintáctica, así que ningún patrón las devuelve.
 *      **Es la razón por la que el conteo de este escáner es un PISO y no un
 *      total, y no hay cota superior conocida** — medirla exigiría leer los 14
 *      archivos a mano. Las que alguien LEA y decida que no se pueden anclar van
 *      a `UNANCHORABLE_PROSE`; esa lista mide lo que se leyó, no lo que hay.
 *  (b) EL RUIDO DE LA FORMA P4, que se reporta A PROPÓSITO. Un `:N` suelto es
 *      indistinguible de un puerto (`:8443`, `:443`, `:80`), de un offset
 *      (`:0`), del valor de una propiedad (`{reputation:100}`, `minLength:1`) o
 *      de un timestamp ISO (`T00:00:00`). Descartarlos por rango sería inventar
 *      una heurística que mañana se come una cita real a la línea 80, así que el
 *      modo de falla apunta al lado RUIDOSO —una excusa escrita a mano en
 *      `SCANNER_FALSE_POSITIVES`— y no al silencioso. Población medida hoy en el
 *      Corte A: 4, en 2 archivos.
 *  (c) EL ÚNICO DESCARTE es `::N` (IPv6). La regla es sintáctica y estrecha —el
 *      carácter previo a los `:` no puede ser `:`— justamente para que no se
 *      convierta en una heurística.
 *  (d) EL VALOR SEMÁNTICO. El escáner encuentra el TOKEN; que la línea apuntada
 *      diga lo que la prosa afirma lo verifica el guardián con un `mustContain`
 *      escrito a mano, y que la prosa alrededor sea VERDADERA no lo verifica
 *      nadie. Número bien + conclusión falsa pasa en verde.
 *  (e) LAS CITAS PARTIDAS EN DOS LÍNEAS. Un `archivo.ts:` al final de una línea
 *      y el número al principio de la siguiente no matchea. Población hoy 0, y
 *      eso es una medición del árbol de hoy, no una propiedad del escáner.
 *  (f) LOS PARES `{file, line}` ESTRUCTURADOS, como los 41 de
 *      `test/ownership-filter-guard.exceptions.ts`. Se escriben en dos líneas
 *      separadas y nunca producen el token `archivo:N`, así que este escáner no
 *      los puede ver ni queriendo. No es un hueco: ya tienen testigo propio, y
 *      mejor — `G-08`/`G-09` los verifican en las dos direcciones.
 *  (g) UN ARCHIVO QUE NO ESTÁ EN LOS 14 PATHS DEL CORTE, o que no está en el
 *      índice de git. El universo es explícito; el silencio sobre el resto es
 *      real y está declarado en el docblock del guardián.
 */

import ts from 'typescript';

/** Las cuatro formas sintácticas en que este repo escribe una cita. */
export type CiteForm = 'P1' | 'P2' | 'P3' | 'P4';

/** Una cita `archivo:línea` encontrada en el texto de un archivo. */
export interface FoundCite {
  /** Ruta tal como se la pasaron a `scanSource`. */
  readonly file: string;
  /** Línea 1-based del citador donde aparece el token. DERIVADA, no se guarda. */
  readonly line: number;
  /** El token literal, tal como está escrito. P3 incluye sus backticks. */
  readonly cite: string;
  readonly form: CiteForm;
  /** El path escrito en el token. `undefined` para P3/P4. */
  readonly path?: string;
  /** Línea citada (la A de un rango `A-B`). */
  readonly num: number;
  /** Fin del rango, si el token era `A-B`. */
  readonly endNum?: number;
}

/**
 * Un path (con al menos un punto de extensión en el último segmento) seguido de
 * `:N` o `:A-B`. Cubre P1 y P2 de una vez: la diferencia entre las dos es si el
 * path contiene `/`, y eso se decide después de matchear.
 *
 * 🔴 El PUNTO dentro de la clase de caracteres del segmento (`[A-Za-z0-9_.@-]`)
 * es lo que hace que `./splash.tsx:245`, `../adapters/solana/chain.ts:84` y
 * `.nexus/project-context.md:6` entren. NO es cosmético: hay un caso medido en
 * otro repo donde un patrón perdió una cita justo por excluir el `./`.
 *
 * ⚠️ Acá había un prefijo `(?:\.{1,2}\/)?` con un comentario que decía que ERA
 * ÉL el que hacía entrar el `./`. **Medido con un mutante: era redundante.**
 * Sacándolo, los tres casos de arriba seguían matcheando —los cubre la clase del
 * segmento— y los cuatro controles quedaban VERDES. O sea que el comentario
 * afirmaba de más sobre su propio código, adentro de la HU que existe para cazar
 * exactamente eso. Se sacó el prefijo y se escribió acá lo que se midió. Lo que
 * SÍ mata a `G-C2` es sacarle el punto a la clase del segmento.
 *
 * 🔴 Y el `*` del último segmento —en vez de un `+`— es lo que hace que un
 * DOTFILE entre: `.gitignore:172` no tiene nombre ANTES del punto. Con un `+`
 * ahí, `.gitignore:172` no matchea como cita con archivo y su `:172` cae al
 * barrido de bare como si fuera un P4 suelto: se pierde el nombre del archivo,
 * o sea justo lo que permite cruzar el token contra el `target` declarado.
 * Medido en esta HU: esa suposición dejaba 8 citas del Corte A sin ver, y
 * **las 8 están mal** (`test/sdd-index-matches-folders.exceptions.ts` cita
 * `.gitignore:172/:173/:177-180/:178/:184`, y los cinco números están corridos
 * exactamente +13 líneas). Ver la nota de no-cobertura del guardián.
 */
const FILE_CITE_RE =
  /(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_@-]*(?:\.[A-Za-z0-9_-]+)+:(\d+)(?:-(\d+))?/g;

/** Un `:N` o `:A-B` suelto, sin path delante. Cubre P3 y P4. */
const BARE_CITE_RE = /:(\d+)(?:-(\d+))?/g;

/** Un token no puede empezar en medio de un identificador. */
const IDENT_CHAR = /[A-Za-z0-9_$@-]/;

/** Traduce índices de carácter a línea 1-based. */
function lineIndex(src: string): (index: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === '\n') starts.push(i + 1);
  }
  return (index: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * Todas las citas de `src`, en las CUATRO formas.
 *
 * ⚠️ NO enmascara comentarios: las citas VIVEN en los comentarios. Es lo
 * contrario de `ownership-filter-guard.scanner.ts`, y a propósito.
 *
 * El único falso positivo que se descarta acá es `::N` (IPv6 — medido:
 * `src/types/index.ts` tiene un `'::1'`). La regla es sintáctica y estrecha: el
 * carácter previo a los `:` no puede ser `:`. Los puertos (`:8443`, `:443`,
 * `:80`) y el `:0` NO se descartan: descartarlos por rango sería inventar una
 * heurística que mañana se come una cita real de la línea 80. Van a
 * `SCANNER_FALSE_POSITIVES` con motivo escrito, o sea al lado RUIDOSO.
 */
export function scanSource(src: string, file: string): FoundCite[] {
  const lineOf = lineIndex(src);
  const found: FoundCite[] = [];
  /** Rangos [inicio,fin) ya consumidos por una cita con path. */
  const consumed: Array<[number, number]> = [];

  FILE_CITE_RE.lastIndex = 0;
  for (let m = FILE_CITE_RE.exec(src); m !== null; m = FILE_CITE_RE.exec(src)) {
    const start = m.index;
    const prev = start > 0 ? (src[start - 1] as string) : '';
    if (IDENT_CHAR.test(prev)) continue;
    const token = m[0];
    const pathText = token.slice(0, token.lastIndexOf(':'));
    consumed.push([start, start + token.length]);
    found.push({
      file,
      line: lineOf(start),
      cite: token,
      form: pathText.includes('/') ? 'P1' : 'P2',
      path: pathText,
      num: Number(m[1]),
      ...(m[2] === undefined ? {} : { endNum: Number(m[2]) }),
    });
  }

  BARE_CITE_RE.lastIndex = 0;
  for (let m = BARE_CITE_RE.exec(src); m !== null; m = BARE_CITE_RE.exec(src)) {
    const start = m.index;
    if (consumed.some(([a, b]) => start >= a && start < b)) continue;
    const prev = start > 0 ? (src[start - 1] as string) : '';
    // El falso positivo medido: `::1`.
    if (prev === ':') continue;
    const end = start + m[0].length;
    const next = end < src.length ? (src[end] as string) : '';
    const backticked = prev === '`' && next === '`';
    found.push({
      file,
      line: lineOf(start),
      cite: backticked ? `\`${m[0]}\`` : m[0],
      form: backticked ? 'P3' : 'P4',
      num: Number(m[1]),
      ...(m[2] === undefined ? {} : { endNum: Number(m[2]) }),
    });
  }

  return found.sort((a, b) => a.line - b.line || a.cite.localeCompare(b.cite));
}

/** El trozo de path que el token escribe, sin el `:N`. `null` si no hay. */
export function citePathOf(token: string): string | null {
  const colon = token.lastIndexOf(':');
  const raw = colon === -1 ? token : token.slice(0, colon);
  return raw === '' || !raw.includes('.') ? null : raw;
}

/**
 * ¿El token NOMBRA un archivo (P1/P2), o es un `:N` suelto (P3/P4)?
 *
 * ⚠️ Vive acá y no duplicado en el guardián, y no es cosmético: la primera
 * versión del guardián tenía su propia regex para esta misma pregunta y volvió a
 * exigir un nombre ANTES del punto — o sea que **el punto ciego del dotfile se
 * reprodujo DENTRO del arreglo del punto ciego del dotfile**, en el mismo día.
 * Dos criterios que responden la misma pregunta coinciden el día que se
 * escriben y divergen en la próxima corrección de borde: es exactamente lo que
 * `test/payment-guards-live-in-one-place.test.ts` existe para prevenir.
 */
export function citeNamesFile(token: string): boolean {
  return citePathOf(token) !== null;
}

/**
 * El path que el token nombra, resuelto contra el citador cuando el token es
 * relativo (`./`, `../`). `null` para P3/P4 (no nombran archivo) y para los P1
 * cuyo path es un fragmento (`lib/payment-spec-reader.ts`), que no se puede
 * resolver sin decidir contra qué raíz — ésos los resuelve el HUMANO en el
 * campo `target` y el guardián sólo verifica CONSISTENCIA (DT-11).
 */
export function normalizeTarget(fromFile: string, token: string): string | null {
  const raw = citePathOf(token);
  if (raw === null) return null;
  if (!raw.startsWith('./') && !raw.startsWith('../')) return null;
  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of raw.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

/**
 * ¿El token es consistente con el `target` que la entrada declara a mano?
 *
 * - `./` y `../` → tienen UNA resolución, y tiene que ser exactamente `target`.
 * - path con `/` → `target` es ese path, o termina en él alineado por segmento
 *   (`lib/payment-spec-reader.ts` ↔ `src/lib/payment-spec-reader.ts`).
 * - path sin `/` (P2) → el basename de `target` es el token.
 * - P3/P4 → el token no nombra archivo: no hay nada que cruzar acá. Lo cubre
 *   `targetReason`, que es obligatorio cuando `target !== from`.
 */
export function citeMatchesTarget(fromFile: string, token: string, target: string): boolean {
  const raw = citePathOf(token);
  if (raw === null) return true;
  if (raw.startsWith('./') || raw.startsWith('../')) {
    return normalizeTarget(fromFile, token) === target;
  }
  if (raw.includes('/')) {
    return target === raw || target.endsWith(`/${raw}`);
  }
  const base = target.slice(target.lastIndexOf('/') + 1);
  return base === raw;
}

// ── El resolver de símbolos (Compiler API) ─────────────────────────────────

/**
 * Kinds de DECLARACIÓN que cuentan como contenedor nombrable.
 *
 * La whitelist no es una optimización: es lo que distingue esta implementación
 * de la variante «el nodo más interno», que se descartó MIDIENDO. Sin ella, el
 * camino de `reputation.ts:189` termina en `add`/`failedCallers` y el de una
 * cadena de Supabase en `from` — nombres de expresión que ningún humano
 * escribiría en un `symbolPath` a mano.
 */
const DECL_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.EnumMember,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.Constructor,
]);

/** Los tres nombres de vitest cuyo primer argumento nombra un bloque. */
const BLOCK_CALLS: ReadonlySet<string> = new Set(['it', 'test', 'describe']);

function propertyNameText(name: ts.Node | undefined): string | null {
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return null;
}

/** El nombre del bloque `it('…')` / `test('…')` / `describe('…')`, si lo es. */
function blockCallName(node: ts.Node): string | null {
  if (!ts.isCallExpression(node)) return null;
  let head: ts.Expression = node.expression;
  while (ts.isPropertyAccessExpression(head)) head = head.expression;
  if (!ts.isIdentifier(head) || !BLOCK_CALLS.has(head.text)) return null;
  const first = node.arguments[0];
  if (first === undefined) return null;
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return first.text;
  return null;
}

function containerName(node: ts.Node): string | null {
  const block = blockCallName(node);
  if (block !== null) return block;
  if (!DECL_KINDS.has(node.kind)) return null;
  if (node.kind === ts.SyntaxKind.Constructor) return 'constructor';
  const named = node as ts.Node & { name?: ts.Node };
  return propertyNameText(named.name);
}

/** Cache de parseo: los targets se consultan una vez por needle-hit. */
const SF_CACHE = new Map<string, { src: string; sf: ts.SourceFile }>();

function sourceFileFor(src: string, file: string): ts.SourceFile {
  const hit = SF_CACHE.get(file);
  if (hit !== undefined && hit.src === src) return hit.sf;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  SF_CACHE.set(file, { src, sf });
  return sf;
}

/** Los targets sin símbolos TS. El resolver devuelve `[]` y el guard lo exige. */
const SYMBOLLESS = /\.(md|json|sql|ya?ml|txt|sh|mjs|cjs)$/i;

/**
 * El camino de símbolos que contiene `line`, de afuera hacia adentro.
 *
 * La contención usa `node.pos` (el FULL start, o sea con la trivia de adelante)
 * y no `node.getStart()`: es lo que hace que una línea de un docblock mapee a la
 * declaración que ese docblock documenta, que es donde viven casi todas las
 * citas de este repo. Con `getStart()` el docblock queda huérfano y devuelve
 * `[]` — ése es el mutante de G-C3.
 *
 * `[]` es una respuesta legítima: docblock de cabecera (antes de cualquier
 * declaración nombrable) y targets sin símbolos.
 */
export function resolveSymbolPath(src: string, file: string, line: number): string[] {
  if (SYMBOLLESS.test(file)) return [];
  const sf = sourceFileFor(src, file);
  const total = sf.getLineStarts().length;
  if (line < 1 || line > total) return [];
  const pos = sf.getPositionOfLineAndCharacter(line - 1, 0);
  const path: string[] = [];
  let node: ts.Node = sf;
  for (;;) {
    let next: ts.Node | undefined;
    ts.forEachChild(node, (child) => {
      if (next !== undefined) return;
      if (child.pos <= pos && pos < child.end) next = child;
    });
    if (next === undefined) break;
    const name = containerName(next);
    if (name !== null) path.push(name);
    node = next;
  }
  return path;
}

/** `declared` es subsecuencia ORDENADA de `actual` (no sufijo, no igualdad). */
export function isOrderedSubsequence(
  declared: readonly string[],
  actual: readonly string[],
): boolean {
  let i = 0;
  for (const seg of actual) {
    if (i < declared.length && declared[i] === seg) i += 1;
  }
  return i === declared.length;
}

/**
 * Las líneas 1-based de `targetSrc` que cumplen las DOS condiciones:
 * la CONJUNCIÓN de `needles` cae en la línea, y `symbolPath` es subsecuencia
 * ordenada del camino que el resolver da para esa línea.
 *
 * La unicidad es de la conjunción, no de cada needle: medido sobre el exemplar
 * que ya está en `main` (`CITED_INDEX_LINES` sobre `doc/sdd/_INDEX.md`), sus
 * tres needles dan 2, 2 y 4 hits por separado y 1 sola juntas. Por needle, el
 * exemplar sería ROJO y la regla inusable.
 */
export function locate(
  targetSrc: string,
  targetFile: string,
  needles: readonly string[],
  symbolPath: readonly string[],
): number[] {
  const lines = targetSrc.split('\n');
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i] as string;
    if (!needles.every((n) => text.includes(n))) continue;
    if (symbolPath.length > 0) {
      const actual = resolveSymbolPath(targetSrc, targetFile, i + 1);
      if (!isOrderedSubsequence(symbolPath, actual)) continue;
    }
    hits.push(i + 1);
  }
  return hits;
}
