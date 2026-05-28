# Adversarial Review (AR) — WKH-113 [BASE-08] discovery chain validation dinámica + compose chain-flow

> Fase: AR (post-F3). Modo: QUALITY. Reviewer: nexus-adversary.
> Branch: `feat/095-wkh-113-discovery-chain-dynamic` (3 commits).
> Diff base: `git diff main..feat/095-wkh-113-discovery-chain-dynamic`.
> Fecha: 2026-05-27.

---

## Alcance del cambio revisado

| Archivo | Líneas clave | Cambio |
|---------|--------------|--------|
| `src/services/discovery.ts` | `:38-60` JSDoc, `:89-95` check, `:97-103` collapse | `ALLOWED_CHAIN_VALUES` (Set) → validación dinámica `normalizeChainSlug(chainRaw) === undefined → reject`. Collapse de salida intacto. |
| `src/services/compose.ts` | `:328-355` `resolveAgent` | Hidratación de `payment` desde `discover()` cuando difiere de `getAgent`. |
| `src/services/discovery.test.ts` | `:326-465` | +141 líneas (T-AC1a/b, T-AC2a/b, T-AC5, T-AC1-discover, T-AC7). |
| `src/services/compose.chain-flow.test.ts` | nuevo (279 líneas) | T-AC3-flow x2, T-CD8a/b, T-CD10. |
| `doc/sdd/.../auto-blindaje.md` | — | doc F3. |

Scope IN respetado al 100% (4 archivos de código + auto-blindaje). Ningún archivo fuera de scope tocado.

---

## Resultado de los Gates (ejecución real)

| Gate | Comando | Resultado |
|------|---------|-----------|
| Test suite | `npm test` (vitest run) | **1059 passed / 1059** (72 files) ✓ |
| Typecheck prod | `tsc -p tsconfig.build.json --noEmit` | **exit 0, 0 errores** ✓ |
| Suite scoped | discovery + chain-flow + compose | 83 passed / 83 ✓ |
| CD-11 grep | mocks de `discovery.js` consumidos por `resolveAgent` | `compose.test.ts:29` y `compose.chain-flow.test.ts:33` exportan `getAgent`+`discover` ✓ |

---

## Tabla de hallazgos (11 categorías)

| ID | Severidad | Categoría | Evidencia (archivo:línea) | Hallazgo / Mitigación |
|----|-----------|-----------|---------------------------|------------------------|
| SEC-1 | **OK** | Security / SEC-AR | `discovery.ts:93` + `chain-resolver.ts:61-66` | Validación dinámica RECHAZA toda chain exótica (`polygon`/`solana`/`ethereum`/`arbitrum`/typos/`""`/`" "`/`1`/`137`/`__proto__`/`constructor`). Repro ejecutado: 15/15 reject confirmados. Prototype pollution cubierto por `Object.hasOwn` sobre record null-proto. Defensa-en-profundidad SEC-AR BLQ-MED-1 preservada. |
| SEC-2 | **OK** | Security | `discovery.ts:85` | El guard de campos críticos (`!methodRaw \|\| !chainRaw \|\| typeof obj.contract !== 'string'`) se conserva intacto ANTES de la validación de chain. No hay bypass de contract/method. |
| CD7-1 | **OK** | Integration / Data Integrity | `discovery.ts:97-103` | **CD-7 PRESERVADO.** El collapse de salida (`avalanche-testnet`/`-mainnet` → `'avalanche'`; resto pass-through) está separado de la validación. `normalizeChainSlug` SOLO decide accept/reject; su retorno (`ChainKey`) NUNCA se usa como `chain` de salida. Repro: `readPayment('avalanche')` → `'avalanche'` (NO `'avalanche-fuji'`). Tests `:179/221/273` verdes + nuevo T-AC2a afirma explícito `.not.toBe('avalanche-fuji')`. |
| ERR-1 | **OK** | Error Handling | `compose.ts:337-354`, `discovery.ts:62-111` | Sin try/catch nuevos. `readPayment` retorna `undefined` (no throw) ante chain desconocida. `resolveAgent` fail-soft (CD-10) cuando `discover` no trae el agente. Sin errores silenciados peligrosos. |
| INT-1 | **OK** | Integration / Backwards compat | `compose.ts:328`, `discovery.ts:62` | Firmas públicas preservadas: `resolveAgent(step) => Promise<Agent\|null>`, `readPayment` sin cambio de firma. Avalanche/Kite byte-idénticos (T-CD8a/b afirman `toBe(getAgentPayment)` sobre la referencia, no solo el valor). CD-2/CD-8 satisfechos. |
| CD8-1 | **OK** | Data Integrity | `compose.ts:351` | Merge no-op confirmado: la condición `real.payment.chain !== agent.payment?.chain` evita tocar `agent.payment` cuando concuerdan. T-CD8a/b verde. |
| MERGE-1 | **OK** | Data Integrity / Cross-chain | `compose.ts:352` | El merge adopta el `payment` **completo** (`agent.payment = real.payment`), no solo la chain. No hay Frankenstein chain-de-uno/contract-de-otro: chain+contract+asset+method siempre vienen de la misma fila. CD-5/CD-10 satisfechos. |
| TS-1 | **OK** | Type Safety | diff completo | Cero `any`/`as unknown`/`as any` introducidos. `let agent` reasignable correcto. Narrowing `real?.payment?.chain &&` garantiza `real.payment` definido en el bloque. CD-4 OK. tsc build 0 errores. |
| TEST-1 | **OK** | Test Coverage | `compose.chain-flow.test.ts`, `discovery.test.ts:326-465` | 11 tests nuevos mapeados 1-a-1 a AC/CD. Negativos cubiertos (T-AC5 reject, T-CD10 fail-soft). T-AC3-flow valida hasta el borde del settle (`mockDownstream.mock.calls[0][0].payment.chain === 'base-sepolia'`), no mockea output prefabricado (lección WKH-112 aplicada). |
| SCOPE-1 | **OK** | Scope Drift | `git diff --name-only` | Solo 4 archivos de código (Scope IN) + auto-blindaje. NO toca wasiai-v2, `downstream-payment.ts`, `adapters/*`, `chain-resolver.ts`, middleware inbound. CD-6 OK. |
| OWN-1 | **OK** | Security / Ownership | diff | No toca `src/services` con queries sobre `a2a_agent_keys`. Cero referencias a `owner_ref`. N/A real (no hay query a la tabla protegida). |
| MIG-1 | **N/A** | Destructive Migrations | — | No hay SQL/migrations en el diff. N/A. |
| RPC-1 | **N/A** | RPC SECURITY DEFINER | — | No hay funciones postgres / RPC nuevas. N/A. |
| CACHE-1 | **N/A** | Cache Invalidation | — | No introduce capa de cache nueva. El circuit-breaker preexistente (no modificado) cachea el registry, pero no es key por user ni se invalida en este cambio. N/A. |
| PERF-1 | **MENOR** | Performance | `compose.ts:348` | La hidratación agrega **1 `discover({limit:50})` por cada `resolveAgent` resuelto vía `getAgent`** (el path feliz). Antes el path feliz hacía 0 discover. `compose` resuelve cada step 2x (loop `:70` + lookahead `:207`), así un compose de M steps pasa de ~0 a ~`2M-1` discover. **Documentado y aceptado en SDD §4.3 + §7 (Riesgo B/B)**: registry ya cacheado por circuit-breaker; el path fallback (rama `:337-342`) reusa su discover sin re-consultar (mitigación aplicada). No bloquea. Sugerencia futura: cachear el resultado de `discover()` a nivel de `compose()` para reusar entre steps del mismo request. |
| XCHAIN-1 | **MENOR** | Data Integrity / Cross-chain | `compose.ts:348-349` | El merge matchea por `a.slug === agent.slug` **ignorando el registry**. `discover()` aplana agentes de TODAS las registries enabled sin dedup de slug (`discovery.ts:151 allAgents = results.flat()`). Si dos registries tienen el mismo slug con chains distintas, el `.find()` puede adoptar el `payment` (chain+contract) del agente de OTRA registry — sobrescribiendo un `getAgent` que se resolvió con `step.registry` pin. **Repro condicional**: registry A (`step.registry`) tiene `kyc@avalanche`, registry B tiene `kyc@base-sepolia`; `getAgent('kyc', 'A')` → avalanche, `discover()` aplana `[kyc@A, kyc@B]`, `.find()` puede devolver el primero; si es B → adopta base-sepolia. El payment queda internamente consistente (full payment, no Frankenstein) pero apunta a OTRO agente. **Por qué MENOR y no BLQ**: (a) requiere colisión de slug cross-registry + chains distintas + estar en top-50; (b) el matching por-slug ya existía en el fallback pre-WKH-113 (no es regresión nueva del path fallback); (c) baja probabilidad en la config canónica actual. Sugerencia: filtrar `.find((a) => a.slug === agent.slug && a.registry === agent.registry)` para preservar el registry pin del `getAgent`. |

