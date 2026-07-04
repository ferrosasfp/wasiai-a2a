# SDD #148: [WKH-143c] Activar referral real en los splits (Opción B)

> SPEC_APPROVED: no
> Fecha: 2026-07-04
> Tipo: feature/billing (money-path — agrega un 3er destinatario de fee)
> SDD_MODE: full
> Branch: feat/148-wkh-143c-activate-referral
> Artefactos: doc/sdd/148-wkh-143c-activate-referral/

---

## 1. Resumen

WKH-143 cableó el read-side de los splits pero hardcodea `referral: null` para
siempre (DT-6). WKH-143b agregó el write-path: `a2a_agents.referrer_ref` se
persiste hoy como string opaco pero **nadie lo lee**. Esta HU cierra DT-6:
`resolveAgentSplitContext` deja de devolver `referral: null` incondicionalmente
y resuelve el `referrer_ref` a una wallet real.

**Semántica decidida por el humano — Opción B (NO se reabre):** `referrer_ref`
es el **`slug` de OTRO agente self-published**. Su wallet de referral es el
`payout_wallet` de ESE agente, resuelto con **exactamente el mismo método que
el creator** (`getSplitContextRow(referrer_ref)`) — cero lookup nuevo. El
referral solo paga cuando `SPLIT_BPS_REFERRAL > 0` **Y** el agente primario
declaró un `referrer_ref` que resuelve a un `payout_wallet` válido **distinto**
del creator. Con el default `10000/0/0` el comportamiento es byte-idéntico a hoy.
Testnet. NO se toca el engine de splits (`fee-split.ts`).

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 148 |
| **Tipo** | feature/billing (money-path) |
| **SDD_MODE** | full |
| **Objetivo** | Activar el leg de `referral` del protocol fee resolviendo `referrer_ref` (slug de otro agente self-published) a su `payout_wallet` vía `getSplitContextRow`, dentro de `resolveAgentSplitContext`. |
| **Reglas de negocio** | Opción B (slug → payout_wallet del referrer). Fail-safe → `null`. Dedup self-referral (misma wallet que creator → `null`). Byte-idéntico con default. Anti-leak. Σbps==10000 fail-closed intacto. |
| **Scope IN** | `src/services/agent-split-context.ts` (resolución del referral, rama self-published) + `src/config/split-config.ts` (nuevo gate `referralActive()` no-throw) + tests. |
| **Scope OUT** | `fee-split.ts` (engine), `fee-charge.ts` (`chargeProtocolFee`), call-sites (`orchestrate.ts`/`compose.ts`), write-path (`agent.ts`/`routes/agents.ts`), mappers públicos. |
| **Missing Inputs** | N/A — la única decisión bloqueante (semántica de `referrer_ref`) ya está resuelta: **Opción B**. |

### Acceptance Criteria (EARS)

1. **AC-1** WHILE `SPLIT_BPS_REFERRAL` es `0` (default) o ambos `SPLIT_BPS_CREATOR`
   y `SPLIT_BPS_REFERRAL` son `0`, THE system SHALL mantener el path byte-idéntico
   a hoy — cero query extra de resolución del referrer (el 2º `getSplitContextRow`
   NO corre).
2. **AC-2** IF la wallet resuelta para `referral` es inválida (`!isValidWallet`) o
   no se pudo resolver (row del referrer ausente / `payout_wallet` null), THEN THE
   system SHALL devolver `referral: null` — el skip/re-ruta lo maneja
   `resolveRecipients` (SG-6), sin código nuevo en `fee-split.ts`.
3. **AC-3** WHEN el agente primario NO tiene `referrer_ref` (`NULL`), THE system
   SHALL resolver `referral: null` sin lookup extra.
4. **AC-4** THE system SHALL NUNCA exponer `referrer_ref` ni la wallet del referral
   resuelta en ninguna respuesta pública ni log no PII-safe (mappers intactos).
5. **AC-5** IF el lookup del referrer lanza un error (DB, narrowing, timeout), THEN
   THE system SHALL degradar a `referral: null` **preservando el `creator`** —
   nunca propagar el error ni romper el charge/200.
