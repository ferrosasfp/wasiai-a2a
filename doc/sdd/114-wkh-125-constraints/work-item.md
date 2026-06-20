# Work Item — [WKH-125] KEY-CONSTRAINTS: Constraints programables por destino y ventana de tiempo

## Resumen

Ampliar el modelo de constraints de la Agent Key (master + sessions) para incluir: (a) **cap de gasto acumulado por destino** (agente slug o registry), con ventana de tiempo configurable; (b) control de **ventana de tiempo arbitraria** para el daily ya existente. Hoy la key frena gasto total diario y por llamada, pero no puede limitar cuánto se gasta con un vendor/agente específico, ni con ventanas distintas al "día". Esto cierra el gap con el Kite Passport ("no gastar más de $50 con vendors aprobados") manteniendo la Agent Key cross-chain y agnóstica.

---

## Sizing

- SDD_MODE: full
- Estimación: **L** (no M — ver justificación)
- Branch sugerido: `feat/114-wkh-125-constraints`

**Por qué L y no M**: se necesitan 2 nuevas tablas (o 1 tabla + 1 de ledger), 1 nuevo RPC atómico que extiende el patrón `debit_delegation_and_parent`, modificaciones en los 3 puntos de débito (`increment_a2a_key_spend` / rutas session / rutas delegation), un nuevo servicio de políticas, extensión de tipos, y cobertura de tests de concurrencia. El núcleo del valor (atomicidad + tracking del acumulado por destino) tiene la misma complejidad que WKH-121 + WKH-101 combinados.

---

## Acceptance Criteria (EARS)

- **AC-1 (SET-POLICY)**: WHEN a key owner calls `PUT /auth/keys/me/spend-policies` with a valid `{ destination, max_usd, window }` payload and their `owner_ref`, the system SHALL persist the policy in `a2a_key_spend_policies` filtered by `owner_ref` and return 200 with the saved policy.

- **AC-2 (CAP-REJECT)**: WHEN a debit is requested for a destination (agent_slug + registry) that has an active spend policy AND the accumulated spend for that destination within the active window would exceed `max_usd`, the system SHALL reject the debit with error code `DEST_CAP_EXCEEDED` (HTTP 402) and SHALL NOT decrement the key's budget.

- **AC-3 (WINDOW-RESET)**: WHILE a spend policy has `window = "hourly"` or `window = "rolling_N_seconds"`, the system SHALL compute the accumulated spend only over debits timestamped within the active window (rolling, not calendar-reset), so that debits outside the window SHALL NOT count toward the cap.

- **AC-4 (ATOMIC-DEBIT)**: WHEN the system checks the destination cap and debits the parent budget, both operations SHALL execute within the same PostgreSQL transaction using `FOR UPDATE` on `a2a_key_spend_policies` + `a2a_agent_keys`, such that concurrent debits to the same destination SHALL serialize correctly and SHALL NOT produce a race condition that allows both to pass when only one should.

- **AC-5 (BACK-COMPAT)**: WHILE a key or session has NO spend policies defined, the system SHALL behave exactly as it does today (WKH-121/122/123/124 paths unchanged) — no new checks, no new errors, no performance regression on the hot-path.

- **AC-6 (SESSION-INHERIT)**: WHEN a key session is created, it SHALL optionally accept a `spend_policies` list that overrides (not merges) the parent key's spend policies for that session's lifetime; absent that list, the session SHALL apply the parent key's active policies.

- **AC-7 (OWNERSHIP-GUARD)**: WHEN any service reads or writes `a2a_key_spend_policies`, the query SHALL include `.eq('key_id', keyId).eq('owner_ref', ownerId)` with `ownerId: string` (non-optional), and SHALL throw `OwnershipMismatchError` if the row is not found under that owner.

---

## Scope IN

