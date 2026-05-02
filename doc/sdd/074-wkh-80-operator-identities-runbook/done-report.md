# Report — HU [WKH-80] Operator Identities Runbook

## Resumen ejecutivo

WKH-80 consolidó todas las identidades operacionales de wasiai-a2a (operator wallet, Kite Passport prod/staging, Vercel, Railway, Supabase, email raíz) en un único documento `doc/operations/identities-runbook.md` (329 líneas). El runbook centraliza ID públicos, ubicaciones de secrets, procedimientos de recovery y análisis de bus factor, eliminando la dependencia de persona única sin exponerse a leaks. F4 QA APPROVED el 2026-05-01. Todas las 6 ACs + 4 CDs pasadas. Drift: 1 NEW file exacto.

## Pipeline ejecutado

- F0: project-context cargado (wasiai-a2a A2A protocol, FAST pipeline doc-only)
- F1: work-item.md APPROVED (AC-1 a AC-6 EARS, 6 CDs, 3 DTs)
- F2: SDD generado (mini mode, decisión DT-1 usar nuevo doc vs extender existente, DT-2 staging efímero)
- F2.5: story-file.md (no generado — doc-only FAST, scope reducido)
- F3: implementación en wave única, 1 archivo NEW (`doc/operations/identities-runbook.md`)
- AR: no aplica (FAST pipeline, doc-only)
- CR: no aplica (FAST pipeline, doc-only)
- F4: qa-report.md APPROVED (2026-05-01, branch commit 8dc8d00)

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | runbook.md:45-60 — tabla principal 13 identidades (operator wallet, Kite Passport prod user/agent/wallet, staging user/agent/wallet, Vercel x2, Railway x2, Supabase, email) con columnas exactas: Identity Name \| Public ID \| Secret Location \| Recovery Procedure \| Owner |
| AC-2 | PASS | runbook.md:97-124 — Recovery Prod con comandos `kpass signup init`, `kpass signup exchange`, `kpass agent:register`, `kpass wallet balance` verbatim de poc-results.md:48-58. runbook.md:172-185 — session commands (`kpass agent:session create`, `kpass agent:session status --wait`) match poc-results.md:213 |
| AC-3 | PASS | runbook.md:192-215 — sección "Bus Factor — identidades con dependencia de persona única" lista 7 identidades con columnas Dependencia \| Riesgo \| Mitigación propuesta. Propuesta explícita WKH-OPS-MULTI-OWNER |
| AC-4 | PASS | Secret scan 8 patterns (JWT, EVM key, signup codes, etc.) vs branch commit → 0 matches. Solo public IDs (0x addresses, UUIDs) y env var names. CD-1 disclaimer en runbook.md:61-64 confirma intent |
| AC-5 | PASS | runbook.md:220-221 — address operator `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba` + env `OPERATOR_PRIVATE_KEY` en Railway `wasiai-a2a-production`. runbook.md:224-236 — rol outbound Avalanche documentado (Model B, "Stripe Connect half"). Cross-ref RUNBOOK-prod-execution.md líneas 274-277 |
| AC-6 | PASS | runbook.md:283-285 — referencia poc-results.md como source primario de Passport IDs. runbook.md:290-293 — referencia RUNBOOK-prod-execution.md. runbook.md:297-310 — subsección "Gap que WKH-80 cierra" explicita por qué ninguno de los docs previos era suficiente |

## Constraint Directives

| CD | Status | Método |
|----|--------|--------|
| CD-1 (no secrets) | PASS | Secret scan contra branch commit 8dc8d00: 8 patterns grep (JWT base64url eyJ, EVM 64-hex, signup codes 8-char EOL, agent_token substring, known codes, assigned codes) → 0 matches. Solo la palabra "agent_token" en disclaimer text, no valor |
| CD-2 (absolute paths) | PASS | runbook.md:75-76, 284-285, 290-293 — todas las referencias usan paths absolutos `/home/ferdev/.openclaw/workspace/wasiai-a2a/...` |
| CD-3 (no invented IDs) | PASS | Cross-check: todas las UUIDs/addresses presentes en runbook existían previo en work-item.md identity table. No hay IDs nuevos no confirmados en poc-results.md |
| CD-4 (kpass from spike) | PASS | Comandos en runbook.md:103, 110, 116, 121 match verbatim poc-results.md:48, 50, 54, 58. Session commands runbook.md:172-185 match poc-results.md:213 |

