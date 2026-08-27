# Work Item — [WKH-369] `/discover/<slug>` devuelve capacidades VACÍAS para todo agente federado, mientras `/discover` sí las publica

> Issue de origen: `github.com/ferrosasfp/wasiai-a2a/issues/182`
> Fase: F1 (Analyst). NO hay código en esta HU todavía.

---

## ⚠️ Condiciones bajo las que se escribió este F1 — leer antes de apoyarse en una cita

**Este F1 corrió SIN SHELL**: las únicas herramientas disponibles fueron `Read`, `Write` y
`Glob`. No hubo `grep`, `git`, `curl` ni `npm`. Se sigue la convención ya establecida por las
filas `224` y `225` de `_INDEX.md`, que corrieron con la misma limitación: **cada afirmación
lleva su marca**.

| Marca | Significado |
|---|---|
| `[MEDIDO-F1]` | Lo leí yo, en este árbol, en el archivo y línea que cito. |
| `[HEREDADO]` | Viene del barrido contra producción del 2026-08-27 que trae el encargo. No lo re-corrí. |
| `[NO MEDIDO]` | Es una derivación o una hipótesis. **No la trates como hecho.** |

⛔ **Tres consecuencias concretas de no tener shell, y las declaro para que nadie las lea como
hechos:**

1. **Ningún conteo de este documento es exhaustivo.** Sin `grep` no hay barrido. Donde digo
   "los consumidores de `getAgent`" estoy dando una **cota inferior** encontrada abriendo
   archivos de a uno, no un total. Cerrar el censo es pre-requisito de F2 (ver MI-4).
2. **No pude hacer ni un GET a producción.** Todo lo que este documento dice sobre la FORMA
   del payload de `https://app.wasiai.io/api/v1/agents/<slug>` es `[NO MEDIDO]`. Es la
   medición más barata que existe (un GET gratis) y es la primera tarea de F2.
3. **El nombre de rama es una propuesta sin verificar** — no pude correr
   `git rev-parse --abbrev-ref HEAD`. Lo declaro sin medir en vez de afirmarlo, que es
   exactamente el error que ya cometió una fila de este índice al nombrar una rama que
   existía y estaba contenida en `main` sin commits propios, haciendo que quien verificaba
   confirmara la mentira.

---

## Resumen

`GET /discover/<slug>` publica `capabilities: []` para **todo** agente servido por un
registro federado, mientras `GET /discover` publica para esos mismos agentes la lista real.
La causa no es que el agente no tenga capacidades: es que el camino de detalle aplica el
mapeo que el registro declaró **para el payload de la lista** sobre el payload de **otro
endpoint**, y una clave que no está se renderiza como un array vacío indistinguible de una
declaración de vacío. El entregable de la HU no es que las dos vistas coincidan hoy, sino
que no puedan volver a divergir en silencio.

---

## Sizing

- **SDD_MODE: `full`**
- **Modo del pipeline: QUALITY** (el tablero lo tenía como FAST+AR — se **sube**, nunca se baja)
- **Estimación: M**
- **Branch sugerido:** `fix/230-wkh-369-discover-detalle-capacidades-vacias` `[NO MEDIDO]`

### Por qué QUALITY y no FAST+AR — la razón escrita, como pidió el encargo

El encargo pide resolver el sizing y dejar la razón. No alcanza con "CLAUDE.md dice QUALITY",
aunque eso solo ya sería suficiente y es normativo. Las cuatro señales que lo sostienen por
mérito propio:

1. **El arreglo toca un choke-point COMPARTIDO con el camino del dinero, aunque el defecto
   no esté ahí.** `mapAgent` es UNA sola función que sirve a los dos caminos: la lista la
   invoca en `src/services/discovery.ts:1273` y el detalle en `:1436` `[MEDIDO-F1]`. El
   camino de lista alimenta a `/compose` vía el capability-resolver, o sea el camino del
   dinero. Un arreglo descuidado sobre el mapper compartido **llega al dinero aunque el bug
   no viva ahí**. Ésta es la señal fuerte: no es la severidad del defecto, es la ubicación
   del arreglo.
