# Adversarial Review — WKH-191a: captura + persistencia firma EIP-712 `DebitAuthorization`

- **Rol**: nexus-adversary (AR)
- **Fecha**: 2026-07-13
- **HU**: 191a (Wave 0 del EPIC WKH-191 — non-custodial settlement)
- **Story File**: `doc/sdd/173-wkh-191a-debit-authorization-capture/story-HU-191a.md`
- **Naturaleza**: firma **INERTE** (cero movimiento de fondos) · migration aditiva · flag-gated `ESCROW_DEBIT_CAPTURE_ENABLED` default OFF

## Gates ejecutados por el Adversary (no confié en el reporte del Dev)

| Check | Comando | Resultado |
|-------|---------|-----------|
| Typecheck | `npx tsc --noEmit` | **PASS** (exit 0) |
| Suite completa | `npx vitest run` | **2868 passed / 0 failed** |
| 4 archivos tocados | `vitest run` sobre eip712/debit-capture/payments/payment-intent | **69 passed / 0 failed** |
| Lint | `biome check` (binario directo) sobre 10 archivos tocados | **PASS** (exit 0, 0 fixes) |

## Superficie revisada

Diff real (`git diff` + untracked): `src/adapters/escrow/{eip712.ts,eip712.test.ts,debit-capture.ts,debit-capture.test.ts}`, `src/services/payment-intent.ts(+test)`, `src/routes/payments.ts(+test)`, `src/types/database.types.ts`, migraciones `20260713000000_wkh191a_debit_signatures[_down].sql`, `contracts/src/WasiAIEscrow.sol` (solo lectura, verificación de convergencia). `contracts/**` NO modificado (confirmado por `git status`).

---

## 11 categorías de ataque

### 1. Security — **OK**
- Ownership Guard doble: (a) RPC `capture_debit_signature` con `SELECT owner_ref ... FOR UPDATE` + `IF v_owner IS DISTINCT FROM p_owner_ref THEN RAISE 'OWNERSHIP_MISMATCH'` (`migration :76-85`); (b) lectura de `buyer_wallet` filtrada por `.eq('id',intentId).eq('owner_ref',ownerRef)` (`debit-capture.ts:122-127`). Patrón WKH-53 respetado.
- Sin SQL dinámico (`EXECUTE format`) — todo parametrizado en plpgsql, sin vector de injection.
- Sin secrets en código. La firma cruda del cliente se persiste como TEXT sin ejecutarse.
- `recovered.toLowerCase() !== buyerWallet.toLowerCase()` (`:150-154`) rechaza cualquier firmante que no sea el `buyer_wallet` owner-guarded; `buyerWallet===null` cae en `SIGNER_MISMATCH` (no acepta firmante arbitrario).

### 2. Error Handling — **OK**
- `captureDebitSignatureBestEffort` (`debit-capture.ts:222-237`) envuelve TODO en try/catch que NUNCA re-lanza; error del RPC (`persist :202 if(error) throw`) se propaga al wrapper que lo traga con `log.warn`. Verificado en vivo por T-7 (RPC devuelve `OWNERSHIP_MISMATCH` → `resolves.toBeUndefined()`).
- Recover malformado → `null` (`eip712.ts:167-177`) → `SIGNER_MISMATCH`, no throw.

### 3. Data Integrity — **OK**
- Anti-replay race-safe en 3 capas: pre-check `SELECT ... WHERE status='valid'` (`migration :89-100`) + índice único parcial `uq_debit_sig_valid_nonce` (`:42-44`) + `EXCEPTION WHEN unique_violation` re-inserta como `invalid/NONCE_ALREADY_USED` (`:114-125`). Dos `valid` concurrentes sobre `(key_id,nonce)`: el 2º pierde el índice y degrada — no puede duplicar el nonce válido.
- El índice `WHERE status='valid'` refleja fielmente `_usedNonces[keyId][nonce]` del contrato (consumido solo en `debit()` exitoso, `WasiAIEscrow.sol:139`): intentos `invalid` NO queman el nonce.
- Migración envuelta en `BEGIN/COMMIT`.

### 4. Performance — **OK**
- Costo por close/settle con flag ON y firma presente: 1 `select buyer_wallet` + 1 `rpc`. Awaited en el hilo del settle pero best-effort; sin N+1, sin loops. Latencia adicional documentada (R-4) y aceptada; con flag OFF cero costo.

### 5. Integration — **OK**
- Parámetros nuevos `debitCapture?` son opcionales y appended (`closeSession` 4º, `settleUpto` 5º) → backwards-compatible.
- Con flag OFF el route pasa `debitCapture=undefined` y `allowStaleRecovery=false` explícito (== default previo) → llamada byte-idéntica. Verificado por T-3.
- El seam `settlePaymentIntentOnChain` y las ramas de dinero NO se tocan (diff confirma inserción SOLO entre `finalUsd` y el `if(finalMicro<=0)`).

### 6. Type Safety — **MENOR** (MNR-1, ver abajo)
- Sin `any` en código de producción. Los `as any` viven solo en test doubles con `biome-ignore` justificado. `tsc` verde.

### 7. Test Coverage — **OK**
- 13 tests cubren ≥1 por AC + convergencia (T-10) + best-effort (T-8) + negativos (AMOUNT/SIGNER/DEADLINE/NONCE mismatch). Mocks no mienten: `recoverDebitAuthorization`/`buildDebitDomain` son reales (viem), firma real vía `privateKeyToAccount`. T-7 ejercita el wrapper real; T-8 usa un doble con la misma semántica no-throw (el wrapper real queda cubierto por T-7). Cobertura combinada suficiente.

