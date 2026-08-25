# AR — Iteración 2 (re-AR del fix-pack) · WKH-364 · Sonda del camino del dinero

- **Rama / commit**: `feat/227-sonda-money-path` @ `3d83c03` (árbol limpio, base `origin/main`)
- **Alcance**: **SÓLO el fix-pack**. La iteración 1 (`ar-report.md`) y el `cr-report.md` no se re-barren.
- **Fecha**: 2026-08-25
- **Veredicto**: ✅ **APROBADO con MENORes** — **0 BLOQUEANTES**, 5 MENORes.

---

## 0. Método, y por qué se puede creer el resultado

- **45 mutantes** aplicados sobre el código del fix-pack: **35 KILLED, 10 SURVIVED**.
  Arnés: copia previa a directorio propio, restauración por `cp`, `assert md5` **después de
  cada mutante**. ⛔ Nunca `git checkout --`. MD5 final verificado idéntico al inicial y
  `git status --short` vacío.
- **4.860 combinaciones** de respuestas `/discover` × `/compose` × env ejecutadas contra
  `main()` con `fetch` doblado, cazando `exit 0` y excepciones.
- **Los 3 bloques `run:` del YAML ejecutados de verdad** (`bash -e`, con `npm` y `gh`
  doblados), en 13 escenarios — incluidos los de inyección.
- **Sondeo en vivo** contra producción, coste **0 USDC** (`GET /discover` + un `/compose`
  con credencial inválida que muere en el middleware).
- **Gate completo del repo, en orden, una vez** (⛔ `npm run qa` no existe acá).

### El gate

| Paso | Comando | Resultado |
|---|---|---|
| 1 | `npx tsc -p tsconfig.json --noEmit` | **exit 0**, sin salida |
| 2 | `npm run lint` (`biome check src/`) | **exit 0** — `Checked 503 files in 192ms. No fixes applied.` |
| 3 | `npm test` (`vitest run`) | **exit 0** — `Test Files 299 passed \| 6 skipped (305)` · `Tests 6008 passed \| 19 skipped (6027)` |

Los **305** archivos concuerdan con el número que los dos README declaran tras el fix-pack
(`README.md:378`, `README.es.md:412`, `304 → 305`), y ese número lo deriva
`test/readme-numbers.test.ts`, que está en verde. `test/**/*.test.mjs` ya estaba en el
`include` de `vitest.config.ts:5` **antes** de esta HU: el archivo nuevo no entró por una
excepción escrita para él.

---

## 1. 🎯 ¿`PASS` es REALMENTE inalcanzable por omisión?

**Sí. Medido, no leído.** Y el arreglo **no** introdujo un falso DOWN.

### 1.1 Barrido exhaustivo de `main()` — 4.860 entradas

20 formas de respuesta de `/discover` (200 con card real, 200 sin `metadata`, 200 con body
no-JSON, 200 sin `outputSchema`, 200 con `inputSchema` vacío, 204, 302, 304, 400, 401, 403,
404, 418, 429, 451, 500, 503, error de red) × 27 formas de `/compose` (2xx con cotización
real, 2xx con `success:false`, 2xx con body `null`, `steps:[]`, `output` string, `rate:0`,
`NaN`, `Infinity`, negativo, `"3.7"` string, 201, 299, 204, 400/402/403/500 con y sin
`agentFailure`/`error_code`/`errorCode`, red, timeout) × 9 envs.

**Resultado**: `exit 0` en **24 de 4.860**, y las 24 son **6 formas únicas**, todas
legítimas — `calls=[GET,POST]`, status 2xx de `/compose` y `assertQuoteShape().ok === true`:

```
exit=0 calls=[GET,POST] discover=200 card real          compose=200 cotizacion real :: PASS
exit=0 calls=[GET,POST] discover=200 card real          compose=201                 :: PASS
exit=0 calls=[GET,POST] discover=200 card real          compose=299                 :: PASS
exit=0 calls=[GET,POST] discover=200 inputSchema vacio  compose=200 cotizacion real :: PASS
exit=0 calls=[GET,POST] discover=200 inputSchema vacio  compose=201                 :: PASS
exit=0 calls=[GET,POST] discover=200 inputSchema vacio  compose=299                 :: PASS
```

**Cero excepciones** (`exit 1`) en las 4.860. Ninguna combinación produjo `PASS` con
`calls=[GET]`, que era el defecto de origen (`auto-blindaje.md:72-95`).

