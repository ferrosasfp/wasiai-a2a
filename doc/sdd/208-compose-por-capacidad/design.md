# HU-208 — `/compose` por capacidad · registro de decisiones

Spec: WAS-187 (wasiai-v2 `.nexus/sprints/sprint-2/sdd-187.md`) + encargo del
coordinador. Este documento existe porque explica decisiones que el código solo
no puede defender y que, sin esto, alguien deshace en tres meses.

## Qué cambia

Un step de `/compose` puede declararse por `agent` (como siempre) **o** por
`capability` (nuevo), exactamente uno de los dos. El gateway resuelve qué agente
cumple mejor la capacidad.

Es **composición, no orquestación**: el que pide sigue declarando los pasos y su
orden. No hay planificador ni LLM decidiendo la forma del pipeline.

## Decisión 1 — No hay ranking nuevo. Se reusa el de discovery.

"El mejor agente" ya está definido en un solo lugar: el sort de
`runDiscoveryPipeline` (`verified` → reputación computada desc → precio asc).
`resolveCapability` pide el conjunto ya ordenado y toma la **cabeza**. No
reordena, no puntúa, no desempata.

Por eso tampoco se portó `performance_score` de WAS-187: nuestro
`AgentReputation.score` ya se deriva de tasks liquidadas + success_rate +
latencia, que es lo que aquella columna medía. Un segundo score sería una segunda
definición de "el mejor", y divergirían sin que nadie se entere.

## Decisión 2 — El precio y el 402: resolver una sola vez, aguas arriba

`resolveComposeCapabilitiesHandler` corre **entre** `validateComposeBodyHandler` y
`resolveComposePriceHandler`, o sea antes de `requirePaymentOrA2AKey`.

Tres consecuencias, todas buscadas:

1. **El descubrimiento es gratis.** Nada antes del middleware de pago debita ni
   settlea, así que resolver ahí no le cuesta nada al llamador ni cuando falla.
2. **El 402 y el débito cotizan el pipeline real.** El preHandler de precio ve un
   arreglo donde todos los steps traen un slug concreto. No necesitó **ni un solo
   cambio de lógica de precio**: para él, un step resuelto por capacidad es
   indistinguible de uno que el llamador nombró.
3. **Se resuelve una sola vez.** Si la resolución viviera en
   `composeService.resolveAgent`, correría **después** de cotizar y **después** de
   debitar el step-0, sobre entradas de ranking que cambian solas (fetch en vivo a
   los registries + `computeReputationBatch`), y podría elegir otro agente: el
   llamador habría pagado por un pipeline y recibido otro.

El pin está **enforced por el compilador**, no por convención:
`ComposeRequest.steps` es `ResolvedComposeStep[]` (con `agent: string`
obligatorio), así que entregarle un step sin resolver al ejecutor es un error de
compilación.

## Decisión 3 — Los filtros van PRE-SORT. Esto es lo que neutraliza TD-189-1.

`runDiscoveryPipeline` corre: filtros → sort → `slice(0, limit)`. Como el recorte
va **después** del sort, sobre una lista ya ordenada sólo puede sacar elementos de
la **cola**:

    sorted.slice(0, N)[0] === sorted[0]    para todo N >= 1

El recorte **jamás puede cambiar quién gana**; sólo descarta candidatos que no
íbamos a elegir. Eso deja el residual TD-189-1 (el `slice` global sobre un
over-fetch por-registry) **fuera** del camino de la resolución por capacidad. Ese
residual muerde al pool **por slug** de `compose.resolveAgent`, que pide el
catálogo entero sin filtrar y ahí sí el agente compite contra todo por una ventana
finita.

**La propiedad se sostiene sólo mientras los filtros corran antes del sort.** Si
se movieran aguas abajo del recorte — por ejemplo filtrando en el resolver sobre
la página ya cortada — la precondición de ese residual pasaría a estar encima del
camino del dinero. Anclado por `T-DISCFILT-06/07` y por la mutación M8.

## Decisión 4 — El alcance de la credencial es un FILTRO de candidatos

Port de WAS-187 AC-7. Un agente que la credencial del llamador estructuralmente no
puede invocar **no es un candidato**. No es fallback silencioso: es definir bien el
conjunto. Que "el mejor" sea relativo al llamador es correcto, no un defecto.

Se usa `authzService.checkScoping`, **la misma función** que después hace cumplir
el alcance en `composeService.compose`. Con dos predicados distintos, el selector
elegiría agentes que el ejecutor rechaza con 403 sobre un agente que el llamador
nunca nombró. Por la misma razón, el lector de `category` se extrajo a
`lib/agent-category.ts` y lo comparten selector y ejecutor.

**Nada se descarta a escondidas**: `DiscoveryResult.excluded.scope` cuenta los
candidatos que el filtro sacó, y el 422 dice *"no hay agente dentro del alcance de
esta key"*, no un "no hay agente" a secas que mandaría a buscar el problema al
catálogo.

### El problema de orden que esto creó, y cómo se resolvió

