# Report Final — WKH-29 Gasless EIP-3009 (DONE)

| Campo | Valor |
|-------|-------|
| HU | WKH-29 |
| Branch | `feat/018-gasless-aa` |
| Fecha inicio | 2026-04-05 |
| Fecha cierre | 2026-04-06 |
| Tipo | feature (hackathon bonus) |
| Sizing | S (~100 LOC lib + ~40 LOC route + ~80 LOC tests + ~15 LOC tipos) |
| Mode | QUALITY |
| Epic | WKH-4 (Sprint 4 — Polish + Diferenciadores) |

---

## Goal

Agregar soporte gasless (EIP-3009 `TransferWithAuthorization`) para transfers de PYUSD en Kite Testnet (chain 2368) via el relayer `https://gasless.gokite.ai/testnet`, reusando el patrón viem EIP-712 ya consolidado en `src/lib/x402-signer.ts`, con feature flag `GASLESS_ENABLED` opt-in y módulo completamente aislado del middleware x402 existente.

---

## Pipeline ejecutado

| Fase | Fecha aprox | Veredicto |
|------|-------------|-----------|
| F0 Codebase Grounding | 2026-04-05 | OK — 12 archivos leídos, patrones verificados, drift documental registrado |
| F1 Work Item + ACs EARS | 2026-04-05 | HU_APPROVED — 7 ACs en EARS, scope IN/OUT, DT-1..DT-8, CD-1..CD-9 |
| F2 SDD + Constraint Directives | 2026-04-06 | SPEC_APPROVED — diseño técnico completo, anti-hallucination checklist, plan de waves |
| F2.5 Story File | 2026-04-06 | OK — generado post-SPEC_APPROVED, pre-flight checks incluidos |
| F3 Implementación (Wave 0+1+2) | 2026-04-06 | ENTREGADO — 6 archivos creados/modificados |
| AR v1 | 2026-04-06 | BLOQUEANTE — 3 bloqueantes (H-4, H-5, H-19): v=NaN, hexToSignature import riesgo, test de humo |
| F3 Fix | 2026-04-06 | OK — parseSignature, derivación yParity→v, tests con recovery criptográfico real |
| AR v2 | 2026-04-06 | OK — 3 BLOQUEANTES cerrados con evidencia archivo:línea, 112/112 tests PASS |
| CR | 2026-04-06 | MENOR — 0 bloqueantes, 2 MENOR (CR-3.3, CR-4.6), 3 NIT. Apto para F4 |
| F4 QA | 2026-04-06 | PASS — 6/7 ACs PASS, 1 PARTIAL (AC-5, deuda trazada), 9/9 CDs cumplidos |
| DONE | 2026-04-06 | Cierre — report + _INDEX.md + commit + push |

---

## Resumen ejecutivo

WKH-29 implementó el módulo gasless (EIP-3009) para transfers de PYUSD en Kite Testnet vía el relayer oficial `gasless.gokite.ai`. Se creó `src/lib/gasless-signer.ts` con patrón lazy singleton idéntico a `x402-signer.ts`, usando `parseSignature` de viem 2.47.6 para descomponer v/r/s. El módulo es opt-in (`GASLESS_ENABLED=false`) y completamente aislado del path x402. La ruta `GET /gasless/status` expone estado del módulo sin revelar la private key. El AR v1 detectó un bug crítico: `hexToSignature(...).v` puede ser `undefined` en viem 2.x, y el test original usaba `typeof === 'number'` (que pasa con NaN). El F3 fix migró a `parseSignature` con derivación explícita `yParity + 27` y reemplazó los tests de humo por verificación criptográfica real con `recoverTypedDataAddress`. Suite final: 112/112 tests, typecheck limpio, 0 ethers, todos los CDs cumplidos. Mainnet (USDC.e, chain 2366) y la integración profunda gasless↔x402 quedan diferidos a WKH-33 post-hackathon.

---

## Archivos creados/modificados