2. **El radio de impacto es mayor que el que reporta el issue.** El mismo `getAgent` alimenta
   `GET /agents/:slug/agent-card` (`src/routes/agent-card.ts:43` `[MEDIDO-F1]`), y las
   `skills` del Agent Card se derivan **directamente** de `agent.capabilities`
   (`src/services/agent-card.ts:124` `[MEDIDO-F1]`). O sea: los 24 federados también publican
   `skills: []` en el artefacto que mira el estándar A2A. El issue no lo menciona.
3. **La verificación es el entregable, y eso es F4 con evidencia.** Lo que se pide no es un
   parche sino un guard que no pueda ponerse verde con el bug puesto. FAST+AR no tiene CR ni
   F4 con evidencia `archivo:línea`, que es exactamente el rol que acá hay que ejercer.
4. **Demo Day es el lunes 31.** Con esa fecha encima, una regresión silenciosa en `/discover`
   —la ruta más caliente y la que alimenta la demo— cuesta más que los dos días de proceso.

⚠️ **Lo que NO es señal, y lo digo porque invita a bajar el modo:** que la ruta sea un GET
gratis y de sólo lectura. Es cierto y es lo que hace que el DEFECTO sea de baja severidad;
no dice nada sobre el riesgo del ARREGLO, que es lo que decide el modo.

### Skills de dominio (máx. 2)

- `api-contract-design` — el contrato de una vista parcial y cómo se declara.
- `test-verification-design` — el diseño del guard no-vacuo (es el corazón de la HU).

---

## El hallazgo — y el issue #182 lo cuenta mal

**Todo esta sección es `[HEREDADO]`** del barrido del 2026-08-27 contra producción, sólo GETs.

El issue dice *"5 de 12 muestreados difieren"* y propone que el patrón es "ser federado". El
barrido completo de los 29 agentes, comparando `capabilities` de `GET /discover?limit=100`
contra `GET /discover/<slug>`:

```
29 comparados · 19 iguales · 10 DIFIEREN · 0 errores
```

Los 10: `agentshop-cashout-matcher`, `agentshop-corridor-discoverer`,
`agentshop-kyc-validator`, `wasi-chainlink-price`, `wasi-defi-sentiment`,
`wasi-liquidity-analyzer`, `wasi-onchain-analyzer`, `wasi-wallet-profiler`,
`wasi-risk-report`, `wasi-contract-auditor`. En **todos**: la lista trae 4 capacidades, el
detalle trae `[]`.

### 🔴 El patrón real es más fuerte, y la aritmética importa

| Población | n | Detalle devuelve `[]` | ¿Puede exhibir el defecto? |
|---|---|---|---|
| Federados **con** capacidades en la lista | 10 | 10 | **Sí** |
| Federados **sin** capacidades en la lista | 14 | 14 | **No** — no tienen nada que perder |
| Federados (total) | **24** | **24** | — |
| Self-published | 5 | 0 | Sí, y coinciden |

⇒ La afirmación correcta es: **el detalle devuelve `[]` para 24 de 24 federados (100 %)**.

Los "19 iguales" son 14 federados que coinciden **en vacío** más 5 self-published que
coinciden con contenido. Sumar esos 14 al lado sano es contar como evidencia de salud a
filas que, por construcción, no podían dar otra cosa.

### ⇒ El punto metodológico, que es lo que esta HU deja escrito

**"10 de 29" no es la tasa del defecto: es la tasa de agentes con datos cargados.** Una tasa
calculada sobre filas que NO PUEDEN exhibir el defecto lo subestima, y acá lo subestimó por
un factor de ~3 (34 % contra 100 %). El error no es de quien escribió el issue: es el modo
de falla por defecto de cualquier medición de paridad, porque **"coincide" y "coincide
vacío" se ven idénticos en la salida**.

Esto va a un AC (AC-3) y a un CD (CD-1), porque el mismo error, cometido en el TEST en vez
de en el issue, produce un guard que pasa con el bug puesto. Es el mismo error de muestreo,
una capa más adentro y mucho más caro.

---

## La divergencia — dónde está, citada

### El issue sospecha de `mapAgent`. Verificado: `mapAgent` NO es donde diverge

`[MEDIDO-F1]` Los dos caminos llaman **a la misma función, sin diferencias**:

