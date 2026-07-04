# SDD — [WKH-143] Activar splits de creador/referral (cablear el seam de WKH-136)

**HU**: WKH-143 v1 · **Fase**: F2 (SDD) · **Mode**: QUALITY (money-path)
**Branch**: `feat/144-wkh-143-activate-creator-referral-splits`
**Input**: `work-item.md` + `doc/sdd/138-wkh-136-atomic-splits-bps/done-report.md`
**Deroga**: CD-P1 de WKH-136 (firma pública de `chargeProtocolFee`) — a propósito, documentado (DT-1).

---

## 0. TL;DR del diseño resuelto

1. **Firma ampliada (aditiva)**: `FeeChargeParams` gana `creator?: SplitPartyRef | null` +
   `referral?: SplitPartyRef | null`. `chargeProtocolFee` los pasa a
   `resolveRecipients(splitConfig, { platformWallet, creator, referral })` (que YA los acepta).
2. **Resolución del agente primario** = `steps[0].agent` en los 2 call-sites, vía un helper nuevo
   best-effort `resolveAgentSplitContext(agent)` que devuelve `{ creator, referral }`.
   - registry externo → `metadata.payTo` (fallback `metadata.payment.contract`), owner_ref = `agent.slug`.
   - self-published → query dedicada a `a2a_agents` por `slug` → `payout_wallet` (owner_ref = `row.owner_ref`).
   - referral → **siempre `null` en v1** (el mecanismo `referrer_ref → wallet` es Scope OUT; el seam
     transporta referral y queda testeado a nivel `fee-charge`, pero el call-site no lo activa).
3. **Byte-idéntico GARANTIZADO por gate**: el call-site solo resuelve/adjunta contexto cuando
   `splitsActive()` (peek NO-throw de `SPLIT_BPS_CREATOR/REFERRAL`) es `true`. Con default `10000/0/0`
   → gate `false` → helper NO corre, cero query extra, el objeto de params queda **exactamente**
   `{orchestrationId, feeBaseUsdc, feeRate}` → suites existentes verdes sin tocar.
4. **MNR-3 (AC-6)**: `extrasFailed` se evalúa también en los 3 returns tempranos de `chargeProtocolFee`
   (`existing.status==='charged'`, `existing.status==='pending'`, `23505`), simétrico al path de éxito.

Sin `[NEEDS CLARIFICATION]` abiertos: el write-path de `payout_wallet`/`referrer_ref` y la resolución
real de referral son **Scope OUT** explícito (v2), no ambigüedades pendientes de esta HU.

---

## 1. Context Map (archivos leídos + patrón extraído)

