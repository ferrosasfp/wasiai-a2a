# Code Review (CR) — WKH-322

| Campo | Valor |
|---|---|
| HU | WKH-322 — `/discover` deja de descartar parámetros en silencio |
| Rama | `feat/217-wkh-322-discover-reputation-param-naming` (4 commits sobre `main`) |
| Rol | Adversary · **CR = calidad / patrones** (el ataque va en `ar-report.md`, corriendo en paralelo) |
| Fecha | 2026-08-04 |
| Veredicto | **APROBADO CON MENORES** (0 bloqueantes, 4 MENORes) |

**Alcance de este CR**: calidad, patrones, prosa, disciplina de test y adherencia al
contrato (`story-WKH-322.md`). Security / integridad / bypass **no** se cubren acá:
son del AR paralelo. Cuando un hallazgo mío toca la frontera, lo digo y lo derivo.

Base ya verificada por el orquestador, **no re-corrida**: `npx tsc --noEmit` exit 0,
`npm test` 4976 verdes, lint limpio, 17 mutantes muertos.

---

## 0. Lo que verifiqué yo mismo (no lo tomé del Dev)

| Afirmación del Dev | Cómo la medí | Resultado |
|---|---|---|
| «+50 tests» | `git show main:<file>` vs `HEAD` + conteo de `it(` / `it.each(` | **Exacto: 50.** 22 `it` nuevos + 2 `it.each` × 10 = 42 de ruta, + 8 `T-U*` = 50 |
| Los 2 archivos de test corren verdes | `npx vitest run` sobre los dos archivos | `PASS (100) FAIL (0)`, 0 `.skip` / `.only` / `.todo` |
| «formateé con biome sólo los 3 archivos tocados» | `./node_modules/.bin/biome check src/` | `Checked 441 files. No fixes applied.` — sin reformateos ajenos |
| «cero cambios en discovery.ts / capability-resolver.ts / compose.ts / compose-step-shape.ts / _INDEX.md / _INDEX-row.md» | `git diff --name-only main..HEAD` | **Confirmado**: 9 archivos, ninguno de esos |
| `discovery-query.ts` aditivo puro (W0, criterio 3) | `git diff --numstat` | `166 0` — **cero deleciones** |
| Los 17 deletes de `discover.ts` son semánticos | lectura línea a línea del hunk | firma del helper + 2 call-sites viejos. **Cero ruido de formato** |
| M11 «era M5 disfrazado» | ver §4.3 | **Documentado y correcto**, verificado por razonamiento sobre el set de tests |
| `npm run qa` no existe | `package.json.scripts` | Confirmado: `lint`, `test`, `test:coverage`, `build`… **no hay `qa`** |

⚠️ Nota de método: el proxy de CLI me devolvió `Lint: 2 errors` para un `npx biome check`
que corriendo el binario local da limpio. **No creerle al proxy en verificaciones de
gate**; corrí todo por `./node_modules/.bin/`.

---

## 1. Adherencia al Story File y a las CDs — **OK**

