# Work Item — [WKH-137] Pagos IM-native + QR (WhatsApp/Telegram) sin hostear HTTP

> NNN asignado: 139. Título normalizado: wkh-137-im-qr-payments.
> Fecha: 2026-07-03. Origen: roadmap OKX Wave 2 (`doc/competitive/attack-plan-2026-07.md`), derivado de `doc/competitive/okx-ai-analysis-2026-07.md` ítem P1/#6.

---

## Resumen

La HU original pide "invocar y cobrar un agente por WhatsApp/Telegram o un
QR/link, sin requerir que el seller hostee un endpoint HTTP". Groundeando
contra el código real, esto son **dos problemas distintos de tamaño muy
distinto**, y la HU tal como está redactada los mezcla:

1. **Lado consumidor (buyer)**: dejar que un humano invoque y pague un agente
   ya registrado (HTTP-hosted, self-published o marketplace) desde un canal
   IM/QR en vez de una app/PWA. Esto es alcanzable hoy reusando infra
   existente (`POST /orchestrate/plan`+`/execute` de WKH-131, session keys
   sin wallet de WKH-121, `resolveAgentPriceUsdc`).
2. **Lado vendedor (seller) "sin hostear HTTP"**: hoy TODO agente registrado
   en wasiai-a2a (marketplace o self-published, WKH-134) tiene un
   `agent_url`/`invokeUrl` HTTP resoluble — es un invariante del modelo de
   discovery/compose actual (`src/services/compose.ts`, `src/services/agent.ts`).
   Remover ese requisito para el VENDEDOR (que el gateway reciba pedidos por
   IM y se los reenvíe a un seller sin URL pública — polling, relay, webhook
   invertido) es un cambio de modelo de invocación, no una feature aditiva.
   **No está resuelto por nada de lo que existe hoy** y es sustancialmente
   más grande que el punto 1.

**Este work item cubre SOLO el punto 1** (lado consumidor), acotado a una
única primitiva protocolar nueva en wasiai-a2a: un **link de invocación
opaco, single-use, con price-cap**, que cualquier canal externo (bot de
Telegram/WhatsApp, página redimida desde un QR) puede mintear y redimir
reusando el money-path existente. El punto 2 (seller sin HTTP) y la
implementación real del bot/canal IM quedan **fuera de esta HU**, marcados
como fases siguientes (ver Missing Inputs).

---

## Sizing

- **SDD_MODE:** full (money-path — CLAUDE.md: dinero siempre QUALITY con AR/CR obligatorio)
- **Estimación:** S/M para el v1 acotado (mint+redeem de invocation-links, reusa infra existente). La HU original (L) NO se implementa entera acá.
- **Clasificación NexusAgil:** QUALITY
- **Branch sugerido:** `feat/139-wkh-137-invocation-links`

---

## Acceptance Criteria (EARS) — v1 acotado: "Invocation Links"

### AC-1 — Mint de link opaco, single-use, price-capped
WHEN un caller autenticado (Agent Key o session key existente, WKH-121) invoca `POST /agents/:slug/link` con `{maxPriceUsdc, ttlSeconds?}`, the system SHALL mintear un token opaco (mismo patrón que `wasi_a2a_sess_*`: persistir solo su hash, nunca el token crudo) atado a `{slug, owner_ref del caller, maxPriceUsdc, expiresAt}`, y SHALL retornarlo una única vez en el body del 201.

### AC-2 — Redeem exitoso invoca bajo el precio cap
WHEN `POST /agents/links/:token/redeem` es llamado con un token válido, no expirado y no usado, the system SHALL resolver el precio actual del agente vía `resolveAgentPriceUsdc`, y SI `currentPriceUsdc <= maxPriceUsdc` ENTONCES SHALL invocar el agente a través del path de compose existente bajo el `owner_ref`/key del token, y SHALL marcar el token como consumido de forma atómica (no redimible dos veces).

