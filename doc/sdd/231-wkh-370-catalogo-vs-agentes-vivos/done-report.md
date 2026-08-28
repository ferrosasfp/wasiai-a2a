# Done Report — HU [WKH-370] · El vigilante del catálogo: nada compara el catálogo con los agentes vivos

> Fase **DONE** · Rol `nexus-docs` · 2026-08-27
> Rama `feat/231-wkh-370-catalogo-vs-agentes-vivos` · HEAD de la HU `c0eb5be` · base `091db28`
> Issue de origen: `github.com/ferrosasfp/wasiai-a2a/issues/186`

## ⚠️ Cómo leer este reporte

Todo número de acá sale de un artefacto de esta carpeta o de un comando que corrí yo en esta fase.
Lo que no pude respaldar, **no está**. Cuando dos artefactos dan números distintos sobre lo mismo,
**digo los dos y cuál medí yo** (pasa una vez, en la escala del §7).

---

## 1 · Resumen ejecutivo

Se entrega **un vigilante del catálogo**: `scripts/check-catalog-vs-live.mjs` (609 líneas) con
**dos chequeos de familias distintas**, **siete clases con siete códigos de salida propios**, y
`.github/workflows/check-catalog-vs-live.yml` (271 líneas) que los corre como **dos jobs sin
`needs:`** — si falta la credencial de la mitad de completitud, **la mitad de deriva sigue
corriendo**, y la que no pudo correr sale `CONFIG(3)` nombrando la env en vez de fingir un verde.

Status final: **DONE**. F4 lo aprobó con **10/10 ACs PASS, 0 FAIL**, todos con evidencia
**ejecutada** (`qa-validation.md` §1). El gate del repo está verde y lo corrí yo al cerrar (§8).

Archivos clave: `scripts/check-catalog-vs-live.mjs` · `test/check-catalog-vs-live.test.mjs` (831
líneas, 40 tests) · `.github/workflows/check-catalog-vs-live.yml` · `src/services/agent.ts`
(el booleano `hasPayoutWallet`) · `src/services/agent.completeness.test.ts`.

---

## 2 · La tesis, que es la razón de existir de la HU

> **Una fila mal nacida se ve igual que una sana desde el catálogo.**
> Deriva y completitud son **dos preguntas distintas** y **ninguna implica a la otra**.

- **DERIVA** — el catálogo (`a2a_agents`) y el manifiesto que sirve el agente dicen cosas distintas.
- **FILA MAL NACIDA** — la fila está **incompleta**, no desincronizada: nació sin `metadata` y sin
  `payout_wallet`, así que **no difiere** del manifiesto, simplemente **no tiene nada que comparar**.
  Un chequeo de deriva la reporta como **conforme**.

Y la consecuencia de la segunda es de dinero, verificada en código: con `payout_wallet` nulo,
`src/services/agent-split-context.ts:50-52` devuelve `creator: null` ⇒ la pata de creador del split
no existe y el 1 % se re-rutea a plataforma. El modo de falla es **mudo por diseño**: no es un error
que caiga en el best-effort de CD-10, es **la rama normal del ternario**, y no loguea nada.

La HU la volvió **ejecutable**, no una advertencia en prosa: es **AC-3**, y el QA la reprodujo con
el mismo fixture saliendo por las dos mitades (`qa-validation.md` §4, escenario B):

```
INCOMPLETA: 1 fila(s) mal nacida(s) … | modo=completitud comparados=1 derivas=0 incompletas=1   exit = 5
CONFORME:                             … | modo=deriva      comparados=1 derivas=0 incompletas=0   exit = 0
```

**La misma fila, mismo fixture, dos veredictos opuestos.** Sin la mitad de completitud esa fila
salía `exit 0` y nadie la miraba — que es exactamente lo que le pasó a `remit-kyc-session` y
`remit-kyc-decision`.

---

## 3 · Qué entrega, concretamente

### 3.1 · Las siete clases y sus siete exit codes

`scripts/check-catalog-vs-live.mjs:85-91`, verificado abriendo el archivo en esta fase:

| Exit | Clase | Qué acusa |
|---|---|---|
| `0` | `CONFORME` | se comparó al menos un par y todo lo elegible está al día |
| `1` | `DEFECTO` | defecto del propio chequeo (excepción no manejada) — **la escalera nunca lo emite** |
| `2` | `INALCANZABLE` | **el otro no contestó** |
| `3` | `CONFIG` | **yo no estoy en condiciones de preguntar** |
| `4` | `DERIVA` | el catálogo y el manifiesto vivo difieren |
| `5` | `INCOMPLETA` | fila mal nacida |
| `6` | `UNRESOLVED` | contestó, pero no puedo confiar en que sea el agente que creo |

El docblock del script (`:20-25`) declara la distinción `INALCANZABLE` ≠ `CONFIG` en esos términos,
y **esa definición es la que después obliga al cierre del `BLQ-BAJO-1`** (§5).

### 3.2 · Los dos jobs, y por qué NO hay `needs:`

`.github/workflows/check-catalog-vs-live.yml`, leído en esta fase: `jobs:` en `:70`, job `deriva`
en `:71`, job `completitud` en `:178`, **ningún `needs:` en el archivo** (la única aparición de la
palabra está en el docblock `:11-15`, que explica la decisión). `cron: '23 6 * * *'` (`:55`).

- `deriva` → sólo `GET /discover` público + los manifiestos. **Cero secretos.** Corre siempre.
- `completitud` → necesita `A2A_CATALOG_OWNER_KEY`, y lleva `if: github.event_name != 'pull_request'`
  (`:183`) para que **la credencial no llegue a ninguna corrida de PR**.

**Cuatro títulos de issue, dos propios y distintos** (`:118`/`:164` para deriva, `:221`/`:261` para
completitud), abrir con `if: failure() && github.event_name == 'schedule'` y cerrar con
`if: success() && …`. Es CD-6: los otros dos workflows del repo dedupean **por título exacto**, así
que compartir título haría que un chequeo cierre el aviso del otro.

### 3.3 · La corrida REAL contra producción — medida por el QA, coste 0 USDC

```
CONFORME: … | modo=deriva catalogo=29 elegibles=5 comparados=5 derivas=0 incompletas=0
unresolved=0 inalcanzables=0 sindato=0 excluidos=24 outputSchemaPresente=3/5   exit 0
sin credencial → CONFIG(3) nombrando la env. Ni verde ni INALCANZABLE.
```

Tres cosas que hay que leer en esa línea, y están todas dichas en el propio mensaje:

1. El verde dice que **los 5 elegibles** están al día. **No dice nada de los 24 excluidos**, y esos
   24 salen enumerados uno por uno con su motivo escrito (`registry=WasiAI no publica manifiesto
   propio`) — AC-5 y CD-10: **ninguna exclusión en silencio**.
2. `catalogo=29 elegibles=5 excluidos=24` está **derivado, no hardcodeado** (CD-16 / MI-5: el
   número se mueve, y dos filas del índice lo dan como 25 y 29 en fechas distintas).
3. `outputSchemaPresente=3/5` es la deuda `TD-370-OUTPUTSCHEMA-SIN-FUENTE` **hecha visible en la
   línea**, no tapada: 3 filas del catálogo traen un `outputSchema` que **ningún** manifiesto
   respalda (0/5 medido en `sdd.md` §3.4).

