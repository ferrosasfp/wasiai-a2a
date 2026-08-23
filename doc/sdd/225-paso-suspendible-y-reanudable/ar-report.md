# Adversarial Review — WKH-225 · Corte A

**Rama**: `feat/225-paso-suspendible-y-reanudable` (worktree `/home/ferdev/.openclaw/workspace/wt-225`)
**Diff atacado**: `git diff 5578998 HEAD` — 4 commits (`e2f7609` W0 · `0935b52` W1 · `86cd78f` W2 · `87134bf` auto-blindaje)
**Fecha**: 2026-08-23

## Veredicto

> ## 🔴 RECHAZADO — 5 BLOQUEANTEs activos
>
> **2 `BLQ-ALTO` · 2 `BLQ-MED` · 1 `BLQ-BAJO` · 8 `MNR`**
>
> Los dos ALTO están **probados ejecutando**, no argumentados: uno contra un
> Postgres 16 real (contenedor descartable, migración aplicada tal cual), el otro
> por lectura del guard `i > 0` más el testigo que el propio Dev escribió.

### Gates del repo (corridos por mí en este worktree)

| Paso | Resultado |
|---|---|
| `npx tsc -p tsconfig.json --noEmit` | ✅ exit 0, sin salida |
| `npm run lint` (biome, `src/`) | ✅ `Checked 508 files. No fixes applied.` |
| `npm test` | ✅ `Test Files 303 passed \| 6 skipped (309)` · `Tests 6027 passed \| 19 skipped (6046)` |

⚠️ **Verde no es correcto.** Dos de los BLOQUEANTEs de abajo pasan la suite entera
porque sus testigos miden el TEXTO del SQL y un doble que modela la INTENCIÓN en
vez del motor. Los 6 archivos `skipped` son los `*.real.test.ts` preexistentes
(`describe.skipIf` sin base viva) más `test/smoke-downstream-x402.test.mjs`: ninguna
suite nueva desapareció, y los 6 archivos nuevos de esta HU corren (303 = 297 de la
base + 6).

---

## 🔴 LOS DOS FOCOS OBLIGATORIOS — resueltos explícitamente

### (a) ¿Es posible la doble ejecución por replay del token? — **NO en el camino válido. SÍ en el camino vencido, sin ejecución pero con daño.**

**Medido, no leído.** Levanté Postgres 16 en un contenedor, apliqué
`20260823000000_wkh225_suspended_runs.sql` sin tocarla y corrí dos
`claim_suspended_run` concurrentes sobre la misma fila:

```
BEGIN
sesion1: 33333333-3333-3333-3333-333333333333     ← gana el lock, transiciona
COMMIT
ERROR:  RUN_ALREADY_USED                          ← sesion2, bloqueada en FOR UPDATE
CONTEXT: PL/pgSQL function claim_suspended_run(text,text) line 34 at RAISE
status final: resuming
```

- El anti-replay vive en la **base** (`FOR UPDATE` + status-gate), no en memoria del
  proceso ⇒ **CD-3 se cumple**. `src/lib/resume-token.ts` no tiene ningún `Map`,
  `Set` ni caché (`T-TOK-LEAF` verifica que sólo importa `node:crypto`, leyendo el
  fuente del **módulo**, no del test — `src/lib/resume-token.test.ts:31` resuelve
  `SELF` a `resume-token.ts`).
- La marca de redimido y la lectura son **la misma sentencia bajo el mismo lock**:
  no hay ventana entre leer y escribir en el camino `suspended → resuming`.
- El binding es a la **credencial exacta** (`computeResumeBinding`,
  `src/lib/resume-token.ts:255-261`), con precedencia delegación → sesión → key, y
  se verifica **después** del HMAC. El `owner_ref` es un guard aparte dentro del RPC.
- La firma se valida **antes** de tocar la base y antes de leer el payload
  (`src/routes/compose.ts:1503-1512`), con testigo real que espía el módulo de
  supabase (`src/routes/compose.resume.test.ts:227-230`).

🔴 **Pero el camino VENCIDO sí es replayable, y cada replay tiene efecto**: ver
`BLQ-ALTO-1`. No ejecuta steps ni mueve plata, pero emite un evento
`compose_stranded_payment` **por intento**, sin techo.

### (b) ¿Es atacable el reloj? — **NO para el vencimiento del run. La afirmación CD-19 del Dev es CIERTA.**

- `expires_at` lo escribe **Postgres**, en un `BEFORE INSERT`
  (`…suspended_runs.sql:112-129`): `NEW.expires_at := now() + make_interval(secs => NEW.ttl_seconds)`.
  Verificado **ejecutando** el INSERT contra PG16: la app manda `ttl_seconds`, no un
  instante (`src/services/suspended-run.ts:211`).
- La **lectura** compara los dos lados contra el mismo reloj: `NOW() >= v_expires`
  dentro del RPC (`…suspended_runs.sql:199`).
- `T-MIG-7` (`test/wkh225-suspended-runs.migration.test.ts:112-122`) existe y es
  cierto: barrí el `.sql` y no hay `Date.now` ni `new Date(`.
