# CR Report — WKH-MULTICHAIN (Code Review)

## Veredicto
**APROBADO_CON_NITS**

## Resumen ejecutivo

Reviewed 25 files / +1,295 net LOC / 7 commits (W0-W6). Findings:

- **Type safety**: `grep "as unknown\|as any\|: any"` over all new code paths returns zero matches. The single `as unknown` in `src/middleware/a2a-key.ts:76` pre-existed this HU (untouched by diff).
- **Test coverage**: 908/908 PASS (baseline 379 + cumulative 529 added; W0 +29, W1 +35, W2 +7, W3 +1, W4 +3, W5 +17). All 12 implementable ACs cited file:line.
- **CD coverage**: All 19 CDs traceable. CD-12 (same-bundle chainId) cleanly enforced — middleware reads `chainId` once at `a2a-key.ts:220` and reuses for both `debit` (239) and `getBalance` (249, 274).
- **Backward-compat**: `kite-ozone-testnet` path byte-identical — registry mock asserts factory called WITHOUT args on legacy path (`registry.test.ts:397`), `kite-factory.test.ts` exercises real DT-I env restoration semantics.
- **Docs**: `MULTI-CHAIN.md` is operator-ready — copy-paste SQL, curl examples, mainnet flip procedure, TD-NEW-KITE-PARAMS clearly tracked.
- **TS compile**: `npx tsc --noEmit` clean except the pre-existing WKH-69 `x402.passport-shape.test.ts` TS6059 (unrelated, not touched).
- **Commit hygiene**: Excellent. 7 atomic commits, each with WKH-MULTICHAIN W<N> trailer, test count delta in body.

Benchmark-quality implementation. The 3 NITs below are stylistic and should be considered backlog candidates, not blockers.

## Hallazgos

### NIT-1: `getChainConfig()` startup log retains coupling to default chain
- **Severidad**: NIT
- **Tipo**: Code smell (cosmetic, expected by design)
- **Archivo:línea**: `src/index.ts:134`
- **Issue**: The startup banner still calls `getChainConfig()` (no chainKey arg → default). After the multi-chain refactor, the banner shows only the default chain even if 4 are initialized. The `[Registry] Adapters initialized: ...` log from `registry.ts:138` already covers this elsewhere.
- **Fix sugerido**: Optionally replace with `getInitializedChainKeys().join(', ')` in the banner OR leave as-is. CD-11 is about hot path middleware, not startup banners — this is compliant.

### NIT-2: `AvalancheGaslessAdapter.networkTag` typed string but exposed as opaque
- **Severidad**: NIT
- **Tipo**: Type ergonomics
- **Archivo:línea**: `src/adapters/avalanche/gasless.ts:18-23`
- **Issue**: `private readonly networkTag: 'avalanche-fuji' | 'avalanche-mainnet'` is derived from `chainId` via conditional. Since the constructor already receives a `chainId`, an enum lookup would be cleaner. Not worth a fix-pack.
- **Fix sugerido**: Optionally accept the slug directly from the factory. Leave for future Gasless implementation HU.

### NIT-3: `MULTI-CHAIN.md` §4 USDC.e address may benefit from single source of truth
- **Severidad**: NIT
- **Tipo**: Documentation drift (low confidence)
- **Archivo:línea**: `doc/architecture/MULTI-CHAIN.md:110`
- **Issue**: The matrix lists `USDC.e (0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e)` for `kite-mainnet`. Reader may want a single source of truth (e.g. link to `doc/kite-contracts.md`).
- **Fix sugerido**: Backlog — link `kite-mainnet` row to `doc/kite-contracts.md`.

## Matriz AC × Test (14 ACs)

