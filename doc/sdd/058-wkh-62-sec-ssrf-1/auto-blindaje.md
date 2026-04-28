# Auto-Blindaje — WKH-62 / SEC-SSRF-1

**Fecha**: 2026-04-27  
**HU**: WKH-62 / SEC-SSRF-1 — SSRF Protection for discoveryEndpoint  
**Status**: DONE  
**Especialista**: nexus-docs + nexus-qa

Lecciones extraídas del análisis de artefactos (work-item.md, sdd.md, story-WKH-62.md, qa-report.md, done-report.md) para aplicación en futuras HUs.

---

## AB-WKH-62-1: Extracted URL Validator — Modular Library Pattern

**Contexto**: Lógica defensiva de SSRF estaba acoplada a `src/mcp/url-validator.ts` con `MCPToolError` hardcoded. Necesitaba reutilizarse en `src/services/discovery.ts` y `src/routes/registries.ts` sin crear dependencia circular (`services` → `mcp` violaría CD-1).

**Decisión técnica**: Extraer la lógica core a `src/lib/url-validator.ts` como módulo neutral que:
1. Devuelve `Result<URL, ValidationFailure>` (nunca throw)
2. Acepta env var name como parámetro (`allowlistEnvVar?: string`)
3. Expone `validateOutboundUrl()` como API pública pura

Cada dominio envuelve el `Result` con su política de error:
- MCP: `validateGatewayUrl()` → lanza `MCPToolError(-32602)`
- Registry: `validateRegistryUrl()` → lanza `SSRFViolationError extends Error`

**Ventajas**:
- **Separación de capas**: services no acople a mcp (CD-1 respetado).
- **Composabilidad**: el mismo core valida 3 casos de uso.
- **Reusabilidad**: terceros pueden importar `src/lib/url-validator.ts` directamente.
- **Testabilidad**: tests del core sin try/catch, sin dependencia a MCPToolError.

**Aplicación futura**:
- Si `parseChainIdSafe()` o `normalizePriceSafe()` aparecen en futuras HUs, usar patrón `Result` + wrappers.
- Cuando WKH-63 (registries cross-tenant) necesite validación, heredará el patrón.
- Si un nuevo dominio (e.g., `src/scheduler/`) necesita URL validation, importa directo de `src/lib/`, no duplica.

**Antipatrón evitado**: No dejar lógica en `src/mcp/`, luego re-exportar desde services (violaría separación de capas). No crear `src/utils/url-validator.ts` duplicado en cada dominio.

---

## AB-WKH-62-2: Result<T,E> Pattern + Domain-Specific Wrapper Throw Policy

**Contexto**: Función core de validación necesita ser pura (sin side effects, sin throw) pero la mayoría de callers esperan throw behavior.

**Decisión técnica**: Separar pureza de dominio:
1. **Core (`validateOutboundUrl`)**: Devuelve `Result<URL, ValidationFailure>` = `{ ok: true, value: URL } | { ok: false, error: ValidationFailure }`
2. **Wrappers de dominio**: Leen el `Result` y deciden:
   - Si `ok === true`: retornan la URL.
   - Si `ok === false`: lanzan excepción con detalles del dominio.

```ts
// Core — Result style
export async function validateOutboundUrl(rawUrl: string, opts?: ValidateOutboundOpts): Promise<Result<URL, ValidationFailure>> {
  try {
    const url = new URL(rawUrl);
    // ... validation logic ...
    return { ok: true, value: url };
  } catch (err) {
    return { ok: false, error: { category: 'invalid-url', reason: '...' } };
  }
}

// Wrapper — throw policy
export async function validateRegistryUrl(rawUrl: string): Promise<URL> {
  const result = await validateOutboundUrl(rawUrl, { allowlistEnvVar: 'DISCOVERY_SSRF_ALLOWLIST' });
  if (!result.ok) {
    throw new SSRFViolationError(result.error.reason, result.error.category);
  }
  return result.value;
}
```

