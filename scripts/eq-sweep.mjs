#!/usr/bin/env node
/**
 * Barrido de mutación por LÍNEA sobre los `.eq('owner_ref', …)` del árbol.
 *
 * Para cada línea: la borra, corre la suite entera, registra el veredicto y
 * restaura el archivo. Un filtro cuya eliminación deja la suite verde
 * (`SURVIVED`) es un filtro que no mide nadie.
 *
 * ── NOTA DE HONESTIDAD SOBRE PARA QUÉ SIRVE ESTO ─────────────────────────
 *
 * Que sea barato de correr NO lo convierte en un control que alguien vaya a
 * mirar. Esto es una herramienta de quien cierra una HU de seguridad, no un
 * guardián: nada lo ejecuta solo, y si nadie lo corre no dice nada. El control
 * que sí corre en cada PR es `test/ownership-filter-guard.test.ts`, que es
 * estático y tarda milisegundos.
 *
 * Por qué NO está cableado a CI (WKH-SEC-03, DT-4): costos medidos en este
 * worktree — la suite tarda ~10 s de pared, así que el barrido completo son
 * ~87 líneas × ~15 s ≈ 22 min, y el acotado a las 11 líneas de WKH-SEC-03
 * ≈ 3 min. Un control de 22 min compite con el ciclo de trabajo y se termina
 * desactivando. El argumento de que "el orden de magnitud lo descarta" nunca se
 * midió y es falso; el que vale es éste.
 *
 * ── LAS DOS TRAMPAS QUE ESTE GUION EVITA A PROPÓSITO ─────────────────────
 *
 *  A. FALSO KILLED — si la mutación toca más de una línea, la suite se pone
 *     roja por otra razón (un tipo que no compila, otro test que dependía de
 *     esa columna) y el veredicto queda al revés. Por eso después de mutar se
 *     verifica que `git diff --numstat` diga exactamente 1 archivo y 1 borrado,
 *     y si no, el veredicto se descarta como `INVALID`.
 *  B. FALSO SURVIVED — si la línea elegida es un COMENTARIO que menciona
 *     `.eq('owner_ref', …)`, borrarla no cambia nada y el `SURVIVED` es correcto
 *     y completamente engañoso. Por eso se imprime el texto exacto borrado y se
 *     rechazan las líneas que empiezan con `*`, `//` o `/*`.
 *
 * Uso:
 *   node scripts/eq-sweep.mjs --all
 *   node scripts/eq-sweep.mjs --paths src/services/receipt.ts src/services/agent.ts
 *   node scripts/eq-sweep.mjs --paths src/services/receipt.ts --tests src/services/receipt.ownership.test.ts
 *
 * Requiere el árbol LIMPIO en los archivos a mutar (si no, aborta): el guion
 * restaura con `git checkout --`, y eso se llevaría puesto cualquier cambio sin
 * commitear.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** La columna cuyo filtro se mide. */
const COLUMN = 'owner_ref';
/** Una llamada real, no un comentario que la menciona. */
const CALL_RE = new RegExp(`^\\s*\\.(?:eq|in)\\(\\s*['"\`]${COLUMN}['"\`]`);
const COMMENT_RE = /^\s*(?:\/\/|\/\*|\*)/;

function git(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function parseArgs(argv) {
  const out = { all: false, paths: [], tests: [] };
  let bucket = null;
  for (const arg of argv) {
    if (arg === '--all') {
      out.all = true;
      bucket = null;
    } else if (arg === '--paths') bucket = 'paths';
    else if (arg === '--tests') bucket = 'tests';
    else if (bucket) out[bucket].push(arg);
    else {
      console.error(`argumento no reconocido: ${arg}`);
      process.exit(2);
    }
  }
  if (!out.all && out.paths.length === 0) {
    console.error(
      'uso: node scripts/eq-sweep.mjs --all | --paths <archivo...> [--tests <archivo...>]',
    );
    process.exit(2);
  }
  return out;
}

/** Los archivos de producción bajo `src/`, del índice de git. */
function trackedSources() {
  return git(['ls-files', '-z', 'src'])
    .split('\0')
    .filter(Boolean)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => !f.endsWith('.test.ts'))
    .filter((f) => !f.includes('/__tests__/'));
}

