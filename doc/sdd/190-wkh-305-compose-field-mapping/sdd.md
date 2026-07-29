# SDD #190 — [WKH-305] Mapeo de un campo puntual entre steps de un pipeline `/compose`

> SPEC_APPROVED: si — 2026-07-28, revision clinica del orquestador (delegada por Fernando).
> Waves W0-W4 con W3 paralela, 9 decisiones tecnicas, 19 restricciones, 7 criterios,
> 22 tests y 12 mutantes con su test asesino. Cero pendientes sin resolver.
> Fecha: 2026-07-28
> Tipo: feature (money-path)
> SDD_MODE: full
> Branch: `feat/305-wkh-305-compose-field-mapping`
> Artefactos: `doc/sdd/190-wkh-305-compose-field-mapping/`
> Work item: [`work-item.md`](work-item.md)

---

## 1. Resumen

Esta HU hace DOS cosas, y la segunda es la más importante de las dos aunque el
título nombre la primera:

1. **El mapeo.** El gateway aprende a poblar un campo del `input` de un step con
   el valor de una clave de primer nivel de la salida del step inmediatamente
   anterior. Es plomería determinística: lookup de clave plana, sin expresiones,
   sin anidamiento, sin transformación (CD-1). Desbloquea el pipeline de remesa
   (`quoteId` nace en el paso de cotización y lo necesita el de desembolso).

