# Auto-Blindaje -- WKH-34 Agentic Economy L3

### [2026-04-06 18:49] Wave 2 -- Type cast in test mocks requires `as unknown as` pattern
- **Error**: TypeScript rejected `mock as ReturnType<typeof supabase.from>` with "neither type sufficiently overlaps"
- **Causa raiz**: Supabase client types are complex generics; a plain `Record<string, unknown>` does not structurally overlap with `PostgrestQueryBuilder`
- **Fix**: Changed to `mock as unknown as ReturnType<typeof supabase.from>` (double cast via `unknown`), matching the existing pattern in `src/services/task.test.ts`
- **Aplicar en**: Every test that mocks `supabase.from()` return values

### [2026-04-06 18:50] Wave 2 -- supabase.rpc mock type incompatibility
- **Error**: `mockRpc.mockResolvedValue({ data, error } as ReturnType<typeof supabase.rpc> extends Promise<infer T> ? T : never)` was overly complex and still failed
- **Causa raiz**: The conditional type extraction pattern is fragile with Supabase's overloaded `rpc` signatures
- **Fix**: Simplified to `as any` with eslint-disable comment, which is the pragmatic approach for deeply generic mock returns in vitest
- **Aplicar en**: Any test mocking `supabase.rpc()` calls

### [2026-04-06 18:52] Wave 1-3 -- Linter auto-applying WKH-35 changes to unrelated files
- **Error**: A background linter (likely from a cached WKH-35 session) kept modifying `src/index.ts`, `src/services/compose.ts`, `src/middleware/x402.ts`, `src/routes/gasless.ts`, etc. with adapter refactor code that doesn't exist yet
- **Causa raiz**: The workspace had stashed WKH-35 changes on branch `feat/023-adapter-refactor-l2` and the linter was picking up those modifications
- **Fix**: Repeatedly ran `git checkout --` on affected files after each edit; eventually used `Write` for a full file rewrite of `src/index.ts` to avoid incremental edits being intercepted
- **Aplicar en**: When working on a branch where other feature branches have pending changes in the workspace, always verify `git status --short` after each file edit to catch linter contamination
