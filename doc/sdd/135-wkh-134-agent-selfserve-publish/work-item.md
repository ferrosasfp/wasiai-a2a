# Work Item — [WKH-134] SDK + publish self-serve de 1 agente en <5 min

## Resumen
Hoy `POST /registries` solo permite registrar una **URL de marketplace**
(`discoveryEndpoint` + `invokeEndpoint`, ambos obligatorios) — un dev solista
que quiere exponer un único agente debe simular ser un marketplace entero
(montar un endpoint de discovery que devuelva un array con un solo agente).
Esta HU ataca ese gap de adopción (identificado vs OKX en
`doc/competitive/okx-ai-analysis-2026-07.md`, P0-#3): un endpoint/flujo
self-serve para publicar **un solo agente** (URL + Agent Card) y que quede
inmediatamente descubrible en `/discover`, sin operar infraestructura de
marketplace. Público objetivo: developers individuales / equipos chicos que
hoy tienen que renunciar a listar su agente por la fricción de tener que
"ser un marketplace".

## Sizing
- SDD_MODE: full
- QUICK_FLOW: **QUALITY** (justificación: toca registro/discovery [superficie
  ya identificada como sensible: WKH-62 SSRF, WKH-63 ownership/IDOR,
  WKH-SEC-02c RLS] + auth + valida URLs de terceros arbitrarias suministradas
  por el caller. Es exactamente el tipo de endpoint que ya generó 3 HUs de
  seguridad previas sobre `/registries`. Mínimo aceptable sería FAST+AR, pero
  dado el patrón de incidentes repetidos sobre esta tabla, se sube a QUALITY
  para forzar SDD + Adversarial Review formales antes de tocar
  registro/discovery de nuevo).
- Estimación: M
- Branch sugerido: `feat/133-wkh-134-agent-selfserve-publish`

## Skills Router
- `nexus-agile` (metodología, obligatoria)
- Dominio: seguridad de endpoints públicos con inputs URL-shaped (SSRF /
  ownership) — mismo dominio que WKH-62/WKH-63/WKH-SEC-02c ya resolvieron;
  reusar sus patrones (`validateRegistryUrl`, `owner_ref` guard) en vez de
  reinventar.

## Acceptance Criteria (EARS)

- AC-1: WHEN un dev autenticado (`x-a2a-key` o `Authorization: Bearer`) llama
  al nuevo endpoint de publicación de agente individual con una `agentUrl`
  válida (y opcionalmente su propia Agent Card o los campos mínimos para
  generarla), the system SHALL crear un registro descubrible del agente sin
  requerir que el caller opere un `discoveryEndpoint`/`invokeEndpoint` propio.

- AC-2: WHEN el agente publicado vía el nuevo flujo es consultado, the system
  SHALL hacerlo aparecer en `GET/POST /discover` (y en
  `GET /discover/:slug`) en igualdad de condiciones que los agentes que hoy
  vienen de un registry de marketplace — mismo shape de respuesta.

- AC-3: IF la `agentUrl` (o cualquier URL saliente del payload) apunta a un
  destino bloqueado por las reglas SSRF vigentes (loopback, rango privado,
  metadata endpoint, esquema no-http(s), etc. — mismas reglas que
  `validateRegistryUrl` aplica hoy en `POST /registries`), THEN the system
  SHALL rechazar la publicación con `422 SSRF_BLOCKED` y NO persistir el
  registro, replicando el guard ya existente (no una versión débil o nueva).

- AC-4: WHEN dos callers con `owner_ref` distintos intentan publicar el mismo
  slug de agente, o un caller intenta actualizar/eliminar un agente publicado
  por otro `owner_ref`, THEN the system SHALL rechazar la operación
  (colisión de slug → 409/400 explícito; cross-owner mutation → mismo patrón
  disclosure-safe 404 que usa `registryService` hoy vía
  `OwnershipMismatchError`) — cero mutación cross-tenant.

- AC-5: WHEN un developer sigue el quickstart documentado end-to-end
  (signup → publish-agent → verificar en `/discover`), the system SHALL
  permitirle completar el ciclo con **como máximo 2 llamadas HTTP**
  (`POST /auth/agent-signup` ya existe + 1 llamada nueva de publish) y sin
  necesidad de escribir un `discoveryEndpoint` propio — medible como
  "tiempo de integración documentado < 5 min" en la doc nueva.

- AC-6: IF el payload de publicación no incluye los campos mínimos para
  construir un Agent Card válido (nombre, URL del agente, al menos una
  capability/skill), THEN the system SHALL responder `400` con un mensaje
  que liste los campos faltantes (mismo patrón de validación explícita que
  `POST /registries` usa hoy).

## Scope IN
- Nuevo endpoint (o extensión clara) en `src/routes/` para "publicar 1
  agente" — path/nombre y shape de payload exacto: **[NEEDS
  CLARIFICATION]**, a resolver en F2 (Architect). Debe reusar
  `requirePaymentOrA2AKey`, `validateRegistryUrl` (SSRF) y el patrón
  `ownerRef` de `registryService` — NO reinventar estos tres mecanismos.
- Persistencia: reusar la tabla `registries` (posible fila con
  `discoveryEndpoint`/`invokeEndpoint` sintéticos apuntando al propio agente,
  o extender el modelo con un tipo `single-agent`) vs. tabla nueva — **[NEEDS
  CLARIFICATION]**, decisión técnica de Architect en F2 (DT).
- Que el agente publicado aparezca en `/discover`, `/discover/:slug` y
  `/agents/:slug/agent-card` igual que hoy.
- Actualizar `doc/INTEGRATION.md` (o doc nuevo) con el quickstart de "publicar
  1 agente en <5 min", incluyendo ejemplo curl/fetch.
