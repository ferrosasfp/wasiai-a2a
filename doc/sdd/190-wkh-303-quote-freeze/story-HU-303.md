# Story File — #190 (WKH-303): Congelar la cotización 10 minutos con quote firmado

> SDD: `doc/sdd/190-wkh-303-quote-freeze/sdd.md` (SPEC_APPROVED)
> Work item: `doc/sdd/190-wkh-303-quote-freeze/work-item.md`
> Fecha: 2026-07-28
> Branch: `feat/190-wkh-303-quote-freeze`
> Baseline de tests a preservar: **3996 passed | 19 skipped** → objetivo **4029+ passed | 19 skipped**

**Este documento es el único que el Dev necesita leer.** Si algo no está acá, el Dev PARA y escala al
orquestador. No inventar, no asumir, no improvisar.

---

## 0. ALERTA DE COLISIÓN: WKH-305 está escribiendo `src/services/compose.ts` AHORA MISMO

**Esto no es una nota al pie. Es lo primero que tenés que leer y lo primero que tenés que verificar
antes de tocar `compose.ts` (Wave W1.3).**

### Qué pasa

Al momento de escribir este Story File, en **este mismo worktree**, `git status --porcelain` devuelve:

```
 M src/services/compose.ts
?? src/services/compose.field-mapping.test.ts
```

Sin commitear. Es trabajo de **WKH-305** (field mapping de compose,
`doc/sdd/190-wkh-305-compose-field-mapping/`). WKH-305 mueve la construcción de `input` a **antes** del
bloque de gas/débito per-step, que es exactamente el bloque que W1.3 de esta HU tiene que modificar.

**Y se está moviendo mientras leés esto**: durante los ~8 minutos que tomó escribir este documento, el
estado pasó de `M compose.ts + M compose.test.ts` a `M compose.ts + ?? compose.field-mapping.test.ts`
(los tests se movieron a un archivo propio). O sea: no es un diff dormido, es una HU **en vuelo**. Por
eso el chequeo de §0 se corre **en el momento** de arrancar W1.3, no ahora, y el bloque se relee con
`Read` justo antes de editarlo.

### Consecuencia directa: los números de línea del SDD están viejos

| Referencia | En el SDD | En el archivo real hoy |
|---|---|---|
| Comentario ancla `CD-11: guard \`i > 0\`` | ~L272 | **L272** |
| `if (i > 0 && scopingKeyRow && chainId !== undefined) {` | "L274" | **L296** |
| Bloque de `debitAmount` | "L284-296" | **~L306-318** |

**PROHIBIDO ubicar el punto de inserción por número de línea.** Se ubica **por contenido**, con estas
anclas literales (verificadas en disco el 2026-07-28):

```ts
// CD-11: guard `i > 0` es la ÚNICA defensa contra double-debit del
// step 0 (que ya fue debitado por el middleware via
// request.composeEstimatedCostUsd). NO REMOVER. AR/CR debe verificar
// que esta línea sobrevive en futuras HUs.
```

```ts
if (i > 0 && scopingKeyRow && chainId !== undefined) {
```

```ts
const debitAmount =
  (isInvalid ? PLACEHOLDER_FEE_USD : agent.priceUsdc) + stepGasOverhead;
```

### Protocolo obligatorio al arrancar W1.3 (y solo entonces)

1. Correr, como primer paso de la wave:
   ```bash
   git status --porcelain src/services/compose.ts src/services/compose.test.ts
   ```
2. **Si sigue apareciendo ` M` (sin commitear): PARÁ y avisá al orquestador antes de escribir una sola
   línea en ese archivo.** Texto exacto a reportar: *"W1.3 bloqueada: el diff de WKH-305 en
   `src/services/compose.ts` sigue sin commitear. Dos HUs escribiendo el mismo archivo sin commit
   intermedio es el escenario que destruyó trabajo en HU-203. ¿Commiteo WKH-305 primero, o sigo
   encima?"* Esperá respuesta. No decidas vos.
3. Si el orquestador te habilita a seguir encima: aplicás W1.3 **sobre** ese estado, sin tocar nada
   de WKH-305.
4. Releé el bloque completo con `Read` **inmediatamente antes** de editarlo. El archivo puede haber
   cambiado entre el paso 1 y el paso 4.

### Prohibiciones de esta sección (no negociables)

- **PROHIBIDO** `git checkout --`, `git restore`, `git stash`, `git clean`, `git reset --hard` sobre
  `src/services/compose.ts`, `src/services/compose.test.ts` o cualquier otro archivo. En ninguna wave,
  por ningún motivo, tampoco para "revertir una prueba rápida" (CD-15).
- **PROHIBIDO** revertir, reordenar, "limpiar", reformatear o mejorar el cambio de WKH-305 (CD-23).
  Si el diff de WKH-305 te parece mal, lo reportás, no lo tocás.
- **PROHIBIDO** commitear el trabajo de WKH-305 dentro de un commit tuyo. Si commiteás, `git add` por
  path explícito de **tus** archivos, nunca `git add -A` ni `git add .`.
- La misma regla aplica a `src/routes/orchestrate.ts` y `src/services/orchestrate.ts`: si al empezar
  W1.1/W1.2/W1.3 aparecen como ` M` por otra HU (159/160/161/162/163/189 tocan el bloque de
  relevancia del planner), avisás antes de escribir.

---

## 1. Goal

Entre `POST /orchestrate/plan` (cotiza) y `POST /orchestrate/execute` (ejecuta y debita) hay una
ventana en la que el precio de un agente puede cambiar. Hoy `/execute` re-resuelve el precio en vivo y
solo lo frena un techo declarado por el cliente (`maxQuotedCostUsdc`): si el precio cambió pero quedó
debajo del techo, **se debita el precio nuevo sin que nadie lo haya aprobado**.

Esta HU agrega un **quote firmado, stateless, con TTL de 10 minutos**: `/plan` lo emite, el cliente lo
devuelve en `/execute`, y el gateway debita **el precio y la identidad congelados**, nunca los
re-resueltos en vivo. Sin storage nuevo: ni tabla Postgres, ni Redis, ni estado en memoria. El token es
autocontenido y se verifica con un secreto del servidor (HMAC-SHA256 + `timingSafeEqual`).

Sin el campo `quote`, el comportamiento de hoy queda **byte a byte intacto**.

---

## 2. Acceptance Criteria (EARS) — copiados del SDD aprobado

- **AC-1**: WHEN `POST /orchestrate/plan` responde con `planStatus:'ready'`, the system SHALL incluir
  un quote firmado (token opaco, HMAC-SHA256) que congela, por cada step, la identidad resuelta del
  agente (`registry` + `slug`) y su `priceUsdc` cotizado, válido por exactamente 10 minutos desde su
  emisión.
- **AC-2**: WHEN `POST /orchestrate/execute` recibe un quote válido, no expirado y atado al caller que
  lo presenta, the system SHALL debitar y ejecutar cada step congelado usando el precio Y la identidad
  de agente del quote, NUNCA el precio ni la identidad re-resueltos en vivo.
- **AC-3**: IF el quote expiró o su firma no verifica, THEN the system SHALL rechazar con un código
  explícito y distinguible, SHALL NOT debitar monto alguno, y SHALL indicar que se requiere una nueva
  cotización.
- **AC-4**: IF el quote fue emitido para una credencial distinta de la que lo presenta, THEN the system
  SHALL rechazar sin debitar, con un código distinguible del de expiración.
- **AC-5**: IF un agente congelado ya no existe o está desactivado al momento de `/execute`, THEN the
  system SHALL rechazar esa redención con un error explícito y SHALL NOT cobrar ni el precio congelado
  ni un precio en vivo por ese agente.
- **AC-6**: WHERE el caller NO incluye quote, the system SHALL preservar el comportamiento actual sin
  cambios (re-resolución en vivo contra `maxQuotedCostUsdc`, `409 QUOTE_STALE` si lo supera).
- **AC-7**: the system SHALL implementar el congelamiento sin storage durable nuevo: el quote SHALL ser
  autocontenido y verificable solo con un secreto del servidor.

---

## 3. Las cuatro reglas del freeze que no se pueden malinterpretar

### 3.1 El quote congela precio **E** identidad

El payload firmado lleva, por cada step: `a` (slug del agente), `r` (registry, `string | null`) y `p`
(precio como string `toFixed(8)`). No es solo un precio: es **el precio de ese agente exacto**.
Congelar solo el precio dejaría abierto el ataque "ejecutar otro agente al precio del primero".

### 3.2 El mismatch de identidad se **RECHAZA**, no se corrige

Si `body.steps[i].agent` o `body.steps[i].registry` no coinciden con lo congelado, la respuesta es
**400 `QUOTE_STEP_MISMATCH`** y cero ejecución.

