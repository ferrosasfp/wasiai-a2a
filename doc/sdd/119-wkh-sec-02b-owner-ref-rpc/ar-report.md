# AR Report — WKH-SEC-02b (Ownership Guard DB-level en increment_a2a_key_spend)

**Branch:** `feat/119-wkh-sec-02b-owner-ref-rpc`
**Reviewer:** nexus-adversary
**Fecha:** 2026-06-22
**Veredicto:** **APROBADO**
**Resumen:** 0 BLOQUEANTE · 2 MENOR · resto OK/N-A
**Evidencia ejecutada:** `npx vitest run src/services/budget.test.ts` → PASS (41) FAIL (0); `npx tsc --noEmit` → exit 0.

---

## Vectores de ataque obligatorios

### V1 — El guard funciona — OK
`increment_a2a_key_spend` 4-param (migración up L20-93). El guard está colocado
correctamente: DESPUÉS de `SELECT ... FOR UPDATE` + `IF NOT FOUND` (L35-42) y
ANTES del check `is_active`/debit (L47-49):
```
IF v_row.owner_ref IS DISTINCT FROM p_owner_ref THEN
  RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller', p_key_id;
END IF;
```
`RAISE EXCEPTION` en plpgsql aborta la función → rollback de la tx (la fila quedó
lockeada por FOR UPDATE pero no se hizo UPDATE). No hay débito en mismatch.

**Evasión por NULL/vacío evaluada:** `IS DISTINCT FROM` es NULL-safe — si
`p_owner_ref` es NULL y `owner_ref` no lo es → DISTINCT → RAISE (correcto, no
evade). Si ambos NULL → no DISTINCT → pasa, pero `owner_ref` es columna poblada
en prod (la usan los demás guards 125/125b), por lo que un caller no puede
hacer coincidir un NULL contra una fila real. Owner vacío `''` solo coincide si
la fila tiene `owner_ref=''` (su propia key). No hay bypass.

### V2 — Overload (BLQ-MED-1 recurrente) — OK
Migración up **L15**: `DROP FUNCTION IF EXISTS increment_a2a_key_spend(uuid, integer, numeric);`
ANTES del `CREATE` de 4-param (L20). No queda sobrecarga 3-arg sin guard. El
patrón replica el precedente de 125/125b. Hardening de la nueva firma presente
(L96-101).

### V3 — Dispatch de 125b PRESERVADO — OK (CRÍTICO, verificado)
`debit_delegation_and_parent` (up L260-318) conserva el dispatch condicional
**byte-idéntico** a 20260608 (125b) salvo el único cambio autorizado:
```
IF p_destination IS NOT NULL AND p_destination <> '' THEN
  PERFORM debit_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination);
ELSE
  PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);  -- +p_owner_ref
END IF;
```
El branch IF (debit_with_dest_policy con p_destination) está intacto. Solo el ELSE
agregó `p_owner_ref`. El bypass de 125b NO se reintroduce. Idéntico en
`debit_session_and_parent` (up L235-239).

### V4 — Los 3 RPCs pasan el p_owner_ref correcto — OK
- `debit_with_dest_policy` (up L167): pasa su propio `p_owner_ref` (ya validado
  contra `v_key_owner` en L131-133). Correcto.
- `debit_session_and_parent` (up L238): pasa `p_owner_ref` (validado contra
  `v_owner` de la sesión Y `v_key_id` contra la key en L215-220). Correcto.
- `debit_delegation_and_parent` (up L311): pasa `p_owner_ref` (validado contra
  `v_owner` de la delegación Y `v_key_id` en L288-293). Correcto.
Ningún owner cruzado: en los 3 casos el `p_owner_ref` ya fue verificado coincidente
con el owner de la entidad antes del PERFORM, y la key está bound por `v_key_id`.

### V5 — CD-5 (no tocar lógica existente) — OK
Cuerpo de increment comparado contra el original `20260406000000:56-121`. Daily
reset (L56-62), daily limit (L65-71), chain budget (L73-80), debit/UPDATE
(L82-91), KEY_NOT_FOUND (L40-42), is_active (L51-53) son **byte-idénticos** al
original. El guard es PURAMENTE aditivo (3 líneas insertadas L47-49).

### V6 — Caller #1 TS: guard tautológico — OK (documentado, no es finding)
**Confirmado: para el caller #1 (ruta master-no-dest) el guard ES un no-op.**
`budget.ts:300-308` hace `SELECT owner_ref WHERE id = keyId` y pasa ese mismo
`ownerRef` al RPC, que lo compara contra la misma fila → siempre coincide. No
agrega defensa real para esta ruta (un atacante que controla el keyId leería el
owner de esa misma key).

Esto NO es finding: el SDD lo documenta explícitamente en **DT-4 (§10, L370-407)**.
La decisión Opción (a) es deliberada — minimizar blast radius sin ampliar la firma
de `debit()` (evita reescribir a2a-key.ts:861, compose.ts, orchestrate, gasless y
30+ tests). El valor real del guard está en las rutas delegación/sesión/dest-policy
(V3/V4), donde el `p_owner_ref` proviene de una entidad distinta (delegación/sesión)
y SÍ cruza tenants. Para caller #1 es coherencia de firma + defensa-en-profundidad
contra un futuro caller que pase un owner divergente. Respeto de decisión
documentada (regla de calibración 5). Ver MNR-1 sobre la race.