### AC-3 — Redeem rechazado si el precio excede el cap
IF `POST /agents/links/:token/redeem` resuelve `currentPriceUsdc > maxPriceUsdc`, THEN the system SHALL responder `409 PRICE_EXCEEDS_LINK_CAP` SIN debitar ni invocar el agente, y SIN consumir el token (el caller puede reintentar o el link expira por TTL).

### AC-4 — Tokens inválidos/expirados/usados no invocan nada
IF `POST /agents/links/:token/redeem` recibe un token inexistente, expirado o ya consumido, THEN the system SHALL responder `404 LINK_NOT_FOUND`, `410 LINK_EXPIRED` o `409 LINK_ALREADY_USED` respectivamente, sin ningún debit ni intento de invocación.

### AC-5 — Links son inmutables tras el mint
WHILE un link no fue redimido ni expiró, the system SHALL NO exponer ningún endpoint que permita modificar su `slug`, `owner_ref` o `maxPriceUsdc` — mint-once, sin PATCH.

### AC-6 — Invariantes de money-path preservadas en redeem
WHEN un redeem exitoso debita al owner del link, the system SHALL aplicar las mismas invariantes que `/compose` hoy: fee de protocolo, receipt (`receiptService`), y el Ownership Guard (`owner_ref` en toda query sobre `a2a_agent_keys`, ver CLAUDE.md) — el redeem NO es un bypass nuevo del guard de ownership.

### AC-7 — Sin datos de invocación en el propio token
WHERE el token es consumido por un canal externo (bot, página QR) que el gateway no controla, the system SHALL diseñar el token para que su exposición (leak, screenshot, forward accidental en un chat) NO otorgue más que "ejecutar este agente una vez hasta este price-cap" — nunca acceso al balance completo de la key, a otros agentes, ni a operaciones de gestión de la key (mint/list/revoke de otros links o sessions).

---

## Scope IN

| Archivo / Módulo | Qué se toca |
|---|---|
| `src/routes/` (nueva ruta, p.ej. `agent-links.ts`) | `POST /agents/:slug/link` (mint), `POST /agents/links/:token/redeem` |
| `src/services/` (nuevo, p.ej. `agent-link.ts`) | Mint (hash-only storage, mismo patrón que `key-session.ts`), redeem (lookup + price-check + invoke + consumo atómico) |
| DB (nueva tabla, p.ej. `a2a_agent_links`) | `token_hash`, `slug`, `owner_ref`, `max_price_usdc`, `expires_at`, `consumed_at`, `created_at` — con `owner_ref` desde el día 1 (Ownership Guard, CLAUDE.md) |
| `src/services/agent-price.ts` | Solo lectura — reusar `resolveAgentPriceUsdc` tal cual |
| `src/services/compose.ts` | Solo lectura/reuso — invocar vía el path existente, sin tocar el guard `i>0` ni la lógica interna |
| `test/` | Tests del mint + redeem: happy path, price-exceeds-cap, expired, already-used, ownership cross-tenant |

## Scope OUT (explícito)

- **NO** se implementa el bot de Telegram ni de WhatsApp Business API en esta HU — eso es una app consumidora (repo nuevo, análogo a Chaski/yarvis), no el gateway.
- **NO** se genera ni hostea la imagen QR ni una página web de "redeem" — el link/token es la primitiva protocolar; renderizarlo como QR o como mensaje de chat es responsabilidad del canal (fuera de wasiai-a2a).
- **NO** se resuelve "el seller no hostea HTTP" — sigue siendo un invariante del modelo actual que todo agente tiene `agent_url`/`invokeUrl` resoluble. Este punto queda **explícitamente sin resolver** y marcado como posible epic separado (ver Missing Inputs).
- **NO** se crea un mecanismo de onboarding/signup nuevo para usuarios que nunca tuvieron una Agent Key — el mint de un link requiere una key/session existente y autenticada.
- **NO** se modifica `/orchestrate/plan`, `/orchestrate/execute` ni `/compose` internamente — el redeem es un caller más de esos paths existentes.
- **NO** se implementa `session`/`upto` sobre IM — los links de esta HU son de un solo uso, no metered.

---

