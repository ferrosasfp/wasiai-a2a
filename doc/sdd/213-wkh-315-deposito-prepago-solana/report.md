# Report — HU WKH-315 Depósito prepago en Solana

## Resumen ejecutivo

Hasta esta HU, la plata sólo podía **entrar** al gateway por EVM: no había forma de fondear
el saldo prepago de una Agent Key depositando en Solana. WKH-315 agrega ese camino:
`POST /auth/deposit` acredita un depósito SPL de USDC en Solana devnet, verificado on-chain
a `finalized`, exactamente una vez, sin que el gateway cargue ni derive ninguna clave privada
Solana, y sólo desde una wallet que probó su control con una firma ed25519. El camino EVM
queda byte-idéntico (AC-10). 15/15 ACs con evidencia archivo:línea y test nombrado, 0
bloqueantes abiertos, `tsc` limpio, suite en 4517 passed / 19 skipped, fuzz 8/8 guards
puestos en rojo al neutralizarlos por separado. La migración **no está aplicada** todavía en
ninguna base; el merge y la activación son decisión del founder.

## Pipeline ejecutado

- F0: contexto del proyecto cargado desde `.nexus/project-context.md` + relevamiento propio
  del camino EVM existente (work-item.md §1-§4)
- F1: `work-item.md` con 12 ACs (gate: HU_APPROVED)
- F2: `sdd.md`, que agrega 3 ACs derivados del diseño (AC-13/14/15) sobre los 12 heredados
  (gate: SPEC_APPROVED)
- F2.5: `story-HU-315.md`, 4 waves (W0 contratos/esquema serial, W1 los cuatro módulos en
  paralelo, W2 integración, W3 hardening/docs/evidencia)
- F3: implementación en 4 waves, 36 archivos tocados (15 fuente, 12 test, 2 migración SQL,
  1 config, 2 doc de producto, 4 artefactos de proceso), 22 commits
- AR + CR: 8 bloqueantes encontrados y resueltos en fix-packs sucesivos (detalle en
  Auto-Blindaje) — veredicto final APROBADO
- F4: APROBADO, 15/15 ACs con evidencia archivo:línea y test nombrado

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 camino feliz | PASS | `src/routes/auth.solana-deposit.test.ts:315` (T-315-01); monto verificado on-chain vs. declarado: `src/adapters/solana/deposit-verifier.test.ts:1973` (T-315-02) |
| AC-2 finalidad | PASS | `src/adapters/solana/deposit-verifier.test.ts:228` (`confirmed` ⇒ `DEPOSIT_NOT_FINALIZED`) y `:300` (T-315-03b, assert sobre el argumento `commitment:'finalized'`) |
| AC-3 idempotencia (escritura condicional atómica) | PASS | `src/routes/auth.solana-deposit.test.ts:647` (T-315-04, segunda presentación ⇒ 409); `test/wkh315-solana-deposit.migration.test.ts:111` (T-315-04b, índice único sin `chain_id`) |
| AC-4 destino equivocado | PASS | `src/adapters/solana/deposit-verifier.test.ts:477` (T-315-05, `RECIPIENT_MISMATCH`, sin crédito, sin reembolso) |
| AC-5 mint equivocado | PASS | `src/adapters/solana/deposit-verifier.test.ts:448` (T-315-06, `MINT_MISMATCH` distinguible de `RECIPIENT_MISMATCH`) |
| AC-6 indeterminado ("unknown", no "absent") | PASS | `src/adapters/solana/deposit-verifier.test.ts:336` (T-315-07, RPC tira ⇒ `unknown`) y `:389` (T-315-07b, `finalized` sin `meta` ⇒ `unknown`); evento durable: `src/routes/auth.solana-deposit.test.ts:580` (T-315-07c) |
| AC-7 gate de funding wallet (§4) | PASS | `src/routes/auth.solana-deposit.test.ts:399` (T-315-08, sin wallet bindeada ⇒ 403) y `:435` (T-315-08b, wallet distinta a la bindeada ⇒ 403 sin insertar fila) |
| AC-8 base58 byte-exacto, sin normalizar | PASS | `src/services/identity.solana-funding.test.ts:102` (T-315-09, dos pubkeys que difieren sólo en caja ⇒ dos valores distintos) |
| AC-9 monto mínimo | **PASS vacuo, declarado como tal** | `src/adapters/solana/deposit-verifier.test.ts:2030` (T-315-10, un depósito de 0.000001 acredita: no existe mínimo hoy) — `[DECIDE FOUNDER] D-2` abierto |
| AC-10 EVM byte-idéntico | PASS | `src/services/budget.test.ts:1251` (T-315-11b, llamada EVM sin `p_vm_family`); suites EVM existentes (`auth.test.ts`, `deposit-verifier.test.ts`, `escrow-verifier.test.ts`, `budget.test.ts`) verdes sin modificarse |
| AC-11 honestidad de `deposit-info` | PASS | `src/routes/auth.solana-deposit.test.ts:783` (T-315-12, flag OFF ⇒ no lista) y `:804` (T-315-12b, flag ON + owner ⇒ lista los 7 campos) |
| AC-12 cero claves privadas | PASS | `src/adapters/solana/deposit-account.test.ts:13` (T-315-13, ningún módulo del camino de depósito importa `getSolanaOperatorKeypair` ni `Keypair`, grep estático) |
| AC-13 unicidad no depende del entorno | PASS | `test/wkh315-solana-deposit.migration.test.ts:23` (T-315-14, índice único sobre `(tx_hash)` sin `chain_id`) |
| AC-14 destino inalcanzable por tipos desde Solana | PASS | `src/adapters/deposit-verifier.evm-only.test.ts:50` (T-315-15, `resolveTreasury('solana-devnet')` no compila, `@ts-expect-error`) |
| AC-15 depositante único | PASS | `src/adapters/solana/deposit-verifier.test.ts:1836` (T-315-16, dos owners de origen ⇒ `DEPOSITOR_AMBIGUOUS`) y `:1798` (T-315-16b, fee-payer tercero no confunde al depositante) |

