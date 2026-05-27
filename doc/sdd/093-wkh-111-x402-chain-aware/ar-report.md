# Adversarial Review (AR) — #093 [WKH-111] [BASE-06] x402 payment path chain-aware

> Agente: nexus-adversary
> Fecha: 2026-05-27
> Branch: `feat/093-wkh-111-x402-chain-aware` (commits `2d90fab`, `6dcf607`)
> Diff vs `main`: `git diff main..feat/093-wkh-111-x402-chain-aware`
> Suite: 1048 tests verdes (1039 baseline + 9 nuevos). `tsc -p tsconfig.build.json --noEmit` limpio.

---

## Evidencia ejecutada

| Verificación | Resultado |
|--------------|-----------|
| `npm test` (full) | **1048 passed / 0 fail** (72 files) — baseline 1039 + 9 nuevos, cero regresión |
| `npm test -- x402.chain-aware.test.ts` | **9 passed / 0 fail** (T-AC1..T-AC5, T-AC3a/b, T-AC4a/b, T-CD9, T-OPTS-AMOUNT) |
| `tsc -p tsconfig.build.json --noEmit` | **exit 0** (typecheck de producción limpio) |
| Prod files cambiados (non-test) | **solo `src/middleware/x402.ts`** (Scope IN) |
| `grep a2a_agent_keys / owner_ref / src/services/` en el diff | **NONE** (no toca capa de ownership) |
| `grep 1e18 fallback en x402.ts` | **NONE** (deriva de `adapter.quote()`) |
| `grep any/as unknown en x402.ts prod` | **NONE** |
| Call-sites `buildX402Response` | 6, todos `await` + `chainKey` (x402.ts:181,190,213,226,246,259); único consumidor = `requirePayment` |

---

## Tabla de hallazgos