---

## 4 · Pipeline ejecutado

| Fase | Artefacto | Resultado |
|---|---|---|
| **F0 + F1** | `work-item.md` | 10 ACs EARS. ⚠️ Corrió **sin shell** (sólo Read/Write/Glob): cada cita marcada `[MEDIDO-F1]` / `[HEREDADO]` / `[NO MEDIDO]`. Sizing **subido de FAST+AR a QUALITY con razón escrita** |
| ⛔ | `HU_APPROVED` | otorgado por el humano |
| **F2** | `sdd.md` (559 líneas) | Cierra MI-1..MI-7. **MI-2 medido**: el manifiesto es `invokeUrl` con `/invoke`→`/manifest`, 200 en 5/5. **MI-3 decidido: opción 3b** con 5 mitigaciones |
| ⛔ | `SPEC_APPROVED` | otorgado por el humano |
| **F2.5** | `story-file.md` (782 líneas) | 33 test IDs, escalera de §5, presupuesto de escala por archivo |
| **F3** | `20b3102` · `auto-blindaje.md` | **5 waves** (W0 serial → W1 dos carriles → W2 workflow → W3 falsabilidad → W4 cierre) · **13 archivos fuera de `doc/`** |
| **AR** | `ar-report.md` | ❌ **RECHAZADO** — 3 bloqueantes + 2 menores |
| **CR** | `cr-report.md` | ❌ **RECHAZADO** — 2 bloqueantes + 5 menores |
| **fix-pack it. 1** | `7fdd4fc` | los **5 bloqueantes consolidados** cerrados |
| **AR-2** | `ar-report-2.md` | ✅ **APROBADO**, 0 bloqueantes. Los 5 cierres re-verificados **ejecutando**, sin creerle al Dev en ningún punto |
| **fix-pack it. 2** | `f86be49` | `MNR2-1` cerrado (**sin tocar la lógica**: faltaba el test) |
| **F4** | `qa-validation.md` | ✅ **APROBADO PARA DONE** — **10/10 ACs PASS**, 0 FAIL, 0 no verificable |
| **DONE** | este archivo | las 5 citas del índice re-derivadas, AC-4 amendado, `_INDEX-row.md` borrado, gate corrido |

**El recorrido en una línea**: AR❌ + CR❌ (5 bloqueantes consolidados) → fix-pack → re-AR ✅ →
`MNR2-1` → F4 **10/10 ACs**.

---

## 5 · Los 5 bloqueantes, y cómo se cerraron

| ID | Origen | Qué era | Cierre, verificado por el AR-2 **ejecutando** |
|---|---|---|---|
| **BLQ-1** | AR | **Tres mutantes sobreviven la suite 35/35 verde**, y M9 produce un **falso verde end-to-end** (`exit=0 CONFORME … comparados=1 sindato=0` sobre algo que nunca se midió) | `T-C6`, **un test por `main()`**, no por `classify()`. M8/M9/M14 **re-hechos** por el AR-2: cada uno rojo por su motivo. ⚠️ M14 **deja el exit correcto**: lo mata **sólo** `toMatch(/ comparados=0 /)` |
| **BLQ-2** | CR | Las dos citas de la prosa de `ownership-filter-guard.exceptions.ts` apuntaban a la **firma** de `update` y a una **apertura de docblock**, no a los chequeos de dueño | Re-derivadas **abriendo la línea**; al `7fdd4fc` son `:715`/`:890` (el propio fix-pack desplazó `agent.ts` +4). **11 anclas** verificados uno por uno + `TD-370-EXCEPTIONS-SIN-GUARDIAN` declarada |
| **BLQ-3** | AR | Una credencial **revocada** (`401`/`403`) salía `INALCANZABLE(2)` — *"esto NO dice que el catálogo esté mal"*—, mientras la **ausente** ya salía `CONFIG(3)`. **El mismo hecho por dos códigos** | Fila **`4b`** (numerada así **a propósito para no correr los números del contrato del W0**). Arnés propio del AR-2 sobre `401`,`403`,`503`,`500`,`429`: los dos primeros a `CONFIG(3)`, **el `503` no se movió** |
| **BLQ-4** | AR | `1 manifiesto caído + 4 derivas REALES` salía `exit=2` con *"esto NO dice que el catálogo esté mal"* **en la misma línea que decía `derivas=4`** | Guard `&& !acusaAlCatalogo` en las filas 8 y 9 — **sin mover filas**, para que la escalera se siga auditando renglón por renglón contra §5. AR-2: **378 combinaciones, 0 divergencias** contra una semántica de referencia **escrita a mano** |
| **BLQ-5** | CR | El párrafo de CD-23 decía *"`AgentRow` no las tipa"* de **tres** columnas, y `AgentRow` **sí tipa `owner_ref`** (`agent.ts:63`). Lo que protege a `owner_ref` es una **barrera de VALOR**, y el párrafo la vendía como de tipo | Sujeto acotado a las dos columnas donde es cierto + `T-S6`, que **deriva del fuente** el contenido de `AgentRow`. AR-2: **7 mutantes, tres sobre el TIPO**, todos muertos ⇒ `T-S6` **no se lee a sí mismo** |

---

## 6 · Acceptance Criteria — resultado final

Los 10 con evidencia **ejecutada** (`qa-validation.md` §1). ⛔ Ninguno se apoya en una cita sola.

| AC | Status | Evidencia (ejecutada) |
|---|---|---|
| **AC-1** deriva con slug + campo + las dos huellas | ✅ PASS | Prod: `comparados=5`. Escenario A: `HALLAZGO: remit-corridor-fx-solana tipo=deriva campo=inputSchema catalogo=f55d5f37eef2 manifiesto=a8902398d897` → `exit 4` |
| **AC-2** completitud separada, etiquetas y códigos distintos | ✅ PASS | Escenario B: la **misma fila** sale `INCOMPLETA(5)` y `CONFORME(0)` en dos corridas de `main()` que no se consultan. Dos jobs sin `needs:` (T-Y1) |
| **AC-3** 🎯 **LA TESIS** | ✅ PASS | `INCOMPLETA … incompletas=1` **en la misma línea que dice `derivas=0`** → `exit 5`. Barrido de **8.748 combinaciones: 0 violaciones** del invariante `incompletas>0 ⇒ nunca CONFORME` |
| **AC-4** anti-vacuidad | ✅ **PASS con desvío literal declarado** | `comparados===0 ⇒ CONFORME` sucede **0 veces** en 8.748 combinaciones, con control positivo. ⚠️ La primera cláusula no es literal — **texto amendado en DONE**, §9 |
| **AC-5** exclusión con motivo escrito | ✅ PASS | Prod: línea `EXCLUIDOS:` con los **24** federados, uno por uno, cada uno con su motivo |
| **AC-6** clave de unión verificada | ✅ PASS | Escenario E: manifiesto que se declara `otro-agente` → `UNRESOLVED(6)` con `comparados=0 derivas=0` ⇒ **no comparó ni un campo pese a que el `inputSchema` DIFERÍA** |
| **AC-7** el cero uniforme acusa al instrumento | ✅ PASS | Escenario C: 5 elegibles con `inputSchema` en la **raíz** → `CONFIG(3)`, **no** "5 derivas". Y el corte pasa **antes de salir a la red** (`:491`) |
| **AC-8** un exit code por clase | ✅ PASS | El QA **observó los 6 códigos que la escalera puede emitir**: `0`, `2`, `3`, `4`, `5`, `6`. El `1` está **reservado** y la escalera nunca lo emite |
| **AC-9** issue con título propio, abrir y cerrar | ✅ PASS (estructural) · runtime **post-deploy** | YAML real: 2 jobs, cron, 4 títulos, `if: failure()`/`if: success()` + `schedule`. ⚠️ La corrida **programada** no se puede ejecutar antes del merge |
| **AC-10** rojo por su MOTIVO + control positivo | ✅ PASS | **Tres mutantes propios del QA**, uno por clase, cada rojo leído por su motivo. Árbol **byte-idéntico** por `sha256sum`, `git status --porcelain` vacío |

