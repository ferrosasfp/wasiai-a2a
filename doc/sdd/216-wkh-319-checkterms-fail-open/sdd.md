# SDD · WKH-319 — Cerrar el fail-open del camino de SALIDA en Solana (`checkTerms`)

| Campo | Valor |
|---|---|
| HU | **WKH-319** |
| Fase | **F2 — SDD** (input: hallazgo trazado por ejecución; ver §0) |
| Worktree / rama | `~/.openclaw/workspace/wt-319` · `feat/216-wkh-319-checkterms-fail-open` |
| Archivo de producción | `src/adapters/solana/payment.ts` (**único**) |
| Riesgo | **Camino de dinero, código MERGEADO Y CORRIENDO.** El leg que le paga a los agentes |
| Corte mínimo | **W0 + W1** — cierra las 5 formas del fail-open. W2/W3 son endurecimiento y evidencia |
| Autor | `nexus-architect` |

---

## 0. Estado del input y qué se verificó antes de diseñar

No hay `work-item.md`: el encargo llegó con el hallazgo **ya trazado por ejecución** (tres
probes reproducibles) y con la instrucción explícita de **no rehacer el barrido**. Este SDD
adopta ese trazado como work item (§2) y **verifica puntualmente** los seis hechos de los que
cuelga el diseño. Los seis quedaron confirmados:

| # | Afirmación del encargo | Verificación | Resultado |
|---|---|---|---|
| V-1 | `preTokenBalances` es `optional(nullable(array(...)))` en el bundle instalado | `node_modules/@solana/web3.js/lib/index.cjs.js`, `ConfirmedTransactionMetaResult` y `ParsedConfirmedTransactionMetaResult` | **CONFIRMADO** — literal `superstruct.optional(superstruct.nullable(superstruct.array(TokenBalanceResult)))` |
| V-2 | `owner` es `optional(string())` | `TokenBalanceResult` en el mismo bundle | **CONFIRMADO** |
| V-3 | `amount` está tipado `string()` ⇒ los no-string no llegan | `TokenAmountResult = type({ amount: string(), uiAmount: nullable(number()), decimals: number(), ... })` | **CONFIRMADO** |
| V-4 | `:1120` escapa del `try` de `probeSettlementPresence` | `payment.ts:617-624` cierra el `try` en el `catch`; `checkTerms` se llama en `:640`, **fuera**. `verify()` lo llama en `:1164`, también fuera | **CONFIRMADO** |
| V-5 | Todas las fixtures usan `preTokenBalances: [{owner: PAY_TO, amount:'0'}]` | 6 sitios: `payment.test.ts:301,327,361,602` · `intent-dedup.test.ts:353,865`. **Ninguna trae `accountIndex`, ni `accountKeys`, ni `preBalances`** | **CONFIRMADO y AMPLIADO** (§8.3) |
| V-6 | Los 4 consumidores no tienen segunda barrera | `settleSolanaLeg` (`lib/downstream-payment.ts:469-543`) sólo mira `success`/`txHash` y arma el recibo con `settledAmount: amountAtomic` — el monto que **creemos** haber pagado | **CONFIRMADO** |

**Hallazgo nuevo del grounding, que cambia el diseño** (no estaba en el encargo):

- **`accountIndex: number` y `mint: string` son OBLIGATORIOS** en `TokenBalanceResult`, y
  `message.accountKeys` es **obligatorio** en `ParsedConfirmedTransactionResult`. O sea que el
  esquema del SDK **sí** garantiza el material con el que se puede construir un guard fuerte:
  la debilidad está en `owner` y en las dos listas, no en el índice. Esto es lo que hace
  barata la solución (§4.4).
- **`preBalances` / `postBalances` son `array(number())` obligatorios**, y sus índices son el
  mismo espacio que `accountIndex`. **Eso da un discriminador local y directo del único caso
  legítimo de ausencia en `pre`** — la ATA creada en la misma tx (§4.5). Es la pieza que
  permite no importar el invariante de conservación global de WKH-315 (§7.2).

---

## 1. Resumen

`SolanaPaymentAdapter.checkTerms` (`src/adapters/solana/payment.ts:1101-1130`) **no falla
abierto por no verificar: falla abierto por verificar otra cosa.** Con `preTokenBalances`
ausente, el `?? []` de `:1114` fabrica una lista vacía, `balanceFor(pre)` da `0n`, y `delta`
deja de ser un delta para pasar a ser el **saldo absoluto** de `payTo`. La comprobación
degenera de *"esta tx transfirió ≥ required a payTo"* a *"payTo tiene ≥ required"*.

Consecuencia medida: una tx donde `payTo` **GASTA** 100 USDC y no recibe nada devuelve
`{ok:true}`. **Una transacción ajena, con el agente como pagador, se certifica como "nuestro
pago llegó".**

El arreglo tiene **una sola idea**: `checkTerms` responde hoy una pregunta de dos valores
(*coincide* / *no coincide*) a una pregunta que tiene **tres** (*coincide* / *no coincide* /
**no pude medirlo**). Todo lo demás —las cinco formas de lista, el delta negativo, el `''`
que `BigInt` convierte en `0n`, el `find` que toma la primera cuenta— son **maneras distintas
de caer en el tercer valor que el tipo no tiene**, y por eso todas terminan colapsadas en el
lado equivocado del segundo.

Se agrega el tercer valor, se lo hace viajar, y **no hace falta tocar a ninguno de los cuatro
consumidores**: los cuatro ya tienen escrita —y testeada— la rama correcta para
`presence.state === 'unknown'` (§5). Lo único que hay que dejar de hacer es **fabricar
`landed_mismatch` a partir de una indeterminación**.

---

## 2. Work Item (adoptado del encargo)

**Como** operador del gateway,
**quiero** que la validación de términos del leg Solana distinga *"no coincide"* de *"no pude
medirlo"*,
**para que** ninguna transacción ajena pueda certificarse como nuestro pago, y ninguna
indeterminación transitoria condene un intent sano.

### Scope IN

- `src/adapters/solana/payment.ts` — `checkTerms`, el mapeo en `probeSettlementPresence`, el
  mapeo en `verify()`, y la cola de `settleAlreadySigned` (W2).
- `src/adapters/types.ts` — **bloque aditivo** con el tipo del veredicto de términos.
- Las 6 fixtures de `payment.test.ts` / `intent-dedup.test.ts` (§8.3) + tests nuevos.

### Scope OUT (y por qué)

| Fuera | Razón |
|---|---|
| El fail-open de `getOperatorSplBalance` (`:210-220` + `downstream-payment.ts:383-390`) | **Decisión deliberada y documentada.** No se toca ni se re-litiga (instrucción del encargo) |
| `SettlementPresence` (`types.ts:170-187`) | **CONGELADO.** WKH-314 (R1) y WKH-315 (CD-3) lo tratan así, y §4.7 muestra que agregarle un estado es un **bug de dinero** con el código de hoy |
| El monto del recibo (`settledAmount: amountAtomic`) | Es el análogo de salida del cambio estructural de WKH-315 y necesita superficie nueva (`SettleResult` + `settleSolanaLeg` + ledger). Se **habilita** acá (§4.8) y se cierra en HU aparte (§9, TD-319-1) |
| El `success:true` incondicional de `settleViaFacilitator:813` | Pre-existente y con razón propia (un 2xx del facilitator sobre un pago probablemente real; devolver `false` dispara reembolso). Se documenta en §5.2, no se cambia |
| Cambiar `commitment:'confirmed'` a `finalized` en `:619` / `:1141` | Diferido con ticket propio en `doc/sdd/185-.../work-item.md` (MNR-2). Ortogonal |

### Acceptance Criteria (EARS)

| AC | Enunciado |
|---|---|
| **AC-1** | **WHEN** `meta.preTokenBalances` o `meta.postTokenBalances` está **ausente o `null`**, THE SYSTEM SHALL devolver `indeterminate`, y `probeSettlementPresence` SHALL reportar `unknown` (nunca `landed_ok` ni `landed_mismatch`) |
| **AC-2** | **WHEN** cualquiera de las dos listas contiene una entrada que no es un objeto con `mint: string`, `accountIndex: number` y `uiTokenAmount.amount` que satisface `/^[0-9]+$/`, THE SYSTEM SHALL devolver `indeterminate` **sin lanzar** |
| **AC-3** | **WHEN** una cuenta del conjunto receptor aparece en `post` y **no** en `pre`, y `meta.preBalances[accountIndex]` **no es `0`** (o no se puede leer), THE SYSTEM SHALL devolver `indeterminate` |
| **AC-4** | **WHEN** una cuenta del conjunto receptor aparece en `post` y no en `pre`, y `meta.preBalances[accountIndex] === 0`, THE SYSTEM SHALL tomar su saldo previo como `0` y completar la medición — **la ATA creada en la misma tx sigue funcionando** |
| **AC-5** | **WHEN** una cuenta del conjunto receptor aparece en `pre` y **no** en `post`, THE SYSTEM SHALL aplicar la regla simétrica de AC-3/AC-4 sobre `meta.postBalances[accountIndex]` |
| **AC-6** | **WHEN** el delta agregado del conjunto receptor es **negativo**, THE SYSTEM SHALL devolver `indeterminate` (**nunca** `mismatch`) |
| **AC-7** | **WHERE** el receptor tiene **más de una** cuenta de token del mint en la misma tx, THE SYSTEM SHALL agregar el delta sobre **todas** ellas, emparejando `pre` y `post` por `accountIndex` |
| **AC-8** | **WHEN** las dos listas están presentes, son interpretables y completas, y el delta agregado es `>= 0` y `< required`, THE SYSTEM SHALL devolver `mismatch` — **`landed_mismatch` NO se vuelve inalcanzable** |
| **AC-9** | THE SYSTEM SHALL NOT lanzar desde `checkTerms` para **ninguna** entrada admitida por el esquema de `@solana/web3.js`, y `probeSettlementPresence` SHALL traducir cualquier throw a `unknown` — la promesa *"NUNCA lanza"* vuelve a ser cierta |
| **AC-10** | **WHEN** `checkTerms` devuelve `indeterminate` en la rama `confirmed`, `settleAlreadyConfirmed` SHALL lanzar `SETTLE_PRESENCE_UNKNOWN` (transitorio) y SHALL NOT lanzar `SETTLE_CONFIRMED_BUT_UNVERIFIABLE` |
| **AC-11** | **WHEN** `checkTerms` devuelve `indeterminate` en la rama `signed`, `settleAlreadySigned` SHALL lanzar `SETTLE_IN_FLIGHT_UNRESOLVED`, con **cero** llamadas a `sendRawTransaction`, y SHALL NOT marcar la fila `confirmed` |
| **AC-12** | **WHEN** `checkTerms` devuelve `indeterminate` dentro de `recoverConfirmedSettle`, el leg SHALL aparecer como `SETTLE_UNKNOWN` (`valueDisposition:'unknown'`), no como `SETTLE_FAILED` |
| **AC-13** | **WHEN** `checkTerms` devuelve `indeterminate` dentro de `settleViaFacilitator`, la fila SHALL quedar en `signed` (sin `recordConfirmedIntent`) |
| **AC-14** | `verify()` SHALL marcar `indeterminate: true` en **toda** negativa no medida (tx no parseable en el nodo consultado, términos indeterminados) |
| **AC-15** | Un estado nuevo de `SettlementPresence` SHALL NOT poder alcanzar la cola de re-transmisión de `settleAlreadySigned`: la cola SHALL exigir pertenencia explícita a `{absent, landed_failed}` |

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos (todos con `Read`; rutas confirmadas)

