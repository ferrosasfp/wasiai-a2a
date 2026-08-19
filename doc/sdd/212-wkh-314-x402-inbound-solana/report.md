# Report — HU 212 · [WKH-314] x402 inbound en Solana

**Cierre**: 2026-08-19 · **Modo**: QUALITY · **Veredicto F4**: APROBADO (9/9 ACs) · **Status**: DONE
**HEAD del trabajo**: `cc332f8` · **Base declarada**: `main@75de7eb`

---

## ⚠️ Lo primero, porque el encargo decía lo contrario: `main` YA fue fast-forwardeada y PUSHEADA

El encargo de esta fase decía *"Sin pushear, sin mergear. El merge es decisión del founder"*. **Medido
hoy, eso ya no describe el repo.** No lo hizo esta fase (no ejecutó ningún comando de escritura de git
antes de medirlo); queda escrito porque un reporte de cierre que repita la premisa vieja hace que el
próximo que lo lea decida mal.

| Instrumento | Salida |
|---|---|
| `/usr/bin/git symbolic-ref -q HEAD` | `refs/heads/main` (**no** la rama de la HU) |
| `/usr/bin/git rev-parse main` y `HEAD` | los dos `cc332f81c5d909f4bdfd21609e2b0d9941a0a091` |
| `/usr/bin/git rev-list --count main..HEAD` | `0` |
| `/usr/bin/git rev-list --count 75de7eb..main` | `8` |
| `/usr/bin/git reflog show main --date=iso` | `cc332f8 main@{2026-08-19 11:57:55 -0600}: merge cc332f8: Fast-forward` |
| `/usr/bin/git reflog --date=iso` | `75de7eb HEAD@{2026-08-19 11:57:55 -0600}: checkout: moving from feat/212-wkh-314-x402-inbound-solana-f3 to main` |
| **`/usr/bin/git ls-remote origin refs/heads/main`** (consulta de red) | **`cc332f8` — está en GitHub** |
| Control positivo del mismo instrumento | `ls-remote origin refs/heads/feat/212-…-f3` ⇒ **vacío**: la rama de la HU nunca se pusheó; lo que viajó fue el fast-forward de `main` |
| `origin` | `https://github.com/ferrosasfp/wasiai-a2a.git` (repo **público**) |

**Qué significa exactamente**: los 8 commits de la HU están en `main` local **y** en `origin/main`. Un
fast-forward, no un merge commit, a las 11:57:55 de hoy — 4 minutos después del último commit de la HU y
**durante** esta fase de cierre. **De quién fue no es atribuible desde el reflog** (todos los commits del
repo tienen el mismo autor). Lo que sí es atribuible: no salió de este agente.

**Qué NO cambia**: el árbol de `cc332f8` es el mismo se mire desde donde se mire (fue fast-forward), así
que todas las mediciones de abajo valen para el código que hoy está en `main` y en GitHub.

**Qué SÍ cambia, y es lo que hay que mirar**: lo que antes era *"código apagado sin mergear"* ahora es
**código apagado en `main` y publicado**. Las tres cosas de la sección "Pre-requisitos para ENCENDER"
dejan de ser condiciones de un merge futuro y pasan a ser condiciones de una **variable de entorno**.

---

## Resumen ejecutivo

El gateway ya puede **cobrar** en Solana devnet por x402: la Pared A cayó. `acceptsInboundPayment` dejó
de ser `vmFamily === 'evm'` a secas y pasa por `isSolanaX402InboundConfigured()`
(`src/adapters/solana/chain.ts:242-247`), **una sola definición** que consumen el guard del middleware y
`GET /capabilities`. Entrega: challenge 402 con `reference` + `nonce` firmados por HMAC, verificación de
la transferencia USDC-SPL contra dos proveedores RPC, uso único durable en
`public.a2a_solana_inbound_proofs` vía 3 funciones `SECURITY DEFINER`, y un preflight que falla cerrado.

**El código nace apagado y eso está verificado en los dos lados**: `.env.example:1349`
(`SOLANA_X402_INBOUND_ENABLED=false`) y el gateway vivo, re-consultado hoy en esta fase
(`GET /capabilities` ⇒ HTTP 200, 51.414 bytes, `solana-devnet → acceptsInboundPayment: false`, con
control positivo en las tres chains EVM que dan `true`).

Camino recorrido: **AR RECHAZADO → fix-pack 1 → CR RECHAZADO → fix-pack 2 → F4 APROBADO → 4ª pasada de
docs**. Los dos hallazgos más caros fueron agujeros de **plata** que el F3 no vio pese a entregar 20/20
mutantes muertos.

---

## Pipeline ejecutado

| Fase | Artefacto | Resultado |
|---|---|---|
| F0/F1 | `work-item.md` | 9 ACs EARS · gate `HU_APPROVED` |
| F2 | `sdd.md` | 8 CDs + DTs · gate `SPEC_APPROVED` |
| F2.5 | `story-file.md` | waves + `CD-A1`..`CD-A4` |
| F3 | `e8abe36` | implementación · 20/20 mutantes declarados muertos |
| **AR** | `adversarial-review.md` | **RECHAZADO** — 2 `BLQ-ALTO`, 3 `BLQ-MED`, 1 `BLQ-BAJO`, 3 `MNR` |
| fix-pack 1 | `882028e` | los 6 hallazgos del AR |
| **CR** | `code-review.md` | **RECHAZADO** — 3 `BLQ-BAJO`, 7 `MNR`. *Ninguno de los 6 del AR volvió*; lo que bloqueó fue deuda **nueva** del propio fix-pack |
| fix-pack 2 | `f81c086`, `3e8ab83` | los 3 `BLQ-BAJO` + los MENORes |
| **F4** | `f4-report.md` | **APROBADO** — 9/9 ACs con `archivo:línea` y test por nombre |
| 4ª pasada | `9b36e0e`, `a535140`, `c05b88b`, `cc332f8` | el mensaje público de la API + `README.md:35` / `README.es.md:35` / `doc/INTEGRATION.md:7` |

