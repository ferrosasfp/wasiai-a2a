# Story File — WKH-57 / WAS-V2-3-CLIENT

> Self-contained contract for Dev (F3). Read this file front-to-back ONCE. You don't need to re-open the SDD or work-item.
> Branch: `feat/057-wkh-57-was-v2-3-client` from `main` (`91adc29` or later).
> Mode: QUALITY • Sizing: S • Estimated dev: 30-45 min.

---

## Mission

Add a defensive fallback in `discoveryService.mapAgent` (`src/services/discovery.ts:229`) so that when the canonical price field configured by the registry (`price_per_call_usdc` for `wasiai-v2`) is `null`/`undefined`, the system reads the alternate field `price_per_call`. This prevents `priceUsdc` from collapsing silently to `0`, which today bypasses the downstream Fuji USDC settle guard at `compose.ts:249` (`if (agent.priceUsdc > 0)`).

The change is surgical: ~10 LOC of production code in `discovery.ts` + 16 new tests across 2 test files. **NO** changes to `compose.ts`, `types/index.ts`, `registry.ts`, the wasiai-v2 source, or DB migrations.

---

## §1 — Scope IN (paths exactos)

| # | Archivo | Operación | Líneas afectadas (aprox) |
|---|---------|-----------|--------------------------|
| 1 | `src/services/discovery.ts` | **Modificar** | Add module constants near top (post imports, ~line 15-20). Replace line 229 with helper call. Add 2 helpers + 1 test-only reset export at end of file (~lines 290-340). |
| 2 | `src/services/discovery.test.ts` | **Modificar** | Add 2 new `describe` blocks (`parsePriceSafe` and `mapAgent — v2 schema drift fallback (WAS-V2-3-CLIENT)`). 15 new tests. Append at end of file (after line 237 of current state). |
| 3 | `src/services/compose.test.ts` | **Modificar** | Add 1 new `describe` block (`composeService — WAS-V2-3-CLIENT integration (WKH-57)`) with 1 integration test (`T-INT-01`). Append after line 399 of current state. |

**Anything outside these 3 files is OUT OF SCOPE. CD-12 enforces this.**

---

## §2 — Acceptance Criteria + Test Plan inline

