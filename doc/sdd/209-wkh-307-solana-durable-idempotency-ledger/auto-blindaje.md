# Auto-Blindaje — WKH-307 · idempotencia durable del settle Solana

Errores REALES cometidos durante la implementación (F3), con el patrón que los
previene. Nada de esto es hipotético.

---

## Campaña de mutación — los 15 mutantes (Done Definition 1)

Procedimiento por mutante: árbol limpio → aplicar → **probar que aterrizó** (hash del
archivo distinto del respaldo) → **`npx tsc --noEmit` limpio** → correr los tests →
restaurar por `cp` desde el respaldo → **verificar por hash**. Nunca `git checkout --`
(esta HU crea archivos untracked y `git checkout` no los revierte).

| # | Mutación | ¿Compiló? | Resultado | Test(s) asesino(s) — observado |
|---|---|---|---|---|
| **M1** | El resultado del reclamo deja de gobernar: se transmite siempre | Sí (3ª formulación) | **KILLED** | `T-IDM-03`, `03b`, `04`, `05`, `06a/b/c`, `07`, `07b`, `09b`, `12` |
| **M2** | `in_progress` comparte el camino de `claimed` (variante sutil) | Sí (2ª formulación) | **KILLED** | `T-IDM-09b` |
| **M3** | El reclamo se mueve DESPUÉS de construir y firmar | Sí | **KILLED** | 11 tests, incluido `T-IDM-04` y toda la familia `06` |
| **M4** | `store_unavailable` se lee como "no existe" ⟹ se reclama igual | Sí | **KILLED** | `T-LDG-06`, `T-LDG-07`, `T-LDG-13` |
| **M5** | `applied !== true` → `applied === false` (un `undefined` pasa como éxito) | Sí | **KILLED** | `T-LDG-05b`, `T-LDG-09`, `T-LDG-13` |
| **M6** | `recordSigned` DESPUÉS de `sendRawTransaction` (rompe I2) | Sí | **KILLED** | `T-PAY-01`, `T-PAY-02`, `T-IDM-01c`, `T-IDM-08`, `08b`, `T-235a-AC1`, `AC1b` |
| **M7** | Se ignora el veredicto de `recordSigned` y se transmite igual | Sí (2ª formulación) | **KILLED** | `T-PAY-02`, `T-IDM-01c` |
| **M8** | `terms_conflict` devuelve la firma previa en vez de rechazar | Sí | **KILLED** | `T-IDM-07`, `T-IDM-07b` |
| **M9** | `confirmed` devuelve la firma SIN llamar a `verify()` | Sí | **KILLED** | `T-IDM-03`, `T-IDM-12` |
| **M10** | `signed` re-firma y re-transmite SIN chequear el block height | Sí | **KILLED** | `T-IDM-06c` |
| **M11** | El 23505 se traga y se reporta como éxito | Sí | **KILLED** | `T-LDG-08` |
| **M12** | Se borra el término del LEASE del `ON CONFLICT DO UPDATE` | Sí (`.sql` válido) | **KILLED** (tras arreglar un FALSO KILLED — ver abajo) | `T-MIG-08`, `08b`, `09`, `12` |
| **M13** | Se borran los tres términos del intent (AC-8 desaparece) | Sí | **KILLED** | `T-MIG-09` |
| **M14** | El índice de `settle_signature` SIN `UNIQUE` | Sí | **KILLED** | `T-MIG-10` |
| **M15** | El `_down` hace `DROP TABLE` en vez de `RENAME` | Sí | **KILLED** | `T-MIG-13` |
| **M16** | La ausencia vuelve a INFERIRSE de que el parseo no verifique (conducta pre-AR) | Sí (2ª formulación) | **KILLED** | `T-IDM-13`, `14`, `14b`, `16`, `17` |
| **M17** | Se elimina el gate de re-hidratación del ciclo `down → up` | Sí (`.sql` válido) | **KILLED** | `T-MIG-15`, `15b`, `15c` |
| **M18** | El parse no disponible vuelve a leerse como `landed_mismatch` (AR MNR-3) | Sí (2ª formulación) | **KILLED** | `T-IDM-13`, `T-IDM-18` |
| **M19** | `landed_failed` vuelve a saltear la prueba de expiración (AR MNR-2) | Sí (2ª formulación) | **KILLED** | `T-IDM-19` |
| **M20** | La retención de histórico insuficiente deja de fallar el preflight (AR MNR-1) | Sí | **KILLED** | `T-IDM-20` |
| **M21** | La retención NO MEDIBLE vuelve a continuar sin la declaración del operador | Sí | **KILLED** | `T-IDM-20c`, `20c2`, `20c4` |

