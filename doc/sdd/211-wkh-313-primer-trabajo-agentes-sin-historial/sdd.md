# SDD — WKH-313 · El primer trabajo de un agente que no es nuestro

**Fase**: F2 (diseño). NO hay código de producción en este artefacto.
**Repo**: `wasiai-a2a` · worktree `/home/ferdev/.openclaw/workspace/wt-313` · rama `feat/211-wkh-313-primer-trabajo`
**Repo secundario** (entrega separada, un escritor por repo): `chaski-v3`
**Input**: `work-item.md` (§1-§12) de esta misma carpeta
**Fecha de verificación**: 2026-07-29
**Decisión del founder ya tomada**: *oportunidad provisoria* (variante de la Opción C del work-item, por **cantidad de trabajos**, no por calendario). Descartados explícitamente: pagarles invocaciones desde nuestra billetera como mecanismo general, y que `verified` sustituya al historial.

---

## 0. Medición en vivo (no es teoría)

Medido con `GET /discover` (gratis, sin auth de pago) contra
`https://wasiai-a2a-production.up.railway.app`, 2026-07-29, vía `python3+urllib`:

| capability | total | agente | `verified` | `computedReputation` | `identity` | precio |
|---|---|---|---|---|---|---|
| `remittance-payout` | 1 | `remit-cashout-payout-solana` | `false` | **ausente (nunca trabajó)** | ausente | 0.03 |
| `remittance-fx-quote` | 1 | `remit-corridor-fx-solana` | `false` | `score 7` (5 settled, rate 0.71) | ausente | 0.03 |
| `kyc-verification` | 1 | `remit-kyc-validator` | `false` | `score 2` (1 settled, rate 1.00) | ausente | 0.02 |

`GET /discover?capabilities=remittance-payout&verified=true` → `total 0`.
`GET /discover?query=remit&limit=50` → **3** agentes en total, uno por leg, **ninguno `verified`**, **ninguno con `identity`**.

Aritmética confirmada leyendo el código (`reputation.ts:144-160`): `score = round(min(tasksSettled/F,1) × 100 × successRate)`, `F=50` por defecto (`reputation.ts:36-40`). 1 tarea liquidada ⇒ **2**. 0 tareas liquidadas ⇒ `computeFromAccumulator` retorna `null` (`reputation.ts:147`) ⇒ el slug **no entra** al Map del batch ⇒ el filtro lo cuenta 0 (`discovery.ts:424-427`) ⇒ **excluido con cualquier piso > 0**. No tiene puntaje: no tiene *nada*.

**Consecuencia sobre la demo insignia**: `chaski-v3` manda `constraints.min_reputation = 2` en los DOS legs de payout (`app/api/payout/prepare/route.ts:243` y `app/api/a2a/payout/submit/route.ts:390`, constante en `src/infrastructure/a2a/gateway-client.ts:29`). El único agente que sirve `remittance-payout` está en score-nada ⇒ `resolveCapability` devuelve `no_candidates` (`capability-resolver.ts:130-136`) ⇒ 422 ⇒ el cliente lo traduce a `no_agent_match` (`gateway-client.ts:136`) ⇒ 502 opaco. **El leg que entrega la plata no resuelve.** Los otros dos legs no mandan piso (`app/api/a2a/quote/route.ts:47-50` sin `constraints`; el leg de KYC no pasa por este cliente).

### Dos precisiones que cambian cómo se cuenta el daño (y que hay que decir en voz alta)

1. **Lo que está caído es el camino "sobre los rieles A2A", no necesariamente el flujo en producción hoy.** El transporte por gateway está detrás de `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER === "a2a-gateway"` (`prepare/route.ts:238`); con el flag apagado corre la rama punto-a-punto que invoca `remit-cashout-payout` por URL fija (`prepare/route.ts:264`). El propio `chaski-v3/doc/sdd/_INDEX.md:677-690` documenta: *«El flag se entrega APAGADO y hoy NO se puede encender»*, y el bloqueo que cita es **exactamente este**. **No pude determinar** el valor de esa env en producción (no leo envs de prod). Si está apagada, lo caído es la capacidad de encenderla — que es justo lo que se muestra la semana que viene.
2. **El leg de KYC está a un fallo de romperse igual.** `remit-kyc-validator` tiene score **2** = exactamente el piso. Con 1 success y 1 failed: `successRate = 0.50`, `score = round(1/50×100×0.5) = 1` ⇒ **por debajo de cualquier piso de 2**. Hoy ese leg no manda piso, así que no lo sufre; el día que alguien se lo ponga, el mismo lazo se cierra sobre un agente que **sí** trabajó. Es el caso §1.6 del work-item, vivo, medible, en el flujo insignia.

---

## 1. Correcciones al work-item (verificadas, y cambian el diseño)

El work-item §3 afirma que `verified` tiene **salida self-service**: «un agente que queda afuera de `verified=true` puede bindear su identidad ERC-8004 on-chain y entrar». **Eso no es lo que hace el código.**

- `verified` sale del **card que auto-reporta el registry**: `discovery.ts:676` → `Boolean(getNestedValue(raw, mapping.verified ?? 'verified') ?? false)`.
- Para agentes **self-published** está **hardcodeado en `false`**: `src/services/agent.ts:141` (`verified: false`), sin ninguna rama que lo levante.
- El binding ERC-8004 verificado on-chain **no toca `verified`**: `attachIdentities` sólo asigna `a.identity` (`discovery.ts:528`). Son dos campos distintos.

Tres consecuencias duras:

1. **`verified` es un dato controlado por la parte filtrada** (el registry declara el booleano en su propio card), o sea el mismísimo defecto que el código rechaza por escrito para `agent.reputation` (`discovery.ts:412-417`) — y encima es la **PRIMERA** clave del sort (`discovery.ts:456-457`). Un agente de un registry que declare `verified:true` le gana a cualquier self-published, sin importar su reputación. No es alcance de esta HU, pero queda escrito (§9 residual R-3).
2. **`verified` NO puede ser el control compensatorio ni un requisito de elegibilidad del carril de estreno**: los tres agentes del flujo insignia son self-published y por construcción no pueden tenerlo. Exigirlo rompería los tres legs, no arreglaría ninguno. Sería teatro.
3. El ancla de identidad **que sí es no-forjable y sí es alcanzable sola** es `Agent.identity` (ERC-8004, contrato bidireccional de tres anclajes descrito en `types/index.ts:329-339`). Hoy **ninguno** de los tres agentes la tiene (medido). Es el candidato correcto para endurecer la elegibilidad más adelante, no hoy.

