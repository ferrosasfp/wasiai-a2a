# SDD — [WKH-335] El Coordinador tiene el status HTTP del agente y no lo dice

> HU CROSS-REPO. Wave 1 en `wasiai-a2a` (worktree `/home/ferdev/.openclaw/workspace/a2a-wkh362`,
> rama `feat/wkh-335-status-estructurado`). Wave 2 en `chaski-v3` (worktree
> `/home/ferdev/.openclaw/workspace/chaski-wkh362`, rama `feat/wkh-335-error-no-opaco`).
> ⚠️ Los DIRECTORIOS de worktree conservan un nombre viejo (`…-wkh362`), residuo de dos renumeraciones.
> La HU es **WKH-335** y las ramas son `feat/wkh-335-*`. **WKH-335 no es un número nuevo**: es el ID que
> `chaski-v3` ya reservaba en 7 lugares de su código (`agent-rejections.ts:48`, `gateways.ts:122`,
> `quote/route.ts:34`, entre otros) para exactamente este trabajo, y que nunca tuvo fila de índice.
>
> Input: `work-item.md` de esta carpeta (aprobado con `HU_APPROVED`), `.nexus/project-context.md`,
> issues `ferrosasfp/wasiai-a2a#177` y `ferrosasfp/chaski-v3#5`.

---

## 0. Cómo leer este documento

Toda cita `archivo:línea` de este SDD la abrí yo en el worktree correspondiente durante este F2.
Donde el work-item traía un número y el árbol dice otro, está marcado **[DRIFT]** con el número
medido. No hay ninguna cita heredada sin abrir.

Las **tres decisiones que el F1 dejó abiertas a propósito** se resuelven en §3:

| Abierta en F1 | Resuelta en | Veredicto en una línea |
|---|---|---|
| DT-1 · nombre y shape del campo | §3.1 | `agentFailure?: AgentFailureKind`, unión cerrada de DOS valores, plano (sin objeto) |
| DT-2 · de dónde sale el dato | §3.2 | **(b)** `response.status` capturado en el origen vía `AgentHttpError` — hay precedente exacto en este repo |
| `[NEEDS CLARIFICATION]` · el 429 | §3.3 | **allow-list**, no deny-list: `INPUT_REJECTED ⟺ status ∈ {400, 422}`. El 429 cae en `AGENT_ERROR`, que es el bucket del comportamiento de HOY |

Los tres `[resuelto en F2]` de "Missing Inputs" del work-item se cierran en §3.1, §3.4 y §3.5.

---

## 1. Context Map — qué leí, por qué, y qué patrón extraje

### 1.1 `wasiai-a2a` (worktree `a2a-wkh362`, rama `feat/wkh-335-status-estructurado`)

| Archivo:línea | Por qué lo abrí | Qué extraje |
|---|---|---|
| `src/services/compose.ts:1738-1758` | origen del dato | `ssrfFetch` → `if (!response.ok)` (:1743) → lee body truncado a 300 → `throw new Error(\`Agent ${slug} returned ${status}…\`)` (:1755-1757). **Único uso de `response.status`**: después de esa línea el número sólo vive dentro de un string. ✔ work-item exacto |
| `src/services/compose.ts:1665-1678` | ¿alguien re-envuelve el error entre el `throw` y el `catch`? | El único `try/catch` intermedio de `invokeAgent` envuelve `validateRegistryUrl` y corre **ANTES** del fetch. **Medido: no hay re-wrap.** Una subclase de `Error` tirada en :1756 llega intacta a los dos `catch`. Esto es lo que hace viable DT-2(b) |
| `src/services/compose.ts:733-734` | el `catch` del primer intento | `const firstError = err instanceof Error ? err.message : String(err);` — el objeto `err` está en scope y hoy se descarta apenas se le saca el `.message` |
| `src/services/compose.ts:1146-1159` | AC-2, camino CON retry | `return { success:false, …, error: \`Step ${i} failed after retry: …\`, ...withheldResult(settleWithholding ?? retryWithholding, i) }`. ✔ rango del work-item exacto |
| `src/services/compose.ts:1178-1190` | AC-1, camino DIRECTO | `return { success:false, …, error: \`Step ${i} failed: ${firstError}\`, ...withheldResult(settleWithholding, i) }`. ✔ rango exacto. **Son dos `return` distintos, no comparten nada** (CD-6) |
| `src/services/compose.ts:146-158` | **el exemplar de forma** | `function withheldResult(withholding, step): Pick<ComposeResult,'settleRefundWithheld'>` — `if (!x) return {}` y si no, el objeto. Se esparce en los **mismos dos `return`** (:1158 y :1189). El campo nuevo se agrega con un helper gemelo, una línea por sitio |
| `src/services/compose.ts:1092-1094` | el `catch` del retry | `const retryError = retryErr instanceof Error ? retryErr.message : String(retryErr);` — mismo patrón, `retryErr` en scope |
| `src/services/compose.ts:918-920` | DT-2(a), el camino a descartar | `const missingFields = isMasterPath ? parseFieldErrors(firstError) : null` |
| `src/lib/field-error-parser.ts:24-31` | DT-2(a) | `/returned (\d{3})/.exec(errorMessage)` + guard `status < 400 || status >= 500 → null`. Extrae **nombres de campo**, y el status es sólo su compuerta interna |
| `src/lib/discovery-sources.ts:18-38` | **el exemplar de DT-2(b)** | `RegistryHttpError extends Error` con `public readonly status: number`. Su docblock dice literalmente *"Existe para que el fanout pueda clasificar `http_error` sin parsear el mensaje"* y *"El `message` se mantiene BYTE-IDÉNTICO al `Error` genérico que había antes… para no romper ningún test que lo asserte"*. Es el mismo problema, ya resuelto en este repo, con el mismo candado de mensaje |
| `src/types/index.ts:1180-1263` | dónde declarar el campo | `ComposeResult`. Campos aditivos existentes con su estilo de docblock: `errorCode` (:1207-1212), `inputMappingFailure` (:1229-1241), `verificationStatus` (:1243), `settleRefundWithheld` (:1259-1263), `failedSources`/`catalogStatus` |
| `src/types/index.ts:681-687`, `:708`, `:724-727` | **el exemplar de naming** | `DiscoverySourceFailure` = unión cerrada de clases de fallo; se consume como `failure?: DiscoverySourceFailure` dentro de `DiscoverySource` y como `failure: DiscoverySourceFailure` en `FailedSourceRef`. **Precedente exacto de "campo llamado `failure` cuyo valor es una unión cerrada clasificada"** |
| `src/routes/compose.ts:1127-1130` | ¿el campo llega al cable? | `return reply.status(status).send({ ...result, requestId: request.id })` — spread completo del `ComposeResult`. **Aditivo por construcción** |
| `src/routes/compose.ts:899-902` | ¿hay `schema.response` que STRIPee? | `fastify.post<{ Body: ComposeBody }>('/', { config, preHandler: [...] }, …)`. **Medido: no hay `schema:` en la ruta** (grep de `schema:` sobre `src/routes/compose.ts` = 0 hits). Sin serializador declarado, Fastify no descarta claves desconocidas |
| `src/services/compose.test.ts:209-226` | los helpers de test | `mockFetchOk(data)` y `mockFetchError(status, body = '{"error":"fail"}')` sobre `mockFetch` (que stubea el `fetch` global **y** el de `undici`, :74-80) |
| `src/services/compose.test.ts:2634-2660` | el `describe` donde entran los tests nuevos | `composeService.compose — WKH-130 adaptive input-retry`, con `mockAgentsBySlug`, `FIELD_ERR_BODY` y `netSpend()` |
| `src/services/compose.test.ts:2740-2769` | exemplar de AC-2 | `T-RETRY-FAIL`: `mockFetchError(422, FIELD_ERR_BODY)` + `mockFetchError(500)` + `mockRegen` → asserta `result.error` contiene `returned 422` y `returned 500`. **El escenario del retry ya está armado**: el test nuevo de AC-2 sólo cambia el status del segundo `mockFetchError` |
| `src/services/compose.test.ts:2807-2853` | exemplares de AC-1 | `T-5XX-NO-RETRY` (500) y `T-4XX-NOFIELDS` (400 "Bad Request") — los dos caen al `return` directo |
| `src/services/compose.test.ts:2885-2909` | exemplar de la AUSENCIA | `T-NON-4XX`: `mockFetch.mockRejectedValueOnce(new Error('network ECONNRESET'))` |
| `src/routes/compose.test.ts:117-121` | por qué el test de ruta NO certifica | `vi.mock('../services/compose.js', …)` — en ese archivo el service es un **doble**. Sirve para probar la serialización, nunca la emisión (§9.3) |
| `test/cited-lines-guard.citations.ts:88`, `:97`, `:263` | riesgo de citas desplazadas | `src/types/index.ts` y `src/services/compose.ts` están en el conjunto cubierto. **Medido: las únicas citas declaradas hacia esos archivos son `src/services/compose.ts:571` y `types/index.ts:217-218`, las dos ANTES de todo punto de inserción de esta HU** |
| `.github/workflows/ci.yml:33-44` + `package.json:7-16` | el gate real | `npx tsc -p tsconfig.json --noEmit` → `npm run lint` (`biome check src/`) → `npm test` (`vitest run`). ⛔ **`npm run qa` NO existe en este repo** |

### 1.2 `chaski-v3` (worktree `chaski-wkh362`, rama `feat/wkh-335-error-no-opaco`)