| CD | Qué exige | Evidencia |
|---|---|---|
| CD-1 | No tocar `/compose` / `capability-resolver.ts` | `git diff --name-only`: ninguno aparece |
| CD-2 | `parseMinReputation` único validador para los dos nombres | `discovery-query.ts:309-310` — las dos ramas entran por la misma función |
| CD-3 | Sin queries/RPC nuevas | El guard es `Object.keys(...).find(...)`, in-process (`discovery-query.ts:284-287`) |
| CD-4 | No tocar `applyReputationFloor` / carril de estreno | `src/services/discovery.ts` sin diff |
| CD-5 🔒 | Prohibido `schema` + `additionalProperties:false` | No hay `schema:` en `discover.ts`; verifiqué además que `src/index.ts` no registra `ajv` ni `querystringParser` ⇒ la premisa de CD-5 sigue siendo cierta |
| CD-6 | GET y POST por el MISMO helper, cada test con gemelo POST | `discover.ts:216` y `:270` llaman a `parseFiltersOr400`; 11 pares `T-R*`/`T-R*b` |
| CD-7 | Sin sinónimos más allá de `min_reputation`, sin fuzzy match | `ALLOWED_DISCOVER_PARAMS` = 10 claves exactas (`discovery-query.ts:187-198`), sin distancia de edición |
| CD-8 | `INTEGRATION.md` en el mismo merge | `doc/INTEGRATION.md` está en el diff de la rama (+40/-1) |
| CD-9 | Ninguna frase no falsable | Ver §5 — **1 MENOR** (MNR-1) |
| CD-10 | Ningún test deriva su expectativa de la constante que verifica | `T-R30`/`T-R30b` enumeran a mano (`discover.minreputation.test.ts:691-702`, `:716-727`); `T-U7` también (`:314-323`); sólo los NEGATIVOS leen la constante (`:553`). **Correcto en la dirección segura** |
| CD-11 | Grepear call-sites antes de cambiar la firma | 2 call-sites, ambos migrados; `parseFiltersOr400` no se exporta |
| CD-13 | Shape del error sin cambios | `discover.ts:98` sigue siendo `{ error, code }` |

**Scope**: los 8 archivos del Scope IN (§5 del story) y **ninguno más**. Los 3
`_INDEX*` y `GET /discover/:slug` (`discover.ts:309-330`) intactos ✓.

---

## 2. Fuente única de la lista blanca — **OK, con un MENOR de mantenibilidad**

Pregunta 3 del encargo, respondida con evidencia:

- **Hay una sola lista en runtime**: `ALLOWED_DISCOVER_PARAMS`
  (`src/lib/discovery-query.ts:187-198`). La consumen **desde el mismo lugar**
  `assertKnownDiscoverParams` (`:285`) y el constructor del mensaje de error (`:225`),
  y la ruta la alcanza por un único punto: `parseFiltersOr400`
  (`discover.ts:73`), invocado por GET (`:216`) y POST (`:270`). **No encontré una
  segunda copia** en `src/`, `scripts/` ni `packages/`.
- **Los tests no se comparan con la constante donde eso sería trampa**: los positivos
  (`T-R30`, `T-R30b`, `T-U7`) escriben los 10 nombres a mano; el único que la importa
  es `T-R27` (`discover.minreputation.test.ts:553`), y ahí la usa como **precondición
  negativa** (`expect(ALLOWED.has('bogusparam')).toBe(false)`), que es el sentido seguro.
  El auto-blindaje documenta que la primera versión de `T-U7` sí iteraba la constante y
  se corrigió (`auto-blindaje.md:20-33`). Esto es exactamente lo que CD-10 pedía.
- **Lo que sí hay son 3 listas que nadie ata mecánicamente** → `MNR-3`.

---

## 3. Los 4 call-sites — **OK, y el benchmark ahora mide dos cosas distintas**

| Call-site | Estado |
|---|---|
| `src/__tests__/e2e/e2e.test.ts:278` | `{ q: 'test' }` ✓ (sigue afirmando 200 en `:280`) |
| `scripts/perf-bench.mjs:11` | `{ q: '', limit: 10 }` ✓ |
| `scripts/perf-bench.mjs:12` | `{ q: 'price', limit: 5 }` ✓ |
| `scripts/k6-load-test.js:127` | `{ capabilities: ['defi'], q: 'oracle', limit: 3 }` ✓ |

Ninguno quedó a medias: `grep "query:"` sobre esos archivos no devuelve nada dentro de
un body de `/discover`.

**¿Los dos escenarios de `perf-bench` miden ahora cosas distintas? Sí, verificado en
el código, no asumido:**

- `q: ''` → `discover.ts:291` produce `query: ''` → `discovery.ts:447` (`if (query.query)`)
  es **falso** ⇒ no filtra, y `discovery.ts:1062` **no** manda `queryParam` upstream.
  El escenario *"empty query"* mide de verdad una búsqueda sin filtrar.
- `q: 'price'` → las dos ramas anteriores se **activan** (filtro local + parámetro
  upstream), y además habilita la puerta de broaden-retry de `discovery.ts:323`
  (`total === 0 && query.query`).

