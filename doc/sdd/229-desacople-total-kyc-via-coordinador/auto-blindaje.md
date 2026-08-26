# Auto-Blindaje — WKH-366 (F3)

Errores cometidos y corregidos DURANTE la implementación, con su fix y dónde más aplica.
Waves cubiertas por este archivo: **W0 y W1**. W2..W5 van en lanzamientos separados.

---

### [2026-08-26 10:07] W0 — `lint` es el eslabón que casi no llega a correr

- **Error**: escribí un `expect(...).toBe(false)` de una línea en
  `src/lib/capability-risk.test.ts` (T-B2). `npx tsc --noEmit` pasó en 0 y el archivo de test
  hubiera pasado `vitest` sin chistar. **`npm run lint` (biome) lo puso rojo**: el formateador
  quería la llamada partida en 3 líneas.
- **Causa raíz**: escribir código a mano sin correr el formateador del repo, y asumir que
  "typecheck + test verde" es el gate. **No lo es**: el gate de `wasiai-a2a` es
  `tsc` → `lint` → `test`, y `lint` es el SEGUNDO eslabón, no un extra.
- **Fix**: partir la llamada como pide biome y re-correr `npm run lint` hasta
  `Checked 516 files. No fixes applied.`
- **Aplicar en**: toda wave de repo B (`wasiai-a2a`). ⚠️ `npm run lint` es `biome check src/`:
  **no mira `test/`**. Un test escrito en `test/**` no se lintearía y el mismo error pasaría
  invisible — lo que hace que este rojo haya sido suerte de ubicación, no de rigor.

---

### [2026-08-26 10:14] W1 — `diff` bajo el hook dijo "✅ Files are identical" sobre archivos que DIFIEREN

- **Error**: para verificar que los dos `manifest/route.ts` nuevos son copia literal del exemplar,
  corrí `diff exemplar nuevo`. La salida fue **`✅ Files are identical`** para los DOS. Es falso:
  difieren en 2 líneas (la 1 y la 12).
- **Causa raíz**: el mismo hook que ya corrompe `cat` y trunca `git diff` intercepta `diff` y
  contesta otra cosa. **La herramienta afirmó lo que yo esperaba oír** — el modo de falla más caro,
  porque un "son idénticos" es exactamente lo que uno busca al copiar un exemplar y no invita a
  mirar dos veces.
- **Fix**: `/usr/bin/diff`, que devolvió las 2 líneas reales y `exit=1`.
- **Aplicar en**: **cualquier** verificación de "¿esto cambió?" en este entorno. Ya estaban
  documentados `cat`, `grep`, `git diff` y `git log`; **`diff` pelado se suma a la lista**. Regla
  operativa: para preguntas de igualdad de archivos, ruta absoluta al binario, y creerle sólo si
  además muestra el detalle o el exit code.

---

### [2026-08-26 10:18] W1 — `vi.stubEnv` NO se deshace entre los casos de un mismo `it`, y volvió 401 a tres ramas

- **Error**: en `src/app/api/agents/compose-dialect-no-pii.test.ts` (T-A10) armé el barrido de las
  ramas con el caso "401 sin credencial" en el MEDIO de la lista. Ese caso hace
  `vi.stubEnv("INVOKE_AUTH_SECRET", ...)`, y el stub **sobrevive al resto del `for`**: la rama 502
  que venía después contestó **401**.
- **Causa raíz**: `vi.stubEnv` se deshace en el `afterEach` (`vi.unstubAllEnvs()`), no entre las
  iteraciones de un bucle dentro del mismo test. Yo razoné sobre el ciclo de vida del stub en vez
  de medirlo.
- **Fix**: mover el caso del guard al FINAL de las dos listas y dejar escrito **por qué** va último.
- **Aplicar en**: todo test que barra varias ramas en un solo `it` y encienda una env en una de
  ellas. 🔴 **Y el modo de falla peligroso es el otro**: acá el rojo apareció porque yo asertaba el
  status esperado de cada rama. **Sin ese assert, el barrido habría medido cinco veces la misma
  respuesta del guard y salido VERDE**, afirmando "ninguna rama filtra identidad" sobre ramas que
  nunca se ejecutaron. El assert de status no es decorado: es el control de que el instrumento
  apunta a lo que dice apuntar.

---

## Divergencias del SDD (§8 del Story File) — qué se hizo con cada una

Las 8 venían YA detectadas por F2.5. Las que tocan W0/W1:

| # | Qué se hizo en W0/W1 |
|---|---|
| G-1 | No aplica a W0/W1 (T-B5/T-B6 son de W2). |
| G-2 | No aplica a W0/W1 (T-B3 es de W2). |
| G-3 | No aplica a W0/W1 (es de W3). |
| G-4 | No aplica a W0/W1 (es de W3). |
| G-5 | No aplica a W0/W1 (es de W3). |
| G-6 | No aplica a W0/W1 (es de W3). |
| G-7 | No aplica a W0/W1 (el candado de conteo de tests es de `chaski-v3`). W1 agrega 3 archivos de test en el repo A, que **no tiene** ese candado. |
| G-8 | **APLICADA.** Los tests `T-A7` de los dos endpoints cubren **las 4 ramas que emite el handler** y dejan el 401 de `guardInvokeAuth` FUERA del conjunto, con el motivo escrito en el test y en la cabecera de las dos rutas. `src/auth/invoke-auth.ts` **no** cambió de comportamiento: sólo su prosa. |

---

## Divergencias NUEVAS encontradas al implementar (no estaban en §8)

### G-9 · La cita del Story File a `readCoordinatorFee` está corrida 6 líneas

- **Dice el Story File** (dos veces, §W1-A1 punto 1): `readCoordinatorFee(data)` en
  `wasiai-a2a/src/services/compose.ts:2024`, colapso `data.result ?? data` en `:2025`.
- **Mide el árbol** (2026-08-26): `readCoordinatorFee(data)` está en **`:2030`** y
  `const output = data.result ?? data;` en **`:2031`**. `:2024` es una línea de comentario del
  bloque que explica el orden.
- **Qué se hizo**: la cita que quedó escrita en
  `src/app/api/agents/remit-kyc-session/invoke/route.ts` usa **`:2030`/`:2031`** y deja anotado en
  el mismo comentario que el Story File dice otra cosa y que vale la medición. **El hecho de fondo
  —el sobre se lee ANTES del colapso— es CIERTO y no cambia.**

### G-10 · La prosa de `invoke-auth.ts:43` ya era falsa ANTES de esta HU

- **Dice el Story File** (§W1-A5): la línea 43 dice *"Este guard se llama SÓLO desde los **3**
  `invoke`"* ⇒ actualizar el número a **5**.
- **Mide el árbol**: `guardInvokeAuth(` tiene **5 call sites de producción ANTES de esta HU**: los 3
  `/invoke` **más** `remit-kyc-validator/session/route.ts:70` y
  `remit-kyc-validator/decision/route.ts:112`. O sea que el **"SÓLO"** era falso desde WKH-233, y
  cambiar sólo el número lo dejaría igual de falso con otra cifra.
- **Qué se hizo**: se escribió el número de `invoke` (**5**, que es lo que pidió el Story File) **y**
  se corrigió el "SÓLO", con el total medido (**7 call sites**) y la instrucción de derivarlo
  grepeando, no de memoria. Es CD-14 aplicado a la frase entera, no sólo al dígito.

### G-11 · Los `manifest/route.ts` nuevos difieren del exemplar en DOS líneas, no en una

- **Dice el Story File** (§W1-A2 y el checklist de Repo A): *"copia LITERAL […] cambiando **una
  sola línea**: `:12` `const PATH_SLUG`"*.
- **Qué se hizo**: se cambiaron **dos**: `:12` (el `PATH_SLUG`) y **`:1`**, que es el comentario con
  la ruta del propio archivo. Dejarlo diciendo `remit-kyc-validator/manifest/route.ts` dentro de
  `remit-kyc-session/manifest/route.ts` sería una afirmación falsa escrita a mano en un archivo
  nuevo. Verificado con `/usr/bin/diff`: **exactamente 2 líneas, ninguna más.**

