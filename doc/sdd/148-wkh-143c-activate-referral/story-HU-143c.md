# Story File — HU WKH-143c: Activar referral real en los splits (Opción B)

> Contrato autocontenido para `nexus-dev`. **NO releas el SDD** — todo lo necesario está acá.
> Fuente: `doc/sdd/148-wkh-143c-activate-referral/sdd.md` (SPEC_APPROVED).
> Branch: `feat/148-wkh-143c-activate-referral`
> Tipo: feature/billing — **money-path** (agrega un 3er destinatario de fee). **SIN migración.**

---

## 1. Contexto compacto (qué se construye y por qué)

WKH-143 cableó el read-side de los splits pero hardcodea `referral: null` para siempre.
WKH-143b agregó el write-path: `a2a_agents.referrer_ref` se persiste pero **nadie lo lee**.
Esta HU cierra ese seam: `resolveAgentSplitContext` deja de devolver `referral: null`
incondicionalmente y resuelve `referrer_ref` a una wallet real.

**Semántica — Opción B (DECIDIDA por el humano, NO se reabre):** `referrer_ref` es el
**`slug` de OTRO agente self-published**. Su wallet de referral es el `payout_wallet` de ESE
agente, resuelto con **exactamente el mismo método que el creator** (`getSplitContextRow(referrer_ref)`).
Cero lookup nuevo. El referral solo paga cuando `SPLIT_BPS_REFERRAL > 0` **Y** el agente primario
declaró un `referrer_ref` que resuelve a un `payout_wallet` válido **distinto** del creator.
Con el default `10000/0/0` el comportamiento es **byte-idéntico** a hoy.

Testnet. **NO se toca el engine de splits.**

---

## 2. Scope IN (lista exhaustiva de archivos a tocar — SOLO estos 4)

| # | Archivo | Acción |
|---|---------|--------|
| 1 | `src/config/split-config.ts` | Agregar `referralActive(): boolean` (export **aditivo**). |
| 2 | `src/services/agent-split-context.ts` | Resolver `referral` en la rama self-published (Opción B + dedup + fail-safe + gate fino). |
| 3 | `src/config/split-config.test.ts` | Agregar `T-REFACTIVE`. |
| 4 | `src/services/agent-split-context.test.ts` | Agregar 6 tests de referral. Suite existente **intacta**. |

**PROHIBIDO tocar cualquier otro archivo.** Ver §7 (CDs).

---

## 3. Anti-Hallucination Checklist (símbolos verificados — todos existen HOY)

| Símbolo / hecho | Ubicación verificada | Uso en esta HU |
|-----------------|----------------------|----------------|
| `splitsActive()` (peek no-throw, helper `peek` interno) | `src/config/split-config.ts:126-136` | **Exemplar** para `referralActive()`. |
| `getSplitContextRow(slug)` → `{ ownerRef: string; payoutWallet: string\|null; referrerRef: string\|null } \| null` | `src/services/agent.ts:271-294` | Se reusa TAL CUAL para resolver el referrer. |
| Rama self-published + resolución de `creator` | `src/services/agent-split-context.ts:43-49` | Punto de inserción de la lógica de referral. |
| try/catch **function-wide** best-effort → `{null,null}` | `src/services/agent-split-context.ts:70-78` | Red de seguridad final — **se mantiene sin cambios**. |
| `SplitPartyRef { wallet: string\|null; ownerRef: string\|null }` | `src/services/fee-split.ts:81-85` | Shape del `referral`. **Todo-requerido, sin opcionales.** |
| `isValidWallet(w): w is string` = `/^0x[0-9a-fA-F]{40}$/` | `src/lib/wallet-format.ts:20,26-29` | Juez ÚNICO de la wallet — vive en `resolveRecipients`. **NO re-validar en el seam.** |
| Exact-match `chargeProtocolFee({ orchestrationId, feeBaseUsdc, feeRate })` | `src/services/orchestrate.test.ts:557-561` | Debe quedar **verde byte-idéntico** (default no cambia el shape). |
| Mock `mockGetSplitContextRow` + `logSpy` + fixture `agent()` + `PAYOUT='0x2222…2222'` | `src/services/agent-split-context.test.ts:16-45` | Infra de test a reusar. |
| Patrón env save/restore (`KEYS` + `beforeEach`/`afterEach`) | `src/config/split-config.test.ts:142-157` | Copiar para aislar `SPLIT_BPS_REFERRAL` en los tests nuevos. |

