# Validation Report — WKH-342 (F4)

**Veredicto**: APROBADO PARA DONE — 7/7 ACs PASS.
Repos: A `wasiai-facilitator@464380c` (base `b896228`) · B `wasiai-a2a@6b72396` (base `568cf40`).

## ACs
| AC | Status | Evidencia | Input que lo pondría en rojo |
|----|--------|-----------|-------------------------------|
| AC-1 | PASS | `src/routes/supported.ts:101-107` (`app.hasRoute`) + `src/__tests__/unit/routes.supported.test.ts:860-928` (T-A1/T-A2/T-A2b) | comentar el `.filter(app.hasRoute)` — T-A1/T-A2 rojos |
| AC-2 | PASS | `facilitator-settle.ts:600-628` (gate perezoso) + `src/index.ts:355` (`warmPayoutRoutePreflight()`, sin `if`) + `facilitator-settle.wiring.test.ts:51-97` (T-B7, lee texto — declarado, no ejecución real) | envolver la línea en `if (...) { warmPayoutRoutePreflight(); }` bloque multilínea — T-B7 sigue verde (residuo declarado) |
| AC-3 | PASS | `facilitator-settle.ts:622-631` + `facilitator-settle.test.ts:375-412` (T-B3/T-B3b/T-B3c) — **mutante propio**: invertí `'route_absent'`→`'route_registered'` en `:623` (sha256 difirió: `3da8a9d…`→`a4ffa44…`), 7 tests KILLED, reverti con `cp` (sha256 vuelve a `3da8a9d…`) | volver a comparar contra `route_registered` en el gate |
| AC-4 | PASS | `facilitator-settle.ts:186-380` (4 razones: `transport_error/probe_http_error/body_unreadable/field_absent`) + `T-B4-B6,T-B12,T-B6d` — probé YO `{"dedicatedRoutes":[{"id":"POST /solana/payout"}]}` (T-B12, línea 537-552: `route_unaskable`, POST SÍ sale) | colapsar `route_unaskable` dentro de `route_absent` |
| AC-5 | PASS | `T-B8` (`facilitator-settle.test.ts:645-673`, 6 valores de bandera ⇒ cero fetch) + 0 archivos EVM tocados en los 2 diffs (`git diff --name-only` grepeado) | quitar el `isPayoutViaFacilitatorOn()` guard |
| AC-6 | PASS | `facilitator-settle.ts:629` reusa `'not-sent'` (6 call-sites vs 5 en base, medido) · `routes.openapi.test.ts:251-301` (T-O6, deriva de `getSupportedResponse()` real, no hardcode) | agregar un 4º `DedicatedRouteId` sin actualizar `DEDICATED_ROUTE_PROBES` (Record exhaustivo lo aborta en compilación) |
| AC-7 | PASS | `openapi.yaml` diff: `required` aditivo, `dedicatedRoutes` nuevo campo · `sdd.md:44-49` (H-2, MEDIDO: 0 consumidores reales en wasiai-v2, sólo `scripts/*.mjs` con `.includes`) | quitar `chains`/`methods` del schema existente |

## Los 4 desenlaces — confirmado con sonda propia
(a) unión discriminada sin booleanos: `PayoutRouteVerdict` (`facilitator-settle.ts:213-227`), 3 estados + 4 razones de `unaskable`.
(b) cuarto desenlace: probé el objeto `{id:...}` (T-B12, ya no `route_absent`) — **y el control inverso**: `dedicatedRoutes: []` sigue cortando (T-B3, confirmado con mi mutante KILLED arriba).
(c) normalización no fabrica falso positivo — sonda propia (`tsx`, fetch mockeado): `payout-v2`→`route_absent`, `/solana/payout/`→`route_absent`, `GET /solana/payout`→`route_absent`. Los 3 correctos.
(d) asimetría: `route_unaskable` deja pasar (T-B6d, 4 razones). Exhaustividad: agregué un 5º estado ficticio a un switch idéntico en archivo temporal (`__wkh342_probe_exhaustive.ts`, borrado tras la prueba) — `tsc --noEmit` dio **TS2322 "not assignable to 'never'"**.

## Aislamiento — 3 mecanismos
18 `it(` en `payment.flag.test.ts`. (1) `vitest -t "<nombre exacto escapado>" --reporter=json`, 18 corridas, cada una `numPassedTests=1, numFailedTests=0` (no confundible con "0 tests"). (2) `grep -n "it.skip\|describe.skip\|.only("` → 0 matches, descarta el truco que usó el CR antes. (3) corrida completa del archivo junto: `18 passed / 0 failed`. Los 3 coinciden.

## Baseline (derivado, no heredado)
A: `npm test` → **92 files / 1361 tests** ✅ · `tsc --noEmit`, `typecheck:tests`, `biome lint src/ --max-warnings 0`, `prettier --check` → **los 4 en 0**, corridos directo (no `npx`).
B: `vitest run --reporter=json` → **280 files / 5410 tests / 5391 passed / 19 skipped / 0 failed** ✅ · worktree de `568cf40` da **5377 tests** ⇒ **+33 derivado** (no heredado) · `tsc --noEmit` 0 · `node_modules/.bin/biome check src/` (binario directo, no `npx`) → **473 files, 0** ✅.
Disposición: 6 call-sites de `FacilitatorSettleError` en B (base 5), la nueva reusa `'not-sent'` — 0 `success:true/false` nuevos. 0 `.env*` y 0 archivos EVM en los 2 diffs.

## Residuo (declarado, no oculto)
Ninguna mitad está desplegada (`git merge-base --is-ancestor` confirma: ni `464380c` ni `6b72396` son ancestros de `main`) — el guard está inerte en prod. `route_absent` sólo se probó contra dobles (fetch mockeado). Warm-up: T-B7 lee texto (declarado en su propio docblock, líneas 25-39) — un bloque multilínea lo pasaría. `/health` con el mismo defecto queda fuera a propósito (no tocado en el diff). Enum derivado puede volver a divergir si alguien reescribe `DEDICATED_ROUTE_IDS` a mano en vez de derivarlo — mitigado, no eliminado.

## Drift
`git status --short` A: vacío. B: sólo las 10 entradas preexistentes (`_INDEX.md` + 9 doc paths no tocados por esta HU). Sin scope drift.

## Gates
A y B — confirmados arriba con re-ejecución propia (no heredados de CR).
