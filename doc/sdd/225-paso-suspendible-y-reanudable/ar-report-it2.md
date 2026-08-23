# Adversarial Review — WKH-225 · Corte A · **ITERACIÓN 2** (fix-pack)

**Worktree**: `/home/ferdev/.openclaw/workspace/wt-225`, rama `feat/225-paso-suspendible-y-reanudable`
**Atacado**: `git diff 87134bf aa0fc13` (el fix-pack) sobre la base ya revisada `5578998..87134bf`
**Fecha**: 2026-08-23

## Veredicto

> ## 🟢 APROBADO con MENORes
>
> **Los 5 BLOQUEANTEs de la ronda 1 están CERRADOS, y los 5 se reprodujeron** — dos contra un
> Postgres 16 real, tres poniendo los testigos nuevos en ROJO contra el código viejo en un worktree
> separado.
> **0 BLOQUEANTEs nuevos. 3 MENORes nuevos** (`MNR-9`, `MNR-10`, `MNR-11`), los tres sobre **prosa
> que afirma más de lo que mide**, ninguno sobre comportamiento.

### Gates del repo (corridos por el revisor en este worktree)

| Paso | Resultado |
|---|---|
| `npx tsc -p tsconfig.json --noEmit` | ✅ exit 0 |
| `npm run lint` | ✅ `Checked 508 files. No fixes applied.` |
| `npm test` | ✅ `Test Files 303 passed | 6 skipped (309)` · `Tests 6051 passed | 19 skipped (6070)` (+24 vs ronda 1) |

⚠️ **El verde sigue sin ser evidencia.** En la ronda 1 dos BLOQUEANTEs lo pasaron. Ningún hallazgo
de abajo se cierra por "el test pasa": cada uno tiene una corrida contra Postgres, una **mutación
que lo pone rojo**, o las dos.

---

## Estado de los 5 hallazgos de la ronda 1

### ✅ `BLQ-ALTO-1` — CERRADO, reproducido contra Postgres 16

Contenedor descartable, migración aplicada tal cual. Fila envejecida a mano
(`expires_at = now() - 1h`; el trigger es `BEFORE INSERT`, así que desde la app es inmovible):

```
 --- inicial ---   | suspended | vencido=t
=== INTENTO 1 ===  ERROR: RUN_EXPIRED  (guard 3)
                   UPDATE ... WHERE token_hash AND owner_ref AND status='suspended' → 1 fila
                   ⇒ status = expired
=== INTENTO 2 ===  ERROR: RUN_EXPIRED  (guard 4 NUEVO)   → UPDATE 0
=== INTENTO 10 === ERROR: RUN_EXPIRED  (guard 4)         → UPDATE 0   status final = expired
=== dueño ajeno === ERROR: RUN_NOT_FOUND (guard 1)       → UPDATE 0
```

- **`expired` es alcanzable**: sí, en el intento 1. Era inalcanzable en la ronda 1.
- **N intentos = N eventos**: **no**. El `UPDATE` condicional afecta 0 filas desde el 2º ⇒
  `expire()` retorna en `src/services/suspended-run.ts:374` sin emitir. La amplificación de
  `strandedExposureBreached` está cerrada.
- **Guard 4 devuelve el mismo 410 la décima vez que la primera**: sí, mismo literal, mapeado en
  `src/routes/compose.ts:RESUME_CLAIM_HTTP`. No degrada a 409.
- **Concurrencia**: 5 sesiones simultáneas ⇒ `UPDATE 1` / `UPDATE 0` ×4. La afirmación del
  auto-blindaje (`1 0 0 0 0`) es cierta y se reprodujo.

**Ataque a la decisión de sacar el predicado del reloj de `expire()` — AGUANTA.** Cuatro vías
verificadas: único call-site (`:270`, dentro de la rama `RUN_EXPIRED` de `claim()`); guard 3 exige
`NOW() >= v_expires` con el reloj de Postgres en los dos lados; `expires_at` no se puede mover
post-INSERT (los tres `UPDATE` de `settle_suspended_run` tocan `status`, `resumed_at` y
`error_message`, nunca `expires_at` — en particular **`reopen` no compra tiempo**); y agotadas las
secuencias `claim/reopen/claim` a ambos lados del vencimiento, **no hay vía para marcar `expired` un
run que no venció**.