**Reglas de oro:**
- **NO** usar `getSplitConfig()` en la lógica de resolución ni en `referralActive()` — throwea
  `SplitConfigError` (fail-closed) y reintroduciría un bug. Solo `peek` no-throw.
- **NO** construir `SplitPartyRef` con `x: cond ? v : undefined` (rompe `exactOptionalPropertyTypes`).
  El shape es `{ wallet, ownerRef }`, ambos presentes.
- Cualquier duda de tipos/narrowing → marcá `[VERIFY-AT-IMPL]` y verificá con `tsc --noEmit`.

---

## 4. Waves

### W0 — Serial Gate (helper `referralActive` + su test)

**W0.1 — `src/config/split-config.ts`: agregar `referralActive()`**

- Export **aditivo** (NO tocar `splitsActive()`, `getSplitConfig()`, ni el fail-closed Σ==10000).
- Espejo de `splitsActive()` (`:126-136`) pero SOLO sobre `SPLIT_BPS_REFERRAL`.
- Peek no-throw: `undefined`/`''` → `false`; `Number.parseInt(raw, 10)` entero `>0` → `true`;
  NaN/basura/no-entero/`'0'` → `false`. **Nunca throwea.**
- Colocá la función **después** de `splitsActive()`. Doc-comment breve explicando que es el
  gate FINO específico del referral (con `SPLIT_BPS_CREATOR>0` pero `SPLIT_BPS_REFERRAL=0`,
  `splitsActive()` es `true` pero el lookup del referrer NO debe correr → cero query extra).
- Reusá el mismo criterio `peek` interno (podés replicar el closure local; NO exportar `peek`).

**W0.2 — `src/config/split-config.test.ts`: `T-REFACTIVE`**

- Nuevo `describe('referralActive', …)` con el patrón env save/restore de
  `describe('splitsActive')` (`:142-157`), pero `KEYS = ['SPLIT_BPS_REFERRAL'] as const`.
- Importá `referralActive` del mismo módulo (el import existente es
  `import { getSplitConfig, SplitConfigError, splitsActive } from './split-config.js'` —
  agregá `referralActive` respetando orden alfabético: `getSplitConfig, referralActive, splitsActive, SplitConfigError`
  → **corré biome `--write` para que ordene**).
- Casos: `'500'` → `true`; unset → `false`; `''` → `false`; `'0'` → `false`;
  `'abc'` → `false` (sin throw); `'12.5'` → `false`.

**Verificación W0:** `tsc --noEmit` + `vitest run src/config/split-config.test.ts` verde + `biome check`.

---

### W1 — Lógica (depende de W0)

**W1.1 — `src/services/agent-split-context.ts`: resolver `referral` en la rama self-published**

Punto exacto: dentro del `try` externo (`:42`), rama `if (agent.registry_id === SELF_PUBLISHED_REGISTRY_ID)` (`:43-49`).

Secuencia (respetá el orden — el gate va ANTES de la 2ª query):

1. `row = await getSplitContextRow(agent.slug)` — **como hoy** (`:44`), sin cambios.
2. `creator = row?.payoutWallet ? { wallet: row.payoutWallet, ownerRef: row.ownerRef } : null` — **como hoy** (`:45-47`).
3. Declarar `let referral: SplitPartyRef | null = null;` (default).
4. **Gate del lookup:** `if (referralActive() && row?.referrerRef) { … }`.
   - Si el gate es `false` (referral off, o sin `referrer_ref`) → `referral` queda `null`,
     **cero 2ª query** (AC-1, AC-3). El `getSplitContextRow` corre 1 sola vez.