| Camino | Call-site | Qué le pasa |
|---|---|---|
| Lista | `src/services/discovery.ts:1273` | `agentsData.map((raw) => this.mapAgent(registry, raw))` |
| Detalle | `src/services/discovery.ts:1436` | `const agent = this.mapAgent(registry, data)` |

`mapAgent` (`src/services/discovery.ts:1345-1382`) es determinista y no ramifica por camino.
**No hay una rama del mapper que trate distinto al detalle.** Marcar `mapAgent` como el bug,
como sugiere el issue, mandaría a Dev a buscar una diferencia que no existe.

### Dónde diverge de verdad: en lo que se le DA DE COMER al mapper

Son dos asimetrías estructurales, y las dos están en el árbol:

**(a) La lista desenvuelve el sobre; el detalle no tiene con qué.** `[MEDIDO-F1]`

```
lista:    agentsData = schema.agentsPath ? getNestedValue(data, schema.agentsPath) : data   (:1257-1259)
detalle:  this.mapAgent(registry, data)                                                     (:1436)
```

El esquema del registro declara **`agentsPath`** para decir dónde vive el array dentro de la
respuesta de la lista. **No existe ningún `agentPath` equivalente para la respuesta de
detalle**: el camino de detalle asume que el agente está en la raíz del cuerpo. Si el
endpoint de detalle envuelve (`{ data: … }`, `{ agent: … }`), todo se lee mal.

**(b) El mapeo se declaró para UN endpoint y se aplica a DOS.** `[MEDIDO-F1]` — y ésta es la
que explica el síntoma exacto.

La fila del registro federado `wasiai` se siembra en
`supabase/migrations/20260401000000_kite_registries.sql:38-70`, y **los dos endpoints son
endpoints distintos de APIs distintas**:

```sql
discovery_endpoint  'https://app.wasiai.io/api/v1/capabilities'      -- :41
agent_endpoint      'https://app.wasiai.io/api/v1/agents/{slug}'     -- :43
```

con un **único** `agentMapping` (`:51-59`), declarado para el primero:

```json
"capabilities": "tags",                       // :56
"price":        "price_per_call_usdc",        // :57
"reputation":   "erc8004.reputation_score"    // :58
```

⇒ En el detalle, `getNestedValue(data, 'tags')` `[MEDIDO-F1: :1360-1362]` busca la clave
`tags` en el cuerpo de `/api/v1/agents/<slug>`. Si esa clave no está ahí, devuelve
`undefined`, y `toArray(undefined)` devuelve `[]` (`src/services/discovery.ts:1491-1495`
`[MEDIDO-F1]`).

### 🎯 Por qué falla EXACTAMENTE `capabilities` y aparentemente nada más

Ésta es la derivación que más rinde de todo el F1, y hace una predicción falsable.

`[MEDIDO-F1]` De los siete campos que `mapAgent` resuelve por mapeo, **`capabilities` es el
único cuyo path declarado difiere de su propio nombre canónico**:

| Campo | Path declarado | ¿Path == nombre? |
|---|---|---|
| `id` | `id` | ✅ sí |
| `name` | `name` | ✅ sí |
| `slug` | `slug` | ✅ sí |
| `description` | `description` | ✅ sí |
| `verified` | `verified` | ✅ sí |
| `status` | `status` | ✅ sí |
| **`capabilities`** | **`tags`** | ❌ **NO** |
| `priceUsdc` | `price_per_call_usdc` | ❌ **NO** |
| `reputation` | `erc8004.reputation_score` | ❌ **NO** |

Los seis primeros usan la misma clave en cualquier payload razonable de agente, así que una
diferencia de forma entre los dos endpoints **es invisible para ellos**. Los tres últimos
son los únicos que pueden romperse — y `capabilities` es el único de los tres que el barrido
midió.

⇒ **Predicción falsable, `[NO MEDIDO]`:** `priceUsdc` y `reputation` son los otros dos
candidatos, y son exactamente los que hay que medir en F2. Que el barrido no los haya visto
**no es evidencia de que estén sanos**: es que no se los miró. Es la misma trampa de
muestreo del issue, en otro eje.

---

## ¿Cuál de las dos vistas dice la VERDAD para un federado?

