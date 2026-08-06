/**
 * Escáner de cadenas `supabase.from(<tabla>)` — FUNCIONES PURAS SOBRE TEXTO.
 *
 * Lo consume `test/ownership-filter-guard.test.ts`. Vive separado y sin tocar el
 * disco por una razón concreta: si el escáner sólo se pudiera invocar sobre el
 * árbol real, sus propios tests serían «lo que el escáner encuentra hoy», que es
 * la trampa que este guardián existe para no repetir — un instrumento que se
 * compara contra su propia salida da verde con cualquier implementación,
 * incluida la que no encuentra nada. Siendo puras, G-03..G-07 les pasan fixtures
 * en memoria con la respuesta conocida de antemano.
 *
 * Exemplar: `test/test-files-are-run-in-ci.test.ts:203-274` (`discoverRunnersFrom`,
 * el mismo patrón de «parser puro del texto + wrapper que lee el disco»).
 *
 * ── LO QUE ESTE ESCÁNER NO VE (medido, no arreglado) ──────────────────────
 *
 *  (a) Las cadenas partidas en una variable: `let q = supabase.from(...)` y más
 *      abajo `q = q.eq('owner_ref', …)`. Se ve el `.from(`, no se ve el `.eq()`
 *      que llega en otra sentencia. 11 sitios medidos hoy (`discovery.ts`,
 *      `task.ts`, `mock-registry.ts`). El modo de falla apunta al lado RUIDOSO:
 *      esas cadenas se reportan como sin filtro aunque lo tengan → falso
 *      positivo que se resuelve con una excepción escrita, no falso negativo
 *      silencioso.
 *  (b) El VALOR que se le pasa al filtro. `.eq('owner_ref', otroOwner)` sale
 *      como `ownerFiltered: true`. Presencia textual, no semántica.
 *  (c) Los literales de expresión regular con comillas desbalanceadas dentro
 *      (`/[^']/`). El enmascarado usa la heurística estándar de «después de
 *      `( , = : [ ! & | ? { } ; return` una `/` abre regex»; si un archivo
 *      rompiera esa heurística el enmascarado se desincroniza. El control es
 *      G-02: el conteo global sobre el árbol real tiene un piso, así que una
 *      desincronización que se coma cadenas pone el guardián en rojo.
 */

/** Verbo de la cadena: el primero de estos métodos que aparece. */
export type Verb =
  | 'select'
  | 'insert'
  | 'update'
  | 'upsert'
  | 'delete'
  | 'unknown';

/** Una cadena `supabase.from(...)` encontrada en un archivo. */
export interface Chain {
  /** Ruta tal como se la pasaron a `scanSource`. */
  file: string;
  /** Línea 1-based del `.from(`. Es la convención de `censo-owner-ref.md`. */
  line: number;
  /** `null` = el argumento de `.from()` no se pudo resolver (ver `unresolved`). */
  table: string | null;
  /** Texto crudo del argumento de `.from(`, para el mensaje del rojo. */
  rawArg: string;
  verb: Verb;
  /** Hay un filtro por la columna `owner_ref` EXACTA en la misma cadena. */
  ownerFiltered: boolean;
  /** Métodos de la cadena, en orden, sin argumentos. Para diagnóstico. */
  methods: string[];
}

const CHAIN_VERBS: ReadonlySet<string> = new Set([
  'select',
  'insert',
  'update',
  'upsert',
  'delete',
]);

/**
 * Métodos que cuentan como «acota por dueño» si su primer argumento es la
 * columna `owner_ref`. Cualquier otra forma de acotar (`.or`, `.filter`) NO
 * cuenta y cae en la lista de excepciones con su motivo escrito.
 */
const SCOPING_METHODS: ReadonlySet<string> = new Set(['eq', 'in', 'match']);

/** La columna, comparada EXACTA. `ownerRef` en camelCase no es esta columna. */
const OWNER_COLUMN = 'owner_ref';

// ── (1) Enmascarado de comentarios, strings y regex ────────────────────────

