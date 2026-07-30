# WKH-313 - El primer trabajo de un agente que no es nuestro

**Tipo**: pregunta estructural de producto con implementación chica atrás
**Estado**: F1 (work-item). NO hay decisión tomada.
**Repo de referencia**: `/home/ferdev/.openclaw/workspace/wasiai-a2a` (verificado en solo lectura, rama `main`)
**Fecha de verificación**: 2026-07-29

---

## 0. Resumen ejecutivo para quien decide

Un agente recién publicado tiene score de reputación 0. Si el que consulta pide un piso mayor a 0, el agente queda excluido. Como nunca lo eligen, nunca acumula historial. El círculo se cierra.

Eso es cierto. Pero **tres partes del encuadre con el que llegó el encargo no resistieron la verificación**, y las tres cambian qué hay que decidir:

1. **El gateway NO pone el piso.** No hay default de entorno, no hay inyección del planner, no hay valor implícito. El piso lo fija siempre el que consulta. El marketplace hoy es neutral en el mecanismo. Detalle en §2.
2. **La asimetría con `verified` no es la que se describió.** `verified` tambien es un filtro opcional del que consulta (`discovery.ts:320-321`), no solo un criterio de orden. En forma, identidad y reputación son idénticos: filtro opt-in mas clave de orden. Detalle en §3.
3. **La asimetría real es otra, y es mas fuerte que la que se creía.** Es de *alcanzabilidad de la salida*: un agente puede volverse `verified` solo, sin pedirle permiso a nadie. No puede volverse reputado solo. La única entrada del score es ser elegido y cobrado por callers distintos, que es exactamente lo que el filtro le niega. Detalle en §3.

La decisión de producto no es "el marketplace excluye o no excluye". Es: **¿la plataforma se hace cargo de que el instrumento que publica y documenta produce un resultado cerrado, aunque cada exclusión individual la haya pedido un tercero?**

---

## 1. Diagnóstico verificado (archivo:línea y aritmética real)

### 1.1 El filtro

`src/services/discovery.ts:422-428`

```
if (query.minReputation != null) {
  const min = query.minReputation;
  allAgents = allAgents.filter((a) => {
    const score = a.computedReputation?.score;
    return (Number.isFinite(score) ? (score as number) : 0) >= min;
  });
}
```

Confirmado lo que decía el encargo:

- Usa **solo** `computedReputation.score`. NO usa el fallback `?? a.reputation` que sí usa el comparador del sort en `discovery.ts:437-440`. La razón está escrita en `discovery.ts:412-417` y es correcta: `agent.reputation` lo auto-reporta el registry en la card, así que filtrar con él no filtra nada (basta declarar `reputation: 100`).
- **Fail-safe hacia la exclusión**: un agente sin score computado cuenta 0 (`discovery.ts:426`). Un agente con 0 tareas liquidadas no aparece en el Map de `computeReputationBatch` (`reputation.ts`, retorna solo slugs con score), así que cae en esa rama.
- Corre **antes** del sort y del `slice` (`discovery.ts:404-407`), por lo tanto también achica `total` (`discovery.ts:494`). No es un filtro cosmético de página: reduce el conjunto de matches de verdad.

### 1.2 La fórmula

`src/services/reputation.ts:159-160`

```
const raw = Math.min(tasksSettled / resolveScaleFactor(), 1);
const score = Math.round(raw * 100 * successRate);
```

Con `F = REPUTATION_SCALE_FACTOR` (default 50, `reputation.ts:37-40`, `.env.example:826`).

### 1.3 Qué cuenta como tarea liquidada

`src/services/reputation.ts:113-116`: exige `status === 'success'` **Y** `cost_usdc > 0`. Confirmado: **el trabajo gratis no cuenta**. Esto tiene un efecto de segundo orden que conviene tener escrito, porque es contraintuitivo:

- `successCount` se incrementa con **cualquier** success, incluso con `cost_usdc = 0` (`reputation.ts:111`).
- `failedCount` se incrementa con **cualquier** failed, sin importar el costo (`reputation.ts:128-129`).
- `tasksSettled` solo sube con success pago.

