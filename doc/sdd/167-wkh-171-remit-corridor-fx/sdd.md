# SDD #167: [WKH-171] Publicar `remit-corridor-fx` como agente standalone del marketplace A2A

> SPEC_APPROVED: no
> Fecha: 2026-07-09
> Tipo: feature
> SDD_MODE: full
> Branch: feat/167-wkh-171-remit-corridor-fx
> Artefactos: doc/sdd/167-wkh-171-remit-corridor-fx/
> Repos tocados: `wasiai-remittance-agents` (código nuevo) · `wasiai-a2a` (CERO código — solo registro runtime)

---

## 1. Resumen

Se construye y deploya el **endpoint HTTP** que hace invocable al agente `remit-corridor-fx`
(hoy una librería TS pura sin servidor) y se lo **registra** como agente REGISTRADO y facturable
en el protocolo A2A vía el mecanismo self-serve ya existente (`POST /agents`, WKH-134/143b).

El endpoint es una **Next.js API route** (App Router, deploy Vercel — mismo patrón que los repos
hermanos `wasiai-lendable`/cobraya y `wasiai-agentshop`) que envuelve `runCorridorFx`
(`src/agents/corridor-fx.ts`) + `FallbackFxProvider` (`src/providers/fx.ts`), honra el contrato
A2A `POST /invoke → 200 { result: {...} }` (legible por `data.result ?? data` en
`compose.ts:892-893`) y responde `400` estructurado si el body falla Zod.

**Decisiones ratificadas por el humano (NO se reabren en este SDD):**
1. **Modo de pago = a2a-key prepago** → `wasiai-a2a` queda con **CERO código nuevo** (Opción B / `payTo`
   DESCARTADA para esta HU). El riel a probar es: discover → debitar budget del a2a-key → invocar →
   fee-split creator (1% a `payoutWallet`). Resuelve Missing Input #1 (Analyst) con la Opción A.
2. **Stack del endpoint = Next.js API route en Vercel**, proyecto Vercel NUEVO separado del demo
   `wasiai-agentshop`. Resuelve Missing Inputs #2 y #4.

Resultado esperado: `remit-corridor-fx` aparece en `POST /discover` como `status: active`, es invocable
vía `/compose` con un a2a-key, cotiza con FX mid real (`open.er-api.com`) + spread declarado, y liquida
el leg `creator` del protocol fee a su `payoutWallet` — en paralelo al demo `agentshop-corridor-discoverer`,
que queda intacto.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 167 (WKH-171) |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Objetivo** | Hacer invocable + registrar `remit-corridor-fx` (endpoint HTTP nuevo + `POST /agents`) probando el riel discover→pagar(a2a-key)→invocar→fee-split, sin tocar el demo ni el core money-path del gateway. |
| **Reglas de negocio** | Slug byte-idéntico `remit-corridor-fx`; cotización 100% del `FallbackFxProvider` (FX mid real + spread); TransFi OFF; testnet-only; mutaciones de prod gated por `!` humano. |
| **Scope IN** | `wasiai-remittance-agents`: scaffolding Next.js + invoke route + tests + deploy Vercel nuevo. `wasiai-a2a`: 1 llamada runtime `POST /agents` (sin código). |
| **Scope OUT** | `wasiai-agentshop`/`agentshop-*`; `orchestrate.ts`/core `compose.ts`; TransFi adapter; `remit-kyc-validator`/`remit-cashout-payout`; value-delivery/`remittance_intents`; mainnet; migraciones DB; soporte `payTo`/x402-anónimo-directo (Opción B). |
| **Missing Inputs** | #1 y #2/#4 resueltos por ratificación humana (ver §1). #3 (a2a-key/owner_ref publicador, wallet `payoutWallet`, ejecución del deploy) = pasos manuales gated por `!` (ver §11). |

### Acceptance Criteria (EARS)

- **AC-1**: WHEN un caller consulta `POST /discover` (o `GET /agents/remit-corridor-fx/agent-card`) en
  `wasiai-a2a`, THE system SHALL devolver `remit-corridor-fx` como agente activo (`status: active`,
  `enabled: true`), distinto y sin reemplazar a `agentshop-corridor-discoverer`.
