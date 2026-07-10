# SDD #169: [WKH-170] Publicar `remit-kyc-validator` como agente standalone del marketplace A2A (etapa 1 / Free-KYC)

> SPEC_APPROVED: no
> Fecha: 2026-07-10
> Tipo: feature
> SDD_MODE: full
> Branch: feat/169-wkh-170-remit-kyc-validator
> Artefactos: doc/sdd/169-wkh-170-remit-kyc-validator/
> Repos tocados: `wasiai-remittance-agents` (código nuevo) · `wasiai-a2a` (CERO código — solo registro runtime)

---

## 1. Resumen

Se construye y deploya el **endpoint HTTP** que hace invocable al agente `remit-kyc-validator` (hoy una
librería TS pura, `src/agents/kyc-validator.ts`, sin servidor) y se lo **registra** como agente REGISTRADO
y facturable en el protocolo A2A vía el mecanismo self-serve ya existente (`POST /agents`, WKH-134/143b/173).

El endpoint es una **Next.js API route** (App Router, mismo deploy Vercel `wasiai-remittance-agents` de
WKH-171 — NO un proyecto nuevo) que envuelve `runKycValidator` + `KycInputSchema`
(`src/agents/kyc-validator.ts`) + `FallbackKycProvider` (`src/providers/kyc.ts`), honra el contrato A2A
`POST /invoke → 200 { result: {...} }` (legible por `data.result ?? data` en `compose.ts`), responde `400`
estructurado si el body falla Zod, y `502` opaco si el provider falla.

**Diferencia estructural vs WKH-171:** el scaffold Next 14 (`package.json`, `tsconfig.json` con alias
`@/*→src/*`, `next.config.mjs`, `src/app/layout.tsx`, `src/app/page.tsx`, `vitest.config.ts`) **YA EXISTE**
(entregado por WKH-171, verificado en disco). Esta HU **NO** repite la Wave de scaffolding: solo agrega
la ruta `remit-kyc-validator/invoke/` al mismo proyecto.

**El eje crítico de esta HU es la redacción de PII (CD-6 / AC-3 / AC-7):** el output HTTP en TODOS los
códigos (200/400/502) NUNCA puede exponer `legalId` (DNI) ni `travelRuleData`. El core ya está blindado
(`runKycValidator` devuelve solo 7 campos sin PII, testeado en `kyc-validator.test.ts:16-22`); el riesgo
nuevo vive en el **wrapper HTTP**: el path de error 400 no debe ecoar el `legalId` recibido, y el 502 no
debe filtrar `err.message`/body.

**Decisiones ratificadas por el humano (heredadas de WKH-171 — NO se reabren):**
1. **Modo de pago = a2a-key prepago** → `wasiai-a2a` queda con **CERO código nuevo**. Riel a probar:
   discover → debitar budget del a2a-key → invocar → fee-split creator (1% a `payoutWallet`).
2. **Stack = Next.js API route en el MISMO deploy Vercel `wasiai-remittance-agents`** (no proyecto nuevo).
3. **Etapa 1 = Free-KYC / fallback simulado** — Didit real + AML OFF (`DIDIT_API_KEY`/`DIDIT_ADAPTER_READY`
   sin setear).

Resultado esperado: `remit-kyc-validator` aparece en `POST /discover` como `status: active`, es invocable
vía `/compose` con a2a-key, verifica 100% por `FallbackKycProvider` (`provenance:"local-fallback"`), expone
`payoutAllowed` (inerte — sin consumidor de payout hasta Fase A/WKH-168) y liquida el leg `creator` del
protocol fee a su `payoutWallet` — en paralelo al demo `agentshop-kyc-validator`, que queda intacto.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 169 (WKH-170) |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Objetivo** | Hacer invocable + registrar `remit-kyc-validator` (endpoint HTTP nuevo + `POST /agents`) probando el riel discover→pagar(a2a-key)→invocar→fee-split, con garantía dura de NO-PII en toda respuesta HTTP, sin tocar el demo ni el core money-path del gateway. |
| **Reglas de negocio** | Slug byte-idéntico `remit-kyc-validator`; verificación 100% `FallbackKycProvider`; Didit/AML OFF; `payoutAllowed` fail-safe e inerte; NO-PII en 200/400/502; testnet-only; mutaciones de infra/prod gated por `!` humano. |
| **Scope IN** | `wasiai-remittance-agents`: invoke route + tests + sección README + redeploy Vercel (mismo proyecto). `wasiai-a2a`: 1 llamada runtime `POST /agents` (sin código). |
| **Scope OUT** | `wasiai-agentshop`/`agentshop-kyc-validator`; `orchestrate.ts`/core `compose.ts`; Didit adapter + AML real; `remit-corridor-fx`/`remit-cashout-payout`; wiring de `payoutAllowed` a un gate de payout real (value-delivery/`remittance_intents` = Fase A/WKH-168); mainnet; migraciones DB; reabrir el modo de pago (x402-anónimo/`payTo`). |
| **Missing Inputs** | #1 (a2a-key/owner_ref publicador + `payoutWallet` testnet) y #2 (redeploy Vercel + confirmación Didit OFF + `POST /agents` prod) = pasos manuales gated por `!` (§11). #3 (`priceUsdc`) resuelto = `0.02`. #4 (modo pago/stack) resuelto por WKH-171. |

