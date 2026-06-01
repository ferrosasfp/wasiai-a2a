# Done Report — WKH-108 Smoke de regresión commiteable downstream x402 CI

## Resumen ejecutivo

Se entregó un smoke de regresión commiteable y secret-free que protege la capacidad OUTBOUND x402 (operator-float paga agentes downstream vía facilitator) live en Base Sepolia (WKH-106) y Avalanche Fuji (WKH-107). El smoke tiene dos capas: una liviana network-only que corre siempre (facilitator health + supported chains + breaker) y una E2E opt-in gated por env. Pipeline FAST+AR completado: AR APROBADO 0 findings, CR APROBADO con 4 MENORs (3 cerrados por fix-pack, MNR-4 registrado como decisión de gate aprobada por el humano). F4 QA: APROBADO PARA DONE, 6 ACs PASS con evidencia archivo:linea. Status: DONE.

## Pipeline ejecutado

- F0: project-context cargado — contexto WasiAI A2A, stack, patrón smoke WKH-92
- F1: `work-item.md` — HU_APPROVED (2026-06-01); DT-2 NEEDS CLARIFICATION resuelto a SI por Fernando en gate
- F2/F2.5: `sdd.md` + `story-file.md` — SPEC_APPROVED (2026-06-01), modo mini (FAST+AR)
- F3: implementación en 1 wave, 4 archivos creados (detalle abajo)
- AR: APROBADO, 0 findings — cero-secretos verificado, skip-limpio verificado, asserts estrictos, smoke live PASS
- CR: APROBADO con 4 MENORs — fix-pack cerró MNR-1/2/3; MNR-4 registrado como decisión de gate
- F4: APROBADO PARA DONE — 6 ACs PASS con evidencia archivo:linea, drift limpio (src/ intacto)

## Archivos entregados

| Archivo | Descripcion |
|---------|-------------|
| `scripts/smoke-downstream-x402.mjs` | Script standalone secret-free. Capa liviana: health + supported + breaker. Capa E2E opt-in gated por `RUN_DOWNSTREAM_E2E=1` + `FUNDER_PK`. Incluye `fetchWithTimeout`. |
| `test/smoke-downstream-x402.test.mjs` | Wrapper vitest. Corre capa liviana si `RUN_NETWORK_SMOKE=1`; sin esa gate verifica solo skip-limpio. Integrado en `npm test`. |
| `package.json` | Script `"smoke:downstream": "node scripts/smoke-downstream-x402.mjs"` agregado. |
| `.github/workflows/smoke-downstream.yml` | Workflow GitHub Actions. Triggers: push:main, PR, schedule diario 06:00 UTC. `continue-on-error` condicional a PR (informativo en PR; hard-fail en push:main y schedule). Secreto `FUNDER_PK` optional: smoke corre en capa liviana sin el secret. |

## Como ejecutar el smoke

```bash
# Capa liviana (network-only, sin secrets, siempre disponible):
npm run smoke:downstream

# Wrapper vitest con capa de red (dentro de npm test):
RUN_NETWORK_SMOKE=1 npm test

# Capa E2E completa (requiere wallet fondeada con gas + USDC):
RUN_DOWNSTREAM_E2E=1 FUNDER_PK=0x... npm run smoke:downstream

# Con URLs custom (para entornos staging):
A2A_BASE=https://... FACILITATOR_URL=https://... npm run smoke:downstream
```

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 — facilitator health | PASS | `scripts/smoke-downstream-x402.mjs`: GET `/health` → exit 1 si status != 200. Smoke live: 200 OK. |
| AC-2 — chains + eip3009 + breaker | PASS | `scripts/smoke-downstream-x402.mjs`: verifica `eip155:84532` (Base Sepolia) + `eip155:43113` (Avalanche Fuji) en `/supported`, cada una con `methods` incluyendo `eip3009` y `breakerState == 'CLOSED'`. |
| AC-3 — E2E gate activa | PASS | `scripts/smoke-downstream-x402.mjs`: bloque `if (RUN_DOWNSTREAM_E2E && FUNDER_PK)` corre flujo provision → discover → compose → downstream-settle, falla si no hay `downstreamTxHash`. |
| AC-4 — skip-limpio | PASS | Sin `RUN_DOWNSTREAM_E2E=1` o sin `FUNDER_PK`: imprime `[SKIP] E2E downstream omitido`, exit 0. Verificado en vitest: test "E2E skippea limpio sin gate" verde. |
| AC-5 — cero-secretos | PASS | AR grepeó `0x[0-9a-f]{40,}`, `Bearer `, `/home/`, `dev-tokens` — resultado LIMPIO. Toda credencial por env con defaults a URLs publicas de prod. |
| AC-6 — A2A reachability (informativo) | PASS | `scripts/smoke-downstream-x402.mjs`: GET `/discover` → check informativo no-bloqueante (log warning, no exit 1). Resuelto como informativo en F2 (MNR-1 cerrado). |

