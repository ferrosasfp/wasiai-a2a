# Work Item — [WKH-318] `limit` colapsa el registro federado en `/discover` (y la respuesta lo niega)

**Fecha**: 2026-07-30
**Fase**: F1 (F0 + F1 por `nexus-analyst`)
**Ticket**: WKH-318
**NNN**: 215 (verificado con `Glob doc/sdd/2*/work-item.md`: el más alto es `214-wkh-316-escritor-payment-block`; `209`–`214` tomados)
**Branch sugerido**: `feat/215-wkh-318-discover-limit-federado`

---

## Resumen

Cualquier valor de `limit` en `/discover` hace que el registro federado `WasiAI` (20 de los 23
agentes) **desaparezca**, y la respuesta sigue afirmando que ese registro contribuyó y que no se
excluyó nada. `/compose` y `/orchestrate` pasan `limit` internamente, así que la orquestación viene
eligiendo entre **3 agentes en vez de 23** desde hace tiempo, en silencio.

Son **dos defectos separables**: (A) el fetch federado se cae cuando hay `limit`, y (B) una falla del
fetch se reporta como éxito. (B) es más barato, más importante y se entrega solo.

---

## F0 — Codebase Grounding (verificado, con archivo:línea)

### La causa raíz, medida, con las dos puntas del cable

| # | Eslabón | Evidencia |
|---|---|---|
| 1 | El registro `WasiAI` **sí** declara `limitParam` | `supabase/migrations/20260401000000_kite_registries.sql:48` → `"limitParam": "limit"`; endpoint `:41` → `https://app.wasiai.io/api/v1/capabilities`. (Leído del **seed en el repo**, no de la tabla: no tengo shell en esta fase, y la columna `auth` de `registries` nunca se toca.) |
| 2 | El gate se abre y a2a manda el **over-fetch**, no el page size | `src/services/discovery.ts:591-596` → `url.searchParams.set(schema.limitParam, resolveUpstreamFetchLimit(query.limit))` |
| 3 | El over-fetch es **siempre ≥ 200** | `src/lib/discovery-fetch-limit.ts:47-52` → `max(pageLimit, DISCOVERY_UPSTREAM_FETCH_LIMIT ?? 200)`. Por eso `limit=5`, `limit=23` y `limit=100` producen **idéntico** resultado: los tres mandan `limit=200` upstream. |
| 4 | **El upstream rechaza cualquier `limit > 100` con HTTP 400** | `wasiai-v2/src/app/api/v1/capabilities/route.ts:99-108` → `if (isNaN(n) \|\| n < 1 \|\| n > 100) return NextResponse.json({error:'limit must be between 1 and 100'}, {status:400})` |
| 5 | a2a convierte el 400 en excepción | `src/services/discovery.ts:631-633` → `if (!response.ok) throw new Error(...)` |
| 6 | ...y la excepción se traga, devolviendo lista vacía | `src/services/discovery.ts:275-295` → `.catch(err => { log.error(...); return [] as Agent[]; })` |
| 7 | ...pero la respuesta **sigue declarando el registro como contribuyente** | `src/services/discovery.ts:481` → `const contributingRegistries = registries.map((r) => r.name)` — es la lista de registries **configurados**, sin ninguna relación con si el fetch funcionó |

**Cadena completa**: caller manda `limit=N` → a2a manda `limit=200` a v2 → v2 responde **400** →
`queryRegistry` tira → el `.catch` devuelve `[]` → quedan sólo los 3 self-published → `total=3` →
y la respuesta dice `registries: ["WasiAI","self-published"]`, `excluded: {scope: 0}`.

**Esto explica cada punto de la medición**, incluido el que parecía raro:

- Sin `limit`: el gate `query.limit && schema.limitParam` (`:591`) no se abre, no se manda nada,
  y v2 usa **su default de paginación: 20** (`route.ts:114` → `Number(rawLimit ?? 20)`). 20 federados
  + 3 self-published = **23**. El `total: 23` de producción no es "todo el catálogo": es la página
  default del upstream.
- `offset=0` y `minReputation=0` no rompen porque **ninguno de los dos se reenvía upstream**
  (`minReputation` no aparece en el mapeo de params `:574-599`: es filtro puramente local; `offset`
  ni siquiera existe en el `DiscoveryQuery`).

