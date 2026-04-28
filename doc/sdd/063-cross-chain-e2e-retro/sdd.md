# SDD — 063 Cross-Chain E2E Retro

**HU virtual**: TRUE cross-chain Kite PYUSD inbound + Fuji USDC outbound funcional E2E
**Fecha**: 2026-04-28
**Mode**: QUALITY (retrospectivo)
**Status**: SPEC_APPROVED retroactivo (post-merge documentación)
**Architect**: nexus-architect

---

## 1. Context Map

Archivos leídos para reconstruir la cascada (orden cronológico de descubrimiento):

| Archivo | Por qué se leyó | Patrón extraído |
|---------|-----------------|-----------------|
| `git log --oneline -20` | Identificar los 5 commits del 2026-04-28 | PRs #48–#52 mergeadas en ~36 min: 07:38 → 08:14 UTC |
| `git show edde596` (PR #48) | Diff exacto del cambio de paths | 2 fetch endpoints renombrados: `/v2/verify` → `/verify`, `/v2/settle` → `/settle` |
| `git show 7c3419f` (PR #49) | Diff exacto schema fallbacks | Refactor `readPayment` con 3 fallbacks defensivos |
| `git show 7187ccb` (PR #50) | Diff exacto debug logs added | 8 líneas de logs temporales (FLAG_OFF/FLAG_ON) en `downstream-payment.ts` |
| `git show a552508` (PR #51) | Diff cleanup + smoke script | Logs removidos + `scripts/smoke-e2e-cross-chain.mjs` (238 lines) creado |
| `git show e4d217d` (PR #52) | Diff guards + timeout | 4 guards `if (reply.sent) return;` + `60000` → `120000` |
| `src/adapters/kite-ozone/payment.ts` (verificado con Glob) | Confirmar paths actuales | mode `'pieverse'` y `'x402'` co-existen, switch via `KITE_FACILITATOR_MODE` |
| `src/services/discovery.ts` (verificado con Glob) | Confirmar `readPayment` actual | Fallbacks ya en HEAD (post-PR #49) |
| `src/middleware/x402.ts` (verificado con Glob) | Confirmar guards en HEAD | 5 guards `reply.sent` activos |
| `src/routes/compose.ts` (verificado con Glob) | Confirmar timeout default | Default `'120000'` confirmado |
| `scripts/smoke-e2e-cross-chain.mjs` (Read parcial) | Confirmar pipeline 3 agentes | Pipeline `wasi-chainlink-price` → `wasi-defi-sentiment` → `wasi-wallet-profiler`, todos del registry `wasiai` |
| `doc/sdd/058-062 auto-blindajes` (Read selectivo) | Evitar duplicación de findings | SSRF, scope check, sentinels, RCE — todos ya documentados |
| `doc/sdd/_INDEX.md` | Posicionar entry 063 | Última entry: 062, fechas crecientes, status DONE |

---

## 2. Decisiones técnicas (DT)

### DT-1 — Documentar la cascada como UNA HU virtual, no 5

**Opción A**: Crear 5 SDDs retroactivos (uno por PR). **Rechazada**: explosion combinatoria de artefactos para fixes individuales. Los PRs son atomic en código pero forman UNA falla sistémica (la pipeline cross-chain no funcionaba) — agruparlos refleja la verdad operacional.

**Opción B**: Un SDD consolidado con 5 ACs. **Elegida**. Permite contar la historia de la cascada y evita duplicar contexto en 5 archivos.

### DT-2 — Auto-blindajes con prefix `AB-CROSS-CHAIN-N` (no `AB-WKH-XX-N`)

Los 5 PRs no son una WKH numerada (no tenían work-item formal). Usar prefix `AB-CROSS-CHAIN-N` indica claramente que la lección viene de un sprint reactivo, no de una HU planificada. Útil para futuras grep `AB-CROSS-*` para encontrar hard-won lessons.

### DT-3 — No re-implementar nada

Todos los fixes ya están en `main`. Esta HU es 100% documental. El Dev (nexus-dev) NO se lanza para esta HU. AR/CR tampoco — los PRs ya pasaron review individual al merge.

### DT-4 — Timeline cronológico en done-report

Para que el lector entienda por qué la cascada fue inevitable (cada fix destrabó el siguiente layer pero descubrió el siguiente bug), documentamos la secuencia de smoke-fail → log → fix con timestamps UTC del commit log.

---

## 3. Root cause en cascada — el bug iceberg

El smoke E2E cross-chain fallaba con síntomas distintos en cada iteración. Cada
fix destrabó el siguiente layer pero expuso el bug subyacente. Total: **7 root
causes en serie** para que las 4 txs aparezcan on-chain.

### Layer 1 — Pieverse facilitator caído (upstream)

- **Síntoma original**: `/compose` devolvía 402 `Failed to settle payment`.
- **Investigación**: probe HTTP a `https://facilitator.pieverse.ai/v2/verify` retornaba `HTTP_CODE=000` (DNS fail / connection refused) desde 2026-04-13.
- **Causa**: Pieverse upstream blocker (WKH-45). NO es nuestro código.
- **Fix aplicado**: ninguno acá — heredamos a layer 2.

### Layer 2 — wasiai-a2a apuntaba a Pieverse por default

- **Síntoma**: aún cambiando facilitator local, el adapter seguía POSTeando a Pieverse.
- **Causa**: `KITE_FACILITATOR_URL` no estaba seteada en Railway → default era Pieverse legacy.
- **Fix**: setear `KITE_FACILITATOR_URL=https://wasiai-facilitator-production.up.railway.app` en Railway env. **Cambio infra, no código.**

### Layer 3 — Path drift `/v2/verify` legacy vs `/verify` spec (PR #48)

- **Síntoma**: post-switch a `wasiai-facilitator`, requests retornaban HTTP 404.
- **Investigación**: `wasiai-facilitator` no expone `/v2/*` — solo `/verify`, `/settle`, `/supported`. El prefix `/v2/` era convención Pieverse-specific.
- **Causa**: el adapter `KiteOzonePaymentAdapter` tenía hardcoded `${facilitatorUrl}/v2/verify` y `${facilitatorUrl}/v2/settle`.
- **Fix (PR #48, edde596)**: paths a `/verify` y `/settle`. Body envelope idéntico. Diff de 5 inserciones / 5 deleciones.
- **Verification**: `GET /supported` retornó 200 con `chains: [eip155:2368 Kite, eip155:43113 Fuji]`; `POST /verify {}` retornó 400 INVALID_PAYLOAD (sintaxis OK, validation expected).

### Layer 4 — Envelope shape Pieverse vs x402 spec-literal

- **Síntoma**: post-fix paths, `/verify` retornaba `400 INVALID_PAYLOAD` con payloads firmados.
- **Causa**: el body `{paymentPayload, paymentRequirements}` venía de Pieverse spec; `wasiai-facilitator` espera el x402 canonical envelope (firma `TransferWithAuthorization` contra el contrato del token PYUSD, no contra el contrato del facilitator).
- **Fix**: setear `KITE_FACILITATOR_MODE=x402` en Railway env. Esto activa el branch del adapter que firma EIP-3009 spec-literal. **Cambio infra, no código** — el branch ya existía en `payment.ts` desde una HU anterior.

### Layer 5 — Schema drift v2 marketplace (PR #49)

- **Síntoma**: inbound Kite tx OK (200 con `txHash` real), pero **0 downstream Fuji txs**. La response `/compose` no contenía `downstream` field.
- **Investigación**: `signAndSettleDownstream` retornaba `null` para todos los steps. Tracing reveló que `agent.payment` quedaba `undefined` → guard fail.
- **Causa**: `wasiai-v2` (consumed por `/discover`) expone:
  - `payment.protocol = "x402"` (no `payment.method = "x402"`)
  - `chain = "avalanche-testnet"` a top-level del agent (no dentro de `payment.chain`)
  - `signAndSettleDownstream` chequea `chain === "avalanche"`
- **Fix (PR #49, 7c3419f)**: extender `readPayment` con 3 fallbacks defensivos:
  ```ts
  const methodRaw = obj.method ?? obj.protocol;
  const chainRaw = obj.chain ?? raw.chain;
  const chain = chainRaw === 'avalanche-testnet' ? 'avalanche' : chainRaw;
  ```
- **Backward compatible**: agentes que ya exponen el shape canonical no se afectan.

### Layer 6 — CONFIG_MISSING silencioso (`FUJI_RPC_URL`)

- **Síntoma**: post-PR #49, smoke seguía mostrando `downstream: undefined`.
- **Investigación**: agregamos diagnostic logs (PR #50, 7187ccb) — `FLAG_ON: WASIAI_DOWNSTREAM_X402=true` confirmado, `agent.priceUsdc=0.001`, `payment.method=x402`, `payment.chain=avalanche` — todo bien. Pero el helper `signAndSettleDownstream` retornaba null.
- **Causa raíz**: `FUJI_RPC_URL` no estaba seteada en Railway. La función fallaba silently en el RPC client init (probable `null check` o try/catch silencioso) y devolvía null sin logging.
- **Fix**: agregar `FUJI_RPC_URL=https://api.avax-test.network/ext/bc/C/rpc` a Railway env. **Cambio infra**, no código.
- **Lección clave**: AB-CROSS-CHAIN-5 (CONFIG_MISSING silencioso es UX killer en debugging).

### Layer 7 — Reply.sent post-await + timeout headroom (PR #52)

- **Síntoma post-éxito**: las 4 txs aparecían on-chain, pero los logs Railway mostraban `FST_ERR_REP_ALREADY_SENT` y algunos requests retornaban 504 cuando el cluster Fuji RPC iba lento.
- **Causa A (reply guards)**: el handler de x402 middleware tiene awaits de 5-10s en `verify`/`settle`. Si el `createTimeoutHandler` dispara 504 mientras el await está pendiente, cuando el await resuelve y se llama `reply.status(402).send(...)`, Fastify throws `FST_ERR_REP_ALREADY_SENT`.
- **Causa B (timeout)**: `TIMEOUT_COMPOSE_MS` default era `60000` (60s). Pipeline 3-step toma ~32s; pipeline 5-step podría ir a 50-70s — boundary muy ajustada.
- **Fix (PR #52, e4d217d)**:
  - 5 guards `if (reply.sent) return;` en `src/middleware/x402.ts` (4 post-await + 1 pre-`reply.header`).
  - Default `TIMEOUT_COMPOSE_MS` → `120000` en `src/routes/compose.ts:25`, alineado con `TIMEOUT_ORCHESTRATE_MS`.

### Por qué funcionó la cascada

Cada fix era **necesario y suficiente** para destrabar el siguiente síntoma. El orden cronológico tampoco fue arbitrario: layer N solo era observable después de fixar layer N-1 (no podías ver `payment.method=undefined` mientras el path estaba en 404). Esto significa que **un único smoke-test E2E fue suficiente** para drenar la pila — no necesitábamos 5 smokes paralelos.

---

## 4. Constraint Directives (CD)

Heredadas y escaladas para futuras HUs cross-chain:

- **CD-1**: PROHIBIDO asumir `https://facilitator.pieverse.ai` como facilitator. Usar `wasiai-facilitator` vía `KITE_FACILITATOR_URL`. Pieverse permanece deprecated.
- **CD-2**: PROHIBIDO leer `agent.payment.method` o `agent.payment.chain` sin fallback a `agent.payment.protocol` / `agent.chain`. El registry `wasiai-v2` expone schema drift permanente.
- **CD-3**: PROHIBIDO middleware con awaits >5s sin `if (reply.sent) return;` antes de cada `reply.send`/`reply.header` post-await.
- **CD-4**: PROHIBIDO config-missing silencioso. Cualquier env var crítica para cross-chain (FUJI_RPC_URL, KITE_FACILITATOR_URL, OPERATOR_PRIVATE_KEY) debe loguear `CONFIG_MISSING ${VAR}` al startup y al primer uso.
- **CD-5**: PROHIBIDO sentinels compartidos como ownerRef (heredada de WKH-63). `'x402-anonymous'` causa cross-tenant takeover. Si no hay tenant identity verificable, mutación se rechaza.
- **CD-6**: PROHIBIDO usar `node:vm` o `new Function()` como security boundary (heredada de WKH-60). Worker threads o isolated-vm.
- **CD-7**: Cuando un default de timeout cambie, debe alinearse con todos los timeouts del mismo flow (compose / orchestrate). Documentar en commit message qué timeout sirve de baseline.

---

## 5. Waves de implementación

**N/A — esta HU es retrospectiva 100% documental.** No se ejecuta `nexus-dev`. No hay W0/W1/W2 porque los 5 PRs ya están mergeados a `main`.

Si esto fuera un futuro forward-looking SDD, las waves serían:

- W0 (serial): catalogar fallbacks en `readPayment` y verificar sucessor calls.
- W1 (paralelo): aplicar guards `reply.sent` en cualquier middleware con awaits.
- W2 (paralelo): instrumentar todos los CONFIG_MISSING con log estructurado.

---

## 6. Exemplars verificados

| Exemplar | Path | Por qué sirve de referencia |
|----------|------|----------------------------|
| Schema drift fallback | `src/services/discovery.ts:29-71` | Patrón `obj.X ?? obj.Y ?? raw.X`, con normalize trailing |
| Reply.sent guard | `src/middleware/x402.ts:127`, `:141`, `:160`, `:172`, `:185` | 5 puntos canónicos donde post-await reply puede chocar contra timeout |
| Facilitator switch | `src/adapters/kite-ozone/payment.ts:37-50` | Pattern `mode: 'pieverse' \| 'x402'` con doc inline |
| Smoke E2E cross-chain | `scripts/smoke-e2e-cross-chain.mjs` | Pipeline 3 agents + viem EIP-3009 sign + 4 tx assertions |
| Auto-blindaje cross-tenant | `doc/sdd/060-wkh-63-sec-reg-1/auto-blindaje.md` (sección "sentinel compartido") | Anti-pattern documentado |
| Auto-blindaje RCE | `doc/sdd/062-wkh-60-sec-rce-1/auto-blindaje.md` | `node:vm` no es security boundary |

---

## 7. Plan de tests

**N/A para esta HU.** Pero los tests que cubren los fixes ya están:

| Fix | Test que lo cubre |
|-----|-------------------|
| PR #48 paths | `scripts/smoke-e2e-cross-chain.mjs` (integración real on-chain) |
| PR #49 fallbacks | `src/services/__tests__/discovery.test.ts` (debe tener cases para `protocol` y `raw.chain` — verificar) |
| PR #52 reply guards | Detectados solo por logs Railway; un test unit requeriría mock de Fastify reply lifecycle (TD-MNR sugerido). |
| PR #52 timeout | Implícito en smoke (32s < 120s). |

**Sugerencia retrospectiva (TD-MNR)**: agregar test unitario que simule timeout disparado durante `await verify()` y verifique que **no** se llama `reply.send()` post-timeout.

---

## 8. Readiness Check

- [x] Todos los exemplars verificados con Glob/Read
- [x] No hay `[NEEDS CLARIFICATION]` pendientes
- [x] PRs #48–#52 mergeadas a `main` (verified via `git log`)
- [x] 4 tx hashes confirmados (1 Kite + 3 Fuji) en commit message PR #51
- [x] CD heredados de SDDs anteriores (058–062) documentados
- [x] No hay duplicación con SDDs anteriores — solo referencias cruzadas
- [x] Smoke `scripts/smoke-e2e-cross-chain.mjs` ejecutable

**SDD APROBADO retroactivamente.** No requiere F2.5 (no hay implementación pendiente). Procede a `auto-blindaje.md` + `done-report.md`.
