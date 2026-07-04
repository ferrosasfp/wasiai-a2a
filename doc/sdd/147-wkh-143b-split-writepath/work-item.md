# Work Item — [WKH-143b] Write-path de creator/referral (cerrar el seam dormido de WKH-143)

## Resumen

WKH-143 (DONE, fila 144 `_INDEX.md`) cableó el ENGINE de splits para leer
`a2a_agents.payout_wallet`/`referrer_ref`, pero **ningún código escribe hoy
esas columnas** — el publish self-serve (WKH-134, `src/routes/agents.ts`
POST/PATCH) no las captura. Esta HU cierra ese write-path: el creador de un
agente self-published puede declarar su `payoutWallet` (y opcionalmente un
`referrerRef`, opaco) al publicar/editar, activando de verdad su cobro de
creator-split cuando `SPLIT_BPS_CREATOR > 0`. Testnet.

## Sizing

- SDD_MODE: full (QUALITY — toca el publish del money-path: input que
  determina quién cobra en `chargeProtocolFee`, requiere ownership guard +
  validación de wallet reforzadas)
- Estimación: S/M
- Branch sugerido: `feat/147-wkh-143b-split-writepath`

## F0 — Grounding (confirmado contra código real)

| Hecho | Evidencia |
|-------|-----------|
| POST `/agents` NO acepta `payoutWallet`/`referrerRef` hoy | `src/routes/agents.ts:79-208` — construye `PublishAgentInput` campo por campo (`name`, `agentUrl`, `capabilities`, `description`, `priceUsdc`, `inputSchema`, `outputSchema`, `discoverable`); no hay rama para wallet/referral. |
| PATCH `/agents/:slug` NO acepta esos campos hoy | `src/routes/agents.ts:213-310` — pasa `body` completo a `publishedAgentService.update`, pero `update()` (`src/services/agent.ts:404-500`) solo lee `name/description/capabilities/agentUrl/priceUsdc/inputSchema/outputSchema/discoverable` del `UpdateAgentInput`; cualquier otro campo del body es ignorado silenciosamente. |
| `PublishAgentInput`/`UpdateAgentInput` no tipan estos campos | `src/types/index.ts:118-150` — confirma que ni el tipo de entrada de POST ni el de PATCH declaran `payoutWallet`/`referrerRef`. |
| Columnas destino YA existen en prod (testnet) | `supabase/migrations/20260705000000_wkh136_fee_splits.sql:70-72` — `ALTER TABLE a2a_agents ADD COLUMN IF NOT EXISTS payout_wallet TEXT, referrer_ref TEXT`. Nullable, sin default, sin CHECK de formato a nivel DB. |
| Lectura de creator YA existe y funciona (read-side, DONE) | `src/services/agent-split-context.ts:37-79` (`resolveAgentSplitContext`) — para self-published, llama `publishedAgentService.getSplitContextRow(slug)` (`src/services/agent.ts:241-264`, YA implementado en WKH-143) y construye `creator = { wallet: row.payoutWallet, ownerRef: row.ownerRef }` si `payoutWallet` no es null. **Esta HU solo necesita poblar la columna — el read-side no se toca.** |
| Hallazgo crítico F0 (no estaba en el brief del user): `referrer_ref` NUNCA se lee para armar el `referral` de splits | `src/services/agent-split-context.ts:15-16,35,48,69` — comentario explícito DT-6: `"referral es SIEMPRE null en v1 (el mecanismo referrer_ref → wallet es Scope OUT)"`. `getSplitContextRow` SÍ devuelve `referrerRef` (línea 261), pero `resolveAgentSplitContext` lo IGNORA y siempre retorna `referral: null`. **Consecuencia: aunque esta HU persista `referrer_ref`, el split de referral SIGUE sin activarse en la práctica** — falta la resolución `referrer_ref → wallet` en el read-side, que es una pieza de producto no definida (ver Missing Inputs). |
| Validador de formato de wallet EVM — DUPLICADO existente, ninguna instancia exportada para reuso cross-módulo | `src/services/fee-split.ts:41,164-166` (`ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/`; función local `isValidWallet`, NO exportada) y `src/adapters/settle-verifier.ts:82` (mismo regex, comentado como "mirror"). Ninguno está pensado para importarse desde `src/services/agent.ts`/`src/routes/agents.ts`. |
| Patrón de validación 422 ya establecido en esta misma ruta | `src/routes/agents.ts:64-66,145-158,264-275` (`isValidPriceUsdc` + guard `priceUsdc` inválido → 422) — mismo patrón a replicar para `payoutWallet`. |
| Patrón de ownership guard ya establecido para PATCH | `src/services/agent.ts:404-500` (`update()`): pre-fetch por slug → `OwnershipMismatchError` si no existe o `owner_ref !== ownerRef` → 404 disclosure-safe (`agents.ts:300-301` `mapOwnershipError`); UPDATE final filtrado por `.eq('slug', slug).eq('owner_ref', ownerRef)` (TOCTOU defense-in-depth). El nuevo campo pasa por el MISMO guard sin código nuevo de ownership. |
| Privacidad ya establecida (CD-5 de WKH-143) | `src/services/agent.ts:59-71` (`PublishedAgentRecord`) y `mapRowToRecord` (`agent.ts:129-148`) NO incluyen `payout_wallet`/`referrer_ref` — deben seguir sin incluirlos tras esta HU (ninguna respuesta pública los expone). |

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `POST /agents` incluye `payoutWallet` con formato de address
  EVM válido (`^0x[0-9a-fA-F]{40}$`, mismo criterio que `resolveRecipients`),
  THE system SHALL persistir ese valor en `a2a_agents.payout_wallet` de la
  fila creada.
