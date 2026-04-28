# Done Report — 063 Cross-Chain E2E Retro

**Fecha**: 2026-04-28
**HU**: TRUE cross-chain Kite PYUSD inbound + Fuji USDC outbound funcional E2E
**Mode**: QUALITY (retrospectivo, post-merge)
**Status**: DONE
**Author**: nexus-architect (F2 retrospectivo) + nexus-docs (consolidación)

---

## Resumen ejecutivo

Hackathon Kite cerró el sprint security (SDDs 058–062, mergeadas el 2026-04-27)
y abrió el sprint cross-chain (5 PRs en cascada el 2026-04-28). Al final del
día teníamos **4 transacciones reales on-chain** demostrando true cross-chain
en una sola corrida de `/compose`:

- **1 inbound** Kite testnet PYUSD (settled vía wasiai-facilitator, x402 spec mode)
- **3 outbound** Avalanche Fuji USDC (settled por step vía `signAndSettleDownstream`)

Cero hardcodes, cero secrets en código, todo desde env vars, on-chain verifiable.

---

## Timeline cronológico — cómo se descubrió cada bug

Tiempos UTC del commit log. Cada PR fue descubierto por un smoke fail con
síntoma distinto, fixado, y el siguiente smoke reveló el siguiente layer.

| Hora UTC | Evento | PR | Síntoma observado |
|----------|--------|----|--|
| 07:38 | PR #48 merge `edde596` | fix(kite-adapter) paths | `wasiai-facilitator` retornaba HTTP 404 en `/v2/verify` (no expone prefix `/v2/`) |
| ~07:40 | smoke run #2 | — | aún failing: HTTP 400 INVALID_PAYLOAD post-fix paths |
| ~07:42 | infra change | — | setear `KITE_FACILITATOR_MODE=x402` en Railway env (cambio infra, no PR) |
| ~07:45 | smoke run #3 | — | inbound Kite tx OK, **0 downstream Fuji txs**, response sin `downstream` field |
| 07:50 | PR #49 merge `7c3419f` | fix(discovery) schema fallbacks | tracing reveló `agent.payment` undefined → `signAndSettleDownstream` → null |
| ~07:53 | smoke run #4 | — | post-fix, downstream **aún undefined** — algo más broken pero no sabemos qué |
| 07:55 | PR #50 merge `7187ccb` | chore(diag) debug logs | agregamos logs estructurados FLAG_ON/FLAG_OFF + agent payment shape |
| ~08:00 | smoke run #5 | — | logs muestran `FLAG_ON, priceUsdc=0.001, method=x402, chain=avalanche` — todo OK pero downstream null |
| ~08:02 | infra change | — | descubrimos `FUJI_RPC_URL` no está en Railway env. Setear. |
| ~08:05 | smoke run #6 | — | **4 txs on-chain confirmadas** 🎯 |
| 08:08 | PR #51 merge `a552508` | chore cleanup + smoke script | quitar logs temporales + commit del smoke automatizado |
| ~08:10 | logs review | — | Railway logs muestran `FST_ERR_REP_ALREADY_SENT` post-success y algunos 504 raros |
| 08:14 | PR #52 merge `e4d217d` | fix(x402) guards + timeout | reply.sent guards + TIMEOUT_COMPOSE_MS 60s→120s |

**Total**: ~36 minutos de PRs activos + ~6 smoke iterations + 2 cambios de infra Railway.

---

## Evidencia on-chain — 4 transacciones reales

Todas confirmadas y publicadas en commit message de PR #51 (`a552508`).
**Validation timestamp**: 2026-04-28T14:06 UTC.

### Inbound Kite testnet PYUSD (1 tx)

| Tx hash | Explorer |
|---------|----------|
| `0x04ba7afcceeb30445e71e42e34523167c6aa92c0d8adc11c0f3abe27e24d7219` | https://testnet.kitescan.ai/tx/0x04ba7afcceeb30445e71e42e34523167c6aa92c0d8adc11c0f3abe27e24d7219 |

