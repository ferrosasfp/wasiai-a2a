# SDD #170: [WKH-172] Publicar `remit-cashout-payout` como agente standalone del marketplace A2A (etapa 1 / payout MOCK)

> SPEC_APPROVED: no
> Fecha: 2026-07-10
> Tipo: feature
> SDD_MODE: full
> Branch: feat/170-wkh-172-remit-cashout-payout
> Artefactos: doc/sdd/170-wkh-172-remit-cashout-payout/
> Repos tocados: `wasiai-remittance-agents` (endpoint + tests + 1 cambio ACOTADO al fail-safe money-path) · `wasiai-a2a` (CERO código — solo registro runtime)

---

## 1. Resumen

Se construye y deploya el **endpoint HTTP** que hace invocable al agente `remit-cashout-payout` (hoy una
librería TS pura, `src/agents/cashout-payout.ts`, sin servidor) y se lo **registra** como agente REGISTRADO
y facturable en el protocolo A2A vía el mecanismo self-serve ya existente (`POST /agents`, WKH-134/143b/173,
gratis). El endpoint es una **Next.js API route** (App Router, mismo deploy Vercel `wasiai-remittance-agents`
de WKH-171/170 — NO un proyecto nuevo) que envuelve `runCashoutPayout` + `CashoutPayoutInputSchema`, honra
el contrato A2A `POST /invoke → 200 { result: {...} }` (legible por `data.result ?? data` en `compose.ts`),
responde `400` estructurado si el body falla Zod, y `502` opaco si el core/provider falla.

Esta HU cierra el trío `remit-*` (FX + KYC + **Payout**) y prueba el riel completo `discover → pagar
(a2a-key) → invocar → fee-split creator` sobre el leg **más sensible** de la remesa (el desembolso), con las
tres garantías money-path: **hard-gate KYC** (sin `kycPayoutAllowed` no se desembolsa), **idempotencia**
(mismo `idempotencyKey` → mismo `payoutId`) y **reembolso/credit-back** (heredado de `refund-outbox.ts`).

**El eje crítico y novedoso de esta HU** (no presente en WKH-170/171) es el **HALLAZGO F0 #1**: el fail-safe
`assertPayoutProviderSafe()` (`cashout-payout.ts:48-61`) lanza `payout_refused` **incondicionalmente** cuando
`NODE_ENV==='production'` sin provider real — y Vercel fija `NODE_ENV=production` en todo deploy construido,
así que el mock NUNCA podría correr en el deploy real (todo invoke daría 502). El humano **ratificó la
Opción A**: introducir un opt-in ACOTADO y explícito (`PAYOUT_ALLOW_MOCK=true`) que permita correr el
**FallbackPayoutProvider (mock)** en prod SOLO para etapa 1, **sin abrir jamás un path a desembolso real**.
El diseño de ese flag (§4.3) es el corazón de este SDD y el objeto obligatorio del Adversary Review.

**Decisiones ratificadas por el humano (heredadas de WKH-170/171 — NO se reabren):** (1) modo de pago =
a2a-key prepago → `wasiai-a2a` con CERO código nuevo; (2) stack = Next.js API route en el MISMO deploy Vercel;
(3) etapa 1 = payout MOCK (`FallbackPayoutProvider`, `provenance:"local-fallback"`, nunca mueve plata);
TransFi real (`TRANSFI_API_KEY`+`TRANSFI_ADAPTER_READY`) permanece gated OFF (etapa 2 / WKH-168, Scope OUT).

Resultado esperado: `remit-cashout-payout` aparece en `POST /discover` como `status:active`, es invocable vía
`/compose` con a2a-key, ejecuta el payout MOCK (tagueado inequívocamente como simulación) SOLO tras pasar el
hard-gate KYC, es idempotente por `idempotencyKey`, NUNCA expone PII del beneficiario (Yape/CCI) y liquida el
leg `creator` del protocol fee a su `payoutWallet` — en paralelo al demo `agentshop-cashout-matcher`, intacto.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 170 (WKH-172) |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Objetivo** | Hacer invocable + registrar `remit-cashout-payout` (endpoint HTTP nuevo + `POST /agents`) probando el riel discover→pagar(a2a-key)→invocar→fee-split sobre el leg de payout, con las 3 garantías money-path (hard-gate KYC, idempotencia, reembolso) y NO-PII del beneficiario en toda respuesta HTTP; resolviendo el hallazgo del fail-safe con un opt-in ACOTADO al mock (Opción A) que no puede habilitar desembolso real. |
| **Reglas de negocio** | Slug byte-idéntico `remit-cashout-payout`; payout 100% `FallbackPayoutProvider` (mock); TransFi OFF; hard-gate KYC (`kycPayoutAllowed`); idempotencia determinística; `deliveredLocal`/`txRef` = `null` + `provenance:"local-fallback"` siempre visibles; NO-PII beneficiario en 200/400/502; testnet-only; mutaciones infra/prod + cualquier cambio al fail-safe gated por `!` humano. |
| **Scope IN** | `wasiai-remittance-agents`: invoke route + tests + cambio ACOTADO al fail-safe `assertPayoutProviderSafe()` (Opción A) + tests del flag + sección README + redeploy Vercel (mismo proyecto, con `PAYOUT_ALLOW_MOCK=true`). `wasiai-a2a`: 1 llamada runtime `POST /agents` (sin código). |
| **Scope OUT** | `wasiai-agentshop`/`agentshop-cashout-matcher`; `orchestrate.ts`/core `compose.ts`; ampliar `refund-outbox.ts`; adapter TransFi real + desembolso real; `resolveTravelRuleData()` (stub); máquina de estados value-delivery (WKH-168); re-verificación server-to-server del KYC; `remit-corridor-fx`/`remit-kyc-validator`; mainnet; migraciones DB; reabrir modo de pago. |
| **Missing Inputs** | #1 (fail-safe) **RESUELTO** = Opción A (opt-in `PAYOUT_ALLOW_MOCK`, §4.3). #2 (a2a-key/owner_ref + `payoutWallet` testnet) y #3 (redeploy Vercel + confirmación TransFi OFF + `POST /agents` prod) = pasos manuales gated por `!` (§11). #4 (`priceUsdc`) resuelto = `0.03`. #5 (modo pago/stack) resuelto por WKH-170/171. #6 (confianza en `kycPayoutAllowed` del caller) = boundary heredado, Scope OUT. |

### Acceptance Criteria (EARS)

- **AC-1**: WHEN un caller consulta `POST /discover` (o `GET /agents/remit-cashout-payout/agent-card`) en
  `wasiai-a2a`, THE system SHALL devolver `remit-cashout-payout` como agente activo (`status:active`,
  `enabled:true`), distinto y sin reemplazar a `agentshop-cashout-matcher`.
- **AC-2**: WHEN se registra `remit-cashout-payout` vía `POST /agents`, THE system SHALL persistir una fila
  NUEVA en `a2a_agents` con slug EXACTO `remit-cashout-payout` (idéntico al `SLUG` exportado por
  `src/agents/cashout-payout.ts`), sin modificar ninguna fila `agentshop-*`.