### G-12 · Dos ramas del contrato son INALCANZABLES por el cable, y se testean igual

- `remit-kyc-session`: la rama `callback_not_allowed` no se puede alcanzar mandando un body, porque
  `KycComposeSessionInputSchema` no acepta `callbackUrl`.
- `remit-kyc-decision`: las ramas `invalid_request` (`missing_session`) y el veredicto
  `token_missing` no se pueden alcanzar, porque el schema exige `sessionId` y `decisionToken` con
  `.trim().min(1)` y Zod los caza antes con un 400.
- **Por qué se escriben igual**: `KycSessionOutcome` y `KycDecisionOutcome` son uniones CERRADAS y
  el `switch` es exhaustivo — **omitir la rama NO COMPILA**.
- **Qué se hizo**: se ejercitan por el único camino que queda —doblando el desenlace del core con
  `mockResolvedValueOnce`— para que no queden ramas sin una sola aserción encima, y la
  inalcanzabilidad va escrita en el código y en el test.

---

## Mutantes aplicados, y el rojo que produjo cada uno

Todos: aplicar → correr → ver el rojo → **restaurar con `cp` desde una copia propia**.
⛔ Ninguno se restauró con `git checkout --`.

### Repo B — `wasiai-a2a`

| # | Mutante | Rojo observado |
|---|---|---|
| M1 | sacar `'kyc-session-create'` de `NON_DISBURSEMENT_CAPABILITIES` | `capability-risk.test.ts:165` — `expected "no-disbursement", received "unclassified"`. 1 failed / 28 passed |
| M2 | `requiresPinnedAgent` sin `normalize` (`.has(capability)`) | `capability-risk.test.ts:182` — `requiresPinnedAgent('KYC-Decision-Read')` deja de dar `true`. 1 failed / 28 passed |
| M3 | agregar `'kyc-verification'` (preexistente) a `AUTHORIZATION_CAPABILITIES` | `capability-risk.test.ts:220` — el barrido de las 15 preexistentes. 1 failed / 28 passed |

### Repo A — `wasiai-remittance-agents`

| # | Mutante | Rojo observado |
|---|---|---|
| M4 | publicar un `required` que Zod no exige (`required: ["identityRef"]` en la ficha de `remit-kyc-session`) | `input-schema-drift.test.ts:367` — **2 failed** / 16 passed (`compareObject` (3) + el barrido inverso) |
| M5 | borrar la entrada `remit-kyc-decision` del registro | `registry.test.ts:14` — `to have a length of 5 but got 4`. 1 failed / 14 passed |
| M6 | 5ª clave en el `result` del 200 de `/remit-kyc-session/invoke` | T-A1 — `expected ['decisionToken','extra',…] to deeply equal ['decisionToken','provenance',…]`. 1 failed / 9 passed |
| M7 | `identityRef: parsed.data.identityRef ?? undefined` (la clave LLEGA al core) | T-A2 — `expected ['identityRef'] to not include 'identityRef'`. 1 failed / 9 passed |
| M8 | `.strict()` → `.passthrough()` en los DOS schemas nuevos | **8 failed** en 3 archivos. El leak real: en `/remit-kyc-decision/invoke` el 400 pasa a **200 con el DNI atravesando el agente** |
| M9 | `guardInvokeAuth` DESPUÉS del `safeParse`, en los dos endpoints | T-A5 ×2 — `se leyó el body del caller ANTES de autenticarlo: expected 1 to be 0`. **El status siguió siendo 401**: murió por el CONTADOR, no por el status. 2 failed / 21 passed |
| M10 | un `reason` colado en UNA sola rama del 401 | T-A6 — `los 401 no son byte-idénticos: {"error":"unauthorized"} \| {…,"reason":"token_mismatch"} \| {…}`. 1 failed / 12 passed |
| M11 | sacar `headers: NO_STORE` del 401 del token | T-A7 — `las 4 ramas no comparten Cache-Control: no-store,`. 1 failed / 12 passed |
| M12 | sacarle `legacy-single-shot-kyc` a la ficha de `remit-kyc-validator` | **4 failed** en `registry.test.ts`, uno de ellos T-A8. Es AC-3 |
| M13 | ecoar el body CRUDO en el 400 de `/remit-kyc-session/invoke` | **3 failed** en 2 archivos — T-A3 y las dos mitades de T-A10: `expected … not to contain '12345678'` |

**Control positivo del instrumento (T-A10)**: el barrido no-PII tiene un `it` que afirma que la PII
**existe** en la respuesta del doble del partner y que el barrido la detecta cuando está. Sin él,
los dos barridos podrían estar verdes por medir un `dump` sin PII adentro — o sea, midiendo nada.

---

## W2 — Repo B (`wasiai-a2a`): el guard N2

### [2026-08-26 10:35] Wave 2 — `cacheHit: 'MISS'` no existe en el tipo, y `vitest` lo dejó pasar

- **Error**: en T-B5 armé el doble de `maybeTransform` con
  `cacheHit: 'MISS'`. **`npx vitest run src/services/compose.test.ts` salió VERDE, 114 passed.**
  El rojo apareció recién en el primer eslabón del gate:
  `src/services/compose.test.ts L4311: TS2322 Type '"MISS"' is not assignable to type 'boolean | "SKIPPED"'`.
- **Causa raíz**: escribí el campo del molde de memoria en vez de leer el tipo. El molde real
  (`src/services/compose.test.ts:86-92`) usa `cacheHit: 'SKIPPED'`, y el tipo es
  `boolean | 'SKIPPED'` — o sea que el vocabulario que yo asumí (`HIT`/`MISS`) **no es el de este
  repo**. `vitest` no typechequea el archivo de test, así que la suite verde no dice nada del tipo.
- **Fix**: `cacheHit: false`.
- **Aplicar en**: es la regla 9 del `CLAUDE.md` medida otra vez, y en el eslabón que ya había
  costado 5 revisiones. **Correr `vitest` sobre el archivo que tocaste no es correr el gate**: acá
  la parte que faltaba era `tsc`, y en la corrida siguiente fue `lint` (dos archivos mal formateados
  que la suite verde tampoco vio). El gate de este repo son TRES comandos en orden y hay que
  correrlos los tres.

### [2026-08-26 10:34] Wave 2 — dos mutantes que NO SE APLICARON y la corrida salió VERDE

- **Error**: los mutantes M15 y M17 (sacar `'kyc-session-create'` / agregar `'kyc-verification'`)
  los escribí como un reemplazo de texto sobre el bloque
  ``'kyc-session-create',\n  'kyc-decision-read',\n]);``. Ese literal aparece **DOS veces** en
  `capability-risk.ts`: una en `AUTHORIZATION_CAPABILITIES` y otra en
  `NON_DISBURSEMENT_CAPABILITIES`, que termina con las mismas dos entradas y el mismo `]);`.
- **Causa raíz**: identifiqué el sitio a mutar por su contenido y no por su ancla. Las dos listas
  **terminan igual por diseño** (las dos capacidades nuevas van al final de ambas).
- **Fix**: anclar el reemplazo en el bloque COMPLETO, desde
  `export const AUTHORIZATION_CAPABILITIES`.
- **Aplicar en**: lo que lo cazó fue un `assert s.count(old)==1` en el script de mutación —
  **sin ese assert la corrida habría reportado `20 passed` y yo habría anotado "mutante
  sobrevivió"**, que es la conclusión exactamente opuesta a la verdad y habría hecho reescribir un
  test que estaba bien. Todo script de mutación lleva su assert de que el mutante SE APLICÓ; si no,
  el verde mide el árbol sin mutar. Es la variante "el instrumento no tocó el blanco" de
  `memory/mi-sonda-invento-el-corte.md`.

### [2026-08-26 10:36] Wave 2 — el mutante que el Story File le asigna a T-B7 NO lo mata

- **Error**: no es mío, es del Story File, y se descubrió ejecutándolo. La tabla de W2-B3 dice que
  el mutante de **T-B7** es *"invertir el predicado de `requiresPinnedAgent` ⇒ rojo"*.
  **Medido: T-B7 y T-B7b siguen VERDES con el predicado invertido** (`15 failed | 5 passed`, y los
  dos que sobreviven son ésos).