6. **AC-6** WHEN `SPLIT_BPS_REFERRAL > 0` Y el `referrer_ref` resuelve a un
   `payout_wallet` válido **distinto** del `creator`, THE system SHALL devolver
   `referral = { wallet: payout_wallet del referrer, ownerRef: owner_ref del
   referrer }` vía `getSplitContextRow(referrer_ref)`.
7. **AC-7 (self-referral dedup)** WHEN la wallet resuelta del referral es igual
   (case-insensitive) a la wallet del `creator`, THE system SHALL resolver
   `referral: null` — evita pagar dos veces al mismo party.

## 3. Context Map (Codebase Grounding)

### Archivos leidos (verificados con Read)

| Archivo | Por que | Patron extraido |
|---------|---------|-----------------|
| `src/services/agent-split-context.ts` | Es el ÚNICO archivo de lógica a modificar; hoy hardcodea `referral: null` en ambas ramas (`:48`, `:69`). | Rama self-published llama `getSplitContextRow(agent.slug)` (`:44`), arma `creator` desde `row.payoutWallet`+`row.ownerRef` (`:45-47`). try/catch function-wide best-effort → `{null,null}` (`:70-78`). |
| `src/services/agent.ts` (`getSplitContextRow`, `:271-294`) | Es el método que Opción B reusa para resolver el referrer. | Devuelve `{ ownerRef, payoutWallet: string\|null, referrerRef: string\|null }` o `null` (`.eq('slug', slug).maybeSingle()`). Server-side puro — esas columnas NUNCA entran a un shape público (CD-5). |
| `src/config/split-config.ts` | Fuente del gate. `splitsActive()` (`:126-136`) peek no-throw de creator OR referral. Hay que agregar un peek análogo específico de referral. | `splitsActive()` = `peek(SPLIT_BPS_CREATOR) \|\| peek(SPLIT_BPS_REFERRAL)`; `peek` = entero `>0` sin cache, nunca throwea (a diferencia de `getSplitConfig()` fail-closed). |
| `src/services/fee-split.ts` (`resolveRecipients`, `:196-253`; `SplitPartyRef`, `:81-85`) | Consumidor de `referral`. NO se toca (CD-1). | `resolveParty('referral', config.referralBps, ctx.referral)`: `bps<=0 → return` (ni leg ni skipped); `isValidWallet(party.wallet)` OK → recipient; sino skip + re-ruta bps a plataforma (SG-6). El único juez de la wallet es `isValidWallet`. |
| `src/lib/wallet-format.ts` | Single source del criterio EVM (CD-1). | `isValidWallet(w): w is string` = `/^0x[0-9a-fA-F]{40}$/`. Formato-only, mixed-case aceptado. |
| `src/services/orchestrate.ts` (`:1071-1094`) | Call-site A. NO se toca. | `if (pipeline.success)` → `if (splitsActive()) { splitCtx = await resolveAgentSplitContext(steps[0].agent); creator=…; referral=… }`; `feeParams` construido con asignación condicional (`if (creator)`, `if (referral)`). Con default el gate es false → helper NO corre → `feeParams` byte-idéntico. |
| `src/routes/compose.ts` (`:576-599`) | Call-site B. NO se toca. | Espejo de orchestrate: mismo gate `splitsActive()`, misma asignación condicional de `creator`/`referral`. |
| `src/services/agent-split-context.test.ts` | Test a extender. | Mockea `publishedAgentService.getSplitContextRow` + `logger`. Fixtures `agent()`, `PAYOUT`. T-CTX-* / T-143B-* ya cubren creator + `referral: null` sin env de referral. |
| `src/config/split-config.test.ts` | Test a extender para `referralActive()`. | Suite existente de `getSplitConfig`/`splitsActive`. |

### Estado de datos relevante

