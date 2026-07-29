# Story File — #190 · WKH-305: Mapeo de un campo puntual entre steps de `/compose`

> SDD: `doc/sdd/190-wkh-305-compose-field-mapping/sdd.md` (SPEC_APPROVED)
> Work item: `doc/sdd/190-wkh-305-compose-field-mapping/work-item.md`
> Fecha: 2026-07-28
> Branch: `feat/305-wkh-305-compose-field-mapping`
> Baseline de la suite ANTES de tocar nada: **3996 passed | 19 skipped**

---

## 0. Cómo se lee este documento

Este archivo es el contrato completo. **No leas el SDD ni el work-item**: todo lo
que necesitás está acá. Si algo no está acá, **PARÁ y escalá al Architect** — no
lo inventes, no lo deduzcas del código, no lo resuelvas "como parezca razonable".

Hay dos cosas en esta HU y la segunda es la peligrosa:

1. **El mapeo** — el gateway aprende a poblar un campo del `input` del step `i`
   con el valor de una clave de primer nivel de la salida del step `i-1`.
   Plomería determinística, sin expresiones, sin anidamiento.
2. **El reordenamiento del cobro** — hoy `composeService.compose` **debita el
   step `i` ANTES de construir su `input`**. O sea que un step con entrada
   inválida cobra igual. Eso se invierte. Es el hot path de dinero más denso del
   repo y por eso viaja **en su propia wave, en su propio commit, con su propio
   gate** (§4).

---

## 1. Goal

Que un pipeline de `/compose` pueda declarar `inputFromPrevious: {"quoteId": "quoteId"}`
en un step y que el gateway propague ese campo desde la salida del step anterior
**antes de cobrar ese step y antes de invocar a su agente**; y que ningún step
del pipeline vuelva a cobrarse antes de que su entrada esté construida y
validada. Un pipeline que no declara mapeos tiene que correr **byte-idéntico** a
hoy: mismo `ComposeResult`, mismo costo, mismos hooks de refund.

Caso real que lo motiva: la remesa identidad → cotización → desembolso. El
`quoteId` nace en el paso de cotización y lo necesita el de desembolso; el
llamador no puede mandarlo por adelantado porque todavía no existe. Y el agente
de desembolso **no** puede aprender a leer `previousOutput.quoteId`, porque eso
lo convertiría en "el paso 3 de un pipeline de remesa" y dejaría de ser
invocable solo.

---

## 2. Acceptance Criteria (EARS) — los que QA verifica en F4

- **AC-1**: WHEN un step declara un mapeo de un campo cuyo nombre existe como
  clave de primer nivel en el objeto de salida del step inmediatamente anterior,
  the system SHALL poblar ese campo en el input del step con el valor leído de
  esa clave, antes de invocar al agente de ese step.

- **AC-2**: IF un step declara un mapeo cuyo campo de origen NO existe en la
  salida del step inmediatamente anterior (incluye el caso en que esa salida no
  es un objeto plano — un `A2AMessage`, un array, `null`/`undefined`), THEN the
  system SHALL fallar el pipeline para ese step con un error distinguible ANTES
  de ejecutar el débito per-step de ese step y ANTES de invocar a su agente.

- **AC-3**: WHILE resuelve el mapeo de un step, the system SHALL restringir la
  resolución a un lookup de una sola clave de primer nivel por entrada de mapeo
  (sin dot-paths, sin JSONPath, sin expresiones, sin valores por defecto, sin
  acceso a steps distintos del inmediatamente anterior).

- **AC-4**: WHEN un pipeline no declara ningún mapeo de campos en ninguno de sus
  steps, the system SHALL comportarse de forma byte-idéntica al comportamiento
  actual de `passOutput`/`step.input`.

- **AC-5**: IF el mapeo de un step falla (AC-2) y ese step tiene débito per-step
  activo (`i > 0` del path master), THEN the system SHALL dejar los steps
  `0..i-1` con su cobro intacto y el pipeline SHALL responder con el mismo tipo
  de error que hoy usan los demás fallos de step (`success:false`, `error`, sin
  cobrar el step `i`).

- **AC-6**: WHEN un body de `/compose` declara un mapeo con forma inválida
  (no-objeto, vacío, clave o valor no-string, cardinalidad excedida, clave
  reservada, destino ya presente en `step.input`, o mapeo en el step 0), THEN the
  system SHALL rechazarlo con `400` **antes del middleware de pago**, sin débito
  y sin discovery.

- **AC-7**: WHILE un step con mapeo entra al retry adaptativo (WKH-130), the
  system SHALL re-aplicar el mapeo sobre el `input` regenerado por el LLM ANTES
  del re-débito, de modo que el valor mapeado sea siempre el del step anterior y
  no uno inventado por el modelo.

---

## 3. LA FRONTERA — la regla que gobierna todo el reordenamiento

No es una lista de casos. Es **una regla**, y tenés que poder aplicarla vos a
cualquier chequeo que se te cruce:

> **Se mueve ANTES del cobro todo lo que sea función pura del cuerpo del pedido
> y de las salidas de los steps ya producidas. Se queda DESPUÉS del cobro todo
> lo que sólo se puede saber invocando al agente de ese step.**

Aplicada:

| Chequeo | ¿De qué depende? | ¿Antes del débito? |
|---|---|---|
| Forma del body / del mapeo (S1..S8) | Sólo del body | Sí — y además antes del middleware de pago |
| Existencia del agente / precio / 402 | Body + discovery | Sí (ya hoy) |
| Alcance de la credencial (WKH-61 scoping) | Credencial + agente resuelto | Sí (ya hoy) |
| **Construcción del `input` (`passOutput`)** | `step.input`, `lastOutput` | **Sí — ESTO ES LO QUE SE MUEVE (W1)** |
| **Resolución del mapeo (R3..R6)** | `step.input`, `lastOutput` | **Sí (W2)** |
| Techo `maxBudget` | Precios acumulados | Sí (ya hoy) |
| Gas overhead del step | env + chainId | Sí (ya hoy) |
| ¿El agente acepta el input? (4xx de campos) | **Ejecutar** | No |
| ¿El agente devuelve 2xx? | **Ejecutar** | No |
| ¿El settle downstream salió? | **Ejecutar** | No (HU-203) |
| ¿El valor mapeado era semánticamente correcto? (`quoteId` vencido, `null`, de otro corredor) | **Ejecutar** | No — residuo declarado, es de WKH-306 |

**Por qué el movimiento es mecánico y no un rediseño**: entre el bloque de
débito y la construcción del `input` no hay ninguna dependencia de datos ni de
efectos. El `input` se calcula sólo con `step.input`, `step.passOutput` y
`lastOutput`; el bloque de débito sólo lee `agent.priceUsdc` / `stepGasOverhead`
y escribe `stepDebitedUsd` + el ledger. Ninguno de los dos lee lo que el otro
escribe. Es una conmutación de dos bloques independientes.

### 3.1 Las DOS excepciones que NO se mueven

Son excepciones explícitas a la regla de arriba. Si el diff las toca, es
BLOQUEANTE en AR:

1. **`const startTime = Date.now()`** (hoy `src/services/compose.ts:343`) **se
   queda donde está**, después del débito y justo antes del `invokeAgent`. Si
   subiera junto con el `input`, la latencia de **todos** los steps pasaría a
   incluir el tiempo del débito: un cambio silencioso de métrica en el
   money-path. No es "más preciso", es otra métrica con el mismo nombre.

2. **El guard `i > 0`** del bloque de débito (hoy
   `if (i > 0 && scopingKeyRow && chainId !== undefined)`, `compose.ts:274`) **no
   se mueve, no se duplica, no se gatea con nada nuevo**. Es la única defensa
   contra el doble débito del step 0 (el step 0 ya lo debitó el middleware vía
   `request.composeEstimatedCostUsd`). Está comentado como tal en el propio
   archivo (`compose.ts:250-253`, "CD-11 ... NO REMOVER").