**PROHIBIDO** "corregir" el request sobreescribiendo `body.steps[i]` con la identidad del quote y
seguir adelante. Dos razones, las dos load-bearing:

1. Dejaría al cliente ejecutando un agente distinto del que pidió, con un `input` pensado para otro
   agente.
2. **Corregir en silencio vuelve el guard inmune a la mutación**: si el código "arregla" el mismatch
   en vez de rechazarlo, borrar el guard no cambia ningún resultado observable y ningún test puede
   ponerlo rojo. El mutante M4 existe precisamente para probar que el guard es observable. Un guard que
   no se puede matar no es un guard, es decoración.

### 3.3 Los rechazos NO debitan: se afirma **saldo idéntico**, no el status code

Todo camino de rechazo (`QUOTE_INVALID`, `QUOTE_EXPIRED`, `QUOTE_CALLER_MISMATCH`,
`QUOTE_STEP_MISMATCH`, `QUOTE_AGENT_UNAVAILABLE`) debe terminar en **0 débito**.

Los tests **no alcanzan con afirmar el status code**. Cada test de rechazo afirma, como mínimo:

- `saldoAntes === saldoDespués` (igualdad exacta sobre el ledger con estado del harness), **y**
- `budgetService.debit` **nunca fue llamado** (`expect(debitSpy).not.toHaveBeenCalled()`), **y**
- en los tests de ruta, `orchestrateService.executeApprovedPlan` **nunca fue llamado**.

Un test que solo mira `res.statusCode === 409` pasa igual si el código debitó antes de responder. Eso
ya pasó tres veces en este repo (ver CD-13).

### 3.4 El freeze aplica al monto que se le debita **al caller**, y es exacto en las dos direcciones

- Si el precio vivo **subió**: se cobra el congelado (el gateway absorbe la diferencia). Es la
  consecuencia inevitable de dar una garantía de precio.
- Si el precio vivo **bajó**: se cobra igual el congelado. **PROHIBIDO** implementar
  `Math.min(congelado, vivo)` (mutante M22). Cobrar el precio nuevo, aunque sea más barato, sigue
  siendo cobrar un precio que el caller no aprobó.
- El settle downstream al agente sigue siendo su precio vivo. No se toca.

---

## 4. Compromiso aceptado y a la vista: **un quote se puede redimir más de una vez dentro de sus 10 minutos**

Esto es una decisión de diseño del founder, no un descuido. Va escrito acá, va escrito en el código, y
va escrito en `doc/INTEGRATION.md` (W3.1). **Nadie lo puede descubrir después.**

- **No hay tracking de "ya usado"** porque eso exigiría storage durable, que está explícitamente
  descartado (AC-7 / CD-1).
- **No es doble cobro**: cada redención ejecuta el pipeline de verdad y debita su propio importe. Dos
  redenciones = dos ejecuciones = dos débitos. Lo que se repite es la garantía de precio, honrada dos
  veces, no el cargo por un mismo trabajo.
- **No es un bypass de límites**: cada redención pasa por `budgetService.debit` con el budget, el daily
  limit, el cap por destino y los caps de delegación/sesión intactos.
- **Límite del daño**: durante ≤ 10 minutos, un caller puede ejecutar N pipelines al precio viejo en vez
  del nuevo. Delta máximo `N × Σ(precio_vivo − precio_congelado)`, y solo cuando el precio subió.
- **Si algún día se exige single-use**, hay que revisar la decisión de no-storage (la forma natural es la
  tabla de nonces que ya existe para `signed-auth`, `a2a_signed_auth_nonces`).

**PROHIBIDO** implementar un anti-replay en memoria del proceso "para mitigar un poco". Sería estado no
durable, inconsistente entre instancias, invisible en el contrato, y rompería AC-7.

---

## 5. Contrato de integración (cliente ↔ gateway)

### 5.1 `POST /orchestrate/plan` → respuesta (dos campos **aditivos**)

```jsonc
{
  "orchestrationId": "…",
  "planStatus": "ready",
  "steps": [ /* … */ ],
  "costPerStep": [0.05, 0.06],
  "totalCostUsdc": 0.11,
  "protocolFeeUsdc": 0.0011,
  "feeRatePercent": 1,
  "maxQuotedCostUsdc": 0.1211,
  "reasoning": "…",
  "consideredAgents": [ /* … */ ],

  "quote": "v1.eyJiaW5kIjoi….a3f…",           // NUEVO — token opaco, string
  "quoteExpiresAt": "2026-07-28T14:31:07.000Z" // NUEVO — informativo; el exp real va firmado adentro
}
```

El quote se emite **solo si se cumplen las cinco** condiciones (§8, W1.1). Si falla cualquiera, ambos
campos quedan `undefined` y `JSON.stringify` los omite: respuesta byte-idéntica a la de hoy.

### 5.2 `POST /orchestrate/execute` → request

Campo nuevo **opcional** en el body:

```jsonc
{
  "orchestrationId": "…",
  "steps": [ /* … */ ],
  "maxQuotedCostUsdc": 0.1211,
  "budget": 1.0,
  "quote": "v1.eyJiaW5kIjoi….a3f…"   // NUEVO — opcional. Ausente = comportamiento de hoy.
}
```

Schema JSON del campo: `quote: { type: 'string', minLength: 1, maxLength: 8192 }`. **No** se agrega a
`required`.

### 5.3 Errores nuevos (cuerpo idéntico en los cinco)

```json
{ "error_code": "QUOTE_EXPIRED", "requiresNewQuote": true }
```

| HTTP | `error_code` | Cuándo | AC |
|---|---|---|---|
| 400 | `QUOTE_INVALID` | forma del token, firma que no verifica, secreto ausente en el servidor, payload inválido, precio ≤ 0, `iat` en el futuro | AC-3 |
| 409 | `QUOTE_EXPIRED` | pasaron más de 10 minutos desde `iat` | AC-3 |
| 403 | `QUOTE_CALLER_MISMATCH` | el quote fue emitido para otra credencial, o el caller no es bindeable (x402) y presenta un quote | AC-4 |
| 400 | `QUOTE_STEP_MISMATCH` | cantidad de steps distinta, o identidad (`agent`/`registry`) distinta en algún índice | AC-2 |
| 409 | `QUOTE_AGENT_UNAVAILABLE` | un agente congelado ya no resuelve en ningún registry habilitado | AC-5 |

El `409 QUOTE_STALE` existente **no cambia** y sigue siendo el único error del camino sin quote.

---

## 6. Files to Create/Modify

**Estos 11 archivos y ninguno más.** Todas las ubicaciones se dan por **ancla de contenido**, nunca por
número de línea: los números que aparecen abajo son orientativos y ya sabemos que algunos están
desactualizados (§0).

| # | Archivo | Acción | Qué hacer | Ancla de contenido | Wave |
|---|---------|--------|-----------|--------------------|------|
| 1 | `src/services/orchestrate-quote.ts` | **Crear** | Módulo leaf: constantes, tipos, `quoteHmacKey`, `resolveQuoteCaller`, `computeQuoteBinding`, `signQuote`, `verifyQuote`. Cero imports de DB/Redis/Fastify. | archivo nuevo (verificado: no existe) | W0.1 |
| 2 | `src/types/index.ts` | Modificar | Agregar `frozenStepPricesUsd?: readonly number[] \| undefined` con JSDoc a **dos** interfaces. | En `export interface ComposeRequest {`: **después** de la prop `keySessionContext?: KeySessionDebitContext \| undefined;` que cierra esa interface. En `export interface OrchestrateRequest {`: **después** de `chainId?: number \| undefined;`. | W0.2 |
| 3 | `.env.example` | Modificar | Bloque nuevo `ORCHESTRATE_QUOTE_HMAC_KEY` (texto exacto en §7.5). | Insertar **después** del bloque que termina en la línea `RECEIPT_SIGNING_SECRET=` | W0.3 |
| 4 | `src/routes/orchestrate.ts` (`/plan`) | Modificar | Emitir `quote` + `quoteExpiresAt` + log `[orchestrate.quote.issued]`. | Calcular justo **después** de `const protocolFeeUsdc =` … y agregar los 2 campos dentro del objeto que sigue al comentario `// Solo los campos PÚBLICOS del OrchestratePlanResult (pick).` | W1.1 |
| 5 | `src/routes/orchestrate.ts` (`/execute`) | Modificar | Campo `quote` en el schema; los 6 guards; armado del plan con valores congelados; spread condicional de `maxQuotedCostUsdc`; logs `redeemed`/`price-delta`/`rejected`. | Schema: objeto que contiene `required: ['orchestrationId', 'steps', 'maxQuotedCostUsdc', 'budget'],`. Guards y congelado: bloque que empieza en el comentario `// Re-derivación del plan server-side (CD-2/CD-NEW-6): los precios del`, y **todo antes** de `const result = await orchestrateService.executeApprovedPlan(` | W1.2 |
| 6 | `src/services/orchestrate.ts` | Modificar | **Una línea aditiva**: propagar `frozenStepPricesUsd` a compose. | Dentro del objeto que abre en `const pipeline = await composeService.compose({`, junto a `chainId: request.chainId,` | W1.3 |
| 7 | `src/services/compose.ts` | Modificar | Consumir el precio congelado en el `debitAmount` per-step. | Ver §0: anclas `if (i > 0 && scopingKeyRow && chainId !== undefined) {` y `const debitAmount =` / `(isInvalid ? PLACEHOLDER_FEE_USD : agent.priceUsdc) + stepGasOverhead;` | W1.3 |
| 8 | `src/services/orchestrate-quote.test.ts` | **Crear** | 11 tests unitarios (§9.1). | archivo nuevo (verificado: no existe) | W2.1 |
| 9 | `src/routes/orchestrate.test.ts` | Modificar | +15 tests en un `describe` **nuevo**, al final del archivo. No tocar los describes existentes. | archivo existente | W2.2 |
| 10 | `src/services/orchestrate.quote-billing.test.ts` | **Crear** | 7 tests de dinero con saldo antes/después (§9.3). | archivo nuevo (verificado: no existe) | W2.3 |
| 11 | `doc/INTEGRATION.md` | Modificar | Sección del quote: cómo pedirlo, cómo devolverlo, tabla de los 5 `error_code`, TTL 10 min, qué pasa al rotar la clave, y el compromiso de §4 con todas las letras. | Después del bloque que documenta `protocolFeeUsdc` / `feeRatePercent` / `maxQuotedCostUsdc` | W3.1 |

