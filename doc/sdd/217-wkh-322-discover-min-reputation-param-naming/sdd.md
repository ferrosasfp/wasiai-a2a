# SDD #217: [WKH-322] `/discover` ignora en silencio `min_reputation` — y no sólo ese nombre

| Campo | Valor |
|---|---|
| HU | WKH-322 |
| Work item | [`work-item.md`](work-item.md) (HU_APPROVED) |
| SDD_MODE | mini (superficie: capa de parseo/validación de parámetros de UNA ruta) |
| Metodología | QUALITY |
| Branch sugerido | `feat/217-wkh-322-discover-reputation-param-naming` (desde `main` — ver DT-7) |
| Archivos de producción tocados | 2 (`src/lib/discovery-query.ts`, `src/routes/discover.ts`) + 1 doc |
| Fecha | 2026-08-03 |

---

## 1. Resumen

El work-item cerró bien la causa: el filtro de reputación de `/discover` **existe y
funciona**, y lo que falla es el NOMBRE — la ruta sólo lee `minReputation`
(camelCase, `routes/discover.ts:141`) mientras `/compose` usa `min_reputation`
(snake_case, `capability-resolver.ts:110-112`) para la misma capacidad. Un caller que
trae la convención de `/compose` no recibe ni filtro ni error.

Este SDD agrega **un hecho medido hoy que cambia el alcance de la decisión**: el
parámetro mal escrito de `min_reputation` no es un caso aislado, es un ejemplar de una
clase que ya mordió — y mordió **dentro de la medición que originó esta HU**. La URL
`GET /discover?capability=remittance-payout` (singular) devuelve **23 agentes**; la
correcta, `?capabilities=remittance-payout`, devuelve **1**. Las dos con HTTP 200. O
sea: la medición que se usó para estudiar un parámetro descartado en silencio tropezó,
sin que nadie lo notara, con **un segundo parámetro descartado en silencio**, y leyó el
catálogo entero creyendo estar mirando candidatos de una capacidad. Un error de un
carácter, un factor de 23 en la respuesta, cero señales.

Por eso la decisión de F2 (MI-1) no es "alias **o** 400": es **alias Y 400, en el mismo
cambio**. El alias arregla el parámetro que el protocolo se contradice a sí mismo sobre
cómo se llama; el 400 sobre claves desconocidas cierra la clase. Y van juntos por un
motivo que no es de comodidad: si el 400 llegara solo, su **primera víctima** sería
justamente el caller razonable que copió la convención de `/compose` — castigaríamos
con un error a quien leyó bien la mitad de nuestra propia API. Ver DT-1.

Además, este SDD asciende de *inferencia* a *medición* el riesgo que el orquestador
señaló: `remit-cashout-payout-solana` es el **único** agente del catálogo con capacidad
`remittance-payout`, no tiene `computedReputation`, y con cualquier piso `>= 1` el
conjunto de candidatos queda en **0**. Ver §3.3 y R-2.

---

## 2. Work Item y ACs heredados

### 2.1 Acceptance Criteria (EARS) — heredados, con su resolución de diseño

| AC | Qué exige | Cómo lo satisface este diseño |
|---|---|---|
| **AC-1** (regresión, pin) | `minReputation` en `[0,100]` sigue excluyendo por `computedReputation.score` y reportando `excluded.reputation` | El motor no se toca (CD-4). Se pinea con test **después** del cambio de parseo (§5, T-1a/T-1b) |
| **AC-2** (núcleo) | `min_reputation` NO puede producir una respuesta indistinguible de "sin filtro" | **Opción (a) + (b)**: alias válido para `min_reputation` (DT-1) **y** 400 `UNKNOWN_DISCOVER_PARAM` para toda otra clave no reconocida (DT-1, DT-3) |
| **AC-3** (condicional a alias) | Resultados idénticos entre ambos nombres; precedencia DECLARADA si se mandan los dos | Idénticos por construcción: un solo validador, un solo campo de salida (DT-4). Conflicto (dos valores distintos) → **400 `CONFLICTING_MIN_REPUTATION`**, que es una precedencia declarada y no una elección tácita (DT-4) |
| **AC-4** (regresión, pin) | Fail-closed con `standingBatch.degraded === true`, por cualquiera de los dos nombres | El alias colapsa a `query.minReputation` **antes** del service: el motor recibe exactamente el mismo input de hoy, así que no hay un segundo camino que pueda debilitarse (DT-4). Test T-4 |
| **AC-5** (opcional, alcance F2) | Si se amplía la validación, documentar el cambio de contrato en `doc/INTEGRATION.md` ANTES de activarlo | **Se toma el alcance ampliado.** W2 (docs) es obligatoria y **debe mergear junto con W1** — "antes de activarlo" se interpreta como *antes de que llegue a `main`/prod*, no como un commit anterior que dejaría el doc afirmando algo que el código todavía no hace (CD-8) |

### 2.2 Enmienda al AC-2 (declarada acá, no silenciada)

El AC-2 plantea (a) y (b) como alternativas excluyentes ("o bien... o bien"). DT-1
concluye que **son complementarias y que ninguna sola es suficiente**. No se reinterpreta
el AC en silencio: se lo cumple en su parte fuerte (la respuesta deja de ser
indistinguible) y se declara acá el ensanchamiento, para que F4 valide contra ESTA
lectura y no contra la disyunción original.

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos (paths verificados; todos existen en este árbol)

