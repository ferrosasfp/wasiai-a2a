# Auto-Blindaje — #230 · WKH-369 · F3 (Dev)

> Rama: `feat/230-wkh-369-detalle-capacidades-federadas` (desde `main` @ `18e4550`)
> Fecha: 2026-08-27

---

## 0. Línea base del gate, medida antes de tocar una línea (W0.1)

Corrida sobre el árbol limpio, en el orden de `.github/workflows/ci.yml`:

```
npx tsc -p tsconfig.json --noEmit  → "TypeScript compilation completed", exit 0
npm run lint                       → "Checked 516 files in 274ms. No fixes applied."
npm test                           → Test Files  310 passed | 6 skipped (316)
                                     Tests      6290 passed | 19 skipped (6309)
```

**Coincide exactamente con la del Story File §0.4.** Delta cero: el número no envejeció
entre F2.5 y F3.

---

## 1. CD-2 — los 14 rojos, cada uno con su mutación y su MOTIVO

Protocolo: aplicar la mutación → correr **sólo** el test afectado
(`vitest run <archivo> -t '<ID>'`) → copiar el rojo literal → restaurar con `cp` desde una
copia hecha **antes**, nunca con `git checkout --`.

Backup de sesión: `…/scratchpad/wkh369-f3/` (subdirectorio propio — ver §3, E-4).

> ⚠️ **LAS CITAS DE ESTA TABLA SON DEL ÁRBOL `6d1cb63`, NO DEL FINAL.** El fix-pack del
> AR/CR (§7) reescribió `src/services/agent-detail.ts` y le movió TODAS las líneas: hoy la
> asignación de `capabilities` está en `:103`, el `catch` en `:136` y el guard de
> self-published en `:90`. Las mutaciones se midieron contra `6d1cb63` y ahí valían; dejarlas
> sin fechar sería exactamente la clase de cita que el CR encontró cuatro veces en este mismo
> archivo. **Las citas contra el árbol final están en §7.**

| ID | `archivo:línea` mutado (árbol `6d1cb63`) | Mutación | Rojo REAL |
|---|---|---|---|
| **T-01** | `src/services/agent-detail.ts:60` | comentar `agent.capabilities = entrada.capabilities;` | `AssertionError: expected [] to deeply equal [ 'remittance', 'remit', 'kyc', …(1) ]` |
| **T-02a** | `src/services/agent-detail.ts:73` | comentar `agent.capabilitiesState = 'unresolved';` (rama 5b) | `AssertionError: expected undefined to be 'unresolved' // Object.is equality` |
| **T-02b** | `src/services/agent-detail.ts:60-70` | agregar `if (agent.capabilities.length === 0) agent.capabilitiesState = 'unresolved';` dentro de 5a | `AssertionError: expected true to be false // Object.is equality` |
| **T-02c** | `src/services/agent-detail.ts:49,75-78` | sacar el `try { … } catch { … }` (queda un bloque desnudo) | `Error: registro down` propagado, **no** un assert: `Error: registry down ❯ src/services/agent-detail.test.ts:302:7` |
| **T-03** | `src/services/agent-detail.ts:60` | la misma de T-01 (el paso 5a lee el payload de DETALLE) | `AssertionError: expected 1 to be +0 // Object.is equality` — o sea `difiere: 1` |
| **T-04** | `src/services/agent-detail.test.ts:337` | `const poblacion = SLUGS_MEDIDOS.length` (denominador = total) | `AssertionError: expected 25 to be 50 // Object.is equality` |
| **T-05** | `src/services/agent-detail.ts:60` | la misma de T-01 | `AssertionError: expected [] to have a length of 4 but got +0` |
| **T-06a** | `src/services/agent-detail.ts:65-69` | sacar la copia de `reputation` | `AssertionError: expected NaN to be 7 // Object.is equality` |
| **T-06b** | `src/services/discovery.ts:1500` ⚠️ **temporal** | `V2_PRICE_FALLBACK_FIELD = 'price_per_call_XXX'` | caso (a): `AssertionError: expected +0 to be 0.001 // Object.is equality` |
| **T-07a** | `src/services/discovery.ts:1381` ⚠️ **temporal** | agregar `capabilitiesState: 'unresolved' as const` al objeto que devuelve `mapAgent` | el string difiere: `Received` termina en `…"status":"active"},"capabilitiesState":"unresolved"}` contra un `Expected` que cierra en `…"status":"active"}}` |
| **T-07b** | idem T-07a | idem | `AssertionError: expected [ 'id', 'name', 'slug', …(13) ] to not include 'capabilitiesState'` |
| **T-08** | `src/routes/discover.ts:341` | volver a `discoveryService.getAgent(slug, registry)` | `AssertionError: expected [] to have a length of 4 but got +0` |
| **T-09** | `src/services/agent-detail.ts:47` | sacar el guard `agent.registry_id === SELF_PUBLISHED_REGISTRY_ID` | `AssertionError: expected "discover" to not be called at all, but actually been called 1 times` — ⚠️ **NO** el rojo que el Story File esperaba. Ver §2 |
| **T-10** | `src/services/agent-detail.ts:51` | `registry: agent.registry` (el NOMBRE) | `AssertionError: expected "discover" to be called with arguments: [ { registry: 'wasiai', …(1) } ]` · diff: `- "registry": "wasiai"` / `+ "registry": "WasiAI"` |

**Todos los rojos previstos por el Story File §7.2 salieron con el mensaje previsto, salvo
T-09** (§2). T-06a se midió **dos veces**: la primera contra la forma original de la línea, y
otra vez contra la forma final después del arreglo de `exactOptionalPropertyTypes` (§3, E-2),
porque un rojo medido sobre código que después cambió es un rojo de otro programa.

### Restauración de `src/services/discovery.ts` — probada, no supuesta (CD-11 / §7.3)

Después de cada mutación temporal (T-06b y T-07a/b), y otra vez al cerrar W3:

```
/usr/bin/git status --porcelain src/services/discovery.ts   → salida VACÍA
/usr/bin/git diff --stat src/services/discovery.ts          → salida VACÍA
sed -n '1500p' src/services/discovery.ts
  → const V2_PRICE_FALLBACK_FIELD = 'price_per_call' as const;
```

Y un barrido de restos: `/usr/bin/grep -rn "MUTANTE" src/` no devuelve ninguna línea escrita
por esta HU (los 19 aciertos son comentarios preexistentes de otros archivos).

---

