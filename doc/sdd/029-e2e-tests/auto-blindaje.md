# Auto-Blindaje — #029 E2E Test Suite

### [2026-04-06 08:46] Wave 0 — Incorrect relative path depth in setup.ts
- **Error**: All `vi.mock()` and `import` paths used `../../../` (3 levels up) instead of `../../` (2 levels up), causing "Failed to load url" errors.
- **Causa raiz**: The Story File's `buildTestApp Design` section specified paths like `../../../middleware/request-id.js`, but the file lives at `src/__tests__/e2e/setup.ts` which is only 2 directories deep under `src/` (not 3). The Story File paths assumed a deeper nesting.
- **Fix**: Replaced all `../../../` with `../../` in setup.ts. Verified with `node -e "path.resolve(...)"` before applying.
- **Aplicar en**: Any future test file placed in `src/__tests__/*/` subdirectories -- always count directory levels from the file location to `src/` before writing relative imports.