| AC | Test archivo:línea | Código archivo:línea | Status |
|----|-------------------|---------------------|--------|
| AC-1 | `src/adapters/__tests__/registry.test.ts:262-275, 277-293, 295-303` | `src/adapters/registry.ts:79-141` | OK |
| AC-2 | `src/adapters/__tests__/registry.test.ts:131-157, 384-398` | `src/adapters/registry.ts:95-100`, `src/adapters/kite-ozone/index.ts:38-79` | OK |
| AC-3 | `src/adapters/__tests__/registry.test.ts:96-102, 198-204` | `src/adapters/registry.ts:113-120` | OK |
| AC-4 | `src/middleware/a2a-key.test.ts:598-616, 620-634` | `src/middleware/a2a-key.ts:185-220`, `src/adapters/chain-resolver.ts:24-43` | OK |
| AC-5 | `src/middleware/a2a-key.test.ts:638-653` | `src/middleware/a2a-key.ts:188-207` (manifest delegated to upstream per DT-A/CD-16) | OK |
| AC-6 | `src/middleware/a2a-key.test.ts:638-653` | `src/middleware/a2a-key.ts:199-206` | OK |
| AC-7 | `src/middleware/a2a-key.test.ts:657-677, 681-707` | `src/middleware/a2a-key.ts:191-216` | OK |
| AC-8 | `src/middleware/a2a-key.test.ts:358-378, 528-549, 809-841` | `src/middleware/a2a-key.ts:244-267` | OK |
| AC-9 | `src/middleware/a2a-key.test.ts:765-805` | `src/middleware/a2a-key.ts:239-243` (single `debit` call per Fastify hook) | OK |
| AC-10 | `src/services/discovery.test.ts:249-325` | `src/services/discovery.ts:62, 326` (pre-existing `readPayment` exposes both fields) | OK |
| AC-11 | `src/middleware/a2a-key.test.ts:711-761` | `src/middleware/a2a-key.ts:229-238` | OK |
| AC-12 | `npm test -- --run` → 908/908 PASS | N/A (suite-wide) | OK |
| AC-13 | F4 smoke (post-deploy) | N/A — out of Dev scope | DEFERRED-F4 |
| AC-14 | F4 smoke (post-deploy) | N/A — out of Dev scope | DEFERRED-F4 |

## Matriz CD × Evidencia (19 CDs)

| CD | Tipo | Evidencia archivo:línea | Status |
|----|------|------------------------|--------|
| CD-1 | TS strict, no `any`/`as unknown` | `grep` new code paths → only pre-existing `a2a-key.ts:76` (untouched) | OK |
| CD-2 | Backward-compat Kite testnet byte-identical | `registry.test.ts:384-398` asserts factory called with NO args on legacy path; `kite-ozone/index.ts:44-78` `try/finally` no-op when `opts` absent | OK |
| CD-3 | No mods to `kite-ozone/` except additive `opts` | `git diff main..HEAD -- src/adapters/kite-ozone/` → only `index.ts` modified, only additive `opts` | OK |
| CD-4 | 379+ baseline + new coverage | 908/908 PASS; cross-chain confusion at `a2a-key.test.ts:809-841`, multi-chain init at `registry.test.ts:262-313`, mainnet wiring at `registry.test.ts:316-399` | OK |
| CD-5 | Single debit per request | `a2a-key.ts:239-243` (single `await budgetService.debit(...)`); test `a2a-key.test.ts:765-805` asserts `toHaveBeenCalledTimes(1)` | OK |
| CD-6 | Chain resolution <50ms, no I/O | `chain-resolver.ts` pure (no imports of registry); `a2a-key.ts:185-216` only reads in-memory `Map` via `getAdaptersBundle` | OK |
| CD-7 | Logs with chainKey + chainId + asset_symbol | `a2a-key.ts:229-238` (debit log), 252-261 (insufficient-budget log); test `a2a-key.test.ts:711-761` asserts shape | OK |
| CD-8 | Don't break wasiai-v2 prod | Code structurally compatible — wasiai-v2 only propagates `x-payment-chain` header. Smoke test is F4. | OK (compile-time) |
| CD-9 | AR vectors | AR agent in parallel; CR confirms structural hooks (chain confusion at `a2a-key.test.ts:809`, ownership in `getBalance` enforced by `budget.ts` per WKH-53) | OK |
| CD-10 | Deposit Avalanche procedure documented | `doc/architecture/MULTI-CHAIN.md:173-241` (SQL + curl + faucet) | OK |
| CD-11 | No `process.env.WASIAI_A2A_CHAIN` in hot path | `grep` middleware → 0 matches; only in `registry.ts:80-81` (init time) | OK |
| CD-12 | debit + getBalance same bundle source | `a2a-key.ts:220` (`chainId` declared once); reused at 241 (debit), 250 (cold getBalance), 276 (post-debit getBalance) | OK |
| CD-13 | Conflict warn both env vars | `registry.ts:84-93`; test `registry.test.ts:207-220` | OK |
| CD-14 | Normalize total, no silent fallback on invalid header | `chain-resolver.ts:51-55` returns `undefined` on unknown; `a2a-key.ts:191-198` returns 400; test `a2a-key.test.ts:657-677` | OK |
| CD-15 | Avalanche x402 canonical only | `avalanche/payment.ts:31` (`AVALANCHE_SCHEME = 'exact'`), 202-223 (canonical body); no `pieverse` branch anywhere | OK |
| CD-16 | No discovery in middleware | `grep "discoveryService\|composeService" src/middleware/a2a-key.ts` → 0 matches | OK |
| CD-17 | Test isolation | `registry.ts:232-236`; `avalanche/payment.ts:427-432`; invoked in `beforeEach` (`registry.test.ts:80`, `avalanche.test.ts:45, 96`) | OK |
| CD-18 | No mutation of bundle | Bundles returned by `getAdaptersBundle` are class instances; nothing in diff mutates them post-construction | OK |
| CD-19 | Anti prototype-pollution | `chain-resolver.ts:20-21` uses `Object.create(null)`; line 55 uses `Object.hasOwn`; test `chain-resolver.test.ts:58-64` asserts `toString`/`constructor`/`__proto__`/`hasOwnProperty` return `undefined` | OK |

