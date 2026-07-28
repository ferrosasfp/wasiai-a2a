# HU-202 — Lease del hop 2: ningún re-envío sin evidencia persistida de que no se pagó

**Branch**: `fix/202-hop2-lease` · **Base**: `main` @ `2382efb`
**Cierra**: `TD-198-01` (casos B, C, F, G) — anotado en `src/services/reconciliation.ts`
**NO cierra**: el agujero (a) de la opción "nonce determinístico" (pieverse no es EIP-3009),
`TD-201-01` (lector de `authorizationState`), `TD-201-02`, `TD-201-03`.

> ⚠️ El prompt de esta HU cita la base como `a1f5790`. Ese SHA **no existe** en este repo
> (`git log --oneline -1 a1f5790` → `unknown revision`). La base real es `2382efb`
> (`fix(201): fix-pack AR — superficie para los deposits retenidos + el 2º eje del inbound`),
> que SÍ contiene HU-201 mergeada. Se trabaja sobre esa.

---

## 1. El agujero, en una línea

El lado settle del reconciliador re-envía el hop 2 (operador → seller) **sin ningún hecho
persistido que diga si el hop 2 ya se intentó**. Todas las entradas llegan como
`hop1_confirmed` y son indistinguibles entre sí.

### 1.1 Por qué esto NO es sólo "el proceso se murió" (caso F)

`record_debit_hop1` (`supabase/migrations/20260713000001_wkh191b_debit_hop1.sql:57`) escribe
`debit_settle_status = 'hop1_confirmed'`, y `settleEscrowAware`
(`src/services/payment-intent.ts:637-648`) lo llama **ANTES** de invocar el hop 2. La fila
queda en ese estado durante **toda** la ventana del hop 2 (`sign` + `/settle` con techo de
30s + re-verify on-chain).

Y `claim_reconciliation` acepta reclamar `hop1_confirmed` para el lado **settle**
(`20260728010000_hu198_settle_status_applied.sql:209`):

```sql
AND (
  debit_settle_status IN ('hop1_confirmed','reconciliation_pending')   -- ← acá
  OR (debit_settle_status = v_target
      AND (p_side = 'refund' OR debit_resolution_tx_hash IS NOT NULL))
  OR (p_side = 'refund' AND debit_settle_status = 'resolving_settle')
);
```

⟹ **un click en `POST /dashboard/api/reconciliation/:id/resolve` durante un settle lento
normal paga dos veces al seller, con el proceso vivo y sano.** No hace falta ningún crash.

### 1.2 La observación que hace que el fix sea obvio

El reconciliador **ya tiene** la disciplina que le falta al camino normal: su
`claim_reconciliation` **flipea el estado a `resolving_settle` ANTES** de mandar el re-envío
(`src/services/reconciliation.ts:461-467` → `658`). O sea: **el claim ES el lease**, y por eso
el re-envío del reconciliador no se puede duplicar a sí mismo. El camino que paga en el 99%
de los casos — `settleEscrowAware` — no tiene equivalente.

Esta HU no inventa un mecanismo: **replica en `settleEscrowAware` la disciplina que el
reconciliador ya aplica a su propio re-envío.**

---

## 2. Alcance

### Scope IN
| Archivo | Qué |
|---|---|
| `supabase/migrations/20260729000000_hu202_hop2_lease.sql` | columna `debit_hop2_attempted_at` + `record_debit_settle_status` (stamp/clear) + `claim_reconciliation` (guard del stamp) |
| `supabase/migrations/20260729000000_hu202_hop2_lease_down.sql` | rollback |
| `scripts/apply-hu202-migration.mjs` | applier bdwv-only con guard anti-caldz + post-estado leído de la base |
| `src/services/payment-intent.ts` | lease pre-hop2 + release en `unequivocal` + abort fail-closed |
| `src/adapters/escrow/debit-executor.ts` | docstring de `recordDebitSettleStatus` (contrato del lease) |
| `src/services/reconciliation.ts` | `hop2_attempted_at` en `PendingRow`/`listPending` + reescritura del bloque `TD-198-01` |
| `src/services/payment-intent.test.ts` | tests de efecto (las dos direcciones) |
| `src/services/reconciliation.test.ts` | test de superficie |
| `src/routes/dashboard.test.ts` | passthrough del campo nuevo |
| `test/hu202-hop2-lease.migration.test.ts` | SQL-estructural |

