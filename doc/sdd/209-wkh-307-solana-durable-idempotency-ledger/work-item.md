# Work Item — [WKH-307] Idempotencia del settle Solana respaldada en ledger (no en memoria)

## Resumen

El registro de "qué intentId de Solana ya se le pagó a quién" hoy vive en un `Map` in-memory
del proceso del gateway (`src/adapters/solana/payment.ts:93`, `_intentSignatures`). El propio
código lo documenta como pendiente: `// Persist-before-return del seam de idempotencia (W5 lo
respalda en ledger).` (línea 581) y `// En W3 es un store in-memory por proceso... en W5 el
almacén real es la columna settle_signature del ledger` (línea 63). W5 nunca llegó — quedó
diferido por WKH-235a (fila 185 del `_INDEX.md`, RE-SCOPE 2026-07-25) "porque hoy no existe
mecanismo que reintente settle Solana con mismo intentId". Instrucción explícita del founder:
esto deja de ser una hipótesis y pasa a ser requerimiento — "debe ser respaldado en ledger,
nada de memoria, hacemos código para producción, no para hack".

**Consecuencia real hoy**: un reinicio del proceso (deploy, restart rotativo, crash) a mitad
de un compose-run pierde la memoria de qué `intentId` ya fue pagado. Un retry post-reinicio
puede re-broadcastear un SPL transfer real → doble pago al agente Solana-native. No hay
backstop on-chain (a diferencia de EVM/EIP-3009, que tiene nonce determinístico) — la única
defensa contra el doble pago en Solana es este seam de aplicación.

Esta HU reemplaza el `Map` por un store durable en la base de datos propia de `wasiai-a2a`
(Supabase, bdwv en dev / caldz en prod — **NO** la base del facilitator, que es un proyecto
Supabase distinto), con una escritura condicional atómica (claim-antes-de-broadcastear), no
un patrón leer-y-luego-escribir.

## Sizing

- SDD_MODE: full
- Estimación: M
- Branch sugerido: `fix/209-wkh-307-solana-durable-idempotency-ledger`
- Modo: **QUALITY** — money-path (settle real de SPL en Solana, riesgo de doble pago). Sigue
  el mismo rigor que WKH-234/235a/HU-202 (mutación por cada guard, tests de las dos
  direcciones, gates tsc/lint/tests, migración solo a bdwv).

## Conclusión de coordinación con WKH-302 (leída del prompt de esta tarea; no encontré su
work-item en `doc/sdd/` ni en `BACKLOG.md` de este repo — ver Missing Inputs #1)

**No recomiendo esperar ni fusionar con WKH-302.** Recomiendo proceder ahora, con un diseño
que quede estable frente a esa migración futura. Razonamiento:

- WKH-302 (según la descripción de esta tarea) mueve **la transmisión** (el broadcast real,
  hoy `sendAndConfirmTransaction` dentro de `settle()`) del gateway al facilitator — es decir,
  cambia **qué código ejecuta el envío on-chain**, no **quién decide si hay que reenviar**.
- El punto donde hoy se sabe el `intentId` (antes de que exista ninguna firma) es el mismo
  punto, sea cual sea el ejecutor del broadcast. Si el **claim atómico del `intentId`** se hace
  en ese punto — ANTES de invocar lo que sea que haga el envío real —, el diseño no se tira
  cuando WKH-302 aterrice: solo cambia lo que hay DENTRO del bloque "broadcast" (hoy: llamada
  local a `sendAndConfirmTransaction`; después de 302: llamada HTTP al facilitator).
- Precedente directo en este mismo repo de que ese patrón (claim antes de actuar, en la base
  de quien DECIDE, no de quien EJECUTA) funciona y se mantiene estable a través de refactors:
  `doc/sdd/202-hop2-lease/work-item.md` — el lease del hop 2 se toma en `payment-intent.ts`
  (el orquestador que DECIDE reenviar), no en el facilitator (quien EJECUTA el hop 2 EVM).
- Si el Architect (F2) o el founder tienen información de WKH-302 que contradiga este supuesto
  (por ejemplo, que el facilitator también necesita conocer/reclamar el `intentId` de forma
  independiente porque puede recibir llamadas de más de un caller), **debe revisarse el DT-3
  antes de F2** — dejado explícito en Missing Inputs, no asumido en silencio.

## Acceptance Criteria (EARS)

