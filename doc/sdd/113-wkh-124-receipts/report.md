# Final Report — WKH-124: Recibos inmutables + proof-chain (KEY-RECEIPTS)

> **Status**: ✅ DONE · **Fecha**: 2026-06-19 · **Branch**: `feat/113-wkh-124-receipts`
> **Épica**: E16 (Agent Key robustness vs Kite Passport) · **Modo**: QUALITY AUTO
> Veredicto F4: APROBADO PARA DONE (8/8 ACs PASS).

## 1. Resumen ejecutivo
WKH-124 agrega **recibos inmutables firmados** por cada pago exitoso, capturando el linaje verificable `session → agent_key → owner_ref` + detalles del cobro (monto, chain, tx_hash, counterparty, timestamp), encadenados con `prev_receipt_hash` (ledger-style) y firmados con HMAC-SHA256 server-side. Es el equivalente al "Proof of AI" del Kite Passport — evidencia portable para resolución de disputas y auditoría — pero **sin gas ni latencia de bloque** (anclaje on-chain diferido a WKH-124b). Endpoint `GET /receipts/:id/verify` recomputa el hash y detecta manipulación.

## 2. Pipeline (QUALITY AUTO, 2026-06-19)
HU_APPROVED y SPEC_APPROVED self-aprobados (clinical review). F2.5 → F3 (7 nuevos + 8 modificados + migración) → AR (APROBADO con MENORs) + CR (APROBADO con MENORs) → **fix-pack de tests** (cerró el MENOR de cobertura de call-sites) → F4 (APROBADO PARA DONE). Sin BLOQUEANTEs.

## 3. AC results (8/8 PASS — ver validation.md)
- AC-1 emisión protocol_fee (`orchestrate.ts`) · AC-2 emisión budget_debit en las 3 rutas (master `a2a-key.ts`, delegation + key-session `budget.ts`) · AC-3 HMAC canonical determinista + append-only · AC-4 verify match · AC-5 verify tamper→{valid:false} · AC-6 best-effort no rompe el pago · AC-7 ownership list · AC-8 disclosure-safe 404.
- Gates: tsc 0 · 1515 tests pass · lint clean.

## 4. Decisiones clave
- **DT-1**: inmutabilidad firmada server-side + tabla append-only (no on-chain en MVP).
- **DT-2 (concurrencia)**: RPC `insert_receipt` con `pg_advisory_xact_lock(hashtext(owner_ref))` serializa por owner; HMAC computado app-side (el secret **nunca va a Postgres**, CD-4); persistido con UPDATE-once `WHERE receipt_hash=''`.
- **counterparty=null** en budget_debit — NO se amplía la firma de `budgetService.debit` (CD-7, evita romper ~11 tests de aridad); el linaje se obtiene de los call-sites, no de parámetros.
- **fee-charge.ts NO tocado** (scope reducido; protocol_fee se emite desde orchestrate.ts).

## 5. Hallazgos
- 0 BLOQUEANTEs. El MENOR de cobertura de call-sites (AR-MNR-1/CR-MNR-3) fue **CERRADO por fix-pack** (tests master + key-session agregados).
- MENORs deuda: `resolveCallerKey` duplicado en receipts.ts (autorizado por Story File), `.catch(warn)` copy-paste x4, y el **chain-fork bajo concurrencia** (`prev_receipt_hash` puede capturar '' fuera del lock) → diferido a **WKH-124b** junto con el anclaje on-chain.
- La corrección del Dev (`request.scopingKeyRow` en vez de `request.a2aKeyRow` inexistente en OrchestrateRequest) fue validada como limpia por AR y CR.

## 6. Archivos
**Nuevos**: `src/types/receipt.ts`, `src/services/receipt.ts` (+test), `src/routes/receipts.ts` (+test), `supabase/migrations/20260605000000_a2a_receipts.sql` (+down). **Modificados**: `src/services/budget.ts`, `src/middleware/a2a-key.ts`, `src/services/orchestrate.ts`, `src/index.ts`, `.env.example`, tests de integración (budget/orchestrate/a2a-key).

## 7. Deploy
- Migración `20260605000000_a2a_receipts.sql` **aplicada a prod** (<supabase-prod-ref>): tabla `a2a_receipts` + RPC `insert_receipt/10` + índice `(owner_ref, created_at DESC)`. HTTP 201.
- Env var operativa: setear `RECEIPT_SIGNING_SECRET` en Railway para activar la emisión/verificación (sin ella → skip best-effort, no rompe nada).

## 8. Spinoffs
- **WKH-124b**: anclaje on-chain (Merkle root periódico) + fix del chain-fork bajo concurrencia + endpoint `GET /receipts/:id/chain` (verificación de cadena completa).
- E16 sigue con **WKH-125** (constraints programables).
- Deuda menor de refactor (resolveCallerKey export, best-effort helper).

## 9. Lección
Cuando el diseño emite efectos secundarios (recibos) desde los **call-sites que ya tienen el linaje** en vez de ampliar la firma de una función central (`debit`), se evita el bug recurrente de aridad de mocks y se mantiene la integración estrictamente aditiva. El SQL/RPC prescrito textual en el Story File aceleró F3.