**Los dos testigos rehechos NO son vacuos**, verificado poniéndolos rojos contra `87134bf`:
`wkh225-suspended-runs.migration.test.ts` → **5 fallos**; `suspended-run.test.ts` → **2 fallos**
(`T-RUN-9` da `expected 'suspended' to be 'expired'`).
Mutaciones extra del revisor: quitar `.eq('status','suspended')` de `expire()` ⇒ **3 rojos**;
quitar `.eq('owner_ref', ownerId)` ⇒ **4 rojos**, incluidos `G-08` y `G-09` del guardián mecánico.

### ✅ `BLQ-ALTO-2` — CERRADO, con el testigo verificado ROJO contra el código viejo

**`P0-3` monta el `composeService` REAL — confirmado**: 18 `vi.mock` en
`src/__tests__/e2e/compose-flow.test.ts` y **ninguna es `services/compose.js`**.

Copiado el archivo nuevo al worktree en `87134bf`: **los 5 casos en ROJO**
(`P0-3a` `expected debit to be called 2 times, but got 1`, `P0-3b2`
`expected creditWithDest to be called 1 times, but got 0`, etc.).

**Ataque propio a `debitResumedFirstStep` (`src/routes/compose.ts:1013-1119`):**

- **¿Cobra dos veces?** No. El route debita `remaining[0]`; el bucle sigue detrás de
  `if (i > 0 && …)` — `src/services/compose.ts:616`, byte-idéntico a `5578998:571`, una sola
  ocurrencia.
- **¿Puede no cobrar?** Perseguidos los 5 returns de `{ok:true, debitedUsd:0}`: ninguno deja un step
  ejecutándose sin débito. El caso interesante es `typeof price !== 'number' || !resolved`:
  `resolveAgentPriceUsdc` devuelve `null` exactamente cuando `resolveAgentDestination` devuelve
  `null` (misma cadena), y la única divergencia posible —el cache de 60 s del precio— **empuja al
  lado seguro**.
- **¿Refund exacto?** Sí, en las dos ramas mutuamente excluyentes (`:1823` el 504, `:1858` el
  fallo), con la misma fórmula `max(0, debitado − ya settleado)`. `P0-3b2` asserta
  `debit[5] === creditWithDest[4]` (sin eso, cap leak).
- **Orden inverso**: los tres campos se setean en `:1113-1115`, **después** del
  `if (!debited.success)`, y `refundComposeStep0` sólo corre bajo `debitedUsd > 0`.
- **¿Reintrodujo el $1?** No por la puerta que importaba. El `$1` de `:1092` sólo entra con agente
  que EXISTE y precio inválido — el fallback honesto de CD-4, byte a byte el mismo que `/compose`
  aplica en `:868`. El `$1` estructural de `step0-debit.ts:33` no es alcanzable.

### ✅ `BLQ-MED-1` — CERRADO, y las dos mitades

Techo del caller: columna `max_budget_usdc` persistida y restaurada. **Techo del operador** (la
mitad que la ronda 1 destacaba): `resolveEffectivePipelineBudgetUsd`
(`src/lib/stranded-payment.ts:342-348`) hace `min(callerMaxBudget, PIPELINE_EXPOSURE_CEILING_USD)`;
con `preSpentUsd` sumado a `wouldNeed`, **los dos techos vuelven a valer una vez por run**. `P0-3d`
lo mide ejecutando.

**Aritmética de `/compose` byte-idéntica con el campo ausente**: `preSpentUsd` se usa en **una sola
expresión** (`:574`); con `undefined` queda `0 + x === x`, bit-idéntico para todo `x` no-`-0`, y los
costos son no-negativos.

### ✅ `BLQ-MED-2` — CERRADO

Gate en el call-site (`src/services/reconciliation.ts:779-781`), ternario cortocircuitando el
`await`. `T-REC-2d` arma un doble cuya respuesta para `a2a_suspended_runs` es
`{error:'relation does not exist'}` y asserta `cap.suspended.table === null`: **la tabla nunca se
pidió**. No es testigo de presencia — es la captura del `from()` que nunca ocurrió.
`queried: false` viaja crudo al operador; **nadie lo lee como "no hay ninguno"**.
Con bandera OFF y migración sin aplicar, `POST /compose/resume` degrada a **503**, no a 500.

### ✅ `BLQ-BAJO-1` — CERRADO por construcción

`frozenStepPrices` sale del **mismo `slice(ctx.i + 1)`** que arma `remainingSteps`
(`src/services/compose.ts:1361-1376`): el índice `k` de un array **es** el de otro. `T-SUSP-FROZEN`
asserta los dos arrays y la igualdad de largos.