- **Barrido de todo cálculo de tiempo en Node de esta HU** — 3 sitios, ninguno es
  autoridad sobre el vencimiento del run:
  1. `src/lib/resume-token.ts:338` `Date.now()` → `iat`/`exp` del **token**. Es
     fast-fail declarado; `RESUME_EXPIRED` **no corta** el camino a la base
     (`src/routes/compose.ts:1509-1512`), así que un skew de Node no puede volver
     reanudable un run vencido ni bloquear uno vigente.
  2. `src/lib/resume-token.ts:450` `Date.now()` en `verifyResumeToken` → mismo caso.
  3. `src/services/suspended-run.ts:215` `new Date(input.frozenPricesExpireAtMs).toISOString()`
     → formatea un instante que **viene del quote**, no un "ahora". Y hoy es
     siempre `undefined` (ver `MNR-4`).

⚠️ El único efecto de reloj que sí encontré es el `LEAST` de CD-15 pudiendo producir
una fila que **nace vencida** (`MNR-4`), y hoy es inalcanzable.

---

## Findings, ordenados para el fix-pack

### 🔴 BLQ-ALTO-1 — El `UPDATE ... SET status='expired'` del claim lo **rollbackea** el `RAISE` que va dos líneas abajo

| | |
|---|---|
| **Categoría** | Data Integrity · RPC `SECURITY DEFINER` · Error Handling |
| **Archivo:línea** | `supabase/migrations/20260823000000_wkh225_suspended_runs.sql:198-204` |
| **Rompe** | **AC-7** (las dos cláusulas), CD-2 por la puerta de atrás, AC-11 |

**Qué está mal.** El guard 3 del claim hace:

```sql
IF v_status = 'suspended' AND NOW() >= v_expires THEN
  UPDATE a2a_suspended_runs SET status = 'expired' WHERE a2a_suspended_runs.id = v_id;
  RAISE EXCEPTION 'RUN_EXPIRED';
END IF;
```

Un `RAISE EXCEPTION` sin bloque `EXCEPTION` que lo atrape **aborta la transacción
entera**, y PostgREST corre cada `rpc()` en una transacción propia. El `UPDATE`
se descarta. La fila **nunca** llega a `expired`.

El exemplar del que se dice copiar hace exactamente lo contrario y lo dice:
`supabase/migrations/20260706000000_wkh137_agent_links.sql:91-93` → `-- open + expirado → LINK_EXPIRED (no consume)`, **sin UPDATE antes del RAISE**. La
divergencia no está declarada en el SDD como divergencia: está declarada como la
propiedad que hace cierto el "exactamente uno".

**Reproducción — ejecutada contra Postgres 16 real** (contenedor descartable,
migración aplicada tal cual, `a2a_agent_keys` y `trigger_set_updated_at` stubbeados):

```
paso                                   |  status   | vencido
---------------------------------------+-----------+---------
 --- estado inicial ---                | suspended | t

 --- claim #1 (esperado: RUN_EXPIRED) ---
ERROR:  RUN_EXPIRED
 --- status DESPUES del claim #1 ---   | suspended     ← NO cambió

 --- claim #2 (el SDD promete RUN_ALREADY_USED) ---
ERROR:  RUN_EXPIRED                                    ← vuelve a decir EXPIRED
 --- status DESPUES del claim #2 ---   | suspended

 --- claim #3 ---
ERROR:  RUN_EXPIRED
 --- status final ---                  | suspended
```

**Impacto.**

1. **AC-7 "SHALL dejar el run en un estado terminal"**: `expired` es **inalcanzable**.
   Barrido: el único escritor de ese literal en todo `src/` es el UPDATE rollbackeado
   (`grep -rn "'expired'" src/` → `suspended-run.ts` sólo lo usa como `reason`, nunca
   como escritura). `expire()` (`src/services/suspended-run.ts:312-363`) **lee** y
   emite, no escribe.
2. **AC-7 "SHALL emitir exactamente un evento"**: `claim()`
   (`src/services/suspended-run.ts:270-273`) llama a `this.expire(...)` cada vez que
   ve `RUN_EXPIRED`, y `expire()` no mira el `status`. ⇒ **N intentos = N eventos
   `compose_stranded_payment`**, sin techo salvo el rate-limit.
3. Esos eventos son justo los que `src/services/stranded-alert.ts:229-259` acumula en
   una ventana de 60 min para publicar `strandedExposureBreached` en `/health`.
   ⇒ **un caller autenticado puede encender la alerta de plata varada de producción
   a voluntad**, que es literalmente el daño que CD-2 existe para prevenir, entrando
   por otra puerta.
4. La fila queda `suspended` para siempre ⇒ `reconciliationService.listSuspendedRuns`
   (`src/services/reconciliation.ts:923`) le muestra al operador como "esperando" un
   run que ya venció y que nadie va a reanudar.

**Por qué la suite está verde — dos testigos que no pueden ponerse rojos.**

- `test/wkh225-suspended-runs.migration.test.ts:88-106` (`T-MIG-5`) compara
  **posiciones de literales en el string** (`marcaExpired > expiredGuard`,
  `raiseExpired > marcaExpired`). Mide el ORDEN del texto. Ninguna mutación de la
  semántica transaccional lo puede romper porque no ejecuta SQL.