- **AC-3**: WHEN se invoca el endpoint con `kycPayoutAllowed:false` (hard-gate KYC no superado), THE system
  SHALL responder `200` con `result.executed:false`, `result.status:"blocked"`,
  `result.reason:"kyc_gate_not_passed"`, y SHALL NUNCA invocar al payout provider (ni real ni fallback).
- **AC-4**: WHEN se invoca el endpoint con `kycPayoutAllowed:true` y un input válido, THE system SHALL
  responder `200` con un `result` que contenga EXCLUSIVAMENTE `slug`, `executed`, `status`, `payoutId`,
  `deliveredLocal`, `txRef`, `reason`, `provenance` — y SHALL NUNCA incluir `beneficiary.name`,
  `beneficiary.destination` ni `travelRuleData` (ni en claro ni anidados) en ninguna respuesta HTTP
  (200/400/502) ni en logs estructurados.
- **AC-5**: WHEN se invoca el endpoint dos veces con el mismo `idempotencyKey` (mismo input, provider mock),
  THE system SHALL devolver el mismo `payoutId` determinístico (`fallback-${idempotencyKey}`) en ambas
  respuestas, sin generar dos identificadores de payout distintos para el mismo reintento.
- **AC-6**: IF el deploy corre en producción (`NODE_ENV==='production'`) sin provider de payout real
  (`TRANSFI_API_KEY`+`TRANSFI_ADAPTER_READY`) Y **sin** el opt-in `PAYOUT_ALLOW_MOCK=true`, THEN THE system
  SHALL rechazar la ejecución (`502`, `payout_refused` internamente) — el mock NUNCA se ejecuta silenciosamente
  en ese estado (comportamiento default intacto). **[RESUELTO — Opción A]** WHILE el deploy de etapa 1 corra
  con `PAYOUT_ALLOW_MOCK=true` (y TransFi OFF), THE system SHALL ejecutar el **FallbackPayoutProvider (mock)**,
  devolviendo `provenance:"local-fallback"`, `deliveredLocal:null`, `txRef:null` — y SHALL NUNCA ejecutar un
  desembolso real (ese path sigue 100% gated por `TRANSFI_API_KEY`+`TRANSFI_ADAPTER_READY`, independiente del flag).
- **AC-7**: IF la invocación de `remit-cashout-payout` como step pago de un pipeline `/compose`/`/orchestrate`
  falla (502 o excepción, incluido el caso AC-6 sin flag), THEN THE system SHALL acreditar de vuelta el monto
  debitado por ese step vía el mecanismo de refund existente (`refund-outbox.ts`, WKH-127/128/129), sin
  requerir código nuevo en `wasiai-a2a`.
- **AC-8**: IF el body del request falla la validación Zod (ej. falta `idempotencyKey` / `beneficiary.method`
  inválido), THEN THE system SHALL responder `400` con un error estructurado (Zod `.flatten()` únicamente) que
  NO ecoe el valor de `beneficiary.name`/`beneficiary.destination` recibido, nunca un 500 sin manejar.
- **AC-9**: WHEN un pipeline cuyo `steps[0]` es `remit-cashout-payout` completa con éxito Y el agente declaró
  `payoutWallet`, THE system SHALL liquidar el leg `creator` del protocol fee (1%) a esa wallet vía el
  mecanismo existente (`fee-split.ts`/`agent-split-context.ts`), auditable en `a2a_fee_splits`.

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón / hallazgo extraído |
|---------|---------|-----------|
| `wasiai-remittance-agents/src/agents/cashout-payout.ts` | **Core a envolver + sede del cambio del flag** | `SLUG="remit-cashout-payout"` (l.14), `PRICE_USDC=0.03` (l.15). `CashoutPayoutInputSchema` (l.17-29) exige `kycVerificationId`, `kycPayoutAllowed:boolean`, `idempotencyKey`, `beneficiary{name,country,method,destination}`. `runCashoutPayout(raw)` (l.67-108): parsea (throws ZodError), hard-gate KYC (l.71-82: `!kycPayoutAllowed` → return `{executed:false, status:"blocked", reason:"kyc_gate_not_passed"}` SIN llamar provider), luego `assertPayoutProviderSafe()` + `getPayoutProvider().execute()`. Output = 8 campos `{slug,executed,status,payoutId,deliveredLocal,txRef,reason,provenance}` — **sin** `beneficiary`/`travelRuleData`. `resolveTravelRuleData()` (l.110-122) = STUB (no propaga PII). **`assertPayoutProviderSafe()` (l.48-61) = sede del cambio del flag (Opción A).** |
| `wasiai-remittance-agents/src/providers/payout.ts` | Provider de payout | `getPayoutProvider()` (l.108-118): sin `TRANSFI_API_KEY` → `FallbackPayoutProvider` (mock). Con key pero `TRANSFI_ADAPTER_READY!=='true'` → **lanza** `transfi_adapter_not_ready` (fail-loud, l.111-114). `FallbackPayoutProvider.execute` (l.68-78): determinístico, `payoutId:fallback-${idempotencyKey}`, `deliveredLocal:null`, `txRef:null`, `provenance:"local-fallback"` (CD-9). `assertValidPayout` (l.99-105) guarda contra id vacío/NaN. **Este archivo NO se modifica** — el flag vive solo en cashout-payout.ts. |
| `wasiai-remittance-agents/src/providers/types.ts` | Contratos | `PayoutInput` (l.61-73) = `{quoteId, amountUsd, beneficiary{name,country,method,destination}, travelRuleData, idempotencyKey}`. `PayoutResult` (l.75-82) = `{payoutId, status, deliveredLocal, txRef, failureReason, provenance}`. Confirma qué es PII (`beneficiary`, `travelRuleData`) y que el output del agente los excluye. |
| `wasiai-remittance-agents/src/agents/cashout-payout.test.ts` | Patrón de test core + fail-safe actual | vitest; `validInput` con `beneficiary.destination:"999999999"` (PII). Cubre hard-gate (l.15-20), PROD sin real → throws (l.26-30), dev sin opt-in → throws (l.32-37), dev+`ALLOW_FALLBACK_PAYOUT=true` → mock ejecuta con `deliveredLocal:null` (l.39-47), input inválido → throws (l.49-51). **Debe extenderse con los 3 tests del flag nuevo (§6).** |
| `wasiai-remittance-agents/src/app/api/agents/remit-kyc-validator/invoke/route.ts` | **Exemplar PRINCIPAL del endpoint** (VERIFICADO ✓) | `import {NextRequest,NextResponse} from "next/server"`; `const parsed = InputSchema.safeParse(await req.json().catch(()=>null)); if(!parsed.success) return NextResponse.json({error:"invalid_input",details:parsed.error.flatten()},{status:400})`; `try{ const result = await runX(parsed.data); return NextResponse.json({result},{status:200}) } catch(err){ console.warn(...,{errorName: err instanceof Error ? err.name : "unknown"}); return NextResponse.json({error:"..._unavailable"},{status:502}) }`. Import por alias `@/agents/...`. CD-6 comentado en el propio archivo. |
| `wasiai-remittance-agents/src/app/api/agents/remit-kyc-validator/invoke/route.test.ts` | **Exemplar del test HTTP** (VERIFICADO ✓) | `vi.hoisted` + `vi.mock("@/agents/...", ...actual)` para forzar throw del core en el test 502 sin tocar el core (`runXMock.mockImplementationOnce`). `POST(new NextRequest(url,{method:"POST",body:JSON.stringify(...)}))`. `const output = data.result ?? data`. Asserts NO-PII: `expect(JSON.stringify(...)).not.toContain("<PII>")`. Test 502 con mensaje-trampa + `data.stack toBeUndefined()`. `beforeEach`: `vi.stubEnv(...)`; `afterEach`: `vi.unstubAllEnvs()`. |
| `wasiai-remittance-agents/README.md` | Contrato HTTP + sección espejo | §"Endpoint HTTP + deploy (etapa 1 — `remit-kyc-validator`)" (l.94+) es el molde de la nueva sección Payout. Dev port `3030`. Tabla de agentes (l.35-36) ya lista `remit-cashout-payout`. |
| `wasiai-a2a/doc/sdd/169-wkh-170-remit-kyc-validator/sdd.md` | **Precedente directo** (sibling, DONE) | Estructura de este SDD, payload `POST /agents` (§10), derivación de slug (`name.toLowerCase().replace(/\s+/g,'-')`), contrato `data.result ?? data`, waves manuales gated por `!`. Se hereda sin re-verificar código de `wasiai-a2a` (CERO código nuevo acá). |
| `wasiai-a2a/doc/sdd/168-wkh-173-.../auto-blindaje.md`, `155-...`, `142-...` | **Auto-blindaje histórico** | Ver §5 (blindaje heredado): hygiene biome/tsc recurrente (WKH-114/144/115): optional-chaining (`x?.prop`), sin imports sin uso, `tsc --noEmit` debe pasar también sobre `.test.ts`. Money-path replay (WKH-115 MNR-2): la idempotencia es una property, no un window de tolerancia. |

