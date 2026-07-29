# SDD #190: [WKH-303] Congelar la cotización 10 minutos con quote firmado (orchestrate plan→execute)

> SPEC_APPROVED: no
> Fecha: 2026-07-28
> Tipo: feature
> SDD_MODE: full
> Branch: `feat/190-wkh-303-quote-freeze`
> Artefactos: `doc/sdd/190-wkh-303-quote-freeze/`
> Work item: [`work-item.md`](work-item.md)

---

## 1. Resumen

`POST /orchestrate/plan` cotiza y `POST /orchestrate/execute` ejecuta y debita. Entre las dos
requests hay una ventana en la que el precio de un agente puede cambiar. Hoy `/execute`
**re-resuelve el precio en vivo** (`src/routes/orchestrate.ts:379-391`) y lo único que lo frena es
un techo que declara el propio cliente (`maxQuotedCostUsdc`): si el precio cambió pero quedó por
debajo del techo, **se debita el precio nuevo sin que nadie lo haya aprobado**. Ni el precio ni la
identidad del agente viajan firmados, así que tampoco hay nada que impida ejecutar un agente
distinto del que se cotizó.

Esta HU agrega un **quote firmado, stateless, con TTL de 10 minutos**: `/plan` lo emite,
el cliente lo devuelve en `/execute`, y el gateway debita **el precio y la identidad congelados**,
nunca los re-resueltos en vivo. Sin storage nuevo (ni tabla Postgres ni Redis): el token es
autocontenido y se verifica con un secreto del servidor (HMAC-SHA256 + `timingSafeEqual`),
siguiendo el idiom que el repo ya usa en `src/services/receipt.ts` y
`src/services/llm/transform-hmac.ts`. Sin el campo `quote`, el comportamiento de hoy queda
byte a byte intacto.

`POST /compose` y `POST /orchestrate` (atómicos) quedan **explícitamente fuera**: cotizan y
debitan en la misma request, no tienen la ventana que esta HU cierra.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 190 (WKH-303) |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Objetivo** | Que el monto debitado en `/orchestrate/execute` sea exactamente el cotizado en `/orchestrate/plan` durante 10 minutos, para el agente exacto que se cotizó, sin storage nuevo. |
| **Reglas de negocio** | Freeze de precio **e** identidad por step; TTL 10 min; atado a la credencial que cotizó; re-verificación de existencia del agente al redimir; vencido ⇒ error re-cotizable, nunca cobro al precio nuevo; sin quote ⇒ comportamiento actual intacto. |
| **Scope IN** | Ver §6 |
| **Scope OUT** | Ver §6 |
| **Missing Inputs** | Ninguno bloqueante (§9). Los tres pendientes del work-item quedan resueltos en §4. |

### Acceptance Criteria (EARS) — heredados del work-item

- **AC-1**: WHEN `POST /orchestrate/plan` responde con `planStatus:'ready'`, the system SHALL
  incluir un quote firmado (token opaco, HMAC-SHA256) que congela, por cada step, la identidad
  resuelta del agente (`registry` + `slug`) y su `priceUsdc` cotizado, válido por exactamente
  10 minutos desde su emisión.
- **AC-2**: WHEN `POST /orchestrate/execute` recibe un quote válido, no expirado y atado al caller
  que lo presenta, the system SHALL debitar y ejecutar cada step congelado usando el precio Y la
  identidad de agente del quote — NUNCA el precio ni la identidad re-resueltos en vivo.
- **AC-3**: IF el quote expiró o su firma no verifica, THEN the system SHALL rechazar con un código
  explícito y distinguible, SHALL NOT debitar monto alguno, y SHALL indicar que se requiere una
  nueva cotización.
- **AC-4**: IF el quote fue emitido para una credencial distinta de la que lo presenta, THEN the
  system SHALL rechazar sin debitar, con un código distinguible del de expiración.
- **AC-5**: IF un agente congelado ya no existe o está desactivado al momento de `/execute`, THEN
  the system SHALL rechazar esa redención con un error explícito y SHALL NOT cobrar ni el precio
  congelado ni un precio en vivo por ese agente.
- **AC-6**: WHERE el caller NO incluye quote, the system SHALL preservar el comportamiento actual
  sin cambios (re-resolución en vivo contra `maxQuotedCostUsdc`, `409 QUOTE_STALE` si lo supera).
- **AC-7**: the system SHALL implementar el congelamiento sin storage durable nuevo: el quote SHALL
  ser autocontenido y verificable solo con un secreto del servidor.

---

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón / hallazgo extraído |
|---------|---------|----------------------------|
| `src/routes/orchestrate.ts` (481 líneas, leído entero) | Es el sitio del bug y del fix | `/plan` L174-292 arma la respuesta con un **pick** de campos públicos (L267-278); `/execute` L299-478 re-resuelve `costPerStep` y `step0Price` con `resolveAgentPriceUsdc` (L379-391) y construye el `OrchestratePlanResult` a mano (L406-423). El `orchestrationId` de billing se genera server-side (L357), el del cliente sólo correlaciona (L359). Los guards nuevos entran **antes** de L425 (`executeApprovedPlan`), que es la única llamada que debita. |
| `src/services/orchestrate.ts` L1043-1232 + L930-1041 | Dónde se debita el step-0 y dónde vive el cap gate | `executeApprovedPlan` L1101-1115: el cap gate corre **sólo** si `request.maxQuotedCostUsdc !== undefined`, y usa `quoteMaxCostUsdc(steps, forceRefresh=true)` (re-resolución en vivo). El débito del step-0 es `plan.plannedCostUsd + gasOverhead` (L1140) vía `budgetService.debit` (L1149). `billsStep0 = request.scopingKeyRow !== undefined` (L1097) ⇒ cubre master **y** delegación/sesión. `planOrchestration` L961-1001 arma `costPerStep` con `resolveAgentPriceUsdc` (null ⇒ 0). |
| `src/services/compose.ts` L175-338 y L845-889 | Dónde se debitan los steps 1..N | El débito per-step usa `agent.priceUsdc` del agente **resuelto en vivo** (L284-296), con fallback `PLACEHOLDER_FEE_USD` si es 0/negativo/NaN. Guard `i > 0` (L274) = única defensa anti double-charge del step-0, NO TOCAR. `totalCost += agent.priceUsdc` (L888) alimenta `pipeline.totalCostUsdc` (base del protocol fee) — es el costo **ejecutado**, no lo que paga el caller. |
| `src/services/receipt.ts` L31-98 | Exemplar principal del token firmado | `CanonicalFields` + `buildCanonicalPayload` (orden alfabético explícito, `Number(x).toFixed(8)`), `computeReceiptHash` (devuelve `null` si el secret no está ⇒ degradación limpia), `hashesEqual` (regex hex ANTES de `Buffer.from`, longitud ANTES de `timingSafeEqual`, nunca throw). |
| `src/services/llm/transform-hmac.ts` (84 líneas) | Exemplar del par sign/verify puro | `signX`/`verifyX` sin dependencias de DB; `HEX = /^[0-9a-f]{64}$/`; verify **nunca** tira, devuelve `false` ante cualquier entrada malformada. |
| `src/services/signed-auth.ts` (314 líneas) | Exemplar de orden de verificación y resultado discriminado | Resultado `{ok:true} | {ok:false, code}` que el middleware mapea a HTTP; orden explícito de checks documentado; "las funciones reciben PRIMITIVOS, no `request` de Fastify". Su anti-replay usa Postgres — **esta HU no lo copia** (CD-1). |
| `src/lib/caller-hash.ts` L32-39 | Exemplar de "HMAC de una identidad para no exponerla" | `hashCallerRef` = `HMAC-SHA256(secret, owner_ref)` hex. Justifica meter el binding como HMAC y no como id crudo dentro del token. |
| `src/services/agent-price.ts` (123 líneas) | Resolución de precio e identidad | `resolveAgentPriceUsdc(slug, registry, forceRefresh)` → `number | null` (null ⇔ el agente no resolvió en NINGÚN registry habilitado, con fallback sin hint L70-72); cache in-process 60s; `_resetAgentPriceCache()` TEST-ONLY. `resolveAgentDestination` devuelve la identidad canónica. |
| `src/middleware/a2a-key.ts` L69-101, L609-623, L695-721, L957-965, L1205, L1321 | Contextos de débito y garantía de "cero débito antes del handler" | Decoraciones: `a2aKeyRow`, `delegationContext`, `keySessionContext`, `resolvedChainId`, `skipMiddlewareDebit`. **Verificado**: el flag `skipMiddlewareDebit` se respeta en los tres paths (master L1205, delegación L721, sesión L965) ⇒ en `/orchestrate/execute` **ninguna capa debita antes del handler**. El comentario L712-720 sobre "deleg/session no se factura el step-0" está desactualizado: `billsStep0` (orchestrate.ts:1097) sí los factura. |
| `src/types/index.ts` L483-545, L700-818 | Contratos a extender | `ResolvedComposeStep`, `ComposeRequest`, `OrchestrateRequest`, `OrchestratePlanResult`. |
| `src/types/a2a-key.ts` L280-285, L435-439 | Shape del binding | `DelegationDebitContext.delegationId`, `KeySessionDebitContext.sessionId`, ambos con `ownerRef` + `keyId`. |
| `tsconfig.json` | Reglas de compilación | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` **activos** ⇒ los campos opcionales nuevos se asignan condicionalmente, nunca con `undefined` explícito. |
| `.env.example` L415-425, L694-701 | Convención de nombres de secretos | `SCHEMA_TRANSFORM_HMAC_KEY`, `RECEIPT_SIGNING_SECRET`; bloque con separador `# ─────`, explicación de qué pasa si está vacía y `openssl rand -hex 32`. |
| `src/routes/orchestrate.test.ts` (755 líneas) | Harness de tests de ruta | Mockea `a2a-key` (pass-through que puebla `a2aKeyRow`), `forward-key`, `timeout`, `rate-limit`, `backpressure`, `agent-price`, `fee-charge` y `orchestrateService` entero. T-ROUTE-EXEC (L645-666) ya cubre `409 QUOTE_STALE`. |
| `src/services/orchestrate.billing.test.ts` (789 líneas) | Harness de tests de dinero | Corre el **compose real**, mockea sólo el borde (`budgetService.debit`, `discoveryService`, adapters, fetch) y afirma cantidad/monto exacto de débitos. Es el molde del archivo nuevo de §4.9. |
| `src/routes/charged-routes.meta.test.ts` L86-91, L275-292 | Lista congelada de rutas que cobran | `POST /orchestrate/plan` y `/execute` ya están en `LEGACY_UNVALIDATED`. Esta HU **no agrega rutas ni preHandlers de validación** ⇒ la lista no se toca. |
| `doc/INTEGRATION.md` L268-306 | Doc pública del contrato de `/plan` | Documenta `protocolFeeUsdc` / `feeRatePercent` / `maxQuotedCostUsdc`. El quote va documentado ahí (W3.1). |
| `doc/sdd/208-.../auto-blindaje.md`, `203-.../auto-blindaje.md`, `202-.../auto-blindaje.md` | Errores recurrentes de las últimas 3 HUs DONE | Ver §3.1 |

