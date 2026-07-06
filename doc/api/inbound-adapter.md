# Inbound Adapter API — Push/Webhook de tareas externas (WKH-115)

WasiAI A2A expone un **adapter INBOUND source-agnostic** que permite a una fuente
externa (bounty/task platform) **empujar** demanda al motor de orquestación de
WasiAI. La fuente hace un `POST` autenticado por HMAC; WasiAI normaliza el
payload, lo rutea **in-process** a `orchestrateService` pagando con la agent key
a2a configurada para esa fuente, y trackea el ciclo de vida.

Este es un complemento del modelo **pull** (`/orchestrate`): la fuente no llama
a `/orchestrate` directamente, sino que envía tareas y WasiAI las ejecuta.

---

## Endpoint

```
POST /inbound/:source/tasks
Content-Type: application/json
```

- `:source` — identificador de la fuente. Se sanitiza a `[A-Z0-9_]` (uppercased)
  para resolver la config env (ver más abajo).

---

## Autenticación — HMAC-SHA256 sobre el body crudo

Esquema Stripe-style: firma sobre `"<timestamp>.<rawBody>"` + ventana anti-replay.

### Headers requeridos

| Header | Valor |
|--------|-------|
| `x-wasiai-timestamp` | Unix epoch en **segundos** (string). Ej. `"1751826000"`. |
| `x-wasiai-signature` | Hex de **64 chars** = `HMAC-SHA256(secret, "<timestamp>.<rawBody>")`. |
| `content-type` | `application/json` |

### Cómo firmar

1. Tomá el **body crudo** exacto que vas a enviar (los bytes; NO re-serialices).
2. Construí el string canónico: `` `${timestamp}.${rawBody}` ``.
3. Calculá `HMAC-SHA256` con el **secreto de la fuente en UTF-8** (no un hash
   previo) y codificá el digest en **hex minúscula**.