| AC | EARS statement | Test ID | Test file | Mock setup | Expected assertion |
|----|---------------|---------|-----------|-----------|-------------------|
| **AC-1** | WHEN `mapAgent` processes a v2 raw where `price_per_call_usdc` is `null`/`undefined` AND `price_per_call` is numeric, THEN `agent.priceUsdc === price_per_call`. | `T-fallback-numeric` | discovery.test.ts | `makeV2Registry()` + `{price_per_call_usdc: null, price_per_call: 0.05, ...}` direct call to `discoveryService.mapAgent(reg, raw)` | `expect(agent.priceUsdc).toBe(0.05)` |
| AC-1 (variant) | (same — undefined canonical) | `T-fallback-undefined-canonical` | discovery.test.ts | `{price_per_call: 0.10, ...}` (no `price_per_call_usdc` key at all) | `expect(agent.priceUsdc).toBe(0.10)` |
| **AC-2** | WHEN both fields populated with distinct numerics, THEN canonical wins; fallback NOT consulted. | `T-canonical-wins` | discovery.test.ts | `{price_per_call_usdc: 0.20, price_per_call: 0.99, ...}` + `vi.spyOn(console, 'warn')` | `expect(agent.priceUsdc).toBe(0.20)` AND `expect(warnSpy).not.toHaveBeenCalled()` |
| AC-2 (edge) | (canonical=0 explicit wins over fallback) | `T-canonical-zero-wins` | discovery.test.ts | `{price_per_call_usdc: 0, price_per_call: 0.05, ...}` | `expect(agent.priceUsdc).toBe(0)` (canonical 0 is valid; do NOT take fallback) |
| **AC-3** | WHEN both `null`/`undefined`/absent, THEN `priceUsdc === 0`. | `T-both-null` | discovery.test.ts | `{price_per_call_usdc: null, price_per_call: null, ...}` + `vi.spyOn(console, 'warn')` | `expect(agent.priceUsdc).toBe(0)` AND `expect(warnSpy).not.toHaveBeenCalled()` (no fallback was actually used) |
| **AC-4** | WHEN `composeService.compose` invoked with step whose agent has `priceUsdc > 0` resolved via fallback, THEN downstream Fuji USDC settle path is entered. | `T-INT-01` | compose.test.ts | `vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(makeAgent({slug: 'v2-fallback-agent', priceUsdc: 0.05, payment: {method:'x402', chain:'avalanche', contract:'0x...aBcD'}, metadata:{payTo:'0x...aBcD'}}))` + `mockDownstream.mockResolvedValue({txHash:'0xfeeb', blockNumber:42, settledAmount:'50000'})` + `mockFetchOk()` | `expect(mockDownstream).toHaveBeenCalledTimes(1)` AND `expect(result.steps[0].downstreamTxHash).toBe('0xfeeb')` |
| **AC-5** happy | WHEN fallback value is parseable string, THEN parsed to finite number. | `T-fallback-string-parseable` | discovery.test.ts | `{price_per_call_usdc: null, price_per_call: '0.05', ...}` | `expect(agent.priceUsdc).toBe(0.05)` |
| AC-5 sad | WHEN fallback is non-parseable string, THEN `priceUsdc === 0`. | `T-fallback-string-non-parseable` | discovery.test.ts | `{price_per_call_usdc: null, price_per_call: 'free', ...}` | `expect(agent.priceUsdc).toBe(0)` |
| **AC-6** emit | WHEN fallback path taken, THEN exactly one `console.warn` per slug per process lifetime. | `T-warn-emitted-on-fallback` | discovery.test.ts | spy `console.warn`, single `mapAgent` call with fallback for slug `v2-agent` | `expect(warnSpy).toHaveBeenCalledTimes(1)` AND `expect(warnSpy.mock.calls[0][0]).toContain('v2-agent')` AND `.toContain('fallback')` |
| AC-6 dedup | WHEN same slug enters fallback twice, THEN only ONE warn total. | `T-warn-once-per-slug` | discovery.test.ts | `_resetFallbackWarnDedup()` in `beforeEach`, then 2× `mapAgent` with same slug + fallback | `expect(warnSpy).toHaveBeenCalledTimes(1)` |
| **AC-7** | Pre-existing 463-test baseline stays green; new tests cover all ACs above. | (suite + diff) | — | run `npx vitest run` after each wave | `Test Files  N passed` AND `Tests  463+ passed` (target: 479) |

### Helper-only tests (W0, support `parsePriceSafe`)

| Test ID | Input | Expected output | AC |
|--------|------|----------------|----|
| `T-PARSE-1` | `parsePriceSafe(0.05)` | `0.05` | AC-1 (number passthrough) |
| `T-PARSE-2` | `parsePriceSafe('0.05')` | `0.05` | AC-5 happy |
| `T-PARSE-3` | `parsePriceSafe('free')` | `0` | AC-5 sad |
| `T-PARSE-4` | `parsePriceSafe(null)` AND `parsePriceSafe(undefined)` | `0` | AC-3 |
| `T-PARSE-5` | `parsePriceSafe(-1.0)` AND `parsePriceSafe(NaN)` AND `parsePriceSafe(Infinity)` | `0` | CD-7 safe floor |
| `T-PARSE-6` | `parsePriceSafe('')` | `0` | AB-WKH-53-#3 (empty string) |

**Total tests added: 6 (W0) + 9 (W1) + 1 (W2) = 16. Baseline 463 → expected total 479.**

---

## §3 — Waves de implementación (3 waves)

### W0 — Helper standalone `parsePriceSafe` + 6 unit tests (~10 min)

**Pre-conditions**:
- Branch `feat/057-wkh-57-was-v2-3-client` created from `main`.
- `npm test` baseline green (~463 tests).
- `discovery.ts` open at lines 200-300.

**Actions**:

1. In `src/services/discovery.ts`, add module-scoped constants and `parsePriceSafe` exported helper. Place AFTER existing helpers (after `toAgentStatus`, around line 299):

   ```ts
   // ─── WAS-V2-3-CLIENT (WKH-57): defensive fallback for v2 schema drift ──

   /** Field name used as fallback when registry's canonical price path is null/undefined. */
   const V2_PRICE_FALLBACK_FIELD = 'price_per_call' as const;

   /**
    * Parses a raw value (number | string | null | undefined) into a finite,
    * non-negative number. Returns 0 for any of: null, undefined, NaN, Infinity,
    * negative number, non-parseable string, empty string.
    *
    * Pattern: mirrors `getProtocolFeeRate` in fee-charge.ts (Number.parseFloat
    * + Number.isFinite). CD-7 safe floor applies — never inflate via fallback.
    */
   export function parsePriceSafe(raw: unknown): number {
     if (raw === null || raw === undefined) return 0;
     if (typeof raw === 'number') {
       return Number.isFinite(raw) && raw >= 0 ? raw : 0;
     }
     if (typeof raw === 'string') {
       if (raw === '') return 0;
       const parsed = Number.parseFloat(raw);
       return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
     }
     return 0;
   }
   ```