### 3.1 Auto-Blindaje histórico aplicado (últimas 3 HUs DONE)

| Patrón recurrente | HUs | Cómo se previene en este SDD |
|---|---|---|
| **Dos expresiones separadas para la misma cantidad de dinero** (refund ≠ débito) | HU-208 W2, HU-203 | **CD-12**: `resolveQuoteCaller` y `computeQuoteBinding` son la ÚNICA fuente del binding, usadas por emisión y por redención; el precio congelado se lee de UN solo lugar (`payload.steps[i].priceUsdc`) tanto para step-0 como para 1..N. |
| **Tests que afirman el efecto pero no el costo / no el saldo** | HU-208 W2 y W3 | **CD-13**: todo test de rechazo afirma **saldo antes === saldo después**, no sólo el status code; los tests de éxito afirman `saldoAntes − saldoDespués === precio congelado`. |
| **Dobles que descartan argumentos o devuelven menos que la función real** ⇒ mutantes que sobreviven | HU-202 W1 y fix-pack (3ª reincidencia) | **CD-14**: los dobles de `budgetService.debit` y `resolveAgentPriceUsdc` capturan y afirman **todos** sus argumentos (monto, índice, slug), y se tipan con el retorno real. |
| **Mutation testing sobre trabajo no commiteado destruido por `git checkout --`** | HU-203, HU-202 | **CD-15**: el harness de mutación copia el archivo FUERA del árbol de git y verifica la restauración con `sha256sum`. `git checkout/restore/stash` PROHIBIDOS como undo. |
| **Restaurar estado global en la última línea del test** ⇒ fallos en cascada | HU-202 W2 | **CD-16**: el `ORCHESTRATE_QUOTE_HMAC_KEY` de test se restaura en `afterEach`, nunca al final del cuerpo. |
| **Aserción que re-implementa la lógica que dice verificar** (verdadera por construcción) | HU-202 fix-pack | **CD-17**: ningún test re-implementa el HMAC para compararlo consigo mismo; los tests de firma usan un token **producido por `signQuote`** y mutado byte a byte, o un token construido con OTRA clave. |

### Exemplars (paths verificados en disco)

| Para crear/modificar | Seguir patrón de | Qué patrón copiar |
|---------------------|------------------|-------------------|
| `src/services/orchestrate-quote.ts` (nuevo) | `src/services/receipt.ts:31-98` + `src/services/llm/transform-hmac.ts:1-84` | payload canónico con keys en orden alfabético y `toFixed(8)`; getter de secreto que devuelve `null` si falta; regex hex antes de `Buffer.from`; longitud antes de `timingSafeEqual`; verify que NUNCA tira |
| Resultado discriminado del verify | `src/services/signed-auth.ts:242-314` | `{ok:true, payload} | {ok:false, code}`; el route mapea `code` → HTTP; orden de checks documentado en el JSDoc |
| Binding del caller como HMAC | `src/lib/caller-hash.ts:32-39` | `HMAC-SHA256(secret, "<kind>:<id>")` hex, para no exponer ids internos en un token que el cliente puede decodificar |
| `src/services/orchestrate-quote.test.ts` (nuevo) | `src/services/llm/transform-hmac.test.ts` (84 líneas) + `src/services/receipt.test.ts` | tests de sign/verify puros, sin mocks de DB |
| `src/services/orchestrate.quote-billing.test.ts` (nuevo) | `src/services/orchestrate.billing.test.ts:1-120` | mocks de borde + compose REAL + aserciones sobre `budgetService.debit` |
| Guards nuevos en `/execute` | `src/routes/orchestrate.ts:444-451` (el 409 `QUOTE_STALE` actual) | `reply.status(N).send({ error_code, ... })` con return temprano |
| Campos nuevos en la respuesta de `/plan` | `src/routes/orchestrate.ts:243-278` (`feeRatePercent` de WKH-132) | campo aditivo `undefined` ⇒ `JSON.stringify` lo omite ⇒ back-compat |
| Bloque nuevo en `.env.example` | `.env.example:415-425` (`SCHEMA_TRANSFORM_HMAC_KEY`) | separador, explicación del modo degradado, `openssl rand -hex 32` |

### Estado de BD relevante

| Tabla | Existe | Cambios |
|-------|--------|---------|
| — | — | **NINGUNO.** Esta HU no crea, altera ni consulta tablas nuevas (AC-7 / CD-1). Cero migraciones. |

### Componentes reutilizables encontrados (no reinventar)

- `resolveAgentPriceUsdc` (`src/services/agent-price.ts:44`) — resuelve precio **y** existencia en una
  sola llamada: `null` ⇔ el agente no resuelve en ningún registry habilitado. Sirve para AC-5 sin
  agregar un lookup nuevo.
- `PLACEHOLDER_FEE_USD` (`src/lib/pricing-constants.ts:16`) — el fallback $1 ya centralizado.
- `timingSafeEqual` + regex hex — ya hay tres implementaciones idénticas (`transform-hmac.ts:69-83`,
  `signed-auth.ts:178-193`, `receipt.ts:92-98`). Se replica el patrón local (son 6 líneas y las tres
  copias existen); **no** se refactoriza a un helper común (fuera de scope).
- `budgetService.debit` / `getBalance` — el dispatcher de débito no cambia.

---

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| # | Archivo | Acción | Qué cambia | AC | Wave | Exemplar |
|---|---------|--------|-----------|----|------|----------|
| 1 | `src/services/orchestrate-quote.ts` | **Crear** | Módulo leaf: constantes, tipos, `resolveQuoteCaller`, `computeQuoteBinding`, `signQuote`, `verifyQuote`. Sin imports de DB/Redis/Fastify. | AC-1,3,4,7 | W0.1 | `receipt.ts` + `transform-hmac.ts` |
| 2 | `src/types/index.ts` | Modificar | `ComposeRequest.frozenStepPricesUsd?: readonly number[] | undefined` y `OrchestrateRequest.frozenStepPricesUsd?: readonly number[] | undefined` (aditivos, con JSDoc). | AC-2 | W0.2 | JSDoc de `keySessionContext` (L520-545) |
| 3 | `.env.example` | Modificar | Bloque nuevo `ORCHESTRATE_QUOTE_HMAC_KEY` (§4.6). | AC-7, CD-5 | W0.3 | `.env.example:415-425` |
| 4 | `src/routes/orchestrate.ts` (`/plan`) | Modificar | Emitir `quote` + `quoteExpiresAt` cuando se cumplen las 5 precondiciones de §4.4.1. | AC-1, AC-6 | W1.1 | L243-278 |
| 5 | `src/routes/orchestrate.ts` (`/execute`) | Modificar | Campo `quote?` en el body + schema; los 6 guards de §4.5 ANTES de `executeApprovedPlan`; con quote válido: `costPerStep`/`plannedCostUsd`/`frozenStepPricesUsd` congelados y `maxQuotedCostUsdc` NO propagado al service. | AC-2,3,4,5,6 | W1.2 | L444-451 |
| 6 | `src/services/orchestrate.ts` | Modificar | `executeApprovedPlan` propaga `request.frozenStepPricesUsd` a `composeService.compose`. Una línea aditiva en el objeto de L1213-1232. | AC-2 | W1.3 | L1218-1231 |
| 7 | `src/services/compose.ts` | Modificar | En el débito per-step (L274-296): si hay precio congelado válido para el índice `i`, ese es el `debitAmount` (más el gas overhead); si no, el camino de hoy intacto. | AC-2 | W1.3 | L284-296 |
| 8 | `src/services/orchestrate-quote.test.ts` | **Crear** | 11 tests unitarios del módulo (§4.9). | AC-1,3,4,7 | W2.1 | `transform-hmac.test.ts` |
| 9 | `src/routes/orchestrate.test.ts` | Modificar | +15 tests de ruta (§4.9), en un `describe` nuevo. | AC-1..6 | W2.2 | tests T-ROUTE-EXEC existentes |
| 10 | `src/services/orchestrate.quote-billing.test.ts` | **Crear** | 7 tests de dinero con saldo antes/después (§4.9). | AC-2,3,5,6 | W2.3 | `orchestrate.billing.test.ts` |
| 11 | `doc/INTEGRATION.md` | Modificar | Sección nueva del quote + tabla de errores, después del bloque de fee (L268-306). | AC-1,3 | W3.1 | el propio bloque de fee |