/**
 * Devuelve una copia de `src` de la MISMA longitud donde los comentarios son
 * espacios y el contenido de strings/regex es relleno. Los índices siguen
 * alineados con el original, así que se recorre la estructura sobre la máscara
 * y se leen los literales sobre el texto real.
 *
 * Sin esto, un `.from(` dentro de un comentario o de un string cuenta como
 * cadena real, y un paréntesis dentro de un string descuadra el balanceo.
 */
export function maskNonCode(src: string): string {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  /** Último carácter de código visto, para decidir si una `/` abre regex. */
  let prev = '';

  const regexCanStart = (): boolean =>
    prev === '' || '(,=:[!&|?{};+-*%~^'.includes(prev);

  while (i < n) {
    const c = src[i] as string;

    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
      continue;
    }

    if (c === '/' && src[i + 1] === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      if (i < n) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
      continue;
    }

    if (c === "'" || c === '"' || c === '`') {
      i += 1;
      while (i < n && src[i] !== c) {
        if (src[i] === '\\') {
          out[i] = 'x';
          if (i + 1 < n && src[i + 1] !== '\n') out[i + 1] = 'x';
          i += 2;
          continue;
        }
        if (src[i] !== '\n') out[i] = 'x';
        i += 1;
      }
      i += 1;
      prev = c;
      continue;
    }

    if (c === '/' && regexCanStart()) {
      // Literal de regex: se rellena igual que un string para que sus paréntesis
      // y comillas no descuadren el balanceo de la cadena.
      let j = i + 1;
      let closed = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '[') {
          j += 1;
          while (j < n && src[j] !== ']' && src[j] !== '\n') {
            j += src[j] === '\\' ? 2 : 1;
          }
          j += 1;
          continue;
        }
        if (src[j] === '/') {
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed) {
        for (let k = i + 1; k < j; k += 1) out[k] = 'x';
        i = j + 1;
        prev = '/';
        continue;
      }
      // No cerraba en la línea: era una división. Se sigue de largo.
    }

    if (!/\s/.test(c)) prev = c;
    i += 1;
  }

  return out.join('');
}

// ── (2) Constantes de módulo ───────────────────────────────────────────────

/**
 * `const NOMBRE = 'literal'` → mapa NOMBRE → literal.
 *
 * CD-13. `src/services/fee-split.ts:37` es `const SPLITS_TABLE = 'a2a_fee_splits'`
 * y sus cadenas escriben `.from(SPLITS_TABLE)`: un escáner que sólo aceptara
 * literales dejaría fuera al archivo con más sitios del hallazgo y no se
 * enteraría. Resolverlas también sirve para EXCLUIR bien: `fee-charge.ts` usa
 * `const FEES_TABLE = 'a2a_protocol_fees'`, y esa tabla no tiene dueño.
 */
export function moduleStringConsts(src: string): Map<string, string> {
  const masked = maskNonCode(src);
  const found = new Map<string, string>();
  const re = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])/g;
  let m = re.exec(masked);
  while (m !== null) {
    const name = m[1] as string;
    const quote = m[2] as string;
    const start = (m.index as number) + (m[0] as string).length;
    const end = src.indexOf(quote, start);
    if (end !== -1 && !src.slice(start, end).includes('\n')) {
      found.set(name, src.slice(start, end));
    }
    m = re.exec(masked);
  }
  return found;
}

// ── (3) Tablas con dueño, derivadas del archivo de tipos ───────────────────

/**
 * Las tablas cuyo bloque `Row` declara una columna `owner_ref`, leídas de
 * `src/types/database.types.ts`.
 *
 * CD-4: el guardián NO lleva una lista escrita a mano; la deriva en cada
 * corrida. Una lista a mano es lo que ya envejeció en `CLAUDE.md` (dice 4).
 *
 * El formato del archivo generado, verificado: `Tables: {` con 4 espacios,
 * `<tabla>: {` con 6, `Row: {` con 8, columnas con 10. `Views: {` a 4 espacios
 * cierra el bloque `Tables`.
 *
 * Cuenta cualquier tipo: `kite_schema_transforms` declara `owner_ref: string | null`
 * y ENTRA. Que la fila pueda tener `NULL` es otro problema (una fila así es
 * invisible para todos), y este conjunto no opina sobre eso.
 */