2. In `src/services/discovery.test.ts`, append a new top-level describe (after line 237 / end of current file):

   ```ts
   import { discoveryService, parsePriceSafe } from './discovery.js';
   // ↑ already importing discoveryService — add parsePriceSafe to the same import

   describe('parsePriceSafe (W0 — WAS-V2-3-CLIENT helper)', () => {
     it('T-PARSE-1: number passthrough returns finite positive', () => {
       expect(parsePriceSafe(0.05)).toBe(0.05);
     });
     it('T-PARSE-2: parseable string returns parsed number', () => {
       expect(parsePriceSafe('0.05')).toBe(0.05);
     });
     it('T-PARSE-3: non-parseable string returns 0', () => {
       expect(parsePriceSafe('free')).toBe(0);
       expect(parsePriceSafe('N/A')).toBe(0);
     });
     it('T-PARSE-4: null/undefined return 0', () => {
       expect(parsePriceSafe(null)).toBe(0);
       expect(parsePriceSafe(undefined)).toBe(0);
     });
     it('T-PARSE-5: negative/NaN/Infinity return 0 (CD-7 safe floor)', () => {
       expect(parsePriceSafe(-1.0)).toBe(0);
       expect(parsePriceSafe(Number.NaN)).toBe(0);
       expect(parsePriceSafe(Number.POSITIVE_INFINITY)).toBe(0);
       expect(parsePriceSafe(Number.NEGATIVE_INFINITY)).toBe(0);
     });
     it('T-PARSE-6: empty string returns 0 (AB-WKH-53-#3 edge)', () => {
       expect(parsePriceSafe('')).toBe(0);
     });
   });
   ```

   NOTE: this assumes the existing `import { discoveryService } from './discovery.js'` line gets extended to `import { discoveryService, parsePriceSafe } from './discovery.js'`. **Read the test file first** before editing to confirm the exact import line.

**Validation gate (must pass before W1)**:
- `npx tsc --noEmit` clean.
- `npx vitest run src/services/discovery.test.ts` → previous tests pass + 6 new T-PARSE-* pass.
- `git status`: only `discovery.ts` and `discovery.test.ts` modified.

**Commit W0**: `feat(WKH-57 W0): add parsePriceSafe helper with safe-floor semantics`

---

### W1 — `mapAgent` fallback + dedup warn + 9 tests (~15 min)

**Pre-conditions**:
- W0 merged into branch (or staged in same branch). Tests passing.
- `discovery.ts` lines 211-244 (mapAgent body) open.

**Actions**:

1. In `src/services/discovery.ts`, add at top of file (post-imports, around line 15-20):

   ```ts
   // ─── WAS-V2-3-CLIENT (WKH-57) module-scoped warn dedup ────────────────
   // Set lives for process lifetime. Reset via `_resetFallbackWarnDedup()`
   // in test setUp to avoid cross-test contamination (CD-11).
   const _warnedFallbackSlugs = new Set<string>();

   /** TEST-ONLY: clears the dedup Set. NOT for production code paths. */
   export function _resetFallbackWarnDedup(): void {
     _warnedFallbackSlugs.clear();
   }
   ```

