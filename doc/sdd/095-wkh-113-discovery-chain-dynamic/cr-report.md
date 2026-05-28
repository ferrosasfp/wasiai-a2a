# Code Review (CR) — WKH-113 [BASE-08] discovery chain validation dinámica + compose chain-flow

> Revisor: nexus-adversary (CR / calidad)
> Fecha: 2026-05-27
> Branch: `feat/095-wkh-113-discovery-chain-dynamic` (3 commits)
> Input: SDD §095 (CD-1..CD-11, Test Plan), story-file.md, ar-report previo (no presente → CR enfocado en calidad/patrones)
> Alcance: solo lectura + ejecución de gates. NO se modificó código.

---

## 1. Gates (ejecutados de verdad)

| Gate | Comando | Resultado |
|------|---------|-----------|
| Typecheck autoritativo | `npx tsc -p tsconfig.build.json --noEmit` | **EXIT 0** (0 errores) |
| Suite completa | `npm test` (`vitest run`) | **1059 passed / 1059** · 72 test files · 3.92s |

Coincide con el baseline esperado (~1059). Cero regresión observable.

---

## 2. Tabla de hallazgos

| ID | Severidad | Observación | Evidencia (archivo:línea) | Sugerencia |
|----|-----------|-------------|---------------------------|------------|
| OK-1 | OK | **CD-1 / CD-9** — `ALLOWED_CHAIN_VALUES` borrado por completo; validación deriva de `normalizeChainSlug`. Grep en `src/` no encuentra el `Set` en prod (solo menciones en comentarios de test). | `discovery.ts:93` (`if (normalizeChainSlug(chainRaw) === undefined)`); grep `ALLOWED_CHAIN_VALUES` → solo `discovery.test.ts:279,328` (comentarios) | — |
| OK-2 | OK | **CD-7 / CD-2** — readPayment preserva el string legacy de salida. La normalización `avalanche-testnet/-mainnet → 'avalanche'` quedó INTACTA (`:100-103`); NO se devuelve el `ChainKey`. Separación validación (resolver) vs salida (string) limpia y comentada. | `discovery.ts:100-103` (colapso preservado), `:105-110` (return string), JSDoc `:50-54` (⚠️ Salida CD-7) | — |
| OK-3 | OK | **JSDoc SEC-AR actualizado** — el bloque documenta la validación dinámica (CD-1/CD-9), el invariante de salida (CD-7) y referencia WKH-113 DT-4/DT-5. Legible y fiel al código. | `discovery.ts:38-61` | — |
| OK-4 | OK | **CD-8 merge no-op** — la condición `real.payment.chain !== agent.payment?.chain` evita tocar el agente cuando concuerdan (Avalanche/Kite). Test-afirmado con `toBe(getAgentPayment)` sobre la **referencia** del objeto (no solo el valor). | `compose.ts:351-353`; tests T-CD8a `compose.chain-flow.test.ts:217`, T-CD8b `:250` | — |
| OK-5 | OK | **CD-10 fail-soft** — si `discover()` no trae el agente, `real?.payment?.chain` es falsy → no se cambia nada → se conserva el payment de getAgent. No asume Base, no cross-chain. Test T-CD10 afirma `toBe(getAgentPayment)`. | `compose.ts:351` (guard); test `compose.chain-flow.test.ts:276` | — |
| OK-6 | OK | **Anti doble-llamada a discover()** — cuando el agente se resuelve por el fallback `discover()`, se retorna directo desde esa rama (`return` temprano `:341`) sin re-consultar. La 2ª llamada `:348` solo ocurre cuando vino de `getAgent`. Algoritmo legible, comentado por CD. | `compose.ts:337-342` (rama fallback, return), `:348` (hidratación post-getAgent) | — |
| OK-7 | OK | **CD-7 readPayment NO devuelve ChainKey como chain** — verificado en el return: `chain` es el string legacy/pass-through, nunca el `ChainKey` del resolver. T-AC2a afirma EXPLÍCITAMENTE `avalanche*` → `'avalanche'` y `.not.toBe('avalanche-fuji')`. | `discovery.ts:107` (return chain), test `discovery.test.ts:382,395` (`.not.toBe('avalanche-fuji')`) | — |
| OK-8 | OK | **Coherencia del merge (chain + contract de la misma fuente)** — se reemplaza el `payment` COMPLETO (`agent.payment = real.payment`), no solo `chain`. El `contract`/`asset`/`method` provienen del mismo path real → no se mezcla chain de una fuente con contract de otra. Coherente con CD-5/AC-6. | `compose.ts:352` | — |
| OK-9 | OK | **CD-4 sin `any`/`as unknown`** — cero `any` explícito, `as unknown`, `<any>` en prod ni en el test nuevo. El narrowing `real?.payment?.chain && ...` estrecha el tipo sin casts peligrosos. Los `as \`0x${string}\`` en fixtures de test son casts de literal address (aceptados). | grep `: any\|as unknown\|<any>` en `discovery.ts`/`compose.ts`/`compose.chain-flow.test.ts` → 0 | — |
| OK-10 | OK | **CD-11 mocks completos** — `compose.chain-flow.test.ts:33-35` y `compose.test.ts:29-31` exportan `getAgent`+`discover` (ejercen el `resolveAgent` real). `orchestrate.test.ts:28` mockea `./compose.js` entero → no ejercita resolveAgent (no break point). `agent-price.test.ts` solo `getAgent` → no consume resolveAgent. | grep `vi.mock('./discovery` + inspección de `orchestrate.test.ts:28`, `agent-price.test.ts:8-11` | — |
| OK-11 | OK | **CD-6 sin out-of-scope** — solo los 4 archivos del Scope IN + `auto-blindaje.md`. NO se tocó `chain-resolver.ts`, `registry.ts`, adapters, `downstream-payment.ts`, middleware ni wasiai-v2. | `git diff --name-only` → `compose.ts`, `compose.chain-flow.test.ts`, `discovery.ts`, `discovery.test.ts` | — |
| OK-12 | OK | **Tests discovery (+7) cubren el contrato** — T-AC1a (base-sepolia), T-AC1b (avalanche-fuji + chainId 84532 pass-through), T-AC2a (avalanche*→avalanche, NO fuji), T-AC2b (kite pass-through), T-AC5 (polygon/solana→undefined), T-AC1-discover (e2e discover), T-AC7 (fuji habilitado). Asserts concretos. | `discovery.test.ts:349-464` | — |
| OK-13 | OK | **T-AC3-flow ejerce discovery→compose SIN mockear agent.payment prefabricado** — simula la divergencia real: getAgent→`avalanche`, discover→`base-sepolia`; afirma resolveAgent→`base-sepolia` y captura el `agent` que llega a `signAndSettleDownstream` (`mock.calls[0][0].payment.chain==='base-sepolia'`). Cierra el gap de scoping de WKH-112. | `compose.chain-flow.test.ts:108-183` | — |
| MNR-1 | MENOR | **Scaffolding redundante en T-AC3-flow (settle border)** — el test setea `registryService.getEnabled` (`:146`) y `mockFetchOk()` (`:173`) aunque `discoveryService` está mockeado y el path no consume `getEnabled` para resolver el agente (la resolución viene del mock de `getAgent`/`discover`). No afecta correctitud (el test pasa y afirma lo correcto), solo es ruido leve que puede confundir sobre qué fuente alimenta `resolveAgent`. | `compose.chain-flow.test.ts:146,173` | Opcional: eliminar `getEnabled`/`mockFetchOk` si no son necesarios para que `compose()` complete el step, o un comentario de por qué `compose()` los requiere (fetch del invoke real). NO bloquea. |

