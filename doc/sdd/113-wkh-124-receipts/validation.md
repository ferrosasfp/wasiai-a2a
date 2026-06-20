# Validation Report — WKH-124 KEY-RECEIPTS (F4 QA)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-06-19
**Agente**: nexus-qa

---

## Runtime / Migration Checks

### Migration source (no se aplica — lo hace el orquestador)
- `20260605000000_a2a_receipts.sql` existe: archivo verificado, 87 líneas.
- `20260605000000_a2a_receipts_down.sql` existe: `DROP FUNCTION IF EXISTS insert_receipt(...)` + `DROP TABLE IF EXISTS a2a_receipts` — coincide exactamente con la up-migration.
- Orden de timestamp correcto: `20260604000000` (WKH-123) → `20260605000000` (WKH-124). Verificado con `ls supabase/migrations/`.
- La migración es estrictamente aditiva: crea una tabla nueva + índice + función RPC. Cero `DROP`/`ALTER` sobre tablas existentes.
- Tabla `a2a_receipts`: `owner_ref TEXT NOT NULL`, `receipt_hash TEXT NOT NULL DEFAULT ''`, `CHECK (receipt_type IN ('protocol_fee','budget_debit'))`, índice `(owner_ref, created_at DESC)` — coincide exactamente con el SDD §4.2 + Story File SQL textual.
- RPC hardening completo: `SET search_path = public, pg_temp` + `REVOKE EXECUTE FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE TO service_role` (migration:81-86) — CD-C OK.
- Advisory lock `pg_advisory_xact_lock(hashtext(p_owner_ref))` presente (migration:52). RPC sin SQL dinámico.
- **Migración NOT applied to remote** (no se puede verificar sin acceso a Supabase remoto) → NO VERIFICABLE en runtime; aplica el orquestador/ops.

### Env var parity
- `RECEIPT_SIGNING_SECRET` documentada en `.env.example:431` (sin valor, correcto: CD-4).
- Código la lee en `receipt.ts:78` como `process.env.RECEIPT_SIGNING_SECRET` (no hardcodeada). Match correcto.

### fee-charge.ts NOT touched (CD-6)
- `git diff main...HEAD -- src/services/fee-charge.ts` → sin output (cero cambios). Confirmado.

---

## ACs — Verificación con evidencia

| AC | Texto (EARS) | Status | Evidencia |
|----|-------------|--------|-----------|
| AC-1 | WHEN `chargeProtocolFee` retorna `{status:'charged', txHash}`, THEN emit receipt `protocol_fee` | PASS | `orchestrate.ts:456-479` call-site; `orchestrate.test.ts:730-763` (T-25) asserta `receiptType:'protocol_fee'`, `ownerRef:'owner-1'`, `counterparty:'0xFEEWALLET'`, `txHash:'0xFEE'` |
| AC-2 | WHEN `budgetService.debit` retorna `{success:true}` en las 3 rutas (master/delegation/key-session), THEN emit `budget_debit` best-effort | PASS | **master**: `a2a-key.ts:821-839` + `a2a-key.test.ts:1450-1476` (asserta `ownerRef:'user-1'`, `receiptType:'budget_debit'`, `sessionId:null`); **delegation**: `budget.ts:163-181` + `budget.test.ts:277-295` (asserta `delegationId:'del-1'`); **key-session**: `budget.ts:91-109` + `budget.test.ts:314-329` (asserta `sessionId:'sess-1'`) |
| AC-3 | WHEN se crea un recibo, THEN `receipt_hash = HMAC-SHA256(secret, canonical)` con canonical determinista + append-only | PASS | `receipt.ts:53-81`; `receipt.test.ts:77-88` (hex 64-char determinista); `receipt.test.ts:93-151` (orden alfabético, `toFixed(8)`, ISO, `null` literal); `receipt.test.ts:301-343` (UPDATE-once `.eq('receipt_hash','')`) |
| AC-4 | WHEN `GET /receipts/:id/verify` con owner match, THEN recomputa hash y retorna `{valid:true, computed_hash, stored_hash}` | PASS | `receipt.ts:195-243`; `receipt.test.ts:171-181` (round-trip match); `receipts.test.ts:140-158` (HTTP 200 `valid:true`, `mockVerify` called con `('rcpt-1','user-1')`) |
| AC-5 | IF mismatch detectado, THEN retorna `{valid:false, tamper_detected:true}` con HTTP 200 | PASS | `receipt.ts:243`; `receipt.test.ts:184-199` (amount_usd alterado → `tamper_detected:true`); `receipts.test.ts:162-180` (HTTP 200, `valid:false`, `tamper_detected:true`) |
| AC-6 | IF emisión falla, THEN log WARN + retornar resultado original sin cambios | PASS | `receipt.ts:110-118` (guards) + `receipt.ts:182-187` (catch final); `receipt.test.ts:210-232` (secret unset → no insert, warn); `receipt.test.ts:253-274` (RPC reject → resolves undefined); `orchestrate.test.ts:766-788` (T-26: emit reject → orchestrate OK); `a2a-key.test.ts:1478-1493` (emit reject → req 200); `budget.test.ts:298-308` + `332-345` (emit reject → `{success:true}`) |
| AC-7 | WHEN `GET /receipts` llamado, THEN retorna SOLO recibos del caller (`.eq('owner_ref', callerOwnerRef)` OBLIGATORIO) | PASS | `receipt.ts:256` `.eq('owner_ref', ownerRef)`; `receipt.test.ts:348-358` (mock chain verifica `eq('owner_ref','owner-A')`); `receipts.test.ts:117-130` (HTTP 200, `mockList` called con `'user-1'`) |
| AC-8 | WHEN `owner_ref` del recibo NO coincide con el del caller, THEN retorna 404 disclosure-safe | PASS | `receipt.ts:267-282` (`getById` con `.eq('owner_ref')`, `PGRST116 → null`); `receipts.ts:82-84,110-112` (null → 404 `RECEIPT_NOT_FOUND`); `receipts.test.ts:183-195` (cross-owner `/:id` → 404); `receipts.test.ts:197-209` (cross-owner `/:id/verify` → 404, `mockVerify` NOT called) |