**21/21 KILLED. Ningún superviviente.** (M16–M17 del AR; M18–M21 del re-AR.) Los tres mutantes que hubo que reformular
(M1, M2, M7) NO se contaron hasta que compilaron: un mutante que rompe el parseo o los
tipos lo caza el compilador, no el test, y contarlo sería un falso KILLED.

### Correcciones a los punteros del Story File (no son defectos, son hallazgos)

- **M2** — el Story File esperaba `T-IDM-01`/`T-IDM-02`. **`T-IDM-02` no puede
  matarlo**, y el motivo es interesante: con `in_progress` tratado como `claimed`, el
  segundo request concurrente igual se frena en `recordSignedIntent` (la fila ya está
  en `signed`, así que el `UPDATE ... WHERE status='claimed'` no aplica) ⟹ sigue
  saliendo **1 solo broadcast**. O sea que el persist-before-broadcast es un SEGUNDO
  candado real sobre la concurrencia, no sólo sobre el orden. Lo mata `T-IDM-09b`.
- **M11** — el Story File esperaba también `T-IDM-08`. No puede: en esa suite el
  ledger está MOCKEADO, así que una mutación dentro de `settle-ledger.ts` no se
  ejecuta. `T-IDM-08` prueba cómo REACCIONA el adapter a una colisión; `T-LDG-08`
  prueba cómo el ledger la TRADUCE. Sólo el segundo puede cazar esta mutación.

---

### [2026-07-29 03:3x] AR BLQ-MEDIO-1 — Un `null` de RPC declarado como prueba

- **Error**: la salida que autoriza RE-TRANSMITIR exigía dos hechos y yo declaré los
  dos como pruebas (`"Las tres salidas son por DEMOSTRACION, nunca por tiempo"`). Sólo
  uno lo era. El segundo —"la tx no está en la cadena"— salía de que
  `getParsedTransaction` devolviera `null`, y ese `null` también significa *este nodo
  no tiene ese histórico*, *va atrasado* o *el índice está degradado*.
- **El doble pago concreto**: la tx aterriza, `confirmTransaction` corta por timeout, y
  el retry consulta la altura contra el nodo de la punta (expirado ✓) y el parseo
  contra otro nodo del pool que no indexó ese bloque (`null`) ⟹ "expiró sin aterrizar"
  ⟹ **segundo SPL transfer real**. Sin backstop on-chain.
- **Causa raíz**: el tipo. `VerifyResult` es `{valid: boolean}`, y con un booleano
  *"probado que no está"* y *"no pude preguntar"* colapsan en el mismo `false`. El
  call-site no podía distinguirlos ni aunque quisiera. Es el mismo error que yo mismo
  había evitado en el seam del ledger (uniones discriminadas, CD-11) y no apliqué acá.
- **Fix**: la determinación negativa pasa a `getSignatureStatuses` con
  `searchTransactionHistory: true` (responde `null` **habiendo buscado**), y el
  veredicto vive en `SettlementPresence`, una unión de **cinco** estados que el
  compilador obliga a agotar: `landed_ok` / `landed_failed` / `landed_mismatch` /
  `absent` / `unknown`. Los dos últimos eran el mismo valor y son opuestos.
  `VerifyResult` NO se tocó: lo comparten 4 adapters EVM que son Scope OUT.
- **Aplicar en**: **toda consulta a un sistema externo tiene TRES respuestas, no dos —
  está / no está / no pude preguntar.** Si el retorno es un `boolean` o un `T | null`,
  el tercer caso ya se perdió en el DISEÑO y todo call-site aguas abajo lo va a
  colapsar mal. El arreglo tiene que vivir en el tipo, no en el call-site: si el tipo
  lo fuerza, el próximo que lo toque no puede repetirlo.

---

