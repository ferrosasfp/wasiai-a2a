# Work Item — WKH-319 · Cerrar el fail-open de `checkTerms` en el camino de salida Solana

| Campo | Valor |
|---|---|
| HU | **WKH-319** |
| Carpeta | `doc/sdd/216-wkh-319-checkterms-fail-open/` |
| Worktree | `~/.openclaw/workspace/wt-319` |
| Branch | `feat/216-wkh-319-checkterms-fail-open` (**ya existe**) |
| Fase | **F1 — Work Item** |
| Autor | `nexus-analyst` |
| Estado del pipeline al escribirse esto | **SDD aprobado, F3 en curso** |

> ## ⚠️ ESTE WORK ITEM ES RETROACTIVO
>
> La HU arrancó sin F0/F1: el encargo llegó con el hallazgo **ya trazado por ejecución** y el
> SDD lo adoptó como work item (`sdd.md` §2). Esto corrige el desvío de proceso: sin
> `work-item.md` con ACs en EARS, **F4 no tendría criterios que validar**.
>
> **Este documento NO re-diseña nada.** Cada AC deriva de una decisión ya tomada y escrita en
> `sdd.md`, o de un hecho ya medido por las tres probes del encargo. Si algún AC de acá
> contradijera al SDD, **gana el SDD** y el AC es un bug de este archivo.

---

## Resumen

`SolanaPaymentAdapter.checkTerms` (`src/adapters/solana/payment.ts:1101-1130` en el estado
pre-fix) **no falla abierto por verificar de menos: falla abierto por verificar otra cosa.**
Con `preTokenBalances` ausente, el `?? []` fabrica la lista, `balanceFor(pre)` da `0n` y
`delta` deja de ser un delta para pasar a ser el **saldo absoluto** de `payTo`. La pregunta
degenera de *"esta tx transfirió ≥ required a `payTo`"* a *"`payTo` tiene ≥ required"*.

**Se construye** el tercer valor que la función nunca tuvo: `checkTerms` responde hoy una
pregunta de dos valores (*coincide* / *no coincide*) a una que tiene **tres** (*coincide* /
*no coincide* / **no pude medirlo**). Todas las formas del bug —las cinco de lista, la familia
de `amount`, el delta negativo, el `find` que toma la primera cuenta— son **maneras distintas
de caer en el tercer valor que el tipo no tiene**, y por eso todas aterrizan en el lado
equivocado del segundo.

**Para quién:** el operador del gateway y, sobre todo, el agente que cobra. **Por qué ahora:**
es el leg que paga, y **ya corre en producción**.

---

## Evidencia — el bug está medido, no inferido

Tres probes reproducibles del encargo (`probe.ts`, `probe2.ts`, `probe3.ts`; corren **sin red
y sin base**). Los seis hechos de los que cuelga el diseño fueron re-verificados puntualmente
por el Architect y quedaron confirmados (`sdd.md` §0, V-1..V-6).

| # | Hecho medido | Dónde |
|---|---|---|
| E-1 | **Repro central**: una tx donde `payTo` **GASTA 100 USDC** y no recibe nada, con `pre` ausente ⇒ `{"ok":true}`. Una transacción **ajena, con el agente como pagador**, se certifica como *"nuestro pago llegó"* | probe del encargo |
| E-2 | **Cinco formas del input** lo disparan: `pre` ausente · `null` · vacía · presente sin la entry de `payTo` · con entry pero **sin `owner`**. Tres son parciales | probe del encargo |
| E-3 | `amount` igual a `''`, `'   '`, `'0x10'`, `'+5'` también dan `ok:true`. El `catch` de un `try{BigInt(x)}` **ni se ejecuta** | probe del encargo |
| E-4 | Si faltan **las dos** listas, es fail-closed **por accidente de simetría**, no por diseño | probe del encargo |
| E-5 | **Alcanzabilidad**: `preTokenBalances` está declarado `optional(nullable(array(...)))` y `owner` es `optional(string())`. Un nodo que omita el campo **pasa la validación del SDK limpio** | `node_modules/@solana/web3.js/lib/index.cjs.js`; `sdd.md` §0 V-1/V-2 |
| E-6 | `accountIndex: number` y `mint: string` son **obligatorios**; `preBalances`/`postBalances` son `array(number())` **obligatorios** e indexados por el mismo espacio que `accountIndex` | ídem; `sdd.md` §0 |
| E-7 | **Cuatro consumidores vivos, sin segunda barrera**: `settleSolanaLeg` (`src/lib/downstream-payment.ts:469-543`) sólo mira `success`/`txHash` y arma el recibo con `settledAmount: amountAtomic` — el monto que **creemos** haber pagado | `sdd.md` §0 V-6 |
| E-8 | `:1120` **escapa del `try`** de `probeSettlementPresence`, cuyo docstring promete *"NUNCA lanza"* | `payment.ts:617-624` cierra el `try`; el call-site está en `:640`, fuera. `sdd.md` §0 V-4 |
| E-9 | **Por qué la suite no lo veía**: las 6 fixtures usan `preTokenBalances` con `amount: '0'` — **la única forma donde el bug es indistinguible del comportamiento correcto** (con `pre = 0`, `delta = post`, que es justo lo que el bug calcula) — y **ninguna trae `accountIndex`**, obligatorio en el esquema real | `payment.test.ts:301,327,361,602` · `intent-dedup.test.ts:353,865`. `sdd.md` §0 V-5 |

