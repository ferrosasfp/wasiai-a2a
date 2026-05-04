# Report — HU [WKH-87] Public Docs Refinements

**Status**: DONE | **Date**: 2026-05-04 | **Branch**: `docs/083-wkh-87-public-docs-refinements` @ `4bcd8a0`

---

## Resumen ejecutivo

Carry-forward completado de 8 correcciones técnicas (MNR residuos de WKH-82 CR iter 2 + AR) a documentación pública. **Cero cambios a `src/`** — scope puramente doc. Entrega: Node 20+ requirement, inline `chain.ts` en networks.md, bash/curl equivalente Step 4, "Versioning & Stability" policy, JSON-RPC error shapes + REST envelopes, 4 muestras TS individuales para herramientas MCP self-hosted, y ancla estable en lugar de citation de líneas. **7/7 ACs PASS**, tests (794/794) preservados, **APROBADO para DONE**.

---

## Pipeline ejecutado

| Fase | Evento | Fecha | Veredicto |
|------|--------|-------|-----------|
| F0 | project-context cargado | 2026-04-28 | — |
| F1 | work-item.md + ACs EARS (7 criteria) | 2026-05-03 | — |
| F2 | SDD mini completado (inline directives + ejemplos) | 2026-05-03 | — |
| F2.5 | story-file.md generado (docs-only) | 2026-05-03 | — |
| F3 | Implementación wave 1: 4 archivos docs/ modificados | 2026-05-04 | ✓ |
| AR | Adversary Review (N/A — docs-only FAST) | — | — |
| CR | Code Review (N/A — docs-only FAST) | — | — |
| F4 | QA nexus-qa — validación ACs + tests | 2026-05-04 | **APROBADO** |
| DONE | Reporte final + índice | 2026-05-04 | ✓ |

---

## Acceptance Criteria — Resultado Final

| AC | Status | Evidence |
|----|--------|----------|
| AC-1: Node 20+ in getting-started Prerequisites | ✅ PASS | `docs/getting-started.md:23` requiere Node.js 20+ + nota crypto.getRandomValues (líneas 24-26) |
| AC-2: Inline chain.ts (kiteTestnet + kiteMainnet) | ✅ PASS | `docs/networks.md:51-117` — byte-for-byte mirror de `src/adapters/kite-ozone/chain.ts`, 4 exports con CD-WKH87-4 sync note |
| AC-3: Bash/curl equivalent Step 4 (EIP-712) | ✅ PASS | `docs/getting-started.md:396-474` — node -e one-liner + viem + crypto.randomBytes con placeholders `<YOUR_*>` (CD-WKH87-2) |
| AC-4: Versioning & Stability section | ✅ PASS | `docs/api-reference.md:376-455` — stable v1, breaking change rules, 90-day deprecation, /health version detection con JSON |
| AC-5: JSON-RPC + REST error shapes | ✅ PASS | `docs/api-reference.md:458-534` — JSON-RPC envelope (465-481) + REST envelope (500-505) + x402 extended (511-517), reflejando shape real del gateway |
| AC-6: 4 TS samples (pay_x402, get_payment_quote, discover_agents, orchestrate) | ✅ PASS | `docs/mcp-integration.md` — pay_x402 (98-130), get_payment_quote (156-176), discover_agents (204-226), orchestrate (259-283) con nota inline CD-WKH87-3 sobre decimal quirk |
| AC-7: Stable anchor en lugar de line-range citation | ✅ PASS | `docs/api-reference.md:537-544` — reemplaza "lines 100-121" con anchor estable "// Routes comment block + registriesRoutes...mcpPlugin" |

**Veredicto QA**: 7/7 ACs PASS ✅

---

## Hallazgos finales

### Bloqueantes
None — zero issues.

### Menores (si existían)
- **CD-WKH87-3 enforcement** (nota decimal quirk en samples): documentado inline en AC-6 evidence.
- **CD-WKH87-4 (sync note)**: agregada línea 56-58 en networks.md para trackeabilidad futura. Si `src/adapters/kite-ozone/chain.ts` se actualiza, este HU deja explícito que docs/ debe sincronizar.

---

## Consolidación de Constraint Directives + Decisiones Técnicas

Todos los directives fueron honrados:

| Directive | Aplicación | Status |
|-----------|-----------|--------|
| CD-WKH87-1: TS samples verificable contra src/ types | Networks.md + MCP samples comparan contra src/adapters, src/services | ✓ |
| CD-WKH87-2: bash/curl runnable as-is, placeholders explícitos | Step 4 curl muestra `<YOUR_KITE_TESTNET_PRIVATE_KEY>`, `<YOUR_PAYMENT_TOKEN_ADDRESS>` | ✓ |
| CD-WKH87-3: Nunca refdes 18-decimal como correcto | AC-6 incluye nota "decimal quirk — legacy default, NOT real token count" | ✓ |
| CD-WKH87-4: chain.ts sync con src/adapters/kite-ozone/chain.ts | Sync note + link en docs/networks.md | ✓ |
| DT-1: chain.ts exacto match de exports | kiteTestnet, kiteMainnet, getKiteChain, getKiteNetwork — todos presentes | ✓ |
| DT-2: node -e para Step 4 (crypto.randomBytes portable) | Implemented en getting-started Step 4 equiv | ✓ |
| DT-3: line-range citation → stable anchor | AC-7 verifica y reemplaza con function-block reference | ✓ |

---

## Archivos modificados

**Scope IN** (4 archivos, +430 líneas, -5 líneas):

1. `docs/api-reference.md`
   - AC-4 "Versioning & Stability" section (71 líneas nuevas)
   - AC-5 error shape examples + JSON-RPC/REST envelopes (77 líneas nuevas)
   - AC-7 stable anchor (8 líneas nuevas)
   - Delta: +171 / -5

2. `docs/getting-started.md`
   - AC-1 Node 20+ requirement update (3 líneas)
   - AC-3 bash/curl Step 4 equivalent + node -e one-liner (85 líneas nuevas)
   - Delta: +85 / -0

3. `docs/mcp-integration.md`
   - AC-6 individual TS samples para 4 tools (4 × 28 líneas aprox)
   - Delta: +106 / -0

4. `docs/networks.md`
   - AC-2 inline chain.ts TypeScript block (67 líneas nuevas)
   - CD-WKH87-4 sync note (1 línea)
   - Delta: +68 / -0

**Scope OUT** (como especificado en work-item.md):
- `src/` — zero changes
- `test/` — zero changes
- `mcp-servers/` — zero changes

---

## Verificación de Drift

| Check | Resultado |
|-------|-----------|
| Regresión en tests | ✅ 794/794 PASS (docs-only, cero cambios a src/) |
| Errores de tipo TS | ✅ N/A (docs-only, sin linting requerido) |
| DB/env/migration | ✅ N/A (docs-only) |
| Line-number stability | ✅ AC-7 verifica anchor estable (no hardcoded line nums) |

---

## Decisiones diferidas a backlog

None — este HU cierra el carry-forward de MNRs de WKH-82 completamente. No hay spinoffs pendientes.

### Relacionados (ya DONE en pipeline):
- **WKH-82** (Public Docs & Onboarding) — completed 2026-05-02, este HU resuelve residuos CR.
- **Decimal drift bug en `src/`** — explícitamente OUT OF SCOPE, será ticket separado si es requerida.

---

## Lecciones para próximas HUs

1. **Carry-forward doc-only MNRs rápidamente en FAST mode**: Este HU demuestra que correcciones técnicas puras a docs (sin cambio de código) pueden procesarse en FAST AUTO sin AR/CR gates, acelerando cierre de épicas anteriores.

2. **Inline code samples requieren sync notes explícitas**: El comment `CD-WKH87-4` en networks.md es una defensa contra drift futuro. Aplicable a cualquier HU que replica código de `src/` en `docs/`.

3. **Placeholders en samples evitan copypaste errors**: AC-3 y AC-6 muestran que `<YOUR_VARIABLE_NAME>` es más claro que comentarios — desarrolladores no corren accidentalmente con placeholders.

4. **Stable anchors > hardcoded line numbers**: AC-7 fue clave — reemplazar "lines 100-121" con "// Routes comment block at..." elimina churn futuro por reordenamiento.

---

## Testing + Quality Gates

| Criterio | Status | Evidencia |
|----------|--------|-----------|
| Todos los ACs tienen evidence archivo:línea | ✅ PASS | qa-report.md cita cada AC con range exacto |
| Tests previos preservados (no regresión) | ✅ PASS | 794/794 PASS |
| Zero drift a src/ | ✅ PASS | 4 docs files only |
| Constraint Directives honored | ✅ PASS | todos honrados, tabla arriba |
| Ready for merge | ✅ PASS | qa-report.md: "APROBADO PARA DONE" |

---

## Cierre

**Veredicto final: DONE ✅**

Documentación pública refinada y consolidada. Node version requirement alineada, ejemplos self-contained listos para copypaste, error shapes documentadas, MCP tooling samples completas. Cero deuda técnica en docs, zero código pendiente. Branch lista para merge a `main`.
