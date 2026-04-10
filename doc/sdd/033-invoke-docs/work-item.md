# Work Item -- [WKH-INVOKE-DOCS] Clarify proxy invocation pattern in Agent Card and /discover

## Resumen

Agents discovered via wasiai-a2a must be invoked through the gateway (POST /compose or /orchestrate), NOT by calling the agent's external host directly. The current /discover response returns `invokeUrl` pointing to external registries, which causes managed agents to attempt direct HTTP calls (HTTP 000 failures). This HU adds metadata fields and documentation to make the proxy pattern explicit.

## Sizing

- SDD_MODE: mini
- Estimation: S
- Branch: feat/033-invoke-docs
- Flow: FAST (docs/metadata only, no auth, no DB changes)

## Acceptance Criteria (EARS)

- AC-1: WHEN a client fetches `GET /.well-known/agent.json`, the response body SHALL include a field `invocationNote` (string) explaining that agent invocations must go through POST /compose or POST /orchestrate on this gateway, not directly to external hosts.
- AC-2: WHEN a client fetches `GET /discover` or `GET /discover/:slug`, each agent object in the response SHALL include an `invocationNote` field (string) stating that the `invokeUrl` is an internal reference and the caller must use POST /compose or POST /orchestrate on the gateway.
- AC-3: WHEN a reader views the README, there SHALL be a section (or updated existing section) under Discovery that documents the proxy invocation pattern: discover agents, then invoke via /compose or /orchestrate.

## Scope IN

- `src/services/agent-card.ts` -- add `invocationNote` to `buildSelfAgentCard()` and `buildAgentCard()`
- `src/services/discovery.ts` -- add `invocationNote` to the Agent object returned by `mapAgent()`
- `src/types/index.ts` -- add optional `invocationNote?: string` to `Agent` interface and `AgentCard` interface (or as an extension field)
- `README.md` -- add/update discovery section with proxy invocation guidance

## Scope OUT

- No changes to /compose or /orchestrate logic
- No changes to authentication or payment flows
- No DB schema changes
- No new endpoints
- No removal or rewriting of `invokeUrl` (it stays as-is for internal gateway use)

## Decisiones tecnicas (DT-N)

- DT-1: Use a string field `invocationNote` rather than restructuring the Agent Card URL, because changing `url` or `invokeUrl` would break existing consumers. The note is additive.
- DT-2: The `invocationNote` text SHALL include the literal endpoint paths (`POST /compose`, `POST /orchestrate`) so consumers can parse or display it.

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO remove or modify the existing `invokeUrl` field -- it is used internally by /compose pipeline execution.
- CD-2: OBLIGATORIO the `invocationNote` field must be present in every agent object returned by /discover (not optional/sometimes-missing).

## Missing Inputs

- [resuelto en F2] Exact wording of the `invocationNote` string -- Architect decides in SDD.

## Analisis de paralelismo

- This HU does NOT block other HUs.
- Can run in parallel with WKH-028 (README rewrite) but needs coordination on README section to avoid merge conflicts.
- No dependency on WKH-025 (A2A Key Middleware) or WKH-026 (Hardening).