**Respuesta: la LISTA.** El argumento es de mecanismo, no de mayoría, y no requiere haber
hecho el GET:

1. **La lista aplica el mapeo declarado al payload para el que fue declarado.** El
   `agentMapping` y el `discovery_endpoint` se sembraron **en la misma sentencia SQL**
   (`20260401000000_kite_registries.sql:41` y `:51-59` `[MEDIDO-F1]`). Esa correspondencia
   es la definición operativa de "leer bien". El detalle aplica ese mismo mapeo a un
   endpoint que nunca lo declaró, y sin `agentPath` con qué desenvolver.
2. **El vacío del detalle es incapaz de significar lo que afirma.** `toArray(undefined)` es
   `[]` y `toArray([])` también es `[]` (`:1491-1495` `[MEDIDO-F1]`): **la ausencia de la
   clave y la declaración de vacío colapsan en el mismo valor.** El `[]` del detalle no es
   una afirmación sobre el agente; es el residuo de haber buscado en el lugar equivocado,
   presentado con la misma cara que una afirmación.
3. **Asimetría del error — y esto es lo que cierra el caso.** Un path equivocado sólo puede
   **perder** datos, nunca **inventarlos**. Cuatro strings de capacidad plausibles no se
   fabrican leyendo la clave que no es. ⇒ El lado con contenido es el que lleva información;
   el lado vacío es compatible tanto con la verdad como con el error, así que no puede ser
   la evidencia que decide.

⛔ **Lo que NO se probó, y no lo voy a escribir como si sí:** que el cuerpo de
`/api/v1/agents/<slug>` publique las capacidades bajo `capabilities` (o bajo cualquier otra
clave concreta). Eso es `[NO MEDIDO]` y es MI-1. La conclusión "la lista es la verdadera" **no
depende** de conocer esa clave; la conclusión sobre **cómo** arreglarlo sí.

---

## Acceptance Criteria (EARS)

- **AC-1** — WHEN un caller pide `GET /discover/<slug>` para un agente servido por un
  registro federado, the system SHALL devolver un `capabilities` igual al que
  `GET /discover` publica para ese mismo slug en el mismo estado de catálogo.

- **AC-2** — IF el camino de detalle no puede resolver la lista de capacidades desde el
  payload upstream, THEN the system SHALL declarar la vista como no resuelta en vez de
  publicar `[]`, de modo que "el agente no declara capacidades" y "el gateway no pudo
  leerlas" **no** colapsen en el mismo valor. (Es el precedente ya establecido de WKH-318:
  `rows: null` ≠ `rows: 0`.)

- **AC-3** — WHEN se mida la paridad entre las dos vistas, the system SHALL clasificar cada
  agente en **`difiere` / `coincide-con-contenido` / `coincide-en-vacío`**, y SHALL calcular
  la tasa del defecto **sobre la población que puede exhibirlo** (los que tienen lista no
  vacía), nunca sobre el total. Una medición que reporte un solo número agregado sin esa
  partición NO satisface este AC.

- **AC-4** — WHILE el defecto esté presente en el camino de detalle, the test de paridad
  SHALL fallar. (Verificable sólo re-introduciendo el defecto a propósito; ver CD-2.)

- **AC-5** — WHEN se pide `GET /agents/<slug>/agent-card` para un agente federado, the system
  SHALL derivar `skills` de la misma lista de capacidades que publica `GET /discover`.

- **AC-6** — WHEN el camino de detalle mapee un payload federado, the system SHALL producir
  los mismos valores que el camino de lista para **todo** campo de `agentMapping` cuyo path
  declarado difiera de su nombre canónico — hoy `capabilities`→`tags`,
  `price`→`price_per_call_usdc`, `reputation`→`erc8004.reputation_score` — o SHALL declarar
  el campo como no resuelto según AC-2.

- **AC-7** — WHILE esta HU esté desplegada, the system SHALL dejar `GET /discover`,
  `POST /discover` y la resolución por capacidad de `/compose` con salida **byte-idéntica**
  para las mismas entradas. Cualquier diferencia observable en el camino de lista es una
  regresión, no una mejora.

