/**
 * LA MUESTRA RESERVADA del discriminador de citas sueltas (WKH-371, AC-2).
 *
 * ── PARA QUÉ EXISTE ────────────────────────────────────────────────────────
 *
 * Este archivo NO es el clasificador ni lo consume. Es el ORÁCULO contra el que
 * el clasificador se mide, y su única propiedad importante es que **se escribió
 * ANTES de que el clasificador existiera**, en un commit anterior.
 *
 * 🔴 EL DEFECTO QUE ESTE ARCHIVO EXISTE PARA NO REPETIR, medido en el F1 de
 * esta misma HU: la primera cascada derivó sus reglas leyendo
 * `test/cited-lines-guard.exceptions.ts` y después midió su precisión **sobre
 * ese mismo archivo**: 11 de 11 = 100 %. Medida contra un conjunto etiquetado
 * que nadie había escrito mirando el clasificador —las entradas P3/P4 de
 * `CITED_LINES`, etiquetadas a mano en OTRAS HUs—, la misma cascada daba
 * **recall 4/19 = 21 %**, con 5 falsos negativos silenciosos. Calibrar no es
 * medir: un instrumento que se compara contra su propia salida da verde con
 * cualquier implementación, incluida la que no encuentra nada.
 *
 * ── CÓMO SE GARANTIZA LA INDEPENDENCIA (no se promete: se verifica) ────────
 *
 * Por ORDEN DE COMMITS. En el commit que trae `RESERVED_SAMPLE` con sus
 * etiquetas, `classifyBareCite` no existe en el árbol:
 *
 *     git show <commit-de-etiquetas>:test/cited-lines-guard.scanner.ts \
 *       | grep -c classifyBareCite        # → 0
 *
 * ⚠️ LO QUE ESTE MECANISMO **NO** GARANTIZA, y decirlo al revés sería prosa que
 * afirma de más: quien etiquetó conocía las reglas de la cascada, porque
 * etiquetar exige saber qué es una CITA. Eso es inevitable y **no** es lo que
 * AC-2 prohíbe. AC-2 prohíbe dos cosas concretas y las dos son verificables:
 * que la muestra sea la misma de la que salieron las reglas, y que las
 * etiquetas se ajusten después de ver la salida del clasificador. **La
 * independencia es de la MUESTRA y del MOMENTO, no de la mente del que
 * etiqueta.**
 *
 * ── EL MARCO, CON SU PERÍMETRO Y SU PATRÓN (CD-1) ──────────────────────────
 *
 * Perímetro: los archivos de `src/`, `test/` y `scripts/` que estaban en el
 * ÍNDICE DE GIT del commit `SAMPLE_BASE_COMMIT` (no en el disco, y no en `doc/`).
 * Patrón: las formas P3 y P4 de `scanSource` (`cited-lines-guard.scanner.ts`),
 * o sea un `:N` / `:A-B` sin path delante.
 * Del universo así definido se quitan:
 *   · los 8 archivos AUTO-REFERENTES de `SELF_REFERENTIAL` (ver abajo), y
 *   · las ocurrencias que YA tienen etiqueta a mano en el repo (el oráculo
 *     preexistente: las entradas P3/P4 de `CITED_LINES` y las de
 *     `SCANNER_FALSE_POSITIVES`), porque medirse contra ellas dos veces no
 *     agrega información.
 *
 * 🔴 **EL COMMIT BASE NO ES DECORACIÓN (CD-21).** Este mismo archivo introduce
 * ≥120 tokens P3/P4 nuevos en `test/` —cada `cite: ':634'` de acá abajo matchea
 * `BARE_CITE_RE`—, así que un marco derivado del árbol de HOY estaría inflado
 * por el propio instrumento y el censo publicaría un número falso. El marco se
 * deriva contra `SAMPLE_BASE_COMMIT` con `git ls-tree` + `git cat-file`, y este
 * archivo queda además fuera por `SELF_REFERENTIAL`.
 *
 * ── EL SORTEO: NADIE ELIGE QUÉ SE ETIQUETA ─────────────────────────────────
 *
 * `drawReservedSample` es un Fisher-Yates con un PRNG determinista (xorshift32
 * sembrado con `SAMPLE_SEED`) sobre el marco ordenado. Cualquiera lo re-corre y
 * obtiene los mismos 120 sitios. Que el que mide elija a mano qué tokens mirar
 * es la otra forma de la misma trampa.
 *
 * **Estratificado por FORMA (P3 / P4), n = 60 + 60.** La forma la produce
 * `scanSource` desde el 2026-08-19 y **no participa de ninguna regla de la
 * cascada**, así que estratificar por ella no contamina la medición. ⛔ Nunca
 * por la etiqueta predicha. El motivo de estratificar es de potencia y está
 * medido: las citas son ~38 % de P3 y ~1,4 % de P4, así que un sorteo simple de
 * 120 traería ~2 citas de P4 y no diría nada del falso negativo.
 *
 * Qué afirma cada estrato, y nada más:
 *   · **P3 → PRECISIÓN.** Es donde se concentran los positivos.
 *   · **P4 → COTA SUPERIOR DEL FALSO NEGATIVO.** Es el estrato masivo y casi
 *     vacío de citas; sirve para acotar lo que el clasificador NO ve.
 * El agregado se pondera por el tamaño de cada estrato en el marco.
 *
 * Exemplar: `test/ownership-filter-guard.exceptions.ts` (datos escritos a mano
 * leyendo el sitio, nunca volcando la salida del escáner que los consume) y
 * `test/ownership-filter-guard.scanner.ts` (derivador puro sobre texto).
 */

