# SDD #147: [WKH-143b] Write-path de creator/referral (cerrar el seam dormido de WKH-143)

> SPEC_APPROVED: no
> Fecha: 2026-07-04
> Tipo: feature (money-path input)
> SDD_MODE: full
> Branch: feat/147-wkh-143b-split-writepath
> Artefactos: doc/sdd/147-wkh-143b-split-writepath/

---

## 1. Resumen

WKH-143 (DONE, fila 144) cableó el **read-side** del engine de splits: `resolveAgentSplitContext`
ya llama `publishedAgentService.getSplitContextRow(slug)` y arma el leg de `creator` a partir de
`a2a_agents.payout_wallet`. Pero **ningún código escribe hoy esa columna** — el publish self-serve
(`POST`/`PATCH /agents`, WKH-134) no captura `payoutWallet`/`referrerRef`, así que `payout_wallet`
es SIEMPRE `NULL` y todo creator-split se re-rutea a plataforma (SG-6).

Esta HU cierra EXCLUSIVAMENTE el **write-path**: extiende `PublishAgentInput`/`UpdateAgentInput`
con `payoutWallet?`/`referrerRef?`, los captura y valida en las 2 rutas (422 en `payoutWallet`
inválido, mismo criterio EVM que `resolveRecipients`), y los persiste vía `publish()`/`update()`
reusando **sin cambios** el ownership guard ya existente. Con `payout_wallet` válido +
`SPLIT_BPS_CREATOR > 0` el creator cobra de verdad (integración con el read-side de WKH-143,
sin código nuevo en el money-path de cobro). Con el default `10000/0/0` el comportamiento es
byte-idéntico a hoy. Testnet.

**`referrer_ref` se persiste pero queda funcionalmente INERTE** (DT-4): `resolveAgentSplitContext`
sigue hardcodeando `referral: null` (DT-6 de WKH-143). Activar pagos de referral requiere una HU
separada (WKH-143c) que resuelva la semántica de `referrer_ref` → wallet — Scope OUT acá.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 147 |
| **Tipo** | feature (money-path input) |
| **SDD_MODE** | full |
| **Objetivo** | Capturar/validar/persistir `payoutWallet`+`referrerRef` en el publish self-serve para activar el creator-split real; `referrer_ref` opaco e inerte. |
| **Reglas de negocio** | `payoutWallet` = address EVM válida (mismo regex que `resolveRecipients`) o 422. Solo el owner setea SU agente. Los campos NUNCA se exponen en respuestas públicas. Default `10000/0/0` byte-idéntico. |
| **Scope IN** | `src/types/index.ts`, `src/routes/agents.ts` (POST+PATCH), `src/services/agent.ts` (publish+update), validador EVM compartido, tests. |
| **Scope OUT** | Read-side de referral (`resolveAgentSplitContext`), `computeSplits`/`resolveRecipients`/`settleFeeSplits`/`chargeProtocolFee`, unset de wallet, auto-captura de referral, prueba de propiedad de wallet, multi-wallet por chain, UI. |
| **Missing Inputs** | `[NEEDS CLARIFICATION]` heredado de WKH-143 (semántica de `referrer_ref`) — NO bloqueante: esta HU solo persiste el string opaco. Diferido a WKH-143c. |

### Acceptance Criteria (EARS)

