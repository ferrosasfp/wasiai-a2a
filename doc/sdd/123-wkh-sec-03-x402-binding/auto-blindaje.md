# Auto-Blindaje — WKH-SEC-03 (x402 inbound binding)

### [2026-06-23 W4] Wave 4 — T-AC6 falso positivo por aserción demasiado amplia
- **Error**: el test T-AC6 asercionaba `res.body.toLowerCase()` no contiene `'dead'`, y falló porque el body 402 incluye `accepts[0].payTo === '0x..dEaD'` (el wallet del server anunciado por protocolo).
- **Causa raíz**: confusión de scope de CD-2. CD-2 prohíbe exponer el wallet en el **mensaje de error** (`error`), NO en el `accepts[0].payTo`, que el protocolo x402 SIEMPRE anuncia (Story File líneas 201-203: "el `accepts[0].payTo` del challenge ya anuncia el wallet correcto vía protocolo; eso es esperado y correcto").
- **Fix**: la aserción ahora valida `body.error.toLowerCase()` no contiene `'dead'` (el campo de mensaje genérico), no el body completo.
- **Aplicar en**: cualquier test que valide CD-2 — chequear el campo `error` del challenge, nunca `accepts[].payTo`, que es protocolo-mandatorio.

### [2026-06-23 W5] Wave 5 — regresión CD-10 por quote() ausente y value 6-dec contra quote kite 18-dec
- **Error**: 5 tests legacy fallaron. (a) Los 4 de `x402.passport-shape.test.ts` daban 500 porque el `mockAdapter` no tenía método `quote()`. (b) `x402.chain-aware.test.ts` T-AC3b daba 402 (esperaba 200) porque el fixture default usa `value:'1000000'` (6-dec) pero esa ruta cae al default kite (quote 18-dec `10^18`) → underpay.
- **Causa raíz**: el binding check ahora invoca `resolvePaymentRequirements` → `adapter.quote(1)` SIEMPRE (incluso en el happy path), porque `opts.amount` está unset. Antes `quote()` solo corría al construir el 402 challenge. (a) los mocks legacy nunca necesitaron `quote` en happy path. (b) la trampa dimensional CD-7: 6-dec vs 18-dec.
- **Fix**: (a) agregué `quote()` mock devolviendo `amountWei:'1000000'` (6-dec, alineado con el fixture default) al `mockAdapter` de passport-shape. (b) alineé el `value` del fixture a `'1000000000000000000'` en T-AC3b (ruta kite default), por CD-7 — NUNCA escalar dimensiones. Ambos cambios autorizados por W5 paso 3 del Story File.
- **Aplicar en**: cualquier harness de middleware que mockee un PaymentAdapter para el happy path DEBE incluir `quote()` (el binding lo llama siempre). Y todo `value` de fixture debe alinearse a la dimensión del `quote` de la cadena bajo prueba (6-dec base/avax, 18-dec kite).
