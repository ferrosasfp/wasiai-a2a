/**
 * CHEQUEO MECÁNICO de la lista de cadenas en la documentación pública.
 *
 * ── EL PROBLEMA QUE ESTO CIERRA ────────────────────────────────────────────────
 * `docs/networks.md` abría diciendo que lista "every chain ... that the service
 * knows about today" y nombraba TRES de los ocho miembros de `ChainKey`. Faltaban
 * `base-sepolia`, `base-mainnet`, `tempo-testnet` y `solana-devnet`. La misma
 * página, además, mandaba al lector a no asumir que Base funciona, cuando Base
 * está en `SUPPORTED_CHAINS` sin ninguna bandera. El README del mismo repo llama
 * a Solana "primary network": la contradicción estaba dentro del repo.
 *
 * El defecto no es que alguien haya escrito mal la lista: es que agregar una
 * cadena al código no le pedía nada a la documentación. Eso es lo que este test
 * cambia.
 *
 * ── QUÉ AFIRMA ESTE TEST ───────────────────────────────────────────────────────
 * 1. Todo slug del union `ChainKey` aparece nombrado en cada documento que dice
 *    listar las cadenas. La lista NO se hardcodea acá: se deriva de
 *    `src/adapters/types.ts`, que es su fuente de verdad.
 * 2. Todo token con FORMA de slug de cadena que esos documentos escriben entre
 *    backticks es un `ChainKey` real. Las familias (`kite`, `avalanche`, ...)
 *    también salen del union, así que una familia nueva queda cubierta sola.
 *    Esto caza el borrado de un slug y el typo (`base-sepolia-v2`), que la
 *    dirección 1 sola no ve.
 *
 * ── QUÉ NO CUBRE, dicho para que nadie lo lea de más ───────────────────────────
 *  · No mira los VALORES de las otras columnas. Un `chainId`, una dirección de
 *    token o un explorer equivocados pasan en verde: eso lo dice el propio
 *    `networks.md` en su sección "Source of truth".
 *  · No prueba que la cadena esté inicializada en ningún deploy. `ChainKey` es lo
 *    que el código CONOCE; `WASIAI_A2A_CHAINS` decide lo que un proceso LEVANTA,
 *    y las dos banderas (`TEMPO_ADAPTER_ENABLED`, `SOLANA_ADAPTER_ENABLED`)
 *    deciden lo que siquiera puede entrar. Nada de eso es observable desde acá.
 *  · No verifica que lo que la página dice DE cada cadena sea cierto. Un slug
 *    nombrado dentro de una frase falsa pasa el test.
 *  · Sólo mira los archivos de `DOCS_THAT_LIST_CHAINS`. Una página nueva que
 *    liste cadenas y no se agregue a esa constante no la mira nadie.
 *  · La dirección 1 compara por SUBSTRING, así que un typo que EXTIENDE un slug
 *    válido (`base-sepolia-v2`) la satisface. Medido: esa mutación deja verde la
 *    dirección 1 y pone roja la 2. Por eso están las dos, y por eso borrar una
 *    "porque la otra ya cubre" es falso.
 *
 * ── MUTACIONES MEDIDAS (2026-08-05) ────────────────────────────────────────────
 *  · agregar `'polygon-amoy'` al union ⇒ 2 rojos (README.md y docs/networks.md,
 *    dirección 1).
 *  · renombrar `base-sepolia` a `base-sepolia-v2` en la tabla de networks.md ⇒
 *    1 rojo (dirección 2).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Documentos que AFIRMAN listar las cadenas. Mantenido a mano a propósito: un
 * glob sobre `docs/**` incluiría páginas que mencionan una cadena de pasada y
 * las obligaría a nombrarlas a las ocho.
 */
const DOCS_THAT_LIST_CHAINS = ['README.md', 'docs/networks.md'] as const;

/**
 * Los slugs, LEÍDOS del union `ChainKey` en `src/adapters/types.ts`.
 *
 * Se parsea el archivo en vez de importar el tipo porque `ChainKey` es un tipo:
 * en runtime no existe y no hay nada que recorrer. El parseo es el precedente de
 * `payment-contract-docs.test.ts`, que deriva las direcciones de token de los
 * `payment.ts` de cada adapter en lugar de repetirlas.
 */
function chainKeys(): string[] {
  const source = readFileSync(`${REPO}src/adapters/types.ts`, 'utf8');
  const block = /export type ChainKey =([^;]*);/.exec(source)?.[1];
  if (block === undefined) {
    throw new Error(
      'no se encontró `export type ChainKey =` en src/adapters/types.ts — si el union se movió o se renombró, este test dejó de mirar lo que dice mirar; arreglá el parser, no borres el test',
    );
  }
  return [...block.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1] as string);
}

/** Familias derivadas de los propios slugs: `base-sepolia` → `base`. */
function chainFamilies(keys: string[]): string[] {
  return [...new Set(keys.map((k) => k.split('-')[0] as string))];
}

describe('la documentación pública lista las cadenas que el código conoce', () => {
  it('el parser lee el union `ChainKey` (sanity del scanner)', () => {
    // Sin esto, un parser roto devolvería [] y los dos tests de abajo pasarían
    // sin comparar nada. El piso es 6: los miembros no gateados por bandera.
    const keys = chainKeys();
    expect(keys.length).toBeGreaterThanOrEqual(6);
    // Dos anclas concretas: la cadena por defecto y el rail no-EVM.
    expect(keys).toContain('kite-ozone-testnet');
    expect(keys).toContain('solana-devnet');
  });

  it.each(DOCS_THAT_LIST_CHAINS)('%s nombra cada slug de `ChainKey`', (doc) => {
    const text = readFileSync(`${REPO}${doc}`, 'utf8');
    const missing = chainKeys().filter((key) => !text.includes(key));
    expect(
      missing,
      `${doc} dice listar las cadenas del servicio y no nombra estas. Agregar una cadena al código sin decirlo acá es cómo esta página llegó a mandar al lector a no asumir que Base funciona, con Base ya en SUPPORTED_CHAINS`,
    ).toEqual([]);
  });

  it.each(
    DOCS_THAT_LIST_CHAINS,
  )('%s no inventa slugs que `ChainKey` no tenga', (doc) => {
    const keys = chainKeys();
    const known = new Set(keys);
    const familyRe = new RegExp(
      `\`(${chainFamilies(keys).join('|')})-[a-z0-9-]+\``,
      'g',
    );
    const lines = readFileSync(`${REPO}${doc}`, 'utf8').split('\n');
    const offenders: string[] = [];
    lines.forEach((line, idx) => {
      for (const m of line.matchAll(familyRe)) {
        const slug = (m[0] as string).slice(1, -1); // sin los backticks
        if (!known.has(slug)) offenders.push(`${doc}:${idx + 1} → ${slug}`);
      }
    });
    expect(
      offenders,
      'un slug con forma de cadena que no está en el union: o el union lo perdió y la doc quedó prometiendo un rail muerto, o es un typo que un integrador va a copiar a su `WASIAI_A2A_CHAINS` y le va a dar `Unsupported chain` al arrancar',
    ).toEqual([]);
  });
});
