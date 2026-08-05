/**
 * El método que el smoke le exige a una cadena SALE DE LA CADENA.
 *
 * ⚠️ EL BUG QUE ESTOS TESTS EXISTEN PARA CAZAR (medido, no inferido).
 * `scripts/smoke-downstream-x402.mjs` tenía `const REQUIRED_METHOD = 'eip3009'` y
 * lo exigía contra CUALQUIER cadena de `EXPECTED_CHAINS`. `eip3009` es un método
 * EVM. Contra el facilitator de producción, el 2026-08-04:
 *
 *     EXPECTED_CHAINS=solana:devnet node scripts/smoke-downstream-x402.mjs
 *     → [smoke] FAIL: chain solana:devnet (Solana Devnet) missing method
 *       'eip3009' (got: spl-token-transfer-finalized)      exit 1
 *
 * O sea: ROJO SIEMPRE, con un mensaje que acusa a una cadena sana. Y como el
 * default de `EXPECTED_CHAINS` es sólo eip155:*, el rail Solana no estaba
 * cubierto por el smoke y nadie se enteraba — el rojo esperaba a la primera
 * persona que intentara cubrirlo.
 *
 * Este archivo es `.ts` a propósito (y no una sección más del wrapper
 * `smoke-downstream-x402.test.mjs`): necesita importar `chain-resolver.ts` para
 * el cruce de T-DSM-04, y un `.mjs` no puede importar TypeScript.
 */

import { describe, expect, it } from 'vitest';
import {
  getChainVmFamily,
  listChainAliases,
  normalizeChainSlug,
} from '../src/adapters/chain-resolver.js';
import {
  knownVmFamilies,
  requiredMethodFor,
} from '../scripts/smoke-downstream-x402.mjs';

describe('smoke-downstream-x402 · el método requerido sale de la cadena', () => {
  it('T-DSM-01: una cadena EVM exige eip3009', () => {
    // Los dos ids del default de EXPECTED_CHAINS: el comportamiento que ya había
    // no puede cambiar. Un "arreglo" que hiciera dinámico el método pero rompiera
    // el caso EVM sería una regresión sobre el rail que HOY mueve plata.
    expect(requiredMethodFor('eip155:84532')).toBe('eip3009');
    expect(requiredMethodFor('eip155:43113')).toBe('eip3009');
  });

  it('T-DSM-02: una cadena Solana exige spl-token-transfer-finalized, NO eip3009', () => {
    // El valor no es una preferencia nuestra: es lo que el facilitator declara en
    // `GET /supported` para `solana:devnet` (verificado en vivo, ver el encabezado).
    expect(requiredMethodFor('solana:devnet')).toBe(
      'spl-token-transfer-finalized',
    );
    expect(requiredMethodFor('solana:devnet')).not.toBe('eip3009');
  });

  it('T-DSM-03: una cadena de familia DESCONOCIDA tira, no pasa en silencio', () => {
    // ⚠️ ESTE ES EL TEST QUE IMPORTA. Un chequeo que se saltea cuando no entiende
    // la entrada es PEOR que no tenerlo: la cadena nueva —la única sin confianza
    // acumulada— saldría verde y se leería como verificada.
    expect(() => requiredMethodFor('cosmos:cosmoshub-4')).toThrow(
      /cannot determine the required settle method/i,
    );
    // El mensaje tiene que nombrar la cadena y las familias conocidas, si no el
    // rojo manda a buscar el problema al lugar equivocado.
    expect(() => requiredMethodFor('cosmos:cosmoshub-4')).toThrow(
      /cosmos:cosmoshub-4/,
    );
    expect(() => requiredMethodFor('cosmos:cosmoshub-4')).toThrow(/eip155/);

    // Un id SIN namespace tampoco puede colarse: sin `:` no hay familia que
    // deducir. `'eip155'` pelado y `''` caen del mismo lado.
    expect(() => requiredMethodFor('base-sepolia')).toThrow(
      /cannot determine the required settle method/i,
    );
    expect(() => requiredMethodFor('')).toThrow(
      /cannot determine the required settle method/i,
    );

    // Y ningún valor de entrada puede devolver algo utilizable por accidente:
    // un `undefined` devuelto haría que `methods.includes(undefined)` sea false
    // y el smoke fallara con un mensaje incomprensible en vez de este.
    expect(() =>
      requiredMethodFor(undefined as unknown as string),
    ).toThrow();
  });

  it('T-DSM-04: toda familia de VM que conoce el repo tiene método en el smoke', () => {
    // ⚠️ ESTE ES EL ANTI-DESINCRONIZACIÓN, Y ES MECÁNICO A PROPÓSITO.
    // La tabla del smoke es una SEGUNDA lista respecto de `chain-resolver.ts`
    // (no se puede importar la primera: es TS y el script corre con node pelado,
    // y además `chain-resolver` clasifica familias pero no nombra métodos). Una
    // segunda lista mantenida por una regla ESCRITA se desincroniza; por eso acá
    // se ENUMERA la fuente de verdad en vez de confiar en que alguien lea la
    // prosa. Agregar una `ChainKey` de una familia nueva en `src/` sin enseñarle
    // el método a `scripts/` pone ESTE test en rojo.
    const familiasDelRepo = new Set(
      listChainAliases()
        .map((alias) => normalizeChainSlug(alias))
        .filter((key): key is NonNullable<typeof key> => key !== undefined)
        .map((key) => getChainVmFamily(key)),
    );

    // Sanity de la enumeración misma: si `listChainAliases()` devolviera vacío,
    // el `for` de abajo no correría y el test pasaría sin haber comprobado nada
    // — verde por el motivo equivocado.
    expect(familiasDelRepo.size).toBeGreaterThanOrEqual(2);
    expect(familiasDelRepo).toContain('evm');
    expect(familiasDelRepo).toContain('solana');

    for (const familia of familiasDelRepo) {
      expect(
        knownVmFamilies(),
        `la familia de VM '${familia}' existe en src/adapters/chain-resolver.ts ` +
          'pero scripts/smoke-downstream-x402.mjs no sabe qué método exigirle',
      ).toContain(familia);
    }
  });
});