### Scope OUT (prohibido tocar)
- `src/services/compose.ts` (tarea aparte).
- El lector de `authorizationState` (`TD-201-01`).
- `caldz` (producción). **La migración se aplica SOLO a bdwv.**
- Nonce determinístico para el hop 2 (opción 1 del `TD-198-01`): su agujero (a) sigue abierto.

---

## 3. Diseño

Se persiste el hecho **"el hop 2 se intentó"** ANTES de intentarlo, en dos columnas que ya
gobiernan la decisión + una nueva:

| Hecho | Dónde vive |
|---|---|
| "voy a intentar el hop 2" | `debit_settle_status = 'resolving_settle'` (bloquea el claim) **+** `debit_hop2_attempted_at = now()` (cuándo, y guard independiente del status) |
| "el intento terminó y NO movió plata" | `debit_settle_status = 'reconciliation_pending'` **+** `debit_hop2_attempted_at = NULL` ⟹ **libera** el lease |
| "el intento pagó" | `debit_settle_status = 'settled'` (+ el stamp se preserva, auditoría) |
| "el intento terminó de resultado desconocido / no terminó" | el lease **se queda** ⟹ nadie auto-re-envía |

### 3.1 Por qué el stamp además del status

El status solo ya cerraría F. El stamp agrega dos cosas que el status no puede dar:

1. **Un guard que no depende de la disciplina del código.** Cualquier caller que baje el
   status a `reconciliation_pending`/`hop1_confirmed` re-abriría el agujero; el guard nuevo
   del `claim_reconciliation` refusa el lado settle mientras haya stamp sin
   `debit_resolution_tx_hash`, **cualquiera sea el status**.
2. **La edad.** Una fila `resolving_settle` de hace 2 segundos es un settle en vuelo sano;
   una de hace 40 minutos es plata parada. Sin timestamp, la superficie no puede
   distinguirlas y se vuelve ruido que nadie mira — el modo de falla que HU-201 documentó.

### 3.2 Por qué el stamp se LIMPIA en `reconciliation_pending`

`reconciliation_pending` significa exactamente "el reconciliador puede tomar esto y
re-enviar". Su único escritor en el camino del hop 2 es la rama `unequivocal` — el veredicto
que el repo ya trata como "probado que no se ejecutó". Si no se limpiara, el guard nuevo
dejaría al **caso D** (rechazo normal del facilitator) sin re-envío automático ⟹ el seller
sin cobrar. **Sobre-corregir acá es tan malo como no corregir.**

⚠️ El lease **hereda** la inferencia de D y no la arregla: `unequivocal` incluye un
`2xx {success:false}` SIN txHash, que es una lectura de la semántica de un TERCERO, no una
prueba (ver `payment-intent.ts` y `TD-201-03`).

### 3.3 Abort fail-closed si el lease no se toma

Si `recordDebitSettleStatus('resolving_settle')` devuelve `false` (error del RPC, guard que
rechaza, `applied` ausente), **no se manda el hop 2**. El costo es cero y se puede demostrar:
la fila queda en `hop1_confirmed` **sin stamp** ⟹ es exactamente el **caso A** ⟹ el
reconciliador la reclama y la paga. Nada salió, nadie puede doble-pagar.

Bonus: dos `settleEscrowAware` concurrentes sobre el mismo intent — hoy los dos mandan hop 2 —
pasan a que sólo uno tome el lease.

### 3.4 Verificación pedida por el founder: ¿el lease convierte A en revisión manual?

**No: la afirmación del AR es imprecisa, y el founder tiene razón.**

Línea de tiempo de `settleEscrowAware` con el lease:

```
 t1  record_debit_hop1   → status = 'hop1_confirmed'      (sin stamp)
 t2  LEASE               → status = 'resolving_settle' + stamp = now()
 t3  el request del hop 2 SALE
 t4  llega el veredicto  → 'settled' | release | se queda leaseado
```

El **caso A** es "murió después del hop 1 y ANTES de intentar el hop 2", o sea la ventana
`[t1, t3)`. El lease la parte en dos:

- `[t1, t2)` — **sin stamp, status `hop1_confirmed`** ⟹ `claim_reconciliation` la reclama ⟹
  **sigue auto-re-enviándose**, igual que hoy.
- `[t2, t3)` — leaseada ⟹ revisión manual. **Esto es el único costo**, y es la ventana entre
  que volvió el `UPDATE` de una fila y que salió el request (armar params + `signTypedData`
  local + dispatch HTTP): milisegundos, sin ninguna E/S de red en el medio.

Y hay una segunda mitad que la nota del AR omitía: el **caso D** (rechazo `unequivocal` del
facilitator) — que es la entrada legítima que ocurre de verdad y de forma repetida, no por
crash — **no se toca**: el lease se libera y el re-envío automático sigue igual.

O sea: **el lease convierte en manual una ventana de milisegundos sin E/S dentro de A, no A.**
El costo real es mucho menor que el que dice la nota, y por eso el diseño vale la pena. La
nota del `TD-198-01` se corrige en esta HU.

### 3.5 Verificación pedida por el founder: ¿el lease cierra F? — contra el SQL

Sí. Con `p_side = 'settle'` (⟹ `v_target = 'resolving_settle'`), el `WHERE` de
`claim_reconciliation` (`20260728010000:204-219`) sólo reclama si:

| rama | condición | durante el hop 2 leaseado |
|---|---|---|
| 1 | `status IN ('hop1_confirmed','reconciliation_pending')` | **falsa** — el status es `resolving_settle` |
| 2 | `status = 'resolving_settle' AND (p_side='refund' OR debit_resolution_tx_hash IS NOT NULL)` | **falsa** — `p_side='settle'` y la tx del hop 2 todavía no existe |
| 3 | `p_side='refund' AND status='resolving_settle'` | **falsa** — `p_side='settle'` |

Las tres falsas ⟹ `v_rows = 0` ⟹ `claimed = FALSE` ⟹ `resolveIntent` **no llega nunca** al
`settlePaymentIntentOnChain` del `if (!skipResend)`, y le contesta al operador
`awaiting_manual_settle_evidence` (`reconciliation.ts:485-494`), no un re-envío. **F cerrado.**
Esta HU agrega además la rama 4 (guard del stamp), que hace la refusal independiente del
status.

El lado **refund** sigue reclamando (rama 3): asimetría deliberada de MNR-4 — el refund es
budget-only e idempotente y no manda ningún hop 2.

---

## 4. Criterios de aceptación (prohibiciones falsables)

Redactados como "nunca X" sobre el **efecto en la plata**. Ninguno nombra el identificador
que lo implementa: un AC que dice "existe la variable `leaseHeld`" es verdadero por
construcción y no mide nada.

- **AC-1 (F)** — Con el hop 2 EN VUELO (el request salió y todavía no volvió), un intento de
  reconciliación sobre ese intent **nunca** puede terminar mandando un segundo pago al seller.
- **AC-2 (B)** — Si el proceso desaparece después de que el request del hop 2 salió, una
  corrida posterior del reconciliador **nunca** manda un segundo pago sin haber verificado
  antes una tx del hop 2 on-chain.
- **AC-3 (C)** — Si el hop 2 pagó pero el registro del resultado no se pudo escribir, el
  reconciliador **nunca** manda un segundo pago automáticamente.
- **AC-4 (G)** — Si el estado del ciclo de vida no se pudo escribir, el sistema **nunca**
  manda el hop 2 igual: sin el hecho persistido no sale plata.
- **AC-5 (A — la dirección contraria)** — Si el proceso muere después del hop 1 **sin haber
  persistido ningún intento de hop 2**, el reconciliador **nunca** deja al seller sin cobrar:
  esa fila se resuelve sola, sin intervención humana.