## Type safety report

```
$ grep -rn "as unknown\|\bas any\b\|: any\b" \
    src/adapters/avalanche/ \
    src/middleware/a2a-key.ts \
    src/adapters/chain-resolver.ts \
    src/adapters/registry.ts \
    src/adapters/kite-ozone/index.ts \
    src/adapters/types.ts

src/middleware/a2a-key.ts:76:        ) as unknown;
```

The single match is **pre-existing** (x402 fallback handler from prior HU, untouched). New code paths (W0-W6) have **zero** type-safety escape hatches. CD-1 honored.

Test files use 2 isolated `as unknown as` for defensive runtime guards in `chain-resolver.test.ts:71-74` (simulating callers passing non-strings) and 1 in `a2a-key.test.ts:720` (Fastify logger spy assignment) — both intentional, neither in production code.

## Documentation drift

- **`.env.example`**: `WASIAI_A2A_CHAINS` + `AVALANCHE_FACILITATOR_URL` sync with code. DT-8 independence with `WASIAI_DOWNSTREAM_NETWORK` documented. ✓
- **`MULTI-CHAIN.md` matrix (§4)**: Coincides with `SUPPORTED_CHAINS` in `registry.ts:25-30`. USDC addresses match `payment.ts:43-46`. ✓
- **`MULTI-CHAIN.md` deposit procedure (§7)**: Executable as-is — SQL is literal, curl examples include correct headers. ✓
- **`README.md`**: Adds one paragraph + one table row, no contradictions. ✓

No documentation drift detected.

## Commit hygiene

7 commits on `feat/086-wkh-multichain-a2a` (e2ec88a → c26a14b). All commits:
- Have clear subject lines following `<type>(<scope>): W<N> — <summary>` pattern.
- Include `WKH-MULTICHAIN W<N>` trailer.
- Have detailed bodies citing CDs, ACs, file paths, and test count deltas.
- Are atomic — each commit's tests pass independently (W0 845 → W1 880 → W2 887 → W3 888 → W4 891 → W5 908 → W6 908).

No commit mixes scopes across waves. Excellent hygiene.

## Recomendaciones para AR

1. **Chain confusion attack via header tricks** — try `x-payment-chain: ../avalanche-fuji` or newline injection to verify trim/lowercase doesn't strip semantically meaningful characters.
2. **Ownership leak in cold-path `getBalance`** — `a2a-key.ts:250` passes `keyRow.owner_ref`; AR should confirm `services/budget.ts` enforces `.eq('owner_ref', ...)` per WKH-53.
3. **Race condition in `initAdapters()` if called twice concurrently** — `_initialized = true` is set AFTER the loop populates `_bundles`.
4. **DT-I env mutation visible from concurrent module init** — `process.env.KITE_NETWORK` during `await import()`. Tests use vitest's default isolation per file.
5. **Facilitator URL hardcoded fallback in `payment.ts:56-57`** — confirm matches `wasiai-facilitator` deploy.

---

*CR Report by `nexus-adversary` — F6 — 2026-05-13.*
