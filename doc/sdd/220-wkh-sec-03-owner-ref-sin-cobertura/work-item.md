# Work Item — [WKH-SEC-03] Los 23 filtros por dueño que se pueden borrar con la suite entera en verde

> F1 · NexusAgil QUALITY · 2026-08-05 · autor: `nexus-analyst`
> Insumo medido: `doc/audit/deuda-tecnica-2026-08-06/A1-guards-que-no-discriminan.md`, hallazgo 0.

---

## Resumen

Los 23 `.eq('owner_ref', …)` que el reporte A1 marca como borrables **existen los 23 en el
árbol**: verifiqué cada uno leyendo su archivo:línea. Ninguno es un IDOR vivo. Lo que falta
es la prueba: borrar cualquiera de esos 23 deja las 5308 pruebas en verde, así que la única
barrera entre inquilinos que tiene este servicio no está afirmada en ningún lado y la próxima
edición la puede borrar sin fricción. Esta HU escribe esa prueba y agrega un control mecánico
que impida que la clase vuelva a aparecer.

**El corazón de la corrección al encargo**: el barrido que produjo la lista **borra líneas que
existen**, así que por construcción **no puede encontrar un filtro ausente**. Los 23 son todos
"caso 1" porque el método sólo sabe encontrar casos 1. El censo de "caso 2" es una medición
DISTINTA que **no se corrió**, y esta HU la incluye (AC-6).

---

## Sizing

- **SDD_MODE**: full (QUALITY, es la regla del repo para todo `wasiai-a2a`)
- **Estimación**: **M** para este corte. El total de los 23 sitios es **L**, y por eso se parte
  (ver "Decisión de partición").
- **Branch sugerido**: `feat/220-wkh-sec-03-owner-ref-sin-cobertura`
- **Skills de dominio** (máx. 2): `security/idor-multitenant`, `testing/mutation-y-fixtures`

---

## Los 23 sitios, verificados uno por uno

Método de esta verificación: `Read` del archivo en el rango de la línea citada, en el árbol de
`main` de `/home/ferdev/.openclaw/workspace/wasiai-a2a`. Se verifica **si el filtro está**, que
es una pregunta distinta de "qué mutación sobrevive" (lo que midió A1).

