/**
 * Límites estructurales de un pipeline de `/compose`.
 *
 * Módulo LEAF (cero imports) por la misma razón que `pricing-constants.ts`,
 * `discovery-query.ts`, `discovery-fetch-limit.ts` y `downstream-skip-code.ts`:
 * lo consumen dos capas distintas (una ruta y un adapter de pago) y media docena
 * de suites mockean los módulos gordos del money-path COMPLETOS con factories sin
 * `importOriginal`. Un archivo nuevo sin dependencias no puede quedar `undefined`
 * en ninguna suite (ninguna lo mockea) y no arrastra nada al grafo del adapter.
 *
 * ─── Por qué existe (AR it3 MENOR-2) ────────────────────────────────────────
 * El `5` vivía DUPLICADO como literal en dos sitios sin nada que los atara:
 *   · `routes/compose.ts` — el guard de validación (`steps.length > MAX`).
 *   · `adapters/solana/payment.ts` — factor de `ESTIMATED_MAX_RUN_WALL_CLOCK_MS`
 *     (`MAX × 300 s`), del que se derivan la ventana protegida y el TTL del Map de
 *     idempotencia de settles.
 * Subir el límite de la ruta invalidaba EN SILENCIO la cota estimada del run y
 * sub-margineaba el TTL: una entrada de idempotencia podía expirar mientras su run
 * seguía vivo, que es exactamente el estado del que ese Map protege.
 *
 * Se eligió la constante compartida por sobre un test que compare dos literales:
 * el test detecta la divergencia DESPUÉS de que alguien escribió el segundo número
 * (y sólo si corre esa suite), mientras la constante hace la divergencia
 * imposible de escribir. El test de TTL (`solana/intent-dedup.test.ts`) conserva a
 * propósito su propio literal (`5 * 300_000`) como valor esperado independiente:
 * así, subir este número no rompe la derivación en silencio — falla la batería de
 * TTL y obliga a re-revisar el margen a mano.
 */

/**
 * Máximo de steps que acepta un pipeline de `/compose`.
 *
 * ⚠️ Si lo subís: re-revisá `ESTIMATED_MAX_RUN_WALL_CLOCK_MS` en
 * `src/adapters/solana/payment.ts` (la cota estimada de wall-clock de un run
 * escala linealmente con este número, y de ella salen la ventana protegida y el
 * TTL del dedup de settles).
 */
export const MAX_COMPOSE_STEPS = 5;
