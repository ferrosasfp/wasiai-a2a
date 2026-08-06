# Code Review — WKH-SEC-04 (post fix-pack AR)

> Worktree `/home/ferdev/.openclaw/workspace/wt-sec04`, rama
> `feat/221-wkh-sec-04-owner-ref-dinero-y-disputas`, HEAD `853ed66`, base `b7fa4e7`, AR previo en
> `99e3ed0`.
> Árbol verificado con `git status --porcelain` **vacío** antes y después de cada sonda (7 sondas: 1
> mutante de columna, 2 archivos de prueba temporales, 4 mutantes de reemplazo). Estado final: vacío,
> HEAD `853ed66`.
>
> **Persistido por el orquestador**: el revisor no puede emitir `.md` por configuración.

## 0. GATE — ¿los 3 BLOQUEANTEs del AR están cerrados? **SÍ, los 3, con repro propio**

Ninguno se dio por bueno leyendo `fix-pack-ar.md`. Los tres se re-midieron.

### `BLQ-BAJO-1` (AR) — «se persiste una firma consumible» → **CERRADO**

Verifiqué **yo** las dos fuentes que la frase nueva invoca:

- `supabase/migrations/20260713000000_wkh191a_debit_signatures.sql:83-85` es literalmente
  `IF v_owner IS DISTINCT FROM p_owner_ref THEN RAISE EXCEPTION 'OWNERSHIP_MISMATCH: intent % not
  owned by caller'; END IF;`, y está **antes** del INSERT (`:104-126`), dentro del `BEGIN` del RPC. ✅
- `src/adapters/escrow/debit-capture.ts:288` es `if (error) throw error;`. ✅
- `debit-capture.ts:205-206` es el comentario de producción «El RPC re-verifica ownership en la
  persistencia». ✅
- `:212` es el filtro; `:236-242` es la rama `SIGNER_MISMATCH`; `:247` es `status = 'valid'`;
  `:275-287` es la llamada `supabase.rpc('capture_debit_signature', {...p_status, p_reason})`. Las
  **seis** citas resuelven al sujeto que nombran.

La afirmación fuerte nueva —«lo único que queda entre ese veredicto y una firma consumible es el
`RAISE` del RPC» (`debit-capture.ownership.test.ts:28-29`)— **la verifiqué leyendo el cuerpo entero
del RPC**: entre el `RAISE` de `:83-85` y el `INSERT` de `:104-114` sólo hay degradación anti-replay
(`:87-100`), que no es una guarda de dueño. La frase es exacta.

Y sí, **declara honestamente que este archivo no puede medir esa guarda** (`:32-35`: «DC-01..DC-04
stubean el RPC … toda frase sobre lo que la base persiste es infalsificable acá adentro. Se refuta o
se confirma leyendo la migración, no corriendo este archivo»). Eso es lo que faltaba. **Cerrado.**

⚠️ Pero el puntero de esa misma declaración apunta mal → `BLQ-BAJO-1` **nuevo**, §1.

### `BLQ-BAJO-2` (AR) — el espía y la columna mal escrita → **CERRADO en los 3 sitios**

Repro **mío**, no copiado:

```
python3: assert ".eq('owner_ref', ownerRef)" in linea 120  → OK, no es comentario
mutado:  "      .eq('owner_ref', ownerRef)" → "      .eq('ownerRef', ownerRef)"
git diff --stat -- src/adapters/escrow/debit-capture.ts
  1 file changed, 1 insertion(+), 1 deletion(-)
./node_modules/.bin/esbuild src/adapters/escrow/debit-capture.ts   → PARSE OK (exit 0)
node ./node_modules/vitest/vitest.mjs run src/adapters/escrow/debit-capture.test.ts
  ❯ src/adapters/escrow/debit-capture.test.ts:539:22
    539| expect(calls.eq).toContainEqual(['owner_ref', OWNER]);
  Test Files  1 failed (1)
       Tests  1 failed | 19 passed (20)
```

El diff del fallo muestra `["ownerRef","tenant-A"]` contra el esperado `["owner_ref", ...]`.
**Coincide exactamente** con lo que ahora afirman los tres sitios:

- `src/adapters/escrow/debit-capture.ownership.test.ts:43-52` ✅
- `doc/sdd/221-…/mutation-log.md:139-153` ✅
- `doc/sdd/221-…/_INDEX-row.md:21` ✅ (verificado con `--word-diff`)

Y la reformulación («un espía prueba que la llamada se hizo, no qué filas volvieron») está anclada en
hechos que verifiqué: `debit-capture.test.ts:85` y `:469` son ambos `eq: () => builder`, y `:539` es
el `toContainEqual`. **Cerrado.**