---

## 2. Context Map — qué leí y qué extraje

| Archivo (verificado con Glob/Read) | Por qué | Qué extraje |
|---|---|---|
| `src/services/discovery.ts:299-503` | Es el pipeline entero | Orden exacto: blocklist → status → verified → caps → q → maxPrice → scope → `attachReputations` → **minReputation** → sort → `slice`. `excluded:{scope}` se arma en `:501`. `total` es pre-slice (`:494`) |
| `src/services/discovery.ts:347-366` | Advertencia "NO MOVER" | El filtro debe quedar **pre-sort**; moverlo abajo del `slice` pone TD-189-1 encima del camino del dinero |
| `src/services/discovery.ts:404-428` | El filtro a modificar | Sólo `computedReputation.score`, fail-safe a 0; el punto exacto donde entra la admisión de estreno |
| `src/services/discovery.ts:430-463` | El ranking a **no** romper | `repValue` (con fallback `?? x.reputation`), sort verified→rep→precio→tiebreak aleatorio sembrado |
| `src/services/discovery.ts:516-554` | `attachIdentities` / `attachReputations` | `identity ≠ verified`; el batch es **1 query** y su fallo se traga con `catch {}` → hoy "sin dato" y "sin historial" son indistinguibles |
| `src/services/discovery.ts:676` | Origen de `verified` | Auto-reportado por el registry |
| `src/services/reputation.ts:94-171` | La fórmula y el cap | `settledByCaller` + `min(n,K)`; `null` si `tasksSettled === 0`; `successCount`/`failedCount` viven en el accumulator y **hoy se descartan** |
| `src/services/reputation.ts:228-276` | El batch | Un solo `.in('agent_id', slugs)`; error ⇒ **Map vacío** (idéntico a "nadie tiene historial") |
| `src/services/capability-resolver.ts:86-137` | El camino de `/compose` | Mapea `constraints.min_reputation` → `query.minReputation`; toma `agents[0]`; `reason` sólo distingue `no_candidates` vs `excluded_by_scope` |
| `src/lib/compose-step-shape.ts:128-177` | Allowlist de constraints | `new Set(['max_price_usdc','min_reputation'])`; clave desconocida ⇒ 400. Acá hay que agregar la nueva clave, si no el caller recibe 400 |
| `src/lib/discovery-query.ts:44-57`, `:107-112` | Validación de input | Patrón de parser leaf + error tipado + 400. Modelo para el parser del flag nuevo |
| `src/routes/discover.ts:79-177` | GET y POST | Dos puntos de entrada que hay que tocar en simetría (el POST se olvida fácil) |
| `src/types/index.ts:303-322`, `:350-388`, `:429-438` | Contratos públicos | `AgentReputation`, `DiscoveryQuery`, `DiscoveryResult.excluded`, `ComposeStepConstraints` |
| `src/services/agent.ts:125-149`, `:429-440` | Self-published | `verified:false` hardcodeado; `listAsAgents` hace `select('*')` (trae `owner_ref`) pero `mapRowToAgent` **no lo surfacea** |
| `supabase/migrations/20260703000000_wkh134_a2a_agents.sql:20-40` | Ancla anti-sybil | `a2a_agents(slug PK, owner_ref NOT NULL, created_at, enabled)` + índice por `owner_ref`. RLS deny-by-default |
| `src/services/discovery.minreputation.test.ts` (249 líneas) | Exemplar de test | Mocks de `registry`/`reputation`/`agent`/`identity`, helper `rep(score)`, `serve(rows)`. **T-8 (`:218-228`)** es el hallazgo clave: batch degradado ⇒ nadie pasa |
| `doc/INTEGRATION.md:245-259` | Contrato público | Ahí está escrito «An agent with no settled tasks scores 0 and is excluded whenever minReputation > 0» — hay que actualizarlo o el doc miente |
| `chaski-v3/src/infrastructure/a2a/gateway-client.ts:16-41`, `:144-242` | El consumidor | `PAYOUT_MIN_REPUTATION = 2`; `GatewayConstraints` tipa sólo dos claves ⇒ una tercera **no compila** hasta agregarla |
| `chaski-v3/app/api/payout/prepare/route.ts:230-304` | El leg de dinero | PR7 forward → PR8 valida `depositAddress` → PR9 emite la atestación HMAC. **El `depositAddress` lo elige el agente** y el usuario firma contra esa dirección |
| `chaski-v3/doc/sdd/_INDEX.md:668-704` | Estado del flag | El bloqueo está documentado allá con esta misma aritmética |

### Auto-Blindaje histórico aplicado (obligatorio, hay datos)

Leí `doc/sdd/208-compose-por-capacidad/auto-blindaje.md` y los encabezados de
`doc/sdd/209-wkh-307-solana-durable-idempotency-ledger/auto-blindaje.md`. Dos patrones se repiten en ≥2 HUs y **se convierten en CD**:

- **"No pude preguntar" leído como "la respuesta es no"** — 209: *«`table_missing` para un fallo de red: el séptimo sitio del bug»*, *«el MISMO bug 20 líneas más abajo»*, *«un `null` de RPC declarado como prueba»*. Acá el equivalente exacto: `computeReputationBatch` devuelve **Map vacío** cuando la query falla (`reputation.ts:242-253`) y el pipeline lo traga con `catch {}` (`discovery.ts:550-552`) ⇒ un agente con historial se vuelve indistinguible de un recién llegado. → **CD-7**.
- **Dos expresiones para la misma cantidad** — 208: el refund del step-0 calculaba el débito por su cuenta y divergía. Acá el riesgo es el predicado de estreno escrito una vez en el filtro y otra vez en el contador/badge. → **CD-8**.
- **"No agrega costo" hay que asertarlo como costo de I/O, no como efecto visible** — 208 (M5 sobrevivió). → **CD-9** y el test T-13.