### Los cuatro consumidores, por gravedad

| # | Consumidor | Qué pasa hoy con un `landed_ok` fabricado |
|---|---|---|
| 1 | `settleAlreadySigned` (`payment.ts:452`) | **El peor.** Un intent firmado que **no aterrizó** se marca `confirmed`, el agente **nunca cobra**, y el reintento queda **clausurado** |
| 2 | `settleViaFacilitator` (`:775`) | `checkTerms` es la **única** verificación de que el facilitator externo movió la plata. **Único cruce de límite de confianza** |
| 3 | `settleAlreadyConfirmed` (`:367`) | Desarma el re-check de forks |
| 4 | `recoverConfirmedSettle` (`:1000`) | El self-heal cierra el leg sobre un pago que puede no haber ocurrido |

### El camino inverso (igual de grave, en la otra dirección)

Un delta **negativo** sale hoy como `landed_mismatch` ⇒ en la rama `confirmed` eso es
`SETTLE_CONFIRMED_BUT_UNVERIFIABLE`: **condena permanente con salida manual**. Para una tx que
**construimos nosotros**, un delta negativo es **indeterminación**, no prueba en contra.

---

## Sizing

| Campo | Valor |
|---|---|
| **Modo NexusAgil** | **QUALITY** — camino de dinero, en código **ya mergeado y corriendo en producción** |
| **SDD_MODE** | `full` |
| **Estimación** | **M** (≈ 9-10 h: W0 ≈ 1 h · W1 ≈ 4-5 h · W2 ≈ 2 h · W3 ≈ 2 h) |
| **Corte mínimo shippable** | **W0 + W1** — un tipo nuevo, una función reescrita, dos call-sites. ~150 líneas, **un** archivo de producción |
| **Skills de dominio** | `solana/spl-token accounting` · `payments — fail-open/fail-closed` |
| **Branch** | `feat/216-wkh-319-checkterms-fail-open` (ya creado) |

---

## Acceptance Criteria (EARS)

**Convención de lectura.** `verdict` es el retorno de `checkTerms`; `state` es el de
`probeSettlementPresence`. Un AC marcado **`[SC]`** es de **sobre-corrección**: existe para
detectar que el arreglo **rechaza de más**. Un arreglo que rechaza pagos buenos también está
roto, y sin estos ACs el QA no tiene con qué verlo.

### Bloque A — Las cinco formas de lista

| AC | Enunciado | Evidencia esperada |
|---|---|---|
| **AC-1** | **WHEN** `meta.preTokenBalances` o `meta.postTokenBalances` está **ausente** (`undefined`) o es **`null`**, THE SYSTEM SHALL devolver `verdict:'indeterminate'`, y `probeSettlementPresence` SHALL reportar `state:'unknown'`. THE SYSTEM SHALL NOT reportar `landed_ok` ni `landed_mismatch` | `payment.ts` · guard Paso 1 · T-319-1, T-319-1b |
| **AC-2** | **WHEN** faltan **las dos** listas, THE SYSTEM SHALL devolver `indeterminate` **por el guard explícito**, y THE SYSTEM SHALL NOT depender de la simetría accidental de dos `?? []` para llegar al mismo resultado | `payment.ts` · el fail-closed pasa a ser por diseño · T-319-1b |
| **AC-3** | **WHEN** una cuenta del conjunto receptor aparece en `post` y **no** en `pre` (lista `pre` **vacía**, o **presente sin la entry** de `payTo`), **AND** `meta.preBalances[accountIndex]` **no es `0`**, no es leíble o el índice está fuera de rango, THEN THE SYSTEM SHALL devolver `indeterminate` con `detail` `terms_pre_row_missing` | T-319-2, T-319-3, T-319-4 |
| **AC-4** `[SC]` | **WHEN** una cuenta del conjunto receptor aparece en `pre` y **no** en `post`, THE SYSTEM SHALL aplicar la regla **simétrica** de AC-3/AC-5 sobre `meta.postBalances[accountIndex]`. La simetría **no es estética**: sin ella, una fila nuestra faltante del lado `post` hace que el delta se vea **más chico** y produce un **`landed_mismatch` falso sobre un pago real** | T-319-10 · mutante **M6** |
| **AC-5** `[SC]` | **WHEN** una cuenta del conjunto receptor aparece en `post` y no en `pre`, **AND** `meta.preBalances[accountIndex] === 0`, THEN THE SYSTEM SHALL tomar su saldo previo como `0n` y **completar la medición** — la **ATA creada en la misma tx** SHALL seguir acreditando (`landed_ok`). El caso espejo (cuenta cerrada en la tx, `postBalances[accountIndex] === 0`) SHALL seguir siendo **medible** | T-319-9, T-319-10 · mutante **M15** |
| **AC-6** | **WHEN** una entrada del mint esperado tiene `owner` **ausente** (quinta forma), THE SYSTEM SHALL NOT contarla como del receptor **ni** afirmar por eso que la plata fue a otro lado | Paso 4 · T-319-19 |
| **AC-7** `[SC]` | **IF** existe al menos una entrada no clasificable (`owner` ausente y sin tier de dirección) **AND** el delta medido es `< required`, THEN THE SYSTEM SHALL devolver `indeterminate` (`terms_unclassifiable_entry`) y SHALL NOT devolver `mismatch`. **WHILE** el delta medido ya alcanza `required`, THE SYSTEM SHALL devolver `match` (medir de menos no puede volver verdadero un `>=` falso) | `sdd.md` §4.6 W1 · T-319-19 |
| **AC-8** `[SC]` (W2) | **WHERE** el tier de dirección está disponible **AND** `addressAt(accountIndex) === expectedAta`, THE SYSTEM SHALL contar la entrada como del conjunto receptor **aunque `owner` esté ausente**, resolviendo a `landed_ok` un pago real que en W1 quedaba `unknown`. La identidad SHALL ser una **UNIÓN** (`dirección ∨ owner`), nunca una conjunción | T-319-19 · mutante **M17** |

