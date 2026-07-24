# Auto-Blindaje — WKH-234 (Solana Payment Adapter)

Errores/decisiones defensivas registradas durante F3. Cada entrada protege HUs futuras del mismo error.

### [2026-07-24 15:55] Wave 0 — El union discriminado ensancha `getPaymentAdapter()` y rompe ~15 archivos consumidores
- **Error**: al convertir `PaymentAdapter` en unión `EvmPaymentAdapter | SolanaPaymentAdapter`, `getPaymentAdapter()` pasó a devolver la unión → 56 errores TS en 15 archivos (consumidores que leen `getToken`/`sign`/`chainId`/`supportedTokens[].address`, más tests que anotan `let adapter: PaymentAdapter`).
- **Causa raíz**: TS no permite acceder a miembros EVM-only sobre la unión sin narrowing. Casi todos los call-sites del gateway son EVM-exclusivos (x402 middleware, fee-*, payment-intent, deposit route, sign flows).
- **Fix**:
  1. `getPaymentAdapter(chainKey?): EvmPaymentAdapter` narrowa por el discriminante `vmFamily` (throw fail-loud si no-EVM; inalcanzable para las 7 chains EVM → byte-idéntico). Esto arregló los 9 archivos de producción SIN tocarlos.
  2. Nuevo accessor `getPaymentAdapterOrUnion()` devuelve la unión para los dos choke-points de settle (downstream/compose, W4).
  3. Sitios forzados por tsc que leen `supportedTokens[].address` (deposit-verifier, settle-verifier, x402 middleware, deposit route): narrowing local `vmFamily === 'evm'` (byte-idéntico EVM; Solana nunca los alcanza — deposit/settle-verify son viem-only). CD-13 sanciona explícitamente extender estos sitios (nombra middleware/x402).
- **Aplicar en**: cualquier futura generalización de una interfaz-a-unión: prever el blast-radius de accessors compartidos y proveer un accessor narrowed para el caso común + un accessor de unión para los pocos sitios poliglota.

### [2026-07-24 15:57] Wave 0 — Mocks de test sin el campo discriminante `vmFamily`
- **Error**: 14 tests fallaron en runtime (`getPaymentAdapter: resolved a non-EVM (undefined)`, TOKEN_MISMATCH, deposit-info vacío) porque los mocks de payment (`registry.test.ts`, `deposit-verifier.test.ts`, `x402.settle-reverify.test.ts`, `auth.test.ts`) construyen objetos payment con `as unknown as` SIN `vmFamily`.
- **Causa raíz**: los mocks son fixtures incompletos de `EvmPaymentAdapter`; tsc no los cazó por el cast `as unknown`. El narrowing runtime por `vmFamily` los trató como no-EVM.
- **Fix**: completar cada mock payment con `vmFamily: 'evm'`. NO se cambió ninguna aserción (`expect(...).toBe(...)` intactos) → AC-4 preservado.
- **Aplicar en**: al agregar un campo discriminante a una interfaz, `grep` los mocks `as unknown as X['payment']` y completarlos. El cast oculta el faltante al compilador; solo el runtime lo revela (correr `npm test` completo, no solo tsc).

### [2026-07-24] Wave 0 — Colisión de nombre interfaz/clase `SolanaPaymentAdapter`
- **Error potencial**: el Story File dice `class SolanaPaymentAdapter implements SolanaPaymentAdapter`; declarar clase e importar la interfaz homónima en el mismo módulo colisiona (duplicate identifier).
- **Fix**: importar la interfaz con alias `import type { SolanaPaymentAdapter as ISolanaPaymentAdapter }` y `class SolanaPaymentAdapter implements ISolanaPaymentAdapter`.
- **Aplicar en**: cualquier adapter nuevo cuyo nombre de clase coincida con su interfaz de contrato.