### Exemplars

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `src/app/api/agents/remit-cashout-payout/invoke/route.ts` | `remit-kyc-validator/invoke/route.ts` (VERIFICADO ✓) | Mismo patrón CD-6 no-PII exacto: `safeParse`→400 `.flatten()`, core→`{result}` 200, catch→502 opaco con solo `err.name`. Se cambia `KycInputSchema/runKycValidator` por `CashoutPayoutInputSchema/runCashoutPayout` y el código de error 502 a `payout_unavailable`. |
| `src/app/api/agents/remit-cashout-payout/invoke/route.test.ts` | `remit-kyc-validator/invoke/route.test.ts` (VERIFICADO ✓) + `cashout-payout.test.ts` | Contract tests con `vi.mock` del core + tests NO-PII a nivel HTTP + hard-gate + idempotencia + flag/fail-safe. |
| Cambio a `assertPayoutProviderSafe()` en `src/agents/cashout-payout.ts` (l.48-61) | El propio bloque existente (fork mínimo de la rama `NODE_ENV==='production'`) | Opción A: agregar el opt-in `PAYOUT_ALLOW_MOCK` SOLO en la rama prod, sin tocar `hasReal` ni la rama dev. Ver §4.3. |
| Extensión de `src/agents/cashout-payout.test.ts` | Los tests existentes del mismo archivo (l.26-47) | 3 tests nuevos del flag (prod+flag→mock, prod+flag+TransFi-key-sin-ready→throws, prod-sin-flag→throws default). |
| Payload `POST /agents` (§10, doc, NO código) | WKH-170 SDD §10 (VERIFICADO en DONE) | Campos exactos + derivación de slug + `outputSchema` SIN PII del beneficiario. |

### Estado de BD relevante

| Tabla | Existe | Columnas relevantes | Cambios |
|-------|--------|---------------------|---------|
| `a2a_agents` (`wasiai-a2a`) | Sí | `slug` (PK), `name`, `agent_url`, `price_usdc`, `capabilities` (JSONB), `metadata` (JSONB), `payout_wallet`, `referrer_ref`, `enabled`, `owner_ref` | **NINGUNO** — solo se INSERTA 1 fila vía `POST /agents` runtime (DT-1). Sin migración. |
| `a2a_fee_splits` | Sí | leg `creator` + `status` + `tx_hash` | Solo lectura (evidencia de AC-9). |
| `a2a_refund_outbox` | Sí | auditoría de credit-back | Solo lectura (evidencia de AC-7). Sin código nuevo (DT-7). |

### Componentes reutilizables encontrados

- `runCashoutPayout` / `getPayoutProvider` / `CashoutPayoutInputSchema` / `FallbackPayoutProvider` /
  `assertPayoutProviderSafe` — **ya implementados y testeados**. El endpoint SOLO los envuelve; el ÚNICO
  cambio de lógica es el opt-in del flag en `assertPayoutProviderSafe()` (§4.3). NO se reimplementa payout,
  hard-gate, ni idempotencia.
- El scaffold Next 14 completo (`package.json`, `tsconfig.json` alias `@/*→src/*`, `next.config.mjs`,
  `layout.tsx`, `page.tsx`, `vitest.config.ts`) — **ya existe** (WKH-171/170). No se re-scaffolda.
- `refund-outbox.ts` (`wasiai-a2a`, WKH-127/128/129) — acredita cualquier step fallido genéricamente. Se
  hereda automáticamente para AC-7, **cero código nuevo** (DT-7).
- El pipeline de discovery/fee-split del gateway ya mergea filas `a2a_agents` — cero código nuevo en
  `wasiai-a2a` (DT-1).

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar (`wasiai-remittance-agents`)

| Archivo | Acción | Qué hace | Exemplar |
|---------|--------|----------|----------|
| `src/agents/cashout-payout.ts` (l.48-61) | **Modificar (ACOTADO)** | Opción A: opt-in `PAYOUT_ALLOW_MOCK` en la rama `NODE_ENV==='production'` de `assertPayoutProviderSafe()`. ÚNICA excepción al "no tocar el core". Ver §4.3. | El bloque existente |
| `src/app/api/agents/remit-cashout-payout/invoke/route.ts` | **Crear** | Endpoint principal. Envuelve `runCashoutPayout`, `{result}` 200, 400 sin PII, 502 opaco. Ver §4.4. | `remit-kyc-validator/invoke/route.ts` |
| `src/app/api/agents/remit-cashout-payout/invoke/route.test.ts` | **Crear** | Contract tests HTTP (AC-3/4/5/6/8) incl. NO-PII beneficiario en 200/400/502, hard-gate, idempotencia, flag/fail-safe. Ver §6. | `remit-kyc-validator/invoke/route.test.ts` + `cashout-payout.test.ts` |
| `src/agents/cashout-payout.test.ts` | **Modificar (extender)** | +3 tests del flag nuevo (prod+flag→mock; prod+flag+TransFi-key-sin-ready→throws; prod-sin-flag→throws default). Ver §6. | Los tests existentes del archivo |
| `README.md` | Modificar (menor) | Nueva sección "Endpoint HTTP + deploy (etapa 1 — `remit-cashout-payout`)", espejo de la de `remit-kyc-validator`, documentando `PAYOUT_ALLOW_MOCK` y su naturaleza de incidente-si-se-usa-fuera-de-etapa-1. | `README.md` §l.94+ |