| Archivo:línea | Por qué lo abrí | Qué extraje |
|---|---|---|
| `src/infrastructure/a2a/gateway-client.ts:120-131` | el enum de fallos | `GatewayFailCode`, 11 valores, `step_failed` = *"success:false mid-pipeline"* |
| `src/infrastructure/a2a/gateway-client.ts:133-158` | `GatewayFailure` | `code`, `step?`, `gatewayCode?`, `reason?`, `message?` (SERVER-ONLY), `httpStatus?`. Acá va el campo nuevo |
| `src/infrastructure/a2a/gateway-client.ts:232-249` | `readFailureFields` | copia `step` / `code`\|`error_code` / `reason` / `error`→`message`, **cada uno con guard de tipo**. Nunca confía en la forma del otro lado |
| `src/infrastructure/a2a/gateway-client.ts:252-270` | `mapErrorStatus` | `case 400: return body.success === false ? "step_failed" : "invalid_request"`. **El fallo medido en producción llega por acá** (el gateway contesta 400 con `success:false`) |
| `src/infrastructure/a2a/gateway-client.ts:330-337` | sitio 1 del `!res.ok` | `{ ok:false, code, ...readFailureFields(parsed), httpStatus: res.status }` |
| `src/infrastructure/a2a/gateway-client.ts:341-353` | **sitio 2, que el work-item no nombraba** | el `200 + success:false` arma su objeto **a mano**, sin `readFailureFields`. Si sólo se toca el lector, este sitio queda sin el campo (§4.4). La línea `:343` es el `PROHIBIDO parsear el texto "Step 2 failed: …"` — **vigente, esta HU no lo toca** |
| `src/infrastructure/a2a/gateway-client.ts:380-392` | `logGatewayFailure` | log de SÓLO enums (`code`, `step`, `gatewayCode`, `reason`, `httpStatus`). El campo nuevo es un enum ⇒ entra acá sin violar CD-9 |
| `app/api/a2a/quote/route.ts:158-170` | leg 1 | `if (!r.ok) { logGatewayFailure("quote", r); if (not_configured) 501; if (no_agent_match && noAgentMeansNobodyFits) 422; return 502 a2a_unavailable }`. ✔ `:170` exacto |
| `app/api/payout/prepare/route.ts:400-427` | leg 2 | mismo patrón → `prepare_upstream_error` 502. **[DRIFT]** el work-item decía `:391`; el `if (!r.ok)` real está en **`:400`** |
| `app/api/payout/prepare/route.ts:444-453` | **el hallazgo que define Wave 2** | el rechazo del agente que YA existe: `readPayoutRejection(result)` → `console.warn("[payout-prepare] agent_rejected", …)` → `NextResponse.json({ error: rejection.enum }, { status: 422 })`. **Enum y status ya definidos para esta familia** |
| `src/application/agent-rejections.ts:44-49` | **el hallazgo que define el leg de quote** | `QUOTE_REJECTED = "a2a_quote_rejected"` con el docblock: *"HOY NINGÚN PRODUCTOR DE ESTA APP LO EMITE… El desenlace estructural está pedido en WKH-335 (`wasiai-a2a`, otro repo)"*. **Esta HU es ese desenlace** |
| `src/application/agent-rejections.ts:60-64` | el gemelo del payout | `PREPARE_REJECTED = "prepare_agent_rejected"` — *"Familia: quien atendió la capacidad `remittance-payout` rechazó crear la orden"* |
| `src/application/agent-rejections.ts:66-88` | la asimetría documentada | *"el agente de payout contesta su rechazo en el `output` del step… El de FX lo contestaba con un status HTTP de error, **que es justamente lo que el gateway colapsa**"*. Wave 1 des-colapsa exactamente eso |
| `src/application/agent-rejections.ts:10-13` | el defecto, medido allá | `POST {"amountUsd":2}` → 502; `{"amountUsd":50000}` → 502; el agente había contestado `400 fx_amount_below_minimum` / `400 fx_amount_above_maximum` |
| `src/application/agent-rejections.ts:189-197` | **el exemplar de la dirección del default** | `NO_AGENT_REASONS_MEANING_NOBODY`: *"LA DIRECCIÓN DEL DEFAULT ES LA DECISIÓN, y es fail-closed hacia lo vago: sólo los reasons de esta allowlist habilitan la afirmación fuerte… El costo de equivocarse hacia acá es un diagnóstico pobre; hacia el otro lado es una frase falsa"*. **Es el argumento que resuelve el 429** (§3.3) |
| `src/infrastructure/a2a/gateways.ts:96-131` | el lector del cliente | `readQuoteRejection`: `if (body.error !== QUOTE_REJECTED) return undefined; … return QUOTE_REJECTED`. **Ya sabe leer el enum**; `:143-155` lo tira como `Error` |
| `src/presentation/flow-vm.ts:592-596` | el copy que YA existe | `if (code.includes("a2a_quote_rejected")) return "No pudimos cotizar este envío: el corredor lo rechazó. Probá con otro monto."` — **exactamente el mensaje que el defecto medido necesita** |
| `src/presentation/flow-vm.test.ts:1008-1047` | el candado T-4.1' | declara *"AC-4 QUEDA NO CUMPLIDO"* y cierra con *"Si algún día WKH-335 aterriza, ESTE `expect` es el que hay que dar vuelta"*. Ver §4.5: el `expect` **no** hay que darlo vuelta; la que hay que reescribir es la declaración |
| `app/api/a2a/quote/route.test.ts:85-109` | el doble | `gwRouter({ compose, status, composeThrows, captureCompose })` stubea el `fetch` global |
| `app/api/a2a/quote/route.test.ts:236-262` | **el exemplar de los tests de Wave 2** | `T-13.2/AC-13`: enum propio + `Object.keys(json) === ["error"]` + `directCalls` vacío + el `message` del gateway NO logueado |
| `app/api/a2a/quote/route.test.ts:266-270` | **el exemplar que importa más** | *"LOS DOS DESENLACES EN EL MISMO `it`, COMPARADOS ENTRE SÍ. Un test que sólo mire el caso nuevo no prueba que se DISTINGAN: pasaría igual con los dos mapeados al mismo enum"* |
| `src/infrastructure/a2a/gateway-client.test.ts:424-432` | el shape del fallo real | `T-A2.4b`: `status: 400, body: { success:false, steps:[], error:"Step 1 failed", step:0 }` → `{ code:"step_failed", step:0, httpStatus:400 }` |
| `package.json:8-19` + `.github/workflows/ci.yml` | el gate real de ESTE repo | `npm run qa` = `lint && typecheck && typecheck:scripts && test`; el CI agrega `npm run build`. ⚠️ **`qa` sí existe acá y no existe en `wasiai-a2a`** |

### 1.3 Auto-Blindaje histórico leído (obligatorio, §"aprendé del pasado")

`doc/sdd/_INDEX.md` → últimas DONE con `auto-blindaje.md`: **224** (WKH-362), **223** (WKH-360), **222** (WKH-345).
Tres patrones se repiten en ≥2 de las tres y se convierten en CD (§5.2, CD-14/CD-15/CD-16):

1. **Prosa que afirma de más sobre su propio código** (222 W0: *"copié al docblock una afirmación del Story File que no medí, y era falsa"*; 224 W1: *"el docblock afirmaba que un trozo del regex cargaba un comportamiento que NO cargaba"*). → CD-14.
2. **"¿quién MÁS afirma algo sobre esto?"** (223 W0-3: agregar 2 envs dejó falso un número publicado en los DOS README; 222 W2: *"corrí sólo los archivos que toqué y canté verde con 2 rojos en el árbol"*). → CD-15 y CD-16.
3. **Un test que mide otra cláusula de la que dice medir** (223 W0-1: el mismo número como valor y como techo, *"el `it` decía estar midiendo el PARSEO y en realidad medía el TECHO"*). → CD-17, y es literal para esta HU: el clasificador tiene bordes (399/400/422/429/500) y un test que use el mismo status para las dos clases no distingue nada.

---

## 2. Qué se construye

**Una frase**: `/compose` pasa a decir, en un campo propio y de vocabulario cerrado, si el agente
invocado **leyó el pedido y rechazó su contenido** o **falló por otra cosa**; y los dos legs de
dinero de Chaski dejan de contestar "algo salió mal, probá de nuevo" en el primer caso.

**El defecto, medido hoy contra producción por la ruta real de Chaski:**

| Lo que la persona escribe | Hoy | Después de las DOS waves |
|---|---|---|
| `amountUsd: 10` | 200, cotización real | igual (byte-idéntico) |
| `amountUsd: 100000` | **502 "algo salió mal, probá de nuevo"** | 422 `a2a_quote_rejected` → *"No pudimos cotizar este envío: el corredor lo rechazó. Probá con otro monto."* |
| `amountUsd: 0` | **502**, ídem | ídem |
| `amountUsd: -5` | **502**, ídem | ídem |

Un monto fuera de rango se presenta hoy como una caída del sistema, y el consejo que se da
(reintentar) **está garantizado a fallar**. "Montos topeados" es parte del producto.

---

## 3. Decisiones técnicas

### 3.0 Heredadas del work-item — estado en este F2