5. **Dentro del gate — inner try/catch best-effort (AC-5):**
   ```
   try {
     const refRow = await getSplitContextRow(row.referrerRef);
     if (refRow?.payoutWallet) {
       const candidate = { wallet: refRow.payoutWallet, ownerRef: refRow.ownerRef };
       // dedup self-referral case-insensitive:
       if (!(creator && candidate.wallet.toLowerCase() === creator.wallet.toLowerCase())) {
         referral = candidate;
       }
       // si es self-referral → referral queda null
     }
     // si !refRow?.payoutWallet → referral queda null (AC-2)
   } catch (err) {
     // log + referral queda null. creator SE PRESERVA (el inner catch NO lo toca).
   }
   ```
   - **PSEUDO-CÓDIGO ILUSTRATIVO** — adaptá naming/narrowing a lo que compile. `[VERIFY-AT-IMPL]`
     el narrowing de `creator.wallet` (es `string | null` en `SplitPartyRef`): dentro del `if (creator && …)`,
     `creator.wallet` puede seguir siendo `string | null` para TS. Como `creator` se construyó con
     `wallet: row.payoutWallet` (truthy en la rama), usá el narrowing que satisfaga `tsc` sin castear —
     ej. guardá la wallet del creator en una const string cuando construís `creator`, o chequeá
     `creator?.wallet && candidate.wallet.toLowerCase() === creator.wallet.toLowerCase()`.
   - El `catch` **debe** llamar `log.error({ slug: agent.slug, … }, '…')` (best-effort, patrón del catch externo `:73-76`).
6. `return { creator, referral };` (reemplaza el `return { creator, referral: null };` de `:48`).

7. **Rama registry externo (`:51-69`):** SIN cambios — sigue `referral: null`.
8. **try/catch externo (`:70-78`):** SIN cambios — red de seguridad final.

**Import de `referralActive`:**
- Agregá `import { referralActive } from '../config/split-config.js';`.
- El bloque de imports actual (`:19-23`) es:
  `../lib/logger.js`, `../types/index.js` (x2), `./agent.js`, `./fee-split.js`.
- `../config/…` ordena **antes** de `../lib/…` alfabéticamente → el import nuevo va primero.
  **NO lo ordenes a mano** — agregalo y corré `biome check --write` (anti-recurrencia import-order,
  ref WKH-143 / WKH-143b auto-blindaje).

**Actualización de doc-comment (opcional, recomendado):** el header dice `DT-6: referral SIEMPRE null`
(`:15-16` y `:35`). Ajustá a "referral: null salvo `SPLIT_BPS_REFERRAL>0` + referrer resuelto (Opción B, WKH-143c)".
Cosmético, no cambia lógica.

**Verificación W1:** `tsc --noEmit` + `biome check` (import order).

---

### W2 — Tests (depende de W1)

**W2.1 — `src/services/agent-split-context.test.ts`: 6 tests nuevos. Suite existente INTACTA.**

**Setup previo (CRÍTICO):** el archivo HOY **no** aisla `process.env.SPLIT_BPS_REFERRAL`
(solo tiene `afterEach(() => vi.clearAllMocks())`, `:43-45`). Los tests de referral setean esa env.
Para no contaminar la suite existente (que asume referral OFF → byte-idéntico):
- Agregá save/restore de `process.env.SPLIT_BPS_REFERRAL` (patrón `beforeEach`/`afterEach` de
  `split-config.test.ts:145-157`): en `beforeEach` guardá el original y `delete`-alo; en `afterEach`
  restaurá. Así los tests T-CTX-*/T-143B-* corren con referral **unset** (verde sin cambios) y cada
  test de referral setea/limpia su propio valor.
- Importá `beforeEach` de vitest (hoy importa `afterEach, describe, expect, it, vi` — `:13`).

Fixtures sugeridos (reusá `PAYOUT='0x2222…2222'` `:37` para el creator):
- `W_REF = '0x3333333333333333333333333333333333333333'` (referrer, ≠ creator).