**Ningún otro archivo.** En particular: nada de `src/routes/compose.ts`, nada de `src/middleware/`,
cero migraciones, cero dependencias npm nuevas.

---

## 7. Especificación de cada pieza

### 7.1 `src/services/orchestrate-quote.ts` (W0.1)

#### Constantes

| Constante | Valor | Por qué |
|---|---|---|
| `QUOTE_VERSION` | `'v1'` | prefijo del token; permite rotar el formato |
| `QUOTE_TTL_SECONDS` | `600` | los 10 minutos. **Sin env override**: una env que alargue la ventana es una palanca silenciosa sobre el money-path |
| `QUOTE_CLOCK_SKEW_SECONDS` | `60` | tolerancia de `iat` en el futuro (deriva de reloj entre instancias) |
| `QUOTE_MAX_TOKEN_CHARS` | `8192` | techo de tamaño antes de decodificar nada |
| `QUOTE_ENV_VAR` | `'ORCHESTRATE_QUOTE_HMAC_KEY'` | nombre del secreto, en un solo lugar |

#### Formato del token

```
<QUOTE_VERSION>.<base64url(payloadJSON)>.<hmacHex64>
```

- **No es JWT.** Cero dependencias nuevas.
- La firma se computa sobre el string crudo `"<version>.<b64payload>"`, **no** sobre el objeto parseado.
- `payloadJSON` = `JSON.stringify` de un objeto con las keys en **orden alfabético explícito** (patrón
  `buildCanonicalPayload` de `receipt.ts`).

#### Payload

| Key | Tipo | Contenido |
|---|---|---|
| `bind` | `string` (hex 64) | HMAC del caller |
| `exp` | `number` (epoch s) | `iat + QUOTE_TTL_SECONDS` |
| `iat` | `number` (epoch s) | emisión |
| `oid` | `string` | `orchestrationId` del plan (**solo correlación**, ver CD-11) |
| `steps` | `Array<{a,p,r}>` | `a` = slug; `r` = registry (`string \| null`); `p` = precio como string `toFixed(8)` |
| `v` | `1` | versión del payload |

`p` viaja como string de 8 decimales para que firma y verificación sean byte-idénticas y no haya
sorpresas de coma flotante entre emisión y redención.

#### Binding al caller

```
QuoteCaller = { kind: 'delegation'|'session'|'key', id: string }
bind = HMAC-SHA256(secret, "quote-bind:v1:" + kind + ":" + id)  → hex
```

`resolveQuoteCaller(ctx)` es la **única fuente de verdad** del binding (CD-12), usada por emisión **y**
por redención, con esta precedencia (espeja cómo se enruta el débito en el middleware):

1. `delegationContext` presente → `{kind:'delegation', id: delegationContext.delegationId}`
2. si no, `keySessionContext` presente → `{kind:'session', id: keySessionContext.sessionId}`
3. si no, `a2aKeyRow` presente → `{kind:'key', id: a2aKeyRow.id}`
4. si no (x402 / anónimo) → `null`: no se emite quote y no se puede redimir uno.

El id crudo **nunca** entra al payload (el base64url es legible por cualquiera): va como HMAC, patrón
`hashCallerRef` de `src/lib/caller-hash.ts`. El `kind` entra al HMAC para que una delegación y una
sesión con el mismo UUID no colisionen.

El binding es a la **credencial exacta**, no al `owner_ref`: el mismo owner con OTRA de sus keys **no**
puede redimir el quote (test T-Q-R10).

#### API pública

| Función | Firma | Notas |
|---|---|---|
| `quoteHmacKey()` | `(): string \| null` | lee `process.env.ORCHESTRATE_QUOTE_HMAC_KEY`; vacío o ausente → `null`. **Sin fallback a ningún otro secreto** (CD-5) |
| `resolveQuoteCaller(ctx)` | `(ctx: {delegationContext?, keySessionContext?, a2aKeyRow?}) => QuoteCaller \| null` | tipo **estructural**, sin importar Fastify |
| `computeQuoteBinding(caller)` | `(caller: QuoteCaller) => string \| null` | `null` si no hay secreto |
| `signQuote(input)` | `({orchestrationId, caller, steps: QuoteStepInput[], nowMs?}) => {token, expiresAtIso} \| null` | `null` si no hay secreto, `steps` vacío, o algún precio no es finito y `> 0`. **Nunca tira** |
| `verifyQuote(token, caller, nowMs?)` | `=> {ok:true, payload} \| {ok:false, code}` | `code ∈ {'QUOTE_INVALID','QUOTE_EXPIRED','QUOTE_CALLER_MISMATCH'}`. **Nunca tira** |

#### Orden de verificación en `verifyQuote` (load-bearing, CD-8)

1. `typeof token === 'string'` y `token.length <= QUOTE_MAX_TOKEN_CHARS`; si no → `QUOTE_INVALID`.
2. Hay secreto; si no → `QUOTE_INVALID` (**fail-closed**: sin secreto no se acepta ningún quote, y
   **nunca** se cae al camino de precio vivo teniendo un quote presente).
3. Split en 3 partes por `.`, prefijo `v1`, firma con forma hex de 64 chars; si no → `QUOTE_INVALID`.
4. **HMAC sobre `"<v>.<b64>"` + `timingSafeEqual`**; si no coincide → `QUOTE_INVALID`.
5. Recién ahora: base64url-decode + `JSON.parse` en `try/catch` + validación de forma (`v===1`,
   `iat`/`exp` enteros, `steps` array no vacío, cada `a` string no vacío, cada `p` parseable a número
   finito **> 0**, `r` string o `null`); si no → `QUOTE_INVALID`.
6. `nowSec >= exp` → `QUOTE_EXPIRED`. `iat > nowSec + QUOTE_CLOCK_SKEW_SECONDS` → `QUOTE_INVALID`.
7. `computeQuoteBinding(caller)` vs `payload.bind` con `timingSafeEqual`; si no → `QUOTE_CALLER_MISMATCH`.

**Por qué la firma va antes que la expiración** (al revés que `signed-auth.ts`): acá el `exp` viaja
**dentro** del payload que estamos verificando; leerlo antes de validar el HMAC sería confiar en un
campo que el atacante controla. En `signed-auth.ts` el timestamp viaja en un header aparte, por eso
allá el orden es el otro. **PROHIBIDO** invertirlo.

### 7.2 Emisión en `/plan` (W1.1)

Se emite el quote **solo si se cumplen las cinco**:

1. `plan.planStatus === 'ready'`;
2. `quoteHmacKey() !== null`;
3. `resolveQuoteCaller(request) !== null`;
4. `plan.steps.length >= 1` y todo step tiene `agent` string no vacío;
5. **todo** `plan.costPerStep[i]` es finito y `> 0`.

Si falla cualquiera: `quote` y `quoteExpiresAt` quedan `undefined` y `JSON.stringify` los omite
(mismo mecanismo que `feeRatePercent`, que ya está en ese objeto).

