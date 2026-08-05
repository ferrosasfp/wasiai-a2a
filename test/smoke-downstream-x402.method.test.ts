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
  assertBreakerAcceptable,
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

/**
 * La AUSENCIA de `breakerState` se acepta por su RAZÓN, nunca por sí sola.
 *
 * ⚠️ EL BUG QUE ESTOS TESTS EXISTEN PARA CAZAR (medido, no inferido).
 * `scripts/smoke-downstream-x402.mjs` exigía `breakerState === 'CLOSED'` a toda
 * cadena. Contra el facilitator de producción, el 2026-08-05:
 *
 *     EXPECTED_CHAINS=solana:devnet node scripts/smoke-downstream-x402.mjs
 *     → [smoke] FAIL: chain solana:devnet (Solana Devnet)
 *       breakerState='undefined' (expected 'CLOSED')            exit 1
 *
 * El `SolanaAdapter` del facilitator no tiene circuit breaker y no corresponde
 * que lo tenga (allá el facilitator es TESTIGO de una tx ya finalizada, no la
 * transmite ni paga su gas). El facilitator ahora publica por cadena EXACTAMENTE
 * UNO de `breakerState` / `breakerStateAbsentReason` (commit 1c257c2 / fix
 * ad5b352), y la entrada Solana trae `NO_BREAKER`.
 *
 * ⚠️ LOS DOS TESTS QUE IMPORTAN SON LOS ROJOS (T-DSM-07 y T-DSM-08). Aceptar la
 * ausencia de los dos campos, o aceptar cualquier string como razón, convierte
 * este chequeo en uno que se apaga solo — y se apaga justo cuando la respuesta
 * viene incompleta o reescrita, que es cuando hace falta. Un guard que acepta
 * cualquier cosa en lugar del campo que falta no es un guard.
 */
