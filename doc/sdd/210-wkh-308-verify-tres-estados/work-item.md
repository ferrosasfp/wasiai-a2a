# WKH-308 — El cuarto sitio de la determinación negativa: **VERIFICADO CERRADO**

> Estado: **NO SE IMPLEMENTA.** El hallazgo describe una conducta que ya no existe.
> Este documento es la verificación, no un plan.
>
> Verificado contra `main` = `abb0029` (worktree `wt-308`, rama
> `feat/308-verify-tres-estados`). Suite baseline: **4254 passed | 19 skipped**.

---

## 1. El hallazgo original: cerrado por WKH-307

> *"`verify()` colapsa 'falló' con 'no la encuentro', y ante `valid:false` **se borra el
> seam de idempotencia y se re-emite el pago**."*

| Pregunta | Respuesta | Evidencia en `main` |
|---|---|---|
| ¿Sigue el colapso en `verify()`? | **SÍ** | `payment.ts:884-889` — `!parsed?.meta \|\| parsed.meta.err` ⟹ un solo `valid:false`. El string lo admite: *"not found **or** failed"* |
| ¿Sigue habiendo un camino que borre el seam y re-emita? | **NO** | El seam en memoria **no existe**: `grep -rn "_intentSignatures" src/ --include=*.ts` (sin tests) ⟹ **0**. `grep -n "new Map" src/adapters/solana/payment.ts` ⟹ **0** |
| ¿Qué cubrió WKH-307? | **El camino entero** | No había dos caminos; `settle()` tiene una sola trayectoria |
| ¿`isProvenAbsent` está listo? | **NO EXISTE** | `grep -rn "isProvenAbsent"` ⟹ **0** en todo el árbol |

**Los únicos dos puntos de emisión** son `payment.ts:293` (primera emisión, tras ganar el
reclamo atómico — no consulta la cadena) y `payment.ts:522` (re-firma, **sólo** tras
`SettlementPresence ∈ {absent, landed_failed}` **y** la prueba de expiración). Ninguno
pasa por `verify()`.

El **único** consumidor interno de `verify()` es `recoverConfirmedSettle`
(`payment.ts:774`): ante `!valid` hace `return undefined` (`:801`) y su caller (`:715`)
**lanza**. No re-emite.

### Premisas del encargo que no se sostienen contra este árbol

Se verificaron una por una porque el encargo anterior ya venía con tres de cuatro
desactualizadas:

| Premisa | Verificación |
|---|---|
| *"`VerifyResult.indeterminate` existe (`types.ts:42`)"* | **NO.** `VerifyResult` (`types.ts:28-31`) tiene sólo `valid` y `error`. La línea 42 es `SignRequest.timeoutSeconds`. `indeterminate` existe, pero como veredicto de **`services/reconciliation.ts:150,240`**, otro tipo y otro riel |
| *"el candado del gateway es un `Map` en memoria (`payment.ts:100`)"* | **NO.** `payment.ts:100` es un comentario; no hay ningún `Map` en el archivo. WKH-307 lo reemplazó por la tabla `a2a_solana_settle_intents` |
| *"hoy la única protección durable del riel Solana vive del lado del facilitator"* | **NO.** La protección durable del gateway **es** esa tabla, con reclamo atómico, y sobrevive al reinicio. Ése era el objetivo declarado de WKH-307 |
| *"tres tests fijan la conducta (`T-HEAL-1`, `T-HEAL-2`, `T-P1-2a`)"* | **NO.** Eliminado / invertidos por WKH-307; sólo sobreviven como filas de la tabla de retiro (`intent-dedup.test.ts:43-46`). `payment.flag.test.ts` y el test `DOCUMENTA EL HALLAZGO ABIERTO` **no existen** (`find` / `grep` ⟹ vacío) |

Hoy la conducta está fijada por tests que afirman **lo contrario** y pasan: `T-IDM-12`
(`:693`), `T-IDM-13` (`:721`), `T-IDM-18` (`:841`), `T-IDM-18b` (`:857`).

---

## 2. El precedente de EVM: **confirma el criterio, y Solana ya lo cumple**

`src/adapters/escrow/reconciler-onchain.ts:73-104` (`reverifyDebitedByTxHash`):

| Situación | EVM | Solana (WKH-307) |
|---|---|---|
| no se pudo preguntar (RPC ausente, `getTransactionReceipt` tira) | `indeterminate` | `unknown` (`payment.ts:540+`) |
| aterrizó y **revirtió** | `not_confirmed` ⟹ se reintenta | `landed_failed` ⟹ se reintenta |
| aterrizó y cumple | `confirmed` | `landed_ok` |
| aterrizó y NO cumple los términos | `not_confirmed` | `landed_mismatch` (estado propio) |
| **no está** (demostrado) | *(no lo afirma nunca)* | `absent` |