### Acceptance Criteria (EARS)

- **AC-1**: WHEN un caller consulta `POST /discover` (o `GET /agents/remit-kyc-validator/agent-card`) en
  `wasiai-a2a`, THE system SHALL devolver `remit-kyc-validator` como agente activo (`status: active`,
  `enabled: true`), distinto y sin reemplazar a `agentshop-kyc-validator`.
- **AC-2**: WHEN se registra `remit-kyc-validator` vía `POST /agents`, THE system SHALL persistir una fila
  NUEVA en `a2a_agents` con slug EXACTO `remit-kyc-validator` (idéntico al `SLUG` exportado por
  `src/agents/kyc-validator.ts`), sin modificar ninguna fila `agentshop-*`.
- **AC-3**: WHEN se invoca `remit-kyc-validator` con input válido, THE system SHALL responder `200` con un
  body cuyo `result` contenga EXCLUSIVAMENTE `slug`, `approved`, `riskLevel`, `reasons`, `verificationId`,
  `provenance`, `payoutAllowed` — y SHALL NUNCA incluir `legalId` ni `travelRuleData` (ni en claro ni
  anidados) en ninguna respuesta HTTP (200/400/502).
- **AC-4**: WHILE `DIDIT_API_KEY`/`DIDIT_ADAPTER_READY` permanezcan sin configurar, THE system SHALL servir
  toda verificación exclusivamente vía `FallbackKycProvider` (`provenance: "local-fallback"`), nunca
  intentar el adapter Didit.
- **AC-5**: IF el `provenance` de la verificación no pertenece al conjunto de proveniencias reales
  (`"didit"`) Y el deploy corre en producción (`NODE_ENV==='production'`), THEN THE system SHALL devolver
  `payoutAllowed: false` sin excepción, sin importar `ALLOW_FALLBACK_KYC`.
- **AC-6**: WHEN el endpoint HTTP recibe `POST` con un body válido, THE system SHALL responder `200` con un
  body legible por `data.result ?? data` (contrato `compose.ts`), consistente con `remit-corridor-fx`.
- **AC-7**: IF el body del request falla la validación Zod (ej. falta `senderCountry`), THEN THE system
  SHALL responder `400` con un error estructurado que NO ecoe el valor de `legalId` recibido, nunca un 500.
- **AC-8**: WHEN un pipeline cuyo `steps[0]` es `remit-kyc-validator` completa con éxito Y el agente declaró
  `payoutWallet`, THE system SHALL liquidar el leg `creator` del protocol fee (1%) a esa wallet vía el
  mecanismo existente de `fee-split.ts`/`agent-split-context.ts`, auditable en `a2a_fee_splits`.

## 3. Context Map (Codebase Grounding)