| ID | Severidad | Categoría | Descripción | Evidencia archivo:línea | Mitigación |
|----|-----------|-----------|-------------|--------------------------|------------|
| V1 | **OK** | Security / Cross-chain confusion | El cliente NO puede forzar settle en otra chain. El adapter se selecciona SOLO por `chainKey` (header), y el body canónico al facilitator usa `getNetworkTag(this.network)` del adapter — IGNORA `paymentPayload.network`. Un `network` mentido no cambia el ruteo ni el domain EIP-712. | `x402.ts:200,235` (verify/settle reciben `getPaymentAdapter(chainKey)`); `base/payment.ts:239,255,295` (`buildX402CanonicalBody` usa `getNetworkTag(network)` con `network=this.network`); `types.ts:24` (`X402Proof.network` aceptado pero no usado para ruteo). DT-3 confirmado. | — |
| V2 | **OK** | Data Integrity / Decimales dimensional (WKH-67/072) | El `maxAmountRequired` de Base es 6-dec real (`'1000000'`), NO el `1e18` de Kite. Deriva SIEMPRE de `adapter.quote()` de la chain resuelta. No hay path donde el literal 18-dec se cuele para Base. | `x402.ts:67-68` (`opts.amount ?? (await adapter.quote(DEFAULT_AMOUNT_USD)).amountWei`); grep `1e18` en x402.ts → NONE; test T-CD9 (`x402.chain-aware.test.ts:352-379`) afirma `'1000000'` y `!== '1000000000000000000'`. | — |
| V3 | **OK** | Error Handling / Fail-loud (CD-5) | Chain desconocida → 400 `CHAIN_NOT_SUPPORTED` (slug no reconocido) y 400 (slug reconocido pero no inicializado). Ambos sub-casos disparan ANTES de leer `payment-signature`, así que valen tanto para challenge (sin firma) como verify/settle (con firma). Nunca silent default. | `x402.ts:150-175` (resolución + dos guards 400 + guard 500 `REGISTRY_NOT_INITIALIZED`), ubicado en :144-175 ANTES de :177 (`payment-signature`). Tests T-AC4a/T-AC4b (`x402.chain-aware.test.ts:263-317`). | — |
| V4 | **OK** | Integration / Cero regresión Kite (CD-1) | Sin `x-payment-chain`, el path resuelve el default Kite y es byte-idéntico: `eip155:2368` + `'1000000000000000000'`. `quote()` de Kite devuelve exactamente el literal legacy. Los 1039 tests baseline siguen verdes. | Test T-AC3a (`:202-226`), T-AC3b (`:230-259`); suite full 1048 verde; `kite-ozone/payment.ts:330-337` quote → literal legacy. | — |
| V5 | **OK** | Data Integrity / Coherencia de chain (CD-6/AC-5) | Resolución del `chainKey` UNA sola vez al inicio del handler; challenge/verify/settle reusan la misma variable `chainKey`. No hay doble resolución ni ventana de divergencia. | `x402.ts:149` (única `resolveChainKey`); challenge :181, verify :200, settle :235 usan el mismo `chainKey`. Test T-AC5 (`:321-348`) afirma `.every(c => c[0] === 'base-sepolia')`. | — |
| V6 | **OK** | Error Handling / Orden de resolución (CD-10) | La resolución ocurre DESPUÉS del wallet guard (503, :119-129) y del set de `paymentOrigin` (:132-136), y ANTES de leer `payment-signature` (:177). El challenge 402 sin firma también es chain-aware. | `x402.ts:119-129` (wallet guard) → :132-137 (origin+resource) → :144-175 (chain) → :177 (signature). | — |
| V7 | **OK** | Security / Ownership guard (regla del proyecto) | El cambio NO toca `a2a_agent_keys`, `src/services/`, ni introduce queries. No aplica el patrón owner_ref. | `git diff` grep `a2a_agent_keys\|owner_ref\|src/services/` → NONE. Solo `src/middleware/x402.ts` (prod). | — |
| V8 | **OK** | Type Safety (CD-3) | `chainKey` tipado como `ChainKey` (no `string`). Sin `any`/`as unknown` en producción. `tsc` build limpio. | `x402.ts:18` (`import type { ChainKey }`), `:61` (`chainKey: ChainKey`); grep any/as unknown → NONE; tsc exit 0. | — |
| V9 | **OK** | Error Handling / reply.sent guards (ripple async) | Los 5 guards `if (reply.sent) return` (FST_ERR_REP_ALREADY_SENT) se preservaron intactos tras el refactor sync→async. El challenge branch (:178-181) no necesita guard (nada async corre antes que pueda haber enviado reply). | `x402.ts:208,221,241,254,268`. Suite verde confirma cero ripple no resuelto. | — |
| MNR-1 | **MENOR** | Data Integrity / Mismatch payload.network | DT-3/TD-WKH-111-01: no se emite 400 explícito cuando `paymentPayload.network` ≠ header. La defensa es indirecta (firma EIP-712 atada al domain del adapter → `verify.valid=false`). Es una decisión documentada y aceptada en el SDD §4.3/§10; el adapter provee fail-seguro. NO bloquea ningún AC. Documentado como TD candidato. | SDD §4.3 (DT-3), §10 (TD-WKH-111-01); `base/payment.ts:227-248` (body canónico ignora `network` del cliente). | Dejar como TD. Reevaluar 400 explícito en HU futura si se quiere UX más clara; sin impacto de seguridad neto hoy. |

---

## Análisis de los vectores de ataque obligatorios