**Ningún otro archivo se toca.** En particular: nada de `src/middleware/`, nada de migraciones,
nada en `src/routes/compose.ts`.

### 4.2 Modelo de datos

**N/A — cero cambios de BD.** El quote es un token autocontenido (AC-7 / CD-1). No se crea tabla,
no se usa Redis, no se guarda estado en memoria del proceso.

### 4.3 El módulo del quote (`src/services/orchestrate-quote.ts`)

#### 4.3.1 Constantes

| Constante | Valor | Por qué |
|---|---|---|
| `QUOTE_VERSION` | `'v1'` | prefijo del token; permite rotar el formato sin ambigüedad |
| `QUOTE_TTL_SECONDS` | `600` | los 10 minutos que decidió el founder. **Sin env override**: una env que alargue la ventana de freeze es una palanca silenciosa sobre el money-path. |
| `QUOTE_CLOCK_SKEW_SECONDS` | `60` | tolerancia máxima de `iat` en el futuro (deriva de reloj entre instancias) |
| `QUOTE_MAX_TOKEN_CHARS` | `8192` | techo de tamaño antes de decodificar nada (guard de DoS) |
| `QUOTE_ENV_VAR` | `'ORCHESTRATE_QUOTE_HMAC_KEY'` | nombre del secreto, en un solo lugar |

#### 4.3.2 Formato del token (decisión del Missing Input #2 del work-item)

```
<QUOTE_VERSION>.<base64url(payloadJSON)>.<hmacHex64>
```

- **No es JWT**: agregar una dependencia de JWT para firmar un objeto propio con HMAC no aporta nada
  (no hay interoperabilidad de terceros, no hay JWKS, no hay claims estándar) y el repo ya tiene el
  idiom propio en `receipt.ts` / `transform-hmac.ts`. Cero dependencias nuevas.
- **La firma se computa sobre el string crudo `"<version>.<b64payload>"`**, no sobre el objeto
  parseado ⇒ al verificar NO hace falta parsear JSON no confiable: primero verifica el HMAC, después
  decodifica (CD-8).
- `payloadJSON` = `JSON.stringify` de un objeto con las keys en **orden alfabético explícito**
  (patrón `buildCanonicalPayload`, `receipt.ts:57-75`).

#### 4.3.3 Payload

| Key | Tipo | Contenido |
|---|---|---|
| `bind` | `string` (hex 64) | HMAC del caller — §4.3.4 |
| `exp` | `number` (epoch s) | `iat + QUOTE_TTL_SECONDS` |
| `iat` | `number` (epoch s) | emisión |
| `oid` | `string` | `orchestrationId` del **plan** (sólo correlación; el id de billing lo sigue generando `/execute` server-side, L357 — CD-11) |
| `steps` | `Array<{a,p,r}>` | `a` = slug del agente; `r` = registry (`string | null`); `p` = precio como string `toFixed(8)` |
| `v` | `1` | versión del payload |

`p` viaja como string de 8 decimales para que firma y verificación sean byte-idénticas y para que no
haya sorpresas de coma flotante entre emisión y redención (patrón `amount_usd` en `receipt.ts:61`).

#### 4.3.4 Binding al caller (decisión del Missing Input #3 del work-item)

```
QuoteCaller = { kind: 'delegation'|'session'|'key', id: string }
bind = HMAC-SHA256(secret, "quote-bind:v1:" + kind + ":" + id)  → hex
```

`resolveQuoteCaller(ctx)` — **única fuente de verdad**, usada por emisión y por redención (CD-12) —
con esta precedencia, que espeja cómo se enruta el débito en el middleware:

1. `delegationContext` presente → `{kind:'delegation', id: delegationContext.delegationId}`
2. si no, `keySessionContext` presente → `{kind:'session', id: keySessionContext.sessionId}`
3. si no, `a2aKeyRow` presente → `{kind:'key', id: a2aKeyRow.id}`
4. si no (x402 / anónimo) → `null` ⇒ **no se emite quote y no se puede redimir uno** (x402 ya paga
   el monto exacto que firma; ver work-item §Resumen).

Por qué HMAC y no el id crudo: el payload es base64url, o sea legible por cualquiera que tenga el
token. Meter `a2a_agent_keys.id` o el `delegationId` adentro filtraría identificadores internos.
Precedente exacto: `hashCallerRef` (`src/lib/caller-hash.ts:32-39`). `kind` entra al HMAC para que
una delegación y una sesión con el mismo UUID no colisionen.

**DT-3 se implementa literal**: el binding es a la credencial exacta, no al `owner_ref`. El mismo
owner con OTRA de sus keys **no** puede redimir el quote (test T-Q-R10). No encontré ningún caso de
uso legítimo que lo justifique relajar: `/plan` y `/execute` los llama el mismo cliente con la misma
credencial (Chaski usa una sola key por sesión), y relajarlo a `owner_ref` habilitaría que una
sesión delegada con cap chico redima una cotización obtenida por la master key.

#### 4.3.5 API pública del módulo

| Función | Firma | Notas |
|---|---|---|
| `quoteHmacKey()` | `(): string | null` | lee `process.env.ORCHESTRATE_QUOTE_HMAC_KEY`; vacío/ausente → `null` (patrón `computeReceiptHash`, `receipt.ts:81-85`). **Sin fallback a otro secreto** (CD-5). |
| `resolveQuoteCaller(ctx)` | `(ctx: {delegationContext?, keySessionContext?, a2aKeyRow?}) => QuoteCaller | null` | tipo estructural, **sin importar Fastify** (patrón `signed-auth.ts` L20-22) |
| `computeQuoteBinding(caller)` | `(caller: QuoteCaller) => string | null` | `null` si no hay secreto |
| `signQuote(input)` | `({orchestrationId, caller, steps: QuoteStepInput[], nowMs?}) => {token, expiresAtIso} | null` | `null` si: no hay secreto, `steps` vacío, o algún precio no es finito y `> 0` (§4.4.1). **Nunca tira.** |
| `verifyQuote(token, caller, nowMs?)` | `=> {ok:true, payload} | {ok:false, code}` | `code ∈ {'QUOTE_INVALID','QUOTE_EXPIRED','QUOTE_CALLER_MISMATCH'}`. **Nunca tira.** |

#### 4.3.6 Orden de verificación en `verifyQuote` (CD-8, load-bearing)

1. `typeof token === 'string'` y `token.length <= QUOTE_MAX_TOKEN_CHARS` → si no, `QUOTE_INVALID`.
2. Hay secreto → si no, `QUOTE_INVALID` (**fail-closed**: sin secreto no se puede verificar, así que
   no se acepta ningún quote; nunca se cae al camino de precio vivo con un quote presente).
3. Split en 3 partes por `.`, prefijo `v1`, firma con forma hex de 64 chars → si no, `QUOTE_INVALID`.
4. **HMAC sobre `"<v>.<b64>"` + `timingSafeEqual`** → si no coincide, `QUOTE_INVALID`.
5. Recién ahora: base64url-decode + `JSON.parse` (en `try/catch`) + validación de forma
   (`v===1`, `iat`/`exp` enteros, `steps` array no vacío, cada `a` string no vacío, cada `p` parseable
   a un número finito **> 0**, `r` string o null) → si no, `QUOTE_INVALID`.
6. `nowSec >= exp` → `QUOTE_EXPIRED`. `iat > nowSec + QUOTE_CLOCK_SKEW_SECONDS` → `QUOTE_INVALID`
   (token del futuro = reloj desviado; sin este guard una instancia adelantada emite quotes que
   viven más de 10 minutos para el resto de la flota).
