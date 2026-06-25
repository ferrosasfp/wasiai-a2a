# Auto-Blindaje — Fix-pack auditoría 2026-06-24

Errores detectados durante la implementación del fix-pack y cómo se cerraron.
Origen: `doc/audit/2026-06-24-auditoria-profunda.md`.

### [2026-06-24] A1 — /compose no reembolsaba el step-0 pre-debitado en fallo
- **Error**: la rama `!result.success` de `src/routes/compose.ts` devolvía el
  error sin reembolsar el pre-débito del step-0 que cobró el middleware
  (`request.composeEstimatedCostUsd`, path a2a-key). El refund per-step del
  service es no-op para `i===0` (`compose.ts:142` guard `i > 0`). Cobro sin
  contraprestación; asimetría con `orchestrate.ts:644` que sí reembolsa.
- **Causa raíz**: el step-0 lo debita el middleware, no el service; ninguna capa
  cubría el reembolso del step-0 en el path compose.
- **Fix**: mirror exacto de `orchestrate.ts:644` — antes del `return reply.status`,
  `refundUsd = Math.max(0, composeEstimatedCostUsd - result.totalCostUsdc)`,
  best-effort (nunca cambia el status code ni tira). Reusa el destino canónico
  exacto del débito (`request.composeDestination`) vía `creditWithDest`; sin
  destino fiable cae a `credit` (sin dest-policy) para no romper el dest-cap.
- **Aplicar en**: cualquier ruta que pre-debite vía middleware y delegue la
  ejecución a un service (patrón orchestrate/compose). El destino del refund
  DEBE matchear el del débito (hallazgo M3) — nunca re-derivar uno nuevo.

### [2026-06-24] A3 — `Number(bal) <= 0` dejaba pasar un balance corrupto (NaN)
- **Error**: en `src/services/orchestrate.ts:283`, un `budget` JSONB no-numérico
  daba `NaN`, y `NaN <= 0 === false` → el early-fail "sin fondos" NO disparaba
  (un balance corrupto se trataba como con fondos).
- **Causa raíz**: comparación numérica sin guard de finitud sobre un valor que
  puede no ser numérico (proviene de JSONB).
- **Fix**: `const n = Number(bal); if (!Number.isFinite(n) || n <= 0) { ...fail... }`.
- **Aplicar en**: toda comparación `Number(x) <op> k` sobre valores que vienen de
  JSONB/strings externas — usar `Number.isFinite` antes de comparar.

### [2026-06-24] B11 — `vi.mock` duplicado dentro de función async
- **Error**: `src/services/kite-client.test.ts` tenía un `vi.mock('viem', ...)`
  duplicado dentro de `importKiteClient()` además del top-level — generaba un
  warning de vitest (vi.mock es hoisted; el inline es redundante).
- **Fix**: eliminado el `vi.mock` duplicado interno; se conserva el top-level.
- **Aplicar en**: `vi.mock` es hoisted al top del módulo — nunca duplicarlo dentro
  de funciones; el de top-level ya cubre todas las importaciones.

### [2026-06-24] M5 — tests existentes esperaban el leak del msg PG crudo
- **Error**: al sanitizar la ruta master de `debit()` a `DEBIT_FAILED`, dos tests
  (`budget.test.ts` AC-9 DAILY_LIMIT / INSUFFICIENT_BUDGET) fallaron porque
  asertaban el mensaje crudo de Postgres como `error` — exactamente el leak que
  M5 corrige.
- **Causa raíz**: la ruta master sólo mapeaba `OWNERSHIP_MISMATCH` y devolvía
  `error.message` para todo lo demás (incluidos códigos de negocio conocidos).
  Los tests congelaron ese comportamiento defectuoso.
- **Fix**: la ruta master ahora espeja el mapeo de la ruta dest-policy
  (INSUFFICIENT_BUDGET→AGENT_KEY_BUDGET_EXHAUSTED, DAILY_LIMIT, KEY_INACTIVE,
  KEY_NOT_FOUND) y sólo cae a `DEBIT_FAILED` (+ `console.error`) para PG errors
  inesperados. Los dos tests se actualizaron a los códigos estables.
- **Aplicar en**: cuando sanitizás un leak, revisá que los tests no estén
  congelando el comportamiento defectuoso — actualizalos al contrato correcto.

### [2026-06-24] B8 — `err as Record<string, unknown>` no compila sobre Error
- **Error**: al reemplazar el double-cast `as unknown as AppError`, intenté
  `(err as Record<string, unknown>)[key]` directo sobre un `Error` → TS2352
  (Error y Record no se solapan, falta index signature).
- **Causa raíz**: `Error` es un tipo nominal sin index signature; castear a
  `Record` directo lo rechaza el compilador (a diferencia de `object`).
- **Fix**: narrowing por `key in obj` con helpers tipados `(obj: object, ...)`;
  dentro del guard `(obj as Record<string, unknown>)[key]` SÍ es legal (object
  sí se solapa con Record). Sin `as unknown as`.
- **Aplicar en**: para leer props arbitrarias de un `Error`/clase nominal, usar
  `'k' in obj` + cast desde `object` (no desde el tipo nominal).

### [2026-06-24] B1 — `noImplicitOverride` exige `override` en `cause`
- **Error**: activar `noImplicitOverride` rompió `vm-runner.ts:92` — la propiedad
  `cause` de `TransformExecutionError` redeclara `Error.cause` sin `override`.
- **Fix**: `public override readonly cause?: unknown;`.
- **Aplicar en**: cualquier subclase de `Error` (u otra base) que redeclare un
  miembro de la base necesita el modificador `override` bajo este flag.

### [2026-06-24] B1 — `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` diferidos
- **Hallazgo**: `noUncheckedIndexedAccess` generó 232 errores (162×TS2532 acceso
  indexado, 43×TS18048, + mismatches en arrays de tests/adapters) y
  `exactOptionalPropertyTypes` generó 52 (mayormente TS2375 en adapters de pago).
  Ambos exceden el umbral seguro del wave y requieren cambios de tipos/lógica de
  riesgo no acotado.
- **Decisión**: REVERTIDOS. Quedaron activos sólo `noFallthroughCasesInSwitch` y
  `noImplicitOverride` (low-noise, 1 hit arreglado). Los otros dos quedan como
  deuda técnica para un wave dedicado con su propio SDD.