| Artefacto | Qué se toca |
|-----------|-------------|
| `supabase/migrations/20260606000000_a2a_key_spend_policies.sql` | Nueva tabla `a2a_key_spend_policies` + tabla de ledger `a2a_key_dest_spend_ledger` + RPC `debit_with_dest_policy` |
| `src/types/a2a-key.ts` | Interfaces `SpendPolicy`, `SpendPolicyWindow`, extensión de `CreateKeyInput` y `CreateKeySessionInput` |
| `src/services/spend-policy.ts` | Nuevo servicio: CRUD de políticas (set/get/delete), filtrado por owner_ref |
| `src/services/budget.ts` | Extensión del `debit()` master-key path para llamar al nuevo RPC cuando hay políticas activas |
| `src/services/key-session.ts` | Extensión de `debitSessionAndParent` para propagar destino al RPC |
| `src/routes/auth/` | `PUT /auth/keys/me/spend-policies` (set), `GET /auth/keys/me/spend-policies` (list) |
| `src/services/compose.ts` | Propagar `agent.slug` + `agent.registry` como `destination` al `budgetService.debit()` (solo en paths que ya conocen el agente) |
| `src/services/orchestrate.ts` | Ídem compose — propagar destino por step |
| `test/` | Tests unitarios de concurrencia + back-compat + window-reset |

---

## Scope OUT

- **No se tocan** las tablas `a2a_delegations` ni `a2a_key_sessions` directamente (la propagación del destino va por el `KeySessionDebitContext` / `DelegationDebitContext` como campo opcional).
- **No se implementa** cap por categoría (solo por agent_slug + registry en este MVP).
- **No se implementa** cap por chain (el cap es en USD cross-chain, igual que el daily).
- **No se implementa** ventana calendárica tipo "weekly reset cada lunes" — solo rolling window en segundos y `total` (acumulado de por vida de la key/sesión).
- **No se agrega UI** de gestión de políticas en el dashboard (es API-only en este MVP).
- **No se migran** policies a las delegations EIP-712 (DelegationPolicy ya tiene su propio modelo con `allowed_agent_slugs`; los spend-policies son adicionales sobre master/session, no sobre delegations en este MVP).
- **No se implementa** el RLS real a nivel Postgres para `a2a_key_spend_policies` (sigue siendo app-layer ownership guard, consistente con la deuda técnica WKH-SEC-02).

---

## Modelo de datos propuesto (DT)

### DT-1: Tabla `a2a_key_spend_policies`

```
a2a_key_spend_policies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id      UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE,
  owner_ref   TEXT NOT NULL,          -- Ownership Guard app-layer (CD-1)
  destination TEXT NOT NULL,          -- "<registry>/<agent_slug>" o "<agent_slug>" (sin registry)
  max_usd     NUMERIC(18,6) NOT NULL, -- cap acumulado para la ventana
  window_type TEXT NOT NULL,          -- 'total' | 'rolling'
  window_secs INT,                    -- NULL si window_type='total'; N segundos si 'rolling'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (key_id, destination)        -- solo 1 política por destino por key
)
```

**Justificación**: JSONB en la key (`spend_limits` in-column) fue descartado porque (a) el ledger de acumulado no puede vivir en la misma fila sin race conditions (la fila de la key ya tiene `daily_spent_usd` y el lock es sobre `a2a_agent_keys`), y (b) un JOIN en la migración existente llevaría a conflictos con el RPC `increment_a2a_key_spend`. Una tabla separada es más limpia y permite índice por `(key_id, destination)`.

**Supuesto marcado**: el `destination` como `"<registry>/<agent_slug>"` o `"<agent_slug>"` (snake-case) es el formato más directo dado que `agent.registry` y `agent.slug` ya están disponibles en `compose.ts` line ~85. Si el humano prefiere UUIDs de agente como destino, [NEEDS CLARIFICATION] — se usa el slug string por ahora (MVP conservador).

### DT-2: Tabla `a2a_key_dest_spend_ledger`

```
a2a_key_dest_spend_ledger (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id      UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE,
  owner_ref   TEXT NOT NULL,
  destination TEXT NOT NULL,
  amount_usd  NUMERIC(18,6) NOT NULL,
  debited_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)
-- Índice hot-path: (key_id, destination, debited_at)
CREATE INDEX ON a2a_key_dest_spend_ledger (key_id, destination, debited_at);
```

