# Work Item — [WKH-322] `/discover` ignora en silencio `min_reputation` (snake_case) porque el filtro real sólo reconoce `minReputation` (camelCase)

## Resumen

`/discover` (GET y POST) **ya tiene** un filtro de reputación mínima real y
probado — no es un parámetro fantasma como planteaba el encargo original. Fue
implementado por el fix-pack P1 "hallazgo 2" (mergeado a `main`, commit
`6373dd8`, fila `189` de `_INDEX.md`) y extendido por WKH-313 (carril de
estreno para agentes nuevos). El problema real, verificado hoy contra el
código, es otro: **el filtro sólo responde al nombre `minReputation`
(camelCase)**, mientras que el mismo protocolo — en `/compose`, dentro de
`constraints` — usa `min_reputation` (snake_case) para exactamente la misma
capacidad. Fastify no valida querystring/body no declarados en estas dos
rutas, así que un caller que llega a `/discover` con la convención de
`/compose` (`?min_reputation=2`) no obtiene ni el filtro ni un error: la
request se procesa como si el parámetro no existiera. Esto reproduce, byte a
byte, lo medido hoy contra producción (`23/23/23/23` idénticos con
`min_reputation=0/1/2/3`) y la ausencia de campo de reputación en el agente
volcado (es self-published, sin historial: ni `reputation` auto-reportado ni
`computedReputation` calculado se adjuntan).

Esta HU acota el trabajo a: (1) cerrar el silencio de nombre equivocado en
`/discover` con una decisión explícita (alias o 400), y (2) dejar
regression-pinned, con test, lo que YA funciona hoy para que nadie lo rompa
creyendo que "no existía".

## Evidencia medida hoy (2026-08-04) — para no reabrir lo ya cerrado

```
GET /discover?capability=remittance-payout                   -> 23 agentes
GET /discover?capability=remittance-payout&min_reputation=1  -> 23 agentes
GET /discover?capability=remittance-payout&min_reputation=2  -> 23 agentes
GET /discover?capability=remittance-payout&min_reputation=3  -> 23 agentes
```

Las cuatro respuestas idénticas **no prueban que el filtro esté ausente**:
prueban que `min_reputation` (snake_case) nunca llega a
`query.minReputation` en `src/routes/discover.ts:141` (el tipo de
Querystring sólo declara `minReputation`), así que
`parseMinReputation(undefined)` devuelve `undefined` (sin filtrar,
`src/lib/discovery-query.ts:44-45`) para las cuatro requests por igual.

## Evidencia de código (F0, este mismo árbol de trabajo, sin diffs pendientes)

- El validador real: `src/lib/discovery-query.ts:12-57` (`parseMinReputation`,
  rango `[0,100]`, 400 `INVALID_MIN_REPUTATION` si es inválido).
- El filtro real: `src/services/discovery.ts:529-591`
  (`applyReputationFloor`, corre pre-sort/pre-slice, fail-closed si el batch
  de reputación está degradado).
- El wiring de la ruta: `src/routes/discover.ts:133-241` (GET y POST, mismo
  helper `parseFiltersOr400`).
- La misma capacidad, con el OTRO nombre, en `/compose`:
  `src/services/capability-resolver.ts:110-112` — `constraints.min_reputation`
  (snake_case) se mapea a `query.minReputation` y llama al MISMO
  `discoveryService.discover`. O sea: la funcionalidad es una sola; lo que
  difiere es el nombre expuesto en cada superficie.
- Confirmado que ninguna de las dos rutas de `/discover` declara `schema` de
  Fastify para querystring/body (`src/routes/discover.ts:133-174`,
  `:186-241`): un parámetro con nombre no reconocido no genera error, se
  descarta en silencio. Esto es genérico, no exclusivo de `min_reputation` —
  ver DT-3 y AC-5.
- `mapRowToAgent` (self-published, `src/services/agent.ts:125-149`) nunca
  setea `reputation`; y `computedReputation` sólo se adjunta si hay score
  real (`discovery.ts:1024-1031`). Un agente self-published sin historial —
  como el volcado hoy — no trae ningún campo de reputación por diseño, no
  por bug. Esto explica la segunda mitad de lo observado hoy.

