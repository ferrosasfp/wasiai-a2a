# Work Item — Cross-Chain E2E Retro (063)

**Tipo**: Retrospective / consolidated post-mortem
**Mode**: QUALITY (retro)
**Fecha**: 2026-04-28
**Autor**: nexus-architect (F2 retrospectivo)
**Status**: DONE (consolidación post-merge)
**Branch base**: `main` (PRs #48–#52 mergeadas)

> Esta HU virtual NO produce código nuevo. Documenta retroactivamente 5 PRs
> de bugfix/diagnóstico que se mergearon durante el debugging cross-chain
> del 2026-04-28 para aislar la disciplina (SDD + auto-blindajes) que se
> saltó en el rush hackathon.

---

## Contexto

El 2026-04-28 cerramos el sprint hackathon Kite con TRUE cross-chain E2E
funcionando: 1 inbound Kite testnet PYUSD + 3 outbound Fuji USDC settles
en una sola corrida de `/compose` con 3 steps. Para llegar ahí hubo que
desencadenar **5 PRs** en cascada (#48 → #52) cada uno destrabando un layer
distinto del pipeline cross-chain.

El proceso fue reactivo (smoke fail → log → fix → smoke fail → ...), no
siguió F2/F2.5 formal. Necesitamos extraer las lecciones antes de que se
olviden y referenciarlas desde el _INDEX para que futuras HUs cross-chain
arranquen con auto-blindaje.

### PRs consolidados

| PR | Commit | Título | Archivo principal |
|----|--------|--------|-------------------|
| #48 | edde596 | fix(kite-adapter): use /verify and /settle (no /v2/ prefix) | `src/adapters/kite-ozone/payment.ts` |
| #49 | 7c3419f | fix(discovery): v2 payment schema drift fallbacks | `src/services/discovery.ts` |
| #50 | 7187ccb | chore(diag): downstream flag/payment diagnostic logging | `src/lib/downstream-payment.ts` |
| #51 | a552508 | chore: remove debug logs + add cross-chain smoke | `scripts/smoke-e2e-cross-chain.mjs` (+) |
| #52 | e4d217d | fix(x402): reply.sent guards + bump TIMEOUT_COMPOSE_MS to 120s | `src/middleware/x402.ts`, `src/routes/compose.ts` |

---

## Scope IN

Archivos modificados durante el sprint cross-chain debugging (todos ya
mergeados a `main`):

1. `src/adapters/kite-ozone/payment.ts` — paths `/v2/verify` `/v2/settle` → `/verify` `/settle` (PR #48)
2. `src/services/discovery.ts` — `readPayment()` con fallbacks `obj.protocol` y `raw.chain` + normalización `avalanche-testnet` → `avalanche` (PR #49)
3. `src/lib/downstream-payment.ts` — diagnostic logs added (#50) y removed (#51)
4. `src/middleware/x402.ts` — `if (reply.sent) return;` guards en 4 sitios post-await (PR #52)
5. `src/routes/compose.ts` — `TIMEOUT_COMPOSE_MS` default `60000` → `120000` (PR #52)
6. `scripts/smoke-e2e-cross-chain.mjs` — nuevo smoke automatizado cross-chain (PR #51)

## Scope OUT

- NO se vuelve a tocar código de producción en esta HU (es retrospectiva).
- NO se reabren los SDDs 058–062 (sprint security) — se referencian.
- NO se modifica `wasiai-facilitator` ni `wasiai-v2` (proyectos hermanos).

---

## Acceptance Criteria (EARS)

### AC-1 — Facilitator switch documentado (Pieverse → wasiai-facilitator)

- **Given** que Pieverse facilitator está caído desde 2026-04-13 (HTTP 000 / DNS fail, WKH-45 upstream blocker)
- **When** `KITE_FACILITATOR_URL` apunta a `https://wasiai-facilitator-production.up.railway.app` y `KITE_FACILITATOR_MODE=x402`
- **Then** el adapter `KiteOzonePaymentAdapter` POSTea a `/verify` y `/settle` (sin prefix `/v2`) con envelope x402-spec-literal y recibe HTTP 200 con `valid=true` o `success=true`
- **Evidence**: `src/adapters/kite-ozone/payment.ts:199` (`fetch(\`${facilitatorUrl}/verify\`, ...)`), `src/adapters/kite-ozone/payment.ts:242` (`fetch(\`${facilitatorUrl}/settle\`, ...)`)

### AC-2 — Schema drift fallbacks defensivos en discovery

- **Given** que un agent del marketplace `wasiai-v2` expone `payment.protocol` en lugar de `payment.method` y `chain` a top-level del agent (no dentro de `payment`)
- **When** `readPayment(rawAgent)` corre sobre ese agent
- **Then** retorna un objeto `{method, chain, contract}` válido aplicando las reglas de fallback:
  - `obj.method ?? obj.protocol`
  - `obj.chain ?? raw.chain`
  - `chain === 'avalanche-testnet'` → normalizado a `'avalanche'`
- **Evidence**: `src/services/discovery.ts:29-71` (función `readPayment` con type guard extendido)

### AC-3 — Mode x402 spec-literal en kite-ozone adapter

- **Given** `KITE_FACILITATOR_MODE=x402` (vs. legacy `pieverse`)
- **When** el adapter firma una request de pago
- **Then** el envelope sigue el x402 canonical spec (EIP-3009 `TransferWithAuthorization` contra el contrato del token PYUSD directamente, no contra el contrato del facilitator)
- **Evidence**: `src/adapters/kite-ozone/payment.ts:37-50` (comentario doc del mode `'x402'`), confirmado que `wasiai-facilitator GET /supported` responde `chains: [eip155:2368 Kite, eip155:43113 Fuji]`

### AC-4 — Reply.sent guards previenen FST_ERR_REP_ALREADY_SENT

- **Given** que el x402 middleware tiene awaits de `verify`/`settle` que pueden tardar 5-10s
- **When** el `createTimeoutHandler` dispara 504 antes de que el await resuelva
- **Then** los `reply.send(...)` y `reply.header(...)` post-await son skipped vía `if (reply.sent) return;` y no se lanza `FST_ERR_REP_ALREADY_SENT`
- **Evidence**: `src/middleware/x402.ts:127`, `:141`, `:160`, `:172`, `:185` (5 guards introducidos)

### AC-5 — TIMEOUT_COMPOSE_MS con headroom para cross-chain

- **Given** que un pipeline 3-step cross-chain tarda ~32s y un 5-step puede llegar a 50-70s
- **When** `process.env.TIMEOUT_COMPOSE_MS` no está seteado
- **Then** el default es `120000` (120s), alineado con `TIMEOUT_ORCHESTRATE_MS`
- **Evidence**: `src/routes/compose.ts:25` (`parseInt(process.env.TIMEOUT_COMPOSE_MS ?? '120000', 10)`)

---

## Constraint Directives heredadas (de PRs)

- **CD-INHERIT-1** (de PR #48): Pieverse facilitator está deprecated y permanentemente roto. Cualquier HU futura que asuma `https://facilitator.pieverse.ai` debe ser rechazada — se usa `wasiai-facilitator` (URL en env var `KITE_FACILITATOR_URL`).
- **CD-INHERIT-2** (de PR #49): Cualquier código que lea `agent.payment.{method,chain}` debe tolerar `protocol` y `chain` top-level como fallbacks.
- **CD-INHERIT-3** (de PR #52): Cualquier middleware Fastify con awaits >5s debe tener `if (reply.sent) return;` antes de cada `reply.send` y `reply.header` post-await.

---

## Out of scope / referencias cruzadas

| Tema cubierto en | SDD |
|------------------|-----|
| Cross-tenant ownership (sentinel `'x402-anonymous'`) | 060-wkh-63-sec-reg-1 |
| L2 transform cache poisoning + node:vm | 062-wkh-60-sec-rce-1 |
| SSRF en discoveryEndpoint | 058-wkh-62-sec-ssrf-1 |
| Scoping check post-resolveAgent | 059-wkh-61-sec-scope-1 |
| Gasless drain protection | 061-wkh-59-sec-drain-1 |
| Schema drift v2 (origin) | 057-wkh-57-was-v2-3-client |
| Downstream Fuji USDC | 054-wkh-55-downstream-x402-fuji |

Esta retro **no duplica** esos hallazgos — los referencia. Foco aquí: el
"plumbing" cross-chain (paths, schema, timeouts, reply guards) que destrabó
las 4 txs reales on-chain.

---

## Done Definition

- [x] 5 PRs (#48–#52) mergeadas a `main`.
- [x] Smoke `scripts/smoke-e2e-cross-chain.mjs` corre verde en producción Railway.
- [x] 4 tx hashes confirmados on-chain (1 Kite + 3 Fuji), publicados en commit message PR #51.
- [x] `sdd.md`, `auto-blindaje.md`, `done-report.md` consolidados en `063-cross-chain-e2e-retro/`.
- [x] `_INDEX.md` actualizado con entry 063 → DONE.
