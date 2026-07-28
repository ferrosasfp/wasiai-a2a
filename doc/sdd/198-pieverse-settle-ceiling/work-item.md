# HU-198 — Techo de espera de los hops `pieverse` + estado `unknown` del settle

> ⚠️ **ESTE WORK-ITEM ES RETROACTIVO.** Se escribió DESPUÉS de la implementación y del
> primer AR, porque la HU arrancó sin F1/F2 (no hubo `work-item.md` ni SDD). El AR#1
> tuvo que verificar *las afirmaciones del dev contra el código* en vez de *el código
> contra ACs aprobados* — lo dejó dicho y es una violación de proceso reconocida.
> Los ACs de abajo describen lo que se construyó, con la evidencia archivo:línea, para
> que el AR siguiente tenga contra qué medir. **No son ACs pre-aprobados.**

## Contexto

Los dos hops HTTP al facilitator del modo `pieverse` de `kite-ozone`
(`POST /verify` y `POST /settle`) eran los únicos caminos de settlement del repo sin
cota de wall-clock, y son el **camino vivo**: `pieverse` es el default de
`KITE_FACILITATOR_MODE` (`src/adapters/kite-ozone/payment.ts`, `getFacilitatorMode`).
HU-195 los había excluido explícitamente (`src/lib/outbound-timeout.ts`) dejando
escrita la pregunta que esta HU tenía que contestar: *¿qué hace el gateway con un
settle de resultado desconocido?*

**El hecho mecánico que gobierna todo el diseño**: abortar el request HTTP al
facilitator **no cancela el broadcast**. El gateway no pasa de "pagó" a "no pagó";
pasa de "sé el resultado" a **"no sé el resultado"**.

### Corrección al encuadre inicial (verificada)

El pedido original decía que los hops esperaban "indefinidamente". No es exacto: el
peer **mudo** ya estaba acotado a 300 s por los defaults de undici
(`bodyTimeout`/`headersTimeout` = `300e3`, `node_modules/undici/lib/dispatcher/client.js`,
citado en `src/lib/outbound-timeout.ts`). Lo verdaderamente ilimitado es el peer que
**trickle-feedea**. Consecuencia: el techo **no crea** estados huérfanos nuevos (hoy el
hang termina en el mismo `throw` y en el mismo estado, 10× más tarde) — sólo los hace
llegar antes.

## Scope

**IN**
- Cota de wall-clock para los dos hops `pieverse`, configurable por env.
- Representación **tipada** del estado `unknown` del valor + su consumo en los
  call-sites que hoy colapsan el veredicto.
- Que un hop 2 de resultado desconocido no lo re-envíe el reconciliador a ciegas.
- Guard estructural para leer disposiciones de valor a través de límites de módulo.

**OUT** (levantado como HUs propias)
- `success:false` no prueba nada (BLQ-ALTO-1 del AR): toca 5 adapters. Entrada (G) de
  `TD-198-01`.
- Caso (F): `hop1_confirmed` se escribe antes del hop 2, así que la fila es
  auto-reclamable durante todo el hop 2 **con el proceso vivo**. Entrada (F) de
  `TD-198-01`.
- Nonce determinístico del hop 2 / lease pre-hop2: ver la recomendación en
  `TD-198-01` (`src/services/reconciliation.ts`, bloque del `if (!skipResend)`).

## Acceptance Criteria (EARS, retroactivos)

> ⚠️ **REESCRITOS por AR#2 MNR-6.** La versión anterior tenía 6 ACs (8, 12, 15, 16, 17,
> 18) que NOMBRABAN el identificador que los implementa (`readSettleValueDisposition`,
> `PENDING_STATUSES`, `RETURNS TABLE(applied boolean)`…). Un AC que nombra su propia
> implementación es **verdadero por construcción**: no mide nada, porque cualquier código
> que exista satisface la descripción de sí mismo.
>
> La prueba de que no era cosmético: **el único AC redactado como PROHIBICIÓN FALSABLE
> —AC-2, "nunca `{success:false}` ni un `Error` pelado"— es el único que se rompió**
> (BLQ-MEDIO-1: el techo cumplido durante el body se escapaba del canal tipado).
> Correlación perfecta entre "AC falsable" y "AC que encontró un bug".
>
> Criterio nuevo: la forma EARS se reserva para propiedades **observables desde afuera
> del módulo** y redactadas de modo que se pueda escribir el caso que las viola. Todo lo
> que describe una decisión de implementación bajó a **CD**, que es lo que era.

### Techo

- **AC-1** — *When* el facilitator no completa la respuesta de `POST /verify` dentro del
  presupuesto, *the gateway shall* rechazar dentro de ese presupuesto y **nunca** quedar
  esperando por el default del cliente HTTP (300 s). Vale en los DOS ejes: peer que no
  manda headers **y** peer que trickle-feedea el body.
  Tests: `T-198-VERIFY`, `T-198-AR2-TRICKLE-VERIFY`.
