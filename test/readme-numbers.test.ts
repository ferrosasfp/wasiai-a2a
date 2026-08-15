/**
 * Guardián: los números que los DOS README publican sobre este repo se derivan
 * del repo, en cada `npm test`.
 *
 * ⚠️ EL BUG QUE ESTE TEST EXISTE PARA CAZAR (medido 2026-08-15, auditoría
 * externa). Los README decían `4.862 tests` en `242 archivos`; `npm test` daba
 * **5424** en **284**. Un 12% de más en archivos y 562 casos de diferencia, en
 * el único documento que un revisor externo sí lee. En la misma tabla, que se
 * presenta como "estado medido en este repo": las cuatro cifras de cobertura
 * desactualizadas, `.env.example` con 180 variables cuando el comando que el
 * propio README publica al lado devuelve 181, y el lint "sobre 441 archivos"
 * cuando Biome dice 477. Seis filas medibles, seis equivocadas. Ninguna estaba
 * mal escrita a propósito: se escribieron a mano una vez y el repo siguió.
 *
 * Es el mismo mecanismo que ya había pasado en `chaski-v3` ("750 tests que eran
 * 2109"), y de ahí sale este archivo: `chaski-v3/src/composition/
 * readme-test-count.test.ts` es el original, portado acá y ampliado a las otras
 * cuatro cifras de la misma tabla, porque el modo de falla no es del número de
 * tests: es de todo número escrito a mano al lado de un comando que lo calcula.
 *
 * QUÉ SE CLAVA Y QUÉ NO — la decisión, no la copia:
 *
 *   SÍ  ARCHIVOS de test. Exacto y derivable sin correr la suite: se expanden
 *       los globs de `vitest.config.ts` contra el índice de git.
 *   SÍ  VARIABLES de `.env.example`. El README publica el comando; acá se corre
 *       ese comando. Un revisor que copie y pegue tiene que obtener lo mismo.
 *   SÍ  ARCHIVOS que linta Biome. Sale del `files.includes` de `biome.json`,
 *       no de una lista escrita acá.
 *   SÍ  PISO de cobertura. Sale de los `thresholds` de `vitest.config.ts`. Si
 *       alguien afloja el trinquete, el README no puede seguir prometiendo el
 *       piso viejo.
 *   NO  CASOS de test (5424 al escribir esto). Para saberlo hay que correr la
 *       suite, y un test que corre la suite para contarla es recursivo. Por eso
 *       ese número se SACÓ de los dos README y se reemplazó por el comando: lo
 *       que no se puede clavar, no se escribe como número. El bloque
 *       `ningún README reintroduce...` impide que vuelva a entrar.
 *   NO  la MEDICIÓN de cobertura (87.49 / 79.64 / 92.48 / 89.02). Misma razón:
 *       hay que correr `--coverage`. En los README va con la FECHA en que se
 *       midió, que es una afirmación que no se vuelve falsa sola.
 *
 * CUATRO TRAMPAS, cada una resuelta a propósito:
 *
 * 1. UN GUARD QUE NO ENCUENTRA NADA APLAUDE. Si el regex deja de matchear
 *    porque alguien reescribió la frase, `expect(declarado).toBe(real)` sobre
 *    `undefined` no protege. Por eso se asserta PRIMERO que el marcador existe
 *    en los dos idiomas, y que el barrido devuelve un set no trivial.
 * 2. LA ASIMETRÍA ENTRE IDIOMAS NO SE VE. El modo de falla de una traducción
 *    parcial no es decir algo falso: es OMITIR. Cada idioma se mide por
 *    separado, con su propio marcador, y ninguno hereda el resultado del otro.
 * 3. UN EXPANSOR DE GLOBS ROTO SE APLAUDE SOLO. Si `globToRegExp` devolviera
 *    `/.*​/`, el conteo sería el del repo entero y el README quedaría "correcto"
 *    contra un número inventado. El bloque `el expansor no es vacuo` lo fija
 *    con casos positivos y negativos.
 * 4. EL FILTRO DE "NÚMERO ESCRITO A MANO" PUEDE NO FILTRAR NADA. Se prueba con
 *    las filas históricas REALES de los dos README, las que estaban mal.
 *
 * QUÉ NO CUBRE (declarado, no arreglado):
 *   - que el 284 coincida con lo que vitest realmente corre. Se deriva de su
 *     `include`/`exclude`, que es su fuente, pero no se le pregunta a vitest
 *     (un test no puede contar la suite que lo contiene). Si el runner cambiara
 *     de motor, esto seguiría verde. El vecino que sí mira runners contra
 *     archivos es `test/test-files-are-run-in-ci.test.ts`.
 *   - la MEDICIÓN de cobertura y el conteo de casos: ver arriba, van con fecha.
 *   - el reparto verdes/salteados: requiere correr. Los README lo describen por
 *     mecanismo (`*.real.test.ts` + un e2e manual) y sin número.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

// ── Archivos del repo, contra el ÍNDICE de git ─────────────────────────────
// Contra git y no contra el disco por dos razones medidas: es lo que un
// `checkout` trae (un archivo sin trackear no lo ve nadie más), y Biome tiene
// `vcs.useIgnoreFile: true`, así que lo ignorado por git tampoco lo linta.

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
}

const TRACKED = trackedFiles();

// ── Globs ──────────────────────────────────────────────────────────────────

/**
 * Construcciones que este expansor NO sabe traducir. Caer acá pone el test
 * rojo; matchear de menos en silencio sería peor que no tener guardián.
 */
