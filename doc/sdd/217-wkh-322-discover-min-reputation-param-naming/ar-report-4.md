# AR-4 — WKH-322 · cuarta pasada, acotada al fix-pack 3 (`000f424..e50d656`)

**Persistido por el orquestador**: el agente de AR-4 no tenía herramienta de escritura.
Entregó el reporte en su mensaje; este archivo es esa entrega. Sin redirects de shell.

Árbol real intacto: rama `feat/217-wkh-322-discover-reputation-param-naming`, HEAD `e50d656`,
`git status` idéntico antes y después. Toda mutación vivió en una copia rsync fuera del repo.

## VEREDICTO: RECHAZADO (2 BLOQUEANTE-BAJO)

Los 4 `BLQ-BAJO` de AR-3 están **cerrados y verificados por mutación**, incluido el más
difícil: los dos gitignoreados hoy son visibles para el barrido y el retroceso que el Dev dice
haberse cazado solo efectivamente quedó corregido. `T-CS-4` no es decorativo: los fixtures de
"LÍMITE DECLARADO" se ponen rojos si el límite deja de serlo. La exclusión de volumen es sana:
los 37.883 archivos que saca son 100% derivados.

Lo que rechaza es **el guardián nuevo**, `test/test-files-are-run-in-ci.test.ts`, y por la
misma razón por la que AR-3 rechazó el barrido: valida que el step **exista**, no que
**ejecute** ni cuál sea su alcance **efectivo**.

---

## `BLQ-BAJO-1` — el guardián de CI cuenta un step que NO corre, o que corre menos de lo que dice

**Test Coverage** · `test/test-files-are-run-in-ci.test.ts:20-37` (la promesa), `:128-137`
(`vitestIncludeGlobs`), `:156-164` (el único límite declarado), `:182-220` (`discoverRunners`).

El docstring dice que traduce cada `scripts.test` a "los globs que **realmente** se expanden" y
declara **un solo** límite (`defaults.run.working-directory`). Tres vectores medidos lo
falsifican, los tres verdes:

**(a) `exclude` de vitest — el más barato y el peor.** `vitestIncludeGlobs` lee `include` y
nunca mira `exclude`, que ya existe en los dos configs.

```
# mutación: vitest.config.ts:6
exclude: ['dist/**', 'node_modules/**', 'packages/**', 'src/lib/discovery-query.test.ts'],
```

| | esperado | real |
|---|---|---|
| `npx vitest run src/lib/discovery-query.test.ts` | corre | `No test files found, exit 1` |
| `npm test` | 4987 pass | **4961 pass, verde** |
| guardián | ROJO (26 tests sin runner) | **3 passed, verde** |

**(b) `if:` que nunca resuelve true.** `if: github.ref == 'refs/heads/never'` en el step
`Test (mcp-servers/wasiai-x402)` → guardián **3 passed**. Los 347 tests no correrían en ningún
PR y el guardián los da por cubiertos.

**(c) `continue-on-error: true`.** Ídem, guardián verde. No es hipotético:
`smoke-downstream.yml:36` ya usa ese idiom en este repo.