> El caso `inputSchema: {}` merece una línea y **no es un hallazgo**: un catálogo que
> publica un schema sin propiedades hace que la sonda mande `input:{}`, y ahí el agente real
> devuelve 400 `INPUT_REJECTED` ⇒ DRIFT(4). Sólo sale PASS en el fuzz porque yo forcé un 2xx
> con cotización. En producción ese camino no llega a verde.

### 1.2 ¿Falso DOWN por el default nuevo (fila 12)?

**No.** La fila 12 (`probe-money-path.mjs:310`) es **inalcanzable desde `main()`**: los tres
únicos `return` que ocurren después de derivar y antes del POST son `amountInvalid`
(fila 0-bis), `derive.reason` (fila 3) y `selfTestFieldPresent === false` (interceptado en
`classify`, `:224`), y los tres devuelven su propia clase. Con `obs.compose` presente, el
2xx cae en fila 10 u 11 y el no-2xx en fila 9. La fila 12 es red de seguridad pura, y su
mutante a `PASS` **muere** (mutante B3, 2 rojos).

### 1.3 Sondeo en vivo (0 USDC)

| Entrada | Salida | exit |
|---|---|---|
| sin `A2A_PROBE_KEY` | `CONFIG: credencial de sonda ausente (A2A_PROBE_KEY) — esto NO dice nada sobre producción` | **3** |
| sin key + `GITHUB_EVENT_NAME=pull_request` | `SKIP: … un pull_request DESDE UN FORK no recibe el secret del repo` | **0** |
| `A2A_PROBE_KEY=wk_credencial_inventada_por_el_ar` | `CONFIG: la credencial de la sonda (KEY_NOT_FOUND) — producción no está implicada \| … schemaSha256=ee87a63f8e71 omitted=[destCountry] httpStatus=403` | **3** |

El `SKIP`/exit 0 sólo existe con `GITHUB_EVENT_NAME === 'pull_request'`, que GitHub setea
siempre; en la corrida por `schedule` es inalcanzable, así que **la sonda no puede cerrar
sola el issue de una caída**. El mutante que lo desata (C8) muere con 2 rojos.

### 1.4 Riesgo verificado y descartado: el `outputSchema` publicado

`assertQuoteShape` (`:190-202`) cruza `rate` y `netDeliveredLocal` contra el `outputSchema`
del card. Si producción no los declarara, el `PASS` sería **inalcanzable para siempre** y la
sonda daría DRIFT(4) 48 veces por día. **Medido en vivo hoy**:

```
GET /discover/remit-corridor-fx-solana → 200
metadata keys: [ 'payment', 'inputSchema', 'discoverable', 'outputSchema' ]
outputSchema.properties: rate, slug, feeUsd, quoteId, expiresAt, etaMinutes,
                         provenance, localCurrency, netDeliveredLocal
```

`rate` ✅ y `netDeliveredLocal` ✅. Y el `inputSchema` vivo es **byte-equivalente** al fixture
`SCHEMA_REAL` (`test/probe-money-path.test.mjs:63-71`): mismo `schemaSha256=ee87a63f8e71`
que el log D-1 del Dev.

**Veredicto de la sección: OK.**

---

## 2. La atribución — el hallazgo propio del fix-pack, y hasta dónde llegó

El Dev extrajo la lección correcta (`auto-blindaje.md:90-92`):

> *«Defensa en profundidad vuelve equivalentes a los mutantes de la capa de arriba: si el
> test mira sólo el exit code, la redundancia se pudre en silencio. Hay que fijar la
> ATRIBUCIÓN.»*

**La aplicó a la fila donde la descubrió, y a ninguna otra.** Medido con 9 mutantes que
conservan clase y exit code y sólo degradan el mensaje:

| Mutante | Fila | Mensaje mutado | Resultado |
|---|---|---|---|
| E1 | 2-bis | pierde `/discover` | **KILLED** (`T-5: PASS es inalcanzable…`, `toContain('/discover')`) |
| E8 | 0 | pierde `A2A_PROBE_KEY` y el descargo | **KILLED** (`T-7`) |
| E2 | 1 | `DOWN: /discover inalcanzable (…)` → `DOWN: algo no anduvo` | 🔴 **SURVIVED** |
| E7 | 2 | pierde el slug del agente | 🔴 **SURVIVED** |
| E3 | 3 | pierde `<campo>` y `<detalle>` | 🔴 **SURVIVED** |
| E4 | 4 | pierde `(<error_code>)` | 🔴 **SURVIVED** |
| E9 | 9 | `DOWN: candidata a caída real …` → **`DOWN: producción está caída`** | 🔴 **SURVIVED** |
| E6 | 10 | pierde el campo y la razón | 🔴 **SURVIVED** |
| E5 | 12 | pierde `2xx de /compose` | 🔴 **SURVIVED** |