### 3.2 El punto de inserción EXACTO

El `input` se construye **inmediatamente después del bloque de scoping check
(WKH-61) y antes de `const stepGasOverhead = ...`**.

Anclas de contenido (los números de línea se van a mover mientras editás; usá el
contenido, no el número — ver CD-14):

- Ancla superior: la llave que cierra el `if (scopingKeyRow) { ... }` del scoping
  check, el que devuelve `errorCode: 'SCOPE_DENIED'`. Hoy termina en
  `compose.ts:227`.
- Ancla inferior: el comentario `// Gas pass-through (audit 2026-06-25): per-step
  gateway gas overhead...` seguido de `const stepGasOverhead =`. Hoy
  `compose.ts:228-234`.

**Por qué ahí y no pegado al bloque de débito:**

- **La autorización va primero, siempre.** Nada se evalúa para un agente que la
  credencial no puede invocar. El scoping check queda intocable arriba de todo.
- Un fallo de mapeo es determinístico y no depende del precio, del gas ni del
  presupuesto. Fallar ahí da el error más claro y **evita un lookup de gas** para
  un step que no puede correr igual — y ese lookup no es gratis:
  `getStepGasOverheadUsd` en mainnet sin configurar **lanza**
  `GasOverheadUnavailableError`, o sea que un mapeo roto podría reportarse como
  un error de gas.
- Para un pipeline SIN mapeo el punto es irrelevante (nada falla ahí), así que no
  compromete AC-4.

---

## 4. ⛔ EL GATE DE W1 — leelo dos veces

**Esta es la regla más importante de todo el archivo. No es una recomendación, no
es una buena práctica, no es "si podés". Es la condición de salida de W1.**

W1 mueve la construcción del `input` de después del débito a antes del débito,
**sin agregar ninguna semántica de mapeo**. Ese cambio va en **un commit propio,
solo, sin nada más adentro**. El AR lo revisa aislado.

**Condición de salida de W1, literal:**

> `npm test` — **la suite COMPLETA del repo en verde, con el baseline intacto
> (3996 passed | 19 skipped), SIN haber editado UN SOLO test existente.**

Y la regla de parada:

> **Si para poner la suite en verde tenés que tocar, ajustar, relajar, re-ordenar
> o "actualizar" un test que ya existía: PARÁ. No lo edites. No lo skipees. No
> lo arregles. Reportá al orquestador y esperá.**
>
> Que un test existente se ponga rojo **no es un test desactualizado**. Es la
> prueba de que había una dependencia oculta entre la construcción del `input` y
> el bloque de débito, y por lo tanto **el movimiento no era mecánico** y la
> premisa entera de esta wave (§3, "conmutación de dos bloques independientes")
> es falsa. En ese escenario el diseño tiene que volver al Architect, no
> resolverse editando la evidencia que lo contradice.

Los únicos tests que se **agregan** en W1 son los de caracterización de W1.2
(§7.2), y son **agregados**, no modificados: `compose.test.ts` gana casos nuevos
al final, ningún `it()` preexistente cambia una línea.

Checklist de auto-verificación del commit de W1, antes de seguir a W2:

```
[ ] git diff --stat del commit W1 toca EXACTAMENTE 2 archivos:
    src/services/compose.ts  y  src/services/compose.test.ts
[ ] En compose.test.ts el diff es SÓLO adiciones (+), cero líneas borradas (-)
    dentro de un it() preexistente
[ ] El diff de compose.ts NO contiene la cadena "startTime"
[ ] El diff de compose.ts NO contiene la cadena "i > 0"
[ ] npm test → 3996 + los nuevos, passed; 19 skipped; 0 failed
[ ] npx tsc --noEmit → limpio
```

---

## 5. El contrato del campo — `inputFromPrevious`

```jsonc
// POST /compose
{
  "steps": [
    { "agent": "remit-corridor-fx",    "input": { "corridor": "US-PE", "amountUsd": 400 } },
    { "agent": "remit-cashout-payout", "input": { "method": "yape" },
      "inputFromPrevious": { "quoteId": "quoteId" } }
  ]
}
```

**Semántica**: `inputFromPrevious[<claveDestino>] = <claveOrigen>`, o sea
`input[claveDestino] = salidaDelStepAnterior[claveOrigen]`. Se lee como una
asignación: el destino (lo que el agente ve) está del lado de la clave, igual que
un alias de SQL o de GraphQL.

**El nombre del campo es `inputFromPrevious` y no otro.** "from previous" no
admite leerse como "de cualquier step": el alcance queda dentro del nombre.

### 5.1 Reglas de FORMA (S1..S8) — función pura del body, todas pre-cobro

| # | Regla | Motivo |
|---|-------|--------|
| S1 | Ausente → no activa ninguna lógica nueva | Retrocompatibilidad (CD-3) |
| S2 | Debe ser objeto no nulo y **no** array | Un array no puede expresar el mapeo |
| S3 | Entre **1** y **`MAX_INPUT_MAPPING_ENTRIES` (= 8)** entradas. **`{}` se RECHAZA** | Cardinalidad acotada. Un mapeo que no mapea nada es un error del llamador, no un no-op (mismo criterio que `constraints.chain` en `compose-step-shape.ts:144-151`) |
| S4 | Toda clave y todo valor: `string` no vacío, **≤ 128 chars** | Sin claves generadas ni gigantes |
| S5 | Ni clave ni valor pueden ser `__proto__`, `constructor` ni `prototype` | Anti prototype-pollution |
| S6 | La clave destino no puede ser `previousOutput` | Reservada por `passOutput`; si no, dos escritores del mismo campo |
| S7 | La clave destino **no puede existir ya** como clave propia de `step.input` | Un valor que el llamador cree haber puesto y el servidor pisa en silencio es exactamente la clase de bug que `compose-step-shape.ts` existe para no cometer |
| S8 | El step de índice **0** no puede declarar mapeo | No hay step anterior; es detectable en el body ⇒ se rechaza pre-cobro |

### 5.2 Reglas de RESOLUCIÓN (R1..R6) — dependen de la salida anterior, también pre-cobro

| # | Regla | Fallo (`reason`) |
|---|-------|------------------|
| R1 | `base` = `step.passOutput && lastOutput ? { ...step.input, previousOutput: lastOutput } : step.input` — **idéntico a hoy, carácter por carácter** | — |
| R2 | Sin mapeo declarado → devuelve `base` **por la MISMA referencia** (sin copia, sin allocación nueva) | — |
| R3 | Re-valida la forma (S2..S7) | `INVALID_MAPPING_SHAPE` |
| R4 | `lastOutput` debe ser objeto plano: no `null`/`undefined`, no array, `typeof === 'object'` | `PREVIOUS_OUTPUT_NOT_OBJECT` |
| R5 | Por cada entrada: `Object.hasOwn(prev, origen)` **y** `prev[origen] !== undefined` | `SOURCE_FIELD_MISSING` |
| R6 | Éxito → objeto **NUEVO** `{ ...base, ...mapeados }`. El valor se copia **verbatim**: misma referencia, sin clonar, sin coercionar, sin stringificar | — |

Tres notas que no son opcionales:

- **`null` es un valor presente y SE MAPEA.** La clave existe; el gateway no
  inventa la semántica "null no cuenta" sobre datos de un tercero. El residual
  (un `quoteId: null` que llega al agente y falla pagando) es el lado "requiere
  ejecutar" de la frontera y es residuo declarado de WKH-306. Se documenta, no se
  disimula.
