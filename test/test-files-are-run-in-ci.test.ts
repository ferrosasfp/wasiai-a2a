/**
 * Guardián: todo archivo `*.test.*` del repo tiene que estar dentro del alcance
 * de algún runner que CI efectivamente corre.
 *
 * ⚠️ EL BUG QUE ESTE TEST EXISTE PARA CAZAR (medido, AR-3 de WKH-322).
 * WKH-322 arregló un bloqueante en `mcp-servers/wasiai-x402/src/handlers.mjs`
 * (un status de error volvía como si fuera el resultado) y escribió tres tests
 * de regresión en `mcp-servers/wasiai-x402/tests/tools.test.mjs`. Esos tests no
 * los corría NADIE: el `include` de `vitest.config.ts` es `src/**` + `test/**`,
 * y ni `package.json` ni ningún workflow nombraban `mcp-servers`. Borrar el
 * bloque `if (!res.ok)` de `handlers.mjs` dejaba CI **verde**.
 *
 * O sea: la mitad de un fix de un bloqueante quedó fijada por una suite
 * huérfana, y la suite huérfana se lee EXACTAMENTE igual que una suite que
 * pasa — nadie ve la diferencia entre "347 verdes" y "347 verdes que nadie
 * corrió". Es el mismo modo de falla que ya tiene guardián para otras dos
 * clases en este directorio (`docs-referenced-by-code-exist.test.ts`,
 * `scripts-imported-by-tests-are-tracked.test.ts`).
 *
 * POR QUÉ UN GUARDIÁN Y NO SÓLO EL STEP DE CI. El step de CI arregla los dos
 * casos de hoy (`mcp-servers/wasiai-x402` y `packages/agent-sdk`). El guardián
 * cierra la CLASE: el próximo sub-paquete con su propio `package.json` y sus
 * propios tests se pone rojo el día que se escribe, no la próxima vez que un
 * adversario se ponga a leer los `include` de un `vitest.config.ts`. Se hacen
 * las DOS cosas a propósito, porque un guardián que nace rojo se termina
 * exceptuando, y una excepción por archivo es el artefacto que ya falló acá.
 *
 * CÓMO DECIDE. No tiene una lista de runners: los DESCUBRE.
 *   1. lee los workflows de `.github/workflows/`, parte cada job en steps y se
 *      queda con los que ejecutan `npm test` / `npm run test…`;
 *   2. de cada step saca su `working-directory` (raíz si no tiene) y lee el
 *      `scripts.test` del `package.json` de ese directorio;
 *   3. traduce ese script a los globs que realmente se expanden: el `include`
 *      del `vitest.config.ts` para vitest, los argumentos glob para
 *      `node --test`.
 * Si no puede traducir un runner, NO adivina: se pone rojo. "No sé qué corre
 * este step" es indistinguible de "este step no corre lo que creo".
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

const TEST_FILE_RE = /\.test\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

interface Runner {
  /** Directorio (relativo al repo) desde el que corre. `''` es la raíz. */
  dir: string;
  /** Globs relativos a `dir` que ese runner expande. */
  globs: string[];
  /** De dónde salió, para que el mensaje del rojo sea accionable. */
  source: string;
}

// ── Descubrimiento de archivos de test ─────────────────────────────────────

/** Contra el ÍNDICE de git, no contra el disco: es lo que `checkout` trae. */
function trackedTestFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\0')
    .filter(Boolean)
    .filter((f) => TEST_FILE_RE.test(f))
    .filter((f) => !f.includes('node_modules/'));
}

// ── Traducción de globs ────────────────────────────────────────────────────

/**
 * Glob → RegExp. Soporta `**`, `*`, `?` y `{a,b}`, que es todo lo que usan los
 * `include` y los `node --test` de este repo. Cualquier otra construcción
 * (extglob `?(c|m)`, negaciones) cae en `unsupportedGlob` y pone el test rojo
 * en vez de matchear de menos en silencio.
 */
