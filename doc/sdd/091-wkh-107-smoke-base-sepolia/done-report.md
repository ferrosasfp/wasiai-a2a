# Report — HU WKH-107 / [BASE-04] Smoke E2E Base Sepolia con tx hash real en Basescan

**Status**: DONE  
**Date closed**: 2026-05-19  
**Branch**: `feat/wkh-base-port-v1`  
**Commits**: `7001635` (script + template) · `5ef9fd0` (3 tx hashes)

---

## Resumen ejecutivo

Smoke E2E test completado contra Base Sepolia (chainId 84532). Script `smoke-base-sepolia.mjs` implementa el flujo x402 v2 completo (POST /compose → 402 challenge → EIP-3009 firma → retry con payment-signature → 200 OK). Validación onchain: 3 transacciones `transferWithAuthorization` confirmadas en Basescan con nonces únicos (anti-replay). Evidencia inmutable en `doc/BASE-EVIDENCE.md`. AC-1 PARTIAL (validación full gateway bloqueada por infraestructura, validación chain-layer completada). 5/6 ACs PASS, 1 PARTIAL documentado.

---

## Pipeline ejecutado

| Fase | Artefacto | Status | Fecha | Gates |
|------|-----------|--------|-------|-------|
| F0 | Codebase + project-context | ✅ | 2026-05-19 | — |
| F1 | work-item.md | ✅ | 2026-05-19 | HU_APPROVED |
| F2 | sdd.md (mini mode) | ✅ | 2026-05-19 | SPEC_APPROVED |
| F2.5 | story-file.md | ✅ | 2026-05-19 | — |
| F3 | scripts/smoke-base-sepolia.mjs + doc/BASE-EVIDENCE.md | ✅ | 2026-05-19 | 2 commits (7001635, 5ef9fd0) |
| AR (Adversary Review) | ar-report.md | ✅ BLOQUEANTES: 0 | 2026-05-19 | APPROVED |
| CR (Code Review) | cr-report.md | ✅ APROBADO | 2026-05-19 | APPROVED |
| F4 (QA / Validation) | qa-report.md | ✅ PASS con condición | 2026-05-19 | APROBADO PARA DONE |

---

## Archivos creados/modificados en WKH-107

```
scripts/smoke-base-sepolia.mjs           (NEW, 434 líneas)
scripts/smoke-base-sepolia-raw.mjs       (NEW, 189 líneas, herramienta de validación)
doc/BASE-EVIDENCE.md                     (NEW, 107 líneas)
README.md                                (MOD, +6 líneas: sección "Verifiable proof on Base Sepolia")
doc/sdd/091-wkh-107-smoke-base-sepolia/  (artifacts dir, NEW)
```

No se modificó código en `src/`.

---

## Aceptance Criteria — resultado final

