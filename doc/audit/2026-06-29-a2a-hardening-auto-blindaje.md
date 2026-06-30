# Auto-Blindaje — fix/audit-a2a-hardening (2026-06-29)

Errores cometidos durante la implementación de las remediaciones de auditoría y
cómo se corrigieron, para blindar futuras HUs.

### [2026-06-29] H-1 — `ssrfFetch` rompió tests que mockean solo `validateRegistryUrl`
- **Error**: al introducir la re-validación per-hop en `ssrfFetch`
  (`validateOutboundUrl`), los tests que hacían `vi.mock('../lib/url-validator.js')`
  exponiendo SOLO `validateRegistryUrl` dejaban `validateOutboundUrl` como
  `undefined` → toda llamada outbound tiraba `TypeError`.
- **Causa raíz**: el mock parcial del módulo no cubría la nueva superficie que
  `ssrf-dispatcher.ts` importa (`validateOutboundUrl`, `isBlockedAddress`).
- **Fix**: completar el mock con `validateOutboundUrl` (→ `{ ok: true, ... }`) e
  `isBlockedAddress` (→ `false`) en `erc8004-identity-bridge.e2e.test.ts`.
- **Aplicar en**: cualquier test que mockee `lib/url-validator.js` y ejecute un
  flujo que pase por `ssrfFetch` (compose downstream, discovery, MCP tools).

### [2026-06-29] H-1 — doble resolución DNS agotaba los mocks `mockResolvedValueOnce`
- **Error**: `compose.ssrf` / `discovery.ssrf` resolvían el host UNA vez con
  `validateRegistryUrl` (pre-fetch ya existente) y AHORA otra vez dentro de
  `ssrfFetch` (`validateOutboundUrl`). Los mocks `mockResolvedValueOnce`
  alimentaban solo la primera; la segunda recibía `undefined` → "addresses is
  not iterable" o registries válidos caídos.
- **Causa raíz**: el contador `Once` asumía 1 lookup por fetch; H-1 introduce 2.
- **Fix**: usar `mockResolvedValue` persistente o `mockImplementation`
  hostname-aware en los happy-paths (los block-paths siguen con `Once` porque
  cortan antes del segundo lookup).
- **Aplicar en**: tests de SSRF con mock de `node:dns` que esperen que un fetch
  llegue a ejecutarse.

### [2026-06-29] H-1 — `response.headers.get` sobre fakes de fetch sin `.headers`
- **Error**: el loop de redirects leía `response.headers.get('location')`;
  varios tests devuelven fakes `{ ok, status, json }` sin `.headers` → crash.
- **Causa raíz**: se asumió que todo response tiene `.headers` (cierto para
  undici real, falso para los fakes de test).
- **Fix**: leer `location` solo cuando es 3xx Y `typeof response.headers?.get
  === 'function'` (fail-safe; no debilita el caso real undici).
- **Aplicar en**: cualquier wrapper de fetch que inspeccione headers de la
  respuesta debe tolerar fakes mínimos en tests.

### [2026-06-29] F-04 — assertions de `debit()` con aridad exacta (3/6 args)
- **Error**: agregar el 7º arg `ownerRef` rompió ~30 `toHaveBeenCalledWith`
  que fijaban la aridad exacta de `budgetService.debit`.
- **Causa raíz**: `toHaveBeenCalledWith` exige match de aridad; el nuevo arg
  posicional invalida los matchers de 3/6 args.
- **Fix**: actualizar cada assertion al nuevo shape (7 args), con el
  `owner_ref` real de cada keyRow de test. Las `.not.toHaveBeenCalledWith` de
  menor aridad se dejaron (siguen siendo negativos correctos).
- **Aplicar en**: cambios de firma de servicios muy testeados → buscar TODOS los
  `toHaveBeenCalledWith` antes de dar por cerrado.

### [2026-06-29] F-05 — un test fijaba el leak crudo como comportamiento esperado
- **Error**: `registries.ownership.test.ts` T-OWN-10 afirmaba que `err.message`
  crudo (`'database down'`) llegaba al cliente.
- **Causa raíz**: el test codificaba el bug (leak) como contrato.
- **Fix**: actualizar la assertion al mensaje estático del fix y agregar un
  `not.toContain('database down')` que blinda contra regresión del leak.
