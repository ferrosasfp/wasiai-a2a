# Auto-Blindaje — WKH-100 (ERC-8004 Identity Binding, Fase 1)

### [2026-05-31] Wave 4 — Nuevo named export rompe mocks de tests existentes
- **Error**: tras agregar `import { isIdentityVerified }` en `src/routes/auth.ts`
  y `src/middleware/a2a-key.ts`, 46 tests existentes (`auth.test.ts`,
  `a2a-key.test.ts`) empezaron a devolver 500 (TypeError: `isIdentityVerified is
  not a function`).
- **Causa raíz**: esos test files mockean `../services/identity.js` con un factory
  manual (`vi.mock(..., () => ({ identityService: {...} }))`) que NO exportaba el
  nuevo named export. Al consumir el módulo mockeado, `isIdentityVerified` era
  `undefined`.
- **Fix**: agregar `isIdentityVerified` (impl derivada `row?.erc8004_identity != null`)
  al factory de mock de ambos test files, + `bindErc8004Identity`/
  `resolveIdentityForSlug` en el mock de `identityService` en `auth.test.ts`.
- **Aplicar en**: cualquier HU que agregue un NUEVO named export a un módulo que
  ya tenga mocks con factory manual (`vi.mock(path, () => ({...}))`). Esos mocks
  reemplazan el módulo entero → hay que reflejar TODOS los exports consumidos por
  el código bajo test. Grep `vi.mock('<modulo>'` antes de agregar exports nuevos.

### [2026-05-31] FIX-PACK BLQ-MED-1 — renombrar export rompe mock no listado in-scope
- **Error**: al renombrar `resolveIdentityForSlug` → `resolveIdentityForToken` y
  agregar el import `extractDeclaredTokenId` (de `discovery.js`) en
  `agent-card.ts`, 7 tests de `agent-card.test.ts` devolvieron 500. El Story
  listaba los mocks de `auth.test.ts`/`a2a-key.test.ts`/e2e pero NO mencionaba
  `agent-card.test.ts`, que mockea `../services/discovery.js` con factory manual.
- **Causa raíz**: el factory de `discovery.js` solo exportaba `discoveryService`;
  el código ahora consume también `extractDeclaredTokenId` del MISMO módulo → era
  `undefined` y al invocarlo lanzaba en serve-time. Es la misma lección de Wave 4
  pero por el lado de un export NUEVO (no renombrado) consumido por la route.
- **Fix**: agregar `extractDeclaredTokenId: vi.fn(() => null)` al factory de
  `vi.mock('../services/discovery.js')` en `agent-card.test.ts`.
- **Aplicar en**: el grep de `resolveIdentityForSlug` NO basta — al renombrar/
  mover un símbolo hay que grep TAMBIÉN el módulo destino del nuevo import
  (`vi.mock('<modulo>'`) en TODO el repo, no solo los test files que el Story
  enumere. Los mocks factory rompen silenciosamente (TypeError en runtime, no en
  tsc).

### [2026-05-31] FIX-PACK BLQ-MED-1 — `mockReturnValueOnce` encadenado filtra entre tests
- **Error**: los tests de `bindErc8004Identity` (pre-check + UPDATE = 2 llamadas a
  `supabase.from`) fallaban de forma cruzada: un test obtenía el builder del test
  anterior (clash falso / TypeError supabase undefined).
- **Causa raíz**: armé la doble respuesta con
  `mockFrom.mockReturnValueOnce(a).mockReturnValueOnce(b)`. El queue `once` no se
  re-armaba limpio por test bajo `vi.clearAllMocks()` global, dejando entradas
  residuales.
- **Fix**: `mockFrom.mockReset()` + `mockImplementation` con un contador local
  (`call===1 ? preCheck : update`). Determinista por test. Cast
  `as unknown as ReturnType<typeof supabase.from>` (no `as` directo: TS2352).
- **Aplicar en**: cuando un service hace N queries a supabase en una sola función,
  mockear con `mockImplementation`+contador local, NO con `mockReturnValueOnce`
  encadenado; y castear builders mock con `as unknown as` para evitar TS2352.

### [2026-05-31] FIX-PACK v2 (MNR-1) — endurecer validación rompe test legacy de happy-path
- **Error**: tras agregar la regla JUNTOS-o-NINGUNO en `auth.ts` (un `agent_slug`
  sin `agent_registry` → 400 `INVALID_INPUT`), el test AC-1 (`auth.erc8004.test.ts`)
  que enviaba `{ token_id, agent_slug }` pasó de 200 a 400. El test predataba el fix.