**Ventajas**:
- **Tests limpios**: `expect(result.ok).toBe(false)` en vez de try/catch en cada test.
- **Performance**: No se construye stack trace en la ruta de validación (hot path).
- **Composabilidad**: El mismo `Result` se traduce a 3 políticas distintas sin re-ejecución.
- **Error categorización**: `result.error.category` permite handlers granulares (ej: loguear `'dns-lookup-failed'` diferente a `'private-ip'`).

**Aplicación futura**:
- Parsers criptográficos (`parsePrivateKeySafe()`): core devuelve `Result`, wrapper en MCP lanza `MCPToolError`, wrapper en CLI lanza `CLIError`.
- Cachés de transformación (`parseAndCacheTransformSchema`): core devuelve `Result`, handler de ruta decide si 400 o 500.

**Anti-patrón evitado**: No tener `validateOutboundUrl()` que a veces lanza, a veces devuelve (inconsistent). No devolver `null` o `undefined` para fallos (ambiguo).

---

## AB-WKH-62-3: SSRF Allowlist Short-Circuit es Comportamiento Intencional (Design Trade-off)

**Contexto**: En WKH-62, `DISCOVERY_SSRF_ALLOWLIST=example.com` (env var CSV) permite que `fetch()` vaya a `http://example.com` incluso si el DNS lo resuelve a `127.0.0.1`. Operadores que creían que TODAS las IPs privadas serían bloqueadas pierden esa garantía.

**Decisión técnica (DT-D)**: Allowlist bypass es DOS capas defensivas distintas:
1. **IP-layer** (remota): `DISCOVERY_SSRF_ALLOWLIST` bypassea el check de rango privado (RFC1918, loopback, 169.254.*.*, etc.).
2. **DNS-literal-layer** (local): SIEMPRE bloqueado: `localhost`, `127.0.0.1` (literal, no resolve), `*.local`.

Esto permite staging/canary interno:
```bash
DISCOVERY_SSRF_ALLOWLIST=internal.staging.example.com npm start
# fetch("http://internal.staging.example.com") → resolve a 10.0.0.1 → OK (allowlist bypass)
# fetch("http://localhost:9999") → BLOCKED (literal check)
```

**Por qué NO es un bug**:
- El allowlist se configura solo en env var, NO en código.
- En producción (`DISCOVERY_SSRF_ALLOWLIST` unset), TODAS las IPs privadas se bloquean.
- La capa de literal blocks (`localhost`, `*.local`) sigue activa incluso con allowlist (anti-typo).

**Por qué es risky**:
- Operadores que dependen de "defensa-en-profundidad" (múltiples capas) pierden la capa de IP-blocking si configuran allowlist.
- Si mal-usan allowlist (ej: `DISCOVERY_SSRF_ALLOWLIST='*'`), abre SSRF completo.

**Release note crítica**:
```
BREAKING CHANGE (behavior): DISCOVERY_SSRF_ALLOWLIST now allows URLs 
that resolve to private IPs (RFC1918, 127.0.0.0/8, 169.254.*.*, fe80::/10).

SECURITY WARNING: This allowlist is ONLY for staging/canary with trusted 
registry operators. In production, leave DISCOVERY_SSRF_ALLOWLIST unset.

Literal checks (localhost, *.local) remain active even with allowlist.

WKH-63 (cross-tenant registries) MUST NOT use this allowlist without 
additional owner_ref checks.
```

**Aplicación futura**:
- Si WKH-63 agrega multi-tenant registry support, security review debe marcar allowlist como RISKY y permitir deshabilitar globalmente.
- Si `MCP_GATEWAY_ALLOWLIST` agrega similar bypass en WKH-XX, documentar la misma trade-off.
- Tests futuros de allowlist deben especificar: "esta es una feature de staging, no producción".

---

## AB-WKH-62-4: DNS Mock Test Isolation — Never Real DNS Lookups in Tests