### [2026-07-29 03:4x] AR MNR-4 — Una decisión de no destruir evidencia abrió otro hueco

- **Error**: el `_down` renombra la tabla en vez de borrarla (correcto: la evidencia de
  a quién se le pagó no se destruye). Pero re-aplicar el `up` crea **una tabla nueva y
  vacía**, y eso deja **sin dedup a todo intent en vuelo**: el siguiente retry re-paga.
  La query de inventario existía, pero enmarcada como *"antes de BORRAR el backup"*, no
  como *"antes de re-aplicar el up"*.
- **Causa raíz**: pensé el `_down` como final de camino, no como mitad de un CICLO. Un
  rollback casi siempre viene seguido de una restauración.
- **Fix**: gate EJECUTABLE en el `up`, antes de crear la tabla — aborta con
  `WKH307_BACKUP_NOT_REHYDRATED` si el backup conserva filas `status <> 'confirmed'`.
  No un paso en un runbook: es exactamente el *"gate que nadie corre no es un gate"*
  que esta misma HU aplica al preflight de esquema.
- **Aplicar en**: cuando una migración `_down` preserva datos, preguntarse **qué pasa
  al re-aplicar el `up`**. Preservar sin re-hidratar es preservar para nadie.

---

### [2026-07-29 03:05] W4 — M12 produjo un FALSO KILLED: "no tests" en vez de un test rojo

- **Error**: al borrar el término del lease del `.sql`, la suite de migración reportó
  **`no tests`** en vez de un fallo nombrado. El helper que extrae el predicado
  (`withLeaseAsFlag`) se llamaba en el cuerpo del `describe`, o sea durante la
  **COLECCIÓN**: su `throw` abortaba el archivo entero antes de registrar un solo test.
- **Causa raíz**: confundir "la suite se puso roja" con "el test cazó la mutación". Un
  archivo que no colecciona pone todo en rojo **sin haber probado nada**, y encima
  esconde el resto de los tests del archivo. Es exactamente el falso KILLED que CD-15
  describe, sólo que por otra vía que la habitual (no fue el compilador, fue el
  colector).
- **Fix**: la extracción pasó a ser **diferida** (`const guard = () => …`, invocada
  dentro de cada `it`). Con el mismo mutante aplicado, ahora fallan **4 tests
  nombrados** (`T-MIG-08`, `08b`, `09`, `12`) — un KILLED de verdad.
- **Aplicar en**: **ningún helper que pueda TIRAR se invoca en el cuerpo de un
  `describe`.** Todo lo que valida entrada externa (un `.sql`, un fixture, un archivo)
  va dentro del `it`. Y la regla de lectura: **"no tests" NUNCA cuenta como mutante
  muerto** — hay que ver el nombre del test que falló y el motivo.

---

### [2026-07-29 02:41] W3 — El doble de la firma explotaba al serializar

- **Error**: los tests del adapter fallaban con
  `Signature verification failed. Invalid signature for public key […]`. El doble del
  operador era `{ publicKey, secretKey: new Uint8Array(64) }` (64 ceros).
- **Causa raíz**: `tx.serialize()` **VERIFICA** las firmas. Mientras el adapter usaba
  `sendAndConfirmTransaction` eso no se notaba (el helper estaba mockeado y nadie
  serializaba); al pasar a `sendRawTransaction(tx.serialize())` el doble falso dejó de
  alcanzar. El test fallaba **por el doble, no por el código**.
- **Fix**: `Keypair` REAL (`Keypair.generate()` / `fromSeed` donde hace falta
  determinismo). Beneficio colateral: dos transacciones con el mismo mensaje bajo el
  mismo blockhash producen ahora la MISMA firma de verdad, que es exactamente el
  escenario que `T-IDM-08` necesita ejercitar.
- **Aplicar en**: cuando un refactor mueve el código a una API MÁS ESTRICTA (serializar
  y verificar, en vez de confiar), **los dobles que "alcanzaban" dejan de alcanzar**.
  Antes de culpar al código, preguntarse si el doble sigue siendo válido para la API
  nueva.

---

### [2026-07-29 02:43] W3 — Un blockhash que no era un blockhash