7. `computeQuoteBinding(caller)` vs `payload.bind` con `timingSafeEqual` → si no, `QUOTE_CALLER_MISMATCH`.

Por qué firma **antes** que expiración (al revés que `signed-auth.ts`, que chequea timestamp
primero): acá el `exp` viaja **dentro** del payload que estamos verificando; leerlo antes de validar
el HMAC sería confiar en un campo que el atacante controla. En `signed-auth.ts` el timestamp viaja
en un header aparte, por eso allá el orden es el otro.

### 4.4 Flujo principal (Happy Path)

#### 4.4.1 Emisión — `POST /orchestrate/plan`

Después de `planOrchestration` y del cálculo de `feeRatePercent`/`protocolFeeUsdc` que ya existe
(L243-261), el route intenta emitir el quote. Se emite **sólo si se cumplen las cinco**:

1. `plan.planStatus === 'ready'`;
2. `quoteHmacKey() !== null`;
3. `resolveQuoteCaller(request) !== null` (hay credencial bindeable);
4. `plan.steps.length >= 1` y todo step tiene `agent` string no vacío;
5. **todo** `plan.costPerStep[i]` es finito y `> 0`.

Si falla cualquiera, `quote` y `quoteExpiresAt` quedan `undefined` y `JSON.stringify` los omite ⇒
**respuesta byte-idéntica a la de hoy** (mismo mecanismo que `feeRatePercent`, L266).

La condición 5 es deliberada: si un step no resolvió precio (o el agente es gratis), `costPerStep[i]`
es 0 y hoy ese step se cobra con `PLACEHOLDER_FEE_USD` ($1). Congelar un 0 sería congelar un cobro de
$0 (revenue leak) y congelar $1 sería congelar un número que nunca se cotizó. La alternativa honesta
es no emitir quote para ese plan: el cliente sigue con el comportamiento de hoy, que no empeora.

Respuesta (dos campos aditivos):

```jsonc
{
  "orchestrationId": "…", "planStatus": "ready", "steps": [...],
  "costPerStep": [0.05, 0.06], "totalCostUsdc": 0.11,
  "protocolFeeUsdc": 0.0011, "feeRatePercent": 1, "maxQuotedCostUsdc": 0.1211,
  "reasoning": "…", "consideredAgents": [...],
  "quote": "v1.eyJiaW5kIjoi….a3f…",          // NUEVO
  "quoteExpiresAt": "2026-07-28T14:31:07.000Z" // NUEVO (informativo; el exp real va firmado adentro)
}
```

#### 4.4.2 Redención — `POST /orchestrate/execute`

Con `body.quote` presente y los 6 guards de §4.5 en verde, el handler arma el plan con los valores
**congelados** en vez de los re-resueltos:

| Valor | Sin quote (hoy, intacto) | Con quote válido |
|---|---|---|
| `costPerStep[i]` | `resolveAgentPriceUsdc(step)` en vivo | `payload.steps[i].p` |
| `plannedCostUsd` (base del débito del step-0) | `resolveAgentPriceUsdc(steps[0])` en vivo | `payload.steps[0].p` |
| `totalCostUsdc` / `feeUsdc` (reserva de `maxBudget`) | suma en vivo × rate | suma congelada × rate |
| `maxQuotedCostUsdc` **en el request al service** | `body.maxQuotedCostUsdc` ⇒ corre el cap gate | **NO se pasa** ⇒ el cap gate no corre (§4.4.3) |
| `frozenStepPricesUsd` (campo nuevo) | ausente | los N precios congelados |
| `plan.maxQuotedCostUsdc` (campo informativo del resultado) | `body.maxQuotedCostUsdc` | `body.maxQuotedCostUsdc` (sin cambios) |

Después, `executeApprovedPlan` corre igual que hoy: debita el step-0 con `plannedCostUsd + gas`
(orchestrate.ts:1140) y compose debita los steps 1..N. La única diferencia es de dónde salen los
números.

Steps 1..N: `executeApprovedPlan` pasa `frozenStepPricesUsd` a `composeService.compose`, y el bloque
de débito per-step (compose.ts:274-296) queda:

- si `frozenStepPricesUsd?.[i]` es finito y `> 0` → `debitAmount = ese precio + stepGasOverhead`;
- si no (ausente, 0, negativo, NaN) → **exactamente el camino de hoy**
  (`(isInvalid ? PLACEHOLDER_FEE_USD : agent.priceUsdc) + stepGasOverhead`).

Todo lo demás de compose queda intacto: el guard `i > 0` (CD-6), el `maxBudget` check con precio
vivo, `totalCost += agent.priceUsdc` (el costo **ejecutado**, base del protocol fee) y el settle
downstream, que le sigue pagando al agente su precio vivo. **El freeze aplica exclusivamente al monto
que se le debita al caller** — que es justamente lo que el caller aprobó.

#### 4.4.3 Por qué el cap gate no corre cuando hay quote válido

El cap gate (`orchestrate.ts:1101-1115`) re-resuelve todos los precios en vivo y tira
`409 QUOTE_STALE` si la suma supera `maxQuotedCostUsdc`. Con un quote válido eso rompería AC-2: el
caller tiene una garantía de precio y aun así se le rechazaría la ejecución porque el precio **vivo**
(que ya no lo afecta) subió. Además es redundante: la suma congelada es ≤ el techo por construcción,
porque el techo se derivó de esos mismos precios en `/plan`. Con `exactOptionalPropertyTypes`, el
request al service se arma con spread condicional para no pasar `maxQuotedCostUsdc: undefined`.

Sin quote, el cap gate corre igual que hoy (AC-6).

### 4.5 Flujo de error — los 6 guards de `/execute`

Todos corren en el handler **antes** de la primera llamada a `executeApprovedPlan`
(`orchestrate.ts:425`), que es la única línea que mueve dinero. Ninguna capa anterior debita en esta
ruta: `markSkipMiddlewareDebitHandler` está en el preHandler (L342) y el flag se respeta en los tres
paths del middleware (master `a2a-key.ts:1205`, delegación `:721`, sesión `:965`) — verificado.
De ahí sale la garantía estructural de "0 débito" de AC-3/AC-4/AC-5 (CD-3).

| # | Guard | Condición | HTTP | `error_code` | AC |
|---|-------|-----------|------|--------------|----|
| G1 | Token verificable | `verifyQuote` → `QUOTE_INVALID` (forma, firma, secreto ausente, payload inválido, precio ≤ 0, `iat` futuro) | 400 | `QUOTE_INVALID` | AC-3 |
| G2 | Vigencia | `verifyQuote` → `QUOTE_EXPIRED` | 409 | `QUOTE_EXPIRED` | AC-3 |
| G3 | Binding | `verifyQuote` → `QUOTE_CALLER_MISMATCH`; también cuando `resolveQuoteCaller(request) === null` (x402 presentando un quote) | 403 | `QUOTE_CALLER_MISMATCH` | AC-4 |
| G4 | Cantidad de steps | `body.steps.length !== payload.steps.length` | 400 | `QUOTE_STEP_MISMATCH` | AC-2 |
| G5 | Identidad por step | para algún `i`: `body.steps[i].agent !== payload.steps[i].a` **o** `(body.steps[i].registry ?? null) !== payload.steps[i].r` | 400 | `QUOTE_STEP_MISMATCH` | AC-2 |
| G6 | Agente vivo | para algún `i`: `resolveAgentPriceUsdc(a, r ?? undefined, /*forceRefresh*/ true)` → `null` | 409 | `QUOTE_AGENT_UNAVAILABLE` | AC-5 |

Cuerpo de error, idéntico en los 5 códigos nuevos:

```json
{ "error_code": "QUOTE_EXPIRED", "requiresNewQuote": true }
```

`requiresNewQuote: true` es la parte de AC-3 que exige "indicar que se requiere una nueva
cotización", y es un campo que el cliente puede usar sin parsear strings.

Notas de diseño de los guards:

- **G5 rechaza, no corrige.** La alternativa (ejecutar la identidad del quote ignorando la que mandó
  el cliente) deja al cliente con un agente distinto del que pidió y con el input pensado para otro
  agente. Rechazar es más honesto y, sobre todo, **verificable**: existe un test que lo pone rojo si
  el guard desaparece (M4). Tras G4+G5, la identidad ejecutada **es** la del quote, que es lo que
  pide AC-2 y lo que cierra el ataque "ejecutar otro agente al precio del primero".
- **G6 usa `resolveAgentPriceUsdc(..., forceRefresh=true)`**, el mismo resolver que usa el money-path:
  `null` ⇔ el agente no resuelve en **ningún** registry habilitado (agent-price.ts:59-78) ⇒ borrado,
  desactivado o su registry deshabilitado. No agrega un lookup nuevo: reemplaza, uno a uno, los que
  hacía el cap gate que ya no corre. Su precio vivo se usa **sólo** para telemetría (§4.7), nunca
  para debitar.
- El orden G1→G6 es de barato a caro: la criptografía es local, la existencia del agente es red.

### 4.6 Env var nueva