**Conteo**: BLOQUEANTE-ALTO=0 · BLOQUEANTE-MEDIO=0 · BLOQUEANTE-BAJO=0 · MENOR=1 · OK=13

---

## 3. Verificación punto por punto del checklist CR

1. **CDs del SDD**: CD-1 (OK-1, sin Set), CD-2 (OK-2/OK-12, regresión nula — suite verde + asserts `:273/:301/:244` intactos), CD-4 (OK-9), CD-7 (OK-2/OK-7), CD-8 (OK-4), CD-9 (OK-1), CD-10 (OK-5), CD-11 (OK-10), CD-6 (OK-11). **Todas verificadas.**
2. **Calidad readPayment**: cambio mínimo (1 línea de check + JSDoc + import). Separación validación/salida correcta y comentada (OK-2/OK-3). JSDoc SEC-AR actualizado fielmente (OK-3).
3. **Calidad merge resolveAgent**: algoritmo legible, comentado por CD; evita doble `discover()` cuando vino del fallback (OK-6); maneja real-not-found fail-soft (OK-5); reemplaza payment COMPLETO de la misma fuente — coherente (OK-8).
4. **Tests sin perder cobertura**: 7 nuevos discovery cubren accept/preserve/reject (OK-12); T-AC2a afirma `avalanche`→`'avalanche'` y `.not.toBe('avalanche-fuji')` (OK-7); T-AC3-flow sin payment prefabricado (OK-13); asserts concretos.
5. **Mocks (CD-11)**: nuevo archivo mockea discovery completo; no rompe otros mocks (OK-10).
6. **Legibilidad/mantenibilidad**: naming claro, comentarios citan CD/DT/Hn de forma trazable.
7. **Gates**: `npm test` = **1059 passed**; `tsc -p tsconfig.build.json --noEmit` = **EXIT 0**. Reales.

