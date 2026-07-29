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
 * Cubre los cuatro tests que hoy dependen de un `.mjs` de `scripts/` y cualquiera
 * que se agregue después, porque los descubre leyendo el fuente, no una lista fija.
 *
 * ⚠️ NO ALCANZA CON MIRAR LOS `import`. `test/smoke-passport-autonomous.test.mjs` no
 * importa su script: lo EJECUTA con `spawnSync(node, [SCRIPT_PATH])`, donde SCRIPT_PATH
 * sale de un `resolve(...)`. Si ese `.mjs` se gitignorea, en CI el spawn falla y el test
 * se cae exactamente igual — pero un guardián que sólo mire `from '...'` lo deja pasar.
 * O sea que la primera versión de este archivo tenía el mismo punto ciego que el bug que
 * viene a cazar, sólo que un renglón más allá. Por eso el descubrimiento busca CUALQUIER
 * literal de cadena que apunte a `scripts/*.mjs`, importado o no.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/**
 * CUALQUIER literal que apunte a un `.mjs` de `scripts/`: tanto `from '../scripts/x.mjs'`
 * como el `resolve(__filename, '../../scripts/x.mjs')` de un test que lo spawnea. Comillas
 * simples o dobles.
 *
 * Se captura el tramo desde `scripts/` y NO se resuelve la ruta relativa a propósito: los
 * dos usos cuentan los `../` desde bases distintas (`from` es relativo al directorio del
 * archivo; `resolve(__filename, ...)` trata al archivo como un segmento más, así que lleva
 * un `../` de más). Resolver "bien" cualquiera de los dos rompería el otro. Como todos estos
 * scripts viven en `scripts/` en la raíz del repo, la cola del literal ES la ruta a
 * verificar, y así el chequeo no depende de acertar la aritmética de `..`.
 */
const SCRIPT_REF_RE = /['"](?:\.\.\/)+(scripts\/[^'"]+\.mjs)['"]/g;

/**
 * Quita los comentarios para que el descubrimiento mire CÓDIGO y no PROSA.
 *
 * ⚠️ EXISTE POR UN FALSO POSITIVO REAL: este mismo archivo documenta el formato que busca,
 * y el ejemplo de la prosa hacía que el guardián se denunciara a sí mismo por un script que
 * no existe. Un guardián que se cae solo se termina desactivando, que es peor que no tenerlo.
 *
 * Sólo se borran los bloques `/* … *\/` y las líneas que son ÍNTEGRAMENTE comentario. NO se
 * corta a mitad de línea al ver `//`, a propósito: eso partiría un `'http://…'` dentro de una
 * cadena y podría hacer DESAPARECER una referencia real. Ante la duda, se escanea de más.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

/** Todos los archivos de test bajo `test/` (no recursivo: hoy es plano). */
function testFiles(): string[] {
  return readdirSync(HERE)
    .filter((f) => f.endsWith('.test.ts') || f.endsWith('.test.mjs'))
    .map((f) => join(HERE, f));
}

/** Rutas (relativas al repo) de los scripts de los que depende cada test. */
function importedScriptPaths(): { testFile: string; scriptPath: string }[] {
  const out: { testFile: string; scriptPath: string }[] = [];
  const seen = new Set<string>();
  for (const file of testFiles()) {
    const source = stripComments(readFileSync(file, 'utf8'));
    const testFile = file.slice(REPO_ROOT.length + 1);
    for (const match of source.matchAll(SCRIPT_REF_RE)) {
      const scriptPath = match[1];
      if (scriptPath === undefined) continue;
      // Un mismo test puede nombrar el script dos veces (import + ruta para spawn).
      const key = `${testFile}::${scriptPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ testFile, scriptPath });
    }
  }
  return out;
}

/** ¿Hay metadata de git usable acá? Un tarball/vendorizado no la tiene. */
function gitMetadataAvailable(): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
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
  it('el descubrimiento encuentra las dependencias (si no, el test de abajo es vacuo)', () => {
    const found = importedScriptPaths();
    // Control de armado: sin esta aserción, un regex roto dejaría la lista vacía y
    // el guardián pasaría sin verificar nada — la falla silenciosa de siempre.
    const paths = found.map((f) => f.scriptPath);
    expect(found.length).toBeGreaterThanOrEqual(4);
    // El que rompió CI el 2026-07-28 (import).
    expect(paths).toContain('scripts/verify-rls-enabled.mjs');
    expect(paths).toContain('scripts/migrate-preflight.mjs');
    expect(paths).toContain('scripts/smoke-downstream-x402.mjs');
    // ⚠️ Éste NO se importa: se spawnea. Si el descubrimiento vuelve a mirar sólo los
    // `from '...'`, esta línea se pone roja — que es el punto ciego que ya tuvimos.
    expect(paths).toContain('scripts/smoke-passport-autonomous.mjs');
  });

  it('★ todos están trackeados por git (checkout no trae archivos ignorados)', () => {
    // DOS MODOS, ninguno que pase en silencio:
    //  · con metadata de git (máquina del dev, CI real) se pregunta por el ÍNDICE,
    //    que es lo que `checkout` materializa. Ahí se caza el bug en el momento de
    //    introducirlo, aunque el archivo siga en el disco del autor.
    //  · sin metadata (tarball, vendorizado, `git archive`) el disco YA es el
    //    estado post-checkout, así que la existencia del archivo es la verdad.
    // Saltear el test cuando no hay git sería la falla silenciosa de siempre.
    const useGit = gitMetadataAvailable();
    const broken = importedScriptPaths().filter(({ scriptPath }) =>
      useGit
        ? !isTrackedByGit(scriptPath)
        : !existsSync(join(REPO_ROOT, scriptPath)),
    );
    expect(
      broken,
      `Estos scripts los importa un test pero ${
        useGit ? 'git NO los tiene en el índice' : 'NO existen en esta copia'
      }, así que en CI no van a existir y la suite no va a colectar:\n` +
        broken.map((u) => `  ${u.scriptPath}  ← ${u.testFile}`).join('\n'),
    ).toEqual([]);
  });
});
