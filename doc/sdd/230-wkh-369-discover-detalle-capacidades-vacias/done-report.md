# Done Report — #230 · WKH-369 · `/discover/<slug>` publicaba capacidades vacías para todo agente federado

Merge `85cc288` (padres `18e4550` + `a2c221f`) · rama `feat/230-wkh-369-detalle-capacidades-federadas`
Cierre: 2026-08-27 · `nexus-docs`

> **Marca de cada afirmación.** Lo que dice `[ARTEFACTO]` sale de un archivo de esta carpeta y
> se cita con su nombre. Lo que dice `[MEDIDO-DOCS]` lo corrí yo en esta fase y pego la salida.
> Lo que dice `[MEDIDO-ORQ]` lo midió el orquestador contra producción después del deploy y yo
> **no** lo re-corrí entero. **Ningún número de este reporte es una estimación.**

---

## 1 · Resumen ejecutivo

`GET /discover/<slug>` devolvía `capabilities: []` para **24 de 24** agentes federados,
mientras `GET /discover` publicaba la lista real para esos mismos slugs. El mismo defecto
vaciaba las `skills` del Agent Card A2A (`GET /agents/<slug>/agent-card`) `[ARTEFACTO sdd.md §1]`.

Se arregló **fuera** de `discoveryService.getAgent` — en un resolver nuevo
(`src/services/agent-detail.ts`) que consumen las dos rutas gratis de detalle — de modo que
`/compose`, `/orchestrate` y la cotización de precio quedan intactos **por construcción y no
por promesa**. Cuando la lista tampoco puede resolver las capacidades, la respuesta lo **dice**
(`capabilitiesState: 'unresolved'`) en vez de publicar un `[]` indistinguible de una afirmación.

Post-deploy, medido contra producción: el bucket `difiere` pasó de **10 → 0** y
`agentshop-kyc-validator` publica **4 skills** donde ayer publicaba `[]`.

---

## 2 · Dónde **no** está el arreglo, y por qué eso es el hallazgo

El crudo del endpoint de detalle del registro federado **no trae las capacidades en ningún
campo**. `[ARTEFACTO sdd.md §3.2]` — las 28 claves reales del cuerpo son:

```
agent_type, category, chain, chain_id, cover_image, created_at, creator, currency,
description, error_rate_7d, error_rate_sample_size, estimated_total_cost, example_input,
input_schema, invoke_url, is_featured, mcp, name, output_schema, p50_latency_ms,
p95_latency_ms, payment, performance_score, price_per_call, reputation, sandbox_enabled,
slug, stats
```

⛔ **No existen `tags`, `capabilities`, `skills`, `labels` ni `keywords`.** Lo más parecido es
`category = "compliance"`, que es **una** de las cuatro capacidades reales.

⇒ **Ninguna variante de mapeo, de desenvoltura de sobre ni un `agentPath` nuevo podía arreglar
esto**: apuntar a otro path es seguir buscando un dato que no está en la respuesta que se está
leyendo. Por eso el arreglo va a buscarlo a la única fuente que lo tiene (la LISTA, DT-1) y,
cuando eso falla, declara la vista como no resuelta.

Corolario medido que conviene no perder: la lista **no** funciona por una red de seguridad.
`discovery.ts:1360-1362` lee `raw[mapping.capabilities ?? 'capabilities']`, y el `??` protege a
la **ruta declarada** de ser `undefined`, **no al valor resuelto** de estar ausente. El único
fallback al nombre canónico del archivo es el de precio (`discovery.ts:1500`, `:1512-1544`), y
es —medido— lo único que evita que `priceUsdc` diverja también `[ARTEFACTO sdd.md §3.2/§3.3]`.
**`priceUsdc` no estaba sano: estaba tapado.**

---

## 3 · Las CUATRO hipótesis que cayeron, y la causa común

`[ARTEFACTO sdd.md §0]`

| # | Hipótesis | Quién la sostuvo | Cómo cayó |
|---|---|---|---|
| 1 | «El bug está en `mapAgent`» | issue **#182** | Los dos caminos llaman a la **misma** función sin ramificar: `discovery.ts:1273` (lista) y `:1436` (detalle). Medido en F1 |
| 2 | «Falta un `agentPath` para desenvolver el sobre del detalle» | **F1** (`nexus-analyst`) | El detalle **no tiene sobre**: el agente viene en la raíz. Agregar `agentPath` no apunta a ningún lado. Medido en F2 |
| 3 | «El payload de LISTA trae `capabilities`, no `tags`, así que la lista anda por un fallback al nombre canónico» | **el encargo de F2** | Falso **en la premisa y en la consecuencia**: el cuerpo que el gateway consume SÍ trae `tags`, y en `mapAgent` **no existe** ningún fallback al nombre canónico para `capabilities`. Medido en F2 |
| 4 | «Se puede pedir un solo agente al registro federado con `?q=<slug>`» | **el F2 mismo**, al diseñar la opción (a) | `?q=agentshop-kyc-validator&limit=1` → `agents: [], total: 0`. El filtro de texto **no mira el slug** (`discovery.ts:466-473`). Medido en F2 |

### La causa común — el activo de esta HU

> **Se midió el artefacto que el cliente puede pedir, no el que el sistema consume.**

La hipótesis #3 es la que lo muestra entero. La medición que la sostenía era un `GET` **sin
autenticar** a `https://app.wasiai.io/api/v1/capabilities`. Ese endpoint **no devuelve el mismo
cuerpo que el gateway consume**: sin credencial delega en el propio `/discover` de a2a y
devuelve agentes **ya mapeados** (con `capabilities` en la raíz). El cuerpo que el gateway
realmente recibe es el catálogo nativo de v2, con `tags`. La sonda era técnicamente correcta,
devolvía 200, y contestaba **otra pregunta** `[ARTEFACTO sdd.md §0]`.