**Bonus, `MNR-4` cerrado y medido contra PG16:**

| caso | nace vencido | `frozen_step_prices` | TTL real |
|---|---|---|---|
| `frozen_prices_expires_at = now() − 5min` | **f** | `NULL` (descartados) | 01:00:00 |
| `frozen_prices_expires_at = now() + 3min` | f | conservados | 00:03:00 |

---

## Hallazgos NUEVOS — 3 MENORes, 0 BLOQUEANTEs

### 🟡 `MNR-9` — el parser de `T-MIG-5` no generaliza, y su docblock afirma que sí

`test/wkh225-suspended-runs.migration.test.ts:88-133` (regex en `:119-122`).

Parser extraído a un script y corrido contra 4 variantes:

| variante | esperado | real |
|---|---|---|
| `.sql` de `87134bf` (con el bug) | ROJO | **ROJO** ✅ |
| `.sql` de `aa0fc13` | VERDE | **VERDE** ✅ |
| **MUT-1**: mismo `UPDATE` **anidado** en `IF TRUE THEN … END IF;` | ROJO | **VERDE** ❌ |
| **MUT-2**: `UPDATE` + `RAISE` en el **top-level** del claim | ROJO | **VERDE** ❌ |
| MUT-3: escritura vía `EXECUTE 'UPDATE …'` | ROJO | ROJO ✅ |

**Causa**: `/^[ \t]*IF .*?THEN$[\s\S]*?^[ \t]*END IF;$/gm` es no-greedy ⇒ ante un `IF` anidado el
bloque externo termina en el `END IF;` interno y el `RAISE` posterior queda fuera. Y `bloquesIf`
sólo mira bloques `IF`: una escritura suelta al nivel del cuerpo es invisible.
Que el `IF` anidado no es hipotético lo demuestra el propio fix-pack, que introdujo uno en
`trigger_set_suspended_run_expires_at` (`:129-136`).

**Impacto acotado** (por eso MENOR): la regresión exacta sí la caza `T-MIG-14`, que es literal.

### 🟡 `MNR-10` — `rejected` se documenta como "nada aplicado", y `budgetService.debit` no puede garantizarlo

`src/routes/compose.ts:1007` · `:1101-1108` · `src/services/budget.ts:129-153` y `:188`.

`debit` devuelve `{success:false, error}` **desde un `catch`**: un timeout después de que la RPC
commiteó produce el mismo shape que un rechazo por saldo. Es el patrón ya documentado en este repo:
*"no pude preguntar" ≠ "no pasó"* — y que la misma HU respeta bien tres bloques más abajo, donde el
fee distingue `unknown` de `not_charged` (`:1875-1895`).

**Por qué MENOR**: es paridad con `/compose`, y elegir `failed` sobre `reopen` es el lado seguro
contra el doble cobro. Lo nuevo es la **certeza escrita** en un tipo del camino del dinero.

### 🟡 `MNR-11` — la razón por la que `MNR-6` queda abierto es falsa contra el código del propio fix-pack

`supabase/migrations/20260823000000_wkh225_suspended_runs.sql:276-283`.

El comentario dice que bajar el guard a `resuming` dejaría que un claim concurrente marque `expired`
un run **en ejecución**. **Eso ya no puede pasar**: el fix-pack sacó la transición del RPC y la puso
en un `UPDATE … WHERE status = 'suspended'` (`src/services/suspended-run.ts:346-351`), que afectaría
0 filas. Lo que cambiaría es un 410 en vez de un 409 — molesto, no destructivo.

**La DECISIÓN sigue siendo correcta**; lo que está mal es la **razón**, y una razón falsa en un
comentario normativo hace que la próxima persona descarte por el motivo equivocado.

**El estado actual no deja un agujero peor**: un run atascado en `resuming` **sí es visible** para el
operador (`reconciliation.ts:971-980` no filtra por status). La pérdida real es la que `MNR-6` ya
nombraba.

---

## Escala — dato para el CR (check 7), medido

```
TOTAL 5578998..aa0fc13        31 archivos  +9433 / −33
  sin doc/                    27 archivos  +6397 / −33     ← 1,74× sobre ≈3680
    tests                     14 archivos  +3592 / −22
    src + supabase (no test)  10 archivos  +2753 / −5
FIX-PACK 87134bf..aa0fc13 sin doc  17 archivos  +1607 / −307
    tests                      9 archivos  +1030 / −160    ← la declaración del Dev es CIERTA
    src + supabase               +564 / −147
```