| Archivo | Por qué | Patrón / hallazgo extraído |
|---|---|---|
| `src/adapters/solana/payment.ts` (1181 L, **completo**) | Es el archivo a modificar | `checkTerms` `:1101-1130`; los dos call-sites `:640` y `:1164`; los 4 consumidores `:367`, `:452`, `:775`, `:1000`; el `try` que se cierra en `:624` |
| `src/adapters/types.ts` (`:14-60`, `:110-245`) | Dónde vive el tipo nuevo y qué NO tocar | `VerifyResult.indeterminate?: boolean` **ya existe** (`:28-43`) con su doctrina. `SettlementPresence` (`:170-187`) y su docstring-doctrina (`:132-168`) = *"toda pregunta tiene TRES respuestas"* |
| `src/lib/downstream-payment.ts` (`:355-545`) | El consumidor real del leg | El catch `:476-521` clasifica `SETTLE_UNKNOWN` vs `SETTLE_FAILED` por `readSettleValueDisposition`. El recibo (`:530-543`) usa `amountAtomic`, **no** lo medido |
| `src/adapters/errors.ts` (`:57-110`, `:145-232`) | El transporte de la incógnita | `FacilitatorSettleError.valueDisposition`; `readSettleValueDisposition` lee **por forma** (`name` + campo), no por `instanceof` |
| `src/adapters/solana/facilitator-settle.ts` (1-120) | El límite de confianza | `PAYOUT_NO_SPEND_CODES` (lista cerrada, default al lado seguro). El facilitator recibe sólo `payTo` base58: **la cuenta concreta la elige él** (§4.6) |
| `src/adapters/solana/payment.test.ts` (`:280-380`, `:590-625`) | Las fixtures y las aserciones que se van a mover | 4 sitios de fixture; ninguna con `accountIndex` |
| `src/adapters/solana/intent-dedup.test.ts` (`:340-382`, `:852-890`) | Idem + el canario | **`T-IDM-18b`** fija que un mismatch REAL sigue dando `SETTLE_SIGNED_TERMS_MISMATCH`. Es el test que impide sobre-corregir (§8.2) |
| `src/adapters/solana/payment.flag.test.ts`, `settle-wiring.test.ts` | Verificar radio de impacto | Mockean `getParsedTransaction` a `null` ⇒ **no llegan a `checkTerms`** ⇒ no se tocan |
| `node_modules/@solana/web3.js/lib/index.cjs.js` + `index.d.ts` | Alcanzabilidad real | V-1..V-3 + el hallazgo nuevo de §0 |
| `doc/sdd/213-wkh-315-.../sdd.md` + `story-HU-315.md` + `src/adapters/solana/deposit-verifier.ts` (wt-315) | El gemelo del lado ENTRADA | §7.2: qué se reusa y qué no |
| `doc/sdd/212-wkh-314-x402-inbound-solana/sdd.md` (`:470-540`, `:800-820`) | La HU que va a MOVER esta función | §7.1: colisión de merge real + `TD-INBOUND-MULTI-ATA` |

### 3.2 Exemplars verificados (existen; confirmados por `Read` directo)

| Para escribir | Seguir el patrón de | Qué se copia |
|---|---|---|
| El guard de presencia con tercer valor | **`payment.ts:586-596`** — *el mismo autor, 500 líneas antes, en el mismo archivo* | `if (!statuses \|\| !Array.isArray(statuses.value)) return {state:'unknown', detail}` + `if (length === 0) return {state:'unknown'}`. **Una lista ausente y una lista vacía son dos indeterminaciones distintas, y ninguna es un dato** |
| La unión discriminada de N valores con doctrina en el docstring | `types.ts:170-187` (`SettlementPresence`) y `:199-207` (`SettledPeek`) | Discriminante `string`, un comentario por variante que dice **qué autoriza y qué prohíbe** |
| El parseo defensivo de `uiTokenAmount.amount` | **`wt-315` `deposit-verifier.ts:438-449`** (`ATOMIC_AMOUNT_RE = /^\d+$/` + `atomicOf → bigint \| null`) | El razonamiento literal de por qué `try{BigInt(x)}` **no alcanza**: `BigInt('')`=`0n`, `BigInt('   ')`=`0n`, `BigInt('0x10')`=`16n` — el `catch` ni se ejecuta |
| La validación de **contenido**, no sólo de contenedor | **`wt-315` `deposit-verifier.ts:289-307`** (`isBalanceEntry`) | `preTokenBalances: [null]` tira `TypeError` en el primer `b.mint`. O se cierran todas las formas o la promesa *"NUNCA lanza"* se corrige |
| El `owner` ausente que **no descalifica** | **`wt-315` `deposit-verifier.ts:392-423`** | Un `owner` ausente leído como *"es de otro"* es **una afirmación sobre un dato ausente** |
| El delta negativo como indeterminación | **`wt-315` `deposit-verifier.ts:493-505`** | *"Si el número da negativo, lo que aprendimos es que los datos no son coherentes, no que la plata haya ido a otro lado"* |
| Tests de las ramas de `settle` con doble de ledger | `src/adapters/solana/intent-dedup.test.ts` (`seedRow`, `onChainOk`, `presenceState`) | Se reusa la infraestructura tal cual; sólo cambian las fixtures |

### 3.3 Auto-Blindaje histórico — patrones recurrentes que se vuelven CD

Buscados con `find doc/sdd -name 'auto-blindaje*.md'`. Los de las HUs recientes de esta
familia (207-215) **no existen en `main`**; el único disponible de la familia Solana es
`doc/sdd/213-.../auto-blindaje.md` **en el worktree `wt-315`** (29 KB, HU en vuelo, no DONE),
más los de HUs viejas (`134-`, `144-`, `191-`, `093-`). Se leyó el de 315 y se cruzó con
`§3.5` de su SDD, que ya consolida el barrido de `209-`, `208-` y `203-`.

| Patrón recurrente | Apariciones (≥2) | Se previene con |
|---|---|---|
| **"No pude preguntar" leído como negativa demostrada** | 209 §BLQ-MEDIO-1 · 209 §Wave-0 (×2) · HU-201 entera · 315 §BLQ-MED-1 y §BLQ-MED-3 · **y esta HU** | **CD-1**, **CD-2** |
| **Un `??` que fabrica el dato que el guard iba a mirar** | 315 §BLQ-BAJO-1 (`postByIndex.get(idx) ?? 0n` inflaba el techo del propio invariante) · **`payment.ts:1114-1115`** | **CD-3** |
| **Un fixture "del tipo correcto" que funciona por casualidad** | 209 §W3 (blockhash de 32 *caracteres*) · 209 §Hallazgo-1 · **V-5 de esta HU: el `'0'` es la única forma donde el bug es indistinguible del comportamiento correcto** | **CD-4** |
| **Falso KILLED / la suite reporta algo que no habla del código** | 209 §M12 · 208 §M5 | **CD-5** |
| **Un guard que se compara consigo mismo** | 315 §BLQ-BAJO-1 (el invariante recalculaba su propia fórmula) | **CD-6** |
| **Un gate/precondición que nadie corre no es un gate** | 209 §MNR-4 · 209 §MNR-1 | **CD-7** |

---

## 4. Diseño técnico

### 4.1 Archivos a crear/modificar

| # | Archivo | Acción | Qué hace | Wave | AC |
|---|---|---|---|---|---|
| 1 | `src/adapters/types.ts` | Modificar (**bloque aditivo al final**) | `SolanaTermsVerdict` — unión de 3, discriminante `verdict` | W0 | AC-1..8 |
| 2 | `src/adapters/solana/payment.ts` · `checkTerms` | **Reescribir el cuerpo** + firma | El corazón (§4.3-§4.6) | W0 (firma) / W1 (cuerpo) | AC-1..9 |
| 3 | `src/adapters/solana/payment.ts` · `probeSettlementPresence:640-643` | Modificar | `switch` exhaustivo + `try` externo | W0/W1 | AC-1, AC-9 |
| 4 | `src/adapters/solana/payment.ts` · `verify():1144-1165` | Modificar | `indeterminate:true` + corregir el docstring caduco | W2 | AC-14 |
| 5 | `src/adapters/solana/payment.ts` · `settleAlreadySigned:500-517` | Modificar | Lista-blanca explícita en la cola | W2 | AC-15 |
| 6 | `src/adapters/solana/payment.test.ts` | Modificar (4 fixtures) + tests nuevos | §8 | W1-W2 | todos |
| 7 | `src/adapters/solana/intent-dedup.test.ts` | Modificar (2 fixtures) + tests nuevos | §8 | W1-W2 | AC-10..13 |
| 8 | `doc/sdd/216-.../_INDEX-row.md`, `doc/sdd/_INDEX.md` | Crear/Modificar | Cierre | W3 | — |

**Ningún archivo más.** No hay migraciones, no hay envs nuevas, no hay dependencias nuevas.