**8 commits, 0 wave drift.** Orden: F3 → fix-pack AR → fix-pack CR → docs.

---

## Gates re-derivados en HEAD `cc332f8` (no copiados de otro reporte)

| Gate | Comando | Resultado |
|---|---|---|
| Tipos | `npx tsc --noEmit` | **exit 0** |
| Lint | `npm run lint` (`biome check src/`) | **exit 0** — *Checked 501 files* |
| Suite completa + cobertura | `npm run test:coverage` | **exit 0** — Test Files `297 passed / 6 skipped (303)` · Tests **`5924 passed / 19 skipped (5943)`** |
| Suite propia de la HU (8 archivos) | `npx vitest run` sobre los 8 archivos de la HU | **169 passed / 0 failed** |
| Guardián del índice | `npx vitest run test/sdd-index-matches-folders.test.ts` | **12 passed / 0 failed** (antes y después de editar el índice) |

**Cobertura, salida literal del reporter:**

```
Statements   : 88.02% ( 12979/14745 )
Branches     : 80.6%  ( 8983/11144 )
Functions    : 92.69% ( 1801/1943 )
Lines        : 89.54% ( 12135/13552 )
```

Piso del CI (`vitest.config.ts`): **80 / 70 / 80 / 80**. Pasa con margen en las cuatro.

**Números que NO coincidieron con lo que traía el encargo. Gana el comando:**

1. **Branches: el reporter imprime `80.6`, no `80,61`.** No es un desacuerdo real: `8983/11144 =
   0,806092…`, o sea 80,61 % redondeado a dos decimales, y el reporter recorta el trailing. **Lo que se
   publica en un gate es lo que imprime el instrumento**: `80.6`. Queda con las dos formas para que
   nadie tenga que re-derivarlo.
2. **La suite propia de la HU son 169, no 160.** El F4 midió **160 en 7 archivos**; el 8º archivo de la
   HU es `src/middleware/x402.non-evm-inbound.test.ts` (9 tests, el que la 4ª pasada reescribió).
   160 + 9 = 169. No hay contradicción: el F4 midió antes de esa reescritura y sobre un universo de 7.
3. **`git status --porcelain` da 0 líneas y ES cierto** — pero sólo porque los tres archivos que el
   snapshot inicial listaba como untracked (`via-proxy.json`, `via-proxy.err`,
   `contracts/.gas-snapshot`) hoy están **ignorados** (`.gitignore:23`, `:25`). Control positivo del
   cero: los tres existen en disco, y `git ls-files -o` (sin `--exclude-standard`) devuelve **38.223**
   entradas ⇒ el instrumento sí produce salida cuando hay algo que producir. Sin ese control, el `0` del
   `f4-report.md` §1 sería indistinguible de un cero falso.

---

## Acceptance Criteria — resultado final

Los 9 salen del `f4-report.md` §2, con test por nombre. Lo re-derivado en esta fase es **AC-7** y el
runtime de **AC-8**.

| AC | Status | Evidencia |
|----|--------|-----------|
| **AC-1** challenge con red, mint, monto atómico, `payTo`, referencia única y expiración | ✅ PASS | `src/lib/solana-x402-challenge.ts` · emisión en `x402.ts` · `T-CHAL-01`, `T-CHAL-02b`, `T-CHAL-02c` (200 emisiones ⇒ 200 nonces), `T-CHALX-01` |
| **AC-2** registro durable **antes** de conceder | ✅ PASS | `recordInboundObserved` · `src/services/solana-inbound-proof.ts` · `T-GRANT-01/02/03`, `T-STORE-00` |
| **AC-3** replay con código propio, sin depender del primer intento | ✅ PASS | `X402_SOLANA_PROOF_REPLAY` · `T-REPLAY-01/04/05`, `T-STORE-04/05/11` |
| **AC-4** monto corto ⇒ código distinguible **sin consumir** | ✅ PASS | `T-SHORT-01`, `T-NOCONS-01` (los **ocho** motivos dejan la firma gastable) |
| **AC-5** destino/mint distinto ⇒ deniega sin consumir ni reembolsar | ✅ PASS | `T-TERMS-01/02/03`, `T-TERMS-05` (MAC forjado ⇒ **cero** llamadas al RPC, contadas), `T-BIND-09` |
| **AC-6** `unknown` nunca se degrada a `absent`; canal EVM compartido (DT-14) | ✅ PASS | `T-UNK-01/02/03b/05/07/07b` |
| **AC-7** camino EVM **byte-idéntico** | ✅ PASS | **re-derivado hoy**: `/usr/bin/git diff 75de7eb...cc332f8 -- src/adapters/{avalanche,base,kite-ozone,tempo,inbound,escrow}/` ⇒ 0 bytes. ⚠️ Ver la nota de instrumento de abajo: el control positivo salvó esta medición |
| **AC-8** `/capabilities` publica `true` **sii** cableado y habilitado | ✅ PASS | **una sola expresión** (`isSolanaX402InboundConfigured`, `chain.ts:242-247`) consumida por `capabilities` y por el guard del middleware · `T-CAP-01/02/03` · **runtime re-consultado hoy**: gateway vivo ⇒ `solana-devnet: false`; control positivo `kite-ozone-testnet` / `avalanche-fuji` / `base-sepolia` ⇒ `true` |
| **AC-9** cero claves privadas Solana en el inbound | ✅ PASS | grep de `Keypair` / `sendRawTransaction` / `PRIVATE_KEY` sobre los 5 módulos ⇒ **0**; control positivo `payment.ts` ⇒ **4** · `T-KEY-01` |

