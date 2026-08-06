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
 * Por qué NO está cableado a CI (WKH-SEC-03, DT-4). La decisión no cambia, los
 * números sí: son de correr esto, no de estimarlo.
 *
 *   - `--all` muta **46 líneas**, no ~87. Las 46 son las que matchean `CALL_RE`,
 *     que está anclado en `^\s*\.` sobre archivos de producción. El 87 de la
 *     versión anterior de este comentario es el conteo de `.eq('owner_ref'` en
 *     CUALQUIER posición de `src/` incluyendo los `*.test.ts` — o sea, un número
 *     que este guion nunca usó para nada.
 *   - `--all --tests test/ownership-filter-guard.test.ts`: **26,08 s** de pared
 *     medidos, 46/46 KILLED. Son ~0,57 s por mutación.
 *   - La suite COMPLETA tarda **10,47 s** medidos, así que `--all` contra la
 *     suite entera da ≈ 46 × 11 s ≈ **8-9 min**. Eso es una extrapolación, no
 *     una medición: no se corrió entero contra la suite completa.
 *
 * 8-9 min siguen compitiendo con el ciclo de trabajo, así que el veredicto de
 * DT-4 es el mismo. El argumento de que "el orden de magnitud lo descarta" nunca
 * se midió y es falso; el que vale es éste.
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
 *
 * La restauración está en un `finally` y en handlers de `SIGINT`/`SIGTERM`/
 * `SIGHUP` (ver `restaurar()`): un Ctrl-C en el medio del barrido repone el
 * archivo mutado antes de salir. Lo que NO puede cubrirse desde acá es un
 * `SIGKILL` o un corte de luz — ahí el árbol queda con la línea borrada y hay
 * que correr `git checkout -- <archivo>` a mano; el `git status` lo muestra y
 * G-08 lo pone rojo en el siguiente `npm test`.
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

/**
 * El archivo que está mutado AHORA MISMO, o `null`. Existe por un motivo
 * medido, no por prolijidad: entre `deleteLine` y el `git checkout --` que lo
 * repone pasa una corrida entera de la suite (~10 s), y el barrido completo son
 * ~9 min. Un Ctrl-C, un `kill`, o una excepción en el medio dejaban un
 * `.eq('owner_ref', …)` BORRADO en el árbol de trabajo, que es exactamente el
 * bug que este guion existe para cazar, plantado por el guion.
 *
 * (Lo tapaba a medias que G-08 lo caza en el siguiente `npm test`. "A medias"
 * porque nadie garantiza que el siguiente comando sea `npm test`, y porque el
 * árbol queda sucio mientras tanto.)
 */
let mutado = null;

/** Repone el archivo mutado. Idempotente: un segundo Ctrl-C no rompe nada. */
function restaurar({ anunciar = false } = {}) {
  if (mutado === null) return;
  const file = mutado;
  mutado = null;
  try {
    git(['checkout', '--', file]);
    if (anunciar) console.error(`# restaurado: ${file}`);
  } catch (err) {
    // Si esto falla, el árbol QUEDA SUCIO y hay que decirlo fuerte: callarlo
    // sería la misma falla silenciosa de la que trata toda esta HU.
    console.error(
      `\n# ⚠️ NO SE PUDO RESTAURAR ${file}. Corré: git checkout -- ${file}\n# ${String(err)}`,
    );
  }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    console.error(`\n# ${sig} — abortando el barrido.`);
    restaurar({ anunciar: true });
    process.exit(130);
  });
}

/**
 * ⚠️ ESTE `await` NO ES DECORATIVO, Y REGISTRAR EL HANDLER SIN ÉL NO ALCANZA.
 *
 * Medido acá: con los `process.on('SIGINT', …)` puestos y el barrido escrito
 * como un `for` sincrónico, un `kill -INT` al proceso **no imprimía nada y no
 * paraba nada** — el barrido siguió hasta el final (`# KILLED 46`). El motivo:
 * registrar un listener de señal le saca a la señal su acción por defecto (matar
 * el proceso) y la convierte en un callback que espera al event loop; un bucle
 * 100% sincrónico, con `spawnSync` adentro, nunca le devuelve el control, así
 * que el callback queda encolado para siempre.
 *
 * O sea que el handler solo empeoraba el original: antes Ctrl-C mataba el
 * proceso en el acto (dejando el archivo mutado, que es el bug), después Ctrl-C
 * no hacía absolutamente nada. Este `setImmediate` es el que le da al event loop
 * su turno entre iteración e iteración, con el árbol ya restaurado.
 */
const cederElTurno = () => new Promise((r) => setImmediate(r));

try {
  for (const file of files) {
    for (const { line, text } of targetLines(file)) {
      // Antes de tocar nada: si hay una señal encolada, se atiende ACÁ, con el
      // árbol limpio.
      await cederElTurno();

      deleteLine(file, line);
      mutado = file;

      if (!diffIsSingleDeletion(file)) {
        restaurar();
        console.log(`INVALID   ${file}:${line}  (el diff no es 1 sola baja)`);
        invalid += 1;
        continue;
      }

      const run = runSuite(args.tests);
      restaurar();

      const verdict = run.ok ? 'SURVIVED' : 'KILLED';
      if (run.ok) survived += 1;
      else killed += 1;

      console.log(`${verdict.padEnd(9)} ${file}:${line}`);
      console.log(`          borrado: ${text.trim()}`);
      console.log(`          ${run.summary}`);
      for (const f of run.failed) console.log(`          ${f}`);
    }
  }
} finally {
  // Cubre la excepción (un archivo ilegible, un `git` que falla): sin esto, el
  // stack trace se lleva puesta la restauración.
  restaurar({ anunciar: true });
}

console.log('');
console.log(`# KILLED ${killed} · SURVIVED ${survived} · INVALID ${invalid}`);
if (survived > 0) {
  console.log(
    '# Cada SURVIVED es un filtro que se puede borrar sin que nada se ponga rojo.',
  );
}
