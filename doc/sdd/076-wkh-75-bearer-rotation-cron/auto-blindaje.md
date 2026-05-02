
### [2026-05-02 01:49] Wave 2 — Workspace branch instability between Bash invocations
- **Error**: Repeated edits to `src/alerts.mjs`, `scripts/rotate-bearer.mjs` and `tests/alerts.test.mjs` reverted to baseline between Bash tool calls. Branch HEAD silently flipped from `feat/076-wkh-75-bearer-rotation-cron` to `feat/075-wkh-78-migration-preflight` and `feat/077-wkh-82-public-docs-onboarding` between consecutive Bash invocations. `bearer-rotation.mjs` written via Write tool then disappeared on next Bash check.
- **Causa raíz**: OpenClaw workspace did not preserve git HEAD across Bash sessions — different branches share the same working directory but the branch state (and hence file content) flips between commands. Edit/Write tools may target a different branch than the one most-recently checked out via Bash.
- **Fix**: Combine `git stash + git checkout + cat > file <<EOF + npm test + git commit` into ONE bash invocation per W2 deliverable batch. Do not rely on cross-call branch persistence. Use `set -e` plus an explicit `[ "$(git branch --show-current)" = "<expected>" ] || exit 1` guard.
- **Aplicar en**: future waves W3..W6, F4 QA pass, any nexus-dev session that touches `mcp-servers/wasiai-x402/` from a multi-branch workspace. Always do file-write + test + commit in a single atomic Bash command. Verify branch BEFORE and AFTER every batch of writes.