## Sizing

- SDD_MODE: mini (superficie acotada a validación/naming de parámetros de una
  ruta ya existente; el motor de filtrado NO se toca — CD-4)
- Metodología: **QUALITY** (superficie pública del protocolo, repo auditado
  por el mentor de la incubadora Solana)
- Estimación: S/M
- Branch sugerido: `feat/217-wkh-322-discover-reputation-param-naming`

## Acceptance Criteria (EARS)

- **AC-1** (regresión, ya implementado — pin, no reconstruir): WHILE un
  caller envía `minReputation` con un valor numérico en `[0,100]` a `GET` o
  `POST /discover`, the system SHALL excluir de `agents` todo agente cuyo
  `computedReputation.score` sea menor a ese valor y SHALL reportar la
  cantidad excluida en `excluded.reputation`. Evidencia:
  `discovery.ts:577-591`, `discovery-query.ts:44-57`. Este AC existe para que
  F3/F4 verifiquen con test que sigue siendo cierto DESPUÉS del cambio de
  parseo, no para reimplementarlo.

- **AC-2** (evento no deseado — el núcleo de esta HU): IF un caller envía a
  `GET`/`POST /discover` un parámetro llamado `min_reputation` (snake_case —
  la misma convención que `constraints.min_reputation` de `/compose`,
  `capability-resolver.ts:110-112`), THEN the system SHALL NOT devolver una
  respuesta indistinguible de la de una request sin ningún filtro de
  reputación. Según la decisión de F2 (ver Missing Inputs / recomendación),
  SHALL o bien (a) tratarlo como alias válido de `minReputation` y filtrar de
  verdad, o (b) rechazar la request con HTTP 400 y un mensaje que nombre
  explícitamente el parámetro correcto (`minReputation`).

- **AC-3** (evento, condicional a que F2 elija alias): WHEN la decisión de F2
  es "alias", the system SHALL producir resultados IDÉNTICOS (mismo array
  `agents`, mismo `excluded.reputation`) entre `?minReputation=N` y
  `?min_reputation=N` para el mismo `N` y el mismo estado del catálogo. Si
  ambos se envían a la vez con valores distintos, the system SHALL resolver
  la precedencia de forma DECLARADA (no implícita) y devolverla en la
  respuesta o documentarla — no dejarla a un orden de evaluación accidental.

- **AC-4** (regresión, no deseado — pin): IF el batch de reputación no puede
  leerse (`standingBatch.degraded === true`), THEN el filtro — por
  cualquiera de los dos nombres aceptados tras esta HU — SHALL seguir siendo
  fail-closed (excluye a todos los agentes bajo `minReputation > 0`).
  Evidencia hoy: `discovery.ts:544-546`, `:704-712`. Esta HU NO debe
  debilitar este comportamiento.

- **AC-5** (opcional, alcance a decidir en F2): WHERE F2 decide ampliar la
  validación más allá de `min_reputation` (por ejemplo, rechazar CUALQUIER
  querystring/body key no reconocida en `/discover`), the system SHALL
  documentar el cambio de contrato en `doc/INTEGRATION.md` ANTES de
  activarlo — es un cambio que puede romper callers existentes que hoy mandan
  parámetros extra inocuos y son ignorados sin daño.

## Scope IN

- `src/routes/discover.ts` — parseo de query (GET) y body (POST), el helper
  `parseFiltersOr400`
- `src/lib/discovery-query.ts` — validador(es) de `minReputation` /
  eventual alias `min_reputation`
- Tests de la ruta (`src/routes/discover.test.ts` o equivalente) — casos
  nuevos de AC-2/AC-3, más el test de regresión que fija AC-1/AC-4
- `doc/INTEGRATION.md` si la documentación pública de `/discover` necesita
  reflejar el nombre aceptado (hoy puede estar incompleta o inconsistente
  con `/compose` — verificar en F2)

## Scope OUT