La misma forma reaparece tres veces más en el pipeline, y por eso vale como regla y no como
anécdota:

- **El fixture con capacidades vacías** (CD-1): el testigo de la mecanización lo firmaba un
  agente **self-published**, que hace early-return en `agent-detail.ts:47` y **no pertenece a la
  población del bug** `[ARTEFACTO ar-report.md BLQ-BAJO-2]`.
- **La primera corrida de AC-7** en F4: los dos sha256 coincidían porque se estaban comparando
  dos listas **vacías** (`state:"failed", failure:"bad_payload"`). Se descartó por vacua y se
  rehizo `[ARTEFACTO qa-validation.md §4.1]`.
- **El gate del §4 abajo**: se corrió el gate entero, sobre un árbol donde el entregable no
  existía.

---

## 4 · El gate que estuvo ROJO y se reportó VERDE — regla nueva para el repo

`[ARTEFACTO cr-report.md BLQ-ALTO-1 · ar-report.md BLQ-ALTO-1 · auto-blindaje.md §7.0]`

`test/readme-numbers.test.ts:83` enumera los archivos con
`execFileSync('git', ['ls-files'])` — o sea **contra el ÍNDICE de git, no contra el disco**.
Mientras `agent-detail.ts`, `agent-detail.test.ts` y `discover.detail-capabilities.test.ts`
estuvieron **untracked**, el guardián no los veía y el gate daba verde con los números viejos.

```
git ls-tree -r --name-only 18e4550 src | grep -c '\.ts$'  → 516
git ls-tree -r --name-only 6d1cb63 src | grep -c '\.ts$'  → 519

AssertionError: expected 316 to be 318   ← readme-numbers.test.ts:283  (los dos README)
AssertionError: expected 516 to be 519   ← readme-numbers.test.ts:289  (los dos README)
Tests  4 failed | 6300 passed | 19 skipped (6323)   ·   exit 1
```

⇒ **El Dev corrió el gate COMPLETO y EN ORDEN, sobre un árbol en el que su propio entregable no
existía.** El `auto-blindaje.md §4` llegó a declarar `fallos: 0`; el renglón está hoy
**RETRACTADO** en el propio archivo. Que los totales del Dev (312 / 6304) coincidieran
exactamente con `311 passed + 1 failed` y `6300 passed + 4 failed` prueba que la corrida
existió: lo que no se leyó fue la línea `Tests` entera.

> ### 🔴 Regla que sale de esta HU y viaja fuera de ella
> **El árbol que el gate mide es el ÍNDICE, no tu working copy.** `git add -A` va **ANTES** del
> gate final, no después. Es una variante NUEVA de «correr las partes de un gate no es correr el
> gate» (regla 9 de `CLAUDE.md`): acá el gate se corrió entero y en orden, pero **sobre el árbol
> equivocado**. Merece entrar a `CLAUDE.md` como corolario de la regla 9.
>
> **Corolario que también viaja**: `npm test | tail` puede terminar con `[exited with code 0]`
> porque ése es el exit del **pipe**. El exit de `npm` está en `PIPESTATUS[0]`.

Es exactamente la misma clase de error que las cuatro hipótesis del §3: **el instrumento midió
un artefacto, y no era el artefacto del que se estaba afirmando algo.**

---

## 5 · Pipeline ejecutado

| Fase | Artefacto | Resultado |
|---|---|---|
| **F1** | `work-item.md` | 8 ACs EARS. Corrió **sin shell** (sólo Read/Write/Glob): todo marcado `[MEDIDO-F1]` / `[HEREDADO]` / `[NO MEDIDO]`. Gate `HU_APPROVED` — commit `9ba550a` |
| **F2** | `sdd.md` | `SDD_MODE: full`. Corrió **con shell y con red**: cerró MI-1..MI-6, tiró la hipótesis #2 y #3, encontró la #4 propia. Gate `SPEC_APPROVED` |
| **F2.5** | `story-HU-369.md` (+ `story-file.md`, puntero) | 16 Constraint Directives, 14 tests con su mutación y su rojo esperado, waves W−1..W4, presupuesto y Done Definition. **Una sola copia del contrato**, a propósito |
| **F3** | `auto-blindaje.md` | Commit `6d1cb63`. 4 archivos de producción, 2 de test |
| **AR** | `ar-report.md` | ❌ **RECHAZADO** — 1 ALTO · 1 MEDIO · 3 BAJO · 3 MENOR |
| **CR** | `cr-report.md` | ❌ **RECHAZADO** — 1 BLOQUEANTE-ALTO + 1 BLOQUEANTE-BAJO + 5 MENOR (corrió en paralelo con el AR) |
| **fix-pack** | `auto-blindaje.md §7` | Commit `29d55e3` — los 6 bloqueantes, con el gate corrido **después** de `git add -A` |
| **re-AR** | `ar-report-2.md` | ✅ **APROBADO** — cero bloqueantes, 2 MENOR |
| **cierre MNR** | `auto-blindaje.md §8` | Commit `cfb1cfe` — los 2 MENOR del AR-2 + `TD-369-10` |
| **F4** | `qa-validation.md` | ✅ **APROBADO** — **8/8 ACs PASS**, 0 FAIL, 4 verificaciones post-deploy pendientes + 3 F4-MNR |
| **merge** | `85cc288` | En `main`, desplegado. Verificado: `git merge-base --is-ancestor 85cc288 HEAD` → ancestro `[MEDIDO-DOCS]` |

