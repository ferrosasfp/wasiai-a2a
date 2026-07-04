# Work Item — [WKH-143c] Activar referral real en los splits (cerrar DT-6 de WKH-143)

## Resumen

WKH-143 (DONE) cableó el read-side del engine de splits pero **hardcodea
`referral: null` para siempre** (`resolveAgentSplitContext`, DT-6). WKH-143b
(DONE) agregó el write-path: `a2a_agents.referrer_ref` se persiste HOY como
string opaco (≤200 chars, trimmeado) al publicar/editar un agente
self-published, pero **nadie lo lee** — `getSplitContextRow` lo devuelve y se
ignora. Esta HU activa el referral de verdad: define qué ES `referrer_ref` y
cablea `resolveAgentSplitContext` para resolverlo a una wallet real, dejando
de devolver `referral: null` incondicionalmente. Testnet. Money-path — agrega
un tercer destinatario de fee (`SPLIT_BPS_REFERRAL > 0`).

**Bloqueada para F2**: requiere una decisión de producto del humano (ver
`NEEDS CLARIFICATION` abajo) sobre la semántica de `referrer_ref` — el
Analyst NO la inventa.

## Sizing

- SDD_MODE: full (QUALITY — money-path, agrega un recipient de fee real,
  mismo nivel de rigor que WKH-143/143b)
- Estimación: S/M
- Branch sugerido: `feat/148-wkh-143c-activate-referral`

## F0 — Grounding (confirmado contra código real)

