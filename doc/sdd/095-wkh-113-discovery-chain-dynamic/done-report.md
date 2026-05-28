# Report — HU [WKH-113] [BASE-08] discovery chain validation dinamica + compose chain-flow

## Resumen ejecutivo

WKH-113 cierra el ultimo tramo del epic BASE port (WKH-103): elimina los dos gates upstream que bloqueaban el outbound downstream en Base Sepolia y Avalanche Fuji. `ALLOWED_CHAIN_VALUES` (Set hardcodeado) reemplazado por validacion dinamica via `normalizeChainSlug`; `resolveAgent` en compose hidrata el payment real desde el path capabilities (no getAgent). Pipeline QUALITY completo ejecutado: 7/7 ACs PASS (AC-4 unit PASS + live PENDING-RUNTIME, clasificacion esperada); 1059/1059 tests, tsc EXIT 0, 0 BLOQUEANTES en AR + CR + QA. Status: **DONE**.

Archivos clave: `src/services/discovery.ts`, `src/services/compose.ts`, `src/services/discovery.test.ts` (+7 tests), `src/services/compose.chain-flow.test.ts` (nuevo, +5 tests).

---

## Pipeline ejecutado

| Fase | Artefacto | Veredicto / Fecha |
|------|-----------|-------------------|
| F0 | Codebase grounding (hallazgos H14/H15 — gap WKH-112 + getAgent hardcode avalanche) | 2026-05-27 |
| F1 | `work-item.md` — HU_APPROVED | 2026-05-27 |
| F2 | `sdd.md` — SPEC_APPROVED | 2026-05-27 |
| F2.5 | `story-file.md` — generado post-SPEC_APPROVED | 2026-05-27 |
| F3 | Implementacion en 3 waves (W0 baseline, W1 discovery, W2 compose) — 3 commits, 4 archivos | 2026-05-27 |
| AR | `ar-report.md` — APROBADO (0 BLQ, 2 MENOR: PERF-1 + XCHAIN-1) | 2026-05-27 |
| CR | `cr-report.md` — APROBADO CON OBSERVACIONES (0 BLQ, 1 MENOR: MNR-1) | 2026-05-27 |
| F4 | `qa-report.md` — APROBADO PARA DONE (7/7 ACs; gates 1059/1059 + tsc EXIT 0) | 2026-05-27 |
| DONE | `done-report.md` | 2026-05-27 |

---

## Acceptance Criteria — resultado final

| AC | Texto resumido | Status | Evidencia |
|----|---------------|--------|-----------|
| AC-1 | Validacion dinamica sin allowlist: base-sepolia, avalanche-fuji, chainId 84532 aceptados | PASS | `discovery.ts:93`; T-AC1a `discovery.test.ts:349`; T-AC1b `discovery.test.ts:359`; T-AC1-discover `discovery.test.ts:420` |
| AC-2 | Cero regresion avalanche/kite: `readPayment('avalanche')` -> 'avalanche' (NO 'avalanche-fuji') | PASS | `discovery.ts:100-103` (collapse intacto); T-AC2a `discovery.test.ts:376` (`.toBe('avalanche')` + `.not.toBe('avalanche-fuji')`); T-AC2b `discovery.test.ts:398` (kite pass-through) |
| AC-3 | Chain real Base llega a compose: resolveAgent hidrata payment.chain desde discover -> base-sepolia sobrevive hasta borde del settle | PASS | `compose.ts:348-352`; T-AC3-flow #1 `compose.chain-flow.test.ts:108`; T-AC3-flow #2 settle border `compose.chain-flow.test.ts:145` (`payment.chain === 'base-sepolia'`) |
| AC-4 | Settle outbound real Base Sepolia | PASS (unit) + PENDING-RUNTIME | 1059/1059 verde; T-AC3-flow settle border PASS; facilitator prod eip155:84532 CLOSED; tx live requiere seed agente + operator funded post-merge (ver Pending post-merge) |
| AC-5 | Chain desconocida rechazada: polygon/solana -> readPayment undefined; defensa SEC-AR preservada | PASS | `discovery.ts:93` (guard dinamico); T-AC5 `discovery.test.ts:406`; AR SEC-1: 15/15 chains exoticas rechazadas |
| AC-6 | Coherencia end-to-end: chain+contract+asset+method de la misma fuente | PASS | `compose.ts:352` (adopta payment COMPLETO); CR OK-8; T-AC3-flow settle border `compose.chain-flow.test.ts:182` |
| AC-7 | avalanche-fuji habilitado y seguro: agente avalanche-fuji ahora con payment | PASS | `discovery.ts:93` (normalizeChainSlug acepta 'avalanche-fuji'); T-AC7 `discovery.test.ts:444`; facilitator prod eip155:43113 CLOSED |

---

## Hallazgos finales

### BLOQUEANTES: 0 (AR 0 + CR 0 + QA 0)

### MENORES: 3 aceptados / backlog