Los 4 commits verificados en `main` con `git merge-base --is-ancestor` (NO con `git log`, que
bajo el proxy de este entorno omite los merges) `[MEDIDO-DOCS]`:
`9ba550a` · `6d1cb63` · `29d55e3` · `cfb1cfe` → los cuatro `OK-en-main`.

### Los bloqueantes, uno por uno

| ID | Qué era | Cómo se cerró |
|---|---|---|
| **AR/CR BLQ-ALTO-1** | El gate en rojo (4 fallos en `readme-numbers.test.ts`) reportado como verde | `README.md:378/:383` y `README.es.md:412/:417` → `318` y `519`, y el gate re-corrido tras `git add -A`. Salida del Scope IN **autorizada**, con precedente doble en el repo (`86cd78f`, `ee8a10a`) |
| **AR BLQ-MED-1** | El `catch` del resolver era **mudo** y las dos ramas producían un payload byte-idéntico | `log.warn` estructurado con `error_code`. 3 mutantes de log muertos por T-12 |
| **AR BLQ-BAJO-1** | `unresolved` **FALSO** sobre capacidades que SÍ se habían resuelto | Se marca sólo si está vacío. T-11 mata el marcado incondicional |
| **AR BLQ-BAJO-2** | **CD-1 no estaba mecanizada**: T-03 pasaba con el fixture vacío **y el bug puesto** | El contador exige el bucket **y** `registryId !== SELF_PUBLISHED_REGISTRY_ID`. Verificado con el control: guard nuevo **ROJO** / guard viejo **VERDE** sobre el mismo input |
| **AR BLQ-BAJO-3** | Hasta **201** `supabase.from()` por request en una ruta pública **exenta de rate limit** | Se **quitó la exención**. Acotar el fan-out se descartó con el motivo escrito: `resolveUpstreamFetchLimit(n)=max(n,200)` no baja el fetch upstream, y el `slice` post-`sort` podría producir un `unresolved` FALSO ⇒ cambiaría un problema de **costo** por uno de **corrección** |
| **CR BLQ-BAJO-1** | El marcador no llega al Agent Card ⇒ `skills: []` sin poder decir «no lo pude leer» | Declarado como **TD-369-6** y **pineado ejecutando** por T-14: el día que se cierre, T-14 se pone rojo |

---

## 6 · Acceptance Criteria — resultado final

`[ARTEFACTO qa-validation.md §3]` · la columna «prod» agrega el post-deploy `[MEDIDO-ORQ]`.

| AC | Status | Evidencia (arnés) | En producción |
|---|---|---|---|
| **AC-1** — detalle == lista para federados | ✅ **PASS** | `agent-detail.ts:100-113`; T-01 `agent-detail.test.ts:387`, T-08 `discover.detail-capabilities.test.ts:258`. Con el defecto re-introducido: `expected [] to deeply equal ['remittance','remit','kyc',…]` | ✅ `difiere` **10 → 0** |
| **AC-2** — no resuelto ≠ `[]` | ✅ **PASS** | `types/index.ts:458-465`, `agent-detail.ts:58-62`; T-02a/b/c `:398/:405/:412`, T-11 `:513`. **No tautológico**: T-02b fija que resuelto-y-vacío deja la clave **AUSENTE** | ✅ los 14 de `coincide-en-vacío` salen **sin** marcador; **0 marcados `unresolved`** |
| **AC-3** — partición de 3 + tasa sobre la población que puede exhibirlo | ✅ **PASS** | T-03 `:426`, T-04 `:441`; clasificador `:295-311` | ✅ ver §7 |
| **AC-4** — con el defecto, el test de paridad falla | ✅ **PASS** | **Mutación ejecutada** en worktree aislado: `× T-03 → expected 1 to be +0`, y arrastra T-01/T-05/T-08/T-13. `Tests 5 failed \| 15 passed (20)`. Control sin mutar: `20 passed (20)` | n/a |
| **AC-5** — `skills` del card sale de la misma lista | ✅ **PASS** | `routes/agent-card.ts:41-43`; T-05 `:281`. `services/agent-card.ts` **no se tocó** — 0 líneas en el diff | ✅ `agentshop-kyc-validator` → **4 skills** |
| **AC-6** — paridad de los 3 campos con path ≠ nombre | ⚠️ **PASS con residual** (F4-MNR-1) | T-06a `:464`, T-06b `:470` | ✅ `reputation` divergentes **2/29 → 0** · `priceUsdc` **0/29** antes y después |
| **AC-7** — lista y `/compose` byte-idénticos | ✅ **PASS** | Dos worktrees, la misma sonda (`sha256 6bf60f6c…` idéntica en ambos): `1ddd7cd1…` = `1ddd7cd1…`, 10362 bytes, `diff` sin salida. **Con control positivo**: inyectando la fuga que AC-7 prohíbe el sha cambia y T-07a/T-07b se ponen rojos | ✅ `discovery.ts`/`compose.ts`/`agent-price.ts` → **0 líneas** en el diff |
| **AC-8** — el gate en el orden del CI | ✅ **PASS** | `0` · `519` · `312/318` · `6310/6329` · exit **0**, con el índice limpio | ✅ re-corrido en esta fase, §9 |

---

## 7 · Producción — el ANTES y el DESPUÉS

**ANTES** `[ARTEFACTO qa-validation.md §2, medido 2026-08-27 antes del deploy]`
**DESPUÉS** `[MEDIDO-ORQ, contra prod después del merge 85cc288, 29 agentes]`