| Hecho | Evidencia |
|-------|-----------|
| `resolveAgentSplitContext` hardcodea `referral: null` SIEMPRE | `src/services/agent-split-context.ts:15-16,35,48,69` — comentario explícito DT-6: `"referral es SIEMPRE null en v1"`. Los dos `return` (self-published y registry externo) fijan `referral: null` sin leer nada. |
| `getSplitContextRow` YA devuelve `referrerRef` pero se ignora | `src/services/agent.ts:271-294` — el SELECT trae `owner_ref, payout_wallet, referrer_ref`; el caller (`agent-split-context.ts:44`) solo destructura `row?.payoutWallet`, nunca `row?.referrerRef`. |
| `referrer_ref` se persiste HOY como string opaco, sin validación de formato | `src/services/agent.ts:198-213` (`assertValidReferrerRef`) — exige `typeof === 'string'`, `trim().length` en `[1, 200]`. NINGÚN otro criterio (no regex EVM, no lookup, no unicidad). `src/routes/agents.ts` replica el mismo guard en POST/PATCH (422 si inválido). |
| `resolveRecipients`/`computeSplits` consumen un `SplitPartyRef` genérico — agnóstico de "cómo" se resolvió | `src/services/fee-split.ts:81-85` (`SplitPartyRef { wallet, ownerRef }`), `:196-253` (`resolveRecipients`) — el `party` de `referral` puede venir de CUALQUIER fuente server-side; solo exige `isValidWallet(party.wallet)` (`fee-split.ts:31`, ahora en `src/lib/wallet-format.ts`, extraído en WKH-143b). Wallet inválida/ausente → skip + re-ruta bps a plataforma (SG-6) — **este fallback YA existe y no hay que reimplementarlo**. |
| El validador EVM YA está centralizado (single source) | `src/lib/wallet-format.ts` (extraído en WKH-143b) — `ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/` + `isValidWallet`. `fee-split.ts:31` y `src/services/agent.ts:191-196` (`assertValidPayoutWallet`) ya lo importan. Cualquier resolución nueva de wallet DEBE reusar este mismo módulo (CD-1 heredado). |
| Existe un candidato de "wallet con prueba de control" que HOY NO se usa para creator/referral | `src/services/identity.ts:171-199` (`bindFundingWallet`) + migración `supabase/migrations/20260529000001_a2a_key_funding_wallet.sql` — `a2a_agent_keys.funding_wallet` se bindea SOLO tras probar control (el caller depositó desde esa wallet, `Transfer.from == funding_wallet`, WKH-35 FIX-1). Es una wallet MÁS confiable que `payout_wallet`/`referrer_ref` (ambos auto-declarados sin prueba, DT-2 de WKH-143b). **Hallazgo relevante para la Opción A abajo.** |
| `owner_ref` NO es único por fila en `a2a_agent_keys` | `supabase/migrations/20260406000000_a2a_agent_keys.sql:8-38` — no hay `UNIQUE(owner_ref)`; un mismo owner puede tener N keys (`id` es la PK, `owner_ref` es un campo repetible). Implicación: si `referrer_ref` se interpreta como "el `owner_ref` de otro caller", resolver SU wallet exige decidir con qué fila (la primera con `funding_wallet` no-nulo? todas? error si hay >1?). |
| `slug` de `a2a_agents` SÍ es único (PK) | `src/services/agent.ts:246-260` (`getRow` por `.eq('slug', slug)`, colisión pre-check en `publish()`, `agent.ts:337-344`) — si `referrer_ref` se interpreta como "slug de otro agente self-published", la resolución es determinística (1 fila o ninguna), sin la ambigüedad del punto anterior. |
| No existe HOY ningún concepto de "programa de referidos"/atribución en registries ni agent-keys | Grep de `registry.ts`, `identity.ts`, `agent.ts`: sin tabla de afiliados, sin código de invitación, sin tracking de quién refirió a quién. `referrer_ref` es la ÚNICA pieza de dato relacionada, y es 100% opaca (WKH-143b DT-2, Missing Inputs #1). |
| El seam de resolución ya es best-effort/fail-safe por diseño | `src/services/agent-split-context.ts:8-10` (CD-10) — cualquier error de lookup DEBE degradar a `referral: null`, nunca romper el charge. Cualquier resolución nueva DEBE preservar este contrato. |

## `[NEEDS CLARIFICATION]` — decisión de producto del humano (BLOQUEANTE para F2)

**Pregunta central: ¿qué ES `referrer_ref` semánticamente, y cómo se resuelve
su wallet de payout?** El Analyst NO decide esto — se presentan las opciones
factibles groundeadas en el código real. Cada una es implementable con el
seam actual (`resolveAgentSplitContext` → `SplitPartyRef` → `resolveRecipients`)
sin tocar `computeSplits`/`resolveRecipients`/`settleFeeSplits` (heredado
CD-7 de WKH-143b).

### Opción A — `referrer_ref` = `owner_ref` de otro caller de a2a

El creador declara el `owner_ref` de quien lo refirió (otro tenant de la
plataforma, no necesariamente dueño de un agente). Se resuelve su wallet vía
`a2a_agent_keys.funding_wallet` (la wallet con **prueba de control**, ya
existe el bind-flow de WKH-35).

- **Cómo se resuelve**: nuevo lookup — `SELECT funding_wallet FROM
  a2a_agent_keys WHERE owner_ref = referrer_ref AND funding_wallet IS NOT
  NULL LIMIT 1` (o equivalente vía un método nuevo en `identityService`).
  `isValidWallet` NO hace falta re-validar (el bind-flow ya solo acepta
  formato EVM, y `funding_wallet` se persiste lowercase).
- **Ambigüedad a resolver**: `owner_ref` no es único por fila — si el
  referrer tiene 0 o >1 keys con `funding_wallet` bindeado, ¿tomar la
  primera? ¿la más reciente? ¿fallar a `null` si hay >1 (mismo patrón
  fail-safe que `resolveErc8004AgentId`, `identity.ts:432-438`, que exige
  EXACTAMENTE 1 match)?
- **Pros**: usa una wallet con prueba de control real (más confiable que un
  `payout_wallet` auto-declarado). Encaja con "referir a OTRO USUARIO de la
  plataforma", que es la semántica típica de un programa de referidos.
  Reutiliza infraestructura de identidad ya existente (WKH-35).
- **Cons**: exige que el referrer YA tenga una agent key con
  `funding_wallet` bindeado — un referrer que solo publicó agentes pero
  nunca bindeó wallet de fondeo queda sin cobrar (degrada a plataforma,
  SG-6 — no rompe, pero es "silenciosamente inerte" para ese caso). Nuevo
  código de lookup (no reusa 100% lo existente).

### Opción B — `referrer_ref` = `slug` de otro agente self-published

El creador declara el `slug` del agente (no del usuario) que lo refirió. Se
resuelve exactamente igual que el `creator` — reusando
`getSplitContextRow(slug)` (ya existe, cero código nuevo de lookup).

- **Cómo se resuelve**: `resolveAgentSplitContext` llama
  `publishedAgentService.getSplitContextRow(referrerRef)` (el MISMO método
  que ya usa para `creator`, solo con el slug del referrer en vez del slug
  del agente primario) → `referral = { wallet: row.payoutWallet, ownerRef:
  row.ownerRef }` si `payoutWallet` no es null.
- **Ambigüedad**: ninguna — `slug` es PK única, resolución determinística
  (0 o 1 fila).
- **Pros**: CERO código de lookup nuevo (reusa `getSplitContextRow` tal
  cual); mismo nivel de confianza que el creator (`payout_wallet`
  auto-declarado, DT-2 de WKH-143b — consistente, no un estándar nuevo);
  más simple de implementar/testear (espejo exacto del path de creator).
- **Cons**: la semántica es "qué agente te refirió", no "qué usuario te
  refirió" — más limitado (solo agentes self-published pueden ser
  referrers, no cualquier tenant). Requiere que el referido conozca el
  `slug` exacto del agente referrer (dato público, no es un secreto — el
  slug se deriva del `name`, es descubrible).