- **AC-2**: WHEN se registra `remit-corridor-fx` vía `POST /agents`, THE system SHALL persistir una fila
  NUEVA en `a2a_agents` con slug EXACTO `remit-corridor-fx`, sin modificar ninguna fila `agentshop-*`.
- **AC-3**: WHEN se invoca `remit-corridor-fx` con un `amountUsd` válido, THE system SHALL devolver una
  cotización cuyo `rate` derive del mid USD→PEN real (`open.er-api.com`) más el spread declarado
  (`FALLBACK_FX_SPREAD_BPS`), nunca un valor hardcodeado o simulado.
- **AC-4**: WHILE `TRANSFI_API_KEY`/`TRANSFI_ADAPTER_READY` permanezcan sin configurar, THE system SHALL
  servir toda cotización exclusivamente vía `FallbackFxProvider` (`provenance: "local-fallback"`).
- **AC-5**: WHEN un pipeline cuyo `steps[0]` es `remit-corridor-fx` completa con éxito Y el agente declaró
  `payoutWallet`, THE system SHALL liquidar el leg `creator` del protocol fee (1%) a esa wallet vía el
  mecanismo existente de `fee-split.ts`/`agent-split-context.ts`, auditable en `a2a_fee_splits`.
- **AC-6**: WHEN el endpoint HTTP recibe `POST` con un body válido (`amountUsd` positivo, `destCountry`/
  `payoutMethod` opcionales), THE system SHALL responder `200` con un body legible por `data.result ?? data`
  y que matchee `CorridorFxOutput`.
- **AC-7**: IF el body del request falla la validación Zod (ej. `amountUsd <= 0`), THEN THE system SHALL
  responder `400` con un error estructurado, nunca un 500 sin manejar.
- **AC-8** *(resuelto por ratificación — cierra `[NEEDS CLARIFICATION]` del work-item)*: el camino
  x402-anónimo-directo-al-agente queda **explícitamente fuera de etapa 1**. El único riel soportado es
  **a2a-key prepago**; no se agrega soporte `payTo`/`payment` a self-publish. IF un caller invoca vía x402
  anónimo (sin a2a-key), THE gateway lanza `No payTo address...` (`compose.ts:812`) — comportamiento
  esperado y documentado, no un bug de esta HU.

## 3. Context Map (Codebase Grounding)

