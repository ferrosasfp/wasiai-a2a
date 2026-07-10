# Story File — [WKH-170] Publicar `remit-kyc-validator` como agente standalone (etapa 1 / Free-KYC)

> Contrato autocontenido para el Dev (F3). Implementá **al pie de la letra**, wave por wave.
> Fuente de verdad: `sdd.md` (SPEC_APPROVED). NO reabras decisiones ya cerradas.
> Repo de trabajo (código F3): **`/home/ferdev/.openclaw/workspace/wasiai-remittance-agents/`**
> `wasiai-a2a` = **CERO código** (registro runtime `!` humano, W4).

---

## 0. Contexto compacto (qué se construye y por qué)

`remit-kyc-validator` hoy es una **librería TS pura** (`runKycValidator` + `FallbackKycProvider`) sin servidor
HTTP → NO es invocable por el gateway A2A. Esta HU le agrega **un único endpoint** Next.js App Router que
envuelve la lógica ya existente y honra el contrato `POST /invoke → 200 { result: {...} }` (legible por
`data.result ?? data` en `wasiai-a2a/src/services/compose.ts`).

**Diferencia clave vs WKH-171:** el scaffold Next 14 (`package.json`, `tsconfig.json` con alias `@/*→src/*`,
`next.config.mjs`, `vitest.config.ts`, `src/app/{layout,page}.tsx`) **YA EXISTE** (lo entregó WKH-171 en este
mismo repo, verificado en disco). **NO hay Wave de scaffolding.** Solo se agrega la carpeta
`remit-kyc-validator/invoke/`.

El agente verifica KYC/AML de una remesa. Etapa 1 corre **100% en `FallbackKycProvider`** (`provenance:
"local-fallback"`); **Didit queda OFF** (etapa 2, CD-4). El pago es vía **a2a-key prepago** → cero código en
el gateway. El registro (`POST /agents`) y el deploy son **pasos manuales `!` del humano** (W3/W4).

**Eje crítico (CD-6 / AC-3 / AC-7):** ningún response HTTP (200/400/502) puede exponer `legalId` (DNI) ni
`travelRuleData`. El core ya está blindado (`runKycValidator` devuelve solo 7 campos sin PII). El riesgo nuevo
vive en el **wrapper HTTP**: el path 400 no debe ecoar el `legalId` recibido; el 502 no debe filtrar
`err.message`/body.

**NO se reimplementa lógica KYC.** `src/agents/kyc-validator.ts` y `src/providers/*` **NO se tocan**.

---

## 1. Scope IN — archivos exactos a tocar (repo `wasiai-remittance-agents`)

| # | Archivo | Acción | Wave |
|---|---------|--------|------|
| 1 | `src/app/api/agents/remit-kyc-validator/invoke/route.ts` | **Crear (endpoint principal)** | W1 |
| 2 | `src/app/api/agents/remit-kyc-validator/invoke/route.test.ts` | Crear (7 tests) | W1 |
| 3 | `README.md` | Modificar (agregar sección endpoint + deploy) | W2 |

**PROHIBIDO tocar** (CD-1/CD-2/CD-4 + scaffold ya existe):
- `src/agents/kyc-validator.ts`, `src/providers/kyc.ts`, `src/providers/types.ts` (ya listos y testeados).
- El scaffold: `package.json`, `tsconfig.json`, `next.config.mjs`, `vitest.config.ts`, `src/app/layout.tsx`,
  `src/app/page.tsx` (ya existen — NO re-scaffoldar, NO tocar).
- `src/app/api/agents/remit-corridor-fx/**` (agente hermano ya DONE — solo se **lee** como exemplar).
- Cualquier archivo de `wasiai-agentshop` / `agentshop-kyc-validator` (CD-1).
- Cualquier archivo de `wasiai-a2a` (CD-2: ni `agent.ts`, ni `agents.ts`, ni `compose.ts`, ni `types`).

---

## 2. Anti-Hallucination Checklist (específico de esta HU)

Antes de dar por terminada la wave, verificá — cada símbolo citado con archivo:línea real:

- [ ] El endpoint importa **solo símbolos reales** de `@/agents/kyc-validator`: `KycInputSchema` y
      `runKycValidator`. Ambos existen y están exportados (`src/agents/kyc-validator.ts:16` y `:75`). NO
      inventes otros (`KycAgentOutput` es un `interface` de solo tipo — NO se importa en runtime).