| Hecho | Evidencia | Implicación de diseño |
|-------|-----------|-----------------------|
| `payout_wallet` se persiste **raw** (NO lowercased) | `agent.ts:361-362` — `row.payout_wallet = input.payoutWallet` tras `isValidWallet` (que acepta mixed-case). | Dos agentes pueden tener la MISMA address en distinto casing → la dedup self-referral (AC-7) DEBE comparar **case-insensitive** (`toLowerCase()`), sino un self-referral con casing distinto pagaría doble. |
| `slug` de `a2a_agents` es único (PK-like, `.eq('slug')`) | `agent.ts:250-260`, `:271-294`. | Resolución del referrer determinística (0 o 1 fila). Cero ambigüedad (a diferencia de Opción A/`owner_ref`). |
| `getSplitContextRow` ya trae `referrerRef` pero se ignora | `agent-split-context.ts:44-48` solo lee `row.payoutWallet`/`row.ownerRef`. | Cerrar DT-6 = leer `row.referrerRef` + un 2º `getSplitContextRow(referrerRef)`. Cero lookup nuevo. |
| Los call-sites gatean `resolveAgentSplitContext` tras `splitsActive()` | `orchestrate.ts:1079`, `compose.ts:584`. | Con default `10000/0/0` la función NO se invoca → byte-idéntico garantizado ARRIBA del helper (no depende de esta HU). |

### Componentes reutilizables encontrados
- `publishedAgentService.getSplitContextRow(slug)` — se reusa **tal cual** para
  resolver el referrer (Opción B). NO crear un lookup nuevo.
- `isValidWallet` (`src/lib/wallet-format.ts`) — validación EVM. Nota: en Opción B
  la wallet del referrer es un `payout_wallet` que YA fue validado en el
  write-path (`assertValidPayoutWallet`, `agent.ts:191-196`); igual `resolveRecipients`
  re-valida con `isValidWallet` (único juez, CD-2). No hace falta re-validar en
  `agent-split-context.ts` (mismo contrato que el `creator`, que tampoco re-valida).
- `splitsActive()` (`split-config.ts`) — patrón peek no-throw a espejar para
  `referralActive()`.

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Accion | Descripcion | Exemplar |
|---------|--------|-------------|----------|
| `src/config/split-config.ts` | Modificar | Agregar `referralActive(): boolean` — peek no-throw de `SPLIT_BPS_REFERRAL > 0` (mismo `peek` interno que `splitsActive`). Export aditivo; `splitsActive()` intacto. | `splitsActive()` (`split-config.ts:126-136`) |
| `src/services/agent-split-context.ts` | Modificar | En la rama self-published: tras resolver `creator`, si `referralActive() && row?.referrerRef` → 2º `getSplitContextRow(row.referrerRef)` (inner try/catch best-effort) → arma `referral` con dedup vs `creator`. Rama registry externo: `referral: null` sin cambios. | La resolución del `creator` en el mismo archivo (`:44-48`) |
| `src/services/agent-split-context.test.ts` | Modificar | Agregar tests de referral (resuelve, inválido, dedup, bps-off, sin referrer, throw). Suite existente intacta. | Tests existentes T-CTX-*/T-143B-* del mismo archivo |
| `src/config/split-config.test.ts` | Modificar | Agregar test unitario de `referralActive()` (env `>0` → true; ausente/`0`/basura → false). | Tests de `splitsActive()` del mismo archivo |

### 4.2 Modelo de datos

N/A — cero cambios de BD. Se reusa el SELECT existente de `getSplitContextRow`
(`owner_ref, payout_wallet, referrer_ref`) sin tocar columnas ni migraciones.

### 4.3 Diseño de la resolución (sin código)

**`referralActive()` (split-config.ts):** peek no-throw idéntico al de
`splitsActive()`, pero SOLO sobre `SPLIT_BPS_REFERRAL`. Devuelve `true` sii
parsea a entero `>0`. Nunca throwea. Razón: se necesita un gate fino específico
del referral — con `SPLIT_BPS_CREATOR>0` pero `SPLIT_BPS_REFERRAL=0`,
`splitsActive()` es `true` (corre el helper por el creator) pero el lookup del
referrer NO debe correr (cero query extra, AC-1). PROHIBIDO usar `getSplitConfig()`
acá (throwea `SplitConfigError` → reintroduce BLQ-MED-1).

**`resolveAgentSplitContext` — rama self-published:**
1. `row = await getSplitContextRow(agent.slug)` (como hoy).
2. `creator = row?.payoutWallet ? { wallet: row.payoutWallet, ownerRef: row.ownerRef } : null` (como hoy).
3. `referral = null` por defecto.
4. **Gate del lookup:** `if (referralActive() && row?.referrerRef)` → resolver el
   referrer; en cualquier otro caso `referral` queda `null` sin 2ª query (AC-1, AC-3).
