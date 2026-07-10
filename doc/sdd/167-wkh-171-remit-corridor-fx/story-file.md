# Story File — [WKH-171] Publicar `remit-corridor-fx` como agente standalone (etapa 1)

> Contrato autocontenido para el Dev (F3). Implementá **al pie de la letra**, wave por wave.
> Fuente de verdad: `sdd.md` (SPEC_APPROVED). NO reabras decisiones ya cerradas.
> Repo de trabajo (código F3): **`/home/ferdev/.openclaw/workspace/wasiai-remittance-agents/`**
> `wasiai-a2a` = **CERO código** (registro runtime `!` humano, W4).

---

## 0. Contexto compacto (qué se construye y por qué)

`remit-corridor-fx` hoy es una **librería TS pura** (`runCorridorFx` + `FallbackFxProvider`) sin servidor
HTTP → NO es invocable por el gateway A2A. Esta HU le agrega **Next.js App Router** y crea **un único
endpoint** que envuelve la lógica ya existente y honra el contrato `POST /invoke → 200 { result: {...} }`
(legible por `data.result ?? data` en `wasiai-a2a/src/services/compose.ts:892-893`).

El agente cotiza USDC→PEN con **FX mid real** (`open.er-api.com`) + spread declarado
(`FALLBACK_FX_SPREAD_BPS`). TransFi queda **OFF** (etapa 2). El pago es vía **a2a-key prepago** → cero
código en el gateway. El registro (`POST /agents`) y el deploy son **pasos manuales `!` del humano** (W3/W4).

**NO se reimplementa lógica FX.** `src/agents/corridor-fx.ts` y `src/providers/*` **NO se tocan**.

---

## 1. Scope IN — archivos exactos a tocar (repo `wasiai-remittance-agents`)

| # | Archivo | Acción | Wave |
|---|---------|--------|------|
| 1 | `package.json` | Modificar (deps + scripts) | W0 |
| 2 | `tsconfig.json` | Modificar (Next + alias `@`) | W0 |
| 3 | `next.config.mjs` | Crear | W0 |
| 4 | `.gitignore` | Crear | W0 |
| 5 | `vitest.config.ts` | **Crear** (alias `@` — load-bearing, ver §Anti-Hallucination) | W0 |
| 6 | `src/app/layout.tsx` | Crear (mínimo) | W0 |
| 7 | `src/app/page.tsx` | Crear (landing informativa, sin lógica) | W0 |
| 8 | `src/app/api/agents/remit-corridor-fx/invoke/route.ts` | **Crear (endpoint principal)** | W1 |
| 9 | `src/app/api/agents/remit-corridor-fx/invoke/route.test.ts` | Crear (5 tests) | W1 |
| 10 | `README.md` | Modificar (sección endpoint + deploy) | W2 |

**PROHIBIDO tocar** (CD-1/CD-2/CD-3):
- `src/agents/corridor-fx.ts`, `src/providers/fx.ts`, `src/providers/types.ts` (ya listos).
- Cualquier archivo de `wasiai-agentshop` / `agentshop-*`.
- Cualquier archivo de `wasiai-a2a` (ni `agent.ts`, ni `agents.ts`, ni `compose.ts`, ni `types`).

---

## 2. Anti-Hallucination Checklist (específico de esta HU)

Antes de dar por terminada una wave, verificá:

- [ ] El endpoint importa **solo símbolos reales** de `@/agents/corridor-fx`: `CorridorFxInputSchema`
      y `runCorridorFx`. **Ambos existen y están exportados** (`src/agents/corridor-fx.ts:13,31`). NO inventes otros.
- [ ] `CorridorFxOutput` = `FxQuote & { slug }`. Los campos del `result` son EXACTAMENTE:
      `slug, rate, feeUsd, netDeliveredLocal, localCurrency (="PEN"), etaMinutes, quoteId, expiresAt, provenance`
      (`src/providers/types.ts:45-54` + `corridor-fx.ts:22-24`). NO agregues/renombres campos.
- [ ] **NO** hay bloque de receipt EIP-712 en el endpoint. El repo **no tiene** `agent-signer`
      (a diferencia del exemplar cobraya, líneas 5-6/53-77 — que SÍ lo tiene). Forkeá cobraya **sin** ese bloque.