| # | archivo:línea | ¿El filtro está? | Caso | Qué protege exactamente |
|---|---|---|---|---|
| 1 | `src/services/fee-split.ts:365` | **SÍ** | 1c | SELECT de idempotencia del leg, `(orch, role, owner)` |
| 2 | `src/services/fee-split.ts:538` | **SÍ** | 1c | UPDATE `status='charged'` + `tx_hash` |
| 3 | `src/services/fee-split.ts:618` | **SÍ** | 1c | UPDATE `status='failed'` (`markLegFailed`) |
| 4 | `src/services/fee-split.ts:697` | **SÍ** | 1b | UPDATE `status='reversed'` (`reverseFeeSplits`) |
| 5 | `src/services/receipt.ts:293` | **SÍ** | 1a | `getById(id, ownerRef)`, lectura de un recibo por id |
| 6 | `src/services/inbound-task.ts:316` | **SÍ** | 1a | `get(ownerRef, id)`, lectura de una tarea inbound |
| 7 | `src/services/inbound-task.ts:338` | **SÍ** | 1a | `getByExternalRef`, además clave de dedup `(owner, source, external_ref)` |
| 8 | `src/services/agent.ts:549` | **SÍ** | 1a | `listMine(ownerRef)`, listado de agentes propios |
| 9 | `src/services/agent.ts:715` | **SÍ** | 1b | DELETE del agente, detrás del pre-chequeo en JS de `:701-709` |
| 10 | `src/services/reconciliation.ts:1448` | **SÍ** | 1a | `readBudgetUsd` sobre `a2a_agent_keys` (la tabla que nombra `CLAUDE.md`) |
| 11 | `src/services/arbiter.ts:110` | **SÍ** | 1a | read-first del nonce del árbitro (`a2a_arbiter_nonces`) |
| 12 | `src/services/arbiter.ts:1070` | **SÍ** | 1a | UPDATE `disputed→open` (`revertDisputeToOpen`) |
| 13 | `src/services/arbiter.ts:1100` | **SÍ** | 1a | UPDATE `disputed→arb_hold` (`holdArbitration`) |
| 14 | `src/services/spend-policy.ts:163` | **SÍ** | 1a | `list(keyId, ownerId)` de políticas de gasto |
| 15 | `src/services/spend-policy.ts:190` | **SÍ** | 1a | DELETE de una política; el filtro **es** el guard (0 filas → `OwnershipMismatchError`, `:198-205`) |
| 16 | `src/services/spend-policy.ts:219` | **SÍ** | 1a | `hasAnyPolicy`; el propio docblock (`:211-213`) dice que es de diagnóstico, no del hot-path |
| 17 | `src/services/llm/transform.ts:234` | **SÍ** | 1a | lectura de la caché L2 de funciones de transformación |
| 18 | `src/services/llm/transform.ts:278` | **SÍ** | 1a | UPDATE `hit_count` de esa misma caché (fire-and-forget) |
| 19 | `src/services/arbiter/evidence.ts:57` | **SÍ** | 1a | snapshot del intent para la evidencia de disputa |
| 20 | `src/services/arbiter/evidence.ts:76` | **SÍ** | 1a | ledger de vouchers de esa disputa |
| 21 | `src/services/arbiter/evidence.ts:96` | **SÍ** | 1a | cadena de recibos de la sesión |
| 22 | `src/routes/payments.ts:384` | **SÍ** | 1a | `GET /session/:id/dispute`, con `settle_usd` y `at_stake_usd` en el cuerpo |
| 23 | `src/adapters/escrow/debit-capture.ts:212` | **SÍ** | 1a | lectura del `buyer_wallet` que ancla al firmante del débito |

### Conteo por caso

- **Caso 1 (el filtro está y ningún test lo prueba): 23 de 23.**
- **Caso 2 (el filtro NO está, IDOR vivo): 0 de 23.** Con la salvedad metodológica de abajo.
- **Caso 3 (el filtro no corresponde ahí): 0 de 23.** Las 23 son consultas sobre tablas que
  **sí** tienen columna `owner_ref`, verificado en `src/types/database.types.ts`:
  `a2a_fee_splits:158`, `a2a_receipts:955`, `a2a_inbound_tasks:564`, `a2a_agents:61`,
  `a2a_agent_keys:217`, `a2a_arbiter_nonces:24`, `a2a_payment_intents:722`,
  `a2a_key_spend_policies:671`, `a2a_arbitrations:108`, `a2a_payment_vouchers:871`.
  (`kite_schema_transforms` no lo leí en el archivo de tipos: **no se pudo verificar** ahí, pero
  el cliente de Supabase está tipado con `Database` y `.eq('owner_ref', …)` sobre una columna
  inexistente no compilaría, y `npx tsc --noEmit` corre en CI, `.github/workflows/ci.yml:37`.)

### Las tres sub-clases del caso 1, porque deciden qué test hay que escribir

Colapsarlas sería escribir 23 tests iguales, y 4 de ellos no podrían ponerse en rojo nunca.

**1a — aislamiento entre inquilinos, alcanzable desde una ruta autenticada (18 sitios).**
Borrar el filtro cambia lo que sale por la API. Un test de dos dueños los mata a todos.