- [ ] Firma real: `runKycValidator(raw: unknown): Promise<KycAgentOutput>` (`kyc-validator.ts:75`).
- [ ] Los campos del `result` (`KycAgentOutput`) son EXACTAMENTE 7 (`kyc-validator.ts:34-43`):
      `slug, approved, riskLevel, reasons, verificationId, provenance, payoutAllowed`. **SIN** `legalId`
      **ni** `travelRuleData`. NO agregues/renombres campos.
- [ ] El 400 usa **SOLO** `parsed.error.flatten()`. **PROHIBIDO** devolver `parsed.data`, el body crudo
      (`await req.json()`), `parsed.error.issues` transformado, `parsed.error.message` concatenado, o cualquier
      mensaje custom que interpole el valor recibido (CD-6). El `KycInputSchema` se reutiliza **tal cual** (no
      se modifica — vive en el core; sus reglas `.min()`/`.positive()` producen mensajes Zod value-free).
- [ ] El 502 tiene body **fijo** `{ error: "verification_unavailable" }` + `console.warn` con **SOLO**
      `err.name`. **PROHIBIDO** `err.message`, `err.stack`, el input o el body en el log o en el response (CD-6).
- [ ] El código de error 502 es `"verification_unavailable"` (NO `"quote_unavailable"` — ese es de FX).
- [ ] El endpoint envuelve la salida en `{ result }` (CD-7/CD-8). NO devuelvas el output "pelado".
- [ ] **NO** hay bloque de receipt EIP-712 (este repo no tiene `agent-signer`). **NO** hay lógica de
      pago/x402/on-chain/Supabase/viem en el endpoint (lo hace el gateway).
- [ ] **NO** se leen env vars de Didit en el route (`DIDIT_API_KEY`/`DIDIT_ADAPTER_READY`). El provider las
      resuelve dentro de `getKycProvider()` (`src/providers/kyc.ts:103`). El route no las referencia.
- [ ] **NO** se agregan deps nuevas (Next/React/zod/vitest ya están). NO `@supabase/*`, NO `viem`, NO SDK de pago.
- [ ] Debe existir ≥1 test NO-PII a nivel HTTP en el **200** y ≥1 en el **400** (CD-6, tests 2 y 5 de §3.2).

> **Símbolos verificados** (para que NO alucines):
> - `remit-corridor-fx/invoke/route.ts` (exemplar byte-a-byte, VERIFICADO ✓) — mismo patrón exacto.
> - `kyc-validator.ts:13` `SLUG="remit-kyc-validator"` · `:14` `PRICE_USDC=0.02` · `:16-24` `KycInputSchema`
>   (`senderName, senderCountry, legalId, amountUsd, receiverName, receiverCountry, purpose`) · `:34-43`
>   `KycAgentOutput` (7 campos, sin PII) · `:75` `runKycValidator`.
> - `providers/kyc.ts:59-77` `FallbackKycProvider.verify` (`provenance:"local-fallback"`, `verificationId`
>   = `fallback-<hash(legalId)>` — es un hash, NO el DNI en claro) · `:103-113` `getKycProvider()`
>   (sin `DIDIT_API_KEY` → fallback; con key sin `DIDIT_ADAPTER_READY=true` → **lanza** `didit_adapter_not_ready`).

---

## 3. Waves

### Wave 1 — Endpoint + tests (única wave de código automatizable)

> No hay W0: el scaffold ya existe (WKH-171). Solo se agrega la carpeta `remit-kyc-validator/invoke/`.

#### W1.1 — `src/app/api/agents/remit-kyc-validator/invoke/route.ts` (Crear — ENDPOINT PRINCIPAL)

Exemplar byte-a-byte: `src/app/api/agents/remit-corridor-fx/invoke/route.ts` (mismo repo). Se cambia
`CorridorFxInputSchema/runCorridorFx` → `KycInputSchema/runKycValidator`, el import a `@/agents/kyc-validator`,
y el código de error 502 a `verification_unavailable`.

**Contenido exacto:**

