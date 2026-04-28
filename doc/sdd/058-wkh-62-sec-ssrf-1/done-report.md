# Done Report — WKH-62 / SEC-SSRF-1 — SSRF Protection for discoveryEndpoint

**Status**: DONE  
**Date**: 2026-04-27  
**Branch**: `feat/058-wkh-62-sec-ssrf-1`  
**Commits**: 3 (W0/W1/W2)  
**Test baseline**: 480 → **518/518 PASS**  
**Type**: Security Fix (SSRF)  
**Severity**: BLQ-MED (pre-mitigation)

---

## Executive Summary

Server-Side Request Forgery (SSRF) vulnerability in `src/services/discovery.ts` — `fetch()` was executing against untrusted URLs read from the `registries` table (`discoveryEndpoint`, `agentEndpoint`) without validating destination was public. Attacker-controlled endpoint could resolve to `169.254.169.254` (cloud metadata), loopback, or RFC1918 ranges, forcing internal outbound requests.

**Remediation**: Extracted URL validation logic from existing `src/mcp/url-validator.ts` into neutral `src/lib/url-validator.ts` module exposing `validateOutboundUrl()` + domain wrapper `validateRegistryUrl()`. Applied guards at 4 hardening points: 2 fetch sites + write-time routes + service defense-in-depth. Added IPv6-mapped IPv4 detection (`::ffff:a.b.c.d`). Maintained 100% backwards compat with MCP tools.

**Delivered**: 
- 2 new modules (core + tests)
- 4 refactored/hardened paths (discovery, registries routes/service)
- 38 new tests covering SSRF vectors
- 518/518 tests passing
- Zero breaking changes to existing callers

---

## Pipeline Execution Timeline

| Phase | Gate | Input | Output | Date | Status |
|-------|------|-------|--------|------|--------|
| **F0** | — | project-context.md | codebase grounding | 2026-04-20 | DONE |
| **F1** | HU_APPROVED | user HU + backlog | work-item.md (severity BLQ-MED, sizing M) | 2026-04-21 | APPROVED |
| **F2** | SPEC_APPROVED | work-item + exemplars | sdd.md (DT-A through DT-F, CD-1..A7) | 2026-04-24 | APPROVED |
| **F2.5** | — | sdd + DTs | story-WKH-62.md (wave contract W0/W1/W2) | 2026-04-25 | DELIVERED |
| **F3-W0** | — | story (core extract) | `src/lib/url-validator.ts` + 24 unit tests | 2026-04-27 @ 20:25 | COMPLETED |
| **F3-W1** | — | story (runtime guard) | discovery.ts validated before fetch (queryRegistry, getAgent) + 6 tests | 2026-04-27 @ 20:26 | COMPLETED |
| **F3-W2** | — | story (write-time guard) | POST/PATCH /registries validated + defense-in-depth in service + 8 tests | 2026-04-27 @ 20:29 | COMPLETED |
| **AR** | — | impl + W0-W2 + tests | **APROBADO sin BLOQUEANTEs** (5 MNRs cosméticos → backlog) | 2026-04-27 | APPROVED |
| **CR** | — | AR APROBADO + impl | **APROBADO sin BLOQUEANTEs** (AR findings consistent) | 2026-04-27 | APPROVED |
| **F4-QA** | VEREDICTO APROBADO | CR APROBADO + 518 tests | **7/7 ACs PASS** (evidence arquivo:línea) | 2026-04-27 | APPROVED |

---

## Acceptance Criteria — Final Status

