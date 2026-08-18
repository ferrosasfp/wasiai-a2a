# Implementation Log — WKH-360 / `223-coordinador-como-agente` (F3)

> Rama `feat/223-wkh-360-coordinador-agente`, base `3823580`. Un commit por wave.
>
> **Todo número de este documento fue MEDIDO, con el comando y el sha al lado.**
> Lo que no se pudo medir está marcado `[NO VERIFICADO]` y no se suaviza.

---

## 1 · Los seis commits

| Wave | sha | Qué entró |
|---|---|---|
| W0 | `23a27dd` | leaf `contracting-chain.ts` + tipos + las 2 envs |
| W1 | `879faa7` | el bucle DIRECTO en los CUATRO sitios de capa 1 |
| W2 | `6f252ad` | capa 2 (traza entrante), techo y propagación (AC-7) |
| W3 | `af9ef5a` | la carta + `well-known.test.ts` + doc de DT-1/DT-2 |
| W4 | `1015f90` | el fee en cascada (AC-10/AC-11/AC-12) + CD-21 |
| W5 | *(este commit)* | barrido de citas, batería completa, auto-blindaje, log |

---

## 2 · Criterio de salida por wave, con el número corrido

| Wave | `tsc` | `biome` | Suite (`Tests`) | Δ | ownership |
|---|---|---|---|---|---|
| base `3823580` | 0 | — | `5441 passed \| 19 skipped` · exit 0 | — | 13/13 |
| W0 | 0 | 0 (479) | ❌ `5497 passed \| 19 skipped` · exit 0 — **CIFRA FALSA, ver la fila de abajo** | +56 | 13/13 |
| **W0 · el número REAL de `23a27dd`** | 0 | 0 (479) | **`4 failed \| 5493 passed \| 19 skipped` · `suite_exit=1`** | — | 13/13 |
| W1 | 0 | 0 (482) | `5526 passed \| 19 skipped` · exit 0 | +29 | 13/13 |
| W2 | 0 | 0 (484) | `5561 passed \| 19 skipped` · exit 0 | +35 | 13/13 |
| W3 | 0 | 0 (485) | `5579 passed \| 19 skipped` · exit 0 | +18 | 13/13 |
| W4 | 0 | 0 (485) | `5594 passed \| 19 skipped` · exit 0 | +15 | 13/13 |

**Cero tests preexistentes movidos sin explicación**; los TRES que cambiaron de
aserción están documentados abajo (§5). El total neto vs el baseline está en §9, que
es donde vive el número vivo — acá quedó la foto de cada wave.

### ⚠️ La fila de W0: la cifra que el commit declara es FALSA (CR/BLQ-BAJO-1)

El mensaje del commit `23a27dd` dice `exit 0` y `5497 passed`. **Ese árbol tiene 4
rojos.** Re-medido de forma independiente en el fix-pack, en un worktree detached a
`23a27dd` con el `node_modules` de este árbol:

```
node ./node_modules/vitest/vitest.mjs run
  Test Files  1 failed | 280 passed | 6 skipped (287)
       Tests  4 failed | 5493 passed | 19 skipped (5516)     suite_exit=1
  FAIL test/readme-numbers.test.ts  (×4)
    expected 286 to be 287     (archivos de test)
    expected 477 to be 479     (archivos que linta Biome)
```

**Motivo, y ya estaba diagnosticado**: `auto-blindaje.md` §"mi verde de W0 era cierto
en el momento en que lo medí y falso un segundo después, por mi propio commit"
describe el mecanismo con precisión — `readme-numbers.test.ts` **re-deriva** el conteo
de archivos del repo, así que agregar los archivos de W0 invalidó los números que los
README publicaban, y eso pasó **después** de correr la suite y **antes** de commitear.
Lo que faltó fue corregir la cifra ya escrita.

**Resuelto en W1** (`879faa7` actualiza los dos README y la suite vuelve a exit 0);
verificado: desde W1 en adelante todas las filas dan `exit 0`.