- **`undefined` se trata como AUSENTE.** JSON nunca produce `undefined`; sólo
  puede aparecer si la salida vino de un objeto JS interno. Sin este guard, un
  `hasOwn` verdadero con valor `undefined` mandaría una clave fantasma al agente.
- **Un `.` en la clave de origen es un CARÁCTER, no un separador.** `{"x":"a.b"}`
  contra `{a:{b:1}}` da `SOURCE_FIELD_MISSING`. Hay un test (T-MAP-09) cuyo único
  trabajo en la vida es probar que **no hay traversal**.

### 5.3 Error público

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

- **HTTP 400**, por el `default` que YA existe en `src/routes/compose.ts:1009-1014`
  (`let status = 400; if SCOPE_DENIED → 403; else if DEST_CAP_EXCEEDED → 402`).
  **PROHIBIDO agregar una rama de status nueva.**
- `inputMappingFailure` es el paralelo exacto de `scopeDeniedTarget`: detalle
  accionable sin obligar a parsear el `error` en texto. El texto del `error`
  también nombra step, campo y origen.
- No filtra nada sensible: los nombres de clave son los que el propio llamador
  declaró en su body.
- En `/orchestrate*` viaja como cualquier otro fallo de step
  (`pipeline.success:false`). **`src/routes/orchestrate.ts` NO se toca.**

### 5.4 Coexistencia con `passOutput`

`inputFromPrevious` y `passOutput: true` **coexisten**. Son cosas distintas:
`passOutput` inyecta el objeto entero bajo `previousOutput`; el mapeo puebla
campos de primer nivel. S6 impide que se pisen.

El mapeo lee `lastOutput` **después** del bridge (A2A passthrough / unwrap /
`maybeTransform`), o sea exactamente el mismo objeto que `passOutput` habría
inyectado. Un solo concepto de "la salida del step anterior". Si el bridge LLM
reescribió el shape, el mapeo ve el shape reescrito. **El fast-path WKH-56 y
`maybeTransform` no se tocan.**

Si la salida es un `A2AMessage` y el mapeo apunta a `quoteId`: falla con
`SOURCE_FIELD_MISSING` (el `A2AMessage` es un objeto plano con `kind`/`parts`), o
con `PREVIOUS_OUTPUT_NOT_OBJECT` si el bridge la dejó en un array/primitivo. **No
re-implementes `isA2AMessage` en el resolvedor**: los dos casos de AC-2 quedan
cubiertos sin ramas especiales.

---

## 6. Constraint Directives — vinculantes

### 6.1 De alcance y semántica

- **CD-1 (PROHIBIDO)**: ninguna forma de expresión, función, dot-path anidado,
  JSONPath ni valor por defecto dentro de una entrada de mapeo. Es
  EXCLUSIVAMENTE un lookup de clave de primer nivel. Si te parece que hace falta
  más, **PARÁ y escalá** — no lo extiendas.
- **CD-2 (OBLIGATORIO)**: resolver y validar el mapeo ANTES del débito per-step y
  ANTES de `invokeAgent`. Un mapeo roto NUNCA genera cobro del step al que
  pertenece — ni el débito normal, ni el re-débito del retry.
- **CD-3 (OBLIGATORIO)**: un pipeline SIN mapeos es byte-idéntico (mismo
  `ComposeResult`, mismo costo, mismos hooks de refund). El campo es opcional y su
  ausencia no activa ninguna rama nueva.
- **CD-4 (PROHIBIDO)**: leer de un step distinto del inmediatamente anterior. Sin
  `results[i-2]`, sin nada anterior.
- **CD-5 (PROHIBIDO)**: mutar `step.input` o `lastOutput`. El resolvedor devuelve
  un objeto nuevo o la MISMA referencia de entrada; jamás escribe sobre lo que
  recibe.
- **CD-6 (OBLIGATORIO)**: leer claves del objeto anterior con `Object.hasOwn`,
  nunca con `in` ni con acceso directo. Rechazar `__proto__`/`constructor`/
  `prototype` como clave **y** como valor. Patrón del repo:
  `src/adapters/chain-resolver.ts:14-21`.
- **CD-9 (PROHIBIDO)**: usar el valor mapeado para **cualquier** decisión del
  gateway (precio, destino, cap por destino, chain, ruteo, idempotencia). Sólo
  viaja en el body hacia el agente. Es dato de un tercero: el mapeo lo asciende
  de un bolso rotulado `previousOutput` a un campo de primer nivel con nombre
  autoritativo, y esa promoción no le da autoridad.
- **CD-10 (OBLIGATORIO)**: toda la lógica nueva vive en un módulo **LEAF** sin
  imports de runtime. **PROHIBIDO agregar a `src/services/compose.ts` un import
  nuevo que no sea ese leaf.** Motivo real y documentado: media docena de suites
  moquean `downstream-payment.js` / `budget.js` / `a2a-key.ts` completos con
  factories sin `importOriginal`; una función importada desde un módulo gordo
  llega `undefined` bajo test y rompe decenas de suites (rompió 84 en el fix-pack
  P1 y 21 en HU-193). Un archivo sin dependencias no lo moquea nadie.
- **CD-11 (PROHIBIDO)**: agregar una rama de status HTTP nueva.

### 6.2 Las dos intocables del reordenamiento

- **CD-7 (PROHIBIDO)**: mover, duplicar o gatear el guard `i > 0` del bloque de
  débito. Si el diff lo toca, es BLOQUEANTE en AR.
- **CD-8 (PROHIBIDO)**: mover `const startTime = Date.now()`.

### 6.3 De método — derivadas del Auto-Blindaje histórico

Estas salieron de errores que este equipo ya cometió, cada una en ≥2 HUs
distintas. No son teoría.

- **CD-12 (PROHIBIDO)** afirmar que un guard está protegido porque su línea tiene
  cobertura. Cada guard nuevo se verifica **mutando primero** y comprobando que
  un test se pone rojo. (Recurrente en `190-p1-guards-sin-proteccion` y `193`.)
- **CD-13 (PROHIBIDO)** un test de dinero que sólo mire el status code o el spy.
  Todo AC de dinero se prueba comparando el **balance antes vs. después**. (El
  bug de refund de HU-208 apareció exactamente por esto.)
- **CD-14 (PROHIBIDO)** escribir un test o un comentario contra un
  `archivo:línea` heredado sin releer el archivo. Los punteros de este Story File
  son archivo + **contenido ancla**; si al implementar no coinciden, **reportalo**.
- **CD-15 (OBLIGATORIO)**: **todo mutante tiene que COMPILAR antes de contarlo.**
  Un mutante que rompe el parseo produce "no tests" / "FAIL archivo" y es un
  **falso KILLED**: pone todo rojo y no prueba nada. Verificá `npx tsc --noEmit`
  con el mutante aplicado antes de correr la suite. (Documentado en dos HUs
  distintas con el mismo error.)
- **CD-16 (PROHIBIDO)** `git checkout --` sobre archivos con cambios sin
  commitear durante la verificación por mutación. Se **commitea** el fix, se
  muta, se restaura. (Casi se pierde trabajo dos veces.)
- **CD-17 (OBLIGATORIO)** correr `npx tsc --noEmit` **completo** (incluye los
  tests), no sólo `npm run build` — que usa `tsconfig.build.json` y **excluye**
  los tests. (Lección de WKH-196.)
- **CD-18 (OBLIGATORIO)** que un claim de "no agrega costo" se pruebe asertando
  el **I/O** (cantidad de llamadas), no sólo el efecto observable.

---

## 7. Waves

```
W0 ──┬── W1 ──── W2 ──┬── W4
     └── W3 ───────────┘
```