### Bloque B — La familia de `amount` y la forma de las entradas

| AC | Enunciado | Evidencia esperada |
|---|---|---|
| **AC-9** | **WHEN** `uiTokenAmount.amount` de una entrada relevante **no** satisface `/^[0-9]+$/` — incluidos `''`, `'   '`, `'0x10'`, `'+5'`, `'1.0'`, `'1e9'` — THE SYSTEM SHALL devolver `indeterminate` (`terms_amount_unreadable`) **sin lanzar**, y SHALL NOT interpretarlo como `0n` | T-319-6 · mutante **M8** (`try{BigInt}` no alcanza: el `catch` ni se ejecuta) |
| **AC-10** | **WHEN** cualquiera de las dos listas contiene una entrada que **no** es un objeto con `mint: string`, `accountIndex: number` y `uiTokenAmount.amount: string` (incluido `[null]`), THE SYSTEM SHALL devolver `indeterminate` (`terms_entry_shape`) **sin lanzar** | T-319-5 · mutante **M7** |

### Bloque C — Delta negativo y agregación

| AC | Enunciado | Evidencia esperada |
|---|---|---|
| **AC-11** | **WHEN** el delta agregado del conjunto receptor es **negativo**, THE SYSTEM SHALL devolver `indeterminate` (`terms_negative_delta`) y SHALL NOT devolver `mismatch` — para una tx que construimos nosotros el destino no gasta, así que un número negativo prueba que **los datos no son coherentes**, no que la plata haya ido a otro lado | T-319-7 · mutante **M9** |
| **AC-12** | THE SYSTEM SHALL chequear el delta negativo **antes** del `< required`, para que la indeterminación no quede tapada por el `mismatch` | orden de guards `sdd.md` §4.4 Paso 6 |
| **AC-13** `[SC]` | **WHERE** el receptor tiene **más de una** cuenta de token del mint en la misma tx, THE SYSTEM SHALL **agregar** el delta sobre **todas** ellas, emparejando `pre` y `post` por `accountIndex`, y SHALL resolver `landed_ok` un pago real que el `.find()` anterior clasificaba `landed_mismatch`. THE SYSTEM SHALL NOT usar `.find()` ni fijar una única cuenta admisible | T-319-8 · mutante **M10** |

### Bloque D — "NUNCA lanza" vuelve a ser cierta

| AC | Enunciado | Evidencia esperada |
|---|---|---|
| **AC-14** | THE SYSTEM SHALL NOT lanzar desde `checkTerms` para **ninguna** entrada admitida por el esquema de `@solana/web3.js` | T-319-5, T-319-6 (aserción `resolves`, no `rejects`) |
| **AC-15** | **IF** algo lanza dentro de `checkTerms` pese a los guards, THEN `probeSettlementPresence` SHALL traducirlo a `state:'unknown'` (`terms_threw`) y SHALL NOT propagar — el guard no se sostiene sobre su propio razonamiento | T-319-11 · mutante **M14** |
| **AC-16** `[SC]` | **IF** `new PublicKey(...)` o `getAssociatedTokenAddressSync(...)` lanzan (base58 inválido, owner off-curve), THEN el tier de dirección SHALL quedar **no disponible** y THE SYSTEM SHALL caer al tier de `owner`. Eso por sí solo SHALL NOT producir `indeterminate` ni propagar el throw | T-319-20 · mutante **M18** |

### Bloque E — Sobre-corrección: que no se rechace de más