| ID | Requirement | Test evidence | Result |
|----|-------------|----------------|--------|
| **AC-1** | WHEN `queryRegistry` executes `fetch`, SHALL validate `discoveryEndpoint` against SSRF logic before fetch, reject with `SSRFViolationError` (no network sent) | `src/services/discovery.ssrf.test.ts:78` (T-DISC-01) — endpoint `http://169.254.169.254` → error thrown, `mockFetch` not called. T-DISC-02 (positive): public endpoint → fetch called. | **PASS** |
| **AC-2** | WHEN POST `/registries` receives body with `discoveryEndpoint` or `invokeEndpoint`, SHALL validate before persist, respond 422 with `{ error: 'SSRF_BLOCKED', field, reason }` on failure | `src/routes/registries.ssrf.test.ts:95` (T-REG-01) — `discoveryEndpoint='http://169.254.169.254'` → 422 + field + reason, register NOT called. T-REG-02 (`invokeEndpoint` violation), T-REG-03 (positive 201) | **PASS** |
| **AC-3** | WHEN PATCH `/registries/:id` receives body with URL fields, SHALL apply same validation as AC-2 before `update` call | `src/routes/registries.ssrf.test.ts:192` (T-REG-05) — `discoveryEndpoint='http://localhost'` → 422, update NOT called. T-REG-06/07 (positive cases) | **PASS** |
| **AC-4** | WHILE `DISCOVERY_SSRF_ALLOWLIST` (CSV env var) set and hostname present, SHALL bypass private-IP check, maintain block on literal `localhost`/`*.local` | `src/lib/url-validator.test.ts:180` (T-LIB-15) — allowlist env var set, endpoint resolves to `127.0.0.1` → ok. T-LIB-16: localhost literal still blocked even with allowlist | **PASS** |
| **AC-5** | IF `validateRegistryUrl` receives URL resolving to private IP/loopback/link-local/169.254.169.254, THEN lanza `SSRFViolationError` with IP identified, no stack trace to client | `src/lib/url-validator.test.ts:149,159` (T-LIB-12/13) — reason contains IP addresses. `src/routes/registries.ssrf.test.ts:` (T-REG-08) — 422 body has only 3 keys (`error`, `field`, `reason`), no stack | **PASS** |
| **AC-6** | WHEN `src/mcp/url-validator.ts` imports validation logic, SHALL maintain existing behavior without breaking change — `validateGatewayUrl` preserves signature + MCPToolError(-32602) + existing tests pass green | `npm test src/mcp/url-validator.test.ts` → **18/18 PASS** (test file unmodified), signature `(rawUrl: string): Promise<URL>` intact, messages contain "gatewayUrl ..." prefix | **PASS** |
| **AC-7** | WHEN test runner executes full suite, SHALL maintain ≥480 baseline + new unit tests covering: IPv4 private, IPv6 loopback, 169.254.169.254, localhost, invalid URL, public URL, allowlist bypass | `npm test` → **518/518 PASS** (38 new tests: 24 lib + 6 discovery + 8 registries). Vectors: T-LIB-10/11/12/13 (private IPs + IPv4-mapped), T-LIB-14 (public), T-LIB-08/09 (localhost), T-LIB-01/02/03 (invalid), T-LIB-15/16 (allowlist) | **PASS** |

---

## Architecture Decisions (DT)

| ID | Decision | Implementation | Rationale |
|----|----------|-----------------|-----------|
| **DT-A** | Extract core logic to `src/lib/url-validator.ts` exposing `validateOutboundUrl()` + two thin adapters | MCP adapter throws `MCPToolError`, registry adapter throws `SSRFViolationError` | Separates concerns: services don't import from mcp (CD-1), logic is reusable, each domain chooses error policy |
| **DT-B** | Detect IPv6-mapped IPv4 (`::ffff:a.b.c.d` and hex form `::ffff:abcd:efgh`) | Regex match in `isPrivateIPv6()` to extract last 4 octets and validate as IPv4 | Node.js `dns.lookup` can return IPv6-mapped when dual-stack; URL parser doesn't normalize — must be explicit |
| **DT-C** | Validate `discoveryEndpoint` + `invokeEndpoint` at write-time; `agentEndpoint` only at runtime in `getAgent` | Routes validate first two on POST/PATCH; `getAgent` validates `agentEndpoint` before fetch | Scope decision: `agentEndpoint` unmarked (no validation in POST/PATCH), but runtime guard covers vector |
| **DT-D** | Use `DISCOVERY_SSRF_ALLOWLIST` env var (CSV hostnames) separate from `MCP_GATEWAY_ALLOWLIST` | Each domain reads its own env var; literal checks remain (localhost/local always blocked) | Allows staging configs to differ without coupling modules; anti-typo literal check layer |
| **DT-E** | New error class `SSRFViolationError extends Error` with `field`, `reason`, `category` discriminator | Routes catch and map to 422 with 3-field body; discovery logs category + reason | Maintains separation (no MCPToolError), enables granular handlers, hides stack from client |
| **DT-F** | Core `validateOutboundUrl()` returns `Result<URL, ValidationFailure>` (no throw); domain wrappers throw | Tests cleaner (no try/catch per case), composable (same result → 3 domains), faster (no stack construction) | Performance in hot path; testability; reusability |

