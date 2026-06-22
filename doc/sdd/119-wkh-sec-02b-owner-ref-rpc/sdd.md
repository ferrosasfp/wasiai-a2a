# SDD #119: [WKH-SEC-02b] Validar `p_owner_ref` dentro de `increment_a2a_key_spend`

> SPEC_APPROVED: no
> Fecha: 2026-06-22
> Tipo: security / improvement (defensa en profundidad)
> SDD_MODE: full
> Branch: feat/119-wkh-sec-02b-owner-ref-rpc
> Artefactos: doc/sdd/119-wkh-sec-02b-owner-ref-rpc/

---

## 1. Resumen

`increment_a2a_key_spend` es el RPC fundacional de todo débito de budget en el
sistema, pero hoy NO valida `owner_ref` internamente. El Ownership Guard vive
solo en la capa app (WKH-53) o en los RPCs intermedios (`debit_with_dest_policy`,
`debit_delegation_and_parent`, `debit_session_and_parent`). Esta HU agrega un
guard Postgres-level dentro de `increment_a2a_key_spend` para que cualquier
invocación (directa o vía `PERFORM`) rechace con `OWNERSHIP_MISMATCH` y haga
ROLLBACK si el `p_owner_ref` pasado no coincide con el `owner_ref` registrado en
la fila de `a2a_agent_keys`. La RPC ya está REVOCADA de `anon`/`authenticated`
(WKH-SEC-02 / hardening previo) → esto es **defensa en profundidad, no un fix de
vulnerabilidad activa**.