function unsupportedGlob(glob: string): boolean {
  return /[!+@]\(|\)\(|^!/.test(glob);
}

function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:[^/]+/)*'; // `a/**/b` matchea también `a/b`
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      continue;
    }
    if (c === '{') {
      const close = glob.indexOf('}', i);
      if (close !== -1) {
        const alts = glob.slice(i + 1, close).split(',');
        re += `(?:${alts.map((a) => a.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|')})`;
        i = close;
        continue;
      }
    }
    re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${re}$`);
}

// ── Descubrimiento de runners ──────────────────────────────────────────────

/** El array literal de `include:` de un `vitest.config.ts`. `null` si no hay. */
function vitestIncludeGlobs(configPath: string): string[] | null {
  if (!existsSync(configPath)) return null;
  const src = readFileSync(configPath, 'utf8');
  const m = src.match(/\binclude\s*:\s*\[([\s\S]*?)\]/);
  if (!m) return null;
  const globs = [...(m[1] as string).matchAll(/['"`]([^'"`]+)['"`]/g)].map(
    (g) => g[1] as string,
  );
  return globs.length > 0 ? globs : null;
}

/** Los globs que un `scripts.test` expande de verdad. `null` = no lo entiendo. */
function globsForTestScript(dir: string, script: string): string[] | null {
  if (/\bvitest\b/.test(script)) {
    return vitestIncludeGlobs(join(REPO_ROOT, dir, 'vitest.config.ts'));
  }
  if (/\bnode\b[^&|;]*--test\b/.test(script)) {
    // `node --test 'tests/*.test.mjs' otro/glob` → los argumentos posicionales
    // posteriores a `--test`, con o sin comillas.
    const after = script.slice(script.indexOf('--test') + '--test'.length);
    const args = [...after.matchAll(/'([^']+)'|"([^"]+)"|(\S+)/g)]
      .map((a) => (a[1] ?? a[2] ?? a[3]) as string)
      .filter((a) => !a.startsWith('-'));
    return args.length > 0 ? args : null;
  }
  return null;
}

/**
 * Parte un workflow en steps. Un step arranca en un `- ` de la lista de `steps`
 * y termina donde arranca el siguiente. Alcanza para leer el par
 * (`working-directory`, `run`) de cada uno, que es lo único que se necesita.
 *
 * ⚠️ NO cubre `defaults.run.working-directory` a nivel job/workflow: hoy no se
 * usa en ninguno de los dos workflows, y si alguien lo usara este guardián
 * atribuiría el step a la raíz y se pondría ROJO (no verde). El modo de falla
 * apunta al lado seguro a propósito.
 */
function workflowSteps(yaml: string): string[] {
  const lines = yaml.split('\n');
  const steps: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (/^\s*-\s+(?:name|uses|run|with|working-directory)\s*:/.test(line)) {
      if (current) steps.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) steps.push(current.join('\n'));
  return steps;
}

function discoverRunners(): { runners: Runner[]; untranslatable: string[] } {
  const runners: Runner[] = [];
  const untranslatable: string[] = [];
  for (const wf of readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f))) {
    const yaml = readFileSync(join(WORKFLOW_DIR, wf), 'utf8');
    for (const step of workflowSteps(yaml)) {
      const run = step.match(/\brun\s*:\s*(.+)/);
      if (!run) continue;
      const cmd = (run[1] as string).trim();
      if (!/^npm\s+(?:test|run\s+test)/.test(cmd)) continue;
      const wd = step.match(/\bworking-directory\s*:\s*(\S+)/);
      const dir = wd ? (wd[1] as string).replace(/^\.\/?|\/$/g, '') : '';
      const pkgPath = join(REPO_ROOT, dir, 'package.json');
      const source = `${wf} → \`${cmd}\`${dir ? ` (working-directory: ${dir})` : ''}`;
      if (!existsSync(pkgPath)) {
        untranslatable.push(`${source}: no hay package.json en '${dir || '.'}'`);
        continue;
      }
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      // `npm run test:coverage` corre otro script; se resuelve el nombre real.
      const scriptName =
        cmd.match(/^npm\s+run\s+(\S+)/)?.[1] ?? ('test' as string);
      const script = pkg.scripts?.[scriptName];
      if (script === undefined) {
        untranslatable.push(`${source}: '${scriptName}' no existe en ${dir || '.'}/package.json`);
        continue;
      }
      const globs = globsForTestScript(dir, script);
      if (globs === null || globs.some(unsupportedGlob)) {
        untranslatable.push(`${source}: no sé qué archivos expande \`${script}\``);
        continue;
      }
      runners.push({ dir, globs, source });
    }
  }
  return { runners, untranslatable };
}

