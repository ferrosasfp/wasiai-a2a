# Story File — #226 · WKH-335: El Coordinador tiene el status HTTP del agente y no lo dice

> **Este documento es autocontenido.** El Dev NO lee el SDD ni el work-item. Si algo no está acá,
> el Dev PARA y escala al Architect (ver "Escalation Rule" al final).
>
> SDD de origen (referencia para QA/CR, no para el Dev): `doc/sdd/226-wkh-335-status-del-agente-estructurado/sdd.md`
> Work item: `doc/sdd/226-wkh-335-status-del-agente-estructurado/work-item.md`
> Fecha: 2026-08-25 · Gate pasado: `SPEC_APPROVED`

---

## ⚠️ HU CROSS-REPO — DOS WAVES CON ORDEN OBLIGATORIO

| Wave | Repo | Worktree (usar ESTA ruta tal cual) | Rama | Cuándo |
|---|---|---|---|---|
| **Wave 1** | `wasiai-a2a` | `/home/ferdev/.openclaw/workspace/a2a-wkh362` | `feat/wkh-335-status-estructurado` | **PRIMERO, entera** |
| **Wave 2** | `chaski-v3` | `/home/ferdev/.openclaw/workspace/chaski-wkh362` | `feat/wkh-335-error-no-opaco` | Después de que Wave 1 cierre su gate |

⚠️ **Los DIRECTORIOS de worktree conservan un nombre viejo (`…-wkh362`), residuo de dos
renumeraciones. NO los renombres.** La HU es **WKH-335**; las ramas son `feat/wkh-335-*`.
Las dos ramas ya existen y ya están checkouteadas en sus worktrees (verificado con
`git rev-parse --abbrev-ref HEAD` en los dos).

⚠️ **WKH-335 no es un número nuevo.** `chaski-v3` ya reservaba ese ID en 7 lugares de su código y
sus tests para exactamente este trabajo (`agent-rejections.ts:48`, `agent-rejections.ts:58`,
`gateways.ts:122`, `quote/route.ts:34`, `flow-vm.test.ts:1023`, `flow-vm.test.ts:1046`,
`route.test.ts:69`). Esta HU es ese desenlace: **cierra deuda declarada, no estrena vocabulario.**

---

## Goal

`/compose` (en `wasiai-a2a`) pasa a decir, **en un campo propio de vocabulario cerrado**, si el
agente invocado **leyó el pedido y rechazó su contenido** (`INPUT_REJECTED`) o **falló por otra
cosa** (`AGENT_ERROR`). Los dos legs de dinero de `chaski-v3` (cotización y desembolso) leen ese
campo y dejan de contestar *"algo salió mal, probá de nuevo"* en el primer caso.

**El defecto, medido hoy contra producción por la ruta real de Chaski:**

| Lo que la persona escribe | Hoy | Después de las DOS waves |
|---|---|---|
| `amountUsd: 10` | 200, cotización real | igual (byte-idéntico) |
| `amountUsd: 100000` | **502 "algo salió mal, probá de nuevo"** | 422 `a2a_quote_rejected` → *"No pudimos cotizar este envío: el corredor lo rechazó. Probá con otro monto."* |
| `amountUsd: 0` | **502**, ídem | ídem |
| `amountUsd: -5` | **502**, ídem | ídem |

Un monto fuera de rango se presenta hoy como una caída del sistema, y el consejo que se da
(reintentar) **está garantizado a fallar**. "Montos topeados" es parte del producto.

La causa: `compose.ts:1743` tiene `response.status` en una variable tipada, y en `:1755-1757` lo
mete adentro de un string de prosa. Después de esa línea el número **sólo vive dentro de un
string**, y ese string es server-only por contrato del lado de Chaski
(`gateway-client.ts:343` prohíbe parsearlo).

---

## Acceptance Criteria (EARS) — copiados del SDD aprobado

### Wave 1 — `wasiai-a2a`

- **AC-1** (camino directo). WHEN un agente invocado por un step de `/compose` responde con un
  status HTTP 4xx o 5xx y el pipeline falla SIN reintento (`compose.ts:1178-1190`), the system SHALL
  incluir en el `ComposeResult` devuelto un campo nuevo, aditivo y opcional, que permita a un
  consumidor distinguir un rechazo por input (reintentar con el MISMO input no sirve) de una falla
  de infraestructura (reintentar puede servir), SIN alterar el campo `error` existente.

- **AC-2** (camino con retry). WHEN la misma clase de fallo ocurre DESPUÉS del retry adaptativo
  (`compose.ts:1146-1159`), the system SHALL incluir el MISMO campo nuevo, reflejando el desenlace
  del intento cuyo error se reporta (el del retry), en el mismo `return` — **este es un sitio de
  código DISTINTO del de AC-1 y los dos tienen que quedar cubiertos, no sólo uno.**

- **AC-3** (no leak). THE campo nuevo SHALL NOT incluir el `invokeUrl` del agente ni su cuerpo de
  respuesta crudo. Es una clasificación acotada derivada del status HTTP, no un eco.

- **AC-4** (aditivo / back-compat). WHEN un consumidor existente lee sólo `error` (el 100% del
  tráfico de hoy), the system SHALL producir un comportamiento byte-idéntico al actual. Ningún campo
  existente del sobre de `/compose` SHALL ser renombrado ni quitado.

- **AC-5** (el control que impide que la HU nazca con la deuda adentro). THE test que cierra Wave 1
  SHALL ejercitar la respuesta **PROPIA** de `/compose` de `wasiai-a2a` (no un doble de Chaski)
  contra un agente invocado que responde 4xx, y SHALL quedar como evidencia que ese test estuvo en
  **ROJO ANTES** del fix y en **VERDE después**. Un test que pasa con y sin el arreglo no cuenta
  como evidencia de AC-1/AC-2.

### Wave 2 — `chaski-v3`

- **AC-6** (leg de cotización). WHEN `runViaGateway` (invocado desde `app/api/a2a/quote/route.ts:136`)
  recibe del gateway un fallo cuyo campo nuevo indica un rechazo por input del agente de FX, DISTINTO
  de `no_agent_match` / `payment_required` / `unavailable` (que siguen colapsados), the system SHALL
  mapearlo a un enum propio de Chaski, DISTINTO del genérico `a2a_unavailable`: palabra propia, nunca
  eco del `message` del gateway.

- **AC-7** (leg de desembolso — la pata de dinero, prioridad de la HU). WHEN
  `app/api/payout/prepare/route.ts` recibe la MISMA clase de fallo del leg de payout, the system
  SHALL aplicar el MISMO mapeo que AC-6. **Arreglar sólo AC-6 y dejar este leg opaco NO satisface la
  HU**: es el camino que decide a dónde va la plata.

- **AC-8** (candados preservados). WHEN cualquiera de las dos rutas responde con el código nuevo,
  the system SHALL mantener el body con EXACTAMENTE una clave (`error`), sin el `message` crudo del
  gateway, sin la URL del agente y sin PII.

- **AC-9** (sin levantar la prohibición de parsear prosa). THE mapeo SHALL leer ÚNICAMENTE el campo
  estructurado nuevo que expone `readFailureFields` — `gateway-client.ts:343` (PROHIBIDO parsear
  `"Step N failed: ..."`) sigue intacto y vigente.

### Cierre (los dos repos)

- **AC-10** (orden de despliegue, precondición del founder — **Clase 1, no la ejecuta un agente**).
  IF Vercel (`chaski-v3`) se despliega ANTES que Railway (`wasiai-a2a`), THEN Chaski mapea un campo
  que todavía no existe en prod y el fix no cambia nada observable. El Dev **no despliega**.

---

## Contrato de Integración ⚠️ BLOQUEANTE

### `wasiai-a2a` `/compose` → `chaski-v3` `gateway-client.ts`

**Sobre de fallo de `/compose` (HTTP 400 con `success:false`) — DESPUÉS de Wave 1:**

```json
{
  "success": false,
  "output": null,
  "steps": [ /* SÓLO los steps COMPLETADOS */ ],
  "totalCostUsdc": 0.001,
  "totalLatencyMs": 812,
  "error": "Step 1 failed: Agent remit-corridor-fx-solana returned 400: {\"error\":\"invalid_input\",...}",
  "agentFailure": "INPUT_REJECTED",
  "requestId": "req-..."
}
```

- `agentFailure` es **el único campo nuevo**. Todo lo demás queda byte-idéntico (CD-3 / AC-4).
- Valores posibles: **`"INPUT_REJECTED"` | `"AGENT_ERROR"` | (ausente)**. No hay un tercer valor
  y no hay `null`.
- **Ausente ⟺ el agente invocado NO contestó con un status HTTP no-2xx** (red, DNS, timeout, SSRF,
  bucle de contratación, fallo de mapeo de input). Ausente significa *"no sé qué contestó el
  agente"*, que es distinto de `AGENT_ERROR` (*"contestó, y no fue sobre tu pedido"*).
- **El status HTTP de `/compose` NO cambia**: un fallo de pipeline sigue siendo 400.

**Regla de clasificación (allow-list, no deny-list):**

```
INPUT_REJECTED  ⟺  status del agente ∈ { 400, 422 }
AGENT_ERROR     ⟺  cualquier otro status no-2xx (401, 402, 403, 404, 405, 408, 409, 413, 415, 429, todo 5xx…)
ausente         ⟺  no hubo status HTTP del agente
```

**Errores de las rutas de Chaski, DESPUÉS de Wave 2:**

| Leg | Condición | HTTP | Body |
|---|---|---|---|
| quote | `r.code === "step_failed" && r.agentFailure === "INPUT_REJECTED"` | **422** | `{ "error": "a2a_quote_rejected" }` |
| quote | todo lo demás | igual que hoy (501 / 422 no-agente / 502) | igual que hoy |
| prepare | `r.code === "step_failed" && r.agentFailure === "INPUT_REJECTED"` | **422** | `{ "error": "prepare_agent_rejected" }` |
| prepare | todo lo demás | igual que hoy (501 / 422 no-agente / 502) | igual que hoy |

⚠️ **El guard por `code === "step_failed"` es obligatorio y deliberado**: el campo sólo puede venir
de un sobre de fallo de pipeline, y exigirlo impide que la rama nueva dispare por un status que no
es ése.

