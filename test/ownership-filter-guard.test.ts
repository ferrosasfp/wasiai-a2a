/**
 * Guardián: toda cadena `supabase.from(<tabla con owner_ref>)` cuyo verbo sea
 * `select`, `update` o `delete` lleva un filtro por `owner_ref` en la misma
 * cadena, o tiene una entrada escrita a mano en
 * `test/ownership-filter-guard.exceptions.ts` que dice por qué no.
 *
 * ⚠️ EL BUG QUE ESTE TEST EXISTE PARA CAZAR (medido, WKH-SEC-03).
 * El cliente de Supabase usa `SUPABASE_SERVICE_KEY`, que BYPASSEA RLS: los
 * `.eq('owner_ref', …)` de la capa de aplicación son la única barrera entre
 * inquilinos. El censo abrió con 23 de esos filtros como candidatos a "no los
 * mira nadie". **De esos 23 se mutaron uno por uno los 11 de este corte; los
 * otros 12 son de WKH-SEC-04 y acá NO se mutaron.** Separar lo medido de lo
 * heredado es el punto de este párrafo, y la lista de abajo dice cuál es cuál.
 *
 *  · MEDIDO ACÁ — 11 sitios, campaña completa en
 *    `doc/sdd/220-wkh-sec-03-owner-ref-sin-cobertura/mutation-log.md:70-87`, una
 *    fila por mutante con su conteo crudo. De los 11, **8 no los miraba ningún
 *    test preexistente** (el único rojo de cada uno de esos 8 mutantes está
 *    dentro del archivo de test NUEVO del sitio, más el colateral G-08/G-09) y
 *    **3 sí**: `spend-policy.ts:163`, `:190` y `:219` ya tenían un espía de
 *    llamada en `src/services/spend-policy.test.ts` (`:292`, `:311`, `:344`), y
 *    borrando `:163` ese archivo solo da `1 failed | 17 passed (18)`. De los 8,
 *    el único con su salida completa pegada es `src/services/receipt.ts:293`:
 *    borrándolo en `ef384b7` la suite entera daba `5294 passed | 19 skipped
 *    (5313)`, el baseline exacto, cero rojos (`sdd.md:146-147`).
 *  · HEREDADO, NO RE-MEDIDO — los 12 sitios de WKH-SEC-04, declarados «fuera del
 *    corte, sin mutar» en `mutation-log.md:212`. Su única evidencia sigue siendo
 *    el barrido de A1, que no se re-corrió acá y cuya línea base este mismo SDD
 *    declara equivocada y corrige (`sdd.md:494-497`, CD-8: «un mutante comparado
 *    contra la baseline equivocada se clasifica al revés»). Sobre esos 12 esta
 *    HU no midió nada.
 *
 * POR QUÉ UN GUARDIÁN ADEMÁS DE LOS TESTS DE PROPIEDAD. Los `*.ownership.test.ts`
 * cubren 11 sitios, de a uno. El guardián cubre la CLASE: la cadena número 102
 * que alguien escriba sin filtro se pone roja el día que se escribe, en vez de
 * la próxima vez que un adversario se ponga a leer los services de a uno. Se
 * hacen las DOS cosas a propósito, y ninguna reemplaza a la otra.
 *
 * CÓMO DECIDE. No tiene una lista de tablas: las DERIVA de
 * `src/types/database.types.ts` en cada corrida (hoy: 62 tablas, 21 con
 * `owner_ref`). Una lista a mano es lo que ya envejeció una vez: `CLAUDE.md`
 * enumeraba 4 tablas, y de esas 4 decía que `registries` no tenía columna de
 * dueño, teniéndola (`database.types.ts:2567`). Esa sección ahora declara el
 * criterio y apunta a este archivo. Si no puede resolver el argumento de un
 * `.from()`, NO adivina: esa cadena entra a una lista que pone este test en ROJO.
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
 *  7. RLS. No la mide ni la reemplaza: es WKH-SEC-02 (`CLAUDE.md:247-255`). Y
 *     mientras el cliente use `SUPABASE_SERVICE_KEY` (BYPASSRLS), RLS no vuelve
 *     redundante ningún filtro de aplicación.
 *  8. (Del estado del corte, no del instrumento.) Entre el merge de WKH-SEC-03 y
 *     el de WKH-SEC-04 este guardián está verde con 12 sitios que no tienen test
 *     de propiedad: `fee-split` ×4, `arbiter` ×3, `evidence` ×3,
 *     `reconciliation` ×1, `debit-capture` ×1. Para esos 12, lo que se sabe es
 *     que el filtro está escrito. Que funcione no lo midió nadie todavía.
 *  9. `supabase.rpc(...)` — el universo del escáner es `supabase.from(`, así que
 *     los RPC quedan ENTEROS afuera. Medido hoy sobre `src/` no-test:
 *     **42 call-sites en 13 archivos**, entre ellos `budget.ts`,
 *     `payment-intent.ts`, `arbiter.ts`, `reconciliation.ts`, `refund-outbox.ts`
 *     y `adapters/escrow/debit-*.ts`, o sea el camino del dinero. El acotamiento
 *     por dueño de un RPC vive dentro de la función SQL, que este archivo no
 *     lee. **Este guardián no dice NADA sobre esos 42.** Tampoco entran las
 *     tablas cuyo dueño es TRANSITIVO por clave foránea y que no declaran
 *     `owner_ref` propia: `a2a_solana_settle_intents` queda fuera del conjunto
 *     derivado por definición, y tiene 2 cadenas — `settle-ledger.ts:552`
 *     (`readSettleIntent`, acota por `intent_id`) y `:603` (`probeSettleLedger`,
 *     un `select('intent_id').limit(1)` de esquema que no lee datos).
 *     No se encontró ningún IDOR vivo en ninguna de las dos clases —
 *     `readSettleIntent` tiene UN solo llamador de producción, `payment.ts:372`,
 *     interno — pero eso es una lectura de código de esta HU, no una medición
 *     de este guardián.
 *     Ampliar el alcance a los RPC es OTRA HU; declararlo es de ésta.
 * 10. UN ARCHIVO QUE TODAVÍA NO ESTÁ EN EL ÍNDICE DE GIT. El universo sale de
 *     `git ls-files src` (`:140-142`), a propósito: es lo que un `checkout`
 *     trae. La consecuencia es que un archivo nuevo **sin `git add`** es
 *     invisible para el guardián. Medido: un `src/services/__mnr4-probe.ts`
 *     recién creado con `supabase.from('a2a_receipts').select('*').eq('id', id)`
 *     da `13 passed (13)`; con un `git add -N` encima, los mismos tests dan
 *     `2 failed | 11 passed (13)` nombrando `src/services/__mnr4-probe.ts:3 ·
 *     a2a_receipts · select`. **No es un agujero de CI** —en CI el archivo llegó
 *     por un commit, así que está en el índice— sino de la vuelta local: mientras
 *     escribís el service, el verde que ves no habla de tu archivo. Se cierra
 *     solo al hacer `git add`, y eso pasa antes de cualquier revisión.
 *
 * Naming: G-01..G-13.
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

/**
 * SEGUNDO LECTOR del MISMO archivo de tipos, escrito a propósito con otro
 * algoritmo que `deriveTables`. Vive acá y no en el escáner: es el oráculo
 * contra el que G-11/G-12 cruzan al escáner, y meterlo en el módulo que vigila
 * lo volvería un instrumento comparándose contra su propia salida.
 *
 * La diferencia que importa: `deriveTables` es una máquina de estados que
 * exige `owner_ref` DENTRO del bloque `Row:` y con 10 espacios exactos de
 * indentación; esto parte el archivo en bloques por tabla y le pregunta a cada
 * bloque entero si la cadena `owner_ref` aparece. Son dos caminos distintos
 * hasta la misma respuesta.
 *
 * ⚠️ LO QUE ESTE CRUCE NO CAZA, y decirlo es la mitad de su valor: los dos
 * lectores comparten UNA suposición — que dentro de `Tables:` cada tabla abre
 * con `^ {6}<identificador>: {`. Un cambio del archivo generado que rompa esa
 * suposición rompe a los DOS a la vez y el cruce sigue en verde. **Y el agujero
 * no es sólo un cambio global de formato: es también el JUEGO DE CARACTERES del
 * nombre.** Medido sobre `16847c3`: quotear UNA sola clave
 * (`a2a_key_spend_policies:` → `"a2a_key_spend_policies":`), sin tocar la
 * indentación, dejaba los 12 controles en verde, y con eso puesto una cadena
 * real sin filtro sobre esa tabla también daba `12 passed (12)` — el control con
 * los tipos sanos daba `2 failed | 10 passed`. Esa es la forma que
 * `supabase gen types` emite para cualquier nombre que no sea identificador JS,
 * y ciega UNA TABLA POR VEZ, donde los pisos de G-01 (`>= 50` sobre 62 reales,
 * `>= 15` sobre 21) tienen holgura de sobra y no disparan.
 *
 * Lo que cierra ese agujero es **G-13**, y por eso no alcanza con el piso.
 */
