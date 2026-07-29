/**
 * Guardián: todo script importado por un test tiene que estar TRACKEADO en git.
 *
 * ⚠️ EL BUG QUE ESTE TEST EXISTE PARA CAZAR (pasó de verdad, 2026-07-28).
 * Una limpieza sacó `scripts/verify-rls-enabled.mjs` del índice y lo agregó al
 * `.gitignore`, pero dejó `test/verify-rls-enabled.test.ts` importándolo. En el
 * disco del autor todo seguía verde: el archivo seguía ahí, sin trackear. En CI no:
 * `actions/checkout` NO materializa archivos ignorados, así que el módulo no
 * existía, la suite no colectaba y `npm test` salía con exit 1 en TODA rama y en
 * main. Un CI siempre rojo no da señal: el rojo nuevo es indistinguible del viejo.
 *
 * Por eso el chequeo es contra GIT y no contra el filesystem. `existsSync` habría
 * pasado en la máquina donde se rompió, que es exactamente donde no hay que confiar.
 *
 * Cubre los tres tests que hoy importan un `.mjs` de `scripts/`
 * (verify-rls-enabled, migrate-preflight, smoke-downstream-x402) y cualquiera que
 * se agregue después, porque los descubre leyendo los imports, no una lista fija.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/** Import specifiers que salen del directorio de tests hacia `scripts/`. */
const SCRIPT_IMPORT_RE = /from\s+'((?:\.\.\/)+scripts\/[^']+)'/g;

/** Todos los archivos de test bajo `test/` (no recursivo: hoy es plano). */
function testFiles(): string[] {
  return readdirSync(HERE)
    .filter((f) => f.endsWith('.test.ts') || f.endsWith('.test.mjs'))
    .map((f) => join(HERE, f));
}

/** Rutas relativas al repo de los scripts importados por los tests. */
function importedScriptPaths(): { testFile: string; scriptPath: string }[] {
  const out: { testFile: string; scriptPath: string }[] = [];
  for (const file of testFiles()) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(SCRIPT_IMPORT_RE)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      const absolute = resolve(dirname(file), specifier);
      out.push({
        testFile: file.slice(REPO_ROOT.length + 1),
        scriptPath: absolute.slice(REPO_ROOT.length + 1),
      });
    }
  }
  return out;
}

/** `true` sii git tiene la ruta en el índice (lo que `checkout` materializa). */
function isTrackedByGit(repoRelativePath: string): boolean {
  const stdout = execFileSync('git', ['ls-files', '--', repoRelativePath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return stdout.trim().length > 0;
}

describe('scripts importados por tests', () => {
  it('el descubrimiento encuentra los imports (si no, el test de abajo es vacuo)', () => {
    const found = importedScriptPaths();
    // Control de armado: sin esta aserción, un regex roto dejaría la lista vacía y
    // el guardián pasaría sin verificar nada — la falla silenciosa de siempre.
    expect(found.length).toBeGreaterThanOrEqual(3);
    expect(found.map((f) => f.scriptPath)).toContain(
      'scripts/verify-rls-enabled.mjs',
    );
  });

  it('★ todos están trackeados por git (checkout no trae archivos ignorados)', () => {
    const untracked = importedScriptPaths().filter(
      ({ scriptPath }) => !isTrackedByGit(scriptPath),
    );
    expect(
      untracked,
      `Estos scripts los importa un test pero git NO los tiene en el índice, así que ` +
        `en CI no van a existir y la suite no va a colectar:\n` +
        untracked.map((u) => `  ${u.scriptPath}  ← ${u.testFile}`).join('\n'),
    ).toEqual([]);
  });
});