export function deriveOwnerTables(typesSrc: string): Set<string> {
  return deriveTables(typesSrc).withOwner;
}

/** Igual que `deriveOwnerTables`, más el universo, para el control de armado. */
export function deriveTables(typesSrc: string): {
  all: Set<string>;
  withOwner: Set<string>;
} {
  const all = new Set<string>();
  const withOwner = new Set<string>();
  let inTables = false;
  let table: string | null = null;
  let inRow = false;

  for (const line of typesSrc.split('\n')) {
    const top = /^ {4}([A-Za-z_$][\w$]*)\s*:\s*\{\s*$/.exec(line);
    if (top !== null) {
      inTables = top[1] === 'Tables';
      table = null;
      inRow = false;
      continue;
    }
    if (!inTables) continue;

    const entry = /^ {6}([A-Za-z_$][\w$]*)\s*:\s*\{\s*$/.exec(line);
    if (entry !== null) {
      table = entry[1] as string;
      all.add(table);
      inRow = false;
      continue;
    }

    const block = /^ {8}([A-Za-z_$][\w$]*)\s*:\s*\{\s*$/.exec(line);
    if (block !== null) {
      inRow = block[1] === 'Row';
      continue;
    }

    if (inRow && table !== null && /^ {10}owner_ref\??\s*:/.test(line)) {
      withOwner.add(table);
    }
  }

  return { all, withOwner };
}

// ── (4) El escáner de cadenas ──────────────────────────────────────────────

function skipSpace(masked: string, from: number): number {
  let i = from;
  while (i < masked.length && /\s/.test(masked[i] as string)) i += 1;
  return i;
}

/** Índice del `)` que cierra el `(` de `open`. `-1` si no cierra. */
function matchParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** El identificador que termina en `end` (exclusivo), leído hacia atrás. */
function identBefore(masked: string, end: number): string {
  let i = end;
  while (i > 0 && /[\w$]/.test(masked[i - 1] as string)) i -= 1;
  return masked.slice(i, end);
}

/**
 * ¿El primer argumento de este método es la columna `owner_ref`?
 *
 * Comparación EXACTA del nombre (G-07): `.eq('ownerRef', …)` en camelCase NO
 * cuenta. Ese error concreto es indistinguible de un cross-tenant legítimo
 * cuando lo mira un mock que ignora los argumentos, y es la clase de bug que
 * deja al dueño sin ver sus propias filas.
 */
function scopesByOwner(method: string, args: string): boolean {
  if (!SCOPING_METHODS.has(method)) return false;
  if (method === 'match') {
    return new RegExp(`[{,]\\s*(?:'${OWNER_COLUMN}'|"${OWNER_COLUMN}"|${OWNER_COLUMN})\\s*:`).test(
      args,
    );
  }
  return new RegExp(`^\\s*(?:'${OWNER_COLUMN}'|"${OWNER_COLUMN}"|\`${OWNER_COLUMN}\`)\\s*(?:,|$)`).test(
    args,
  );
}

/**
 * Todas las cadenas `supabase.from(T)` de `src` con `T` ∈ `ownerTables`, MÁS
 * las cadenas cuyo argumento de `.from()` no se pudo resolver (`table: null`).
 *
 * Las no resolubles se devuelven a propósito en vez de descartarse: «no sé qué
 * tabla es esta» es indistinguible de «es una tabla con dueño que no estoy
 * mirando», y el guardián se pone rojo con ellas
 * (`test-files-are-run-in-ci.test.ts:38-39`: si no puede traducir, no adivina).
 *
 * CD-13, regla 1: se filtra por RECEPTOR (`supabase`), no por el nombre del
 * método. En `src/` no-test hay 156 `.from(` de los cuales la gran mayoría son
 * `Buffer.from` / `Array.from` / `Uint8Array.from` / `Transaction.from`. Sin el
 * filtro de receptor, la lista de «no pude resolver el argumento» nace con
 * decenas de entradas de ruido y el guardián se vuelve inservible.
 */
export function scanSource(
  src: string,
  ownerTables: Set<string>,
  filePath: string,
): Chain[] {
  const masked = maskNonCode(src);
  const consts = moduleStringConsts(src);
  const chains: Chain[] = [];

  // Prefijos de línea para traducir índice → número de línea, una sola vez.
  const lineStarts: number[] = [0];
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === '\n') lineStarts.push(i + 1);
  }
  const lineOf = (index: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((lineStarts[mid] as number) <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };

  const FROM = '.from(';
  let at = masked.indexOf(FROM);
  while (at !== -1) {
    const search = at + 1;

    // ── receptor: hacia atrás, saltando espacios y saltos de línea ──────
    // La forma dominante en este repo es multilínea:
    //     const { data } = await supabase
    //       .from('a2a_receipts')
    // así que el receptor no está pegado al `.from(`.
    const dotAt = at;
    const beforeDot = skipSpaceBack(masked, dotAt);
    const receiver = identBefore(masked, beforeDot);
    if (receiver !== 'supabase') {
      at = masked.indexOf(FROM, search);
      continue;
    }

    const open = at + FROM.length - 1;
    const close = matchParen(masked, open);
    if (close === -1) {
      at = masked.indexOf(FROM, search);
      continue;
    }

    const rawArg = src.slice(open + 1, close).trim();
    const table = resolveTable(rawArg, consts);

    // ── recorrer la CADENA, no la línea ────────────────────────────────
    const methods: string[] = [];
    let verb: Verb = 'unknown';
    let ownerFiltered = false;
    let cursor = close + 1;

    for (;;) {
      const next = skipSpace(masked, cursor);
      if (masked[next] !== '.') break;
      const nameStart = next + 1;
      const nameMatch = /^[A-Za-z_$][\w$]*/.exec(masked.slice(nameStart));
      if (nameMatch === null) break;
      const name = nameMatch[0];
      const afterName = skipSpace(masked, nameStart + name.length);
      if (masked[afterName] !== '(') {
        // Acceso a propiedad sin llamar: la cadena de PostgREST termina acá.
        break;
      }
      const argClose = matchParen(masked, afterName);
      if (argClose === -1) break;

      const args = src.slice(afterName + 1, argClose);
      methods.push(name);
      if (verb === 'unknown' && CHAIN_VERBS.has(name)) verb = name as Verb;
      if (scopesByOwner(name, args)) ownerFiltered = true;

      cursor = argClose + 1;
    }

    if (table === null || ownerTables.has(table)) {
      chains.push({
        file: filePath,
        line: lineOf(at),
        table,
        rawArg,
        verb,
        ownerFiltered,
        methods,
      });
    }

    at = masked.indexOf(FROM, search);
  }

  return chains;
}

function skipSpaceBack(masked: string, from: number): number {
  let i = from;
  while (i > 0 && /\s/.test(masked[i - 1] as string)) i -= 1;
  return i;
}

/** Literal → su valor; identificador → la constante de módulo; si no, `null`. */
function resolveTable(
  rawArg: string,
  consts: Map<string, string>,
): string | null {
  const literal = /^(['"`])([^'"`]*)\1$/.exec(rawArg);
  if (literal !== null) return literal[2] as string;
  if (/^[A-Za-z_$][\w$]*$/.test(rawArg)) return consts.get(rawArg) ?? null;
  return null;
}

/** Las cadenas del alcance del guardián: `select` / `update` / `delete`. */
export const GUARDED_VERBS: ReadonlySet<Verb> = new Set<Verb>([
  'select',
  'update',
  'delete',
]);