- **AC-1**: WHEN `POST /agents` incluye `payoutWallet` con formato EVM válido (`^0x[0-9a-fA-F]{40}$`), THE system SHALL persistir ese valor en `a2a_agents.payout_wallet` de la fila creada.
- **AC-2**: WHEN `PATCH /agents/:slug` incluye `payoutWallet` válido y el caller es el owner, THE system SHALL actualizar `a2a_agents.payout_wallet` de esa fila (y solo esa) sin afectar otros campos no incluidos en el body.
- **AC-3**: IF `payoutWallet` está presente (POST o PATCH) pero no cumple el formato EVM válido, THEN THE system SHALL responder `422` y NO persistir ningún campo del request.
- **AC-4**: WHEN `POST`/`PATCH` incluye `referrerRef` como string no-vacío (tras `trim()`, `≤ 200` chars), THE system SHALL persistir el valor trimmeado en `a2a_agents.referrer_ref` — opaco, sin resolución de wallet en esta HU.
- **AC-5**: WHILE `payoutWallet` está ausente del body, THE system SHALL dejar `a2a_agents.payout_wallet` sin tocar (PATCH) o `NULL` (POST) — sin inventar default.
- **AC-6**: IF un caller autenticado hace `PATCH /agents/:slug` con `payoutWallet`/`referrerRef` sobre un slug que NO le pertenece, THEN THE system SHALL responder `404` (disclosure-safe) sin persistir nada.
- **AC-7**: WHEN un agente self-published tiene `payout_wallet` válido seteado vía esta HU y `SPLIT_BPS_CREATOR > 0`, THE system SHALL rutear el leg de `creator` del protocol fee a esa wallet real (integración sobre el read-side YA existente de WKH-143 — solo verificación, sin código nuevo de cobro).
- **AC-8**: THE system SHALL NUNCA exponer `payout_wallet`/`referrer_ref` en ninguna respuesta pública (201/200 de POST/PATCH, `GET /agents` list-mine, `GET /agents/:slug/agent-card`, `/discover`) — hereda CD-5 de WKH-143.

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `src/routes/agents.ts` | Rutas POST/PATCH a extender | Guard `isValidPriceUsdc` → 422 (`:64-66,145-158,264-275`); construcción condicional de `input` (`:163-185`); PATCH pasa `body` crudo a `update()` (`:293-297`); `mapOwnershipError` → 404 (`:39-47,300-301`); errores estáticos CD-10. |
| `src/services/agent.ts` | `publish()`/`update()` a extender | `AgentRow`/`PublishedAgentRecord`/`mapRowToRecord` NO incluyen `payout_wallet`/`referrer_ref` (`:42-71,129-148`); `assertValidPriceUsdc` write-boundary (`:178-183`); insert typed (`:313-324`); ownership guard en `update()` (pre-fetch + `.eq('owner_ref', ownerRef)`, `:404-499`); `getSplitContextRow` (read-side, NO tocar, `:241-264`). |
| `src/services/fee-split.ts` | Fuente de verdad del validador EVM | `ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/` (`:41`) + `isValidWallet` privado (`:164-166`) usado por `resolveRecipients` (`:217`). Es el criterio EXACTO que exige DT-1/CD-1. |
| `src/services/agent-split-context.ts` | Read-side ya cableado (NO tocar) | `getSplitContextRow(slug)` → `creator = { wallet: payoutWallet, ownerRef }`; `referral` SIEMPRE `null` (DT-6, `:15-16,45-48,69`). Esta HU solo puebla la columna que este archivo ya lee. |
| `src/types/index.ts` | Tipos de entrada a extender | `PublishAgentInput` (`:118-135`) + `UpdateAgentInput` (`:141-150`) — aditivo, `exactOptionalPropertyTypes`. |
| `src/types/database.types.ts` | Confirmar columnas tipadas | `a2a_agents` Insert/Update ya tipan `payout_wallet?: string \| null` y `referrer_ref?: string \| null` (`:41,43,55,57`). El insert/update row las soporta sin cast. |
| `src/config/split-config.ts` | Semántica de activación de splits | `getSplitConfig()` fail-CLOSED; default `10000/0/0`; `splitsActive()` gate no-throw (`:126-136`). Confirma que con default el creator no cobra → byte-idéntico. |
| `src/routes/agents.publish.test.ts` | Exemplar de test de ruta | Mock de `requirePaymentOrA2AKey` + `node:dns` + supabase; service mockeado por método; T-PUB-06 usa service real vía `vi.importActual`. |
| `src/routes/agents.ownership.test.ts` | Exemplar de test de ownership | supabase in-memory con `state.eqCalls`/`updateCalled`; asserts de guard cross-owner → 404 + no-mutación + `logOwnershipMismatch`. |
| `src/services/agent-split-context.test.ts` | Exemplar de test de integración read-side | `mockGetSplitContextRow` → assert `resolveAgentSplitContext` arma `creator`. Base para el AC-7 end-to-end. |
| `doc/sdd/138-wkh-136-atomic-splits-bps/auto-blindaje.md` | Learnings money-path | Disciplina byte-idéntico con default `10000/0/0`; fragilidad de tests money-path ante cambios de cadena `.eq`. |