- Validaciones: SSRF (reusar `validateRegistryUrl`), ownership (reusar
  patrón `owner_ref`), campos mínimos de Agent Card.

## Scope OUT
- **El SDK cliente tipado (`wasiai-sdk`) como paquete npm publicado** — vive
  en el repo separado `wasiai-sdk` (ya existe, "thin"), NO en `wasiai-a2a`.
  Esta HU en `wasiai-a2a` es exclusivamente el **endpoint/flujo de servidor**
  + su documentación; el trabajo de empaquetar/publicar un cliente TS en npm
  es una HU distinta en el repo `wasiai-sdk` (fuera de este scope).
- CLI tipo `npx skills add` (paridad OKX) — no se construye acá.
- MCP Skills discovery nativo — no se construye acá.
- Cambios al schema de Agent Card en sí (`src/services/agent-card.ts`) más
  allá de lo necesario para aceptar el nuevo flujo de publicación.
- Reputation write-back ERC-8004 (P0-#2 del doc competitivo — HU separada).
- UI/dashboard para publicar agentes (solo API + docs en esta HU).
- Verificación on-chain de ownership del agente (ERC-8004 bind) — el
  ownership acá es solo `owner_ref` de la key del caller, igual que
  `/registries` hoy.

## Decisiones técnicas (DT-N)
- DT-1: El nuevo flujo DEBE reusar `validateRegistryUrl` /
  `SSRFViolationError` tal cual existen en `src/lib/url-validator.ts` — no se
  permite una validación de URL paralela o debilitada para "URLs de agente".
- DT-2: El nuevo flujo DEBE reusar el patrón `owner_ref` +
  `OwnershipMismatchError` de `src/services/registry.ts` (o el service que
  lo reemplace) — mismo disclosure-safe 404 en mutaciones cross-owner.
- DT-3 [NEEDS CLARIFICATION — para Architect F2]: ¿el "publish 1 agente" es
  una fila más en `registries` (con `discoveryEndpoint`/`invokeEndpoint`
  auto-derivados del `agentUrl` del propio agente) o requiere una tabla /
  concepto nuevo (`a2a_agents` standalone, sin marketplace padre)? Esto
  determina si `discoveryService.discover()` necesita cambios o si el fix es
  puramente en el registro.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO introducir una validación de SSRF nueva o distinta de
  `validateRegistryUrl` para las URLs que trae este endpoint (agentUrl y
  cualquier URL derivada). Toda URL saliente pasa por el validador existente.
- CD-2: PROHIBIDO persistir el registro del agente sin `owner_ref` del
  caller autenticado (mismo guard que WKH-63/WKH-SEC-02c). No hay path
  anónimo/x402-only que pueda publicar o mutar un agente.
- CD-3: OBLIGATORIO que Adversarial Review (F2/AR) verifique explícitamente,
  citando archivo:línea: (a) el nuevo endpoint llama a `validateRegistryUrl`
  antes de persistir, (b) toda mutación filtra por `owner_ref`, (c) no hay
  mensaje de error que filtre la existencia de un slug/agente de otro owner
  (paridad con el patrón disclosure-safe ya usado en `registries.ts`).
- CD-4: PROHIBIDO tocar el paquete/repo `wasiai-sdk` desde esta HU — si
  Architect/Dev detectan necesidad de tocarlo, se documenta como HU
  separada, no se expande el scope acá.

## Missing Inputs
- [NEEDS CLARIFICATION — bloqueante para F2] Nombre y path exacto del nuevo
  endpoint (p.ej. `POST /agents` vs `POST /registries/agent` vs
  `POST /publish`). Definir en F2 junto con el shape de payload.
- [NEEDS CLARIFICATION — bloqueante para F2] Modelo de datos: ¿reusar
  `registries` con un discriminador `type: 'single-agent' | 'marketplace'`,
  o tabla nueva? Impacta migración DB (requiere runbook de
  `075-wkh-78-migration-preflight`).
- [NEEDS CLARIFICATION — resuelto en F2] ¿El endpoint acepta un Agent Card
  A2A completo (JSON) como input, o campos sueltos (`name`, `agentUrl`,
  `capabilities[]`) que el gateway ensambla en un Agent Card? Afecta AC-6 y
  la UX del quickstart <5 min.
- [NEEDS CLARIFICATION — resuelto en F2] ¿Se cobra fee o requiere budget para
  publicar (como `/registries` hoy, que exige `requirePaymentOrA2AKey`), o
  el publish es gratis con solo `x-a2a-key` sin pago? El humano no especificó
  monetización de este endpoint.

## Análisis de paralelismo
- No bloquea ninguna HU en curso; es independiente del pipeline de billing
  (WKH-127/129/130/132) y de la capa de identidad (WKH-100/101/103).
- Puede correr en paralelo con cualquier HU de `wasiai-v2` (consumer del
  gateway) — no las bloquea porque `/registries` sigue funcionando igual
  (esta HU es aditiva, no reemplaza el flujo de marketplace).
- Bloquea (lógicamente, no técnicamente) el trabajo de empaquetar
  `wasiai-sdk` como cliente completo: el SDK va a querer envolver este
  endpoint una vez exista, así que conviene que esta HU termine antes de que
  se le pida al repo `wasiai-sdk` soportar "publish agent" en el cliente
  tipado. No es un bloqueo duro (son repos separados) pero sí de secuencia
  recomendada.
- Reusa infraestructura de seguridad ya endurecida por WKH-62 (SSRF),
  WKH-63/WKH-SEC-02c (ownership/RLS) — no requiere volver a auditar esas
  piezas, solo verificar que el nuevo endpoint las invoca correctamente.
