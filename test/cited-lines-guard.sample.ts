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
 * ── LA ÚNICA CONVENCIÓN DE ETIQUETADO QUE HIZO FALTA DECIDIR ───────────────
 *
 * **Una cita cuyo destino vive en OTRO repo se etiqueta `INDECIDIBLE`, no
 * `CITA`.** Motivo: `target` es un path del índice de git de ESTE repo, y una
 * cita a `wasiai-remittance-agents/src/manifest/registry.ts:77` no tiene uno
 * —ese repo aporta **0** archivos al índice de éste—. Etiquetarla `CITA` con un
 * target que ningún guardián puede abrir sería declarar verificable algo que no
 * lo es. El `reason` de esos sitios dice que el destino es cross-repo, así que
 * la decisión queda auditable en vez de escondida en un número.
 *
 * ⚠️ Ninguna otra convención hizo falta: los 118 sitios restantes se
 * resolvieron leyendo la oración. En particular, **el número de línea puede
 * estar podrido y la etiqueta sigue siendo `CITA`** — lo que se etiqueta es a
 * QUÉ ARCHIVO apunta el token, que es la pregunta que el clasificador contesta;
 * si además la línea sigue diciendo lo que la prosa afirma es otra pregunta, y
 * la contesta `G-C5` con su `mustContain`.
 *
 * Se llena en el commit S2, y `classifyBareCite` no existe hasta S3.
 */