## Hallazgos finales

- **BLOQUEANTEs**: 8 encontrados a lo largo de los fix-packs (`BLQ-MED-1`, `BLQ-MED-2`,
  `BLQ-MED-3`, `BLQ-BAJO-1` ×2 rondas distintas, `BLQ-ALTO-1`, `BLQ-ALTO-2`, `BLQ-1` de la
  iteración 6). **Todos resueltos y re-verificados** (mutación + re-AR); 0 pendientes.
- **MENORes**: `MNR-1`, `MNR-2`, `MNR-3` (fix-pack) + `M1`, `M2`, `M3`, `M5`, `M6`, `M7`,
  `M8`, `M9`, `M10` (ronda inicial). **Todos resueltos**, ninguno diferido como deuda.

## Auto-Blindaje consolidado

> Copiado íntegro desde `auto-blindaje.md` (713 líneas, 20 entradas). Esta HU llevó **seis
> rondas** de AR/CR sobre el mismo síntoma antes de cerrar la causa estructural. Se reproduce
> completo porque el valor está en el orden: cada entrada es la lección que la siguiente
> ronda todavía no había aprendido.

### W0 — Story file vs. realidad del compilador

**[W0] El story file afirmó que la suite CD-1 no habría que tocarla, y sí hubo que tocarla
(por tipos, no por conducta).** Narrowear `VerifyDepositArgs.chainKey` a `EvmChainKey` rompió
14 call-sites que escribían `chainKey: 'kite-ozone-testnet' as ChainKey`: un cast de
ensanchamiento que le borra al compilador la información de que el literal ya es EVM. Fix: se
quitaron los 14 `as ChainKey`. **Lección**: grepear `as <TipoAncho>` en los tests ANTES de
estimar el impacto de un narrowing, no sólo los valores literales.

**[W0] Una propiedad requerida nueva en `A2AAgentKeyRow` rompe 33 archivos de test, dos de
ellos intocables.** `funding_wallet_solana` se pasó a opcional (`?: string | null`), con la
razón en el docstring: el único lector en producción fail-closea sobre cualquier valor falsy.
**Lección**: contar los fixtures ANTES de elegir requerido vs. opcional (`grep -rl` aproxima
el costo en un comando).

### W1-W2 — Vacuidad de tests, no sólo del código

