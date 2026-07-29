/**
 * Guardián: un puntero desde CÓDIGO hacia un documento del repo tiene que resolver.
 *
 * ⚠️ EL BUG QUE ESTE TEST EXISTE PARA CAZAR (pasó de verdad, 2026-07-28).
 * Una limpieza sacó `CLAUDE.md` del repositorio. Dieciocho comentarios en
 * `src/services/identity.ts`, `src/routes/compose.ts`, `src/routes/gasless.ts`,
 * `src/lib/step0-refund.ts` y una migración SQL siguen diciendo "ver CLAUDE.md" para
 * explicar el Ownership Guard, que es la regla que impide el acceso cruzado entre dueños.
 * O sea: código de SEGURIDAD apuntando a su fuente de verdad, y la fuente no estaba.
 *
 * ES LA MISMA FAMILIA que un test importando un script inexistente (ver
 * `test/scripts-imported-by-tests-are-tracked.test.ts`), con una diferencia que la hace
 * PEOR: no revienta. Un import roto tira la suite; un puntero roto en un comentario
 * miente en silencio y sólo lo descubre quien va a buscar la regla y no la encuentra.
 *
 * Y no siempre es sólo prosa: `src/routes/agents.publish.test.ts` LEE
 * `doc/QUICKSTART-PUBLISH.md` con `readFileSync`. Ahí un puntero roto sí revienta, en CI,
 * exactamente como el `.mjs` gitignoreado.
 *
 * ── POR QUÉ EL ALCANCE ES EL QUE ES (medido, no supuesto) ───────────────────────────
 *
 * Un "todo token `.md` citado desde código tiene que existir" da ~20 falsos positivos el
 * primer día, y un guardián ruidoso se desactiva, que es peor que no tenerlo. Lo medido:
 *   · `rotation.schedule.mdays` ⟹ el regex se comía `rotation.schedule.md`. No era ni una
 *     referencia: era un acceso a propiedad. (Lo arregla el lookahead de abajo.)
 *   · `https://github.com/…/CHAIN-ADAPTIVE.md` ⟹ una URL, no una ruta del repo.
 *   · `doc/sdd/185-…/work-item.md` ⟹ rutas ELIDIDAS con `…` en prosa.
 *   · `MULTI-CHAIN.md`, `auto-blindaje.md`, `work-item.md`, `w0-audit.md` ⟹ nombres sueltos
 *     usados como abreviatura de un documento que SÍ existe, en otra carpeta.
 * Por eso se verifican sólo las referencias con FORMA DE RUTA, más una lista declarada de
 * documentos de raíz que el código cita por nombre pelado.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/**
 * Documentos de RAÍZ que el código cita por nombre pelado ("ver CLAUDE.md").
 *
 * ⚠️ ES UNA LISTA DECLARADA A PROPÓSITO, y no derivada de lo que hoy existe en el disco.
 * Derivarla sería la trampa de siempre: si el archivo desaparece, el nombre deja de
 * resolver, el chequeo lo saltea "porque no es un doc de raíz" y el guardián pasa en verde
 * justo cuando tenía que gritar. Una afirmación sobre el mundo se escribe; no se infiere
 * del mundo que quiere vigilar.
 */
const ROOT_DOCS_CITED_BARE = ['CLAUDE.md'] as const;

/**
 * Punteros que hoy NO resuelven y que NO se arreglan acá.
 *
 * Apuntan a documentación interna que la limpieza del 2026-07-28 sacó del repo y que fue
 * rescatada en un repositorio privado. A dónde tienen que apuntar ahora lo deciden el
 * founder y el coordinador, no este test. Están listados uno por uno —y no ignorados con
 * un patrón— para que el guardián siga protegiendo de punteros NUEVOS sin fingir que
 * éstos ya están sanos. La lista es DEUDA VISIBLE: si se encoge, mejor; si crece sin que
 * nadie lo decida, el test se pone rojo.
 */
const KNOWN_BROKEN_PENDING_DECISION = new Set<string>([
  'doc/sdd/spike-kite-passport/poc-results.md',
]);

/** Extensiones que consideramos CÓDIGO (lo que este guardián vigila). */
const CODE_EXT = ['.ts', '.tsx', '.mjs', '.cjs', '.js', '.sql', '.sh'];

/**
 * Token con pinta de ruta a un `.md`. El lookahead evita comerse `.mdays` (que apareció
 * de verdad y no era una referencia sino un acceso a propiedad).
 */
const MD_TOKEN_RE = /[A-Za-z0-9._/-]+\.md(?![A-Za-z0-9])/g;

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
}

/** Archivos de código trackeados. `doc/**` queda afuera: acá se vigila el CÓDIGO. */
function codeFiles(): string[] {
  return trackedFiles().filter(
    (f) => !f.startsWith('doc/') && CODE_EXT.some((e) => f.endsWith(e)),
  );
}

/**
 * Saca los `./` y `../` del principio, para que una referencia relativa quede como ruta
 * desde la raíz del repo.
 *
 * ⚠️ Sin ejemplo literal a propósito: este archivo es CÓDIGO y el guardián se escanea a sí
 * mismo, así que una ruta de muestra en la prosa se denuncia sola. Ya pasó: el ejemplo que
 * había acá puso el test en rojo en cuanto el archivo entró al índice — antes no, porque
 * `git ls-files` todavía no lo listaba y el guardián no se veía. Un verde que dependía de
 * no estar trackeado no era un verde.
 */
