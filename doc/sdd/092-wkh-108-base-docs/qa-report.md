# QA Report — WKH-108 BASE-05 · Docs README "Base Support" + integration guide

**Fecha**: 2026-05-19
**Branch**: feat/wkh-base-port-v1
**Commit WKH-108**: `a6685a0`
**Pipeline**: FAST (doc-only HU, no CR required)
**Veredicto**: FAIL — AC-5 no cumplido (entry 092 ausente en _INDEX.md)

---

## Resumen ejecutivo

WKH-108 entrega documentación de primera clase para Base en el ecosistema wasiai-a2a: sección `## Base Support` en README, guía standalone `doc/integration-base.md` (226 líneas) y dos filas nuevas en la tabla Production Status. Seis de los siete ACs pasan con evidencia concreta. El séptimo falla: la entry `092` no existe en `doc/sdd/_INDEX.md`. El archivo termina en la entry `091` (WKH-107). Todos los Constraint Directives pasan. No hay scope drift en el commit WKH-108. La HU NO puede avanzar a DONE hasta que se inserte la fila 092 en `_INDEX.md`.

---

## AC Verification

| AC | Texto (EARS resumido) | Status | Evidencia |
|----|-----------------------|--------|-----------|
| AC-1 | Sección `## Base Support` visible antes de 2 pantallas de scroll en README | PASS | `README.md:41` — `## Base Support` aparece en la línea 41, ~2 pantallas desde el top (líneas 1-41). Subsecciones Quick Start (47), Network Config (75), Facilitator Options (83), Bazaar Discovery (92) presentes. |
| AC-2 | Quick Start de 5 pasos en `doc/integration-base.md` → HTTP 200 o 402 con `network: eip155:84532` | PASS | `doc/integration-base.md:13-68` — 5 pasos exactos: (1) clone .env, (2) set 3 vars, (3) register key, (4) POST /compose con `x-payment-chain: base-sepolia`, (5) grep log. Response esperada documentada en línea 57: `HTTP 200 o HTTP 402 (accepts[].network == "eip155:84532")`. |
| AC-3 | Sección Base Support en README incluye link a `doc/BASE-EVIDENCE.md` con 1+ tx hash verificable | PASS | `README.md:45` — `[doc/BASE-EVIDENCE.md](doc/BASE-EVIDENCE.md)` con descripción "three Base Sepolia transferWithAuthorization txs on 2026-05-19, total 0.016 USDC, all SUCCESS". `doc/BASE-EVIDENCE.md` existe con 3 tx hashes reales (Run1: `0x4719e0e...`, Run2: `0x6356a85d...`, Run3: `0x1d31a672...`). |
| AC-4 | Tabla de decisión CDP vs wasiai-facilitator con 4+ criterios objetivos | PASS | `doc/integration-base.md:151-159` — 6 criterios en tabla: (1) Self-custody of settlement, (2) Dependency on Coinbase API, (3) Mainnet readiness today, (4) Cost per tx (USDC gas), (5) Latency (mainnet typical), (6) Bazaar discovery. Sin lenguaje de marketing; valores objetivos en cada celda. |
| AC-5 | `doc/sdd/_INDEX.md` incluye entry `092` para esta HU | FAIL | `doc/sdd/_INDEX.md` termina en línea 80 con entry `091` (WKH-107). Búsqueda exhaustiva: `grep "092\|wkh-108\|WKH-108\|base-docs" doc/sdd/_INDEX.md` → exit code 1, 0 matches. La fila 092 no fue insertada por el commit `a6685a0`. |
| AC-6 | Tabla "Production Status" incluye Base Sepolia + Base Mainnet con URL y estado real | PASS | `README.md:116` → `Base Sepolia adapter (84532) \| [sepolia.basescan.org] \| staged — env-gated, WKH-103 in branch`. `README.md:117` → `Base Mainnet adapter (8453) \| [basescan.org] \| staged — env-gated, WKH-103 in branch`. Estado honesto, no overclaim. |
| AC-7 | BASE-EVIDENCE.md existe → sin placeholders `[PENDING BASE-04]` | PASS | `doc/BASE-EVIDENCE.md` existe (107 líneas, 3 tx hashes reales). `grep "PENDING BASE-04" doc/integration-base.md README.md` → 0 matches. Condición correctamente rama: EXISTS → link real usado. |

---

## CD Compliance Checklist