**[W1.3] Un test que grepea una prohibición se satisface con la prosa que la documenta.** El
test "el módulo es LEAF" matcheaba contra el fuente crudo y se ponía rojo por el comentario
que EXPLICABA la prohibición, no por violarla. **Lección**: despojar comentarios en las dos
direcciones antes de afirmar sobre el texto de un fuente.

**[W2] Un guard de seguridad por subcadena prohibía la carga útil de la respuesta.** El mint
fixture `So111…112` tenía una tirada de 40 unos consecutivos que matcheaba el needle del
secreto que el test buscaba cazar. **Lección**: un secreto formado por un carácter repetido es
indistinguible de una dirección base58 legítima; el fixture distintivo es parte del contrato
del test, no un detalle estético.

### W3.2-W3.3 — Mutación real, no cosmética

**[W3.3] Un mutante sobrevivió: el test probaba el validador, no la ausencia del fallback.**
`M18` sobrevivió porque el fixture de "sin fallback" era rechazable por OTRO motivo
(dirección EVM en la env de treasury). **Lección**: si un test afirma "X no se usa", el
fixture de X tiene que ser un valor que SÍ funcionaría si se usara; sin la campaña de
mutación, el test entra al AR como verde sin serlo.

**[W3.3] El mutante M1 del story file no compila, y eso es un hallazgo, no un obstáculo.** El
SDK tipa `commitment` como `Finality` (excluye `'processed'`), una segunda línea de defensa
independiente que el diseño no había contado. **Lección**: un mutante que no compila se
investiga, no se descarta en silencio.

**[W3.2] El story file manda editar un documento que no existe en el repo.** Falso: la ruta
tenía un typo (faltaba `architecture/`). Ver la corrección en FIX-PACK M1 más abajo.

### FIX-PACK — el descubrimiento de la causa estructural (4 iteraciones sobre el mismo síntoma)

**[BLQ-MED-1] Un guard de dinero que fallaba ABIERTO, y un comentario que afirmaba lo
contrario.** `atomicOf` ignoraba en silencio una entrada `pre` con `amount` ilegible ⇒
`preOurs = 0n` ⇒ se acreditaba el saldo ENTERO de tesorería (1000 USDC en tesorería + depósito
de 1 = 1001 acreditados). Hallazgo extra: `BigInt('')` y `BigInt('   ')` dan `0n` sin tirar,
así que `try/catch` no alcanza como validador de formato; se exigió `/^\d+$/` antes de
convertir. **Lección**: en toda suma de dinero con `catch`/`continue`, preguntar qué pasa si
la entrada saltada está del lado del MINUENDO; nunca usar `BigInt(s)` como validador de
formato.

**[MNR-2] Un campo ausente leído como "fue a otro lado".** `isOurAta` exigía `owner ===
expectedOwner` sobre un campo OPCIONAL del SDK; un RPC que lo omitía producía
`RECIPIENT_MISMATCH` determinista y sin recurso para el depositante legítimo. **Lección**: un
término redundante sobre un campo opcional no es defensa en profundidad, es una fuente de
falsos negativos con voz de veredicto.

**[M1] Concluí "el archivo no existe" de una ruta mal tipeada, y lo escribí como lección.**
`doc/MULTI-CHAIN.md` no existe; `doc/architecture/MULTI-CHAIN.md` sí, 26 KB, versionado hace
meses. **Lección**: cuando un artefacto "no existe", buscarlo por nombre en todo el repo
(`git ls-files | grep -i`) antes de escribirlo como hecho; desconfiar del hallazgo que trae su
propia explicación cómoda.

**[BLQ-MED-2] Copié el idioma de la migración exemplar, pero no la línea que cerraba la
ventana.** Faltaba `NOTIFY pgrst, 'reload schema';` al dropear/recrear
`register_a2a_key_deposit`: con caché viejo, el camino **EVM** contestaba 500. **Lección**:
al copiar el idioma de un exemplar, leer el archivo completo, no el bloque análogo.

**[BLQ-BAJO-1] Un guard que cobra antes de tener algo que cuidar.** La aserción de coherencia
cuenta-de-depósito ↔ operador se disparaba sin condicionar a que el camino de depósito
estuviera encendido: con el depósito apagado, todo settle Solana de SALIDA se caía.
**Lección**: todo guard nuevo necesita preguntarse en qué estados del sistema se dispara, y
probar SIEMPRE el lado positivo del control junto con el negativo.