| Archivo | Por qué se leyó | Qué se extrajo |
|---|---|---|
| `src/routes/discover.ts` (272 líneas, completo) | Superficie a modificar | `parseFiltersOr400` (`:25-55`) es el helper COMPARTIDO por GET y POST — el punto de wiring correcto. El `Querystring` tipado (`:136-148`) declara 9 claves; el `Body` (`:189-201`), las mismas 9. **Ninguna de las dos rutas registra `schema:`** |
| `src/lib/discovery-query.ts` (153 líneas, completo) | Módulo a extender | Módulo LEAF (sin imports de services/DB) — el docstring `:1-10` explica por qué: los tests de la ruta mockean `../services/discovery.js` completo. Tres validadores con el mismo patrón: `Invalid*Error` con `code` + `parseX(raw: unknown)`. **El patrón a copiar está acá, literal** |
| `src/services/discovery.ts` (`:520-591`, `:682-715`, `:717-745`) | Confirmar que el motor no hay que tocarlo | `applyReputationFloor` corre entre `attachReputations` y el `sort` (posición que CD-11 de WKH-313 protege). Gate `query.minReputation != null` (`:577`). `excluded.standingUnavailable` se propaga SIEMPRE (`:712`) |
| `src/services/capability-resolver.ts` (`:1-200`) | Verificar el otro nombre y CD-1 | `constraints.min_reputation → query.minReputation` (`:110-112`). Confirma que **la funcionalidad es una sola** y sólo difiere el nombre expuesto. NO se toca |
| `src/lib/compose-step-shape.ts` (`:39-57`, `:175-209`) | Buscar precedente de política | 🎯 **`ALLOWED_STEP_CONSTRAINTS`** — `/compose` YA rechaza toda clave desconocida en `constraints` con 400 `VALIDATION_ERROR` (`:176-185`), y el comentario de arriba dice textual: *"Decirle que no se soporta es honesto; ignorarlo, no."* Ver DT-1 |
| `src/routes/orchestrate.ts` (`:73-132`) | Buscar exemplar de `schema` Fastify | `:79` documenta que el schema de `steps[]` **no** declara `additionalProperties: false`, "así que ajv NO remueve las claves que no conoce". Pista que llevó a la verificación de DT-3 |
| `src/index.ts` (`:95-106`) | Config de la instancia Fastify | `Fastify({ logger, genReqId, trustProxy })` — **sin `ajv:` custom** ⇒ rigen los defaults de `@fastify/ajv-compiler` |
| `node_modules/@fastify/ajv-compiler/README.md:23-36` | Verificar el default de ajv | `removeAdditional: true` está en la lista de defaults de Fastify. **Decisivo** — ver DT-3 |
| `src/lib/discovery-query.test.ts` (completo) | Exemplar de test unitario | Naming `T-V1..T-V5`, `T-AT1..T-AT5`; patrón `try/expect.unreachable/catch` para afirmar `code` y `received` |
| `src/routes/discover.minreputation.test.ts` (`:1-130` + índice completo) | Exemplar de test de ruta | Mock de `../services/discovery.js` con factory sin `importOriginal`; `app.inject`; naming `T-R1..T-R21`; aserción `expect(mockDiscover).not.toHaveBeenCalled()` para probar "sin fanout" |
| `src/routes/discover.test.ts` (índice de casos) | Impacto en la suite existente | 13 casos `P1-4` + rate-limit. Ninguno manda parámetros desconocidos (§3.4) |
| `doc/INTEGRATION.md` (`:217-320`, `:713-731`) | Contrato público a actualizar | §`/discover` documenta `minReputation`, `allowTrial`, `limit`, `excluded`. Tabla de errores `:723` sólo nombra `INVALID_MIN_REPUTATION` |
| `doc/roadmap/2026-08-incubadora-solana-checklist.md` (`:40-80`) | Verificar el consumidor de `/compose` | §0.3 cita `chaski-v3/src/infrastructure/a2a/gateway-client.ts:29` (`PAYOUT_MIN_REPUTATION = 2`) y `app/api/a2a/payout/submit/route.ts:390` (`constraints: { min_reputation: ... }`) en los legs de `prepare` **y** `submit` |
| `doc/sdd/215-.../sdd.md` (estructura) | Formato de SDD del repo | Esqueleto de secciones que usa este documento |
| Auto-blindaje 211/213/215/216 | Obligatorio (§3.5) | Ver §3.5 |

### 3.2 Medición en vivo contra producción (GET gratuitos, `2026-08-03`)

`https://wasiai-a2a-production.up.railway.app`. Se reusó la medición del orquestador y
se agregaron los controles que faltaban:

```
GET /discover                                              -> total 23   excluded.reputation 0
GET /discover?capability=remittance-payout                 -> total 23   excluded.reputation 0     (A)
GET /discover?capabilities=remittance-payout               -> total  1   excluded.reputation 0     (B)
GET /discover?capability=remittance-payout&min_reputation=2 -> total 23                            (C)
GET /discover?capability=remittance-payout&minReputation=1  -> total  6   excluded.reputation 17
GET /discover?capabilities=remittance-payout&minReputation=1-> total  0   excluded.reputation 1    (D)
GET /discover?bogusparam=zzz                               -> total 23   HTTP 200                  (E)
GET /discover?minReputation=abc                            -> HTTP 400 INVALID_MIN_REPUTATION      (F)
```

Lecturas, en orden de importancia:

- **(A) vs sin parámetros: idénticos.** `capability` (singular) se descarta en silencio
  igual que `min_reputation`. Los "23 agentes" de la medición original **no eran los
  candidatos de `remittance-payout`: eran el catálogo entero.**
- **(B): la respuesta verdadera a esa pregunta es 1 agente, no 23.** El error de nombre
  costó un factor 23 con HTTP 200.
- **(E)**: confirma que el silencio es genérico, no específico de un nombre parecido a
  uno real. Cualquier clave inventada pasa.
- **(F)**: cierra **MI-2 del work-item**: el deploy de prod SÍ incluye el fix-pack P1
  (el 400 con el mensaje de escala 0-100 sólo puede venir de
  `discovery-query.ts:29`). **No hay deploy-lag.** MI-2 queda RESUELTO.
- **(D)** es el hallazgo de §3.3.

### 3.3 El agente que entrega la plata: de inferencia a medición

El orquestador infirió, de dos mediciones, que `remit-cashout-payout-solana` quedaría
fuera con un piso. **Verificado directamente hoy, y es peor que la inferencia**:

```
GET /discover?capabilities=remittance-payout
  -> 1 agente: remit-cashout-payout-solana
     registry=self-published  verified=false  reputation=null  computedReputation=null

GET /discover?capabilities=remittance-payout&minReputation=1
  -> total 0   excluded {reputation: 1, trialAvailable: 1, standingUnavailable: false}

GET /discover?capabilities=remittance-payout&minReputation=2&allowTrial=true
  -> total 1   agents[0].trial = { granted: true, under_min_reputation: 2,
                                   tasks_settled: 0, remaining_settled_tasks: 3 }
```

O sea:

1. No es "el agente de payout no está entre los 6": es que **es el único que sirve esa
   capacidad**, y con cualquier piso `>= 1` el conjunto queda **vacío**. No hay
   segundo candidato que lo reemplace.
2. `standingUnavailable: false` ⇒ el gateway **sí pudo leer** el historial. No es el
   modo "no pude preguntar": la exclusión es real y significa lo que parece.
3. `/compose` con `constraints: { min_reputation: 2 }` — la constante que
   `doc/roadmap/2026-08-incubadora-solana-checklist.md:57-58` documenta en chaski-v3 —
   llama al MISMO pipeline (`capability-resolver.ts:124`), recibe `agents: []` y devuelve
   `422` con `reason: 'excluded_by_reputation'`.
4. **Hay salida y está medida**: `allow_trial: true` lo admite por el carril de estreno
   de WKH-313, con su badge `trial` visible y su cupo (`remaining_settled_tasks: 3`).

Esto **no lo causa ni lo arregla esta HU** (CD-1: `/compose` no se toca). Se declara como
**R-2**, con dueño y estado de verificación. Lo que sí hace esta HU es **volverlo
visible**: hoy un integrador que investiga con `?min_reputation=2` ve 23 agentes y
concluye que hay oferta de sobra; después de esta HU verá 0 y `excluded.reputation`, que
es la verdad. Un diagnóstico correcto es un cambio de comportamiento deseado, no una
regresión.

### 3.4 Impacto verificado sobre la suite y sobre los callers (no estimado: medido)

Aplicando la lección de WKH-315 (verificar el impacto ANTES de estimarlo):

