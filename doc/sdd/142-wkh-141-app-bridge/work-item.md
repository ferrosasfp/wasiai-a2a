# Work Item — [WKH-141] Bridge APP-compatible (Agent Payments Protocol de OKX)

> NNN asignado: 142. Título normalizado: wkh-141-app-bridge.
> Fecha: 2026-07-04. Origen: roadmap OKX Wave 3 — Strategic (`doc/competitive/attack-plan-2026-07.md`),
> derivado de `doc/competitive/okx-ai-analysis-2026-07.md` ítem 10 ("Implementar un
> Broker/bridge compatible con APP"). Depende de WKH-135 (intents `session`/`upto`,
> DONE — fila 137 de `_INDEX.md`).

---

## Resumen

La HU original de Jira pide "un Broker/bridge compatible con APP (MPP EVM + x402
+ ERC-8004 + XMTP + MCP)", afirmando que ya somos ~80% compatibles. Groundeando:
esa cifra viene de `doc/competitive/okx-ai-analysis-2026-07.md` (línea 15) y es
una **lectura/interpretación nuestra del whitepaper de APP** — este repo NO tiene
el schema/wire-format exacto de APP (no hay un `.json`/OpenAPI/spec file de OKX
en `doc/` ni en ningún otro lado). Eso cambia radicalmente qué es seguro construir
ahora: un endpoint que "acepta un intent APP" implicaría parsear un wire-format de
un tercero que no tenemos confirmado — eso no es "cerrar el 20%", es inventar el
20% restante, lo cual está explícitamente prohibido para este agente.

Por eso el v1 propuesto **NO es el bridge inbound completo**. Es la pieza más
concreta, demostrable y de menor riesgo que no requiere adivinar el spec ajeno:
una **declaración de capacidades APP-compatibles en el Agent Card** (outbound,
aditiva, cero riesgo de parseo de payloads ajenos) más un **adaptador interno de
mapeo** (función pura, sin persistencia nueva, sin endpoint público) que traduce
nuestros intents ya existentes (`charge` vía x402, `session`/`upto` vía WKH-135)
a un envelope con el vocabulario de APP — documentado explícitamente como
"alineación conceptual/mapeo best-effort", no como interop verificada end-to-end
contra una contraparte real de OKX.

El bridge inbound real (aceptar payloads de agentes OKX) queda bloqueado hasta
que el humano confirme acceso al spec exacto (ver Missing Inputs — bloqueante).

---

## Sizing

- **SDD_MODE:** full (QUALITY) — toca el Agent Card (contrato público consumido
  por wasiai-v2 y terceros) y el vocabulario de payment intents (money-path
  adyacente, aunque el v1 no toca settlement real).
- **Estimación:** S/M para el v1 acotado (campo aditivo + función de mapeo pura +
  feature flag). La HU original (L, "Broker/bridge completo con XMTP") NO se
  implementa entera acá — sería un epic de varias HUs.
- **Clasificación NexusAgil:** QUALITY
- **Branch sugerido:** `feat/142-wkh-141-app-capability-declaration`

## Skills Router
- `api-contract-design` — el campo nuevo en Agent Card es un contrato público
  (consumido hoy por wasiai-v2 y cualquier registry externo); debe ser aditivo,
  versionado y sin romper el schema actual.
- `money-path-review` — aunque el v1 no toca settlement, el vocabulario que
  declara (`charge`/`session`/`upto`) referencia primitivas de dinero reales
  (WKH-135); un nombre o mapeo mal declarado puede inducir a un caller externo a
  intentar un flujo de pago que no existe tal cual lo anuncia.

## Contexto grounding (archivos reales revisados)
- `doc/competitive/okx-ai-analysis-2026-07.md` (líneas 14-16, 43, 54-55) — fuente
  de la HU. Confirma: (a) APP es UN wire-format con dos transports (A2A/A2MCP),
  no dos protocolos separados; (b) los 4 intents (`charge`/`escrow`/`session`/
  `upto`) son el gap de producto más grande; (c) la cifra "~80% alineados" es una
  lectura nuestra, no una certificación externa.
- `doc/sdd/137-wkh-135-payment-intents-session-upto/work-item.md` +
  `done-report.md` — WKH-135 (DONE): ya existen `session`/`upto` con naming APP
  ("session"/"upto" literales en `payments.ts:172,307`), full money-path, 5 RPCs
  atómicos, 4 fix-packs de dinero cerrados. Es la base que este bridge reutiliza,
  NO reimplementa.
