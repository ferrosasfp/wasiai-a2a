/**
 * Guardián: los dos README describen el mismo repo, así que citan los mismos
 * archivos y tienen la misma estructura de secciones.
 *
 * ⚠️ EL BUG QUE ESTE TEST EXISTE PARA CAZAR (medido 2026-08-15, auditoría
 * externa). `README.md` tenía la subsección **"Two independent gates for real
 * money"** — las dos compuertas que hay que pasar antes de que un pago a una
 * cadena mainnet llegue a producción, con las dos citas que lo sostienen — y
 * `README.es.md` no la tenía. (Estaba en `:349-355` del árbol auditado,
 * `3750e3a`; el número se escribe con su commit porque una línea se mueve sola.)
 * La agregó `2fbeb8a`, que tocó UN archivo:
 *
 *     $ git show --stat 2fbeb8a
 *     README.md | 8 ++++++++
 *     1 file changed, 8 insertions(+)
 *
 * El lector hispanohablante, que es el default de una incubadora LATAM, se
 * quedaba sin el argumento de seguridad del dinero real. Nadie lo vio en cuatro
 * meses porque el modo de falla de una traducción parcial no es decir algo
 * falso: es OMITIR, y una omisión no se ve leyendo el archivo que la tiene.
 *
 * ⚠️ POR QUÉ NO ALCANZA UN CHEQUEO DE TAMAÑO. En el repo hermano `chaski-v3` el
 * mismo bug (falta un párrafo entero en el ES) convive con dos archivos de
 * EXACTAMENTE 397 líneas cada uno: cualquier chequeo de paridad por tamaño da
 * verde. Acá los dos archivos ni siquiera miden lo mismo, así que un chequeo de
 * tamaño sería peor todavía: nunca podría estar en verde y se terminaría
 * borrando.
 *
 * QUÉ COMPARA, y por qué esas dos cosas:
 *
 *   1. EL CONJUNTO DE ARCHIVOS CITADOS. Es exactamente el instrumento con el que
 *      la auditoría encontró el agujero, y es barato: los dos documentos hablan
 *      del mismo código, así que la evidencia que ofrecen tiene que ser la
 *      misma. Medido al escribir esto: 43 referencias por idioma, y la única
 *      diferencia es el link cruzado de un README al otro.
 *   2. LA ESTRUCTURA DE TÍTULOS (la secuencia de niveles `#`/`##`). Caza la
 *      sección entera que falta aunque no cite ningún archivo, que es el caso
 *      que (1) dejaría pasar. Se comparan NIVELES, no textos: los títulos están
 *      traducidos y tienen que poder estarlo.
 *
 * QUÉ NO CUBRE (declarado, no arreglado):
 *   - un párrafo faltante que no cite archivos NI abra sección. La contención
 *     ahí es humana.
 *   - que la traducción DIGA lo mismo. Esto compara evidencia y estructura, no
 *     significado: un ES que cite los mismos archivos y afirme lo contrario pasa.
 *   - los números medidos de los dos README, que tienen su propio guardián en
 *     `test/readme-numbers.test.ts` y se verifican por idioma y por separado.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const EN = 'README.md';
const ES = 'README.es.md';

/** Los dos nombres de archivo que SÍ tienen que diferir: cada README linkea al
 *  otro en su primera línea. Excluirlos es el único caso especial. */
const CROSS_LINK = new Set([EN, ES]);

const FILE_REF =
  /\b[A-Za-z0-9_./-]+\.(?:ts|mjs|js|md|json|yml|yaml|sql)(?::\d+(?:-\d+)?)?/g;

function fileRefs(text: string): string[] {
  return [...new Set(text.match(FILE_REF) ?? [])]
    .filter((r) => !CROSS_LINK.has(r))
    .sort();
}

/** Los niveles de título, en orden, ignorando lo que esté dentro de un bloque
 *  de código: los ejemplos de `bash` de este README tienen comentarios que
 *  empiezan con `#` y se leerían como títulos. */
function headingLevels(text: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,6}) /);
    if (m) out.push(m[1] as string);
  }
  return out;
}

const TEXT: Record<string, string> = {
  [EN]: readFileSync(join(REPO_ROOT, EN), 'utf8'),
  [ES]: readFileSync(join(REPO_ROOT, ES), 'utf8'),
};

describe('los dos README describen el mismo repo', () => {
  it('el extractor encuentra algo (si diera vacío, la igualdad de abajo sería vacua)', () => {
    // Sin esto, un regex roto deja las dos listas en `[]` y el test aplaude.
    expect(fileRefs(TEXT[EN] as string).length).toBeGreaterThan(30);
    expect(fileRefs(TEXT[ES] as string).length).toBeGreaterThan(30);
    expect(headingLevels(TEXT[EN] as string).length).toBeGreaterThan(10);
    // Y que agarre las citas con línea, que son las que se perdieron.
    expect(fileRefs(TEXT[EN] as string)).toContain(
      'src/lib/downstream-payment.ts:186-194',
    );
  });

  it('★ citan exactamente los mismos archivos', () => {
    const en = fileRefs(TEXT[EN] as string);
    const es = fileRefs(TEXT[ES] as string);
    expect(
      es.filter((r) => !en.includes(r)),
      'Hay evidencia en el README en español que no está en el inglés.',
    ).toEqual([]);
    expect(
      en.filter((r) => !es.includes(r)),
      'Hay evidencia en el README en inglés que NO está en el español. Casi\n' +
        'siempre significa que un cambio se hizo en un solo idioma y el lector del\n' +
        'otro se quedó sin el argumento. Traducilo; no borres la cita del inglés.',
    ).toEqual([]);
  });

  it('tienen la misma estructura de secciones', () => {
    // Niveles, no textos: los títulos están traducidos a propósito.
    expect(headingLevels(TEXT[ES] as string)).toEqual(
      headingLevels(TEXT[EN] as string),
    );
  });

  it('los extractores no son vacuos (sin esto, todo lo de arriba pasa por vacío)', () => {
    // Una cita presente en un solo idioma tiene que verse. Es el bug de 2fbeb8a
    // reproducido en miniatura.
    const conCita = 'ver `src/lib/downstream-skip-code.ts:306` y listo';
    const sinCita = 'ver el mapa de códigos de skip y listo';
    expect(fileRefs(conCita)).toEqual(['src/lib/downstream-skip-code.ts:306']);
    expect(fileRefs(sinCita)).toEqual([]);
    // El link cruzado es el único que puede diferir.
    expect(fileRefs('[Español](README.es.md)')).toEqual([]);
    // Y los `#` de adentro de un bloque de código no son títulos.
    expect(headingLevels('## Uno\n```bash\n# no soy un titulo\n```\n# Dos')).toEqual([
      '##',
      '#',
    ]);
  });
});