**10/10 PASS · 0 FAIL · 0 NO VERIFICABLE.**

---

## 7 · Hallazgos finales

### BLOQUEANTEs — **5 de 5 resueltos, 0 pendientes**

Los 3 del AR + los 2 del CR, cerrados en `7fdd4fc` y **re-verificados ejecutando** por el AR-2
(`ar-report-2.md`), que no le creyó al Dev en ningún punto y re-hizo cada cierre con mutación o
arnés propio.

### MENORes

| # | Estado |
|---|---|
| `MNR-1` (AR) · un `/discover` que rompe su contrato con `200` salía como *"no contestó"* | ✅ **Resuelto** (`T-E7`) |
| `MNR-2` / `MNR-4` (CR/AR) · los dos npm scripts eran **el mismo comando sin `CHECK_MODE`**, y `T-S4` **clavaba el cuerpo duplicado** | ✅ **Resuelto** — arreglados los scripts **y el test con ellos**. *El verde de hoy no validaba los scripts: los congelaba* |
| `MNR-CR-1` · *"los cuatro llamadores"* nueve renglones después de *"sus tres"*. Son **tres** | ✅ **Resuelto** — `T-S6` los **cuenta sobre el fuente** |
| `MNR-CR-2` · `citations.ts` con los números viejos | ✅ **Resuelto** (mismo mecanismo que BLQ-2) |
| `MNR-CR-3` · **provenance falsa** en `TD-370-CITAS-FUERA-DEL-CORTE` | ✅ **Corregida la provenance, no la conclusión**: las tres citas **ya estaban podridas en `091db28`** |
| `MNR2-1` (AR-2) · quitar `\|\| schema === null` dejaba la suite en **36 passed** — y es **alcanzable**: `PATCH /agents/:slug` con `{"inputSchema": null}` persiste `metadata.inputSchema: null` | ✅ **Resuelto en `f86be49`** — ⛔ **la lógica NO se tocó** (el script quedó byte a byte idéntico a `f797298`); faltaba el fixture |
| `MNR2-2`, `MNR2-3` (AR-2) · mutantes **equivalentes / defensivos puros**, ramas inalcanzables por el camino real | 🟡 **Aceptados como TD, documentados** para que no se re-descubran |
| `MNR2-4` (AR-2) · las **5 citas podridas** de la fila del índice | ✅ **Cerrado en DONE** — §9 de este reporte |
| `MNR2-5` (AR-2) · una cita cuyo `mustContain` **no sostiene la frase que decora** (el ancla verifica que la línea existe, no que respalde lo que se afirma al lado) | 🟡 **Pre-existente, fuera de Scope IN** ⇒ backlog |
| `MNR-CR-5` · `GET /agents` no está en la tabla de endpoints de `doc/INTEGRATION.md`. Consecuencia: `hasPayoutWallet` nace sin sitio canónico | 🟡 **Hueco pre-existente**, fuera de Scope IN ⇒ backlog |

### Deuda técnica declarada

| TD | Dónde vive | Qué dice |
|---|---|---|
| **`TD-370-EXCEPTIONS-SIN-GUARDIAN`** | `auto-blindaje.md` + `ar-report-2.md` §2 | `test/ownership-filter-guard.exceptions.ts` es **el archivo que justifica por qué una query NO lleva filtro de ownership** — el artefacto que la sección *Security Conventions* de `CLAUDE.md` manda auditar — y **ningún guardián verifica sus citas de prosa**. **Medido**: con tres citas a `:99999` el gate completo sale **VERDE**. Cerrarla obliga a meter el archivo en `CORTE_A_PATHS`, declarar **todas** sus citas de una vez y mover los invariantes de conteo del guardián ⇒ **es una HU propia** |
| **`TD-370-OUTPUTSCHEMA-SIN-FUENTE`** | docblock de `scripts/check-catalog-vs-live.mjs:47-56` | `outputSchema` **no está en ninguno de los 5 manifiestos** (0/5) y **3 filas del catálogo sí lo traen** ⇒ no entra a la escalera, **sólo se cuenta**. Exigirlo haría nacer el chequeo en rojo por un criterio sin fuente de verdad |
| **`TD-370-KEY-SOLO-LECTURA`** | docblock de `.github/workflows/check-catalog-vs-live.yml` | **No existe ninguna agent key de sólo lectura**: `GET /` (listMine), `PATCH /:slug` y `DELETE /:slug` usan **el mismo** `requireA2AKey()` ⇒ cualquier credencial capaz de leer `listMine` **puede borrar esas filas**. El día que exista una key read-only, o RLS + vista sobre `a2a_agents` (WKH-SEC-02), este secreto se degrada |
| **`TD-370-CITAS-FUERA-DEL-CORTE`** | `auto-blindaje.md` | 3 sitios citan `services/agent.ts` desde fuera de `CORTE_A_PATHS` (`discovery.ts`, `orchestrate.ts`, `services/agent.ownership.test.ts` — este último con **5** tokens podridos, no 1). **Ya estaban podridas en `091db28`**; esta HU las desplazó más, **no las rompió**. Se dejan **a propósito**: arreglarlas violaría CD-9 |
| **`TD-370-RLS-SET-INCOMPLETO`** | `sdd.md` DT-3 | `a2a_agents` **tiene `owner_ref`** y **no está** en `RLS_TABLES` (`scripts/verify-rls-enabled.mjs:23-34`). Discrepancia real entre el criterio escrito de `CLAUDE.md` y la lista de ese script. **No se tocó acá** |

### Escala — mi propia medición, y la discrepancia que encontré

Presupuesto del `sdd.md` §9: **≈1.040 líneas fuera de `doc/`, techo 1.100**, y la regla explícita
*"si el diff supera 2.200 líneas fuera de `doc/`, se justifica por escrito o se recorta"*.

Medido por mí en esta fase, `git diff --numstat 091db28 <c> | grep -v doc/sdd/231`:

| Commit | Fuera de `doc/` |
|---|---|
| `20b3102` (fin de F3) | **+1.766 / −30** |
| `f86be49` (fin del fix-pack 2) | **+2.027 / −31** |
| `c0eb5be` (HEAD de la HU) | **+2.027 / −31** |

El **1.766** del `ar-report.md` reproduce **exacto** mi medición de `20b3102`, que es el árbol que
el AR revisó. ⚠️ **`qa-validation.md` §8.1 cita "~1.780" para `f86be49`, y mi medición del mismo
rango da +2.027**: la diferencia (261 líneas) es del orden del workflow, y **no la pude reconciliar**
con el comando que el QA no dejó escrito. **La conclusión no cambia con ninguno de los dos números**:
2.027 < 2.200, el techo que la propia HU se fijó. Lo dejo dicho porque un número que no cierra es
información, y taparlo sería exactamente lo que esta HU existe para no hacer.