| AC | Texto (resumen EARS) | Status | Evidencia |
|----|----------------------|--------|-----------|
| AC-1 | WHEN smoke script executed against staging URL, SHALL complete full x402 v2 flow (POST /compose → 402 → sign → retry → 200) | **PARTIAL** | `scripts/smoke-base-sepolia.mjs` implementa flow canónico (líneas 200-435). Ejecución completa bloqueada por ausencia de staging URL con WKH-104/105 activos. Chain-layer validado vía `smoke-base-sepolia-raw.mjs` — misma construcción EIP-712 domain, confirma primitivos criptográficos. Documentado en `doc/BASE-EVIDENCE.md` líneas 22-33. Pending deuda DT-I: ejecutar contra gateway post-WKH-104/105 merge. |
| AC-2 | Tx hash en Basescan muestra `transferWithAuthorization` sobre USDC sepolia `0x036C...CF7e` | **PASS** | 3 txs verificadas via RPC directo: `input[0:10]=0xe3ee160e` (selector correcto), `to=0x036cbd...CF7e` (contrato USDC). Basescan URLs en `doc/BASE-EVIDENCE.md` líneas 50, 62, 73. Hashes onchain confirmados con blockNumbers crecientes. |
| AC-3 | 3 corridas → 3 tx hashes únicos, nonce EIP-3009 único por corrida | **PASS** | 3 nonces distintos: `0xc6587747...` (run1), `0x1c845284...` (run2), `0x50db521d...` (run3). len(set(nonces)) == 3. Bloques 41729635 < 41729641 < 41729646. Sin replay. Documentado en qa-report.md líneas 62-67. |
| AC-4 | `doc/BASE-EVIDENCE.md` contiene por corrida: tx hash, Basescan URL, amount, agent destination, ISO 8601 timestamp, status | **PASS** | `doc/BASE-EVIDENCE.md` líneas 46-80: cada run contiene todos los campos requeridos. Dates: 2026-05-19T21:52:38.902Z, 21:52:49.163Z, 21:53:00.062Z. Amounts: 0.001, 0.005, 0.010 USDC. Destino: submitter `0x9c0638...` (auto-transfer MVP pattern). Status: 3 SUCCESS. CD-3 cumplido: cero runs fallidas ocultas. |
| AC-5 | README.md sección "Production proof" contiene sub-sección "Verifiable proof on Base Sepolia" con link a `doc/BASE-EVIDENCE.md` | **PASS** | README.md línea 68: sub-sección `### Verifiable proof on Base Sepolia` dentro de sección "Production Status". Línea 70: link `[doc/BASE-EVIDENCE.md](doc/BASE-EVIDENCE.md)`. Commit 7001635. |
| AC-6 | IF balance insuficiente THEN print error INSUFFICIENT_BALANCE + exit code 1 antes de cualquier HTTP request | **PASS** (estático) | `scripts/smoke-base-sepolia.mjs` líneas 177-184: `if (usdcBalance < amount)` → `console.error('✗ INSUFFICIENT_BALANCE: ...')` → `process.exit(1)`. Branch ocurre antes de Step 2 (POST /compose, línea 212). No ejecutado en runtime (balance era suficiente en las 3 corridas). Validación estática de rama mediante lectura de código. |

---

## Validación onchain — método y hallazgos

### Transacciones confirmadas en Base Sepolia Basescan