⛔ **No se reescribió la historia.** El commit `23a27dd` queda como está y esta fila es
la corrección. Riesgo que deja abierto, y por eso se escribe: un `bisect`, un revert o
un merge parcial que se pare en `23a27dd` da CI **rojo** con un commit cuyo mensaje
dice estar verde.

Comandos (sin pipes para adjudicar, CD-13):

```bash
./node_modules/.bin/tsc --noEmit; echo "tsc_exit=$?"
node ./node_modules/vitest/vitest.mjs run > /tmp/x.txt 2>&1; echo "suite_exit=$?"
node ./node_modules/vitest/vitest.mjs run test/ownership-filter-guard.test.ts
```

---

## 3 · La batería de mutación: 18 corridos, 18 muertos

**Protocolo**: suite COMPLETA por mutante, aguja verificada `== 1`, sustitución
verificada por **texto resultante**, respaldo por copia + restauración verificada con
`md5sum`, `git status --short` completo al final de cada uno. El harness **aborta sin
emitir veredicto si `tsc` no da 0** (ver §6, error de W1).

### 3.1 · Calibración (corridos PRIMERO, contra el árbol base)

| ID | Mutación | Esperado | Medido |
|---|---|---|---|
| `CAL-MUERE` | `PLACEHOLDER_FEE_USD` `1.0`→`2.0` | tiene que MORIR | **MUERE** (MEDIDO: exit=1, 51 rojos, en `3823580`) |
| `CAL-VIVE` | comentario al final de `compose-limits.ts` | tiene que VIVIR | **VIVE** (MEDIDO: exit=0, 0 rojos, en `3823580`) |

⇒ el instrumento distingue, así que los veredictos de abajo valen.

### 3.2 · Los 16 obligatorios

| # | Mutación | Medido | Testigos |
|---|---|---|---|
| `MUT-01` | mover el guard del **Sitio 3** debajo del débito per-step | **MATA** (exit=1, **2** rojos, en `879faa7`) | `T-L1-2`, `T-L1-2b` — mueren por el **conteo de débitos**, no por el status |
| `MUT-02` | mover el guard del **Sitio 1** al route handler (post-débito) | **MATA** (exit=1, **6** rojos, en `879faa7`) | los 6 `it` de orden del Sitio 1. ⚠️ **el 400 sale igual bajo el mutante**: un test de status habría sobrevivido |
| `MUT-03` | mover el guard del **Sitio 2** después del `debitRes` | **MATA** (exit=1, **2** rojos, en `879faa7`) | `T-L1-3`, `T-L1-3b` |
| `MUT-04` | `Number.parseInt` en lugar del regex de profundidad | **MATA** (exit=1, **9** rojos, en `6f252ad`) | `T-U-DEPTH-3/4/5/6`, `T-U-MAX-7`, `T-DEPTH-2/3/4`, `T-CHAIN-1-ORDEN` |
| `MUT-05` | `Number()` en lugar del regex | **MATA** (exit=1, **9** rojos, en `6f252ad`) | los mismos 9 |
| `MUT-06` | borrar el strip del punto final (paso 7) | **MATA** (exit=1, **9** rojos, en `879faa7`) | testigos en las TRES capas: leaf, Sitio 1 y Sitio 2 |
| `MUT-07` | comparar `url.host` (con puerto) en vez de `url.hostname` | **MATA** (exit=1, **2** rojos, en `879faa7`) | `T-U-SELF-1`, `T-L1-5` |
| `MUT-08` | `?? Number.POSITIVE_INFINITY` en el techo | **MATA** (exit=1, **6** rojos, en `6f252ad`) | `T-U-MAX-1`, `T-ENV-2b/3`, `T-DEPTH-1/6`, `T-DEPTH-1-ORDEN` |
| `MUT-09` | chequeo de largo **después** del `split` | **MATA** (exit=1, **1** rojo, en `6f252ad`) | ⚠️ **TESTIGO ÚNICO**: `T-CHAIN-1-SPY`. Anotado en el testigo |
| `MUT-10` | `>` en lugar de `>=` en el techo | **MATA** (exit=1, **6** rojos, en `6f252ad`) | `T-U-CEIL-1`, `T-U-MAX-6`, `T-DEPTH-1/5/6`, `T-DEPTH-1-ORDEN` |
| `MUT-11` | invertir el predicado de identidad (**control negativo**) | **MATA** (exit=1, **25** rojos, en `879faa7`) | rompe hasta el e2e del camino feliz ⇒ los gemelos positivos son load-bearing |
| `MUT-12` | leer el sobre del fee **después** del colapso `data.result ?? data` | **MATA** (exit=1, **2** rojos, en `1015f90`) | `T-FEE-4`, `T-FEE-5`. ⚠️ la 1ª versión daba 178 rojos **por un TypeError**: mutante corregido (§6) |
| `MUT-13` | `usdc: 0` cuando el coordinador no declara | **MATA** (exit=1, **3** rojos, en `1015f90`) | `T-U-FEE-3`, `T-U-FEE-4`, `T-FEE-5` |
| `MUT-14` | reportar `feeUsdc` en la rama `skipped` | **MATA** (exit=1, **1** rojo, en `1015f90`) | ⚠️ **TESTIGO ÚNICO**: `T-FEE-2wkh`. Anotado en el testigo |
| `MUT-15` | headers de la traza **después** del spread de credenciales | **MATA** (exit=1, **1** rojo, en `6f252ad`) | ⚠️ **TESTIGO ÚNICO**: `T-PROP-3`. Anotado en el testigo |
| `MUT-16` | emitir la cadena sin `canonicalId` | **MATA** (exit=1, **2** rojos, en `6f252ad`) | `T-U-OUT-3`, `T-PROP-2` |