- **AC-8** — WHEN se ejecute el gate del repo en el orden de `.github/workflows/ci.yml`
  (`npx tsc -p tsconfig.json --noEmit` → `npm run lint` → `npm test`), the system SHALL
  pasar los tres pasos. `[NEEDS CLARIFICATION: los números de línea base de la suite los
  fija F2 corriéndola; este F1 no pudo.]`

---

## Scope IN

- `src/services/discovery.ts` — `getAgent` (`:1387-1465`) y lo que le da de comer a
  `mapAgent` (`:1436`). El fix vive acá.
- `src/services/discovery.ts` — `toArray` (`:1491-1495`) **sólo si** AC-2 exige distinguir
  ausencia de vacío. ⚠️ Es compartido con el camino de lista: cualquier cambio acá cae bajo
  CD-4.
- Los campos de AC-6 (`capabilities`, `priceUsdc`, `reputation`) y `metadata`, que en el
  detalle es el cuerpo entero (`metadata: raw`, `:1378` `[MEDIDO-F1]`) y por lo tanto es
  **la superficie por la que las sondas leen `metadata.inputSchema`**.
- El artefacto de verificación: test de paridad no vacuo + su partición de tres estados (AC-3).
- `doc/sdd/_INDEX.md` — fila de la HU.

## Scope OUT — explícito

- ⛔ **El camino del dinero.** Nada de `src/lib/downstream-payment.ts`, `src/adapters/**`,
  `src/middleware/x402.ts`, `fee-*`, settle, escrow. **Demo Day es el lunes 31.**
- ⛔ **El pin de seguridad del KYC.** `kyc-session-create` y `kyc-decision-read` resuelven a
  UN solo agente cada una, verificado el 2026-08-27 `[HEREDADO]`. No se toca.
- ⛔ **Republicar filas del catálogo.** Eso es OPS, no código — y encima sobre `bdwv`, que
  **sirve producción** (`.nexus/project-context.md:97` `[MEDIDO-F1]`). Editar la fila del
  registro para "emparejar" las vistas sería tapar el defecto con un cambio de datos no
  versionado y no testeable.
- ⛔ **WKH-366 no es la causa.** Los 10 son preexistentes y federados `[HEREDADO]`.
- **El camino de lista**, salvo por AC-7 (que exige demostrar que NO cambió).
- Las 14 filas federadas con capacidades vacías upstream: si están vacías de verdad es un
  problema de datos, no de código (pero ver MI-3).
- Agregar un `agentPath` configurable al esquema de registro **como feature nueva** para
  terceros: si el fix lo necesita entra, pero generalizarlo a un contrato público es otra HU.

---

## Decisiones técnicas (DT-N)

- **DT-1 — La vista autoritativa para un federado es la LISTA.** Justificación en la sección
  homónima: correspondencia mapeo↔endpoint declarada en la misma migración, más la asimetría
  del error (un path malo pierde, no inventa). **Resolver esto ANTES de tocar código es
  obligatorio**: sin esta decisión, cualquier arreglo sólo mueve la inconsistencia de lado.

- **DT-2 — El defecto es de ALIMENTACIÓN del mapper, no del mapper.** `mapAgent` es correcto
  y compartido; se rompe la precondición que asume (que el `raw` tenga la forma para la que
  se declaró el mapeo). ⇒ El fix debe estar en `getAgent`, no en `mapAgent`. Corrige la
  sospecha del issue.

- **DT-3 — Un vacío no resuelto no se publica como vacío declarado.** Es el precedente ya
  pagado por WKH-318 en este mismo archivo (`rows: null` ≠ `0`, `state: 'ok'` se gana con
  evidencia). Esta HU aplica la MISMA regla al detalle en vez de inventar una segunda.

- **DT-4 — Mecanismo del arreglo: DECISIÓN DE F2, no de F1.** Hay al menos tres caminos
  (resolver el detalle a través del mismo pipeline de lista; declarar un `agentPath` +
  mapeo propio del detalle; que el detalle degrade a la lista cuando no resuelve). Elegir
  exige el GET de MI-1, que este F1 no pudo hacer. **No lo pre-decido**: fijarlo sin la
  medición es exactamente lo que produjo el diagnóstico equivocado del issue.