### Exemplars

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `src/lib/wallet-format.ts` (NUEVO) | `src/services/fee-split.ts:41,164-166` | Mover el `ADDRESS_RE`+`isValidWallet` (leaf helper) a un módulo compartido, criterio idéntico. |
| Guard `payoutWallet` en `agents.ts` | `isValidPriceUsdc` + guard 422 (`agents.ts:64-66,145-158,264-275`) | Mismo patrón write-boundary → 422. |
| Captura en `input`/body | Construcción condicional (`agents.ts:163-185`) | `exactOptionalPropertyTypes`: `if (v !== undefined) obj.x = v`. |
| Persistencia en `publish()`/`update()` | Insert/updateRow typed + asserts (`agent.ts:178-183,313-324,442-458`) | Asignación condicional + defense-in-depth guard. |
| Ownership | Guard existente `update()` (`agent.ts:404-499`) | REUSAR sin código nuevo — pre-fetch + `.eq('owner_ref', ownerRef)`. |

### Estado de BD relevante

| Tabla | Existe | Columnas relevantes |
|-------|--------|---------------------|
| `a2a_agents` | Sí (prod testnet) | `payout_wallet TEXT NULL`, `referrer_ref TEXT NULL` (migración `20260705000000_wkh136_fee_splits.sql:70-72`; sin default, sin CHECK). Insert/Update ya tipados. **Sin cambios de esquema en esta HU.** |

### Componentes reutilizables encontrados

- `isValidWallet`/`ADDRESS_RE` en `fee-split.ts:41,164-166` — reutilizar (vía extracción a `src/lib/wallet-format.ts`), NO reimplementar (evita un TERCER duplicado del regex).
- Ownership guard de `publishedAgentService.update` (`agent.ts:404-499`) — reutilizar sin cambios.
- `mapOwnershipError` (`agents.ts:39-47`) — ya mapea `OwnershipMismatchError` → 404 (cubre AC-6 sin código nuevo).

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `src/lib/wallet-format.ts` | Crear | Exporta `ADDRESS_RE` + `isValidWallet(w): w is string`. Single source del criterio EVM. | `fee-split.ts:41,164-166` |
| `src/services/fee-split.ts` | Modificar (mínimo) | Reemplazar el `ADDRESS_RE`/`isValidWallet` PRIVADOS por `import { isValidWallet } from '../lib/wallet-format.js'`. **Solo el leaf helper — NO se toca el cuerpo de `resolveRecipients`/`computeSplits`/`settleFeeSplits`/`chargeProtocolFee`.** Comportamiento byte-idéntico. | — |
| `src/types/index.ts` | Modificar | `PublishAgentInput` += `payoutWallet?: string`, `referrerRef?: string`; idem `UpdateAgentInput` (aditivo). | `types/index.ts:118-150` |
| `src/routes/agents.ts` | Modificar | POST+PATCH: validar `payoutWallet` (422 si presente-inválido) y `referrerRef` (422 si presente-inválido: no-string / vacío-tras-trim / >200), capturar ambos (POST → `input`; PATCH → ya fluyen por `body`). | `agents.ts:145-185,264-297` |
| `src/services/agent.ts` | Modificar | `publish()`: persistir `payout_wallet`/`referrer_ref` en el insert (condicional). `update()`: idem en `updateRow` DESPUÉS del ownership guard. Defense-in-depth: `assertValidPayoutWallet`/`assertValidReferrerRef`. NO tocar `AgentRow`/`PublishedAgentRecord`/`mapRowToRecord`/`mapRowToAgent`. | `agent.ts:178-183,312-324,442-458` |
| `src/lib/wallet-format.test.ts` | Crear | Unit del validador (válida/inválida/vacía/no-string). | `price.test.ts` |
| `src/routes/agents.publish.test.ts` | Modificar | Casos de persistencia POST + 422 `payoutWallet`/`referrerRef` inválido + anti-leak en el 201. | mismo archivo |
| `src/routes/agents.ownership.test.ts` | Modificar | PATCH `payoutWallet` cross-owner → 404 sin mutación. | mismo archivo |
| `src/services/agent-split-context.test.ts` | Modificar | AC-7 integración: payout persistido → `resolveAgentSplitContext` arma `creator`. | mismo archivo |

### 4.2 Modelo de datos

N/A — sin cambios de esquema. Las columnas `payout_wallet`/`referrer_ref` ya existen (nullable) y ya están tipadas en `database.types.ts`. Esta HU solo las **puebla** desde el write-path.

### 4.3 Componentes / Servicios

