/**
 * Guardián: toda cadena `supabase.from(<tabla con owner_ref>)` cuyo verbo sea
 * `select`, `update` o `delete` lleva un filtro por `owner_ref` en la misma
 * cadena, o tiene una entrada escrita a mano en
 * `test/ownership-filter-guard.exceptions.ts` que dice por qué no.
 *
 * ⚠️ EL BUG QUE ESTE TEST EXISTE PARA CAZAR (medido, WKH-SEC-03).
 * El cliente de Supabase usa `SUPABASE_SERVICE_KEY`, que BYPASSEA RLS: los
 * `.eq('owner_ref', …)` de la capa de aplicación son la única barrera entre
 * inquilinos. Había 23 de esos filtros que NINGÚN test miraba. Reproducido
 * antes de escribir esto: borrando `src/services/receipt.ts:293` la suite
 * completa quedaba en `5294 passed | 19 skipped`, cero rojos — o sea, idéntica.
 *
 * POR QUÉ UN GUARDIÁN ADEMÁS DE LOS TESTS DE PROPIEDAD. Los `*.ownership.test.ts`
 * cubren 11 sitios, de a uno. El guardián cubre la CLASE: la cadena número 102
 * que alguien escriba sin filtro se pone roja el día que se escribe, en vez de
 * la próxima vez que un adversario se ponga a leer los services de a uno. Se
 * hacen las DOS cosas a propósito, y ninguna reemplaza a la otra.
 *
 * CÓMO DECIDE. No tiene una lista de tablas: las DERIVA de
 * `src/types/database.types.ts` en cada corrida (hoy: 62 tablas, 21 con
 * `owner_ref`). Una lista a mano es lo que ya envejeció en `CLAUDE.md`, que
 * enumera 4. Si no puede resolver el argumento de un `.from()`, NO adivina: esa
 * cadena entra a una lista que pone este test en ROJO.
 *
 * NACE VERDE CON 41 EXCEPCIONES, y eso es a propósito: son la fotografía honesta
 * del árbol hoy, cada una con su motivo leído del código y desarrollado en
 * `doc/sdd/220-wkh-sec-03-owner-ref-sin-cobertura/censo-owner-ref.md`. Un
 * guardián que nace rojo se termina exceptuando entero.
 *
 * ── QUÉ NO CUBRE (declarado, no arreglado — medir antes de creerle a esta lista) ──
 *
 *  1. EL VALOR que se le pasa al filtro. `.eq('owner_ref', otroOwner)` pasa este
 *     guardián sin chistar: se verifica presencia textual, no semántica. Lo que
 *     caza un valor equivocado son los tests de propiedad
 *     (`src/services/*.ownership.test.ts`), no esto.
 *  2. Las cadenas partidas en una variable (`let q = supabase.from(...)` y más
 *     abajo `q = q.eq(...)`). El escáner ve el `.from(` y no ve el `.eq()` que
 *     llega en otra sentencia. Medido en `ef384b7`: el único sitio así sobre una
 *     tabla con dueño es `src/services/task.ts:124`, y NO da falso positivo
 *     porque su `.eq('owner_ref', …)` está en `:126`, antes de la partición. La
 *     población de esta clase hoy es 0; el modo de falla, si aparece, apunta al
 *     lado ruidoso (falso positivo que se resuelve escribiendo una excepción),
 *     no al silencioso.
 *  3. `insert` / `upsert` (14 sitios) están fuera del alcance. Un INSERT no
 *     filtra, estampa. La regla alternativa ("que `owner_ref` aparezca en el
 *     payload") daría 9 rojos falsos, porque en 9 de los 14 el payload es una
 *     variable armada antes. El estampado se prueba con el patrón de
 *     `src/services/task.ownership.test.ts:323-331`.
 *  4. Que la fila TENGA dueño. `kite_schema_transforms.owner_ref` es
 *     `string | null` (`src/types/database.types.ts:2303`): una fila con NULL no
 *     matchea `.eq('owner_ref', X)` para ningún X, así que queda invisible para
 *     todos. Eso no es un IDOR, es un miss permanente, y este guardián no opina.
 *  5. Los filtros que no son `.eq` / `.in` / `.match` sobre `owner_ref` (`.or`,
 *     `.filter`). Caen en la lista de excepciones con su motivo.
 *  6. Que la tabla exista de verdad en la base. El conjunto sale del archivo de
 *     tipos GENERADO; si está desactualizado respecto de la base, el guardián
 *     hereda ese desfase sin avisar.
 *  7. RLS. No la mide ni la reemplaza: es WKH-SEC-02 (`CLAUDE.md:207-215`). Y
 *     mientras el cliente use `SUPABASE_SERVICE_KEY` (BYPASSRLS), RLS no vuelve
 *     redundante ningún filtro de aplicación.
 *  8. (Del estado del corte, no del instrumento.) Entre el merge de WKH-SEC-03 y
 *     el de WKH-SEC-04 este guardián está verde con 12 sitios que no tienen test
 *     de propiedad: `fee-split` ×4, `arbiter` ×3, `evidence` ×3,
 *     `reconciliation` ×1, `debit-capture` ×1. Para esos 12, lo que se sabe es
 *     que el filtro está escrito. Que funcione no lo midió nadie todavía.
 *
 * Naming: G-01..G-10.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  OWNERSHIP_FILTER_EXCEPTIONS,
  OWNER_FILTER_CATEGORIES,
} from './ownership-filter-guard.exceptions.js';
import {
  type Chain,
  GUARDED_VERBS,
  deriveOwnerTables,
  deriveTables,
  scanSource,
} from './ownership-filter-guard.scanner.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/** Contra el ÍNDICE de git, no contra el disco: es lo que `checkout` trae. */
function trackedSourceFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', 'src'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => !f.endsWith('.test.ts'))
    .filter((f) => !f.includes('/__tests__/'));
}

