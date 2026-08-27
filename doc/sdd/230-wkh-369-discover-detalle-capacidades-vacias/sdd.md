# SDD #230: [WKH-369] `/discover/<slug>` publica capacidades vacías para todo agente federado

> SPEC_APPROVED: no
> Fecha: 2026-08-27
> Tipo: bugfix con contrato (SDD_MODE: `full`, como fija el F1)
> SDD_MODE: full
> Branch: `fix/230-wkh-369-discover-detalle-capacidades-vacias`
> Artefactos: `doc/sdd/230-wkh-369-discover-detalle-capacidades-vacias/`
> Input: `work-item.md` (HU_APPROVED 2026-08-27, commit `9ba550a`)

---

## 0. Condiciones de este F2 — y la marca de cada afirmación

Este F2 corrió **con shell y con red**. Todo lo que el F1 dejó `[NO MEDIDO]` se midió.

| Marca | Significado |
|---|---|
| `[MEDIDO-F2]` | Lo ejecuté yo en esta corrida, contra este árbol o contra producción, el 2026-08-27. |
| `[MEDIDO-F1]` | Viene del work-item, leído en el árbol. Lo re-verifiqué donde lo cito. |
| `[NO MEDIDO]` | Derivación o hipótesis. **No es un hecho.** |

⛔ **Cuatro hipótesis han caído en esta HU por darse por buenas sin medir. Es el patrón
de este defecto, y por eso vale la pena escribirlo antes que nada:**

| # | Hipótesis | Quién la sostuvo | Cómo cayó |
|---|---|---|---|
| 1 | «El bug está en `mapAgent`» | issue #182 | `[MEDIDO-F1]` los dos caminos llaman a la misma función sin ramificar (`discovery.ts:1273` lista, `:1436` detalle) |
| 2 | «Falta un `agentPath` para desenvolver el sobre del detalle» | F1 | `[MEDIDO-F2]` el detalle **no tiene sobre**: el agente viene en la raíz. Agregar `agentPath` no apunta a ningún lado |
| 3 | «El payload de LISTA trae `capabilities`, no `tags`, así que la lista anda por un fallback al nombre canónico» | encargo de F2 | `[MEDIDO-F2]` **falso en la premisa y falso en la consecuencia**. Ver §3.2: el cuerpo que el gateway consume SÍ trae `tags`, y en `mapAgent` **no existe** ningún fallback al nombre canónico para `capabilities` |
| 4 | «Se puede pedir un solo agente al registro federado con `?q=<slug>`» | mío, al diseñar (a) | `[MEDIDO-F2]` `?q=agentshop-kyc-validator&limit=1` → `agents: [], total: 0`. El filtro de texto **no mira el slug** (`discovery.ts:466-473`) |

La #3 merece un párrafo, porque es la que más se parece a la trampa que la HU documenta:
la medición que la sostenía era un `GET` **sin autenticar** a
`https://app.wasiai.io/api/v1/capabilities`, y ese endpoint **no devuelve el mismo cuerpo
que el gateway consume**. Sin credencial delega en el propio `/discover` de a2a y devuelve
agentes ya mapeados (con `capabilities` en la raíz). El cuerpo que el gateway realmente
recibe es el catálogo nativo de v2, con `tags`. Se demuestra en §3.2 sin necesidad de
autenticarse. **Medí el artefacto que el sistema consume, no el que tu cliente puede pedir.**

---

## 1. Resumen

`GET /discover/<slug>` publica `capabilities: []` para **24 de 24** agentes federados,
mientras `GET /discover` publica la lista real para esos mismos slugs `[MEDIDO-F2]`. El
mismo defecto vacía las `skills` del Agent Card A2A (`GET /agents/<slug>/agent-card`),
medido en vivo.

La causa **no** es el mapper ni un sobre: es que **el endpoint de detalle del registro
federado no publica capacidades bajo ningún nombre**. `tags`, `capabilities`, `skills`,
`labels` y `keywords` están todos ausentes de su cuerpo `[MEDIDO-F2]`. Lo más parecido es
`category`, que es **una** de las cuatro.

Por lo tanto el arreglo no puede ser de mapeo: el dato **no está en la respuesta que se
está leyendo**. Hay que ir a buscarlo a la única fuente que lo tiene (la lista) o declarar
que no se pudo resolver. AC-1 obliga a lo primero y AC-2 a lo segundo cuando lo primero
falla, así que el diseño hace **las dos**, y lo hace **fuera de `getAgent`** para que el
camino del dinero quede intacto por construcción y no por promesa.

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 230 |
| **Tipo** | bugfix con cambio aditivo de contrato |
| **SDD_MODE** | full |
| **Objetivo** | Que la vista de detalle publique las mismas capacidades que la lista, y que cuando no pueda resolverlas lo **diga** en vez de publicar `[]` |
| **Reglas de negocio** | La vista autoritativa para un federado es la LISTA (DT-1 del F1). Un vacío no resuelto no se publica como vacío declarado (DT-3) |
| **Scope IN** | §6 |
| **Scope OUT** | §6 — ⛔ camino del dinero, ⛔ pin del KYC, ⛔ edición de datos |
| **Missing Inputs** | MI-1..MI-3 y MI-6 **CERRADOS** en este F2 (§9). MI-4 cerrado (§3.4). MI-5 resuelto por DT-4/DT-6 |

### Acceptance Criteria (EARS) — heredados sin cambios del work-item

- **AC-1** — WHEN un caller pide `GET /discover/<slug>` para un agente servido por un
  registro federado, the system SHALL devolver un `capabilities` igual al que
  `GET /discover` publica para ese mismo slug en el mismo estado de catálogo.
- **AC-2** — IF el camino de detalle no puede resolver la lista de capacidades desde el
  payload upstream, THEN the system SHALL declarar la vista como no resuelta en vez de
  publicar `[]`.
- **AC-3** — WHEN se mida la paridad entre las dos vistas, the system SHALL clasificar cada
  agente en **`difiere` / `coincide-con-contenido` / `coincide-en-vacío`**, y SHALL calcular
  la tasa del defecto **sobre la población que puede exhibirlo**.
- **AC-4** — WHILE el defecto esté presente en el camino de detalle, the test de paridad
  SHALL fallar.
- **AC-5** — WHEN se pide `GET /agents/<slug>/agent-card` para un agente federado, the
  system SHALL derivar `skills` de la misma lista de capacidades que publica `GET /discover`.
- **AC-6** — WHEN el camino de detalle mapee un payload federado, the system SHALL producir
  los mismos valores que el camino de lista para **todo** campo de `agentMapping` cuyo path
  declarado difiera de su nombre canónico, o SHALL declarar el campo como no resuelto.
- **AC-7** — WHILE esta HU esté desplegada, the system SHALL dejar `GET /discover`,
  `POST /discover` y la resolución por capacidad de `/compose` con salida **byte-idéntica**.
- **AC-8** — WHEN se ejecute el gate del repo en el orden de `.github/workflows/ci.yml`,
  the system SHALL pasar los tres pasos. ✅ **`[NEEDS CLARIFICATION]` del F1 RESUELTO** —
  la línea base está medida en §3.5.

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos

| Archivo | Por qué | Patrón / hallazgo extraído |
|---|---|---|
| `src/services/discovery.ts` (`:1257-1273`, `:1345-1382`, `:1387-1465`, `:1469-1495`, `:1500-1544`, `:466-473`) | Es donde vive todo el mecanismo | `mapAgent` no ramifica; **el único fallback al nombre canónico es el de `price`**; el filtro `q` no mira el slug |
| `src/routes/discover.ts` (`:319-343`) | El consumidor del detalle | El handler es `getAgent` → `reply.send(agent)`, sin enriquecimiento |
| `src/routes/agent-card.ts` (`:43`, `:52-73`, `:88-99`) | Radio de AC-5 | 🎯 **Exemplar clave**: `computedReputation` **se computa en el ROUTE, NO en `getAgent`**, con el motivo escrito en `:91` |
| `src/services/agent-card.ts` (`:124`) | Cómo se derivan las `skills` | `agent.capabilities.map(...)` ⇒ `[]` entra, `skills: []` sale. No hay nada que arreglar acá si `capabilities` llega bien |
| `src/types/index.ts` (`:305`, `:421-458`, `:591-624`, `:775-797`) | El contrato `Agent` y `DiscoveryQuery` | Patrón **"omitido, no `null`"** ya establecido tres veces (`identity`, `computedReputation`, `trial`). `DiscoveryQuery.includeInactive` existe |
| `src/services/registry.ts` (`:246-262`) | Cómo se resuelve `query.registry` | `getWithSecrets(id)` — **toma el ID, no el nombre** |
| `src/services/discovery.test.ts` (`:20-28`, `:43-47`) | Exemplar de testigo que NO mockea el service | Doble a nivel `fetch` + `undici`, con `registryService` mockeado |
| `src/routes/discover.test.ts` (`:25-30`) | **La razón medida de que el bug sobreviviera** | `getAgent: vi.fn().mockResolvedValue(null)` ⇒ `mapAgent` nunca corre bajo test en esa ruta |
| `src/services/agent-price.ts` (`:16-19`, `:49`, `:59-71`, `:83`, `:124-125`) | Consumidor de `getAgent` en el camino del dinero | Llama `getAgent` **hasta 2 veces**; tiene caché TTL en proceso (60 s) |
| `src/services/compose.ts` (`:1713-1714`) | Consumidor de `getAgent` en el camino del dinero | `getAgent(slug, registry)` y si falla `getAgent(slug)` — **dos llamadas por step** |
| `test/cited-lines-guard.citations.ts` (`:87-102`, `:371-377`, `:656-664`, `:726-733`) | Riesgo de romper el guardián de citas | `CORTE_A_PATHS` incluye `src/types/index.ts`; hay **3** anclas declaradas hacia `discovery.ts`: líneas **63, 449, 529** |
| `test/sdd-index-matches-folders.test.ts` (`:241-360`) | La carpeta 230 necesita fila en `_INDEX.md` | Ya la tiene (`grep -c '230-wkh-369' doc/sdd/_INDEX.md` → `1`) `[MEDIDO-F2]` |
| `supabase/migrations/20260401000000_kite_registries.sql` (`:38-70`) | El `agentMapping` del registro `wasiai` | ⚠️ `ON CONFLICT (id) DO NOTHING` — la fila viva puede diferir del seed; se verificó por comportamiento (§3.2), no por lectura del seed |
| `doc/sdd/226/`, `227/`, `228/`, `229/` `auto-blindaje.md` | Aprendizaje histórico obligatorio | §5.3 |

### 3.2 🔴 MI-1 / MI-3 CERRADOS — la forma real de los dos payloads, y por qué la lista funciona

**Detalle** — `GET https://app.wasiai.io/api/v1/agents/agentshop-kyc-validator` → 200
`[MEDIDO-F2]`. Claves de la raíz (28), sin sobre:

```
agent_type, category, chain, chain_id, cover_image, created_at, creator, currency,
description, error_rate_7d, error_rate_sample_size, estimated_total_cost, example_input,
input_schema, invoke_url, is_featured, mcp, name, output_schema, p50_latency_ms,
p95_latency_ms, payment, performance_score, price_per_call, reputation, sandbox_enabled,
slug, stats
```

- ⛔ **NO** existen `tags`, `capabilities`, `skills`, `labels` ni `keywords`.
- `category = "compliance"` — **1 de las 4** capacidades reales.
- `price_per_call = 0.001` — **sin** el sufijo `_usdc`.
- `reputation = {"score": null, "count": 0}` — un **objeto**, no un número.
- **NO** hay `erc8004`. **NO** hay `id`, `verified` ni `status`.
- Idéntico en forma para `wasi-chainlink-price` (`category: "defi"`, `reputation: {score:0,count:1}`).

**Lista** — el cuerpo que **el gateway consume** sí trae `tags`. Se demuestra **sin
autenticarse**, por el propio contrato del mapper: `mapAgent` guarda el crudo entero en
`metadata` (`discovery.ts:1378`, `metadata: raw`). Y en la salida viva de
`GET /discover?limit=100` del gateway `[MEDIDO-F2]`:

```
metadata de agentshop-kyc-validator = { category, description, erc8004, input_schema,
  invoke_url, name, output_schema, payment, price_per_call_usdc, slug, tags }
metadata.tags = ["remittance","remit","kyc","compliance"]
```

⇒ El `raw` que recibió `mapAgent` en el camino de lista **es la fila nativa del catálogo de
v2, con `tags`, `price_per_call_usdc` y `erc8004`**. El `agentMapping` sembrado **acierta**.

**⇒ Consecuencia #2 del encargo, RESUELTA y en sentido contrario al que se planteaba:**
**no existe ningún fallback al nombre canónico para `capabilities`.** La línea es

```
src/services/discovery.ts:1360-1362
      capabilities: toArray(
        getNestedValue(raw, mapping.capabilities ?? 'capabilities'),
      ),
```

y el `??` protege a **la ruta declarada** de ser `undefined`, **no al valor resuelto** de
estar ausente. Con `mapping.capabilities = 'tags'` se lee `raw.tags` y nada más. La lista
funciona porque **el dato está donde el mapeo dice**, no por una red de seguridad.

**El único fallback al nombre canónico que existe en este archivo es el de precio**, y está
acotado a un campo por diseño `[MEDIDO-F2]`:

```
src/services/discovery.ts:1500   const V2_PRICE_FALLBACK_FIELD = 'price_per_call' as const;
src/services/discovery.ts:1512-1544   function resolvePriceWithFallback(raw, canonicalPath, slug)
      canonical = getNestedValue(raw, 'price_per_call_usdc')  → ausente en el detalle
      fallback  = getNestedValue(raw, 'price_per_call')        → 0.001 ✅
```

**Y ése es, medido, el único motivo por el que `priceUsdc` no diverge** (§3.3). Es una red
de seguridad que se puso para otra cosa (WKH-57, drift de esquema de v2) y que tapa este
defecto en un campo de tres. Que tape uno y no los otros dos es exactamente lo que hace
que el defecto se vea como «falla sólo `capabilities`».

**MI-3 cerrado** `[MEDIDO-F2]`: los 14 federados con lista vacía tienen
`metadata.tags = []` — la clave **está presente y es un array vacío**. Están vacíos
upstream de verdad. **No hay un segundo defecto**, y este dato es load-bearing para AC-7
(§4.6).

### 3.3 🔴 MI-2 / AC-6 CERRADOS — qué midieron `priceUsdc` y `reputation`

Barrido `[MEDIDO-F2]` de los **29** agentes, comparando `GET /discover?limit=100` contra
`GET /discover/<slug>` en el gateway de producción, campo por campo:

| Campo | Path declarado | Divergencias | Por qué |
|---|---|---|---|
| `capabilities` | `tags` | **10 / 29** | El detalle no publica capacidades bajo ningún nombre |
| `priceUsdc` | `price_per_call_usdc` | **0 / 29** | ⚠️ **Salvado por accidente** por `resolvePriceWithFallback` (`discovery.ts:1512-1544`): el detalle trae `price_per_call`, que es literalmente `V2_PRICE_FALLBACK_FIELD` |
| `reputation` | `erc8004.reputation_score` | **2 / 29** | El detalle no trae `erc8004`. `wasi-chainlink-price`: lista `0` → detalle `null`. `wasi-defi-sentiment`: lista `1` → detalle `null` |
| `computedReputation` | *(no es de `agentMapping`)* | **9 / 29** | 🆕 **Cuarta divergencia, que no está ni en el issue ni en el work-item.** Presente en 9 agentes de la lista, en **0** del detalle |

Tres cosas que hay que leer de esa tabla y no diluir:

1. **`priceUsdc` NO está sano: está tapado.** La predicción falsable del F1 acertó en el
   mecanismo y erró en el resultado, y erró **hacia el lado peligroso**: un observador que
   sólo mire el valor concluye "no diverge" y cierra AC-6. Si alguien borrara
   `V2_PRICE_FALLBACK_FIELD` mañana —una limpieza razonable, porque su motivo original
   (WKH-57) es otro— el precio del detalle pasaría a `0` en silencio, **sobre un campo del
   camino del dinero**. Por eso AC-6 se cierra con un **test que mata el fallback y exige
   rojo**, no con la observación de que hoy coinciden.