## 2. ⚠️ El rojo de T-09 NO fue el que el Story File predijo — y el test estaba incompleto

- **Error**: el Story File §7.2 predice para T-09 el rojo `expected 1 to be 0`, o sea que la
  aserción que mata al mutante sería el contador de `mockFetch`. **Es falso, medido.**
- **Causa raíz**: sacando el guard de self-published, el resolver llama a
  `discover({ registry: 'self-published', includeInactive: true })`. Ese valor es
  **exactamente** `SELF_PUBLISHED_REGISTRY_NAME`, así que `discover()` entra por el merge
  **local** (el gate está en `discovery.ts:251` y la llamada a
  `publishedAgentService.listAsAgents()` en `:253`; `:249` era la declaración de
  `localAgents`, o sea el renglón vecino — CR MNR-1), `getWithSecrets`
  devuelve `undefined` y `registries` queda vacío ⇒ **cero fetch outbound**. El contador de
  `mockFetch` sigue en 0 y la aserción del Story File **pasa con el mutante puesto**.
- **Fix**: T-09 lleva DOS aserciones. La del contador (la que el Story File pide) se conserva
  tal cual, y se agrega `expect(discoverSpy).not.toHaveBeenCalled()`, que es la que
  efectivamente mata al mutante. El comentario en el test dice por qué no es redundante.
- **Aplicar en**: cualquier guard de *no pagar I/O* cuyo testigo cuente llamadas de RED. La
  llamada que el guard evita puede resolverse por un camino que no toca la red — y entonces
  el contador mide la ausencia de una consecuencia, no la del comportamiento. **Contá la
  llamada que el guard evita, no su efecto más visible.**

---

## 3. Errores propios de esta sesión

### [2026-08-27] W0 — `npx biome` no resuelve el ejecutable en este entorno
- **Error**: `npx biome check --write src/types/index.ts` salió con
  `npm error could not determine executable to run`, después de imprimir una salida parcial
  confusa (`Lint: 2 errors, 0 warnings`) que **no era de mi archivo**. Casi la leo como un
  fallo real de mi edición.
- **Causa raíz**: el paquete se llama `@biomejs/biome`; `npx biome` intenta resolver un
  paquete `biome` que no existe. `npm run lint` funciona porque el script del `package.json`
  usa el binario local.
- **Fix**: `./node_modules/.bin/biome check --write <archivos>` — directo, sin `npx`.
- **Aplicar en**: todo CD-14 de este repo. El Story File escribe `npx biome check --write` y
  **ese comando no corre acá**.

### [2026-08-27] W1 — dos errores de tipos que `vitest` no puede ver
- **Error**: con los 10 tests en VERDE, el paso 1 del gate dio dos `error TS`:
  1. `agent-detail.test.ts:221` (árbol `6d1cb63`) — el doble de `getWithSecrets` devolvía
     `null` y la firma real es `Promise<RegistryConfig | undefined>`.
  2. `agent-detail.ts` — `agent.reputation = entrada.reputation` con
     `exactOptionalPropertyTypes: true`: `number | undefined` no es asignable a `number`.
- **Causa raíz**: `vitest` transpila sin chequear tipos. **Diez tests verdes no dicen nada
  sobre `tsc`**, y el Story File manda correr el gate *desde el paso 1* justamente por esto.
- **Fix**: (1) el doble devuelve `undefined`. (2) La copia de `reputation` respeta la
  doctrina «omitido, no `null`» del repo: si la entrada de la lista no trae el campo, se
  **borra** del detalle en vez de escribirle `undefined`
  (`src/services/agent-detail.ts:104-112` en el árbol FINAL; era `:65-69` en `6d1cb63`, y este
  renglón decía `:61`, que ahí era un **comentario** — una cita de un estado transitorio del
  archivo, CR MNR-1). En la práctica la rama de borrado no se alcanza —
  `mapAgent` siempre produce `reputation` (puede ser `NaN`) — pero escribir
  `agent.reputation = undefined` habría publicado la clave con valor `null` tras el
  `JSON.stringify`, que es exactamente la ambigüedad que esta HU existe para matar.
- **Aplicar en**: cualquier asignación a un campo `?:` de `Agent`. El árbol compila con
  `exactOptionalPropertyTypes`, así que **copiar un opcional incluye copiar su ausencia**.

### [2026-08-27] W1 — el scratchpad compartido ya tenía un `discovery.ts.bak` de otra sesión
- **Error**: la primera copia de respaldo fue a la raíz del scratchpad, que ya contenía
  `discovery.ts.bak` (301 archivos de sesiones anteriores). Un `cp` de restauración desde el
  archivo equivocado habría **revertido `discovery.ts` a un estado ajeno** — y el
  `git status --porcelain` habría salido sucio sin que yo entendiera por qué.
- **Causa raíz**: el scratchpad es compartido entre sesiones del mismo proyecto.
- **Fix**: subdirectorio propio `…/scratchpad/wkh369-f3/`, y el respaldo se **verificó**
  contra el original con `/usr/bin/diff -q` antes de usarlo (`diff` a secas miente en este
  entorno: contesta `Files are identical` sobre archivos que difieren).
- **Aplicar en**: todo protocolo §7.3. **Un backup que no comparaste no es un backup: es un
  archivo con el nombre correcto.**

### [2026-08-27] W2 — el `import` que quedaba sin usar, y sí quedó sin usar
- **Error potencial evitado**: `src/routes/agent-card.ts` importaba
  `{ discoveryService, extractDeclaredTokenId }` del mismo módulo. Al reemplazar la única
  llamada a `discoveryService.getAgent` (línea 43), `discoveryService` quedó **huérfano**.
- **Causa raíz**: el Story File §W2b anticipaba que "se sigue usando" — pero lo que se sigue
  usando es `extractDeclaredTokenId`, que viene del mismo `import` **con otro nombre**.
  Verificado con `/usr/bin/grep -n 'discoveryService\|extractDeclaredTokenId'`: los únicos
  usos de `discoveryService` en ese archivo eran la línea 10 (el import) y la 43 (la llamada).
- **Fix**: el import se partió en dos: `resolveAgentForDetailView` de `agent-detail.js` y
  **sólo** `extractDeclaredTokenId` de `discovery.js`. En `src/routes/discover.ts`
  `discoveryService` **sí** se queda: lo usan los handlers de `GET`/`POST /discover`
  (`discover.ts:235` y `:305` en el árbol FINAL; este renglón decía «234 y 304», que eran
  correctas en `18e4550` y **las desplazó mi propio import** — CR MNR-1. Re-verificadas
  después del fix-pack, que agregó ~28 líneas de docblock pero **debajo**, en `:321-361`).
