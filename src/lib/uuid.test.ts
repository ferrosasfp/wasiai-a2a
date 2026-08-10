/**
 * Tests de `src/lib/uuid.ts` — predicado de FORMA de UUID (WKH-345).
 *
 * Estos cuatro existen porque el guard de las cinco rutas se anula con UNA
 * línea: `return UUID_RE.test(id)` → `return true`. Cada `it` de acá nombra el
 * mutante de una línea que lo pone rojo.
 *
 * LO QUE NO SON: los únicos testigos de esos mutantes. Acá había escrito que los
 * tests de ruta "no ven M-2 ni M-3 porque todos los ids que fabrican las suites
 * son v4 y se piden una sola vez". Las dos mitades son falsas, y las dos se
 * caen con una corrida de la suite completa (`c3b7333`):
 *
 *   M-2 (endurecer a v4)   → **11 rojos, 9 FUERA de este archivo**, los 9 en
 *                            `src/routes/tasks.test.ts`, que es justamente un
 *                            archivo de tests de ruta. Los ids de fixture NO son
 *                            todos v4: `tasks.test.ts:95` es
 *                            `'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'`.
 *   M-3 (flags `i` → `gi`) → **32 rojos, 29 FUERA**, en 9 archivos. Los ids SÍ se
 *                            piden más de una vez por proceso, que es exactamente
 *                            por qué el `lastIndex` compartido mata 29 de rebote.
 *
 * El valor de estos cuatro no es ser los únicos rojos: es ser los únicos que
 * dicen POR QUÉ el rojo no se arregla tocando el fixture (ver T-U2).
 */
import { describe, expect, it } from 'vitest';
import { isValidUUID, UUID_RE } from './uuid.js';

describe('isValidUUID (WKH-345)', () => {
  // T-U1 — mutante que lo mata: `return UUID_RE.test(id)` → `return true`.
  it('T-U1 (AC-6) rechaza lo que no tiene forma de UUID, y acepta lo que sí', () => {
    // Los tres primeros son los valores REALES que hoy viajan hasta Postgres y
    // vuelven como 500: fixtures vivos de receipts/key-session/payments.
    expect(isValidUUID('not-a-uuid')).toBe(false);
    expect(isValidUUID('')).toBe(false);
    expect(isValidUUID('sess-1')).toBe(false);
    expect(isValidUUID('i1')).toBe(false);

    // Control positivo: sin esto, `return false` también pasaría el test y el
    // guard rechazaría TODO, incluidos los ids legítimos.
    expect(isValidUUID('11111111-2222-4333-8444-555555555555')).toBe(true);
  });

  // T-U2 — mutante que lo mata: endurecer el patrón a v4, o sea
  // `[0-9a-f]{4}-[0-9a-f]{4}-` → `4[0-9a-f]{3}-[89ab][0-9a-f]{3}-`.
  //
  // Medido en `c3b7333` (suite completa, árbol limpio): ese mutante pone rojos
  // **11** tests, de los cuales **9 están fuera de este archivo** (los 9 en
  // `src/routes/tasks.test.ts`). NO es cierto que el resto de la suite sea ciego
  // a él: ésa era la hipótesis, y es falsa. Los otros 2 rojos son de acá (T-U2 y
  // T-U4).
  //
  // El 13/11 que decía antes era de `2d8168c` y le atribuía al mutante 2 fallos
  // **preexistentes** (`arbiter.test.ts`, ya arreglados): el mutante nunca mató
  // 13.
  //
  // Pero esos 9 caen porque sus fixtures son literales escritos a mano sin forma
  // de v4 — `tasks.test.ts:95` es `'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'` —, así
  // que señalan "el fixture no es v4", no "el contrato no debe pedir v4".
  //
  // Este test es el único que afirma lo segundo. Sin él, la lectura natural del
  // rojo es "actualizo los 9 fixtures a v4", y el contrato de cinco rutas
  // públicas queda estrechado con la suite en verde.
  it('T-U2 (AC-6) el nil UUID pasa: el predicado es de FORMA, no de versión', () => {
    expect(isValidUUID('00000000-0000-0000-0000-000000000000')).toBe(true);
    // v1 (variant `1`) y variant `c`: dos formas válidas que un patrón de v4
    // rechazaría.
    expect(isValidUUID('11111111-1111-1111-1111-111111111111')).toBe(true);
    expect(isValidUUID('cccccccc-cccc-cccc-cccc-cccccccccccc')).toBe(true);
  });

  // T-U3 — mutante que lo mata: agregar `g` a los flags.
  //
  // No es cosmético. `UUID_RE` es una instancia de módulo que comparten cinco
  // archivos de ruta; con `g`, `.test()` avanza `lastIndex` y la segunda llamada
  // sobre el mismo id devuelve `false`. El aserto de abajo lo demuestra en vez
  // de sólo declararlo.
  it('T-U3 los flags son exactamente `i` — con `g` el predicado tendría estado', () => {
    expect(UUID_RE.flags).toBe('i');
    expect(UUID_RE.global).toBe(false);

    const valido = '11111111-2222-4333-8444-555555555555';
    expect(isValidUUID(valido)).toBe(true);
    expect(isValidUUID(valido)).toBe(true);
    expect(UUID_RE.lastIndex).toBe(0);
  });

  // T-U4 — mutante que lo mata: borrar el flag `i`.
  it('T-U4 (AC-1..AC-4) es case-insensitive: un UUID en mayúsculas es válido', () => {
    expect(isValidUUID('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')).toBe(true);
    expect(
      isValidUUID('11111111-2222-4333-8444-555555555555'.toUpperCase()),
    ).toBe(true);
  });
});
