# AR-3 — WKH-322 · tercera pasada adversarial (post fix-pack 2)

**Persistido por el orquestador**: el agente de AR-3 no tenía herramienta de escritura.
Entregó el reporte en su mensaje; este archivo es esa entrega. No se usaron redirects de
shell (el proxy `rtk` corrompe el contenido en silencio con exit 0).

Árbol real intacto: mismo branch, mismo HEAD `000f424`, mismo `git status`. El sandbox de
mutación vivió fuera del repo y se borró.

## VEREDICTO: RECHAZADO (4 BLOQUEANTE-BAJO activos)

Los 2 `BLQ-MED` de AR-2 están **cerrados y verificados por mutación**. Los 10 call-sites
están **confirmados por búsqueda independiente** y no aparece un onceavo. Los 4 MENORes de
AR-2 están **cerrados**. Lo que rechaza es el **candado**: funciona para todo lo que hay hoy
en el repo, pero **declara una cobertura que no tiene**, y ese es exactamente el mecanismo
por el cual la próxima ronda va a dejar de buscar.

---

## Resumen

Reproduje lo que el Dev afirma y le da: revertir el `#9` (`smoke-test.sh:229`) o el `#10`
(`handlers.mjs:146`) pone `T-CS-2` en rojo con archivo:línea y clave; el barrido cuesta
182 ms sobre 783 archivos y `npm test` completo son 9,9 s con 4987 verdes; `tsc --noEmit` y
`biome check` limpios; la suite MCP 347/347. Mi búsqueda independiente da exactamente las 10
y ninguna clave fuera de la allowlist: **no hay onceavo**. La exención `expectsRejection`
suprime **12 hits, los 12 en el test del propio guard**: está acotada, no es un cajón.

Lo que rompe es la honestidad del candado. Planté 15 formas distintas de mandar un parámetro
a `/discover` en un directorio nuevo: cazó 5 formas + el `.md` publicado + el workflow de CI
+ el `Dockerfile` + el POST opaco, y **dejó pasar MUDAS 5 formas con clave literal y
estática**. Ninguna está en la sección "QUÉ NO CUBRE", que declara un único límite estático.

---

## `BLQ-BAJO-1` — `T-CS-2` no cumple lo que su docstring promete: 5 formas con clave **literal** pasan mudas

`src/__tests__/discover-callsites.test.ts:28-30` (la promesa), `:36-46` (los límites
declarados), contra `:107-120` (los extractores).

El docstring promete *"un call-site NUEVO, en cualquier archivo del repo"* y declara **un
solo** límite estático: claves construidas en runtime. Es falso.

| # | Forma plantada | Resultado |
|---|---|---|
| p01 | `` url.searchParams.set(`query`, x) `` | ✅ ROJO |
| p02 | `url.searchParams.set('que' + 'ry', x)` | ✅ ROJO (por accidente: captura `'que'`) |
| p03 | `const KEY='query'; params.set(KEY, x)` | ⚪ mudo — **límite declarado, honesto** |
| **p04** | `new URLSearchParams({ query: 'oracle', limit: '5' })` | 🔴 **MUDO** |
| **p05** | `new URLSearchParams([['query','oracle']])` | 🔴 **MUDO** |
| **p06** | `axios.get(url, { params: { query: 'oracle' } })` | 🔴 **MUDO** |
| p07 | POST con `JSON.stringify({ ...extraFilters, limit: 5 })` | 🔴 **VERDE** → `BLQ-BAJO-2` |
| p08 | helper `callDiscover({query})` con `set(k,v)` en otro archivo | ⚪ mudo (runtime, declarado) |
| p09 | `.md` publicado con `curl ".../discover?query=oracle"` | ✅ ROJO |
| p10 | `.md` publicado con `-d '{"query":"oracle"}'` | ✅ ROJO |
| — | `.github/workflows/probe-ci.yml` con curl | ✅ ROJO |
| — | `Dockerfile` (sin extensión) con `HEALTHCHECK curl` | ✅ ROJO |
| p11 | k6 `http.post(url, JSON.stringify({query,limit}))` | ✅ ROJO |
| **p12** | fixture `.json`: `{"body":{"query":"oracle"}}` | 🔴 **MUDO** (`BODY_ANCHOR_RE` exige `body` sin comillas) |
| **p13** | fixture `.yaml` con `body: {query: oracle}` | 🔴 **MUDO** |
| **p14** | `'/discover' + '?query=' + encodeURIComponent(t)` | 🔴 **MUDO** (`QS_RE` exige `?` pegado al path) |
| p15 | `body: JSON.stringify(filters)` con `filters` lejos | ✅ ROJO — `opaquePost` |