- **Aplicar en**: `tsc` y `vitest` son **ciegos** a un import sin usar; sólo lo ve `biome`, y
  `lint` va **segundo** en el gate. Es el modo de falla que ya sobrevivió 5 revisiones en este
  repo.

---

## 4. ❌ RETRACTADO — este renglón declaraba un VERDE que no existía (W3.5)

> 🔴 **Lo que decía este apartado era FALSO y el AR y el CR lo midieron los dos.** Se deja el
> texto original tachado porque borrarlo sería borrar la evidencia del error. La corrección
> vive en §7.0, y el gate real, verde, en §7.9.

Lo que este apartado afirmaba:

```
npm test → Test Files  312 passed | 6 skipped (318)
           Tests      6304 passed | 19 skipped (6323)
```

…y la tabla cerraba con `fallos | 0 | 0 | —`.

**Lo que salía de verdad en `6d1cb63`**, medido dos veces por el AR y una por el CR:

```
Test Files  1 failed | 311 passed | 6 skipped (318)
Tests       4 failed | 6300 passed | 19 skipped (6323)
exit 1
```

Los totales **coinciden** (`311 + 1 = 312`, `6300 + 4 = 6304`): no fue otra corrida, fue la
misma corrida con la línea `Tests` leída a medias. Ver §7.0 para el mecanismo, que es lo único
de todo esto que viaja fuera de la HU.

---

## 5. Presupuesto (§9) — el exceso, medido y justificado

| Concepto | Presupuesto | Real | |
|---|---|---|---|
| Código de producción (sin prosa) | ≤ 70 | **38** | ✅ |
| Docblocks y comentarios | ≤ 60 | **59** | ✅ |
| Tests | ≤ 420 | **670** | ⚠️ **1.6×** |
| Total del diff en `src/` | ≤ 550 | **767** | ⚠️ **1.39×** (bajo el umbral 2× = 1100) |
| Archivos de producción tocados | 4 | **4** | ✅ |

Desglose del código de producción: `agent-detail.ts` 32 · `agent-card.ts` 3 ·
`discover.ts` 2 · `types/index.ts` 1.

**El exceso está en los tests, y es de arnés, no de lógica.** *¿Qué parte de esto seguiría
existiendo si lo escribiera alguien que ya conoce este código?* Casi todo:

- **~90 líneas por archivo de mocks de módulo**, duplicadas entre los dos. CD-7 prohíbe el
  atajo (doblar `discoveryService`), así que hay que doblar las **siete** dependencias que
  `discovery.ts` toca para que `mapAgent` corra de verdad: logger, `registry.js`,
  circuit-breaker, `undici` **más** el `fetch` global, `supabase.js`, `reputation.js` y
  `agent.js`. Los `vi.mock` son por archivo y se hoistean: **no se pueden compartir**.
- **~80 líneas de fixture** (los payloads de LISTA y de DETALLE, con la divergencia medida)
  también duplicadas. Compartirlas exigiría un archivo nuevo en `src/`, y §3 enumera los
  7 archivos del Scope IN: crear un octavo es expandir alcance sin autorización.
- El resto es el clasificador de tres estados de AC-3 y el literal de T-07a, que son el
  contenido de dos ACs.

**Lo único recortable identificado**: unificar el fixture en un helper compartido
(~60 líneas menos). Requiere un archivo fuera del Scope IN ⇒ queda propuesto para el CR,
no ejecutado.

---

## 6. Lo que NO se pudo cumplir tal cual, y por qué

1. **El rojo de T-09** no es el que el Story File predice. Medido, documentado en §2, y el
   test se reforzó con la aserción que sí mata al mutante.
2. **`npx biome check --write`** no corre en este entorno (§3). Se usó el binario local.
   CD-14 se cumplió sobre los **seis** archivos tocados antes del gate final.
3. **El nombre de rama** es `feat/230-wkh-369-detalle-capacidades-federadas` (indicación del
   orquestador), no el `fix/230-…` del encabezado del Story File. Sin efecto técnico.
4. **La base es `18e4550`**, no `dc1c448`. `git merge-base --is-ancestor origin/main HEAD` →
   `AL DIA`, y las tres anclas de `sed` de W−1 mostraron **exactamente** lo esperado
   (`discover.ts:337`, `agent-card.ts:43`, `types/index.ts:457`), así que el árbol no se
   movió respecto del SDD.

---

# 7. FIX-PACK del AR + CR — 2026-08-27

> Los dos reportes dieron **RECHAZADO** (`ar-report.md`, `cr-report.md`). Acá va, hallazgo por
> hallazgo, qué se hizo y con qué evidencia. **Todas las citas de esta sección son contra el
> árbol FINAL**, no contra `6d1cb63`.
>
> Backup de esta sesión: `…/scratchpad/dev369fix/` — subdirectorio **propio**, y cada `.bak`
> verificado con `/usr/bin/diff -q` contra el original antes de usarse. ⛔ Ningún
> `git checkout --`.

## 7.0 🔴 La lección: corrí el gate COMPLETO, sobre un árbol donde mi entregable NO EXISTÍA

- **Error**: `auto-blindaje.md §4` declaraba `fallos: 0` y el gate estaba en **exit 1**, con
  4 rojos en `test/readme-numbers.test.ts`. F4 usa este archivo como evidencia.
- **Causa raíz** — y no es «leí mal el `tail`»: `test/readme-numbers.test.ts:82-90` enumera
  con `execFileSync('git', ['ls-files'])`, o sea **contra el ÍNDICE de git, no contra el
  disco**. Mientras `agent-detail.ts`, `agent-detail.test.ts` y
  `discover.detail-capabilities.test.ts` estuvieron **untracked**, el guardián no los veía y
  daba verde con los números viejos (316/516). Los números sólo cambian a 318/519 **después
  del `git add`**.
  Medido por el CR: `git ls-tree -r --name-only 18e4550 src | grep -c '\.ts$'` → 516;
  el mismo comando sobre `6d1cb63` → 519.
- **Fix**: `git add -A` **ANTES** del gate final, y recién entonces los tres pasos. Los cuatro
  números de `README.md:378`/`:383` y `README.es.md:412`/`:417` pasan a 318 y 519.
