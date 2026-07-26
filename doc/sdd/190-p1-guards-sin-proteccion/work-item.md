# 190 — P1: guards del money-path sin protección (solo tests)

**Branch**: `test/p1-guards-sin-proteccion`
**Tipo**: SOLO TESTS — cero cambios en código de producción (`git diff --name-only` sobre no-test = vacío)
**Baseline**: 3364 passed / 11 skipped → **3392 passed / 11 skipped** (+28 tests)
**Gates**: `tsc --noEmit` 0 · `biome check src/` 0 · suite completa verde

---

## Criterio de aceptación aplicado

**Cada test tiene que ponerse ROJO al borrar su guard.** Cobertura de línea NO
cuenta como protección: el hallazgo 2 de esta HU es exactamente un guard
line-covered al 98.63% cuyo borrado dejaba la suite entera verde.

Se corrió una batería de **30 mutaciones**; las 30 murieron. Detalle por ítem
abajo, con el mensaje real de la assertion.

---

## Discrepancia de arranque (reportada, no corregida en silencio)

El encargo decía que `main` estaba en `6373dd8`. El HEAD real era **`9f17f16`**,
8 commits más adelante (fix-pack P1 de la HU 189). `6373dd8` ES ancestro de
`9f17f16` (verificado con `git merge-base --is-ancestor`), así que se branchó
desde el HEAD real. Baseline de tests re-medido sobre ese HEAD: 3364/11, que
coincide con el número del encargo.

---

## Ítem 1 — `src/adapters/solana/chain.ts` en 0%

**Verificado**: 0% stmts / 0% branch / 0% funcs, líneas 15-108, con
`--coverage.include='src/adapters/solana/**'`.

**Causa raíz** (no estaba en el diagnóstico): los dos únicos test-files del rail
Solana (`payment.test.ts:31`, `intent-dedup.test.ts:43`) hacen
`vi.mock('./chain.js', ...)` para no tocar la red. Toda la resolución de config
del rail nunca se ejecutaba.

**Test**: `src/adapters/solana/chain.test.ts` (NUEVO, 13 tests). Alcance elegido
por costo-de-rotura, no por porcentaje: decimals (exponente del monto),
CAIP-2 (llave del gate mainnet), commitment (garantía de confirmación), operator
keypair (la llave que firma + CD-3 no-loguear-secreto), y el cache por proceso.

**Resultado**: chain.ts **0% → 100%**.

| Mutación | Resultado |
|---|---|
| M1a `getSolanaUsdcDecimals` sin validación (NaN pasa) | KILLED — T-P1-1c |
| M1b `getSolanaCommitment` passthrough (whitelist borrada) | KILLED — T-P1-1d |
| M1c `getSolanaNetwork` honra `opts` (rompe devnet-only CD-4) | KILLED — T-P1-1b |
| M1d cache de `Connection` borrado | KILLED — T-P1-1g |
| M1e operator loguea el SECRETO | KILLED — T-P1-1k |
| M1f throw de env faltante degradado a `'boom'` | KILLED — T-P1-1i |
| M1g cache del operator borrado | KILLED — T-P1-1j |
| M1h `.trim()` del secret borrado | KILLED — T-P1-1j |
| M1i default del mint devnet cambiado | KILLED — T-P1-1a |
| M1j override de CAIP-2 ignorado | KILLED — T-P1-1e |

---

## Ítem 2 — el `delete` del self-heal

**Puntero del AR estaba STALE**: decía `payment.ts:341` y `:360-361`. El `delete`
real está en **`src/adapters/solana/payment.ts:448`**; `:341` es `getMint()` y
`:360-364` es `getMaxTimeoutSeconds`/`getMerchantName` (que sí son las únicas
líneas sin cubrir de ese archivo, probablemente de dónde salió la confusión).

**El hallazgo es REAL y es el más interesante de la tanda**: el `delete` estaba
LINE-COVERED (payment.ts al 98.63%, con T-HEAL-1/T-HEAL-2 pasando por esa línea)
pero **sin ninguna protección**. Borrando la línea entera:
`3364 passed | 11 skipped` — suite completa verde.

**Por qué el line-coverage engañaba**: en T-HEAL-1/T-HEAL-2 el re-broadcast
posterior SÍ tiene éxito, y `rememberIntentSignature` hace `.set()`, que
sobreescribe la entrada vieja igual. La assertion `getSettledSignature === SIG_A`
pasa con y sin el `delete`.

**Tests**: `src/adapters/solana/intent-dedup.test.ts`