/** Las líneas mutables de un archivo: llamadas reales, nunca comentarios. */
function targetLines(file) {
  const lines = readFileSync(resolve(REPO_ROOT, file), 'utf8').split('\n');
  const found = [];
  lines.forEach((text, i) => {
    if (COMMENT_RE.test(text)) return; // antídoto de la trampa B
    if (!CALL_RE.test(text)) return;
    found.push({ line: i + 1, text });
  });
  return found;
}

function deleteLine(file, line) {
  const abs = resolve(REPO_ROOT, file);
  const lines = readFileSync(abs, 'utf8').split('\n');
  lines.splice(line - 1, 1);
  writeFileSync(abs, lines.join('\n'));
}

/** `true` sólo si el diff es exactamente 1 archivo con 1 borrado y 0 altas. */
function diffIsSingleDeletion(file) {
  const out = git(['diff', '--numstat', '--', file]).trim().split('\n');
  if (out.length !== 1) return false;
  const [added, removed] = out[0].split('\t');
  return added === '0' && removed === '1';
}

function runSuite(tests) {
  const res = spawnSync(
    process.execPath,
    ['./node_modules/vitest/vitest.mjs', 'run', ...tests],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  );
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const summary =
    output.match(/^\s*Tests\s+.*$/m)?.[0].trim() ?? '(sin línea de resumen)';
  const failed = output
    .split('\n')
    .filter((l) => l.includes('FAIL '))
    .map((l) => l.trim());
  return { ok: res.status === 0, summary, failed };
}

const args = parseArgs(process.argv.slice(2));
const files = args.all ? trackedSources() : args.paths;

const dirty = git(['status', '--porcelain', '--', ...files]).trim();
if (dirty) {
  console.error(
    'ABORTA: hay cambios sin commitear en los archivos a mutar.\n' +
      'Este guion restaura con `git checkout --`, así que se los llevaría puestos:\n' +
      dirty,
  );
  process.exit(1);
}

console.log('# Barrido de mutación · `.eq(\'owner_ref\', …)`');
console.log(`# commit: ${git(['rev-parse', 'HEAD']).trim()}`);
console.log(`# archivos: ${files.length}`);
console.log('');

const baseline = runSuite(args.tests);
console.log(`BASELINE  ${baseline.summary}`);
if (!baseline.ok) {
  console.error(
    'ABORTA: la baseline ya está roja. Contra una baseline roja los veredictos\n' +
      'se clasifican al revés.',
  );
  process.exit(1);
}
console.log('');

let survived = 0;
let killed = 0;
let invalid = 0;

for (const file of files) {
  for (const { line, text } of targetLines(file)) {
    deleteLine(file, line);

    if (!diffIsSingleDeletion(file)) {
      git(['checkout', '--', file]);
      console.log(`INVALID   ${file}:${line}  (el diff no es 1 sola baja)`);
      invalid += 1;
      continue;
    }

    const run = runSuite(args.tests);
    git(['checkout', '--', file]);

    const verdict = run.ok ? 'SURVIVED' : 'KILLED';
    if (run.ok) survived += 1;
    else killed += 1;

    console.log(`${verdict.padEnd(9)} ${file}:${line}`);
    console.log(`          borrado: ${text.trim()}`);
    console.log(`          ${run.summary}`);
    for (const f of run.failed) console.log(`          ${f}`);
  }
}

console.log('');
console.log(`# KILLED ${killed} · SURVIVED ${survived} · INVALID ${invalid}`);
if (survived > 0) {
  console.log(
    '# Cada SURVIVED es un filtro que se puede borrar sin que nada se ponga rojo.',
  );
}
