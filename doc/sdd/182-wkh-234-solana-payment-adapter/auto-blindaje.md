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

### [2026-07-24 16:41] Wave 5 — CAIP-2 aditivo SIN tocar el HMAC canónico ni el RPC atómico
- **Riesgo**: agregar `settle_caip2`/`settle_signature` al recibo podía (a) romper la firma HMAC de recibos previos si entraban al canonical payload, o (b) requerir tocar el RPC atómico `insert_receipt`/`debit_with_dest_policy` (money-path).
- **Fix**: columnas nullable aditivas en `a2a_receipts` (migración idempotente `IF NOT EXISTS`), NO incluidas en `buildCanonicalPayload` (13 keys intactas → HMAC byte-idéntico). Se setean en el UPDATE-once existente (junto a `receipt_hash`) SOLO cuando el leg es Solana. `budget.debit` gana params opcionales `settleCaip2?/settleSignature?`; tras un debit EXITOSO emite un recibo best-effort reusando el `ownerRef` REQUERIDO (CD-1/AC-9) — sin queries nuevas sobre `a2a_agent_keys`, sin tocar el RPC de debit. EVM (sin settleCaip2) → sin emit extra → byte-idéntico.
- **exactOptionalPropertyTypes**: pasar `string | undefined` a un campo `?: string` rompe tsc (TS2379). El param del helper se tipó `settleSignature: string | undefined` (requerido-pero-undefinable).
- **database.types.ts**: al agregar columnas se deben reflejar en Row/Insert/Update del tipo generado, o el `.update()` tipado falla tsc.
- **NOTA para AR/CR**: el threading LIVE de `settleCaip2` desde compose → `budget.debit` para el leg Solana NO se cableó (compose es W4, fuera del scope W5; el debit per-step usa el chainId inbound del caller). El mecanismo (budget.debit + columna + emit) está implementado y testeado a nivel unit (AC-8/AC-9); el cableado end-to-end es un follow-up fino. → **RESUELTO en el fix-pack AR+CR (entrada de abajo).**

---

## Fix-pack AR + CR (iteración 1) — 2026-07-24

### [2026-07-24 17:05] BLQ-1 (AR) — AC-8 falso-verde: el CAIP-2 nunca se registraba en runtime
- **Error**: `budget.debit` recibía params opcionales `settleCaip2?/settleSignature?` y emitía el recibo Solana SÓLO si estaban presentes, pero NINGÚN call-site real (compose:244/438) los pasaba → para un leg `solana-devnet` la columna `a2a_receipts.settle_caip2` quedaba NULL en el flujo real. El único test que ejercitaba el path era un unit del debit aislado (verde artificial).
- **Causa raíz — ordenamiento temporal**: el `debit` per-step es **fee-on-attempt** — corre ANTES de `invokeAgent` (que es donde ocurre el settle downstream Solana y nace la firma base58). Threadear la firma real al `debit` pre-settle era **temporalmente imposible**. El seam `debit(...,settleCaip2,settleSignature)` que proponía el plan W5 no podía nunca tener un caller real → por eso era un falso-verde estructural.
- **Fix (arquitectura correcta)**:
  1. Se **removieron** los params `settleCaip2?/settleSignature?` de `budget.debit` y sus dos bloques `if (settleCaip2) emit`. El RPC atómico de debit queda intacto (money-path byte-idéntico).
  2. Nuevo método `budgetService.recordSolanaSettleReceipt({keyId,ownerRef,chainId,amountUsd,settleCaip2,settleSignature})` — wrapper del `emitSolanaSettleReceipt` existente (best-effort, fire-and-forget), que REUSA el `ownerRef` del caller (CD-1/AC-9, sin queries nuevas sobre `a2a_agent_keys`).
  3. `DownstreamResult` gana `settleCaip2?: string`; `settleSolanaLeg` lo setea = `adapter.caip2ChainId` (presente SÓLO en la rama Solana; los legs EVM lo dejan `undefined`).
  4. `compose` (happy-path + retry-ok, closure `recordSolanaLegIfAny`) llama `recordSolanaSettleReceipt` **DESPUÉS** de `invokeAgent`, cuando ya existe `downstream.settleCaip2` + `downstream.txHash` (la firma). Guard: sólo si `scopingKeyRow && chainId !== undefined` (hubo débito del caller). Leg EVM → no se invoca → columna NULL → byte-idéntico (AC-4).
