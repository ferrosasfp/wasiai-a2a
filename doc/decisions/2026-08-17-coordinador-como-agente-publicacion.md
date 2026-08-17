# WKH-360 — El coordinador como agente: qué se publica, dónde y qué NO

> Decisiones DT-1 y DT-2 de la HU `223-coordinador-como-agente`, más el
> procedimiento escrito de registro en catálogos externos (NC-4).
>
> **Estado de este documento**: DT-1 y DT-2 son decisiones **tomadas**. La tabla de
> catálogos externos es una **lista de verificaciones pendientes**, no un plan
> aprobado: ⛔ ninguna fila se ejecuta sin el OK del founder.

---

## 1 · Qué entregó esta HU

`GET /.well-known/agent.json` ya declara **cómo contratar al gateway como un agente
A2A**. Antes publicaba qué sabía hacer y nada de cómo contratarlo
(`authentication.schemes: []`, sin endpoint ni precio por skill).

Lo que la carta declara ahora, con la fuente de cada dato:

| Dato | Valor | De dónde sale |
|---|---|---|
| Esquemas de auth/pago | `bearer` siempre; `x402` **sólo si** hay alguna chain inicializada que acepte cobro de ENTRADA | `getInboundPaymentChainKeys()` (lista viva del proceso) |
| Endpoint por skill | `POST /discover`, `POST /compose`, `POST /orchestrate` | los prefijos con los que `src/index.ts` registra cada plugin |
| Precio | **NO hay precio fijo.** `discover` es `free`; `compose` y `orchestrate` declaran `protocol-fee-on-executed-cost` + `feeRatePercent` + `quoteEndpoint: /orchestrate/plan` | `getProtocolFeeRate()`, la misma expresión que usa `/orchestrate/plan` |
| Contrato de la traza | `depthMax`, los dos nombres de header, y la nota best-effort | el MISMO lector que aplica el guard |

**Por qué no hay `priceUsdc` por skill**: los precios de los agentes son
pass-through y lo que este gateway cobra es una **tasa sobre el costo realmente
ejecutado**, que no se conoce antes de ejecutar. Publicar un número fijo sería
fabricar una oferta. La carta declara el **modelo** y apunta al **cotizador**
(`POST /orchestrate/plan`, que devuelve `costPerStep`, `totalCostUsdc`,
`protocolFeeUsdc` y `maxQuotedCostUsdc`, y **no cobra**).

⚠️ **La nota best-effort de `contracting.bestEffortNote` no es adorno y no se puede
quitar.** Publica que la detección de bucles **transitivos** depende de que cada
intermediario reenvíe los headers. Sin ese texto, la carta induciría a un coordinador
a creer que declarar los headers alcanza para estar cubierto.

---

## 2 · DT-1 · El gateway NO se publica en su propio `/discover`

**Decisión: no se publica. No es una decisión de neutralidad, es mecánica.**

Si el gateway fuera una fila de su propio catálogo:

- `/compose` podría **elegirlo por ranking** al resolver un step por capacidad, y
- `/orchestrate` podría **ponerlo en un plan** desde el planner.

O sea que el catálogo propio **fabricaría exactamente el bucle** que esta HU corta.
El guard de capa 1 lo rechazaría después (por identidad del destino), pero el
resultado sería un catálogo que ofrece un agente que el propio gateway se niega a
invocar: una fila que sólo produce errores.

**Consecuencia para quien integre**: el gateway se descubre por su
`/.well-known/agent.json`, que es el mecanismo estándar de A2A para eso, **no** por
`/discover`. Las dos superficies tienen públicos distintos: `/discover` es el
catálogo de agentes contratables *a través* del gateway; la carta es el gateway
*como agente*.

---

## 3 · DT-2 · No se construye ningún publicador automático

**Decisión: esta HU entrega la carta y este procedimiento escrito. NO entrega un
auto-registrador en catálogos externos.**

Motivo: no está verificado qué catálogos A2A externos aceptan hoy una publicación
abierta (NC-4, abajo). Construir un publicador contra un endpoint de alta que no se
verificó es escribir código para una API supuesta.

---

## 4 · NC-4 · Catálogos externos: lo verificado y lo que falta verificar

⛔ **NADA de esta tabla está aprobado para ejecutarse.** Es la lista de lo que hay
que averiguar, y cada fila necesita el OK del founder antes de dar un paso.