### Opción C — `referrer_ref` = wallet EVM cruda declarada directamente

Se reinterpreta `referrer_ref` como la wallet misma (sin indirección). El
creador declara directamente una address `0x...` al publicar.

- **Cómo se resuelve**: NINGÚN lookup — `referral = { wallet: referrerRef,
  ownerRef: 'referral' }` si `isValidWallet(referrerRef)`, si no,
  `referral: null` (delegando el skip a `resolveRecipients`/SG-6 igual que
  hoy).
- **Cons importante**: CAMBIA retroactivamente la validación de
  `referrer_ref` — hoy (`assertValidReferrerRef`, WKH-143b) acepta
  CUALQUIER string no-vacío ≤200 chars (no exige formato EVM). Si se elige
  esta opción, ¿se exige EVM en el WRITE-path desde ahora (rechazar con 422
  strings no-EVM), o se tolera en el READ-path (string no-EVM persistido →
  simplemente no resuelve, degrada a `null`, sin romper nada existente)?
  Cualquier `referrer_ref` YA persistido que no sea una wallet válida
  (ej. un código de afiliado que algún creador ya haya guardado en testnet)
  deja de "significar" nada — no hay dato observado de esto en prod aún
  (feature inerte desde WKH-143b), así que el riesgo de romper datos reales
  es bajo, pero es una decisión de compatibilidad explícita.
- **Pros**: MÁS simple de todas — cero lookup nuevo, cero ambigüedad,
  reusa `isValidWallet` (mismo criterio que `payoutWallet`). No depende de
  que el referrer sea un usuario/agente conocido de la plataforma — cabe
  cualquier wallet externa (ej. un afiliado que ni siquiera usa WasiAI
  directamente).
- **Cons**: pierde la trazabilidad "quién es el referrer dentro de la
  plataforma" (`ownerRef` queda como constante `'referral'`, sin vínculo a
  un caller real) — menos útil para reputación/analytics futuros.

### Descartada (no compatible con el modelo actual, se documenta por completitud)

**Opción D — captura dinámica** (el agent-key/marketplace que originó la
invocación, no un valor declarado al publicar): incompatible con el diseño
YA shippeado en WKH-143b, donde `referrer_ref` es un campo **declarativo,
fijado al publish/update del agente**, no algo que varíe por invocación. Adoptar
esta opción exigiría rediseñar el write-path (WKH-143b) y el contrato de
`resolveAgentSplitContext` (que resuelve por agente, no por request) — fuera
de alcance de "activar lo que ya existe". Si el humano la prefiere, es una
HU nueva de mayor alcance (no una activación de WKH-143c).