**7 de 9 sobreviven.** `story-file.md:205-217` (§5) fija el **prefijo exacto del mensaje fila
por fila** — es contrato, no prosa — y sólo dos filas tienen testigo. Los 20 casos de la
tabla T-5 (`test/probe-money-path.test.mjs:167-174`) asierten `klass`, `exit` y
`message.startsWith(klass + ':')`: aceptan el número correcto por la razón equivocada.
Los 4 casos T-15 (`:317-356`) asierten `exit` + cantidad de llamadas, nunca stdout.

⚠️ **E9 es el más caro de los siete**: convierte el único mensaje de la escalera que dice
*«candidata»* en una afirmación de certeza — exactamente el falso rojo que la HU existe para
no producir — y la suite entera queda verde. `T-6` (`:245-253`) sólo comprueba que un mensaje
no contenga la palabra del otro.

**Los mensajes de HEAD son correctos** (verificados uno por uno contra §5): esto es una
deuda de testigo, no un defecto. Por eso es **MNR-1** y no bloqueante. Pero es la deuda que
el propio fix-pack nombró y no cerró.

---

## 3. Los 12 mutantes que el Dev declara muertos + los que no probó

**45 mutantes / 35 KILLED / 10 SURVIVED.** Baseline: `47 passed (47)`.

### 3.1 Los dos que ANTES sobrevivían — reproducidos

| # | Mutante | Resultado |
|---|---|---|
| A1 | `key=${process.env.A2A_PROBE_KEY}` en la línea de clase (`emit`, `:406`) | **KILLED** — `T-13`, 1 rojo |
| A2 | `COMPOSE_TIMEOUT_MS, false` → `true` (el POST reintenta ante timeout, `:396`) | **KILLED** — `T-14`, 1 rojo |
| A2b | `isRetryable` devuelve `true` para todo `AbortError` (`:317`) | **KILLED** — `T-14`, 1 rojo |
| A1b | fuga de la credencial **lavada por un alias** (`globalThis.__k = key` en `readCredential` + impresión en `emit`) | 🔴 **SURVIVED** → **MNR-2** |

Las dos regresiones que el AR-it1 cazó están cerradas, **y el cableado también** (A2b: T-14
prueba la función pura *y* los dos call-sites, `:472-473`).

### 3.2 La escalera y la derivación

| # | Mutante | Resultado |
|---|---|---|
| B1 | borra la fila 2-bis entera | KILLED (1) |
| B2 | fila 2-bis sólo para `>= 400` (204/302 se cuelan) — **no probado por el Dev** | KILLED (1) |
| B3 | el default (fila 12) vuelve a ser `PASS` | KILLED (2) |
| B4 | fila 11 sin exigir `assertQuoteShape().ok` | KILLED (1) |
| B5 | fila 11 sin exigir `is2xx` | 🟡 SURVIVED — **equivalente**, ver §3.5 |
| B6 | la fila 10 no dispara | KILLED (1) |
| B7 | `assertQuoteShape` acepta cualquier cosa | KILLED (1) |
| B8 | fila 4 sólo grafía `error_code` (snake) | KILLED (1) |
| B9 | fila 4 sólo grafía `errorCode` (camel) | KILLED (2) |
| B10 | fila 4 sin el `Set` de `SCOPE_ERROR_CODES` | KILLED (1) |
| B11 | **cualquier** 403 es CONFIG, incluido el desconocido — **no probado por el Dev** | KILLED (1) |
| C6 | `deriveInput` hardcodea `{amountUsd:25, payoutMethod:'yape'}` | KILLED (5) |
| C7 | `deriveInput` inventa un `string` libre requerido (`'PE'`) | KILLED (2) |
| C9 | `assertQuoteShape` sin el carve-out de `drift` | KILLED (1) |
| C8 | la fila 0 devuelve `SKIP`/0 también fuera de `pull_request` | KILLED (2) |

**La grafía desconocida se comporta bien** (`errorCode: 'ALGO_RARO'` en un 403 ⇒ fila 9,
DOWN/2): la fila 4 no se volvió un colador. Testigo: `:193-194`.