### Archivos leídos
| Archivo | Por qué | Patrón / hallazgo extraído |
|---------|---------|-----------|
| `wasiai-remittance-agents/src/agents/kyc-validator.ts` | **Core a envolver** | `runKycValidator(raw: unknown): Promise<KycAgentOutput>` parsea con `KycInputSchema` (throws ZodError), llama `getKycProvider().verify()`, retorna `{slug, approved, riskLevel, reasons, verificationId, provenance, payoutAllowed}` — **SIN** `legalId`/`travelRuleData` (BLQ-MED-1 resuelto, líneas 28-33/87-88). `SLUG="remit-kyc-validator"` (l.13), `PRICE_USDC=0.02` (l.14). `isPayoutAllowed()` (l.56-69) = gate fail-safe. `KycInputSchema` (l.16-24) exportado. |
| `wasiai-remittance-agents/src/providers/kyc.ts` | Provider KYC | `getKycProvider()` (l.103-113): sin `DIDIT_API_KEY` → `FallbackKycProvider` (`provenance:"local-fallback"`, l.74). Con key pero `DIDIT_ADAPTER_READY!=='true'` → **lanza** `didit_adapter_not_ready` (fail-loud, l.106-110). `FallbackKycProvider.verify` (l.59-77) es determinístico, nunca lanza con input válido. `buildTravelRule` (l.79-88) arma el PII que queda del lado del provider (NO se propaga al output). |
| `wasiai-remittance-agents/src/providers/types.ts` | Contrato KYC | `KycResult` = `{approved, riskLevel, reasons, travelRuleData:{originator:{name,country,legalId}, beneficiary:{...}}, verificationId, provenance}`. `KycAgentOutput` (en kyc-validator.ts) EXCLUYE `travelRuleData`. Confirma qué campos son PII (`travelRuleData`, `legalId`). |
| `wasiai-remittance-agents/src/agents/kyc-validator.test.ts` | Patrón de test + evidencia NO-PII core | vitest; `vi.stubEnv("DIDIT_API_KEY","")` = fallback. `expect(JSON.stringify(out)).not.toContain("12345678")` (DNI) + `expect(Object.keys(out)).not.toContain("travelRuleData")` (l.19-20). Cubre las 3 combinaciones del fail-safe (l.28-52). **Este es el espejo core del test HTTP nuevo.** |
| `wasiai-remittance-agents/src/app/api/agents/remit-corridor-fx/invoke/route.ts` | **Exemplar principal del endpoint** (VERIFICADO ✓) | `import {NextRequest,NextResponse} from "next/server"`; `const parsed = InputSchema.safeParse(await req.json().catch(()=>null)); if(!parsed.success) return NextResponse.json({error:"invalid_input",details:parsed.error.flatten()},{status:400})`; `try{ const result = await runX(parsed.data); return NextResponse.json({result},{status:200}) } catch(err){ console.warn(...{errorName}); return NextResponse.json({error:"..._unavailable"},{status:502}) }`. Alias `@/agents/...`. |
| `wasiai-remittance-agents/src/app/api/agents/remit-corridor-fx/invoke/route.test.ts` | **Exemplar del test** (VERIFICADO ✓) | `vi.hoisted` + `vi.mock("@/agents/...", ...actual)` para forzar throw del core en el test 502 sin tocar el core; `POST(new NextRequest(url,{method:"POST",body:JSON.stringify(...)}))`; `const output = data.result ?? data` (contrato compose); test 502 asserta `not.toContain("secret")` + `data.stack toBeUndefined()`. |
| `wasiai-remittance-agents/README.md` | Contrato HTTP (CD-7) + sección espejo | §"Endpoint HTTP + deploy (etapa 1 — `remit-corridor-fx`)" (l.58-92) es el molde de la nueva sección KYC. Contrato: `POST /invoke → 200 {result} / 400 invalid_input / 502`. Dev port `3030`. |
| `wasiai-remittance-agents/tsconfig.json` + `next.config.mjs` + `src/app/{layout,page}.tsx` + `vitest.config.ts` | **Scaffold — verificado que YA EXISTE** | `tsconfig` con `paths:{"@/*":["./src/*"]}`; `vitest.config.ts` con alias `@`; `next.config.mjs`, `layout.tsx`, `page.tsx` presentes. **NO se re-scaffolda** (diferencia clave vs WKH-171). |
| `wasiai-a2a/doc/sdd/167-wkh-171-remit-corridor-fx/sdd.md` | Precedente directo (mismo patrón) | §4.3 diseño del endpoint, §10 payload `POST /agents`, derivación de slug (`agent.ts:337`: `name.toLowerCase().replace(/\s+/g,'-')`), contrato `data.result ?? data` (compose.ts:892-893), `PublishAgentInput` (types/index.ts:118). Todo verificado en WKH-171 (DONE) — se hereda sin re-verificar código de `wasiai-a2a` (CERO código nuevo acá). |

### Exemplars
| Para crear | Seguir patrón de | Razón |
|-----------|------------------|-------|
| `src/app/api/agents/remit-kyc-validator/invoke/route.ts` | `remit-corridor-fx/invoke/route.ts` (VERIFICADO ✓) | Mismo patrón exacto: `safeParse`→400 estructurado, core→`{result}` 200, catch→502 opaco. Se cambia `CorridorFxInputSchema/runCorridorFx` por `KycInputSchema/runKycValidator` y el código de error 502 a `verification_unavailable`. |
| `src/app/api/agents/remit-kyc-validator/invoke/route.test.ts` | `remit-corridor-fx/invoke/route.test.ts` (VERIFICADO ✓) + `kyc-validator.test.ts` (NO-PII) | Contract tests con `vi.mock` del core + tests NO-PII a nivel HTTP (200 y 400). |
| Payload `POST /agents` (§10, doc, NO código) | `PublishAgentInput` (WKH-171 SDD §10, VERIFICADO en DONE) | Campos exactos + derivación de slug desde `name` + `outputSchema` SIN campos PII. |

### Estado de BD relevante
| Tabla | Existe | Columnas relevantes | Cambios |
|-------|--------|---------------------|---------|
| `a2a_agents` (`wasiai-a2a`) | Sí | `slug` (PK), `name`, `agent_url`, `price_usdc`, `capabilities` (JSONB), `metadata` (JSONB), `payout_wallet`, `referrer_ref`, `enabled`, `owner_ref` | **NINGUNO** — solo se INSERTA 1 fila vía `POST /agents` runtime (DT-1). Sin migración. |
| `a2a_fee_splits` | Sí | leg `creator` + `status` + `tx_hash` | Solo lectura (evidencia de AC-8). |

### Componentes reutilizables encontrados
- `runKycValidator` / `getKycProvider` / `KycInputSchema` / `isPayoutAllowed` / `FallbackKycProvider` —
  **ya implementados y testeados** (incl. NO-PII y fail-safe). El endpoint SOLO los envuelve; **NO se
  reimplementa lógica KYC ni el gate** (DT-4).
- El scaffold Next 14 completo — **ya existe** (WKH-171). No se crea nada de infra de proyecto.
- El pipeline de discovery/fee-split del gateway ya mergea filas `a2a_agents` — **cero código nuevo** en
  `wasiai-a2a` (DT-1).

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar (`wasiai-remittance-agents`)