const typesSrc = readFileSync(
  join(REPO_ROOT, 'src/types/database.types.ts'),
  'utf8',
);
const { all: ALL_TABLES, withOwner: OWNER_TABLES } = deriveTables(typesSrc);

const SOURCE_FILES = trackedSourceFiles();
const CHAINS: Chain[] = SOURCE_FILES.flatMap((file) =>
  scanSource(readFileSync(join(REPO_ROOT, file), 'utf8'), OWNER_TABLES, file),
);

const UNRESOLVED = CHAINS.filter((c) => c.table === null);
const RESOLVED = CHAINS.filter((c) => c.table !== null);
const IN_SCOPE = RESOLVED.filter((c) => GUARDED_VERBS.has(c.verb));
const UNFILTERED = IN_SCOPE.filter((c) => !c.ownerFiltered);

const key = (file: string, line: number): string => `${file}:${line}`;
const EXCEPTED = new Set(
  OWNERSHIP_FILTER_EXCEPTIONS.map((e) => key(e.file, e.line)),
);

describe('ownership filter guard — cadenas sobre tablas con owner_ref', () => {
  // ══════════════════════════════════════════════════════════════
  // CONTROL DE ARMADO (G-01, G-02)
  // Sin estos dos, un parser roto deja las listas vacías y G-08 pasa en verde
  // sin verificar nada: la falla silenciosa de siempre, adentro del guardián
  // que existe para cazar una falla silenciosa.
  // ══════════════════════════════════════════════════════════════

  it('G-01: el conjunto de tablas con dueño se derivó de verdad del archivo de tipos', () => {
    // Input que lo pone en rojo: romper el parser de `database.types.ts` para
    // que devuelva ∅. Sin este control, con ∅ tablas el guardián no encontraría
    // NINGUNA cadena y pasaría afirmando cobertura total.
    expect(ALL_TABLES.size).toBeGreaterThanOrEqual(50);
    expect(OWNER_TABLES.size).toBeGreaterThanOrEqual(15);
    expect(OWNER_TABLES.has('a2a_receipts')).toBe(true);
    expect(OWNER_TABLES.has('tasks')).toBe(true);
    // `kite_schema_transforms` es la única con `owner_ref: string | null`; que
    // entre confirma que el criterio es "la columna existe", no "es NOT NULL".
    expect(OWNER_TABLES.has('kite_schema_transforms')).toBe(true);
    // Y no es que se cuele cualquier cosa: hay tablas sin dueño y quedan fuera.
    expect(OWNER_TABLES.size).toBeLessThan(ALL_TABLES.size);
    expect(OWNER_TABLES.has('a2a_events')).toBe(false);
    expect(OWNER_TABLES.has('a2a_protocol_fees')).toBe(false);
  });

  it('G-02: el barrido del árbol encontró cadenas y pudo resolver TODOS los `.from()`', () => {
    // Input que lo pone en rojo: un regex que matchee de menos.
    expect(SOURCE_FILES.length).toBeGreaterThan(150);
    expect(RESOLVED.length).toBeGreaterThanOrEqual(90);
    expect(IN_SCOPE.length).toBeGreaterThanOrEqual(60);
    // "No sé qué tabla es esta" es indistinguible de "es una tabla con dueño que
    // no estoy mirando". Si esta lista crece, alguien introdujo una forma nueva
    // de nombrar la tabla y hay que mirarla, no adivinarla.
    expect(
      UNRESOLVED.map((c) => `${key(c.file, c.line)} → .from(${c.rawArg})`),
      'Hay `supabase.from(...)` cuyo argumento este guardián NO pudo resolver a un\n' +
        'nombre de tabla. Mientras no se resuelva, no se puede afirmar que esa cadena\n' +
        'esté fuera de alcance.\n' +
        'Arreglo: usar un literal, o una `const` de módulo con valor literal.\n',
    ).toEqual([]);
  });

  // ══════════════════════════════════════════════════════════════
  // EL ESCÁNER NO ES VACUO (G-03..G-07)
  // Fixtures en memoria con la respuesta conocida de antemano. Sin ellos, el
  // único test del escáner sería "lo que el escáner encuentra hoy", que es un
  // instrumento comparándose contra su propia salida.
  // ══════════════════════════════════════════════════════════════

  const TABLES = new Set(['a2a_receipts']);
  const scan = (src: string): Chain[] => scanSource(src, TABLES, 'fixture.ts');
  const unfiltered = (src: string): Chain[] =>
    scan(src).filter((c) => GUARDED_VERBS.has(c.verb) && !c.ownerFiltered);

  it('G-03: una cadena CON el filtro no se reporta', () => {
    // Input que lo pone en rojo: un escáner que reporte siempre.
    const src = [
      'const { data } = await supabase',
      "  .from('a2a_receipts')",
      "  .select('*')",
      "  .eq('id', id)",
      "  .eq('owner_ref', ownerRef)",
      '  .single();',
    ].join('\n');
    expect(scan(src)).toHaveLength(1);
    expect(unfiltered(src)).toEqual([]);
  });

  it('G-04: una cadena SIN el filtro se reporta, con su número de línea', () => {
    // Input que lo pone en rojo: un escáner que no reporte nunca.
    const src = [
      '// arriba hay un comentario para correr las líneas',
      'const { data } = await supabase',
      "  .from('a2a_receipts')",
      "  .select('*')",
      "  .eq('id', id)",
      '  .single();',
    ].join('\n');
    const found = unfiltered(src);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(3);
    expect(found[0]?.table).toBe('a2a_receipts');
    expect(found[0]?.verb).toBe('select');
  });

  it('G-05: `.from(CONST)` con una `const` de módulo se resuelve', () => {
    // Input que lo pone en rojo: volver a exigir literales. `fee-split.ts:37` es
    // `const SPLITS_TABLE = 'a2a_fee_splits'` y sus cadenas escriben
    // `.from(SPLITS_TABLE)`: un escáner que sólo acepte literales deja fuera al
    // archivo con más sitios del hallazgo y no se entera.
    const src = [
      "const RECEIPTS_TABLE = 'a2a_receipts';",
      'const { data } = await supabase',
      '  .from(RECEIPTS_TABLE)',
      "  .select('*')",
      "  .eq('id', id);",
    ].join('\n');
    const found = unfiltered(src);
    expect(found).toHaveLength(1);
    expect(found[0]?.table).toBe('a2a_receipts');
    // Y una `const` que apunta a una tabla SIN dueño se resuelve para EXCLUIRLA
    // bien, que es el otro uso de resolver constantes.
    const otra = [
      "const FEES_TABLE = 'a2a_protocol_fees';",
      "const x = await supabase.from(FEES_TABLE).select('*').eq('id', id);",
    ].join('\n');
    expect(scan(otra)).toEqual([]);
  });

  it('G-06: se filtra por RECEPTOR — `Buffer.from` no es una cadena de supabase', () => {
    // Input que lo pone en rojo: quitar el filtro de receptor. Sin él, los
    // `Buffer.from` / `Array.from` / `Uint8Array.from` / `Transaction.from` del
    // árbol entran como "no pude resolver el argumento" y el guardián se vuelve
    // inservible por ruido.
    expect(scan("const b = Buffer.from('a2a_receipts');")).toEqual([]);
    expect(scan("const a = Array.from('a2a_receipts');")).toEqual([]);
    expect(scan("const t = Transaction.from('a2a_receipts');")).toEqual([]);
    // Y el receptor correcto sí entra, para que esto no pase por matchear nada.
    expect(scan("await supabase.from('a2a_receipts').select('*');")).toHaveLength(1);
  });

  it('G-07: el nombre de la columna se compara EXACTO — `ownerRef` no cuenta', () => {
    // Input que lo pone en rojo: comparar el nombre de forma laxa. Un
    // `.eq('ownerRef', …)` en camelCase es indistinguible de "no matcheó nada"
    // para cualquier mock que ignore los argumentos, y deja al dueño sin ver sus
    // propias filas.
    const camel = [
      'const { data } = await supabase',
      "  .from('a2a_receipts')",
      "  .select('*')",
      "  .eq('ownerRef', ownerRef)",
      '  .single();',
    ].join('\n');
    expect(unfiltered(camel)).toHaveLength(1);
    // Las tres formas que SÍ acotan, para que el reconocimiento no sea vacuo.
    for (const filter of [
      ".eq('owner_ref', ownerRef)",
      ".in('owner_ref', owners)",
      '.match({ owner_ref: ownerRef })',
    ]) {
      const src = [
        'const { data } = await supabase',
        "  .from('a2a_receipts')",
        "  .select('*')",
        `  ${filter}`,
        '  .single();',
      ].join('\n');
      expect(unfiltered(src), `${filter} debería contar como acotado`).toEqual(
        [],
      );
    }
    // Y una columna que sólo CONTIENE el nombre tampoco cuenta.
    const parecida = [
      'const { data } = await supabase',
      "  .from('a2a_receipts')",
      "  .select('*')",
      "  .eq('prev_owner_ref', ownerRef)",
      '  .single();',
    ].join('\n');
    expect(unfiltered(parecida)).toHaveLength(1);
  });

  // ══════════════════════════════════════════════════════════════
  // EL TEST ★ (G-08) Y LA HIGIENE DE LA LISTA (G-09, G-10)
  // ══════════════════════════════════════════════════════════════

  it('★ G-08: ninguna cadena `select`/`update`/`delete` queda sin filtro y sin excepción', () => {
    // Input que lo pone en rojo: agregar a cualquier service
    //   supabase.from('a2a_receipts').select('*').eq('id', id).single()
    const orphans = UNFILTERED.filter((c) => !EXCEPTED.has(key(c.file, c.line)));
    expect(
      orphans.map((c) => `${key(c.file, c.line)} · ${c.table} · ${c.verb}`),
      `Hay ${orphans.length} cadena(s) sobre una tabla con \`owner_ref\` que no acotan por\n` +
        'dueño y no tienen motivo escrito. El cliente de Supabase usa\n' +
        '`SUPABASE_SERVICE_KEY`, que BYPASSEA RLS: sin ese filtro, cualquier caller\n' +
        'autenticado alcanza las filas de otro owner.\n' +
        'Arreglo: agregarle `.eq(\'owner_ref\', <owner del caller>)` a la cadena, o pasar\n' +
        'el `ownerRef` hasta el service si todavía no llega — NO exceptuarlas acá.\n' +
        'Si de verdad no corresponde filtrar (lectura de admin, barrido de cron, catálogo\n' +
        'compartido), recién ahí va una entrada en\n' +
        '`test/ownership-filter-guard.exceptions.ts` con el motivo de ESE sitio.\n' +
        `Hallazgos:\n${orphans.map((c) => `  ${key(c.file, c.line)} · ${c.table} · ${c.verb}`).join('\n')}\n`,
    ).toEqual([]);
  });

  it('G-09: ninguna excepción sobrevive a su sitio', () => {
    // Input que lo pone en rojo: borrar una consulta del árbol y dejar su
    // excepción. Sin esto, la lista se pudre y el guardián va perdiendo alcance
    // sin avisar: cada excepción muerta es un permiso que ya nadie revisa.
    const live = new Set(UNFILTERED.map((c) => key(c.file, c.line)));
    const stale = OWNERSHIP_FILTER_EXCEPTIONS.filter(
      (e) => !live.has(key(e.file, e.line)),
    );
    expect(
      stale.map((e) => `${key(e.file, e.line)} · ${e.category}`),
      'Hay excepciones cuyo sitio ya no es una cadena sin filtro de dueño: o la\n' +
        'consulta se movió de línea, o desapareció, o alguien le puso el filtro.\n' +
        'Arreglo: borrar la entrada (si el sitio se arregló) o actualizar su línea.\n',
    ).toEqual([]);
    // Control de armado de este mismo test: si la lista quedara vacía, lo de
    // arriba pasaría sin verificar nada.
    expect(OWNERSHIP_FILTER_EXCEPTIONS.length).toBeGreaterThanOrEqual(35);
    expect(UNFILTERED.length).toBe(OWNERSHIP_FILTER_EXCEPTIONS.length);
  });

  it('G-10: toda excepción tiene categoría de la unión cerrada y motivo no vacío', () => {
    // Validado en RUNTIME, no por tipo, y la diferencia importa: medido, CI no
    // typechequea `test/` (`tsconfig.json:19` incluye sólo `src/**/*`) ni lo
    // lintea (`package.json:11` es `biome check src/`). Un
    // `category: 'inventada'` compila en el editor, no rompe CI y entra al repo.
    const categories = new Set<string>(OWNER_FILTER_CATEGORIES);
    const bad = OWNERSHIP_FILTER_EXCEPTIONS.filter(
      (e) =>
        !categories.has(e.category) ||
        typeof e.reason !== 'string' ||
        e.reason.trim().length < 40,
    );
    expect(
      bad.map((e) => `${key(e.file, e.line)} · category=${e.category}`),
      'Hay excepciones con una categoría fuera de la unión cerrada, o con un motivo\n' +
        'vacío o demasiado corto para decir algo. El motivo tiene que explicar por qué\n' +
        `ESE sitio no necesita el filtro.\nCategorías válidas: ${[...categories].join(', ')}\n`,
    ).toEqual([]);
    // Un motivo genérico repetido en 41 entradas es el fracaso de este archivo
    // aunque todo esté en verde: si dos sitios comparten motivo palabra por
    // palabra, uno de los dos no se leyó.
    const reasons = OWNERSHIP_FILTER_EXCEPTIONS.map((e) => e.reason.trim());
    expect(new Set(reasons).size).toBe(reasons.length);
    // Y las líneas son plausibles (una excepción con `line: 0` no apunta a nada).
    expect(
      OWNERSHIP_FILTER_EXCEPTIONS.filter((e) => !Number.isInteger(e.line) || e.line < 1),
    ).toEqual([]);
  });
});