| AC | Enunciado | Evidencia esperada |
|---|---|---|
| **AC-17** `[SC]` | **WHEN** las dos listas están presentes, son interpretables y completas sobre el conjunto receptor, **AND** el delta agregado es `>= 0` y `< required`, THEN THE SYSTEM SHALL devolver `mismatch` ⇒ `landed_mismatch`. **`landed_mismatch` SHALL NOT volverse inalcanzable** | T-319-12 · **T-IDM-18b** (`intent-dedup.test.ts:857-878`) verde **sin cambiar su aserción** · mutante **M16** |
| **AC-18** `[SC]` | **WHEN** las dos listas están presentes, simétricas y completas, **AND** el delta agregado es `>= required`, THEN THE SYSTEM SHALL devolver `match` con `creditedAtomic` = el delta **medido** ⇒ `landed_ok`. El camino feliz SHALL NOT cambiar de comportamiento | suite Solana actual verde · T-319-8, T-319-9 |
| **AC-19** `[SC]` | **WHILE** una tx es simétrica (el caso normal), THE SYSTEM SHALL NOT leer `preBalances`/`postBalances` — la lectura es **perezosa**, sólo ante asimetría, para no agregar indeterminación gratuita | `sdd.md` §4.5 · las 6 fixtures actuales no necesitan `pre/postBalances` |
| **AC-20** `[SC]` | THE SYSTEM SHALL NOT debilitar ningún guard para que una fixture vieja pase. **WHEN** una fixture falla contra un guard nuevo, THE SYSTEM SHALL corregir **la fixture** (agregar `accountIndex`, valores realistas), porque modela una forma que el RPC no produce | `git diff` de `payment.test.ts` / `intent-dedup.test.ts`: sólo realismo de fixture, **cero aserciones aflojadas** · CD-10 |

### Bloque F — Que la indeterminación viaje y no colapse

| AC | Enunciado | Evidencia esperada |
|---|---|---|
| **AC-21** | THE SYSTEM SHALL usar `verdict: 'match' \| 'mismatch' \| 'indeterminate'` como discriminante, **NO `ok`**. THE SYSTEM SHALL NOT exponer `ok: true \| false \| 'unknown'` (sería **peor que el bug**: `if (terms.ok)` da **`true`** para `'unknown'`) | `src/adapters/types.ts` · `npx tsc --noEmit` **completo** verde · mutante **M12** (no compila) |
| **AC-22** | `probeSettlementPresence` SHALL mapear con un `switch` **exhaustivo y sin `default`**: `match→landed_ok`, `mismatch→landed_mismatch`, `indeterminate→unknown` | `payment.ts:640-643` reescrito |
| **AC-23** | THE SYSTEM SHALL NOT agregar un estado nuevo a `SettlementPresence`. `indeterminate` SHALL traducirse a `unknown`, que ya existe y ya significa eso | `git diff` de `types.ts:170-187` **vacío** · CD-13 |
| **AC-24** | **WHEN** `checkTerms` devuelve `indeterminate` en la rama `confirmed`, `settleAlreadyConfirmed` SHALL lanzar `SETTLE_PRESENCE_UNKNOWN` (transitorio) y SHALL NOT lanzar `SETTLE_CONFIRMED_BUT_UNVERIFIABLE` | `payment.ts:367`, `:385-393` · T-319-13 |
| **AC-25** | **WHEN** `checkTerms` devuelve `indeterminate` en la rama `signed`, `settleAlreadySigned` SHALL lanzar `SETTLE_IN_FLIGHT_UNRESOLVED`, con **cero** llamadas a `sendRawTransaction`, y SHALL NOT marcar la fila `confirmed` | `payment.ts:452`, `:478-486` · T-319-14 |
| **AC-26** | **WHEN** `checkTerms` devuelve `indeterminate` dentro de `recoverConfirmedSettle`, el leg SHALL aparecer como `SETTLE_UNKNOWN` (`valueDisposition:'unknown'`) y SHALL NOT aparecer como `SETTLE_FAILED` | `payment.ts:1000` · `downstream-payment.ts:501-520` · T-319-15 |
| **AC-27** | **WHEN** `checkTerms` devuelve `indeterminate` dentro de `settleViaFacilitator`, la fila SHALL quedar en `signed` (sin `recordConfirmedIntent`) | `payment.ts:775`, `:791-802` · T-319-16 |
| **AC-28** | Todo `detail` de indeterminación de términos SHALL llevar el prefijo estable **`terms_`** y una causa distinguible (`terms_list_absent`, `terms_entry_shape`, `terms_amount_unreadable`, `terms_pre_row_missing`, `terms_post_row_missing`, `terms_negative_delta`, `terms_unclassifiable_entry`, `terms_threw`) | logs de `probeSettlementPresence` · CD-8 |
| **AC-29** | La cola de re-transmisión de `settleAlreadySigned` SHALL exigir **pertenencia explícita** a `{absent, landed_failed}`; un estado no contemplado SHALL lanzar `SETTLE_PRESENCE_UNHANDLED` en vez de re-transmitir | `payment.ts:500-517` · T-319-18 · mutante **M13** |
| **AC-30** | (W2) `verify()` SHALL marcar `indeterminate: true` en **toda** negativa no medida (tx no parseable en el nodo consultado, términos indeterminados), **sin** cambiar su `valid` | `payment.ts:1144-1165` · T-319-17 · mutante **M12b** |

