# Work Item — [WKH-142] Defensa en profundidad: guard de importe negativo en el money-path

## Resumen
Follow-up de seguridad de WKH-134 (self-serve publish). WKH-134 cerró el path
EXPUESTO (validación en el write-boundary de `POST/PATCH /agents` + clamp en el
read-boundary de `mapRowToAgent`/`mapRowToRecord`), pero dejó pendiente la
defensa FINAL en el punto de débito mismo: hoy nada impide que un
`p_amount_usd`/`priceUsdc` negativo llegue al RPC de débito y, en vez de
restar, SUME al budget prepago del caller (`new_bal = current − (−X)`). Esta HU
cierra los 3 puntos identificados por el AR de WKH-134 en el choke-point único
del money-path (`increment_a2a_key_spend`), en `compose.isInvalid`, y a nivel
DB (`CHECK price_usdc >= 0`).

## Sizing
- SDD_MODE: full
- Estimación: S
- Branch sugerido: `fix/143-wkh-142-negative-amount-guard`

## F0 — Grounding (estado real verificado contra código, 2026-07-04)

1. **RPC `increment_a2a_key_spend`** (`supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc.sql:20-93`):
   NO valida `p_amount_usd >= 0`. Con `p_amount_usd` negativo:
   `v_current_bal < p_amount_usd` (L77) es `false` (cualquier balance ≥ un
   número negativo) → pasa el check de fondos insuficientes → `v_new_bal :=
   v_current_bal - p_amount_usd` (L83) **suma** el valor absoluto al budget.
   El `daily_limit` check (L68) también queda neutralizado (siempre `false`
   con amount negativo).
   **Choke-point confirmado**: los otros 3 RPCs de débito (`debit_with_dest_policy`
   L108-174, `debit_session_and_parent` L189-245, `debit_delegation_and_parent`
   L260-318) **todos** terminan haciendo `PERFORM increment_a2a_key_spend(...)`
   internamente (L167, L238, L311) — un guard único en `increment_a2a_key_spend`
   cierra las 4 rutas de débito sin duplicar lógica.
   Confirmado también que `refund_a2a_key_spend` (función DISTINTA,
   `20260623000000_wkh127_refund_a2a_key_spend.sql:38-40`) ya es defensiva
   (`IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN RETURN;`) — **ningún
   caller legítimo pasa negativos a `increment_a2a_key_spend`**; el guard no
   rompe ningún flujo existente.

2. **`compose.isInvalid`** (`src/services/compose.ts:207-210`):
   ```ts
   const isInvalid =
     typeof agent.priceUsdc !== 'number' ||
     agent.priceUsdc === 0 ||
     Number.isNaN(agent.priceUsdc);
   ```
   Confirmado: solo cubre no-number / cero / NaN. Un `agent.priceUsdc < 0` pasa
   como "válido" y se propaga tal cual a `budgetService.debit` (L217-218,
   `debitAmount = (isInvalid ? PLACEHOLDER_FEE_USD : agent.priceUsdc) +
   stepGasOverhead`).

3. **`CHECK price_usdc >= 0`**: tabla `a2a_agents`
   (`supabase/migrations/20260703000000_wkh134_a2a_agents.sql:20-31`) tiene
   `price_usdc NUMERIC NOT NULL DEFAULT 0` **sin CHECK constraint** — la única
   defensa hoy es el write-boundary de `routes/agents.ts` (app-layer,
   bypasseable si algo escribe directo a la tabla, ej. script admin, futuro
   endpoint, o bug de service).
   **Auditoría de otras tablas de precio** (Scope OUT explícito, ver abajo):
   - `registries`: NO almacena precio localmente — el precio de agentes de
     marketplace se lee vía mapping externo (`schema.discovery.agentMapping.price`,
     `20260401000000_kite_registries.sql:57`) y se clampea en runtime con
     `parsePriceSafe` (discovery.ts). No aplica CHECK de DB acá.
   - `a2a_agent_keys`: el `budget` es `JSONB` (mapa `{chain_id: monto}`, no una
     columna NUMERIC) — un CHECK constraint SQL simple no puede validar valores
     dentro de un JSONB sin una función/trigger dedicado. Las columnas NUMERIC
     de límites (`daily_limit_usd`, `max_spend_per_call_usd`) SÍ podrían tener
     `CHECK (... >= 0)`, pero son configuradas por el propio owner (no por un
     tercero/atacante) — menor prioridad, **fuera de esta HU** (ver Missing
     Inputs).

## Acceptance Criteria (EARS)

- AC-1: WHEN `increment_a2a_key_spend` es invocada con `p_amount_usd < 0` (o
  `NULL`, o `NaN`), the system SHALL abortar con `RAISE EXCEPTION
  'INVALID_AMOUNT: ...'` ANTES de tocar `budget`/`daily_spent_usd`, sin aplicar
  ningún cambio a la fila.