---

## Anti-Hallucination Checklist — específico de esta HU

Marcá cada uno **antes** de escribir código. Todos fueron medidos por el Architect el 2026-08-25 en
los dos worktrees; si alguno no da lo que dice acá, **PARÁ y escalá**.

- [ ] `src/lib/agent-http-error.ts` **NO existe** en `a2a-wkh362`. Lo creás vos. (medido: `ls` → No such file)
- [ ] El identificador `agentFailure` tiene **cero ocurrencias** en `a2a-wkh362/src/`. (medido: `grep -rn "agentFailure" src/` → 0 hits)
- [ ] ⛔ **`npm run qa` NO EXISTE en `wasiai-a2a`.** Sus scripts son: `dev`, `build`, `start`, `lint` (`biome check src/`), `format`, `test` (`vitest run`), `test:coverage`, `smoke:downstream`, `migrate:preflight`. (medido en `package.json:7-16`)
- [ ] ✅ `npm run qa` **SÍ existe en `chaski-v3`** = `lint && typecheck && typecheck:scripts && test`. (medido en `package.json:8-19`)
- [ ] `src/routes/compose.ts` **no tiene ningún `schema:`** en la ruta POST `/` — Fastify no va a strippear el campo nuevo. No agregues uno.
- [ ] `QUOTE_REJECTED = "a2a_quote_rejected"` **ya existe** en `chaski-v3/src/application/agent-rejections.ts:49`. **No la crees de nuevo.**
- [ ] `PREPARE_REJECTED = "prepare_agent_rejected"` **ya existe** en `chaski-v3/src/application/agent-rejections.ts:64`. **No la crees de nuevo.**
- [ ] `readQuoteRejection` (`chaski-v3/src/infrastructure/a2a/gateways.ts:96-131`) **ya sabe leer** `QUOTE_REJECTED` y `A2aQuoteGateway` ya lo tira como `Error` (`:150-152`). No toques esa cadena.
- [ ] `humanError` (`chaski-v3/src/presentation/flow-vm.ts:595-596`) **ya tiene el copy**: *"No pudimos cotizar este envío: el corredor lo rechazó. Probá con otro monto."* No escribas copy nuevo.
- [ ] El `if (!r.ok)` del payout está en **`app/api/payout/prepare/route.ts:400`**, NO en `:391`. (`:391` es parte del `await runViaGateway`. El work-item original tenía este número mal; el SDD lo corrigió.)
- [ ] `gateway-client.ts` tiene **DOS** sitios que arman un fallo: `:330-337` (vía `readFailureFields`) y `:341-353` (armado **a mano**, sin `readFailureFields`).
- [ ] Las 4 citas que se desplazan existen hoy exactamente acá (medido con `grep -rn` en `src/ app/` de `chaski-v3`):
      `src/infrastructure/rate-limit.ts:313` → `gateway-client.ts:216-217`;
      `app/api/a2a/quote/route.ts:135` → `gateway-client.ts:225`;
      `src/infrastructure/a2a/gateways.ts:112` → `agent-rejections.ts:49`;
      `src/presentation/flow.tsx:1712` → `agent-rejections.ts:266`.
- [ ] `chaski-v3` **NO tiene guardián de citas** (sus `*guard*.test.ts` son de otras cosas). Nada va a cazar una cita rota: el instrumento sos vos.
- [ ] En `wasiai-a2a` **sí** hay guardián (`test/cited-lines-guard.citations.ts`), pero las únicas citas declaradas hacia los archivos que tocás son `src/services/compose.ts:571` y `src/types/index.ts:217-218`, **las dos ANTES de todo punto de inserción de esta HU** ⇒ exposición cero. Igual el guardián corre en `npm test`.
- [ ] **No hay ningún `try/catch` intermedio** entre el `throw` de `compose.ts:1755-1757` y los dos `catch` que lo reciben (`:733` y `:1092`). Una subclase de `Error` llega intacta. (Medido: el único `try/catch` de `invokeAgent` envuelve `validateRegistryUrl` y corre ANTES del fetch.)

---

## Files to Modify/Create

### Wave 1 — `wasiai-a2a` (worktree `/home/ferdev/.openclaw/workspace/a2a-wkh362`)

**6 archivos, 2 nuevos.** Cualquier archivo fuera de esta tabla ⇒ PARÁ y escalá.

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---|---|---|---|
| 1 | `src/types/index.ts` | Modificar | `export type AgentFailureKind = 'INPUT_REJECTED' \| 'AGENT_ERROR';` junto a las uniones de clasificación (al lado de `DiscoverySourceFailure`, `:681-687`) + `agentFailure?: AgentFailureKind;` dentro de `ComposeResult`, después del bloque `inputMappingFailure` | E-3 y E-4 |
| 2 | `src/lib/agent-http-error.ts` | **Crear** | `AgentHttpError extends Error` + `classifyAgentFailure(status)`. Módulo leaf: sólo importa el tipo de `../types/index.js` | E-1 y E-5 |
| 3 | `src/lib/agent-http-error.test.ts` | **Crear** | Tabla de clasificación con pares que discriminan + totalidad + el candado CD-9 | E-6 |
| 4 | `src/services/compose.ts` | Modificar | import + `throw new AgentHttpError(...)` en `:1755-1757` + helper `agentFailureResult` junto a `withheldResult` + **los DOS** `return` (`:1146-1159` y `:1178-1190`) | E-2 |
| 5 | `src/services/compose.test.ts` | Modificar | Los 7 `it` de la tabla de tests (los que CERTIFICAN, AC-5) dentro del `describe` de `:2634` | E-7, E-8, E-9 |
| 6 | `src/routes/compose.test.ts` | Modificar | 1 `it` de serialización (que la ruta no descarta el campo) | — |
| 7 | `doc/INTEGRATION.md` | Modificar | Entrada del campo nuevo en la tabla de errores de la sección 5 (~`:1042`, donde ya viven `errorCode: INPUT_MAPPING_FAILED` e `inputMappingFailure`) | la fila `400` con `errorCode: INPUT_MAPPING_FAILED` |

> (7 filas, 6 archivos de código + 1 de doc. El presupuesto de §"Presupuesto de diff" cuenta 6 archivos de código.)

### Wave 2 — `chaski-v3` (worktree `/home/ferdev/.openclaw/workspace/chaski-wkh362`)

**9 archivos, 0 nuevos.** ⚠️ **Ningún archivo nuevo de constantes.**

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---|---|---|---|
| 1 | `src/infrastructure/a2a/gateway-client.ts` | Modificar | campo en `GatewayFailure` (~`:155`) + guard de VALOR en `readFailureFields` (`:232-249`) + **los DOS** sitios de construcción (`:330-337` y `:341-353`) + `logGatewayFailure` (`:380-392`) | E-10 |
| 2 | `src/infrastructure/a2a/gateway-client.test.ts` | Modificar | `T-335-GW-1/2/3` | `T-A2.4b`, `:424-432` |
| 3 | `app/api/a2a/quote/route.ts` | Modificar | rama nueva en `:158-170`, ANTES del `502`; + reescribir la prosa de `:146-157` | E-11 |
| 4 | `app/api/a2a/quote/route.test.ts` | Modificar | `T-335-Q-1/2/3` | E-12 (`:236-262` y `:266-270`) |
| 5 | `app/api/payout/prepare/route.ts` | Modificar | rama nueva en `:400-427`, ANTES del `502`; + reescribir la prosa de `:405-412` | E-11 + `:444-453` |
| 6 | `app/api/payout/prepare/route.test.ts` | Modificar | `T-335-P-1/2/3/4` | E-12 |
| 7 | `src/application/agent-rejections.ts` | Modificar | **sólo prosa** (docblocks de `:44-49`, `:51-58`, `:66-88`) + re-anclar 2 citas. **Cero constantes nuevas.** | — |
| 8 | `src/infrastructure/a2a/gateways.ts` | Modificar | **sólo prosa** del comentario de `:112-122` | — |
| 9 | `src/presentation/flow-vm.ts` | Modificar | **sólo prosa** del comentario de `:575-594`. El `if (code.includes("a2a_quote_rejected"))` de `:595-596` **NO se toca** | — |
| 10 | `src/presentation/flow-vm.test.ts` | Modificar | reescribir la declaración de `:1008-1027` + `T-335-VM-1`. ⛔ **El `expect` de `humanError("step_failed")` en `:1045-1046` NO se toca** | — |
| 11 | `src/application/agent-rejections.test.ts` | Modificar | `T-335-AR-1` | — |

---

## Exemplars — fragmentos reales, verificados el 2026-08-25

### E-1 · La clase de error con status — `wasiai-a2a/src/lib/discovery-sources.ts:19-38`

**Usar para**: archivo #2 de Wave 1 (`agent-http-error.ts`). **Es el mismo problema, ya resuelto en
este repo, con el mismo candado de mensaje byte-idéntico.**

```ts
/**
 * Error de un registro que respondió con un status no-2xx.
 *
 * Existe para que el fanout pueda clasificar `http_error` sin parsear el mensaje.
 * El `message` se mantiene BYTE-IDÉNTICO al `Error` genérico que había antes
 * (`Registry ${name} returned ${status}`) para no romper ningún test que lo asserte.
 * ...
 */
export class RegistryHttpError extends Error {
  public readonly status: number;
  constructor(registryName: string, status: number) {
    super(`Registry ${registryName} returned ${status}`);
    this.name = 'RegistryHttpError';
    this.status = status;
  }
}
```

**Lo que se copia**: la forma, el `public readonly status`, el `this.name`, y **el candado del
mensaje byte-idéntico escrito en el docblock**.

### E-2 · El helper de spread en el `return` — `wasiai-a2a/src/services/compose.ts:141-158`

**Usar para**: archivo #4 de Wave 1 (`agentFailureResult`). Se declara **junto a este**.

```ts
/**
 * HU-203: traduce la retención al campo de `ComposeResult` que lee
 * `services/orchestrate.ts` para decidir sobre el débito del step 0. Un solo lugar
 * donde se arma, para que los dos `return` de error del catch no puedan divergir.
 */
function withheldResult(
  withholding: SettleWithholding | undefined,
  step: number,
): Pick<ComposeResult, 'settleRefundWithheld'> {
  if (!withholding) return {};
  return {
    settleRefundWithheld: { step, reason: withholding.reason, txHash: withholding.txHash },
  };
}
```