Consecuencia: **un agente que trabaja gratis para arrancar sube su `success_rate` pero nunca su `tasks_settled`, y si una de esas corridas gratis falla, el fallo sí le pega al score.** El trabajo gratis tiene downside sin upside en esta fórmula. Es un detalle que importa porque "que haga unas gratis primero" es la primera idea que se le ocurre a cualquiera y no funciona.

### 1.4 El cap anti-sybil por caller

`src/services/reputation.ts:145-148` y `:45-49`:

```
const K = resolveMaxTasksPerCaller();          // default 5, .env.example:835
let tasksSettled = 0;
for (const n of acc.settledByCaller.values()) tasksSettled += Math.min(n, K);
```

`tasksSettled = Σ_caller min(n_caller, K)`. Esto es lo que convierte el problema de "conseguir un trabajo" en **"conseguir trabajos de muchos clientes distintos"**, que es bastante peor.

### 1.5 La aritmética, con los defaults de hoy (F=50, K=5)

Con `success_rate = 1`:

| Score objetivo | Tareas pagas necesarias | **Callers distintos necesarios** |
|---|---|---|
| 1 (cualquier piso > 0) | 1 | 1 |
| 10 | 5 | 1 |
| 20 | 10 | 2 |
| 50 | 25 | 5 |
| 80 | 40 | 8 |
| 100 | 50 | 10 (y cero fallos históricos) |

Lecturas que importan:

- **Un solo cliente no puede llevar a un agente mas allá de score 10.** El cap lo corta ahí. Un piso de 20 exige, estructuralmente, dos clientes distintos que ya hayan pagado 5 veces cada uno.
- **El piso mínimo efectivo es 1.** Como el score es entero y un agente sin historial vale 0, `minReputation = 1` ya excluye a todo agente nuevo. No hace falta pedir 50 para cerrar la puerta.
- El bucket `'__anon__'` (`reputation.ts:133-134`) junta **todos** los eventos sin `caller_ref_hash` en una sola cubeta capeada a K. Historia legacy completa: 10 puntos como techo.

### 1.6 Qué pasa con un fallo, y el caso feo

`successRate = round(success / (success + failed), 2)` (`reputation.ts:155-157`).

| Situación | tasks_settled | success_rate | score |
|---|---|---|---|
| 5 pagas, 0 fallos | 5 | 1.00 | 10 |
| 5 pagas, 1 fallo | 5 | 0.83 | 8 |
| 3 pagas, 1 fallo | 3 | 0.75 | 5 (era 6) |
| 1 paga, 1 fallo | 1 | 0.50 | 1 |
| **1 paga, 4 fallos** | **1** | **0.20** | **0** |

La última fila es el caso feo y no está documentado en ningún lado: **un agente que ya cobró puede volver a score 0 y quedar permanentemente invisible bajo cualquier piso mayor a 0**, sin camino de vuelta, porque para reparar el `success_rate` necesita corridas nuevas y para tener corridas nuevas necesita ser elegido. Es el mismo círculo, pero cerrándose sobre un agente que ya había entrado. El fallo pega proporcionalmente mas fuerte cuanto mas corto es el historial, que es justo cuando el agente es mas frágil.

---

## 2. Quién puede pedir el filtro y con qué valor (VERIFICADO, no asumido)

**Respuesta: lo fija siempre el que consulta. El gateway no lo fija nunca.**

Rastreo completo de `minReputation` / `min_reputation` fuera de tests:

| Punto de entrada | archivo:línea | Origen del valor |
|---|---|---|
| `GET /discover` (query string) | `src/routes/discover.ts:99` | parámetro del que consulta |
| `POST /discover` (body JSON) | `src/routes/discover.ts:159` | parámetro del que consulta |
| Resolución de capacidad de `/compose` | `src/services/capability-resolver.ts:100-101` | `constraints.min_reputation` del step, que manda el que consulta |
| Validación de forma del step | `src/lib/compose-step-shape.ts:156` | `min_reputation` esta en el allowlist de constraints |
| Tipo público | `src/types/index.ts:434-437` | documentado como piso de reputación computada |
| Validación de rango | `src/lib/discovery-query.ts:44-57` | `[0,100]`, ausente o vacío devuelve `undefined` (no filtra) |