- **AC-2** — *When* el presupuesto se cumple sobre `POST /settle`, *the gateway shall*
  reportar el resultado como DESCONOCIDO y **nunca** como "no se pagó": prohibido devolver
  `{ success: false }` y prohibido propagar un error del que un consumidor no pueda
  distinguir un rechazo del facilitator. Vale en los DOS ejes (headers y body).
  Tests: `T-198-SETTLE-UNKNOWN`, `T-198-AR2-TRICKLE-SETTLE`.
  ⚠️ Este AC se ROMPIÓ en la implementación original y lo encontró AR#2, no la suite: el
  eje "body" no tenía test. Es el AC que justifica el criterio de redacción de arriba.
- **AC-3** — *Where* el intento de pago **no llegó a salir** (DNS que no resuelve,
  conexión rechazada, URL inválida), *the gateway shall* reportarlo como no-pagado
  (reintentable); en **todo otro** caso, incluida la ignorancia sobre lo que pasó, shall
  reportarlo como desconocido.
  Tests: `T-CLS-*`, `T-198-SETTLE-NOT-SENT`, `T-198-AR2-BADJSON`.
- **AC-4** — *The operator shall* poder cambiar el presupuesto por configuración en
  milisegundos, y una configuración inválida (ausente / no numérica / ≤ 0) **nunca** debe
  desactivar el presupuesto.
  Tests: `T-198-ENV`, `T-198-ENV-honra-el-valor`.
- **AC-5** — *The change shall* dejar observablemente intactos los otros cuatro caminos de
  settlement (los 3 adapters restantes y el modo alternativo de este mismo).
  Evidencia: `git diff` vacío sobre esos paths + candado `T-198-AR2-HTTP-ERROR` para el
  camino "el facilitator contestó rechazando", que NO cambia.

### Estado desconocido, visto desde afuera

- **AC-6** — *When* el pago a un agente downstream queda en resultado desconocido, *the
  response shall* distinguirlo de "no se pagó" con un código propio, y *the gateway shall*
  no emitir recibo de pago.
  Tests: `T-198-SettleUnknown`, `T-198-SettleNotSent`.
- **AC-7** — *When* el settle INBOUND queda en resultado desconocido, *the gateway shall*:
  (a) no otorgar acceso; (b) **nunca** afirmarle al caller que su pago falló, y advertirle
  que reintentar con el mismo header no sirve; (c) dejar un registro CONSULTABLE (no sólo
  una línea de log) que incluya el nonce, para poder cruzarlo contra la cadena.
  Tests: `T-198-AR-INBOUND-MSG`(+`-plain`), `T-198-AR-INBOUND-EVENT`(+`-plain`,
  `-throws`).
- **AC-8** — *When* un error tipado del money-path cruza un límite de módulo, *the
  consumer shall* leer su clasificación igual, aunque la identidad de clase no coincida
  (grafo de módulos duplicado).
  Tests: `T-READ-cross-registry`, `T-GAS-cross-registry`, `T-198-Gasless-CrossRegistry`.
- **AC-9** — *Where* el consumidor del gasless no puede clasificar el error, *the gateway
  shall* no reembolsar (fail-safe de HU-192, sin cambio).
  Test: `T-192-6` (preexistente; se pone rojo si se invierte).

### Lo que el reconciliador puede y no puede hacer solo

- **AC-10** — *When* el hop 2 falla sin prueba de que no se ejecutó, *the reconciler shall*
  no re-enviarlo automáticamente.
  Tests: `T-198-Escrow-Ambiguous`, `resolving_settle SIN tx previa…`.
- **AC-11** — *When* el hop 2 falla CON prueba de que no se ejecutó, *the reconciler shall*
  poder re-enviarlo automáticamente (es su razón de existir).
  Tests: `T-198-Escrow-Unequivocal`, `T-4` (preexistente).
- **AC-12** — *While* un intent está en resultado desconocido, *the admin surface shall*
  seguir listándolo y aceptando su resolución. Las dos superficies (listado y resolución)
  **nunca** deben divergir en qué intents consideran pendientes.
  Tests: `T-198-Pending-List`, `T-198-Pending-Resolve`, `T-198-Pending-Shared`.
  ⚠️ Su mutación SOBREVIVIÓ a AR#1 (sin esta propiedad el intent es un limbo invisible,
  peor que el bug original).
- **AC-13** — *When* el reconciliador no puede resolver un intent porque le falta evidencia
  del hop 2, *the API shall* **nunca** responder que ya está resuelto, y shall entregar la
  acción concreta que el operador tiene que hacer fuera del panel.
  Tests: `AR#2: claim perdido + resolving_settle SIN tx…` (+ el par CON tx),
  `T-198-AR2-MNR2`(+`-neg`).