### `BLQ-BAJO-3` (AR) — `updateErr` logueado vs cero-filas MUDO → **CERRADO**

Sondeé el caso cero-filas **yo**, con una copia temporal de `fee-split.ownership.test.ts`
(`src/services/zz-cr-probe.test.ts`, corrida y borrada):

```
FS-02 → {"err":0,"warn":0,"info":0,"errCalls":[],"warnCalls":[],
         "row_status":"pending","row_owner":"owner-B-0xbbbb","reported":"charged"}
```

Cero líneas de log de cualquier nivel, fila `pending` y ya de B, reportado `charged`. Idéntico a lo
declarado.

**Y probé la refutación que el propio archivo ofrece** (`:307-308`):

```
con expect(logSpy.error).toHaveBeenCalled() → Test Files 1 failed (1) | Tests 1 failed
```

La frase es falsable desde adentro del archivo, tal como promete. Los dos casos quedan separados y
numerados en `:294-309`, y las citas de respaldo resuelven exacto: `fee-split.ts:538` es el
`.eq('owner_ref', ownerRef))`, `:540-547` es el bloque `if (updateErr) { log.error(...) }`,
`:541-542` es el comentario de producción, `:549` es el `return { ...base, status: 'charged', txHash }`.
**Cerrado.** La corrección también está propagada a `_INDEX-row.md:21`.

**Gate del AR: 3/3 cerrados.**

---

## 1. Veracidad de la prosa NUEVA — **BLOQUEANTE-BAJO-1**

Barrí toda la prosa agregada por `853ed66` (`git diff 99e3ed0 853ed66`: 3 archivos de `src/` y 5 de
`doc/`). Hay **una** afirmación nueva cuyo puntero no resuelve a su sujeto — y es, con ironía
completa, el puntero de la frase escrita para cerrar `BLQ-BAJO-1`.

### `BLQ-BAJO-1` — la cita que el propio fix-pack invalidó al escribirla

- **Categoría**: veracidad de la evidencia / `archivo:línea`
- **Archivo:línea**: `src/adapters/escrow/debit-capture.ownership.test.ts:33`
- **El sujeto está en otro lado.** En el mismo commit `853ed66` el header creció 18 líneas y empujó el
  stub de `:173` a `:199`:

  ```
  $ git show 99e3ed0:src/adapters/escrow/debit-capture.ownership.test.ts | grep -n "mockRpc.mockResolvedValue"
  173:    mockRpc.mockResolvedValue({          ← era cierto en el AR
  $ grep -n "mockRpc.mockResolvedValue" src/adapters/escrow/debit-capture.ownership.test.ts
  33:  * (`mockRpc.mockResolvedValue(...)`, `:173-176`), ...
  199:    mockRpc.mockResolvedValue({          ← es cierto HOY
  ```

- **Repro (las DOS lecturas posibles del `:NNN` desnudo, y las dos fallan)**:

  ```
  $ sed -n '173,176p' src/adapters/escrow/debit-capture.ownership.test.ts
      debit_nonce: '1',
      debit_key_id_hash: '0xhash',
      debit_hop1_tx_hash: null,
      debit_settle_status: null,      ← fixture de signatureRow(), NO el stub

  $ sed -n '173,176p' src/adapters/escrow/debit-capture.ts
    // 3. Derivar server-side (CD-S1): keyId canónico + monto atómico server-computado.
    const keyIdHash = keccak256(stringToBytes(keyId));
    const serverAmountAtomic = parseUnits(finalAmountUsd.toString(), decimals);
                                          ← derivación del keyId, NO el stub
  ```

  El resto de los `:NNN` desnudos de este header (`:205-206`, `:205-216`, `:236-242`, `:247`) refieren
  a `debit-capture.ts`, así que la lectura por defecto de `:173-176` es la de producción — y ahí es
  una derivación de keccak. Bajo la otra lectura es un literal de fixture con campos `debit_*` que
  **se parece** a un stub de firmas. Es exactamente la trampa de la que este repo tiene lección
  escrita: un `archivo:línea` que apunta mal pero muestra algo que el verificador espera ver.

- **Impacto**: es el puntero **portante** de la única frase que el fix-pack agregó para cerrar
  `BLQ-BAJO-1`. La declaración «este archivo no puede medir esa guarda porque stubea el RPC» sólo vale
  si el lector puede llegar al stub. Hoy no llega: llega a un fixture. Y el defecto es
  **auto-infligido por el fix-pack**, que corrió la línea sin actualizar la cita.