Y lo que **no** existe, que es lo importante:

- **No hay variable de entorno** que fije un piso por defecto. Barrí la lista completa de `process.env.*` del repo: hay `REPUTATION_SCALE_FACTOR`, `REPUTATION_MAX_TASKS_PER_CALLER`, `REPUTATION_CACHE_TTL_MS`, `REPUTATION_CALLER_HMAC_SECRET`. Ninguna fija un mínimo de discovery.
- **El planner LLM de `/orchestrate` nunca lo setea.** `src/services/orchestrate.ts` (1074 líneas) tiene **cero** ocurrencias de `constraints` y de `min_reputation`. El plan que arma el modelo no puede introducir un piso.
- **Ausente equivale a no filtrar** (`discovery-query.ts:45`), y el filtro entero esta gateado en `query.minReputation != null` (`discovery.ts:422`).

### Qué significa esto para el encuadre

Cambia el encuadre, pero **no disuelve el problema**, y conviene ser preciso sobre por qué:

- Es **falso** que "el gateway está cerrando la puerta él mismo". Hoy no la cierra. Por defecto un agente nuevo aparece en todos los resultados.
- Es **verdadero** que la plataforma fabrica el instrumento, lo documenta como buena práctica (`doc/INTEGRATION.md:249-257`) y va a tener a su propio consumidor insignia usándolo. La neutralidad del mecanismo no es neutralidad del resultado si todo consumidor serio pone piso por la misma razón obvia.

O sea: la plataforma no aprieta el gatillo, pero vende el arma con el manual. Si la respuesta a "¿como arranca un tercero?" es "depende de que ningún consumidor pida piso", eso no es una respuesta, es una apuesta.

**Decisión del founder, no de ingeniería**: si la plataforma se hace cargo o no del resultado agregado de una perilla que ella publica pero no acciona.

---

## 3. La asimetría con `verified` (CORRECCIÓN al encargo)

El encargo decía: para identidad on-chain el founder decidió que sea el primer criterio del orden y no un requisito; para reputación el código hace lo contrario, es un requisito duro; nadie decidió esa asimetría.

**Eso, tal como está escrito, no es exacto.** `verified` **tambien** es un filtro:

```
src/services/discovery.ts:319-322
// Filter by verified if requested (AC-3, AC-9: AND logic with status filter)
if (query.verified === true) {
  allAgents = allAgents.filter((a) => a.verified === true);
}
```

En forma, los dos son lo mismo:

| | filtro | default | clave de orden |
|---|---|---|---|
| `verified` | opt-in del que consulta (`:320`) | apagado | 1a (`:456-457`) |
| reputación | opt-in del que consulta (`:422`) | apagado | 2a (`:458-459`) |

La decisión del founder sobre identidad **sí** está respetada en el camino por defecto. Y la reputación está exactamente igual por defecto. No hay una asimetría de política que alguien haya introducido sin darse cuenta.

### La asimetría que sí existe, y es peor

Es de **alcanzabilidad de la salida**, no de forma del filtro:

- **`verified` tiene salida self-service.** Un agente que queda afuera de `verified=true` puede bindear su identidad ERC-8004 on-chain y entrar. No necesita que nadie lo elija. La llave está de su lado.
- **La reputación no tiene salida self-service.** La única entrada de `tasksSettled` son tareas liquidadas con `cost_usdc > 0` de callers distintos (§1.3, §1.4). Es decir: **la única forma de dejar de estar excluido es ser elegido, que es precisamente lo que la exclusión impide.** La llave está del lado del que te excluye.

