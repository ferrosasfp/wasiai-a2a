# Auto-Blindaje -- 038-biome-linter

### [2026-04-11 00:20] Wave 1 -- biome --write converts function() to arrow in mockImplementation
- **Error**: `biome check --write --unsafe` converted `vi.fn().mockImplementation(function () { ... })` to arrow function `() => ({ ... })`. Arrow functions cannot be used as constructors, so `new Anthropic(...)` failed with "is not a constructor".
- **Causa raiz**: Biome's `useArrowFunction` rule auto-fixes `function()` expressions that don't use `this`. But vitest mocks that simulate class constructors (used with `new`) require traditional functions.
- **Fix**: Reverted to `function()` syntax and added `// biome-ignore lint/complexity/useArrowFunction: must use function() for new-able mock constructor` on both affected files.
- **Aplicar en**: Any test file that mocks a class constructor (e.g., `@anthropic-ai/sdk`, `viem` clients). Always review `biome check --write` output in test files for constructor mock patterns.

### [2026-04-11 00:20] Wave 1 -- noNonNullAssertion auto-fix produces optional chaining that narrows to undefined
- **Error**: Biome auto-fixed `client.account!` to `client.account?.` and `nextAgent!.id` to `nextAgent?.id`, changing the type from `T` to `T | undefined`, which caused TS2345 errors.
- **Causa raiz**: The `noNonNullAssertion` fix blindly replaces `!` with `?`, but the downstream code expects the non-nullable type.
- **Fix**: Replaced non-null assertions with explicit guards (`if (!x) throw new Error(...)`) or captured into a const after the null check.
- **Aplicar en**: Any code with `!` assertions -- always manually fix with guards instead of relying on biome auto-fix.
