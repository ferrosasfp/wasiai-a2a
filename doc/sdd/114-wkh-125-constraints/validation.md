# Validation Report — WKH-125 KEY-CONSTRAINTS (DENSE)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-06-19
**QA**: nexus-qa | Branch: feat/114-wkh-125-constraints (working tree, pre-commit)
**Suite**: 1554 passed | 3 skipped (1557 total) — run local 21:16:49

---

## Runtime Checks

### RC-1: Migración — verificación de archivo (sin aplicar al remoto — NO APLICAR en F4)

La migración `20260606000000_a2a_key_spend_policies.sql` existe en disco:
`supabase/migrations/20260606000000_a2a_key_spend_policies.sql` — 10.3K
`supabase/migrations/20260606000000_a2a_key_spend_policies_down.sql` — 2.5K

Verificación de contenido crítico:

| Check | Evidencia | Resultado |
|-------|-----------|-----------|
| Tabla `a2a_key_spend_policies` con `CREATE TABLE IF NOT EXISTS` | migration:10-21 | OK |
| Tabla `a2a_key_dest_spend_ledger` | migration:36-43 | OK |
| Índice `(key_id, destination, debited_at)` | migration:46-47 | OK |
| RPC `debit_with_dest_policy` — 5 params | migration:55-131 | OK |
| Hardening: `SET search_path = public, pg_temp` | migration:135 | OK |
| `REVOKE EXECUTE FROM PUBLIC, anon, authenticated` | migration:136-137 | OK |
| `GRANT EXECUTE TO service_role` | migration:138-139 | OK |
| **BLQ-MED-1 fix**: `DROP FUNCTION IF EXISTS debit_session_and_parent(uuid, text, uuid, integer, numeric)` en L157 **ANTES** del CREATE de 6 params en L159 | migration:157 | OK |
| `CREATE OR REPLACE FUNCTION debit_session_and_parent` — 6 params con `p_destination TEXT DEFAULT NULL` | migration:159-232 | OK |
| Hardening 6-param `debit_session_and_parent` | migration:227-232 | OK |
| Down-migration restaura 5-param + dropea RPC nuevo + 2 tablas | _down.sql:6,63-65 | OK |

**Estado de la migración remota**: NO VERIFICABLE desde QA (no tenemos acceso a `supabase_migrations.schema_migrations` del remoto sin credenciales). El orquestador aplica la migración antes de DONE. El archivo SQL está estructuralmente correcto.

### RC-2: Env vars