```bash
# ─────────────────────────────────────────────────────────────
# Orchestrate quote freeze (WKH-303) — congelamiento de precio
# ─────────────────────────────────────────────────────────────
# Clave HMAC-SHA256 con la que `POST /orchestrate/plan` firma la cotización que
# `POST /orchestrate/execute` puede redimir durante 10 minutos para que el monto
# debitado sea EXACTAMENTE el cotizado. El token es autocontenido: no hay tabla ni
# Redis detrás. Si esta var está vacía, `/plan` NO emite quote y `/execute` rechaza
# cualquier quote que le presenten (fail-closed) — el comportamiento vuelve a ser
# el de hoy (precio re-resuelto en vivo contra `maxQuotedCostUsdc`).
# NUNCA reusar otro secreto acá (REQUEST_EIP712_*, RECEIPT_SIGNING_SECRET, etc.).
# Generar con: openssl rand -hex 32
ORCHESTRATE_QUOTE_HMAC_KEY=
```

Rotación: rotar la clave invalida todos los quotes en vuelo ⇒ los clientes reciben `QUOTE_INVALID`
y re-cotizan. Es aceptable (ventana de 10 minutos) y queda escrito en `doc/INTEGRATION.md`.

### 4.7 Telemetría (aditiva, sin PII, nunca el token ni el secreto)

| Log | Nivel | Cuándo | Campos |
|---|---|---|---|
| `[orchestrate.quote.issued]` | info | `/plan` emite | `orchestrationId`, `stepCount`, `expiresAt` |
| `[orchestrate.quote.redeemed]` | info | `/execute` con quote válido | `orchestrationId`, `planId`, `stepCount`, `ttlRemainingSec` |
| `[orchestrate.quote.price-delta]` | warn | por step donde el precio vivo ≠ el congelado | `orchestrationId`, `step`, `frozenUsd`, `liveUsd`, `deltaUsd` |
| `[orchestrate.quote.rejected]` | warn | cualquier guard G1-G6 | `orchestrationId`, `planId`, `error_code` |

`price-delta` es la métrica que mide RIESGO-1 en producción: sin ella, la exposición del gateway al
freeze es invisible.

### 4.8 Compromiso aceptado y a la vista: el quote se puede redimir más de una vez

**Un quote válido puede redimirse todas las veces que quepan en sus 10 minutos.** Impedirlo exigiría
llevar registro de "ya usado", o sea storage — exactamente lo que el founder descartó.

Qué significa y qué no:

- **No es doble cobro.** Cada redención ejecuta el pipeline de verdad y debita su propio importe:
  dos redenciones = dos ejecuciones = dos débitos. Lo que se repite es la **garantía de precio**,
  honrada dos veces, no el cargo por un mismo trabajo.
- **No es un bypass de límites.** Cada redención pasa por `budgetService.debit` con el budget, el
  daily limit, el cap por destino y los caps de delegación/sesión intactos.
- **El límite del daño es**: durante ≤ 10 minutos, un caller puede ejecutar N pipelines al precio
  viejo en vez del nuevo. El delta máximo es `N × Σ(precio_vivo − precio_congelado)` y sólo cuando el
  precio subió dentro de la ventana.
- **Si algún día se exige single-use**, hay que revisar la decisión de no-storage: la forma natural es
  la tabla de nonces que ya existe para `signed-auth` (`a2a_signed_auth_nonces`, `signed-auth.ts:206-223`).

Esto está también en la respuesta pública: `doc/INTEGRATION.md` lo dice con todas las letras (W3.1).

### 4.9 Plan de tests

Framework: vitest (`npm test` = `vitest run`). **Baseline a preservar: 3996 passed | 19 skipped.**

#### Unitarios del módulo — `src/services/orchestrate-quote.test.ts` (nuevo)

| Test | Qué afirma | AC | Mata |
|---|---|---|---|
| T-Q-U1 | round-trip: `signQuote` → `verifyQuote` ok; `payload.steps` = los mismos slugs/registries/precios; `exp - iat === 600` | AC-1 | — |
| T-Q-U2 | token con el payload mutado (precio `0.05` → `0.01`, re-encodeado, misma firma) → `QUOTE_INVALID` | AC-3 | M3 |
| T-Q-U3 | token emitido en `now - 601s` → `QUOTE_EXPIRED`; en `now - 599s` → `ok` | AC-3 | M1 |
| T-Q-U4 | quote de `{kind:'key', id:'k1'}` verificado con `{kind:'key', id:'k2'}` → `QUOTE_CALLER_MISMATCH`; y `{kind:'delegation', id:'X'}` vs `{kind:'session', id:'X'}` (mismo id, distinto kind) → mismatch | AC-4 | M2 |
| T-Q-U5 | el módulo es stateless: el archivo fuente no matchea `/supabase|redis|ioredis|pg/`, y el round-trip funciona sin un solo mock | AC-7 | M13 |
| T-Q-U6 | payload con `p` = `"0.00000000"`, negativo o `"NaN"` → `QUOTE_INVALID` (firmado con la clave real, o sea: la firma verifica y aun así se rechaza) | AC-3 | M9 |
| T-Q-U7 | sin `ORCHESTRATE_QUOTE_HMAC_KEY`: `signQuote` → `null` y `verifyQuote` de un token válido previo → `QUOTE_INVALID` (fail-closed) | AC-7, CD-5 | M14 |
| T-Q-U8 | token de `QUOTE_MAX_TOKEN_CHARS + 1` chars → `QUOTE_INVALID` sin tirar | AC-3 | — |
| T-Q-U9 | token con `iat = now + 120` → `QUOTE_INVALID` | AC-3 | M15 |
| T-Q-U10 | firmas malformadas (largo distinto, no-hex, vacía, `undefined` casteado) → `QUOTE_INVALID`, **nunca throw** | CD-4 | — |
| T-Q-U11 | `resolveQuoteCaller`: delegación > sesión > key; sin ninguno → `null` | AC-4 | M16 |

#### Ruta — `src/routes/orchestrate.test.ts` (describe nuevo, +15)

| Test | Qué afirma | AC | Mata |
|---|---|---|---|
| T-Q-P1 | `/plan` ready con secreto y key ⇒ `body.quote` presente y `verifyQuote(quote, caller)` devuelve los precios de `costPerStep`; `quoteExpiresAt` = `iat+600` | AC-1 | — |
| T-Q-P2 | sin secreto ⇒ `'quote' in body === false` y `'quoteExpiresAt' in body === false`; el resto del body idéntico | AC-6, CD-2 | M11 |
| T-Q-P3 | `planStatus !== 'ready'` ⇒ sin `quote` | AC-1 | M17 |
| T-Q-P4 | `costPerStep` con un `0` ⇒ sin `quote` | AC-1 | M18 |
| T-Q-P5 | caller x402 (sin `a2aKeyRow`) ⇒ sin `quote` | AC-4 | M19 |
| T-Q-R1 | `/execute` con quote válido ⇒ `executeApprovedPlan` llamado con `plannedCostUsd` y `costPerStep` **congelados**, `frozenStepPricesUsd` = los congelados, y **sin** `maxQuotedCostUsdc` en el request | AC-2 | M7, M10 |
| T-Q-R2 | `/execute` **sin** quote ⇒ `executeApprovedPlan` llamado exactamente como hoy (precios vivos + `maxQuotedCostUsdc` presente + `frozenStepPricesUsd` ausente) | AC-6, CD-2 | M20 |
| T-Q-R3 | quote expirado ⇒ 409 `QUOTE_EXPIRED` + `requiresNewQuote:true` + `executeApprovedPlan` **no** llamado | AC-3 | M1 |
| T-Q-R4 | quote de otra key ⇒ 403 `QUOTE_CALLER_MISMATCH` + no llamado | AC-4 | M2 |
| T-Q-R5 | `body.steps[0].agent` ≠ el congelado ⇒ 400 `QUOTE_STEP_MISMATCH` + no llamado | AC-2 | M4 |
| T-Q-R6 | `body.steps` con un step de más ⇒ 400 `QUOTE_STEP_MISMATCH` + no llamado | AC-2 | M5 |
| T-Q-R7 | `resolveAgentPriceUsdc` → `null` para un agente congelado ⇒ 409 `QUOTE_AGENT_UNAVAILABLE` + no llamado | AC-5 | M6 |
| T-Q-R8 | quote válido + precio vivo **por encima** de `maxQuotedCostUsdc` ⇒ 200 y ejecución al precio congelado (nunca 409 `QUOTE_STALE`) | AC-2 | M10 |
| T-Q-R9 | `quote: "basura"` ⇒ 400 `QUOTE_INVALID` + no llamado | AC-3 | M21 |
| T-Q-R10 | quote emitido bajo delegación, presentado por la master key del mismo owner ⇒ 403 `QUOTE_CALLER_MISMATCH` (DT-3 literal) | AC-4 | M2 |
| T-Q-R11 | los 3 contextos (master / delegación / sesión) emiten y redimen su propio quote de punta a punta | AC-4, Scope IN | M16 |

#### Dinero — `src/services/orchestrate.quote-billing.test.ts` (nuevo)