**Los TRES mutantes de testigo único (`MUT-09`, `MUT-14`, `MUT-15`) llevan la
anotación EN EL TESTIGO** (no sólo acá), con el número medido y el aviso de que
refixturear su input lo apaga igual que borrarlo (CD-22 / §11.1 regla 7).

---

## 4 · CD-11 · Barrido de citas, re-medido por CONTENIDO

Corrido después de la última edición, comparando `HOY[n]` contra `BASE[n]` por el
**texto de la línea**, no por aritmética.

**Resultado principal: TODA cita del Story File hacia un archivo que esta HU NO tocó
sigue siendo exacta.** Verificado uno por uno:

| Archivo (no tocado) | Citas verificadas | Estado |
|---|---|---|
| `src/adapters/registry.ts` | `:522`, `:532` | **sin mover** |
| `src/lib/self-published-auth.ts` | `:82`, `:89`, `:105`, `:115` | **sin mover** |
| `src/lib/compose-limits.ts` | `:38` | **sin mover** |
| `src/lib/pricing-constants.ts` | `:16` | **sin mover** |
| `src/services/fee-charge.ts` | `:106`, `:133`, `:428`, `:432` | **sin mover** |
| `src/middleware/a2a-key.ts` | `:187`, `:1222`, `:1231` | **sin mover** |
| `src/routes/capabilities.ts` | `:33`, `:65`, `:70` | **sin mover** |

**Seis citas apuntan a contenido que YA NO EXISTE, y las seis son exactamente las
líneas que la HU tenía que reescribir** (o sea que es confirmación, no daño):

| Cita del Story File | Qué le pasó |
|---|---|
| `src/services/compose.ts:617`, `:968` | los dos call-sites de `invokeAgent`, ahora con el 6.º argumento (AC-7) |
| `src/routes/compose.ts:1050`, `:1053` | la prosa *"ningún campo de fee se serializa"* — **reescrita por CD-21** |
| `src/routes/compose.ts:1127` | el `reply.send({kiteTxHash, ...result})`, ahora con los campos de fee (AC-10) |
| `src/services/agent-price.ts:114` | el `return` de `resolveAgentDestination`, ahora con `invokeUrl` |

**Mapa de navegación** de los archivos tocados.

⛔ **ESTE MAPA YA NO TIENE NÚMEROS DE LÍNEA DE DESTINO, Y ES A PROPÓSITO.** La versión
anterior los tenía y **estaba mal en 3 de las 5 filas de `src/types/index.ts`, todas
por exactamente +11** (AR/BLQ-BAJO-2). Peor: cuando el fix-pack recomputó los valores
que el AR había corregido, **volvieron a estar mal**, porque el propio fix-pack
desplazó las líneas otra vez. Un número de destino en un `.md` es un dato que envejece
con cada edición del código que describe, y su modo de falla es
**auto-confirmante**: el destino equivocado casi siempre muestra prosa plausible.

