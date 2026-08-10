/**
 * Guardián: `doc/sdd/_INDEX.md` y las carpetas `doc/sdd/NNN-…` dicen lo mismo.
 *
 * ⚠️ EL BUG QUE ESTE TEST EXISTE PARA CAZAR (medido el 2026-08-10, no hipotético).
 * El índice —que **es** el backlog del proyecto, porque Jira está fuera de uso— afirmaba
 * tres cosas falsas a la vez:
 *   · **31 carpetas de `doc/sdd/` no tenían fila** que las reclamara (26 si sólo se cuenta
 *     "ninguna fila lleva su número"), entre ellas HUs de money-path ya mergeadas.
 *   · la fila `007` estaba **duplicada**.
 *   · dos filas linkeaban un `report.md` que **nunca existió** en ningún commit.
 * Y el propio índice llevaba una **lista a mano** de "qué carpeta tiene fila" que decía 18
 * cuando eran 31, y decía "no" de dos carpetas que sí tenían. Una lista a mano no se
 * actualiza con las carpetas nuevas: por eso acá el universo se DERIVA y lo único escrito a
 * mano son las excusas puntuales (`sdd-index-matches-folders.exceptions.ts`).
 *
 * Es la tercera vez que este repo aprende lo mismo: `test/ownership-filter-guard.test.ts`
 * deriva las tablas del esquema en vez de listarlas, y una lista fija de 11 referencias en
 * otra HU cantó `11/11` con el candado en rojo por una cita que no estaba en la lista.
 *
 * ── DE QUÉ LADO CAE EL ERROR (decisión, no accidente) ──────────────────────────────────
 *
 * **FAIL-CLOSED: ante cualquier duda, ROJO.** Si `git` no está disponible, si no aparece el
 * header de la tabla, si una fila no parsea, si una carpeta no se puede resolver → el test
 * falla. Un guardián que produce falsos ROJOS es una molestia y se arregla en dos minutos;
 * el mismo guardián produciendo falsos VERDES es un adorno, y el adorno es lo que dejó el
 * índice mintiendo por semanas. Elegimos molestia.
 *
 * ── LO QUE ESTE GUARDIÁN **NO** MIRA (leelo antes de apoyarte en su verde) ─────────────
 *
 *  1. **NO valida el CONTENIDO de un estado.** Que una fila diga `DONE` de algo que no está
 *     mergeado, o que diga `in progress` de algo desplegado, le pasa en verde. Eso lo cubre
 *     la disciplina de la nota "Un estado desactualizado acá hace planificar mal" del
 *     `_INDEX.md` (`git merge-base --is-ancestor`, `git rev-list --count main..<rama>`), y
 *     no hay forma de mecanizarlo desde el árbol: **"commit en `main`" no es "desplegado"**,
 *     y lo desplegado vive en Railway/Vercel/`bdwv`, no en git.
 *  2. **NO verifica que la fila hable de SU carpeta.** Verifica que exista exactamente un
 *     reclamo. Una fila que linkea la carpeta correcta y describe otra HU pasa en verde.
 *  3. **NO mira el `.gitignore` por su cuenta**: las carpetas y links gitignoreados están
 *     declarados a mano en el archivo de excepciones. Si alguien gitignorea una carpeta
 *     nueva, el guardián se pone rojo (bien), pero no explica que fue el `.gitignore`.
 *  4. **NO valida las citas `_INDEX.md:N` que hace la documentación**, sólo las que hace
 *     `src/`. Las de `doc/` se corren de lugar sin que nada avise (pasó en este mismo
 *     saneamiento y está declarado en el `_INDEX.md`).
 *  5. **NO ordena nada.** La tabla puede estar desordenada; la fila `023` lo está a
 *     propósito, y el motivo (una cita desde `src/`) es lo que sí verifica G-F.
 *  6. **NO mira las tablas secundarias** del `_INDEX.md`, sólo la tabla principal: se corta
 *     en la primera línea que no empieza con `|`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CITED_INDEX_LINES,
  FOLDERS_UNTRACKED_BY_DESIGN,
  LINKS_KNOWN_UNTRACKED,
  ROWS_WITHOUT_FOLDER,
} from './sdd-index-matches-folders.exceptions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SDD_DIR = join(REPO_ROOT, 'doc', 'sdd');
const INDEX_REL = 'doc/sdd/_INDEX.md';

/** Header exacto de la tabla principal. Si cambia, el guardián se cae (fail-closed). */
const EXPECTED_HEADER = ['#', 'Fecha', 'HU', 'Tipo', 'Mode', 'Status', 'Branch'] as const;