**Validador EVM compartido (`src/lib/wallet-format.ts`)** — resuelve DT-1: hoy el regex está duplicado
en `fee-split.ts:41` y `settle-verifier.ts:82` (y otros ~13 adapters). Para NO crear un tercero, se
extrae el leaf helper que usa `resolveRecipients` a un módulo `lib/`. `fee-split.ts` pasa a importarlo
(garantía de que el publish valida con EXACTAMENTE la misma función que el money-path — CD-1).
Ubicación `lib/` (no `services/`) para que `routes/agents.ts` y `services/agent.ts` lo importen sin
acoplar el publish al módulo money-path `fee-split.ts` (que arrastra adapters/supabase). Sin ciclos:
`lib/wallet-format.ts` no importa nada del proyecto.

**Validación en la ruta (write-boundary, 422):**
- `payoutWallet`: `if (body.payoutWallet !== undefined && !isValidPayoutWallet(body.payoutWallet)) → 422`.
  `isValidPayoutWallet(v) = typeof v === 'string' && isValidWallet(v)`. Cubre string vacío, dirección
  no-EVM, tipo no-string (DT-3: `''` es formato inválido → 422, NUNCA "unset").
- `referrerRef`: `if (body.referrerRef !== undefined && !isValidReferrerRef(body.referrerRef)) → 422`.
  `isValidReferrerRef(v) = typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 200`
  (DT-2). El valor persistido es el **trimmeado**.

**Persistencia (service, defense-in-depth + ownership):**
- `publish()`: tras `assertValidPayoutWallet`/`assertValidReferrerRef` (espejo de `assertValidPriceUsdc`,
  throw genérico), asignación condicional al insert row: `if (input.payoutWallet !== undefined)
  row.payout_wallet = input.payoutWallet;` idem `referrer_ref` (valor trimmeado). Ausente → columna `NULL`
  (AC-5).
- `update()`: los mismos asserts + asignación condicional a `updateRow` **después** del pre-fetch y el
  guard de ownership. El UPDATE final ya filtra por `.eq('slug', slug).eq('owner_ref', ownerRef)`
  (`agent.ts:480-481`) → los campos nuevos heredan el guard sin código nuevo (AC-2/AC-6/CD-2). Ausente
  en el body → no se toca la columna (merge parcial, AC-5).

**Anti-leak (CD-3/AC-8) — por construcción:** `AgentRow`, `PublishedAgentRecord`, `mapRowToRecord` y
`mapRowToAgent` NO declaran `payout_wallet`/`referrer_ref`. El `.select().single()` del insert/update
devuelve la fila completa, pero al castearse a `AgentRow` (que las omite) los mappers nunca las emiten.
La garantía es **no agregarlas** a esos shapes + un test de regresión. `getSplitContextRow` sigue siendo
el ÚNICO lector server-side de esas columnas.

### 4.4 Flujo principal (Happy Path)

**POST /agents con `payoutWallet` (AC-1):**
1. Middleware `requirePaymentOrA2AKey` → `request.a2aKeyRow` (tenant identity).
2. SSRF guard de `agentUrl` (sin cambios).
3. Guard `payoutWallet`/`referrerRef` → válidos, siguen.
4. Se construye `input` con `payoutWallet`/`referrerRef` (condicional).
5. `publishedAgentService.publish(input, keyRow.owner_ref)` → assert + insert con `payout_wallet`/`referrer_ref`.
6. `201` con `PublishedAgentRecord` (SIN los campos nuevos — anti-leak).

**PATCH /agents/:slug con `payoutWallet` (AC-2):**
1. Middleware + SSRF (si `agentUrl` viene).
2. Guards `payoutWallet`/`referrerRef` → 422 si presente-inválido.
3. `publishedAgentService.update(slug, body, keyRow.owner_ref)` → pre-fetch → owner OK → `updateRow` con los campos nuevos → UPDATE filtrado por `(slug, owner_ref)`.
4. `200` con record (SIN los campos nuevos).

**Cobro real (AC-7):** en la siguiente invocación cobrada de ese agente, con `SPLIT_BPS_CREATOR > 0`,
`resolveAgentSplitContext` (WKH-143, sin cambios) lee `payout_wallet` vía `getSplitContextRow` → `creator`
→ `resolveRecipients` → leg de creator a la wallet real. **Cero código nuevo en el money-path de cobro.**

### 4.5 Flujo de error

