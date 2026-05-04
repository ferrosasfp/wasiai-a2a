# Report — HU [WKH-91] Discord formatter polish — truncate, hostname, test hardening

## Resumen ejecutivo

Consolidada la polka de 7 MNRs (4 AR + 3 CR deduplicados) surgidos de WKH-90 Discord formatter. Implementados: truncation con ellipsis (AC-1/2), hostname parsing fix (AC-3), helper `pickFirstNonEmpty` (AC-7), constant `DEFAULT_SEVERITY_LABEL` (AC-6), JSDoc `@internal` (AC-5), T-AL-DISC-06 hardening (AC-4), comment fix (AC-8), test 429 handler (AC-9). **Status**: APROBADO PARA DONE. 9/9 ACs PASS. 249/249 tests PASS. 0 drift. Branch `feat/081-wkh-91-discord-formatter-polish` @ 3b8cbd9.

## Pipeline ejecutado

- **F1**: work-item.md (gate: HU_APPROVED — resumen, 9 ACs EARS, sizing S, mini SDD)
- **F3**: implementación wave única en 2 archivos (alerts.mjs + alerts.test.mjs), sin AR/CR formales (FAST AUTO)
- **F4**: qa-report.md (gate: **APROBADO PARA DONE** — 9/9 ACs PASS con evidencia archivo:línea, 249/249 tests, 0 drift, light CR sin hallazgos)
- **DONE**: consolidación artefactos, `done-report.md` + `_INDEX.md` update

## Acceptance Criteria — resultado final

| AC | Status | Evidencia | 
|----|--------|-----------|
| AC-1: title truncate ≤256 + ellipsis | PASS | `src/alerts.mjs:94-98` `_truncate` impl; `src/alerts.mjs:164` applied to `embed.title`; runtime test title.length===256 ✓ |
| AC-2: description truncate ≤4096 + ellipsis | PASS | `src/alerts.mjs:70` `DESCRIPTION_MAX=4096`; `src/alerts.mjs:169` applied; runtime test desc.length===4096 ✓ |
| AC-3: `hostname` not `host`, port-stripped | PASS | `src/alerts.mjs:226` `DISCORD_HOSTS.has(parsed.hostname.toLowerCase())`; runtime `https://discord.com:8080/…` → isDiscord=true ✓ |
| AC-4: T-AL-DISC-06 unconditional assertions | PASS | `tests/alerts.test.mjs:357-390` zero `if (captured)` guards; assertions run unconditionally ✓ |
| AC-5: `@internal` JSDoc on `formatForDiscord` | PASS | `src/alerts.mjs:124` JSDoc + `src/alerts.mjs:149` export present ✓ |
| AC-6: `DEFAULT_SEVERITY_LABEL` constant | PASS | `src/alerts.mjs:74` defined; `src/alerts.mjs:159` used in place of literal ✓ |
| AC-7: `pickFirstNonEmpty` helper | PASS | `src/alerts.mjs:107-112` defined; `src/alerts.mjs:174-177` replaces nested ternary ✓ |
| AC-8: comment update "T-AL-DISC-01..08" | PASS | `tests/alerts.test.mjs:216` updated ✓ |
| AC-9: HTTP 429 → `{sent:false, status:429, reason:...}` | PASS | `src/alerts.mjs:258-263` production path; `tests/alerts.test.mjs:413-429` T-AL-DISC-08 test ✓ |

## Hallazgos finales

- **BLOQUEANTEs**: ninguno. QA APROBADO.
- **MENORs**: ninguno. Light CR no reportó issues.
- **Deuda técnica**: ninguna deferida.

## Archivos modificados

```
mcp-servers/wasiai-x402/src/alerts.mjs (producción)
  - _truncate(s, max) helper: lines 94-98
  - _pickFirstNonEmpty(...candidates) helper: lines 107-112
  - DEFAULT_SEVERITY_LABEL constant: line 74
  - @internal JSDoc on formatForDiscord: line 124
  - truncation applied to embed.title: line 164
  - truncation applied to embed.description: line 169
  - pickFirstNonEmpty used for timestamp resolution: lines 174-177
  - hostname fix (lowercase compare): line 226
  - 429 handler with exact shape: lines 258-263

mcp-servers/wasiai-x402/tests/alerts.test.mjs (tests)
  - T-AL-DISC-06 hardening: lines 357-390 (no if-guards, unconditional assertions)
  - T-AL-DISC-08 new test: lines 413-429 (HTTP 429 shape verification)
  - comment fix "T-AL-DISC-01..08": line 216
```

## Test Results

- Full suite: 249/249 PASS (248 baseline post-WKH-88 + 1 nuevo T-AL-DISC-08)
- Alerts-specific: 14/14 PASS
- Backward compat (Slack + Discord): verified
- Truncation runtime: verified (title 260→256, description 5000→4096)
- Port-in-URL runtime: verified

## Constraint Directives — compliance

Todos los 7 CD heredados de WKH-90 + 3 nuevos para WKH-91:

- ✓ CD-9: no webhookUrl en logs
- ✓ CD-12: sendAlert nunca lanza excepción
- ✓ CD-18: `redirect: 'error'` presente en fetch (line 243)
- ✓ CD-WKH91-1: ellipsis placed at end using `slice(0, max - 1) + '…'`
- ✓ CD-WKH91-2: hostname used (not host) + lowercase normalization
- ✓ CD-WKH91-3: T-AL-DISC-06 sin conditional assertions

## Decisiones diferidas a backlog

Ninguna. Todos los MNRs resueltos en esta HU. No hay spinoffs.

## Lecciones para próximas HUs

1. **Truncation + ellipsis es simétrico**: `slice(0, max - 1) + '…'` funciona para cualquier longitud máxima (title, description, custom fields). Extraer a helper reduce deuda.

2. **URL parsing gotchas**: `parsed.host` incluye puerto; `parsed.hostname` no. Siempre documentar la intención explícitamente en el comentario inline (WKH-91 no lo hizo — se asume conocimiento de `URL` API).

3. **Unconditional assertions en tests**: test bodies con guards condicionales (`if (captured)`) pueden enmascarar regresiones. Mockear siempre para garantizar determinismo path.

4. **Helper naming**: underscore prefix (`_truncate`, `_pickFirstNonEmpty`) es claro para "interno", pero JSDoc `@internal` debería ir en TODAS las funciones no-exportadas. Mejorar linting para detectar missing `@internal`.

## Próximos pasos

1. Auto-deploy via git-link: rama `feat/081-wkh-91-discord-formatter-polish` @ 3b8cbd9 → merge a main cuando el humano lo requiera (post-QA sign-off en repo).
2. Sin actividades manuales. Pipeline DONE.
3. Sin follow-up PRs requeridas.