> `src/providers/payout.ts`, `src/providers/types.ts` y todo el scaffold = **NO se tocan**. `resolveTravelRuleData()`
> (stub) = **NO se toca** (CD-10).

### 4.2 Modelo de datos

N/A. Sin cambios de schema (DT-1). Solo INSERT runtime de 1 fila en `a2a_agents` vía `POST /agents` (§10,
paso manual gated por `!`).

### 4.3 ⭐ Diseño del flag `PAYOUT_ALLOW_MOCK` (Opción A — corazón del SDD, objeto obligatorio del AR)

**Problema (hallazgo F0 #1).** `assertPayoutProviderSafe()` (`cashout-payout.ts:48-61`) hoy lanza
`payout_refused` **incondicionalmente** en `NODE_ENV==='production'` cuando no hay provider real. Vercel fija
`NODE_ENV=production` en todo deploy → el mock NUNCA corre en el deploy real → todo invoke daría 502,
contradiciendo el objetivo de la HU ("payout mock para validar el riel").

**Solución (Opción A, ratificada).** Introducir un opt-in NUEVO, ACOTADO y ruidoso `PAYOUT_ALLOW_MOCK` que,
SOLO en la rama `NODE_ENV==='production'`, permita proceder al **mock** (nunca al real). Estructura del
cambio (mínimo, solo la rama prod — el resto del método queda byte-idéntico):

```
function assertPayoutProviderSafe(): void {
  const hasReal =
    !!process.env.TRANSFI_API_KEY && process.env.TRANSFI_ADAPTER_READY === "true";
  if (hasReal) return;                              // ← INTACTO: path TransFi real, gate propio

  if (process.env.NODE_ENV === "production") {
    // ⚠️ SEGURIDAD MONEY-PATH (WKH-172, etapa 1): PAYOUT_ALLOW_MOCK habilita SOLO el
    // FallbackPayoutProvider (mock, NUNCA mueve plata). NO abre ningún path a desembolso real:
    // el path real sigue 100% gated por TRANSFI_API_KEY + TRANSFI_ADAPTER_READY (chequeado arriba
    // vía hasReal, y de nuevo en getPayoutProvider()). Activar este flag en CUALQUIER deploy que
    // no sea el de etapa 1 (mock) es un INCIDENTE DE SEGURIDAD money-path.
    if (process.env.PAYOUT_ALLOW_MOCK !== "true") {
      throw new Error("payout_refused: se requiere provider de payout REAL en producción (no fallback)");
    }
    console.warn("[remit-payout] PROD + PAYOUT_ALLOW_MOCK: usando payout FALLBACK (mock, NO mueve plata) — SOLO etapa 1");
    return;
  }

  if (process.env.ALLOW_FALLBACK_PAYOUT !== "true") {   // ← INTACTO: rama dev/CI sin cambios
    throw new Error("payout_refused: el payout fallback (mock) requiere ALLOW_FALLBACK_PAYOUT=true explícito (solo dev/CI)");
  }
  console.warn("[remit-payout] usando payout FALLBACK (mock, NO mueve plata) — solo dev/CI");
}
```

**Propiedades de seguridad — los 4 puntos que el AR DEBE verificar (BLOQUEANTE si falla alguno):**

1. **El flag NO puede abrir un path a desembolso real.** `hasReal` se evalúa PRIMERO y hace `return` antes de
   leer el flag; cuando hay TransFi real configurado, el flag ni se lee. Cuando NO hay real, el flag como mucho
   deja proceder a `getPayoutProvider()`, que **sin `TRANSFI_API_KEY` devuelve `FallbackPayoutProvider`** — no
   hay forma de que el flag materialice un provider real (no puede "inventar" una key ni un adapter). El flag
   solo elige entre **throw vs mock**, jamás **mock vs real**.
2. **TransFi sigue OFF por default e independiente del flag.** El path real está gated por
   `TRANSFI_API_KEY`+`TRANSFI_ADAPTER_READY` en DOS lugares (`hasReal` acá y `getPayoutProvider()` en
   payout.ts:108-118), ninguno de los cuales lee `PAYOUT_ALLOW_MOCK`. Caso adverso: `PAYOUT_ALLOW_MOCK=true`
   **+** `TRANSFI_API_KEY` seteada **pero** `TRANSFI_ADAPTER_READY!=='true'` → `hasReal` es false → entra a la
   rama prod → flag true → procede → `getPayoutProvider()` **lanza `transfi_adapter_not_ready`** (fail-loud) →
   502. NO corre el mock silenciosamente con una TransFi a medias, NI corre un real sin readiness. (CD-4
   garantiza que en este deploy `TRANSFI_API_KEY` va SIN setear, así que el path normal es directo al mock.)
3. **El output es inequívocamente mock.** Cuando corre, `FallbackPayoutProvider.execute()` fuerza
   `deliveredLocal:null`, `txRef:null`, `provenance:"local-fallback"` (payout.ts:70-77, CD-9), que
   `runCashoutPayout` mapea 1:1 al output sin renombrar. Ningún consumidor puede confundirlo con un desembolso
   real (no hay monto entregado ni referencia on-chain/partner).
4. **Sin el flag, el fail-safe sigue rechazando (default intacto).** En prod sin `PAYOUT_ALLOW_MOCK=true` →
   lanza el MISMO `payout_refused` de hoy → 502. La rama dev/CI (`ALLOW_FALLBACK_PAYOUT`) queda byte-idéntica.
   No se amplía el alcance de `ALLOW_FALLBACK_PAYOUT` (CD-11: nombre distinto, guarda propia en prod).

**Contrato con CD-11:** nombre nuevo `PAYOUT_ALLOW_MOCK` (≠ `ALLOW_FALLBACK_PAYOUT`); guarda dentro de la
rama `NODE_ENV==='production'` (no reutiliza la dev); comentario de seguridad money-path horneado en el código.

### 4.4 Endpoint — diseño (sin código)

Handler `POST` en `src/app/api/agents/remit-cashout-payout/invoke/route.ts` (fork exacto de KYC):

1. `const parsed = CashoutPayoutInputSchema.safeParse(await req.json().catch(() => null))` — importar
   `CashoutPayoutInputSchema` desde `@/agents/cashout-payout` (reusar, **NO duplicar**).
2. **Si `!parsed.success` → 400 SIN PII (AC-8 / CD-6):** `return NextResponse.json({ error:"invalid_input",
   details: parsed.error.flatten() }, { status:400 })`.
   - `ZodError.flatten()` es **value-free** por diseño (mensajes de validación Zod, ej. `"Required"`,
     `"Invalid enum value"`), nunca el valor recibido. `CashoutPayoutInputSchema` usa solo `.min()`/`.positive()`/
     `.enum()`/tipos básicos sin mensajes custom que interpolen valores → provablemente libre de PII.
   - **PROHIBIDO en este path:** devolver `parsed.data`/body crudo/`parsed.error` con transformación que
     interpole valores, ni mensajes custom en el schema que ecoen `beneficiary.name`/`destination`.
3. **200 happy path:** `try { const result = await runCashoutPayout(parsed.data); return
   NextResponse.json({ result }, { status:200 }) }` — envolver en `{ result }` (contrato `data.result ?? data`).
   El core garantiza `result` = 8 campos sin PII.
4. **502 catch (opaco):** `catch (err)`: el core puede lanzar `payout_refused` (fail-safe sin flag) o
   `transfi_adapter_not_ready` (si alguien viola CD-4) o ZodError re-lanzada (no debería, ya cubierto por
   safeParse). Responder `502` con body **fijo** `{ error:"payout_unavailable" }` + `console.warn(
   "[remit-cashout-payout] payout failed:", { errorName: err instanceof Error ? err.name : "unknown" })`
   (**solo `err.name`, sin `err.message`/stack/input**). **Nunca un 500 sin manejar.**
5. Sin receipt EIP-712, sin lógica de pago/x402/on-chain en el endpoint (lo hace el gateway a2a).

### 4.5 Flujo principal (Happy Path — riel completo)

1. Caller con **a2a-key** invoca `POST /compose` en `wasiai-a2a` con `steps[0]=remit-cashout-payout` + input
   `{ quoteId, amountUsd, kycVerificationId, kycPayoutAllowed:true, beneficiary{...}, idempotencyKey }`.
2. Gateway hace discovery → encuentra la fila `a2a_agents` (`status:active`, `invokeUrl` = deploy Vercel).
3. Gateway **debita** el `price_usdc` (0.03) del budget del a2a-key (ledger interno).
4. Gateway hace `POST {invokeUrl}` → endpoint corre `runCashoutPayout`: pasa el hard-gate KYC (`kycPayoutAllowed:true`)
   → `assertPayoutProviderSafe()` deja proceder (prod + `PAYOUT_ALLOW_MOCK=true`, §4.3) → `getPayoutProvider()`
   devuelve el mock (TransFi OFF) → `200 { result: { slug, executed:true, status:"settled", payoutId:
   "fallback-<idempotencyKey>", deliveredLocal:null, txRef:null, reason:null, provenance:"local-fallback" } }`
   (SIN PII del beneficiario).
5. Gateway lee `data.result`, continúa/completa el pipeline.
6. Al completar con éxito, cobra el 1% protocol fee y **liquida el leg `creator`** a `payout_wallet` → fila en
   `a2a_fee_splits` (AC-9).

### 4.6 Flujo de error

1. `kycPayoutAllowed:false` → `200 { result: { executed:false, status:"blocked", reason:"kyc_gate_not_passed" } }`
   SIN llamar al provider (AC-3). No es error HTTP: es un resultado de negocio legible por el pipeline.
2. Body inválido (falta `idempotencyKey`/`beneficiary.method` inválido/no-JSON) → `400 {error:"invalid_input",
   details}` **sin ecoar** `beneficiary.name`/`destination` (AC-8/CD-6). El gateway ve el 4xx → reembolsa (AC-7).
3. Prod **sin** `PAYOUT_ALLOW_MOCK` → core lanza `payout_refused` → catch → `502 {error:"payout_unavailable"}`
   opaco (AC-6). El gateway ve el 502 → reembolsa vía `refund-outbox.ts` (AC-7). Comportamiento default intacto.
4. Violación CD-4 (`TRANSFI_API_KEY` seteada sin `TRANSFI_ADAPTER_READY=true`) → `getPayoutProvider()` lanza
   `transfi_adapter_not_ready` → 502 opaco (fail-loud, no mock silencioso, no real sin readiness).

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir
- **CD-3 (heredado)**: slug byte-idéntico `remit-cashout-payout`. En el registro, `name="remit-cashout-payout"`
  EXACTO (`name.toLowerCase().replace(/\s+/g,'-')` produce ese slug). NO usar espacios/mayúsculas.
- **CD-6 (heredado, eje crítico)**: ningún response HTTP (200/400/502) ni log estructurado puede contener
  `beneficiary.name`, `beneficiary.destination` (Yape/CCI) ni `travelRuleData` en ningún nivel. El 400 usa
  **solo** `parsed.error.flatten()`. El 502 es body fijo `{error:"payout_unavailable"}` + `console.warn` con
  **solo** `err.name`. DEBE existir ≥1 test que lo verifique a nivel HTTP en 200, 400 **y** 502 (input con
  `beneficiary.destination` real → assert que no aparece).
- **CD-9 (heredado)**: el mock NUNCA aparenta un movimiento real — `deliveredLocal:null`, `txRef:null`,
  `provenance:"local-fallback"` SIEMPRE visibles; nunca ofuscados/renombrados. Test que lo asserta.
- **CD-11 (heredado, flag)**: el opt-in nuevo se llama `PAYOUT_ALLOW_MOCK` (≠ `ALLOW_FALLBACK_PAYOUT`),
  con guarda propia dentro de `NODE_ENV==='production'`, y comentario horneado que documente que activarlo
  fuera del deploy de etapa 1 es un incidente de seguridad money-path (§4.3).
- **CD-8 (heredado)**: endpoint responde `200 { result: {...} }`, legible por `data.result ?? data`. Contrato
  idéntico a `remit-kyc-validator`/`remit-corridor-fx`.
- Reusar `CashoutPayoutInputSchema` y `runCashoutPayout` de `@/agents/cashout-payout`. NO duplicar schema/lógica.
- El scaffold Next ya existe: NO tocar `package.json`/`tsconfig.json`/`next.config.mjs`/`layout.tsx`/`page.tsx`/
  `vitest.config.ts`. Solo se agrega la carpeta `remit-cashout-payout/invoke/`.
- **Blindaje histórico (WKH-114/144/115 — auto-blindaje)**: correr `biome check --write` por archivo ANTES del
  gate; narrowing de nullable con `x?.prop` (no `!x || !x.y`); sin imports sin uso; `tsc --noEmit` debe pasar
  **también** sobre los `.test.ts` (anotar `req`/handlers ad-hoc si los hubiera). El gate no es solo vitest verde.

### PROHIBIDO
- **CD-1**: NO tocar NINGÚN archivo de `wasiai-agentshop` / `agentshop-cashout-matcher` ni su registro/slug.
- **CD-2**: NO tocar `wasiai-a2a` (CERO código: ni `orchestrate.ts`, ni core `compose.ts`, ni ampliar
  `refund-outbox.ts`). El registro es 100% runtime (`POST /agents`).
- **CD-4**: NO setear/activar `TRANSFI_API_KEY` ni `TRANSFI_ADAPTER_READY=true` en el deploy de esta HU
  (TransFi real = etapa 2 / WKH-168). El deploy corre con ambas SIN setear.
- **CD-5**: testnet-only — `payoutWallet` = wallet EVM **testnet** (Kite/Avalanche/Base testnet). Nunca mainnet.
- **CD-6 / CD-9 / CD-11** (ver OBLIGATORIO arriba).
- **CD-7 (heredado, ampliado)**: mutaciones de infra/prod (redeploy Vercel, `POST /agents` contra prod,
  `payoutWallet`) **Y cualquier cambio a `assertPayoutProviderSafe()`** las ejecuta/ratifica el **humano vía
  `!`**. El cambio del flag (§4.3) es la ÚNICA excepción acotada al "no tocar el core" y **requiere AR explícito**.
- **CD-10**: NO tocar `resolveTravelRuleData()` (stub) ni introducir recuperación real del Travel Rule data.
- NO modificar `src/providers/payout.ts`/`types.ts` (el flag vive SOLO en `cashout-payout.ts`).
- NO tocar el hard-gate KYC (`cashout-payout.ts:71-82`) — ya correcto, no se agrega override.
- NO agregar deps nuevas, receipt EIP-712, ni consumidor de value-delivery real (WKH-168).

## 6. Test Plan

Framework: **vitest**. Los tests corren en fallback (TransFi OFF, sin red real). En el repo de tests
`NODE_ENV` es `"test"` por default; para ejercer el mock por la rama dev se usa `ALLOW_FALLBACK_PAYOUT=true`,
y para ejercer explícitamente el flag nuevo se stubea `NODE_ENV=production` + `PAYOUT_ALLOW_MOCK`.

### 6.1 Core — extender `src/agents/cashout-payout.test.ts` (3 tests nuevos del flag)

| Test | AC / CD | Descripción |
|------|---------|-------------|
| "PROD + PAYOUT_ALLOW_MOCK → ejecuta mock (no mueve plata)" | AC-6, §4.3 pt.1/3 | `stubEnv NODE_ENV=production`, `TRANSFI_API_KEY=""`, `PAYOUT_ALLOW_MOCK="true"` → `out.executed:true`, `out.provenance:"local-fallback"`, `out.deliveredLocal:null`, `out.txRef:null`. |
| "PROD + PAYOUT_ALLOW_MOCK + TRANSFI_API_KEY sin READY → throws transfi_adapter_not_ready" | AC-6, §4.3 pt.2 | `stubEnv NODE_ENV=production`, `PAYOUT_ALLOW_MOCK="true"`, `TRANSFI_API_KEY="k"`, `TRANSFI_ADAPTER_READY=""` → `rejects.toThrow(/transfi_adapter_not_ready/)` (el flag NO habilita un real a medias ni un mock silencioso). |
| "PROD sin PAYOUT_ALLOW_MOCK → throws payout_refused (default intacto)" | AC-6, §4.3 pt.4 | `stubEnv NODE_ENV=production`, `TRANSFI_API_KEY=""`, `PAYOUT_ALLOW_MOCK=""` → `rejects.toThrow(/payout_refused/)`. (Los tests existentes l.26-47 quedan verdes.) |

### 6.2 HTTP — crear `src/app/api/agents/remit-cashout-payout/invoke/route.test.ts`

`beforeEach`: `vi.stubEnv("TRANSFI_API_KEY","")` + `vi.stubEnv("ALLOW_FALLBACK_PAYOUT","true")` (mock por rama
dev en `NODE_ENV=test`). `afterEach`: `vi.unstubAllEnvs()`. `vi.hoisted` + `vi.mock("@/agents/cashout-payout",
...actual)` para el test 502. Input de referencia con PII real del beneficiario para los asserts NO-PII:
`{ quoteId:"q1", amountUsd:100, kycVerificationId:"v1", kycPayoutAllowed:true, beneficiary:{ name:"Bob",
country:"PE", method:"yape", destination:"999888777" }, idempotencyKey:"idem-1" }`.

| Test | AC / CD | Descripción |
|------|---------|-------------|
| "kycPayoutAllowed:false → 200 blocked, no ejecuta provider" | **AC-3** | `invoke({...valid, kycPayoutAllowed:false})` → `status===200`; `output.executed===false`; `output.status==="blocked"`; `output.reason==="kyc_gate_not_passed"`; `output.payoutId===null`. |
| "body válido → 200 { result } con exactamente los 8 campos, provenance mock" | AC-4, AC-6, CD-9 | `status===200`; `output = data.result ?? data`; `output.slug==="remit-cashout-payout"`; `Object.keys(output).sort()` = `["deliveredLocal","executed","payoutId","provenance","reason","slug","status","txRef"]`; `output.provenance==="local-fallback"`; `output.deliveredLocal===null`; `output.txRef===null`. |
| "el 200 NO filtra beneficiary.name/destination ni travelRuleData (NO-PII HTTP)" | **AC-4 / CD-6** | Con el input PII (`destination:"999888777"`): `expect(JSON.stringify(await res.json())).not.toContain("999888777")` + `.not.toContain("Bob")` + `.not.toContain("travelRuleData")`. |
| "idempotencia: mismo idempotencyKey → mismo payoutId" | **AC-5** | Dos `invoke(valid)` (mismo `idempotencyKey:"idem-1"`) → ambos `output.payoutId === "fallback-idem-1"` (iguales entre sí y determinísticos). |
| "PROD sin flag → 502 payout_unavailable (fail-safe default)" | **AC-6** | `stubEnv NODE_ENV=production`, `PAYOUT_ALLOW_MOCK=""`, `TRANSFI_API_KEY=""` → `status===502`; `data` deep-equals `{error:"payout_unavailable"}`. |
| "PROD + PAYOUT_ALLOW_MOCK → 200 mock a nivel HTTP" | **AC-6**, §4.3 | `stubEnv NODE_ENV=production`, `PAYOUT_ALLOW_MOCK="true"`, `TRANSFI_API_KEY=""` → `status===200`; `output.provenance==="local-fallback"`; `output.deliveredLocal===null`. |
| "input inválido (falta idempotencyKey) con beneficiary PII → 400 SIN ecoar destination" | **AC-8 / CD-6** | `invoke({...valid, idempotencyKey:undefined})` → `status===400`; `data.error==="invalid_input"`; `data.details` truthy; `expect(JSON.stringify(data)).not.toContain("999888777")` + `.not.toContain("Bob")`. |
| "body no-JSON → 400 (no 500)" | AC-8 | body `"not-json{"` → `400`; `data.error==="invalid_input"`. |
| "runCashoutPayout lanza → 502 opaco sin filtrar internals/PII" | **CD-6**, §4.6 | `runCashoutPayoutMock.mockImplementationOnce(async()=>{ throw new Error("payout_refused leak 999888777") })` → `status===502`; `data` deep-equals `{error:"payout_unavailable"}`; `not.toContain("999888777")`; `not.toContain("payout_refused")`; `data.stack` undefined. |

> **AC-1, AC-2, AC-7, AC-9** son ACs de **registro/gateway runtime** — se verifican por **smoke manual +
> evidencia** (QA F4), no por unit test en el repo del agente. Evidencia esperada (§11): fila en `a2a_agents`
> con slug `remit-cashout-payout`, `POST /discover` mostrando el slug (`agentshop-cashout-matcher` intacto),
> fila en `a2a_refund_outbox` al forzar un step 502 (AC-7), fila `charged` + `tx_hash` en `a2a_fee_splits` leg
> `creator` = `payoutWallet` (AC-9).

## 7. Plan de Implementación (Waves)

### Wave 0/W1 — Flag + endpoint + tests (código automatizable)
- [ ] W1.1: `src/agents/cashout-payout.ts` (l.48-61) → opt-in `PAYOUT_ALLOW_MOCK` en la rama prod de
  `assertPayoutProviderSafe()` (§4.3), con el comentario de seguridad money-path (CD-11). ÚNICO cambio de core.
- [ ] W1.2: `src/app/api/agents/remit-cashout-payout/invoke/route.ts` → fork de `remit-kyc-validator/invoke/
  route.ts`. Envuelve `runCashoutPayout`, `{result}` 200, 400 sin PII (§4.4), 502 `payout_unavailable` opaco.
- [ ] W1.3: `src/app/api/agents/remit-cashout-payout/invoke/route.test.ts` → 9 tests (§6.2), incl. NO-PII HTTP
  en 200/400/502, hard-gate, idempotencia, flag/fail-safe.
- [ ] W1.4: extender `src/agents/cashout-payout.test.ts` → +3 tests del flag (§6.1).
- **Verificación**: `biome check --write` por archivo → `npm test` (vitest) verde (nuevos + existentes) →
  `npm run typecheck` (`tsc --noEmit`, incl. `.test.ts`) → `npm run build` (Next compila la nueva ruta).

### Wave 2 — Docs (depende de W1)
- [ ] W2.1: `README.md` — sección "Endpoint HTTP + deploy (etapa 1 — `remit-cashout-payout`)" con la URL
  `POST /api/agents/remit-cashout-payout/invoke`, el contrato 200/400/502, la nota TransFi OFF (CD-4), la
  documentación de `PAYOUT_ALLOW_MOCK` (qué habilita, por qué es seguro, que usarlo fuera de etapa 1 es un
  incidente), y las env vars (§9). Espejo de la sección `remit-kyc-validator`.

### Wave 3 — Redeploy Vercel (MANUAL, humano vía `!` — CD-7)
- [ ] W3.1: Redeploy del **MISMO** proyecto Vercel `wasiai-remittance-agents` (agrega la ruta nueva; NO
  proyecto nuevo). Setear `PAYOUT_ALLOW_MOCK=true`. Confirmar `TRANSFI_API_KEY`/`TRANSFI_ADAPTER_READY` **sin
  setear** (CD-4).
- [ ] W3.2: `agent_url` real = `https://wasiai-remittance-agents.vercel.app/api/agents/remit-cashout-payout/invoke`.
- [ ] W3.3: Smoke directo: `curl -X POST {agent_url} -d '{"quoteId":"q1","amountUsd":100,"kycVerificationId":
  "v1","kycPayoutAllowed":true,"beneficiary":{"name":"Bob","country":"PE","method":"yape","destination":
  "999888777"},"idempotencyKey":"idem-1"}'` → `200 {result:{...provenance:"local-fallback",deliveredLocal:null,
  txRef:null}}`; verificar que la respuesta **no contiene** `999888777`/`Bob`/`travelRuleData`. Segundo curl
  igual → mismo `payoutId`. Smoke del gate: `kycPayoutAllowed:false` → `blocked`.

### Wave 4 — Registro `POST /agents` (MANUAL, humano vía `!` — CD-7)
- [ ] W4.1: `POST /agents` contra prod (Railway) con a2a-key autenticado + header `x-payment-chain:
  avalanche-fuji` + payload §10 (incl. `payoutWallet` testnet). Registrar es **gratis** (WKH-173 live).
- [ ] W4.2: Verificar `POST /discover` muestra `remit-cashout-payout` (`status:active`) sin afectar
  `agentshop-cashout-matcher` (AC-1/AC-2).

### Wave 5 — Verificación E2E del riel (MANUAL + QA)
- [ ] W5.1: `/compose` con a2a-key y `steps[0]=remit-cashout-payout` + input válido → `result` mock sin PII,
  hard-gate respetado (AC-3/AC-4/AC-6).
- [ ] W5.2: Forzar un step 502 (ej. registrar transitoriamente sin flag, o gate fallido) → verificar credit-back
  en `a2a_refund_outbox` (AC-7).
- [ ] W5.3: Verificar fila `charged` + `tx_hash` en `a2a_fee_splits` leg `creator` = `payoutWallet` (AC-9).

## 8. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| El flag abre inadvertidamente un path a desembolso real | B | **A** | §4.3: `hasReal` retorna antes de leer el flag; sin `TRANSFI_API_KEY` `getPayoutProvider()` solo puede devolver el mock; test "flag+TransFi-key-sin-ready→throws". **AR obligatorio (CD-7).** |
| Se activa `PAYOUT_ALLOW_MOCK` en un deploy que no es etapa 1 | B | **M** | Comentario de seguridad horneado (CD-11); nombre distinto de `ALLOW_FALLBACK_PAYOUT`; documentado en README como incidente; TransFi seguiría OFF (solo correría el mock, no plata real). |
| El 400/502 ecoa `beneficiary.destination` (fuga PII) | B | **A** | `flatten()` value-free; 502 body fijo + `console.warn` solo `err.name`; tests con `destination` real en 200/400/502. |
| El mock aparenta un desembolso real (CD-9) | B | **A** | `deliveredLocal`/`txRef` = `null` + `provenance:"local-fallback"` forzados por el provider; test que lo asserta; nunca renombrado. |
| El `name` no produce el slug exacto | B | A | CD-3: `name="remit-cashout-payout"` (lowercase, guiones, sin espacios). W4 verifica el slug persistido. |
| Slug ya existe (colisión) | B | M | `POST /agents` pre-check + 23505; investigar antes de re-registrar (NO tocar `agentshop-*`). |
| Redeploy pisa `remit-corridor-fx`/`remit-kyc-validator` (comparten proyecto) | B | M | Mismo deploy: la ruta se agrega, no reemplaza; smoke de las 3 rutas post-deploy. Coordinar orden con WKH-170 (PENDING-DEPLOY). |
| Regresión biome/tsc en `.test.ts` (auto-blindaje WKH-115) | M | B | `biome check --write` por archivo + `tsc --noEmit` sobre `.test.ts` en la verificación de W1. |

## 9. Env vars del deploy (Vercel, W3 — humano)

```
# Etapa 1 (payout MOCK): habilitar el mock en el deploy Vercel prod (Opción A / WKH-172):
PAYOUT_ALLOW_MOCK=true      # ← SETEAR: habilita SOLO el FallbackPayoutProvider (mock). NO habilita real.
                            #   Activarlo fuera del deploy de etapa 1 = incidente de seguridad money-path.
# PROHIBIDO en esta HU (CD-4):
# TRANSFI_API_KEY           ← NO setear
# TRANSFI_ADAPTER_READY     ← NO setear (debe quedar != "true")
# ALLOW_FALLBACK_PAYOUT     ← irrelevante en prod (la rama prod usa PAYOUT_ALLOW_MOCK, no este)
```

## 10. Payload de registro `POST /agents` (documento — NO ejecutar; humano vía `!`)

> Endpoint: `POST https://<a2a-prod-railway>/agents` · Auth: header con a2a-key autenticado (owner_ref del
> publicador — Missing Input #2) + header `x-payment-chain: avalanche-fuji`. `slug` NO se manda (se deriva de
> `name`). Registrar es **gratis** (WKH-173 live).

```json
{
  "name": "remit-cashout-payout",
  "agentUrl": "https://wasiai-remittance-agents.vercel.app/api/agents/remit-cashout-payout/invoke",
  "description": "Payout / value-delivery de remesa (USDC→PEN vía Yape/Plin/CCI). Etapa 1: desembolso MOCK determinístico (nunca mueve plata real); TransFi real en etapa 2. Requiere hard-gate KYC (kycPayoutAllowed) + idempotencyKey. El output NUNCA expone PII del beneficiario (nombre/celular/CCI ni Travel Rule).",
  "priceUsdc": 0.03,
  "capabilities": ["remittance-payout", "cashout", "value-delivery", "fiat-disbursement"],
  "payoutWallet": "0x<WALLET-EVM-CREATOR-TESTNET>",
  "discoverable": true,
  "inputSchema": {
    "type": "object",
    "properties": {
      "quoteId": { "type": "string", "minLength": 1 },
      "amountUsd": { "type": "number", "exclusiveMinimum": 0 },
      "kycVerificationId": { "type": "string", "minLength": 1 },
      "kycPayoutAllowed": { "type": "boolean" },
      "beneficiary": {
        "type": "object",
        "properties": {
          "name": { "type": "string", "minLength": 1 },
          "country": { "type": "string", "minLength": 2 },
          "method": { "type": "string", "enum": ["yape", "plin", "bank_cci"] },
          "destination": { "type": "string", "minLength": 1 }
        },
        "required": ["name", "country", "method", "destination"]
      },
      "idempotencyKey": { "type": "string", "minLength": 1 }
    },
    "required": ["quoteId", "amountUsd", "kycVerificationId", "kycPayoutAllowed", "beneficiary", "idempotencyKey"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "slug": { "type": "string" },
      "executed": { "type": "boolean" },
      "status": { "type": "string" },
      "payoutId": { "type": ["string", "null"] },
      "deliveredLocal": { "type": ["number", "null"] },
      "txRef": { "type": ["string", "null"] },
      "reason": { "type": ["string", "null"] },
      "provenance": { "type": "string" }
    }
  }
}
```

- `name` = `"remit-cashout-payout"` byte-idéntico ⇒ slug `remit-cashout-payout` (CD-3).
- `priceUsdc` = `0.03` (= `PRICE_USDC` en `cashout-payout.ts:15`).
- `payoutWallet` = wallet EVM **testnet** del creator (Missing Input #2) → habilita el leg `creator` (AC-9).
  **CD-5: testnet, nunca mainnet.**
- **Nota sobre `inputSchema` y PII (para AR):** el `inputSchema` declara los **campos** que el agente acepta
  (incluido el objeto `beneficiary`, que el core `CashoutPayoutInputSchema` exige para funcionar) — son
  **definiciones de campos, NO valores PII**. Un JSON Schema no contiene datos del beneficiario, solo su
  forma. La garantía CD-6 opera sobre los **valores** en respuestas/logs en runtime (jamás se ecoan), y el
  **`outputSchema` declara CERO campos del beneficiario / Travel Rule** (solo los 8 campos no-PII del output).
  Esto es consistente con el precedente WKH-170 (donde `legalId` es campo de input pero no de output).

## 11. Missing Inputs (residuales — gated por `!` humano, CD-7)

- [x] **#1 (fail-safe / flag) RESUELTO** = Opción A: opt-in `PAYOUT_ALLOW_MOCK` (§4.3). No bloquea F2.5/F3.
- [ ] #2: a2a-key/owner_ref del publicador + wallet EVM `payoutWallet` **testnet** del creator (§10). **Humano.**
- [ ] #3: Ejecución del redeploy Vercel (W3, mismo proyecto) con `PAYOUT_ALLOW_MOCK=true` + confirmación
  `TRANSFI_API_KEY`/`TRANSFI_ADAPTER_READY` sin setear (CD-4) + `POST /agents` (W4) con `x-payment-chain:
  avalanche-fuji`. **Humano vía `!`.**

## 12. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| — | — | Sin `[NEEDS CLARIFICATION]`. Missing Input #1 (fail-safe) RESUELTO = Opción A. Modo de pago (a2a-key) y stack (Next.js / mismo deploy) heredados de WKH-170/171. `priceUsdc=0.03` resuelto. | No |

> Boundary de confianza documentado (DT-6 / Missing Input #6, no bloqueante): el agente confía en el booleano
> `kycPayoutAllowed` provisto por el caller/pipeline, sin re-verificación server-to-server contra
> `remit-kyc-validator` (mitigación real dependería de WKH-168, Scope OUT). No es un `[NEEDS CLARIFICATION]`
> de esta HU: es una decisión heredada del scaffold, explícita.

---

## Readiness Check

```
READINESS CHECK:
[x] Cada AC tiene ≥1 archivo/prueba asociado (AC-3/4/5/6/8 → route.ts + route.test.ts + cashout-payout.test.ts; AC-1/2/7/9 → registro runtime §10/§11 + verificación manual §6/§7)
[x] Cada archivo en §4.1 tiene Exemplar verificado con Read (remit-kyc-validator route ✓, su route.test ✓, cashout-payout.ts/.test ✓, payout.ts ✓, types.ts ✓)
[x] No hay [NEEDS CLARIFICATION] pendientes (Missing Input #1 resuelto = Opción A; priceUsdc resuelto; pago/stack heredados)
[x] Constraint Directives incluyen >3 PROHIBIDO (CD-1/2/4/5/6/7/9/10/11 + no-tocar-providers + no-tocar-hard-gate + no-deps)
[x] Context Map tiene >2 archivos leídos (9 archivos con archivo:línea + 3 auto-blindaje)
[x] Scope IN y OUT explícitos y no ambiguos (§2)
[x] BD: `a2a_agents`/`a2a_fee_splits`/`a2a_refund_outbox` verificadas que existen; sin migración (DT-1)
[x] Flujo principal (Happy Path — riel completo) definido (§4.5), con el flag activo
[x] Flujo de error definido (§4.6, 4 casos), incl. el path 400 PII-safe y el 502 default sin flag
[x] Diseño del flag (§4.3) con los 4 puntos de seguridad que el AR DEBE verificar (BLOQUEANTE)
[x] PII redaction (CD-6) diseñada para 200/400/502 con test de enforcement en cada código
[x] Auto-blindaje histórico revisado: hygiene biome/tsc (WKH-114/144/115) heredada como CD; sin patrón de error recurrente ≥2 aplicable al money-path de esta HU más allá del blindaje ya horneado
```

**SDD LISTO para SPEC_APPROVED** — sin TBDs de diseño. El cambio del flag (§4.3) es la única excepción acotada
al "no tocar el core", diseñada para no habilitar jamás un desembolso real, y marcada como objeto obligatorio
del Adversary Review. Los residuales son operativos (gated por `!` humano, CD-7).

---

*SDD generado por NexusAgil — FULL — Architect F2*
