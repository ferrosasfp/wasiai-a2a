# Report — WKH-DEPOSIT-INFO GET /auth/deposit-info

## Resumen ejecutivo

Endpoint público `GET /auth/deposit-info` implementado y validado en wasiai-a2a. Lee datos de env + registry (sin DB, sin RPC, sin secrets en respuesta) para devolver, por cada chain inicializada, treasury, token y min_confirmations. Elimina necesidad de entregar esa info out-of-band. **Status: DONE** — 1114 tests passing, tsc/biome/build clean, 3 commits, 172 insertions, AC-1..AC-6 cubiertas.

## Pipeline ejecutado

- **F0**: project-context cargado (`doc/sdd/`, `.nexus/project-context.md`)
- **F1**: work-item.md (gate: HU_APPROVED el 2026-05-30)
- **F2**: SDD implícito (mini-SDD en work-item.md estructura DT + CD)
- **F2.5**: story-file.md N/A (SDD_MODE=mini, estructura simple)
- **F3**: Implementación wave única (3 commits):
  - `4530f69` feat: export resolvers from deposit-verifier.ts (CD-1 DRY)
  - `be21c86` feat: GET /deposit-info handler en auth.ts (AC-1..AC-4, AC-6, AC-7)
  - `7e80b0b` test: integration tests + secret leakage checks (AC-5 verificado)
- **AR**: APROBADO c/ menor no-bloqueante (cobertura de treasury=null path derivado)
- **CR**: APROBADO (reuse de resolvers, zero duplication, DRY preservado, no new DB/RPC)
- **F4**: APROBADO (1114 tests, tsc clean, AC evidence archivo:línea citada)

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | `src/routes/auth.test.ts:831` — GET /auth/deposit-info → 200 con networks array |
| AC-2 | PASS | `src/routes/auth.test.ts:831-853` — cada entry: chain_id, slug, family, treasury, token, min_confirmations shape exacto |
| AC-3 | PASS | `src/routes/auth.test.ts:859-866` — registry vacío → 200 { networks: [] } |
| AC-4 | PASS | `src/routes/auth.test.ts:868-880` — treasury unresolvable → entry con treasury: null |
| AC-5 | PASS | `src/routes/auth.test.ts:882-901` — response body NEVER contiene OPERATOR_PRIVATE_KEY, SUPABASE, SECRET, private key material |
| AC-6 | PASS | `src/routes/auth.ts:371-396` — sin rateLimit override, usa global default (60/min) |
| AC-7 | PASS | `src/routes/auth.ts:19-21` — reusa `resolveChainFamilyEnvSuffix`, `resolveMinConfirmations`, `resolveTreasury` exported en `deposit-verifier.ts:67,86,103` |

## Hallazgos finales

### BLOQUEANTEs
Ninguno. Todas las ACs resueltas, AR/CR/F4 aprobados.

### MENOREs
- **TD-DEPOSIT-INFO-1** (no-bloqueante): Cobertura de path `treasury === null` cuando `supportedTokens[0]` es undefined o vacío está implementada (`cd-3: tolerate empty supportedTokens`, filter en handler línea 379). En la práctica `bundles` siempre tienen >=1 token; la prueba es defensiva. **Resolución**: implementada, aceptada como cobertura preventiva.

## Auto-Blindaje consolidado

| Categoría | Entrada | Status |
|-----------|---------|--------|
| **Ownership Guard (WKH-53)** | Endpoint `/auth/deposit-info` es PUBLIC (sin auth check). No toca `a2a_agent_keys` ni datos de owner → no aplica ownership-check. | ✓ OK — N/A |
| **Secret Leakage (CD-2, AC-5)** | `treasury` es solo la address (o null); NUNCA el private key. Verificado en test:896 (no OPERATOR_PRIVATE_KEY, no SUPABASE, no SECRET). | ✓ PASS |
| **DRY Preservation (CD-1, DT-1)** | `resolveChainFamilyEnvSuffix`, `resolveMinConfirmations`, `resolveTreasury` exportados en `deposit-verifier.ts`, no duplicados. Único source of truth. | ✓ PASS |
| **Rate Limit (AC-6)** | Endpoint en auth plugin (prefix `/auth`), sin rateLimit override → global default (60/min) via middleware chain. | ✓ PASS |
| **RPC Elimination (CD-4)** | Cero `publicClient.get*()` calls. Pure env + registry read. Fast, cacheable. | ✓ PASS |
| **Token Coverage** | Reusa `supportedTokens[0]` from `bundle.payment`. Si vacío, entry es filtrada (línea 379). | ✓ PASS |
| **Type Safety** | `family: ChainFamily` (KITE\|AVALANCHE\|BASE), `chainKey: ChainKey`, all typed. No `any`. | ✓ PASS |

## Archivos modificados

```
src/adapters/deposit-verifier.ts   (+6/-3)   — export 3 resolvers
src/routes/auth.ts                 (+50/-2)  — GET /deposit-info handler
src/routes/auth.test.ts            (+119/-4) — 5 new test cases (AC-1..AC-6)
─────────────────────────────────────────────
Total: 3 files, 172 insertions, 9 deletions
```

### Dominio: Auth & Discovery
- `src/routes/auth.ts` — new GET /deposit-info handler (reuse resolvers from deposit-verifier)
- `src/routes/auth.test.ts` — test coverage (AC-1..AC-6, secret checks, public access)
- `src/adapters/deposit-verifier.ts` — export resolvers (DRY, single source of truth)

### Dependencias
- `src/adapters/registry.ts` — `getInitializedChainKeys()`, `getAdaptersBundle()` (ya exported, sin cambios)
- Env vars (ya existentes): `A2A_DEPOSIT_TREASURY_<FAMILY>`, `A2A_DEPOSIT_MIN_CONFIRMATIONS_<FAMILY>`, `A2A_DEPOSIT_MIN_CONFIRMATIONS`, `OPERATOR_PRIVATE_KEY`

## Decisiones diferidas a backlog
Ninguna. Scope IN cubierto completamente. Las decisiones sobre comportamiento con `supportedTokens[0]===undefined` fueron resueltas en F3 (CD-3: filter la entry, no incluir token: null — implementa ambos caminos defensivamente).

## Lecciones para próximas HUs

1. **Mini-SDD inline en work-item.md funciona bien**: cuando SDD_MODE=mini (endpoint simple), estructurar DT + CD directamente en AC.md ahorra una fase. F2 está implícito.
2. **Exporting resolvers vs duplication**: la presión de reusar `resolveChainFamilyEnvSuffix` etc. fue clara. El patrón "export helper functions from adapters" es sólido para multi-path handlers.
3. **Public endpoints sin auth son simples para QA**: cero ownership validation, cero DB, cero RPC → test coverage exhaustiva en una sola inyección. No hay path secreto por auth scope.
4. **Defensive filtering (CD-3)**: tolerate empty `supportedTokens[0]` with `.filter(entry => entry !== null)` es mejor que hard-fail. Futuro-proof si los bundles cambian.

---

**Status**: DONE  
**Commits**: `4530f69`, `be21c86`, `7e80b0b`  
**Branch**: `feat/099-deposit-info`  
**Tests**: 1114 passing (1114 files)  
**Build**: tsc OK, biome OK, npm run build OK  