- **DT-5 — El radio incluye el Agent Card.** `GET /agents/:slug/agent-card` consume el mismo
  `getAgent` (`agent-card.ts:43`) y sus `skills` salen de `agent.capabilities`
  (`agent-card.ts:124`). Entra al alcance de la verificación (AC-5), no como bonus.

---

## Constraint Directives (CD-N)

- **CD-1 — 🔴 PROHIBIDO un fixture de paridad con capacidades vacías.** OBLIGATORIO que el
  agente federado del fixture tenga **al menos 2 capacidades no vacías** en la vista de lista
  **y** un payload de detalle con la forma divergente. Un fixture vacío **pasa con el bug
  puesto**: es literalmente el mismo error de muestreo que cometió el issue, movido al test,
  donde es mucho más caro porque se ve verde. Si el test no puede fallar, no es un test.

- **CD-2 — OBLIGATORIO romper a propósito cada test nuevo antes de darlo por bueno.** El rojo
  se cita en F4 con el archivo:línea mutado y la salida. Un guard cuyo rojo nadie vio no está
  entregado. Todo AC que afirme un comportamiento **se ejecuta**: una cita `archivo:línea`
  dice dónde vive el código, no qué hace corriendo.

- **CD-3 — PROHIBIDO tocar el camino del dinero.** Ver Scope OUT. Si el arreglo parece
  necesitarlo, es señal de que el arreglo está mal planteado: parar y escalar.

- **CD-4 — PROHIBIDO cambiar el comportamiento observable de `mapAgent` para el camino de
  LISTA.** Si se lo toca, AR debe demostrar equivalencia en el camino de lista con evidencia
  ejecutada, no con lectura (AC-7). Es el punto donde este arreglo puede alcanzar al dinero.

- **CD-5 — PROHIBIDO "arreglar" esto editando datos.** Ni la fila `registries` de `bdwv`, ni
  republicar el catálogo. El arreglo es de código, versionado y testeable. (Además `bdwv`
  sirve producción: un experimento destructivo ahí toca prod.)

- **CD-6 — Ningún guard puede leerse a sí mismo.** PROHIBIDO que el test de paridad compare
  la salida del mapper contra el mapper, o derive el valor esperado del mismo código que
  vigila. El valor esperado se escribe **a mano** en el fixture. (Precedente del repo:
  `CITED_INDEX_LINES` y su `mustContain` escrito a mano — `test/sdd-index-matches-folders.exceptions.ts:172-179`
  `[MEDIDO-F1]`.)

- **CD-7 — PROHIBIDO validar esta HU con un test que mockee `discoveryService`.** Es **la
  razón medida por la que el bug sobrevivió**: la única suite sobre la ruta de detalle mockea
  el service entero, con `getAgent: vi.fn().mockResolvedValue(null)`
  (`src/routes/discover.test.ts:25-30` `[MEDIDO-F1]`) ⇒ `mapAgent` **nunca corre** en el
  camino de detalle bajo test, y por construcción ninguna cantidad de tests de esa ruta puede
  cazar esto. El testigo tiene que ejercitar el mapeo real sobre un payload doblado a nivel
  de `fetch`, como ya hace `src/services/discovery.test.ts` `[MEDIDO-F1: :43-48]`.

- **CD-8 — El gate del repo se corre COMPLETO y EN ORDEN, una vez.** ⛔ `npm run qa` **NO
  EXISTE en este repo**. Es `npx tsc -p tsconfig.json --noEmit` → `npm run lint` →
  `npm test`. Correr las partes de un gate no es correr el gate; `lint` va segundo y es el
  eslabón que nadie alcanza.

---

## Missing Inputs