- **Test obligatorio (INTEGRACIÓN)**: `compose.test.ts` → `T-234-AC8-INTEG` (leg Solana: `budgetService.recordSolanaSettleReceipt` llamado 1× con `settleCaip2='solana:…'` + firma + `ownerRef` reusado) y `T-234-AC8-INTEG-b` (leg EVM: NO se llama). Los units de `budget.test.ts` se re-apuntaron a `recordSolanaSettleReceipt` (ya no al debit aislado).
- **Desviación consciente vs el fix propuesto**: el orquestador sugería "reusá `debit(..., settleCaip2, settleSignature)`". Se respetó el ESPÍRITU (reuso de `ownerRef`, cero queries nuevas sobre `a2a_agent_keys`) pero NO la letra (debit como seam) porque el ordenamiento fee-on-attempt lo hace imposible. El registro vive en un método post-settle. Flag para el re-AR.
- **Aplicar en**: cualquier metadato que dependa del RESULTADO de un side-effect (settle/broadcast) NO puede threadearse por un seam que corre ANTES del side-effect. El seam correcto es post-side-effect.

### [2026-07-24 17:02] BLQ-2 (CR) — `npm run lint` (biome) en rojo (11 errores)
- **Error**: archivos nuevos/tocados de la HU no pasaban `biome check` (format + organizeImports + useOptionalChain) → gate CI (`.github/workflows/ci.yml`) en rojo.
- **Fix**: `./node_modules/.bin/biome check --write src/` (autofix, 10 archivos) + aplicado a mano el `useOptionalChain` de `payment.ts:188` (`!parsed?.meta`). `npm run lint` → exit 0, sin warnings. `tsc` + suite re-verificados post-autofix (verdes).
- **Aplicar en**: correr `biome check --write` antes de cerrar cada wave; `npm run format` NO alcanza (no toca organizeImports/useOptionalChain). Binario local `./node_modules/.bin/biome` (NO `npx biome` — falla "could not determine executable").

### [2026-07-24 17:00] MNR AR-2 + CR-1 — comentario engañoso + cast redundante
- **AR-2**: el docstring de `settleSolanaLeg` prometía "verify-before-trust internamente" en el settle fresco, pero `payment.ts` sólo llama `verify()` en el camino idempotente-hit. Corregido: el settle fresco confía en `sendAndConfirmTransaction`; `verify()` sólo re-lee una firma previa antes de reusarla.
- **CR-1**: `downstream-payment.ts:479` `txHash: settleRes.txHash as \`0x${string}\`` sobre un campo que ya es `string`. Cast removido, asignación directa.

### [2026-07-24 17:06] MNR AR-1 (idempotencia durable) — DIFERIDO como follow-up
- **Contexto**: hoy el settle Solana dedup por `Map` in-memory (`payment.ts:_intentSignatures`). Un `TransactionExpiredTimeoutError` con la tx igual confirmada, o un restart de proceso, puede re-broadcastear un 2º SPL-transfer (doble-pago del fee).
- **Por qué se difiere**: el fix limpio (consultar el ledger por una firma confirmada del `intentId` ANTES de broadcastear, y `verify()` en vez de re-emitir) NO puede vivir en `src/adapters/solana/*` sin violar clean-arch (CD-7: el adapter NO importa services/ledger). Tendría que vivir en la capa de wiring (`downstream-payment.ts`/`compose.ts`), que necesita: (a) un método de lectura en el ledger `receipts` filtrando por un `intentId` persistido, (b) persistir el `intentId` en el recibo (hoy se persiste `settle_signature` pero no el `intentId` como clave de búsqueda), (c) pasar la firma conocida al adapter para que haga `verify()` en vez de settle. Es un cambio de superficie mayor al scope razonable del fix-pack (toca schema del recibo + lectura + wiring), con riesgo money-path.
- **Estado**: la durabilidad in-proceso (Map + persist `settle_signature` en el ledger vía BLQ-1) reduce la ventana, pero el dedup **cross-proceso** queda como **follow-up**. Recomendado abrir HU: "idempotencia durable del settle Solana vía lookup de `intentId` en el ledger antes del broadcast".

### [2026-07-24 17:06] MNR CR-2 (balance pre-check Solana) — DIFERIDO como follow-up
- **Contexto**: `settleSolanaLeg` no tiene el pre-flight balance check + skip-code `INSUFFICIENT_BALANCE` que la rama EVM sí tiene (`downstream-payment.ts:338-396`).
- **Por qué se difiere**: la paridad exige leer el balance SPL de la ATA del operator vía `@solana/web3.js`/`spl-token`, que por CD-7 debe vivir DENTRO del adapter (nueva superficie `getOperatorSplBalance()` + su unit con `Connection` mockeada). No es trivial (no es el mismo `erc20Abi.balanceOf` de viem). El settle igualmente falla-soft (NEVER-throws → `null` + skip-code `SETTLE_FAILED`) si el operator no tiene fondos, así que no hay regresión de seguridad, sólo falta el skip-code temprano `INSUFFICIENT_BALANCE`.
- **Estado**: **follow-up** (paridad de observabilidad, no bloqueante).