> ⚠️ **Nota de instrumento sobre AC-7, y vale para cualquiera que la reproduzca.** La primera corrida de
> esa medición dio **0 bytes también para `src/adapters/solana/`**, que es el control positivo y tenía
> que dar un número grande. No era un hallazgo: `main` ya apunta a `cc332f8`, así que `main...HEAD`
> compara el commit **contra sí mismo** y todo da 0. El cero era del instrumento, no del repo.
> Reproducirla exige el rango explícito `75de7eb...cc332f8`. **El control positivo fue lo único que
> distinguió "no hay diferencias" de "la pregunta estaba mal hecha".**

---

## Los dos agujeros de plata que encontró el AR y el F3 no vio

Van con el detalle completo porque son el contenido de la HU, no un anexo.

### 1 · El monto del sobre nunca se comparaba contra el precio de ESTE request

`resolveSolanaPaymentRequirements` resolvía `requiredAmount` una vez y lo usaba **sólo** para construir
el challenge; después de validar el MAC, todo el camino usaba `presented.amountAtomic`, o sea el monto
que venía **en el sobre del cliente**. No existía en la rama Solana el equivalente del guard EVM
`BigInt(auth.value) < BigInt(requiredAmount)`.

**Consecuencia**: pagar **0,000001 USDC** (1 unidad atómica) por un pipeline de **50 USDC**, dentro de
la ventana de 900 s del challenge, **repetible a voluntad**, y sin reembolso inbound en el camino x402.
El MAC probaba *"este sobre lo emitimos nosotros"*, nunca *"éste es el precio de ahora"* — y el precio
del mismo `resource` varía por request porque se calcula sobre el body.

**Rompía el contrato del propio Story File** (`story-file.md:544`): *"El monto sale de UNA sola
resolución reusada por el challenge y por el binding (CD-11)"*. Había dos expresiones y divergían.

**Qué lo acota hoy**: el guard de monto (`>=` contra el `requiredAmount` resuelto) más los guards de
`payTo` y `mint`, corriendo **antes** de tocar la cadena. Candados: `T-PRICE-01` (mata el mutante
`|| true`) y `T-PRICE-04` (mata `if (false)`), más los gemelos positivos `T-PRICE-02/03`.
**Qué queda afuera**: el residuo que el CR nombró como `MNR-3` — si el precio **sube** entre el 402 y la
presentación por un motivo honesto, la transferencia ya en cadena con la referencia vieja **queda varada
para siempre** (402 nuevo ⇒ `nonce` nuevo ⇒ referencia nueva ⇒ `reference_absent`). Eso no está
resuelto: está declarado.

### 2 · Dos callers en el mismo segundo obtenían la MISMA referencia

El material del MAC era `resource|payTo|amount|mint|network|issuedAt|expiresAt`: **nada por caller, nada
por pedido**, y `issuedAt` con granularidad de 1 segundo. Los 5 campos que compara el store de uso único
(`reference`, `resource`, `pay_to`, `amount_atomic`, `mint`) salían **byte-idénticos** entre dos callers
distintos — medido, con las dos referencias impresas iguales.

**Consecuencia**: el atacante sostiene un sobre válido por segundo contra un endpoint de precio estable,
mira `getSignaturesForAddress(reference)` —la firma de la víctima es pública desde que aterriza— y la
presenta con **su propio** sobre. Se lleva el servicio. La víctima, **que transfirió USDC de verdad y de
forma irreversible**, recibe `X402_SOLANA_PROOF_REPLAY`: *"tu firma ya se usó para obtener servicio"*.

El F3 había declarado este caso como **inocuo** en un test verde (`T-CHAL-02b`) con siete líneas de
comentario explicando por qué. La razón escrita era cierta a medias (*"el uso único vive en la firma"*)
y nunca se corrió el escenario del atacante.

**Qué lo acota hoy**: entropía por emisión (`nonce`, CSPRNG) dentro del material del MAC, eco-repetida
por el pagador en `extra`. Candados: `T-CHAL-02b` invertido y con la precondición **medida** antes de
asertar, `T-CHAL-02c` (200 emisiones, 200 nonces, ninguno derivable del timestamp), `T-STEAL-01/02/03`.
Mueren dos mutantes distintos: sacar el `nonce` del MAC, y reemplazar el CSPRNG por un `Buffer.alloc`.
**Qué queda afuera**: el AR dice, con esas palabras, que **no midió** la carrera real contra el reloj de
devnet ni si un rate-limit de producción impide sostener un 402 por segundo. El agujero está cerrado por
construcción del MAC; la ventana de explotación previa nunca se cuantificó.

---

## 🔴 Lección 1 — Ningún mutante puede introducir un test que no existe

El F3 entregó **20/20 mutantes muertos** con instrumentación impecable, y **los dos agujeros de arriba
pasaron igual**. Textual del AR:

> *"Ningún mutante puede introducir un test que no existe."*

La causa, medida: los **29 `it()`** de `x402.solana-inbound.test.ts` armaban el sobre **siempre** con
`envelope(c, sig)` donde `c = await getChallenge(app)` — el challenge del **mismo request**. Control
positivo del AR: `grep "amountAtomic: '"` da **un** hit, y es un fixture de `peek`.

**Mutar código no encuentra un agujero que vive en una CLASE DE INPUT que ningún test construye.** Un
score de mutación mide la robustez de lo que la suite **ya ejercita**, y no dice absolutamente nada de
lo que no. Acá las dos clases ausentes se nombraban en una línea cada una: *un sobre emitido a otro
precio* y *dos callers compartiendo referencia*. El score no las podía nombrar porque el score no sabe
qué **no** existe.

**Regla operativa que queda**: antes de reportar un score de mutación, **listar qué inputs no aparecen
en ningún fixture de la suite**. Ese listado, y no el score, es lo que dice cuánto vale el verde.

El fix se hizo bien: los dos tests se escribieron **antes** del arreglo y se midió que iban rojos
(`T-PRICE-01`: `expected 200 to be 402`; `T-STEAL-01`: dos referencias idénticas literales;
`T-STEAL-02`: `expected 200 to be 402` con la firma de la víctima).