El desglose de `agent.ts` (`cr-report.md` check 2) es lo que hace legible el exceso:
**85 líneas agregadas · 76 de comentario/docblock (89 %) · 9 de código.** Las 9 son el tipo, el
campo, la firma, la expresión y los 3 casts — *la parte que escribiría alguien que ya conoce el
repo*. Las 76 son el precio de I-2 + CD-23, **ambos obligatorios por contrato**.

---

## 8 · Las tres decisiones donde el Dev rechazó lo prescrito **con medición**

Ninguna es preferencia de estilo: las tres traen el número que las sostiene.

### 8.1 · `OwnedAgentRow` en vez de ampliar `AgentRow`

El Story File (D-2 paso 1) prescribía *"agregar a `AgentRow` una sola línea: `payout_wallet`"*.
El Dev **no lo hizo**, y creó `type OwnedAgentRow = AgentRow & { payout_wallet: string | null }`,
que tipa **sólo** el parámetro de `mapRowToRecord` (el shape del **dueño**).

**El motivo, que es el hallazgo**: la decisión de WKH-143 (*"NO ampliar esta interfaz"*) traía su
razón escrita entre paréntesis — ***alimenta mappers públicos***. `AgentRow` es el tipo del
parámetro de **`mapRowToAgent`**, el mapper del catálogo **ANÓNIMO**. Ampliarlo haría que la columna
exista **para el compilador** dentro del mapper público, y la única barrera restante sería *que a
nadie se le ocurra escribirla en el objeto de retorno*.

**Medido por el AR, no argumentado**: insertó `verified: row.payout_wallet !== null` en
`mapRowToAgent` y corrió `tsc`:

```
L211: TS2339 Property 'payout_wallet' does not exist on type 'AgentRow'.
```

> **La barrera es el tipo, no la buena voluntad.**

Verificado por mí en esta fase: `src/services/agent.ts:54-65` sigue listando **10 columnas sin
`payout_wallet`**. El QA lo clasificó explícitamente: **no es drift, es mejor que lo prescrito.**

### 8.2 · `OwnedAgentRow` en vez de `getSplitContextRow` — habría sido N+1

La salida "obvia" que el orquestador señaló era usar `getSplitContextRow`, que **ya** selecciona
`owner_ref, payout_wallet, referrer_ref`. El Dev la rechazó con el mecanismo escrito: ese lector va
**por slug**, y `mapRowToRecord` es un mapper **SÍNCRONO** al que `listMine` le pasa **N filas de
una sola query**. Cablearlo ahí convierte `GET /agents` en **una query por agente** —el patrón
anti-N+1 que `listPublisherAnchors` existe para no repetir, **y el mismo cargo que esta HU le hace
a `GET /discover/<slug>`**— y además vuelve asíncrono a un mapper puro y a sus **tres** llamadores.

> **Se paga más y se protege menos**: la columna seguiría siendo legible desde el mapper público vía
> una llamada, y encima con costo.

El CR lo ratificó (check 4): *"El Dev descartó la alternativa por el motivo correcto"*.

### 8.3 · El guard de las filas 8/9 en vez de mover las filas

Para el `BLQ-4` había dos salidas legítimas —mover 8/9 debajo de 10/11, o cambiarles el mensaje— y
el Dev tomó **una tercera que las domina**: el mismo `guard` que la fila 7 ya usa
(`&& !acusaAlCatalogo`).

- Mover las filas habría sido **drift del contrato del W0** ⇒ la escalera dejaría de auditarse
  renglón por renglón contra §5 del Story File.
- Cambiar sólo el mensaje habría dejado **el exit code mintiendo**, que es lo que AC-8 le pide al
  humano que lea.

Y el AR-2 no le creyó: recorrió los 6 contadores en `{0,1,2}` contra una **semántica de referencia
escrita a mano** (*"10 y 11 antes que 8 y 9"*), **no derivada del fuente** para no compararse
consigo mismo:

```
casos evaluados: 378 · divergencias: 0 · caídas al fondo de la escalera: 0
inalcanzables=1 derivas=4  (coexisten)    → DERIVA(4)
inalcanzables=1 derivas=0  (NO coexisten) → INALCANZABLE(2)   ← la fila 8 sigue ganando
SOLO un manifiesto caído                  → INALCANZABLE(2)   ← 🎯 el caso legítimo NO quedó tapado
```

⇒ el guard **no es decorativo en ninguna de sus dos patas**, y la afirmación del docblock es
verdadera **en todo el espacio de contadores**, no sólo en los cuatro casos pedidos.

---

## 9 · Lo que se **midió** en vez de suponerse

Esta es la propiedad que separa a esta HU de un chequeo que sale verde: **cada afirmación fuerte
tiene una corrida detrás, y cada silencio tiene su control positivo.**

### 9.1 · El silencio del guardián de `exceptions.ts` — con su control positivo

El AR-2 podrió **tres** citas de prosa de `ownership-filter-guard.exceptions.ts` a líneas que **no
existen** (`:99999` / `:99998`, en un archivo de 950) y corrió el gate completo:

```
Test Files 314 passed | 6 skipped (320) · Tests 6350 passed | 19 skipped (6369)   exit 0
```

**VERDE. Ningún guardián mira ese archivo.**

⚠️ Y acá está la parte que hace que la medición valga: **un verde no prueba nada si el instrumento
no puede ponerse rojo.** El AR-2 podrió entonces el campo **estructural** `line:` de `citations.ts`,
que **sí** tiene guardián:

```
3 failed | 9 passed   exit 1
```

⇒ **el verde de arriba es silencio real, no un instrumento apagado.** Sin ese contraste,
`TD-370-EXCEPTIONS-SIN-GUARDIAN` sería una sospecha; con él es un hecho.

### 9.2 · Las 378 combinaciones de la escalera contra una semántica escrita a mano

Ver §8.3. Lo que hay que retener del **método**: la semántica de referencia se escribió **a mano
desde el texto**, no se derivó del fuente. Un invariante que recalcula la fórmula que vigila
**aplaude cualquier cosa**.

### 9.3 · Las 8.748 combinaciones del QA, con control positivo del barrido

El QA importó `classify` del script real y recorrió `{modo} × {credencial} × {6 contadores en
0,1,2}` comprobando invariantes **escritos por él desde el texto de los ACs**, no desde el fuente:

```
combinaciones evaluadas: 8748
AC-4 violaciones (comparados=0 y CONFORME):        0
AC-3 violaciones (incompletas>0 y CONFORME):       0
AC-7 violaciones (cero uniforme y DERIVA):         0
con comparados=0, clases emitidas: {"CONFIG":1404,"INALCANZABLE":126,"UNRESOLVED":42,"INCOMPLETA":1008,"DERIVA":336}
CONTROL POSITIVO (classify falso que rompe AC-4): violaciones detectadas = 2 (debe ser 2)
```

⚠️ **El control positivo no es decorativo**: un barrido que sólo verifica una AUSENCIA pasa igual
cuando no ejecutó nada. Sustituyó `classify` por uno deliberadamente roto y el barrido **lo
detectó** ⇒ los tres ceros son silencio real.