- **Error**: `Blob.encode[recentBlockhash] requires (length 32) Uint8Array as src`. El
  fixture usaba `'2'.repeat(32)`, o sea 32 CARACTERES.
- **Causa raíz**: un blockhash es base58 de **32 BYTES**, no una cadena de 32
  caracteres. `'1'×32` funcionaba por casualidad (base58 `'1'` = byte 0 ⟹ 32 ceros), lo
  que enmascaró el error hasta que hizo falta un segundo blockhash distinto.
- **Fix**: `Keypair.generate().publicKey.toBase58()` como generador de blockhashes
  válidos, y una cola para que un test pueda FORZAR una repetición (el escenario de
  colisión). El default devuelve uno FRESCO por llamada, como un RPC real.
- **Aplicar en**: un valor de fixture que "parece del tipo correcto" y funciona por
  casualidad es peor que uno que falla: el primer caso que necesita dos valores
  distintos revienta lejos del origen. Derivar los fixtures de la MISMA librería que
  los va a consumir.

---

### [2026-07-29 02:35] W3 — Importar un `.test.ts` desde otro DUPLICA sus suites

- **Error**: el Story File indicaba reusar `evalSqlPredicate`, "exportado" desde
  `test/hu202-hop2-lease.migration.test.ts`. Importarlo habría **re-ejecutado los
  `describe`/`it` de HU-202 dentro de mi archivo**.
- **Causa raíz**: importar un módulo lo EJECUTA; en un archivo de tests, eso registra
  sus suites en el archivo importador.
- **Verificado antes de decidir**, no asumido: un archivo con 1 test que importa el de
  HU-202 reportó **23 tests** (22 + 1). Duplicación confirmada empíricamente.
- **Fix**: el evaluador se movió a `test/helpers/sql-predicate.ts` (no matchea el glob
  de vitest, así que no se colecciona) y **ambos** archivos lo importan. Una sola
  definición, cero duplicación. Los 22 tests de HU-202 siguen pasando sin cambios.
- **Aplicar en**: el código compartido entre suites vive en un helper que NO sea
  `*.test.ts`. Y cuando una instrucción dice "reusá X de tal test", **medir el efecto
  antes** — el conteo de tests es la evidencia.

---

### [2026-07-29 02:45] W3 — Un guard nuevo que hace fallar tests ajenos NO es un test desactualizado

- **Observación, no error**: al volver `intentId` obligatorio (DT-9), **14 tests** del
  leg Solana en `downstream-payment.test.ts` pasaron a devolver `null`. Todos llamaban
  a `signAndSettleDownstream(agent, logger)` **sin** `intentId`, apoyándose justamente
  en el fallback derivado que esta HU elimina.
- **Por qué se documenta**: la tentación era "el guard rompe tests, aflojá el guard".
  Lo correcto era lo contrario — esos 14 tests eran la EVIDENCIA de cuánto se usaba el
  fallback, y re-anclarlos (pasando un `intentId` explícito) es lo que confirma que el
  camino nuevo es el que se ejercita. Se agregaron además 3 tests para los dos
  skip-codes nuevos, incluido el que prueba que **sin clave estable no se toca la red**.
- **Aplicar en**: cuando un guard nuevo pone en rojo tests preexistentes, la primera
  pregunta es *¿estos tests dependían de lo que el guard elimina?*. Si la respuesta es
  sí, re-anclarlos ES el trabajo; aflojar el guard sería borrar la evidencia.

---

### Delta de tests — DERIVADO, no afirmado (CR menor 3)

El CR no pudo re-derivar el delta sin hacer checkout de la base. Queda derivable con
estos comandos, contra el commit base de la HU (`013d04e`):

```bash
# RETIRADOS (la batería vieja completa)
git show 013d04e:src/adapters/solana/intent-dedup.test.ts | grep -c "^  it("   # 26

# AGREGADOS
grep -c "^  it(" src/adapters/solana/intent-dedup.test.ts                       # 27
grep -c "^  it(" src/adapters/solana/settle-ledger.test.ts                      # 20
grep -c "^  it(" test/wkh307-solana-settle-intents.migration.test.ts            # 31
# y el delta de los dos re-anclados:
#   payment.test.ts     19 → 23   (+4)
#   downstream-payment  71 → 74   (+3)
```