---

## 4. Veredicto

### APROBADO CON OBSERVACIONES

- **BLOQUEANTES: 0** (ALTO=0, MEDIO=0, BAJO=0).
- **MENOR: 1** (MNR-1 — scaffolding redundante en un test, no afecta correctitud).

El cambio cumple los 11 Constraint Directives verificables en CR (CD-1/CD-2/CD-4/CD-6/CD-7/CD-8/CD-9/CD-10/CD-11; CD-3/CD-5 no aplican a CR de calidad — CD-5 cubierto por OK-5/OK-8). Implementación mínima, coherente y bien documentada. Gates verdes y reales. **El único hallazgo es MENOR y NO bloquea el gate.** Apto para avanzar a F4 (QA). MNR-1 queda a criterio del Dev/orquestador (entra ahora o backlog).

---

## 5. Resumen al orquestador

CR de WKH-113 [BASE-08] **APROBADO CON OBSERVACIONES** — 0 bloqueantes, 1 MENOR.
Gates reales: `npm test` = 1059/1059 passed (72 files), `tsc -p tsconfig.build.json --noEmit` EXIT 0.
La validación dinámica en `readPayment` borra `ALLOWED_CHAIN_VALUES` y deriva accept/reject de `normalizeChainSlug` (CD-1/CD-9), preservando el string legacy de salida intacto (CD-7: `avalanche*`→`'avalanche'`, resto pass-through) — test T-AC2a afirma explícitamente `.not.toBe('avalanche-fuji')`.
El merge en `resolveAgent` hidrata el `payment` COMPLETO desde el path real (`discover`/capabilities) solo cuando difiere: no-op para Avalanche/Kite (CD-8, afirmado por referencia de objeto), fail-soft si discover no trae el agente (CD-10), sin doble llamada cuando el agente vino del fallback (OK-6). T-AC3-flow ejerce discovery→compose sin mockear `agent.payment` prefabricado y captura la chain en el borde del settle.
Sin `any`/`as unknown` (CD-4), sin tocar archivos fuera de los 4 del Scope IN (CD-6), mocks discovery completos (CD-11). Único MENOR: scaffolding redundante (`getEnabled`/`mockFetchOk`) en el test settle-border — cosmético, no bloquea.
Path del reporte: `doc/sdd/095-wkh-113-discovery-chain-dynamic/cr-report.md`. Recomendación: avanzar a F4 (QA).

---

*CR generado por NexusAgil — Adversary (Code Review) — WKH-113 (BASE-08)*
