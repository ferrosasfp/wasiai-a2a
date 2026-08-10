> Producto de F0+F1 (nexus-analyst). Contexto del encargo: David, mentor de la
> incubadora Solana LATAM Labs, va a revisar este repo y su API pública en
> detalle. El criterio no es sólo "funciona": es que lo que él toque primero no
> parezca descuidado.

# Work Item — [WKH-345] Un `:id` mal formado en cuatro superficies devuelve 500 en vez de 400/422

## Resumen

`GET /receipts/:id` (y `/verify`) devuelve **500** cuando `:id` no es un UUID
válido, porque el valor llega sin validar hasta un `.eq('id', id)` de Supabase
que lanza `invalid input syntax for type uuid`. El patrón correcto YA EXISTE en
el repo — `src/routes/tasks.ts:127-133` valida forma con `isValidUUID` ANTES de
tocar la capa de datos y devuelve 400 — pero `isValidUUID`/`UUID_RE` son
privados de ese módulo, así que nadie más lo reusa.

Barrido manual (ver §Missing Inputs #1 sobre sus límites) encontró el **mismo
agujero en otras 3 rutas** (`auth/key-session.ts` ×2, `auth/delegation.ts` ×1),
más una variante equivalente en `payments.ts` (4 endpoints, vía RPC en vez de
`.eq()`, mismo síntoma). Por eso esta HU no es "arreglar receipts": es agregar
el guard de formato de UUID que falta en el borde de la API, reusando —no
reinventando— el que ya existe en `tasks.ts`.

Esta HU es el **corte 1 de 3** de un encargo más amplio (revisión pre-mentor de
la API pública). Los otros dos hallazgos del encargo (ids vacíos en el catálogo
público; una dirección de cobro sin código de red en la doc) **quedan fuera**
de esta HU — ver §Scope OUT y la nota de cierre, con la justificación de por
qué NO se agrupan en la misma bolsa.

## Sizing

- SDD_MODE: full (QUALITY — regla del repo, sin excepción por tamaño)
- Estimación: M (5 archivos de `src/`, 1 archivo nuevo compartido, dinero
  adyacente en `payments.ts`, sin cambios de esquema ni de contrato para el
  camino feliz)
- Branch sugerido: `fix/222-wkh-345-uuid-param-validation`

## Acceptance Criteria (EARS)

- **AC-1**: WHEN un caller invoca `GET /receipts/:id` o `GET /receipts/:id/verify`
  con un `:id` que no matchea el formato UUID v4-shape (`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
  case-insensitive — el mismo regex que `tasks.ts`), the system SHALL responder
  `400` en vez del `500` actual, y SHALL NOT ejecutar ninguna query contra
  `a2a_receipts`.
- **AC-2**: WHEN un caller invoca `DELETE /auth/key-session/:id` o
  `PATCH /auth/key-session/:id/require-signature` con un `:id` mal formado, the
  system SHALL responder `400` en vez del `500 KEY_SESSION_REVOKE_FAILED` /
  `500 REQUIRE_SIGNATURE_FAILED` actuales.
- **AC-3**: WHEN un caller invoca `DELETE /auth/delegation/:id` con un `:id` mal
  formado, the system SHALL responder `400` en vez del `500 DELEGATION_REVOKE_FAILED`
  actual.
- **AC-4**: WHEN un caller invoca `POST /payments/session/:id/voucher`,
  `POST /payments/session/:id/close`, `POST /payments/session/:id/dispute` o
  `POST /payments/upto/:id/settle` con un `:id` mal formado, the system SHALL
  responder `422 { error_code: 'INVALID_INPUT' }` — el código que ESTE archivo
  ya usa para todo lo demás mal formado (`isFiniteNonNegative`,
  `isNonEmptyString`) — en vez del `500 PAYMENT_INTENT_FAILED` / `500 ARBITER_FAILED`
  actuales.
- **AC-5** (unwanted/invariante): IF el `:id` recibido SÍ tiene formato UUID
  válido (exista o no, sea del owner que llama o de otro), THEN el sistema
  SHALL responder exactamente igual que hoy — mismo status, mismo body, mismo
  `error_code`. El fix es aditivo estrictamente sobre el camino MALFORMADO; no
  toca ningún camino que hoy ya funciona.
- **AC-6** (ubiquitous): the system SHALL validar todo `:id` con forma de UUID
  en un path param usando UN solo helper exportado y compartido (extraído de
  `isValidUUID`/`UUID_RE` de `tasks.ts`, sin reescribir el regex), no una copia
  por archivo.

## Scope IN

- `src/lib/uuid.ts` (o ubicación equivalente que decida el Architect en F2):
  nuevo módulo leaf que exporta `isValidUUID`/`UUID_RE`, extraídos TAL CUAL de
  `src/routes/tasks.ts:90-95` (mismo regex, mismo comportamiento — cero cambio
  de semántica).
- `src/routes/tasks.ts`: refactor para importar el helper compartido en vez de
  declararlo local (byte-idéntico en comportamiento; el propio archivo ya
  tiene tests que lo pinean).
- `src/routes/receipts.ts`: guard de formato al inicio de `GET /:id` y
  `GET /:id/verify`, antes de `resolveCallerKey`/`receiptService.getById`.
- `src/routes/auth/key-session.ts`: guard de formato al inicio de
  `DELETE /key-session/:id` y `PATCH /key-session/:id/require-signature`.
- `src/routes/auth/delegation.ts`: guard de formato al inicio de
  `DELETE /delegation/:id`.
- `src/routes/payments.ts`: guard de formato al inicio de los 4 handlers con
  `:id` listados en AC-4 (`GET /session/:id/dispute` YA es seguro — ver
  Missing Inputs #1 — pero se le agrega el mismo guard por consistencia, a
  criterio del Architect).
- Tests que prueben el `:id` malformado en las 4 superficies (uno por
  endpoint), más un test que confirme que `tasks.ts` sigue devolviendo 400
  byte-idéntico después de la extracción.

## Scope OUT

- **Finding 2 del encargo (ids vacíos en el catálogo público de `/discover`)**.
  Causa raíz YA IDENTIFICADA en código, no en datos: `src/services/discovery.ts:1354`,
  dentro de `mapAgent()` —
  `id: String(getNestedValue(raw, mapping.id ?? 'id') ?? '')` — cuando un
  registry federado no expone un campo `id` en la ruta configurada (o no
  configura `agentMapping.id`), el agente entra al catálogo con `id: ''` en vez
  de caer al `slug` (que SIEMPRE está poblado, línea 1348, y es lo que
  `agent.ts:128` — el mapper de self-published — ya usa como `id`). Es el
  **serializador** el que los emite vacíos, no una columna sin productor ni un
  problema de `bdwv` — por eso es CÓDIGO, no una acción de datos.
  No pude re-medir el "22" citado en el encargo contra la API viva ni contra
  `bdwv`: esta sesión de F1 sólo tuvo `Read`/`Write`/`Glob`, sin `Bash`/`curl`/
  acceso a red o DB. El dato más cercano que existe en el repo (medido por
  OTRO sub-agente, no por mí, `doc/roadmap/2026-08-incubadora-solana-checklist.md`
  líneas 47-51 y 60) reporta que el registry federado `WasiAI` tenía 22-25
  agentes entre 2026-07-29 y 2026-08-04 — consistente con la hipótesis de que
  "22" es TODO ese registry, pero es una inferencia, no una medición mía.
  Recomiendo abrir **WKH-346** (F1 separado) con el fix de una línea
  (`?? ''` → `?? slug`) y, como primer paso de esa F1, correr
  `curl "$GW/discover?limit=100" | jq '[.agents[] | select(.id=="")] | length'`
  contra prod con el commit vigente al lado del número.
- **Finding 3 del encargo (dirección de cobro de mainnet sin su código de
  red)**. El caso YA CERRADO que el encargo cita (`doc/integration-base.md`,
  corregido antes de 2026-08, confirmado leyendo el archivo: la nota inline en
  las líneas ~200-208 documenta el fix) confirma la familia del bug pero está
  resuelto. Mi mejor candidato para "el vecino" es `doc/kite-contracts.md` §4
  ("Our operator wallet", líneas 101-113): documenta
  `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba` como receptor de x402 SIN decir
  si es la wallet de Kite testnet (2368) o mainnet (2366) — y `KITE_WALLET_ADDRESS`
  es una sola env var (no una por red, confirmado en `doc/architecture/MULTI-CHAIN.md`
  §8, que no la reconfigura al activar Kite mainnet), así que la MISMA
  dirección será la cobradora real en mainnet el día que se active, sin que
  esa sección lo diga. **No puedo afirmar que sea la única ocurrencia**: mi
  revisión cubrió `README.md`, `doc/INTEGRATION.md`, `doc/architecture/FEE-MODEL.md`,
  `doc/kite-contracts.md`, `doc/architecture/MULTI-CHAIN.md`, `doc/integration-base.md`,
  `doc/BASE-EVIDENCE.md` y el primer bloque de `.env.example` — NO cubrí
  `doc/architecture/CHAIN-ADAPTIVE.md`, `doc/solana-labs/`, el resto de
  `.env.example` (180 variables por el propio README) ni el pitch/deck. Sin
  `grep`/`Bash` en esta sesión no pude hacer el barrido que el propio encargo
  pide ("medí cuántas ocurrencias hay"). Recomiendo **WKH-347**: F1 aparte,
  doc-only, que empiece con
  `grep -rn -E '0x[0-9a-fA-F]{40}' doc/ README*.md .env.example` para levantar
  TODAS las ocurrencias de direcciones antes de decidir qué tocar.
- Los endpoints de reconciliación/arbitraje de `src/routes/dashboard.ts`
  (`:intentId`) tienen el MISMO agujero estructural (`arbiterService.resolveHold`/
  `reconciliationService.resolveIntent`/etc. con `:intentId` sin validar forma),
  pero están detrás de `DASHBOARD_ADMIN_TOKEN` (fail-closed, `requireAdminTokenStrict`)
  — no son la superficie pública anónima que un revisor externo toca en su
  primer clic. Queda fuera de esta HU; candidato a fast-follow de menor
  prioridad, NO founder-gated ni bloqueante.
- `src/routes/registries.ts` (`GET /registries/:id`, sin `try/catch`, en
  apariencia el mismo patrón que `receipts.ts`): **verificado y descartado**.
  `registries.id` es un slug TEXT server-derivado (`src/services/registry.ts:196-221`,
  `.eq('id', id).maybeSingle()`), no una columna UUID — un `id` malformado
  simplemente no matchea ninguna fila y `maybeSingle()` devuelve `null` sin
  error de Postgres. No comparte el bug; no se toca.
- Cualquier rediseño del shape de error global (`middleware/error-boundary.ts`)
  o de los códigos de error existentes de `payments.ts`/`key-session.ts`/
  `delegation.ts` más allá de lo estrictamente necesario para AC-1..AC-4.

## Decisiones técnicas (DT-N)

- **DT-1**: El helper compartido se extrae TAL CUAL de `tasks.ts` (mismo
  regex `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`), no
  se reinventa. `tasks.ts` pasa a importarlo — es el único archivo que YA hace
  esto bien, y por eso es la fuente de verdad, no un archivo nuevo.
- **DT-2**: Cada archivo devuelve el `error_code`/status que YA usa para sus
  otros rechazos de forma — `receipts.ts`/`key-session.ts`/`delegation.ts` no
  tenían un código de error de "forma inválida" previo (su único 4xx documentado
  es el 403 de auth y el 404 de not-found), así que el Architect decide en F2
  si el 400 lleva `error_code` o no, mirando el patrón de `tasks.ts`
  (`{ error: 'Invalid UUID format' }`, sin `error_code`); `payments.ts` SÍ
  tiene un código establecido (`422 { error_code: 'INVALID_INPUT' }`) y lo
  reusa sin inventar uno nuevo (AC-4). No se inventa un shape de error nuevo
  para todo el repo.
- **DT-3**: El guard corre ANTES de cualquier lookup/auth que toque datos —
  mismo lugar relativo que `tasks.ts:127-133` (antes de la resolución de
  owner y de cualquier query). Para `payments.ts`, que además es dinero, esto
  importa: el guard evita que un `:id` malformado dispare siquiera el RPC de
  débito/settle — no cambia CUÁNDO se cobra hoy (nunca se cobraba con un id
  malformado, porque el RPC ya fallaba antes de mover nada; el fix sólo
  cambia el STATUS de la respuesta).

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO cambiar el comportamiento para un `:id` con formato UUID
  válido — exista o no, sea del `owner_ref` que llama o de otro. El fix es
  aditivo únicamente sobre el camino con formato inválido (AC-5).
- **CD-2**: PROHIBIDO duplicar el regex/función de validación de UUID en más
  de un lugar. Un solo export, cuatro (o cinco) importadores.
- **CD-3**: OBLIGATORIO — antes de dar por cerrado AC-6, correr
  `grep -rn "req.params" src/routes/ src/routes/auth/` (con `Bash` real, en
  F3/dev) cruzado contra `.eq('id',`/`.rpc(` en el archivo de servicio que
  cada ruta invoca, para confirmar que la lista de 4 archivos de este work-item
  es COMPLETA. Esta F1 la armó leyendo manualmente ~14 de ~30 archivos de
  `src/routes/` (sin `Grep`/`Bash` disponibles en esta sesión) — ver Missing
  Inputs #1. Si el grep real encuentra una 5ª ruta, se agrega a esta misma HU
  (no se abre una nueva) antes de F4.
- **CD-4**: PROHIBIDO tocar `src/routes/registries.ts` — verificado y
  descartado (ver Scope OUT).
- **CD-5** (money-path, por `payments.ts`): OBLIGATORIO que el guard no
  introduzca ningún cobro/débito/settle nuevo ni cambie el resultado de
  ninguno existente — sólo adelanta el rechazo de forma a ANTES del primer
  `await` que toca `supabase`/`adapter`.

## Missing Inputs

1. **[no bloqueante, declarado]** El barrido de "¿hay otras rutas con el mismo
   agujero?" se hizo LEYENDO A MANO ~14 de ~30 archivos de `src/routes/` +
   `src/routes/auth/` (`receipts.ts`, `tasks.ts`, `payments.ts`, `agents.ts`,
   `agent-links.ts`, `agent-card.ts`, `discover.ts`, `registries.ts`,
   `dashboard.ts`, `auth.ts`, `auth/key-session.ts`, `auth/delegation.ts`) —
   esta sesión de F1 tuvo `Read`/`Write`/`Glob` únicamente, sin `Grep` ni
   `Bash`, así que no pude correr el `grep -rn "req.params"` que el propio
   encargo pide como evidencia de una afirmación de ausencia. NO leí
   `capabilities.ts`, `gasless.ts`, `inbound.ts`, `mock-registry.ts`,
   `well-known.ts`, `metrics.ts`, `compose.ts`, `orchestrate.ts`,
   `auth/bind.ts`, `auth/deposit.ts`, `auth/funding-wallet.ts`, `auth/me.ts`,
   `auth/require-signature.ts`, `auth/signup.ts`, `auth/identity.ts`,
   `auth/spend-policy.ts`. CD-3 lo convierte en un paso obligatorio de F3, no
   en una promesa de esta F1.
2. **[resuelto — código, no dato]** Ver Scope OUT / Finding 2: causa raíz en
   `discovery.ts:1354`, fuera de esta HU, sugerido WKH-346.
3. **[no bloqueante, doc-only]** Ver Scope OUT / Finding 3: candidato
   identificado (`doc/kite-contracts.md` §4) pero sin barrido completo,
   sugerido WKH-347.
4. **[actualización pendiente de `_INDEX.md`]** Esta sesión de F1 tampoco tuvo
   `Bash`/`Edit` para insertar de forma segura una fila nueva en
   `doc/sdd/_INDEX.md` (277 líneas, algunas de >3000 caracteres — reconstruir
   el archivo entero a mano vía `Write` arriesgaba corromper contenido que no
   pude releer al 100% con certeza byte-a-byte). La fila lista para insertar
   está en el resumen ejecutivo que este agente le devuelve al orquestador;
   falta que alguien con `Edit`/`Bash` la aplique.

## Análisis de paralelismo

- No bloquea ni es bloqueada por ninguna HU Solana en vuelo (WKH-314/315/316/318/319/322/342):
  ningún archivo de este Scope IN (`receipts.ts`, `auth/key-session.ts`,
  `auth/delegation.ts`, `payments.ts`, `tasks.ts`, el nuevo `src/lib/uuid.ts`)
  aparece en los archivos que esas HUs declaran tocar (`middleware/x402.ts`,
  `adapters/registry.ts`, `compose.ts`, `types/index.ts`, `services/agent.ts`,
  `discovery.ts`, `discovery-query.ts`, `adapters/solana/*`,
  `wasiai-facilitator`).
- Puede correr en paralelo, en un worktree propio, con cualquier otra HU que
  no toque estos 5 archivos.
- Si se abren WKH-346 (ids vacíos, `discovery.ts`) o WKH-347 (doc de wallets),
  no comparten archivo con esta HU — pueden ir en paralelo sin coordinación.

---

## Nota de cierre: por qué es UNA HU (ésta) y no tres en la misma bolsa

Los tres hallazgos del encargo comparten el síntoma "la superficie pública
dice/hace algo que no corresponde", pero tienen:

- **causas distintas**: (1) es un GUARD DE FORMATO ausente en el borde HTTP,
  reproducible y arreglable con el mismo patrón ya probado en `tasks.ts`; (2)
  es un FALLBACK de serialización mal elegido en un mapper (`?? ''` en vez de
  `?? slug`); (3) es —en el mejor de los casos que pude confirmar— un vacío de
  CONTEXTO en documentación, sin código de por medio.
- **archivos y riesgo distintos**: (1) toca 5 archivos de `src/routes`+`src/lib`,
  incluyendo un archivo de dinero (`payments.ts`); (2) toca 1 línea de
  `src/services/discovery.ts`; (3) toca 0 líneas de `src/` (si el candidato
  identificado es correcto).
- **estado de verificación distinto**: (1) está confirmado por lectura directa
  del código en las 4 rutas; (2) tiene causa raíz confirmada pero el número
  "22" del encargo no lo pude re-medir con las herramientas de esta sesión; (3)
  tiene un candidato razonable pero NO un barrido completo.

Meterlos en una sola HU habría forzado a que el gate `HU_APPROVED` apruebe a
la vez un fix de código bien entendido, un fix de código de una línea sin
número re-medido, y una acción de documentación sin barrido completo — tres
niveles de confianza distintos bajo una sola aprobación. Se separan. Esta HU
(WKH-345) es la única de las tres que entrego lista para F2 hoy.