Ese es el hallazgo que conviene que quede escrito, porque es el que hace que esto no sea "una perilla mas estricta que otra" sino un lazo. Y aplica igual aunque el piso lo pida un tercero: la neutralidad de quien acciona no cambia que la salida sea inalcanzable.

---

## 4. Qué protege hoy ese piso (obligatorio leer antes de proponer debilitarlo)

El piso es el **único gate automático de calidad** entre "se resolvió una capacidad" y "se mueve plata a una contraparte". No hay otro. Concretamente cubre:

1. **Cobro sin entrega.** El pago es por llamada, no por resultado. Un agente puede cobrar y devolver basura, y el settle igual ocurre. La reputación es lo único que penaliza eso a futuro, vía `success_rate`.
2. **Squatting de capacidad.** Publicar un agente con una capacidad popular y un `payTo` propio. Sin piso, un agente recién publicado compite de entrada por el ranking.
3. **Fee farming.** Publicar, ser seleccionado, cobrar la llamada, no entregar, repetir bajo slug nuevo.

Y hay una agravante de contexto: **la pata donde esto se aplica termina en un desembolso a una persona real.** El constraint es por step de `/compose` (`compose-step-shape.ts:156`), así que el riesgo depende de qué hace el step. El step que resuelve la capacidad de cashout/payout es el que le manda plata a un humano, y ahí un agente malo no produce un resultado malo: produce una remesa que no llega.

> **VERIFICAR (fuera de este repo)**: qué piso concreto setea hoy el pipeline de remesa de Chaski y sobre qué leg. Ese código vive en `chaski-v3` / `remit-agents`, que no toqué. **No asumir el valor.** La decisión de §5 depende de este dato: no es lo mismo relajar un piso de 1 que uno de 50.

**Regla para las opciones de §5**: ninguna opción que debilite el piso se acepta sin decir explícitamente cuál de los tres riesgos de arriba se está aceptando a cambio, y sobre qué leg.

---

## 5. Opciones de política (con contras honestas, sin recomendación)

Ninguna de estas está recomendada. Todas tienen un costo real y está escrito.

### Opción A. Carril de estreno con cupo

Reservar N lugares de la página de resultados para agentes bajo el piso.

- **Contra dura**: el que consulta pidió un piso y recibe algo que no lo cumple. Es exactamente la clase de bug que el propio código nombra y rechaza en `discovery.ts:412-417` y `compose-step-shape.ts:149-155`: un filtro que el que pide cree tener y no tiene. Si se hace, tiene que ser opt-in explícito o venir marcado en la respuesta, no ambas cosas a medias.
- **Contra**: el cupo sin regla de elegibilidad es un vector de spam. Publicás 50 agentes y ocupás el carril.
- **Contra**: no responde quién come el primer fallo. El cupo reparte oportunidad, no riesgo.
- **Riesgo aceptado**: 1 y 3 de §4, acotado al tamaño del cupo.

### Opción B. Que la reputación ordene en vez de filtrar

Sacar el filtro, dejar la clave de sort.

- **Contra que la mata**: con pocos candidatos, salir último es lo mismo que salir primero. `capability-resolver.ts` toma `result.agents[0]` y listo. **Con un solo candidato el orden es un no-op y el recién llegado se lleva la pata de dinero completa.** La vara desaparece exactamente en el caso mas común para una capacidad nueva, que es el caso donde mas importa.
- **Contra**: rompe en silencio a todo consumidor que hoy depende del filtro. Un piso que pasa a ser sugerencia sin avisar es peor que no tenerlo.
- **Riesgo aceptado**: 1, 2 y 3 de §4, sin techo.

### Opción C. Período de gracia

El agente nuevo queda exento del piso por X días o por sus primeras N tareas.