`retirados = 26` · `agregados = 27 + 20 + 31 + 4 + 3 = 85` · **neto = +59**.

Reconcilia exacto con el total corrido: **4072 (baseline) + 59 = 4131**.

---

### [2026-07-29 10:0x] Ejercicio del SQL contra Postgres — 27/27, y dos hallazgos

Los 31 tests de migración **parsean el `.sql` y evalúan predicados en JS**; aplicar la
migración prueba que el DDL es válido. Ninguna de las dos cosas ejecuta las funciones.
`scripts/exercise-wkh307-functions.mjs` las corre contra la base de desarrollo:
**27/27 casos coinciden con lo que los tests en JS afirman**, incluidos el
`INSERT ... ON CONFLICT`, el `make_interval` en sus dos direcciones, el
`expired_signatures || ARRAY[...]` y el `RETURNS TABLE` + `RETURN NEXT` — que hasta hoy
nunca se habían ejecutado.

**Hallazgo 1 — una garantía escrita que la base no cumple (fixture, no código).**
`T-LDG-10` usaba uint64 max (`18446744073709551615`) como valor de
`last_valid_block_height` para probar que "viaja como string sin coerción". Es cierto en
el borde TS, pero **la columna es `BIGINT` con signo** (techo 9223372036854775807): ese
valor hace que `record_solana_settle_signed` tire `22003 out of range`. O sea que el
test implicaba un round-trip que la base rechaza.

- **No es un bug de dinero**: un slot de Solana ronda 3.5e8, diez órdenes por debajo del
  techo; y si alguna vez desbordara, la función tira → `settle-ledger` lo traduce a
  `store_unavailable` → **fail-closed, sin transmitir** (medido: caso B2, la fila queda
  `claimed` sin firma, no con una altura truncada).
- **Fix**: el fixture pasa a `9007199254740993` (2^53+1) — sigue por ENCIMA del entero
  seguro de JS, que es lo que a WKH-196 le importa, y entra cómodo en `BIGINT`. Y el
  techo quedó **medido** en el guion (casos B1/B2) en vez de supuesto.
- **Aplicar en**: un fixture "bien grande para probar precisión" tiene que respetar el
  TIPO DE LA COLUMNA. Probar con un valor que la base rechaza no prueba el round-trip:
  prueba el borde de arriba y esconde el de abajo.

**Hallazgo 2 — el guion chocaba consigo mismo entre corridas.**
`SIG_A`/`SIG_B` eran constantes globales, pero el índice UNIQUE sobre `settle_signature`
es **global**: la segunda corrida recibía 23505 donde esperaba éxito, y todo lo de abajo
cascadeaba. Pasó de verdad y me mandó a buscar un bug de SQL que no existía. Las firmas
pasaron a tener alcance de corrida (`SigA-${RUN}`), y el guion ahora imprime el **error
crudo de Postgres** cuando una llamada no devuelve fila (un `null` pelado no distingue
"devolvió vacío" de "tiró").

**Nota operativa que costó 4 filas colgadas**: pipear la salida del guion a `head` cierra
el pipe, node recibe EPIPE y **muere antes del bloque de limpieza**. Las filas quedaron
en desarrollo y se borraron con `--cleanup-orphans` (acotado al prefijo
`wkh307-exercise-%`, verificado 4 → 0, tabla en 0). Para correrlo: sin pipe, o
redirigiendo a un archivo.

---

### [2026-07-29 10:2x] re-AR — El probe estaba probado en Postgres, pero no por su canal

- **Hueco**: `scripts/exercise-wkh307-functions.mjs` manda **SQL crudo por la Management
  API**, así que demostró que *Postgres levanta* `WKH307_PROBE_OK`. El gate necesita otra
  cosa: que **`supabase.rpc(..., { p_probe: true })` deposite esa cadena en
  `error.message`**, porque `probeSettleLedger` hace `message.includes(PROBE_OK_MARKER)`.
  Si PostgREST no expusiera el texto ahí, el veredicto sería `rpc_missing` y **`settle()`
  rechazaría todos los pagos Solana** con una alarma que manda a aplicar una migración
  que ya está aplicada.