### 9.4 · Y de esa misma tabla salió el hallazgo del §10

La fila `con comparados=0` muestra `UNRESOLVED: 42` e `INALCANZABLE: 126`. **Eso es lo que hizo
falsable el texto de AC-4.** El instrumento que midió el cumplimiento es el que encontró que el
contrato afirmaba de más.

---

## 10 · AC-4: el texto amendado, y por qué **eso es el hallazgo**

`work-item.md` fue amendado en esta fase — **la única edición a un artefacto previo, y está
declarada dentro del propio artefacto con el original a la vista**.

**Qué decía** (F1): *"…THEN the system SHALL salir con clase **CONFIG** y SHALL NOT salir con clase
conforme."*

**Qué mide el QA**: con `comparados === 0`, la clase puede ser `UNRESOLVED(6)` (escenarios D y E) o
`INALCANZABLE(2)` (manifiesto caído). La **primera** cláusula no es literal.

**Qué se cumple sin excepción**: la **segunda** —**jamás conforme**— con **0 violaciones sobre las
8.748 combinaciones**, con control positivo.

**Por qué el desvío es una mejora y no un incumplimiento**: la cláusula (i) **choca de frente con
AC-8**. `CONFIG` afirma por contrato que *acusa al INSTRUMENTO* y *no implica a producción*. Con la
escalera literal, *"los cinco manifiestos están caídos"* se reportaba como *"yo no estoy en
condiciones de preguntar"*: **una mala atribución**, que es justo lo que las siete clases existen
para evitar. Y el contrato no pudo verlo porque **el conflicto sólo aparece con un único elegible**:
con más de uno basta que uno compare.

**El texto nuevo dice lo que el código hace y garantiza**, y el original queda visible como
corrección. No se borró: **que un AC afirme de más es el hallazgo**, no una errata — en la HU que
existe para sacar prosa que afirma de más.

---

## 11 · ⚠️ MI-8 — acción del founder: crear el secreto `A2A_CATALOG_OWNER_KEY`

**Falta crear el secreto `A2A_CATALOG_OWNER_KEY` en los Actions del repo** (una agent key del owner
de los 5 agentes self-published; alta por el founder).

**Hasta entonces, la mitad de completitud sale `CONFIG(3)` todos los días** — y hay que decirlo así
de claro:

> **Eso es el diseño funcionando, no una falla.**

Medido contra producción por el QA, con `env -u A2A_CATALOG_OWNER_KEY` para garantizar la ausencia:

```
CONFIG: falta la credencial A2A_CATALOG_OWNER_KEY — la completitud NO se verificó, y un sin dato
        jamás sale por exit 0 | modo=completitud …            exit = 3
```

Las tres propiedades que hacen que eso sea correcto:

1. **No sale verde.** Un dato ausente no es un dato bueno.
2. **No sale `INALCANZABLE(2)`.** No acusa a producción de una caída que no existe.
3. **Nombra la env.** El humano sabe qué hacer sin leer el código.

Y **la mitad de deriva sigue corriendo igual**, porque los dos jobs no tienen `needs:`. Ésa es la
razón entera por la que el workflow está partido.

⚠️ Cuando el secreto exista, el modo de falla a vigilar cambia: si sale `401`/`403`, la clase sigue
siendo **`CONFIG(3)`** y el mensaje dice *"hay que rotarla"* — **eso tampoco es una caída de
producción** (es el cierre del `BLQ-3`).

---

## 12 · Archivos modificados

`git diff --name-status 091db28 c0eb5be` → **17 archivos**. Agrupados por dominio:

### El chequeo (Scope IN, nuevo)
| Archivo | Δ |
|---|---|
| `scripts/check-catalog-vs-live.mjs` | **+609** (nuevo) — el vigilante: 7 clases, escalera pura, huella de schema |
| `test/check-catalog-vs-live.test.mjs` | **+831** (nuevo) — 40 tests, incluidos los rojos a propósito de AC-10 |
| `.github/workflows/check-catalog-vs-live.yml` | **+271** (nuevo) — 2 jobs sin `needs:`, cron `'23 6 * * *'`, 2 títulos de issue propios |
| `package.json` | +3 / −1 — los dos npm scripts, **con su `CHECK_MODE`** (cierre de `MNR-4`) |

### El booleano de completitud (`src/`, opción 3b de DT-3)
| Archivo | Δ |
|---|---|
| `src/services/agent.ts` | +89 / −7 — `OwnedAgentRow`, `hasPayoutWallet`, y **76 de las 89 son docblock** |
| `src/services/agent.completeness.test.ts` | **+192** (nuevo) — T-B1/T-B2: el booleano **por valor**, no sólo por clave |
| `src/routes/agents.publish.test.ts` | +6 — el fixture compartido `RECORD_RESPONSE`, que un campo **requerido** rompe. **Desvío del Scope IN declarado** |

### Arrastre de citas por desplazamiento (los 4 declarados)
| Archivo | Δ | Por qué |
|---|---|---|
| `test/ownership-filter-guard.exceptions.ts` | +9 / −9 | El guardián registra **5 sitios de `agent.ts` por número de línea** |
| `test/cited-lines-guard.citations.ts` | +10 / −7 | 3 citas del Corte A + la advertencia de que dos números son **prosa** |
| `src/routes/agents.ownership.test.ts` | +2 / −2 | Dos citas de prosa desplazadas |
| `src/types/index.ts` | +1 / −1 | Una cita de prosa desplazada |

### Conteos del repo
| Archivo | Δ |
|---|---|
| `README.md` · `README.es.md` | +2 / −2 c/u — los dos números que `test/readme-numbers.test.ts` verifica **contra el índice de git** |

### Documentación de la HU
`doc/sdd/231-…/`: `auto-blindaje.md`, `ar-report.md`, `cr-report.md`, `ar-report-2.md`,
`qa-validation.md` (los 5 en el diff de la rama) + `work-item.md`, `sdd.md`, `story-file.md` (ya en
`091db28`) + **este `done-report.md`**.

⛔ **NO se tocaron**: `src/services/discovery.ts`, el camino del dinero, el pin del KYC,
`src/routes/agents.ts`, `.env.example`. **CD-9 y CD-24 respetados**, verificado por el QA (§8.1) y
por el AR-2 (que además confirmó que **las 3 citas que CD-9 manda dejar podridas siguen podridas**).

---

## 13 · Auto-Blindaje consolidado

**Las 22 entradas de `auto-blindaje.md`, íntegras** — la lección de cada una, en el orden en que se
escribieron. ⛔ Ninguna se resumió ni se omitió: las lecciones futuras dependen de esto.

### F3 — implementación