Harness clonado de `orchestrate.billing.test.ts` (compose REAL, mocks de borde) **más un ledger con
estado**: `budgetService.debit` descuenta de una variable `balanceUsd` y devuelve `{success:true}`;
`getBalance` la lee. Cada test mide `balanceUsd` **antes** y **después** (CD-13).

| Test | Escenario | Aserción de saldo | AC | Mata |
|---|---|---|---|---|
| T-Q-B1 | 1 step. Congelado `0.05`; el precio vivo **sube** a `0.09` | `antes − después === 0.05` exacto | AC-2 | M7 |
| T-Q-B2 | 3 steps. Congelados `[0.05, 0.06, 0.07]`; vivos `[0.09, 0.11, 0.13]` | `antes − después === 0.18` y cada llamada a `debit` con el monto congelado de SU índice (los args capturados y afirmados uno a uno, CD-14) | AC-2 | M8 |
| T-Q-B3 | 1 step. Congelado `0.05`; el precio vivo **baja** a `0.01` (dirección opuesta) | `antes − después === 0.05` — el freeze es simétrico: se cobra lo pactado, no lo que quedó más barato | AC-2 | M7, M22 |
| T-Q-B4 | quote expirado, en los 3 contextos de débito | `antes === después` (0 débitos, `debit` nunca llamado) | AC-3 | M1 |
| T-Q-B5 | agente congelado ya no resuelve | `antes === después` | AC-5 | M6 |
| T-Q-B6 | **sin** quote, precio vivo `0.09` | `antes − después === 0.09` (regresión: el camino de hoy sigue cobrando en vivo) | AC-6 | M20 |
| T-Q-B7 | quote firmado con un precio `0` en un step | 400 `QUOTE_INVALID` y `antes === después` (jamás un débito de $0) | AC-3 | M9 |

#### Mutantes (§4.10) — todos deben COMPILAR

**Regla dura (CD-15)**: antes de mutar, copia del archivo **fuera del árbol de git** + `sha256sum` de
referencia; restaurar copiando de vuelta y verificando el hash. `git checkout --`, `git restore` y
`git stash` están PROHIBIDOS como undo (destruyeron trabajo real en HU-203).

**Regla dura (CD-18)**: un mutante que no compila (`npx tsc --noEmit` limpio con la mutación puesta)
**no cuenta**. Un error de sintaxis pone todo rojo y no prueba nada. Todos los mutantes de abajo son
cambios de condición, de literal o de origen del dato — ninguno toca la sintaxis ni los tipos.

| # | Archivo | Mutación (compila) | Test que lo mata |
|---|---|---|---|
| M1 | `orchestrate-quote.ts` | `if (nowSec >= payload.exp)` → `if (false)` | T-Q-U3, T-Q-R3, T-Q-B4 |
| M2 | `orchestrate-quote.ts` | el comparador del binding devuelve `true` fijo | T-Q-U4, T-Q-R4, T-Q-R10 |
| M3 | `orchestrate-quote.ts` | `if (!signatureOk)` → `if (false)` | T-Q-U2 |
| M4 | `routes/orchestrate.ts` | G5 (identidad por step) → `if (false)` | T-Q-R5 |
| M5 | `routes/orchestrate.ts` | G4 (largo) → `if (false)` | T-Q-R6 |
| M6 | `routes/orchestrate.ts` | G6 (`price === null`) → `if (false)` | T-Q-R7, T-Q-B5 |
| M7 | `routes/orchestrate.ts` | `plannedCostUsd` = precio **vivo** de `steps[0]` en vez del congelado | T-Q-B1, T-Q-B3, T-Q-R1 |
| M8 | `services/compose.ts` | ignorar `frozenStepPricesUsd[i]` y usar siempre `agent.priceUsdc` | T-Q-B2 |
| M9 | `orchestrate-quote.ts` | validación del precio `> 0` → `>= 0` | T-Q-U6, T-Q-B7 |
| M10 | `routes/orchestrate.ts` | pasar `maxQuotedCostUsdc` al service también con quote válido | T-Q-R8, T-Q-R1 |
| M11 | `routes/orchestrate.ts` | emitir `quote` aunque `quoteHmacKey()` sea `null` (firma con `''`) | T-Q-P2 |
| M13 | `orchestrate-quote.ts` | agregar un `import { supabase }` sin usar | T-Q-U5 |
| M14 | `orchestrate-quote.ts` | `quoteHmacKey()` con fallback a `RECEIPT_SIGNING_SECRET` | T-Q-U7 (y CD-5) |
| M15 | `orchestrate-quote.ts` | guard de `iat` futuro → `if (false)` | T-Q-U9 |
| M16 | `orchestrate-quote.ts` | invertir la precedencia de `resolveQuoteCaller` (key antes que delegación) | T-Q-U11, T-Q-R11 |
| M17 | `routes/orchestrate.ts` | emitir quote con `planStatus !== 'ready'` | T-Q-P3 |
| M18 | `routes/orchestrate.ts` | emitir quote con algún `costPerStep[i] === 0` | T-Q-P4 |
| M19 | `routes/orchestrate.ts` | emitir quote sin caller bindeable (bind fijo `'anon'`) | T-Q-P5 |
| M20 | `routes/orchestrate.ts` | tratar la ausencia de `quote` como quote inválido (400) | T-Q-R2, T-Q-B6, + los T-EXEC existentes |
| M21 | `routes/orchestrate.ts` | ante `QUOTE_INVALID`, seguir por el camino de precio vivo en vez de rechazar | T-Q-R9, T-Q-B7 |
| M22 | `services/compose.ts` | usar `Math.min(frozen, agent.priceUsdc)` en vez del congelado | T-Q-B3 |

**Mutante de control**: comentar el `i > 0` de `compose.ts:274` debe poner rojos tests
**preexistentes** (double-charge del step-0). Si no lo hace, el harness de mutación está mal armado y
ningún resultado de esta campaña vale.

### 4.10 Verificación por wave

| Wave | Verificación |
|------|--------------|
| W0 | `npx tsc --noEmit` (la suite entera, no sólo `npm run build`, que excluye tests — lección WKH-196) |
| W1 | `npx tsc --noEmit` + `npm test` sin regresión sobre el baseline |
| W2 | `npm test` = **4029+ passed | 19 skipped** (3996 + 33 nuevos), 0 failed |
| W3 | campaña de mutación (§4.9) + `npx biome check src/` + `npm test` completo |

---

## 5. Waves de implementación

### Wave 0 — Serial gate (contratos, sin cambio de comportamiento)

- **W0.1** — Crear `src/services/orchestrate-quote.ts`: constantes, tipos (`QuoteCaller`,
  `QuoteStep`, `QuotePayload`, `QuoteVerifyResult`), `quoteHmacKey`, `resolveQuoteCaller`,
  `computeQuoteBinding`, `signQuote`, `verifyQuote`.
  Exemplar: `src/services/receipt.ts:31-98` + `src/services/llm/transform-hmac.ts`.
- **W0.2** — `src/types/index.ts`: `frozenStepPricesUsd?: readonly number[] | undefined` en
  `ComposeRequest` (junto a `keySessionContext`, ~L536-545) y en `OrchestrateRequest` (~L718-730),
  con JSDoc que diga qué es y que su ausencia = comportamiento de hoy.
- **W0.3** — `.env.example`: bloque de §4.6.

**Gate W0**: `npx tsc --noEmit` limpio. Nada de W1 arranca antes.

### Wave 1 — Paralelizable (3 frentes independientes)

- **W1.1** — `/plan`: emisión (§4.4.1) + logs `issued`. Archivo: `src/routes/orchestrate.ts`
  (bloque del `reply.send`, L267-278). **Depende sólo de W0.1.**
- **W1.2** — `/execute`: campo `quote` en el JSON schema del body
  (`{type:'string', minLength:1, maxLength:8192}`), los 6 guards de §4.5, el armado del plan con
  valores congelados y el spread condicional de `maxQuotedCostUsdc` (§4.4.3) + logs
  `redeemed`/`price-delta`/`rejected`. Archivo: `src/routes/orchestrate.ts`. **Depende de W0.1+W0.2.**
- **W1.3** — Freeze de steps 1..N: `src/services/orchestrate.ts` propaga
  `request.frozenStepPricesUsd` a `composeService.compose` (objeto de L1213-1232) y
  `src/services/compose.ts` lo consume en el débito per-step (L284-296). **Depende de W0.2.**

> W1.1 y W1.2 tocan el mismo archivo en zonas distintas (`/plan` L174-292 vs `/execute` L299-478).
> Si se ejecutan en paralelo, hacerlo en el mismo worktree y en ese orden para evitar conflicto.

### Wave 2 — Tests (depende de W1 completa)

- **W2.1** — `src/services/orchestrate-quote.test.ts` (11 tests). Depende de W0.1.
- **W2.2** — `src/routes/orchestrate.test.ts` (+15, describe nuevo). Depende de W1.1+W1.2.
- **W2.3** — `src/services/orchestrate.quote-billing.test.ts` (7 tests de dinero). Depende de W1.3.

