# Story File — HU-143b · Write-path de creator/referral

> Contrato autocontenido para `nexus-dev`. **NO releas el SDD** — todo lo que necesitás está acá.
> Fuente: `sdd.md` (SPEC_APPROVED). Branch: `feat/147-wkh-143b-split-writepath`.
> Tipo: **money-path input** (input que determina quién cobra el creator-split). Testnet. **SIN migración.**

---

## 1. Contexto compacto (qué se construye y por qué)

WKH-143 (DONE) ya cableó el **read-side**: `resolveAgentSplitContext` →
`publishedAgentService.getSplitContextRow(slug)` lee `a2a_agents.payout_wallet` y arma el leg de
`creator`. Pero **nadie escribe esa columna hoy** → `payout_wallet` es SIEMPRE `NULL` → todo
creator-split se re-rutea a plataforma.

Esta HU cierra EXCLUSIVAMENTE el **write-path**: el publish self-serve (`POST`/`PATCH /agents`)
captura, valida y persiste `payoutWallet` + `referrerRef`. Con `payout_wallet` válido +
`SPLIT_BPS_CREATOR > 0`, el creator cobra de verdad — **sin código nuevo en el money-path de cobro**
(el read-side de WKH-143 ya lo hace). Con el default `10000/0/0`, byte-idéntico a hoy.

**`referrer_ref` se persiste OPACO pero INERTE**: `resolveAgentSplitContext` sigue retornando
`referral: null`. Activar pagos de referral es WKH-143c (Scope OUT acá). No tocar el read-side.

---

## 2. Scope IN (lista EXHAUSTIVA de archivos a tocar)

| # | Archivo | Acción |
|---|---------|--------|
| 1 | `src/lib/wallet-format.ts` | **Crear** (validador + regex compartido) |
| 2 | `src/services/fee-split.ts` | Modificar — **solo swap del leaf helper** (import) |
| 3 | `src/types/index.ts` | Modificar — extender 2 interfaces (aditivo) |
| 4 | `src/routes/agents.ts` | Modificar — guards 422 + captura (POST+PATCH) |
| 5 | `src/services/agent.ts` | Modificar — asserts + persistencia condicional (publish+update) |
| 6 | `src/lib/wallet-format.test.ts` | **Crear** (unit) |
| 7 | `src/routes/agents.publish.test.ts` | Modificar (persistencia POST + 422 + anti-leak) |
| 8 | `src/routes/agents.ownership.test.ts` | Modificar (PATCH cross-owner 404) |
| 9 | `src/services/agent-split-context.test.ts` | Modificar (AC-7 + inerte + byte-idéntico) |

**PROHIBIDO tocar cualquier archivo fuera de esta lista.** En particular: NO tocar
`src/services/agent-split-context.ts`, `src/services/fee-charge*.test.ts`,
`src/config/split-config.ts`, ni el cuerpo money-path de `fee-split.ts`.

**SIN migración**: las columnas `payout_wallet TEXT NULL` / `referrer_ref TEXT NULL` ya existen en
prod (testnet) y ya están tipadas en `database.types.ts` (`Row:27,29`, `Insert:41,43`,
`Update:55,57`). Confirmado. No crees ni edites archivos en `supabase/migrations/`.

---

## 3. Anti-Hallucination Checklist (verificado contra código real — NO reverificar, ya está hecho)