- **AC-2**: WHEN `PATCH /agents/:slug` incluye `payoutWallet` válido y el
  caller es el owner del agente, THE system SHALL actualizar
  `a2a_agents.payout_wallet` de esa fila (y solo esa), sin afectar otros
  campos no incluidos en el body.
- **AC-3**: IF `payoutWallet` está presente en el body (POST o PATCH) pero no
  cumple el formato de address EVM válido, THEN THE system SHALL rechazar
  con `422` (mismo patrón que el guard existente de `priceUsdc` inválido) y
  NO persistir ningún campo del request.
- **AC-4**: WHEN `POST`/`PATCH` incluye `referrerRef` como string no-vacío
  (tras `trim()`), THE system SHALL persistirlo en
  `a2a_agents.referrer_ref` tal cual fue declarado — opaco, sin resolución
  de wallet asociada en esta HU (ver DT-4/Scope OUT).
- **AC-5**: WHILE `payoutWallet` está ausente del body, THE system SHALL
  dejar `a2a_agents.payout_wallet` sin tocar (PATCH) o `NULL` (POST) — no se
  inventa ningún valor default.
- **AC-6**: IF un caller autenticado intenta `PATCH /agents/:slug` con
  `payoutWallet`/`referrerRef` sobre un slug que NO le pertenece (owner_ref
  distinto), THEN THE system SHALL responder `404` (patrón
  `OwnershipMismatchError` ya existente, disclosure-safe) sin persistir nada.
- **AC-7**: WHEN un agente self-published tiene `payout_wallet` válido
  seteado (vía esta HU) y `SPLIT_BPS_CREATOR > 0`, THE system SHALL, en la
  siguiente invocación cobrada de ese agente, rutear el leg de `creator` del
  protocol fee a esa wallet real (test de integración end-to-end sobre el
  read-side YA existente de WKH-143 — sin código nuevo en el money-path de
  cobro, solo verificación).
- **AC-8**: THE system SHALL NUNCA exponer `payout_wallet`/`referrer_ref` en
  ninguna respuesta pública (`201`/`200` de POST/PATCH, `GET /agents` list
  propia, `GET /agents/:slug/agent-card`, `/discover`) — hereda CD-5 de
  WKH-143 sin excepción.