| Test | AC/CD | Escenario |
|------|-------|-----------|
| `T-REF-RESOLVE` | AC-6, CD-B1 | `SPLIT_BPS_REFERRAL='500'`. Agente self-published slug `'A'`. `mockGetSplitContextRow` devuelve, en la 1ª call (slug `'A'`), `{ ownerRef:'owner-A', payoutWallet:PAYOUT, referrerRef:'B' }`; en la 2ª call (slug `'B'`), `{ ownerRef:'owner-B', payoutWallet:W_REF, referrerRef:null }`. Usá `mockResolvedValueOnce` encadenados (1ª=A, 2ª=B). Asserta: `ctx.creator = { wallet:PAYOUT, ownerRef:'owner-A' }`; `ctx.referral = { wallet:W_REF, ownerRef:'owner-B' }`; `mockGetSplitContextRow` llamado con `'A'` y con `'B'`. |
| `T-REF-INVALID` | AC-2 | `SPLIT_BPS_REFERRAL='500'`. 1ª call → creator OK con `referrerRef:'B'`; 2ª call (referrer) → `null` (o `{ …, payoutWallet:null }`). Asserta `ctx.referral` null, `ctx.creator` intacto. |
| `T-REF-SELF-DEDUP` | AC-7, CD-B2 | `SPLIT_BPS_REFERRAL='500'`. Creator `payoutWallet=PAYOUT`, `referrerRef:'B'`. 2ª call (referrer) → `payoutWallet = PAYOUT.toUpperCase()` (mismo address, **casing distinto**: `'0x' + '2'.repeat(40).toUpperCase()` o `PAYOUT.toUpperCase()`). Asserta `ctx.referral` null (dedup case-insensitive), `ctx.creator` intacto. |
| `T-REF-BPS-OFF` | AC-1, CD-B4/CD-P3 | `SPLIT_BPS_REFERRAL` **unset** (o `'0'`). Agente con `referrerRef:'B'` seteado en la 1ª row. Asserta `ctx.referral` null **Y** `mockGetSplitContextRow` llamado **exactamente 1 vez** (`toHaveBeenCalledTimes(1)`) — cero query extra. |
| `T-REF-NO-REFERRER` | AC-3 | `SPLIT_BPS_REFERRAL='500'` pero 1ª row con `referrerRef:null`. Asserta `ctx.referral` null **Y** `getSplitContextRow` llamado 1 sola vez (sin 2ª query). |
| `T-REF-THROW` | AC-5, CD-B3 | `SPLIT_BPS_REFERRAL='500'`. 1ª call → creator OK con `referrerRef:'B'`; 2ª call **rechaza** (`mockRejectedValueOnce(new Error('DB down'))`). Asserta: `ctx.referral` null, **`ctx.creator` PRESERVADO** (= `{ wallet:PAYOUT, ownerRef:'owner-A' }`), `logSpy.error` llamado, sin throw (el `await resolveAgentSplitContext(...)` resuelve normal). |

**Tip mock secuencial:** `mockGetSplitContextRow.mockResolvedValueOnce(rowA).mockResolvedValueOnce(rowB)` —
la 1ª invocación (slug primario) devuelve `rowA`, la 2ª (referrer) `rowB`. Para T-REF-THROW la 2ª es
`.mockRejectedValueOnce(...)`.

**Verificación W2:** `vitest run src/services/agent-split-context.test.ts` — nuevos verdes + T-CTX-*/T-143B-* verdes sin cambios.

---

### W3 — Verificación final

- [ ] `npx @biomejs/biome check --write` sobre los **4 archivos** tocados (import-order, formato).
- [ ] `npx tsc --noEmit` limpio.
- [ ] Suite **completa** verde: `vitest run`. En particular:
  - `src/services/orchestrate.test.ts` — el exact-match `:557` (`chargeProtocolFee({ orchestrationId, feeBaseUsdc, feeRate })`) verde **sin tocar** (byte-idéntico default).
  - Money-path: `orchestrate.test.ts`, `compose.test.ts`, `fee-charge-splits.test.ts`, `fee-split.test.ts` verdes sin cambios.
  - Anti-leak: `discovery.selfpublished.test.ts`, `agent-card.test.ts` verdes sin cambios (ningún shape público expone `referrer_ref`/wallet del referral).

---

## 5. Patrones a seguir (exemplars verificados)

- **`referralActive()`** → espejo de `splitsActive()` (`src/config/split-config.ts:126-136`): closure `peek` local, `Number.parseInt(raw, 10)`, `Number.isInteger(parsed) && parsed > 0`, nunca throwea.
- **Resolución del referral** → espejo de la resolución del `creator` en el mismo archivo (`agent-split-context.ts:44-47`): `getSplitContextRow(...)` → construir `SplitPartyRef` desde `payoutWallet`+`ownerRef`.
- **Inner catch best-effort** → mismo formato que el catch externo (`:70-78`): `log.error({ slug: agent.slug, detail }, '…')`, no propaga.
- **Tests referral** → estructura de T-CTX-SELF (`:85-97`) para mocks de `getSplitContextRow` + asserts de `creator`/`referral`.
- **Env aislada en test** → `describe('splitsActive')` de `split-config.test.ts:142-157`.

---

## 6. Tests requeridos (resumen)