### Archivos leídos
| Archivo | Por qué | Patrón / hallazgo extraído |
|---------|---------|-----------|
| `wasiai-remittance-agents/src/agents/corridor-fx.ts` | Core a envolver | `runCorridorFx(raw): Promise<CorridorFxOutput>` parsea con `CorridorFxInputSchema` (throws ZodError), llama `getFxQuoteProvider().quote()`, retorna `{ slug: SLUG, ...quote }`. `SLUG="remit-corridor-fx"`, `PRICE_USDC=0.03`. |
| `wasiai-remittance-agents/src/providers/fx.ts` | Provider FX | `FallbackFxProvider` usa `getUsdToPenMid()` (fetch a `https://open.er-api.com/v6/latest/USD`, cache 5min, estático `STATIC_USD_PEN=3.75`), aplica `FALLBACK_FX_SPREAD_BPS` (250) + `FALLBACK_FX_FLAT_FEE_USD` (0.5). `getFxQuoteProvider()` = fallback salvo `TRANSFI_API_KEY` + `TRANSFI_ADAPTER_READY==='true'`. `assertValidQuote` = guard NaN/negativos → throw. |
| `wasiai-remittance-agents/src/providers/types.ts` | Contrato FX | `FxQuote` = `{rate, feeUsd, netDeliveredLocal, localCurrency:"PEN", etaMinutes, quoteId, expiresAt, provenance}`. `CorridorFxOutput extends FxQuote { slug }`. |
| `wasiai-remittance-agents/README.md` | Contrato HTTP (CD-7) | `POST /invoke/{slug} body=step input → 200 { result: {...} }`. Nada de pago/x402 del lado del agente. Slugs `remit-*`, servicio+registro separados. |
| `wasiai-remittance-agents/package.json` + `tsconfig.json` | Estado del repo | Librería TS pura ESM (`"type":"module"`), única dep runtime `zod`. `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes:false`, alias `@/*` NO configurado hoy. Scripts: `typecheck`/`test`/`test:watch` (vitest). SIN Next/React/Vercel. |
| `wasiai-remittance-agents/src/agents/corridor-fx.test.ts` + `providers/fx.test.ts` | Patrón de test + fetch mock | vitest; `vi.stubGlobal("fetch", vi.fn(async()=>({ok:true,json:async()=>({rates:{PEN:3.8}})})))` + `vi.stubEnv("TRANSFI_API_KEY","")`. Es el mock exacto para el contract test del endpoint. |
| `wasiai-lendable/src/app/api/agents/cobraya-credit-scorer/invoke/route.ts` | **Exemplar principal del endpoint** | `import {NextRequest,NextResponse} from "next/server"`; `const parsed = InputSchema.safeParse(await req.json().catch(()=>null)); if(!parsed.success) return NextResponse.json({error:"invalid_input",details:parsed.error.flatten()},{status:400})`; core → `output`; `return NextResponse.json({...output})`. Alias `@/core/...`. |
| `wasiai-agentshop/src/app/api/agents/agentshop-corridor-discoverer/invoke/route.ts` | Exemplar hermano (demo intacto) | Misma forma App Router `POST(req: Request)`; valida body → 400 `{error}`; retorna `NextResponse.json(result)`. Confirma path `src/app/api/agents/{slug}/invoke/route.ts`. NO SE TOCA (CD-1). |
| `wasiai-a2a/src/services/compose.ts:892-893` | Contrato de lectura (CD-7/AC-6) | `const data = await response.json(); const output = data.result ?? data;` — el endpoint DEBE envolver en `{ result }`. |
| `wasiai-a2a/src/services/compose.ts:800-815` | Confirma AC-8 | Sin `metadata.payTo`/`payment.contract` el x402-anónimo lanza `No payTo address...`. Ratificado como fuera de scope. |
| `wasiai-a2a/src/types/index.ts:118-140` | Contrato de registro | `PublishAgentInput = {name, agentUrl, capabilities[], description?, priceUsdc?, inputSchema?, outputSchema?, discoverable?, payoutWallet?, referrerRef?}`. `slug` NUNCA se acepta del body. |
| `wasiai-a2a/src/services/agent.ts:337` | **Derivación del slug (crítico)** | `const slug = input.name.toLowerCase().replace(/\s+/g, '-')`. Para slug `remit-corridor-fx` el `name` DEBE ser exactamente `remit-corridor-fx` (ya lowercase, con guiones, sin espacios). Pre-check de colisión (línea 341) + `23505` como defensa de race. |
| `wasiai-a2a/src/services/agent.ts:108-127` | `mapRowToAgent` | Fila self-published → `Agent` con `status:'active'`, `verified:false`, `invokeUrl=agent_url`. Confirma AC-1. |
| `wasiai-a2a/src/routes/agents.ts:99-230` | Route `POST /agents` | Requiere a2a-key autenticado (no x402 anónimo). 422 si `priceUsdc`/`payoutWallet` inválidos. SSRF-valida `agentUrl` write-time. `capabilities` filtra a string[] ≥1. |

### Exemplars
| Para crear | Seguir patrón de | Razón |
|-----------|------------------|-------|
| `src/app/api/agents/remit-corridor-fx/invoke/route.ts` | `wasiai-lendable/.../cobraya-credit-scorer/invoke/route.ts` (VERIFICADO ✓) | safeParse→400 estructurado, core→`{result}`, App Router POST. **Omitir el bloque de receipt EIP-712** (no hay `agent-signer` en este repo — ver §4.3). |
| `src/app/api/agents/remit-corridor-fx/invoke/route.test.ts` | `src/agents/corridor-fx.test.ts` (VERIFICADO ✓) — fetch+env stub | Contract test con `POST(new Request(...))` y `vi.stubGlobal("fetch",...)`. |
| Payload `POST /agents` (§10, doc, NO código) | `PublishAgentInput` (`types/index.ts:118`, VERIFICADO ✓) | Campos exactos + derivación de slug desde `name`. |