| # | Entrada | La lección (*"aplicar en"*) |
|---|---|---|
| 1 | **W0.1** · el Story File dice `a58ab2b`, el HEAD real es `091db28`; el único delta es **el propio Story File commiteándose encima** | Todo Story File/SDD debe decir *"árbol de código **medido**"*, no *"HEAD"*. **El HEAD cambia por el acto mismo de guardar el documento.** Segunda vez consecutiva |
| 2 | **W1.A** · la escalera literal daba `CONFIG(3)` donde correspondía `UNRESOLVED(6)` e `INALCANZABLE(2)` | Toda escalera con una fila de *"no medí nada"*: esa fila es la **última** explicación, no la primera. **Una fila de anti-vacuidad puesta arriba le roba la causa a las de abajo** |
| 3 | **W1.B** · `AgentRow` **no** se amplió: `OwnedAgentRow` | Cuando una HU pide ampliar un tipo que un guard anterior protege, preguntar **cuál era el MOTIVO del guard**, no sólo qué prohibía. Acá el motivo era *"alimenta mappers públicos"*, y existía una forma de darle el dato al mapper que **no** es público |
| 4 | **W1.B** · un campo **requerido** nuevo rompió 4 fixtures fuera del Scope IN (`TS2345`) | Agregar un campo **requerido** a un tipo exportado es un cambio de **blast radius**, no una línea. El Scope IN tiene que incluir a los **constructores** del tipo, no sólo a su definición |
| 5 | **W3.3** · CD-13 estaba incompleto: mover sólo `line:` deja el guardián **VERDE con la prosa PODRIDA** | *"Arreglar una cita"* son **dos** ediciones, no una. Y un guardián verde después de mover código **no** prueba que las citas digan la verdad: prueba que **el registro concuerda consigo mismo** |
| 6 | **W1.B5** · `tsc` y las suites verdes, y `npm run lint` **exit 1** | El orden es `tsc → lint → test`, y **el formateo mueve líneas**. Cualquier arreglo de citas por desplazamiento va **después** de que el formateador dijo la última palabra |
| 7 | **W3.1** · AC-10: los tres mutantes con su rojo **literal** y su motivo | El rojo se lee **por su motivo**: `expected 4 to be +0` = deriva **fabricada** (5 de 5 agentes acusados todos los días); `expected true to be false` = una billetera de **espacios** declarada válida; `expected +0 to be 5` = **la fila rota declarada sana** |
| 8 | **`TD-370-CITAS-FUERA-DEL-CORTE`** · 3 sitios fuera de `CORTE_A_PATHS`; **provenance corregida en la it. 1** | **Imputarle a este trabajo un daño preexistente apaga la búsqueda de la causa real.** Las tres ya estaban podridas en `091db28`, reproducido con `git show`; esta HU las **desplazó más**, no las rompió |
| 9 | **Las otras dos TD y dónde viven** · `OUTPUTSCHEMA-SIN-FUENTE` en el docblock del script, `KEY-SOLO-LECTURA` en el del workflow | La deuda vive **en el sitio**, no en un backlog aparte donde nadie la lee |
| 10 | **W4.2** · las dos suites verdes, `tsc` verde, `lint` verde… y `npm test` completo: **7 archivos / 28 casos rojos**, ninguno escrito por el Dev | **Correr las PARTES de un gate no es correr el gate.** Y el bug era real: un `cast` derrota al tipo, así que el docblock que decía *"impide que un lector angosto alimente este mapper"* era **prosa que afirma de más, escrita en la HU que existe para sacar eso**. Además: antes de presupuestar una inserción en un archivo grande de `src/`, buscar **TODOS** los registros que lo referencian por línea |
| 11 | **W3.3 (segunda pasada)** · citas verdes a media tarde, rojas en el gate final | El arreglo de citas por desplazamiento es **lo último que se toca**. Hacerlo antes es garantizar hacerlo dos veces — **y la segunda es la que se olvida**. ⚠️ Renombrar `872→886` cuando ya existe una entrada `886` **colisiona**: hay que renombrar **de mayor a menor** |

### Fix-pack · iteración 1 (AR + CR RECHAZADO)

| # | Entrada | La lección |
|---|---|---|
| 12 | **BLQ-1** · las dos ramas `sin-dato` se probaban **salteándose la función que produce el dato** ⇒ 3 mutantes con la suite 35/35 verde | Cuando una función **produce** un estado y otra lo **clasifica**, un test que le pasa el estado a mano **no prueba la primera**. Al menos uno tiene que entrar por el **punto de entrada real**. Y **el contador que un control positivo lee es parte del contrato**: se afirma su valor exacto, no `> 0` |
| 13 | **BLQ-2 / MNR-2** · cuarta pasada de citas, y esta vez las de **PROSA que ningún guardián mira**. Los valores viejos eran **correctos** en `091db28`; el desplazamiento real era **+78** y se les aplicó **+64**, el delta de la *primera* pasada | Una cita de línea **nunca** se actualiza sumándole el delta de otra pasada. **Sumar un delta es adivinar; abrir la línea es medir.** Y cuando una corrección **no tiene rojo posible**, lo que se reporta no es *"verificado"*: es **la medición de que nadie lo mira** |
| 14 | **BLQ-3** · ausente y revocada, **el mismo hecho por dos códigos distintos**; el segundo entró por el camino del error de transporte *porque llegó como un status HTTP* | **La forma del error se comió su significado.** Antes de mandar un status al cajón de *"el otro no contestó"*, preguntar **quién falló**: un `4xx` de autenticación acusa a **mi credencial**; un `5xx` acusa al otro lado |
| 15 | **BLQ-4** · el principio *"si coexisten manda la que cuesta dinero"* estaba **escrito** en la fila 10 y aplicado entre 10 y 11, pero **no** a 8/9 | Cuando un docblock enuncia un principio de precedencia, **buscar todas las parejas donde aplica**, no sólo la que motivó escribirlo. **Un principio aplicado en un solo lugar es una excepción disfrazada de regla** |
| 16 | **BLQ-5** · el párrafo hablaba de **tres** columnas como bloque y la corrección **heredó el sujeto plural sin re-verificarlo** | Cuando se corrige una afirmación sobre **N** cosas, se re-verifica **una por una**. Y un test de prosa que sólo busca `toContain` de la frase **nueva** no prueba nada sobre la frase **vieja que quedó al lado**: hay que anclar el test al **hecho derivado del fuente** |
| 17 | **MNR** · los cuatro arreglados y el diferido; ⚠️ **`T-S4` clavaba el cuerpo duplicado** de los npm scripts | **El verde de hoy no validaba los scripts: los congelaba.** Un test que fija un valor equivocado convierte el defecto en contrato |
| 18 | **`TD-370-EXCEPTIONS-SIN-GUARDIAN`** · declarada, **medida**, NO cerrada | El archivo que justifica **por qué una query NO lleva filtro de ownership** —el que `CLAUDE.md` manda auditar— **no tiene guardián sobre sus citas**. Medido con dos citas a líneas inexistentes: **la suite completa sale verde** |
| 19 | **CUARTA pasada de citas** · las rompió **el propio arreglo de PROSA** del Dev: un párrafo de 6 → 9 renglones, y `G-08` en rojo diciendo *"cadena sin motivo escrito"* | **Un comentario de 9 líneas donde había 6 mueve tanto como un `if`.** Los barridos miran **lo que escribiste, no lo que desplazaste**. Y un rojo que *"suena a agujero de seguridad nuevo"* puede ser un número de línea viejo: **leer el código antes de creerle al mensaje** |

### Fix-pack · iteración 2 (re-AR APROBADO)

