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

### [2026-07-03 17:15] FIX-PACK (AR) BLQ-ALTO-1 — `priceUsdc` sin validar en el write-boundary (money-path)
- **Error**: `POST /agents` y `PATCH /agents/:slug` aceptaban cualquier `number`
  como `priceUsdc` (incl. negativo). Un agente publicado con `priceUsdc: -1000`
  terminaba inflando el budget prepago del caller vía `/compose` +
  `increment_a2a_key_spend`. Además `mapRowToAgent`/`mapRowToRecord` sólo hacían
  `typeof === 'number' ? v : 0`, sin clampear negativos/no-finitos ya en DB.
- **Causa raíz**: el precio es money-path pero se trataba como campo cosmético.
  El único safeguard (`parsePriceSafe`) vivía en `discovery.ts` (path registries)
  y no se reusaba en el path self-published.
- **Fix**:
  1. Write-boundary (rechazo → 422): `isValidPriceUsdc` en `routes/agents.ts`
     (POST y PATCH) + `assertValidPriceUsdc` como defense-in-depth en el service
     (`publish`/`update`). Sólo se acepta `number` finito `>= 0`.
  2. Read-boundary (clamp): se movió `parsePriceSafe` a `lib/price.ts` (helper
     puro, sin ciclo de imports con `services/agent.ts`), re-exportado desde
     `discovery.ts` para no romper imports existentes. `mapRowToAgent` y
     `mapRowToRecord` ahora enrutan `row.price_usdc` por `parsePriceSafe` →
     cualquier negativo/no-finito ya persistido se clampea a 0.
- **Aplicar en**: TODO campo money-path (precio, budget, montos) debe validarse
  en el write-boundary (rechazo explícito) Y clamparse en el read-boundary
  (defensa para datos legacy). Reusar el mismo safeguard, no clones paralelos.

### FOLLOW-UP (fuera de scope WKH-134) — guard profundo en el RPC de débito
- El fix de esta HU blinda el write/read-boundary de `a2a_agents`. NO toca el RPC
  `increment_a2a_key_spend` ni `compose.isInvalid`. Un guard profundo que rechace
  un `amount`/precio negativo o no-finito EN el punto de débito (defensa final,
  independiente de cómo llegó el precio) queda como **follow-up de seguridad
  SEPARADO**. Trackearlo como TD/HU propia (money-invariant en el settlement),
  fuera de esta branch.

### [2026-07-03 17:16] FIX-PACK (AR) MNR-1 / MNR-2 — validación de `capabilities` y `name` en PATCH
- **Error**: PATCH no validaba `capabilities` (podía setear `[]` o `"x"`); POST
  no filtraba elementos no-string; PATCH de `name` no aplicaba los guards de
  whitespace de `publish`.
- **Fix**: `stringCapabilities` filtra a strings en POST (línea de input) y valida
  `length >= 1` en POST/PATCH (422 en PATCH, 400 missing en POST). `sanitizeCapabilities`
  en el service (publish/update). `assertValidName` reusa los guards de whitespace
  en `update`. Documentado: el `slug` es PK INMUTABLE → PATCH de `name` NO
  re-deriva el slug; `name` y `slug` pueden divergir tras un PATCH (elegido por
  simplicidad/honestidad, sin rechazar el cambio de name).
- **Aplicar en**: PATCH parcial debe reusar EXACTAMENTE los mismos guards que el
  create; no asumir que "es sólo un update" exime de validar.