| Símbolo | Ubicación real confirmada | Uso en esta HU |
|---------|---------------------------|----------------|
| `ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/` | `fee-split.ts:41` | Mover a `wallet-format.ts` |
| `isValidWallet(w): w is string` (privado) | `fee-split.ts:164-166` | Mover a `wallet-format.ts`, fee-split lo importa |
| `isValidWallet` **usado por** `resolveRecipients` | `fee-split.ts:217` | NO tocar esa llamada — sigue igual |
| `isValidPriceUsdc(v): v is number` | `agents.ts:64-66` | **Exemplar** del guard 422 |
| Guard `priceUsdc` inválido → 422 (POST) | `agents.ts:148-158` | **Exemplar** — copiar patrón |
| Guard `priceUsdc` inválido → 422 (PATCH) | `agents.ts:265-275` | **Exemplar** — copiar patrón |
| Construcción condicional de `input` | `agents.ts:163-185` | **Exemplar** `if (typeof x === ...) input.x = x` |
| PATCH pasa `body` crudo a `update()` | `agents.ts:293-297` | referrerRef/payoutWallet fluyen por `body` |
| `mapOwnershipError` → 404 | `agents.ts:39-47`, invocado `:300-301` | Cubre AC-6 sin código nuevo |
| `assertValidPriceUsdc` (write-boundary) | `agent.ts:178-183` | **Exemplar** de assert defense-in-depth |
| Insert row typed | `agent.ts:313-324` | Agregar asignación condicional acá |
| Ownership guard `update()` (pre-fetch + `.eq('owner_ref', ownerRef)`) | `agent.ts:409-426`, UPDATE `:477-483` | REUSAR sin cambios |
| Construcción condicional de `updateRow` | `agent.ts:445-458` | Agregar campos DESPUÉS del guard |
| `getSplitContextRow(slug)` (read-side) | `agent.ts:241-264` | **NO TOCAR** — ya lee las columnas |
| `AgentRow` (SIN payout/referrer) | `agent.ts:42-53` | **NO agregar** los campos (anti-leak) |
| `PublishedAgentRecord` (SIN payout/referrer) | `agent.ts:59-71` | **NO agregar** los campos (anti-leak) |
| `mapRowToRecord` / `mapRowToAgent` | `agent.ts:129-148` / `107-126` | **NO agregar** los campos (anti-leak) |
| `PublishAgentInput` | `types/index.ts:118-135` | Extender (aditivo) |
| `UpdateAgentInput` | `types/index.ts:141-150` | Extender (aditivo) |
| `resolveAgentSplitContext` → `referral: null` | `agent-split-context.ts:48,69` | **NO TOCAR** (referral inerte) |
| Columnas `payout_wallet`/`referrer_ref` tipadas | `database.types.ts:27,29,41,43,55,57` | Insert/Update las soportan sin cast |

**`[VERIFY-AT-IMPL]`**: al abrir cada archivo, confirmá visualmente que las líneas citadas siguen ahí
(pueden haber corrido ±pocas líneas). Si un símbolo NO está donde dice → **PARÁ y reportá al
orquestador**, no improvises un path alternativo.

---

## 4. Waves

### W0 — Serial Gate (validador + tipos). Debe compilar + suite money-path verde ANTES de W1.

**W0.1 — Crear `src/lib/wallet-format.ts`**
- Módulo **leaf**: NO importa NADA del proyecto (evita ciclos). Exemplar de módulo puro:
  `src/lib/price.ts` (comentario "sin Fastify, sin Supabase, sin adapters").
- Exportar:
  - `ADDRESS_RE` (regex EVM, exactamente `/^0x[0-9a-fA-F]{40}$/` — el de `fee-split.ts:41`).
  - `isValidWallet(wallet: string | null | undefined): wallet is string` — cuerpo idéntico al de
    `fee-split.ts:164-166` (`typeof wallet === 'string' && ADDRESS_RE.test(wallet)`).
- Es la **única fuente de verdad** del criterio EVM (CD-1). No cambiar el regex ni agregar checksum
  EIP-55 ni longitud distinta.

**W0.2 — `src/services/fee-split.ts`: swap del leaf helper (ÚNICA edición permitida acá)**
- Borrar la constante privada `ADDRESS_RE` (`:41`) y la función privada `isValidWallet` (`:164-166`).
- Agregar `import { isValidWallet } from '../lib/wallet-format.js';` (nota `.js` — ESM).
- La llamada `isValidWallet(party.wallet)` en `resolveRecipients` (`:217`) queda **idéntica**.
- ⛔ **PROHIBIDO** tocar el cuerpo de `resolveRecipients` / `computeSplits` / `settleFeeSplits` /
  `chargeProtocolFee` / `reverseFeeSplits` / `planSplits`. Comportamiento byte-idéntico (CD-7).
- Gate: `fee-split.test.ts` + toda la suite money-path (`fee-charge*.test.ts`) DEBE seguir verde.
  Si algo se rompe acá, algo se tocó de más.

**W0.3 — `src/types/index.ts`: extender los inputs (aditivo)**
- `PublishAgentInput` (`:118-135`) += `payoutWallet?: string;` y `referrerRef?: string;`.
- `UpdateAgentInput` (`:141-150`) += `payoutWallet?: string;` y `referrerRef?: string;`.
- Aditivo, opcional. `exactOptionalPropertyTypes` → tipo `string` (no `string | undefined`).

### W1 — Rutas + service (depende de W0)

**W1.1 — `src/routes/agents.ts`: guards 422 + captura (POST y PATCH)**
- Import: `import { isValidWallet } from '../lib/wallet-format.js';`
- Definí 2 helpers locales (junto a `isValidPriceUsdc`, `:64-66`):
  - `isValidPayoutWallet(v: unknown): v is string` = `typeof v === 'string' && isValidWallet(v)`.
    (Cubre string vacío / no-EVM / no-string → todos inválidos → 422. `''` es **inválido**, NO
    "unset" — DT-3.)
  - `isValidReferrerRef(v: unknown): v is string` = `typeof v === 'string' && v.trim().length >= 1
    && v.trim().length <= 200`.