El cambio es atómico y reversible: una migración up (DROP + CREATE de la firma
extendida + actualización de los 3 RPCs SQL que la invocan + caller TS) y una
migración down que restaura exactamente la firma de 3 params y los cuerpos
previos.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 119 |
| **Tipo** | security / improvement |
| **SDD_MODE** | full |
| **Objetivo** | Agregar Ownership Guard DB-level dentro de `increment_a2a_key_spend` (firma extendida con `p_owner_ref TEXT`), propagado a los 4 callers, sin regresión funcional. |
| **Reglas de negocio** | El guard se ubica DESPUÉS del `FOR UPDATE` y del `IF NOT FOUND`, ANTES del check de `is_active`. No se toca ninguna otra validación (daily reset, chain budget, KEY_INACTIVE, KEY_NOT_FOUND). |
| **Scope IN** | Nueva migración SQL up + down; `src/services/budget.ts` (caller #1 ruta master-no-dest); tests. |
| **Scope OUT** | `delegation.ts`, `key-session.ts`, `src/routes/`, lógica de negocio del débito, `register_a2a_key_deposit`, WKH-SEC-02c. |
| **Missing Inputs** | Ninguno tras F2 (los 2 [NEEDS CLARIFICATION] se resuelven en §10). |

### Acceptance Criteria (EARS)

1. **AC-1** — WHEN `increment_a2a_key_spend` se ejecuta con un `p_owner_ref` que NO
   coincide con el `owner_ref` registrado en `a2a_agent_keys` para `p_key_id`,
   THE system SHALL hacer `RAISE EXCEPTION 'OWNERSHIP_MISMATCH: ...'` y ROLLBACK
   de la transacción completa (ningún budget se decrementa).
2. **AC-2** — WHEN `budgetService.debit` ejecuta la ruta master-key sin destino
   (caller #1), THE system SHALL pasar `p_owner_ref` a `increment_a2a_key_spend`
   y SHALL continuar debitando correctamente para un owner válido.
3. **AC-3** — WHEN `debit_delegation_and_parent`, `debit_session_and_parent` o
   `debit_with_dest_policy` ejecutan `PERFORM increment_a2a_key_spend(...)`,
   THE system SHALL incluir `p_owner_ref` en cada PERFORM y el débito SHALL
   completarse sin error para un `owner_ref` correcto (preservando el dispatch
   condicional a `debit_with_dest_policy` introducido en WKH-125/125b).
4. **AC-4** — WHEN se aplica el down script, THE system SHALL restaurar
   `increment_a2a_key_spend` a su firma de 3 params (sin `p_owner_ref`) y los 3
   RPCs dependientes a sus versiones previas (post-125b), sin pérdida de datos.
5. **AC-5** — WHILE el servicio corre post-migración, THE system SHALL mantener
   `tsc` 0 errores, `biome` 0 errores (en los archivos tocados) y la suite de
   tests existente en verde; compose/orchestrate SHALL retornar HTTP 200 para
   keys válidas.
6. **AC-6** — IF `increment_a2a_key_spend` lanza `OWNERSHIP_MISMATCH` vía la ruta
   del caller #1, THEN THE system SHALL mapear el error a
   `{ success: false, error: 'OWNERSHIP_MISMATCH' }` sin propagar el mensaje
   crudo de Postgres al cliente.

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `supabase/migrations/20260406000000_a2a_agent_keys.sql` | Definición original de `increment_a2a_key_spend` (3 params) | Estructura: `SELECT * ... FOR UPDATE` → `IF NOT FOUND` (KEY_NOT_FOUND) → `IF NOT is_active` (KEY_INACTIVE) → daily reset → DAILY_LIMIT → INSUFFICIENT_BUDGET → UPDATE. `SECURITY DEFINER`. |
| `supabase/migrations/20260406000000_a2a_agent_keys_down.sql` | Patrón de down script | `DROP FUNCTION IF EXISTS increment_a2a_key_spend(UUID, INT, NUMERIC)` (firma exacta). |
| `supabase/migrations/20260606000000_a2a_key_spend_policies.sql` | Callers #4 (`debit_with_dest_policy`) y #3 (`debit_session_and_parent`); exemplar de Ownership Guard DB-level | Guard: `IF v_key_owner IS DISTINCT FROM p_owner_ref THEN RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller'`. Dispatch condicional `IF p_destination IS NOT NULL AND <> '' → debit_with_dest_policy ELSE increment_a2a_key_spend`. Patrón DROP-antes-de-CREATE (BLQ-MED-1). |
| `supabase/migrations/20260608000000_wkh125b_delegation_dest_cap.sql` | Caller #2 (`debit_delegation_and_parent`), ESTADO ACTUAL post-125b (6 params) | Firma 6 params `(p_delegation_id, p_owner_ref, p_key_id, p_chain_id, p_amount_usd, p_destination DEFAULT NULL)` con dispatch condicional `debit_with_dest_policy` / `increment_a2a_key_spend` en el paso 5. Hardening: `ALTER FUNCTION ... SET search_path` + REVOKE/GRANT. |
| `supabase/migrations/20260608000000_wkh125b_delegation_dest_cap_down.sql` | Cómo se revierte el caller #2 hoy | Restaura la firma de 5 params con `PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd)` (3-arg). **CRÍTICO**: mi up DEBE asentarse sobre la firma de 6 params, NO sobre esta de 5 del down de 125b. |
| `src/services/budget.ts` | Caller #1 TS (ruta master-no-dest L298-308) + ruta dest-aware (L247-263, exemplar del SELECT cold-path de owner) + mapeo de errores | Ruta dest-aware ya hace `SELECT owner_ref ... .eq('id', keyId).single()` y mapea `OWNERSHIP_MISMATCH` por `msg.includes(...)` (L282-284). Ruta master-no-dest hoy llama `supabase.rpc('increment_a2a_key_spend', {p_key_id, p_chain_id, p_amount_usd})` y devuelve `error.message` crudo (L304-305). |
| `src/services/budget.test.ts` | Tests existentes del caller #1 (impacto del cambio de firma) | Tests L180-191, L229-240 llaman `debit('key-1', 2368, 1.5)` (3-arg) y asertan `rpc('increment_a2a_key_spend', {p_key_id, p_chain_id, p_amount_usd})` SIN `p_owner_ref`. Mock helper `chainMock()` para `supabase.from(...).select().eq().single()`. Mock `supabase.rpc`. |
| `src/middleware/a2a-key.ts` (L820-928) | Call-site de producción que llega a la ruta master-no-dest | L861: `budgetService.debit(keyRow.id, chainId, estimatedCostUsd)` (3-arg). `keyRow.owner_ref` ya está en scope (L876, L899, L926). |
| `src/services/compose.ts` (L110-186) | Otro call-site de `budgetService.debit` | L160: SIEMPRE pasa `destination` (6º arg) → enruta a delegación/sesión/dest-policy → NUNCA llega a la ruta master-no-dest. No reaches caller #1. |
| `src/services/security/errors.ts` | Shape de `OwnershipMismatchError` | `class OwnershipMismatchError extends Error { readonly code = 'OWNERSHIP_MISMATCH' }`. (No requerido en la ruta master-no-dest: ahí se mapea por string-match como en el dest path.) |
| `doc/sdd/114-.../auto-blindaje.md`, `116-...`, `120-...` | Lecciones históricas | Ver §3.bis. |

### Exemplars

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| Migración up (DROP + CREATE `increment_a2a_key_spend` 4-param + guard) | `20260606000000_a2a_key_spend_policies.sql:80-83` (guard) + `:157` (DROP antes de CREATE) | Guard `IS DISTINCT FROM` + patrón BLQ-MED-1 ya probado en este codebase. |
| Actualizar PERFORM en los 3 RPCs SQL | `20260608000000_wkh125b_delegation_dest_cap.sql:74-78` (dispatch condicional) | Preservar el dispatch a `debit_with_dest_policy` de 125b; solo agregar `p_owner_ref` al PERFORM de `increment_a2a_key_spend`. |
| Migración down | `20260608000000_wkh125b_delegation_dest_cap_down.sql` | DROP de la firma nueva + CREATE OR REPLACE literal de la versión previa + hardening de la firma vieja. |
| `budget.ts` SELECT cold-path de owner en ruta master-no-dest | `src/services/budget.ts:247-255` (ruta dest-aware, mismo archivo) | Precedente exacto del mismo derivado de `owner_ref` vía SELECT; reusarlo. |
| `budget.ts` mapeo `OWNERSHIP_MISMATCH` por string-match | `src/services/budget.ts:282-284` (ruta dest-aware) | Mismo patrón `msg.includes('OWNERSHIP_MISMATCH')`. |
| Tests SQL del guard (owner válido / inválido + rollback) | `src/services/budget.test.ts` (mock `supabase.rpc` / `from`) | Mismo framework (vitest) y mocks ya montados. |

### Estado de BD relevante

| Objeto | Existe | Detalle relevante |
|--------|--------|-------------------|
| `a2a_agent_keys` | Sí | Columna `owner_ref TEXT NOT NULL`. PK `id UUID`. |
| `increment_a2a_key_spend(uuid, integer, numeric)` | Sí | Firma 3-param actual (sin owner guard). |
| `debit_with_dest_policy(uuid, integer, numeric, text, text)` | Sí | Caller #4. PERFORM `increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd)` en L123. |
| `debit_delegation_and_parent(uuid, text, uuid, integer, numeric, text)` | Sí (post-125b, 6 params) | Caller #2. Dispatch condicional L74-78. |
| `debit_session_and_parent(uuid, text, uuid, integer, numeric, text)` | Sí (post-125, 6 params) | Caller #3. Dispatch condicional L213-217. |
| `register_a2a_key_deposit` | Sí | Función hermana, ya tiene `p_owner_ref` + guard. **NO TOCAR.** |

### Componentes reutilizables encontrados

- Guard `IF <owner> IS DISTINCT FROM p_owner_ref THEN RAISE EXCEPTION 'OWNERSHIP_MISMATCH...'` — patrón canónico en `debit_with_dest_policy:81-83`. Reusar verbatim el wording.
- SELECT cold-path de `owner_ref` en `budget.ts:247-255` — reusar para el caller #1.
- Mapeo `msg.includes('OWNERSHIP_MISMATCH')` en `budget.ts:282-284` — reusar.

### §3.bis — Lecciones de Auto-Blindaje histórico (aplicadas como CD)

- **BLQ-MED-1 (recurrente ≥3 HUs: WKH-125, WKH-125b, WKH-SEC-02 patrón DDL)**: `CREATE OR REPLACE` con cambio de aridad crea una **sobrecarga**, no reemplaza → `ERROR: function ... is not unique`. Mitigado por **CD-1** (DROP de la firma de 3 params antes del CREATE de 4). Ref: `114/auto-blindaje#75-95`, `120/auto-blindaje` (header de la migración 125b).
- **Test estructural frágil por substring (WKH-116)**: contar sentencias DDL completas, no substrings que también matchean comentarios. Mitigado por **CD-7**. Ref: `116/auto-blindaje#4-7`.
- **Biome line-length en aserciones (WKH-125b)**: escribir aserciones largas ya multilínea y correr `biome check <files-tocados>` antes de cerrar. Mitigado por **CD-8**. Ref: `120/auto-blindaje#3-16`.
- **Scope discipline / lint pre-existente (WKH-125b)**: separar errores propios de los pre-existentes con `git diff origin/main -- <file>`; no expandir scope. Mitigado por **CD-9**. Ref: `120/auto-blindaje#18-29`.

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc.sql` | Crear | UP: DROP `increment_a2a_key_spend(uuid,integer,numeric)` + CREATE firma 4-param con guard owner_ref + CREATE OR REPLACE de los 3 RPCs SQL pasando `p_owner_ref` en el PERFORM (preservando dispatch 125b) + hardening de la nueva firma de `increment`. | `20260606000000_a2a_key_spend_policies.sql`, `20260608000000_wkh125b_delegation_dest_cap.sql` |
| `supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc_down.sql` | Crear | DOWN: DROP firma 4-param + CREATE OR REPLACE de la firma 3-param original (cuerpo literal) + restaurar el PERFORM 3-arg en los 3 RPCs (versión post-125b) + hardening. | `20260608000000_wkh125b_delegation_dest_cap_down.sql` |
| `src/services/budget.ts` | Modificar | Ruta master-no-dest (L297-308): SELECT cold-path de `owner_ref` → pasar `p_owner_ref` al RPC → mapear `OWNERSHIP_MISMATCH` por `error.message.includes(...)`. | `budget.ts:247-263` y `:282-284` (mismo archivo) |
| `src/services/budget.test.ts` | Modificar | Actualizar las aserciones de los tests master-key (3-arg) para incluir `p_owner_ref` + agregar tests del nuevo guard (owner válido pasa / inválido rechaza / mapping / KEY_NOT_FOUND en SELECT). | `budget.test.ts` (mocks ya montados) |

> El timestamp `20260609000000` se elige > `20260608000000` (última migración del repo, WKH-125b) para garantizar orden de aplicación correcto.

### 4.2 Modelo de datos

Sin cambios de schema (no se altera ninguna tabla). Solo se redefine la **firma y
el cuerpo** de la función `increment_a2a_key_spend` (de 3 a 4 params) y se ajusta
el `PERFORM` dentro de 3 RPCs existentes. Ningún dato se migra ni se pierde.

### 4.3 Firma final de `increment_a2a_key_spend`

```
increment_a2a_key_spend(
  p_key_id     UUID,
  p_chain_id   INT,
  p_amount_usd NUMERIC,
  p_owner_ref  TEXT        -- NUEVO (WKH-SEC-02b): Ownership Guard DB-level
) RETURNS void
```

Cuerpo (DT-2, posición del guard): el guard se inserta **entre** el `IF NOT FOUND`
(KEY_NOT_FOUND, ya existente) y el `IF NOT v_row.is_active` (KEY_INACTIVE):

```
SELECT * INTO v_row FROM a2a_agent_keys WHERE id = p_key_id FOR UPDATE;
IF NOT FOUND THEN RAISE EXCEPTION 'KEY_NOT_FOUND: ...'; END IF;

-- NUEVO (WKH-SEC-02b, AC-1): Ownership Guard DB-level. La fila ya está lockeada
-- (FOR UPDATE). El service usa SERVICE_ROLE/bypass RLS → este check es la única
-- defensa Postgres-level para la ruta directa.
IF v_row.owner_ref IS DISTINCT FROM p_owner_ref THEN
  RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller', p_key_id;
END IF;

IF NOT v_row.is_active THEN RAISE EXCEPTION 'KEY_INACTIVE: ...'; END IF;
-- ... resto INTACTO (daily reset, DAILY_LIMIT, INSUFFICIENT_BUDGET, UPDATE) ...
```

Toda la lógica existente (daily reset, chain budget, mensajes de error) se copia
**literal** desde `20260406000000_a2a_agent_keys.sql:60-121`. Solo se añade el
parámetro y el bloque del guard (CD-5). Se mantiene `SECURITY DEFINER` y se agrega
hardening (`SET search_path`, REVOKE/GRANT) consistente con los RPCs hermanos.

### 4.4 Actualización de los 3 RPCs SQL (callers #2/#3/#4)

Los 3 RPCs ya reciben `p_owner_ref` como parámetro propio. El único cambio es
agregar `p_owner_ref` al `PERFORM increment_a2a_key_spend(...)` (DT-3):

- **Caller #4** `debit_with_dest_policy` (`20260606000000:123`):
  `PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);`
- **Caller #3** `debit_session_and_parent` (`20260606000000:216`, branch ELSE
  sin destino): `PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);`
  — el branch `IF` con destino llama `debit_with_dest_policy` (sin cambios; ese
  RPC ya propaga su propio `p_owner_ref` al `increment` actualizado). **Preservar
  el dispatch condicional.**
- **Caller #2** `debit_delegation_and_parent` (`20260608000000:77`, branch ELSE
  sin destino): `PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);`
  — el branch `IF p_destination ...` llama `debit_with_dest_policy(...)` (firma 5
  params, sin cambios). **Preservar el dispatch de 125b (CD-10).**

> Para cada RPC se usa `CREATE OR REPLACE` SIN cambio de aridad (su firma NO
> cambia, solo el cuerpo) → NO requiere DROP previo. El único DROP necesario es el
> de `increment_a2a_key_spend` (que SÍ cambia de aridad). Como los 3 RPCs se
> recrean con CREATE OR REPLACE en la misma migración, hay que re-emitir su
> hardening (`ALTER FUNCTION ... SET search_path` + REVOKE/GRANT) tras cada
> CREATE OR REPLACE, copiando los bloques de hardening verbatim de sus
> migraciones origen.

### 4.5 Caller #1 TS — `budget.ts` ruta master-no-dest (DT-4: Opción A/(a) resuelta en §10)

```
// ── RUTA MASTER KEY — INTACTA salvo el owner guard (CD-5) ──
// WKH-SEC-02b: el RPC ahora exige p_owner_ref. Mismo SELECT cold-path que la
// ruta dest-aware (L247-255). Sólo en esta ruta directa (cold path aceptable).
const { data: keyRow, error: ownerErr } = await supabase
  .from('a2a_agent_keys')
  .select('owner_ref')
  .eq('id', keyId)
  .single();