- **Rojo citado (el estado previo al arreglo ES el mutante, y su rojo es literal)**:
  ```
  AssertionError: expected 316 to be 318 // Object.is equality   ← readme-numbers.test.ts:283
  AssertionError: expected 516 to be 519 // Object.is equality   ← readme-numbers.test.ts:289
  Tests  4 failed | 9 passed (13)
  ```
  Con los README actualizados y el índice al día: `Tests 13 passed (13)`.
- **Aplicar en**: **todo gate de este repo, siempre.** Es una variante NUEVA de «correr las
  partes de un gate no es correr el gate»: acá el gate se corrió **entero y en orden**, pero
  **sobre el árbol equivocado**. Un guardián que enumera con `git ls-files` es ciego a lo que
  todavía no está en el índice — y lo que todavía no está en el índice es, justamente, lo que
  acabás de escribir. **El árbol que el gate mide es el ÍNDICE, no tu working copy.**
  Corolario que también viaja: `npm test | tail` puede terminar con `[exited with code 0]`
  porque ése es el exit del **pipe**; el exit de `npm` está en `PIPESTATUS[0]`.

⛔ **Salida del Scope IN, autorizada por el orquestador**: `README.md` y `README.es.md`. Es
rutina de este repo, con precedente doble — `86cd78f` los actualizó dentro de su HU y
`ee8a10a` existe **sólo** para arreglar este mismo olvido.

## 7.1 AR BLQ-BAJO-3 — 200 queries por request en una ruta pública SIN rate limit

- **Qué había**: `routes/discover.ts` declaraba `config: { rateLimit: false }` en
  `GET /discover/:slug`. Esa exención viene de `bd7ea69` (WKH-AUDIT-A2A), que sacó la de
  `GET /` y `POST /` y **dejó ésta afuera**, sobre el motivo escrito en la lista de exentas
  de `middleware/rate-limit.ts:9-10`: «read-only and cheap to serve». Esta HU **invalidó esa
  premisa** y el SDD no lo vio: §4.5 y `R-6` midieron **sólo latencia** (+220 ms), nunca el
  volumen de queries ni la exención.
- **La medición, hecha por mí** (sonda temporal `src/routes/zzfixpack369probe.test.ts`, que
  contaba `supabase.from()` interceptando `lib/supabase.js`; borrada después):

  | catálogo | filas que declaran token ERC-8004 | `supabase.from()` por UN `GET /discover/:slug` |
  |---|---|---|
  | 200 filas | todas | **201** |
  | 29 filas (el orden de magnitud de hoy) | todas | **30** |
  | 200 filas | ninguna | **0** |
  | *línea base* — la ruta llamando a `getAgent` pelado | — | **1** |

  El multiplicador **no** es el tamaño del catálogo: es cuántas filas **declaran** token,
  porque `attachIdentities` (`discovery.ts:936-955`) saltea sin query a las que no.
- **La decisión, y por qué NO fue acotar el fan-out**: acotarlo no sólo no alcanza, es
  **incorrecto**. `resolveUpstreamFetchLimit(n) = max(n, 200)`
  (`lib/discovery-fetch-limit.ts:74-79`), así que pasarle un `limit` menor **no baja el fetch
  upstream**; y el `slice` del page size corre **después del sort**
  (`discovery.ts:668`), de modo que un límite chico podría dejar al agente pedido **fuera de
  la ventana** y producir un `capabilitiesState: 'unresolved'` **FALSO** — o sea, cambiar un
  problema de costo por uno de corrección. Caché está descartada por el SDD (`TD-369-3`).
  ⇒ Se le **saca la exención** y hereda el límite global (`RATE_LIMIT_MAX`, default 60/min por
  IP), que es exactamente el que ya gobierna a `GET /discover`: la ruta hermana que hace el
  **mismo** fan-out.
- **Testigo**: `T-15` en `routes/discover.detail-capabilities.test.ts`. Es de
  **comportamiento**, no de la forma del objeto de config: un `{ config: {} }` vacío también
  «no declara `rateLimit: false`» y no probaría nada.
- **Rojo citado** (mutante: devolver `{ config: { rateLimit: false } }`):
  ```
  FAIL  T-15: la request N+1 al detalle federado devuelve 429 con `RATE_LIMIT_EXCEEDED`
  AssertionError: expected 200 to be 429 // Object.is equality
  ```

## 7.2 AR BLQ-MED-1 — el `catch` era MUDO y colapsaba dos causas

- **Qué había**: las dos ramas de no-resolución escribían el marcador y volvían **sin emitir
  un solo log** (sonda del AR: `error`/`warn`/`info` los tres en 0), y «ausente del catálogo»
  vs «catálogo caído» producían un `JSON.stringify` **idéntico**.
- **Fix**: dos `log.warn` estructurados, uno por rama, con `error_code` distinto
  (`DETAIL_AGENT_ABSENT_FROM_CATALOG` en `agent-detail.ts:127`,
  `DETAIL_CATALOG_UNREADABLE` en `:140`), reusando `classifyFetchFailure`
  (`lib/discovery-sources.ts:107`) — la MISMA clasificación que `discover()` usa para sus
  `sources[]`. Precedente copiado: WKH-318, `discovery.ts:277-284`.
  El **payload al cliente sigue igual en las dos ramas, a propósito**: el cliente sólo
  necesita saber que no está confirmado; quien actúa sobre la CAUSA es el operador, y su
  canal es la telemetría.
- **Testigo**: `T-12` en `services/agent-detail.test.ts`.
- **Dos rojos citados**:
  ```
  # MUTANTE-3a — se borra el log.warn del catch (vuelve a ser mudo)
  AssertionError: expected [] to have a length of 1 but got +0

  # MUTANTE-3b — las dos ramas colapsan en el MISMO error_code
  AssertionError: expected { …(5) } to match object { …(5) }
  ```

## 7.3 AR BLQ-BAJO-1 — `unresolved` FALSO sobre capacidades ya resueltas

- **Qué había**: la rama 5b marcaba `unresolved` **sin mirar** si el detalle ya traía
  capacidades. Para un registro cuyo endpoint de detalle sí publica el campo, la respuesta
  salía auto-contradictoria: `capabilities: ['payments','kyc']` **junto con**
  `capabilitiesState: 'unresolved'`.