- AC-2: WHEN cualquiera de los otros 3 RPCs de débito (`debit_with_dest_policy`,
  `debit_session_and_parent`, `debit_delegation_and_parent`) recibe un
  `p_amount_usd` negativo, the system SHALL rechazarlo con el mismo código
  `INVALID_AMOUNT` (heredado del `PERFORM increment_a2a_key_spend` interno —
  sin re-implementar el guard 4 veces).
- AC-3: WHEN `compose.ts` evalúa `isInvalid` para el débito per-step (steps
  2..N), the system SHALL tratar `agent.priceUsdc < 0` como inválido (mismo
  fallback `PLACEHOLDER_FEE_USD` que hoy aplica a NaN/0/no-number) — nunca debe
  propagarse un monto negativo a `budgetService.debit`.
- AC-4: WHEN se aplica la migración del `CHECK (price_usdc >= 0)` sobre
  `a2a_agents`, the system SHALL primero clampear a 0 cualquier fila existente
  con `price_usdc < 0` (`UPDATE ... SET price_usdc = 0 WHERE price_usdc < 0`)
  para que el `ADD CONSTRAINT` no falle contra datos ya persistidos en prod.
- AC-5: IF un INSERT/UPDATE directo sobre `a2a_agents` (bypasseando el
  write-boundary de `routes/agents.ts`) intenta persistir `price_usdc < 0`,
  THEN the system SHALL rechazarlo a nivel Postgres vía el CHECK constraint
  (violación `23514`), sin depender exclusivamente de la validación app-layer.

## Scope IN
- `supabase/migrations/<timestamp>_wkh142_negative_amount_guard.sql` (+ `_down.sql`):
  - `CREATE OR REPLACE FUNCTION increment_a2a_key_spend(...)` (misma firma de 4
    params, cuerpo copiado literal + el guard nuevo) con
    `IF p_amount_usd IS NULL OR p_amount_usd < 0 OR p_amount_usd = 'NaN'::numeric
    THEN RAISE EXCEPTION 'INVALID_AMOUNT: p_amount_usd % must be >= 0', p_amount_usd;
    END IF;` insertado DESPUÉS del ownership guard (línea 47-49 actual) y ANTES
    del check de `is_active`.
  - `UPDATE a2a_agents SET price_usdc = 0 WHERE price_usdc < 0;` seguido de
    `ALTER TABLE a2a_agents ADD CONSTRAINT a2a_agents_price_usdc_nonneg CHECK
    (price_usdc >= 0);`.
  - Down migration: drop del constraint + revert de la función a la firma sin
    el guard (mismo patrón de los `_down.sql` hermanos).
- `src/services/compose.ts:207-210` (`isInvalid` en el branch de débito per-step):
  agregar `|| agent.priceUsdc < 0` a la condición.
- Tests unitarios/integración que cubran: RPC rechaza negativo (los 4 callers),
  `compose.isInvalid` rechaza negativo, constraint DB rechaza INSERT directo.

## Scope OUT
- CHECK constraints sobre `a2a_agent_keys` (`daily_limit_usd`,
  `max_spend_per_call_usd`) — configurados por el propio owner, menor riesgo,
  follow-up separado si se decide.
- Cualquier cambio a `registries` (no almacena precio localmente).
- Cambios al modelo de `budget` JSONB de `a2a_agent_keys` (requeriría
  trigger/función dedicada, no un CHECK simple) — fuera de esta HU.
- Reescritura de `parsePriceSafe`/read-boundary de `a2a_agents` (ya cerrado en
  WKH-134, no se toca).

## Decisiones técnicas (DT-N)
- DT-1: el guard de monto se agrega **solo en `increment_a2a_key_spend`**
  (choke-point único) en vez de duplicarlo en los 4 RPCs — todos los débitos
  atraviesan esa función vía `PERFORM` (confirmado en F0). Menor superficie de
  mantenimiento, consistente con el patrón `CD-1` de la migración WKH-SEC-02b
  ("DROP de la firma ANTES del CREATE de 4 params — una sola función").
- DT-2: `CREATE OR REPLACE` sin `DROP FUNCTION` previo — la firma de 4 params
  (`uuid, integer, numeric, text`) no cambia de aridad, solo se agrega una
  validación al cuerpo. No aplica el gotcha de sobrecarga de WKH-SEC-02b (ese
  fue por CAMBIO de aridad 3→4 params; acá la aridad queda igual).
- DT-3: el guard rechaza explícitamente `'NaN'::numeric` — Postgres `NUMERIC`
  SÍ admite el valor especial `NaN` (a diferencia de `INTEGER`), y
  `NaN < 0` evalúa `false` en Postgres → sin este chequeo explícito, un
  `p_amount_usd = NaN` se colaría por el `< 0` solo.
