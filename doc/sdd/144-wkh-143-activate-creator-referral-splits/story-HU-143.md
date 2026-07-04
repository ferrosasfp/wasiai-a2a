# Story File — #144: [WKH-143] Activar splits de creador/referral (cablear el seam de WKH-136)

> SDD: `doc/sdd/144-wkh-143-activate-creator-referral-splits/sdd.md`
> Fecha: 2026-07-04
> Branch: `feat/144-wkh-143-activate-creator-referral-splits`
> Mode: QUALITY (money-path)

---

## Goal

WKH-136 ya entregó el engine de splits (`fee-split.ts`), pero `chargeProtocolFee`
no transporta el agente primario → creator/referral SIEMPRE se re-rutan a plataforma.
Esta HU **cablea ese seam**: resuelve el agente primario (`steps[0].agent`) en los 2
call-sites, amplía la firma de `chargeProtocolFee` para transportar el contexto de
creator/referral ya resuelto, y **garantiza byte-idéntico** en el default `10000/0/0`
vía un gate `splitsActive()` (NO-throw). NO construye el write-path de
`payout_wallet`/`referrer_ref` (eso es v2, Scope OUT).

---

## Acceptance Criteria (EARS)

> Copiados del SDD. QA los verifica en F4 con evidencia archivo:línea.

- **AC-1**: WHEN `chargeProtocolFee` se invoca desde `/orchestrate/execute` o `/compose`
  y el pipeline tiene ≥1 step, THE system SHALL resolver el agente primario como
  `steps[0].agent` y construir su contexto de creator (`SplitPartyRef`) ANTES de invocar
  `chargeProtocolFee`.
- **AC-2**: WHEN el agente primario es de un registry externo (NO self-published) y expone
  una wallet resoluble vía `agent.metadata.payTo` (fallback `agent.metadata.payment.contract`),
  THE system SHALL pasar esa wallet como `creator` a `resolveRecipients` (vía la firma ampliada).
- **AC-3**: WHEN el agente primario es self-published (`registry_id === SELF_PUBLISHED_REGISTRY_ID`)
  y su fila `a2a_agents` tiene `payout_wallet` no-nulo con formato de address válido, THE system
  SHALL resolverlo como `creator` igual que AC-2.
- **AC-4**: IF el agente primario no tiene wallet de creador resoluble (self-published sin
  `payout_wallet`, o registry sin `payTo`/`payment.contract`), THEN THE system SHALL comportarse
  exactamente igual que hoy: el bps de creador se re-enruta a plataforma vía el fallback SG-6 de
  `resolveRecipients` (fila `skipped`, sin error, sin abortar el cobro).
- **AC-5**: WHILE la config permanece en el default `10000/0/0`, THE system SHALL producir un
  resultado byte-idéntico al actual (cero legs adicionales, cero cambio en `protocolFeeUsdc`,
  suites money-path existentes verdes sin modificarlas).
- **AC-6**: WHEN un leg adicional (creator/referral) falla su settle DESPUÉS de que el agregado
  ya fue marcado `already-charged` en un return temprano (`existing.status==='charged'`,
  `existing.status==='pending'`, o `23505` unique_violation), THE system SHALL evaluar
  `extrasFailed` en ESOS returns tempranos también y degradar el agregado a `failed` cuando
  corresponda (cierre de MNR-3).
- **AC-7**: WHERE el agente primario NO existe (`steps.length === 0`), THE system SHALL invocar
  `chargeProtocolFee` sin contexto de creator/referral, preservando el comportamiento actual
  (100% a plataforma).

---