| Wave | Depende de | ¿Paralelizable? | Qué es |
|------|-----------|-----------------|--------|
| **W0** | — | No. **Serial gate.** | Contrato + leaf puro. Nadie lo llama todavía. |
| **W1** | W0 | No. Va sola, **commit propio**. | El reordenamiento del débito, sin semántica de mapeo. |
| **W2** | W0 + W1 | No | Semántica del mapeo en el service + retry. |
| **W3** | W0 | **SÍ — corre en paralelo con W1/W2** | Validación de forma pre-cobro en el borde HTTP. Toca archivos disjuntos de W1/W2. |
| **W4** | W1 + W2 + W3 | No | Docs + verificación final. |

> W3 sólo necesita el leaf y los tipos (W0). Sus archivos
> (`compose-step-shape.ts`, `compose-step-shape.test.ts`,
> `routes/compose.field-mapping.test.ts`) no se cruzan con los de W1/W2
> (`services/compose.ts`, `services/compose.test.ts`,
> `services/compose.field-mapping.test.ts`). `types/index.ts` ya quedó cerrado en
> W0, así que no hay archivo compartido en vuelo.

---

### W0 — Contrato + leaf puro (serial gate, cero cambio de comportamiento)

#### W0.1 — `src/lib/compose-input-mapping.ts` · **CREAR**

Módulo **LEAF**: **cero imports de runtime**, sólo `import type`. Nunca lanza:
devuelve `null` o una unión discriminada. Exemplar a seguir:
`src/lib/compose-step-shape.ts` (docstring que explica DÓNDE corre y por qué eso
importa) y `src/lib/compose-limits.ts` (constante con docstring de qué se rompe
si la subís).

Superficie pública exacta:

```ts
/** Tope de entradas por mapeo. Subirlo agranda la superficie de un body hostil. */
export const MAX_INPUT_MAPPING_ENTRIES = 8;
/** Largo máximo de una clave (destino u origen). */
export const MAX_INPUT_MAPPING_KEY_LEN = 128;

/** Problema de FORMA, sin índice de step (lo agrega el caller). */
export type MappingShapeProblem = {
  /** Texto sin prefijo de step, p. ej. "'inputFromPrevious' must be an object". */
  detail: string;
  /** Clave destino que disparó el problema, si aplica. */
  field?: string;
};

/**
 * Reglas S2..S7 sobre un `inputFromPrevious` crudo + el `input` del step.
 * `undefined` (S1) → `null` (forma válida: no declara mapeo).
 * ÚNICA definición de las reglas de forma. La llaman los DOS call-sites.
 */
export function checkMappingShape(
  mapping: unknown,
  stepInput: unknown,
): MappingShapeProblem | null;

/**
 * Envoltorio para el borde HTTP: agrega S8 (mapeo en el step 0) y el prefijo
 * `Step N:` al mensaje. Lo consume `lib/compose-step-shape.ts`.
 */
export function validateInputMappingShape(
  step: unknown,
  stepIndex: number,
): { message: string; field?: string } | null;

export type InputMappingFailure = {
  reason:
    | 'INVALID_MAPPING_SHAPE'
    | 'PREVIOUS_OUTPUT_NOT_OBJECT'
    | 'SOURCE_FIELD_MISSING';
  /** Mensaje para el caller, sin prefijo de step. */
  message: string;
  field?: string;
  source?: string;
};

export type StepInputResolution =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; failure: InputMappingFailure };

/** Lo mínimo que el resolvedor necesita ver de un step. */
type MappableStep = {
  input: Record<string, unknown>;
  passOutput?: boolean | undefined;
  inputFromPrevious?: Record<string, string> | undefined;
};

/**
 * R1 (base) + R2..R6 (mapeo). Es la función que llama el happy-path del loop.
 *
 * ⚠️ NO recibe `results` ni el índice del step, A PROPÓSITO: así CD-4 la hace
 * cumplir la FIRMA y no la disciplina. Leer `results[i-2]` es imposible sin
 * cambiar este tipo. (Mismo espíritu que `ResolvedComposeStep`, que convierte la
 * resolución tardía en un error de compilación.)
 */
export function resolveStepInput(
  step: MappableStep,
  lastOutput: unknown,
): StepInputResolution;

/**
 * R2..R6 sobre una base ARBITRARIA. Existe para el retry adaptativo (AC-7), que
 * necesita re-aplicar el mapeo sobre el input regenerado por el LLM y no sobre
 * `step.input`. `resolveStepInput` = calcular la base (R1) + llamar a ésta.
 *
 * Sin mapeo declarado devuelve `base` POR LA MISMA REFERENCIA (R2).
 */
export function applyMappingTo(
  base: Record<string, unknown>,
  mapping: Record<string, string> | undefined,
  lastOutput: unknown,
): StepInputResolution;
```

Notas de implementación no negociables:

- R1 tiene que ser **carácter por carácter** la expresión de hoy
  (`compose.ts:339-342`):
  `step.passOutput && lastOutput ? { ...step.input, previousOutput: lastOutput } : step.input`.
  No la "mejores", no cambies el truthiness de `lastOutput` por un
  `!= null`, no le agregues un `?? {}`.
- Lectura de claves del objeto anterior: **`Object.hasOwn(prev, source)`**. Nunca
  `in`, nunca acceso directo.
- El objeto de destino de los mapeados se construye sobre `Object.create(null)` o
  bien se filtran las claves prohibidas antes del spread — de las dos formas, un
  `__proto__` como clave nunca puede llegar al `{ ...base, ...mapeados }`.
- El orden de chequeo importa para el `reason`: primero forma (R3), después
  `lastOutput` (R4), después cada entrada (R5).

#### W0.2 — `src/types/index.ts` · **MODIFICAR**

1. `ComposeStep` (hoy en `src/types/index.ts`, la interfaz que ya tiene `agent?`,
   `capability?`, `constraints?`, `registry?`, `input`, `passOutput?`,
   `acceptanceCriteria?`): agregar

```ts
  /**
   * WKH-305: mapeo de campos puntuales desde la salida del step INMEDIATAMENTE
   * anterior hacia el input de este step. `{ claveDestino: claveOrigen }`, o sea
   * `input[destino] = salidaAnterior[origen]`.
   *
   * Lookup de UNA clave de primer nivel por entrada: sin dot-paths, sin
   * expresiones, sin defaults, sin acceso a steps anteriores al inmediato. Lo
   * valida `lib/compose-input-mapping.ts` en DOS puntos, los dos pre-cobro:
   * `validateComposeStepShape` (borde HTTP) y `resolveStepInput` (service).
   *
   * Coexiste con `passOutput` (que inyecta el objeto entero bajo
   * `previousOutput`); la clave destino `previousOutput` está prohibida para que
   * no haya dos escritores del mismo campo.
   */
  inputFromPrevious?: Record<string, string>;
```

2. `ComposeResult.errorCode`: agregar el miembro
   `| 'INPUT_MAPPING_FAILED'` a la unión existente
   (`'SCOPE_DENIED' | 'DEST_CAP_EXCEEDED'`), con el comentario de que mapea a
   **400** por el `default` del route (no agrega rama).

3. `ComposeResult`: agregar `inputMappingFailure?` con el shape de §5.3, siguiendo
   el patrón de `scopeDeniedTarget` (detalle estructurado aparte del mensaje).

⚠️ El repo usa `exactOptionalPropertyTypes`: al construirlo en `compose.ts` usá
**spread condicional** (`...(x !== undefined && { field: x })`), como ya hace el
bloque de `scopeDeniedTarget` en `compose.ts:218-224`.

#### W0.3 — `src/lib/compose-input-mapping.test.ts` · **CREAR**

Unit del leaf (sin mocks, es puro). Cubre: T-MAP-09, T-MAP-10, T-MAP-11 (§8) y
además cada regla S2..S8 y R2/R4/R5/R6 con un caso positivo y uno negativo.
Objetivo de cobertura: **100% de líneas y ramas** — es un módulo puro, no tiene
excusa.