- **AC-14** — *When* se comprueba que el débito del buyer nunca ocurrió, *the reconciler
  shall* poder acreditarle su budget de vuelta, incluso si el hop 2 quedó en resultado
  desconocido. (El bloqueo del re-envío **no** debe bloquear el reembolso.)
  Tests: `T9`/`T10` del SQL-estructural.
- **AC-15** — *When* una escritura del ciclo de vida no se aplica, *the gateway shall*
  detectarlo y alertar nombrando el estado REAL de la fila, y **nunca** afirmar una
  consecuencia que no se sigue de los datos.
  Tests: `T-198-AR: applied=false/true/RPC viejo`, `T-198-AR2` (prohíbe volver a
  "auto-claimable" / "resend hop2 blind").
- **AC-16** — *The drift report shall* contar todo débito vigente y no reembolsado, y
  **nunca** declarar una lista de exclusiones incompleta.
  Test: `T-198-Drift`.

### Migraciones

- **AC-17** — *When* una migración se aplica en el orden equivocado respecto del deploy,
  *the header shall* declarar qué se rompe, y *the migration shall* traer su reverso.
  Tests: `T5`, `T6`, `T13`, `T14`, `T20`, `T21` del SQL-estructural.
- **AC-18** — *The migrations shall* aplicarse únicamente a la base de DESARROLLO, con
  verificación de post-estado leída de la base y no asumida, y **nunca** alcanzar la base
  de producción.
  Evidencia: `scripts/apply-hu198-migration.mjs` (5 chequeos; ref hardcodeado; aborta si
  resuelve a producción; reporta el `ref` del JWT de cada key del entorno).

## Constraint Directives

- **CD-1** — No inventar un valor de techo nuevo: la norma del repo (30 s, en los 4
  caminos ya acotados) es el default, y el mismo para los dos hops (los 4 usan una sola
  constante para ambos).
- **CD-2** — El default de toda clasificación de valor cae al lado **money-safe**:
  `unknown` sobre `not-sent`, `resolving_settle` sobre `reconciliation_pending`,
  `no reembolsar` sobre `reembolsar`. Sólo un veredicto **explícito** habilita la acción
  irreversible.
- **CD-3** — Prohibido colapsar "no sé si se pagó" en el mismo camino que "no se pagó".
- **CD-4** — Cero cambios colaterales en los otros 4 caminos de settlement.
- **CD-5** — Toda migración: sólo bdwv, con `_down`, preflight y post-estado leído de la
  base. Nunca derivar el ref de `SUPABASE_URL`; verificar el claim `ref` del JWT y no el
  nombre de la variable (en `.env.local` **`SUPABASE_SERVICE_KEY` es caldz**).
- **CD-6** — Ningún estado nuevo si el existente ya tiene la semántica buscada
  (`resolving_settle` ya estaba en el CHECK y en el índice desde 191c).

### CDs que ANTES eran ACs (AR#2 MNR-6)

Bajaron de AC a CD porque describen la implementación elegida, no una propiedad
observable. Se conservan porque siguen siendo decisiones vinculantes:

- **CD-7** — La disposición del valor se lee con un guard ESTRUCTURAL
  (`readSettleValueDisposition` / `readGaslessValueDisposition`), no con `instanceof`
  solo. (Antes parte de AC-8.)
- **CD-8** — `resolving_settle` vive en `PENDING_STATUSES`, y `listPending` /
  `resolveIntent` derivan su filtro de LA MISMA constante. (Antes parte de AC-12.)
- **CD-9** — `record_debit_settle_status` devuelve `applied` + `current_status`; el caller
  trata `undefined` como no-confirmado. (Antes parte de AC-15.)
- **CD-10** — El drift cuenta `resolving_settle` y excluye `resolving_refund`,
  `resolved_refunded` y `resolved_settled`, con las tres exclusiones nombradas. (Antes
  parte de AC-16.)
- **CD-11** — Cada migración trae `_down`, gate de orden de release en el header y pasa
  `migrate-preflight.mjs`. (Antes parte de AC-17.)
- **CD-12** — El applier hardcodea el ref de bdwv, no lo deriva de `SUPABASE_URL`, y
  verifica el claim `ref` del JWT en vez del nombre de la variable. (Antes parte de
  AC-18.)

## Deuda registrada

`TD-198-01` — anotada **en el código**, en el `if (!skipResend)` de
`src/services/reconciliation.ts`: entradas (B), (C), (F) y (G) del re-envío sin
evidencia, las dos candidatas de fondo con sus agujeros, y la recomendación actual
(lease pre-hop2, porque el nonce determinístico depende del BLQ-ALTO y no cubre
`pieverse`).
