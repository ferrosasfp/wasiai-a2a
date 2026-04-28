# Cross-Chain E2E Proven — 2026-04-28

**Status**: ✅ TRUE cross-chain end-to-end funcionando en testnet
**Operator wallet**: `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba`

---

## TL;DR

WasiAI A2A Protocol orquesta pagos cross-chain entre **dos blockchains diferentes**, en una sola request HTTP:

```
Caller paga PYUSD en Kite Testnet  ───▶  wasiai-a2a recibe inbound
                                                      │
                            ┌─────────────────────────┘
                            │
                            ▼
              wasiai-a2a invoca N agents (wasiai-v2 marketplace)
                            │
                            ▼
              Por cada agent: firma USDC en Avalanche Fuji  ───▶  agent recibe outbound
```

**Validado on-chain con 4-6 transacciones reales por run** (1 Kite + N Fuji).

---

## Demos verificables (testnet)

### Demo 1 — `/compose` 3 agents (canonical pipeline)

| Tx | Chain | Type | Explorer |
|----|-------|------|----------|
| `0x04ba7afc…` | Kite | PYUSD inbound | [kitescan](https://testnet.kitescan.ai/tx/0x04ba7afcceeb30445e71e42e34523167c6aa92c0d8adc11c0f3abe27e24d7219) |
| `0xc7fb7021…` | Fuji | USDC → wasi-chainlink-price | [snowtrace](https://testnet.snowtrace.io/tx/0xc7fb70214b35910a24527d4cee7addcfd89c48d637591d4ee7ff57c1656642e5) |
| `0x9b32b576…` | Fuji | USDC → wasi-defi-sentiment | [snowtrace](https://testnet.snowtrace.io/tx/0x9b32b5767eb2aafc2fb920b36de0df67f0603838dc84bd2de15ae61d6f7c762b) |
| `0xc7676a51…` | Fuji | USDC → wasi-wallet-profiler | [snowtrace](https://testnet.snowtrace.io/tx/0xc7676a51720972333a5b156777da3783cf48093d0069835a0b03ef2ce30db075) |

### Demo 2 — `/compose` 5 agents (pipeline cap)

| # | Agent | Cost | Tx |
|---|-------|------|----|
| 1 | wasi-chainlink-price | $0.001 | [`0x463b1011…`](https://testnet.snowtrace.io/tx/0x463b1011b020f3639b08829a43ddb9d0a2d9c588995a8fc52fcae9bea9d5efc7) |
| 2 | wasi-chainlink-price | $0.001 | [`0x520b40e2…`](https://testnet.snowtrace.io/tx/0x520b40e2aa10d16c6930697521bf280ab8ac719b46165c4e39c4eff79b74bb2c) |
| 3 | wasi-defi-sentiment | $0.01 | [`0x3284ba7c…`](https://testnet.snowtrace.io/tx/0x3284ba7cf5bd8830c0f653c77de958b7bc77cb8704e0387bb012ab5e1f4dee2e) |
| 4 | wasi-wallet-profiler | $0.05 | [`0xdf64eeaf…`](https://testnet.snowtrace.io/tx/0xdf64eeaf0547021d3909d978e0949284a388bf008bd5298f9d353d6c0fae68e7) |
| 5 | wasi-liquidity-analyzer | $0.05 | [`0x75f89eed…`](https://testnet.snowtrace.io/tx/0x75f89eed24a90639afb987e3d3efad054d267d6d11b95c6bae459fa5274cad41) |

Inbound: [`0x3f4871bc…`](https://testnet.kitescan.ai/tx/0x3f4871bcefa5f879595e73c507e9c83d5a8bdbd5502685985717bb8c74f0cbdb) ($0.112 USDC, 41.8s)

### Demo 3 — `/orchestrate` LLM planner

Goal: `"Get the current AVAX price and DeFi market sentiment"`
LLM (Claude) eligió 3 agents BlexSignal automáticamente:
- [`0x1c694bb8…`](https://testnet.snowtrace.io/tx/0x1c694bb8df538922ddc63fad51c27aaf2cd7eda63fbe76f122f7060c942ce0ab) blexsignal-wt-momentum
- [`0x080f5a64…`](https://testnet.snowtrace.io/tx/0x080f5a641273685c2a65cb65ea9089d533f27a54d90cb4bc8faf6f9e775163d2) blexsignal-ob-levels
- [`0xb3067e72…`](https://testnet.snowtrace.io/tx/0xb3067e721b8d5b5e5dcf96e0f42bb3f6b0ef4e06203bbf8e3bbbad73b32fa2b4) blexsignal-daily-census

Inbound: [`0x2b569363…`](https://testnet.kitescan.ai/tx/0x2b569363a5b9d44309bfeae2a4d9dc947ceabd24b7d2a239119d427a288c17cb) ($0.07 USDC, 32s)

---

## Performance benchmark

| Métrica | Valor |
|---------|-------|
| **Success rate** | 5/5 (100%) |
| **Latency p50** | 27.0s |
| **Latency p95** | 31.2s |
| **Latency p99** | 31.2s |
| **Latency avg** | 25.9s |
| **Total USDC moved** | $0.305 |
| **Total txs on-chain** | 19 |
| **Avg txs per run** | 3.8 |

Pipeline 3 agents end-to-end (1 Kite + 3 Fuji), 5 runs consecutivas.

---

## Reproducir el demo

### Pre-requisitos
- Operator wallet con PYUSD en Kite testnet (~10 tokens) y AVAX para gas Fuji (~0.05 AVAX)
- Variables Railway prod ya seteadas:
  - `KITE_FACILITATOR_URL=https://wasiai-facilitator-production.up.railway.app`
  - `KITE_FACILITATOR_MODE=x402`
  - `WASIAI_DOWNSTREAM_X402=true`
  - `FUJI_RPC_URL=https://api.avax-test.network/ext/bc/C/rpc`

### Comando
```bash
node scripts/smoke-e2e-cross-chain.mjs            # 3 agents canonical
node scripts/smoke-cross-chain-5-agents.mjs       # 5 agents (pipeline cap)
node scripts/smoke-orchestrate-cross-chain.mjs    # LLM planner
node scripts/perf-bench-cross-chain.mjs           # 5-run benchmark
```

Cada smoke imprime los tx hashes con links directos a Snowtrace + KiteScan.

---

## Stack productivo

| Componente | URL | Status |
|------------|-----|--------|
| **wasiai-a2a** (orquestador) | https://wasiai-a2a-production.up.railway.app | ✅ live |
| **wasiai-facilitator** (multi-chain settle) | https://wasiai-facilitator-production.up.railway.app | ✅ live, soporta Kite + Fuji |
| **wasiai-v2 marketplace** (agents) | https://wasiai-v2.vercel.app | ✅ live |

`wasiai-facilitator` `/supported`:
```json
{"chains": [
  {"network": "eip155:2368",  "name": "Kite Testnet",     "methods": ["eip3009"], "breakerState": "CLOSED"},
  {"network": "eip155:43113", "name": "Avalanche Fuji",   "methods": ["eip3009"], "breakerState": "CLOSED"}
]}
```

---

## Sprint 2026-04-28 highlights

| PR | Cambio | Impacto |
|----|--------|---------|
| #44 | docs `SCHEMA_TRANSFORM_HMAC_KEY` + Railway helper | HMAC defense-in-depth |
| #45 | WKH-58 fix #1: skip Pieverse cuando a2aKey | Bypass Pieverse muerto en path a2a-key |
| #46 | Haiku 4.5 pricing canonical + a2a-key header propagation | Cost tracking correcto |
| #47 | TD cleanup 4 MNRs cosméticos | Hygiene |
| #48 | kite-adapter `/verify` paths | wasiai-facilitator switch |
| #49 | Schema drift v2 fallbacks | `agent.payment` se popula con v2 marketplace |
| #50 | Diagnostic logging downstream | Identificó CONFIG_MISSING en Railway |
| #51 | Cleanup debug + smoke E2E script | Reusable repro |
| #52 | x402 reply.sent guards + timeout 60s→120s | Hardening async handlers |
| #53 | Chain allowlist + facilitator timeouts | Defense-in-depth (post AR) |

**Total**: 10 PRs merged hoy, todos auto-mode. 612/612 tests cero regresión.

---

## Documentación relacionada

- `doc/sdd/063-cross-chain-e2e-retro/` — SDD retrospectivo del cross-chain debugging (work-item, sdd, auto-blindaje, done-report)
- `doc/research/2026-04-28-marketplace-502-422-investigation.md` — TD-WKH-49 root cause analysis
- `SPRINT-SECURITY-COMPLETE-2026-04-27.md` — sprint security previo
- `doc/sdd/_INDEX.md` — índice completo de SDDs

---

## Auto-blindajes acumulados (lecciones críticas para próximas HUs)

1. **Adapter envelope shape** debe coincidir con facilitator destino — siempre verificar `GET /supported` antes de switch
2. **Schema drift cascade** — cuando una API cambia, fallbacks defensivos en MÚLTIPLES boundaries
3. **Sentinels compartidos** = cross-tenant takeover. NUNCA usar valores fijos como ownerRef
4. **`node:vm`** NO es security boundary — usar Worker threads o isolated-vm
5. **CONFIG_MISSING silencioso** es UX killer — log envValue + which guard failed
6. **Reply.sent guards post-await** previenen FST_ERR_REP_ALREADY_SENT
7. **Chain allowlist explícita** vs implicit normalize — defensa contra registry comprometido
8. **Facilitator timeouts** simétricos (10s) — bound hangs en todas las llamadas

---

## Próximos pasos sugeridos (backlog)

- **WKH-64** (sugerido por F4 research): remove Pieverse legacy path en `compose.ts:301`
- **WKH-SEC-X-FACILITATOR-CB** (sugerido por AR): circuit breaker en wasiai-facilitator calls
- **WKH-SEC-X-FACILITATOR-FAILOVER** (sugerido por AR): backup facilitator (SPOF mitigation)
- TD-CC-* en `doc/sdd/063-cross-chain-e2e-retro/done-report.md` (5 items cosméticos)

---

*Generated 2026-04-28 — wasiai-a2a TRUE cross-chain demo ready for hackathon*