**Cobertura: 30 ACs · 10 de sobre-corrección**, marcados `[SC]`:
AC-4, AC-5, AC-7, AC-8, AC-13, AC-16, AC-17, AC-18, AC-19, AC-20.

### Mapeo con los ACs del SDD

| SDD | Work Item |
|---|---|
| AC-1 | AC-1, AC-2 |
| AC-2 | AC-9, AC-10 |
| AC-3 | AC-3 |
| AC-4 | AC-5 |
| AC-5 | AC-4 |
| AC-6 | AC-11, AC-12 |
| AC-7 | AC-13 |
| AC-8 | AC-7, AC-8, AC-17 |
| AC-9 | AC-14, AC-15, AC-16 |
| AC-10..13 | AC-24..27 |
| AC-14 | AC-30 |
| AC-15 | AC-29 |
| — (nuevos de F1) | AC-18, AC-19, AC-20, AC-21, AC-22, AC-23, AC-28 |

---

## Scope IN

| Archivo | Qué |
|---|---|
| `src/adapters/solana/payment.ts` | `checkTerms` (cuerpo + firma), el mapeo de `probeSettlementPresence:640-643`, el mapeo de `verify():1144-1165`, la cola de `settleAlreadySigned:500-517` |
| `src/adapters/types.ts` | **Bloque aditivo al final**: `SolanaTermsVerdict`. **`SettlementPresence` NO se toca** |
| `src/adapters/solana/payment.test.ts` | 4 fixtures + tests nuevos |
| `src/adapters/solana/intent-dedup.test.ts` | 2 fixtures + tests nuevos |
| `doc/sdd/216-wkh-319-checkterms-fail-open/` | Artefactos de la HU |

**Ningún archivo más.** Cero migraciones · cero envs nuevas · cero dependencias nuevas · cero
cambios de contrato público.

## Scope OUT

| Fuera | Razón |
|---|---|
| **El fail-open de `getOperatorSplBalance`** (`payment.ts:210-220` + `downstream-payment.ts:383-390`) | **Decisión deliberada y documentada, con su razón escrita. NO se re-litiga** (instrucción explícita del encargo) |
| `SettlementPresence` (`types.ts:170-187`) | **CONGELADO** por contrato con WKH-314 (R1) y WKH-315 (CD-3). Agregarle un estado **planta un segundo pago** (ver DT-2) |
| El monto del recibo (`settledAmount: amountAtomic`, `nonEvmSettle.amountUsd`) | Necesita superficie nueva en `SettleResult` + `settleSolanaLeg` + ledger. Se **habilita** acá (`creditedAtomic`) y se cierra en **TD-319-1** |
| El `success:true` incondicional de `settleViaFacilitator:813` | Pre-existente y deliberado: devolver `false` dispara reembolso/re-envío del hop. Se **documenta**, no se cambia |
| `commitment:'confirmed'` → `finalized` (`:619`, `:1141`) | Diferido con ticket propio (`doc/sdd/185-.../work-item.md` MNR-2). Ortogonal |
| El invariante de conservación global de WKH-315 | Responde una pregunta que el lado de **salida** no tiene, e importaría un supuesto sobre **toda** la tx que rompería con un payout batcheado del facilitator (`sdd.md` §7.2) |
| Correr contra red o base reales | Todos los tests corren **sin red y sin base** |

---

## Decisiones técnicas (DT-N)

> Ya tomadas y justificadas en el SDD. Se listan acá para trazabilidad de los ACs.
> **No se re-litigan en F3/AR/CR/F4.**

- **DT-1 — El discriminante es `verdict`, no `ok`.** El renombre es **deliberado**: hace que
  cada lectura vieja **deje de compilar**, obligando a revisitar a mano los dos call-sites
  (`:640`, `:1164`). `ok: true|false|'unknown'` sería **peor que el bug**, porque
  `if (terms.ok)` da **`true`** para `'unknown'`: un fail-open silencioso con forma de arreglo.
  → AC-21.
- **DT-2 — NO se agrega un sexto estado a `SettlementPresence`.** Los cuatro consumidores
  discriminan con **cadenas de `if`**, no con `switch` exhaustivo, y `settleAlreadySigned` cae
  **por descarte** a una cola que **re-transmite**. Un estado nuevo que alguien olvide agregar
  a esa cadena **pagaría dos veces en silencio**, sin que TypeScript diga una palabra.
  `indeterminate` se traduce a `unknown`, que ya existe y ya significa exactamente eso.
  → AC-22, AC-23, AC-29.
- **DT-3 — Los cuatro consumidores no necesitan ramas nuevas.** Los cuatro ya tienen escrita
  —y testeada— la rama de `presence.state === 'unknown'`. Lo único que hay que dejar de hacer
  es **fabricar `landed_mismatch` a partir de una indeterminación**. → AC-24..27.