2. **`reputation` diverge de verdad**, en 2 de 29. Y los otros 27 «coinciden» en
   `null` que **no es un `null`**: es `Number(undefined)` = `NaN` (`discovery.ts:1364-1366`),
   serializado como `null` por `JSON.stringify`. Los dos lados están rotos igual, así que
   la comparación no lo ve. Es el mismo patrón de «coincide en vacío» del AC-3, un campo
   más allá. ⛔ **Arreglar el `NaN` está FUERA de scope** y el motivo es AC-7: hacerlo
   `undefined` OMITIRÍA la clave y cambiaría los bytes de la lista para 27 agentes. Va a
   `TD-369-1` (§11).
3. **`computedReputation` es una divergencia nueva**, y **también fuera de scope**: no es
   un campo de `agentMapping` (AC-6 no la alcanza) y se resuelve en el route
   (`agent-card.ts:88-99`), no en el mapper. Se declara para que no se descubra otra vez
   como si fuera nueva: `TD-369-2` (§11).

### 3.4 MI-4 CERRADO — censo completo de consumidores de `getAgent`

`/usr/bin/grep -rn 'getAgent\b' --include=*.ts src/` `[MEDIDO-F2]`. Call-sites reales
(excluyendo comentarios y la definición):

| Consumidor | Línea | ¿Camino del dinero? |
|---|---|---|
| `src/routes/discover.ts` | `:337` | No — GET gratis |
| `src/routes/agent-card.ts` | `:43` | No — GET gratis |
| `src/services/compose.ts` | `:1713`, `:1714` | 🔴 **SÍ** — dos llamadas por step |
| `src/services/agent-price.ts` | `:59`, `:71`, `:124`, `:125` | 🔴 **SÍ** — cotización de step-0 y per-step |

⇒ **La cota inferior del F1 (2) era la mitad: son 4 archivos y 8 call-sites, y 2 de los 4
están en el camino del dinero.** Este censo es lo que decide DT-4 (§4.1): cualquier arreglo
dentro de `getAgent` le agrega I/O a `/compose`, que es exactamente lo que CD-3 prohíbe.

### 3.5 MI-6 CERRADO — línea base del gate, corrido COMPLETO y EN ORDEN

`[MEDIDO-F2]`, 2026-08-27, sobre `main` en `9ba550a`, en la secuencia de
`.github/workflows/ci.yml`:

| # | Comando | Resultado |
|---|---|---|
| 1 | `npx tsc -p tsconfig.json --noEmit` | ✅ `TypeScript compilation completed`, exit 0 |
| 2 | `npm run lint` (`biome check src/`) | ✅ `Checked 516 files in 249ms. No fixes applied.` |
| 3 | `npm test` (`vitest run`) | ✅ **Test Files 310 passed \| 6 skipped (316)** · **Tests 6290 passed \| 19 skipped (6309)** · Duration 15.77 s |

⚠️ Dos avisos de la corrida, ninguno bloqueante y los dos **preexistentes**: un
`Failed to load source map for typescript.js` de vite, y las líneas `DOWN:`/`CONFIG:`/`PASS:`
de la sonda del money-path (WKH-364), que son salida esperada de sus tests.

⚠️ **`npm run lint` es `biome check src/`: NO lintea `test/`.** Lo dice el auto-blindaje de
la HU 229. Consecuencia de diseño: **todos los tests de esta HU viven en `src/`**, para que
sí los mire el linter (§7).

### 3.6 Exemplars verificados

Todos existen en el árbol y los rangos están confirmados con `sed`/`/usr/bin/grep`
`[MEDIDO-F2]`.

| Para escribir | Seguir el patrón de | Qué se copia |
|---|---|---|
| El resolver nuevo, y **dónde** ponerlo | `src/routes/agent-card.ts:88-99` | Enriquecimiento resuelto **en el route, NO en `getAgent`**, con el motivo escrito en `:91`. Es el precedente exacto de esta decisión |
| El campo nuevo del contrato | `src/types/index.ts:445-457` (`identity`, `computedReputation`, `trial`) | «Omitido, **no** `null`», con el motivo de backward-compat en el docblock |
| El guard de self-published | `src/routes/agent-card.ts:52-56` | `if (agent.registry_id === SELF_PUBLISHED_REGISTRY_ID)` (`src/types/index.ts:305`) |
| El testigo que ejercita `mapAgent` de verdad | `src/services/discovery.test.ts:20-28` + `:43-47` | Mock de `registryService` + doble de `fetch` **y** de `undici.fetch` a la vez. **Nunca** mock de `discoveryService` |
| Un fallback documentado por campo | `src/services/discovery.ts:1500`, `:1512-1544` | Constante con nombre + docblock que dice qué gana y por qué |
| Caché TTL en proceso, **si hiciera falta** | `src/services/agent-price.ts:16-19`, `:83` | ⛔ **NO se usa en esta HU** (§4.5): la medición de latencia lo hace innecesario |

### 3.7 Estado de BD relevante

| Tabla | Existe | Relevancia |
|---|---|---|
| `registries` | Sí | Fila `wasiai` con `discovery_endpoint`, `agent_endpoint` y `schema.discovery.agentMapping`. **⛔ NO SE TOCA** (CD-5). `bdwv` sirve producción |

Sin migraciones. Sin cambios de esquema. **N/A.**

---

## 4. Diseño técnico

### 4.1 🎯 DT-4 — el mecanismo del arreglo, decidido

> El F1 dejó DT-4 abierto a propósito. El encargo puso tres salidas sobre la mesa. Elijo
> **(a)**, y la elección **no es de gusto: está forzada por un AC ya aprobado**.

**AC-1 dice `SHALL devolver un capabilities igual al que GET /discover publica`.** Eso es
literalmente (a). (b) no lo satisface: deja al detalle sin servir para decidir por
capacidad, que es para lo que existe la vista. Y AC-2 no es una alternativa a AC-1, es su
red: gobierna el caso en que (a) **no puede** resolver.

⇒ **DT-4 = (a) enriquecer desde la lista, con (b) como piso obligatorio cuando (a) falla.**

#### Trade-off escrito de las tres

| | Qué da | Qué cuesta | Veredicto |
|---|---|---|---|
| **(a) Enriquecer desde la lista** | El dato correcto, que es el que AC-1 exige. Además arregla `reputation` (2 divergencias) y `skills` del Agent Card **sin código extra** | **+1 llamada upstream** en el camino de detalle. Medido: **~220 ms** (§4.5), no una caché | ✅ **ELEGIDA** |
| **(b) Declarar no resuelto** | Honesto y barato. Cambia el contrato de la respuesta | **No satisface AC-1.** El detalle sigue sin servir para decidir por capacidad | ⚙️ **Se implementa igual, como piso de AC-2** — no como alternativa |
| **(c) Derivar de `category`** | Nada que se pueda usar | `category` es **1 de 4** (`"compliance"` de `["remittance","remit","kyc","compliance"]`) `[MEDIDO-F2]` | ⛔ **RECHAZADA** |

#### ⛔ Por qué (c) queda escrita como rechazada, para que no vuelva

`category` produciría `capabilities: ["compliance"]`: un valor **plausible, con la forma
correcta, y falso**. Es peor que el `[]` de hoy por tres razones, y la tercera es la que
importa:

1. **Pierde el 75 % del dato** y no hay forma de saberlo mirando la respuesta.
2. **Rompe la resolución por capacidad.** Un caller que busque `remit` dejaría de encontrar
   al agente en el detalle mientras lo encuentra en la lista: la divergencia sigue viva,
   disfrazada de dato.
3. **Es exactamente el modo de falla que esta HU existe para matar.** El defecto original
   es «un residuo de haber leído en el lugar equivocado, presentado con la misma cara que
   una afirmación». (c) fabrica un segundo residuo con mejor cara. Un `[]` al menos se ve
   raro; un `["compliance"]` pasa todas las revisiones.

⚠️ Además (c) es **atractiva** porque es la única de las tres que no cuesta I/O. Ésa es
precisamente la razón por la que vuelve. Queda prohibida en **CD-9**.

### 4.2 Dónde vive el arreglo: en el ROUTE, NO en `getAgent`

Ésta es la segunda mitad de DT-4 y la que protege el dinero.