- **AC-6 (D — la dirección contraria)** — Cuando el hop 2 fue rechazado con el veredicto
  explícito de "no se ejecutó", el reconciliador **nunca** deja esa fila sin re-enviar
  automáticamente.
- **AC-7 (refund)** — Un intent cuyo hop 1 no movió fondos **nunca** queda sin poder
  reembolsar el budget del buyer por culpa del lease.
- **AC-8 (superficie)** — Una fila con un intento de hop 2 persistido y sin resolver **nunca**
  queda fuera de la lista que ve el operador, y **nunca** se presenta sin el dato que permite
  distinguir un settle en vuelo de uno parado.
- **AC-9 (superficie, invariantes de HU-201)** — La superficie **nunca** se gatea por
  `isEscrowSettleEnabled`, **nunca** devuelve una lista vacía cuando la query falló, y
  **nunca** declara un total que no sea exacto.
- **AC-10 (no-regresión del refund)** — La migración **nunca** deja al lado refund sin poder
  reclamar una fila `resolving_settle` (rama MNR-4 de HU-198).
- **AC-11 (orden de release)** — Aplicar la migración antes del código **nunca** cambia el
  comportamiento de dinero (sin nadie que estampe, el guard nuevo no matchea ninguna fila).
- **AC-12 (rollback)** — El `_down` **nunca** destruye la evidencia de los hop 2 intentados.

### Fuera de alcance declarado
- El re-envío del `if (!skipResend)` sigue saliendo **sin prueba dura** en los casos A y D:
  esta HU distingue A/D de B/C/F/G, **no** convierte la inferencia de D en prueba. Eso es
  `TD-201-01` + el agujero (a).
- La ventana `[t2, t3)` (§3.4) queda como revisión manual: es el costo asumido.
- Filas que ya estaban en `hop1_confirmed` **antes** del deploy siguen siendo auto-reclamables:
  la migración no puede inventar retroactivamente evidencia que nadie persistió.

---

## 5. Gate de orden de release

**La migración se aplica ANTES de deployar el código.** Consecuencias del orden inverso
(código primero), que es lo que hay que saber si alguien se equivoca:

- `record_debit_settle_status` viejo **no conoce** `debit_hop2_attempted_at`, pero la firma
  (5 args) y el tipo de retorno **no cambian** en esta migración ⟹ `CREATE OR REPLACE`, sin
  DROP, **sin ventana de schema-cache de PostgREST** (`PGRST202`).
- Con el código nuevo sobre la función vieja: el lease se toma igual (el flip a
  `resolving_settle` ya es escribible desde `20260728000000`) ⟹ **F sigue cerrado por el
  status**. Lo que falta es el stamp: no hay guard independiente y la superficie muestra
  `hop2_attempted_at: null`. **Degradación, no agujero nuevo.**
- Con el código viejo sobre la migración nueva: nadie estampa ⟹ la rama nueva del
  `claim_reconciliation` no matchea ninguna fila ⟹ comportamiento idéntico a hoy.

---

## 6. Plan de verificación

- **Efecto sobre la plata, las dos direcciones.** Cada AC del 1 al 7 tiene un test que mide
  *¿salió un segundo pago?* / *¿se reembolsó?*, nunca *¿se llamó a tal función?*.
- **Mutación por cada guard**, con `sha256sum` antes/después para probar que la mutación
  aterrizó en disco, y anclada por número de línea cuando el patrón aparece más de una vez.
  ⚠️ Una migración nueva es un archivo **untracked**: `git checkout --` no la revierte y el
  `git diff` vacío parece "revertido" mientras la mutación sigue en disco. Por eso el
  `sha256sum` se compara contra el valor pre-mutación, no contra `git status`.
- **Test SQL-estructural** siguiendo `test/hu198-settle-status.migration.test.ts`, usando su
  helper `code()` (quita las líneas `--`) y `fnBody()` (acota a UNA función). Una aserción
  sobre el texto del `.sql` **se satisface con el comentario de cabecera** si no se usa
  `code()`: esa vacuidad ya se cazó en HU-198.
