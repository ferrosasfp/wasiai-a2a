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

### [2026-07-24 16:00] Wave 1 — DESVIACIÓN de Scope IN: el guard de publish vive TAMBIÉN en `routes/agents.ts`
- **Error**: el Story File lista solo `src/services/agent.ts` para el guard namespace-aware de publish, pero el rechazo real de `payoutWallet` inválido ocurre PRIMERO en `routes/agents.ts` (422 antes de llegar al service). Con el guard EVM-only del route, AC-1 (publicar wallet base58) era IMPOSIBLE end-to-end.
- **Causa raíz**: Scope IN incompleto — no incluyó `routes/agents.ts` pese a ser la puerta de entrada del publish y a que AC-1 es un gate de W1.
- **Fix**: se hizo el route guard namespace-aware (mirror mínimo del service): `isValidPayoutWalletForChain(v, payoutChain)` resuelve la familia vía `normalizeChainSlug` (ausente→EVM byte-idéntico; solana-devnet→base58; desconocida→422 AC-6). Se preservó el `reason` EVM 'must be a valid EVM address' byte-idéntico. Se thread `input.payoutChain`.
- **Aplicar en**: FLAG PARA AR/CR — desviación consciente de Scope IN, justificada por AC-1. Revisar que el route guard no relaje la validación EVM (solo agrega la rama Solana cuando payoutChain lo indica).

### [2026-07-24 16:05] Wave 1 — Ordering: `chain-resolver` (W2) debía adelantarse a W1
- **Error**: `agent.ts` (W1) resuelve la familia vía `normalizeChainSlug`, pero los aliases Solana estaban planificados para W2. Sin ellos, AC-1 (payoutChain:'solana-devnet') se rechazaría como chain desconocida.
- **Fix**: se adelantaron los aliases Solana de `SLUG_ALIASES` a W1 (el resolver es puro y flag-independiente → seguro). W2 solo agrega el test de discovery.
- **Aplicar en**: al derivar familia desde slug en una wave, el resolver que la reconoce debe estar listo en la MISMA o anterior wave.

### [2026-07-24 16:11] Wave 1 — Tests preexistentes usaban 'solana' como chain DESCONOCIDA
- **Error**: 2 tests (`x402.chain-aware.test.ts` T-AC4a, `discovery.test.ts` T-AC5) usaban el slug `'solana'` como ejemplo de chain no reconocida. Al hacerse reconocida (feature), rompieron.
- **Fix**: cambiar el ejemplo a `'solana-mainnet'` (NO reconocido, devnet-only CD-4). Se preservó la aserción y la intención del test (chain desconocida → CHAIN_NOT_SUPPORTED / payment undefined). NO es cambio de expectativa: el input dejó de ser válido para el caso "unknown".
- **Aplicar en**: al agregar un slug al resolver, `grep` los tests que lo usaban como stand-in de "desconocido" y reapuntarlos a un slug aún inválido.

### [2026-07-24 16:30] Wave 4 — DESVIACIÓN: compose inbound se deja EVM-only (NO se agrega rama Solana inbound)
- **Contexto**: el Story File W4 pide una "rama inbound Solana" en compose (:798-991). Pero esa rama es el pago INBOUND (caller→gateway) que firma EIP-3009 sobre la DEFAULT chain, y §1 dice explícitamente "el caller NO posee wallet Solana" → inbound-Solana es semánticamente imposible.
- **Problema**: cablear `getPaymentAdapterOrUnion()` en compose inbound forzaba actualizar ~34 mocks de `registry.js` en toda la suite (blast radius enorme, riesgo money-path).
- **Decisión**: compose inbound se deja usando `getPaymentAdapter()` (narrowa a EvmPaymentAdapter, fail-loud si la default fuera Solana — config no soportada, correcto). El settle Solana REAL vive en el DOWNSTREAM (`signAndSettleDownstream`, settle-only operator-signed), que ES la ruta del fee del agente Solana. Solo se agregó el threading de `intentId` en compose (invokeAgent + call sites) — inocuo para los mocks.
- **Aplicar en**: FLAG PARA AR/CR — desviación consciente. La justificación (§1 caller sin wallet Solana + downstream es la ruta real) debe validarse. El único mock tocado fue `downstream-payment.test.ts` (getPaymentAdapterOrUnion + vmFamily:'evm').

### [2026-07-24 16:32] Wave 4 — intentId idempotente: `composeRunId:stepIndex` (no Date.now)
- **Error potencial**: derivar el intentId del leg Solana de `Date.now()` haría que el retry (que re-invoca) genere un intentId distinto → re-emitiría un settle ya confirmado (AC-7 violado / doble pago).
- **Fix**: `const composeRunId = randomUUID()` una vez por ejecución de compose(); intentId = `${composeRunId}:${i}`. Estable entre master+retry del MISMO step (idempotente AC-7), distinto entre ejecuciones (no dedup cross-run). El almacén real (persistencia cross-proceso) se cierra en W5 (ledger settle_signature); el seam W3/W4 es in-memory.
- **Aplicar en**: cualquier clave de idempotencia debe ser estable a través de los reintentos del MISMO trabajo lógico y única entre trabajos distintos — nunca `Date.now()` por-intento.