/**
 * Pisos de anti-vacuidad. No son "el número de HUs": son el umbral por debajo del cual
 * asumimos que el parseo se rompió y no que el proyecto se encogió. **Los dos números de
 * abajo son una foto** (medidos el 2026-08-10: 201 carpetas de HU derivadas de git —204
 * directorios en el disco menos `_validation` y las 2 gitignoreadas— y 210 filas de datos);
 * el piso es lo normativo. Si alguna vez hay que BAJARLO, algo se borró y merece mirarse a
 * mano en vez de acomodar el número.
 */
const MIN_FOLDERS = 150;
const MIN_ROWS = 150;

interface Row {
  /** Línea 1-indexed dentro de `_INDEX.md`. */
  readonly line: number;
  readonly cells: readonly string[];
  readonly raw: string;
}

/** Parte una fila Markdown respetando los `\|` escapados. */
function splitCells(raw: string): string[] {
  const body = raw.trim();
  const out: string[] = [];
  let cur = '';
  let i = 0;
  while (i < body.length) {
    if (body[i] === '\\' && body[i + 1] === '|') {
      cur += '|';
      i += 2;
      continue;
    }
    if (body[i] === '|') {
      out.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    cur += body[i];
    i += 1;
  }
  out.push(cur);
  // la primera y la última "celda" son el vacío antes/después de los `|` de los extremos
  return out.slice(1, -1).map((c) => c.trim());
}

const indexLines: readonly string[] = readFileSync(join(REPO_ROOT, INDEX_REL), 'utf8').split('\n');

/** Tabla principal, derivada: header exacto + filas consecutivas. Fail-closed si no aparece. */
function parseMainTable(): { headerLine: number; rows: Row[] } {
  const headerIdx = indexLines.findIndex((l) => {
    if (!l.startsWith('|')) return false;
    const cells = splitCells(l);
    return (
      cells.length === EXPECTED_HEADER.length && cells.every((c, i) => c === EXPECTED_HEADER[i])
    );
  });
  if (headerIdx === -1) {
    throw new Error(
      `[G-D1] no se encontró el header de la tabla principal en ${INDEX_REL}. ` +
        `Esperado: | ${EXPECTED_HEADER.join(' | ')} |. ` +
        'Si el formato del índice cambió a propósito, hay que actualizar este guardián: ' +
        'fallar es deliberado, porque sin header no se puede afirmar NADA sobre la tabla.',
    );
  }
  const sep = indexLines[headerIdx + 1] ?? '';
  if (!/^\|[\s|:-]+\|$/.test(sep.trim())) {
    throw new Error(`[G-D1] la línea siguiente al header no es el separador de la tabla: ${sep}`);
  }
  const rows: Row[] = [];
  for (let i = headerIdx + 2; i < indexLines.length; i += 1) {
    const raw = indexLines[i] ?? '';
    if (!raw.startsWith('|')) break;
    rows.push({ line: i + 1, cells: splitCells(raw), raw });
  }
  return { headerLine: headerIdx + 1, rows };
}

const { rows } = parseMainTable();

/** Carpetas de HU: se DERIVAN de git, no del disco. Ver G-T para por qué. */
function trackedHuFolders(): Set<string> {
  let out: string;
  try {
    out = execFileSync('git', ['ls-files', '--', 'doc/sdd'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(
      '[G-E0] no se pudo correr `git ls-files -- doc/sdd`, así que no se puede derivar el ' +
        'universo de carpetas. El guardián falla A PROPÓSITO en vez de caer al disco: el ' +
        'disco y git difieren (hay carpetas gitignoreadas), y un universo distinto en CI que ' +
        `en local es un verde que no significa nada. Detalle: ${String(err)}`,
    );
  }
  const folders = new Set<string>();
  for (const rel of out.split('\n')) {
    const parts = rel.trim().split('/');
    // doc/sdd/<carpeta>/<archivo…>
    if (parts.length < 4) continue;
    const folder = parts[2];
    if (folder === undefined || folder === '') continue;
    if (folder.startsWith('_')) continue; // convención del directorio: `_` = material meta
    folders.add(folder);
  }
  return folders;
}

const huFolders = trackedHuFolders();

/**
 * Clave de índice de una carpeta: el prefijo `NNN` si lo tiene, o el nombre completo.
 * Varias carpetas comparten prefijo (deuda de numeración conocida), y ahí el número NO
 * alcanza: esas carpetas sólo se pueden reclamar por link (control G-C).
 */
function indexKey(folder: string): string {
  const m = /^(\d{3})-/.exec(folder);
  return m?.[1] ?? folder;
}

const foldersByKey = new Map<string, string[]>();
for (const f of [...huFolders].sort()) {
  const k = indexKey(f);
  foldersByKey.set(k, [...(foldersByKey.get(k) ?? []), f]);
}

const LINK_RE = /\]\(([^)\s]+)\)/g;

/** Links del índice que apuntan dentro de `doc/sdd/`, por fila. */
function linksOf(row: Row): string[] {
  const out: string[] = [];
  for (const m of row.raw.matchAll(LINK_RE)) {
    const t = m[1];
    if (t === undefined) continue;
    if (t.startsWith('http') || t.includes('…')) continue;
    out.push(t);
  }
  return out;
}

/**
 * Quién reclama a cada carpeta. Dos mecanismos, y G-G verifica que los DOS estén vivos:
 *  (1) una fila que linkea un archivo dentro de la carpeta;
 *  (2) una fila cuyo `#` es el número de la carpeta, **sólo si ese número es de una sola
 *      carpeta** (si es compartido, el número no identifica nada).
 */
const claimsByFolder = new Map<string, { byLink: number[]; byNumber: number[] }>();
for (const folder of huFolders) {
  claimsByFolder.set(folder, { byLink: [], byNumber: [] });
}
for (const row of rows) {
  for (const target of linksOf(row)) {
    const top = target.split('/')[0];
    if (top === undefined) continue;
    const entry = claimsByFolder.get(top);
    if (entry && !entry.byLink.includes(row.line)) entry.byLink.push(row.line);
  }
  const key = row.cells[0] ?? '';
  const sameKey = foldersByKey.get(key);
  if (sameKey !== undefined && sameKey.length === 1) {
    const only = sameKey[0];
    if (only !== undefined) claimsByFolder.get(only)?.byNumber.push(row.line);
  }
}

function claimers(folder: string): number[] {
  const c = claimsByFolder.get(folder);
  if (c === undefined) return [];
  return [...new Set([...c.byLink, ...c.byNumber])].sort((a, b) => a - b);
}

describe('doc/sdd/_INDEX.md ↔ carpetas de doc/sdd/ (guardián de sincronía)', () => {
  it('G-A1: el universo derivado no es trivial (anti-vacuidad del parseo)', () => {
    expect(huFolders.size).toBeGreaterThanOrEqual(MIN_FOLDERS);
    expect(rows.length).toBeGreaterThanOrEqual(MIN_ROWS);
  });

  it('G-D2: cada fila tiene exactamente 7 columnas y las 4 obligatorias no están vacías', () => {
    const malformed = rows
      .filter((r) => r.cells.length !== EXPECTED_HEADER.length)
      .map((r) => `${INDEX_REL}:${r.line} tiene ${r.cells.length} columnas (${r.cells[0]})`);
    expect(
      malformed,
      'Casi siempre es un `|` literal dentro de un span de código: escapalo como `\\|`. ' +
        'Pasó en la fila `155` y en la fila `221`, y en las dos el Markdown renderizado ' +
        'mostraba el TIPO donde va el STATUS.',
    ).toEqual([]);
    const empty: string[] = [];
    for (const r of rows) {
      for (const idx of [0, 1, 2, 5]) {
        if ((r.cells[idx] ?? '') === '') {
          empty.push(`${INDEX_REL}:${r.line} celda "${EXPECTED_HEADER[idx]}" vacía`);
        }
      }
    }
    expect(empty).toEqual([]);
  });

  it('G-A2: cada carpeta de HU tiene EXACTAMENTE una fila', () => {
    const problems: string[] = [];
    for (const folder of [...huFolders].sort()) {
      const c = claimers(folder);
      if (c.length === 1) continue;
      problems.push(
        c.length === 0
          ? `doc/sdd/${folder}/ NO tiene fila. Agregá una fila a ${INDEX_REL} con su estado ` +
            'REAL (evidencia: commit en `main`, `git merge-base --is-ancestor`), y un link a ' +
            'un archivo de la carpeta.'
          : `doc/sdd/${folder}/ tiene ${c.length} filas (líneas ${c.join(', ')}). ` +
            'Unificalas en una.',
      );
    }
    expect(problems).toEqual([]);
  });

  it('G-B1: cada fila reclama alguna carpeta, o está declarada como fila sin carpeta', () => {
    const claimedLines = new Set<number>();
    for (const folder of huFolders) for (const l of claimers(folder)) claimedLines.add(l);
    const excused = new Set(ROWS_WITHOUT_FOLDER.map((e) => e.key));
    const orphans = rows
      .filter((r) => !claimedLines.has(r.line))
      .filter((r) => !excused.has(r.cells[0] ?? ''))
      .map(
        (r) =>
          `${INDEX_REL}:${r.line} (fila "${r.cells[0]}") no apunta a ninguna carpeta de ` +
          'doc/sdd/. O le falta el link a su carpeta, o es una fila sin carpeta y va con su ' +
          'motivo a ROWS_WITHOUT_FOLDER.',
      );
    expect(orphans).toEqual([]);
  });

  it('G-B2: no sobra ninguna excepción de ROWS_WITHOUT_FOLDER (la lista no se pudre)', () => {
    const claimedLines = new Set<number>();
    for (const folder of huFolders) for (const l of claimers(folder)) claimedLines.add(l);
    const orphanKeys = new Set(
      rows.filter((r) => !claimedLines.has(r.line)).map((r) => r.cells[0] ?? ''),
    );
    const stale = ROWS_WITHOUT_FOLDER.filter((e) => !orphanKeys.has(e.key)).map(
      (e) =>
        `la excepción de la fila "${e.key}" ya no hace falta (o la fila ganó carpeta, o ` +
        'desapareció): borrala.',
    );
    expect(stale).toEqual([]);
  });

  it('G-B3: cada excepción declarada tiene forma y motivo escrito (se valida en runtime)', () => {
    const bad: string[] = [];
    for (const e of ROWS_WITHOUT_FOLDER) {
      if (typeof e.key !== 'string' || e.key.trim() === '') bad.push(`key inválida: ${e.key}`);
      if (typeof e.reason !== 'string' || e.reason.trim().length < 40) {
        bad.push(`motivo demasiado corto para la fila "${e.key}"`);
      }
    }
    for (const e of [...FOLDERS_UNTRACKED_BY_DESIGN, ...LINKS_KNOWN_UNTRACKED]) {
      const id = 'folder' in e ? e.folder : e.target;
      if (typeof e.reason !== 'string' || e.reason.trim().length < 20) {
        bad.push(`motivo demasiado corto para "${id}"`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('G-C: si un número está compartido por varias carpetas, cada una está linkeada por nombre', () => {
    const ambiguous = [...foldersByKey.entries()].filter(([, fs]) => fs.length > 1);
    // control positivo del propio control: si esto queda vacío, no es que esté todo sano,
    // es que la deuda de numeración desapareció y este `it` dejó de medir algo.
    expect(
      ambiguous.length,
      'ya no hay números compartidos: revisá si este control sigue teniendo sentido',
    ).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const [key, fs] of ambiguous) {
      for (const f of fs) {
        const byLink = claimsByFolder.get(f)?.byLink ?? [];
        if (byLink.length !== 1) {
          problems.push(
            `el número "${key}" lo comparten ${fs.length} carpetas, así que doc/sdd/${f}/ ` +
              `sólo puede identificarse por link, y tiene ${byLink.length}.`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('G-E1: todo link del índice a doc/sdd/ apunta a un archivo que está EN GIT', () => {
    const trackedFiles = new Set(
      execFileSync('git', ['ls-files', '--', 'doc/sdd'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      })
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    const excused = new Set(LINKS_KNOWN_UNTRACKED.map((e) => e.target));
    const broken: string[] = [];
    for (const row of rows) {
      for (const target of linksOf(row)) {
        if (excused.has(target)) continue;
        if (!trackedFiles.has(`doc/sdd/${target}`)) {
          broken.push(
            `${INDEX_REL}:${row.line} linkea "${target}", que no está en git. ` +
              'Si el archivo no existe, el link MIENTE (pasó con dos `report.md` que nunca ' +
              'existieron); si existe pero está sin commitear, commitealo o declaralo.',
          );
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('G-T: toda carpeta de HU del disco está en git (o declarada como gitignoreada)', () => {
    const onDisk = readdirSync(SDD_DIR)
      .filter((n) => !n.startsWith('_'))
      .filter((n) => statSync(join(SDD_DIR, n)).isDirectory());
    const excused = new Set(FOLDERS_UNTRACKED_BY_DESIGN.map((e) => e.folder));
    const invisible = onDisk
      .filter((f) => !huFolders.has(f) && !excused.has(f))
      .map(
        (f) =>
          `doc/sdd/${f}/ existe en el disco y NO en git: para cualquiera que clone el repo ` +
          'esa HU no existe, y su fila del índice linkea a la nada. Commiteala.',
      );
    expect(invisible).toEqual([]);
  });

  it('G-F1: las líneas de _INDEX.md que cita src/ siguen diciendo lo que el código afirma', () => {
    const problems: string[] = [];
    for (const c of CITED_INDEX_LINES) {
      const line = indexLines[c.line - 1];
      if (line === undefined) {
        problems.push(`${c.from} cita ${INDEX_REL}:${c.line} y esa línea no existe`);
        continue;
      }
      for (const needle of c.mustContain) {
        if (!line.includes(needle)) {
          problems.push(
            `${c.from} cita ${INDEX_REL}:${c.line} esperando "${needle}", y esa línea ya no ` +
              'lo contiene: se corrió la tabla. Agregar filas al FINAL, o compensar la línea ' +
              'liberada en el mismo lugar (ver "Por qué la fila `023` está fuera de orden ' +
              'numérico" en el índice).',
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('G-F2: toda cita `_INDEX.md:N` que haga src/ está declarada (el universo se deriva)', () => {
    const files = execFileSync('git', ['ls-files', '--', 'src'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => /\.(ts|tsx|mjs|cjs|js)$/.test(s));
    const declared = new Set(CITED_INDEX_LINES.map((c) => `${c.from}:${c.line}`));
    const undeclared: string[] = [];
    for (const rel of files) {
      const body = readFileSync(join(REPO_ROOT, rel), 'utf8');
      for (const m of body.matchAll(/doc\/sdd\/_INDEX\.md:(\d+)/g)) {
        const n = Number(m[1]);
        if (!declared.has(`${rel}:${n}`)) {
          undeclared.push(
            `${rel} cita ${INDEX_REL}:${n} y no está en CITED_INDEX_LINES. Declaralo con lo ` +
              'que esa línea tiene que decir, o el próximo que agregue una fila lo rompe en ' +
              'silencio.',
          );
        }
      }
    }
    expect(undeclared).toEqual([]);
  });

  it('G-G: los DOS mecanismos de reclamo están vivos (control positivo del instrumento)', () => {
    let onlyByNumber = 0;
    let onlyByLink = 0;
    for (const folder of huFolders) {
      const c = claimsByFolder.get(folder);
      if (c === undefined) continue;
      if (c.byLink.length === 0 && c.byNumber.length > 0) onlyByNumber += 1;
      if (c.byNumber.length === 0 && c.byLink.length > 0) onlyByLink += 1;
    }
    // Si uno de los dos cae a 0, una rama del reclamo dejó de ejercitarse y el guardián
    // podría estar aprobando por la otra sin que nadie lo note.
    expect(onlyByNumber, 'ninguna carpeta se reclama sólo por número').toBeGreaterThan(0);
    expect(onlyByLink, 'ninguna carpeta se reclama sólo por link').toBeGreaterThan(0);
  });
});