### 4.2 DT-1 — El tercer valor, y por qué el discriminante NO puede ser `ok`

```ts
// src/adapters/types.ts — bloque ADITIVO, al final del área Solana.
/**
 * WKH-319 — veredicto de TERMINOS sobre una tx ya parseada.
 *
 * ⚠️ POR QUE TRES VALORES Y NO DOS. `checkTerms` devolvia
 * `{ok:true} | {ok:false; error}`, y esa union de DOS respondia una pregunta de TRES:
 * *coincide* / *no coincide* / **no pude medirlo**. Sin el tercero, toda forma de dato
 * ilegible —una lista ausente, una entrada truncada, un `amount` que no es un entero—
 * tenia que aterrizar en uno de los dos, y aterrizaba en el equivocado: con
 * `preTokenBalances` ausente el `?? []` fabricaba la lista, `delta` pasaba a ser el
 * SALDO ABSOLUTO de payTo, y una tx donde payTo GASTA se certificaba como nuestro pago.
 *
 * ⚠️ POR QUE EL DISCRIMINANTE ES `verdict: string` Y NO `ok`.
 *  1. `ok: true | false | 'unknown'` seria PEOR que la union de dos: `if (terms.ok)` da
 *     **true** para `'unknown'` — un fail-open silencioso con forma de arreglo.
 *  2. Renombrar el campo hace que **cada lectura vieja deje de compilar**. El colapso no
 *     se previene con un comentario que pida no hacerlo: se previene haciendo que no
 *     compile. Los dos call-sites (`payment.ts:640`, `:1164`) tienen que ser revisitados
 *     a mano, y ese es exactamente el punto.
 *
 * `creditedAtomic` viaja SOLO en `match`: es el hecho MEDIDO, no el que pedimos. Existe
 * para que el log y (mas adelante) el recibo puedan cerrar sobre el mismo hecho — hoy el
 * recibo usa el monto que CREEMOS haber pagado (`downstream-payment.ts:530-543`).
 * String, no bigint, por la convencion de la casa: los atomicos viajan como string.
 */
export type SolanaTermsVerdict =
  /** Medido: el conjunto receptor subio >= lo requerido. */
  | { verdict: 'match'; creditedAtomic: string }
  /**
   * MEDIDO y no alcanza. Exige que las dos listas esten presentes, sean interpretables
   * y esten COMPLETAS sobre el conjunto receptor. Es una negativa demostrada.
   */
  | { verdict: 'mismatch'; detail: string }
  /**
   * No se pudo medir. NO es una negativa: no autoriza condenar una fila ni
   * re-transmitir. El caller lo traduce a `SettlementPresence.unknown`.
   */
  | { verdict: 'indeterminate'; detail: string };
```

**Alternativa considerada y descartada:** reusar `VerifyResult` con `indeterminate?: boolean`.
Rechazada porque el campo es **opcional**: un call-site que lo ignore vuelve a colapsar, y no
hay nada que lo rompa. La unión discriminada obliga.

### 4.3 DT-2 — Cómo viaja `indeterminate` hasta los cuatro consumidores

**Se traduce a `SettlementPresence.unknown`, que ya existe y ya significa exactamente eso.**

```ts
// probeSettlementPresence, reemplaza :640-643
let terms: SolanaTermsVerdict;
try {
  terms = this.checkTerms(parsed, proof);
} catch (err) {
  // Cinturón Y tirantes (CD-6): los guards de §4.4 hacen que esto no ocurra, pero la
  // promesa "NUNCA lanza" del docstring tiene que ser ESTRUCTURALMENTE cierta, no
  // argumentada. Un guard que se sostiene sobre su propio razonamiento no es un guard.
  return { state: 'unknown', detail: `terms_threw: ${errText(err)}` };
}
switch (terms.verdict) {
  case 'match':
    log.info(
      { signature: proof.signature, payTo: proof.payTo,
        requiredAtomic: proof.amountAtomic, creditedAtomic: terms.creditedAtomic },
      'solana terms verified on-chain',
    );
    return { state: 'landed_ok' };
  case 'mismatch':
    return { state: 'landed_mismatch', detail: terms.detail };
  case 'indeterminate':
    return { state: 'unknown', detail: terms.detail };
}
```

`switch` **exhaustivo y sin `default`**: agregar una cuarta variante rompe la compilación del
tipo de retorno. Es la segunda mitad de "que el colapso no compile".

**Por qué NO se agrega un sexto estado `terms_indeterminate` a `SettlementPresence`** — y esta
es la decisión más importante del SDD:

1. **Semánticamente sería un duplicado.** `unknown` ya está documentado como *"No se pudo
   preguntar. NUNCA autoriza re-transmitir"* (`types.ts:186-187`). "No pude medir los
   términos" es un caso de eso.
2. **Sería un bug de dinero.** Los cuatro consumidores discriminan con **cadenas de `if`, no
   con `switch` exhaustivo**. `settleAlreadySigned` chequea `landed_ok` (`:458`), `unknown`
   (`:478`), `landed_mismatch` (`:490`) y después **cae a una cola que asume `absent` o
   `landed_failed`** (`:500-554`) y **re-transmite** tras probar la expiración. Un estado nuevo
   que nadie agregue a esa cadena **cae en la rama que paga de nuevo**, en silencio, sin que
   TypeScript diga una palabra. Meter un estado nuevo en `SettlementPresence` con el código
   de hoy es plantar un segundo pago.
3. **`SettlementPresence` está congelado por contrato** con WKH-314 (R1) y WKH-315 (CD-3).

Lo que **sí** se hace es cerrar esa trampa para el próximo (AC-15, §4.7) y no perder
diagnosticabilidad: **todo `detail` de indeterminación de términos lleva el prefijo estable
`terms_`** (`terms_pre_list_absent`, `terms_entry_shape`, `terms_amount_unreadable`,
`terms_pre_row_missing`, `terms_post_row_missing`, `terms_negative_delta`,
`terms_unclassifiable_entry`, `terms_threw`). El operador distingue en el log *"el RPC no
contestó"* (reintentar contra otro nodo, se destraba solo) de *"las listas de balances no se
pudieron interpretar"* (el mismo nodo va a volver a fallar). **CD-8.**

### 4.4 DT-3 — El cuerpo nuevo de `checkTerms`, guard por guard

Orden fijo. Cada paso **sólo puede** devolver `indeterminate` o seguir; `mismatch` es
**siempre el último** y exige que todo lo anterior haya salido bien.

**Paso 1 — Presencia de las listas (guard (a)).** Copia estructural de `:586-596`.

```ts
const preRaw = meta.preTokenBalances;
const postRaw = meta.postTokenBalances;
if (!Array.isArray(preRaw) || !Array.isArray(postRaw)) {
  return { verdict: 'indeterminate', detail: `terms_list_absent: pre=${Array.isArray(preRaw)} post=${Array.isArray(postRaw)} — an absent list is not an empty one` };
}
```

> **Muere acá:** `pre` ausente, `pre: null`, `post` ausente, `post: null`, y el "fail-closed
> por accidente" (las dos ausentes) pasa a ser fail-closed **por diseño**.
> **El `?? []` de `:1114-1115` desaparece del archivo. CD-3.**

**Paso 2 — Forma de las entradas.** El esquema garantiza `mint: string` y
`accountIndex: number`; el guard existe porque **el esquema no es el único productor** (un
doble de test, un fixture, un `as unknown as` en el futuro) y porque `[null]` tira `TypeError`
en el primer `b.mint` (medido en WKH-315).

```ts
const isEntry = (b: unknown): b is TokenBalanceLike =>
  typeof b === 'object' && b !== null &&
  typeof (b as {mint?: unknown}).mint === 'string' &&
  typeof (b as {accountIndex?: unknown}).accountIndex === 'number' &&
  typeof (b as {uiTokenAmount?: {amount?: unknown}}).uiTokenAmount?.amount === 'string';
if (!preRaw.every(isEntry) || !postRaw.every(isEntry)) {
  return { verdict: 'indeterminate', detail: 'terms_entry_shape: ...' };
}
```

**Paso 3 — El monto de una entrada, sin `BigInt` crédulo (guard (e)).**

```ts
const ATOMIC_RE = /^[0-9]+$/;
const atomicOf = (b: TokenBalanceLike): bigint | null =>
  ATOMIC_RE.test(b.uiTokenAmount.amount) ? BigInt(b.uiTokenAmount.amount) : null;
```

> **Muere acá** la familia `''`, `'   '`, `'0x10'`, `'+5'` — donde el `catch` de un
> `try{BigInt()}` **ni siquiera se ejecuta**. `null` significa *"no pude medir"*, **nunca**
> cero: cualquier `null` en una entrada relevante ⇒ `indeterminate`
> (`terms_amount_unreadable`). CD-2.

**Paso 4 — El conjunto receptor, agregado por `accountIndex` (guard (d)).**

```ts
const isOurs = (b: TokenBalanceLike): boolean =>
  b.mint === mint && declaredOwner(b) === proof.payTo;   // W1
// W2 amplía: || addressAt(b.accountIndex) === expectedAta   (§4.6)
```

Se construyen **dos `Map<number, bigint>`** (`preOurs`, `postOurs`) con las entradas nuestras,
indexadas por `accountIndex`.

> **El `find` de `:1117-1119` desaparece.** No se lo reemplaza por "fijar el `accountIndex`
> del `post` y buscar ese mismo en `pre`", sino por **agregación sobre todas las cuentas
> nuestras, emparejadas por índice**. Es estrictamente mejor:
> - resuelve el bug reportado (los dos `find` resolviendo a cuentas distintas) **por
>   construcción**: ya no hay "la primera";
> - mide el hecho económico correcto — *"las tenencias de USDC de payTo subieron ≥ required"*—
>   que es lo que el recibo afirma, y es robusto a **cuál** de sus cuentas recibió;
> - **no importa ningún supuesto nuevo sobre el facilitator** (§4.6), a diferencia de fijar la
>   ATA como única cuenta admisible.
>
> **Decisión sobre si (d) entra al corte: SÍ, entra en W1.** El encargo lo deja a criterio
> porque la explotabilidad on-chain no está demostrada. Entra igual por tres razones: (i) el
> costo es **cero** —la agregación es la misma pasada que ya hace falta para los guards de
> simetría del Paso 5, así que no entra código extra por (d)—; (ii) su modo de falla es
> `landed_mismatch` sobre un pago REAL, o sea el fail-**closed** que en `settleAlreadyConfirmed`
> **condena la fila para siempre** (§5.3): no es benigno aunque no sea explotable; (iii) deja
> cerrado `TD-INBOUND-MULTI-ATA`, que WKH-314 parkeó como riesgo R-4 con un "preflight
> ruidoso" como mitigación (§7.1) — mitigación que deja de hacer falta.