| Archivo:líneas | Por qué se leyó | Patrón / hecho extraído |
|----------------|-----------------|--------------------------|
| `src/services/fee-charge.ts:43-53` | Firma a ampliar | `FeeChargeParams = {orchestrationId, feeBaseUsdc, feeRate}` — destructurado en :183. |
| `src/services/fee-charge.ts:240-249` | Único caller de `resolveRecipients` | Hoy invoca con SOLO `{ platformWallet: walletAddress }` → creator/referral `undefined` → SG-6. |
| `src/services/fee-charge.ts:256-267` | Dónde se calcula `extrasFailed` | `settleFeeSplits` corre ANTES del idempotency SELECT; `extrasFailed` ya está disponible en los returns tempranos. |
| `src/services/fee-charge.ts:326-347` | Returns tempranos (MNR-3) | `charged` (:327-334) + `pending` (:335-343) NO consultan `extrasFailed`. |
| `src/services/fee-charge.ts:362-372` | Return temprano 23505 | Idem — `unique_violation` retorna `already-charged inProgress` sin mirar `extrasFailed`. |
| `src/services/fee-charge.ts:487-503` | Patrón simétrico de éxito | `if (extrasFailed !== undefined) return {status:'failed', ..., splits: buildSplits('charged', txHash)}` — a replicar en los 3 tempranos. |
| `src/services/fee-split.ts:85-99` | Tipos del seam (YA exportados) | `SplitPartyRef = {wallet: string\|null, ownerRef: string\|null}` + `SplitContext.{creator?,referral?}`. |
| `src/services/fee-split.ts:203-260` | `resolveRecipients` (CD-6, no tocar) | Ya acepta `ctx.creator`/`ctx.referral`; `resolveParty` valida con `isValidWallet` → inválido/null = SG-6 (skip + re-ruta a plataforma). |
| `src/services/fee-split.ts:164-166` | Validación de wallet | `isValidWallet` (ADDRESS_RE `^0x[0-9a-fA-F]{40}$`) es el ÚNICO punto de validación → el helper NO revalida (CD-2). |
| `src/services/compose.ts:787-805` | Exemplar de fallback de wallet (DT-2) | `meta.payTo` canónico → fallback `meta.payment.contract`; narrowing `typeof === 'string'`. |
| `src/services/orchestrate.ts:1064-1069` | Call-site #1 | Dentro de `if (pipeline.success)`; `pipeline.steps[0]?.agent`. Sin try/catch propio (lección BLQ-MED-1). |
| `src/routes/compose.ts:573-578` | Call-site #2 | Dentro de `try {}` (:572-617); `result.steps[0]?.agent`. |
| `src/services/agent.ts:42-53` | `AgentRow` interno | NO tipa `payout_wallet`/`referrer_ref` (aunque `select('*')` los trae). NO ampliar esta interfaz (alimenta mappers públicos → CD-5). |
| `src/services/agent.ts:107-126` | `mapRowToAgent` | self-published: `id === slug`, `registry_id === SELF_PUBLISHED_REGISTRY_ID`. NUNCA serializa payout_wallet/referrer_ref (CD-5 debe seguir así). |
| `src/services/agent.ts:220-231` | `getRow(slug)` | Exemplar de query: `.from('a2a_agents').select(...).eq('slug', slug).maybeSingle()`. |
| `src/types/index.ts:110-111` | Constantes | `SELF_PUBLISHED_REGISTRY_ID = 'self-published'`. |
| `src/types/index.ts:174-206` | `Agent` | `.metadata?: Record<string,unknown>`, `.registry_id`, `.slug`. |
| `src/types/index.ts:359-361` | `StepResult` | `.agent: Agent` completo → `steps[0].agent` es un `Agent`. |
| `src/config/split-config.ts:23-27,86-109` | `SplitConfig` + `getSplitConfig` | `{platformBps, creatorBps, referralBps}`; `getSplitConfig` **throw** `SplitConfigError` si Σ≠10000 → NO llamable fuera del try de `chargeProtocolFee` (BLQ-MED-1). |
| `src/services/fee-split.test.ts:44-72` | Exemplar de mock supabase multi-`.eq` | `chain.eq = () => chain` (profundidad arbitraria) — base para los mocks de los tests nuevos. |
| `src/services/orchestrate.test.ts:554-561` | **Landmine de no-regresión** | T-12 usa `toHaveBeenCalledWith({orchestrationId, feeBaseUsdc, feeRate})` **exacto** (no `objectContaining`) → el objeto de params NO puede ganar keys en default. |
| `src/services/orchestrate.billing.test.ts:714-719` | No-regresión (safe) | `expect.objectContaining(...)` → tolera keys extra. |
| `src/routes/compose.fee.test.ts:166-171` | No-regresión (safe) | `expect.objectContaining(...)` → tolera keys extra. |

---

## 2. Decisiones técnicas (DT-N)