- **Causa raíz**: T-B7 manda un step **pinado** (`agent: 'remit-kyc-decision'`), y en un step pinado
  `step.capability` es `undefined` ⇒ el bucle hace `continue` **antes** de llamar al predicado. El
  predicado no se ejecuta nunca en ese camino, así que invertirlo no puede cambiar el resultado.
- **Fix**: el mutante que sí mata a T-B7/T-B7b es **M21**: invertir el *shape-check* del guard para
  que un step SIN capacidad caiga en el `return` en vez del `continue` (o sea, que el guard rechace
  un step pinado). Aplicado y verificado.
- **Aplicar en**: cuando una tabla de tests asigna un mutante, **hay que ejecutarlo, no aceptarlo**.
  Un mutante mal asignado no es un detalle de prosa: hace creer que un test está candado cuando
  ninguna mutación lo toca. Vale para toda fila donde el mutante ataca una rama que el fixture del
  test **no recorre**.

### Mutantes de W2 — aplicados, rojo observado, restaurados con `cp`

Copias pristinas en un directorio propio del scratchpad; restauración con `cp`.
⛔ Ninguno se restauró con `git checkout --` (borraría lo que se está midiendo).

| # | Mutante | Rojo observado |
|---|---|---|
| M14 | sacar `'kyc-decision-read'` de `AUTHORIZATION_CAPABILITIES` | **3 failed / 17 passed** — T-B3, T-B8, T-B9. El rojo es `expected "vi.fn()" to not be called at all, but actually been called 1 times` sobre `discoverMock`: **el impostor pasó a ser consultado** |
| M15 | sacar `'kyc-session-create'` del mismo set | **1 failed / 19 passed** — T-B3b, mismo rojo sobre `discoverMock` |
| M16 | invertir el predicado (`!AUTHORIZATION_CAPABILITIES.has(...)`) | **15 failed / 5 passed** — T-B10 más los 14 T-CAPROUTE preexistentes. ⚠️ **NO mata a T-B7/T-B7b** (ver la entrada de arriba) |
| M17 | agregar `'kyc-verification'` (preexistente) al set — CD-18 | **2 failed / 47 passed** — T-B2 (`kyc-verification: expected true to be false`) y T-B10 (`expected 400 to be 200`) |
| M18 | sacar la llamada al guard de `validateComposeBody` (o sea, moverlo a la posición post-débito) | **4 failed / 16 passed** — T-B3, T-B3b, T-B8, T-B9. T-B8 muere por `lookupByHash` **llamado 2 veces**: el contador, no el status |
| M19 | asignar `result.output` **después** del bridge | **1 failed** — T-B5: `expected { payoutAllowed: true } to deeply equal { payoutAllowed: false }`. El veredicto **invertido**, que es exactamente el daño que AC-7' evita |
| M20 | `i < steps.length - 1` → `i <= steps.length - 1` | **1 failed** — T-B6. El pipeline de 1 step entra al bloque del bridge y revienta |
| M21 | el shape-check del guard invertido: un step **pinado** cae en el `return` | **4 failed / 16 passed** — T-B7 y T-B7b entre ellos. Es el killer REAL de la dirección positiva del guard |

**T-B4 no tiene mutante, y es a propósito**: es el **control positivo del instrumento**, no un
candado. Lo que afirma es que **el agujero existe**: con el mismo doble que usa T-B3,
`resolveCapability('kyc-decision-read', …)` devuelve **`evil-kyc`** (`res.ok === true`,
`agent.registry === 'registro-de-un-tercero'`). Medido en verde. Sin esa afirmación, el verde de
T-B3 podría venir de que su doble no arma ningún ataque.

---

## W3 + W4 — repo C (`chaski-v3`), worktree `wt-366-chaski`, branch `feat/wkh-366-kyc-gateway-transport`

Línea base medida sobre `main` en el mismo worktree, ANTES de tocar nada:
`npm run qa` ⇒ `Test Files 154 passed (154)` · `Tests 3060 passed (3060)` · exit 0 · lint `137→132 warnings, 0 errores`.

### [2026-08-26] Wave 3 — 🔻 G-9: el guard de `identityMatches` se pone rojo, y el Story File no lo previó

