# Implementation Log — WKH-345 (F3)

Rama `fix/222-wkh-345-uuid-param-validation`, worktree `/home/ferdev/.openclaw/workspace/wt-345`.
Todos los conteos los medí en esta sesión, con su commit al lado (P-14).

---

## Línea base (W0, primer acto)

```
git rev-parse --short HEAD → 2745bb2
npm test → Test Files 274 passed | 6 skipped (280)
           Tests  5391 passed | 19 skipped (5410)
```

**Línea base: `5391 passed | 19 skipped` @ `2745bb2`.**
No es el `5330 passed | 19 skipped` que circula: ése es de `b7fa4e7`.

---

## Las dos corridas del protocolo de dos pasos

| Paso | Wave | Commit | Test Files | Tests |
|---|---|---|---|---|
| **A** | W1 (sólo fixtures) | `c9bcee0` | 275 passed \| 6 skipped (281) | **5395 passed** \| 19 skipped (5414) |
| **B′** | W3, antes de arreglar `arbiter.test.ts` | `7862f88` (árbol limpio) | 1 failed \| 275 passed \| 6 skipped (282) | **2 failed** \| 5405 passed \| 19 skipped (5426) |
| **B** | W3 (cierre definitivo) | `f69bff8` | 276 passed \| 6 skipped (282) | **5407 passed** \| 19 skipped (5426) — **0 rojos** |

Contabilidad del Paso B contra mi línea base: 5391 + 4 (T-U1..T-U4) + 6 de ruta
(T-1a, T-1b, T-2a, T-2b, T-3, T-5) + 6 de `payments.uuid-param.test.ts`
(T-4a..T-4e + T-4-POS) = **5407**. El delta se explica entero por tests nuevos.

### Paso A — la evidencia de AC-5

W1 cambió **27 sitios** de path param en 5 archivos de test y **cero líneas** de
`src/routes/*.ts`. Control ejecutado:

```
git diff --name-only -- src/ | grep -v '\.test\.ts$'   → vacío
```

`src/lib/uuid.ts` ya existía en ese commit pero **ningún route lo importaba**: era
código inalcanzable a propósito, para que la medición separe "no cambié el camino
válido" de "moví el fixture hasta que pasó".

Contabilidad: 5391 + 4 (T-U1..T-U4) = **5395**. Todo el delta se explica por los
unitarios nuevos, o sea que **ningún test preexistente se movió** cuando los 27
path params pasaron a tener forma de UUID, con el código de producción de antes.
Eso es AC-5 medido, no prometido.

### Paso B′ → B — los 2 rojos y su resolución

Los 2 fallos estaban en **`src/services/arbiter.test.ts`**, que no estaba en el
Scope IN. Se escaló, el coordinador autorizó el arreglo, y el Paso B es la
corrida posterior. Ver "El 6º archivo" abajo.

---

## Qué hizo cada wave

| Wave | Commit | Qué |
|---|---|---|
| **W0** | `af4e126` | `src/lib/uuid.ts` (extracción byte a byte de `tasks.ts:90-95`) + `src/lib/uuid.test.ts` (T-U1..T-U4). Ningún route lo importa todavía. |
| **W1** | `c9bcee0` | Sólo fixtures: 27 path params + los asertos que nombran ese mismo path param. |
| **W2** | `2d8168c` | 9 guards en 5 archivos de producción + 6 tests de ruta + `payments.uuid-param.test.ts` nuevo. |
| **W3** | `7862f88`, `f5793c8`, `f69bff8` | Gates, mutación (4 mutantes), censo, re-verificación de citas, estos documentos, y el arreglo autorizado de `src/services/arbiter.test.ts`. |

### Los 9 guards, con su línea medida en `2d8168c`

| Archivo | Líneas | Respuesta |
|---|---|---|
| `src/routes/receipts.ts` | `:83`, `:114` | `400 { error_code: 'INVALID_INPUT' }` |
| `src/routes/auth/key-session.ts` | `:136`, `:195` | `400 { error_code: 'INVALID_INPUT' }` |
| `src/routes/auth/delegation.ts` | `:143` | `400 { error_code: 'INVALID_INPUT' }` |
| `src/routes/payments.ts` | `:262`, `:304`, `:357`, `:508` | `422 { error_code: 'INVALID_INPUT' }` |

`src/routes/tasks.ts` no lleva guard nuevo: ya tenía el suyo (`validateTaskId`).
Sólo dejó de declarar el predicado y ahora lo importa (`:76`).

### Desplazamiento real de `tasks.ts` (medido, no asumido)

El borrado del helper quita 7 líneas y el import agrega 1: **−6 netas**.