**Lo que se copia**: la firma `Pick<ComposeResult, 'campo'>`, el `return {}` cuando no aplica (que
es lo que produce la **AUSENCIA**, no un `undefined` explícito), y el spread en **los mismos dos
`return`** (`:1158` y `:1189`).

### E-3 · El naming del campo — `wasiai-a2a/src/types/index.ts:681-687`

**Usar para**: archivo #1 de Wave 1. Precedente exacto de *"campo `failure` cuyo valor es una unión
cerrada de clases"*.

```ts
export type DiscoverySourceFailure =
  | 'http_error'
  | 'timeout'
  | 'ssrf_blocked'
  | 'circuit_open'
  | 'bad_payload'
  | 'unknown';
```

Se consume como `failure?: DiscoverySourceFailure` (`:708`) y `failure: DiscoverySourceFailure`
(`:726`). **El prefijo `agent` en `agentFailure` es imprescindible**: en este archivo "failure"
solo ya significa "de una fuente de discovery".

### E-4 · El docblock de campo aditivo — `wasiai-a2a/src/types/index.ts:1207-1212` y `:1229-1241`

**Usar para**: archivo #1 de Wave 1. Estilo `WKH-N (AC-M): …`, con lo load-bearing marcado.

```ts
  errorCode?:
    | 'SCOPE_DENIED'
    | 'DEST_CAP_EXCEEDED'
    | 'INPUT_MAPPING_FAILED'
    | 'CONTRACTING_LOOP_DETECTED'
    | 'CONTRACTING_DEPTH_EXCEEDED';
  ...
  /**
   * WKH-305: detalle accionable del fallo de `inputFromPrevious`. Paralelo exacto
   * de `scopeDeniedTarget`: el `error` en texto también nombra step, campo y
   * origen, pero un cliente no debería tener que parsearlo para reaccionar.
   * ...
   */
  inputMappingFailure?: { ... };
```

### E-5 · La función pura y total — `wasiai-a2a/src/lib/field-error-parser.ts:1-31`

**Usar para**: `classifyAgentFailure`. Copiar **el contrato "NEVER throws" escrito en el docblock**.

```ts
/**
 * Contract (CD-10):
 *  - Pure: no I/O.
 *  - NEVER throws for ANY input — any internal exception degrades to `null`.
 *  - Only 4xx are considered (5xx / no-status → null).
 */
export function parseFieldErrors(errorMessage: string): string[] | null {
  try {
    const statusMatch = /returned (\d{3})/.exec(errorMessage);
    const statusDigits = statusMatch?.[1];
    if (statusDigits === undefined) return null;
    const status = Number.parseInt(statusDigits, 10);
    if (status < 400 || status >= 500) return null;
    ...
```

⛔ **ESTE ARCHIVO NO SE TOCA.** Ver "Las 7 cosas", punto 5.

### E-6 · Los helpers de test de `compose.test.ts:209-226`

**Usar para**: archivos #3 y #5 de Wave 1.

```ts
function mockFetchOk(data: unknown = { result: 'ok' }) {
  mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => data });
}
function mockFetchError(status: number, body = '{"error":"fail"}') {
  mockFetch.mockResolvedValueOnce({
    ok: false, status, json: async () => JSON.parse(body), text: async () => body,
  });
}
```

`mockFetch` stubea el `fetch` global **y** el de `undici` (`compose.test.ts:74-80`).

### E-7 · El `describe` donde entran los tests nuevos — `compose.test.ts:2634-2660`

```ts
describe('composeService.compose — WKH-130 adaptive input-retry', () => {
  function mockAgentsBySlug(agents: Record<string, Agent>) { ... }
  // body 422 con field-errors Zod (parser → ['senderName']).
  const FIELD_ERR_BODY =
    '{"error":"invalid_input","details":{"fieldErrors":{"senderName":["Required"]}}}';
  function netSpend(): number { ... }
```

### E-8 · Exemplar del camino DIRECTO — `compose.test.ts:2807-2853` (`T-5XX-NO-RETRY`, `T-4XX-NOFIELDS`)

```ts
  it('T-4XX-NOFIELDS: 400 "Bad Request" → regen 0 calls', async () => {
    const a1 = makeAgent({ slug: 'kyc', priceUsdc: 0.001 });
    const a2 = makeAgent({ slug: 'corridor', priceUsdc: 0.05, id: 'agent-2' });
    mockAgentsBySlug({ kyc: a1, corridor: a2 });
    mockFetchOk();
    mockFetchError(400, 'Bad Request');

    const result = await composeService.compose({
      steps: [{ agent: 'kyc', input: {} }, { agent: 'corridor', input: {} }],
      scopingKeyRow: makeKeyRow({ id: 'k1', owner_ref: 'owner-test' }),
      chainId: 2368,
      a2aKey: 'wasi_a2a_test',
    });

    expect(result.success).toBe(false);
    expect(mockRegen).not.toHaveBeenCalled();
  });
```

`400 'Bad Request'` **no tiene field-errors parseables ⇒ no hay retry ⇒ cae al `return` directo**
(`:1178-1190`). Eso es lo que hace de este el exemplar de AC-1.

### E-9 · Exemplar del camino CON RETRY — `compose.test.ts:2740-2769` (`T-RETRY-FAIL`)

```ts
  it('T-RETRY-FAIL: 422+fields → regen → 500; 2 debits + 2 refunds; net = 0', async () => {
    ...
    mockFetchOk();
    mockFetchError(422, FIELD_ERR_BODY); // 1er intento falla
    mockFetchError(500);                 // re-invoke falla
    mockRegen.mockResolvedValueOnce({ q: 'x', senderName: 'Ana' });
    ...
    expect(result.error).toContain('after retry');
    expect(result.error).toContain('returned 422');
    expect(result.error).toContain('returned 500');
```

**El escenario del retry ya está armado**: el test nuevo de AC-2 sólo cambia el status del segundo
`mockFetchError`. Y el exemplar de la AUSENCIA es `T-NON-4XX` (`:2885-2909`):
`mockFetch.mockRejectedValueOnce(new Error('network ECONNRESET'))`.

### E-10 · El lector con guard de VALOR — `chaski-v3/src/infrastructure/a2a/gateway-client.ts:230-249`

```ts
/** Copia los campos granulares del body de error del gateway SIN traducirlos (§5 del Story).
 *  Sólo `code`/`error_code` → gatewayCode, `reason`, `step` numérico y `error` → message. */
function readFailureFields(body: unknown): Omit<GatewayFailure, "ok" | "code"> {
  if (!isRecord(body)) return {};
  const step = typeof body.step === "number" ? body.step : undefined;
  const gatewayCode =
    typeof body.code === "string" ? body.code
      : typeof body.error_code === "string" ? body.error_code : undefined;
  const reason = typeof body.reason === "string" ? body.reason : undefined;
  const message = typeof body.error === "string" ? body.error : undefined;
  return {
    ...(step !== undefined ? { step } : {}),
    ...(gatewayCode !== undefined ? { gatewayCode } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}
```

⚠️ El campo nuevo se lee con guard **de VALOR**, no sólo de tipo: un string que no sea exactamente
`"INPUT_REJECTED"` o `"AGENT_ERROR"` **no se copia**.

### E-11 · La rama nueva en la route — `chaski-v3/app/api/a2a/quote/route.ts:158-170`

```ts
  if (!r.ok) {
    logGatewayFailure("quote", r);
    if (r.code === "not_configured")
      return NextResponse.json({ error: "a2a_not_configured" }, { status: 501 });
    // 🔴 El `code` NO alcanza (AR/BLQ-MED-1): ...
    if (r.code === "no_agent_match" && noAgentMeansNobodyFits(r.reason))
      return NextResponse.json({ error: QUOTE_NO_AGENT_FOR_CAPABILITY }, { status: 422 });
    return NextResponse.json({ error: "a2a_unavailable" }, { status: 502 });
  }
```

El gemelo del payout (`prepare/route.ts:400-427`) tiene la misma forma y termina en:

```ts
    return NextResponse.json(
      { error: r.code === "not_configured" ? "prepare_not_configured" : "prepare_upstream_error" },
      { status: r.code === "not_configured" ? 501 : 502 },
    );
```

Y el 422 de rechazo que YA existe del lado del payout (`prepare/route.ts:444-453`), que es el patrón
exacto del desenlace nuevo:

```ts
  const rejection = readPayoutRejection(result);
  if (rejection) {
    console.warn("[payout-prepare] agent_rejected", {
      reason: rejection.logged, relayed: rejection.enum,
    });
    return NextResponse.json({ error: rejection.enum }, { status: 422 });
  }
```

### E-12 · El test de Wave 2 — `chaski-v3/app/api/a2a/quote/route.test.ts:236-270`

**Es el exemplar que más importa.** El comentario de `:266-270` es la regla:

```ts
  // 🔴 LOS DOS DESENLACES EN EL MISMO `it`, COMPARADOS ENTRE SÍ. Un test que sólo mire el caso nuevo
  // no prueba que se DISTINGAN: pasaría igual con los dos mapeados al mismo enum.
```

Y el candado de una sola clave (`:250-260`):

```ts
    const res = await POST(req({ amountUsd: 400 }));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json).toEqual({ error: "a2a_no_agent_for_capability" });
    expect(Object.keys(json)).toEqual(["error"]); // CD-8: cero eco del gateway en el body
    expect(directCalls).toHaveLength(0);          // cero fallback silencioso
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).toContain("no_agent_match");
    expect(logged).not.toContain("no agent matched capability"); // el message NO se loguea
```

El router doble está en `:85-109` (`gwRouter({ compose, status, composeThrows, captureCompose })`),
y stubea el `fetch` global.

---

## 🔴 LAS SIETE COSAS QUE ESTA HU NO PUEDE PERDER

Leelas antes de empezar y volvé a leerlas antes de cerrar cada wave. Cada una es un error concreto
que el SDD midió como probable.

### 1. Los DOS sitios de Wave 1 son `return` DISTINTOS