- **3 gates**: `npx tsc --noEmit`, `npm run lint`, `npm test`. Baseline **3808 passed | 19
  skipped**.
- **Migración**: `npm run migrate:preflight`, apply SOLO a bdwv con guard anti-caldz,
  post-estado **leído de la base** (no se asume que el apply salió bien).

---

## 7. Resultado (ejecutado)

**Gates**: `tsc --noEmit` limpio · `biome check src/` limpio · **3847 passed | 19 skipped**
(baseline 3808 → +39 tests).

**Migración aplicada a bdwv** (`node scripts/apply-hu202-migration.mjs`), post-estado leído
del catálogo de la base, 5/5:

```
[env] SUPABASE_SERVICE_KEY   → CALDZ (producción) ⚠️ NO se usa en este script
[env] SUPABASE_SERVICE_KEY_D → bdwv (desarrollo)
[target] ref=bdwvrwzvsldephfibmuu (HARDCODEADO, no derivado de SUPABASE_URL)
  (a) columna debit_hop2_attempted_at   → EXISTE (timestamptz)
  (b) record_debit_settle_status stamp  → PRESENTE (toma el lease)
  (b) record_debit_settle_status clear  → PRESENTE (libera el lease)
  (c) claim_reconciliation lease guard  → PRESENTE ⇒ el lado settle no re-envía a ciegas
  (d) claim_reconciliation refund/MNR-4 → PRESENTE ⇒ el refund del buyer sigue alcanzable
```

⚠️ El guard 2 del applier **confirmó el footgun en este checkout**: `SUPABASE_SERVICE_KEY`
(sin sufijo) apunta a **CALDZ (producción)** y `SUPABASE_SERVICE_KEY_D` a bdwv. La base se
identificó por el claim `ref` del JWT, no por el nombre de la variable. **A caldz no se
tocó.**

**Mutación — 14 mutaciones, 14 cazadas, 0 verdes.** Cada una anclada por número de línea y
con `sha256sum` antes → mutado → restaurado; el `diff` final del listado de hashes es
idéntico al pre-campaña (ninguna quedó en disco).

| # | Mutación | La cazan |
|---|---|---|
| M1 | `if (!leaseHeld)` → `if (false)` — se manda el hop 2 sin lease | AC-4, AC-4b, AC-1c |
| M14 | `if (!leaseHeld && false)` — variante sutil de M1 | AC-4, AC-4b, AC-1c |
| M2 | borra la TOMA del lease (el agujero F original) | AC-1 + 7 más |
| M3 | libera el lease también con resultado desconocido (B, C) | AC-2/AC-3 + 2 |
| M4 | nunca libera el lease (sobre-corrección: D sin cobrar) | AC-6 + 3 |
| M5 | anula el guard del lease en `claim_reconciliation` | T10 |
| M6 | el lease nunca se libera en SQL | T5 |
| M7 | el stamp nunca se escribe | T4 |
| M8 | borra la rama refund MNR-4 (regresión HU-198) | T12 |
| M9 | la columna no se crea | T1 |
| M10 | el `_down` hace `DROP COLUMN` (destruye evidencia) | T15 |
| M11 | la superficie deja de pedir la columna | AC-8 |
| M12 | la superficie afirma `null` sobre filas estampadas | AC-8 |
| M13 | `resolveIntent` ignora la negativa del claim | 8 tests |

**Límite declarado del método**: los tests de servicio corren contra un **modelo** del
`WHERE` de `claim_reconciliation` (`claimPredicate`), no contra Postgres. La
correspondencia modelo↔SQL está candada por `T10`, que afirma el texto del `WHERE` **y**
la misma tabla de verdad. Una mutación que cambie **los dos a la vez** (SQL y modelo) no
se detecta: eso lo cierra un Postgres efímero, que este repo no tiene, o el applier
leyendo `pg_get_functiondef` (que sí corrió, arriba).