Por eso la columna de destino es el **ANCLA TEXTUAL**: se busca ese texto y listo.

| Archivo | Cita del Story File | Ancla textual (buscar esto) |
|---|---|---|
| `src/types/index.ts` | `:374` | `export interface Agent {` |
| | `:989` | `export interface ComposeRequest {` |
| | `:1027` | `POR QUÉ ES UN INPUT Y NO UN CAMPO DEL` |
| | `:1091` | ⚠️ **reescrita** — era el `errorCode?:` de una línea; hoy es una unión multilínea con los dos códigos nuevos |
| | `:1144` | `export interface StepResult {` |
| | `:1398` | `discoveredAgents: Agent[];` |
| | `:1673` | `export interface AgentSkill {` |
| | `:1679` | `export interface AgentCard {` |
| `src/services/compose.ts` | `:334` | `for (let i = 0; i < steps.length; i++) {` |
| | `:376` | ⚠️ **AMBIGUA** — la línea base es `}`, que aparece 10 veces. Sin ancla útil |
| | `:1424` | `const headers: Record<string, string> = {` |
| | `:1516` | `const response = await ssrfFetch(agent.invokeUrl, {` |
| | `:1538` | `const data = (await response.json()) as Record<string, unknown>;` |
| `src/routes/compose.ts` | `:688` | `async function resolveComposePriceHandler(` |
| | `:867` | `...requirePaymentOrA2AKey(` |
| | `:1132` | `export default composeRoutes;` |
| `src/services/orchestrate.ts` | `:1061` | `async executeApprovedPlan(` |
| | `:1115` | ⚠️ **AMBIGUA** — `}`, 22 ocurrencias |
| | `:1149` | `const debitRes = await budgetService.debit(` |
| | `:1213` | `const pipeline = await composeService.compose({` |
| `src/routes/orchestrate.ts` | `:137` | ⚠️ **AMBIGUA** — `preHandler: [`, 3 ocurrencias (las tres rutas) |
| | `:806` | `error_code: 'QUOTE_STALE',` |
| `src/index.ts` | `:173` | ⚠️ **AMBIGUA** — `fastify.log.info(`, 2 ocurrencias |
| | `:271` | `await fastify.register(discoverRoutes, { prefix: '/discover' });` |

Las cinco filas marcadas ⚠️ **AMBIGUA** son exactamente el modo de falla que la
advertencia vieja describía y que el mapa viejo igual publicaba como si fueran
destinos ciertos: la línea de la cita es contenido genérico (`}`, `preHandler: [`), así
que **ninguna herramienta puede decir a cuál se refería**. Se dejan marcadas en vez de
resolverlas a ojo.

Comando con el que se derivó esta tabla (compara `git show 3823580:<archivo>` contra el
archivo de hoy por TEXTO EXACTO de la línea, y reporta 0, 1 o N coincidencias):
`node -e` con `execSync('git show 3823580:'+f)` — ver el commit del fix-pack Grupo 6.

---

## 5 · Tests preexistentes cuya ASERCIÓN cambió (los tres, con su motivo)

Ninguno se borró. Los tres se **re-apuntaron**, y en los tres la inversión **es el
objeto de un AC**, no daño colateral:

| Test | Afirmaba | Por qué cambió |
|---|---|---|
| `agent-card.test.ts` → *"sets empty auth schemes"* | `schemes` `toEqual([])` | **AC-1b** exige que la carta declare con qué se le paga. Re-apuntado a "`bearer` SIEMPRE y el conjunto DERIVADO" |
| `routes/agent-card.test.ts` → *"returns 200 with gateway self AgentCard"* | `schemes` `toEqual([])` | ídem |
| `routes/compose.fee.test.ts` → `T-FEE-8` | `not.toHaveProperty('protocolFeeUsdc')` | **AC-10** exige que el fee sea visible; era el hueco #3 de la HU. ⚠️ **sus otras dos aserciones se conservaron**, y la del `feeChargeTxHash` es load-bearing (el hash del fee NO se serializa nunca) |