`compose.ts:1178-1190` (directo) y `compose.ts:1146-1159` (con retry) **no comparten nada**. No es
un `return` con una variable: son dos bloques de código separados por ~20 líneas.
**Cerrar uno deja la mitad de los fallos igual de opacos** (CD-6). Cada uno lleva su
`...agentFailureResult(<err de SU catch>)`:

- `:1158` (retry) → `...agentFailureResult(retryErr)` — la variable del `catch (retryErr)` de `:1092`
- `:1189` (directo) → `...agentFailureResult(err)` — la variable del `catch (err)` de `:733`

### 2. Los DOS legs de Wave 2

`app/api/a2a/quote/route.ts` **y** `app/api/payout/prepare/route.ts`. Arreglar sólo la cotización
deja opaco el camino que decide a dónde va la plata (CD-7).
⚠️ **El `if (!r.ok)` del payout está en `:400`, NO en `:391`.** (`:391` es el `await runViaGateway`.
El work-item traía el número viejo; el SDD lo midió y lo corrigió.)

### 3. `gateway-client.ts` tiene DOS sitios que arman un fallo

- `:330-337` — el `if (!res.ok)`, que **sí** pasa por `readFailureFields(parsed)` ⇒ extender el
  lector lo cubre solo. **Verificalo, no lo asumas.**
- `:341-353` — el `200 + success:false`, que arma su objeto **A MANO**, sin `readFailureFields`.
  **Si sólo tocás el lector, este sitio queda sin el campo** y el mismo fallo se clasifica distinto
  según el status con que llegue: la misma asimetría silenciosa que CD-6 previene del otro lado.
  Cuesta una línea (CD-11).

### 4. Wave 2 NO crea vocabulario

`QUOTE_REJECTED = "a2a_quote_rejected"` y `PREPARE_REJECTED = "prepare_agent_rejected"` **ya
existen** en `src/application/agent-rejections.ts:49` y `:64`, **sin productor**, esperando
exactamente esto. **Cero constantes nuevas.** Un archivo de constantes nuevo en Chaski es una de
las tres señales de alarma del presupuesto de diff.

Los tres eslabones del lado del cliente también ya están construidos:
`readQuoteRejection` reconoce el enum (`gateways.ts:123-131`), `A2aQuoteGateway` lo tira
(`gateways.ts:150-152`), y `humanError` tiene su copy (`flow-vm.ts:595-596`).

### 5. NO unificar el clasificador con `parseFieldErrors` "por consistencia"

`parseFieldErrors` gatea el reintento con `400 ≤ status < 500` (`field-error-parser.ts:31`); el
clasificador nuevo dice `INPUT_REJECTED` sólo para `{400, 422}`. **Divergen A PROPÓSITO y ninguna
de las dos es la otra:**

- la compuerta del retry pregunta *"¿vale la pena reintentar con un input **regenerado por un
  LLM**?"* — un 403 con `fieldErrors` legibles califica;
- el clasificador pregunta *"¿reintentar con el **MISMO** input puede cambiar algo?"* — un 403 no
  califica.

⛔ **`src/lib/field-error-parser.ts` no se toca.** Cualquier cambio ahí es señal de alarma del
presupuesto. Escribí la razón de la divergencia en el docblock de **los dos** módulos: sin ese
texto, el próximo que lea los dos números unifica y rompe uno. **Es un error ya cometido en este
repo** (Auto-Blindaje de la HU 223).

### 6. NO dar vuelta el `expect` de T-4.1' (`flow-vm.test.ts:1045-1046`)

El propio archivo dice: *"Si algún día WKH-335 aterriza, ESTE `expect` es el que hay que dar
vuelta"*, sobre:

```ts
    expect(humanError("step_failed")).toBe("Algo salió mal. Intentá de nuevo.");
```

**Medido: NO hay que darlo vuelta.** Después de Wave 2 el cliente **nunca recibe `step_failed` como
`error` del body**: la route lo traduce a `a2a_quote_rejected` **antes**. `humanError("step_failed")`
sigue —correctamente— dando el copy genérico, porque `step_failed` sigue siendo el bucket de lo que
no se pudo clasificar.

**Ese comentario es una trampa: un Dev obediente rompe un candado válido.** Lo que cambia es
(a) la **declaración** en prosa de `:1008-1027` y `:1044`, y (b) que hace falta un `it` **nuevo**
(`T-335-VM-1`) que recorra la cadena nueva.

### 7. Las 4 citas que se desplazan y las 8 prosas que quedan falsas

`chaski-v3` **NO tiene guardián de citas**. Nada las va a cazar. Van una por una, más abajo, en los
checklists de W2.0 y W2.2.

---

## Constraint Directives

### OBLIGATORIO

- **CD-4**: el test de AC-5 corre sobre la respuesta **PROPIA** de `/compose`, nunca contra un doble
  de Chaski, y queda la evidencia del rojo-antes. Ver "Protocolo de evidencia".
- **CD-6**: cubrir **los DOS** caminos del Coordinador: directo (`compose.ts:1178-1190`) y con
  reintento (`compose.ts:1146-1159`).
- **CD-7**: en Wave 2, arreglar **los DOS** legs de dinero: `app/api/a2a/quote/route.ts` y
  `app/api/payout/prepare/route.ts`.
- **CD-9**: el `message` del `AgentHttpError` es **BYTE-IDÉNTICO** al string que hoy arma
  `compose.ts:1755-1757`. Es lo que mantiene verdes `parseFieldErrors`, la máquina de reintento y
  los asserts existentes sobre `result.error`.
  **Se prueba con un test** que asserte que
  `parseFieldErrors(new AgentHttpError('foo', 422, BODY).message)` sigue devolviendo los campos —
  **no con una lectura del diff.**
- **CD-11**: cubrir **los DOS** sitios de `gateway-client.ts` que construyen un fallo: `:330-337`
  y `:341-353`.
- **CD-12**: re-anclar las **4 citas** desplazadas **en el mismo commit** que las desplaza, y
  re-correr el barrido después de editar.
- **CD-13**: la regla para extender la allow-list de `INPUT_REJECTED` va escrita en el docblock del
  clasificador, con los dos casos medidos que justifican `400` y `422`.
- **CD-15**: reescribir, **en el mismo commit**, las prosas que esta HU vuelve falsas: las 8 de
  `chaski-v3` + la entrada nueva de `doc/INTEGRATION.md` en `wasiai-a2a`.
- **CD-16**: el veredicto de wave es la **suite completa del repo** y el gate de cierre es la
  secuencia completa, en orden. Ver "Gates".
- **CD-17**: los tests de borde del clasificador usan **pares que discriminan**: `399/400`,
  `422/423`, `429/500`. **PROHIBIDO** que un test use el mismo status para probar dos cláusulas
  distintas.

### PROHIBIDO

- **CD-1**: ecoar el `invokeUrl` del agente invocado o su cuerpo de respuesta crudo — ni en el campo
  nuevo de `wasiai-a2a`, ni en el body HTTP de `chaski-v3`.
- **CD-2**: parsear en `chaski-v3` el string `"Step N failed: …"`. `gateway-client.ts:343` sigue
  vigente. Esta HU levanta la opacidad **AGREGANDO** un campo, jamás habilitando ese parseo.
- **CD-3**: renombrar o quitar cualquier campo existente del sobre de `/compose` (`error`,
  `errorCode`, `success`, `steps`, `totalCostUsdc`, `totalLatencyMs`, `verificationStatus`,
  `settleRefundWithheld`, `failedSources`, `catalogStatus`, …). **Estrictamente aditivo.**
- **CD-5**: cambiar el criterio de colapso de `payment_required` (402) / `unavailable` en Chaski.
  Siguen siendo estado operativo NUESTRO, no del pedido de quien llama.
- **CD-10**: poblar `agentFailure` cuando **no hubo status HTTP del agente**. La ausencia es un valor
  con significado y no se rellena. `agentFailureResult` devuelve `{}`, no `{ agentFailure: undefined }`.
- **CD-14**: escribir en un docblock una afirmación falsable que no hayas ejecutado en esta HU. Si
  la frase se puede poner a prueba con un comando, o la corrés y anotás el resultado, o no la
  escribís.
- **CD-18**: tocar `errorCode`, su unión de valores, o su mapeo de status en
  `src/routes/compose.ts:1112-1117`. **El campo nuevo NO cambia NINGÚN status HTTP de `/compose`**:
  un fallo de pipeline sigue siendo 400.
- **Sin dependencias nuevas** en ninguno de los dos repos. Ninguna. Lista vacía.

---

## Contrato de datos exacto

### `wasiai-a2a/src/types/index.ts`

```ts
export type AgentFailureKind = 'INPUT_REJECTED' | 'AGENT_ERROR';
```

Y dentro de `ComposeResult` (que va de `:1180` a `:1263`), después del bloque `inputMappingFailure`:

```ts
agentFailure?: AgentFailureKind;
```

**El docblock DEBE contener** (y cada afirmación tiene que ser verificable con un input concreto —
CD-14):

1. la pregunta que responde: *"¿el agente invocado rechazó lo que le mandaron?"*;
2. que **no** es `errorCode` y por qué: `errorCode` enumera motivos por los que el **gateway mismo**
   rechaza el pipeline (scope, cap de destino, bucle de contratación); `agentFailure` describe qué
   contestó el **agente invocado**. Dos preguntas, dominios distintos;
3. la tabla de clasificación de abajo;
4. el invariante de ausencia: **`agentFailure` presente ⟺ el agente invocado contestó con un status
   HTTP no-2xx**;
5. que en el camino con retry refleja el intento del **retry**;
6. el puntero a `agent-http-error.ts` para que nadie lo unifique con la compuerta de
   `parseFieldErrors`.

**Por qué DOS valores y no el status crudo**: el número desnudo obliga a cada consumidor a
re-implementar la clasificación, y cada uno la haría distinta. El campo responde UNA pregunta, y el
número sigue disponible server-side en `error` y en los logs, que es donde el operador lo necesita.

**Por qué `AGENT_ERROR` y no `AGENT_UNAVAILABLE`**: un 401/403 del agente no es "no disponible"; es
"nos dijo que no por algo que no es el contenido del pedido". `AGENT_ERROR` no afirma de quién es la
culpa ni si el agente está vivo, que es lo único que podemos sostener.