| Archivo | Acción | LOC aprox |
|---------|--------|-----------|
| `src/lib/gasless-signer.ts` | CREADO | 310 |
| `src/lib/gasless-signer.test.ts` | CREADO | 285 |
| `src/routes/gasless.ts` | CREADO | 25 |
| `src/types/index.ts` | MODIFICADO | +37 (sección GASLESS TYPES L405-441) |
| `src/index.ts` | MODIFICADO | +5 (import L20 + registro condicional L59-62) |
| `.env.example` | MODIFICADO | +6 (bloque Gasless L38-44) |
| `doc/sdd/018-gasless-aa/work-item.md` | CREADO | ~310 |
| `doc/sdd/018-gasless-aa/sdd.md` | CREADO | ~558 |
| `doc/sdd/018-gasless-aa/story-file.md` | CREADO | ~200 |
| `doc/sdd/018-gasless-aa/ar-report.md` | CREADO | ~377 (v1 + v2) |
| `doc/sdd/018-gasless-aa/cr-report.md` | CREADO | ~231 |
| `doc/sdd/018-gasless-aa/validation.md` | CREADO | ~365 |
| `doc/sdd/018-gasless-aa/report.md` | CREADO | este archivo |
| `doc/sdd/_INDEX.md` | MODIFICADO | +1 fila |

---

## Decisiones clave

| # | Decisión | Justificación |
|---|----------|---------------|
| DT-1 | EIP-3009 relayer en vez de gokite-aa-sdk | Evita ethers.js; reusa patrón EIP-712 viem existente |
| DT-2 | Módulo `gasless-signer.ts` separado de `x402-signer.ts` | Responsabilidades distintas: x402 firma authorizations, gasless firma TransferWithAuthorization |
| DT-3 | `GASLESS_ENABLED` default `false` | Opt-in; no rompe funcionalidad existente |
| DT-4 | `validAfter = block.timestamp - 1` | EIP-3009: garantiza validez en el próximo bloque |
| DT-5 | `parseSignature()` de viem (post-AR: reemplaza `hexToSignature`) | Canónico viem 2.47.6; `hexToSignature` es alias deprecado potencialmente ausente en futuras versiones |
| DT-6 | Cache de `/supported_tokens` en memoria | Evita query en cada transfer; TTL = vida del proceso |
| DT-7 | Testnet only en esta iteración | Mainnet requiere chain definition adicional + PublicClient dinámico → WKH-33 |
| DT-8 | Paths gasless y x402 independientes | En testnet usan tokens distintos (PYUSD vs Test USDT) |
| DT-9 | Lazy singleton WalletClient (no top-level await) | Si `GASLESS_ENABLED=false`, el módulo nunca carga ni valida `OPERATOR_PRIVATE_KEY` |
| DT-10 | `_tokenCache` reseteado en `_resetGaslessSigner()` | Extiende el patrón x402-signer; necesario para tests con estado limpio |
| DT-AR-FIX | `yParity + 27` fallback cuando `parsed.v === undefined` | `parseSignature` garantiza `yParity ∈ {0,1}` siempre; el fallback convierte a `v ∈ {27,28}` EIP-155 compatible |

---

## Auto-Blindaje — Lecciones del ciclo F3 → AR (BLOQ) → F3 fix → AR v2

### Error detectado: tests de humo enmascararon bug crítico

El AR v1 identificó que `hexToSignature()` en viem 2.x devuelve `{ r, s, yParity, v? }` donde `v` es **opcional**. El código original hacía `Number(v)` directamente — si `v` es `undefined`, `Number(undefined) === NaN`. El test original usaba:

```ts
expect(typeof r.v).toBe('number')
```

`typeof NaN === 'number'` devuelve `true`. El test pasaba con el bug activo. El payload enviado al relayer tendría `"v": NaN` → `JSON.stringify` serializa NaN como `null` → el smart contract PYUSD haría `ecrecover` con v=0 → signer incorrecto → transferencia rechazada on-chain. **El happy path no funcionaba y el test no lo detectaba.**

### Fix aplicado en F3

1. Migración a `parseSignature` (canónico viem 2.47.6) con derivación explícita:
   ```ts
   const parsed = parseSignature(signature)
   const v = parsed.v !== undefined ? Number(parsed.v) : Number(parsed.yParity) + 27
   ```
2. Tests reescritos con verificación criptográfica real:
   ```ts
   expect(Number.isFinite(r.v)).toBe(true)
   expect([27, 28]).toContain(r.v)
   // + recoverTypedDataAddress() → compara contra privateKeyToAccount(TEST_PK).address
   ```

### Regla a aplicar en futuras integraciones EIP-712

**Todo test de firma EIP-712/EIP-3009 debe recuperar la address del signer.** `typeof === 'number'` no es suficiente para `v`. La verificación mínima es:
- `Number.isFinite(v)` — descarta NaN/Infinity
- `[27, 28].includes(v)` — descarta valores fuera de rango EIP-155
- `recoverTypedDataAddress(typedData, signature)` — verifica criptográficamente que la firma pertenece al signer esperado