- `src/services/suspended-run.test.ts:126-131` — el doble `montarRpc` hace
  `fila.status = 'expired'` **y después** devuelve el error. Modela lo que el Dev
  quiso que pasara, no lo que Postgres hace. ⇒ `T-RUN-9` ("dos intentos siguen siendo
  uno", `:356-380`) es **vacuo**: el segundo claim del test cae en `already_used`
  sólo porque el doble persistió una transición que la base descarta.

**Sugerencia (sin escribir el código).** La transición y el `RAISE` **no pueden**
convivir en la misma transacción. Dos salidas, las dos consistentes con el repo:

- (a) que el claim **no levante** para el caso vencido y devuelva un desenlace
  discriminado (una columna `out_status` en el `RETURNS TABLE`), dejando el `RAISE`
  sólo para los casos donde no hay nada que escribir; o
- (b) mantener el `RAISE` y mover la marca a un **segundo RPC idempotente** que el
  service llame al ver `RUN_EXPIRED` — con `UPDATE … WHERE id = … AND owner_ref = …
  AND status = 'suspended'` devolviendo el número de filas afectadas, y emitiendo el
  residuo **sólo si afectó 1**. Eso es lo que vuelve "exactamente uno" una propiedad
  de la base y no una promesa.

En cualquiera de las dos, `T-MIG-5` y `T-RUN-9` tienen que dejar de medir texto e
intención. El testigo que sí falsa la propiedad es el que corre el `.sql` contra un
Postgres (o, como mínimo, un doble cuyo `claim` **descarte** la mutación cuando
devuelve error).

---

### 🔴 BLQ-ALTO-2 — El primer step de un run reanudado se ejecuta y se le paga al agente, pero **nunca se le debita al caller**

| | |
|---|---|
| **Categoría** | Security (money-path) · Data Integrity |
| **Archivo:línea** | `src/routes/compose.ts:1473-1481` + `:1559-1578` · `src/services/compose.ts:404` + `:602` · `src/middleware/a2a-key.ts:1552-1554` |
| **Rompe** | El invariante central del work-item (*"cada ejecución es un débito real"*); deja al operador pagando |

**Qué está mal.** El Dev cambió `requirePaymentOrA2AKey` por `requireA2AKey` en la
cadena del resume (`src/routes/compose.ts:1479`). **Su argumento es CIERTO y lo verifiqué**:
`src/lib/step0-debit.ts:28-33` cae a `PLACEHOLDER_FEE_USD` sin
`composeEstimatedCostUsd`, así que la cadena ingenua habría cobrado $1 por cada
reanudación. **Y `requireA2AKey` autentica igual de fuerte** — mismo dispatcher
master/sesión/delegación, mismo poblado de `a2aKeyRow`/`keySessionContext`/`delegationContext`
(`src/middleware/a2a-key.ts:1569-1590`); el control de identidad no se perdió.

**Lo que sí se perdió es el otro lado del par.** El docblock de ese middleware lo dice
textual (`src/middleware/a2a-key.ts:1554`): *"SIN chain-resolution, **SIN débito**,
SIN spend-limits, SIN x402"*. Y el pipeline **cuenta con** que alguien haya debitado
el índice 0:

```ts
// src/services/compose.ts:404
for (let i = 0; i < steps.length; i++) {
// src/services/compose.ts:602   ← CD-7, byte-idéntico al :571 original (verificado)
  if (i > 0 && scopingKeyRow && chainId !== undefined) {   // ← el débito per-step
```

El resume llama a `composeService.compose({ steps: remaining, scopingKeyRow: keyRow,
chainId: run.chain_id, … })` (`src/routes/compose.ts:1559-1562`). `executePipeline`
**siempre arranca en `i = 0`**, así que el guard `i > 0` **salta el débito del primer
step del tramo restante** — y esta vez no hay middleware que lo haya cobrado antes.

**Reproducción.**

1. `COMPOSE_SUSPEND_ENABLED=true`, `COMPOSE_RESUME_HMAC_KEY` seteado, migración aplicada.
2. `POST /compose` con `steps: [agenteQueSuspende, agenteCaro]`, autenticado con una
   agent key. `agenteQueSuspende` devuelve `{ "a2a_suspend": true, … }` → **202** con
   `resumeToken`. Hasta acá todo bien: el step 0 lo debitó el middleware.
3. `POST /compose/resume` con ese token → `remaining_steps = [agenteCaro]` →
   `executePipeline` con **1 step**, `i = 0`.
4. **Esperado**: `budgetService.debit` se llama una vez por `agenteCaro`.
   **Real**: `budgetService.debit` **no se llama**. `invokeAgent` sí corre y
   `signAndSettleDownstream` sí le paga al agente desde el wallet del operador.

**Corroboración con el propio testigo del Dev** — `src/services/compose.suspend.test.ts:370`:

```ts
// 1. El débito per-step corrió UNA sola vez (el step 1). El step 0 lo
//    debita el middleware, y el step 2 no existe todavía.
expect(mockDebit).toHaveBeenCalledTimes(1);
```

Dos steps ejecutados, **un** débito, y el comentario nombra exactamente la premisa
que el resume rompe: *"el step 0 lo debita el middleware"*. En el resume no hay
middleware que lo debite.

**Impacto.**

- **Un step gratis por cada reanudación**, pagado con fondos del operador.
- Es repetible: con la bandera encendida, un caller puede registrar su propio agente
  (registry auto-registrado, sin vetting) que devuelva `{a2a_suspend:true}` como step 0
  y poner el agente caro en el step 1. Cada ciclo `/compose` → 202 → `/compose/resume`
  entrega una ejecución gratis.
- **Y el reporte miente sobre la plata**: `totalCost += agent.priceUsdc` sí corre para
  ese step, así que `chargeProtocolFee({ feeBaseUsdc: totalCostUsdc })`
  (`src/routes/compose.ts:1626-1630`) cobra fee sobre una base que incluye un importe
  que nunca se debitó.

**Por qué ningún test lo caza.** `src/routes/compose.resume.test.ts:70-72` mockea
`composeService.compose` **entero**, así que la suite del route no ve el pipeline; y
`compose.suspend.test.ts` nunca ejercita la reanudación con `scopingKeyRow` + `chainId`.
Los dos extremos del cable están testeados y el tramo del medio no existe.

**Sugerencia.** ⛔ **NO** tocar el guard `i > 0` (CD-7). El arreglo va del lado del
route: el tramo reanudado necesita cobrar su propio "step 0". Dos formas que ya
existen en el repo: (i) resolver el precio del primer `remaining_step` en un
preHandler y volver a usar el middleware de pago con `composeEstimatedCostUsd`
inyectado — que es exactamente lo que `resolveComposePriceHandler` hace para `/compose`,
y elimina de raíz el $1 de `PLACEHOLDER_FEE_USD` que motivó la divergencia; o (ii)
debitar explícitamente antes de llamar a `compose()`, con el mismo
`normalizeDestination` y el mismo `stepDestination` para que un refund posterior
libere el cap del destino correcto. Cualquiera de las dos necesita un testigo que
**no** mockee `composeService`.

---

### 🟠 BLQ-MED-1 — La reanudación no lleva `maxBudget`: el techo de presupuesto del pipeline se reinicia

| | |
|---|---|
| **Categoría** | Security (money-path) · Integration |
| **Archivo:línea** | `src/routes/compose.ts:1559-1578` (no pasa `maxBudget`) · `supabase/migrations/…:35-91` (no hay columna que lo persista) · `src/services/compose.ts:559-573` |

`/compose` pasa `maxBudget: body.maxBudget` (`src/routes/compose.ts:1153`) y el service
lo combina con el techo del env: `resolveEffectivePipelineBudgetUsd(maxBudget)`
(`src/services/compose.ts:560`), evaluado contra `totalCost`, que en el tramo reanudado
**arranca en 0** (`src/services/compose.ts:392`).

**Reproducción.** `POST /compose` con `maxBudget: 5` sobre `[kyc, a, b, c]`; suspende
tras haber gastado 4.50. `POST /compose/resume` corre `[a, b, c]` con `maxBudget`
**ausente** y `totalCost = 0`. El caller que declaró un techo de 5 puede terminar
pagando 4.50 + (lo que entre en el techo del env) — y el techo del operador
(`resolveEffectivePipelineBudgetUsd` sin `maxBudget`) vale una vez por mitad, o sea el
doble para un run suspendido.

**Impacto.** Un guard de dinero declarado por el caller y otro por el operador se
pierden en silencio en un endpoint público nuevo. No hay ni columna ni testigo.

**Sugerencia.** Persistir el `maxBudget` del run (columna nueva o dentro de un JSONB
ya existente) y, además, arrancar el chequeo del tramo reanudado desde el
`total_cost_usdc` ya gastado, no desde 0 — el route ya lee ese número
(`src/routes/compose.ts:1539`), sólo que lo usa para el reporte y no para el guard.

---

### 🟠 BLQ-MED-2 — `listAmbiguous()` gana una query que corre **con la bandera apagada** y **tira** si la tabla no existe

| | |
|---|---|
| **Categoría** | Integration · Error Handling |
| **Archivo:línea** | `src/services/reconciliation.ts:745` + `:923-935` |
| **Rompe** | **AC-9** (*"cero queries nuevas"*) |

`const suspendedRuns = await this.listSuspendedRuns();` corre **siempre**, sin
`isComposeSuspendEnabled()` de por medio, y ante un error de query hace
`throw new ReconciliationError('INTERNAL')` (`:932`).

**Reproducción.** Desplegar este commit **sin** aplicar
`20260823000000_wkh225_suspended_runs.sql` — que es un orden perfectamente posible: el
propio `.env.example:1541-1545` declara la secuencia "migración → secreto → bandera",
pero nada impide que el código llegue primero (Railway despliega por push).
`GET /dashboard/api/reconciliation` pasa de **200** a **500**, y con él se caen las
**tres** listas que ya funcionaban (`settleUnknown`, `strandedRuns`, `rows`).

**Impacto.** Una HU con la bandera en OFF por default rompe entera la superficie de
reconciliación del operador. Y contradice el texto literal de AC-9.

**Sugerencia.** No es "ponerle un `catch`" — la invariante de que un error de query
TIRE es correcta y está bien heredada. Lo que falta es que la **cuarta lista** no
exista cuando la feature no existe: gatearla por `isComposeSuspendEnabled()` (con
`suspendedRuns` como `{rows:[],total:0,truncated:false}` y un campo que diga que no se
preguntó, no que no hay), o declarar explícitamente en el SDD que esta HU exige el
orden migración-antes-que-código y ponerlo como pre-requisito duro del despliegue.

---

### 🟡 BLQ-BAJO-1 — Los precios congelados se restauran **sin re-indexar**: el tramo reanudado debitaría el precio congelado del step equivocado

| | |
|---|---|
| **Categoría** | Data Integrity (money-path) |
| **Archivo:línea** | `src/routes/compose.ts:1569-1571` · `src/services/compose.ts:636` |

El route restaura `frozenStepPricesUsd: run.frozen_step_prices as number[]` tal cual, y
el service lo lee con `frozenStepPricesUsd?.[i]` donde `i` es el índice **del tramo
restante**, reiniciado a 0.

**Reproducción (cuando CD-15 deje de estar inerte).** Steps `[0,1,2,3]` con precios
congelados `[p0,p1,p2,p3]`; suspende en el 1; `remaining_steps = [2,3]`. El pipeline
reanudado usa `i=1` para el step **3** ⇒ debita **p1**. Y `i=0` (step 2) ni siquiera se
debita (`BLQ-ALTO-2`).

**Hoy es inalcanzable** y lo verifiqué: `buildSuspensionAuthz`
(`src/routes/compose.ts:946-968`) nunca puebla `frozenPricesExpireAtMs`, y el call-site
de `/compose` (`:1147-1200`) nunca pasa `frozenStepPricesUsd` — el único productor es
`/orchestrate`, que por DT-A2 no puede suspender. Pero el código está **cableado**, y
`T-MIG-8` (`test/wkh225-suspended-runs.migration.test.ts:124-129`) da apariencia de
cobertura verificando que el `LEAST` esté **escrito**. Es exactamente el patrón
"código muerto que parece cobertura".

**Sugerencia.** O se corta el cable (no restaurar `frozen_step_prices` mientras el
productor no exista, con un comentario que diga por qué) o se re-indexa al persistir
(guardar `frozen_step_prices.slice(stepIndex + 1)`). Lo que no puede quedar es un
array de precios de dinero indexado contra otro espacio de índices.

---

## MENORes

| ID | Categoría | Archivo:línea | Qué |
|---|---|---|---|
| **MNR-1** | Scope Drift · código muerto | `src/services/suspended-run.ts:416-436` | `listForOwner` **no tiene ningún consumidor de producción** (`grep -rn "listForOwner" src/ --include=*.ts` no-test → sólo su definición y un docblock de `reconciliation.ts:921`). Es el sitio donde `T-OWN-1..3` mide el aislamiento de ownership, o sea que se mide una función que nadie llama. El aislamiento **real** que sí está medido es el de `expire()` (`T-OWN-4`). |
| **MNR-2** | Integration | `src/routes/compose.ts:1559-1578` vs `src/services/compose.ts:1816-1818` | El tramo reanudado no llama a `extractRawKey` ni pasa `a2aKey`, así que a los registries system-trusted les llega **sin** `x-a2a-key`. La primera mitad del mismo pipeline sí lo manda. Es fail-safe en seguridad, pero es un cambio de comportamiento no declarado entre las dos mitades de un mismo run. |
| **MNR-3** | Type Safety · precisión | `…suspended_runs.sql:170` + `src/routes/compose.ts:1539` | `claim_suspended_run` devuelve `total_cost_usdc` como `NUMERIC` y el route hace `Number(run.total_cost_usdc ?? 0)`, sin el `::text` que la doctrina WKH-196 exige. La **misma HU** sí lo aplica en `suspended-run.ts:152` y en `reconciliation.ts:928`. Divergencia interna. |
| **MNR-4** | Data Integrity | `…suspended_runs.sql:116-118` | Una fila puede **nacer vencida**. Verificado ejecutando: con `frozen_prices_expires_at = now() - 5 min` y `ttl_seconds = 3600`, el INSERT deja `expires_at < now()` (probado: `nace_vencido = t`). El caller recibiría un 202 con un artefacto y un `expiresAt` en el pasado, después de que el step ya cobró. Inalcanzable hoy por la misma razón que `BLQ-BAJO-1`. |
| **MNR-5** | Integration | `src/routes/compose.ts:1237-1246` | El body del 202 **no lleva `success`** (ni `verificationStatus` ni `output`), a diferencia de las otras dos ramas que hacen `...result`. Todo DT-A1 se justifica sobre `success: true`, y ese `true` no sale por HTTP: un cliente que discrimine por `body.success` lee `undefined`. |
| **MNR-6** | Data Integrity | `…suspended_runs.sql:199` (`v_status = 'suspended'`) | Un run que muere en `resuming` (proceso caído entre `routes/compose.ts:1517` y `:1597`) **nunca vence ni emite residuo**: el guard de vencimiento exige `suspended`, no hay sweeper (NC-3) y ningún camino lo mueve. R-3 declara la pérdida del token; no declara la pérdida de la constancia del pago varado. |
| **MNR-7** | Security (disclosure) | `…suspended_runs.sql:270` | `settle_suspended_run` levanta `'OWNERSHIP_MISMATCH: run % not owned by caller'` con el `p_id`, mientras el claim se cuidó de no discriminar. **Inalcanzable hoy** (el único caller pasa `run.owner_ref`, que el claim ya validó), pero es la asimetría que el propio archivo declara evitar. |
| **MNR-8** | Test Coverage · telemetría | `src/routes/compose.ts:1609` | `noteDownstreamSkips(request, result.steps, [])` pasa siempre un array vacío de causas internas porque el resume no le presta el `downstreamSkipCauses` a `compose()`. El tramo reanudado pierde la telemetría de skips que la primera mitad sí anota. |

---

## Las 11 categorías

### 1. Security — 🔴 **BLOQUEANTE** (`BLQ-ALTO-2`, `BLQ-MED-1`; `MNR-2`, `MNR-7`)

Lo que ataqué y **aguantó**:

- **Token**: HMAC-SHA256 sobre el **string crudo** con dominio propio
  (`resume|v1.<payload>`), secreto propio sin fallback (`COMPOSE_RESUME_HMAC_KEY`),
  fail-closed si falta (`src/lib/resume-token.ts:172-176`), `timingSafeEqual` con
  chequeo de formato y longitud antes (`:296-308`), techo de 8 KB antes de decodificar
  (`:417-419`), orden de los 7 pasos respetado (`:409-464`), `iat` futuro acotado por
  skew, un solo código de error para firma rota y binding ajeno (`:147`, y es la
  decisión correcta).
- **Persistencia**: sólo `SHA-256(token)`, columna `UNIQUE`. El token nunca entra a un
  log, a un mensaje de error ni a una URL — verificado por barrido y por
  `src/routes/compose.resume.test.ts:354-370`. CD-8 se cumple, y la divergencia
  respecto del exemplar (body en vez de path) es la más segura de las dos.
- **Ownership (CD-4)**: busqué el **VALOR**, no la presencia.
  `claim(resumeTokenHash(token), keyRow.owner_ref)` (`src/routes/compose.ts:1517-1520`)
  usa el `owner_ref` del **caller autenticado**; `expire(tokenHash, ownerId)` cruza
  `token_hash` **y** `owner_ref` (`src/services/suspended-run.ts:317-318`);
  `listForOwner` filtra por `ownerId` (`:420`). Ninguna cadena usa un `owner_ref`
  ajeno. Los dos `supabase.rpc(...)` —que el guardián automático **no mira**— tienen
  el guard dentro del SQL (`IS DISTINCT FROM`) y lo verifiqué ejecutando.
- **AC-6 disclosure-safe en los tres eslabones**: SQL levanta el **mismo literal**
  `RUN_NOT_FOUND` para "no existe" y "dueño ajeno" (`…suspended_runs.sql:190` y `:195`,
  verificado corriendo el RPC); el service colapsa los dos en el mismo objeto
  `{ok:false, reason:'not_found'}` (`suspended-run.ts:274-275`) y `T-RUN-2` compara el
  **objeto entero**; el route manda el mismo body y `T-RES-3`
  (`compose.resume.test.ts:302-321`) lo compara **completo**, no el status. Y el warn
  del route es value-free.
- **La excepción cross-tenant de `listSuspendedRuns`** está escrita a mano, sitio por
  sitio, con motivo (`test/ownership-filter-guard.exceptions.ts:359-374`), y verifiqué
  que las **10** líneas re-apuntadas de ese archivo coinciden una por una con
  `grep -n "\.from('a2a_" src/services/reconciliation.ts`. El auto-blindaje del Dev
  sobre este punto es cierto.

### 2. Error Handling — 🔴 **BLOQUEANTE** (`BLQ-ALTO-1`, `BLQ-MED-2`)

Lo bueno: CD-22 se cumple en las 4 funciones del service (uniones discriminadas, cero
`boolean`), `expire()` no puede lanzar y su `.catch` es real, `unavailable` está
separado de `not_found` (un 503 no miente "no existe"), y el fee del resume distingue
`unknown` de `not_charged` (`src/routes/compose.ts:1631-1650`) — "no pude preguntar"
no se colapsa a "no pasó".

### 3. Data Integrity — 🔴 **BLOQUEANTE** (`BLQ-ALTO-1`, `BLQ-ALTO-2`, `BLQ-MED-1`, `BLQ-BAJO-1`; `MNR-4`, `MNR-6`)

Lo que aguantó: single-use atómico probado con dos sesiones concurrentes contra PG16;
`settle` idempotente por status-gate; `reopen` existe pero **no se usa** en ningún
camino post-débito (verificado: los dos call-sites mandan `'resumed'` o `'failed'`);
CD-18 verificado — el 202 va **antes** del bloque de fee (`src/routes/compose.ts:1237`
vs `:1332+`) y la clave de idempotencia del resume es `run.compose_run_id`, no
`request.id`, con testigo que compara contra el `requestId` real de la respuesta
(`compose.resume.test.ts:453-463`).

### 4. Performance — ✅ **OK**

4 índices (`owner_ref`, `status`, `(key_id, owner_ref)`, `expires_at`) + `token_hash
UNIQUE` (btree, la búsqueda del claim es O(1)). Sin N+1: el claim trae la fila entera
en una sola RPC. `listSuspendedRuns` tiene `limit(500)` + `count:'exact'` + `truncated`.
`listForOwner` tiene `limit(100)`. La query nueva de `listAmbiguous` es secuencial (una
más, en superficie admin) — su problema es de disponibilidad (`BLQ-MED-2`), no de costo.
El `discoverCache` del tramo reanudado se crea nuevo, que es lo correcto: el catálogo
pudo cambiar durante la espera.

### 5. Integration — 🔴 **BLOQUEANTE** (`BLQ-MED-2`; `MNR-2`, `MNR-5`)

Los tipos son **estrictamente aditivos**: `ComposeResult.suspended?`, `resumeToken?`,
`ComposeRequest.suspension?`. `errorCode` **no gana miembros** — verificado por
`T-SUSP-NOERRCODE`, que lee `src/types/index.ts` y compara la lista exacta de 5.
`AmbiguousReport` gana una clave (aditivo, superficie admin). El 202 es un status nuevo
en un endpoint existente, pero sólo alcanzable con la bandera en `'true'`.

### 6. Type Safety — ✅ **OK** (con nota)

`tsc --noEmit` limpio, cero `any` explícito en el diff. Hay varios `as unknown as` sobre
filas de la base (`suspended-run.ts:286`, `:329`, `:431`; `routes/compose.ts:1533-1538`)
— es el patrón que el repo ya usa en `reconciliation.ts` y las formas se validan con
`Array.isArray` antes de usarse. `asJsonColumn` (`suspended-run.ts:77-79`) colapsa
`undefined → null` a propósito y lo explica. Ver `MNR-3` por la precisión del `NUMERIC`.

### 7. Test Coverage — 🔴 **BLOQUEANTE** (evidencia de `BLQ-ALTO-1` y `BLQ-ALTO-2`)

Dos testigos que **no pueden ponerse rojos** ante el bug que dicen cubrir: `T-MIG-5`
(mide posiciones de literales en un string) y `T-RUN-9` (su doble persiste una
transición que Postgres descarta). Y un hueco de cableado: el route del resume mockea
`composeService.compose` entero, así que nada mide el pipeline reanudado de punta a
punta.

Lo que **sí** encontré bien y ataqué a propósito:

- `T-SUSP-CALLSITE` **no se lee a sí mismo**: abre `src/services/orchestrate.ts`
  (`compose.suspend.test.ts:503`). No es vacuo.
- `T-SUSP-GUARD571` lee `compose.ts` real y además exige **una sola** ocurrencia del
  guard. No es vacuo.
- `T-TOK-LEAF` lee `resume-token.ts` (`SELF` en `resume-token.test.ts:31`), no el test.
- `T-SUSP-2` **tiene la premisa medida**: el fixture positivo lleva un
  `downstreamTxHash` real y lo asserta antes de afirmar "cero residuo"
  (`compose.suspend.test.ts:273-276`). No es el camino feliz ejercitando el agujero.
- **`T-RES-10` / `T-RES-11` tienen contrafactual REAL y ejecutable** (`:606-622` y
  `:647-662`): sin `selfHostHint` el guard queda inerte y el fetch **sí** ocurre; sin
  `contractingDepth` el hop siguiente recibe `1` en vez de `5`. Miden efecto, no
  presencia. **CD-17 verificado.**

### 8. Scope Drift — 🟡 **MENOR** (`MNR-1`)

**Los 3 archivos de test fuera de Scope IN: la declaración del Dev es CIERTA.** Leí el
diff completo de los tres (`compose.downstream-skips.test.ts`, `compose.fee.test.ts`,
`e2e/compose-flow.test.ts`): cada uno agrega **exactamente** un `requireA2AKey` con el
mismo pass-through que ya tenían para `requirePaymentOrA2AKey`. Cero aserciones
tocadas, cero fixtures cambiados. (`compose.test.ts` sólo re-apunta un número de línea
en un comentario.)

**Y el modo de falla que reporta también es cierto y peligroso**, así que lo perseguí:
`Test Files 303 passed | 6 skipped (309)`. Los 6 skipped son los `*.real.test.ts`
preexistentes con `describe.skipIf` (requieren base viva) más
`test/smoke-downstream-x402.test.mjs` — ninguno es una suite que dejó de arrancar por
esta HU. La cuenta cierra: 297 (base) + 6 archivos nuevos = 303 pasando.

Tamaño del diff: 7388 inserciones, de las cuales 2293 son los `.md` del SDD ⇒ ~5095
líneas de código+tests contra un presupuesto de 3680 y un umbral de CR de 7360. Dentro.

### 9. Destructive Migrations — ✅ **OK**

**Verificado aplicando la migración a un Postgres 16 limpio**: 100 % aditiva.
`CREATE TABLE IF NOT EXISTS` sobre una tabla nueva, sin un solo `DROP`, `ALTER COLUMN`,
`UPDATE` masivo ni `TRUNCATE` sobre datos existentes. La única FK es hacia
`a2a_agent_keys(id)` con `ON DELETE CASCADE`, y sólo afecta filas de esta tabla nueva.
`ADD COLUMN NOT NULL` sin default no aplica (tabla nueva). El `_down.sql` está envuelto
en `BEGIN;…COMMIT;` con las **firmas exactas** y **no** dropea `trigger_set_updated_at`,
que es compartida — correcto y con testigo (`T-MIG-13`). El `up` no lleva
`BEGIN/COMMIT`, igual que el exemplar `20260706000000_wkh137_agent_links.sql` y que el
resto del directorio: **es la convención del repo, no un descuido**, y no lo cuento
como finding.

### 10. RPC con `SECURITY DEFINER` — 🔴 **BLOQUEANTE** (`BLQ-ALTO-1`; hardening OK)

El hardening está **completo y verificado ejecutando** en las dos funciones:
`SET search_path = public, pg_temp` (`:227`, `:293`), `REVOKE EXECUTE … FROM PUBLIC,
anon, authenticated` (`:228-229`, `:294-295`), `GRANT EXECUTE … TO service_role`
(`:230-231`, `:296-297`). **Cero SQL dinámico** — ni un `EXECUTE format(...)`, así que
no hay superficie de inyección. Ownership validado **dentro** de las dos
(`v_owner IS DISTINCT FROM p_owner_ref`). El trigger `trigger_set_suspended_run_expires_at`
no es `SECURITY DEFINER` (correcto) y aun así lleva su `search_path` fijado (`:123-124`).
`¿Era necesario el DEFINER?` Sí: el patrón del repo es que `service_role` (BYPASSRLS)
llame RPCs bajo RLS deny-by-default; espeja `claim_agent_link`.

El BLOQUEANTE de esta categoría **no es de privilegios: es de semántica transaccional**.

### 11. Cache Invalidation — ⚪ **N/A**

Esta HU no introduce ninguna capa de cache. `createDiscoverCache()`
(`src/services/compose.ts:401`) es per-pipeline y preexistente, y el tramo reanudado
crea uno nuevo — que es lo correcto, porque el catálogo puede haber cambiado durante la
espera (es el razonamiento que `compose.ts:434-437` ya tenía escrito). No hay React
Query, SWR, `revalidatePath`, Redis, memoización ni headers de CDN en el diff.

---

## Verificaciones puntuales que el encargo pidió

| Pedido | Resultado |
|---|---|
| **CD-7** — `compose.ts:602` byte-idéntico al `571` original | ✅ **Confirmado.** `diff <(git show 5578998:src/services/compose.ts \| sed -n '571p') <(sed -n '602p' src/services/compose.ts)` → sin diferencias. Las 3 citas de `test/cited-lines-guard.citations.ts` se re-apuntaron correctamente y el guardián está verde. |
| **CD-4 / ownership por VALOR** | ✅ Ver categoría 1. Ninguna cadena filtra por un `owner_ref` que no sea el del caller autenticado. Los dos `rpc()` tienen el guard dentro del SQL y lo ejecuté. |
| **AC-6 indistinguible en los 3 eslabones** | ✅ SQL (mismo literal, verificado corriendo), service (mismo objeto), route (mismo body comparado entero). |
| **CD-6** — `=== 'true'` estricto, default OFF | ✅ `src/lib/resume-token.ts:78`. `T-SUSP-6b` prueba `''`, `'TRUE'`, `'1'`, `'yes'`, `'True'`, `'false'`, `' true'` y **ausente** → todos `false`. |
| **CD-17** — la reanudación no reinicia la profundidad | ✅ Y el contrafactual **existe y es real**: `T-RES-10`/`T-RES-11` ejecutan el pipeline sin el campo y miden que el guard queda inerte / que el header sale `1` en vez de `5`. No es un test que no pueda fallar. Además verifiqué que no hay drift de profundidad: `outboundContracting.depth` es la profundidad **entrante** (`compose.ts:390-392`); el `+1` vive en `lib/contracting-chain.ts:1147`. Persistir y restaurar es simétrico. |
| **CD-13 (LEAF)** | ✅ `src/lib/resume-token.ts:33` es su único `import`, y es `node:crypto`. El testigo lee el módulo, no el test. |
| **CD-20 (README re-derivados)** | ✅ **Re-derivados por mí, no copiados**: `grep -cE '^[A-Z][A-Z0-9_]*=' .env.example` → **189** (README dice 189); `npm run lint` → *"Checked **508** files"* (README dice 508); la suite corrió **309** archivos (README dice 309). `test/readme-numbers.test.ts` los vuelve a derivar en cada `npm test` y está verde. |
| **Límite: un run reanudado no puede volver a suspender** | ✅ **Cerrado con un guard estructural, no con una nota**: el resume no construye `request.suspension` (`src/routes/compose.ts:1559-1578`), y sin ese campo `suspendIfEnvelope` retorna `null` en su primera línea (`src/services/compose.ts:1329-1330`) — el sobre **ni se mira**. Testigo: `compose.resume.test.ts:417-420`. Y fallar así no pierde plata ni residuo: el `settle('failed')` corre antes de armar la respuesta (`routes/compose.ts:1597-1602`) y los `steps_json` de la primera mitad se re-emiten en el body (`stepsCompletos`). |
| **CD-15 inalcanzable hoy** | ✅ **Confirmado**, con la cadena completa: `buildSuspensionAuthz` (`routes/compose.ts:946-968`) no puebla `frozenPricesExpireAtMs`; el call-site de `/compose` (`:1147-1200`) no pasa `frozenStepPricesUsd`; el único productor es `/orchestrate`, que por DT-A2 no puede suspender. ⇒ `frozen_prices_expires_at` y `frozen_step_prices` son **siempre** NULL, el `LEAST` del trigger nunca corre y la restauración del resume es código muerto. Y el código muerto **trae dos defectos ya escritos**: `BLQ-BAJO-1` (índices) y `MNR-4` (fila que nace vencida, probada ejecutando). |

---

## Orden sugerido del fix-pack

1. **`BLQ-ALTO-1`** — la transición `expired` no existe. Es la que además envenena una
   alerta de producción, y la que tiene dos testigos falsos que hay que rehacer.
2. **`BLQ-ALTO-2`** — el step gratis del tramo reanudado. Es plata del operador y es
   repetible.
3. **`BLQ-MED-1`** — el techo de presupuesto reiniciado (mismo archivo y misma llamada
   que el 2; conviene atacarlos juntos).
4. **`BLQ-MED-2`** — la query nueva que corre con la bandera apagada.
5. **`BLQ-BAJO-1`** — los precios congelados sin re-indexar (barato ahora, caro cuando
   CD-15 se encienda).
6. Los 8 `MNR` — se deciden, no bloquean.

---

## Método (para que esto sea auditable)

- Gate completo del repo corrido en el worktree: `tsc --noEmit`, `npm run lint`, `npm test`.
- **Postgres 16 real en contenedor descartable**: apliqué
  `20260823000000_wkh225_suspended_runs.sql` sin modificarla (con `a2a_agent_keys`,
  `trigger_set_updated_at` y los 3 roles stubbeados) y ejecuté: el claim sobre una fila
  vencida ×3, dos claims concurrentes sobre una fila viva, y un INSERT con
  `frozen_prices_expires_at` en el pasado. Contenedor eliminado al terminar.
- Diff leído entero (`git diff 5578998 HEAD`, sin `rtk`), archivo por archivo.
- Los números de los README re-derivados con los comandos que los propios README publican.
