# Auto-Blindaje — HU-194 (idempotencia del refund-outbox)

## Errores cometidos y corregidos en la sesión

### [2026-07-27] W0 — La dedup en el outbox NO cerraba el agujero (diseño descartado)
- **Error**: el enfoque sugerido (idempotency key en `a2a_refund_outbox` + hacer
  `refund_a2a_key_spend` idempotente "por esa clave") arrancaba mal si la clave
  sólo se registraba en la tabla del outbox: el crédito ORIGINAL — el que
  commiteó y cuya respuesta se perdió — no dejaba NINGÚN rastro con esa clave, así
  que el reintento del sweep era la PRIMERA fila con esa clave y se aplicaba igual.
- **Causa raíz**: la dedup tiene que compartir transacción con el efecto que
  dedupea. Una tabla de cola que se escribe DESPUÉS del fallo no puede saber si el
  efecto ocurrió.
- **Fix**: `a2a_refund_applications` (marcador con `idem_key` PRIMARY KEY) escrito
  DENTRO del cuerpo de la RPC, en la misma transacción que acredita el budget.
  Si el UPDATE commiteó, el marcador commiteó. El índice único del outbox queda
  como segunda defensa (evita filas pendientes duplicadas), no como la primaria.
- **Aplicar en**: cualquier "hacelo idempotente" sobre una acción cuyo resultado
  se lee por la red. Preguntar siempre: *¿dónde queda el rastro si la respuesta se
  pierde?* Si el rastro lo escribe el cliente, no hay idempotencia.

### [2026-07-27] W0 — `orchestrationId` como base de la clave habría suprimido refunds reales
- **Error**: el primer borrador usaba `orchestrationId` como identificador de la
  operación (era una de las opciones sugeridas).
- **Causa raíz**: `POST /orchestrate/execute` recibe `orchestrationId` en el BODY
  (`src/routes/orchestrate.ts:33,299-301`, `OrchestrateExecuteBody`), sin ninguna
  validación de unicidad — es caller-controlled. Un caller que repitiera el id
  haría que su SEGUNDO refund (de otro débito real) se descartara como duplicado:
  pérdida de dinero del caller, silenciosa.
- **Fix**: el `operationId` es SIEMPRE un UUID server-side por operación
  (`requestRefundIdemBase` memoizado en el request, `composeRunId`, `refundRunId`).
  Test que lo fija: `T-194-O2` (dos ejecuciones con el MISMO `orchestrationId` →
  claves distintas), rojo bajo la mutación M9.
- **Corrección (AR MNR-2)**: la primera versión de esta entrada afirmaba que
  `request.id` "puede llegar por el header `request-id`". **Es falso en este
  codebase**: `requestIdHeader` tiene default `false`
  (`node_modules/fastify/lib/config-validator.js:60-61`) y `src/index.ts:59-70`
  pasa `genReqId` sin setearlo, así que el header entrante se IGNORA y `request.id`
  es siempre un `crypto.randomUUID()` server-side
  (`src/middleware/request-id.ts:10`). La decisión no cambia (usar un UUID propio
  sigue siendo lo correcto: `requestIdHeader: true` es una línea en otro archivo
  por otro motivo), pero el argumento sí: la mitad verdadera era `orchestrationId`.
- **Aplicar en**: TODA clave de idempotencia. Antes de usar un id como clave,
  rastrear si puede entrar por header o body **verificando la config REAL del
  framework** (el default de la opción en el paquete instalado, no lo que uno
  recuerda del framework). Y si el id es server-side pero una opción de config
  podría volverlo caller-controlled, no lo uses igual: la clave del dinero no debe
  depender de una opción de logging.

### [2026-07-27] W2 — Dos refunds legítimos del mismo step iban a colapsar
- **Error**: la primera versión del slot era `compose-step:${i}` (sin fase). El
  closure `refundStepDebit` de `src/services/compose.ts` se invoca DOS veces para
  el mismo step: PASO 1 (refund del primer débito) y PASO 6b (refund del débito
  del retry adaptativo). Mismo monto, mismo destino, mismo `reason`. Con una sola
  clave, el segundo crédito — dinero REAL — se habría descartado como duplicado.
- **Causa raíz**: leer el call-site "de a un `await`" en vez de rastrear cuántas
  veces se invoca el closure en el flujo completo del catch.
- **Fix**: `phase: 'd1' | 'd2'` como parámetro del closure → slots
  `compose-step:<i>:d1` y `:d2`. Test `T-194-D1`, rojo bajo la mutación M6.
- **Aplicar en**: antes de fijar la granularidad de una clave de idempotencia,
  contar cuántas veces puede correr el mismo bloque en UNA operación. Si el mismo
  helper se llama dos veces, la clave necesita un discriminador.