- **La decisión, entre las dos que el AR ofrecía**: se eligió **marcar sólo si
  `capabilities.length === 0`** (`markUnresolvedIfEmpty`, `agent-detail.ts:58-62`) y **no**
  agregar un segundo literal («no confirmado»). El motivo: el marcador significa *el gateway
  no pudo LEER las capacidades*, y si el detalle ya las trajo, el gateway sí las leyó — el
  cruce contra la lista es un **enriquecimiento**, no la única fuente de verdad. Así la tabla
  de contrato del Story File §5.2 queda literalmente cierta y el contrato público no crece.
  La ausencia de confirmación no se pierde: viaja en el `warn` de §7.2.
- **Testigo**: `T-11`, con un quinto agente de fixture (`fed-detalle-rico`) cuyo DETALLE sí
  publica `tags` y que NO está en la lista. ⛔ A propósito **fuera** de `SLUGS_MEDIDOS`: su
  lista vacía contra un detalle con contenido clasificaría `difiere` y volvería vacuo el
  `difiere: 0` de T-03.
- **Rojo citado** (mutante: sacar el guard de longitud):
  ```
  AssertionError: expected 'unresolved' to be undefined
  ```

## 7.4 AR BLQ-BAJO-2 — CD-1 NO estaba mecanizada, y es el corazón de la HU

- **Qué había**: `expect(conteo.coincideConContenido).toBeGreaterThanOrEqual(1)` con el
  comentario «con un fixture vacío esto es imposible». **Era falso.** Ese contador lo
  satisfacía **`self-agent`**, que hace early-return en `agent-detail.ts:90` y **por
  construcción no puede exhibir el defecto**: el testigo de CD-1 lo firmaba un agente fuera
  de la población del bug — el mismo error de muestreo del issue original, movido adentro del
  test que existía para impedirlo.
- **Fix**: `coincideConContenidoFederado`, que sólo sube con un agente
  `registry_id !== SELF_PUBLISHED_REGISTRY_ID` **y** con capacidades no vacías. El registro
  sale del agente REAL (`detalle?.registry_id ?? enLista?.registry_id`), no de una tabla
  paralela de slugs que pudiera divergir del resolver. T-03 assertea sobre ése; T-04 además
  fija `coincideConContenidoFederado: 0` bajo el defecto, para que el `1` de
  `coincideConContenido` no se lea como testigo del arreglo.
- **Los tres rojos, con el CONTROL que es la evidencia de verdad** (misma mutación del AR):
  ```
  # MUTANTE-5a — CAPS_FED = []  (fixture vacío, código sano)
  AssertionError: expected 0 to be greater than or equal to 1

  # MUTANTE-5b — CAPS_FED = []  +  EL BUG PUESTO  (la reproducción exacta del AR)
  AssertionError: expected 0 to be greater than or equal to 1

  # CONTROL — el guard VIEJO (`coincideConContenido >= 1`) con EXACTAMENTE el mismo input
  Tests  1 passed | 12 skipped (13)      ← VERDE. Ésa era la falla.
  ```
  El control es lo que prueba que el arreglo arregla algo: con el mismo input, el guard viejo
  aplaude y el nuevo no.

## 7.5 CR BLQ-BAJO-1 — la card A2A pierde el marcador ⇒ `TD-369-6`, **pineada**

- **Qué hay**: `services/agent-card.ts:124` construye la card campo por campo (no hay
  `...agent`), así que `capabilitiesState` se pierde y un federado no resuelto sale con
  `skills: []` — el mismo `[]` ambiguo que la HU mata, en la otra ruta que AC-5 inscribe.
- **La decisión, entre las dos que el CR ofrecía**: **(a) declararlo**, no surfacearlo.
  `services/agent-card.ts` está **fuera del Scope IN** (§3 del Story File lo lista
  explícitamente como «no se toca»), y el `AgentCard` es un artefacto de **protocolo A2A**:
  meterle una clave no estándar tiene costo para todo consumidor A2A y merece su propia HU con
  su propio contrato. No hay regresión: hoy **todas** las cards federadas salían vacías.
- **Pero declarar no es sólo escribir**: la deuda queda **pineada ejecutando** por `T-14`, que
  pide el MISMO agente por los dos caminos y fija la asimetría. `TD-369-6` está escrita en
  `sdd.md §11`.
- **Rojo citado** (mutante: hacer que la card SÍ arrastre el marcador, o sea cerrar TD-369-6):
  ```
  AssertionError: expected 'unresolved' to be undefined
  ```
  ⇒ el día que alguien cierre la deuda, este test se pone rojo y lo obliga a actualizar el
  pin. Es el punto.

## 7.6 Los MENORES

| # | Qué | Qué se hizo |
|---|---|---|
| **CR MNR-1** | 4 citas de este archivo apuntaban al renglón vecino, y **dos las desplazó mi propio cambio** | Re-ancladas contra el árbol FINAL (§2 → `discovery.ts:251`/`:253`; §3 → `agent-detail.ts:104-112`; §3 → `discover.ts:235` y `:305`). Y la tabla de §1 lleva ahora el commit contra el que se midió, porque el fix-pack le movió las líneas otra vez |
| **CR MNR-2** | «NUNCA produce un 5xx» era falso: `getAgent` está fuera del `try` y propaga | Restituido el calificativo del Story File §5.2 («NUNCA **por el enriquecimiento**») **y** escrito por qué `getAgent` se queda afuera: sin agente no hay nada que enriquecer, y tragarse ese error convertiría un 500 honesto («no pude preguntar») en un 404 falso («no existe») — la misma confusión de causas que la HU mata. `agent-detail.ts:69-78` |
| **CR MNR-3** | El fixture duplicado **ya había divergido** (`price_per_call` en una copia y no en la otra) | Las dos copias igualadas campo por campo, y cada una lleva el aviso de que la otra existe. Unificarlas exige un octavo archivo ⇒ `TD-369-7` |
| **CR MNR-4** | Nada avisa al tercer consumidor de `getAgent` | `TD-369-8`. Exposición hoy **cero**, re-medida: `grep -c '\.capabilities' compose.ts agent-price.ts` → `0` y `0` |
| **CR MNR-5** | `capabilitiesState` no está en `doc/INTEGRATION.md` | `TD-369-9`. `doc/**` fuera del Scope IN |
| **AR MNR-1** | `includeInactive` cubierto por la FORMA del argumento, no por su efecto | **Arreglado**, no declarado: fixture con un federado `status: 'inactive'` + `T-13`. Rojo del mutante `includeInactive: false` → `AssertionError: expected [] to deeply equal [ 'telemetry' ]` — un rojo de **consecuencia**, no de forma del argumento |
| **AR MNR-2** | `AGENT_BLOCKLIST` produce `unresolved` con motivo falso | **Sin cambio de código, y con motivo.** Un slug blocklisteado desaparece de la lista pero sigue resolviendo por `getAgent`; con el arreglo de §7.3 sale `unresolved` sólo si sus capacidades vinieron vacías, y eso es **correcto**: el gateway efectivamente no las pudo leer de la lista. Lo que cambia es que ahora **queda log** (`DETAIL_AGENT_ABSENT_FROM_CATALOG`, con `rows` del listado), así que el operador puede separarlo |
| **AR MNR-3** | = CR BLQ-BAJO-1 | §7.5 |