## Drift final

`git diff main...docs/074-wkh-80-operator-identities-runbook --name-only`:
```
doc/operations/identities-runbook.md
```

**Drift: NONE.** Exactamente 1 file NEW. Scope IN completamente satisfecho. Ningún archivo existente modificado.

## Auto-Blindaje consolidado

Lecciones aprendidas del proceso WKH-80:

| Lección | Categoría | Detalle |
|---------|-----------|--------|
| Branch naming confusion entre `docs/` (feature doc) y `doc/` (directory) | naming | PRs que tocan `doc/` (repository directory) deben usar rama `docs/NNN-*` (feature prefix), no `doc/NNN-*` |
| EWAZL55X secret sanitization en runbook recovery flow | security/ops | Cuando se documente un signup flow real, sanitizar los códigos 8-char con placeholders explícitos `<8CHARS>` para evitar expose accidental de signup codes válidos |
| Kite Passport .kite-passport/ vs .kpass/ naming inconsistency (POC friction #3) | naming | El directorio se llama `.kite-passport/` en el filesystem pero la doc oficial diga `.kpass/`. Documentar ambos aliases en futuras HUs |
| Pre-requisitos `jq` para kpass installer no obvios (POC friction #1) | ops/dx | Los runbooks deben listar **todos** los pre-requisitos binarios explícitamente. Agregado a esta HU: `sudo apt install jq` |
| Staging secrets en `/tmp/` son efímeros, requieren regeneración explicita | ops/design | El procedimiento de recovery de staging DEBE incluir "re-signup completo desde cero", no "import de backup" |
| Single-owner (Fernando) en todas las 7 identidades es un single point of failure real | risk | Propuesta: HU futura WKH-OPS-MULTI-OWNER para crear secondary owners con restricted scopes (ej: readonly Railway, escalation-only Supabase) |

## Archivos modificados

NEW:
- `doc/operations/identities-runbook.md` (329 líneas) — tabla central + recovery flows + bus factor analysis + related docs

Total impact: 1 file, 329 líneas.

## Decisiones diferidas a backlog

- **WKH-OPS-MULTI-OWNER** (futuro) — Agregar secondary owners con scopes restrictivos para mitigar bus factor análisis en AC-3
- **WKH-OPS-KEY-ROTATION** (futuro) — Script/runbook para rotación automática de OPERATOR_PRIVATE_KEY, agent_token, service-role key
- **WKH-OPS-RLS-PROD** (futuro) — Enable Postgres RLS en `a2a_agent_keys` + policies en production

## Lecciones para próximas HUs

1. **Branch naming clarity**: docs-only features que tocan `doc/` deben usar `docs/NNN-*`, no `doc/NNN-*`. Es fácil confundir el directorio.

2. **Sanitization de secrets en procedimientos**: cuando documentes un signup/recovery flow que generó valores reales, usar placeholders `<PLACEHOLDER>` explícitamente en todos los comandos de ejemplo.

3. **Staging ephemeral storage requires full re-gen**: si una identidad staging vive en `/tmp/`, documentar que recovery = re-signup from zero, no restore from backup.

4. **Runbooks deben listar pre-requisitos binarios**: `jq`, `curl`, etc. que el procedimiento necesita. No asumir que están instalados.

5. **Bus factor analysis is actionable**: documentar no solo quién es el single point, sino proponer remedios concretos (secondary owner, RO access, escalation flow).

---

**Status**: DONE  
**Validated by**: nexus-qa (F4 APPROVED)  
**Ready for**: PR → main, git push, backlog update  