**[campaña] Re-corrida de mutación: 21/21 KILLED**, incluidos 8 mutantes nuevos del fix-pack.

### FIX-PACK it2 — la indeterminación por PRESENCIA, no sólo por VALOR

**[BLQ-MED-3] Arreglé la indeterminación del VALOR y dejé abierta la de la PRESENCIA.** El
re-AR reprodujo el mismo daño exacto (1001 USDC por un depósito de 1) por tres puertas nuevas:
`preTokenBalances` ausente (`?? []` la lee como vacía), `postTokenBalances` ausente, y una
lista presente a la que le falta la fila de nuestra ATA. **Lección**: todo `?? []` / `?? 0`
sobre un dato EXTERNO en un camino de dinero es sospechoso por definición; validar campos no
cubre datos incompletos, hace falta al menos una aserción que cruce dos mediciones
independientes.

**[el needle que envejeció]** El test del lado PRE volvió a sobrevivir sin que nadie lo
tocara: el invariante nuevo también decía "deposit ATA" en su detalle, así que el needle pasó
a matchear dos guards. **Lección**: re-correr los mutantes viejos después de agregar guards
nuevos, no sólo los del cambio.

**[MENOR-1]** La cabecera prometía "NUNCA lanza" y `accountKeys` sin protección tiraba
`TypeError` (500 en vez de 503, sin evento durable). **Lección**: una promesa TOTAL necesita
un test sobre la forma DEGENERADA del input.

### FIX-PACK it3 — el guard se exime de su propia regla

**[BLQ-BAJO-1] Escribí el guard contra el `??` usando un `??`.** El invariante de conservación
comparaba `delta <= totalSourceDrop`, con `totalSourceDrop` calculado con `?? 0n`: una fila
ausente en `post` inflaba el techo. Reproducido sin atacante: una truncación de listas produce
las dos ausencias de una sola vez. Fix: igualdad de dos lados (`subió total == bajó total`),
donde ninguna ausencia puede pagar por la otra. Supuesto declarado: mint SPL clásico, sin
transfer-fee ni mint/burn (con Token-2022 este guard rechazaría fail-closed, visible).
**Lección**: todo límite (techo/piso) tiene que calcularse sobre datos que el escenario
adverso no pueda inflar; preferir igualdades de dos lados a desigualdades de uno cuando el
dato puede faltar.

**[MNR-3] Contar mutantes muertos OCULTA que un test perdió su poder.** El test del lado POST
se desafiló solo pero la campaña siguió reportando 100% KILLED porque OTRO test cubría el
mismo mutante. **Lección**: un 100% de mutación no es prueba de que ningún test se desafiló;
para un guard de dinero, el test tiene que identificar por CUÁL camino murió (needle sobre el
detalle), no sólo el veredicto.

**[el hueco que encontró la campaña, no la revisión]** El loop del invariante nuevo se
saltaba con `continue` las entradas con `amount` ilegible, sin aplicarle la lección de
BLQ-MED-1. **Lección**: al agregar un loop que recorre los mismos datos que otro ya validado,
no asumir que la validación de aquél lo cubre.

### FIX-PACK it4 — LA CAUSA RAÍZ

**[LA LECCIÓN QUE VALE MÁS QUE LAS OTRAS JUNTAS] Tres iteraciones arreglando síntomas de un
defecto de ESTRUCTURA.** El síntoma se repitió idéntico cuatro veces: `{"ok":true,
"amountUsd":"1001"}` para un depósito de 1 USDC, por cuatro causas distintas. La causa real:
`delta` se calculaba por un camino (suma por entrada de filas que matcheaban nuestra ATA) y se
auditaba por otro (agregación por índice, "gana la última"), y los dos números nunca se
comparaban entre sí. **Cuando distintas causas producen la misma salida exacta, la causa
común no está en ninguna de ellas: está en la estructura que las convierte a todas en ese
número.** Fix estructural: una sola tabla canónica por lista (índice → monto), fail-closed
(índice duplicado rechaza, monto ilegible rechaza), con TODO derivado de ella: el delta que se
acredita y la ecuación que lo audita (`delta === baja neta de las demás cuentas`). Con eso,
toda incoherencia sólo puede mover el lado derecho de la ecuación, y moverlo produce
desigualdad ⇒ `UNKNOWN`. Detalle que retrata todo: con "gana la última", invertir el orden de
dos renglones cambiaba el veredicto de `ok:true` a `UNKNOWN`. **Lección**: si una revisión
encuentra el mismo resultado por un camino nuevo después de un fix, parar de parchear y mirar
la estructura; un valor de dinero debe tener una sola derivación; frente a un dato
contradictorio, rechazar es más barato y más honesto que desempatar.

