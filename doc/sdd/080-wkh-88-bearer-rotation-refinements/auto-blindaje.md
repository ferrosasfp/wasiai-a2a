# Auto-Blindaje — WKH-88 (Bearer Rotation Refinements)

Errores cometidos durante F3 implementation y cómo se corrigieron. Sirve como
referencia para futuras HUs que toquen el mismo dominio.

---

### [2026-05-03 W1] Wave 1 — T-RB-08 regression after introducing S0-pre mutex

- **Error**: After adding the NX-flagged mutex `kvClient.set(MUTEX, ..., {nx:true})`
  as the first operation of `rotateBearer()`, the pre-existing test `T-RB-08:
  KV write failure (S6) → ok:true` started failing. The test used
  `makeKvMock({failNext: 1})` to simulate a single-failure scenario on the S6
  snapshot write, but my new mutex set call became the FIRST `set()` invocation,
  consuming the `failNext` slot and leaving the snapshot write to succeed.
  Assertion `assert.equal(kv._store.size, 0)` then saw size=1 instead.
- **Causa raíz**: Adding a new call to a stubbed dependency (kvClient.set)
  without auditing all tests that rely on call-count-based stub configuration.
  `failNext` is order-sensitive; any new pre-S6 set() call shifts the failure
  window.
- **Fix**: Replaced the local `makeKvMock({failNext:1})` instance in T-RB-08
  with an inline mock that explicitly distinguishes the two `set()` calls:
  first call (mutex with `nx:true`) returns 'OK', second call (snapshot)
  throws. Also added explicit assertions on `setCalls[0].opts.nx === true`
  and `setCalls[1].opts.nx === undefined` to lock in the call ordering.
- **Aplicar en**: Any future change to `rotateBearer()` that adds a new
  KV touch BEFORE S6 must check `tests/bearer-rotation.test.mjs` and
  `tests/audit-stderr.test.mjs` for `failNext` / call-count assumptions.
  Prefer per-call-shape assertions (e.g. `expect(setCalls[N].opts.nx)`) over
  raw `_store.size` checks — they survive call-count drift.

---

### [2026-05-03 W1] Wave 1 — kv-mock missing `nx` flag honour

- **Error**: The shared `tests/_mocks/kv-mock.mjs` did not implement Upstash's
  `{nx: true}` semantics — it overwrote the value unconditionally and always
  returned 'OK'. Without `nx` honour, the new T-MUTEX-01 test could not exercise
  the "mutex already taken" branch using the standard mock.
- **Causa raíz**: WKH-75 only needed `{ex: <seconds>}` semantics for the
  snapshot TTL, so `nx` was never implemented. The mock's surface lagged
  behind production needs as soon as a new use case (mutex) appeared.
- **Fix**: Added `nx` honour to `createKvMock().set()`: when `opts.nx === true`
  and the key already exists (post-purge), return `null` instead of 'OK'.
  Matches `@upstash/redis` documented behaviour.
- **Aplicar en**: Any future Upstash semantic that the mock must support
  (e.g. `{xx: true}` for "set only if exists", `{px: <ms>}` for millisecond
  TTL). Document each new shorthand at the call site of `set()` in the mock,
  with a one-line reference to the production caller that needs it.

---

### [2026-05-03 W2] Wave 2 — STAGE_REASONS literal whitelist updated

- **Error**: Initially returned `{stage:'mutex', reason:'rotation already in
  progress'}` as a literal string at the call site, bypassing the
  `STAGE_REASONS` whitelist. CD-12 mandates that `reason` ALWAYS comes from
  the whitelist so logs and client-facing error bodies cannot leak runtime
  message strings.
- **Causa raíz**: New error path added without auditing the existing CD-12
  invariant.
- **Fix**: Added `'mutex-busy': 'rotation already in progress'` to the
  `STAGE_REASONS` frozen registry and changed the early-return to
  `reason: STAGE_REASONS['mutex-busy']`. Tests assert against
  `STAGE_REASONS['mutex-busy']` rather than the bare string, locking
  the convention.
- **Aplicar en**: Any future stage added to `rotateBearer()` MUST also add
  an entry to `STAGE_REASONS` (and to the JSDoc `@typedef RotateBearerFailure`
  union of valid `stage` values).
