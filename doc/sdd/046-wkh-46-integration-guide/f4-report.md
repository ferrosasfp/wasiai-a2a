# F4 QA Report — WKH-46

## Veredicto: APROBADO PARA DONE

## Runtime Checks
- npm test: 350/350 PASS (40 files, 1.29s)
- npm run build: green baseline (docs-only commit, tsc unchanged)
- Smoke prod: GET /health, /.well-known/agent.json, /discover → 200 | POST /auth/agent-signup → 201 con key | GET /auth/me → 200
- Snippets del doc funcionan copy-paste

## AC Coverage: 8/8 PASS (ver archivo:línea en work-item)
- AC-1: doc/INTEGRATION.md:29,54 — 2 patterns
- AC-2: doc/INTEGRATION.md:72-139 — onboarding
- AC-3: doc/INTEGRATION.md:154-180 — tabla endpoints
- AC-4: doc/INTEGRATION.md:189-241 — x402 flow + link a scripts/demo-x402.ts
- AC-5: doc/INTEGRATION.md:253-260 — error codes (401,402,403,429,503,504)
- AC-6: doc/INTEGRATION.md:273-302 (curl) + 308-365 (fetch JS)
- AC-7: doc/INTEGRATION.md:26,52 — B2B positioning, CORS solo browser
- AC-8: README.md:488,495-498 — link desde Documentation + sección "For Marketplace Developers"

## Deviations justificadas (5)
1. POST /a2a omitido (no existe en código — CD-5 aplicado)
2. MCP es POST only (verificado en src/mcp/index.ts:39)
3. 401 no se emite por app layer (verificado en src/middleware/a2a-key.ts)
4. 429/504 agregados extra al error table (adición de valor)
5. work-item.md staged en el commit (cosmético)

## Drift: cero — 3 archivos, todos Scope IN