Esta regla aplica a cualquier futura integración con `signTypedData` de viem u otras librerías: **el smoke test de forma no es suficiente; se requiere recovery criptográfico.**

---

## Métricas

| Métrica | Valor |
|---------|-------|
| Tests añadidos (gasless) | 9 |
| Total tests suite (post-WKH-29) | 112 |
| Test files en suite | 10 |
| Typecheck (`npx tsc --noEmit`) | PASS (exit 0) |
| BLOQUEANTES detectados en AR v1 | 3 (H-4, H-5, H-19) |
| BLOQUEANTES cerrados en AR v2 | 3 |
| Matches `ethers` en `src/` | 0 |
| Matches `any` en archivos gasless | 0 |
| Matches `console.` en archivos gasless | 0 |
| CDs cumplidos | 9/9 |
| ACs PASS en F4 | 6/7 (1 PARTIAL — AC-5) |

---

## Deuda diferida

### Deuda Media/Alta (requiere atención antes de producción o en WKH-33)

| ID | Descripción | Archivo:Línea | Prioridad |
|----|-------------|---------------|-----------|
| CR-4.6 | AC-5 sin test automático — registro condicional de rutas `GET /gasless/status` con `GASLESS_ENABLED=true` | `src/index.ts:59-62` | Media — WKH-33 |
| H-24 (A-2) | POST payload camelCase pendiente de verificación con smoke test real (requiere fondeo de wallet operadora con PYUSD testnet) | `gasless-signer.ts:227-229` (TODO trazado) | Alta — pre-producción |
| H-8 | `validBefore` efectivo ~24s puede ser insuficiente si RPC devuelve bloque cacheado/rezagado | `gasless-signer.ts:179-180` | Media — monitorear post-deploy |

### MENORes residuales del AR v2 (no abordados — no bloqueantes)

`H-2` (sanitizeError truncado vs whitelist), `H-8` (window 24s efectivo), `H-9` (getBlock no captura error), `H-10` (blockTs undefined edge case), `H-12` (sin retry documentado en work-item), `H-16` (non-null assertion client.account!), `H-18` (cast address sin validación regex), `H-20` (sign+submit no integrados en un test), `H-21` (getBlock failure path no testeado), `H-23` (AC-5 sin test — también CR-4.6).

### NITs del CR (cosmético)

`CR-1.5-NIT` (JSDoc residual `hexToSignature`), `CR-4.4-NIT` (fixture `0xdeadbeef` no es 32 bytes), `CR-5.3-NIT` (comentario verbose en routes/gasless.ts).

---

## Próximo paso

**WKH-33** — Gasless mainnet support (USDC.e on Kite Mainnet, chain 2366):
- Agregar `kiteMainnet` chain definition en `src/lib/kite-chain.ts`
- Refactorizar `gasless-signer.ts` para PublicClient/WalletClient network-aware (testnet/mainnet dinámico)
- Switch dinámico de `chainId` en EIP-712 domain
- Cerrar deuda H-24 (smoke test con wallet fondeada)
- Cerrar deuda CR-4.6 (test automático de registro condicional)
- Jira: [WKH-33](https://ferrosasfp.atlassian.net/browse/WKH-33)

---

## Referencias

| Artefacto | Path |
|-----------|------|
| Work Item (HU + ACs EARS) | `doc/sdd/018-gasless-aa/work-item.md` |
| SDD (diseño técnico) | `doc/sdd/018-gasless-aa/sdd.md` |
| Story File (pre-flight + waves) | `doc/sdd/018-gasless-aa/story-file.md` |
| AR v1 + AR v2 | `doc/sdd/018-gasless-aa/ar-report.md` |
| Code Review | `doc/sdd/018-gasless-aa/cr-report.md` |
| Validation F4 | `doc/sdd/018-gasless-aa/validation.md` |
| Exemplar EIP-712 | `src/lib/x402-signer.ts` |
| Exemplar Fastify route | `src/routes/dashboard.ts` |
| Chain definition | `src/lib/kite-chain.ts` |
| Kite Gasless docs | https://docs.gokite.ai/kite-chain/stablecoin-gasless-transfer |
| Jira post-hackathon | https://ferrosasfp.atlassian.net/browse/WKH-33 |

---

*Generado: 2026-04-06 | Docs DONE | report.md final*