- `src/routes/payments.ts` — shape REAL de nuestros endpoints hoy: `POST
  /session`, `/session/:id/voucher`, `/session/:id/close`, `POST /upto`,
  `/upto/:id/settle`. Campos internos (`keyId`, `sellerRef`, `payTo`, `chainId`,
  `depositUsd`, `capUsd`, `capSignature`, `typedData` EIP-712) — **este shape es
  nuestro, NO el de APP**. No hay garantía de que coincida byte-a-byte con lo que
  un cliente APP real enviaría.
- `src/middleware/x402.ts` — el intent `charge` hoy es un 402-challenge +
  settle atómico. Referencia para lo que ya hablamos de x402 (parte del stack
  de APP).
- `src/services/agent-card.ts` — generador del Agent Card (Google A2A). Punto de
  extensión natural para declarar capacidades adicionales sin tocar el
  money-path; consumido hoy por `GET /agents/:id/agent-card` y por discovery.
- `src/adapters/erc8004-identity.ts` / `erc8004-reputation.ts` /
  `erc8004-reputation-writer.ts` — ya hablamos ERC-8004 (identity read + write-back
  de reputación, WKH-133 DONE). Parte del stack APP que ya cubrimos, sin trabajo
  adicional para este bridge.
- No se encontró ningún archivo de spec de APP (schema JSON, OpenAPI, whitepaper)
  en el repo. La única fuente es el análisis competitivo (interpretación propia).

---

## Acceptance Criteria (EARS) — v1 acotado: "APP Capability Declaration + Internal Mapping"

### AC-1 — Declaración aditiva de intents en el Agent Card
WHEN se solicita `GET /agents/:id/agent-card` para un agente cuya cuenta soporta
los payment intents `charge`/`session`/`upto` (WKH-135), the system SHALL incluir
un campo aditivo nuevo (p.ej. `capabilities.paymentProtocols` o
`extensions.appCompatibility`, shape exacto a confirmar en F2) que liste los
nombres de intent en el vocabulario de APP que soporta, SIN alterar ningún campo
existente del Agent Card consumido hoy por wasiai-v2/discovery.

### AC-2 — Adaptador interno de mapeo, sin persistencia ni endpoint público
WHEN el adaptador de mapeo interno (`src/adapters/app-intent-mapper.ts` o
equivalente) recibe el resultado de una operación ya existente de
`PaymentIntentService` (open/close de `session`, create/settle de `upto`) o del
middleware `charge` (x402), the system SHALL producir un objeto envelope
documentado y versionado con el vocabulario de APP (best-effort, no persistido,
no expuesto por ningún endpoint HTTP en este v1) — función pura, cero I/O nuevo.

### AC-3 — Prohibido aceptar payloads ajenos sin spec confirmado
IF no existe confirmación humana del schema/wire-format exacto de APP (ver
Missing Inputs, bloqueante), THEN the system SHALL NO exponer ningún endpoint
público que parsee o acepte payloads JSON con el wire-format de APP como input
no confiable de un tercero — el v1 se mantiene estrictamente outbound
(declaración) + interno (mapeo), nunca inbound (aceptar input ajeno).

### AC-4 — Feature flag default OFF, cero cambio de comportamiento
WHILE la feature flag `APP_BRIDGE_ENABLED` (o nombre equivalente a confirmar en
F2) está OFF (default), the system SHALL comportarse byte-idéntico al estado
actual — el campo nuevo del Agent Card no aparece, el adaptador de mapeo no se
invoca desde ningún path de request real, cero regresión.

### AC-5 — Sin regresión en el Agent Card ni en discovery
WHEN la suite de tests existente de `agent-card.ts`/`discover` corre después del
cambio, the system SHALL mostrar cero regresiones en el shape/campos ya
consumidos por wasiai-v2 u otros registries — el campo nuevo es estrictamente
aditivo (nunca reemplaza ni renombra un campo existente).

### AC-6 — Positioning honesto en cualquier superficie pública
IF se documenta o comunica (README, docs públicas, pitch) la existencia de esta
declaración de capacidades, THEN the system/docs SHALL aclarar explícitamente que
es una **alineación conceptual/vocabulario compartido**, NO una certificación de
interoperabilidad verificada end-to-end contra una contraparte real de OKX/APP —
prohibido afirmar "100% APP-compatible" o "certificado" sin esa aclaración.

---

## Scope IN

