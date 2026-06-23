# Final Report — WKH-SEC-04: Hardening SSRF (MCP endpoint + compose invokeUrl)

> Status: DONE · 2026-06-23 · Branch: feat/124-wkh-sec-04-ssrf-hardening · Modo: FAST+AR AUTO · F4: APROBADO PARA DONE (5/5 ACs)

## Resumen
Cierra 2 SSRF detectados en la auditoría project-wide: (1) MCP tools (`pay-x402`, `get-payment-quote`) validaban gatewayUrl pero fetcheaban gatewayUrl+endpoint → userinfo/protocol-relative bypass a metadata; (2) `compose.invokeAgent` fetcheaba invokeUrl sin revalidación SSRF runtime (TOCTOU/rebinding + leak de x-a2a-key). Fix: `new URL(endpoint, gatewayUrl)` + validar la URL FINAL + schema endpoint `pattern:'^/'`; y `validateRegistryUrl(invokeUrl)` antes del fetch en compose (espejo de discovery.ts:529).

## Pipeline
FAST+AR AUTO: AR APROBADO (0/0, ambos SSRF cerrados, verificado empírico) + CR APROBADO (0 BLQ, 2 MNR cosméticos) → F4 APROBADO (5/5 ACs).

## ACs: 5/5 PASS (ver validation.md). Gates: tsc 0 · biome 0 · vitest 1643/0 (15 tests nuevos).

## Archivos
`src/mcp/schemas.ts` (pattern '^/'), `src/mcp/tools/pay-x402.ts`, `src/mcp/tools/get-payment-quote.ts`, `src/services/compose.ts` + 3 tests *.ssrf.test.ts.

## TD (MNR cosméticos): re-target a host PÚBLICO distinto del gateway no bloqueado (no es SSRF interno; el caller ya controla gatewayUrl → cero capacidad nueva). Backlog opcional: enforcar host-match.

## Deploy: code-only, sin migración. Merge a main → Railway auto-deploy. El fix empieza a aplicar al deployar.
