# QA Report — WKH-90 Discord-aware payload formatting

**QA Agent**: nexus-qa (F4) | **Date**: 2026-05-04 | **Branch**: feat/078-wkh-90-discord-alert-formatter @ b9788bf

## Veredicto
**APROBADO PARA DONE**

## Runtime checks

- **npm test**: 239/239 PASS, 0 fail, 0 skipped, 0 todo. Duration ~1037ms.
- **Module side-effects**: `formatForDiscord` es función pura (no mutable module-level state). `DISCORD_HOSTS`, `DISCORD_COLOR_BY_SEVERITY`, `DISCORD_COLOR_DEFAULT`, `DISCORD_USERNAME` son `const` a module scope.
- **No DB, no env vars**: library-only HU.

## AC Verification

| AC | Status | Evidencia archivo:línea |
|----|--------|-------------------------|
| AC-1 | ✅ PASS | impl: `src/alerts.mjs:47` (`DISCORD_HOSTS = new Set(['discord.com', 'discordapp.com'])`) + `:173` (`isDiscord = DISCORD_HOSTS.has(parsed.host)`) + `:178-180`. Test: `tests/alerts.test.mjs:219` (T-AL-DISC-01) + `:272` (T-AL-DISC-02) |
| AC-2 | ✅ PASS | impl: `src/alerts.mjs:53-57` (color map) + `:59` (default 3066993). Tests: `:251` (15158332), `:287` (15844367), `:305` (3066993), `:316-318` (unknown→default) |
| AC-3 | ✅ PASS | impl: `src/alerts.mjs:178-180` (non-Discord branch returns sanitized unchanged). Test: `tests/alerts.test.mjs:335` (T-AL-DISC-05, hooks.slack.com) — asserts `!('username' in captured)`, `!('embeds' in captured)` |
| AC-4 | ✅ PASS | impl: `src/alerts.mjs:205-210` (`if (!resp.ok)` → no-throw return). Test: `tests/alerts.test.mjs:321` (T-AL-DISC-04) HTTP 400 |
| AC-5 | ✅ PASS | T-AL-DISC-01/02/03 cubren critical/warning/info con asserts duros sobre `captured` (real POST body), no solo "fetch was called" |
| AC-6 | ✅ PASS | 239/239 tests pass (232 baseline + 7 new). Pre-existing count unchanged |
| AC-7 | ✅ PASS | `README.md:360-420` sub-(i) "Alert webhook platforms (WKH-90)" — auto-detection, tabla plataformas, embed structure, color mapping con hex+decimal+meaning, field routing |

## Drift detection

- **Files outside Scope IN**: ninguno. `git diff main..HEAD --name-only`: solo los 3 declarados (alerts.mjs, alerts.test.mjs, README.md)
- **Branch sync**: local matches origin (cero diff)
- **Env files**: no `.env*` modificado
- **Wave drift**: 1 solo commit (`b9788bf`), no wave violations

## Cosmetic observations (non-blocking)

- `tests/alerts.test.mjs:216` comment dice "T-AL-DISC-01..04" pero hay 7 tests (01..07). Cosmetic only.
- AC-4 menciona 429 explícitamente; hay test dedicado solo para 400. La rama `!resp.ok` cubre ambos idénticamente, AR ran adversarial probe 429. Gap es coverage de test, no correctness. Aceptado como MNR.

## AR/CR follow-up

- 0 BLQs en AR + 0 BLQs en CR
- 7 MNRs total deduplicados (AR-MNR-3 == CR-MNR-CR-4) — todos aceptados como TD/backlog
- No fix-pack required

**Recomendación**: APROBADO → DONE.