**Para el check de ventana rolling**: el RPC hace `SUM(amount_usd) WHERE key_id = $1 AND destination = $2 AND debited_at >= now() - (window_secs * interval '1 second')`. Para `window_type='total'` suma todo sin filtro de tiempo.

**Purga/TTL**: los registros del ledger que ya no impactan ninguna ventana activa son basura. Dejar para una tarea de mantenimiento futura (housekeeping job). En este MVP el ledger crece. [NEEDS CLARIFICATION] si hay requisito de tamaño máximo — por ahora sin purga (conservador).

### DT-3: RPC `debit_with_dest_policy`

```sql
debit_with_dest_policy(
  p_key_id     UUID,
  p_chain_id   INT,
  p_amount_usd NUMERIC,
  p_destination TEXT  -- "<registry>/<slug>" o "" si no se conoce
) RETURNS void
```

Secuencia dentro de la transacción:
1. `FOR UPDATE` en `a2a_agent_keys` (igual que hoy en `increment_a2a_key_spend`).
2. Si `p_destination != ''`: buscar política activa en `a2a_key_spend_policies` para `(key_id, destination)` — `SELECT FOR UPDATE`.
3. Si hay política: sumar acumulado del ledger en la ventana activa (`SUM`). Chequear que `acumulado + p_amount_usd <= max_usd`. Si excede: `RAISE EXCEPTION 'DEST_CAP_EXCEEDED: ...'`.
4. Ejecutar el check y debit existente (daily_limit, chain_budget, balance debit — lógica de `increment_a2a_key_spend`).
5. Si política existe: insertar fila en `a2a_key_dest_spend_ledger`.
6. Commit (implícito).

**Atomicidad**: el `FOR UPDATE` en ambas tablas (policy + key) más el INSERT en el ledger todo en la misma transacción garantiza que dos llamadas concurrentes al mismo destino NO pueden ambas pasar el check simultáneamente (serialización via lock).

### DT-4: Ventanas soportadas en el MVP

| `window_type` | `window_secs` | Semántica |
|---|---|---|
| `total` | NULL | Cap de por vida de la key/sesión (nunca resetea) |
| `rolling` | N > 0 | Rolling window: SUM debits en los últimos N segundos |

**Decidido MVP**: no se agrega `daily` ni `hourly` como valores discretos — `rolling` con `window_secs=3600` es hourly, con `window_secs=604800` es weekly. El `daily` existente (`daily_limit_usd`) no se toca.

### DT-5: Propagación del destino en el debit path

- En `compose.ts` (línea ~159): el agent slug y registry YA están disponibles como `agent.slug` / `agent.registry`. Se añade `destination: \`${agent.registry}/${agent.slug}\`` al call de `budgetService.debit()`.
- El `budgetService.debit()` recibe un optional `destination?: string`. Si es falsy o la key no tiene políticas, se llama a `increment_a2a_key_spend` como hoy (back-compat). Si hay `destination` y la key tiene políticas, se llama a `debit_with_dest_policy`.
- **Lección de WKH-124**: NO ampliar la firma central de `budgetService.debit()` rompiendo los 3 call-sites — el `destination` va como campo opcional al final de la firma para que los call-sites sin `destination` (orchestrate step 0 pre-handler en routes) lo omitan y sigan usando el path actual.

---

## Constraint Directives (CD)

- **CD-1 (ATOMICIDAD)**: el check del cap por destino + el INSERT en el ledger + el debit del balance de la key DEBEN ocurrir en la misma transacción PostgreSQL (mismo RPC, `FOR UPDATE` en ambas tablas). PROHIBIDO chequear en app-layer y debit en RPC separado (race condition).

- **CD-2 (BACK-COMPAT)**: PROHIBIDO modificar la firma o el comportamiento de `increment_a2a_key_spend`. El nuevo RPC `debit_with_dest_policy` es aditivo; el path master sin políticas activas DEBE seguir usando `increment_a2a_key_spend` exactamente igual que hoy.

