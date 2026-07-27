# BACKLOG — WasiAI (fuente de verdad de lo abierto)

Jira se perdió (tenant suspendido, sin recuperación). Este archivo lo reemplaza.

**Reemplaza a la versión anterior** (fechada 2026-04-27, época del hackathon de Kite, con
épicas E1-E17 todas cerradas salvo deuda técnica cosmética). Esa versión no se perdió: sigue
en el historial de git de este mismo archivo (`git log -- BACKLOG.md`). Esta reescritura completa
es correcta porque casi todo lo que listaba ya está cerrado y el documento había quedado obsoleto
por más de tres meses.

**Regla del archivo**: acá solo vive lo ABIERTO. Nada de filas "Done"/"cerrado". Si algo no está
listado, está cerrado y su historia completa (work-item, SDD, auto-blindaje, done-report) vive
versionada en `doc/sdd/NNN-titulo/` del repo correspondiente. No se reconstruyen tickets cerrados.

**Regla de mantenimiento** (repetida al final): esto se actualiza **en el mismo commit** que
cierra la HU que lo toca. Cerrar algo = borrar su fila de acá, no marcarla "Done".

**Autoridad de esta pasada**: git (`.git/logs/HEAD` y merges reales), no memoria de sesión ni
`_INDEX.md`. Un intento anterior de reescribir este archivo confundió notas de memoria de días
atrás con el estado presente y afirmó cosas falsas (que un gate de seguridad "es saltable" y que
fix-packs de money-path seguían "sin mergear" cuando en realidad ya estaban mergeados). Esta
versión verifica contra el reflog real de `wasiai-a2a` (confirmado: HEAD = `0c361e5`, con el merge
`eb24a31` — el fix-pack del gate de mainnet — en su ancestría directa) y contra el código en disco
donde fue posible. Los repos `chaski-v3`, `wasiai-facilitator`, `wasiai-remittance-agents` y
`solana-programs` **sí están en esta máquina** (en `/home/ferdev/.openclaw/workspace/`), pero el
agente que armó esta pasada no tenía acceso a shell, así que no pudo inspeccionarlos ni consultar
endpoints. Lo que quedó marcado como no verificado por esa razón fue **completado después** por el
orquestador con acceso real (ver los ítems que hoy dicen `[verificado 2026-07-27]`).

**Marcas de confianza usadas en cada ítem**:
- `[verificado]` — confirmado en esta pasada contra código en disco, el reflog de git
  (`.git/logs/HEAD`), o un merge real citado por hash.
- `[verificado, pasada anterior]` — confirmado en una pasada anterior (memoria/founder), no
  re-chequeado línea por línea en ésta, pero sin señal de que haya cambiado.
- `[según índice]` — viene del `_INDEX.md` del repo y no se pudo confirmar independientemente.
- `[necesita revisión]` — señal insuficiente o repo no accesible desde esta máquina; alguien tiene
  que confirmarlo contra el repo real o un endpoint en vivo.

---

## 🚦 Qué bloquea qué (30 segundos)

```
[FOUNDER: rotar credencial GET        ──► cierra el único hallazgo de severidad "credencial viva
 /registries, salió por HTTP en prod]      expuesta en prod" que queda. El endpoint YA está
                                            arreglado (no vuelve a exponerla); rotarla es aparte.

[✅ HECHO 2026-07-27: el escrow queda  ──► sus DOS salidas ejercitadas contra devnet. El RELEASE ya
 validado en sus dos salidas]               se había corrido el 22-jul (los docs decían que no: la
                                            cadena dice `Released`). El REFUND se probó hoy, con su
                                            guard en las dos direcciones: rechazado antes del
                                            deadline, exitoso después, fondos de vuelta al remitente.
                                            Falta el circuito completo DESDE Chaski (app → gasless →
                                            release por endpoint).

[FOUNDER: promover Chaski v3 a        ──► todo lo que WKH-218/233/235/236 mergearon a chaski-v3
 producción (hoy sirve v2)]                (Chaski sobre rieles A2A) es real en código pero no lo
                                            ve ningún usuario hasta este paso.

[FOUNDER: decidir el caller x402 en   ──► desbloquea el fix de /registries y /tasks cobrando sin
 /registries y /tasks]                     reembolsar: un caller x402 pagó ON-CHAIN, y eso no es
                                            reembolsable acreditando saldo interno sin más contexto.

[Ingeniería: idempotency key en el    ──► transversal (gasless, compose, orchestrate). Sin esto,
 outbox de refunds]                        un refund que SÍ se aplicó puede re-aplicarse si la RPC
                                            commitea pero la respuesta se pierde.
```