**1b — defensa en profundidad detrás de un pre-chequeo en JavaScript (2 sitios: `agent.ts:715`,
`fee-split.ts:697`).** Borrar el filtro **no cambia** el comportamiento en una sola pasada,
porque el pre-chequeo ya lanzó: `agent.ts:701-709` compara `existing.owner_ref !== ownerRef` y
tira `OwnershipMismatchError` antes de llegar al DELETE; `fee-split.ts:676-683` filtra en
memoria y devuelve `ownership_mismatch`. Estos dos **sólo** se matan con un test de entrelazado
(la fila cambia de dueño entre el read y la escritura), y la receta ya existe en este repo:
`src/services/task.ownership.test.ts:285-317` (`onUpdateStart`, T-OWN-03/T-OWN-04), que además
declara por escrito que la carrera no es alcanzable hoy en producción y explica por qué el test
igual vale (`:277-283`).

**1c — ligadura a un dueño resuelto en el servidor, no aislamiento del que llama (3 sitios:
`fee-split.ts:365/538/618`).** Acá `ownerRef` **no viene del caller**: sale de
`resolveRecipients`, que lo fija en `'platform'` (`fee-split.ts:224`, `:238`) o en el
`party.ownerRef` del creador/referral (`:215`), todo server-side por CD-6 (`:11-13`). O sea que
un caller no puede elegir ese valor. Lo que el filtro impide es escribir sobre una fila
`(orchestration_id, recipient_role)` cuyo destinatario persistido difiere del que la resolución
acaba de calcular: como el UNIQUE es `(orchestration_id, recipient_role)` (docblock `:21`) y NO
incluye `owner_ref`, sin el filtro el UPDATE pisa esa fila en vez de no hacer nada. Es una
aserción de consistencia, y sigue valiendo la pena probarla, pero **no** es un IDOR y decir que
lo es sería afirmar de más.

### ⚠️ La salvedad que cambia la lectura del hallazgo

**El método de A1 no puede encontrar un caso 2.** El barrido borra líneas `^\s*\.eq\(` que
existen y compara contra la línea base (A1 §"Cómo reproducirlo", línea 163). Una consulta que
**nunca tuvo** `.eq('owner_ref', …)` no aparece en ninguna de las 87 líneas `SURVIVED`, no
porque esté bien sino porque no había nada para borrar. Que los 23 sean caso 1 es una
propiedad del instrumento, no del código.

**Candidato concreto a caso 2 que sí encontré, y que no está en la lista de los 23**:
`src/services/reconciliation.ts:1128-1133` hace un UPDATE sobre
`a2a_payment_intent_debit_signatures` filtrando por `key_id`, `debit_nonce` y
`debit_settle_status`, **sin `owner_ref`** — y esa tabla **tiene** la columna
(`src/types/database.types.ts:807`). No lo declaro IDOR vivo: **no se pudo verificar** de dónde
sale ese `keyId` (si viene de la fila reclamada por el worker, el caller no lo elige y no hay
IDOR). Verificar la procedencia de ese `keyId` es trabajo de F2, y el censo de AC-6 es lo que
convierte esa pregunta en una lista finita en vez de una corazonada.

---

## Los otros 64 filtros que no son `owner_ref`

No se ignoran. Tres bloques importan y uno no:

1. **El compare-and-set de la reconciliación**, `src/services/reconciliation.ts:1131-1133`
   (verificado presente). Los tres juntos dicen "resolvé el débito de ESTA key, con ESTE nonce,
   que esté en ESTE estado". Sin `debit_nonce` se resuelve otro débito de la misma key; sin
   `debit_settle_status` se re-resuelve uno ya resuelto (doble crédito o doble captura según el
   lado). Es camino de dinero.
2. **Los UPDATE de `a2a_fee_splits` sin su `orchestration_id`/`recipient_role`**
   (`fee-split.ts:536-537`, `:616-617`, `:695-696`, verificados presentes): marcan `charged` con
   el `tx_hash` de otra orquestación. También camino de dinero.
3. **Los tres lookups de autenticación por hash** (`identity.ts:95`, `delegation.ts:273`,
   `agent-link.ts:245`): son los que deciden QUIÉN sos. **No los verifiqué en el árbol** en este
   F1; los cito del reporte A1 §11.
