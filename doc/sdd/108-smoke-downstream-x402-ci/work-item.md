# Work Item — [WKH-108] Smoke de regresión commiteable (sin secretos) para el payout downstream x402

## Resumen
Crear un smoke de regresión **committeable y secret-free** que proteja la capacidad
OUTBOUND x402 (operator-float paga agentes downstream vía nuestro facilitator),
live + probada on-chain en Base Sepolia (WKH-106) y Avalanche Fuji (WKH-107).
Dos capas: una **liviana network-only** que corre siempre (asserta health/supported
del facilitator + chains + breaker), y una **E2E completa opt-in** (env-gated) que
espeja la lógica del smoke local gitignoreado y skippea limpio sin secrets.
Para: el equipo / CI. Por qué: detectar regresiones de deploy (facilitator caído,
chain dropeada, breaker abierto) sin necesidad de secrets, gas ni wallets fondeadas.

## Sizing
- SDD_MODE: mini
- Smart Sizing: **FAST+AR** (es test/CI, sin payment-path de producción nuevo; el AR
  se justifica por la regla "PROHIBIDO secrets/paths-absolutos" — Adversary debe
  verificar cero-secretos y skip-limpio antes del merge).
- Estimación: S
- Skills Router (máx 2): `x402-payments`, `ci-testing`
- Branch sugerido: `feat/108-wkh-108-smoke-downstream-x402-ci`

## Contexto verificado (F0 grounding)
- **NO hay GitHub Actions** — `.github/workflows/` no existe. CI/CD = Railway en push a `main`.
  NO hay gate de test-on-PR hoy.
- **Test runner = vitest** (`npm test` → `vitest run`, `vitest.config.ts` en raíz, tests en `test/`).
- **Precedente de smoke env-gated**: `test/smoke-passport-autonomous.test.mjs` (WKH-92) +
  `scripts/smoke-passport-autonomous.mjs` — patrón script standalone + wrapper vitest, skippable.
- **Lógica E2E de referencia**: `scripts/smoke-base-downstream.mjs` — **gitignoreado**
  (`.gitignore` línea 59). Ya está parametrizado por env (`A2A_BASE`, `FUNDER_PK`, `NETWORK`,
  `RPC_URL`, `AMOUNT`, `GAS_ETH`) pero requiere `FUNDER_PK` (secreto) + gas + bind real.
  NO apto para CI tal cual. Sirve como referencia para el modo E2E.
- **Facilitator deployado**: `https://wasiai-facilitator-production.up.railway.app`
  - `GET /health` → 200 (público, sin auth)
  - `GET /supported` → lista chains con `network`, `methods:['eip3009']`, `breakerState` (público)
  - `/settle` y `/verify` → exigen `Authorization: Bearer FACILITATOR_API_KEY`.

## Decisión de formato (DT-1, ver abajo): **script standalone `.mjs`**
La capa liviana es un script `.mjs` autoejecutable con exit codes (0 = pass, 1 = fail,
0+SKIP = E2E skippeado), invocable por `node scripts/...` y por un `npm run` script.
Justificación en DT-1. Se agrega un wrapper vitest fino para que `npm test` también lo
ejercite con asserts determinísticos (siguiendo el precedente WKH-92).

## Acceptance Criteria (EARS)

- **AC-1** (capa liviana — facilitator health): WHEN se ejecuta el smoke sin gate E2E,
  the system SHALL hacer `GET {FACILITATOR_URL}/health` y SHALL fallar (exit ≠ 0) si el
  status HTTP no es 200.

- **AC-2** (capa liviana — chains + métodos + breaker): WHEN se ejecuta el smoke sin gate
  E2E, the system SHALL hacer `GET {FACILITATOR_URL}/supported` y SHALL verificar que la
  lista incluye Base Sepolia (`eip155:84532`) y Avalanche Fuji (`eip155:43113`), cada una
  con `methods` conteniendo `eip3009` y `breakerState == 'CLOSED'`; SHALL fallar (exit ≠ 0)
  si falta cualquiera de las dos chains, falta `eip3009`, o un breaker no está `CLOSED`.

- **AC-3** (capa E2E — gate): WHERE la env-gate `RUN_DOWNSTREAM_E2E=1` está activa Y los
  secrets requeridos (`FUNDER_PK`) están presentes, the system SHALL correr el flujo real
  provision → discover → compose → downstream-settle on-chain (espejando
  `scripts/smoke-base-downstream.mjs`) y SHALL fallar si no se obtiene un `downstreamTxHash`.

- **AC-4** (skip-limpio): IF la env-gate `RUN_DOWNSTREAM_E2E` no está activa O falta algún
  secret requerido, THEN the system SHALL omitir la capa E2E, imprimir un mensaje `SKIP`
  explícito, y SHALL terminar con exit 0 (CI sin secrets pasa verde).

- **AC-5** (cero-secretos en el archivo): the system SHALL leer toda credencial, URL y
  parámetro desde variables de entorno con defaults a las URLs públicas de prod; el archivo
  committeado SHALL NO contener private keys, bearer tokens, API keys, ni paths absolutos de
  máquina (`/home/...`), ni referencias a `dev-tokens.env`.

- **AC-6** (opcional — A2A reachability) [TBD si se incluye]: WHEN se ejecuta la capa
  liviana, the system SHALL hacer `GET {A2A_URL}/health` y `GET {A2A_URL}/discover` y SHALL
  verificar que devuelve `base-demo`/`avax-demo` con `payment.chain` seteado. Marcado opcional:
  resolver en F2 si se incluye como assert duro o como check informativo no-bloqueante.