**Solana no quedó atrás del criterio de EVM: lo cumple y es más granular.** Y la
diferencia que sí existe es **legítima y necesaria, no un hueco**:

> EVM **nunca afirma ausencia probada**: colapsa *"no encontrada"* dentro de
> `indeterminate` y por lo tanto **jamás re-emite por ausencia**. Puede darse ese lujo
> porque tiene **backstop on-chain**: el nonce determinístico de EIP-3009 hace que un
> segundo broadcast **revierta** en el token.
>
> Solana **no tiene backstop**. Si nunca pudiera afirmar ausencia, un intent cuya tx
> expiró sin aterrizar quedaría **trabado para siempre** y el agente no cobraría nunca.
> Por eso WKH-307 necesitó una determinación positiva (`getSignatureStatuses` con
> `searchTransactionHistory`) **más** la prueba de expiración del blockhash.

O sea: EVM puede ser más conservador porque la cadena lo respalda; Solana tiene que ser
más preciso porque no. Copiar la forma de EVM *tal cual* a Solana **reintroduciría el
estado sumidero** que WKH-307 eliminó.

---

## 3. Lo que sí aporta este encargo: el testigo único

La observación estructural del re-AR de la 302 **aplica a WKH-307**, y la verifiqué:

> *"Cuando el arreglo se apoya en dos condiciones, verificá que sean **dos testigos** y
> no la misma fuente preguntada dos veces."*

En `settleAlreadySigned` las dos condiciones para re-emitir son:

1. presencia `absent` — `connection.getSignatureStatuses(...)` (`payment.ts:543`)
2. blockhash expirado — `connection.getBlockHeight(...)` (`payment.ts:486`)

**Las dos salen del mismo `getSolanaConnection()`.** Y hay algo peor que la fuente
compartida: **(2) no es un testigo de lo que importa.** No responde *"¿aterrizó?"*, sino
*"¿pasó el tiempo?"*. Una altura avanzada es cierta casi siempre y **no puede
contradecir** un `absent` mentido. O sea que el guard es, en rigor, **un testigo y un
reloj**, no dos testigos.

Esto **no reabre el hallazgo cerrado** (sigue haciendo falta que un nodo mienta), y el
AR de WKH-307 ya atacó su mitad: por eso el preflight **mide** la retención de histórico
del endpoint y **corta** si es insuficiente o no medible
(`schema-preflight.ts`, `SOLANA_RPC_LEDGER_HISTORY_DECLARED_SUFFICIENT`). Lo que queda
sin cubrir es un **pool heterogéneo**: si algunos nodos tienen histórico y otros no, la
medición del arranque puede pegarle a uno bueno y la consulta de `absent` a uno malo.

**Mitigación posible, no implementada** (sería su propia HU, con su AR): exigir que la
determinación `absent` se confirme contra un **segundo endpoint independiente** antes de
autorizar la re-emisión. Ahí sí serían dos testigos.

---

## 4. Decisión

**No se implementa.** El criterio que el founder aprobó ya rige, con más granularidad
que el precedente de EVM y por un motivo de cadena, no por capricho. Escribir código
para "aplicarlo" sería re-implementar lo existente tocando el camino que corre hoy, sin
ganar nada.

**La consecuencia honesta que el founder aceptó ya está vigente**: cuando el sistema **no
puede comprobar** si un pago salió, **no lo reintenta** — el intent queda esperando
intervención humana en vez de resolverse solo. Un agente que no cobró es recuperable
(retry, reconciliación, pago manual); uno que cobró dos veces, no. El procedimiento de
destrabe está en
`doc/sdd/209-wkh-307-solana-durable-idempotency-ledger/runbook-destrabe.md`.

**El auto-sanado no se eliminó: se acotó.** `recoverConfirmedSettle` (`payment.ts:745`)
sigue vivo y sigue recuperando el caso legítimo — la confirmación falló pero la tx SÍ
aterrizó. Dejó de dispararse sólo donde estaba mal: cuando no puede comprobarlo.

---

## 5. Lo que SÍ se implementó (y por qué la severidad corregida no lo cancela)

### 5.1 Corrección a lo que yo mismo afirmé

En la primera versión escribí que un nodo atrasado hacía que `compose` **reembolsara** y
que **el operador absorbiera**. **Es falso**, y lo verifiqué: `settleSolanaLeg` captura
todo throw y devuelve `null` (`downstream-payment.ts:460+`); un `downstream === null`
**no hace fallar el step**; y el reembolso vive en el catch del step
(`compose.ts:885-891`), o sea que sólo dispara cuando `invokeAgent` **lanza**.

**No hay reembolso ni pérdida.** Cometí el mismo error que este documento le señala al
encargo: afirmar una consecuencia sin seguir el camino hasta el final.

### 5.2 El daño real: una contabilidad que miente