| # | Entrada | La lección |
|---|---|---|
| 20 | **MNR2-1** · quitar `\|\| schema === null` dejaba la suite en **36 passed**; **ausente y borrado se leían como un solo caso** y sólo el primero tenía fixture | Cuando una guarda enumera **dos** formas de *"no hay dato"* (`undefined` y `null`), hacen falta **dos** fixtures. Y antes de archivar un mutante como *"equivalente"*, **buscá el verbo de la API que produce ese valor**: acá la diferencia entre defensivo y explotable era **un `PATCH` con un `null` en el body** |
| 21 | **Los otros cuatro menores** · por qué NO se tocaron | Escribirle un test a un mutante **equivalente** es **fabricar cobertura sobre input inconstruible**. Y `MNR2-4` se difiere **a DONE, al final**, por la lección 11: el arreglo de citas es lo último que se toca |
| 22 | **Los dos gates del fix-pack** · corridos completos, en orden, **con el árbol staged** | `git add -A` **antes** del gate: `readme-numbers` enumera con `git ls-files`, **contra el índice**. Con el entregable untracked **da verde en falso** — le pasó a WKH-369 el día anterior |

### DONE — entradas nuevas de esta fase

| # | Entrada | La lección |
|---|---|---|
| 23 | **Las 5 citas del índice, re-derivadas abriendo cada línea** (§14). Se hizo **al final**, después de escribir este reporte, para no moverlas otra vez | Es la lección 11 aplicada a la fase de cierre. `nexus-docs` **también** desplaza líneas |
| 24 | 🔴 **La quinta cita no era un número: era una frase que esta HU volvió FALSA** | **Renumerar sin tocar la frase deja una cita que apunta bien y afirma mal — que es peor que una rota: una rota se ve, ésta no.** Un barrido de citas que sólo re-deriva números **no puede cazar esta clase** |

---

## 14 · La fila del índice — las 5 citas re-derivadas, y la frase reescrita

⚠️ **Estaban publicadas, no pendientes.** El F1 corrió sin herramienta `Edit`, dejó la fila en
`_INDEX-row.md`, y esa fila **ya estaba pegada** en `doc/sdd/_INDEX.md:223` desde antes de que la
rama existiera. Las 5 citas se escribieron contra el árbol **pre-implementación**, y esta HU
desplazó `src/services/agent.ts` **cuatro veces**. **No estaban en `origin/main`** (que sigue en
`b89f394`), así que se corrigen **antes** de publicarse.

⛔ **Re-derivadas abriendo cada línea del árbol de `c0eb5be`, nunca sumando el delta** — que es el
defecto exacto que produjo el `BLQ-2` de esta misma HU.

| # | Podrida | Qué hay HOY en esa línea | **Corregida a** | Verificación |
|---|---|---|---|---|
| 1 | `agent.ts:713` | `throw new OwnershipMismatchError();` | **`agent.ts:795`** | `updateRow.payout_wallet = updates.payoutWallet;`, guarda `if (updates.payoutWallet !== undefined)` en `:794` |
| 2 | `agent.ts:735-736` | `}` + línea en blanco | **`agent.ts:817-818`** | `if (updates.inputSchema !== undefined)` / `meta.inputSchema = updates.inputSchema;` |
| 3 | `agent.ts:165` | `return {};` | **`agent.ts:222`** | el `metadata,` dentro de `mapRowToAgent`, que arranca en `:195` |
| 4 | `agent.ts:190` | docblock sobre `payment` | **`agent.ts:260`** | `if (inputSchema !== undefined) record.inputSchema = inputSchema;` |
| 5 | `agent.ts:174-198` | `readMetadataObject` + el arranque de otro bloque | **`agent.ts:231-268`** 🔴 **+ frase reescrita** | `function mapRowToRecord(row: OwnedAgentRow)` en `:231`, cierre `}` en `:268` |

### 🔴 La #5: renumerar no alcanzaba

La fila afirmaba que `payout_wallet` *"no está en `mapRowToRecord`"*. **Esta HU lo volvió falso**:
`mapRowToRecord` (`:231-268`) recibe un `OwnedAgentRow` y **LEE** la columna en `:256-257` para
derivar `hasPayoutWallet`. Lo que sigue cierto —y es lo que la regla protege— es que **el VALOR no
sale a ningún shape**.

La fila ahora dice:

> *"…no está en el `AgentRow` interno (`agent.ts:54-65`); **tras WKH-370 `mapRowToRecord`
> (`:231-268`) lee la columna para derivar el booleano `hasPayoutWallet`, y el VALOR sigue sin
> salir a ningún shape**…"*

### Las 7 válidas — abiertas por mí en esta fase, **no se tocaron**

| Cita | Lo que hay en la línea |
|---|---|
| `agent-split-context.ts:50-52` | el ternario `row?.payoutWallet ? {…} : null` ✅ |
| `agent-split-context.ts:13-14` | *"CD-5: self-published lee `payout_wallet`/`owner_ref` SOLO vía `getSplitContextRow`…"* ✅ |
| `agent.ts:54-65` | `interface AgentRow`, **10 campos, sin `payout_wallet`** — la afirmación sigue siendo verdadera ✅ |
| `probe-money-path.yml:100` | `A2A_PROBE_KEY: ${{ secrets.A2A_PROBE_KEY }}` ✅ |
| `probe-money-path.yml:116` y `:165` | el **mismo** `TITULO:` en las dos ✅ |
| `ci.yml:4-6` | *"Runs WITHOUT secrets or a live database"* ✅ |
| `smoke-downstream.yml:52` y `:94` | *"Abrir issue si la corrida por reloj falla"* … el `fi` que cierra el paso ✅ |

⛔ **No se tocó nada por encima de la línea 144 de `_INDEX.md`** — `src/lib/capability-risk.ts` y
`src/lib/capability-risk.test.ts` la citan, y `CITED_INDEX_LINES` en
`test/sdd-index-matches-folders.exceptions.ts:181-192` lo verifica. La edición es **in-place sobre
la línea 223**, sin agregar ni quitar líneas.

### `_INDEX-row.md` — borrado

Su propia instrucción 3 decía *"borrar este archivo cuando la fila esté puesta"*. La fila está
puesta y corregida ⇒ **borrado**. Verificado en esta fase que **ningún código lo referencia** y que
`test/sdd-index-matches-folders.test.ts` (que deriva las carpetas de `git ls-files doc/sdd`) sigue
verde tras el borrado — el gate del §16 corrió **después**, con el árbol staged.

---

## 15 · Decisiones diferidas a backlog

⚠️ **Ningún ticket se creó en esta fase** (no lancé `gh`). Lo que sigue son **candidatos con su
motivo escrito**, para que el humano decida si abre issue:

| Candidato | Origen | Por qué no entró |
|---|---|---|
| **Meter `ownership-filter-guard.exceptions.ts` en `CORTE_A_PATHS`** | `TD-370-EXCEPTIONS-SIN-GUARDIAN` | Obliga a declarar **todas** sus citas de una vez y mueve los invariantes de conteo del guardián ⇒ **HU propia**, no un renglón de un fix-pack |
| **`MNR2-5`** — una cita cuyo `mustContain` **no sostiene la frase que decora** | AR-2 | **Pre-existente**, fuera de Scope IN |
| **`MNR-CR-5`** — `GET /agents` fuera de la tabla de `doc/INTEGRATION.md` | CR | Hueco **pre-existente**; `hasPayoutWallet` nace sin sitio canónico |
| **`TD-370-RLS-SET-INCOMPLETO`** — `a2a_agents` tiene `owner_ref` y no está en `RLS_TABLES` | SDD DT-3 | Discrepancia entre el criterio de `CLAUDE.md` y la lista de `verify-rls-enabled.mjs`. Vecino de **WKH-SEC-02** |
| **Una agent key de sólo lectura** (o RLS + vista sobre `a2a_agents`) | `TD-370-KEY-SOLO-LECTURA` | Hoy **cualquier** key que lea `listMine` puede **borrar** esas filas. Es DDL de producción |
| **El camino de escritura que permite nacer incompleto** | `sdd.md` DT-3 | Esta HU es **el vigilante**, no la corrección. `POST /agents` sin `payoutWallet` **sigue sin quejarse** |
| **Completar las 2 filas sin `outputSchema`** | `sdd.md` R-1 | *"Corregir filas"* es **Scope OUT** explícito |