Settled vía `wasiai-facilitator` en mode `x402`. Token: PYUSD (`0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9`). Chain: Kite testnet 2368.

### Outbound Avalanche Fuji USDC (3 txs, una por step del pipeline)

| Step | Agent | Tx hash | Explorer |
|------|-------|---------|----------|
| 1 | `wasi-chainlink-price` | `0xc7fb70214b35910a24527d4cee7addcfd89c48d637591d4ee7ff57c1656642e5` | https://testnet.snowtrace.io/tx/0xc7fb70214b35910a24527d4cee7addcfd89c48d637591d4ee7ff57c1656642e5 |
| 2 | `wasi-defi-sentiment` | `0x9b32b5767eb2aafc2fb920b36de0df67f0603838dc84bd2de15ae61d6f7c762b` | https://testnet.snowtrace.io/tx/0x9b32b5767eb2aafc2fb920b36de0df67f0603838dc84bd2de15ae61d6f7c762b |
| 3 | `wasi-wallet-profiler` | `0xc7676a51720972333a5b156777da3783cf48093d0069835a0b03ef2ce30db075` | https://testnet.snowtrace.io/tx/0xc7676a51720972333a5b156777da3783cf48093d0069835a0b03ef2ce30db075 |

Settled por step vía `signAndSettleDownstream` (WKH-55). Token: USDC en Fuji. Chain: Avalanche Fuji 43113.

### Pipeline ejecutado

```
caller (PYUSD Kite)
    ↓ EIP-3009 signed
POST /compose [X-PAYMENT header]
    ↓
wasiai-a2a verifies + settles inbound (Kite tx 1)
    ↓
step 1: invokes wasi-chainlink-price → signAndSettleDownstream (Fuji tx 1)
step 2: invokes wasi-defi-sentiment → signAndSettleDownstream (Fuji tx 2)
step 3: invokes wasi-wallet-profiler → signAndSettleDownstream (Fuji tx 3)
    ↓
response 200 + 4 tx hashes
```

End-to-end ~32 segundos. Smoke automatizado en `scripts/smoke-e2e-cross-chain.mjs`.

---

## Métricas