**Paso 5 — Completitud del conjunto receptor (guard (c), §4.5).** Ver abajo.

**Paso 6 — El veredicto.**

```ts
const delta = sum(postOurs) - sum(preOurs);
if (delta < 0n) {
  // Guard (b). Para una tx que construimos nosotros, un delta negativo es FISICAMENTE
  // IMPOSIBLE: el destino no gasta. Si el numero da negativo, lo que aprendimos es que
  // los datos no son coherentes — NO que el pago haya ido a otro lado.
  // Hoy sale `landed_mismatch` ⇒ en la rama `confirmed` eso es
  // SETTLE_CONFIRMED_BUT_UNVERIFIABLE: **condena permanente con salida manual** por una
  // causa que nunca se midio. Va ANTES del `< required` para no quedar tapado por el.
  return { verdict: 'indeterminate', detail: `terms_negative_delta: ${delta}` };
}
if (delta < required) {
  return { verdict: 'mismatch', detail: `on-chain transfer ${delta} < required ${required} for ${proof.payTo}` };
}
return { verdict: 'match', creditedAtomic: delta.toString() };
```

### 4.5 DT-4 — La ATA creada en la misma tx, distinguida de una lista truncada

**El problema:** una fila ausente en `pre` para una cuenta que sí está en `post` tiene **dos
causas con consecuencias opuestas**:

- **legítima** — la cuenta **no existía** antes de esta tx (ATA creada in-tx). Su saldo previo
  era genuinamente `0` y tomarlo como `0` es correcto **por construcción**;
- **el bug** — la lista llegó truncada. Tomarlo como `0` fabrica el dato y **es exactamente el
  fail-open** que esta HU cierra.

**El discriminador: `meta.preBalances[accountIndex]`.**

`preBalances` / `postBalances` son `superstruct.array(superstruct.number())` **obligatorios**
(§0, hallazgo nuevo) e indexados por el **mismo espacio** que `accountIndex`. Una cuenta que no
existía antes de la tx tiene **0 lamports** en `preBalances`. Una cuenta de token que existía
es **rent-exempt**: su saldo en lamports es estrictamente `> 0`. La regla:

```
para cada índice i del conjunto receptor presente en post y AUSENTE en pre:
    si meta.preBalances[i] === 0        → saldo previo = 0n        (ATA creada in-tx, AC-4)
    en cualquier otro caso              → indeterminate            (AC-3)
                                          detail: terms_pre_row_missing
```

`preBalances` ausente / no-array / índice fuera de rango / valor `!== 0` ⇒ **indeterminate**.
Nunca "asumir 0".

**Y la regla simétrica (AC-5).** Un índice nuestro presente en `pre` y ausente en `post`
significa cuenta cerrada en la tx; su saldo posterior real es `0`. El discriminador espejo es
`meta.postBalances[i] === 0`. **La simetría no es estética**: sin ella, dropear una fila
nuestra del lado `post` hace que el delta se vea **más chico** y produce un `landed_mismatch`
falso sobre un pago real — el mismo error, en la otra dirección.

**Lectura perezosa (decisión deliberada).** `preBalances`/`postBalances` se leen **sólo cuando
aparece una asimetría**. Una tx simétrica (el caso normal, y el de las 6 fixtures actuales)
nunca los toca. Beneficios: no se agrega indeterminación gratuita, y la churn de fixtures baja
a "agregar `accountIndex`" (§8.3).

**Por qué NO se usa el invariante de conservación global de WKH-315:** §7.2.

### 4.6 DT-5 — El `owner` ausente, y hasta dónde llega la identidad por dirección

`owner` es `optional(string())` (V-2). Hoy `entry.owner === proof.payTo` con `owner` ausente
da `false`, la entrada se descarta, y el delta se sub-mide ⇒ `landed_mismatch` sobre un pago
real. Es **la misma clase de error que el fail-open, en la otra dirección**: una afirmación
("la plata fue a otro lado") hecha sobre un dato **ausente**. WKH-315 llegó a esto de forma
independiente (`deposit-verifier.ts:414-423`).

**W1 (corte mínimo):** una entrada de nuestro mint con `owner` ausente **no es nuestra**, pero
**si existe al menos una** y el delta medido resulta `< required`, el veredicto es
**`indeterminate`** (`terms_unclassifiable_entry`), **no `mismatch`**. Fundamento: una entrada
no clasificada sólo puede **agregar** al lado que no medimos; si aún así el delta medido ya
alcanza, la afirmación positiva es sólida (medir de menos no puede volver verdadero un
`>=` falso). Si **no** alcanza, no podemos afirmar la negativa.

**W2 (endurecimiento):** se agrega el **tier de dirección**, que hace la mayoría de esos casos
**medibles** en vez de indeterminados:

```
esOurs(i)  ⇔  mint(i) === mintConfigurado  ∧  ( addressAt(i) === expectedAta ∨ owner(i) === payTo )
expectedAta = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(payTo))
addressAt(i) = accountKeys[i].pubkey?.toBase58?.() ?? accountKeys[i].toBase58?.()
```

- Es una **UNIÓN**, no una conjunción. Ninguna de las dos identidades puede sub-medir a la
  otra. Exigir las dos (como hace el depósito, CD-5 de 315) sería correcto allá —donde el
  destino es **nuestra** cuenta publicada— e **incorrecto acá**.
- **Por qué no se PINEA la ATA como única cuenta admisible** (que sería la lectura literal de
  "fijar `accountIndex`"): en el camino local la ATA sí es exactamente la cuenta a la que
  transferimos (`signPersistBroadcast:845-850` usa `getOrCreateAssociatedTokenAccount`), pero
  en el camino del **facilitator** nosotros mandamos sólo `payTo` base58
  (`facilitator-settle.ts:42-47`) y **la cuenta concreta la elige él**. Pinear la ATA
  importaría un supuesto **no verificable desde este repo** sobre un sistema externo, y su
  modo de falla sería `landed_mismatch` sobre un pago real. La unión lo evita.
- `new PublicKey(...)` y `getAssociatedTokenAddressSync(...)` **lanzan** (base58 inválido,
  owner off-curve). Van envueltos: si `expectedAta` no se puede derivar, el tier de dirección
  simplemente **no está disponible** y se cae al tier de `owner`. **Nunca propaga el throw.**
- `accountKeys` se lee **a la defensiva** (`parsed.transaction?.message?.accountKeys`), aunque
  el esquema lo declare obligatorio: es la lección literal de `deposit-verifier.ts:334-347`,
  donde el único acceso encadenado sin proteger producía un 500 en vez de un 503. Si no es un
  array, el tier de dirección no está disponible (no es indeterminación por sí solo).

### 4.7 DT-6 — Cerrarle la trampa al próximo (AC-15)

`settleAlreadySigned:500-554` termina asumiendo *"llegados acá la presencia es `absent` o
`landed_failed`"* y, tras la prueba de expiración, **re-transmite**. Es una afirmación
**correcta hoy** y **no verificada por el compilador**. Cambio:

```ts
if (presence.state !== 'absent' && presence.state !== 'landed_failed') {
  // Lista BLANCA, no cola por descarte. Solo estos dos PRUEBAN que la transferencia no
  // ocurrio. Cualquier estado que se agregue a SettlementPresence en el futuro cae acá y
  // fail-closea, en vez de caer en la rama que vuelve a pagar.
  throw new Error(`SETTLE_PRESENCE_UNHANDLED: ${req.intentId} (${presence.state})`);
}
```

Cambio de forma, no de comportamiento: con los 5 estados de hoy es inalcanzable. Existe para
que el sexto —que **no** agrega esta HU (§4.3)— falle cerrado.

### 4.8 DT-7 — El hecho medido queda disponible, el recibo no cambia (todavía)

`match` devuelve `creditedAtomic`. Se **loguea** en el `landed_ok` de
`probeSettlementPresence` y **no viaja más arriba**, porque:

- `SettlementPresence` está congelado (§2) y `landed_ok` no tiene campos;
- el recibo (`downstream-payment.ts:530-543`) escribe `settledAmount: amountAtomic` y
  `nonEvmSettle.amountUsd` derivado del **mismo** atómico: son el monto que **pedimos**, no el
  que se **midió**. Cerrar ese lazo es el análogo de salida del cambio estructural de WKH-315
  y necesita superficie nueva en `SettleResult` + `settleSolanaLeg` + el ledger.

**Se deja anotado como TD-319-1** (§9). El desvío hoy está **acotado y del lado seguro para el
agente**: `checkTerms` sólo aprueba con `delta >= required`, así que el recibo puede
sub-declarar (si el facilitator pagó de más) pero **nunca sobre-declarar**.

---

## 5. Los cuatro consumidores, uno por uno

El resultado de §4.3 es que `indeterminate` llega a los cuatro como `unknown`, y **los cuatro
ya tienen escrita la rama correcta**. Lo que sigue no es diseño nuevo: es la **verificación,
consumidor por consumidor, de que esa rama es la conducta correcta para esta causa nueva** —
que es lo que el encargo pide resolver.

### 5.1 `settleAlreadySigned` (`:452`) — el peor caso

- **Hoy:** un intent firmado que no aterrizó puede salir `landed_ok` ⇒ `recordConfirmedIntent`
  ⇒ **la fila se marca `confirmed`**, se devuelve `success:true`, **el agente nunca cobra** y
  el reintento queda **clausurado** (la próxima vez entra por `settleAlreadyConfirmed`, que ya
  no re-transmite nunca).
- **Con el fix:** `unknown` ⇒ `:478-486` ⇒ `SETTLE_IN_FLIGHT_UNRESOLVED`. **Ni confirma ni
  re-transmite** — que es exactamente lo que el encargo señala como difícil, y ya está escrito.