4. **No corresponde**: `fee-charge.ts:595` y `:695` consultan `a2a_protocol_fees`, tabla que
   **no tiene columna de dueño** (`src/types/database.types.ts:903-943`). Ahí un filtro de
   ownership no falta: es imposible. Es el único caso 3 que encontré en toda la revisión.

Los 64 **no entran en esta HU** (ver Scope OUT y la propuesta de partición): son una clase
distinta (ligadura a la fila, idempotencia, compare-and-set) que necesita otros escenarios de
test, no un fixture de dos dueños.

---

## Acceptance Criteria (EARS)

Cada AC nombra el input concreto que lo pone en rojo. Un AC que no se puede poner en rojo no es
un AC, es una frase.

- **AC-1**: WHEN se ejecuta `npm test`, the system SHALL fallar si alguna cadena
  `.from('<tabla con columna owner_ref>')` en `src/**/*.ts` (excluyendo `*.test.*`) no incluye
  `.eq('owner_ref', …)` y no figura en una lista de excepciones con motivo escrito.
  *Input que lo pone en rojo*: agregar a cualquier service
  `await supabase.from('a2a_receipts').select('*').eq('id', id).single()` sin el filtro de dueño.

- **AC-2**: WHEN el dueño A pide por identificador un recurso del dueño B, the system SHALL
  responder "no existe" (`null` / `undefined` / HTTP 404) sin revelar la existencia del recurso
  ajeno, en `receiptService.getById`, `inboundTaskService.get`, `inboundTaskService.getByExternalRef`,
  `agentService.listMine`, `spendPolicyService.list`, `spendPolicyService.delete`,
  `spendPolicyService.hasAnyPolicy`, `readEvidence` (3 consultas), `getOrCreateArbiterNonce`,
  `reconciliationService.readBudgetUsd`, el bloque L2 de `llm/transform.ts` y
  `GET /session/:id/dispute`.
  *Input que lo pone en rojo*: borrar `src/services/receipt.ts:293` y correr el test: la fila de
  B sale por la API de A.

- **AC-3**: WHILE una fila cambia de dueño entre la lectura previa y la escritura, the system
  SHALL no escribir sobre la fila del nuevo dueño en `agentService.delete`
  (`src/services/agent.ts:715`), `reverseFeeSplits` (`src/services/fee-split.ts:697`),
  `revertDisputeToOpen` (`src/services/arbiter.ts:1070`) y `holdArbitration`
  (`src/services/arbiter.ts:1100`).
  *Input que lo pone en rojo*: borrar `src/services/agent.ts:715`; el falso aplica sólo
  `.eq('slug', …)` y la fila de B queda borrada.

- **AC-4**: the system SHALL construir cada test de ownership sobre un fixture con **al menos
  dos `owner_ref` distintos** y un falso de PostgREST que aplique **únicamente** los filtros que
  el servicio pide (patrón `src/services/task.ownership.test.ts:139-144`).
  *Input que lo pone en rojo*: reducir el fixture a un solo dueño; el test tiene que dejar de
  distinguir y por lo tanto fallar su propio control anti-vacuidad.

- **AC-5**: WHEN se cierre la HU, the system SHALL acompañar cada uno de los 23 sitios con la
  evidencia de que **borrar esa línea** (no el archivo, no renombrar la columna) pone en rojo al
  menos un test, nombrando el test.
  *Input que lo pone en rojo*: un sitio cuyo borrado por línea deje la suite en la línea base
  (`1 failed | 5288 passed | 19 skipped`, A1 §"Líneas base"). Un `KILLED` obtenido renombrando
  `owner_ref` en todo el archivo **no cuenta**: A1 documenta ese falso positivo en su línea 159.