- **DT-4 — La ATA creada en la misma tx se distingue de una lista truncada con
  `preBalances[accountIndex] === 0`.** Una cuenta que no existía tiene 0 lamports; una cuenta
  de token existente es **rent-exempt** (`> 0`). `preBalances`/`postBalances` son
  `array(number())` **obligatorios** e indexados por el mismo espacio que `accountIndex`.
  **Ese caso legítimo tiene que seguir acreditando.** → AC-3, AC-5.
- **DT-5 — El `find` se resuelve como agregación por `accountIndex`**, no fijando la ATA.
  Pinear la ATA importaría un supuesto **no verificable desde este repo** sobre el facilitator
  (nosotros le mandamos sólo `payTo` base58; **la cuenta concreta la elige él**), y su modo de
  falla sería `landed_mismatch` sobre un pago real. → AC-13.
- **DT-6 — La identidad del receptor es una UNIÓN (`dirección ∨ owner`), no una conjunción.**
  El match triple de WKH-315 es correcto allá (destino = **nuestra** cuenta publicada) e
  incorrecto acá. Un `∧` sub-mide ⇒ `landed_mismatch` sobre un pago real. → AC-8.
- **DT-7 — El delta negativo es indeterminación, no negativa**, y se chequea **antes** del
  `< required`. → AC-11, AC-12.
- **DT-8 — `ATOMIC_RE = /^[0-9]+$/` + `atomicOf → bigint | null`**, no `try{BigInt}`:
  `BigInt('')`=`0n`, `BigInt('   ')`=`0n`, `BigInt('0x10')`=`16n` — el `catch` **ni se
  ejecuta**. `null` significa *"no pude medir"*, **nunca** cero. → AC-9.
- **DT-9 — El hecho medido (`creditedAtomic`) queda disponible y logueado, el recibo no cambia
  todavía.** El desvío está acotado y **del lado seguro para el agente**: `checkTerms` sólo
  aprueba con `delta >= required`, así que el recibo puede sub-declarar pero **nunca
  sobre-declarar**. → TD-319-1.
- **DT-10 — Lectura perezosa de `pre/postBalances`**: sólo ante asimetría. No se agrega
  indeterminación gratuita y la churn de fixtures baja a *"agregar `accountIndex`"*. → AC-19.
- **DT-11 — Corte mínimo = W0 + W1**, shippable solo. Después de W1 la **repro central deja de
  devolver `ok:true`** y las cinco formas están cerradas. Recomendación del SDD: mergear W0+W1
  apenas pase AR/CR, sin esperar a W2/W3.
- **DT-12 — Los cuatro primitivos de WKH-315 se transcriben, no se importan** (`ATOMIC_RE`,
  `isEntry`, `declaredOwner`, delta-negativo). Importar crearía una dependencia
  `payment.ts → deposit-verifier.ts` **al revés** de la que 315 diseñó, justo mientras 315 está
  en vuelo. La unificación tiene dueño: **WKH-314** cuando promueva `presence.ts`. → TD-319-2.

---

## Constraint Directives (CD-N)

> Namespace **único y compartido con `sdd.md` §10**. Si acá y allá difieren, gana el SDD.

**Heredados (doctrina de la casa — WKH-307/308, `types.ts:132-168`)**

- **CD-1** — Toda pregunta a un sistema externo tiene **TRES** respuestas: *está* / *no está* /
  *no pude preguntar*. Si el tipo no tiene el tercero, el tercero ya se perdió en el diseño.
- **CD-2** — **PROHIBIDO** que un dato ausente, ilegible o no interpretable produzca una
  afirmación, positiva **o negativa**. Un `null`, un `undefined`, un string vacío y una lista
  faltante son **indeterminación**, nunca cero y nunca "no".
- **CD-7** — Un gate que nadie corre no es un gate: todo guard de esta HU tiene su test.

**OBLIGATORIO**

- **CD-3** — **`??` PROHIBIDO sobre cualquier insumo de un guard de dinero.** Los dos `?? []`
  **desaparecen del archivo** y no vuelven en ninguna forma (`|| []`,
  `Array.isArray(x) ? x : []`, un default de parámetro).
- **CD-4** — Toda fixture nueva modela la **forma real del RPC**: `accountIndex` presente,
  `amount` como entero decimal base 10.
- **CD-5** — Campaña de mutación con protocolo: respaldo físico + hash antes de mutar, y
  **verificar que el archivo mutado efectivamente se colectó** antes de creer un KILLED.
- **CD-6** — El guard no se sostiene sobre su propio razonamiento: el `try` externo del mapeo
  va **además** de los guards internos, con test propio (T-319-11).
- **CD-8** — Todo `detail` de indeterminación lleva prefijo **`terms_`** y causa distinguible.
- **CD-9** — **`landed_mismatch` NO puede volverse inalcanzable.** T-IDM-18b y T-319-12 son la
  prueba, y ninguno de los dos se puede debilitar.
- **CD-10** — **PROHIBIDO debilitar un guard para que una fixture vieja pase.** Si falla, se
  arregla la fixture.