- [ ] **NO** hay lógica de pago / x402 / on-chain / Supabase / viem en el endpoint. Eso lo hace el gateway.
- [ ] El endpoint envuelve la salida en `{ result }` (CD-7). NO devuelvas el output "pelado".
- [ ] `vitest.config.ts` existe con alias `@ → ./src` — **sin él `route.test.ts` NO resuelve `@/agents/corridor-fx`**
      (el repo hoy NO tiene vitest.config; los tests actuales usan imports relativos). Exemplar: `wasiai-agentshop/vitest.config.ts`.
- [ ] `FALLBACK_FX_SPREAD_BPS` / `FALLBACK_FX_FLAT_FEE_USD` se leen dentro de `fx.ts` (NO en el endpoint).
      El endpoint **no** referencia estas env vars directamente.
- [ ] Ningún hardcode de tasa/rate/PEN en el endpoint ni en el test (salvo el mid mockeado en el test).
- [ ] *(blindaje WKH-133)*: no introducir `Number()` sobre dato externo sin guard — el guard `assertValidQuote`
      ya está en el camino (`fx.ts:99`), NO bypassearlo ni removerlo.
- [ ] *(blindaje WKH-134)*: en el route no construir objetos con `x: cond ? v : undefined` (usar asignación condicional).
- [ ] Deps agregadas = **solo** `next`, `react`, `react-dom`, `@types/react`, `@types/react-dom`.
      **NO** agregar `@supabase/*`, `viem`, ni SDK de pago (CD-2).

---

## 3. Waves

### Wave 0 — Scaffolding Next.js (serial, gate de compilación)

Objetivo: convertir la lib TS pura en un proyecto Next 14 App Router **sin romper los tests existentes**.

#### W0.1 — `package.json` (Modificar → contenido final completo)

```json
{
  "name": "wasiai-remittance-agents",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Agentes reales del pipeline de remesas de Chaski (v2, en paralelo al demo). Providers Didit/TransFi con fallback determinístico.",
  "scripts": {
    "dev": "next dev -p 3030",
    "build": "next build",
    "start": "next start -p 3030",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "next": "14.2.5",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "@types/react": "18.3.3",
    "@types/react-dom": "18.3.0",
    "typescript": "^5.6.2",
    "vitest": "^2.1.1"
  }
}
```

> Puerto `3030` (evita colisión con cobraya `3010` y agentshop `3020`). Mantener `type:"module"` y `zod`.

#### W0.2 — `tsconfig.json` (Modificar → contenido final completo)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": false,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"] },
    "types": ["node"]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

> Conserva la rigurosidad del repo (`noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes:false`)
> y suma lo de Next (agentshop/lendable tsconfig): `jsx`, `plugins`, `paths`, `incremental`, includes.
> Si `tsc --noEmit` se queja de tipos globales de React con `"types": ["node"]`, quitá esa línea
> (Next no la setea) — el resto queda igual.

#### W0.3 — `next.config.mjs` (Crear)

Exemplar: `wasiai-agentshop/next.config.mjs`.

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
};

export default nextConfig;
```

#### W0.4 — `.gitignore` (Crear)

```
node_modules/
.next/
out/
build/
dist/
.vercel/

.env
.env.local
.env*.local

*.log
.DS_Store
.vscode/
.idea/

next-env.d.ts
```

#### W0.5 — `vitest.config.ts` (Crear — LOAD-BEARING)

Exemplar: `wasiai-agentshop/vitest.config.ts`. Sin esto, `route.test.ts` NO resuelve `@/agents/corridor-fx`.

```ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

> `include: ["src/**/*.test.ts"]` sigue cubriendo los tests existentes (`agents/corridor-fx.test.ts`,
> `providers/fx.test.ts`). `environment: "node"` es correcto (no hay tests de UI).

#### W0.6 — `src/app/layout.tsx` (Crear — mínimo, presentación)

Exemplar: `wasiai-agentshop/src/app/layout.tsx` (versión reducida, **sin** `import "./globals.css"` para no crear ese archivo).