Además se editaron **4 fixtures** que devuelven `resolveAgentDestination`
(CD-22, re-contado: `MUT-02` da **6** rojos post-edición, sin caso de testigo único).
El Story File listaba 3; **el cuarto** (`src/services/agent-price.test.ts`,
`T-DEST-1/2/3`) **no estaba** porque rompe en RUNTIME (`toEqual` exacto) y no en
`tsc` — ver §6.

---

## 6 · Desviaciones y hallazgos que AR/CR tienen que juzgar

1. **El canal de corte del Sitio 2 NO es el que el Story File prescribe.** §4.2 pedía
   el patrón `__quoteStale` (miembro nuevo en la unión de retorno). Medido, eso fuerza
   narrowing en **6 call-sites de producción en 5 archivos, y 3 de esos archivos no
   están en el Scope IN** (`services/agent-link.ts`, `services/inbound-task.ts`,
   `mcp/tools/orchestrate.ts`). Se usó `pipeline.errorCode` + mapeo a **400** en las
   dos rutas de ejecución: **1 archivo, dentro del Scope IN**, y reusa el mecanismo que
   el repo ya tiene (`pipeline.errorCode === 'SCOPE_DENIED' → 403`). **El ORDEN no
   cambia** y `MUT-03` lo confirma. §16.15 del Story File deja esta forma abierta.
2. **Un 5.º sitio de mock que el Story File no lista** (§3.6 lista 3 + 1 factory):
   `src/services/agent-price.test.ts` `T-DEST-1/2/3` hacen `toEqual` **exacto** sobre
   el retorno, así que rompen en runtime con `tsc` en verde.
3. **`readContractingGuardHealth()` y `rollUpCascadedFee()` son exports del leaf que
   §3.1 no enumera.** Se agregaron porque `/health` está **duplicado** (prod + e2e) y
   el rollup tiene **tres** call-sites: en los dos casos, dos expresiones a mano
   divergen. Ningún export de §3.1 fue renombrado ni removido.
4. ~~**`A2A_CONTRACTING_DEPTH_MAX=0` es legible y cierra el servicio**~~ — **RESUELTO
   en el fix-pack (§9, Grupo 3). El AR lo RECHAZÓ y su veredicto prevalece sobre el
   del CR, que lo había ratificado.** Se había implementado el rango `[0,64]` que
   especifica el Story File, con la consecuencia sólo DOCUMENTADA. Hoy `0` **cae al
   default y avisa**; rango aceptado `[1,64]`. Ver §9.
5. **Asimetría deliberada en el parseo de la profundidad**: la ENV se `trim`ea y el
   HEADER no. CD-14 aplica al header (lo controla un tercero); la env la escribe el
   operador. Fijada con `T-U-MAX-7` para que nadie las "unifique por consistencia".

---

## 7 · Lo que esta HU NO cierra

⛔ **Ninguna de estas líneas puede leerse como cerrada, ni acá ni en ningún otro
texto de la HU.**

- **El bucle transitivo contra un adversario que borra los headers.** La capa 2 es
  **best-effort por construcción**, y eso está escrito en el código, en el body del
  error (`CONTRACTING_LAYER2_BEST_EFFORT_NOTE`) y en la Agent Card. Contra ese caso lo
  que queda en pie es la capa 1 (que **no consulta ningún header del caller**) y el
  techo de profundidad.
- **⚠️ Y la capa 2 nace con cobertura efectiva ~0 EN EL CAMINO REAL**, que no es lo
  mismo que lo de arriba (AR/MNR-5): **22 de los 25 agentes de prod viven en
  `wasiai-v2`**, que nos llama y **no reenvía** los headers. No es un adversario: es la
  topología de hoy. La HU de seguimiento va **en `wasiai-v2`** y está enunciada con su
  criterio de aceptación en `doc/decisions/2026-08-17-coordinador-como-agente-publicacion.md` §5.
  ⛔ Hasta entonces, prohibido escribir que la capa 2 "cubre" el ecosistema.
