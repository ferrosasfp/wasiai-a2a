# Auditoría E2E Integral del Ecosistema WasiAI — 2026-07-07

**Método:** 6 agentes en paralelo, pruebas read-only + telemetría + on-chain + código (el `/execute` real está money-gated). DB: bdwv (testnet dev). Ejecutada durante la noche mientras el bug del $0 de Chaski se resolvía.

---

## 1. Veredicto por subsistema

| Subsistema | Estado | Nota |
|-----------|--------|------|
| Gateway money-path (discover→plan→fee/split) | ✅ **SANO** | WKH-153 confirmado en vivo (input estructurado); fee 1% reconcilia; edge-cases sin 500 |
| Facilitator (settle x402) | ✅ **SANO** salvo circuit-breaker | mutex serializa (0 reverts on-chain); Redis Upstash OK; idempotencia sólida |
| Invocación de agentes (proxy wasiai-v2) | ⚠️ **Funciona, catálogo sucio** | x402 gating correcto, charged=0 en fallos; pero 12/32 agentes rotos |
| DB / RLS / ownership | ⚠️ **a2a-core sólido, leak en facilitator_** | sin IDOR; guards previos cerrados; NUEVO leak en facilitator_* tables |
| Chaski / yarvis (consumer) | ✅ **SANO** | reenvía input estructurado verbatim; maxDuration=60 fix live |
| Apps demo (10) | ✅ **10/10 cargan** | landing, marketplace, agentshop, cobraya, chaski, pitch |

---

## 2. La saga del $0 de Chaski — 3 bugs encadenados (todos entendidos)

| # | Bug | Repo | Estado |
|---|-----|------|--------|
| 1 | **WKH-151** — plan vacío: el pre-filtro de `capabilities` de discovery starveaba al planner | a2a gateway | ✅ FIXED + deployed |
| 2 | **WKH-153** — el planner mandaba `{query}` genérico en vez del `input_schema` real → agentes daban 400 | a2a gateway | ✅ FIXED + deployed (confirmado e2e: /plan en vivo genera `{amountUSD, receiverCountry,...}`) |
| 3 | **WKH-154** — el circuit-breaker del facilitator tira carga buena en bursts de settle | facilitator | 🔄 en fix (re-escopeado) |

**Prueba de que 1+2 funcionan:** un `/orchestrate/execute` real mostró el **step 0 (kyc) ejecutando + settleando con txHash on-chain real** (`0xfc82ad…`). La cadena llega hasta el settle.

**WKH-154 — root cause DEFINITIVA (verificada on-chain):**
- El mutex de serialización YA está deployado y **FUNCIONA** (nonces monótonos 628→629→630, **0 reverts en 40 txs**). La colisión de nonce on-chain está cerrada.
- Los settles fallidos **mueren en `simulateContract`, nunca llegan a la cadena** (0 plata movida). El "gas required exceeds allowance (24468/11800/62584)" es el error de `eth_estimateGas` de coreth durante **contención same-account** — NO es gas/saldo/fee (base fee Fuji ~1 wei; relayer con 1.14 AVAX + no gasta USDC).
- **Culpable real:** el CIRCUIT BREAKER cuenta cada simulate-fail (contención interna) como "chain unavailable"; con >50% en 30s se ABRE → devuelve 503 a settles BUENOS por ~10s → el batch multi-step falla → $0.
- **Fix:** el breaker debe distinguir fallos transport/RPC (abrir) de simulate/business/contención (no contar).

---

## 3. Hallazgos por severidad

### 🔴 ALTO
- **WKH-155 [SEC] — tablas `facilitator_settlements` + `facilitator_audit_log` con RLS abierta en bdwv.** Anon (con la key PÚBLICA del frontend) lee el ledger de settlements (wallets, montos, tx) + IPs de clientes (PII). Y probable **anon-WRITE** (DELETE zero-row dio 204) → podría borrar/forjar settlements (wipe idempotencia → doble-settle), tamperear audit, envenenar `a2a_events`/`app_settings`. Falta confirmar `relrowsecurity` (1 query SQL). **Remediación:** ENABLE RLS + REVOKE anon writes + REVOKE anon SELECT en las 2 del facilitator.
- **[ops] Relayer 0xf432 con gas bajo en Fuji (1.14 AVAX)** — no es la causa del $0 (WKH-154 es el breaker), pero conviene recargar; los settles de fee/split de las últimas horas quedaron `failed` por el breaker + RPC flaky.