`getAgent` tiene **8 call-sites en 4 archivos**, y **4 de esos call-sites están en
`compose.ts` y `agent-price.ts`** (§3.4). Meter un fetch de catálogo adentro de `getAgent`
le agregaría **hasta 2 llamadas upstream por step de `/compose`**. Eso es cambiar el
comportamiento y el perfil de fallo del camino del dinero a cuatro días de Demo Day, que es
lo que **CD-3 prohíbe**.

⇒ **El enriquecimiento se hace en los dos routes gratis y de sólo lectura**
(`routes/discover.ts:337`, `routes/agent-card.ts:43`), a través de **un único helper
compartido** para que no puedan divergir entre sí.

**Esto no es una invención: es el patrón que este repo ya eligió para el mismo problema.**
`src/routes/agent-card.ts:88-99` computa `computedReputation` en el route, y `:91` deja el
motivo por escrito: *«Se computa en el ROUTE (NO en getAgent) para una sola fuente»*.

**Consecuencia arquitectónica que vale más que el arreglo:**

> ⛔ **`src/services/discovery.ts` NO SE TOCA. Cero líneas.**

De ahí salen cuatro garantías **por construcción**, no por testeo:

| Garantía | Por qué es automática |
|---|---|
| **CD-4** (no cambiar `mapAgent` para la lista) | No se edita `mapAgent` |
| **AC-7** (lista y `/compose` byte-idénticos) | `discover()` y `getAgent()` quedan literalmente iguales |
| **CD-3** (no tocar el camino del dinero) | `compose.ts` y `agent-price.ts` siguen llamando al mismo `getAgent` |
| Guardián de citas | Las 3 anclas hacia `discovery.ts` (líneas **63, 449, 529**, `test/cited-lines-guard.citations.ts:371-377`, `:656-664`, `:726-733`) no se pueden mover si el archivo no se edita |

### 4.3 El algoritmo

```
resolveAgentForDetailView(slug, registryId?) -> Agent | null

  1. agent = discoveryService.getAgent(slug, registryId)      // SIN CAMBIOS
     si es null -> null (404, como hoy)

  2. si agent.registry_id === SELF_PUBLISHED_REGISTRY_ID -> devolver agent tal cual
     (medido: 0 divergencias en los 5 self-published; no hay nada que resolver
      y no se paga I/O por nada)

  3. listado = discoveryService.discover({
       registry: agent.registry_id,     // 🔴 el ID, NUNCA el nombre — ver CD-10
       includeInactive: true,           // el detalle sirve agentes inactivos; la lista
     })                                 // los filtra por default (discovery.ts:447-449)

  4. entrada = listado.agents.find(a => a.slug === agent.slug)

  5a. si HAY entrada:
        agent.capabilities = entrada.capabilities
        agent.reputation   = entrada.reputation      // cierra las 2 divergencias de AC-6
        (NO se toca metadata, ni payment, ni priceUsdc, ni identity — ver §4.4)

  5b. si NO hay entrada (upstream caído, catálogo truncado, slug fuera de página,
      registro deshabilitado, o discover() lanzó):
        agent.capabilitiesState = 'unresolved'        // AC-2
        agent.capabilities queda como estaba ([])
```

**El paso 5b es AC-2, y es lo que hace que `[]` deje de ser ambiguo:**

| Salida | Significado, ahora sin ambigüedad |
|---|---|
| `capabilities: ["a","b"]` | El agente declara esas capacidades |
| `capabilities: []`, **sin** `capabilitiesState` | El agente declara que **no tiene** capacidades |
| `capabilities: []`, **con** `capabilitiesState: 'unresolved'` | El gateway **no pudo leerlas**. No es una afirmación sobre el agente |

Es el precedente de WKH-318 (`rows: null` ≠ `rows: 0`) aplicado a este campo, sin inventar
una segunda doctrina.

**DT-6 (cierra MI-5): el marcador es ADITIVO y `capabilities` sigue siendo `string[]`.**
No se usa `capabilities: null`. Motivo medido: `src/services/agent-card.ts:124` hace
`agent.capabilities.map(...)` sin guard, y un `null` ahí es un `TypeError` en el Agent Card.
Un campo opcional omitido es además el patrón que el propio `Agent` ya usa tres veces
(`src/types/index.ts:445-457`) y el que **no rompe** a ningún consumidor que valide forma
exacta. **No hace falta escalar al founder**: el cambio es aditivo y no rompe el contrato.

### 4.4 Qué NO se enriquece, y por qué

| Campo | Decisión | Motivo |
|---|---|---|
| `metadata` | ⛔ **NO se toca** | En el detalle es el cuerpo crudo del endpoint de detalle (`discovery.ts:1378`). Es la superficie por la que las sondas de WKH-364 leen el esquema. Pisarla con la de la lista cambiaría de qué fuente derivan su input. **Cambiar eso es otra HU** |
| `priceUsdc` | ⛔ **NO se toca** | 0 divergencias medidas. Se le pone un **test** que fija que el fallback es lo que lo sostiene (§7, T-06b) |
| `payment`, `identity`, `invokeUrl` | ⛔ **NO se tocan** | `payment` lo lee el camino del dinero (`payment-spec-reader`); `identity` la resuelve `getAgent` con su propio match bidireccional |
| `computedReputation` | ⛔ **NO se toca** | `TD-369-2`. No es campo de `agentMapping`; AC-6 no lo alcanza |
| `reputation` **`NaN`** en los 27 restantes | ⛔ **NO se toca** | `TD-369-1`. Arreglarlo cambia los bytes de la lista ⇒ violaría AC-7 |

### 4.5 El costo, medido

`[MEDIDO-F2]`, 3 corridas contra producción, en estado caliente:

| Llamada | t (s) |
|---|---|
| `GET /discover/<slug>` (hoy) | 0.402 · 0.300 · 0.313 |
| `GET /discover?limit=100&registry=wasiai` (lo que agrega el paso 3) | 0.262 · 0.220 · 0.220 |
| `GET /discover?limit=100` (todos los registries — **lo que NO se hace**) | 0.735 · 0.450 · 0.417 |

Distribución del detalle sobre los 29 slugs: **min 108 ms · p50 293 ms · p95 538 ms · max 1269 ms**.

⇒ **Delta esperado: ~+220 ms, de ~300 ms a ~520 ms en p50.** Un factor de ~1.7x sobre una
ruta gratis y de sólo lectura.

**⇒ Por eso NO se agrega caché en esta HU.** Un módulo de caché de catálogo (aunque el
exemplar exista en `agent-price.ts:16-19`) sería más código que el arreglo, con su propia
invalidación y su propia clase de bug de staleness — para ahorrar 220 ms en una ruta
gratis. Es la respuesta a la pregunta del presupuesto (§8): **nada de eso sobreviviría si
lo escribiera alguien que ya conoce este código.** Si algún día importa, `TD-369-3`.

⚠️ Acotar el `discover()` al registry del agente **no es sólo performance**: evita
re-consultar registries ajenos y evita mezclar el merge de self-published. Cuesta 220 ms en
vez de ~500.

### 4.6 🔴 Por qué AC-7 se cumple, y la medición que lo sostiene

`src/services/discovery.ts` no se edita ⇒ `/discover`, `POST /discover` y el
capability-resolver de `/compose` corren **el mismo código**. Eso ya alcanza.

Pero hay una pregunta que parece que lo rompe y hay que contestarla con un número: **¿el
campo nuevo `capabilitiesState` puede aparecer en la salida de la LISTA y cambiarle los
bytes?**

**No, y está medido.** `capabilitiesState` sólo lo escribe el resolver nuevo, que sólo
corre en los dos routes de detalle. `discover()` no lo escribe nunca. Y aunque alguien lo
llevara al mapper en el futuro, hoy **no habría a quién marcárselo**: `[MEDIDO-F2]`, en los
29 agentes de la lista viva, la clave `tags` del crudo está **presente en los 24 federados**
(10 con contenido, **14 como array vacío**) y ausente sólo en los 5 self-published, que ni
pasan por `mapAgent`. Cero agentes en estado «no resuelto» en la lista hoy.

⚠️ **Aun así, AC-7 se demuestra EJECUTANDO, no leyendo** (CD-4 y el encargo son explícitos).
El método está en §7, T-07.

### 4.7 Archivos a crear/modificar, y la escala esperada por archivo