### 3.3 La guarda de B-4 (self-test) — incluidos los casos que el Dev no probó

| # | Mutante | Resultado |
|---|---|---|
| C1 | `classify` sin la guarda `selfTestFieldPresent === false` (`:224`) | KILLED (2) |
| C2 | `main` no corta antes del pipeline (`:381`) | KILLED (1) |
| C3 | `obs.selfTestFieldPresent = Boolean(input[campo])` en vez de `campo in input` | 🔴 SURVIVED → **MNR-3** |
| C4 | fila 0-bis borrada (`PROBE_AMOUNT_USD` inválido ⇒ DRIFT) | KILLED (2) |
| C5 | `main` sin el `Number.isFinite` del monto (`:364`) | KILLED (1) |

**«El campo presente pero vacío»**: `PROBE_SELF_TEST_OMIT_REQUIRED=''` o `'   '` ⇒
`String(...).trim() || null` ⇒ `null` ⇒ no hay self-test. Correcto, y es lo que produce
`${{ inputs.self_test && 'amountUsd' || '' }}` en la corrida por reloj.

### 3.4 El YAML — 12 mutantes, **12 KILLED**

D1 borra `id: sonda` · D2 `codigo=$?` en vez de `${PIPESTATUS[0]}` · D3 borra `exit "$codigo"` ·
D4 borra el `tee` · D5 borra `LINEA:` · D6 pega el **log entero** en vez de la línea ·
D7 borra el `paths:` del trigger · D8 devuelve la consulta `gh` a una asignación suelta ·
D9 desincroniza el `TITULO` del cierre respecto del de creación · D10 `continue-on-error: true`
incondicional · D11 el aviso se dispara en cualquier evento · D12 segunda env que cablea el
self-test. **Ninguno sobrevive.** Los tres testigos que hacen el trabajo son
`:375-396`, `:360-373` y `:398-412`.

### 3.5 Los 10 supervivientes, clasificados

| Clase | Mutantes | Qué son |
|---|---|---|
| Atribución sin testigo | E2, E3, E4, E5, E6, E7, E9 | **MNR-1** — deuda real de testigo |
| Lavado por alias | A1b | **MNR-2** — ningún test estructural puede cazarlo |
| Semántica `in` vs truthiness | C3 | **MNR-3** — hoy inocuo |
| **Equivalente** | B5 | **no es hallazgo**: la fila 9 (`:293`) ya devuelve DOWN para todo `c.status` no-2xx, así que el `is2xx &&` de la fila 11 es redundante *por construcción* y ningún test puede distinguirlo. Es el mismo fenómeno que el Dev documentó — redundancia sana, mutante equivalente |

---

## 4. B-3 — el shell, ejecutado

Los tres bloques `run:` extraídos verbatim del YAML y corridos con `bash -e` (el shell por
defecto de GitHub Actions para `run:`), con dobles de `npm` y `gh`.

### 4.1 El step de la sonda — el exit sobrevive al `tee` en los 7 escenarios

| # | Escenario | exit del step | `$GITHUB_OUTPUT` |
|---|---|---|---|
| S1 | sonda exit 3, una línea `CONFIG:` | **3** ✅ | `clase<<PROBE_EOF\nCONFIG: la credencial…\nPROBE_EOF` |
| S2 | sonda exit 0, línea `PASS:` | **0** ✅ | la línea `PASS:` |
| S3 | sonda no imprime nada, exit 1 | **1** ✅ | `(la sonda no llegó a emitir su línea de clase)` |
| S4 | **dos** líneas de clase (self-test) | **2** ✅ | `DOWN: candidata a caída real` — `tail -n 1` gana |
| S5 | línea con `` ` ``, `$( )`, `"`, `'`, `\`, `%s` | **2** ✅ | literal, sin evaluar |
| S6 | **inyección**: la línea trae `\nPROBE_EOF\nclase=INYECTADO\nPROBE_EOF` | **2** ✅ | `DOWN: x` — **la inyección no pasa** |
| S7 | sólo ruido de `npm ERR!`, exit 1 | **1** ✅ | el texto de "no llegó a emitir" |

⚠️ **S6 es el que importa**: el ancla `^(PASS\|DOWN\|DRIFT\|CONFIG\|SKIP\|SELF-TEST): ` de
`grep` más `tail -n 1` garantizan que `linea` sea **exactamente una línea que empieza por una
de las seis clases**. Un `PROBE_EOF` inyectado no matchea el ancla y se descarta ⇒ **el
heredoc de `$GITHUB_OUTPUT` no se puede cerrar desde el mensaje de la sonda**, ni siquiera si
alguien controlara el catálogo remoto (los tres campos de origen remoto que llegan al mensaje
son `obs.derive.field`, `obs.derive.detail` y `facts.omitted[]`, todos nombres de propiedad
del `inputSchema` publicado).