**Plano, no objeto — y es una decisión, no una omisión.** No lleva `step`. `/compose` aborta en el
PRIMER step que falla y los dos `return` devuelven `steps: results`, o sea sólo los COMPLETADOS ⇒
el índice del step que falló es exactamente `steps.length`, y Chaski ya lo deriva así
(`gateway-client.ts:345-346`). Un `step` acá sería un segundo lugar que dice lo mismo.

### `wasiai-a2a/src/lib/agent-http-error.ts` (NUEVO)

```ts
export class AgentHttpError extends Error {
  public readonly status: number;
  public readonly kind: AgentFailureKind;
  constructor(agentSlug: string, status: number, detail: string) {
    super(`Agent ${agentSlug} returned ${status}${detail ? `: ${detail}` : ''}`); // BYTE-IDÉNTICO (CD-9)
    this.name = 'AgentHttpError';
    this.status = status;
    this.kind = classifyAgentFailure(status);
  }
}

export function classifyAgentFailure(status: number): AgentFailureKind { /* … */ }
```

**`classifyAgentFailure` — tabla completa y normativa:**

| status | kind | por qué |
|---|---|---|
| **400** | `INPUT_REJECTED` | medido en prod y en `chaski-v3` (`fx_amount_below_minimum` / `fx_amount_above_maximum`) |
| **422** | `INPUT_REJECTED` | forma Zod; es la que usa toda la máquina de retry |
| 401 · 403 | `AGENT_ERROR` | credencial **nuestra**, no el pedido de quien llama |
| 402 | `AGENT_ERROR` | saldo **nuestro**; CD-5 ya lo colapsa del lado de Chaski |
| 404 | `AGENT_ERROR` | `invokeUrl` viejo del catálogo es config, no input |
| 408 · 429 | `AGENT_ERROR` | reintentar tras esperar **sí** puede servir |
| 405 · 409 · 410 · 413 · 415 · cualquier otro 4xx | `AGENT_ERROR` | plausibles pero **no medidos** (CD-13) |
| 5xx | `AGENT_ERROR` | infraestructura |
| < 400 | `AGENT_ERROR` | inalcanzable por `!response.ok`, pero la función es **total** y no tira |

**La función es PURA y TOTAL: no lanza para NINGÚN `number`, incluidos `NaN`, negativos y `0`.**
Mismo contrato "NEVER throws" que declara `field-error-parser.ts:12-13`.

**Por qué allow-list y no deny-list** (escribilo en el docblock, es CD-13): empezar por
*"todo 4xx es INPUT_REJECTED salvo una lista"* se cae solo — cada excepción olvidada produce
**exactamente el defecto de esta HU, invertido**: decirle a la persona *"revisá el monto"* cuando
lo que pasó fue que **nuestra** Agent Key se quedó sin saldo (402), **nuestra** credencial venció
(401), o el `invokeUrl` del catálogo quedó viejo (404). Cambiar "el sistema se cayó" por "es culpa
tuya" no es un arreglo. **Con allow-list, olvidarse de un status deja el comportamiento de HOY**,
que es el bucket vago y genérico.

**El 429 es `AGENT_ERROR`, y eso es la decisión, no una omisión**: (i) la semántica que el campo
promete es *"reintentar con el MISMO input no puede cambiar el resultado"*, y para un rate-limit eso
es **falso**; (ii) `AGENT_ERROR` ya mapea a *"Algo salió mal. Intentá de nuevo."*, que para un 429
es **vago y CIERTO**. Ídem el 408.

### `wasiai-a2a/src/services/compose.ts`

```ts
// junto a withheldResult (:141-158)
function agentFailureResult(err: unknown): Pick<ComposeResult, 'agentFailure'> {
  return err instanceof AgentHttpError ? { agentFailure: err.kind } : {};
}
```

El `throw` de `:1755-1757` pasa de:

```ts
      throw new Error(
        `Agent ${agent.slug} returned ${response.status}${detail ? `: ${detail}` : ''}`,
      );
```

a:

```ts
      throw new AgentHttpError(agent.slug, response.status, detail);
```

⚠️ **El `message` resultante tiene que ser byte-idéntico** — misma interpolación, mismo espacio,
mismo `: ` condicional (CD-9).

⚠️ **`detail` se sigue calculando igual**: `(await response.text()).slice(0,300).replace(/\s+/g,' ').trim()`
dentro del `try/catch` que degrada a `''`. No lo toques.

El import va en el bloque de `../lib/*.js` (`compose.ts:44-77`), en orden alfabético — entre
`downstream-skip-code.js` y `field-error-parser.js`.

### `chaski-v3/src/infrastructure/a2a/gateway-client.ts` — `GatewayFailure`

```ts
  /** WKH-335: la CLASE del fallo del agente invocado, tal como la clasificó el gateway.
   *  Ausente = el gateway no lo dijo (versión vieja, proxy) o no hubo status HTTP del agente. */
  agentFailure?: "INPUT_REJECTED" | "AGENT_ERROR";
```

- Se lee con **guard de VALOR** —no sólo de tipo— igual que el resto de `readFailureFields`: un
  string que no esté en la lista cerrada **no se copia**.
- **Nunca se ecoa al body.** Se usa para ramificar (mismo criterio que `reason`) y se loguea en
  `logGatewayFailure` (`:380-392`), que es un canal de **sólo-enums** — y el campo nuevo es un enum,
  así que entra ahí sin violar nada.

---

## Waves

> **Wave 1 va ENTERA antes de Wave 2.** Dentro de cada wave, el paso `.0` es SERIAL.

### Wave -1 · Environment Gate (OBLIGATORIO, antes de tocar código)

```bash
# --- wasiai-a2a ---
cd /home/ferdev/.openclaw/workspace/a2a-wkh362
/usr/bin/git rev-parse --abbrev-ref HEAD     # DEBE decir: feat/wkh-335-status-estructurado
npm install --silent
ls src/services/compose.ts src/types/index.ts src/lib/field-error-parser.ts \
   src/lib/discovery-sources.ts src/services/compose.test.ts src/routes/compose.test.ts \
   doc/INTEGRATION.md
ls src/lib/agent-http-error.ts 2>/dev/null && echo "⛔ YA EXISTE — PARAR Y ESCALAR"
grep -rn "agentFailure" src/ | head    # DEBE dar 0 hits
node -e "console.log(Object.keys(require('./package.json').scripts))"  # NO debe aparecer 'qa'

# --- chaski-v3 ---
cd /home/ferdev/.openclaw/workspace/chaski-wkh362
/usr/bin/git rev-parse --abbrev-ref HEAD     # DEBE decir: feat/wkh-335-error-no-opaco
npm install --silent
ls src/infrastructure/a2a/gateway-client.ts src/infrastructure/a2a/gateways.ts \
   src/application/agent-rejections.ts src/presentation/flow-vm.ts \
   app/api/a2a/quote/route.ts app/api/payout/prepare/route.ts \
   src/infrastructure/a2a/gateway-client.test.ts app/api/a2a/quote/route.test.ts \
   app/api/payout/prepare/route.test.ts src/presentation/flow-vm.test.ts \
   src/application/agent-rejections.test.ts
grep -n "QUOTE_REJECTED\|PREPARE_REJECTED" src/application/agent-rejections.ts | head
sed -n '400p' app/api/payout/prepare/route.ts   # DEBE ser: if (!r.ok) {
```

**Si algo falla acá: PARAR y reportar al orquestador.** No implementar sobre un entorno roto.

---

### WAVE 1 — `wasiai-a2a` · worktree `a2a-wkh362` · rama `feat/wkh-335-status-estructurado`

#### W1.0 — Contrato (SERIAL, nada depende de nada)

- [ ] **W1.0.1** `src/types/index.ts` — `AgentFailureKind` (junto a `DiscoverySourceFailure`,
      `:681-687`) + `agentFailure?: AgentFailureKind;` dentro de `ComposeResult`, con el docblock
      de 6 puntos. → Exemplars E-3, E-4
- [ ] **W1.0.2** `src/lib/agent-http-error.ts` **(NUEVO)** — `AgentHttpError` +
      `classifyAgentFailure`, con el docblock que incluye CD-13 y la divergencia con
      `parseFieldErrors` (punto 5 de "Las 7 cosas"). → Exemplars E-1, E-5
- [ ] **W1.0.3** `src/lib/field-error-parser.ts` — **SOLO el docblock**: una línea que apunte al
      clasificador y diga por qué los dos números divergen a propósito. **CERO cambios de código.**
      *(Esta es la única excepción a "no tocar `field-error-parser.ts`": prosa, no lógica. Si el
      diff de ese archivo tiene una línea de código, es señal de alarma.)*
- [ ] **W1.0.4** `src/lib/agent-http-error.test.ts` **(NUEVO)** — los tests de la sección
      "Tests requeridos · §9.2". → Exemplar `src/lib/field-error-parser.test.ts:10-60`

**Puerta de W1.0**: `npx tsc -p tsconfig.json --noEmit` verde **y**
`npx vitest run src/lib/agent-http-error.test.ts` verde.

#### W1.1 — Los tests, ANTES del cableado ⚠️ ES LO QUE PRODUCE LA EVIDENCIA DE AC-5

- [ ] **W1.1.1** `src/services/compose.test.ts` — los **7 `it`** de "Tests requeridos · §9.1",
      escritos y **corridos contra el código SIN cablear**.
- [ ] **W1.1.2** Guardar la salida literal en rojo. Ver "Protocolo de evidencia" — **los 5 pasos, sin
      saltear ninguno.**

Con W1.0 hecho, el tipo `agentFailure` ya existe y nada lo puebla ⇒ **el rojo es la ASERCIÓN, no un
error de compilación**. Eso es exactamente lo que AC-5 exige.

#### W1.2 — Cableado (los tres sitios, UN SOLO COMMIT por CD-6)

- [ ] **W1.2.1** `src/services/compose.ts` — import de `AgentHttpError` (bloque `../lib/*.js`, `:44-77`)
- [ ] **W1.2.2** `src/services/compose.ts:1755-1757` — `throw new Error(...)` →
      `throw new AgentHttpError(agent.slug, response.status, detail)` · **mensaje byte-idéntico (CD-9)**