- **DT-1 — Firma ampliada (deroga CD-P1 de WKH-136)**: `FeeChargeParams` gana dos campos
  **opcionales** `creator?: SplitPartyRef | null` y `referral?: SplitPartyRef | null` (importados de
  `fee-split.ts`, ya exportados). Aditivo: un caller que no los pase se comporta idéntico a hoy.
  **Esto deroga explícitamente CD-P1 de WKH-136** ("PROHIBIDO cambiar la firma pública de
  `chargeProtocolFee`") — el done-report de WKH-136 preveía esta HU dedicada (MNR-1 / Opción B).
  **El AR de ESTA HU NO debe marcar el cambio de firma como violación.**

- **DT-2 — Gate `splitsActive()` para byte-idéntico estructural (CRÍTICA)**: se agrega a
  `split-config.ts` un helper **NO-throw** `splitsActive(): boolean` que lee
  `SPLIT_BPS_CREATOR`/`SPLIT_BPS_REFERRAL` de env y devuelve `true` sólo si alguno parsea a `> 0`
  (cualquier parse inválido/ausente → `false`, NUNCA throw). Los call-sites resuelven contexto SÓLO
  si `splitsActive()`. Rationale:
  1. **Byte-idéntico garantizado**: con default `10000/0/0` (o env ausente) el gate es `false` → el
     helper NO corre → cero query a `a2a_agents` → el objeto de params queda **exactamente**
     `{orchestrationId, feeBaseUsdc, feeRate}` → T-12 (exact-match) y todas las suites money-path
     verdes sin tocarlas. La garantía es **estructural**, no depende del contenido de ningún mock.
  2. **Sin reintroducir BLQ-MED-1**: es un peek read-only NO-throw; NO se llama `getSplitConfig()` en
     el call-site (eso volvería a lanzar `SplitConfigError` fuera del try/catch de `chargeProtocolFee`
     — el bug exacto de WKH-136). La validación fail-CLOSED sigue viviendo DENTRO de
     `chargeProtocolFee` (getSplitConfig → catch → `failed`), intacta.
  3. **Latencia**: elimina el query extra a `a2a_agents` en el 99% de los requests (default) — mitiga
     el riesgo de latencia del work-item de raíz.

- **DT-3 — Helper `resolveAgentSplitContext(agent)` best-effort (módulo nuevo)**: nuevo archivo
  `src/services/agent-split-context.ts` con
  `export async function resolveAgentSplitContext(agent: Agent | undefined): Promise<{ creator: SplitPartyRef | null; referral: SplitPartyRef | null }>`.
  - `!agent` (AC-7, `steps.length===0`) → `{ creator: null, referral: null }`.
  - `agent.registry_id === SELF_PUBLISHED_REGISTRY_ID` → `publishedAgentService.getSplitContextRow(agent.slug)`;
    `creator = row?.payoutWallet ? { wallet: row.payoutWallet, ownerRef: row.ownerRef } : null` (AC-3).
  - registry externo → `payTo = metadata.payTo ?? metadata.payment.contract` (mismo criterio
    `compose.ts:787-805`, DT-2/CD-2 del work-item); `creator = payTo ? { wallet: payTo, ownerRef: agent.slug } : null` (AC-2).
  - **`referral` siempre `null` en v1** (ver DT-6).
  - **Envuelto en try/catch interno**: cualquier error (query, narrowing) → log + `{creator:null, referral:null}`.
    Preserva la semántica de fallback (AC-4) y protege el contrato "el fee nunca rompe el 200" — el
    helper NUNCA propaga (no reintroduce BLQ-MED-1 desde el call-site).
  - **NO revalida la wallet**: pasa `payTo`/`payout_wallet` crudos; `resolveRecipients.resolveParty`
    (`isValidWallet`) es el único juez → wallet inválida = SG-6 (skip + re-ruta a plataforma). Un solo
    punto de validación (CD-2, sin mecanismo paralelo).

- **DT-4 — `publishedAgentService.getSplitContextRow(slug)` (query dedicada, CD-5)**: método nuevo en
  `agent.ts` que selecciona **sólo** `owner_ref, payout_wallet, referrer_ref` y devuelve
  `{ ownerRef: string; payoutWallet: string | null; referrerRef: string | null } | null`. **NO** se
  amplía la interfaz interna `AgentRow` (:42-53) ni `mapRowToAgent`/`mapRowToRecord` — esas dos
  columnas **jamás** entran a un shape público (`/discover`, AgentCard, `listMine`) → CD-5 intacto por
  construcción. Query espejo de `getRow` (:220-231).

- **DT-5 — Agente primario = `steps[0].agent`** en ambos call-sites (ratifica SG-5 de WKH-136).
  orchestrate: `pipeline.steps[0]?.agent`; compose: `result.steps[0]?.agent`. `undefined` (pipeline
  vacío) → helper devuelve `{null,null}` → 100% plataforma (AC-7).

- **DT-6 — `referral` inactivo en v1 (Scope OUT, no ambigüedad)**: el mecanismo
  `referrer_ref → wallet` NO está definido en ningún código ([NEEDS CLARIFICATION] #2/#3 del
  work-item, Scope OUT). Por tanto el call-site resuelve `referral = null` **siempre**. El **seam de
  referral SÍ queda cableado y testeado**: la firma ampliada transporta `referral` y
  `chargeProtocolFee` lo pasa a `resolveRecipients` — se prueba a nivel `fee-charge` inyectando un
  `SplitPartyRef` directo (T-REF-WIRE). Activar la resolución real de referral es una HU futura (v2).
  Esto NO es un `[NEEDS CLARIFICATION]` abierto: es alcance diferido explícito.

- **DT-7 — MNR-3 (AC-6) en los 3 returns tempranos**: `extrasFailed` ya está calculado (:257-267)
  antes de los returns tempranos. En cada uno (`existing.status==='charged'` :327, `'pending'` :335,
  `23505` :363) se antepone: `if (extrasFailed !== undefined) return { status:'failed', feeUsdc,
  error: extrasFailed, splits: buildSplits(<estado real>, <txHash?>) }`. Simétrico al path de éxito
  (:489-496). El `splits` refleja la realidad del leg de plataforma (`already-charged`/`in-progress`),
  pero el agregado es `failed` porque un leg adicional obligatorio falló.

- **DT-8 — `ownerRef` del leg creator**: self-published → `row.owner_ref` (identidad real del dueño).
  registry externo → `agent.slug` (identificador estable non-null; no hay owner_ref de registry). Es
  el valor del Ownership Guard de `a2a_fee_splits` (UNIQUE(orch, role) — una fila creator por orch,
  el ownerRef sólo debe ser un string estable). No afecta reverse (Scope OUT).

---

## 3. Constraint Directives (CD-N)

Heredadas del work-item (CD-1..CD-8) + refuerzos de F2:

- **CD-1 (OBLIGATORIO)** — Byte-idéntico con default `10000/0/0`: ninguna suite existente
  (`fee-charge.test.ts`, `orchestrate.test.ts`, `orchestrate.billing.test.ts`, `compose.fee.test.ts`,
  `money-path.*`, `fee-split.test.ts`) puede requerir modificación para seguir verde. Garantía
  estructural vía el gate `splitsActive()` (DT-2).
- **CD-1b (OBLIGATORIO, F2)** — El objeto de params pasado a `chargeProtocolFee` en default NO puede
  ganar keys: `orchestrate.test.ts:557` (T-12) es **exact-match**. Con el gate `false`, no se
  construyen ni adjuntan `creator`/`referral` → objeto idéntico.
- **CD-2 (OBLIGATORIO)** — Reusar EXACTAMENTE el criterio `payTo` → `payment.contract`
  (`compose.ts:787-805`). PROHIBIDO un mecanismo paralelo de resolución/validación de wallet
  (`isValidWallet` en `resolveRecipients` es el único juez).
- **CD-3 (OBLIGATORIO)** — Cerrar MNR-3: `extrasFailed` en los 3 returns tempranos (DT-7).
- **CD-4 (OBLIGATORIO)** — Recipients resueltos SOLO server-side. PROHIBIDO leer
  `creator`/`referral`/wallet del body de `/orchestrate` o `/compose` (heredado CD-6 WKH-136).
- **CD-5 (PROHIBIDO)** — PROHIBIDO exponer `payout_wallet`/`referrer_ref` en cualquier respuesta
  pública. Se leen SÓLO en `getSplitContextRow` server-side; NO entran a `AgentRow`/mappers públicos
  (DT-4). El AR debe verificar que ningún mapper serialice esas columnas.
- **CD-6 (PROHIBIDO)** — PROHIBIDO modificar el interior testeado de
  `computeSplits`/`resolveRecipients`/`settleFeeSplits`/`reverseFeeSplits` (`fee-split.ts`). Esta HU
  SÓLO cablea el input (pasar `creator`/`referral` ya resueltos).
- **CD-7 (PROHIBIDO)** — PROHIBIDO construir el write-path de `payout_wallet`/`referrer_ref`
  (`PATCH /agents`, captura de referrer en publish) sin ratificación humana explícita. Scope OUT.
- **CD-8 (OBLIGATORIO)** — `exactOptionalPropertyTypes`: construir `FeeChargeParams` y el contexto con
  **asignación condicional** (`if (ctx.creator) params.creator = ctx.creator`), NUNCA
  `creator: cond ? v : undefined`. Patrón recurrente WKH-133/134/136 (ver §7).
- **CD-9 (PROHIBIDO, F2 — anti BLQ-MED-1)** — PROHIBIDO llamar `getSplitConfig()` (o cualquier función
  que pueda `throw`) en los call-sites `orchestrate.ts`/`compose.ts`. El gate es `splitsActive()`
  (NO-throw). Toda validación fail-CLOSED vive DENTRO de `chargeProtocolFee`.
- **CD-10 (OBLIGATORIO, F2)** — El helper `resolveAgentSplitContext` es best-effort: NUNCA propaga
  (try/catch interno → `{null,null}`). Un fallo de resolución degrada a "sin creator" (AC-4), nunca
  rompe el charge ni el 200.

---

## 4. Waves de implementación

### W0 — Contratos / seam (SERIAL, base de todo)
Cambios de tipo/firma sin lógica de call-site. Nadie compila el resto sin esto.

1. **`src/config/split-config.ts`** — agregar `export function splitsActive(): boolean`
   (NO-throw; lee `SPLIT_BPS_CREATOR`/`SPLIT_BPS_REFERRAL`, `Number.parseInt`, `> 0`; cualquier
   NaN/ausente/error → `false`). Aditivo, no toca `getSplitConfig`.
2. **`src/services/fee-charge.ts`**:
   - Importar `SplitPartyRef` desde `./fee-split.js`.
   - Ampliar `FeeChargeParams` (:43-53) con `creator?: SplitPartyRef | null` + `referral?: SplitPartyRef | null` (DT-1).
   - En el `resolveRecipients` (:240-242) pasar el contexto ampliado con **asignación condicional**
     (CD-8): construir `const ctx: SplitContext = { platformWallet: walletAddress };`
     `if (params.creator) ctx.creator = params.creator;` `if (params.referral) ctx.referral = params.referral;`.
   - MNR-3 (DT-7): anteponer el chequeo `extrasFailed` en los 3 returns tempranos (:327, :335, :363).

### W1 — Resolución server-side (paralelizable tras W0)
1. **`src/services/agent.ts`** — agregar `publishedAgentService.getSplitContextRow(slug)` (DT-4).
2. **`src/services/agent-split-context.ts`** (NUEVO) — `resolveAgentSplitContext(agent)` (DT-3),
   best-effort. Importa `SELF_PUBLISHED_REGISTRY_ID`, `Agent`, `SplitPartyRef`, `publishedAgentService`.

### W2 — Cableado de call-sites (tras W1)
1. **`src/services/orchestrate.ts:~1064`** — dentro de `if (pipeline.success)`, antes de
   `chargeProtocolFee`:
   ```
   let creator: SplitPartyRef | null = null;
   let referral: SplitPartyRef | null = null;
   if (splitsActive()) {
     const ctx = await resolveAgentSplitContext(pipeline.steps[0]?.agent);
     creator = ctx.creator; referral = ctx.referral;
   }
   const feeParams: FeeChargeParams = { orchestrationId, feeBaseUsdc: pipeline.totalCostUsdc, feeRate };
   if (creator) feeParams.creator = creator;
   if (referral) feeParams.referral = referral;
   const feeResult = await chargeProtocolFee(feeParams);
   ```
   (Estructura ilustrativa; el Dev respeta CD-8/CD-9. Con `splitsActive()===false`, `feeParams` es
   idéntico al actual → CD-1b.)
2. **`src/routes/compose.ts:~573`** — mismo patrón con `result.steps[0]?.agent` y
   `feeBaseUsdc: result.totalCostUsdc`, dentro del `try` existente.

### W3 — Tests (tras W2) — ver §6.

---

## 5. Exemplars verificados (Glob/Read confirmados)

| Exemplar | Path:líneas | Uso |
|----------|-------------|-----|
| Firma a ampliar | `src/services/fee-charge.ts:43-53` | Base de `FeeChargeParams`. |
| Caller de `resolveRecipients` | `src/services/fee-charge.ts:240-249` | Dónde inyectar `ctx.creator/referral`. |
| Returns tempranos (MNR-3) | `src/services/fee-charge.ts:327,335,363` | Dónde anteponer `extrasFailed`. |
| Patrón simétrico de éxito | `src/services/fee-charge.ts:489-496` | Forma exacta del degrade a `failed`. |
| Tipos del seam | `src/services/fee-split.ts:85-99` | `SplitPartyRef`, `SplitContext` (ya exportados). |
| Resolver/fallback | `src/services/fee-split.ts:203-234` | SG-6 + `isValidWallet` (único validador). |
| Fallback de wallet (DT-2) | `src/services/compose.ts:787-805` | `payTo` → `payment.contract`, narrowing. |
| Query a2a_agents | `src/services/agent.ts:220-231` | Espejo para `getSplitContextRow`. |
| Mapper público (CD-5) | `src/services/agent.ts:107-126` | Confirmar que NO gana payout_wallet/referrer_ref. |
| Call-site #1 | `src/services/orchestrate.ts:1064-1069` | Wiring orchestrate. |
| Call-site #2 | `src/routes/compose.ts:573-578` | Wiring compose. |
| Constante | `src/types/index.ts:110` | `SELF_PUBLISHED_REGISTRY_ID`. |
| `StepResult.agent` | `src/types/index.ts:359-361` | `steps[0].agent` es `Agent`. |
| Mock supabase multi-`.eq` | `src/services/fee-split.test.ts:44-72` | Base de los mocks de tests nuevos. |
| Landmine exact-match | `src/services/orchestrate.test.ts:554-561` | No-regresión T-12 (CD-1b). |

---

## 6. Plan de tests (≥1 por AC)

Archivos NUEVOS (no tocar los existentes — CD-1):
- `src/config/split-config.test.ts` (existente): **agregar** casos de `splitsActive()` — verificar
  aditividad sin romper los actuales (o archivo nuevo `split-active.test.ts` si el mock de env colisiona).
- `src/services/agent-split-context.test.ts` (NUEVO).
- `src/services/fee-charge-splits.test.ts` (NUEVO) — reusa el mock `chain.eq = () => chain` de
  `fee-split.test.ts:44-72` (soporta las cadenas multi-`.eq` de `settleFeeSplits`).

| Test | AC | Qué cubre |
|------|----|-----------|
| **T-GATE-1/2** | AC-5 | `splitsActive()`: env ausente / `0/0` → `false`; `SPLIT_BPS_CREATOR=1000` → `true`; env corrupto (`abc`) → `false` (NO-throw). |
| **T-CTX-REG** | AC-2 | `resolveAgentSplitContext` con agent registry externo + `metadata.payTo` válido → `creator = {wallet: payTo, ownerRef: slug}`; con sólo `metadata.payment.contract` → fallback correcto. |
| **T-CTX-SELF** | AC-3 | agent self-published (`registry_id===SELF_PUBLISHED_REGISTRY_ID`) + `getSplitContextRow` devuelve `payoutWallet` válido → `creator = {wallet, ownerRef: row.owner_ref}`. |
| **T-CTX-MISS** | AC-4 | self-published con `payout_wallet=null` **y** registry sin `payTo`/`payment.contract` → `creator=null` (→ SG-6 aguas abajo). |
| **T-CTX-NOAGENT** | AC-7 | `resolveAgentSplitContext(undefined)` → `{creator:null, referral:null}`. |
| **T-CTX-THROW** | AC-4/CD-10 | `getSplitContextRow` rechaza (query error) → helper best-effort → `{null,null}` (no propaga). |
| **T-CTX-REF-NULL** | DT-6 | referral SIEMPRE `null` (self-published con `referrer_ref` seteado incluido) — activación diferida. |
| **T-CREATOR-CHARGE** | AC-2/AC-3 | `chargeProtocolFee({...creator: {wallet:0x.., ownerRef}})` con `SPLIT_BPS_CREATOR>0` → leg creator `charged` en `a2a_fee_splits`, `protocolFeeUsdc` sin cambio (subdivisión, CD-5). |
| **T-REF-WIRE** | DT-1/DT-6 | `chargeProtocolFee({...referral: {wallet:0x.., ownerRef}})` con `SPLIT_BPS_REFERRAL>0` → leg referral `charged` — prueba que la firma ampliada transporta referral hasta `resolveRecipients`. |
| **T-FALLBACK-SG6** | AC-4 | `chargeProtocolFee` con `creator: null` (o wallet inválida) + `SPLIT_BPS_CREATOR>0` → fila `skipped`, bps re-ruteado a plataforma, sin abortar el cobro. |
| **T-MNR3-CHARGED** | AC-6 | leg adicional falla + `existing.status==='charged'` → return `failed` (no `already-charged`). |
| **T-MNR3-PENDING** | AC-6 | leg adicional falla + `existing.status==='pending'` → return `failed`. |
| **T-MNR3-23505** | AC-6 | leg adicional falla + INSERT `23505` → return `failed`. |
| **T-BYTEID** | AC-5/CD-1 | Con default `10000/0/0` (`splitsActive()===false`): `chargeProtocolFee({orchestrationId, feeBaseUsdc, feeRate})` → 1 leg plataforma, `amount==feeUsdc`, cero writes a `a2a_fee_splits`. Reafirmado por `fee-charge.test.ts` + `orchestrate.billing.test.ts` verdes **sin cambios**. |
| **No-regresión** | AC-5 | Ejecutar `orchestrate.test.ts` (T-12 exact-match), `orchestrate.billing.test.ts`, `compose.fee.test.ts`, `fee-split.test.ts`, `money-path.*` → verdes sin editar. |

---

## 7. Auto-Blindaje histórico incorporado (últimas HUs DONE)

Leídos `auto-blindaje.md` de WKH-136 (138), WKH-138 (140), WKH-134 (135). Patrones recurrentes
(≥2 HUs) → convertidos en CD:

- **`exactOptionalPropertyTypes` → asignación condicional** (WKH-133 #1, WKH-134 #1, WKH-136 CD-8):
  recurrente ≥3 HUs → **CD-8**. Nunca `x: cond ? v : undefined`.
- **Test out-of-scope = contrato duro; verificar el mock ANTES** (WKH-134 #2, WKH-136 "híbrido"):
  recurrente ≥2 HUs → **CD-1/CD-1b** + §6 (tests nuevos reusan el mock multi-`.eq`, no tocan los
  existentes; T-12 exact-match protegido por el gate).
- **Helper best-effort "nunca rechaza" con múltiples call-sites** (WKH-136 BLQ-MED-1): un `throw`
  pre-guarda rompe el contrato en el call-site sin try/catch (`orchestrate.ts`) → **CD-9 + CD-10**
  (gate NO-throw + helper best-effort; `getSplitConfig` sólo dentro de `chargeProtocolFee`).

---

## 8. Riesgos para el AR

| Riesgo | Nota para el AR |
|--------|-----------------|
| Cambio de firma de `chargeProtocolFee` | **ESPERADO** (DT-1 deroga CD-P1 de WKH-136). Validar la firma NUEVA, no marcar como violación. |
| "Creator self-published nunca cobra" | **ESPERADO** (DT-6/Scope OUT): sin write-path, `payout_wallet` es NULL → `getSplitContextRow` devuelve `payoutWallet:null` → SG-6. NO es regresión. |
| "Referral nunca se activa" | **ESPERADO** (DT-6): call-site resuelve `referral=null` siempre; el seam queda cableado+testeado (T-REF-WIRE). NO es bug. |
| Byte-idéntico | Garantía **estructural** por gate `splitsActive()` (DT-2/CD-1b) — con default, el objeto de params es idéntico; T-12 exact-match debe pasar sin editar. AR: verificar que ninguna suite existente se modificó. |
| Exposición de wallets (CD-5) | AR: verificar que `payout_wallet`/`referrer_ref` NO entran a `AgentRow`/`mapRowToAgent`/`mapRowToRecord` ni a ningún response público; sólo `getSplitContextRow` los lee. |
| BLQ-MED-1 (regresión) | AR: verificar que NO se llama `getSplitConfig()` en los call-sites (CD-9); el gate es `splitsActive()` NO-throw; el helper es best-effort (CD-10). |
| MNR-3 mal cerrado | AR: verificar los 3 returns tempranos (`charged`/`pending`/`23505`) evalúan `extrasFailed` (DT-7). |

---

## 9. Readiness Check (F2)

- [x] Work-item leído (Scope IN/OUT, 7 ACs, 8 CD, DT-1..DT-5, Missing Inputs).
- [x] `project-context.md` leído — stack Fastify/Supabase/viem/TS strict; sin drift relevante.
- [x] Todos los archivos referenciados verificados con Read (paths + líneas reales).
- [x] Exemplars confirmados (§5) — cero paths inventados.
- [x] Auto-blindaje de las 3 últimas HUs DONE incorporado (§7) → CD-1b/CD-9/CD-10 nuevos.
- [x] Firma ampliada resuelta (DT-1) + derogación CD-P1 documentada para el AR.
- [x] Resolución del agente primario resuelta en ambos call-sites (DT-3/DT-5).
- [x] Byte-idéntico garantizado estructuralmente (DT-2/CD-1b) + landmine T-12 identificada.
- [x] MNR-3 (AC-6) diseñado en los 3 returns tempranos (DT-7).
- [x] Ubicación del helper decidida (`agent-split-context.ts` + `getSplitContextRow`) — CD-5 intacto.
- [x] Test plan ≥1 por AC (§6), sobre archivos NUEVOS (no rompe suites existentes).
- [x] Waves definidas (W0 serial → W1 → W2 → W3).
- [x] **Cero `[NEEDS CLARIFICATION]` abiertos**: write-path de `payout_wallet`/`referrer_ref` y
      resolución real de referral son **Scope OUT** explícito (v2), no ambigüedades de esta HU.

**Veredicto**: SDD **LISTO para SPEC_APPROVED**. Sin TBDs. Sin ambigüedades abiertas.

---

*SDD generado por nexus-architect — F2. No implementa código. Espera gate `SPEC_APPROVED`.*
