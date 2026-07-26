# WKH-191x — Dashboard Live Trace (seguimiento operativo read-only)

**Fase**: F3 (implementación) · **Branch**: `feat/dashboard-live-trace` · **Base**: `54f1f9a`

## 1. Objetivo

Una pantalla de seguimiento operativo con formato "live trace" sobre **tráfico real ya
ocurrido** (read-only), que permita responder tres preguntas:

1. ¿Está todo bien AHORA? (chains registradas, antigüedad del último settle cross-chain,
   skips por código)
2. ¿Cada llamada se ejecutó como debe? (hora, endpoint, status, latencia, caller)
3. ¿Se cruzaron las redes? (el caller pagó en una red, el agente cobró en otra)

Con texto didáctico por bloque: el founder tiene que aprender a leerla, no solo mirarla.

## 2. Scope IN

| Archivo | Acción |
|---|---|
| `src/types/trace.ts` | crear (contratos de la API) |
| `src/lib/downstream-skip-code.ts` | extender (vocabulario público runtime + significado) |
| `src/lib/chain-display.ts` | crear (chainId/CAIP-2 → nombre legible + explorer) |
| `src/services/trace.ts` | crear (lectura cross-tenant de telemetría) |
| `src/middleware/event-tracking.ts` | extender (persistir skip-codes PÚBLICOS en `metadata`) |
| `src/routes/compose.ts` | 1 línea aditiva (capturar los skips del pipeline) |
| `src/routes/orchestrate.ts` | 2 líneas aditivas (idem, legacy + execute) |
| `src/routes/dashboard.ts` | agregar `GET /dashboard/trace` + `GET /dashboard/api/trace` |
| `src/static/dashboard-trace.html` | crear (HTML+CSS+JS inline, sin build step) |
| tests | `chain-display.test.ts`, `trace.test.ts`, `dashboard.trace.test.ts`, `downstream-skip-signal.test.ts` (extensión) |

**Scope OUT**: migraciones, envs, prod, cualquier botón que dispare un `/compose`
(cada ejecución cuesta dinero), refactor de los dos gates admin existentes.

## 3. Hallazgos de grounding (código real, NO asumido)

### H-1 — La correlación `orchestration_id == metadata.requestId` sólo vale para `/compose`

- `src/routes/compose.ts:749` y `:777` → `orchestrationId: request.id`.
- `src/middleware/event-tracking.ts:73` → `metadata.requestId = request.id`.
- **PERO** `src/routes/orchestrate.ts:90`, `:197`, `:347` → `orchestrationId =
  crypto.randomUUID()`, que NO es `request.id`. Los recibos de un flujo
  `/orchestrate` (y `/orchestrate/execute`, el que usa Chaski) **nunca** cruzan con su
  evento.

### H-2 — Los recibos `budget_debit` se emiten con `orchestration_id = NULL`

Los 4 sitios de emisión de `budget_debit` pasan `orchestrationId: null`:
`src/services/budget.ts:73` (settle Solana), `:174` (key-session), `:258` (delegación) y
`src/middleware/a2a-key.ts:1268` (débito master). Sólo los recibos `protocol_fee`
(`src/routes/compose.ts:777`, `src/services/orchestrate.ts:1286`) llevan el id.

**Consecuencia de diseño**: agrupar exclusivamente por `orchestration_id` produciría una
pantalla vacía o mutilada. Se resuelve con la **unión de tres fuentes** con clave de
correlación explícita (sección 4), sin heurísticas temporales.

**Por qué NO se corrigió el origen**: threadear el `orchestration_id` a los 4 emisores es
un cambio en el money-path (firma de `budgetService.debit`, canonical payload del HMAC del
recibo) y queda fuera del scope de una pantalla read-only. Queda como
**TD-TRACE-1**.

**Por qué NO se correlaciona por ventana temporal**: `a2a_events` no tiene columna de
owner, así que emparejar por tiempo podría atribuir el recibo del tenant A a la llamada del
tenant B. En una pantalla de auditoría cross-tenant eso es una fuga, no una comodidad.

### H-3 — Los skip-codes del leg downstream NO están persistidos en ninguna tabla

`toPublicSkipCode` se usa en un único sitio (`src/services/compose.ts:722`) y sólo alimenta
la RESPUESTA HTTP (`steps[].downstreamSettle`) y los logs. No hay tabla ni columna con el
motivo del skip, así que el conteo pedido era imposible de calcular con el schema actual.