- **Sugerencia**: apuntar a `:199-202` y desambiguar el archivo. No cambia una sola línea de código
  ejecutable.
- **Por qué BLOQUEANTE-BAJO y no MENOR**: misma clase por la que el AR rechazó, vive en `src/`, es
  nueva de este commit. El contenido de la frase es correcto; lo falso es sólo el puntero.

**Lo que NO es hallazgo, y lo digo porque lo busqué específicamente**: el resto de la prosa nueva es
falsable y verdadera. Verifiqué una por una:

| Afirmación nueva | Con qué se refuta | Resultado |
|---|---|---|
| `debit-capture.ownership.test.ts:20-30` — no se persiste; la guarda es el RPC | migración `:83-85` + `debit-capture.ts:288` | ✅ exacta |
| `:28-29` — «lo único que queda es el `RAISE`» | cuerpo entero del RPC (`:74-126`) | ✅ entre el RAISE y el INSERT sólo hay anti-replay |
| `:47-52` — el espía SÍ caza la columna mal escrita | mutar `:120` y correr `debit-capture.test.ts` | ✅ reproducido idéntico |
| `fee-split.ownership.test.ts:294-309` — (i) logueado / (ii) mudo | sonda propia + `expect(logSpy.error)` | ✅ `0/0/0`, y la refutación da rojo |
| `:371-380` — el payload entero afirma la reversa | sonda propia sobre FS-04 | ✅ `{status:'reversed', txHash:'0xAAA-tx-de-A'}` con la fila en `charged` |
| `:355-359` — el pre-chequeo de `:676-683` filtra en memoria | leer `fee-split.ts:676-683` | ✅ `rows.filter(...)` + corte `ownership_mismatch` |
| `arbiter.ownership.test.ts:338-344` — `= undefined` deja el string de 9 chars | `node -e` + `sed -n` sobre `arbiter.test.ts` | ✅ `string 9`; las 5 líneas son `delete` |

---

## 2. El conteo de `MNR-1` — **OK, y no se auto-invalida**

Corrí el grep **yo**, hoy, con el párrafo ya escrito en el archivo:

```
$ command grep -rn "reverseFeeSplits" src/ --include=*.ts | wc -l
20
$ ... | cut -d: -f1 | sort | uniq -c
      1 src/services/fee-charge.ts
      6 src/services/fee-split.ownership.test.ts
      7 src/services/fee-split.test.ts
      6 src/services/fee-split.ts
```

**20 hits en 4 archivos**, con la distribución exacta que declara
`fee-split.ownership.test.ts:263-267`. El AR tenía mal el número (dijo «5 archivos»): el fix-pack
tiene razón y lo dice sin maquillarlo.

El hit único fuera de `fee-split.*` **está dentro de un comentario**, verificado (`/**` abre en
`fee-charge.ts:670`, cierra en `:681`).

Y el texto **declara qué parte del enunciado es volátil**: «Los dos conteos de test se mueven cada vez
que se edita un comentario como éste; lo que no se mueve sin un llamador nuevo es que el único hit de
otro módulo sea prosa» (`:267-269`). Eso resuelve la trampa del auto-conteo: el número está fechado y
la conclusión no cuelga del número. **Correcto hoy y correcto como forma.** Ver `MNR-2` por una
imprecisión de la glosa.

---

## 3. AC-6 / Scope Drift — **OK**

`git diff --name-only b7fa4e7 -- src` → **8 archivos**: siete `*.test.ts` más
`src/services/__tests__/owner-scoped-fake.ts`. **Cero líneas de producción.**

Y verifiqué que el falso no se cuela a producción por la puerta de atrás:
`grep -rln "owner-scoped-fake" src/ test/ --include=*.ts` → 11 archivos, **todos** `*.ownership.test.ts`.
Ningún importador de producción.

El fix-pack no agregó archivos y no tocó una línea ejecutable salvo `arbiter.ownership.test.ts:345` y
`:347` (los dos `delete process.env`, dentro de un `afterEach`). **AC-6 intacto.**

---

## 4. Regresión — **OK, idéntica a la baseline**

```
$ node ./node_modules/vitest/vitest.mjs run
 Test Files  273 passed | 6 skipped (279)
      Tests  5358 passed | 19 skipped (5377)
   Duration  10.96s

$ ./node_modules/.bin/tsc --noEmit            → exit 0
$ ./node_modules/.bin/biome check src/        → Checked 472 files in 143ms. No fixes applied.  exit 0
```