- **AC-6**: WHEN el control de AC-1 corra por primera vez, the system SHALL emitir la lista
  completa de consultas sobre tablas con `owner_ref` que hoy no filtran por dueño, y cada
  entrada SHALL quedar clasificada como IDOR vivo, excepción justificada o falso positivo, con
  su motivo.
  *Input que lo pone en rojo*: que `src/services/reconciliation.ts:1128-1133` (UPDATE sobre
  `a2a_payment_intent_debit_signatures`, tabla con `owner_ref` en `database.types.ts:807`, sin
  filtro de dueño) **no** aparezca en la lista.

- **AC-7**: IF la implementación necesita modificar una línea de producción para que un test
  pase, THEN the system SHALL detener la HU y escalar, porque esta HU no arregla filtros: los
  prueba.
  *Input que lo pone en rojo*: `git diff --stat` sobre `src/**/*.ts` que no sean `*.test.ts`
  distinto de vacío (única excepción admitida: la lista de excepciones de AC-1, si se decide
  ubicarla en `src/`).

---

## Scope IN

- `test/ownership-guard-coverage.test.ts` (nuevo): el control mecánico de AC-1 y AC-6.
- `src/services/__fixtures__/owner-scoped-fake.ts` (nuevo, nombre tentativo): el falso de
  PostgREST de dos dueños, extraído del patrón de `src/services/task.ownership.test.ts:91-225`
  para no copiarlo 12 veces.
- Tests nuevos `*.ownership.test.ts` para los sitios de este corte (ver partición):
  `receipt`, `inbound-task`, `agent`, `spend-policy`, `llm/transform`, `routes/payments`.
- `doc/sdd/220-wkh-sec-03-owner-ref-sin-cobertura/mutation-log.md`: la evidencia de AC-5, una
  línea por sitio.
- `CLAUDE.md` §"Tablas con ownership en app-layer (hoy)" (`:198-205`): hoy lista 4 tablas y las
  reales son 18. Actualizar la tabla y apuntar al control de AC-1.

## Scope OUT

- **Arreglar cualquier filtro.** Los 23 están. Esta HU no toca producción (CD-1).
- **Los otros 64 filtros** (`.eq` que no son `owner_ref`): otra HU, otra clase de escenario.
- **`a2a_protocol_fees`**: no tiene dueño, no hay nada que filtrar.
- **RLS real en Postgres**: es `WKH-SEC-02` / `TD-SEC-01`, ya trackeada (`CLAUDE.md:207-215`).
  Esta HU refuerza la capa de aplicación, que hoy es la única defensa, y no la reemplaza.
- **Los repos `chaski-v3`, `wasiai-facilitator`, `solana-programs`, `wasiai-remittance-agents`**
  y sus hallazgos 1, 2, 7, 9, 10, 12, 13, 14.
- **`m5-keys/`**, desplegar, la base `caldz`.
- **Los reportes A2..A6** de la misma auditoría.
- Mutación automatizada en CI (ver DT-4: rechazada con motivo).

---

## Decisiones técnicas (DT-N)

- **DT-1 — Test de propiedad, no espía de llamada.** El test principal afirma "A no puede ver ni
  mutar lo de B", no `expect(eq).toHaveBeenCalledWith('owner_ref', …)`. Motivo escrito y ya
  probado en este repo: `src/services/task.ownership.test.ts:15-46`. Un espía pasa aunque el
  nombre de columna esté mal escrito, y ese error deja al dueño sin ver **sus propias** filas.
  El espía queda como respaldo estructural en un solo test por archivo, porque sí sirve para
  **ubicar** cuál de N sitios se abrió.
- **DT-2 — El falso no filtra por su cuenta.** Aplica exactamente los `.eq(col, val)` que le
  piden sobre una tabla en memoria (`task.ownership.test.ts:139-144`). Si el falso filtrara por
  dueño de oficio, el test pasaría igual sin el filtro en el servicio, que es el modo de falla
  del mock actual de `fee-split.test.ts:68` (`chain.eq = () => chain`, tira columna y valor).