### Hallazgo lateral que sale del mismo hilo: hay un techo de 20 que nadie ve

a2a **nunca lee `next_cursor`** (v2 lo devuelve en `route.ts:157-158,191`; `queryRegistry`
`:635-647` sólo lee `agentsPath` y mapea). Con `limit` → 0 federados; sin `limit` → exactamente los
**20 primeros por `created_at desc`**. No hay ningún camino por el cual `/discover` pueda ver el
agente federado número 21. Es precisamente el riesgo que `discovery-fetch-limit.ts:107-111`
anticipó por escrito ("un registry que pagina de a 25 devolvería 25 filas — PEOR que hoy y fuera de
nuestro control"); el número real es 20. **No pude determinar** cuántos agentes tiene hoy la tabla
`agents` de v2 (sin shell), así que no sé si hay agentes ya invisibles por este techo.

### Por qué esto no disparó ninguna alarma

El `throw` del `!response.ok` (`:631`) está **fuera** del callback del circuit breaker
(`:618-629`: el `cb.execute` envuelve sólo el `ssrfFetch`). Un 400 sostenido **no cuenta como falla
del breaker**, no abre el circuito y no genera señal de degradación. Lo bueno: no hay riesgo de que
el breaker se abra y contamine el camino sin `limit`. Lo malo: el fallo es perfectamente mudo salvo
por una línea de `log.error` que nadie consulta.

### El impacto en el camino del dinero, que es lo que vuelve esto grave

| Consumidor | Línea | `limit` que pasa | Consecuencia hoy |
|---|---|---|---|
| `/compose` | `src/services/compose.ts:134-137` → `discover({ limit: resolveComposeAgentPoolLimit() })` | `max(50,200)` = **200** | El pool por-slug es **sólo los 3 self-published**. Los 20 federados no se pueden resolver ni hidratar. |
| `/orchestrate` (1er pase) | `src/services/orchestrate.ts:557-561` | **50** → over-fetch 200 | El planner LLM elige entre 3 candidatos, no 23. |
| `/orchestrate` (broaden-retry) | `src/services/orchestrate.ts:577-580` | **50** → over-fetch 200 | El retry que existe para **repoblar** el candidate-set está igualmente envenenado: nunca puede recuperar a los federados. |

La consecuencia de un pool que no contiene al agente está descrita, palabra por palabra, en el
comentario de `src/lib/discovery-fetch-limit.ts:59-71`:

> pool de 50 → el agente no está → `payment.chain` NO se hidrata → queda el default de `getAgent`
> (`avalanche`) → el leg downstream se saltea (guard de familia del payTo / `NO_PAYMENT_FIELD`) o
> apunta al rail equivocado: **el agente no se cobra, en silencio**.

La ironía es que ese módulo se escribió justamente para evitar que el pool se encogiera, tras un
bloqueante adversarial — y el mecanismo que lo protege (pedir 200) es exactamente el que lo rompe.

**Relación con la tarea #86** (0.14 USDC cobrados al caller sin que el agente recibiera nada):
consistente con este defecto, **no confirmada**. No la verifiqué y no la doy por explicada; queda
como hipótesis a cerrar con evidencia en F4, no como causa establecida.

### Sobre `capabilities=` y `minReputation=` combinados con `limit`

Mismo colapso, sin agravante ni atenuante: `limit` es condición **necesaria y suficiente** del 400.
`capabilities` se reenvía como `tag` (`:574-579`, mapeo en el seed `:47`) y `maxPrice` como
`max_price` (`:597-599`), y ambos funcionan solos porque v2 los acepta. `minReputation` nunca sale
de a2a. Combinados con `limit`, los tres degradan al mismo conjunto de 3 y la respuesta miente
igual. **Pendiente de medir en F4** (no tengo shell en F1): confirmar los 4 casos cruzados contra
producción por GET (gratis).

---

## Sizing

- **SDD_MODE**: `full` — toca el camino del dinero y el contrato público de `/discover`.
- **Estimación**: **M** en total. Corte A = **S** (1 archivo de servicio + contrato + tests).
  Corte B = **M** (schema de registry + política de degradación + tests de integración).
- **Smart Sizing**: **QUALITY** (regla del proyecto; además: money-path + superficie pública).
- **Skills de dominio**: `api-contract-design`, `payment-integrity`.
- **Contra el 03/08**: el corte A entra con margen y ya elimina la mentira de la superficie que van
  a integrar los colaboradores. El corte B es el que devuelve los 20 agentes; si el calendario
  aprieta, A solo ya es entregable y honesto (`/discover` diría la verdad sobre estar degradado en
  lugar de fingir 23 fuentes sanas).

---

## El corte propuesto (honestidad primero)

### Corte A — "una falla no se reporta como éxito" (independiente, entregable solo)

No cambia **qué** agentes se devuelven. Cambia **qué se afirma** sobre ellos.
`registries` pasa a listar sólo las fuentes que efectivamente entregaron filas, y la respuesta gana
una señal explícita de degradación con las fuentes que fallaron. Ship first.

**Por qué primero**: es la clase de bug sistémico del proyecto (afirmar más de lo que la evidencia
sostiene, décimo sitio encontrado), está en la puerta de entrada del protocolo, y su arreglo es
independiente de por qué falló el fetch. Además hace **auto-detectable** cualquier regresión futura
del corte B.

### Corte B — "el fetch federado funciona con `limit`"

Devuelve los 20 agentes. Depende de decidir cómo se acota el over-fetch a lo que cada registro
acepta. **El diseño lo decide el Architect en F2** — acá sólo se deja constancia de que la opción
"sacar el límite" ya fue evaluada y **rechazada** por revisión adversarial
(`discovery-fetch-limit.ts:107-111`) y sigue rechazada.

**Dependencia**: A no depende de B. B es mucho más seguro de mergear con A ya en producción.

---

## Acceptance Criteria (EARS)

- **AC-1** (camino feliz con `limit`) — WHEN un caller invoca `GET /discover?limit=N` con `N` válido
  y todos los registros habilitados responden correctamente, the system SHALL devolver los agentes
  de **todas** las fuentes contribuyentes, con `total` igual al número de matches pre-`limit` de la
  unión de esas fuentes, y `agents.length <= N`.

- **AC-2** (registro sin `limitParam`) — IF un registro habilitado no declara `limitParam` en su
  `schema.discovery`, THEN the system SHALL consultarlo sin reenviar ningún parámetro de límite y
  SHALL incluir sus agentes en el resultado, sin degradar ni fallar la request completa.

- **AC-3** (fetch federado que falla) — IF el fetch a un registro habilitado falla por cualquier
  causa (HTTP no-2xx, timeout, SSRF bloqueado, payload no-array), THEN the system SHALL registrar
  esa fuente como **fallida** y SHALL excluirla de la lista de fuentes que contribuyeron, sin que la
  respuesta sugiera de ninguna forma que fue consultada con éxito.

- **AC-4** (honestidad de `registries` / `excluded`) — the system SHALL garantizar que el campo
  `registries` de la respuesta de `/discover` contenga **exactamente** las fuentes que aportaron
  filas al conjunto candidato, y SHALL exponer las fuentes fallidas en un campo de degradación
  explícito, distinguible de una fuente que respondió correctamente con cero agentes.

- **AC-5** (pool de `/compose`) — WHILE existe al menos un registro habilitado y sano,
  `/compose` SHALL resolver su pool de agentes por slug sobre un conjunto que incluya a los agentes
  de ese registro, de modo que `payment.chain` se hidrate desde la card real y no desde el default
  de `getAgent`.

- **AC-6** (`/orchestrate`, mismo defecto) — WHEN `/orchestrate` construye su candidate-set
  (primer pase y broaden-retry), the system SHALL usar el mismo conjunto de fuentes sanas que
  `/discover`, de modo que el planner nunca reciba un candidate-set recortado por una falla de fetch
  no reportada.

- **AC-7** (no-regresión del contrato de paginación) — WHEN un caller invoca `/discover` **sin**
  `limit`, the system SHALL preservar el comportamiento actual byte-a-byte respecto de qué
  parámetros se reenvían upstream (es decir: seguir sin imponer un cap donde hoy no hay ninguno).

- **AC-8** (evidencia contra producción) — the system SHALL demostrar en F4, con salida capturada de
  `GET /discover` (endpoint gratuito) contra el entorno desplegado, que `limit=5`, `limit=100`,
  `capabilities=<x>&limit=N` y `minReputation=0&limit=N` devuelven un `total` consistente con el
  caso sin `limit`.

---

## Scope IN

- `src/services/discovery.ts` — `runDiscoveryPipeline` (`:266-503`), `queryRegistry` (`:559-648`).
- `src/lib/discovery-fetch-limit.ts` — sólo si el corte B lo requiere; su contrato público
  (`resolveComposeAgentPoolLimit`) no cambia de firma.
- `src/types/index.ts` — `DiscoveryResult` (campo de degradación) y, si aplica al corte B,
  `RegistrySchema.discovery`.
- `src/routes/discover.ts` — documentación del contrato de respuesta (`:71-77`).
- Tests: `src/routes/discover*.test.ts`, suites de `discovery` y del pool de `compose`.
- Migración de `registries` **sólo** si el corte B necesita un campo de schema nuevo (JSONB, aditivo).

## Scope OUT

- **Modificar `wasiai-v2`** (subir el cap de 100 del endpoint upstream). Es otro repo; si el
  Architect concluye que es parte de la solución, se abre HU aparte y se coordina. Esta HU se
  resuelve **del lado de a2a**.
- Reapuntar el `discoveryEndpoint` del registro `WasiAI` (el TD-002 de v2 sugiere `/api/v1/agents`).
  Fuera de alcance: cambia el loop-break y la superficie federada entera.
- Implementar paginación por `next_cursor` (el techo de 20). Se **documenta** acá como hallazgo, se
  trabaja en HU separada — ver "Missing Inputs".
- Cambiar el ranking (verified-first → reputación → precio), el filtro de scope de HU-208, o el
  residual TD-189-1.
- Cualquier cosa en mainnet. Devnet/testnet únicamente.
- Confirmar o cerrar la tarea #86.

---

## Decisiones técnicas (DT-N)

- **DT-1**: El work item se parte en dos cortes entregables por separado (A: honestidad; B:
  funcionalidad). Justificación: A no depende de B, es sustancialmente más barato, cubre el riesgo
  reputacional del 03/08 (la superficie que integran los colaboradores deja de mentir) y convierte
  cualquier regresión de B en algo visible.
- **DT-2**: La honestidad se expresa **agregando** un campo de degradación, no cambiando el tipo de
  `registries`. `registries` sigue siendo `string[]`; lo que cambia es **cómo se calcula** (`:481`),
  para no romper a los consumidores existentes que ya leen ese campo.
- **DT-3**: Una fuente que responde 200 con cero agentes y una fuente que falló **no** se colapsan
  en la misma representación. Son estados distintos y el caller necesita distinguirlos (es el mismo
  principio del hallazgo "no pude preguntar no es no": tres valores, no dos).
- **DT-4**: El swallow por-registro (`:275-295`) se **mantiene** como comportamiento (una fuente
  caída no debe tumbar `/discover` entero, CD-4 previo). Lo que cambia es que deje de ser invisible.
- **DT-5**: `resolveUpstreamFetchLimit` conserva su propiedad de monotonía (nunca under-fetch
  respecto de lo que pidió el caller). Cualquier clamp del corte B se resuelve **por registro**, no
  bajando el default global.

---

## Constraint Directives (CD-N)

- **CD-1 (OBLIGATORIA)**: **PROHIBIDO** romper la garantía que `discovery-fetch-limit.ts` existe
  para dar: el pool por-slug de `/compose` debe seguir siendo un conjunto **para buscar por slug**,
  no un top-N rankeado, y no puede encogerse por debajo del piso histórico de 50
  (`COMPOSE_POOL_MIN_LIMIT`). **PROHIBIDO** "arreglar" esto quitando el `limit` de
  `compose.ts:136` o de `orchestrate.ts:557/577`: sin `limit` el tamaño del pool lo decide el default
  de paginación del registro (hoy 20), que está fuera de nuestro control. Ya fue rechazado por AR.
- **CD-2**: **PROHIBIDO** que una falla de fetch federado produzca una respuesta que afirme, por
  acción u omisión, que ese registro fue consultado con éxito. Incluye `registries`, `total`,
  `excluded` y cualquier campo nuevo.
- **CD-3**: **PROHIBIDO** modificar el repositorio `wasiai-v2` dentro de esta HU.
- **CD-4**: **PROHIBIDO** tocar mainnet, credenciales, la columna `auth` de `registries`, o
  cualquier base que no sea `bdwv`; y **sólo lectura**. `caldz` está fuera de límites.
- **CD-5**: **OBLIGATORIO** que el camino sin `limit` conserve exactamente los parámetros que
  reenvía hoy upstream (AC-7). Imponer un cap donde no lo hay reintroduce la clase de bug
  "esconder agentes" en el único camino que hoy funciona.
- **CD-6**: **OBLIGATORIO** que `/orchestrate` y `/compose` queden cubiertos por test, no sólo
  `/discover`. El defecto llegó al camino del dinero por esos dos consumidores; un fix verificado
  únicamente en la ruta pública deja el riesgo real sin cubrir.
- **CD-7**: **PROHIBIDO** que la verificación se apoye en "la suite pasa". Los guards nuevos se
  verifican por **cobertura de sus líneas** y, para el corte A, con al menos un test que falle si el
  campo de degradación se calcula desde la lista de registries configurados en lugar de las fuentes
  que respondieron (el guard no puede compararse consigo mismo).

---

## Missing Inputs

- `[resuelto en F2]` Mecanismo del corte B (clamp por registro declarado en el schema JSONB / probe
  y reintento sin `limit` ante 4xx / negociación del máximo). Lo decide el Architect con la
  aritmética del over-fetch a la vista.
- `[resuelto en F4]` Medición cruzada `capabilities`/`minReputation` × `limit` contra producción por
  GET. No pude ejecutarla en F1: **esta fase no tiene shell** (sólo Read/Glob/Write).
- `[resuelto en F4]` Cuántos agentes tiene realmente la tabla `agents` de v2. Determina si el techo
  de 20 ya está ocultando agentes hoy o es sólo un riesgo latente. **No pude determinarlo** en F1.
- `[NEEDS CLARIFICATION]` La tarea #86 (0.14 USDC cobrados sin pago al agente): consistente con este
  defecto, no confirmada. Requiere trazar ese `orchestrationId` concreto.
- `[DECIDE FOUNDER]` **Ante una fuente federada caída, ¿`/compose` y `/orchestrate` deben seguir
  con el pool parcial o cortar?** Es la decisión de negocio real: seguir con pool parcial es
  exactamente lo que produjo el estado actual (elegir entre 3 creyendo elegir entre 23); cortar
  vuelve a `/discover` frágil ante cualquier registro de terceros caído. Recomendación del Analyst:
  `/discover` degrada y lo declara; el **camino del dinero** (`/compose`/`/orchestrate`) falla
  explícito antes que cobrar sobre un candidate-set que sabe incompleto.
- `[DECIDE FOUNDER]` ¿El campo de degradación de `/discover` es parte del contrato público que se
  documenta a los colaboradores para el 03/08, o interno/observabilidad?
- `[DECIDE FOUNDER]` ¿Se abre HU para subir el cap de `limit` en `wasiai-v2` (hoy 100) y/o para
  seguir `next_cursor`? Sin una de las dos, el catálogo federado visible queda topeado.

---

## Análisis de paralelismo

- **Bloquea**: cualquier demo del 03/08 que dependa de que la orquestación elija entre el catálogo
  completo, y cualquier integración de colaboradores contra `/discover` (verían `total: 3` y una
  lista de registries que no se corresponde).
- **Puede ir en paralelo con**: WKH-307/308 (ledger e idempotencia Solana), WKH-314 (x402 inbound),
  WKH-315 (depósito prepago), WKH-316 (escritor del bloque `payment`) — ninguna toca
  `discovery.ts` ni `discovery-fetch-limit.ts`.
- **Riesgo de colisión a vigilar**: **WKH-313** ("primer trabajo, agentes sin historial"). Por el
  título toca reputación, y el filtro `minReputation` + `attachReputations` viven dentro del mismo
  `runDiscoveryPipeline` (`:402-428`) que esta HU modifica. **No abrí `doc/sdd/211-*`** (prohibido en
  esta fase), así que el solapamiento es **inferido, no verificado**. Coordinar el orden de merge o
  aislar los cambios a bloques distintos de la función.
- **Sinergia con WKH-316**: esta HU es lo que hace que un `payment` recién publicable sea
  efectivamente **visible** para `/compose`. Sin WKH-318, un agente federado con `payment` correcto
  sigue sin llegar al pool.