export const RESERVED_SAMPLE: readonly LabeledSite[] = [
  // ── scripts/ ─────────────────────────────────────────────────────────────
  {
    file: 'scripts/smoke-base-sepolia.mjs',
    line: 21,
    cite: ':3001',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'La línea documenta una env var: «gateway base URL (default: http://localhost:3001)». Es el PUERTO del gateway.',
  },

  // ── src/__tests__ ────────────────────────────────────────────────────────
  {
    file: 'src/__tests__/erc8004-identity-bridge.e2e.test.ts',
    line: 345,
    cite: ':00',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Campo de un fixture: `verified_at: \'2026-05-10T00:00:00.000Z\'`. Es la hora de un timestamp ISO.',
  },

  // ── src/adapters ─────────────────────────────────────────────────────────
  {
    file: 'src/adapters/__tests__/avalanche.test.ts',
    line: 264,
    cite: ':43113',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Es el chain id de un identificador CAIP-2: `network: \'eip155:43113\'` (Avalanche Fuji).',
  },
  {
    file: 'src/adapters/escrow/debit-capture.ownership.test.ts',
    line: 15,
    cite: '`:236-242`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/adapters/escrow/debit-capture.ts',
    reason: 'La oración habla del veredicto EN MEMORIA del código de producción: «pasa de `SIGNER_MISMATCH` (`:236-242`) a `valid` (`:247`)», y el mismo párrafo nombra `debit-capture.ts:275-287`.',
  },
  {
    file: 'src/adapters/escrow/debit-capture.ownership.test.ts',
    line: 25,
    cite: '`:205-206`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/adapters/escrow/debit-capture.ts',
    reason: '«El comentario de producción DOS LÍNEAS ARRIBA del filtro ya lo dice (`:205-206`)»: el filtro es el del código de producción, que el párrafo nombra como `debit-capture.ts:288`.',
  },
  {
    file: 'src/adapters/escrow/debit-capture.ownership.test.ts',
    line: 33,
    cite: '`:199-202`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/adapters/escrow/debit-capture.ownership.test.ts',
    reason: 'AUTO-CITA declarada en el propio texto: «`mockRpc.mockResolvedValue(...)` de ESTE archivo, `:199-202`».',
  },
  {
    file: 'src/adapters/escrow/debit-capture.ownership.test.ts',
    line: 42,
    cite: '`:85`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/adapters/escrow/debit-capture.test.ts',
    reason: '«dos dobles que son `eq: () => builder` (`:85`, `:469`)»: los dobles son los de `debit-capture.test.ts`, que el mismo párrafo nombra en `debit-capture.test.ts:539`.',
  },
  {
    file: 'src/adapters/escrow/debit-capture.ownership.test.ts',
    line: 50,
    cite: '`:539`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/adapters/escrow/debit-capture.test.ts',
    reason: '«corriendo … `debit-capture.test.ts` da `Tests 1 failed | 19 passed (20)`, rojo en `:539`»: el rojo es de ese archivo, nombrado dos líneas antes en el comando.',
  },
  {
    file: 'src/adapters/escrow/debit-capture.ownership.test.ts',
    line: 155,
    cite: '`:230-235`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/adapters/escrow/debit-capture.ts',
    reason: 'Abierto: `debit-capture.ts:230-235` es exactamente la ventana `[now, now + 3600]` (`DEADLINE_EXPIRED` / `DEADLINE_TOO_FAR`). El párrafo no nombra ningún archivo.',
  },
  {
    file: 'src/adapters/escrow/debit-capture.ownership.test.ts',
    line: 254,
    cite: '`:236-249`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/adapters/escrow/debit-capture.ts',
    reason: '«La decisión es del código (`:236-249`), no del doble»: «el código» es el de producción, no este archivo de test.',
  },
  {
    file: 'src/adapters/escrow/debit-capture.ownership.test.ts',
    line: 255,
    cite: '`:275-287`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/adapters/escrow/debit-capture.ts',
    reason: '«se lee en los argumentos con los que llamó al RPC (`:275-287`)»: la llamada al RPC vive en el código de producción; acá sólo se leen sus argumentos.',
  },
  {
    file: 'src/adapters/escrow/debit-capture.test.ts',
    line: 12,
    cite: '`:85`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/adapters/escrow/debit-capture.test.ts',
    reason: 'AUTO-CITA: «sus dobles NO aplican los filtros (`:85` y `:469` son `eq: () => builder`)», y «sus» es el docblock de cabecera hablando de este mismo archivo.',
  },
  {
    file: 'src/adapters/solana/facilitator-settle.ts',
    line: 416,
    cite: '`:360`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/adapters/solana/facilitator-settle.ts',
    reason: 'AUTO-CITA: «Arriba se aplica dos veces … al CUERPO (`:360`) y al CAMPO (`:372`)», y «arriba» es este mismo archivo.',
  },
  {
    file: 'src/adapters/solana/facilitator-settle.ts',
    line: 583,
    cite: '`:338`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/index.ts',
    reason: '«los dos warm-ups vecinos de `src/index.ts` (`if (isEscrowSettleEnabled()) …` en `:338`»: el archivo lo nombra la misma oración.',
  },
  {
    file: 'src/adapters/solana/facilitator-settle.ts',
    line: 584,
    cite: '`:345`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/index.ts',
    reason: 'Segunda cita de la misma oración que la anterior: «`if (process.env.SOLANA_ADAPTER_ENABLED === \'true\') …` en `:345`», dentro de `src/index.ts`.',
  },
  {
    file: 'src/adapters/solana/facilitator-settle.wiring.test.ts',
    line: 94,
    cite: '`:345`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/index.ts',
    reason: '«Los dos warm-ups vecinos SÍ llevan su `if` en el call-site (`src/index.ts:338` y `:345`)»: el archivo está nombrado en la línea anterior.',
  },
  {
    file: 'src/adapters/solana/intent-dedup.test.ts',
    line: 470,
    cite: ':0',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Sufijo de un identificador de intent en un literal: `seedRow(\'run:0\')`.',
  },
  {
    file: 'src/adapters/solana/intent-dedup.test.ts',
    line: 497,
    cite: ':0',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Ídem: `freshAdapter.settle(req(\'run:0\'))`, el `0` es parte del id del intent.',
  },
  {
    file: 'src/adapters/solana/intent-dedup.test.ts',
    line: 675,
    cite: ':0',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Ídem: `seedRow(\'run:0\', { status: \'claimed\', signature: null })`.',
  },
  {
    file: 'src/adapters/solana/intent-dedup.test.ts',
    line: 677,
    cite: ':0',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Ídem: `adapter.settle(req(\'run:0\'))` dentro del `expect(...).rejects`.',
  },
  {
    file: 'src/adapters/solana/intent-dedup.test.ts',
    line: 827,
    cite: ':0',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Ídem: `seedRow(\'run:0\')` en el test del 503 del RPC.',
  },
  {
    file: 'src/adapters/solana/intent-dedup.test.ts',
    line: 907,
    cite: ':0',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Ídem: `adapter.settle(req(\'run:0\')).catch(...)`.',
  },
  {
    file: 'src/adapters/solana/intent-dedup.test.ts',
    line: 1040,
    cite: ':0',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Ídem: `await adapter.settle(req(\'run:0\'))`, primera de tres llamadas con ids `run:0`/`run:1`/`run:2`.',
  },
  {
    file: 'src/adapters/solana/intent-dedup.test.ts',
    line: 1740,
    cite: ':0',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Ídem: `adapter.settle(req(\'run:0\')).catch((e: Error) => e)`.',
  },
  {
    file: 'src/adapters/solana/payment.flag.test.ts',
    line: 529,
    cite: ':0',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Sufijo del id de intent en `settleReq(\'run-shared:0\')`.',
  },
  {
    file: 'src/adapters/solana/payment.flag.test.ts',
    line: 562,
    cite: ':0',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Clave de un Map con el mismo id: `rows.get(\'run-idem3:0\')`.',
  },
  {
    file: 'src/adapters/solana/payment.test.ts',
    line: 267,
    cite: ':0',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Segmento del medio de un id compuesto: `intentId: \'ctx-1:0:payTo\'`.',
  },
  {
    file: 'src/adapters/solana/payment.test.ts',
    line: 458,
    cite: ':1',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Ídem: `intentId: \'ctx-timeout:1:payTo\'`.',
  },
  {
    file: 'src/adapters/solana/payment.test.ts',
    line: 591,
    cite: ':2',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Ídem: `intentId: \'ctx-timeout:2:payTo\'`.',
  },
  {
    file: 'src/adapters/solana/payment.test.ts',
    line: 820,
    cite: ':1',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Ídem: `intentId: \'ctx-order:1:payTo\'`.',
  },
  {
    file: 'src/adapters/solana/settle-ledger.test.ts',
    line: 248,
    cite: ':0',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Sufijo del id: `intentId: \'run-1:0\'` en el argumento de `recordSignedIntent`.',
  },

  // ── src/lib ──────────────────────────────────────────────────────────────
  {
    file: 'src/lib/agent-http-error.ts',
    line: 54,
    cite: ':2',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Es el cuerpo de un POST transcripto en la prosa de una tabla: `{"amountUsd":2}`. El `2` es el monto, no una línea.',
  },
  {
    file: 'src/lib/capability-risk.ts',
    line: 85,
    cite: '`:77`',
    form: 'P3',
    nth: 0,
    label: 'INDECIDIBLE',
    reason: 'El destino está en OTRO repo: «declaradas en `wasiai-remittance-agents/src/manifest/registry.ts:76` y `:77`», y `wasiai-remittance-agents` no está en el índice de git de éste (0 archivos).',
  },
  {
    file: 'src/lib/capability-risk.ts',
    line: 100,
    cite: '`:300`',
    form: 'P3',
    nth: 0,
    label: 'INDECIDIBLE',
    reason: 'Mismo caso cross-repo: «`wasiai-remittance-agents/src/manifest/registry.ts:275` y `:300`». Ningún guardián de este repo puede abrir ese archivo.',
  },
  {
    file: 'src/lib/contracting-chain.ts',
    line: 39,
    cite: '`:82`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/lib/self-published-auth.ts',
    reason: '«⛔ NO reusar `canonicalizeHostKey` de `src/lib/self-published-auth.ts:89-105`. Su docblock (`:82`) afirma…»: «su» es el de ese archivo, nombrado la línea anterior.',
  },
  {
    file: 'src/lib/outbound-timeout.ts',
    line: 42,
    cite: '`:594`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/adapters/kite-ozone/payment.ts',
    reason: '«`kite-ozone` modo x402 `:594`» dentro de la lista de caminos de settle ya acotados; dos líneas después el mismo párrafo escribe `kite-ozone/payment.ts` con todas las letras.',
  },
  {
    file: 'src/lib/refund-idem.test.ts',
    line: 47,
    cite: ':3',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Segmento del medio del valor de `slot`: `\'compose-step:3:d2\'`. Es el índice del step, no una línea.',
  },
  {
    file: 'src/lib/refund-idem.ts',
    line: 82,
    cite: ':3',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Ejemplo de valor de `slot` enumerado en el docblock del campo: «`gasless`, `compose-step0`, `compose-step:3:d1`, `orchestrate-step0`…».',
  },
  {
    file: 'src/lib/ssrf-dispatcher.ts',
    line: 365,
    cite: '`:8443`',
    form: 'P3',
    nth: 0,
    label: 'RUIDO',
    reason: 'Puertos de ejemplo, y BACKTICKEADOS: «an explicit non-default port on either side (e.g. `:8080`, `:8443`)». Es la prueba de que los backticks no discriminan.',
  },
  {
    file: 'src/lib/trial-standing.test.ts',
    line: 439,
    cite: ':00',
    form: 'P4',
    nth: 1,
    label: 'RUIDO',
    reason: 'Minutos de un timestamp ISO en un fixture: `cand(\'a\', \'owner-1\', \'2026-01-01T00:00:00Z\')`.',
  },
  {
    file: 'src/lib/url-validator.ts',
    line: 130,
    cite: ':0',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Es una dirección IPv6 escrita en la tabla del docblock: «`::`, `0:0:0:0:0:0:0:0` — unspecified».',
  },
  {
    file: 'src/lib/url-validator.ts',
    line: 130,
    cite: ':0',
    form: 'P4',
    nth: 2,
    label: 'RUIDO',
    reason: 'Tercera ocurrencia del mismo `0:0:0:0:0:0:0:0` de esa línea. Mismo motivo: es la dirección IPv6 «unspecified».',
  },

  // ── src/middleware ───────────────────────────────────────────────────────
  {
    file: 'src/middleware/charged-route.test.ts',
    line: 351,
    cite: ':1',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Valor de un campo dentro de un JSON transcripto como string: `json: \'{"messages":[{"role":"user"}],"n":1}\'`.',
  },

  // ── src/routes ───────────────────────────────────────────────────────────
  {
    file: 'src/routes/agent-card.test.ts',
    line: 254,
    cite: ':420',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Segmento del medio del triple de reputación on-chain: `value: \'3:420:2\'`.',
  },
  {
    file: 'src/routes/agent-card.test.ts',
    line: 267,
    cite: ':2',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Último segmento del mismo triple `\'3:420:2\'`, esta vez en el `expect`.',
  },
  {
    file: 'src/routes/auth.erc8004.test.ts',
    line: 122,
    cite: ':00',
    form: 'P4',
    nth: 1,
    label: 'RUIDO',
    reason: 'Segundos de un timestamp de fixture: `daily_reset_at: \'2026-04-07T00:00:00.000Z\'`.',
  },
  {
    file: 'src/routes/auth.erc8004.test.ts',
    line: 129,
    cite: ':00',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Minutos de `created_at: \'2026-04-06T12:00:00.000Z\'`.',
  },
  {
    file: 'src/routes/auth.test.ts',
    line: 146,
    cite: ':00',
    form: 'P4',
    nth: 1,
    label: 'RUIDO',
    reason: 'Segundos de `created_at: \'2026-04-06T12:00:00.000Z\'`.',
  },
  {
    file: 'src/routes/compose.no-charge-on-validation-error.test.ts',
    line: 1051,
    cite: '`:839`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/middleware/a2a-key.ts',
    reason: '«El hook `onDebitOrphaned` se invoca en TRES sitios — el tercero y el cuarto son delegación (`:839`) y key-session (`:1065`)», y el sitio MASTER lo nombra `a2a-key.ts:1316` dos líneas antes.',
  },
  {
    file: 'src/routes/compose.no-charge-on-validation-error.test.ts',
    line: 1056,
    cite: '`:352`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/compose.ts',
    reason: '«una rama DISTINTA de `refundComposeStep0` (`compose.ts:343` creditDelegation / `:352` creditSession)»: el archivo lo nombra la misma oración, y `refundComposeStep0` vive en el servicio, no en la ruta.',
  },
  {
    file: 'src/routes/dashboard.tablero.test.ts',
    line: 81,
    cite: ':00',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Minutos de `daily_reset_at: \'2026-08-27T00:00:00.000Z\'` en el fixture del tablero.',
  },
  {
    file: 'src/routes/dashboard.tablero.test.ts',
    line: 340,
    cite: ':00',
    form: 'P4',
    nth: 1,
    label: 'RUIDO',
    reason: 'Segundos del reloj falso: `vi.setSystemTime(new Date(\'2026-08-26T12:00:00.000Z\'))`.',
  },
  {
    file: 'src/routes/gasless.refund.test.ts',
    line: 264,
    cite: ':00',
    form: 'P4',
    nth: 1,
    label: 'RUIDO',
    reason: 'Segundos de `created_at: \'2026-04-06T12:00:00.000Z\'`.',
  },
  {
    file: 'src/routes/gasless.test.ts',
    line: 163,
    cite: ':2368',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Chain id de un CAIP-2 en un mock: `name: \'eip155:2368\'`, y la línea de abajo lo repite como `chainId: 2368`.',
  },
  {
    file: 'src/routes/payments.dispute-ownership.test.ts',
    line: 22,
    cite: '`:76-77`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/routes/agents.ownership.test.ts',
    reason: '«Su mock de supabase NO sirve acá: registra los `.eq()` (`:72`) pero `maybeSingle`/`single` (`:76-77`) devuelven `state.row`…», y «su» es el de `agents.ownership.test.ts`, nombrado en el título del bloque.',
  },
  {
    file: 'src/routes/payments.dispute-ownership.test.ts',
    line: 102,
    cite: ':00',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Minutos de `created_at: \'2026-08-05T00:00:00.000Z\'` en el constructor de la fila de fixture.',
  },

  // ── src/services ─────────────────────────────────────────────────────────
  {
    file: 'src/services/__tests__/owner-scoped-fake.ts',
    line: 57,
    cite: '`:538`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/fee-split.ts',
    reason: '«Lo pidieron los tres UPDATE de `src/services/fee-split.ts` (`:538`, `:618`, `:697`)»: el archivo está nombrado con path completo en la misma oración.',
  },
  {
    file: 'src/services/__tests__/owner-scoped-fake.ts',
    line: 57,
    cite: '`:618`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/fee-split.ts',
    reason: 'Segunda cita de la misma enumeración de tres UPDATE de `src/services/fee-split.ts`.',
  },
  {
    file: 'src/services/agent-detail.ts',
    line: 141,
    cite: '`:277-284`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/discovery.ts',
    reason: '«el `REGISTRY_SOURCE_FAILED` que `discovery.ts:408-415` (fan-out de registros; el `:277-284` es el gemelo de la fuente LOCAL) emite»: el gemelo está en el mismo archivo recién nombrado.',
  },
  {
    file: 'src/services/agent.ownership.test.ts',
    line: 22,
    cite: '`:712-716`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/agent.ts',
    reason: '«`agentService.delete` hace `this.getRow(slug)` SIN filtro de dueño (`:692`) … y recién ahí ejecuta el DELETE (`:712-716`)»: es el servicio, y este archivo tiene 154 líneas, así que ni siquiera puede ser una auto-cita.',
  },
  {
    file: 'src/services/arbiter.ownership.test.ts',
    line: 19,
    cite: '`:385`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/arbiter.test.ts',
    reason: '«Su doble de supabase (`arbiter.test.ts:340-430`) … aplica `id` (`:385`) y `status` (`:420`)»: el archivo lo nombra la línea anterior.',
  },
  {
    file: 'src/services/arbiter.ownership.test.ts',
    line: 29,
    cite: '`:1064`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/arbiter.ts',
    reason: '«métodos del objeto exportado `arbiterService` (`arbiter.ts:576`, `:1064`, `:1090`)»: enumeración de tres líneas del mismo archivo, nombrado primero.',
  },
  {
    file: 'src/services/arbiter.ownership.test.ts',
    line: 29,
    cite: '`:1090`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/arbiter.ts',
    reason: 'Tercera cita de la misma enumeración `(`arbiter.ts:576`, `:1064`, `:1090`)`.',
  },
  {
    file: 'src/services/arbiter.ownership.test.ts',
    line: 287,
    cite: '`:208`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/arbiter.ts',
    reason: '«`getOrCreateArbiterNonce` es privada (`arbiter.ts:100`). Se llega por `settleArbitrationOnChain` (`:175`, exportada), que la llama en `:208`»: todo el párrafo recorre `arbiter.ts`.',
  },
  {
    file: 'src/services/arbiter.ownership.test.ts',
    line: 288,
    cite: '`:186-209`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/arbiter.ts',
    reason: '«sólo después de cuatro gates en cascada (`:186-209`)»: los gates son los de `settleArbitrationOnChain`, en `arbiter.ts`.',
  },
  {
    file: 'src/services/arbiter.ownership.test.ts',
    line: 341,
    cite: '`:1398`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/arbiter.test.ts',
    reason: '«El idioma del repo es `delete` (`arbiter.test.ts:461`, `:463`, `:1398`, `:1730`, `:1747`)»: enumeración de cinco líneas del archivo nombrado primero.',
  },
  {
    file: 'src/services/arbiter.ownership.test.ts',
    line: 341,
    cite: '`:463`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/arbiter.test.ts',
    reason: 'Segunda cita de esa misma enumeración de cinco.',
  },
  {
    file: 'src/services/arbiter.ownership.test.ts',
    line: 342,
    cite: '`:1730`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/arbiter.test.ts',
    reason: 'Cuarta cita de la misma enumeración, que arranca en la línea anterior con `arbiter.test.ts:461`.',
  },
  {
    file: 'src/services/arbiter.ownership.test.ts',
    line: 362,
    cite: '`:212-219`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/arbiter.ts',
    reason: 'Abierto: `arbiter.ts:212-219` es literalmente la llamada `await executeResolveDispute({ chainKey, escrowContract, keyIdHash, seller, sellerAmount, nonce })`. El párrafo no nombra archivo.',
  },
  {
    file: 'src/services/arbiter/evidence.ownership.test.ts',
    line: 7,
    cite: '`:57`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/arbiter/evidence.ts',
    reason: '«`src/services/arbiter/evidence.ts` tiene `.eq(\'owner_ref\', ownerRef)` en `:57` (intent), `:76` (vouchers) y `:96` (recibos)»: path completo en la misma oración.',
  },
  {
    file: 'src/services/arbiter/evidence.ownership.test.ts',
    line: 18,
    cite: '`:42`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/arbiter/evidence.test.ts',
    reason: '«Su doble de supabase es `eq: () => b` (`evidence.test.ts:55`) … Y su fixture tiene un solo dueño (`OWNER`, `:42`)»: «su» es el de `evidence.test.ts`.',
  },
  {
    file: 'src/services/arbiter/evidence.test.ts',
    line: 14,
    cite: '`:57`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/arbiter/evidence.ts',
    reason: '«los tres `.eq(\'owner_ref\', …)` de `evidence.ts` (`:57`, `:76`, `:96`)»: el archivo lo nombra la misma oración, dos palabras antes.',
  },
  {
    file: 'src/services/arbiter/evidence.test.ts',
    line: 14,
    cite: '`:76`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/arbiter/evidence.ts',
    reason: 'Segunda cita de esa misma enumeración de tres filtros de `evidence.ts`.',
  },
  {
    file: 'src/services/compose.test.ts',
    line: 202,
    cite: ':00',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Minutos de `created_at: \'2026-04-27T00:00:00.000Z\'` en la fila de key de fixture.',
  },
  {
    file: 'src/services/compose.test.ts',
    line: 4295,
    cite: '`:1580`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/compose.ts',
    reason: '«sale de que `result.output` se asigna antes del bloque del bridge (`compose.ts:1536-1538`) y de que el bloque está gateado en `i < steps.length - 1` (`:1580`)»: el archivo lo nombra la línea anterior.',
  },
  {
    file: 'src/services/discovery.sources.test.ts',
    line: 603,
    cite: '`:1166`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/discovery.ts',
    reason: '«`discovery.ts:1162-1164` lanza `RegistryHttpError` ANTES del `await response.json()` de `:1166`»: el archivo lo nombra la línea anterior.',
  },
  {
    file: 'src/services/discovery.ssrf.test.ts',
    line: 15,
    cite: ':169',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Es la IP del vector de metadatos escrita en IPv6-mapped: «rejects `::ffff:169.254.169.254` (DT-B vector)».',
  },
  {
    file: 'src/services/discovery.trial.test.ts',
    line: 1120,
    cite: ':00',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Minutos de `createdAt: \'2026-01-01T00:00:00Z\'` en el ancla de un agente de fixture.',
  },
  {
    file: 'src/services/discovery.trial.test.ts',
    line: 1290,
    cite: ':00',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Minutos de `\'2026-02-02T00:00:00Z\'` en la tupla `[\'pay-2\', \'owner-sybil\', …]`.',
  },
  {
    file: 'src/services/discovery.ts',
    line: 108,
    cite: ':0',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Está DENTRO de un literal de expresión regular: `/^eip155:(\\d+):0x[0-9a-fA-F]{40}\\/([0-9]+)$/`. El `0` es el del prefijo hexadecimal `0x`.',
  },
  {
    file: 'src/services/fee-charge.ts',
    line: 518,
    cite: ':419',
    form: 'P4',
    nth: 0,
    label: 'CITA',
    target: 'src/services/fee-charge.ts',
    reason: 'AUTO-CITA verificada abriendo el destino: «el reintento ya lo bloquea el 23505 de :419», y `fee-charge.ts:419` es el comentario «Paso 4: INSERT pending (ON CONFLICT DO NOTHING via unique_violation)» — 23505 ES unique_violation.',
  },
  {
    file: 'src/services/fee-split.ownership.test.ts',
    line: 8,
    cite: '`:618`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/fee-split.ts',
    reason: '«`src/services/fee-split.ts` lleva `.eq(\'owner_ref\', ownerRef)` en `:365` … `:538` … `:618` (`markLegFailed`) y `:697`»: path completo en la línea anterior.',
  },
  {
    file: 'src/services/fee-split.ownership.test.ts',
    line: 196,
    cite: '`:404-407`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/fee-split.ts',
    reason: '«el leg queda `in-progress` (`:404-407`), que es el camino real de la base»: es el código de producción; este archivo tiene 395 líneas y ni siquiera contiene la 404.',
  },
  {
    file: 'src/services/fee-split.ownership.test.ts',
    line: 235,
    cite: ':397',
    form: 'P4',
    nth: 0,
    label: 'CITA',
    target: 'src/services/fee-split.ts',
    reason: '«el INSERT no filtra: ESTAMPA el owner_ref (:397)», y las dos líneas vecinas del mismo literal escriben `fee-split.ts:365` y `fee-split.ts:538`.',
  },
  {
    file: 'src/services/fee-split.ownership.test.ts',
    line: 293,
    cite: '`:393-401`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/fee-split.ts',
    reason: '«el INSERT de `chargeLeg` (`:393-401`) no manda la columna»: `chargeLeg` es la función del servicio, no de este test.',
  },
  {
    file: 'src/services/fee-split.ownership.test.ts',
    line: 305,
    cite: '`:540-547`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/fee-split.ts',
    reason: '«`updateErr` queda `null`, `:540-547` NO CORRE»: el párrafo escribe `fee-split.ts:540-547` tres líneas antes, con el nombre.',
  },
  {
    file: 'src/services/fee-split.ownership.test.ts',
    line: 358,
    cite: '`:676-683`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/fee-split.ts',
    reason: '«El pre-chequeo de `:676-683` filtra `rows` por dueño EN MEMORIA»: es `reverseFeeSplits` del servicio; el título del `it` de la línea anterior dice `fee-split.ts:697`.',
  },
  {
    file: 'src/services/fee-split.ownership.test.ts',
    line: 377,
    cite: '`:707`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/fee-split.ts',
    reason: '«No es sólo el contador (`reversedCount += 1`, `:707`)»: `reversedCount` es una variable del servicio, y este archivo tiene 395 líneas.',
  },
  {
    file: 'src/services/fee-split.ownership.test.ts',
    line: 378,
    cite: '`:708-717`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/fee-split.ts',
    reason: '«también `legs.push({ ... status: \'reversed\' })` (`:708-717`)»: sigue describiendo el cuerpo de `reverseFeeSplits`.',
  },
  {
    file: 'src/services/identity.require-signature.ownership.test.ts',
    line: 302,
    cite: '`:144`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/identity.ts',
    reason: '«este test dice CUÁL sitio quedó abierto (`identity.ts:143` vs `:144`)»: el archivo lo nombra la misma oración, contrastando las dos líneas.',
  },
  {
    file: 'src/services/identity.ts',
    line: 254,
    cite: '`:357`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/identity.ts',
    reason: 'AUTO-CITA: «el mismo criterio, y el mismo comentario, que `bindPassport` (`:289`) y `bindErc8004Identity` (`:357`)» — las dos son funciones de este archivo.',
  },
  {
    file: 'src/services/inbound-task.ownership.test.ts',
    line: 81,
    cite: ':00',
    form: 'P4',
    nth: 1,
    label: 'RUIDO',
    reason: 'Segundos de `updated_at: \'2026-08-05T00:00:00.000Z\'` en el constructor de la fila de fixture.',
  },
  {
    file: 'src/services/inbound-task.test.ts',
    line: 304,
    cite: '`:103-106`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/inbound-task.test.ts',
    reason: 'AUTO-CITA declarada: «el mock de este archivo (`:94-97` registra los `.eq()` en `ctx.eqs`; `:103-106` `maybeSingle` devuelve `getSingle`)».',
  },
  {
    file: 'src/services/inbound-task.test.ts',
    line: 304,
    cite: '`:94-97`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/inbound-task.test.ts',
    reason: 'La otra mitad de la misma auto-cita: «el mock de este archivo (`:94-97` registra los `.eq()` en `ctx.eqs`…)».',
  },
  {
    file: 'src/services/inbound-task.test.ts',
    line: 324,
    cite: '`:338`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/inbound-task.ts',
    reason: '«NO mira ninguno de los dos SELECT — ni el de `get` (`inbound-task.ts:316`) ni el de `getByExternalRef` (`:338`)»: el archivo lo nombra la misma oración.',
  },
  {
    file: 'src/services/llm/__tests__/transform-verification.test.ts',
    line: 374,
    cite: ':3',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Valor de una propiedad dentro del código que el LLM devuelve, transcripto como string: `\'return { a:1, b:2, c:3, d:4, e:5 };\'`.',
  },
  {
    file: 'src/services/llm/__tests__/transform-verification.test.ts',
    line: 374,
    cite: ':4',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Cuarta propiedad del mismo literal `\'return { a:1, b:2, c:3, d:4, e:5 };\'`.',
  },
  {
    file: 'src/services/llm/canonical-json.test.ts',
    line: 37,
    cite: ':1',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Es el JSON canónico esperado, escrito como string: `\'{"a":3,"outer":{"x":2,"y":1}}\'`. El `1` es el valor de `y`.',
  },
  {
    file: 'src/services/llm/canonical-json.test.ts',
    line: 47,
    cite: ':2',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Ídem: `\'[{"a":2,"b":1}]\'`, el `2` es el valor de `a`.',
  },
  {
    file: 'src/services/llm/transform.ownership.test.ts',
    line: 30,
    cite: '`:390`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/llm/transform.ts',
    reason: 'Abierto: `transform.ts:390` es `const cacheKey = \\`${sourceAgentId}:${targetAgentId}:${schemaHashValue}:${ownerSegment}\\``, o sea la clave que «ya incluye al dueño». El párrafo nombra `maybeTransform:392-402`, que es una función de ese archivo.',
  },
  {
    file: 'src/services/orchestrate.billing.test.ts',
    line: 171,
    cite: ':00',
    form: 'P4',
    nth: 1,
    label: 'RUIDO',
    reason: 'Segundos de `updated_at: \'2026-04-27T00:00:00.000Z\'` en la fila de key de fixture.',
  },
  {
    file: 'src/services/receipt.test.ts',
    line: 141,
    cite: ':56',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Segundos de un timestamp: `expect(parsed.created_at).toBe(\'2026-06-19T12:34:56.789Z\')`.',
  },
  {
    file: 'src/services/reconciliation.test.ts',
    line: 1421,
    cite: ':00',
    form: 'P4',
    nth: 1,
    label: 'RUIDO',
    reason: 'Segundos de `created_at: \'2026-07-29T00:00:00.000Z\'` en el constructor de fixture.',
  },
  {
    file: 'src/services/reconciliation.test.ts',
    line: 1622,
    cite: ':00',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Minutos del argumento `\'2026-07-29T00:00:00.000Z\'` de `countStrandedExposureSince`.',
  },
  {
    file: 'src/services/reconciliation.test.ts',
    line: 2003,
    cite: ':00',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Minutos de `debit_hop2_attempted_at: \'2026-07-29T10:00:00.000Z\'`.',
  },
  {
    file: 'src/services/spend-policy.ownership.test.ts',
    line: 10,
    cite: '`:190`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/spend-policy.ts',
    reason: 'Título de sección: «── `spend-policy.ts:163` y `:190`: SÍ hay ruta…». Más abajo el mismo archivo escribe el path completo `src/services/spend-policy.ts:163`, `:190`.',
  },
  {
    file: 'src/services/spend-policy.ownership.test.ts',
    line: 14,
    cite: '`:94-95`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/routes/auth/spend-policy.ts',
    reason: '«las dos pasan `callerKey.id` y `callerKey.owner_ref`, dos campos de la misma fila autenticada (`:94-95` y `:125-126`)»: las dos son las RUTAS, que el párrafo nombra `src/routes/auth/spend-policy.ts:79` y `:106`.',
  },
  {
    file: 'src/services/spend-policy.ownership.test.ts',
    line: 43,
    cite: '`:190`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/spend-policy.ts',
    reason: '«decía que `src/services/spend-policy.ts:163`, `:190` y `:219` "se pueden borrar hoy…"»: path completo en la misma oración.',
  },
  {
    file: 'src/services/spend-policy.ownership.test.ts',
    line: 43,
    cite: '`:219`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/spend-policy.ts',
    reason: 'Tercera cita de la misma enumeración `src/services/spend-policy.ts:163`, `:190` y `:219`.',
  },
  {
    file: 'src/services/spend-policy.ownership.test.ts',
    line: 46,
    cite: '`:344`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/spend-policy.test.ts',
    reason: '«ya tenían un espía de llamada preexistente en `src/services/spend-policy.test.ts` (`:292`, `:311`, `:344`)»: path completo en la línea anterior.',
  },
  {
    file: 'src/services/task.test.ts',
    line: 43,
    cite: ':00',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Minutos de `updated_at: \'2026-04-03T18:00:00.000Z\'` en el constructor de fixture.',
  },
  {
    file: 'src/services/trace.test.ts',
    line: 79,
    cite: ':00',
    form: 'P4',
    nth: 1,
    label: 'RUIDO',
    reason: 'Segundos de `created_at: \'2026-07-26T12:00:00.000Z\'`.',
  },
  {
    file: 'src/services/trace.test.ts',
    line: 408,
    cite: ':00',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Minutos de `created_at: \'2026-07-26T09:00:00.000Z\'` en el recibo `r1`.',
  },
  {
    file: 'src/services/trace.test.ts',
    line: 408,
    cite: ':00',
    form: 'P4',
    nth: 1,
    label: 'RUIDO',
    reason: 'Segundos del mismo `\'2026-07-26T09:00:00.000Z\'` de esa línea.',
  },
  {
    file: 'src/services/trace.ts',
    line: 260,
    cite: '`:258`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'src/services/budget.ts',
    reason: '«El débito al caller se emite con los tres en NULL (`middleware/a2a-key.ts:1268`, `services/budget.ts:174`/`:258`)»: el `/` separa dos líneas del MISMO archivo recién nombrado.',
  },

  // ── src/static ───────────────────────────────────────────────────────────
  {
    file: 'src/static/dashboard-trace.render.test.ts',
    line: 90,
    cite: ':3001',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Puerto del origen del `window` falso: `location: { origin: \'http://localhost:3001\' }`.',
  },
  {
    file: 'src/static/dashboard-tres-preguntas.render.test.ts',
    line: 75,
    cite: ':3001',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Ídem: `location: { origin: \'http://localhost:3001\' }` en el `window` falso del render test.',
  },
  {
    file: 'src/static/dashboard.html',
    line: 138,
    cite: ':220',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Valor de una propiedad CSS en el atributo `style` de un `<input>`: `max-width:220px`.',
  },
  {
    file: 'src/static/dashboard.html',
    line: 336,
    cite: ':0',
    form: 'P4',
    nth: 0,
    label: 'RUIDO',
    reason: 'Valor CSS dentro de un string de JS que arma HTML: `font-size:0.75rem`.',
  },

  // ── test/ ────────────────────────────────────────────────────────────────
  {
    file: 'test/readme-parity.test.ts',
    line: 9,
    cite: '`:349-355`',
    form: 'P3',
    nth: 0,
    label: 'CITA',
    target: 'README.md',
    reason: '«(Estaba en `:349-355` del árbol auditado, `3750e3a`…)»: la subsección era de `README.md`, nombrado tres líneas antes. ⚠️ Está anclada A PROPÓSITO a un commit PASADO, y el propio paréntesis lo dice.',
  },
];
