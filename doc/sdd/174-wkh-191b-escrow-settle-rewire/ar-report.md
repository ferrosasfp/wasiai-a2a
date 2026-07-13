# Adversarial Review — WKH-191b (Rewire escrow-aware del settle, two-hop)

> Fecha: 2026-07-13 · Branch: `feat/191b-escrow-settle-rewire` · Reviewer: nexus-adversary
> Input: story-HU-191b.md + sdd.md + working-tree diff (7 mod + 4 nuevos)
> Gate baseline: `tsc --noEmit` PASS · `vitest run` **2896 passed / 0 failed** (191b: 77 tests T-1..T-11 verdes)

## Veredicto global: **APROBADO con MENORs**

Sin BLOQUEANTEs (ALTO/MEDIO/BAJO). 2 hallazgos MENOR (documentación/defensa-en-profundidad),
ninguno bloquea el gate. El money-path es seguro: con el flag OFF (default) el settle es
byte-idéntico al path operator-custodial de HOY; con el flag ON no hay pérdida de fondos ni
double-pay del seller introducido por 191b; los estados de fallo son durables, queryables y
resolubles por 191c (no bricked).

---

## Evidencia por las 11 categorías

### 1. Security — OK
- Reader `readValidDebitSignature` owner-guarded: `.eq('owner_ref', ownerRef)` (`debit-capture.ts:118`).
- Ambos RPC (`record_debit_hop1`, `record_debit_settle_status`) hacen owner-guard DB-level
  (`SELECT owner_ref ... FOR UPDATE` + `OWNERSHIP_MISMATCH`) — migración `:44-52, :103-111`.
- Sin secrets en código; PK desde `OPERATOR_PRIVATE_KEY` env (`debit-executor.ts:77`).
- Sin SQL dinámico: los RPC son plpgsql parametrizado, cero `EXECUTE format(...)`.
- Fund movement 100% gateado por `isEscrowSettleEnabled()` (AND de 2 flags), default OFF.

### 2. Error Handling — OK
- `settleEscrowAware` envuelto en try/catch externo → cualquier throw (reader/executor/RPC) cae
  al seam sin rechazar (`payment-intent.ts:610-619`, CD-S5). Test T-9 lo prueba (2 casos).
- `executeDebitHop1` nunca lanza: sin PK/RPC→not_moved; writeContract catch→not_moved;
  receipt catch→ambiguous; revert→not_moved (`debit-executor.ts:148-234`).
- `readValidDebitSignature` try/catch → null (`debit-capture.ts:110-142`).

### 3. Data Integrity — OK (reconciliation-pending documentado; ver MNR-1)
- **Exactly-once (AC-5):** `if (row.debit_hop1_tx_hash)` skip hop 1 (`payment-intent.ts:522-523`);
  `record_debit_hop1` idempotente por COALESCE (migración `:56-58`); nonce on-chain (`_usedNonces`)
  + índice único parcial `uq_debit_sig_valid_nonce` de 191a. Test T-5.
- **Narrow window R-2:** crash entre hop1-confirmado y persist → retry re-intenta hop1 → revert
  `NonceAlreadyUsed` → `not_moved` → fallback al seam; operador ya recibió los fondos del escrow
  ⇒ nets zero. Documentado (R-2) + test T-11. NO introduce double-pay del seller: el hop 2 solo
  corre una vez por invocación de `settleEscrowAware`, y la re-entrada está gateada por la máquina
  de estados del RPC `close_payment_intent_for_settle` (prev_status='closing' → rama de recovery
  en `:757-834`, NO re-entra `settleEscrowAware`) — misma garantía que el path custodial WKH-136.
- **hop1 ambiguous / hop2 fail → reconciliation_pending:** el remap unequivocal→ambiguous
  (`payment-intent.ts:590-606`, CD-S4) evita el refund off-chain; el caller finaliza
  `failed_ambiguous` (verificado en `:960-994` y `:1290-1321`) → NO refund. Estado durable
  (`debit_settle_status='reconciliation_pending'`) + índice `idx_debit_sig_settle_status` para 191c.

### 4. Performance — OK
- Flag-OFF fast-path en la 1ª línea (`payment-intent.ts:503`): 2 env reads, cero DB / cero on-chain.
  Test T-2 confirma que reader/executor NUNCA se llaman. Latencia byte-idéntica.
- Clients viem cacheados per-ChainKey (`debit-executor.ts:67-118`). Sin N+1.

### 5. Integration — OK
- Seam `settlePaymentIntentOnChain` **byte-idéntico**: diff vs HEAD tiene 0 borrados en el cuerpo
  del seam; los únicos cambios son los 2 call-sites (`settlePaymentIntentOnChain(` → `settleEscrowAware(`)
  y un reorder de import (`getPaymentAdapter` fusionado con `getDefaultChainKey`).
- Migración aditiva (3 cols nullable + índice parcial + 2 RPC), backwards-compatible, con `_down`.
- Evento `Debited` aditivo al ABI TS (`abi.ts`), converge con `WasiAIEscrow.sol:62`. Cero Solidity.

### 6. Type Safety — OK
- NUMERIC uint256 (`debit_amount_atomic`, `debit_nonce`, `p_nonce`) tipados `string`, leídos con
  `BigInt(...)`, nunca `Number()` (`database.types.ts`, `debit-capture.ts:131-137`, CD-S1).