| ID | Origen | Descripcion | Disposicion |
|----|--------|-------------|-------------|
| PERF-1 | AR | La hidratacion agrega 1 `discover({limit:50})` extra por `resolveAgent` resuelto via getAgent. Circuit-breaker cachea el registry; aceptado en SDD §4.3 + §7 (Riesgo B/B). | Aceptado. Mejora futura: cachear `discover()` a nivel de `compose()` para reusar entre steps del mismo request. |
| XCHAIN-1 | AR | El merge en `resolveAgent` matchea por slug ignorando el registry pin. Si dos registries tienen el mismo slug con chains distintas, `.find()` puede adoptar el payment de la registry equivocada. Baja probabilidad en config canonica actual. | Backlog hardening: filtrar `.find((a) => a.slug === agent.slug && a.registry === agent.registry)`. Ver TD-XCHAIN-1. |
| CR-MNR-1 | CR | Scaffolding redundante en T-AC3-flow settle border: `getEnabled`/`mockFetchOk` seteados aunque `discoveryService` esta mockeado. Test pasa y afirma correctamente. | Cosmetico. Opcional en proxima HU que toque compose.chain-flow.test.ts. |

---

## Auto-Blindaje consolidado

> Fuente: `auto-blindaje.md` — sin errores en F3. Las 3 waves pasaron en el primer intento.

### Factores que evitaron errores

| Leccion | Contexto | Regla para futuras HUs |
|---------|----------|------------------------|
| **CD-7: separar validacion de salida en readPayment** | `normalizeChainSlug('avalanche')` retorna `'avalanche-fuji'` (ChainKey); el Story File documentó explicitamente que la validacion (`=== undefined`) y la normalizacion de salida (string legacy, bloque `:97-103`) deben permanecer SEPARADAS. No se toco el collapse. | Si una HU futura toca `readPayment` o `resolveAgent`: releer CD-7 ANTES de tocar la normalizacion de salida. Nunca usar el retorno de `normalizeChainSlug` como el `chain` del `AgentPaymentSpec`. |
| **CD-11: mock discovery completo en test nuevo** | `compose.chain-flow.test.ts` exporto `getAgent` + `discover` desde el inicio, copiando el patron verificado de `compose.test.ts:29-31`. | Cualquier test que ejercite `resolveAgent` debe mockear el modulo `./discovery.js` con AMBOS exports (`getAgent` + `discover`). Grep post-cambio confirma cero mocks rotos. |
| **CD-8: no-op merge verificado por referencia de objeto** | La condicion `real.payment.chain !== agent.payment?.chain` garantiza no-op para Avalanche/Kite. T-CD8a/b usan `toBe()` sobre la referencia del objeto (no solo el valor de chain) para detectar cualquier mutacion. | Tests de no-op en merges de objetos deben usar `toBe()` (identidad de referencia), no solo `toEqual()` (valor). |
| **Gap de scoping WKH-112 cerrado** | WKH-112 mockeaba `agent.payment` directamente: sus tests no ejercitaban el path discovery → compose → downstream. T-AC3-flow de esta HU simula la divergencia real (getAgent → avalanche, discover → base-sepolia) y captura el payment en el borde del settle. | En HUs sobre outbound downstream: los integration tests DEBEN exercitar el path completo discovery→resolveAgent→signAndSettleDownstream. No mockear `agent.payment` prefabricado si el objetivo es validar que la chain llega intacta al settle. |

---

## Archivos modificados

### Produccion (Scope IN)

| Archivo | Cambio |
|---------|--------|
| `src/services/discovery.ts` | `ALLOWED_CHAIN_VALUES` (Set hardcodeado, `:56-63`) eliminado. `readPayment` valida via `normalizeChainSlug(chainRaw) === undefined` (`:93`). Colapso de salida (`avalanche-testnet/-mainnet` → `'avalanche'`, `:100-103`) preservado intacto. JSDoc SEC-AR actualizado (`:38-61`). |
| `src/services/compose.ts` | `resolveAgent` (`:328-355`): hidratacion de `payment` desde `discover()` cuando difiere de `getAgent`. Merge adopta payment COMPLETO. No-op cuando concuerdan (CD-8). Fail-soft si discover no trae el agente (CD-10). Sin doble llamada cuando el agente vino del fallback (rama `:337-342`). |

### Tests (Scope IN)

| Archivo | Cambio |
|---------|--------|
| `src/services/discovery.test.ts` | +7 tests nuevos (`:326-465`): T-AC1a (base-sepolia), T-AC1b (avalanche-fuji + chainId 84532), T-AC2a (avalanche* → 'avalanche', `.not.toBe('avalanche-fuji')`), T-AC2b (kite pass-through), T-AC5 (polygon/solana → undefined), T-AC1-discover (e2e discover), T-AC7 (avalanche-fuji habilitado). |
| `src/services/compose.chain-flow.test.ts` | Nuevo archivo (279 lineas): T-AC3-flow x2 (divergencia real + settle border), T-CD8a/b (no-op merge Avalanche/Kite via referencia), T-CD10 (fail-soft). |

### Docs

| Archivo | Cambio |
|---------|--------|
| `doc/sdd/095-wkh-113-discovery-chain-dynamic/auto-blindaje.md` | F3 clean run documentado (commit 8a79192). |

