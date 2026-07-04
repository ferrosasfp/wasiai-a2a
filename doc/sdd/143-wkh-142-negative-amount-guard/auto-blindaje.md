# Auto-Blindaje — WKH-142 (negative amount guard)

### [2026-07-04] Wave 3 — El comentario del SQL rompió el conteo "INVALID_AMOUNT exactamente 1 vez"
- **Error**: T3 (choke-point) contó 2 ocurrencias de `INVALID_AMOUNT` en el UP y falló; la migración down contenía `INVALID_AMOUNT` en un comentario y rompió el assert "down NO contiene INVALID_AMOUNT".
- **Causa raíz**: usé el literal `INVALID_AMOUNT` dentro de comentarios (`-- CD-7: INVALID_AMOUNT ...` en el UP y `-- ... SIN el guard INVALID_AMOUNT` en el down). El test estructural (y el `git grep` de la Done Definition) cuentan TODAS las apariciones del token, no solo el `RAISE EXCEPTION`.
- **Fix**: reformulé los comentarios ("el prefijo del guard", "el guard de importe negativo") para que el token `INVALID_AMOUNT` aparezca UNA sola vez en el UP (el `RAISE`) y CERO en el down.
- **Aplicar en**: cualquier migración cuyo error-code tenga un CD de "aparece exactamente N veces". NO mencionar el literal en comentarios; describirlo con palabras.

### [2026-07-04] Wave 1 — Agregar una error class exportada rompe el contract-test de errors.test.ts
- **Error**: `npm test` falló en `errors.test.ts` P2-7 ("the contract table covers EVERY exported error class (no drift)") tras exportar `InvalidDebitAmountError`.
- **Causa raíz**: `errors.test.ts` tiene una tabla `ERROR_CONTRACT` que se compara por igualdad exacta contra TODAS las clases exportadas que extienden `Error`. Toda clase nueva DEBE registrarse ahí o el suite falla (fail-on-drift intencional).
- **Fix**: agregué `['InvalidDebitAmountError', 'DEBIT_INVALID_AMOUNT']` a `ERROR_CONTRACT`.
- **Aplicar en**: cualquier HU que agregue una `export class XError extends Error` en `security/errors.ts` — actualizar `ERROR_CONTRACT` en el mismo commit.