### Estado de BD relevante
| Tabla | Existe | Columnas relevantes | Cambios |
|-------|--------|---------------------|---------|
| `a2a_agents` (`wasiai-a2a`) | Sí | `slug` (PK), `name`, `agent_url`, `price_usdc`, `capabilities` (JSONB), `metadata` (JSONB), `payout_wallet`, `referrer_ref`, `enabled`, `owner_ref` | **NINGUNO** — solo se INSERTA 1 fila vía `POST /agents` runtime (DT-2). Sin migración. |
| `a2a_fee_splits` | Sí | leg `creator` + `status` + `tx_hash` | Solo lectura (evidencia de AC-5). |

### Componentes reutilizables encontrados
- `runCorridorFx` / `getFxQuoteProvider` / `CorridorFxInputSchema` / `assertValidQuote` — **ya implementados y testeados**. El endpoint SOLO los envuelve; **NO se reimplementa lógica FX** (DT-3).
- El pipeline de discovery/fee-split del gateway ya mergea filas `a2a_agents` — **cero código nuevo** en `wasiai-a2a` (DT-1).

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar (`wasiai-remittance-agents`)

| Archivo | Acción | Qué hace | Exemplar |
|---------|--------|----------|----------|
| `package.json` | Modificar | + deps `next`, `react`, `react-dom`; + devDeps `@types/react`, `@types/react-dom`; + scripts `dev`/`build`/`start`. Mantener `type:"module"`, `zod`, vitest. | `wasiai-lendable/package.json` |
| `tsconfig.json` | Modificar | + `jsx:"preserve"`, `plugins:[{name:"next"}]`, `paths:{"@/*":["./src/*"]}`, `incremental:true`; `include` suma `next-env.d.ts`, `.next/types/**/*.ts`. Mantener `strict`, `noUncheckedIndexedAccess`, `noEmit`. | `wasiai-lendable/tsconfig.json` |
| `next.config.mjs` | Crear | Config mínima Next 14 App Router (default export objeto). | `wasiai-lendable/next.config.*` |
| `.gitignore` | Crear/Modificar | Ignorar `.next/`, `next-env.d.ts`, `node_modules/`. | repo hermano |
| `src/app/layout.tsx` | Crear | Root layout mínimo (Next exige uno si el `app/` dir se usa). Solo `<html><body>{children}</body></html>`. | repo hermano |
| `src/app/page.tsx` | Crear | Landing informativa (nombre del agente + `POST /api/agents/remit-corridor-fx/invoke`). **Presentación, sin lógica.** | repo hermano |
| `src/app/api/agents/remit-corridor-fx/invoke/route.ts` | Crear | **Endpoint principal.** Ver §4.3. | `cobraya-credit-scorer/invoke/route.ts` |
| `src/app/api/agents/remit-corridor-fx/invoke/route.test.ts` | Crear | Contract tests (AC-3/4/6/7). Ver §6. | `corridor-fx.test.ts` |
| `README.md` | Modificar (menor) | Documentar cómo correr/deployar el endpoint + `agent_url` resultante. | — |

> `src/agents/corridor-fx.ts`, `src/providers/*` = **NO se tocan** (ya listos, DT-3).

### 4.2 Modelo de datos
N/A. Sin cambios de schema (DT-2). Solo INSERT runtime de 1 fila en `a2a_agents` vía `POST /agents` (§10, paso manual).

### 4.3 Endpoint — diseño (sin código)

Handler `POST` en `src/app/api/agents/remit-corridor-fx/invoke/route.ts`:

1. `const parsed = CorridorFxInputSchema.safeParse(await req.json().catch(() => null))`
   — importar `CorridorFxInputSchema` desde `@/agents/corridor-fx` (reusar el mismo schema, **no duplicar**).
2. Si `!parsed.success` → `NextResponse.json({ error: "invalid_input", details: parsed.error.flatten() }, { status: 400 })` (AC-7).
3. `try { const result = await runCorridorFx(parsed.data); return NextResponse.json({ result }, { status: 200 }) }`
   — envolver en `{ result }` (AC-6, contrato `compose.ts:892`).