## Hallazgos finales

- BLOQUEANTEs: 0
- MENORs: 4 detectados en CR
  - MNR-1 (A2A /discover no-bloqueante): CERRADO en fix-pack
  - MNR-2 (fetchWithTimeout — evita hang en CI): CERRADO en fix-pack
  - MNR-3 (continue-on-error condicional a PR): CERRADO en fix-pack
  - MNR-4 (workflow DT-2 scope change): REGISTRADO como decision de gate aprobada — ver seccion dedicada abajo

## Registro de decision MNR-4 — Workflow GitHub Actions (DT-2)

El `work-item.md` marcaba en DT-2 y en Scope OUT: "NO crear `.github/workflows/*.yml` en esta HU" con estado `[NEEDS CLARIFICATION → resolver con humano si quiere el workflow ahora; default propuesto = NO]`.

Durante el gate HU_APPROVED, el humano (Fernando) resolvio el NEEDS CLARIFICATION a **SI**: incluir el workflow GitHub Actions para que el smoke sea regresion de CI real, no solo un script invocable manualmente.

Esta decision fue tomada por el humano antes de que comenzara F3. No es scope drift no-autorizado. El CR lo marco como MNR-4 para documentar la divergencia entre el Scope OUT del work-item y la implementacion final, pero el veredicto es ACEPTADO sin fix requerido. El workflow `.github/workflows/smoke-downstream.yml` es parte del entregable.

## Auto-Blindaje consolidado

Ver `/home/ferdev/.openclaw/workspace/wasiai-a2a/doc/sdd/108-smoke-downstream-x402-ci/auto-blindaje.md` (inmutable, 1 entrada).

Resumen de la entrada:

| Fecha | Contexto | Error | Causa raiz | Fix |
|-------|----------|-------|------------|-----|
| 2026-06-01 | Fix-pack F3 — biome en archivos .mjs | `biome check --write` con `files.includes` apuntando a paths literales `.mjs` reporto "No files were processed" | `biome.json` del repo restringe `files.includes` a `src/**/*.ts`; paths literales para extensiones no-.ts son ignorados | Usar config temporal con `files.includes: ["**/*.mjs"]` (glob por extension) + pasar archivos como argumentos. Biome proceso 2 files. |

Leccion para proximas HUs: para lint/format de scripts `.mjs`/`.cjs` fuera de `src/`, usar config temporal con `includes: ["**/*.mjs"]`; el `biome.json` del repo solo cubre `src/**/*.ts`.

## Decisiones diferidas a backlog

Ninguna. La HU fue completamente contenida en archivos de test/scripts/CI. No se generaron spinoffs.

El smoke existente (`scripts/smoke-base-downstream.mjs`, gitignoreado) permanece sin modificacion como helper local de referencia.

## Lecciones para proximas HUs

1. **NEEDS CLARIFICATION en work-item debe resolverse en gate**: el patron DT-2 (marcar una decision con `[NEEDS CLARIFICATION]` y `default = NO`) funcio correctamente — el humano resolvio en el gate antes de F3. Usar este patron siempre que haya ambiguedad de scope antes de comprometerse a Scope OUT.

2. **biome no procesa .mjs por default**: el `biome.json` del repo cubre solo `src/**/*.ts`. Para fix-packs o waves que toquen scripts `.mjs`, usar un config temporal con `files.includes: ["**/*.mjs"]`. Documentado en auto-blindaje.

3. **fetchWithTimeout es obligatorio en smokes de CI**: un smoke sin timeout puede bloquear indefinidamente un workflow de CI. Toda llamada de red en scripts de smoke debe tener un timeout explicito con exit 1 limpio al vencer.

4. **continue-on-error condicional por trigger**: en workflows de GitHub Actions que cubren tanto PRs como push a main, `continue-on-error: true` incondicional silencia fallos en main. El patron correcto: `continue-on-error: ${{ github.event_name == 'pull_request' }}`.