- **T-P1-2a (borra cuando DEBE)**: firma previa que no verifica + re-broadcast que
  FALLA. Es el único camino donde el `delete` es observable, porque nadie llega a
  llamar a `rememberIntentSignature`. Invariante: la firma huérfana no queda en el
  seam. **Costo de plata**: `downstream-payment.ts:322` lee ese seam y con
  `priorSignature !== undefined` marca el leg como `isIdempotentReplay`, lo que
  convierte el pre-check de balance de GATE en SONDA (`:368`) — una firma que la
  cadena no reconoce desactivaría el corte `INSUFFICIENT_BALANCE` de todos los
  retries siguientes.
- **T-P1-2b (NO borra cuando NO debe)**: 3 retries de un intent ya confirmado; la
  entrada sobrevive a cada hit y se broadcastea CERO veces.

| Mutación | Resultado |
|---|---|
| M2a `delete` borrado | KILLED — T-P1-2a: `expected 'BBBB…' to be undefined` |
| M2b `delete` movido antes del `if (verified.valid)` (incondicional ⇒ el 2º retry re-broadcastea = doble pago) | KILLED — T-P1-2b: `expected undefined to be 'BBBB…'` |

---

## Ítem 3 — `SETTLE_FAILED` de Solana

**Verificado sin cubrir**: los dos guards de
`src/lib/downstream-payment.ts:403-409` (el `catch` del settle) y **`:410-416`**
(`!settleRes.success || !settleRes.txHash`) no tenían NINGÚN test. Mutando los dos
a la vez (rethrow + seguir de largo cobrando): `3364 passed` — verde.

El leg Solana tenía cubierto el corte por fondos (T-234-CR2a) y por payTo
inválido (T-234-AC3c), pero no el corte por settle fallido, que es justo el que
decide si un leg que no pagó se cobra igual.

**Tests**: `src/lib/downstream-payment.test.ts`
- T-P1-3a: `settle` LANZA → `null` + `SETTLE_FAILED`, sin excepción que escape (fail-soft).
- T-P1-3b: `success: false` → `null` + `SETTLE_FAILED`.
- T-P1-3c: `success: true` SIN `txHash` → `null` (un recibo sin firma no es un pago).
- T-P1-3d: la señal del rail SOLANA se CAPTURA (`createSkipCapturingLogger`) y sale
  VERBATIM en el contrato público. Este era el eslabón faltante: T-P1-4i ya cubría
  la captura, pero sobre la rama EVM (fuji).

| Mutación | Resultado |
|---|---|
| M3a `catch` → rethrow (pierde el fail-soft) | KILLED — T-P1-3a |
| M3b log del `catch` borrado (corta, pero muda) | KILLED — T-P1-3a |
| M3c guard `success=false` borrado (cobra igual) | KILLED — T-P1-3b/c/d: `expected {…} to be null` |
| M3d guard sólo mira `success`, no `txHash` | KILLED — T-P1-3c |
| M3e log sin `code` (señal ilegible) | KILLED — T-P1-3b/c/d |
| M3f `SETTLE_FAILED` genericizado a `UNAVAILABLE` en el mapa público | KILLED — T-P1-3d |

---

## Ítem 4 — el chainId del bundle (diagnóstico PARCIALMENTE equivocado)

El encargo pedía verificar antes de escribir. Se verificó, y **la mayor parte ya
estaba cubierta**:

| Guard | Estado real |
|---|---|
| `assertNoSlugDestinationDrift`, EVM testnet→mainnet | YA cubierto — `T-it2-ALTO-1-reg` |
| `assertNoSlugDestinationDrift`, EVM mainnet→testnet (simetría) | YA cubierto — `T-re-CR-MNR-6` |
| `checkAdapterChainIdDrift`, dirección que lanza | YA cubierto — `T-it2-MNR-3-reg-d` |
| `checkAdapterChainIdDrift`, dirección que loguea | YA cubierto — `T-it2-MNR-3-reg` |
| rama Solana de `assertNoSlugDestinationDrift` (usa CAIP-2, no `chainConfig`) | YA cubierto indirectamente — mutarla a EVM mata `flag ON + … full bundle` |

**Lo que SÍ estaba sin proteger eran los dos caminos Solana**, ambos verificados
por mutación sobreviviente:

1. **`registry.ts:216-217`** — exceptuar Solana del throw del chequeo 1
   (`if (!drift || destination.vmFamily === 'solana') return;`) **SOBREVIVÍA la
   suite completa**. O sea: el único gate que impide que el rail devnet-only
   settlee en Solana **MAINNET-BETA** (vía `SOLANA_CAIP2_CHAIN_ID`, env-driven) no
   tenía test. Es el camino de dinero real más directo del rail.
2. **`registry.ts:265`** — borrar el early-return non-EVM del chequeo 2 también
   SOBREVIVÍA.

**Tests**: `src/adapters/__tests__/registry.test.ts`
- T-P1-4-solana-mainnet: bundle Solana con CAIP-2 de mainnet-beta ⇒ `initAdapters`
  LANZA y el bundle no queda alcanzable.