**Gate de salida de W0**: `npx tsc --noEmit` limpio + `npm test` en el baseline
exacto (**3996 passed | 19 skipped**, más los tests nuevos del leaf). Nadie llama
al leaf todavía ⇒ **cero cambio de comportamiento observable**.

---

### W1 — El reordenamiento del débito ⛔ (commit propio · gate de §4)

#### W1.1 — `src/services/compose.ts` · **MODIFICAR**

Un solo cambio, mecánico:

**Antes** (orden actual dentro del `for`, por contenido):

```
resolveAgent → scoping(WKH-61) → stepGasOverhead → maxBudget → stepDestination
  → [BLOQUE DÉBITO  if (i > 0 && scopingKeyRow && chainId !== undefined)]   ← cobra
  → const input = step.passOutput && lastOutput ? {...} : step.input
  → const startTime = Date.now() → invokeAgent
```

**Después**:

```
resolveAgent → scoping(WKH-61)
  → const input = step.passOutput && lastOutput ? {...} : step.input     ← SE MUEVE ACÁ
  → stepGasOverhead → maxBudget → stepDestination
  → [BLOQUE DÉBITO  if (i > 0 && scopingKeyRow && chainId !== undefined)] ← cobra, ya con la entrada construida
  → const startTime = Date.now() → invokeAgent
```

Concretamente: cortar las 4 líneas `const input = step.passOutput && lastOutput ?
{ ...step.input, previousOutput: lastOutput } : step.input;` (hoy
`compose.ts:339-342`) y pegarlas justo después de la llave que cierra el
`if (scopingKeyRow) { ... }` del scoping check (hoy `:227`), antes del comentario
`// Gas pass-through`.

Agregá arriba de la línea movida un comentario que explique **por qué** está ahí
(qué se rompía antes), en el estilo del resto del archivo. Algo del tenor de:

```ts
// WKH-305: la ENTRADA del step se construye ANTES del bloque de débito. Antes
// se construía después, o sea que un step con entrada inválida se cobraba igual.
// Regla: todo lo que es función pura del body y de las salidas ya producidas va
// antes del cobro; lo que sólo se sabe invocando al agente queda después.
// El punto es post-scoping A PROPÓSITO (la autorización va primero) y
// pre-`getStepGasOverheadUsd` (que en mainnet sin configurar LANZA: un mapeo
// roto no debe reportarse como un error de gas).
```

**Lo que NO cambia en este commit** (repetido acá para que no haya duda):
`startTime` se queda donde está; el guard `i > 0` no se toca; el bloque de débito
no cambia por dentro; no se agrega ningún import; no se agrega ningún early
return.

#### W1.2 — `src/services/compose.test.ts` · **MODIFICAR (sólo agregar)**

Tres tests de caracterización **nuevos, al final**, con un mock de
`budgetService.debit`/`creditWithDest` que **mueva un balance en memoria** (§8.1):

- **T-MAP-C1** — happy path de 3 steps sin mapeo: el balance se mueve
  EXACTAMENTE lo mismo que antes del cambio (delta = precio(step1) + precio(step2),
  mismo `stepDestination`, mismo `chainId`).
- **T-MAP-C2** — fallo post-invoke en el step 1: el refund devuelve EXACTAMENTE
  lo mismo que antes (balance final = balance inicial).
- **T-MAP-C3** — un step sin `passOutput`: el objeto que llega a `invokeAgent` es
  `toBe(step.input)` (la **misma referencia**, ni copia ni allocación nueva).

Fixtures a reusar del propio archivo: `makeAgent()` (`compose.test.ts:142`),
`makeKeyRow()` (`:175`), `mockFetchOk()` (`:203`), `mockAgentsBySlug()` (`:1504`,
dentro del `describe` de WKH-59 — si lo necesitás fuera, definí uno local
idéntico, no muevas el existente).

**⛔ Gate de salida de W1: el de §4. Releelo antes de commitear.**

---

### W2 — Semántica del mapeo en el service (depende de W0 + W1)

#### W2.1 — `src/services/compose.ts` · **MODIFICAR** — resolución + early return

En el punto que creó W1.1, reemplazar la expresión del `input` por:

```ts
const resolved = resolveStepInput(step, lastOutput);
if (!resolved.ok) {
  return {
    success: false,
    output: null,
    steps: results,
    totalCostUsdc: totalCost,
    totalLatencyMs: totalLatency,
    error: `Step ${i} input mapping failed: ${resolved.failure.message}`,
    errorCode: 'INPUT_MAPPING_FAILED',
    inputMappingFailure: {
      step: i,
      reason: resolved.failure.reason,
      ...(resolved.failure.field !== undefined && { field: resolved.failure.field }),
      ...(resolved.failure.source !== undefined && { source: resolved.failure.source }),
    },
  };
}
const input = resolved.input;
```

El early-return **copia byte a byte la forma de los otros returns de error del
loop** (`success:false, output:null, steps: results, totalCostUsdc,
totalLatencyMs, error, errorCode`) — mirá el del `SCOPE_DENIED` en
`compose.ts:210-225` como molde. Eso es lo que hace que **AC-5 salga gratis**:
`results` y `totalCost` ya llevan lo cobrado y entregado por los steps `0..i-1`,
y el route (`refundComposeStep0(request, result.totalCostUsdc)`,
`src/routes/compose.ts:1004`) reembolsa sólo lo que no se gastó.

El único import nuevo permitido en `compose.ts` es
`import { applyMappingTo, resolveStepInput } from '../lib/compose-input-mapping.js';`
(CD-10).

**No se toca `src/services/orchestrate.ts`**: su rama
`pipeline.totalCostUsdc > 0 → max(0, plannedCostUsd - totalCostUsdc)` ya trata
este fallo igual que cualquier otro fallo de step. Verificalo leyéndolo, no lo
edites.

#### W2.2 — `src/services/compose.ts` · **MODIFICAR** — re-aplicación en el retry (AC-7)

Hoy el retry adaptativo (WKH-130) hace, dentro del `catch` del `invokeAgent`:

```
parsear field-errors → refund 'd1' → regenerateInputFromErrors(input, …)  [LLM Haiku]
  → RE-DÉBITO (budgetService.debit, mismo stepDebitedUsd, mismo stepDestination)
  → RE-INVOKE
```

Anclas de contenido: `const newInput = await regenerateInputFromErrors(` (hoy
`compose.ts:644`), `if (newInput) {` (`:650`), `const retryDebit = await
budgetService.debit(` (`:654`).

**Cambio**: entre `if (newInput) {` y el `budgetService.debit` del retry,
re-aplicar el mapeo sobre `newInput`:

```ts
if (newInput) {
  // WKH-305 (AC-7): el mapeo se RE-APLICA sobre el input que regeneró el LLM,
  // ANTES del re-débito.
  const remapped = applyMappingTo(newInput, step.inputFromPrevious, lastOutput);
  if (remapped.ok) {
    const retryInput = remapped.input;
    ... // re-débito + re-invoke, con retryInput en vez de newInput
  }
  // remapped.ok === false → NO se re-debita y NO se re-invoca: cae al return de
  // error normal de abajo (fail-closed, CD-2).
}
```

**EL MOTIVO, y por qué no lo podés omitir**: `regenerateInputFromErrors` recibe
el `input` que **ya tenía el campo mapeado**, y le pide a un LLM (Haiku) que lo
"arregle". El modelo puede borrar el campo, renombrarlo, o **inventarle un
valor**. Que un modelo de lenguaje decida el `quoteId` de una remesa es
inaceptable: es un identificador de cotización emitido por otro agente, no un
texto que se pueda completar plausiblemente. Además, un `quoteId` inventado hace
que el caller **pague un retry destinado a fallar**. Si al leer esto pensás "esto
es redundante, el mapeo ya se aplicó una vez" — no lo es: el input que se
re-invoca no es el que se mapeó, es el que devolvió el LLM.