4. `catch (err)`: el core puede lanzar por (a) `assertValidQuote` (NaN/monto inválido) o (b) misconfig de env
   (`transfi_adapter_not_ready`). Responder `502` estructurado `{ error: "quote_unavailable" }` con `console.warn`
   sin stack (patrón cobraya líneas 63-71). **Nunca un 500 sin manejar** (AC-7 espíritu).
5. **Sin receipt EIP-712** (el repo no tiene `agent-signer`; el receipt es opcional en el contrato y no lo exige
   ningún AC — agregarlo ampliaría superficie money-path sin valor en etapa 1).
6. **Sin lógica de pago/x402/on-chain** en el endpoint (README §Arquitectura; lo hace el gateway).

> Nota HTTP: `runCorridorFx` ya reparsea con el mismo schema (idempotente); el `safeParse` en el route es para
> el 400 estructurado (la excepción cruda de ZodError no da un body limpio). No es doble validación problemática.

### 4.4 Flujo principal (Happy Path — riel completo)

1. Caller con **a2a-key** invoca `POST /compose` (o `/orchestrate`) en `wasiai-a2a` con `steps[0]=remit-corridor-fx`.
2. Gateway hace discovery → encuentra la fila `a2a_agents` (`status:active`, `invokeUrl` = deploy Vercel nuevo).
3. Gateway **debita** el `price_usdc` (0.03) del budget del a2a-key (movimiento de ledger interno, no on-chain per-call).
4. Gateway hace `POST {invokeUrl}` con `{ amountUsd, ... }` → endpoint responde `200 { result: {slug, rate, feeUsd, netDeliveredLocal, ...} }`.
5. Gateway lee `data.result` (`compose.ts:893`), continúa el pipeline.
6. Al completar con éxito, cobra el 1% protocol fee y **liquida el leg `creator`** a `payout_wallet` → fila en `a2a_fee_splits` (AC-5).

### 4.5 Flujo de error

1. Body inválido (`amountUsd<=0` / no-JSON) → `400 {error:"invalid_input", details}` (AC-7). El gateway ve el 4xx y aborta/reembolsa el step (comportamiento existente).
2. FX mid API caída → `getUsdToPenMid` cae al estático `STATIC_USD_PEN` (ya implementado) → cotización sigue válida.
3. Env misconfig (`FALLBACK_FX_*` no numérico) → `assertValidQuote` lanza → catch → `502 {error:"quote_unavailable"}` (no 500 crudo).
4. Caller **sin a2a-key** (x402 anónimo) → gateway lanza `No payTo address...` (AC-8, esperado, fuera de scope).

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir
- **CD-3 (heredado)**: slug byte-idéntico `remit-corridor-fx`. En el registro, `name` = `"remit-corridor-fx"` EXACTO (la derivación `name.toLowerCase().replace(/\s+/g,'-')` produce ese slug — `agent.ts:337`). NO usar un `name` con espacios/mayúsculas.
- **CD-7 (heredado)**: endpoint responde `200 { result: {...} }` (envuelto), legible por `data.result ?? data`.
- Endpoint forkea `cobraya-credit-scorer/invoke/route.ts`: `safeParse` → 400 estructurado, core → `{result}`.
- Reusar `CorridorFxInputSchema` y `runCorridorFx` de `@/agents/corridor-fx` (alias `@/*`→`src/*`). NO duplicar el schema ni la lógica FX.
- Env vars del deploy: `FALLBACK_FX_SPREAD_BPS`, `FALLBACK_FX_FLAT_FEE_USD` (y opcional `STATIC_USD_PEN`). Todo desde env (Golden Path: sin hardcodes).
- Mantener money-path guards existentes: `assertValidQuote` DEBE seguir en el camino (nunca emitir NaN). *(blindaje histórico: WKH-133 — todo `Number()`/monto sobre dato externo va guardado; acá ya lo está, no bypassear).*