- T-P1-4-solana-nodrift: el rail Solana sano NO emite `ADAPTER_CHAIN_ID_DRIFT`
  (sin el early-return, `undefined !== 900001` dispara una alarma de
  misconfiguración de dinero FALSA en cada arranque, que es como se desensibiliza
  al operador para cuando el drift sea el REAL de Kite).

| Mutación | Resultado |
|---|---|
| M4a Solana exceptuado del throw del chequeo 1 | KILLED — T-P1-4-solana-mainnet: `promise resolved "undefined" instead of rejecting` |
| M4b early-return non-EVM del chequeo 2 borrado | KILLED — T-P1-4-solana-nodrift: `expected "vi.fn()" to not be called at all, but actually been called 1 times` |
| M4c destino Solana leído de `chainConfig` en vez del CAIP-2 | KILLED (ya lo mataba un test preexistente) |

---

## Ítem 5 — el throw de non-EVM

**Confirmado**: `src/adapters/registry.ts:416-419`, línea 417 en el reporte de
uncovered. Borrar el throw entero SOBREVIVÍA la suite completa.

**Tests**:
- T-P1-5: `getPaymentAdapter('solana-devnet')` lanza, el mensaje nombra el
  `vmFamily` resuelto Y dice qué hacer (`use the vmFamily-aware settle path`), y el
  rail EVM del mismo proceso sigue resolviendo.
- T-P1-5b (contracara): `getPaymentAdapterOrUnion` SÍ devuelve el adapter Solana.
  Sin este test, "arreglar" la inconsistencia haciendo lanzar a los dos accessors
  volvería el rail Solana inalcanzable y nadie se enteraría.

| Mutación | Resultado |
|---|---|
| M5a throw borrado | KILLED — T-P1-5: `expected [Function] to throw an error` |
| M5b mensaje vaciado a `'adapter error'` | KILLED — T-P1-5 |
| M5c `getPaymentAdapterOrUnion` delega en `getPaymentAdapter` (corta el rail) | KILLED — T-P1-5b |

---

## Ítem 6 — el e2e de devnet era VACUO (dos veces)

**Diagnóstico**: `payment.test.ts`, ex-`describe.runIf(SOLANA_DEVNET_E2E === '1')`
→ `'settles a real SPL transfer on devnet'`. **Dos defectos independientes**, los
dos demostrados empíricamente:

1. Siempre apagado: `SOLANA_DEVNET_E2E` no se setea en ningún lado del repo.
2. **Y con el flag prendido seguía sin probar nada.** Vivía en un archivo que
   mockea `./chain.js`, `@solana/spl-token` y `sendAndConfirmTransaction` a nivel
   módulo. `vi.importActual('./payment.js')` desmockea el módulo PEDIDO, **no sus
   dependencias**. Repro:

   ```
   SOLANA_DEVNET_E2E=1 SOLANA_E2E_PAYTO=So111…112 vitest run src/adapters/solana/payment.test.ts
   → Tests  20 passed (20)   en 270 ms
   ```

   Sin red, sin `SOLANA_OPERATOR_PRIVATE_KEY`, sin fondos, asertando
   `success: true` sobre `FAKE_SIG`. Prueba adicional de que los mocks entraban:
   sin `SOLANA_E2E_PAYTO` el fallo era `TypeError` en `payment.ts:454`
   (`new PublicKey(undefined)`) DESPUÉS de que `getSolanaOperatorKeypair()`
   resolviera sin ninguna key en el env.

**Arreglo = split honesto** (el encargo lo autorizaba explícitamente):

- **`src/adapters/solana/settle-wiring.test.ts`** (NUEVO, 5 tests, OFFLINE, activo
  en CI). La parte cuyo valor NO depende de la red: la CONSTRUCCIÓN de la
  transferencia. `createTransferInstruction`, `getAssociatedTokenAddressSync`,
  `Transaction` y `PublicKey` son los REALES; sólo se falsean los 3 bordes de red
  (`getOrCreateAssociatedTokenAccount`, `sendAndConfirmTransaction`, `chain.js`) —
  y el operator es un `Keypair` real de seed fija, así que es determinista.
  Asertea sobre los BYTES de la instrucción: monto u64 LE, dirección
  source→destination, authority firmante, commitment.
- **`src/adapters/solana/devnet-e2e.manual.test.ts`** (NUEVO, manual, skipped en
  CI). Cero `vi.mock`. Runbook completo en el header (keygen, airdrop, faucet
  Circle, conversión del secret a base58, comando, cómo leer los fallos). Dos
  diferencias de fondo con el viejo: **falla ruidosamente si le faltan las envs**,
  y **verifica que el BALANCE SE MOVIÓ** (`before - amount === after`), no que la
  promesa resolvió.

  Verificado que no es vacuo:
  ```
  SOLANA_DEVNET_E2E=1 SOLANA_E2E_PAYTO=So111…112 vitest run …/devnet-e2e.manual.test.ts
  → AssertionError: SOLANA_OPERATOR_PRIVATE_KEY es obligatoria para este e2e
  ```
  o sea: el escenario exacto en el que el test VIEJO pasaba en verde, ahora falla.

