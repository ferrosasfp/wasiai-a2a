# QA Report (F4) — WKH-113 [BASE-08] discovery chain validation dinamica + compose chain-flow

> QA: nexus-qa · Fecha: 2026-05-27
> Branch: `feat/095-wkh-113-discovery-chain-dynamic` (3 commits)
> AR: APROBADO (0 BLQ, 2 MNR) · CR: APROBADO (0 BLQ, 1 MNR)

---

## 1. Runtime / Integration Checks

### 1.1 Gates (runtime reales — no delegados a CR)

| Gate | Comando | Resultado |
|------|---------|-----------|
| Suite completa | `npm test` (vitest run) | **1059 passed / 1059** · 72 test files · 2.02s |
| Typecheck prod | `npx tsc -p tsconfig.build.json --noEmit` | **EXIT 0** (0 errores) |

Coincide exactamente con lo reportado por CR (1059/1059) y AR (1059/1059). Cero regresion.

### 1.2 Facilitator prod — soporte de 3 chains

```
GET https://wasiai-facilitator-production.up.railway.app/supported

{
  "chains": [
    {"network":"eip155:2368","name":"Kite Testnet","methods":["eip3009"],"breakerState":"CLOSED"},
    {"network":"eip155:43113","name":"Avalanche Fuji","methods":["eip3009"],"breakerState":"CLOSED"},
    {"network":"eip155:43114","name":"Avalanche","methods":["eip3009"],"breakerState":"CLOSED"},
    {"network":"eip155:84532","name":"Base Sepolia","methods":["eip3009"],"breakerState":"CLOSED"}
  ],
  "methods":["eip3009"]
}
```

**4 cadenas activas** (eip155:2368 Kite, 43113 Fuji, 43114 Avalanche, 84532 Base Sepolia).
Todos los breakers en CLOSED. La infra prod esta lista para recibir settle outbound en Base Sepolia
post-merge + seed del agente base-sepolia invocable.

### 1.3 Scope drift check

`git diff --name-only main..feat/095-wkh-113-discovery-chain-dynamic` produce exactamente:

```
doc/sdd/095-wkh-113-discovery-chain-dynamic/auto-blindaje.md
src/services/compose.chain-flow.test.ts
src/services/compose.ts
src/services/discovery.test.ts
src/services/discovery.ts
```

5 archivos: los 4 del Scope IN + auto-blindaje.md (doc F3, no es codigo). Cero archivos
fuera de scope. CD-6 verificado: no se toco chain-resolver.ts, downstream-payment.ts,
adapters, middleware, ni wasiai-v2.

### 1.4 Eliminacion de ALLOWED_CHAIN_VALUES

`grep -rn "ALLOWED_CHAIN_VALUES" src/` → solo menciones en COMENTARIOS de test:
- `src/services/discovery.test.ts:279` (comentario historico)
- `src/services/discovery.test.ts:328` (comentario historico)

Zero presencia en codigo de produccion (`discovery.ts`): verificado — `grep` retorna exit 1
(no found) sobre `discovery.ts`. CD-1/CD-9 satisfechos.

---

## 2. AC Verification

| AC | Texto (EARS) | Status | Evidencia |
|----|-------------|--------|-----------|
| AC-1 | Validacion dinamica sin allowlist: `normalizeChainSlug` acepta base-sepolia, avalanche-fuji, chainId 84532 | PASS | `discovery.ts:93` (`if (normalizeChainSlug(chainRaw) === undefined)`); T-AC1a `discovery.test.ts:349` (base-sepolia); T-AC1b `discovery.test.ts:359` (avalanche-fuji + '84532'); T-AC1-discover `discovery.test.ts:420` (e2e discover) |
| AC-2 | Cero regresion avalanche/kite: `readPayment('avalanche')` → 'avalanche' (NO 'avalanche-fuji'); kite pass-through | PASS | `discovery.ts:100-103` (collapse avalanche-testnet/-mainnet → 'avalanche'); T-AC2a `discovery.test.ts:376` afirma `.toBe('avalanche')` y `.not.toBe('avalanche-fuji')`; T-AC2b `discovery.test.ts:398` (kite-ozone-testnet pass-through); suite 1059/1059 verde |
| AC-3 | Chain real Base llega a compose: resolveAgent hidrata payment.chain desde discover → base-sepolia sobrevive hasta el borde del settle | PASS | `compose.ts:348-352` (hidratacion); T-AC3-flow #1 `compose.chain-flow.test.ts:108` afirma `agent.payment.chain === 'base-sepolia'`; T-AC3-flow #2 (settle border) `compose.chain-flow.test.ts:145`: `mockDownstream.mock.calls[0][0].payment.chain === 'base-sepolia'` |
| AC-4 | Settle outbound real Base: unit/integration PASS; tx onchain live = PENDING-RUNTIME | PASS (unit) + PENDING-RUNTIME | Unit: 1059/1059 verde, T-AC3-flow settle border PASS. Facilitator prod eip155:84532 CLOSED. Live tx requiere: (1) seed agente base-sepolia invocable en registry prod, (2) operator funded en Base Sepolia, (3) gateway deployado post-merge. Ver §3 smoke checklist. NO es FAIL. |
| AC-5 | Chain desconocida → rechazo: polygon/solana → readPayment undefined. Defensa SEC-AR preservada | PASS | `discovery.ts:93` (guard dinamico); T-AC5 `discovery.test.ts:406`: polygon → `agent.payment` undefined, solana → `agent.payment` undefined; AR SEC-1 confirma 15/15 chains exoticas rechazadas |
| AC-6 | Coherencia end-to-end: mismo chainKey discovery→compose→downstream | PASS | `compose.ts:352` (`agent.payment = real.payment` — adopta payment COMPLETO, no solo chain); CR OK-8: chain+contract+asset+method de la misma fuente; T-AC3-flow settle border `compose.chain-flow.test.ts:182` confirma coherencia hasta `signAndSettleDownstream` |
| AC-7 | avalanche-fuji habilitado y seguro: agente avalanche-fuji ahora con payment, rutea a adapter Fuji | PASS | `discovery.ts:93` (normalizeChainSlug acepta 'avalanche-fuji' → ChainKey 'avalanche-fuji'); T-AC7 `discovery.test.ts:444`: `agents[0].payment` definido, `.chain === 'avalanche-fuji'`; Facilitator prod eip155:43113 Avalanche Fuji CLOSED |

