# Auto-Blindaje -- WKH-38

### [2026-04-06 18:08] Wave 3 -- vi.mock factory hoisting with kiteClient named export

- **Error**: Tests failed with `ReferenceError: Cannot access 'mockReadContract' before initialization` because `vi.mock` factory is hoisted above `const mockReadContract = vi.fn()`.
- **Causa raiz**: The original test used `const mockGetBlock = vi.fn()` which appeared to work because `requireKiteClient` returns a function (lazy eval), but adding `kiteClient` as a direct object property in the mock factory evaluated `mockReadContract` at hoist time before its declaration.
- **Fix**: Used `vi.hoisted()` to declare both `mockGetBlock` and `mockReadContract`, ensuring they exist before the hoisted `vi.mock` factory runs.
- **Aplicar en**: Any future test that adds named exports (not function-wrapped) to an existing `vi.mock` factory must use `vi.hoisted()` for the mock functions.