La condición 5 es deliberada: si un step no resolvió precio, `costPerStep[i]` es 0 y hoy ese step se
cobra con `PLACEHOLDER_FEE_USD` ($1). Congelar 0 sería congelar un revenue leak; congelar $1 sería
congelar un número que nunca se cotizó. No emitir quote deja al cliente con el comportamiento de hoy,
que no empeora.

### 7.3 Redención en `/execute` (W1.2)

Con `body.quote` presente y los 6 guards en verde, el handler arma el plan con los valores
**congelados**:

| Valor | Sin quote (hoy, intacto) | Con quote válido |
|---|---|---|
| `costPerStep[i]` | `resolveAgentPriceUsdc(step)` en vivo | `payload.steps[i].p` |
| `plannedCostUsd` (base del débito del step-0) | `resolveAgentPriceUsdc(steps[0])` en vivo | `payload.steps[0].p` |
| `totalCostUsdc` / `feeUsdc` (reserva de `maxBudget`) | suma en vivo × rate | suma congelada × rate |
| `maxQuotedCostUsdc` **en el request al service** | `body.maxQuotedCostUsdc` (corre el cap gate) | **NO se pasa** (el cap gate no corre) |
| `frozenStepPricesUsd` (campo nuevo) | ausente | los N precios congelados |
| `plan.maxQuotedCostUsdc` (campo informativo del resultado) | `body.maxQuotedCostUsdc` | `body.maxQuotedCostUsdc` (sin cambios) |

**Por qué el cap gate no corre con quote válido**: re-resuelve todos los precios en vivo y tira 409
`QUOTE_STALE` si la suma supera el techo. Con un quote válido eso rompería AC-2 (rechazarle la
ejecución a un caller que tiene garantía de precio, por un precio vivo que ya no lo afecta). Además es
redundante: la suma congelada es ≤ el techo por construcción, porque el techo se derivó de esos mismos
precios en `/plan`. Con `exactOptionalPropertyTypes` activo, el request al service se arma con **spread
condicional** para no pasar `maxQuotedCostUsdc: undefined`.

#### Los 6 guards

Todos corren **antes** de la primera llamada a `orchestrateService.executeApprovedPlan`, que es la
única línea que mueve dinero. Ninguna capa anterior debita en esta ruta (`markSkipMiddlewareDebitHandler`
está en el preHandler y el flag se respeta en los tres paths del middleware). De ahí sale la garantía
estructural de "0 débito" (CD-3/CD-7).

| # | Guard | Condición | HTTP | `error_code` | AC |
|---|-------|-----------|------|--------------|----|
| G1 | Token verificable | `verifyQuote` → `QUOTE_INVALID` | 400 | `QUOTE_INVALID` | AC-3 |
| G2 | Vigencia | `verifyQuote` → `QUOTE_EXPIRED` | 409 | `QUOTE_EXPIRED` | AC-3 |
| G3 | Binding | `verifyQuote` → `QUOTE_CALLER_MISMATCH`, **o** `resolveQuoteCaller(request) === null` con quote presente | 403 | `QUOTE_CALLER_MISMATCH` | AC-4 |
| G4 | Cantidad de steps | `body.steps.length !== payload.steps.length` | 400 | `QUOTE_STEP_MISMATCH` | AC-2 |
| G5 | Identidad por step | para algún `i`: `body.steps[i].agent !== payload.steps[i].a` **o** `(body.steps[i].registry ?? null) !== payload.steps[i].r` | 400 | `QUOTE_STEP_MISMATCH` | AC-2 |
| G6 | Agente vivo | para algún `i`: `resolveAgentPriceUsdc(a, r ?? undefined, /* forceRefresh */ true)` → `null` | 409 | `QUOTE_AGENT_UNAVAILABLE` | AC-5 |

- **G5 rechaza, no corrige** (§3.2).
- **G6** usa el mismo resolver del money-path: `null` ⟺ el agente no resuelve en **ningún** registry
  habilitado (borrado, desactivado, o registry deshabilitado). El precio vivo que devuelve se usa
  **solo** para el log `price-delta`, **jamás** para debitar.
- Orden G1→G6 de barato a caro: la criptografía es local, la existencia del agente es red.

### 7.4 Freeze de los steps 1..N (W1.3)

`src/services/orchestrate.ts`: una línea aditiva dentro del objeto de `composeService.compose({ … })`,
propagando `request.frozenStepPricesUsd`.

`src/services/compose.ts`, dentro del bloque anclado en `if (i > 0 && scopingKeyRow && chainId !== undefined) {`:

- si `frozenStepPricesUsd?.[i]` es finito y `> 0` → `debitAmount = ese precio + stepGasOverhead`;
- si no (ausente, 0, negativo, NaN) → **exactamente el camino de hoy**
  (`(isInvalid ? PLACEHOLDER_FEE_USD : agent.priceUsdc) + stepGasOverhead`).

**Intocable** en ese archivo: el guard `i > 0` (única defensa anti double-charge del step-0), el
`totalCost += agent.priceUsdc` (base del protocol fee: es el costo **ejecutado**), el `maxBudget` check
con precio vivo, el refund `stepDebitedUsd`, y el settle downstream.

### 7.5 `.env.example` (W0.3) — texto exacto a insertar

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

### 7.6 Telemetría (aditiva, sin PII, nunca el token ni el secreto)

| Log | Nivel | Cuándo | Campos |
|---|---|---|---|
| `[orchestrate.quote.issued]` | info | `/plan` emite | `orchestrationId`, `stepCount`, `expiresAt` |
| `[orchestrate.quote.redeemed]` | info | `/execute` con quote válido | `orchestrationId`, `planId`, `stepCount`, `ttlRemainingSec` |
| `[orchestrate.quote.price-delta]` | warn | por step donde el precio vivo ≠ el congelado | `orchestrationId`, `step`, `frozenUsd`, `liveUsd`, `deltaUsd` |
| `[orchestrate.quote.rejected]` | warn | cualquier guard G1-G6 | `orchestrationId`, `planId`, `error_code` |

Esta es la **lista cerrada**. **PROHIBIDO** loguear el token, el payload completo o el secreto (CD-10).

---

## 8. Exemplars (verificados en disco el 2026-07-28)

### Exemplar 1: token firmado stateless
**Archivo**: `src/services/receipt.ts` (bloque `CanonicalFields` / `buildCanonicalPayload` /
`computeReceiptHash` / `hashesEqual`)
**Usar para**: archivo #1
**Patrón clave**:
- payload canónico con **keys en orden alfabético explícito** y `Number(x).toFixed(8)` para los montos;
- getter del secreto que devuelve `null` si la env no está (`if (!secret) return null;`), sin throw;
- comparación: regex hex **antes** de `Buffer.from`, longitud **antes** de `timingSafeEqual`, nunca throw;
- el secreto nunca se loguea.

### Exemplar 2: par sign/verify puro
**Archivo**: `src/services/llm/transform-hmac.ts` (84 líneas, leelo entero)
**Usar para**: archivo #1
**Patrón clave**:
- `const HEX = /^[0-9a-f]{64}$/;` a nivel módulo;
- `verify*` devuelve `false` ante **cualquier** entrada malformada y **nunca tira**;
- `Buffer.from(sig, 'hex')` dentro de `try/catch`, con chequeo de longitud antes de `timingSafeEqual`;
- JSDoc que explica *por qué* constant-time, no solo *qué* hace.