| Métrica | ANTES | DESPUÉS |
|---|---|---|
| `difiere` | **10** | **0** |
| `coincide-con-contenido` | 5 | **15** |
| `coincide-en-vacío` | 14 | 14 |
| marcados `unresolved` | — | **0** |
| detalle no legible | 0 | 0 |
| **Tasa sobre la población elegible** (federados con lista no vacía) | **10/10 = 100 %** | **0/15 = 0 %** |
| `agentshop-kyc-validator` → `agent-card.skills` | `[]` | **4** (`remittance`, `remit`, `kyc`, `compliance`) |
| Catálogo | 29 agentes | 29 agentes, 29 activos; los 5 `remit-*` activos |

Los **10** que diferían pasaron a `coincide-con-contenido`: **5 + 10 = 15**. Cuadra.

⚠️ **Los 14 de `coincide-en-vacío` NO son un defecto residual.** Son federados cuyo upstream
**realmente** no declara capacidades: `metadata.tags = []` — la clave **está presente y es un
array vacío** `[ARTEFACTO sdd.md §3.2, MI-3 cerrado]`. Están vacíos upstream de verdad, y por
eso salen **sin** el marcador `unresolved`: el vacío ahí **sí** es una afirmación.

⛔ **Por qué el «10 de 29 = 34 %» no vale**, y es la corrección que el work-item hizo al issue
#182: mete en el denominador a 14 agentes cuya lista está vacía (no pueden exhibir el defecto) y
a 5 self-published (early-return, tampoco pueden). **Una tasa calculada sobre filas que NO
PUEDEN exhibir el defecto lo subestima.** La cifra correcta del «antes» es **10/10 = 100 %**
sobre la población elegible, y **24 de 24 federados** recibían `[]`.

### Re-verificación independiente, corrida por esta fase `[MEDIDO-DOCS]`

Sólo `GET`, contra `https://wasiai-a2a-production.up.railway.app`, 2026-08-27:

```
GET /discover/agentshop-kyc-validator                    → HTTP 200
  capabilities      = ['remittance', 'remit', 'kyc', 'compliance']
  capabilitiesState = <AUSENTE>        ← resuelto ⇒ el marcador NO viaja. Correcto (AC-2)

GET /agents/agentshop-kyc-validator/agent-card           → HTTP 200
  skills = ['remittance', 'remit', 'kyc', 'compliance']  ← ayer era []
```

⚠️ **Lo que esta fase NO re-corrió**: el barrido completo de los 29 agentes (son los números
`[MEDIDO-ORQ]` de la tabla) y el paso 4 del smoke (70 requests para provocar el `429`), porque
es una prueba de carga deliberada contra producción. Queda como verificación pendiente del
operador, con el comando en `qa-validation.md §6`.

---

## 8 · ⚠️ Cambio de comportamiento — PARA EL RELEASE NOTE

> ### `GET /discover/:slug` **ya no está exenta de rate limit**
>
> `src/routes/discover.ts` traía `config: { rateLimit: false }` desde `bd7ea69`
> (WKH-AUDIT-A2A), con el motivo escrito «read-only and cheap to serve»
> (`middleware/rate-limit.ts:9-10`). **Esta HU invalidó esa premisa**: el detalle pasó de
> 1 fetch upstream + como mucho 1 query de identidad, a 1 fetch upstream + un `discover()`
> completo. Medido en el fix-pack:
>
> | catálogo | filas que declaran token ERC-8004 | `supabase.from()` por UN `GET /discover/:slug` |
> |---|---|---|
> | 200 filas | todas | **201** |
> | 29 filas (el orden de magnitud de hoy) | todas | **30** |
> | 200 filas | ninguna | **0** |
> | *línea base* (la ruta llamando a `getAgent` pelado) | — | **1** |
>
> La línea fue **borrada** (`routes/discover.ts`, docblock del motivo en `:321-360`). Sin la
> exención, la ruta hereda el límite global `RATE_LIMIT_MAX` (**default 60/min por IP**), el
> mismo que ya gobierna a `GET /discover`, la ruta hermana que hace el MISMO fan-out.
>
> 📣 **Un consumidor que hoy martillea `GET /discover/:slug` va a empezar a ver `429`.** Es
> intencional y está justificado con números, pero es un cambio observable de una ruta pública
> y **tiene que ir en el release note**. T-15 lo fija ejecutando (`expected 200 to be 429`).
>
> Flanco cerrado que no estaba pedido: `routes/agent-card.ts`, que ahora hace el **mismo**
> fan-out, **nunca tuvo** exención — hereda el límite global `[ARTEFACTO ar-report-2.md §2]`.

---

## 9 · El gate del repo, corrido en esta fase de cierre `[MEDIDO-DOCS]`

⛔ `npm run qa` **NO existe en este repo**. El gate es la secuencia de
`.github/workflows/ci.yml`: `tsc` → `lint` → `test`. Corrido **después** de `git add` del
`done-report.md` y del `_INDEX.md` — la lección del §4 aplicada a esta misma fase.

`git status --porcelain` con los 2 archivos **staged** antes de correrlo:

```
A  doc/sdd/230-wkh-369-discover-detalle-capacidades-vacias/done-report.md
M  doc/sdd/_INDEX.md
```

```
############ PASO 1 · npx tsc -p tsconfig.json --noEmit ############
EXIT=0

############ PASO 2 · npm run lint ############
> biome check src/
Checked 519 files in 263ms. No fixes applied.
EXIT=0

############ PASO 3 · npm test ############
 Test Files  312 passed | 6 skipped (318)
      Tests  6310 passed | 19 skipped (6329)
 PIPESTATUS[0]=0
```