### 🟠 MEDIO
- **WKH-154 (el bug #3 de arriba)** — circuit-breaker tira carga buena.
- **Catálogo de agentes: 12/32 cobrables rotos vía proxy** (charged=0, sin pérdida de plata, pero engaña al usuario). 3 clawmerchants 404-dead, 5 chitacloud timeout, 2 blexsignal 500, sentiment-analyzer schema-mismatch, dataarbitrage flaky. → ticket WKH-156.
- **`sentiment-analyzer` schema incompatible:** bdwv pide `text`, el upstream demo pide `input` (string) → inalcanzable vía a2a. Afecta a todo agente con `endpoint_url = …/api/demo/agents/*`.
- **2 agentes son mock/echo** (`wasiai-news-summarizer`→beeceptor, `dataarbitrageagent`→httpbin) → devuelven basura si se invocan.
- **`a2a_inbound_tasks` no existe en bdwv** → el flujo WKH-115 daría 500 (migración `20260708000000_wkh115_inbound_tasks.sql` no aplicada a bdwv).

### 🟡 BAJO
- `/discover` free-text débil (`q=sentiment`→0 pese a existir agentes) — reenvía `q` upstream; no afecta money-path (el planner usa capabilities + broaden-retry).
- Sort verified-first inerte (0/31 verificados).
- Dead-endpoint 404 se surfacea como 422 al caller (semántica engañosa).
- Timeout amplification (~30s para los chitacloud lentos por retry×timeout).
- `registries.auth.value` = secreto estático largo-vivo sin rotación (protegido at-rest).
- 3 clawmerchants son GET-only (POST→404) — mismatch de método.
- PWA manifest de Chaski con branding viejo "Yarvis" (cosmético).

---

## 4. Lo que está SÓLIDO (confirmado)
- Guards de ownership app-layer (owner_ref en a2a_agent_keys/tasks/identity) — **sin IDOR**.
- Fixes de la auditoría 2026-07-05 (webhook_secret, creator_*, a2a_protocol_fees anon) — **siguen cerrados**.
- x402: no-charge-on-failure, débito post-success, per-key mutex, refund-on-settle-fail, economía del challenge coherente.
- Facilitator: idempotencia (SETNX + auth-nonce on-chain), settle-cap fail-closed, 4 chains rpc:ok, Redis degraded:false, 798/798 tests verdes.
- Fee 1% sobre spend real (no sobre el cap); splits bps independientes; contabilidad consistente.

---

## 5. Tickets creados
- **WKH-152** — guard de relevancia en el path LLM del planner (deuda pre-existente).
- **WKH-153** — planner input_schema (✅ DONE, deployed).
- **WKH-154** — circuit-breaker tira carga buena (🔄 en fix).
- **WKH-155** — [SEC] facilitator_* tables RLS abierta.
- **WKH-156** — salud del catálogo de agentes (12/32 rotos) [a crear].

---

## 6. Próximas acciones (para el humano)
1. **WKH-155 (SEC)** — correr el 1-liner `relrowsecurity` + aplicar la migración RLS/REVOKE en bdwv (money-gated, requiere tu OK).
2. **WKH-154** — revisar el fix del circuit-breaker (lo dejo listo/deployado si el AR pasa limpio) + reintentar Chaski.
3. **Catálogo (WKH-156)** — marcar inactive los 5 chitacloud + 3 clawmerchants + 2 mock; arreglar el schema de sentiment.
4. **Aplicar migración `a2a_inbound_tasks` a bdwv** (WKH-115 gap).
5. Recargar gas del relayer en Fuji (opcional).