### 4.2 El step del aviso

| # | Escenario | Resultado |
|---|---|---|
| T1 | línea normal | `gh issue create` con la línea dentro de un bloque ``` ✅ |
| T2 | `LINEA` vacía | `clase=${LINEA:-(…)}` **funciona sin comillas**: el cuerpo muestra `(la sonda no llegó a emitir su línea de clase: puede haber fallado un paso anterior)` ✅ |
| T3 | `gh issue list` falla | `::error::…se intenta crear el aviso igual` **y llama a `create`** ✅ (el `if !` desarma el `set -e`) |
| T4 | ya hay issue abierto (#42) | `gh issue comment 42`, no `create` ✅ |
| T5 | **inyección**: `LINEA='DOWN: $(touch …/PWNED) \`touch …/PWNED2\` fin'` | **ningún archivo creado**; el texto viaja literal al `--body` ✅ |

**T5 confirma que no hay inyección de comando**: `$clase` va entre comillas dobles en
`printf` y bash **no re-escanea** el resultado de una expansión de parámetro.

### 4.3 El step del cierre

| # | Escenario | Resultado |
|---|---|---|
| U1 | no hay issue abierto | no llama a `close`, exit 0 ✅ |
| U2 | hay #42 | `gh issue close 42 --comment …`, exit 0 ✅ |
| U3 | `gh issue list` falla | `::warning::…` y **exit 0** — no escala a rojo ✅ |

**Veredicto de la sección: OK.** El único `run:` que corre con `set -e` desactivado es el de
la sonda, y su exit lo reconstruye a mano `${PIPESTATUS[0]}`; los otros dos llevan
`set -euo pipefail` y las únicas dos rutas que pueden matarlos están envueltas en `if !`.

---

## 5. Fuga de credencial — ¿testigo o candado que se lee a sí mismo?

**Es un testigo, no un candado vacuo.** T-13 (`test/probe-money-path.test.mjs:446-461`)
escanea `SCRIPT_CODE`, que es *el script* con sus comentarios quitados — **no se escanea a sí
mismo**, así que no cae en el patrón `expect(self.includes("literal"))`.

Sus tres aserciones y qué mutante mata cada una:

| Aserción | Mutante que la activa | Resultado |
|---|---|---|
| `env.A2A_PROBE_KEY` aparece **1** vez | A1 (`key=${process.env.A2A_PROBE_KEY}` en `emit`) | KILLED |
| `cred.key` aparece **1** vez, y es el header del POST | `process.stdout.write(cred.key)` en `main` | KILLED (count → 2) |
| el cuerpo de `emit` no matchea `/A2A_PROBE_KEY\|cred\.key\|\bkey\b/` | pasar `cred` a `emit` e imprimirlo | KILLED |

**Lo que NO cierra** (mutante A1b, medido): lavar el valor por un alias que no nombra ninguno
de los dos literales —`globalThis.__k = key` en `readCredential` y `${globalThis.__k}` en
`emit`— pasa con **47 passed (47)**. Ningún test estructural sobre texto puede cazar eso; el
que lo cazaría es uno de comportamiento que corra `main()` con una key sentinel y afirme que
no aparece en stdout. Ver **MNR-2**.

`sinComentariosJs` (`:53-57`) filtra sólo líneas cuyo texto **arranca** con `//`, `*` o `/*`,
así que no puede hacer desaparecer código ejecutable — y verificado: la única línea del
script que arranca con backtick (`:407`) sobrevive al filtro.

---

## 6. Daño colateral del fix-pack

- ✅ **`/usr/bin/git diff origin/main -- src/` → VACÍO.** Cero líneas de producción, ni de
  código ni de comentario.
- ✅ El diff total son **16 archivos**: 3 de la sonda + 6 artefactos SDD + 3 logs de evidencia
  + `package.json` (+1 script) + 2 README (`304 → 305`) + `_INDEX.md` (+1 fila).
- ✅ `package.json:16` agrega `probe:money-path` y **`package.json:11` no se movió** (T-12 lo
  ancla y está verde).