---

## 3. La regla de producto — *Trial Standing* (carril de estreno)

### 3.1 Enunciado

Un agente tiene **standing** derivado *exclusivamente* de sus eventos liquidados. Cuatro estados, y son cuatro a propósito:

| standing | condición (de una lectura **no degradada**) | efecto |
|---|---|---|
| `scored` | `tasksSettled ≥ 1` | pasa/no pasa el piso por su score real (comportamiento de hoy, intacto) |
| `newcomer` | `tasksSettled == 0` **y** `failedCount == 0` | **elegible** para el carril de estreno |
| `penalized` | `tasksSettled == 0` **y** `failedCount ≥ 1` | **no** elegible: ya tuvo su chance y entregó mal |
| `unknown` | la lectura de standing falló | **no** elegible (fail-closed). Nunca se confunde con `newcomer` |

Un agente elegible es **admitido** bajo `minReputation = m` si y sólo si se cumplen las TRES:

1. el que consulta **lo pidió explícitamente** (`allowTrial` / `constraints.allow_trial`);
2. `m ≤ T` (**techo de estreno**, propuesto `T = 10`);
3. el ancla de publicación no excedió su cupo (**M** agentes en estreno por publicador, propuesto `M = 2`).

El carril **se agota solo**, en tres formas y ninguna requiere que alguien intervenga:
- **por éxito**: al llegar a `tasksSettled = N` (propuesto `N = 3`) el agente sale del carril y se sostiene con su score real (3 liquidadas ⇒ score 6);
- **por fallo**: el primer evento `failed` lo pasa a `penalized` y el carril queda **anulado**, no decrementado;
- **por techo**: si el que consulta pide `m > T`, no hay estreno — está pidiendo un agente probado, y eso el carril no lo finge.

### 3.2 Por qué esta forma y no otra

- **Por cantidad, no por calendario** (DT-4 heredado): el reloj castiga al agente por una variable que no controla (que no le llegue tráfico). El contador sólo avanza cuando efectivamente trabajó.
- **Cero persistencia nueva**: el estado sale del mismo `a2a_events` que ya alimenta la reputación, del **mismo accumulator**, en la **misma query**. No hay tabla de gracia que se desincronice, no hay contador que haya que decrementar, no hay job de expiración. El "se resuelve solo" del founder es literal: la condición deja de cumplirse por el propio trabajo del agente.
- **El score nunca se fabrica**: un agente admitido por estreno entra al conjunto con su `computedReputation` **ausente** (o su score real bajo). Por eso `repValue` (`discovery.ts:437-440`) le da 0 y **queda al fondo del ranking**: sólo gana cuando no hay ningún agente que pase por mérito. AC-7 intacto, y el ranking de los que ya tienen historial no se mueve un milímetro.
- **Es visible en la respuesta**, siempre (AC-2/DT-3): agente admitido ⇒ badge `trial`; candidatos descartados por piso ⇒ contador; candidatos que se podrían haber admitido ⇒ contador aparte. Un piso relajado en silencio es la clase de bug que este repo ya rechaza dos veces por escrito.

### 3.3 Las cinco preguntas del founder, contestadas

**(a) ¿La oportunidad es del gateway o del consumidor?** **Partida, y la partición es el diseño.**
- **El gateway es dueño del MECANISMO**: quién es recién llegado, cuántos trabajos dura, cuándo se anula, cuál es el cupo por publicador. Es el único que tiene los datos (`a2a_events`, `a2a_agents.owner_ref`) y es la única forma de que **un tercero lo reciba sin escribir una línea de código**. Si esto viviera en cada consumidor, cada uno tendría que implementarlo, y la plaza seguiría sin admitir oferta nueva por defecto: exactamente lo que el founder descartó.
- **El consumidor es dueño de la ADMISIÓN**: si en *esta* llamada acepta o no un candidato en estreno. Y por una razón que no es de gusto: el consumidor puso el piso y el consumidor come el riesgo. Que el gateway ignore por su cuenta un piso que el caller pidió es **el mismo defecto** que el código ya nombra y rechaza en `discovery.ts:412-417` y `compose-step-shape.ts:148-155` ("un filtro que el que pide cree tener y no tiene"), sólo que con el signo invertido y sobre el camino del dinero. Además AC-1 exige que el gateway no aplique un piso que nadie pidió: la simetría honesta es que tampoco **quite** uno que sí pidieron.
- **Default = no admitir.** Un consumidor que no cambia nada obtiene el comportamiento de hoy, byte por byte.

**(b) ¿Cómo se evita que sea vector de abuso?** Cinco capas, y la última es la que importa:
1. **Nunca gana por ranking**: score real 0 ⇒ último. Un candidato en estreno sólo puede ser elegido cuando **ningún** agente pasa por mérito. Publicar cien agentes en estreno no desplaza a uno reputado.
2. **Cupo por publicador** (`M`, propuesto 2): el ancla es `a2a_agents.owner_ref` (NOT NULL, con índice) para self-published, y `registry_id` para federados. Con más de M elegibles del mismo ancla, retienen estreno los **M más antiguos por `created_at`** (determinista, no aleatorio). Publicar 100 agentes de la misma cuenta compra 2 estrenos, no 100.
3. **Anulación al primer fallo**, no decremento. El que arranca y entrega mal sale.
4. **Techo de piso** (`T`): el estreno no puede colarse bajo un piso alto. Un consumidor que pide 50 está pidiendo historial de varios clientes distintos (§1.4 del work-item: con `K=5`, un solo cliente no lleva a nadie más allá de 10) y el carril no lo simula.
5. **Opt-in del consumidor + control compensatorio obligatorio en legs de desembolso** (CD-13). El vector realmente caro no es "cobrar un fee de 0.03 sin entregar": es que en `prepare` **el `depositAddress` lo elige el agente** (`chaski-v3/app/api/payout/prepare/route.ts:290-291`) y el usuario firma el **principal** de la remesa contra esa dirección. PR8 valida el *formato* y PR9 **ata** la dirección a *esta* remesa, pero **ninguno de los dos verifica que la dirección sea de un pagador legítimo** — atar bien una dirección equivocada sigue siendo una remesa que no llega. Por eso el estreno en un leg de desembolso no se habilita sin uno de los controles de §3.4.
- **Residual honesto** (R-1): el cupo se ancla en la cuenta, y crear cuentas nuevas es barato. Cerrar eso es trabajo de nivel signup, no de esta HU. La palanca disponible el día que haga falta es exigir `Agent.identity` (ERC-8004) para el estreno: cuesta gas y un token real, y **es alcanzable solo** — a diferencia de `verified`, ver §1.