El alcance lo resuelve el middleware de pago, que corre **después**. Por eso
`services/caller-scope.ts` lo lee por adelantado, en modo solo-lectura, reusando
los builders puros ya exportados (`buildDelegationEffectiveRow` /
`buildSessionEffectiveRow`, WKH-173 DT-B) — no re-implementa el cálculo.

**Invariante de seguridad: esto no autoriza nada.** Alimenta un filtro de
candidatos; el alcance se sigue haciendo cumplir donde siempre. Por eso todos los
caminos de error devuelven `undefined` (sin filtro) en vez de rechazar: si falla,
se elige el mejor global y el ejecutor lo rechaza con 403 — exactamente el
comportamiento previo a esta HU. **En ninguna rama puede conceder acceso.**

## Decisión 5 — NO existe `constraints.chain`. Rechazado a propósito.

Se evaluó (y se llegó a implementar) una restricción de rail para desambiguar
gemelos como `remit-corridor-fx` / `remit-corridor-fx-solana`. **Se revirtió.**

Forzar la cadena es hacerle trampa al ranking. El orden `verified → reputación →
precio` se respeta **siempre**. Si el agente que queremos no gana, el problema no
es el ranking: es que ese agente no se lo merece todavía, y el arreglo va del lado
de los **datos** (que se gane la reputación), no del código.

`max_price_usdc` y `min_reputation` **sí** quedan: son restricciones legítimas del
que pide, no una forma de señalar un agente concreto por la puerta de atrás.

Corolario implementado: una clave **desconocida** en `constraints` (incluida
`chain`) es un **400**, nunca se ignora. Rechazar la feature no puede significar
tragarse el parámetro: quien mande `chain` creería haber fijado el rail mientras el
gateway elige por su cuenta.

## Decisión 6 — Los empates se rompen al azar

Agotados los tres criterios, el ganador lo decidía el orden del arreglo, que sale
de cómo se concatenaron las fuentes: un **sesgo posicional invisible** que repartía
ingresos por un accidente de implementación. Dos agentes idénticos en identidad,
reputación y precio merecen la misma chance.

Vive en el comparador de `discovery.ts`, donde vive el criterio, no en compose.

**No se puede llamar al aleatorio dentro del comparador**: `Array.sort` exige una
relación de orden consistente, y un `cmp` no determinista deja el resultado
**indefinido** por especificación. Por eso el valor se asigna una vez por agente
antes de ordenar (`lib/ranking-tiebreak.ts`) y el comparador sólo lo lee: el orden
vuelve a ser total y estable dentro de la request.

Se prefirió esto a un `shuffle` previo + sort estable porque aquello se apoya en
una propiedad **implícita** (la estabilidad del sort de V8) y en un lugar distinto
del criterio: quien lea el comparador no vería el desempate, y un re-sort en otra
capa lo desharía en silencio.

La fuente de aleatoriedad es **inyectable** para que los tests no sean flakes; el
test de reparto usa un PRNG sembrado (determinista **y** distribuido).

## Decisión 7 — `fallback_slug` (WAS-187 AC-6) NO se porta

Es el anti-patrón de fallback silencioso un nivel corrido, y además **vuelve a
acoplar al llamador con un agente**, que es justo lo que esta HU elimina: un
`fallback_slug` es un slug en el código del cliente con otro nombre. El que quiere
un agente concreto tiene `agent`. (En wasiai-v2 esa lógica además estaba rota —
defecto documentado en el S5 review.)

## Defectos de WAS-187 portados como ARREGLO, no como bug

| Defecto (wasiai-v2) | Acá |
|---|---|
| AC-3 incumplido: código `validation_error` en vez de `ambiguous_step` | Se emite `ambiguous_step` real (`T-SHAPE-03`) |
| WAS-187-01: `NaN` en constraint pasaba el guard `!== undefined` | Se valida finitud; `NaN` → 400 (`T-SHAPE-09`) |
| AC-6 `fallback_slug` roto | No se porta (Decisión 7) |

## Residual abierto — el precio no está congelado

La **identidad** del agente no puede derivar (está pineada). El **precio** del
agente ya fijado sí puede cambiar entre la cotización y el cobro. Ese residual
existe hoy para todo llamador que nombra su agente y **no se cierra en esta HU**.

La solución acordada es **congelar la cotización por 10 minutos**, no una alarma:
una alarma avisa después de que alguien pagó de más; un precio congelado hace que
no pueda pasar. Requiere almacenamiento durable entre requests (no hay Redis en
este repo — ver `agent-price.ts:9` y `reputation.ts:21`), o sea una migración, o
un quote firmado que el cliente devuelva. **Pendiente de decisión**; no se
implementó nada a medias.

## Deuda anotada

- **Eco del pipeline resuelto cuando falla en el paso k**: si el pipeline falla en
  el step k, `result.steps` sólo trae 0..k-1, así que las resoluciones de los
  steps posteriores no son visibles. No se agregó porque es un cambio de forma de
  la respuesta y no conviene mezclarlo con esta HU.
- **Congelamiento de precio**: arriba.
