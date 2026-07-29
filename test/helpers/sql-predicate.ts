/**
 * Helper COMPARTIDO de tests de migración: evaluador del subconjunto de SQL booleano
 * que usan los guards de las migraciones, + extractor de cláusulas.
 *
 * ⚠️ POR QUE VIVE ACA Y NO EN UN `.test.ts`: lo consumen `hu202-hop2-lease.migration`
 * y `wkh307-solana-settle-intents.migration`. Importar un archivo `.test.ts` desde otro
 * EJECUTA sus `describe`/`it` y los REGISTRA DOS VECES (medido: 22 → 23 al importar).
 * Este archivo no matchea el glob de vitest (`*.test.ts`), así que se importa sin
 * arrastrar suites ajenas.
 *
 * Se movió tal cual desde `hu202-hop2-lease.migration.test.ts` (WKH-307): mismo código,
 * misma semántica, una sola definición.
 */

/**
 * ── AR de HU-202, MENOR 2 — DE TABLA DE VERDAD DECORATIVA A EVALUADOR DEL SQL REAL ──
 *
 * Este archivo tenía DOS tablas de verdad (una por guard) escritas así:
 *
 *     const guard = (p, cur) => p !== 'resolving_settle' || cur === null || [...].includes(cur);
 *     expect(guard('resolving_settle', 'settled')).toBe(false);
 *
 * Eso es una RE-IMPLEMENTACIÓN EN JAVASCRIPT del predicado, seguida de aserciones sobre la
 * re-implementación. Es verdadera POR CONSTRUCCIÓN: se puede borrar el `WHERE` entero del
 * `.sql` y esas líneas siguen verdes. Aserciones decorativas, y justo en el archivo cuyo
 * propósito declarado es cazar vacuidades.
 *
 * LA CONVERSIÓN: en vez de re-escribir el predicado, se EXTRAE del `.sql` y se EVALÚA. El
 * evaluador de abajo cubre el subconjunto de SQL booleano que estos guards usan (`OR`,
 * `AND`, `=`, `<>`, `IS [NOT] NULL`, `IN (...)`, literales de texto, identificadores). Si
 * alguien muta el `WHERE` de la migración, el texto extraído cambia, el predicado evaluado
 * cambia, y la tabla de verdad SE PONE ROJA — que es lo que la versión anterior no podía
 * hacer bajo ninguna mutación.
 *
 * ALCANCE HONESTO: esto sigue sin ser Postgres. Evalúa la EXPRESIÓN tal como está escrita,
 * con la semántica de tres valores reducida a booleano para el subconjunto usado. No
 * verifica planes, tipos ni NULLs en operadores que estos guards no usan.
 */

/** Un valor de columna/parámetro tal como lo ve el evaluador. */
type SqlValue = string | null;

/**
 * Evalúa una expresión booleana SQL del subconjunto usado por los guards de esta
 * migración, contra un entorno `{ identificador: valor }`.
 *
 * Precedencia: `OR` (más bajo) → `AND` → comparaciones. Paréntesis soportados.
 */
export function evalSqlPredicate(
  expr: string,
  env: Record<string, SqlValue>,
): boolean {
  const src = expr.trim();
  let pos = 0;

  const skipWs = () => {
    while (pos < src.length && /\s/.test(src[pos] as string)) pos++;
  };
  /** Consume `word` (case-insensitive) si sigue; devuelve si lo consumió. */
  const eatWord = (word: string): boolean => {
    skipWs();
    const slice = src.slice(pos, pos + word.length);
    if (slice.toUpperCase() !== word.toUpperCase()) return false;
    const after = src[pos + word.length];
    if (after !== undefined && /[A-Za-z0-9_]/.test(after)) return false;
    pos += word.length;
    return true;
  };
  const eatChar = (ch: string): boolean => {
    skipWs();
    if (src[pos] !== ch) return false;
    pos++;
    return true;
  };
  /** `'texto'` → el texto; identificador → su valor en `env` (error si falta). */
  const readOperand = (): SqlValue => {
    skipWs();
    if (src[pos] === "'") {
      const end = src.indexOf("'", pos + 1);
      if (end === -1) throw new Error(`unterminated string at ${pos}`);
      const lit = src.slice(pos + 1, end);
      pos = end + 1;
      return lit;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(pos));
    if (!m) throw new Error(`expected operand at ${pos}: ${src.slice(pos, 40)}`);
    const ident = m[0];
    pos += ident.length;
    if (!(ident in env)) {
      // Un identificador que el test no modeló es un agujero del test, NO un pass.
      throw new Error(`unmodelled identifier in SQL predicate: ${ident}`);
    }
    return env[ident] as SqlValue;
  };

  const parseOr = (): boolean => {
    let acc = parseAnd();
    while (eatWord('OR')) acc = parseAnd() || acc;
    return acc;
  };
  const parseAnd = (): boolean => {
    let acc = parseAtom();
    while (eatWord('AND')) acc = parseAtom() && acc;
    return acc;
  };
  const parseAtom = (): boolean => {
    skipWs();
    if (eatChar('(')) {
      const v = parseOr();
      if (!eatChar(')')) throw new Error(`expected ) at ${pos}`);
      return v;
    }
    const left = readOperand();
    if (eatWord('IS')) {
      const negated = eatWord('NOT');
      if (!eatWord('NULL')) throw new Error(`expected NULL at ${pos}`);
      return negated ? left !== null : left === null;
    }
    if (eatWord('IN')) {
      if (!eatChar('(')) throw new Error(`expected ( after IN at ${pos}`);
      const items: SqlValue[] = [readOperand()];
      while (eatChar(',')) items.push(readOperand());
      if (!eatChar(')')) throw new Error(`expected ) after IN list at ${pos}`);
      // SQL: `NULL IN (...)` no es TRUE.
      return left !== null && items.includes(left);
    }
    skipWs();
    if (src.startsWith('<>', pos)) {
      pos += 2;
      const right = readOperand();
      return left !== null && right !== null && left !== right;
    }
    if (src[pos] === '=') {
      pos += 1;
      const right = readOperand();
      return left !== null && right !== null && left === right;
    }
    throw new Error(`unsupported operator at ${pos}: ${src.slice(pos, 40)}`);
  };

  const result = parseOr();
  skipWs();
  if (pos !== src.length) {
    throw new Error(`trailing input at ${pos}: ${src.slice(pos, 40)}`);
  }
  return result;
}

/**
 * Extrae del cuerpo de una función el bloque `AND ( … )` cuyo texto contiene `anchor`.
 * Balancea paréntesis, así que devuelve la expresión COMPLETA tal como está en el `.sql`.
 * Si el guard se borra o se renombra, esto TIRA — que es el punto.
 */
export function extractGuardClause(fnSql: string, anchor: string): string {
  const anchorAt = fnSql.indexOf(anchor);
  if (anchorAt === -1) {
    throw new Error(`guard clause not found in SQL (anchor: ${anchor})`);
  }
  const open = fnSql.lastIndexOf('(', anchorAt);
  if (open === -1) throw new Error(`no opening paren before anchor: ${anchor}`);
  let depth = 0;
  for (let i = open; i < fnSql.length; i++) {
    if (fnSql[i] === '(') depth++;
    else if (fnSql[i] === ')') {
      depth--;
      if (depth === 0) return fnSql.slice(open + 1, i).trim();
    }
  }
  throw new Error(`unbalanced parens for anchor: ${anchor}`);
}

