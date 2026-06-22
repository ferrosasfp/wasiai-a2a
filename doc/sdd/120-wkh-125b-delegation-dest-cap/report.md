# Final Report — WKH-125b: Cap de gasto por destino en delegaciones EIP-712

> **Status**: ✅ DONE · **Fecha**: 2026-06-22 · **Branch**: `fix/120-wkh-125b-delegation-dest-cap` · **Modo**: QUALITY AUTO
> Veredicto F4: APROBADO PARA DONE (5/5 ACs PASS). **Migración lista para aplicar a prod.**

## 1. Resumen ejecutivo

WKH-125b cierra un **bypass de seguridad real** en producción: las delegaciones EIP-712 podían evadir el cap de gasto por destino (`a2a_key_spend_policies`) que sí aplicaba a master keys y session keys. La ruta `debit_delegation_and_parent` se ejecutaba sin evaluar `a2a_key_spend_policies`, quedando un vector de bypass simétrico al que se cerró en d076ea8 para session keys. Esta HU implementa el fix idéntico: pasar el `destination` a través de los 2 call-sites (`budget.ts:161` + `a2a-key.ts:384`), actualizar la RPC con un nuevo parámetro `p_destination` con dispatch condicional a `debit_with_dest_policy`, aplicar hardening Postgres idéntico al de `debit_session_and_parent`, y verificar atomicidad en tests unitarios + e2e gateado.

**Resultado**: bypass cerrado en AMBOS call-sites, back-compat preservada byte-idéntica en la rama `ELSE`, veredicto AR+CR+F4 100% APROBADO (0 bloqueantes).

## 2. Pipeline (QUALITY AUTO, 2026-06-22)

HU_APPROVED + SPEC_APPROVED self-aprobados → F2.5 (story-HU-125b) → F3 (8 tests nuevos; 145 PASS en suites de la HU) → AR (APROBADO, 0 BLQ) + CR (APROBADO con 1 MNR cosmético) → F4 (APROBADO PARA DONE, 5/5 ACs PASS).

## 3. AC results (5/5 PASS)

| AC | Criterio | Status | Evidencia |
|----|----------|--------|-----------|
| **AC-1** | Débito vía delegación a destino con política + acumulado > cap → DEST_CAP_EXCEEDED (402) | ✅ PASS | `delegation.test.ts:448-462`; `budget.test.ts:280-288` success:false; `a2a-key.test.ts:1536-1549` HTTP 402 |
| **AC-2** | Delegación sin política → comportamiento byte-idéntico | ✅ PASS | `delegation.test.ts:302-310` (p_destination:null); `a2a-key.test.ts:1580-1612` (5 args); `budget.test.ts:266-273` |
| **AC-3** | Política rolling window_secs=N vía delegación → acumulado solo en ventana | ✅ PASS | `delegation.test.ts:432-446` forwarding p_destination; cálculo en debit_with_dest_policy (WKH-125) |
| **AC-4** | Cap por destino vía delegación → check + debit + UPDATE + INSERT en misma tx (atómico) | ✅ PASS | `delegation-atomicity.real.test.ts:152-228` ROLLBACK: parent + total_spent + ledger sin cambio |
| **AC-5** | Cap excedido vía delegación → 402 + error_code DEST_CAP_EXCEEDED, sin PG crudo | ✅ PASS | `delegation.test.ts:465-486` no leak; `errors.ts:317-323` mensaje limpio; `a2a-key.ts:404-408` 402 |

## 4. Archivos

**Nuevos (2 migraciones)**: `supabase/migrations/20260608000000_wkh125b_delegation_dest_cap.sql` (UP) + `..._down.sql` (DOWN, reversible a 5-param).

**Modificados (3 servicios TS)**: `src/services/delegation.ts` (destination, forwarding, mapeo error), `src/services/budget.ts` (forwarding, mapeo DestCapExceededError), `src/middleware/a2a-key.ts` (forwarding condicional, HTTP 402).

**Tests (8 cases nuevos)**: `delegation.test.ts` (+5), `budget.test.ts` (+2), `a2a-key.test.ts` (+6), `__tests__/e2e/delegation-atomicity.real.test.ts` (+1 gateado).

## 5. Decisiones técnicas clave

- **DT-1**: Dispatch condicional idéntico a `debit_session_and_parent` (WKH-125 W3.4), reusa `debit_with_dest_policy` sin duplicación.
- **DT-2**: `DROP FUNCTION IF EXISTS debit_delegation_and_parent(...5-param...)` antes del CREATE de 6 params (evita sobrecarga BLQ-MED-1).
- **DT-3**: `p_destination DEFAULT NULL` preserva back-compat total en rama ELSE.
- **DT-4**: Atomicidad en RPC, no splitido en app-layer.
- **DT-5**: `delegationContext.ownerRef` ya disponible, sin SELECT adicional.

## 6. Gates

tsc 0 · biome scoped 0 · lint global 1 pre-existente ajeno (reputation.ts:116) · vitest 1622 PASS / 0 FAIL (incluye 8 tests nuevos).

## 7. Hallazgos

**0 BLOQUEANTEs.** Bypass cerrado simétrico a session keys, ambos call-sites cubiertos, atomicidad verificada.
**1 MENOR (MNR-1)**: comment drift en el RPC (anotaciones `(CD-N/AC-N)` inline perdidas). Lógica ejecutable byte-idéntica. Deuda cosmética.

## 8. Deploy a Producción

**Aplicar**: `20260608000000_wkh125b_delegation_dest_cap.sql` vía Supabase Management API a `caldzjhjgctpgodldqav`.
**Prerequisitos**: `debit_with_dest_policy` existe (WKH-125 DONE); firma target DOWN `debit_delegation_and_parent(uuid,text,uuid,integer,numeric)` coincide con prod.
**Rollback**: `_down.sql` en <30s (revierte a 5-param; service_role nunca pasó 6º arg antes del deploy → sin breaking change).

## 9. Lección de cierre

Aplicar un fix de bypass requiere auditar TODOS los call-sites (acá hubo 2: per-step y step-0). Reutilizar lógica vía dispatch condicional en el RPC (no duplicación) mantiene atomicidad. El patrón DROP-antes-de-CREATE es obligatorio al cambiar firma de RPC con múltiples callers (lección BLQ-MED-1 de WKH-125, aplicada sin fallo).