```tsx
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "remit-corridor-fx · WasiAI A2A agent",
  description: "USDC→PEN remittance corridor FX quote agent (A2A protocol).",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

#### W0.7 — `src/app/page.tsx` (Crear — landing informativa, server component, sin lógica)

```tsx
export default function Home() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24, lineHeight: 1.5 }}>
      <h1>remit-corridor-fx</h1>
      <p>USDC→PEN remittance corridor FX quote agent — WasiAI A2A protocol.</p>
      <p>
        Invoke: <code>POST /api/agents/remit-corridor-fx/invoke</code>
      </p>
    </main>
  );
}
```

**Verificación W0** (todo debe pasar antes de W1):
```
npm install
npm run typecheck    # tsc --noEmit → verde
npm run build        # next build → compila (App Router + route dummy aún no existe, OK)
npm test             # vitest → los 2 tests existentes (corridor-fx, fx) siguen VERDES
```

---

### Wave 1 — Endpoint + tests (depende de W0)

#### W1.1 — `src/app/api/agents/remit-corridor-fx/invoke/route.ts` (Crear — ENDPOINT PRINCIPAL)

Exemplar: `wasiai-lendable/src/app/api/agents/cobraya-credit-scorer/invoke/route.ts` **SIN el bloque de receipt EIP-712**.

Contenido exacto:

```ts
// src/app/api/agents/remit-corridor-fx/invoke/route.ts
// Endpoint HTTP del agente remit-corridor-fx. Envuelve runCorridorFx (lib pura) y honra el
// contrato a2a: POST /invoke → 200 { result: {...} } (legible por data.result ?? data en compose.ts).
// Fork de cobraya-credit-scorer SIN receipt EIP-712 (este repo no tiene agent-signer).
import { NextRequest, NextResponse } from "next/server";
import { CorridorFxInputSchema, runCorridorFx } from "@/agents/corridor-fx";

export async function POST(req: NextRequest) {
  const parsed = CorridorFxInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await runCorridorFx(parsed.data);
    return NextResponse.json({ result }, { status: 200 });
  } catch (err) {
    // El core puede lanzar por assertValidQuote (NaN/monto inválido) o misconfig de env
    // (transfi_adapter_not_ready). Nunca un 500 crudo. Warn estructurado sin stack (patrón cobraya).
    console.warn("[remit-corridor-fx] quote failed:", {
      errorName: err instanceof Error ? err.name : "unknown",
    });
    return NextResponse.json({ error: "quote_unavailable" }, { status: 502 });
  }
}
```

Reglas:
- `safeParse` para el **400 estructurado** (AC-7). `runCorridorFx` re-parsea internamente (idempotente, `corridor-fx.ts:32`) — no es doble validación problemática.
- Envolver en `{ result }` (AC-6 / CD-7).
- `catch → 502 { error: "quote_unavailable" }` (AC-7 espíritu: nunca 500 sin manejar).
- **NO** agregar `runtime`/`dynamic` exports salvo que `next build` lo exija (default nodejs sirve fetch/AbortSignal).

#### W1.2 — `src/app/api/agents/remit-corridor-fx/invoke/route.test.ts` (Crear — 5 tests)

Exemplar del mock: `src/agents/corridor-fx.test.ts` (fetch + env stub). Invoca el handler con `NextRequest` (no server real).

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

const ENDPOINT = "http://localhost/api/agents/remit-corridor-fx/invoke";

function invoke(body: unknown) {
  return POST(
    new NextRequest(ENDPOINT, { method: "POST", body: JSON.stringify(body) }),
  );
}

describe("POST /api/agents/remit-corridor-fx/invoke", () => {
  beforeEach(() => {
    vi.stubEnv("TRANSFI_API_KEY", ""); // fallback (FX mid real mockeado)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ rates: { PEN: 3.8 } }) })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // AC-6: body válido → 200 { result } legible por data.result
  it("body válido → 200 { result } legible por data.result", async () => {
    const res = await invoke({ amountUsd: 100 });
    expect(res.status).toBe(200);
    const data = await res.json();
    const output = data.result ?? data; // contrato compose.ts:893
    expect(output.slug).toBe("remit-corridor-fx");
    expect(output.localCurrency).toBe("PEN");
    expect(Number.isFinite(output.rate)).toBe(true);
    expect(output.netDeliveredLocal).toBeGreaterThan(0);
    expect(output.quoteId).toBeTruthy();
  });

  // AC-3: rate deriva del mid real + spread (no hardcode)
  it("rate deriva del mid real + spread declarado", async () => {
    const res = await invoke({ amountUsd: 100 });
    const { result } = await res.json();
    // mid mockeado 3.8, spread default 250 bps → 3.8*(1-0.025)=3.705 (spread en contra)
    expect(result.rate).toBeLessThan(3.8);
    expect(result.rate).toBeGreaterThan(3.6);
  });

  // AC-4: TransFi OFF → provenance local-fallback
  it("TransFi OFF → provenance local-fallback", async () => {
    const res = await invoke({ amountUsd: 100 });
    const { result } = await res.json();
    expect(result.provenance).toBe("local-fallback");
  });

  // AC-7: amountUsd<=0 → 400 estructurado (no 500)
  it("amountUsd<=0 → 400 estructurado", async () => {
    const res = await invoke({ amountUsd: -5 });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid_input");
    expect(data.details).toBeTruthy();
  });

  // AC-7: body no-JSON → 400 (no 500)
  it("body no-JSON → 400 (no 500)", async () => {
    const res = await POST(
      new NextRequest(ENDPOINT, { method: "POST", body: "not-json{" }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid_input");
  });
});
```