```ts
// src/app/api/agents/remit-kyc-validator/invoke/route.ts
// Endpoint HTTP del agente remit-kyc-validator. Envuelve runKycValidator (lib pura) y honra el
// contrato a2a: POST /invoke → 200 { result: {...} } (legible por data.result ?? data en compose.ts).
// Fork de remit-corridor-fx/invoke/route.ts (mismo repo), cambiando el core FX por el core KYC.
// CD-6 (eje crítico): NINGÚN response (200/400/502) puede exponer legalId ni travelRuleData.
import { NextRequest, NextResponse } from "next/server";
import { KycInputSchema, runKycValidator } from "@/agents/kyc-validator";

export async function POST(req: NextRequest) {
  const parsed = KycInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    // CD-6: SOLO parsed.error.flatten() (mensajes Zod, value-free). NUNCA parsed.data / body crudo /
    // mensajes custom que interpolen el valor recibido (el legalId NO se ecoa).
    return NextResponse.json(
      { error: "invalid_input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await runKycValidator(parsed.data);
    return NextResponse.json({ result }, { status: 200 });
  } catch (err) {
    // CD-6: el core puede lanzar por getKycProvider() misconfig (didit_adapter_not_ready) o error del
    // provider. Body FIJO opaco + warn SOLO con err.name (nunca err.message / stack / input). Nunca un 500.
    console.warn("[remit-kyc-validator] verify failed:", {
      errorName: err instanceof Error ? err.name : "unknown",
    });
    return NextResponse.json({ error: "verification_unavailable" }, { status: 502 });
  }
}
```

Reglas:
- `safeParse` para el **400 estructurado** (AC-7). `runKycValidator` re-parsea internamente con el mismo
  `KycInputSchema` (idempotente, `kyc-validator.ts:76`) — no es doble validación problemática.
- Envolver en `{ result }` (AC-6 / CD-7/CD-8).
- `catch → 502 { error: "verification_unavailable" }` (nunca 500 sin manejar).
- **NO** agregar `runtime`/`dynamic` exports salvo que `next build` lo exija.

#### W1.2 — `src/app/api/agents/remit-kyc-validator/invoke/route.test.ts` (Crear — 7 tests)

Exemplar del mock: `remit-corridor-fx/invoke/route.test.ts` (`vi.hoisted` + `vi.mock(...importActual)` para
forzar el throw del 502 sin tocar el core). Exemplar NO-PII: `kyc-validator.test.ts:19-20`.

**Contenido exacto:**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

// Mock del core con default = implementación real (los demás tests corren el path real).
// El test del 502 usa mockImplementationOnce para forzar un throw sin tocar kyc-validator.ts.
const { runKycValidatorMock } = vi.hoisted(() => ({ runKycValidatorMock: vi.fn() }));
vi.mock("@/agents/kyc-validator", async (importActual) => {
  const actual = await importActual<typeof import("@/agents/kyc-validator")>();
  runKycValidatorMock.mockImplementation(actual.runKycValidator);
  return { ...actual, runKycValidator: runKycValidatorMock };
});

import { POST } from "./route";

const ENDPOINT = "http://localhost/api/agents/remit-kyc-validator/invoke";

// Input válido de referencia con PII real (legalId = DNI) para los asserts NO-PII.
const validInput = {
  senderName: "Alice",
  senderCountry: "US",
  legalId: "12345678",
  amountUsd: 100,
  receiverName: "Bob",
  receiverCountry: "PE",
  purpose: "family support",
};

function invoke(body: unknown) {
  return POST(
    new NextRequest(ENDPOINT, { method: "POST", body: JSON.stringify(body) }),
  );
}