## Files to Modify/Create

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `src/config/split-config.ts` | Modificar | Agregar `export function splitsActive(): boolean` NO-throw (peek de `SPLIT_BPS_CREATOR`/`SPLIT_BPS_REFERRAL`). NO tocar `getSplitConfig`. | mismo archivo, `parseBps` (:55-78) |
| 2 | `src/services/fee-charge.ts` | Modificar | Ampliar `FeeChargeParams` (:43-53) con `creator?`/`referral?`; construir `SplitContext` con asignación condicional y pasarlo a `resolveRecipients` (:240-242); MNR-3 en los 3 returns tempranos (:327/:335/:363). | mismo archivo, path de éxito :489-496 |
| 3 | `src/services/agent.ts` | Modificar | Agregar método `getSplitContextRow(slug)` a `publishedAgentService`. NO ampliar `AgentRow` (:42-53) ni mappers. | mismo archivo, `getRow` :220-231 |
| 4 | `src/services/agent-split-context.ts` | **Crear** | Helper best-effort `resolveAgentSplitContext(agent)`. | `compose.ts:787-805` (payTo) |
| 5 | `src/services/orchestrate.ts` | Modificar | Call-site #1 (:1064-1069): resolver primario tras gate `splitsActive()` y pasar contexto. | `compose.ts:787-805` |
| 6 | `src/routes/compose.ts` | Modificar | Call-site #2 (:573-578, dentro del `try`): idem con `result.steps[0]?.agent`. | mismo patrón que #5 |
| 7 | `src/config/split-config.test.ts` | Modificar/Crear | Casos de `splitsActive()` (T-GATE). Si el mock de env colisiona → archivo nuevo `split-active.test.ts`. | patrones de env-mock del propio archivo |
| 8 | `src/services/agent-split-context.test.ts` | **Crear** | Tests del helper (T-CTX-*). | `fee-split.test.ts:44-72` (mock supabase) |
| 9 | `src/services/fee-charge-splits.test.ts` | **Crear** | Tests del seam sobre `chargeProtocolFee` (T-CREATOR/T-REF-WIRE/T-FALLBACK/T-MNR3/T-BYTEID). | `fee-split.test.ts:44-72` |

> **NO tocar** `fee-charge.test.ts`, `orchestrate.test.ts`, `orchestrate.billing.test.ts`,
> `compose.fee.test.ts`, `fee-split.test.ts`, `money-path.*` (CD-1 / CD-1b).

---

## Contratos de función (firmas exactas — BLOQUEANTE)

> Esta HU cablea servicios internos (call-site → `chargeProtocolFee` → `resolveRecipients`
> y helper → `agent.ts`). No hay cambio de contrato HTTP: el body y el response 200 de
> `/orchestrate` y `/compose` NO cambian (CD-4). Los contratos relevantes son las firmas.

### `FeeChargeParams` (ampliada, aditiva — DT-1)
```ts
export interface FeeChargeParams {
  orchestrationId: string;
  feeBaseUsdc: number;
  feeRate: number;
  creator?: SplitPartyRef | null;   // NUEVO — importar de './fee-split.js'
  referral?: SplitPartyRef | null;  // NUEVO
}
```
- `SplitPartyRef = { wallet: string | null; ownerRef: string | null }` (ya exportado en `fee-split.ts:85-88`).
- Aditivo: un caller que NO pase estos campos se comporta idéntico a hoy.

### `splitsActive(): boolean` (NO-throw — DT-2/CD-9)
- Lee `process.env.SPLIT_BPS_CREATOR` y `process.env.SPLIT_BPS_REFERRAL` con `Number.parseInt(raw, 10)`.
- Devuelve `true` **solo si** alguno parsea a un entero `> 0`.
- Cualquier `NaN` / ausente / basura / error → `false`. **NUNCA throw** (es un peek, no valida la suma).
- **PROHIBIDO** llamar `getSplitConfig()` acá (throwea `SplitConfigError`). Es un parse independiente y tolerante.

### `getSplitContextRow(slug)` (DT-4/CD-5)
```ts
// dentro de publishedAgentService (agent.ts)
async getSplitContextRow(slug: string): Promise<{
  ownerRef: string;
  payoutWallet: string | null;
  referrerRef: string | null;
} | null>
```
- Query espejo de `getRow` pero seleccionando **SOLO** `owner_ref, payout_wallet, referrer_ref`
  (`.from('a2a_agents').select('owner_ref, payout_wallet, referrer_ref').eq('slug', slug).maybeSingle()`).
- Mapea snake_case → camelCase. `data ? {...} : null`.
- **NO** ampliar la interfaz `AgentRow` (:42-53). **NO** tocar `mapRowToAgent`/`mapRowToRecord`.
  Esas 2 columnas jamás entran a un shape público (CD-5).