**(c) ¿Cuántos trabajos dura y qué pasa si los falla?** `N = 3` liquidadas pagas `[DECIDE FOUNDER]`, y **se anula con el primer fallo**. Aritmética de por qué 3: 1 liquidada ⇒ score 2 (queda pegado al piso actual de Chaski, sin margen: un fallo posterior lo devuelve a 1 y lo expulsa); 3 liquidadas ⇒ score 6 (aguanta dos fallos antes de caer bajo 2: `round(3/50×100×0.60) = 4`); 5 liquidadas ⇒ 10, que es el techo estructural de un solo cliente (§1.4). `N=3` es el número más chico que deja al agente **con margen** al salir del carril.

**(d) ¿Qué diferencia hace `verified`?** Hoy, **ninguna que sirva**, y hay que decirlo: es un booleano que el registry declara sobre sí mismo (`discovery.ts:676`) y está hardcodeado `false` para todo self-published (`agent.ts:141`), o sea para los tres agentes del flujo insignia (medido). No es requisito de elegibilidad, no es control compensatorio y no se toca en esta HU. El ancla de identidad utilizable es `Agent.identity` y hoy nadie la tiene: eso es una tarea de datos (bindear nuestros agentes), no de código, y queda como palanca `[DECIDE FOUNDER]` de §5.

**(e) ¿Y el que tiene historial malo?** **No entra al carril, y eso es deliberado.** `penalized` (0 liquidadas + ≥1 fallo) y `scored` con score bajo (§1.6: 1 paga + 4 fallos ⇒ score 0) son estados distintos de `newcomer` y ninguno recibe estreno: ya tuvieron la oportunidad. Lo que sí queda **abierto y sin resolver** es que el §1.6 no tiene salida (para reparar el `success_rate` necesita corridas nuevas y para tenerlas necesita ser elegido). Su remedio es otro — ventana de recencia / decaimiento del historial viejo — y **no** es esta HU (§7 fuera de alcance, HU nueva propuesta). Confundir los dos casos en una sola política es cómo se le regala pase libre a un agente que ya falló.

### 3.4 El control compensatorio del leg de desembolso (AC-6 / CD-4 heredados)

CD-4 del work-item prohíbe admitir un agente bajo el piso en un leg que termina en un desembolso a una persona física **sin control compensatorio explícito**. Tres candidatos, ninguno inventado — los tres son verificables en código:

| Control | Dónde vive | Qué acota | Costo |
|---|---|---|---|
| **CC-1 — Tope de principal en llamadas de estreno** | `chaski-v3` (leg de payout) | La pérdida máxima por remesa contra un agente no probado | chico. Necesita el número: `[DECIDE FOUNDER]` |
| **CC-2 — Estreno sólo con rail no-mainnet** | `chaski-v3` (chequeo de chain/env del leg) | La pérdida a **cero real** mientras el rail es devnet/testnet | chico, y es el que sirve para la semana que viene |
| **CC-3 — Exigir `Agent.identity` (ERC-8004) al candidato en estreno** | `wasiai-a2a` (elegibilidad) | Encarece el sybil y ancla al publicador | medio + **bloquea hasta bindear nuestro agente** (hoy `identity` ausente en los 3) |

**Recomendación**: **CC-2 como gate de la entrega (verificable, costo cero real) + CC-1 con un número del founder para cuando el rail sea real.** CC-3 se agenda como endurecimiento, no como bloqueante — hoy bloquearía la propia demo.
Si el founder no fija ninguno, **CD-13 aplica y el estreno NO se habilita en el leg de payout** (el resto del carril sigue sirviendo para capacidades que no desembolsan).

---

## 4. Decisiones técnicas

- **DT-1** (hereda DT-1 del work-item): el filtro sigue leyendo **sólo** `computedReputation.score`. `agent.reputation` no entra nunca. El carril de estreno **no** es un score: es un estado aparte, y el score del admitido sigue siendo el real (ausente o bajo).
- **DT-2** (hereda DT-2): el filtro se queda **pre-sort y pre-slice** (`discovery.ts:404-428`). La admisión de estreno se implementa **dentro de ese mismo bloque**, como una segunda rama del predicado. No se agrega un post-filtro y no se mueve nada.
- **DT-3** (hereda DT-3): toda relajación se expresa en la **respuesta**, no sólo en logs.
- **DT-4**: el standing se computa en **un solo lugar** — una función nueva en `services/reputation.ts` que reusa `RepAccumulator` (`reputation.ts:72-131`) y expone los tres contadores que hoy se descartan (`successCount`, `failedCount`, `tasksSettled`). Firma propuesta:
  `computeStandingBatch(slugs: string[]): Promise<{ degraded: boolean; standings: Map<string, AgentStanding> }>`
  con `AgentStanding = { kind:'scored'; reputation: AgentReputation } | { kind:'newcomer' } | { kind:'penalized' }`.
  `computeReputationBatch` se **deriva** de ella (mismo query, mismo accumulator, misma fórmula) para que no haya dos expresiones del score.