### 8. Scope Drift — **OK**
- Todos los archivos modificados están en Scope IN §3. `_INDEX.md` + `doc/sdd/**` son artefactos de proceso esperados. Cero refactor de código adyacente. `contracts/**` intacto (CD-4).

### 9. Destructive Migrations — **OK** (revisada, no N/A)
- `20260713000000_wkh191a_debit_signatures.sql` es 100% aditiva: `CREATE TABLE IF NOT EXISTS` (tabla nueva sibling), `CREATE INDEX`, `CREATE OR REPLACE FUNCTION`. Cero `DROP/ALTER/UPDATE/TRUNCATE` sobre tablas con data. FK `ON DELETE CASCADE` hacia `a2a_payment_intents` (no toca la tabla padre). Down reversible (`DROP FUNCTION`/`DROP TABLE`) con `BEGIN/COMMIT`. No requiere rollback plan especial.

### 10. RPC con SECURITY DEFINER — **OK**
- `capture_debit_signature` es `SECURITY DEFINER` (`migration :133`) PERO: `search_path` fijado vía `ALTER FUNCTION ... SET search_path = public, pg_temp` (`:135-136`) → sin schema hijacking; valida ownership internamente (`FOR UPDATE` + `IS DISTINCT FROM`, `:76-85`); sin SQL dinámico (todo parametrizado); `REVOKE EXECUTE FROM PUBLIC, anon, authenticated` + `GRANT ... TO service_role` (`:137-140`) → no expuesto a PostgREST/anon. La lista de tipos del ALTER/REVOKE/GRANT coincide con los 11 args. RLS deny-by-default habilitada (`:47`).

### 11. Cache Invalidation — **N/A**
- La HU no introduce ninguna capa de cache (React Query / SWR / revalidatePath / Redis / memoization nuevas). Solo persistencia DB directa.

---

## Hallazgos

### MNR-1 — Type Safety — `src/types/database.types.ts` (Row `a2a_payment_intent_debit_signatures`)
- **Descripción**: las columnas `debit_amount_atomic` y `debit_nonce` son `NUMERIC(78,0)` (uint256) en la migración (`:24,:26`) pero el `Row` las tipa como `number` (`database.types.ts`, líneas del bloque nuevo). Un uint256 > 2^53 leído vía `.from().select()` sufriría pérdida de precisión (supabase-js además devuelve NUMERIC como string en runtime → doble discrepancia tipo-vs-runtime). El bloque `Functions.Args` SÍ lo hace bien (`p_amount_atomic: string`, `p_nonce: string`).
- **Reproducción**: en 191b, `const { data } = await supabase.from('a2a_payment_intent_debit_signatures').select('debit_amount_atomic')` → `data.debit_amount_atomic` tipado `number`; para `2n**60n` (`1152921504606846976`) el valor real excede `Number.MAX_SAFE_INTEGER` → truncación silenciosa al castear.
- **Impacto**: **DORMIDO en 191a** — no existe ningún reader de esta tabla (grep confirmado: solo la escribe el RPC vía `debit-capture.ts:189`). Se activa recién en 191b cuando se lea el `amount`/`nonce` para presentar el débito on-chain. No rompe ningún AC de 191a ni la firma inerte.
- **Sugerencia**: tipar `debit_amount_atomic`/`debit_nonce` como `string` en `Row`/`Insert`/`Update`, consistente con la convención `cap_nonce TEXT` de wkh135 y con los `Args`. No bloquea 191a; conviene cerrarlo antes de que 191b lea la columna.

### Observación informativa (NO finding) — convergencia de identidad `buyer_wallet` ↔ `_depositor[keyId]`
- El typed-data converge byte-a-byte con `WasiAIEscrow.sol` (orden `keyId,amount,deadline,nonce` `:33-37`↔`:39`; domain `WasiAIEscrow`/`1` `:68-69`↔`:80`; prioridad deadline→signer→amount espeja `_verifyAndConsume`). La validez ECDSA de una firma marcada `valid` se preserva on-chain siempre que `verifyingContract` (env `A2A_ESCROW_CONTRACT_*`) y `chainId` (`row.chain_id`) apunten al contrato deployado. Además 191a valida `recovered==buyer_wallet` mientras el contrato valida `recovered==_depositor[keyId]`: la equivalencia `buyer_wallet==depositor` es un binding de identidad que se materializa en el deploy/191b. Como la firma es INERTE y este binding es scope explícito de 191b, no es un finding de 191a — se registra para que 191b lo asiente.

---

## Veredicto global

**APROBADO con MENORs**

- **BLOQUEANTES: 0** (ALTO 0 / MEDIO 0 / BAJO 0) → el gate NO se bloquea.
- **MENOR: 1** (MNR-1, type fidelity NUMERIC→number, dormido en 191a, relevante para 191b).
- Los 6 vectores de ataque priorizados (inercia, flag-off byte-idéntico, robustez del settle, convergencia con el contrato, anti-replay/ownership, validación de monto) se probaron y **resistieron**. La firma es demostrablemente inerte: cero readers, cero `escrow.debit()`/`writeContract` desde el path de captura, `contracts/**` intacto.

MNR-1 no bloquea DONE; se decide si entra ahora o va al backlog de 191b (recomendado cerrarlo antes de que 191b lea la columna).