⇒ *"filter category"* pasa a ejercitar **tres caminos** que antes no tocaba. Esto
refuerza (no debilita) la instrucción del story §6 W1.6: los números históricos no son
comparables, y ahora hay una razón concreta y verificable para decirlo. Ver `MNR-4`
sobre dónde tiene que quedar escrita esa nota.

---

## 4. Calidad de los tests — **OK** (los 50 son distintos; 1 hueco → MNR-2)

### 4.1 ¿50 tests o conteo inflado? — **50 reales**

`main` → `HEAD`: `discover.minreputation.test.ts` 21 → 43 `it` + 2 `it.each`;
`discovery-query.test.ts` 18 → 26 `it`. Son **42 + 8 = 50 casos de vitest**, no 50
`expect`. El número es honesto.

### 4.2 Los gemelos `b`/`c`: ¿prueban algo que el GET no prueba?

Sí, y el argumento no es "por simetría estética": GET y POST comparten el helper pero
**no el cableado**. Un mutante que revierta el POST a los tres campos elegidos a mano
(el bug original, `discover.ts` en `main`) deja **verdes** todos los `T-R*` de GET y mata
`T-R24b`, `T-R26b`, `T-R27b`, `T-R31b`, `T-R32b`, `T-R34b`. Los gemelos son la única red
que cubre ese cableado, y CD-6 los exige por escrito.

Además, varios gemelos ejercitan un **tipo distinto**, no sólo otro verbo:
- `T-R24b` (`:464`) manda `min_reputation: 2` como **number**; el GET manda `'2'` string.
- `T-R28b` (`:588`) compara conflicto **number vs number**; `T-R28` compara strings.
- `T-R28c` (`:600`) **no es un gemelo**: es el único caso que prueba la rama "mismo valor
  escrito distinto (`5` vs `5.0`) NO es conflicto" a nivel de ruta.

Redundancia real que sí existe, y la declaro para que nadie la descubra después como
si fuera un hallazgo: contra el mutante "POST sin cablear", **cualquiera** de esos seis
gemelos alcanza; los otros cinco no agregan poder discriminante. Es redundancia
**mandada por CD-6**, no invento del Dev ⇒ **no la cuento como finding**.

### 4.3 El `it.each` de 10 casos: ¿los 10 discriminan?

**Sí, uno por clave.** Cada caso es la única cobertura de su nombre: sacar `maxPrice`
de `ALLOWED_DISCOVER_PARAMS` deja verde a los otros 9 y pone en rojo exactamente
`T-R30 (maxPrice)` y `T-R30b (maxPrice)`. No hay dos casos que mueran juntos por la
misma causa. Y los 10 nombres están escritos a mano en dos arrays literales
(`:691-702`, `:716-727`), tomados del doc y de las firmas de la ruta, no de la constante
(CD-10 / §7.3 del story).