- DT-4: la migración del CHECK incluye el `UPDATE` de clamp de datos existentes
  ANTES del `ALTER TABLE ... ADD CONSTRAINT` en la MISMA migración (no en un
  paso manual separado) — reproducible en cualquier entorno (dev/staging/prod)
  sin depender de que un humano corra un script antes.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO modificar la firma (aridad) de `increment_a2a_key_spend` —
  solo agregar el guard al cuerpo existente (copiar literal + insertar el IF).
- CD-2: PROHIBIDO tocar `refund_a2a_key_spend` / `refund_with_dest_policy` /
  `refund_delegation_and_parent` / `refund_session_and_parent` — esas ya son
  defensivas (`<= 0` → no-op) y están fuera de scope (son la ruta de CRÉDITO,
  no de débito).
- CD-3: OBLIGATORIO que el `ALTER TABLE ADD CONSTRAINT` esté precedido, en la
  MISMA transacción/migración, por el `UPDATE` de clamp — nunca asumir "no hay
  filas negativas hoy" sin el clamp defensivo.
- CD-4: OBLIGATORIO seguir el patrón de hardening de RPCs hermanas
  (`search_path`, `REVOKE ... FROM PUBLIC, anon, authenticated`, `GRANT ...
  TO service_role`) si la migración recrea la función — no perder el
  hardening existente al hacer `CREATE OR REPLACE`.
- CD-5: PROHIBIDO usar `Number.isNaN` en el fix de `compose.isInvalid` como
  único cambio — el fix debe ser explícitamente `agent.priceUsdc < 0` (NaN ya
  está cubierto por el check existente).

## Missing Inputs
- [resuelto en F2] Mensaje de error exacto del `RAISE EXCEPTION` (`INVALID_AMOUNT`
  vs otro código) — el Architect decide el código estable siguiendo el patrón
  `KEY_NOT_FOUND` / `OWNERSHIP_MISMATCH` / `INSUFFICIENT_BUDGET` ya usados, y
  cómo lo mapea `budgetService.debit`/`credit*` (hoy ningún branch de esos
  switches conoce `INVALID_AMOUNT` — hay que agregar el mapeo a un error_code
  estable, ej. `DEBIT_INVALID_AMOUNT`, en vez de caer al fallback genérico
  `DEBIT_FAILED`).
- [NEEDS CLARIFICATION] ¿Se quiere, como follow-up SEPARADO, agregar
  `CHECK (... >= 0)` a `daily_limit_usd` / `max_spend_per_call_usd` de
  `a2a_agent_keys`? No es parte del scope de WKH-142 (Jira solo menciona
  `price_usdc`), pero quedó identificado en la auditoría F0. NO bloqueante para
  esta HU.

## Riesgos
- **Riesgo migración (ALTO, mitigado por DT-4/CD-3)**: la tabla `a2a_agents`
  es nueva (creada 2026-07-03, misma fecha que el fix de write-boundary de
  WKH-134) — el riesgo de filas negativas preexistentes en prod (caldz) es
  BAJO pero no cero (la tabla estuvo unos minutos sin el guard de
  `isValidPriceUsdc` durante el desarrollo de WKH-134 mismo, antes del
  fix-pack BLQ-1). El `UPDATE ... WHERE price_usdc < 0` ANTES del
  `ADD CONSTRAINT` en la misma migración neutraliza esto sin necesitar
  verificación manual previa — la migración es auto-suficiente y reproducible.
- **Riesgo cambio de RPC en prod (MEDIO)**: `increment_a2a_key_spend` es el
  choke-point de TODO el money-path (debit maestro + dest-policy + session +
  delegation). Un error en el `CREATE OR REPLACE` rompería TODOS los débitos,
  no solo el guard nuevo. Mitigación: DT-2 (mismo cuerpo literal + un solo IF
  agregado, sin tocar el resto de la lógica) + tests de regresión sobre los 4
  callers antes de mergear (Scope IN).
- **Riesgo de falsos positivos (BAJO)**: `p_amount_usd = 0` sigue siendo
  válido para `increment_a2a_key_spend` (débitos de costo cero legítimos, ej.
  `PLACEHOLDER_FEE_USD` podría ser 0 en algún flujo) — el guard nuevo es
  estrictamente `< 0` (o NaN/NULL), no `<= 0`, para no romper ese caso.

## Análisis de paralelismo
- No bloquea ni depende de HUs actualmente `in progress` (WKH-141, fila 142 del
  `_INDEX.md`, está en F1 esperando `HU_APPROVED` — feature no-relacionada,
  distinto área). Puede correr en paralelo sin conflicto de archivos: WKH-142
  toca `supabase/migrations/*`, `src/services/compose.ts` (líneas 207-210 —
  zona acotada), y `src/services/budget.ts` (mapeo de error code, si aplica).
  Ningún archivo compartido con WKH-141 (`src/services/interop/*` presumible,
  fuera de este repo grounding).
- Bloquea/recomienda cerrarse ANTES de cualquier HU futura que añada un nuevo
  caller de `increment_a2a_key_spend` (ese caller heredará el guard gratis, sin
  trabajo extra) — no hay ninguna en curso hoy.
