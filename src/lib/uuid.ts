/**
 * Predicado de FORMA de UUID — guard de borde HTTP (WKH-345).
 *
 * Extraído de `src/routes/tasks.ts`, donde vivía como helper privado del módulo
 * y por eso las otras superficies de ruta no lo tenían. El patrón se copia byte
 * a byte: extraer NO es la oportunidad de mejorarlo (P-2).
 *
 * QUÉ VALIDA
 *   Sólo la forma: 8-4-4-4-12 dígitos hexadecimales separados por guiones,
 *   anclada a los dos extremos, case-insensitive.
 *
 * QUÉ NO VALIDA — y es a propósito
 *   Ni la versión ni la variant. `00000000-0000-0000-0000-000000000000` (el nil
 *   UUID) pasa, y un v1/v3/v5 también. Endurecerlo a v4
 *   (`4[0-9a-f]{3}-[89ab][0-9a-f]{3}`) estrecharía el contrato de cinco rutas
 *   públicas sin ninguna AC que lo pida. T-U2 en `uuid.test.ts` es el testigo
 *   deliberado de esa decisión.
 *
 *   Medido en `c3b7333` (suite completa, árbol limpio): aplicar ese
 *   endurecimiento pone rojos **11** tests, de los cuales **9 están FUERA de
 *   `uuid.test.ts`** y no hablan de versiones — caen de rebote porque sus
 *   fixtures son literales escritos a mano que no tienen forma de v4 (los 9 están
 *   en `tasks.test.ts`, cuyo `VALID_UUID` de `:95` es
 *   `'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'`). Los otros 2 rojos son T-U2 y T-U4.
 *   O sea: quien endurezca el patrón va a ver la suite en rojo, pero por el
 *   motivo equivocado, y la lectura fácil es "arreglo los fixtures". T-U2 es el
 *   único que dice POR QUÉ no hay que hacerlo.
 *
 *   Este renglón decía `2d8168c`: 13 rojos / 11 fuera. Eran 11/9: los 2 de
 *   diferencia estaban rojos en `2d8168c` SIN ningún mutante (`arbiter.test.ts`,
 *   ver auto-blindaje #2), así que se le estaban cargando al mutante.
 *
 * PARA QUÉ SIRVE
 *   El valor de un `:id` llega sin validar a una columna `uuid` de Postgres, que
 *   responde `22P02 invalid input syntax for type uuid`; ninguna superficie
 *   traduce ese error y el caller recibe un 500 donde corresponde un 4xx. Este
 *   predicado corta por forma ANTES del primer acceso a datos.
 *
 * POR QUÉ LOS FLAGS SON `i` Y NUNCA `gi`
 *   `UUID_RE` es una instancia de módulo compartida por cinco archivos de ruta.
 *   Con el flag `g`, `.test()` avanza `lastIndex` entre llamadas, así que un id
 *   perfectamente válido empieza a ser rechazado según el orden en que se hayan
 *   llamado las rutas. Es un bug con estado global y dependiente del orden.
 *   T-U3 fija los flags exactos.
 *
 * POR QUÉ ACÁ NO HAY NINGÚN RESPONDEDOR DE ERROR
 *   Se comparte el predicado, nunca la respuesta: este módulo no toca `reply`
 *   (D-4). Las cinco superficies responden distinto a propósito — `tasks.ts` da
 *   `400 { error: 'Invalid UUID format' }`, `payments.ts` da `422`, el resto
 *   `400 { error_code: 'INVALID_INPUT' }` — porque cada una conserva el contrato
 *   que YA emite. Un helper `rejectInvalidUUID(reply, ...)` tendría que recibir
 *   status y body por parámetro, y el próximo lector los "simplificaría": ése es
 *   el mecanismo exacto por el que tres contratos distintos derivan a uno solo.
 */

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `true` si `id` tiene forma de UUID (ver docblock: forma, no versión). */
export function isValidUUID(id: string): boolean {
  return UUID_RE.test(id);
}