---

## 5. Re-verificación de mutantes — **OK, 4 mutantes, ninguno de los 4 del fix-pack**

Elegí a propósito sitios que **el fix-pack no re-verificó**. Método: reemplazo del
`.eq('owner_ref', ownerRef)` por vacío, `esbuild <file>` **a secas**, y `vitest run` **sólo el archivo
del sitio** — el guardián estructural nunca entró a la corrida.

| Sitio | `git diff --stat` | Parseo | Rojos del archivo del sitio | AR §0 |
|---|---|---|---|---|
| `fee-split.ts:365` | `1 insertion(+), 1 deletion(-)` | `PARSE OK` | `FS-01` + `FS-BS` — `2 failed \| 7 passed (9)` | ✅ |
| `arbiter/evidence.ts:57` | `1 insertion(+), 1 deletion(-)` | `PARSE OK` | `EV-01` + `EV-BS` — `2 failed \| 3 passed (5)` | ✅ |
| `reconciliation.ts:1448` | `1 insertion(+), 1 deletion(-)` | `PARSE OK` | `RC-01` — `1 failed \| 1 passed (2)` | ✅ |
| `arbiter.ts:110` | `1 insertion(+), 1 deletion(-)` | `PARSE OK` | `AR-05` — `1 failed \| 6 passed (7)` | ✅ |

Cada rojo **nombra su propio `archivo:línea`** en el título del test, que es el control de «mutante mal
construido». `git status --porcelain` vacío después de cada uno.

Sumado a los 4 del fix-pack y los 13 del AR, **8 de los 13 sitios tienen ahora doble verificación
independiente**.

---

## 6. La entrada nueva de `auto-blindaje.md` — **útil, no decorativa**

`doc/sdd/221-…/auto-blindaje.md:98-124`. Le deja tres cosas concretas:

1. **Una causa raíz que generaliza**: «las tres frases describen algo que ocurre **fuera del alcance
   del archivo donde las escribí** … eran infalsificables **dentro de su propio archivo**, y por eso
   sobrevivieron a la suite verde y a mi relectura» (`:106-111`). Explica por qué correr los tests no
   podía cazarlo.
2. **Una prueba de bolsillo accionable**: «¿qué corrida la pone en rojo si deja de ser cierta? Si la
   respuesta es "ninguna, porque acá está mockeado", la frase no va, o va declarada como no medible»
   (`:120-122`).
3. **La advertencia de propagación** (`:122-124`): la prosa de `BLQ-BAJO-2` viajó del test al
   `mutation-log.md` y de ahí al `_INDEX-row.md`. En este repo la prosa se copia hacia arriba.

La frase «El pecado no fue equivocarme de mecánica: fue escribir una consecuencia que no medí, **al
lado de una que sí medí, con el mismo tono**» (`:111-112`) nombra el vector real: la
**indistinguibilidad tipográfica** entre lo medido y lo supuesto. **No es autoflagelación.**

---

## 7. Categorías restantes

| # | Categoría | Veredicto | Justificación |
|---|---|---|---|
| 1 | Security | **OK** | Cero producción. El RPC `capture_debit_signature` tiene `SECURITY DEFINER` + `SET search_path = public, pg_temp` (`…191a…sql:139-140`) + `REVOKE … FROM PUBLIC, anon, authenticated` + `GRANT … TO service_role` + chequeo de dueño antes del INSERT. |
| 2 | Error Handling | **OK** | Las dos deudas de comportamiento están declaradas con precisión y medidas; el AR §3 ya las clasificó como deuda declarada. El fix-pack no pretendió haberlas arreglado. |
| 3 | Data Integrity | **OK** | Fixtures con dos dueños; cada negativo con gemelo anti-vacuidad. El `delete process.env` **mejora** el aislamiento entre archivos. |
| 4 | Performance | **N/A** | Sólo comentarios + 2 líneas de `afterEach`. |
| 5 | Integration | **OK** | `owner-scoped-fake.ts` no se tocó en este fix-pack; el análisis de aditividad del AR §5 sigue vigente. |
| 6 | Type Safety | **OK** | `tsc --noEmit` exit 0. |
| 7 | Test Coverage | **OK** | 28 tests, sin cambios. 8/13 sitios con doble verificación. |
| 8 | Scope Drift | **OK** | §3. |
| 9 | Destructive Migrations | **N/A** | No toca `supabase/migrations/`. |
| 10 | RPC `SECURITY DEFINER` | **N/A** | No crea ni modifica RPCs. |
| 11 | Cache Invalidation | **N/A** | No hay capa de cache. |