- **La capa 1 en los caminos NO-HTTP.** El `hint` del fix-pack (Grupo 1) llega a los
  cuatro sitios **por HTTP**. El tool MCP (`src/mcp/tools/orchestrate.ts`) y
  `src/services/inbound-task.ts` llaman al service in-process, sin `FastifyRequest` y
  por lo tanto sin `Host` que pasar: para esos dos el guard depende **sólo** de
  `BASE_URL` / `A2A_SELF_HOSTS`. Congelado en `T-L1+6`, `T-L1+9` y `T-PROP-2`.
  ⚠️ **Esta línea enumeraba mal, y así estuvo escrita en seis lugares** (AR-it2 /
  BLQ-MED-1): había un TERCER caller **HTTP** sin hint,
  `POST /agents/links/:token/redeem` (público, `routes/agent-links.ts`) →
  `services/agent-link.ts` → `executeApprovedPlan`, que con las dos envs ausentes
  reproducía byte por byte el escenario que `T-L1-2c` congela como cerrado, y donde
  **el bucle lo paga el que emitió el link**, no el caller anónimo. Cableado en el
  fix-pack 2. ⛔ Lo que impide la próxima recurrencia **no es esta lista**: es
  `T-HINT-CALLSITES` (`src/lib/contracting-chain.test.ts`), que enumera los
  call-sites de producción de `orchestrate`/`executeApprovedPlan`/`compose` y se cae
  cuando aparece uno nuevo sin `selfHostHint` que no tenga excepción escrita.
  Testigos del cableado nuevo: `T-L1-2f`, `T-L1-2g`, `T-L1-2h`.
- **Los ALIAS propios sin `A2A_SELF_HOSTS`.** El `Host` entrante cubre el host por el
  que entró la petición y ningún otro. Setear la env es **paso del deploy**.
- **El eslabón que ANUNCIAMOS sin configuración.** Sin las dos envs, el `canonicalId`
  sale del `Host`, que el caller influye. El argumento de monotonía **no aplica acá**
  (aplica al conjunto de negación); está escrito en `resolveSelfHosts` y medido en
  `T-PROP-5`. ⚠️ Y ese eslabón **puede nombrar a un tercero**: sale en el header que
  emitimos NOSOTROS hacia agentes ajenos, o sea una afirmación sobre nuestra
  identidad, firmada por nosotros, con contenido elegido por el caller.
- **⚠️ SIN LAS DOS ENVS, EL CALLER NO AGRANDA EL CONJUNTO: LO DEFINE, Y PUEDE
  VACIARLO** (AR-it2 / BLQ-MED-2). La monotonía que hace admisible el `hint` está
  escrita como propiedad de seguridad en seis lugares y **sólo vale en el caso
  CONFIGURADO** — `T-L1-2d`, que la congela, setea `A2A_SELF_HOSTS` en su primera
  línea. Sin envs `hosts` es literalmente `[canonicalizeHost(hint)]`, así que el
  enunciado es cierto y la garantía es vacía. Medido: `resolveSelfHosts('a b')`,
  `('http://x')`, `('::1')` y `('')` ⇒ `hosts: []` y `canonicalId: null`, o sea el
  guard **inerte a pedido**; y medido con fastify en este árbol, `Host: a b` ⇒
  `request.hostname === 'a b'` con `trustProxy` en `false` **y** en `true` (con
  `true` entra además por `X-Forwarded-Host`). ⛔ La conclusión **no es revertir el
  hint**: sin él ese mismo deploy queda inerte SIEMPRE, no sólo bajo ataque. Lo que
  el hint cubre es el bucle **accidental**; lo que cierra el hostil es setear
  `A2A_SELF_HOSTS`. Testigo: `T-L1-2e`.
- **El bypass por IP literal.** La comparación de identidad es **por NOMBRE**. R-3 /
  TD-360-2, residual declarado.
- **Que hoy haya drenaje de fondos en curso.** Lo medido es que **el guard no
  existía** y que la ruta al bucle estaba abierta. Lo que frena hoy el caso directo es
  **accidental** (el bearer sólo se reenvía a registries system-trusted), no un guard.