## Scope IN

- `src/types/index.ts`: extender `PublishAgentInput`/`UpdateAgentInput` con
  `payoutWallet?: string` y `referrerRef?: string` (aditivo).
- `src/routes/agents.ts` (POST + PATCH): validar `payoutWallet` con el mismo
  criterio de formato EVM que `resolveRecipients` (422 si inválido, patrón
  idéntico al guard `priceUsdc`); pasar `referrerRef` (trim + no-vacío) sin
  validación de formato adicional; ambos campos opcionales.
- `src/services/agent.ts`: `publish()` y `update()` — persistir
  `payout_wallet`/`referrer_ref` en el insert/update row (asignación
  condicional, `exactOptionalPropertyTypes`); ownership guard reusado sin
  cambios (ya cubre estos campos porque pasan por el mismo `updateRow`).
- Compartir/exportar el validador de formato EVM en un único lugar en vez de
  crear un tercer duplicado (candidato: exportar `isValidWallet` desde
  `fee-split.ts`, o extraerlo a un módulo compartido, ej. `src/lib/
  wallet-format.ts`) — decisión de ubicación exacta en F2.
- Tests nuevos: publish/update persistiendo ambos campos; 422 en
  `payoutWallet` malformado (POST y PATCH); ownership guard (PATCH sobre
  agente de otro owner no filtra ni persiste); AC-7 integración end-to-end
  (creator split cobra a wallet real declarada vía este write-path,
  reusando fixtures de `fee-charge-splits.test.ts`/`agent-split-context.test.ts`);
  regresión de que `PublishedAgentRecord`/respuestas públicas NO incluyen
  estos campos.

## Scope OUT

- Resolución `referrer_ref → wallet` (read-side del referral) —
  `resolveAgentSplitContext` sigue hardcodeando `referral: null` (DT-6 de
  WKH-143). Esta HU persiste `referrer_ref` de forma forward-compatible,
  pero **no activa pagos de referral** — eso requiere una HU separada que
  defina la semántica de `referrer_ref` y la resolución de su wallet (ver
  Missing Inputs).
- Auto-captura de `referrer_ref` (query param, header, cookie de afiliado,
  sesión) — v1 es 100% explícito vía body, sin inferencia (decisión
  conservadora del user/Analyst).
- Soporte de "unset"/borrado de `payoutWallet` ya seteado (ej. `payoutWallet:
  null` explícito para revertir a sin-creator) — v1 solo soporta set/replace
  con un valor válido.
- Prueba de propiedad de la wallet (firma EIP-712, verificación on-chain de
  que el caller controla esa address) — v1 confía en el valor declarado,
  mismo nivel de confianza que `metadata.payTo` de registries externos hoy
  (DT-2 de WKH-143).
- Modificar `computeSplits`/`resolveRecipients`/`settleFeeSplits`/
  `chargeProtocolFee`/`resolveAgentSplitContext` (money-path/read-side, ya
  DONE en WKH-136/143) — esta HU es EXCLUSIVAMENTE write-path del publish.
- UI/dashboard para que el creador ingrese su wallet — fuera de este repo
  backend (si existe una capa de UI de publish self-serve, es una HU
  aparte).
- Múltiples wallets de payout / wallet distinta por chain — v1 = una sola
  address EVM válida para todas las chains (mismo criterio chain-agnóstico
  ya usado por `resolveRecipients`).

## Decisiones técnicas (DT-N)

- **DT-1**: reusar EXACTAMENTE el criterio de formato de wallet ya usado por
  `resolveRecipients`/`verifyDefaultChainSettle`
  (`^0x[0-9a-fA-F]{40}$`) — PROHIBIDO inventar un validador nuevo con reglas
  distintas (ej. checksum EIP-55, longitud distinta). El Architect (F2)
  decide la ubicación exacta (exportar el `isValidWallet` privado de
  `fee-split.ts`, o extraerlo a un módulo compartido) para no crear un
  TERCER duplicado del mismo regex (hoy ya está en `fee-split.ts` y
  `settle-verifier.ts`).