- **POST** (`:88+`): después del guard `priceUsdc` (`:148-158`), agregá dos guards espejo:
  ```
  if (body.payoutWallet !== undefined && !isValidPayoutWallet(body.payoutWallet))
     → reply.status(422).send({ error: 'Invalid payoutWallet', field: 'payoutWallet', reason: ... })
  if (body.referrerRef !== undefined && !isValidReferrerRef(body.referrerRef))
     → reply.status(422).send({ error: 'Invalid referrerRef', field: 'referrerRef', reason: ... })
  ```
  Luego, en la construcción condicional de `input` (`:163-185`), agregá:
  ```
  if (typeof body.payoutWallet === 'string') input.payoutWallet = body.payoutWallet;
  if (typeof body.referrerRef === 'string') input.referrerRef = body.referrerRef.trim();
  ```
  (referrerRef se captura **trimmeado** — CD/DT-2.)
- **PATCH** (`:225+`): agregá los MISMOS dos guards 422 después del guard `priceUsdc` (`:265-275`).
  El `body` crudo ya fluye a `publishedAgentService.update(slug, body, keyRow.owner_ref)`
  (`:293-297`) → el service captura los campos. NO reconstruyas el body en la ruta PATCH.
  - ⚠️ El trim del referrerRef en PATCH lo hace el **service** (ver W1.2), porque PATCH pasa `body`
    crudo. Asegurate de que el trim viva en un solo lugar para PATCH: el service.
- El `Body` de POST es `Partial<PublishAgentInput> & Record<string, unknown>` (`:79`) — ya admite los
  campos nuevos. El de PATCH es `Record<string, unknown>` (`:215`) — accedé como
  `body.payoutWallet` / `body.referrerRef`.
- Mensajes de error estáticos (CD-10): no leakear detalle en el body.

**W1.2 — `src/services/agent.ts`: asserts + persistencia condicional**
- Import: `import { isValidWallet } from '../lib/wallet-format.js';`
- Definí 2 asserts defense-in-depth (espejo de `assertValidPriceUsdc` `:178-183`, throw genérico):
  - `assertValidPayoutWallet(v: unknown): void` — `if (v === undefined) return; if (!(typeof v ===
    'string' && isValidWallet(v))) throw new Error('Invalid payoutWallet');`
  - `assertValidReferrerRef(v: unknown): void` — `if (v === undefined) return; if (!(typeof v ===
    'string' && v.trim().length >= 1 && v.trim().length <= 200)) throw new Error('Invalid
    referrerRef');`
- **`publish()`** (`:270-340`):
  - Tras `assertValidPriceUsdc(input.priceUsdc)` (`:297`), agregá
    `assertValidPayoutWallet(input.payoutWallet); assertValidReferrerRef(input.referrerRef);`
  - En el insert `row` (`:313-324`), DESPUÉS de armar el objeto, asignación condicional
    (CD-4 — `exactOptionalPropertyTypes`, NUNCA `x: cond ? v : undefined`):
    ```
    if (input.payoutWallet !== undefined) row.payout_wallet = input.payoutWallet;
    if (input.referrerRef !== undefined) row.referrer_ref = input.referrerRef.trim();
    ```
    (Ausente → columna queda `NULL` — AC-5. El insert de POST ya viene trimmeado desde la ruta;
    re-trim es idempotente y seguro.)
- **`update()`** (`:404-499`):
  - Tras `assertValidPriceUsdc(updates.priceUsdc)` (`:442-443`), agregá los dos nuevos asserts
    (con guard `!== undefined`, igual que priceUsdc).
  - En la construcción de `updateRow` (`:445-458`), **DESPUÉS** del pre-fetch + guard de ownership
    (`:409-426`) — que ya corrió arriba — agregá:
    ```
    if (updates.payoutWallet !== undefined) updateRow.payout_wallet = updates.payoutWallet;
    if (updates.referrerRef !== undefined) updateRow.referrer_ref = updates.referrerRef.trim();
    ```
  - El UPDATE final ya filtra por `.eq('slug', slug).eq('owner_ref', ownerRef)` (`:480-481`) → los
    campos nuevos **heredan el ownership guard sin código nuevo** (AC-2/AC-6/CD-2). PATCH cross-owner
    → `OwnershipMismatchError` (lanzado en `:416`/`:425`) antes de construir `updateRow` → 404.