- **DT-3 — La lista de tablas con dueño se DERIVA, no se escribe a mano.** El control de AC-1
  saca las tablas de `src/types/database.types.ts` (toda tabla cuyo `Row` tiene `owner_ref`), no
  de una constante. Así una tabla nueva con dueño queda cubierta el día que se crea, sin que
  nadie se acuerde de agregarla. Es la diferencia entre un control mecánico y una lista que
  envejece, que es exactamente cómo envejeció la tabla de `CLAUDE.md:198-205` (dice 4 tablas,
  hay 18).
- **DT-4 — Mutación en CI: NO.** Reproducir el barrido de A1 en cada PR son ~87 corridas de la
  suite completa de 5308 tests. **No se pudo verificar** el tiempo de pared de una corrida, así
  que no doy un número, pero el orden de magnitud lo descarta como control de PR. Alternativa
  propuesta: el barrido queda como guion versionado (`scripts/eq-sweep.mjs`) y se corre a mano
  al cerrar HUs de seguridad. El control de PR es AC-1, que es estático y cuesta milisegundos.
- **DT-5 — Ubicación del control: `test/`, no `scripts/`.** `npm test` ya es un paso obligatorio
  de CI (`.github/workflows/ci.yml:43`) y ya hay precedente de guardián estructural que parsea
  el árbol: `test/test-files-are-run-in-ci.test.ts` y `src/routes/charged-routes.meta.test.ts`.
  Un guion en `scripts/` habría que acordarse de invocarlo, y A1 §17 documenta qué pasa con los
  guiones que nadie mira (`verify-rls-enabled.mjs` imprime `[PASS]` sobre cero protección).

---

## Constraint Directives (CD-N)

- **CD-1 — PROHIBIDO** modificar cualquier línea de producción bajo `src/` que no sea test. Si un
  test no puede ponerse en rojo sin tocar producción, se documenta y se escala (AC-7).
- **CD-2 — OBLIGATORIO** que todo fixture de ownership tenga dos `owner_ref` distintos. Un
  fixture de un solo actor **no puede refutar** un filtro por dueño; es la causa medida de que
  los 23 sitios estén descubiertos (A1 §"Las dos causas mecánicas", punto (b)).
- **CD-3 — OBLIGATORIO** que la evidencia de AC-5 sea **por línea**. Una mutación más grande
  (renombrar la columna en todo el archivo) da un KILLED falso: pasó, está documentado en
  A1:159, y hizo creer que `spend-policy.ts` estaba cubierto cuando sus 3 sitios están abiertos.
- **CD-4 — PROHIBIDO** que el control de AC-1 tenga una lista de tablas escrita a mano (DT-3).
- **CD-5 — PROHIBIDO** que el control de AC-1 se presente como suficiente. Es un verificador de
  presencia textual: **no** puede detectar que se le pase el valor equivocado
  (`.eq('owner_ref', otroOwner)`) ni cadenas escritas en una sola línea, límite que el propio
  barrido de A1 declara (§"Lo que NO revisé", punto 5). El control mecánico ubica; los tests de
  AC-2/AC-3 miden. Los dos, o ninguno sirve.
- **CD-6 — OBLIGATORIO** que cada test nuevo lleve un control anti-vacuidad: un caso que falle
  si el falso empieza a filtrar de más o de menos (el patrón "las dos direcciones" de
  `task.ownership.test.ts:261-264`: A ve lo suyo **y** no ve lo de B).

---

## Decisión de partición: dos HUs, y no por urgencia

**No hay IDOR vivo entre los 23, así que no hay HU de emergencia.** El corte se justifica por
otra cosa, y es medible:

- **WKH-SEC-03 (esta HU)**: el mecanismo (control de AC-1 + censo de AC-6 + falso compartido) y
  los **12 sitios de lectura/escritura alcanzables desde ruta autenticada con identificador del
  caller**: `receipt.ts:293`, `inbound-task.ts:316,338`, `agent.ts:549,715`,
  `spend-policy.ts:163,190,219`, `llm/transform.ts:234,278`, `routes/payments.ts:384`.
  Es donde un borrado accidental se traduce directo en datos de otro dueño saliendo por la API.
- **WKH-SEC-04 (sigue a ésta)**: los **11 restantes**, que son el camino de dinero y disputas y
  necesitan escenarios más caros: `fee-split.ts:365,538,618,697` (más los 9 `.eq` no-owner del
  mismo archivo, que comparten el mock roto de `fee-split.test.ts:68` y conviene arreglar de una
  vez), `arbiter.ts:110,1070,1100`, `arbiter/evidence.ts:57,76,96`,
  `reconciliation.ts:1448`, `debit-capture.ts:212`.

**Por qué partir y no hacer waves de una sola HU**: 23 sitios en 12 archivos son del orden de
3000 líneas de test nuevas. Este repo tiene evidencia propia de qué pasa cuando una revisión
mira demasiado de una vez: WKH-322 necesitó **4 pasadas de AR**, cada una descubriendo que un
mecanismo nuevo declaraba cobertura que no tenía (`doc/sdd/_INDEX.md`, fila 217). Partir en dos
pone el mecanismo (lo que evita la reincidencia) en producción antes, y le da a la segunda HU un
patrón ya revisado para copiar en vez de inventar.

**Riesgo de la partición, declarado**: entre el merge de SEC-03 y el de SEC-04, el control de
AC-1 va a estar verde con 11 sitios todavía sin test de propiedad. El control dice "el filtro
está", no "el filtro funciona" (CD-5). Hay que escribirlo en el reporte de cierre de SEC-03 para
que nadie lea el verde como "cerrado".

---

## El mecanismo para que no vuelva a pasar, y su costo

El `CLAUDE.md` ya lo prohíbe desde WKH-53 (`:135-196`), con el patrón escrito, el motivo escrito
y la instrucción de marcarlo **BLOQUEANTE** en AR. **Se violó 23 veces.** O sea que el problema
no es que la regla no exista: es que **su cumplimiento sólo lo puede comprobar una persona
leyendo un diff**, y eso no escala a 12 archivos y varios meses.

**Propuesta (AC-1 + AC-6): un guardián estructural en la suite.**

- **Qué hace**: deriva de `src/types/database.types.ts` el conjunto de tablas con `owner_ref`
  (18 hoy), recorre `src/**/*.ts` no-test, y por cada cadena `.from('<tabla del conjunto>')`
  exige un `.eq('owner_ref', …)` antes de resolver, o una entrada en la lista de excepciones con
  motivo. Falla nombrando `archivo:línea`.
- **Costo de construirlo**: un archivo, del orden de 200 líneas, más la lista inicial de
  excepciones que sale del censo de AC-6. Está dentro de esta HU.
- **Costo de correrlo**: cero configuración nueva. `npm test` ya es paso obligatorio de CI
  (`.github/workflows/ci.yml:43`), y es análisis estático de texto: milisegundos frente a los
  ~5300 tests que ya corren.
- **Costo de mantenerlo**: cada excepción nueva obliga a escribir un motivo. Ese es el punto: hoy
  omitir el filtro no cuesta nada; con esto, omitirlo cuesta justificarlo por escrito en un
  archivo que el revisor ve en el diff.
- **Lo que NO hace, y hay que decirlo (CD-5)**: no detecta que le pases el **valor** equivocado,
  ni cadenas de una sola línea. Por eso el guardián **acompaña** a los tests de propiedad y no
  los reemplaza. Un control que promete más de lo que mide es el hallazgo 17 de A1
  (`verify-rls-enabled.mjs` imprime `[PASS] RLS enabled` sobre una política `USING (true)`), y
  no vamos a agregar un segundo.