---

## 🔴 Lección 2 — Verificar los SITIOS arreglados no es verificar el CLAIM

La misma frase falsa —*"el adaptador de Solana no implementa el inbound"*— **sobrevivió tres pasadas**:

| Pasada | Qué hizo | Qué concluyó |
|---|---|---|
| **CR** (`MNR-2`) | La marcó y **enumeró 6 sitios** en los dos README | "hay que condicionar estas 6 frases" |
| **fix-pack 2** | Condicionó **los 6**, con el condicional DENTRO de la afirmación | "hecho" |
| **F4** (§6.1) | Verificó **los 6** contra el **gateway VIVO** (HTTP 200, el `curl` publicado, control positivo con `base-sepolia`) | ✅ *"el README no quedó falso"* |

Una **cuarta** pasada encontró `README.md:35` y `README.es.md:35` **intactas** —el **primer bloque** que
lee cualquiera, en un repo **público**— más `doc/INTEGRATION.md:7`. Y el README **se contradecía consigo
mismo**: `:35` decía que el inbound Solana no existe, `:214` decía *"implemented (WKH-314), off in the
deployment that is up"*.

⚠️ **La pasada más rigurosa fue la que más reforzó la conclusión falsa.** El F4 midió contra producción
—el instrumento más caro y más convincente de toda la HU— y por eso su *"✅ ciertos en los dos estados"*
se leyó como cerrado. Era cierto **de los 6 bloques que la HU editó**; el barrido nunca salió de ellos.
**Un documento no se verifica leyendo el diff: la frase vieja no está en el diff precisamente porque
nadie la tocó.**

Es el mismo patrón que ya tiene entrada propia en el Auto-Blindaje (*las citas que rompés vos al
arreglar otra cosa*), aplicado a **prosa** en vez de a números de línea.

**El arreglo: barrer la AFIRMACIÓN, no la lista.** Cuando una HU cambia lo que algo **significa**, se
grepea la frase vieja en **todo el repo**, incluidos los archivos que la HU no abrió. Corolario medido:
cuando un doc dice A arriba y no-A abajo, **el podrido suele ser el de arriba** — se escribió antes y
nadie vuelve a leer el intro.

Hay una tercera cara del mismo hallazgo, y es la que más cuesta ver: la frase estaba **clavada por un
test verde** (`T-204-03`, `expect(body.error).toMatch(/OUTBOUND settlement rail/)`) en el único archivo
que el Scope IN mandaba reescribir y que no se reescribió. **No reescribirlo no dejó un hueco de
cobertura: dejó un candado sosteniendo la afirmación vieja**, así que nadie iba a verlo rojo nunca. Un
test verde que sostiene una frase que dejó de ser cierta es peor que un hueco: el hueco no defiende a
nadie.

---

## Hallazgos finales

**AR — 6 bloqueantes, todos arreglados, y con candado verificado por el CR bajo mutación propia
(12/13 muertos, el 13º equivalente):**

| # | Hallazgo | Estado |
|---|---|---|
| `BLQ-ALTO-1` | el monto del sobre no se comparaba contra el precio del request | resuelto (`T-PRICE-01/04`) |
| `BLQ-ALTO-2` | `reference` sin entropía por pedido ⇒ robo del pago ajeno | resuelto (`T-CHAL-02b/02c`, `T-STEAL-01/02/03`) |
| `BLQ-MED-1` | `landed_failed` perdía contra `finalized_ok` | resuelto (`T-UNK-06b/08/08b`) |
| `BLQ-MED-2` | la rama Solana quemaba la prueba con el 504 ya enviado | resuelto (`T-504-01`, `T-RPCTO-01/02`) |
| `BLQ-MED-3` | el guard anti-mainnet no se aplicaba al RPC **primario** | resuelto (`T-PRE-04c`) |
| `BLQ-BAJO-1` | el gateway decía *"two independent nodes searched"* habiendo buscado uno | resuelto (`T-ABSX-01/02`) |

**CR — 3 `BLQ-BAJO`, los tres deuda NUEVA del fix-pack 1, los tres arreglados en el fix-pack 2**: al
veto `landed_failed` se le pedía menos finalidad que al grant al que le ganaba; **cinco** citas
`archivo:línea` rotas por las ~113 líneas que el propio fix-pack insertó encima (re-barriendo
aparecieron **tres más** que el CR no había listado); y el denominador *"los 60 s de `/compose`"*, que no
existe en ninguna ruta del repo (`/compose` son 180 s, `/orchestrate` 120 s).

**MENORes**: 3 del AR + 7 del CR. Dos se marcaron explícitamente como **no-backlog** y se hicieron:
`MNR-2` (los README que afirmaban que esta HU no existe) y `MNR-7` (la entrada del Auto-Blindaje que
declaraba como medido un comportamiento de instrumento falso). El resto quedó documentado en el
Auto-Blindaje o en el propio código.

**F4 — 3 hallazgos de drift, ninguno bloqueante para el código apagado, los tres pre-requisitos para
encender**: §6.2 (el mensaje público que contradecía al README), §6.3 (el ítem del Scope IN sin hacer) y
§3.c (el costo de alertas del `unknown`, con mensaje falso para el productor nuevo). Los dos primeros se
cerraron en la 4ª pasada; §3.c quedó como **TD escrita**.

**Scope drift declarado, no escondido**: el Scope IN mandaba *"reescritura DELIBERADA de
`x402.non-evm-inbound.test.ts` — reescribir, no borrar"* y el F3 no lo hizo (agregó un archivo nuevo).
Se cumplió recién en la 4ª pasada. Un segundo ítem del Scope IN era **obsoleto sin culpa del dev**: el
guard `inboundVmUnsupported` que mandaba extender ya no existía, lo había borrado HU-DOUBLE-PAY.