```js
import { createHmac } from 'node:crypto';

const timestamp = Math.floor(Date.now() / 1000).toString();
const rawBody = JSON.stringify(payload); // exactamente lo que se envía
const signature = createHmac('sha256', Buffer.from(secret, 'utf8'))
  .update(`${timestamp}.`)
  .update(rawBody)
  .digest('hex');

await fetch(`https://<gateway>/inbound/${source}/tasks`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-wasiai-timestamp': timestamp,
    'x-wasiai-signature': signature,
  },
  body: rawBody,
});
```

### Ventana anti-replay

`|now - timestamp| <= INBOUND_HMAC_TOLERANCE_SEC` (default **300** segundos).
Fuera de la ventana → `401`.

### Verificación (server-side)

- Se rechaza hex malformado **antes** de decodificar (regex `^[0-9a-f]{64}$`).
- El `timestamp` se valida con un guard estricto `^\d+$` (rechaza whitespace,
  `1e10`, `0x10`, `12.3`) **antes** del chequeo de ventana.
- El HMAC se compara en tiempo constante (length-check + `timingSafeEqual`).
- El HMAC se calcula sobre los **bytes exactos** del body recibido
  (`req.rawBody`), nunca sobre un re-`JSON.stringify`.
- Una fuente **no configurada** también computa un HMAC dummy antes de responder
  `401`, para no revelar por timing qué fuentes existen.

---

## Idempotencia — enviá un `id` (recomendado)

La ventana anti-replay (300s) por sí sola **no** protege del doble-cobro: un
request firmado capturado y **re-enviado dentro de la ventana** volvería a
ejecutar la orquestación y **re-debitaría** la agent key pagadora.

Para evitarlo, la fuente **DEBERÍA** enviar un `id` estable por tarea (mapea a
`external_ref`). WasiAI deduplica por `(owner_ref, source, external_ref)`:

- Si llega una 2ª ingesta con el **mismo** `(source, id)` → se devuelve la tarea
  **existente** con su status actual, **sin** crear una fila nueva y **sin**
  re-invocar `orchestrate` (idempotente, sin doble-cobro).
- Un índice `UNIQUE` parcial es el backstop de la race de dos requests idénticos
  concurrentes: uno gana el insert, el otro recibe el mismo replay idempotente.
- En un replay de una tarea ya `settled`, el `answer` original **no** se
  re-entrega (`answer: null`); el request original ya recibió la respuesta.

> **Sin `id`** (`external_ref` nulo) no hay deduplicación: el único anti-replay
> es la ventana de **300 s**.

---

## Configuración por fuente (env-driven)

Cada fuente se da de alta con variables de entorno. `<S>` = el `:source`
sanitizado (uppercased, `[A-Z0-9_]`).

| Env var | Requerido | Descripción |
|---------|-----------|-------------|
| `INBOUND_SOURCE_SECRET_<S>` | Sí | Secreto HMAC en UTF-8. Ausente → `401`. |
| `INBOUND_SOURCE_A2A_KEY_<S>` | Sí | Raw a2a key **pagadora** (su budget prepago paga la orquestación). |
| `INBOUND_SOURCE_MAX_BUDGET_<S>` | Sí | Cap por tarea (finito `> 0`). |
| `INBOUND_SOURCE_DEFAULT_BUDGET_<S>` | No | Budget cuando el payload no declara monto (finito `>= 0`, default `0`). |
| `INBOUND_SOURCE_CHAIN_<S>` | No | Chain del ruteo. Default = chain del adapters bundle. |
| `INBOUND_HMAC_TOLERANCE_SEC` | No | Ventana anti-replay global (default `300`). |

Cualquier requerido ausente/inválido → la fuente se trata como **no
configurada** → `401` (no se filtra qué fuentes existen).

---

## Payload genérico → normalización

El adapter de referencia es un **webhook HTTP genérico** (NO acoplado a ninguna
plataforma 3rd-party). Mapeo `payload → goal/budget/constraints`:

| Campo payload | Tipo | Mapea a | Regla |
|---------------|------|---------|-------|
| `goal` | string | `goal` | **Requerido**, no vacío tras trim. Ausente/vacío/no-string → `400`. |
| `id` | string | `externalRef` | Opcional. No-string → `null`. |
| `budget_usdc` | number | `budgetUsdc` | Opcional. Finito `>= 0`; presente pero `NaN`/`Infinity`/negativo/no-number → `400`. Ausente → default de la fuente. |
| `constraints` | object | `constraints` | Opcional. No-object plano → `{}`. |
| `callback_url` / `artifact_url` | string | `embeddedUrls[]` | Opcional. Validadas por SSRF antes de cualquier fetch. No-string → ignoradas. |
| `payment` / `escrow` | presente (no-null) | rechazo | La mera presencia de un pago/escrow propio ⇒ `rejected` (a2a-only). |

### Reglas de negocio

- **Budget SIEMPRE capado**: `budget = min(monto_declarado, MAX_BUDGET)` o el
  default de la fuente si no se declaró. Nunca se confía en el monto externo crudo.
- **Escrow externo → rechazo**: si el payload trae `payment`/`escrow`, la tarea
  se marca `rejected` y **no** se acredita budget de ese monto.
- **SSRF**: toda URL embebida se valida con `validateOutboundUrl` **antes** de
  cualquier fetch; si falla → `rejected` con razón `ssrf:*`.

---

## Lifecycle

```
ingested → routed → settled | rejected | failed
```

| Estado | Significado |
|--------|-------------|
| `ingested` | Row creado tras auth + validación de shape. |
| `routed` | Budget capado + `orchestration_id` asignado; **antes** de invocar orchestrate. |
| `settled` | `orchestrate` devolvió `pipeline.success === true`. |
| `rejected` | Escrow externo declarado (AC-5) o URL SSRF-inválida (AC-7). |
| `failed` | orchestrate no-ready / `pipeline.success === false` / throw (fail-closed). |

Todas las lecturas/escrituras están aisladas por `owner_ref` (el owner de la
agent key pagadora). Cross-tenant se trata como not-found.

---

## Respuestas HTTP

| HTTP | Body | Cuándo |
|------|------|--------|
| `200` | `{ "status": "settled", "orchestrationId": "...", "answer": ... }` | Ruteo OK (`pipeline.success === true`). |
| `200` | `{ "status": "rejected", "reason": "..." }` | Escrow externo (AC-5) o URL SSRF-inválida (AC-7). |
| `200` | `{ "status": "failed", "reason": "..." }` | orchestrate no-ready / `pipeline.success === false` / throw (fail-closed). |
| `200` | `{ "status": "ingested"\|"routed", "orchestrationId": ..., "idempotent": true }` | Replay idempotente de una tarea aún en vuelo (mismo `(source, id)` concurrente). |
| `400` | `{ "error_code": "INVALID_PAYLOAD" }` | `goal` ausente/vacío o `budget_usdc` inválido. Sin row. |
| `401` | `{ "error_code": "UNAUTHORIZED" }` | Firma inválida/ausente, timestamp fuera de ventana, o fuente sin secret. Cero row, cero orchestrate. |
| `500` | `{ "error_code": "INBOUND_SOURCE_MISCONFIGURED" }` | Key pagadora inexistente/inactiva (la firma FUE válida). |

---

## Notas de diseño

- **Ruteo in-process**: la ruta llama a `orchestrateService.orchestrate`
  directamente (mismo patrón que `agent-links.ts`); NO hace un HTTP self-call ni
  usa una cola. El money-path (débito del budget prepago) queda intacto.
- **Additive-only**: el content-type parser raw-body está **encapsulado** al
  plugin `/inbound` (Fastify encapsula parsers de plugins sin `fastify-plugin`),
  por lo que `/orchestrate`, `/compose` y `/tasks` no se ven afectados.
- **Activación de la migración**: la tabla `a2a_inbound_tasks` se crea con la
  migración `20260708000000_wkh115_inbound_tasks.sql` (aplicación separada).
