# Adversarial Review — WKH-SEC-04

> Worktree `/home/ferdev/.openclaw/workspace/wt-sec04`, HEAD `99e3ed0`, base `b7fa4e7`. Árbol
> verificado limpio antes y después de cada mutante (`git status --porcelain` vacío entero).
>
> **Persistido por el orquestador** desde el reporte del revisor, que por configuración no puede
> emitir archivos `.md`. Texto íntegro, sin editar.

## 0. EL EJE: ¿mueren por comportamiento o por el guardián?

Verifiqué **los 13, no 4**. Método: mutante por **reemplazo** (`.eq('owner_ref', ownerRef)` → vacío)
con `assert patrón in línea` + control de que no es comentario → `git diff --stat` → **parseo con
esbuild** → `vitest run <solo el archivo del sitio>`. **El guardián nunca estuvo en la corrida.**

Los 13 dieron `1 insertion(+), 1 deletion(-)` y `PARSE OK`. **13/13 KILLED por su propio archivo.
Ninguno sobrevive.**

| # | Sitio | Rojos (archivo del sitio, SIN guardián) |
|---|---|---|
| 1 | `fee-split.ts:365` | `FS-01` + `FS-BS` — `2 failed \| 7 passed` |
| 2 | `fee-split.ts:538` | `FS-02` + `FS-BS` — `2 failed \| 7 passed` |
| 3 | `fee-split.ts:618` | `FS-03` — `1 failed \| 8 passed` |
| 4 | `fee-split.ts:697` | `FS-04` — `1 failed \| 8 passed` |
| 5 | `arbiter.ts:110` | `AR-05` — `1 failed \| 6 passed` |
| 6 | `arbiter.ts:1070` | `AR-01` + `AR-BS` — `2 failed \| 5 passed` |
| 7 | `arbiter.ts:1100` | `AR-03` + `AR-BS` — `2 failed \| 5 passed` |
| 8 | `evidence.ts:57` | `EV-01` + `EV-BS` — `2 failed \| 3 passed` |
| 9 | `evidence.ts:76` | `EV-03` + `EV-BS` — `2 failed \| 3 passed` |
| 10 | `evidence.ts:96` | `EV-04` + `EV-BS` — `2 failed \| 3 passed` |
| 11 | `reconciliation.ts:1448` | `RC-01` — `1 failed \| 1 passed` |
| 12 | `debit-capture.ts:212` | `DC-01` + `DC-BS` — `2 failed \| 3 passed` |
| 13 | `debit-capture.ts:120` | `DC-03` + `DC-BS` — `2 failed \| 3 passed` |

**Coincide exactamente**, fila por fila, con la columna «Rojos de COMPORTAMIENTO» del
`mutation-log.md`. Los 13 `archivo:línea` citados resuelven a la línea del filtro (verificado con
`sed -n`). **Firmas**: los 13 nombran un test distinto que contiene su propio `archivo:línea`; ningún
par comparte conjunto de rojos (los `*-BS` se repiten pero siempre acompañados de un nombre único).
**La afirmación del dev se sostiene.**

> ⚠️ **Mi propio instrumento fabricó un falso resultado en la primera pasada.** Corrí
> `esbuild <file> --loader=ts`, que es inválido cuando no se lee de stdin (`"loader" without
> extension only applies when reading from stdin`), exit 1. Los 13 salieron
> `PARSE_ERROR / DESCARTADO`. Sin verificar el instrumento habría reportado «13 mutantes inválidos».
> La forma correcta es `esbuild <file>` a secas.

## 1. Security — **BLOQUEANTE-BAJO-1**

Sin secretos reales en los 5 archivos nuevos (`grep -E "sk-|eyJ|PRIVATE_KEY|0x[a-f0-9]{64}"` vacío).
`TEST_SECRET` es fixture copiado de `arbiter.test.ts:117` (verificado, idéntico).

**`BLQ-BAJO-1` — afirmación de seguridad falsa en el money-path.**

- **Archivo:línea**: `src/adapters/escrow/debit-capture.ownership.test.ts:15-17`
- **Dice**: «…y **se persiste** una autorización de débito `valid` contra un intent ajeno. **Es una
  firma consumible por el path de escrow**.»