| Archivo | Acción | Qué hace | Exemplar |
|---------|--------|----------|----------|
| `src/app/api/agents/remit-kyc-validator/invoke/route.ts` | **Crear** | Endpoint principal. Envuelve `runKycValidator`, `{result}` 200, 400 sin PII, 502 opaco. Ver §4.3. | `remit-corridor-fx/invoke/route.ts` |
| `src/app/api/agents/remit-kyc-validator/invoke/route.test.ts` | **Crear** | Contract tests (AC-3/4/5/6/7) incl. 2 tests NO-PII a nivel HTTP (200 y 400). Ver §6. | `remit-corridor-fx/invoke/route.test.ts` + `kyc-validator.test.ts` |
| `README.md` | Modificar (menor) | Nueva sección "Endpoint HTTP + deploy (etapa 1 — `remit-kyc-validator`)", espejo de la de `remit-corridor-fx`. | `README.md` §l.58-92 |

> `src/agents/kyc-validator.ts`, `src/providers/*`, y todo el scaffold (`package.json`, `tsconfig.json`,
> `next.config.mjs`, `src/app/{layout,page}.tsx`, `vitest.config.ts`) = **NO se tocan** (ya listos, DT-4/DT-5).

### 4.2 Modelo de datos
N/A. Sin cambios de schema (DT-1). Solo INSERT runtime de 1 fila en `a2a_agents` vía `POST /agents` (§10,
paso manual gated por `!`).

### 4.3 Endpoint — diseño (sin código)

Handler `POST` en `src/app/api/agents/remit-kyc-validator/invoke/route.ts`:

1. `const parsed = KycInputSchema.safeParse(await req.json().catch(() => null))`
   — importar `KycInputSchema` desde `@/agents/kyc-validator` (reusar el mismo schema, **NO duplicar**).
2. **Si `!parsed.success` → 400 SIN PII (AC-7 / CD-6, path crítico):**
   `return NextResponse.json({ error: "invalid_input", details: parsed.error.flatten() }, { status: 400 })`.
   - **Justificación PII-safe:** `ZodError.flatten()` devuelve `{ formErrors: string[], fieldErrors:
     { <campo>: string[] } }` donde los valores son **mensajes de validación de Zod** (ej. `"Required"`,
     `"String must contain at least 2 character(s)"`, `"Expected string, received number"`) — **por diseño
     NO incluye el valor recibido** del campo. Para `KycInputSchema` (solo `.min()`/`.positive()`/tipos
     básicos, sin `.refine`/`.superRefine` con mensajes custom que interpolen el valor), `flatten()` es
     **provablemente libre de PII**: nunca ecoa `legalId` ni ningún valor de input.
   - **PROHIBIDO en este path (CD-6, blindaje explícito para el Dev):**
     - NO devolver `parsed.data` ni el body crudo (`await req.json()`) en el response.
     - NO devolver `parsed.error` crudo / `parsed.error.issues` con transformación custom que interpole
       valores, ni `parsed.error.message` concatenado con el input.
     - NO agregar mensajes custom en `KycInputSchema` que interpolen el valor (ej. ``.min(1, `bad ${val}`)``).
       El schema se reutiliza tal cual (está en el core, no se modifica — DT-4).
   - El test de CD-6 (§6) es la enforcement dura: enviar un body con `legalId:"12345678"` válido pero
     otro campo inválido → `400` cuyo body JSON **no contiene** `"12345678"`.
3. **200 happy path:** `try { const result = await runKycValidator(parsed.data); return
   NextResponse.json({ result }, { status: 200 }) }` — envolver en `{ result }` (AC-6, contrato
   `compose.ts data.result ?? data`). El core ya garantiza que `result` es `KycAgentOutput` (7 campos, sin
   PII — DT-4).
4. **502 catch (opaco, sin PII/internals — CD-6):** `catch (err)`: el core puede lanzar por
   `getKycProvider()` misconfig (`didit_adapter_not_ready` — no debería ocurrir con Didit OFF, CD-4) o un
   error inesperado del provider. Responder `502` con body **fijo** `{ error: "verification_unavailable" }`
   + `console.warn("[remit-kyc-validator] verify failed:", { errorName: err instanceof Error ? err.name :
   "unknown" })` (patrón `remit-corridor-fx`, solo `err.name`, **sin `err.message`, sin stack, sin input**).
   **Nunca un 500 sin manejar.**
5. **Sin receipt EIP-712** (este repo no tiene `agent-signer`; opcional en el contrato, sin AC que lo exija).
6. **Sin lógica de pago/x402/on-chain** en el endpoint (lo hace el gateway a2a).

> Nota HTTP: `runKycValidator` reparsea internamente con el mismo `KycInputSchema` (idempotente); el
> `safeParse` en el route es para el 400 estructurado (la ZodError cruda no da un body limpio). No es doble
> validación problemática.

### 4.4 Flujo principal (Happy Path — riel completo)

1. Caller con **a2a-key** invoca `POST /compose` (o `/orchestrate`) en `wasiai-a2a` con
   `steps[0]=remit-kyc-validator` + input `{ senderName, senderCountry, legalId, amountUsd, receiverName,
   receiverCountry, purpose }`.