if (ownerErr || !keyRow) {
  return { success: false, error: 'KEY_NOT_FOUND' };
}
const ownerRef = (keyRow as Pick<A2AAgentKeyRow, 'owner_ref'>).owner_ref;

const { error } = await supabase.rpc('increment_a2a_key_spend', {
  p_key_id: keyId,
  p_chain_id: chainId,
  p_amount_usd: amountUsd,
  p_owner_ref: ownerRef,                  // NUEVO (AC-2)
});

if (error) {
  // CD-3/AC-6: NO propagar el msg crudo de PG para OWNERSHIP_MISMATCH.
  if (error.message.includes('OWNERSHIP_MISMATCH')) {
    return { success: false, error: 'OWNERSHIP_MISMATCH' };
  }
  return { success: false, error: error.message };  // resto: comportamiento previo
}
return { success: true };
```

> Nota de regresión: el comportamiento previo devolvía `error.message` crudo para
> DAILY_LIMIT/INSUFFICIENT_BUDGET (tests L193-223 lo asertan). Ese branch se
> **mantiene** para todos los errores salvo `OWNERSHIP_MISMATCH`, que se mapea a
> code estable (AC-6/CD-3). Los tests existentes de DAILY_LIMIT/INSUFFICIENT_BUDGET
> siguen verdes; solo se actualiza la aserción del `rpc(...)` para incluir
> `p_owner_ref`.

### 4.6 Flujo principal (Happy Path)

1. `a2a-key.ts:861` llama `budgetService.debit(keyRow.id, chainId, cost)` (sin
   delegación/sesión/destino).
2. `budget.ts` cae a la ruta master-no-dest → SELECT `owner_ref` de la key.
3. Llama `increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref)`.
4. El RPC lockea la fila, valida `owner_ref` (match) → continúa con daily reset /
   budget check / UPDATE.
5. Resultado: `{ success: true }`, budget decrementado atómicamente.

### 4.7 Flujo de error

1. **Owner mismatch** (AC-1): si `p_owner_ref` ≠ `owner_ref` de la key →
   `RAISE EXCEPTION 'OWNERSHIP_MISMATCH...'` → ROLLBACK total → `budget.ts` mapea a
   `{ success: false, error: 'OWNERSHIP_MISMATCH' }`. Budget intacto.
2. **Key inexistente en el SELECT cold-path**: `ownerErr || !keyRow` →
   `{ success: false, error: 'KEY_NOT_FOUND' }` (sin llamar al RPC).
3. **Otros errores PG** (DAILY_LIMIT, INSUFFICIENT_BUDGET, KEY_INACTIVE,
   KEY_NOT_FOUND desde el RPC): comportamiento previo intacto (`error.message`).

## 5. Constraint Directives (Anti-Alucinación)

### Heredados del work-item (resueltos donde aplica)

- **CD-1** — PROHIBIDO usar `CREATE OR REPLACE` para cambiar la firma de
  `increment_a2a_key_spend` sin DROP previo. OBLIGATORIO
  `DROP FUNCTION IF EXISTS increment_a2a_key_spend(uuid, integer, numeric);`
  ANTES del `CREATE OR REPLACE` de la firma de 4 params. (Lección BLQ-MED-1,
  recurrente ≥3 HUs — ref `114/auto-blindaje#75-95`.)