Tres límites del enumerador **no declarados**, de la misma corrida:
- `git ls-files` **no desciende a submódulos** (medido: `contracts/lib/**`, 2104 archivos invisibles);
- `readTextFile` (`:176-186`) descarta en **silencio** todo archivo > 2 MiB y todo binario, sin sumarlos a `filesScanned` ni reportarlos;
- `isForeignHost` (`:289-300`) sólo reconoce `localhost|127.0.0.1|wasiai|railway|vercel`: un call-site contra un gateway self-hosted en dominio propio se descarta como "registry federado ajeno".

**Impacto**: ninguna de estas formas existe hoy (`git grep URLSearchParams` = cero; `axios`
sólo dentro del regex del extractor). **No hay bug vivo.** El impacto es el que esta HU vino
a matar, reencarnado: "QUÉ NO CUBRE" está escrita para que un revisor futuro sepa qué sigue
teniendo que buscar a mano, y hoy le dice que la única grieta es runtime. Con esa frase,
AR-4 no busca `URLSearchParams`, y el onceavo entra por ahí.

---

## `BLQ-BAJO-2` — un `POST` cuyo body el extractor **no** sabe leer pasa VERDE, la negación exacta de `T-CS-3`

`:254-266` (`topLevelKeys` saltea el spread con `i += 1; // spread, etc.`) y `:465-474`
(`hasBody` se conforma con **cualquier** ancla de body cercana).

`T-CS-3` existe textualmente para esto (`:30-32`, `:563-568`): *"No sé qué manda este
call-site se reporta rojo a propósito"*. Pero `hasBody` es booleano: alcanza con leer **una**
clave del literal para declarar el body "leído".

Reproducción verificada:
```js
// p07-helper.mjs
export const extraFilters = { query: 'oracle' };
// p07-spread.mjs
await fetch(`${BASE}/discover`, {
  method: 'POST',
  body: JSON.stringify({ ...extraFilters, limit: 5 }),
});
```
→ **4 passed**. Un solo hit: `'limit' body JSON`. `opaquePosts` = `[]`. El `query` real que
sale por el cable no aparece ni como hit ni como rojo.

Contraste que aísla la causa: `body: JSON.stringify(filters)` (variable, sin literal) **sí**
entra en `opaquePosts` y pone `T-CS-3` en rojo.

**Impacto**: el único chequeo que dice "no sé ⇒ rojo" tiene un caso donde sabe a medias y
aplaude. Un `{...defaults, limit}` es idiomático; es más probable que aparezca que cualquiera
de las formas de `BLQ-BAJO-1`.

**Sugerencia**: que `topLevelKeys` señale la presencia de un spread (o de cualquier token no
resuelto) y que ese archivo:línea entre en `opaquePosts` aunque haya leído otras claves. La
distinción no es "¿leí algo?" sino "¿leí **todo**?".

---

## `BLQ-BAJO-3` — el barrido no ve archivos gitignoreados, y hoy hay **dos** que llaman a `/discover`

`:156-164` (`git ls-files -z --cached --others --exclude-standard`) contra `.gitignore:60-66`
y `.gitignore:197`.

```
$ git check-ignore -v scripts/smoke-base-downstream.mjs scripts/smoke-prod-via-app-wasiai.mjs
.gitignore:64:/scripts/smoke-base-downstream.mjs      scripts/smoke-base-downstream.mjs
.gitignore:197:/scripts/smoke-prod-via-app-wasiai.mjs scripts/smoke-prod-via-app-wasiai.mjs
```

- `scripts/smoke-base-downstream.mjs:116` → `body: { q: GOAL }` hacia `/discover`
- `scripts/smoke-prod-via-app-wasiai.mjs:85` → `/api/v1/capabilities?limit=20`

Los dos usan claves correctas **hoy** — verificado a mano, que es justamente el paso manual
que el mecanismo vino a eliminar. Y `smoke-base-downstream.mjs:116` **figura en el inventario
del AR-2**: un revisor humano contó como call-site un archivo que el guard automático es
estructuralmente incapaz de mirar.

Reproducción: cambiar `{ q: GOAL }` por `{ query: GOAL }` en ese archivo y correr `npm test`
→ **verde**.