**Logro para tener en cuenta como contexto** (no es un ítem abierto, es la base sobre la que se
apoya buena parte de lo de arriba): el rail multichain funciona end-to-end en producción.
`POST /discover` devuelve agentes que declaran `payment.chain: solana-devnet`, y **el gateway les
paga de verdad**: WKH-235/236 (`remit-corridor-fx-solana`, `remit-cashout-payout-solana`) están
registrados, descubribles, y su fee se liquida on-chain de verdad (settle verificado). Sus filas en
el `_INDEX.md` de `wasiai-remittance-agents` dicen "in progress (F1)" — están desactualizadas,
esto ya se cobró `[verificado por indicación explícita de esta pasada; repo no clonado acá]`.

---

## 🔴 Bloqueado por el founder

### Bloqueando algo concreto ahora mismo

1. **Rotar la credencial que salió por `GET /registries`** `[verificado]`. El endpoint devolvía
   `registries[].auth.value` en claro (prefijo `wasi_a2a_…`) sin auth. **El bug de código ya está
   cerrado**: `src/routes/registries.ts` solo puede devolver el tipo `RegistryPublic` (sin
   `auth.value`) y hay un test dedicado (`registries.redaction.test.ts`) que recorre todos los GET
   del plugin y falla si algún response contiene el secreto — confirmado leyendo el archivo en esta
   pasada. **Pero la credencial que ya salió por HTTP en prod sigue viva** hasta que alguien la
   rote; el fix de código no la desexpone hacia atrás.
2. **2 variables de entorno del release del escrow, en el Railway del `facilitator`**:
   `SOLANA_ESCROW_RELEASE_ENABLED` y la clave de la autoridad que firma el release. Sin ellas,
   `POST /solana/escrow/release` daba **404** porque la ruta no se registraba. Era el paso que cerraba la
   remesa non-custodial de punta a punta en Solana. Al momento de escribir esto el founder estaba
   deployándolas — **verificar con `curl -X POST` si ya da 401 (ruta registrada, falta auth) en vez
   de 404 (ruta ausente)** antes de asumir que sigue bloqueado `[RESUELTO 2026-07-27: el founder puso las dos vars, Railway redeployó y la ruta ahora responde 401 (registrada, pide auth) en vez de 404. Verificado con POST real. Health del facilitator: degraded=false, las 5 redes en rpc=ok, y las 3 rutas Solana (sponsor, escrow/release, settle) todas en 401]`.
3. **Promover Chaski v3 a producción.** Hoy Vercel sirve `chaski-v2`; v2 y v3 comparten el mismo
   proyecto Vercel `[verificado, pasada anterior]`. Sin este paso, todo lo que WKH-218 (Chaski sobre
   rieles A2A, mergeado y verificado en vivo contra un gateway mockeado) mergeó a `chaski-v3` no es
   lo que ve un usuario real.
4. **Confirmar si el plan de Vercel protege producción**, para darle URL fija a la pantalla de
   seguimiento `/dashboard/trace` (hoy vive en `wasiai-a2a`, Railway, no Vercel — pero el mismo tipo
   de decisión de "URL pública fija vs preview protegido" aplica al resto de la superficie de
   founder-facing tooling) `[según índice / pasada anterior]`.
5. **Accesos de sandbox de partners** (Didit AML, TransFi) **y el frente legal/UIF** — sin esto,
   KYC/AML y el off-ramp a fiat real no pueden ir más allá de sandbox/mock.
6. **Decidir qué se hace con el caller x402 en `/registries` y `/tasks`** cuando esos endpoints
   cobran y fallan (ver ítem de ingeniería abajo): un caller x402 pagó **on-chain**, y eso no es
   reembolsable acreditando saldo interno sin una decisión de producto sobre cómo hacerlo.