---

## Drift Detection

**Scope**: los archivos modificados/creados en working-tree son exactamente los esperados por el Story File §Files to Modify/Create:
- Nuevos: `src/types/receipt.ts`, `src/services/receipt.ts`, `src/services/receipt.test.ts`, `src/routes/receipts.ts`, `src/routes/receipts.test.ts`, `supabase/migrations/20260605000000_a2a_receipts.sql`, `supabase/migrations/20260605000000_a2a_receipts_down.sql`. Total: 7 nuevos.
- Modificados: `src/services/budget.ts`, `src/middleware/a2a-key.ts`, `src/services/orchestrate.ts`, `src/index.ts`, `.env.example`. Más tests de call-sites: `src/middleware/a2a-key.test.ts`, `src/services/budget.test.ts`, `src/services/orchestrate.test.ts`. Total: 8 modificados.
- `src/services/fee-charge.ts` NO tocado (confirmado con `git diff`). CD-6 OK.
- `doc/jury-qa*.md` untracked: son docs pre-existentes (sin relación con WKH-124, no modificados por este branch).
- **Spec drift**: ninguno. `fee-charge.ts` intencionalmente excluido per SDD §11 + Story File nota de scope. El call-site del `protocol_fee` en `orchestrate.ts` usa `request.scopingKeyRow` (corrección documentada en auto-blindaje).
- **Wave drift**: W0 (tipos/migration) → W1 (service) → W2 (integraciones) → W3 (router) → W4 (tests) respetado (confirmado por estructura de imports).

**Drift**: none (todo dentro de scope).

---

## Quality Gates

- **tsc --noEmit**: EXIT 0 — verificado en sesión (salida: "TypeScript compilation completed", 0 errores).
- **npm test**: 1515 passed | 3 skipped — EXIT 0. Superó la baseline esperada de ~1511 (fix-pack agregó tests de master + key-session).
- **npm run lint** (biome): "No fixes applied. Found 1 info" — el único info es en `reputation.ts:116` (pre-existente, no relacionado con WKH-124). EXIT 0.

---

## AR/CR Follow-up

**BLOQUEANTEs**: 0 (AR y CR aprobados sin bloqueantes).

**MNRs documentados como deuda técnica (no bloquean DONE)**:

| MNR | Descripción | Estado |
|-----|-------------|--------|
| MNR-1 (CR) / MNR (AR) | `resolveCallerKey` duplicado en `receipts.ts:22-48` (copia de `auth.ts:113-142`, Story File lo autorizó) | Deuda latente → WKH futura: exportar desde módulo compartido |
| MNR-2 (CR) | Bloque `.catch(warn)` copy-paste en 4 call-sites (`budget.ts:104-108`,`:176-180`; `a2a-key.ts:834-838`; `orchestrate.ts:473-477`) | Aceptable: patrón establecido por `event.ts`; refactorizar a `emitReceiptBestEffort` helper si se desea |
| MNR-3 (CR) / MNR-1 (AR) | Falta de assertions en call-sites master+key-session | **CERRADO por fix-pack**: `a2a-key.test.ts:1450-1476` cubre master; `budget.test.ts:314-329` cubre key-session. Evidencia: `npm test` 1515 pass |
| MNR-2 (AR) | `prev_receipt_hash` puede capturar `''` bajo emisiones concurrentes del mismo owner (ventana INSERT→UPDATE-once) | Previsto en SDD DT-2 como riesgo known; `verify` lo reporta `{valid:false,reason:'UNSIGNED'}`. Diferido a WKH-124b |

---

## Verificaciones adicionales de código

- **Secret nunca a Postgres**: `receipt.ts:122-136` — RPC recibe 10 parámetros (owner_ref, agent_key_id, session_id, delegation_id, receipt_type, amount_usd, chain_id, tx_hash, counterparty, orchestration_id). El `RECEIPT_SIGNING_SECRET` no figura. Confirmado.
- **Append-only**: únicas operaciones sobre `a2a_receipts` desde `receipt.ts`: `supabase.rpc('insert_receipt')` (INSERT delegado), `.select()` x2 (list + getById), y `.update({receipt_hash}).eq('id',...).eq('receipt_hash','')` (UPDATE-once, líneas 174-178). Cero `.delete()`. CD-2 OK.
- **Ownership Guard en todas las lecturas**: `list` L256 `.eq('owner_ref', ownerRef)`, `getById` L274 `.eq('owner_ref', ownerRef)`. `verify` delega a `getById` (L196). Firmas: `ownerRef: string` (no `string | undefined`). CD-3 OK.
- **Router registrado**: `src/index.ts:27` `import receiptsRoutes` + `index.ts:124-125` `register(receiptsRoutes, {prefix:'/receipts'})`. OK.
- **TS strict**: 0 errores de tsc. Sin `any` explícito en archivos nuevos. `amount_usd: string` en `ReceiptRow`. CD-5 OK.
- **CD-6 (aditivo)**: `a2a_events`, `a2a_protocol_fees`, `chargeProtocolFee` firma, `budgetService.debit` firma — todos intactos. Verificado con grep + git diff.

---

**Listo para DONE.**

*Validación generada por nexus-qa — WKH-124 — 2026-06-19*
