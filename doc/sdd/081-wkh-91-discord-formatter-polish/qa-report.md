# QA Report — WKH-91 Discord Formatter Polish

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-05-04
**Branch**: feat/081-wkh-91-discord-formatter-polish @ 3b8cbd9
**Pipeline**: FAST AUTO (no AR/CR formal — AC verification + light code-quality check)

---

## AC Verification

| AC | Status | Evidencia archivo:línea |
|----|--------|-------------------------|
| AC-1: title truncate ≤256 + ellipsis | PASS | `src/alerts.mjs:69` `TITLE_MAX=256`; `src/alerts.mjs:94-98` `_truncate` impl `slice(0,max-1)+'…'`; `src/alerts.mjs:164` applied to `embed.title`. Runtime: `formatForDiscord({severity:'critical',body:{event:'a'.repeat(260)}})` → title.length===256, title.endsWith('…') ✓ |
| AC-2: description truncate ≤4096 + ellipsis | PASS | `src/alerts.mjs:70` `DESCRIPTION_MAX=4096`; `src/alerts.mjs:169` `embed.description = _truncate(safeBody.reason, DESCRIPTION_MAX)`. Runtime: `formatForDiscord` with reason len 5000 → desc.length===4096, desc.endsWith('…') ✓ |
| AC-3: `hostname` not `host`, lowercase | PASS | `src/alerts.mjs:226` `DISCORD_HOSTS.has(parsed.hostname.toLowerCase())`; `src/alerts.mjs:47` DISCORD_HOSTS values are already lowercase strings. Runtime: URL `https://discord.com:8080/…` → `hostname='discord.com'` → isDiscord=true → embeds present ✓ |
| AC-4: T-AL-DISC-06 unconditional assertions (no `if (captured)`) | PASS | `tests/alerts.test.mjs:357-390` — full test body scanned; zero `if (captured)` guards present. `fetchCalls===1` asserted at line 381; `captured` checked with `assert.ok` at line 382 then assertions run unconditionally at lines 384-389 ✓ |
| AC-5: `@internal` JSDoc on `formatForDiscord` | PASS | `src/alerts.mjs:124` `* @internal` inside JSDoc block directly above `export function formatForDiscord` at line 149. Export surface unchanged (function still exported) ✓ |
| AC-6: `DEFAULT_SEVERITY_LABEL = 'unknown'` replaces magic string | PASS | `src/alerts.mjs:74` `const DEFAULT_SEVERITY_LABEL = 'unknown'`; `src/alerts.mjs:159` `const sevLabel = sev \|\| DEFAULT_SEVERITY_LABEL`. Runtime: `formatForDiscord({severity:undefined,body:{}})` → title `[unknown]` ✓ |
| AC-7: `pickFirstNonEmpty` helper replaces nested ternary | PASS | `src/alerts.mjs:107-112` `function _pickFirstNonEmpty(...candidates)` defined at module scope; `src/alerts.mjs:174-177` applied to resolve timestamp from `rotatedAt`/`checkedAt`. No nested ternary remains in that path ✓ |
| AC-8: comment says "T-AL-DISC-01..08" (was "..04") | PASS | `tests/alerts.test.mjs:216` literal text: `// WKH-90 — Discord-aware payload formatting tests (T-AL-DISC-01..08).` ✓ |
| AC-9: HTTP 429 → `{sent:false, status:429, reason:'webhook status 429'}` no throw | PASS | `tests/alerts.test.mjs:413-429` test `T-AL-DISC-08`; asserts `r.sent===false`, `r.status===429`, `r.reason==='webhook status 429'`, and `Object.keys(r).sort()` === `['reason','sent','status']` (no extras). Production path: `src/alerts.mjs:258-263` `!resp.ok` branch returns `{sent:false, reason:\`webhook status ${resp.status}\`, status:resp.status}` ✓ |

---

## Runtime Checks

**Tests**: `node --test` (full suite) → 249/249 pass, 0 fail.

Alerts-specific suite `node --test tests/alerts.test.mjs` → 14/14 pass (T-AL-01..05 + T-AL-DISC-01..08 + T-AL-bonus).

**Backward compat smoke (executed inline)**:
- Slack URL `https://hooks.slack.com/…` → `sent:true`, no `username`, no `embeds`, `severity:'critical'` at top-level. ✓
- Discord URL `https://discord.com/api/webhooks/…` → `sent:true`, `username:'wasiai-alerts'`, `embeds[0].title:'[critical] test'`. ✓

**Truncation runtime**:
- Title 260 chars → length 256, ends `…`. ✓
- Description 5000 chars → length 4096, ends `…`. ✓

**Port-in-URL runtime**:
- `https://discord.com:8080/api/webhooks/1/x` → `parsed.hostname='discord.com'` → Discord embed path taken. ✓

No DB changes, no env vars, no migrations — those checks N/A for this HU.

---

## Drift Detection

Files changed vs main: 3
- `doc/sdd/081-wkh-91-discord-formatter-polish/work-item.md` — pipeline artefact (F1 output), not a code-scope violation
- `mcp-servers/wasiai-x402/src/alerts.mjs` — Scope IN ✓
- `mcp-servers/wasiai-x402/tests/alerts.test.mjs` — Scope IN ✓

Scope OUT not touched: no README, no other src files, no schema, no env vars. Drift: none.

---

## Light Code Review (FAST AUTO)

- `_truncate` and `_pickFirstNonEmpty`: underscore prefix signals internal; naming clear; JSDoc present. No issues.
- `DEFAULT_SEVERITY_LABEL`: constant placement (line 74) is logical, near other Discord constants. No issues.
- T-AL-DISC-06 mock approach: `fetchCalls` counter + `assert.ok(captured)` before body-shape assertions is correct and hermetic. Unconditional path confirmed.
- T-AL-DISC-08 assertions: checks exact triple `{sent,status,reason}` plus `Object.keys` guard — specific, not `.length`-only. No issues.
- CD-18 `redirect:'error'` still present at `src/alerts.mjs:243`. ✓
- CD-9: no `webhookUrl` in any log call. ✓
- CD-12: `sanitizeAlertBody` still called before payload construction at line 215. ✓
- No `any` usage; no hardcoded secrets; no new env vars.

No observations requiring action.

---

## Recomendacion

**APROBADO PARA DONE.**

9/9 ACs PASS con evidencia archivo:linea. 249/249 tests pass. 0 drift. Backward compat verified via runtime smoke. Light CR: sin hallazgos.