### PROHIBIDO
- **CD-1**: NO tocar NINGÚN archivo de `wasiai-agentshop` / `agentshop-corridor-discoverer`.
- **CD-2**: NO tocar `wasiai-a2a` (CERO código: ni `orchestrate.ts`, ni core `compose.ts`, ni `agent.ts`/`agents.ts`/`types`). El registro es 100% runtime (`POST /agents`). La Opción B (`payTo`) queda descartada.
- **CD-4**: NO activar TransFi — NO setear `TRANSFI_API_KEY` ni `TRANSFI_ADAPTER_READY=true` en el deploy.
- **CD-5**: testnet-only — ninguna referencia a mainnet en deploy/registro.
- **CD-6**: las mutaciones de infra/prod (deploy Vercel nuevo, `POST /agents` contra prod, env vars) las ejecuta el **humano vía `!`**. El pipeline automatizado NO las corre.
- NO agregar deps fuera de las listadas (`next`/`react`/`react-dom` + types). NO agregar `@supabase/*`, `viem`, ni SDK de pago al repo del agente.
- NO agregar receipt EIP-712 / `agent-signer` en esta HU (fuera de scope).
- NO modificar `src/agents/corridor-fx.ts` ni `src/providers/*`.
- *(blindaje WKH-134)*: en el route, NO construir objetos tipados con `x: cond ? v : undefined`; usar asignación condicional. *(Nota: `exactOptionalPropertyTypes:false` en este repo lo hace menos crítico, pero es buena práctica.)*

## 6. Test Plan

Framework: **vitest** (ya en el repo). Los tests corren en fallback (TransFi OFF) con `fetch` stubeado — sin red real.

| Test | AC que cubre | Descripción |
|------|-------------|-------------|
| `route.test.ts` › "body válido → 200 { result } legible por data.result" | AC-6 | `POST(new Request(url,{method:"POST",body:JSON.stringify({amountUsd:100})}))` → `res.status===200`; `const data=await res.json(); const output=data.result ?? data;` → `output.slug==="remit-corridor-fx"`, `output.localCurrency==="PEN"`, `Number.isFinite(output.rate)`, `output.netDeliveredLocal>0`. Mock: `vi.stubGlobal("fetch",...PEN:3.8)` + `vi.stubEnv("TRANSFI_API_KEY","")`. |
| `route.test.ts` › "rate deriva del mid real + spread" | AC-3 | Con mid mockeado `PEN:3.8` y `FALLBACK_FX_SPREAD_BPS` default (250): `output.rate` ≈ `3.8*(1-250/10000)` (menor que el mid, spread en contra). Assert `rate < 3.8 && rate > 3.6`. Confirma que NO es hardcode. |
| `route.test.ts` › "TransFi OFF → provenance local-fallback" | AC-4 | Sin `TRANSFI_API_KEY` → `output.provenance === "local-fallback"` (nunca `"transfi"`). |
| `route.test.ts` › "amountUsd<=0 → 400 estructurado" | AC-7 | `POST` con `{amountUsd:-5}` → `res.status===400`; body tiene `error:"invalid_input"` + `details`. NO 500. |
| `route.test.ts` › "body no-JSON → 400 (no 500)" | AC-7 | `POST` con body vacío/no-JSON → `400` (el `.catch(()=>null)` + safeParse). |

> AC-1, AC-2, AC-5, AC-8 son ACs de **registro/gateway runtime** — se verifican por **smoke manual + evidencia**
> (QA F4), no por unit test en el repo del agente. Ver §11 (evidencia esperada: fila en `a2a_agents`,
> `POST /discover` mostrando el slug, fila `charged` en `a2a_fee_splits`).

## 7. Plan de Implementación (Waves)

### Wave 0 — Scaffolding Next.js (Serial Gate)
- [ ] W0.1: `package.json` — deps `next`/`react`/`react-dom` + types + scripts `dev`/`build`/`start` (mantener zod/vitest/`type:module`).
- [ ] W0.2: `tsconfig.json` — `jsx:"preserve"`, `plugins:[{name:"next"}]`, `paths:{"@/*":["./src/*"]}`, includes Next.
- [ ] W0.3: `next.config.mjs` + `.gitignore` (`.next/`, `next-env.d.ts`).
- [ ] W0.4: `src/app/layout.tsx` + `src/app/page.tsx` (mínimos, presentación).
- **Verificación**: `npm install` OK + `npm run build` (Next) compila + `npm run typecheck` (`tsc --noEmit`) verde.