- **AC-1** (Event-driven): WHEN `SolanaPaymentAdapter.settle()` se invoca con un `intentId`
  que no tiene registro previo en el store durable, the system SHALL reclamar ese `intentId`
  mediante una escritura condicional atómica (una sola operación de base de datos que informe
  si aplicó o no) ANTES de broadcastear cualquier transferencia on-chain.
- **AC-2** (Unwanted): IF dos invocaciones concurrentes de `settle()` llegan para el mismo
  `intentId` (dos procesos, o el mismo proceso en paralelo), THEN the system SHALL permitir que
  como máximo una de ellas broadcastee la transferencia SPL — la que pierde la carrera NUNCA
  debe emitir un segundo pago.
- **AC-3** (Event-driven): WHEN `settle()` se invoca con un `intentId` que ya tiene una firma
  confirmada registrada en el store durable, the system SHALL re-verificar esa firma on-chain
  (semántica `verify()` existente, verify-before-trust) y devolverla sin re-broadcastear —
  equivalente al `recallIntentSignature` actual, pero leyendo de un store que sobrevive al
  proceso.
- **AC-4** (State-driven): WHILE el store durable no está disponible (cliente no configurado, o
  la operación de claim/lectura falla), the system SHALL NOT broadcastear una transferencia
  nueva para un `intentId` no reclamado — fail-CLOSED, mismo patrón que
  `wasiai-facilitator/src/infra/solana-dedup.ts` (nunca fail-open hacia un posible doble pago).
- **AC-5** (Event-driven, el caso que motiva la HU): WHEN el proceso del gateway se reinicia
  después de haber registrado durablemente una firma confirmada para un `intentId`, y un caller
  reintenta `settle()` con el mismo `intentId`, the system SHALL devolver la firma previamente
  registrada (re-verificada on-chain) en vez de broadcastear de nuevo — cierra la brecha
  concreta que hoy pierde el `Map` en cada restart.
- **AC-6** (Unwanted, crash a mitad de camino): IF el proceso se cae/reinicia después de que el
  broadcast on-chain fue exitoso pero ANTES de que el resultado se haya persistido
  durablemente, THEN un retry del mismo `intentId` SHALL NOT re-broadcastear a ciegas — debe
  degradar a un estado que exija recuperación explícita (reusar `recoverConfirmedSettle` de
  WKH-235a si aplica, o quedar en un estado no-auto-reenviable, mismo principio fail-closed que
  el lease de HU-202) — el sistema NUNCA debe pagar dos veces por esta ventana.
- **AC-7** (Ubiquitous, alcance de la migración): The system SHALL aplicar la migración SQL de
  esta HU **solo** a la base de datos de desarrollo (`bdwv`). Aplicarla a producción (`caldz`)
  queda explícitamente fuera de esta HU — gate founder-aparte, mismo patrón que
  WKH-191/196/202.

## Scope IN

- `src/adapters/solana/payment.ts` — reemplazar los puntos de lectura/escritura del `Map`
  in-memory (`rememberIntentSignature`, `recallIntentSignature`, y su barrido lazy
  `evictIntentSignatures`) por llamadas a un seam de persistencia durable nuevo, preservando
  intacta la semántica de verify-before-trust y el self-heal (`recoverConfirmedSettle`,
  WKH-235a) que ya existe.
- Módulo nuevo (nombre a definir en F2, p. ej. `src/adapters/solana/settle-ledger.ts` o
  extensión de un módulo de infra existente) que exponga el claim atómico + lectura + registro
  de resultado, en el mismo espíritu que `wasiai-facilitator/src/infra/solana-dedup.ts` (fail
  cerrado, sin `Number()`/coerción de montos, sin PII en logs).
- Migración SQL nueva bajo `supabase/migrations/` (solo aplicable a bdwv en esta HU) — tabla
  dedicada o extensión de `a2a_receipts` (decisión de esquema para F2, ver DT-4 y Missing
  Inputs #2), con una función de claim atómica (patrón `INSERT ... ON CONFLICT` o función
  plpgsql tipo `UPDATE ... WHERE ... RETURNING`, mirror de
  `record_debit_settle_status`/`claim_reconciliation` de `doc/sdd/202-hop2-lease/`).
- Tests nuevos que reemplacen/extiendan `src/adapters/solana/intent-dedup.test.ts` y
  `src/adapters/solana/payment.test.ts`: el reemplazo de motor debe probarse bajo mutación
  (mismo estándar que HU-202 — cada guard de atomicidad con al menos una mutación cazada), y
  con un caso explícito de "dos claims concurrentes, gana solo uno".