- ⛔ **NO agregar** `payout_wallet`/`referrer_ref` a `AgentRow` (`:42-53`),
  `PublishedAgentRecord` (`:59-71`), `mapRowToRecord` (`:129-148`) ni `mapRowToAgent`
  (`:107-126`). El `.select()` devuelve la fila completa, pero al castearse a `AgentRow` (que las
  omite) los mappers nunca las emiten → anti-leak por construcción (CD-3/AC-8).
- ⛔ **NO tocar** `getSplitContextRow` (`:241-264`) — read-side de WKH-143.

### W2 — Tests (depende de W1). ≥1 por AC. **12 tests.**

**W2.1 — `src/lib/wallet-format.test.ts` (crear)** — Exemplar: `src/lib/price.test.ts` (unit puro).
1. `isValidWallet` acepta EVM válida (`0x` + 40 hex, mayúsc/minúsc). *(CD-1)*
2. `isValidWallet` rechaza: `''`, address corta/larga, no-hex, no-`0x`, `null`, `undefined`, no-string. *(CD-1)*

**W2.2 — `src/routes/agents.publish.test.ts` (modificar)** — mocks hoisted ya existen
(`mockInsert`, supabase builder, service por método, `node:dns`).
3. **AC-1**: POST con `payoutWallet` válido → persiste `payout_wallet` en el insert row. Verificá el
   valor pasado al insert (capturá el `row` en el mock supabase del path del service real, patrón
   T-PUB-06 `vi.importActual`, o asserteá sobre el mock del método `publish`).
4. **AC-4**: POST con `referrerRef` con whitespace (`'  ref-abc  '`) → persiste `referrer_ref`
   **trimmeado** (`'ref-abc'`).
5. **AC-3/CD-5/DT-3**: POST con `payoutWallet` inválido (`''`, `'0xshort'`, no-string) → **422**,
   `mockInsert` NO llamado.
6. **AC-4/DT-2**: POST con `referrerRef` inválido (`'   '` vacío-tras-trim, string de >200 chars) →
   **422**, sin insert.
7. **AC-8/CD-3 (anti-leak / regresión del 201)**: el body del `201` NO contiene `payout_wallet` ni
   `referrer_ref` (ni `payoutWallet`/`referrerRef`).

**W2.3 — `src/routes/agents.ownership.test.ts` (modificar)** — `state` con
`row/updateCalled/deleteCalled/eqCalls` + `mockLog` (`logOwnershipMismatch`) ya existen; owner
seteable vía `currentOwner`; `OWNER_A_ROW` fixture.
8. **AC-2**: owner hace PATCH de su propio slug con `payoutWallet` válido → 200, `state.updateCalled`
   true, y `state.eqCalls` incluye `['owner_ref', <owner>]` (guard aplicado). Confirmá que otros
   campos no incluidos en el body no se tocan.
9. **AC-3/CD-5**: PATCH con `payoutWallet` inválido → **422**, `state.updateCalled` false.
10. **AC-6/CD-2**: owner B hace PATCH del slug de owner A con `payoutWallet`/`referrerRef` → **404**,
    `state.updateCalled` false, `mockLog` (logOwnershipMismatch) llamado. Nada persistido.

**W2.4 — `src/services/agent-split-context.test.ts` (modificar)** — mock `mockGetSplitContextRow`
ya existe (spy inyectado en `publishedAgentService.getSplitContextRow`). **NO tocar el mock supabase
frágil de `fee-charge*.test.ts`** (learning WKH-136) — el AC-7 se ejercita acá, al nivel read-side.
11. **AC-7 (creator cobra)**: mock `getSplitContextRow` devolviendo `{ ownerRef, payoutWallet:
    '0x...40hex', referrerRef: null }` (el valor que el write-path persiste) → `resolveAgentSplitContext`
    arma `creator = { wallet, ownerRef }` no-null (integración read-side). Opcional: pasar ese
    `creator` a `resolveRecipients` con `creatorBps > 0` y verificar que produce un leg `creator`.
12. **DT-4/CD-6 (referral inerte) + CD-8/AC-5 (byte-idéntico)**: (a) con `referrerRef` seteado en el
    row mock, `resolveAgentSplitContext` sigue devolviendo `referral: null`. (b) con `payoutWallet:
    null` (default, sin write-path), `creator` es `null` → sin creator (byte-idéntico al comportamiento
    previo).

---

## 5. Patrones a seguir (exemplars verificados)