El aserto es flojo a propósito (`statusCode === 200` + `toHaveBeenCalled()`), y es lo
que corresponde: AC-5 afirma "el parámetro es público", no "el parámetro filtra". El
efecto de cada valor está candado en otro lado (`T-R22`, `T-R24`, `T-R11`, `T-R14`…).
**No es un aserto vago: es el aserto exacto de la afirmación nueva del doc**
(`INTEGRATION.md:259-260`, *"The same names work in the query string (GET) and in the
JSON body (POST)"*) — que es precisamente lo que `T-R30b` compra.

### 4.4 El mutante M11 — la distinción está documentada y es correcta

`auto-blindaje.md:35-49` lo dice con todas las letras: el M11 original se escribió
**borrando** `assertKnownDiscoverParams` y murió *"con los mismos 8 tests"* que el
mutante "guard ausente" ⇒ era el mismo mutante dos veces. Se rehizo como **reorden
real** (valores primero, claves después) y mata **exactamente 2**.

**Verifiqué esa cifra**, no la acepté: el reorden sólo cambia la respuesta cuando la
request trae a la vez una clave desconocida **y** un valor inválido. Recorrí los 42
tests de ruta: la única entrada con esa combinación es
`?capability=x&minReputation=abc` (`T-R31`, `:749`) y su gemelo (`T-R31b`, `:760`).
`T-R26`/`T-R27`/`T-R34` traen clave mala con valores válidos; `T-R33`/`T-R28` traen
valores malos con claves conocidas. ⇒ **mueren exactamente 2, y `T-R31` es realmente
el test que pina el orden** — no hereda su rojo de otro.

La lección quedó además escrita como regla general (*"si dos mutantes matan el mismo
conjunto de tests, sospechá que son el mismo mutante"*, `auto-blindaje.md:47-49`), que
es la forma útil de guardarla.

### 4.5 `T-U8` y el docstring falsable — **OK**

- El docstring (`discovery-query.ts:276-281`) promete **determinismo** y **niega**
  explícitamente "la primera clave que escribió el caller", con el contraejemplo
  `?1=a&capability=b` → reporta `'1'`.
- **Ejecuté el contraejemplo**: `Object.keys({capability:'b', 1:'a'})` → `["1","capability"]`.
  El docstring es **verdadero y falsable**, y el mensaje real (`:224`) no promete nada
  sobre orden: sólo nombra la clave y enumera las aceptadas.
- `T-U8` (`discovery-query.test.ts:325-334`) escribe `capability` **primero** en el
  literal y afirma `received === '1'`. Cualquier implementación que honre "la primera
  que escribió el caller" (p. ej. leer el querystring crudo en orden) lo pone en rojo.
  `Object.keys().sort()` — la otra tentación, prohibida por el story `:403` — **no** lo
  mataría, pero tampoco cambia el resultado observable de este input.
- Límite honesto, para que nadie lea de más: `T-U8` canda **el comportamiento**, no el
  texto. Si alguien reescribe la promesa en el comentario **sin tocar el código**,
  ningún test se pone rojo. Eso es intrínseco a los comentarios y no es un defecto del
  Dev; lo anoto porque es la pregunta que hizo el encargo.

---

## 5. Prosa honesta (CD-9) — **1 MENOR**

**La cita del precedente está y es fiel.** `discovery-query.ts:209-214` cita
`compose-step-shape.ts:176-185` y reproduce textual *"Decirle que no se soporta es
honesto; ignorarlo, no."*. Fui a leerlo: la frase está literal en
`compose-step-shape.ts:175` y el chequeo que justifica está en `:176-185`. La lectura
que agrega el Dev (*"la superficie que COBRA era estricta y la GRATUITA era permisiva"*)
es una interpretación **suya**, marcada como tal y verificable.

Otras citas nuevas, todas verificadas una por una:
- `compose-step-shape.ts:51` (`min_reputation` en `constraints`) → **existe**, línea 51 exacta.
- `compose-step-shape.ts:39-48` como modelo del docstring de la allowlist → **correcto**
  (es el bloque JSDoc de `ALLOWED_STEP_CONSTRAINTS`).
- *"el mismo criterio con que `capability-resolver.ts` ordena los motivos de su 422"*
  (`discover.ts:58-59`) → **fiel**: `capability-resolver.ts:136-185` ordena scope →
  `standingUnavailable` → reputación, con el motivo escrito.
- El alcance del guard está **acotado en el propio texto** (`discovery-query.ts:216-218`
  y `discover.ts:148-151`): dice que NO cubre `GET /discover/:slug`. Eso es exactamente
  lo que pedía el story `:358-360` para no apagar la próxima revisión.

Lo único que afirma de más es `MNR-1`.

---

## 6. Deuda declarada — **1 MENOR** (dónde vive, no si existe)

- **TD-322-1** está donde alguien la va a ver: **en el código**, dos veces
  (`discover.ts:151`, `discovery-query.ts:218`), justo al lado del guard cuyo alcance
  limita. Correcto.
- **TD-322-2** y **TD-322-3** viven **sólo** en `sdd.md:570-572`… y ese archivo **no
  está trackeado en git** ⇒ `MNR-4`.

---

## Findings

### `MNR-1` — el docstring dice "alfabético" y el orden declarado no lo es
- **Categoría**: prosa falsable (CD-9)
- **Archivo:línea**: `src/lib/discovery-query.ts:171-173` (afirmación) vs `:193-194` (orden real)
- **Qué dice**: *"El orden de declaración es alfabético (case-insensitive) porque el
  mensaje del 400 se construye uniendo este Set…"*
- **Reproducción** (ejecutada):
  ```
  node -e "const a=['allowTrial','capabilities','includeInactive','limit','maxPrice',
  'minReputation','min_reputation','q','registry','verified'];
  console.log([...a].sort((x,y)=>x.toLowerCase()<y.toLowerCase()?-1:1).join(','))"
  → …maxPrice,min_reputation,minReputation,q…      (ASCII case-insensitive)
  ```
  Con `localeCompare(…,{sensitivity:'base'})` da lo mismo: `min_reputation` **antes** que
  `minReputation`, porque `'_'` (0x5F) < `'r'` (0x72). El orden declarado es el inverso.
- **Impacto**: nulo en runtime (el orden es fijo, estable y el mensaje es determinista).
  El daño es de credibilidad: es una frase de una línea que un `sort()` desmiente, en el
  docstring de la constante que esta HU convierte en contrato público, y en una HU cuya
  CD-9 pide justamente que cada frase sea falsable **y verdadera**.
- **Origen, para que el fix sea de una línea y no un debate**: el orden lo **mandó el
  story** (`story-WKH-322.md:325-330`, y el formato exacto del mensaje en `:383-385`),
  que también lo llama "alfabético". El **orden no se toca** — cambiarlo cambiaría el
  mensaje que el doc publica.
- **Sugerencia**: reemplazar la justificación por una verdadera, del tipo *"orden fijo,
  el del contrato de W0.3 — el mensaje del 400 se construye uniendo este Set en orden de
  inserción, así que reordenar acá cambia el mensaje que ve el caller"*. Sin la palabra
  "alfabético", o con un "aproximadamente alfabético (`minReputation` antes que
  `min_reputation`, contra el orden de `sort()`)".

### `MNR-2` — la mitad "primitivo" de la guarda de body no la prueba nadie
- **Categoría**: cobertura de test / mutante sobreviviente
- **Archivo:línea**: guarda en `src/routes/discover.ts:33`
  (`typeof raw !== 'object' || Array.isArray(raw)`); único test en
  `src/routes/discover.minreputation.test.ts:767-778` (`T-R32`), que sólo manda `[1,2]`.
- **Mutante que sobrevive**: cambiar `:33` por `if (Array.isArray(raw))`. Los 50 tests
  nuevos siguen verdes.
- **Reproducción** (comportamiento derivado del código, con las primitivas medidas en node):
  | Body | Hoy | Con el mutante |
  |---|---|---|
  | `5` / `true` | 400 `INVALID_DISCOVER_BODY` | `Object.keys(5)` → `[]` ⇒ **200 con el catálogo entero** |
  | `"ab"` | 400 `INVALID_DISCOVER_BODY` | `Object.keys('ab')` → `["0","1"]` ⇒ 400 `unknown parameter '0'` |

  (`node -e "console.log(JSON.stringify(Object.keys(5)), JSON.stringify(Object.keys('ab')))"`
  → `[] ["0","1"]`.)
- **Impacto**: el 200 silencioso es **exactamente la clase de bug que esta HU existe
  para matar**, y el `'0'` es exactamente el mensaje que DT-9 existe para evitar. Además
  `doc/INTEGRATION.md:762` ya **publica** el comportamiento para primitivos (*"the body is
  an array **or a primitive**"*), o sea que hay una promesa pública sin test detrás.
- **Sugerencia**: sumar un gemelo de `T-R32` con `payload: 5` (o `'"ab"'` con
  `content-type: application/json`) que afirme `code === 'INVALID_DISCOVER_BODY'`. Un
  solo caso cubre la rama y el mensaje.

### `MNR-3` — tres listas de parámetros y ninguna atada a las otras
- **Categoría**: mantenibilidad
- **Archivo:línea**: `src/lib/discovery-query.ts:187-198` (runtime),
  `src/routes/discover.ts:196-208` (tipo `Querystring`), `:249-261` (tipo `Body`).
- **Asimetría del modo de falla**:
  - agregar la clave al **tipo** y olvidarla en el Set ⇒ 400 ruidoso ⇒ se descubre solo;
  - agregarla al **Set** y olvidarse del resto ⇒ la ruta la acepta y **nadie la lee** ⇒
    200 sin efecto: **la clase de bug de esta HU, reintroducida por la puerta de atrás**.
- **Por qué no lo cubre nada**: `T-R30` enumera a mano **a propósito** (CD-10), así que
  una clave nueva en el Set no rompe ningún test; y no hay chequeo de tipos que ligue
  `ALLOWED_DISCOVER_PARAMS` con `keyof Querystring`.
- **Impacto**: bajo hoy (10 claves, docstring que advierte que agregar una es decisión de
  producto, `discovery-query.ts:167-169`), y crece con cada parámetro futuro.
- **Sugerencia**: un candado **de tipos**, no un test (un test que derive de la constante
  violaría CD-10). Por ejemplo, en la ruta, un
  `const _paramsAreDeclared: Record<Extract<keyof Querystring, string>, true>` alimentado
  a mano, o un `satisfies` que obligue a que el Set y el tipo tengan el mismo dominio.
  Alternativa mínima y aceptable: una línea en el docstring del Set que diga que agregar
  una clave obliga a tocar los dos tipos de `discover.ts` y la tabla de `INTEGRATION.md`.

### `MNR-4` — el contrato que justifica el 400 no está en git
- **Categoría**: trazabilidad / deuda declarada que se puede perder
- **Reproducción**:
  ```
  git ls-files doc/sdd/217-wkh-322-discover-min-reputation-param-naming/
  → doc/sdd/217-.../auto-blindaje.md      ← el único trackeado
  git status --porcelain doc/sdd/217-.../
  → ?? _INDEX-row.md   ?? sdd.md   ?? story-WKH-322.md   ?? work-item.md
  git check-ignore -v doc/sdd/217-.../sdd.md   → exit 1 (no está ignorado)
  ```
- **Contraste con la convención del propio repo** (no es una preferencia mía):
  `git ls-files doc/sdd/215*/` y `doc/sdd/211*/` devuelven `work-item.md`, `sdd.md` y
  `story-HU-*.md` **trackeados** en las dos HUs comparables anteriores.
- **Impacto**: si esta rama mergea como está, a `main` llega un **400 nuevo en una
  superficie pública** sin el documento que lo justifica. Y se pierden, por ser los
  únicos lugares donde existen: **TD-322-2** y **TD-322-3** (`sdd.md:570-572`), el
  radio de impacto medido de §2.2, R-1/R-2 con dueño founder, y la nota de que los
  números históricos de `perf-bench.mjs` **no son comparables** (`story:550-553`).
  Un `git clean` en el worktree los borra sin dejar rastro.
- **Sugerencia**: `git add` de los 4 `.md` del directorio de la HU antes del merge (es
  bookkeeping, no código: no toca el diff de producción). Y, ya que el precedente
  existe (`doc/sdd/215-.../mutation-log.md`), dejar los 17 mutantes → tests en un
  `mutation-log.md`: hoy ese registro sólo vive en el transcript de la sesión, y la
  Done Definition (`story:805-806`) lo pide por escrito.

---

## 7. Las 4 desviaciones declaradas — juzgadas

| # | Desviación | Veredicto |
|---|---|---|
| 1 | `npm run qa` no existe; corrió el equivalente | **BIEN RESUELTO.** Confirmado: `package.json` no tiene `qa`. El equivalente que corrió (`npx tsc --noEmit` + `npm test` + `npm run lint`) es **literalmente** la Done Definition del story (`:801-803`). Declararlo en vez de inventar un script es lo correcto |
| 2 | `T-U7` / `T-U8` de más | **ACEPTADA, y son los dos que más valen.** `T-U7` es el que quedó después de corregir el test que se medía a sí mismo (`auto-blindaje.md:20-33`) y `T-U8` es el que canda el gotcha de `Object.keys` que el story anticipó en `:395-404`. Agregar tests que candan una trampa documentada no es scope creep |
| 3 | Sufijos `b`/`c` en vez de números nuevos | **ACEPTADA, y es la convención del repo**: `T-EV5b/c/d` (`reconciliation.test.ts:2060-2105`), `T-AC1a/b` (`discovery.test.ts:467-477`), `T-AC4a/b` (`llm/models.test.ts:103-126`). Además mantiene legible el mapa AC → test del story §7.1 |
| 4 | biome sólo sobre los 3 archivos tocados | **BIEN RESUELTA.** `biome check src/` da limpio sobre 441 archivos, así que no dejó deuda; y el diff no tiene una sola línea de reformateo ajeno. `npm run lint` es `biome check src/`, o sea que `scripts/*.mjs` ni siquiera entra al lint: no hay drift posible ahí |

---

## 8. Observaciones que NO son findings

Las dejo escritas para que nadie las "descubra" después como hallazgos.

1. **`T-R33` no tiene gemelo POST** y está bien: un body JSON no puede repetir una clave,
   así que el gemelo sería vacuo. (Un `{ minReputation: ['1','1'] }` sí sería un caso
   distinto, pero es el parseo preexistente de `parseMinReputation`, que CD-2 prohíbe tocar.)
2. **`InvalidDiscoverBodyError` es inalcanzable por GET**: `request.query` con el parser
   default de Fastify es siempre un objeto (verifiqué que `src/index.ts` no registra
   `querystringParser`). El mensaje habla de "request body", que es donde sí se alcanza.
   No es un bug; es una rama muerta en un verbo.
3. **`parseFiltersOr400` ya hace más que parsear filtros** (forma + claves + valores). El
   nombre quedó chico, pero renombrarlo hoy sólo agrega ruido al diff y el JSDoc
   (`discover.ts:48-59`) explica el alcance nuevo. No lo cuento como finding.
4. **`packages/agent-sdk/src/agent.ts:496-513`** manda exactamente `q, capabilities,
   maxPrice, minReputation, limit, registry, verified`: las 7 están en la lista blanca.
   El SDK propio **no se rompe** — lo verifiqué yo, no lo tomé del story.
5. **`min_reputation: [50]` en un body POST se acepta como 50** (`Number(['50'])` es 50).
   Es coerción preexistente de `parseMinReputation` y CD-2 la congela. **Se lo dejo al
   AR** por si lo considera superficie de ataque; desde calidad no es de esta HU.

---

## Veredicto

**APROBADO CON MENORES.**

- **BLOQUEANTES: 0.** No encontré nada que rompa un AC, que corra distinto de lo que
  dice el contrato, ni que deje una promesa pública sin implementación.
- **MENORes: 4** — `MNR-1` (prosa), `MNR-2` (test faltante), `MNR-3` (mantenibilidad),
  `MNR-4` (trazabilidad).

Ninguno bloquea el gate. Mi recomendación de orden, si el Dev los toma en esta misma
sesión: **`MNR-4` primero** (es un `git add`, y es lo único que se puede **perder**),
después `MNR-2` (un test, 10 líneas), después `MNR-1` (una frase) y `MNR-3` (una línea
de docstring o un candado de tipos, según cuánto quiera invertir).

Lo que quiero dejar dicho, porque es lo que más costó verificar y es lo que mejor está:
**la disciplina de mutación de esta HU es real**. El Dev encontró que su propio mutante
M11 era M5 disfrazado, lo escribió, lo rehízo, y la firma de muerte del mutante bueno
(exactamente `T-R31`/`T-R31b`) **la reverifiqué contra los 42 tests de ruta y da**. Eso
es lo contrario del antecedente de "verde aparente" de este repo.