| Archivo / Módulo | Qué se toca |
|---|---|
| `src/services/agent-card.ts` | Campo aditivo nuevo de capacidades APP-compatibles (shape exacto a definir en F2) |
| `src/adapters/app-intent-mapper.ts` (nuevo) | Función pura de mapeo: nuestros intents (`charge`/`session`/`upto`) → envelope con vocabulario APP. Sin I/O, sin persistencia |
| Feature flag (env var, patrón WKH-133 reputation-writeback) | `APP_BRIDGE_ENABLED` default `false`/off |
| `test/` | Tests del campo aditivo (shape, no-regresión), tests unitarios del mapper (inputs conocidos → envelope esperado), test de flag OFF = no-op |
| `doc/` (líneas de docs, no README completo) | Aclaración de "alineación conceptual" si se documenta públicamente (AC-6) |

## Scope OUT (explícito)

- **NO** se construye ningún endpoint que acepte/parsee payloads reales de APP
  (inbound) — bloqueado por falta de spec confirmado (Missing Inputs #1).
- **NO** se implementa XMTP como transport — es net-new grande (mensajería
  descentralizada, librería/identidad distinta a todo lo que hablamos hoy),
  candidato casi seguro a quedar fuera incluso de un v2 del bridge.
- **NO** se implementa MPP (Multi-Party Payments / splits atómicos con
  contrapartes reales de APP) — eso ya existe como primitiva propia (WKH-136,
  splits bps, DONE) pero conectarlo al MPP real de APP requeriría el mismo spec
  bloqueante que el resto del bridge.
- **NO** se modifica el comportamiento de `charge` (x402), `session`/`upto`
  (WKH-135), ni el settlement real — el v1 es puramente declarativo/mapeo
  interno, cero cambio de money-path.
- **NO** se certifica ni se prueba interoperabilidad real contra un endpoint de
  OKX/APP — no tenemos acceso a una contraparte de test.
- **NO** se decide la dirección final del bridge (inbound vs outbound) — el v1
  es intencionalmente neutral/reutilizable en cualquier dirección futura.

---

## Decisiones técnicas (DT-N)

**DT-1 — v1 es outbound-declaración + mapeo interno, nunca inbound.**
Aceptar/parsear un wire-format de un tercero sin el schema exacto confirmado es
una superficie de ataque nueva (mismo tipo de riesgo que WKH-60/SEC-RCE-1 y
WKH-62/SEC-SSRF-1, ya remediados en este proyecto: parsear input no confiable
sin validación estricta = vector de inyección/deserialización). Por eso el v1
solo declara capacidades propias (outbound) y mapea nuestros datos ya validados
(interno), sin abrir superficie de parseo de datos ajenos.

**DT-2 — Reuso total de WKH-135 como fuente de verdad.**
El adaptador de mapeo NO reimplementa lógica de settlement ni introduce un
"tercer modelo" de payment intent — traduce el resultado YA validado de
`PaymentIntentService`/`x402` middleware a un envelope de vocabulario distinto.
Cero duplicación de lógica de dinero.

**DT-3 — Feature flag default OFF (mismo patrón que WKH-133 reputation-writeback).**
Permite mergear y probar en CI/staging sin activar la afirmación pública de
compatibilidad hasta que el humano ratifique el positioning (AC-6) y,
eventualmente, el acceso al spec real para un v2 inbound.

---

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO exponer cualquier endpoint HTTP que acepte/parsee un
  payload con el wire-format de APP como input no confiable de un tercero sin
  confirmación humana explícita del schema exacto — cualquier PR que lo haga se
  marca BLOQUEANTE en AR (equivalente en severidad a un problema de
  deserialización insegura, ver CLAUDE.md tabla de deudas de seguridad).
- **CD-2**: OBLIGATORIO que el campo nuevo del Agent Card sea 100% aditivo — no
  renombra, no remueve, no cambia el tipo de ningún campo existente consumido
  hoy por `wasiai-v2` u otro registry (verificar contra
  `src/services/agent-card.test.ts` y cualquier consumidor conocido).
- **CD-3**: PROHIBIDO afirmar en cualquier doc/README/pitch "certificado
  APP-compatible" o "100% compatible" sin la aclaración de AC-6 (alineación
  conceptual, no interop verificada).
- **CD-4**: OBLIGATORIO feature flag default OFF; el comportamiento con la flag
  apagada debe ser byte-idéntico al estado pre-HU (test explícito de
  no-regresión con la flag OFF).
- **CD-5**: PROHIBIDO que el adaptador de mapeo (`app-intent-mapper.ts`)
  introduzca I/O (DB, red, filesystem) — debe ser una función pura, testeable
  sin mocks de infraestructura.

---

## Categorías de riesgo (para Architect/Adversary en F2/AR)

