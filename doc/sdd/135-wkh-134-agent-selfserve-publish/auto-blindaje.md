# Auto-Blindaje — WKH-134 (self-serve publish)

Registro de errores cometidos durante la implementación F3 y cómo se corrigieron.
Objetivo: que futuras HUs no repitan el mismo tropiezo.

### [2026-07-03 16:57] W2 — `exactOptionalPropertyTypes` rechaza `undefined` explícito
- **Error**: `tsc` TS2379 en `agents.ts` al construir `PublishAgentInput` con
  `description: cond ? x : undefined` — el tsconfig tiene
  `exactOptionalPropertyTypes: true`, que NO acepta asignar `undefined` explícito
  a una propiedad opcional (`description?: string`).
- **Causa raíz**: asumí que `field?: T` equivale a `field: T | undefined`. Con
  `exactOptionalPropertyTypes` NO lo es: la propiedad debe estar AUSENTE, no ser
  `undefined`.
- **Fix**: construir el objeto con los campos requeridos y agregar los opcionales
  SOLO cuando están presentes (`if (typeof body.x === 'string') input.x = body.x`).
- **Aplicar en**: cualquier construcción de un objeto tipado con props opcionales
  a partir de un body HTTP (routes). Nunca `x: cond ? v : undefined`; usar
  asignación condicional.

### [2026-07-03 16:59] W2 — merge en `discover()` rompe un test que stubea `fetch` global
- **Error**: `discovery.ssrf.test.ts` T-DISC-03 pasó de 1 a 0 agentes tras agregar
  `await publishedAgentService.listAsAgents()` en `discover()`. El SELECT real de
  supabase (PostgREST) usa el `fetch` global stubeado por el test y consumía el
  único `mockResolvedValueOnce`, dejando sin respuesta el fetch del registry.
- **Causa raíz**: `discover()` ganó una nueva dependencia de servicio
  (`publishedAgentService`) que toca supabase; los tests que stubean `fetch` sin
  mockear esa dependencia terminan enrutando la llamada de supabase al stub.
- **Fix**: `vi.mock('./agent.js', ...)` en `discovery.ssrf.test.ts` devolviendo
  `listAsAgents → []` / `getBySlugAsAgent → null`. Es EXACTAMENTE el patrón que
  WKH-100 (identity) y WKH-103 (reputation) ya aplicaron en ese mismo archivo
  cuando agregaron sus dependencias a `discover()` (ver comentarios L38-54).
- **Aplicar en**: cualquier nueva dependencia de servicio agregada a
  `discover()`/`getAgent()` debe mockearse en TODOS los tests de discovery que
  stubean `fetch`/supabase, o el conteo de fetches se desincroniza.