- **Contra**: se puede farmear. Republicar bajo slug nuevo reinicia el reloj. Hoy no hay binding de publisher que lo impida para self-published; habría que anclarlo a `owner_ref` o a una identidad ERC-8004, y eso es trabajo aparte.
- **Contra**: la gracia por calendario vence contra el reloj, no contra la evidencia. Un agente que no recibió tráfico durante la ventana sale con score 0 y la ventana quemada. La variante "primeras N tareas" no tiene este problema y es estrictamente mejor.
- **Contra**: no arregla el caso feo de §1.6 (el agente que ya entró y volvió a 0).
- **Riesgo aceptado**: 1 y 3, acotado a N tareas por agente.

### Opción D. Reputación importada

Aceptar historial externo: registro de reputación ERC-8004, otro marketplace, volumen liquidado on-chain.

- **Contra de principio**: el repo se niega deliberadamente a filtrar con datos que controla la parte filtrada (`discovery.ts:412-417`). Una reputación importada de una fuente que el agente eligió es la misma falsa garantía que `agent.reputation`, con mas pasos. Solo sirve si la fuente es un ancla de confianza y no forjable.
- **A favor**: el riel existe. Hay lector on-chain (`src/adapters/erc8004-reputation.ts`) y camino de escritura (`ERC8004_REPUTATION_WRITEBACK_ENABLED`, hoy apagado por default). No es net-new completo.
- **Contra**: define una lista de fuentes confiables, que es una decisión de gobernanza permanente, no un flag.
- **Riesgo aceptado**: desplaza el riesgo a la calidad del ancla externa.

### Opción E. Piso modulado por densidad de candidatos

Si aplicar el piso vacía el conjunto (o lo deja bajo M), relajarlo y decirlo.

- **Contra que la mata**: el filtro deja de filtrar exactamente cuando el pool es fino, y **el pool fino se puede fabricar**. Publicá una capacidad de nombre nicho que nadie mas sirve y el piso se evapora solo. Convierte una garantía monótona en una condicional que un atacante controla.
- **Contra**: dificulta razonar. "Tenés piso 50, salvo cuando no" no es un contrato.
- **Riesgo aceptado**: 2 y 3, y encima de forma dirigible por el atacante.

### Opción F. Fianza en lugar de historial

El recién llegado deposita una garantía reembolsable; el piso se levanta mientras la fianza esté viva y se ejecuta ante disputa.

- **Contra**: pone una barrera de capital que castiga al constructor chico legítimo, que es justo el que la tesis abierta dice querer.
- **Contra**: necesita maquinaria de ejecución de la fianza. El árbitro existe (`src/services/arbiter.ts`, `src/adapters/escrow/arbiter-executor.ts`) pero cablear slash contra un stake es trabajo real, no un flag.
- **Contra de producto**: sustituye reputación por colateral. Es una promesa distinta a la que hoy hace el marketplace.
- **Riesgo aceptado**: ninguno de los tres, los cubre con dinero. Es la única opción que no debilita §4.

---

## 6. La pregunta de demo

**Repregunta probable**: "Si tu marketplace es abierto, ¿cómo consigue su primer trabajo un agente que publicó un tercero?"

**Respuesta honesta con el estado de hoy** (sin adornos, para decir tal cual):

> "Por defecto aparece. Nosotros no ponemos ningún piso de reputación: el que consulta decide si pone uno, y si no pone, el agente nuevo compite desde el primer día, mas abajo en el ranking pero visible.
>
> Ahora, si el que consulta pide piso mayor a cero, el agente nuevo queda afuera, porque arranca en cero. Y la única forma de subir es que lo elijan y le paguen, así que ahí sí hay un círculo. Hoy eso lo resolvemos a mano para nuestros propios agentes, dándoles los primeros trabajos pagos de verdad. Para un tercero todavía no hay un camino automático. Está identificado y abierto como HU, no está decidido."

**Lo que NO hay que decir**, porque no es cierto y se cae a la primera repregunta:

- "Ordenamos, no filtramos." Filtramos si nos lo piden (`discovery.ts:422`).
- "La reputación es opcional." El instrumento es opcional; el efecto sobre el excluido no.
- "Con unas corridas gratis arranca." Falso, §1.3: el trabajo gratis no suma a `tasks_settled` y si falla, resta.

---

## 7. Criterios de aceptación (EARS)