2. In `src/services/discovery.ts`, add the resolver helper near `parsePriceSafe` (still in the helpers area, ~line 320):

   ```ts
   /**
    * Resolves agent.priceUsdc from a raw response, with v2 schema-drift fallback.
    *
    * - If `canonicalPath` is populated (even with 0), returns parsePriceSafe(canonical).
    *   This preserves CD-2 backward-compat: explicit 0 from canonical wins.
    * - Else attempts to read V2_PRICE_FALLBACK_FIELD ('price_per_call').
    * - When the fallback IS taken (i.e. canonical was null/undefined AND fallback was
    *   present), emits exactly one console.warn per slug per process (CD-3 + DT-B).
    *
    * @param raw  Raw registry response object.
    * @param canonicalPath  Path configured by registry (e.g. 'price_per_call_usdc').
    * @param slug  Agent slug for log dedup.
    */
   function resolvePriceWithFallback(
     raw: Record<string, unknown>,
     canonicalPath: string,
     slug: string,
   ): number {
     const canonical = getNestedValue(raw, canonicalPath);
     if (canonical !== null && canonical !== undefined) {
       return parsePriceSafe(canonical);
     }
     const fallback = getNestedValue(raw, V2_PRICE_FALLBACK_FIELD);
     if (fallback === null || fallback === undefined) return 0;
     if (!_warnedFallbackSlugs.has(slug)) {
       _warnedFallbackSlugs.add(slug);
       console.warn(
         `[Discovery] price_per_call_usdc is null for agent "${slug}" — using fallback "price_per_call"`,
       );
     }
     return parsePriceSafe(fallback);
   }
   ```

3. In `src/services/discovery.ts`, replace **only** line 229 inside `mapAgent`:

   ```ts
   // BEFORE:
   priceUsdc: Number(getNestedValue(raw, mapping.price ?? 'price') ?? 0),

   // AFTER:
   priceUsdc: resolvePriceWithFallback(raw, mapping.price ?? 'price', slug),
   ```

   The `slug` variable is already in scope (computed at line 214). Do NOT refactor the rest of the method (CD-2 + DT-D).