No se agregan env vars nuevas en WKH-125. Las existentes (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`) son usadas por el cliente Supabase existente sin cambio. OK — no aplica verificación nueva.

### RC-3: BLQ-ALTO-1 (cap bypass) — verificación de la corrección en código

**Evidencia de la corrección**:

- `src/services/agent-price.ts:83-93`: `resolveAgentDestination(slug, registry?)` resuelve vía `discoveryService.getAgent(slug, registry)` + fallback `getAgent(slug)` — MISMOS args que `compose.resolveAgent` (`compose.ts:345-346`). Devuelve `{registry, slug}` del agente canónico.
- `src/routes/compose.ts:92-98`: `resolveComposePriceHandler` llama `resolveAgentDestination(firstStep.agent, firstStep.registry)` y con el resultado canónico llama `deriveComposeDestination(resolved)` → `normalizeDestination(${resolved.registry}/${resolved.slug})`. Asigna a `request.composeDestination` en L114 y L121.
- `src/routes/compose.ts:29-38`: `deriveComposeDestination` toma el objeto `{registry, slug}` del agente resuelto, **NO** del body crudo. Defensivo: si normalización falla, devuelve `undefined` (back-compat).
- `src/services/compose.ts:166`: per-step usa `normalizeDestination(${agent.registry}/${agent.slug})` donde `agent` viene de `resolveAgent` (discovery canónico) — mismo normalizador.
- Test T-ROUTE-PRICE-DEST-1 (`compose.test.ts:298-321`): body omite `registry`, discovery resuelve `"wasiai/myagent"`, el test aserta `capturedComposeDestination === 'wasiai/myagent'` (NO `'myagent'`). PASS en la suite verde.

**Bypass cerrado**: el destino del step-0 ahora siempre refleja el registry canónico del agente resuelto.

### RC-4: Back-compat del path sin destino

`src/middleware/a2a-key.ts:795-804`: llamada condicional — si `request.composeDestination` es falsy → `await budgetService.debit(keyRow.id, chainId, estimatedCostUsd)` (3 args, INTACTO). Las 93 aserciones de 3-arg en `a2a-key.test.ts` y `gasless.test.ts` verdes (confirmado en suite 1554 passed).

---

## AC Verification

| AC | Texto (EARS) | Status | Evidencia |
|----|-------------|--------|-----------|
| AC-1 | PUT /auth/keys/me/spend-policies persiste en a2a_key_spend_policies filtrado por owner_ref, retorna 200 con la política | PASS | `auth.spend-policies.test.ts:122-145` — PUT 200 con POLICY; aserta `callerKey.owner_ref='user-1'`, `callerKey.id='key-1'`; upsert con `onConflict='key_id,destination'`. `spend-policy.test.ts:117-150` — `upsertRow.owner_ref='user-1'`, `upsertRow.key_id='key-1'`. Suite verde. |
| AC-2 | Debit con política activa Y acumulado+monto > max_usd → rechaza DEST_CAP_EXCEEDED (HTTP 402), NO decrementa budget | PASS | `budget.test.ts:525-542` — prefijo `DEST_CAP_EXCEEDED` en error RPC → `{success:false, error:'DEST_CAP_EXCEEDED'}`, budget intacto (rollback en RPC). `a2a-key.ts:808-813` — `DEST_CAP_EXCEEDED` → `reply.status(402)`. `routes/compose.ts:226-228` — `errorCode==='DEST_CAP_EXCEEDED'` → status 402 (mid-pipeline). Suite verde. |
| AC-3 | rolling window: acumulado solo sobre débitos con debited_at >= now() - N segundos | PASS | `spend-policy.test.ts:392-396` — assert estructural sobre el SQL de la migración: `debited_at >= now() - (v_pol_wsecs * interval '1 second')` presente. `migration:104` — cláusula exacta confirmada. Suite verde. |
| AC-4 | Check cap + debit en la misma tx PostgreSQL con FOR UPDATE; débitos concurrentes serializan | PASS | `spend-policy.test.ts:370-390` — assert estructural: orden `lock key < lock policy < SUM < check cap < PERFORM increment < INSERT ledger` verificado contra el SQL de la migración. `budget.test.ts:625-651` — `Promise.all` de 2 débitos cap=1: exactamente 1 pasa, 1 rechazado con `DEST_CAP_EXCEEDED`; ambas llaman al RPC atómico (2 calls a `debit_with_dest_policy`). Suite verde. |
| AC-5 | Sin política: comportamiento exactamente igual a hoy (sin nuevos checks ni errores) | PASS | `budget.test.ts:477-492` — sin destino → `increment_a2a_key_spend` directo + assert `not.toHaveBeenCalledWith('debit_with_dest_policy', ...)`. `a2a-key.ts:795-804` — llamada condicional: sin `composeDestination` → 3-arg intacto. 93 tests de middleware/gasless verdes (3-arg). Suite verde. |
| AC-6 | Session hereda políticas activas de la parent key; override per-session = [TBD-FUTURO] | PASS (en scope del MVP) | `migration:213-217` — `debit_session_and_parent` (6 params): si `p_destination IS NOT NULL AND <> ''` → `PERFORM debit_with_dest_policy(p_key_id, ...)` → la sesión aplica el cap de la parent. `key-session.ts:440-454` — `debitSessionAndParent` agrega `destination?: string` AL FINAL (CD-4 respetado); pasa `p_destination: destination ?? null`. `key-session.test.ts:404-418` — `destination='kite/translator'` → RPC recibe `p_destination: 'kite/translator'`. `key-session.test.ts:420-435` — `DEST_CAP_EXCEEDED` → `DestCapExceededError`. `budget.test.ts:597-617` — con session ctx + destino, `debitSessionAndParent` recibe el destino como 6º arg. Suite verde. |
| AC-7 | Todo service lee/escribe a2a_key_spend_policies con .eq(key_id).eq(owner_ref); ownerId: string no-opcional; 0 rows → OwnershipMismatchError. En RPC: ownership DB-layer | PASS | `spend-policy.ts:159-161` (list): `.eq('key_id', keyId).eq('owner_ref', ownerId)`. `spend-policy.ts:185-187` (delete): idem. `spend-policy.ts:214-216` (hasAnyPolicy): idem. `migration:81-83` — ownership DB-layer: `IF v_key_owner IS DISTINCT FROM p_owner_ref THEN RAISE 'OWNERSHIP_MISMATCH'`. `spend-policy.test.ts:315-326` — 0 rows → `OwnershipMismatchError`. `spend-policy.test.ts:291-293` — list aserta `.eq('key_id', 'key-1')` + `.eq('owner_ref', 'user-1')`. Suite verde. |

---

## Drift Detection

### Scope drift

Archivos modificados vs Scope IN:

- Scope IN cumplido: `supabase/migrations/20260606000000*.sql`, `src/types/a2a-key.ts`, `src/services/spend-policy.ts` (nuevo), `src/services/budget.ts`, `src/services/key-session.ts`, `src/routes/auth.ts`, `src/services/compose.ts`, `src/middleware/a2a-key.ts`, `src/routes/compose.ts`, `src/services/security/errors.ts`, `src/types/index.ts` (W0.5 del story file), tests correctos.
- Fuera de Scope IN listado pero JUSTIFICADOS y APROBADOS: `src/services/agent-price.ts` + `src/services/agent-price.test.ts` (fix-pack BLQ-ALTO-1, aprobado en RE-AR), `src/types/index.ts` (extensión `ComposeResult.errorCode`, documentado en auto-blindaje y aprobado en CR).
- `doc/sdd/_INDEX.md` — actualización de índice de docs, operacional.
- `orchestrate.ts` NO modificado (confirmado — delega en compose). `increment_a2a_key_spend` NO modificado (CD-2 respetado).
- `doc/jury-qa*.md` — pre-existentes untracked (no de esta HU).
- `BACKLOG.md`, `HACKATHON-FINAL.md` — modificados en la rama principal, no de esta HU.

**Drift**: ninguno injustificado. Los 2 archivos del fix-pack y `index.ts` están explícitamente documentados y aprobados.

### Wave drift

Commits visibles en `main...HEAD`: WKH-121/122/123/124 (commits anteriores de la épica E16). WKH-125 está en working tree (sin commitear aún). No hay violación de orden wave (W0→W4 implementados en secuencia según el auto-blindaje).

### Spec drift

- Atomicidad RPC: `migration:70-129` — secuencia lock key → ownership → lock policy → SUM ledger → check cap → PERFORM increment → INSERT ledger. Conforme al SDD §DT-RPC.
- Destino canónico del agente: step-0 derivado de `resolveAgentDestination` (discovery), per-step de `agent.registry/agent.slug` (resolveAgent). Mismo normalizador `normalizeDestination`. Conforme.
- Back-compat: path sin `destination` → `increment_a2a_key_spend` directo. Conforme CD-5.
- `ComposeResult.errorCode` extendido a `'SCOPE_DENIED' | 'DEST_CAP_EXCEEDED'` — aditivo, aprobado CR.

**Spec drift**: ninguno.

### Test drift (CD-8 — aridad)

- `compose.test.ts`: 7 aserciones de `mockDebit` verificadas (L1115, L1159, L1168, L1223, L1232, L1416, L1496) — todas tienen 6 args con el destino normalizado real (`'test-registry/corridor'`, etc.). No `expect.anything()`.
- `orchestrate.billing.test.ts`: 4 aserciones L222, L231, L264, L272 — todas con 6 args (`'wasiai/a2'`, `'wasiai/a3'`, etc.).
- Aserciones de 3-arg (`a2a-key.test.ts`, `gasless.test.ts`) NO tocadas — confirmado por 93 tests verdes.
- Tests del fix-pack agregados: `agent-price.test.ts` T-DEST-1..4, `compose.test.ts` T-ROUTE-PRICE-DEST-1/2 — tests concretos con asserts no vagos, todos verdes.

**Test drift**: ninguno. Tests reforzados, no debilitados.

---

## Quality Gates

| Gate | Resultado | Fuente |
|------|-----------|--------|
| `npx tsc --noEmit` | PASS (0 errores) | RE-AR report (1554 passed) + confirmado QA: salida vacía (no errores) |
| `npm test` | PASS: 1554 passed / 3 skipped | Ejecutado QA: 96 test files, 8.36s tests, 2.15s total. Conteo idéntico al RE-AR report. |
| `npm run lint` | PASS (0 errores WKH-125) | Ejecutado QA: "No fixes applied. Found 1 info." — el `info` es `reputation.ts:116` pre-existente, `reputation.ts` no modificado (git status limpio). |
| build | NO EJECUTADO — tsc clean + tests verdes implican build correcta. CR confirmó 0 errores. | CR report |

---

## AR/CR Follow-up

### BLQ-ALTO-1 — CERRADO
- Fix en `src/services/agent-price.ts:83-93` (`resolveAgentDestination`) + `src/routes/compose.ts:92-98` (deriva destino del resuelto, no del body).
- Test T-ROUTE-PRICE-DEST-1 (`compose.test.ts:298-321`) reproduce el bypass y lo verifica cerrado.
- RE-AR verificó cierre con evidencia archivo:línea. Confirmado QA.

### BLQ-MED-1 — CERRADO
- `DROP FUNCTION IF EXISTS debit_session_and_parent(uuid, text, uuid, integer, numeric)` en `migration:157` — ANTES del CREATE de 6 params en `:159`.
- Firma del DROP matchea exacta la de 5 params de `20260603000000_a2a_key_sessions.sql:28-33`.
- RE-AR verificó cierre. Confirmado QA.

### Menores / Deuda técnica (no bloqueantes, documentados)

| Item | Descripción | Estado |
|------|-------------|--------|
| Override per-session real | `spend_policies?: SpendPolicyInput[]` en `CreateKeySessionInput` — campo existe en el tipo, semántica [TBD-FUTURO] no implementada. La herencia vía RPC cubre AC-6 del MVP. | Aceptado — Scope OUT explícito |
| Cap bajo delegacionContext | La rama de delegación en `budget.ts` no propaga `destination` a `debitDelegationAndParent`. Explícitamente fuera de scope ("Extender políticas a delegaciones EIP-712"). | Aceptado — Scope OUT |
| Purga del ledger | `a2a_key_dest_spend_ledger` crece sin TTL. Documentado DT-10. | Aceptado — Scope OUT, tarea futura |
| RLS Postgres-level para `a2a_key_spend_policies` | Sigue app-layer. Consistente con deuda WKH-SEC-02 vigente. | Aceptado — deuda pre-existente |

**0 BLOQUEANTES pendientes.**

---

## Smoke Manual (para el operador — ejecutar tras merge + migración aplicada)

```
1. PUT /auth/keys/me/spend-policies { destination:"test/agent", max_usd:"0.001", window_type:"total" }
   → esperar 200 con la política guardada.
2. POST /compose { steps:[{ agent:"test", input:{} }] }
   → primer call: 200 OK (el acumulado es 0, < max_usd).
3. POST /compose misma request (segundo call)
   → esperar 402 con error_code: "DEST_CAP_EXCEEDED" (el acumulado ya es >= max_usd).
4. Verificar en DB: SELECT * FROM a2a_key_dest_spend_ledger WHERE destination='test/agent';
   → debe haber 1 fila (la del primer call exitoso; el segundo no insertó por ROLLBACK).
```

---

**Listo para DONE.** Todos los ACs PASS con evidencia archivo:línea. 0 bloqueantes. Drift: ninguno injustificado. Suite 1554 verde. tsc 0 errores. lint sin findings de WKH-125.
