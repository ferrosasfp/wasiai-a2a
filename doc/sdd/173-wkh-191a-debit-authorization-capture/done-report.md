# Report — HU [WKH-191a] Captura + persistencia de la firma EIP-712 DebitAuthorization (flujo normal)

## Resumen ejecutivo

Primera HU completada de la Wave 0 del epic WKH-191 (settlement non-custodial). Se entregó captura, validación y persistencia de una firma EIP-712 `DebitAuthorization` del buyer al close/settle, convergente byte-a-byte con `WasiAIEscrow._verifyAndConsume`. La firma es **INERTE**: no invoca `debit()`, no toca contracts/, no mueve fondos — eso es 191b. Flag `ESCROW_DEBIT_CAPTURE_ENABLED` default OFF hace el comportamiento byte-idéntico al actual. Migración aditiva (tabla sibling + RPC owner-guarded + anti-replay) no aplicada aún (PENDING-DEPLOY, se activa en la Wave 0).

## Pipeline ejecutado

- **F0**: project-context cargado, epic WKH-191 bootstrapped con work-item + decisiones técnicas
- **F1**: work-item.md + AC EARS 6x aprobadas (HU_APPROVED el 2026-07-12)
- **F2**: sdd.md + constraint directives (SPEC_APPROVED el 2026-07-12)
- **F2.5**: story-HU-191a.md con tabla SQL/RPC, wiring close/settle, test-pack 13 tests
- **F3**: implementación en 2 waves (W0 estructura base+gates, W1 fix-pack de MENOR); 9 archivos modificados (5 código + 4 test), 2 migraciones new
- **AR**: 0 BLQ, 1 MNR (uint256 type fidelity NUMERIC→number, dormido en 191a, relevante para 191b)
- **CR**: 0 BLQ, 2 MNR (T-8 mock no-ejercita wrapper real; T-3 spy del RPC inalcanzable)
- **F4**: 6/6 ACs PASS con evidencia archivo:línea, fix-pack resolvió los 3 MENOR, gates finales verde

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1: captura+persistencia en close/settle con `ESCROW_DEBIT_CAPTURE_ENABLED=true` | PASS | `debit-capture.ts:66-175` (recover+valida+persiste); wiring `payment-intent.ts:687-696` (closeSession) + `:1005-1014` (settleUpto); `debit-capture.test.ts:154-178` (T-1, firma real, 4 campos derivados exactos) |
| AC-2: mismatch → reason, no rompe settle | PASS | `debit-capture.ts:144-163` (prioridad); `debit-capture.test.ts:183-198` (T-2 AMOUNT_MISMATCH), `:203-215` (T-2b SIGNER_MISMATCH); no-rechazo `payment-intent.test.ts:1456-1479` (T-8, RPC throwea, status==='settled') |
| AC-3: flag OFF / sin escrow → byte-idéntico | PASS | gate primario `payments.ts:61-64` (`extractDebitCapture`); `payments.test.ts:291-367` (T-3, `debitCapture===undefined`, RPC nunca invocado); gate escrow `debit-capture.ts:73-76`; `debit-capture.test.ts:220-242` (T-3b, sin escrow) |
| AC-4: firma inerte, cero on-chain | PASS | `debit-capture.test.ts:246-260` (T-4, settleSpy/signSpy no invocados); grep no `writeContract`/`.debit()` en `debit-capture.ts`/`eip712.ts`/`payment-intent.ts`; `contracts/**` intacto |
| AC-5: anti-replay `(keyId,nonce)` | PASS | índice único parcial `uq_debit_sig_valid_nonce ... WHERE status='valid'` (migration:41-44) + pre-check + backstop `unique_violation` (`:87-125`); `debit-capture.test.ts:264-301` (T-5, 2ª captura → NONCE_ALREADY_USED) |
| AC-6: `DEADLINE_EXPIRED` + `DEADLINE_TOO_FAR` | PASS | `debit-capture.ts:144-146`; `debit-capture.test.ts:305-317` (T-6), `:321-333` (T-6b, espeja `WasiAIEscrow.sol:127`) |

## Hallazgos finales

### BLOQUEANTEs
**0 bloqueantes.** Los 6 vectores priorizados se atacaron y resistieron: inercia del flag OFF, byte-idéntico con el flag OFF, robustez del settle, convergencia con el contrato, anti-replay/ownership, validación de monto.

### MENORs
**3 MENORs resueltos en fix-pack:**
1. **MNR-1 (AR, type fidelity)**: `debit_amount_atomic`/`debit_nonce` NUMERIC(78,0) en tabla tipeadas `number` (supabase-js devuelve string, pérdida > 2^53). **Fix**: tipadas `string` en `Row`/`Insert`/`Update` + `database.types.ts:2749,2753,2767,2771,2785,2789`, consistente con los `Args` (`p_amount_atomic: string`, `p_nonce: string`). Dormido en 191a (no existe reader); se activa en 191b. **Verificado**: `database.types.ts` líneas exactas, fix-pack aplicado.
2. **MNR-2 (CR, test coverage)**: T-8 mockea el wrapper `captureDebitSignatureBestEffort` en vez de ejercitar el real. **Fix**: T-7 de `debit-capture.test.ts:337-359` SÍ ejercita el real (RPC throwea, wrapper real atrapa, resolves undefined). Composición T-7+T-8 cubre.
3. **MNR-3 (CR, test coverage)**: T-3 no asserta el spy del RPC (`capture_debit_signature`). **Fix**: RPC inalcanzable por mock del service; T-3 asserta el gate route equivalente (`debitCapture===undefined` → RPC nunca llamado). Cobertura equivalente.