- **DT-5**: `degraded` es un **tercer valor explícito**, no un Map vacío. Es la corrección del defecto de clase que ya mordió siete veces en HU-307: hoy `reputation.ts:242-253` devuelve el mismo Map vacío para "nadie tiene historial" y para "no pude preguntar", y `discovery.ts:550-552` lo traga con `catch {}`. Con `degraded: true` **no se admite a nadie por estreno** y el `excluded` de la respuesta lo dice.
- **DT-6**: `attachReputations` (`discovery.ts:542-554`) pasa a devolver el batch de standings y `runDiscoveryPipeline` lo guarda en un `Map<slug, AgentStanding>` **local**. El standing **no** se agrega como campo público de `Agent` (evita publicar una letra escarlata `penalized` sin contrato y evita rozar la redacción de `discovery.redaction.test.ts`). Lo único que se surfacea es el badge `trial` del **admitido**.
- **DT-7**: el flag del que consulta se llama `allowTrial` en `DiscoveryQuery` / query-string / body, y `allow_trial` en `ComposeStepConstraints` (snake_case, como sus dos hermanas). **Hay que agregarlo al allowlist de `compose-step-shape.ts:156`**: si no, un caller que lo manda recibe 400 `unsupported constraint`. Su parser vive en `lib/discovery-query.ts` (módulo leaf, mismo motivo documentado en `:1-10`).
- **DT-8**: `N`, `T`, `M` se resuelven por env con default en código, patrón `resolveScaleFactor` (`reputation.ts:36-49`): `TRIAL_MAX_SETTLED_TASKS`, `TRIAL_MAX_MIN_REPUTATION`, `TRIAL_MAX_AGENTS_PER_PUBLISHER`. **Con una diferencia deliberada**: si la env está ausente/inválida el default **no apaga el control** (a diferencia del riesgo que cita `gateway-client.ts:22-28`), porque el default es el valor conservador, no el permisivo.
- **DT-9**: la consulta del ancla anti-sybil (`a2a_agents` → `owner_ref, created_at`) corre **sólo** si `allowTrial === true`. En el camino por defecto no hay ni una query nueva. Batched, un solo SELECT por request (anti-N+1, patrón CD-12 de `reputation.ts:234-240`).
- **DT-10**: `capability-resolver.ts` gana un tercer `reason`: `excluded_by_reputation`. Hoy un conjunto vaciado por el piso vuelve como `no_candidates` (`:130-136`) — indistinguible de "esa capacidad no existe". Ese fue el diagnóstico que llevó tres semanas de confusión en Chaski; el 422 tiene que decirlo.

---

## 5. Números que decide el founder

| Símbolo | Qué es | Propuesta | Consecuencia de moverlo |
|---|---|---|---|
| `N` | Liquidadas pagas que dura el estreno | **3** `[DECIDE FOUNDER]` | 1 = el agente sale sin margen (un fallo lo re-expulsa). 5 = sale en 10, el techo de un solo cliente |
| `T` | Piso máximo bajo el cual aplica el estreno | **10** `[DECIDE FOUNDER]` | Es el techo estructural de un caller único (§1.4). Más alto = el carril simula historial multi-cliente que no existe |
| `M` | Agentes en estreno por publicador | **2** `[DECIDE FOUNDER]` | 1 = un dev honesto con dos agentes queda a medias. Alto = flota sybil por cuenta |
| `CC-1` | Tope de principal por remesa en llamada de estreno | **sin propuesta** `[DECIDE FOUNDER]` | Es la pérdida máxima aceptada contra un agente no probado |
| `CC-2` | Estreno sólo en rail no-mainnet | **recomendado SÍ** `[DECIDE FOUNDER]` | Es el que deja la demo con riesgo real cero |
| `CC-3` | Exigir `identity` ERC-8004 para estrenar | **NO ahora** `[DECIDE FOUNDER]` | Hoy bloquearía la propia demo (ningún agente la tiene) |
| §1.6 | ¿El agente expulsado por fallos tempranos entra en esta HU? | **NO** (HU aparte) `[DECIDE FOUNDER]` | Mezclarlo le da pase libre a quien ya falló |

---

## 6. Waves

### W0 — DESTRABE DE LA DEMO (tres entregas, la tercera en otro repo)

**Por qué el destrabe no es "bajar la constante de Chaski", con argumento:**
- Bajarla a 0 o borrarla **es desechable** (hay que deshacerlo después) y además **borra el único gate automático de calidad** del leg que mueve el principal (§4 del work-item). Encima **rompe sus propios tests**: `chaski-v3/app/api/payout/submit/route.test.ts:1240` y `app/api/payout/prepare/route.test.ts:657` afirman `PAYOUT_MIN_REPUTATION > 0`.
- Y el destrabe **tampoco** puede ser sólo del gateway: cualquier variante en la que el gateway ignore por su cuenta el piso que el caller pidió reproduce, sobre el camino del dinero, el defecto que este repo rechaza por escrito dos veces (`discovery.ts:412-417`, `compose-step-shape.ts:148-155`), y Chaski atestaría la dirección de un agente en estreno **sin saberlo**.
- Por eso W0 es **el carril de estreno de verdad, en su versión mínima**: nada de lo que se escribe en W0 se tira después, y el piso de Chaski **se queda en 2**.

| # | Repo | Entrega | Archivos (scope IN) |
|---|---|---|---|
| **W0.1** | `wasiai-a2a` | Standing de tres estados + `degraded` explícito | `src/services/reputation.ts` (nueva `computeStandingBatch`, `computeReputationBatch` derivada), `src/types/index.ts` (`AgentStanding`) |
| **W0.2** | `wasiai-a2a` | Canal de admisión opt-in + cupo por publicador + superficie honesta | `src/services/discovery.ts` (`attachReputations`→standings, rama de admisión en `:422-428`, `excluded`), `src/lib/discovery-query.ts` (parser), `src/routes/discover.ts` (GET **y** POST), `src/lib/compose-step-shape.ts:156` (allowlist), `src/services/capability-resolver.ts` (mapeo + `excluded_by_reputation`), `src/services/agent.ts` (lector del ancla `owner_ref/created_at`), `src/types/index.ts` (`DiscoveryQuery.allowTrial`, `DiscoveryResult.excluded`, `Agent.trial`, `ComposeStepConstraints.allow_trial`) |
| **W0.3** | `chaski-v3` | **Entrega separada y coordinable — otro repo, otro escritor, otra rama y otro PR.** Bloqueada por W0.1+W0.2 mergeadas y deployadas | `src/infrastructure/a2a/gateway-client.ts` (`GatewayConstraints` gana `allow_trial?: boolean`; **`PAYOUT_MIN_REPUTATION` se queda en 2**), `app/api/payout/prepare/route.ts:243`, `app/api/a2a/payout/submit/route.ts:390` (mandan `{ min_reputation: 2, allow_trial: true }`), el control compensatorio elegido (§3.4), y los 4 tests que hoy hacen `toEqual({min_reputation: …})` (`gateway-client.test.ts:117,125`, `payout/submit/route.test.ts:1239`, `payout/prepare/route.test.ts:656`) |