- Cast documentado `data as unknown as ValidDebitRow | null` (CD-S2, `debit-capture.ts:125`).
- Sin `any` injustificado. `tsc --noEmit` PASS.

### 7. Test Coverage — OK
- 77 tests: T-1..T-11 + happy/negative del executor y reader. Cubren flag-off byte-idéntico,
  sin firma, amount/deadline mismatch, not_moved, hop2-fail remap (+ assert en el caller que
  finaliza `failed_ambiguous` sin refund), hop1-ambiguous, exactly-once, chain sin escrow,
  CD-S5 no-rechaza, confirmations + DEBITED_EVENT_NOT_FOUND, receipt reverted.
- T-10 (ownership SQL) documentado como cubierto por el guard idéntico de 191a (no ejecutado como
  test de integración SQL) — aceptable, ver nota categoría 10.

### 8. Scope Drift — OK
- Solo archivos del Scope IN (migración, abi.ts, database.types.ts, debit-capture.ts,
  debit-executor.ts, payment-intent.ts + tests). Seam intacto. Sin refactors no pedidos.

### 9. Destructive Migrations — OK
- 100% aditiva: `ADD COLUMN IF NOT EXISTS` (3 nullable, sin NOT NULL sobre tabla con data),
  `CREATE INDEX IF NOT EXISTS` parcial, `CREATE OR REPLACE FUNCTION`. Sin DROP/ALTER TYPE/UPDATE
  masivo/TRUNCATE/rename. Wrap `BEGIN/COMMIT`. `_down.sql` reversible presente.

### 10. RPC con SECURITY DEFINER — OK
- Ambos RPC: `SET search_path = public, pg_temp` (migración `:79-80, :123-124`) — sin schema
  hijacking. `REVOKE EXECUTE FROM PUBLIC, anon, authenticated` + `GRANT ... TO service_role`.
- Owner-guard interno (valida `auth`-equivalente vía `a2a_payment_intents.owner_ref` + `FOR UPDATE`).
- Sin SQL dinámico. No expuestos a PostgREST/anon.
- *Observación (no-finding):* el `UPDATE ... WHERE key_id = p_key_id AND debit_nonce = p_nonce AND
  valid` no incluye `intent_id`/`owner_ref` en el WHERE (el owner-guard valida `p_intent_id`). Dado
  el índice único parcial `uq_debit_sig_valid_nonce`, el acceso service_role-only y que la app
  siempre pasa la tripla `(intent_id, key_id, nonce)` consistente (el reader es owner-guarded), NO
  es explotable. Espeja el patrón ya auditado de 191a. Hardening opcional.

### 11. Cache Invalidation Logic — N/A
- 191b no introduce ninguna capa de cache de datos de usuario (React Query/SWR/Redis/CDN). Los
  `Map<ChainKey, ...>` de clients viem cachean objetos de conexión por cadena, no datos por-tenant
  → sin riesgo de cross-tenant staleness.

---

## Hallazgos

### MNR-1 — Data Integrity / Documentación: invariante de accounting de reconciliation-pending no explícito para 191c
- **Categoría:** Data Integrity
- **Archivo:** `payment-intent.ts:558-606` + SDD §11 R-3
- **Descripción:** En los estados `reconciliation_pending` (hop1 confirmed + hop2 fail; hop1 ambiguous)
  el buyer queda **temporalmente doble-contabilizado**: el escrow debitó `finalUsd` al operador
  (hop 1) Y el budget off-chain quedó debitado sin refund (`finalize('failed_ambiguous')`). R-3
  documenta el netting del happy-path pero NO explicita que en reconciliation-pending el operador
  **custodia** los fondos del hop 1 y que 191c DEBE deshacer un lado (refund del escrow vía
  `withdraw()` O completar hop 2 + refund off-chain). No hay pérdida permanente (fondos recuperables
  en el operador) y el estado es durable + queryable, por eso NO bloquea.
- **Reproducción:** flag ON, escrow activo, firma valid, hop1→confirmed, seam→failed → intent
  terminal `failed_ambiguous` con escrow debitado + budget off-chain debitado. Query
  `debit_settle_status='reconciliation_pending'` lo captura.
- **Impacto:** si 191c no implementa el unwind correcto, el buyer permanece doble-cobrado. Riesgo
  de spec, no de 191b.
- **Sugerencia:** documentar en el SDD/handoff de 191c la invariante explícita "reconciliation_pending
  ⇒ operador custodia hop1 ⇒ refund exactamente-un-lado". No requiere cambio de código en 191b.

### MNR-2 — Test Coverage: T-10 (ownership RPC) no ejecutado como test de integración SQL
- **Categoría:** Test Coverage
- **Archivo:** story-HU-191b.md T-10 / `debit-capture.test.ts`
- **Descripción:** El owner-guard DB-level de `record_debit_hop1`/`record_debit_settle_status` está
  presente en la migración pero se documenta como "cubierto por el guard idéntico de 191a" en lugar
  de un test SQL propio. El guard es correcto por inspección; la cobertura es por analogía.
- **Impacto:** bajo — el patrón es idéntico al `capture_debit_signature` ya testeado (T-7 de 191a).
- **Sugerencia:** opcional, agregar un test de integración SQL directo cuando exista harness de DB.

---

## Priorización del fix-pack
Ninguno bloquea. MNR-1 y MNR-2 son documentación/cobertura opcional → backlog o handoff a 191c.

*AR generado por NexusAgil — fase AR (Adversarial Review)*