**Resolución (aditiva, sin migración)**: `a2a_events.metadata` es `jsonb` libre. Se persiste
`metadata.downstreamSkips: PublicDownstreamSkipCode[]` con el MISMO patrón
spread-condicional que ya usa `payment_origin` (`event-tracking.ts:77`). El valor se toma de
`StepResult.downstreamSettle`, cuyo tipo es `` `skipped:${PublicDownstreamSkipCode}` `` →
**es imposible por tipos que entre un código interno**. Cero cambios en la lógica de
decisión de dinero.

Limitación honesta: el contador sólo ve tráfico posterior al deploy de esta pantalla. La UI
lo dice.

### H-4 — Precisión numérica

`a2a_receipts.amount_usd` es `NUMERIC(20,8)`; `a2a_protocol_fees.budget_usdc` / `fee_usdc`
son `NUMERIC(18,6)`. Ninguna es `NUMERIC(78,0)` (esas son
`a2a_payment_intent_debit_signatures.debit_nonce` / `debit_amount_atomic`, WKH-191a, que
esta pantalla NO lee). Igual se seleccionan con `::text` y se transportan como **string
hasta el DOM**: cero aritmética flotante en el camino de lectura (convención post WKH-196).

### H-5 — `a2a_protocol_fees.fee_usdc` NO es el fee total

`fee_usdc` es la pata PLATAFORMA del split; el total es `fee_total_usdc` (WKH-167). La UI
muestra `fee_total_usdc` cuando existe y etiqueta explícitamente cuando cae al legacy
`fee_usdc`.

### H-6 — El `explorerUrl` de Solana lleva query string

`src/adapters/solana/index.ts:36` → `https://explorer.solana.com?cluster=devnet`. Concatenar
`/tx/<sig>` da una URL inválida. `buildExplorerTxUrl` inserta el path ANTES del query con
`new URL`, así funciona para los dos mundos sin hardcodear ningún explorer.

## 4. Diseño

### 4.1 Correlación (sin heurísticas)

```
clave de grupo:
  evento   → metadata.requestId ?? event.id
  recibo   → orchestration_id   ?? `receipt:<id>`     (H-2: puede ser NULL)
  fee      → orchestration_id                          (NOT NULL en el schema)
```

Un grupo nace de cualquiera de las tres fuentes y se enriquece con las que compartan clave:

- `/compose` con Agent Key → grupo completo (endpoint + latencia + recibos + fee).
- `/orchestrate*` (H-1) → el fee y los recibos caen en grupos propios; el evento en el suyo.
- Recibos con `orchestration_id` NULL (H-2) → un grupo por movimiento de dinero.

Ningún grupo inventa datos que no tiene: lo ausente se muestra como `n/d` y la UI explica
por qué. `correlation: 'full' | 'call-only' | 'money-only'` viaja en el payload para que la
pantalla sea explícita sobre lo que está viendo.

### 4.2 Cruce de redes (la tesis)

Un recibo con `settle_caip2` no nulo describe el settle al agente en otra VM. El cruce es
`red(chain_id) != red(settle_caip2)`, resuelto contra el registry real (no por string
matching): un settle Solana pagado desde un budget Solana NO es cruce, y se etiqueta como
mismo-rail.

### 4.3 Salud

- `chains[]` + `default` desde `getInitializedChainKeys()` / `getAdaptersBundle()` /
  `getDefaultChainKey()`, la misma fuente que `GET /capabilities`.
- `lastCrossChainSettle`: último recibo con `settle_caip2` + `settle_signature` que además
  ES cruce (4.2), con su antigüedad en segundos calculada server-side.
- `skips[]`: conteo por código PÚBLICO en las últimas N horas (default 24, tope 168).

## 5. Decisión de autorización

`GET /dashboard/api/trace` usa un gate **FAIL-CLOSED** (`requireAdminTokenForTrace`): sin
`DASHBOARD_ADMIN_TOKEN` configurado responde 503 en dev **y** en prod.

Justificación de por qué NO se reusó el opt-in `requireAdminToken` (el de `/api/stats`,
`/api/arbitrations/holds`, `/api/reconciliation`):