- ✅ Las **1.061 líneas** nuevas no desplazaron ninguna cita: los guardianes de
  `archivo:línea` del repo (`ownership-filter-guard`, `sdd-index-matches-folders`,
  `docs-referenced-by-code-exist`, `test-files-are-run-in-ci`) están en verde en la corrida
  completa de 305 archivos.
- ✅ Las 4 citas nuevas que sostienen B-2 **se verificaron una por una contra el árbol**:
  `src/middleware/a2a-key.ts:105-111` = el union de los 6 códigos ✅ · `:121` =
  `send({ error, error_code })` ✅ · `src/routes/compose.ts:1113` =
  `if (result.errorCode === 'SCOPE_DENIED')` ✅ · `src/types/index.ts:1269-1284` = la tabla
  normativa de `agentFailure` ✅ · `src/services/authz.ts` = **exactamente 4** causas de
  `SCOPE_DENIED` (`:30`, `:43`, `:56`, `:71`) ✅, emitidas en camel por
  `src/services/compose.ts:423`.
- ✅ Escala: 713 líneas de código (1,23x del presupuesto §15, techo 1156), con el desglose
  escrito y derivado en `auto-blindaje.md:240-265`. El excedente es +137 líneas de tests, y
  **cada caso nuevo tiene un mutante que lo pide** — verificado: quitando cualquiera de los
  4 testigos nuevos del YAML, entre 1 y 3 mutantes pasan a sobrevivir.

**Veredicto de la sección: OK.**

---

## 7. Las 11 categorías

| # | Categoría | Veredicto |
|---|---|---|
| 1 | **Security** | **OK** — sin secrets en código; la credencial se lee en un sitio y se usa en uno; testigo estructural (T-13) con el límite de MNR-2; **cero inyección** de comando y **cero inyección de heredoc** medidas en 13 escenarios de shell; permisos del workflow mínimos (`contents: read`, `issues: write`) |
| 2 | **Error Handling** | **OK** — `exit 1` reservado a la excepción no manejada y **no se alcanzó en 4.860 combinaciones**; las dos consultas `gh` no pueden morir en silencio bajo `set -e` (D8 KILLED); `res.json().catch(() => null)` degrada a `body:null` y la fila 10/9 lo agarran |
| 3 | **Data Integrity** | **OK** — el único método no-GET es un POST y no se reintenta ante timeout (A2/A2b KILLED, T-14 cubre función *y* cableado); la sonda no escribe estado |
| 4 | **Performance** | **N/A** — dos llamadas HTTP por corrida, sin bucles ni almacenamiento. Los techos (15 s / 120 s) están documentados en `auto-blindaje.md:29-40` |
| 5 | **Integration** | **OK** — `steps:[{agent, input}]` concuerda con `ComposeStep.agent` (`src/types/index.ts`) y el 200 spreadea `ComposeResult` (`compose.ts:1270-1272`), así que `body.success` y `body.steps[0].output` existen; el `outputSchema` vivo declara `rate` y `netDeliveredLocal` (medido hoy) ⇒ `PASS` es alcanzable |
| 6 | **Type Safety** | **N/A** — `.mjs` sin tipos; `tsconfig.json` sólo incluye `src/**/*`, así que ni `tsc` ni `biome` miran estos archivos. Sus invariantes se validan en runtime por la suite |
| 7 | **Test Coverage** | **MENOR** — 35/45 mutantes muertos, pero **7 de 9 mutantes de atribución sobreviven** (MNR-1), más MNR-2 y MNR-3 |
| 8 | **Scope Drift** | **OK** — los 16 archivos están en el Scope IN de `story-file.md:47-60`; `src/` intacto |
| 9 | **Destructive Migrations** | **N/A** — la HU no toca SQL, schema ni datos |
| 10 | **RPC con SECURITY DEFINER** | **N/A** — no hay funciones de base de datos |
| 11 | **Cache Invalidation** | **N/A** — sin cache. El único estado entre corridas es el issue de GitHub, y su ciclo abrir/comentar/cerrar se midió en §4.2-4.3 |

---

## 8. Hallazgos

### 🟡 MNR-1 — La lección del propio fix-pack quedó aplicada a una sola fila

- **Categoría**: Test Coverage
- **Archivo:línea**: `test/probe-money-path.test.mjs:167-174` (tabla T-5) y `:317-356` (T-15);
  contrato incumplido de testigo: `doc/sdd/227-sonda-del-money-path/story-file.md:205-217` (§5)