| # | Archivo | Acción | Qué hace | Líneas (código, sin prosa) | Exemplar |
|---|---|---|---|---|---|
| 1 | `src/types/index.ts` | Modificar | `capabilitiesState?: 'unresolved'` en `Agent`, **omitido** cuando resuelve | **+4** (+ ~10 de docblock) | `:445-457` |
| 2 | `src/services/agent-detail.ts` | **Crear** | El resolver de §4.3 | **~45** (+ ~35 de docblock) | `routes/agent-card.ts:88-99` |
| 3 | `src/routes/discover.ts` | Modificar | `getAgent(...)` → `resolveAgentForDetailView(...)` en `:337` | **+2 / -1** | — |
| 4 | `src/routes/agent-card.ts` | Modificar | Ídem en `:43` | **+2 / -1** | — |
| 5 | `src/services/agent-detail.test.ts` | **Crear** | AC-1, AC-2, AC-3, AC-4, AC-6 | ~230 (test) | `discovery.test.ts:20-28`, `:43-47` |
| 6 | `src/routes/discover.detail-capabilities.test.ts` | **Crear** | AC-1 y AC-5 en el borde HTTP, sin mockear `discoveryService` | ~170 (test) | ídem |
| 7 | `doc/sdd/230-…/story-file.md`, `auto-blindaje.md`, `cr-report.md`, `qa-report.md` | Crear | Artefactos del pipeline | prosa | — |
| 8 | `doc/sdd/_INDEX.md` | Modificar | Actualizar la fila 230 al cerrar | +1 fila | — |

⛔ **`src/services/discovery.ts` NO figura en esta tabla, y eso es intencional (§4.2).**
⛔ **`src/services/agent-card.ts` tampoco**: AC-5 se satisface sin editarlo, porque `:124`
ya deriva las `skills` de `agent.capabilities`. Se **verifica** con T-05; no se toca.

### 4.8 Flujo principal (happy path)

1. Caller: `GET /discover/agentshop-kyc-validator`.
2. `resolveAgentForDetailView` llama a `getAgent` → agente federado con `capabilities: []`.
3. No es self-published ⇒ `discover({ registry: 'wasiai', includeInactive: true })`.
4. Encuentra la entrada del slug con `capabilities: ["remittance","remit","kyc","compliance"]`.
5. Respuesta: esas 4 capacidades, **sin** `capabilitiesState`. `metadata` sigue siendo el
   cuerpo del endpoint de detalle.
6. `GET /agents/agentshop-kyc-validator/agent-card` devuelve **4 `skills`** en vez de `[]`.

### 4.9 Flujo de error

| Qué falla | Qué pasa |
|---|---|
| `getAgent` devuelve `null` | **404 `Agent not found`**, igual que hoy. Sin cambios |
| `discover()` lanza (red, SSRF, breaker abierto) | Se atrapa; `capabilitiesState: 'unresolved'`; **200**. ⛔ Nunca un 5xx: es un enriquecimiento aditivo (patrón `agent-card.ts:95-98`) |
| El slug no está en el listado | `capabilitiesState: 'unresolved'` |
| El catálogo vino truncado y el slug quedó fuera de página | Cae en el caso anterior ⇒ `'unresolved'`. **Correcto**: no se puede afirmar `[]` |
| Agente self-published | Se saltea el paso 3. Cero I/O nuevo |

---

## 5. Constraint Directives

### 5.1 Heredadas del work-item (**vigentes sin cambios**)

- **CD-1** — 🔴 **PROHIBIDO un fixture de paridad con capacidades vacías.** El agente
  federado del fixture tiene **≥ 2 capacidades no vacías** en la vista de lista **y** un
  payload de detalle con la forma divergente medida en §3.2. Un fixture vacío **pasa con el
  bug puesto**. ⚙️ **En esta HU la CD deja de ser prosa**: T-03 asserta
  `coincideConContenido >= 1`, así que un fixture vacío **no puede** poner el test en verde.
- **CD-2** — **OBLIGATORIO romper a propósito cada test nuevo antes de darlo por bueno.**
  El rojo se cita con `archivo:línea` mutado y la salida. §7 fija la mutación de cada test.
- **CD-3** — **PROHIBIDO tocar el camino del dinero.** ⚙️ Satisfecha por construcción (§4.2).
- **CD-4** — **PROHIBIDO cambiar el comportamiento observable de `mapAgent` para la LISTA.**
  ⚙️ Satisfecha por construcción, **y aun así se demuestra ejecutando** (T-07).
- **CD-5** — **PROHIBIDO «arreglar» esto editando datos.** Ni la fila `registries` de
  `bdwv`, ni republicar el catálogo.
- **CD-6** — **Ningún guard puede leerse a sí mismo.** El valor esperado del test de
  paridad se escribe **a mano** en el fixture; **PROHIBIDO** derivarlo llamando al mismo
  código que se vigila.
- **CD-7** — **PROHIBIDO validar esta HU con un test que mockee `discoveryService`.** Es la
  razón medida de que el bug sobreviviera (`src/routes/discover.test.ts:25-30`). El testigo
  dobla `fetch` **y** `undici.fetch` (`discovery.test.ts:43-47`).
- **CD-8** — **El gate se corre COMPLETO y EN ORDEN, una vez.** ⛔ `npm run qa` **no existe**.
  Es `npx tsc -p tsconfig.json --noEmit` → `npm run lint` → `npm test`.

### 5.2 Nuevas de este SDD

- **CD-9** — ⛔ **PROHIBIDO derivar capacidades de `category`, `agent_type`, `chain`,
  `creator` o de cualquier heurística sobre el payload de detalle.** Motivo en §4.1:
  produce un dato plausible y falso, que es peor que el vacío. Si el listado no resuelve,
  la salida es `'unresolved'`, nunca una aproximación.

- **CD-10** — 🔴 **`discover({ registry })` toma el `registry.id`, NUNCA el
  `Agent.registry` (nombre de display).** `[MEDIDO-F2]` contra producción:

  | Petición | Resultado |
  |---|---|
  | `GET /discover?limit=100&registry=WasiAI` (nombre) | `agents: 0`, `total: 0`, `sources: []`, **`catalogStatus: "complete"`** |
  | `GET /discover?limit=100&registry=wasiai` (id) | `agents: 24`, `total: 24`, `sources: [{name:"WasiAI",state:"ok",rows:24}]` |

  Confundirlos **no da error**: da un catálogo vacío que se anuncia como **completo**. Todo
  el enriquecimiento devolvería `'unresolved'` para siempre, con la ruta en 200 y el gate en
  verde. Es **el mismo modo de falla que esta HU existe para matar**, un nivel más arriba.
  ⚠️ Y la trampa está armada: `src/routes/agent-card.ts:66` usa la convención **contraria**
  (`registries.find(r => r.name === agent.registry)`, con un comentario que dice *«CD-9:
  Agent.registry = name, NOT id»*) **a 20 líneas del punto de inserción**. Usar
  `agent.registry_id` (`src/types/index.ts:436`). **Tiene su propio test: T-10.**

- **CD-11** — ⛔ **PROHIBIDO editar `src/services/discovery.ts` en esta HU.** Si el arreglo
  parece necesitarlo, está mal planteado: parar y escalar. (Protege CD-3, CD-4, AC-7 y las
  3 anclas del guardián de citas en las líneas 63/449/529.)

- **CD-12** — ⛔ **PROHIBIDO escribir un token `:<dígito>` en cualquier comentario que se
  agregue a `src/types/index.ts`.** Ese archivo es uno de los `CORTE_A_PATHS`
  (`test/cited-lines-guard.citations.ts:87-102`): **toda** cita ahí —incluso un `:N`
  suelto— debe estar declarada a mano en un archivo que **no está en el Scope IN**. Es un
  rojo del gate y obligaría a tocar un archivo fuera de scope. **Precedente medido:
  auto-blindaje de la HU 228, Wave 0.** Verificación:
  `sed -n '<rango nuevo>p' src/types/index.ts | /usr/bin/grep -E ':[0-9]'` → sin resultados.

- **CD-13** — **Todos los archivos de test de esta HU van en `src/`, nunca en `test/`.**
  `npm run lint` es `biome check src/` y **no mira `test/`**; un test ahí no se lintea y el
  error de formato pasa invisible. **Precedente: auto-blindaje de la HU 229, W0.**

