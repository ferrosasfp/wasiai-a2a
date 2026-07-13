# Code Review (Adversary) — WKH-191b (escrow settle rewire, two-hop)

> Fecha: 2026-07-13 · Branch: `feat/191b-escrow-settle-rewire`
> Rol: nexus-adversary (CR — calidad/patrones). AR corre en paralelo (dominio security/integrity).
> Suite: **2896 tests PASS / 0 FAIL** · `tsc --noEmit` limpio · `biome check` limpio (7 archivos).

## Veredicto global: **APROBADO con MENORs**

0 BLOQUEANTEs. 1 MENOR (test placeholder tautológico + cross-reference inexacta). No bloquea DONE.

---

## 1. Fidelidad SDD / Story File — OK

- `settleEscrowAware` (payment-intent.ts:485-624) implementa las ramas EXACTAS del Story §W3.1:
  fast-path flag-OFF en 1ª línea (:497), gate chain/escrow (:500-504), reader (:507-513),
  exactly-once por `debit_hop1_tx_hash` (:516), hop1 con las 3 clasificaciones
  (not_moved→seam / ambiguous→reconcile-sin-hop2 / confirmed→recordDebitHop1 ANTES de hop2),
  hop2 con remap `unequivocal→ambiguous` (:606-621). Coincide con CD-1..CD-S5.
- Migración (`20260713000001_wkh191b_debit_hop1.sql`) = byte-a-byte con el SQL del Story §W0.1
  (2 RPC SECURITY DEFINER, índice parcial, CHECK, down reversible).
- ABI `Debited` (abi.ts:30-40) aditivo, 4 inputs, converge con el Story §W0.2.
- `database.types.ts`: 3 columnas nullable en Row/Insert/Update + 2 funciones con `p_nonce: string`
  (CD-S1). Correcto.
- **Desviación (a) — `settleEscrowAware` exportado:** CORRECTA. Espeja a `settlePaymentIntentOnChain`
  (también exportado) y habilita el test unitario del wrapper con el seam real. Sin impacto de scope.
- **Desviación (b) — T-7 (idempotencia RPC) / T-10 (ownership) documentados, no en-vivo:** CORRECTA y
  calibrada. La parte de query-shape de T-7 SÍ es un test vivo (debit-capture.test.ts). La idempotencia
  COALESCE y el owner-guard son semántica SQL (migración) + el guard es idéntico al de
  `capture_debit_signature` ya testeado en 191a. Razonable diferirlos a integración SQL. (Ver MNR-1
  por el placeholder tautológico asociado.)

## 2. Calidad de los 30 tests nuevos — OK (1 MNR)

Verificados uno a uno; prueban lo que declaran:
- **flag-OFF byte-idéntico** (T-2, payment-intent.test.ts:1630): asserta
  `mockReadValidDebitSignature.not.toHaveBeenCalled()` **y** `mockExecuteDebitHop1.not.toHaveBeenCalled()`.
  Verifica que reader/executor NO se invocan. Correcto.
- **hop2-fail→reconciliation** (T-4 caller, :1685): asserta `db.row.settle_outcome==='failed_ambiguous'`
  **y** `db.refunds).toEqual([])`. Verifica NO-refund real vía la DB in-memory fiel. Correcto.
- **exactly-once** (T-5, :1728): `mockExecuteDebitHop1.not.toHaveBeenCalled()` + seam corre. Verifica
  skip-hop1. Correcto.
- **hop1-confirmed ANTES de hop2** (T-1, :1611): usa `invocationCallOrder` — `hop1Order < signOrder`
  (mockSign = 1er paso del seam). Verifica el orden BLQ-DR/CD-3 real, no un proxy. Correcto.
- **happy-path seller cobra** (T-1, :1625-1626): `outcome.status==='settled'` + `txHash==='0xTX'`
  (tx del hop2 = forward al seller). Correcto.
- **narrow-window R-2** (T-11, debit-executor.test.ts:210): receipt `reverted` → `not_moved:REVERTED`
  → el caller cae al seam. Cubierto.
- executor: happy `Debited` matcheado→confirmed; `DEBITED_EVENT_NOT_FOUND`→ambiguous con 3 variantes
  (sin log / otro keyId / otro contrato); confirmations pasado explícito (`confirmations:1`); timeout→
  ambiguous; revert→not_moved; write throw→not_moved sin txHash; sin PK/RPC→not_moved. Sólido, no-mentiroso.
- **Tautológico:** SÍ, uno → ver **MNR-1**.

## 3. Migración — OK

- 2 RPC `SECURITY DEFINER` con `SET search_path = public, pg_temp` (sin schema hijacking).
- `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` + `GRANT ... TO service_role` en ambos.
- Owner-guard DB-level (`SELECT owner_ref ... FOR UPDATE` + `IS DISTINCT FROM` → `OWNERSHIP_MISMATCH`;
  `INTENT_NOT_FOUND` si no existe) en ambos RPC.
- `record_debit_hop1` idempotente por `COALESCE(debit_hop1_tx_hash, p_tx_hash)` — la 1ª escritura gana,
  devuelve el hash efectivo. Correcto para exactly-once.
- `record_debit_settle_status` valida `p_status IN ('settled','reconciliation_pending')` (RAISE si no)
  — coherente con el CHECK de columna (que además admite `'hop1_confirmed'`).
- Índice parcial `idx_debit_sig_settle_status` (para 191c). `BEGIN/COMMIT` wrap. `_down` reversible
  (drop RPC + índice + 3 columnas), no destruye datos de 191a. Sin hallazgos.