2. Gateway hace discovery → encuentra la fila `a2a_agents` (`status:active`, `invokeUrl` = deploy Vercel).
3. Gateway **debita** el `price_usdc` (0.02) del budget del a2a-key (ledger interno, no on-chain per-call).
4. Gateway hace `POST {invokeUrl}` con el input → endpoint responde `200 { result: { slug, approved,
   riskLevel, reasons, verificationId, provenance:"local-fallback", payoutAllowed } }` (SIN PII).
5. Gateway lee `data.result` (contrato compose), continúa el pipeline.
6. Al completar con éxito, cobra el 1% protocol fee y **liquida el leg `creator`** a `payout_wallet` → fila
   en `a2a_fee_splits` (AC-8).

**`payoutAllowed` — inerte (documentado):** el campo se calcula por `isPayoutAllowed()` (fail-safe) y se
expone en el `result`, pero **hoy NO tiene consumidor**: `wasiai-a2a` no lo lee para gatear ningún payout
real (el value-delivery/`remittance_intents` es Fase A / WKH-168, Scope OUT). Esta HU solo garantiza que se
calcula y expone **correctamente** (AC-5). En etapa 1 (fallback, prod) `payoutAllowed` será siempre `false`.

### 4.5 Flujo de error

1. Body inválido (falta `senderCountry`/`legalId`/etc., o no-JSON) → `400 {error:"invalid_input", details}`
   **sin ecoar el `legalId` recibido** (AC-7/CD-6). El gateway ve el 4xx y aborta/reembolsa el step.
2. Provider misconfig (`getKycProvider()` lanza `didit_adapter_not_ready` — solo si alguien viola CD-4) →
   catch → `502 {error:"verification_unavailable"}` opaco (no 500, no leak de `err.message`).
3. Caller **sin a2a-key** (x402 anónimo) → gateway lanza `No payTo address...` (esperado, heredado de
   WKH-171, fuera de scope).

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir
- **CD-3 (heredado)**: slug byte-idéntico `remit-kyc-validator`. En el registro, `name` =
  `"remit-kyc-validator"` EXACTO (la derivación `name.toLowerCase().replace(/\s+/g,'-')` produce ese slug).
  NO usar `name` con espacios/mayúsculas.
- **CD-6 (heredado, eje crítico)**: ningún response HTTP (200/400/502) puede contener `legalId` ni
  `travelRuleData` en ningún nivel. El 400 usa **solo** `parsed.error.flatten()` (mensajes Zod, value-free)
  — NO `parsed.data`, NO el body crudo, NO mensajes custom que interpolen valores. El 502 es body fijo
  `{error:"verification_unavailable"}` + `console.warn` con **solo** `err.name`. DEBE existir ≥1 test que lo
  verifique a nivel HTTP en el 200 **y** en el 400 (input con `legalId` real → assert que no aparece).
- **CD-7/CD-8 (heredado)**: endpoint responde `200 { result: {...} }` (envuelto), legible por
  `data.result ?? data`. Contrato idéntico a `remit-corridor-fx`.
- Reusar `KycInputSchema` y `runKycValidator` de `@/agents/kyc-validator` (alias `@/*`→`src/*`, ya
  configurado). NO duplicar el schema ni la lógica KYC.
- El scaffold Next ya existe: NO tocar `package.json`/`tsconfig.json`/`next.config.mjs`/`layout.tsx`/
  `page.tsx`/`vitest.config.ts`. Solo se agrega la carpeta `remit-kyc-validator/invoke/`.
- *(blindaje histórico WKH-133, heredado de WKH-171 §5)*: todo `Number()`/monto sobre dato externo va
  guardado. Acá no hay aritmética nueva en el route (el core ya lo maneja); no introducir ninguna.

### PROHIBIDO
- **CD-1**: NO tocar NINGÚN archivo de `wasiai-agentshop` / `agentshop-kyc-validator` ni su registro/slug.
- **CD-2**: NO tocar `wasiai-a2a` (CERO código: ni `orchestrate.ts`, ni core `compose.ts`, ni
  `agent.ts`/`agents.ts`/`types`). El registro es 100% runtime (`POST /agents`).
- **CD-4**: NO setear/activar `DIDIT_API_KEY` ni `DIDIT_ADAPTER_READY=true` en el deploy (Didit/AML =
  etapa 2 / Fase A). El deploy debe correr con ambas env vars **sin setear**.
- **CD-5**: testnet-only — `payoutWallet` debe ser wallet EVM **testnet** (Kite/Avalanche/Base testnet).
  Ninguna referencia a mainnet en deploy/registro.
- **CD-6** (ver OBLIGATORIO arriba): NO ecoar PII en ningún response HTTP.
- **CD-7**: mutaciones de infra/prod (redeploy Vercel del mismo proyecto, `POST /agents` contra prod,
  `payoutWallet`) las ejecuta el **humano vía `!`**. El pipeline automatizado NO las corre.