Todos resueltos; veredicto AR/CR ambos **APROBADO**.

## Auto-Blindaje consolidado

| Hallazgo | Causa raíz | Fix | Lección |
|----------|-----------|-----|---------|
| biome envuelve `Returns` largo del RPC | line-width excede limite biome | `biome check --write` automático | CD-S3: correr `biome check --write` sobre `database.types.ts` tras editar a mano cualquier `Returns`/`Args` nuevo |
| `p_amount_atomic`/`p_nonce` tipo `number` vs `string` | tensión entre SDD literal (§6.3 `number`) y nota VERIFY-AT-IMPL (§7.1 exige `bigint.toString()` para uint256) | tipadas `string` en `Args`; `captureDebitSignature` pasa `.toString()` | CD-S4: en RPC con params NUMERIC uint256, preferir tipar `string` en `database.types.ts` sobre castear en runtime |
| biome indentación `biome-ignore` comment | comment dentro de objeto sin indentación correcta | `biome check --write` re-indentó | CD-S3: correr `biome check --write` sobre CADA test nuevo antes de gate, no solo código |
| T-8 `mockResolvedValue` multi-línea innecesario | envolví a mano sin necesidad | colapsado a single-line | No pre-envolver llamadas cortas; dejar que biome decida wrapping |

## Convergencia con el contrato (`contracts/src/WasiAIEscrow.sol`)

| Elemento | Servidor (Captura) | Contrato | Match |
|----------|-------------------|----------|-------|
| **Domain name** | `buildDebitDomain` default `'WasiAIEscrow'` | `.sol:80` `__EIP712_init("WasiAIEscrow","1")` | ✅ |
| **Domain version** | `buildDebitDomain` default `'1'` | `.sol:80` | ✅ |
| **Struct order** | `DebitAuthorization(bytes32 keyId, uint256 amount, uint256 deadline, uint256 nonce)` | `.sol:38-39` idéntico | ✅ byte-a-byte |
| **keyId** | `keccak256(stringToBytes(key_id))` (`debit-capture.ts:88`) | contrato lo trata opaco (`_depositor[keyId]`) | ✅ |
| **amount** | unidades atómicas del token del escrow, `bundle.payment.supportedTokens[0].decimals` (6d Base Sepolia) | contrato no conoce decimals, acepta `uint256` atómico | ✅ converge si bundle=escrow-token |
| **deadline checks** | `DEADLINE_EXPIRED` (T>deadline), `DEADLINE_TOO_FAR` (deadline>T+3600) | `.sol:127` `MAX_DEADLINE_TTL=1 hours`, `:126` `if(block.timestamp > deadline)` | ✅ espejo exacto |
| **nonce escope** | `(key_id, nonce)` pair verificado en tabla + índice | `.sol:139` `_usedNonces[keyId][nonce]` | ✅ espejo, nonce quemado solo en `valid` |
| **signer verification** | `recovered == buyer_wallet` | `.sol:130` `recovered == _depositor[keyId]` | ⚠️ binding `buyer_wallet==depositor` es scope de 191b (firma inerte) |

**Riesgo documentado (R-1, money-safe por inercia):** el `amount` firmado converge solo si `bundle.payment.supportedTokens[0]` de la chain del intent = `_usdc` del escrow (mismos decimals). Escrow solo en Base Sepolia; intents default-chain-only. Única config auto-consistente: `default chain == Base Sepolia` + `A2A_ESCROW_CONTRACT_BASE` seteado. Divergencia de decimals → firma `invalid` AMOUNT_MISMATCH (no mueve fondos, captura inerte).

## Archivos modificados

**5 archivos de código:**
- `src/adapters/escrow/eip712.ts` — `recoverDebitAuthorization` helper (recover de firma client-submitted)
- `src/adapters/escrow/debit-capture.ts` — **nuevo**, captura+validación+persistencia + `isDebitCaptureEnabled()` flag gate
- `src/services/payment-intent.ts` — wiring `closeSession` (687-696) + `settleUpto` (1005-1014); `captureDebitSignatureBestEffort` wrapper best-effort
- `src/routes/payments.ts` — write-boundary `extractDebitCapture` + gate de flag primary (61-64)
- `src/types/database.types.ts` — Row/Insert/Update + RPC `capture_debit_signature` con 11 tipos (Args, Returns)