Dos propiedades que hacen que esto sea seguro:

- **La re-aplicación no puede fallar si la primera tuvo éxito**: `lastOutput` es
  el MISMO objeto (el step `i` falló, el pipeline no avanzó) y las claves son las
  mismas ⇒ es total por construcción. No introduce una rama de fallo nueva antes
  del re-débito. El `ok:false` se maneja igual (fail-closed, sin re-débito)
  aunque sea inalcanzable.
- **Sin mapeo declarado, `applyMappingTo` devuelve `newInput` por la MISMA
  referencia** (R2) ⇒ el camino WKH-130 de hoy queda byte-idéntico (CD-3).

#### W2.3 — `src/services/compose.field-mapping.test.ts` · **CREAR**

Suite nueva de service con **ledger con estado** (§8.1). Cubre T-MAP-01..08,
T-MAP-12..14, T-MAP-19..22.

**Por qué un archivo aparte y no `compose.test.ts`**: mismo motivo que el
docstring "WHY A SEPARATE FILE" de `src/routes/compose.no-debit-on-abort.test.ts`
— los mocks que hacen falta acá (un `budgetService` con balance real) son
incompatibles con los del hermano, que sólo espía llamadas. Ponele un docstring
de cabecera que lo explique.

---

### W3 — Validación de forma pre-cobro en el borde (depende de W0 · **paralelizable**)

#### W3.1 — `src/lib/compose-step-shape.ts` · **MODIFICAR**

Al final de `validateComposeStepShape(step, stepIndex)` (hoy antes del
`return null;` de `:175`), delegar en el leaf y traducir:

```ts
const mappingErr = validateInputMappingShape(step, stepIndex);
if (mappingErr) {
  return {
    error: `Step ${stepIndex}: ${mappingErr.message}`,
    code: 'VALIDATION_ERROR',
    step: stepIndex,
  };
}
```

**Sin duplicar ni una regla**: las reglas viven UNA sola vez, en
`compose-input-mapping.ts`. Este archivo sólo traduce el fallo al shape
`ComposeStepShapeError` que ya usa.

Este es el punto pre-cobro real: `validateComposeStepShape` lo llama
`validateComposeBody` (`src/routes/compose.ts:167`), que corre en
`validateComposeBodyHandler` (`:201-210`), o sea **antes de
`resolveComposePriceHandler` y antes de `requirePaymentOrA2AKey`**. Está
documentado en el docstring de cabecera de `compose-step-shape.ts:8-14`. **No
agregues un preHandler nuevo.**

> **Por qué la forma se valida en DOS lugares con UNA definición**: el schema de
> `POST /orchestrate/execute` (`src/routes/orchestrate.ts`, el schema de `steps[]`)
> **no declara `additionalProperties: false`**, así que ajv no remueve el campo:
> un caller puede inyectar un `inputFromPrevious` malformado que **nunca pasa por
> `validateComposeBodyHandler`**. Por eso el resolvedor del service revalida la
> forma él mismo, fail-closed (R3). Ese camino lo cubre T-MAP-21. **`routes/orchestrate.ts`
> no se toca.**

#### W3.2 — `src/lib/compose-step-shape.test.ts` · **MODIFICAR (agregar)**

Casos de forma del mapeo a nivel step: cada una de S2..S8 devuelve un
`ComposeStepShapeError` con `code:'VALIDATION_ERROR'` y el `step` correcto; un
step sin `inputFromPrevious` sigue devolviendo `null` (S1).

#### W3.3 — `src/routes/compose.field-mapping.test.ts` · **CREAR**

Suite de ruta con el **middleware REAL** y balance en memoria. Exemplar
obligatorio: `src/routes/compose.no-charge-on-validation-error.test.ts`
(`budgetState` con `balance`, `debitMock` que **resta**, `creditMock` que
**suma** — ver `:119-170`). Cubre T-MAP-15..18.

---

### W4 — Documentación + verificación final (depende de todo)

#### W4.1 — `doc/INTEGRATION.md` · **MODIFICAR**

- §3 (`/compose`): el campo `inputFromPrevious`, su semántica destino→origen, las
  reglas de forma (S2..S8 en prosa), el ejemplo de §5 de este documento y la nota
  de que **no es un lenguaje de expresiones** (un `.` es un carácter).
- §5: fila nueva para `INPUT_MAPPING_FAILED` (HTTP 400) con los tres `reason`.
- §5.1: dónde cae en el contrato de cobro — forma inválida ⇒ 400 sin cobro
  alguno; mapeo irresoluble mid-pipeline ⇒ los steps `0..i-1` quedan cobrados
  (entregaron valor) y el step `i` **no se cobra**.

#### W4.2 — Verificación (§9)

#### W4.3 — `doc/sdd/190-wkh-305-compose-field-mapping/auto-blindaje.md` · **CREAR**

Errores reales cometidos durante la implementación, wave por wave, con el
patrón que los previene. Si no cometiste ninguno, no inventes: dejalo explícito.

---

## 8. Plan de tests

Nomenclatura: `T-MAP-NN`. Framework: **vitest** (`npm test`).

### 8.1 Cómo se prueba el dinero (CD-13) — no negociable

**Los tests de dinero comparan el balance ANTES y DESPUÉS. En las dos
direcciones.** Un `expect(mockDebit).toHaveBeenCalledWith(...)` **no** distingue
"cobró y devolvió" de "cobró y se lo quedó" — así se escapó el bug de refund de
HU-208.

Las dos direcciones que esta HU tiene que probar, ambas obligatorias:

1. **Que un mapeo roto NO cobre ese step** → T-MAP-07: balance final =
   balance inicial − precio(step 1), con el step 2 (el del mapeo roto) sin mover
   un centavo. No alcanza con "no se llamó a debit": hay que ver el número.
2. **Que el camino bueno cobre EXACTAMENTE igual que hoy** → T-MAP-13: pipeline
   sin mapeo, 3 steps, todos OK: el balance se mueve exactamente el mismo delta,
   con el mismo destino canónico y el mismo `chainId`. El reordenamiento no puede
   haber cambiado un centavo del camino feliz.

Patrón del mock (copiado de `compose.no-charge-on-validation-error.test.ts:119-170`):

```ts
const budgetState = vi.hoisted(() => ({ balance: 10 }));
const debitMock = vi.hoisted(() =>
  vi.fn(async (_keyId: string, _chainId: number, amountUsd: number) => {
    budgetState.balance -= amountUsd;
    return { success: true };
  }),
);
const creditWithDestMock = vi.hoisted(() =>
  vi.fn(async (/* … */ amountUsd: number /* … */) => {
    budgetState.balance += amountUsd; // el credit TIENE que mover el balance
    return { success: true, reverted: true };
  }),
);
```

### 8.2 Cobertura por AC — qué afirma exactamente cada test