- NO agregar deps nuevas (Next/React ya están). NO agregar `@supabase/*`, `viem`, ni SDK de pago al repo.
- NO agregar receipt EIP-712 / `agent-signer` (fuera de scope).
- NO modificar `src/agents/kyc-validator.ts` ni `src/providers/*` (ya listos y testeados).
- NO agregar consumidor/wiring de `payoutAllowed` a ningún gate de payout (Fase A / WKH-168, Scope OUT).

## 6. Test Plan

Framework: **vitest** (ya en el repo). Los tests corren en fallback (Didit OFF) — sin red real. Se
mockea el core con `vi.hoisted` + `vi.mock("@/agents/kyc-validator", ...actual)` (patrón exacto de
`remit-corridor-fx/invoke/route.test.ts`) para poder forzar el throw del 502 sin tocar el core.

`beforeEach`: `vi.stubEnv("DIDIT_API_KEY", "")` (fuerza fallback). `afterEach`: `vi.unstubAllEnvs()`.
Input válido de referencia (con PII real para los asserts NO-PII): `{ senderName:"Alice",
senderCountry:"US", legalId:"12345678", amountUsd:100, receiverName:"Bob", receiverCountry:"PE",
purpose:"family support" }`.

| Test | AC / CD que cubre | Descripción |
|------|-------------------|-------------|
| "body válido → 200 { result } legible por data.result, solo los 7 campos" | AC-6, AC-3 | `POST(new NextRequest(url,{method:"POST",body:JSON.stringify(validInput)}))` → `status===200`; `const output = data.result ?? data`; `output.slug==="remit-kyc-validator"`; `Object.keys(output)` = exactamente `{slug, approved, riskLevel, reasons, verificationId, provenance, payoutAllowed}` (assert que NO tiene otras keys). |
| "el 200 NO filtra legalId/DNI ni travelRuleData (NO-PII HTTP)" | **AC-3 / CD-6** | Con `validInput` (legalId `"12345678"`): `expect(JSON.stringify(await res.json())).not.toContain("12345678")` + `.not.toContain("travelRuleData")`. Espejo HTTP de `kyc-validator.test.ts:19-20`. |
| "Didit OFF → provenance local-fallback" | AC-4 | Sin `DIDIT_API_KEY` → `output.provenance === "local-fallback"` (nunca `"didit"`). |
| "PROD + fallback → payoutAllowed false (fail-safe, HTTP)" | AC-5 | `vi.stubEnv("NODE_ENV","production")` + `vi.stubEnv("ALLOW_FALLBACK_KYC","true")` → `output.payoutAllowed === false`. Espejo HTTP de `kyc-validator.test.ts:46-52`. |
| "input inválido (falta senderCountry) con legalId real → 400 SIN ecoar el legalId" | **AC-7 / CD-6** | `POST` con `{...validInput, senderCountry: undefined}` (legalId `"12345678"` presente) → `status===400`; `data.error==="invalid_input"`; `data.details` truthy; **`expect(JSON.stringify(data)).not.toContain("12345678")`** (no ecoa el DNI). |
| "body no-JSON → 400 (no 500)" | AC-7 | `POST` con body `"not-json{"` → `400`; `data.error==="invalid_input"` (por `.catch(()=>null)` + safeParse). |
| "runKycValidator lanza → 502 { error: verification_unavailable } sin filtrar internals/PII" | CD-6, §4.5 | `runKycValidatorMock.mockImplementationOnce(async()=>{ throw new Error("didit_adapter_not_ready leak 99887766") })` → `status===502`; `data` deep-equals `{error:"verification_unavailable"}`; `not.toContain("99887766")`; `not.toContain("didit_adapter_not_ready")`; `data.stack` undefined. |

> **AC-1, AC-2, AC-8** son ACs de **registro/gateway runtime** — se verifican por **smoke manual +
> evidencia** (QA F4), no por unit test en el repo del agente. Evidencia esperada (§11): fila en
> `a2a_agents` con slug `remit-kyc-validator`, `POST /discover` mostrando el slug (`agentshop-kyc-validator`
> intacto), fila `charged` + `tx_hash` en `a2a_fee_splits` leg `creator` = `payoutWallet`.

## 7. Plan de Implementación (Waves)

> **Nota:** NO hay Wave de scaffolding (a diferencia de WKH-171): el scaffold Next ya existe. W0 y W1 se
> colapsan en "endpoint + tests".

### Wave 0/W1 — Endpoint + tests (código automatizable)
- [ ] W1.1: `src/app/api/agents/remit-kyc-validator/invoke/route.ts` → Exemplar:
  `remit-corridor-fx/invoke/route.ts`. Envuelve `runKycValidator`, `{result}` 200, 400 sin PII (§4.3.2),
  502 `verification_unavailable` opaco.
- [ ] W1.2: `src/app/api/agents/remit-kyc-validator/invoke/route.test.ts` → 7 tests (§6), incl. los 2
  NO-PII HTTP (200 y 400) exigidos por CD-6.
- **Verificación**: `npm test` (vitest) verde — tests nuevos + los existentes de agents/providers intactos
  — + `npm run typecheck` (`tsc --noEmit`) + `npm run build` (Next compila la nueva ruta).

