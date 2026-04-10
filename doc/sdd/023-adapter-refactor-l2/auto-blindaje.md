### [2026-04-06 19:00] Wave 3-6 -- External linter/formatter reverting file writes
- **Error**: Write tool successfully wrote full file replacements for x402.ts, compose.ts, gasless routes, index.ts -- but an external process (likely linter/formatter or IDE watcher) reverted the files to their original git content within milliseconds.
- **Causa raiz**: The project has an auto-formatting tool that triggers on file save. When the Write tool creates files, the formatter rewrites them (compacting code). When the Edit tool modifies tracked files, the watcher sometimes restores the original content if the modification is detected as "external".
- **Fix**: Used Edit tool for incremental changes on tracked files (which worked reliably for small edits). For large rewrites, used Write tool but verified immediately with git diff that changes persisted. For test files and new files, Write tool worked consistently.
- **Aplicar en**: Any future HU that modifies multiple tracked files. Prefer Edit (diffs) over Write (full replace) for tracked files. Always verify with git diff after writes.

### [2026-04-06 19:05] Wave 3 -- compose.test.ts mock not intercepting registry
- **Error**: compose.test.ts was mocking `../lib/x402-signer.js` and `../middleware/x402.js` but compose.ts now imports from `../adapters/registry.js`. Tests failed with "Adapters not initialized".
- **Causa raiz**: When compose.ts changed from direct imports to registry imports, the test mocks needed to be updated to mock the registry module instead.
- **Fix**: Replace `vi.mock('../lib/x402-signer.js')` and `vi.mock('../middleware/x402.js')` with `vi.mock('../adapters/registry.js', () => ({ getPaymentAdapter: () => ({ sign: mockSign, settle: mockSettle }) }))`.
- **Aplicar en**: Any consumer test that mocks direct module imports must be updated when the consumer switches to registry-based imports.

### [2026-04-06 18:55] Wave W-1 -- Wrong branch from previous HU attempt
- **Error**: Started on branch `feat/024-agentic-economy-l3` from a previous aborted session instead of creating fresh `feat/023-adapter-refactor-l2` from main.
- **Causa raiz**: Previous session left adapter files and WKH-34 files that conflated the working state.
- **Fix**: Switched to main, cleaned working tree with `git checkout --`, deleted old branch, and created fresh `feat/023-adapter-refactor-l2` from clean main.
- **Aplicar en**: Always verify `git branch --show-current` and `git status --short` at Wave -1 before any code changes.