### Decisiones de founder de pasadas anteriores, no re-verificadas en ésta

No hay evidencia de que hayan cambiado, pero tampoco se re-confirmaron esta vez (repos no clonados
en esta máquina). Tratarlas como abiertas hasta reconfirmar contra el repo real.

7. **WKH-233** (Chaski consume KYC vía agente A2A en vez de Didit directo): decisión Opción A
   (companion ticket con 2 endpoints nuevos en `wasiai-remittance-agents`, espejando el Didit v3
   hosted-redirect que Chaski ya usa) vs Opción B (swap directo al `/invoke` actual, que reabriría
   el IDOR de PII que WKH-179 cerró) `[según índice, no reverificado]`.
8. **WKH-237b**: ¿existe un `IdentityRegistry` ERC-8004 canónico en Avalanche, o lo deployamos
   nosotros? Hoy el bind on-chain real sigue hardcodeado a Base `[según índice, no reverificado]`.
9. **WKH-238**: registro Solana de identidad/reputación — Solana Agent Registry (8004-solana,
   recomendado) vs SATI `[según índice, no reverificado]`.
10. **Ratificar que el operador del gateway firma el settle del fee en Solana** (custodial de ese
    lado, espejo del modelo EVM ya en producción) `[según índice, no reverificado]`.
11. **Provisionar la Agent Key de Chaski en el gateway** para correr el e2e real de WKH-218 contra
    el gateway de producción (hoy solo probado contra un gateway mockeado) `[según índice, no
    reverificado]`.

---

## ✅ Contexto: lo que se cerró en las últimas 24-48h (para que nadie lo vuelva a listar como abierto)

Verificado contra `.git/logs/HEAD` de `wasiai-a2a` en esta pasada — HEAD actual = `0c361e5`.

- **Gate de mainnet por destino real**: `isMainnetChainKey` clasificaba por el string del slug, no
  por la chain real del bundle; `KITE_NETWORK=mainnet` lo esquivaba. **Cerrado**, branch
  `fix/ar-profundo-p0-money-path`, merge `eb24a31` (confirmado como ancestro directo de HEAD en el
  reflog). Reemplazado por un gate fail-closed real (`WASIAI_DOWNSTREAM_MAINNET_ALLOW`, allowlist
  explícita) — confirmado leyendo `scripts/activate-mainnet-downstream.sh` y
  `doc/operations/mainnet-activation-runbook.md` en esta pasada: el script viejo seteaba
  `WASIAI_DOWNSTREAM_NETWORK`, una variable que ningún archivo de `src/` leía (control muerto desde
  WKH-112); el script actual lo dice explícitamente en un comentario y usa el gate real.
- **Credencial de `/registries` en claro**: cerrado (ver founder #1 arriba — el código está
  arreglado, la rotación sigue pendiente).
- **`/compose` cobraba un 400 de validación sin ejecutar nada**: cerrado, mismo merge `eb24a31` +
  fix-pack `a35212e`.
- **5 hallazgos P1**: doble `limit` de `/discover` (escondía agentes), `minReputation` aceptado y
  ignorado, artefacto de float en el monto atómico del challenge 402, falta de señal del skip en la
  respuesta de `/compose`, `_intentSignatures` (dedup Solana) sin cap ni TTL. **Cerrados**, merge
  `6373dd8`.
- **5 guards del money-path sin test bajo mutación + el e2e de devnet vacuo**: cerrados, merge
  `54f1f9a` (el mensaje del merge dice explícitamente "el e2e de devnet dejaba de mentir").
- **`/gasless/transfer` cobraba el transfer que no llegaba a hacer**: cerrado, merge `0c361e5`
  (HEAD actual).
- **Pantalla `/dashboard/trace`**: viva en `wasiai-a2a` (no en un repo aparte), merge `b81c2e6`.
  Confirmado leyendo `src/routes/dashboard.ts` y `src/services/trace.ts` en esta pasada: read-only,
  gate fail-closed (`requireAdminTokenForTrace`), cross-tenant por diseño y documentado como tal.