### Wave 1 — Endpoint + tests (depende de W0)
- [ ] W1.1: `src/app/api/agents/remit-corridor-fx/invoke/route.ts` → Exemplar: `cobraya-credit-scorer/invoke/route.ts`. Envuelve `runCorridorFx`, `{result}`, 400/502 estructurados.
- [ ] W1.2: `src/app/api/agents/remit-corridor-fx/invoke/route.test.ts` → Exemplar: `corridor-fx.test.ts`. 5 tests (§6).
- **Verificación**: `npm test` (vitest) verde (tests nuevos + los existentes de agents/providers intactos) + `npm run typecheck`.

### Wave 2 — Docs (depende de W1)
- [ ] W2.1: `README.md` — sección "Endpoint HTTP + deploy" con la URL `POST /api/agents/remit-corridor-fx/invoke` y las env vars.
- **Verificación**: revisión de consistencia con el contrato.

### Wave 3 — Deploy (MANUAL, humano vía `!` — CD-6)
- [ ] W3.1: Deploy proyecto Vercel **nuevo** (separado de `wasiai-agentshop`). Setear env vars (§9). NO setear TransFi (CD-4).
- [ ] W3.2: Obtener el `agent_url` real = `https://<deploy-nuevo>/api/agents/remit-corridor-fx/invoke`.
- [ ] W3.3: Smoke directo: `curl -X POST {agent_url} -d '{"amountUsd":100}'` → `200 {result:{...provenance:"local-fallback"}}`.

### Wave 4 — Registro (MANUAL, humano vía `!` — CD-6)
- [ ] W4.1: `POST /agents` contra prod (Railway) con a2a-key autenticado + payload §10 (incl. `payoutWallet`).
- [ ] W4.2: Verificar `POST /discover` muestra `remit-corridor-fx` (`status:active`) sin afectar `agentshop-*` (AC-1/AC-2).

### Wave 5 — Verificación E2E del riel (MANUAL + QA)
- [ ] W5.1: Invocar `/compose` con a2a-key y `steps[0]=remit-corridor-fx` → cotización real (AC-3/AC-6).
- [ ] W5.2: Verificar fila `charged` + `tx_hash` en `a2a_fee_splits` leg `creator` = `payoutWallet` (AC-5).

## 8. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Agregar Next a un repo ESM lib rompe el typecheck/tests existentes | M | M | W0 aislado; verificar `npm test` (agents/providers) sigue verde tras el scaffolding. `noEmit`+alias no afectan los tests actuales. |
| Testear un route handler de Next requiere runtime Next | B | B | Handlers App Router aceptan `Request` estándar y devuelven `Response`; test invoca `POST(new Request(...))` sin server. |
| El `name` en el registro no produce el slug exacto | B | A | CD-3 explícito: `name="remit-corridor-fx"` (verificado contra `agent.ts:337`). W4 verifica el slug persistido. |
| Slug ya existe (colisión) | B | M | `POST /agents` pre-check (línea 341) + 23505; si existe, es fila previa — investigar antes de re-registrar. |
| FX mid API (`open.er-api.com`) caída en prod | M | B | Fallback estático `STATIC_USD_PEN` ya implementado; cotización sigue saliendo. |
| Deploy Vercel expone el agente a x402-anónimo | B | B | AC-8: sin `payTo` el gateway rechaza; el a2a-key es el único riel. Documentado. |

## 9. Env vars del deploy (Vercel, W3 — humano)

```
FALLBACK_FX_SPREAD_BPS=250        # spread declarado (bps); default del código si se omite
FALLBACK_FX_FLAT_FEE_USD=0.5      # fee flat USD; default del código si se omite
STATIC_USD_PEN=3.75               # (opcional) fallback si open.er-api.com falla
# PROHIBIDO en esta HU (CD-4):
# TRANSFI_API_KEY        ← NO setear
# TRANSFI_ADAPTER_READY  ← NO setear (debe quedar != "true")
# AGENT_SIGNER_PRIVATE_KEY ← NO necesario (sin receipt en etapa 1)
```

## 10. Payload de registro `POST /agents` (documento — NO ejecutar; humano vía `!`)

