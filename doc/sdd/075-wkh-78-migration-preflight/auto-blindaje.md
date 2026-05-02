# WKH-78 Auto-Blindaje — Errors Encountered During Fix-Pack iter 1

This file documents errors I made (or hit) during the AR fix-pack
implementation, the root cause, the fix, and where the same pattern
could re-emerge in future stories.

---

### [2026-05-02 01:25] Wave pre-1 — Working tree on wrong branch when concurrent agents run

- **Error**: I wrote the new `scripts/migrate-preflight.mjs` while
  `git branch --show-current` reported `feat/077-wkh-82-public-docs-onboarding`
  (the result of a concurrent sibling agent's `git checkout`). The Write
  tool succeeded against the path, but the file landed in a working tree
  that wasn't the WKH-78 branch's.
- **Root cause**: each `Bash` tool invocation gets a fresh shell, and
  another agent process running in parallel was switching branches
  between my Bash calls. There is no per-call working tree lock.
- **Fix**: chain "stash → checkout → apply stash → run → commit" into
  one Bash invocation so a sibling agent cannot re-`checkout` mid-flight.
  When a stash apply happened, immediately `git add` + `git commit` to
  pin the work onto the branch's history.
- **Apply in**: every multi-step git workflow done via the agent harness
  while concurrent agents are running. If you need to stage + edit + run
  + commit, do it as one chained `bash -c` (with `set -e`) and verify
  `git branch --show-current` *inside* the chain. Single-call Edit/Write
  is unsafe across branch boundaries.

### [2026-05-02 01:29] Wave 1 — vitest "no test files found" when calling vitest with a path argument

- **Error**: `npx vitest run test/migrate-preflight.test.ts` reported
  "No test files found" because the `rtk` shell wrapper passed the path
  through a token-rewriter that suppressed it.
- **Root cause**: the `rtk` proxy is the default shell wrapper and it
  has a hook for vitest invocations that filters args.
- **Fix**: prefix the command with `rtk proxy` to bypass the wrapper, OR
  ensure the path is passed verbatim. After confirming the test file
  glob in `vitest.config.ts` was correctly extended to
  `['src/**/*.test.ts', 'test/**/*.test.ts']`, the test run worked
  unfiltered.
- **Apply in**: any future use of `vitest`, `npm test`, or other CLI
  commands that need explicit paths under WKH-style branch automation.
  When the proxy wrapper is in play, prefer `rtk proxy <cmd>`.

### [2026-05-02 01:42] Wave 3 — `git reset --soft` survived branch hop but commits did not

- **Error**: I ran `git reset --soft f644afa` to consolidate three wave
  commits into one final commit. Between the reset and the
  `git commit -F`, a sibling agent's `git checkout` switched branches.
  The soft-reset's staged changes were discarded by the checkout, and
  my commit ended up on the wrong branch (or nothing-to-commit).
- **Root cause**: `git reset --soft` keeps changes in the index, but the
  index is part of the working tree state that `git checkout` will
  discard or migrate. Combined with concurrent branch switches, this is
  fragile.
- **Fix**: avoid soft-reset for cross-branch consolidation under
  concurrency. Either (a) chain everything into one bash invocation, or
  (b) accept multi-commit history and squash later via `git rebase -i`
  on a less hostile environment, or (c) drop the soft-reset and prefer
  three small commits. I went with (a): apply stash + stage + commit in
  one shell call so the work was pinned before any sibling could run.
- **Apply in**: every `git reset --soft` / `git reset --hard` workflow
  under concurrent agents. Treat the index as ephemeral; commit early
  and often, and squash with rebase later (only if you control the
  environment).

### [2026-05-02 01:45] Wave 3 — Stash apply silently no-op when stash@{N} renumbers

- **Error**: I called `git stash apply stash@{1}` after stashing other
  agents' WIP. The stash list shifted (a sibling agent had pushed a new
  stash) so my expected stash@{1} was no longer my work.
- **Root cause**: stash indices are FIFO — every `stash push` shifts
  every existing index by +1.
- **Fix**: identify the right stash by NAME (`auto-w2-tight2-…`) or by
  inspecting `git stash show stash@{N} --stat` for the exact set of
  files (3 files: scripts/migrate-preflight.mjs +
  test/migrate-preflight.test.ts + doc/runbooks/migration-preflight.md).
  When in doubt, `for n in 0..9; do show stash@{$n}; done` and grep.
- **Apply in**: every stash-pop / stash-apply that targets a specific
  numerical index. Prefer named stashes + lookup-by-name. Better still,
  use a feature branch or temporary branch instead of stash when
  multiple agents may push.

---

## Forward-looking guards

These will be enforced for future WKH-* fix-packs running under the
same concurrent-agent harness:

1. **Treat working tree as a transient resource.** Anything not
   committed can disappear at any moment — never assume a branch will
   stay checked out across two Bash calls.
2. **Pin work as early as possible.** Once tests pass, immediately
   commit; do not soft-reset or amend across multi-call workflows.
3. **Identify stashes by name, not by index.** Use
   `git stash push -m "wkh78-w1-$(date +%s)"` and re-find by message.
4. **Use `set -e` and chained tool calls** when sequencing 3+
   operations: stash → checkout → apply → test → commit.