### Wave 3 — Cierre

- **W3.1** — `doc/INTEGRATION.md`: sección del quote (cómo pedirlo, cómo devolverlo, tabla de los 5
  `error_code` con su HTTP, TTL de 10 min, qué pasa al rotar la clave, y el compromiso de §4.8 escrito
  con todas las letras).
- **W3.2** — Campaña de mutación completa (22 mutantes + el de control), con evidencia
  `sha256sum` de restauración por mutante.
- **W3.3** — `npx tsc --noEmit` + `npx biome check src/` + `npm test` completo contra el baseline.

---

## 6. Scope

**IN**

- `src/services/orchestrate-quote.ts` (nuevo, leaf).
- `src/routes/orchestrate.ts` — emisión en `/plan` y redención + guards en `/execute`.
- `src/services/orchestrate.ts` — **una línea**: propagar `frozenStepPricesUsd` a compose.
- `src/services/compose.ts` — **el débito per-step** (L274-296) honra el precio congelado cuando llega.
- `src/types/index.ts` — dos campos opcionales aditivos.
- `.env.example` — `ORCHESTRATE_QUOTE_HMAC_KEY`.
- Tests: 1 archivo unitario nuevo, 1 archivo de dinero nuevo, +15 tests en el de ruta.
- `doc/INTEGRATION.md` — documentación pública del quote.

> **Delta de scope declarado**: el work-item listaba sólo `orchestrate.ts` + módulo nuevo + env +
> contrato de error. `compose.ts` y `services/orchestrate.ts` entran porque **AC-2 dice "cada step"** y
> los steps 1..N se debitan dentro de compose (`compose.ts:310-318`), no en el route. Sin ese
> plumbing, el freeze cubriría sólo el step-0 y AC-2 quedaría incumplido. El cambio es aditivo y
> default-off: sin `frozenStepPricesUsd`, `compose.ts` corre el mismo código de hoy.

**OUT**

- `POST /compose` y `POST /orchestrate` (atómicos): cotizan y debitan en la misma request, no tienen
  la ventana que esta HU cierra. **Ni una línea de `src/routes/compose.ts`.**
- Tabla Postgres o Redis para el quote (CD-1).
- Single-use / anti-replay del quote dentro de su ventana (§4.8, compromiso aceptado).
- Congelar el **input** de los steps: el quote congela identidad y precio; el `input` lo sigue
  mandando el cliente. Congelarlo impediría el retoque legítimo del payload entre plan y execute y no
  lo pide ningún AC.
- Congelar el gas overhead per-step (`getStepGasOverheadUsd`): es pass-through del gateway, hoy 0 en
  testnet, y no es un precio de agente.
- Cambiar la base del protocol fee: sigue siendo `pipeline.totalCostUsdc` (el costo **ejecutado**).
- El rol de `maxQuotedCostUsdc` como techo en el camino **sin** quote (AC-6).
- Chaski / frontend: mandar y reenviar el campo `quote` es una HU aparte. Mientras tanto Chaski sigue
  funcionando exactamente igual (AC-6).
- Refactorizar las tres copias de `hex-regex + timingSafeEqual` a un helper común.

---

## 7. Riesgos

| # | Riesgo | Prob. | Impacto | Mitigación |
|---|--------|-------|---------|------------|
| **R1** | **El gateway absorbe las subas de precio dentro de la ventana**: se le debita al caller el precio congelado y se le settlea al agente el precio vivo. Si subió, la diferencia la pone el gateway. | M | M | Es la consecuencia directa e inevitable de "congelar el precio" (un quote que se repudia cuando sube no es un quote). Está **acotada**: ventana de 10 min, sólo sobre los pipelines efectivamente redimidos, delta = `Σ(vivo − congelado)`. Se **mide** con el log `[orchestrate.quote.price-delta]` (§4.7). Si la exposición medida molesta, la palanca futura es un umbral env-gated de rechazo — **no se implementa acá y no se inventa el número**. Ver §11. |
| **R2** | Redención múltiple dentro de la ventana (§4.8) | A | B | Aceptado y documentado por el founder; sin doble cobro (cada uso ejecuta y debita aparte); todos los caps siguen operando. Documentado en el SDD, en el código y en `doc/INTEGRATION.md`. |
| **R3** | Conflicto de merge en `orchestrate.ts` con las HUs 159/160/161/162/163/189 (bloque de relevancia del planner) | M | B | Zonas disjuntas (planner vs `/plan`+`/execute`). Coordinar el orden de merge con la que esté más avanzada, como ya recomendó la fila 163 del `_INDEX.md`. |
| **R4** | Regresión silenciosa en el camino **sin** quote (el 100% del tráfico actual, incluido Chaski) | B | A | CD-2 + T-Q-R2/T-Q-B6 + los T-EXEC preexistentes + el mutante M20. La rama nueva entera está detrás de `if (body.quote !== undefined)`. |
| **R5** | Deriva de reloj entre instancias alarga la ventana de 10 min | B | B | `exp` va firmado (no recalculado al verificar) + guard de `iat` futuro con 60 s de tolerancia (M15/T-Q-U9). |
| **R6** | La clave HMAC no se configura en prod ⇒ el freeze no protege nada y nadie se entera | M | M | Fail-closed en la redención (§4.3.6 paso 2) + log `issued` ausente es señal observable + `doc/INTEGRATION.md` lo declara como requisito de activación. El deploy de la env es acción del founder, igual que `RECEIPT_SIGNING_SECRET`. |
| **R7** | El token expone información del plan (slugs y precios son legibles en base64url) | B | B | Los slugs y precios **ya los tiene el cliente**: se los devolvió `/plan` en claro. Lo único sensible (id de key/delegación/sesión) va como HMAC, nunca crudo (§4.3.4). |
| **R8** | G6 agrega latencia a `/execute` | B | B | Cero neto: reemplaza uno a uno los `resolveAgentPriceUsdc(forceRefresh=true)` que hacía el cap gate, que con quote válido ya no corre (§4.4.3). |
| **R9** | **WKH-305 está editando `src/services/compose.ts` AHORA MISMO, sin commitear, en este mismo worktree** — y toca el mismo bloque per-step que W1.3 | A | M | Verificado con `git diff` durante F2: WKH-305 mueve la construcción de `input` desde la L339 a antes del bloque de gas/débito (+22 líneas), así que **el bloque de débito per-step que este SDD cita como L274-296 hoy está en ~L296-318**. Acciones obligatorias para el Dev: (a) antes de W1.3, releer el bloque y ubicarlo por su comentario ancla `CD-11: guard \`i > 0\``, **nunca por número de línea**; (b) no revertir ni "limpiar" el cambio de WKH-305 (CD-23); (c) si W1.3 arranca con ese diff todavía sin commitear, avisar al orquestador — dos HUs escribiendo el mismo archivo sin commit intermedio es exactamente el escenario que destruyó trabajo en HU-203. |

---

## 8. Dependencias

- Ninguna HU bloqueante. No depende de WKH-191 (escrow) ni de las HUs de relevancia del planner.
- No requiere migraciones, ni deploy previo, ni dependencias npm nuevas.
- Para que el freeze **opere en producción** hace falta setear `ORCHESTRATE_QUOTE_HMAC_KEY` en
  Railway (acción del founder, post-merge). Sin ella el código queda inerte y el comportamiento es el
  de hoy.

## 9. Missing Inputs

- Ninguno bloqueante. Los tres del work-item quedan resueltos:
  1. Redención múltiple → §4.8, compromiso aceptado y documentado a la vista (no bloqueaba).
  2. Formato y transporte del token → §4.3.2 (formato propio `v1.<b64>.<hmac>`) y campo `quote` en el
     body de `/execute`.
  3. Binding al caller → §4.3.4 (HMAC de `kind:id` con precedencia delegación > sesión > key).

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante |
|--------|---------|-------------|------------|
| — | — | **Ninguno.** No quedan `[NEEDS CLARIFICATION]` ni `[TBD]`. | No |

## 11. Nota al founder (no bloqueante, para que no lo descubras después)

Dos consecuencias de tus decisiones que quedan escritas acá para que no aparezcan como sorpresa:

1. **Freeze exacto, no `min(congelado, vivo)`.** Se cobra lo cotizado en las dos direcciones: si el
   precio bajó dentro de la ventana, el caller igual paga lo pactado (T-Q-B3). Es la lectura literal
   de "se congela el precio" y de "nunca cobro silencioso al precio nuevo" — cobrar el precio nuevo
   más barato también sería cobrar un precio que el caller no aprobó. La alternativa `min()` sería
   más amable con el caller y le sacaría al gateway la ganancia de las bajas, pero le dejaría intacta
   la pérdida de las subas. Si preferís `min()`, es **una condición en W1.3 y un test** (T-Q-B3
   invertido); decilo en el gate y lo cambio antes de que el Dev arranque.
2. **Las subas dentro de la ventana las paga el gateway** (R1). Es inherente a cualquier garantía de
   precio. Queda acotada a 10 minutos y medida con `[orchestrate.quote.price-delta]`, así que en dos
   semanas de producción vas a tener el número real en vez de una intuición.

