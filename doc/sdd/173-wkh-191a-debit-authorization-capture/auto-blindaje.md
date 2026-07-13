# Auto-Blindaje — WKH-191a (Dev F3)

### [2026-07-13 07:00] Wave 0 — biome envuelve `Returns` largo del RPC en `database.types.ts`
- **Error**: `biome check` falló en `database.types.ts` porque el `Returns: { persisted_status: string; persisted_reason: string | null }[];` (single-line, copiado del template §6.3) excedía el line-width y biome exigía multi-línea.
- **Causa raíz**: el objeto `Returns` de `capture_debit_signature` tiene dos props con un union `| null`, más largo que `accumulate_payment_voucher` (que sí cabe en una línea). biome envuelve por ancho, no por número de props.
- **Fix**: `biome check --write src/types/database.types.ts` (formateo automático a multi-línea).
- **Aplicar en**: cualquier tipo de `Returns`/`Args` nuevo en `database.types.ts` — correr `biome check --write` sobre el archivo tras editarlo a mano (CD-S3).

### [2026-07-13 07:00] Wave 0 — `p_amount_atomic`/`p_nonce` como `string`, no `number`
- **Error**: el template §6.3 tipa `p_amount_atomic: number` y `p_nonce: number`, pero §7.1 paso 8 exige pasar `bigint.toString()` (string) para NUMERIC(78,0) sin pérdida de precisión > 2^53.
- **Causa raíz**: tensión entre el bloque literal del Story (§6.3) y la nota VERIFY-AT-IMPL (§7.1/§405). uint256 no cabe en `number`.
- **Fix**: tipé `p_amount_atomic: string` y `p_nonce: string` en el `Args` del RPC (CD-S4: preferir tipar bien sobre castear). `p_deadline` queda `number` (epoch seconds, cabe). Consistente con `captureDebitSignature` que pasa `.toString()`.
- **Aplicar en**: cualquier RPC futuro con params NUMERIC uint256 → tipar `string` en `database.types.ts`.

### [2026-07-13 07:15] Wave 1 — indentación del comentario `biome-ignore` en el test
- **Error**: `biome check` falló en `debit-capture.test.ts` por la indentación de un `// biome-ignore lint/suspicious/noExplicitAny` colocado a mano dentro de un objeto.
- **Causa raíz**: el comentario quedó con menos indentación de la que biome exige para su posición dentro del objeto literal.
- **Fix**: `biome check --write` re-indentó automáticamente.
- **Aplicar en**: correr `biome check --write` sobre cada test nuevo antes del gate (CD-S3), no solo sobre el código de producción.

### [2026-07-13 07:20] FIX-PACK — `mockResolvedValue` multi-línea innecesario en T-8
- **Error**: `biome check` falló en `payment-intent.test.ts` porque `mockRecover.mockResolvedValue('0x…')` lo escribí en 3 líneas y biome exigía single-line (cabía en el ancho).
- **Causa raíz**: envolví el argumento manualmente sin necesidad; el string+call entraba en una sola línea.
- **Fix**: colapsado a una línea. `biome check` verde.
- **Aplicar en**: no pre-envolver llamadas cortas a mano; dejar que biome decida el wrapping.