function unsupportedGlob(glob: string): boolean {
  return /[!+@]\(|\)\(|^!/.test(glob);
}

/** Glob → RegExp. Soporta `**`, `*`, `?` y `{a,b}`, que es todo lo que usan
 *  `vitest.config.ts` y `biome.json` hoy. */
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

function expand(
  files: string[],
  include: string[],
  exclude: string[] = [],
): string[] {
  const inc = include.map(globToRegExp);
  const exc = exclude.map(globToRegExp);
  return files.filter(
    (f) => inc.some((r) => r.test(f)) && !exc.some((r) => r.test(f)),
  );
}

/** El PRIMER array literal de la clave pedida, tal como está escrito. La clave
 *  puede venir entrecomillada (JSON de `biome.json`) o pelada (TS de
 *  `vitest.config.ts`): las dos formas tienen que leerse igual. */
function globArray(source: string, key: string): string[] | null {
  const m = source.match(
    new RegExp(`(?:^|[^\\w"'])["']?${key}["']?\\s*:\\s*\\[([\\s\\S]*?)\\]`, 'm'),
  );
  if (!m) return null;
  const globs = [...(m[1] as string).matchAll(/['"`]([^'"`]+)['"`]/g)].map(
    (g) => g[1] as string,
  );
  return globs.length > 0 ? globs : null;
}

// ── Las cuatro derivaciones ────────────────────────────────────────────────

const VITEST_CONFIG = readFileSync(join(REPO_ROOT, 'vitest.config.ts'), 'utf8');
const BIOME_CONFIG = readFileSync(join(REPO_ROOT, 'biome.json'), 'utf8');

const TEST_INCLUDE = globArray(VITEST_CONFIG, 'include');
const TEST_EXCLUDE = globArray(VITEST_CONFIG, 'exclude') ?? [];
const TEST_FILES =
  TEST_INCLUDE === null ? [] : expand(TRACKED, TEST_INCLUDE, TEST_EXCLUDE);

const BIOME_INCLUDE = globArray(BIOME_CONFIG, 'includes');
const LINTED_FILES =
  BIOME_INCLUDE === null ? [] : expand(TRACKED, BIOME_INCLUDE);

/** El comando que los README publican, corrido sobre el archivo de verdad. */
const ENV_VARS = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8')
  .split('\n')
  .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l)).length;

const THRESHOLDS = (() => {
  const block = VITEST_CONFIG.match(/thresholds\s*:\s*\{([\s\S]*?)\}/);
  if (!block) return null;
  const read = (k: string): number | null => {
    const m = (block[1] as string).match(new RegExp(`${k}\\s*:\\s*(\\d+)`));
    return m ? Number(m[1]) : null;
  };
  return {
    statements: read('statements'),
    branches: read('branches'),
    functions: read('functions'),
    lines: read('lines'),
  };
})();

// ── Los README ─────────────────────────────────────────────────────────────

const READMES = [
  {
    file: 'README.md',
    label: 'inglés',
    testFiles: /\*\*(\d+) test files\*\*/,
    lintFiles: /over \*\*(\d+) files\*\*/,
    envVars: /documents \*\*(\d+) variables\*\*/,
    floor:
      /statements \*\*(\d+)%\*\*, branches \*\*(\d+)%\*\*, functions \*\*(\d+)%\*\*, lines \*\*(\d+)%\*\*/,
  },
  {
    file: 'README.es.md',
    label: 'español',
    testFiles: /\*\*(\d+) archivos de test\*\*/,
    lintFiles: /sobre \*\*(\d+) archivos\*\*/,
    envVars: /documenta \*\*(\d+) variables\*\*/,
    floor:
      /sentencias \*\*(\d+)%\*\*, ramas \*\*(\d+)%\*\*, funciones \*\*(\d+)%\*\*, líneas \*\*(\d+)%\*\*/,
  },
] as const;

function readme(file: string): string {
  return readFileSync(join(REPO_ROOT, file), 'utf8');
}

/**
 * Un conteo de CASOS escrito a mano. Dos formas, porque las dos existieron:
 * en prosa (`4.862 tests`) y como fila de tabla (`| Tests | 4,862 verdes...`).
 * El lookahead deja pasar "284 test files", que es un conteo de ARCHIVOS y sí
 * está clavado.
 */
const HANDWRITTEN_CASE_COUNT = [
  /\b\d[\d.,]*\s*(?:tests?|casos|pruebas|test cases)\b(?!\s+(?:files?|archivos?))/i,
  /^\|\s*(?:tests|casos|pruebas|test cases)\b[^|]*\|.*\d{3}/i,
];

function handwrittenCaseCounts(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => HANDWRITTEN_CASE_COUNT.some((re) => re.test(line)))
    .map((line) => line.trim());
}

// ── Los tests ──────────────────────────────────────────────────────────────

describe('los números que los README publican salen del repo', () => {
  it('el barrido encuentra algo (si diera vacío, todo lo de abajo pasaría por vacuo)', () => {
    // TRAMPA 1. Sin este caso, un `include` que dejara de parsearse haría que
    // los tres conteos dieran 0 y los README quedaran "verificados" contra 0.
    expect(TRACKED.length).toBeGreaterThan(500);
    expect(TEST_INCLUDE, 'no pude leer el `include` de vitest.config.ts').not.toBeNull();
    expect(BIOME_INCLUDE, 'no pude leer `files.includes` de biome.json').not.toBeNull();
    expect(
      [...(TEST_INCLUDE ?? []), ...TEST_EXCLUDE, ...(BIOME_INCLUDE ?? [])].filter(
        unsupportedGlob,
      ),
      'hay globs que este expansor no sabe traducir: arreglar el expansor, no bajar el assert',
    ).toEqual([]);
    expect(TEST_FILES.length).toBeGreaterThan(200);
    expect(LINTED_FILES.length).toBeGreaterThan(200);
    expect(ENV_VARS).toBeGreaterThan(100);
    expect(THRESHOLDS).not.toBeNull();

    // Y que el set sea el correcto, no sólo grande: este archivo tiene que
    // estar adentro, y los sub-paquetes que el `exclude` saca, afuera.
    expect(TEST_FILES).toContain('test/readme-numbers.test.ts');
    expect(TEST_FILES).toContain('src/routes/receipts.test.ts');
    expect(TEST_FILES.filter((f) => f.startsWith('packages/'))).toEqual([]);
    expect(TEST_FILES.filter((f) => f.startsWith('mcp-servers/'))).toEqual([]);
  });

  for (const { file, label, testFiles, lintFiles, envVars, floor } of READMES) {
    describe(`${file} (${label})`, () => {
      it('declara el número real de archivos de test', () => {
        const hit = readme(file).match(testFiles);
        expect(
          hit,
          `no se encontró ${testFiles} en ${file}: si cambiaste la frase, actualizá el marcador acá`,
        ).not.toBeNull();
        expect(Number((hit as RegExpMatchArray)[1])).toBe(TEST_FILES.length);
      });

      it('declara el número real de archivos que linta Biome', () => {
        const hit = readme(file).match(lintFiles);
        expect(hit, `no se encontró ${lintFiles} en ${file}`).not.toBeNull();
        expect(Number((hit as RegExpMatchArray)[1])).toBe(LINTED_FILES.length);
      });

      it('declara el número real de variables de .env.example', () => {
        const hit = readme(file).match(envVars);
        expect(hit, `no se encontró ${envVars} en ${file}`).not.toBeNull();
        expect(Number((hit as RegExpMatchArray)[1])).toBe(ENV_VARS);
      });

      it('declara el piso de cobertura que el CI realmente exige', () => {
        const hit = readme(file).match(floor);
        expect(hit, `no se encontró ${floor} en ${file}`).not.toBeNull();
        const [, s, b, f, l] = hit as RegExpMatchArray;
        expect({
          statements: Number(s),
          branches: Number(b),
          functions: Number(f),
          lines: Number(l),
        }).toEqual(THRESHOLDS);
      });

      it('no reintroduce un conteo de casos escrito a mano', () => {
        expect(
          handwrittenCaseCounts(readme(file)),
          'Un conteo de casos escrito a mano envejece en cada test nuevo y nadie lo\n' +
            'verifica. Publicá el comando (`npm test` lo imprime), no el número.',
        ).toEqual([]);
      });
    });
  }

  it('el expansor de globs no es vacuo (TRAMPA 3)', () => {
    const files = [
      'src/lib/a.test.ts',
      'src/a.test.ts',
      'src/lib/a.ts',
      'src/lib/a.test.mjs',
      'test/b.test.ts',
      'test/b.test.mjs',
      'test/helpers/c.test.ts',
      'packages/agent-sdk/src/d.test.ts',
      'dist/e.test.ts',
      'README.md',
    ];
    // Los mismos globs que usa el repo hoy.
    expect(
      expand(
        files,
        ['src/**/*.test.ts', 'test/**/*.test.ts', 'test/**/*.test.mjs'],
        ['dist/**', 'node_modules/**', 'packages/**'],
      ).sort(),
    ).toEqual([
      'src/a.test.ts',
      'src/lib/a.test.ts',
      'test/b.test.mjs',
      'test/b.test.ts',
      'test/helpers/c.test.ts',
    ]);
    // Y el de Biome: sólo `.ts` bajo `src/`, a cualquier profundidad.
    expect(expand(files, ['src/**/*.ts']).sort()).toEqual([
      'src/a.test.ts',
      'src/lib/a.test.ts',
      'src/lib/a.ts',
    ]);
    // Un `*` simple no cruza `/`.
    expect(expand(files, ['src/*.ts'])).toEqual(['src/a.test.ts']);
  });

  it('el filtro de conteos a mano caza las filas históricas reales (TRAMPA 4)', () => {
    // Las cuatro líneas que estaban en los README el 2026-08-15, verbatim. Si
    // alguna dejara de matchear, este guardián estaría en verde por vacío.
    const historicas = [
      '| Tests | 4,862 passing, 19 skipped (4,881 total) |',
      '| Tests | 4.862 verdes, 19 salteados (4.881 en total) |',
      'the suite has 5424 tests today',
      'la suite tiene 5424 casos hoy',
    ];
    for (const line of historicas) {
      expect(handwrittenCaseCounts(line), `no cazó: ${line}`).toHaveLength(1);
    }
    // Y no caza lo que sí está clavado ni la prosa vecina.
    for (const line of [
      '| Test files | **284 test files** in the root suite |',
      '| Archivos de test | **284 archivos de test** en la suite raíz |',
      '| Test cases | printed by `npm test`. Not written down here |',
      '`npm run lint` (Biome) over **477 files**',
      'a poll every 5 seconds cost 720 USD per hour',
    ]) {
      expect(handwrittenCaseCounts(line), `falso positivo en: ${line}`).toEqual([]);
    }
  });
});