### V7 — Down reversible — OK
Down (L9-278) restaura:
- increment 3-param **sin hardening** (L11-71) — correcto: el original
  `20260406` nunca lo tuvo (CD-6).
- `debit_with_dest_policy` con `PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd)` 3-arg (L132) — estado post-125.
- `debit_session_and_parent` (L149-211) y `debit_delegation_and_parent`
  (L214-278): dispatch preservado, branch ELSE con PERFORM 3-arg — **byte-idéntico**
  al estado post-125b verificado contra 20260606:159-224 y 20260608:19-85.
El down NO rompe 125b al revertir. Reversible y atómico.

### V8 — Error mapping (no leak PG) — OK
`budget.ts:319-321`: `OWNERSHIP_MISMATCH` se mapea a `{ success:false, error:'OWNERSHIP_MISMATCH' }`
sin propagar el msg crudo de PG. Consistente con la ruta dest-aware (L282-284).
Ver MNR-2 sobre el fallback genérico de esta ruta.

### V9 — Hardening (REVOKE/GRANT/search_path) — OK
Nueva firma 4-param: `SET search_path = public, pg_temp` (L96-97), `REVOKE ... FROM PUBLIC, anon, authenticated` (L98-99), `GRANT ... TO service_role` (L100-101).
Los 3 RPCs dependientes re-hardenizados (L176-181, L247-252, L320-325).

---

## Categorías AR

| # | Categoría | Resultado |
|---|-----------|-----------|
| 1 | Security | OK — guard NULL-safe, hardening completo, error sin leak |
| 2 | Error Handling | OK — RAISE→rollback; mapping estable (ver MNR-2) |
| 3 | Data Integrity | OK — FOR UPDATE serializa; guard bajo lock (ver MNR-1) |
| 4 | Performance | OK — 1 SELECT extra en ruta baja frecuencia (DT-4, aceptado) |
| 5 | Integration | OK — firma de debit() intacta; dispatch 125b preservado |
| 6 | Type Safety | OK — `Pick<A2AAgentKeyRow,'owner_ref'>`, sin `any`; tsc exit 0 |
| 7 | Test Coverage | OK — 41 pass; tests del guard + KEY_NOT_FOUND cold-path |
| 8 | Scope Drift | OK — solo los 4 archivos del Scope IN |
| 9 | Destructive Migrations | OK — DROP FUNCTION (no tabla/columna); down reversible; sin data loss |
| 10 | RPC SECURITY DEFINER | OK — search_path fijado, ownership validado, sin SQL dinámico, REVOKE de anon |
| 11 | Cache Invalidation | N/A — no introduce capa de cache |

---

## Findings MENOR

### MNR-1 — Race teórica entre SELECT cold-path y RPC (caller #1)
**Categoría:** Data Integrity · **Archivo:** `src/services/budget.ts:300-315`
**Descripción:** El SELECT de `owner_ref` (L300) y el RPC (L310) son dos round-trips
separados sin lock entre ellos. Si `owner_ref` de la key cambiara entre ambos, el
valor pasado sería stale. **Impacto: nulo en la práctica** — `owner_ref` es
inmutable post-creación de la key, y aun si cambiara, el guard del RPC compara
contra la fila lockeada (FOR UPDATE), así que un mismatch resultaría en
OWNERSHIP_MISMATCH (fail-closed, sin débito). No hay ventana de doble-débito ni
corrupción. Es deuda cosmética del patrón no-op de DT-4.
**Sugerencia:** documentar en comentario que `owner_ref` se asume inmutable; o
(fuera de scope) la Opción (c) de DT-4 que elimina el SELECT. No bloquea.

### MNR-2 — Fallback de la ruta master-no-dest propaga `error.message` crudo
**Categoría:** Error Handling · **Archivo:** `src/services/budget.ts:322`
**Descripción:** A diferencia de la ruta dest-aware (L285-291), que tiene un
fallback `DEST_POLICY_DEBIT_FAILED` y NUNCA propaga el msg de PG, la ruta
master-no-dest hace `return { success:false, error: error.message }` (L322) para
todo error que no sea OWNERSHIP_MISMATCH. Esto propaga el texto crudo de PG
(INSUFFICIENT_BUDGET, DAILY_LIMIT, etc.) al caller. **Impacto:** bajo — este
comportamiento es **preexistente** (no lo introdujo esta HU; era idéntico en
origin/main) y los mensajes no contienen secretos. Pero es inconsistente con
CD-B aplicado en la otra ruta. No rompe AC ni expone vuln → MENOR, no bloqueante.
**Sugerencia:** alinear el mapping de la ruta master-no-dest con el de dest-aware
(INSUFFICIENT_BUDGET→AGENT_KEY_BUDGET_EXHAUSTED, etc. + fallback genérico). Fuera
del scope estricto de esta HU; backlog.

---

## Veredicto final

**APROBADO con MENORs.**

Los 9 vectores obligatorios pasan. El objetivo central (guard DB-level en
increment + dispatch 125b preservado + down reversible) está implementado
correctamente y verificado con evidencia ejecutable (41 tests verde, tsc limpio).
El patrón no-op para caller #1 (V6) es una limitación conocida y documentada en
DT-4, no un defecto. Los 2 MENOR son deuda cosmética/preexistente que no bloquea
el gate.

**No hay BLOQUEANTEs.** El orquestador puede avanzar a CR/F4.
