# Auto-Blindaje — HU-201 (`success:false` no es prueba de que no se ejecutó)

### [2026-07-28] Wave 1 — el BLQ-ALTO estaba en 5 caminos, no en 4

- **Error**: el brief enumeraba "los 4 adapters" (`base`, `avalanche`, `tempo`,
  `kite` modo x402) como los que aplanan un HTTP non-2xx a `success:false`. Si me
  quedaba con esa lista, el modo **`pieverse` de kite — que es el DEFAULT de
  producción** (`getFacilitatorMode()`, `payment.ts:70`) — quedaba sin arreglar.
- **Causa raíz**: en pieverse el bug tiene OTRA forma. No aplana a `success:false`:
  tira un `Error` PELADO (`payment.ts`, guard `!response.ok` del `settle` de la
  clase). Buscar el patrón `!response.ok || result.settled !== true` encuentra 4
  ocurrencias y deja la quinta afuera, porque ahí el síntoma es
  `readSettleValueDisposition() === undefined` en vez de un refund indebido.
- **Fix**: se cambió también ese `throw new Error(...)` por
  `FacilitatorSettleError(..., 'unknown')`, y el candado
  `T-198-AR2-HTTP-ERROR` (que candaba el comportamiento VIEJO a propósito, porque
  HU-198 dejó esto Scope OUT) se invirtió y pasó a `T-201-HTTP-ERROR`.
- **Aplicar en**: cualquier barrido por "camino de settle" tiene que ENUMERAR los
  caminos, no grepear un patrón. La lista canónica vive en la cabecera de
  `src/adapters/settle-http-error.hu201.test.ts`.
- **⚠️ CORRECCIÓN (AR MENOR)**: son **SEIS** implementaciones de `settle`, no cinco.
  La sexta es `src/adapters/solana/payment.ts`, y está EXCLUIDA de esta HU con
  motivo —no habla con un facilitator HTTP: construye, firma y broadcastea ella
  misma, y es idempotente por `intentId`— pero decir "los cinco" canoniza una lista
  incompleta para el próximo barrido, que es el error que esta misma entrada
  describe. La regla correcta: enumerar las seis y JUSTIFICAR cada exclusión.

### [2026-07-28] Wave 1 — dos referencias del brief apuntaban al guard equivocado

- **Error**: el brief citaba `kite-ozone:679-685` como el aplanado del settle y
  `reconciliation.ts:344-347` como la afirmación de que el caso (D) está probado.
  Las dos líneas existen y son parecidas, pero son OTRO guard: 679-685 es
  `verifyX402` (verify, que no broadcastea nada) y 344-347 es el comentario del
  `claimed=false` de AR BLQ-BAJO-1.
- **Causa raíz**: el repo tiene el mismo `if (!response.ok)` dos veces por adapter
  (verify + settle) y varios bloques de comentario con vocabulario idéntico.
  Anclar por número de línea sin verificar el contenido lleva a mutar/editar el
  guard vecino, que es exactamente el modo de fallo que ya nos pasó.
- **Fix**: se localizó cada guard por CONTENIDO (`grep -n "if (!response.ok)"` en
  los 4 archivos da 10 hits; el de settle es siempre el segundo de cada archivo) y
  se verificó la mutación por `sha256sum` + el nombre del test que se pone rojo.
- **Aplicar en**: toda mutación de este repo. Un `grep -n` del patrón + el hash del
  archivo antes/después es el mínimo; el test que se pone rojo tiene que nombrar el
  archivo fuente que se mutó (por eso los `describe` de la suite nueva incluyen el
  path).

### [2026-07-28] Wave 2 — el candado del caso legítimo no es opcional

- **Error potencial evitado**: la primera versión mental del fix era "todo
  `success:false` pasa a `ambiguous`". Eso pasa todos los tests de la dirección
  peligrosa y convierte un riesgo de doble pago en "el reconciliador no reconcilia"
  + "el buyer no recupera su deposit", en silencio.
- **Fix**: cada test de la dirección peligrosa (T-201-A/C/E) tiene su
  contra-ejemplo obligatorio (T-201-B/D/F). Probado con la **mutación de
  sobre-corrección** (`failureKind: 'ambiguous'` fijo): pone rojos **12** tests, 3 de
  ellos los contra-ejemplos nuevos. (Yo había reportado 10: conté sobre una corrida
  parcial. La dirección del error fue conservadora —sub-declarar cuántos candados
  hay— pero un número de mutación es evidencia, y una evidencia mal contada no es
  evidencia. Corregido por el AR.)