## 4. Legibilidad / mantenibilidad — OK

- `debit-executor.ts`: cache lazy `Map<ChainKey,...>` (:67-118, espejo gasless/escrow-verifier),
  `Hop1Outcome` discriminado y exhaustivo, clasificación not_moved/ambiguous/confirmed clara, re-verify
  `Debited` con `decodeEventLog` y topic0 derivado del ABI (`parseAbiItem`, nunca hardcodeado).
  BigInt en todo el money-path (amount/deadline/nonce), sin `Number()`. `getEscrowReceiptTimeoutMs`
  parse `>0` con default 60_000. `_resetDebitExecutor` TEST-ONLY. Sin dead code funcional.
- El remap `unequivocal→ambiguous` está localizado y comentado (payment-intent.ts:606-621).
- Nombres consistentes con 191a/136. Comentarios explican el "por qué" money-safety, no el "qué".
- Nit no accionable: el `catch` del receipt (debit-executor.ts:191) etiqueta TODO throw como
  `RECEIPT_TIMEOUT` aunque podría ser otro error de RPC; el `kind:'ambiguous'` es correcto y money-safe,
  y el Story lo prescribe así (Exemplar 1). No es finding.

## 5. Consistencia — OK

- `debit-executor.ts` espeja `base/gasless.ts` (client cache, writeContract en try/catch=pre-broadcast,
  waitForTransactionReceipt con timeout+confirmations).
- El reader (`readValidDebitSignature`) sigue el patrón owner-guarded + cast `as unknown as ...` de 191a
  (CD-S2) y re-valida amount/deadline como espejo de `captureDebitSignature`.
- El gate compone bien con 191a: `isEscrowSettleEnabled = ESCROW_SETTLE_ENABLED==='true' &&
  isDebitCaptureEnabled()` (AND de ambos flags, CD-1).

## 6. Manejo de errores — OK

- `settleEscrowAware` envuelto en try/catch externo (:496/:625): CUALQUIER throw (reader/executor/RPC)
  → `return settlePaymentIntentOnChain(base)` + `log.warn`. Nunca rechaza (CD-S5). Verificado por T-9
  (reader lanza / executor lanza → settle normal).
- Reader `readValidDebitSignature` es no-throw (try/catch → null) — defensa en profundidad.
- Executor nunca lanza: sin PK/RPC→not_moved, write throw→not_moved, receipt throw→ambiguous.
- Edge cases (escrow no config / sin chainKey / sin PK / timeout) → todos caen al seam o a un
  `Hop1Outcome` money-safe. `settlePaymentIntentOnChain` NO se tocó (byte-idéntico, confirmado en diff).

### Nota (no-finding) — retry sobre `reconciliation_pending`
Tras un hop1 `ambiguous` el wrapper persiste el tx tentativo (Story §W3.1 lo prescribe) y marca
`reconciliation_pending`. `settleEscrowAware` decide exactly-once SOLO por presencia de
`debit_hop1_tx_hash`, sin inspeccionar `debit_settle_status`. Un hipotético retry saltaría hop1 e iría
a hop2. En 191b esto es **inalcanzable**: el intent queda terminal `failed_ambiguous` y ningún camino
(closeSession/settleUpto/expireStale) reintenta un intent terminal. La resolución de
`reconciliation_pending` es scope explícito de 191c. Documentado y money-safe → no es finding.

---

## Hallazgos

### MNR-1 — Test placeholder tautológico + cross-reference inexacta
- **Categoría:** Test Coverage / calidad de test
- **Archivo:** `src/adapters/escrow/debit-capture.test.ts:543-545` (bloque T-7)
- **Descripción:** el caso
  `it('record_debit_hop1 es idempotente por COALESCE (documentado; ver debit-executor.test.ts)', () => { expect(true).toBe(true); })`
  no asserta nada sobre el código (tautológico). Además su comentario afirma que la idempotencia "se
  ejercita a nivel wrapper en `debit-executor.test.ts` (mock del RPC)", pero `debit-executor.test.ts`
  NO contiene ningún test de `recordDebitHop1`/`recordDebitSettleStatus` — la referencia es inexacta.
- **Reproducción:** `grep -n "recordDebitHop1\|record_debit_hop1" src/adapters/escrow/debit-executor.test.ts`
  → sin coincidencias; el test T-7 pasa siempre porque `expect(true).toBe(true)`.
- **Impacto:** ninguno funcional (la idempotencia real está en el COALESCE de la migración, verificado por
  lectura). Riesgo de calidad: da falsa sensación de cobertura y apunta a un test inexistente.
- **Sugerencia:** o (a) eliminar el placeholder y dejar la idempotencia documentada como test de
  integración SQL pendiente (coherente con T-10), o (b) agregar un test real del wrapper que, con el RPC
  mockeado devolviendo el hash existente en la 2ª llamada, asserte que `recordDebitHop1` retorna el hash
  previo. Corregir/eliminar la referencia a `debit-executor.test.ts`.

---

## Resumen
| Check | Resultado |
|-------|-----------|
| 1. Fidelidad SDD/Story | OK |
| 2. Calidad de tests | OK (MNR-1) |
| 3. Migración | OK |
| 4. Legibilidad/mantenibilidad | OK |
| 5. Consistencia | OK |
| 6. Manejo de errores | OK |

**BLOQUEANTEs: 0 · MENORs: 1 (MNR-1) · tsc: 0 err · biome: 0 · suite: 2896 PASS / 0 FAIL**

**Veredicto: APROBADO con MENORs.** MNR-1 puede cerrarse en fix-pack o diferirse a backlog (no bloquea DONE).