- **Por qué era barato**: el caso C7b del ejercicio ya había demostrado que el `RAISE`
  ocurre ANTES de escribir, así que llamarlo por el cliente real no ensucia la tabla.
- **Medido** (`scripts/probe-wkh307-preflight.mts`, con `tsx` sobre el código de
  producción, no una re-implementación): `error.message === "WKH307_PROBE_OK"` **exacto**,
  `error.code === "P0001"`, `probeSettleLedger() → {probe:'ok'}`,
  `ensureSolanaSchemaReady() → {ok:true}`, y **0 filas escritas** (antes=0, después=0).
- **Aplicar en**: probar una integración **por un canal distinto del que usa el código**
  demuestra menos de lo que parece. "El SQL funciona" y "el cliente ve el error donde el
  código lo lee" son afirmaciones distintas, y la segunda es la que sostiene el gate.

---

### [2026-07-29 10:3x] re-AR MNR-1 — Mi arreglo introdujo una precondición de despliegue no escrita

- **Error**: documenté `absent` como *"prueba de ausencia"*. No lo es.
  `searchTransactionHistory: true` obliga al nodo a mirar su almacenamiento de largo
  plazo — **el que ese nodo tiene**. Un validador sin `--enable-rpc-bigtable-ledger-storage`
  devuelve `null` igual sobre una tx que sí existe, y desde la respuesta no hay forma de
  distinguir "busqué en todo el historial" de "busqué hasta donde tengo".
- **Causa raíz**: al arreglar el bloqueante cambié el disparador frecuente por uno raro,
  y **presenté el resultado como una prueba** en vez de como una mejora con precondición.
  El AR atacó su propia sugerencia y encontró el resto; yo la adopté sin auditarla.
- **Fix**: (a) la doc dice lo que realmente prueba —"este nodo, buscando en lo que tiene,
  no conoce esta firma"—; (b) la precondición **se mide** en el preflight de arranque
  (`getSlot` vs `getFirstAvailableBlock`), con umbral derivado y no arbitrario: la
  validez de un blockhash (~150 slots), que es exactamente el momento en que el código
  usa un `absent`. Medido en vivo contra el RPC configurado: **895 497 slots retenidos**.
- **La asimetría se resolvió FAIL-CLOSED, con salida explícita** (decisión del
  coordinador; yo había propuesto warn-y-seguir y el argumento que me convenció es de
  costos): permitir de más produce un `absent` falso ⟹ **segundo pago, irreversible**;
  cortar de más produce un arranque fallido, **ruidoso, inmediato y reversible en un
  minuto**. Cuando los dos errores no cuestan lo mismo, el default va del lado barato.
  · medida y suficiente ⟹ arranca · medida e insuficiente ⟹ corta ·
  **no medible ⟹ corta**, con el mensaje diciendo cómo salir.
  Mi objeción (no poder medir NO es evidencia de falla) se salvó con
  `SOLANA_RPC_LEDGER_HISTORY_DECLARED_SUFFICIENT=true`: **sin default permisivo**
  (ausente = cortar) y con un nombre que declara lo que el operador AFIRMA, no un
  `SKIP_` que el próximo lector apague por molestia. Así la decisión queda registrada en
  la configuración en vez de perderse en un warn de arranque que nadie lee.
- **Aplicar en**: un warn de arranque no es un control. Si algo tiene que decidirse, que
  el sistema **pare y pida la decisión**; el registro de esa decisión vale más que la
  comodidad de seguir.
- **Aplicar en**: cuando un arreglo cambia "inferencia" por "consulta a un tercero,
  **revisar qué precondiciones de despliegue trae esa consulta**. Una garantía que
  depende de cómo esté configurado un nodo no es una garantía hasta que alguien la
  verifica en el arranque.

---

### Residuos declarados

- **La migración NO se aplicó a ninguna base.** El Story File (W4.2) pide aplicarla a
  **bdwv**; la instrucción operativa vigente exige autorización explícita antes de
  tocar cualquier base. Queda pendiente de aprobación. `caldz` (producción) está fuera
  de alcance por diseño: es **WKH-307b**.