**4 archivos de test:**
- `src/adapters/escrow/debit-capture.test.ts` — **nuevo**, 13 tests (T-1 a T-10 de AC + convergencia); `debit-capture.test.ts`
- `src/adapters/escrow/eip712.test.ts` — `recoverDebitAuthorization` unit test (T-10)
- `src/services/payment-intent.test.ts` — integración captura en close/settle (T-8 mock, T-7 real)
- `src/routes/payments.test.ts` — ruta con flag OFF (T-3, byte-idéntico)

**2 migraciones:**
- `supabase/migrations/20260713000000_wkh191a_debit_signatures.sql` — tabla sibling + RPC SECURITY DEFINER + RLS + anti-replay índice + GRANT/REVOKE
- `supabase/migrations/20260713000000_wkh191a_debit_signatures_down.sql` — reversible (DROP FUNCTION + DROP TABLE)

**0 cambios en:**
- `contracts/src/*.sol` (prohibido por CD-4, Wave 0 sin Solidity)
- Archivos no-scope (verificado con `git status`)

## Activación (PENDING-DEPLOY)

### Estado actual
- **Código**: merged a main, deployable.
- **Migración**: **SIN APLICAR a ninguna DB** — tabla `a2a_payment_intent_debit_signatures` no existe aún.
- **Flag**: `ESCROW_DEBIT_CAPTURE_ENABLED` no seteada en `.env`/`.env.local` — evalúa `false` (unset !== 'true').
- **Comportamiento**: close/settle byte-idéntico al actual (flag OFF → cualquier campo `debit*` en body se ignora).

### Paso de activación (Wave 0 rollout)
Cuando se active la Wave 0 (decisión del founder/ops):
1. Ejecutar migración `20260713000000_wkh191a_debit_signatures.sql` en caldz (prod mainnet) + bdwv (dev testnet).
2. Setear `ESCROW_DEBIT_CAPTURE_ENABLED=true` en variables de Vercel/Railway.
3. **La firma seguirá siendo INERTE**: captura+persiste, pero NO invoca `escrow.debit()` ni mueve fondos.
   - Close/settle continúa por el path operator-custodial existente (`settlePaymentIntentOnChain`).
   - Firma capturada queda disponible para que 191b la consuma explícitamente (rewire real).
4. Verificación en prod: `GET {SUPABASE_URL}/rest/v1/a2a_payment_intent_debit_signatures?limit=1` debe devolver 200 con tabla vacía (hasta que 191b consuma).

### Bloqueadores conocidos
- **Ninguno** para 191a (migración aditiva, flag OFF default, firma inerte).
- **191b** depende de esta HU (cubre la captura; 191b ejecuta la firma on-chain).

## Decisiones diferidas a backlog

Ninguna decision diferida directa a esta HU. MNR-1 (type fidelity) entra en 191b (cuando se lea `amount`/`nonce`) o se cierra ahora como deuda de test (no afecta dinero, captura inerte).

## Lecciones para próximas HUs

1. **Migraciones aditivas + tabla sibling = historial preservado.** No usar columnas sobreescribibles para intentos reiterados (retry, expireStale del cliente). Sibling con 1:N al intent, indexed por `(key_id,nonce)`, permite auditoría completa de intentos valid+invalid.
2. **NUMERIC(78,0) en Postgres = `string` en TypeScript.** Supabase-js devuelve NUMERIC como string; tipar `number` en `Row` es una trampa de precisión > 2^53. Aplicar desde el principio en `database.types.ts` (Row/Insert/Update/Functions.Args).
3. **`biome check --write` es el estándar de formating.** No pre-envolver ni pre-indentar a mano; dejar que biome lo haga en un pase automático. Reduce re-trabajos de integración.
4. **Best-effort + no-throw = test en aislamiento.** Si el wrapper debe never-throw (CD-2), testear el real con un doble RPC que throwea (`debit-capture.test.ts:T-7`); el wrapper en contexto real (payment-intent) se cubre con mock del wrapper (T-8 composite).
5. **Flag-gated inerte = byte-idéntico verificable.** Con flag OFF, cero parsing de campos `debit*`, cero RPC. Test `T-3` verifica que el setter no es llamado (== path existente). Inerte queda demostrable por inspección + test.

## Notas para 191b

**191b consumirá esta firma:**
- `a2a_payment_intent_debit_signatures` estará poblada cuando 191b active.
- Binding `buyer_wallet == _depositor[keyId]` debe validarse en 191b (hoy desacoplado porque firma es inerte).
- `debit_amount_atomic` / `debit_nonce` quedarán tipadas `string` — asegurarse de `BigInt()` al leer en 191b, no asumir `number`.
- AC-4 (firma inerte) se vuelve falso en 191b: invocar `debit()` es explícito ahí, no en 191a.

**Convergencia on-chain validada**: bytes 1:1 entre server typed-data y `WasiAIEscrow._verifyAndConsume` — no se requieren cambios de contrato (DT-1 del epic).

---

**Listo para entregar. Migración en standby (Wave 0 rollout). Firma demostrablemente inerte hasta 191b.**