describe("POST /api/agents/remit-kyc-validator/invoke", () => {
  beforeEach(() => {
    vi.stubEnv("DIDIT_API_KEY", ""); // fuerza FallbackKycProvider (Didit OFF)
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // (1) AC-6 / AC-3: body válido → 200 { result } legible por data.result, EXACTAMENTE los 7 campos.
  it("body válido → 200 { result } con exactamente los 7 campos", async () => {
    const res = await invoke(validInput);
    expect(res.status).toBe(200);
    const data = await res.json();
    const output = data.result ?? data; // contrato compose.ts (data.result ?? data)
    expect(output.slug).toBe("remit-kyc-validator");
    expect(Object.keys(output).sort()).toEqual([
      "approved",
      "payoutAllowed",
      "provenance",
      "reasons",
      "riskLevel",
      "slug",
      "verificationId",
    ]);
  });

  // (2) AC-3 / CD-6: el 200 NO filtra legalId/DNI ni travelRuleData (NO-PII a nivel HTTP).
  it("el 200 NO filtra legalId ni travelRuleData (NO-PII HTTP)", async () => {
    const res = await invoke(validInput);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("12345678"); // el DNI / legalId nunca viaja
    expect(body).not.toContain("travelRuleData"); // Travel Rule PII nunca viaja
  });

  // (3) AC-4: Didit OFF → provenance local-fallback (nunca "didit").
  it("Didit OFF → provenance local-fallback", async () => {
    const res = await invoke(validInput);
    const { result } = await res.json();
    expect(result.provenance).toBe("local-fallback");
  });

  // (4) AC-5: PROD + fallback + opt-in → payoutAllowed false (fail-safe, a nivel HTTP).
  it("PROD + fallback → payoutAllowed false (fail-safe)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_FALLBACK_KYC", "true"); // aún así el fail-safe lo ignora en prod
    const res = await invoke(validInput);
    const { result } = await res.json();
    expect(result.payoutAllowed).toBe(false);
  });

  // (5) AC-7 / CD-6: input inválido CON legalId real → 400 que NO ecoa el legalId.
  it("input inválido (falta senderCountry) con legalId real → 400 SIN ecoar el legalId", async () => {
    const res = await invoke({ ...validInput, senderCountry: undefined });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid_input");
    expect(data.details).toBeTruthy();
    expect(JSON.stringify(data)).not.toContain("12345678"); // el DNI NO se ecoa en el 400
  });

  // (6) AC-7: body no-JSON → 400 (no 500).
  it("body no-JSON → 400 (no 500)", async () => {
    const res = await POST(
      new NextRequest(ENDPOINT, { method: "POST", body: "not-json{" }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid_input");
  });

  // (7) CD-6 / §4.5: runKycValidator lanza → 502 opaco sin filtrar internals/PII.
  it("runKycValidator lanza → 502 { error: verification_unavailable } sin filtrar internals", async () => {
    runKycValidatorMock.mockImplementationOnce(async () => {
      throw new Error("didit_adapter_not_ready leak 99887766");
    });
    const res = await invoke(validInput);
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data).toEqual({ error: "verification_unavailable" });
    expect(JSON.stringify(data)).not.toContain("99887766");
    expect(JSON.stringify(data)).not.toContain("didit_adapter_not_ready");
    expect(data.stack).toBeUndefined();
  });
});
```

Notas de test (por qué cada aserto pasa — NO son negociables):
- Con `validInput` (legalId `"12345678"`, 8 chars ≥ 6): el fallback devuelve `approved=true`,
  `riskLevel="low"` (amount 100 < 1000), `provenance="local-fallback"`,
  `verificationId="fallback-<hash>"` (**hash del legalId, no el DNI en claro** —
  `providers/kyc.ts:73,90-95`). Por eso `JSON.stringify(result)` **no contiene** `"12345678"`.
- Test (4): `isPayoutAllowed` (`kyc-validator.ts:56-69`) con `NODE_ENV="production"` entra en la rama
  `!isProd && allowFallback` = `false` → retorna `false`, ignorando `ALLOW_FALLBACK_KYC`. Espejo HTTP de
  `kyc-validator.test.ts` (fail-safe en prod).
- Test (5): `JSON.stringify({ ...validInput, senderCountry: undefined })` **omite** `senderCountry` (clave
  `undefined` no se serializa) → Zod falla con `"Required"` en `senderCountry`; `flatten()` devuelve solo
  mensajes Zod (`{ formErrors:[], fieldErrors:{ senderCountry:["Required"] } }`), **sin** ecoar el `legalId`.
- El mock default corre el core real; solo el test (7) fuerza el throw con `mockImplementationOnce`.
- `new NextRequest(...)` es type-correct (extiende `Request`); evita el cast `as NextRequest`.

**Verificación W1** (todo verde antes de cerrar F3):
```
npm test          # 7 tests nuevos VERDES + los existentes (agents/kyc-validator, providers) siguen verdes
npm run typecheck # tsc --noEmit → verde
npm run build     # next build compila la ruta nueva remit-kyc-validator/invoke
```

---

### Wave 2 — Docs (depende de W1)

#### W2.1 — `README.md` (Modificar — agregar sección, espejo de la de `remit-corridor-fx`)

Agregá una sección nueva al README existente (justo después de la sección de `remit-corridor-fx`,
`README.md:58-92`). Contenido:

````markdown
## Endpoint HTTP + deploy (etapa 1 — `remit-kyc-validator`)

El agente `remit-kyc-validator` ya es invocable vía Next.js App Router (mismo deploy que `remit-corridor-fx`):

```
POST /api/agents/remit-kyc-validator/invoke
body: { "senderName": "Alice", "senderCountry": "US", "legalId": "<DNI>", "amountUsd": 100,
        "receiverName": "Bob", "receiverCountry": "PE", "purpose": "family support" }
→ 200 { "result": { "slug", "approved", "riskLevel", "reasons",
                     "verificationId", "provenance", "payoutAllowed" } }   # SIN legalId ni travelRuleData
→ 400 { "error": "invalid_input", "details": {...} }   # body inválido (mensajes Zod, sin PII)
→ 502 { "error": "verification_unavailable" }          # falla del provider / misconfig
```

Etapa 1 corre 100% en **fallback KYC** (`provenance: "local-fallback"`): verificación determinística, sin
red real. **Didit queda OFF** (etapa 2): `DIDIT_API_KEY` / `DIDIT_ADAPTER_READY` **sin setear** en el deploy.
**Garantía dura NO-PII:** el output NUNCA expone `legalId` (DNI) ni `travelRuleData` en ninguna respuesta
(200/400/502). **Sin** receipt EIP-712 y **sin** lógica de pago/x402 del lado del agente (lo hace el gateway a2a).

### Correr local
`npm run dev` → `http://localhost:3030/api/agents/remit-kyc-validator/invoke`
````

**Verificación W2**: consistencia del contrato documentado con `route.ts`.

---

## 4. Artefactos para las waves MANUALES (`!` humano — NO las ejecuta el Dev/pipeline, CD-7)

> W3, W4, W5 son mutaciones de infra/prod. El Dev **documenta** estos artefactos pero **NO los ejecuta**.

### W3 — Redeploy Vercel (MISMO proyecto `wasiai-remittance-agents`, NO uno nuevo)

Env vars de KYC etapa 1:
```
# Etapa 1 (Free-KYC / fallback): NINGUNA env var de KYC es necesaria.
# PROHIBIDO setear (CD-4):
# DIDIT_API_KEY         ← NO setear
# DIDIT_ADAPTER_READY   ← NO setear (debe quedar != "true")
# ALLOW_FALLBACK_KYC    ← NO setear en prod (irrelevante: en NODE_ENV=production el fail-safe lo ignora)
# AGENT_SIGNER_PRIVATE_KEY ← NO necesario (sin receipt en etapa 1)
```

`agent_url` resultante:
`https://wasiai-remittance-agents.vercel.app/api/agents/remit-kyc-validator/invoke`

Smoke post-deploy (verificar 200 sin PII):
```
curl -X POST https://wasiai-remittance-agents.vercel.app/api/agents/remit-kyc-validator/invoke \
  -H 'content-type: application/json' \
  -d '{"senderName":"Alice","senderCountry":"US","legalId":"12345678","amountUsd":100,"receiverName":"Bob","receiverCountry":"PE","purpose":"family"}'
# → 200 { "result": { ... "provenance":"local-fallback", "payoutAllowed":false ... } }
# y verificar que la respuesta NO contiene "12345678" ni "travelRuleData".
```

### W4 — Registro `POST /agents` (contra prod Railway, a2a-key autenticado)

> `slug` NO se manda: se deriva de `name` vía `name.toLowerCase().replace(/\s+/g,'-')` (`agent.ts:337`).
> `name` = `"remit-kyc-validator"` byte-idéntico ⇒ slug `remit-kyc-validator` (CD-3).
> Registrar es **gratis** (WKH-173 live: `requireA2AKey()` auth-only, sin débito).
> **Header obligatorio:** `x-payment-chain: avalanche-fuji` (además del a2a-key autenticado).

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
- `payoutWallet` = wallet EVM **testnet** del creator (Missing Input #1, lo aporta el humano) → habilita el
  leg `creator` del split (AC-8). **CD-5: testnet, nunca mainnet.**
- `inputSchema` = campos de `KycInputSchema` (`kyc-validator.ts:16-24`). `legalId` **es input** (se envía al
  agente), pero **NO aparece en `outputSchema`**.
- `outputSchema` = campos de `KycAgentOutput` (`kyc-validator.ts:34-43`) — **SIN `legalId` ni
  `travelRuleData`** (CD-6). El schema declarado al marketplace refleja el contrato NO-PII.

### W4.2 / W5 — Verificación (QA F4, evidencia archivo:línea / fila DB)
- `POST /discover` (o `GET /agents/remit-kyc-validator/agent-card`) muestra `remit-kyc-validator`
  `status:active`, sin afectar `agentshop-kyc-validator` (AC-1/AC-2).
- `/compose` con a2a-key y `steps[0]=remit-kyc-validator` → `result` sin PII, `provenance:"local-fallback"`,
  `payoutAllowed:false` (AC-3/AC-6).
- Fila `charged` + `tx_hash` en `a2a_fee_splits` leg `creator` = `payoutWallet` (AC-8).

---

## 5. Patrones a seguir (exemplars verificados)

| Necesitás | Exemplar (path verificado ✓) | Qué copiar / qué NO |
|-----------|------------------------------|----------------------|
| Endpoint | `wasiai-remittance-agents/src/app/api/agents/remit-corridor-fx/invoke/route.ts` | Copiar el patrón exacto (`safeParse→400 flatten`, `{result}` 200, `catch→502 opaco + warn err.name`). **Cambiar** el core a `KycInputSchema/runKycValidator`, el import a `@/agents/kyc-validator`, y el código 502 a `verification_unavailable`. |
| Test (mock 502) | `wasiai-remittance-agents/src/app/api/agents/remit-corridor-fx/invoke/route.test.ts` | Copiar `vi.hoisted` + `vi.mock(...importActual)` + `POST(new NextRequest(...))`. |
| Test NO-PII (core) | `wasiai-remittance-agents/src/agents/kyc-validator.test.ts:19-20` | Espejo HTTP: `JSON.stringify(...).not.toContain("12345678")` + `.not.toContain("travelRuleData")`. |
| README sección | `wasiai-remittance-agents/README.md:58-92` (sección `remit-corridor-fx`) | Molde de la sección KYC (§W2.1). |
| Payload registro | SDD §10 (derivado de `PublishAgentInput`, WKH-171 DONE) | Campos exactos; `slug` NUNCA en el body; `outputSchema` SIN campos PII. |

---

## 6. Tests requeridos (resumen — 7 tests)

`route.test.ts` — 7 tests (§W1.2), todos en modo fallback (Didit OFF, sin red real):
1. body válido → `200 { result }` legible por `data.result ?? data`; `Object.keys` = exactamente los 7 campos (AC-6/AC-3).
2. **NO-PII HTTP (200)** → `JSON.stringify` del body NO contiene `"12345678"` ni `"travelRuleData"` (AC-3/CD-6).
3. Didit OFF → `provenance === "local-fallback"` (AC-4).
4. `NODE_ENV=production` + `ALLOW_FALLBACK_KYC=true` → `payoutAllowed === false` (AC-5, fail-safe).
5. **NO-PII HTTP (400)** → falta `senderCountry` con `legalId:"12345678"` presente → `400 invalid_input`;
   `JSON.stringify(data).not.toContain("12345678")` (AC-7/CD-6).
6. body no-JSON → `400`, no 500 (AC-7).
7. `runKycValidator` lanza → `502 { error:"verification_unavailable" }`; NO filtra `99887766` /
   `didit_adapter_not_ready` / stack (CD-6).

Los tests existentes (`agents/kyc-validator.test.ts`, `providers/*.test.ts`) DEBEN seguir verdes.

---

## 7. Done Definition (F3 — código)

- [ ] W1: `route.ts` creado (fork de `remit-corridor-fx` con core KYC, 502 `verification_unavailable`);
      `route.test.ts` con 7 tests (incl. los 2 NO-PII HTTP: 200 y 400); `npm test` verde (7 nuevos + los
      previos), `npm run typecheck` verde, `npm run build` compila la ruta nueva.
- [ ] W2: `README.md` con la sección "Endpoint HTTP + deploy (etapa 1 — `remit-kyc-validator`)".
- [ ] Cero cambios en `src/agents/*`, `src/providers/*`, el scaffold, `remit-corridor-fx/*`,
      `wasiai-agentshop/*`, `wasiai-a2a/*`.
- [ ] Cero deps nuevas. Sin receipt EIP-712, sin lógica de pago/x402 en el endpoint.
- [ ] Ningún response HTTP expone `legalId` ni `travelRuleData` (CD-6, verificado por tests 2 y 5).
- [ ] Anti-Hallucination Checklist (§2) completo.

**NO es parte de F3** (lo hace el humano vía `!`, CD-7): W3 redeploy Vercel, W4 registro `POST /agents`,
W5 verificación e2e del riel.

---

*Story File generado por NexusAgil — Architect F2.5. Contrato para el Dev (F3).*
