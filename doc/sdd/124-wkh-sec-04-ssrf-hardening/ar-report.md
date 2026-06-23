# AR Report — WKH-SEC-04 SSRF Hardening (2026-06-23)
Veredicto: APROBADO — 0 BLQ, 0 MNR. Ambos SSRF cerrados, verificado empíricamente. 15/15 tests SSRF PASS.
- MCP endpoint SSRF CERRADO: new URL(endpoint,gatewayUrl) neutraliza userinfo `@`; validateGatewayUrl sobre la URL FINAL atrapa protocol-relative `//host`; schema `^/` rechaza absolutas/backslash. (pay-x402.ts:89-90, get-payment-quote.ts:31-32, schemas.ts:29/45, router.ts:167 Ajv gate).
- compose invokeUrl CERRADO: validateRegistryUrl(agent.invokeUrl) en compose.ts:440 ANTES del fetch (:455); SSRFViolationError → logger.warn + rethrow sin filtrar invokeUrl/x-a2a-key/PAYMENT headers; aborta step. Headers nunca salen al host bloqueado.
- No regresión: paths `^/` + hosts públicos + allowlist OK. Tercer path SSRF: ninguno (grep de fetch( — discovery ya cubierto WKH-62, adapters usan facilitatorUrl de env).
- Nota CR-MNR-1 (cosmético, aceptado): AC-5 menciona rechazar si host != gatewayUrl; impl enforça private-IP. Re-target a host PÚBLICO distinto no es SSRF interno y el caller ya controla gatewayUrl → cero capacidad nueva. Backlog opcional: enforcar host-match.