- **Query strings usados contra `/discover` en TODO `src/`** (`grep` sobre 77 archivos de
  test + e2e): 14 variantes distintas, **todas** usando exclusivamente
  `capabilities`, `maxPrice`, `registry`, `verified`, `limit`, `minReputation`,
  `allowTrial`. **Cero** claves desconocidas ⇒ el 400 estricto **no rompe ni un test
  existente**.
- **Callers internos por HTTP**: `scripts/doctor-dast.js:126` y `scripts/doctor-chaos.js:115`
  llaman `/discover` **sin parámetros**; `scripts/k6-load-test.js:188` idem.
  `src/middleware/event-tracking.ts:19` sólo lo lista para telemetría.
- **Callers internos del motor** (`orchestrate.ts:557,577`, `capability-resolver.ts:124`,
  `routes/capabilities.ts:62`, `mcp/tools/discover-agents.ts:33`) llaman
  `discoveryService.discover({...})` **en proceso**: no pasan por el parser de query, así
  que el 400 les es transparente.
- **Ejemplos en documentación pública** (`doc/INTEGRATION.md`, `doc/QUICKSTART-PUBLISH.md`,
  `doc/BASE-EVIDENCE.md`, ...): sólo `capabilities`, `limit`, `q`, `maxPrice`,
  `minReputation`, `verified`. **Ningún ejemplo público quedaría rechazado.**
- Dato histórico que refuerza la clase: `doc/sdd/077-wkh-82-public-docs-onboarding/done-report.md:117`
  registra que en su día hubo que **sacar de los docs** un `/discover?chain=2368` porque
  "no existe". Ya se publicó una vez un parámetro que la ruta ignoraba en silencio.

### 3.5 Auto-Blindaje histórico consultado (obligatorio)

Últimas HUs con auto-blindaje: **216 (WKH-319)**, **215 (WKH-318)**, **213 (WKH-315)**,
**211 (WKH-313)**. Patrones recurrentes (>= 2 HUs) que se convierten en CD:

| Patrón recurrente | Dónde apareció | CD que lo previene acá |
|---|---|---|
| **Prosa/comentario que afirma de más y apaga la revisión** | WKH-319 (*"un comentario seguro de sí mismo hace que el próximo lector no vuelva a revisar la cuenta"*), WKH-313 (JSDoc que prometía `created_at` y no era lo que hacía) | **CD-9** |
| **El fixture/AC ya garantiza el resultado: el test mide aire** — "tres copias de un razonamiento no son tres verificaciones" | WKH-319 (AC = comentario = código, los tres equivocados), WKH-313 (3 veces en la misma HU: `reputation: 0` en el fixture hacía pasar la garantía de orden) | **CD-10** |
| **Verificar el VALOR y no el TIPO / el significado** | WKH-315 (`as ChainKey` invisible a un grep por valor), memoria del proyecto (*"un nombre de campo no es su semántica"*) | **CD-11** |
| **Worktree nuevo sin `node_modules` ⇒ `TS2307` masivo leído como "baseline rota"** | WKH-318 | **CD-12** (procedimental) |

---

## 4. Diseño técnico

### 4.1 DT-1 — MI-1 RESUELTO: **alias `min_reputation` + 400 sobre claves desconocidas, en el mismo cambio**

El criterio del proyecto es *"un valor que no se puede honrar no se acepta callado"*.
Aplicado acá, con las tres opciones sobre la mesa:

**Por qué el alias solo NO alcanza.** El alias arregla **un** nombre. La clase quedó
demostrada hoy, y no con un ejemplo de laboratorio: la propia medición encargada para
estudiar este bug tropezó con `capability` (singular) y leyó 23 agentes donde había 1
(§3.2 A/B). Si el alias hubiera estado desplegado ayer, esa medición habría salido
**exactamente igual de equivocada**. Un arreglo que no habría atrapado el error que
ocurrió mientras se lo diseñaba no está cerrando el problema: está cerrando un caso.

**Por qué el 400 solo es peor de lo que parece.** Su primera víctima no sería un typo:
sería el caller que escribió `min_reputation` porque **así se llama el parámetro en
`/compose`**, en la misma API, para la misma capacidad, mapeado por
`capability-resolver.ts:110-112` a la misma `query.minReputation`. Devolverle 400 es
cobrarle a él la inconsistencia que pusimos nosotros. El alias es lo que vuelve
**legítimo** al 400: primero dejamos de contradecirnos, después exigimos precisión.

**Por qué la combinación no es "las dos por las dudas".** Cada una cubre lo que la otra
no puede: el alias cubre el nombre **que nosotros mismos usamos con otro significado de
convención**; el 400 cubre **todo el resto del espacio de nombres**, que es infinito y
donde no podemos ir agregando sinónimos de a uno.

**Y no es una política nueva: ya la escribimos y la shippeamos una capa más adentro.**
`src/lib/compose-step-shape.ts:176-185` rechaza cualquier clave desconocida dentro de
`step.constraints` con 400, y su comentario dice textual:

> *"Decirle que no se soporta es honesto; ignorarlo, no."*

La asimetría actual es, además, perversa: la superficie que **cobra** (`/compose`) es
estricta, y la superficie **gratis** (`/discover`) es permisiva — cuando `/discover` es
justamente donde el integrador decide **a qué agente le va a pagar**. Un parámetro
ignorado en la consulta gratuita se paga en la llamada siguiente.

**Costo, con los ojos abiertos.** Un integrador que hoy manda basura inerte y recibe 200
empezará a recibir 400. La parte medible del radio de explosión es **cero**
(§3.4: ni un test, ni un script, ni un caller interno, ni un ejemplo de la documentación
pública manda una clave fuera de la lista). La parte no medible son los integradores
externos que no podemos enumerar. Mitigaciones asumidas, no descubiertas después:
(i) la lista blanca incluye **todo** lo que la ruta ya lee hoy, más el alias;
(ii) el mensaje del 400 nombra la clave ofensora **y** enumera las aceptadas, así que el
arreglo del lado del caller es mecánico; (iii) `doc/INTEGRATION.md` documenta el cambio
de contrato en el mismo merge (AC-5 / CD-8); (iv) **no se toca `GET /discover/:slug`**
(DT-6). Riesgo residual: **R-1**.

**Decisión sobre parámetros cosméticos (`utm_*`, `_`, `cachebust`): NO se hace excepción.**
`/discover` es una API de servidor a servidor, no una página compartible; la evidencia de
§3.4 no muestra un solo caller que los mande; y una lista de "claves que se ignoran a
propósito" reintroduce, por la puerta de atrás y con nuestra firma, exactamente el
silencio que esta HU viene a matar. Decisión reversible; su disparador está en R-1.

### 4.2 DT-2 — Tercera opción (unificar la convención del protocolo): EVALUADA y RECHAZADA, con su verificación

La causa raíz sí es tener dos nombres para el mismo concepto en la misma API. Pero
unificar renombrando `/compose` está **verificado como breaking duro e inmediato**:

- `ALLOWED_STEP_CONSTRAINTS` (`compose-step-shape.ts:49-57`) es una lista **estricta**:
  toda clave fuera de ella devuelve 400 `VALIDATION_ERROR` con
  `unsupported constraint '<clave>'` (`:176-185`). Renombrar a camelCase no degradaría a
  chaski-v3: lo **rompería en la primera request**, con 400, en los dos legs.
- chaski-v3 manda `constraints: { min_reputation: PAYOUT_MIN_REPUTATION }` en `prepare`
  **y** en `submit` — evidencia en este repo, sin abrir el otro:
  `doc/roadmap/2026-08-incubadora-solana-checklist.md:57-58`, citando
  `chaski-v3/app/api/a2a/payout/submit/route.ts:390` y `gateway-client.ts:29`.
- El work-item ya lo dejó fuera de alcance ("ni siquiera se evalúa acá") y CD-1 prohíbe
  tocar ese camino. Se evalúa igual, y se rechaza **con la verificación hecha**, para que
  la próxima HU no reabra la pregunta a ciegas.

**Lo que sí se rescata de esa opción, gratis:** con el alias, **`min_reputation` pasa a
ser el único nombre que funciona en las DOS superficies**. La convergencia se consigue
por ensanchamiento de `/discover`, no por rotura de `/compose`. El doc de W2 debe decirlo
así: *si querés un solo nombre para ambos endpoints, usá `min_reputation`*.

### 4.3 DT-3 — El rechazo NO se implementa con un `schema` de Fastify. **Verificado.**

Tentación obvia: declarar `schema: { querystring: { ..., additionalProperties: false } }`.
**Haría lo contrario de lo que se busca**, y el propio repo dejó la pista
(`routes/orchestrate.ts:79`).

Verificado en este árbol:

1. `src/index.ts:95-106` construye `Fastify({ logger, genReqId, trustProxy })` — **sin
   opción `ajv`**.
2. Sin `ajv` custom rigen los defaults documentados en
   `node_modules/@fastify/ajv-compiler/README.md:23-36`, que incluyen
   **`removeAdditional: true`** (Fastify 5.9.0, verificado en `package.json`).
3. Con `removeAdditional: true`, `additionalProperties: false` hace que ajv **borre** las
   claves desconocidas **antes** de que el handler vea el objeto. No hay error, no hay
   log, y el handler ni siquiera puede enterarse de que existieron.

Sería cambiar un silencio por otro **más profundo**: hoy la clave al menos llega al
handler; con el schema ingenuo desaparecería antes. Por eso el chequeo vive en **código de
aplicación** (módulo leaf + el helper compartido), donde el conjunto de claves recibidas
es observable. Es, además, el mismo lugar donde `/compose` puso el suyo.

### 4.4 DT-4 — Semántica del alias y del conflicto (AC-3)

Un único punto de resolución, en el módulo leaf, **antes** de armar el `DiscoveryQuery`:

```
resolveMinReputation(camelRaw, snakeRaw) -> number | undefined
  a = parseMinReputation(camelRaw)     // CD-2: el ÚNICO validador, sin duplicar
  b = parseMinReputation(snakeRaw)     // CD-2: el mismo, sobre el otro nombre
  si a !== undefined && b !== undefined && a !== b  -> throw ConflictingMinReputationError
  devolver  a ?? b
```

Consecuencias, todas deliberadas:

- **Equivalencia por construcción (AC-3)**: los dos nombres colapsan al mismo `number` y
  alimentan el mismo campo `minReputation` del `DiscoveryQuery`. No hay "el camino del
  alias": aguas abajo del parser **hay un solo camino**, byte por byte el de hoy. Por eso
  AC-4 (fail-closed) no puede debilitarse: no existe una segunda rama que pueda divergir.
- **La validación de rango y de forma es la misma para los dos** (CD-2): `'abc'` por
  cualquiera de los dos nombres da el mismo 400 `INVALID_MIN_REPUTATION`.
- **Vacío = ausente**, consistente con el contrato de hoy (`discovery-query.ts:45`):
  `?minReputation=5&min_reputation=` **no** es conflicto (el segundo parsea a `undefined`).
- **Conflicto → 400, no precedencia.** Se descartó "gana el camelCase": un caller con
  `?minReputation=0&min_reputation=5` (default de plantilla + override explícito) recibiría
  `0` — su piso explícito descartado en silencio, o sea **la misma clase de bug que esta
  HU cierra, con el signo invertido**. Dos valores incompatibles no se pueden honrar los
  dos; el criterio del proyecto dice qué hacer. Y satisface la letra de AC-3: la
  resolución es DECLARADA y observable, no un orden de evaluación accidental.

### 4.5 DT-5 — Un solo alias. `capability` (singular) NO se aliasa.

`capability` fue el otro nombre que falló hoy, y es tentador aliasarlo también. **No.**
El alias de `min_reputation` se justifica por un hecho puntual y verificable: **ese nombre
exacto ya es parte del contrato de esta API en otra superficie**. `capability` no lo es en
`/discover` — es un singular plausible, nada más. Aliasar por plausibilidad es aceptar que
el número de nombres válidos crece con la imaginación de los callers, y cada sinónimo hay
que mantenerlo, documentarlo y testearlo para siempre.

Para `capability` la respuesta correcta es el 400 de DT-1: un error que **nombra
`capabilities`** enseña el nombre canónico una vez y no crea un segundo. Es exactamente el
caso que se midió hoy, y con este diseño habría salido `400 UNKNOWN_DISCOVER_PARAM`
en lugar de 23 agentes equivocados.

### 4.6 DT-6 — Alcance de la lista blanca: las dos rutas de `/discover` raíz, y sólo ellas

- `GET /discover` (query) y `POST /discover` (body): **sí**, con la MISMA lista y por el
  MISMO helper (CD-6).
- `GET /discover/:slug` (`routes/discover.ts:247-268`, `Querystring: { registry? }`):
  **no se toca en esta HU**. Es otra ruta, con otro contrato y otro tipo de caller
  (lookup puntual, `rateLimit: false`), y el work-item no la nombra. Ensancharla sería
  scope creep sobre una superficie que nadie midió. Se declara como **deuda TD-322-1**.

Lista blanca (idéntica a lo que la ruta lee hoy + el alias; verificada contra
`routes/discover.ts:136-148` y `:189-201`):

```
capabilities · q · maxPrice · minReputation · min_reputation · allowTrial ·
limit · registry · verified · includeInactive
```

### 4.7 DT-7 — DT-2 del work-item RESUELTO con git: WKH-313/318/319 **están mergeados**, y hay **tres** filas desactualizadas (no dos)

`git log --oneline main` muestra los merges:

| HU | Fila en `_INDEX.md` dice | git dice |
|---|---|---|
| WKH-313 | fila `211`: *"NO MERGEADO — pendiente orden de merge coordinado"* | `1b322e2 merge WKH-313: un agente sin historial ya puede ser elegido` |
| WKH-318 | fila `215`: *"DONE (corte A)"* + no pusheado | `6eb4f8a merge WKH-318 corte A` + `ca9ffb8 fix(merge): el doble de discover no tenía los campos que 318 volvió requeridos` |
| WKH-319 | fila `216`: *"DONE (código, en worktree — pendiente merge/decisión del founder)"* | `6a2f292 merge WKH-319: el camino que paga a los agentes deja de certificar pagos que no ocurrieron` |

El analyst encontró dos; **son tres**. Consecuencias operativas para esta HU:

- Se rama **desde `main`** tal cual está. `git status` no muestra diffs pendientes en
  `src/` (sólo directorios de doc sin trackear).
- **No hay roce de merge real** con 313/318: su código ya está en `main` y esta HU no toca
  `discovery.ts`.
- Las tres filas quedan para `nexus-docs` en el cierre (ver R-4).

### 4.8 DT-8 — Orden de validación declarado: primero la FORMA, después los VALORES

Dentro de `parseFiltersOr400`: **(1)** claves desconocidas → **(2)** conflicto de alias →
**(3)** valores (`minReputation`/`limit`/`allowTrial`). Con `allErrors: false` de facto (un
solo error por respuesta), el orden hay que elegirlo y declararlo.

Se elige forma primero porque una clave desconocida significa que el **modelo mental del
caller sobre la forma de la API está equivocado**; devolverle un error de valor sobre otro
parámetro lo manda a buscar al lugar equivocado — el mismo razonamiento que
`capability-resolver.ts:136-174` aplica al ordenar los motivos del 422 (alcance antes que
reputación, y "no pude leer" antes que "no alcanzan"). Se pinea con test (T-6).

### 4.9 DT-9 — Guardas de forma del body en POST

`request.body ?? {}` se castea hoy a `Record<string, unknown>` (`:204`). Si el body es un
**array** o un primitivo, `Object.keys` devuelve índices y el 400 diría
`unknown parameter '0'` — loud, pero incomprensible. Se agrega guarda explícita: body
ausente/`null` → `{}` (comportamiento de hoy, pineado por `discover.test.ts:199`); body que
no es objeto plano (array incluido) → 400 con mensaje propio. No se inventa un código
nuevo para esto: reusa `UNKNOWN_DISCOVER_PARAM`... **no** — usa el mismo `code` sería
mentir sobre la causa; se emite `code: 'INVALID_DISCOVER_BODY'`. Un código por causa.

### 4.10 Archivos a crear / modificar

| Archivo | Acción | Qué cambia |
|---|---|---|
| `src/lib/discovery-query.ts` | **modificar** (aditivo) | `ALLOWED_DISCOVER_PARAMS` (exportada), `UnknownDiscoverParamError`, `ConflictingMinReputationError`, `InvalidDiscoverBodyError`, `assertKnownDiscoverParams()`, `resolveMinReputation()`. **Nada existente se modifica** |
| `src/routes/discover.ts` | **modificar** | `parseFiltersOr400` pasa a recibir el **bag crudo** (`request.query` / body) en vez de tres campos elegidos a mano; agrega los 3 `catch` nuevos. GET y POST le pasan el bag. `Querystring`/`Body` suman `min_reputation?` |
| `src/lib/discovery-query.test.ts` | **modificar** (aditivo) | Unit tests del alias, del conflicto y de la lista blanca |
| `src/routes/discover.minreputation.test.ts` | **modificar** (aditivo) | Tests de ruta GET+POST para AC-2/AC-3/AC-5 y los pins de AC-1/AC-4 |
| `doc/INTEGRATION.md` | **modificar** | §`/discover` (alias + rechazo de desconocidos) y tabla de errores `:723` |
| `src/services/discovery.ts` | **PROHIBIDO** (CD-4) | — |
| `src/services/capability-resolver.ts`, `src/routes/compose.ts` | **PROHIBIDO** (CD-1) | — |

### 4.11 Flujo principal (post-fix)

```
GET /discover?min_reputation=2&capabilities=remittance-payout
  │
  ├─ assertKnownDiscoverParams(request.query)         → todas conocidas, sigue
  ├─ resolveMinReputation(undefined, '2')             → 2      (CD-2: parseMinReputation)
  ├─ parseLimit / parseAllowTrial                     → sin cambios
  └─ discoveryService.discover({ minReputation: 2, ... })
         └─ pipeline IDÉNTICO al de hoy → applyReputationFloor → excluded.reputation
```

Byte-idéntico a lo que hoy produce `?minReputation=2`. Ese es el punto de AC-3.

### 4.12 Flujos de error

| Request | Hoy | Después | Código |
|---|---|---|---|
| `?min_reputation=2` | 200, sin filtrar (23) | 200, **filtrando** (0 para `remittance-payout`) | — |
| `?capability=x` | 200 con el catálogo entero | **400**, mensaje nombra `capabilities` | `UNKNOWN_DISCOVER_PARAM` |
| `?bogusparam=zzz` | 200 | **400** | `UNKNOWN_DISCOVER_PARAM` |
| `?minReputation=1&min_reputation=5` | 200 con piso 1 | **400** | `CONFLICTING_MIN_REPUTATION` |
| `?minReputation=1&min_reputation=1` | 200 | 200, piso 1 | — |
| `?min_reputation=abc` | 200 sin filtrar | **400** | `INVALID_MIN_REPUTATION` (CD-2) |
| `POST` body `[1,2]` | 200 con filtros vacíos | **400** | `INVALID_DISCOVER_BODY` |
| `?capability=x&minReputation=abc` | 200 | **400** por la clave | `UNKNOWN_DISCOVER_PARAM` (DT-8) |

Shape del cuerpo: `{ error, code }`, idéntico al que ya emite `parseFiltersOr400`
(`routes/discover.ts:50`) y verificado en prod en §3.2 (F).

---

## 5. Plan de tests (>= 1 por AC, con el mutante que mata a cada uno)

Naming: unitarios `T-U*` en `src/lib/discovery-query.test.ts`; de ruta `T-R22+` en
`src/routes/discover.minreputation.test.ts` (continúa la numeración existente, que llega
a `T-R21`).

### 5.1 Cobertura por AC