- **`chaski-v3`**: WKH-218 (Chaski corre sobre los rieles A2A) mergeado y **verificado en vivo**
  contra un gateway mockeado; el cliente A2A ya puede elegir la red de cobro. `[según el log de
  merges de esta pasada; repo no clonado acá para inspección propia]`.
- **`wasiai-facilitator`**: el `/health` que reportaba `degraded:true` permanente por sondear Solana
  con un método de EVM está arreglado y deployado (verificado en vivo en una pasada anterior: pasó
  a `degraded:false`) `[verificado, pasada anterior; repo no clonado acá]`.
- **WKH-235/236** (agentes Solana-native, fee real): ver sección de arriba.

---

## 🧩 Ítems de ingeniería abiertos

### wasiai-a2a

- **`/registries` (3 handlers: POST/PATCH/DELETE, usan `requirePaymentOrA2AKey`) y `/tasks` (5
  endpoints, TODOS —incluidos los GET— exigen `requirePaymentOrA2AKey`) cobran y nunca reembolsan
  en caso de error** `[verificado — confirmado leyendo `src/routes/registries.ts` y
  `src/routes/tasks.ts` en esta pasada]`. Bloqueado por decisión de founder (bloque founder #6):
  uno de sus modos de error le pega a un caller x402 que ya pagó **on-chain**, y eso no es
  reembolsable acreditando saldo interno sin más contexto de producto.
- **El outbox de refunds puede re-aplicar un credit que ya se aplicó**, si la RPC commitea pero la
  respuesta al caller se pierde (partición de red). Transversal: gasless, compose y orchestrate.
  `src/services/refund-outbox.ts` documenta un invariante anti-doble-refund basado en "filas
  afectadas" (A2), pero ese invariante no cubre el caso de respuesta perdida tras un commit real —
  necesita migración con idempotency key.
- **Requests salientes sin techo de duración real**: el timeout de `undici`/`fetch` (usado en
  `src/lib/downstream-payment.ts` y en el resto de las llamadas a agentes downstream) es de
  inactividad (`bodyTimeout`), no de duración total, y nadie lo configura explícitamente. Un agente
  que gotea datos lento puede clavar un socket. Es disponibilidad, no plata. Relacionado: hay un PR
  de dependabot (`dependabot/npm_and_yarn/undici-8.5.0`, branch confirmado en `.git/refs/`) con un
  bump mayor de esta misma librería, sin integrar.
- **Test de dedup de Solana inestable (~5%)** en el borde de la ventana temporal protegida
  `[según pasada anterior, no re-ejecutado en ésta]`.
- **Falta el write-path de `payment` en `POST /agents` y `PATCH /agents/:slug`** `[verificado,
  pasada anterior — confirmado en el done-report de WKH-241]`. Hoy `metadata.payment` solo se puede
  seedear a mano en la base — así se registraron los 2 agentes Solana-native. El AR de WKH-241 dejó
  anotado que, al implementarlo, necesita allowlist de chains del operador + verificación de
  ownership del `payTo`, o nace con un BLQ-ALTO (cualquiera podría registrar
  `base-mainnet`/`kite-mainnet` y settlear dinero real).
- **`WKH-235a` (idempotencia durable del settle Solana)** quedó re-scopeada y diferida a propósito:
  el dedup real (`a2a_receipts.settle_intent_id` + `x-idempotency-key` + migración SQL) no se hizo
  porque hoy no existe ningún mecanismo que reintente un settle Solana con el mismo `intentId`.
  Reactivar antes de mainnet / dinero real, o en cuanto exista un reintentador de settles.
- **11 branches stale sin auditar** + PRs de dependabot sin integrar (ver ítem de undici arriba)
  `[según pasada anterior]`.

### wasiai-facilitator (`main = 75099ef`, verificado 2026-07-27)

- **`/health` no distingue "adapter registrado" de "ruta apagada por flag"**: reporta salud por red,
  nunca por ruta o flag. Fue el estado del release del escrow hasta el 2026-07-27 (ya resuelto): si las env
  vars faltan, no hay ninguna señal de salud que lo diga, solo el 404 al invocar.
- **WKH-148** — error explícito `OPERATOR_FUNDING_LOW` en `/settle` (ver zombis abajo, parado desde
  el 7 de julio).

### Pantalla `/dashboard/trace` (wasiai-a2a)

- **Faltan índices para las 2 queries cross-tenant** que arma `traceService.snapshot()` contra
  `a2a_events` / `a2a_receipts` / `a2a_protocol_fees` (`src/services/trace.ts`). Hoy la tabla es
  chica y no se nota, pero escala mal: dos seq-scans cada 10s por cada pestaña de operador abierta
  `[RESUELTO 2026-07-27: el founder puso las dos vars, Railway redeployó y la ruta ahora responde 401 (registrada, pide auth) en vez de 404. Verificado con POST real. Health del facilitator: degraded=false, las 5 redes en rpc=ok, y las 3 rutas Solana (sponsor, escrow/release, settle) todas en 401]`.

---

## 🗺️ Milestones del programa (Solana LATAM Labs / WayLearn, cierre 31 de agosto de 2026)

**Nota de mapeo**: la fuente del plan describe 6 "Sprints" + una "Extensión" en prosa, sin IDs. Los
docs de milestone del programa (M1 roadmap / M2 negocio / M3 arquitectura) usan otra numeración más
chica; el "M5" del código/runbooks (`RUNBOOK-M5.md`) es un hito interno (deposit no-custodial en
devnet) DENTRO de "Sprint 3", no un M-programa aparte. Mapeo cada Sprint recibido a M1..M6 + M7 en
el orden dado; no hay fuente que numere formalmente M1-M7 1:1.

| M | Contenido | Estado real |
|---|---|---|
| M1 · Fundación | Config multi-VM · orquestador de settlement multichain · escrow Anchor con beneficiario fijo + refund por deadline | **DONE** `[verificado, pasada anterior]`. |
| M2 · Core Solana seguro | Wallet Standard + firma del depósito no-custodial · verificación de pago (pin mint/monto, dedup) · identidad multi-red base58 | **DONE** `[verificado, pasada anterior]`. |
| M3 · Money-path trustless + gasless | PoP ed25519 · binding + release verificado + refund trustless · gasless fee-payer · contratos tipados/IDL golden tests · e2e devnet con tx verificable | **CASI COMPLETO, con una pieza aún gateada al founder**. PoP, binding+release+gasless: DONE y deployados. El e2e de devnet **ya no es vacuo** (merge `54f1f9a` en `wasiai-a2a`, confirmado por mensaje de merge explícito) — pero el `POST /solana/escrow/release` real sigue dando 404 hasta las 2 env vars del founder (bloque founder #2). Golden tests/IDL: DONE en facilitator y remit-agents; en `chaski-v3` seguía en F1 según la última nota disponible `[no reverificado, repo no clonado]`. |
| M4 · Marketplace multichain, agentes Solana-native y tenant | Fees on-chain en Solana · corredor/FX y payout Solana-native publicados · identidad/reputación on-chain · Chaski sobre los rieles · off-ramp fiat con partner licenciado · modelo tenant/white-label | **MUY ADELANTADO en 3 de 5 frentes, 0% en 2**. Fees Solana: **YA se cobran de verdad** (ver contexto arriba) — este frente pasó de "bloqueado" a "hecho" desde la última pasada. Agentes Solana-native: publicados, descubribles, cobrando. Chaski sobre rieles (WKH-218): DONE y mergeado, falta promover v3 a prod (founder #3) para que un usuario real lo vea. ERC-8004 Avalanche: solo allow-set de código, sin `IdentityRegistry` real (founder #8). Solana Agent Registry (WKH-238): no iniciada (founder #9). Off-ramp fiat real: config lista, smoke gateado a sandbox del founder (founder #5). Tenant/white-label: **NET-NEW, 0%** — no existe `tenant_id` en ningún lado; `owner_ref` es guard de mutación (IDOR), no scoping de lectura `[según pasada anterior]`. |
| M5 · Rieles A2A y reconciliación | Auth + pago x402 con timeout/circuit-breaker · reconciliación on-chain-como-verdad + FX entregado vs cotizado · KYC como agente A2A | **PARCIAL**. x402 con timeout/circuit-breaker: existe hace meses en el core de `wasiai-a2a`, no específico de Solana. Reconciliación + FX: hecho del lado EVM (`chaski-v2`), no confirmado equivalente en Solana. KYC como agente A2A (WKH-233): bloqueada, founder #7. |
| M6 · Producción, operación, seguridad y legal | Gestión de llaves · RPC dedicado/observabilidad/HA · UX de producción · cumplimiento (Travel Rule, AML, PII) · supply-chain, DB con RLS+backup, gate de production-readiness · frente legal | **MAYORMENTE NO INICIADO**, con excepciones puntuales: RLS hecho para EVM en `wasiai-a2a`, no confirmado para tablas Solana nuevas; observabilidad sólida del lado `wasiai-a2a` con el gap conocido de `/health` del facilitator (arriba); PII/AML parcial en `chaski-v2`, con un fail-open de compliance sin confirmar (Didit `aml.hits`, founder #5); load-testing/production-readiness: sin HU encontrada; legal/UIF: 100% founder, sin arrancar. |
| M7 · Extensión | On-ramp de agentes de terceros · publicar un agente Langflow descubrible y facturable vía x402 | **NO INICIADO**. `WKH-239` (PoC Langflow) es una acción comprometida por el founder, sin HU formal encontrada en ningún `_INDEX.md` revisado `[según memoria]`. |

---

## 🧟 Zombis a decidir (retomar o archivar)

Sin movimiento desde el **7 de julio de 2026** (3 semanas). No se tratan como trabajo activo.

- **`wasiai-a2a`**:
  - `WKH-157` — recall de free-text en `/discover` (`fix/159-wkh-157-discover-freetext-filter`).
  - `WKH-152` — planner LLM sin guard de relevancia (`fix/160-wkh-152-llm-relevance-guard`).
  - `WKH-158` — retry del planner LLM ante fallo transitorio (`fix/161-wkh-158-greedy-relevance-guard`).
  - `WKH-159` — falso negativo multilingüe del fallback greedy (`fix/162-wkh-159-greedy-multilingual-guard`).
  - `WKH-160` — relevancia semántica por embeddings. **Parkeada a propósito**, no olvidada: es
    **blocking prerequisite explícito de mainnet** según `doc/operations/mainnet-activation-runbook.md`
    (confirmado en esta pasada — el runbook la lista como bloqueante junto al upgrade UUPS del
    marketplace). Las otras 4 sí valen una decisión "retomar o cerrar como no-prioridad".
- **`wasiai-facilitator`**: `WKH-148` — error explícito `OPERATOR_FUNDING_LOW` en `/settle`.
- **`WKH-23` (Tasks DB, `wasiai-a2a`)**: el `_INDEX.md` tiene dos filas contradictorias (`007`) para
  el mismo ticket/branch, una "WIP" y otra "DONE". Evidencia indirecta de que está cerrado de
  verdad: `WKH-54` (owner_ref + RLS sobre `tasks`, confirmado en código de esta pasada vía
  `src/routes/tasks.ts`) se construyó encima de esa tabla sin reportar bloqueo. Recomendación:
  tratar como DONE y borrar la fila WIP duplicada del índice.

---

## ⚠️ Contradicciones encontradas entre fuentes

1. **`ground-truth.txt` (log de merges provisto para esta pasada) no incluye el merge `eb24a31`**
   (fix-pack del gate de mainnet) ni sus commits (`466a70a`, `4c84ae6`, `d81c207d`, `182a2e9d`,
   `15cd4c5a`), aunque están confirmados como ancestros reales de `HEAD` en `.git/logs/HEAD`
   (reflog). Lectura más probable: ese snapshot de log fue generado con un filtro que se saltó esta
   branch específica, no que el merge no haya ocurrido — el reflog es una fuente más autoritativa
   (no se puede falsificar sin reescribir el repo) y lo confirma sin ambigüedad.
2. **`WKH-235/236` en el `_INDEX.md` de `wasiai-remittance-agents`** dicen "in progress (F1)"
   mientras que, según esta pasada, ya están registrados, descubribles y cobrando de verdad en
   producción. El índice de ese repo no se re-verificó directamente (repo no clonado acá) — la
   fuente de esta afirmación es la instrucción explícita recibida para esta pasada, no una lectura
   propia del índice.
3. **`wasiai-facilitator/_INDEX.md`** (según pasadas anteriores) marca el orquestador multichain, el
   adapter Solana verify+dedup y el gasless fee-payer como "DONE (HELD — no merge; prod/Railway)",
   pero notas de sesión previas confirman con captura que el deploy activo en Railway ya corresponde
   a ese merge en `main`. Tratado en este documento como mergeado y deployado, pendiente solo de
   activación por env vars — no re-verificado en esta pasada (repo no clonado acá).
4. **`WKH-23` con dos filas contradictorias** en el mismo índice (ver zombis arriba).
5. **HU-SOL-9 (`chaski-v3`)** se etiqueta a sí misma como `WKH-208`, pero `WKH-208` en
   `wasiai-remittance-agents` es un ticket distinto y ya cerrado (reescritura del adapter de payout
   de TransFi). Posible reuso erróneo de número de Jira. No resuelto; tratar `HU-SOL-9` solo por su
   nombre de programa hasta aclarar.

---

## 📐 Regla de mantenimiento de este archivo

- Este archivo lista **solo lo abierto**. Nada de "Done"/"cerrado" acá.
- Se actualiza **en el mismo commit** que cierra la HU que lo toca (borrar la fila, no marcarla).
- Antes de agregar algo como abierto: verificar contra código/reflog/endpoint en vivo cuando sea
  posible. Si no se pudo verificar, marcarlo `[según índice]` o `[necesita revisión]` explícitamente
  — nunca como hecho un dato de memoria de sesión sin re-chequear contra git o código.
- Si una fuente contradice a otra, se documenta la contradicción arriba en vez de elegir en silencio.
- La historia de todo lo cerrado sigue viviendo en `doc/sdd/NNN-titulo/` de cada repo — no se
  duplica acá.

---

## Hallazgos del 2026-07-27 (escrow Solana)

**El escrow quedó validado en sus dos salidas contra devnet.** `[verificado]`

- **Release**: ya se había corrido el **22 de julio**, no estaba sin probar. El escrow
  `GXY2todK6pJPdT8h1EcRNZgFX7cZXEnDN7L3XSHCHY2J` está en estado `Released` con sus 10 USDC en el
  beneficiario. Los documentos (RUNBOOK-M5 y notas de sesión) afirmaban que el release estaba
  diferido. **La cadena es la fuente de verdad, los documentos estaban desactualizados.** Se
  descubrió decodificando las cuentas del programa con el IDL, no leyendo docs.
- **Refund**: ejercitado por primera vez el 27 de julio, y probado en **las dos direcciones**:
  rechazado por el programa **antes** del deadline (el guard protege), exitoso **después**
  (tx `4GDwrHgsu2kc…`), con los fondos de vuelta al remitente. Las dos mitades importan: el refund es
  lo que hace el escrow no-custodial (el usuario recupera su plata solo con su firma), y el guard es
  lo que hace que el depósito signifique algo.

**RIESGO DE DISEÑO abierto: perder el `remittanceId` vuelve los fondos inalcanzables.** `[verificado]`

El `refund` exige el `remittanceId` como argumento, y ese dato **no es recuperable desde la cadena**
(solo vive su hash truncado en la seed del PDA). Ya hay un caso real: el escrow
`BmHDdjKL…` tiene 10 USDC de prueba trabados con el deadline vencido, y su `remittanceId` se perdió
(el RPC no indexa la transacción vieja y la base de Chaski está bloqueada). En producción esto sería
grave: un usuario cuya remesa falla y cuyo `remittanceId` se perdió **no puede recuperar su dinero**,
aunque el refund funcione perfecto. Ahí el escrow deja de ser no-custodial en la práctica, porque
nadie puede sacar esos fondos. Direcciones posibles: persistencia redundante del id, entregarle al
usuario un comprobante que lo incluya, o que el programa lo guarde en la cuenta (implica redeploy y
auditoría). Más una reconciliación que detecte escrows vencidos para no acumular fondos huérfanos en
silencio.