- **CD-14** — **Correr `npx biome check --write` sobre cada archivo nuevo antes de cantar
  verde**, y re-correr el gate **desde el paso 1**, no desde donde falló. `tsc` + `vitest`
  son ciegos al formato y `lint` va **segundo**. **Precedente en DOS HUs consecutivas: 226
  (Wave 1) y 229 (W0).** Es el error recurrente #1 de este repo.

- **CD-15** — **`[]` nunca se publica como afirmación sin haber comprobado la resolución.**
  Corolario de AC-2 escrito como prohibición, para que ningún camino nuevo lo reintroduzca.

- **CD-16** — **PROHIBIDO tocar `metadata` en el camino de detalle** (§4.4). Es la fuente de
  la que WKH-364 deriva el input de sus sondas; cambiarla es otra HU.

### 5.3 De dónde salen CD-12, CD-13 y CD-14: el Auto-Blindaje histórico

Leídos `[MEDIDO-F2]`: `doc/sdd/226-…/auto-blindaje.md`, `227-…`, `228-…`, `229-…`.

| Patrón | HUs | ⇒ CD |
|---|---|---|
| **`lint` (biome) rojo por formato en archivos nuevos**, después de que `tsc` y `vitest` pasaran | **226** (Wave 1) y **229** (W0) — **recurrente** | **CD-14** |
| **Guardián de citas rojo** por una cita nueva o por una línea desplazada | **226** (Wave 1, `E-LINE_MOVED`) y **228** (Wave 0, `CORTE_A_PATHS`) — **recurrente** | **CD-11**, **CD-12** |
| Un número copiado de un artefacto envejece solo | **228** (Wave 0) | Todos los números de §3.3 y §3.5 llevan fecha y comando |
| Herramientas del entorno que **afirman** lo que uno espera oír (`diff`, `cat`, `grep`, `git diff/log`) | **229** (W1) | §12 |
| Un guardián que se denuncia a sí mismo por su propia prosa | **227** (Wave 1) | **CD-6**, y §7 nota de T-03 |

---

## 6. Scope

**IN**

- `src/types/index.ts` — campo aditivo `capabilitiesState`.
- `src/services/agent-detail.ts` — **nuevo**, el resolver.
- `src/routes/discover.ts:337` y `src/routes/agent-card.ts:43` — un call-site cada uno.
- `src/services/agent-detail.test.ts` y `src/routes/discover.detail-capabilities.test.ts` — nuevos.
- `doc/sdd/230-…/` y la fila 230 de `doc/sdd/_INDEX.md`.

**OUT**

- ⛔ **El camino del dinero**: `src/lib/downstream-payment.ts`, `src/adapters/**`,
  `src/middleware/x402.ts`, `fee-*`, settle, escrow. **Demo Day es el lunes 31.**
- ⛔ **El pin de seguridad del KYC.**
- ⛔ **`src/services/discovery.ts`** (CD-11) y **`src/services/agent-card.ts`** (no hace falta).
- ⛔ **Republicar filas del catálogo** o editar `registries` en `bdwv` (CD-5).
- ⛔ El `NaN` de `reputation` (`TD-369-1`) y la ausencia de `computedReputation` en el
  detalle (`TD-369-2`): medidos, declarados, **no arreglados acá** — arreglarlos rompería AC-7
  o excede AC-6.
- ⛔ Caché de catálogo (`TD-369-3`): §4.5.
- ⛔ Generalizar un `agentPath` / mapeo propio de detalle como feature de contrato público
  para terceros. Y además, medido: **no resolvería nada** (§3.2).

---

## 7. Plan de tests — al menos uno por AC

⚠️ **Regla que gobierna toda esta sección (CD-2): cada test se rompe a propósito antes de
darlo por bueno.** La columna «Mutación» dice **exactamente** qué romper. Un guard cuyo rojo
nadie vio no está entregado.

### 7.1 El fixture — donde vive CD-1

Un fixture a mano en `src/services/agent-detail.test.ts`, con **la forma medida en §3.2**,
nunca inventada:

| Agente | Payload de LISTA (`raw`) | Payload de DETALLE (`raw`) | Rol |
|---|---|---|---|
| `fed-con-caps` | `tags: ["remittance","remit","kyc","compliance"]`, `price_per_call_usdc: 0.001`, `erc8004: { reputation_score: 7 }` | `category: "compliance"`, `price_per_call: 0.001`, `reputation: { score: null, count: 0 }`, **sin `tags`** | 🔴 **El que hace no vacuo al guard** (CD-1) |
| `fed-sin-caps` | `tags: []` | mismo, sin `tags` | `coincide-en-vacío`: prueba que el arreglo **no inventa** |
| `fed-fuera-del-listado` | *(no está en la lista)* | igual que el primero | Dispara AC-2 |
| `self-agent` | self-published, `capabilities: ["weather","geo"]` | — | Prueba que se saltea el paso 3 |

⛔ **CD-6**: los valores esperados se escriben **literales**. Prohibido derivarlos llamando a
`mapAgent`, a `discover()` ni al resolver.

### 7.2 Los tests

| ID | AC | Archivo | Qué afirma | **Mutación que DEBE ponerlo rojo (CD-2)** |
|---|---|---|---|---|
| **T-01** | AC-1 | `agent-detail.test.ts` | `fed-con-caps` en detalle devuelve las **4** capacidades de la lista | Volver el paso 5a un no-op |
| **T-02a** | AC-2 | `agent-detail.test.ts` | `fed-fuera-del-listado` → `capabilitiesState === 'unresolved'` **y** `capabilities` sigue siendo `[]` | Borrar la asignación de `capabilitiesState` |
| **T-02b** | AC-2 | `agent-detail.test.ts` | `fed-sin-caps` → `capabilities: []` **y `capabilitiesState` AUSENTE** (`'capabilitiesState' in agent === false`) | Marcar `'unresolved'` siempre que `capabilities.length === 0` |
| **T-02c** | AC-2 | `agent-detail.test.ts` | Si `discover()` **rechaza**, se devuelve 200 con `'unresolved'`, no un throw | Sacar el `try/catch` |
| **T-03** | AC-3, AC-4, **CD-1** | `agent-detail.test.ts` | Partición de **tres** estados sobre el fixture completo: `{difiere: 0, coincideConContenido: ≥1, coincideEnVacio: ≥1}`. **`coincideConContenido >= 1` es la aserción que hace imposible pasar con fixture vacío** | Restaurar el defecto: que el paso 5a lea del payload de detalle. Debe dar `difiere: 1` |
| **T-04** | AC-4 | `agent-detail.test.ts` | La tasa se calcula sobre `difiere + coincideConContenido`, **no** sobre el total. Con el fixture: `1/2 = 50 %`, y **no** `1/4 = 25 %` | Cambiar el denominador al total |
| **T-05** | AC-5 | `discover.detail-capabilities.test.ts` | `GET /agents/fed-con-caps/agent-card` → `skills.length === 4` con los 4 ids correctos | La misma de T-01 |
| **T-06a** | AC-6 | `agent-detail.test.ts` | `reputation` del detalle == el de la lista (`7`), no `NaN` | Sacar la asignación de `reputation` del paso 5a |
| **T-06b** | AC-6 | `agent-detail.test.ts` | 🔴 **`priceUsdc` coincide (`0.001`) Y el motivo es el fallback**: con un payload de detalle **sin** `price_per_call`, `priceUsdc` cae a `0` y **diverge** | *(no aplica: el test ya es la mutación)*. Fija que el `0 / 29` medido depende de `V2_PRICE_FALLBACK_FIELD` (`discovery.ts:1500`) y no de que el detalle esté sano |
| **T-07** | **AC-7** | `discover.detail-capabilities.test.ts` | 🔴 **Paridad EJECUTADA del camino de lista**: se corre `discover()` con el mismo fixture **antes y después** del cambio y se compara `JSON.stringify` **byte a byte**. La línea base se guarda como snapshot literal escrito a mano | Escribir `capabilitiesState` también en `mapAgent`: la comparación debe romper |
| **T-08** | AC-1, AC-5 | `discover.detail-capabilities.test.ts` | El borde HTTP: `GET /discover/fed-con-caps` → 200 con 4 capacidades, **sin mockear `discoveryService`** (CD-7) | Volver el route a `getAgent` pelado |
| **T-09** | — | `agent-detail.test.ts` | `self-agent` no dispara ningún fetch de catálogo (`mockFetch` no se llama de más) | Sacar el guard de self-published |
| **T-10** | **CD-10** | `agent-detail.test.ts` | 🔴 El resolver llama a `discover()` con **`registry: 'wasiai'` (el id)**. Se asserta el argumento exacto | Cambiar a `agent.registry` (el nombre) — debe romper. **Sin este test la confusión id/nombre es un verde silencioso** |