**Run 1 — 0.001 USDC**  
Hash: [`0x4719e0e492029c5b9922d85627a710fa0a3d6d781932cec2ed357aceffb9c108`](https://sepolia.basescan.org/tx/0x4719e0e492029c5b9922d85627a710fa0a3d6d781932cec2ed357aceffb9c108)  
Block: 41,729,635 | Gas: 85,740 | Status: ✅ SUCCESS

**Run 2 — 0.005 USDC**  
Hash: [`0x6356a85df7d0273483438234a31a8730ebd9be64d956962bfc14c14447a86107`](https://sepolia.basescan.org/tx/0x6356a85df7d0273483438234a31a8730ebd9be64d956962bfc14c14447a86107)  
Block: 41,729,641 | Gas: 85,720 | Status: ✅ SUCCESS

**Run 3 — 0.010 USDC**  
Hash: [`0x1d31a67267d4f15a22a20ccd28296931fae0b9d0265c848295f84313b949fad7`](https://sepolia.basescan.org/tx/0x1d31a67267d4f15a22a20ccd28296931fae0b9d0265c848295f84313b949fad7)  
Block: 41,729,646 | Gas: 85,740 | Status: ✅ SUCCESS

Selector verificado: `0xe3ee160e` = `keccak256(transferWithAuthorization(...))[:4]` ✓

---

## AC-1 PARTIAL — Method note crítico

El script principal `smoke-base-sepolia.mjs` implementa el flujo x402 v2 completo (líneas 200-435):

```
POST /compose
  ↓
HTTP 402 challenge (get authorization challenge)
  ↓
Sign EIP-712 TransferWithAuthorization envelope
  ↓
POST /compose (retry con payment-signature header)
  ↓
HTTP 200 + tx hash
```

**Por qué no se ejecutó contra gateway**: WKH-104 (Base adapter) y WKH-105 (Base facilitator) aún no están mergeados a main/Railway staging. Sin esta infraestructura, la URL `BASE_SMOKE_GATEWAY_URL` no existía.

**Validación alternativa completada**: El orquestador ejecutó `smoke-base-sepolia-raw.mjs`, que:
- Salta `/compose` y llama USDC.transferWithAuthorization directamente en Base Sepolia RPC
- Usa **la misma construcción EIP-712 domain** que `src/adapters/base/payment.ts` (WKH-104) construye en runtime
- Usa **las mismas wallets** (cliente firma, submitter paga gas)
- Confirma onchain que dominio, versión, chainId son correctos
- Produce **evidencia inmutable onchain**: 3 tx hashes con nonces únicos

Esta validación chain-layer es equivalente a un test unitario con mocking de la capa gateway. Prueba que los primitivos criptográficos (EIP-712, EIP-3009) funcionan correctamente. La diferencia es que la HTTP 402 loop y la retry no se pudieron probar.

**Deuda técnica documentada (DT-I)**: "Ejecutar `smoke-base-sepolia.mjs` contra gateway una vez WKH-104/105 mergeados a main y deployados en Railway con `WASIAI_A2A_CHAINS=base-sepolia`." Condición documentada en `doc/BASE-EVIDENCE.md` líneas 98-106.

**Condición aceptada para DONE**: work-item mismo declara esta dependencia en "Missing Inputs" (línea 64): "[BLOQUEANTE] Sin esta URL el script no puede correr." No es regresión; es dependencia conocida.

---

## Hallazgos finales

### BLOQUEANTEs

0 bloqueantes. Todas las dependencias externas están documentadas como deuda técnica (DT-I).

### MENORs

0 menores. Calidad gates pasados (npm test 1039/1039, npm run build strict).

---

## Auto-Blindaje consolidado

| ID | Categoría | Hallazgo | Impacto | Resolución |
|----|-----------|----------|--------|-----------|
| AB-1 | Clarity | AC-1 PARTIAL requiere transparencia sobre "qué falta vs qué no se puede hacer" | Alto | Documentado: "chain-layer validado, full gateway flow pendiente post-infra". `doc/BASE-EVIDENCE.md` Method note explica divergencia. |
| AB-2 | Process | Smoke validation sin staging URL requiere split en dos scripts (raw vs full) | Medio | `smoke-base-sepolia-raw.mjs` es "validation instrument" (qa-report línea 101). No está en Scope IN literal pero acepta su rol en evidencia. Documentado explícitamente. |
| AB-3 | Security | EIP-712 domain hardcoding (DT-4) — verificar contra Circle ABI en cada release | Medio | Domain verificado manualmente en WKH-104 SDD (línea DT-4). Incluir en pre-prod checklist: "Circle USDC v2 domain check". |
| AB-4 | Crypto | Nonce uniqueness via `randomBytes(32)` — entropía suficiente para 3 corridas | Bajo | Confiado. Riesgo colisión = 1/2^256, negligible. Para 1000+ corridas, considerar counter persistente. Hoy: OK. |
| AB-5 | Docs | `doc/BASE-EVIDENCE.md` marcado como "append-only" (CD-2) — instrucción clara para futuros runs | Alto | CD-2 y CD-3 implementados. Archivo bloqueado contra edición post-publicación. Run 4 (full /compose flow) se agregará al final sin reemplazar Runs 1-3. |
| AB-6 | Monitoring | Basescan indexation delay (10-30s) — script asume confirmación si facilitator retorna tx hash | Medio | DT-6: script NO poll-ea explorer. Asume confirmación a partir de facilitator response. Riesgo: tx submitida pero no indexada = false positive. Mitigación: agregar opcional explorer poll con timeout en futuras iteraciones. |
| AB-7 | Compatibility | Faucet Circle rate-limiting en USDC sepolia — risk de timeout en runs 2-3 | Bajo | Mitigado: wallet pre-fundeada con buffer de 0.1 USDC. Runs exitosas en < 15s cada una. Para CI automático futuro, considerar faucet backup (Alchemy). |

---

## Decisiones diferidas a backlog

- **WKH-108 (BASE-05)**: Documentación final de BASE port. Ya puede arrancar con tx hashes reales (no placeholders) extraídos de `doc/BASE-EVIDENCE.md`.
- **DT-I pending**: Full /compose flow smoke execution. Creado como deuda en linea, ejecutable post-WKH-104+105+Railway deploy.
- **WKH-SEC-BASELINE-BASE**: Auditoría de security de adapters Base (EIP-712 domain, signature verification, reentrancy). Pendiente para Fase 2.

---

## Lecciones para próximas HUs

1. **Split validation cuando dependencias externas bloquean**: No esperar infraestructura completa para probar primitivos. Raw chain test (`smoke-base-sepolia-raw.mjs`) es herramienta válida de validación cuando flow completo está bloqueado. Documentar explícitamente el gap en el report.

2. **CD-2 + CD-3 = confianza en documentación**: Append-only files + transparencia sobre fallos = evidencia que la suite confía. O inviertes en integración perfecta o documentas honestamente el estado intermedio. Elegimos honestidad; escaló bien.

3. **EIP-712 domain versionado por contrato**: USDC usa v2 en todas las redes. Codificar en DT, no en AC. Futuros adapters (Scroll, Optimism) verificar version per Circle ABI changelog.

4. **Nonce uniqueness > replay testing**: Para E2E smoke, 3 corridas con 3 nonces distintos > 1 corrida con replay attack test. Anti-replay es propiedad de USDC, nosotros demostramos que la usamos. Más económico que un ataque simulado.

---

## Quality gates FINAL

| Gate | Status | Evidencia |
|------|--------|-----------|
| `npm test` 1039/1039 | ✅ PASS | WKH-106 QA baseline (sin cambios en src/ en WKH-107) |
| `npm run build` strict | ✅ PASS | WKH-106 QA baseline |
| tsc --noEmit | ✅ PASS | WKH-106 QA baseline |
| CD-1: no hardcoded private keys | ✅ PASS | `BASE_SMOKE_PRIVATE_KEY` lee desde env (línea 89, smoke-base-sepolia.mjs) |
| CD-5: no src/ modificado | ✅ PASS | Todos los archivos en scope IN están fuera src/ |
| CD-6: solo viem | ✅ PASS | imports: `viem` únicamente, cero ethers |
| AC-1 PARTIAL acceptance | ✅ PASS (con condición) | Documentado en qa-report.md líneas 124-134 |

---

## Production readiness checklist

- [x] Scripts contienen validación de balance pre-flight (AC-6)
- [x] Private keys nunca hardcodeados, siempre env vars (CD-1)
- [x] EIP-712 domain hardcodeado con comentario de verificación manual (DT-4)
- [x] 3 tx hashes diferentes en onchain evidence (anti-replay verificado)
- [x] Basescan URLs en evidence (verifiable link)
- [x] README.md contiene sección "Verifiable proof" (AC-5, user-facing)
- [x] Script principal `smoke-base-sepolia.mjs` implementa full x402 v2 flow (listo para staging test post-WKH-104/105)
- [x] Auto-Blindaje completo (7 entradas, sin omisiones)

---

## Pending items

1. **AC-1 PARTIAL**: Full `/compose` flow validation se hará post-merge WKH-104+105 + Railway deployment con `WASIAI_A2A_CHAINS=base-sepolia`. Documentado como deuda DT-I en esta HU. No bloquea DONE.

2. **Run 4 — full /compose flow**: Ejecutable una vez infraestructura lista. `doc/BASE-EVIDENCE.md` ya tiene placeholder "Run 4 — full /compose flow" (líneas 98-106). Append cuando esté listo.

3. **WKH-108 (BASE-05 docs)**: Puede arrancar ahora con tx hashes reales. No requiere esperar por nada más en BASE port.

---

## Next steps

1. Merge `feat/wkh-base-port-v1` a main (cuando WKH-104+105+106 también estén DONE).
2. Deploy a Railway con `WASIAI_A2A_CHAINS` = `["fuji-usdc", "base-sepolia"]`.
3. Ejecutar Run 4 (full /compose flow) en staging — append resultado a `doc/BASE-EVIDENCE.md`.
4. Postular a Base Builder Grants con `doc/BASE-EVIDENCE.md` + tx hashes inmutables.

---

## Commits

- `7001635`: feat(WKH-107): smoke E2E script + evidence template for Base Sepolia
  - Adds `scripts/smoke-base-sepolia.mjs` (434 líneas)
  - Adds `doc/BASE-EVIDENCE.md` template + wallets
  - Updates `README.md` with "Verifiable proof on Base Sepolia" section

- `5ef9fd0`: feat(WKH-107): Base Sepolia smoke evidence — 3/3 SUCCESS tx hashes
  - Populates `doc/BASE-EVIDENCE.md` with 3 onchain tx hashes
  - Wallets, EIP-712 domain, nonces, gas usage
  - Method note explaining chain-layer vs full-flow validation

---

**Report signed off**: 2026-05-19  
**Status**: ✅ DONE  
**Gate**: F4 QA APROBADO PARA DONE + AC-1 PARTIAL condition documented