- **DT-2**: `referrerRef` se persiste como string opaco sin resolución de
  lookup en esta HU — sanity mínima (no-vacío tras `trim`, largo máximo
  razonable, ej. 200 chars, para evitar abuso/DoS de columna TEXT) porque su
  semántica exacta (¿`owner_ref` de otro caller? ¿código de afiliado libre?)
  sigue sin resolverse desde WKH-143 (ver Missing Inputs).
- **DT-3**: semántica de ausencia/actualización de `payoutWallet` — en POST,
  ausente ⇒ columna `NULL` (igual que hoy, sin creator activo). En PATCH,
  ausente en el body ⇒ NO se modifica el valor existente (merge parcial,
  mismo patrón que el resto de `update()`). PROHIBIDO tratar `''` (string
  vacío) como "borrar" — un `payoutWallet: ''` debe rechazarse como formato
  inválido (AC-3), no interpretarse como unset.
- **DT-4 (crítica de producto, hereda DT-4 de WKH-143)**: cerrar este
  write-path activa pagos REALES de creator para agentes self-published con
  `payout_wallet` válido y `SPLIT_BPS_CREATOR > 0` (AC-7). El campo
  `referrer_ref` queda persistido pero **funcionalmente inerte** — el
  referral sigue re-ruteándose 100% a plataforma (SG-6) porque
  `resolveAgentSplitContext` no lo lee (ver Missing Inputs). Este matiz debe
  comunicarse honestamente en el gate y en el DONE report — NO es un bug de
  esta HU, es un scope explícito.
- **DT-5**: ownership — el caller solo puede setear `payoutWallet`/
  `referrerRef` de SU PROPIO agente. Se reusa el guard de ownership YA
  existente en `publishedAgentService.update` (pre-fetch `owner_ref` +
  `.eq('owner_ref', ownerRef)` en el UPDATE final) — PROHIBIDO un mecanismo
  paralelo o un nuevo endpoint que bypasee ese guard.

## Constraint Directives (CD-N)

- **CD-1 (OBLIGATORIO)**: la validación de `payoutWallet` SHALL usar
  exactamente el mismo regex de formato EVM que `resolveRecipients`/
  `verifyDefaultChainSettle` — PROHIBIDO un validador paralelo con reglas
  distintas.
- **CD-2 (OBLIGATORIO)**: toda escritura de `payout_wallet`/`referrer_ref`
  vía PATCH SHALL pasar por el guard de ownership `.eq('owner_ref',
  ownerRef)` ya existente en `publishedAgentService.update` — PROHIBIDO un
  code path que actualice `a2a_agents` sin ese filtro (ver
  Security Conventions del `CLAUDE.md` raíz — Ownership Guard).
- **CD-3 (PROHIBIDO)**: PROHIBIDO exponer `payout_wallet`/`referrer_ref` en
  NINGUNA respuesta pública (201/200 de POST/PATCH, `GET /agents` list-mine,
  `GET /agents/:slug/agent-card`, `/discover`) — hereda CD-5 de WKH-143.
  `PublishedAgentRecord`/`mapRowToRecord` NO deben incluir estos campos.
- **CD-4 (OBLIGATORIO)**: `exactOptionalPropertyTypes` — construir el
  insert/update row con asignación condicional (`if (v !== undefined)
  obj.x = v`), nunca `x: cond ? v : undefined` (patrón heredado
  WKH-134/143).
- **CD-5 (OBLIGATORIO)**: un `payoutWallet` inválido SHALL responder `422`
  (mismo status code que el guard existente de `priceUsdc`/SSRF de
  `agentUrl`), NUNCA `400` silencioso ni `500`.
- **CD-6 (PROHIBIDO)**: PROHIBIDO tocar `resolveAgentSplitContext`/
  `agent-split-context.ts` para activar la lectura de `referrer_ref` en esta
  HU — es una HU separada (ver DT-4/Missing Inputs). Esta HU es
  EXCLUSIVAMENTE write-path del publish self-serve.
