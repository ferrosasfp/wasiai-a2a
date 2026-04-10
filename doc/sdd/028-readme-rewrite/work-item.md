# Work Item -- [WKH-17] README.md rewrite -- reflect production architecture

## Resumen

Reescribir README.md para reflejar la arquitectura chain-adaptive actual del proyecto (L1-L4 adapters, identity a2a_agent_keys, hardening, gasless graceful degradation). El README actual referencia archivos eliminados y omite features implementados en WKH-34, WKH-35, WKH-18, WKH-38.

## Sizing

- SDD_MODE: mini
- Estimation: S
- Branch sugerido: feat/028-readme-rewrite
- Skills: [technical-writing, architecture-documentation]

## Acceptance Criteria (EARS)

- AC-1: WHEN a developer reads README.md, the system SHALL present all 13 sections defined in scope (project description, architecture diagram, quick start, env vars, API endpoints, identity, payment flow, adapter pattern, hardening, gasless, testing, deployment, doc links).
- AC-2: the system SHALL NOT reference deleted files (kite-client.ts, x402-signer.ts, or any file not present in current main branch).
- AC-3: WHEN README.md lists environment variables, the system SHALL include the complete matrix from .env.example including WASIAI_A2A_CHAIN, RATE_LIMIT_MAX, TIMEOUT_ORCHESTRATE_MS, and all new variables added by WKH-18/WKH-34/WKH-35/WKH-38.
- AC-4: WHEN README.md lists API endpoints, the system SHALL include all current production endpoints: /, /discover, /compose, /orchestrate, /auth/agent-signup, /auth/me, /gasless/status, /gasless/transfer, /dashboard, /dashboard/api/stats, /.well-known/agent.json.
- AC-5: WHEN README.md describes the architecture, the system SHALL include a simplified L1-L4 diagram consistent with doc/CHAIN-ADAPTIVE.md.

## Scope IN

- README.md (root)

## Scope OUT

- Zero code changes
- No changes to src/, test/, scripts/, supabase/
- No changes to .nexus/project-context.md (separate task)
- No changes to doc/CHAIN-ADAPTIVE.md or doc/kite-contracts.md

## Decisiones tecnicas (DT-N)

- DT-1: Content sources are current codebase (src/), .env.example, doc/CHAIN-ADAPTIVE.md, doc/kite-contracts.md, and smoke-test.sh -- no invented information.
- DT-2: Architecture diagram uses ASCII art (consistent with existing style), not external images.

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO hardcodear wallet addresses, private keys, or API keys -- use placeholder notation (0xYour..., your-key-here).
- CD-2: PROHIBIDO referenciar archivos que no existan en el codebase actual.
- CD-3: OBLIGATORIO cross-check every env var name against .env.example before including.
- CD-4: OBLIGATORIO cross-check every endpoint against src/routes/ before including.

## Missing Inputs

- [resuelto en F2] Exact list of env vars from .env.example (Dev reads file during implementation)
- [resuelto en F2] Exact L1-L4 diagram from CHAIN-ADAPTIVE.md (Dev reads file during implementation)

## Analisis de paralelismo

- Esta HU NO bloquea ninguna otra HU.
- Puede ejecutarse en paralelo con WKH-25 (a2a-key-middleware) y WKH-26 (hardening) -- es doc-only.
- Depende de que WKH-18, WKH-34, WKH-35, WKH-38 esten mergeados (ya lo estan).