- **Error**: crear `gateway-kyc-client.ts` con el estrechado que CD-19 exige puso **ROJO** a
  `src/composition/kyc-provider-residue.static.test.ts` (G-3, "`identityMatches` sólo vive en el
  BORDE"), que pinea una lista CERRADA de dos archivos. Ese archivo **no está en el Scope IN de W3**.
- **Causa raíz**: CD-19 ordena que el transporte nuevo estreche la respuesta con los MISMOS lectores
  y preserve `identityMatches` AUSENTE, y la checklist de §9 prohíbe tocar los cuerpos del cliente
  directo (o sea: no se puede factorizar el estrechado a un módulo común). Las dos reglas juntas
  fuerzan **un tercer archivo que nombra el campo**. El Story File no lo anticipó.
- **Fix**: agregar `src/infrastructure/kyc/gateway-kyc-client.ts` a `PERMITIDOS_IDENTITY_MATCHES` y
  **reescribir su docblock**, que empezaba con «SON DOS ARCHIVOS, NO CUATRO» — una afirmación que el
  cambio volvía falsa. El criterio se dejó escrito (el TIPO + los módulos que ESTRECHAN, uno por
  transporte) junto con la nota de que **el número envejece solo** y que W6 tiene que volver a bajarlo
  a dos al borrar el transporte directo.
- **Aplicar en**: toda lista de excepciones pinneada por NOMBRE. Un guard con lista cerrada es una
  dependencia oculta de cualquier HU que agregue un módulo al mismo borde, y no aparece en ningún
  Scope IN. Buscar `PERMITIDOS_*` antes de crear un módulo hermano de uno ya listado.

### [2026-08-26] Wave 3 — dos citas ancladas rotas por MI propio desplazamiento

- **Error**: reescribir la cabecera de `gateway-client.ts` (+22 líneas) corrió todo el archivo y dejó
  DOS citas apuntando a otra cosa: `` (`agentFailure`, `:264`) `` dentro del propio archivo, y
  `` (`not_configured`, `gateway-client.ts:239`) `` desde `app/api/a2a/quote/route.ts:137`.
- **Causa raíz**: el barrido mental fue sobre lo que ESCRIBÍ, no sobre lo que DESPLACÉ. Ninguna de
  las dos líneas se editó; las dos quedaron falsas igual.
- **Fix**: re-derivadas MIDIENDO (`:314` y `:289`), no estimando. Lo cazó
  `src/composition/citas-ancladas.test.ts`, no una relectura.
- **Aplicar en**: toda edición que inserte líneas ARRIBA en un archivo citado. El instrumento existe
  y es barato: correr el candado de citas antes del gate completo.

### [2026-08-26] Wave 4 — 🔴 el mutante M13 destapó que MI test no medía lo que decía

- **Error**: escribí en `smoke-kyc-helpers.test.ts` un `it` rotulado *"🔴 el `it` MÁS IMPORTANTE del
  archivo"* que afirmaba matar el mutante «la fila por defecto de la escalera devuelve PASS», usando
  una observación VACÍA. **Corrí el mutante: mataba UN test, y no era ése.**
- **Causa raíz**: una observación vacía **no llega al default** — sale mucho antes, por la fila "no se
  llegó a consultar el catálogo". El `it` era un candado sobre una fila distinta de la que decía
  vigilar, y su verde no distinguía el código bueno del mutado.
- **Fix**: el caso se reescribió con la observación que SÍ alcanza el default (un recorrido entero
  que contesta bien pero sin ninguna de las cuatro verificaciones positivas), y la observación vacía
  quedó como un `it` aparte que asserta su PROPIA fila por el mensaje. Re-corrido el mutante:
  **2 failed / 54 passed**, con el caso corregido entre los muertos.
- **Aplicar en**: **el mutante no es la confirmación del test, es su medición.** Si el rojo aparece en
  un test distinto del que el comentario nombra, el hallazgo es el comentario. Ya pasó en W2 con un
  mutante mal asignado; acá pasó al revés (el test mal apuntado). Mismo remedio: ejecutar, no aceptar.

### [2026-08-26] Wave 3 — `undefined` disparó el parámetro por defecto y el `it` falló por otra causa

- **Error**: en `authority.gateway.test.ts`, la fila "sin la clave `agent`" pasaba `undefined` a
  `compose200(output, agent = EJECUTOR_PROPIO)`, así que **el default se activaba** y el step salía
  con el ejecutor CORRECTO. El `it` fallaba, pero por el motivo equivocado.
- **Causa raíz**: `undefined` no es "ausente" cuando hay un parámetro por defecto: es su gatillo.
- **Fix**: un `Symbol("sin-agent")` como centinela explícito, y el motivo escrito en el docblock del
  helper para que nadie lo "simplifique" de vuelta a `undefined`.
- **Aplicar en**: cualquier helper de test con parámetro por defecto donde una de las filas quiera
  expresar AUSENCIA.

### [2026-08-26] Wave 4 — el gate se cayó en LINT, que es su PRIMER eslabón

- **Error**: `npm run qa` salió **exit 1** con `Found 2 errors` de `lint/complexity/noCommaOperator`
  en `scripts/smoke-kyc-helpers.test.ts:312-313` (un `(o.campo = x, o)` dentro de un arreglo de
  funciones). `tsc` y `vitest` estaban los dos en verde.
- **Causa raíz**: escribí una expresión válida para TypeScript y prohibida por el linter, y venía
  corriendo `vitest` por archivo durante toda la wave.
- **Fix**: cuerpos de bloque en vez del operador coma, y `romper(o)` separado del `push`.
- **Aplicar en**: es exactamente el precedente escrito del repo —un `import` sin usar que sobrevivió
  5 revisiones porque nadie llegaba a `lint`—. **Correr las partes de un gate no es correr el gate**,
  y en este repo `lint` va PRIMERO.

### Mutantes de W3 y W4 — aplicados, rojo observado, restaurados con `cp` + `/usr/bin/diff`

Copias pristinas en un directorio propio del scratchpad (`w366w3/`).
⛔ Ninguno se restauró con `git checkout --`. Cada restauración se verificó con `/usr/bin/diff` vacío.

| # | Mutante | Rojo observado |
|---|---|---|
| **M-C5** 🔴 | `gateway-kyc-client.ts`: **borrar el chequeo de slug** de `invocarPineado` | `authority.gateway.test.ts`: **1 failed** — `expected true to be false` sobre `r.authorized`. O sea: **el mutante AUTORIZA UN DESEMBOLSO** contra `evil-kyc`. Y `gateway-kyc-client.test.ts`: 2 failed más |
| M1 | `kyc-transport.ts`: invertir el default de la bandera | **9 failed / 7 passed** (T-C1 ausente/direct + 7 filas de T-C3) |
| M2 | `kyc-transport.ts`: `.toLowerCase()` antes de comparar | **2 failed / 14 passed** — las filas `"GATEWAY"` y `"Gateway"` |
| M3 | `gateway-client.ts`: `bridged` enumera sólo `"LLM"` (fail-OPEN) | **6 failed / 66 passed** entre los dos archivos: T-A1.1d + 5 filas de T-C6 |
| M4 | `gateway-client.ts`: reordenar las claves de la variante `capability` | **3 failed / 33 passed** — T-C1b y los dos asserts de forma del step |
| M5 | `gateway-kyc-client.ts`: emitir `capability` en vez de `agent` | **2 failed / 58 passed** — las dos ramas de T-C4 |
| M6 | `gateway-kyc-client.ts`: ignorar `bridged` | **7 failed / 53 passed** — T-C6 (6 filas) + el `it` de bridge de `authority.gateway` |
| M7 | `gateway-kyc-client.ts`: `identityRef ?? null` en vez de omitir la clave (P-4) | **1 failed / 35 passed** — T-C11 |
| M8 | `authority.ts`: el viaje sale SIN credencial (equivale a mover el Guard 3 detrás del `fetch`, P-7) | **2 failed / 22 passed** — las dos filas de T-C10 (`direct` y `gateway`): el contador de `fetch` deja de ser 0 |
| M9 | `authority.ts`: mandar el claim CRUDO en vez del canonicalizado | **1 failed / 23 passed** — la calibración de T-C10 |
| M10 | `gateway-kyc-client.ts`: `Boolean(raw.payoutAllowed)` en vez de `readBoolean` | **1 failed / 35 passed** — T-C8: el STRING `"true"` deja de tirar |
| M11 | escribir `remit-kyc-session` en un SEGUNDO módulo de producción | **1 failed / 5 passed** — T-KGS-1 |
| M12 | un segundo importador de `kycAgentUrl` | **1 failed / 5 passed** — T-KGS-3 |
| M13 | `smoke-kyc-helpers.ts`: la fila por DEFECTO de la escalera devuelve PASS | **2 failed / 54 passed** — tras corregir el test (ver la entrada de arriba; antes mataba sólo 1, y no el que decía) |
| M14 | `deriveInput` deja de leer su argumento (cuerpo hardcodeado) | **6 failed / 49 passed** — el caso del `enum`, el del enum invertido, y los de no-derivable |

**14 de 14 mutantes matan.** El único que exigía un desenlace concreto por escrito —M-C5, *"borrar el
chequeo de slug tiene que AUTORIZAR UN DESEMBOLSO"*— lo cumple: el rojo es `r.authorized` pasando de
`false` a `true`, no un código interno.

---

# FIX-PACK DEL AR — BLQ-ALTO-1 (2026-08-26)

### [2026-08-26 12:15] Fix-pack — El par `(slug, registry)` que N3 comparaba lo publica cualquiera
- **Error**: el docblock de `EXPECTED_REGISTRY` afirmaba que el par *"no es forjable desde el card de
  un candidato federado"*. Es **falso**: `POST /agents` del Coordinador es auth-only y el slug de
  `a2a_agents` es PK global primero-que-llega sin scoping por owner; una fila self-published nace
  además con `registry:"self-published"` HARDCODEADO ⇒ apropiarse del slug regala el registry. Los
  tres niveles del pin caían con una llamada HTTP y sin permisos especiales.
- **Causa raíz**: se tomó por infalsificable un dato **elegido por el publicador**. La distinción que
  faltaba: qué campos del card los *elige* quien publica y cuáles tienen *consecuencia física*.
  `slug` y `registry` son nombres; `invokeUrl` es a dónde el Coordinador HABLA de verdad.
- **Fix**: N3 pasa a cruzar el **origen** de la `invokeUrl` del ejecutor contra `KYC_AGENT_BASE_URL`,
  una env del DEPLOY. Módulo puro nuevo `src/infrastructure/kyc/agent-origin.ts`. El par se conserva
  como cinturón, con su alcance real escrito (caza la degradación al fanout federado, que no necesita
  atacante) y con la prohibición explícita de volver a llamarlo "no forjable".
- **Aplicar en**: **todo guard cuyo lado derecho salga del mismo lugar que el dato que verifica.**
  Si los dos lados de una comparación los controla la misma parte, la comparación no verifica nada.
  El lado derecho tiene que venir del deploy, no del catálogo.

### [2026-08-26 12:20] Fix-pack — El mutante mataba el test de la función, y NO el del desembolso
- **Error**: escribí `sameOrigin` con su suite, y en producción puse la comparación **inline**
  (`originOf(ref.invokeUrl) !== esperado`). El mutante `===` → `endsWith` sobre `sameOrigin` mató
  `agent-origin.test.ts` (3 rojos) y dejó **VERDE** `authority.gateway.test.ts`.
- **Causa raíz**: la función que el test puro vigilaba **no era la que decidía la plata**. Un test de
  unidad verde sobre una función que ningún consumidor llama es exactamente un guard vacuo.
- **Fix**: producción pasa por `sameOrigin`, la misma función. Re-medido: el mutante ahora mata en los
  **tres** niveles (pieza pura, transporte y desembolso) y también en la sonda.
- **Aplicar en**: **el mutante no se aplica al test, se aplica al CAMINO.** Antes de creerle a un test
  de unidad, mutá la función y mirá si el test del efecto que importa también se pone rojo. Si no, el
  consumidor tiene una copia y hay dos implementaciones que se van a desincronizar.

### [2026-08-26 12:35] Fix-pack — Agregar un campo al ref del ejecutor FILTRÓ la URL interna al browser
- **Error**: puse `invokeUrl` dentro de `GatewayAgentRef`. `npm run qa` se puso rojo con
  `expect(raw).not.toContain("interno.example.com")` en `app/api/a2a/quote/route.test.ts` y con el
  `toEqual` del agente en `app/api/payout/prepare/route.test.ts`.
- **Causa raíz**: las dos rutas hacen `{ agent: r.agents[0] }` **sin proyectar campo por campo**, así
  que *toda* clave agregada a ese tipo sale por HTTP al navegador. Yo estaba mirando el tipo, no sus
  consumidores.
- **Fix**: el dato vive en `invokeUrls`, un arreglo **paralelo** que las rutas no ecoan, con su lector
  propio (`readInvokeUrl`). No es "acordarse de borrarla en dos lados": es que no pueda estar. Se
  agregó el test que lo fija, incluido un `JSON.stringify(...).not.toContain(host)` para que no se
  arregle editando el `toEqual`. Mutante verificado: reponer el campo adentro del ref ⇒ **3 rojos**,
  los dos de las rutas y el nuevo.
- **Aplicar en**: **antes de agregar un campo a un tipo, buscá quién lo serializa entero.** Un tipo
  que se ecoa sin proyección es una superficie pública, aunque se llame "interno".

### [2026-08-26 12:40] Fix-pack — «No pude verificar» iba a salir como una ACUSACIÓN a producción
- **Error**: al agregarle a la sonda la comparación de origen, sin `KYC_AGENT_BASE_URL` el
  `assertExecutor` rechaza (correcto, fail-closed) y la escalera lo habría clasificado como
  **SUPLANTACIÓN (exit 6)** — o sea, un hallazgo FABRICADO por una env NUESTRA que falta.
- **Causa raíz**: fail-closed y atribución de causa son dos cosas distintas. Rechazar está bien;
  decir *por qué* rechazó es lo que hace que un exit code sirva.
- **Fix**: `agentOriginKnown` en la observación, fila propia en la escalera ⇒ **CONFIG (3)**, y corte
  en `main()` **antes del primer POST** (cada `/compose` se cobra: no se paga por una medición que no
  se va a poder afirmar). Es el mismo patrón que ya tenía `selfTestFieldPresent`.
- **Aplicar en**: toda sonda que sume una precondición de verificación. La pregunta es *"¿el rojo que
  esto produce acusa a producción o a mi configuración?"*, y la respuesta va en una fila propia.

### [2026-08-26 12:45] Fix-pack — Mis inserciones rompieron 7 citas ancladas, y con TRES deltas distintos
- **Error**: `npm test` de B y `qa` de C se pusieron rojos con 4 guards de citas: `cited-lines-guard`
  (3), `ownership-filter-guard` (3, G-08 + G-09) y `citas-ancladas` de C (2, dos veces seguidas —
  una por la primera edición y otra por el refactor a `invokeUrls`).
- **Causa raíz**: **ninguna de las 7 citas apuntaba a código que yo tocara.** Las rompió el
  DESPLAZAMIENTO. Y el detalle que importa: los deltas **no eran iguales entre sí** —
  `registry.ts` corrió +53 para `list`/`getWithSecrets` y **+62** para `getEnabled`, porque entre
  medio está el guard nuevo dentro de `register`.
- **Fix**: cada cita se re-derivó **abriendo el archivo** (`sed -n`), nunca copiando el número que
  sugería el mensaje del guard —que él mismo advierte que dice dónde está la needle, no que la prosa
  siga siendo cierta— y **nunca** propagando un delta único a un grupo. Se corrigieron también los
  rangos de docblock citados en la prosa de las excepciones (`:165-170`→`:218-224`, etc.), que ningún
  guard verifica y habrían quedado falsos en silencio.
- **Aplicar en**: toda edición que inserte líneas ARRIBA de algo citado. ⛔ Un solo delta para varias
  citas del mismo archivo es incorrecto por defecto si tu diff tocó más de un punto del archivo.

### [2026-08-26 12:50] Fix-pack — Un mock parcial de módulo apagó el guard nuevo con un 500 opaco
- **Error**: `registries.ssrf.test.ts` y `registries.test.ts` doblan `../services/registry.js` con una
  factory que **enumera** sus exports. El `isReservedRegistryName` nuevo llegaba `undefined` al
  handler ⇒ TypeError ⇒ **5 tests en 500** con el mensaje `expected 500 to be 422`, que no nombra la
  causa.
- **Causa raíz**: una factory que enumera es una lista que envejece con cada export nuevo del módulo.
- **Fix**: `importOriginal` y doblar **sólo `registryService`**. `isReservedRegistryName` corre REAL:
  es puro, y un `vi.fn()` que devuelva `undefined` habría dejado el guard del namespace apagado en
  todo el archivo sin que nada se pusiera rojo. **Se dobla la BASE, no la aritmética.**
- **Aplicar en**: cualquier `vi.mock` con factory enumerativa sobre un módulo al que le agregás un
  export. Y en general: si el símbolo nuevo es puro, no lo dobles.

### [2026-08-26 12:55] Fix-pack — El quinto importador puso rojo un candado, y eso era lo correcto
- **Error (no fue error, fue decisión)**: `T-KGS-3` fija en CUATRO los importadores de
  `resolveKycAgentBaseUrl`. El transporte por gateway necesita esa fábrica y lo puso en cinco ⇒ rojo.
- **Causa raíz**: el candado es una FOTO declarada, y su propio docblock dice *"si mañana hay un
  quinto, hay que decidir si es legítimo, no editarlo de reflejo"*.
- **Fix**: se agregó el quinto **con su motivo escrito** y nombrando la categoría nueva (no es un
  preflight ni un compositor de URL: es el verificador del ejecutor). ⛔ Se rechazó la alternativa
  cómoda —leer `process.env.KYC_AGENT_BASE_URL` a mano en el transporte—, que habría esquivado el
  candado **sin ponerlo rojo** y roto la regla de una sola fuente de `agent-env.ts`. Se prefirió el
  quinto importador VISIBLE a una segunda fuente invisible.
- **Aplicar en**: cuando un candado de conteo se pone rojo, la pregunta no es "cómo lo evito" sino
  "¿es legítimo?". La salida que no lo pone rojo suele ser peor que la que sí.

### [2026-08-26 13:00] Fix-pack — Reservar `self-published`: se midió ANTES de reservar
- **Contexto**: `POST /registries` no tenía blocklist y el namespace sintético del gateway estaba
  libre. Reservarlo puede romper una fila existente.
- **Medición previa** (catálogo VIVO de Railway, 2026-08-26, sólo lecturas):
  `GET /registries` → `total: 1`, única fila `wasiai`; `GET /registries/self-published` → **404**.
  ⇒ cero filas afectadas.
- **Status elegido**: **400**, y no un 409 nuevo. Derivado de cómo responde HOY el otro rechazo por el
  `name` —la colisión de PK— que sale por el `catch` del handler como 400 `Failed to register
  registry`. Estrenar un código para un rechazo de la misma familia le cambia la forma del error a un
  caller por un motivo que no le importa.
- **Precedencia medida, no asumida**: `' self-published '` NO sale del service como "reserved" — el
  guard de whitespace de borde (DT-23.4) corre antes. Se dejó escrito en vez de reordenar un guard
  preexistente; por la RUTA, que es por donde entra un caller real, sí sale como "reserved" y
  **pre-cobro**, porque `validateRegisterBody` normaliza con `.trim()`.
- **Aplicar en**: ⛔ ninguna reserva/blocklist se escribe sin medir antes el estado vivo, y ningún
  status nuevo se estrena sin mirar cómo responde hoy el rechazo de la misma familia.

### Mutantes del fix-pack — aplicados, rojo observado, restaurados con `cp` + `/usr/bin/diff`

Copias pristinas en un directorio propio del scratchpad (`mut366/`). ⛔ Ninguno con `git checkout --`.
Todos re-corridos contra el código **FINAL** (el refactor a `invokeUrls` cambió el camino del dato,
así que las corridas previas al refactor no valían).

| # | Mutante | Rojo observado |
|---|---|---|
| **M-F1** 🔴 | `gateway-kyc-client.ts`: **borrar el bloque `2b`** (el chequeo de origen) | **17 failed / 64 passed**. En `authority.gateway.test.ts`, T-C5c da `expected true to be false` sobre `r.authorized` y `{authorized:true}` en 5 filas más ⇒ **el mutante AUTORIZA UN DESEMBOLSO** al impostor con el par perfecto. Es la reproducción exacta del BLQ-ALTO-1 |
| **M-F2** 🔴 | `agent-origin.ts`: `===` → `endsWith` sobre el host | **7 failed / 170 passed**, repartidos en los CUATRO archivos: `agent-origin.test.ts` (3), `gateway-kyc-client.test.ts` (2), `authority.gateway.test.ts` (1, el del desembolso) y `smoke-kyc-helpers.test.ts` (1). ⚠️ Antes de cablear producción por `sameOrigin`, este mismo mutante daba **3 rojos y CERO en el desembolso** — ver la entrada de las 12:20 |
| M-F3 | `agent-origin.ts`: `parsed.origin` → `parsed.hostname` | **2 failed / 26 passed** — el puerto no-default y el `http:` contra deploy `https:` |
| **M-F4** 🔴 | `gateway-client.ts`: reponer `invokeUrl` **dentro** de `GatewayAgentRef` | **3 failed / 167 passed** — el test nuevo del transporte **y las dos rutas que ecoan al browser**. Es el mutante que fija que la separación en `invokeUrls` es el control, no un detalle de estilo |
| M-F5 | `routes/registries.ts`: sacar el check reservado **pre-cobro** (dejarlo sólo en el service) | **4 failed / 19 passed** — las cuatro filas de T-NCR-19. ⚠️ **La razón que decía acá era falsa** (corregida en el fix-pack del CR, MNR-2, re-midiendo): NO muere «por los contadores con el status en 400». En ese archivo `registryService` está DOBLADO, así que el guard del service no corre y el POST **sale 201**; muere en el PRIMER assert, `expect(res.statusCode).toBe(400)`, con `expected 201 to be 400`, y los contadores quedan `debit` 1 · `credit` 0 · balance 10 → 9 · `mockRegister` 1. El mutante para el que «el contador, no el status» SÍ es la razón correcta es **M-F5b** |
| **M-F5b** (nuevo, fix-pack CR/MNR-2) | `routes/registries.ts`: el check reservado corre **POST-cobro** (sacarlo de `registerBodyCheck`, dejar sólo la llamada defense-in-depth del handler) | **4 failed / 19 passed** — mismas filas, otra aserción: status `400` y el mensaje `reserved` INTACTOS (los dos primeros asserts PASAN) y muere en `expect(debitMock).not.toHaveBeenCalled()`. Es el único mutante que justifica que T-NCR-19 viva en el archivo que corre el middleware de pago de verdad |
| M-F6 | `services/registry.ts`: comparar el `name` CRUDO (sin normalizar) | **5 failed / 38 passed** — las variantes en mayúsculas y con espacios, que producen el MISMO PK por otro camino |

**7 de 7 matan** (6 + el M-F5b que agregó el fix-pack del CR), y los dos que tenían un desenlace
exigido por escrito lo cumplen: M-F1 autoriza un desembolso, y M-F4 filtra la URL interna al
navegador.

### [2026-08-26 13:05] Fix-pack — MNR-1 y MNR-2: lo que NO se cambió, y por qué
- **MNR-1** (`decisionToken` alcanzable por el retry con LLM si un step de KYC deja de ser índice 0):
  **cero cambio de comportamiento**, por diseño del fix-pack. Se agregó al docblock de
  `invocarPineado` la cadena completa medida —`fieldErrors` del `.flatten()` ⇒ el parser del
  Coordinador matchea; lo único que lo vuelve inalcanzable es que `stepDebitedUsd > 0` exige `i > 0`—
  para que la próxima persona sepa **qué está sosteniendo la línea "exactamente un step"** antes de
  agregarle un segundo. La mitigación de fondo (excluir `AUTHORIZATION_CAPABILITIES` del camino
  `willRetry`) vive del lado del Coordinador y queda fuera de alcance.
- **MNR-2**: **no se recortó nada**, y **T-B9 se queda**. El AR verificó que no es duplicado: además
  de la mayúscula ejercita el whitespace atravesando la ruta entera hasta el 400 pre-débito. La
  propuesta de recortarlo que había hecho el Dev queda retirada.

---

## Fix-pack 2 — los MENORes de la ronda 2 del AR

### [2026-08-26 12:39] Wave única — MI comentario nuevo falsificó la afirmación que ese mismo comentario hacía
- **Error**: al documentar en `registry.ownership.test.ts` por qué la cita re-apuntada **no** se da de
  alta en `CITED_LINES`, escribí la razón medida: *«`scanSource` sobre ESTE archivo devuelve sólo
  tokens `:00` de un timestamp»*. Re-medí después de escribirla: **3 tokens, no 2**. El tercero era el
  literal `` `:00` `` de mi propia frase, que el escáner leyó como una cita en forma P3.
- **Causa raíz**: la afirmación era sobre un archivo, y yo la escribí **adentro** de ese archivo. Es la
  variante de escritura del defecto «controles que se leen a sí mismos»: un enunciado que se cita a sí
  mismo como ejemplo cambia el conjunto que está describiendo. La medición previa era correcta; lo que
  la invalidó fue publicarla.
- **Fix**: sacar el token del texto y describir el hallazgo sin escribirlo (*«sólo los falsos positivos
  de un timestamp ISO — cero citas reales»*). Re-medido: vuelve a **2**, y ahora la frase es cierta.
- **Aplicar en**: **toda prosa que cite un número derivado de un escaneo del archivo donde se escribe**.
  El costo de no verlo no es un número feo: es una frase falsa cuya falsedad la causó el propio acto de
  escribirla, o sea que la medición que la respalda es de un mundo que ya no existe. La regla operativa:
  si el enunciado es sobre el archivo actual, **re-derivalo DESPUÉS de guardar**, nunca antes.

### [2026-08-26 12:41] Wave única — el AR listó 2 sitios de eco, y son 6
- **Error**: iba a arreglar MNR-4 exactamente donde el AR lo señaló (`smoke-kyc-helpers.ts:192` y
  `:197`) y cerrar. Antes de hacerlo barrí el archivo entero buscando la MISMA clase de eco.
- **Causa raíz**: MNR-4 no denuncia dos líneas, denuncia **una regla enunciada y no aplicada**.
  Arreglar sólo los sitios que el AR alcanzó a nombrar deja la regla igual de falsa y reproduce el
  defecto un nivel más arriba — es literalmente «verificar los sitios que arreglaste no es verificar
  el claim».
- **Fix**: cuatro sitios más, todos con string de dueño ajeno llegando al **stdout del operador** por
  la cadena `Check.reason → verdict.message → process.stdout.write`:
  `assertOutputKeys` (claves de más del output), `ladder` (`derive.field`/`derive.detail`, nombres de
  propiedad del `inputSchema` publicado), `ladder` (`decisionRequired.faltan`), `claseDeHttp` (`code`
  del cuerpo de la respuesta) y `emitir` en `smoke-kyc-via-gateway.ts` (`omitted`, también nombres de
  propiedad publicados). Los cuatro primeros con testigo propio y mutante 1-a-1.
- **Aplicar en**: cualquier MENOR redactado como «acá pasa X». **Buscar X en todo el módulo antes de
  tocar la línea citada**; la lista del revisor es una muestra, no el censo.

### [2026-08-26 12:42] Wave única — `emitir` quedó arreglado y SIN testigo, y se declara
- **Error**: no hay test sobre la sanitización de `omitted` en `smoke-kyc-via-gateway.ts`.
- **Causa raíz**: `emitir` no está exportada, así que ningún test la puede invocar. Exportarla sólo
  para poder medirla es un cambio de superficie que este fix-pack de MENORes no tiene mandato de hacer.
- **Fix**: **ninguno** — se deja escrito acá en vez de tapado. Lo que sí está medido a fondo es
  `safeEcho` (17 filas nuevas + 4 mutantes); lo que queda sin medir es la única afirmación restante, «está
  aplicada en esa línea», que se verifica leyéndola.
- **Aplicar en**: todo arreglo en una función no exportada de un script. Si no se puede medir, **se
  declara**; un arreglo sin testigo presentado junto a otros que sí lo tienen se lee como medido.

### Mutantes del fix-pack 2 — aplicados, rojo observado, restaurados con `cp` + `/usr/bin/diff`

Copia pristina propia en el scratchpad. ⛔ Ninguno con `git checkout --`. Base verde:
`smoke-kyc-helpers.test.ts` **85 passed (85)**.

| # | Mutante | Rojo observado |
|---|---|---|
| **M-G1** 🔴 | `safeEcho` → `return String(v)` (el arreglo entero) | **13 failed / 69 passed**. El mensaje de vitest imprime el string hostil ENTERO dentro del `reason` — la reproducción literal de MNR-4 |
| M-G2 | quitar **sólo** el techo de largo (charset intacto) | **3 failed / 79 passed** — las dos calibraciones del borde y la fila de 5.000 caracteres. Prueba que las dos mitades del arreglo se miden por separado |
| M-G3 | abrir la lista blanca hacia arriba (`cp >= 0x20`, sin techo `0x7e`) | **4 failed / 78 passed** — C1 crudo, override RTL, homoglifo cirílico y el combinado. Prueba que «no-ASCII cae» es una decisión medida y no un efecto colateral |
| M-G4 | quitar `safeEcho` de los **tres sitios que el AR no listó** | **3 failed / 82 passed**, **uno por sitio**: `derive.field`/`detail`, `decisionRequired.faltan` y el `code` del 402. Correspondencia 1-a-1 ⇒ ningún testigo es vacuo ni redundante |

**4 de 4 matan.** Restauración verificada con `/usr/bin/diff` contra la copia pristina en cada vuelta
(salida vacía) y la suite del archivo vuelve a **85 passed** antes de aplicar el siguiente.

---

## Fix-pack del CR (2026-08-26) — 6 MENORes, 0 bloqueantes

### [2026-08-26 13:20] Wave única — MNR-5: el campo que sostiene el cierre del BLOQUEANTE no tenía candado del lado que lo PRODUCE
- **Error**: `steps[i].agent.invokeUrl` viajaba en la respuesta de `POST /compose` **sólo porque el
  handler responde `...result` sin proyectar**. Nada en `wasiai-a2a` lo fijaba. Medición **del estado
  ANTES del fix** (⚠️ no la repitas esperando el mismo número: el propio fix la volvió vieja, y el
  docblock de T-B11 explica por qué el grep hoy se cuenta a sí mismo): `grep "agent.invokeUrl"
  src/routes/compose*.test.ts` ⇒ **0 hits**; los **18** hits de `invokeUrl` en esos 9 archivos eran
  **todos fixtures**, ninguna aserción; y `doc/INTEGRATION.md` no nombraba el campo.
- **Causa raíz**: el guard que cierra `BLQ-ALTO-1` vive **entero en el otro repo**
  (`chaski-v3/src/infrastructure/kyc/gateway-kyc-client.ts:235`, que lee lo que
  `src/infrastructure/a2a/gateway-client.ts:308-313` extrae de la respuesta HTTP). Se verificó el lado
  que CONSUME y nunca el que PRODUCE. Modo de falla clásico de este ecosistema: *"una capacidad que
  cruza servicios no existe hasta que los DOS la reconocen"*.
- **El escenario, no hipotético**: alguien acá proyecta `agent` para no filtrar la URL interna del
  agente — un endurecimiento **razonable**, y Chaski tuvo ese incidente exacto en esta misma HU (por eso
  su lector vive en un arreglo paralelo). Resultado: `readInvokeUrl` ⇒ `null` ⇒ `sameOrigin(null,…)`
  falso ⇒ **502 en todos los desembolsos por gateway**, con los gates de los DOS repos en verde.
- **Fix**: (1) `T-B11` en `src/routes/compose.capability.test.ts` — DOS steps, aserción sobre el
  **valor** de `invokeUrl` (no `toBeDefined()`: un `""` del otro lado se trata como ausencia), con el
  motivo cross-repo, los consumidores y **lo que el test NO mide** escritos en el docblock; (2) sección
  nueva en `doc/INTEGRATION.md` (§3, *"which agent actually ran a step"*) que declara `slug`,
  `registry`/`registry_id`, `invokeUrl` y `verified` como contrato publicado, con el porqué y las dos
  consecuencias operativas.
- **Mutante M-H1** (proyectar `agent` en el `reply.send` de `routes/compose.ts` para omitir
  `invokeUrl`): **1 failed / 161 passed** corriendo las **9** suites de `src/routes/compose*`, con
  `AssertionError: expected undefined to be 'https://x.test/remit-kyc-session'`. Rojo en **exactamente
  un** test ⇒ T-B11 es el único testigo del campo en todo el repo, y no es redundante con nada.
  Restaurado con `cp` + `/usr/bin/diff` (salida vacía).
- **⚠️ Lo que este testigo NO cubre, medido y escrito en su docblock**: que el *service* pueble el
  campo. **Las 9 suites de la ruta doblan `services/compose.js`** — no hay ninguna que no lo haga, así
  que "elegir una que no doble el service" no era una opción disponible. Lo que sí mide es la
  proyección del handler, que es donde el mutante entra. La otra mitad tiene candado de **compilación**
  y no de test: `StepResult.agent` es `Agent` y `Agent.invokeUrl` es `string` no opcional, y el fixture
  de T-B11 se tipa `StepResult` a propósito para heredarlo.
- **Aplicar en**: todo campo de una respuesta HTTP del que dependa un guard de OTRO repo. El testigo va
  **en el repo que lo emite**, y la doc pública es la que convierte "detalle interno" en "contrato".

### [2026-08-26 13:35] Wave única — MNR-2: el mutante documentado moría por la razón EQUIVOCADA
- **Error**: el docblock de `src/routes/registries.no-charge-before-validating.test.ts` y la fila
  **M-F5** de este mismo archivo afirmaban que sacar el check reservado del pre-cobro mata T-NCR-19
  *"con el status todavía en 400, por los contadores"*. **Falso.**
- **Medido aplicando el mutante** (no leído del reporte del CR): en ese archivo `registryService` está
  **doblado** (`mockRegister`), así que el guard del service (`services/registry.ts`, `is reserved`)
  **no corre nunca** y el POST **sale 201**. Las 4 filas mueren en el PRIMER assert,
  `expect(res.statusCode).toBe(400)`, con `expected 201 to be 400`. Contadores sondeados en la misma
  corrida: `debit` **1** · `credit` **0** · balance **10 → 9** · `mockRegister` **1** — o sea que el
  *"1 y 1"* del texto viejo era falso en las dos cifras.
- **Causa raíz**: se escribió el efecto que el mutante *debería* tener según el diseño (pre-cobro ⇒ los
  contadores son la afirmación) sin correrlo contra ESTE archivo, donde el doble cambia el desenlace.
  Es la misma clase que la lección de instrumento: **la razón por la que un test muere es una medición,
  no una deducción del diseño.**
- **Fix**: docblock reescrito con los DOS mutantes y la aserción exacta en la que muere cada uno, y la
  fila M-F5 corregida acá. Los asserts se nombran **por su texto** y no por su línea, porque el número
  se mueve al editar el propio comentario que lo cita.
- **M-F5b, el mutante que faltaba** (el check corre pero POST-cobro: sacarlo de `registerBodyCheck` y
  dejar sólo la llamada defense-in-depth del handler): **4 failed / 19 passed**, status `400` y mensaje
  `reserved` INTACTOS —los dos primeros asserts PASAN— y muere en
  `expect(debitMock).not.toHaveBeenCalled()`. **Ése** es el mutante para el que *"el contador, no el
  status"* es cierto, y es el único que justifica que T-NCR-19 viva en el archivo que corre el
  middleware de pago de verdad.
- **No se agregó nada en `registry.ownership.test.ts`**: ya existe el testigo del guard del service, el
  `it.each` **`rejects the reserved namespace`** (3 filas, service real). Lo que faltaba era el puntero,
  y ahora está.
- **Aplicar en**: todo comentario que diga «este mutante mata por X». Correrlo. Y antes de afirmar qué
  discrimina un archivo de ruta, mirar **qué tiene doblado**.

### [2026-08-26 13:45] Wave única — MNR-3 / MNR-4: tres sitios, tres números, la misma superficie
- **Error**: `kyc-gateway-slug-count.static.test.ts` titulaba *"los CUATRO módulos declarados"* sobre un
  bucle de **cinco rutas distintas / seis vueltas** (el fix-pack del AR agregó el quinto importador en
  esta misma HU); y `authority.gateway.test.ts` decía *"las otras TRES formas"* sobre **cuatro filas de
  dos categorías** — un conjunto que el resto del fix enumera como **cuatro** (ramas 2 y 2b de
  `invocarPineado`) y como **cinco** (docblock de `assertExecutor`).
- **Causa raíz**: un número en un título es un dato derivado guardado a mano. Se pudre solo, y encima
  **no era comprobable**: tres sitios cortan la misma superficie con granularidades distintas, así que
  ningún número podía contrastarse con los otros.
- **Fix**: los tres anclados en el CRITERIO, siguiendo el exemplar
  `kyc-provider-residue.static.test.ts` (*«EL NÚMERO NO ES EL CRITERIO Y ENVEJECE SOLO»*): *"TODA ruta
  declarada en las dos listas"*, *"el `registry` no es el nuestro, o el `agent` no se puede leer"*, y
  *"cualquier cosa que no sea: el catálogo dijo que ejecutó NUESTRO agente, en NUESTRO host"*.
  ⛔ Explícitamente **no** se cambió el 4 por un 5.
- **Queda anotado, no arreglado**: el `it` vecino *"`resolveKycAgentBaseUrl` se importa desde EXACTAMENTE
  los CINCO módulos declarados"* tiene el mismo defecto de forma, pero su número es **cierto hoy** y el
  CR no lo nombró. Cambiarlo era ensanchar el diff de un fix-pack de MENORes.
- **Aplicar en**: todo título de test con un cardinal. Si el número se puede derivar de la lista que el
  test recorre, el título no lo repite.

### [2026-08-26 13:50] Wave única — MNR-6: la única deuda que vivía sólo en un reporte de OTRO repo
- **Error**: la deuda de `emitir()` (recibió `safeEcho` y no tiene testigo) estaba declarada **sólo** en
  este `auto-blindaje.md`, que vive en `wasiai-a2a` mientras el código vive en `chaski-v3`.
- **Causa raíz**: un documento de cierre no llega al clone del que toca el archivo. Precedente textual
  del ecosistema: `wasiai-remittance-agents/src/app/api/agents/remit-kyc-validator/decision/route.ts`
  — *«ESTA DEUDA VIVE ACÁ A PROPÓSITO… la fuente autoritativa es este comentario»*.
- **Fix**: docblock `TD-366-EMITIR-SIN-TESTIGO` sobre `emitir` en
  `chaski-v3/scripts/smoke-kyc-via-gateway.ts`, que dice qué **no** está medido (el uso de `safeEcho` en
  esa línea; la función pura sí lo está), qué mutante **no pone rojo nada**, y el arreglo barato.
  Verificado: el módulo exporta `main` y `EXIT` y nada más, y **ningún archivo del repo lo importa**
  (única referencia: el script `smoke:kyc-gateway` de `package.json`).
- **Aplicar en**: toda deuda de un repo declarada en el artefacto de otro. La fuente autoritativa va
  donde está el código.

### [2026-08-26 13:55] Wave única — el gate cazó lo que el Dev no: `lint` es el SEGUNDO eslabón
- **Error**: `T-B11` se escribió con una línea de 82 columnas que biome reformatea. `tsc` daba 0 y la
  suite del archivo daba 21/21 **verde**; `npm run lint` dio **exit 1**.
- **Causa raíz**: se corrió el sub-gate cómodo (vitest sobre el archivo tocado) antes que el gate.
- **Fix**: reformateado a mano, `git add`, y la secuencia completa **`tsc → lint → test`** corrida de
  nuevo entera y en orden sobre el índice ya actualizado.
- **Aplicar en**: es la enésima repetición de *"correr las PARTES de un gate no es correr el gate"*. Un
  archivo nuevo o una línea larga en `src/**` se lintean; los de `test/**` no (el `lint` de este repo es
  `biome check src/`).

### Presupuesto de escala re-medido al cerrar el fix-pack del CR (CD-16) — PARA `nexus-docs`
`/usr/bin/git diff --stat HEAD` en cada worktree, con **cero commits** en las tres ramas ⇒ el stat es la
HU entera. ⛔ Nunca bajo el hook `rtk`.

| Repo | Presupuesto SDD §11 (techo) | Insertions AHORA | **Ratio** | Δ de este fix-pack |
|---|---|---|---|---|
| **A** `wasiai-remittance-agents` | 450–800 | **1457** (13 archivos, −8) | **1.82x** | **0** — no se tocó |
| **B** `wasiai-a2a` | 150–400 | **1043** (18 archivos, −38) | **2.61x** | **+169** (INTEGRATION.md 38 · `compose.capability.test.ts` 109 · `registries.no-charge-before-validating.test.ts` 22) |
| **C** `chaski-v3` | 800–1400 | **3801** (25 archivos, −63) | **2.72x** | **+38**, todo prosa (5 · 8 · 8 · 17) |

⚠️ **El 2.18x que el CR le puso a B (MNR-1) era correcto CUANDO SE MIDIÓ y hoy está viejo: son 2.61x**,
porque el propio fix-pack del CR le agregó 169 líneas — 147 de ellas son el testigo cross-repo de MNR-5
y su declaración pública, que es el hallazgo más caro de la HU. Es el mismo fenómeno que MNR-1 describe
(un número que el fix-pack anterior volvió viejo) aplicándose una vuelta más. **Los tres exceden el
techo**; los tres exhiben la misma razón, escrita en el SDD §11 y confirmada acá: el presupuesto contó
código de producción y lo que domina el diff son los **testigos** (en B, 8 de los 18 archivos son
`*.test.ts` y aportan **772** de las 1043 insertions — derivado con `git diff --numstat`, no estimado). Docs: **tomar estos números de acá, no del CR.**

### Gates del fix-pack — corridos ENTEROS, EN ORDEN, y serializados (un repo por vez)

| Repo | Gate | Resultado |
|---|---|---|
| **A** `wasiai-remittance-agents` | `typecheck` → `test` → `build` | **no re-corrido**: cero diff en este fix-pack. Última medición conocida (CR): typecheck 0 · **846 / 34** · build 0 |
| **B** `wasiai-a2a` | `npx tsc -p tsconfig.json --noEmit` → `npm run lint` → `npm test` | **exit 0 / 0 / 0**. biome **516 files**. Suite **6290 passed · 19 skipped (6309)** · **310 test files passed · 6 skipped (316)**. Es **+1 test** exacto contra la medición del CR (6289): T-B11 |
| **C** `chaski-v3` | `npm run qa` → `npm run build` | **exit 0 / 0**. `qa` = lint (biome, **289 files**) → `tsc --noEmit` → `tsc -p tsconfig.scripts.json --noEmit` → vitest **3285 passed (3285)** · **160 test files (160)**. Idéntico al CR: el fix-pack de C es 100% prosa |

⚠️ **`npm run qa` NO EXISTE en `wasiai-a2a`** — el gate de B son los tres comandos de
`.github/workflows/ci.yml`, en ese orden.