| Categoría | Riesgo |
|---|---|
| **Mapeo de protocolo / drift semántico** | Nuestro `session`/`upto` (WKH-135) comparte nombre con los intents de APP pero el modelo exacto (quién firma qué, cuándo se settlea, qué campos exige) puede diferir del real de OKX. Declarar "compatible" sin el spec confirmado puede ser engañoso para un caller externo real — mitigado por AC-6 (positioning honesto) y por mantener el v1 estrictamente outbound. |
| **Seguridad del wire-format ajeno** | Si en el futuro (v2) se decide aceptar payloads reales de APP, parsear un schema de un tercero sin especificación confirmada es una superficie de inyección/deserialización nueva — mismo patrón de riesgo que los hallazgos ya remediados WKH-60 (RCE vía cache poisoning) y WKH-62 (SSRF). El v1 de esta HU evita ese riesgo por diseño (DT-1/CD-1), pero el Architect debe dejarlo documentado como precondición dura para cualquier v2 inbound. |
| **Contrato público (Agent Card)** | Cualquier campo nuevo en un contrato consumido por wasiai-v2/terceros es, de facto, una API pública — un cambio no-aditivo rompe consumidores fuera de este repo sin aviso. |
| **Reputacional / positioning** | Afirmar compatibilidad con un protocolo de un competidor directo (OKX.AI) sin verificación real puede ser usado en contra si un tercero prueba que no interopera de verdad — CD-3/AC-6 mitigan, pero es una decisión de producto, no solo técnica. |
| **Scope creep** | La tentación de "ya que estamos, conectemos XMTP o el MPP real" en la misma HU — explícitamente OUT. |

---

## Missing Inputs — decisiones que el humano debe resolver

| # | Ítem | Estado |
|---|---|---|
| 1 | **Acceso al spec exacto/wire-format de APP** (schema JSON, OpenAPI, o documentación técnica oficial de OKX más allá del whitepaper narrativo que ya leímos). Sin esto, cualquier endpoint que "acepte un intent APP" real sería inventado. Determina si un v2 inbound es siquiera viable. | [NEEDS CLARIFICATION — BLOQUEANTE para cualquier v2 inbound; NO bloquea el v1 de esta HU, que es deliberadamente outbound-only] |
| 2 | **Transport**: A2A (HTTP/JSON-RPC) ya lo hablamos. XMTP es transporte net-new grande (mensajería descentralizada, librería e identidad distintas). Casi seguro OUT incluso de un v2 — requiere su propia HU/epic si se decide perseguir. | [NEEDS CLARIFICATION — no bloquea el v1; bloquea cualquier HU de "transport XMTP"] |
| 3 | **Dirección del bridge**: ¿inbound (agentes/brokers de OKX invocan wasiai-a2a hablando APP) o outbound (wasiai-a2a invoca agentes/brokers de OKX hablando su protocolo)? La HU de Jira sugiere inbound ("agentes de OKX transan por nuestra capa neutral"), que es la dirección de MAYOR riesgo (parsear wire-format ajeno). El v1 de esta HU es neutral a esta decisión (declaración + mapeo reusable en cualquier dirección). | [NEEDS CLARIFICATION — BLOQUEANTE para decidir el v2; no bloquea el v1] |
| 4 | Shape exacto del campo nuevo en el Agent Card (`capabilities.paymentProtocols` vs `extensions.appCompatibility` vs otro) — decisión de diseño menor. | [resuelto en F2, no bloqueante] |
| 5 | Si la feature flag debe ser global o por-agente (opt-in por agente a declarar compat APP) — algunos operadores de agentes podrían no querer esa declaración pública. | [resuelto en F2, no bloqueante] |

---

## Análisis de paralelismo

- **Depende de** WKH-135 (`session`/`upto`, DONE, fila 137 de `_INDEX.md`) — ya
  disponible, sin bloqueo técnico para el v1.
- **No bloquea** ninguna HU activa — es aditivo (campo de Agent Card + módulo
  nuevo sin I/O).
- **Comparte archivo** `src/services/agent-card.ts` con cualquier otra HU futura
  que lo toque — verificar conflictos de merge antes de F3 si hay trabajo
  paralelo sobre Agent Cards.
- **Bloquea conceptualmente** (no técnicamente) cualquier v2 real del bridge
  (inbound, XMTP, MPP real) — esos quedan condicionados a Missing Input #1
  (acceso al spec real de APP), que es una decisión/gestión externa al equipo de
  ingeniería (conseguir el documento técnico de OKX, no algo que se resuelva en
  código).
- **Independiente** de WKH-137 (invocation links, DONE) y WKH-138 (gasless
  Avalanche/Base, DONE) — no comparten código.

---

*Generado por nexus-analyst (F0+F1). No incluye SDD ni Story File — eso es F2/F2.5
del Architect, después de HU_APPROVED.*
