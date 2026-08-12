/**
 * WKH-342 T-B7 — EL CABLEADO DEL WARM-UP, LEÍDO DEL FUENTE.
 *
 * ⚠️ POR QUÉ ESTE TEST EXISTE, Y POR QUÉ MIRA TEXTO Y NO COMPORTAMIENTO.
 *
 * Sin él, TODO el resto de la suite de WKH-342 puede dar verde con el warm-up
 * DESCABLEADO: `warmPayoutRoutePreflight()` está exportada y testeada, pero si nadie la
 * llama en el arranque, la alarma no suena nunca en producción y el primer aviso de que
 * la ruta no existe vuelve a llegar leg por leg. Es la clase de agujero de
 * `tests-que-registran-el-doble-no-prueban-el-cableado`: si todos los llamadores de una
 * función viven en archivos `*.test.*`, el cableado no existe.
 *
 * Y no se puede probar importando `src/index.ts`: ese módulo hace `await initAdapters()`
 * a NIVEL DE MÓDULO (lo dice su propio comentario, `src/index.ts:246-248`), así que
 * importarlo desde un test levanta el servicio. La única prueba posible es leer el fuente
 * como texto — técnica ya usada en `test/ownership-filter-guard.scanner.ts` y en
 * `test/test-files-are-run-in-ci.test.ts`.
 *
 * ⚠️ Y POR QUÉ ESTE ARCHIVO VIVE EN `src/` Y NO EN `test/`: el `include` de
 * `vitest.config.ts:5` cubre los dos directorios, pero el `include` de `tsconfig.json:19`
 * es sólo `src/**` (MEDIDO 2026-08-09). Un test en `test/` NO LO TYPECHEQUEA NADIE, y
 * este archivo hace aserciones sobre índices y tipos que quiero que `tsc --noEmit`
 * evalúe.
 *
 * LO QUE ESTE TEST NO CUBRE (declarado, y CORREGIDO por AR MNR-3 — mi declaración
 * anterior era más amplia que la verdad).
 *
 * No cubre que la línea se EJECUTE: verifica que está escrita después de `listen(`, una
 * sola vez y sin `await`. Pero el residuo es MÁS ANGOSTO de lo que decía acá, y la
 * diferencia está medida:
 *   · `if (Number('0')) warmPayoutRoutePreflight();` (guarda INLINE) ⟹ **T-B7 y T-B7b
 *     ROJOS**. La regex de la llamada exige que el `warmPayoutRoutePreflight();` arranque
 *     la línea (`^[^\S\n]*`), así que cualquier guarda en la misma línea la rompe.
 *   · `if (Number('0')) {\n  warmPayoutRoutePreflight();\n}` (bloque MULTILÍNEA) ⟹ los 4
 *     verdes. **Ése es el residuo real**, y es el único.
 *   · Un `process.exit()` antes también pasaría.
 * Y el radio de un descableado es acotado: se pierde la ALARMA DE ARRANQUE, no el gate. El
 * gate del leg de pago es `ensurePayoutRouteReady()` dentro de `payoutViaFacilitator`, que
 * sondea igual la primera vez que se usa.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = resolve(HERE, '..', '..', 'index.ts');
const source = readFileSync(INDEX_PATH, 'utf-8');

describe('WKH-342 T-B7 / AC-2 — src/index.ts llama al warm-up del sondeo', () => {
  it('★ T-B7: la llamada existe, es UNA, y está DESPUÉS de fastify.listen(', () => {
    // Control de que se leyó el archivo correcto: sin esto, un path equivocado daría un
    // `-1` en todos los `indexOf` y los `toBeGreaterThan` de abajo dirían cualquier cosa.
    const listenIndex = source.indexOf('await fastify.listen(');
    expect(listenIndex).toBeGreaterThan(-1);

    const callSites = [
      ...source.matchAll(/^[^\S\n]*warmPayoutRoutePreflight\(\);/gm),
    ];
    expect(callSites).toHaveLength(1);

    const callIndex = callSites[0]?.index;
    expect(callIndex).toBeDefined();
    // Antes de `listen()` el sondeo correría durante el boot: si el facilitator está
    // caído, el `fetch` de 5 s se suma al arranque ANTES de que el healthcheck de
    // Railway (`railway.json:9`, 60 s) tenga un puerto al que pegarle.
    expect(callIndex as number).toBeGreaterThan(listenIndex);
  });

  it('★ T-B7b: la llamada NO lleva `await` — un arranque no puede depender del vecino', () => {
    // `railway.json:10` de este repo trae `restartPolicyType: 'ON_FAILURE'` SIN
    // `restartPolicyMaxRetries`: un boot que espera a un facilitator caído deja al
    // gateway en ciclo de reinicios por algo que no es suyo.
    expect(source).toMatch(/^[^\S\n]*warmPayoutRoutePreflight\(\);/m);
    expect(source).not.toMatch(/await\s+warmPayoutRoutePreflight\(/);
    // Y tampoco encadenada a un `.then`/`.catch` que la vuelva esperable arriba.
    expect(source).not.toMatch(/warmPayoutRoutePreflight\(\)\s*\./);
  });

  it('★ T-B7c: la función viene del módulo dueño de las envs, no de una copia local', () => {
    expect(source).toMatch(
      // El `[^}]*` a los dos lados tolera que el import traiga OTROS símbolos del mismo
      // módulo (hoy `readPayoutRouteHealth`, para el campo `solanaPayoutRoute` de /health)
      // y también que esté partido en varias líneas. NO afloja lo que este test vigila,
      // que es su propia frase: de qué MÓDULO sale la función. Cambiar esa ruta lo sigue
      // poniendo rojo, y eso está medido, no supuesto.
      /import\s*\{[^}]*\bwarmPayoutRoutePreflight\b[^}]*\}\s*from\s*'\.\/adapters\/solana\/facilitator-settle\.js'/,
    );
  });

  it('★ T-B7d: el call-site NO repite el gate de la bandera (el criterio vive dentro)', () => {
    // Los dos warm-ups vecinos SÍ llevan su `if` en el call-site (`src/index.ts:338` y
    // `:345`). Éste se aparta a propósito: `ensurePayoutRouteReady` es a la vez el gate
    // perezoso del leg de pago, y dos copias del criterio pueden divergir. Si alguien
    // "uniformiza" agregando el `if` acá, este test lo marca para que la decisión se
    // discuta en vez de colarse.
    expect(source).not.toMatch(
      /SOLANA_SETTLE_VIA_FACILITATOR[^\n]*warmPayoutRoutePreflight/,
    );
    expect(source).not.toMatch(/if\s*\([^)]*\)\s*warmPayoutRoutePreflight\(\)/);
  });
});