**Segunda palanca, barata y complementaria**: la unión `OwnershipOp` de
`src/services/security/errors.ts:469-483` enumera hoy 14 operaciones y **ninguna** es de
`receipt`, `inbound-task`, `arbiter`, `fee-split` ni `llm/transform`. Es una señal ya existente
de qué módulos pasaron por el ritual de ownership y cuáles no. Convertirla en obligación (que
todo service que reciba un `ownerRef` registre su op) no es un guard, pero pone la omisión en el
lugar donde el compilador y el revisor la ven.

**Lo que se descarta y por qué**: mutación en CI (DT-4, costo), y confiar en el AR/CR humano
(ya se probó durante meses, resultado 23 a 0).

---

## Missing Inputs

- **[resuelto en F2]** Procedencia del `keyId` en `src/services/reconciliation.ts:1128-1133`.
  Decide si ese sitio es un caso 2 real o una consulta de worker sin superficie de caller.
  **No se pudo verificar** en F1.
- **[resuelto en F2]** ¿`reverseFeeSplits` tiene algún llamador en producción? Su docblock dice
  «v1: NO se cablea a orchestrate/compose» (`src/services/fee-split.ts:636`). Si no lo tiene, su
  test de AC-3 sigue valiendo (es defensa en profundidad declarada) pero baja de prioridad.
  **No se pudo verificar**: no dispuse de herramienta de búsqueda global en este F1.
- **[resuelto en F2]** ¿`kite_schema_transforms` está en `Database` y tiene `owner_ref`? El
  argumento del typecheck es fuerte pero indirecto. Hay que leerlo antes de que DT-3 derive el
  conjunto de tablas.
- **[no bloqueante]** Número de HU y de directorio. Usé **220** porque es el siguiente libre en
  este árbol (el máximo visible es `219-hu-323-…`), pero hay ramas sin mergear (WKH-325,
  WKH-326) que pueden haber tomado 220-222 en sus propios worktrees.
  **[NEEDS CLARIFICATION]** confirmar el número antes de crear la rama. El propio `_INDEX.md`
  documenta que las colisiones de numeración ya ocurrieron y se toleran
  (`doc/sdd/_INDEX.md:195-206`).
- **[no bloqueante]** **No pude crear un worktree**: en esta corrida sólo tuve herramientas de
  lectura y escritura de archivos, sin shell. El work-item se escribió directo en el árbol
  principal, y por eso **no toqué `doc/sdd/_INDEX.md`**: la fila va staged en
  `_INDEX-row.md`, que es la convención que ya usan las HUs 212, 214 y 217.

---

## Análisis de paralelismo

- **Bloquea a WKH-SEC-04** (los 11 sitios de dinero y disputas): comparte el falso de dos dueños
  y la lista de excepciones. Arrancar las dos en paralelo garantiza dos falsos distintos.
- **Roce con WKH-SEC-02** (RLS real en Postgres, `CLAUDE.md:207-215`): **ninguno de código**. Son
  capas distintas y se pueden hacer en paralelo. Ojo con el argumento: RLS **no** vuelve
  redundantes estos filtros mientras el cliente use `SUPABASE_SERVICE_KEY`, que es BYPASSRLS.
- **Roce con las HUs en vuelo** (WKH-313/314/315/316/318/319, y las ramas WKH-325/326 sin
  mergear): esta HU **no toca `src/` de producción** (CD-1), así que el único conflicto textual
  posible es `CLAUDE.md` y `doc/sdd/_INDEX.md`. Bajo.
- **Depende de**: nada. Se puede empezar hoy.
- **Habilita**: cualquier HU que agregue una tabla con dueño. Con AC-1 mergeado, esa tabla queda
  cubierta el día que nace (DT-3), que es exactamente lo que no pasó con las 10 tablas que
  vinieron después de WKH-53/54.