### `resolveAgentSplitContext(agent)` (DT-3/CD-10)
```ts
// src/services/agent-split-context.ts (NUEVO)
export async function resolveAgentSplitContext(
  agent: Agent | undefined,
): Promise<{ creator: SplitPartyRef | null; referral: SplitPartyRef | null }>
```
- `!agent` → `{ creator: null, referral: null }` (AC-7).
- `agent.registry_id === SELF_PUBLISHED_REGISTRY_ID` → `publishedAgentService.getSplitContextRow(agent.slug)`;
  `creator = row?.payoutWallet ? { wallet: row.payoutWallet, ownerRef: row.ownerRef } : null` (AC-3).
- registry externo → resolver `payTo` con el criterio EXACTO de `compose.ts:791-801`
  (`metadata.payTo` canónico → fallback `metadata.payment.contract`, narrowing `typeof === 'string'`);
  `creator = payTo ? { wallet: payTo, ownerRef: agent.slug } : null` (AC-2, DT-8).
- **`referral` SIEMPRE `null` en v1** (DT-6 — sin write-path de `referrer_ref`, Scope OUT).
- **Todo envuelto en un `try/catch` interno**: cualquier error (query, narrowing) → `log` + return
  `{ creator: null, referral: null }`. NUNCA propaga (CD-10). Esto protege el 200 y no reintroduce BLQ-MED-1.
- **NO revalida la wallet**: pasa `payTo`/`payout_wallet` crudos. El único juez es `isValidWallet`
  dentro de `resolveRecipients` → wallet inválida = SG-6 (CD-2).

---

## Constraint Directives

### OBLIGATORIO
- **CD-1 / CD-1b (byte-idéntico)**: con default `10000/0/0` → `splitsActive()===false` → el helper
  NO corre, cero query a `a2a_agents`, y el objeto de params queda **exactamente**
  `{ orchestrationId, feeBaseUsdc, feeRate }`. `orchestrate.test.ts:557` es **exact-match**
  (`toHaveBeenCalledWith({...})`, NO `objectContaining`) → NO puede ganar keys. Garantía estructural.
- **CD-2**: reusar EXACTAMENTE el criterio `payTo` → `payment.contract` de `compose.ts:791-801`.
  PROHIBIDO un mecanismo paralelo de resolución/validación de wallet. `isValidWallet` (en
  `resolveRecipients`) es el ÚNICO validador.
- **CD-3 (MNR-3)**: `extrasFailed` DEBE evaluarse en los 3 returns tempranos (:327, :335, :363),
  no solo en el path de éxito. Simétrico a :489-496.
- **CD-4**: recipients resueltos SOLO server-side. PROHIBIDO leer `creator`/`referral`/wallet del
  body de `/orchestrate` o `/compose`.
- **CD-8 (`exactOptionalPropertyTypes`)**: construir `FeeChargeParams` y `SplitContext` con
  **asignación condicional** (`if (params.creator) ctx.creator = params.creator;`), NUNCA
  `creator: cond ? v : undefined`. Patrón recurrente WKH-133/134/136 — es un error histórico que se
  repitió ≥3 HUs; el typecheck falla si lo hacés con ternario+undefined.
- **CD-10**: `resolveAgentSplitContext` es best-effort: try/catch interno → `{null,null}`. NUNCA propaga.

### PROHIBIDO
- **CD-5**: PROHIBIDO exponer `payout_wallet`/`referrer_ref` en cualquier respuesta pública
  (`/discover`, AgentCard, `listMine`, `GET /agents/:slug`). Solo se leen en `getSplitContextRow`.
  NO ampliar `AgentRow` ni tocar mappers.
- **CD-6**: PROHIBIDO modificar el interior testeado de
  `computeSplits`/`resolveRecipients`/`settleFeeSplits`/`reverseFeeSplits` (`fee-split.ts`). Esta HU
  SOLO cablea el input (pasar `creator`/`referral` ya resueltos).
- **CD-7**: PROHIBIDO construir el write-path de `payout_wallet`/`referrer_ref` (PATCH /agents,
  captura de referrer en publish). Scope OUT (v2).
- **CD-9 (anti BLQ-MED-1)**: PROHIBIDO llamar `getSplitConfig()` (o cualquier función que pueda
  `throw`) en los call-sites `orchestrate.ts`/`compose.ts`. El gate es `splitsActive()` NO-throw.
  Toda validación fail-CLOSED vive DENTRO de `chargeProtocolFee` (ya está, intacta).