## Decisiones técnicas (DT-N)

**DT-1 — El link es una autorización pre-firmada, no una wallet.**
El "cómo se paga desde un chat" (clarificación pedida por el orquestador) se
resuelve, para este v1, delegando la autorización al MOMENTO DEL MINT (un
humano ya autenticado con su Agent Key/session key decide "autorizo hasta
$X para este agente" y comparte el link resultante) en vez de intentar que el
canal IM maneje firmas EIP-712 o custodia. Esto reusa 100% el patrón de
session keys (WKH-121) que ya evita pedir wallet al usuario final.

**DT-2 — Redeem es de un solo uso, no reusable como "suscripción".**
Un link autoriza EXACTAMENTE una invocación. Si el caso de uso real (WhatsApp
recurrente) necesita múltiples invocaciones desde el mismo link, eso es
`session`/`upto` (WKH-135, ya existe) expuesto por otro canal, no esta HU.

**DT-3 — El mint requiere Agent Key/session key existente.**
No se resuelve en esta HU cómo un usuario que jamás usó WasiAI obtiene su
primera key desde dentro de un chat de Telegram. Eso es un flujo de
onboarding que toca `auth/signup.ts` y está fuera de scope (ver Missing
Inputs #4).

---

## Constraint Directives (CD-N)

**CD-1 — PROHIBIDO persistir el token crudo.**
Igual que `key-session.ts` (WKH-121): solo se persiste `SHA-256(token)`. El
token crudo se retorna UNA vez en el 201 del mint y nunca más se puede leer.

**CD-2 — OBLIGATORIO `owner_ref` en toda query de `a2a_agent_links`.**
Reusar el patrón de Ownership Guard de CLAUDE.md: todo `SELECT`/`UPDATE` sobre
la tabla nueva filtra por `owner_ref` además del token/id. El redeem no
requiere que el REDIMIDOR sea el owner (el punto es que cualquiera con el
link lo puede canjear — eso es "compartible por chat"), pero el MINT y
cualquier operación de listado/revocación de links SÍ deben filtrar por
`owner_ref` del caller autenticado.

**CD-3 — PROHIBIDO exceder el price-cap sin rechazo explícito (AC-3).**
El redeem NUNCA invoca el agente ni debita si `currentPriceUsdc > maxPriceUsdc`
resuelto server-side — el precio del cliente/canal externo nunca es la fuente
de verdad (mismo principio que `/orchestrate/execute`, WKH-131 AC-4).

**CD-4 — PROHIBIDO reusar un token consumido (single-use real).**
El consumo del token y el debit/invoke deben ser atómicos (mismo patrón que
`debit_session_and_parent`/RPC con `FOR UPDATE`) — dos redeems concurrentes
del mismo token NO deben poder invocar dos veces ni doble-cobrar.

---

## Categorías de riesgo (para Architect/Adversary en F2/AR)

| Categoría | Riesgo |
|---|---|
| **Seguridad — link leak** | Un link filtrado en un grupo de WhatsApp/Telegram público es canjeable por cualquiera hasta el price-cap. Mitigación parcial: TTL corto + cap explícito + single-use (AC-7), pero el Architect debe decidir si además se requiere un segundo factor (ej. redeem solo desde una IP/user-agent registrada, o requerir un PIN corto) — [NEEDS CLARIFICATION]. |
| **Money-path — race en redeem concurrente** | Doble redeem simultáneo del mismo token; requiere el mismo patrón atómico que sessions/delegations (CD-4). |
| **Ownership** | Nueva tabla `a2a_agent_links` debe seguir el patrón WKH-53/RLS desde el día 1, no como deuda técnica post-hoc. |
| **Scope creep** | La tentación de "ya que estamos, conectemos el bot de Telegram" en la misma HU — explícitamente OUT (Scope OUT). |
| **Ambigüedad de producto no resuelta** | Ver Missing Inputs — si el humano decide que el punto 2 (seller sin HTTP) es el foco real de WKH-137, este work item entero debe re-scopearse. |

---

## Missing Inputs — decisiones de producto/arquitectura que el humano debe resolver

Estas NO se inventan; bloquean iniciar F2 (SDD) más allá del v1 acotado
descrito arriba.

| # | Ítem | Estado |
|---|---|---|
| 1 | **Qué canal IM primero**: Telegram (bot API simple, gratis, sin aprobación) vs WhatsApp Business API (requiere aprobación de Meta, template messages, costo por conversación). El análisis competitivo asume "WhatsApp-first LATAM" pero técnicamente Telegram es mucho más rápido de shippear. | [NEEDS CLARIFICATION — bloqueante para cualquier HU de bot; NO bloquea el v1 de esta HU, que es channel-agnostic] |
| 2 | **Qué encodea el QR/link y cómo se paga desde un chat.** Resuelto PARCIALMENTE en este work item (DT-1/DT-2: el link es un token opaco pre-autorizado por alguien con key existente). Pendiente: ¿el QR encodea la URL de redeem directamente, o un deep-link a un bot (`t.me/bot?start=<token>`) que a su vez llama al redeem? | [NEEDS CLARIFICATION — resolver en F2 de la HU del canal, no de esta] |
| 3 | **El modelo arquitectónico de "invocar+cobrar sin hostear HTTP" (lado SELLER).** Esta es la ambigüedad más grande y NO se resuelve en esta HU. Opciones no evaluadas: (a) el gateway hostea un relay/webhook por-seller (el seller registra un "canal" en vez de una URL, y el gateway le hace polling o long-poll); (b) un "bot-as-a-service" donde el seller mismo corre un proceso liviano que hace polling a una cola del gateway; (c) no se resuelve — se redefine el alcance de WKH-137 a solo el lado consumidor (lo que hace este work item). | [NEEDS CLARIFICATION — bloqueante; requiere decisión de producto antes de cualquier HU de "seller sin HTTP"] |
| 4 | **Cómo se autentica/autoriza el pago en un canal IM para un usuario SIN Agent Key previa.** Groundeado: hoy `POST /auth/key-session` (WKH-121) requiere una master key ya autenticada. No hay flujo de "onboarding desde cero vía chat". | [NEEDS CLARIFICATION — si el caso de uso real es "usuario nuevo de WhatsApp nunca usó WasiAI", esta HU no lo resuelve; requiere signup flow nuevo] |
| 5 | **Repo nuevo (bot) vs cambios en el gateway.** Groundeado: con el v1 de esta HU (invocation links) + lo que YA existe (`/orchestrate/plan`+`/execute`, session keys, agent-card), un bot de Telegram podría implementarse **enteramente como repo nuevo, consumidor de la API de wasiai-a2a, sin más cambios en este repo** — mismo patrón que Chaski/yarvis. | [NEEDS CLARIFICATION — recomendación del Analyst: repo nuevo; requiere confirmación humana antes de abrir esa HU] |

---

## Análisis de paralelismo

- **No bloquea** ninguna HU activa — es aditivo (tabla + rutas nuevas).
- **Depende de** WKH-121 (session keys, DONE) y WKH-131 (`/orchestrate/plan`+`/execute`, DONE) — ambos ya en prod, sin bloqueo.
- **Puede ir en paralelo con** WKH-136 (splits, DONE) y cualquier HU que no toque `src/services/compose.ts` internamente (este work item solo lo LLAMA, no lo modifica).
- **Bloquea conceptualmente** (no técnicamente) una futura HU de "bot Telegram/WhatsApp real": esa HU necesita que el humano resuelva Missing Inputs #1, #2, #4, #5 antes de poder tener ACs EARS no ambiguos.
- **El punto 2 de la HU original (seller sin HTTP)** es un epic separado y más grande — no se puede paralelizar hasta que Missing Input #3 se resuelva; probablemente amerita su propio spike/F0 dedicado en vez de heredar el NNN 139.

---

*Generado por nexus-analyst (F0+F1). No incluye SDD ni Story File — eso es F2/F2.5 del Architect, después de HU_APPROVED.*