**AC-8** no es un test: es el gate del repo, §3.5, corrido completo y en orden.

### 7.3 Cómo se testea sin mockear `discoveryService` (CD-7)

Copiando el exemplar `src/services/discovery.test.ts:20-28` + `:43-47`, verificado:

```
vi.mock('./registry.js', ...)     // registryService: getEnabled / getWithSecrets
vi.mock('../lib/circuit-breaker.js', ...)   // execute: (fn) => fn()
const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.stubGlobal('fetch', mockFetch);
vi.mock('undici', ...)            // la MISMA mockFetch, si no el doble no intercepta
```

`mockFetch` responde según la URL: el `discovery_endpoint` devuelve el sobre
`{ agents: [...] }` con `tags`; el `agent_endpoint` devuelve la forma de detalle **sin**
`tags`. Así `mapAgent` corre **de verdad** en los dos caminos, que es justo lo que
`src/routes/discover.test.ts:25-30` impedía.

---

## 8. 🎯 Presupuesto de escala — lo que el CR va a contrastar (regla 10)

| Concepto | Presupuesto |
|---|---|
| **Código de producción (sin prosa, sin tests)** | **≤ 70 líneas** |
| Docblocks y comentarios | ≤ 60 líneas |
| Tests | ≤ 420 líneas |
| **Total del diff en `src/`** | **≤ 550 líneas** |
| Umbral de justificación por escrito (2x del total) | **1100 líneas** |
| Archivos de producción tocados | **4** (1 nuevo, 3 modificados) |
| Archivos de producción **NO** tocados y que uno esperaría | `src/services/discovery.ts`, `src/services/agent-card.ts` |

**¿Qué parte de esto seguiría existiendo si lo escribiera alguien que ya conoce este código?**

Casi todo, y por eso el presupuesto es chico. Lo que **no** sobreviviría, y por eso está
explícitamente afuera:

- ⛔ Un módulo de caché de catálogo. 220 ms en una ruta gratis no lo pagan (§4.5).
- ⛔ Un `agentPath` configurable en el esquema de registro. Medido: **no hay a qué apuntar**
  (§3.2).
- ⛔ Un segundo `agentMapping` para el endpoint de detalle. Mismo motivo.
- ⛔ Refactorizar `mapAgent`, `toArray` o `getNestedValue`. El mapper **no es el bug** —
  ésa es la hipótesis #1, que ya cayó.
- ⛔ Una abstracción de «estrategia de resolución de campos». El defecto tiene **un** campo.

⚠️ **Señal de alarma para el CR**: si el diff de producción supera ~70 líneas, casi seguro
apareció una de las cinco de arriba. La más probable es la caché.

---

## 9. Missing Inputs — estado

| # | Qué faltaba | Estado |
|---|---|---|
| **MI-1** | Forma real del cuerpo de detalle | ✅ **CERRADO** §3.2. Sin sobre; **ninguna** clave de capacidades |
| **MI-2** | ¿`priceUsdc` y `reputation` divergen? | ✅ **CERRADO** §3.3. `priceUsdc` **0/29** (tapado por el fallback); `reputation` **2/29** |
| **MI-3** | ¿Las 14 filas vacías lo están upstream? | ✅ **CERRADO** §3.2. Sí: `tags: []`, clave presente. **No hay segundo defecto** |
| **MI-4** | Censo de consumidores de `getAgent` | ✅ **CERRADO** §3.4. **4 archivos, 8 call-sites**, 2 archivos en el camino del dinero |
| **MI-5** | ¿Degradar a la lista o declararse parcial? | ✅ **RESUELTO** DT-4 + DT-6: **las dos**, con campo aditivo. No requiere escalar |
| **MI-6** | Línea base del gate | ✅ **CERRADO** §3.5. `310/316` archivos, `6290/6309` tests |

**Ningún Missing Input abierto. Ningún `[NEEDS CLARIFICATION]`.**

---

## 10. Riesgos

| # | Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|---|
| R-1 | 🔴 Confundir `registry_id` con `registry` ⇒ enriquecimiento **siempre** `'unresolved'`, con la ruta en 200 y el gate verde | **Alta** — la convención contraria está a 20 líneas (`agent-card.ts:66`) | **Alto** — la HU parece hecha y no arregló nada | **CD-10** + **T-10**, que asserta el argumento exacto |
| R-2 | El fixture de paridad se escribe vacío y el guard pasa con el bug puesto | Media — es el error del issue | Alto | **CD-1** mecanizada: T-03 exige `coincideConContenido >= 1` |
| R-3 | El Dev «aprovecha» y arregla el `NaN` de `reputation` ⇒ rompe AC-7 | Media — parece una mejora obvia | Alto | `TD-369-1` explícito + T-07 lo pone rojo |
| R-4 | Formato biome en los 3 archivos nuevos | **Alta** — pasó en 226 **y** en 229 | Bajo | **CD-14** |
| R-5 | Guardián de citas rojo por un `:N` en `src/types/index.ts` | Media — pasó en 228 | Medio | **CD-12** con su comando de verificación |
| R-6 | +220 ms en `/discover/<slug>` y en el Agent Card antes del Demo Day | Alta (es el diseño) | Bajo | Medido (§4.5). Rutas gratis y de sólo lectura. `TD-369-3` si molesta |
| R-7 | Conflicto en `discovery.ts` con otra rama caliente (WKH-318, HU-323, WKH-313, WKH-322) | — | — | ⚙️ **Eliminado**: CD-11 no lo edita. Igual, antes de F3: `git merge-base --is-ancestor`, ⛔ **nunca** `git log` bajo el proxy |
| R-8 | El registro federado cambia su payload de lista y deja de traer `tags` | Baja | Medio | Degrada a `'unresolved'`, que es la respuesta correcta. **No** vuelve al `[]` mudo |

---

## 11. Deuda técnica declarada (medida acá, **no** arreglada acá)

| # | Qué | Evidencia | Por qué no ahora |
|---|---|---|---|
| **TD-369-1** | `Agent.reputation` es `NaN` para **27 de 29** agentes en **las dos** vistas. `Number(getNestedValue(...) ?? undefined)` (`discovery.ts:1364-1366`); `JSON.stringify(NaN)` → `null`, así que se ve como un `null` honesto | §3.3 `[MEDIDO-F2]` | Arreglarlo **omite** la clave y cambia los bytes de la lista ⇒ **violaría AC-7** |
| **TD-369-2** | `computedReputation` aparece en 9 agentes de la lista y en **0** del detalle | §3.3 `[MEDIDO-F2]` | No es campo de `agentMapping`; AC-6 no lo alcanza. El Agent Card **sí** lo computa (`agent-card.ts:88-99`), sólo falta en `/discover/<slug>` |
| **TD-369-3** | Sin caché de catálogo: cada detalle paga ~220 ms | §4.5 `[MEDIDO-F2]` | Más código que el arreglo, para una ruta gratis. Exemplar listo si hace falta: `agent-price.ts:16-19` |
| **TD-369-4** | `resolvePriceWithFallback` sostiene, **sin decirlo**, la paridad de precio del detalle. Borrarlo mandaría el `priceUsdc` del detalle a `0` en silencio | §3.3 `[MEDIDO-F2]` | Se **acota** con T-06b, que lo deja fijado por un test. Documentar el acoplamiento en el propio docblock es otra HU |
| **TD-369-5** | `metadata.inputSchema` no existe en ninguna vista: el crudo trae `input_schema` (snake_case) en las dos, y `agent-card.ts:132-133` lee `inputSchema` | `[MEDIDO-F2]`, incidental | Fuera del alcance de esta HU. **Toca a WKH-364** (las sondas derivan su input de ahí) |