## Scope IN
- `scripts/smoke-downstream-x402.mjs` — NUEVO, committeado, secret-free (capa liviana + capa E2E opt-in).
- `test/smoke-downstream-x402.test.mjs` — NUEVO, wrapper vitest (asserta capa liviana + skip-limpio del gate).
- `package.json` — agregar script `smoke:downstream` (`node scripts/smoke-downstream-x402.mjs`).
- `doc/sdd/108-smoke-downstream-x402-ci/` — artefactos del pipeline.

## Scope OUT
- NO crear `.github/workflows/*.yml` en esta HU (no existe CI de Actions hoy; wirearlo es
  decisión ops separada → ver DT-2). El smoke queda invocable vía `npm run smoke:downstream`
  para que se cablee a un workflow después sin retrabajo.
- NO modificar `scripts/smoke-base-downstream.mjs` (gitignoreado, sigue como helper local).
- NO modificar el facilitator ni endpoints de prod.
- NO tocar `src/` (código de producción).
- NO fondear wallets ni ejecutar el E2E en CI por default.

## Decisiones técnicas (DT-N)
- **DT-1 — script `.mjs` standalone + wrapper vitest fino (no solo test vitest).**
  Justificación: (a) el flujo E2E necesita exit codes y mensajes legibles para correr
  manualmente (`node scripts/...`) y eventualmente desde un workflow CI con `npm run`;
  (b) reusar la lógica de `smoke-base-downstream.mjs` (que es `.mjs` standalone) es directo;
  (c) el precedente del repo (WKH-92) ya es exactamente este patrón script + wrapper vitest.
  El wrapper vitest garantiza que `npm test` ejercite la capa liviana de forma determinística
  y que el skip-limpio del E2E sea un test verde.
- **DT-2 — NO agregar GitHub Actions en esta HU.** El repo no tiene `.github/workflows/`
  y el CI es Railway-on-push. Agregar Actions es un cambio de superficie ops (permisos,
  secrets en GH, triggers) que merece su propia HU. Se deja el smoke invocable por `npm run`
  para cablearlo sin retrabajo. [NEEDS CLARIFICATION → resolver con humano si quiere el
  workflow ahora; default propuesto = NO].
- **DT-3 — env-gate = `RUN_DOWNSTREAM_E2E=1`.** Nombre explícito, alineado con el patrón
  de gates del repo. Secrets requeridos por la capa E2E: `FUNDER_PK` (+ defaults públicos
  para `A2A_BASE`, `FACILITATOR_URL`, `NETWORK`, `RPC_URL`).
- **DT-4 — chain IDs por CAIP-2 dinámico.** Las chains esperadas (`eip155:84532`,
  `eip155:43113`) se definen como constante de expectativa del smoke (lista de chains que
  DEBEN estar soportadas), no se hardcodean URLs ni contratos. Si se requiere parametrizar
  qué chains exigir, vía env `EXPECTED_CHAINS` (default a las dos testnet). [resolver en F2].

## Constraint Directives (CD-N)
- **CD-1 — PROHIBIDO secrets/paths-absolutos en el archivo committeado.** El `.mjs` y el
  test NO pueden contener private keys, bearer tokens, API keys, paths `/home/...`, ni
  referencias a `dev-tokens.env`. Todo por env con defaults públicos. Adversary debe grepear
  `0x[0-9a-f]{40,}`, `Bearer `, `/home/`, `dev-tokens` y fallar el AR si aparece.
- **CD-2 — OBLIGATORIO skip-limpio sin secrets.** Sin `RUN_DOWNSTREAM_E2E=1` o sin
  `FUNDER_PK`, la capa E2E DEBE skippear con exit 0 + mensaje `SKIP`. Un fallo de la capa E2E
  por secret ausente es un BUG (rompe CI sin secrets).
- **CD-3 — OBLIGATORIO no romper CI/`npm test` existente.** El wrapper vitest no debe
  introducir flakiness en `npm test` cuando el facilitator de prod esté caído de forma
  transitoria: definir si la capa liviana dentro de vitest es bloqueante o se marca
  skippeable bajo otra gate (`RUN_NETWORK_SMOKE`). [resolver en F2 — ver Missing Inputs].

## Missing Inputs
- **[resuelto en F2]** Si la capa liviana network-only debe ser bloqueante dentro de
  `npm test` (la suite local pasa a depender de que el facilitator de prod esté up) o si se
  pone tras una gate `RUN_NETWORK_SMOKE=1` y `npm test` solo corre los asserts de skip-limpio.
  Default propuesto: gate `RUN_NETWORK_SMOKE` para no acoplar la suite unit a prod uptime;
  el script standalone sí hace los asserts de red siempre.
- **[resuelto en F2]** AC-6 (A2A reachability `/discover` base-demo/avax-demo): incluir como
  assert duro vs check informativo. Default propuesto: informativo no-bloqueante (el contrato
  fuerte es el facilitator).
- **[NEEDS CLARIFICATION]** ¿El humano quiere el workflow de GitHub Actions en esta HU
  (DT-2)? Default = NO (Scope OUT).

## Análisis de paralelismo
- Esta HU NO bloquea otras y puede ir en paralelo. Es aditiva (archivos nuevos + 1 script en
  package.json), no toca `src/` ni el facilitator. No hay dependencia con WKH abiertas.
- Depende (en runtime, no en código) de que WKH-106/107 sigan deployados — que es
  precisamente lo que el smoke protege.