| Qué | En `2745bb2` | En `2d8168c` |
|---|---|---|
| `function validateTaskId` | `:127` | `:121` |
| `return { error: 'Invalid UUID format' }` | `:130` | `:124` |

`tasks.no-charge-before-validating.test.ts` (el pin de byte-identidad) **no se
tocó** y sigue verde.

---

## Mutación

Cada mutante se aplicó exigiendo que el `sha256sum` **difiera** antes de correr la
suite (R-1), se juzgó contra **mi** línea base (R-3), y se restauró **reescribiendo
el archivo** (nunca `git checkout --`) hasta que `git diff` diera vacío (R-2).

### Los "originales", cada uno con el commit donde vale

Un `sha256sum` de "original" sin commit al lado no sirve para nada: `src/lib/uuid.ts`
**cambió de contenido dos veces** en esta rama (al corregirse su docblock en
`7862f88`, y otra vez en el fix-pack de MENORes). Quien re-corra el mutante hoy
calcula un "original" distinto del citado y **no puede distinguir eso de una
manipulación del archivo**.

| Archivo | `sha256sum` original | Vale en |
|---|---|---|
| `src/lib/uuid.ts` | `3595862d0c6383495edaf667…` | `af4e126`, `c9bcee0`, `2d8168c` |
| `src/lib/uuid.ts` | `616b7c549986b64fc2e938c2…` | `7862f88`, `f5793c8`, `f69bff8`, `c3b7333` |
| `src/lib/uuid.ts` | `a1e585c08bd4148ece9dcd2b…` | `ee886ba` (fix-pack de MENORes) en adelante |
| `src/routes/auth/key-session.ts` | `29770366321c21ffb07f61b0…` | `2d8168c` … `ee886ba` (no cambió en ningún commit de la rama) |
| `src/routes/payments.ts` | `b1cfcd212cc032b7f2380f5f…` | `2d8168c` … `ee886ba` (no cambió en ningún commit de la rama) |