**Cuadra exacto con el gate de F4** (`0` · `519` · `312/318` · `6310/6329`): esta fase sólo
agregó archivos en `doc/`, y `test/readme-numbers.test.ts` cuenta `.ts` de `src/` y archivos de
test. Los guardianes que sí miran este cambio están adentro y en verde:
`test/sdd-index-matches-folders.test.ts` (G-D2: 7 columnas; G-A2: una sola fila para la carpeta
230; **G-E1: los 4 links de la fila apuntan a archivos que están en git** — por eso el
`git add` del `done-report.md` va antes; **G-F1/G-F2: `_INDEX.md:144` sigue diciendo lo que
`src/lib/capability-risk.ts` afirma**).

⚠️ **El `PIPESTATUS[0]` está pegado a propósito**: `npm test | tail` puede terminar con
`[exited with code 0]` porque ése es el exit del **pipe**, no el de `npm`. Es el corolario del §4.

Ruido preexistente, idéntico a la línea base de `auto-blindaje.md §0`: las líneas
`DOWN:`/`CONFIG:`/`PASS:` de la sonda del money-path y el aviso
`Failed to load source map for typescript.js`.

---

## 10 · Archivos modificados

Diff `18e4550..85cc288` `[MEDIDO-DOCS]`: **14 archivos, +2925 / −11**.

### Producción (`src/`) — 4 archivos, exactamente los ítems 1-4 de `sdd.md §4.7`

| Archivo | Acción | Qué hace |
|---|---|---|
| `src/services/agent-detail.ts` | **Creado** (+179) | El resolver `resolveAgentForDetailView`. Enriquece el detalle federado con lo que publica la lista, o marca `unresolved`. Vive **fuera** de `getAgent` (CD-11) |
| `src/routes/discover.ts` | Modificado (+44/−…) | `getAgent(...)` → `resolveAgentForDetailView(...)`; **quita `config: { rateLimit: false }`** (§8) |
| `src/routes/agent-card.ts` | Modificado (+10/−…) | Ídem en `:43`; el import se partió para no dejar `discoveryService` huérfano |
| `src/types/index.ts` | Modificado (+8) | `capabilitiesState?: 'unresolved'` en `Agent`, patrón «omitido, **no** `null`» |

### Tests — 2 archivos nuevos, 20 casos

| Archivo | Líneas |
|---|---|
| `src/services/agent-detail.test.ts` | +632 |
| `src/routes/discover.detail-capabilities.test.ts` | +434 |

### Documentación obligatoria por guardián

`README.md` (+4/−4) y `README.es.md` (+4/−4) — `316→318` y `516→519`. **No es scope creep**:
`test/readme-numbers.test.ts` los pone rojos si no se actualizan (F4-MNR-2).

### Artefactos del pipeline

`ar-report.md` · `ar-report-2.md` · `auto-blindaje.md` · `cr-report.md` · `qa-validation.md` ·
`sdd.md` (+27, las TDs nuevas). `work-item.md`, `sdd.md` y `story-HU-369.md` entraron antes
(`9ba550a` y siguientes).

### Lo que NO se tocó — verificado ejecutando, no leyendo

`[ARTEFACTO qa-validation.md §5]`

- ⛔ **Camino del dinero**: `services/discovery.ts`, `services/compose.ts`,
  `services/agent-price.ts`, `downstream-payment`, `adapters/**`, `middleware/x402`, `fee-*`,
  settle, escrow, `orchestrate` → **0 líneas** en el diff. CD-11 cumplida, y es lo que hace
  automáticas a CD-3/CD-4 y a AC-7.
- ⛔ **El pin del KYC**: `kyc-session-create` / `kyc-decision-read` sin tocar.
- ⛔ **Datos del catálogo**: cero migraciones, cero SQL. La medición de producción fue **sólo
  `GET`**.
- `services/agent-card.ts` (declarado «no se toca»): no aparece en el diff. AC-5 se satisface
  desde la ruta.

### Escala vs presupuesto (regla 10 de `CLAUDE.md`)

`[ARTEFACTO auto-blindaje.md §5 · cr-report.md check 2 · qa-validation.md §5]`

| Concepto | Presupuesto | Real | |
|---|---|---|---|
| Código de producción (sin prosa) | ≤ 70 | **38** | ✅ |
| Docblocks y comentarios | ≤ 60 | **59** | ✅ |
| Tests | ≤ 420 | **670** | ⚠️ **1.6×** |
| Total del diff en `src/` | ≤ 550 | **767** | ⚠️ **1.39×** (umbral 2× = 1100) |
| Archivos de producción tocados | 4 | **4** | ✅ |

El exceso es **de arnés, no de lógica**, y está atribuido: ~90 líneas por archivo de `vi.mock`
de las **siete** dependencias que `discovery.ts` toca (CD-7 prohíbe el atajo de doblar
`discoveryService`, y los `vi.mock` se hoistean por archivo: no se comparten), ~80 de fixture, y
el clasificador de tres estados, que **es** el contenido de AC-3. El CR lo contrastó **leyendo
el diff** y ninguna de las 5 señales de alarma apareció. Post-fix-pack el arnés creció otra vez
por los 6 bloqueantes (T-11..T-16), que no existían al presupuestar.

---

## 11 · Hallazgos finales

- **BLOQUEANTEs: 6 — los 6 resueltos.** 1 ALTO (gate rojo), 1 MEDIO (`catch` mudo), 3 BAJO
  (AR), 1 BAJO (CR). Re-verificados **ejecutando** en `ar-report-2.md`: cero bloqueantes.