- **La rama POSITIVA del gate de re-hidratación NUNCA se ejecutó contra Postgres.** Es
  el único bloque ejecutable de la migración sin ejercitar: los tests parsean el `.sql`,
  el ejercicio corre las 4 funciones, y aplicar la migración sobre una base sin backup
  sólo ejercita su rama negativa. **No se probó contra bdwv a propósito**: el gate
  hardcodea `public.a2a_solana_settle_intents_backup_wkh307`, así que crearla —aunque
  fuera dentro de una transacción— arriesga dejarla si el transporte auto-commitea, y
  esa tabla **bloquearía todo apply futuro**. Probar el candado rompería el camino que
  el candado protege. Queda el escenario listo para correr en un entorno descartable en
  `gate-rehydration-test.sql`, con los dos casos y sus hallazgos posibles.
- **El e2e manual de devnet (W4.3) no se corrió**: requiere red, fondos y
  `SOLANA_DEVNET_E2E=1`. Es opcional en el Story File.

---

## Post-mortem WKH-307c — el e2e manual era incorrible, y el probe mentía el motivo

### [2026-07-29 20:15] Wave 0 — `table_missing` para un fallo de red: el séptimo sitio del bug sistémico
- **Error**: `probeSettleLedger()` clasificaba CUALQUIER `.error` de la consulta a la tabla
  como `table_missing` (`settle-ledger.ts:543-545`, antes del arreglo). Reproducido en vivo:
  el veredicto salió `table_missing — TypeError: fetch failed`, o sea el veredicto y el
  detalle contradiciéndose en la misma línea.
- **Causa raíz**: `supabase-js` **no lanza** ante un fallo de transporte: lo DEVUELVE en
  `.error`. Verificado en la fuente (`@supabase/postgrest-js/dist/index.mjs`, el
  `.catch(fetchError => ...)` construye `{ error: { message: 'TypeError: fetch failed',
  code: '', details, hint }, data: null, status: 0 }`). El `catch` del `try` —que existía
  justamente para decir "no pude preguntar"— estaba MUERTO para el modo de fallo más
  común. Costo real: `table_missing` manda a aplicar una migración ya aplicada y **no se
  reintenta solo**; `probe_failed` manda a mirar la DB y **sí** se reintenta
  (`schema-preflight.ts:72-79`).
- **Fix**: la pregunta se hace EN POSITIVO. `isRelationMissingError()` exige evidencia de
  esquema (`PGRST205` — código VERIFICADO en vivo contra bdwv, no asumido — o `42P01`, o el
  texto "could not find the table" / "relation ... does not exist"); todo lo demás es
  `probe: 'failed'`. No se inventó ningún valor nuevo: `probe_failed` ya existía en
  `SolanaSchemaFailure`.
- **Aplicar en**: TODO `if (res.error) return <veredicto definitivo>` sobre un cliente que
  devuelve los fallos de red en banda. La regla: un veredicto que afirma algo del mundo
  ("la tabla no existe", "la función es vieja") necesita evidencia POSITIVA; la ausencia de
  evidencia se llama "no pude preguntar".