### [2026-07-27] W2 — `reason` dentro de la clave habría reabierto el agujero
- **Error**: tentación de usar el `reason` (que ya viaja al outbox) como parte de
  la clave, porque describía bien "qué refund es".
- **Causa raíz**: el `reason` describe CÓMO falló el intento, no QUÉ refund es. El
  mismo refund lógico se encola con `:refund-failed` o `:refund-threw` según el
  camino; dos claves distintas ⟹ dos filas ⟹ dos créditos.
- **Fix**: el `reason` queda SÓLO como campo de auditoría. El slot es explícito y
  no depende del modo de fallo. Tests `T-SR-14` y `T-194-G1` / `T-SR-12` (la clave
  encolada es la MISMA que la del credit), rojos bajo M8 y M11.
- **Aplicar en**: las claves se componen de identidad, nunca de diagnóstico.

### [2026-07-27] W1 — Un parámetro `string` habría dejado pasar un `destination` como clave
- **Error**: el primer diseño agregaba `idemKey: string | null` como parámetro
  positivo. En `creditDelegation(delegationId, ownerRef, keyId, chainId, amount,
  destination?)` el nuevo parámetro tenía que ir ANTES del `destination` opcional,
  y un `destination: string` en esa posición typechequea perfecto contra
  `string | null` → clave silenciosamente equivocada.
- **Causa raíz**: dos parámetros adyacentes del mismo tipo primitivo.
- **Fix**: el parámetro es un OBJETO (`RefundIdem = { idemKey: string | null }`) y
  es REQUERIDO en las 4 variantes de `credit*`. El compilador marcó los 8
  call-sites y los ~21 usos en tests, uno por uno.
- **Aplicar en**: cualquier parámetro nuevo que se pueda confundir posicionalmente
  con el de al lado. Un objeto de una sola propiedad cuesta 12 caracteres y
  convierte un bug de dinero en un error de compilación.

### [2026-07-27] W2 — Orden de locks invertido entre el camino master y el dual-ledger
- **Error**: la primera versión de los wrappers dual-ledger reclamaba la clave
  ANTES de que el refund del parent tomara el `FOR UPDATE` de `a2a_agent_keys`,
  mientras el camino master lockeaba la key y DESPUÉS reclamaba: órdenes opuestos
  sobre los mismos dos recursos ⟹ deadlock posible entre el credit original (bajo
  delegación) y el reintento del sweep (master) con la misma clave.
- **Causa raíz**: pensar el claim como "una tabla más" y no como un recurso
  lockeable dentro de la jerarquía.
- **Fix**: los wrappers hacen `PERFORM 1 FROM a2a_agent_keys WHERE id = p_key_id
  FOR UPDATE` antes del claim (lock que el parent iba a tomar igual). Orden único:
  delegación/sesión → key → marcador → ledger del dest-cap. Documentado en el
  header de la migración.
- **Aplicar en**: toda RPC nueva que toque 2+ tablas del money-path. Escribir el
  orden en el header y verificar que TODOS los caminos lo respeten.

### [2026-07-27] W3 — Dos mutaciones mal medidas (el patrón no golpeaba el código)
- **Error**: (a) M11 insertaba `idemKey: <otra clave>` ANTES de la propiedad
  original en el mismo object literal: en JS gana la ÚLTIMA, así que el mutante era
  un no-op y el test quedaba verde "por las buenas". (b) el ancla de M11 arrancaba
  con una línea de comentario y el guard `only_in_comments` abortó, que es lo
  correcto pero delataba un ancla mal elegida.
- **Causa raíz**: mutar por inserción en vez de por reemplazo del código real.
- **Fix**: el harness (`mutate.py`) ABORTA si el patrón no existe, si es ambiguo
  (aparece más de una vez) o si sólo aparece en comentarios; y las mutaciones
  reemplazan la expresión real (`idemKey: idem.idemKey` → `` `${...}:threw` ``) con
  un ancla de código que la desambigua (`\n      })\n      .catch(...`).
- **Aplicar en**: todo run de mutación. Una mutación que no cambia el
  comportamiento observable es un falso verde, que es peor que no medir.

### [2026-07-27] W3 — Dos expectativas de mutación estaban mal atribuidas
- **Error**: se esperaba que `T-194-C6` se pusiera rojo con M1 (la clave no llega
  a la RPC) y que `T-SR-12`/`T-194-G1` se pusieran rojos con M7 (sin memoización).
  No pasó, y la primera lectura fue "el test es vacuo".
