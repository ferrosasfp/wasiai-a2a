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
- **Aplicar en**: cualquier barrido por "camino de settle" tiene que enumerar los
  **cinco** (4 x402 + pieverse), no grepear un patrón. La lista canónica vive en la
  cabecera de `src/adapters/settle-http-error.hu201.test.ts`.

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
  sobre-corrección** (`failureKind: 'ambiguous'` fijo): pone rojos 10 tests, 3 de
  ellos los contra-ejemplos nuevos.
- **Aplicar en**: cualquier HU que endurezca una clasificación de dinero. Mutar
  hacia el lado SEGURO y exigir rojo es tan obligatorio como mutar hacia el
  peligroso.