1. **Cross-chain confusion / chain spoofing** → **CERRADO (OK)**. Probado en código: `verify`/`settle` reciben `getPaymentAdapter(chainKey)` (header), y el body al facilitator se construye con `getNetworkTag(this.network)` del adapter, ignorando `paymentPayload.network`. Un cliente que mienta el `network` del payload no puede seleccionar un bundle distinto ni cambiar el domain EIP-712; produce `verify.valid=false` (fail seguro). No hay path donde `payload.network` seleccione adapter.
2. **Decimales/dimensional** → **CERRADO (OK)**. Base = `'1000000'` (6-dec) derivado de `adapter.quote()`; literal `1e18` eliminado del fallback. T-CD9 lo blinda.
3. **Fail-loud (CD-5)** → **CERRADO (OK)**. 400 en ambos sub-casos (slug desconocido + slug reconocido no inicializado), antes del branch de `payment-signature` → vale para challenge y verify/settle.
4. **Cero regresión Kite (CD-1)** → **CERRADO (OK)**. Path sin header byte-idéntico; 1039 baseline verdes; refactor async no rompió orden ni `reply.sent` guards. Los mocks tocados (e2e/setup.ts, registries.test.ts, passport-shape.test.ts) son extensiones test-only del `vi.mock` del registry (3 funciones nuevas que el middleware ahora consume) — replican el default Kite y NO ocultan regresión de producción (el path prod las llama reales en runtime; el smoke E2E es el oráculo real).
5. **Coherencia de chain (CD-6/AC-5)** → **CERRADO (OK)**. Resolución única; T-AC5 verifica que todas las invocaciones usan `'base-sepolia'`.
6. **Orden de resolución (CD-10)** → **CERRADO (OK)**. Después del wallet guard, antes del payment-signature.
7. **Ownership guard** → **N/A confirmado (OK)**. No toca services ni `a2a_agent_keys`.
8. **Scope creep** → **OK**. Único prod file = `x402.ts` (Scope IN). NO se tocó `a2a-key.ts`, `registry.ts`, `chain-resolver.ts`, adapters ni smoke (CD-8). Los 3 archivos de test extra son la corrección documentada del ripple effect (auto-blindaje 2026-05-27 13:10) — extensiones de `vi.mock`, no código de producción.

---

## Nota sobre los archivos fuera de la tabla "Files to Modify"

El diff incluye `src/__tests__/e2e/setup.ts`, `src/routes/registries.test.ts` y `src/middleware/x402.passport-shape.test.ts` (5-7 líneas c/u). NO son scope creep ni violación de CD-8: son los mocks de registry que `requirePayment` ahora consume (`getDefaultChainKey`/`getAdaptersBundle`/`getInitializedChainKeys`). Sin extenderlos, los tests legacy devolvían 500 `REGISTRY_NOT_INITIALIZED` (mock incompleto → `undefined`). Es el ripple effect anticipado en el Story File y documentado en `auto-blindaje.md`. Cero código de producción afectado; reproducen el default Kite byte-idéntico.

---

## Veredicto final

# APROBADO

- **BLOQUEANTES: 0** (ALTO: 0, MEDIO: 0, BAJO: 0)
- **MENORES: 1** (MNR-1 — DT-3 mismatch sin 400 explícito; decisión documentada y aceptada, fail-seguro vía adapter; NO bloquea)
- **OK: 9 categorías/vectores**

Los 8 vectores de ataque obligatorios están cerrados con evidencia ejecutable. La implementación cumple AC-1..AC-5 y CD-1..CD-11. Cero regresión (1048 verde), typecheck de producción limpio, sin hardcodes, sin `any`, scope respetado (solo `x402.ts` en prod), ownership N/A confirmado. El único hallazgo es MENOR y corresponde a una Decisión Técnica documentada (TD-WKH-111-01), no a un defecto.

---

## Resumen al orquestador

AR de WKH-111 (x402 chain-aware) **APROBADO — 0 BLOQUEANTES**. Único prod file = `src/middleware/x402.ts` (Scope IN); los 3 archivos de test extra son la corrección documentada del ripple effect sync→async (extensiones de `vi.mock`, no producción). Verifiqué los 8 vectores obligatorios con evidencia ejecutable: el cross-chain spoofing está cerrado (el adapter se selecciona por header y el body al facilitator usa `getNetworkTag(this.network)`, ignorando `paymentPayload.network`); el amount de Base es 6-dec real (`'1000000'`) derivado de `adapter.quote()`, sin literal `1e18`; el fail-loud 400 `CHAIN_NOT_SUPPORTED` dispara en ambos sub-casos antes del branch de payment-signature; cero regresión Kite (1048 tests verde, byte-idéntico); coherencia de chainKey única en challenge/verify/settle; orden correcto (post wallet guard, pre signature); sin tocar `a2a_agent_keys`/services/`a2a-key.ts`. 1 finding MENOR: el mismatch `payload.network` vs header no emite 400 explícito (DT-3/TD-WKH-111-01) pero es decisión documentada con fail-seguro vía adapter — no bloquea. Reporte: `doc/sdd/093-wkh-111-x402-chain-aware/ar-report.md`. Listo para CR.