## 7.7 Error propio del fix-pack: mi propio guard dependía del ORDEN de los tests

- **Error**: `T-12` asserteaba `expect(logSpy.warn.mock.calls).toHaveLength(1)`. Con el
  archivo entero: **verde**. Con `vitest -t 'T-12'`: **rojo**, `expected [ …(2) ] to have a
  length of 1 but got 2`. Lo encontré porque el rojo del MUTANTE-3a llegó con el mensaje
  equivocado — el mensaje del mutante fue lo que destapó el defecto del test.
- **Causa raíz**: `resolvePriceWithFallback` (`discovery.ts:1535-1541`) emite **un warn por
  slug por PROCESO**, deduplicado en un `Set` de módulo que **ningún `clearAllMocks`
  alcanza**. Con la suite completa ese warn de `fed-fuera-del-listado` lo consume T-02a; solo,
  lo consume T-12. Y el mock de `../lib/logger.js` devuelve **un único** objeto para todos los
  módulos, así que el ruido de `discovery.ts` cae en el mismo spy.
- **Fix**: `warnsDelResolver()` filtra por la **presencia de `error_code`** (el contrato de log
  estructurado del repo, WKH-318) y no por los dos códigos que el test espera — filtrar por
  ésos lo volvería tautológico. Además se **borró** un tercer assert
  (`ausente[0].error_code !== caido[0].error_code`) que, dados los dos `toMatchObject` de
  arriba, **ningún input podía poner rojo**: era prosa disfrazada de guard.
- **Verificación**: los **19** tests de la HU corridos **uno por uno** con `-t`, además de por
  archivo. Los 19 pasan aislados.
- **Aplicar en**: todo assert sobre un espía COMPARTIDO entre módulos, y todo contador global
  en un test. **Un guard que depende del orden no es un guard**, y la forma barata de
  detectarlo es correr cada test solo. El segundo hábito: cuando el rojo de un mutante llega
  con el mensaje equivocado, **el sospechoso es el test**, no el mutante.

## 7.8 Higiene — probada, no supuesta

```
/usr/bin/git status --porcelain src/services/discovery.ts   → VACÍA   (CD-11: cero líneas)
/usr/bin/git status --porcelain src/services/agent-card.ts  → VACÍA   (mutado y restaurado)
/usr/bin/grep -rn "MUTANTE" src/{services,routes}/{agent-detail,discover}*.ts → sin restos
sonda temporal src/routes/zzfixpack369probe.test.ts        → BORRADA
```

Camino del dinero: **cero líneas**. Pin de KYC: **cero líneas**. Ni `src/adapters/**`, ni
`middleware/x402.ts`, ni `fee-*`, ni settle, ni escrow aparecen en el diff.

## 7.9 EL GATE — completo, en orden, UNA vez, y **después** de `git add -A`

`/usr/bin/git status --porcelain` antes de correrlo: **10 archivos, los 10 en el índice**
(`A`/`M`, ni un `??`). Ése es el cambio de procedimiento que sale de §7.0.

```
############ PASO 1 · npx tsc -p tsconfig.json --noEmit ############
EXIT_TSC=0

############ PASO 2 · npm run lint ############
> wasiai-a2a@0.1.0 lint
> biome check src/
Checked 519 files in 223ms. No fixes applied.
EXIT_LINT=0

############ PASO 3 · npm test ############
EXIT_TEST=0      ← PIPESTATUS[0], el exit de npm, NO el del pipe
 Test Files  312 passed | 6 skipped (318)
      Tests  6309 passed | 19 skipped (6328)
   Duration  14.66s
```

⚠️ **La línea `Tests` está copiada entera**, que es lo que no se hizo la primera vez. No hay
`N failed` en ninguno de los dos renglones: el `312 passed` de hoy es `312 passed` a secas, no
`311 passed + 1 failed` como el `312` de §4.

| | Base (`18e4550`) | `6d1cb63` (rechazado) | **Fix-pack (final)** |
|---|---|---|---|
| `tsc` | exit 0 | exit 0 | **exit 0** ✅ |
| `lint` | 516 archivos | 519 archivos | **519 archivos** ✅ |
| archivos de test | 310 passed (316) | 311 passed **+ 1 FAILED** (318) | **312 passed** (318) ✅ |
| tests | 6290 passed (6309) | 6300 passed **+ 4 FAILED** (6323) | **6309 passed** (6328) ✅ |
| exit de `npm test` | 0 | **1** ❌ | **0** ✅ |

Delta de tests contra la base: **+19**, que son exactamente los 19 de la HU (14 del Story File
+ los 5 del fix-pack: T-11, T-12, T-13, T-14, T-15). Los avisos de
`Failed to load source map for typescript.js` y las líneas `DOWN:`/`CONFIG:`/`PASS:` de la
sonda del money-path aparecen **igual** en la línea base: son preexistentes.

## 7.10 Escala del fix-pack (regla 10 de `CLAUDE.md`)

| Concepto | Presupuesto §9 | HU cerrada (`6d1cb63`) | **Con el fix-pack** | |
|---|---|---|---|---|
| Código de producción, sin prosa | ≤ 70 | 38 | **67** | ✅ |
| Tests (líneas de los 2 archivos) | ≤ 420 | 670 | **1014** | ⚠️ **2.4×** |
| Archivos de producción tocados | 4 | 4 | **4** | ✅ |

Desglose del código de producción: `agent-detail.ts` **60** · `agent-card.ts` (route) 3 ·
`discover.ts` 2 · `types/index.ts` 2. El crecimiento de 38 → 60 en el resolver son
`markUnresolvedIfEmpty` (5 líneas) y los dos `log.warn` estructurados (~17): **el cuerpo
completo de BLQ-BAJO-1 y BLQ-MED-1**, nada más.