Densidad de comentario en las líneas agregadas de código de producción:

| | agregadas | comentario | vacías | **ejecutable** |
|---|---|---|---|---|
| HU completa | 2753 | 1302 (47%) | 130 | **1321** |
| **sólo el fix-pack** | 564 | **377 (67%)** | 10 | **177** |

**Respuesta al check 7** — *¿qué parte seguiría existiendo si lo escribiera alguien que ya conoce
esta librería?*: **el fix-pack son 177 líneas ejecutables**. Del lado de tests, 1030 líneas para 24
tests netos ⇒ ~43 por test, la mayoría prosa de justificación. **No se reporta como exceso
injustificado**: cierra 5 BLOQUEANTEs y 7 MENORes, y el volumen de comentario es la convención
documentada del repo. Es dato, no hallazgo — la decisión es del CR.

---

## Las re-derivaciones del fix-pack — verificadas una por una

**(a) Las 7 excepciones de ownership de `reconciliation.ts`**: derivadas con `grep` y cruzadas una
por una (640, 690, 731, 973, 1072, 1315, 1535), todas ✅. Y **abiertas las cuatro citas `:NNN-NNN`
que las razones hacen hacia docblocks y que el guardián NO mira** — ése es exactamente el modo de
falla de un "sumale N a todo": las cuatro apuntan al texto correcto.

**(b) Las 2 citas del guardián de líneas (`:602 → :616`)**: byte-identidad confirmada, una sola
ocurrencia, y **cero** referencias vivas huérfanas a `compose.ts:602`.

**Citas que el fix-pack pudo desplazar sin darse cuenta**: el `+260` de `src/routes/compose.ts`
arranca en la línea 979; todas las citas vivas hacia ese archivo apuntan por debajo de 979 ⇒
intactas. La única cita rota encontrada, `src/services/fee-charge.ts:235 → "compose.ts:611"`,
**ya estaba rota en `5578998`**: es preexistente, no del fix-pack.

---

## Las 11 categorías — iteración 2

| # | Categoría | Estado |
|---|---|---|
| 1 | Security | ✅ OK — el ownership nuevo medido por VALOR; mutaciones ⇒ 4 y 3 rojos |
| 2 | Error Handling | 🟡 `MNR-10` |
| 3 | Data Integrity | 🟡 `MNR-11` — los defectos cerrados y reproducidos contra PG16 |
| 4 | Performance | ✅ OK — `expire()` pasó a `UPDATE … RETURNING`: una query MENOS |
| 5 | Integration | ✅ OK — todo aditivo; los tipos borrados nacieron en esta HU |
| 6 | Type Safety | ✅ OK — `tsc` limpio, cero `any` en el diff |
| 7 | Test Coverage | 🟡 `MNR-9` — los 3 testigos falsos rehechos y puestos en ROJO por el revisor |
| 8 | Scope Drift | ✅ OK — 17 archivos no-doc, los 2 de guardián son contabilidad obligatoria |
| 9 | Destructive Migrations | ✅ OK — 100% aditivo; migración re-aplicada limpia contra PG16 |
| 10 | RPC `SECURITY DEFINER` | ✅ OK — el BLOQUEANTE se cerró sacando la escritura de la función que levanta |
| 11 | Cache Invalidation | ⚪ N/A |

---

## Orden sugerido — ninguno bloquea

1. `MNR-9` — el más importante: un guardián que dice cubrir más de lo que cubre **apaga la próxima
   revisión**.
2. `MNR-11` — la razón falsa en un comentario normativo.
3. `MNR-10` — `"(nada aplicado)"` es una certeza que el shape no da.

---

## Método (auditable)

- Gate completo del repo en el worktree.
- **Postgres 16 real** en contenedor descartable: migración sin tocar; claim ×3 y ×10 sobre fila
  vencida, dueño ajeno, 5 `UPDATE` condicionales concurrentes, y los dos casos del trigger.
  Contenedor eliminado.
- **Dos worktrees detached descartables**: uno en `87134bf` con los testigos nuevos encima (para
  verificar la verificación del Dev), otro en `aa0fc13` para mutar `expire()`. Ambos eliminados.
- Parser de `T-MIG-5` extraído a un script y corrido contra 4 variantes del `.sql`.
- Diffs leídos con `/usr/bin/git` (nunca bajo `rtk`, que trunca cortando hunks).