- **Módulo leaf puro**: `src/lib/price.ts` — sin deps del proyecto. Modelo para `wallet-format.ts`.
- **Guard 422 en ruta**: `agents.ts:148-158` (`isValidPriceUsdc` + `reply.status(422).send({ error,
  field, reason })`). Copiá la forma exacta.
- **Construcción condicional (`exactOptionalPropertyTypes`)**: `agents.ts:163-185` /
  `agent.ts:445-458` — `if (v !== undefined) obj.x = v`. NUNCA ternario con `undefined`.
- **Assert defense-in-depth**: `agent.ts:178-183` (`assertValidPriceUsdc`) — throw genérico.
- **Ownership guard reusado**: `agent.ts:409-426` + `.eq('owner_ref', ownerRef)` en `:480-481`.
- **Anti-leak por omisión**: `AgentRow`/`PublishedAgentRecord`/`mapRowToRecord` omiten los campos.
- **Test route con mocks hoisted**: `agents.publish.test.ts:27-73`.
- **Test ownership con `state.eqCalls`**: `agents.ownership.test.ts:23-88`.
- **Test read-side con `mockGetSplitContextRow`**: `agent-split-context.test.ts`.

---

## 6. Constraint Directives (heredados — INVIOLABLES)

- **CD-1**: `payoutWallet` valida con EXACTAMENTE `isValidWallet` de `lib/wallet-format.ts` (el mismo
  que `resolveRecipients`). Prohibido validador paralelo (checksum EIP-55, longitud distinta).
- **CD-2**: toda escritura vía PATCH pasa por el guard `.eq('owner_ref', ownerRef)` existente en
  `update()`. Prohibido un code path que actualice `a2a_agents` sin ese filtro. Firma recibe
  `ownerRef: string` (no opcional).
- **CD-3 (anti-leak)**: PROHIBIDO exponer `payout_wallet`/`referrer_ref` en cualquier respuesta
  pública (201/200, list-mine, agent-card, /discover). PROHIBIDO agregarlos a
  `AgentRow`/`PublishedAgentRecord`/`mapRowToRecord`/`mapRowToAgent`.
- **CD-4 (`exactOptionalPropertyTypes`)**: asignación condicional, nunca `x: cond ? v : undefined`.
- **CD-5 (422)**: `payoutWallet`/`referrerRef` presentes-inválidos → 422 (nunca 400 silencioso / 500).
- **CD-6 (referral diferido)**: PROHIBIDO tocar `resolveAgentSplitContext`/`agent-split-context.ts`
  para leer `referrer_ref`. Referral INERTE — es WKH-143c.
- **CD-7 (money-path intacto)**: PROHIBIDO modificar el cuerpo de
  `computeSplits`/`resolveRecipients`/`settleFeeSplits`/`chargeProtocolFee`. Única edición en
  `fee-split.ts`: swap del `ADDRESS_RE`/`isValidWallet` privados por el import.
- **CD-8 (byte-idéntico)**: default `10000/0/0` + sin `payoutWallet` → comportamiento byte-idéntico,
  columnas `NULL`, cero query extra. Verificado por test.
- **Trim**: `referrerRef` persistido es el valor **trimmeado** (DT-2).
- `payoutWallet: ''` → 422 (formato inválido), NUNCA "unset" (DT-3). No hay unset en v1.
- NO auto-capturar `referrerRef` (query/header/cookie/sesión) — 100% explícito por body.
- NO agregar dependencias. NO tocar el mock supabase de `fee-charge*.test.ts`.

---

## 7. Done Definition

- [ ] `src/lib/wallet-format.ts` creado (leaf, exporta `ADDRESS_RE` + `isValidWallet`).
- [ ] `fee-split.ts` importa el helper; cuerpo money-path intacto; suite money-path verde.
- [ ] `PublishAgentInput`/`UpdateAgentInput` extendidos (aditivo).
- [ ] POST+PATCH: guards 422 `payoutWallet`/`referrerRef` + captura (POST → input; PATCH → body).
- [ ] `publish()`/`update()`: asserts + persistencia condicional; update DESPUÉS del ownership guard.
- [ ] `AgentRow`/`PublishedAgentRecord`/mappers SIN los campos nuevos (anti-leak).
- [ ] `resolveAgentSplitContext` NO tocado (referral inerte).
- [ ] 12 tests (≥1/AC) verdes.
- [ ] `npm run build` (TypeScript strict, sin `any`) + `npm test` verdes.
- [ ] SIN migración, sin deps nuevas, sin archivos fuera del Scope IN.

---

*Story File generado por NexusAgil — nexus-architect F2.5 · WKH-143b · desde sdd.md (SPEC_APPROVED)*