---

## Veredicto sobre vectores obligatorios

1. **CD-7 (cero regresión del string de salida)** — ✅ **PRESERVADO**. `readPayment` devuelve `'avalanche'` para `avalanche`/`avalanche-testnet`/`avalanche-mainnet` (NO `'avalanche-fuji'`). Validación y collapse de salida están separados (`discovery.ts:93` vs `:97-103`). Repro ejecutado + T-AC2a afirma `.not.toBe('avalanche-fuji')`.
2. **Defensa SEC-AR BLQ-MED-1 (CD-1/AC-5)** — ✅ **PRESERVADA**. La validación dinámica RECHAZA todas las chains desconocidas (`polygon`/`solana`/typos/numéricos no-mapeados/empty/prototype-pollution). Repro: 15/15 reject. Un registry comprometido NO puede inyectar una chain exótica.
3. **Cross-chain confusion en el merge (CD-5/CD-10)** — adopta payment completo (sin Frankenstein) → seguro en el caso normal. Vector residual XCHAIN-1 (colisión slug cross-registry) → MENOR.
4. **Merge no-op (CD-8/CD-2)** — ✅ Avalanche/Kite byte-idénticos (T-CD8a/b `toBe` sobre referencia).
5. **Fail-soft (CD-10)** — ✅ discover sin el agente → conserva payment de getAgent, NO asume Base (T-CD10).
6. **Doble llamada / DoS** — fallback reusa su discover; hidratación agrega 1 discover en path feliz → MENOR documentado (PERF-1).
7. **Ownership guard** — ✅ no toca `a2a_agent_keys`.
8. **Scope creep** — ✅ 0 archivos fuera de scope.
9. **Gates** — ✅ 1059/1059 tests, tsc build exit 0.

---

## VEREDICTO FINAL: **APROBADO**

- **BLOQUEANTE-ALTO**: 0
- **BLOQUEANTE-MEDIO**: 0
- **BLOQUEANTE-BAJO**: 0
- **MENOR**: 2 (PERF-1 documentado/aceptado en SDD; XCHAIN-1 edge case cross-registry)
- **OK**: 11 categorías sustantivas
- **N/A**: 3 (migrations, RPC, cache — justificadas)

**Total BLOQUEANTEs: 0 → el gate AR PASA.** Los 2 MENOR no bloquean DONE; XCHAIN-1 se recomienda al backlog (filtrar por registry en el `.find()`). PERF-1 ya está aceptado en el SDD.