- NO agregar dependencias nuevas. NO modificar archivos fuera de la tabla. NO "mejorar" código adyacente.

---

## Exemplars

### Exemplar 1: fallback de wallet payTo → payment.contract
**Archivo**: `src/services/compose.ts:791-801`
**Usar para**: rama registry-externo de `resolveAgentSplitContext` (#4).
**Patrón clave** (copiar el criterio, NO el `throw`):
```ts
const meta = agent.metadata as Record<string, unknown> | undefined;
const canonicalPayTo = typeof meta?.payTo === 'string' ? meta.payTo : undefined;
const fallbackPayment = meta?.payment as Record<string, unknown> | undefined;
const fallbackPayTo =
  typeof fallbackPayment?.contract === 'string' ? fallbackPayment.contract : undefined;
const payTo = canonicalPayTo ?? fallbackPayTo;
```
> En el helper: si `payTo` es `undefined` → `creator = null` (NO throw — allá es un pago obligatorio, acá es opcional).

### Exemplar 2: query self-published por slug
**Archivo**: `src/services/agent.ts:220-231` (`publishedAgentService.getRow`)
**Usar para**: `getSplitContextRow` (#3).
**Patrón clave**: `.from('a2a_agents').select(<cols>).eq('slug', slug).maybeSingle()`; `if (error) throw`;
`return data ? (...) : null`. En `getSplitContextRow` seleccioná SOLO las 3 columnas de ownership/payout,
NO `select('*')` (evita arrastrar columnas al scope).

### Exemplar 3: path de éxito con extrasFailed (para MNR-3)
**Archivo**: `src/services/fee-charge.ts:487-496`
**Usar para**: los 3 returns tempranos (#2).
**Patrón clave**:
```ts
if (extrasFailed !== undefined) {
  return { status: 'failed', feeUsdc, error: extrasFailed, splits: buildSplits(<estado real>, <txHash?>) };
}
```
> En cada temprano, `buildSplits` debe reflejar la realidad del leg de plataforma:
> - `existing.status==='charged'` (:327) → `buildSplits('already-charged', existing.tx_hash ?? undefined)`
> - `existing.status==='pending'` (:335) → `buildSplits('in-progress')`
> - `23505` (:363) → `buildSplits('in-progress')`
>
> El agregado retornado es `failed` (un leg obligatorio falló) aunque el leg de plataforma esté charged/in-progress.

### Exemplar 4: inyección del contexto en resolveRecipients
**Archivo**: `src/services/fee-charge.ts:240-242` (call actual, SOLO `{ platformWallet }`)
**Usar para**: el cambio en `chargeProtocolFee` (#2).
**Patrón clave** (CD-8, asignación condicional):
```ts
const ctx: SplitContext = { platformWallet: walletAddress };
if (params.creator) ctx.creator = params.creator;
if (params.referral) ctx.referral = params.referral;
const resolution = resolveRecipients(splitConfig, ctx);
```
> `SplitContext` ya se importa (o importalo de `./fee-split.js`, junto a `SplitPartyRef`). `resolveRecipients`
> ya acepta `ctx.creator`/`ctx.referral` (fee-split.ts:203-234) — NO se toca (CD-6).

### Exemplar 5: mock supabase multi-`.eq` para tests
**Archivo**: `src/services/fee-split.test.ts:44-72`
**Usar para**: `agent-split-context.test.ts` (#8) y `fee-charge-splits.test.ts` (#9).
**Patrón clave**: `chain.eq = () => chain` (profundidad arbitraria de `.eq`) + `chain.maybeSingle`/`chain.then`
con colas por operación (`selectQ`/`insertQ`/`updateQ`). Soporta las cadenas multi-`.eq` de `settleFeeSplits`
y la de `getSplitContextRow`.

### Exemplar 6: landmine de exact-match (no-regresión)
**Archivo**: `src/services/orchestrate.test.ts:554-561`
**Usar para**: verificación de CD-1b (NO editar este archivo).
**Patrón clave**: `expect(vi.mocked(chargeProtocolFee)).toHaveBeenCalledWith({ orchestrationId, feeBaseUsdc, feeRate })`
— exact-match. Si el objeto de params gana `creator`/`referral` en default, este test ROMPE. Con el gate
`splitsActive()===false` no se adjuntan → pasa sin tocar.

---

## Test Expectations

> Framework: **Vitest**. Archivos NUEVOS (no tocar suites existentes — CD-1).
> Money-path → test-first obligatorio (lógica de negocio + dinero).

| Test | Archivo | ACs | Qué cubre |
|------|---------|-----|-----------|
| T-GATE-1/2 | `split-config.test.ts` (o `split-active.test.ts`) | AC-5 | `splitsActive()`: env ausente / `0/0` → `false`; `SPLIT_BPS_CREATOR=1000` → `true`; `abc` (basura) → `false` (NO-throw). |
| T-CTX-REG | `agent-split-context.test.ts` | AC-2 | registry externo + `metadata.payTo` válido → `creator={wallet:payTo, ownerRef:slug}`; solo `payment.contract` → fallback correcto. |
| T-CTX-SELF | `agent-split-context.test.ts` | AC-3 | self-published + `getSplitContextRow`→`payoutWallet` válido → `creator={wallet, ownerRef:row.owner_ref}`. |
| T-CTX-MISS | `agent-split-context.test.ts` | AC-4 | self-published con `payout_wallet=null` **y** registry sin `payTo`/`payment.contract` → `creator=null`. |
| T-CTX-NOAGENT | `agent-split-context.test.ts` | AC-7 | `resolveAgentSplitContext(undefined)` → `{creator:null, referral:null}`. |
| T-CTX-THROW | `agent-split-context.test.ts` | AC-4/CD-10 | `getSplitContextRow` rechaza (query error) → best-effort → `{null,null}` (no propaga). |
| T-CTX-REF-NULL | `agent-split-context.test.ts` | DT-6 | `referral` SIEMPRE `null` (incluso self-published con `referrer_ref` seteado). |
| T-CREATOR-CHARGE | `fee-charge-splits.test.ts` | AC-2/AC-3 | `chargeProtocolFee({...creator})` con `SPLIT_BPS_CREATOR>0` → leg creator `charged` en `a2a_fee_splits`; `feeUsdc` sin cambio (subdivisión). |
| T-REF-WIRE | `fee-charge-splits.test.ts` | DT-1/DT-6 | `chargeProtocolFee({...referral})` con `SPLIT_BPS_REFERRAL>0` → leg referral `charged` — prueba que la firma transporta `referral` hasta `resolveRecipients`. |
| T-FALLBACK-SG6 | `fee-charge-splits.test.ts` | AC-4 | `creator:null` (o wallet inválida) + `SPLIT_BPS_CREATOR>0` → fila `skipped`, bps re-ruteado a plataforma, cobro NO aborta. |
| T-MNR3-CHARGED | `fee-charge-splits.test.ts` | AC-6 | leg adicional falla + `existing.status==='charged'` → return `failed` (no `already-charged`). |
| T-MNR3-PENDING | `fee-charge-splits.test.ts` | AC-6 | leg adicional falla + `existing.status==='pending'` → return `failed`. |
| T-MNR3-23505 | `fee-charge-splits.test.ts` | AC-6 | leg adicional falla + INSERT `23505` → return `failed`. |
| T-BYTEID | `fee-charge-splits.test.ts` | AC-5/CD-1 | default `10000/0/0`: `chargeProtocolFee({orchestrationId, feeBaseUsdc, feeRate})` → 1 leg plataforma, `amount==feeUsdc`, cero writes a `a2a_fee_splits`. |
| No-regresión | (ejecutar, no editar) | AC-5 | `orchestrate.test.ts` (T-12 exact-match), `orchestrate.billing.test.ts`, `compose.fee.test.ts`, `fee-split.test.ts`, `money-path.*` → verdes SIN editar. |

---

## Anti-Hallucination Checklist (símbolos verificados por Architect)

Todos confirmados con Read en el codebase actual. Si alguno difiere → PARAR y escalar.

- [x] `FeeChargeParams` existe en `src/services/fee-charge.ts:43-53` (hoy: `{orchestrationId, feeBaseUsdc, feeRate}`).
- [x] `resolveRecipients(config, ctx)` en `fee-split.ts:203` acepta `ctx.creator`/`ctx.referral` — NO tocar (CD-6).
- [x] `SplitPartyRef` (`{wallet:string|null, ownerRef:string|null}`) y `SplitContext` exportados en `fee-split.ts:85-99`.
- [x] `isValidWallet` (único validador de wallet) en `fee-split.ts:164` — el helper NO revalida (CD-2).
- [x] Returns tempranos a modificar (MNR-3): `charged` :327, `pending` :335, `23505` :363. Path éxito: :489-496. `buildSplits` en scope (:281).
- [x] Call-site orchestrate en `orchestrate.ts:1064-1069`, `feeBaseUsdc: pipeline.totalCostUsdc`, sin try/catch propio.
- [x] Call-site compose en `routes/compose.ts:573-578`, `feeBaseUsdc: result.totalCostUsdc`, DENTRO del `try` (:573-617).
- [x] Patrón payTo→payment.contract en `compose.ts:791-801`.
- [x] `publishedAgentService.getRow` en `agent.ts:220-231`; `AgentRow` (:42-53) NO tipa `payout_wallet`/`referrer_ref` → NO ampliar.
- [x] `SELF_PUBLISHED_REGISTRY_ID = 'self-published'` en `types/index.ts:110`.
- [x] `StepResult.agent: Agent` (`types/index.ts:359-361`) → `steps[0]?.agent` es `Agent | undefined`.
- [x] `getSplitConfig` (`split-config.ts:86-110`) THROWEA `SplitConfigError` si Σ≠10000 → PROHIBIDO en call-site (CD-9). Env vars: `SPLIT_BPS_CREATOR`/`SPLIT_BPS_REFERRAL`.
- [x] Mock supabase multi-`.eq` en `fee-split.test.ts:44-72`.
- [x] Landmine exact-match en `orchestrate.test.ts:557` (`toHaveBeenCalledWith`, NO `objectContaining`).
- [ ] **[VERIFY-AT-IMPL]**: columnas reales de `a2a_agents` en runtime (`payout_wallet`, `referrer_ref`, `owner_ref`) — `select('*')` ya las trae hoy (F0 del work-item). Confirmar nombres exactos al escribir `getSplitContextRow`.
- [ ] **[VERIFY-AT-IMPL]**: imports a agregar en cada call-site (`splitsActive` de `../config/split-config.js`, `resolveAgentSplitContext` de `./agent-split-context.js` u `../services/agent-split-context.js` según ruta relativa, `SplitPartyRef`/`FeeChargeParams` según se necesite). Verificar la ruta relativa exacta desde `routes/compose.ts` vs `services/orchestrate.ts`.

---

## Waves

### Wave -1: Environment Gate (verificar antes de tocar código)
```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
npm install 2>/dev/null || echo "revisar package.json"
# Archivos base del Scope IN deben existir:
ls src/config/split-config.ts src/services/fee-charge.ts src/services/fee-split.ts \
   src/services/agent.ts src/services/orchestrate.ts src/routes/compose.ts \
   src/services/compose.ts 2>/dev/null || echo "FALTA archivo base"
# Typecheck baseline (debe pasar antes de empezar):
npx tsc --noEmit 2>&1 | head -20
```
**Si algo falla en Wave -1**: PARAR y reportar al orquestador. No implementar sobre entorno roto.

### Wave 0 — Contratos / seam (SERIAL, base de todo — nadie compila sin esto)
- [ ] **W0.1**: `split-config.ts` — agregar `splitsActive(): boolean` NO-throw (`Number.parseInt`, `> 0`, cualquier fallo → `false`). NO tocar `getSplitConfig`. → Archivo #1
- [ ] **W0.2**: `fee-charge.ts` — importar `SplitPartyRef` de `./fee-split.js`; ampliar `FeeChargeParams` (#2, DT-1); construir `ctx: SplitContext` con asignación condicional (CD-8, Exemplar 4) y pasarlo a `resolveRecipients`. → Archivo #2
- [ ] **W0.3**: `fee-charge.ts` — MNR-3: anteponer el chequeo `extrasFailed` en los 3 returns tempranos (:327/:335/:363, Exemplar 3). → Archivo #2

### Wave 1 — Resolución server-side (paralelizable tras W0)
- [ ] **W1.1**: `agent.ts` — agregar `publishedAgentService.getSplitContextRow(slug)` (#3, DT-4/CD-5, Exemplar 2). NO ampliar `AgentRow`. → Archivo #3
- [ ] **W1.2**: crear `src/services/agent-split-context.ts` — `resolveAgentSplitContext(agent)` best-effort (#4, DT-3/CD-10, Exemplar 1). Depende de W1.1 (usa `getSplitContextRow`). → Archivo #4

### Wave 2 — Cableado de call-sites (tras W1)
- [ ] **W2.1**: `orchestrate.ts:~1064` — dentro de `if (pipeline.success)`, gate `splitsActive()` → resolver `pipeline.steps[0]?.agent` → construir `feeParams: FeeChargeParams` con asignación condicional (CD-8/CD-9/CD-1b). → Archivo #5
- [ ] **W2.2**: `routes/compose.ts:~573` — mismo patrón con `result.steps[0]?.agent` y `feeBaseUsdc: result.totalCostUsdc`, DENTRO del `try` existente. → Archivo #6

Estructura ilustrativa de W2 (el Dev respeta CD-8/CD-9; con `splitsActive()===false` el objeto es idéntico al actual):
```ts
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

### Wave 3 — Tests (tras W2)
- [ ] **W3.1**: `split-config.test.ts` (o `split-active.test.ts`) — T-GATE. → Archivo #7
- [ ] **W3.2**: `agent-split-context.test.ts` — T-CTX-*. → Archivo #8
- [ ] **W3.3**: `fee-charge-splits.test.ts` — T-CREATOR/T-REF-WIRE/T-FALLBACK/T-MNR3/T-BYTEID. → Archivo #9
- [ ] **W3.4**: correr suites de no-regresión SIN editarlas (ver tabla). Deben quedar verdes.

### Verificación incremental
| Wave | Verificación al completar |
|------|--------------------------|
| W0 | `npx tsc --noEmit` pasa; `fee-charge.test.ts` sigue verde (byte-idéntico intacto). |
| W1 | typecheck; helper + `getSplitContextRow` compilan; sin exposición de wallets. |
| W2 | typecheck; `orchestrate.test.ts` (T-12 exact-match) + `orchestrate.billing.test.ts` + `compose.fee.test.ts` verdes SIN editar. |
| W3 | full test suite verde; nuevos tests cubren ≥1/AC. |

---

## Out of Scope (NO tocar bajo ninguna circunstancia)

- Write-path de `payout_wallet`/`referrer_ref` (extender `PublishAgentInput`/`UpdateAgentInput`,
  `POST`/`PATCH /agents`, captura de referrer) — **CD-7, v2**.
- Resolución REAL de `referral` (mecanismo `referrer_ref → wallet`) — DT-6, el call-site resuelve
  `referral=null` siempre; el seam queda cableado+testeado (T-REF-WIRE), no activado.
- Interior de `computeSplits`/`resolveRecipients`/`settleFeeSplits`/`reverseFeeSplits` (`fee-split.ts`) — CD-6.
- Interfaz `AgentRow` (:42-53), `mapRowToAgent`, `mapRowToRecord`, cualquier mapper/endpoint público — CD-5.
- Cableado de `reverseFeeSplits` a orchestrate/compose (MNR-2, sigue diferido).
- Atribución proporcional multi-agente (solo `steps[0]`, SG-5 de WKH-136).
- Suites de test existentes (CD-1). NO "mejorar" código adyacente. NO nuevas dependencias.

---

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala a Architect.** No inventar, no asumir.

Situaciones de escalation:
- Un símbolo del Anti-Hallucination Checklist difiere del código real (líneas movidas, firma distinta).
- Las columnas reales de `a2a_agents` no son `payout_wallet`/`referrer_ref`/`owner_ref` ([VERIFY-AT-IMPL]).
- El typecheck exige un cambio de firma pública que no esté cubierto por DT-1.
- Alguna suite existente requeriría edición para pasar (viola CD-1 — es señal de que el gate `splitsActive()`
  no está aislando bien el path default).
- El cambio requiere tocar archivos fuera de la tabla "Files to Modify/Create".

---

*Story File generado por nexus-architect — F2.5. No implementa código. Dev arranca en Wave -1.*