- **CD-3 (OWNERSHIP)**: OBLIGATORIO que todo acceso a `a2a_key_spend_policies` y `a2a_key_dest_spend_ledger` filtre por `key_id` + `owner_ref` (ownerId: string, no-optional). Misma convención que WKH-53 (CLAUDE.md — Security Conventions sección).

- **CD-4 (NO ROMPER WKH-121..124)**: PROHIBIDO modificar las firmas de `debitSessionAndParent`, `debitDelegationAndParent`, `KeySessionDebitContext`, `DelegationDebitContext` de forma que rompa los call-sites existentes. La propagación del destino va como campo OPCIONAL en los contexts (o como parámetro adicional al final).

- **CD-5 (NULL = SIN RESTRICCION)**: una key sin ninguna fila en `a2a_key_spend_policies` DEBE pasar el debit exactamente igual que hoy. Ningún nuevo check debe ejecutarse si no hay políticas.

- **CD-6 (NO ETHERS / TS-STRICT)**: sin `any` explícito en los nuevos tipos. Las interfaces de `SpendPolicy` deben ser tipadas completamente.

---

## Decisiones técnicas (DT)

- **DT-6 (Tabla separada vs JSONB en-key)**: se elige tabla separada (`a2a_key_spend_policies`) porque el tracking del acumulado (ledger) no puede vivir en la fila de la key sin exacerbar las contenciones del lock existente. JSONB en-key fue descartado.

- **DT-7 (Ledger vs columna de acumulado en-policy)**: se elige ledger de debits (`a2a_key_dest_spend_ledger`) en lugar de una columna `accumulated_usd` en `a2a_key_spend_policies`, porque el rolling window necesita filtrar por `debited_at`. Una columna acumulada solo funciona para `total`; el ledger sirve para ambos.

- **DT-8 (Destination key como string)**: el destino se identifica como `"<registry>/<agent_slug>"` (string). Esto es consistente con los campos `agent.registry` y `agent.slug` ya disponibles en compose/orchestrate. El formato exacto se normaliza en `spend-policy.ts` (trim + lowercase) para comparabilidad.

- **DT-9 (Session + delegation inherit)**: sessions heredan las políticas de la parent key por defecto (AC-6). Las delegations (WKH-101, EIP-712) tienen su propio modelo de `allowed_agent_slugs` en `DelegationPolicy` y no se extienden en este MVP.

- **DT-10 (Purga del ledger)**: sin purga automática en el MVP. El ledger crece ilimitadamente. Si esto es un problema, se traquea como deuda técnica post-MVP.

---

## Missing Inputs

- [SUPUESTO] `destination` como `"registry/slug"` string (no UUID). Si el humano prefiere UUID de agente como destino, requiere ajuste en DT-8. [NEEDS CLARIFICATION → conservador: usar slug]
- [SUPUESTO] La `window_type='rolling'` con suma en el RPC es aceptable en latencia (un SELECT SUM sobre el ledger con índice en `(key_id, destination, debited_at)`). Si el ledger crece mucho, puede degradar. Mitigación futura: particionado o purga. [resuelto en F2 si aplica]
- [SUPUESTO] Las session keys heredan pero pueden sobrescribir las spend-policies de la parent key (AC-6). El mecanismo exacto (lista en `CreateKeySessionInput` vs referencia a un policy-set) se define en F2.
- [BLOQUEANTE-0] No hay bloqueantes — toda la información está disponible para empezar el SDD.

---

## Análisis de paralelismo

- WKH-125 es la **última HU de E16** (épica "Agent Key mejor que Kite Passport"). WKH-121/122/123/124 están DONE. No hay dependencias circulares.
- Este work item NO bloquea ninguna otra HU conocida.
- Puede correr en paralelo con cualquier trabajo fuera de la épica E16 que no toque `src/services/budget.ts` (WKH-121..124 ya están mergeadas; no hay solapamiento activo).
- La migración `20260606000000` es segura (tablas nuevas, no altera existentes).