describe('smoke-downstream-x402 · el breaker ausente se acepta por su razón', () => {
  it('T-DSM-05: estado presente y válido → pasa, y lo reporta en el log', () => {
    // El caso de las cuatro entradas eip155:* de producción. Comportamiento que ya
    // había: no puede cambiar, es el rail que HOY mueve plata.
    expect(
      assertBreakerAcceptable(
        { name: 'Base Sepolia', breakerState: 'CLOSED' },
        'eip155:84532',
      ),
    ).toBe('breaker=CLOSED');

    // Un breaker ABIERTO sigue siendo rojo: es el motivo original del chequeo.
    expect(() =>
      assertBreakerAcceptable(
        { name: 'Avalanche Fuji', breakerState: 'OPEN' },
        'eip155:43113',
      ),
    ).toThrow(/breakerState='OPEN' \(expected 'CLOSED'\)/);
    expect(() =>
      assertBreakerAcceptable(
        { name: 'Avalanche Fuji', breakerState: 'HALF_OPEN' },
        'eip155:43113',
      ),
    ).toThrow(/expected 'CLOSED'/);
  });

  it('T-DSM-06: estado ausente con razón CONOCIDA → pasa, con la razón en el log', () => {
    // Exactamente la entrada `solana:devnet` que devuelve producción hoy.
    expect(
      assertBreakerAcceptable(
        { name: 'Solana Devnet', breakerStateAbsentReason: 'NO_BREAKER' },
        'solana:devnet',
      ),
    ).toBe('breakerAbsent=NO_BREAKER');

    // Las otras dos razones del enum publicado por el facilitator.
    expect(
      assertBreakerAcceptable(
        { name: 'Kite Testnet', breakerStateAbsentReason: 'BREAKER_DISABLED' },
        'eip155:2368',
      ),
    ).toBe('breakerAbsent=BREAKER_DISABLED');

    // ADAPTER_LOOKUP_FAILED no abre el breaker de nadie (no cambia el exit code),
    // pero el facilitator lo declara inalcanzable por construcción: si sale, su
    // registry está inconsistente y el log tiene que decirlo, no tragárselo.
    expect(
      assertBreakerAcceptable(
        { name: 'Raro', breakerStateAbsentReason: 'ADAPTER_LOOKUP_FAILED' },
        'eip155:1',
      ),
    ).toMatch(/ADAPTER_LOOKUP_FAILED.*WARN/);
  });

  it('T-DSM-07: NINGUNO de los dos campos → ROJO, no "esta cadena no tiene breaker"', () => {
    // ⚠️ ESTE ES EL CASO QUE NO SE PUEDE AFLOJAR. Sin ninguno de los dos campos la
    // respuesta está incompleta, la reescribió algo en el camino, o el facilitator
    // es anterior a `breakerStateAbsentReason`. Leer eso como "no hay breaker" es
    // volver a la ambigüedad que el facilitator acaba de eliminar.
    expect(() =>
      assertBreakerAcceptable({ name: 'Solana Devnet' }, 'solana:devnet'),
    ).toThrow(/NEITHER breakerState NOR breakerStateAbsentReason/);
    // El mensaje tiene que nombrar la cadena, si no el rojo manda a buscar el
    // problema al lugar equivocado.
    expect(() =>
      assertBreakerAcceptable({ name: 'Solana Devnet' }, 'solana:devnet'),
    ).toThrow(/solana:devnet/);

    // Un objeto pelado (sin siquiera `name`) cae del mismo lado: la ausencia no se
    // vuelve aceptable porque la entrada traiga menos datos.
    expect(() => assertBreakerAcceptable({}, 'eip155:84532')).toThrow(
      /NEITHER breakerState NOR breakerStateAbsentReason/,
    );
  });

  it('T-DSM-08: razón DESCONOCIDA → ROJO, "no sé qué me dijiste" no es "está todo bien"', () => {
    // ⚠️ EL OTRO ROJO QUE IMPORTA. Si esto pasara, el guard aceptaría cualquier
    // string en lugar del campo que falta: bastaría un `breakerStateAbsentReason`
    // cualquiera para apagar el chequeo del breaker en TODAS las cadenas.
    expect(() =>
      assertBreakerAcceptable(
        { name: 'Solana Devnet', breakerStateAbsentReason: 'BECAUSE' },
        'solana:devnet',
      ),
    ).toThrow(/is not a reason this script understands/);
    // El mensaje tiene que listar las razones conocidas para que el fix sea obvio.
    expect(() =>
      assertBreakerAcceptable(
        { name: 'Solana Devnet', breakerStateAbsentReason: 'BECAUSE' },
        'solana:devnet',
      ),
    ).toThrow(/NO_BREAKER/);

    // Vecinos de las razones válidas: ni el string vacío, ni la variante en
    // minúsculas, ni una razón "parecida" se cuelan.
    for (const razon of ['', 'no_breaker', 'NO_BREAKER ', 'OK', 'CLOSED']) {
      expect(() =>
        assertBreakerAcceptable(
          { name: 'Solana Devnet', breakerStateAbsentReason: razon },
          'solana:devnet',
        ),
      ).toThrow(/is not a reason this script understands/);
    }
  });

  it('T-DSM-09: estado presente FUERA del enum → ROJO, y con otro mensaje que OPEN', () => {
    // Un `breakerState` que no es ninguno de los tres valores publicados es una
    // respuesta que no entendemos, no un breaker sano y no un breaker abierto.
    expect(() =>
      assertBreakerAcceptable(
        { name: 'Base Sepolia', breakerState: 'TRIPPED' },
        'eip155:84532',
      ),
    ).toThrow(/is not a known breaker state/);
    expect(() =>
      assertBreakerAcceptable(
        { name: 'Base Sepolia', breakerState: 'TRIPPED' },
        'eip155:84532',
      ),
    ).toThrow(/CLOSED, OPEN, HALF_OPEN/);

    // `null` es un valor PRESENTE, no una ausencia: no puede caer en la rama que
    // pide razón y quedar aceptado por venir sin ella.
    expect(() =>
      assertBreakerAcceptable(
        { name: 'Base Sepolia', breakerState: null },
        'eip155:84532',
      ),
    ).toThrow(/is not a known breaker state/);

    // Y la minúscula tampoco pasa: 'closed' no es 'CLOSED'.
    expect(() =>
      assertBreakerAcceptable(
        { name: 'Base Sepolia', breakerState: 'closed' },
        'eip155:84532',
      ),
    ).toThrow(/is not a known breaker state/);

    // El rojo del enum NO puede confundirse con el de un breaker abierto: son
    // problemas distintos (facilitator raro vs cadena fallando).
    expect(() =>
      assertBreakerAcceptable(
        { name: 'Base Sepolia', breakerState: 'TRIPPED' },
        'eip155:84532',
      ),
    ).not.toThrow(/expected 'CLOSED'/);
  });
});
