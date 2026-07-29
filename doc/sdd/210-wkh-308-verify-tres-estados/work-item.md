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

## 5. Residuo encontrado — **con una corrección a lo que yo mismo afirmé**

### 5.1 Lo que dije, y por qué estaba mal

En la primera versión de este documento escribí que un nodo atrasado hacía que
`compose` **reembolsara** al caller y que **el operador absorbiera** la diferencia. **Lo
afirmé sin trazar el camino del reembolso. Es falso**, y lo verifiqué:

- `settleSolanaLeg` **captura todo throw** de `adapter.settle` y devuelve `null`
  (`downstream-payment.ts:460-465`). No re-lanza.
- Un `downstream === null` **no hace fallar el step**: `invokeAgent` no lanza, corre
  `finishSuccessfulStep` y el step termina OK.
- El reembolso (`refundStepDebit`) vive en el **catch del step**
  (`compose.ts:885-891`), o sea que sólo dispara cuando `invokeAgent` **lanza**.

Conclusión: **no hay reembolso, y por lo tanto no hay pérdida para el operador.** El
agente cobró on-chain y el caller pagó: económicamente correcto.

Cometí exactamente el error que este mismo documento le señala al encargo original —
afirmar una consecuencia sin seguir el camino hasta el final.

### 5.2 El daño real, que es menor pero existe

El defecto sobreviviente es de **contabilidad y observabilidad**, no de dinero:

> Un settle que **SÍ se pagó** se reporta como **no settleado**. El caller recibe
> `downstreamSettle: 'skipped:SETTLE_FAILED'`, no se surface el `downstreamTxHash`, no
> se escribe el recibo del leg Solana en el ledger (`recordSolanaLegIfAny` no se invoca
> porque `downstream` es `null`), y la fila queda en `signed` en vez de `confirmed`.

O sea: la reconciliación mira un pago hecho y lee "no se pagó". Es la misma familia de la
determinación negativa —tratar *"no pude comprobarlo"* como *"no pasó"*— sólo que el
costo es de datos, no de plata.

### 5.3 El arreglo NO es de una línea

Cambiar `verify()` por `probeSettlementPresence` dentro de `recoverConfirmedSettle`
**por sí solo no cambia nada observable**: cualquiera sea el error, `settleSolanaLeg`
lo colapsa a `SETTLE_FAILED` en su catch. Para que el arreglo tenga efecto hacen falta
**dos partes**:

1. `payment.ts` — `recoverConfirmedSettle` distingue los estados y, ante `unknown`,
   señaliza "no pude comprobarlo" en vez de "falló";
2. `downstream-payment.ts` — el catch de `settleSolanaLeg` deja de colapsar todo a
   `SETTLE_FAILED` y emite **`SETTLE_UNKNOWN`** cuando corresponde, **espejando lo que
   el leg EVM ya hace** (`readSettleValueDisposition`, `:893-905`). Ese código público
   ya existe y ya significa lo que hace falta: *"no sé si se pagó, ese leg NO se puede
   tratar como no pagado"* (`downstream-skip-code.ts:58-60`).

La parte (2) cambia el **skip-code que ve el caller** (`SETTLE_FAILED` →
`SETTLE_UNKNOWN`) en un camino que corre hoy. Es un cambio de contrato observable, chico
pero real, y por eso **no lo implementé sin confirmarlo**: el encargo lo describía como
una línea, y no lo es.

**Encuadre correcto, que es el que pediste dejar escrito**: no es *alinear Solana con
EVM* — es **dejar de reportar como fallado algo que no pudimos comprobar**. Da la
casualidad de que el leg EVM ya lo hace, así que hay patrón que espejar en vez de
inventar.
