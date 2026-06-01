# Auto-Blindaje — WKH-104 (F3)

### [2026-05-31 18:08] Wave 0 — `process.env.X = undefined` no borra la env var
- **Error**: en `caller-hash.test.ts` el test de fallback warn fallaba (`console.warn` 0 veces). Biome además marcaba el assignment.
- **Causa raíz**: `process.env.REPUTATION_CALLER_HMAC_SECRET = undefined` coacciona a la string `"undefined"` (no-vacía, truthy) → `resolveCallerHashSecret` la trata como secret válido y nunca entra al fallback.
- **Fix**: usar `delete process.env.REPUTATION_CALLER_HMAC_SECRET` para realmente desetear la var antes del test de fallback.
- **Aplicar en**: cualquier test que dependa de la AUSENCIA de una env var. `= undefined` NO borra; usar `delete`.

### [2026-05-31 18:11] Wave 2 — Test-pollution por `mockResolvedValueOnce` no consumido
- **Error**: T-SYBIL-2 (failed compose_step) pasaba en aislamiento (`-t`) pero fallaba en la suite completa: el track esperado con `status='failed'` no aparecía.
- **Causa raíz**: `vi.clearAllMocks()` (beforeEach) NO limpia las colas de `mockResolvedValueOnce`. Un test previo dejaba un once-value de `mockFetchOk` en la cola de `mockFetch`; mi test lo consumía → fetch OK → success path en vez de failed.
- **Fix**: en los 3 tests nuevos de compose, `mockFetch.mockReset()` + `mockFetch.mockResolvedValue(...)` (persistente, no once) para no depender del estado de la cola global.
- **Aplicar en**: cualquier test nuevo que use el `mockFetch` global con `vi.stubGlobal`. Resetear la cola o usar valores persistentes, no once-values heredables.

### [2026-05-31 18:16] Wave 4 — `describe.skipIf` evalúa el cuerpo del describe
- **Error**: el test e2e fallaba (1 failed) incluso sin env: `createClient('', '')` lanzaba en el top-level del callback del `describe`.
- **Causa raíz**: `describe.skipIf(cond)` solo skippea los `it`/hooks, NO evita que el cuerpo de la callback del describe se ejecute al registrar la suite. Construir el cliente Supabase con strings vacías ahí explotaba.
- **Fix**: declarar `let supabase: SupabaseClient;` y crear el cliente DENTRO de `beforeAll` (que sí se skippea cuando el describe está skipped). Cualquier setup que pueda lanzar va en hooks, no en el cuerpo del describe.
- **Aplicar en**: todo test gateado por env con `describe.skipIf`. Setup costoso/que-lanza siempre en `beforeAll`, nunca en el cuerpo del describe.