| Métrica | Valor |
|---------|-------|
| Tests totales | 612 (cubrimiento global del repo) |
| Regresiones introducidas | 0 |
| PRs cross-chain (1 día) | 5 (#48, #49, #50, #51, #52) |
| Líneas modificadas (código prod) | 39 inserciones / 14 deleciones |
| Líneas agregadas (smoke + tests) | 238 (smoke E2E) |
| Commits totales del día | 5 merges + 0 reverts |
| Tx hashes on-chain (validation) | 4 (1 Kite + 3 Fuji) |
| Tiempo total de cascada | ~36 min PR activity (07:38 → 08:14 UTC) |
| Costo blockchain (testnet) | 0 (testnet faucets) |
| Costo de API LLM | ~0 (no LLM en path crítico cross-chain) |

---

## Archivos modificados (resumen)

| Archivo | PR | Cambio neto |
|---------|----|-|
| `src/adapters/kite-ozone/payment.ts` | #48 | 5 inserciones / 5 deleciones (paths `/v2/*` → `/*`) |
| `src/services/discovery.ts` | #49 | 30 inserciones / 9 deleciones (3 fallbacks defensivos en `readPayment`) |
| `src/lib/downstream-payment.ts` | #50, #51 | +8 / -8 (debug logs added then removed) |
| `src/middleware/x402.ts` | #52 | 7 inserciones / 1 deleción (5 reply.sent guards) |
| `src/routes/compose.ts` | #52 | 1 inserción / 1 deleción (timeout default `60000` → `120000`) |
| `scripts/smoke-e2e-cross-chain.mjs` | #51 | +238 (nuevo smoke automatizado) |

---

## Constraint Directives establecidos por esta HU

Heredados al SDD para futuras HUs cross-chain (ver `sdd.md` §4):

- **CD-1**: Pieverse facilitator deprecated → usar `wasiai-facilitator` vía env.
- **CD-2**: `agent.payment` lecturas con fallback `protocol`/`raw.chain`.
- **CD-3**: middleware con awaits >5s → guards `reply.sent`.
- **CD-4**: env vars críticas cross-chain → log `CONFIG_MISSING`.
- **CD-5**: nunca sentinels compartidos como ownerRef (heredada WKH-63).
- **CD-6**: `node:vm` no es security boundary (heredada WKH-60).
- **CD-7**: defaults de timeout alineados entre flows (compose / orchestrate).

---

## Auto-blindajes documentados

Ver `auto-blindaje.md` para detalle. Resumen:

| ID | Lección |
|----|---------|
| AB-CROSS-CHAIN-1 | Pieverse vs x402 envelope — verificar `GET /supported` antes del switch |
| AB-CROSS-CHAIN-2 | Schema drift en cascada — fallbacks defensivos en boundaries |
| AB-CROSS-CHAIN-3 | Sentinels compartidos = cross-tenant takeover (heredada WKH-63) |
| AB-CROSS-CHAIN-4 | `node:vm` no es security boundary (heredada WKH-60) |
| AB-CROSS-CHAIN-5 | CONFIG_MISSING silencioso es UX killer en debugging |
| AB-CROSS-CHAIN-6 | Reply.sent guards post-await previenen FST_ERR_REP_ALREADY_SENT |

---

## Próximos pasos sugeridos

### TD documentado (no blockers)

| # | Tema | Prioridad |
|---|------|-----------|
| TD-CC-1 | Test unit reply.sent race | MEDIA |
| TD-CC-2 | Startup `CONFIG_MISSING` logger | ALTA |
| TD-CC-3 | Fixture tests por marketplace shape | MEDIA |
| TD-CC-4 | Helper `sendIfNotSent` | BAJA |
| TD-CC-5 | Runbook facilitator switch | MEDIA |

### Sprint recomendado

- **Sprint cross-chain hardening** (próximo): atacar TD-CC-2 (config validation) primero — ROI más alto. ~½ día de trabajo, mata clase entera de bugs silenciosos.
- **Sprint testing**: TD-CC-1 + TD-CC-3 — agregan ~30 tests pero cubren regression risk del flow más crítico del producto.
- **TD-WKH-60 hardening continuo**: ya cubierto en SDD 062 — seguir refinando worker_threads + cache hardening.
- **Sentinels audit**: ya cubierto en SDD 060 — pero hay que extender a `tasks` (WKH-54) cuando esa tabla agregue ownership.

---

## Cross-references

| SDD | Relación |
|-----|----------|
| 057-wkh-57-was-v2-3-client | Origen del schema drift v2 (cubierto por PR #49) |
| 054-wkh-55-downstream-x402-fuji | `signAndSettleDownstream` baseline (consumido por cross-chain) |
| 058-wkh-62-sec-ssrf-1 | SSRF protection — co-existe con cross-chain pero ortogonal |
| 060-wkh-63-sec-reg-1 | Cross-tenant ownership — fix originario del sentinel anonymous |
| 062-wkh-60-sec-rce-1 | RCE blocking + cache hardening — co-existe |

---

## Verdict

**DONE.** Cross-chain E2E demonstrably operational on-chain. 5 PRs mergeadas a `main`. 0 regresiones. 612 tests verdes. 4 tx hashes verifiable.

Sprint hackathon Kite cierra con cross-chain proven. La disciplina del retro
(SDD + auto-blindaje + done-report) compensa el shortcut de F2/F2.5 que
tomamos durante el rush — la próxima HU cross-chain arranca con CD heredados
y AB documentados.

---

*Reporte generado retroactivamente por nexus-architect (F2 retro). Push to
`main` ya hecho a través de cada PR individual — esta HU es 100% documental,
no requiere push adicional de código.*