> Endpoint: `POST https://<a2a-prod-railway>/agents` · Auth: header con a2a-key autenticado (owner_ref del publicador — Missing Input #3). `slug` NO se manda (se deriva de `name`).

```json
{
  "name": "remit-corridor-fx",
  "agentUrl": "https://<DEPLOY-NUEVO>.vercel.app/api/agents/remit-corridor-fx/invoke",
  "description": "Cotización de corredor de remesa USDC→PEN (FX mid real + spread declarado). Etapa 1 fallback; TransFi en etapa 2.",
  "priceUsdc": 0.03,
  "capabilities": ["remittance-fx-quote", "usdc-to-pen", "corridor-pricing"],
  "payoutWallet": "0x<WALLET-EVM-CREATOR-TESTNET>",
  "discoverable": true,
  "inputSchema": {
    "type": "object",
    "properties": {
      "amountUsd": { "type": "number", "exclusiveMinimum": 0 },
      "destCountry": { "type": "string", "default": "PE" },
      "destCurrency": { "type": "string", "const": "PEN" },
      "payoutMethod": { "type": "string", "enum": ["yape", "plin", "bank_cci"], "default": "yape" }
    },
    "required": ["amountUsd"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "slug": { "type": "string" },
      "rate": { "type": "number" },
      "feeUsd": { "type": "number" },
      "netDeliveredLocal": { "type": "number" },
      "localCurrency": { "type": "string", "const": "PEN" },
      "etaMinutes": { "type": "number" },
      "quoteId": { "type": "string" },
      "expiresAt": { "type": "string" },
      "provenance": { "type": "string" }
    }
  }
}
```

- `name` = `"remit-corridor-fx"` byte-idéntico ⇒ slug `remit-corridor-fx` (CD-3).
- `priceUsdc` = `0.03` (= `PRICE_USDC` en `corridor-fx.ts`).
- `payoutWallet` = wallet EVM **testnet** del creator (Missing Input #3, aporta el humano) → habilita el leg `creator` del split (AC-5).
- `inputSchema`/`outputSchema` derivados de `CorridorFxInputSchema` / `CorridorFxOutput` (`providers/types.ts`).

## 11. Missing Inputs (residuales — gated por `!` humano, CD-6)

- [ ] a2a-key/owner_ref del publicador (para W4.1). **Humano.**
- [ ] Wallet EVM `payoutWallet` testnet del creator (para el payload §10). **Humano.**
- [ ] Ejecución del deploy Vercel nuevo (W3) + `POST /agents` (W4) + env vars. **Humano vía `!`.**

## 12. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| — | — | Sin `[NEEDS CLARIFICATION]`. El AC-8 del work-item quedó **resuelto** por ratificación (a2a-key, Opción A). | No |

> Los items de §11 NO son `[NEEDS CLARIFICATION]` de diseño: son valores operativos (secretos/wallet) que
> por política (CD-6) los provee/ejecuta el humano en las waves manuales. No bloquean F2.5/F3 (la
> construcción del endpoint + tests no los necesita).

---

## Readiness Check

```
READINESS CHECK:
[x] Cada AC tiene ≥1 archivo asociado (AC-3/4/6/7 → route.ts + route.test.ts; AC-1/2/5/8 → registro runtime §10/§11 + verificación manual)
[x] Cada archivo en §4.1 tiene Exemplar verificado con Glob/Read (cobraya route ✓, corridor-fx.test ✓, PublishAgentInput ✓)
[x] No hay [NEEDS CLARIFICATION] pendientes (AC-8 resuelto por ratificación)
[x] Constraint Directives incluyen >3 PROHIBIDO (CD-1/2/4/5/6 + no-deps + no-receipt + no-tocar-core)
[x] Context Map tiene >2 archivos leídos (13 archivos, con archivo:línea)
[x] Scope IN y OUT explícitos y no ambiguos (§2)
[x] BD: `a2a_agents` verificada que existe; sin migración (DT-2)
[x] Flujo principal (Happy Path — riel completo) definido (§4.4)
[x] Flujo de error definido (§4.5, 4 casos)
[x] Auto-blindaje histórico revisado (WKH-133/134 — guards de Number()/monto + no `x:cond?v:undefined`)
```

**SDD LISTO para SPEC_APPROVED** — sin TBDs de diseño; los residuales son operativos (gated por `!` humano, CD-6).

---

*SDD generado por NexusAgil — FULL — Architect F2*