| DT | Estado |
|---|---|
| **DT-1** (no reutilizar `errorCode`) | ✔ **VIGENTE Y HONRADA**. `errorCode` (`types/index.ts:1207-1212`) enumera motivos por los que el **gateway mismo** rechaza; `agentFailure` describe qué contestó el **agente invocado**. Son dos preguntas y no comparten dominio. Ningún valor nuevo entra a `errorCode` |
| **DT-2** (origen del dato) | ✔ resuelta en §3.2 → **opción (b)** |
| **DT-3** (Wave 2 sigue el patrón `no_agent_match`) | ✔ **VIGENTE Y AMPLIADA**: §3.6 encuentra que el enum propio para las dos familias **ya existe** y no hay que inventar ninguno |

### 3.1 DT-1 resuelta — nombre y shape del campo

```ts
// src/types/index.ts — junto a las demás uniones cerradas de clasificación
export type AgentFailureKind = 'INPUT_REJECTED' | 'AGENT_ERROR';

// dentro de ComposeResult, después de errorCode/inputMappingFailure
agentFailure?: AgentFailureKind;
```

**Nombre**: `agentFailure`. Verificado: **cero ocurrencias** del identificador en `src/` antes de
esta HU (grep). El par *campo llamado `failure` + unión cerrada de clases* es el patrón que este
repo ya usa: `DiscoverySourceFailure` (`types/index.ts:681-687`) consumido como
`failure?: DiscoverySourceFailure` (`:708`) y `failure: DiscoverySourceFailure` (`:726`). El
prefijo `agent` es imprescindible porque en este archivo "failure" solo ya significa "de una
fuente de discovery".

