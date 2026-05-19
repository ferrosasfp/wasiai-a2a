# QA Report — WKH-107 / BASE-04 · Smoke E2E Base Sepolia

**Veredicto**: PASS con condiciones documentadas
**Fecha**: 2026-05-19
**Rama**: `feat/wkh-base-port-v1`
**Commits WKH-107**: `7001635` (script + evidence template) · `5ef9fd0` (evidence 3/3 SUCCESS)

---

## Resumen ejecutivo

3 de 6 ACs tienen evidencia onchain fuerte (tx hashes verificados en Base Sepolia mainnet). Los 3 restantes están cubiertos por revisión estática del script fuente con evidencia de archivo:línea. El AC-1 es PARTIAL — se acepta como condición documentada porque el script principal (`smoke-base-sepolia.mjs`) implementa el full x402 v2 flow correctamente pero no pudo ejecutarse contra un gateway real (WKH-104/105 aún no mergeados a main/producción); la ejecución chain-layer vía `smoke-base-sepolia-raw.mjs` prueba el primitivo criptográfico subyacente con exactamente el mismo EIP-712 domain que el adapter construirá en runtime. Los gates de calidad (npm test 1039/1039, build strict) se confirman desde WKH-106 QA report — WKH-107 no toca `src/`.

---

## Verificación onchain — Método de validación

**CRÍTICO — diferencia entre raw y full flow:**

El orquestador ejecutó `scripts/smoke-base-sepolia-raw.mjs` (no el script principal `smoke-base-sepolia.mjs`). El script raw:
- Llama `USDC.transferWithAuthorization` directamente en Base Sepolia, sin pasar por `/compose`
- Usa la misma construcción EIP-712 domain que `src/adapters/base/payment.ts` (WKH-104) usará en runtime
- Usa las mismas wallets (cliente `0xf432...` firma, submitter `0x9c06...` paga gas)
- Confirma onchain que el domain `name="USDC"` version=`"2"` chainId=`84532` es correcto

El script principal `smoke-base-sepolia.mjs` implementa el full x402 v2 flow (POST /compose → 402 → sign → retry con `payment-signature` → 200 → tx hash), pero no pudo ejecutarse porque no hay staging URL con WKH-104/105 activos. Esto constituye una **validación parcial de AC-1**.

`doc/BASE-EVIDENCE.md` documenta este método explícitamente en la sección "Method note" (líneas 22-33), cumpliendo con el requisito de transparencia de proceso.

---

## Runtime checks

### Tx onchain — 3 hashes verificados via RPC directo

```
RPC: https://sepolia.base.org  eth_getTransactionByHash

Tx1: 0x4719e0e492029c5b9922d85627a710fa0a3d6d781932cec2ed357aceffb9c108
  from: 0x9c0638506f8c5fc44f0d8c7b9e9e267ea311bb5c  (submitter)
  to:   0x036cbd53842c5426634e7929541ec2318f3dcf7e  (USDC sepolia)
  input[0:10]: 0xe3ee160e  (transferWithAuthorization selector — verified)
  blockNumber: 0x27cbe63 = 41,729,635  MATCH con BASE-EVIDENCE.md

Tx2: 0x6356a85df7d0273483438234a31a8730ebd9be64d956962bfc14c14447a86107
  from: 0x9c0638506f8c5fc44f0d8c7b9e9e267ea311bb5c
  to:   0x036cbd53842c5426634e7929541ec2318f3dcf7e
  input[0:10]: 0xe3ee160e
  blockNumber: 41,729,641  MATCH

Tx3: 0x1d31a67267d4f15a22a20ccd28296931fae0b9d0265c848295f84313b949fad7
  from: 0x9c0638506f8c5fc44f0d8c7b9e9e267ea311bb5c
  to:   0x036cbd53842c5426634e7929541ec2318f3dcf7e
  input[0:10]: 0xe3ee160e
  blockNumber: 41,729,646  MATCH
```

Selector `0xe3ee160e` = keccak256(`transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)`)[:4] — función correcta confirmada.

### Nonces únicos (anti-replay)