- **Es falso.** Sin el filtro de `:212`, el flujo computa `status='valid'` y llama `persist()` → RPC
  `capture_debit_signature`, que tiene guarda de dueño a nivel DB:
  `supabase/migrations/20260713000000_wkh191a_debit_signatures.sql:83-85` →
  `IF v_owner IS DISTINCT FROM p_owner_ref THEN RAISE EXCEPTION 'OWNERSHIP_MISMATCH'`. Ese error se
  relanza en `debit-capture.ts:288` (`if (error) throw error`). **No se persiste nada**, así que no
  hay firma consumible.
- **Repro**: leer `debit-capture.ts:205-206` — el comentario de producción **dos líneas arriba del
  filtro que el test mide** ya lo dice: «El RPC re-verifica ownership en la persistencia». Y `DC-01`
  no puede detectarlo porque el propio test stubea el RPC (`mockRpc.mockResolvedValue(...)`,
  `:173-176`), o sea que la frase es infalsificable dentro de su archivo.
- **Impacto**: sobredimensiona la consecuencia de un filtro del camino del dinero y, peor, induce a
  un lector futuro a creer que la guarda del RPC no existe.
- **Sugerencia**: reescribir a lo medido — sin el filtro cambia el **veredicto en memoria** de
  `SIGNER_MISMATCH` a `valid`; la persistencia la sigue bloqueando el RPC. Decir qué queda sin
  defensa en profundidad, no inventar una firma consumible.

## 2. Test Coverage / veracidad de la evidencia — **BLOQUEANTE-BAJO-2 y -3**

**`BLQ-BAJO-2` — la justificación del 13.º sitio es falsable y falsa.**

- **Archivo:línea**: `src/adapters/escrow/debit-capture.ownership.test.ts:25-26`, propagado a
  `doc/sdd/221-…/mutation-log.md:139-140` y a `doc/sdd/221-…/_INDEX-row.md:21`.
- **Dice**: «Un espía pasa igual con el nombre de la columna mal escrito, y ese error deja al dueño
  sin ver **sus propias** firmas.»
- **Repro ejecutado**: muté `debit-capture.ts:120` a `.eq('ownerRef', ownerRef)` (columna mal
  escrita), `PARSE OK`, `1 insertion(+), 1 deletion(-)`, y corrí **sólo el test preexistente**:

  ```
  node ./node_modules/vitest/vitest.mjs run src/adapters/escrow/debit-capture.test.ts
  × WHERE valid ORDER BY captured_at DESC LIMIT 1 + eq(owner_ref); amount OK → devuelve la fila
  Test Files 1 failed (1)   Tests 1 failed | 19 passed (20)
  ```

  El espía **no pasa**: `expect(calls.eq).toContainEqual(['owner_ref', OWNER])` (`:539`) compara el
  par exacto, así que `['ownerRef', OWNER]` lo pone rojo.
- **Impacto**: es el argumento que sostiene incluir el 13.º sitio, y va camino al `_INDEX-row.md`. El
  valor real de `DC-03/DC-04` existe, pero la razón escrita es falsa.
- **Sugerencia**: usar la formulación correcta, que el propio dev ya escribió bien en los `*-BS`
  («una llamada existente no prueba qué filas se tocaron»): un espía prueba que la llamada se hizo,
  **no qué filas volvieron** (p. ej. no ve un filtro correcto acompañado de una consulta ensanchada).

**`BLQ-BAJO-3` — el comentario de FS-02 atribuye el resultado a una rama que no se ejecuta.**

- **Archivo:línea**: `src/services/fee-split.ownership.test.ts:287-290`
- **Dice**: «el leg se reporta `charged` igual (`fee-split.ts:549`), porque el transfer SÍ salió y **el
  `updateErr` sólo se loguea** (`:540-547`).»
- **Repro ejecutado** (sonda temporal en FS-02, ya revertida):

  ```
  SONDA_logs_update_charged: 0
  SONDA_total_error_logs:    0
  SONDA_total_warn_logs:     0
  SONDA_row_status:          "pending"
  SONDA_reported:            "charged"
  ```

  En ese escenario el UPDATE **matchea cero filas**, PostgREST no devuelve error, `updateErr` es
  `null`, y `fee-split.ts:540-547` **nunca corre**. No se emite **ninguna** línea de log.