- `src/services/capability-resolver.ts` y el camino `/compose` en general —
  YA filtra correctamente por `constraints.min_reputation`; es
  money-adjacent (decide qué agente cobra) y esta HU es estrictamente sobre
  `/discover` (CD-1)
- `src/services/discovery.ts` → `applyReputationFloor` y el carril de
  estreno (WKH-313) — el MOTOR del filtro no se re-diseña, sólo su capa de
  parseo de nombres de parámetro (CD-4)
- Renombrar `constraints.min_reputation` de `/compose` a camelCase — sería
  un breaking change para consumidores externos ya integrados (chaski-v3,
  WayLearn); ni siquiera se evalúa acá
- Cualquier cambio en `chaski-v3`, `wasiai-facilitator`,
  `wasiai-remittance-agents` — prohibido explícitamente para este agente
- Verificar o forzar el estado del deploy de Railway — es operacional, fuera
  de lo que un cambio de código puede resolver (ver Missing Inputs MI-2)
- Actualizar `doc/sdd/_INDEX.md` filas 211 (WKH-313) y 215 (WKH-318) — anotado
  como hallazgo (DT-2), no bloqueante para esta HU, delegable a `nexus-docs`
  en el cierre

## Decisiones técnicas (DT-N)

- **DT-1**: El encargo original ("`/discover` acepta `min_reputation` y no
  filtra nada") describe un síntoma real pero con una causa distinta a la
  asumida. El filtro no es un parámetro fantasma: existe, está mergeado a
  `main` (fix-pack P1 hallazgo-2, commit `6373dd8`) y fue extendido por
  WKH-313. La medición de hoy usó `min_reputation` (snake_case), un nombre
  que la ruta nunca leyó bajo ningún commit — reproduce "se ignora en
  silencio" pero por nombre equivocado, no por filtro ausente. Ver evidencia
  de código arriba.

- **DT-2 (hallazgo, no bloqueante, pero relevante para planificar el merge)**:
  `doc/sdd/_INDEX.md` tiene DOS filas que describen `discovery.ts`/
  `discover.ts` como **no mergeadas a `main`**, y el código de ambas YA está
  presente en este árbol de trabajo sin diffs pendientes según `git status`
  al momento de este F0:
  - Fila `211` (WKH-313, fecha 2026-07-30): "NO MERGEADO — pendiente orden
    de merge coordinado". El carril de estreno (`allowTrial`, `standingFor`,
    trial-lane completo) está en `discovery.ts` hoy.
  - Fila `215` (WKH-318, fecha 2026-07-30): "no mergeado/pusheado a `main`,
    decisión pendiente del founder". Los campos `sources[]`/`catalogStatus`/
    `registries` (contrato de honestidad del catálogo) están en
    `discovery.ts` hoy (`:644-715`).

  Es el mismo patrón de "estado desactualizado" que el propio `_INDEX.md`
  documenta y advierte en su sección final ("Un estado desactualizado acá
  hace planificar mal"), ahora con DOS casos nuevos. No lo resuelvo acá — lo
  dejo anotado para que Architect/QA lo reverifiquen con
  `git log --oneline main` / `git merge-base --is-ancestor <rama> main`
  antes de asumir que WKH-313/WKH-318 siguen sin mergear, y para que
  `nexus-docs` corrija esas dos filas al cerrar esta HU o una de docs
  separada.

- **DT-3**: Fastify no valida querystring/body no declarados en ninguna de
  las dos rutas de `/discover` (no hay `schema:` en el registro de la ruta).
  Esto es genérico: CUALQUIER nombre de parámetro mal escrito (no sólo
  `min_reputation`) se descarta en silencio hoy — `allow_trial`,
  `max_price`, `include_inactive` tendrían el mismo problema si alguien los
  escribe con la convención equivocada. Esta HU cierra el caso concreto
  medido (`min_reputation`); si F2 quiere cerrar la clase completa, es
  AC-5 (opcional, con su propio costo de compatibilidad).

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO tocar `src/services/capability-resolver.ts`,
  `src/routes/compose.ts` o cualquier lectura de `constraints.min_reputation`
  en el camino de `/compose`. Ese camino ya filtra correctamente y es
  money-adjacent (selecciona el agente que cobra); esta HU es estrictamente
  sobre la superficie `/discover`.

- **CD-2**: OBLIGATORIO reusar `parseMinReputation`
  (`discovery-query.ts:44-57`) como único validador de rango `[0,100]` para
  cualquier nombre aceptado (alias incluido). PROHIBIDO duplicar la lógica de
  validación: un alias con su propio parseo divergería del original y
  reabriría exactamente la clase de bug que el fix-pack P1 ya cerró (un
  `NaN` o un fuera-de-rango que "cuela" por el camino nuevo).

- **CD-3**: PROHIBIDO agregar queries/RPC nuevas al camino SIN ningún
  parámetro de reputación (ni camelCase ni snake_case) — mismo principio que
  ya gobierna `allowTrial` (CD-9 de WKH-313): si el caller no pide nada, el
  costo de I/O de `/discover` debe seguir siendo byte-idéntico al de hoy.

- **CD-4**: PROHIBIDO modificar `applyReputationFloor` o cualquier lógica del
  carril de estreno en `src/services/discovery.ts`. Sólo se toca la capa de
  PARSEO/VALIDACIÓN de nombres de parámetro en `routes/discover.ts` y
  `lib/discovery-query.ts`. El motor de filtrado no se re-diseña en esta HU.

## Missing Inputs

- **[bloqueante para F2]** MI-1: ¿alias snake_case o 400 fail-loud
  (AC-2/opciones a/b)? No hay instrucción del founder al respecto. Ver
  recomendación del Analyst abajo — no vinculante, decisión formal en F2.
- **[bloqueante para F2, verificación no de diseño]** MI-2: confirmar contra
  producción (Railway) que el commit desplegado hoy incluye el fix-pack P1
  hallazgo-2 (`minReputation` funcional), repitiendo la medición con el
  nombre CORRECTO (`?minReputation=2`, no `min_reputation`). Sin esto no se
  puede descartar que, ADEMÁS del nombre equivocado, haya un deploy-lag real
  entre `main` y Railway.
- **[no bloqueante, resuelto como DT-2]** MI-3: reconciliar las filas 211
  (WKH-313) y 215 (WKH-318) de `_INDEX.md` con el estado real del árbol de
  trabajo.

## Recomendación del Analyst (no vinculante)

Para AC-2: **alias** (`min_reputation` como sinónimo válido de
`minReputation` en `/discover`, mismo validador). Motivos: (i) es la MISMA
capacidad semántica que ya existe con ese nombre exacto en `/compose` —
tratarla como "no soportada" en `/discover` sería fingir una distinción que
no existe en el protocolo; (ii) reduce la sorpresa de un caller que integra
ambos endpoints de la misma API; (iii) alias y 400-para-nombres-desconocidos
no son mutuamente excluyentes — F2 puede elegir alias para este caso
concreto Y, por separado, decidir sobre AC-5 (rechazar cualquier OTRO nombre
no reconocido) si quiere cerrar la clase completa del bug.

## Análisis de paralelismo

- Roce de merge con WKH-313 (fila 211) y con WKH-318 (fila 215) —
  ambas tocan `discovery.ts`/`discover.ts`, y según DT-2 puede que YA estén
  en `main` (a reverificar). Recomendado: resolver primero DT-2 (confirmar
  con git qué está realmente mergeado) antes de abrir esta rama, para partir
  de un `main` estable y evitar reabrir un archivo que otra HU esté tocando
  en paralelo.
- NO bloquea ni depende de WKH-314/315/316 (Solana inbound/deposit/payment
  writer) — superficies de código distintas.
- Puede correr en paralelo con cualquier trabajo en `/compose` siempre que
  no toque `capability-resolver.ts` (CD-1 lo prohíbe explícitamente en
  ambas direcciones).
- No depende de ninguna decisión del founder sobre dinero real/mainnet — es
  código de discovery, sin banderas de money-path nuevas.