Notas de test:
- `FALLBACK_FX_SPREAD_BPS` se lee a nivel módulo en `fx.ts:10` (const top-level) → en test queda el **default 250**
  (no lo stubeamos). Por eso el rango `3.6 < rate < 3.8` con mid 3.8. NO stubear esa env.
- `new NextRequest(...)` es type-correct (extiende `Request`); evita el cast `as NextRequest`.
- El cache de `getUsdToPenMid` (`fx.ts:73`) es por-módulo; vitest aísla el módulo por archivo → sin flakiness (todos los tests usan 3.8).

**Verificación W1**:
```
npm test          # 5 tests nuevos VERDES + los 2 existentes (agents/providers) siguen verdes
npm run typecheck # verde
npm run build     # next build compila con el route real
```

---

### Wave 2 — Docs (depende de W1)

#### W2.1 — `README.md` (Modificar — agregar sección)

Agregá una sección **"Endpoint HTTP + deploy (etapa 1 — `remit-corridor-fx`)"** al README existente. Contenido:

```markdown
## Endpoint HTTP + deploy (etapa 1 — `remit-corridor-fx`)

El agente `remit-corridor-fx` ya es invocable vía Next.js App Router:

```
POST /api/agents/remit-corridor-fx/invoke
body: { "amountUsd": 100, "destCountry": "PE", "payoutMethod": "yape" }  # solo amountUsd es requerido
→ 200 { "result": { "slug", "rate", "feeUsd", "netDeliveredLocal", "localCurrency": "PEN",
                     "etaMinutes", "quoteId", "expiresAt", "provenance" } }
→ 400 { "error": "invalid_input", "details": {...} }   # body inválido (ej. amountUsd <= 0)
→ 502 { "error": "quote_unavailable" }                 # falla del provider / misconfig
```

Etapa 1 corre 100% en **fallback FX** (`provenance: "local-fallback"`): FX mid real de
`open.er-api.com` + spread declarado. **Sin** receipt EIP-712 y **sin** lógica de pago/x402 del lado
del agente (eso lo hace el gateway a2a). TransFi queda para etapa 2.

### Correr local
`npm run dev` → `http://localhost:3030/api/agents/remit-corridor-fx/invoke`

### Deploy (Vercel, proyecto NUEVO — separado de wasiai-agentshop)
Env vars (ver §Env vars del deploy). El `agent_url` a registrar es
`https://<deploy-nuevo>.vercel.app/api/agents/remit-corridor-fx/invoke`.
```

> Aclará en el README que el patrón "…→ receipt EIP-712 → { result }" descrito arriba en el doc
> aplica a los agentes con `agent-signer`; `remit-corridor-fx` etapa 1 **omite** el receipt.

**Verificación W2**: consistencia del contrato documentado con `route.ts`.

---

## 4. Artefactos para las waves MANUALES (`!` humano — NO las ejecuta el Dev/pipeline, CD-6)

> W3, W4, W5 son mutaciones de infra/prod. El Dev **documenta** estos artefactos pero **NO los ejecuta**.

### W3 — Deploy Vercel (nuevo proyecto) — Env vars

```
FALLBACK_FX_SPREAD_BPS=250        # spread declarado (bps). Si se omite, el código usa 250.
FALLBACK_FX_FLAT_FEE_USD=0.5      # fee flat USD. Si se omite, el código usa 0.5.
STATIC_USD_PEN=3.75               # (opcional) fallback si open.er-api.com falla

# PROHIBIDO setear en esta HU (CD-4 / CD-5 / fuera de scope):
# TRANSFI_API_KEY          ← NO setear
# TRANSFI_ADAPTER_READY    ← NO setear (debe quedar != "true")
# AGENT_SIGNER_PRIVATE_KEY ← NO necesario (sin receipt en etapa 1)
```

Smoke post-deploy:
```
curl -X POST https://<deploy-nuevo>.vercel.app/api/agents/remit-corridor-fx/invoke \
  -H 'content-type: application/json' -d '{"amountUsd":100}'