El bloque viejo se borró de `payment.test.ts` y en su lugar quedó un comentario
que explica por qué no puede vivir ahí (para que nadie lo re-agregue).

| Mutación (sobre el settle real) | Resultado |
|---|---|
| M6a source/destination INVERTIDOS | KILLED — T-P1-6b |
| M6b monto off-by-one (`- 1n`) | KILLED — T-P1-6a/d/e |
| M6c monto vía `Number` con redondeo | KILLED — T-P1-6d: `expected { tag: 3, amount: 0n } to deeply equal { tag: 3, amount: 1n }` |
| M6d authority = `payTo` en vez del operador | KILLED — T-P1-6b |
| M6e commitment no viaja al broadcast | KILLED — T-P1-6c: `expected {} to deeply equal { commitment: 'confirmed' }` |
| M6f ATA destino derivada del OPERADOR (se paga a sí mismo) | KILLED — T-P1-6b |

---

## Observaciones que quedan abiertas (NO se tocaron)

1. **`solana/index.ts`, `attestation.ts`, `gasless.ts`, `identity.ts` siguen en
   0%**. Fuera del scope de los 5 hallazgos. `index.ts` (el factory) es el más
   relevante de los cuatro porque arma el bundle que el registry valida.
2. **BUG REAL ENCONTRADO — `T-CAP-4` es FLAKY (pre-existente, NO se arregló)**.
   Ver la sección dedicada abajo.
3. `payment.ts:360-364` (`getMaxTimeoutSeconds`, `getMerchantName`) siguen sin
   cubrir. Son getters de config sin impacto de dinero; se dejaron a propósito.

---

## BUG REAL: `T-CAP-4` es FLAKY (~5-10% de las corridas) — NO se arregló

**Dónde**: `src/adapters/solana/intent-dedup.test.ts:466-488` —
`T-CAP-4: el desalojo respeta el borde exacto de la ventana protegida`.
Guard bajo prueba: `src/adapters/solana/payment.ts:255`.

**Es PRE-EXISTENTE**, no lo introdujo esta HU. Medido sobre el archivo pristino de
`HEAD` (`git show HEAD:…`, con mis 2 tests AUSENTES): **2 de 40 corridas fallaron**.
Con mis tests presentes: **4 de 40**, y mis tests T-P1-2a/T-P1-2b fallaron **0 de 40**
(o sea: el flake es de T-CAP-4, no de lo que agregué). Apareció una vez en el gate
final de esta sesión, que es cómo se detectó.

**Assertion que falla** (línea 477):
```
AssertionError: expected undefined to be 'BBBBBB…' // Object.is equality
```

**Causa raíz**: el test siembra la entrada EXACTAMENTE en el borde
(`_seedIntentSignature('en-el-borde', SIG_B, PROTECTED_WINDOW_MS)` ⇒
`storedAt = Date.now() - PROTECTED_WINDOW_MS`) y DESPUÉS hace trabajo asíncrono
(`adapter.settle(...)`, que await-ea las dos ATAs y el broadcast). El desalojo
compara con el reloj de pared en ese momento posterior:

```ts
// payment.ts:255
if (now - entry.storedAt <= protectedWindow) break; // protegida
```

Si entre el seed y el `evictIntentSignatures(now)` pasa **≥ 1 ms** de wall-clock,
la edad efectiva es `PROTECTED_WINDOW_MS + 1` y la entrada deja de estar protegida
⇒ se desaloja ⇒ `getSettledSignature` devuelve `undefined`. El test depende de que
el `settle()` completo tarde 0 ms.

**NO es un bug de dinero**: en producción la ventana protegida es de 25 min y su
borde es difuso por diseño; un ms de un lado o del otro no cambia ninguna decisión
de plata. Es un defecto de DETERMINISMO del test.

**Por qué no lo arreglé**: el arreglo honesto es inyectar el `now` (o un clock) en
`evictIntentSignatures` para que el borde sea comparable sin depender del reloj de
pared — y eso es **tocar el money-path**, que el encargo prohíbe explícitamente en
esta tanda. La alternativa barata (sembrar unos ms DENTRO de la ventana) le saca al
test justamente lo que vino a fijar: el borde EXACTO. Es una decisión de diseño,
no un fix mecánico.

**Impacto operativo**: el gate `vitest run` es rojo ~1 de cada 10-20 corridas por
esta única razón. Vale una HU corta.