Invariantes que valen sea cual sea la opción elegida:

- **AC-1 (ubicuo)**: El gateway **no aplicará nunca** un piso de reputación que el que consulta no haya pedido explícitamente. Guard de regresión sobre la neutralidad verificada en §2.
- **AC-2 (no deseado)**: **Si** un resultado de discovery se devuelve con el piso relajado, salteado o modulado, **entonces** la respuesta lo indicará explícitamente. Prohibido el override silencioso (misma clase de bug que `discovery.ts:412-417`).
- **AC-3 (dirigido por evento)**: **Cuando** el que consulta pide `minReputation > 0` y hay candidatos descartados por ese piso, la respuesta informará cuántos. Hoy `excluded` solo lleva `scope` (`discovery.ts:501`), así que un conjunto vacío por piso es indistinguible de "esa capacidad no existe". Este AC es independiente de la opción y hace **visible** el problema aunque no se arregle.
- **AC-4 (dirigido por estado)**: **Mientras** un agente esté bajo una habilitación de estreno (opción A o C), la habilitación estará acotada por cantidad de selecciones y/o por tiempo, y el consumo de ese cupo será observable en el registro del agente.
- **AC-5 (no deseado)**: **Si** la habilitación se agota, o el score del agente cae de nuevo bajo el piso, **entonces** el agente volverá a quedar excluido sin intervención manual.
- **AC-6 (opcional)**: **Donde** la política elegida admita a un agente bajo el piso en un step que desemboca en un desembolso a una persona física, el gateway exigirá el control compensatorio que defina el founder (§4). Sin control compensatorio definido, esa combinación no se habilita.
- **AC-7 (ubicuo)**: El score seguirá siendo **no forjable por el agente puntuado**. Ninguna entrada nueva podrá subirlo mas allá de lo que ya permite el cap por caller (`reputation.ts:145-148`). Esto veta cualquier variante de auto-reporte, incluida la opción D mal anclada.

---

## 8. Alcance

### Dentro

- Diagnóstico verificado con archivo:línea (hecho, §1 a §3).
- Documentar la asimetría real de alcanzabilidad (§3) donde vive la política de ranking, para que no se vuelva a leer como "una perilla mas estricta que otra".
- AC-3: exponer el conteo de excluidos por piso en `excluded` de `DiscoveryResult`. Es chico, no cambia política y convierte un vacío mudo en un dato.
- Presentar a founder las opciones de §5 con su costo, para una decisión.

### Fuera

- Elegir la política. **Es decisión del founder**, no de ingeniería.
- Tocar la fórmula, `F` o `K`. Cambiar `REPUTATION_SCALE_FACTOR` o `REPUTATION_MAX_TASKS_PER_CALLER` mueve todos los scores existentes a la vez, incluidos los de producción. No es parte de esta HU.
- El arranque a mano de nuestros propios agentes. Ya está aprobado y en curso por otra vía.
- Reputación on-chain / write-back ERC-8004 (`ERC8004_REPUTATION_WRITEBACK_ENABLED`). Solo se nombra como riel existente en la opción D.
- Binding de publisher para evitar el reciclado de slug. Es prerequisito de la opción C, y es HU aparte.
- Cualquier cambio en repos de consumidores (`chaski-v3`, `remit-agents`).

---

## 9. Decisiones técnicas

- **DT-1**: El filtro seguirá leyendo solo `computedReputation.score`, nunca `agent.reputation`. La razón de `discovery.ts:412-417` sigue siendo válida y no se toca en ninguna opción.
- **DT-2**: El filtro se queda donde está, antes del sort y del `slice`. Moverlo aguas abajo del recorte pone la precondición del residual TD-189-1 encima del camino del dinero (`discovery.ts:350-358` lo advierte explícitamente: NO MOVER).
- **DT-3**: Cualquier relajación se expresa en la **respuesta**, no solo en logs. Un consumidor que pidió piso tiene que poder detectar por contrato que no lo recibió.
- **DT-4**: Si se elige gracia (opción C), la variante por **cantidad de tareas** es preferible a la de calendario (§5, contra 2). El reloj penaliza al agente por falta de tráfico, que es la variable que no controla.
- **DT-5**: El caso de §1.6 (agente que vuelve a 0 por fallos tempranos) se trata aparte del caso "recién publicado". Comparten el síntoma pero no la causa: uno nunca entró, el otro entró y fue expulsado. Una política pensada solo para el primero deja al segundo sin salida.