- **Causa raíz**: cada test guarda UN guard concreto. `T-194-C6` depende del índice
  único del outbox (M3), no del `p_idem_key` del credit. La memoización de
  `requestRefundIdemBase` hoy no es observable en los call-sites porque cada uno
  construye su `idem` UNA vez y lo reusa; su contrato se prueba en el unitario
  (`T-IDEM-06`, rojo con M7) y su valor es para call-sites futuros.
- **Fix**: expectativas corregidas + mutaciones dedicadas (M3 para el índice del
  outbox, M8/M11 para la coincidencia de claves credit↔outbox). 15/15 mutantes
  cazados.
- **Aplicar en**: cuando un mutante no pone rojo el test esperado, primero
  verificar QUÉ guard cubre ese test. Puede ser expectativa mal escrita y no test
  vacuo.

### [2026-07-27] Fix-pack AR (BLQ-BAJO-1) — el orden migración→deploy no estaba escrito en ninguna parte
- **Error**: la HU entregó código que DEPENDE de una migración pendiente de
  aprobación, sin declarar el orden de release. Si se deploya el código primero, los
  8 call-sites de refund reciben `PGRST202` (no existe función con `p_idem_key`) en
  el credit y `PGRST204` (no existe la columna) en el enqueue: el refund no se
  aplica NI queda encolado y el caller queda cobrado sin rastro recuperable.
- **Causa raíz**: pensar la compatibilidad en UNA dirección. Se documentó con
  detalle que la migración es back-compat con el código viejo (que es cierto), y de
  ahí se asumió que el par era seguro en cualquier orden. La dirección inversa
  (código nuevo contra schema viejo) nunca se escribió.
- **Fix**: gate explícito en el header del `.sql` y en `work-item.md` §0. NO se
  agregó shim en código a propósito: un shim que atrapara `PGRST202` y reintentara
  sin la clave reabriría el agujero de doble crédito que la HU cierra.
- **Aplicar en**: toda HU que entregue código + migración juntos. Escribir el orden
  y qué error CONCRETO da el orden inverso. "Es aditiva/no destructiva" describe la
  migración, no el release.

### [2026-07-27] Fix-pack AR (MNR-1) — se afirmó cobertura sin medirla por línea
- **Error**: el commit afirmaba cobertura del par failed/threw de los call-sites,
  pero el `catch` del credit-back del step-0 de `/compose`
  (`src/routes/compose.ts:424-451`) tenía **0 hits** en toda la suite, incluida la
  línea nueva `idemKey: idem.idemKey` (441). Los otros 3 pares sí estaban cubiertos,
  así que la asimetría pasó desapercibida por analogía.
- **Causa raíz**: medir cobertura por "existe un test del patrón" en vez de por hits
  de las líneas nuevas. Un archivo con 3 de 4 caminos cubiertos se lee como cubierto.
- **Fix**: `T-194-CR-1/2` en `compose.no-charge-on-validation-error.test.ts`
  (el credit TIRA → el enqueue lleva la MISMA clave; y un enqueue que también tira
  no rompe el 400). Medido antes/después con
  `vitest run --coverage.include='src/routes/compose.ts'`: 0 → 2 hits. Verificado
  por mutación (clave distinta en la 441 → `T-194-CR-1` rojo).
- **Aplicar en**: toda línea NUEVA del money-path. Antes de afirmar cobertura,
  correr coverage con `--coverage.include=<el archivo>` y mirar los hits de esas
  líneas. Si son 0, no hay cobertura, aunque el hermano de al lado la tenga.

### [2026-07-27] Fix-pack AR (MNR-3) — el test contra Postgres real cubría la función MENOS riesgosa
- **Error**: el archivo env-gated (`refund-idempotency.real.test.ts`) sólo ejercitaba
  `refund_a2a_key_spend`. Las funciones donde hubo que **corregir un orden de locks
  invertido** (`refund_delegation_and_parent`, `refund_session_and_parent`) y donde
  el claim convive con la fila compensatoria del dest-cap
  (`refund_with_dest_policy`) no se tocaban en ningún lado.
- **Causa raíz**: escribir el test de integración sobre el camino más fácil de
  montar (una key y nada más) en vez de sobre el que más riesgo tiene (fixtures de
  política de gasto y delegación).
- **Fix**: `T-194-R7` (el dest-cap se revierte UNA vez, no dos) y `T-194-R8`
  (`total_spent` decrementado UNA vez) + los fixtures en el `beforeAll`. Sigue
  env-gated y **sin ejecutar**: la aprobación de la migración llega con evidencia
  ejecutable, no con evidencia inventada.
- **Aplicar en**: cuando un test es env-gated (nadie lo corre en CI), su valor es la
  evidencia que habilita; priorizar los caminos que se TOCARON y los que mueven dos
  ledgers, no el más barato de escribir.