- Funciones TEST-ONLY equivalentes a `_resetSolanaClients`/`_intentDedupSize`/
  `_seedIntentSignature`/`_setIntentDedupClock` (líneas 715-781 de `payment.ts`), adaptadas al
  nuevo store (o sustituidas por un mock/fixture de Supabase, según convención del repo — ver
  `intentDedupNow`/reloj inyectable, que si sigue siendo relevante para TTL debe preservarse).

## Scope OUT

- **WKH-302** en sí (mover el broadcast del gateway al facilitator) — no se toca en esta HU.
  El diseño debe ser compatible con esa migración futura (DT-3), pero implementarla es Scope
  OUT explícito.
- **`wasiai-facilitator`** — solo lectura permitida (ya usada para F0). Ningún archivo de ese
  repo se modifica.
- **`facilitator_solana_settlements`** (la tabla del facilitator, keyed por `signature`) — NO
  se reutiliza ni se muta desde `wasiai-a2a`. Resuelve un problema distinto (dedup de una firma
  ya presentada como prueba, verify-then-record de un settle que YA sucedió) mientras que esta
  HU necesita reservar un `intentId` ANTES de que exista firma (claim-before-broadcast). Son
  bases de datos Supabase distintas (proyectos separados, confirmado leyendo
  `wasiai-facilitator/src/infra/supabase.ts` vs `src/lib/supabase.ts` de este repo).
- **Aplicar la migración a producción (`caldz`)** — gate founder-aparte (AC-7).
- El dedup durable **cross-caller** que WKH-235a dejó diferido a propósito (columna
  `settle_intent_id` en `a2a_receipts` + `x-idempotency-key` HTTP + reintentador real del lado
  del caller de `/compose`) es un problema DISTINTO (protocolo de reintento del caller HTTP);
  esta HU resuelve la capa de abajo (el adapter deja de olvidar en memoria), no construye ese
  protocolo. Si comparten esquema de tabla, es una decisión de F2 (DT-4), no de esta HU.
- Cambiar la política de TTL/cap actual (`resolveIntentTtlMs`, `resolveMaxIntentEntries`,
  `evictIntentSignatures`) más allá de lo estrictamente necesario para migrar a DB: si el
  Architect concluye en F2 que una tabla no necesita el mismo mecanismo anti-leak que un `Map`
  in-memory, simplificarlo es una decisión válida, pero no ampliar el scope a rediseñar la
  política de retención sin necesidad.

## Decisiones técnicas (DT-N)

- **DT-1**: El candidato "reusar la tabla del facilitator" se descarta como reuse directo (ver
  Scope OUT) — son dominios y bases de datos distintos, y la clave primaria natural de cada uno
  es distinta (`signature` allá, `intentId` acá, porque acá el registro debe existir ANTES de
  que la firma exista).
- **DT-2**: La atomicidad se implementa como una escritura condicional única a nivel SQL —
  `INSERT` con constraint `UNIQUE` + manejo del código de error `23505` (patrón exacto de
  `wasiai-facilitator/src/infra/solana-dedup.ts:118-161`), o una función `plpgsql` tipo "claim"
  con `UPDATE ... WHERE ... RETURNING` (patrón de `claim_reconciliation` /
  `record_debit_settle_status` en `doc/sdd/202-hop2-lease/`). **NUNCA** un `SELECT` seguido de
  un `INSERT`/`UPDATE` en pasos separados — ese exacto error se identificó y corrigió hoy en
  otra parte de este repo (HU-202) y es la causa raíz que esta HU debe evitar desde el diseño.
- **DT-3**: El punto de claim del `intentId` debe quedar ANTES de la llamada que hace el
  broadcast real, para que el diseño sea estable frente a WKH-302 (ver sección de coordinación
  arriba). Este supuesto debe confirmarse en F2 antes de comprometerse al diseño final.
- **DT-4**: Decisión de esquema (tabla nueva vs. extender `a2a_receipts` con la columna
  `settle_intent_id` que WKH-235a dejó prevista y diferida) se deja explícitamente para F2 —
  Analyst no diseña SQL. Ambas opciones cumplen DT-1/DT-2; la elección es de Architect.

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO implementar la protección de idempotencia como lectura-y-luego-escritura
  (leer si existe, y si no existe, escribir en una operación separada). OBLIGATORIO: una
  escritura condicional atómica a nivel de base de datos que devuelva si aplicó o no en la
  misma operación.