---

## Auto-Blindaje consolidado — 19 entradas, ninguna perdida

El archivo íntegro es [`auto-blindaje.md`](auto-blindaje.md). Acá va el índice completo con la **regla
operativa** de cada entrada, para no tener que abrirlo sólo para saber si algo aplica.

### F3 (8 entradas)

| # | Entrada | Regla que queda |
|---|---|---|
| 1 | La rama del Story File estaba tomada por un **worktree fantasma** | *"la rama existe"* ≠ *"hay trabajo ahí"*: `git log main..rama` y contar. Antes de borrar nada de un worktree ajeno, md5 contra `main` |
| 2 | Iba a mover una línea **citada por `CLAUDE.md`** (`database.types.ts:2567`) | Toda HU que agregue una tabla mide `citations.ts` **antes** de decidir dónde insertar. Acá cambió una decisión de arquitectura: el peek pasó a `SECURITY DEFINER` en vez de `.from()` |
| 3 | Bloque sintáctico sin sentido en el archivo del challenge | Releer el archivo entero después de escribirlo. **`tsc` verde no significa "el código dice lo que quisiste decir"**: esto habría compilado |
| 4 | Un test de `src/` **no puede importar de `test/`** (TS6059) | Helper compartido por tests de `src/` ⇒ `src/**/__tests__/`. Helper de `test/` ⇒ `test/helpers/`. **No se cruzan** |
| 5 | **Adiviné el `resource`** en un test, y el verde no lo era | Todo fixture que reproduzca un valor que el sistema deriva: **tomalo del sistema, no lo escribas**. El riesgo no era el rojo: era el verde con el fixture equivocado |
| 6 | Un **guard estructural** cazó una palabra mía (`prepaid`) | Cuando un guard te frena: *"¿mi texto puede cambiar?"* **antes** que *"¿la lista puede crecer?"*. Ensanchar el candado para que pase tu caso lo debilita para el próximo |
| 7 | El candado del README se alimenta del **índice de git** | `git add` por ruta explícita (nunca `-A`) **antes** de correr la puerta, o el número que medís no es el que la suite va a ver |
| 8 | Los **dobles sin tipo** rompen `tsc` aunque los tests pasen | vitest verde **no** implica `tsc` verde. Las tres puertas, siempre, y por separado |

### Fix-pack del AR (4 entradas)

| # | Entrada | Regla que queda |
|---|---|---|
| 9 | 🔧 **CORREGIDA — la causa que escribí acá era FALSA: el hook no elide, corrompe el PIPE** | **Ésta es la versión que se lee.** Ver el bloque de abajo |
| 10 | El **test que documentaba el bug con su razón escrita** (`T-CHAL-02b`) | Cualquier test cuyo comentario diga *"inofensivo"* o *"DECLARADO"* es un lugar donde **nadie corrió el escenario**. Si la razón dice *"X protege esto"*, escribí el test que ataca **con X puesto** |
| 11 | **Un mutante que ningún mutante podía cazar** (`MNR-3`) | → **Lección 1** de este reporte. Antes de reportar un score de mutación, listar qué **inputs** no aparecen en ningún fixture |
| 12 | El **fixture positivo** también se rompe al agregar un campo al MAC | Campo nuevo en un material firmado ⇒ **obligatorio** en el tipo de verificación (`nonce: unknown`, no `nonce?:`), para que el compilador enumere todos los sitios |

**Entrada 9, íntegra, porque es la que le va a mentir al próximo si alguien lee la versión vieja:**

> La entrada decía, **como cosa medida**, que *"el hook reescribe `cat`/`sed` y el resultado colapsa
> líneas"* y que *"el comando sale 0: la pérdida es silenciosa"*. **Es falso.** El CR intentó
> reproducirlo y no pudo; el dev tampoco, re-midiendo; el F4 lo reprodujo en la dirección correcta.
>
> **Lo real** —y ya estaba en la memoria del proyecto como `rtk-proxy-corrupts-redirected-output`— es
> que el contenido del archivo llega **intacto**; lo que se corrompe es la salida **redirigida por
> pipe**, y **selectivamente según el consumidor del otro lado**:
>
> | Comando | Salida |
> |---|---|
> | `/usr/bin/wc -l chain.ts` | `329` |
> | `cat -n chain.ts` (hook) redirigido **a archivo** | `329` líneas; `diff` contra `/usr/bin/cat -n` ⇒ **IDÉNTICOS** |
> | `cat -n chain.ts` (hook) canalizado a `tail -1` | **vacío, exit 0** |
> | `cat -n chain.ts` (hook) canalizado a `wc -l` | `329` — o sea que el pipe **sí** entrega los datos |
> | `/usr/bin/cat -n chain.ts` canalizado a `/usr/bin/tail -1` | `329 }` |
>
> **La corrupción es selectiva, que es peor que total**: `wc -l` cuenta bien lo que `tail -1` pierde.
> Regla operativa: **si escribís "la herramienta X hace Y", pegá el control que distingue Y de no-Y**;
> si no, el que venga después va a explicar con ese artefacto inventado un bug de verdad.
>
> Esta fase lo volvió a confirmar por su cuenta, de refilón: `grep -n "^| 212 " doc/sdd/_INDEX.md`
> redirigido a archivo bajo el hook produjo **119 bytes**; el mismo comando con `/usr/bin/grep` produjo
> **7.749**. La fila entera del índice se había perdido en silencio con exit 0.

### Fix-pack del CR + F4 (7 entradas)