**[BLQ-BAJO-2] Enuncié una regla y la apliqué a un solo caso.** La regla "un veredicto de
indeterminación precede a cualquier veredicto medido" se aplicó sólo a `DEPOSITOR_AMBIGUOUS`,
dejando `RECIPIENT_MISMATCH` corriendo antes con un `detail` idéntico al del destino
genuinamente equivocado y sin evento durable. **Lección**: cuando se escribe una regla general
en un comentario, buscar en el mismo archivo todos los sitios que caen bajo ella antes de
cerrar.

### FIX-PACK it5 — el sobre-anuncio como causa raíz de las cinco vueltas

**[LA CAUSA RAÍZ DE LAS CINCO ITERACIONES] El sobre-anuncio apaga las revisiones.** Cada
iteración escribió una propiedad universal que la fórmula no sostenía; la de it4 era falsa en
un paso (mover el lado derecho también puede RESTAURAR la igualdad contra un izquierdo ya
inflado). **Una afirmación universal en un comentario no es documentación, es una instrucción
de dejar de buscar.** El daño no fue el bug: fue que la frase protegió al bug de ser
encontrado. Fix: toda afirmación se reescribió a su forma falsable, con el criterio explícito
de nombrar el input que la rompería. Límite escrito junto a la garantía: un dataset
internamente coherente pero falso es indistinguible de un depósito legítimo por cualquier
chequeo local; lo que acota ese riesgo es la confianza en el endpoint RPC, no este archivo.
**Lección**: un comentario que dice "cualquier/ninguno/siempre" sobre un guard de dinero
necesita, al lado, el input que lo rompería; escribir el LÍMITE junto a la garantía no es
debilidad, es lo que mantiene a la revisión buscando donde todavía hay algo.

**[BLQ-ALTO-1] Indexé por la etiqueta y no por la identidad.** La tabla canónica se indexaba
por `accountIndex` en vez de por dirección; mentir el `owner` de una de dos filas con la misma
dirección financiaba el crédito (X1 ⇒ 1001 USDC). **Lección**: la clave de una tabla canónica
tiene que ser la identidad del objeto, y ningún campo que el emisor controle puede decidir la
clasificación de un dato en un guard de dinero.

**[BLQ-ALTO-2] Tercera vez: enuncié una regla y la apliqué a un solo caso.** La presencia
bilateral se aplicó sólo a NUESTRA fila; para las demás quedaba un `?? 0n` explotable (CE1).
Tercera aparición del mismo patrón (MNR-4 en it3, BLQ-BAJO-2 en it4, ésta). **Paso mecánico
adoptado por la reincidencia**: al cerrar una iteración, grepear el archivo por el patrón que
cada regla nueva gobierna y dejar anotado en el commit cuántos sitios se revisaron.

### FIX-PACK it6 — el propio artefacto de evidencia también puede anunciar de más

**[BLQ-1] Escribí un fuzz que no podía ponerse rojo.** El fuzz decía respaldar cuatro clases
de incoherencia y era sensible a una sola; neutralizando cada guard por separado, 5 de 6
quedaron VERDES. Causa: el dataset base nunca ejercitaba duplicación, ilegibilidad ni los
cruces que exigen dos cambios del mismo lado. Fix: candado (un caso adversario por guard, con
needle asertado) + barrido ampliado. Se corrigió también el oráculo: el barrido marcaba como
"inflación" un dataset coherente que describía un depósito legítimamente mayor; el oráculo
correcto es "sobre un dataset INCOHERENTE, el crédito nunca supera el depósito real". Medición
final: 8/8 ROJO al neutralizar cada guard. **Lección**: un fuzz se valida neutralizando lo que
dice vigilar y viendo si se pone rojo; si no se puede poner rojo, no es evidencia.