- **Impacto**: «sólo se loguea» implica que queda rastro. No queda. El comportamiento real es peor que
  el declarado: divergencia **silenciosa** entre lo reportado (`charged`) y lo persistido
  (`pending`), sin telemetría. El comentario de producción de `fee-split.ts:541-542` sí cubre el caso
  `updateErr` (decisión intencional y documentada), pero **no** cubre el caso cero-filas.
- **Sugerencia**: separar los dos casos en la declaración. `updateErr` → reportado y logueado (deuda
  declarada preexistente). Cero filas matcheadas → reportado y **mudo**.

## 3. Los dos hallazgos de comportamiento — ¿deuda declarada o tarea propia?

**(a) `chargeLeg` reporta `charged` con la escritura acotada** → **deuda declarada, NO tarea propia.**
El camino cero-filas exige que el `owner_ref` de un leg ya insertado cambie, y ninguna operación del
repo lo hace (el `UNIQUE` de `…wkh136_fee_splits.sql:40` no incluye `owner_ref`, pero nada reescribe
la columna). El camino `updateErr` ya está documentado como intencional en producción. **Lo que sí hay
que corregir es la declaración** (`BLQ-BAJO-3`): hoy dice que se loguea y no se loguea.

**(b) `reversedCount` cuenta con cero filas matcheadas** → **deuda declarada con ticket, NO tarea
propia hoy.** Verificado en `fee-split.ts:692-707`: el UPDATE sin match no devuelve error, se saltea
el `continue` de `:699-705` y `reversedCount += 1`. **`reverseFeeSplits` no tiene llamador de
producción** — confirmado con `grep -rn "reverseFeeSplits" src/ --include=*.ts`: sólo `fee-split.ts`,
sus dos archivos de test, y una mención en comentario en `fee-charge.ts:677`. Impacto hoy = cero.
**Pero cuando se cablee, el contador se vuelve una afirmación contable falsa** → merece TD con ticket,
no HU urgente. La nota del dev es correcta en su mecánica.

## 4. Clase B (2 sitios) — **OK**

`evidence.ts:76` y `:96` están declarados **con esas palabras** y no se disfrazan de IDOR:
`evidence.ownership.test.ts:196-215` encabeza «**GRUPO B — integridad ante una fila inconsistente.
ESTO NO ES AISLAMIENTO ENTRE INQUILINOS.**», declara que el estado no es alcanzable hoy, y cierra con
«Presentar esto como “A no ve los vouchers de B” sería afirmar de más». Los nombres de los tests
(`EV-03`, `EV-04`) hablan de «un voucher de B **colgado del intent de A**», no de acceso cruzado. La
justificación de por qué el test vale igual (los totales son entradas de `classify`) es verificable en
`evidence.ts:85-89` y `:116-119`. **Sin hallazgos.**

## 5. Entrelazado / falso compartido — **OK**

`onUpdateStart` es aditivo: default `null` (`owner-scoped-fake.ts:152`, `:229`), se invoca con `?.` en
`update()` (`:326`). `unique` es `undefined` por default y `dupKey()` retorna `null` si la tabla no lo
declara (`:287-292`). **Verificado por comportamiento, no por lectura**: corrí los 6 archivos de
SEC-03 que consumen el falso con el fake nuevo y con el de `b7fa4e7`:

```
fake NUEVO (HEAD):    Test Files 6 passed (6)   Tests 23 passed (23)
fake VIEJO (b7fa4e7): Test Files 6 passed (6)   Tests 23 passed (23)
```

**La suite de SEC-03 queda idéntica.** Ninguna tabla fuera de `fee-split.ownership.test.ts` declara
`unique`. El límite del `unique` frente a `upsert` está declarado en el header (`:66-71`). Sin
hallazgos.

## 6. `arbiter/evidence.test.ts` — declaración honesta, decisión correcta — **OK**

Las tres citas del comentario cruzado son exactas (verificadas con `sed -n`): `:42` es
`const OWNER = 'tenant-A';` (un solo dueño), `:55` es `eq: () => b,` (registra y no aplica), `:192` es
el test titulado «intent inexistente / **de otro owner**». La declaración es honesta y precisa. **La
decisión de no tocarlo es la correcta**: el archivo tiene 20 tests que dependen de ese contrato, y el
`Out of Scope` del Story File (`:696`) prohíbe arreglar. El límite queda apuntando al archivo que sí
lo mide. Misma evaluación para `debit-capture.test.ts:10-15` (citas `:85`, `:469`, `:539` verificadas
exactas).

## 7. Scope Drift — **OK**