### [2026-07-29 20:20] Wave 0 — el MISMO bug, 20 líneas más abajo
- **Error**: la rama del rpc del probe tenía la forma idéntica: cualquier mensaje de error
  que no fuera la marca `WKH307_PROBE_OK` salía como `rpc_missing` ("re-aplicá la
  migración, quedó una versión vieja de la función"). Un `TypeError: fetch failed` caía ahí.
- **Causa raíz**: buscar el bug "en su sitio" en vez de buscar su FORMA en todo el archivo.
  Los dos sitios estaban en la misma función.
- **Fix**: `isTransportFailure(res)` (`code === '' && status === 0`, la firma exacta que
  `postgrest-js` le pone a un fallo sin respuesta del servidor) antes de afirmar nada sobre
  el esquema. Los otros 5 sitios del archivo (`claimSettleIntent`, `recordSignedIntent`,
  `recordConfirmedIntent`, `reclaimExpiredIntent`, `readSettleIntent`) se revisaron uno por
  uno: **no tienen el bug**, porque su veredicto ante `.error` ya es `store_unavailable` /
  `unknown`, que ES "no sé". El único que discrimina por código (`23505` ⟹
  `signature_collision`) usa evidencia positiva, así que un fallo de red (`code: ''`) no
  puede colarse.
- **Aplicar en**: cuando encuentres un bug de clasificación, grepeá su FORMA
  (`if (x.error) return`) en todo el archivo antes de dar el arreglo por terminado.

### [2026-07-29 20:28] Wave 1 — un e2e imposible de correr no es un e2e
- **Error**: `devnet-e2e.manual.test.ts` era INCORRIBLE desde esta HU. `settle()` arranca
  con el preflight del ledger, y `vitest.config.ts:17-20` fija
  `env: { SUPABASE_URL: 'http://localhost:54321', ... }`. La `env` de la config de vitest
  **gana sobre `process.env`**, así que exportar las credenciales de bdwv NO servía de nada
  (cuatro intentos perdidos ahí).
- **Causa raíz**: el runbook del header documentaba SOL, USDC, ATAs y formato de clave —
  todo lo que el test necesitaba ANTES de WKH-307. Cuando la HU agregó una precondición
  nueva (una base alcanzable), el runbook no se actualizó. Una precondición que existe en el
  código y no en el runbook se descubre a mano, corriendo.
- **Fix**: `vitest.e2e.config.ts` (config aparte que NO declara `env`, e incluye SOLO ese
  archivo) + runbook reescrito con la base, el comando y la trampa de la `env`. El bloque
  `env` del config principal **NO se tocó**: es lo que impide que los ~4300 unit tests
  escriban en una base real.
- **Aplicar en**: cuando una HU agrega una precondición de ENTORNO a un camino existente,
  el runbook de ese camino es parte del Scope IN. Y un test que nadie puede correr envejece
  igual que un gate que nadie corre.

### [2026-07-29 20:29] Wave 1 — dos errores propios de esta sesión, registrados
- **Error 1**: escribí `SOLANA_SETTLE_LEDGER_SCHEMA_UNAVAILABLE` en el runbook. El string
  real es `SETTLE_LEDGER_SCHEMA_UNAVAILABLE` (`payment.ts:296`), sin el prefijo. **Causa**:
  lo escribí de memoria en vez de grepearlo. **Fix**: verificado con grep y corregido. Un
  código de error inventado en un runbook manda a buscar en los logs algo que no existe.
- **Error 2**: recomendé `set -a; . ./.env; set +a` para cargar credenciales. **No funciona
  en este repo**: aborta con `./.env: line 38: ...: command not found` porque hay valores
  con caracteres que bash interpreta. **Fix**: el runbook usa
  `node --env-file=.env ./node_modules/vitest/vitest.mjs run --config ...`, que parsea
  dotenv sin pasar por el shell. **Aplicar en**: cualquier instrucción de runbook que
  sourcee un `.env` con secretos base64 o con metacaracteres de shell en los valores.

### [2026-07-29 20:31] Decisión registrada — `passWithNoTests` en el config del e2e
- Se dejó en **`false`**, igual que el config principal. Los dos caminos se MIDIERON, no se
  supusieron:
  · sin `SOLANA_DEVNET_E2E=1` el `describe.runIf(E2E)` se degrada a `describe.skip`, el
    archivo SÍ colecta y la salida es `1 skipped` con exit 0 — `passWithNoTests` no
    participa de ese camino;
  · con el glob roto (probado con un filtro que no matchea) la salida es
    `No test files found, exiting with code 1`.
- O sea que el único caso donde el flag decide es el del glob roto, y ahí queremos ruido.
  Con `true` ese caso saldría 0 y se leería igual que un e2e exitoso: el peor resultado
  posible para un comando cuyo propósito es mover dinero real. El caso "está apagado" ya se
  distingue solo porque dice `skipped`, no `passed`, y el runbook lo declara.

### [2026-07-29 20:29] Actualización factual de "Residuos declarados"
- El residuo de arriba dice **"La migración NO se aplicó a ninguna base"**. Eso **ya no es
  cierto para bdwv**: medido en esta sesión, `probeSettleLedger()` contra bdwv devuelve
  `{ probe: 'ok' }` (861 ms, red real), o sea que la tabla resuelve **y** el rpc levanta
  `WKH307_PROBE_OK`. El probe usa `p_probe := true` y no escribió ninguna fila. Sobre
  `caldz` **no pude determinarlo** y no se consultó: sigue siendo WKH-307b.