⚠️ **Una predicción del SDD que envejeció, y conviene dejarla dicha**: `sdd.md` R-1 anunciaba que
*"el chequeo NACE EN ROJO"* porque 2 filas no tienen `outputSchema`. **No pasó**: la decisión D-1
del Story File sacó `outputSchema` de la escalera con medición (0/5 manifiestos lo publican) y lo
dejó **contado en la línea** (`outputSchemaPresente=3/5`). La corrida real dio **`CONFORME(0)`**.
La deuda quedó **visible en vez de roja**, que era el objetivo de no entrenar a la gente a ignorar
el control.

---

## 16 · El gate del repo — corrido por mí en esta fase, después de la última edición

⛔ `npm run qa` **no existe en este repo**. El gate es la secuencia de `.github/workflows/ci.yml`.
⚠️ Corrido **después** de todas mis ediciones de documentos y **con `git add -A` antes**, porque
`test/readme-numbers.test.ts:83` enumera con `git ls-files` —contra el **índice**— y hay tests que
leen documentos (`docs-referenced-by-code-exist`, `cited-lines-guard`).

```
=== git status --porcelain (con el árbol ya staged) ===
D  doc/sdd/231-wkh-370-catalogo-vs-agentes-vivos/_INDEX-row.md
A  doc/sdd/231-wkh-370-catalogo-vs-agentes-vivos/done-report.md
M  doc/sdd/231-wkh-370-catalogo-vs-agentes-vivos/work-item.md
M  doc/sdd/_INDEX.md

=== 1) npx tsc -p tsconfig.json --noEmit ===
TypeScript compilation completed                            TSC_EXIT=0

=== 2) npm run lint ===
> biome check src/
Checked 520 files in 264ms. No fixes applied.               LINT_EXIT=0

=== 3) npm test ===
 Test Files  314 passed | 6 skipped (320)
      Tests  6350 passed | 19 skipped (6369)
   Duration  20.20s                                         TEST_EXIT=0
```

| Número | Base `091db28` | Esperado (F4) | **Medido por mí en DONE** | |
|---|---|---|---|---|
| Biome | 519 | 520 | **520** | ✅ |
| Archivos de test | 312/318 | 314/320 | **314 passed / 6 skipped (320)** | ✅ |
| Casos | 6310/6329 | 6350/6369 | **6350 passed / 19 skipped (6369)** | ✅ |

⚠️ **Los 4 archivos del `git status` de arriba son los únicos que esta fase tocó**, y los cuatro son
documentos: **ni `src/`, ni `scripts/`, ni `test/`** — por eso los tres números son idénticos a los
de F4, y eso es la comprobación, no una coincidencia.

⚠️ **Sobre este propio transcript**: escribirlo modifica `done-report.md` **después** de la corrida
que transcribe. Para que no quede un gate corrido sobre un árbol distinto del que se entrega, el
gate se volvió a correr **con este bloque ya escrito y `git add -A` hecho**, y dio **exactamente lo
mismo**: `tsc 0` · `lint 520` · `314/320` archivos · `6350/6369` casos · exit 0. Es esperable —
ningún test del repo lee este archivo— pero **esperable no es medido**, y la diferencia entre las
dos cosas es la mitad de las lecciones de esta HU.

---

## 17 · Smoke post-deploy — para el operador, DESPUÉS del merge

Lo único que **no se puede ejecutar antes del merge** es la corrida **programada** (GitHub no
evalúa `schedule:` fuera de la rama por defecto).

```
1. Merge a main. Confirmar que .github/workflows/check-catalog-vs-live.yml está en main.
2. Actions → "check-catalog-vs-live" → Run workflow (workflow_dispatch).
   Esperado: job `deriva` VERDE (exit 0) · job `completitud` con exit 3 (CONFIG) mientras
   A2A_CATALOG_OWNER_KEY no esté cargado — y NINGÚN issue abierto, porque los pasos de
   aviso son `if: … github.event_name == 'schedule'`.
3. Esperar el cron ('23 6 * * *') o forzar un fallo transitorio, y verificar:
   a. se abre UN issue con el título 'check-catalog deriva: el catalogo se separo de los
      agentes vivos' (o el de completitud), y NINGUNO de los otros dos títulos del repo
      (probe-money-path / smoke-downstream) queda tocado;
   b. en la siguiente corrida verde el MISMO issue se CIERRA solo.
4. Cargar el secreto A2A_CATALOG_OWNER_KEY (MI-8) y confirmar que el job `completitud`
   pasa de exit 3 a exit 0 sobre los 5 self-published.
   ⚠️ Si sale 401/403 la clase sigue siendo CONFIG(3) y el mensaje dice "hay que rotarla":
   eso NO es una caída de producción.
```

---

## 18 · Las tres lecciones que más valen para la próxima HU

1. **Sumar un delta es adivinar; abrir la línea es medir — y arreglar citas es lo ÚLTIMO que se
   toca.** Esta HU desplazó `agent.ts` **cuatro veces** y **tres pasadas de citas quedaron viejas
   por la edición siguiente**. Peor: la cuarta la rompió **un arreglo de PROSA**, porque un párrafo
   de 6 → 9 renglones no *se siente* una inserción. **Los barridos miran lo que escribiste, no lo
   que desplazaste.** Corolario operativo: renombrar entradas **de mayor a menor** para no
   colisionar, y correr el arreglo **después** del formateador.

2. **Un test que le pasa el estado a mano no prueba a quien lo produce — y un verde sin rojo posible
   no es una verificación, es un silencio.** Tres mutantes sobrevivieron con la suite **35/35
   verde**, uno de ellos con un **falso verde end-to-end**, porque las ramas `sin-dato` sólo se
   ejercitaban **salteándose la función que produce el dato**. Y la contracara: cuando el AR-2 midió
   que **ningún guardián mira `exceptions.ts`**, lo que hizo válida la conclusión fue el **control
   positivo** —podrir un campo que **sí** tiene guardián y verlo rojo—. Sin ese contraste, el verde
   podía ser un instrumento apagado.

3. **Que un AC afirme de más es el hallazgo, no la errata — y una cita que apunta bien y afirma mal
   es peor que una rota.** El texto de AC-4 quedó **más fuerte que la implementación**, y lo
   descubrió el mismo barrido de 8.748 combinaciones que probó su cumplimiento. En la misma familia:
   la quinta cita del índice se podía renumerar y **seguir mintiendo**, porque esta HU volvió falsa
   la frase que decoraba. **Un barrido que sólo re-deriva números no puede cazar esa clase**: hay
   que preguntarle a cada cita *qué afirma*, no sólo *adónde apunta*.
