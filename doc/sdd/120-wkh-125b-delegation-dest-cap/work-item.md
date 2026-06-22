# Work Item — [WKH-125b] Aplicar el cap de gasto por destino en delegaciones EIP-712

## Resumen

WKH-125 introdujo el cap por destino (`a2a_key_spend_policies` + `a2a_key_dest_spend_ledger` + RPC `debit_with_dest_policy`) y lo aplicó correctamente a la ruta **master key** y a la ruta **session key** (fix d076ea8 / PR #92). La ruta de **delegación EIP-712** quedó explícitamente fuera del scope de WKH-125 (SDD §6 Scope OUT). Una auditoría cross-HU confirma que el bypass existe hoy en prod: un débito vía `delegationContext` salta al RPC `debit_delegation_and_parent` (que internamente llama `increment_a2a_key_spend`) sin pasar jamás por `debit_with_dest_policy` ni evaluar `a2a_key_spend_policies`. Esta HU cierra ese gap de forma simétrica al fix de session keys.

## Sizing

- SDD_MODE: full
- Estimación: M
- Branch sugerido: `fix/120-wkh-125b-delegation-dest-cap`

## Skills Router

- `payment-security` (cap de gasto, atomicidad en ruta de dinero)
- `backend-typescript` (modificación de RPC Postgres + service TS)

## F0 Grounding — Evidencia del bug (archivo:línea)

| Archivo | Línea(s) | Hallazgo |
|---------|----------|---------|
| `src/services/budget.ts` | 153–230 | La rama `if (delegationContext)` (L154) invoca `debitDelegationAndParent` sin `destination` y **retorna antes** de llegar al bloque dest-aware (L238). |
| `src/services/budget.ts` | 161–167 | Llamada `delegationService.debitDelegationAndParent(delegationContext.delegationId, delegationContext.ownerRef, delegationContext.keyId, chainId, amountUsd)` — 5 args, sin destino. |
| `src/services/budget.ts` | 238 | Bloque `if (destination)` (ruta master dest-aware) **nunca se alcanza** cuando hay `delegationContext` activo. |
| `src/services/delegation.ts` | 377–436 | `debitDelegationAndParent` llama `supabase.rpc('debit_delegation_and_parent', {...})` — ese RPC usa `PERFORM increment_a2a_key_spend(...)`, NOT `debit_with_dest_policy`. No hay slot para `destination`. |
| `src/services/key-session.ts` | 440–455 | **Contraste:** `debitSessionAndParent` acepta `destination?` en L446 y lo pasa como `p_destination: destination ?? null` en L454 — este es el patrón a espejar. |
| `doc/sdd/114-wkh-125-constraints/sdd.md` | §6 Scope OUT | Texto literal: "Extender políticas a delegaciones EIP-712 (DelegationPolicy mantiene su modelo)" — confirma que el gap fue conocido y diferido. |

**Veredicto: BUG REAL.** Una key con `a2a_key_spend_policies` configurada puede ser debiteada ilimitadamente vía delegación EIP-712 sin que el cap por destino sea evaluado.

## Acceptance Criteria (EARS)

- **AC-1 (DELEGATION-DEST-CAP)**: WHEN se realiza un débito vía `delegationContext` hacia un destino con política activa en `a2a_key_spend_policies` Y el acumulado en la ventana + el monto excedería `max_usd`, THEN the system SHALL rechazar con `DEST_CAP_EXCEEDED` (HTTP 402) y SHALL NOT decrementar el budget de la parent key ni el `total_spent` de la delegación.

- **AC-2 (DELEGATION-BACK-COMPAT)**: WHILE una delegación EIP-712 opera sobre una parent key sin políticas activas para el destino en cuestión, the system SHALL comportarse exactamente igual que hoy: el débito usa el RPC `debit_delegation_and_parent` con su semántica actual (total_spent + parent budget) sin nuevos checks ni errores.

- **AC-3 (DELEGATION-POLICY-WINDOW)**: WHEN una política tiene `window_type='rolling'` con `window_secs=N` Y el débito se realiza vía delegación, the system SHALL computar el acumulado SOLO sobre débitos con `debited_at >= now() - N segundos` en el ledger `a2a_key_dest_spend_ledger` — idéntico al comportamiento de master key y session key (AC-3 de WKH-125).

- **AC-4 (ATOMIC)**: WHEN el sistema evalúa el cap por destino para un débito de delegación, el check del cap + el debit del budget de la parent key + el UPDATE de `total_spent` de la delegación + el INSERT del ledger SHALL ejecutarse en la misma transacción PostgreSQL (indivisible), de modo que débitos concurrentes al mismo destino SHALL serializar y SHALL NOT producir race condition.

- **AC-5 (ERROR-CODE-PROPAGATION)**: WHEN el cap por destino se excede vía delegación, the system SHALL retornar `error_code: 'DEST_CAP_EXCEEDED'` al caller con HTTP 402 — el mismo código que las rutas master key y session key — y SHALL NOT exponer el mensaje crudo de PostgreSQL.

## Scope IN

- `src/services/delegation.ts` — extender firma de `debitDelegationAndParent` con `destination?: string` y pasarlo al RPC.
- `supabase/migrations/` — actualizar `debit_delegation_and_parent` con param `p_destination TEXT DEFAULT NULL`; dispatch interno a `debit_with_dest_policy` cuando hay destino (espejo exacto del fix de `debit_session_and_parent` en WKH-125 W3.4).
- `src/services/budget.ts` — pasar `destination` desde la rama `delegationContext` a `debitDelegationAndParent` (el `destination` ya llega como 6º param de `debit()` desde WKH-125).
- `src/services/delegation.ts` — mapear `DEST_CAP_EXCEEDED` en el bloque de errores de `debitDelegationAndParent` → lanzar `DestCapExceededError`.
- `src/services/budget.ts` — mapear `DestCapExceededError` en la rama delegación → `{ success: false, error: 'DEST_CAP_EXCEEDED' }`.
- Tests: `src/services/delegation.test.ts` (AC-1, AC-2, AC-5) + actualización de aserciones de aridad si corresponde.

## Scope OUT

- No se modifica la `DelegationPolicy` del EIP-712 (los campos firmados: `max_amount_per_tx`, `max_total_amount`, `allowed_chains`, etc.). El cap por destino viene de `a2a_key_spend_policies`, no del typed-data.
- No se agregan rutas HTTP nuevas (los endpoints `PUT/GET /auth/keys/me/spend-policies` ya existen de WKH-125).
- No se implementa override de política per-delegación (análogo a `[TBD-FUTURO]` de AC-6 de WKH-125 para sesiones).
- No se toca `debit_with_dest_policy` (el RPC ya existe, es correcto y se reusa vía PERFORM dentro del RPC de delegación, igual que para sesiones).
- No se modifican las rutas de master key ni session key.
- No se implementa purga del ledger.

## Decisiones técnicas (DT-N)

- **DT-1 (ESPEJO DEL FIX DE SESSION KEY)**: el mecanismo es simétrico al de WKH-125 W3.4 para `debit_session_and_parent`. El RPC `debit_delegation_and_parent` recibe un nuevo param `p_destination TEXT DEFAULT NULL`; cuando no es null, en el paso "PERFORM increment_a2a_key_spend" se reemplaza por "PERFORM debit_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination)". Esto da atomicidad total sin duplicar lógica de cap.

- **DT-2 (CREATE OR REPLACE con DROP previo)**: el BLQ-MED-1 de WKH-125 enseñó que `CREATE OR REPLACE` con +1 param crea una sobrecarga, no reemplaza. La migración DEBE incluir `DROP FUNCTION IF EXISTS debit_delegation_and_parent(...)` con la firma vieja ANTES del CREATE (idéntico al fix de `debit_session_and_parent` en WKH-125).

- **DT-3 (FIRMA TS SIN BLAST RADIUS)**: `destination` ya es el 6º param de `budgetService.debit()` (agregado en WKH-125). La rama delegación en `budget.ts` sólo necesita pasarlo a `debitDelegationAndParent`. La firma de `debitDelegationAndParent` en `delegation.ts` agrega `destination?: string` al final. Los call-sites de `debitDelegationAndParent` son exclusivamente `budget.ts:161` — blast radius de 1 call-site. No hay aserciones de aridad en tests que enumeren los args de `debitDelegationAndParent` directamente (a verificar con grep antes de tocar).

- **DT-4 (OWNER_REF YA DISPONIBLE)**: `delegationContext.ownerRef` ya existe en el objeto de contexto (`budget.ts:163`). El RPC `debit_with_dest_policy` requiere `p_owner_ref`. No se necesita un SELECT adicional para derivar el owner — ya está en el contexto.

## Constraint Directives (CD-N)

- **CD-1 (ATOMICIDAD OBLIGATORIA)**: PROHIBIDO chequear el cap en app-layer y debitar en RPC separado. El check cap + INSERT ledger + debit budget + UPDATE total_spent de la delegación DEBEN ocurrir en la misma tx PostgreSQL (dentro del RPC `debit_delegation_and_parent` actualizado, vía dispatch a `debit_with_dest_policy`).

- **CD-2 (DROP ANTES DE CREATE OR REPLACE)**: OBLIGATORIO incluir `DROP FUNCTION IF EXISTS debit_delegation_and_parent(<firma-vieja>)` antes del `CREATE OR REPLACE` en la migración. Sin esto se crea una sobrecarga y el caller de 5-arg queda activo (BLQ-MED-1 de WKH-125, REPETIDO).

- **CD-3 (BACK-COMPAT TOTAL)**: PROHIBIDO alterar el comportamiento cuando `p_destination IS NULL`: la delegación sin destino DEBE comportarse byte-idéntico a hoy (total_spent check + parent budget check, sin nuevo ledger, sin nuevo cap).

- **CD-4 (NO TOCAR increment_a2a_key_spend)**: PROHIBIDO modificar la firma o el cuerpo de `increment_a2a_key_spend`. El dispatch se hace a `debit_with_dest_policy` que internamente ya llama `PERFORM increment_a2a_key_spend`.

- **CD-5 (NO PROPAGAR MSG CRUDO PG)**: el prefijo `DEST_CAP_EXCEEDED` en `delegation.ts` DEBE lanzar `DestCapExceededError`; `budget.ts` lo mapea a `{ success: false, error: 'DEST_CAP_EXCEEDED' }`. El `error.message` crudo de Postgres NUNCA llega al cliente.

- **CD-6 (HARDENING BLOCK)**: la migración DEBE incluir el bloque `ALTER FUNCTION ... SET search_path = public, pg_temp` + `REVOKE ... FROM PUBLIC, anon, authenticated` + `GRANT ... TO service_role` con la firma tipada nueva (6 params) — idéntico al hardening de `debit_session_and_parent` en WKH-125.

## Missing Inputs

- [resuelto] Formato de `destination`: `<registry>/<slug>` normalizado — idéntico a WKH-125 (ya implementado en `normalizeDestination` de `spend-policy.ts`).
- [resuelto] `owner_ref` disponible: ya está en `delegationContext.ownerRef` (`budget.ts:163`).
- [resuelto] Firma vieja de `debit_delegation_and_parent`: 5 params `(UUID, TEXT, UUID, INT, NUMERIC)` — derivado de `delegation.ts:384-390`.

## Análisis de paralelismo

- Depende de WKH-125 (DONE/prod). Sin bloqueos pendientes.
- Puede ir en paralelo con las otras HUs del batch siempre que no toquen `delegation.ts` ni `budget.ts` ruta delegación.
- NO bloquea ninguna otra HU conocida.
- Prioridad: ALTA (security — bypass de cap en ruta de dinero, mismo severity que el bypass de session keys cerrado en d076ea8).