- **CD-2** — OBLIGATORIO que el down restaure EXACTAMENTE la firma (3 params) y el
  cuerpo original de `increment_a2a_key_spend`, y los 3 RPCs a su versión previa
  (post-125b para `debit_delegation_and_parent`), para rollback atómico reversible.
- **CD-3** — PROHIBIDO propagar el mensaje crudo de Postgres `OWNERSHIP_MISMATCH`
  al cliente. Debe mapearse a `{ success: false, error: 'OWNERSHIP_MISMATCH' }` en
  `budget.ts` (patrón de la ruta dest-aware, `budget.ts:282-284`).
- **CD-4** — OBLIGATORIO que la migración sea idempotente en reintento: usar
  `DROP FUNCTION IF EXISTS` y `CREATE OR REPLACE`; re-run down+up no debe dejar la
  DB inconsistente.
- **CD-5** — PROHIBIDO modificar la lógica existente dentro de
  `increment_a2a_key_spend` (daily reset, chain budget, KEY_INACTIVE,
  KEY_NOT_FOUND). Solo se agrega el guard entre el `IF NOT FOUND` y el check de
  `is_active`. El resto del cuerpo se copia literal de `20260406000000:60-121`.

### Específicos del SDD (F2)

- **CD-6** — OBLIGATORIO replicar el hardening (`ALTER FUNCTION public.increment_a2a_key_spend(uuid,integer,numeric,text) SET search_path = public, pg_temp;` + `REVOKE ... FROM PUBLIC, anon, authenticated;` + `GRANT ... TO service_role;`) para la nueva firma de 4 params, consistente con los RPCs hermanos. El down debe restaurar el hardening de la firma de 3 params (o no agregarlo si la original no lo tenía — verificar: la original NO tiene hardening, así que el down NO debe agregarlo).
- **CD-7** — Los tests estructurales del SQL (si los hay) DEBEN contar sentencias
  DDL completas (regex sobre la forma `CREATE OR REPLACE FUNCTION increment_a2a_key_spend(...)` / `DROP FUNCTION`), NO substrings que también matcheen comentarios. (Lección WKH-116, ref `116/auto-blindaje#4-7`.)
