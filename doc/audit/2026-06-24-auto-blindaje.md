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