El repo ya conoce esta clase con el signo invertido: `.gitignore:198-204` tiene una NOTA
explicando que `verify-rls-enabled.mjs` **no** puede ignorarse porque `actions/checkout` no
materializa ignorados.

---

## `BLQ-BAJO-4` — los tests que fijan el fix de `AR-2 BLQ-MED-2` **no corren en CI**

`mcp-servers/wasiai-x402/tests/tools.test.mjs:161-225` (`T-322-A`, `T-322-A2`, `T-322-B`) y
`tests/http.test.mjs:276-277`, contra `vitest.config.ts:5` y `.github/workflows/ci.yml:36-37`.

El fix de `BLQ-MED-2` son dos cosas: (a) `handlers.mjs:146` `query`→`q`, y (b)
`handlers.mjs:191-208`, el `if (!res.ok)` que impide devolver un 400 donde el agente espera
`{agents:[…]}`.

- (a) **sí** está protegido: revertirlo pone `T-CS-2` en rojo.
- (b) **no está protegido por nada**.

```
vitest.config.ts:5   include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'test/**/*.test.mjs']
.github/workflows/ci.yml:37   run: npm test        # → "vitest run"
$ grep -rn "mcp-servers" package.json .github/workflows/ test/
(cero resultados)
```

Borrar el bloque `if (!res.ok)` de `handlers.mjs` deja CI **verde**.

**Impacto**: el hallazgo que AR-2 clasificó `BLQ-MED` queda fijado por una suite huérfana. Es
el modo de falla que este repo ya documentó ("una suite ausente que nadie nota") y contra el
que ya escribió guardianes (`test/docs-referenced-by-code-exist.test.ts`,
`test/scripts-imported-by-tests-are-tracked.test.ts`). Preexistente como infraestructura,
pero **esta HU es la que puso ahí un test de regresión de un bloqueante** y lo dio por cubierto.

---

## MENORes

### `MNR-1` — `docs/api-reference.md:99` publica la escala equivocada de `minReputation`

```
| `minReputation` | number | Minimum reputation score `[0,1]`. |
```
El código valida `[0, 100]` (`discovery-query.ts:13-14`), y esta misma HU corrigió esa mentira
**dos veces** (JSDoc de la ruta y `doc/INTEGRATION.md`). Un integrador que lee
`api-reference.md` manda `minReputation=0.8` creyendo "80%" y obtiene un piso de 0,8/100, o
sea prácticamente ningún filtro, **en silencio y con 200**: la clase exacta de WKH-322, sobre
el valor en vez del nombre. La misma tabla omite `min_reputation` y `allowTrial`.

Preexistente en `main` y fuera del Scope IN declarado. Pero el docstring del mecanismo declara
que `docs/**` "SÍ se verifica" porque *"una doc que publique un parámetro inexistente es el
mismo bug de esta HU, escrito en prosa"*, y el barrido lo da por verificado mirando sólo las
**claves**.

### `MNR-2` — el entrecomillado del nombre en el 400 no está escapado

`discovery-query.ts:243-252` justifica las comillas para que la nota de truncado quede fuera.
La propiedad se cae con un `'` dentro del nombre, que el caller elige:

Input: clave `a'` + 80×`b`. Output: `unknown parameter 'a'.repeatbbbb…bbb' (truncated; …)`.
Un grep no puede delimitar el nombre. Cosmético (el JSON escapa bien, no hay inyección), pero
la frase del JSDoc afirma una propiedad que un input concreto falsifica.

---

## Verificaciones que PASARON

**Los 10 call-sites — búsqueda independiente.** Universo de claves de todas las query strings
literales del repo contra los dos endpoints:
```
allowTrial capabilities limit maxPrice minReputation min_reputation q registry verified
bogusparam capability query   ← los 3 sólo en discover.minreputation.test.ts: es el test del guard
```
`git grep URLSearchParams` = cero; `axios` = sólo dentro del regex; spread hacia `/discover` =
cero; `body: <identificador>` = cero; los dos gitignoreados revisados a mano;
`src/mcp/tools/discover-agents.ts:34` llama `discoveryService.discover()` in-process (el campo
interno se llama `query` y ahí es correcto); `docs/mcp-integration.md:195,337` documenta el
**input de la tool**, no el cable. **Son 10, están los 10, no hay onceavo.**