`T-REFACTIVE` (split-config.test.ts) · `T-REF-RESOLVE` · `T-REF-INVALID` · `T-REF-SELF-DEDUP` ·
`T-REF-BPS-OFF` · `T-REF-NO-REFERRER` · `T-REF-THROW` (agent-split-context.test.ts).
Suite existente completa **sin regresiones**.

---

## 7. Constraint Directives (heredados — INVIOLABLES)

- **CD-B1 (Opción B):** `referrer_ref` = `slug` de otro agente self-published; su wallet = `payout_wallet`
  resuelto vía `getSplitContextRow(referrer_ref)` — **el MISMO método que el creator**. PROHIBIDO lookup nuevo,
  tabla nueva, o reinterpretar `referrer_ref` como wallet cruda (Opción C) u `owner_ref` (Opción A).
- **CD-B2 (dedup self-referral):** si la wallet del referral iguala (**case-insensitive**, `toLowerCase()`)
  la wallet del creator → `referral: null`. `payout_wallet` se persiste raw/mixed-case (`agent.ts:361`),
  por eso la comparación exacta dejaría pasar el mismo payee en distinto casing.
- **CD-B3 (fail-safe):** cualquier fallo de resolución del referrer (row ausente, `payout_wallet` null, throw)
  → `referral: null`. El inner try/catch degrada **SOLO `referral`**, preservando `creator`. Nunca propaga.
- **CD-B4 (gate fino):** el 2º `getSplitContextRow` corre SÓLO si `referralActive()` **y** hay `referrer_ref`.
  Con `SPLIT_BPS_REFERRAL=0`/unset → cero query extra.
- **CD-1 (heredado):** toda validación de wallet usa EXACTAMENTE `isValidWallet` de `src/lib/wallet-format.ts`.
  El juez final sigue siendo `resolveRecipients` — **NO re-validar en el seam** (igual que el creator).
- **CD-P1:** PROHIBIDO modificar el cuerpo de `computeSplits`/`resolveRecipients`/`settleFeeSplits`/
  `reverseFeeSplits`/`chargeProtocolFee` (engine money-path, `fee-split.ts`/`fee-charge.ts`).
- **CD-P2 (anti-leak):** PROHIBIDO exponer `referrer_ref` o la wallet del referral en respuestas públicas,
  mappers (`mapRowToAgent`/`mapRowToRecord`) o logs no PII-safe. **NO tocar mappers.**
- **CD-P3 (byte-idéntico):** PROHIBIDO cualquier query o cambio de shape que rompa el default `10000/0/0`.
  El exact-match `orchestrate.test.ts:557` DEBE quedar verde sin cambios.
- **CD-P4:** PROHIBIDO tocar call-sites (`orchestrate.ts`, `compose.ts`) ni write-path
  (`agent.ts` publish/patch, `routes/agents.ts`, `assertValidReferrerRef`).
- **CD-P5 (no auto-activación):** PROHIBIDO que un `referrer_ref` ya persistido empiece a cobrar sin que
  el operador setee `SPLIT_BPS_REFERRAL>0` — garantizado por `referralActive()`.
- **CD-P6:** PROHIBIDO modificar `splitsActive()`, `getSplitConfig()` o el fail-closed Σ==10000.
  `referralActive()` es export **ADITIVO**.
- **CD-P7:** PROHIBIDO modificar archivos fuera de los 4 de §2.
- **exactOptionalPropertyTypes (anti-recurrencia WKH-133/134/136):** `SplitPartyRef` es todo-requerido —
  NO usar `x: cond ? v : undefined`.
- **Import-order (anti-recurrencia WKH-143/143b):** `biome check --write` sobre TODO archivo tocado antes de cerrar cada wave.

---

## 8. Done Definition

- [ ] `referralActive()` agregado (aditivo, no-throw) + `T-REFACTIVE` verde.
- [ ] `resolveAgentSplitContext` resuelve `referral` en rama self-published (Opción B + dedup + fail-safe + gate fino); rama registry externo sin cambios.
- [ ] 6 tests de referral verdes; suite existente (T-CTX-*/T-143B-*) verde sin cambios.
- [ ] `tsc --noEmit` limpio, `biome check` limpio sobre los 4 archivos.
- [ ] Suite full verde: `orchestrate.test.ts:557` exact-match + money-path + anti-leak sin cambios.
- [ ] Cero migraciones. Cero cambios fuera de los 4 archivos de §2.