- **Por qué esa es la conducta correcta, y no otra:** la fila queda en `signed` **con su
  `last_valid_block_height` intacto**, o sea que sigue siendo **reconciliable**. El reintento
  vuelve a preguntar; si el RPC mejora, resuelve a `landed_ok` (marca confirmado) o a
  `absent` + blockhash expirado (re-firma legítimamente). La indeterminación **no consume
  ninguna prueba** y no cierra ninguna puerta.
- **Riesgo aceptado, y su salida:** si la indeterminación es **permanente** (por ejemplo, un
  nodo que sistemáticamente devuelve listas de balances truncadas), el intent queda trabado
  esperando. Es **fail-closed** —no cuesta un peso— y por eso el `detail` con prefijo `terms_`
  es obligatorio (**CD-8**): distingue en el log *"el RPC no contestó"* (se destraba solo) de
  *"las listas no se pudieron interpretar"* (cambiar de endpoint). La salida manual es la
  misma que ya existe: `doc/sdd/209-.../runbook-destrabe.md`.

### 5.2 `settleViaFacilitator` (`:775`) — el único cruce de límite de confianza

- **Hoy:** `checkTerms` es la **única** verificación de que el facilitator movió la plata. Un
  `landed_ok` fabricado ⇒ `recordConfirmedIntent` ⇒ la fila salta a `confirmed` **con la cadena
  sin respaldarlo**. Y `confirmed` es un estado del que no se vuelve: si más tarde la cadena
  dice `absent`, `settleAlreadyConfirmed` **condena la fila para siempre**. El fail-open de
  hoy no cobra un doble pago acá: **fabrica la condena de mañana**.
- **Con el fix:** `unknown` ⇒ rama `else` de `:791-802` ⇒ **la fila queda en `signed` con la
  cota**, y un retry posterior la reconcilia por `settleAlreadySigned`. Correcto y ya escrito.
- **Lo que NO cambia, con su razón:** `:813` devuelve `success:true` igual. Es pre-existente y
  deliberado — el facilitator respondió 2xx sobre un pago probablemente real, y devolver
  `false` dispara **reembolso y/o re-envío del hop** (`downstream-payment.ts:522-528`). Bajar
  eso a `SETTLE_UNKNOWN` es un cambio de conducta del leg que excede esta HU y depende de
  TD-319-1. **Se documenta, no se toca.**

### 5.3 `settleAlreadyConfirmed` (`:367`) — donde el fix más gana

- **Hoy, dos daños opuestos:** (i) un `landed_ok` fabricado desarma el re-check de forks — que
  es **la única defensa** contra un `confirmTransaction` a commitment `confirmed` (optimista)
  cuyo bloque quedó fuera de la cadena canónica; (ii) por el camino inverso, un delta negativo
  o una lista truncada produce `landed_mismatch` ⇒ **`SETTLE_CONFIRMED_BUT_UNVERIFIABLE`**, que
  es **condena permanente con salida manual** (`:425-427`) por una causa que nunca se midió.
- **Con el fix:** `unknown` ⇒ `:385-393` ⇒ `SETTLE_PRESENCE_UNKNOWN`, **transitorio**,
  explícitamente escrito para no condenar la fila (AR BLQ-MEDIO-1 de WKH-307). El próximo
  retry vuelve a preguntar.
- **Es la razón principal por la que el guard (b) —delta negativo— entra al corte mínimo**: sin
  él, una lista `post` truncada sobre una fila `confirmed` **condena un intent sano**.

### 5.4 `recoverConfirmedSettle` (`:1000`) — el self-heal

- **Hoy:** un `landed_ok` fabricado marca confirmado y devuelve `{success:true}` sobre un pago
  que puede no haber ocurrido ⇒ recibo escrito, leg cerrado, agente sin cobrar.
- **Con el fix:** `unknown` ⇒ `:1006-1030` ⇒ `FacilitatorSettleError(..., 'unknown')` ⇒
  `readSettleValueDisposition` ⇒ **`SETTLE_UNKNOWN`** en `settleSolanaLeg`
  (`downstream-payment.ts:501-520`). El leg se publica como *"no sé"*, no como *"falló"*.
- **Nota (no es un cambio, es una consecuencia):** el `landed_mismatch` que hoy cae en
  `:1046-1049` → `undefined` → `throw e` → `SETTLE_FAILED` **deja de recibir** las causas de
  forma de lista. Le siguen llegando los mismatch **medidos**, que es lo que el comentario de
  `:1035-1045` dice que quiere (*"si alguna vez dispara en producción, merece mirada humana"*)
  — y ahora eso es verdad, porque ya no dispara por un `null` del transporte.

### 5.5 `verify()` — muerto hoy, se despierta con WKH-314

`verify()` no tiene **ningún** call-site de producción (verificado: los 41 `adapter.verify(`
del repo son de otros adapters o de tests; los de Solana están en `payment.test.ts:335,346` y
`devnet-e2e.manual.test.ts:142`). WKH-314 lo despierta.

Se lo deja correcto **ahora**:

1. `checkTerms → 'indeterminate'` ⇒ `{ valid: false, indeterminate: true, error }`. El campo
   **ya existe** en `VerifyResult` (`types.ts:42`) con exactamente esta doctrina escrita.
2. **El `!parsed?.meta` de `:1144-1156` también pasa a `indeterminate: true`**, y su docstring
   —que hoy dice que flipearlo *"APAGA el self-heal de WKH-235a"*— **queda caduco y hay que
   corregirlo**: WKH-308 sacó el self-heal de `verify()` y lo puso en
   `probeSettlementPresence` (`:986-1004`). El peligro que ese comentario describe **ya no
   existe**, y dejarlo escrito hace que el próximo lector crea que no puede tocarlo.
   Verificado que no rompe tests: `payment.test.ts:343-352` sólo asserta `valid === false`.
3. `verify()` **NO** cambia su `valid` para ningún caso: `indeterminate` es aditivo. Un
   consumidor futuro que lo ignore se comporta como hoy; uno que lo lea distingue.

---

## 6. Waves de implementación

### W0 — Serial gate: el contrato (nada empieza sin esto)

| Tarea | Archivo | Qué |
|---|---|---|
| W0.1 | `src/adapters/types.ts` | `SolanaTermsVerdict` (§4.2), bloque **aditivo al final**. **No se toca `SettlementPresence`** |
| W0.2 | `payment.ts:1101-1130` | Cambiar **sólo la firma** de `checkTerms` a `SolanaTermsVerdict` y adaptar el cuerpo actual al discriminante nuevo (`{verdict:'match', creditedAtomic: delta.toString()}` / `{verdict:'mismatch', detail}`). **Cero guards nuevos todavía** |
| W0.3 | `payment.ts:640-643` | El `switch` exhaustivo + el `try` externo (§4.3) |
| W0.4 | `payment.ts:1164-1165` | Adaptar `verify()` al discriminante nuevo (sin `indeterminate` todavía) |
| W0.5 | — | `npx tsc --noEmit` **completo** (no sólo `npm run build`: lección de WKH-196) + suite Solana verde **sin tocar fixtures** |

**W0 es un no-op de comportamiento.** Su valor es que **`indeterminate` ya no tiene dónde
colapsar** cuando W1 empiece a producirlo, y que los dos call-sites quedaron revisitados a mano
porque el compilador los rompió.

### W1 — **EL CORTE MÍNIMO** (serial: mismo archivo, misma función)

| Tarea | Qué | AC |
|---|---|---|
| W1.1 | Paso 1 — presencia de listas; **borrar los dos `??  []`** | AC-1 |
| W1.2 | Paso 2 — `isEntry` (forma de las entradas) | AC-2, AC-9 |
| W1.3 | Paso 3 — `ATOMIC_RE` + `atomicOf → bigint \| null`; cualquier `null` relevante ⇒ `indeterminate` | AC-2, AC-9 |
| W1.4 | Paso 4 — conjunto receptor agregado por `accountIndex`; **eliminar el `find`** | AC-7 |
| W1.5 | Paso 5 — completitud simétrica con `pre/postBalances` (§4.5), **lectura perezosa** | AC-3, AC-4, AC-5 |
| W1.6 | Paso 6 — delta negativo ⇒ `indeterminate`, **antes** del `< required` | AC-6 |
| W1.7 | `owner` ausente: `indeterminate` sólo si el delta medido no alcanza (§4.6, W1) | AC-8 |
| W1.8 | **Actualizar las 6 fixtures** (§8.3) + los tests T-319-1..11 (§8.1) | todos |

> ### ⛔ ACÁ CORTA EL CORTE MÍNIMO — `W0 + W1` es shippable solo
>
> Después de W1, **las cinco formas del input** que disparan el fail-open están cerradas
> (`pre` ausente · `null` · vacía · presente sin la entry · con entry pero sin `owner`), más la
> familia de `amount` (`''`, `'   '`, `'0x10'`, `'+5'`), más el delta negativo, más el `find`.
> **La repro central deja de devolver `ok:true`.**
>
> Es **un tipo nuevo, una función reescrita y dos call-sites** — ~150 líneas de producción, un
> archivo de producción, cero migraciones, cero envs, cero cambios de contrato público.
> **Recomendación: mergear W0+W1 apenas pase AR/CR, sin esperar a W2/W3.** Esto corre hoy.
>
> Lo que **queda abierto** después del corte (y por qué no es urgente): el `owner` ausente
> produce `indeterminate` en vez de una medición (ruido operativo, fail-closed, W2.1); un
> estado nuevo de `SettlementPresence` seguiría cayendo en la cola de re-transmisión (nadie lo
> está agregando, W2.3); `verify()` sigue sin `indeterminate` (**muerto en producción hoy**,
> W2.2).

### W2 — Endurecimiento (paralelizable: tres tareas independientes)

| Tarea | Qué | AC |
|---|---|---|
| W2.1 | Tier de dirección para el `owner` ausente (§4.6): `expectedAta` + `addressAt`, **envueltos** | AC-8 |
| W2.2 | `verify()` ⇒ `indeterminate:true` en las dos negativas no medidas + **corregir el docstring caduco de `:1144-1156`** | AC-14 |
| W2.3 | Lista-blanca en la cola de `settleAlreadySigned` (§4.7) | AC-15 |
| W2.4 | `creditedAtomic` en el log del `landed_ok` (§4.8) | — |