- **Qué**: §5 fija el prefijo del mensaje **fila por fila**, y sólo las filas 0 y 2-bis lo
  tienen anclado. Los 20 casos de T-5 asierten `klass` + `exit` + `startsWith(klass+':')`,
  que un mensaje degradado sigue satisfaciendo.
- **Reproducción**: aplicar cualquiera de E2–E7/E9 (§2). El más elocuente, E9:
  ```
  - 'DOWN: candidata a caída real — no hay campo estructurado que atribuya la causa'
  + 'DOWN: producción está caída'
  ```
  → `47 passed (47)`, exit 0.
- **Impacto**: la sonda podría dar el exit code correcto por la razón equivocada, y la razón
  es lo que se pega en el issue — el producto entero de la HU (§9 del Story File). Hoy los
  mensajes son correctos: es deuda de testigo, no defecto.
- **Sugerencia**: agregar a la tabla T-5 una cuarta columna con un fragmento obligatorio del
  mensaje por fila (`toContain`), tomado de §5. Es una columna en la tabla que ya existe.

### 🟡 MNR-2 — El testigo de la credencial es estructural, y la afirmación es más fuerte que él

- **Categoría**: Security / Test Coverage
- **Archivo:línea**: `test/probe-money-path.test.mjs:446-461` (T-13);
  `auto-blindaje.md:170-181` («la credencial no puede llegar a stdout»)
- **Reproducción** (mutante A1b): en `scripts/probe-money-path.mjs:84` agregar
  `globalThis.__k = key;` y en `:406` imprimir `k=${globalThis.__k}` ⇒ **`47 passed (47)`**.
- **Impacto**: en un repo PÚBLICO, una edición futura que pase el valor por una variable
  intermedia publica la key sin poner nada en rojo. Los mutantes *directos* sí mueren.
- **Sugerencia**: un test de comportamiento — correr `main()` con `A2A_PROBE_KEY` sentinel y
  `fetch` doblado, capturar stdout+stderr, y afirmar que el sentinel no aparece. Cierra la
  clase entera en vez de dos grafías. La afirmación del `auto-blindaje` debería decir *«no
  puede llegar por ninguna de las dos vías nombradas»* mientras el test sea estructural.

### 🟡 MNR-3 — La guarda nueva del self-test no distingue `in` de truthiness

- **Categoría**: Test Coverage
- **Archivo:línea**: `scripts/probe-money-path.mjs:380`
- **Reproducción** (mutante C3): `obs.selfTestFieldPresent = obs.selfTestField in input` →
  `Boolean(input[obs.selfTestField])` ⇒ **`47 passed (47)`**.
- **Impacto**: nulo hoy (`amountUsd` deriva a 25). Con un `minimum: 0` en el schema el valor
  derivado sería `0` y la variante daría el CONFIG «el campo no estaba» sobre un campo que
  sí estaba. El código de HEAD es el correcto; lo que falta es el testigo.
- **Sugerencia**: un caso más en T-15 con un schema cuyo campo requerido derive a `0`.

### 🟡 MNR-4 — El techo diario subió y el piso mensual se declaró «sin cambios»

- **Categoría**: Integration / documentación operativa
- **Archivo:línea**: `auto-blindaje.md:166-168` y `:220-221`;
  `.github/workflows/probe-money-path.yml:14-17`
- **Qué**: el mismo párrafo que habilita *«~18 corridas de PR por día»* afirma que *«el
  presupuesto mensual (≥ 44 USDC / 30 días) no cambia»*. La aritmética: 44 USDC es el piso de
  **sólo el reloj** (48 × 0,0303 × 30 = 43,63). Si las 18 corridas de PR/día se usaran, el
  techo mensual real sube a 30 × 2,00 = **60 USDC**, y con 44 la key se queda sin saldo antes
  de fin de mes ⇒ `INSUFFICIENT_BUDGET` ⇒ CONFIG/3 ⇒ job rojo cada 30 min.
- **Impacto**: el `≥` mantiene la frase técnicamente cierta, pero el ítem del checklist que
  el founder va a ejecutar (`:220`) dice `≥ 44` a secas. La sonda lo reportaría bien (CONFIG,
  no caída), así que el daño es ruido, no una mentira de la sonda.
- **Sugerencia**: escribir los dos números en el checklist — *«44 USDC cubre sólo el reloj;
  cada corrida de PR suma 0,0303 y el techo diario de 2,00 permite hasta 18»*.

### 🟡 MNR-5 — La evidencia de AC-4 no está anclada al árbol entregado