---

## MENORes

- **`MNR-1` — el mismo puntero corrido, propagado a tres sitios de `doc/`.** `auto-blindaje.md:115`
  cita `debit-capture.ownership.test.ts:34-37` para respaldar una frase que vive en **`:32-33`**;
  `:34-37` contiene su continuación, una línea `*` vacía y el encabezado de la **sección siguiente**.
  El rango citado **no contiene el texto que cita**. Repro: `sed -n '34,37p' …`. La misma cita corrida
  aparece en `fix-pack-ar.md:36` y `:232`, y `fix-pack-ar.md:32` cita `:20-32` para un bloque que
  termina en `:30`. Patrón consistente de +2: se midió contra un estado intermedio del archivo.

- **`MNR-2` — la glosa del conteo del grep describe mal 2 de sus 6 hits.**
  `fee-split.ownership.test.ts:265` dice «`fee-split.ts` (6: la definición y sus logs)». De los 6,
  **dos son comentarios**: `:18` (docblock del módulo) y `:628` (separador de sección). Corolario:
  `:267-268` dice «Los **dos** conteos de test se mueven…» — son **tres**, porque el de `fee-split.ts`
  también se mueve al editar comentarios. La conclusión (sin llamador de producción) no se toca.

- **`MNR-3` — un bloque de salida atribuido a un comando que en este shell no la produce.**
  `fix-pack-ar.md:158-161` presenta `$ npx biome check src/ → Checked 472 files … exit 0`, y **cuatro
  líneas más abajo** el propio documento dice que ese comando da `Lint: 2 errors` +
  `npm error could not determine executable to run`. Repro: `npx biome check src/ ; echo exit=$?` →
  `exit=1`. (Control medido: `npx tsc --noEmit` **sí** funciona — el problema es específico de biome.)
  El resultado es correcto; lo que está mal es la **etiqueta**. En una HU cuyo tema es «prosa que
  afirma de más», un bloque `$ comando → salida` donde la salida no vino de ese comando es exactamente
  el defecto.

---

## VEREDICTO: **RECHAZADO (1 BLOQUEANTE activo)**

Los **3 BLOQUEANTEs del AR están cerrados**, verificados con repro propio y no leyendo el fix-pack.

Lo que bloquea es **nuevo y auto-infligido**: al reescribir el header, el fix-pack corrió el stub de
`:173` a `:199` y dejó la cita apuntando a `:173-176`. Bajo cualquiera de las dos lecturas posibles
del `:NNN` desnudo, ese rango muestra otra cosa — y en el archivo de test muestra un fixture con
campos `debit_*` que se parece lo suficiente al stub como para que una revisión rápida lo dé por
bueno. Es la trampa de la evidencia que se auto-confirma, en el puntero portante de la frase escrita
para cerrar `BLQ-BAJO-1`.

**Fix-pack priorizado:**

1. `BLQ-BAJO-1` — `src/adapters/escrow/debit-capture.ownership.test.ts:33`: `:173-176` → `:199-202`,
   y desambiguar el archivo.
2. `MNR-1` — mismo puntero corrido en `auto-blindaje.md:115`, `fix-pack-ar.md:36`, `:232`
   (`:34-37` → `:32-35`) y `fix-pack-ar.md:32` (`:20-32` → `:20-30`).
3. `MNR-2` — `fee-split.ownership.test.ts:265` y `:267`: la glosa de los 6 hits y el «dos conteos» → tres.
4. `MNR-3` — `fix-pack-ar.md:159-160`: etiquetar el transcript con el binario que lo produjo.

**Recomendación de proceso**: los 4 se arreglan editando números y una glosa; ninguno toca código
ejecutable, ninguno mueve la suite. Antes de re-lanzar el CR conviene un control mecánico barato: cada
`` `:NNN` `` nuevo o desplazado del diff, verificado con `sed -n` **después** de terminar de editar el
archivo, no mientras se edita. Los cuatro hallazgos de este CR son el mismo defecto: se midió contra
un archivo que después creció.

**Lo que quiero dejar dicho, porque lo verifiqué y se sostiene**: los 4 mutantes que elegí al azar
mueren por comportamiento con el guardián fuera de la corrida y coinciden fila por fila con el AR; la
suite es idéntica a la baseline en los tres controles; no hay una línea de producción tocada y el
falso compartido no tiene importadores de producción; y la entrada de `auto-blindaje.md` es de las que
sirven. **El núcleo técnico de la HU se sostiene entero. Lo que falta es un número de línea.**