import { type BareLabel, type FoundCite, scanSource } from './cited-lines-guard.scanner.js';

/** La semilla del sorteo. Se escribe acá para que el sorteo sea reproducible. */
export const SAMPLE_SEED = 'WKH-371';

/**
 * El commit contra el que se derivó el marco (CD-21). `main` en el momento de
 * abrir la rama de esta HU, o sea ANTES de que existieran este archivo y las
 * excepciones que la HU agrega.
 */
export const SAMPLE_BASE_COMMIT = '19405baf7f173033c4ef81dc8380238f1cda73ba';

/** El tamaño de cada estrato. */
export const STRATUM_N = 60;

/**
 * Los archivos AUTO-REFERENTES: quedan fuera del universo del clasificador y
 * fuera del marco de la muestra.
 *
 * Los 7 primeros son DT-11 — los dos guardianes cuyos `:N` sueltos son, en su
 * mayoría, el REGISTRO de citas de otros archivos y no afirmaciones propias.
 *
 * 🔴 El OCTAVO es ESTE MISMO ARCHIVO (CD-20). Cada entrada de `RESERVED_SAMPLE`
 * contiene el `target` que el clasificador tiene que producir; si el
 * clasificador lo leyera como contexto, estaría leyendo la respuesta — que es
 * exactamente el defecto de «un control que se lee a sí mismo». No es
 * hipotético: `paragraphOf` toma la corrida de líneas alrededor del token, y en
 * un literal de objeto el `target: '…'` está DOS líneas más abajo del
 * `cite: ':N'`.
 */
export const SELF_REFERENTIAL: readonly string[] = [
  'test/cited-lines-guard.scanner.ts',
  'test/cited-lines-guard.test.ts',
  'test/cited-lines-guard.citations.ts',
  'test/cited-lines-guard.exceptions.ts',
  'test/ownership-filter-guard.scanner.ts',
  'test/ownership-filter-guard.test.ts',
  'test/ownership-filter-guard.exceptions.ts',
  'test/cited-lines-guard.sample.ts',
];

/** Un sitio sorteado, identificado sin ambigüedad dentro del citador. */
export interface SampleSite {
  /** Archivo CITADOR, path relativo al commit base. */
  readonly file: string;
  /** Línea 1-based del citador donde aparece el token. */
  readonly line: number;
  /** El token literal. P3 incluye sus backticks. */
  readonly cite: string;
  readonly form: 'P3' | 'P4';
  /**
   * Ordinal 0-based entre las ocurrencias que comparten `(file, line, cite)`.
   * Sin esto, los dos `:00` de un mismo timestamp serían el mismo sitio.
   */
  readonly nth: number;
}

/** Un sitio con su etiqueta escrita a mano ABRIENDO el sitio (CD-11). */
export interface LabeledSite extends SampleSite {
  readonly label: BareLabel;
  /** Presente si y sólo si `label === 'CITA'`: el archivo que la cita apunta. */
  readonly target?: string;
  /** El motivo, de una línea, LEÍDO EN EL SITIO. ⛔ Nunca volcado de nada. */
  readonly reason: string;
}