**Mutación de los 2 bloqueantes de AR-2** (revirtiendo ambos):
```
FAIL  T-CS-2
  mcp-servers/wasiai-x402/src/handlers.mjs:146  clave 'query' (searchParams)
  scripts/smoke-test.sh:229                     clave 'query' (body JSON)
```

**La exención `expectsRejection` no es un cajón**: 12 supresiones, las 12 en
`discover.minreputation.test.ts`, todas casos donde mandar la clave mala **es** el punto del
test. Cero en producción.

**AR-2 MNR-1 a MNR-4 — los 4 cerrados.** El corte UTF-16 probado con 11 entradas (par
suplente no se parte; `<=` no trunca en exactamente 64; anuncia "UTF-16 code units", no
"characters"). El conteo quedó en 10 en las 6 apariciones del Story File, cero residuos de
4/6/8, y el comentario de `T-R34` quedó **sin número** con la razón escrita.

**`TD-322-4` bien acotada**, con medición, archivo:línea, la asimetría GET/POST y criterio de
cierre. Dice explícitamente qué sí hizo la HU: sacar del JSDoc la frase que la daba por
resuelta.

**`BLQ-ALTO-1` sigue afuera**: `ALLOWED_DISCOVER_PARAMS` = las mismas 10 claves, cero
`category`, cero `cursor`, cero banderas nuevas, `wasiai-v2` fuera del diff.

**Performance medida**: `discover-callsites.test.ts` 182 ms sobre 783 archivos leídos (1680
enumerados); `npm test` completo 9,93 s, 243 files, 4987 pass. Nadie lo va a saltear por costo.

**Prosa**: barrí `doc/INTEGRATION.md` (+45 líneas) y los JSDoc nuevos buscando frases no
falsables. Encontré **dos** (las de `BLQ-BAJO-1` y `MNR-2`); las demás resisten un input
concreto. El nivel de honestidad de esta HU es alto; por eso las dos excepciones importan.

## Categorías

| # | Categoría | Veredicto |
|---|---|---|
| 1 | Security | **OK**. `received` no viaja al caller; amplificación acotada (clave de 100.000 → mensaje de 276); `?__proto__=x` da 400, el guard endurece |
| 2 | Error Handling | **OK**. Los 3 smokes leen `.text()` → status → `JSON.parse` |
| 3 | Data Integrity | **N/A**. `/discover` es lectura |
| 4 | Performance | **OK** (medido, no estimado) |
| 5 | Integration | **OK con nota**. Contrato MCP publicado intacto; SDK sin ruptura; fanout federado usa `queryParam='q'` de la config sembrada |
| 6 | Type Safety | **OK**. `tsc` y `biome` limpios; los casts son de `RegExpExecArray` bajo `noUncheckedIndexedAccess` |
| 7 | Test Coverage | **4 × BLOQUEANTE-BAJO** |
| 8 | Scope Drift | **OK**. 23 archivos; el test-mecanismo es la única adición no prevista en F2.5 y es respuesta directa a AR-2 |
| 9 | Destructive Migrations | **N/A** |
| 10 | RPC `SECURITY DEFINER` | **N/A** |
| 11 | Cache Invalidation | **N/A** |

**Riesgo residual declarado**: no se puede verificar desde este repo que `wasiai-v2` reenvíe
verbatim y no lea `query` por su cuenta. AR-1 y AR-2 lo evidenciaron leyendo
`forward-handler.ts` de v2; queda a confirmar en F4/deploy.

## Orden sugerido para el fix-pack

| # | ID | Qué toca | Costo |
|---|---|---|---|
| 1 | `BLQ-BAJO-2` | `topLevelKeys` señala lo no resuelto → `opaquePosts` | ~15 líneas |
| 2 | `BLQ-BAJO-4` | step de CI para `mcp-servers/wasiai-x402`, o test-guardián | ~10 líneas |
| 3 | `BLQ-BAJO-3` | declarar el set ignorado (y/o enumerarlo) | docstring |
| 4 | `BLQ-BAJO-1` | sincerar "QUÉ NO CUBRE" con las formas medidas | docstring |
| 5 | `MNR-1`, `MNR-2` | `docs/api-reference.md` y la frase del entrecomillado | 2 líneas |

Los cuatro son de **declaración y cableado**, no de lógica de negocio. Si el Dev cierra los
cuatro, el candado deja de prometer de más y AR-4 puede confiar en él, que es la única
condición bajo la cual esta HU cierra la clase en vez de cerrar diez instancias.
