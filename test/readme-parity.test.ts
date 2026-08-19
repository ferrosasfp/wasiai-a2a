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
 * ⚠️ EL SEGUNDO BUG, Y POR QUÉ ESTE ARCHIVO CRECIÓ (medido 2026-08-19). Este
 * guardián estaba en VERDE (4 passed) mientras al `README.es.md` le faltaban
 * SEIS cosas del inglés, entre ellas el párrafo `README.md:10-13` que le pone
 * UN nombre a la pieza ("This is the coordinator", el mismo nombre que usan el
 * deck, la agent card y el registro de Solana) y la fila de evidencia on-chain
 * del registro. Medido sobre el ES de entonces: `Coordinator` 0 ocurrencias,
 * `Solana Agent Registry` 0, contra 26 de `WasiAI` como control positivo.
 *
 * Cayó JUSTO entre los dos criterios de abajo: es prosa dentro de secciones que
 * YA existían (no mueve ningún título) y no cita ningún ARCHIVO del repo (cita
 * la ruta HTTP `/.well-known/agent.json`, que el ES ya tenía por otro lado, y
 * URLs de `explorer.solana.com`).
 *
 * Y es el caso que este archivo YA declaraba no cubrir, con estas palabras: "un
 * párrafo faltante que no cite archivos NI abra sección. La contención ahí es
 * humana". O sea que declarar el límite estaba hecho, y no alcanzó: la
 * contención humana falló en su primera oportunidad medida. Por eso acá se
 * agrega un criterio (3) en vez de volver a escribir el límite.
 *
 * QUÉ COMPARA, y por qué esas tres cosas:
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
 *   3. LOS LITERALES ENTRE BACKTICKS. Un identificador NO se traduce: `allowTrial`
 *      se escribe igual en los dos idiomas, y también `WasiAI A2A Coordinator`,
 *      `x402Support: true` o la firma `3jHFjCeY…`. Así que un literal que está en
 *      el inglés y no en el español es un párrafo que no se tradujo, aunque no
 *      cite archivos ni abra sección. Esto es lo que caza el bug de 2026-08-19:
 *      4 de sus 6 omisiones traían literales propios.
 *
 * POR QUÉ (3) SE MIDE EN UNA SOLA DIRECCIÓN, y por qué se saltean los bloques de
 * código: el modo de falla que persigue este archivo es que al ES le FALTE algo,
 * no que le sobre. Que el ES tenga prosa medida de más no es el bug (hoy tiene:
 * el bloque de `catalogStatus`/`sources` de "Qué corre hoy" es más largo que el
 * del inglés), y assertar simetría ahí pondría rojo un README correcto. Los
 * bloques ``` se saltean porque los comentarios de los ejemplos `curl` sí están
 * traducidos y son texto, no identificadores.
 *
 * EL COSTO DE (3), medido antes de escribirlo: sobre los dos README arreglados
 * compara 307 literales y da CERO diferencias. Las dos únicas que había son
 * placeholders que se traducen a propósito (`src/adapters/<network>/` →
 * `<red>/`, `doc/sdd/NNN-title/` → `NNN-titulo/`); la primera la cubre una regla
 * (todo literal con `<` o `>` es un placeholder) y la segunda es la ÚNICA
 * excepción escrita a mano. Si alguien agrega un placeholder nuevo sin ángulos,
 * esto se pone rojo nombrando el token: es ruidoso a propósito, porque matchear
 * de menos en silencio sería peor que no tener guardián.
 *
 * QUÉ NO CUBRE (declarado, no arreglado, y MEDIDO borrando del ES cada una de
 * las 6 omisiones por separado y corriendo este archivo: 4 lo ponen rojo, 2 no):
 *   - texto faltante que no cite archivos, NI abra sección, NI traiga un literal
 *     entre backticks PROPIO. Sigue siendo contención humana. Los 2 casos
 *     medidos que quedan afuera:
 *       · prosa pelada, sin un solo backtick: "Being registered is not the same
 *         as being discovered" (`README.md:411`).
 *       · texto agregado a una fila de tabla que YA existía, cuando lo que
 *         agrega es un link y no un identificador: la cláusula "The same
 *         identity is anchored on-chain in the Solana Agent Registry" de
 *         `README.md:265`. El literal de esa fila (`/.well-known/agent.json`)
 *         ya estaba en el ES, así que (3) no ve nada nuevo.
 *     Un criterio sobre URLs cazaría el segundo, y se descartó a propósito: las
 *     URLs de los badges de shields.io SÍ se traducen (`protocol-` →
 *     `protocolo-`, `license-` → `licencia-`), así que habría que exceptuarlas
 *     por prefijo, y aun así no cazaría el primero. Queda como el candidato
 *     obvio si aparece una tercera omisión de esta clase.
 *   - que al ES le SOBRE algo. (3) se mide en una sola dirección, ver arriba.
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

/** Placeholders que SÍ se traducen. `src/adapters/<network>/` no está acá
 *  porque lo cubre la regla de los ángulos; éste no tiene ángulos y no hay
 *  regla que lo distinga de un identificador real. */
const TRANSLATED_PLACEHOLDERS = new Set([
  'doc/sdd/NNN-title/',
  'doc/sdd/NNN-titulo/',
]);

/** Los literales entre backticks que están FUERA de un bloque de código. Un
 *  identificador no se traduce, así que estos tienen que aparecer en los dos
 *  idiomas. Se descartan los placeholders, que sí se traducen. */
function codeLiterals(text: string): string[] {
  const out = new Set<string>();
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const tok = m[1] as string;
      if (/[<>]/.test(tok)) continue;
      if (TRANSLATED_PLACEHOLDERS.has(tok)) continue;
      out.add(tok);
    }
  }
  return [...out].sort();
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
    // Y el extractor de literales, con el token que faltaba el 2026-08-19: si
    // dejara de verlo, el criterio (3) quedaría verde por vacío.
    expect(codeLiterals(TEXT[EN] as string).length).toBeGreaterThan(200);
    expect(codeLiterals(TEXT[ES] as string).length).toBeGreaterThan(200);
    expect(codeLiterals(TEXT[EN] as string)).toContain('WasiAI A2A Coordinator');
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

  it('★ el español no se saltea ningún literal del inglés', () => {
    // Criterio (3). Una dirección sola: falta en el ES, ver el docblock.
    const es = new Set(codeLiterals(TEXT[ES] as string));
    expect(
      codeLiterals(TEXT[EN] as string).filter((t) => !es.has(t)),
      'Hay literales entre backticks en el README en inglés que NO están en el\n' +
        'español. Un identificador no se traduce, así que casi siempre significa\n' +
        'que un párrafo entero se escribió en un solo idioma. Traducilo. Si de\n' +
        'verdad es un placeholder que se traduce, agregalo a\n' +
        '`TRANSLATED_PLACEHOLDERS` con su motivo; no bajes el assert.',
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
    // El extractor de literales: agarra los de la prosa, y NINGUNO de adentro
    // de un bloque de código (ahí los comentarios están traducidos).
    expect(codeLiterals('el parámetro `allowTrial` y `x402Support: true`')).toEqual([
      'allowTrial',
      'x402Support: true',
    ]);
    expect(codeLiterals('```bash\ncurl `$GW/discover` # `un comentario`\n```')).toEqual(
      [],
    );
    // Los placeholders, que sí se traducen, no cuentan.
    expect(codeLiterals('viven en `src/adapters/<network>/` y `doc/sdd/NNN-title/`')).toEqual(
      [],
    );
    expect(codeLiterals('viven en `src/adapters/<red>/` y `doc/sdd/NNN-titulo/`')).toEqual(
      [],
    );
  });
});