5. **Resolución del referrer (inner try/catch, best-effort AC-5):**
   - `refRow = await getSplitContextRow(row.referrerRef)`.
   - Si `!refRow?.payoutWallet` → `referral = null` (AC-2).
   - Sino candidato `{ wallet: refRow.payoutWallet, ownerRef: refRow.ownerRef }`.
   - **Dedup self-referral (AC-7):** si `creator` existe y
     `candidate.wallet.toLowerCase() === creator.wallet.toLowerCase()` →
     `referral = null` (no pagar dos veces al mismo party). Sino
     `referral = candidate`.
   - `catch` → log + `referral = null` (creator SE PRESERVA — el inner catch NO
     toca `creator`).
6. `return { creator, referral }`.

**Rama registry externo:** sin cambios — `referral: null`. Justificación: el
write-path (WKH-143b) persiste `referrer_ref` SOLO para agentes self-published;
un agente de registry externo no tiene `referrer_ref` legible (viene de
`agent.metadata`, sin ese campo). Resolver referral para externos sería inventar
datos → fuera de Opción B.

**try/catch externo:** el existente (`:70-78`, function-wide) se mantiene como
red de seguridad final. El inner try/catch del referrer es adicional para que un
fallo de la 2ª query degrade SOLO `referral` sin perder `creator` (AC-5). Sin el
inner catch, un throw del referrer lookup caería al catch externo y borraría el
`creator` — regresión inaceptable.

### 4.4 Flujo principal (Happy Path — AC-6)

1. Operador setea `SPLIT_BPS_PLATFORM=8000`, `SPLIT_BPS_CREATOR=1500`,
   `SPLIT_BPS_REFERRAL=500` (Σ=10000).
2. Caller invoca `/orchestrate` o `/compose`; el pipeline tiene éxito; el fee se
   cobra post-success.
3. Call-site: `splitsActive()` true → `resolveAgentSplitContext(steps[0].agent)`.
4. Agente primario self-published con `payout_wallet=W_creator` y
   `referrer_ref='otro-slug'`.
5. `referralActive()` true + `referrer_ref` presente → `getSplitContextRow('otro-slug')`
   → `payout_wallet=W_ref` (≠ W_creator).
6. `referral = { wallet: W_ref, ownerRef: owner del referrer }`.
7. `chargeProtocolFee` (sin tocar) → `resolveRecipients` rutea 500 bps a `W_ref`,
   1500 a `W_creator`, 8000 a plataforma. `settleFeeSplits` cobra los legs.

### 4.5 Flujos de error / borde

1. **`referrer_ref` = slug inexistente** → `getSplitContextRow` → `null` →
   `referral: null` → `resolveRecipients` re-ruta 500 bps a plataforma (SG-6). AC-2.
2. **`referrer_ref` de un agente sin `payout_wallet`** → `payoutWallet null` →
   `referral: null` → re-ruta a plataforma. AC-2.
3. **Self-referral** (referrer resuelve a la misma wallet que el creator, incl.
   `referrer_ref === agent.slug` o distinto slug misma wallet) → dedup → `referral: null`
   → sus 500 bps se re-rutan a plataforma. AC-7.
4. **2ª query rechaza** (DB down/timeout) → inner catch → `referral: null`,
   `creator` preservado, log.error. AC-5.
5. **`SPLIT_BPS_REFERRAL=0`** → `referralActive()` false → cero 2ª query, aunque el
   agente tenga `referrer_ref`. AC-1 / CD-5 (no auto-activación).

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir
- **CD-B1 (Opción B, decidida):** `referrer_ref` = `slug` de otro agente
  self-published; su wallet = `payout_wallet` resuelto vía
  `getSplitContextRow(referrer_ref)` — el MISMO método que el `creator`. PROHIBIDO
  un lookup nuevo, una tabla nueva, o reinterpretar `referrer_ref` como wallet
  cruda (Opción C) u `owner_ref` (Opción A).
- **CD-B2 (dedup self-referral, AC-7):** si la wallet del referral iguala
  (case-insensitive, `toLowerCase()`) la wallet del `creator` → `referral: null`.
  Justificación: `payout_wallet` se persiste raw (mixed-case, `agent.ts:361`),
  la comparación exacta dejaría pasar el mismo payee en distinto casing.