| Candidato | Lo que SÍ está medido | Lo que falta verificar | ⛔ |
|---|---|---|---|
| **Kite** | `a2aSupport: none` y bloqueado por falta de API | si existe algún endpoint de alta pública | no se intenta hasta que haya API |
| **`wasiai-v2` (nuestro propio marketplace)** | es un registry vivo consumido por el gateway | (a) que listarnos ahí **no** nos meta en nuestro propio `/discover` (DT-1), y (b) que el `invokeUrl` publicado **no** sea el nuestro | **decisión del founder**: es el caso con más riesgo de reintroducir el bucle por la puerta de atrás |
| **x402 Bazaar** | — | ¿alta abierta o curada?, qué campos exige, ¿republica el `invokeUrl`? | — |
| **Agentic.Market** | — | ídem | — |
| **ERC-8004 sobre Base** | es un registro de **IDENTIDAD**, no un catálogo de agentes | — | ⛔ **no reemplaza** el registro en un catálogo; confundirlos sobreestima la distribución |

**El riesgo transversal de esta tabla, y por qué merece su propia línea**: varios de
estos catálogos **republican el `invokeUrl`**. Si alguno publica el nuestro como si
fuera el de un agente, un tercero que lo lea y lo invoque produce el bucle desde
afuera. La capa 1 lo corta (por identidad, antes de cobrar), pero el modo de falla
para el integrador es un 400 opaco. Antes de publicarse en cualquier catálogo hay que
saber **qué URL va a republicar**.

---

## 5 · Lo que esta HU NO cierra (residuales, copiados con su ⛔)

⛔ **Ninguno de estos se puede leer como cerrado.**

| # | Queda abierto | ⛔ Prohibido escribir |
|---|---|---|
| **R-3 / TD-360-2** | **Bypass por IP literal.** La comparación de identidad es **por NOMBRE**: `https://<nuestra-ip>/compose` no matchea salvo que un operador ponga esa IP en `A2A_SELF_HOSTS`. Cerrarlo pediría resolver DNS de nuestros propios hosts por step: caro, inestable (las IPs de Railway rotan) y solapado con el módulo SSRF | que la capa 1 "cierra el bucle directo" **sin calificar que es por nombre** |
| **R-4** | **La capa 2 NO cierra el transitivo contra un adversario** que borra los headers. Lo que queda en pie es la capa 1 (que no consulta ningún header del caller) y el techo de profundidad | "bucle transitivo cerrado" a secas |
| **TD-360-1** | La **allow-list** de auto-contratación legítima, si algún día aparece un caso. Hoy no existe ninguno (0 de 25 agentes de prod apuntan al gateway). Si entra, entra **vacía por default = denegar** | shippearla en esta HU |
| **NC-1** | **No se pudo verificar si `BASE_URL` está seteada en el Railway de prod.** Un `GET /.well-known/agent.json` con `X-Forwarded-Proto: http` devuelve `url` en `https://`, y eso es compatible con `BASE_URL` seteada **y** con Railway reescribiendo el header: desde afuera no se distingue. El diseño no depende de la respuesta (conjunto vacío ⇒ `warn`, no `throw`), y **`GET /health` publica `contractingGuard.selfHostCount` para confirmarlo después del deploy** | que `BASE_URL` está (o no está) seteada en prod |
| **NC-2** | **No se pudo verificar `TRUST_PROXY` en prod.** Cambia si el rate-limit buckeatea por IP real o si todos los callers externos comparten un bucket. Afecta la NARRATIVA de cuánto DoS colateral produce un bucle, no el diseño | afirmar que el rate-limit acota (o no acota) el bucle en prod |
| **WKH-361 (candidato)** | **El bucle de DISCOVERY**: registrar como `registry` el propio `/discover`. Es un vector real y contiguo (`POST /registries` valida forma y SSRF y nada más, sin control de identidad propia), pero **no mueve plata** y tiene circuit-breaker por registry. Comparte el módulo leaf de esta HU ⇒ va **después**, nunca en paralelo | tratarlo como cubierto por esta HU |

---

## 6 · Qué mirar después del deploy

```bash
GW=https://wasiai-a2a-production.up.railway.app

# 1 · ¿el guard tiene identidad configurada? (NC-1 se resuelve ACÁ, no desde afuera)
curl -s "$GW/health" | jq '.contractingGuard'
#   selfHostCount: 0  → 'request-only': sólo cubre el Host de cada petición.
#                       Los ALIAS propios NO están cubiertos ⇒ setear A2A_SELF_HOSTS.
#   selfHostCount: >0 → 'env': la identidad está declarada.

# 2 · ¿la carta declara cómo contratarla?
curl -s "$GW/.well-known/agent.json" | jq '{schemes: .authentication.schemes, contracting, skills: [.skills[] | {id, endpoint, pricing}]}'

# 3 · el techo publicado tiene que ser el que se aplica
curl -s "$GW/.well-known/agent.json" | jq '.contracting.depthMax'
```

⚠️ **`A2A_CONTRACTING_DEPTH_MAX=0` no es "sin límite extra": es el servicio
cerrado.** Un caller directo tiene profundidad 0 y el corte es `depth >= techo`, así
que con 0 se rechaza el 100% del tráfico. No sirve como interruptor de emergencia.
