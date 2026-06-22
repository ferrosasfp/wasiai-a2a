# Final Report — WKH-SEC-02b: Ownership Guard DB-level en `increment_a2a_key_spend`

> **Status**: ✅ DONE · **Fecha**: 2026-06-22 · **Branch**: `feat/119-wkh-sec-02b-owner-ref-rpc` · **Modo**: QUALITY AUTO
> Veredicto F4: APROBADO PARA DONE (6/6 ACs PASS). **Migración lista para aplicar a prod.**

## 1. Resumen ejecutivo

WKH-SEC-02b agrega un Ownership Guard Postgres-level dentro de `increment_a2a_key_spend`, el RPC fundacional de todo débito de budget. La función pasa de 3 a 4 parámetros (nuevo `p_owner_ref TEXT`): si el owner_ref pasado no coincide con el registrado en `a2a_agent_keys`, lanza `OWNERSHIP_MISMATCH` y hace ROLLBACK. Es **defensa en profundidad**, no un fix de vulnerabilidad activa (la RPC ya está REVOCADA de anon/authenticated desde WKH-SEC-02). Spinoff de `doc/sdd/116-wkh-sec-02-rls/report.md` §8.

## 2. Pipeline (QUALITY AUTO, 2026-06-22)

HU_APPROVED + SPEC_APPROVED self-aprobados → F2.5 → F3 (waves W0 SQL → W1 budget.ts → W2 tests) → AR (APROBADO, 0 BLQ, 2 MNR cosméticos) + CR (APROBADO, 0 BLQ, 2 MNR cosméticos) → F4 (APROBADO PARA DONE, 6/6 ACs PASS).

## 3. AC results (6/6 PASS — ver validation.md)

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 guard OWNERSHIP_MISMATCH + rollback | ✅ PASS | `20260609000000_..._rpc.sql:47-49` (guard entre IF NOT FOUND y is_active) + `budget.test.ts:511-521` |
| AC-2 caller TS pasa p_owner_ref | ✅ PASS | `budget.ts:300-315` (SELECT cold-path) + `budget.test.ts:496-509` + KEY_NOT_FOUND `:523-530` |
| AC-3 los 3 PERFORM pasan p_owner_ref | ✅ PASS | inspección SQL `:167`, `:238`, `:311`; dispatch 125b preservado |
| AC-4 down reversible | ✅ PASS | `..._rpc_down.sql:9` DROP 4-param → CREATE 3-param + 3 RPCs a PERFORM 3-arg |
| AC-5 cero regresión | ✅ PASS | vitest 1625/0, tsc 0, biome 0 |
| AC-6 error mapping sin leak | ✅ PASS | `budget.ts:317-321` |

## 4. Decisiones clave

- **DT-1 = Opción A** (DROP + recrear atómico) en vez de wrapper → patrón BLQ-MED-1 probado en WKH-125/125b; Opción B dejaba una función sin guard coexistiendo.
- **DT-4 = Opción (a)** SELECT cold-path en la ruta master-no-dest → blast radius CERO (firma de `debit()` intacta; ningún cambio en compose/orchestrate/a2a-key ni 30+ tests). Único caller que llega a la ruta master-no-dest = `a2a-key.ts:861`.
- **Dispatch de 125b preservado byte-a-byte** en `debit_delegation_and_parent`: solo el branch ELSE agregó `p_owner_ref`; el branch `IF p_destination → debit_with_dest_policy` quedó intacto (no reintroduce el bypass de 125b).

## 5. Archivos

**Nuevos**: `supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc.sql` (up) + `..._down.sql` (down reversible).
**Modificados**: `src/services/budget.ts` (caller #1: SELECT cold-path + p_owner_ref + mapeo), `src/services/budget.test.ts` (3 aserciones de aridad arregladas + 3 tests nuevos).

## 6. Gates

tsc 0 · biome 0 · vitest 1625 passed / 4 skipped / 0 failed.

## 7. Deploy a Producción

**Aplicar**: `20260609000000_wkh_sec02b_owner_ref_rpc.sql` vía Supabase Management API a `caldzjhjgctpgodldqav`. DDL sub-ms, hot-apply seguro (RPC revocada de anon/authenticated). **Prerequisito**: la firma post-125b de `debit_delegation_and_parent` (6-param) debe estar aplicada en prod ANTES (esta migración la recrea desde esa base). **Rollback**: `..._down.sql`.

## 8. Nota de diseño (guard semi-tautológico para el caller #1)

Para el caller #1 (budget.ts ruta master), el owner_ref se obtiene por SELECT de la misma key y se compara contra esa misma key → guard semi-tautológico (solo falla en ventana TOCTOU ~imposible). El **valor real** del guard está en (a) los 3 PERFORM internos donde `p_owner_ref` proviene de la entidad padre (delegation/session) y cruza tenants, y (b) futuros callers directos del RPC.

## 9. Deuda técnica (MNR cosméticos, no bloquean)

- TD-1: comentarios omitidos en el `increment` 3-param del down (SQL ejecutable byte-idéntico).
- TD-2: `mockOwnerSelect` declarado después de su primer uso en budget.test.ts (funciona por hoisting).
- TD-3: la ruta master-no-dest propaga `error.message` crudo de PG en el fallback (preexistente, no introducido por esta HU).

## 10. Lección

Agregar un guard a una RPC fundacional con múltiples callers exige: DROP-antes-de-CREATE (overload), preservar byte-a-byte la lógica y los dispatch de HUs previas (125b), y elegir la opción de menor blast radius para los call-sites (SELECT cold-path sobre ampliar firma).