1. `payoutWallet` presente inválido (typo, no-EVM, `''`, no-string) → `422 { error: 'Invalid payoutWallet', field: 'payoutWallet', reason: ... }`, nada se persiste (AC-3/CD-5).
2. `referrerRef` presente inválido (vacío-tras-trim, >200, no-string) → `422 { error: 'Invalid referrerRef', field: 'referrerRef', reason: ... }`, nada se persiste (DT-2).
3. PATCH sobre slug de otro owner (o inexistente) → `OwnershipMismatchError` → `404 { error: 'Agent not found' }` disclosure-safe, sin mutación (AC-6/CD-2). `logOwnershipMismatch` PII-safe.
4. Cualquier otro error → mensaje estático (`Failed to publish/update agent`), detalle solo al log (CD-10, sin leak).

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir

- **CD-1 (heredado work-item)**: la validación de `payoutWallet` DEBE usar EXACTAMENTE el mismo regex/función que `resolveRecipients` — vía `src/lib/wallet-format.ts` (que `fee-split.ts` también importa). PROHIBIDO un validador paralelo con reglas distintas (checksum EIP-55, longitud distinta, etc.).
- **CD-2 (heredado work-item + CLAUDE.md Ownership Guard)**: toda escritura de `payout_wallet`/`referrer_ref` vía PATCH DEBE pasar por el guard `.eq('owner_ref', ownerRef)` ya existente en `update()`. PROHIBIDO un code path/endpoint que actualice `a2a_agents` sin ese filtro. `getBalance`-style: la firma que recibe el `keyId`/slug ya recibe `ownerRef: string` (no opcional).
- **CD-4 (`exactOptionalPropertyTypes`)**: construir insert/updateRow/`input` con asignación condicional (`if (v !== undefined) obj.x = v`), NUNCA `x: cond ? v : undefined` (heredado WKH-134/143).
- **CD-5 (422)**: `payoutWallet`/`referrerRef` presentes pero inválidos → `422` (mismo status que el guard `priceUsdc`), NUNCA `400` silencioso ni `500`.
- **CD-8 (byte-idéntico)**: con default `10000/0/0` (o `SPLIT_BPS_CREATOR` ausente/vacío) y sin `payoutWallet` en el body, el comportamiento DEBE ser byte-idéntico a hoy — `splitsActive()` → `false`, cero query extra, columnas `NULL`. Verificado por test de regresión.
- **Persistir referrerRef trimmeado** — el valor de `trim()` (DT-2), no el bruto con whitespace.

### PROHIBIDO

- **CD-3 (anti-leak)**: PROHIBIDO exponer `payout_wallet`/`referrer_ref` en NINGUNA respuesta pública (201/200 de POST/PATCH, `GET /agents` list-mine, `agent-card`, `/discover`). PROHIBIDO agregarlas a `AgentRow`/`PublishedAgentRecord`/`mapRowToRecord`/`mapRowToAgent` (hereda CD-5 de WKH-143).
- **CD-6 (referral diferido)**: PROHIBIDO tocar `resolveAgentSplitContext`/`agent-split-context.ts` para activar la lectura de `referrer_ref`. El referral queda INERTE (DT-4) — es WKH-143c.
- **CD-7 (money-path de cobro intacto)**: PROHIBIDO modificar el cuerpo de `computeSplits`/`resolveRecipients`/`settleFeeSplits`/`chargeProtocolFee` (DONE en WKH-136/143). La única edición permitida en `fee-split.ts` es reemplazar el `ADDRESS_RE`/`isValidWallet` PRIVADOS por un import del nuevo `lib/wallet-format.ts` (comportamiento idéntico; `resolveRecipients` sigue llamando `isValidWallet(party.wallet)` igual).
- NO tratar `payoutWallet: ''` como "unset"/borrado → es formato inválido → 422 (DT-3). No hay soporte de unset en v1.
- NO auto-capturar `referrerRef` (query/header/cookie/sesión) — 100% explícito por body.
- NO agregar dependencias nuevas. NO modificar archivos fuera del Scope IN.
- NO crear un TERCER duplicado del regex de wallet EVM.