**[BLQ-2] Cité números que ningún test respaldaba.** Los comentarios citaban "206 mutaciones
y 21.321 pares" contra un fuzz commiteado que corría 103 y 5.253. **Lección**: no citar cifras
de evidencia en comentarios; si la cifra importa, vive en un `expect`.

### FIX-PACK it7 — la palabra "medido" es un compromiso

**[BLQ-1] Escribí "Medido:" delante de algo que no medí.** Un comentario con tres afirmaciones
sobre por qué un caso del fuzz necesitaba cierto `owner` resultó falso o vacío en las tres,
verificado por el revisor. Razoné mirando el bloque de atribución sin comprobar el ORDEN real
de los guards del propio archivo. **Lección**: "medido" es un compromiso, no un énfasis; si la
frase que sigue no corresponde exactamente al comando corrido y su salida, no lleva esa
palabra. Antes de explicar por qué actúa un guard, verificar el orden de los guards propios:
la explicación más plausible suele ser la del guard que ni siquiera llegó a correr.

**[MNR-1] Una explicación única para cuatro casos que tenían dos motivos.** Y faltaba un
límite del ORÁCULO: `isCoherent` no lee `owner` en ninguna línea, así que es estructuralmente
ciego a esa clase de corrupción (declarado ahora junto a su definición). **Lección**: cuando
una tabla de resultados tiene varias filas con el mismo símbolo, verificar el mecanismo de
cada una por separado; todo oráculo de test tiene que declarar qué clase de error NO modela,
en el mismo lugar donde se define.

## Archivos modificados

**Fuente (15)**
- `src/adapters/chain-resolver.ts`, `src/adapters/deposit-verifier.ts`, `src/adapters/types.ts`
- `src/adapters/solana/chain.ts`, `src/adapters/solana/deposit-account.ts` (nuevo),
  `src/adapters/solana/deposit-verifier.ts` (nuevo, 889 líneas)
- `src/lib/ed25519.ts` (nuevo), `src/lib/wallet-format.ts`
- `src/routes/auth/deposit.ts`, `src/routes/auth/funding-wallet.ts`, `src/routes/auth/parsers.ts`
- `src/services/budget.ts`, `src/services/identity.ts`
- `src/types/a2a-key.ts`, `src/types/database.types.ts`

**Test (12)**
- `src/adapters/deposit-verifier.evm-only.test.ts` (nuevo), `src/adapters/deposit-verifier.test.ts`
- `src/adapters/solana/chain.test.ts` (nuevo), `src/adapters/solana/deposit-account.test.ts` (nuevo),
  `src/adapters/solana/deposit-verifier.fuzz.test.ts` (nuevo, 639 líneas),
  `src/adapters/solana/deposit-verifier.test.ts` (nuevo, 2116 líneas)
- `src/lib/ed25519.test.ts` (nuevo), `src/lib/wallet-format.test.ts`
- `src/routes/auth.solana-deposit.test.ts` (nuevo, 1105 líneas)
- `src/services/budget.test.ts`, `src/services/identity.solana-funding.test.ts` (nuevo)
- `test/wkh315-solana-deposit.migration.test.ts` (nuevo, 408 líneas)

**Migración SQL (2)**
- `supabase/migrations/20260731000000_wkh315_solana_deposit.sql` (up)
- `supabase/migrations/20260731000000_wkh315_solana_deposit_down.sql` (down, con backup de firmas)

**Config y docs de producto (3)**
- `.env.example` (+71 líneas, envs nuevas documentadas)
- `doc/INTEGRATION.md` (runbook §6.6, deuda §6.7)
- `doc/architecture/MULTI-CHAIN.md` (registro de `TD-SOLANA-CAIP2-DENYLIST` §10.1)

**Artefactos de proceso (4, este directorio)**
- `work-item.md`, `sdd.md`, `story-HU-315.md`, `auto-blindaje.md`

36 archivos, +11484/-35 líneas, 22 commits.

## Decisiones diferidas a backlog

- **`[DECIDE FOUNDER] D-2`**: no hay monto mínimo de depósito Solana. AC-9 pasa de forma vacua
  y así se declaró: `T-315-10` prueba que un depósito de 0.000001 acredita (que NO se inventó
  un mínimo). Es decisión de negocio, no deuda técnica.