/**
 * Clave de una ocurrencia dentro del marco. Misma convención que el `citeKey`
 * del guardián, más la línea y el ordinal para desambiguar repeticiones.
 */
export function siteKey(s: SampleSite): string {
  return `${s.file} :: ${s.line} :: ${s.cite} :: ${s.nth}`;
}

/** Clave con la que el ORÁCULO PREEXISTENTE identifica una cita: `from :: cite`. */
export function oracleKey(file: string, cite: string): string {
  return `${file} :: ${cite}`;
}

/**
 * El MARCO: las ocurrencias P3/P4 sorteables.
 *
 * PURA sobre texto — recibe los fuentes ya leídos (del commit base) y el
 * conjunto de claves del oráculo preexistente. No toca disco por la misma razón
 * que el escáner: un derivador que sólo se pudiera invocar sobre el árbol real
 * no se puede probar con una respuesta conocida de antemano.
 *
 * El orden de salida es total y estable —`(file, line, cite, nth)`— porque el
 * sorteo depende de él: un marco en otro orden sortea otros 120 sitios.
 */
export function sampleFrame(
  sources: ReadonlyMap<string, string>,
  oracleKeys: ReadonlySet<string>,
): readonly SampleSite[] {
  const out: SampleSite[] = [];
  const files = [...sources.keys()].sort();
  for (const file of files) {
    if (SELF_REFERENTIAL.includes(file)) continue;
    const seen = new Map<string, number>();
    const hits: readonly FoundCite[] = scanSource(sources.get(file) as string, file);
    for (const h of hits) {
      if (h.form !== 'P3' && h.form !== 'P4') continue;
      const k = `${h.line} :: ${h.cite}`;
      const nth = seen.get(k) ?? 0;
      seen.set(k, nth + 1);
      if (oracleKeys.has(oracleKey(file, h.cite))) continue;
      out.push({ file, line: h.line, cite: h.cite, form: h.form, nth });
    }
  }
  return out.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.cite.localeCompare(b.cite) ||
      a.nth - b.nth,
  );
}

/**
 * xorshift32. Determinista, 32 bits, sin dependencias — el punto es que
 * cualquiera pueda re-correr el sorteo, no la calidad estadística.
 */
export function xorshift32(seed: number): () => number {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return (): number => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

/** FNV-1a de 32 bits: convierte `SAMPLE_SEED` en la semilla numérica. */
export function seedFrom(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * El SORTEO: `STRATUM_N` de P3 y `STRATUM_N` de P4, Fisher-Yates con
 * `xorshift32`. La salida vuelve al orden `(file, line, cite, nth)` para que el
 * archivo se pueda leer, pero la SELECCIÓN es la del sorteo.
 *
 * Si un estrato tuviera menos de `STRATUM_N` elementos, se devuelve entero: es
 * un censo de ese estrato y el intervalo lo refleja.
 */
export function drawReservedSample(
  frame: readonly SampleSite[],
  seed: string,
): readonly SampleSite[] {
  const rnd = xorshift32(seedFrom(seed));
  const pick = (form: 'P3' | 'P4'): SampleSite[] => {
    const pool = frame.filter((s) => s.form === form).slice();
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = rnd() % (i + 1);
      const tmp = pool[i] as SampleSite;
      pool[i] = pool[j] as SampleSite;
      pool[j] = tmp;
    }
    return pool.slice(0, STRATUM_N);
  };
  return [...pick('P3'), ...pick('P4')].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.cite.localeCompare(b.cite) ||
      a.nth - b.nth,
  );
}

/**
 * LOS 120 SITIOS SORTEADOS, CON SU ETIQUETA ESCRITA A MANO.
 *
 * ⛔ NO SE GENERA VOLCANDO LA SALIDA DE NADA (CD-11). Cada `label`, cada
 * `target` y cada `reason` salió de abrir el archivo en la línea indicada y leer
 * la oración. El `reason` es la evidencia de que el sitio se abrió: describe
 * QUÉ dice la línea, no qué regla la clasifica.
 *
 * Se llena en el commit S2, y `classifyBareCite` no existe hasta S3.
 */
export const RESERVED_SAMPLE: readonly LabeledSite[] = [];