- El opt-in deja la superficie ABIERTA cuando `NODE_ENV` no es `production`. Un deploy con
  `NODE_ENV` sin setear (footgun real y documentado: los tests de este mismo archivo
  simulan "dev" borrando `NODE_ENV`) publicaría `owner_ref`, montos y tx hashes de TODOS los
  tenants en una URL pública.
- El opt-in está grandfathered por compatibilidad: `/api/stats` y `/api/events` ya tenían
  consumidores cuando se les puso el token (WKH-54). Este endpoint es **nuevo**: no hay
  cliente al que romper, así que no hay razón para heredar la debilidad.
- No se reusó `requireAdminTokenStrict` (WKH-191c) tal cual porque su mensaje dice
  "Reconciliation API not configured"; se agrega un gate propio con el mismo contrato
  (503 / 401 / passthrough) y comparación timing-safe extraída a `adminTokenMatches`.
- Los dos gates existentes NO se tocan (prohibición de refactor en F3). TD-TRACE-2: migrarlos
  al helper compartido.

La ruta HTML `GET /dashboard/trace` es pública (igual que `GET /dashboard`) y **no contiene
ningún dato de tenant**: es un cascarón que pide el token al usuario. El token viaja SIEMPRE
en el header `X-Admin-Token`, NUNCA en query param (un query param queda en los logs de
acceso del servidor y de cualquier proxy intermedio). Se persiste en `localStorage` con la
misma clave `wasiai_admin_token` que ya usa `dashboard.html`.

## 6. Ownership Guard — por qué esta pantalla NO usa los services con guard

`CLAUDE.md` obliga a `.eq('owner_ref', …)` en toda query sobre `a2a_agent_keys` desde
`src/services/`. Esta pantalla es **admin y cross-tenant por diseño** (el founder tiene que
ver el tráfico de todos los tenants), así que:

1. `src/services/trace.ts` **no toca `a2a_agent_keys`**. Lee sólo telemetría:
   `a2a_events`, `a2a_receipts`, `a2a_protocol_fees`. No hay nada que "burlar".
2. NO se reusan `receiptService.list/getById` (tienen el guard por `ownerRef` y son
   per-tenant por contrato). Un service admin con su propia query explícita es preferible a
   pasarles un owner falso o a agregarles un modo "sin guard", que erosionaría el guard para
   todos los callers.
3. El control de acceso vive en la ruta (gate fail-closed, sección 5), igual que
   `listHolds()` (WKH-189, CD-5) y `listPending()` (WKH-191c), los dos precedentes
   cross-tenant deliberados del repo.

## 7. Criterios de aceptación

- **AC-1** Sin `DASHBOARD_ADMIN_TOKEN` configurado, `GET /dashboard/api/trace` → 503 y el
  service NO se invoca (dev y prod).
- **AC-2** Con token configurado y header ausente/incorrecto → 401 y el service NO se
  invoca.
- **AC-3** `GET /dashboard/trace` (HTML) responde 200 sin token y su cuerpo no contiene
  ningún dato de tenant.
- **AC-4** Los recibos se agrupan por `orchestration_id`; los que lo tienen NULL no se
  mezclan entre sí ni con otra llamada.
- **AC-5** Un recibo con `chain_id` EVM + `settle_caip2` Solana se marca `crossChain: true`;
  un settle Solana sobre un `chain_id` Solana se marca `false`.
- **AC-6** Los skips se cuentan y se muestran con el vocabulario **público**; un código
  interno presente en los datos NO se cuenta ni se muestra.
- **AC-7** Auto-refresh ~10s con hora de última actualización visible; si el fetch falla, la
  pantalla marca el estado como stale en vez de seguir mostrando datos viejos como buenos.
- **AC-8** Cero botones que disparen `/compose` u `/orchestrate`.

## 8. Deuda técnica registrada

- **TD-TRACE-1** — `budget_debit` sin `orchestration_id` (H-2): threadearlo unificaría cada
  grupo en una sola fila. Cambio de money-path.
- **TD-TRACE-2** — los dos gates admin existentes duplican la comparación timing-safe
  (`adminTokenMatches`).
- **TD-TRACE-3** — `/orchestrate*` no correlaciona evento con recibos (H-1): usar
  `request.id` como `orchestrationId`, o persistir el `orchestrationId` en el evento.