### Recomendación no-vinculante del Analyst

Si el humano no tiene una preferencia fuerte de producto, la **Opción B**
minimiza riesgo/esfuerzo (cero lookup nuevo, mismo patrón que `creator`,
mismo nivel de confianza ya aceptado) y es la más fácil de verificar en AR/CR
por espejo directo con código ya auditado. La **Opción A** es la
semánticamente más "correcta" para un programa de referidos entre usuarios,
al costo de un lookup nuevo y la ambigüedad de `owner_ref` no-único. La
decisión final es del humano.

## Acceptance Criteria (EARS)

### Comunes a CUALQUIER opción elegida (no bloqueados por la decisión)

- **AC-1**: WHILE `SPLIT_BPS_REFERRAL` es `0` (default) o `SPLIT_BPS_CREATOR`
  y `SPLIT_BPS_REFERRAL` son ambos `0`, THE system SHALL mantener
  `resolveAgentSplitContext` byte-idéntico a hoy — `splitsActive()` en
  `false`, cero query extra de resolución de referral.
- **AC-2**: IF la wallet resuelta para `referral` (por cualquier vía) es
  inválida (no pasa `isValidWallet` de `src/lib/wallet-format.ts`) o no se
  pudo resolver, THEN THE system SHALL devolver `referral: null` desde
  `resolveAgentSplitContext` — el skip + re-ruta a plataforma lo maneja
  `resolveRecipients` (SG-6) SIN código nuevo en `fee-split.ts`.
- **AC-3**: WHEN un agente NO tiene `referrer_ref` seteado (`NULL`), THE
  system SHALL resolver `referral: null` — sin inventar ningún valor.
- **AC-4**: THE system SHALL NUNCA exponer `referrer_ref` ni la wallet de
  referral resuelta en ninguna respuesta pública (hereda CD-3/CD-5 de
  WKH-143/143b sin excepción — `POST`/`PATCH /agents`, `GET /agents`
  list-mine, `agent-card`, `/discover`).
- **AC-5**: IF la resolución del lookup de referral lanza un error (DB,
  narrowing, timeout), THEN THE system SHALL degradar a `referral: null`
  (best-effort, CD-10 heredado) — NUNCA propagar el error ni romper el
  charge/200 de la invocación.
- **AC-6**: WHEN `SPLIT_BPS_REFERRAL > 0` Y el `referrer_ref` de un agente se
  resuelve a una wallet válida (según la opción elegida), THE system SHALL
  rutear el leg de `referral` del protocol fee a esa wallet real en la
  siguiente invocación cobrada de ese agente (integración sobre
  `resolveRecipients`/`settleFeeSplits` YA existentes — sin código nuevo en
  el money-path de cobro).

### Condicionales a la opción elegida — `[NEEDS CLARIFICATION]`

- **AC-7 (Opción A)**: IF se elige la Opción A, WHEN `referrer_ref` coincide
  con el `owner_ref` de EXACTAMENTE una fila de `a2a_agent_keys` con
  `funding_wallet` no-nulo, THE system SHALL resolver `referral = { wallet:
  esa funding_wallet, ownerRef: referrer_ref }`; con 0 o >1 matches, THE
  system SHALL resolver `referral: null` (mismo patrón fail-safe que
  `resolveErc8004AgentId`).
- **AC-7 (Opción B)**: IF se elige la Opción B, WHEN `referrer_ref` coincide
  con el `slug` de un agente self-published con `payout_wallet` no-nulo, THE
  system SHALL resolver `referral = { wallet: esa payout_wallet, ownerRef:
  su owner_ref }` vía `getSplitContextRow(referrerRef)` (mismo método que
  ya usa `creator`).
- **AC-7 (Opción C)**: IF se elige la Opción C, WHEN `referrer_ref` en sí
  mismo pasa `isValidWallet`, THE system SHALL resolver `referral = {
  wallet: referrerRef, ownerRef: 'referral' }` directamente, sin ningún
  lookup a Supabase.

