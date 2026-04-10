# Work Item -- [WKH-BEARER-AUTH] Bearer Token as Alternative Auth Header

## Resumen

Add support for `Authorization: Bearer wasi_a2a_xxx` as an alternative authentication mechanism alongside the existing `x-a2a-key` custom header. Programmatic agents (e.g., Anthropic Managed Agents) have friction with custom headers; Bearer token is the universal standard. Backwards compatible: `x-a2a-key` takes priority when both are present.

## Sizing

- SDD_MODE: FAST+AR (auth-rbac risk category)
- Estimation: S
- Branch suggested: feat/032-bearer-auth

## Acceptance Criteria (EARS)

- AC-1: WHEN a request includes `Authorization: Bearer wasi_a2a_xxx` and no `x-a2a-key` header, the system SHALL extract the token value and process it through the existing key validation pipeline (hash, lookup, validate, debit).
- AC-2: WHEN a request includes both `x-a2a-key` and `Authorization: Bearer wasi_a2a_xxx` headers, the system SHALL use the `x-a2a-key` value (backwards compatibility priority).
- AC-3: WHEN a request includes `Authorization: Bearer <value>` where value does NOT start with `wasi_a2a_`, the system SHALL ignore the Bearer token and fall through to x402 payment flow (do not hijack third-party Bearer tokens).
- AC-4: WHEN a request includes `Authorization: Bearer wasi_a2a_xxx` with a valid key, the system SHALL return the same `x-a2a-remaining-budget` header and `request.a2aKeyRow` augmentation as the `x-a2a-key` path.
- AC-5: IF the `Authorization` header uses a scheme other than `Bearer` (e.g., `Basic`), THEN the system SHALL ignore it and fall through to x402 payment flow.

## Scope IN

- `src/middleware/a2a-key.ts` -- key extraction logic in the handler function (lines 79-84 area)
- `src/middleware/a2a-key.test.ts` -- new test cases for Bearer path

## Scope OUT

- No changes to identity, budget, or authz services
- No changes to x402 middleware
- No new env vars
- No DB schema changes
- No changes to route registrations

## Decisiones tecnicas (DT-N)

- DT-1: Extract Bearer token ONLY when prefix is `wasi_a2a_` -- this prevents the middleware from consuming Bearer tokens intended for other auth systems (e.g., OAuth, JWT). Non-matching Bearer values fall through to x402.
- DT-2: Priority order is `x-a2a-key` > `Authorization: Bearer wasi_a2a_*` > x402 fallback. This ensures zero breaking changes for existing consumers.
- DT-3: Bearer extraction is case-insensitive for the "Bearer" scheme keyword (per RFC 7235 section 2.1), but the token value itself (`wasi_a2a_*` prefix) is case-sensitive.

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO changing the behavior of requests that currently use `x-a2a-key` -- zero regression on existing auth path.
- CD-2: PROHIBIDO accepting Bearer tokens that do not start with `wasi_a2a_` -- prevents hijacking third-party auth.
- CD-3: OBLIGATORIO all existing tests continue to pass without modification.
- CD-4: OBLIGATORIO new tests cover: Bearer-only happy path, both-headers priority, non-wasi Bearer fallthrough, wrong scheme fallthrough, Bearer with invalid key (403).

## Missing Inputs

- None. All inputs resolved.

## Analisis de paralelismo

- This HU does NOT block any other HU.
- This HU does NOT depend on any in-progress HU.
- Can be implemented independently on its own branch.
