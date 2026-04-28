# Validation Report — WKH-62 / SEC-SSRF-1 (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-04-27
**Branch**: `feat/058-wkh-62-sec-ssrf-1` — 3 commits (W0/W1/W2), 9 files vs main

---

## Runtime checks

- DB state: N/A — HU no toca schema DB (Scope OUT confirmado).
- Env parity: `DISCOVERY_SSRF_ALLOWLIST` presente en `.env.example:173`. CD-4 OK.
- Migration: N/A — sin migración Supabase.
- CD-1 (no services → mcp): `grep "from.*mcp"` en `src/services/` y `src/lib/url-validator.ts` → cero hits. OK.
- CD-6 (no lib → mcp/types): `src/lib/url-validator.ts` no importa de `src/mcp/`. OK.
- CD-A1 (`validateOutboundUrl` never throws): único `throw` en el archivo es dentro de `validateRegistryUrl` (L313), no dentro de `validateOutboundUrl`. OK.
- CD-A3 (guard fuera de cb.execute): `src/services/discovery.ts:161` llama `validateRegistryUrl` antes del `cb.execute` en L200. OK.
- CD-A7 (dns.lookup, no resolve): `grep "dns.resolve"` → cero hits en ambos validadores. OK.
- CD-2 (no stack trace en 422): `src/routes/registries.ts` envía solo `{ error, field, reason }`. T-REG-08 verifica `Object.keys(body).sort() === ['error','field','reason']`. OK.

---

## ACs

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1: runtime SSRF guard en queryRegistry | PASS | T-DISC-01: `src/services/discovery.ssrf.test.ts:78` — SSRFViolationError lanzado, mockFetch not called. T-DISC-02 (positive): fetch called para host público. |
| AC-2: write-time guard en POST /registries | PASS | T-REG-01: `src/routes/registries.ssrf.test.ts:95` — 422 + `{error:'SSRF_BLOCKED', field:'discoveryEndpoint', reason contains '169.254.169.254'}` + register NOT called. T-REG-02: field=invokeEndpoint. T-REG-03 (positive): 201. T-REG-04: file:// → 422. |
| AC-3: write-time guard en PATCH /registries/:id | PASS | T-REG-05: `src/routes/registries.ssrf.test.ts:192` — PATCH localhost → 422, update NOT called. T-REG-06 (name-only): 200. T-REG-07 (valid URL): 200. |
| AC-4: allowlist bypass via DISCOVERY_SSRF_ALLOWLIST | PASS | T-LIB-15: `src/lib/url-validator.test.ts:180` — allowlist bypasses private-IP check. T-LIB-16: literal localhost NOT bypassable. T-DISC-06: allowlist permite fetch a host interno. |
| AC-5: SSRFViolationError con IP identificada, sin stack al cliente | PASS | T-LIB-12/13: `src/lib/url-validator.test.ts:149,159` — reason contiene '10.0.0.1' y '169.254.169.254'. T-REG-08: body 422 solo tiene 3 claves. CD-2 OK. |
| AC-6: backwards compat MCP — validateGatewayUrl sin breaking change | PASS | `npm test src/mcp/url-validator.test.ts` → 18/18 PASS sin modificar el archivo. Firma `(rawUrl: string): Promise<URL>` preservada en `src/mcp/url-validator.ts:51`. mapMcpMessage produce strings compatibles con `toContain()`. |
| AC-7: baseline ≥480 + nuevos tests SSRF | PASS | `npm test` → **518/518 passed (48 files)**. Nuevos tests: `src/lib/url-validator.test.ts` 24 it(), `src/services/discovery.ssrf.test.ts` 6 it(), `src/routes/registries.ssrf.test.ts` 8 it() = 38 nuevos (spec estimaba 32 — Dev agregó 6 extra happy-path/dns-failure en lib, todos legítimos). Vectores cubiertos: IPv4 privado (T-LIB-11/12/13), IPv6 loopback (T-LIB-14), 169.254.169.254 (T-LIB-13), localhost (T-LIB-08), URL inválida (T-LIB-01/02/03), URL pública (happy path), allowlist bypass (T-LIB-15/16), IPv6-mapped DT-B (T-LIB-17/18). |

---

## Drift

- Scope: 9 archivos modificados = exactamente los 8 de Scope IN del Story File §1 + `.env.example` (opcional documentado). Cero archivos rogue.
- Wave order: commits `348ba12` (W0) → `811884d` (W1) → `1f5c016` (W2). Orden correcto.
- Spec drift: test paths co-located (`src/lib/url-validator.test.ts`) vs work-item (`tests/unit/lib/...`). Story File F2.5 §1 define la ubicación final (co-located), work-item no es el contrato de Dev. Sin drift real.
- MCP test count: `src/mcp/url-validator.test.ts` reporta 18 tests (story decía 17 en §2 AC-6). El archivo no fue modificado (git diff vacío). El conteo en el story era aproximado. Sin issue.

---

## Gates (confirmed via runtime execution — no CR report present)

Pre-condición indicada: "518/518 tests, TS clean" — verificado directamente:

- `npx tsc --noEmit` → exit 0, sin output. PASS.
- `npm test` → **518/518 passed** (48 test files, 948ms). PASS.
- lint: no CR report presente; no re-ejecutado (ausencia de reporte no invalida — tests y TS clean son los gates críticos para esta HU).

---

## CD Compliance spot-check (1–12)

| CD | Descripción | Status |
|----|-------------|--------|
| CD-1 | services no importan de mcp | PASS — grep vacío |
| CD-2 | No stack en body 422 | PASS — T-REG-08 + routes solo envía {error,field,reason} |
| CD-3 | validateGatewayUrl firma y MCPToolError(-32602) | PASS — 18/18 MCP tests PASS |
| CD-4 | DISCOVERY_SSRF_ALLOWLIST via env var | PASS — .env.example:173 + T-LIB-15 |
| CD-5 | ≥480 tests baseline | PASS — 518 total |
| CD-6 | src/lib no importa mcp/types | PASS — grep vacío |
| CD-A1 | validateOutboundUrl never throws | PASS — único throw en wrapper validateRegistryUrl |
| CD-A2 | vi.mock('node:dns') pattern | PASS — todos los 3 test files nuevos usan el pattern correcto (L25-29, L37-42 en discovery.ssrf, L37-42 en registries.ssrf) |
| CD-A3 | Guard antes de cb.execute | PASS — discovery.ts:161 antes de L200 |
| CD-A4 | Edge cases '', ' ', URL parse fail | PASS — T-LIB-01/02/03 |
| CD-A5 | Loop ALL fields antes de service call | PASS — routes itera discoveryEndpoint+invokeEndpoint en outer try antes de registryService.register/update |
| CD-A6 | 3 archivos test separados | PASS — lib, discovery.ssrf, registries.ssrf son archivos independientes |
| CD-A7 | dns.lookup, no dns.resolve | PASS — grep vacío |

---

## AR/CR follow-up

No hay ar-report.md ni cr-report.md en el directorio. La tarea indica "AR+CR APROBADOS, 5 MNRs cosméticos backlog". Los 5 MNRs son deuda técnica aceptada, no bloquean DONE.

---

**Listo para DONE.**