**La demo queda destrabada al terminar W0.3, no antes.** Y W0.2 **debe** incluir el cupo por publicador antes de que W0.3 se encienda: sin cupo, la capacidad `remittance-payout` no tiene hoy **ningún** agente con score, así que el desempate entre dos candidatos en estreno es **aleatorio** (`discovery.ts:454`, `lib/ranking-tiebreak.ts`) y un sybil que publique el mismo capability tiene ~50% de quedarse con el `depositAddress` del principal. Ordenar W0.2 después de W0.3 abriría una ventana de robo más barata que la remesa que roba.

### W1 — `wasiai-a2a`: que el vacío deje de ser mudo (AC-3, independiente de la política)
`excluded: { scope, reputation, trialAvailable }` en `DiscoveryResult` + el 422 de `/compose` con `reason: 'excluded_by_reputation'`. Es lo único de la HU que **hace visible el problema aunque la política no se toque**, y es lo que convierte el próximo diagnóstico de 3 semanas en 3 minutos. Paralelizable con W2. (Parte del shape se adelanta en W0.2 porque el badge y el contador son la superficie de AC-2; W1 completa contadores y el `reason`.)

### W2 — `wasiai-a2a`: documentación y contrato (paralelizable)
`doc/INTEGRATION.md:245-259` (hoy dice, sin matiz, que un agente sin liquidadas queda excluido: hay que documentar el carril, el opt-in, el badge y los contadores) + una nota donde vive la política de ranking (`discovery.ts:404-428`) con la **asimetría real** de §1: `verified` es auto-reportado y hardcodeado `false` para self-published; el ancla no-forjable es `identity`. Sin esa nota, el próximo lector vuelve a leer "una perilla más estricta que otra".

### Fuera de esta HU (abiertas como HU nuevas)
- **§1.6 / R-2**: salida para el agente que entró y volvió a 0 (ventana de recencia o decaimiento). Vive ya en un agente de producción: `remit-kyc-validator` está a un fallo de caer bajo el piso 2.
- **R-3**: `verified` como primera clave del sort siendo un booleano auto-reportado por el registry (`discovery.ts:676`), inalcanzable para todo self-published (`agent.ts:141`). Es un canal de ranking controlado por la parte rankeada. **No pude determinar** qué autenticación exige hoy crear un registry, así que **no afirmo** que sea explotable por un tercero — hay que verificarlo antes de dimensionarlo.
- Bindear `identity` ERC-8004 a los tres agentes remit (tarea de datos, habilita CC-3).
- Tocar `F` (`REPUTATION_SCALE_FACTOR`) o `K` (`REPUTATION_MAX_TASKS_PER_CALLER`): mueve todos los scores de producción a la vez. Explícitamente fuera (§8 del work-item).

---

## 7. Constraint Directives

Heredados del work-item, **sin cambios**:
- **CD-1**: PROHIBIDO introducir un piso por defecto del lado del gateway (env o código). AC-1.
- **CD-2**: PROHIBIDO que una relajación de piso quede fuera de la respuesta. AC-2.
- **CD-3**: PROHIBIDO aceptar como entrada de reputación cualquier dato controlado por el agente puntuado, o por un solo caller más allá de `K`. AC-7.
- **CD-4**: PROHIBIDO habilitar un agente bajo el piso en un leg de desembolso a persona física sin control compensatorio explícito. AC-6 → materializado en CD-13.
- **CD-5**: PROHIBIDO cambiar `reputation.ts`/`discovery.ts` sin confirmar antes el piso real de los consumidores de producción. **CUMPLIDO en §0**: es 2, en los dos legs de payout de `chaski-v3`, y en ningún otro lado.

Nuevos de este SDD:
- **CD-6** (exigido por el encargo): PROHIBIDO alterar el ranking de los agentes **que ya tienen historial**. El comparador de `discovery.ts:455-463` y `repValue` (`:437-440`) quedan **byte-idénticos**; un agente en estreno **nunca** recibe score fabricado y por lo tanto ordena último entre iguales. Cubierto por T-05 y T-06 (mutación M4).
- **CD-7**: PROHIBIDO derivar "no tiene historial" de la **ausencia de dato**. La lectura de standing devuelve un tercer valor explícito (`degraded`) y con él **no se admite a nadie**. Referencias: `reputation.ts:242-253`, `discovery.ts:550-552`, `discovery.minreputation.test.ts:218-228` (T-8), HU-307 auto-blindaje («`table_missing` para un fallo de red: el séptimo sitio del bug», «el MISMO bug 20 líneas más abajo», «un `null` de RPC declarado como prueba»).
- **CD-8**: PROHIBIDO escribir el predicado de standing más de una vez. El filtro, el contador de `excluded`, el badge `trial` y el cupo leen **la misma** función. Referencia: HU-208 auto-blindaje (el refund del step-0 que divergía del débito por tener dos expresiones de la misma cantidad).
- **CD-9**: PROHIBIDO que el camino por defecto (`allowTrial` ausente) cambie **en nada**, incluido el **costo de I/O**: sin opt-in, cero queries nuevas. Se asertan las llamadas, no sólo el resultado (HU-208 auto-blindaje, mutación M5 sobreviviente).
- **CD-10**: PROHIBIDO surfacear `owner_ref` (ni ningún ancla de publicación) en la respuesta de `/discover` o `/compose`. El ancla se usa para contar, no para publicar. Guard: `discovery.redaction.test.ts`.
- **CD-11**: PROHIBIDO mover el filtro de `minReputation` fuera del bloque pre-sort (`discovery.ts:347-366` lo dice: **NO MOVER**).
- **CD-12**: PROHIBIDO que W0.3 baje, borre o convierta en env `PAYOUT_MIN_REPUTATION`. Se queda en 2, como constante de código.
- **CD-13**: PROHIBIDO habilitar `allow_trial` en un leg de desembolso sin uno de los controles compensatorios de §3.4 **elegido por escrito**. Sin control elegido, W0.3 no se entrega y el carril queda disponible sólo para capacidades que no desembolsan.
- **CD-14**: PROHIBIDO conceder estreno a un agente con `failedCount ≥ 1`. "Sin historial" y "mal historial" son estados distintos (DT-5 del work-item).
- **CD-15**: PROHIBIDO que el cupo por publicador se resuelva de forma no determinista. Ante empate manda `created_at` ascendente (los M más antiguos), nunca el orden del arreglo ni el tiebreak aleatorio.

