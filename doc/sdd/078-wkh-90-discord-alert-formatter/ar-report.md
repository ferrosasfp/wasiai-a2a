# AR Report — WKH-90

**Reviewer**: nexus-adversary (AR mode) | **Date**: 2026-05-04 | **Branch**: feat/078-wkh-90-discord-alert-formatter @ b9788bf

## Veredicto
**APROBADO con MENORES**

## Resumen ejecutivo

Implementación correcta y conservadora del shaping Discord en `mcp-servers/wasiai-x402/src/alerts.mjs`. Tests independientes corroboran 239/239 pass (232 baseline + 7 nuevos T-AL-DISC-01..07). Verifiqué shape Discord contra docs (`username`/`embeds[]`/`color` int/`fields[]` con name+value+inline), backward-compat raw JSON, fall-safe en URL malformada, no-throw en HTTP 4xx, y zero-leak de URL/secrets en stderr. Todos los 7 ACs y los 6 CDs (heredados + nuevos) PASS.

## Hallazgos BLOQUEANTES

Ninguno.

## Hallazgos MENORES

**MNR-1 — Embed title/description sin truncado defensivo**
- Path: `mcp-servers/wasiai-x402/src/alerts.mjs:116` (title), `:124` (description)
- Discord rechaza HTTP 400 si `title > 256` o `description > 4096`. Hoy callers (`bearer-rotation.mjs` STAGE_REASONS) generan strings ≤80 chars → no se dispara en prod actual. Probé `formatForDiscord({severity:'critical', body:{event:'X'.repeat(300)}})` → `title.length === 311` > 256.
- Sugerencia: truncar `title` a 256 y `description` a 4096 con `…` final.

**MNR-2 — Detección host se rompe con puerto explícito**
- Path: `mcp-servers/wasiai-x402/src/alerts.mjs:172-173`
- `parsed.host` incluye puerto cuando es no-default. `https://discord.com:8080/...` → `parsed.host === 'discord.com:8080'` → no matchea → cae a raw.
- En práctica Discord usa 443 default → no rompe. Pero decisión silenciosa.
- Sugerencia: usar `parsed.hostname` (sin puerto) o documentar.

**MNR-3 — Test T-AL-DISC-06 deja assert condicional**
- Path: `mcp-servers/wasiai-x402/tests/alerts.test.mjs:377` (`if (captured) { ... }`)
- El assert que importa (no-Discord-shape) podría no ejecutarse si fetch falla antes del mock.
- Sugerencia: stub que siempre captura, assert duro.

**MNR-4 — `formatForDiscord` exportado pero no documentado como API pública**
- Export amplía superficie pública sin necesidad. Hoy solo usado por `sendAlert` interno + tests.
- Sugerencia: marcar `@internal` o no exportar.

## Cobertura ACs

| AC | Status | Evidencia |
|---|---|---|
| AC-1 (Discord shape) | ✅ PASS | `src/alerts.mjs:178-180` + T-AL-DISC-01/02 |
| AC-2 (color map) | ✅ PASS | `src/alerts.mjs:53-57` (15158332/15844367/3066993 verificados) |
| AC-3 (backward compat) | ✅ PASS | T-AL-DISC-05 con Slack URL |
| AC-4 (HTTP 4xx no-throw) | ✅ PASS | T-AL-DISC-04 + `src/alerts.mjs:205-211` |
| AC-5 (severity coverage) | ✅ PASS | T-AL-DISC-01/02/03 asserts duros |
| AC-6 (no regresión) | ✅ PASS | `node --test 'tests/*.test.mjs'` → 239/239 |
| AC-7 (README docs) | ✅ PASS | README.md:360-420 sub-(i) |

## Cobertura CDs

| CD | Status | Evidencia |
|---|---|---|
| CD-9 (no log URL) | ✅ PASS | log calls `:158, 197, 206, 213` no incluyen URL; probe con secret-token confirmado |
| CD-12 (no throw) | ✅ PASS | 8 probes adversariales (BigInt, Symbol, null severity, etc.) — todos retornan objeto |
| CD-18 (redirect:'error') | ✅ PASS | `:190` sin cambio |
| CD-WKH90-1 (no add ALLOWED keys) | ✅ PASS | git diff confirma |
| CD-WKH90-2 (URL fail-safe) | ✅ PASS | `:171-176` try/catch + T-AL-DISC-06 |
| CD-WKH90-3 (username hardcoded) | ✅ PASS | `:62` const, cero `process.env` en módulo |
| CD-WKH90-4 (mock fetch) | ✅ PASS | T-AL-DISC-01..07 todos usan globalThis.fetch |

## Tests independientes corridos

1. `node --test tests/alerts.test.mjs` → 13/13 pass
2. `node --test 'tests/*.test.mjs'` → 239/239 pass
3. 8 probes adversariales (severity null, body undefined, port URL, subdomain spoof, http vs https, HTTP 429, BigInt, Symbol) → todas absorbidas
4. Verificación matemática colors: `0xE74C3C===15158332`, `0xF1C40F===15844367`, `0x2ECC71===3066993` ✓

**Recomendación**: APROBADO con MENORES — proceder a F4. 4 MNRs documentados para backlog/follow-up opcional.