- **CD-B3 (fail-safe, AC-2/AC-5):** cualquier fallo de resolución del referrer
  (row ausente, `payout_wallet` null, throw) → `referral: null`. El inner try/catch
  degrada SOLO `referral`, preservando `creator`. Nunca propaga.
- **CD-B4 (gate fino, AC-1):** el 2º `getSplitContextRow` corre SÓLO si
  `referralActive()` (peek no-throw de `SPLIT_BPS_REFERRAL>0`) **y** hay
  `referrer_ref`. Con `SPLIT_BPS_REFERRAL=0` → cero query extra.
- **CD-1 (heredado WKH-143b):** cualquier validación de wallet usa EXACTAMENTE
  `isValidWallet` de `src/lib/wallet-format.ts` (single source). El juez final de
  la wallet del referral sigue siendo `resolveRecipients` (no re-validar en el
  seam, igual que el `creator`).
- **CD-10 (heredado WKH-143):** resolución best-effort — degrada, no rompe el charge.
- **Anti-recurrencia import-order (WKH-143 + WKH-143b, ≥2 HUs):** correr
  `npx @biomejs/biome check --write` sobre TODO archivo tocado antes de cerrar la
  wave. Los imports nuevos (`referralActive` en agent-split-context.ts) deben
  respetar el orden alfabético intra-grupo que Biome computa —
  `ref: WKH-143 auto-blindaje / WKH-143b auto-blindaje`.
- **Anti-recurrencia exactOptionalPropertyTypes (WKH-133/134/136, ≥2 HUs):** al
  construir `SplitPartyRef` no usar `x: cond ? v : undefined`; el shape
  `{ wallet, ownerRef }` es todo-requerido, sin opcionales — mantenerlo así.
  `ref: WKH-136 auto-blindaje#exactOptionalPropertyTypes`.

### PROHIBIDO
- **CD-P1:** PROHIBIDO modificar el cuerpo de
  `computeSplits`/`resolveRecipients`/`settleFeeSplits`/`reverseFeeSplits`/
  `chargeProtocolFee` (engine money-path, `fee-split.ts`/`fee-charge.ts`).
- **CD-P2 (anti-leak, AC-4):** PROHIBIDO exponer `referrer_ref` o la wallet del
  referral en cualquier respuesta pública, mapper (`mapRowToAgent`/`mapRowToRecord`)
  o log no PII-safe. NO tocar mappers.
- **CD-P3 (byte-idéntico, AC-1):** PROHIBIDO introducir cualquier query o cambio de
  shape que rompa el default `10000/0/0`. El exact-match `orchestrate.test.ts:557`
  (`chargeProtocolFee` llamado con `{ orchestrationId, feeBaseUsdc, feeRate }`
  exacto) DEBE quedar verde sin cambios.
- **CD-P4:** PROHIBIDO tocar los call-sites (`orchestrate.ts`, `compose.ts`) ni el
  write-path (`agent.ts` publish/patch, `routes/agents.ts`,
  `assertValidReferrerRef`) — fuera de scope.
- **CD-P5 (no auto-activación, heredado CD-5 WKH-143c):** PROHIBIDO que un
  `referrer_ref` ya persistido empiece a cobrar sin que el operador setee
  `SPLIT_BPS_REFERRAL>0` — garantizado por `referralActive()`.
- **CD-P6:** PROHIBIDO modificar `splitsActive()`, `getSplitConfig()` o el fail-closed
  Σbps==10000. `referralActive()` es un export ADITIVO.
- **CD-P7:** PROHIBIDO modificar archivos fuera de la tabla 4.1.

## 6. Scope

**IN:**
- `src/config/split-config.ts`: `referralActive()` (nuevo, aditivo).
- `src/services/agent-split-context.ts`: resolución del `referral` en la rama
  self-published (Opción B + dedup + fail-safe + gate fino).
- Tests: `agent-split-context.test.ts` + `split-config.test.ts`.

**OUT:**
- Engine de splits (`fee-split.ts`, `fee-charge.ts`), call-sites, write-path,
  mappers, migraciones, referral en registry externo, programa de referidos
  (dashboards/tracking/multi-nivel), prueba de control de la wallet del referrer.