### W3 — Evidencia y cierre

| Tarea | Qué |
|---|---|
| W3.1 | **Campaña de mutación** (§8.4). Respaldo físico + hash antes de mutar; **prohibido `git checkout --`** sobre trabajo sin commitear |
| W3.2 | `doc/sdd/216-.../_INDEX-row.md` + fila en `doc/sdd/_INDEX.md` |
| W3.3 | `auto-blindaje.md` de la HU |
| W3.4 | Nota en `doc/sdd/212-wkh-314-.../` sobre la enmienda que necesita su §7.1 (§7.1 de acá) |

**Estimación:** W0 ≈ 1 h · W1 ≈ 4-5 h (la mitad son fixtures y tests) · W2 ≈ 2 h · W3 ≈ 2 h.

---

## 7. Interacción con las HUs en vuelo, y orden de merge

Estado verificado con `git log main..HEAD` en cada worktree:

| HU | Worktree | Commits sobre `main` | Toca `payment.ts` | Toca `adapters/types.ts` |
|---|---|---|---|---|
| WKH-313 | `wt-313` | 5 | No | No (toca `src/types/index.ts`, **otro archivo**) |
| WKH-314 | `wt-314` | **0 — sin empezar** | **SÍ, lo va a MOVER** | No |
| WKH-315 | `wt-315` | 5+ | **No** (prohibido por su propia story: *"CERO cambios, git diff vacío"*) | **Sí (+65, aditivo)** |
| WKH-316 | `wt-316` | 0 | No | No |
| WKH-318 | `wt-318` | 1 | No | No |
| **WKH-319** | `wt-319` | — | **Sí** | **Sí (aditivo)** |

### 7.1 La colisión real: WKH-314 va a MOVER esta función

El SDD de WKH-314 (`doc/sdd/212-.../sdd.md:474-531`) declara que **es la dueña de promover el
primitivo**: extrae `probeSettlementPresence` y `checkTerms` a un módulo nuevo
`src/adapters/solana/presence.ts` como funciones libres, y deja `payment.ts` delegando. Y
declara explícitamente:

> *"Qué NO se cambia, a propósito: el `.find()` de `checkTerms`. Es una fuente conocida de
> falso `landed_mismatch` (DT-8) y arreglarlo cambiaría el comportamiento del leg de salida.
> Se mitiga con un preflight ruidoso, no con un cambio silencioso en un camino de dinero
> recién shipeado. Queda como **TD-INBOUND-MULTI-ATA**."*

**Recomendación de orden: WKH-319 → WKH-314.** Razones:

1. **314 no está empezada** (0 commits). Reordenar no cuesta trabajo tirado.
2. **319 es un fail-open vivo en el camino que paga.** 314 es una feature.
3. Si 314 va primero, 319 tiene que reescribir `presence.ts` — que es el archivo cuya prueba de
   corrección es *"la suite del adapter queda verde **sin modificarse**"*. Esa prueba **no
   puede sobrevivir** a 319, que cambia 6 fixtures y la firma de la función. Las dos HUs se
   pisarían el criterio de aceptación, no sólo el texto.
4. Si 319 va primero, **314 extrae la función ya arreglada** —su §7 sigue siendo válido
   palabra por palabra— y **`TD-INBOUND-MULTI-ATA` se cierra sin trabajo**: su riesgo R-4 y su
   DT-8 ("preflight que falla ruidoso") **dejan de hacer falta**.

**Enmienda que 314 va a necesitar** (W3.4): la firma publicada en su §7.1,
`checkSplTransferTerms(...): { ok: true } | { ok: false; error: string }`, pasa a
`SolanaTermsVerdict`. Es un cambio de una línea en su SDD y **mejora** su contrato: la HU de
entrada necesita el tercer valor todavía más que la de salida.

### 7.2 WKH-315 — qué se reusa y qué NO (y por qué)

WKH-315 resuelve **el bug gemelo del lado ENTRADA**. Se leyó su SDD (`§4.8`, `§7.1`), su story
file y **su implementación** (`wt-315/src/adapters/solana/deposit-verifier.ts`, 712 L).

**SE REUSA — la doctrina y cuatro primitivos, transcritos, no importados:**

| Qué | De dónde | Por qué transcrito y no importado |
|---|---|---|
| `ATOMIC_AMOUNT_RE = /^\d+$/` + `atomicOf → bigint \| null` | `deposit-verifier.ts:438-449` | Son 6 líneas. Importar crearía una dependencia `payment.ts → deposit-verifier.ts` **al revés** de la que 315 diseñó (315 es quien lee de `payment.ts`, no al contrario), justo mientras 315 está en vuelo |
| `isBalanceEntry` (validar contenido, no sólo contenedor) | `:289-307` | Idem |
| `declaredOwner` + *"el `owner` ausente no descalifica"* | `:392-423` | Idem — y acá se usa como **unión** con la dirección, no como conjunción (§4.6) |
| Delta negativo ⇒ indeterminación | `:493-505` | El razonamiento es idéntico; el enunciado cambia de lado (la cuenta receptora no gasta) |

**Regla anti-duplicación, honesta:** lo compartido es **la doctrina, no la función** — que es
textualmente la decisión que 315 tomó respecto de `probeSettlementPresence` (su §7.1, DT-8). Y
la convergencia real ya tiene dueño: cuando **WKH-314** promueva `presence.ts` (§7.1), ése es
el lugar natural para que estos cuatro primitivos vivan una sola vez. **Se anota como
TD-319-2**, no se fuerza ahora contra dos HUs en vuelo.

**NO SE REUSA — y esto es lo importante:**

| Qué de 315 | Por qué NO |
|---|---|
| **El invariante de conservación global** (`totalUp === totalDown` sobre todas las entradas del mint, `:518-587`) | **Responde una pregunta que la salida no tiene.** El depósito **descubre** un monto que no conocía y necesita que las dos listas cuadren entre sí. La salida **conoce** el monto y sólo necesita que **el lado receptor** esté completo — y para eso `preBalances[i]===0` (§4.5) es un discriminador **local, directo y sobre un campo obligatorio del esquema**. La conservación además **importa un supuesto sobre TODA la transacción** que 315 tuvo que declarar explícitamente (*"el mint es SPL clásico, sin transfer-fee ni mint/burn en el camino"*): en el leg de salida, un payout **batcheado** del facilitator que toque el mismo mint por otra razón haría `subió ≠ bajó` y convertiría un pago bueno en un 503 permanente. **Coste alto, beneficio nulo para esta pregunta.** |
| **El match TRIPLE de destino** (`mint` ∧ `owner` ∧ `dirección === ATA`, CD-5 de 315) | Allá el destino es **nuestra cuenta publicada** y exigir las tres es correcto. Acá el destino es **la cuenta del agente**, y en el camino del facilitator **la elige un tercero** (§4.6). Un `∧` acá sub-mide ⇒ `landed_mismatch` sobre un pago real. Se usa **`∨`** |
| **El descubrimiento del depositante por delta negativo** (`:532-542`) | No hay pregunta análoga: el pagador somos nosotros (o el facilitator por nosotros) |
| **`DEPOSITOR_AMBIGUOUS`, `finalized`, el flag propio, la migración** | Vocabulario y superficie del camino de entrada |

**Roce textual:** `src/adapters/types.ts`. Las dos HUs agregan **bloques aditivos distintos** al
final; ninguna toca `SettlementPresence`. Conflicto de merge esperado: **trivial** (dos
adiciones consecutivas). **Orden recomendado: 315 → 319** para ese archivo, o al revés; da
igual, pero el que mergee segundo resuelve concatenando.