## Scope IN

- `src/services/agent-split-context.ts`: `resolveAgentSplitContext` deja de
  hardcodear `referral: null` — agrega la resolución elegida (A/B/C) en
  ambas ramas (self-published y registry externo, o solo self-published si
  el humano acota el alcance — a definir en F2 según la opción).
- Nuevo lookup SI la opción elegida lo requiere (Opción A: método nuevo en
  `identityService` o `agent.ts`; Opción B: cero código nuevo, reusa
  `getSplitContextRow`; Opción C: cero lookup, solo `isValidWallet`).
- Tests de integración: `referral` se arma correctamente para cada caso
  (agente con/sin `referrer_ref`, wallet resuelta válida/inválida/ausente,
  byte-idéntico con el default `10000/0/0`).

## Scope OUT

- Modificar `computeSplits`/`resolveRecipients`/`settleFeeSplits`/
  `chargeProtocolFee` (money-path de cobro, DONE en WKH-136/143/143b) —
  esta HU es EXCLUSIVAMENTE el lookup de resolución del `referral` dentro de
  `resolveAgentSplitContext`.
- Write-path del publish (`POST`/`PATCH /agents`, `assertValidReferrerRef`)
  — ya DONE en WKH-143b. Si la Opción C se elige, decidir si el write-path
  se endurece (exigir formato EVM en `referrer_ref` desde ahora) es una
  sub-decisión de F2, no un rediseño del endpoint.
- Programa de referidos completo (dashboards, tracking de conversiones,
  multi-nivel/MLM, códigos de invitación con expiración) — esta HU SOLO
  activa el pago del split, no construye un sistema de afiliados.
- Prueba de propiedad/control de la wallet del referrer (heredado Scope OUT
  de WKH-143b) — mismo nivel de confianza que `payout_wallet` (excepto en
  Opción A, que hereda la prueba de control YA existente de
  `funding_wallet`).
- Múltiples referrers en cadena (referral del referral) — v1 es un solo
  nivel, igual que `creator`.

## Decisiones técnicas (DT-N)

- **DT-1 (OBLIGATORIO, cualquier opción)**: cualquier wallet resuelta para
  `referral` DEBE validarse con EXACTAMENTE `isValidWallet` de
  `src/lib/wallet-format.ts` (single source, extraída en WKH-143b) —
  PROHIBIDO un criterio de formato paralelo.
- **DT-2 (heredado CD-10 de WKH-143)**: la resolución de `referral` es
  best-effort — cualquier fallo de lookup degrada a `null`, nunca rompe el
  charge. Aplica igual a la Opción A (nuevo lookup) que a B/C.
- **DT-3 (pendiente de F2, depende de la opción)**: si se elige la Opción A,
  definir el criterio de desambiguación cuando `owner_ref` tiene múltiples
  `a2a_agent_keys` — `[NEEDS CLARIFICATION]` técnico secundario, resoluble
  en F2 con el patrón fail-safe ya existente (`resolveErc8004AgentId`:
  exactamente 1 match o `null`).
- **DT-4**: el gate `splitsActive()` (`src/config/split-config.ts:126-136`)
  NO se modifica — sigue siendo el único punto que decide si
  `resolveAgentSplitContext` hace query extra. Esta HU no introduce un
  gate paralelo (evita auto-activación accidental si algún día
  `SPLIT_BPS_REFERRAL` queda en 0 pero hay `referrer_ref` seteados en DB).

## Constraint Directives (CD-N)

- **CD-1 (PROHIBIDO)**: PROHIBIDO modificar el cuerpo de
  `computeSplits`/`resolveRecipients`/`settleFeeSplits`/`chargeProtocolFee`
  — esta HU es EXCLUSIVAMENTE la resolución dentro de
  `resolveAgentSplitContext` (y su lookup dependiente, si aplica).
- **CD-2 (OBLIGATORIO)**: con `SPLIT_BPS_REFERRAL=0` (o config default
  `10000/0/0`), el comportamiento DEBE ser byte-idéntico a hoy — mismo
  invariante que WKH-136/143/143b, verificado con test de regresión.