- [ ] **W1.2.3** `src/services/compose.ts` — helper `agentFailureResult(err)` junto a
      `withheldResult` (`:141-158`) → Exemplar E-2
- [ ] **W1.2.4** `src/services/compose.ts:1146-1159` — agregar `...agentFailureResult(retryErr)`
      al lado de `...withheldResult(...)` de `:1158` **(AC-2, camino con retry)**
- [ ] **W1.2.5** `src/services/compose.ts:1178-1190` — agregar `...agentFailureResult(err)`
      al lado de `...withheldResult(...)` de `:1189` **(AC-1, camino directo)**

⚠️ **W1.2.4 y W1.2.5 son OBLIGATORIOS los dos. Si sólo hacés uno, la HU está a la mitad (CD-6).**

**Puerta de W1.2**: los 7 `it` de W1.1 pasan a verde **y la suite completa del repo** queda verde.

#### W1.3 — Superficie pública y prosa

- [ ] **W1.3.1** `src/routes/compose.test.ts` — el `it` de serialización de "Tests requeridos · §9.3"
- [ ] **W1.3.2** `doc/INTEGRATION.md` — fila del campo nuevo en la tabla de errores de la sección 5
      (donde ya viven `errorCode: INPUT_MAPPING_FAILED` e `inputMappingFailure`, ~`:1042`).
      Documentar: los dos valores, el invariante de ausencia, y que **no cambia el status HTTP**.
- [ ] **W1.3.3** Guardar la salida en verde (paso 4 del protocolo de evidencia)

**Gate de cierre de Wave 1** (secuencia completa, en orden, una vez):
```
npx tsc -p tsconfig.json --noEmit   &&   npm run lint   &&   npm test
```

---

### WAVE 2 — `chaski-v3` · worktree `chaski-wkh362` · rama `feat/wkh-335-error-no-opaco`

#### W2.0 — El cliente del gateway (SERIAL)

- [ ] **W2.0.1** `src/infrastructure/a2a/gateway-client.ts` — campo `agentFailure?` en
      `GatewayFailure` (~`:155`, antes de `httpStatus?: number;`), con su docblock
- [ ] **W2.0.2** `readFailureFields` (`:232-249`) — leer el campo **con guard de VALOR** (no sólo
      `typeof === "string"`: tiene que estar en la lista cerrada) → Exemplar E-10
- [ ] **W2.0.3** **Sitio 1** (`:330-337`, el `if (!res.ok)`) — **verificar** que el campo llega vía
      el spread de `readFailureFields(parsed)`. Si llega, no hace falta línea nueva; **anotalo**.
- [ ] **W2.0.4** **Sitio 2** (`:341-353`, el `200 + success:false`) — agregar el campo **A MANO**,
      igual que se agregan `step` y `message` ahí. **CD-11: sin esto la mitad queda sin cubrir.**
- [ ] **W2.0.5** `logGatewayFailure` (`:380-392`) — agregar `agentFailure: f.agentFailure` al objeto
      del `console.warn`. Es un enum ⇒ no viola el canal de sólo-enums.
- [ ] **W2.0.6** **CD-12 — re-anclar 2 citas** (agregar el campo al tipo desplaza todo lo posterior):
      - [ ] `src/infrastructure/rate-limit.ts:313` → dice `./a2a/gateway-client.ts:216-217`. Abrir
            el destino, ver a qué línea se movió, corregir el número.
      - [ ] `app/api/a2a/quote/route.ts:135` → dice `gateway-client.ts:225`. Ídem.
- [ ] **W2.0.7** `src/infrastructure/a2a/gateway-client.test.ts` — `T-335-GW-1/2/3`

#### W2.1 — Los dos legs (paralelizables entre sí, **los dos obligatorios** por CD-7)

- [ ] **W2.1.1** `app/api/a2a/quote/route.ts:158-170` — rama nueva **ANTES** del `502`, después del
      `no_agent_match`:
      ```ts
      if (r.code === "step_failed" && r.agentFailure === "INPUT_REJECTED")
        return NextResponse.json({ error: QUOTE_REJECTED }, { status: 422 });
      ```
      Importar `QUOTE_REJECTED` de `src/application/agent-rejections.ts` (**ya existe**).