- **CD-7 (PROHIBIDO)**: PROHIBIDO modificar
  `computeSplits`/`resolveRecipients`/`settleFeeSplits`/`chargeProtocolFee`
  (ya DONE en WKH-136/143) — esta HU no toca el money-path de cobro.

## Missing Inputs

- **[NEEDS CLARIFICATION] (heredado de WKH-143 Missing Inputs #2, sigue sin
  resolver, NO bloqueante para F2 de esta HU)**: ¿qué es semánticamente
  `referrer_ref`? ¿Un `owner_ref` de OTRO caller de a2a (cuya wallet payout
  se buscaría en su PROPIA fila `a2a_agents.payout_wallet`, exigiendo que el
  referrer también sea dueño de un agente self-published), o un
  identificador/código de referido libre para un sistema de atribución que
  aún no existe? Esta HU asume "string opaco declarado por el creador" y
  SOLO lo persiste — no resuelve el lookup. Para activar pagos de referral
  de verdad se necesita una HU separada (sugerida WKH-143c) que: (a) defina
  la semántica, (b) implemente la resolución de wallet del referrer, (c)
  actualice `resolveAgentSplitContext` para dejar de hardcodear
  `referral: null`.
- Resuelto conservador en F0 (no bloqueante): captura de `referrer_ref` es
  100% explícita vía body del publish/update — SIN auto-captura (query
  param, header, sesión) en v1, tal como indicó el user.
- Resuelto conservador en F0 (no bloqueante): sin soporte de "unset"/borrado
  de `payoutWallet` en v1 (DT-3) — solo set/replace con valor válido.

## Riesgos (para AR)

| Riesgo | Prob | Impacto | Mitigación |
|--------|------|---------|------------|
| Se confunde "referral inerte" (DT-4) con un bug de esta HU | A | M | DT-4 lo documenta explícitamente como scope, no regresión; el DONE report debe repetirlo. |
| Ownership guard mal cableado — un caller setea el `payoutWallet` de un agente que no le pertenece | B | A | AC-6 + reuso EXPLÍCITO del guard ya existente en `update()` (CD-2) — PROHIBIDO un path nuevo que lo bypasee. |
| `payoutWallet` con formato inválido se persiste (ej. típo, dirección Bitcoin, string vacío) y luego rompe silenciosamente el settle en `chargeLeg` | M | A | AC-3/CD-1/CD-5 — reject 422 en el write boundary, mismo patrón defensivo que `priceUsdc`. |
| Se crea un TERCER duplicado del regex de wallet EVM (ya hay 2: `fee-split.ts` + `settle-verifier.ts`) | M | B | DT-1 exige reusar/exportar, no reimplementar. |
| Exponer `payout_wallet`/`referrer_ref` en alguna respuesta nueva (ej. si se agrega un campo de eco en el 201) | B | A | CD-3/AC-8 explícito — AR debe grepear el shape de respuesta de POST/PATCH. |

## Análisis de paralelismo

- Depende de: WKH-143 (DONE, fila 144 `_INDEX.md`) — el read-side de
  creator ya existe y funciona; esta HU solo cierra el write-path que
  faltaba.
- Bloquea: la activación completa de pagos de REFERRAL sigue bloqueada
  hasta una HU futura (sugerida WKH-143c) que resuelva la semántica de
  `referrer_ref` y actualice `resolveAgentSplitContext` (ver Missing
  Inputs) — esta HU NO la desbloquea, solo prepara el terreno (persiste el
  dato).
- Puede ir en paralelo con: WKH-090/HU-090 (fila 146, Tempo/MPP rail, en
  progreso) y WKH-139 v2 (fila 145, agente-árbitro, en progreso) — no
  comparte archivos (esas tocan adapters de pago y disputa, no
  `src/routes/agents.ts`/`src/services/agent.ts`).
- No bloquea ningún otro trabajo en curso explícitamente.
