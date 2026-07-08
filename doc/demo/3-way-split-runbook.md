# Demo runbook — Fee split 3-way (platform + creator + referral) on-chain

**Qué muestra:** una orquestación por el gateway a2a donde el fee del protocolo (1%) se
divide y **paga on-chain a 3 destinatarios distintos** — plataforma, creator del agente, y
un referral — todo en testnet KITE. Es la prueba visible del modelo de fee-split (WKH-136)
funcionando end-to-end.

> **Estado:** verificado en vivo 2026-07-09 (orquestación `39b1ad56-a2a0-49b7-bdea-16f2a1c570cf`).
> Los 2 agentes de demo ya están registrados en `a2a_agents` (bdwv) con `enabled=false`
> (invisibles al gateway hasta que los prendas para la demo).

---

## Por qué hace falta un setup especial
El referral **solo resuelve para agentes a2a-nativos** (filas en `a2a_agents` con `referrer_ref`).
Los agentes del marketplace (tabla `agents`, ej. los agentshop-*) caen en la rama de
registry-externo, donde el referral es SIEMPRE null. Por eso la demo usa 2 agentes a2a-nativos
dedicados (un "primario" que se ejecuta + un "referrer" solo referenciado).

## Los 3 footguns (ya resueltos en el setup, documentados por si se recrea)
1. **`metadata.payTo` obligatorio** — un agente self-published *priced* necesita `metadata.payTo`
   (dónde se le paga su precio); el a2a-key NO lo saltea. Sin él: `Step 0 failed: No payTo address`.
2. **Checksum EIP-55 / viem** — las wallets deben ser checksum-válidas O all-lowercase.
   Mixed-case inválido → `Address ... must match its checksum counterpart`. Usar minúsculas.
3. **El caller DEBE usar `x-a2a-key` (prepago), NO x402** — con x402 un agente self-published
   priced tira "No payTo" y el step falla (sin fee, sin split).

---

## Setup (ya aplicado — referencia)
Los agentes en `a2a_agents` (bdwv, ref `bdwvrwzvsldephfibmuu`):

| slug | rol | enabled | price | payout_wallet | referrer_ref | metadata.payTo |
|------|-----|---------|-------|---------------|--------------|----------------|
| `wasiai-fee-split-settlement-agent` | primario (se ejecuta) | false* | 0.05 | `0xcafe…cafe` (creator) | `wasiai-referral-partner` | `0xcafe…cafe` |
| `wasiai-referral-partner` | referrer (referenciado) | false | 0 | `0xbeef…beef` (referral) | — | — |

\* prender solo durante la demo. El primario apunta `agent_url` al echo `https://wasiai-base-demo-agent.vercel.app/api/invoke/base-demo` (responde 200). Config de splits en prod: `PLATFORM=8000 / CREATOR=1500 / REFERRAL=500`.

*(Las wallets `0xcafe…`/`0xbeef…` son vanity de demo, distintas entre sí para pasar el dedup self-referral. Verificables en el explorer de KITE.)*

---

## Correr la demo

### 1. Prender el agente primario
```
! cd /home/ferdev/.openclaw/workspace/wasiai-a2a && AT=$(grep -E '^SUPABASE_ACCESS_TOKEN=' .env|cut -d= -f2-|tr -d '"') && curl -s -X POST "https://api.supabase.com/v1/projects/bdwvrwzvsldephfibmuu/database/query" -H "Authorization: Bearer $AT" -H "Content-Type: application/json" -H "User-Agent: Mozilla/5.0" -d '{"query":"UPDATE public.a2a_agents SET enabled=true WHERE slug='"'"'wasiai-fee-split-settlement-agent'"'"';"}'
```

### 2. Ejecutar (plan → execute) con `x-a2a-key`
- Gateway: `https://wasiai-a2a-production.up.railway.app`
- Header: `x-a2a-key: <WASIAI_A2A_KEY>` (en yarvis/.env.local) + `x-payment-chain: 43113`
- Goal: `"Generate the 3-way fee-split settlement receipt (fee-split settlement) for a WasiAI orchestration, with the platform/creator/referral breakdown."`
- `POST /orchestrate/plan` → `POST /orchestrate/execute` (con `orchestrationId`+`steps`+`maxQuotedCostUsdc` del plan).

### 3. Apagar el agente (post-demo, anti-contaminación)
```
! ... UPDATE public.a2a_agents SET enabled=false WHERE slug='wasiai-fee-split-settlement-agent';
```

---

## Resultado esperado (price 0.05 → fee 0.0005)
| Pata | bps | Monto USDC | Wallet |
|------|-----|-----------|--------|
| Plataforma | 8000 | 0.0004 | fee wallet (relayer) |
| Creator | 1500 | 0.000075 | `0xcafe…` |
| Referral | 500 | 0.000025 | `0xbeef…` |
| **Σ** | 10000 | **0.0005** | = fee 1% |

`a2a_protocol_fees.fee_total_usdc` = 0.0005 (total) · `fee_usdc` = 0.0004 (pata plataforma) · las patas creator+referral en `a2a_fee_splits` (status=charged).

## Prueba de la corrida verificada (2026-07-09, KITE 2368)
- Plataforma (fee): tx `0x88cf77f2ae4df789c3afb4809e4d2592cc2939429ca2ae876a75b94ca893904b`
- Creator: tx `0xdd3e2a06580674d1…` (0.000075 → 0xcafe)
- Referral: tx `0xe55da48235a40b23…` (0.000025 → 0xbeef)
- Todas minadas `status=1`. Débito off-chain del prepago: 0.05 (budget 6.873→6.823).

## Cleanup permanente (si no se re-usa)
```sql
DELETE FROM public.a2a_agents WHERE slug IN ('wasiai-fee-split-settlement-agent','wasiai-referral-partner');
```
Las filas de `a2a_fee_splits` quedan como audit trail.
