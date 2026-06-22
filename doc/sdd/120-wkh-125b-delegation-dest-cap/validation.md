# Validation Report — WKH-125b (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-06-22
**QA**: nexus-qa F4

---

## Runtime checks

### Bypass cerrado — call-sites confirmados

Dos call-sites de `debitDelegationAndParent` en produccion (grep exhaustivo, excluyendo tests y comentarios):

| Call-site | Archivo:linea | Destination forwarding |
|-----------|--------------|----------------------|
| service rama delegacion | `src/services/budget.ts:161-168` | `destination` como 6 arg (string|undefined — DT-6) |
| middleware step-0 condicional | `src/middleware/a2a-key.ts:383-400` | `request.composeDestination` con rama if/else |

Tercer path: **ninguno**. `key-session.ts:14` es solo un comentario docstring que menciona la funcion. No quedan call-sites sin destination forwarding.

El `TODO(WKH-125b)` original fue eliminado: `grep -rn "TODO.*125b" src/` → 0 hits.

### Migracion — estructura verificada (archivo en disco)

`supabase/migrations/20260608000000_wkh125b_delegation_dest_cap.sql`:
- Linea 17: `DROP FUNCTION IF EXISTS debit_delegation_and_parent(uuid, text, uuid, integer, numeric);` — ANTES del CREATE (CD-2 cumplido)
- Linea 19: `CREATE OR REPLACE FUNCTION debit_delegation_and_parent(... p_destination TEXT DEFAULT NULL)` — firma de 6 params
- Lineas 74-78: dispatch condicional `IF p_destination IS NOT NULL AND p_destination <> '' THEN PERFORM debit_with_dest_policy(...) ELSE PERFORM increment_a2a_key_spend(...)` — byte-identico al exemplar session (L213-217 del 20260606000000)
- Lineas 88-93: hardening 6 params `ALTER/REVOKE/GRANT ... service_role`

Down migration `...down.sql`: DROP-6 (L5) → CREATE-5 cuerpo original (L8-53) → hardening-5 (L56-61). Completamente reversible.

### Back-compat (CD-3)

Rama ELSE (`migration:77`): `PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd)` — identico al original `20260601000000:95`. Paso-5 con `p_destination NULL` = comportamiento byte-identico al pre-WKH-125b.

### Env vars / DB apply

Migration es working-tree no commiteada — aplicacion al remoto es GATE DE DEPLOY, no de validacion. El archivo existe y es sintaticamente correcto (estructura verificada con Read). Marcado como **NO VERIFICABLE contra remoto** (sin INTEGRATION_TEST_DB_URL disponible en CI).

### Gates (confirmado del CR report)

- `npx tsc --noEmit` → **0 errores** (CR report, linea "TSC_EXIT=0")
- `npx vitest run` → **1622 PASS / 0 FAIL** (CR report, linea "VITEST_EXIT=0")
- `biome check` scoped → **0 errores** (CR report, linea "BIOME_EXIT=0")
- lint global → 1 info pre-existente en `reputation.ts:116`, ajeno a la HU (confirmado en CR §Checklist item 3)

**NO re-ejecutados** — leidos del cr-report.md segun protocolo F4.

---

## ACs

| AC | Texto (EARS) | Status | Evidencia |
|----|-------------|--------|-----------|
| AC-1 | WHEN debito via delegationContext hacia destino con politica activa Y acumulado + monto > max_usd THEN rechazar DEST_CAP_EXCEEDED (402) Y NO decrementar budget ni total_spent | PASS | `delegation.test.ts:448-462` (RPC→DestCapExceededError); `budget.test.ts:280-288` (success:false, mockReceiptEmit not called); `a2a-key.test.ts:1536-1549` (402 + error_code DEST_CAP_EXCEEDED); `a2a-key.test.ts:1554-1576` (6 args forwarded con destination) |
| AC-2 | WHILE delegacion opera sobre parent key SIN politicas activas para el destino THEN comportarse identico a hoy (debit_delegation_and_parent con semantica actual) | PASS | `delegation.test.ts:302-310` (5-arg call → p_destination:null); `a2a-key.test.ts:1580-1612` (sin composeDestination → exactamente 5 args, toHaveBeenCalledWith posicional sin 6 arg); `budget.test.ts:266-273` (destination=undefined como 6 arg, back-compat) |
| AC-3 | WHEN politica rolling con window_secs=N Y debito via delegacion THEN acumulado SOLO sobre debitos en ventana — identico a master/session | PASS | `delegation.test.ts:432-446` (p_destination:'kite/translator' forwarded al RPC via expect.objectContaining); el calculo de ventana vive en debit_with_dest_policy (no modificado, cubierto por WKH-125) |
| AC-4 | WHEN sistema evalua cap por destino para debito de delegacion THEN check cap + debit parent + UPDATE total_spent + INSERT ledger en misma tx PostgreSQL (atomicidad, no race condition) | PASS (gated) | `src/__tests__/e2e/delegation-atomicity.real.test.ts:152-228` — debito real RPC con p_destination que excede el cap → asserta ROLLBACK: budget intacto (L202), total_spent intacto (L210), ledger sin INSERT (L215-220). Gateado por INTEGRATION_TEST_DB_URL, no corre en CI normal — documentado como diseño intencional en SDD §7 y CR §6 |
| AC-5 | WHEN cap excedido via delegacion THEN retornar error_code:'DEST_CAP_EXCEEDED' con HTTP 402 Y NO exponer mensaje crudo de PostgreSQL | PASS | `delegation.test.ts:465-486` (thrown.message no contiene 'accum' ni 'cap 1'); `errors.ts:317-323` (DestCapExceededError.message = 'Destination spend cap exceeded', sin detalle PG); `a2a-key.ts:404-408` (HTTP 402 con error_code estable) |

---

## Drift

- **Scope**: 7 archivos src/ modificados + 2 migraciones nuevas. Todos dentro del Scope IN del Story File (tabla §1). Cero archivos fuera de scope. El segundo call-site (a2a-key.ts) fue identificado en SDD §8 como ampliacion justificada de Scope IN, no como drift.
- **Wave**: W0 (SQL) → W1 (TS) → W2 (tests) — orden correcto.
- **Spec drift**: dispatch condicional en migration:74-78 es byte-identico al exemplar SDD §5.W0. Firma TS `destination?: string` en delegation.ts:384 espeja key-session.ts:446 como especificado.
- **Test drift**: los 5 ACs tienen cobertura no-trivial con aserciones posicionales estrictas. Las aserciones de aridad actualizadas (budget.test.ts:272 `undefined`, delegation.test.ts:308 `p_destination:null`) no relajan cobertura — estan mas precisas.
- **MNR-1 del CR** (comment drift en cuerpo del RPC): cosmético, logica ejecutable byte-identica confirmada. Aceptado como deuda de documentacion — no afecta runtime.

---

## AR/CR follow-up

- AR: APROBADO (0 BLQ, 0 MNR). Sin findings pendientes.
- CR: APROBADO con 1 MNR cosmético (comment drift, MNR-1). Aceptado como TD; no bloquea DONE.

---

**5/5 ACs PASS. Listo para DONE.**