## 7. Riesgos

| Riesgo | Prob | Impacto | Mitigacion |
|--------|------|---------|------------|
| Query extra del referrer en el default → rompe byte-idéntico | B | A | CD-B4/CD-P3: gate `referralActive()`; test `T-REF-BPS-OFF` asserta `getSplitContextRow` llamado 1 sola vez; `orchestrate.test.ts:557` verde sin cambios. |
| Doble pago al mismo payee (self-referral) | M | M | CD-B2: dedup case-insensitive vs `creator.wallet`; test `T-REF-SELF-DEDUP`. |
| Fallo del lookup del referrer borra el `creator` | M | M | CD-B3: inner try/catch degrada solo `referral`; test `T-REF-THROW` asserta `creator` preservado. |
| Leak de `referrer_ref`/wallet en respuesta pública | B | A | CD-P2: no se tocan mappers; suite de public-shape (discovery/agent-card) queda verde. |
| Auto-activación de pagos sobre `referrer_ref` ya persistido | B | M | CD-P5: `referralActive()` exige `SPLIT_BPS_REFERRAL>0` explícito. |
| Casing distinto del mismo address evade la dedup | M | M | CD-B2 comparación `toLowerCase()` (payout_wallet raw, `agent.ts:361`). |

## 8. Dependencias

- WKH-143 (DONE, read-side creator + seam best-effort) — presente.
- WKH-143b (DONE, write-path `referrer_ref`/`payout_wallet` + `wallet-format.ts`) —
  presente.
- `getSplitContextRow` devuelve `referrerRef` (`agent.ts:271-294`) — presente.

## 9. Plan de tests

Framework: **vitest** (patrón del repo). Los tests de referral setean/limpian
`process.env.SPLIT_BPS_REFERRAL` (config sin cache, `split-config.ts` lee por-call).

| Test | AC / CD que cubre | Archivo | Descripción |
|------|-------------------|---------|-------------|
| `T-REF-RESOLVE` | AC-6, CD-B1 | `agent-split-context.test.ts` | `SPLIT_BPS_REFERRAL='500'`; self-published slug `A` con `payoutWallet=W_creator`, `referrerRef='B'`; 2º `getSplitContextRow('B')` → `payoutWallet=W_ref` (≠). Asserta `referral={wallet:W_ref, ownerRef:owner-B}`, `getSplitContextRow` llamado con `'A'` y con `'B'`, `creator` intacto. |
| `T-REF-INVALID` | AC-2 | `agent-split-context.test.ts` | `referrer_ref` → row `null` (o `payoutWallet:null`) → `referral:null`, `creator` intacto. |
| `T-REF-SELF-DEDUP` | AC-7, CD-B2 | `agent-split-context.test.ts` | referrer resuelve a la MISMA wallet que el creator (incl. casing distinto, ej. `W` vs `W.toUpperCase()`-hex) → `referral:null`. |
| `T-REF-BPS-OFF` | AC-1, CD-B4/CD-P3 | `agent-split-context.test.ts` | `SPLIT_BPS_REFERRAL` unset/`'0'`; agente con `referrerRef` seteado → `referral:null` y `getSplitContextRow` llamado **1 sola vez** (solo el slug primario) — cero query extra. |
| `T-REF-NO-REFERRER` | AC-3 | `agent-split-context.test.ts` | `SPLIT_BPS_REFERRAL='500'` pero `referrerRef:null` → `referral:null`, sin 2ª query. |
| `T-REF-THROW` | AC-5, CD-B3 | `agent-split-context.test.ts` | `SPLIT_BPS_REFERRAL='500'`; 2º `getSplitContextRow` (referrer) rechaza → `referral:null`, **`creator` preservado**, `log.error` llamado, sin propagar. |
| `T-REFACTIVE` | AC-1, CD-B4 | `split-config.test.ts` | `referralActive()`: `'500'`→true; unset/`''`/`'0'`/`'abc'`/`'12.5'`→false. |
| No-regresión existente | AC-4, CD-P3 | `agent-split-context.test.ts` (T-CTX-*/T-143B-*) | Sin env de referral → `referralActive()` false → `referral:null` → suite existente verde SIN cambios (byte-idéntico). Nota: el comentario `DT-6 referral SIEMPRE null` puede ajustarse a "null salvo SPLIT_BPS_REFERRAL>0 + referrer resuelto"; no cambia asserts. |
| No-regresión money-path | CD-P1/CD-P3 | `orchestrate.test.ts`, `fee-charge-splits.test.ts`, `fee-split.test.ts`, `compose.test.ts` | Deben quedar verdes sin cambios (engine + call-sites intactos). |
| Anti-leak | AC-4, CD-P2 | `discovery.selfpublished.test.ts`, `agent-card.test.ts` (existentes) | Verdes sin cambios — ningún shape público expone `referrer_ref`/wallet del referral. |