### Wave 2 — Docs (depende de W1)
- [ ] W2.1: `README.md` — sección "Endpoint HTTP + deploy (etapa 1 — `remit-kyc-validator`)" con la URL
  `POST /api/agents/remit-kyc-validator/invoke`, el contrato 200/400/502, la nota Didit OFF (CD-4) y las
  env vars (§9). Espejo de la sección `remit-corridor-fx` (l.58-92).
- **Verificación**: consistencia con el contrato.

### Wave 3 — Redeploy Vercel (MANUAL, humano vía `!` — CD-7)
- [ ] W3.1: Redeploy del **MISMO** proyecto Vercel `wasiai-remittance-agents` (agrega la ruta nueva; NO
  proyecto nuevo). Confirmar `DIDIT_API_KEY`/`DIDIT_ADAPTER_READY` **sin setear** (CD-4).
- [ ] W3.2: `agent_url` real = `https://wasiai-remittance-agents.vercel.app/api/agents/remit-kyc-validator/invoke`.
- [ ] W3.3: Smoke directo: `curl -X POST {agent_url} -d '{"senderName":"Alice","senderCountry":"US",
  "legalId":"12345678","amountUsd":100,"receiverName":"Bob","receiverCountry":"PE","purpose":"family"}'`
  → `200 {result:{...provenance:"local-fallback", payoutAllowed:false}}` y verificar que la respuesta **no
  contiene** `12345678` ni `travelRuleData`.

### Wave 4 — Registro `POST /agents` (MANUAL, humano vía `!` — CD-7)
- [ ] W4.1: `POST /agents` contra prod (Railway) con a2a-key autenticado + header `x-payment-chain:
  avalanche-fuji` + payload §10 (incl. `payoutWallet` testnet). Registrar es **gratis** (WKH-173 live).
- [ ] W4.2: Verificar `POST /discover` muestra `remit-kyc-validator` (`status:active`) sin afectar
  `agentshop-kyc-validator` (AC-1/AC-2).

### Wave 5 — Verificación E2E del riel (MANUAL + QA)
- [ ] W5.1: Invocar `/compose` con a2a-key y `steps[0]=remit-kyc-validator` + input KYC → `result` sin PII
  (AC-3/AC-6).
- [ ] W5.2: Verificar fila `charged` + `tx_hash` en `a2a_fee_splits` leg `creator` = `payoutWallet` (AC-8).

## 8. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| El 400 ecoa el `legalId` recibido (fuga de PII) | B | **A** | `flatten()` es value-free por diseño de Zod; CD-6 prohíbe ecoar `parsed.data`/body/mensajes custom; test dedicado con legalId real asserta que no aparece en el body 400. |
| El 502 filtra `err.message`/stack con datos del input | B | **A** | Body fijo `{error:"verification_unavailable"}`; `console.warn` solo con `err.name`; test con mensaje-trampa (`99887766`) asserta que no aparece. |
| El `name` en el registro no produce el slug exacto | B | A | CD-3: `name="remit-kyc-validator"` (ya lowercase, con guiones, sin espacios). W4 verifica el slug persistido. |
| Slug ya existe (colisión) | B | M | `POST /agents` pre-check + 23505; si existe, investigar antes de re-registrar (NO tocar `agentshop-*`). |
| `payoutAllowed` interpretado como gate activo | B | M | Documentado como inerte (§4.4); Scope OUT prohíbe wirearlo. |
| Redeploy pisa `remit-corridor-fx` (comparten proyecto) | B | M | Es el MISMO deploy: la ruta nueva se agrega, no reemplaza; smoke de ambas rutas post-deploy. Coordinar orden si ambos redeploys están pendientes (logística, no técnico). |

## 9. Env vars del deploy (Vercel, W3 — humano)

```
# Etapa 1 (Free-KYC / fallback): NINGUNA env var de KYC es necesaria.
# PROHIBIDO en esta HU (CD-4):
# DIDIT_API_KEY         ← NO setear
# DIDIT_ADAPTER_READY   ← NO setear (debe quedar != "true")
# ALLOW_FALLBACK_KYC    ← NO setear en prod (irrelevante: en NODE_ENV=production el fail-safe lo ignora)
# AGENT_SIGNER_PRIVATE_KEY ← NO necesario (sin receipt en etapa 1)
```

## 10. Payload de registro `POST /agents` (documento — NO ejecutar; humano vía `!`)

> Endpoint: `POST https://<a2a-prod-railway>/agents` · Auth: header con a2a-key autenticado (owner_ref del
> publicador — Missing Input #1) + header `x-payment-chain: avalanche-fuji`. `slug` NO se manda (se deriva
> de `name`). Registrar es **gratis** (WKH-173 live: `requireA2AKey()` auth-only, sin débito).