- **El bucle de DISCOVERY** (registrar el propio `/discover` como registry). Vector
  real y contiguo, **no cubierto acá**. Candidato a WKH-361.

---

## 8 · `[NO VERIFICADO]`

- **`BASE_URL` en el Railway de prod** (NC-1). No se puede distinguir desde afuera.
  El diseño no depende de la respuesta (conjunto vacío ⇒ `warn`, no `throw`), y
  `GET /health` → `contractingGuard.selfHostCount` lo resuelve **después del deploy**.
- **`TRUST_PROXY` en prod** (NC-2). ⚠️ **Esta línea decía que sólo afecta la
  narrativa del DoS colateral, y quedó FALSA** (AR-it2 / BLQ-MED-2): con
  `trustProxy` activo `request.hostname` sale de **`X-Forwarded-Host`**, que es el
  `selfHostHint` del guard, así que la env es parte de la **superficie de ataque**
  del guard y no sólo del rate-limit. Lo medido en este árbol con fastify matiza el
  hallazgo en la dirección **peor**: `Host: a b` ⇒ `request.hostname === 'a b'` con
  `trustProxy` en `false` **también**, o sea que el vaciado del conjunto **no
  depende de `TRUST_PROXY`** — esa env agrega un segundo header por donde entra, no
  el agujero. Sigue sin verificarse su valor en prod, y ahora la respuesta importa
  para dos cosas, no una.
- **El comportamiento en PRODUCCIÓN de todo lo de esta HU.** Nada se ejecutó contra
  prod salvo `POST /discover` (gratis y read-only) y `GET /.well-known/agent.json`.
  ⛔ No se invocó `/compose` ni `/orchestrate` contra prod: mueven plata.
- **Los catálogos externos de NC-4.** Ninguna fila verificada, ninguna aprobada.

---

## 9 · Fix-pack post AR/CR (2026-08-17)

AR y CR **rechazaron**. Los dos coincidieron en que el núcleo está sano —los tres
cortes pre-débito son reales y los dos revisores los re-midieron por separado— y en
que lo que bloqueaba eran **controles y frases que no medían lo que decían**. Ningún
hallazgo tocaba el orden respecto del dinero, y **el fix-pack tampoco lo cambia**.

### 9.1 · Un commit por grupo

| Grupo | sha | Qué entró |
|---|---|---|
| 2 | `84051dd` | `readCoordinatorFee` tiraba `TypeError` sobre un 200 con body escalar, **después del débito** |
| 3 | `8157f32` | `A2A_CONTRACTING_DEPTH_MAX=0` apagaba el money-path, legible y en silencio |
| 1 | `f7661e1` | el guard quedaba INERTE sin config; el `Host` entrante viaja como `hint` a los 4 sitios + las 4 frases calificadas |
| 4 | `72ae303` | el rollup fabricaba un `0` con status `complete` y podía publicar `null` |
| 5 | `8b1d07a` | cuatro controles que no controlaban (`/health`, `GUARD_SOURCES`, el grep de CD-14, conteos de filas) |
| 6 | *(este commit)* | números y frases que envejecieron, más la HU de seguimiento de `wasiai-v2` |

### 9.2 · Criterio de salida, corrido en cada commit

| Grupo | `tsc` | `biome` | Suite (`Tests`) | Δ |
|---|---|---|---|---|
| entrada (`71fdaf7`) | 0 | 0 (485) | `5594 passed \| 19 skipped` · exit 0 | — |
| 2 (`84051dd`) | 0 | 0 (485) | `5597 passed \| 19 skipped` · exit 0 | +3 |
| 3 (`8157f32`) | 0 | 0 (485) | `5598 passed \| 19 skipped` · exit 0 | +1 |
| 1 (`f7661e1`) | 0 | 0 (485) | `5605 passed \| 19 skipped` · exit 0 | +7 |
| 4 (`72ae303`) | 0 | 0 (485) | `5608 passed \| 19 skipped` · exit 0 | +3 |
| 5 (`8b1d07a`) | 0 | 0 (485) | `5612 passed \| 19 skipped` · exit 0 | +4 |
| 6 (este) | 0 | 0 (485) | `5613 passed \| 19 skipped` · exit 0 | +1 |