| # | Entrada | Regla que queda |
|---|---|---|
| 13 | Reporté como **MEDIDO** un comportamiento de Fastify que no medí (`MNR-1`) | Si no corriste el snippet, se escribe *"no lo medí"*, no la conclusión. **Un reporte con una razón falsa y un veredicto correcto es peor que uno sin razón: parece verificado** |
| 14 | **Al veto le pedía menos que al grant** (`BLQ-BAJO-1`) | Cada vez que subís un estado de precedencia en una tabla de decisión, releé qué hace falta para **emitirlo**. Un rank alto convierte cualquier laxitud de la precondición en una decisión de dinero |
| 15 | **Rompí CINCO citas mías** al insertar 113 líneas encima (`BLQ-BAJO-2`) | Verificar las citas **al escribirlas** no alcanza: hay que re-abrirlas **después de la última edición**. Preferir **el símbolo** al número siempre que exista uno estable |
| 16 | El **denominador que justificaba un techo no existía** (`BLQ-BAJO-3`) | Toda comparación contra un límite ajeno: si el límite vive en otro archivo, **el test lo lee de ahí**. Calibrado: bajando el techo de `/compose` a 20 s, `T-RPCTO-04` se pone rojo |
| 17 | El README decía *"configuración"* y **la API contestaba *"el código no puede"*** (§6.2 + §6.3) | Cuando una HU cambia lo que un **ERROR de la API significa**, el texto del error es **artefacto de la HU**, no documentación. Y antes de decir *"esa suite queda intacta porque sigue verde"*: preguntá **qué afirma**, no si pasa |
| 18 | 📌 **TD** — el costo del `unknown` y su mensaje EVM-específico (F4 §3.c) | **NO se implementó.** Pre-requisito para encender. Ver "Pre-requisitos" §1 |
| 19 | **2ª vuelta** — arreglé el mensaje y el README seguía diciendo la frase vieja (`:35`) | → **Lección 2** de este reporte. El barrido de docs se hace **por frase**, no por diff. Y cuando un doc dice A arriba y no-A abajo, el podrido suele ser **el de arriba** |

**Lo que el F4 midió sobre el propio pipeline, y conviene no perder**: el dev del fix-pack 2 declaró que
sus mutantes M14–M18 corrieron en el **checkout compartido**, sin worktree aislado, y que no podía
descartar residuo. El F4 lo descartó con `git hash-object` contra `git rev-parse HEAD:<f>` en los 11
archivos de mayor radio (**11/11 idénticos**), más un control positivo que sí distingue. Y midió algo
más: **la declaración del dev era MÁS grave que la realidad** — dijo que un mutante tocó
`src/routes/compose.ts`, *"el de mayor radio"*, y ese archivo **no fue modificado por esta HU en
absoluto**: coincide byte a byte con `main`. Sobre-declarar un riesgo también es no medirlo.

---

## Los tres pendientes — son pre-requisitos para ENCENDER, no para mergear

El código nace apagado y eso está verificado **en los dos lados**: `.env.example:1349`
(`SOLANA_X402_INBOUND_ENABLED=false`) y el gateway vivo publicando `acceptsInboundPayment: false` para
`solana-devnet`, re-consultado en esta fase. El predicado que lo gobierna exige **cuatro** cosas
(`src/adapters/solana/chain.ts:242-247`): `SOLANA_ADAPTER_ENABLED=true`,
`SOLANA_X402_INBOUND_ENABLED=true`, `SOLANA_X402_INBOUND_PAY_TO` y
`SOLANA_X402_INBOUND_CHALLENGE_SECRET`. Sin las cuatro, el 400 de HU-204 sale igual que antes.

### 1 · TD §3.c — el costo del `unknown`, y un mensaje que nombra un facilitator inexistente

Ya escrita en `auto-blindaje.md` (entrada 18). Cuando el veredicto de la cadena no está disponible se
emite **un log ERROR alertable + una fila durable en `a2a_events` por cada reintento, sin dedup ni
rate-limit**. Antes del fix-pack 2 ese mismo caso costaba **1 log `info` y 0 eventos**: amplificación
0 → N por fallo genuino. Aritmética del F4: un cliente que obedece el `Retry-After: 15` ⇒ **4 logs ERROR
+ 4 filas `failed` en 60 s** por un pago que no va a prosperar. Contraste medido en el mismo archivo:
`warnDefaultChainApplied` **sí** tiene ventana + cap.

Y el mensaje habla de un **facilitator que en el camino Solana no existe**: `src/middleware/x402.ts:437`
—re-verificado en HEAD por esta fase— dice literalmente *"the facilitator hop was cut without an answer,
so the payment may have executed on-chain … the caller may have been charged"*, y se emite en la rama
`txHash === null`, que en Solana es **siempre**. En el inbound Solana firma el pagador y el gateway sólo
lee la cadena. Compartir el canal fue correcto (DT-14 lo argumenta bien); **no se ajustó el texto para
el segundo productor**.

Alcance propuesto: parametrizar el mensaje por productor y evaluar dedup por `(caip2, signature)`.

### 2 · La migración no está aplicada en ninguna base

`supabase/migrations/20260819000000_wkh314_solana_inbound_proofs.sql` (+ su `_down`) crea
`public.a2a_solana_inbound_proofs` y las 3 funciones `SECURITY DEFINER`
(`record_solana_inbound_observed`, `consume_solana_inbound_proof`, `peek_solana_inbound_proof`).

⚠️ **Los 11 tests `T-MIG-01…11` leen el TEXTO del `.sql`, no el esquema de un servidor.** *"El archivo
dice X"* no es *"el servidor tiene X"*. Sin la tabla, `probeInboundProofStore()` da `table_missing` y el
preflight cierra el camino (`T-PRE-02`) — **falla cerrado**, pero **nadie verificó el otro extremo**.

Va a **bdwv**. ⛔ **Nunca `caldz`** (mainnet, prohibida).

### 3 · El smoke manual del operador

Reproducido del `f4-report.md` §8, **con una corrección de nombre re-derivada del `.sql`**, señalada en
el paso 6.