- **CD-11** — Fixtures con `accountIndex` distinto por cuenta y `pre/postBalances` con valores
  realistas (`2039280` = rent-exempt · `0` = no existía). Un `1` genérico prueba menos de lo
  que parece.
- **CD-12** — El orden de los guards es parte del contrato: **`mismatch` es siempre el último**
  y exige que todo lo anterior haya salido bien.

**PROHIBIDO**

- **CD-13** — **NO tocar `SettlementPresence`** (`types.ts:170-187`): ni estados, ni campos en
  `landed_ok`.
- **CD-14** — **NO tocar `getOperatorSplBalance`** (`:210-220`) ni
  `downstream-payment.ts:383-390`. Fail-open deliberado y documentado. **No se re-litiga.**
- **CD-15** — **NO cambiar el `success:true` de `settleViaFacilitator:813`** ni el monto del
  recibo.
- **CD-16** — **NO tocar `wt-313`, `wt-315`, `wt-318`, `wt-314`, `wt-316` ni `main`.** Ni
  mergear, ni pushear, ni aplicar migraciones. **NO** actualizar el `_INDEX.md` del repo
  principal desde acá.
- **CD-17** — **NO git destructivo**: `reset --hard`, `clean -fd`, `stash drop/clear`,
  `checkout --` sobre trabajo sin commitear, `branch -D`.
- **CD-18** — **NO correr contra la red ni la base de producción**, ni usar credenciales
  reales. **NO** abrir `chaski-v3/m5-keys/`.
- **CD-19** — **NO agregar envs, banderas ni kill-switches** para los guards. Un guard de
  dinero apagable por configuración **es el fail-open con otro nombre**.
- **CD-20** — **NO redirigir a archivo la salida de comandos que leen archivos** (el proxy
  `rtk` trunca con exit 0 y ya corrompió un fuente). `Read`/`Write` siempre.

---

## Missing Inputs

**Bloqueantes: NINGUNO.** El SDD cerró sin `[NEEDS CLARIFICATION]` abiertos.

**`[NEEDS CLARIFICATION]` — declarados, no supuestos.** Ninguno bloquea el corte mínimo; todos
tienen su mitigación **ya en el diseño**, que es seguro en ambas ramas de la respuesta.

| # | Qué no se pudo determinar | Por qué no bloquea |
|---|---|---|
| NC-1 | **Si el RPC de producción omite `preTokenBalances` en alguna condición real.** El esquema lo **permite** (E-5, verificado), pero **no hay evidencia de que un nodo del pool lo haga** | El guard cierra la puerta pase o no. La **frecuencia esperada del `unknown` nuevo en producción es desconocida**: es la métrica a mirar post-deploy |
| NC-2 | **Si un nodo real omite la fila de `pre` para una ATA creada en la misma tx** (el supuesto de AC-5) | Diseño seguro en los dos casos: si la fila viene, se usa; si no, `preBalances[i]===0` la resuelve. Confirmación empírica = `devnet-e2e.manual.test.ts` |
| NC-3 | **Si el facilitator paga a la ATA canónica de `payTo` o a otra cuenta de token suya** (código en otro repo) | Por eso el conjunto receptor es una **unión** (DT-6) y **no** se pinea la ATA: el diseño no depende de la respuesta |
| NC-4 | **Si `message.accountKeys` incluye las direcciones cargadas por Address Lookup Table**, y si `pre/postBalances` cubren esos índices | Índice que no resuelve ⇒ tier de dirección no disponible; `preBalances[i]` fuera de rango ⇒ **indeterminate**, nunca un pase silencioso (AC-3) |
| NC-5 | **La explotabilidad on-chain del `find`**: se reprodujo **en memoria, no en cadena** | Entra al corte por **costo cero** (la agregación es la misma pasada que ya hace falta) y por su modo de falla fail-**closed**-permanente, no por estar probado explotable |
| NC-6 | **Auto-Blindaje de las HUs DONE 207-215**: no existen en `main`. Los patrones de `sdd.md` §3.3 salen de una fuente **indirecta** (el de `wt-315`, HU en vuelo) | Los CD derivados igual tienen respaldo cruzado en 209/208/203 |
| NC-7 | **Si algún test fuera de `src/adapters/solana/` observa `checkTerms` indirectamente.** Se verificaron `payment.flag.test.ts` y `settle-wiring.test.ts` (mockean `getParsedTransaction → null`, no llegan) pero **no se corrió la suite completa** | Trabajo de F3/F4 |
| NC-8 | **Las tres probes del encargo (`probe.ts`, `probe2.ts`, `probe3.ts`) NO están en `wt-319`**: no existe `scratchpad/` en el worktree | **QA no puede re-correrlas desde acá.** La evidencia de F4 tiene que salir de los tests T-319-1..20, que replican los mismos escenarios dentro de la suite. Si se quiere la repro original, hay que reconstruirla **como test**, no como script suelto |

---

## Análisis de paralelismo

Estado verificado por el Architect con `git log main..HEAD` en cada worktree (`sdd.md` §7).