**+19 tests netos sobre `71fdaf7`; +172 sobre el baseline `3823580`.** Archivos de
test: **292** en los siete commits (los `it` nuevos entraron en archivos existentes,
así que `readme-numbers.test.ts` no se movió).

### 9.3 · Mutantes del fix-pack — 8 corridos, 8 muertos

Protocolo: sustitución verificada **por el texto resultante**, aguja verificada `== 1`,
restauración verificada con **`md5sum -c`** y `git status --short` al final de cada
uno. Ningún archivo se editó mientras una batería medía.

| ID | Mutación | Medido | Testigos |
|---|---|---|---|
| `FP-01` | sacar el guard de tipo de `readCoordinatorFee` | **MATA** (2 rojos) | `T-U-FEE-5` (texto: el `TypeError` literal), `T-FEE-7` (texto: `expected false to be true`, con `debit` en 1) |
| `FP-02` | quitar el `hint` de los **services** (Sitios 2 y 3) | **MATA** (3 rojos) | `T-L1-2c` y `T-L1-3c` mueren por `debit: not called ⇒ called 1 times`; `T-PROP-5` por `expected undefined` |
| `FP-03` | quitar el `hint` de los **routes** | **MATA** (2 rojos) | `T-L1+10`, `T-ROUTE-HINT` — el cableado, que los de arriba NO cubren |
| `FP-04` | restaurar el gate viejo del rollup (`sum === 0 && anyUndeclared`) | **MATA** (2 rojos) | `T-U-ROLL-5`, `T-U-ROLL-6` |
| `FP-05` | quitar el techo del monto en `readCoordinatorFee` | **MATA** (1 rojo) | `T-U-FEE-7` |
| `FP-06` | borrar el campo `contractingGuard` del handler de `e2e/setup.ts` | **MATA** (2 rojos) | `T-HEALTH-CONTRACTING` ×2. **Es la mutación exacta del CR**, que en `71fdaf7` daba `5594 passed, cero rojos` |
| `FP-07` | borrar el campo `contractingGuard` del handler de **prod** (`index.ts`) | **MATA** (1 rojo) | `T-HEALTH-BOTH` — el handler de prod no es importable, así que este barrido textual es lo único que lo cubre |
| `FP-08` | poner un `=== 'true'` en `middleware/contracting-guard.ts` | **MATA** (1 rojo) | `T-FLAG-1`. **Es la calibración inversa del AR**, que con `GUARD_SOURCES` de un solo path seguía en verde |

Más dos calibraciones que **cambiaron un testigo** en vez de aceptarlo:
`Number(rawDepth)` en el paso 4 mata `T-CD14-SWEEP` (el candado de CD-14, que antes
del fix-pack no discriminaba), y el escalar movido del step 0 al step 1 en `T-FEE-7`
(ver `auto-blindaje.md`: moría por la razón barata).

### 9.4 · Lo que NO se hizo, y por qué

- **`it.each` (CR/MNR-5, segunda mitad).** Los 8 bucles de casos ahora asserten la
  cantidad de filas, que es la propiedad que faltaba (borrar una fila pone rojo).
  Convertirlos a `it.each` renombra y multiplica los `it` **que los reportes de AR y CR
  citan por nombre**, a cambio de nada más. Declarado, no hecho.
- **Cerrar R-3 / la IP literal.** Sigue abierto. El fix-pack sólo hizo que la forma
  IPv6 que la doc recomendaba **no voltee el arranque** (AR/MNR-1).
- **Cerrar el transitivo.** Sigue abierto, y ahora está escrito que en el camino real
  la Capa 2 nace con cobertura efectiva ~0 (§7).
- **Un cache para el lookup del Sitio 2.** Se corrigió la FRASE (decía "cache de 60 s"
  y ese cache no cubre ese camino); el lookup sigue yendo fresco a propósito, con el
  costo real escrito y el fail-closed decidido y medido (`T-L1-3d`).
