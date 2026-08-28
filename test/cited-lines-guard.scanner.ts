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
 *  (h) EL ARCHIVO SIN EXTENSIÓN. El grupo de extensión sigue siendo obligatorio
 *      (`(?:\.[…]+)+`), así que un `Dockerfile:12` se DECAPITA exactamente igual
 *      que se decapitaba `.gitignore:172` antes del arreglo del `*`. Medido con
 *      fixtures sobre `scanSource`:
 *
 *        `// ver Dockerfile:12`         -> P4 `:12`  (pierde el nombre)
 *        `// ver Makefile:3`            -> P4 `:3`   (idem)
 *        `// ver docker/Dockerfile:12`  -> P4 `:12`  (idem, con directorio)
 *        `// ver https://x.io:8443/y`   -> P2 con path `x.io` (archivo inventado)
 *
 *      ⚠️ NO está arreglado, y la diferencia con el dotfile es lo que lo deja
 *      acá y no en un fix: DEGRADA RUIDOSO. Medido: agregar `Dockerfile:12` a un
 *      archivo del Corte A pone `G-C4` en ROJO (el `:12` cae al barrido bare y
 *      queda huérfano), no en verde. Lo que se pierde no es la detección: es el
 *      cruce mecánico `citeMatchesTarget`, que queda vacuo y pasa a depender del
 *      `targetReason` escrito a mano. Población hoy en el Corte A: 0 (barridos
 *      los 14 paths buscando `Dockerfile|Makefile|Procfile|LICENSE|CHANGELOG`
 *      seguidos de `:N`). Arreglarlo tiene CONTRAINDICACIÓN medida: aceptar
 *      segmentos sin punto convierte cualquier `foo:12` de la prosa en una cita
 *      con archivo, o sea que cambia un fallo ruidoso por ruido de fondo.
 */

import ts from 'typescript';

/** Las cuatro formas sintácticas en que este repo escribe una cita. */
export type CiteForm = 'P1' | 'P2' | 'P3' | 'P4';

/**
 * Las cuatro clases en que se puede caer un `:N` SUELTO (P3/P4).
 *
 * Vive acá, y no en el archivo de la muestra ni en el del guardián, para que el
 * que ETIQUETA A MANO y el que CLASIFICA hablen exactamente el mismo
 * vocabulario. Dos uniones homónimas declaradas en dos archivos coinciden el
 * día que se escriben y divergen en la próxima corrección de borde.
 *
 *  · `CITA`        — apunta a una línea de un archivo del repo.
 *  · `RUIDO`       — no es una cita: puerto, chain id, timestamp, valor de un
 *                    campo de un objeto escrito en la prosa.
 *  · `DATO`        — es el VALOR de un campo `cite:` / `quote:` de un registro,
 *                    o sea la cita de OTRO archivo transcripta como dato.
 *  · `INDECIDIBLE` — el contexto no alcanza para decidir a QUÉ archivo apunta.
 *                    Es una respuesta legítima y es el bug del issue #178.
 */
export type BareLabel = 'CITA' | 'RUIDO' | 'DATO' | 'INDECIDIBLE';