- **MENORes: 10 — 2 cerrados en código, 8 convertidos en deuda escrita o cerrados por prosa.**
  Los 2 MENOR del AR-2 se cerraron en `cfb1cfe` (docblock de los `error_code` + el
  cross-reference al mutante equivocado), y de ese cierre salió `TD-369-10`.
- **3 F4-MNR abiertos**, ninguno bloqueante — §12.
- **Deuda arreglada de contrabando: ninguna.** `TD-369-1` (el `NaN` de `reputation`) y
  `TD-369-2` (`computedReputation`) siguen sin arreglar **a propósito**: arreglarlos habría
  cambiado los bytes de la lista y **violado AC-7**. Verificado una por una por el CR.

### Los 3 F4-MNR de `qa-validation.md`

| # | Qué es | Por qué no bloquea |
|---|---|---|
| **F4-MNR-1** | El residual de **precio** de AC-6 no tiene TD propia. T-06b **afirma con un assert** que si el detalle deja de traer `price_per_call`, el `priceUsdc` sale `0` —un precio plausible— **sin ningún marcador**. `capabilitiesState` sólo habla de `capabilities` | La población que hoy lo exhibe es **0 de 29**, medido contra prod. El agujero es **latente**, no vivo. `TD-369-4` declara una causa **distinta** (borrar `resolvePriceWithFallback`); ésta —que el upstream deje de mandar el campo— no depende de que nadie toque este repo. **Salida sugerida: TD nueva, o extender TD-369-4** |
| **F4-MNR-2** | `README.md:378` y `README.es.md:412` no están en la tabla `sdd.md §4.7` | No es scope creep: son **mecánicamente obligatorios**. Es una entrada que faltó en el presupuesto |
| **F4-MNR-3** | `doc/sdd/_INDEX.md` sin actualizar (ítem 8 de §4.7) | El propio §4.7 dice «al cerrar» ⇒ es trabajo de esta fase. **CERRADO acá** — §14 |

---

## 12 · Deuda técnica declarada

`[ARTEFACTO sdd.md §11]` — las 5 nuevas verificadas presentes por F4.

| TD | Qué | Origen | Por qué no se cerró acá |
|---|---|---|---|
| **TD-369-6** 🔴 | **El marcador `capabilitiesState` NO llega al Agent Card.** `services/agent-card.ts:124` construye la card campo por campo (no hay `...agent`) ⇒ un federado no resuelto sale con `skills: []`, el mismo `[]` ambiguo que esta HU mata, en la otra ruta que AC-5 inscribe | CR BLQ-BAJO-1 | `agent-card.ts` está **fuera del Scope IN**, y el `AgentCard` es un artefacto de **protocolo A2A**: meterle una clave no estándar tiene costo para todo consumidor y merece su propia HU. **No hay regresión** (hoy todas las cards federadas salían vacías). **Pineada ejecutando por T-14**: el día que se cierre, T-14 se pone rojo — ése es el punto |
| **TD-369-7** | El fixture (`listPayload`/`detailPayload`) está **duplicado** entre los dos archivos de test, y **ya divergió una vez** (`price_per_call` en una copia y no en la otra, las dos diciéndose «la forma medida en producción») | CR MNR-3 | Unificarlas exige un **octavo archivo** fuera del Scope IN. En el fix-pack las dos copias se **igualaron**; lo que queda pendiente es que el aviso sea mecánico y no prosa |
| **TD-369-8** | `getAgent` sigue devolviendo `capabilities: []` para todo federado, y **nada avisa al tercer consumidor**: el aviso vive en `agent-detail.ts`, que ese consumidor no va a abrir | CR MNR-4 | CD-11 prohíbe editar `discovery.ts`, y es lo que hace automáticas a CD-3/CD-4/AC-7. Exposición **hoy es cero**, medida: `grep -rn '\.capabilities' compose.ts agent-price.ts` → 0 |
| **TD-369-9** | `capabilitiesState` no está documentado en `doc/INTEGRATION.md` (`:390`, `:427`, `:525`), que es donde el repo documenta la respuesta de `/discover` | CR MNR-5 | `doc/**` fuera del Scope IN. No rompe a nadie (clave aditiva, sin response schema), pero la semántica «`capabilities: []` **sin** el marcador ES una afirmación» es justo la que un integrador necesita |
| **TD-369-10** | **Ningún `error_code` nombra la causa dominante.** «El endpoint de LISTA se cayó» sigue saliendo con el código de `DETAIL_AGENT_ABSENT_FROM_CATALOG`; lo que discrimina es el **valor** de `catalog_status`, no el código. Un operador que agrupe registros caídos por `error_code` sigue sin poder | AR-2 MNR-1 | Un tercer `error_code` cambia el vocabulario de logs del repo (WKH-318) y re-particiona lo que T-12 fija hoy en dos ramas. **No hay pérdida de señal**: el dato para discriminar viaja en el mismo warn. Pineada por **T-16** |

**Heredadas del F2, medidas y no arregladas**: `TD-369-1` (`reputation` es `NaN` para **27 de
29** agentes en **las dos** vistas; arreglarlo violaría AC-7), `TD-369-2` (`computedReputation`
en 9 agentes de la lista y **0** del detalle), `TD-369-3` (sin caché de catálogo: ~220 ms por
detalle), `TD-369-4` (`resolvePriceWithFallback` sostiene la paridad de precio **sin decirlo**),
`TD-369-5` (`metadata.inputSchema` no existe en ninguna vista: el crudo trae `input_schema` —
**toca a WKH-364**).