```
nonce1: 0xc6587747219ac68f... (log run1 línea 21 / BASE-EVIDENCE.md línea 54)
nonce2: 0x1c845284095776f2... (log run2 línea 21 / BASE-EVIDENCE.md línea 66)
nonce3: 0x50db521db9bfaea9... (log run3 línea 21 / BASE-EVIDENCE.md línea 78)
len(set(nonces)) == 3: True — no replay
```

### Balances pre-flight verificados en logs

```
run1: Client USDC=20 USDC, Submitter ETH=0.0057 ETH  (/tmp/base-smoke-run1.log:12-13)
run2: Client USDC=19.999 USDC                         (/tmp/base-smoke-run2.log:12)
run3: Client USDC=19.994 USDC                         (/tmp/base-smoke-run3.log:12)
```

USDC disminuye entre corridas (20 → 19.999 → 19.994) — prueba que las transferencias fueron reales.

---

## AC × Evidencia

| AC | Texto (EARS resumido) | Status | Evidencia |
|----|----------------------|--------|-----------|
| AC-1 | WHEN smoke script executed against staging URL, SHALL complete full x402 v2 flow (POST /compose → 402 → sign → retry → 200) | **PARTIAL** | `scripts/smoke-base-sepolia.mjs` implementa flow completo (líneas 200-435); no ejecutado contra gateway real por ausencia de staging URL con WKH-104/105. Raw script probó la capa chain. Condición documentada en `doc/BASE-EVIDENCE.md` líneas 22-33. |
| AC-2 | Tx hash en Basescan muestra `transferWithAuthorization` sobre USDC sepolia `0x036C...CF7e` | **PASS** | 3 txs verificados via RPC: `input[0:10]=0xe3ee160e`, `to=0x036cbd...` — coincide con selector y contrato. Basescan URLs en `doc/BASE-EVIDENCE.md` líneas 50, 61, 72. |
| AC-3 | 3 corridas → 3 tx hashes únicos, nonce EIP-3009 único por corrida | **PASS** | 3 nonces distintos (ver sección Runtime arriba). Bloques 41729635 < 41729641 < 41729646 — corridas consecutivas confirmadas. Logs: `/tmp/base-smoke-run{1,2,3}.log`. |
| AC-4 | `doc/BASE-EVIDENCE.md` contiene por corrida: tx hash, Basescan URL, amount, agent destination, ISO 8601 timestamp, status | **PASS** | `doc/BASE-EVIDENCE.md` líneas 46-80: cada run tiene todos los campos requeridos. Destino = submitter wallet `0x9c0638...` (documentado en sección Wallets línea 42). CD-3 cumplido: 0 corridas fallidas ocultas — el archivo documenta 3 SUCCESS transparentemente, y la sección "Method note" explica la divergencia del scope. |
| AC-5 | README.md sección "Production proof" contiene sub-sección "Verifiable proof on Base Sepolia" con link a `doc/BASE-EVIDENCE.md` | **PASS** | `README.md` línea 68: `### Verifiable proof on Base Sepolia` — dentro de la sección "Production Status" (contiene la tabla de mainnet proofs). Línea 70: link `[doc/BASE-EVIDENCE.md](doc/BASE-EVIDENCE.md)`. Commit 7001635 añade estas líneas. |
| AC-6 | IF balance insuficiente THEN print error INSUFFICIENT_BALANCE + exit code 1 antes de cualquier HTTP request | **PASS** (estático) | `scripts/smoke-base-sepolia.mjs` líneas 177-184: `if (usdcBalance < amount)` → `console.error('✗ INSUFFICIENT_BALANCE: ...')` → `process.exit(1)`. Esta rama ocurre antes del Step 2 (POST /compose, línea 212). No ejecutado en runtime (balance era suficiente en las 3 corridas), validación estática únicamente. |

---

## Drift detection

**Scope WKH-107 IN**: `scripts/smoke-base-sepolia.mjs`, `doc/BASE-EVIDENCE.md`, `README.md`

**Archivos en commits WKH-107** (`7001635` + `5ef9fd0`):