/** Los runners que cubren un archivo dado. Vacío = nadie lo corre. */
function runnersCovering(file: string, runners: Runner[]): Runner[] {
  return runners.filter((r) => {
    if (r.dir !== '' && !file.startsWith(`${r.dir}/`)) return false;
    const rel = r.dir === '' ? file : file.slice(r.dir.length + 1);
    return r.globs.some((g) => globToRegExp(g).test(rel));
  });
}

// ── Los tests ──────────────────────────────────────────────────────────────

const { runners, untranslatable } = discoverRunners();
const testFiles = trackedTestFiles();

describe('archivos de test vs. runners que CI corre', () => {
  it('el descubrimiento encuentra runners y archivos (si no, el de abajo es vacuo)', () => {
    // Control de armado: sin esto, un regex roto deja las dos listas vacías y el
    // guardián pasa sin verificar nada — la falla silenciosa de siempre, dentro
    // del guardián que existe para cazar una falla silenciosa.
    expect(
      untranslatable,
      'Hay steps de CI que corren tests y este guardián NO pudo traducir a un set de\n' +
        'archivos. Un runner que no se sabe qué corre no puede usarse para afirmar que\n' +
        `algo está cubierto:\n  ${untranslatable.join('\n  ')}\n`,
    ).toEqual([]);
    expect(runners.length).toBeGreaterThanOrEqual(3);
    expect(testFiles.length).toBeGreaterThan(200);
    // Los tres sub-árboles con tests hoy, cada uno atribuido a su runner. Si un
    // step de CI desaparece, esto se pone rojo por el lado del runner además de
    // por el lado del archivo.
    expect(runners.map((r) => r.dir)).toContain('');
    expect(runners.map((r) => r.dir)).toContain('mcp-servers/wasiai-x402');
    expect(runners.map((r) => r.dir)).toContain('packages/agent-sdk');
  });

  it('★ ningún archivo de test queda fuera del alcance de todos los runners', () => {
    const orphans = testFiles.filter(
      (f) => runnersCovering(f, runners).length === 0,
    );
    expect(
      orphans,
      `Hay ${orphans.length} archivo(s) de test que NINGÚN runner de CI corre. Pasan en\n` +
        'verde en la máquina de quien los escribió (ahí se invocan a mano) y no protegen\n' +
        'nada: borrar el código que fijan deja CI verde.\n' +
        'Arreglo: meterlos en el `include` de un runner existente, o agregar el step de\n' +
        'CI del sub-paquete (con su `working-directory`) — NO exceptuarlos acá.\n' +
        `Runners descubiertos:\n${runners.map((r) => `  ${r.source} → ${r.dir || '.'}/{${r.globs.join(', ')}}`).join('\n')}\n` +
        `Huérfanos:\n${orphans.map((o) => `  ${o}`).join('\n')}\n`,
    ).toEqual([]);
  });

  it('el matcher no es vacuo: reconoce lo cubierto y rechaza lo que no', () => {
    // Sin este caso, un `globToRegExp` que devolviera `/.*/ ` haría pasar el test
    // de arriba afirmando cobertura total.
    const fake: Runner[] = [
      { dir: '', globs: ['src/**/*.test.ts'], source: 'fixture' },
      { dir: 'sub/pkg', globs: ['tests/*.test.mjs'], source: 'fixture' },
    ];
    expect(runnersCovering('src/lib/a.test.ts', fake)).toHaveLength(1);
    expect(runnersCovering('src/a.test.ts', fake)).toHaveLength(1);
    expect(runnersCovering('sub/pkg/tests/a.test.mjs', fake)).toHaveLength(1);
    // Los tres que NO tiene que matchear: extensión distinta, un nivel de más
    // bajo un `*` simple, y un archivo del sub-paquete visto desde la raíz.
    expect(runnersCovering('src/lib/a.test.mjs', fake)).toHaveLength(0);
    expect(runnersCovering('sub/pkg/tests/x/a.test.mjs', fake)).toHaveLength(0);
    expect(runnersCovering('other/tests/a.test.mjs', fake)).toHaveLength(0);
  });
});