```
0. Aplicar 20260819000000_wkh314_solana_inbound_proofs.sql en bdwv (NUNCA caldz).

1. Verificar SOLANA_X402_INBOUND_PAY_TO != A2A_DEPOSIT_OWNER_SOLANA y != su ATA.
   El preflight falla cerrado (T-COL-01/01b), pero confirmalo a mano: un choque cobra
   la misma transferencia dos veces.

2. Setear SOLANA_RPC_URL_FALLBACK con un nodo DISTINTO del primario. Sin el, un `absent`
   es UNA opinion y no una ausencia corroborada. El preflight solo AVISA (MNR-1 del AR:
   la ausencia degrada a un solo proveedor EN SILENCIO).

3. Setear las 4 envs y redeployar.
   curl "$GW/capabilities"  =>  solana-devnet debe pasar a acceptsInboundPayment: true.

4. POST /compose con x-payment-chain: solana-devnet  =>  402 con network "solana:<genesis>",
   mint base58, payTo base58, reference, nonce y expiresAt.

5. Transferir USDC-SPL con esa reference, esperar `finalized`, presentar la firma => 200.
   Re-presentarla => 402 X402_SOLANA_PROOF_REPLAY.

6. En la base:
      SELECT status, amount_atomic
        FROM public.a2a_solana_inbound_proofs        <-- NOMBRE CORREGIDO
       WHERE signature = '<sig>';
   => una fila, status='consumed'.

   ⚠️ El f4-report escribio `solana_inbound_proofs` (sin el prefijo `a2a_`). El nombre
      real, leido del CREATE TABLE del .sql, es `public.a2a_solana_inbound_proofs`.
      Con el nombre viejo la consulta da "relation does not exist", que es facil de
      confundir con "la migracion no se aplico".

7. Mirar el conteo de a2a_events con eventType='x402_settle_unknown' antes y despues
   de la prueba (§3.c: sin dedup, hasta 4 filas por minuto por pago fallido).

8. Antes de encender, cerrar la TD de §3.c (x402.ts:437): si no, el primer `unknown`
   real le va a decir al pagador que un facilitator inexistente pudo haberle cobrado.
```

---

## ⛔ Lo que NO se midió — con estas palabras

Esto no es una sección de cortesía: es lo que separa *"la HU está cerrada"* de *"el rail funciona"*.

1. **Nada se probó contra devnet real con el rail encendido.** Todo `AC-1` … `AC-6` está medido **con
   dobles**. **Nadie presentó una firma real de una transferencia USDC-SPL** contra un gateway con las
   cuatro envs puestas. Tampoco se observó nunca un `{err, confirmationStatus:'processed'}` real de un
   fork descartado, que es el escenario exacto que motivó `BLQ-BAJO-1` del CR.
2. **`DT-6` sigue SIN VERIFICAR.** El faucet de devnet devolvió `Internal error` y después `429`, así
   que no se pudo firmar la transferencia que probaría que una referencia inexistente aterriza como
   cuenta read-only no-firmante. El AR dictaminó que **falla cerrado** (si el supuesto es falso,
   `readInboundBinding` da `reference_absent` ⇒ **nadie puede pagar**): riesgo de **disponibilidad**, no
   de cobrar de menos. **Sigue sin medirse.** Lo que sí se midió es la mitad que se podía:
   `getParsedTransaction` enumera cuentas read-only no-firmantes (4 de 8 en las txs de USDC devnet
   inspeccionadas), y a `commitment:'finalized'` el endpoint público devolvió `null` para las **mismas**
   tres firmas que a `'confirmed'` devolvió completas — dato que cambió una decisión del código.
3. **La migración contra cualquier base.** No se aplicó ni se consultó ninguna.
4. **La interoperabilidad del `extra.nonce` con un cliente real.** Contrato verificado en código, en
   tests y en `INTEGRATION.md`. **No se probó ninguna wallet, ni Solana Pay, ni ningún SDK x402.** El
   *"aceptable"* se apoya en que los otros seis campos del sobre ya eran custom y en que el rail nace
   apagado.
5. **La distribución de latencia de cualquier proveedor RPC.** No se puede decir si el techo de 8 s es
   alto o bajo. Sólo se midió que el denominador que lo justificaba era falso.
6. **El volumen real de la alerta de §3.c.** Se calculó la aritmética; **no se observó bajo carga**, ni
   se conoce el umbral de alertas del destino de logs.
7. **La paridad de env vars contra Railway.** Se midió **la consecuencia observable**
   (`/capabilities` publica `false`), **no las variables del servidor**.
8. **La frecuencia real del caso de `BLQ-BAJO-1`.** El camino de código existe y la frase del docblock
   era falsa para él; **no se midió con qué frecuencia pasa**, ni si pasa alguna vez.

⛔ **En ninguna parte de este reporte se afirma que un problema "ya no puede pasar".** Cada agujero
tiene escrito qué lo **acota** y qué queda **afuera**.

---

## Archivos modificados — 35 archivos, +8.543 / −136

Derivado de `/usr/bin/git diff 75de7eb...cc332f8 --stat`.

**Money-path inbound (nuevo)**
- `src/adapters/solana/inbound-presence.ts` (+506) · `inbound-verify.ts` (+314) · `inbound-preflight.ts` (+340)
- `src/lib/solana-x402-challenge.ts` (+291)
- `src/services/solana-inbound-proof.ts` (+417)
- `src/middleware/x402.ts` (+873/−…) — la bifurcación, con `return` inmediato y **antes** de `getPaymentAdapter()`

**Superficie compartida (mínima y deliberada)**
- `src/adapters/registry.ts` (+16) — `acceptsInboundPayment` pasa a una sola expresión
- `src/adapters/solana/chain.ts` (+164) — `isSolanaX402InboundConfigured` y el guard anti-mainnet del RPC **primario**
- `src/adapters/types.ts` (+131) · `src/index.ts` (+10) · `src/types/database.types.ts` (+55, sólo el bloque `Functions`)
- `src/adapters/solana/schema-preflight.ts` (2) · `settle-ledger.ts` (4)