Los cinco hashes de la tabla los leí con `git show <commit>:<archivo> | sha256sum`, o
sea del **objeto de git**, no del árbol de trabajo. La tercera fila de `uuid.ts` —la
del fix-pack de MENORes— se agregó en un commit **posterior** a `ee886ba` a propósito:
mientras escribía el fix-pack ese commit todavía no existía, y un identificador no se
escribe antes de existir (auto-blindaje #4). `git rev-parse ee886ba` antes de citarlo.

| ID | Mutante | Medido en | `sha256sum` mutado | Esperado | **Medido** |
|---|---|---|---|---|---|
| **M-1** | `return UUID_RE.test(id)` → `return true` | `2d8168c` | `6ae64af867f67e00…` | T-U1 + 11 tests de ruta rojos | **15 rojos**: T-U1, los **9** tests de ruta de presencia (T-1a, T-1b, T-2a, T-2b, T-3, T-4a..T-4d) y **5 preexistentes de `tasks`**. T-4e y T-5 quedan verdes **por construcción** (ver abajo). |
| **M-2** | endurecer el patrón a v4 | `c3b7333` (re-medido) | `4b5b64236511a9be…` | sólo T-U2 rojo | **11 rojos, 9 fuera de `uuid.test.ts`** — los 9 en `src/routes/tasks.test.ts`, los 2 de acá son T-U2 y **T-U4**. La expectativa era falsa: ver auto-blindaje #1. |
| **M-3** | flags `i` → `gi` | `c3b7333` (re-medido) | `05b5989a5751c791…` | T-U3 rojo | **32 rojos, 29 fuera de `uuid.test.ts`** en **9 archivos**; los 3 de acá son T-U3, T-U2 y T-U4. El `lastIndex` compartido rompiendo ids válidos, medido. |
| **M-4** (propio) | mover el guard **arriba** del gate de prefijo en `DELETE /key-session/:id` | `2d8168c` | `7472834d14892925…` (de `key-session.ts`) | — | **T-5 rojo** (`400` donde espera `403`), **T-SUBSESSION verde**. Justifica el desvío de T-5. |
| **M-5** (propio, fix-pack) | mover el guard **arriba** del gate `isArbiterEnabled()` en `POST /session/:id/dispute` | `c3b7333` | `c0502dd2a6a4cdda…` (de `payments.ts`) | — | **1 solo rojo en TODO el repo: T-4e**. `arbiter.test.ts` queda **64 passed (64)**. Ver "el testigo que consumió el arreglo". |

### Por qué M-2 y M-3 se re-midieron, y qué cambió

El `13 rojos / 11 fuera` de M-2 y el `33 rojos` de M-3 son de `2d8168c`, commit en el
que **`arbiter.test.ts:991` y `:1010` ya estaban rojos sin ningún mutante**
(auto-blindaje #2). La fila de M-3 lo desglosaba (`+ los 2 preexistentes`); la de M-2
**no**, así que le cargaba al mutante 2 fallos que no eran suyos. Re-medidos en
`c3b7333`, con esos 2 ya arreglados y el árbol limpio: **M-2 = 11/9** y
**M-3 = 32/29 en 9 archivos**. Ésos son los números que también quedaron escritos en
los docblocks de `src/lib/uuid.ts` y `src/lib/uuid.test.ts`.

### Por qué M-1 da 9 y no 11

T-4e y T-5 **no pueden** morir con M-1, y eso es correcto: no son tests de
*presencia* del guard, son tests de su **orden**. Con el guard anulado, T-4e sigue
recibiendo el `404` del gate de `ARBITER_ENABLED` y T-5 sigue recibiendo el `403`
del gate de prefijo — que es exactamente lo que afirman. Mueren con el mutante
**contrario**, y M-4 lo demuestra para T-5. La expectativa "los 11 rojos" del
Story File mezcla dos familias de test.

Los 5 rojos extra de `tasks` bajo M-1 son señal buena: confirman que la
extracción quedó **cableada**, o sea que `tasks.ts` usa el predicado compartido y
no una copia.

---

## Gates

| Gate | Comando | Resultado |
|---|---|---|
| Tipos | `npx tsc --noEmit` | **limpio** (exit 0) |
| Lint | `biome check src/` | **limpio** — 476 archivos, 0 errores |
| Suite | `npm test` | **0 rojos** — `5407 passed \| 19 skipped (5426)` |
| Ownership (ver abajo) | `git diff --stat 2745bb2 -- src/services/ ':!*.test.ts'` | **vacío** |
| Ownership — la excepción, visible | `git diff --stat 2745bb2 -- src/services/` | `arbiter.test.ts` \| **94 insertions, 74 deletions** (1 archivo). Era `+85 −71` antes del fix-pack de MENORes, que agregó las 3 interpolaciones de `${INTENT_ID}` en los mensajes del falso. |
| Un solo regex (AC-6) | `grep -rn "0-9a-f]{8}-" src/` | **1 sola ocurrencia de producción**: `src/lib/uuid.ts:57` (era `:51`; el fix-pack de MENORes agregó 6 líneas al docblock de arriba, re-medido con `python3` sobre el árbol final). Las otras 5 son de test, con sus propios patrones más estrictos. |
| Censo de `.params` | `grep -rl "\.params" src/routes/` | **16 archivos, conjunto idéntico** al de `2745bb2` (comparé los dos conjuntos, no sólo el total). |
| Censo de fixtures de path param | criterio corregido, ver abajo | **11 sitios, los 11 deliberados**. Cero accidentales. |

### El paso 4, afinado — dos números, no uno

El paso 4 de §9 pedía `git diff --stat -- src/services/` **vacío**. Ese comando es
un **proxy** de una intención: *"no cambiaste lógica de propiedad ni de negocio"*.
Una cadena de URL dentro de un fixture `.test.ts` no es ninguna de las dos, así que
acá el proxy y su intención **divergen**.

De las tres salidas posibles, dos son malas: violar el chequeo y anotarlo al pie
(el próximo lector no sabe si fue deliberado), o dejar 2 tests rojos (la HU no
cierra por algo que no es un defecto). La tercera es satisfacer la intención y
hacer que el chequeo diga la verdad sobre lo que protege:

```bash
git diff --stat 2745bb2 -- src/services/ ':!*.test.ts'    # vacío  ⇒ cero producción
git diff --stat 2745bb2 -- src/services/                  # 1 archivo, +94 −74
```

**Verificado que el pathspec de exclusión funciona en este git** (2.43.0) antes de
apoyarme en él: lo probé contra `src/routes/`, donde sé que hay cambios de los dos
tipos, y filtró los 6 `.test.ts` dejando los 5 de producción. Usé la forma con **un
solo** `--`; con `--` duplicado git lo interpreta distinto.

El segundo número es obligatorio: la excepción tiene que quedar **visible**, no
tapada por un pathspec más permisivo.

Sobre este gate: el verde de `test/ownership-filter-guard.test.ts` **no** es
evidencia acá — verifica presencia textual del filtro, no su valor, y deja los
`supabase.rpc(...)` afuera, que es justo la forma que usa `payments.ts`.

---

## El 6º archivo — escalado, autorizado, arreglado

`src/services/arbiter.test.ts` inyectaba 4 veces contra rutas de `payments.ts` con
`:id = 'i1'`, que no tiene forma de UUID. El censo de §5 no lo lista: enumera 20
sitios en 5 archivos, **todos bajo `src/routes/`**, y éste vive en `src/services/`.

Los cuatro sitios son las líneas `url:` que inyectan. Van con **dos** números,
porque el archivo se desplazó dos veces: `+10` por el bloque de `INTENT_ID` y `+6`
por el fix-pack de MENORes. Re-medidos con `python3` sobre el árbol final:

| Sitio en `2d8168c` | Hoy (`url:`) | El `it(` que lo contiene | Qué pide | Estado con el guard, antes del arreglo |
|---|---|---|---|---|
| `:935` | **`:951`** | `:941` | `POST` dispute, flag **OFF**, espera `404` | **verde** — el gate del flag corre antes del guard. |
| `:949` | **`:965`** | `:960` | `GET` dispute, flag OFF, espera `404` | **verde** — `GET` no lleva guard (P-5). |
| `:991` | **`:1007`** | `:994` | `POST` dispute, flag **ON**, espera `200` | **ROJO**, recibía `422` |
| `:1010` | **`:1026`** | `:1015` | `POST` dispute, flag ON, espera `409 INTENT_NOT_OPEN` | **ROJO**, recibía `422` |

Se escaló en vez de arreglarlo de una (§2: "si creés que hace falta tocar uno más,
parás y escalás"). El coordinador autorizó el arreglo, **incluidos los dos verdes**:
dejar `'i1'` en los dos primeros deja dos fixtures que **cruzan el guard nuevo por
accidente**, y un cambio de orden mañana los rompe sin que se entienda por qué.

### ⚠️ El arreglo CONSUMIÓ un testigo, y T-4e quedó solo

La fila del `POST` con flag OFF decía, además, "testigo independiente de D-3 y de
T-4e". **Ya no lo es, y eso hay que leerlo como una pérdida de cobertura.** La
frase no era falsa —la columna habla de *antes del arreglo*, y antes sí lo era—,
pero el estado que describe ya no existe.

Medido con **M-5** (mover el guard arriba del gate `isArbiterEnabled()` en
`POST /session/:id/dispute`; `payments.ts` `b1cfcd21…` → `c0502dd2…`, en `c3b7333`):

```
npm test                              → 1 failed | 5406 passed  (1 solo rojo)
  el único rojo: payments.uuid-param.test.ts > T-4e
npx vitest run src/services/arbiter.test.ts → 64 passed (64)
```

O sea: con el `:id` refixtureado a un UUID **válido**, ese test ya no puede
distinguir "el gate del flag corre primero" de "el guard corre primero" — pasa el
guard en los dos órdenes y recibe su `404` igual.

> **Hoy T-4e (`src/routes/payments.uuid-param.test.ts`) es el ÚNICO testigo del
> orden `isArbiterEnabled()` antes del guard de forma (D-3) en todo el repo.**
> Si alguien lo borra creyendo que `arbiter.test.ts` cubre el orden, D-3 pierde
> **toda** su cobertura y la suite no se pone roja. Lo mismo vale al revés: no
> "simplificar" T-4e a un `:id` bien formado.

Es la **segunda vez en esta misma HU** que un refixture apaga un testigo: la
primera fue T-SUBSESSION (`auth.key-session.test.ts`, auto-blindaje #3), donde W1
cambió `sess-1` por un UUID válido. Dos instancias medidas del mismo mecanismo
dejan de ser anécdota, así que está nombrado **como patrón** en el auto-blindaje
(entrada #6), con su control.

### El arreglo NO fueron 4 líneas, y la razón importa

`makeArbDb` compara el id contra el literal: era `:385` (`b._conds.id !== 'i1'`)
en `2745bb2`, pasó a `:395` con el bloque de la constante nueva (**+10 líneas**) y
hoy está en **`:399`** (`!== INTENT_ID`), tras el **+4** del fix-pack de MENORes
por encima de esa línea. O sea que los 4 sitios **no se
pueden arreglar en aislamiento**: cambiar sólo las URLs hace que el falso no
encuentre la fila y los tests fallen por otro motivo. Las dos salidas eran:

- enseñarle al falso **dos** ids para una misma fila ⇒ un hack, y deja el archivo
  con dos convenciones de id;
- **un solo id con nombre, con forma de UUID, en todo el archivo** ⇒ esto.

Se hizo lo segundo: `const INTENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`
(`src/services/arbiter.test.ts:124-132`), 4 URLs a template y 57 literales
`'i1'` → `INTENT_ID`. Es semánticamente un no-op —el id es un valor opaco de
fixture— y además vuelve el fixture **realista**: `a2a_payment_intents.id` ES una
columna `uuid`, así que `'i1'` nunca pudo haber existido en la base.

**Faltaban 3, y el fix-pack de MENORes las cerró.** Ese barrido tomó los literales
`'i1'` sueltos, pero no las **tres apariciones dentro de un string más grande**: los
mensajes de error que fabrica el falso, en `:259`, `:297` y `:916` de aquel momento.
Quedaban diciendo `intent i1` con el fixture ya llamándose `INTENT_ID`, o sea
contradiciendo el "un solo id con nombre en todo el archivo" de acá arriba.
Verificado inofensivo antes de tocarlos: ninguna aserción compara esos strings, y el
servicio no los parsea — hace `msg.includes('OWNERSHIP_MISMATCH')` y
`msg.includes('INTENT_NOT_OPEN')` (`src/services/arbiter.ts:347` y `:353`), o sea un
`includes` sobre el mensaje entero, que es indiferente al id que lleve dentro. Y aun así se
arreglan: pasan a `${INTENT_ID}`, que además es lo que hace el RPC real
(`RAISE EXCEPTION 'INTENT_NOT_OPEN: intent % is %', p_intent_id, v_status`,
`supabase/migrations/20260704100000_wkh139_arbiter.sql:111`). Interpolar corrió las
tres líneas a 3 objetos multi-línea (el formatter de biome no las deja en 80
columnas), y de ahí el **+6** de desplazamiento que se re-midió arriba.

Verificado: `arbiter.test.ts` **64 passed (64)**, incluido el test del nonce
derivado (hoy `:1410`, `deriveArbiterNonce(EXPECTED_KEY_HASH, INTENT_ID, …)`), que era
el único sitio donde el valor del id no es opaco sino que entra a una derivación
criptográfica. Los dos lados derivan del mismo constante, así que se movieron
juntos.

### El hallazgo que esto destapa, y vale más que el arreglo

**Es la tercera aparición del patrón de §5, y ahora sabemos por qué el censo lo
perdió: estaba acotado a `src/routes/`.** El patrón no vive en un directorio, vive
en cualquier test que arme una URL con un path param.

> **El censo de fixtures de path param se define por lo que el fixture
> construye, no por dónde vive el archivo.**

Censo re-corrido con ese criterio sobre **`src/` y `test/` enteros** (495 archivos,
6 superficies con guard incluyendo `/tasks/`), buscando todo `:id` sin forma de
UUID:

**11 sitios, y los 11 son tests negativos deliberados.** Cero accidentales, **no
apareció un 7º archivo**. Como es una afirmación de **ausencia**, va con el
instrumento que la produjo:

- 6 son los tests negativos nuevos de esta HU (`'not-a-uuid'`).
- 3 son los preexistentes de `tasks.test.ts` (`:352`, `:360`, `:370`), del guard
  que `tasks.ts` ya tenía.
- 2 son `tasks.no-charge-before-validating.test.ts:512` (`'no-soy-un-uuid'`) y
  `:528` (`'nope'`) — T-NCT-08 y T-NCT-09. Un clasificador que sólo busque el
  literal `'not-a-uuid'` los marca como residuales por error: son deliberados.

El script del censo está en el reporte de F3; lo importante es el criterio, porque
el script se vuelve a escribir y el criterio no.

---

## Residuos

- **R-2 sigue ABIERTO** (P-6). `if (error || !data)` colapsa **todo** error de
  Postgres en `404`, no sólo el de forma: estaba en `payments.ts:387` en
  `2745bb2` y ahora está en **`:409`** (se corrió +22 por los guards de arriba).
  No lo toqué y no está arreglado.
- **R-3**: los 5 regex de UUID que quedan en `src/` son todos de test y ninguno es
  el guard de borde. Cuatro de ellos (`schema-preflight.test.ts:95`,
  `request-id.test.ts:33` y `:50`, `e2e.test.ts:30`) **sí** validan v4 sobre ids
  generados por el servicio, y unificarlos hacia el patrón laxo debilitaría
  asertos legítimos. `refund-idem.test.ts:81` usa el laxo. Ninguno se unifica.
- El `:id` de `GET /payments/session/:id/dispute` sigue **sin guard** (P-5).
- `src/routes/registries.ts`, `auth/identity.ts`, `inbound.ts`,
  `auth/require-signature.ts` y `auth/spend-policy.ts`: **no tocados**.
- `src/routes/dashboard.ts` sigue con el mismo bug estructural en sus 4
  `:intentId`, tras `requireAdminTokenStrict`. Scope OUT (P-7), fast-follow.