**Impacto**: el modo de falla que este archivo documenta en su propia cabecera ("347 verdes que
no corría nadie") vuelve por la puerta de al lado, y esta vez con un guardián verde encima
diciendo que está cubierto — estrictamente peor que no tenerlo, porque el revisor siguiente
deja de mirar los `include`.

**Sugerencia**: (1) leer también `exclude` y restarlo del set cubierto; (2) que un step con
`if:` o `continue-on-error:` caiga en `untranslatable` ("no puedo afirmar que este step corra")
en vez de contar como runner; (3) mínimo aceptable: declarar los tres en el docstring.

---

## `BLQ-BAJO-2` — los dos `npm install` nuevos de CI se saltan el `.npmrc` de hardening

**Security** · `.github/workflows/ci.yml:48-64` contra `.npmrc:1-6`.

`.npmrc` fija `ignore-scripts=true` y dice textualmente *"do NOT remove this flag globally"*.
npm resuelve el `.npmrc` de proyecto desde el prefix (el dir con `package.json`), no de los
ancestros. Medido:

```
$ npm config get ignore-scripts                                  # raíz
true
$ cd mcp-servers/wasiai-x402 && npm config get ignore-scripts
false
$ cd packages/agent-sdk && npm config get ignore-scripts
false
```

Los dos steps agregados por `b3c9e3b` corren en esos directorios, así que instalan **con
`postinstall`/`preinstall` habilitados** — 108 paquetes en x402, y en `agent-sdk` peor: sin
`package-lock.json`, `npm install` re-resuelve los `^` de `vitest`/`typescript`/`biome` en cada
corrida, así que una patch release comprometida de cualquier transitiva ejecuta código
arbitrario en el runner. El comentario del `.npmrc` ("wasiai-a2a has no first-party lifecycle
scripts, so this is safe") deja de describir lo que pasa en CI. El job `build-test` no declara
bloque `permissions:`.

**Sugerencia**: `--ignore-scripts` explícito en los dos steps, o un `.npmrc` por sub-paquete.

---

## MENORes

**`MNR-1`** — `T-CS-3` promete leer todo body y el `{[k]:v}` pasa mudo.
`discover-callsites.test.ts:787-802` (el mensaje), `:341-356` (la decisión), `:886-901` (el
fixture). Verifiqué los dos argumentos del Dev y **los dos son ciertos**, medidos: mutando
`topLevelKeys` para que `[` en posición de clave marque `unresolved`, el único rojo del repo
real es `discover.minreputation.test.ts:732` (el `it.each` POSITIVO del propio guard), o sea
que efectivamente haría falta una excepción. No es conveniencia: es honesto y está declarado
con fixture. Lo que queda es prosa: `body: JSON.stringify(filters)` (cero claves legibles) sale
**rojo** `no-body`, y `body: JSON.stringify({[k]: v})` (también cero claves legibles) sale
**verde y mudo**. El mensaje de `T-CS-3` no cruza al límite que vive 100 líneas más abajo. Un
cross-reference de una línea lo cierra.

**`MNR-2`** — 3 de 5 límites del extractor tienen fixture; el docstring hedgea bien, el
auto-blindaje no. Con fixture y probados no-vacuos: array de pares `:962`, QS concatenada
`:972`, `"params"` entrecomillado `:930`, más `{[k]:v}` `:886`. **Sin fixture**:
`params.set(KEY, x)` — y ésta **sí es fixturable** con `scanFile`; y el helper cross-file, que
no lo es. El docstring `:47-49` hedgea correcto, pero `auto-blindaje.md:283-284` afirma el
universal: *"ningún ítem de esa lista vale si no tiene un caso que lo congele"*, y la propia
lista no lo cumple.

**`MNR-3`** — prosa nueva en `docs/api-reference.md` (`f369bc4`) falsable con input concreto.
`:104` — *"Anything other than `true`/`false` is a `400 INVALID_ALLOW_TRIAL`"*. Input
`?allowTrial=` → `parseAllowTrial('')` (`discovery-query.ts:148`) devuelve `undefined`, no tira
→ **200**, no 400.
`:101` — *"Must be an integer `>= 1`"*. Input `?limit=1e21`: es un entero ≥ 1 y devuelve **400
`INVALID_LIMIT`**, porque `parseLimit:110` exige `Number.isSafeInteger`. Falta el techo
`2^53-1`.
Lo demás de la tabla aguanta: las 10 filas son exactamente `ALLOWED_DISCOVER_PARAMS`, la escala
`[0,100]` es la del código, y los dos códigos de error existen.

---

## Verificaciones que PASARON (medición, no intención)

**Blanco 1 — lo que el guardián SÍ cumple.** Archivo `*.test.ts` huérfano en directorio nuevo,
staged → **ROJO** con el path y la lista de runners descubiertos. `scripts.test = "jest
--config jest.config.cjs"` → **ROJO** por `untranslatable`, con el comando textual. `node
--test` con extglob `?(c|m)js` → **ROJO** (`unsupportedGlob`). Un `run: |` multilínea no
matchea `^npm` y pierde el runner → rojo (lado seguro). La promesa "si no puede traducir, no
adivina" se sostiene. Costo: **258 ms** los dos guardianes juntos; `npm test` 9,97 s. (Único
caso verde por diseño: un `*.test.*` untracked no se ve — declarado en `:63`.)

**Blanco 2 — el step de CI corre de verdad y rompe el build.** Sin `continue-on-error`, en el
job `build-test`. Borrando el bloque `if (!res.ok)` de `handlers.mjs:191-208` → **`# fail 3`,
exit 1**. `BLQ-BAJO-4` de AR-3 está cerrado de verdad. `npm ci` reproducible desde cero: lock
v3 en sync, 108 paquetes, cero `file:`/`link:`, `engines node 22.x` = el `node-version: '22'`
del workflow. Corrida con entorno limpio y **borrando `.env.local`**: `# pass 347 # fail 0`.
`agent-sdk`: 8 files / 30 tests verdes.

**Blanco 3 — la exclusión de volumen no saca nada propio. Es el hallazgo que NO apareció.**
38.134 ignorados → 251 quedan (el docstring dice 267; es medición de working copy, etiquetada
como tal). Los 37.883 excluidos, clasificados uno por uno: **37.080 `node_modules/`, 574
`dist/`, 229 `coverage/`, y CERO en "otro"**. Barrí los 803 no-`node_modules` buscando
`/discover|/api/v1/capabilities`: 44 aciertos, **los 44 derivados**, todos con su fuente dentro
del barrido. Y estructuralmente no puede escaparse un archivo propio: los excludes se pasan
**sólo** al `--ignored` (`:262-268`); el `--cached --others` (`:249`) va sin pathspec.

**Blanco 4 — el retroceso está corregido, en las dos direcciones.**
```
scripts/smoke-base-downstream.mjs:116   { q: GOAL } → { query: GOAL }
  → T-CS-2 ROJO: "…:116  clave 'query' (body JSON)"
scripts/smoke-prod-via-app-wasiai.mjs:85  capabilities?limit=20 → ?query=x&limit=20
  → T-CS-2 ROJO: "…:85  clave 'query' (query string)"
```
El discriminante que reemplazó al descartado (`isProseMention`, `:496-504`) no tapó nada más:
volqué los 98 call-sites detectados sobre 1007 archivos y están los 10 del inventario de AR-2.
`T-CS-0b` no es tautológico: sacando la rama `--ignored` de `repoFiles()` se pone **ROJO**.

**Blanco 8 — cero drift.** `git diff --name-only 000f424..e50d656` = 8 rutas (las 7 del Dev +
`ar-report-3.md`, que persistió el orquestador). `ALLOWED_DISCOVER_PARAMS` sigue en **las
mismas 10 claves**, cero banderas nuevas. El diff de `src/lib/discovery-query.ts` es **100%
líneas de comentario**. `wasiai-v2` fuera del diff: `BLQ-ALTO-1` sigue afuera por decisión del
founder.

## Categorías (sólo las que toca la superficie nueva)

| # | Categoría | Veredicto |
|---|---|---|
| 1 | Security | **`BLQ-BAJO-2`** — `ignore-scripts` bypasseado en los 2 installs nuevos |
| 4 | Performance | **OK** — guardián 258 ms; suite 9,97 s; x402 1,1 s; agent-sdk 0,7 s |
| 5 | Integration | **MENOR** (`MNR-3`) — 2 frases de `api-reference.md` falsables |
| 7 | Test Coverage | **`BLQ-BAJO-1`** + `MNR-1`, `MNR-2` |
| 8 | Scope Drift | **OK** — 8 archivos, allowlist intacta, diff de código = comentarios |
| 2,3,6,9,10,11 | Error Handling / Data Integrity / Type Safety / Migrations / RPC / Cache | **N/A** — el fix-pack 3 no toca runtime de producción; sin SQL, sin RPC, sin cache |

## Orden para el fix-pack 4

| # | ID | Qué toca | Costo |
|---|---|---|---|
| 1 | `BLQ-BAJO-1` | leer `exclude` + rechazar steps con `if:`/`continue-on-error:`, **o** declarar los 3 límites | ~10 líneas / 3 líneas |
| 2 | `BLQ-BAJO-2` | `--ignore-scripts` en `ci.yml:50` y `:60` | 2 palabras |
| 3 | `MNR-1` | cross-ref del límite `{[k]:v}` en el mensaje de `T-CS-3` | 1 línea |
| 4 | `MNR-2` | fixture para `params.set(KEY, x)`; hedgear `auto-blindaje.md:283` | ~8 líneas |
| 5 | `MNR-3` | `?allowTrial=` vacío y el techo `2^53-1` en `api-reference.md` | 2 líneas |

**Nada de lo que encontré esta ronda toca el camino de producción de `/discover`.**