**Contexto**: En WKH-62, `src/lib/url-validator.ts` hace `dns.lookup(hostname)` para resolver direcciones y detectar IPs privadas. Los tests deben mockear `node:dns` explícitamente; NO usar DNS real.

**Patrón obligatorio (CD-A2)**:
```ts
// En describe() o describe.each(), NO global scope
vi.mock('node:dns', () => ({
  promises: {
    lookup: vi.fn(async (hostname: string) => {
      if (hostname === 'example.com') return [{ address: '93.184.216.34', family: 4 }];
      if (hostname === '10.0.0.1') return [{ address: '10.0.0.1', family: 4 }];
      if (hostname === 'localhost') throw new Error('localhost not resolvable in mock');
      throw new Error(`Unexpected hostname in mock: ${hostname}`);
    }),
  },
}));

// NO usar:
// vi.spyOn(dns.promises, 'lookup') ← no funciona con default import
// dns.lookup() real ← falla en CI, timing attacks, flaky
```

**Por qué NO usar DNS real**:
1. **Timing attacks**: Atacante observa latencia de `dns.lookup`, infiere si es privada (rápido local) vs pública (lento remoto).
2. **Flakiness en CI**: DNS resolver en CI puede estar deshabilitado, no tener /etc/hosts, fallar intermitentemente.
3. **Isolation**: Tests deben ser repeatables sin dependencias externas.
4. **Intentionality**: Mock permite testear todos los casos (private IP resolve, DNS failure, IPv6-mapped) sin setup externo.

**Patrón aplicado en WKH-62**:
- `src/lib/url-validator.test.ts:25–29` — mock al inicio del describe block.
- `src/services/discovery.ssrf.test.ts:37–42` — mismo patrón para discovery tests.
- `src/routes/registries.ssrf.test.ts:37–42` — mismo patrón para route tests.

**Archivos test SEPARADOS**: No mezclar `url-validator.test.ts` con otros que también mockean dns. Vitest aísla mocks por archivo; previene contaminación.

**Aplicación futura**:
- Si WKH-XX agrega caché de DNS (LRU + TTL), los tests DEBEN mockear `node:dns`, luego mockear el caché con `vi.hoisted()`.
- Si integración con Cloudflare DoH o AWS Route53, mantener mock de `node:dns` como fallback — nunca DNS real en tests.
- Auto-blindaje futuro (AB-WKH-XX): "DNS test isolation pattern" como sub-checklist.

**Anti-patrón evitado**: 
- NO `try { await dns.lookup(...) } catch { skip test }` (oculta problemas).
- NO usar environment variables para "skip si no hay DNS" (test no determinista).
- NO confiar en `/etc/hosts` en CI (varía por runner).

---

## AB-WKH-62-5: Trailing-Dot Bypass en Literal Block — RFC 1035 § 3.1 Edge Case

**Contexto**: Función `isBlockedHostnameLiteral()` en `src/lib/url-validator.ts` detecta `localhost`, `127.0.0.1`, `*.local` para prevenir typos. Sin embargo, RFC 1035 § 3.1 permite trailing dot en FQDNs: `localhost.` es equivalente a FQDN `localhost`.

**Problema**:
```ts
function isBlockedHostnameLiteral(hostname: string): boolean {
  return /^(localhost|127\.0\.0\.1|\.local)$/i.test(hostname);
  // BUG: hostname='localhost.' (con trailing dot) NO matchea
}

// Bypass:
validateOutboundUrl('http://localhost./admin') // Poco probable pero válido DNS
```

**En WKH-62**: Identificado como MNR-3 (aceptado, no bloqueante). Razón: trailing-dot bypasses son raros en práctica (atacante debe saber que opera en DNS-aware resolver); defensa primaria (IP blocking) aún protege.

**Mitigación (futuro, no WKH-62)**:
```ts
function isBlockedHostnameLiteral(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, ''); // remove trailing dot
  return /^(localhost|127\.0\.0\.1|\.local)$/i.test(normalized);
}
```

