# Auto-Blindaje — WKH-103 (Reputación ERC-8004)

### [2026-05-31 17:16] Wave 1 — Test-guard de aislamiento de módulo demasiado estricto
- **Error**: El test T-AC10 hacía `expect(src).not.toContain('budget'|'delegation'|'a2a_agent_keys')` sobre el source completo. Falló porque los comentarios/JSDoc del service citan las constraints "CD-2/CD-3", "a2a_agent_keys" y "delegation" en prosa explicativa.
- **Causa raíz**: El guard confundía referencias en comentarios (legítimas, documentan la regla) con uso real (imports / `.from()`).
- **Fix**: El guard ahora assertea sobre (a) líneas `import` reales — sin `budget`/`delegation`/`redis`; (b) `.from('...')` calls — el único set permitido es `{'a2a_events'}`; (c) ausencia literal de `.from('a2a_agent_keys')`.
- **Aplicar en**: Cualquier test-guard de "no importa X / no toca tabla Y": chequear el statement (import / `.from()`), nunca el texto crudo del source, porque los comentarios mencionan las reglas a propósito. Mismo patrón aplicado al guard W3 del adapter (`writeContract`/`WalletClient`/`privateKeyToAccount`): se assertea sobre `codeOnly` (líneas no-comentario), no sobre el source completo.

### [2026-05-31 17:24] Wave 4 — Test de fetch-count roto por el fetch interno de Supabase (PostgREST)
- **Error**: `discovery.ssrf.test.ts > T-DISC-03` esperaba `mockFetch` llamado 1 vez pero recibió 2, tras agregar `attachReputations` a `discover()`.
- **Causa raíz**: ese test mockea `registry.js`/`identity.js`/`circuit-breaker.js` y `vi.stubGlobal('fetch')`, pero NO mockea `supabase.js` ni `reputation.js`. El nuevo `computeReputationBatch` corría contra el cliente real de Supabase, cuyo transporte PostgREST usa `fetch` internamente → un 2º `fetch()` contabilizado por el spy global.
- **Fix**: `vi.mock('./reputation.js', ...)` en `discovery.ssrf.test.ts` devolviendo `Map` vacío (CD-15: reflejar el export nuevo consumido en código bajo test).
- **Aplicar en**: TODO test que (a) hace `vi.stubGlobal('fetch')` y assertea el call-count, Y (b) ejercita un code-path que ahora llama un service que usa Supabase. Si el service no está mockeado, su fetch interno (PostgREST) infla el contador. Mockear el service o `supabase.js`. Auditados todos los callers de `discover()`/`getAgent()` (solo `discovery.test.ts` —mockea supabase— y este —ahora fixeado—).

### [2026-05-31 17:22] Wave 3 — Resolución del `[VERIFY-AT-IMPL]` del ReputationRegistry
- **Hallazgo**: el ABI oficial del ReputationRegistry ERC-8004 SÍ es accesible (no quedó como stub). Se leyó `abis/ReputationRegistry.json` del repo `erc-8004/erc-8004-contracts@main` (2026-05-31).
- **Decisión**: la única lectura agregada `view` es `getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) → (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)`. El adapter la invoca con `[], '', ''` (sin filtros) y surfacea el crudo como string `"count:summaryValue:decimals"` (anti-precision-loss, nunca Number() sobre bigint). Cita al repo + addresses canónicas (Base 8453/84532) documentadas en el JSDoc; addresses SOLO desde env (CD-4).
- **Aplicar en**: futuras integraciones de los registries ERC-8004 — la fuente de verdad del ABI es `abis/*.json` del repo oficial, no los `.sol` (no están en `src/`).