---

## 10. Constraint directives

- **CD-1**: PROHIBIDO introducir un piso por defecto del lado del gateway, por env o por código, como parte de esta HU. Rompería AC-1 y convertiría en real la crítica que hoy es falsa.
- **CD-2**: PROHIBIDO que una relajación de piso quede fuera de la respuesta (AC-2). Sin excepción por "es solo un caso borde".
- **CD-3**: PROHIBIDO aceptar como entrada de reputación cualquier dato controlado por el agente puntuado o por un solo caller mas allá del cap `K` (AC-7).
- **CD-4**: PROHIBIDO habilitar un agente bajo el piso en un leg de desembolso a persona física sin control compensatorio explícito (AC-6).
- **CD-5**: Cualquier cambio en `reputation.ts` o `discovery.ts` requiere confirmar antes el valor de piso que usan hoy los consumidores de producción (§4, VERIFICAR). No se cambia a ciegas algo que hoy filtra plata real.

---

## 11. Tamaño

| Fase | Tamaño |
|---|---|
| Decisión de founder sobre §5 | 0 código |
| Solo AC-3 (observabilidad del excluido) | **S** (1 campo en `DiscoveryResult`, 1 contador en `discovery.ts`, tests de ruta) |
| Opción C variante por N tareas | **M** (persistencia del contador de gracia por agente, gate en el filtro, expiración) |
| Opción A carril con cupo | **M-L** (regla de elegibilidad, cupo, contrato de respuesta, antispam) |
| Opción D reputación importada | **L** (ancla de confianza, gobernanza de fuentes, lectura on-chain) |
| Opción F fianza | **L** (custodia del stake, cableado de slash contra el árbitro) |

---

## 12. Qué necesito del founder para cerrar F1

1. **Decisión sobre §2**: ¿la plataforma se hace cargo del resultado agregado de una perilla que publica y documenta pero no acciona? De esto depende que la HU siga o se cierre como "no es nuestro problema, es del consumidor".
2. **Decisión sobre §5**: cuál opción, o ninguna. Con el riesgo de §4 aceptado por escrito.
3. **Dato bloqueante**: qué piso setea hoy Chaski y sobre qué leg (§4, VERIFICAR). Sin eso no se puede dimensionar lo que se está relajando.
4. **Confirmación**: si el caso de §1.6 (agente expulsado tras fallos tempranos) entra en esta HU o se abre aparte.

---

## Anexo: cómo se verificó

Solo lectura, sin commits, sin cambio de rama, sin envs, sin migraciones, sin invocar endpoints.

- Filtro y orden: `src/services/discovery.ts:319-322`, `:404-428`, `:430-463`, `:494-501`
- Fórmula, cap y predicado de liquidación: `src/services/reputation.ts:37-49`, `:105-131`, `:140-160`
- Origen del piso: `src/routes/discover.ts:99`, `:159`; `src/services/capability-resolver.ts:100-101`, `:164`; `src/lib/compose-step-shape.ts:156-174`; `src/lib/discovery-query.ts:44-57`; `src/types/index.ts:430-437`
- Ausencia de default del gateway: barrido de `process.env.*` sobre `src/`; `src/services/orchestrate.ts` con 0 ocurrencias de `constraints` y `min_reputation`
- Defaults: `.env.example:826` (`REPUTATION_SCALE_FACTOR=50`), `.env.example:835` (`REPUTATION_MAX_TASKS_PER_CALLER=5`)
- Contrato público: `doc/INTEGRATION.md:246-257`, `:490`