- **CD-3 (PROHIBIDO — anti-leak)**: PROHIBIDO exponer `referrer_ref` o la
  wallet de referral resuelta en cualquier respuesta pública o log no
  PII-safe.
- **CD-4 (OBLIGATORIO)**: cualquier nuevo lookup (Opción A) DEBE seguir el
  patrón fail-safe existente (0 o >1 matches ambiguos → `null`, nunca un
  throw ni una elección arbitraria silenciosa sin loggear).
- **CD-5 (PROHIBIDO — auto-activación)**: PROHIBIDO que esta HU active
  pagos de referral para agentes que YA tienen `referrer_ref` persistido de
  WKH-143b sin que el operador setee explícitamente
  `SPLIT_BPS_REFERRAL > 0` — el dato persistido existente NO debe empezar a
  cobrar "solo por deployar código nuevo".

## Missing Inputs

- **[NEEDS CLARIFICATION] — BLOQUEANTE para F2**: ¿cuál opción (A/B/C, o
  una variante) define la semántica de `referrer_ref`? Ver sección
  dedicada arriba con pros/cons groundeados.
- **[NEEDS CLARIFICATION] — secundario, no bloqueante si se elige Opción
  A**: criterio de desambiguación cuando `owner_ref` tiene múltiples
  `a2a_agent_keys` con `funding_wallet` (DT-3) — resoluble en F2 con
  precedente existente (`resolveErc8004AgentId`).
- **[NEEDS CLARIFICATION] — secundario, solo si se elige Opción C**: si se
  reinterpreta `referrer_ref` como wallet cruda, ¿el write-path
  (`assertValidReferrerRef`, WKH-143b) se endurece para exigir formato EVM
  desde ahora, o se tolera cualquier string persistido y solo se resuelve
  si matchea el formato (sin romper valores ya guardados)?

## Riesgos (para AR, una vez resuelta la decisión)

| Riesgo | Prob | Impacto | Mitigación |
|--------|------|---------|------------|
| Auto-activación accidental de pagos a un `referrer_ref` ya persistido en testnet | B | M | CD-5 — el operador debe setear `SPLIT_BPS_REFERRAL>0` explícitamente; sin eso, byte-idéntico (AC-1/CD-2). |
| Ambigüedad de `owner_ref` no-único (Opción A) resuelta de forma insegura (ej. tomar "cualquiera") | M | M | DT-3/CD-4 — exigir el patrón fail-safe de exactamente 1 match. |
| Reinterpretar `referrer_ref` como wallet (Opción C) rompe algún valor ya persistido en testnet que no sea EVM | B | B | Degrada a `null` (AC-2), no error — impacto bajo porque el campo es inerte desde su creación (WKH-143b). |
| Leak de `referrer_ref`/wallet resuelta en alguna respuesta nueva | B | A | AC-4/CD-3 — mismo patrón de test de regresión que WKH-143b. |
| Se reintroduce un lookup síncrono costoso en el hot-path de cobro | B | M | Reusar `getSplitContextRow`/patrón best-effort existente; medir antes de mergear si la opción elegida agrega una query nueva por invocación. |

## Análisis de paralelismo

- Depende de: WKH-143 (DONE, fila 144) y WKH-143b (DONE, fila 147) — el
  read-side de creator y el write-path de `referrer_ref` ya existen; esta HU
  cierra el último seam dormido.
- Bloquea: nada explícitamente — es la activación final del roadmap de
  splits (WKH-136 → 143 → 143b → 143c). Con esta HU DONE, el ciclo de
  splits queda completo (plataforma + creador + referral, todos activables
  vía env).
- Puede ir en paralelo con: cualquier HU que no toque
  `src/services/agent-split-context.ts`/`src/services/agent.ts`/
  `src/services/identity.ts` (según la opción elegida).
- **BLOQUEADA para F2** hasta que el humano decida entre las opciones A/B/C
  (o una variante) — este work-item NO debe avanzar a SDD sin esa decisión.