---

## 13 · Auto-Blindaje consolidado

`[ARTEFACTO auto-blindaje.md §3, §7.0, §7.7, §8 · cr-report.md · ar-report.md]`
**Sin resumir ni omitir entradas.**

### 13.1 · 🔴 El gate se corrió sobre el ÍNDICE, no sobre el disco (§7.0)

Ver §4. **Es la entrada más importante de esta HU.** `git add -A` va antes del gate final.
`npm test | tail` puede mostrar `[exited with code 0]`: ése es el exit del **pipe**, el de `npm`
está en `PIPESTATUS[0]`.

### 13.2 · `npx biome` no resuelve el ejecutable en este entorno (§3, W0)

`npx biome check --write` sale con `npm error could not determine executable to run`, **después
de imprimir una salida parcial confusa** (`Lint: 2 errors, 0 warnings`) que **no era del archivo
editado** — casi se lee como un fallo real de la edición. El paquete se llama `@biomejs/biome`.
**Fix**: `./node_modules/.bin/biome check --write <archivos>`.
**Aplicar en**: todo CD-14 de este repo. El Story File escribe el comando que **no corre acá**.

### 13.3 · Diez tests verdes no dicen nada sobre `tsc` (§3, W1)

Con los 10 tests en VERDE, el paso 1 del gate dio dos `error TS`: un doble que devolvía `null`
donde la firma real es `Promise<RegistryConfig | undefined>`, y
`agent.reputation = entrada.reputation` bajo `exactOptionalPropertyTypes: true`.
**`vitest` transpila sin chequear tipos.**
**Aplicar en**: cualquier asignación a un campo `?:` de `Agent` — el árbol compila con
`exactOptionalPropertyTypes`, así que **copiar un opcional incluye copiar su ausencia**. Escribir
`agent.reputation = undefined` habría publicado la clave con valor `null` tras el
`JSON.stringify`: **exactamente la ambigüedad que esta HU existe para matar**.

### 13.4 · El scratchpad compartido ya tenía un `.bak` de otra sesión (§3, W1)

La primera copia de respaldo fue a la raíz del scratchpad, que ya contenía un `discovery.ts.bak`
de otra sesión (301 archivos previos). Un `cp` de restauración desde el archivo equivocado habría
**revertido `discovery.ts` a un estado ajeno**.
**Fix**: subdirectorio propio + `/usr/bin/diff -q` **antes** de usar el backup (`diff` a secas
miente en este entorno: contesta `Files are identical` sobre archivos que difieren).
**Aplicar en**: todo protocolo de mutación. **Un backup que no comparaste no es un backup: es un
archivo con el nombre correcto.**

### 13.5 · El `import` que quedaba sin usar, y sí quedó sin usar (§3, W2)

Al reemplazar la única llamada a `discoveryService.getAgent` en `agent-card.ts:43`,
`discoveryService` quedó **huérfano** — el Story File anticipaba que «se sigue usando», pero lo
que se sigue usando es `extractDeclaredTokenId`, que viene del **mismo import con otro nombre**.
**Aplicar en**: `tsc` y `vitest` son **ciegos** a un import sin usar; sólo lo ve `biome`, y
`lint` va **segundo** en el gate. Es el modo de falla que ya sobrevivió 5 revisiones en este repo.

### 13.6 · El rojo predicho no fue el rojo real, y el test estaba incompleto (§2)

El rojo de T-09 no fue el que el Story File predijo. Se midió, se documentó, y **el test se
reforzó con la aserción que sí mata al mutante** (`expect(discoverSpy).not.toHaveBeenCalled()`).
**Un mutante que muere por el motivo equivocado es un test que no cubre lo que dice cubrir.**

### 13.7 · Mi propio guard dependía del ORDEN de los tests (§7.7)

Un guard del fix-pack pasaba o fallaba según el orden de ejecución. Cerrado y verificado con
**19/19 verdes aislados** (`ar-report-2.md`, cierre 6).

### 13.8 · Un cierre que EMPEORA la prosa (§8.1)

Al cerrar el AR-2 MNR-1, la salida no fue borrar la afirmación falsa del docblock sino
**escribirla correcta**: qué separan **realmente** los dos `error_code` (`discover()` tiró vs
`discover()` respondió sin la fila). Del propio cierre salió `TD-369-10`, porque quedó demostrado
que el modo de falla dominante **no** llega al `catch`.
**Y salió un rojo no previsto que dejó el test mejor** (§8.1, «Un rojo que NO estaba previsto»).

### 13.9 · El fixture vacío que pasa con el bug puesto (AR BLQ-BAJO-2 · CD-1)

CD-1 existía justamente para prohibirlo, y **no estaba mecanizada**. El testigo del contador lo
firmaba un agente **self-published** que hace early-return y **no pertenece a la población del
bug**. El control que lo prueba: mismo input, **guard nuevo ROJO / guard viejo VERDE**.
**El error de muestreo del issue, movido al test, donde se ve verde.**

### 13.10 · Una comparación que se auto-confirma (F4 §4.1)

La primera corrida de AC-7 dio dos sha256 idénticos… comparando **dos listas vacías**
(`state:"failed", failure:"bad_payload"`, porque la sonda devolvía `{agents:[...]}` en vez de un
array pelado). Se **descartó por vacua**. La versión buena trae `agents=2` y capacidades reales,
**y un control positivo** que demuestra que el instrumento discrimina.

### 13.11 · Citas desplazadas por la propia edición (CR MNR-1)