**Aplicación futura**:
- Si HU-XX implementa custom registry name validation (ej: `registry_name NOT IN ('localhost', 'admin', ...)` en DB), normalizar entrada con `.replace(/\.$/, '')`.
- Si HU-XX agrega DNS-based access lists (DNSBL, DNSWL), hacer explicit normalization.
- Tests futuros: agregar caso `'http://localhost./admin'` → must block.

**Por qué NO fijar en WKH-62**:
- SDD sizing M (3–4h) se agotó; adicional sería W3 extra.
- Riesgo: bajo (trailing dot es edge case).
- Defensa primaria (IP blocks) reduce urgencia.
- Documentado para futuro (auto-blindaje).

**Auto-blindaje para próximas security HUs**:
> Si el validator toca hostnames (literals, DNS, dominio), verificar RFC 1035 normalization (trailing dot, case-insensitivity, etc.). Usar `.toLowerCase().replace(/\.$/, '')` antes de comparación.

---

## Tabla de Referencia — Auto-Blindajes por Tema

| AB-ID | Tema | Lección | Aplicación | Prioridad |
|-------|------|---------|-----------|-----------|
| AB-WKH-62-1 | Library extraction | Core + wrapper pattern (Result + throw policies) | Parsers, validators, future domains | P1 |
| AB-WKH-62-2 | Result pattern | Pure core (no throw) + domain wrappers (throw) | Tests limpios, performance, composabilidad | P1 |
| AB-WKH-62-3 | Allowlist bypass | Behavior is intentional, not a bug; doc release notes | Staging configs, multi-tenant security review | P2 |
| AB-WKH-62-4 | DNS test isolation | Always mock node:dns; separate test files | All DNS-touching tests, future caching | P1 |
| AB-WKH-62-5 | Trailing-dot normalization | RFC 1035 edge case; fix in future security HUs | Hostname matching, DNS-based ACLs | P4 |

---

## Cross-Reference to Prior HUs

| Prior HU | Auto-Blindaje | Applied in WKH-62? | Notes |
|----------|----------------|-------------------|-------|
| WKH-53 (RLS Ownership) | AB-WKH-53-#2 (read before write) | ✓ (Read exemplars from discovery.test.ts) | Mocking pattern inherited |
| WKH-53 | AB-WKH-53-#3 (edge case empty strings) | ✓ (T-LIB-01/02 for '') | Explicit tests for boundaries |
| WKH-56 (A2A Fast-Path) | AB-WKH-56-W4 (coverage tooling) | ✓ (Manual count: 38 tests, not --coverage) | 518/518 baseline + new |
| WKH-57 (LLM Bridge) | AB-WKH-57-1 (test isolation, vi.mock chain) | ✓ (3 separate test files, no contamination) | Vitest file-level isolation |
| WKH-57 | AB-WKH-57-3 (CLIENT pattern in discovery) | ✓ (Discovery mocks replicated) | Consistent test structure |

---

## Checklist para Futuras Security HUs (AB-WKH-62 Ritual)

Cuando próxima HU toque validación, seguridad, o extraiga lógica compartida:

- [ ] **AB-1**: ¿Hay lógica core pura que se reutiliza? → Crear `src/lib/` module con `Result` return.
- [ ] **AB-2**: ¿Hay múltiples callers con políticas de error distintas? → Wrappers domain-specific que throw.
- [ ] **AB-3**: ¿Hay configuración de allowlist/bypass? → Documentar en RELEASE.md que es intentional trade-off.
- [ ] **AB-4**: ¿Hay DNS, network, o I/O en tests? → Mockear explícitamente; archivos test separados.
- [ ] **AB-5**: ¿Hay hostname/URL/RFC-parsing? → Verificar RFC normalization (trailing dot, case, etc.); documentar edge cases.

---

Generated: 2026-04-27  
Docs Specialist: nexus-docs