`git diff --name-only b7fa4e7 -- src` devuelve **8 archivos, todos `*.test.ts` más
`src/services/__tests__/owner-scoped-fake.ts`**. Cero producción. AC-6 cumplido. El único cambio en
`test/ownership-filter-guard.test.ts` es dentro del bloque `/** */` del header (punto 8): ni el
escáner ni las 41 excepciones se tocaron.

## 8. Integration / Regresión — **OK**

```
Test Files  273 passed | 6 skipped (279)
     Tests  5358 passed | 19 skipped (5377)
tsc --noEmit  exit=0
biome check src/  Checked 472 files. No fixes applied.  exit=0
```

Coincide **exacto** con lo declarado en `mutation-log.md:56-58`. Base `5330 → 5358` = +28 tests, +5
archivos, tal como se declara.

## 9. Error Handling — **OK** (ver §3)
## 10. Data Integrity — **OK**

Los fixtures tienen dos `owner_ref` (CD-2, verificado en los 5). Cada test negativo tiene su gemelo
positivo anti-vacuidad y afirma primero que la fila ajena **existe** (CD-25), lo que descarta el falso
verde por tabla vacía.

## 11. Performance — **N/A** — sólo tests; suite corre en 9.87s, sin regresión.
## 12. Type Safety — **OK** — `tsc --noEmit` limpio; los casts son de fixture en tests.
## 13. Destructive Migrations — **N/A** — la HU no toca `supabase/migrations/`.
## 14. RPC `SECURITY DEFINER` — **N/A** — la HU no crea ni modifica RPCs.

Colateral: el `capture_debit_signature` que leí para `BLQ-BAJO-1` tiene
`SET search_path = public, pg_temp` y chequeo de ownership interno — correcto.

## 15. Cache Invalidation — **N/A** — no hay capa de cache.

## MENORes

- **`MNR-1`** — `fee-split.ownership.test.ts:262-264` describe la salida de un comando y la describe
  mal: dice que `grep -rn "reverseFeeSplits" src/ --include=*.ts` «devuelve sólo el propio
  `fee-split.ts` y una mención en un comentario de `fee-charge.ts:677`». Devuelve **5 archivos**:
  también `fee-split.test.ts` (3 hits) y `fee-split.ownership.test.ts` (4 hits). La **conclusión**
  (sin llamador de producción) es correcta; la descripción de la salida no.
- **`MNR-2`** — `arbiter.ownership.test.ts:339` y `:342` usan `process.env.X = undefined`, que en Node
  deja el **string `"undefined"` de 9 caracteres** (verificado: `typeof === 'string'`,
  `length === 9`). El idioma del repo es `delete process.env.X` (`arbiter.test.ts:461`, `:463`,
  `:1398`, `:1730`, `:1747`). Impacto hoy nulo (`arbiter.ts:90` compara `=== 'true'`, y vitest aísla
  por archivo), pero deja `ARBITER_NONCE_SECRET="undefined"` donde antes no existía la variable.
- **`MNR-3`** — `fee-split.ownership.test.ts:353-357` describe el hallazgo (b) sólo sobre
  `reversedCount`. Se queda corto: `fee-split.ts:708-717` también hace
  `legs.push({... status: 'reversed'})`, o sea que el payload entero afirma la reversa, no sólo el
  contador.

## VEREDICTO: **RECHAZADO (BLOQUEANTEs activos)**

Fix-pack por prioridad. Los tres son de la misma clase — **prosa que afirma de más en archivos que se
mergean** — y los tres los falsifiqué con un comando concreto. Ninguno rompe funcionalidad.

1. `BLQ-BAJO-1` — `debit-capture.ownership.test.ts:15-17`
2. `BLQ-BAJO-2` — `debit-capture.ownership.test.ts:25-26` + `mutation-log.md:139-140` +
   `_INDEX-row.md:21`
3. `BLQ-BAJO-3` — `fee-split.ownership.test.ts:287-290`
4. `MNR-1`, `MNR-2`, `MNR-3`

**Lo que NO es hallazgo y quiero dejar dicho**: los 13 mutantes mueren de verdad por comportamiento,
el falso compartido es genuinamente aditivo, la Clase B está declarada con las palabras correctas, el
límite de `evidence.test.ts` es honesto, y no hay una línea de producción tocada. El núcleo técnico de
la HU se sostiene.