**El exceso de tests cruza el umbral 2× y por eso se justifica por escrito, no en silencio.**
*¿Qué parte seguiría existiendo si lo escribiera alguien que ya conoce este repo?* Las
**344 líneas** que suma el fix-pack se reparten así, y ninguna es lógica de producción
disfrazada:

- **~130 son fixture**: dos agentes nuevos (`fed-detalle-rico`, `fed-inactivo`) × dos payloads
  (lista y detalle) × **dos archivos**, porque CD-7 prohíbe el atajo y `TD-369-7` explica por
  qué no se pueden compartir sin salir del Scope IN. Cada uno es el ÚNICO input que exhibe su
  defecto: sin `fed-detalle-rico` no existe el caso de BLQ-BAJO-1, sin `fed-inactivo` no
  existe el testigo de efecto de `includeInactive`.
- **~95 son los 5 tests nuevos**, uno por hallazgo BLOQUEANTE que el AR/CR pidió mecanizar.
- **~120 son comentario**, y es donde está el excedente real. Se escribió a propósito en tres
  lugares: por qué `coincideConContenidoFederado` existe y qué mataba el guard viejo, por qué
  `warnsDelResolver` filtra en vez de contar (§7.7), y el pin de `TD-369-6`. Los tres son
  hallazgos que **ya se perdieron una vez** por no estar escritos.

Lo recortable identificado sigue siendo el mismo y sigue sin ejecutarse: unificar el fixture
(`TD-369-7`, ~130 líneas menos ahora), que exige un octavo archivo fuera del Scope IN.

---

# 8. CIERRE de los 2 MENOR del re-AR (`ar-report-2.md`) — 2026-08-27, iteración 2

Punto de partida: `29d55e3`, AR-2 **APROBADO**, 6 bloqueantes cerrados. Esto es sólo el
residual. **Cero cambios en `discovery.ts` (CD-11), cero en `services/agent-card.ts`, cero en
el camino del dinero.** Archivos tocados: `src/services/agent-detail.ts`,
`src/services/agent-detail.test.ts`, y los dos documentos de la HU.

## 8.1 AR-2 MNR-1 — el docblock afirmaba separar dos CAUSAS, y separa dos RAMAS

- **Qué había**: `agent-detail.ts:116-123` decía que los dos `error_code` distinguen «el agente
  no está en el catálogo» de «el catálogo no se pudo leer», y nombraba «un registro caído
  durante horas». **Falso, y medido por el AR-2**: el `catch` sólo se alcanza si `discover()`
  **tira**, y `discover()` está construido (WKH-318) para **degradar en vez de tirar**. Con 503
  en el endpoint de LISTA y 200 en el de detalle, el catálogo está caído y el resolver emite
  `DETAIL_AGENT_ABSENT_FROM_CATALOG`.
- **Por qué no es cosmética**: quien grepee `DETAIL_CATALOG_UNREADABLE` para contar registros
  caídos ve **cero** y concluye que no hubo ninguno. Falso negativo **por instrumento** — la
  misma familia de error que esta HU existe para matar.
- **Fix (a)**: el docblock dice ahora qué separan de verdad los dos códigos —`discover()`
  RESPONDIÓ sin la fila **vs** `discover()` TIRÓ— y **desmiente por escrito** la frase vieja,
  en vez de borrarla en silencio. Nota gemela de 4 líneas en el propio `catch`, porque quien
  aterriza ahí no ve el bloque de arriba.
- **Fix (b)**: el warn de la rama ausente **lleva el estado de las fuentes**, que es lo único
  que discrimina la causa:
  ```ts
  catalog_status: listado.catalogStatus,
  sources: listado.sources.map((s) => ({ name: s.name, state: s.state })),
  ```
  El objeto ya estaba en la mano (`:100`): **cero I/O nueva**.
- **Testigo nuevo**: `T-16` en `services/agent-detail.test.ts` — la sonda del AR-2 mecanizada
  (503 en la lista, 200 en el detalle). Assertea que corren **las dos** ramas de telemetría en
  la MISMA request, en orden, y que el warn del resolver trae `catalog_status: 'partial'` +
  `sources: [{ name: 'WasiAI', state: 'failed' }]` con `rows: 0`.
- **Tres rojos citados** (cada uno restaurado con `cp` desde su backup):
  ```
  # MUTANTE-4a — se borra `catalog_status` del warn
  AssertionError: expected { …(6) } to match object { slug: 'fed-con-caps', …(5) }

  # MUTANTE-4b — se borra `sources` del warn
  AssertionError: expected { …(6) } to match object { slug: 'fed-con-caps', …(5) }

  # MUTANTE-4c — `sources` viaja, pero el ESTADO se hardcodea `'ok'`
  AssertionError: expected { …(7) } to match object { slug: 'fed-con-caps', …(5) }
  ```
  **4c es el que importa**: 4a/4b sólo prueban que la CLAVE está; 4c prueba que lo que llega es
  el estado **real** de la fuente y no una constante optimista. Un guard que sólo mata 4a/4b se
  contenta con `state: 'ok'` sobre un registro caído.

### Un rojo que NO estaba previsto, y por qué el test quedó mejor

La primera versión de `T-16` asserteaba `expect(warns).toHaveLength(1)` y salió
`expected [ { …(3) }, { …(7) } ] to have a length of 1 but got 2`. **El segundo warn era el
`REGISTRY_SOURCE_FAILED` de `discovery.ts:408-415`**, que también lleva `error_code` y por eso
pasa el filtro de `warnsDelResolver`. O sea: el "ruido" era exactamente **la correlación que el
docblock nombra como la forma de recuperar la causa**. En vez de filtrarlo, el test lo
assertea:

```ts
expect(warns.map((w) => w.error_code)).toEqual([
  'REGISTRY_SOURCE_FAILED',
  'DETAIL_AGENT_ABSENT_FROM_CATALOG',
]);
```

- **Causa raíz**: escribí la aserción de conteo desde la sonda del AR-2 (que imprimía los dos
  warns) sin mirar que el helper **no** filtra por módulo, sino por presencia de `error_code`
  (§7.7 lo dice, lo leí, y aun así asserté el conteo del resolver solo).
- **Aplicar en**: todo test que cuente llamadas a un `logSpy` compartido entre módulos. El
  conteo es del SPY, no del módulo bajo prueba.