> **Learnings de auto-blindaje aplicados** (`138-wkh-136` auto-blindaje):
> - CD-8 codifica la disciplina byte-idéntico con default `10000/0/0` (Wave 2 learning).
> - Tests money-path son frágiles ante cambios de cadena `.eq` en el mock supabase: los tests de esta HU NO deben tocar `fee-charge.test.ts`/`fee-charge-splits.test.ts`; el AC-7 se ejercita vía `agent-split-context.test.ts` (mock de `getSplitContextRow`), NO reescribiendo el mock del money-path.

## 6. Scope

**IN:** extensión de tipos, captura+validación 422 en POST/PATCH, persistencia ownership-guarded, validador EVM compartido, anti-leak por construcción, tests.

**OUT:** read-side de referral (`resolveAgentSplitContext` sigue `referral: null` — WKH-143c), `computeSplits`/`resolveRecipients`/`settleFeeSplits`/`chargeProtocolFee`, unset de wallet, auto-captura de referral, prueba de propiedad on-chain de la wallet, multi-wallet por chain, UI/dashboard de publish.

## 7. Waves de Implementación

### Wave 0 (Serial Gate — contratos/tipos)
- [ ] W0.1: `src/lib/wallet-format.ts` — `ADDRESS_RE` + `isValidWallet`. → Exemplar: `fee-split.ts:41,164-166`
- [ ] W0.2: `src/services/fee-split.ts` — reemplazar el leaf helper privado por import de W0.1 (NO tocar cuerpos prohibidos). Verificar `fee-split.test.ts` + suite money-path verdes.
- [ ] W0.3: `src/types/index.ts` — extender `PublishAgentInput` + `UpdateAgentInput`.

### Wave 1 (Parallelizable — depende de W0)
- [ ] W1.1: `src/routes/agents.ts` — guards 422 `payoutWallet`/`referrerRef` (POST+PATCH) + captura en `input`. → Exemplar: `agents.ts:145-185,264-297`
- [ ] W1.2: `src/services/agent.ts` — asserts defense-in-depth + persistencia condicional en `publish()`/`update()`. → Exemplar: `agent.ts:178-183,312-324,442-458`

### Wave 2 (Tests — depende de W1)
- [ ] W2.1: `src/lib/wallet-format.test.ts` (unit validador).
- [ ] W2.2: `src/routes/agents.publish.test.ts` (persistencia POST + 422 + anti-leak 201).
- [ ] W2.3: `src/routes/agents.ownership.test.ts` (PATCH cross-owner → 404 sin mutación).
- [ ] W2.4: `src/services/agent-split-context.test.ts` (AC-7 integración creator real + byte-idéntico default).

### Dependencias
| Tarea | Depende de | Razón |
|-------|-----------|-------|
| W0.2 | W0.1 | fee-split importa el nuevo módulo |
| W1.1, W1.2 | W0.1, W0.3 | usan el validador + tipos extendidos |
| W2.* | W1.* | testean el comportamiento implementado |

## 8. Plan de Tests

| Test | AC / CD que cubre | Wave | Archivo | Framework |
|------|-------------------|------|---------|-----------|
| Validador acepta EVM válida, rechaza inválida/vacía/no-string | CD-1 | W2.1 | `wallet-format.test.ts` (nuevo) | vitest |
| POST persiste `payout_wallet` en el insert row | AC-1 | W2.2 | `agents.publish.test.ts` | vitest |
| POST persiste `referrer_ref` trimmeado | AC-4 | W2.2 | `agents.publish.test.ts` | vitest |
| POST `payoutWallet` inválido (`''`, no-EVM, no-string) → 422, sin insert | AC-3/CD-5/DT-3 | W2.2 | `agents.publish.test.ts` | vitest |
| POST `referrerRef` inválido (vacío-tras-trim, >200) → 422 | AC-4/DT-2 | W2.2 | `agents.publish.test.ts` | vitest |
| 201 NO contiene `payout_wallet`/`referrer_ref` (anti-leak) | AC-8/CD-3 | W2.2 | `agents.publish.test.ts` | vitest |
| PATCH persiste `payout_wallet` del owner sin tocar otros campos | AC-2 | W2.3 | `agents.ownership.test.ts` | vitest |
| PATCH `payoutWallet` inválido → 422 | AC-3/CD-5 | W2.3 | `agents.ownership.test.ts` | vitest |
| PATCH `payoutWallet` cross-owner → 404, `updateCalled` false, `logOwnershipMismatch` llamado | AC-6/CD-2 | W2.3 | `agents.ownership.test.ts` | vitest |
| Integración: payout persistido → `getSplitContextRow` → `resolveAgentSplitContext` arma `creator` con esa wallet → `resolveRecipients(creatorBps>0)` produce leg creator | AC-7 | W2.4 | `agent-split-context.test.ts` | vitest |
| `referrer_ref` persistido pero `resolveAgentSplitContext` sigue `referral: null` (inerte) | DT-4/CD-6 | W2.4 | `agent-split-context.test.ts` | vitest |
| Byte-idéntico: sin `payoutWallet` + default `10000/0/0` → columnas NULL, `splitsActive()` false, sin creator | CD-8/AC-5 | W2.4 | `agent-split-context.test.ts` | vitest |