De las 36 citas verificadas por el CR, 4 fallaban — **todas en `auto-blindaje.md`, ninguna en el
código de producción**. Y **dos de las cuatro las desplazó el propio cambio**
(`discover.ts:234→235`, `:304→305`). Es la clase que el F2.5 ya había encontrado 5 veces en el
SDD, y coincide con la lección `citas-rotas-por-tu-propia-edicion`: **los barridos miran lo que
escribiste, no lo que desplazaste.**

### 13.12 · Prosa que afirma de más (CR MNR-2)

`agent-detail.ts:44-45` decía «NUNCA produce un 5xx» con la **función** como sujeto, pero
`await discoveryService.getAgent(...)` está **fuera del `try`** y propaga. El Story File §5.2
escribía la versión correcta («NUNCA **por el enriquecimiento**») y **el código perdió el
calificativo**. No es regresión: el daño es que **la frase apaga la próxima revisión del único
camino que sí puede 5xxear**.

### 13.13 · Higiene, en las cuatro fases

Backups en subdirectorio propio verificados con `/usr/bin/diff -q`; mutaciones con `sed -i` y
restauración por `cp`; worktrees detached en scratchpad para las mutaciones de F4;
`git status --porcelain` vacío antes y después en cada fase. ⛔ **Nunca `git checkout --`** —
es el arnés que restaura borrando lo que mide. Contra producción: **sólo `GET`**.
Herramientas: `/usr/bin/grep`, `/usr/bin/diff`, `/usr/bin/git`, `sed`/`awk`. **Sin `cat`**, sin
la herramienta `Grep`. La salida de `vitest` se leyó vía `rtk proxy` porque el filtro del proxy
la colapsa a `PASS (n) FAIL (n)` y se pierden los nombres de test.

---

## 14 · `_INDEX.md`

Fila **230** (línea **222**) actualizada **en el lugar**, de
`F1 (sólo work-item.md) · in progress — pendiente HU_APPROVED` a **DONE**.

⚠️ **Restricción load-bearing respetada**: `src/lib/capability-risk.ts` y
`src/lib/capability-risk.test.ts` citan `_INDEX.md:144`, verificado por `CITED_INDEX_LINES`
(`test/sdd-index-matches-folders.exceptions.ts:181-192`, que exige que esa línea contenga
`remit.corridor-discovery`, `kyc-check` y `cashout-match`). **La edición sustituye una línea por
una línea: el archivo sigue teniendo 362 líneas y nada por encima de la 222 se movió.** Se
verificó ejecutando el guardián, no leyéndolo (§9).

Esto cierra **F4-MNR-3** y el ítem 8 de `sdd.md §4.7`.

---

## 15 · Decisiones diferidas a backlog

No se crearon tickets nuevos en esta HU. Lo diferido vive como TD escrita en `sdd.md §11`
(§12 de este reporte). Los candidatos a HU propia, en orden de valor:

1. **TD-369-6** — llevar la distinción resuelto/no-resuelto al Agent Card A2A. Necesita su
   propio contrato: es el artefacto que mira el estándar. **Ya tiene su test pineado (T-14).**
2. **TD-369-9** — documentar `capabilitiesState` en `doc/INTEGRATION.md`.
3. **TD-369-10** — el tercer `error_code` (`DETAIL_CATALOG_DEGRADED`): toca el vocabulario de
   logs de WKH-318.
4. **F4-MNR-1** — el residual de precio: TD nueva o extensión de `TD-369-4`.
5. **TD-369-5** — `metadata.inputSchema` vs `input_schema`: **toca a WKH-364**, no a ésta.

---

## 16 · Lecciones para las próximas HUs

1. **Medí el artefacto que el SISTEMA consume, no el que tu cliente puede pedir.** Cuatro
   hipótesis cayeron por esto, y la #3 lo muestra entero: un `GET` sin credencial al mismo host
   devolvió **200 y otro cuerpo**. Antes de afirmar la forma de un payload upstream, preguntate
   **quién lo pide y con qué credencial** — si no es el mismo caller que el del código, no es el
   mismo dato.
2. **El árbol que el gate mide es el ÍNDICE de git, no tu working copy.** `git add -A` **antes**
   del gate final. Un guardián que enumera con `git ls-files` es ciego a lo que todavía no está
   en el índice — y lo que no está en el índice es, justamente, **lo que acabás de escribir**.
   Candidata a corolario de la regla 9 de `CLAUDE.md`.
3. **Una tasa calculada sobre filas que no pueden exhibir el defecto lo subestima.** «10 de 29»
   era 34 %; la cifra real era **100 % de la población elegible**. Antes de reportar una tasa,
   partí la población en «puede exhibirlo» / «no puede» y decí cuál es el denominador. El mismo
   error, movido al fixture, **se ve verde** (CD-1 / AR BLQ-BAJO-2).
4. **Un vacío no es una afirmación hasta que alguien lo declare.** `toArray(undefined)` y
   `toArray([])` colapsan en el mismo `[]`, y ese colapso reapareció **tres niveles arriba**: en
   el Agent Card (TD-369-6), en el `catch` mudo (AR BLQ-MED-1) y en el `priceUsdc = 0` sin
   marcador (F4-MNR-1). Cuando arregles un colapso de ese tipo, **buscá dónde más vive la misma
   forma** antes de cerrar.
5. **Arreglá afuera del choke-point.** El resolver vive en un archivo nuevo y
   `services/discovery.ts` tiene **0 líneas** en el diff. Eso convirtió CD-3, CD-4 y AC-7 de
   promesas en **propiedades del diseño**, y es lo que permitió que el camino del dinero no
   necesitara ni una sola revisión de regresión.