## 10. Waves de Implementación

### Wave 0 (Serial Gate — contrato/helper)
- [ ] W0.1: `split-config.ts` — agregar `referralActive()` (peek no-throw de
  `SPLIT_BPS_REFERRAL>0`, espejo de `splitsActive()`). → Exemplar: `splitsActive()`
  `split-config.ts:126-136`.
- [ ] W0.2: `split-config.test.ts` — `T-REFACTIVE`. Verificación: `tsc --noEmit` +
  tests de split-config verdes + `biome check`.

### Wave 1 (Depende de W0 — lógica)
- [ ] W1.1: `agent-split-context.ts` — resolución del referral en rama
  self-published: gate `referralActive() && row?.referrerRef`, 2º
  `getSplitContextRow`, dedup case-insensitive, inner try/catch best-effort.
  Import de `referralActive` respetando orden Biome. → Exemplar: resolución del
  `creator` en el mismo archivo (`:44-48`).

### Wave 2 (Depende de W1 — tests)
- [ ] W2.1: `agent-split-context.test.ts` — T-REF-RESOLVE, T-REF-INVALID,
  T-REF-SELF-DEDUP, T-REF-BPS-OFF, T-REF-NO-REFERRER, T-REF-THROW; verificar suite
  existente verde. Exemplar: tests T-CTX-*/T-143B-* del mismo archivo.

### Wave 3 (Final — verificación)
- [ ] W3.1: `biome check --write` sobre los 4 archivos tocados (anti-recurrencia
  import-order). `tsc --noEmit`. Suite completa verde (incl.
  `orchestrate.test.ts:557` exact-match, money-path, anti-leak).

## 11. Verificación Incremental

| Wave | Verificación al completar |
|------|--------------------------|
| W0 | `tsc --noEmit` + `split-config.test.ts` verde + `biome check` |
| W1 | `tsc --noEmit` + `biome check` (import order) |
| W2 | `agent-split-context.test.ts` completo verde |
| W3 | Suite full verde: money-path (`orchestrate`/`compose`/`fee-charge-splits`/`fee-split`) + anti-leak (`discovery.selfpublished`/`agent-card`) sin cambios |

## 12. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| — | — | Ninguno. La decisión de producto (semántica de `referrer_ref`) está resuelta: **Opción B**. Cero `[NEEDS CLARIFICATION]` abiertos. | No |

---

## READINESS CHECK

- [x] Cada AC tiene ≥1 archivo asociado en tabla 4.1 (AC-1..AC-7 → agent-split-context.ts + split-config.ts + tests).
- [x] Cada archivo en 4.1 tiene Exemplar verificado con Read/Glob (paths reales confirmados).
- [x] No hay `[NEEDS CLARIFICATION]` pendientes (Opción B decidida).
- [x] Constraint Directives incluyen ≥3 PROHIBIDO (CD-P1..CD-P7).
- [x] Context Map tiene ≥2 archivos leídos (9 archivos leídos).
- [x] Scope IN y OUT explícitos y no ambiguos.
- [x] BD: sin cambios de tablas; SELECT reusado verificado (`getSplitContextRow`).
- [x] Happy Path completo (§4.4) + ≥1 flujo de error (§4.5, 5 casos).
- [x] Anti-recurrencia histórica aplicada (import-order ≥2 HUs, exactOptionalPropertyTypes ≥2 HUs) como CD.

**SDD listo para SPEC_APPROVED.**

---

*SDD generado por NexusAgil — nexus-architect — FULL*
