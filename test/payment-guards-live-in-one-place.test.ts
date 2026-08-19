/**
 * Guardián estructural — WKH-316 · T-316-24 · CD-9.
 *
 * LO QUE FIJA: los 7 guards del bloque `payment` viven en UN solo módulo
 * (`src/lib/payment-spec-writer.ts`). Ni `src/routes/agents.ts` ni
 * `src/services/agent.ts` re-implementan ninguno: los dos llaman a
 * `validatePaymentBlock` y nada más.
 *
 * POR QUÉ HACE FALTA UN TEST ESTRUCTURAL, si ya hay tests de comportamiento. Un
 * chequeo duplicado **no cambia una sola respuesta HTTP** el día que se escribe:
 * los dos criterios coinciden, así que toda la suite sigue verde. Lo que cambia
 * es después — la próxima corrección de borde se aplica en un lado y no en el
 * otro, y el desacuerdo aparece como un rechazo inexplicable en un camino de
 * dinero. Ningún assert sobre la salida puede ver eso; hay que mirar el fuente.
 *
 * ⚠️ SE MIRA EL CÓDIGO, NO LA PROSA. `routes/agents.ts` menciona `x402` en un
 * mensaje de error de auth (`:66`) y `getInitializedChainKeys()` en un comentario
 * (`:124`), y las dos son legítimas. Sin sacar los comentarios primero, este
 * guardián estaría midiendo la documentación en vez del código, y su rojo sería
 * un falso positivo que alguien terminaría borrando.
 *
 * ⚠️ EL CONTROL DE VACUIDAD ES LA MITAD DEL TEST. Un guardián que sólo verifica
 * AUSENCIA pasa perfecto contra un repo donde la funcionalidad no existe. Por eso
 * cada token que se exige ausente en los dos consumidores se exige **presente**
 * en el módulo validador, y además se exige que los dos consumidores IMPORTEN
 * `validatePaymentBlock`. Si alguien borrara la HU entera, este archivo se pone
 * rojo en vez de aplaudir.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const WRITER = 'src/lib/payment-spec-writer.ts';
const CONSUMERS = ['src/routes/agents.ts', 'src/services/agent.ts'];

/**
 * Saca los comentarios de bloque y las líneas que son SÓLO comentario, dejando
 * las URLs y los strings de código intactos (a diferencia de un `//` a secas,
 * que se comería la mitad de cualquier `https://…`).
 */
function codeOnly(file: string): string {
  const raw = readFileSync(join(REPO_ROOT, file), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

/**
 * Un chequeo del bloque `payment`, con el AC que lo obliga a estar en un solo
 * lugar. El patrón está escrito para matchear el CÓDIGO que haría el chequeo, no
 * cualquier aparición del nombre.
 */
const GUARD_MARKERS: Array<{ ac: string; what: string; pattern: RegExp }> = [
  {
    ac: 'AC-10',
    what: 'el literal del método x402',
    // `'x402'` como literal entero. La frase "the x402 anonymous path" de un
    // mensaje de auth NO matchea, y no tiene que matchear.
    pattern: /(['"`])x402\1/,
  },
  {
    ac: 'AC-2/AC-3',
    what: 'la resolución del riel contra el registry',
    pattern: /getAdaptersBundle\s*\(|getInitializedChainKeys\s*\(/,
  },
  {
    ac: 'AC-5',
    what: 'las direcciones cero',
    pattern: /'0'\.repeat\(40\)|'1'\.repeat\(32\)|0x0{40}/,
  },
  {
    ac: 'AC-6',
    what: 'la comparación contra la address del operador',
    pattern: /resolveOperatorAddress/,
  },
  {
    ac: 'AC-12',
    what: 'la lectura del símbolo del token del riel',
    pattern: /supportedTokens/,
  },
];

describe('T-316-24 · CD-9 — los guards de `payment` viven en un solo lugar', () => {
  for (const { ac, what, pattern } of GUARD_MARKERS) {
    it(`${ac}: ${what} NO está re-implementado en los consumidores`, () => {
      for (const file of CONSUMERS) {
        expect(
          pattern.test(codeOnly(file)),
          `${file} parece re-implementar el chequeo de ${ac} (${what}). ` +
            'Los 7 guards viven en `validatePaymentBlock` ' +
            '(`src/lib/payment-spec-writer.ts`) y en ningún otro lado (CD-9): ' +
            'dos criterios que nada obliga a moverse juntos divergen en la ' +
            'próxima corrección de borde, y el desacuerdo sale como un rechazo ' +
            'inexplicable en un camino de dinero.',
        ).toBe(false);
      }
    });

    // ── Control de vacuidad ──────────────────────────────────────────
    it(`${ac}: ...y SÍ está en el validador (si no, el test de arriba es vacío)`, () => {
      expect(
        pattern.test(codeOnly(WRITER)),
        `${WRITER} no contiene el chequeo de ${ac} (${what}). O se movió de ` +
          'módulo, o se borró: en los dos casos el test de ausencia de arriba ' +
          'dejó de medir algo y hay que arreglar ESTE archivo, no silenciarlo.',
      ).toBe(true);
    });
  }

  it('los dos consumidores llaman al validador compartido', () => {
    // Sin esto, borrar la HU entera dejaría el guardián en verde: no habría
    // ningún chequeo duplicado porque no habría ningún chequeo.
    for (const file of CONSUMERS) {
      const code = codeOnly(file);
      expect(code, `${file} no importa payment-spec-writer`).toContain(
        'payment-spec-writer.js',
      );
      expect(code, `${file} no llama a validatePaymentBlock`).toMatch(
        /validatePaymentBlock\s*\(/,
      );
    }
  });

  it('el stripper de comentarios no se come el código (control del instrumento)', () => {
    // Si `codeOnly` devolviera vacío o casi, TODOS los tests de ausencia
    // pasarían por la razón equivocada. Se fija contra un ancla que sólo puede
    // estar en el código.
    for (const file of [...CONSUMERS, WRITER]) {
      const code = codeOnly(file);
      expect(code.length, `${file} quedó vacío tras sacar comentarios`).toBeGreaterThan(
        500,
      );
      expect(code, `${file}: se perdió el bloque de imports`).toContain(
        'import',
      );
    }
    // Y la contraparte: el stripper SÍ saca los comentarios. `routes/agents.ts`
    // menciona `getInitializedChainKeys()` en un comentario y en ningún otro
    // lado; si esto fuera `true`, el stripper no estaría haciendo nada.
    expect(
      /getInitializedChainKeys/.test(codeOnly('src/routes/agents.ts')),
    ).toBe(false);
    expect(
      readFileSync(join(REPO_ROOT, 'src/routes/agents.ts'), 'utf8'),
    ).toContain('getInitializedChainKeys');
  });
});