- **Categoría**: Test Coverage / Done Definition
- **Archivo:línea**: `doc/sdd/227-sonda-del-money-path/evidence/D-1-post-fixpack.log:4`
- **Qué**: la cabecera dice `HEAD: 8865721 (fix-pack todavia sin commitear al correrlo)`. El
  árbol entregado es **`3d83c03`**. La declaración es honesta, pero AC-4 pide *«la sonda
  demostrada en ROJO, con el log archivado»* y el log archivado no nombra el commit entregado.
- **Reproducción**: `A2A_PROBE_KEY=<inválida> npm run probe:money-path` sobre `3d83c03`
  cuesta **0 USDC** y da lo mismo — lo re-corrí en este AR:
  `CONFIG: la credencial de la sonda (KEY_NOT_FOUND) … schemaSha256=ee87a63f8e71 omitted=[destCountry] httpStatus=403`, exit 3.
- **Impacto**: bajo. Es una línea de cabecera.
- **Sugerencia**: re-correr D-1 sobre el commit final y actualizar la cabecera, o anotar en el
  log que el AR-it2 lo re-midió sobre `3d83c03` con salida idéntica.

---

## 9. Lo que se midió y **no** es hallazgo

- **B5** (`is2xx &&` de la fila 11 sin testigo) — mutante **equivalente**: la fila 9 (`:293`)
  ya cubre todo `c.status` no-2xx. Redundancia sana.
- **`.replace('( ', '(')`** de la fila 10 — ya declarado como CR/MNR-4 en
  `auto-blindaje.md:234`, con su razón. No se duplica.
- **`schemaSha256` sólo cubre el `inputSchema`** — ya declarado como AR/MNR-3 (`:235`).
- **200 con cuerpo ilegible ⇒ DRIFT** — ya declarado como AR/MNR-5 (`:236`).
- **La fila 4 extiende §5 con `SCOPE_DENIED`** — desviación deliberada del Story File,
  documentada y **correcta**: `src/services/compose.ts:423` emite ese código en camel.
- **`DEST_CAP_EXCEEDED` ⇒ 402 ⇒ fila 5** con el mensaje «la credencial no fue aceptada (402)»
  — la clase (CONFIG) y el exit (3) son los correctos; el matiz de la prosa es de la fila 5,
  que es anterior al fix-pack.
- **La precondición de merge** (`A2A_PROBE_KEY` ausente) — **medida por el orquestador**, no
  re-medida acá. `auto-blindaje.md:200-224` la declara con la honestidad correcta.

---

## 10. Veredicto

# ✅ APROBADO con MENORes

**0 BLOQUEANTES.** Los 6 arreglos declarados (B-1 … B-6) y los 4 MENORes (M-1 … M-4) están
implementados y **cada uno tiene al menos un mutante que muere**:

| Arreglo | Testigo que lo mata |
|---|---|
| B-1 `PASS` inalcanzable por omisión | B1, B2, B3, B4, B6, B7 + 4.860 combinaciones sin un solo `exit 0` espurio |
| B-2 las dos grafías del 403 | B8, B9, B10, B11 |
| B-3 la línea de clase llega al issue | D1–D6, D8 + 13 escenarios de shell ejecutados |
| B-4 `selfTestFieldPresent` | C1, C2 |
| B-5 `paths:` y las dos frases del fork | D7 + lectura en vivo del `SKIP:` |
| B-6 la credencial no se imprime | A1 (el mutante del AR-it1, reaplicado) |
| M-1 `sinComentariosJs` | los tres guardianes corren sobre `SCRIPT_CODE` y el docblock ya explica `destCountry` |
| M-2 `isRetryable` y su cableado | A2, A2b |
| M-3 fila 0-bis | C4, C5 |
| M-4 las dos `gh issue list` dentro de `if !` | D8 + T3/U3 ejecutados |

Los 5 MENORes son **deuda de testigo y de prosa operativa**, no defectos: ninguna afirmación
de la HU es falsa en HEAD y la sonda no puede mentir con las entradas medidas. **No bloquean
el gate.** Si el orquestador quiere cerrarlos, MNR-1 es el único que vale una ronda —una
columna más en una tabla que ya existe— y MNR-5 es gratis.

⛔ **Sigue en pie la precondición de merge**, que no es un hallazgo de este AR sino un
bloqueante de founder: `A2A_PROBE_KEY` no existe como repo secret. Sin ella el `cron` produce
48 corridas rojas por día. Ver `auto-blindaje.md:200-224`.