- **Causa raíz**: el contrato del bind cambió: `agent_slug` dejó de ser opt-in
  independiente y pasó a ser una mitad del ancla bidireccional `(registry, slug)`.
  El payload happy-path del test enviaba solo una mitad → ahora es input inválido
  por diseño (DT-22.7). No era bug del código; era un fixture desactualizado.
- **Fix**: actualizar el payload del test AC-1 a `{ token_id, agent_registry,
  agent_slug }` y assert sobre ambos campos persistidos. Idéntico criterio en el
  e2e bridge (constante `BOUND_REGISTRY` + anclas en los `_storedBinding`).
- **Aplicar en**: cuando un fix endurece la validación de un endpoint (nuevo
  campo obligatorio condicional), revisar TODOS los fixtures de happy-path que
  enviaban el shape viejo — fallan en runtime con 4xx, no en tsc. Buscar los
  `payload:` y los row-fixtures (`_storedBinding`, `makeKeyRow`) que toquen el
  shape afectado.

### [2026-05-31] FIX-PACK v3 (BLQ-MED-1) — campo REQUERIDO nuevo en `Agent` rompe 24 fixtures en 9 files fuera del in-scope literal
- **Error**: agregar `registry_id: string` (requerido) a `Agent` en
  `src/types/index.ts` produjo 24 errores `tsc` (TS2345/TS2741/TS2322) en 9 test
  files que construyen objetos `Agent` literales: `agent-price.test.ts`,
  `agent-card.test.ts` (route+service), `orchestrate.test.ts`, `mcp/tools/orchestrate.test.ts`,
  `compose.test.ts`, `compose.chain-flow.test.ts`, `discovery.test.ts`,
  `downstream-payment.test.ts`. La lista de tests in-scope del Story v3 NO los
  mencionaba.
- **Causa raíz**: un campo NUEVO requerido en un tipo compartido obliga a todo
  fixture que construya ese tipo. A diferencia de un campo opcional (`identity?`,
  que el v1 agregó sin romper nada), `registry_id` se especificó requerido a
  propósito (es el ancla del match — debe estar siempre presente). El impacto es
  transversal y solo lo revela `tsc --noEmit` (build tsc pasa porque `mapAgent`
  sí lo setea; rompen únicamente los fixtures de test).
- **Fix**: agregar `registry_id: <value>` a cada fixture (mismo valor que
  `registry` salvo en los enrich tests, donde debe ser el PK `id` del
  `makeRegistry`, no el name). Desviación de scope justificada: el contrato del
  tipo lo fuerza; no es expansión de alcance sino consecuencia mecánica.
- **Aplicar en**: antes de agregar un campo REQUERIDO a un tipo compartido
  (`Agent`, `RegistryConfig`, row types), correr `tsc --noEmit` (no solo el
  build tsconfig) ANTES de cerrar la wave para enumerar TODOS los fixtures
  impactados. Considerar opcional + default-seguro si el blast-radius es grande;
  si requerido es intencional (como acá), presupuestar la actualización de
  fixtures fuera del in-scope literal.

### [2026-05-31] FIX-PACK v3 (DT-23.3.2) — nuevo import de service en un route obliga a mockearlo en tests del route
- **Error**: el bind ahora hace `registryService.get(trimmed)` (existence
  pre-check). `auth.erc8004.test.ts` no mockeaba `../services/registry.js` →
  habría caído al supabase real (no determinista).
- **Causa raíz**: agregar una dependencia de service a un handler hace que sus
  tests de ruta arrastren el módulo real si no lo mockean. No falla en tsc; falla
  (o pega a la red) en runtime.
- **Fix**: `vi.mock('../services/registry.js', () => ({ registryService: { get: vi.fn() }}))`
  + default `mockResolvedValue(EXISTING_REGISTRY)` en `beforeEach`, y override a
  `undefined` para el caso "PK inexistente". En el e2e (que ya mockeaba
  `registry.js` con `get`), bastó `mockResolvedValue(makeRegistry())`.
- **Aplicar en**: al introducir una llamada a un nuevo service dentro de un
  handler, grep los `*.test.ts` que registran ese route y agregar el mock del
  service (con un default que cubra el happy-path) antes de correr la suite.