---

## 8. Criterios de aceptación y plan de tests (≥1 por AC, con la mutación que mata cada uno)

Los ACs son los del work-item §7 (AC-1..AC-7) más tres nuevos que la política elegida exige (AC-8..AC-10).

| ID | AC | Test (archivo verificado) | Qué asserta | **Mutación que el test debe matar** |
|---|---|---|---|---|
| T-01 | AC-1 | `src/services/discovery.minreputation.test.ts` (extender) | Sin `minReputation` en la query, ningún agente se excluye por reputación, con o sin `allowTrial` | **M1**: introducir un piso por defecto (`const min = query.minReputation ?? 1`) ⇒ T-01 rojo |
| T-02 | AC-2 | `src/services/discovery.trial.test.ts` (nuevo) | Un agente admitido por estreno viene con `trial:{...}` y **sin** `computedReputation` fabricada | **M2**: admitir al agente pero no marcarlo (borrar la asignación del badge) ⇒ rojo |
| T-03 | AC-3 | `src/routes/discover.minreputation.test.ts` (extender) | Con `minReputation=50` y 3 descartados, `excluded.reputation === 3`; y `trialAvailable` cuenta los que se habrían admitido | **M3**: `excluded.reputation = 0` fijo, o contar post-`slice` ⇒ rojo |
| T-04 | AC-4 | `discovery.trial.test.ts` | Con `tasksSettled = N` el agente **ya no** es admitido por estreno (queda sujeto a su score real) | **M4**: `<` → `<=` en el límite de `N` ⇒ rojo (test de frontera exacta: N-1 admite, N no) |
| T-05 | AC-5 + **CD-6** | `discovery.trial.test.ts` | Un agente con `failedCount ≥ 1` y 0 liquidadas **no** se admite ni con `allowTrial` | **M5**: borrar el término `failedCount === 0` del predicado ⇒ rojo |
| T-06 | **CD-6** | `discovery.trial.test.ts` | Orden dorado: con [scored 90, scored 10, trial] el trial queda **último**, y el orden de los dos scored es idéntico al de hoy | **M6**: darle al admitido un score sintético (`score: min`) para "que pase" ⇒ el trial sube y el test cae. Mata AC-7 y CD-6 a la vez |
| T-07 | AC-6 / CD-13 | `chaski-v3` (W0.3): `app/api/payout/prepare/route.test.ts` | El step de payout manda `allow_trial` **sólo** cuando el control compensatorio elegido se cumple; si no, no lo manda | **M7**: mandar `allow_trial:true` incondicionalmente ⇒ rojo |
| T-08 | AC-7 | `src/services/reputation.test.ts` (extender) | El standing no tiene ninguna entrada que el agente controle: un `metadata.reputation`/`score` en el evento no cambia `tasksSettled` ni el `kind` | **M8**: leer un score del `metadata` del evento ⇒ rojo |
| T-09 | AC-8 (nuevo: default OFF) | `discovery.trial.test.ts` | Sin `allowTrial`, con un `newcomer` presente y `minReputation=1`, el resultado es **idéntico** al de hoy (0 agentes, `total 0`) | **M9**: `allowTrial ?? true` ⇒ rojo |
| T-10 | AC-9 (nuevo: fail-closed) | `discovery.trial.test.ts` + `reputation.test.ts` | Con la lectura de standing **degradada** (query con error) y `allowTrial=true`, **nadie** entra; y `degraded` viaja como `true`, no como Map vacío | **M10**: tratar `degraded` como `newcomer` (o volver a devolver Map vacío en el error) ⇒ rojo. **Es la mutación más importante del set**: es el defecto de clase de HU-307 |
| T-11 | AC-10 (nuevo: cupo) | `discovery.trial.test.ts` | Con 5 `newcomer` del mismo `owner_ref` y `M=2`, se admiten exactamente los 2 de `created_at` más antiguo; los otros 3 quedan afuera | **M11**: quitar el cupo, o resolverlo por orden del arreglo en vez de `created_at` ⇒ rojo (el test fija `created_at` desordenado respecto del arreglo, para que el orden del arreglo **no** sea la respuesta correcta) |
| T-12 | AC-10 / techo `T` | `discovery.trial.test.ts` | Con `minReputation = T+1` y `allowTrial=true`, el `newcomer` **no** entra; con `T` exacto, sí | **M12**: `<=` → `<` (o borrar el techo) ⇒ rojo por frontera |
| T-13 | **CD-9** (costo de I/O) | `discovery.trial.test.ts` | Sin `allowTrial`: el batch de standing se llama **exactamente 1 vez** y el lector del ancla **0 veces**. Con `allowTrial`: 1 y 1 | **M13**: leer el ancla siempre (fuera del gate) ⇒ rojo. Aserción sobre **llamadas**, no sobre el resultado (HU-208 M5) |
| T-14 | DT-7 (borde HTTP) | `src/lib/compose-step-shape.test.ts` + `src/lib/discovery-query.test.ts` | `constraints.allow_trial` se acepta (no 400) y un valor no booleano se **rechaza** con 400; `allowTrial` en GET y POST parsea igual | **M14**: no agregar la clave al allowlist de `:156` ⇒ 400 y rojo; aceptar `"maybe"` como truthy ⇒ rojo |
| T-15 | DT-10 (422 explicable) | `src/services/capability-resolver.test.ts` | Conjunto vaciado **por el piso** ⇒ `reason: 'excluded_by_reputation'`, no `no_candidates` | **M15**: colapsar el reason a `no_candidates` ⇒ rojo |
| T-16 | CD-10 (redacción) | `src/services/discovery.redaction.test.ts` (extender) | Ni `owner_ref` ni el `kind` de standing aparecen en la respuesta serializada | **M16**: adjuntar el standing como campo público del `Agent` ⇒ rojo |
| T-17 | CD-8 (una sola expresión) | `discovery.trial.test.ts` | Filtro, contador `trialAvailable` y badge coinciden **siempre**: si hay k admitidos, hay k badges y `trialAvailable === k` en el mismo escenario | **M17**: cambiar el predicado del contador sin cambiar el del filtro (divergencia) ⇒ rojo. Es el guard anti-HU-208 |

