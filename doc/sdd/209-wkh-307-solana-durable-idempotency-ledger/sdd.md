# SDD #209: [WKH-307] Idempotencia del settle Solana respaldada en ledger (no en memoria)

> SPEC_APPROVED: no
> Fecha: 2026-07-28
> Tipo: bugfix + money-path hardening
> SDD_MODE: full
> Branch: `fix/209-wkh-307-solana-durable-idempotency-ledger`
> Artefactos: `doc/sdd/209-wkh-307-solana-durable-idempotency-ledger/`
> Baseline de tests: **3996 passed | 19 skipped**

---

## 1. Resumen

El registro de "a qué `intentId` de Solana ya se le pagó y con qué firma" vive hoy en un
`Map` de proceso (`src/adapters/solana/payment.ts:93`, `_intentSignatures`). Un reinicio
—deploy, restart rotativo, crash— lo borra entero. Después de ese reinicio el sistema **no
sabe** si ya le pagó a un agente Solana, y un retry re-broadcastea un SPL transfer real.
Solana no tiene backstop on-chain (a diferencia de EIP-3009, con nonce determinístico): este
seam de aplicación es la única defensa contra el doble pago.

Esta HU reemplaza el `Map` por una tabla propia de `wasiai-a2a`
(`a2a_solana_settle_intents`, base bdwv en dev) con una **máquina de estados
persist-before-side-effect** de tres estados (`claimed` → `signed` → `confirmed`) cuyas
transiciones son todas **escrituras condicionales atómicas** que informan en la misma
operación si aplicaron. El reclamo del `intentId` ocurre **antes de que exista ninguna
firma** y **antes del punto de transmisión**, así que el diseño sobrevive intacto a WKH-302
(que muda la transmisión al facilitator): lo único que cambia después de esa migración es el
contenido del bloque "transmitir", no quién decide transmitir.

El caso feo —la caída entre transmitir con éxito y persistir el resultado— deja de ser
irrecuperable: la firma de una transacción Solana **existe antes del broadcast** (es la
firma ed25519 sobre el mensaje), así que se persiste primero y se transmite después. Un
retry post-crash encuentra la firma exacta, la re-verifica on-chain con el `verify()` que ya
existe, y la devuelve — nunca re-transmite a ciegas, y tampoco deja la plata trabada.

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 209 (WKH-307) |
| **Tipo** | bugfix + money-path hardening |
| **SDD_MODE** | full |
| **Objetivo** | Que el hecho "este `intentId` ya se está pagando / ya se pagó con esta firma" sobreviva al reinicio del proceso, con un reclamo atómico antes del broadcast y fail-closed ante cualquier duda. |
| **Reglas de negocio** | Nunca dos SPL transfers para un `intentId`. Nunca un broadcast sin reclamo persistido. Nunca "no sé" tratado como "no se pagó, adelante". Nunca una firma leída del store devuelta sin re-verificar on-chain. Nunca un estado que trabe la plata sin operación que lo destrabe. |
| **Scope IN** | Ver §6. |
| **Scope OUT** | Ver §6. |
| **Estimación** | **L** (revisada desde la M del work-item — ver §7 R-6: el AC-6 obliga a reestructurar el primitivo de broadcast, que el work-item no había dimensionado). |
| **Missing Inputs** | **Los 4 del work-item quedan RESUELTOS en este SDD** (§9). Ninguno bloqueante. |

### 2.1 Acceptance Criteria (EARS)

AC-1..AC-7 se heredan **verbatim** del work-item. AC-8..AC-11 los agrega F2 por hallazgos de
Codebase Grounding (cada uno justificado donde se introduce).

- **AC-1** (Event-driven): WHEN `SolanaPaymentAdapter.settle()` se invoca con un `intentId`
  que no tiene registro previo en el store durable, the system SHALL reclamar ese `intentId`
  mediante una escritura condicional atómica (una sola operación de base de datos que informe
  si aplicó o no) ANTES de broadcastear cualquier transferencia on-chain.
- **AC-2** (Unwanted): IF dos invocaciones concurrentes de `settle()` llegan para el mismo
  `intentId`, THEN the system SHALL permitir que como máximo una de ellas broadcastee la
  transferencia SPL — la que pierde la carrera NUNCA debe emitir un segundo pago.
- **AC-3** (Event-driven): WHEN `settle()` se invoca con un `intentId` que ya tiene una firma
  confirmada registrada en el store durable, the system SHALL re-verificar esa firma on-chain
  (semántica `verify()` existente, verify-before-trust) y devolverla sin re-broadcastear.
- **AC-4** (State-driven): WHILE el store durable no está disponible (cliente no configurado,
  o la operación de claim/lectura falla), the system SHALL NOT broadcastear una transferencia
  nueva para un `intentId` no reclamado — fail-CLOSED.
- **AC-5** (Event-driven): WHEN el proceso del gateway se reinicia después de haber
  registrado durablemente una firma confirmada para un `intentId`, y un caller reintenta
  `settle()` con el mismo `intentId`, the system SHALL devolver la firma previamente
  registrada (re-verificada on-chain) en vez de broadcastear de nuevo.
- **AC-6** (Unwanted, el caso feo): IF el proceso se cae/reinicia después de que el broadcast
  on-chain fue exitoso pero ANTES de que el resultado se haya persistido durablemente, THEN
  un retry del mismo `intentId` SHALL NOT re-broadcastear a ciegas.
- **AC-7** (Ubiquitous): The system SHALL aplicar la migración SQL de esta HU **solo** a la
  base de desarrollo (`bdwv`). Producción (`caldz`) queda explícitamente fuera.
- **AC-8** (Unwanted, **nuevo en F2**): IF llega un `settle()` con un `intentId` ya
  registrado pero con `payTo`, `amountAtomic` o `mint` DISTINTOS a los registrados, THEN the
  system SHALL fallar cerrado — SHALL NOT broadcastear y SHALL NOT devolver la firma previa.
  *(Origen: `settleSolanaLeg` deriva `payTo`/`amountAtomic` del `Agent` en cada invocación
  (`src/lib/downstream-payment.ts:262,296,325`); nada garantiza hoy que un mismo `intentId`
  llegue dos veces con los mismos términos. Devolver la firma de un pago de $3 como prueba de
  un pago de $300 es un bug de contabilidad. Espejo del AC-9 de WKH-302.)*
- **AC-9** (Unwanted, **nuevo en F2**): the system SHALL NOT atribuir la MISMA firma on-chain
  a dos `intentId` distintos. *(Origen: §4.2 DT-6 — al reemplazar `sendAndConfirmTransaction`
  se pierde su bucle anti-firma-duplicada (`node_modules/@solana/web3.js/lib/index.cjs.js:8139-8161`).
  Dos legs del mismo run que paguen al mismo agente el mismo monto bajo el mismo blockhash
  producen mensajes idénticos ⟹ firma idéntica ⟹ una sola transferencia on-chain contabilizada
  como dos pagos ⟹ el agente cobra la mitad.)*