- **CD-2**: OBLIGATORIO fail-closed — si el store durable no está disponible o la query falla,
  el sistema NO debe broadcastear un pago nuevo. PROHIBIDO cualquier fallback que trate "no sé
  si ya se pagó" como "no se pagó, adelante".
- **CD-3**: PROHIBIDO modificar código o esquema de `wasiai-facilitator`. Solo lectura. PROHIBIDO
  además que `wasiai-a2a` escriba o lea directamente la tabla `facilitator_solana_settlements`
  (bases de datos distintas, sin conexión cross-DB en este repo).
- **CD-4**: OBLIGATORIO que la migración SQL producida se aplique únicamente contra la base de
  desarrollo (bdwv) durante esta HU. PROHIBIDO aplicarla contra producción (caldz) — mismo
  guard anti-caldz que usan los applier scripts recientes (`scripts/apply-hu202-migration.mjs`
  como referencia de patrón).
- **CD-5**: OBLIGATORIO preservar verify-before-trust: cualquier firma leída del store durable
  debe re-verificarse on-chain (`verify()`) antes de devolverse como válida — no se debe confiar
  ciegamente en lo persistido.
- **CD-6**: PROHIBIDO tocar `contracts/.gas-snapshot`, `doc/audit/2026-06-28-best-practices-audit.md`,
  los `doc/jury-qa*.md`, y `doc/sdd/118-wkh-sec-02b-owner-ref-rpc/` (untracked protegidos por
  instrucción explícita de esta tarea).

## Missing Inputs

1. **[NEEDS CLARIFICATION — no bloqueante para HU_APPROVED, sí para F2]** No encontré un
   `work-item.md`/SDD de WKH-302 en `doc/sdd/` de este repo ni mención en `BACKLOG.md` — toda
   la descripción de WKH-302 usada en esta HU viene del prompt de la tarea (probablemente vive
   en Jira o en otro repo, p. ej. `wasiai-facilitator` o `chaski-v3`). El Architect debería
   ubicar esa fuente antes de comprometerse al DT-3 (diseño call-site-stable).
2. **[resuelto en F2]** Esquema exacto: tabla nueva dedicada vs. extender `a2a_receipts` con
   `settle_intent_id`. Ver DT-4.
3. **[resuelto en F2]** Política de retención/cleanup de la nueva tabla (¿necesita TTL/job de
   limpieza como el `Map` actual, o una tabla Postgres con estas filas —pequeñas, acotadas por
   volumen de settles Solana— puede simplemente crecer sin ese mecanismo?).
4. **[resuelto en F2]** Qué pasa exactamente con las entradas del `Map` in-memory en el momento
   del deploy de esta HU: análisis del Analyst es que **no importa perderlas** — cada
   `intentId` es un UUID fresco por compose-run (`composeRunId = randomUUID()`), así que no hay
   "migración de datos" que hacer; el único riesgo es un run que esté a mitad de camino
   EXACTAMENTE durante el restart del deploy de esta HU, que es una instancia acotada y única
   del mismo problema que la HU corrige en general (no un caso nuevo). F2 debe confirmar que
   coincide con esta lectura o señalar lo contrario.

## Análisis de paralelismo

- **No bloquea** ni es bloqueada por HUs actualmente `in progress` en el `_INDEX.md` (159-163,
  todas sobre `orchestrate.ts`/discovery/relevancia — módulos distintos, sin overlap de
  archivos).
- **Coordina con WKH-302** (ver sección dedicada arriba) sin bloquearse mutuamente: pueden
  desarrollarse en paralelo si el Architect de esta HU confirma DT-3 con quien tenga el
  work-item real de WKH-302 antes de comprometer el diseño de F2. Si esa confirmación revela
  que el supuesto de DT-3 es incorrecto, esta HU debería re-abrir su F2 (no su F1/ACs, que
  siguen siendo válidos independientemente de dónde viva el broadcast).
- **Precedente y patrón reusable**: `doc/sdd/202-hop2-lease/` (mismo repo) resolvió un problema
  estructuralmente idéntico (claim atómico antes de actuar, fail-closed, verificación en las
  dos direcciones, mutación por guard) para el hop 2 EVM del escrow. El Architect de F2 debería
  leerlo como referencia de diseño y de nivel de rigor de testing esperado.