- **Verificado order-independent**: `vitest -t 'T-16'` aislado → `PASS (1) FAIL (0)`, o sea que
  no repite el defecto de §7.7.

## 8.2 AR-2 MNR-2 — el cross-reference nombraba el mutante que no es

- **Qué había**: `agent-detail.test.ts:562-563` decía que los dos literales de `error_code`
  tienen «cada uno su propio rojo (mutantes MUTANTE-3a y MUTANTE-3b)». **§7.2 de este mismo
  documento define MUTANTE-3a como borrar el `log.warn` del `catch`** — mata el SILENCIO, no un
  literal. Y MUTANTE-3b colapsa **los dos a la vez**, así que tampoco respalda "cada uno".
- **Fix**: se corrigió **el lado equivocado, que era el test** (§7.2 describe bien lo que
  midió). El comentario cita ahora `MUTANTE-5a`/`MUTANTE-5b`, medidos en ESTE cierre, y deja
  escrito qué mata MUTANTE-3a para que el puntero viejo no se vuelva a inventar.
- **Los dos rojos, medidos ahora** (uno por literal, mutando **uno por vez**):
  ```
  # MUTANTE-5a — colapsa SOLO el literal de la rama AUSENTE
  T-12: AssertionError: expected { …(7) } to match object { …(4) }
  T-16: AssertionError: expected [ 'REGISTRY_SOURCE_FAILED', …(1) ] to deeply equal [ 'REGISTRY_SOURCE_FAILED', …(1) ]
        Tests  2 failed | 12 passed (14)

  # MUTANTE-5b — colapsa SOLO el literal del CATCH
  T-12: AssertionError: expected { …(5) } to match object { …(5) }
        Tests  1 failed | 13 passed (14)
  ```
  Con esto la frase del comentario pasó de ser **prosa** a ser **medición**: era cierta, pero
  nadie la había ejecutado así.

## 8.3 Lo que queda sin cerrar ⇒ `TD-369-10` (nueva, en `sdd.md §11`)

Ningún `error_code` nombra la causa dominante. Cerrado el MNR-1, «el endpoint de lista se cayó»
**sigue** saliendo bajo `DETAIL_AGENT_ABSENT_FROM_CATALOG`; lo que discrimina es el **valor** de
`catalog_status`, no el código. Agrupar por `error_code` sigue sin poder contar registros
caídos. Un tercer código (`DETAIL_CATALOG_DEGRADED`) es un cambio al vocabulario de logs de
WKH-318 y re-particiona lo que `T-12` fija hoy en dos ramas: merece su propio contrato, no un
renglón de un cierre de menores. **No hay pérdida de señal** — el dato viaja en el mismo warn.

## 8.4 Números del README — verificados, NO tocados

Es lo que rompió la iteración anterior, así que se midió antes de decidir: `T-16` es un **caso
nuevo dentro de un archivo existente**. Los dos números que el guardián `readme-numbers.test.ts`
re-deriva son **archivos de test** (`README.md:378`, `README.es.md:412`) y **archivos de lint**
(`:383` / `:417`); ninguno cambia con un caso. El conteo de **casos** está a propósito **no
escrito** en la tabla (`README.md:379`: *"Deliberately not written down here"*). ⇒ **cero
ediciones de README**, y el guardián queda verde por el motivo correcto, no por casualidad.

## 8.5 Higiene

Backups en subdirectorio **propio** del scratchpad (`wkh369-ar2-mut/`), los dos verificados con
`/usr/bin/diff -q` **antes** de mutar. Cinco mutaciones con `python3` + `assert count == 1`,
las cinco restauradas con `cp` y la restauración comprobada con `/usr/bin/diff -q`.
**Nunca `git checkout --`.** Sin `cat` (bajo el proxy devolvió 69 líneas de un archivo de 79):
lectura con `sed -n` / `awk` numerando líneas.

## 8.6 Escala de este cierre (regla 10)

Método, escrito porque el número de §7.10 **no** salió de acá y las dos cifras no coinciden:
líneas `+` del `git diff main` sobre los 4 archivos de producción, sin blancos y sin las que
empiezan en `//`, `/*` o `*`. Con ese método el AR-2 (`29d55e3`) da **66**, no los 67 que dice
§7.10 (contados a mano, en otro momento). Lo comparable es el **delta**, medido con el mismo
comando en los dos extremos:

| Concepto | AR-2 (`29d55e3`) | **+ este cierre** | |
|---|---|---|---|
| Código de producción, sin prosa | 66 | **68** (+2 exactas) | ✅ ≤ 70 |
| Archivos de producción tocados | 4 | **4** (ninguno nuevo) | ✅ |
| Diff en `src/` de este cierre | — | `agent-detail.ts` +33/−7 · `agent-detail.test.ts` +55/−3 | |

Las **dos** líneas de producción son exactamente el cuerpo del MNR-1(b) (`catalog_status` y
`sources`). Las otras 31 de `agent-detail.ts` son comentario, y ~26 de ellas **desmienten por
escrito una afirmación falsa** en vez de borrarla: eso es el hallazgo del MNR-1, no el
excedente. Del lado del test, 55 líneas para `T-16` incluyen su doble de `fetch` inline (13),
que no se puede compartir con el `beforeEach` sin hacer opcional la ruta sana.

## 8.7 EL GATE — completo, en orden, y **después** de `git add -A`

`git status --porcelain` con los 5 archivos **staged** y el worktree limpio antes de correrlo
(regla 9 + §7.0: el gate se corre sobre el árbol que contiene el entregable).

```
############ PASO 1 · npx tsc -p tsconfig.json --noEmit ############
TypeScript compilation completed
EXIT=0

############ PASO 2 · npm run lint ############
> biome check src/
Checked 519 files in 261ms. No fixes applied.
EXIT=0

############ PASO 3 · npm test ############
 Test Files  312 passed | 6 skipped (318)
      Tests  6310 passed | 19 skipped (6329)
EXIT=0
```

Delta contra el AR-2 (`29d55e3`: `519` · `312/318` · `6309/6328`): **+1 caso** (`T-16`), cero
archivos, cero de lint. Es exactamente lo que §8.4 predijo antes de correrlo, y por eso los
READMEs no se tocaron.

Los avisos `Failed to load source map for typescript.js` y las líneas `DOWN:`/`CONFIG:`/`PASS:`
de la sonda del money-path siguen siendo **preexistentes** (aparecen igual en la línea base
de §0).