| AC | Test | Qué afirma | Mutante que debe matar |
|---|---|---|---|
| **AC-1** | `T-R22` | `?minReputation=7` sigue llegando al service como `7` y la respuesta serializa `excluded.reputation` | Quitar `minReputation` del objeto pasado a `discover` |
| **AC-1** | `T-R23` | `POST { minReputation: 7 }` idem (simetría GET/POST) | Wirear sólo el GET |
| **AC-2** | `T-R24` | `?min_reputation=2` llama a `discover` con `{ minReputation: 2 }` — **no** con `undefined` | Devolver `undefined` cuando sólo viene el snake |
| **AC-2** | `T-R25` | `?min_reputation=2` y `?minReputation=2` producen **el mismo objeto** de llamada y la misma respuesta | Cualquier divergencia entre los dos caminos |
| **AC-2** | `T-R26` | `?capability=remittance-payout` → **400**, el mensaje contiene `capabilities`, y `mockDiscover` **no** fue llamado | Aceptar claves desconocidas |
| **AC-2** | `T-R27` | `?bogusparam=zzz` → 400 (la clase, no sólo el near-miss) | Lista blanca implementada como "rechazo sólo lo que se parece" |
| **AC-3** | `T-U1` | `resolveMinReputation('5', undefined) === resolveMinReputation(undefined, '5') === 5` | Parseo distinto por rama |
| **AC-3** | `T-U2` | Ambos con valores distintos → `ConflictingMinReputationError` con `code: 'CONFLICTING_MIN_REPUTATION'` | "gana el camelCase" |
| **AC-3** | `T-U3` | Ambos con el **mismo** valor (incluido `'5'` vs `5`) → `5`, sin lanzar | Comparar los crudos en vez de los normalizados |
| **AC-3** | `T-U4` | `('5', '')` → `5` (vacío = ausente, no conflicto) | Tratar `''` como presente |
| **AC-3** | `T-R28` | Ruta: `?minReputation=1&min_reputation=5` → 400 sin fanout | — |
| **AC-4** | `T-R29` | Con el service devolviendo `excluded.standingUnavailable: true` y `agents: []`, **los dos nombres** producen la misma respuesta fail-closed | Un alias que "ablande" el piso (p. ej. mandando `0` en vez del valor) |
| **AC-5** | `T-R30` | **Enumeración LITERAL** de los 10 parámetros públicos (escritos a mano, uno por uno, no derivados de la constante): cada uno con un valor válido → 200 | Sacar una clave de la lista blanca |
| **DT-8** | `T-R31` | `?capability=x&minReputation=abc` → 400 con `UNKNOWN_DISCOVER_PARAM` (forma antes que valor) | Invertir el orden |
| **DT-9** | `T-R32` | `POST` con body array → 400 `INVALID_DISCOVER_BODY`; `POST` con body vacío → 200 (pin de `discover.test.ts:199`) | Guarda ausente |
| **CD-2** | `T-U5` | `resolveMinReputation(undefined, 'abc')` lanza `InvalidMinReputationError` (**no** un error nuevo) | Validador duplicado para el alias |
| **borde** | `T-R33` | `?minReputation=1&minReputation=1` (repetido ⇒ array) → 400 `INVALID_MIN_REPUTATION`, como hoy | Aplanar arrays "para ser amable" |

### 5.2 La regla del test que NO puede medir aire (auto-blindaje 313/319 → CD-10)

`T-R30` es el caso peligroso. Si se escribiera iterando `ALLOWED_DISCOVER_PARAMS`, mediría
la constante contra sí misma: agregar `pepito` a la lista haría que el test **pase** y
afirme que `pepito` es público. **Debe enumerar los nombres a mano**, tomados de
`doc/INTEGRATION.md` y de la firma de `request.query` — dos fuentes que no son la
constante. `T-R26/T-R27` (negativos) sí pueden apoyarse en la constante: ahí el sesgo va en
la dirección segura.

### 5.3 Disciplina de mutación (obligatoria)

Antes de declarar F3 terminado, correr a mano los mutantes de la columna derecha y
verificar que **cada uno mata al menos un test nombrado**. Un mutante que sobrevive es un
test que no prueba lo que dice, y en este repo ya pasó tres veces en una sola HU
(auto-blindaje WKH-313).

---

## 6. Scope

### 6.1 IN

- `src/lib/discovery-query.ts` — sólo **agregados**
- `src/routes/discover.ts` — `parseFiltersOr400` + los dos handlers raíz + los tipos
- `src/lib/discovery-query.test.ts`, `src/routes/discover.minreputation.test.ts`
- `doc/INTEGRATION.md` — §`/discover` + tabla de errores

### 6.2 OUT

- **Todo `/compose`** (`capability-resolver.ts`, `compose.ts`, `compose-step-shape.ts`) — CD-1
- **`applyReputationFloor` y el carril de estreno** en `discovery.ts` — CD-4
- **`GET /discover/:slug`** — DT-6 / TD-322-1
- Renombrar `constraints.min_reputation` — DT-2
- Aliasar `capability` u otro parámetro — DT-5
- Aliasar `verified`/`includeInactive` o endurecer su coerción `=== 'true'` — deuda
  TD-322-2 (misma clase: `?verified=1` hoy es `undefined` en silencio). **Fuera**: cambia
  el significado de valores, no de nombres, y nadie lo midió
- `chaski-v3`, `wasiai-facilitator`, `wasiai-remittance-agents` — prohibido
- Arreglar la reputación de `remit-cashout-payout-solana` o el piso de chaski-v3 — R-2
- Corregir `_INDEX.md` (3 filas) y pegar `_INDEX-row.md` — R-4, es de `nexus-docs`

---

## 7. Constraint Directives

### 7.1 Heredadas del work-item (vigentes sin cambios)

- **CD-1**: PROHIBIDO tocar `src/services/capability-resolver.ts`, `src/routes/compose.ts`
  o cualquier lectura de `constraints.min_reputation`. Ya filtra bien y es money-adjacent.
- **CD-2**: OBLIGATORIO reusar `parseMinReputation` como **único** validador de rango
  `[0,100]` para **los dos** nombres. PROHIBIDO duplicar la lógica: un alias con su propio
  parseo divergiría y reabriría la clase que el fix-pack P1 cerró. Test: `T-U5`.
- **CD-3**: PROHIBIDO agregar queries/RPC nuevas. El camino sin parámetro de reputación
  debe seguir con el mismo costo de I/O, byte por byte. Todo lo que agrega esta HU es
  in-process y O(claves de la request).
- **CD-4**: PROHIBIDO modificar `applyReputationFloor` o el carril de estreno. Sólo se
  toca la capa de PARSEO/VALIDACIÓN.

### 7.2 Nuevas de este SDD

- **CD-5**: PROHIBIDO implementar el rechazo de claves desconocidas con un `schema` de
  Fastify / `additionalProperties: false`. Con los defaults de esta app
  (`removeAdditional: true`, verificado en DT-3) **borraría** las claves en silencio: sería
  un silencio peor que el actual. Va en código de aplicación.