### Exemplar 3: resultado discriminado que el route mapea a HTTP
**Archivo**: `src/services/signed-auth.ts`
**Usar para**: `verifyQuote` (archivo #1) y los guards (archivo #5)
**Patrón clave**: `{ok:true, …} | {ok:false, code}`; el route traduce `code` → status; el orden de
checks documentado en el JSDoc; las funciones reciben **primitivos**, no el `request` de Fastify.

### Exemplar 4: HMAC de una identidad para no exponerla
**Archivo**: `src/lib/caller-hash.ts` (`hashCallerRef`)
**Usar para**: `computeQuoteBinding` (archivo #1)

### Exemplar 5: campo aditivo en la respuesta de `/plan`
**Archivo**: `src/routes/orchestrate.ts`, el `const feeRatePercent = plan.planStatus === 'ready' ? … : undefined;`
y el objeto tras el comentario `// Solo los campos PÚBLICOS del OrchestratePlanResult (pick).`
**Usar para**: archivo #4
**Patrón clave**: campo `undefined` ⇒ `JSON.stringify` lo omite ⇒ back-compat sin condicionales en el send.

### Exemplar 6: guard con return temprano en `/execute`
**Archivo**: `src/routes/orchestrate.ts`, bloque `if ('__quoteStale' in result) { return reply.status(409).send({ error_code: 'QUOTE_STALE', … }); }`
**Usar para**: archivo #5

### Exemplar 7: tests de sign/verify puros
**Archivos**: `src/services/llm/transform-hmac.test.ts` + `src/services/receipt.test.ts`
**Usar para**: archivo #8

### Exemplar 8: tests de dinero con mocks de borde
**Archivo**: `src/services/orchestrate.billing.test.ts`
**Usar para**: archivo #10
**Patrón clave**: corre el **compose real**, mockea solo el borde (`budgetService.debit`,
`discoveryService`, adapters, `fetch`) y afirma cantidad y monto exacto de los débitos.

### Exemplar 9: bloque de env con secreto
**Archivo**: `.env.example`, bloque de `SCHEMA_TRANSFORM_HMAC_KEY=`
**Usar para**: archivo #3

---

## 9. Waves

### Wave -1: Environment Gate (OBLIGATORIO antes de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a

# 1) Dependencias
npm install

# 2) Los archivos base del Scope IN existen
ls src/routes/orchestrate.ts src/services/orchestrate.ts src/services/compose.ts \
   src/types/index.ts .env.example doc/INTEGRATION.md \
   src/services/receipt.ts src/services/llm/transform-hmac.ts src/lib/caller-hash.ts \
   src/services/agent-price.ts src/services/orchestrate.billing.test.ts

# 3) Los 3 archivos nuevos NO existen todavía
ls src/services/orchestrate-quote.ts src/services/orchestrate-quote.test.ts \
   src/services/orchestrate.quote-billing.test.ts 2>&1 | head

# 4) Baseline limpio ANTES de escribir nada
npx tsc --noEmit
npm test   # debe dar 3996 passed | 19 skipped

# 5) Estado del worktree (ver §0)
git status --porcelain
```

**Si el baseline no da 3996 passed | 19 skipped, o `tsc` no está limpio: PARAR y reportar.** No se
implementa sobre un entorno roto: sin baseline confiable, ningún resultado posterior significa nada.

### Wave 0 — Serial gate (contratos, sin cambio de comportamiento)

Las tres tareas son independientes entre sí y pueden hacerse en cualquier orden, pero **W1 no arranca
hasta que las tres estén y `tsc` esté limpio**.

- [ ] **W0.1** — Crear `src/services/orchestrate-quote.ts` (archivo #1) → Exemplars 1, 2, 3, 4
- [ ] **W0.2** — `src/types/index.ts` (archivo #2): `frozenStepPricesUsd` en `ComposeRequest` y en
      `OrchestrateRequest`, con JSDoc que diga qué es y que su ausencia = comportamiento de hoy
- [ ] **W0.3** — `.env.example` (archivo #3) → Exemplar 9

**Gate W0**: `npx tsc --noEmit` limpio. Nada de W1 arranca antes.

### Wave 1 — Tres frentes (paralelizables con una salvedad)

| Tarea | Archivo | Depende de | ¿Paralela? |
|---|---|---|---|
| **W1.1** emisión en `/plan` | #4 (`src/routes/orchestrate.ts`) | W0.1 | Con W1.3 sí. Con W1.2 **no** (mismo archivo) |
| **W1.2** redención en `/execute` | #5 (`src/routes/orchestrate.ts`) | W0.1 + W0.2 | Con W1.3 sí. Con W1.1 **no** (mismo archivo) |
| **W1.3** freeze steps 1..N | #6 + #7 (`services/orchestrate.ts`, `services/compose.ts`) | W0.2 | Sí, con W1.1 y W1.2 |

- [ ] **W1.1** — emisión (§7.2) + log `issued`. Zona: `/plan`.
- [ ] **W1.2** — schema del campo `quote`, los 6 guards (§7.3), armado del plan congelado, spread
      condicional de `maxQuotedCostUsdc`, logs `redeemed`/`price-delta`/`rejected`. Zona: `/execute`.
- [ ] **W1.3** — **LEER §0 PRIMERO Y CORRER EL CHEQUEO DE `git status`.** Propagación + consumo del
      precio congelado (§7.4).

> W1.1 y W1.2 tocan el mismo archivo en zonas distintas (`/plan` vs `/execute`). Hacerlas **en el mismo
> worktree y en ese orden** (primero W1.1, después W1.2). No abrir un worktree paralelo para esto.

**Gate W1**: `npx tsc --noEmit` limpio + `npm test` sin regresión contra el baseline (3996 | 19).

### Wave 2 — Tests (33 nuevos)

| Tarea | Archivo | Depende de | ¿Paralela? |
|---|---|---|---|
| **W2.1** 11 unitarios | #8 | W0.1 | Sí, con W2.2 y W2.3 |
| **W2.2** +15 de ruta | #9 | W1.1 + W1.2 | Sí |
| **W2.3** 7 de dinero | #10 | W1.3 | Sí |

**Gate W2**: `npm test` = **4029+ passed | 19 skipped**, 0 failed.

### Wave 3 — Cierre

- [ ] **W3.1** — `doc/INTEGRATION.md` (archivo #11), incluyendo el compromiso de §4 con todas las letras.
- [ ] **W3.2** — Campaña de mutación completa (§11): **primero el mutante de control**, después los 22.
- [ ] **W3.3** — `npx tsc --noEmit` + `npx biome check src/` + `npm test` completo.

### Verificación incremental

| Wave | Verificación al completar |
|------|---------------------------|
| W-1 | `tsc` limpio + baseline 3996 passed \| 19 skipped |
| W0 | `npx tsc --noEmit` limpio (la suite entera, **no** solo `npm run build`: excluye los tests, lección WKH-196) |
| W1 | `npx tsc --noEmit` + `npm test` sin regresión sobre el baseline |
| W2 | `npm test` = 4029+ passed \| 19 skipped, 0 failed |
| W3 | mutación (control + 22) + `npx biome check src/` + `npm test` completo |

---

## 10. Tests: qué se crea, qué afirma cada uno, y qué AC cubre

### 10.1 Unitarios — `src/services/orchestrate-quote.test.ts` (nuevo, 11 tests)

| Test | Qué afirma exactamente | AC | Mata |
|---|---|---|---|
| T-Q-U1 | round-trip `signQuote` → `verifyQuote` = `{ok:true}`; `payload.steps` tiene los **mismos** slugs, registries y precios que se firmaron; `exp - iat === 600` | AC-1 | M12 |
| T-Q-U2 | token con el payload mutado (precio `0.05` → `0.01`, re-encodeado, **misma firma**) → `{ok:false, code:'QUOTE_INVALID'}` | AC-3 | M3 |
| T-Q-U3 | token emitido en `now - 601s` → `QUOTE_EXPIRED`; el mismo token emitido en `now - 599s` → `{ok:true}` (los dos lados del borde) | AC-3 | M1, M12 |
| T-Q-U4 | quote de `{kind:'key', id:'k1'}` verificado con `{kind:'key', id:'k2'}` → `QUOTE_CALLER_MISMATCH`; y `{kind:'delegation', id:'X'}` vs `{kind:'session', id:'X'}` (mismo id, distinto kind) → `QUOTE_CALLER_MISMATCH` | AC-4 | M2 |
| T-Q-U5 | el módulo es stateless: el **texto del archivo fuente** no matchea `/supabase\|redis\|ioredis\|pg/`, y el round-trip funciona sin un solo mock | AC-7 | M13 |
| T-Q-U6 | payload con `p` = `"0.00000000"`, negativo o `"NaN"`, **firmado con la clave real** (o sea: la firma verifica y aun así se rechaza) → `QUOTE_INVALID` | AC-3 | M9 |
| T-Q-U7 | sin `ORCHESTRATE_QUOTE_HMAC_KEY`: `signQuote` → `null`, y `verifyQuote` de un token válido previo → `QUOTE_INVALID` (fail-closed) | AC-7 | M14 |
| T-Q-U8 | token de `QUOTE_MAX_TOKEN_CHARS + 1` chars → `QUOTE_INVALID`, sin tirar | AC-3 | — |
| T-Q-U9 | token con `iat = now + 120` → `QUOTE_INVALID` | AC-3 | M15 |
| T-Q-U10 | firmas malformadas (largo distinto, no-hex, vacía, `undefined` casteado, token sin puntos, token con 4 partes) → `QUOTE_INVALID` y **nunca throw** | AC-3 | — |
| T-Q-U11 | `resolveQuoteCaller`: delegación gana sobre sesión, sesión gana sobre key, sin ninguno → `null` | AC-4 | M16 |

**CD-16**: `process.env.ORCHESTRATE_QUOTE_HMAC_KEY` se restaura en `afterEach`, **nunca** en la última
línea del cuerpo del test (si el test falla antes, contamina todo el archivo).

**CD-17**: ningún test re-implementa el HMAC para compararlo contra sí mismo. Los tests de firma parten
de un token producido por `signQuote` y lo mutan byte a byte, o usan **otra** clave.

### 10.2 Ruta — `src/routes/orchestrate.test.ts` (`describe` nuevo, +15 tests)

| Test | Qué afirma exactamente | AC | Mata |
|---|---|---|---|
| T-Q-P1 | `/plan` ready con secreto y key ⇒ `body.quote` presente, y `verifyQuote(quote, caller)` devuelve **los mismos precios que `costPerStep`**; `quoteExpiresAt` = `iat + 600` | AC-1 | — |
| T-Q-P2 | sin secreto ⇒ `'quote' in body === false` **y** `'quoteExpiresAt' in body === false`, y el resto del body es idéntico al de hoy | AC-6 | M11 |
| T-Q-P3 | `planStatus !== 'ready'` ⇒ sin `quote` | AC-1 | M17 |
| T-Q-P4 | `costPerStep` con un `0` ⇒ sin `quote` | AC-1 | M18 |
| T-Q-P5 | caller x402 (sin `a2aKeyRow`, sin delegación, sin sesión) ⇒ sin `quote` | AC-4 | M19 |
| T-Q-R1 | `/execute` con quote válido ⇒ `executeApprovedPlan` llamado con `plannedCostUsd` y `costPerStep` **congelados**, `frozenStepPricesUsd` = los congelados, y **sin** `maxQuotedCostUsdc` en el request al service | AC-2 | M7, M10 |
| T-Q-R2 | `/execute` **sin** quote ⇒ `executeApprovedPlan` llamado exactamente como hoy: precios vivos, `maxQuotedCostUsdc` **presente**, `frozenStepPricesUsd` **ausente** | AC-6 | M20 |
| T-Q-R3 | quote expirado ⇒ 409 `QUOTE_EXPIRED` + `requiresNewQuote:true` + `executeApprovedPlan` **no** llamado | AC-3 | M1 |
| T-Q-R4 | quote de otra key ⇒ 403 `QUOTE_CALLER_MISMATCH` + **no** llamado | AC-4 | M2 |
| T-Q-R5 | `body.steps[0].agent` ≠ el congelado ⇒ 400 `QUOTE_STEP_MISMATCH` + **no** llamado (y **no** se ejecuta con la identidad del quote: rechazo, no corrección) | AC-2 | M4 |
| T-Q-R6 | `body.steps` con un step de más ⇒ 400 `QUOTE_STEP_MISMATCH` + **no** llamado | AC-2 | M5 |
| T-Q-R7 | `resolveAgentPriceUsdc` → `null` para un agente congelado ⇒ 409 `QUOTE_AGENT_UNAVAILABLE` + **no** llamado | AC-5 | M6 |
| T-Q-R8 | quote válido + precio vivo **por encima** de `maxQuotedCostUsdc` ⇒ 200 y ejecución al precio congelado (nunca 409 `QUOTE_STALE`) | AC-2 | M10 |
| T-Q-R9 | `quote: "basura"` ⇒ 400 `QUOTE_INVALID` + **no** llamado (no cae al camino de precio vivo) | AC-3 | M21 |
| T-Q-R10 | quote emitido bajo **delegación**, presentado por la **master key del mismo owner** ⇒ 403 `QUOTE_CALLER_MISMATCH` | AC-4 | M2 |
| T-Q-R11 | los 3 contextos (master / delegación / sesión) emiten y redimen su propio quote de punta a punta | AC-4 | M16 |

### 10.3 Dinero — `src/services/orchestrate.quote-billing.test.ts` (nuevo, 7 tests)

Harness clonado de `orchestrate.billing.test.ts` (compose **real**, mocks solo de borde) **más un
ledger con estado**: el doble de `budgetService.debit` descuenta de una variable `balanceUsd` y
devuelve `{success:true}`; `getBalance` la lee. Cada test mide `balanceUsd` **antes** y **después**.

**CD-14**: los dobles de `budgetService.debit` y `resolveAgentPriceUsdc` **capturan y afirman todos sus
argumentos** (monto, índice, slug, contexto) y se tipan con el retorno real de la función. Un doble que
descarta argumentos hace vacuo el test: es la 3ª reincidencia del repo.

| Test | Escenario | Aserción de saldo (obligatoria) | AC | Mata |
|---|---|---|---|---|
| T-Q-B1 | 1 step. Congelado `0.05`; el precio vivo **sube** a `0.09` | `antes − después === 0.05` exacto | AC-2 | M7 |
| T-Q-B2 | 3 steps. Congelados `[0.05, 0.06, 0.07]`; vivos `[0.09, 0.11, 0.13]` | `antes − después === 0.18` **y** cada llamada a `debit` con el monto congelado de SU índice, afirmado uno a uno | AC-2 | M8 |
| T-Q-B3 | 1 step. Congelado `0.05`; el precio vivo **baja** a `0.01` | `antes − después === 0.05` (el freeze es simétrico: se cobra lo pactado, no lo más barato) | AC-2 | M7, M22 |
| T-Q-B4 | quote expirado, en los **3 contextos** de débito (master, delegación, sesión) | `antes === después` **y** `debit` nunca llamado | AC-3 | M1 |
| T-Q-B5 | agente congelado que ya no resuelve | `antes === después` **y** `debit` nunca llamado | AC-5 | M6 |
| T-Q-B6 | **sin** quote, precio vivo `0.09` | `antes − después === 0.09` (regresión: el camino de hoy sigue cobrando en vivo) | AC-6 | M20 |
| T-Q-B7 | quote firmado con un precio `0` en un step | 400 `QUOTE_INVALID` **y** `antes === después` (jamás un débito de $0) | AC-3 | M9 |

### 10.4 Cobertura por AC (cada AC tiene al menos un test que lo pone rojo si se rompe)

| AC | Tests | Qué prueba el conjunto |
|---|---|---|
| AC-1 | T-Q-U1, T-Q-U3, T-Q-P1, T-Q-P3, T-Q-P4 | el quote se emite solo cuando corresponde, congela precio **e** identidad, y dura exactamente 600 s |
| AC-2 | T-Q-R1, T-Q-R5, T-Q-R6, T-Q-R8, T-Q-B1, T-Q-B2, T-Q-B3 | se debita el precio congelado (arriba y abajo del vivo), por el agente congelado, y la identidad distinta se rechaza |
| AC-3 | T-Q-U2, T-Q-U3, T-Q-U6, T-Q-U8, T-Q-U9, T-Q-U10, T-Q-R3, T-Q-R9, T-Q-B4, T-Q-B7 | expirado/firma inválida/payload inválido ⇒ error distinguible con `requiresNewQuote:true` y **saldo idéntico** |
| AC-4 | T-Q-U4, T-Q-U11, T-Q-P5, T-Q-R4, T-Q-R10, T-Q-R11 | binding a la credencial exacta, en los 3 contextos, con el mismo owner incluido |
| AC-5 | T-Q-R7, T-Q-B5 | agente caído ⇒ 409 y **saldo idéntico** |
| AC-6 | T-Q-P2, T-Q-R2, T-Q-B6 + toda la suite preexistente de `/orchestrate` | sin quote, el comportamiento de hoy intacto |
| AC-7 | T-Q-U5, T-Q-U7 | stateless real (sin imports de storage) y fail-closed sin secreto |

---

## 11. Campaña de mutación: 1 de control **primero**, después 22 mutantes

### 11.0 Procedimiento por mutante (obligatorio, sin atajos)

```bash
# 1) Copia de respaldo FUERA del árbol de git + hash de referencia
SCRATCH=/tmp/claude-1000/-home-ferdev--openclaw-workspace-wasiai-a2a/mutants
mkdir -p "$SCRATCH"
cp src/services/compose.ts "$SCRATCH/compose.ts.orig"
sha256sum src/services/compose.ts | tee "$SCRATCH/compose.ts.sha256"

# 2) Aplicar la mutación con Edit (nunca con sed sobre el archivo real)

# 3) VERIFICAR QUE COMPILA — si no compila, el mutante NO CUENTA
npx tsc --noEmit

# 4) Correr SOLO los tests asesinos (rápido) y confirmar que quedan ROJOS
npx vitest run <archivo de test>

# 5) Restaurar copiando de vuelta y verificar el hash
cp "$SCRATCH/compose.ts.orig" src/services/compose.ts
sha256sum -c "$SCRATCH/compose.ts.sha256"   # debe decir: OK
```

- **CD-15 / §0**: `git checkout --`, `git restore`, `git stash`, `git clean` y `git reset` están
  **PROHIBIDOS** como undo. La evidencia de reversión es el `sha256sum -c: OK`, no el `git status`.
- **CD-18**: un mutante que **no compila** (`npx tsc --noEmit` con la mutación puesta debe salir limpio)
  **no cuenta**. Un error de sintaxis pone todo rojo y no prueba nada: se anota como "descartado, no
  compila" y se reemplaza por una variante equivalente que sí compile.
- Un mutante que **sobrevive** (los tests quedan verdes) es un hallazgo: se reporta, no se disimula.
  Significa que el test asesino es vacuo o que la lógica es inalcanzable.

### 11.1 Mutante de CONTROL — **se corre PRIMERO, antes que los otros 22**

| Campo | Valor |
|---|---|
| **Archivo** | `src/services/compose.ts` |
| **Mutación** | Comentar el guard preexistente: la línea anclada en `if (i > 0 && scopingKeyRow && chainId !== undefined) {` pasa a `if (scopingKeyRow && chainId !== undefined) {` (quitar `i > 0 &&`) |
| **Compila** | Sí (cambio de condición, sin tocar tipos ni sintaxis) |
| **Qué debe pasar** | **Tests PREEXISTENTES en rojo** (double-charge del step-0: `src/services/orchestrate.billing.test.ts` y `src/services/compose.test.ts` afirman la cantidad y el monto de los débitos) |
| **Si NO pone nada rojo** | **PARAR TODA LA CAMPAÑA.** El banco de pruebas no vale y **los otros 22 mutantes no prueban nada**: si un guard preexistente y crítico se puede borrar sin que nadie se entere, un mutante que "muere" puede estar muriendo por otro motivo, y uno que "sobrevive" no distingue entre código correcto y test vacuo. Reportar al orquestador: *"Mutante de control sobrevivió: el harness de mutación no discrimina. Campaña abortada."* |

**Por qué primero**: el control calibra el instrumento. Correrlo al final significaría descubrir después
de 22 mediciones que ninguna era válida.

**Recordatorio**: el guard `i > 0` se restaura inmediatamente y se verifica con `sha256sum -c`. Es la
única defensa anti double-charge del step-0. **Bajo ninguna circunstancia** ese cambio queda en el
working tree cuando termina el paso.

### 11.2 Los 22 mutantes

Todos son cambios de condición, de literal o de origen del dato: ninguno toca sintaxis ni tipos, así
que **todos deben compilar**. Verificar con `npx tsc --noEmit` en cada uno (paso 3 de §11.0) antes de
contarlo.

| # | Archivo | Mutación (debe compilar) | Test asesino | Qué prueba que muera |
|---|---|---|---|---|
| M1 | `orchestrate-quote.ts` | `if (nowSec >= payload.exp)` → `if (false)` | T-Q-U3, T-Q-R3, T-Q-B4 | el TTL de 10 min se enforcea de verdad, y el expirado no debita |
| M2 | `orchestrate-quote.ts` | el comparador del binding devuelve `true` fijo | T-Q-U4, T-Q-R4, T-Q-R10 | el quote está atado a la credencial exacta, no a cualquiera |
| M3 | `orchestrate-quote.ts` | `if (!signatureOk)` → `if (false)` | T-Q-U2 | un payload manipulado con firma vieja no pasa |
| M4 | `routes/orchestrate.ts` | G5 (identidad por step) → `if (false)` | T-Q-R5 | la identidad congelada se **rechaza** al no coincidir (guard observable, §3.2) |
| M5 | `routes/orchestrate.ts` | G4 (cantidad de steps) → `if (false)` | T-Q-R6 | no se puede colar un step extra en la redención |
| M6 | `routes/orchestrate.ts` | G6 (`price === null`) → `if (false)` | T-Q-R7, T-Q-B5 | un agente caído no se cobra ni al congelado ni al vivo |
| M7 | `routes/orchestrate.ts` | `plannedCostUsd` = precio **vivo** de `steps[0]` en vez del congelado | T-Q-B1, T-Q-B3, T-Q-R1 | el step-0 se debita al precio congelado en las dos direcciones |
| M8 | `services/compose.ts` | ignorar `frozenStepPricesUsd[i]` y usar siempre `agent.priceUsdc` | T-Q-B2 | los steps 1..N también se debitan congelados, cada uno con SU precio |
| M9 | `orchestrate-quote.ts` | validación del precio `> 0` → `>= 0` | T-Q-U6, T-Q-B7 | nunca se congela ni se debita un precio de $0 |
| M10 | `routes/orchestrate.ts` | pasar `maxQuotedCostUsdc` al service también con quote válido | T-Q-R8, T-Q-R1 | el cap gate no le rechaza la ejecución a quien tiene garantía de precio |
| M11 | `routes/orchestrate.ts` | emitir `quote` aunque `quoteHmacKey()` sea `null` (firmar con `''`) | T-Q-P2 | sin secreto no se emite un token que nadie puede verificar |
| **M12** | `orchestrate-quote.ts` | `QUOTE_TTL_SECONDS = 600` → `3600` (la ventana de freeze se sextuplica en silencio) | T-Q-U1, T-Q-U3 | los 10 minutos son 10 minutos: `exp - iat === 600` y a los 601 s expira |
| M13 | `orchestrate-quote.ts` | agregar `import { supabase } from '../lib/supabase';` sin usar | T-Q-U5 | el módulo es stateless de verdad (AC-7), no "stateless por ahora" |
| M14 | `orchestrate-quote.ts` | `quoteHmacKey()` con fallback a `RECEIPT_SIGNING_SECRET` | T-Q-U7 | el secreto es dedicado, sin fallback cruzado (CD-5) |
| M15 | `orchestrate-quote.ts` | guard de `iat` futuro → `if (false)` | T-Q-U9 | una instancia con el reloj adelantado no emite quotes que vivan más de 10 min |
| M16 | `orchestrate-quote.ts` | invertir la precedencia de `resolveQuoteCaller` (key antes que delegación) | T-Q-U11, T-Q-R11 | el binding sigue la misma precedencia que el enrutado del débito |
| M17 | `routes/orchestrate.ts` | emitir quote con `planStatus !== 'ready'` | T-Q-P3 | no se congela un plan que no está listo |
| M18 | `routes/orchestrate.ts` | emitir quote con algún `costPerStep[i] === 0` | T-Q-P4 | no se congela un $0 (revenue leak) ni un $1 que nadie cotizó |
| M19 | `routes/orchestrate.ts` | emitir quote sin caller bindeable (bind fijo `'anon'`) | T-Q-P5 | un quote sin dueño sería redimible por cualquiera |
| M20 | `routes/orchestrate.ts` | tratar la ausencia de `quote` como quote inválido (400) | T-Q-R2, T-Q-B6, **+ los tests T-EXEC preexistentes** | back-compat: los clientes de hoy (incluido Chaski) no se rompen (AC-6/CD-2) |
| M21 | `routes/orchestrate.ts` | ante `QUOTE_INVALID`, seguir por el camino de precio vivo en vez de rechazar | T-Q-R9, T-Q-B7 | un quote roto **nunca** degrada silenciosamente a cobro en vivo |
| M22 | `services/compose.ts` | usar `Math.min(frozen, agent.priceUsdc)` en vez del congelado | T-Q-B3 | el freeze es exacto y simétrico, no "el menor de los dos" (§3.4) |

> **Nota de numeración**: el SDD §4.9 lista 21 filas (M1-M11 y M13-M22): el número **M12 quedó como
> hueco** al escribirlo, mientras el conteo declarado era 22. Se completa acá con el mutante del TTL,
> que es exactamente el invariante que ninguna otra fila cubría (el `600` literal). Total: **22
> mutantes + 1 de control**, todos con test asesino nombrado.

### 11.3 Evidencia que hay que entregar al cerrar W3.2

Una tabla con una fila por mutante: `#`, archivo, `tsc` limpio (sí/no), test asesino corrido, resultado
(**muerto** / sobrevivió / descartado por no compilar), y el `sha256sum -c` de la restauración. Más la
fila del control, arriba de todo, con sus tests preexistentes en rojo nombrados uno por uno.

---

## 12. Constraint Directives

### OBLIGATORIO

- **CD-2**: la ausencia del campo `quote` en `/orchestrate/execute` preserva el comportamiento actual
  **byte a byte**. Ningún cliente existente puede romperse.
- **CD-4**: verificar el HMAC con `crypto.timingSafeEqual`, replicando el patrón de
  `src/services/llm/transform-hmac.ts` y `src/services/signed-auth.ts`.
- **CD-6**: re-verificar existencia y estado activo del agente congelado contra discovery al redimir,
  **antes** de facturar. El quote nunca reemplaza ese chequeo.
- **CD-7**: los 6 guards corren **antes** de la primera llamada a
  `orchestrateService.executeApprovedPlan`. Es la garantía estructural de "0 débito".
- **CD-8**: verificar el HMAC **sobre el string crudo del token**, y decodificar/parsear el payload
  **solo después** de que la firma verificó.
- **CD-12**: `resolveQuoteCaller` y `computeQuoteBinding` son la **única** expresión del binding,
  compartida por emisión y redención; el precio congelado se lee de **un solo lugar**
  (`payload.steps[i]`), tanto para el step-0 como para 1..N.
- **CD-13**: todo test de rechazo afirma **saldo antes === saldo después** (no solo el status code) y
  todo test de éxito afirma `saldoAntes − saldoDespués === precio congelado`.
- **CD-14**: los dobles de `budgetService.debit` y `resolveAgentPriceUsdc` capturan y afirman **todos**
  sus argumentos y se tipan con el retorno real.
- **CD-16**: `process.env.ORCHESTRATE_QUOTE_HMAC_KEY` se restaura en `afterEach`, nunca al final del
  cuerpo del test.
- **CD-18**: cada mutante compila (`npx tsc --noEmit` limpio con la mutación puesta) antes de contarlo.
- **CD-20**: los campos opcionales se construyen con spread condicional
  (`...(x !== undefined && { x })`): `exactOptionalPropertyTypes` está activo.
- **CD-21**: correr `npx tsc --noEmit` **completo** (no solo `npm run build`, que excluye los tests)
  antes de dar por cerrada cualquier wave.

### PROHIBIDO

- **CD-1**: agregar tabla Postgres, usar Redis, o guardar estado en memoria del proceso para el quote.
- **CD-3**: debitar cualquier monto cuando el quote expiró, la firma es inválida, el caller no coincide,
  la identidad no coincide o el agente congelado ya no existe. Único resultado permitido: 0 débito +
  error explícito y distinguible.
- **CD-5**: reusar el secreto de otro subsistema (`REQUEST_EIP712_*`, `SIGNED_AUTH_*`,
  `RECEIPT_SIGNING_SECRET`, `SCHEMA_TRANSFORM_HMAC_KEY`) o cualquier fallback/hardcode. Env dedicada:
  `ORCHESTRATE_QUOTE_HMAC_KEY`.
- **CD-9**: tocar el guard `i > 0` de `compose.ts` (fuera del mutante de control, que se restaura y se
  verifica por hash), el `totalCost += agent.priceUsdc` (base del protocol fee) o el settle downstream.
  El freeze cambia **solo** el `debitAmount` del caller.
- **CD-10**: loguear el token, el payload completo o el secreto. §7.6 es la lista cerrada.
- **CD-11**: usar el `oid` del quote como clave de billing, de fee o de idempotencia. El
  `orchestrationId` de ejecución se sigue generando server-side con `crypto.randomUUID()`; reusar el del
  cliente reabre el revenue leak que arregló BLQ-MED-1 de WKH-131.
- **CD-15**: usar `git checkout --`, `git restore`, `git stash`, `git clean` o `git reset` para revertir
  una mutación o cualquier otra cosa.
- **CD-17**: que un test re-implemente el HMAC para compararlo contra sí mismo.
- **CD-19**: modificar `src/routes/compose.ts`, `src/middleware/*`, crear migraciones, agregar
  dependencias npm, o tocar la lista congelada de `src/routes/charged-routes.meta.test.ts`.
- **CD-22**: tocar `doc/sdd/_INDEX.md`, `contracts/.gas-snapshot`, `doc/audit/`, los `doc/jury-qa*.md`,
  `doc/sdd/118-wkh-sec-02b-owner-ref-rpc/`, `doc/sdd/190-wkh-305-compose-field-mapping/`,
  `doc/sdd/190-wkh-306-prepago-agentes-propios/`, `doc/sdd/209-wkh-307-solana-durable-idempotency-ledger/`
  y `doc/solana-labs/`.
- **CD-23**: revertir, reordenar o "limpiar" el cambio sin commitear de **WKH-305** en
  `src/services/compose.ts` y `src/services/compose.test.ts` (§0).

---

## 13. Out of Scope (no tocar bajo ninguna circunstancia)

- `POST /compose` y `POST /orchestrate` (los atómicos): cotizan y debitan en la misma request, no tienen
  la ventana que esta HU cierra. **Ni una línea de `src/routes/compose.ts`.**
- Tabla Postgres o Redis para el quote.
- Single-use / anti-replay dentro de la ventana de 10 minutos (§4).
- Congelar el **input** de los steps: el quote congela identidad y precio; el `input` lo sigue mandando
  el cliente.
- Congelar el gas overhead per-step (`getStepGasOverheadUsd`): es pass-through del gateway, no un precio
  de agente.
- Cambiar la base del protocol fee: sigue siendo `pipeline.totalCostUsdc` (el costo **ejecutado**).
- El rol de `maxQuotedCostUsdc` como techo en el camino **sin** quote.
- Chaski / frontend: mandar y reenviar el campo `quote` es una HU aparte.
- Refactorizar las tres copias de `hex-regex + timingSafeEqual` a un helper común.
- Setear la env en Railway: es acción del founder, post-merge.
- NO "mejorar" código adyacente. NO agregar funcionalidad no listada. NO renombrar nada.

---

## 14. Anti-Hallucination Checklist (marcar antes de dar la HU por terminada)

```
[ ] Corrí Wave -1 completa y el baseline dio 3996 passed | 19 skipped
[ ] Verifiqué el estado de `src/services/compose.ts` con `git status --porcelain` ANTES de W1.3
    y reporté al orquestador si el diff de WKH-305 seguía sin commitear (§0)
[ ] Ubiqué TODOS los puntos de inserción por ancla de contenido, ninguno por número de línea
[ ] Los 3 archivos nuevos los creé yo; los 8 restantes existían y los leí antes de editarlos
[ ] No importé ningún módulo, función o path que no haya verificado que existe
[ ] Cero dependencias npm nuevas; cero migraciones; cero archivos fuera de la tabla de §6
[ ] `orchestrate-quote.ts` no importa supabase, redis, pg ni Fastify (T-Q-U5 lo prueba)
[ ] El HMAC se verifica ANTES de parsear el payload (CD-8)
[ ] Los 6 guards están antes de `executeApprovedPlan` (CD-7)
[ ] La identidad que no coincide se RECHAZA, no se corrige (§3.2)
[ ] TODO test de rechazo afirma saldo idéntico + `debit` no llamado, no solo el status code (§3.3)
[ ] El compromiso de redención múltiple está escrito en el código y en doc/INTEGRATION.md (§4)
[ ] Corrí el mutante de CONTROL PRIMERO y puso rojos tests preexistentes (si no: aborté y reporté)
[ ] Los 22 mutantes compilaron (`npx tsc --noEmit` limpio) antes de contarlos
[ ] Restauré cada mutación por copia + `sha256sum -c: OK`, sin un solo comando git destructivo
[ ] `npx tsc --noEmit` limpio, `npx biome check src/` limpio
[ ] `npm test` = 4029+ passed | 19 skipped | 0 failed
[ ] No toqué `doc/sdd/_INDEX.md` ni ninguno de los archivos protegidos (CD-22)
```

---

## 15. Escalation Rule

**Si algo no está en este Story File, PARÁ y preguntá al orquestador.** No inventar, no asumir, no
improvisar. El Architect resuelve y actualiza el Story File antes de que el Dev continúe.

Situaciones que **obligan** a escalar:

- El diff sin commitear de WKH-305 sigue vivo al arrancar W1.3 (§0).
- Un ancla de contenido de §6 no aparece en el archivo (el archivo cambió).
- El baseline de Wave -1 no da 3996 | 19.
- El mutante de control sobrevive (campaña abortada, §11.1).
- Un mutante de §11.2 sobrevive: es un hallazgo real, se reporta con el test asesino que falló en matarlo.
- Un mutante no compila y no encontrás una variante equivalente que sí compile.
- Un AC te parece ambiguo, o necesitás tocar un archivo fuera de la tabla de §6.
- Cualquier tentación de usar `git checkout/restore/stash/clean/reset`.

---

## 16. Done Definition

1. Los 11 archivos de §6 modificados/creados, ninguno más.
2. `npx tsc --noEmit` limpio (suite completa, no solo `npm run build`).
3. `npx biome check src/` limpio.
4. `npm test` = **4029+ passed | 19 skipped | 0 failed** (baseline 3996 + 33 nuevos).
5. Los 7 ACs con al menos un test que los pone rojos si se rompen (§10.4).
6. Campaña de mutación cerrada: control **primero** y en rojo, 22 mutantes compilados, cada uno con su
   resultado y su `sha256sum -c: OK` de restauración (§11.3).
7. `doc/INTEGRATION.md` documenta el quote, los 5 `error_code`, el TTL, la rotación de la clave y el
   compromiso de redención múltiple.
8. `git status` no muestra ningún archivo tuyo sin intención, ni ninguna mutación olvidada, ni ningún
   cambio revertido de WKH-305.

---

*Story File generado por NexusAgil — F2.5 — Architect*