| HU | Worktree | Commits sobre `main` | Toca `payment.ts` | Toca `adapters/types.ts` | Roce con 319 |
|---|---|---|---|---|---|
| WKH-313 | `wt-313` | 5 | No | No (toca `src/types/index.ts`, **otro archivo**) | **Ninguno** — paralelo libre |
| WKH-314 | `wt-314` | **0 — sin empezar** | **SÍ, la va a MOVER** | No | **ALTO** — ver abajo |
| WKH-315 | `wt-315` | 5+ | **No** (prohibido por su propia story: *"git diff vacío en `payment.ts`"*) | **Sí (+65, aditivo)** | **Bajo** — sólo `types.ts` |
| WKH-316 | `wt-316` | 0 | No | No | **Ninguno** |
| WKH-318 | `wt-318` | 1 | No | No | **Ninguno** |
| **WKH-319** | `wt-319` | — | **Sí** | **Sí (aditivo)** | — |

### ¿Bloquea a otras?

**Sí, a una: WKH-314. Orden recomendado y acordado por escrito: WKH-319 → WKH-314.**

WKH-314 declara que es la dueña de promover `probeSettlementPresence` y `checkTerms` a un
módulo nuevo `src/adapters/solana/presence.ts`, y declara explícitamente que **NO va a arreglar
el `.find()`** (lo parkea como `TD-INBOUND-MULTI-ATA`, mitigado con un *"preflight ruidoso"*).

Razones del orden:

1. **314 no está empezada** (0 commits): reordenar no cuesta trabajo tirado.
2. **319 es un fail-open vivo en el camino que paga; 314 es una feature.**
3. Si 314 va primero, 319 tendría que reescribir `presence.ts` — cuyo criterio de corrección es
   *"la suite del adapter queda verde **sin modificarse**"*. Esa prueba **no puede sobrevivir**
   a 319, que cambia 6 fixtures y la firma de la función. **Las dos HUs se pisarían el criterio
   de aceptación, no sólo el texto.**
4. Si 319 va primero, 314 **extrae la función ya arreglada** y `TD-INBOUND-MULTI-ATA`
   **se cierra sin trabajo** (AC-13).

**Enmienda que 314 va a necesitar** (tarea W3.4): su firma publicada
`checkSplTransferTerms(...): {ok:true}|{ok:false;error}` pasa a `SolanaTermsVerdict`. Cambio de
una línea en su SDD, y **mejora** su contrato: la HU de entrada necesita el tercer valor
todavía más que la de salida.

### ¿Puede ir en paralelo?

- **Con WKH-313, WKH-316, WKH-318: sí, sin restricción.**
- **Con WKH-315: sí.** Único roce textual: `src/adapters/types.ts`, donde las dos agregan
  **bloques aditivos distintos al final** y **ninguna toca `SettlementPresence`**. Conflicto de
  merge esperado: **trivial** — el que mergee segundo resuelve **concatenando**. El orden entre
  las dos es indistinto.
- **Con WKH-314: no.** 319 primero.

---

## Deuda declarada

| ID | Qué | Estado |
|---|---|---|
| **TD-319-1** | El recibo del leg (`settledAmount`, `nonEvmSettle.amountUsd`) usa el monto que **pedimos**, no el **medido** | **HU aparte.** Esta HU deja el hecho medido disponible (`creditedAtomic`) y logueado |
| **TD-319-2** | Cuatro primitivos quedan transcritos en dos archivos (`payment.ts` y `deposit-verifier.ts`) | Se unifican cuando **WKH-314** promueva `presence.ts` |
| **TD-INBOUND-MULTI-ATA** | Parkeada por WKH-314 (su R-4 / DT-8) | **Esta HU la CIERRA** (AC-13) |

---

## Definition of Ready — checklist

| # | Ítem | Estado |
|---|---|---|
| 1 | El bug está **medido por ejecución**, no inferido | ✅ E-1..E-9 |
| 2 | Alcanzabilidad verificada contra el bundle instalado del SDK | ✅ E-5, E-6 |
| 3 | ACs en **EARS**, sin lenguaje vago, todos con evidencia esperada `archivo:línea` o test-ID | ✅ 30 ACs |
| 4 | **ACs de sobre-corrección** presentes y marcados | ✅ 10 marcados `[SC]` |
| 5 | Scope IN y OUT explícitos, con razón por ítem del OUT | ✅ |
| 6 | Sizing decidido | ✅ QUALITY · `full` · M · corte mínimo W0+W1 |
| 7 | Decisiones técnicas trazadas al SDD, **no re-litigadas** | ✅ DT-1..DT-12 |
| 8 | Constraint Directives en namespace compartido con el SDD | ✅ CD-1..CD-20 |
| 9 | Análisis de paralelismo con las 5 HUs en vuelo, verificado con `git log` | ✅ |
| 10 | Lo que **no se pudo determinar** está declarado, no supuesto | ✅ NC-1..NC-8 |
| 11 | Bloqueantes | ✅ ninguno |
| 12 | `_INDEX.md` del repo principal | ⏸️ **Deferido a W3.2** (prohibido tocarlo desde `wt-319`, CD-16) |