### Commits del branch

| Hash | Mensaje |
|------|---------|
| `2f3f43d` | feat(WKH-113): discovery dynamic chain validation via normalizeChainSlug |
| `6ba33b0` | feat(WKH-113): compose resolveAgent hydrates real chain from discover |
| `8a79192` | docs(WKH-113): auto-blindaje — clean F3 run, zero corrections |

---

## Decisiones clave

| ID | Decision | Razon |
|----|----------|-------|
| DT-1 | Merge selectivo desde `discover()`, no reescritura de getAgent | El endpoint getAgent en wasiai-v2 hardcodea chain=avalanche (H14). Modificar wasiai-v2 es Scope OUT (CD-6). La solucion a2a-only es hidratar desde el path capabilities que si emite la chain real (H15). |
| DT-4 | Resolver puro (`normalizeChainSlug`) para validacion, no `getInitializedChainKeys()` | `getInitializedChainKeys()` es mutable en runtime (puede fallar si un adapter no inicializa). El resolver deriva del registro estatico de slugs → determinista, testeable sin mocks de infra. |
| CD-7 | Preservar string de salida — no devolver ChainKey | `normalizeChainSlug('avalanche')` retorna `'avalanche-fuji'`. Si se usara su retorno como `chain` de salida, se romperia el downstream (WKH-112 espera el string legacy). Validacion y normalizacion de salida son responsabilidades separadas. |
| DT-3 | payTo preservado = marketplace contract (TD-WKH-113-01) | El `payTo` per-agente requiere que wasiai-v2 exponga el wallet per-row. Es mejora, no bloqueante para el flujo multi-chain. Documentado como sub-tarea wasiai-v2. |

---

## Decisiones diferidas a backlog

| Ticket | Descripcion | Origen |
|--------|-------------|--------|
| TD-WKH-113-01 | payTo per-agente en compose: cada agente cobra en su propio wallet (hoy va al marketplace contract). Requiere que wasiai-v2 `getAgent`/`capabilities` exponga el campo wallet per-row + sub-tarea wasiai-v2. | DT-3 del SDD. Mejora, no bloqueante. |
| TD-XCHAIN-1 | Slug+registry match en `resolveAgent`: filtrar `.find((a) => a.slug === agent.slug && a.registry === agent.registry)` para preservar el registry pin del `getAgent` ante colision de slug cross-registry. | XCHAIN-1 del AR. Baja probabilidad en config canonica actual. |

---

## Pending post-merge explicito

Los siguientes puntos son operacionales (no codigo) y deben ejecutarse post-merge para completar AC-4 live:

1. **Evidencia onchain outbound en Base Sepolia via /compose (AC-4 live)**: requiere seed de un agente base-sepolia invocable en registry prod (wasiai-v2), billetera operator funded con USDC en eip155:84532, y gateway prod deployado con el branch mergeado. Pasos: `POST /compose` con `steps:[{agent:"<slug-base-sepolia>"}]` → verificar txHash en Basescan (`https://sepolia.basescan.org/tx/<txHash>`) → confirmar en DB (`events_log WHERE type='downstream_settle' AND chain='base-sepolia'`).
2. **Seed agente base-sepolia invocable en wasiai-v2**: prerequisito para el punto anterior. No es codigo de este repo.
3. **Sub-tarea wasiai-v2 para getAgent chain-real + payTo per-agente**: mejora al endpoint v2 para que exponga chain real y wallet por fila (TD-WKH-113-01). No bloquea el flujo multi-chain ya habilitado por esta HU.

El facilitator prod ya esta listo: `eip155:84532` Base Sepolia en estado CLOSED (confirmado en QA §1.2).

---

## Lecciones para proximas HUs

1. **Separar validacion de normalizacion de salida**: cuando una funcion usa un resolver para validar (`normalizeChainSlug === undefined`) y tambien tiene logica de normalizacion de salida (colapso de strings legados), mantenerlas como bloques separados desde el primer edit. El Story File debe documentar explicitamente si el retorno del resolver NO debe usarse como output.

2. **Integration tests que ejercitan el path completo**: el gap de WKH-112 mostro que mockear `agent.payment` prefabricado en tests de compose ocultaba el problema real (la chain nunca llegaba intacta). En HUs sobre outbound downstream, los tests de compose deben simular la divergencia real (getAgent vs discover) y capturar el valor en el borde del settle, no solo verificar que el modulo downstream recibe algo.

3. **Mock de discovery debe exportar getAgent + discover juntos**: cualquier test que ejercite `resolveAgent` (que tiene dos ramas: getAgent + hidratacion via discover) debe mockear ambos exports del modulo `./discovery.js`. Un mock parcial hace invisible la rama de hidratacion.

4. **XCHAIN-1: slug-match en merges cross-registry**: cuando se hace un `.find()` sobre resultados aplanados de multiples registries, el criterio de match debe incluir el registry de origen para preservar el pin del caller. El slug solo no es suficiente en entornos multi-registry.