| Test | AC | Nivel | Qué afirma EXACTAMENTE |
|---|---|---|---|
| `T-MAP-01` | AC-1 | service | 2 steps, `inputFromPrevious:{quoteId:'quoteId'}`, salida previa `{quoteId:'q-1'}` → el body que `mockFetch` recibió para el step 1 contiene `quoteId:'q-1'` (se lee de los args del mock), y el step corre normal. |
| `T-MAP-02` | AC-1 / CD-5 | service | Mismo caso: `step.input` original NO fue mutado (sigue sin la clave `quoteId`) y `lastOutput` tampoco (`toEqual` contra un snapshot tomado antes). |
| `T-MAP-03` | AC-2 | service | Clave ausente en la salida previa → `success:false`, `errorCode:'INPUT_MAPPING_FAILED'`, `inputMappingFailure.reason === 'SOURCE_FIELD_MISSING'`, y **`mockFetch` NO se llamó para el step `i`** (conteo de llamadas). |
| `T-MAP-04` | AC-2 | service | Salida previa `null` → `reason:'PREVIOUS_OUTPUT_NOT_OBJECT'`. |
| `T-MAP-05` | AC-2 | service | Salida previa array → `reason:'PREVIOUS_OUTPUT_NOT_OBJECT'`. |
| `T-MAP-06` | AC-2 | service | Salida previa `A2AMessage` (`{kind:'message',parts:[…]}`) → falla con un código estable, no lanza, no invoca. |
| `T-MAP-07` | **AC-2 / CD-2 · DINERO** | service | 3 steps, mapeo roto en el step 2: **`budgetState.balance` final === inicial − precio(step 1)**. El step 2 no movió un centavo y al step 1 no se le hizo refund. |
| `T-MAP-08` | **AC-5 · DINERO** | service | Mismo escenario: `result.steps.length === 2`, `result.totalCostUsdc === p0 + p1`, y **cero llamadas a `creditWithDest`** (ningún reembolso indebido de los steps buenos). |
| `T-MAP-09` | AC-3 | leaf | `{"x":"a.b"}` contra `{a:{b:1}}` → `SOURCE_FIELD_MISSING`. **No hay traversal.** Único trabajo del test. |
| `T-MAP-10` | AC-3 / CD-6 | leaf | `__proto__`, `constructor`, `prototype` como clave **y** como valor → rechazados; y `({}).polluted === undefined` después de resolver. |
| `T-MAP-11` | AC-3 | leaf | 9 entradas → rechazado; 8 → aceptado. `{}` → rechazado. Valor no-string / vacío / >128 chars → rechazado. |
| `T-MAP-12` | AC-4 / CD-3 | service | Pipeline sin mapeo y sin `passOutput`: el objeto que recibió `invokeAgent` es **`toBe(step.input)`** — misma referencia, ni copia ni allocación nueva. |
| `T-MAP-13` | **AC-4 · DINERO (la otra dirección)** | service | Pipeline sin mapeo, 3 steps, todos OK: el balance se mueve **exactamente** `p1 + p2`, con el mismo `stepDestination` canónico y el mismo `chainId` que antes del cambio. |
| `T-MAP-14` | AC-4 / CD-18 | service | Un pipeline sin mapeo hace **la misma cantidad de llamadas a `budgetService.debit`** (assert de I/O, no sólo de efecto). |
| `T-MAP-15` | AC-6 | ruta | `POST /compose` con `inputFromPrevious` malformado → **400 y `budgetState.balance` intacto** (middleware real). |
| `T-MAP-16` | AC-6 (S8) | ruta | Mapeo declarado en el step 0 → 400 pre-cobro, balance intacto. |
| `T-MAP-17` | AC-6 (S7) | ruta | Destino que ya existe en `step.input` → 400 pre-cobro: el valor del llamador nunca se descarta en silencio. |
| `T-MAP-18` | **AC-5 · DINERO (ruta)** | ruta | Mapeo roto en el step 1: 400, y el débito del step 0 **NO** se reembolsa de más — `refundComposeStep0` se llamó con `alreadySpent === result.totalCostUsdc` y el balance final lo refleja. |
| `T-MAP-19` | AC-7 | service | Retry: el LLM devuelve un input **sin** el campo mapeado → el body del re-invoke **igual lo lleva**, con el valor del step anterior (no con uno del modelo). |
| `T-MAP-20` | **AC-7 / CD-2 · DINERO** | service | Retry con mapeo: exactamente **1 débito activo** en todo momento; si el retry falla, el balance vuelve al valor previo al step (refund `d2` intacto). |
| `T-MAP-21` | DT-6 | service | Un `inputFromPrevious` malformado que **no** pasó por la ruta (entrada tipo `/orchestrate/execute`) → falla pre-débito con `reason:'INVALID_MAPPING_SHAPE'`, sin cobrar. |
| `T-MAP-22` | AC-4 / §5.4 | service | `passOutput:true` + mapeo → el input trae `previousOutput` **y** el campo mapeado (coexisten). |
| `T-MAP-C1..C3` | AC-4 (W1) | service | Caracterización del reordenamiento — ver W1.2. |

### 8.3 Regresión obligatoria

- `npm test` completo verde **sin editar ningún test existente** (gate de W1, §4).
- Re-lectura explícita de estas suites antes de declarar verde:
  `src/services/compose.test.ts` (WKH-56 bridge, WKH-59 debit, WKH-61 scoping,
  WKH-125 dest-cap, WKH-128/129 refund, WKH-130 retry, HU-203 retención, WKH-234
  ledger Solana), `src/routes/compose.no-charge-on-validation-error.test.ts`,
  `src/routes/compose.no-debit-on-abort.test.ts`,
  `src/routes/compose.capability.test.ts`,
  `src/routes/charged-routes.meta.test.ts`, `src/routes/orchestrate*.test.ts`.

---

## 9. Verificación por mutación — los 12 mutantes (OBLIGATORIA)

**Regla de oro, CD-15: TODO MUTANTE TIENE QUE COMPILAR ANTES DE CONTARLO.**

Un mutante que rompe la sintaxis o los tipos hace que vitest reporte "FAIL
archivo" / "no tests" y pone todo rojo **sin haber probado nada**: eso es un
**falso KILLED** y es peor que no mutar, porque te deja creyendo que estás
cubierto. Procedimiento por mutante, en este orden:

```
1. git status → limpio (el fix YA está commiteado). NUNCA `git checkout --`
   sobre cambios sin commitear (CD-16).
2. Aplicar el mutante.
3. npx tsc --noEmit   → DEBE compilar limpio. Si no compila, el mutante NO VALE:
                        reformulalo hasta que compile, o descartalo y anotá por qué.
4. npm test           → tiene que ponerse rojo el/los test(s) nombrados abajo,
                        y por la razón correcta (leé el mensaje del fallo).
5. git restore src/... (o revertí a mano) → volver al fix commiteado.
6. Anotar en auto-blindaje.md: mutante, compiló sí/no, test que lo mató.
```

| # | Mutante (qué cambiás) | Test asesino esperado |
|---|---|---|
| **M1** | Devolver la construcción del `input` a su lugar original: mover las líneas del `const input = ...` de vuelta a después del bloque de débito. | `T-MAP-07`, `T-MAP-18` |
| **M2** | En `applyMappingTo`, ante una clave de origen ausente devolver `{ ok: true, input: base }` en vez de `{ ok: false, … SOURCE_FIELD_MISSING }`. | `T-MAP-03`, `T-MAP-07` |
| **M3** | Cambiar `Object.hasOwn(prev, source)` por `source in prev`. | `T-MAP-10` |
| **M4** | Partir la clave de origen por `.` y hacer traversal (`source.split('.').reduce(...)`). | `T-MAP-09` |
| **M5** | Que el resolvedor **mute** `step.input` (`base[dest] = prev[src]`) en vez de construir un objeto nuevo. | `T-MAP-02`, `T-MAP-12` |
| **M6** | Quitar la re-aplicación del mapeo en el retry: pasarle `newInput` crudo al re-débito y al re-invoke. | `T-MAP-19` |
| **M7** | Quitar S7 (permitir que el destino colisione con una clave ya presente en `step.input`). | `T-MAP-17` |
| **M8** | Quitar S8 (permitir mapeo en el step 0). | `T-MAP-16` |
| **M9** | Sacar la validación de forma del resolvedor (R3): dejarla sólo en la ruta. | `T-MAP-21` |
| **M10** | En el early-return de `INPUT_MAPPING_FAILED`, dejar de propagar `steps: results` y `totalCostUsdc: totalCost` (mandar `[]` y `0`). | `T-MAP-08`, `T-MAP-18` |
| **M11** | Quitar el guard `i > 0` del bloque de débito (CD-7). | Tests **preexistentes** de doble-débito del step 0 en `compose.test.ts` (WKH-59). Identificá cuál(es) por nombre y anotalo. |
| **M12** | Mover `const startTime = Date.now()` arriba del bloque de débito (CD-8). | **Ver nota ⬇** |