function stripRelativePrefix(token: string): string {
  return token.replace(/^(?:\.{1,2}\/)+/, '');
}

/**
 * Directorios de primer nivel REALES del repo, sacados de lo que git tiene trackeado.
 *
 * Existe por otro falso positivo medido: un comentario que enumera alternativas separadas
 * por barras (`README` / `.env.example` / `docs/networks.md`) se lee como UNA sola ruta
 * imposible. Exigir que el primer segmento sea un directorio que existe de verdad descarta
 * eso sin listar nada a mano: la regla sale de la estructura del repo, no de un allowlist
 * que hay que mantener.
 */
function topLevelDirs(): Set<string> {
  const dirs = new Set<string>();
  for (const f of trackedFiles()) {
    const i = f.indexOf('/');
    if (i > 0) dirs.add(f.slice(0, i));
  }
  return dirs;
}

const TOP_LEVEL_DIRS = topLevelDirs();

/**
 * ¿El token es una referencia a una ruta del repo que se pueda verificar?
 * Descarta URLs, rutas elididas, enumeraciones en prosa y nombres pelados (esos últimos
 * van por la lista declarada de documentos de raíz).
 */
function isVerifiablePathRef(token: string): boolean {
  if (token.includes('//')) return false; // URL
  if (token.includes('...')) return false; // ruta elidida en prosa
  const stripped = stripRelativePrefix(token);
  const first = stripped.slice(0, stripped.indexOf('/'));
  if (first === '') return false; // nombre pelado
  return TOP_LEVEL_DIRS.has(first);
}

export interface DocRef {
  sourceFile: string;
  docPath: string;
}

/** Todas las referencias con forma de ruta a un `.md`, desde archivos de código. */
export function pathShapedDocRefs(): DocRef[] {
  const out: DocRef[] = [];
  const seen = new Set<string>();
  for (const file of codeFiles()) {
    let source: string;
    try {
      source = readFileSync(join(REPO_ROOT, file), 'utf8');
    } catch {
      continue;
    }
    for (const token of source.match(MD_TOKEN_RE) ?? []) {
      if (!isVerifiablePathRef(token)) continue;
      const docPath = stripRelativePrefix(token);
      const key = `${file}::${docPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ sourceFile: file, docPath });
    }
  }
  return out;
}

/** `true` sii git tiene la ruta en el índice (lo que `checkout` materializa). */
function isTracked(repoRelativePath: string): boolean {
  const stdout = execFileSync('git', ['ls-files', '--', repoRelativePath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return stdout.trim().length > 0;
}

/** Existe para CI (índice) y también en una copia sin git (tarball): ninguno pasa mudo. */
function resolves(repoRelativePath: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return isTracked(repoRelativePath);
  } catch {
    return existsSync(join(REPO_ROOT, repoRelativePath));
  }
}

describe('documentos citados por el código', () => {
  it('el descubrimiento encuentra referencias (si no, el test de abajo es vacuo)', () => {
    const refs = pathShapedDocRefs();
    // Control de armado: un regex roto dejaría la lista vacía y el guardián pasaría sin
    // verificar nada — la falla silenciosa de siempre.
    expect(refs.length).toBeGreaterThanOrEqual(5);
    // El caso que además REVIENTA: este test lee el doc con readFileSync.
    expect(refs.map((r) => r.docPath)).toContain('doc/QUICKSTART-PUBLISH.md');
  });

  it('★ toda referencia con forma de ruta resuelve (salvo la deuda declarada)', () => {
    const broken = pathShapedDocRefs().filter(
      (r) => !KNOWN_BROKEN_PENDING_DECISION.has(r.docPath) && !resolves(r.docPath),
    );
    expect(
      broken,
      'Estos documentos los cita el código y NO están en el repo. Un puntero roto en un ' +
        'comentario no revienta: miente en silencio.\n' +
        broken.map((b) => `  ${b.docPath}  ← ${b.sourceFile}`).join('\n'),
    ).toEqual([]);
  });

  it('★ los documentos de raíz que el código cita por nombre siguen en el repo', () => {
    // ÉSTE es el que habría cazado la desaparición de CLAUDE.md el día que pasó.
    const missing = ROOT_DOCS_CITED_BARE.filter((d) => !resolves(d));
    expect(
      missing,
      'El código cita estos documentos de raíz por nombre y no están en el repo:\n' +
        missing.map((m) => `  ${m}`).join('\n'),
    ).toEqual([]);
  });

  it('la lista declarada NO está de adorno: el código realmente cita esos documentos', () => {
    // Si alguien borra las citas, la lista queda vieja y el test de arriba vigila un
    // archivo que ya nadie referencia. Esto lo detecta.
    const code = codeFiles()
      .map((f) => {
        try {
          return readFileSync(join(REPO_ROOT, f), 'utf8');
        } catch {
          return '';
        }
      })
      .join('\n');
    for (const doc of ROOT_DOCS_CITED_BARE) {
      expect(code, `${doc} ya no lo cita ningún archivo de código`).toContain(doc);
    }
  });
});