| # | Qué falta | Bloquea | Cómo se resuelve |
|---|---|---|---|
| **MI-1** | La forma real del cuerpo de `https://app.wasiai.io/api/v1/agents/<slug>`: ¿está el agente en la raíz o envuelto? ¿bajo qué clave viaja la lista de capacidades? | **F2** (decide DT-4) | Un `GET`. Es gratis y de sólo lectura. **Primera tarea de F2.** |
| **MI-2** | ¿`priceUsdc` y `reputation` también divergen? (los otros dos campos cuyo path ≠ nombre) | F2 (fija el alcance de AC-6) | Mismo GET de MI-1, comparando los tres campos. Hoy `[NO MEDIDO]`. |
| **MI-3** | Las 14 filas federadas con lista vacía: ¿están vacías upstream, o su vacío tiene otra causa? | No bloquea | Si upstream tiene `tags`, hay un segundo defecto. Se mira en el mismo GET. |
| **MI-4** | Censo completo de consumidores de `getAgent`. Encontré 2 (`routes/discover.ts:337`, `routes/agent-card.ts:43`) **abriendo archivos de a uno: es cota inferior, no total** | **F3** | `grep -rn 'getAgent' src/` con `/usr/bin/grep`. Sin shell no hay barrido. |
| **MI-5** | ¿El detalle debe **degradar a la lista** o **declararse parcial** cuando no resuelve? (AC-2 fija el qué; el cómo es contrato público) | F2 | Decisión de diseño del Architect. Si toca el contrato de respuesta, escalar al founder. |
| **MI-6** | Línea base de la suite (`tsc`/`lint`/`npm test`) antes de tocar nada | F3 | Correr el gate. Este F1 no pudo. |

⚠️ **Ninguno bloquea el gate `HU_APPROVED`.** MI-1 y MI-2 se cierran con un solo GET gratis
al empezar F2.

---

## Análisis de paralelismo

- **¿Bloquea a otras?** **Sí, a una concreta.** `GET /discover/<slug>` es la vista de la que
  las sondas derivan el input desde el `inputSchema` publicado **en la misma corrida** — el
  AC-1 de WKH-364 (fila `227`) prohíbe explícitamente un body literal. Y el `inputSchema` no
  vive en la raíz de la respuesta sino en `metadata.inputSchema`, que en el detalle es el
  cuerpo crudo del endpoint de detalle (`metadata: raw`, `discovery.ts:1378` `[MEDIDO-F1]`).
  ⇒ **Si el cuerpo de detalle tiene otra forma, el `metadata` del detalle es otro objeto que
  el de la lista, y toda sonda que derive su input desde el detalle está derivándolo de una
  fuente distinta de la que documenta el catálogo.** No lo afirmo como roto —`[NO MEDIDO]`—
  pero es el mismo mecanismo que ya produjo el `[]`, y es la razón por la que esto importa
  más de lo que el issue sugiere.
- **¿Puede ir en paralelo?** Sí con cualquier HU que no toque `src/services/discovery.ts`.
- **⚠️ Riesgo de conflicto declarado:** `discovery.ts` es un archivo caliente — WKH-318 (filas
  `215`/`218`), HU-323 (`219`), WKH-313 (`211`) y WKH-322 (`217`) lo tocaron todas. **No
  verifiqué el estado de ninguna rama** (sin `git`) `[NO MEDIDO]`. Antes de F3, comprobar con
  `git merge-base --is-ancestor <sha> origin/main` — ⛔ **NO** con `git log` bajo el proxy,
  que **omite los commits de merge** y contesta "no está en main" cuando sí está. Ese
  instrumento ya hizo que este mismo índice declarara abierta una HU mergeada, y que un F1
  recomendara esperar el merge de una rama ya mergeada.
- **Precedencia sugerida:** después de esta HU conviene revisar si WKH-364 lee capacidades o
  schema desde el detalle. Si lo hace, hereda el arreglo gratis.

---

## Notas para el Architect (F2) — el orden que ahorra trabajo

1. **`GET https://app.wasiai.io/api/v1/agents/<slug>`** para uno de los 10 (p. ej.
   `wasi-chainlink-price`) y `GET /api/v1/capabilities` para el mismo. Diff de claves.
   Cierra MI-1, MI-2 y MI-3 de una.
2. Con eso, DT-4 se decide sola: si el cuerpo está en la raíz y sólo cambia la clave de
   capacidades, el arreglo es de mapeo; si viene envuelto, es de desenvoltura.
3. Recién ahí, el SDD. **Declarar el presupuesto de escala del diff** (regla 10 de CLAUDE.md):
   este arreglo debería ser chico. Si el diff se va a más del doble, se justifica por escrito
   o se recorta — la pregunta que decide es *¿qué parte de esto seguiría existiendo si lo
   escribiera alguien que ya conoce este código?*