- **CD-6**: OBLIGATORIO que GET y POST pasen por el **mismo** helper
  (`parseFiltersOr400`). Es la razón por la que ese helper existe (ver el comentario de
  WKH-313 en `routes/discover.ts:39-42`: *"un flag que sólo se valida en GET deja al otro
  camino aceptando basura por el mismo endpoint"*). Todo test nuevo de ruta tiene su
  gemelo POST.
- **CD-7**: PROHIBIDO agregar sinónimos más allá de `min_reputation`, y PROHIBIDO el
  matcheo difuso / "quisiste decir X" por distancia de edición. Un alias con causa
  documentada (DT-1); el resto, 400 (DT-5).
- **CD-8**: OBLIGATORIO que la actualización de `doc/INTEGRATION.md` (W2) entre en el
  **mismo PR/merge** que el wiring (W1). AC-5 exige documentar antes de activar; partirlo
  en dos merges dejaría, en `main`, o un doc que promete lo que el código no hace, o un
  código que rompe callers sin contrato publicado. Las dos son inaceptables.
- **CD-9** *(auto-blindaje: WKH-319 + WKH-313)*: PROHIBIDO escribir comentarios o docstrings
  que afirmen propiedades universales no verificables con un input concreto. Cada frase
  del código nuevo tiene que ser falsable. Nada de *"esto garantiza que siempre..."* sin
  el test que lo clava al lado. Un comentario seguro de sí mismo apaga las tres revisiones
  siguientes; ya costó cinco iteraciones en una HU de este repo.
- **CD-10** *(auto-blindaje: WKH-313 x3, WKH-319)*: PROHIBIDO que un test derive su
  expectativa de la misma constante que verifica. `T-R30` enumera los parámetros públicos
  **literalmente**. Tres copias de un razonamiento no son tres verificaciones.
- **CD-11** *(auto-blindaje: WKH-315)*: antes de estimar el impacto de cambiar la firma de
  `parseFiltersOr400`, grepear los **call-sites y los casts**, no sólo los valores. Un
  `as` en un test es una dependencia invisible para un grep por valor.
- **CD-12** *(auto-blindaje: WKH-318)*: si F3 corre en un worktree nuevo, **verificar que
  `node_modules/` existe antes de leer cualquier `tsc --noEmit` como baseline**. Un `TS2307`
  masivo sobre paquetes de terceros casi nunca es "la rama está rota".
- **CD-13**: PROHIBIDO cambiar el shape del cuerpo de error. Sigue siendo `{ error, code }`,
  igual que los tres 400 que la ruta ya emite.

---

## 8. Riesgos, dependencias y deuda declarada

| ID | Riesgo | Estado de verificación | Mitigación / dueño |
|---|---|---|---|
| **R-1** | El 400 sobre claves desconocidas rompe a un integrador externo que hoy manda parámetros extra inertes y recibe 200 | **Radio interno medido = 0** (§3.4: 0 tests, 0 scripts, 0 callers, 0 ejemplos públicos). Radio externo **no enumerable** | Mensaje accionable (nombra la clave y lista las válidas) + `INTEGRATION.md` en el mismo merge (CD-8). **Disparador de reversión**: si post-deploy aparecen 400 `UNKNOWN_DISCOVER_PARAM` de un caller real, la respuesta NO es apagar el guard sino agregar el nombre a la lista si es legítimo, o avisar al integrador si es un typo |
| **R-2** | 🔴 `remit-cashout-payout-solana` es el **único** agente con `remittance-payout` y queda excluido por cualquier piso `>= 1` ⇒ `/compose` con `min_reputation: 2` (constante de chaski-v3) devuelve **422 `excluded_by_reputation`** y el leg de entrega de valor no resuelve | **MEDIDO hoy contra prod, no inferido** (§3.3): 1 candidato, `computedReputation: null`, `standingUnavailable: false`, `total 0` con piso 1. La cadena hasta el 502 de chaski está documentada en `doc/roadmap/2026-08-incubadora-solana-checklist.md` §0.3 | **Fuera del alcance de esta HU** (CD-1). Salida existente y medida: `allow_trial: true` lo admite por el carril de WKH-313 (`trial.granted`, `remaining_settled_tasks: 3`). Es **decisión de producto del founder**, no de dev. Se cruza con el hallazgo abierto sobre el piso 2 y el carril de estreno (WKH-313) |
| **R-3** | Esta HU **hace visible** R-2: un integrador que hoy investiga con `?min_reputation=2` ve 23 agentes y después verá 0 | Consecuencia directa y deseada del fix | No mitigar. Un diagnóstico correcto no es una regresión. `excluded.reputation` explica el vacío, y `allowTrial` está documentado en `INTEGRATION.md:270-320` |
| **R-4** | `doc/sdd/_INDEX.md` tiene **3** filas desactualizadas (`211` WKH-313, `215` WKH-318, `216` WKH-319 dicen "no mergeado" y git dice que sí — DT-7), y la fila de ESTA HU quedó sin pegar, en `doc/sdd/217-.../_INDEX-row.md`, porque el analyst no tuvo herramienta de edición | Verificado con `git log --oneline main` (DT-7) | **Para `nexus-docs` en el cierre.** No lo arregla ni el Architect ni el Dev. Que quede escrito acá es lo que impide que se pierda |
| **R-5** | Dos nombres para el mismo parámetro, para siempre | Decisión consciente (DT-1) | Deuda **TD-322-3**. La convergencia real (un solo nombre) exigiría romper `/compose`, verificado como inviable en DT-2 |
| **TD-322-1** | `GET /discover/:slug` sigue descartando query params desconocidos en silencio | Verificado (`routes/discover.ts:247-268`) | Deuda declarada, fuera de alcance (DT-6) |
| **TD-322-2** | `verified` / `includeInactive` colapsan todo lo que no sea `'true'` a `undefined`: `?verified=1` y `?verified=TRUE` se ignoran en silencio | Verificado (`routes/discover.ts:168-169`) | Misma clase, pero sobre VALORES y no sobre nombres. Deuda declarada |

**Dependencias**: ninguna. No depende de WKH-314/315/316 (superficies distintas), no
depende de decisiones del founder sobre dinero real, no toca banderas de money-path.

---

## 9. Missing Inputs / marcadores de incertidumbre

| ID | Estado |
|---|---|
| **MI-1** (alias vs 400) | ✅ **RESUELTO** en F2 → DT-1: **las dos, en el mismo cambio** |
| **MI-2** (¿deploy-lag en Railway?) | ✅ **RESUELTO** por medición (§3.2 F): `?minReputation=abc` devuelve 400 `INVALID_MIN_REPUTATION` con el mensaje de escala 0-100, que sólo existe post-fix-pack-P1. **No hay deploy-lag** |
| **MI-3** (filas de `_INDEX.md`) | ✅ **RESUELTO** por git (DT-7). Son **tres**, no dos. Queda para `nexus-docs` (R-4) |
| Parámetros cosméticos (`utm_*`) | ✅ **DECIDIDO** en DT-1: sin excepciones. Reversible, con disparador en R-1 |

**No queda ningún `[NEEDS CLARIFICATION]` abierto.**

---

## 10. Plan de implementación (Waves)

### W0 — Contrato y validadores (SERIAL, obligatoria, sin tocar rutas)

Todo en `src/lib/discovery-query.ts` (aditivo puro: no se modifica una línea existente).

- **W0.1** `ALLOWED_DISCOVER_PARAMS: ReadonlySet<string>` **exportada**, con las 10 claves
  de DT-6. Docstring con la razón de cada excepción, siguiendo el modelo de
  `ALLOWED_STEP_CONSTRAINTS` (`compose-step-shape.ts:39-57`) — incluida la advertencia de
  que agregar una clave es decisión de producto.
- **W0.2** `UnknownDiscoverParamError` (`code: 'UNKNOWN_DISCOVER_PARAM'`, guarda
  `received`), `ConflictingMinReputationError` (`code: 'CONFLICTING_MIN_REPUTATION'`),
  `InvalidDiscoverBodyError` (`code: 'INVALID_DISCOVER_BODY'`). Mismo patrón que las tres
  clases existentes (`:25-33`, `:74-80`, `:124-132`).
- **W0.3** `assertKnownDiscoverParams(raw: Record<string, unknown>): void` — determinista:
  recorre las claves **en el orden en que llegaron** y lanza en la primera desconocida
  (nada de `Object.keys().sort()`, que reportaría una clave distinta de la que el caller
  leería primero). El mensaje nombra la clave ofensora **y** enumera las aceptadas.
- **W0.4** `resolveMinReputation(camelRaw, snakeRaw)` exactamente como DT-4.
- **W0.5** Unit tests `T-U1..T-U5`.
- **Criterio de terminado**: `npx tsc --noEmit` **limpio** (esta wave es puramente aditiva
  y no vuelve requerido ningún campo de un tipo compartido, así que el problema de W0 de
  WKH-318 no aplica acá — verificado: ningún tipo existente cambia) + `T-U*` en verde.

### W1 — Wiring en la ruta (depende de W0)

- **W1.1** `parseFiltersOr400` cambia de firma: recibe el **bag crudo** en vez de tres
  campos elegidos a mano. **Antes de tocarla, aplicar CD-11**: grepear sus call-sites (hoy
  son 2: `:153` y `:220`) y cualquier cast.
- **W1.2** Dentro del helper, en el orden de DT-8: `assertKnownDiscoverParams` →
  `resolveMinReputation` → `parseLimit`/`parseAllowTrial`. Los tres `catch` nuevos se
  suman a la cadena `instanceof` existente (`:45-52`).
- **W1.3** GET (`:151-158`): pasar `request.query` completo. Sumar `min_reputation?: string`
  al tipo `Querystring`.
- **W1.4** POST (`:204-225`): guarda de forma del body (DT-9), pasar el bag. Sumar
  `min_reputation?: number` al tipo `Body`.
- **W1.5** Tests de ruta `T-R22..T-R33`.
- **Criterio de terminado**: `npx tsc --noEmit` limpio + **la suite completa en verde**
  (no sólo los archivos tocados — auto-blindaje: *"sólo lo vi porque corrí la suite
  COMPLETA"*) + los mutantes de §5.3 corridos y muertos.

### W2 — Contrato público (misma PR que W1 — CD-8)

- **W2.1** `doc/INTEGRATION.md` §`/discover`: `min_reputation` como alias aceptado, la
  frase de DT-2 (*el único nombre que sirve en las dos superficies es `min_reputation`*),
  y el rechazo de claves desconocidas con la lista completa de aceptadas.
- **W2.2** Tabla de errores (`:721-731`): filas para `UNKNOWN_DISCOVER_PARAM`,
  `CONFLICTING_MIN_REPUTATION`, `INVALID_DISCOVER_BODY`. Alcance acotado: **se permite**
  completar en la misma fila los códigos ya existentes que el doc omite
  (`INVALID_LIMIT`, `INVALID_ALLOW_TRIAL`) porque es la misma celda y hoy está incompleta.
  Nada más.
- **Criterio de terminado**: cada afirmación nueva del doc corresponde a un test nombrado
  de §5 (CD-9: prosa falsable).

**Paralelismo**: W0 → W1 → W2 es estrictamente serial (W2 puede redactarse en paralelo a
W1, pero no mergear sin él). No hay waves paralelizables: la HU toca 2 archivos de
producción.

---

## 11. Readiness Check

| # | Ítem | Estado |
|---|---|---|
| 1 | Todos los archivos referenciados existen y fueron leídos (no inferidos) | ✅ 15 archivos, §3.1 |
| 2 | Todo path citado verificado con Read/Glob/Grep | ✅ incluido `node_modules/@fastify/ajv-compiler/README.md:23-36` |
| 3 | Los ACs del work-item tienen >= 1 test cada uno | ✅ AC-1 (T-R22/23), AC-2 (T-R24..27), AC-3 (T-U1..4, T-R28), AC-4 (T-R29), AC-5 (T-R30) |
| 4 | Cada test tiene su mutante declarado | ✅ §5.1, columna derecha |
| 5 | Missing Inputs bloqueantes resueltos | ✅ MI-1 (DT-1), MI-2 (medición), MI-3 (git) |
| 6 | CDs del work-item heredadas | ✅ CD-1..CD-4 textuales en §7.1 |
| 7 | CDs nuevas derivadas del Auto-Blindaje histórico | ✅ CD-9..CD-12, con la HU de origen citada |
| 8 | W0 serial definida y sin dependencias | ✅ §10, sólo módulo leaf |
| 9 | Impacto sobre la suite existente medido, no estimado | ✅ §3.4: 14 query strings, 0 romperían |
| 10 | Decisión de MI-1 fundamentada contra el criterio del proyecto, con su costo | ✅ DT-1 |
| 11 | Tercera opción (unificar convención) evaluada y verificada antes de rechazarla | ✅ DT-2 |
| 12 | Riesgo del agente de payout incorporado con su estado de verificación | ✅ R-2, **medido** (§3.3) |
| 13 | Nota de proceso sobre `_INDEX-row.md` sin pegar | ✅ R-4 |
| 14 | Sin `[NEEDS CLARIFICATION]` abiertos | ✅ §9 |
| 15 | Sin código de producción escrito en esta fase | ✅ este SDD no toca `src/` |

**Veredicto: LISTO PARA `SPEC_APPROVED`.**

---

## 12. Nota de proceso (para `nexus-docs`, no para el Dev)

1. La fila de índice de esta HU quedó en `doc/sdd/217-wkh-322-discover-min-reputation-param-naming/_INDEX-row.md`
   y **no está pegada** en `doc/sdd/_INDEX.md` (el analyst no tuvo herramienta de edición).
2. Al pegarla hay que **actualizarla**: dice "in progress (F1 — esperando HU_APPROVED)" y
   afirma que DT-2 (filas desactualizadas) sigue pendiente de verificar. Ya se verificó
   (DT-7) y son **tres** filas, no dos.
3. Las filas `211`, `215` y `216` de `_INDEX.md` dicen "no mergeado" y git dice lo
   contrario (DT-7). Son **tres casos nuevos** del patrón que el propio `_INDEX.md` ya
   documenta: la corrección del `2026-07-29` sobre el fix-pack `9f17f16` deja registrado
   que *"un F1 planificó sobre ese estado viejo, recomendando esperar un merge que ya
   había ocurrido"*, y remite a la nota final *"Un estado desactualizado acá hace
   planificar mal"* (verificado en el archivo, no citado de segunda mano). El F1 de esta
   HU estuvo a punto de repetirlo: su análisis de paralelismo recomienda "resolver primero
   DT-2 antes de abrir esta rama".