- **CD-8** — Las aserciones de test largas (p.ej. `expect(mockRpc).toHaveBeenCalledWith('increment_a2a_key_spend', { ... p_owner_ref ... })`) se escriben ya multilínea; correr `./node_modules/.bin/biome check <archivos-tocados>` antes de cerrar la wave de tests. (Lección WKH-125b, ref `120/auto-blindaje#3-16`.)
- **CD-9** — PROHIBIDO expandir scope para arreglar lint pre-existente. Si
  `npm run lint` global falla, separar errores propios con
  `git diff origin/main -- <file>`; lint scopeado a los archivos de la HU debe dar 0. (Lección WKH-125b, ref `120/auto-blindaje#18-29`.)
- **CD-10** — PROHIBIDO romper el dispatch condicional de WKH-125/125b en
  `debit_delegation_and_parent` y `debit_session_and_parent`. La migración up DEBE
  partir de la firma de 6 params (con `p_destination`) y el branch
  `IF p_destination IS NOT NULL AND <> '' THEN PERFORM debit_with_dest_policy(...)`
  se preserva intacto; solo se modifica el branch ELSE (PERFORM
  `increment_a2a_key_spend`) para agregar `p_owner_ref`.
- **CD-11** — PROHIBIDO tocar `register_a2a_key_deposit`, `delegation.ts`,
  `key-session.ts`, `src/routes/`, `compose.ts` (no llega a caller #1). Caller #1
  TS es exclusivamente la ruta master-no-dest de `budget.ts`.

## 6. Scope

**IN:**
- Migración up `20260609000000_wkh_sec02b_owner_ref_rpc.sql`.
- Migración down `20260609000000_wkh_sec02b_owner_ref_rpc_down.sql`.
- `src/services/budget.ts` (ruta master-no-dest: SELECT owner + p_owner_ref + mapping).
- `src/services/budget.test.ts` (aserciones actualizadas + tests del guard).

**OUT:**
- `delegation.ts`, `key-session.ts` (cuerpo TS), `src/routes/`, `compose.ts`,
  `a2a-key.ts` (no cambia su call-site de 3-arg), lógica de negocio del débito,
  `register_a2a_key_deposit`, WKH-SEC-02c.

## 7. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| `CREATE OR REPLACE` crea overload de `increment_a2a_key_spend` (BLQ-MED-1) | M | A | CD-1: DROP de la firma de 3 params ANTES del CREATE de 4. |
| Down de 125b deja `debit_delegation_and_parent` con PERFORM 3-arg si se aplica DESPUÉS de esta HU | B | M | Esta HU NO toca el down de 125b; su propio down restaura la versión post-125b (6 params, dispatch intacto). Orden de timestamps garantiza aplicación correcta. |
| SELECT cold-path en master-no-dest agrega 1 query extra en happy path | B | B | Aceptable: ruta directa de baja frecuencia (compose va por dest-policy; orchestrate por sus propios RPCs). Mismo precedente que la ruta dest-aware (cold-path ya aceptado). |
| Downtime en Railway rolling deploy por el DROP en vuelo | B | B | El DROP+CREATE es DDL transaccional en Postgres (atómico, sub-ms). La RPC ya está revocada de anon/authenticated; el único caller es `service_role` (el backend). Hot-apply seguro: ver §10 DT-1. |
| Tests existentes 3-arg rompen al cambiar la firma del RPC | A | M | Esperado: actualizar aserciones `rpc('increment_a2a_key_spend', {...})` para incluir `p_owner_ref` (budget.test.ts L185, L234). Es parte del scope. |

## 8. Dependencias

- **WKH-125b (DONE, #120, mergeado)**: `debit_delegation_and_parent` ya está en 6
  params con dispatch condicional. Esta HU se asienta sobre ese estado (CD-10).
- **WKH-125 (DONE, #114)**: `debit_session_and_parent` y `debit_with_dest_policy`
  ya en su forma actual.
- Migraciones up/down deben aplicarse con el runner existente del repo (orden por
  timestamp). Sin nuevas dependencias de librerías.

## 9. Missing Inputs

Ninguno tras F2. Los 2 [NEEDS CLARIFICATION] del work-item se resuelven en §10.

## 10. Uncertainty Markers — RESUELTOS

| Marker original | Sección | Resolución (F2) | Bloqueante? |
|-----------------|---------|-----------------|-------------|
| [NEEDS CLARIFICATION] DT-1 (Opción A vs B) | §4.1/§4.4 | **RESUELTO → Opción A** | No |
| [NEEDS CLARIFICATION] DT-4 (cómo obtiene ownerId el caller #1) | §4.5 | **RESUELTO → Opción (a) SELECT cold-path** | No |

### DT-1 — RESUELTO: Opción A (DROP + recrear, atómico)

**Decisión: Opción A.** DROP de `increment_a2a_key_spend(uuid,integer,numeric)` +
CREATE de la firma de 4 params + actualización de los 3 RPCs + caller TS, todo en
una migración.

Justificación:
1. **Precedente exitoso en el codebase** (BLQ-MED-1): WKH-125 y WKH-125b ya usaron
   exactamente este patrón (DROP de la firma vieja → CREATE de la nueva) para
   `debit_session_and_parent` y `debit_delegation_and_parent`. Replicarlo es la
   ruta de menor riesgo y consistente.
2. **Opción B deja un vector de confusión semántica**: una función sin guard
   coexistiendo con la owned → riesgo de que un futuro RPC llame la insegura.
   Contradice el objetivo de "defensa en profundidad fundacional".
3. **Riesgo de downtime en Railway evaluado como BAJO → hot-apply seguro**: el
   `DROP FUNCTION` + `CREATE` es DDL transaccional en Postgres (se ejecuta en una
   transacción, atómico, sub-milisegundo, toma un lock de la función). La RPC ya
   está REVOKED de `anon`/`authenticated`; el único rol con EXECUTE es
   `service_role` (el backend). Una llamada en vuelo en el instante del DROP, en
   el peor caso, recibe un error transitorio de "function not found" que el caller
   trata como debit-fail (request rechazado, budget intacto) — no hay corrupción
   ni doble-débito. No se requiere ventana de mantenimiento; aplicar en deploy
   normal. (Si se quisiera cero-error, se puede aplicar la migración antes del
   rollout del nuevo `budget.ts`, pero NO es necesario para correctness.)

### DT-4 — RESUELTO: Opción (a) SELECT cold-path (mínima superficie)

**Decisión: Opción (a)** — derivar `ownerRef` con un SELECT cold-path dentro de la
ruta master-no-dest de `debit()`, idéntico al que ya existe en la ruta dest-aware
(`budget.ts:247-255`). NO se amplía la firma de `debit()`.

**Blast radius — enumeración completa de call-sites de `budgetService.debit`
(grep verificado):**

| Call-site | Args | ¿Llega a caller #1 (master-no-dest)? | Impacto de Opción (b)/(c) |
|-----------|------|--------------------------------------|---------------------------|
| `src/middleware/a2a-key.ts:861` | 3 (`keyRow.id, chainId, cost`) | **SÍ** (única ruta de prod que llega) | Habría que pasar `keyRow.owner_ref` (está en scope) |
| `src/middleware/a2a-key.ts:853` | 6 (con `composeDestination`) | No (destino → dest-policy) | — |
| `src/services/compose.ts:160` | 6 (delegación/sesión/destino) | No (siempre con contexto/destino) | Firma cambiaría igual |
| `src/services/budget.test.ts` (×30+) | 3 a 6 | Varios 3-arg llegan | TODAS las llamadas 3-arg + sus aserciones se reescriben |
| `src/routes/gasless.test.ts:119`, `auth.erc8004.test.ts:98`, `orchestrate.billing.test.ts:116`, `a2a-key.test.ts:221`, `compose.test.ts:59` | mock `vi.mocked(budgetService.debit)` | mock | Mocks no cambian de firma, pero asserts de arg-count podrían romper |

**Por qué Opción (a) minimiza superficie sin regresión:**
- **Cero cambios en call-sites**: la firma de `debit()` no cambia → `a2a-key.ts`,
  `compose.ts`, `orchestrate`, `gasless`, y todos los tests con `vi.mocked` quedan
  intactos. Solo cambia el cuerpo interno de la ruta master-no-dest.
- **Precedente idéntico**: la ruta dest-aware del MISMO archivo ya hace este SELECT
  (WKH-125 lo eligió explícitamente vía su CD-4 "no se amplía la firma"). Mantener
  coherencia.
- **Costo aceptable**: 1 query extra solo en la ruta directa de baja frecuencia
  (compose/orchestrate no la usan). El happy-path de alto volumen (dest-policy) ya
  paga ese SELECT.
- **Opción (b)/(c) descartadas**: amplían la firma de `debit()` con `ownerId`
  obligatorio → reescritura de `a2a-key.ts:861`, todos los call-sites de test, y
  riesgo de regresión en orchestrate/gasless/compose. Blast radius alto para una
  HU de hardening que NO es vuln activa. No justifica el costo.

> Nota: aunque arquitectónicamente (c) alinea con la Security Convention de
> CLAUDE.md ("ownerId siempre obligatorio"), esa convención aplica a funciones que
> RECIBEN un `keyId` desde una ruta autenticada con `request.a2aKeyRow` en scope.
> `debit()` se llama desde múltiples contextos (algunos sin owner directo, como
> el per-step de compose), por lo que el refactor (c) es una HU separada de mayor
> alcance, fuera de este scope.

---

## 11. Plan de Implementación (Waves)

### Wave 0 (Serial Gate — migración SQL up + down)

- [ ] **W0.1** — Crear `supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc.sql`:
  - DROP `increment_a2a_key_spend(uuid, integer, numeric)` (CD-1).
  - CREATE `increment_a2a_key_spend(uuid, integer, numeric, text)` con guard
    owner_ref entre `IF NOT FOUND` y `is_active` (CD-5), resto literal de
    `20260406000000:60-121`. Hardening de la nueva firma (CD-6).
  - CREATE OR REPLACE `debit_with_dest_policy` (firma intacta) con
    `PERFORM increment_a2a_key_spend(..., p_owner_ref)` + re-hardening.
  - CREATE OR REPLACE `debit_session_and_parent` (6 params, dispatch intacto;
    branch ELSE pasa `p_owner_ref`) + re-hardening (CD-10).
  - CREATE OR REPLACE `debit_delegation_and_parent` (6 params, dispatch 125b
    intacto; branch ELSE pasa `p_owner_ref`) + re-hardening (CD-10).
  - Exemplar: `20260606000000_a2a_key_spend_policies.sql`, `20260608000000_wkh125b_delegation_dest_cap.sql`.
- [ ] **W0.2** — Crear `..._down.sql`: DROP firma 4-param de `increment` + CREATE
  OR REPLACE firma 3-param original (cuerpo literal, sin hardening — la original
  no lo tenía, CD-6) + CREATE OR REPLACE de los 3 RPCs restaurando el PERFORM 3-arg
  (versión post-125b para delegation; preservar dispatch) + hardening de los 3 RPCs.
  - Exemplar: `20260608000000_wkh125b_delegation_dest_cap_down.sql`.

### Wave 1 (TS — depende de W0; caller #1)

- [ ] **W1.1** — `src/services/budget.ts` ruta master-no-dest: agregar SELECT
  cold-path de `owner_ref` (DT-4 opción a), pasar `p_owner_ref` al RPC, mapear
  `OWNERSHIP_MISMATCH` por `error.message.includes(...)` (CD-3). El resto del
  branch de error intacto.
  - Exemplar: `budget.ts:247-263` y `:282-284`.

### Wave 2 (Tests — depende de W0 + W1)

- [ ] **W2.1** — `src/services/budget.test.ts`: actualizar aserciones de los tests
  master-key 3-arg (L185, L234) para incluir `p_owner_ref` (el mock `chainMock`
  debe devolver la key con `owner_ref` para el SELECT cold-path). Agregar tests
  del guard: owner válido pasa, `OWNERSHIP_MISMATCH` mapea a code estable + no
  decrementa, `KEY_NOT_FOUND` en el SELECT cold-path. Correr biome sobre archivos
  tocados (CD-8).

### Wave 3 (Verificación final)

- [ ] **W3.1** — `tsc` 0 errores; `biome check src/services/budget.ts src/services/budget.test.ts` 0; suite completa verde (CD-9: separar lint pre-existente). Verificar `git diff` no toca archivos fuera de Scope IN.

## 12. Test Plan (≥1 por AC)

| Test (archivo) | AC | Descripción | Wave |
|----------------|-----|-------------|------|
| `budget.test.ts` — `debit master owner válido pasa p_owner_ref` | AC-2 | `debit('key-1', chain, amt)` → SELECT devuelve `owner_ref` → `rpc('increment_a2a_key_spend', { p_key_id, p_chain_id, p_amount_usd, p_owner_ref })` → `{ success: true }`. | W2 |
| `budget.test.ts` — `debit master OWNERSHIP_MISMATCH mapea a code estable` | AC-1, AC-6 | RPC devuelve `error.message` con `OWNERSHIP_MISMATCH` → `{ success: false, error: 'OWNERSHIP_MISMATCH' }` (no msg crudo). | W2 |
| `budget.test.ts` — `debit master KEY_NOT_FOUND en SELECT cold-path` | AC-2 (borde) | SELECT devuelve `error`/null → `{ success: false, error: 'KEY_NOT_FOUND' }` sin llamar al RPC. | W2 |
| `budget.test.ts` — `DAILY_LIMIT / INSUFFICIENT_BUDGET siguen devolviendo msg previo` | AC-5 | Regresión: el branch no-OWNERSHIP devuelve `error.message` como antes. | W2 |
| Estructural SQL (en `budget.test.ts` o test SQL existente, si el repo lo soporta) — `up contiene DROP de 3-param + CREATE de 4-param` | AC-3, CD-1 | Contar sentencias DDL completas (CD-7): 1 `DROP FUNCTION ... increment_a2a_key_spend(uuid, integer, numeric)` y 1 `CREATE OR REPLACE FUNCTION increment_a2a_key_spend(...numeric, text)`. | W2 |
| Estructural SQL — `los 3 PERFORM pasan p_owner_ref` | AC-3, CD-10 | El up contiene `PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref)` en los 3 RPCs y preserva `PERFORM debit_with_dest_policy(...)` en los branches con destino. | W2 |
| Estructural SQL — `down restaura firma 3-param + PERFORM 3-arg` | AC-4 | El down contiene `CREATE OR REPLACE FUNCTION increment_a2a_key_spend(uuid, integer, numeric)` y `PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd)` (3-arg) en los 3 RPCs. | W2 |
| Suite completa (cero regresión) | AC-5 | `npm test` verde, `tsc` 0, `biome` 0 en archivos tocados. | W3 |

> **Sobre tests E2E reales con DB**: si el repo tiene tests `*.real.test.ts` que
> ejercitan los RPCs contra Postgres (ej. `key-session-atomicity.real.test.ts`,
> `delegation-atomicity.real.test.ts`), el Dev DEBE verificar que llaman a
> `debit()`/RPCs con args correctos y que el guard owner válido no los rompe. Si
> alguno llama `increment_a2a_key_spend` directo con 3 args, actualizar a 4. (El
> Dev confirma con grep en F3; no se invocan en esta fase de F2.)

## 13. Estimación

- Archivos nuevos: 2 (up + down SQL).
- Archivos modificados: 2 (`budget.ts`, `budget.test.ts`).
- Tests nuevos: ~5-7.
- Líneas estimadas: ~200 SQL (up+down, mayormente cuerpos literales copiados) + ~30 TS + ~80 test.

---

## Readiness Check

```
[x] Cada AC tiene al menos 1 archivo asociado (§4.1 + §12 Test Plan)
[x] Cada archivo en §4.1 tiene Exemplar verificado con Read/Glob
[x] No hay [NEEDS CLARIFICATION] pendientes (DT-1 y DT-4 resueltos en §10)
[x] Constraint Directives incluyen >3 PROHIBIDO (CD-1,3,5,9,10,11 + obligatorios)
[x] Context Map tiene >2 archivos leídos (11 archivos + 3 auto-blindaje)
[x] Scope IN y OUT explícitos y no ambiguos (§6)
[x] BD: tablas/funciones verificadas que existen (§3 Estado de BD)
[x] Happy Path completo (§4.6)
[x] Flujo de error definido (§4.7, 3 casos)
[x] Lecciones de auto-blindaje histórico aplicadas como CD (§3.bis, CD-7/8/9)
[x] Dispatch de WKH-125b preservado (CD-10, asentado sobre firma 6-param)
```

Todos los checks PASS. SDD listo para gate SPEC_APPROVED.

---

*SDD generado por NexusAgil — Architect F2 — FULL*