> Un settle que **SÍ se pagó** se reportaba como **no settleado**: el caller recibía
> `skipped:SETTLE_FAILED`, no se surfaceaba el `downstreamTxHash`, no se escribía el
> recibo del leg (`recordSolanaLegIfAny` no corre con `downstream` en `null`) y la fila
> quedaba en `signed`.

No se pierde plata hoy. Se arregla igual porque **ese dato falso es el insumo de un bug
futuro**: el día que un job actúe sobre esas filas —el que pide la reserva del tope
diario de WKH-302— va a leer un pago hecho como pendiente. Ahí sí aparece el doble pago,
meses después de escribirse el dato malo y carísimo de diagnosticar.

### 5.3 El arreglo son DOS partes, porque una sola no cambia nada

1. **`payment.ts`** — `recoverConfirmedSettle` deja de usar `verify()` (que colapsa
   *aterrizó-y-falló* / *no está* / *no la tengo indexada*) y usa
   `probeSettlementPresence`, la misma fuente de tres estados que el resto del adapter
   desde WKH-307. Ante `unknown` lanza `FacilitatorSettleError(..., 'unknown')`.
2. **`downstream-payment.ts`** — el catch de `settleSolanaLeg` deja de colapsar todo en
   `SETTLE_FAILED` y emite `SETTLE_UNKNOWN` cuando la disposición es `unknown`,
   **espejo exacto** del leg EVM (`:914`).

Sin (2), (1) es decorativo: el catch del leg tragaba cualquier error.

**Condición verificada antes de tocar código** — `SETTLE_UNKNOWN` **no es vocabulario
nuevo**: lo emite el leg EVM (`downstream-payment.ts:899` y `:925`), está mapeado
**verbatim y sin genericizar** en `PUBLIC_SKIP_CODE` (`downstream-skip-code.ts:164`), y
dos tests vivos prueban que **hoy llega al caller** (`T-198-SettleUnknown`,
`T-201-SettleFalseWithHash`). Solana sólo deja de mentir donde EVM ya dice la verdad.

**Encuadre correcto**: no es *alinear Solana con EVM* — es **dejar de reportar como
fallado algo que no pudimos comprobar**. Que EVM ya lo haga sólo significa que hay
patrón que espejar en vez de inventar.

### 5.4 `verify()` queda sin consumidores internos en Solana — y NO se retira

Tras el cambio, `grep "this.verify("` en `src/adapters/solana/` da **0**. **Es una
decisión, no un olvido**, y se escribe acá para el próximo que corra ese grep:

- sigue en la **interfaz pública** `SolanaPaymentAdapter` (`types.ts:202`) como la
  superficie declarada de verify-before-trust;
- su lógica de términos **se sigue usando**: `probeSettlementPresence` comparte
  `checkTerms` con ella;
- borrarla cambiaría el contrato de un adapter por una razón interna.

### 5.5 Tests invertidos, con su razón

| Test | Qué afirmaba | Por qué se invierte |
|---|---|---|
| `T-235a-AC2d` | recovery con el RPC caído ⟹ **propaga el error original** (leg reportado FALLADO) | Un RPC que no contesta no prueba que el pago no ocurrió. Ahora ⟹ `unknown`. La propiedad que protegía (no inventar un éxito) **sigue viva**: se rechaza igual, pero sin afirmar lo que no sabemos |
| `T-235a-AC2` | *"no confirmada on-chain"* inferido de un parseo ausente | Ahora la ausencia se **prueba** (`presenceState = null`), no se infiere |

### 5.6 Campaña de mutación

| # | Mutación | ¿Compiló? | Resultado | Asesino |
|---|---|---|---|---|
| **M1** | `unknown` vuelve a caer al camino de fallo (parte 1) | Sí (3ª formulación) | **KILLED** | `T-308-01`, `T-235a-AC2d` |
| **M2** | El leg vuelve a colapsar todo en `SETTLE_FAILED` (parte 2) | Sí | **KILLED** | `T-308-LEG-UNKNOWN` |
| **M3** | Un fallo **probado** on-chain se reporta como `unknown` (colapsa los dos otra vez) | Sí (2ª formulación) | **KILLED** | `T-308-03`, `T-235a-AC2e` |

> **M3 pareció SURVIVED y no lo era: el mutante cayó en el sitio equivocado.**
> `replace(..., 1)` tomó la primera ocurrencia del patrón, que está en
> `settleAlreadyConfirmed` (`:355`), no en `recoverConfirmedSettle` (`:793`). El archivo
> cambió —así que un chequeo de "¿aterrizó?" por hash o `git diff` daba verde— pero **el
> código bajo prueba no**. Aplicado en el sitio correcto, murió con dos tests nombrados.
>
> **Lección**: para una mutación no alcanza con que el archivo cambie; tiene que cambiar
> **el sitio previsto**. Es un refinamiento de la disciplina que ya traía: el guard de
> "MUTANT_NOT_APPLIED" detecta un diff vacío, no un diff en el lugar equivocado.