**Plano, no objeto — y esto es una decisión, no una omisión.** Evalué
`agentFailure?: { step: number; kind: … }` siguiendo a `settleRefundWithheld` y a
`inputMappingFailure`, que sí llevan `step`. Lo descarté **midiendo**: `/compose` aborta en el
PRIMER step que falla y los dos `return` devuelven `steps: results`, o sea sólo los COMPLETADOS
⇒ el índice del step que falló es exactamente `steps.length`, y cualquier consumidor lo deriva sin
parsear nada. Chaski ya lo hace así (`gateway-client.ts:345-346`, con el comentario *"el índice
del paso que falló es ESTRUCTURAL"*). Un `step` en el campo nuevo sería un segundo lugar que dice
lo mismo, y dos lugares que dicen lo mismo se desincronizan. `settleRefundWithheld.step` sí es
load-bearing (su docblock lo declara: orchestrate decide con él si saltea SU reembolso); acá no.

**Por qué DOS valores y no el status crudo** (AC-3 / DT-1): el número desnudo obliga a cada
consumidor a re-implementar la clasificación, y cada uno la haría distinta. El campo responde UNA
pregunta —*"¿el agente rechazó lo que le mandaron?"*— y el número sigue disponible server-side en
`error` y en los logs, que es donde el operador lo necesita.

**`AGENT_ERROR` y no `AGENT_UNAVAILABLE`**: un 401/403 del agente no es "no disponible"; es "nos
dijo que no por algo que no es el contenido del pedido". `AGENT_ERROR` no afirma de quién es la
culpa ni si el agente está vivo, que es lo único que podemos sostener (lección "prosa que afirma
de más", §1.3-1).

**Cierra el Missing Input** *"nombre exacto y shape"*.

### 3.2 DT-2 resuelta — **opción (b)**: `response.status` capturado en el origen

```ts
// src/lib/agent-http-error.ts (NUEVO, módulo leaf)
export class AgentHttpError extends Error {
  public readonly status: number;
  public readonly kind: AgentFailureKind;
  constructor(agentSlug: string, status: number, detail: string) {
    super(`Agent ${agentSlug} returned ${status}${detail ? `: ${detail}` : ''}`); // BYTE-IDÉNTICO
    this.name = 'AgentHttpError';
    this.status = status;
    this.kind = classifyAgentFailure(status);
  }
}
export function classifyAgentFailure(status: number): AgentFailureKind { … } // §6
```

```ts
// src/services/compose.ts, junto a withheldResult (:146-158)
function agentFailureResult(err: unknown): Pick<ComposeResult, 'agentFailure'> {
  return err instanceof AgentHttpError ? { agentFailure: err.kind } : {};
}
```

**Por qué (b) y no (a)**, con los tres argumentos en orden de peso:

1. **Hay precedente exacto en este repo, creado para este mismo problema.**
   `RegistryHttpError` (`src/lib/discovery-sources.ts:31-38`) existe —lo dice su docblock, `:24`—
   *"para que el fanout pueda clasificar `http_error` **sin parsear el mensaje**"*, y conserva el
   `message` byte-idéntico *"para no romper ningún test que lo asserte"*. Copiar ese patrón cuesta
   ~15 líneas y deja el repo con **un** modo de resolver esto en vez de dos.
2. **(a) haría que un contrato PÚBLICO dependa del texto de un mensaje interno.** `parseFieldErrors`
   es una compuerta interna: si mañana alguien reescribe el string de `:1756`, hoy se degrada una
   heurística de reintento (malo, recuperable); con (a) se rompería en silencio el campo que
   Chaski usa para decidir qué le dice a una persona sobre su plata. Un regex sobre prosa no es un
   contrato.
3. **(a) fuerza a re-parsear, un renglón más abajo, el string que el propio código acaba de armar
   con la variable que ya tenía.** `response.status` está tipado y en scope en `:1743`.

**Lo que (b) NO cambia, y es la condición de que sea barato**: el `message` sigue byte-idéntico
⇒ `parseFieldErrors` sigue funcionando igual, la máquina de reintento no se toca, y los asserts
existentes sobre `result.error` (`compose.test.ts:2761-2762`, `field-error-parser.test.ts` entero)
siguen verdes sin editarse. Verificado que es posible: **no hay ningún `try/catch` entre el `throw`
de `:1756` y los dos `catch` de `:733` y `:1092`** (§1.1, fila `compose.ts:1665-1678`).

**Cierra el Missing Input** *"de dónde sale el dato"*.

### 3.3 `[NEEDS CLARIFICATION]` resuelto — el 429, y la forma de la regla

**Decisión: allow-list, no deny-list.**

```
INPUT_REJECTED  ⟺  status ∈ { 400, 422 }
AGENT_ERROR     ⟺  cualquier otro status no-2xx (incluidos 401, 402, 403, 404, 408, 429 y todo 5xx)
ausente         ⟺  el agente no contestó con un status HTTP (red, DNS, timeout, SSRF, bucle de contratación…)
```

**Por qué allow-list.** Empecé por la deny-list ("todo 4xx es INPUT_REJECTED salvo una lista") y se
cae sola: cada excepción que uno se olvida produce **exactamente el defecto de esta HU, invertido**
— decirle a la persona *"revisá el monto"* cuando lo que pasó fue que **nuestra** Agent Key se quedó
sin saldo (402), **nuestra** credencial venció (401) o el `invokeUrl` del catálogo quedó viejo (404).
Cambiar "el sistema se cayó" por "es culpa tuya" no es un arreglo. Con allow-list, olvidarse de un
status deja el comportamiento de HOY, que es el bucket vago y genérico.

Es la dirección de default que este ecosistema ya eligió por escrito, en el repo de enfrente:
`chaski-v3/src/application/agent-rejections.ts:189-197` — *"sólo los reasons de esta allowlist
habilitan la afirmación fuerte… El costo de equivocarse hacia acá es un diagnóstico pobre; hacia el
otro lado es una frase falsa sobre el catálogo, que es el bug que esta HU vino a cerrar"*.

**Por qué exactamente `{400, 422}` y no más.** Son los DOS únicos medidos en este ecosistema:

- **400** — el caso de producción del work-item (`Agent remit-corridor-fx-solana returned 400:
  {"error":"invalid_input",…}`) y los dos de `chaski-v3` (`fx_amount_below_minimum` /
  `fx_amount_above_maximum`, `agent-rejections.ts:10-13`).
- **422** — la forma Zod, la que usa toda la máquina de retry (`compose.test.ts` `FIELD_ERR_BODY`,
  `field-error-parser.test.ts:12`).

409/413/415 son plausibles y **no están medidos**; entran cuando alguien traiga un caso real. La
regla para extender la lista queda escrita en el docblock (CD-13).

**El 429, entonces**: `AGENT_ERROR`. Y eso no es "no decidirlo": es la decisión, con dos razones.
(i) La semántica que el campo promete es *"reintentar con el MISMO input no puede cambiar el
resultado"*, y para un rate-limit eso es **falso** — reintentar tras esperar es justamente lo que
funciona. (ii) `AGENT_ERROR` es el bucket que Chaski ya mapea a *"Algo salió mal. Intentá de
nuevo."*, que para un 429 es **vago y CIERTO**. No hay evidencia medida de que un agente del
catálogo devuelva 429; si aparece, el comportamiento sigue siendo correcto sin tocar nada.
Lo mismo vale para el 408.

### 3.4 Fallos sin status de agente — el campo queda **AUSENTE**

Invariante, y es lo que hace verificable el campo:

> **`agentFailure` presente ⟺ el agente invocado contestó con un status HTTP no-2xx.**

Un fallo de red, un `SSRFViolationError`, `CONTRACTING_LOOP_DETECTED`, `INPUT_MAPPING_FAILED` o un
error del hook downstream **no** pueblan el campo. La ausencia significa *"no sé qué contestó el
agente"*, que es un estado real y distinto de `AGENT_ERROR` (*"contestó, y no fue sobre tu
pedido"*). Inventar un valor para la ausencia es la falla que este ecosistema ya documentó como
*"'no pude preguntar' NO es 'no pasó'"*. Es también el criterio por defecto que el work-item
proponía; queda **formalizado** acá. Sale gratis: `agentFailureResult` devuelve `{}` si el error no
es un `AgentHttpError`, igual que `withheldResult` devuelve `{}` sin retención.

**Cierra el Missing Input** *"si el campo se puebla para fallos no originados en un status HTTP"*.

### 3.5 Qué status reporta el camino con retry (AC-2)

El del **intento cuyo error se reporta, o sea el del retry** (`retryErr`), tal como AC-2 lo pide.
Consecuencia declarada: un `422 → regen → ECONNRESET` deja el campo **AUSENTE**, aunque el primer
intento haya sido un 4xx. Es correcto y deliberado: en el camino con retry el input **fue
regenerado** (`compose.ts:1027-1059`, `retryInput`), así que el veredicto del primer intento ya no
describe lo que se mandó la segunda vez; y el desenlace del segundo intento es desconocido. Ausente
= no sé. La alternativa (heredar el status del primer intento) afirmaría algo sobre un pedido que
no es el que falló último.

### 3.6 DT-4 (NUEVA) — Wave 2 **no crea vocabulario**: reusa dos enums que ya existen y no tienen productor

Este es el hallazgo que más achica Wave 2, y sale de leer `chaski-v3`, no de suponerlo.

| Leg | Enum | Estado hoy | Status HTTP |
|---|---|---|---|
| cotización | `QUOTE_REJECTED = "a2a_quote_rejected"` (`agent-rejections.ts:49`) | **declarado, sin productor**; su docblock dice *"El desenlace estructural está pedido en WKH-335 (`wasiai-a2a`, otro repo)"* | 422 (mismo que `no_agent_match`, `quote/route.ts:169`) |
| desembolso | `PREPARE_REJECTED = "prepare_agent_rejected"` (`agent-rejections.ts:64`) | vivo, pero **sólo** por el carril `200 + status:"blocked"` (`prepare/route.ts:444-453`) | **422**, ya fijado en `:453` |

Los tres eslabones que faltaban del lado de Chaski **ya están construidos**:
`readQuoteRejection` ya reconoce el enum (`gateways.ts:123-131`), `A2aQuoteGateway` ya lo tira
(`gateways.ts:150-152`), y `humanError` ya tiene su copy (`flow-vm.ts:592-596`):
*"No pudimos cotizar este envío: el corredor lo rechazó. Probá con otro monto."*

**Por qué reusar y no estrenar un enum nuevo**: (i) un enum nuevo dejaría a `QUOTE_REJECTED` sin
productor **igual**, o sea deuda intacta más un vocabulario paralelo; (ii) habría que escribir copy
nuevo cuando el que existe fue escrito para exactamente este caso; (iii) el cliente ya sabe leerlo.
Reusar convierte esta HU en **el cierre de WKH-335**, no en un camino en paralelo.

**Cierra el Missing Input** *"¿un enum compartido o dos?"* → **dos, y los dos ya existen**.

**Limitación aceptada, escrita**: el copy dice *"Probá con otro monto"*, y un `INPUT_REJECTED` podría
venir de un campo que no es el monto. Se acepta: (a) el único 4xx medido de ese agente es de rango de
monto; (b) el resto de los campos del formulario son `select`, no texto libre; (c) el peor caso es un
consejo impreciso, contra el actual, que es un diagnóstico **falso** ("el sistema se cayó") más un
consejo garantizado a fallar. Cambiar el copy es una decisión de producto, no de esta HU.

### 3.7 DT-5 (NUEVA) — el clasificador y la compuerta del retry **no se unifican**

`parseFieldErrors` gatea el reintento con `400 ≤ status < 500` (`field-error-parser.ts:31`); el
clasificador nuevo dice `INPUT_REJECTED` sólo para `{400, 422}`. **Divergen a propósito y ninguna
de las dos es la otra:**

- la compuerta del retry pregunta *"¿vale la pena reintentar con un input **regenerado por un
  LLM**?"* — un 403 con `fieldErrors` legibles califica;
- el clasificador pregunta *"¿reintentar con el **MISMO** input puede cambiar algo?"* — un 403 no
  califica.

Queda escrito en el docblock de los dos módulos. Sin ese texto, el próximo que lea los dos números
"unifica por consistencia" y rompe uno — es literal la lección del Auto-Blindaje de la HU 223
(*"sin ese texto, el próximo que lea CD-14 unifica por consistencia y rompe uno de los dos"*).

### 3.8 DT-6 (NUEVA) — `doc/INTEGRATION.md` entra al Scope IN de Wave 1

`doc/INTEGRATION.md` es la guía pública de integración y ya documenta el sobre de error de
`/compose` campo por campo (`:1042`, `:1071` documentan `errorCode: INPUT_MAPPING_FAILED` y
`inputMappingFailure`). Un campo público que no está ahí es una capacidad que **no existe para
quien está del otro lado del cable**. Entra ~15 líneas en la tabla de la sección 5. No estaba en el
Scope IN del work-item; entra por CD-15 (§5.2).

---

## 4. Hallazgos de este F2 que cambian el diseño

### 4.1 El fallo real llega a Chaski por el **400**, no por el 200

`routes/compose.ts:1092-1131`: cuando `!result.success`, el gateway responde **400** (default) con
el `ComposeResult` esparcido. Del lado de Chaski, `mapErrorStatus(400, body)` con `success === false`
da `step_failed` (`gateway-client.ts:255-257`) y el objeto se arma en el **sitio 1**
(`:330-337`), que sí pasa por `readFailureFields`. Confirmado por su propio test `T-A2.4b`
(`gateway-client.test.ts:424-432`). ⇒ el camino medido queda cubierto extendiendo `readFailureFields`.

### 4.2 …pero hay un **segundo sitio** que arma el fallo a mano

`gateway-client.ts:341-353` (el `200 + success:false`) construye su objeto **sin**
`readFailureFields`. Es defensivo hoy, pero si sólo se toca el lector, el mismo fallo se clasifica
distinto según el status con que llegue — la misma asimetría silenciosa que CD-6 previene del lado
de `wasiai-a2a`. **Wave 2 cubre los dos sitios** (CD-11). Cuesta una línea.

### 4.3 Riesgo de citas desplazadas — **medido en los dos repos**

Insertar líneas desplaza toda cita `archivo:línea` posterior, y ningún barrido del diff lo caza.
Medición de este F2:

| Repo | Archivos que la HU edita | Citas entrantes por encima del punto de inserción | Veredicto |
|---|---|---|---|
| `wasiai-a2a` | `src/services/compose.ts`, `src/types/index.ts` | las únicas citas declaradas son `src/services/compose.ts:571` y `types/index.ts:217-218` (`test/cited-lines-guard.citations.ts:263` y `:219-221`); barrido libre en `src/`+`test/` de `compose.ts:1[0-9]{3}` e `index.ts:1[2-9][0-9]{2}` → **0 hits** | **cero exposición** |
| `chaski-v3` | `gateway-client.ts` | `./a2a/gateway-client.ts:216` (desde `rate-limit.ts:313`) y `gateway-client.ts:225` (desde `quote/route.ts:135`) | **2 citas se desplazan** si se agrega el campo al tipo `GatewayFailure` (~`:155`) |
| `chaski-v3` | `agent-rejections.ts` | `…/agent-rejections.ts:49` (desde `gateways.ts:112`) y `…/agent-rejections.ts:266` (desde `flow.tsx:1712`) | **2 citas se desplazan** al reescribir el docblock de `QUOTE_REJECTED` |
| `chaski-v3` | `quote/route.ts`, `payout/prepare/route.ts` | 11 citas hacia `prepare/route.ts`, **todas ≤ `:347`**; cero hacia `quote/route.ts` | **cero exposición** (las inserciones van en `:400+` y `:158+`) |

⇒ La exposición total es de **4 citas**, todas en `chaski-v3`, todas identificadas por nombre.
`chaski-v3` **no tiene** guardián de citas (medido: sus `*guard*.test.ts` son de otras cosas), así
que ahí el barrido es manual y obligatorio (CD-12).

### 4.4 Ocho prosas de `chaski-v3` se vuelven FALSAS con Wave 2

Este repo tiene convención escrita para esto (`routes/compose.ts:1147-1153` del lado a2a: *"CÓMO SE
CITA UNA FRASE QUE SE VOLVIÓ FALSA"*), y la lección de memoria dice que una prosa que afirma de más
**apaga las revisiones**. Sitios medidos, con la frase que muere:

| # | Sitio | Frase que queda falsa |
|---|---|---|
| 1 | `agent-rejections.ts:44-49` | *"HOY NINGÚN PRODUCTOR DE ESTA APP LO EMITE"* |
| 2 | `agent-rejections.ts:51-58` | *"AC-4 está declarado NO CUMPLIDO"* (la parte de la reintroducción de la allow-list **sigue cierta**: el campo nuevo trae una CLASE, no el `reason` del agente) |
| 3 | `agent-rejections.ts:66-88` | *"El de FX lo contestaba con un status HTTP de error, que es justamente lo que el gateway colapsa"* — deja de colapsarlo |
| 4 | `gateways.ts:112-122` | *"ESTE `if` LEE UN ENUM QUE NINGÚN PRODUCTOR DE ESTA APP EMITE"* + *"el universo de `error` … son cuatro"* (pasan a ser cinco) |
| 5 | `quote/route.ts:146-157` | *"SE ABRE UNO SOLO: `no_agent_match`"* |
| 6 | `payout/prepare/route.ts:405-412` | *"Es el ÚNICO code que se abre"* |
| 7 | `flow-vm.ts:575-591` | la parte que explica que ningún productor puede emitir el copy (la del vocabulario `fx_*` **sigue cierta**) |
| 8 | `flow-vm.test.ts:1008-1027` | la declaración *"AC-4 QUEDA NO CUMPLIDO"* del candado T-4.1' |

### 4.5 T-4.1': el `expect` **no** se da vuelta

`flow-vm.test.ts:1045` cierra con *"Si algún día WKH-335 aterriza, ESTE `expect` es el que hay que
dar vuelta"*, refiriéndose a `expect(humanError("step_failed")).toBe("Algo salió mal…")`.
**Medido: no hay que darlo vuelta.** Después de Wave 2 el cliente nunca recibe `step_failed` como
`error` del body: la route lo traduce a `a2a_quote_rejected` **antes**. `humanError("step_failed")`
sigue —correctamente— dando el copy genérico, porque `step_failed` sigue siendo el bucket de lo que
no se pudo clasificar. Lo que cambia es la **declaración** de arriba y hace falta un `it` nuevo que
recorra la cadena nueva. Un F3 que "dé vuelta el expect" porque el comentario lo dice estaría
rompiendo un candado válido por obediencia a una prosa vieja.

### 4.6 `/orchestrate` queda cubierto sin código — verificado

`services/orchestrate.ts` embebe el `ComposeResult` completo como `pipeline` dentro de
`OrchestrateResult` (`types/index.ts`, `pipeline: ComposeResult`). Como el campo es aditivo al
tipo, `/orchestrate` lo hereda por el propio tipado, sin línea nueva. Es lo que el work-item
clasificó como `TD-362-STATUS-ORCHESTRATE` (Clase 2) y este F2 lo confirma: **no es un gap, es una
consecuencia del diseño aditivo**. Disparador para revisar, sin cambios: que un consumidor de
`/orchestrate` reporte la misma opacidad ⇒ HU nueva con su propio F1.

---

## 5. Constraint Directives

### 5.1 Heredadas del work-item (íntegras, sin reinterpretar)

- **CD-1**: PROHIBIDO ecoar el `invokeUrl` del agente invocado o su cuerpo de respuesta crudo — ni
  en el campo nuevo de `wasiai-a2a`, ni en el body HTTP de `chaski-v3`.
- **CD-2**: PROHIBIDO en `chaski-v3` parsear el string `"Step N failed: …"` (`gateway-client.ts:343`,
  CD-8/CD-9 vigentes). Esta HU levanta la opacidad **agregando** un campo, jamás habilitando ese parseo.
- **CD-3**: PROHIBIDO renombrar o quitar cualquier campo existente del sobre de `/compose`
  (`error`, `errorCode`, `success`, `steps`, `totalCostUsdc`, `totalLatencyMs`, …). Estrictamente aditivo.
- **CD-4**: OBLIGATORIO que el test de AC-5 corra sobre la respuesta **PROPIA** de `/compose`, nunca
  contra un doble de Chaski, y que quede la evidencia del rojo-antes. Ver §9.1 y §9.5.
- **CD-5**: PROHIBIDO cambiar el criterio de colapso de `payment_required` / `unavailable` en Chaski.
- **CD-6**: OBLIGATORIO cubrir **los DOS** caminos del Coordinador: directo (`compose.ts:1178-1190`)
  y con reintento (`compose.ts:1146-1159`).
- **CD-7**: OBLIGATORIO en Wave 2 arreglar **los DOS** legs de dinero: `app/api/a2a/quote/route.ts`
  y `app/api/payout/prepare/route.ts`.
- **CD-8**: OBLIGATORIO el orden de despliegue: Railway (`wasiai-a2a`) **primero**, Vercel
  (`chaski-v3`) después. Precondición del founder; ningún agente la ejecuta.

### 5.2 Nuevas de este SDD

- **CD-9**: OBLIGATORIO que el `message` del `AgentHttpError` sea **byte-idéntico** al string que
  hoy arma `compose.ts:1755-1757`. Es lo que mantiene verdes `parseFieldErrors`, la máquina de
  reintento y los asserts existentes sobre `result.error`. Mismo candado que el docblock de
  `RegistryHttpError` (`discovery-sources.ts:22-23`) declara para su caso. **El F3 lo prueba con un
  test que asserta que `parseFieldErrors(new AgentHttpError('foo', 422, BODY).message)` sigue
  devolviendo los campos**, no con una lectura del diff.
- **CD-10**: PROHIBIDO poblar `agentFailure` cuando no hubo status HTTP del agente (§3.4). La
  ausencia es un valor con significado y no se rellena.
- **CD-11**: OBLIGATORIO cubrir **los DOS** sitios de `gateway-client.ts` que construyen un fallo:
  `:330-337` (`!res.ok`) y `:341-353` (`200 + success:false`). Es el CD-6 del lado de Chaski (§4.2).
- **CD-12**: OBLIGATORIO re-anclar las **4 citas** medidas en §4.3 (`gateway-client.ts:216` y `:225`;
  `agent-rejections.ts:49` y `:266`) **en el mismo commit** que las desplaza, y re-correr el barrido
  después de editar (`grep -rnoE '[a-z0-9./-]*<archivo>\.ts:[0-9]{1,4}' src/ app/`). `chaski-v3` no
  tiene guardián de citas: acá el instrumento sos vos.
- **CD-13**: PROHIBIDO agregar un status a la allow-list de `INPUT_REJECTED` sin un caso **medido**
  de un agente real. La regla va escrita en el docblock del clasificador, con los dos casos que
  justifican `400` y `422`.
- **CD-14**: PROHIBIDO escribir en un docblock una afirmación falsable que no hayas ejecutado en
  esta HU. Si la frase se puede poner a prueba con un comando, o la corrés y anotás el resultado, o
  no la escribís. *(Auto-Blindaje 222/W0 y 224/W1 — el mismo error dos HUs seguidas.)*
- **CD-15**: OBLIGATORIO reescribir, **en el mismo commit**, las prosas que esta HU vuelve falsas:
  las 8 de §4.4 en `chaski-v3` y la entrada nueva de `doc/INTEGRATION.md` en `wasiai-a2a` (§3.8).
  Un marcador por línea si se cita la frase vieja. *(Auto-Blindaje 223/W0-3.)*
- **CD-16**: PROHIBIDO cerrar una wave con una corrida dirigida. El veredicto de wave es la **suite
  completa del repo**, y el gate de cierre es la secuencia completa, en orden:
  `wasiai-a2a` → `npx tsc -p tsconfig.json --noEmit` → `npm run lint` → `npm test`;
  `chaski-v3` → `npm run qa` (= `lint` → `typecheck` → `typecheck:scripts` → `test`) → `npm run build`.
  ⛔ **`npm run qa` NO existe en `wasiai-a2a`**; **`npm test` solo NO es el gate en `chaski-v3`**.
  *(Auto-Blindaje 222/W2.)*
- **CD-17**: PROHIBIDO que un test del clasificador use el mismo status para probar dos cláusulas
  distintas, y OBLIGATORIO que los tests de borde usen `399/400` y `422/423` y `429/500` —
  el par que discrimina. Un `it` que dice medir la clasificación y en realidad mide otra cláusula es
  un testigo apagado. *(Auto-Blindaje 223/W0-1.)*
- **CD-18**: PROHIBIDO tocar `errorCode`, su unión de valores y su mapeo de status en
  `routes/compose.ts:1112-1117`. El campo nuevo no cambia **ningún** status HTTP de `/compose`: un
  fallo de pipeline sigue siendo 400.

---

## 6. Contrato de datos

### 6.1 `src/types/index.ts`

```ts
export type AgentFailureKind = 'INPUT_REJECTED' | 'AGENT_ERROR';
```

Y dentro de `ComposeResult` (`:1180-1263`), con docblock en el estilo `WKH-335 (AC-N): …`:

```ts
agentFailure?: AgentFailureKind;
```

Contenido obligatorio del docblock (CD-14: cada afirmación es verificable con un input concreto):
la pregunta que responde; que **no** es `errorCode` y por qué (DT-1); la tabla de §6.2; el
invariante de ausencia (§3.4); que en el camino con retry refleja el intento del retry (§3.5); y el
puntero a §3.7 para que nadie lo unifique con la compuerta de `parseFieldErrors`.

### 6.2 `classifyAgentFailure(status)` — tabla completa

| status | kind | por qué |
|---|---|---|
| 400 | `INPUT_REJECTED` | medido en prod (work-item) y en `chaski-v3` (`agent-rejections.ts:10-13`) |
| 422 | `INPUT_REJECTED` | forma Zod; es la que usa toda la máquina de retry |
| 401 · 403 | `AGENT_ERROR` | credencial **nuestra**, no el pedido de quien llama |
| 402 | `AGENT_ERROR` | saldo **nuestro**; CD-5 ya lo colapsa del lado de Chaski |
| 404 | `AGENT_ERROR` | `invokeUrl` viejo del catálogo es config, no input |
| 408 · 429 | `AGENT_ERROR` | reintentar tras esperar **sí** puede servir (§3.3) |
| 405 · 409 · 413 · 415 · 410 · cualquier otro 4xx | `AGENT_ERROR` | plausibles pero **no medidos** (CD-13) |
| 5xx | `AGENT_ERROR` | infraestructura |
| < 400 | `AGENT_ERROR` | inalcanzable por `!response.ok`, pero la función es total y no tira |

La función es **pura y total**: no lanza para ningún `number`, incluidos `NaN`, negativos y `0`
(mismo contrato "NEVER throws" que `parseFieldErrors` declara en `field-error-parser.ts:12-13`).

### 6.3 `chaski-v3` — `GatewayFailure`

```ts
/** WKH-335: la CLASE del fallo del agente invocado, tal como la clasificó el gateway.
 *  Ausente = el gateway no lo dijo (versión vieja, proxy) o no hubo status HTTP del agente. */
agentFailure?: "INPUT_REJECTED" | "AGENT_ERROR";
```

Leído con guard de valor —no sólo de tipo— igual que el resto de `readFailureFields`: un string que
no esté en la lista cerrada **no** se copia. Nunca se ecoa al body; se usa para ramificar
(mismo criterio que `reason`, `gateway-client.ts:139-149`) y se loguea en `logGatewayFailure`
(`:380-392`), que es un canal de sólo-enums.

**Mapeo en las dos rutas:**

```
r.code === "step_failed" && r.agentFailure === "INPUT_REJECTED"
   → quote:   422 { error: QUOTE_REJECTED }        // "a2a_quote_rejected"
   → prepare: 422 { error: PREPARE_REJECTED }      // "prepare_agent_rejected"
todo lo demás → EXACTAMENTE como hoy (502 a2a_unavailable / prepare_upstream_error)
```

El guard por `code === "step_failed"` es deliberado: el campo sólo puede venir de un sobre de fallo
de pipeline, y exigirlo impide que la rama nueva dispare por un status que no es ése.

---

## 7. Waves de implementación

> Wave 1 (`wasiai-a2a`) va **entera antes** de Wave 2. Dentro de cada una, `W*.0` es serial.

### Wave 1 — `wasiai-a2a` · worktree `a2a-wkh362` · rama `feat/wkh-335-status-estructurado`

**W1.0 — contrato (SERIAL, nada depende de nada)**
- `src/types/index.ts` — `AgentFailureKind` + `agentFailure?` en `ComposeResult` con docblock (§6.1).
- `src/lib/agent-http-error.ts` **(NUEVO)** — `AgentHttpError` + `classifyAgentFailure` (§3.2, §6.2).
- `src/lib/agent-http-error.test.ts` **(NUEVO)** — tabla de §6.2 + totalidad + CD-9 (§9.2).
- Puerta de W1.0: `npx tsc -p tsconfig.json --noEmit` verde y `vitest run src/lib/agent-http-error.test.ts` verde.

**W1.1 — los tests, ANTES del cableado (es lo que produce la evidencia de AC-5)**
- `src/services/compose.test.ts` — los 4 `it` de §9.1, **escritos y corridos contra el código sin
  cablear**. Se guarda la salida en rojo (§9.5). Con W1.0 hecho, el tipo existe y nada lo puebla ⇒
  el rojo es la aserción, no un error de compilación.

**W1.2 — cableado (los tres sitios, un solo commit por CD-6)**
- `src/services/compose.ts`:
  - import de `AgentHttpError` (junto a los demás `../lib/*.js`, `:44-77`);
  - `:1755-1757` — `throw new Error(...)` → `throw new AgentHttpError(agent.slug, response.status, detail)`, **mensaje byte-idéntico** (CD-9);
  - helper `agentFailureResult(err)` junto a `withheldResult` (`:146-158`);
  - `:1146-1159` — `...agentFailureResult(retryErr)` (AC-2);
  - `:1178-1190` — `...agentFailureResult(err)` (AC-1).
- Puerta: los 4 `it` de W1.1 pasan a verde y **la suite completa** queda verde (CD-16).

**W1.3 — superficie pública y prosa**
- `src/routes/compose.test.ts` — el `it` de serialización (§9.3).
- `doc/INTEGRATION.md` — entrada del campo en la tabla de la sección 5 (§3.8, DT-6).
- Gate de cierre de Wave 1: `npx tsc -p tsconfig.json --noEmit` → `npm run lint` → `npm test`.

### Wave 2 — `chaski-v3` · worktree `chaski-wkh362` · rama `feat/wkh-335-error-no-opaco`

**W2.0 — el cliente del gateway (SERIAL)**
- `src/infrastructure/a2a/gateway-client.ts`: campo en `GatewayFailure` (~`:155`); lectura con guard
  de valor en `readFailureFields` (`:232-249`); **los dos** sitios de construcción, `:330-337` y
  `:341-353` (CD-11); `logGatewayFailure` (`:380-392`).
- **CD-12 acá mismo**: re-anclar `gateway-client.ts:216` (desde `src/infrastructure/rate-limit.ts:313`)
  y `gateway-client.ts:225` (desde `app/api/a2a/quote/route.ts:135`).
- `src/infrastructure/a2a/gateway-client.test.ts` — §9.4.

**W2.1 — los dos legs (paralelizables entre sí, los dos obligatorios por CD-7)**
- `app/api/a2a/quote/route.ts:158-170` — rama nueva **antes** del `502`; prosa de §4.4-5.
- `app/api/payout/prepare/route.ts:400-427` — ídem; prosa de §4.4-6.
- `app/api/a2a/quote/route.test.ts` y `app/api/payout/prepare/route.test.ts` — §9.4.
- ⚠️ **Ningún archivo nuevo de constantes.** DT-4: los dos enums ya existen.

**W2.2 — prosa y pantalla**
- `src/application/agent-rejections.ts` — sitios 1, 2 y 3 de §4.4; **CD-12**: re-anclar
  `agent-rejections.ts:49` (desde `gateways.ts:112`) y `:266` (desde `flow.tsx:1712`).
- `src/infrastructure/a2a/gateways.ts:112-122` — sitio 4.
- `src/presentation/flow-vm.ts:575-591` — sitio 7.
- `src/presentation/flow-vm.test.ts:1008-1047` — sitio 8 + el `it` nuevo de §9.4; **el `expect` de
  `humanError("step_failed")` NO se toca** (§4.5).
- Gate de cierre de Wave 2: `npm run qa` **y** `npm run build`.

### Fuera de las waves (Clase 1 — founder, AC-10/CD-8)
Desplegar Railway, después Vercel, y sondear producción: `amountUsd: 100000` por la ruta real de
Chaski debe dar **422 `a2a_quote_rejected`**, no 502. Ningún test de ningún repo puede sustituir
esta medición (§9.6).

---

## 8. Exemplars verificados

Todos abiertos en este F2, con rangos reales.

| Para | Exemplar | Qué se copia |
|---|---|---|
| la clase de error con status | `wasiai-a2a/src/lib/discovery-sources.ts:18-38` (`RegistryHttpError`) | forma, `readonly status`, y el candado del mensaje byte-idéntico |
| el helper de spread en el `return` | `wasiai-a2a/src/services/compose.ts:146-158` (`withheldResult`) | firma `Pick<ComposeResult, 'campo'>`, `return {}` si no aplica, spread en `:1158` y `:1189` |
| el naming del campo | `wasiai-a2a/src/types/index.ts:681-687`, `:708`, `:724-727` (`DiscoverySourceFailure`) | unión cerrada como valor de un campo `failure` |
| el docblock de campo aditivo | `wasiai-a2a/src/types/index.ts:1207-1212` (`errorCode`), `:1229-1241` (`inputMappingFailure`), `:1259-1263` (`settleRefundWithheld`) | estilo `WKH-N (AC-M): …`, con lo load-bearing marcado |
| la función pura total | `wasiai-a2a/src/lib/field-error-parser.ts:10-16` | contrato "NEVER throws" escrito en el docblock |
| el test del clasificador | `wasiai-a2a/src/lib/field-error-parser.test.ts:10-60` | tabla de casos con el string real |
| el test de AC-1 | `wasiai-a2a/src/services/compose.test.ts:2807-2853` (`T-5XX-NO-RETRY`, `T-4XX-NOFIELDS`) | armado del pipeline de 2 steps + `mockFetchError` |
| el test de AC-2 | `wasiai-a2a/src/services/compose.test.ts:2740-2769` (`T-RETRY-FAIL`) | `422 + FIELD_ERR_BODY` → `mockRegen` → segundo `mockFetchError` |
| el test de ausencia | `wasiai-a2a/src/services/compose.test.ts:2885-2909` (`T-NON-4XX`) | `mockFetch.mockRejectedValueOnce(new Error('network ECONNRESET'))` |
| la rama nueva en la route | `chaski-v3/app/api/a2a/quote/route.ts:153-169` y `app/api/payout/prepare/route.ts:406-422` (`no_agent_match`, WKH-332/AC-13) | enum propio + 422 + una sola clave + `reason` sólo para ramificar |
| el 422 de rechazo que ya existe | `chaski-v3/app/api/payout/prepare/route.ts:444-453` | `console.warn` de sólo-enums + `{ error: enum }` + `status: 422` |
| el test de Wave 2 | `chaski-v3/app/api/a2a/quote/route.test.ts:236-262` y `:266-270` | el par comparado en el MISMO `it` + `Object.keys(json) === ["error"]` |
| el lector con guard de valor | `chaski-v3/src/infrastructure/a2a/gateway-client.ts:232-249` | copiar sólo lo que matchea el tipo/valor esperado |
| la dirección del default | `chaski-v3/src/application/agent-rejections.ts:189-197` | allow-list fail-closed hacia lo vago |

---

## 9. Plan de tests

**≥1 test por AC, y todo AC que afirma un comportamiento se EJECUTA.** Una cita `archivo:línea`
dice dónde vive el código, no qué hace corriendo.

### 9.1 Los tests que CERTIFICAN (`wasiai-a2a`) — AC-1, AC-2, AC-3, AC-4, AC-5

Archivo: **`src/services/compose.test.ts`**, dentro del `describe` de `:2634`.

| id | escenario | asserta | AC |
|---|---|---|---|
| `T-335-DIRECT-4XX` | step 0 ok + step 1 `mockFetchError(400,'Bad Request')` (sin field-errors ⇒ sin retry) | `result.agentFailure === 'INPUT_REJECTED'`; `result.success === false`; `result.error` sigue conteniendo `returned 400` (CD-3/AC-4) | AC-1 |
| `T-335-DIRECT-5XX` | ídem con `mockFetchError(500)` | `result.agentFailure === 'AGENT_ERROR'` — **en el MISMO `it` que el 400**, comparados entre sí (exemplar `route.test.ts:266-270`): un test que sólo mire un caso pasaría igual con los dos mapeados al mismo valor | AC-1 |
| `T-335-RETRY` | `mockFetchError(422, FIELD_ERR_BODY)` → `mockRegen` → `mockFetchError(400,'nope')` | `agentFailure === 'INPUT_REJECTED'` **y** `result.error` contiene `after retry` (prueba que es el `return` del retry, no el directo) | AC-2 |
| `T-335-RETRY-5XX` | `422 + FIELD_ERR_BODY` → `mockRegen` → `mockFetchError(500)` | `agentFailure === 'AGENT_ERROR'` — el 422 del PRIMER intento **no** manda (§3.5). Reusa el escenario de `T-RETRY-FAIL` | AC-2 |
| `T-335-ABSENT` | `mockFetch.mockRejectedValueOnce(new Error('network ECONNRESET'))` | `'agentFailure' in result === false` — **no `undefined`, ausente** (§3.4) | AC-3/CD-10 |
| `T-335-NOLEAK` | el caso 400 con un body que incluye una URL y un secreto | `JSON.stringify(result.agentFailure)` no contiene `invokeUrl`, ni el host del agente, ni ningún fragmento del body | AC-3 |
| `T-335-BACKCOMPAT` | el pipeline **exitoso** de `T-RETRY-HAPPY` | `'agentFailure' in result === false` y el resto del objeto igual que hoy | AC-4 |

**Por qué éstos certifican y no son "un doble":** el sujeto bajo prueba es
`composeService.compose()` **real** — el clasificador, los dos `return` y el `throw` corren de
verdad. Lo único doblado es el **agente invocado** (a través de `mockFetch`), que es el tercero
cuyo comportamiento estamos reaccionando. CD-4 prohíbe doblar **al gateway**, que es nuestro propio
sujeto; doblar al tercero es lo que hace toda la suite existente. La regla, escrita para que no se
lea mal: *el sujeto bajo prueba tiene que ser código nuestro; el doble sólo puede ocupar el lugar
del tercero.*

### 9.2 Unitarios del clasificador (`src/lib/agent-http-error.test.ts`, NUEVO)

- Tabla completa de §6.2, con los pares que **discriminan** (CD-17): `399/400`, `422/423`,
  `429/500`. Nada de probar dos cláusulas con el mismo número.
- Totalidad: `NaN`, `-1`, `0`, `999` → devuelve un valor válido y **no lanza**.
- `AgentHttpError` es `instanceof Error` y su `.name` es `'AgentHttpError'`.
- **CD-9 medido, no leído**: `parseFieldErrors(new AgentHttpError('cobraya-cfdi', 422, FIELD_ERR_BODY).message)`
  devuelve los mismos campos que hoy devuelve para el string literal equivalente. Es lo que impide
  que alguien "limpie" el mensaje porque el status ya viaja estructurado.

### 9.3 Serialización (`src/routes/compose.test.ts`) — y qué NO prueba

Un `it`: `mockCompose` devuelve un `ComposeResult` de fallo **con** `agentFailure`, y el body HTTP
del 400 lo contiene. Prueba **una sola cosa**: que la ruta no descarta el campo (riesgo real, un
`schema.response` de Fastify strippea claves desconocidas; medido que hoy no hay schema, §1.1).
**NO prueba que el service lo emita** — en ese archivo `composeService` es un `vi.mock`
(`routes/compose.test.ts:117-121`). Eso lo prueba §9.1 y sólo §9.1.

### 9.4 `chaski-v3` — AC-6, AC-7, AC-8, AC-9

| archivo | id | asserta | AC |
|---|---|---|---|
| `gateway-client.test.ts` | `T-335-GW-1` | `400 + {success:false, agentFailure:"INPUT_REJECTED"}` → `{ code:"step_failed", agentFailure:"INPUT_REJECTED" }` | AC-9 |
| `gateway-client.test.ts` | `T-335-GW-2` | `200 + success:false + agentFailure` → **también** lo trae (sitio 2, CD-11) | AC-9 |
| `gateway-client.test.ts` | `T-335-GW-3` | `agentFailure: "cualquier_cosa"` / `42` / `{}` → el campo **no** se copia (guard de valor) | AC-9 |
| `quote/route.test.ts` | `T-335-Q-1` | los DOS desenlaces **en el mismo `it`**: `INPUT_REJECTED` → 422 `a2a_quote_rejected`; `AGENT_ERROR` → 502 `a2a_unavailable`. No comparten ni status ni enum | AC-6 |
| `quote/route.test.ts` | `T-335-Q-2` | `Object.keys(json) === ["error"]`; el log tiene el enum y **no** el `message` del gateway; `directCalls` vacío | AC-8 |
| `quote/route.test.ts` | `T-335-Q-3` | **ausente** el campo (gateway sin desplegar, AC-10) → 502, byte-idéntico a hoy | AC-6/CD-8 |
| `prepare/route.test.ts` | `T-335-P-1/2/3` | los mismos tres, con `prepare_agent_rejected` / `prepare_upstream_error` | AC-7/AC-8 |
| `prepare/route.test.ts` | `T-335-P-4` | `payment_required` (402) sigue colapsado en `prepare_upstream_error` | CD-5 |
| `flow-vm.test.ts` | `T-335-VM-1` | `humanError("a2a_quote_rejected")` ≠ el genérico, y `humanError("step_failed")` **sigue** siendo el genérico (§4.5) | AC-6 |
| `agent-rejections.test.ts` | `T-335-AR-1` | `QUOTE_REJECTED` sigue sin contener `fx_` — el enum sigue siendo palabra nuestra ahora que **sí** tiene productor | CD-1 |

### 9.5 Protocolo de la evidencia rojo-antes / verde-después (AC-5, CD-4)

Sin esto AC-5 no está cumplido, y no se puede sustituir por una lectura del diff:

1. Con **W1.0 mergeado y W1.2 NO cableado**, correr `npx vitest run src/services/compose.test.ts` y
   **guardar la salida literal** en `doc/sdd/226-…/evidencia-rojo-antes.md`.
2. El rojo tiene que ser el **fallo de aserción** (`expected undefined to be 'INPUT_REJECTED'`), no
   un error de import ni de compilación. Un rojo por el motivo equivocado no es evidencia de nada
   — es exactamente el "falso KILLED".
3. El **número de tests recolectados** tiene que ser el MISMO en las dos corridas. Si difiere,
   la segunda corrida no midió los mismos testigos.
4. Después de W1.2, la misma corrida en verde, guardada al lado.
5. F4 cita los dos bloques por nombre de test y por salida, no por inferencia.

### 9.6 Qué NO cubre ningún test de esta HU (declarado, no descubierto)

1. **Que el Coordinador real y Chaski real se entiendan.** No hay test cross-repo. Los tests de
   Wave 2 doblan al gateway: **un doble que emita el campo hace pasar Wave 2 aunque el Coordinador
   nunca lo emita.** Lo único que lo cierra es §9.1 del lado de `wasiai-a2a` más el sondeo de
   producción del §7 (Clase 1, founder).
2. **Que un agente real del catálogo devuelva 4xx para un monto fuera de rango.** Está medido en el
   work-item contra producción y en `chaski-v3/src/application/agent-rejections.ts:24-30`; ningún
   test de este repo lo re-mide.
3. **Statuses fuera de `{400, 422}` que en la práctica sean rechazos de input.** Por diseño caen en
   `AGENT_ERROR` (§3.3). Nadie los cubre porque nadie los midió.
4. **El orden de despliegue (AC-10).** Ningún test puede verificarlo; `T-335-Q-3` sólo prueba que el
   orden equivocado es **inocuo** (sin campo, comportamiento de hoy), no que se haya respetado.
5. **La precisión del copy.** `humanError` dice *"Probá con otro monto"* para cualquier
   `INPUT_REJECTED` (§3.6, limitación aceptada).
6. **`/orchestrate`.** Hereda el campo por tipo (§4.6) y no se agrega ningún test propio.

---

## 10. Presupuesto de diff (el CR lo contrasta — regla 10)

La pregunta que decide cada exceso: **¿qué parte de esto seguiría existiendo si lo escribiera
alguien que ya conoce estos dos repos?**

| Wave | Archivos | Código | Prosa/docblock | Tests | **Techo** |
|---|---|---|---|---|---|
| **Wave 1** (`wasiai-a2a`) | 6 (2 nuevos) | ~60 | ~95 | ~145 | **≤ 320 líneas** |
| **Wave 2** (`chaski-v3`) | 9 (0 nuevos) | ~55 | ~90 | ~185 | **≤ 350 líneas** |

Desglose de Wave 1: `agent-http-error.ts` ~55 · `agent-http-error.test.ts` ~75 · `compose.ts` ~25 ·
`types/index.ts` ~30 · `compose.test.ts` ~110 · `routes/compose.test.ts` ~25.
Desglose de Wave 2: `gateway-client.ts` ~35 · `quote/route.ts` ~18 · `prepare/route.ts` ~18 ·
las 8 prosas de §4.4 + las 4 citas de §4.3 ~55 · tests (4 archivos) ~185.

**Umbral del CR: 2x** (640 y 700). Un exceso se justifica por escrito o se recorta.

**Tres cosas que si aparecen en el diff son señal de alarma, y por qué:**
- un archivo nuevo de constantes en `chaski-v3` → DT-4 dice que los dos enums ya existen;
- cualquier cambio en `field-error-parser.ts` o en la máquina de reintento → DT-5 dice que divergen
  a propósito;
- un status HTTP nuevo en `routes/compose.ts` → CD-18.

**Lo que el presupuesto NO incluye** y no debería aparecer: refactor de `invokeAgent`, cambios en
`orchestrate.ts`, nuevos módulos en `chaski-v3`, o el `expect` de `humanError("step_failed")`.

---

## 11. Deuda técnica — la clasificación en tres clases

Instrucción vigente del founder: **"No quiero deuda técnica en esta HU (igual evaluá)"**. El
paréntesis es la instrucción: clasificar en tres clases, no barrer todo.

**Clase 3 — hay que cerrarla YA (todo esto está adentro del alcance):**
- el campo estructurado y **los dos** `return` de `compose.ts` (CD-6);
- **los dos** legs de Chaski (CD-7) y **los dos** sitios de `gateway-client.ts` (CD-11, hallazgo de este F2);
- las **8 prosas** que la HU vuelve falsas y las **4 citas** que desplaza (CD-15, CD-12);
- `doc/INTEGRATION.md` (DT-6): un campo público sin documentar no existe para quien está afuera;
- **`QUOTE_REJECTED` sin productor**: es deuda **preexistente** (WKH-335) y esta HU la cierra sin
  costo marginal, porque su productor natural es exactamente lo que Wave 2 construye. No cerrarla
  habría significado estrenar un enum paralelo y dejar el viejo muerto.

**Clase 2 — diferida con razón medida, acotada, con disparador observable:**
- `TD-362-STATUS-ORCHESTRATE`: `/orchestrate` hereda el campo por tipo, verificado en §4.6.
  **Acotamiento**: ningún consumidor de `/orchestrate` mapea el campo hoy. **Disparador**: que un
  consumidor de `/orchestrate` (dashboard, MCP tool) reporte la misma opacidad ⇒ HU nueva con su F1.
- **La allow-list de `{400, 422}`**: acotamiento explícito, no cierre. **Disparador observable**: un
  agente real que rechace input con otro status. Se detecta porque el `error` del sobre (server-only)
  y el log siguen llevando el número; el operador ve `AGENT_ERROR` con un `returned 409` al lado.
  CD-13 fija cómo se extiende.

**Clase 1 — precondición del founder, ningún agente la ejecuta:**
- el **orden de despliegue** (CD-8 / AC-10): Railway antes que Vercel;
- el **sondeo de producción** de §7 (`amountUsd: 100000` → 422, no 502), que es la única medición
  extremo a extremo del defecto que esta HU vino a cerrar.

**Nada que sea causa raíz queda diferido.**

---

## 12. `[NEEDS CLARIFICATION]` — estado

| Ítem | Estado |
|---|---|
| Nombre y shape del campo | ✅ **RESUELTO** §3.1 |
| De dónde sale el dato (DT-2) | ✅ **RESUELTO** §3.2 — opción (b) |
| El 429 del agente invocado | ✅ **RESUELTO** §3.3 — `AGENT_ERROR`, por allow-list |
| ¿Un enum compartido o dos en Chaski? | ✅ **RESUELTO** §3.6 — dos, y los dos ya existen |
| ¿Se puebla para fallos sin status de agente? | ✅ **RESUELTO** §3.4 — **ausente** |
| Orden de despliegue | 🔒 **Clase 1**, founder (CD-8 / AC-10) — no es una ambigüedad, es una acción humana |

**Cero `[NEEDS CLARIFICATION]` abiertos.**

---

## 13. Riesgos del propio diseño (para el Adversary)

1. **El campo se emite y nadie lo lee.** Mitigado por el orden de las waves y por `T-335-Q-3`
   (el orden equivocado es inocuo, no roto). No mitigado del todo: sólo el sondeo de producción cierra.
2. **`AGENT_ERROR` como bolsa de gatos.** Deliberado (§3.3): es el bucket del comportamiento de HOY.
   El riesgo real es el inverso —que alguien lo "mejore" moviendo statuses a `INPUT_REJECTED` sin
   medir— y por eso existe CD-13.
3. **Que el F3 unifique el clasificador con `parseFieldErrors`** "por consistencia". CD/DT-5 + el
   docblock en los dos módulos. Es un error ya cometido en este repo (Auto-Blindaje 223).
4. **Que el F3 dé vuelta el `expect` de T-4.1'** porque un comentario viejo se lo pide (§4.5).
5. **Que el rojo de AC-5 sea por el motivo equivocado** (import roto en vez de aserción). §9.5-2.
6. **Reusar `PREPARE_REJECTED` cambia el `failureReason` persistido de la remesa** y con él el copy
   (*"El agente de pagos rechazó esta remesa… no se movió ningún USDC"*). Verificado que las dos
   mitades son ciertas para este caso: el agente **leyó y rechazó** (4xx sobre el pedido), y el
   prepare corre **antes** de `authorizePrincipal` (`agent-rejections.ts:218-220`). El valor no es
   nuevo para el cliente: **es un productor nuevo de un valor que ya maneja**, por la misma ruta y
   con el mismo 422 que `:453`.

---

## 14. Readiness Check

| # | Ítem | Estado |
|---|---|---|
| 1 | Todas las citas del work-item re-abiertas en el árbol | ✔ — 1 drift corregido (`prepare/route.ts:391` → **`:400`**) |
| 2 | Cero paths inventados; cada exemplar abierto con rango real | ✔ §8 (15 exemplars, 2 repos) |
| 3 | Las tres decisiones abiertas del F1, **resueltas** con criterio escrito | ✔ §3.1, §3.2, §3.3 |
| 4 | Los tres `[resuelto en F2]` de Missing Inputs, cerrados | ✔ §3.1, §3.4, §3.6 |
| 5 | Cero `[NEEDS CLARIFICATION]` abiertos | ✔ §12 |
| 6 | CD del work-item heredados sin reinterpretar | ✔ §5.1 (CD-1..CD-8) |
| 7 | CD nuevos, incluidos los 3 patrones recurrentes del Auto-Blindaje | ✔ §5.2 (CD-9..CD-18; CD-14/15/16/17 del histórico 222/223/224) |
| 8 | Los DOS `return` de `compose.ts` cubiertos (CD-6) | ✔ §7 W1.2, tests §9.1 |
| 9 | Los DOS legs de Chaski cubiertos (CD-7) | ✔ §7 W2.1, tests §9.4 |
| 10 | Candado de una sola clave preservado | ✔ `T-335-Q-2`, `T-335-P-2` |
| 11 | `gateway-client.ts:343` (prohibición de parsear prosa) intacto | ✔ §5.1 CD-2; el campo es estructurado |
| 12 | Ningún campo existente de `/compose` renombrado ni quitado | ✔ CD-3, `T-335-BACKCOMPAT` |
| 13 | ≥1 test por AC | ✔ §9.1/§9.4 (AC-1..AC-9); AC-10 es Clase 1 y §9.6-4 declara por qué ningún test lo cubre |
| 14 | El test que certifica corre sobre la respuesta PROPIA de `/compose` | ✔ §9.1, con la regla del doble escrita |
| 15 | Protocolo de evidencia rojo-antes / verde-después | ✔ §9.5, con el requisito de que el rojo sea la aserción |
| 16 | Lo que los tests NO cubren, declarado | ✔ §9.6 (6 ítems) |
| 17 | Presupuesto de diff por wave + señales de alarma | ✔ §10 |
| 18 | Deuda clasificada en las tres clases | ✔ §11 |
| 19 | El gate real de CADA repo, leído de su `package.json` | ✔ CD-16 — a2a: `tsc`→`lint`→`test` (**sin `qa`**); chaski: `npm run qa` + `build` |
| 20 | Riesgo de citas desplazadas, medido en los dos repos | ✔ §4.3 (a2a: 0; chaski: 4, nombradas) |

**Veredicto: el SDD está listo para `SPEC_APPROVED`.**

### Lo que este F2 **no** midió, y el F3 tiene que medir

- La **salida literal en rojo** de §9.5. Este F2 razona por qué el rojo va a ser una aserción y no
  un error de compilación (vitest transpila con esbuild, sin type-check), pero **no lo corrió**.
- El **conteo real de líneas** del diff. §10 son techos derivados de los exemplars, no una medición.
- Que el barrido de citas de §4.3 siga dando lo mismo **después** de editar (CD-12).