- **AC-10** (Unwanted, **nuevo en F2**): IF el titular de un reclamo desaparece, THEN el
  `intentId` SHALL NOT quedar bloqueado para siempre — pero el desbloqueo SHALL ocurrir
  únicamente sobre evidencia persistida de que **nada se transmitió**, o de que lo transmitido
  **ya no puede aterrizar nunca**. *(Origen: auto-blindaje HU-202 [2026-07-28 19:20] — "cuando
  un fix agrega un estado que bloquea una acción automática, el mismo PR tiene que agregar la
  operación que lo destraba". Y R2 de WKH-302 §DT-5: "WKH-307 no debe diseñar ese caso como un
  estado terminal irrecuperable".)*
- **AC-11** (State-driven, **nuevo en F2**): WHILE la base de datos destino no tenga el
  esquema de esta HU aplicado, the system SHALL fallar cerrado con un diagnóstico ruidoso y
  distinguible, y SHALL NOT degradar en silencio al `Map` in-memory ni a ningún fallback.
  *(Origen: auto-blindaje HU-202 [2026-07-28 18:10] — "toda vez que un valor de retorno pasa
  de telemetría a condición de dinero, su precondición de esquema deja de ser documentación y
  pasa a ser código. Un gate que nadie corre no es un gate". Es literalmente el mismo riesgo:
  AC-7 aplica la migración SOLO a bdwv, así que existe por diseño al menos una base —caldz—
  sin la tabla.)*

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos — `wasiai-a2a` (este repo)

| Archivo | Por qué | Patrón / hallazgo extraído |
|---------|---------|----------------------------|
| `src/adapters/solana/payment.ts` (1-782, completo) | Es el archivo que se modifica | `_intentSignatures` `:93`; TTL/cap/ventana protegida `:122-358`; `settle()` `:512-588`; `recoverConfirmedSettle()` `:604-663`; `verify()` `:665-707`; `candidateSignatureFromFailure()` `:399-417`; TEST-ONLY `:715-781`. Los comentarios `:63` y `:581` declaran esta HU como pendiente ("W5 lo respalda en ledger") |
| `src/adapters/solana/chain.ts` (1-109) | Fuente de `Connection`/operator/commitment | Devnet-only por diseño (`getSolanaNetwork` `:31-37` devuelve `'devnet'` fijo); `_resetSolanaChain()` `:106` |
| `src/adapters/types.ts` (100-152) | Contrato del adapter | `SolanaSettleRequest {payTo, amountAtomic, intentId}` `:106`; **`getSettledSignature(intentId): string \| undefined` es SÍNCRONO** `:150` — DT-8 |
| `src/lib/downstream-payment.ts` (240-436) | Único caller del leg Solana | `getSettledSignature` `:326` gobierna si el pre-check de balance CORTA o sólo SONDEA; **`const legIntentId = intentId ?? \`${agent.slug}:${payTo}\`` `:325`** — hallazgo crítico, ver DT-9 |
| `src/services/compose.ts` (178-182, 387-392, 667-672, 1036-1046, 1407-1411) | Origen del `intentId` | `composeRunId = randomUUID()` `:182` por EJECUCIÓN; `intentId = \`${composeRunId}:${i}\`` `:392` y `:672`. **Los DOS únicos call-sites de producción de `invokeAgent` pasan el `intentId`** ⟹ el fallback de `:325` es hoy inalcanzable en producción (verificado con grep exhaustivo de `invokeAgent(` y `signAndSettleDownstream`) |
| `src/adapters/escrow/schema-preflight.ts` (1-95, exports) | **Exemplar de AC-11** | Probe perezoso + memoizado + `warm*()` fire-and-forget en `index.ts`; veredicto discriminado `EscrowSchemaVerdict`; `_resetEscrowSchemaPreflight()` TEST-ONLY; **prueba POSITIVA** (ejercita el RPC y lee QUÉ excepción tira, sin escribir nada) |
| `src/adapters/escrow/debit-executor.ts` (299-370) | **Exemplar del consumo de un RPC de escritura condicional** | `supabase.rpc(...)`; `error` ⟹ `write_failed`; `applied !== true` ⟹ no confirmado; retorno **discriminado** `'applied' \| 'rejected_by_guard' \| 'write_failed'` (auto-blindaje: un `boolean` esconde una unión) |
| `src/services/signed-auth.ts` (196-222) | **Exemplar in-repo del claim atómico por `INSERT`** | `.insert(...)`; `error.code === '23505'` ⟹ replay ⟹ `false`; cualquier otro error ⟹ throw (fail-closed) |
| `src/services/reconciliation.ts` (349, 414-435, 494, 532-551) | Convención de lectura de columnas anchas + tipado de filas | `::text` en el string del `.select()` (convención WKH-196); `data as unknown as Row[]` cuando `database.types.ts` no está regenerado |
| `src/lib/supabase.ts` (1-43) | Cliente | Singleton EAGER (`process.exit(1)` si falta env). Ya es dependencia dura de todo `src/services/**` |
| `src/types/database.types.ts` (1048-1090) | Shape de una tabla tipada | `a2a_refund_outbox` como molde de `Row`/`Insert`/`Update`. **Una tabla nueva DEBE agregarse acá** o `supabase.from('...')` no typechequea |
| `src/adapters/registry.ts` (62-75, 128-133) | Gate del adapter | `SOLANA_ADAPTER_ENABLED === 'true'`; con el flag OFF el chain ni se registra |
| `supabase/migrations/20260729000000_hu202_hop2_lease.sql` (1-90) | **Exemplar de migración** | Cabecera con GATE DE ORDEN DE RELEASE + consecuencias del orden inverso; `ADD COLUMN IF NOT EXISTS` / `CREATE OR REPLACE` (sin DROP ⟹ sin ventana `PGRST202`) |
| `supabase/migrations/20260724000000_wkh234_receipt_solana_caip2.sql` | Estado de `a2a_receipts` | `settle_caip2` + `settle_signature` son columnas de RECIBO (post-pago), no de reclamo |
| `scripts/apply-hu202-migration.mjs` (1-80) | **Exemplar del applier bdwv-only** | Ref **hardcodeado**, abort si resuelve a caldz, identificación de la key por el claim `ref` del JWT (nunca por el NOMBRE de la variable), post-estado LEÍDO del catálogo |
| `test/hu202-hop2-lease.migration.test.ts` (1-240) | **Exemplar del test SQL-estructural** | `flat()`, `code()` (quita comentarios — existe por una vacuidad real), `fnBody()` (acota a UNA función), `extractGuardClause()` + `evalSqlPredicate()` (extrae el predicado del `.sql` y lo EVALÚA, en vez de re-implementarlo) |
| `src/adapters/solana/payment.test.ts` (1-75) | Estrategia de dobles vigente | `vi.mock('./chain.js')` con `fakeConnection`; `vi.mock('@solana/web3.js')` conservando lo real salvo `sendAndConfirmTransaction`; CD-11 (`(..._a: unknown[])`) y CD-12 (`noUncheckedIndexedAccess`) |
| `src/adapters/solana/intent-dedup.test.ts` (791 líneas) | La batería que se reescribe | Toda la política TTL/cap/ventana protegida/reloj inyectable — ver §5.4 (tabla de destino test por test) |
| `doc/sdd/202-hop2-lease/work-item.md` (completo) | **Precedente de diseño y de rigor** | "el claim ES el lease"; abort fail-closed si el lease no se toma; ACs redactados como prohibiciones falsables sobre el EFECTO EN LA PLATA; mutación por guard con `sha256sum` |
| `doc/sdd/202-hop2-lease/auto-blindaje.md` (completo) | Aprendizaje obligatorio | Ver §3.4 |
| `doc/sdd/208-compose-por-capacidad/auto-blindaje.md` (completo) | Aprendizaje obligatorio | Ver §3.4 |
| `doc/sdd/182-wkh-234-solana-payment-adapter/sdd.md` (CD-7) | Verificar el boundary | **CD-7 de WKH-234 es sobre contener `@solana/web3.js`/`@solana/spl-token` dentro de `src/adapters/solana/*`**, NO sobre prohibir DB en adapters. Ver DT-7 |
| `node_modules/@solana/web3.js/lib/index.cjs.js` (2266-2311, 8124-8164) | **Verificación del SDK, no suposición** | `sendAndConfirmTransaction` ⟶ `connection.sendTransaction` ⟶ **sobrescribe `recentBlockhash` incondicionalmente y re-firma** (`:8141-8144`) ⟹ pre-firmar para conocer la firma NO sobrevive. Es lo que fuerza DT-6 |
| `node_modules/@solana/web3.js/lib/index.d.ts` (3443, 3650) | Verificación de API disponible | `isBlockhashValid(...)` y `sendRawTransaction(...)` EXISTEN en la v1.98.4 instalada |

### 3.2 Archivos leídos — `wasiai-facilitator` (SOLO LECTURA, CD-3)

| Archivo | Por qué | Patrón / hallazgo |
|---------|---------|-------------------|
| `doc/sdd/031-wkh-302-solana-facilitator-signed-settle/sdd.md` (1-538) | **Resuelve Missing Input #1** | Ver §3.3 |
| `src/infra/solana-escrow-release-dedup.ts` (1-107) | **Exemplar del claim durable fail-closed** | `ClaimResult = {ok:true,claimed:true} \| {ok:true,claimed:false} \| {ok:false}`; `INSERT` (nunca upsert-ignore) para que el 23505 aflore como caso distinto; cliente nulo ⟹ `{ok:false}` ⟹ el caller RECHAZA; logs sin PII |
| `src/infra/solana-dedup.ts` (cabecera, 5.8K) | Contraste explícito | Keyed por `signature` (verify-then-record de un settle que YA ocurrió). Confirma DT-1 |

### 3.3 Coordinación con WKH-302 — **Missing Input #1 RESUELTO**

El work-item no encontró el WKH-302 porque **vive en el otro repo**:
`/home/ferdev/.openclaw/workspace/wasiai-facilitator/doc/sdd/031-wkh-302-solana-facilitator-signed-settle/sdd.md`
(leído completo, fechado 2026-07-28, `SPEC_APPROVED: no`).

**El supuesto de DT-3 del work-item queda CONFIRMADO por la contraparte, no asumido.** Su
§4.0 DT-5 punto 2 dice literalmente: *"Su DT-3 queda CONFIRMADO sin cambios. […] el punto de
claim de WKH-307 en `payment.ts` sigue estando antes del bloque que transmite; lo único que
cambia dentro de ese bloque es `sendAndConfirmTransaction(...)` local →
`payoutViaFacilitator(...)` HTTP. **Este diseño NO obliga a mover el reclamo.**"*

**La propiedad que hay que sostener, y cómo este SDD la sostiene**: el reclamo del `intentId`
es lo primero que hace `settle()`, sobre datos (`intentId`, `payTo`, `amountAtomic`, `mint`)
que existen **antes** de que haya transacción, blockhash o firma, y **antes** de la
ramificación por `SOLANA_SETTLE_VIA_FACILITATOR` que WKH-302 introduce. Formalmente:

> **Invariante WKH-307/I0 — el reclamo es una función de la INTENCIÓN, no de la EJECUCIÓN.
> Ningún dato que el reclamo consume proviene de quien transmite. Por lo tanto, cambiar quién
> transmite no puede invalidar el reclamo.**

Los dos requisitos que WKH-302 le pide a esta HU (su §DT-5 punto 4) quedan satisfechos:

| Req. de WKH-302 | Cómo lo cumple este SDD |
|---|---|
| **R1** — el claim va **antes de la ramificación** por `SOLANA_SETTLE_VIA_FACILITATOR`, no dentro de una rama | §4.4 paso 1: el claim es la primera operación de `settle()`, antes de resolver `Connection`, operator, mint y ATAs. La bandera de 302 se leerá después (CD-14 lo fija como prohibición explícita para que un rebase no lo mueva) |
| **R2** — el caso "crash entre broadcast y persistencia" **no** puede quedar como estado terminal irrecuperable; debe permitir relectura contra el ejecutor | §4.3: el estado `signed` guarda la firma **y** el `last_valid_block_height`, así que el retry relee la cadena (hoy) o al ejecutor (post-302) y siempre tiene una salida provable. AC-10 |

**Jerarquía de seams (compatible con la invariante I1 de WKH-302)**: esta tabla es la fuente
**autorizante**; la `facilitator_solana_payouts` de WKH-302 es una barrera **subordinada** que
sólo puede vetar o replicar. Dos barreras at-most-once compuestas siguen siendo at-most-once.
No hay split-brain porque el facilitator nunca inicia un payout.

**Orden de aterrizaje**: indiferente. Único archivo compartido:
`src/adapters/solana/payment.ts` (`settle()`); quien aterrice segundo rebasea. Sin conflicto
de esquema (bases distintas) ni de env (`SOLANA_SETTLE_*` vs `SOLANA_SETTLE_LEDGER_*`).

**Lo único que este SDD le pide de vuelta a WKH-302** (declarado acá para que no se pierda,
no bloqueante): si la ruta `POST /solana/payout` devuelve la firma **antes** de que el
gateway persista, el gateway debe seguir persistiendo `signed` con esa firma antes de tratar
el leg como pagado. Es la misma invariante I2 de 302 vista desde el otro lado.

### 3.4 Auto-Blindaje histórico aplicado (últimas HUs con auto-blindaje: 208, 202, 203, 201)

Se leyeron `doc/sdd/208-compose-por-capacidad/auto-blindaje.md` y
`doc/sdd/202-hop2-lease/auto-blindaje.md` completos. **Tres patrones de error aparecen en ≥2
HUs** y por eso se convierten en Constraint Directives de esta HU, no en consejos:

| Patrón recurrente | Evidencia (≥2 HUs) | CD que lo previene acá |
|---|---|---|
| **Dobles de test que tiran a la basura lo que reciben, o devuelven menos de lo que devuelve la función real** ⟹ tests verdes que no candan nada | HU-202 W1 (el doble devolvía `undefined` donde la real devuelve `Promise<boolean>` ⟹ TODO el suite corría la rama equivocada); HU-202 fix-pack 21:15 (el doble ignoraba `.eq()`/`.is()` ⟹ **2 mutaciones sobrevivieron**; el propio auto-blindaje anota que es la **tercera** vez que ese archivo paga lo mismo) | **CD-9** |
| **Aserciones sobre el MECANISMO en vez de sobre el EFECTO en la plata** ⟹ se rompen (o pasan) por motivos ajenos a la propiedad candada | HU-202 W2 (`toHaveBeenCalledWith` sobre un estado intermedio); HU-202 fix-pack 22:00 (una tabla de verdad re-implementada en JS: **verdadera por construcción, demostrado con una mutación stealth que quedó VERDE**); HU-208 W3/M5 ("toda afirmación del tipo *no agrega costo* tiene que asertar el costo") | **CD-10** |
| **Un `boolean` en un camino de dinero escondiendo una unión de causas con remedios distintos** | HU-202 fix-pack 18:40 (`false` colapsaba guard-rechazó / write-falló / RPC-tiró) | **CD-11** |

Dos lecciones más, de una sola HU pero directamente aplicables porque esta HU repite la
situación exacta:

| Lección | Origen | Dónde se aplica |
|---|---|---|
| Si el fix depende de una migración, **el chequeo de esa migración es parte del fix** (un gate en prosa no es un gate) | HU-202 fix-pack 18:10 | **AC-11** + W1.2 (`solana/schema-preflight.ts`) |
| Un estado que bloquea una acción automática necesita, **en el mismo PR**, la operación que lo destraba | HU-202 fix-pack 19:20 | **AC-10** + §4.3 (la máquina de estados no tiene sumidero) |
| La evidencia de que una mutación se revirtió es el `sha256sum`, **no** el `git status` (los archivos nuevos son untracked) | HU-202 W2 11:05 | **§5.5** (esta HU crea 2 `.sql` + 1 `.mjs` untracked) |

### 3.5 Estado de BD relevante (proyecto Supabase de `wasiai-a2a`)

| Tabla | Existe | Relevancia |
|-------|--------|-----------|
| `a2a_receipts` | **Sí** (`20260605000000_a2a_receipts.sql`) | Tiene `settle_caip2` + `settle_signature` (`20260724000000_wkh234...`). **Descartada como sede del reclamo** — ver DT-4 |
| `a2a_payment_intent_debit_signatures` | **Sí** | Ciclo de vida del escrow EVM (`debit_settle_status`, `debit_hop2_attempted_at`). Dominio distinto; **no se toca** |
| `a2a_signed_auth_nonces` | **Sí** | Exemplar del `INSERT`+23505. No se toca |
| `a2a_solana_settle_intents` | **No** | **La crea esta HU** (§4.2) |
| `facilitator_solana_settlements` | Sí, pero en **otro proyecto Supabase** | Keyed por `signature`. **PROHIBIDO** leerla o escribirla desde este repo (CD-3) |

Topología (verificada leyendo `src/lib/supabase.ts` de este repo vs
`wasiai-facilitator/src/infra/supabase.ts`): son **proyectos Supabase distintos**. No hay
conexión cross-DB en ninguno de los dos repos.

### 3.6 Exemplars verificados (todos confirmados en disco)

| Para crear / modificar | Seguir patrón de | Verificado |
|---|---|---|
| `src/adapters/solana/settle-ledger.ts` (nuevo) | `wasiai-facilitator/src/infra/solana-escrow-release-dedup.ts` (claim-first fail-closed, resultado discriminado) + `src/adapters/escrow/debit-executor.ts:299-370` (consumo de RPC condicional con retorno discriminado) | ✅ ambos leídos |
| `src/adapters/solana/schema-preflight.ts` (nuevo) | `src/adapters/escrow/schema-preflight.ts` | ✅ leído |
| `supabase/migrations/2026073000000_wkh307_solana_settle_intents.sql` (nuevo) | `supabase/migrations/20260729000000_hu202_hop2_lease.sql` | ✅ leído |
| `scripts/apply-wkh307-migration.mjs` (nuevo) | `scripts/apply-hu202-migration.mjs` | ✅ leído |
| `test/wkh307-solana-settle-intents.migration.test.ts` (nuevo) | `test/hu202-hop2-lease.migration.test.ts` | ✅ leído |
| `src/adapters/solana/settle-ledger.test.ts` (nuevo) | `src/services/signed-auth.test.ts` + dobles de `src/adapters/solana/payment.test.ts:1-75` | ✅ leídos |
| `src/adapters/solana/payment.ts` (modificar) | él mismo (preservar `verify()`, `recoverConfirmedSettle()`, `candidateSignatureFromFailure()`) | ✅ leído completo |
| `src/types/database.types.ts` (modificar) | entrada `a2a_refund_outbox` `:1048-1090` | ✅ leído |

---

## 4. Diseño Técnico

### 4.0 Decisiones técnicas (DT-N)

DT-1..DT-4 se heredan del work-item (DT-1/DT-2 ratificadas, DT-3 confirmada contra la fuente,
DT-4 resuelta). DT-5..DT-12 las agrega F2.

#### DT-1 — La tabla del facilitator NO sirve, y el motivo es estructural (RATIFICADA)

`facilitator_solana_settlements` está **keyed por `signature`**
(`wasiai-facilitator/src/infra/solana-dedup.ts`, `UNIQUE(signature)`). Eso responde a la
pregunta *"¿esta prueba que me presentaron ya la vi?"* — un **verify-then-record** de un
settle que **YA ocurrió**.

Esta HU necesita responder una pregunta **distinta y anterior**: *"¿este `intentId` lo estoy
por pagar yo, y nadie más debe hacerlo?"*. Ahí **todavía no existe firma**: no hay
transacción, ni blockhash, ni mensaje que firmar. Una clave que no existe no puede ser clave
primaria. Y el segundo motivo, independiente del primero: son **proyectos Supabase
distintos**, así que ni siquiera es una opción técnica (CD-3).

Los dos problemas son:

| | "esto ya lo vi" | "esto lo estoy por hacer" |
|---|---|---|
| Clave | `signature` (existe después) | `intent_id` (existe antes) |
| Momento | post-broadcast | **pre-broadcast** |
| Falla si falta | replay contable | **doble pago real** |
| Dónde vive | DB del facilitator | **DB de este repo** |

#### DT-2 — Atomicidad: escritura condicional única, nunca leer-y-después-escribir (RATIFICADA)

Toda transición de estado es **una sola operación de base de datos que informa en su propio
resultado si aplicó**. Dos formas, ambas ya usadas en este repo:

- `INSERT ... ON CONFLICT (intent_id) DO UPDATE ... WHERE <condición> RETURNING` — el reclamo.
- `UPDATE ... WHERE intent_id = ? AND <estado esperado> RETURNING` — las transiciones.

**PROHIBIDO** un `SELECT` que decida y un `INSERT`/`UPDATE` que ejecute. Ese es exactamente
el error corregido en HU-202 y la razón de existir de CD-1.

> ⚠️ **Aclaración anti-falso-positivo para AR**: la función de reclamo (§4.2) hace un `SELECT`
> **después** del upsert condicional, cuando éste devolvió 0 filas, para poder CLASIFICAR al
> perdedor (¿está `signed`? ¿`confirmed`? ¿términos distintos?). Ese `SELECT` **no puede
> autorizar nada**: el único camino que devuelve `outcome = 'claimed'` es el que la escritura
> atómica devolvió con filas. Es read-after-write de clasificación, no read-before-write de
> decisión. El test **T-LDG-13** canda esa propiedad (ningún `outcome='claimed'` sin fila
> devuelta por el upsert).

#### DT-3 — El reclamo va antes del punto de transmisión (CONFIRMADA contra WKH-302)

Ver §3.3. Invariante I0. Confirmada por el SDD de la contraparte, no supuesta.

#### DT-4 — Tabla dedicada nueva, **no** extender `a2a_receipts` (Missing Input #2 RESUELTO)

**Decisión: tabla nueva `a2a_solana_settle_intents`.** Cuatro razones, en orden de peso:

1. **Semántica opuesta e incompatible.** `a2a_receipts` es un libro **append-only de hechos
   consumados**, encadenado por owner con `prev_receipt_hash` y firmado con HMAC
   (`src/services/receipt.ts:1-13`), emitido **best-effort fire-and-forget DESPUÉS del pago**.
   Esta HU necesita exactamente lo contrario: una fila **mutable**, escrita **antes** del
   pago, cuya escritura es **bloqueante y fail-closed**. Meter una fila "todavía no pasó nada"
   en un ledger de recibos firmados contamina la cadena de hashes y el significado del libro.
2. **La clave no existe en `a2a_receipts`.** Un recibo se identifica por `id` (UUID propio) y
   no tiene `settle_intent_id`. Agregarlo + un `UNIQUE` parcial sobre él es crear la tabla
   nueva dentro de otra tabla, con todas sus columnas obligatorias (`owner_ref`, `chain_id`,
   `amount_usd`, `receipt_type`, `prev_receipt_hash`…) rellenadas con valores inventados en el
   momento del reclamo, cuando todavía no se sabe si va a haber pago.
3. **Ownership.** `a2a_receipts` está particionada por `owner_ref` y tiene RLS
   (`20260607000000_wkh_sec02_rls.sql`). El `intentId` (`<uuid-del-run>:<step>`) es un
   identificador de EJECUCIÓN del gateway, no de un owner; el adapter Solana ni siquiera
   recibe `owner_ref` (`SolanaSettleRequest`, `src/adapters/types.ts:106-110`). Forzar la
   columna obligaría a atravesar `owner_ref` por todo el camino del adapter — scope ajeno.
4. **WKH-235a dejó prevista `settle_intent_id` en `a2a_receipts` para OTRA cosa**: el dedup
   **cross-caller** por `x-idempotency-key` HTTP (Scope OUT explícito de esta HU). Ocupar ese
   nombre ahora con una semántica distinta le crea una trampa a esa HU futura.

**Consecuencia declarada**: `a2a_receipts.settle_signature` sigue existiendo y sigue siendo el
recibo. La tabla nueva es el **reclamo**. Son dos hechos distintos y viven en dos lugares
distintos, a propósito.

#### DT-5 — Sin TTL, sin cap, sin ventana protegida, sin reloj inyectable (Missing Input #3 RESUELTO)

**Toda la maquinaria de retención se elimina**: `resolveIntentTtlMs`, `resolveMaxIntentEntries`,
`resolveProtectedWindowMs`, `evictIntentSignatures`, `_warnedSoftCapBreached`,
`ESTIMATED_MAX_RUN_WALL_CLOCK_MS`, `UNDICI_DEFAULT_HOP_TIMEOUT_MS`, `TTL_*`,
`intentDedupNow`, `_intentDedupClock` (`payment.ts:86-358`, `:714-781`).

Por qué eliminar y no portar:

- **Existía por un motivo que desaparece.** El propio código lo declara
  (`payment.ts:65-69`): *"El Map no tenía cota: cada intent dejaba una entrada PARA SIEMPRE
  → leak de memoria en un proceso de larga vida"*. Una tabla Postgres indexada no tiene ese
  problema.
- **Era un riesgo de dinero, no una protección.** El mismo bloque
  (`payment.ts:70-74`): *"Si una entrada desaparece MIENTRAS EL INTENT SIGUE VIVO, un retry
  re-broadcastea → SE PAGA DOS VECES"*. Y `payment.ts:178-180` admite que **no existe cota
  superior dura** de vida de un run, así que ningún TTL puede prometer que no expira dentro de
  la ventana viva. Portar el TTL a la tabla sería portar un agujero de doble pago sin ninguna
  contrapartida.
- **Los knobs `SOLANA_INTENT_DEDUP_TTL_MS` / `SOLANA_INTENT_DEDUP_MAX_ENTRIES`
  (`.env.example:993,1001`) se retiran** de `.env.example` con una nota de deprecación. No se
  leen más. Dejarlos "por compatibilidad" es peor: un operador podría creer que sigue
  gobernando algo.
- **Volumen**: una fila por leg Solana settleado, ~200 bytes. Con `SOLANA_ADAPTER_ENABLED`
  activo sólo en devnet y el volumen actual de settles Solana, la tabla no necesita política
  de retención en esta HU. Si algún día la necesita, será una tarea de ops con una consulta de
  inventario (§4.7), no un mecanismo en el hot path del dinero.

**Lo único que se conserva del bloque viejo es un tiempo**, y no es un TTL: el **lease del
estado `claimed`** (§4.3), que gobierna cuándo un reclamo huérfano puede ser tomado por otro
— y que es seguro justamente porque `claimed` **demuestra** que no se transmitió nada.

#### DT-6 — Persist-before-broadcast: hay que dejar de usar `sendAndConfirmTransaction`

Este es el punto donde AC-6 deja de ser una aspiración. **Verificado en el SDK instalado, no
supuesto** (`node_modules/@solana/web3.js@1.98.4/lib/index.cjs.js`):

```
sendAndConfirmTransaction  :2273  →  connection.sendTransaction(transaction, signers, ...)
connection.sendTransaction :8141  →  const latestBlockhash = await this._blockhashWithExpiryBlockHeight(...)
                           :8143  →  transaction.recentBlockhash = latestBlockhash.blockhash   ← INCONDICIONAL
                           :8144  →  transaction.sign(...signers)
```

`sendTransaction` **sobrescribe el blockhash aunque ya esté seteado** y re-firma. Por lo
tanto **es imposible conocer la firma antes del envío** mientras se use ese helper: cualquier
pre-firma queda invalidada. Y sin conocer la firma antes del envío, la ventana
"transmitió-pero-no-persistió" no tiene salida provable.

**Decisión: `settle()` firma explícitamente y transmite en dos pasos.**

1. `const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment)`
2. `tx.feePayer = operator.publicKey; tx.recentBlockhash = blockhash; tx.lastValidBlockHeight = lastValidBlockHeight`
3. `tx.sign(operator)` → `signature = base58Encode(tx.signature)` *(reusa `base58Encode` de
   `src/adapters/solana/base58.ts`, ya usado en `candidateSignatureFromFailure`
   `payment.ts:414`)*
4. **PERSISTIR** `signed` + `signature` + `last_valid_block_height` (escritura condicional).
   Si no aplica ⟹ **no se transmite** (fail-closed).
5. `connection.sendRawTransaction(tx.serialize(), { preflightCommitment: commitment })`
6. `connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, commitment)`
7. **PERSISTIR** `confirmed`.

> **Invariante WKH-307/I2 — el broadcast ocurre SIEMPRE después de que la firma quedó
> persistida. Por lo tanto, una fila en `claimed` (sin firma) DEMUESTRA que nunca se
> transmitió nada.**
>
> Es la misma invariante que WKH-302 adoptó de forma independiente para el facilitator
> (su §DT-9, "invariante WKH-302/I2"). Que las dos HUs converjan en ella sin coordinarse es
> evidencia de que es la forma correcta, no una preferencia.

**Qué se pierde y cómo se repone** (esto es lo que hace que DT-6 no sea gratis): el helper
descartado traía un bucle anti-firma-duplicada (`:8145-8160`) que re-pedía blockhash si la
firma derivada ya se había visto con el blockhash cacheado. Se repone en DT-10 con una
garantía **más fuerte** (durable y cross-proceso, no un `Set` en memoria de la `Connection`).

**Riesgo asumido y acotado**: se reescribe el primitivo de broadcast del money-path Solana.
Mitigación: (a) devnet-only por construcción (`chain.ts:31-37`); (b) `verify()` y
`recoverConfirmedSettle()` **no se tocan** — siguen siendo la validación de verdad;
(c) T-PAY-01..T-PAY-04 (§5.2) fijan el orden exacto de los pasos 4↔5, que es la invariante
entera; (d) M6/M7 (§5.5) son las mutaciones que lo prueban.

#### DT-7 — Dónde vive el acceso a DB, y por qué eso no rompe el boundary de WKH-234

**Verificado, no asumido**: CD-7 de WKH-234 (`doc/sdd/182-wkh-234-solana-payment-adapter/sdd.md:148`)
dice *"`@solana/web3.js`/`@solana/spl-token` viven SOLO en `src/adapters/solana/*`"* — es una
regla de **contención hacia afuera** (que el SDK de Solana no se filtre a `services/` ni
`routes/`), **no** una prohibición de que un adapter toque la DB.

La frase *"cero imports de services/DB"* que aparece en `payment.ts:462` y
`src/adapters/types.ts:141-146` está en el docstring de **`getOperatorSplBalance`**, y
describe **esa función** (una lectura pura del RPC), no el módulo.

**Precedente vivo en el mismo directorio de adapters** (verificado con grep):
`src/adapters/escrow/schema-preflight.ts:93`, `src/adapters/escrow/debit-capture.ts:22` y
`src/adapters/escrow/debit-executor.ts:33` importan `../../lib/supabase.js`. O sea: un adapter
que toca DB **ya es convención de este repo**.

**Diseño adoptado**: módulo nuevo `src/adapters/solana/settle-ledger.ts` — el **único** lugar
de `src/adapters/solana/**` que importa `../../lib/supabase.js`. `payment.ts` importa
`settle-ledger.js` y **nunca** `lib/supabase.js` directamente. Así el acoplamiento a DB queda
en un archivo, testeable y mockeable de una sola pieza. CD-6 lo fija.

#### DT-8 — `getSettledSignature` pasa a asíncrono y a resultado discriminado

Hoy es **síncrono** (`src/adapters/types.ts:150`) porque lee un `Map`. Contra una tabla no
puede serlo. Cambia a:

```
getSettledSignature(intentId): Promise<SettledPeek>
type SettledPeek =
  | { state: 'none' }                          // no hay reclamo
  | { state: 'settled'; signature: string }     // confirmado y con firma
  | { state: 'in_progress' }                    // reclamado por alguien, sin confirmar
  | { state: 'unknown' }                        // el store no respondió
```

**Por qué una unión y no `string | undefined`** (CD-11 / auto-blindaje HU-202 18:40): el
retorno actual colapsa *"no se pagó"* con *"no sé si se pagó"*, que en un camino de dinero son
opuestos. Con la unión, el caller distingue y loguea distinto.

**Único call-site**: `src/lib/downstream-payment.ts:326` (verificado con grep exhaustivo). Su
uso es gobernar si el pre-check de balance **CORTA** (`INSUFFICIENT_BALANCE`) o sólo
**SONDEA**. Mapeo:

| `SettledPeek` | Efecto en el pre-check | Justificación |
|---|---|---|
| `settled` | **SONDA** (no corta) | Idéntico a hoy: un pago ya hecho no necesita fondos otra vez (FIX 2 de WKH-235a, `downstream-payment.ts:318-324`) |
| `in_progress` | **SONDA** (no corta) | Puede terminar en el camino idempotente; y si corta, `settle()` fail-closea igual |
| `none` | **GATE** (corta) | Idéntico a hoy |
| `unknown` | **GATE** (corta) + `code: 'SETTLE_LEDGER_UNAVAILABLE'` | Fail-closed: con el store mudo, `settle()` va a rechazar igual; cortar antes ahorra un RPC y deja el motivo REAL en el log en vez de un `SETTLE_FAILED` genérico |

`settle()` sigue siendo **la única autoridad**: el peek nunca autoriza ni impide un pago por
sí solo. **NUNCA lanza** (contrato preservado): un fallo del store se traduce a `unknown`.

#### DT-9 — El `intentId` de fallback es una trampa que un store durable convierte en permanente

**Hallazgo de F2, no estaba en el work-item.** `src/lib/downstream-payment.ts:325`:

```ts
const legIntentId = intentId ?? `${agent.slug}:${payTo}`;
```

Con el `Map` in-memory + TTL, un `intentId` derivado de `slug:payTo` deduplicaba durante ~50
minutos. **Con un store durable dedupllicaría PARA SIEMPRE**: el primer pago a ese agente
quedaría registrado como confirmado y **todo pago futuro a ese agente devolvería la firma
vieja sin transferir nada**. El agente cobraría una vez en su vida.

**Estado real verificado**: los dos únicos call-sites de producción de `invokeAgent`
(`src/services/compose.ts:387` y `:667`) pasan `` `${composeRunId}:${i}` `` con
`composeRunId = randomUUID()` (`:182`), y `invokeAgent` es el único caller de
`signAndSettleDownstream` (grep exhaustivo). **El fallback es hoy inalcanzable en
producción.** Pero es una bomba de tiempo: cualquier call-site futuro que omita el argumento
la activa, y el modo de falla es silencioso (el agente deja de cobrar y el sistema reporta
éxito).

**Decisión**: el `intentId` pasa a ser **obligatorio** para el leg Solana. Se elimina el
fallback derivado; si `intentId` es `undefined` o vacío, `settleSolanaLeg` devuelve `null` con
un skip-code nuevo y distinguible (`MISSING_INTENT_ID`), **sin** intentar pagar. Es
fail-closed y no cambia ningún comportamiento actual (el argumento siempre viene).

> Alternativa rechazada: derivar un fallback con `randomUUID()` por invocación. Sería peor —
> un `intentId` aleatorio por llamada **desactiva la idempotencia entera** y convierte
> cualquier retry en un pago nuevo. Un identificador de idempotencia que no es estable entre
> reintentos no es un identificador de idempotencia.

#### DT-10 — `UNIQUE` sobre la firma: la reposición de la protección que DT-6 quita (AC-9)

Índice **único parcial** `WHERE settle_signature IS NOT NULL` sobre `settle_signature`.

Escenario que cubre: dos legs del mismo run pagan al **mismo** agente el **mismo** monto. Los
`intentId` difieren (`run:0`, `run:1`) pero el mensaje de la transacción es idéntico (mismo
from-ATA, to-ATA, monto, operador). Bajo el **mismo blockhash** la firma ed25519 es idéntica
⟹ una sola transferencia on-chain ⟹ dos filas la reclamarían como propia ⟹ **el agente cobra
la mitad de lo que se le contabilizó**.

Mecánica: el paso 4 de DT-6 (persistir `signed`) choca con `23505`. Como el choque ocurre
**antes del broadcast**, todavía no salió nada. El adapter **re-pide blockhash y re-firma**,
hasta `SOLANA_SETTLE_SIGN_MAX_ATTEMPTS` (default **3**); agotados, fail-closed con
`SIGNATURE_COLLISION`.

Es **más fuerte** que el bucle del SDK que reemplaza: aquel usaba un `Set` en memoria de la
`Connection` (por proceso, se pierde en el restart); éste es durable y cross-proceso.

> Alternativa rechazada: instrucción **Memo** con el `intentId` para hacer único el mensaje.
> Resuelve lo mismo y además haría el `intentId` auditable on-chain, pero (a) cambia la forma
> de la transacción del money-path, (b) suma un program-id más que pinnear, y (c) WKH-302
> arma su propia transacción y el memo se perdería en el cutover. El `UNIQUE` no toca la
> cadena y no se pierde. Queda anotado como mejora futura, no como deuda.

#### DT-11 — Preflight de esquema ejecutable (AC-11)

`src/adapters/solana/schema-preflight.ts`, espejo de `src/adapters/escrow/schema-preflight.ts`:

- **Probe**: `select('intent_id').limit(1)` sobre `a2a_solana_settle_intents` + una llamada al
  RPC de reclamo con un `intent_id` sentinela imposible y `p_probe := true`, que **RAISE**
  antes de cualquier escritura. Sin efectos: no escribe, no deja locks.
- **Veredicto discriminado y memoizado**, con reintento cada `RETRY_MS_DEFAULT` (60 s), igual
  que el exemplar.
- **Enforcement perezoso** en `settle()` (primera operación, antes del reclamo), no en el
  boot: no rompe el arranque de quien no usa Solana y no tiene ventana TOCTOU.
- **Warm-up** fire-and-forget desde `src/index.ts` cuando `SOLANA_ADAPTER_ENABLED === 'true'`,
  para que el `log.error` suene en el arranque y no en medio de una transferencia. Mismo probe
  y mismo cache: el warm-up no puede divergir del gate.
- **Veredicto negativo ⟹ `settle()` rechaza**. NUNCA cae al `Map` (que ya no existe) ni a
  ningún fallback (CD-2).

**Consecuencia declarada de AC-7 (esto es lo que el preflight hace visible en vez de
silencioso)**: mientras la migración no se aplique a `caldz`, un entorno que apunte a `caldz`
**con `SOLANA_ADAPTER_ENABLED=true`** no va a poder settlear en Solana. Es fail-closed
**deliberado**: preferimos un agente sin cobrar (recuperable) a un agente cobrando dos veces
(irrecuperable). Hoy el default del flag es `false` (`.env.example:953`) y la cadena es
devnet-only (`chain.ts:31-37`), así que el impacto operativo esperado es nulo. Aplicar a
`caldz` es **WKH-307b**, founder-gated, y su creación es condición de Done (§11).

#### DT-12 — Escrituras vía RPC `plpgsql`, no vía `.update()` de supabase-js

Las cuatro transiciones se exponen como funciones SQL invocadas con `supabase.rpc(...)`
(patrón `record_debit_settle_status`, `src/adapters/escrow/debit-executor.ts:306`), no como
cadenas `.update().eq(...)`. Tres motivos, el primero es de corrección:

1. **El lease necesita el reloj del SERVIDOR.** La condición de toma huérfana es
   `claimed_at < now() - lease`. Con `.lt('claimed_at', <ISO calculado en Node>)` el umbral lo
   fija el reloj del **cliente**: dos instancias del gateway con skew de reloj tienen leases
   distintos, y un reloj adelantado puede robar un lease vivo ⟹ dos broadcasts. Con `now()`
   de Postgres hay **un solo reloj** para todos los procesos.
2. **`INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING` no es expresable** con el
   query-builder de supabase-js. Partirlo en dos llamadas es exactamente el read-then-write
   que CD-1 prohíbe.
3. **Testabilidad honesta.** Un doble de `.update().eq().eq().select()` es justo el tipo de
   doble que "tira a la basura lo que recibe" y produjo mutaciones sobrevivientes en HU-202
   (auto-blindaje 21:15). Un doble de `supabase.rpc(name, args)` recibe los argumentos como un
   objeto plano y no puede ignorarlos sin que se note.

**Firma y tipo de retorno estables desde el día 1** (lección de HU-198/202): las funciones
nacen devolviendo una fila con `applied BOOLEAN` + `outcome TEXT` + el estado actual, para que
una migración futura pueda usar `CREATE OR REPLACE` sin `DROP` y sin ventana `PGRST202`.

### 4.1 Archivos a crear / modificar

| # | Archivo | Acción | Qué hace | Exemplar (verificado) | Wave |
|---|---------|--------|----------|----------------------|------|
| 1 | `supabase/migrations/20260730000000_wkh307_solana_settle_intents.sql` | **Crear** | Tabla + índices + 4 funciones de transición atómica + GRANTs + `COMMENT ON` | `supabase/migrations/20260729000000_hu202_hop2_lease.sql` | W0 |
| 2 | `supabase/migrations/20260730000000_wkh307_solana_settle_intents_down.sql` | **Crear** | Rollback que **no destruye evidencia** (ver §4.2) | `20260729000000_hu202_hop2_lease_down.sql` | W0 |
| 3 | `src/types/database.types.ts` | Modificar | Entrada `a2a_solana_settle_intents` (`Row`/`Insert`/`Update`) + firmas de las 4 funciones en `Functions` | entrada `a2a_refund_outbox` `:1048-1090` | W0 |
| 4 | `src/adapters/solana/settle-ledger.ts` | **Crear** | Único punto de acceso a DB del adapter Solana. Expone `claimSettleIntent`, `recordSignedIntent`, `recordConfirmedIntent`, `reclaimExpiredIntent`, `readSettleIntent`. Resultados **discriminados**, fail-closed | `wasiai-facilitator/src/infra/solana-escrow-release-dedup.ts` + `src/adapters/escrow/debit-executor.ts:299-370` | W1 |
| 5 | `src/adapters/solana/schema-preflight.ts` | **Crear** | Probe perezoso memoizado del esquema (AC-11) + `warmSolanaSchemaPreflight()` | `src/adapters/escrow/schema-preflight.ts` | W1 |
| 6 | `src/adapters/solana/payment.ts` | Modificar | Borra la maquinaria del `Map` (DT-5); `settle()` pasa a la máquina de estados (§4.3-§4.4); firma explícita + `sendRawTransaction` + `confirmTransaction` (DT-6); `getSettledSignature` async (DT-8); `recoverConfirmedSettle` y `verify` conservan su semántica | él mismo | W2 |
| 7 | `src/adapters/types.ts` | Modificar | `getSettledSignature(intentId): Promise<SettledPeek>` + tipo `SettledPeek` | contrato existente `:117-151` | W2 |
| 8 | `src/lib/downstream-payment.ts` | Modificar | `await` del peek + mapeo de §DT-8; elimina el fallback de `intentId` (DT-9) | su propio bloque `:318-340` | W2 |
| 9 | `src/lib/downstream-skip-code.ts` | Modificar | Alta de `MISSING_INTENT_ID` y `SETTLE_LEDGER_UNAVAILABLE` en el catálogo | catálogo existente `:27-70` | W2 |
| 10 | `src/index.ts` | Modificar | `warmSolanaSchemaPreflight()` fire-and-forget cuando `SOLANA_ADAPTER_ENABLED === 'true'` | el `warmEscrowSchemaPreflight()` que ya está ahí | W2 |
| 11 | `.env.example` | Modificar | Alta de `SOLANA_SETTLE_LEDGER_LEASE_MS`, `SOLANA_SETTLE_SIGN_MAX_ATTEMPTS`; **baja** de `SOLANA_INTENT_DEDUP_TTL_MS` y `SOLANA_INTENT_DEDUP_MAX_ENTRIES` con nota de deprecación | bloque Solana `:953-1001` | W2 |
| 12 | `src/adapters/solana/settle-ledger.test.ts` | **Crear** | Batería del módulo nuevo (T-LDG-*) | `src/services/signed-auth.test.ts` | W3 |
| 13 | `src/adapters/solana/intent-dedup.test.ts` | **Reescribir** | Pasa a ser la batería de idempotencia **durable** (T-IDM-*). Ver §5.4 (destino test por test) | él mismo + `payment.test.ts:1-75` | W3 |
| 14 | `src/adapters/solana/payment.test.ts` | Modificar | Dobles nuevos de `Connection` (DT-6) + T-PAY-* del orden persist→broadcast | él mismo | W3 |
| 15 | `src/lib/downstream-payment.test.ts` | Modificar | Peek async + `MISSING_INTENT_ID` + `SETTLE_LEDGER_UNAVAILABLE` | él mismo `:89` | W3 |
| 16 | `test/wkh307-solana-settle-intents.migration.test.ts` | **Crear** | SQL-estructural con `code()`/`fnBody()`/`extractGuardClause()`+`evalSqlPredicate()` | `test/hu202-hop2-lease.migration.test.ts` | W3 |
| 17 | `scripts/apply-wkh307-migration.mjs` | **Crear** | Applier **bdwv-only** con guard anti-caldz + post-estado leído del catálogo | `scripts/apply-hu202-migration.mjs` | W0 |
| 18 | `src/adapters/solana/settle-wiring.test.ts` | Modificar | Ajuste de dobles (usa `_resetSolanaClients`, `:115,125`) | él mismo | W3 |

> **Archivos que NO se tocan y hay que dejar constancia**: `src/adapters/solana/verify` (vive
> dentro de `payment.ts` y conserva su cuerpo), `src/adapters/solana/base58.ts`,
> `src/adapters/solana/chain.ts`, `src/adapters/solana/attestation.ts`,
> `src/adapters/solana/gasless.ts`, `src/adapters/registry.ts`, `src/services/compose.ts`,
> y **todo** `src/adapters/avalanche|base|tempo|kite-ozone/**` (el camino EVM queda
> byte-idéntico).

### 4.2 Modelo de datos

**Tabla nueva** `public.a2a_solana_settle_intents`:

| Columna | Tipo | Nota |
|---|---|---|
| `intent_id` | `TEXT PRIMARY KEY` | La clave del reclamo. Existe **antes** que la firma (DT-1) |
| `caip2` | `TEXT NOT NULL` | Red del adapter (`getSolanaCaip2()`) |
| `pay_to` | `TEXT NOT NULL` | Owner base58 del agente — término del intent (AC-8) |
| `amount_atomic` | `TEXT NOT NULL` | **TEXT, nunca `NUMERIC`** — convención WKH-196 (PostgREST devuelve `NUMERIC` como número JSON y `JSON.parse` redondea > 2^53) |
| `mint` | `TEXT NOT NULL` | Término del intent (AC-8) |
| `status` | `TEXT NOT NULL DEFAULT 'claimed'` | `CHECK (status IN ('claimed','signed','confirmed'))` |
| `settle_signature` | `TEXT NULL` | Firma base58. `NOT NULL` desde `signed` |
| `last_valid_block_height` | `BIGINT NULL` | Habilita la prueba "esta tx ya no puede aterrizar" (AC-10) |
| `expired_signatures` | `TEXT[] NOT NULL DEFAULT '{}'` | Historial de firmas que expiraron sin aterrizar. **La evidencia no se borra** |
| `attempts` | `INTEGER NOT NULL DEFAULT 1` | Cuántas veces se reclamó |
| `claimed_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | Ancla del lease. Reloj del **servidor** (DT-12) |
| `signed_at` / `confirmed_at` | `TIMESTAMPTZ NULL` | Auditoría |
| `created_at` / `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | Convención del repo |

**Índices**:

- `PRIMARY KEY (intent_id)` — es lo que hace atómico el reclamo.
- `CREATE UNIQUE INDEX ux_a2a_solana_settle_intents_signature ON ... (settle_signature) WHERE settle_signature IS NOT NULL` — AC-9 / DT-10.
- `CREATE INDEX idx_a2a_solana_settle_intents_status_claimed_at ON ... (status, claimed_at)` — inventario operativo (§4.7).

**Sin `owner_ref` y sin RLS** — decisión explícita, no un olvido: es una tabla de dedup
**global del gateway** (mismo criterio que `facilitator_solana_settlements` y
`facilitator_solana_release_claims`, que tampoco lo tienen; ver la nota de OWNERSHIP en
`wasiai-facilitator/src/infra/solana-escrow-release-dedup.ts:19-22`). El `intentId` es un
identificador de **ejecución del propio gateway**, no un objeto de un tenant: el adapter ni
siquiera recibe `owner_ref` (`SolanaSettleRequest`, `src/adapters/types.ts:106-110`). La regla
de Ownership Guard del `CLAUDE.md` aplica a tablas con columna de owner
(`a2a_agent_keys`, `tasks`); esta no la tiene y no debe tenerla. **Se declara acá para que AR
lo evalúe como decisión y no lo encuentre como omisión.**

**Cuatro funciones `plpgsql` `SECURITY DEFINER`** (DT-12). Todas devuelven una fila
`(applied BOOLEAN, outcome TEXT, status TEXT, settle_signature TEXT, last_valid_block_height TEXT, attempts INT)`
— **misma forma de retorno para las cuatro**, para que el consumo en TS sea uno solo y una
migración futura pueda `CREATE OR REPLACE` sin `DROP`:

| Función | Escritura condicional atómica | `outcome` posibles |
|---|---|---|
| `claim_solana_settle_intent(p_intent_id, p_caip2, p_pay_to, p_amount_atomic, p_mint, p_lease_ms, p_probe)` | `INSERT ... ON CONFLICT (intent_id) DO UPDATE SET attempts=t.attempts+1, claimed_at=now(), updated_at=now() WHERE t.status='claimed' AND t.claimed_at < now() - make_interval(secs => p_lease_ms/1000.0) AND t.pay_to=EXCLUDED.pay_to AND t.amount_atomic=EXCLUDED.amount_atomic AND t.mint=EXCLUDED.mint RETURNING ...` | `claimed` · `in_progress` · `signed` · `confirmed` · `terms_conflict` |
| `record_solana_settle_signed(p_intent_id, p_signature, p_last_valid_block_height)` | `UPDATE ... SET status='signed', settle_signature=p_signature, last_valid_block_height=..., signed_at=now() WHERE intent_id=p_intent_id AND status='claimed' RETURNING ...` | `applied` · `not_claimed` (23505 aflora como excepción → el caller lo mapea a `signature_collision`) |
| `record_solana_settle_confirmed(p_intent_id, p_signature)` | `UPDATE ... SET status='confirmed', confirmed_at=now() WHERE intent_id=p_intent_id AND settle_signature=p_signature AND status IN ('signed','confirmed') RETURNING ...` | `applied` · `signature_mismatch` |
| `reclaim_solana_settle_intent(p_intent_id, p_signature)` | `UPDATE ... SET status='claimed', expired_signatures = expired_signatures \|\| ARRAY[settle_signature], settle_signature=NULL, last_valid_block_height=NULL, attempts=attempts+1, claimed_at=now() WHERE intent_id=p_intent_id AND status='signed' AND settle_signature=p_signature RETURNING ...` | `applied` · `not_signed` |

> `p_probe` (default `false`): cuando es `true`, la función hace `RAISE EXCEPTION
> 'WKH307_PROBE_OK'` **como primera sentencia**, antes de cualquier escritura. Es la prueba
> **positiva** del preflight (DT-11): recibir esa excepción demuestra que la función deployada
> es la nueva, sin escribir una sola fila. Patrón exacto de
> `src/adapters/escrow/schema-preflight.ts:33-48`.

**Migración `_down`**: `DROP FUNCTION` de las cuatro + `DROP INDEX`, pero **NO** `DROP TABLE`
— renombra a `a2a_solana_settle_intents_backup_wkh307`. Un `DROP TABLE` destruiría el registro
de qué se pagó, que es exactamente la evidencia que esta HU existe para no perder (mismo
criterio que el `_down` de HU-202, candado por su test T15).

**Gate de orden de release**: **la migración se aplica ANTES de deployar el código**. Orden
correcto ⟹ sin ventana (la tabla vacía no cambia nada: nadie la lee todavía). Orden inverso
(código primero) ⟹ el preflight de DT-11 falla-closed y **el leg Solana no settlea** hasta que
la migración esté: degradación ruidosa y recuperable, **no** doble pago. Ese es el punto de
que el gate sea código y no prosa (AC-11).

### 4.3 Máquina de estados y qué hace un retry en cada punto

```
                    ┌──────────────────────────────────────────┐
   settle(intentId) │  claim_solana_settle_intent (ATÓMICO)    │
        ──────────► │  INSERT ... ON CONFLICT DO UPDATE WHERE  │
                    └──────────────────────────────────────────┘
                          │ claimed          │ signed / confirmed / in_progress / terms_conflict
                          ▼                  ▼
                 ┌──────────────────┐   (ver tabla de abajo)
                 │ build tx + FIRMAR│
                 └──────────────────┘
                          │ signature (existe SIN haber transmitido)
                          ▼
                 ┌──────────────────────────────┐
                 │ record_solana_settle_signed  │ ◄── ¡23505! ⟹ re-firmar (DT-10)
                 └──────────────────────────────┘
                          │ applied  ── si NO aplica ⟹ NO se transmite (fail-closed)
                          ▼
                 ┌──────────────────────────────┐
                 │ sendRawTransaction + confirm │  ← EL ÚNICO EFECTO IRREVERSIBLE
                 └──────────────────────────────┘
                          │
                          ▼
                 ┌────────────────────────────────┐
                 │ record_solana_settle_confirmed │
                 └────────────────────────────────┘
```

| Estado que encuentra el retry | Qué se SABE con certeza | Acción |
|---|---|---|
| **fila inexistente** | intent nuevo | El `INSERT` gana ⟹ `claimed` ⟹ seguir |
| **`claimed`, joven** (`claimed_at` dentro del lease) | otro request está en vuelo y **todavía no firmó** | `in_progress` ⟹ **fail-closed**, NO transmitir (AC-2) |
| **`claimed`, viejo** (fuera del lease) | el titular murió **antes de firmar** ⟹ **por I2, NUNCA transmitió nada** | El `ON CONFLICT DO UPDATE` toma el relevo atómicamente (`attempts+1`) ⟹ seguir. **Ésta es la puerta de salida de AC-10, y es segura por demostración, no por tiempo** |
| **`signed`** | hay firma y `last_valid_block_height`; el broadcast **pudo** haber salido | Verificar la firma on-chain (`verify()`): **(a) válida** ⟹ `record_confirmed` + devolverla (**AC-6 resuelto**); **(b) no válida y `getBlockHeight() > last_valid_block_height`** ⟹ esa tx **no puede aterrizar nunca** ⟹ `reclaim_solana_settle_intent` (guarda la firma en `expired_signatures`) ⟹ re-firmar; **(c) no válida y el blockhash sigue vivo** ⟹ podría aterrizar ⟹ **fail-closed** |
| **`confirmed`** | el pago se hizo | Re-verificar on-chain (**CD-5, verify-before-trust**) y devolver la firma (AC-3/AC-5). Si la re-verificación **falla**, ver §4.5 |
| **cualquiera + términos distintos** | el caller cambió `payTo`/`amount`/`mint` | `terms_conflict` ⟹ **fail-closed**, sin transmitir y **sin devolver la firma previa** (AC-8) |
| **el store no responde** | nada | `store_unavailable` ⟹ **fail-closed** (AC-4) |

**No hay estado sumidero.** Cada estado tiene salida, y ninguna salida se apoya en "pasó
suficiente tiempo": `claimed` sale por la **demostración** I2, `signed` sale por la
**demostración** de blockhash expirado. AC-10 cumplido sin ningún camino por tiempo que
reabra un doble pago (la trampa que HU-202 nombró: *"liberar por edad reabre el caso F"*).

### 4.4 Flujo principal (happy path)

1. `settle({payTo, amountAtomic, intentId})` — **paso 0**: `ensureSolanaSchemaReady()`
   (memoizado). Veredicto negativo ⟹ throw `SETTLE_LEDGER_SCHEMA_UNAVAILABLE` (AC-11).
2. **Reclamo atómico** `claimSettleIntent({intentId, caip2, payTo, amountAtomic, mint})`.
   Es la **primera operación con la red o la DB**, antes de `getSolanaConnection()`,
   `getSolanaOperatorKeypair()` y de cualquier resolución de ATA. *(R1 de WKH-302: acá va a
   quedar, después, la ramificación por `SOLANA_SETTLE_VIA_FACILITATOR` — **después** del
   reclamo, nunca antes. CD-14.)*
3. `outcome === 'claimed'` ⟹ continuar. Cualquier otro ⟹ §4.5.
4. Resolver `Connection`, operator, mint, ATAs (`getOrCreateAssociatedTokenAccount`, sin
   cambios) y construir la `Transaction` con `createTransferInstruction` (sin cambios).
5. `getLatestBlockhash(commitment)` ⟹ setear `feePayer` + `recentBlockhash` +
   `lastValidBlockHeight` ⟹ `tx.sign(operator)` ⟹ `signature = base58Encode(tx.signature)`.
6. **`recordSignedIntent(intentId, signature, lastValidBlockHeight)`**.
   - `applied` ⟹ seguir.
   - `signature_collision` (23505) ⟹ volver al paso 5 con blockhash fresco, hasta
     `SOLANA_SETTLE_SIGN_MAX_ATTEMPTS` (3); agotado ⟹ throw (AC-9).
   - cualquier otra cosa ⟹ **throw sin transmitir** (AC-1/AC-4).
7. **`sendRawTransaction(tx.serialize())`** ⟹ `confirmTransaction({signature, blockhash, lastValidBlockHeight})`.
   Si lanza ⟹ `recoverConfirmedSettle` (WKH-235a, conservado; ahora con la ventaja de que la
   firma **ya está persistida**).
8. `recordConfirmedIntent(intentId, signature)` ⟹ `log.info` ⟹ `return {txHash: signature, success: true}`.

### 4.5 Flujos de error

| Situación | Respuesta del sistema | AC |
|---|---|---|
| Preflight de esquema negativo | `log.error` con el motivo discriminado (`table_missing` / `rpc_missing` / `probe_failed`) + throw. **Nunca** fallback in-memory | AC-11 |
| `claim` ⟹ `store_unavailable` (cliente nulo, error de red, error de Postgres no-23505) | `log.error` sin PII (sólo `intentId`, `caip2`, `code`) + throw. **No se transmite** | AC-4 |
| `claim` ⟹ `in_progress` | `log.warn` + throw `SETTLE_IN_PROGRESS`. `settleSolanaLeg` lo captura y devuelve `null` con `code: 'SETTLE_FAILED'` ⟹ el leg no se cobra ni se paga | AC-2 |
| `claim` ⟹ `terms_conflict` | `log.error` con los términos **esperados vs recibidos** (montos como string, nunca `Number()`) + throw `SETTLE_INTENT_CONFLICT`. Sin transmitir y **sin devolver la firma previa** | AC-8 |
| `claim` ⟹ `confirmed` y `verify()` **falla** | **NO se re-broadcastea automáticamente** (cambio deliberado respecto del self-heal in-memory de hoy, `payment.ts:534-535`, que borraba la entrada y re-emitía). Con un store durable, "la firma registrada no verifica" es o bien un RPC mintiendo, o bien contabilidad corrupta: las dos exigen mirada humana, no un pago nuevo. `log.error` + throw. **Ver §7 R-3** | CD-5 |
| `claim` ⟹ `signed` y la tx **no** aparece y el blockhash **sigue vivo** | `log.warn` + throw. Es la única ventana donde el sistema dice "no sé todavía" — y "no sé" nunca autoriza pagar | AC-6 |
| `recordSigned` no aplica (`not_claimed`) | throw **antes** de `sendRawTransaction`. La transacción firmada se descarta sin transmitir | AC-1 |
| 23505 en `recordSigned` | re-firma con blockhash fresco (≤3) | AC-9 |
| `sendRawTransaction`/`confirmTransaction` lanzan | `recoverConfirmedSettle` (conservado): si la firma **está** confirmada on-chain ⟹ `recordConfirmedIntent` + éxito; si no ⟹ la fila queda en `signed` con su firma ⟹ el próximo retry aplica la fila 3 de §4.3 | AC-6 |
| `recordConfirmed` falla después de un broadcast exitoso | `log.error` **pero se devuelve éxito** (el pago ocurrió; perderlo es un bug de contabilidad, `payment.ts:650-651`). La fila queda en `signed` **con la firma correcta**, así que el retry la re-verifica y converge | AC-6 |
| `intentId` ausente/vacío en `settleSolanaLeg` | `return null` con `code: 'MISSING_INTENT_ID'`, sin tocar la red | DT-9 |

### 4.6 Qué pasa con las entradas del `Map` al deployar (Missing Input #4 — RESUELTO)

**El análisis del Analyst se CONFIRMA, con una precisión que faltaba.**

Verificado en código: `composeRunId = randomUUID()` (`src/services/compose.ts:182`) se genera
**por ejecución**, y el `intentId` es `` `${composeRunId}:${i}` `` (`:392`, `:672`). Un UUID v4
fresco por run ⟹ **ninguna ejecución futura vuelve a preguntar por un `intentId` viejo** ⟹ no
hay datos que migrar y perder el `Map` no puede causar un doble pago de un run **terminado**.

La precisión que faltaba (y que el work-item pedía verificar, no asumir): la afirmación
depende de que **todos** los call-sites pasen ese `intentId`. Verificado con grep exhaustivo:
`signAndSettleDownstream` tiene un único caller (`compose.ts:1407`, dentro de `invokeAgent`),
y `invokeAgent` tiene exactamente **dos** call-sites de producción (`:387`, `:667`), ambos con
el `intentId` derivado del UUID. **El fallback `` `${agent.slug}:${payTo}` `` de
`downstream-payment.ts:325` es hoy inalcanzable** — y por eso DT-9 lo elimina antes de que un
store durable lo vuelva catastrófico.

**Riesgo residual, acotado y declarado**: un compose-run que esté **exactamente** a mitad de
un settle Solana durante el restart del deploy de esta HU. Es una instancia única del mismo
problema que la HU corrige, no un caso nuevo. Mitigación operativa (no de código): deployar
con `SOLANA_ADAPTER_ENABLED=false` o fuera de una ventana de tráfico Solana. Se anota en el
Story File como paso de release, no como código.

### 4.7 Retención e inventario operativo

Sin job de limpieza (DT-5). Dos consultas para el operador, que van en el header del `.sql`:

```sql
-- Reclamos posiblemente trabados (firmados y sin confirmar hace más de 15 min)
SELECT intent_id, status, settle_signature, attempts, claimed_at, signed_at
  FROM public.a2a_solana_settle_intents
 WHERE status <> 'confirmed' AND claimed_at < now() - INTERVAL '15 minutes'
 ORDER BY claimed_at;

-- Intents que necesitaron re-firma (síntoma de colisión de firma o de blockhash expirado)
SELECT intent_id, attempts, cardinality(expired_signatures) AS expiradas
  FROM public.a2a_solana_settle_intents
 WHERE attempts > 1 OR cardinality(expired_signatures) > 0;
```

---

## 5. Plan de verificación

### 5.0 Principio rector (de HU-202 §4 y del auto-blindaje de HU-202/208)

Todo test de esta HU mide **el efecto sobre la plata**, no el mecanismo. La pregunta que
responde cada aserción es *¿salió un `sendRawTransaction`?* / *¿cuántos?* / *¿con qué monto y
a qué destino?*, **nunca** *¿se llamó a tal función interna?* ni *¿existe tal variable?*. Un
AC que se satisface por construcción no mide nada (auto-blindaje HU-202 22:00, demostrado con
una mutación stealth que quedó verde).

**El contador de broadcasts es la unidad de medida.** El doble de `Connection` lleva
`sendRawTransaction: vi.fn()`; casi toda aserción de esta HU termina en
`expect(mockSendRaw).toHaveBeenCalledTimes(N)` con `N ∈ {0,1}`.

### 5.1 Al menos un test por AC (todos miden dinero)

| AC | Test | Archivo | Qué mide (efecto, no mecanismo) |
|---|---|---|---|
| **AC-1** | `T-IDM-01` | `intent-dedup.test.ts` | Con el reclamo rechazado por la DB, `sendRawTransaction` se llamó **0 veces** y `settle()` rechazó. Y en el camino feliz: el `rpc('claim_solana_settle_intent')` ocurrió **antes** del primer `sendRawTransaction` (orden por `mock.invocationCallOrder`) |
| **AC-2** | `T-IDM-02` | `intent-dedup.test.ts` | Dos `settle()` **concurrentes** (`Promise.allSettled`) sobre el mismo `intentId`, contra un doble de DB con **PK real emulada** (un `Map` interno que rechaza el 2º INSERT): `sendRawTransaction` se llamó **exactamente 1 vez**; la perdedora rechazó y **no** devolvió `success:true` |
| **AC-3** | `T-IDM-03` | `intent-dedup.test.ts` | Fila `confirmed` con firma + `verify()` válido ⟹ `settle()` devuelve **esa** firma, `sendRawTransaction` **0 veces**, y `getParsedTransaction` **se llamó** (la firma no se devolvió sin re-verificar) |
| **AC-4** | `T-IDM-04` | `intent-dedup.test.ts` | Tres modos de indisponibilidad (rpc lanza · rpc devuelve `error` · `data` vacío): en los tres, `sendRawTransaction` **0 veces**. **Ningún camino** devuelve `success:true` |
| **AC-5** | `T-IDM-05` | `intent-dedup.test.ts` | Simula el reinicio: se construye una instancia **nueva** de `SolanaPaymentAdapter` tras `_resetSolanaClients()` (sin ningún estado en memoria) y con la fila `confirmed` ya en el doble de DB ⟹ devuelve la firma previa, `sendRawTransaction` **0 veces**. **Éste es el test que canda el motivo de existir de la HU** |
| **AC-6** | `T-IDM-06` (a/b/c) | `intent-dedup.test.ts` | (a) fila `signed` + tx **confirmada** on-chain ⟹ devuelve la firma, 0 broadcasts, y la fila pasa a `confirmed`; (b) fila `signed` + tx no confirmada + `getBlockHeight() > last_valid_block_height` ⟹ re-firma y **exactamente 1** broadcast nuevo, con la firma vieja archivada; (c) fila `signed` + tx no confirmada + blockhash **vivo** ⟹ **0** broadcasts y rechazo |
| **AC-7** | `T-MIG-14` + el applier | `wkh307-...migration.test.ts` + `scripts/apply-wkh307-migration.mjs` | El script **hardcodea** el ref de bdwv, **aborta** si resuelve al de caldz, e identifica las keys por el claim `ref` del JWT. El test afirma que el literal de caldz aparece **sólo** en el guard de abort |
| **AC-8** | `T-IDM-07` | `intent-dedup.test.ts` | Fila `confirmed` para `payTo=A, amount=3000000`; llega `settle()` con `payTo=B` ⟹ **0** broadcasts **y** el retorno **no** contiene la firma de A. Ídem con `amountAtomic` distinto y con `mint` distinto (3 casos) |
| **AC-9** | `T-IDM-08` | `intent-dedup.test.ts` | El doble de DB emula el `UNIQUE(settle_signature)`: el 1er `recordSigned` con la firma S pasa, el 2º (otro `intentId`) devuelve 23505 ⟹ el adapter **re-firma** con blockhash fresco y el broadcast sale con una firma **distinta**; y **nunca** dos filas terminan con la misma `settle_signature`. Caso límite: agotados los 3 intentos ⟹ **0** broadcasts |
| **AC-10** | `T-IDM-09` + `T-MIG-08` | `intent-dedup.test.ts` + migration test | Fila `claimed` **fuera** del lease ⟹ el reclamo lo toma y sale **1** broadcast (no queda trabada). Fila `claimed` **dentro** del lease ⟹ **0** broadcasts. `T-MIG-08` **evalúa el predicado extraído del `.sql`** (no lo re-implementa) sobre la tabla de verdad de las dos direcciones |
| **AC-11** | `T-IDM-10` | `intent-dedup.test.ts` | Con el preflight devolviendo veredicto negativo: `sendRawTransaction` **0 veces**, y `settle()` rechaza con el código de esquema. Segundo caso: el preflight **no** se consulta una vez por request (memoización) — se afirma el **costo** (`rpc` de probe llamado **1** vez en 3 `settle()`), no sólo el efecto (lección HU-208 M5) |

### 5.2 Tests del orden persist→broadcast (`payment.test.ts`, T-PAY-*)

| Test | Qué canda |
|---|---|
| `T-PAY-01` | `record_solana_settle_signed` ocurre **antes** de `sendRawTransaction` (`invocationCallOrder`), y la firma persistida es **exactamente** la que después se transmite (`base58Encode(tx.signature)` == arg de `recordSigned` == retorno de `settle()`) |
| `T-PAY-02` | Si `recordSigned` no aplica, `sendRawTransaction` se llamó **0 veces** (invariante I2 en su forma falsable) |
| `T-PAY-03` | El `feePayer` y el `recentBlockhash` se setean **antes** de `tx.sign`, y `confirmTransaction` recibe el **mismo** `blockhash`/`lastValidBlockHeight` que se persistió |
| `T-PAY-04` | `sendAndConfirmTransaction` **ya no se importa ni se invoca** (regresión de DT-6): el doble de ese símbolo registra **0** llamadas en todos los caminos |
| `T-PAY-05` | No-regresión de `verify()`: monto/mint/destino se siguen validando con `pre/postTokenBalances` y `delta < required` sigue devolviendo `valid:false` (cuerpo intocado) |
| `T-PAY-06` | No-regresión de `recoverConfirmedSettle`: `sendRawTransaction` lanza + firma confirmada on-chain ⟹ éxito, **0** re-broadcasts, y la fila queda `confirmed` |

### 5.3 Tests del módulo nuevo (`settle-ledger.test.ts`, T-LDG-*)

| Test | Qué canda |
|---|---|
| `T-LDG-01..05` | Un test por `outcome` del reclamo (`claimed`/`in_progress`/`signed`/`confirmed`/`terms_conflict`): el resultado discriminado es el correcto y **ninguno** de los cuatro no-`claimed` puede confundirse con autorización |
| `T-LDG-06` | Cliente/RPC que lanza ⟹ `{ok:false, reason:'store_unavailable'}`. **Nunca** `{ok:true}` |
| `T-LDG-07` | `error` de Postgres no-23505 ⟹ `store_unavailable` (**no** "no existe") |
| `T-LDG-08` | 23505 en `recordSigned` ⟹ `signature_collision` (código propio, distinguible de `not_claimed`) |
| `T-LDG-09` | `data` vacío / forma inesperada / `applied: undefined` ⟹ **no confirmado** (lección HU-202: `undefined` nunca se lee como éxito) |
| `T-LDG-10` | Los montos viajan como **string** en los args del RPC y en el retorno; **cero** `Number()`/`parseFloat` sobre `amount_atomic` (convención WKH-196) |
| `T-LDG-11` | Los logs no llevan PII ni secretos: sólo `intentId`, `caip2`, `code`, `attempts`. **Nunca** `pay_to` completo en un log de nivel `info` |
| `T-LDG-12` | **El doble de `supabase.rpc` CAPTURA sus argumentos y el test afirma sobre ellos** (CD-9): `p_intent_id`, `p_pay_to`, `p_amount_atomic`, `p_mint`, `p_lease_ms` llegan con los valores esperados. Sin esto, cualquier mutación de los args sobrevive (es el bug que HU-202 pagó **tres** veces) |
| `T-LDG-13` | **Ningún camino devuelve `outcome:'claimed'` sin que el RPC de reclamo haya devuelto fila** (la aclaración anti-falso-positivo de DT-2) |

### 5.4 Destino de la batería existente `intent-dedup.test.ts` (791 líneas)

El archivo se **reescribe**. Se declara test por grupo qué pasa y por qué, para que la
desaparición de ~40 tests sea una decisión auditable y no una pérdida silenciosa:

| Grupo actual | Destino | Justificación |
|---|---|---|
| `T-TTL-1..6` (expiración por TTL) | **Eliminados** | Candan `resolveIntentTtlMs`, que DT-5 elimina. Un test de una política borrada no puede sobrevivir a la política |
| `T-CAP-1..7` (cap soft, ventana protegida, borde exacto) | **Eliminados** | Ídem (`evictIntentSignatures`, `resolveProtectedWindowMs`) |
| `T-CLOCK-*` (reloj inyectable `_setIntentDedupClock`) | **Eliminados** | El reloj pasa a ser el de **Postgres** (DT-12). No hay reloj de proceso que inyectar |
| `T-POLICY-*` (`_intentDedupPolicy`) | **Eliminados** | La política que exponían no existe |
| Idempotent-hit + self-heal (`:548-680`) | **Migrados** a `T-IDM-03`, `T-IDM-06`, `T-IDM-07` | La **propiedad** (no re-broadcastear un intent ya pagado; verify-before-trust) sobrevive intacta; cambia el almacén |
| `getSettledSignature` (`:185-300` disperso) | **Migrados** a `T-IDM-11` | Ahora `async` y con unión discriminada (DT-8) |

**Efecto sobre el baseline**: se retiran ~40 tests y se agregan ~55. El conteo final **no** va
a ser `3996 + N`; el reporte de F3 debe declarar el delta neto y el motivo, no presentarlo
como una regresión ni esconderlo.

### 5.5 Campaña de mutación — 15 mutantes, cada uno con su test asesino

**Reglas de la campaña** (heredadas de HU-202 §6 y su auto-blindaje):

- **Todo mutante debe COMPILAR** (`npx tsc --noEmit` limpio, o `.sql` sintácticamente válido)
  antes de contarse. Un mutante que no compila no prueba nada: el compilador lo cazó, no el
  test.
- Cada mutante se ancla **por número de línea** cuando el patrón aparece más de una vez.
- **La evidencia de reversión es el `sha256sum`**, no el `git status`: esta HU crea 2 `.sql`,
  1 `.mjs` y 2 `.ts` **untracked**, y `git checkout --` no los revierte (auto-blindaje HU-202
  11:05). Se guarda copia antes de empezar y se compara el listado de hashes al final.
- **Un mutante que sobrevive es un hallazgo**, no una anécdota: se documenta y se agrega el
  test que lo caza (HU-208 M5).

| # | Mutante (compila) | Archivo:zona | Test asesino |
|---|---|---|---|
| **M1** | `if (claim.outcome !== 'claimed')` → `if (false)` — se transmite sin reclamo | `payment.ts` §4.4 paso 3 | `T-IDM-01`, `T-IDM-02`, `T-IDM-04` |
| **M2** | Variante sutil de M1: `if (claim.outcome !== 'claimed' && false)` | ídem | `T-IDM-01`, `T-IDM-02` |
| **M3** | Se mueve el `claim` **después** de construir y firmar la tx (sigue antes del broadcast) | `payment.ts` §4.4 | `T-IDM-01` (orden por `invocationCallOrder`) |
| **M4** | `store_unavailable` se trata como "no existe" ⟹ se reclama igual y se transmite | `settle-ledger.ts` | `T-IDM-04`, `T-LDG-06`, `T-LDG-07` |
| **M5** | `applied !== true` → `applied === false` (un `undefined` pasa como éxito) | `settle-ledger.ts` | `T-LDG-09` |
| **M6** | **`recordSigned` se mueve DESPUÉS de `sendRawTransaction`** (rompe I2) | `payment.ts` §4.4 pasos 6↔7 | `T-PAY-01`, `T-PAY-02` |
| **M7** | Se ignora el resultado de `recordSigned` y se transmite igual | `payment.ts` | `T-PAY-02`, `T-IDM-01` |
| **M8** | El `terms_conflict` devuelve la firma previa en vez de rechazar | `payment.ts` §4.5 | `T-IDM-07` (los 3 casos) |
| **M9** | El estado `confirmed` devuelve la firma **sin** llamar a `verify()` | `payment.ts` §4.3 | `T-IDM-03` (afirma que `getParsedTransaction` se llamó) |
| **M10** | El estado `signed` re-firma y re-transmite **sin** chequear el block height | `payment.ts` §4.3 fila 3 | `T-IDM-06c` (blockhash vivo ⟹ 0 broadcasts) |
| **M11** | El 23505 de `recordSigned` se traga y se transmite igual | `settle-ledger.ts` / `payment.ts` | `T-IDM-08`, `T-LDG-08` |
| **M12** | En el `.sql`: se borra `AND t.claimed_at < now() - make_interval(...)` del `ON CONFLICT DO UPDATE` (el lease deja de existir ⟹ cualquier retry roba el reclamo) | migración, `claim_solana_settle_intent` | `T-MIG-08` (**evalúa** el predicado extraído, no lo re-implementa) |
| **M13** | En el `.sql`: se borran los tres `AND t.<término> = EXCLUDED.<término>` (AC-8 desaparece) | migración | `T-MIG-09` |
| **M14** | En el `.sql`: el índice `UNIQUE` sobre `settle_signature` se crea **sin** `UNIQUE` (AC-9 desaparece) | migración | `T-MIG-10` |
| **M15** | En el `.sql` `_down`: `DROP TABLE` en vez de renombrar (destruye la evidencia de qué se pagó) | migración `_down` | `T-MIG-13` |

**Límite declarado del método** (obligatorio, como en HU-202 §7): los tests de servicio corren
contra un **doble** de `supabase.rpc`, no contra Postgres. La correspondencia doble↔SQL queda
candada por `T-MIG-08/09/10`, que **extraen** el predicado del `.sql` y lo **evalúan**. Una
mutación que cambie **el `.sql` y el doble a la vez** no se detecta: eso lo cerraría un
Postgres efímero (que este repo no tiene) o el applier leyendo `pg_get_functiondef` — que **sí
corre**, en W4, contra bdwv.

### 5.6 Gates

- `npx tsc --noEmit` **completo** (no sólo `npm run build`: `tsconfig.build.json` excluye
  tests — lección de WKH-196).
- `npm run lint` (`biome check src/`).
- `npm test` (`vitest run`). Baseline **3996 passed | 19 skipped** + el delta declarado en
  §5.4.
- `npm run migrate:preflight` antes del apply.

---

## 6. Scope

### IN

1. Migración SQL nueva (up + down) con la tabla, los índices y las 4 funciones de transición
   atómica. **Aplicada SOLO a bdwv** (AC-7 / CD-4).
2. `src/adapters/solana/settle-ledger.ts` — el seam durable (único acceso a DB del adapter).
3. `src/adapters/solana/schema-preflight.ts` — el gate ejecutable de AC-11.
4. `src/adapters/solana/payment.ts` — reemplazo del `Map` por el ledger; máquina de estados;
   firma explícita + `sendRawTransaction`/`confirmTransaction` (DT-6); `getSettledSignature`
   async y discriminado; **eliminación** de TTL/cap/ventana/reloj (DT-5).
5. `src/adapters/types.ts`, `src/lib/downstream-payment.ts`, `src/lib/downstream-skip-code.ts`,
   `src/index.ts`, `src/types/database.types.ts`, `.env.example` — los cambios de contrato y
   cableado que 4 arrastra.
6. `scripts/apply-wkh307-migration.mjs` — applier bdwv-only con guard anti-caldz y post-estado
   leído del catálogo.
7. Tests: `settle-ledger.test.ts` (nuevo), `intent-dedup.test.ts` (reescrito),
   `payment.test.ts`, `settle-wiring.test.ts`, `downstream-payment.test.ts`,
   `test/wkh307-solana-settle-intents.migration.test.ts` (nuevo).
8. Campaña de mutación de §5.5 y su evidencia.

### OUT

- **WKH-302** (mudar el broadcast al facilitator). Este diseño es compatible (§3.3) pero **no
  la implementa**. No se agrega la bandera `SOLANA_SETTLE_VIA_FACILITATOR`.
- **`wasiai-facilitator`**: sólo lectura. Ningún archivo de ese repo se modifica (CD-3).
- **`facilitator_solana_settlements`**: ni se lee ni se escribe desde este repo (CD-3).
- **Aplicar la migración a `caldz`** — founder-gated, **WKH-307b** (§11).
- **Dedup cross-caller** (`x-idempotency-key` HTTP + `settle_intent_id` en `a2a_receipts` +
  reintentador del lado del caller de `/compose`) — es el problema de arriba, diferido a
  propósito por WKH-235a. Esta HU resuelve la capa de abajo.
- **Política de retención / job de limpieza** de la tabla nueva (DT-5: no hace falta hoy).
- **Instrucción Memo con el `intentId`** (alternativa rechazada en DT-10).
- **Camino EVM**: `src/adapters/avalanche|base|tempo|kite-ozone/**` queda **byte-idéntico**.
- **Mainnet Solana**: la cadena sigue siendo devnet-only (`chain.ts:31-37`, CD-4 de WKH-234).
- El `verify()` con `commitment: 'confirmed'` hardcodeado (`payment.ts:674`) y su nota
  "REVISAR antes de mainnet" — deuda preexistente de WKH-234/235a, **no** se toca acá.

---

## 7. Riesgos

| # | Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|---|
| **R-1** | Se reescribe el primitivo de broadcast del money-path (DT-6) y aparece un bug de construcción de la tx (feePayer/blockhash/serialización) | M | **A** | Devnet-only por construcción. `T-PAY-01..04` fijan el orden y la identidad de la firma. `verify()` y `recoverConfirmedSettle` intactos siguen siendo la validación de verdad. El e2e manual de devnet (`src/adapters/solana/devnet-e2e.manual.test.ts`, gated por `SOLANA_DEVNET_E2E=1`) se corre a mano antes del merge |
| **R-2** | Fail-closed convierte un problema de DB en "el agente no cobra" | **A** | M | **Aceptado a propósito**: un agente sin cobrar es recuperable (retry, reconciliación); un agente cobrado dos veces no. El preflight (AC-11) hace que el motivo sea ruidoso y diagnosticable en vez de un `SETTLE_FAILED` genérico |
| **R-3** | **Cambio de conducta declarado**: hoy, si la firma registrada no verifica, el adapter borra la entrada y **re-broadcastea** (`payment.ts:534-535`). Esta HU deja de hacerlo | M | M | Es deliberado y es el punto de la HU: con un store durable, "la firma registrada no verifica" es o un RPC mintiendo o contabilidad corrupta, y ninguna de las dos se arregla pagando de nuevo. El caso legítimo que el self-heal cubría (una tx que nunca aterrizó) queda cubierto **mejor** por la rama `signed` + block height expirado, que es una **prueba** en vez de una inferencia. Debe quedar explícito en el done-report para que no se lea como regresión |
| **R-4** | Los dobles de test se vuelven más complejos (`Connection` necesita `getLatestBlockhash`, `sendRawTransaction`, `confirmTransaction`, `isBlockhashValid`/`getBlockHeight`) y un doble mal hecho vuelve la batería vacua | **A** | A | CD-9 + `T-LDG-12` (el doble captura y el test afirma sobre los args) + la campaña de mutación, que es el único juez de si un test canda algo |
| **R-5** | Se eliminan ~40 tests existentes (§5.4) y alguien lo lee como pérdida de cobertura | M | B | Tabla de destino test por test en §5.4 + declaración del delta neto en el done-report |
| **R-6** | La estimación del work-item (M) subestima: AC-6 obliga a DT-6, que no estaba dimensionado | **A** (ya materializado) | M | Se revisa a **L** en §2 y se declara acá. No se recorta el alcance: AC-6 sin DT-6 sólo se puede satisfacer con un estado terminal que traba la plata, que AC-10 y R2 de WKH-302 prohíben |
| **R-7** | `tx.sign()` con el doble de keypair actual (`secretKey: new Uint8Array(64)`, `payment.test.ts:35`) podría comportarse distinto que en producción | B | M | W2 verifica en el primer test que `tx.signature` queda poblado y que `base58Encode` lo acepta; si no, el doble pasa a un `Keypair.generate()` real (sin red, es sólo criptografía local) |

---

## 8. Constraint Directives (Anti-Alucinación)

CD-1..CD-6 se heredan **verbatim** del work-item. CD-7..CD-15 los agrega F2 (CD-9/CD-10/CD-11
vienen del Auto-Blindaje histórico, §3.4).

### PROHIBIDO

- **CD-1**: PROHIBIDO implementar la idempotencia como lectura-y-luego-escritura. OBLIGATORIO
  una escritura condicional atómica que devuelva si aplicó en la **misma** operación.
- **CD-2**: PROHIBIDO cualquier fallback que trate "no sé si ya se pagó" como "no se pagó,
  adelante". OBLIGATORIO fail-closed.
- **CD-3**: PROHIBIDO modificar código o esquema de `wasiai-facilitator`. PROHIBIDO que
  `wasiai-a2a` lea o escriba `facilitator_solana_settlements`.
- **CD-4**: PROHIBIDO aplicar la migración contra **caldz**. OBLIGATORIO el guard anti-caldz
  del applier (ref hardcodeado + abort + identificación de la key por el claim `ref` del JWT,
  **nunca** por el nombre de la variable).
- **CD-5**: PROHIBIDO devolver una firma leída del store sin re-verificarla on-chain con
  `verify()`.
- **CD-6**: PROHIBIDO tocar `contracts/.gas-snapshot`,
  `doc/audit/2026-06-28-best-practices-audit.md`, los `doc/jury-qa*.md`, y
  `doc/sdd/118-wkh-sec-02b-owner-ref-rpc/`. **PROHIBIDO tocar `doc/sdd/_INDEX.md`** en esta
  fase.
- **CD-7**: PROHIBIDO que cualquier archivo de `src/adapters/solana/**` **salvo
  `settle-ledger.ts` y `schema-preflight.ts`** importe `../../lib/supabase.js`. En particular,
  `payment.ts` importa el seam, nunca el cliente (DT-7).
- **CD-8**: PROHIBIDO `Number()`, `parseFloat`, `+` unario o aritmética de coma flotante sobre
  `amount_atomic` / `last_valid_block_height`. Los montos viajan como **string** y se comparan
  como `BigInt`. Columnas anchas se leen con `::text` (convención WKH-196).
- **CD-9** *(Auto-Blindaje)*: PROHIBIDO un doble de test que descarte los argumentos que
  recibe o que declare un tipo de retorno más pobre que el de la función real. OBLIGATORIO
  que el doble de `supabase.rpc` **capture** sus args y que al menos un test **afirme sobre
  ellos**. *(HU-202 pagó este mismo error tres veces; dos mutaciones sobrevivieron por él.)*
- **CD-10** *(Auto-Blindaje)*: PROHIBIDO asertar sobre el mecanismo (`toHaveBeenCalledWith` de
  un estado intermedio, existencia de una variable, re-implementación en JS del predicado
  SQL). OBLIGATORIO asertar el **efecto sobre la plata** (cuántos broadcasts, con qué monto, a
  qué destino) y, cuando se afirme "no agrega costo", asertar el **costo** (número de llamadas
  de I/O). Para el SQL: **extraer y evaluar** el predicado del `.sql`, nunca reescribirlo.
- **CD-11** *(Auto-Blindaje)*: PROHIBIDO un `boolean` como retorno de cualquier función de
  este seam. OBLIGATORIO uniones discriminadas que separen "aplicó" / "el guard lo rechazó" /
  "la escritura falló" / "el store no está", porque el remedio de cada una es distinto.
- **CD-12**: PROHIBIDO `SELECT` + `INSERT`/`UPDATE` en pasos separados para decidir si se
  transmite (es CD-1 en su forma SQL). El único `SELECT` permitido es el de **clasificación
  posterior** a un upsert condicional que ya devolvió 0 filas, y **no puede** producir
  `outcome:'claimed'` (candado: `T-LDG-13`).
- **CD-13**: PROHIBIDO conservar o reintroducir TTL, cap, ventana protegida, desalojo o reloj
  inyectable para el seam de idempotencia (DT-5). PROHIBIDO que `SOLANA_INTENT_DEDUP_TTL_MS` o
  `SOLANA_INTENT_DEDUP_MAX_ENTRIES` sigan siendo leídas por el código.
- **CD-14** *(coordinación con WKH-302, R1)*: PROHIBIDO ubicar el reclamo dentro de una rama
  condicional del transporte. El reclamo es la **primera** operación de `settle()` tras el
  preflight, y cualquier ramificación futura por `SOLANA_SETTLE_VIA_FACILITATOR` va
  **después**.
- **CD-15**: PROHIBIDO loguear `SOLANA_OPERATOR_PRIVATE_KEY`, el `secretKey` del `Keypair`, o
  el `payTo` completo en logs de nivel `info` (CD-3 de WKH-234). Sólo `intentId`, `caip2`,
  `code`, `attempts`, y la firma (que es pública).

### OBLIGATORIO seguir

- Los exemplars de §3.6, **todos verificados en disco**. Ningún path, función o API se usa sin
  haber sido confirmado con `Read`/`Grep`.
- Stack no negociable: TypeScript strict (sin `any` explícito), vitest, biome, supabase-js,
  `@solana/web3.js` v1.98.4 ya instalado. **PROHIBIDO agregar dependencias nuevas.**
- Convenciones de los tests Solana existentes: `(..._a: unknown[])` en los `vi.fn` (CD-11 de
  WKH-234, evita TS2556) y accesos a `mock.calls[N]` guardados (`noUncheckedIndexedAccess`).
- `npx tsc --noEmit` **completo**, no sólo `npm run build`.

---

## 9. Missing Inputs — los 4 del work-item, RESUELTOS

| # | Pendiente del work-item | Estado | Resolución |
|---|---|---|---|
| 1 | No se encontraba el work-item/SDD de WKH-302; DT-3 quedaba sin confirmar | **RESUELTO** | Está en `wasiai-facilitator/doc/sdd/031-wkh-302-solana-facilitator-signed-settle/sdd.md` (leído completo). Su §DT-5 **confirma explícitamente** el DT-3 de esta HU y declara que su diseño **no obliga a mover el reclamo**. Ver §3.3, incluidos los dos requisitos R1/R2 que nos pide y que este SDD cumple |
| 2 | Esquema: tabla nueva vs. extender `a2a_receipts` | **RESUELTO** | Tabla nueva `a2a_solana_settle_intents` — DT-4, con las 4 razones |
| 3 | ¿Necesita TTL / job de limpieza? | **RESUELTO** | **No.** DT-5: toda la maquinaria de retención se elimina porque existía para acotar memoria de proceso y era un riesgo de doble pago. Se conserva únicamente el **lease** de `claimed`, que no es un TTL (es seguro por demostración, no por tiempo) |
| 4 | ¿Hay que migrar las entradas del `Map`? | **RESUELTO** | **No.** Confirmado en código (§4.6): `composeRunId = randomUUID()` por ejecución + los dos únicos call-sites pasan el `intentId`. Además se descubrió el fallback `` `${agent.slug}:${payTo}` `` que un store durable volvería catastrófico ⟹ se elimina (DT-9). Riesgo residual acotado y declarado (run a mitad de camino durante el restart del deploy), con mitigación operativa |

**No queda ningún `[NEEDS CLARIFICATION]`.** Un `[TBD]` no bloqueante: el valor exacto de
`SOLANA_SETTLE_LEDGER_LEASE_MS` (propuesto **120 000 ms**, alineado con el
`PAYOUT_LEASE_MS = 120 s` de WKH-302 §DT-9, para que las dos capas no se peleen). Es un knob
por env con default documentado; W1 puede ajustarlo sin re-abrir F2.

---

## 10. Waves de implementación

### W0 — Serial gate (contratos y esquema; nadie más puede empezar antes)

- **W0.1** — `supabase/migrations/20260730000000_wkh307_solana_settle_intents.sql`: tabla,
  índices (PK, `UNIQUE` parcial sobre `settle_signature`, índice de inventario), las 4
  funciones con **firma y retorno estables**, GRANTs, `COMMENT ON`, cabecera con el gate de
  orden de release y las consultas de inventario (§4.7). Exemplar: `20260729000000_hu202_*.sql`.
- **W0.2** — `..._down.sql`: `DROP FUNCTION`/`DROP INDEX` + **RENAME** de la tabla (nunca
  `DROP TABLE`).
- **W0.3** — `src/types/database.types.ts`: entrada de la tabla + firmas de las 4 funciones.
  Exemplar: `a2a_refund_outbox:1048-1090`.
- **W0.4** — Tipos públicos del seam en `src/adapters/solana/settle-ledger.ts` (**sólo tipos y
  firmas, sin lógica**): `ClaimOutcome`, `ClaimResult`, `WriteResult`, `SettleIntentRow`. Es lo
  que desbloquea W1 y W2 en paralelo.
- **W0.5** — `scripts/apply-wkh307-migration.mjs`. Exemplar: `apply-hu202-migration.mjs`.
- **Verificación W0**: `npx tsc --noEmit` limpio. **No se aplica nada a ninguna base todavía.**

### W1 — Paralelizable (implementación del seam)

- **W1.1** — `settle-ledger.ts`: implementación de las 5 funciones sobre `supabase.rpc(...)`,
  resultados discriminados, fail-closed, logs sin PII. → Exemplar:
  `solana-escrow-release-dedup.ts` + `debit-executor.ts:299-370`.
- **W1.2** — `schema-preflight.ts`: probe + memoización + veredicto discriminado +
  `warmSolanaSchemaPreflight()` + `_resetSolanaSchemaPreflight()` TEST-ONLY. → Exemplar:
  `escrow/schema-preflight.ts`.
- **Verificación W1**: `tsc` + los tests de W3.1 que ya se puedan correr.

### W2 — Depende de W0 + W1 (rewiring del adapter)

- **W2.1** — `payment.ts`: **borrar** el bloque `:60-358` (Map, TTL, cap, ventana, reloj,
  evict) y `:714-781` (TEST-ONLY de esa política); `settle()` pasa a §4.4; `getSettledSignature`
  async y discriminado; `recoverConfirmedSettle` y `verify` **conservados**.
- **W2.2** — `src/adapters/types.ts` (`SettledPeek`), `src/lib/downstream-payment.ts` (`await`
  + mapeo de DT-8 + **eliminación del fallback de `intentId`**, DT-9),
  `src/lib/downstream-skip-code.ts` (2 códigos nuevos).
- **W2.3** — `src/index.ts` (warm-up) + `.env.example` (2 altas, 2 bajas con nota).
- **Verificación W2**: `tsc` + `lint` + suite completa en verde.

### W3 — Tests (paralelizable por archivo)

- **W3.1** — `settle-ledger.test.ts` (T-LDG-01..13).
- **W3.2** — `intent-dedup.test.ts` reescrito (T-IDM-01..11) — incluye la tabla de destino de
  §5.4 como comentario de cabecera, para que la eliminación quede documentada en el propio
  archivo.
- **W3.3** — `payment.test.ts` (T-PAY-01..06) + dobles nuevos de `Connection`.
- **W3.4** — `test/wkh307-solana-settle-intents.migration.test.ts` (T-MIG-01..14) con
  `code()`/`fnBody()`/`extractGuardClause()`/`evalSqlPredicate()`.
- **W3.5** — `downstream-payment.test.ts` + `settle-wiring.test.ts` (ajustes de doble).
- **Verificación W3**: suite completa + delta de conteo declarado.

### W4 — Verificación dura (serial, al final)

- **W4.1** — Campaña de mutación de §5.5: 15 mutantes, cada uno **compilando**, con
  `sha256sum` antes/mutado/restaurado y `diff` final del listado de hashes.
- **W4.2** — `npm run migrate:preflight` + `node scripts/apply-wkh307-migration.mjs`
  **contra bdwv exclusivamente**, con post-estado **leído del catálogo**
  (`information_schema.columns`, `pg_indexes`, `pg_get_functiondef` de las 4 funciones).
- **W4.3** — E2E manual opcional de devnet (`SOLANA_DEVNET_E2E=1`), si hay operador fondeado.
- **W4.4** — `auto-blindaje.md` de esta HU + done-report con: delta de tests, R-3 declarado
  como cambio de conducta, y el work-item de **WKH-307b** creado.

| Wave | Depende de | Motivo |
|---|---|---|
| W1 | W0.4 | Necesita los tipos del seam |
| W2 | W0.3, W0.4, W1.1, W1.2 | Necesita el seam y el preflight implementados |
| W3 | W2 | Los tests miden la conducta nueva |
| W4 | W3 | La mutación necesita los tests que la cazan |

---

## 11. Done Definition y follow-ups

Además de los gates de §5.6, esta HU **no está DONE** hasta que:

1. Los 15 mutantes de §5.5 estén corridos, **todos compilando**, con su veredicto documentado.
   Un sobreviviente sin test nuevo que lo cace es un hallazgo abierto, no un detalle.
2. El post-estado de bdwv esté **leído del catálogo de la base** (no asumido del exit code del
   applier) y **caldz esté intacta** (evidencia: el guard del applier abortando si el ref
   resuelve a caldz).
3. El done-report declare: el **delta neto de tests** con su motivo (§5.4), el **cambio de
   conducta R-3**, y la **revisión de sizing M → L**.
4. Exista el work-item de **WKH-307b** — *"aplicar la migración de WKH-307 a producción
   (caldz) y habilitar el leg Solana en prod"* — founder-gated. Mientras no exista, AC-7 deja
   una base sin esquema y el fail-closed de AC-11 es la única red: un desmantelamiento sin
   ticket es una llave dormida con otro nombre (lección DT-2 de WKH-302).
5. Se le comunique a WKH-302 el único pedido de vuelta de §3.3 (persistir `signed` con la
   firma que devuelva `POST /solana/payout` antes de tratar el leg como pagado).

---

## 12. Implementation Readiness Check

```
READINESS CHECK — WKH-307 / SDD #209
[x] Cada AC (AC-1..AC-11) tiene al menos 1 archivo asociado en la tabla 4.1 y al menos
    1 test nominado en §5.1
[x] Cada archivo de la tabla 4.1 tiene un Exemplar verificado en disco (§3.6, 8/8 leídos)
[x] No hay [NEEDS CLARIFICATION] pendientes — los 4 Missing Inputs del work-item quedan
    RESUELTOS en §9. El único [TBD] (valor del lease) es un knob por env con default
    documentado y NO bloquea
[x] Constraint Directives: 15, todas con al menos un PROHIBIDO explícito (mínimo 3)
[x] Context Map: 23 archivos leídos en este repo + 3 en wasiai-facilitator + 2 del SDK
[x] Scope IN y OUT explícitos y no ambiguos (§6)
[x] BD: estado verificado (§3.5) — `a2a_receipts`, `a2a_payment_intent_debit_signatures` y
    `a2a_signed_auth_nonces` EXISTEN; `a2a_solana_settle_intents` NO existe y la crea esta HU
[x] Happy path completo (§4.4, 8 pasos) y máquina de estados completa (§4.3, 7 situaciones)
[x] Flujo de error definido: 11 casos (§4.5)
[x] Waves con W0 serial (§10) y dependencias explícitas
[x] Mutantes especificados (15) con test asesino y requisito de compilación (§5.5)
[x] Límite del método de verificación declarado (§5.5) — no se vende una garantía que el
    repo no puede dar sin un Postgres efímero
[x] Migración: bdwv-only, con guard anti-caldz y post-estado leído del catálogo (AC-7/CD-4)
[x] Coordinación con WKH-302 verificada contra SU SDD, no supuesta (§3.3)
[x] Auto-Blindaje histórico leído (208, 202) y convertido en CD-9/CD-10/CD-11 + AC-10/AC-11
```

**Veredicto: LISTO PARA `SPEC_APPROVED`.** Cero pendientes bloqueantes.

---

*SDD generado por NexusAgil — FULL · F2 · WKH-307*