---

## 12. Waves de implementación

### W0 — Serial. Contratos y línea base. **Nada paralelizable.**

| Paso | Archivo | Qué |
|---|---|---|
| W0.1 | — | `git fetch origin && git merge origin/main`. **Los números de §3.5 se re-derivan si la rama se movió** (auto-blindaje 228) |
| W0.2 | — | Correr el gate **completo y en orden** y confirmar la línea base de §3.5 |
| W0.3 | `src/types/index.ts` | `capabilitiesState?: 'unresolved'` en `Agent`, patrón «omitido, no `null`» de `:445-457`. ⛔ **CD-12**: cero tokens `:<dígito>` en el docblock, verificado con el `grep` de CD-12 |
| W0.4 | — | `npx tsc -p tsconfig.json --noEmit` + `npm run lint` (CD-14) |

**Salida de W0**: el tipo compila y nada más cambió.

### W1 — Serial. El resolver. **Depende de W0.**

| Paso | Archivo | Qué |
|---|---|---|
| W1.1 | `src/services/agent-detail.ts` (**nuevo**) | `resolveAgentForDetailView` de §4.3. Docblock que nombra CD-9, CD-10 y CD-16 |
| W1.2 | `src/services/agent-detail.test.ts` (**nuevo**) | T-01, T-02a/b/c, T-03, T-04, T-06a, T-06b, T-09, **T-10**. Fixture de §7.1 |
| W1.3 | — | **CD-2**: romper cada test con la mutación de §7.2, anotar el rojo en `auto-blindaje.md` |
| W1.4 | — | `npx biome check --write` + gate desde el paso 1 (CD-14) |

### W2 — Paralelizable en dos ramas independientes. **Depende de W1.**

| Paso | Archivo | Qué |
|---|---|---|
| W2a | `src/routes/discover.ts:337` | Cambiar el call-site. Un import, una llamada |
| W2b | `src/routes/agent-card.ts:43` | Ídem. ⚠️ **No tocar `:66`**, que usa la otra convención a propósito |

### W3 — Serial. Los testigos del borde y de AC-7. **Depende de W2.**

| Paso | Archivo | Qué |
|---|---|---|
| W3.1 | `src/routes/discover.detail-capabilities.test.ts` (**nuevo**) | T-05, **T-07**, T-08 |
| W3.2 | — | **CD-2** sobre esos tres |
| W3.3 | — | **CD-8**: gate completo y en orden, una vez, contrastado contra §3.5 |

### W4 — Cierre.

`doc/sdd/230-…/auto-blindaje.md` + fila 230 de `doc/sdd/_INDEX.md`.

**Total: 5 waves (W0..W4).** Sólo W2 tiene paralelismo interno, y son dos ediciones de una
línea: en la práctica es un pipeline serial de 4 pasos con trabajo real.

### ⚠️ Herramientas de este entorno — medido, no teórico

| ⛔ No usar | ✅ Usar | Por qué |
|---|---|---|
| La herramienta `Grep` | `/usr/bin/grep -rn` | Respeta `.gitignore` y da **cero falso** |
| `cat` | `Read` o `sed -n 'A,Bp'` | Un hook lo corrompe con exit 0 |
| `diff` | `/usr/bin/diff` | **Contesta `Files are identical` sobre archivos que difieren** (auto-blindaje 229, W1) |
| `git diff` | `/usr/bin/git diff` | Trunca cortando hunks |
| `git log` para «¿está en main?» | `git merge-base --is-ancestor` | Omite los commits de merge |

---

## 13. Dependencias

- **Librerías externas nuevas: NINGUNA.** Esta HU no agrega ni actualiza ningún paquete, y
  no usa ningún símbolo de terceros que no esté ya en uso en los archivos que toca
  (`vitest` en los tests, `fastify` en los routes — ambos ya importados en los exemplars).
  ⇒ La tabla §8.1 del template **no aplica**, y se declara vacía a propósito en vez de
  omitirla.
- **Del repo**: `discoveryService.getAgent` y `discoveryService.discover`
  (`src/services/discovery.ts:224`, `:1387`), `SELF_PUBLISHED_REGISTRY_ID`
  (`src/types/index.ts:305`). Los tres existen y se leyeron.
- **Precondición de F3**: rama al día con `origin/main` (`git merge-base --is-ancestor`).

---

## 14. Uncertainty Markers

| Marker | Sección | Descripción | ¿Bloqueante? |
|---|---|---|---|
| — | — | **Ninguno.** No hay `[NEEDS CLARIFICATION]` ni `[TBD]` abiertos | — |

El único `[NEEDS CLARIFICATION]` del F1 (AC-8, línea base de la suite) quedó **resuelto** en
§3.5 con los tres pasos del gate corridos en orden.

---

## 15. ✅ Readiness Check

| # | Ítem | Estado | Evidencia |
|---|---|---|---|
| 1 | Todos los Missing Inputs cerrados o resueltos | ✅ | §9 — MI-1..MI-6 |
| 2 | Cero `[NEEDS CLARIFICATION]` / `[TBD]` | ✅ | §14 |
| 3 | DT-4 decidido, con trade-off y con (c) rechazada por escrito | ✅ | §4.1 |
| 4 | Todos los exemplars verificados en el árbol, con rango | ✅ | §3.6 |
| 5 | Todo path citado existe y se abrió | ✅ | §3.1 |
| 6 | ≥ 1 test por AC, con su mutación de CD-2 | ✅ | §7.2 — 12 tests para 7 ACs testeables; AC-8 es el gate |
| 7 | CD-1 mecanizada, no sólo prosa | ✅ | T-03 asserta `coincideConContenido >= 1` |
| 8 | Presupuesto de escala declarado | ✅ | §8 — **≤ 70 líneas de producción**, ≤ 550 de diff |
| 9 | Línea base del gate medida, completa y en orden | ✅ | §3.5 — `310/316`, `6290/6309` |
| 10 | CDs del work-item heredados sin diluir | ✅ | §5.1 — CD-1..CD-8 textuales |
| 11 | CDs nuevos con su evidencia medida | ✅ | §5.2 — CD-9..CD-16 |
| 12 | Auto-Blindaje histórico leído y convertido en CDs | ✅ | §5.3 — 4 HUs; 2 patrones recurrentes ⇒ CD-11/12/14 |
| 13 | AC-7 con un método **ejecutado**, no leído | ✅ | T-07, más la garantía por construcción de §4.2 |
| 14 | Camino del dinero fuera de alcance por construcción | ✅ | §4.2 + CD-11 — `discovery.ts` no se edita |
| 15 | Waves con archivos exactos y dependencias | ✅ | §12 — W0..W4 |
| 16 | Deuda medida declarada y no arreglada de contrabando | ✅ | §11 — TD-369-1..5 |

> **El SDD está listo para `SPEC_APPROVED`.**

---

## 16. Resumen ejecutivo

1. **El endpoint de detalle federado no publica capacidades bajo ningún nombre.** Ni
   `tags`, ni `capabilities`, ni `skills`. `[MEDIDO-F2]` ⇒ ninguna variante de mapeo,
   desenvoltura ni `agentPath` puede arreglar esto. **Tres hipótesis cayeron antes que
   ésta, y una cuarta en este mismo F2.**
2. **La lista funciona porque el dato está donde el mapeo dice**, no por un fallback. El
   único fallback al nombre canónico del archivo es el de **precio**
   (`discovery.ts:1500`, `:1512-1544`), y es —medido— lo único que evita que `priceUsdc`
   diverja también.
3. **DT-4 = (a)**, forzada por AC-1, **con (b) como piso de AC-2**, y **(c) prohibida por
   CD-9** porque fabrica un dato plausible y falso.
4. **El arreglo vive en los dos routes gratis, no en `getAgent`**, porque `getAgent` tiene
   8 call-sites y 4 están en `/compose` y en la cotización. `src/services/discovery.ts`
   **no se toca**: eso convierte CD-3, CD-4 y AC-7 de promesas en propiedades del diseño.
5. **El riesgo #1 no es el arreglo: es `registry` vs `registry_id`.** Un catálogo vacío que
   se anuncia `catalogStatus: "complete"` dejaría la HU «hecha» sin arreglar nada.
   **CD-10 + T-10.**