# → 200 { "result": { ... "provenance": "local-fallback" ... } }
```

### W4 — Registro `POST /agents` (contra prod Railway, a2a-key autenticado)

> `slug` NO se manda: se deriva de `name` vía `name.toLowerCase().replace(/\s+/g,'-')` (`agent.ts:337`).
> `name` = `"remit-corridor-fx"` byte-idéntico ⇒ slug `remit-corridor-fx` (CD-3).

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

- `priceUsdc: 0.03` = `PRICE_USDC` exportado en `corridor-fx.ts:11`.
- `payoutWallet` = wallet EVM **testnet** del creator (lo aporta el humano — Missing Input #3) → habilita leg `creator` del split (AC-5).
- `inputSchema`/`outputSchema` derivados de `CorridorFxInputSchema` / `CorridorFxOutput`.

### W4.2 / W5 — Verificación (QA F4, evidencia archivo:línea / fila DB)
- `POST /discover` (o `GET /agents/remit-corridor-fx/agent-card`) muestra `remit-corridor-fx` `status:active`,
  sin afectar `agentshop-*` (AC-1/AC-2).
- `/compose` con a2a-key y `steps[0]=remit-corridor-fx` → cotización real `provenance:"local-fallback"` (AC-3/AC-6).
- Fila `charged` + `tx_hash` en `a2a_fee_splits` leg `creator` = `payoutWallet` (AC-5).

---

## 5. Patrones a seguir (exemplars verificados)

| Necesitás | Exemplar (path verificado) | Qué copiar / qué NO |
|-----------|----------------------------|----------------------|
| Endpoint | `wasiai-lendable/src/app/api/agents/cobraya-credit-scorer/invoke/route.ts` | Copiar: `safeParse→400`, `NextResponse.json`. **NO copiar**: import de `agent-signer`, bloque `signReceipt` (líneas 5-6, 53-77). |
| Test del endpoint | `wasiai-remittance-agents/src/agents/corridor-fx.test.ts` | Copiar el `vi.stubEnv`+`vi.stubGlobal(fetch, PEN:3.8)`. Adaptar a `POST(new NextRequest(...))`. |
| `next.config.mjs` / `layout.tsx` / `vitest.config.ts` / `.gitignore` | `wasiai-agentshop/*` | Versiones mínimas (§3). |
| `tsconfig.json` Next | `wasiai-agentshop/tsconfig.json` + rigor del repo actual | §W0.2. |
| Payload registro | `PublishAgentInput` (`wasiai-a2a/src/types/index.ts:118-140`) | Campos exactos; `slug` NUNCA en el body. |

---

## 6. Tests requeridos (resumen)

`route.test.ts` — 5 tests (§W1.2), todos en modo fallback (TransFi OFF, fetch stubeado, sin red real):
1. body válido → `200 { result }` legible por `data.result ?? data`; `result` matchea `CorridorFxOutput` (AC-6).
2. `rate` deriva del mid mockeado 3.8 + spread 250 bps (`3.6 < rate < 3.8`), no hardcode (AC-3).
3. TransFi OFF → `provenance === "local-fallback"` (AC-4).
4. `amountUsd:-5` → `400 { error:"invalid_input", details }`, no 500 (AC-7).
5. body no-JSON → `400`, no 500 (AC-7).

Los tests existentes (`agents/corridor-fx.test.ts`, `providers/fx.test.ts`) DEBEN seguir verdes.

---

## 7. Done Definition (F3 — código)

- [ ] W0: `npm install` OK; `npm run typecheck` verde; `npm run build` compila; `npm test` (2 tests previos) verde.
- [ ] W1: `route.ts` creado (fork cobraya sin receipt); `route.test.ts` con 5 tests; `npm test` verde (7 total); `typecheck` + `build` verdes.
- [ ] W2: `README.md` con la sección endpoint + deploy + env vars.
- [ ] Cero cambios en `src/agents/*`, `src/providers/*`, `wasiai-agentshop/*`, `wasiai-a2a/*`.
- [ ] Cero deps fuera de `next`/`react`/`react-dom` + types.
- [ ] Sin receipt EIP-712, sin lógica de pago en el endpoint.
- [ ] Anti-Hallucination Checklist (§2) completo.

**NO es parte de F3** (lo hace el humano vía `!`): W3 deploy, W4 registro `POST /agents`, W5 verificación e2e.

---

*Story File generado por NexusAgil — Architect F2.5. Contrato para el Dev (F3).*