---

## 12. Constraint Directives (Anti-Alucinación)

### Heredados del work-item (íntegros)

- **CD-1**: **PROHIBIDO** agregar tabla Postgres nueva o usar Redis para persistir el quote — token
  stateless autocontenido, verificable sólo con un secreto del servidor.
- **CD-2**: **OBLIGATORIO** que la ausencia del campo `quote` en `/orchestrate/execute` preserve el
  comportamiento actual byte a byte (AC-6). Ningún cliente existente puede romperse.
- **CD-3**: **PROHIBIDO** debitar cualquier monto cuando el quote expiró, la firma es inválida, el
  caller no coincide o el agente congelado ya no existe. Único resultado permitido: 0 débito + error
  explícito y distinguible.
- **CD-4**: **OBLIGATORIO** verificar el HMAC con `crypto.timingSafeEqual`, replicando el patrón de
  `src/services/llm/transform-hmac.ts:69-83` y `src/services/signed-auth.ts:178-193`.
- **CD-5**: **PROHIBIDO** reusar el secreto de otro subsistema (`REQUEST_EIP712_*`, `SIGNED_AUTH_*`,
  `RECEIPT_SIGNING_SECRET`, `SCHEMA_TRANSFORM_HMAC_KEY`) para firmar el quote, y **PROHIBIDO** todo
  fallback o hardcode. Env dedicada: `ORCHESTRATE_QUOTE_HMAC_KEY`.
- **CD-6**: **OBLIGATORIO** re-verificar existencia y estado activo del agente congelado contra
  discovery al redimir, antes de facturar. El quote nunca reemplaza ese chequeo.

### Nuevos de este SDD

- **CD-7**: **OBLIGATORIO** que los 6 guards de §4.5 corran **antes** de la primera llamada a
  `orchestrateService.executeApprovedPlan` (`routes/orchestrate.ts:425`). Es la garantía estructural
  de CD-3. **PROHIBIDO** mover cualquier guard después de esa llamada o dentro del service.
- **CD-8**: **OBLIGATORIO** verificar el HMAC **sobre el string crudo del token** y decodificar/
  parsear el payload **sólo después** de que la firma verificó. **PROHIBIDO** leer un campo del
  payload (`exp`, `bind`, `steps`) antes de eso.
- **CD-9**: **PROHIBIDO** tocar el guard `i > 0` de `src/services/compose.ts:274` (única defensa
  anti double-charge del step-0), el `totalCost += agent.priceUsdc` de L888 (base del protocol fee) y
  el settle downstream. El freeze cambia **sólo** el `debitAmount` del caller.
- **CD-10**: **PROHIBIDO** loguear el token, el payload completo o el secreto. Los logs de §4.7 son
  la lista cerrada de lo que se emite.
- **CD-11**: **PROHIBIDO** usar el `oid` del quote como clave de billing, de fee o de idempotencia.
  El `orchestrationId` de ejecución se sigue generando server-side (`routes/orchestrate.ts:357`);
  reusar el del cliente reabre el revenue leak que arregló BLQ-MED-1 de WKH-131.
- **CD-12**: **OBLIGATORIO** que `resolveQuoteCaller` y `computeQuoteBinding` sean la única expresión
  del binding, compartida por emisión y redención, y que el precio congelado se lea de un solo lugar
  (`payload.steps[i]`). **PROHIBIDO** recalcular el binding o el precio con una segunda expresión
  (HU-208: dos expresiones para la misma cantidad de dinero = bug de dinero).
- **CD-13**: **OBLIGATORIO** que todo test de rechazo afirme **saldo antes === saldo después** (no
  sólo el status code) y que todo test de éxito afirme `saldoAntes − saldoDespués === precio
  congelado`.
- **CD-14**: **OBLIGATORIO** que los dobles de `budgetService.debit` y `resolveAgentPriceUsdc`
  capturen y afirmen sus argumentos y se tipen con el retorno real (HU-202: un doble que descarta
  argumentos hace vacuo el test; es la 3ª reincidencia del repo).
- **CD-15**: **PROHIBIDO** usar `git checkout --`, `git restore` o `git stash` para revertir una
  mutación. Copia fuera del árbol de git + `sha256sum` de referencia; la evidencia de reversión es el
  hash, no el `git status` (HU-203/HU-202).
- **CD-16**: **OBLIGATORIO** restaurar `process.env.ORCHESTRATE_QUOTE_HMAC_KEY` en `afterEach`,
  nunca en la última línea del cuerpo del test (HU-202: un fallo temprano contamina el resto del
  archivo).
- **CD-17**: **PROHIBIDO** que un test re-implemente el HMAC para compararlo contra sí mismo. Los
  tests de firma parten de un token producido por `signQuote` y lo mutan, o usan otra clave
  (HU-202: una aserción que re-escribe la lógica que dice verificar es decoración).
- **CD-18**: **OBLIGATORIO** que cada mutante compile (`npx tsc --noEmit` limpio con la mutación
  puesta) antes de contarlo. Un mutante que rompe la sintaxis no prueba nada.
- **CD-19**: **PROHIBIDO** modificar `src/routes/compose.ts`, `src/middleware/*`, crear migraciones,
  agregar dependencias npm, o tocar la lista congelada de `src/routes/charged-routes.meta.test.ts`.
- **CD-20**: **OBLIGATORIO** construir los campos opcionales con spread condicional
  (`...(x !== undefined && { x })`) — `exactOptionalPropertyTypes` está activo en `tsconfig.json:11`.
- **CD-21**: **OBLIGATORIO** correr `npx tsc --noEmit` completo (no sólo `npm run build`, que excluye
  los tests) antes de dar por cerrada cualquier wave (lección WKH-196).
- **CD-23**: **PROHIBIDO** revertir, reordenar o "limpiar" el cambio sin commitear de **WKH-305** en
  `src/services/compose.ts` (mueve la construcción de `input` antes del bloque de débito). W1.3 se
  aplica **encima** de ese estado, ubicando el bloque por su comentario ancla
  `CD-11: guard \`i > 0\``, nunca por número de línea (ver R9).
- **CD-22**: **PROHIBIDO** tocar `doc/sdd/_INDEX.md`, `contracts/.gas-snapshot`,
  `doc/audit/2026-06-28-best-practices-audit.md`, los `doc/jury-qa*.md` y
  `doc/sdd/118-wkh-sec-02b-owner-ref-rpc/`.

---

## 13. Readiness Check

```
READINESS CHECK — WKH-303
[x] Cada AC tiene al menos 1 archivo asociado en la tabla 4.1
      AC-1 → #1,#4,#8,#9 | AC-2 → #1,#5,#6,#7,#9,#10 | AC-3 → #1,#5,#8,#9,#10
      AC-4 → #1,#5,#8,#9 | AC-5 → #5,#9,#10 | AC-6 → #4,#5,#7,#9,#10 | AC-7 → #1,#3,#8
[x] Cada archivo de la tabla 4.1 tiene Exemplar verificado en disco (11/11)
      orchestrate-quote.ts → receipt.ts + transform-hmac.ts (ambos EXISTEN, leídos)
      quote-billing.test.ts → orchestrate.billing.test.ts (EXISTE, leído)
      resto → zonas concretas de archivos leídos, con línea citada
[x] Los 2 archivos nuevos NO existen hoy (verificado); los 9 restantes SÍ existen (verificado)
[x] No hay [NEEDS CLARIFICATION] ni [TBD] pendientes (§10)
[x] Constraint Directives: 22 (6 heredados + 16 nuevos), con 13 PROHIBIDO explícitos
[x] Context Map: 17 archivos leídos, con línea y patrón extraído
[x] Scope IN y OUT explícitos, con el delta de scope (compose.ts) declarado y justificado
[x] BD: N/A verificado — cero tablas, cero migraciones (AC-7/CD-1)
[x] Happy Path completo: emisión (§4.4.1) + redención (§4.4.2) + por qué no corre el cap gate (§4.4.3)
[x] Flujo de error definido: 6 guards, 5 error_code nuevos, HTTP y cuerpo exacto (§4.5)
[x] Waves con W0 serial de contratos y W1 paralelizable en 3 frentes (§5)
[x] Al menos 1 test por AC: 33 tests nuevos (11 unit + 15 ruta + 7 dinero)
[x] Tests de dinero miden saldo antes/después en las dos direcciones (T-Q-B1 sube, T-Q-B3 baja)
     y saldo idéntico en los rechazos (T-Q-B4, T-Q-B5, T-Q-B7)
[x] Mutantes especificados: 22 + 1 de control, cada uno con su test asesino, todos compilables (CD-18)
[x] Auto-blindaje histórico de las 3 últimas HUs DONE incorporado a los CD (§3.1)
[x] Baseline de tests declarado: 3996 passed | 19 skipped → objetivo 4029+ | 19
[x] Ningún archivo protegido en Scope IN (CD-22)
```

**Veredicto: LISTO PARA `SPEC_APPROVED`.**

---

*SDD generado por NexusAgil — FULL — Architect (F2)*
