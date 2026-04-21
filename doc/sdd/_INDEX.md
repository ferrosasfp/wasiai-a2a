# SDD Index — WasiAI A2A Protocol

| # | Fecha | HU | Tipo | Mode | Status | Branch |
|---|-------|----|------|------|--------|--------|
| 001 | 2026-04-01 | Kite Chain — Conexion Ozone Testnet | feature | QUALITY | DONE | feat/wkh-5-kite-chain |
| 002 | 2026-04-02 | x402 Payment Middleware — Kite Service Provider | feature | QUALITY | DONE | feat/wkh-6-kite-payment-clean |
| 003 | 2026-04-02 | Supabase — Migrar registries de in-memory a PostgreSQL | evolutivo | QUALITY | DONE | feat/wkh-7-supabase-registries |
| 004 | 2026-04-02 | Migrar framework de Hono a Fastify | refactor | QUALITY | DONE | feat/wkh-20-fastify-migration |
| 006 | 2026-04-03 | Agent Cards — Google A2A spec (WKH-15) | feature | QUALITY | DONE | feat/wkh-15-agent-cards |
| 007 | 2026-04-03 | Tasks DB — A2A Task CRUD (WKH-23) | feature | QUALITY | WIP | feat/wkh-23-tasks-db |
| 007 | 2026-04-03 | Tasks DB — A2A task lifecycle (WKH-23) | feature | QUALITY | DONE | feat/wkh-23-tasks-db |
| 008 | 2026-04-03 | x402 compose — client-side payment (WKH-9) | feature | QUALITY | DONE | feat/wkh-9-x402-compose |
| 009 | 2026-04-04 | Mock Community Hub registry (WKH-32) | feature | SPEED | DONE | feat/wkh-32-mock-registry |
| 011 | 2026-04-04 | LLM Planning — Claude selects agents by goal (WKH-10) | feature | QUALITY | DONE | feat/wkh-10-llm-planner |
| 012 | 2026-04-04 | POST /orchestrate — Flujo completo goal→discover→compose→pay (WKH-13) | feature | QUALITY | DONE | feat/wkh-13-orchestrate-full |
| 013 | 2026-04-04 | Schema Transform — LLM adapts output/input between agents (WKH-14) | feature | QUALITY | DONE | feat/wkh-14-schema-transform |
| 014 | 2026-04-05 | Dashboard Analytics — KPIs + events + UI (WKH-27) | feature | QUALITY | DONE | feat/wkh-27-dashboard |
| 015 | 2026-04-05 | POST /orchestrate — LLM Planning + Fallback (WKH-13) | evolutivo | QUALITY | DONE | feat/015-orchestrate-llm-planning |
| 016 | 2026-04-06 | Build — copy src/static/* into dist/static (fixes /dashboard ENOENT) | patch | FAST | DONE | main (5a14ab8) |
| 018 | 2026-04-06 | Gasless Integration EIP-3009 — testnet PYUSD (WKH-29) | feature | QUALITY | DONE | feat/018-gasless-aa |
| 020 | 2026-04-09 | Kite contracts source-of-truth doc + DEPRECATED banner in spike (WKH-36) | patch | FAST | DONE | main |
| 021 | 2026-04-09 | Pitch Fase 0 — Passport drift fix + chain-adaptive framing + types cleanup (WKH-37) | patch | FAST+AR | DONE | main + wasiai-landing |
| 022 | 2026-04-06 | Gasless graceful degradation (WKH-38) | feature | FAST+AR | DONE | feat/022-gasless-degradation |
| 025 | 2026-04-06 | A2A Key Middleware — requirePaymentOrA2AKey (WKH-34-W4) | feature | LAUNCH | in progress | feat/025-a2a-key-middleware |
| 026 | 2026-04-06 | Hardening — Rate Limiting, Error Boundaries, Circuit Breaker, Backpressure (WKH-18) | feature | QUALITY | in progress | feat/026-hardening |
| 027 | 2026-04-06 | Demo Script E2E — smoke test automatizado (WKH-30) | feature | FAST | DONE | feat/027-demo-script-e2e |
| 028 | 2026-04-06 | README.md rewrite — reflect production architecture (WKH-17) | doc | FAST | in progress | feat/028-readme-rewrite |
| 029 | 2026-04-06 | E2E Test Suite — full middleware chain + inject (WKH-E2E) | test | QUALITY | in progress | feat/029-e2e-tests |
| 030 | 2026-04-06 | GET /health endpoint (WKH-HEALTH) | patch | FAST | in progress | main |
| 031 | 2026-04-06 | POST /discover alias — fix 404 for POST callers (WKH-DISCOVER-POST) | bugfix | FAST | in progress | feat/031-discover-post |
| 032 | 2026-04-06 | Bearer Auth — Authorization: Bearer as alternative to x-a2a-key (WKH-BEARER-AUTH) | feature | FAST+AR | in progress | feat/032-bearer-auth |
| 033 | 2026-04-06 | Invoke docs — clarify proxy invocation in Agent Card + /discover (WKH-INVOKE-DOCS) | doc | FAST | in progress | feat/033-invoke-docs |
| 034 | 2026-04-06 | Global Event Tracking — onResponse hook for all endpoints (WKH-EVENT-TRACKING) | feature | FAST+AR | in progress | feat/034-event-tracking |
| 035 | 2026-04-06 | Bearer Auth Fix on /auth/* + Test Hardening (WKH-BEARER-FIX) | bugfix | FAST+AR | in progress | feat/035-bearer-fix |
| 036 | 2026-04-06 | Sync .env.example + README.md with current features (WKH-DOCS-SYNC) | doc | FAST | in progress | feat/036-docs-sync |
| 037 | 2026-04-06 | Migrate x402 from v1 to v2 — Pieverse format (WKH-X402-V2) | bugfix | QUALITY | in progress | feat/037-x402-v2 |
| 038 | 2026-04-11 | Biome Linter + Formatter (WKH-QG-LINT) | tooling | FAST | DONE | feat/038-biome-linter |
| 039 | 2026-04-11 | Security Headers — X-Content-Type-Options + X-Frame-Options (WKH-QG-HEADERS) | patch | FAST | DONE | feat/039-security-headers |
| 040 | 2026-04-12 | Discover verified+status — filtro activos por defecto (WKH-DISCOVER-VERIFIED) | feature | FAST+AR | DONE | main (779f93a) |
| 041 | 2026-04-13 | Migrate x402 payment token from PYUSD to KXUSD (WKH-KXUSD) | config | FAST+AR | DONE | main |
| 042 | 2026-04-13 | MCP Server x402 — Tools para Claude Managed Agent (WKH-MCP-X402) | feature | QUALITY | DONE | feat/042-mcp-server-x402 |
| 043 | 2026-04-20 | Security Hardening — HSTS + CORS restrictivo + requireAuth en /registries (WKH-SEC-01) | security | QUALITY | DONE | feat/043-wkh-sec-01-hardening |