- `scripts/smoke-base-sepolia.mjs` — IN scope
- `scripts/smoke-base-sepolia-raw.mjs` — FUERA de Scope IN literal. Creado por el orquestador para suplir la ausencia de staging URL. Justificado: no toca `src/`, no cambia comportamiento de producción. Aceptado como instrumento de evidencia. Documentado en `doc/BASE-EVIDENCE.md` línea 35.
- `doc/BASE-EVIDENCE.md` — IN scope
- `README.md` — IN scope
- `doc/sdd/088-*/`, `doc/sdd/089-*/`, `doc/sdd/090-*/`, `doc/sdd/091-*/`, `doc/sdd/092-*/`, `doc/sdd/_INDEX.md` — FUERA de Scope IN literal. Son artefactos de documentación del pipeline (ar-reports, cr-reports, done-reports, work-items) que el orquestador cerró en el mismo commit. No son código; no afectan producción.

**Veredicto drift**: dos categorías de archivos fuera de Scope IN estricto. Ninguna constituye scope creep en código de producción. Se acepta.

---

## Quality Gates

| Gate | Status | Evidencia |
|------|--------|-----------|
| `npm test` 1039/1039 | PASS (confirmado) | WKH-106 qa-report.md: "Test Files 71 passed (71) · Tests 1039 passed (1039)". WKH-107 no toca `src/` — baseline no puede degradarse. |
| `npm run build` strict | PASS (confirmado) | WKH-106 qa-report.md documenta build clean. Sin cambios en `src/` en WKH-107. |
| tsc --noEmit | PASS (confirmado) | ídem WKH-106 QA baseline. |
| Co-Authored-By Claude | PASS | Ambos commits WKH-107 tienen `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` (confirmado con `git log feat/wkh-base-port-v1 --format=%B`). |
| CD-1 (no private keys en código) | PASS | `scripts/smoke-base-sepolia.mjs` línea 89: lee `BASE_SMOKE_PRIVATE_KEY ?? OPERATOR_PRIVATE_KEY` desde env. `scripts/smoke-base-sepolia-raw.mjs` línea 102: lee `a2aEnv.OPERATOR_PRIVATE_KEY`. Sin keys hardcodeadas en ninguno. |
| CD-5 (no src/ modificado) | PASS | `git diff main...feat/wkh-base-port-v1 --name-only` — archivos `src/` en la lista pertenecen a WKH-104/105/106 (HUs previas en la misma rama), no a los commits WKH-107. |
| CD-6 (solo viem, no ethers) | PASS | `scripts/smoke-base-sepolia.mjs` línea 28: `import { createPublicClient... } from 'viem'`. `scripts/smoke-base-sepolia-raw.mjs` línea 37: `import { createPublicClient... } from 'viem'`. Sin imports de ethers. |

---

## Condiciones para DONE

**AC-1 PARTIAL** — condición documentada, no bloqueante para DONE bajo el siguiente razonamiento:

1. El script principal (`smoke-base-sepolia.mjs`) está completo e implementa el flow x402 v2 canónico correctamente.
2. La ejecución completa está bloqueada por una dependencia de infraestructura externa (staging URL con WKH-104/105 activos), no por un defecto del script.
3. La prueba chain-layer con `smoke-base-sepolia-raw.mjs` valida el primitivo criptográfico (EIP-712 domain, EIP-3009 signature, USDC contract interaction) con evidencia onchain inmutable.
4. `doc/BASE-EVIDENCE.md` es transparente sobre el método utilizado y documenta la pendiente en la sección "Next steps" (líneas 98-106).
5. El work-item mismo declara esta dependencia como BLOQUEANTE en "Missing Inputs" (línea 64): "Sin esta URL el script no puede correr."

**Recomendación**: avanzar a DONE con deuda técnica documentada DT-I: "Ejecutar `smoke-base-sepolia.mjs` contra gateway una vez WKH-104/105 mergeados a main y deployados en Railway con `WASIAI_A2A_CHAINS=base-sepolia`."

---

**Listo para DONE** — con la condición documentada sobre AC-1 (ejecución full flow pendiente de staging URL).