/** Una cita `archivo:línea` encontrada en el texto de un archivo. */
export interface FoundCite {
  /** Ruta tal como se la pasaron a `scanSource`. */
  readonly file: string;
  /** Línea 1-based del citador donde aparece el token. DERIVADA, no se guarda. */
  readonly line: number;
  /**
   * Columna 0-based del `:` dentro del FUENTE ENTERO (no dentro de la línea).
   *
   * 🔴 EXISTE POR UN DEFECTO MEDIDO, no por completitud. `classifyBareCite`
   * ubicaba el token con `linea.indexOf(token)`, y eso devuelve la PRIMERA
   * aparición del substring, no la del token. Medido en
   * `src/lib/url-validator.ts:129`, cuya línea es
   * `` `::1`, `0:0:0:0:0:0:0:1` — loopback ``: el token real es el `:1` final
   * (carácter anterior `0` ⇒ RUIDO por D1), pero `indexOf(':1')` caía dentro de
   * `` `::1` `` (carácter anterior `:`), la regla D1 no disparaba y el token
   * terminaba clasificado como una CITA a la línea 1 de su propio archivo.
   * Un token mal ubicado no da error: da una respuesta plausible.
   */
  readonly col: number;
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
      col: start,
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
      col: start,
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
 * 🔴 EL CANDADO DE CD-14 SOBRE `SCANNER_FALSE_POSITIVES`: ¿este token nombra un
 * archivo que EXISTE en el índice de git? Devuelve el path trackeado, o `null`.
 *
 * Es la única pregunta que distingue mecánicamente un RUIDO del escáner de una
 * AFIRMACIÓN sobre el repo, y por eso vive acá y no adentro del guardián: es la
 * misma decisión que `citeNamesFile`, y duplicar el criterio es exactamente lo
 * que reprodujo el punto ciego del dotfile adentro de su propio arreglo.
 *
 * ⚠️ La regla NO puede ser «ningún token con path». Medido: `https://x.io:8443/y`
 * produce un token P2 con path (`x.io`) que ES ruido legítimo. Lo que separa los
 * dos casos es que `x.io` no está en el índice de git y `src/types/database.types.ts`
 * sí. Sin esta función, mover una cita REAL a `SCANNER_FALSE_POSITIVES` con una
 * excusa de 40 caracteres la saca del universo y el guardián queda 10/10 verde:
 * el interruptor de apagado que CD-14 existe para prohibir, en la otra lista.
 *
 * La resolución es la misma que `citeMatchesTarget` acepta como consistente:
 * `./`/`../` resuelto contra el citador; con `/`, path exacto o sufijo alineado
 * por segmento; sin `/` (P2), por basename.
 */
export function citeTargetIfTracked(
  fromFile: string,
  token: string,
  tracked: ReadonlySet<string>,
  byBasename: ReadonlyMap<string, readonly string[]>,
): string | null {
  const raw = citePathOf(token);
  if (raw === null) return null;
  if (raw.startsWith('./') || raw.startsWith('../')) {
    const resolved = normalizeTarget(fromFile, token);
    return resolved !== null && tracked.has(resolved) ? resolved : null;
  }
  const base = raw.slice(raw.lastIndexOf('/') + 1);
  const candidates = byBasename.get(base) ?? [];
  if (!raw.includes('/')) return candidates[0] ?? null;
  return candidates.find((f) => f === raw || f.endsWith(`/${raw}`)) ?? null;
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

// ── EL DISCRIMINADOR DE CITAS SUELTAS (P3/P4) ──────────────────────────────
//
// 🔴 EL AGUJERO QUE ESTAS TRES FUNCIONES EXISTEN PARA TAPAR, y está seis
// funciones más arriba: `citeMatchesTarget` abre con `if (raw === null) return
// true`, y `citePathOf` devuelve `null` para TODO token P3/P4. O sea que el
// cruce mecánico entre un `:N` suelto y el `target` que un humano declaró a
// mano devuelve `true` SIN MIRAR NADA. `E-CITE_TARGET_MISMATCH` no se puede
// disparar jamás para esos tokens. Lo que sigue es lo que permite cruzarlos.
//
// ⛔ Y LO QUE ESTAS FUNCIONES NO PUEDEN HACER, POR CONTRATO: usar
// `citeTargetIfTracked` como resolvedor. Su último renglón es
// `if (!raw.includes('/')) return candidates[0] ?? null;` — con homónimos elige
// el PRIMERO EN SILENCIO, y no es un borde raro: medido contra el índice de
// git, el basename `sdd.md` tiene más de cien candidatos. Un resolvedor que
// contesta «uno cualquiera de esos» es peor que uno que dice «no sé», porque su
// respuesta pasa los controles. Por eso `resolveContextTarget` devuelve
// `'AMBIGUOUS'` y NUNCA `string | null`: el tipo hace imposible confundir «no
// hay contexto» con «hay demasiado».

/** La naturaleza de una línea, para cortar el párrafo (DT-10). */
type LineKind = 'blank' | 'deco' | 'comment' | 'code';

/** Caracteres que forman una regla, una caja o un separador. */
const DECO_ONLY = /^[\s*/─━—–\-=~_#·.]*$/;

function lineKind(raw: string): LineKind {
  const t = raw.trim();
  if (t === '') return 'blank';
  const isComment = t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
  if (DECO_ONLY.test(t)) return 'deco';
  return isComment ? 'comment' : 'code';
}

/**
 * El PÁRRAFO que rodea a `line`: la corrida máxima de líneas contiguas de la
 * misma naturaleza, cortada por (a) línea vacía, (b) línea de sólo decoración y
 * (c) cambio de naturaleza entre «línea que es SÓLO comentario» y «línea con
 * código».
 *
 * 🔴 EL PUNTO (c) NO ES COSMÉTICO, Y ESTÁ MEDIDO. Sin él, en un archivo como
 * `cited-lines-guard.citations.ts` —una lista de literales de objeto SIN
 * líneas en blanco entre entradas— el párrafo se derrama a través de varias
 * entradas y arrastra los nombres de archivo de las entradas VECINAS. El
 * síntoma no es un error: es un `INDECIDIBLE` por «el párrafo nombra 5
 * archivos», o sea una respuesta plausible construida sobre contexto ajeno.
 *
 * ⚠️ Lo que (c) NO separa: el comentario al final de una línea de código. Esa
 * línea es `code` entera, comentario incluido, así que un `// … (:397)` pegado
 * a un `'insert:sin-filtro',` se agrupa con el código de alrededor y toma como
 * contexto los archivos que nombren las otras líneas del literal. Es
 * deliberado —ahí es exactamente donde suele estar el contexto— y es la misma
 * dirección de falla que `stripComments` declara en su docblock.
 */
export function paragraphOf(src: string, line: number): string {
  const lines = src.split('\n');
  if (line < 1 || line > lines.length) return '';
  const kind = lineKind(lines[line - 1] as string);
  if (kind === 'blank' || kind === 'deco') return lines[line - 1] as string;
  let from = line;
  while (from > 1 && lineKind(lines[from - 2] as string) === kind) from -= 1;
  let to = line;
  while (to < lines.length && lineKind(lines[to] as string) === kind) to += 1;
  return lines.slice(from - 1, to).join('\n');
}

/**
 * Un path escrito en la prosa SIN `:N` detrás: `` `evidence.ts` ``,
 * `src/services/compose.ts`, `../adapters/solana/chain.ts`.
 *
 * Es la MISMA gramática de path que `FILE_CITE_RE`, sin el `:(\d+)`. Se
 * escribe una sola vez y se deriva de la otra sería mejor todavía, pero las
 * dos son literales de regex y JS no compone regex sin `source`; lo que sí se
 * hace es NO duplicar el criterio de resolución: `mentionCandidates` es la
 * única resolución, y `citeTargetIfTracked` no se toca ni se llama.
 */
const FILE_NAME_RE = /(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_@-]*(?:\.[A-Za-z0-9_-]+)+/g;

/**
 * TODOS los archivos trackeados que un path escrito en la prosa podría nombrar.
 *
 * 🔴 Devuelve la LISTA, no un elemento. Es la diferencia con
 * `citeTargetIfTracked`, y es toda la corrección: dos candidatos son un dato
 * («este contexto no alcanza»), y quedarse con el primero convierte ese dato en
 * una afirmación falsa que después pasa todos los controles.
 */
export function mentionCandidates(
  fromFile: string,
  raw: string,
  tracked: ReadonlySet<string>,
  byBasename: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  if (raw.startsWith('./') || raw.startsWith('../')) {
    const resolved = normalizeTarget(fromFile, raw);
    return resolved !== null && tracked.has(resolved) ? [resolved] : [];
  }
  // 🔴 EL PATH EXACTO GANA, y este renglón es un defecto MEDIDO de la primera
  // versión de esta función, no una optimización. Sin él, `src/index.ts` —un
  // path completo desde la raíz del repo, que existe tal cual en el índice—
  // devolvía DOS candidatos, porque `packages/agent-sdk/src/index.ts` también
  // termina en `/src/index.ts`. El resultado era `AMBIGUOUS` sobre un nombre
  // que no tiene nada de ambiguo, y tres citas reales del árbol se perdían por
  // eso. Un path que está en el índice TAL CUAL no necesita desempate: el
  // sufijo es una coincidencia, la igualdad no.
  if (tracked.has(raw)) return [raw];
  const base = raw.slice(raw.lastIndexOf('/') + 1);
  const candidates = byBasename.get(base) ?? [];
  if (!raw.includes('/')) return candidates;
  // Sufijo alineado por SEGMENTO: `lib/payment-spec-reader.ts` ↔
  // `src/lib/payment-spec-reader.ts`. Es el mismo criterio que
  // `citeMatchesTarget` acepta como consistente, y por eso puede devolver
  // varios: ahí es una VERIFICACIÓN contra un target ya declarado a mano, acá
  // es una RESOLUCIÓN sin nadie que la haya decidido. La misma pregunta, dos
  // usos, y sólo uno de los dos puede darse el lujo de quedarse con el primero.
  return candidates.filter((f) => f.endsWith(`/${raw}`));
}

/** Lo que un párrafo nombra: lo que se pudo resolver, y lo que quedó ambiguo. */
export interface ContextScan {
  /** Targets distintos que se resolvieron a UN candidato. */
  readonly targets: readonly string[];
  /** Los paths escritos que dieron MÁS de un candidato (homónimos). */
  readonly ambiguous: readonly string[];
}

/**
 * Los archivos que un párrafo nombra, en UNA de las dos formas.
 *
 * `mode`:
 *   · `'withLine'` — nombrados CON `:N` (`compose.ts:343`). Es D3a.
 *   · `'bare'`     — nombrados SIN `:N` (`` `evidence.ts` ``). Es D3b.
 *
 * La forma `'withLine'` NO re-implementa el reconocimiento: llama a
 * `scanSource` sobre el párrafo y se queda con los P1/P2. Un segundo criterio
 * para la misma pregunta coincide el día que se escribe y diverge en el
 * próximo borde; en este archivo ya pasó una vez, y está documentado en
 * `citeNamesFile`.
 */
export function scanContext(
  paragraph: string,
  fromFile: string,
  tracked: ReadonlySet<string>,
  byBasename: ReadonlyMap<string, readonly string[]>,
  mode: 'withLine' | 'bare',
): ContextScan {
  const targets: string[] = [];
  const ambiguous: string[] = [];
  const add = (raw: string): void => {
    const cands = mentionCandidates(fromFile, raw, tracked, byBasename);
    if (cands.length === 1) {
      const t = cands[0] as string;
      if (!targets.includes(t)) targets.push(t);
    } else if (cands.length > 1) {
      if (!ambiguous.includes(raw)) ambiguous.push(raw);
    }
  };

  if (mode === 'withLine') {
    for (const hit of scanSource(paragraph, fromFile)) {
      if (hit.path !== undefined) add(hit.path);
    }
    return { targets, ambiguous };
  }

  FILE_NAME_RE.lastIndex = 0;
  for (let m = FILE_NAME_RE.exec(paragraph); m !== null; m = FILE_NAME_RE.exec(paragraph)) {
    const start = m.index;
    const prev = start > 0 ? (paragraph[start - 1] as string) : '';
    // No arrancar en medio de un identificador ni de un path más largo.
    if (IDENT_CHAR.test(prev) || prev === '/') continue;
    const end = start + m[0].length;
    // Con `:N` detrás es la otra forma: la cubre `'withLine'`, y contarla acá
    // la duplicaría.
    if (paragraph[end] === ':' && /\d/.test(paragraph[end + 1] ?? '')) continue;
    add(m[0]);
  }
  return { targets, ambiguous };
}

/**
 * El destino que el CONTEXTO determina, o por qué no lo determina.
 *
 * ⛔ El tipo de retorno NO puede ser `string | null`. Ése es exactamente el
 * defecto de `citeTargetIfTracked`: colapsa «no hay» y «hay varios» en el mismo
 * valor, y el que llama no puede distinguirlos ni queriendo.
 *
 * `'AMBIGUOUS'` cubre las DOS formas de tener demasiado contexto: el párrafo
 * nombra más de un archivo distinto (D6), o nombra un basename con más de un
 * candidato en el índice (D7). Las dos terminan en `INDECIDIBLE`; el motivo
 * que las separa lo escribe `classifyBareCite`.
 *
 * ⚠️ Y D7 sólo decide cuando la ambigüedad es el ÚNICO contexto. Está medido:
 * la versión gruesa —todo párrafo que contenga ALGÚN nombre ambiguo se declara
 * indecidible— baja el recall a la mitad, porque casi todo párrafo largo
 * menciona de paso algún `index.ts` o algún `payment.ts`. Si hay un contexto no
 * ambiguo, gana el no ambiguo.
 */
export function resolveContextTarget(
  paragraph: string,
  fromFile: string,
  tracked: ReadonlySet<string>,
  byBasename: ReadonlyMap<string, readonly string[]>,
  mode: 'withLine' | 'bare',
): { target: string } | 'AMBIGUOUS' | null {
  const scan = scanContext(paragraph, fromFile, tracked, byBasename, mode);
  if (scan.targets.length === 1) return { target: scan.targets[0] as string };
  if (scan.targets.length > 1) return 'AMBIGUOUS';
  return scan.ambiguous.length > 0 ? 'AMBIGUOUS' : null;
}

/** El veredicto del discriminador sobre UN token suelto. */
export interface BareVerdict {
  /** EXACTAMENTE una de las cuatro clases. */
  readonly label: BareLabel;
  /** Presente si y sólo si `label === 'CITA'`. */
  readonly target?: string;
  /** El motivo legible, con el nombre de la regla que decidió. */
  readonly why: string;
  readonly rule: 'D1' | 'D2' | 'D3a' | 'D3b' | 'D5' | 'D6' | 'D7' | 'RESIDUO';
}

/**
 * LA CASCADA. Clasifica un `:N` SUELTO (P3/P4) en una de cuatro clases.
 *
 * Orden de evaluación, y el orden importa:
 *   D1  el carácter anterior al `:` es alfanumérico o `_`  ⇒ RUIDO
 *   D2  el carácter anterior es `'` o `"`                  ⇒ DATO
 *   D6/D7  el párrafo nombra más de un archivo, o sólo nombres ambiguos
 *                                                          ⇒ INDECIDIBLE
 *   D3a el párrafo nombra EXACTAMENTE UN archivo, con `:N` ⇒ CITA
 *   D3b ídem, nombrado sin `:N`                            ⇒ CITA
 *   D5  el párrafo no nombra ninguno y el `:N` cae dentro del propio archivo
 *                                                          ⇒ CITA (auto-cita)
 *   RESIDUO                                                ⇒ INDECIDIBLE
 *
 * 🔴 D6/D7 VAN ANTES QUE D3: la ambigüedad gana. Al revés, un párrafo que
 * nombra tres archivos devolvería el primero que el escáner encuentre, que es
 * `candidates[0]` con otro disfraz.
 *
 * 🔴 D5 ESTÁ DEGRADADA A `INDECIDIBLE`, Y ÉSA ES LA MEDICIÓN MÁS CARA DE ESTA
 * HU. La regla entró con una hipótesis fuerte y con un umbral de rechazo
 * escrito ANTES de medir —«más de 20 destinos equivocados sobre 94 y D5 se
 * degrada»—, justamente para que ningún resultado se pudiera narrar como éxito.
 *
 * Lo que se midió es un CENSO, no un muestreo: los 36 sitios del perímetro que
 * llegan a D5, abiertos uno por uno. **19 apuntan al propio archivo y 17
 * apuntan a otro.** 47 % de destinos equivocados contra un techo de 21 %.
 *
 * ⚠️ El umbral admite dos lecturas y las dos van escritas, porque elegir la
 * cómoda en silencio sería el defecto que esta HU persigue:
 *   · ABSOLUTA («más de 20 FP»): 17 ≤ 20 ⇒ D5 PASA.
 *   · COMO TASA («20 sobre 94» ⇒ ≤ 21 %): 17/36 = 47 % ⇒ D5 NO PASA.
 * Manda la segunda: el «20» sólo tiene sentido contra el denominador para el
 * que se escribió, y el denominador real salió 2,6 veces más chico. Un umbral
 * absoluto sobre una población que encogió no es un umbral, es un regalo.
 *
 * Lo que la degradación cuesta y lo que compra, sobre la muestra reservada
 * (estrato P3, etiquetado a mano ANTES de que esta función existiera):
 *   · con D5:  precisión 15/21 = 71 %,  recall 15/57
 *   · sin D5:  precisión 13/14 = 93 %,  recall 13/57
 * O sea que D5 aportaba 2 aciertos y 5 destinos inventados. **Un destino
 * inventado es peor que un `INDECIDIBLE`**: el `INDECIDIBLE` pide que alguien
 * mire, y el destino inventado pasa los controles.
 *
 * 🔴 LO QUE SIGUE SIENDO VERDAD, Y NO LO REFUTA ESTA DEGRADACIÓN: la AUTO-CITA
 * es la forma principal en que este repo escribe una cita suelta. Los 5 falsos
 * negativos que el F1 encontró contra las entradas ya etiquetadas son 5 de 5
 * auto-citas, y siguen sin resolverse. Lo que se midió acá no es que la
 * auto-cita sea rara: es que «cae dentro del rango de líneas del propio
 * archivo» NO ALCANZA para reconocerla — en un archivo de 2000 líneas, casi
 * cualquier número cae adentro. La detección se conserva en el `why` (dice a
 * qué archivo se PARECE) para que la próxima HU tenga de dónde partir; lo que
 * no se conserva es la afirmación.
 *
 * ⛔ NINGUNA REGLA MIRA LOS BACKTICKS NI EL RANGO DEL NÚMERO, y las dos
 * prohibiciones están refutadas por los dos lados, no supuestas:
 *   · backticks: `test/cited-lines-guard.exceptions.ts` declara puertos
 *     BACKTICKEADOS (`` `:8443` ``, `` `:443` ``, `` `:80` ``, `` `:0` ``) que
 *     son ruido, y decenas de citas reales se escriben sin un solo backtick.
 *   · rango: «los números chicos no son líneas» se come mañana una cita a la
 *     línea 80. Es el mismo criterio que `scanSource` ya declara en su
 *     docblock, y se respeta acá para no tener dos criterios distintos.
 *
 * ── LO QUE ESTA CASCADA NO DECIDE (medido, no arreglado) ───────────────────
 *
 *  (i)   EL DESTINO CROSS-REPO. Un `:77` cuyo contexto es
 *        `wasiai-remittance-agents/src/manifest/registry.ts:76` apunta a un
 *        archivo que no está en el índice de ESTE repo. Si el párrafo nombra
 *        además algún archivo de acá, D3a devuelve ÉSE: es un falso positivo, y
 *        está contado en el censo de la HU, no escondido.
 *  (ii)  EL VALOR SEMÁNTICO. Esta cascada dice a qué ARCHIVO apunta el token.
 *        Que la línea diga lo que la prosa afirma lo verifica `G-C5` con su
 *        `mustContain`; que la prosa sea verdadera no lo verifica nadie.
 *  (iii) LA LÍNEA PODRIDA. Un `:839` que apunta a un archivo correcto y a una
 *        línea que se movió sale `CITA` igual, y está bien: el número lo cruza
 *        el registro, no el clasificador.
 *  (iv)  EL CITADOR AUTO-REFERENTE. Los 8 archivos de `SELF_REFERENTIAL`
 *        contienen el `target` que esta función tendría que producir. La
 *        exclusión NO vive acá —esta función es pura y no conoce esa lista—,
 *        vive en quien arma el universo, y `G-C16` la verifica.
 */
export function classifyBareCite(
  hit: FoundCite,
  src: string,
  tracked: ReadonlySet<string>,
  byBasename: ReadonlyMap<string, readonly string[]>,
): BareVerdict {
  const lines = src.split('\n');
  // ⛔ NO se busca el token con `indexOf` sobre la línea: `hit.col` es la
  // posición REAL que devolvió el escáner. Ver el docblock de `FoundCite.col`
  // para el caso medido en que las dos difieren y la diferencia decide la clase.
  const prev = hit.col > 0 ? (src[hit.col - 1] as string) : '';

  if (/[A-Za-z0-9_]/.test(prev)) {
    return {
      label: 'RUIDO',
      rule: 'D1',
      why: `D1: el carácter anterior al token es «${prev}», o sea que el \`:\` está pegado a un identificador o a un número (puerto, chain id, timestamp, valor de un campo).`,
    };
  }
  if (prev === "'" || prev === '"') {
    return {
      label: 'DATO',
      rule: 'D2',
      why: `D2: el carácter anterior al token es una comilla (${prev}), o sea que el token es el VALOR de un campo de un registro y no una afirmación del texto.`,
    };
  }

  const paragraph = paragraphOf(src, hit.line);
  const withLine = scanContext(paragraph, hit.file, tracked, byBasename, 'withLine');
  const bareCtx = scanContext(paragraph, hit.file, tracked, byBasename, 'bare');
  const union: string[] = [...withLine.targets];
  for (const t of bareCtx.targets) if (!union.includes(t)) union.push(t);

  if (union.length > 1) {
    return {
      label: 'INDECIDIBLE',
      rule: 'D6',
      why: `D6: el párrafo nombra ${union.length} archivos trackeados distintos (${union.join(', ')}) y nada dice a cuál apunta este \`${hit.cite}\`.`,
    };
  }
  if (union.length === 1) {
    const target = union[0] as string;
    const byLine = withLine.targets.includes(target);
    return {
      label: 'CITA',
      target,
      rule: byLine ? 'D3a' : 'D3b',
      why: byLine
        ? `D3a: el párrafo nombra un solo archivo trackeado, y lo nombra CON número de línea: \`${target}\`.`
        : `D3b: el párrafo nombra un solo archivo trackeado, sin número de línea: \`${target}\`.`,
    };
  }

  const ambiguous = [...withLine.ambiguous, ...bareCtx.ambiguous];
  if (ambiguous.length > 0) {
    return {
      label: 'INDECIDIBLE',
      rule: 'D7',
      why: `D7: el único contexto del párrafo son nombres HOMÓNIMOS (${ambiguous.join(', ')}), con más de un candidato en el índice de git. Elegir el primero sería inventar el destino.`,
    };
  }

  const last = Number(hit.endNum ?? hit.num);
  if (hit.num >= 1 && last <= lines.length) {
    return {
      label: 'INDECIDIBLE',
      rule: 'D5',
      why: `D5 DEGRADADA: PARECE una auto-cita a \`${hit.file}\` —el párrafo no nombra ningún archivo trackeado y la línea ${hit.num} cae dentro del propio citador (${lines.length} líneas)—, pero NO se emite como CITA. Ver el docblock de \`classifyBareCite\`: el censo completo de los sitios que llegan acá midió que casi la mitad apunta a OTRO archivo.`,
    };
  }

  return {
    label: 'INDECIDIBLE',
    rule: 'RESIDUO',
    why: `RESIDUO: el párrafo no nombra ningún archivo trackeado y la línea ${hit.num}${hit.endNum === undefined ? '' : `-${hit.endNum}`} cae FUERA del propio citador (${lines.length} líneas), así que ni siquiera puede ser una auto-cita.`,
  };
}

/**
 * El fuente SIN los comentarios: bloques `/* … *\/` y líneas que son sólo
 * comentario. Deja intactas las URLs y los strings de código, a diferencia de
 * cortar por el primer `//`, que se comería la mitad de cualquier `https://…`.
 *
 * 🔴 PARA QUÉ EXISTE: un `includes()` sobre el fuente CRUDO no distingue «este
 * archivo vigila X» de «este archivo MENCIONA X en un comentario». Medido sobre
 * la delegación: `src/lib/money-invariants.fuzz.test.ts` nombra
 * `src/lib/downstream-payment.ts` en un comentario y no verifica una sola cita,
 * y aun así alcanzaba para declararse dueño de ese target y sacar 4 claves del
 * universo con el guardián en 12/12 verde.
 *
 * ⚠️ NO ES CÓDIGO NUEVO: es el mismo criterio que `codeOnly` en
 * `test/payment-guards-live-in-one-place.test.ts`, cuyo docblock explica el
 * falso positivo que lo obliga (`routes/agents.ts` menciona `x402` en un mensaje
 * de error y `getInitializedChainKeys()` en un comentario). Ese archivo es
 * Corte A y está fuera del scope de esta HU, así que NO se tocó ni se importó
 * de ahí: se re-escribió como función PURA sobre un string, porque
 * `delegationFindings` recibe el fuente por un lector inyectado y no lee disco.
 * La duplicación es deliberada y está declarada; si algún día los tres
 * criterios divergen, el que manda es el del guard del camino del dinero
 * (`codeOnly`), y los otros dos se alinean a él.
 *
 * 🔴 SON TRES, NO DOS — y las dos razones de arriba no cubren al tercero (CR
 * `MNR-cr-4`). `test/scripts-imported-by-tests-are-tracked.test.ts:61` ya
 * declara `function stripComments(source: string): string`: mismo nombre, misma
 * semántica, función PURA sobre un string (o sea SIN el problema del disco) y
 * fuera de `CORTE_A_PATHS` (o sea SIN el problema de scope). Hoy el repo tiene
 * TRES limpiadores de comentarios JS/TS, dos con el mismo nombre. Es homónimo,
 * no colisión: aquél es local a su archivo. Y nada mecánico detecta que
 * diverjan — si mañana alguien arregla uno para template literals, los otros se
 * quedan con el criterio viejo y todo sigue verde. Eso es exactamente lo que la
 * delegación de `_INDEX.md` describe en `cited-lines-guard.citations.ts` como
 * «dos criterios que coinciden el día que se escriben y divergen en la próxima
 * corrección de borde». Queda ABIERTO: `TD-224-TRES-STRIPCOMMENTS`.
 *
 * Límite, con esas palabras — y son DOS direcciones, no una. La versión
 * anterior de este párrafo decía que el único modo de fallo era «BORRAR de
 * más … degradar hacia el rojo, que es el lado seguro»; eso está incompleto.
 *   (a) HACIA EL ROJO (seguro): es textual, no un parser. Un `/*` adentro de un
 *       string literal se come lo que sigue hasta el próximo `*\/`, así que un
 *       control que existe se declararía ausente.
 *   (b) HACIA EL VERDE (inseguro): borra de MENOS. El filtro sólo descarta la
 *       línea cuyo texto ARRANCA con `//`, `*` o `/*`, así que **el comentario
 *       al final de una línea de código SOBREVIVE**. Medido:
 *       `const _C = 1; // cubre <target>` pasa entero. Esa es la dirección que
 *       abarata la delegación, y está declarada en el docblock de
 *       `delegationFindings` (`TD-224-DELEGACION-CUESTA-CERO`).
 * El docblock de `codeOnly` no comete este error: dice sólo «las líneas que son
 * SÓLO comentario», sin prometer una dirección.
 */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
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