```json
{
  "name": "remit-kyc-validator",
  "agentUrl": "https://wasiai-remittance-agents.vercel.app/api/agents/remit-kyc-validator/invoke",
  "description": "Validación KYC/AML de remesa (identidad + screening + Travel Rule). Etapa 1 Free-KYC / fallback determinístico; Didit real en etapa 2. El output NUNCA expone PII (DNI/Travel Rule).",
  "priceUsdc": 0.02,
  "capabilities": ["kyc-verification", "aml-screening", "travel-rule", "remittance-compliance"],
  "payoutWallet": "0x<WALLET-EVM-CREATOR-TESTNET>",
  "discoverable": true,
  "inputSchema": {
    "type": "object",
    "properties": {
      "senderName": { "type": "string", "minLength": 1 },
      "senderCountry": { "type": "string", "minLength": 2 },
      "legalId": { "type": "string", "minLength": 1 },
      "amountUsd": { "type": "number", "exclusiveMinimum": 0 },
      "receiverName": { "type": "string", "minLength": 1 },
      "receiverCountry": { "type": "string", "minLength": 2 },
      "purpose": { "type": "string", "minLength": 1 }
    },
    "required": ["senderName", "senderCountry", "legalId", "amountUsd", "receiverName", "receiverCountry", "purpose"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "slug": { "type": "string" },
      "approved": { "type": "boolean" },
      "riskLevel": { "type": "string", "enum": ["low", "medium", "high"] },
      "reasons": { "type": "array", "items": { "type": "string" } },
      "verificationId": { "type": "string" },
      "provenance": { "type": "string" },
      "payoutAllowed": { "type": "boolean" }
    }
  }
}
```

- `name` = `"remit-kyc-validator"` byte-idéntico ⇒ slug `remit-kyc-validator` (CD-3).
- `priceUsdc` = `0.02` (= `PRICE_USDC` en `kyc-validator.ts:14`).
- `payoutWallet` = wallet EVM **testnet** del creator (Missing Input #1, aporta el humano) → habilita el
  leg `creator` del split (AC-8). **CD-5: testnet, nunca mainnet.**
- `inputSchema` = campos de `KycInputSchema` (`kyc-validator.ts:16-24`). `legalId` **es input** (se envía al
  agente para verificar), pero **NO aparece en `outputSchema`**.
- `outputSchema` = campos de `KycAgentOutput` (`kyc-validator.ts:34-43`) — **SIN `legalId` ni
  `travelRuleData`** (CD-6). El schema declarado al marketplace refleja el contrato NO-PII.

## 11. Missing Inputs (residuales — gated por `!` humano, CD-7)

- [ ] a2a-key/owner_ref del publicador (para W4.1). **Humano.**
- [ ] Wallet EVM `payoutWallet` **testnet** del creator (para el payload §10). **Humano.**
- [ ] Ejecución del redeploy Vercel (W3, mismo proyecto) + confirmación `DIDIT_API_KEY`/`DIDIT_ADAPTER_READY`
  sin setear (CD-4) + `POST /agents` (W4) con header `x-payment-chain: avalanche-fuji`. **Humano vía `!`.**

## 12. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| — | — | Sin `[NEEDS CLARIFICATION]`. Modo de pago (a2a-key) y stack (Next.js / mismo deploy) heredados de WKH-171. `priceUsdc=0.02` resuelto. | No |

> Los items de §11 NO son `[NEEDS CLARIFICATION]` de diseño: son valores operativos (a2a-key/wallet/deploy)
> que por política (CD-7) los provee/ejecuta el humano en las waves manuales. No bloquean F2.5/F3 (la
> construcción del endpoint + tests no los necesita).

---

## Readiness Check

```
READINESS CHECK:
[x] Cada AC tiene ≥1 archivo asociado (AC-3/4/5/6/7 → route.ts + route.test.ts; AC-1/2/8 → registro runtime §10/§11 + verificación manual)
[x] Cada archivo en §4.1 tiene Exemplar verificado con Read (remit-corridor-fx route ✓, su route.test ✓, kyc-validator.test ✓)
[x] No hay [NEEDS CLARIFICATION] pendientes (decisiones heredadas de WKH-171 + priceUsdc resuelto)
[x] Constraint Directives incluyen >3 PROHIBIDO (CD-1/2/4/5/6/7 + no-deps + no-receipt + no-tocar-core + no-wirear-payoutAllowed)
[x] Context Map tiene >2 archivos leídos (9 archivos, con archivo:línea)
[x] Scope IN y OUT explícitos y no ambiguos (§2)
[x] BD: `a2a_agents` verificada que existe; sin migración (DT-1)
[x] Flujo principal (Happy Path — riel completo) definido (§4.4), incl. nota de payoutAllowed inerte
[x] Flujo de error definido (§4.5, 3 casos) — con el path 400 PII-safe explícito
[x] PII redaction (CD-6) diseñada para 200/400/502 con test de enforcement en cada código
[x] Auto-blindaje histórico revisado: sin `auto-blindaje.md` en las últimas HUs DONE (167/166); se hereda el blindaje WKH-133/134 documentado en el SDD de WKH-171 (guards de Number/monto — inaplicable acá, sin aritmética nueva en el route)
```

**SDD LISTO para SPEC_APPROVED** — sin TBDs de diseño; los residuales son operativos (gated por `!` humano,
CD-7).

---

*SDD generado por NexusAgil — FULL — Architect F2*