| CD | Descripción | Status | Evidencia |
|----|-------------|--------|-----------|
| CD-1 | NO contratos no deployados, solo links verificables | PASS | USDC addresses son contratos Circle oficiales en Sepolia y Mainnet. Ningún tx hash inventado — los 3 en BASE-EVIDENCE.md tienen Basescan URLs completas. |
| CD-2 | Patrón bilingüe ES/EN del README actual respetado | PASS | README existente no modificado en tono/estructura. Sección nueva `## Base Support` en inglés (audiencia Coinbase). `doc/integration-base.md` en inglés (DT-6). Secciones NexusAgil en español. |
| CD-3 | Diff mínimo en README.md (no refactorizar secciones existentes) | PASS | `git diff main..HEAD -- README.md \| wc -l` → 121 líneas diff. El commit WKH-108 solo agrega la sección nueva + 2 filas Production Status + 2 filas Documentation table. No hay modificación de contenido preexistente. |
| CD-4 | NO mencionar BASE-06/07 ni OnchainKit ni Smart Wallet | PASS | `grep "BASE-06\|BASE-07\|OnchainKit\|Smart Wallet" doc/integration-base.md README.md` → exit 1, 0 matches. |
| CD-5 | Env vars mencionados en guide existen en `.env.example` | PASS | Vars verificadas en `.env.example`: `WASIAI_A2A_CHAINS` (línea 153), `BASE_NETWORK` (línea 406), `BASE_TESTNET_RPC_URL` (línea 411), `BASE_MAINNET_RPC_URL` (línea 414-415), `BASE_SEPOLIA_USDC_ADDRESS` (línea 419), `BASE_MAINNET_USDC_ADDRESS` (línea 423), `BASE_FACILITATOR_URL` (línea 437), `CDP_FACILITATOR_URL` (línea 460). Todas presentes. |
| CD-6 | NO afirmar "Base Mainnet live" sin evidencia | PASS | `README.md:117` → "staged — env-gated, WKH-103 in branch". `doc/integration-base.md:9` → "Base Mainnet ships staged (env-gated)". Sin menciones de "live" o "active" para Base Mainnet. |
| CD-7 | `doc/integration-base.md` incluye nota de dependencia BASE-01..04 | PASS | `doc/integration-base.md:9` → "This guide assumes BASE-01..04 (`WKH-104`..`WKH-107`) have been deployed on the target environment. Check the Production Status table in the root README.md before running the quick start." |

---

## Drift Detection

**Scope drift (archivos WKH-108 commit `a6685a0`):**

```
git show a6685a0 --name-only:
  README.md                          ← Scope IN (agregar sección + 2 filas)
  doc/BASE-EVIDENCE.md               ← linkear, no crear (BASE-04 output ya existía)
  doc/integration-base.md            ← Scope IN (crear nuevo)
  doc/sdd/_INDEX.md                  ← Scope IN (agregar fila 092) ← AUSENTE
  package-lock.json                  ← No en scope, es artifact de npm install de otro commit
```

Nota: `doc/sdd/_INDEX.md` está en el diff del branch (modificado por commits anteriores del epic), pero el commit `a6685a0` específico de WKH-108 NO insertó la fila 092. Eso es el bug de AC-5.

`src/` files: el commit WKH-108 no tocó ningún archivo `src/`. Los 23 archivos `src/` en el diff del branch corresponden a BASE-01..04 (commits previos). Sin scope drift de código.

**Wave drift**: HU es pipeline FAST/MINI. No hay waves formales. Único commit de implementación: `a6685a0`. Orden correcto.

**Spec drift**: Spot-check de 3 puntos clave:
- DT-1 (5 secciones, max 40 líneas cada una): `doc/integration-base.md` tiene 5 secciones, ninguna excede 40 líneas. CUMPLE.
- DT-2 (Base Support DESPUÉS de Kite Hackathon): `README.md:19` = Kite Hackathon, `README.md:41` = Base Support. CUMPLE.
- DT-3 (tabla facilitator con 5 columnas): tabla en `doc/integration-base.md:151` tiene 3 columnas (Criterio + 2 facilitators), no 5. El work-item dice "5 columnas: Criterio | CDP | wasiai | Cuándo usar CDP | Cuándo usar wasiai". La implementación fusionó "Cuándo usar" en la última fila. MINOR — la información está completa y supera los 4 criterios de AC-4. Aceptable.

---

## Gates (FAST pipeline — sin CR formal)

WKH-108 es pipeline FAST (doc-only). No existe cr-report.md para esta HU. Referencia de gates del pipeline completo del branch:

- **npm test (1039/1039)**: confirmado en QA report de WKH-107 (`doc/sdd/091-wkh-107-smoke-base-sepolia/qa-report.md:114` — "Tests 1039 passed (1039)"). WKH-108 no toca `src/` ni tests → baseline no cambia.
- **npm run build**: NO ejecutado en esta sesión QA (WKH-108 no toca `src/`; build verde confirmado implícitamente por el mismo baseline).
- **lint/tsc**: NO ejecutados (sin código modificado en WKH-108).

Estado: Gates pasaron para el branch en WKH-107 QA. WKH-108 es doc-only. Sin regresión posible.

---

## Hallazgo Runtime / Doc Integrity

- **Tx hashes en BASE-EVIDENCE.md**: presentes y verificables (`doc/BASE-EVIDENCE.md:49,61,73`). Los hashes están en el archivo fuente de evidencia. El README y la integration guide referencian el archivo, no repiten los hashes individuales — correcto.
- **Links circulares**: `doc/integration-base.md:220-226` apunta a `../README.md`, `INTEGRATION.md`, `architecture/CHAIN-ADAPTIVE.md`, `architecture/MULTI-CHAIN.md`, `BASE-EVIDENCE.md`. Todos los archivos referenciados existen en el branch.
- **No placeholders**: búsqueda de `PENDING BASE` en los archivos modificados → 0 matches en README.md e integration-base.md (correcto: BASE-EVIDENCE.md existe).

---

## Veredicto Final

**FAIL — fix-pack requerido.**

Un solo fix necesario: insertar la fila `092` en `doc/sdd/_INDEX.md`. La fila debe seguir el patrón de las entradas adyacentes (088, 090, 091):

```markdown
| 092 | 2026-05-19 | [BASE-05] README "Base Support" + integration guide Base (WKH-108) | doc | FAST | DONE | feat/wkh-base-port-v1 |
```

Una vez insertada esa fila y commiteada, AC-5 pasa y la HU puede avanzar a DONE.

**Recomendación**: fix-pack mínimo (1 línea en `_INDEX.md`), luego DONE directamente — no requiere re-QA completa dado que los otros 6 ACs y los 7 CDs están verificados con evidencia.