**Sin roce en `payment.ts`:** la story de 315 tiene como criterio de Done literal *"`git diff
--stat` con `src/adapters/solana/payment.ts` **ausente** de la lista"*.

---

## 8. Plan de tests

Framework **vitest**. **≥1 test por AC.** Todo test de dinero declara **qué mutación lo mata**.

### 8.1 Cobertura por AC

| Test | AC | Escenario | Aserción | Mata |
|---|---|---|---|---|
| **T-319-1** | AC-1 | **La repro central**: `payTo` GASTA 100 USDC (`post` con su entrada en `0`, `pre` **ausente**), `required = 1 USDC` | `probeSettlementPresence → unknown` con `detail` que empieza con `terms_`. **NUNCA `landed_ok`** | M1 |
| **T-319-1b** | AC-1 | Tabla: `pre` ausente · `pre: null` · `post` ausente · `post: null` · **las dos ausentes** | Los 5 ⇒ `unknown` | M1, M2 |
| **T-319-2** | AC-1 | `pre: []` (**presente y vacía**) con `post` acreditando, y `preBalances[i] > 0` | `unknown`, **no** `landed_ok` | M2, M3, M4 |
| **T-319-3** | AC-3 | `pre` presente **sin la entrada de `payTo`**, `post` con ella, `preBalances[i] = 2039280` | `unknown` (`terms_pre_row_missing`) | M3, M4 |
| **T-319-4** | AC-3 | Idem pero `preBalances` **ausente**, y luego `preBalances` corto (índice fuera de rango) | Los dos ⇒ `unknown`. **`undefined` no es `0`** | M5 |
| **T-319-5** | AC-2, AC-9 | `preTokenBalances: [null]`; y `[{mint:MINT}]` (sin `accountIndex`); y `[{...,uiTokenAmount:{}}]` | Los tres ⇒ `unknown`, y **`checkTerms` no lanza** (`expect(...).resolves`, no `rejects`) | M7 |
| **T-319-6** | AC-2 | Tabla sobre `uiTokenAmount.amount`: `''` · `'   '` · `'0x10'` · `'+5'` · `'1.0'` · `'1e9'` | Los 6 ⇒ `unknown`. **Ninguno `landed_ok`** | M8 |
| **T-319-7** | AC-6 | `post` **ausente la fila de `payTo`** con `pre` acreditado (delta negativo) | `unknown`, **no** `landed_mismatch` | M9 |
| **T-319-8** | AC-7 | `payTo` con **dos** cuentas del mismo mint: idx 3 (delta 0) e idx 7 (delta = required). La de delta 0 **primera** en `post` | `landed_ok`. Con `find` daría `landed_mismatch` | M10 |
| **T-319-9** | AC-4 | **ATA creada in-tx**: `pre` sin la fila de `payTo`, `preBalances[i] === 0`, `post` con el monto | **`landed_ok`** — el caso legítimo **sigue funcionando** | M15 |
| **T-319-10** | AC-5 | Espejo: fila nuestra en `pre`, ausente en `post`, `postBalances[i] === 0` ⇒ medible; `postBalances[i] > 0` ⇒ `unknown` | Ambas | M6 |
| **T-319-11** | AC-9 | `parsed` con un getter de `meta` que **lanza** (`Object.defineProperty`) | `probeSettlementPresence` devuelve `unknown` (`terms_threw`), **no propaga** | M14 |
| **T-319-12** | AC-8 | Listas completas, interpretables, delta `= 1` con `required = 1000000` | **`landed_mismatch`** — la negativa medida sigue viva | **M16** |
| **T-319-13** | AC-10 | Fila `confirmed` + `pre` ausente ⇒ `settle()` | Lanza `SETTLE_PRESENCE_UNKNOWN`; **NO** `SETTLE_CONFIRMED_BUT_UNVERIFIABLE`; `sendRawTransaction` 0 veces | M11 |
| **T-319-14** | AC-11 | Fila `signed` + blockhash **expirado** + `pre` ausente ⇒ `settle()` | Lanza `SETTLE_IN_FLIGHT_UNRESOLVED`; **`sendRawTransaction` 0 veces**; `recordConfirmedIntent` **no llamado** | M11 |
| **T-319-15** | AC-12 | Timeout de confirmación + `pre` ausente (camino `recoverConfirmedSettle`) | Lanza con `valueDisposition === 'unknown'` ⇒ `settleSolanaLeg` loguea `SETTLE_UNKNOWN` | M11 |
| **T-319-16** | AC-13 | `SOLANA_SETTLE_VIA_FACILITATOR=true`, payout 2xx, `pre` ausente | `recordConfirmedIntent` **no llamado**, la fila queda `signed`, `success:true` | M11 |
| **T-319-17** | AC-14 | `verify()` con `getParsedTransaction → null`; y con términos indeterminados | `{valid:false, indeterminate:true}` en los dos | M12b |
| **T-319-18** | AC-15 | *Typecheck test*: `settleAlreadySigned` con un `presence.state` inventado (cast) | La cola lanza `SETTLE_PRESENCE_UNHANDLED` en vez de re-transmitir | M13 |
| **T-319-19** | AC-8 (W2) | `owner` **ausente** en la entrada de la ATA de `payTo`, dirección resoluble = `expectedAta` | W1: `unknown` · **W2: `landed_ok`** | M17 |
| **T-319-20** | AC-9 (W2) | `payTo` no es base58 válido / es off-curve ⇒ `expectedAta` no derivable | No lanza; cae al tier de `owner` | M18 |

### 8.2 El canario contra la sobre-corrección

**`T-IDM-18b` (`intent-dedup.test.ts:857-878`) NO se puede debilitar.** Fija que un mismatch
**real** sigue dando `SETTLE_SIGNED_TERMS_MISMATCH`. Su fixture necesita `accountIndex` (§8.3) y
**nada más**. Si al final de esta HU ese test necesita cambiar su aserción, la HU **se pasó**:
convirtió una negativa medida en una indeterminación y volvió inalcanzable un estado que existe
por una razón. **T-319-12 es su refuerzo.** **CD-9.**

### 8.3 Fixtures — el trabajo real, y por qué no se puede esquivar

**Las 6 fixtures existentes son la razón por la que la suite no podía ver el bug.** Todas usan
`preTokenBalances: [{ owner: PAY_TO, mint: MINT, uiTokenAmount: { amount: '0' } }]`, y **`'0'`
es la ÚNICA forma donde el bug es indistinguible del comportamiento correcto** (con `pre = 0`,
`delta = post - 0 = post`, que es justo lo que el bug calcula). Un fixture del tipo correcto
que pasa por casualidad — el patrón recurrente de **CD-4**.

Además **ninguna trae `accountIndex`**, que es **obligatorio en el esquema real del SDK**. O sea
que las fixtures modelan una forma que el RPC nunca manda.

| Sitio | Cambio mínimo |
|---|---|
| `payment.test.ts:301-307` (T-234-AC7) | agregar `accountIndex: 1` a las dos entradas |
| `payment.test.ts:327-333` (verify < required) | idem |
| `payment.test.ts:361-368` (`mockConfirmedTx`) | idem |
| `payment.test.ts:602-608` (`meta.err` no nulo) | idem (no llega a `checkTerms`, pero se realista igual) |
| `intent-dedup.test.ts:353-360` (`onChainOk`) | idem |
| `intent-dedup.test.ts:865-872` (T-IDM-18b) | idem |

**CD-10: PROHIBIDO debilitar un guard nuevo para que una fixture vieja siga pasando.** Si una
fixture falla, **la fixture está mal** — modela una respuesta que el RPC no produce. La
dirección correcta es hacerla realista, nunca aflojar `checkTerms`.

**CD-11: toda fixture nueva de esta HU lleva `accountIndex` explícito y distinto por cuenta**, y
las que ejerciten §4.5 llevan `preBalances`/`postBalances` con **valores realistas**
(`2039280` = rent-exempt de una cuenta de token; `0` = no existía). Un `1` genérico prueba menos
de lo que parece.

### 8.4 Campaña de mutación — los mutantes que DEBEN morir

**Mutantes de FORMA DE LISTA** (los que la suite de hoy no puede ver — obligatorios):

| # | Mutación | Muere con |
|---|---|---|
| **M1** | Restaurar `const pre = meta.preTokenBalances ?? []` | T-319-1, T-319-1b |
| **M2** | Restaurar sólo el `?? []` de `post` | T-319-1b, T-319-2 |
| **M3** | Aceptar `pre: []` como "saldo previo cero" (saltear el Paso 5) | T-319-2, T-319-3 |
| **M4** | Una fila ausente en `pre` ⇒ `0n` **sin** mirar `preBalances` | T-319-2, T-319-3 |
| **M5** | `preBalances[i] === undefined` tratado como `0` (`?? 0`) | T-319-4 |
| **M6** | Quitar la regla **simétrica** del lado `post` (AC-5) | T-319-10 |
| **M7** | Quitar `isEntry` (validar sólo que la lista sea lista) | T-319-5 (y el test **falla por throw**, que es la señal) |
| **M15** | Rechazar la ATA creada in-tx (exigir la fila en `pre` siempre) | **T-319-9** — el mutante de la sobre-corrección |

**Mutantes de LÓGICA:**

| # | Mutación | Muere con |
|---|---|---|
| **M8** | `ATOMIC_RE` ⇒ `try { BigInt(x) } catch { return null }` | T-319-6 (`''`, `'   '`, `'0x10'`, `'+5'` **no entran al catch**) |
| **M9** | `delta < 0n` ⇒ `mismatch` en vez de `indeterminate` | T-319-7 |
| **M10** | Agregación ⇒ `find` (la primera) | T-319-8 |
| **M11** | En el mapeo: `indeterminate` ⇒ `landed_mismatch` | T-319-13/14/15/16 (los cuatro consumidores) |
| **M12** | `checkTerms` vuelve a `{ok:boolean}` | **No compila** (evidencia = salida de `tsc --noEmit`) |
| **M12b** | `verify()` no setea `indeterminate` | T-319-17 |
| **M13** | Quitar la lista-blanca de la cola de `settleAlreadySigned` + agregar un 6º estado | T-319-18 |
| **M14** | Quitar el `try` externo del mapeo | T-319-11 |
| **M16** | **Sobre-corrección**: `delta < required` ⇒ `indeterminate` (borrar `mismatch`) | **T-IDM-18b + T-319-12** |
| **M17** | Quitar el tier de dirección (W2) | T-319-19 |
| **M18** | No envolver `getAssociatedTokenAddressSync` (W2) | T-319-20 |

**Protocolo (CD-5 + reglas operativas de 203/209):** respaldo físico + hash del archivo antes de
mutar; **prohibido `git checkout --`** sobre trabajo sin commitear; **verificar que el archivo
mutado efectivamente se colectó** antes de creer un KILLED (el falso KILLED de 209 §M12 fue un
archivo que no colectó y reportó `no tests` con exit 0).

### 8.5 Verificación por wave

| Wave | Comando | Criterio |
|---|---|---|
| W0 | `npx tsc --noEmit` **completo** + `npx vitest run src/adapters/solana/` | Verde **sin tocar fixtures**. Si algo cambió de comportamiento, W0 se hizo mal |
| W1 | `npx vitest run src/adapters/solana/` + `npx vitest run src/lib/downstream-payment` | T-319-1..16 verdes; **T-IDM-18b verde sin cambiar su aserción** |
| W2 | idem + T-319-17..20 | — |
| W3 | Campaña §8.4 | **18/18 mutantes muertos**, con la evidencia del test que mató a cada uno |

---

## 9. Deuda declarada y `[NEEDS CLARIFICATION]`

| ID | Qué | Estado |
|---|---|---|
| **TD-319-1** | El recibo del leg (`settledAmount`, `nonEvmSettle.amountUsd`) usa el monto que **pedimos**, no el **medido**. Es el análogo de salida del cambio estructural de WKH-315. Necesita `SettleResult` + `settleSolanaLeg` + ledger | **HU aparte.** Esta HU deja el hecho medido disponible (`creditedAtomic`) y logueado |
| **TD-319-2** | Cuatro primitivos (`ATOMIC_RE`/`atomicOf`, `isEntry`, `declaredOwner`, delta-negativo) quedan transcritos en dos archivos (`payment.ts` y `deposit-verifier.ts`) | Se unifican cuando **WKH-314** promueva `presence.ts` (§7.1) |
| **TD-INBOUND-MULTI-ATA** | Parkeada por WKH-314 (su §7 / R-4) | **Esta HU la CIERRA** (AC-7) |
| **[NEEDS CLARIFICATION] — NINGUNA** | No hay ambigüedad que bloquee | El SDD no tiene TBDs |

**No se pudo determinar (declarado, no supuesto):** ver §11.

---

## 10. Constraint Directives

### Heredados (doctrina de la casa — WKH-307/308, `types.ts:132-168`)

- **CD-1** — Toda pregunta a un sistema externo tiene **TRES** respuestas: *está* / *no está* /
  *no pude preguntar*. Si el tipo no tiene el tercero, el tercero ya se perdió en el diseño.
- **CD-2** — **PROHIBIDO** que un dato ausente, ilegible o no interpretable produzca una
  afirmación (positiva o negativa). Un `null`, un `undefined`, un string vacío y una lista
  faltante son **indeterminación**, nunca cero y nunca "no".
- **CD-7** — Un gate que nadie corre no es un gate. Todo guard de esta HU tiene su test.

### Específicos de esta HU

**OBLIGATORIO**

- **CD-3** — **`??` PROHIBIDO sobre cualquier insumo de un guard de dinero.** Los dos
  `?? []` de `:1114-1115` **desaparecen del archivo** y no vuelven en ninguna forma
  (`|| []`, `Array.isArray(x) ? x : []`, un default de parámetro). El patrón *"el `??` fabrica
  el dato que el guard iba a mirar"* ya apareció dos veces (315 §BLQ-BAJO-1 y acá).
- **CD-4** — Toda fixture nueva modela la **forma real del RPC** (`accountIndex` presente,
  `amount` como entero decimal en base 10). Un fixture "del tipo correcto" que pasa por
  casualidad ya causó tres hallazgos en esta familia de HUs.
- **CD-6** — El guard no se sostiene sobre su propio razonamiento: `probeSettlementPresence`
  lleva el `try` externo **además** de los guards internos, y hay un test que lo ejerce
  (T-319-11).
- **CD-8** — Todo `detail` de indeterminación de términos lleva **prefijo `terms_`** y una causa
  distinguible. Un `unknown` sin causa manda al operador a empezar de cero.
- **CD-9** — **`landed_mismatch` NO puede volverse inalcanzable.** T-IDM-18b y T-319-12 son la
  prueba, y ninguno de los dos se puede debilitar.
- **CD-10** — **PROHIBIDO debilitar un guard para que una fixture vieja pase.** Si falla, se
  arregla la fixture.
- **CD-11** — Fixtures con `accountIndex` distinto por cuenta y `pre/postBalances` con valores
  realistas (`2039280` / `0`).
- **CD-12** — El orden de los guards es parte del contrato: **`mismatch` es siempre el último**
  y exige que todo lo anterior haya salido bien. El delta negativo se chequea **antes** del
  `< required`.

**PROHIBIDO**

- **CD-13** — **NO tocar `SettlementPresence`** (`types.ts:170-187`). Ni agregarle un estado, ni
  campos a `landed_ok`. Congelado por contrato con 314 (R1) y 315 (CD-3), y §4.3 muestra que
  agregarle un estado con el código de hoy **planta un segundo pago**.
- **CD-14** — **NO tocar `getOperatorSplBalance`** (`:210-220`) ni
  `downstream-payment.ts:383-390`. Fail-open deliberado y documentado. No se re-litiga.
- **CD-15** — **NO cambiar el `success:true` de `settleViaFacilitator:813`** ni el monto del
  recibo. Fuera de alcance, con razón escrita (§5.2, §4.8).
- **CD-16** — **NO tocar `wt-313`, `wt-315`, `wt-318`, `wt-314`, `wt-316` ni `main`.** Ni
  mergear, ni pushear, ni aplicar migraciones.
- **CD-17** — **NO git destructivo**: `reset --hard`, `clean -fd`, `stash drop/clear`,
  `checkout --` sobre trabajo sin commitear, `branch -D`.
- **CD-18** — **NO correr contra la red ni la base de producción**, ni usar credenciales
  reales. Todos los tests de esta HU corren **sin red y sin base** (dobles ya existentes).
- **CD-19** — **NO agregar envs, banderas ni kill-switches** para los guards. Un guard de dinero
  apagable por configuración es el fail-open con otro nombre.
- **CD-20** — **NO redirigir a archivo la salida de comandos que leen archivos** (el proxy `rtk`
  trunca con exit 0 y ya corrompió un fuente). `Read`/`Write` siempre.

---

## 11. Qué NO se pudo determinar

Declarado para que nadie lo lea como verificado:

1. **Si el RPC de producción omite `preTokenBalances` en alguna condición real.** El esquema lo
   **permite** (V-1, verificado) y el guard cierra la puerta pase o no. Pero **no hay evidencia
   de que un nodo del pool lo haga**, así que la frecuencia esperada del `unknown` nuevo en
   producción **es desconocida**. Es la métrica a mirar después del deploy.
2. **Si un nodo real omite la fila de `pre` para una ATA creada en la misma tx** (el supuesto de
   AC-4). Es el comportamiento documentado y el que asume el diseño, pero **no se pudo
   confirmar contra un nodo** (prohibido tocar la red). El diseño es **seguro en los dos
   casos**: si la fila viniera, se usa; si no, `preBalances[i]===0` la resuelve. La
   confirmación empírica es el `devnet-e2e.manual.test.ts`.
3. **Si el facilitator paga a la ATA canónica de `payTo` o a otra cuenta de token suya.** Su
   código está en otro repo. Por eso el conjunto receptor es una **unión** (§4.6) y **no** se
   pinea la ATA: el diseño no depende de la respuesta.
4. **Si `message.accountKeys` incluye las direcciones cargadas por Address Lookup Table** en
   `getParsedTransaction` con `maxSupportedTransactionVersion: 0`, y si `pre/postBalances`
   cubren esos índices. El esquema declara `accountKeys` obligatorio pero no aclara el alcance.
   Mitigación ya en el diseño: un índice que no resuelve ⇒ el tier de dirección no está
   disponible; un `preBalances[i]` fuera de rango ⇒ **indeterminate**, nunca un pase silencioso.
5. **La explotabilidad on-chain del `find`** (guard (d)) sigue **sin demostrar**: se reprodujo
   en memoria, no en cadena. Entra al corte por costo cero y por su modo de falla
   fail-**closed**-permanente (§4.4), no porque se haya probado explotable.
6. **Auto-Blindaje de las HUs DONE más recientes**: `doc/sdd/207-215/auto-blindaje.md` **no
   existen en `main`**. Se leyó el de `wt-315` (HU en vuelo) y se cruzó con su §3.5, que ya
   consolida 209/208/203. **Los patrones de §3.3 salen de esa fuente indirecta**, no de tres
   auto-blindajes DONE independientes.
7. **Si algún test fuera de `src/adapters/solana/` observa `checkTerms` indirectamente.** Se
   verificó `payment.flag.test.ts` y `settle-wiring.test.ts` (mockean `getParsedTransaction` a
   `null` ⇒ no llegan) y se grepeó todo `src/` por `preTokenBalances` (6 sitios). **No se corrió
   la suite completa** — es trabajo de F3.

---

## 12. Riesgos

| # | Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|---|
| R-1 | **Sobre-corrección**: tanto guard nuevo vuelve `landed_mismatch` inalcanzable y todo se convierte en `unknown` ⇒ intents trabados en masa | Media | Alto (operativo, no de dinero) | **CD-9** + T-IDM-18b + T-319-12 + M16. Los `detail` con prefijo `terms_` permiten medirlo en el log |
| R-2 | Un nodo real produce una forma que el diseño llama indeterminada y que era legítima ⇒ ruido de `SETTLE_PRESENCE_UNKNOWN` | Media | Medio | Fail-**closed** y **transitorio**: no cuesta plata y se destraba solo. §11.1 es la métrica a mirar post-deploy |
| R-3 | WKH-314 mergea primero y `checkTerms` ya no vive en `payment.ts` | Baja (0 commits) | Medio | §7.1: orden **319 → 314**, acordado por escrito |
| R-4 | El Dev afloja un guard para que pase una fixture vieja | Media | **Alto** | **CD-10** + §8.3 con el cambio mínimo por sitio ya escrito |
| R-5 | El Dev agrega el sexto estado a `SettlementPresence` "porque es más limpio" | Media | **Alto — segundo pago** | **CD-13** + §4.3 con el razonamiento completo + AC-15/W2.3 que cierra la trampa |
| R-6 | Conflicto de merge en `src/adapters/types.ts` con WKH-315 | Alta | Bajo | Bloques aditivos al final, disjuntos. Se resuelve concatenando |

---

## Readiness Check

| # | Ítem | Estado |
|---|---|---|
| 1 | Todos los paths referenciados verificados con `Read`/`find`/lectura del bundle | ✅ |
| 2 | Todos los exemplars existen y se citan con archivo:línea | ✅ (§3.2) |
| 3 | Las afirmaciones del encargo se verificaron puntualmente (V-1..V-6) | ✅ (§0) |
| 4 | Stack respetado: TS strict, cero deps nuevas, cero envs nuevas, cero migraciones | ✅ |
| 5 | ≥1 test por AC (20 tests / 15 ACs) | ✅ (§8.1) |
| 6 | Mutantes nominados, **incluidos los de forma de lista** (8 de 18) | ✅ (§8.4) |
| 7 | El corte mínimo está marcado y es shippable solo | ✅ (fin de W1) |
| 8 | Los 4 consumidores resueltos uno por uno, con su razón | ✅ (§5) |
| 9 | El caso legítimo de ATA creada in-tx tiene diseño **y test propio** (T-319-9) | ✅ (§4.5) |
| 10 | `verify()` diseñado para cuando WKH-314 lo despierte | ✅ (§5.5) |
| 11 | Orden de merge y roce resueltos con las 5 HUs en vuelo, verificados con `git log` | ✅ (§7) |
| 12 | Qué se reusa y qué NO de WKH-315, con razón por ítem | ✅ (§7.2) |
| 13 | Constraint Directives heredados + específicos | ✅ (§10) |
| 14 | Sin `[NEEDS CLARIFICATION]` abiertos | ✅ (§9) |
| 15 | Lo que **no se pudo determinar** está declarado, no supuesto | ✅ (§11) |

**El SDD está listo para `SPEC_APPROVED`.**