> El AC-7 se ejercita al nivel read-side (mock de `getSplitContextRow` devolviendo el valor que el
> write-path persiste) para NO tocar el frágil mock supabase de `fee-charge*.test.ts` (learning WKH-136).

## 9. Riesgos

| Riesgo | Prob | Impacto | Mitigación |
|--------|------|---------|------------|
| "Referral inerte" (DT-4) se confunde con bug | A | M | DT-4/CD-6 lo documentan como scope; el DONE report lo repite. |
| Ownership guard bypasseado (setear wallet de agente ajeno) | B | A | AC-6 + reuso EXPLÍCITO del guard de `update()` (CD-2); test cross-owner. |
| `payoutWallet` inválido persistido → rompe silenciosamente el settle | M | A | AC-3/CD-1/CD-5 reject 422 en el write boundary + assert defense-in-depth en el service. |
| Tercer duplicado del regex EVM | M | B | DT-1/CD-1: extracción a `lib/wallet-format.ts`, fee-split importa. |
| Leak de `payout_wallet`/`referrer_ref` en una respuesta | B | A | CD-3/AC-8: no agregar a los shapes públicos + test de regresión del 201. |
| Refactor de `fee-split.ts` rompe la suite money-path | B | A | CD-7: solo se reemplaza el leaf helper por import (idéntico); W0.2 corre `fee-split.test.ts` + money-path verdes antes de seguir. |
| Ciclo de import `agent.ts`→`fee-split.ts` | B | M | Se evita usando `lib/wallet-format.ts` (leaf sin imports del proyecto), no importando `fee-split.ts` desde el publish. |

## 10. Dependencias

- WKH-143 (DONE, fila 144): read-side de creator ya existe y funciona. Esta HU solo puebla la columna.
- Columnas `payout_wallet`/`referrer_ref` ya en prod (testnet) + tipadas — sin migración.

## 11. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| [NEEDS CLARIFICATION] | 4.3 / Scope OUT | Semántica exacta de `referrer_ref` (owner_ref de otro caller vs código de afiliado libre) + resolución `referrer_ref → wallet`. **Diferido a WKH-143c.** | **No** — esta HU solo persiste el string opaco; el referral queda inerte por diseño (DT-4). No bloquea F2/F3. |

> No hay `[NEEDS CLARIFICATION]` bloqueante abierto. El único marker es Scope OUT explícito (WKH-143c).

## 12. Readiness Check

```
READINESS CHECK:
[x] Cada AC tiene ≥1 archivo asociado en tabla 4.1 (AC1-2→agents.ts/agent.ts; AC3-4→agents.ts; AC5→agent.ts; AC6→agent.ts guard; AC7→agent-split-context; AC8→agent.ts mappers)
[x] Cada archivo en 4.1 tiene Exemplar verificado con Glob/Read (paths reales confirmados)
[x] No hay [NEEDS CLARIFICATION] BLOQUEANTE pendiente (el único es Scope OUT → WKH-143c)
[x] Constraint Directives incluyen ≥3 PROHIBIDO (CD-3, CD-6, CD-7 + 4 más)
[x] Context Map tiene ≥2 archivos leídos (11 leídos y verificados)
[x] Scope IN y OUT explícitos y no ambiguos
[x] BD: columnas verificadas que existen y están tipadas (database.types.ts:27,29,41,43,55,57)
[x] Flujo principal (Happy Path) completo (POST + PATCH + cobro AC-7)
[x] Flujo de error definido (422 payoutWallet, 422 referrerRef, 404 ownership, estático CD-10)
```

**SDD LISTO para SPEC_APPROVED.**

---

*SDD generado por NexusAgil — FULL · nexus-architect F2 · WKH-143b*