> **Nota sobre M12 — es el caso CD-12 en estado puro.** Es probable que hoy
> **ningún** test se ponga rojo con M12. Si eso pasa, **no lo cuentes como
> SURVIVED y sigas de largo: hay que ESCRIBIR el test**. Uno que congele que
> `latencyMs` del step no incluye el tiempo del débito, inyectando latencia en el
> mock de `debit` (patrón `debitLatencyMs` de
> `src/routes/compose.no-charge-on-validation-error.test.ts:126-133` + el helper
> `sleep` de `:132-134`) y asertando que el `latencyMs` reportado del step es
> menor que esa latencia inyectada. Mutar primero, y recién ahí diseñar el test:
> ese es exactamente el orden que pide CD-12.

**Ningún mutante puede quedar SURVIVED sin acción.** SURVIVED ⇒ escribís el test
que falta, o documentás en `auto-blindaje.md` por qué ese comportamiento es
deliberadamente no observable.

---

## 10. Anti-Hallucination Checklist (verificá cada ítem con Read/Grep antes de codear)

```
[ ] `src/services/compose.ts` existe; el loop empieza en `for (let i = 0; i < steps.length; i++)`
    y el `const input = step.passOutput && lastOutput ? {...} : step.input` sigue
    DESPUÉS del bloque `if (i > 0 && scopingKeyRow && chainId !== undefined)`.
    Si ya no es así → PARÁ y reportá (CD-14).
[ ] `git log --oneline -3 -- src/services/compose.ts`: el último commit sobre el
    archivo es `c52591a` (HU-208) o posterior conocido. Si hay commits nuevos que
    tocan el bloque de débito → releé el bloque antes de mover nada.
[ ] `src/lib/compose-step-shape.ts` existe y exporta `validateComposeStepShape(step, stepIndex)`.
[ ] `src/routes/compose.ts` llama a `validateComposeStepShape` desde `validateComposeBody`,
    y `validateComposeBodyHandler` está en la cadena de preHandlers ANTES de
    `requirePaymentOrA2AKey`.
[ ] `src/routes/compose.ts` mapea `errorCode` → status con `let status = 400` +
    `SCOPE_DENIED → 403` + `DEST_CAP_EXCEEDED → 402`. NO agregues una rama.
[ ] `src/types/index.ts` tiene `interface ComposeStep` (con `input`, `passOutput?`)
    y `interface ComposeResult` (con `errorCode?`, `scopeDeniedTarget?`).
[ ] `src/lib/compose-limits.ts` exporta `MAX_COMPOSE_STEPS = 5`. ⚠️ Un pipeline
    NO puede tener más de 5 steps: los tests de 3 steps están bien, los de 6 no.
[ ] `src/adapters/chain-resolver.ts:14-21` es el idiom de `Object.hasOwn` a copiar.
[ ] `src/services/llm/input-retry.ts` exporta
    `regenerateInputFromErrors(failedInput, missingFields, agentSlug, agentDescription?)
    : Promise<Record<string, unknown> | null>`.
[ ] `src/routes/compose.no-charge-on-validation-error.test.ts` tiene el `budgetState`
    con `balance`, `debitMock` que resta y `creditMock` que suma. Ese es el patrón.
[ ] `src/services/compose.test.ts` tiene `makeAgent` (:142), `makeKeyRow` (:175),
    `mockFetchOk` (:203), `mockAgentsBySlug` (:1504).
[ ] NO existe todavía `src/lib/compose-input-mapping.ts` (lo creás vos).
[ ] NO vas a tocar: `src/routes/orchestrate.ts`, `src/services/orchestrate.ts`,
    `src/routes/charged-routes.meta.test.ts`, `src/services/budget.ts`,
    ninguna migración, ninguna tabla.
```

**Prohibiciones de contexto (no son parte de la HU pero te aplican):**

- No toques `doc/sdd/_INDEX.md` (lo escribe `nexus-docs` en el cierre).
- No toques los untracked protegidos: `contracts/.gas-snapshot`,
  `doc/audit/2026-06-28-best-practices-audit.md`, los tres `doc/jury-qa*.md`,
  `doc/sdd/118-wkh-sec-02b-owner-ref-rpc/`.
- Nada de git destructivo (`reset --hard`, `checkout --` sobre trabajo sin
  commitear, `push --force`). Repo público.
- Sin `Co-Authored-By` en los commits.

---

## 11. Bloque de verificación final (antes de declarar la HU lista)

```
BASELINE (antes de tocar nada):        3996 passed | 19 skipped
BASELINE (al terminar):                3996 + los tests nuevos, passed | 19 skipped | 0 failed
```

Gates, en orden:

```
[ ] G1 · W0: npx tsc --noEmit limpio · npm test en baseline exacto · nadie llama al leaf
[ ] G2 · W1: ⛔ suite COMPLETA verde SIN editar un solo test existente (§4).
             git diff del commit: sólo compose.ts + compose.test.ts; en el test,
             sólo adiciones. Sin "startTime", sin "i > 0" en el diff de compose.ts.
             Si tuviste que tocar un test → PARASTE y REPORTASTE.
[ ] G3 · W2: T-MAP-01..08, 12..14, 19..22 verdes
[ ] G4 · W3: T-MAP-15..18 verdes + casos de forma en compose-step-shape.test.ts
[ ] G5 · Mutación: los 12 mutantes M1..M12 corridos. Cada uno COMPILÓ (tsc limpio)
             antes de contarse. Ninguno SURVIVED sin test nuevo o justificación
             escrita en auto-blindaje.md. M12 con test escrito si no había ninguno.
[ ] G6 · npx tsc --noEmit COMPLETO (con tests, no sólo `npm run build`) — CD-17
[ ] G7 · npm run lint limpio
[ ] G8 · npm test completo: 0 failed, 19 skipped, baseline + nuevos
[ ] G9 · Cobertura: src/lib/compose-input-mapping.ts al 100% de líneas y ramas.
             Toda línea nueva de src/services/compose.ts sin hits: declarada con
             su motivo.
[ ] G10 · doc/INTEGRATION.md actualizado (§3, §5, §5.1)
[ ] G11 · auto-blindaje.md escrito con los errores reales de la implementación
[ ] G12 · Ni `_INDEX.md` ni los untracked protegidos aparecen en `git status`
```

---

## 12. Done Definition

La HU está lista cuando, **y sólo cuando**:

1. Los 12 gates G1..G12 están tildados.
2. `inputFromPrevious` funciona: AC-1 probado con el body real que recibe el
   agente, no con un spy.
3. Un mapeo irresoluble **no cobra ese step**, y está probado **mirando el
   balance** (T-MAP-07), no el spy.
4. Un pipeline sin mapeo **cobra exactamente lo mismo que hoy**, y está probado
   **mirando el balance** (T-MAP-13).
5. El commit de W1 existe, está **solo**, y su diff no editó ningún test previo.
6. `startTime` y el guard `i > 0` están donde estaban. Verificalo con
   `git diff main -- src/services/compose.ts` y buscando esas dos cadenas.
7. Los 12 mutantes están documentados con "compiló / test asesino / resultado".

Si algo de esta lista no se cumple: **no está lista**. Reportá el estado real, no
uno redondeado.

---

*Story File generado por NexusAgil — Architect (F2.5) · derivado de `sdd.md` (SPEC_APPROVED)*