**Migración**
- `supabase/migrations/20260819000000_wkh314_solana_inbound_proofs.sql` (+445) y `..._down.sql` (+60)

**Tests (6 archivos nuevos + 1 reescrito + fixtures + migración)**
- `x402.solana-inbound.test.ts` (+1106) · `inbound-presence.test.ts` (+744) · `inbound-preflight.test.ts` (+338)
- `inbound-verify.test.ts` (+308) · `solana-inbound-proof.test.ts` (+311) · `solana-x402-challenge.test.ts` (+278)
- `test/wkh314-inbound-proofs.migration.test.ts` (+155)
- `src/middleware/x402.non-evm-inbound.test.ts` (123 ±) — **reescrito, no borrado**
- `src/adapters/solana/__tests__/inbound-fixtures.ts` (+100)

**Docs y config**
- `.env.example` (+69) · `doc/INTEGRATION.md` (133 ±) · `doc/architecture/MULTI-CHAIN.md` (+61)
- `README.md` (16 ±) · `README.es.md` (16 ±) · `doc/sdd/_INDEX.md` (2 ±)
- artefactos SDD de la carpeta de la HU

**Lo que NO se tocó, y es parte del diseño**: `src/routes/compose.ts` y `src/services/compose.ts`
(0 bytes, idénticos a `main`), `src/adapters/solana/payment.ts` (**cero bytes**: el leg de salida no se
movió) y los 6 directorios de adapters EVM (`AC-7`). `wasiai-facilitator` recibió **cero cambios**
(regla de un escritor por repo).

---

## Decisiones diferidas

| Ítem | Dónde vive | Cuándo |
|---|---|---|
| **TD §3.c** — dedup + mensaje por productor del `unknown` | `auto-blindaje.md`, entrada 18 | **antes de encender el rail** |
| **Pared B** — el camino **prepago** tampoco se puede fondear en Solana (`deposit-verifier.ts` lo declara *Scope OUT*; `routes/auth/deposit.ts` exige `tx_hash` `0x…{64}` y `chain_id: number`) | hallazgo del F1, fuera del corte de esta HU | HU aparte: **fila 213 / WKH-315** ya existe en el índice |
| **El testigo en el facilitator** — mover la verificación a `wasiai-facilitator` | fuera de scope por la regla de un escritor por repo | HU posterior en ese repo |
| **Mainnet** | fuera de scope: devnet-only, con un guard anti-mainnet que **acota, no cierra** (no caza un hostname opaco, y la función lo dice) | sin fecha |
| **`MNR-3` del CR** — el residuo del sobre rancio: la transferencia con la referencia vieja queda varada | declarado en el CR, no resuelto | evaluar antes de encender |
| **`MI-1` del F1** — si el pagador de la demo usa clave prepaga, la HU del camino crítico es la Pared B, no la A | no verificable desde este repo; requiere `chaski-v3` | **abierto** |

---

## Lecciones para próximas HUs

1. **Un score de mutación no mide lo que la suite no ejercita.** Antes de reportarlo, listá qué **clases
   de input** no aparecen en ningún fixture. Acá 20/20 mutantes muertos convivieron con dos agujeros de
   dinero, y las dos clases ausentes se nombraban en una línea cada una.
2. **Verificar los sitios arreglados no es verificar el claim.** Una lista de sitios se cierra; una
   afirmación no. Barré la **frase** por todo el repo, incluidos los archivos que la HU no abrió — y
   desconfiá especialmente de la pasada más rigurosa, que es la que más convence a los que vienen
   después. Corolario: cuando un doc dice A arriba y no-A abajo, el podrido suele ser **el de arriba**.
3. **Un test verde puede estar sosteniendo una afirmación que dejó de ser cierta.** Ahí es peor que un
   hueco: el hueco no defiende a nadie. Cuando una HU cambia lo que un error de la API **significa**, el
   texto del error es artefacto de la HU, no documentación.
4. **Cada cero necesita su control positivo.** En esta fase el control salvó dos mediciones distintas:
   `git diff main...HEAD` dando 0 bytes **también para el control positivo** (porque `main` ya apuntaba
   a `HEAD`, no porque no hubiera diferencias), y `git status --porcelain` dando 0 líneas (cierto, pero
   sólo demostrable con `git ls-files -o` devolviendo 38.223).
5. **Una afirmación sobre el instrumento se documenta con el comando exacto que la reproduce.** La
   entrada falsa sobre el hook (*"elide líneas"*) iba a hacer que el próximo agente descartara como
   artefacto conocido un desacuerdo que habría sido un hallazgo real. Lo real es más raro y más
   peligroso: **la corrupción del pipe es selectiva según el consumidor** — `wc -l` cuenta bien lo que
   `tail -1` pierde.
6. **Subir un estado de precedencia obliga a releer sus precondiciones.** El fix del AR puso
   `landed_failed` en tier 0 sin mirar que se emitía sin exigir finalidad, y creó un caso nuevo de
   dinero. Un rank alto convierte cualquier laxitud de la precondición en una decisión de plata.

---

## Cierre

- **F4 APROBADO, 9/9 ACs** con evidencia `archivo:línea` y test por nombre.
- **Gates verdes re-derivados en HEAD**: `tsc` 0 · `biome` 0 (501 archivos) · **5924 passed / 19 skipped
  (5943)** · cobertura **88.02 / 80.6 / 92.69 / 89.54** sobre piso 80/70/80/80.
- **El rail nace apagado**, verificado en `.env.example:1349` y contra el gateway vivo.
- **Tres pre-requisitos para encender**, ninguno bloqueante para el código apagado.
- ⚠️ **`main` y `origin/main` ya están en `cc332f8`**: fast-forwardeadas y pusheadas hoy a las 11:57:55,
  no por esta fase. El código está publicado; lo que sigue apagado es el rail.