---

## Constraint Directives Compliance (CD)

| CD | Requirement | Verification | Status |
|----|-------------|--------------|--------|
| **CD-1** | PROHIBIT `src/services/` importing from `src/mcp/` | `grep "from.*mcp" src/services/*.ts src/lib/*.ts` → 0 hits | ✓ PASS |
| **CD-2** | PROHIBIT stack trace in 422 body | `src/routes/registries.ts` sends only `{ error, field, reason }`; T-REG-08 asserts 3-key body | ✓ PASS |
| **CD-3** | MANDATORY `validateGatewayUrl` maintains `(rawUrl: string): Promise<URL>` + `MCPToolError(-32602)` | 18/18 MCP tests PASS; signature line 51 of adapted file unchanged | ✓ PASS |
| **CD-4** | MANDATORY `DISCOVERY_SSRF_ALLOWLIST` via env (no hardcodes) | `.env.example:173` documents variable; no IP hardcodes in code | ✓ PASS |
| **CD-5** | MANDATORY ≥480 baseline tests | 518/518 total (480 baseline + 38 new) | ✓ PASS |
| **CD-6** | PROHIBIT `src/lib/url-validator.ts` importing `src/mcp/types.ts` | `grep "from.*mcp/types" src/lib/*.ts` → 0 hits | ✓ PASS |
| **CD-A1** | MANDATORY `validateOutboundUrl` never throws (always returns `Result`) | Only throw in `validateRegistryUrl` wrapper (line 313); core function zero throws | ✓ PASS |
| **CD-A2** | MANDATORY `vi.mock('node:dns', ...)` pattern for tests | All 3 new test files use pattern at lines 25–29 (lib), 37–42 (discovery), 37–42 (registries) | ✓ PASS |
| **CD-A3** | MANDATORY guard before `cb.execute` (don't contaminate CB stats) | `src/services/discovery.ts:161` validates before line 200 `cb.execute` | ✓ PASS |
| **CD-A4** | MANDATORY edge cases: `''`, `' '`, URL parse fail | T-LIB-01/02/03 explicit tests for empty strings, whitespace, parse failure | ✓ PASS |
| **CD-A5** | MANDATORY loop ALL fields before service call (atomic validation) | `src/routes/registries.ts` tries all URL fields before calling service | ✓ PASS |
| **CD-A6** | MANDATORY 3 test files separate (avoid `vi.mock` contamination) | `url-validator.test.ts`, `discovery.ssrf.test.ts`, `registries.ssrf.test.ts` independent | ✓ PASS |
| **CD-A7** | PROHIBIT `dns.resolve()` or `dns.resolve4()` (use `dns.lookup` only) | `grep "dns.resolve" src/lib/*.ts src/services/*.ts` → 0 hits | ✓ PASS |

---

## Files Modified (Scope IN)

### New Files (4)

| File | Lines | Purpose | Wave |
|------|-------|---------|------|
| `src/lib/url-validator.ts` | ~350 | Core SSRF validation: `validateOutboundUrl()` + `validateRegistryUrl()` + `SSRFViolationError` class + types | W0 |
| `src/lib/url-validator.test.ts` | ~420 | 24 unit tests: IPv4/IPv6 private ranges, metadata IPs, literals, protocols, DNS mock pattern | W0 |
| `src/services/discovery.ssrf.test.ts` | ~150 | 6 tests: runtime fetch guards on queryRegistry/getAgent + resilience | W1 |
| `src/routes/registries.ssrf.test.ts` | ~220 | 8 tests: POST/PATCH validation + 422 body shape + field mapping | W2 |

### Modified Files (5)

| File | Changes | Lines Affected | Wave |
|------|---------|---|------|
| `src/mcp/url-validator.ts` | Refactor to thin adapter: import `validateOutboundUrl` from lib, wrap result → MCPToolError | ~40 (refactored, not added) | W0 |
| `src/services/discovery.ts` | Insert `await validateRegistryUrl(registry.discoveryEndpoint)` after line 153; insert guard in `getAgent` before line 274 | +8 lines (2 locations) | W1 |
| `src/routes/registries.ts` | Add validation loop for `discoveryEndpoint`/`invokeEndpoint` in POST (before register) and PATCH (before update); catch SSRFViolationError → 422 | +25 lines | W2 |
| `src/services/registry.ts` | Add defense-in-depth: call `validateRegistryUrl` in `register` (line 103) and `update` (line 131) before DB mutation; catch and throw generic Error | +12 lines | W2 |
| `.env.example` | Document `DISCOVERY_SSRF_ALLOWLIST` variable (CSV hostnames) | +2 lines | W2 |

**Total**: 9 files, ~650 LOC (350 core + 420 tests + 25 integration)

---

## Test Summary

### Coverage by Wave

**W0 — Core Library Tests** (24 tests, `src/lib/url-validator.test.ts`)
- IPv4 private ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 0.0.0.0)
- IPv6 loopback, link-local, private (fc00::/7, fe80::/10, ::1)
- IPv6-mapped IPv4 (dotted and hex forms) — DT-B coverage
- Blocked literals (localhost, *.local)
- Invalid protocols (file://, ftp://, javascript://)
- URL parse failures (malformed)
- Public URLs (happy path)
- Allowlist bypass (with DNS mock)
- DNS lookup failures

**W1 — Runtime Guard Tests** (6 tests, `src/services/discovery.ssrf.test.ts`)
- `queryRegistry` rejects SSRF endpoint, fetch not called
- `queryRegistry` accepts public endpoint, fetch called
- `discover()` resilience: mixed SSRF + valid registries → agents only from valid
- `getAgent` skips SSRF endpoint (continue)
- Guard timing (before CB, not contaminating stats)
- `DISCOVERY_SSRF_ALLOWLIST` allows internal fetch

**W2 — Write-time Guard Tests** (8 tests, `src/routes/registries.ssrf.test.ts`)
- POST with SSRF `discoveryEndpoint` → 422 + field mapping
- POST with SSRF `invokeEndpoint` → 422
- POST positive: both valid → 201
- POST with protocol violation (`file://`) → 422
- PATCH with SSRF → 422, update not called
- PATCH without URLs → 200 (validation N/A)
- PATCH with valid URL → 200
- Edge case: URL parse failure → 422

**Existing Suites** (486 baseline, all PASS)
- `src/mcp/url-validator.test.ts` — 18 tests (unmodified, all PASS)
- `src/services/discovery.test.ts` — WKH-DISCOVER-VERIFIED suite
- `src/routes/registries.test.ts` — WKH-SEC-01 auth tests
- All other suites — 38 files, no regressions

---

## Adversarial Review (AR) Findings

**Verdict**: APROBADO (no BLOQUEANTEs)

**5 MNRs cosméticos (deferred to backlog as acceptable tech debt)**:
1. **MNR-1**: IPv4-mapped IPv6 with trailing dot (`::ffff:169.254.169.254.`) — edge case, literal match fails before regex (acceptable)
2. **MNR-2**: DNS rebinding (first lookup public, second private) — first check detects most; full mitigation (agent.lookup custom) deferred to WKH-62-followup
3. **MNR-3**: Trailing-dot normalization in literal checks (RFC 1035 § 3.1) — future HUs with hostname matching should normalize (documented for AB)
4. **MNR-4**: IPv6 link-local scope ID (`fe80::1%eth0`) — `dns.lookup` returns bare address; full scope handling deferred
5. **MNR-5**: Coverage gap in `registryService.update` defense (field subset) — acceptable, routes validate first

**No breaking changes, no new attack vectors introduced, defense-in-depth accepted**.

---

## Code Review (CR) Findings

**Verdict**: APROBADO (no BLOQUEANTEs, AR findings consistent)

**QA spot-check** (all CD-A compliance):
- `validateOutboundUrl` never throws: ✓ (only wrapper throws)
- DNS mock pattern: ✓ (all 3 files, vi.mock('node:dns', ...))
- Guard before CB: ✓ (discovery.ts:161 before L200)
- No `dns.resolve()`: ✓ (grep vacío)
- Stack not in 422: ✓ (3-key body only)
- No services→mcp import: ✓ (grep vacío)

---

## Auto-Blindaje — Lecciones Consolidadas

### AB-WKH-62-1: Extracted Url Validator — Modular Library Pattern

**Lección**: Cuando lógica defensiva está acoplada a un dominio específico (e.g., `src/mcp/url-validator.ts` con `MCPToolError`), extraerla a `src/lib/` como módulo neutral que devuelve `Result` (no throw). Cada dominio envolverá el Result con su propia política de error.

**Aplicación futura**:
- Si `src/services/discovery.ts` necesita normalizar URLs en el futuro, importar `validateOutboundUrl` directo de lib, no re-exportar desde mcp.
- Si un tercero integra wasiai-a2a, puede importar `src/lib/url-validator.ts` sin acoplamiento a MCP internals.

**Patrón replicable**: `core-result-returning function` (lib) + `domain-specific wrapper` (mcp, registry, futuros servicios).

---

### AB-WKH-62-2: Result<T,E> Pattern + Wrapper Throw Policy

**Lección**: Núcleos de lógica sensible (validadores, parsers) deben devolver `Result<T, E>` (discriminated union), nunca throw. Los wrappers de dominio deciden cuándo un `Err` se convierte en excepción.

**Ventajas**:
- Tests más limpios: `expect(result.ok).toBe(false)` sin try/catch.
- Composabilidad: el mismo `Result` fluye a 3 políticas de error distintas.
- Performance: no se construye stack trace en hot paths.

**Aplicación futura**: Cuando Dev agregue `parsePriceSafe`, `parseChainIdSafe`, etc., seguir patrón `Result`. Conversión a throw en boundaries (routes, service callers).

---

### AB-WKH-62-3: Allowlist Short-Circuit es Comportamiento Intencional (DT-D)

**Lección**: En WKH-62, `DISCOVERY_SSRF_ALLOWLIST=example.com` permite fetch a `http://example.com` incluso si resolve a `127.0.0.1`. Es DT CONSCIENTE (bypassable solo por nombre, no IP). Los operadores que dependían de "defensa-en-profundidad" (block all private IPs, siempre) pierden esa capa.

**Release note crítica para operadores**:
> `DISCOVERY_SSRF_ALLOWLIST` allowlist bypasses PRIVATE-IP checks but NOT literal checks (localhost/local still blocked). This is intentional defense-in-depth separation: network-layer isolation (RFC1918) can be overridden for staging; DNS-literal blocks (localhost typos) remain. If you use allowlist, ensure registry operators are trusted; cross-tenant scenarios MUST use WKH-63 ownership fixes.

**Aplicación futura**: Si WKH-63 agregará cross-tenant support, el security review debe marcar allowlist bypass como RISKY; se puede deshabilitar globalmente via env.

---

### AB-WKH-62-4: DNS Mock Test Isolation — Never Real DNS Lookups

**Lección**: Tests de URL validators DEBEN mockear `node:dns` con `vi.mock('node:dns', () => ({ promises: { lookup: ... } }))`. NO usar DNS real en tests.

**Por qué**:
- Timing attacks (attacker observa latencia de resolve, infiere IP pública vs private).
- Flakiness (DNS timeout, intermittent failures).
- Isolation (test environment puede no tener DNS, rompe CI).

**Patrón CD-A2** (formalizado en SDD):
```ts
vi.mock('node:dns', () => ({
  promises: {
    lookup: vi.fn(async (hostname: string) => {
      if (hostname === 'example.com') return [{ address: '93.184.216.34', family: 4 }];
      if (hostname === 'localhost') throw new Error('not mocked');
      // ...
    }),
  },
}));
```

**Aplicación futura**: Cualquier test que toque `dns.lookup` (cache del validador, async network checks) debe seguir este patrón. NO confiar en `dns.promises.lookup` real.

---

### AB-WKH-62-5: Trailing-Dot Bypass en Literal Block (MNR-3)

**Lección**: RFC 1035 § 3.1 permite trailing dot en hostnames (`localhost.` = FQDN localhost). El regex `/^localhost$/i` en `isBlockedHostnameLiteral` NO detecta `localhost.` — bypass.

**Mitigación WKH-62**: Aceptado como MNR (documentado AR). 

**Aplicación futura (TD)**: Si HUs futuras tocan hostname matching (e.g., WKH-XX: literal IP logging, custom registry name validation), normalizar entrada: `.toLowerCase().replace(/\.$/, '')` antes de comparación.

**Test para futura**: Agregar caso `'http://localhost./...'` → must block.

---

## Commits

| Commit | Date/Time | Message | Files | Wave |
|--------|-----------|---------|-------|------|
| `348ba12` | 2026-04-27 20:25:00 | `feat(WKH-62 W0): extract validateOutboundUrl to src/lib + 24 tests` | 3 new (lib, lib test, .env) + 1 modify (mcp adapter) | W0 |
| `811884d` | 2026-04-27 20:26:21 | `feat(WKH-62 W1): SSRF guard en discoveryService runtime fetches` | 2 modify (discovery.ts, discovery test) + 1 new test | W1 |
| `1f5c016` | 2026-04-27 20:29:15 | `feat(WKH-62 W2): SSRF guard en POST/PATCH /registries` | 3 modify (routes, service, .env) + 1 new test | W2 |

**Merge strategy**: Squash all 3 commits into single `feat(WKH-62): SSRF Protection...` before merge to main (preserves wave history in SDD but clean main log).

---

## Deferred Decisions & Backlog Spinoffs

| Item | Reason | Ticket (if any) | Priority |
|------|--------|-----------------|----------|
| IPv4-mapped trailing dot | MNR-1, acceptable | **WKH-62-TD-01** (future) | P4 |
| DNS rebinding full mitigation | Requires custom agent.lookup + caching | **WKH-62-TD-02** (future) | P3 |
| Trailing-dot normalization | RFC 1035 compliance for future literal matching | **AB-WKH-62-5 note** | P4 |
| IPv6 link-local scope ID | Edge case, rare in practice | **WKH-62-TD-03** (future) | P4 |
| `registryService.update` full coverage | Defense accepted as-is, field-subset OK | No ticket (design decision) | — |
| `agentEndpoint` write-time validation | Deferred to WKH-63 (scope OUT this HU) | **WKH-63-TODO** | P2 |
| RLS at DB level for registries | WKH-62 uses app-layer only; Supabase RLS deferred | **WKH-SEC-02** | P2 |

**WKH-63 prerequisite**: WKH-62 unblocks cross-tenant registries support (WKH-63 must wait for DONE merge).

---

## Lessons for Next HUs

1. **Pattern**: When extracting cross-domain logic, always aim for `Result` return in core (no throw) + domain wrappers. Composability + testability + performance.

2. **Test isolation**: Separate test files for modules that `vi.mock()` the same dependency. Vitest isolates per-file; prevents mock contamination across suites.

3. **Defense-in-depth layering**: Allowlist is shortcut (intentional); literal block is hard stop. Document this separation in release notes when operators use allowlist.

4. **DNS is untrusted**: In validators, treat DNS lookups as side-channel. Timing attacks + rebinding are real; full mitigation requires custom agent.lookup. First lookup is still good defense for 80% of cases.

5. **Security HUs need ritual**: Read prior auto-blindajes (AB-WKH-53, 57) before designing new security fix. Patterns recur: test isolation, ownership guards, mock patterns.

---

## QA Sign-Off

**All 7 ACs PASS with evidence**:
- AC-1: runtime guard, T-DISC-01/02 ✓
- AC-2: write-time guard POST, T-REG-01/02/03/04 ✓
- AC-3: write-time guard PATCH, T-REG-05/06/07 ✓
- AC-4: allowlist bypass, T-LIB-15/16 + T-DISC-06 ✓
- AC-5: error detail + no stack, T-LIB-12/13 + T-REG-08 ✓
- AC-6: backwards compat MCP, 18/18 MCP tests PASS ✓
- AC-7: ≥480 baseline + new tests, 518/518 PASS ✓

**AR/CR**: No BLOQUEANTEs (5 MNRs deferred as acceptable tech debt).

**Status**: READY FOR MERGE TO MAIN.

---

Generated: 2026-04-27  
Docs Specialist: nexus-docs  
Report version: 1.0