**Regla de verificación (money-path)**: T-02, T-05, T-06, T-10, T-11 y T-12 tocan **selección de agente**, o sea dinero. Para cada uno se exige: (i) la mutación de su fila aplicada al código real y el test **rojo**; (ii) cobertura de las líneas del guard, no sólo suite verde; (iii) prohibido aceptar un `describe.skip`/archivo no colectado como evidencia (`tres-formas-en-que-la-suite-miente`: un falso KILLED por archivo no colectado ya pasó acá).

---

## 9. Riesgos y residuales declarados

- **R-1 (abierto, aceptado)**: el cupo se ancla en `owner_ref` y crear cuentas nuevas es barato. Mitigación disponible: CC-3 (`identity` ERC-8004). No es esta HU.
- **R-2 (abierto, otra HU)**: §1.6 sin salida. Vivo hoy en `remit-kyc-validator` (score 2, un fallo de la exclusión).
- **R-3 (abierto, sin dimensionar)**: `verified` como primera clave del sort es auto-reportado por el registry e inalcanzable para self-published. **No pude determinar** qué auth exige crear un registry ⇒ no afirmo explotabilidad por terceros.
- **R-4**: `prepare` y `submit` resuelven el agente **por separado** (residual ya aceptado en `chaski-v3/doc/sdd/_INDEX.md:692-699`). Con el carril de estreno el riesgo cambia de forma: dos candidatos en estreno empatan en score 0 y el desempate es aleatorio, así que los dos legs podrían resolver a **agentes distintos**. Con `M ≥ 2` esto es alcanzable. **Mitigación mínima obligatoria en W0.3**: los dos legs deben resolver al **mismo** agente, o el `depositAddress` atestado en `prepare` no es el del agente que ejecuta `submit`. Hay que verificarlo al implementar; si no se puede garantizar, `M = 1` para capacidades de desembolso.
- **R-5**: `total` de `/discover` sube cuando hay admitidos por estreno. Es correcto (`total` = matches de los filtros aplicados), pero es un cambio observable para un consumidor que pagine con `allowTrial=true`. Documentar en W2.

## 10. Lo que NO pude determinar

1. El valor de `NEXT_PUBLIC_VALUE_DELIVERY_ADAPTER` en el Vercel de producción de Chaski (no leo envs de prod) ⇒ no afirmo si el flujo de prod hoy va por gateway o punto-a-punto.
2. Qué autenticación exige hoy `POST /registries` ⇒ R-3 sin dimensionar.
3. Si el rail de payout de Chaski en el entorno de la demo es devnet o mainnet ⇒ CC-2 es *verificable*, pero su estado actual hay que medirlo en F2.5/F3 antes de apoyarse en él.
4. Si `submit` y `prepare` pueden garantizar hoy el mismo agente resuelto (R-4). Requiere leer el guard-order completo de `submit/route.ts`, que quedó fuera de esta lectura.

---

## 11. Readiness Check

| Ítem | Estado |
|---|---|
| Piso real de los consumidores de producción confirmado (CD-5) | **SÍ** — 2, `chaski-v3/src/infrastructure/a2a/gateway-client.ts:29`, usado en `prepare/route.ts:243` y `submit/route.ts:390` |
| Diagnóstico medido en vivo, no asumido | **SÍ** — §0, `GET /discover` (gratis), 2026-07-29 |
| Todos los exemplars existen (Glob/Read) | **SÍ** — 17 archivos de `wasiai-a2a` + 6 de `chaski-v3` + 1 migración, todos leídos |
| Política elegida por el founder | **SÍ** — oportunidad provisoria, variante por cantidad de trabajos |
| W0 destraba la demo y no es desechable | **SÍ** — W0.1+W0.2 son el carril real; W0.3 es el opt-in del consumidor **sin bajar el piso** |
| Entrega en otro repo declarada como separada | **SÍ** — W0.3 en `chaski-v3`, rama y PR propios, un escritor por repo, bloqueada por W0.1+W0.2 |
| ≥1 test por AC con su mutación | **SÍ** — 17 tests, 17 mutaciones nominadas, 6 marcados money-path |
| CD "no romper el ranking existente" | **SÍ** — CD-6, cubierto por T-05/T-06/M6 |
| Números sin decidir marcados | **SÍ** — `N`, `T`, `M`, `CC-1`, `CC-2`, `CC-3`, §1.6 → `[DECIDE FOUNDER]` (§5) |
| `[NEEDS CLARIFICATION]` sin resolver | **NO quedan**: lo indeterminado está en §10 como "no pude determinarlo", no como supuesto |
| **Bloqueante de gate** | **`N`, `T`, `M` y el control compensatorio (§3.4) tienen que estar decididos antes de F2.5.** Sin CC elegido, CD-13 impide entregar W0.3 y la demo **no** se destraba |