- **Aplicar en**: cualquier HU que endurezca una clasificación de dinero. Mutar
  hacia el lado SEGURO y exigir rojo es tan obligatorio como mutar hacia el
  peligroso.

### [2026-07-28] Fix-pack AR — endurecer sin superficie es cambiar ruido por silencio

- **Error**: el fix mandó los HTTP non-2xx a `ambiguous` ⟹ el deposit del buyer deja
  de reembolsarse. Acepté ese costo razonando "va a revisión humana"… sin verificar
  que la revisión humana TUVIERA DÓNDE PASAR. En el camino no-escrow (el DEFAULT)
  esas filas no las lista `listPending()` (lee la tabla de firmas, que ahí no existe)
  ni las toca `resolveIntent()` (corta en el gate del flag). La cola no era cara: no
  existía.
- **Causa raíz**: razoné sobre el camino ESCROW, que sí tiene superficie
  (`resolving_settle` + `listPending`), y extendí esa conclusión al camino no-escrow
  sin comprobarlo. Los dos caminos comparten el clasificador pero NO la
  observabilidad.
- **Fix**: `reconciliationService.listAmbiguous()` + `ambiguous` en
  `GET /dashboard/api/reconciliation`, deliberadamente NO gateado por el flag.
  Candado: `T-201-AMB-FLAG-OFF` (mutar el gate lo pone rojo).
- **Aplicar en**: TODA HU que convierta una acción automática en una manual. El
  entregable no es la reclasificación: es la reclasificación MÁS el lugar donde se
  ve. Pregunta de control: "¿qué query lista las filas que acabo de crear?". Si la
  respuesta es "el `error_message`", no hay superficie.

### [2026-07-28] Fix-pack AR — un test puede candar la propiedad equivocada y parecer verde

- **Error**: `T-201-HTTP-CONTRA` afirmaba `expect(result.txHash).toBe('')` y PARECÍA
  candar la propagación del hash. Era vacuo en esa dimensión: el fixture no traía
  `transactionHash`, así que `result.transactionHash ?? ''` y un `''` hardcodeado son
  indistinguibles. La mutación "borrá el hash en la rama de fallo" sobrevivía en los
  4 adapters x402 con la suite entera en verde — y el hash es la ÚNICA evidencia que
  hace funcionar todo el fix.
- **Causa raíz**: el assert miraba el valor CORRECTO pero en el escenario donde la
  rama no se ejecuta. Es la forma "el escenario está armado de manera que la rama
  nunca corre", ya cazada dos veces esta semana en este repo.
- **Fix**: fixture `respondRejected200WithHash()` + `T-201-CONTRA-HASH` en los 4
  caminos. Los 4 mutantes ahora mueren, cada uno en el test de SU archivo.
- **Aplicar en**: cuando un assert compara contra un valor por DEFECTO (`''`, `null`,
  `0`, `undefined`), el test no distingue "lo calculó" de "no lo tocó". Hay que
  ejercitarlo con un valor NO-default, o mutar y confirmar el rojo.

### [2026-07-28] Fix-pack AR — el veredicto más fuerte del sistema salía de un cuerpo ilegible

- **Error**: apliqué la doctrina "no entender no es tener una prueba" al `txHash` y
  NO al campo de al lado. Un `200 {}` de pieverse deja `result.success === undefined`
  ⟹ `!settleResult.success` es `true` ⟹ salía `unequivocal` ⟹ REEMBOLSO. O sea: un
  cuerpo que no entendimos entero emitía el veredicto más fuerte del sistema, en el
  mismo commit donde escribí que eso no se hace.
- **Causa raíz**: leí el tipo (`PieverseSettleResult.success: boolean`) como una
  garantía. El cuerpo lo manda un TERCERO; el tipo es una declaración nuestra, no un
  contrato ejecutable.
- **Fix**: en el settle pieverse, `typeof result.success !== 'boolean'` ⟹
  `FacilitatorSettleError('unknown')`. Acotado a ESE campo: exigir `settled` en los
  x402 sería sobre-corrección (ahí `settled !== true` es un default-deny deliberado
  contra nuestro propio facilitator).
- **Aplicar en**: cualquier campo de un tercero del que dependa una decisión de
  dinero. `typeof x !== 'boolean'` sobre el veredicto, no sólo `!x`. Un tipo
  TypeScript sobre un payload de red es documentación, no validación.