---

## 3. Drift Detection

**Scope drift**: ninguno. 4 archivos Scope IN + auto-blindaje doc (permitido). 0 archivos fuera.
**Wave drift**: W0 (baseline) → W1 (discovery) → W2 (compose) respetados segun commits.
**Spec drift**: spot-check `readPayment` (discovery.ts:62-111) vs SDD CD-1/CD-7/CD-9 — match exacto. `resolveAgent` (compose.ts:328-355) vs SDD CD-5/CD-8/CD-10 — match exacto.
**Test drift**: todos los tests especificados en story-file existen (T-AC1a/b, T-AC2a/b, T-AC5, T-AC7, T-AC1-discover, T-AC3-flow x2, T-CD8a/b, T-CD10) con asserts concretos.
**Drift**: none.

---

## 4. Gate Confirmation (de CR report — no re-ejecutados)

Gates confirmados por CR report (`cr-report.md §1`):
- `npm test`: 1059 passed / 1059 (72 files) — **PASS**
- `npx tsc -p tsconfig.build.json --noEmit`: EXIT 0 — **PASS**

Re-ejecutados por QA como confirmacion independiente: mismos resultados (1059/1059, EXIT 0).

---

## 5. AR/CR Follow-up

| Finding | Severidad | Estado |
|---------|-----------|--------|
| PERF-1 (extra discover, 1 por resolveAgent via getAgent) | MENOR | Aceptado en SDD §4.3 + §7 (Riesgo B/B). Circuit-breaker ya cachea registry. No bloquea. |
| XCHAIN-1 (slug-match cross-registry sin filtrar por registry pin) | MENOR | Backlog (requiere colision slug cross-registry + chains distintas, baja prob. config canonica). No bloquea. |
| CR MNR-1 (scaffolding redundante en T-AC3-flow settle border: getEnabled/mockFetchOk) | MENOR | Cosmético. Test pasa y afirma correctamente. No bloquea. Ver `compose.chain-flow.test.ts:146,173`. |

**0 BLOQUEANTES** en AR + CR. Los 3 MNR son aceptados o backlog — no condicionan DONE.

---

## 6. Smoke Checklist — AC-4 live (para el operador post-merge)

AC-4 (tx onchain real en Base Sepolia) requiere infra post-merge que no existe hoy:

```
## Post-merge: AC-4 E2E Live (operador)

Pre-requisitos:
  [ ] 1. Deployer del agente target en Base Sepolia: PENDING (seed agente base-sepolia invocable en registry prod)
  [ ] 2. Operator funded: billetera de gateway con USDC en Base Sepolia (eip155:84532)
  [ ] 3. Gateway prod deployado con el branch mergeado

Pasos:
  1. POST https://api.wasiai.com/compose
     { "steps": [{ "agent": "<slug-agente-base-sepolia>", "input": { "q": "test" } }] }
     Header: x-a2a-key: <valid-key>
  2. Verificar response: success:true, txHash != null
  3. Verificar txHash en Basescan (https://sepolia.basescan.org/tx/<txHash>)
  4. Confirmar en DB: events_log WHERE type='downstream_settle' AND chain='base-sepolia'

Facilitator prod: eip155:84532 Base Sepolia ya CLOSED (listo para recibir settle).
Bloqueante restante: seed agente + operator funded — no son codigo, son operacion.
```

---

## 7. Veredicto

**APROBADO PARA DONE**

- AC-1: PASS (evidencia discovery.ts:93 + 3 tests)
- AC-2: PASS (evidencia discovery.ts:100-103 + T-AC2a/b con `.not.toBe('avalanche-fuji')`)
- AC-3: PASS (evidencia compose.ts:348-352 + T-AC3-flow x2 incluyendo settle border)
- AC-4: PASS unit + PENDING-RUNTIME (esperado — requiere seed agente post-merge, no es FAIL)
- AC-5: PASS (evidencia discovery.ts:93 + T-AC5)
- AC-6: PASS (evidencia compose.ts:352 + T-AC3-flow settle border)
- AC-7: PASS (evidencia discovery.ts:93 + T-AC7)
- Gates: 1059/1059, tsc EXIT 0
- Drift: none
- Facilitator prod: 4 chains CLOSED (eip155:84532 Base Sepolia listo)
- BLQ: 0 (AR 0, CR 0, QA 0)

