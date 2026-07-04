# Auto-Blindaje — WKH-142 (negative amount guard)

### [2026-07-04] Fix-pack MENOR — el CHECK con `toContain` de substring exacto rompe al extender el CHECK
- **Error**: al pasar el CHECK de `(price_usdc >= 0)` a `(price_usdc >= 0 AND price_usdc <> 'NaN'::numeric)`, el test T6 falló porque asertaba el substring `CHECK (price_usdc >= 0)` con el paréntesis de cierre, que ya no existe (ahora hay ` AND ...)`).
- **Causa raíz**: `toContain` con un fragmento SQL que incluye el `)` de cierre acopla el test al final exacto del predicado; cualquier extensión del CHECK lo rompe.
- **Fix**: aflojé el assert a `CHECK (price_usdc >= 0` (sin paréntesis de cierre) y agregué un test dedicado (MNR-1) que valida el predicado NaN completo por separado.
- **Aplicar en**: al asertar cláusulas SQL extensibles (CHECK, WHERE), no incluir el delimitador de cierre en el substring salvo que se quiera fijar el predicado completo.

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