- [ ] **W2.1.2** `app/api/a2a/quote/route.ts:146-157` — reescribir la prosa (**prosa falsa #5**)
- [ ] **W2.1.3** `app/api/payout/prepare/route.ts:400-427` — la rama gemela, con `PREPARE_REJECTED`
      y 422, también **ANTES** del `return` final. (El `not_configured` vive dentro de ese `return`
      final; como el guard nuevo exige `code === "step_failed"`, no pueden colisionar.)
- [ ] **W2.1.4** `app/api/payout/prepare/route.ts:405-412` — reescribir la prosa (**prosa falsa #6**)
- [ ] **W2.1.5** `app/api/a2a/quote/route.test.ts` — `T-335-Q-1/2/3` → Exemplar E-12
- [ ] **W2.1.6** `app/api/payout/prepare/route.test.ts` — `T-335-P-1/2/3/4`

⚠️ **Ningún archivo nuevo de constantes.** Los dos enums ya existen.

#### W2.2 — Prosa y pantalla

- [ ] **W2.2.1** `src/application/agent-rejections.ts` — prosas falsas **#1, #2, #3**
- [ ] **W2.2.2** **CD-12 — re-anclar 2 citas** (reescribir el docblock de `QUOTE_REJECTED` desplaza
      todo lo de abajo):
      - [ ] `src/infrastructure/a2a/gateways.ts:112` → dice `../../application/agent-rejections.ts:49`
      - [ ] `src/presentation/flow.tsx:1712` → dice `../application/agent-rejections.ts:266`
- [ ] **W2.2.3** `src/infrastructure/a2a/gateways.ts:112-122` — prosa falsa **#4**
- [ ] **W2.2.4** `src/presentation/flow-vm.ts:575-594` — prosa falsa **#7**. ⛔ El
      `if (code.includes("a2a_quote_rejected"))` de `:595-596` **no se toca**.
- [ ] **W2.2.5** `src/presentation/flow-vm.test.ts:1008-1027` — prosa falsa **#8** + el `it` nuevo
      `T-335-VM-1`. ⛔ **El `expect` de `humanError("step_failed")` en `:1045-1046` NO SE TOCA**
      (punto 6 de "Las 7 cosas").
- [ ] **W2.2.6** `src/application/agent-rejections.test.ts` — `T-335-AR-1`
- [ ] **W2.2.7** Re-correr el barrido de citas después de editar:
      ```bash
      cd /home/ferdev/.openclaw/workspace/chaski-wkh362
      grep -rnoE '[a-z0-9./-]*(gateway-client|agent-rejections)\.ts:[0-9]{1,4}' src/ app/
      ```
      Abrir cada destino y confirmar que la línea citada sigue diciendo lo que la cita afirma.

**Gate de cierre de Wave 2** (secuencia completa, en orden, una vez):
```
npm run qa   &&   npm run build
```

---

## Las 8 prosas de `chaski-v3` que esta HU vuelve FALSAS (CD-15)

⚠️ **`chaski-v3` no tiene guardián de citas ni de prosa. Nada de esto lo caza nadie.** Van una por
una, y se reescriben **en el mismo commit** que las vuelve falsas.

| # | Sitio | Frase que queda FALSA | Qué queda cierto |
|---|---|---|---|
| 1 | `src/application/agent-rejections.ts:44-49` | *"HOY NINGÚN PRODUCTOR DE ESTA APP LO EMITE"* | — ahora **sí** lo emite `quote/route.ts` |
| 2 | `src/application/agent-rejections.ts:51-58` | *"AC-4 está declarado NO CUMPLIDO"* | ⚠️ la parte sobre **la reintroducción de la allow-list `RELAYABLE_QUOTE_REJECTIONS` sigue CIERTA**: el campo nuevo trae una **CLASE**, no el `reason` del agente. **No reintroduzcas esa lista.** |
| 3 | `src/application/agent-rejections.ts:66-88` | *"El de FX lo contestaba con un status HTTP de error, que es justamente lo que el gateway colapsa"* | — deja de colapsarlo |
| 4 | `src/infrastructure/a2a/gateways.ts:112-122` | *"ESTE `if` LEE UN ENUM QUE NINGÚN PRODUCTOR DE ESTA APP EMITE"* **y** *"el universo de `error` … son cuatro"* | pasan a ser **cinco** |
| 5 | `app/api/a2a/quote/route.ts:146-157` | *"SE ABRE UNO SOLO: `no_agent_match`"* | pasan a ser dos |
| 6 | `app/api/payout/prepare/route.ts:405-412` | *"Es el ÚNICO code que se abre"* | ídem. ⚠️ Lo de `payment_required` **sigue cierto** (CD-5) |
| 7 | `src/presentation/flow-vm.ts:575-594` | la parte que explica que **ningún productor puede emitir** el copy | ⚠️ la parte sobre el vocabulario `fx_*` **sigue CIERTA**: `fx_*` sigue sin llegar |
| 8 | `src/presentation/flow-vm.test.ts:1008-1027` | la declaración *"AC-4 QUEDA NO CUMPLIDO"* del candado T-4.1' | ⛔ **el `expect` de `:1045-1046` sigue válido** |

**Y en `wasiai-a2a`**: `doc/INTEGRATION.md` necesita la entrada nueva (W1.3.2). Un campo público que
no está ahí es una capacidad que **no existe para quien está del otro lado del cable**.

---

## Protocolo de evidencia rojo-antes / verde-después (AC-5 + CD-4)

**Es el corazón de la HU.** Sin esto AC-5 no está cumplido, y **no se puede sustituir por una
lectura del diff**.

### La regla que evita que CD-4 se lea mal

> **El sujeto bajo prueba tiene que ser código NUESTRO; el doble sólo puede ocupar el lugar del
> TERCERO.**

- ✅ **Doblar al agente invocado** vía `mockFetch` (`compose.test.ts:209-226`) es lo que hace toda la
  suite existente. El agente es el tercero cuyo comportamiento estamos reaccionando.
- ⛔ **Doblar al gateway es lo prohibido.** En `src/services/compose.test.ts` el sujeto es
  `composeService.compose()` **real**: el clasificador, el `throw` y los dos `return` corren de
  verdad. Eso es lo que certifica.
- ⛔ **`src/routes/compose.test.ts` NO certifica**: ahí `composeService` es un `vi.mock`
  (`:117-121`). Ese archivo prueba **una sola cosa** — que la ruta no descarta el campo. **NO** que
  el service lo emita.
- ⛔ **Ningún test de `chaski-v3` certifica nada de esto**: doblan al gateway. **Un doble que emita
  el campo hace pasar Wave 2 aunque el Coordinador nunca lo emita.** Ése es exactamente el agujero
  que AC-5 existe para cerrar.

### Los 5 pasos, sin saltear ninguno

1. Con **W1.0 hecho y W1.2 NO cableado**, correr:
   ```bash
   cd /home/ferdev/.openclaw/workspace/a2a-wkh362
   npx vitest run src/services/compose.test.ts 2>&1 | tee /tmp/wkh335-rojo.txt
   ```
   y **guardar la salida LITERAL** en
   `doc/sdd/226-wkh-335-status-del-agente-estructurado/evidencia-rojo-antes.md`.

2. **El rojo tiene que ser el FALLO DE ASERCIÓN** —
   `expected undefined to be 'INPUT_REJECTED'` — **no un error de import ni de compilación**.
   Un rojo por el motivo equivocado no es evidencia de nada: es el "falso KILLED".
   Si el rojo es un import roto, arreglá el import y volvé a correr.

3. **El número de tests RECOLECTADOS tiene que ser el MISMO en las dos corridas.**
   Anotá la línea `Tests  N failed | M passed (T)` de las dos. **Si `T` difiere, la segunda corrida
   no midió los mismos testigos** y la evidencia no vale.

4. Después de W1.2, la **misma** corrida en verde, guardada al lado en
   `doc/sdd/226-wkh-335-status-del-agente-estructurado/evidencia-verde-despues.md`.

5. Los dos bloques quedan citables **por nombre de test y por salida**, no por inferencia. F4 los va
   a citar así.

---

## Tests requeridos

**≥1 test por AC, y todo AC que afirma un comportamiento se EJECUTA.** Una cita `archivo:línea`
dice dónde vive el código, no qué hace corriendo.

### §9.1 — Los que CERTIFICAN · `wasiai-a2a/src/services/compose.test.ts`

Van dentro del `describe` de `:2634` (`composeService.compose — WKH-130 adaptive input-retry`), que
ya tiene `mockAgentsBySlug`, `FIELD_ERR_BODY` y `netSpend()`.

| id | escenario | asserta | AC |
|---|---|---|---|
| `T-335-DIRECT-4XX` | step 0 ok + step 1 `mockFetchError(400,'Bad Request')` (sin field-errors ⇒ sin retry) | `result.agentFailure === 'INPUT_REJECTED'`; `result.success === false`; `result.error` **sigue conteniendo** `returned 400` (CD-3 / AC-4) | AC-1 |
| `T-335-DIRECT-5XX` | ídem con `mockFetchError(500)` | `result.agentFailure === 'AGENT_ERROR'` — **EN EL MISMO `it` que el 400, comparados entre sí**. Un test que sólo mire un caso pasaría igual con los dos mapeados al mismo valor (E-12) | AC-1 |
| `T-335-RETRY` | `mockFetchError(422, FIELD_ERR_BODY)` → `mockRegen` → `mockFetchError(400,'nope')` | `agentFailure === 'INPUT_REJECTED'` **y** `result.error` contiene `after retry` — esto último prueba que salió por el `return` del retry (`:1146-1159`) y **no** por el directo | AC-2 |
| `T-335-RETRY-5XX` | `422 + FIELD_ERR_BODY` → `mockRegen` → `mockFetchError(500)` | `agentFailure === 'AGENT_ERROR'` — **el 422 del PRIMER intento NO manda**. Reusa el escenario de `T-RETRY-FAIL` (E-9) | AC-2 |
| `T-335-ABSENT` | `mockFetch.mockRejectedValueOnce(new Error('network ECONNRESET'))` | `('agentFailure' in result) === false` — **ausente, NO `undefined`** (CD-10) | AC-3 |
| `T-335-NOLEAK` | el caso 400 con un body que incluye una URL y un secreto | `JSON.stringify(result.agentFailure)` no contiene el `invokeUrl`, ni el host del agente, ni ningún fragmento del body | AC-3 |
| `T-335-BACKCOMPAT` | el pipeline **exitoso** de `T-RETRY-HAPPY` (el `it` de `:2661`) | `('agentFailure' in result) === false` y el resto del objeto igual que hoy | AC-4 |

⚠️ **Por qué `'agentFailure' in result` y no `result.agentFailure === undefined`**: el invariante es
la **AUSENCIA de la clave**. `{ agentFailure: undefined }` la tiene y serializa distinto.

**Por qué el `retryErr` del retry y no el del primer intento** (documentalo en el `it`): en el
camino con retry el input **fue regenerado** por un LLM, así que el veredicto del primer intento ya
no describe lo que se mandó la segunda vez. Consecuencia declarada: un `422 → regen → ECONNRESET`
deja el campo **AUSENTE**. Es correcto: ausente = *no sé*.

### §9.2 — Unitarios del clasificador · `wasiai-a2a/src/lib/agent-http-error.test.ts` (NUEVO)

- [ ] Tabla completa de clasificación, con los pares que **DISCRIMINAN** (CD-17): **`399/400`**,
      **`422/423`**, **`429/500`**. ⛔ **Nada de probar dos cláusulas con el mismo número.**
- [ ] **Totalidad**: `NaN`, `-1`, `0`, `999` → devuelve un valor válido y **NO lanza**.
- [ ] `AgentHttpError` es `instanceof Error` y su `.name` es `'AgentHttpError'`.
- [ ] **CD-9 MEDIDO, no leído**:
      `parseFieldErrors(new AgentHttpError('cobraya-cfdi', 422, FIELD_ERR_BODY).message)`
      devuelve **los mismos campos** que hoy devuelve para el string literal equivalente.
      Es lo que impide que alguien "limpie" el mensaje porque el status ya viaja estructurado.

Exemplar de forma: `src/lib/field-error-parser.test.ts:10-60` (tabla de casos con el string real).

### §9.3 — Serialización · `wasiai-a2a/src/routes/compose.test.ts` — **y qué NO prueba**

Un `it`: `mockCompose` devuelve un `ComposeResult` de fallo **con** `agentFailure`, y el body HTTP
del 400 lo contiene.

Prueba **UNA SOLA COSA**: que la ruta no descarta el campo (riesgo real: un `schema.response` de
Fastify strippea claves desconocidas; medido que hoy **no hay schema** en esa ruta).
⛔ **NO prueba que el service lo emita** — en ese archivo `composeService` es un `vi.mock`
(`:117-121`). Eso lo prueba §9.1 y **sólo** §9.1.

### §9.4 — `chaski-v3`

| archivo | id | asserta | AC |
|---|---|---|---|
| `src/infrastructure/a2a/gateway-client.test.ts` | `T-335-GW-1` | `400 + {success:false, agentFailure:"INPUT_REJECTED"}` → `{ code:"step_failed", agentFailure:"INPUT_REJECTED" }` (sitio 1) | AC-9 |
| `src/infrastructure/a2a/gateway-client.test.ts` | `T-335-GW-2` | `200 + success:false + agentFailure` → **también** lo trae (**sitio 2, CD-11**) | AC-9 |
| `src/infrastructure/a2a/gateway-client.test.ts` | `T-335-GW-3` | `agentFailure: "cualquier_cosa"` / `42` / `{}` → el campo **NO se copia** (guard de valor) | AC-9 |
| `app/api/a2a/quote/route.test.ts` | `T-335-Q-1` | **los DOS desenlaces EN EL MISMO `it`**: `INPUT_REJECTED` → 422 `a2a_quote_rejected`; `AGENT_ERROR` → 502 `a2a_unavailable`. **No comparten ni status ni enum** | AC-6 |
| `app/api/a2a/quote/route.test.ts` | `T-335-Q-2` | `Object.keys(json) === ["error"]`; el log tiene el enum y **NO** el `message` del gateway; `directCalls` vacío | AC-8 |
| `app/api/a2a/quote/route.test.ts` | `T-335-Q-3` | campo **AUSENTE** (gateway sin desplegar todavía) → 502, byte-idéntico a hoy | AC-6 |
| `app/api/payout/prepare/route.test.ts` | `T-335-P-1/2/3` | los mismos tres, con `prepare_agent_rejected` / `prepare_upstream_error` | AC-7, AC-8 |
| `app/api/payout/prepare/route.test.ts` | `T-335-P-4` | `payment_required` (402) **sigue colapsado** en `prepare_upstream_error` | CD-5 |
| `src/presentation/flow-vm.test.ts` | `T-335-VM-1` | `humanError("a2a_quote_rejected")` ≠ el genérico, **y** `humanError("step_failed")` **SIGUE** siendo el genérico | AC-6 |
| `src/application/agent-rejections.test.ts` | `T-335-AR-1` | `QUOTE_REJECTED` sigue sin contener `fx_` — el enum sigue siendo palabra NUESTRA ahora que **sí** tiene productor | CD-1 |

### Criterio Test-First

| Tipo de cambio | Test-first |
|---|---|
| El campo nuevo y su clasificador (Wave 1) | **SÍ — es AC-5, es obligatorio, es W1.1 antes de W1.2** |
| El mapeo de las rutas (Wave 2) | Sí |
| Reescritura de prosa / docblocks | No |
| `doc/INTEGRATION.md` | No |

---

## Qué NO cubre NINGÚN test de esta HU (declarado, no descubierto)

*Copiado tal cual del SDD §9.6. El Dev **no** tiene que intentar cubrir esto; tiene que saber que
está afuera.*

1. **Que el Coordinador real y Chaski real se entiendan.** No hay test cross-repo. Los tests de
   Wave 2 doblan al gateway: **un doble que emita el campo hace pasar Wave 2 aunque el Coordinador
   nunca lo emita.** Lo único que lo cierra es §9.1 del lado de `wasiai-a2a` más el sondeo de
   producción (Clase 1, founder).
2. **Que un agente real del catálogo devuelva 4xx para un monto fuera de rango.** Está medido en el
   work-item contra producción y en `chaski-v3/src/application/agent-rejections.ts:24-30`; ningún
   test de este repo lo re-mide.
3. **Statuses fuera de `{400, 422}` que en la práctica sean rechazos de input.** Por diseño caen en
   `AGENT_ERROR`. Nadie los cubre porque nadie los midió.
4. **El orden de despliegue (AC-10).** Ningún test puede verificarlo; `T-335-Q-3` sólo prueba que el
   orden equivocado es **inocuo** (sin campo, comportamiento de hoy), no que se haya respetado.
5. **La precisión del copy.** `humanError` dice *"Probá con otro monto"* para cualquier
   `INPUT_REJECTED`, y un `INPUT_REJECTED` podría venir de un campo que no es el monto. Limitación
   aceptada: el único 4xx medido de ese agente es de rango de monto, el resto de los campos del
   formulario son `select`, y el peor caso es un consejo impreciso — contra el actual, que es un
   diagnóstico **falso** más un consejo garantizado a fallar.
6. **`/orchestrate`.** Hereda el campo por tipo (`OrchestrateResult.pipeline: ComposeResult`) y **no
   se agrega ningún test propio ni ninguna línea de código**.

---

## Gates — SON DISTINTOS POR REPO

**Correr las PARTES de un gate no es correr el gate.** La secuencia completa, en orden, una vez, al
cerrar cada wave.

| Repo | Gate | Nota |
|---|---|---|
| `wasiai-a2a` | `npx tsc -p tsconfig.json --noEmit` → `npm run lint` → `npm test` | ⛔ **`npm run qa` NO EXISTE en este repo.** `lint` = `biome check src/`; `test` = `vitest run` |
| `chaski-v3` | `npm run qa` → `npm run build` | ✅ `qa` = `lint && typecheck && typecheck:scripts && test`. ⛔ **`npm test` solo NO es el gate acá** |

⚠️ `lint` va **segundo** en `wasiai-a2a` y ya hubo un `import` sin usar que sobrevivió 5 revisiones
porque todos corrían `vitest` y `tsc` y nadie llegaba a lint.

⚠️ **CD-16: el veredicto de wave es la suite COMPLETA del repo**, no una corrida dirigida a los
archivos que tocaste. Un F3 anterior cantó verde con 2 rojos en el árbol por correr sólo lo suyo.

---

## Presupuesto de diff (el CR lo contrasta)

| Wave | Archivos | Techo de líneas |
|---|---|---|
| **Wave 1** (`wasiai-a2a`) | **6** (2 nuevos) | **≤ 320** |
| **Wave 2** (`chaski-v3`) | **9** (0 nuevos) | **≤ 350** |

Desglose de referencia — Wave 1: `agent-http-error.ts` ~55 · `agent-http-error.test.ts` ~75 ·
`compose.ts` ~25 · `types/index.ts` ~30 · `compose.test.ts` ~110 · `routes/compose.test.ts` ~25.
Wave 2: `gateway-client.ts` ~35 · `quote/route.ts` ~18 · `prepare/route.ts` ~18 · las 8 prosas +
las 4 citas ~55 · tests (4 archivos) ~185.

**Umbral del CR: 2x** (640 y 700). Un exceso se justifica **por escrito** o se recorta. La pregunta
que decide: *¿qué parte de esto seguiría existiendo si lo escribiera alguien que ya conoce estos dos
repos?*

### ⚠️ Las TRES señales de alarma

Si alguna aparece en el diff, **PARÁ**:

1. **Un archivo nuevo de constantes en `chaski-v3`** → los dos enums ya existen (punto 4 de "Las 7 cosas").
2. **Cualquier cambio de CÓDIGO en `src/lib/field-error-parser.ts`** o en la máquina de reintento →
   divergen a propósito (punto 5). *(Una línea de docblock en W1.0.3 es lo único permitido.)*
3. **Un status HTTP nuevo en `src/routes/compose.ts`** → CD-18: el campo nuevo no cambia ningún
   status.

**Lo que el presupuesto NO incluye y no debería aparecer**: refactor de `invokeAgent`, cambios en
`services/orchestrate.ts`, módulos nuevos en `chaski-v3`, o el `expect` de `humanError("step_failed")`.

---

## Out of Scope — lo que el Dev NO hace

- ⛔ **NO despliega ni setea variables de entorno.** El orden Railway (`wasiai-a2a`) **antes** que
  Vercel (`chaski-v3`) es Clase 1, precondición del founder (CD-8 / AC-10). Ningún agente la ejecuta.
- ⛔ **NO sondea producción.** El `amountUsd: 100000` → 422 por la ruta real de Chaski lo hace el
  founder, después de los dos deploys.
- ⛔ **NO levanta la prohibición de parsear prosa** (`chaski-v3/src/infrastructure/a2a/gateway-client.ts:343`).
- ⛔ **NO renombra ni quita campos existentes** del sobre de `/compose`.
- ⛔ **NO toca `errorCode`** ni su mapeo de status (`src/routes/compose.ts:1112-1117`).
- ⛔ **NO toca `services/orchestrate.ts`** — hereda el campo por tipo, sin código nuevo.
- ⛔ **NO toca `wasiai-facilitator` ni `wasiai-remittance-agents`.**
- ⛔ **NO toca `no_agent_match`** (ya resuelto en WKH-332/AC-13) ni el colapso de
  `payment_required` / `unavailable` (CD-5).
- ⛔ **NO reintroduce `RELAYABLE_QUOTE_REJECTIONS`** en `chaski-v3`. El campo nuevo trae una CLASE,
  no el `reason` del agente: esa parte de la prosa **sigue siendo cierta**.
- ⛔ **NO agrega dependencias.** Ninguna, en ninguno de los dos repos.
- ⛔ **NO "mejora" código adyacente.** NO refactoriza `invokeAgent`. NO agrega funcionalidad no listada.
- ⛔ **NO renombra los directorios de worktree** (`a2a-wkh362`, `chaski-wkh362`).
- ⛔ **NO hace commits fuera de las dos ramas indicadas**, y **NO mergea a `main`**.

---

## Done Definition

### Wave 1 — `wasiai-a2a`

- [ ] Los **7 archivos** de la tabla de Wave 1 modificados/creados, **ninguno más**
- [ ] `AgentFailureKind` exportado y `agentFailure?` dentro de `ComposeResult` con docblock de 6 puntos
- [ ] `AgentHttpError` con `message` **byte-idéntico** (CD-9) — **probado con un test**, no leído
- [ ] `classifyAgentFailure` **pura y total**, allow-list `{400, 422}`, con CD-13 en el docblock
- [ ] **LOS DOS** `return` cableados: `:1158` (retry, `retryErr`) **y** `:1189` (directo, `err`) — CD-6
- [ ] Los **7 `it`** de §9.1 en verde
- [ ] Los tests de §9.2 en verde, con los pares que discriminan (`399/400`, `422/423`, `429/500`)
- [ ] El `it` de serialización de §9.3 en verde
- [ ] **`evidencia-rojo-antes.md` y `evidencia-verde-despues.md` escritos**, con el rojo siendo una
      **ASERCIÓN** y el **mismo conteo de tests recolectados** en las dos corridas
- [ ] `doc/INTEGRATION.md` con la entrada del campo nuevo
- [ ] Gate completo verde, en orden: `npx tsc -p tsconfig.json --noEmit` → `npm run lint` → `npm test`
- [ ] Diff dentro del techo (≤ 320 líneas / 6 archivos de código) o exceso justificado por escrito
- [ ] Ninguna de las 3 señales de alarma en el diff

### Wave 2 — `chaski-v3`

- [ ] Los **9 archivos** de la tabla, **cero archivos nuevos**
- [ ] `agentFailure?` en `GatewayFailure` con **guard de VALOR** en `readFailureFields`
- [ ] **LOS DOS** sitios de construcción cubiertos: `:330-337` (verificado) **y** `:341-353` (línea nueva) — CD-11
- [ ] `logGatewayFailure` loguea el campo
- [ ] **LOS DOS** legs mapeados: `quote/route.ts` **y** `payout/prepare/route.ts` — CD-7
- [ ] Guard `r.code === "step_failed" && r.agentFailure === "INPUT_REJECTED"` en los dos
- [ ] Los 10 tests de §9.4 en verde, **con los dos desenlaces en el mismo `it`** donde corresponde
- [ ] `Object.keys(json) === ["error"]` preservado en las dos rutas — AC-8
- [ ] **Las 4 citas re-ancladas** y el barrido re-corrido — CD-12
- [ ] **Las 8 prosas reescritas** — CD-15
- [ ] ⛔ **El `expect` de `flow-vm.test.ts:1045-1046` INTACTO**
- [ ] ⛔ `gateway-client.ts:343` (prohibición de parsear prosa) **intacto**
- [ ] Gate completo verde, en orden: `npm run qa` → `npm run build`
- [ ] Diff dentro del techo (≤ 350 líneas / 9 archivos) o exceso justificado por escrito

---

## Escalation Rule

> **Si algo no está en este Story File, el Dev PARA y escala al Architect.**
> No inventar. No asumir. No improvisar.

Situaciones de escalation obligatoria:

- Un exemplar ya no existe o su rango de líneas no dice lo que este documento afirma
- `src/lib/agent-http-error.ts` **ya existe** al empezar
- `grep -rn "agentFailure" src/` en `a2a-wkh362` da **más de 0 hits** al empezar
- El `if (!r.ok)` de `prepare/route.ts` no está en `:400`
- El **rojo de AC-5 no es una aserción** después de arreglar el import
- El **conteo de tests recolectados difiere** entre la corrida roja y la verde
- El diff se va de **2x** del techo de la wave
- Aparece cualquiera de las **3 señales de alarma**
- Hace falta tocar un archivo **fuera de las dos tablas** de "Files to Modify/Create"
- El gate del repo falla por algo que **no** introdujo esta HU

---

*Story File generado por NexusAgil — F2.5 · Architect · 2026-08-25*