4. In `src/services/discovery.test.ts`, append new describe block:

   ```ts
   import {
     discoveryService,
     parsePriceSafe,
     _resetFallbackWarnDedup,
   } from './discovery.js';

   function makeV2RawAgent(o: Record<string, unknown> = {}) {
     return {
       id: 'v2-agent-1',
       slug: 'v2-agent',
       name: 'V2 Agent',
       description: 'descr',
       capabilities: ['x'],
       status: 'active',
       ...o,
     };
   }

   function makeV2Registry(): RegistryConfig {
     return makeRegistry({
       schema: {
         discovery: {
           agentMapping: { price: 'price_per_call_usdc' },
         },
         invoke: { method: 'POST' },
       },
     });
   }

   describe('mapAgent — v2 schema drift fallback (WAS-V2-3-CLIENT)', () => {
     let warnSpy: ReturnType<typeof vi.spyOn>;
     beforeEach(() => {
       _resetFallbackWarnDedup();         // CD-11: reset Set per test
       warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
     });
     afterEach(() => {
       warnSpy.mockRestore();
     });

     it('T-fallback-numeric: takes price_per_call when canonical is null (AC-1)', () => {
       const reg = makeV2Registry();
       const raw = makeV2RawAgent({ price_per_call_usdc: null, price_per_call: 0.05 });
       const agent = discoveryService.mapAgent(reg, raw);
       expect(agent.priceUsdc).toBe(0.05);
     });

     it('T-fallback-undefined-canonical: takes price_per_call when canonical absent (AC-1)', () => {
       const reg = makeV2Registry();
       const raw = makeV2RawAgent({ price_per_call: 0.10 });
       const agent = discoveryService.mapAgent(reg, raw);
       expect(agent.priceUsdc).toBe(0.10);
     });

     it('T-canonical-wins: canonical numeric wins over populated fallback (AC-2)', () => {
       const reg = makeV2Registry();
       const raw = makeV2RawAgent({ price_per_call_usdc: 0.20, price_per_call: 0.99 });
       const agent = discoveryService.mapAgent(reg, raw);
       expect(agent.priceUsdc).toBe(0.20);
       expect(warnSpy).not.toHaveBeenCalled();
     });

     it('T-canonical-zero-wins: canonical 0 wins over fallback (AC-2 edge / CD-2)', () => {
       const reg = makeV2Registry();
       const raw = makeV2RawAgent({ price_per_call_usdc: 0, price_per_call: 0.05 });
       const agent = discoveryService.mapAgent(reg, raw);
       expect(agent.priceUsdc).toBe(0);
       expect(warnSpy).not.toHaveBeenCalled();
     });

     it('T-both-null: both null returns 0 with no warn (AC-3)', () => {
       const reg = makeV2Registry();
       const raw = makeV2RawAgent({ price_per_call_usdc: null, price_per_call: null });
       const agent = discoveryService.mapAgent(reg, raw);
       expect(agent.priceUsdc).toBe(0);
       expect(warnSpy).not.toHaveBeenCalled();
     });

     it('T-fallback-string-parseable: parses string fallback (AC-5 happy)', () => {
       const reg = makeV2Registry();
       const raw = makeV2RawAgent({ price_per_call_usdc: null, price_per_call: '0.05' });
       const agent = discoveryService.mapAgent(reg, raw);
       expect(agent.priceUsdc).toBe(0.05);
     });

     it('T-fallback-string-non-parseable: non-parseable returns 0 (AC-5 sad)', () => {
       const reg = makeV2Registry();
       const raw = makeV2RawAgent({ price_per_call_usdc: null, price_per_call: 'free' });
       const agent = discoveryService.mapAgent(reg, raw);
       expect(agent.priceUsdc).toBe(0);
     });

     it('T-warn-emitted-on-fallback: emits 1 warn referencing slug (AC-6)', () => {
       const reg = makeV2Registry();
       const raw = makeV2RawAgent({ price_per_call_usdc: null, price_per_call: 0.05 });
       discoveryService.mapAgent(reg, raw);
       expect(warnSpy).toHaveBeenCalledTimes(1);
       const msg = String(warnSpy.mock.calls[0][0]);
       expect(msg).toContain('v2-agent');
       expect(msg).toContain('fallback');
     });

     it('T-warn-once-per-slug: same slug fallback called twice → 1 warn (AC-6 dedup)', () => {
       const reg = makeV2Registry();
       const raw = makeV2RawAgent({ price_per_call_usdc: null, price_per_call: 0.05 });
       discoveryService.mapAgent(reg, raw);
       discoveryService.mapAgent(reg, raw);
       expect(warnSpy).toHaveBeenCalledTimes(1);
     });
   });
   ```

   **CRITICAL** (CD-10 + AB-WKH-53-#2): before writing these asserts, **Read** the actual `discovery.test.ts` file to confirm:
   - Whether `afterEach` is already imported from vitest (line 4). If not, extend the import.
   - Whether `RegistryConfig` is already imported (line 5 — yes).
   - The position to insert (currently end-of-file at line 237 — append after the last closing `});`).

**Validation gate (must pass before W2)**:
- `npx tsc --noEmit` clean.
- `npx vitest run src/services/discovery.test.ts` → all previous + 6 T-PARSE + 9 mapAgent tests pass.
- `git diff src/services/discovery.ts` shows: 2 module constants + 1 reset export + 1 helper + 1 helper + 1 line changed. NO other lines touched.

**Commit W1**: `feat(WKH-57 W1): mapAgent fallback to price_per_call when canonical is null`

---

### W2 — Compose integration test for AC-4 (~10 min)

**Pre-conditions**:
- W0 + W1 staged. All tests passing locally.
- `compose.test.ts` lines 320-399 open (existing WKH-55 downstream block — your template).

**Actions**:

1. In `src/services/compose.test.ts`, append a new describe block AFTER line 399 (closing `});` of the existing WKH-55 describe):

   ```ts
   // ─── WAS-V2-3-CLIENT (WKH-57): integration — fallback unblocks downstream ─
   describe('composeService — WAS-V2-3-CLIENT integration (WKH-57)', () => {
     it('T-INT-01: triggers downstream Fuji USDC settle when priceUsdc is resolved via v2 fallback (AC-4)', async () => {
       vi.mocked(registryService.getEnabled).mockResolvedValue([]);
       mockDownstream.mockResolvedValue({
         txHash: '0xfeeb',
         blockNumber: 42,
         settledAmount: '50000', // 0.05 USDC in atomic units (6-dec)
       });
       // Simulate the OUTPUT of mapAgent post-fallback: priceUsdc resolved
       // from price_per_call when price_per_call_usdc was null.
       const agent = makeAgent({
         slug: 'v2-fallback-agent',
         priceUsdc: 0.05,
         payment: {
           method: 'x402',
           chain: 'avalanche',
           contract: '0x000000000000000000000000000000000000aBcD',
         },
         metadata: { payTo: '0x000000000000000000000000000000000000aBcD' },
       });
       vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent);
       mockFetchOk();

       const result = await composeService.compose({
         steps: [{ agent: agent.slug, input: { q: 'x' } }],
       });

       expect(result.success).toBe(true);
       // AC-4: downstream path executed (vs current bug where priceUsdc=0 skips it)
       expect(mockDownstream).toHaveBeenCalledTimes(1);
       expect(result.steps[0].downstreamTxHash).toBe('0xfeeb');
     });
   });
   ```

   **CRITICAL** (CD-10 + AB-WKH-53-#2): before writing this test, **Read** `compose.test.ts:1-50` to confirm:
   - `makeAgent` helper signature accepts `metadata`/`payment`/`priceUsdc`.
   - `mockDownstream`, `mockFetchOk`, `discoveryService`, `registryService`, `composeService` are all already imported/mocked at the top of the file.
   - The existing pattern (lines 337-364, `T-W3-02`) uses `vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(agent)` — your test must follow the same pattern.
   - **Do NOT** mock `signAndSettleDownstream` differently from the existing `mockDownstream` setup; the file already has this mock module-scoped.

**Validation gate (must pass before commit)**:
- `npx tsc --noEmit` clean.
- `npx vitest run src/services/compose.test.ts` → all previous + 1 new T-INT-01 pass.
- `npx vitest run` (full suite) → 463 baseline + 16 new = **479 total tests pass**.
- `git diff --stat`: exactly 3 files modified (discovery.ts, discovery.test.ts, compose.test.ts).

**Commit W2**: `feat(WKH-57 W2): compose integration test for v2 fallback downstream path`

---

## §4 — Anti-Hallucination Rules (consolidadas)

These rules are the result of past Auto-Blindaje retros. **Violating any of these is a known cause of regressions.** Read carefully.

1. **AB-WKH-53-#2 — Read before write, never project**:
   Before writing ANY assert in a test file, **Read** the current state of the test file from disk. Do NOT trust the snippets in this Story File as exact — line counts, import statements, and helper signatures may have drifted between F2.5 and F3. If a referenced helper/import doesn't exist in disk, STOP and re-Read the file. **Never write `expect(x).toHaveBeenCalledWith(...)` without first verifying that `x` exists as a mocked symbol in the test file.**

2. **AB-WKH-57-W2 — Brittle mock chains: reset Set in `beforeEach`**:
   The `_warnedFallbackSlugs` Set is module-scoped. Without reset, tests after the first one will see `warnSpy` called 0 times (Set already has the slug from a prior test). **MANDATORY**: every test that exercises the fallback warn path must run inside a `describe` block whose `beforeEach` calls `_resetFallbackWarnDedup()` AND re-spies `console.warn`. **Verify**: if you introduce a new fallback test outside the existing describe, copy the `beforeEach`/`afterEach` block.

3. **AB-WKH-56-W4 — Coverage tooling not installed**:
   Do NOT add `--coverage` flags, `c8`/`v8` thresholds, or coverage assertions. AC-7 is verified by manual inspection of test count + green run, not by coverage percentage. Don't even try `npx vitest --coverage`.

4. **Pattern verified — `parsePriceSafe` MUST use `Number.parseFloat` + `Number.isFinite`**:
   - Use **`Number.parseFloat`** (NOT global `parseFloat` — explicit namespace is the codebase convention, see `fee-charge.ts:94`).
   - Use **`Number.isFinite`** (NOT global `isNaN` — `isNaN('abc')` returns true but for the wrong reason; `Number.isFinite` rejects `NaN` AND `Infinity` in one check).
   - Reject **negative numbers** (CD-7 safe floor): `parsed >= 0` is part of the validation.
   - Reject **empty string** explicitly (`Number.parseFloat('')` returns `NaN`, but be explicit for readability).

5. **Pattern verified — warn dedup via module-scoped `Set<string>` + reset helper**:
   - The `Set<string>` is **module-scoped** (declared at top of `discovery.ts`, not inside `mapAgent` — that would defeat dedup).
   - The reset helper `_resetFallbackWarnDedup` is **named with leading underscore** to signal "test-only" and **MUST** be exported (otherwise tests cannot call it).
   - Pattern source: `src/lib/downstream-payment.ts:38, 110-122` (warn-once boolean) — extended to `Set<string>` for per-slug.

6. **AB-WKH-53-#1 — Don't run global lint/format**:
   Run lint scoped to your files only: `npx biome check src/services/discovery.ts src/services/discovery.test.ts src/services/compose.test.ts`. Do NOT run `npm run lint` globally — pre-existing drift outside scope is not your responsibility.

7. **TS strict — zero `any`**:
   No `as any`, no implicit `any`. The `parsePriceSafe(raw: unknown)` signature must remain `unknown`, not `any`. Use type narrowing with `typeof`.

---

## §5 — Constraint Directives (12 CDs)

| CD | What to do / What NOT to do |
|----|---------------------------|
| **CD-1** | **NO** `any` explicit. TS strict mode. Use `unknown` + narrowing in helpers. |
| **CD-2** | **MUST** preserve backward-compat: if `price_per_call_usdc` is populated with a numeric value (including `0`), that value is canonical and `price_per_call` is NOT consulted. Test `T-canonical-zero-wins` enforces this. |
| **CD-3** | **MUST** emit `console.warn` (NOT Logger, see CD-8) when fallback path is taken. Dedupe per-slug via module-scoped `Set<string>`. |
| **CD-4** | **MUST** accept fallback strings parseable to numbers (AC-5). Use `Number.parseFloat` + `Number.isFinite` (canonical pattern from `fee-charge.ts`). |
| **CD-5** | **MUST** keep baseline 463 tests green. Run full suite at end of W2. **NO** modifications to existing tests. |
| **CD-6** | **NO** changes to `wasiai-v2` source nor to the registry config in DB. Fix is purely client-side in `mapAgent`. |
| **CD-7** | **NO** price inflation via fallback. Negative, NaN, Infinity → safe floor `0`. Test `T-PARSE-5` enforces this. |
| **CD-8** | **NO** Logger, pino, or injectable logger. Use `console.warn` directly with `[Discovery]` prefix (consistent with `discovery.ts:62` and `fee-charge.ts:103`). |
| **CD-9** | **NO** changes to `AgentFieldMapping`, `Agent`, or `RegistrySchema` types in `src/types/index.ts`. The fix is internal logic of `mapAgent`. |
| **CD-10** | **MUST** verify referenced helpers/imports exist on disk before writing test asserts. AB-WKH-53-#2 lesson: don't project, Read. |
| **CD-11** | **MUST** call `_resetFallbackWarnDedup()` in `beforeEach` of any test exercising the fallback warn path. Otherwise the Set persists across tests and warn-count assertions fail. |
| **CD-12** | **NO** modifications to files outside Scope IN. Three files only: `discovery.ts`, `discovery.test.ts`, `compose.test.ts`. Verify with `git diff --stat` before each commit. |

---

## §6 — Exemplars (file:line references — verified)

| Pattern | Source | Use here |
|--------|--------|----------|
| `Number.parseFloat` + `Number.isFinite` for safe parsing | `src/services/fee-charge.ts:80-110` | Body of `parsePriceSafe`. Mirror the structure of `getProtocolFeeRate`. |
| Module-scoped warn-once flag | `src/lib/downstream-payment.ts:22-122` (declaration `:38`, usage `:110-122`) | Generalize the `let _warnedDefaultUsdc = false` boolean → `const _warnedFallbackSlugs = new Set<string>()` for per-slug dedup. |
| Direct `discoveryService.mapAgent(registry, raw)` test (no fetch needed) | `src/services/discovery.test.ts:152-192` | Plantilla for the 9 W1 tests. **Bypass HTTP layer** — call `mapAgent` directly with hand-crafted `raw`. |
| Compose integration with mocked downstream | `src/services/compose.test.ts:326-374` (specifically `T-W3-02` at lines 337-364) | 1:1 template for `T-INT-01`. Same mocks: `mockDownstream`, `mockFetchOk`, `vi.mocked(discoveryService.getAgent).mockResolvedValueOnce(...)`. |
| `console.warn` with `[Discovery]` prefix (no Logger) | `src/services/discovery.ts:62`, `src/lib/downstream-payment.ts:115`, `src/services/fee-charge.ts:103` | Use exactly: `[Discovery] price_per_call_usdc is null for agent "<slug>" — using fallback "price_per_call"` |
| `vi.spyOn(console, 'warn').mockImplementation(() => {})` + `mockRestore()` in afterEach | `src/services/compose.test.ts:289-322` (within `safe-logging` block) | Setup for the W1 tests' warn assertions. |

---

## §7 — Pre-implementation checklist (Dev — do BEFORE touching code)

- [ ] `git checkout main && git pull origin main` — confirm at `91adc29` or later.
- [ ] `git checkout -b feat/057-wkh-57-was-v2-3-client`.
- [ ] `npm install` if `package.json` changed (it hasn't, but defensive).
- [ ] `npm test` — confirm baseline ~463 tests pass. **If baseline fails, STOP and report drift.**
- [ ] **Read** `src/services/discovery.ts` lines 200-300 — confirm `mapAgent` is at 211-244 and line 229 is the bug. Note current end-of-file line.
- [ ] **Read** `src/services/discovery.test.ts` lines 1-30 (imports) and lines 220-240 (last describe). Confirm `afterEach` import status, current `discoveryService` import line, and end-of-file line.
- [ ] **Read** `src/services/compose.test.ts` lines 1-60 (imports + helpers like `makeAgent`, `mockDownstream`, `mockFetchOk`) and lines 320-399 (existing WKH-55 describe — your template). Confirm end-of-file line.
- [ ] **Read** `src/services/fee-charge.ts:80-110` — confirm `Number.parseFloat` + `Number.isFinite` exemplar still matches the SDD description.
- [ ] **Read** `src/lib/downstream-payment.ts:22-122` — confirm warn-once pattern still matches.
- [ ] Verify `npx tsc --noEmit` is clean on baseline (no pre-existing TS errors that could mask new ones).

**Only after all the above** start editing files in W0.

---

## §8 — Definition of Done (F3 complete when)

- [ ] Branch `feat/057-wkh-57-was-v2-3-client` exists, with **3 commits** (one per wave: W0, W1, W2).
- [ ] `npx tsc --noEmit` exits 0.
- [ ] `npx vitest run` — full suite green, **479 tests passed (463 baseline + 16 new)**.
- [ ] All these test IDs appear as PASS in the run output:
  - `T-PARSE-1`, `T-PARSE-2`, `T-PARSE-3`, `T-PARSE-4`, `T-PARSE-5`, `T-PARSE-6`
  - `T-fallback-numeric`, `T-fallback-undefined-canonical`
  - `T-canonical-wins`, `T-canonical-zero-wins`
  - `T-both-null`
  - `T-fallback-string-parseable`, `T-fallback-string-non-parseable`
  - `T-warn-emitted-on-fallback`, `T-warn-once-per-slug`
  - `T-INT-01`
- [ ] `git diff --stat origin/main...HEAD` shows **exactly 3 files changed**: `src/services/discovery.ts`, `src/services/discovery.test.ts`, `src/services/compose.test.ts`.
- [ ] No file outside Scope IN modified (CD-12). Verify by inspecting `git diff --stat`.
- [ ] `npx biome check src/services/discovery.ts src/services/discovery.test.ts src/services/compose.test.ts` is clean.
- [ ] No `console.error` or unexpected log output when running tests in CI mode.
- [ ] No `[NEEDS CLARIFICATION]` markers remain in any commit message or code comment.

---

## §9 — Notes for Dev (auto-mode context)

- **Auto mode active**: AR (Adversary Review) and CR (Code Review) will run self-approved after F3. The human is offline for this HU. If you encounter genuine ambiguity (i.e. a CD conflicts with a verified pattern), DO NOT use `AskUserQuestion`. Instead, mark `[NEEDS CLARIFICATION]` in the commit message of the relevant wave and proceed with the **most defensive interpretation** (favor: backward-compat, smaller diff, established pattern over novelty).
- **Branch base**: `main` at commit `91adc29` (or HEAD if newer). Confirm with `git log -1 --oneline`.
- **Baseline test count**: ~463. Target after F3: 479 (verify exactly with the post-W2 run; if baseline drifted to 462 or 464, adjust the math but the delta is +16).
- **TypeScript strict**: zero `any` explicit. Use `unknown` + `typeof` narrowing in helpers.
- **Commit cadence**: 3 commits, one per wave. Use the messages suggested in each wave section. Co-author footer is added by the orchestrator at PR time, not per commit.
- **No PR creation in F3**: just push the branch (or leave local). The orchestrator runs F4/AR/CR/QA on the branch.
- **If a wave's validation gate fails**: do NOT proceed to next wave. Fix the issue, re-run validation, re-commit (use `git commit --amend` only if the wave has not been pushed yet; otherwise add a `fixup!` commit — but for hackathon pace, amending the wave's own commit is acceptable as long as you stay within the wave boundary).

---

> **Status**: Story File ready for Dev (F3).
> **Next agent**: `nexus-dev` reads this file, executes W0 → W1 → W2.
> **Exit criteria for F3**: §8 Done Definition fully checked.