2. **El reordenamiento del cobro.** Hoy `composeService.compose` **debita el step
   `i` ANTES de construir su `input`** (`src/services/compose.ts`: bloque de
   débito `if (i > 0 && scopingKeyRow && chainId !== undefined)` ~262-338;
   construcción del `input` ~339-342; `invokeAgent` ~386). O sea que **un step con
   entrada inválida cobra igual**, lo que contradice la instrucción explícita del
   founder ("primero se hacen las validaciones, si no hay errores se pasa al
   cobro") y es la misma clase de defecto que ya se cerró dos veces en el borde
   HTTP (HIGH-2 / HU-193 `validateComposeBodyHandler`, HU-188 BLQ-MEDIO-1) pero
   que sigue abierta DENTRO del loop.

El mapeo sin el reordenamiento sería un cobro por un fallo determinístico que el
gateway podía haber visto venir. El reordenamiento sin el mapeo ya vale por sí
solo: elimina de raíz la familia de fallos "entrada mala del step i", que es
justamente el residuo que WKH-306 tiene que acotar y exponer. Por eso esta HU va
antes que ella, y por eso las dos partes viajan en waves separadas y revisables
por separado (W1 = reorden puro, W2 = semántica del mapeo).

El resultado esperado: un pipeline cuyo mapeo no resuelve **falla antes de cobrar
ese step y antes de invocar a su agente**, con un código estable
(`INPUT_MAPPING_FAILED`), dejando intacto el cobro de los steps 0..i-1 que sí
entregaron valor; y un pipeline sin mapeos declarados que corre **byte-idéntico**
a hoy.

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 190 (WKH-305) |
| **Tipo** | feature — money-path |
| **SDD_MODE** | full |
| **Objetivo** | Que el gateway pueda propagar un campo puntual de la salida del step N-1 al input del step N, y que ningún step cobre antes de que su entrada esté construida y validada. |
| **Reglas de negocio** | El mapeo lo declara el llamador (o el planner), NO el agente. Un mapeo roto nunca genera cobro del step al que pertenece. Sin mapeo declarado, cero cambio de comportamiento. |
| **Scope IN** | Ver §10. |
| **Scope OUT** | Ver §10. |
| **Missing Inputs** | Los 4 `[NEEDS CLARIFICATION]` del work-item quedan RESUELTOS en §11. Cero pendientes de negocio. |

### Acceptance Criteria (EARS) — heredados del work-item

- **AC-1**: WHEN un step declara un mapeo de un campo cuyo nombre existe como
  clave de primer nivel en el objeto de salida del step inmediatamente anterior,
  the system SHALL poblar ese campo en el input del step con el valor leído de esa
  clave, antes de invocar al agente de ese step.

- **AC-2**: IF un step declara un mapeo cuyo campo de origen NO existe en el
  objeto de salida del step inmediatamente anterior (incluye el caso en que esa
  salida no es un objeto plano — p. ej. es un `A2AMessage`, un array, o
  `null`/`undefined`), THEN the system SHALL fallar el pipeline para ese step con
  un error distinguible ANTES de ejecutar el débito per-step de ese step y ANTES
  de invocar a su agente.

- **AC-3**: WHILE resuelve el mapeo de un step, the system SHALL restringir la
  resolución a un lookup de una sola clave de primer nivel por entrada de mapeo
  (sin dot-paths, sin JSONPath, sin expresiones, sin valores por defecto, sin
  acceso a steps distintos del inmediatamente anterior).

- **AC-4**: WHEN un pipeline no declara ningún mapeo de campos en ninguno de sus
  steps, the system SHALL comportarse de forma byte-idéntica al comportamiento
  actual de `passOutput`/`step.input`.

- **AC-5**: IF el mapeo de un step falla (AC-2) y ese step tiene débito per-step
  activo (steps 1..N del path master, `i > 0`), THEN the system SHALL dejar los
  steps 0..i-1 con su cobro intacto y el pipeline SHALL responder con el mismo
  tipo de error que hoy usan los demás fallos de step (`success:false`, `error`,
  sin cobrar el step i).

### ACs derivados (agregados en F2, verificables)

- **AC-6**: WHEN un body de `/compose` declara un mapeo con forma inválida
  (no-objeto, entrada vacía, clave o valor no-string, cardinalidad excedida, clave
  reservada, destino ya presente en `step.input`, o mapeo en el step 0), THEN the
  system SHALL rechazarlo con `400` **antes del middleware de pago**, sin débito y
  sin discovery (mismo punto pre-cobro que `validateComposeStepShape`).

- **AC-7**: WHILE un step con mapeo entra al retry adaptativo (WKH-130), the
  system SHALL re-aplicar el mapeo sobre el `input` regenerado por el LLM ANTES
  del re-débito, de modo que el valor mapeado sea siempre el del step anterior y
  no uno inventado por el modelo.

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos

| Archivo | Por qué | Patrón / hallazgo extraído |
|---------|---------|----------------------------|
| `src/services/compose.ts` (1424 líneas, íntegro el loop 171-805) | Es el archivo del cambio. | Orden real del step: `resolveAgent` → scoping (WKH-61) → `getStepGasOverheadUsd` → budget-check → `stepDestination` → **débito per-step** → **construcción del `input`** → `invokeAgent`. El `input` NO tiene ninguna dependencia con el débito: se calcula sólo de `step.input`, `step.passOutput` y `lastOutput`. Todo el aparato de refund (`refundStepDebit('d1'\|'d2')`), retención HU-203 (`readSettleWithholding`) y retry WKH-130 vive en el `catch` del `invokeAgent`. |
| `src/routes/compose.ts` (1115 líneas) | Dónde vive la validación pre-cobro y el mapeo de `errorCode` → status. | Cadena de preHandlers: `forward-key` → `timeout` → **`validateComposeBodyHandler`** → `resolveComposeCapabilitiesHandler` → `resolveComposePriceHandler` → `requirePaymentOrA2AKey`. `errorCode` `SCOPE_DENIED`→403, `DEST_CAP_EXCEEDED`→402, default **400**. `refundComposeStep0(request, result.totalCostUsdc)` en la rama `!result.success`. |
| `src/lib/compose-step-shape.ts` (176 líneas) | Es el punto pre-cobro donde debe vivir la validación de FORMA del mapeo. | Módulo LEAF (sólo `import type`), devuelve `ComposeStepShapeError \| null`, un error por step con `step: index`. Precedente explícito: **una clave no soportada se RECHAZA, nunca se ignora en silencio** (comentario sobre `constraints.chain`). |
| `src/lib/compose-limits.ts` | Patrón de constante compartida y por qué existe. | Un número que vive en dos lados diverge en silencio → constante en un leaf. Lo copio para el tope de cardinalidad del mapeo. |
| `src/types/index.ts` (405-600) | Contrato de `ComposeStep`, `ResolvedComposeStep`, `ComposeResult`, `StepResult`. | `errorCode?: 'SCOPE_DENIED' \| 'DEST_CAP_EXCEEDED'`; `scopeDeniedTarget` es el precedente de "detalle estructurado del fallo, aparte del mensaje". `ResolvedComposeStep` es un guard de COMPILACIÓN, no azúcar. |
| `src/services/orchestrate.ts` (1100-1500) | Segundo consumidor de `composeService.compose`. | Refund del step-0 por rama: `pipeline.totalCostUsdc === 0` → refund total; `> 0` → `max(0, plannedCostUsd - totalCostUsdc)`. **Un fallo de mapeo en el step i>0 ya queda correctamente contabilizado sin tocar orchestrate.** |
| `src/routes/orchestrate.ts` (295-333) | Si el campo nuevo sobrevive al schema de `/orchestrate/execute`. | El schema de `steps[]` NO declara `additionalProperties: false` → ajv no remueve el campo. O sea: **un caller de `/orchestrate/execute` puede inyectar un mapeo a mano**, y ese camino NO pasa por `validateComposeBodyHandler`. De ahí DT-6 (el resolver del service valida forma él mismo, fail-closed). |
| `src/adapters/chain-resolver.ts:14-21` | Idiom anti-prototype-pollution del repo. | CD-19: `Object.hasOwn()` + `Object.create(null)`. Es el patrón a copiar para leer claves de un objeto que viene de un tercero. |
| `src/routes/charged-routes.meta.test.ts:76-101` | Si el guard estructural de HU-193 me obliga a algo. | `POST /compose` está en `LEGACY_UNVALIDATED` como **deuda de migración**, no como agujero (valida con preHandler propio). Esta HU NO cambia esa lista. |
| `src/routes/compose.no-charge-on-validation-error.test.ts` | Exemplar de test de dinero a nivel ruta. | Middleware REAL + `budgetState.balance` en memoria; `debit` resta y `credit` SUMA. "Todas las aserciones de dinero comparan el balance ANTES y DESPUÉS". |
| `src/services/compose.test.ts` (cabecera + WKH-59 debit) | Exemplar de test de dinero a nivel service. | Mocks de módulo completos (`./budget.js`, `../lib/downstream-payment.js` SIN `importOriginal`). Los asserts existentes miran `mockDebit).toHaveBeenCalledWith(...)`, no el balance → esta HU sube el estándar con un ledger con estado (DT-8). |
| `doc/INTEGRATION.md` §3 (`/compose`), §5, §5.1 | Contrato público de errores y de "qué se te cobra". | §5.1 promete que un rechazo por FORMA no cobra en ninguno de los dos rieles. El mapeo roto entra ahí (forma → 400 pre-cobro) y agrega un caso nuevo mid-pipeline que hay que documentar. |
| `doc/sdd/208-.../auto-blindaje.md`, `doc/sdd/193-.../auto-blindaje.md`, `doc/sdd/190-p1-.../auto-blindaje.md`, `doc/sdd/203-.../auto-blindaje.md` | Aprendizaje histórico obligatorio. | 6 patrones recurrentes → CD-10..CD-15 (§6). |

### 3.2 Exemplars verificados (todos existen; verificados con `ls`/`grep`/`Read`)

| Para crear/modificar | Seguir patrón de | Qué se copia |
|----------------------|------------------|--------------|
| `src/lib/compose-input-mapping.ts` (NUEVO) | `src/lib/compose-step-shape.ts` ✓ · `src/lib/downstream-skip-code.ts` ✓ · `src/lib/compose-limits.ts` ✓ | Módulo LEAF: cero imports de runtime, sólo `import type`. Docstring que explica DÓNDE corre y por qué eso importa. Retorno `X \| null` / unión discriminada, nunca `throw`. |
| Lectura de claves de un objeto de terceros | `src/adapters/chain-resolver.ts:14-21, 239, 326` ✓ | `Object.hasOwn()`; nunca `in`, nunca acceso directo confiando en el prototipo. |
| Constante del tope de cardinalidad | `src/lib/compose-limits.ts:38` (`MAX_COMPOSE_STEPS`) ✓ | Constante exportada desde un leaf + docstring de qué se rompe si la subís. |
| Campo nuevo opcional en `ComposeStep` | `ComposeStep.capability` / `constraints` (`src/types/index.ts:440-465`) ✓ | Opcional + docstring que dice con qué es mutuamente excluyente y qué lo valida. |
| `errorCode` + detalle estructurado en `ComposeResult` | `scopeDeniedTarget` (`src/types/index.ts:558-563`) + su uso en `compose.ts:210-225` ✓ | Código en la unión + objeto de detalle aparte del mensaje, spread condicional por `exactOptionalPropertyTypes`. |
| Validación de forma pre-cobro | `validateComposeStepShape` (`src/lib/compose-step-shape.ts:88-176`) ✓ | Un error por step, `code`, `step: index`; rechazar en vez de ignorar. |
| Test de dinero a nivel ruta | `src/routes/compose.no-charge-on-validation-error.test.ts` ✓ | Middleware real + balance en memoria; `credit` mueve el balance de verdad. |
| Test de dinero a nivel service | `src/services/compose.test.ts:1501+` (WKH-59) ✓ como base de fixtures, **mejorado** con ledger con estado (DT-8) | `makeAgent`/`makeKeyRow`/`mockAgentsBySlug`/`mockFetchOk`. |
| Suite nueva separada por mocks incompatibles | `src/routes/compose.no-debit-on-abort.test.ts` ✓ (docstring "WHY A SEPARATE FILE") | Un archivo aparte cuando el hermano moquea justo lo que hay que observar. |

### 3.3 Estado de BD relevante

| Tabla | Existe | Relevancia |
|-------|--------|-----------|
| — | — | **N/A. Esta HU no toca la base de datos.** Cero migraciones, cero columnas, cero RPC. El único efecto sobre el ledger es *no* llamar a `budgetService.debit` cuando el mapeo falla. |

### 3.4 Componentes reutilizables encontrados (no crear nuevos)

- `budgetService.debit` / `creditWithDest` / `refundIdemKey` / `refundOutbox` — **no se tocan**. El fix es de ORDEN, no de mecanismo.
- `validateComposeBodyHandler` (`src/routes/compose.ts`) — ya corre pre-pago; el check nuevo se cuelga de `validateComposeStepShape`, que ese handler ya invoca por step. **No se agrega un preHandler nuevo.**
- `Object.hasOwn` — ya es el idiom del repo (CD-19).
- `readAgentCategory`, `resolveComposeAgentPoolLimit`, `toPublicSkipCode` — precedentes de "lógica leaf que consumen dos capas". Confirman la decisión de módulo leaf.

### 3.5 Verificación pedida por el work-item sobre los agentes remit-*

`grep` de `remit-corridor-fx` / `quoteId` en `src/` y `doc/`: los tres agentes
(`remit-kyc-validator`, `remit-corridor-fx`, `remit-cashout-payout`) **NO viven en
este repo** (están en `wasiai-remittance-agents`); acá sólo aparecen como fixtures
de test (`src/services/discovery.test.ts:1234`,
`src/services/agent.payment.test.ts:57`). **Consecuencia: esta HU no depende de su
shape y no lo verifica.** El mapeo es agnóstico — los nombres de clave los declara
el llamador. Si `remit-corridor-fx` no expusiera `quoteId` como clave de primer
nivel, eso es un ajuste en ESE repo, fuera de este alcance (y el modo de fallo
sería exactamente el AC-2: error claro, pre-cobro).

---

## 4. Diseño técnico

### 4.1 Archivos a crear / modificar

| # | Archivo | Acción | Qué cambia | Wave | Exemplar |
|---|---------|--------|-----------|------|----------|
| 1 | `src/lib/compose-input-mapping.ts` | **Crear** | Leaf con: constante de cardinalidad, validador de FORMA (puro, por step) y resolvedor del input (`base` + mapeo). Nunca lanza. | W0 | `compose-step-shape.ts`, `downstream-skip-code.ts` |
| 2 | `src/lib/compose-input-mapping.test.ts` | **Crear** | Unit del leaf: forma, lookup, no-traversal, prototype-pollution, no-mutación. | W0 | `compose-step-shape.test.ts` |
| 3 | `src/types/index.ts` | Modificar | `ComposeStep.inputFromPrevious?: Record<string,string>`; `ComposeResult.errorCode` += `'INPUT_MAPPING_FAILED'`; `ComposeResult.inputMappingFailure?`. | W0 | `ComposeStep.capability`, `scopeDeniedTarget` |
| 4 | `src/services/compose.ts` | Modificar | **(W1)** mover la construcción del `input` a ANTES del bloque de débito. **(W2)** reemplazarla por el resolvedor + return de error pre-débito; re-aplicar el mapeo sobre el input regenerado del retry, antes del re-débito. | W1, W2 | el propio bloque `SCOPE_DENIED` (`compose.ts:202-227`) como forma del early-return |
| 5 | `src/lib/compose-step-shape.ts` | Modificar | Delegar al validador de forma del leaf nuevo y traducir su fallo a `ComposeStepShapeError`. Sin duplicar reglas. | W3 | su propio bloque `constraints` |
| 6 | `src/lib/compose-step-shape.test.ts` | Modificar | Casos de forma del mapeo a nivel step. | W3 | el propio archivo |
| 7 | `src/services/compose.field-mapping.test.ts` | **Crear** | Suite de service con **ledger con estado** (balance real): AC-1, AC-2, AC-3, AC-5, AC-7 y las dos direcciones de dinero. | W2 | `compose.test.ts` (fixtures) + `compose.no-charge-on-validation-error.test.ts` (ledger) |
| 8 | `src/routes/compose.field-mapping.test.ts` | **Crear** | Suite de ruta con middleware REAL: forma inválida → 400 **con balance intacto** (AC-6); mapeo roto mid-pipeline → 400 y el step-0 no se sobre-reembolsa (AC-5). | W3 | `compose.no-charge-on-validation-error.test.ts` |
| 9 | `src/services/compose.test.ts` | Modificar (mínimo) | 2 tests de caracterización del reorden (W1) + identidad de referencia del `input` sin mapeo (AC-4). **No se reescribe ningún test existente.** | W1 | el propio archivo |
| 10 | `doc/INTEGRATION.md` | Modificar | §3 `/compose`: el campo nuevo, sus reglas y su error. §5: fila de `INPUT_MAPPING_FAILED`. §5.1: dónde cae en el contrato de cobro. | W4 | el propio bloque `downstreamSettle` |

> No hay ningún otro archivo en Scope IN. En particular: **no** se toca
> `src/routes/orchestrate.ts`, **no** se toca `charged-routes.meta.test.ts`, **no**
> se toca ninguna migración.

### 4.2 Contrato de API — `inputFromPrevious`

```jsonc
// POST /compose
{
  "steps": [
    { "agent": "remit-corridor-fx",     "input": { "corridor": "US-PE", "amountUsd": 400 } },
    { "agent": "remit-cashout-payout",  "input": { "method": "yape" },
      "inputFromPrevious": { "quoteId": "quoteId" } }
  ]
}
```

**Semántica exacta**: `inputFromPrevious[<claveDestino>] = <claveOrigen>`, o sea
`input[claveDestino] = salidaDelStepAnterior[claveOrigen]`. Se lee como una
asignación y deja el destino (lo que el agente ve) del lado de la clave, igual que
un alias de SQL o de GraphQL.

Reglas de FORMA (puras, función del body — **todas verificables antes del cobro**):

| # | Regla | Motivo |
|---|-------|--------|
| S1 | Ausente → no activa ninguna lógica nueva | CD-3 (retrocompatibilidad) |
| S2 | Objeto no nulo y no array | Un array no puede expresar el mapeo |
| S3 | Entre 1 y `MAX_INPUT_MAPPING_ENTRIES` (= **8**) entradas | Cardinalidad acotada (work-item). `{}` se RECHAZA: un mapeo que no mapea nada es un error del llamador, no un no-op (precedente `constraints.chain`) |
| S4 | Toda clave y todo valor: `string` no vacío, ≤ 128 chars | Sin claves generadas ni gigantes |
| S5 | Ni clave ni valor pueden ser `__proto__`, `constructor` ni `prototype` | Anti-prototype-pollution (CD-19) |
| S6 | La clave destino no puede ser `previousOutput` | Reservada por `passOutput`; si no, dos escritores del mismo campo |
| S7 | La clave destino no puede existir ya como clave propia de `step.input` | Un valor que el llamador cree haber puesto y el servidor pisa en silencio es la clase de bug que `compose-step-shape.ts` existe para no cometer |
| S8 | El step de índice 0 no puede declarar mapeo | No hay step anterior. Detectable en el body ⇒ se rechaza pre-cobro |

Reglas de RESOLUCIÓN (dependen de la salida del step anterior — **también
verificables antes del cobro del step `i`**, ver §4.3):

| # | Regla | Fallo |
|---|-------|-------|
| R1 | `base` = `passOutput && lastOutput ? { ...step.input, previousOutput: lastOutput } : step.input` — **idéntico a hoy** | — |
| R2 | Sin mapeo → devuelve `base` **por la misma referencia** (sin copia, sin allocación nueva) | — |
| R3 | Re-valida la forma (S2..S7; S8 lo cubre R4 naturalmente) | `INVALID_MAPPING_SHAPE` |
| R4 | `lastOutput` debe ser objeto plano: no `null`/`undefined`, no array, `typeof === 'object'` | `PREVIOUS_OUTPUT_NOT_OBJECT` |
| R5 | Por cada entrada: `Object.hasOwn(prev, origen)` y `prev[origen] !== undefined` | `SOURCE_FIELD_MISSING` |
| R6 | Éxito → objeto NUEVO `{ ...base, ...mapeados }`. El valor se copia **verbatim** (misma referencia, sin clonar, sin coercionar, sin stringificar) | — |

Notas deliberadas:

- **`null` es un valor presente y se mapea.** La clave existe; el gateway no
  inventa semántica ("null no cuenta") sobre datos de un tercero. El residual —
  un `quoteId: null` que llega al agente y falla pagando — es exactamente el lado
  "requiere ejecutar" de la frontera (§4.3) y es parte del residuo que WKH-306
  acota. Se documenta, no se disimula.
- **`undefined` se trata como ausente.** JSON nunca produce `undefined`; sólo
  puede aparecer si la salida vino de un objeto JS interno. Sin este guard, un
  `hasOwn` verdadero con valor `undefined` mandaría una clave fantasma al agente.
- **Un `.` en la clave de origen es un CARÁCTER, no un separador.** `{"x": "a.b"}`
  contra `{"a": {"b": 1}}` da `SOURCE_FIELD_MISSING`. Esto es AC-3 hecho
  observable: hay un test cuyo único trabajo es probar que NO hay traversal.

### 4.3 LA FRONTERA — qué se valida antes del débito y qué no

Esta sección es el corazón del SDD. La regla:

> **Se mueve antes del cobro todo lo que sea función pura del body y de las
> salidas de los steps ya ejecutados. Se queda después del cobro todo lo que sólo
> se puede saber invocando al agente de este step.**

| Chequeo | ¿De qué depende? | ¿Antes del débito? | Dónde queda |
|---|---|---|---|
| Forma del body / del mapeo (S1..S8) | Sólo del body | **Sí, y antes del middleware de pago** | `validateComposeBodyHandler` → `validateComposeStepShape` (ruta) |
| Existencia del agente / precio / 402 | Body + discovery | Sí (ya hoy) | `resolveComposePriceHandler` |
| Alcance de la credencial (WKH-61) | Credencial + agente resuelto | Sí (ya hoy) | `compose.ts`, scoping check |
| **Construcción del `input` (`passOutput`)** | `step.input`, `lastOutput` | **Sí — ESTO ES LO QUE SE MUEVE (W1)** | `compose.ts`, nuevo punto pre-débito |
| **Resolución del mapeo (R3..R6)** | `step.input`, `lastOutput` | **Sí (W2)** | mismo punto |
| Techo `maxBudget` | Precios acumulados | Sí (ya hoy) | `compose.ts` |
| Gas overhead del step | env + chainId | Sí (ya hoy) | `compose.ts` |
| **Débito per-step** | todo lo anterior | — | `compose.ts` (queda igual, sólo se corre más abajo) |
| ¿El agente acepta el input? (4xx de campos) | **Ejecutar** | **No** | `catch` → refund WKH-128/129 + retry WKH-130 |
| ¿El agente devuelve 2xx? | **Ejecutar** | **No** | idem |
| ¿El settle downstream salió? | **Ejecutar** | **No** | HU-203 retención (`readSettleWithholding`) |
| ¿El valor mapeado era semánticamente correcto? (`quoteId` vencido, `null`, de otro corredor) | **Ejecutar** | **No** | residuo declarado → WKH-306 |

Lo que hace que el movimiento sea **seguro y mecánico**, y no un rediseño: entre
el bloque de débito y la construcción del `input` **no hay ninguna dependencia de
datos ni de efectos**. El `input` se calcula con `step.input`, `step.passOutput` y
`lastOutput`; el bloque de débito sólo lee `agent.priceUsdc`/`stepGasOverhead` y
escribe `stepDebitedUsd` + el ledger. Ninguno lee lo que el otro escribe. Es una
conmutación de dos bloques independientes, verificable leyendo 80 líneas.

Dos cosas que **NO se mueven**, a propósito:

1. **`const startTime = Date.now()`** se queda donde está (después del débito,
   justo antes del `invokeAgent`). Mover el `input` arriba no debe cambiar qué
   mide `latencyMs`. Si `startTime` subiera, la latencia de todos los steps
   pasaría a incluir el débito — un cambio silencioso de métrica en el money-path.
2. **El guard `i > 0`** del bloque de débito. Es la única defensa contra el doble
   débito del step 0 (CD-11 de WKH-59, comentado en el propio archivo). El
   reordenamiento no lo toca ni lo mueve de bloque.

Punto exacto de inserción: **inmediatamente después del bloque de scoping check
(WKH-61) y antes de `const stepGasOverhead = ...`**. Por qué ahí y no pegado al
débito:

- La autorización (scoping) sigue siendo lo PRIMERO: nada se evalúa para un
  agente que la credencial no puede invocar.
- Un fallo de mapeo es determinístico y no depende del precio, del gas ni del
  presupuesto. Fallar ahí da el error más claro y evita un lookup de gas
  (`getStepGasOverheadUsd`, que en mainnet sin configurar **lanza**
  `GasOverheadUnavailableError`) para un step que no puede correr igual.
- Para un pipeline SIN mapeo el punto es irrelevante (nada falla) ⇒ no compromete
  AC-4.

### 4.4 El reordenamiento, en concreto (W1)

**Antes** (orden actual dentro del `for`, por contenido — los números de línea se
mueven, ver CD-14):

```
resolveAgent → scoping(WKH-61) → stepGasOverhead → maxBudget → stepDestination
  → [BLOQUE DÉBITO i>0]  ← cobra
  → const input = step.passOutput && lastOutput ? {...} : step.input
  → startTime → invokeAgent
```

**Después**:

```
resolveAgent → scoping(WKH-61)
  → const input = resolveStepInput(step, lastOutput)   ← W1 mueve; W2 le da semántica
  →   [si falla → return error INPUT_MAPPING_FAILED, SIN débito, SIN invoke]
  → stepGasOverhead → maxBudget → stepDestination
  → [BLOQUE DÉBITO i>0]  ← cobra, ya con la entrada construida y validada
  → startTime → invokeAgent
```

El early-return copia byte a byte la forma de los otros returns de error del loop
(`success:false, output:null, steps: results, totalCostUsdc, totalLatencyMs,
error, errorCode`), que es lo que hace que AC-5 salga gratis: `results` y
`totalCost` ya llevan lo cobrado y entregado por los steps 0..i-1, y el route
`refundComposeStep0(request, result.totalCostUsdc)` reembolsa sólo lo que no se
gastó. Verificado también aguas arriba: `orchestrate.ts` (rama
`pipeline.totalCostUsdc > 0` → `max(0, plannedCostUsd - totalCostUsdc)`) trata
este fallo igual que cualquier otro fallo de step **sin cambio alguno**.

### 4.5 Código de error y detalle estructurado

```ts
// src/types/index.ts — ComposeResult
errorCode?: 'SCOPE_DENIED' | 'DEST_CAP_EXCEEDED' | 'INPUT_MAPPING_FAILED';
inputMappingFailure?: {
  step: number;
  reason: 'INVALID_MAPPING_SHAPE' | 'PREVIOUS_OUTPUT_NOT_OBJECT' | 'SOURCE_FIELD_MISSING';
  field?: string;   // clave destino
  source?: string;  // clave origen
};
```

- **HTTP: 400**, por el `default` que ya existe en `routes/compose.ts`. **No se
  agrega una rama de status nueva**: un mapeo roto es un error de contrato del
  llamador, la misma familia que el 400 de shape. `SCOPE_DENIED`(403) y
  `DEST_CAP_EXCEEDED`(402) siguen intactos.
- En `/orchestrate*` el fallo viaja como cualquier otro fallo de step
  (`pipeline.success:false`, HTTP 200 legacy). `routes/orchestrate.ts` sólo
  discrimina `SCOPE_DENIED`; **no requiere cambios**.
- `inputMappingFailure` es el paralelo exacto de `scopeDeniedTarget`: detalle
  accionable sin obligar a parsear el `error` en texto. El mensaje de texto
  también nombra step, campo y origen.
- **No filtra nada sensible**: los nombres de clave son los que el propio llamador
  declaró en su body.

### 4.6 Interacción con el retry adaptativo (WKH-130) — AC-7

El retry hace: parsear field-errors → refund `d1` → `regenerateInputFromErrors(input, …)`
(LLM Haiku) → **re-débito `stepDebitedUsd`** → re-invoke.

Decisión: **después de regenerar y ANTES del re-débito, se re-aplica el mapeo
sobre `newInput`.**

- Por qué: `regenerateInputFromErrors` recibe el `input` que YA tenía el campo
  mapeado; el LLM puede borrarlo, renombrarlo o inventarle un valor. Que un modelo
  decida el `quoteId` de una remesa es inaceptable, y además haría que el caller
  pague un retry destinado a fallar.
- La re-aplicación **no puede fallar si la primera aplicación tuvo éxito**:
  `lastOutput` es el mismo objeto (el step i falló, no avanzó el pipeline) y las
  claves son las mismas ⇒ es total por construcción. No introduce una rama de
  fallo nueva antes del re-débito. Igual, el resolvedor devuelve unión
  discriminada y el código trata el `ok:false` como "no reintentar" (fail-closed,
  sin re-débito), que satisface CD-2 aunque sea inalcanzable.
- Sin mapeo declarado, la re-aplicación devuelve `newInput` **por la misma
  referencia** ⇒ el camino WKH-130 de hoy es byte-idéntico (CD-3).

### 4.7 Interacción con `passOutput`, el bridge A2A y `maybeTransform`

- **`inputFromPrevious` y `passOutput:true` COEXISTEN** (confirmando la
  recomendación del work-item). Son cosas distintas: `passOutput` inyecta el
  objeto entero bajo `previousOutput`; el mapeo puebla campos de primer nivel. La
  regla S6 impide que se pisen.
- **El mapeo lee `lastOutput` DESPUÉS del bridge** (A2A passthrough / unwrap /
  `maybeTransform`), o sea exactamente el mismo objeto que `passOutput` habría
  inyectado. Un solo concepto de "la salida del step anterior". Consecuencia
  documentada: si el bridge LLM reescribió el shape, el mapeo ve el shape
  reescrito. Es la única opción coherente — leer el pre-bridge sería un segundo
  concepto de "salida anterior", que es la clase de error que el repo evita
  (dos definiciones de la misma cosa).
- Si la salida es un `A2AMessage` y el mapeo apunta a `quoteId`, el lookup falla
  con `SOURCE_FIELD_MISSING` (el `A2AMessage` es un objeto plano con `kind`/`parts`),
  o con `PREVIOUS_OUTPUT_NOT_OBJECT` si el bridge la dejó en un array/primitivo.
  **Los dos casos de AC-2 quedan cubiertos sin ramas especiales**: no se
  re-implementa `isA2AMessage` en el resolvedor.
- El fast-path WKH-56 y `maybeTransform` **no se tocan**.

### 4.8 Flujo principal (happy path)

1. `POST /compose` con 2 steps; el step 1 declara `inputFromPrevious: {"quoteId":"quoteId"}`.
2. `validateComposeBodyHandler` valida forma (incluye el mapeo) → OK, aún sin cobrar.
3. Precio del step-0 → débito del step-0 por el middleware (o 402 x402).
4. Step 0: resuelve, cobra (middleware), invoca, `lastOutput = {quoteId:"q-1", rate: 3.72}` (post-bridge).
5. Step 1: resuelve agente → scoping OK → **resuelve el input**: `{ method:"yape", quoteId:"q-1" }`
   → gas/budget → **débito per-step** → `invokeAgent` con ese input.
6. `200` con `steps[]` de los dos y `totalCostUsdc` = suma de precios.

### 4.9 Flujos de error

| Caso | Dónde corta | Respuesta | Dinero |
|---|---|---|---|
| Forma del mapeo inválida (S2..S8) | `validateComposeBodyHandler` (pre-pago) | `400 VALIDATION_ERROR` + `step` | **Cero cobro** (ni step-0) |
| Mapeo en el step 0 (S8) | idem | `400 VALIDATION_ERROR`, `step: 0` | **Cero cobro** |
| Salida anterior no es objeto plano | `compose.ts` pre-débito del step i | `400` + `errorCode:'INPUT_MAPPING_FAILED'`, `reason:'PREVIOUS_OUTPUT_NOT_OBJECT'` | Steps 0..i-1 cobrados; **step i NO** |
| Clave de origen ausente | idem | `400` + `reason:'SOURCE_FIELD_MISSING'` con `field`/`source` | idem |
| Forma inválida por `/orchestrate/execute` (no pasó por la ruta de compose) | `compose.ts` pre-débito | `pipeline.success:false`, `reason:'INVALID_MAPPING_SHAPE'` | idem |
| Mapeo OK pero el agente rechaza el valor | `invokeAgent` (post-débito) | comportamiento de HOY (refund `d1` → retry → refund `d2` / retención HU-203) | **sin cambios** |

---

## 5. Decisiones técnicas (DT)

- **DT-1 (heredada del work-item, ratificada).** Mapea el **gateway**, no los
  agentes. Un agente que lee `previousOutput.quoteId` codifica dentro de sí que es
  "el paso 3 de un pipeline de remesa" y deja de ser consumible solo. Además hay
  precedente arquitectónico: el gateway ya media entre steps (A2A fast-path
  WKH-56, transform WKH-14/57). El mapeo es esa misma responsabilidad, en su
  versión determinística y sin LLM.

- **DT-2.** Nombre del campo: **`inputFromPrevious`**. Se elige sobre
  `inputMapping` porque **el alcance queda dentro del nombre**: "from previous" no
  admite leerse como "de cualquier step", así que CD-4 queda expresada en la API y
  no sólo en el docstring. Dirección `destino → origen` (`{"quoteId":"quoteId"}` se
  lee `input.quoteId = anterior.quoteId`).

- **DT-3.** El mapeo se modela como `Record<string,string>` plano y **acotado a 8
  entradas**. Sin arrays de pares (más ceremonia, cero expresividad extra), sin
  objetos anidados (sería la puerta a las rutas). El tope vive como constante en
  el leaf, con el patrón de `MAX_COMPOSE_STEPS`.

- **DT-4 (la del riesgo).** **La construcción del `input` se mueve antes del
  débito para TODOS los steps**, no sólo para los que declaran mapeo. Se descartó
  la alternativa "sólo se adelanta si el step declara mapeo" porque dejaría el
  archivo con DOS órdenes de operaciones según un flag del body: nadie que lea el
  loop después sabría cuál rige, y las HUs siguientes tendrían que razonar sobre
  las dos. Un solo orden, siempre. El costo de esa elección es que el diff toca el
  camino de todos los callers ⇒ se paga con W1 aislada, caracterización de
  balance y regresión completa de la suite.

- **DT-5.** El resolvedor **no recibe `results` ni el índice del step**, sólo
  `(step, lastOutput)`. Así **CD-4 la hace cumplir la firma**, no la disciplina:
  leer `results[i-2]` es imposible sin cambiar el tipo (mismo espíritu que
  `ResolvedComposeStep`, que hace de la resolución tardía un error de
  compilación).

- **DT-6.** **La forma se valida en DOS lugares con UNA sola definición.**
  `validateComposeStepShape` (ruta, pre-pago, 400 lindo) y el propio resolvedor
  (service, fail-closed). Hace falta el segundo porque el schema de
  `POST /orchestrate/execute` (`routes/orchestrate.ts:309-322`) **no declara
  `additionalProperties:false`**, así que un caller puede inyectar un
  `inputFromPrevious` malformado que nunca pasa por `validateComposeBodyHandler`.
  Las reglas viven en **una** función exportada del leaf; los dos call-sites la
  llaman. (Precedente: `validateComposeBody` se usa en el preHandler y otra vez en
  el handler como defense-in-depth, con la misma función pura.)

- **DT-7.** Módulo **LEAF** obligatorio (`src/lib/compose-input-mapping.ts`), cero
  imports de runtime. Motivo documentado en el repo tres veces: media docena de
  suites moquean `downstream-payment.js` / `budget.js` / `a2a-key.ts` completos
  con factories sin `importOriginal`; una función nueva importada desde un módulo
  gordo llega `undefined` bajo test y rompe decenas de suites (rompió 84 en el
  fix-pack P1, y 21 en HU-193). Un archivo sin dependencias no lo moquea nadie.

- **DT-8.** Los tests de dinero de esta HU usan un **ledger con estado** (el mock
  de `budgetService.debit` resta de un balance en memoria y `creditWithDest`
  suma), no `toHaveBeenCalledWith`. Es el estándar que ya usa
  `compose.no-charge-on-validation-error.test.ts` y el que hizo aparecer el bug de
  HU-208 W2. Un assert de "se llamó a debit" no distingue "cobró y devolvió" de
  "cobró y se lo quedó".

- **DT-9.** El valor mapeado **es dato de un tercero** (la auditoría
  `doc/security/audit-ecosystem-2026-07-01.md:374` ya analizó `previousOutput`
  como tal). El mapeo lo asciende de un bolso rotulado `previousOutput` a un campo
  de primer nivel con nombre autoritativo. Por eso: se copia verbatim, **nunca se
  parsea, ni se coerciona, ni se usa para NINGUNA decisión del gateway** (precio,
  destino, cap, chain, ruteo). Sólo viaja en el body hacia el agente. Esto es
  CD-9.

---

## 6. Constraint Directives

### 6.1 Heredadas del work-item (siguen vigentes, sin cambios)

- **CD-1 (PROHIBIDO)**: ninguna forma de expresión, función, dot-path anidado,
  JSONPath ni valor por defecto dentro de una entrada de mapeo. Es
  EXCLUSIVAMENTE un lookup de clave de primer nivel. Cualquier propuesta de
  sintaxis extra vuelve a F1/founder.
- **CD-2 (OBLIGATORIO)**: resolver y validar el mapeo ANTES del débito per-step y
  ANTES de `invokeAgent`. Un mapeo roto NUNCA genera cobro del step al que
  pertenece — ni el débito normal, ni el re-débito del retry.
- **CD-3 (OBLIGATORIO)**: un pipeline SIN mapeos es byte-idéntico (mismo
  `ComposeResult`, mismo costo, mismos hooks de refund). El campo es opcional y su
  ausencia no activa ninguna rama nueva.
- **CD-4 (PROHIBIDO)**: leer de un step distinto del inmediatamente anterior (sin
  `results[i-2]` ni anteriores).

### 6.2 Nuevas de este SDD

- **CD-5 (PROHIBIDO)**: mutar `step.input` o `lastOutput`. El resolvedor devuelve
  un objeto nuevo o la MISMA referencia de entrada; jamás escribe sobre lo que
  recibe (precedente CD-15 de WKH-56, "anti-mutation").
- **CD-6 (OBLIGATORIO)**: leer claves del objeto anterior con `Object.hasOwn`,
  nunca con `in` ni con acceso directo; rechazar `__proto__`/`constructor`/
  `prototype` como clave y como valor (CD-19 de `chain-resolver.ts`).
- **CD-7 (PROHIBIDO)**: mover, duplicar o gatear el guard `i > 0` del bloque de
  débito. Es la única defensa contra el doble débito del step 0. Si el diff lo
  toca, es BLOQUEANTE en AR.
- **CD-8 (PROHIBIDO)**: mover `const startTime = Date.now()`. La latencia del step
  no puede empezar a incluir el débito.
- **CD-9 (PROHIBIDO)**: usar el valor mapeado para cualquier decisión del gateway
  (precio, destino, cap por destino, chain, ruteo, idempotencia). Sólo viaja en el
  body hacia el agente (DT-9).
- **CD-10 (OBLIGATORIO)**: toda la lógica nueva vive en un módulo LEAF sin imports
  de runtime (DT-7). PROHIBIDO agregar un import nuevo a `services/compose.ts` que
  no sea ese leaf.
- **CD-11 (PROHIBIDO)**: agregar una rama de status HTTP nueva. `INPUT_MAPPING_FAILED`
  cae en el `default` 400 que ya existe.

### 6.3 Derivadas del Auto-Blindaje histórico (patrones recurrentes — obligatorias)

- **CD-12: PROHIBIDO afirmar que un guard está protegido por su cobertura de
  línea.** Cada guard nuevo se verifica **mutando primero** y comprobando que un
  test se pone rojo. — recurrente en `190-p1-guards-sin-proteccion/auto-blindaje.md#Wave 1`
  y `193-.../auto-blindaje.md` (Mutación).
- **CD-13: PROHIBIDO un test de dinero que sólo mire el status code o el spy.**
  Todo AC de dinero se prueba comparando el **balance antes vs. después**. — el
  bug de refund de HU-208 apareció exactamente por esto
  (`208-.../auto-blindaje.md#Wave 2`), y `190-p1-.../auto-blindaje.md#Wave 2` lo
  repite ("asertar el efecto observable (plata movida), no que la promesa
  resolvió").
- **CD-14: PROHIBIDO escribir un test o un comentario contra un `archivo:línea`
  heredado sin releer el archivo.** Los punteros de este SDD son
  archivo + **contenido ancla**; si al implementar no coinciden, se reporta. —
  `190-p1-.../auto-blindaje.md#Wave 1` (punteros stale del AR).
- **CD-15: OBLIGATORIO que todo mutante COMPILE antes de contarlo.** Un mutante
  que rompe el parseo produce "no tests"/"FAIL archivo" y es un falso KILLED. —
  documentado en `193-...` y en `190-p1-...` (dos HUs distintas, mismo error).
- **CD-16: PROHIBIDO `git checkout --` sobre archivos con cambios sin commitear**
  durante la verificación por mutación. Se commitea el fix, se muta, se restaura.
  — `193-.../auto-blindaje.md` y `203-.../auto-blindaje.md` (dos veces, casi
  perdiendo trabajo).
- **CD-17: OBLIGATORIO correr `npx tsc --noEmit` completo (incluye tests), no sólo
  `npm run build`** (que usa `tsconfig.build.json` y excluye los tests). — lección
  de WKH-196.
- **CD-18: OBLIGATORIO que un claim de "no agrega costo" se pruebe asertando el
  I/O** (cantidad de llamadas), no sólo el efecto observable. — `208-.../auto-blindaje.md#Wave 3`
  (mutación M5 sobrevivió). Aplica al claim de AC-4/CD-3.

---

## 7. Waves de implementación

### W0 — Serial gate: contrato + leaf puro (sin cambio de comportamiento)

| # | Tarea | Archivos |
|---|-------|----------|
| W0.1 | Leaf `compose-input-mapping.ts`: constante de cardinalidad, `validateInputMappingShape(step, index)`, `resolveStepInput(step, lastOutput)` (unión discriminada), tipos de fallo. Nunca lanza, cero imports de runtime. | `src/lib/compose-input-mapping.ts` |
| W0.2 | Tipos: `ComposeStep.inputFromPrevious`, `ComposeResult.errorCode` += `INPUT_MAPPING_FAILED`, `ComposeResult.inputMappingFailure`. | `src/types/index.ts` |
| W0.3 | Unit del leaf (forma + resolución + no-traversal + no-mutación + prototype-pollution). | `src/lib/compose-input-mapping.test.ts` |

**Gate de salida**: `npx tsc --noEmit` verde y suite completa verde. Nadie llama
todavía al leaf ⇒ **cero cambio de comportamiento observable**.

### W1 — El reordenamiento del débito (aislado, sin semántica de mapeo)

| # | Tarea | Archivos |
|---|-------|----------|
| W1.1 | Mover la construcción del `input` (`passOutput`) desde después del bloque de débito a **inmediatamente después del scoping check**. Sin tocar el guard `i>0`, ni `startTime`, ni el bloque de débito en sí. | `src/services/compose.ts` |
| W1.2 | Tests de caracterización con ledger: happy path cobra EXACTAMENTE lo mismo; fallo post-invoke reembolsa EXACTAMENTE lo mismo; `input` sin `passOutput` sigue siendo la MISMA referencia que `step.input`. | `src/services/compose.test.ts` |

**Gate de salida**: **la suite completa del repo verde sin editar un solo test
existente.** Si algún test existente hay que tocar, el reorden dejó de ser
mecánico ⇒ parar y reportar (es la señal de que había una dependencia oculta).
Este es el commit que el AR revisa como cambio de riesgo, solo.

### W2 — Semántica del mapeo en el service (depende de W0 + W1)

| # | Tarea | Archivos |
|---|-------|----------|
| W2.1 | Reemplazar la expresión del `input` por `resolveStepInput(...)` + early-return de error (`INPUT_MAPPING_FAILED` + `inputMappingFailure`), en el punto pre-débito de W1.1. | `src/services/compose.ts` |
| W2.2 | Re-aplicar el mapeo sobre el input regenerado del retry, ANTES del re-débito (AC-7); `ok:false` ⇒ no re-debitar. | `src/services/compose.ts` |
| W2.3 | Suite nueva de service con ledger con estado: AC-1, AC-2 (4 variantes), AC-3, AC-5, AC-7 y las dos direcciones de dinero. | `src/services/compose.field-mapping.test.ts` |

### W3 — Validación de forma pre-cobro en el borde (depende de W0; **paralelizable con W1/W2**)

| # | Tarea | Archivos |
|---|-------|----------|
| W3.1 | `validateComposeStepShape` delega en `validateInputMappingShape` y traduce el fallo a `ComposeStepShapeError` (`code:'VALIDATION_ERROR'`, `step`). Sin duplicar reglas. | `src/lib/compose-step-shape.ts` |
| W3.2 | Casos de forma en el unit existente. | `src/lib/compose-step-shape.test.ts` |
| W3.3 | Suite de ruta con middleware REAL: forma inválida → 400 **con balance intacto**; mapeo roto mid-pipeline → 400 sin sobre-reembolso del step-0. | `src/routes/compose.field-mapping.test.ts` |

> W3 sólo depende de los tipos y del leaf (W0). Puede correr en paralelo con
> W1/W2 y toca archivos disjuntos de W1/W2 salvo `types/index.ts` (ya cerrado en W0).

### W4 — Documentación + verificación final (depende de todo)

| # | Tarea | Archivos |
|---|-------|----------|
| W4.1 | `doc/INTEGRATION.md`: §3 `/compose` (campo, reglas, ejemplo), §5 (fila de error), §5.1 (dónde cae en el contrato de cobro). | `doc/INTEGRATION.md` |
| W4.2 | Verificación por mutación (§8.3) + `npx tsc --noEmit` + `npm run lint` + `npm test` completo + cobertura de las líneas nuevas. | — |
| W4.3 | `auto-blindaje.md` de la HU. | `doc/sdd/190-wkh-305-compose-field-mapping/auto-blindaje.md` |

### Dependencias

| Tarea | Depende de | Razón |
|---|---|---|
| W1 | W0.2 | Nada (el reorden no usa el leaf), pero comparte archivo de tipos ⇒ W0 primero evita un rebase tonto. |
| W2 | W0 + W1 | Usa el leaf y el punto de inserción que creó W1. |
| W3 | W0 | Sólo necesita el validador de forma y el tipo. |
| W4 | W1+W2+W3 | Documenta el comportamiento final. |

---

## 8. Plan de tests

Framework: **vitest** (`npm test`). Nomenclatura: `T-MAP-NN`.

### 8.1 Cobertura por AC (al menos un test por AC; los de dinero miran el BALANCE)

| Test | AC | Nivel | Qué afirma |
|---|---|---|---|
| `T-MAP-01` | AC-1 | service | 2 steps, `inputFromPrevious:{quoteId:'quoteId'}`, salida previa `{quoteId:'q-1'}` → **el body enviado al agente del step 1 contiene `quoteId:'q-1'`** (se lee de los args de `mockFetch`), y el step corre normal. |
| `T-MAP-02` | AC-1 / CD-5 | service | El mismo caso: `step.input` original NO fue mutado (sigue sin `quoteId`) y `lastOutput` tampoco. |
| `T-MAP-03` | AC-2 | service | Clave ausente en la salida previa → `success:false`, `errorCode:'INPUT_MAPPING_FAILED'`, `reason:'SOURCE_FIELD_MISSING'`, **`mockFetch` NO se llamó para el step i**. |
| `T-MAP-04` | AC-2 | service | Salida previa `null` → `PREVIOUS_OUTPUT_NOT_OBJECT`. |
| `T-MAP-05` | AC-2 | service | Salida previa array → `PREVIOUS_OUTPUT_NOT_OBJECT`. |
| `T-MAP-06` | AC-2 | service | Salida previa `A2AMessage` (`{kind:'message',parts:[…]}`) → falla con código estable (no explota, no invoca). |
| `T-MAP-07` | **AC-2 / CD-2 · DINERO** | service | 3 steps, mapeo roto en el step 2: **balance final = balance inicial − precio(step 1)**. El step 2 no movió un centavo; el step 1 sí (y no se le hizo refund). |
| `T-MAP-08` | **AC-5 · DINERO** | service | Mismo escenario: `result.steps.length === 2`, `totalCostUsdc === p0 + p1`, **cero llamadas a `creditWithDest`** (no hay reembolso indebido de los steps buenos). |
| `T-MAP-09` | AC-3 | leaf | `{"x":"a.b"}` contra `{a:{b:1}}` → `SOURCE_FIELD_MISSING` (**no hay traversal**). |
| `T-MAP-10` | AC-3 / CD-6 | leaf | `__proto__`, `constructor`, `prototype` como clave y como valor → rechazados; el objeto resultante nunca contamina el prototipo. |
| `T-MAP-11` | AC-3 | leaf | 9 entradas → rechazado por cardinalidad; 8 → aceptado. Valor no-string / vacío / >128 → rechazado. |
| `T-MAP-12` | AC-4 / CD-3 | service | Pipeline sin mapeo y sin `passOutput`: el objeto pasado a `invokeAgent` es **`toBe(step.input)`** (misma referencia ⇒ ni copia ni allocación nueva). |
| `T-MAP-13` | **AC-4 · DINERO (la otra dirección)** | service | Pipeline sin mapeo, 3 steps, todos OK: **el balance se mueve EXACTAMENTE igual que antes del cambio** (delta = p1 + p2, con el mismo destino canónico y el mismo `chainId`). El camino bueno sigue cobrando igual. |
| `T-MAP-14` | AC-4 / CD-18 | service | Un pipeline sin mapeo hace **la misma cantidad de llamadas a `budgetService.debit`** que hoy (assert de I/O, no sólo de efecto). |
| `T-MAP-15` | AC-6 | ruta | `POST /compose` con `inputFromPrevious` malformado → **400 y `balance` intacto** (middleware real). |
| `T-MAP-16` | AC-6 (S8) | ruta | Mapeo declarado en el step 0 → 400 pre-cobro, balance intacto. |
| `T-MAP-17` | AC-6 (S7) | ruta | Destino que ya existe en `step.input` → 400 pre-cobro (el valor del llamador nunca se descarta en silencio). |
| `T-MAP-18` | **AC-5 · DINERO (ruta)** | ruta | Mapeo roto en el step 1 con `composeService` real-ish: 400, el débito del step-0 **NO** se reembolsa de más (`refundComposeStep0` con `alreadySpent = totalCostUsdc`). |
| `T-MAP-19` | AC-7 | service | Retry: el LLM devuelve un input **sin** el campo mapeado → el re-invoke lo lleva igual (valor del step anterior, no del modelo). |
| `T-MAP-20` | **AC-7 / CD-2 · DINERO** | service | Retry con mapeo: exactamente 1 débito activo en todo momento; si el retry falla, el balance vuelve al valor previo al step (refund `d2` intacto). |
| `T-MAP-21` | DT-6 | service | Un `inputFromPrevious` malformado que **no** pasó por la ruta (entrada tipo `/orchestrate/execute`) → falla pre-débito con `INVALID_MAPPING_SHAPE`, sin cobrar. |
| `T-MAP-22` | AC-4 | service | `passOutput:true` + mapeo → el input trae `previousOutput` **y** el campo mapeado (coexistencia, §4.7). |

### 8.2 Regresión obligatoria

- Suite completa (`npm test`) verde **sin editar ningún test existente** (gate de W1).
- Foco explícito de re-lectura: `compose.test.ts` (WKH-56 bridge, WKH-59 debit,
  WKH-61 scoping, WKH-125 dest-cap, WKH-128/129 refund, WKH-130 retry, HU-203
  retención, WKH-234 ledger Solana), `compose.no-charge-on-validation-error.test.ts`,
  `compose.no-debit-on-abort.test.ts`, `compose.capability.test.ts`,
  `charged-routes.meta.test.ts`, `orchestrate*.test.ts`.

### 8.3 Verificación por mutación (obligatoria, CD-12/CD-15/CD-16)

Cada mutante debe **compilar** y matar al menos un test nombrado:

| # | Mutante | Debe matar |
|---|---|---|
| M1 | Devolver la construcción del `input` a su lugar original (después del débito) | T-MAP-07, T-MAP-18 |
| M2 | El resolvedor devuelve `ok:true` con el campo faltante en vez de fallar | T-MAP-03, T-MAP-07 |
| M3 | `Object.hasOwn` → `in` | T-MAP-10 |
| M4 | La clave de origen se parte por `.` (traversal) | T-MAP-09 |
| M5 | El resolvedor muta `step.input` en vez de copiar | T-MAP-02, T-MAP-12 |
| M6 | Sin re-aplicación del mapeo en el retry | T-MAP-19 |
| M7 | Quitar S7 (destino colisiona con `step.input`) | T-MAP-17 |
| M8 | Quitar S8 (mapeo en el step 0) | T-MAP-16 |
| M9 | El validador de forma sale del resolvedor (sólo queda en la ruta) | T-MAP-21 |
| M10 | El early-return de mapeo deja de propagar `steps: results` / `totalCostUsdc` | T-MAP-08, T-MAP-18 |
| M11 | Quitar el guard `i > 0` del débito (CD-7) | tests preexistentes de doble-débito del step 0 |
| M12 | `startTime` movido arriba del débito (CD-8) | ver nota |

> Nota M12: si ningún test se pone rojo, **hay que escribir uno** que congele que
> `latencyMs` no incluye el débito (inyectando latencia en el mock de `debit`,
> como hace `compose.no-charge-on-validation-error.test.ts` con `debitLatencyMs`).
> Es exactamente el caso CD-12: mutar primero, y recién ahí diseñar el test.

### 8.4 Cobertura

Reportar cobertura de `src/lib/compose-input-mapping.ts` (objetivo 100% de líneas
y ramas; es puro y no tiene excusa) y de las líneas nuevas de
`src/services/compose.ts`. Declarar explícitamente toda línea sin hits y por qué
(precedente HU-193 §"Cobertura de las líneas nuevas").

---

## 9. Riesgos y coordinación de merge

| # | Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|---|
| R1 | El reorden rompe una dependencia oculta en el loop más denso del repo | Baja | **Alto** (money-path) | W1 aislada en su propio commit; gate = suite completa verde **sin tocar tests**; análisis de independencia de datos en §4.3; mutante M1. |
| R2 | Conflicto de rebase en `services/compose.ts` | **Alta** | Medio | Orden de merge de §9.1; el diff de W1 es una conmutación de bloques (fácil de re-aplicar); W2 agrega ~15 líneas en un punto único. |
| R3 | Alguien "extiende" el mapeo con dot-paths más adelante | Media | Alto (superficie de ataque) | CD-1 + T-MAP-09 (test cuyo único trabajo es probar que no hay traversal) + el nombre `inputFromPrevious`. |
| R4 | El campo nuevo llega por `/orchestrate/execute` sin pasar por la validación de la ruta | Media | Medio | DT-6: el resolvedor valida forma él mismo, fail-closed, pre-débito (T-MAP-21). |
| R5 | Prototype pollution vía clave de mapeo | Baja | Alto | CD-6 + S5 + T-MAP-10. |
| R6 | Un test nuevo "verde por la razón equivocada" | Media | Alto | CD-12/CD-13: mutación obligatoria y balance en vez de spies. |
| R7 | Regresión de latencia/telemetría por mover `startTime` | Baja | Medio | CD-8 + mutante M12. |

### 9.1 Orden de merge propuesto

Estado verificado al escribir este SDD: `main` limpio (sólo untracked de `doc/`),
último commit sobre `src/services/compose.ts` = `c52591a` (HU-208), o sea que
**todos los fix-packs P1 (filas 188/189/190) y HU-203/HU-194 ya están en `main`**.
No hay ninguna rama en vuelo tocando el bloque de débito per-step.

1. **WKH-305 sale de `main` HOY y merge PRIMERO** entre las HUs del batch que
   tocan `compose.ts`. Es la única que reordena el bloque de débito: cuanto más
   tiempo viva fuera, más caro el rebase.
2. **WKH-306 (prepago / residuo) merge DESPUÉS.** Su Scope IN threadea un id de
   run en los `eventService.track` de `compose.ts` — mismo archivo, y su
   inventario de residuo **cambia** con esta HU (toda la familia "entrada mala"
   deja de ser residuo). Si se invirtiera el orden, WKH-306 documentaría un
   residuo que ya no existe.
3. **WKH-303 (quote-freeze) es ORTOGONAL** — su Scope IN es
   `routes/orchestrate.ts` + un leaf nuevo + env. Puede correr en paralelo, sin
   ordenamiento.
4. **WKH-307 (idempotencia durable Solana) es ORTOGONAL** (`adapters/solana/*` +
   migración).
5. **Regla de desempate**: si aparece un fix-pack de dinero que toque el bloque de
   débito (`i > 0 && scopingKeyRow && chainId !== undefined`) mientras WKH-305
   está en vuelo, **ese fix-pack merge primero y WKH-305 rebasa** — un fix de
   dinero no espera a una feature, y nuestro diff es mecánico de re-aplicar.
6. Antes de arrancar W1: `git log --oneline -3 -- src/services/compose.ts` y
   confirmar que el `HEAD` sigue siendo el que dice este SDD. Si cambió, releer el
   bloque (CD-14).

---

## 10. Scope

**IN**

- `src/lib/compose-input-mapping.ts` (+ su test) — leaf nuevo: forma + resolución.
- `src/types/index.ts` — `ComposeStep.inputFromPrevious`, `ComposeResult.errorCode`
  (+1 miembro), `ComposeResult.inputMappingFailure`.
- `src/services/compose.ts` — reorden del `input` a pre-débito + resolución del
  mapeo + re-aplicación en el retry.
- `src/lib/compose-step-shape.ts` (+ su test) — validación de forma pre-cobro.
- `src/services/compose.field-mapping.test.ts` y
  `src/routes/compose.field-mapping.test.ts` — suites nuevas con dinero real
  (ledger con estado).
- `src/services/compose.test.ts` — 3 tests de caracterización agregados (ninguno
  reescrito).
- `doc/INTEGRATION.md` — contrato público del campo y del error.

**OUT**

- Expresiones, JSONPath, dot-notation, templates, transformaciones, defaults (CD-1).
- Mapeo desde steps anteriores al inmediato (CD-4).
- Enseñarle al planner de `/orchestrate` a GENERAR mapeos (HU aparte).
- Congelamiento de precio / price-drift (WKH-303).
- `passOutput` + A2A fast-path + `maybeTransform` (WKH-56/14/57): intactos.
- Cambios al schema JSON de `/orchestrate/execute` (cubierto por DT-6).
- Migración de `POST /compose` al componente `chargedRoute` (deuda de HU-193; esta
  HU **no** toca `LEGACY_UNVALIDATED`).
- UI/dashboard. Base de datos. Cambios en `budgetService`.

---

## 11. Missing Inputs — resueltos en F2

| # | Pregunta del work-item | Resolución |
|---|---|---|
| 1 | Shape exacto del campo de mapeo | **`inputFromPrevious?: Record<string,string>`**, destino→origen, 1..8 entradas, claves y valores string ≤128 (DT-2/DT-3, §4.2). |
| 2 | Nombre del `errorCode` de AC-2 | **`INPUT_MAPPING_FAILED`**, con detalle estructurado `inputMappingFailure` (`reason` ∈ `INVALID_MAPPING_SHAPE` / `PREVIOUS_OUTPUT_NOT_OBJECT` / `SOURCE_FIELD_MISSING`). HTTP 400 por el `default` existente (§4.5). |
| 3 | ¿Coexiste con `passOutput:true`? | **Sí.** Son mecanismos distintos y complementarios; la regla S6 (destino ≠ `previousOutput`) impide que se pisen (§4.7, T-MAP-22). |
| 4 | ¿El mapeo aplica al input regenerado por el retry? | **Sí, y se re-aplica ANTES del re-débito** (AC-7 / §4.6). No introduce una rama de fallo nueva: la re-aplicación es total si la primera tuvo éxito. |
| 5 | Bloqueantes de negocio | **Ninguno.** La orientación gateway-side ya estaba decidida por el founder. |

**Uncertainty markers**: ninguno. Cero `[NEEDS CLARIFICATION]`, cero `[TBD]`.

---

## 12. Readiness Check

```
READINESS CHECK — SDD #190 (WKH-305)
[x] Cada AC (1..7) tiene al menos 1 archivo en §4.1 y al menos 1 test en §8.1
[x] Cada archivo de §4.1 tiene exemplar VERIFICADO (ls/grep/Read) — §3.2
[x] Cero [NEEDS CLARIFICATION] y cero [TBD] — §11
[x] Constraint Directives: 4 heredadas + 7 nuevas + 7 de auto-blindaje (>3 PROHIBIDO)
[x] Context Map: 13 archivos leídos, con hallazgo por archivo — §3.1
[x] Scope IN/OUT explícitos y no ambiguos — §10
[x] BD: N/A declarado y justificado — §3.3
[x] Happy path completo — §4.8
[x] Flujos de error: 6 casos con su efecto sobre el dinero — §4.9
[x] Waves con W0 serial y una wave paralelizable (W3) — §7
[x] El cambio de riesgo (reorden) está aislado en su propia wave con gate propio
[x] Tests de dinero miran el BALANCE, en las dos direcciones (T-MAP-07 / T-MAP-13)
[x] Plan de mutación con 12 mutantes y su test esperado — §8.3
[x] Orden de merge propuesto y verificado contra el estado real de main — §9.1
[x] Auto-Blindaje histórico leído (208/193/190-P1/203) y convertido en CD-12..CD-18
```

**Estado: LISTO PARA SPEC_APPROVED.**

---

*SDD generado por NexusAgil — FULL · Architect (F2)*