function tableBlocks(src: string): Map<string, string> {
  const blocks = new Map<string, string>();
  let inTables = false;
  let current: string | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (current !== null) blocks.set(current, body.join('\n'));
    current = null;
    body = [];
  };
  for (const line of src.split('\n')) {
    const top = /^ {4}([A-Za-z_$][\w$]*)\s*:\s*\{\s*$/.exec(line);
    if (top !== null) {
      flush();
      inTables = top[1] === 'Tables';
      continue;
    }
    if (!inTables) continue;
    const entry = /^ {6}([A-Za-z_$][\w$]*)\s*:\s*\{\s*$/.exec(line);
    if (entry !== null) {
      flush();
      current = entry[1] as string;
      continue;
    }
    if (current !== null) body.push(line);
  }
  flush();
  return blocks;
}

/**
 * TERCER lector, y no busca tablas: busca **lo que los otros dos descartaron sin
 * mirar**. Los dos anteriores tienen la misma forma —"si la línea matchea la
 * cabecera, es una tabla; si no, sigo"—, así que una cabecera con otra sintaxis
 * no es un error para ninguno: simplemente no existe. Esto invierte la pregunta
 * y clasifica TODAS las líneas a 6 espacios de adentro de `Tables:` en tres
 * cajas conocidas, para que la cuarta caja —la que no se esperaba— sea el
 * hallazgo de G-13.
 *
 * Las tres cajas, verificadas contra el archivo de hoy: 62 cabeceras, 62 cierres
 * `};` y 1 apertura de comentario (`/**` en `database.types.ts:1054`, el
 * `COMMENT ON TABLE` de `a2a_solana_settle_intents`). Total 125, que es cuanto
 * hay. El cuerpo del comentario va a 7 espacios y no entra acá.
 */
function lineasA6Espacios(src: string): {
  cabeceras: string[];
  cierres: string[];
  comentarios: string[];
  desconocidas: string[];
} {
  const cabeceras: string[] = [];
  const cierres: string[] = [];
  const comentarios: string[] = [];
  const desconocidas: string[] = [];
  let inTables = false;
  let lineno = 0;
  for (const line of src.split('\n')) {
    lineno += 1;
    const top = /^ {4}([A-Za-z_$][\w$]*)\s*:\s*\{\s*$/.exec(line);
    if (top !== null) {
      inTables = top[1] === 'Tables';
      continue;
    }
    if (!inTables) continue;
    if (!/^ {6}\S/.test(line)) continue;
    const donde = `database.types.ts:${lineno} → ${line.trim()}`;
    if (/^ {6}[A-Za-z_$][\w$]*\s*:\s*\{\s*$/.test(line)) cabeceras.push(donde);
    else if (/^ {6}\}[;,]?\s*$/.test(line)) cierres.push(donde);
    else if (/^ {6}(\/\*|\/\/)/.test(line)) comentarios.push(donde);
    else desconocidas.push(donde);
  }
  return { cabeceras, cierres, comentarios, desconocidas };
}

const SEIS_ESPACIOS = lineasA6Espacios(typesSrc);

const ORACLE_BLOCKS = tableBlocks(typesSrc);
const ORACLE_OWNER = new Set(
  [...ORACLE_BLOCKS.entries()]
    .filter(([, body]) => /\bowner_ref\b/.test(body))
    .map(([table]) => table),
);

const SOURCE_FILES = trackedSourceFiles();
const CHAINS: Chain[] = SOURCE_FILES.flatMap((file) =>
  scanSource(readFileSync(join(REPO_ROOT, file), 'utf8'), OWNER_TABLES, file),
);

/**
 * El MISMO barrido, pero con el universo COMPLETO de tablas del oráculo en vez
 * del conjunto derivado por el escáner. Es lo que hace visible una derivación
 * que se degradó PARCIALMENTE: las cadenas sobre las tablas que se cayeron del
 * conjunto desaparecen de `CHAINS` sin dejar rastro, y siguen acá.
 */
const CHAINS_UNIVERSO: Chain[] = SOURCE_FILES.flatMap((file) =>
  scanSource(
    readFileSync(join(REPO_ROOT, file), 'utf8'),
    new Set(ORACLE_BLOCKS.keys()),
    file,
  ),
);
/** Las tablas que el árbol nombra de verdad en un `supabase.from(...)`. */
const TABLAS_TOCADAS = new Set(
  CHAINS_UNIVERSO.map((c) => c.table).filter(
    (t): t is string => t !== null,
  ),
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
  // CONTROL DE ARMADO (G-01, G-02, G-11, G-12, G-13)
  // Sin estos, un parser roto deja las listas vacías y G-08 pasa en verde
  // sin verificar nada: la falla silenciosa de siempre, adentro del guardián
  // que existe para cazar una falla silenciosa.
  //
  // G-01 y G-02 son PISOS, y un piso sólo protege contra el conjunto VACÍO.
  // Contra el conjunto SESGADO —una derivación que casi funciona y se come
  // cuatro tablas— tienen holgura de sobra: medido, sacando del conjunto
  // `a2a_arbiter_nonces`, `a2a_inbound_tasks`, `a2a_key_spend_policies` y
  // `a2a_payment_vouchers` (cuatro tablas cuyas cadenas están TODAS filtradas
  // hoy, así que el conteo de `UNFILTERED` ni se mueve) los diez tests quedaban
  // verdes, y con el sesgo puesto se podía agregar una cadena real sin filtro
  // sobre `a2a_key_spend_policies` y seguían verdes los diez. G-11 y G-12 son
  // la respuesta a ESO, y no son números: son invariantes de consistencia.
  //
  // Y G-11/G-12 tampoco alcanzaban solos, porque los dos lectores que cruzan
  // comparten la forma de la cabecera: quotear UNA clave del archivo de tipos
  // dejaba los DOCE en verde y una cadena sin filtro sobre esa tabla invisible
  // (medido sobre `16847c3`, ver `mutation-log.md` §M-G9). G-13 es la respuesta
  // a ESO, y ataca por el otro lado: en vez de buscar tablas, exige que no
  // sobre NINGUNA línea sin clasificar.
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

  it('G-11: los DOS lectores del archivo de tipos dan el mismo conjunto de tablas con dueño', () => {
    // Input que lo pone en rojo: cualquier cambio en `deriveTables` que agregue
    // o saque una tabla del conjunto sin que el archivo de tipos haya cambiado
    // — incluido el sesgo de una lista negra de nombres. No es un número: si
    // una migración agrega una tabla con `owner_ref`, los dos lectores se
    // mueven juntos y esto sigue verde sin tocar nada.
    const soloEscaner = [...OWNER_TABLES].filter((t) => !ORACLE_OWNER.has(t));
    const soloOraculo = [...ORACLE_OWNER].filter((t) => !OWNER_TABLES.has(t));
    expect(
      { soloEscaner: soloEscaner.sort(), soloOraculo: soloOraculo.sort() },
      'Los dos lectores de `src/types/database.types.ts` dejaron de coincidir.\n' +
        '`soloOraculo` = tablas que declaran `owner_ref` y que `deriveTables` NO puso en\n' +
        'el conjunto: sus cadenas quedan INVISIBLES para G-08 sin que ningún conteo se\n' +
        'mueva. `soloEscaner` = lo simétrico.\n' +
        'Arreglo: mirar `deriveTables` en `test/ownership-filter-guard.scanner.ts`. Si el\n' +
        'que cambió es el FORMATO del archivo generado, hay que actualizar los dos\n' +
        'lectores, no silenciar éste.\n',
    ).toEqual({ soloEscaner: [], soloOraculo: [] });
    // Control de armado de este mismo test: dos conjuntos vacíos coinciden.
    expect(ORACLE_OWNER.size).toBeGreaterThanOrEqual(15);
    expect(ORACLE_BLOCKS.size).toBeGreaterThanOrEqual(50);
  });

  it('G-12: toda tabla con dueño que el árbol NOMBRA está dentro del universo del guardián', () => {
    // El invariante que faltaba, y la diferencia con G-01/G-02 es el modo de
    // falla que cubre: G-01 y G-02 son pisos con holgura, así que una
    // derivación que se coma unas pocas tablas los pasa. Esto no mira cuántas
    // son: mira que ninguna tabla que el código de verdad consulta se haya
    // caído del conjunto. Input que lo pone en rojo: sacar del conjunto
    // cualquier tabla que aparezca en un `supabase.from(...)` de `src/`.
    const invisibles = [...TABLAS_TOCADAS]
      .filter((t) => ORACLE_OWNER.has(t) && !OWNER_TABLES.has(t))
      .sort();
    expect(
      invisibles,
      'Hay tablas que declaran `owner_ref`, que `src/` consulta con\n' +
        '`supabase.from(...)`, y que quedaron FUERA del conjunto con el que este\n' +
        'guardián barre el árbol. Todas sus cadenas son invisibles para G-08: ni\n' +
        'aparecen como sin filtro ni como excepción, simplemente no existen para él, y\n' +
        'los conteos de G-01/G-02 no se enteran.\n' +
        'Arreglo: mirar `deriveTables` en `test/ownership-filter-guard.scanner.ts`.\n',
    ).toEqual([]);
    // Control de armado: si el barrido con el universo completo no encontrara
    // nada, la lista de arriba sería vacía por vacuidad. Hoy el árbol nombra
    // más tablas que las que tienen dueño, y las dos cosas tienen que ser
    // ciertas para que este test signifique algo.
    expect(CHAINS_UNIVERSO.length).toBeGreaterThan(CHAINS.length);
    expect(TABLAS_TOCADAS.size).toBeGreaterThanOrEqual(20);
    expect(
      [...TABLAS_TOCADAS].filter((t) => OWNER_TABLES.has(t)).length,
    ).toBeGreaterThanOrEqual(15);
  });

  it('G-13: ninguna cabecera de tabla del archivo de tipos quedó SIN PARSEAR', () => {
    // El agujero que G-11 y G-12 NO cierran, porque los dos lectores lo
    // comparten: una cabecera con otra sintaxis no es un error para ninguno de
    // los dos — no existe. Medido en `16847c3`, con los 12 controles anteriores:
    // quotear UNA clave (`a2a_key_spend_policies:` → `"a2a_key_spend_policies":`)
    // dejaba `12 passed (12)`, y con eso puesto una cadena real sin filtro sobre
    // esa tabla seguía dando `12 passed (12)`. Ciega una tabla POR VEZ, así que
    // los pisos de G-01 no disparan (holgura de 12 y de 6).
    //
    // Input que lo pone en rojo: cualquier línea a 6 espacios dentro de
    // `Tables:` que no sea una cabecera parseada, un cierre o un comentario.
    expect(
      SEIS_ESPACIOS.desconocidas,
      'Hay líneas a 6 espacios dentro de `Tables:` que NO son una cabecera de tabla\n' +
        'que este guardián sepa parsear, ni un cierre, ni un comentario. El caso típico\n' +
        'es una clave quoteada (`"mi-tabla": {`), que es lo que `supabase gen types`\n' +
        'emite para cualquier nombre que no sea identificador JS. Los DOS lectores de\n' +
        'G-11 la descartan igual, así que el cruce sigue verde y esa tabla queda\n' +
        'INVISIBLE para G-08: sus cadenas sin filtro no aparecen por ningún lado.\n' +
        'Arreglo: enseñarle la forma nueva a los tres lectores (`deriveTables` en\n' +
        '`test/ownership-filter-guard.scanner.ts`, `tableBlocks` y `lineasA6Espacios`\n' +
        'acá), NO agregar la excepción a esta lista.\n',
    ).toEqual([]);
    // Cada tabla abre y cierra: si una cabecera deja de parsear, su `};` sigue
    // ahí y este par se desbalancea. Es un invariante RELATIVO — una migración
    // que agregue una tabla mueve los dos lados juntos.
    expect(SEIS_ESPACIOS.cierres.length).toBe(SEIS_ESPACIOS.cabeceras.length);
    // Y la cabecera que este lector cuenta es la misma tabla que el oráculo de
    // G-11 puso en su mapa: sin esto, contar 62 y 62 no dice de QUÉ son.
    expect(SEIS_ESPACIOS.cabeceras.length).toBe(ORACLE_BLOCKS.size);
    // Control de armado: si el barrido no encontrara ninguna línea, las tres
    // listas serían vacías y lo de arriba pasaría por vacuidad.
    expect(SEIS_ESPACIOS.cabeceras.length).toBeGreaterThanOrEqual(50);
    expect(SEIS_ESPACIOS.comentarios.length).toBeGreaterThanOrEqual(1);
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
    // `table` y `verb` se cruzan contra la cadena REAL de ese sitio. Antes no:
    // la clave del match era sólo `archivo:línea`, así que una entrada podía
    // decir `table:'registries', verb:'delete'` sobre un `select` a
    // `a2a_receipts` y todo seguía verde. Un campo que nadie compara es un
    // campo que se copia de la entrada de arriba, y el motivo se lee a la luz
    // de esos dos campos.
    const chainAt = new Map(UNFILTERED.map((c) => [key(c.file, c.line), c]));
    const desalineadas = OWNERSHIP_FILTER_EXCEPTIONS.flatMap((e) => {
      const chain = chainAt.get(key(e.file, e.line));
      // La entrada sin cadena viva es el hallazgo de G-09, no de éste.
      if (chain === undefined) return [];
      if (e.table === chain.table && e.verb === chain.verb) return [];
      return [
        `${key(e.file, e.line)} · la entrada dice ${e.table}/${e.verb} · la cadena es ${chain.table}/${chain.verb}`,
      ];
    });
    expect(
      desalineadas,
      'Hay excepciones cuyos campos `table`/`verb` no describen la cadena que hay en\n' +
        'ese `archivo:línea`. O la entrada se copió de otra y no se corrigió, o la\n' +
        'consulta cambió debajo. En los dos casos el `reason` está justificando algo\n' +
        'distinto de lo que el código hace.\n' +
        'Arreglo: corregir `table`/`verb` y RELEER el motivo, que puede haber quedado\n' +
        'falso también.\n',
    ).toEqual([]);
  });
});