- **`[DECIDE FOUNDER] D-1`**: el bucket del saldo (`budget['900001']`) y si es fungible con el
  saldo EVM. Resuelto en parte y escalado en `sdd.md` §4.2: el diseño usa bucket por red; la
  contabilidad única no es implementable dentro de esta HU.
- **`[DECIDE FOUNDER] D-4`**: quién cierra `TD-SOLANA-CAIP2-DENYLIST`. Esta HU **declara** el
  disparo (activar el rail Solana erosiona una de las tres condiciones que lo mantienen
  tolerable) pero no lo cierra. Necesita dueño.
- **`[DECIDE FOUNDER] D-6/D-7`**: recomendación de que la cuenta de depósito sea la del
  operador (no dedicada) + reserva/umbral de alerta de liquidez propuestos (2 USDC / 5 USDC),
  no hardcodeados como definitivos.
- **Migración NO aplicada**: ni en `bdwv` ni en `caldz`. El runbook (`doc/INTEGRATION.md`
  §6.6) fija el orden no negociable: migración → `A2A_DEPOSIT_OWNER_SOLANA` (+
  `..._IS_DEDICATED_SOLANA` si aplica) → `A2A_DEPOSIT_ENABLED_SOLANA=true` **al final**.
- **Costo declarado del guard de presencia bilateral (it5, BLQ-ALTO-2)**: un `transfer +
  close` del depositante y la creación de una ATA de terceros del mismo mint pasan a 503 sin
  consumir la prueba. Otros mints no se ven afectados. Está medido, no estimado.
- **Límite de fondo del verificador (it5)**: un dataset internamente coherente pero falso es
  indistinguible de un depósito legítimo por cualquier chequeo local. Lo que acota ese riesgo
  es la confianza en el endpoint RPC, y eso no vive en este archivo.

## Orden de merge

- **Sin roce con WKH-318** (cero archivos en común).
- **Roce con WKH-319**: sólo `src/adapters/types.ts`, bloques aditivos disjuntos.
- **Aviso para quien mergee después**: al aterrizar esta HU habrá **dos archivos llamados
  `deposit-verifier.ts`**: el EVM en `src/adapters/deposit-verifier.ts` y el Solana en
  `src/adapters/solana/deposit-verifier.ts`. Cualquier comentario de otra HU que apunte a
  "los primitivos transcritos" va a necesitar el path completo, no sólo el nombre de archivo.

## Lecciones para próximas HUs

1. **Cuando el mismo síntoma exacto reaparece por una causa nueva, dejar de parchear y buscar
   la estructura.** Cuatro causas distintas dieron la misma salida literal
   (`{"ok":true,"amountUsd":"1001"}`); el patrón de repetición era la evidencia, no una lista
   de casos por tapar. El fix real fue una sola tabla canónica de la que se deriva TANTO el
   crédito como su auditoría, nunca dos cálculos paralelos de un valor de dinero.
2. **Una afirmación universal en un comentario es una instrucción de dejar de buscar, no
   documentación.** Todo comentario de un guard de dinero que dice "cualquier/cero/siempre"
   necesita, al lado, el input concreto que lo rompería; si no se puede nombrar, la frase dice
   de más y protege al bug de ser encontrado.
3. **Enunciar una regla no alcanza: mecanizarla.** El mismo patrón (regla general escrita,
   aplicada a un solo caso) se repitió tres veces con el mismo autor. Sólo se cortó con un
   paso mecánico: grepear el patrón que la regla gobierna y dejar el conteo en el commit.
4. **Un test o un fuzz puede sobre-anunciar exactamente igual que un comentario.** El
   candado/barrido inicial decía cubrir cuatro clases y cubría una; se valida neutralizando
   cada guard por separado y confirmando que el artefacto se pone rojo, no leyendo su
   descripción en prosa. Y todo oráculo de test debe declarar, junto a su definición, qué
   clase de error NO modela.

## Estado final

**APROBADO — 15/15 ACs, 0 bloqueantes abiertos.** `tsc --noEmit` limpio, suite 4517 passed /
19 skipped, fuzz 8/8 guards puestos en rojo al neutralizarlos por separado. Migración sin
aplicar (pendiente de decisión de merge/activación del founder).
