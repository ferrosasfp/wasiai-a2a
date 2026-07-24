# Story File — [WKH-172] Publicar `remit-cashout-payout` como agente standalone (etapa 1 / payout MOCK)

> SDD: `doc/sdd/170-wkh-172-remit-cashout-payout/sdd.md` (SPEC_APPROVED)
> Fecha: 2026-07-10
> Branch: `feat/170-wkh-172-remit-cashout-payout`
> Contrato autocontenido para el Dev (F3). Implementá **al pie de la letra**, wave por wave. NO reabras
> decisiones cerradas. Si algo no está acá → PARÁ y escalá al Architect (§ Escalation).
> Repo de trabajo (código F3): **`/home/ferdev/.openclaw/workspace/wasiai-remittance-agents/`**
> `wasiai-a2a` = **CERO código** (registro runtime `!` humano, W4).

---

## 0. Goal (qué se construye y por qué)

`remit-cashout-payout` hoy es una **librería TS pura** (`runCashoutPayout` + `FallbackPayoutProvider`, en
`src/agents/cashout-payout.ts`) sin servidor HTTP → NO es invocable por el gateway A2A. Esta HU agrega **un
endpoint** Next.js App Router que envuelve la lógica ya existente y honra el contrato
`POST /invoke → 200 { result: {...} }` (legible por `data.result ?? data` en `wasiai-a2a/src/services/compose.ts`),
cerrando el trío `remit-*` (FX + KYC + **Payout**) sobre el leg más sensible: el desembolso.

**El eje novedoso de esta HU** (no presente en WKH-170/171) es el **flag `PAYOUT_ALLOW_MOCK`**. El fail-safe
`assertPayoutProviderSafe()` (`cashout-payout.ts:48-61`) hoy lanza `payout_refused` **incondicionalmente** en
`NODE_ENV==='production'` sin provider real. Vercel fija `NODE_ENV=production` en todo deploy → el mock NUNCA
correría → todo invoke daría 502. Se introduce un opt-in **ACOTADO y ruidoso** `PAYOUT_ALLOW_MOCK=true` que,
SOLO en la rama prod, permite proceder al **mock** (jamás al real). Este cambio es la **ÚNICA excepción** al
"no tocar el core" y el **objeto obligatorio del Adversary Review**.

**Contexto ya resuelto (NO reabrir):** scaffold Next 14 YA EXISTE (WKH-171/170 en este mismo repo). Pago =
a2a-key prepago → cero código en el gateway. TransFi real = etapa 2 (WKH-168), OFF. Registro (`POST /agents`)
y deploy = pasos manuales `!` del humano (W3/W4). **NO se reimplementa** payout, hard-gate KYC ni idempotencia:
ya existen y están testeados.

**Eje crítico NO-PII (CD-6):** ningún response HTTP (200/400/502) ni log puede exponer `beneficiary.name`,
`beneficiary.destination` (Yape/CCI) ni `travelRuleData`. El core ya está blindado (output = 8 campos sin PII).
El riesgo nuevo vive en el **wrapper HTTP**: el 400 no debe ecoar el `beneficiary`; el 502 no debe filtrar
`err.message`/body.

---

## 1. Acceptance Criteria (EARS) — copiados del SDD aprobado

- **AC-1**: WHEN un caller consulta `POST /discover` en `wasiai-a2a`, THE system SHALL devolver
  `remit-cashout-payout` como agente activo (`status:active`, `enabled:true`), sin reemplazar a
  `agentshop-cashout-matcher`. *(registro runtime — QA F4)*
- **AC-2**: WHEN se registra vía `POST /agents`, THE system SHALL persistir una fila NUEVA en `a2a_agents` con
  slug EXACTO `remit-cashout-payout`, sin modificar filas `agentshop-*`. *(registro runtime — QA F4)*
- **AC-3**: WHEN se invoca con `kycPayoutAllowed:false`, THE system SHALL responder `200` con
  `result.executed:false`, `result.status:"blocked"`, `result.reason:"kyc_gate_not_passed"`, y NUNCA invocar
  al payout provider. *(test HTTP)*
- **AC-4**: WHEN se invoca con `kycPayoutAllowed:true` e input válido, THE system SHALL responder `200` con un
  `result` que contenga EXCLUSIVAMENTE `slug, executed, status, payoutId, deliveredLocal, txRef, reason,
  provenance` — y NUNCA `beneficiary.name`, `beneficiary.destination` ni `travelRuleData` en ninguna respuesta
  (200/400/502) ni logs. *(test HTTP)*
- **AC-5**: WHEN se invoca dos veces con el mismo `idempotencyKey`, THE system SHALL devolver el mismo
  `payoutId` determinístico (`fallback-${idempotencyKey}`). *(test HTTP)*
- **AC-6**: IF prod (`NODE_ENV==='production'`) sin provider real **y sin** `PAYOUT_ALLOW_MOCK=true`, THEN THE
  system SHALL rechazar (`502`, `payout_refused` interno) — el mock NUNCA corre silenciosamente. **[Opción A]**
  WHILE el deploy corra con `PAYOUT_ALLOW_MOCK=true` (TransFi OFF), THE system SHALL ejecutar el mock
  (`provenance:"local-fallback"`, `deliveredLocal:null`, `txRef:null`) — y NUNCA un desembolso real (path real
  100% gated por `TRANSFI_API_KEY`+`TRANSFI_ADAPTER_READY`, independiente del flag). *(tests core + HTTP)*
- **AC-7**: IF la invocación como step pago falla (502/excepción), THEN el gateway SHALL acreditar el monto
  debitado vía `refund-outbox.ts` (WKH-127/128/129), sin código nuevo en `wasiai-a2a`. *(heredado — QA F4)*
- **AC-8**: IF el body falla Zod, THEN THE system SHALL responder `400` con error estructurado (`.flatten()`
  únicamente) que NO ecoe `beneficiary.name`/`beneficiary.destination`, nunca un 500 sin manejar. *(test HTTP)*
- **AC-9**: WHEN un pipeline con `steps[0]=remit-cashout-payout` completa con éxito Y hay `payoutWallet`, THE
  system SHALL liquidar el leg `creator` (1%) a esa wallet, auditable en `a2a_fee_splits`. *(heredado — QA F4)*

---

## 2. Files to Create/Modify — archivos exactos (repo `wasiai-remittance-agents`)

| # | Archivo | Acción | Qué hacer | Wave | Exemplar |
|---|---------|--------|-----------|------|----------|
| 1 | `src/agents/cashout-payout.ts` (l.48-61) | **Modificar (ACOTADO)** | Opt-in `PAYOUT_ALLOW_MOCK` en la rama `NODE_ENV==='production'` de `assertPayoutProviderSafe()`. ÚNICO cambio de core. §W0. | W0 | El bloque existente (§W0) |
| 2 | `src/app/api/agents/remit-cashout-payout/invoke/route.ts` | **Crear** | Endpoint principal. Fork de `remit-kyc-validator/invoke/route.ts`. §W1.1. | W1 | `remit-kyc-validator/invoke/route.ts` ✓ |
| 3 | `src/app/api/agents/remit-cashout-payout/invoke/route.test.ts` | **Crear** | 9 tests HTTP (§W1.2). | W1 | `remit-kyc-validator/invoke/route.test.ts` ✓ |
| 4 | `src/agents/cashout-payout.test.ts` | **Modificar (extender)** | +3 tests del flag (§W1.3). | W1 | Los tests existentes del archivo |
| 5 | `README.md` | Modificar (menor) | Sección "Endpoint HTTP + deploy (etapa 1 — `remit-cashout-payout`)". §W2.1. | W2 | Sección `remit-kyc-validator` del README |

**PROHIBIDO tocar** (CD-1/CD-2/CD-4/CD-10 + scaffold ya existe):
- `src/providers/payout.ts`, `src/providers/types.ts` (el flag vive SOLO en `cashout-payout.ts`).
- `resolveTravelRuleData()` (`cashout-payout.ts:114-122`, stub) — CD-10.
- El hard-gate KYC (`cashout-payout.ts:71-82`) — ya correcto, sin override.
- El scaffold: `package.json`, `tsconfig.json`, `next.config.mjs`, `vitest.config.ts`, `src/app/layout.tsx`,
  `src/app/page.tsx` (ya existen — NO re-scaffoldar).
- `src/app/api/agents/remit-corridor-fx/**` y `remit-kyc-validator/**` (hermanos — solo se **leen** como exemplar).
- Cualquier archivo de `wasiai-agentshop` / `agentshop-cashout-matcher` (CD-1).
- Cualquier archivo de `wasiai-a2a` (CD-2: ni `orchestrate.ts`, ni `compose.ts`, ni `refund-outbox.ts`).

---

## 3. Contrato de Integración ⚠️ BLOQUEANTE

> Esta HU tiene comunicación entre componentes: **gateway A2A (`compose.ts`) → endpoint del agente**.

### Gateway A2A → `POST /api/agents/remit-cashout-payout/invoke`

**Request body (input del step, validado por `CashoutPayoutInputSchema` — `cashout-payout.ts:17-29`):**
```json
{
  "quoteId": "string (min 1)",
  "amountUsd": "number (> 0)",
  "kycVerificationId": "string (min 1)",
  "kycPayoutAllowed": "boolean — hard-gate KYC provisto por el caller/pipeline",
  "beneficiary": {
    "name": "string (min 1) — PII, NUNCA se ecoa de vuelta",
    "country": "string (min 2)",
    "method": "yape | plin | bank_cci",
    "destination": "string (min 1) — Yape/CCI, PII, NUNCA se ecoa de vuelta"
  },
  "idempotencyKey": "string (min 1)"
}
```

**Response exitoso (200) — `{ result }`, output = 8 campos exactos (`CashoutPayoutOutput`, `cashout-payout.ts:33-42`):**
```json
{
  "result": {
    "slug": "remit-cashout-payout",
    "executed": true,
    "status": "settled",
    "payoutId": "fallback-<idempotencyKey>",
    "deliveredLocal": null,
    "txRef": null,
    "reason": null,
    "provenance": "local-fallback"
  }
}
```
> Caso hard-gate (`kycPayoutAllowed:false`): también `200`, con `executed:false`, `status:"blocked"`,
> `reason:"kyc_gate_not_passed"`, `payoutId:null`, `provenance:"n/a"` (`cashout-payout.ts:72-81`).

**Errores:**
| HTTP | Body | Cuándo |
|------|------|--------|
| 400 | `{ "error": "invalid_input", "details": <Zod flatten> }` | Body falla Zod / no-JSON. `details` = SOLO `parsed.error.flatten()` (value-free). |
| 502 | `{ "error": "payout_unavailable" }` | El core lanza (`payout_refused` sin flag / `transfi_adapter_not_ready`). Body FIJO opaco. |

---

## 4. Anti-Hallucination Checklist (específico de esta HU)

Verificá cada símbolo con archivo:línea antes de cerrar cada wave:

- [ ] El endpoint importa **solo símbolos reales** de `@/agents/cashout-payout`: `CashoutPayoutInputSchema`
      (`cashout-payout.ts:17`, exportado) y `runCashoutPayout` (`cashout-payout.ts:67`, exportado). NO importes
      `CashoutPayoutOutput` (es `interface` de solo tipo, `:33`) ni `SLUG`/`PRICE_USDC` (no se usan en el route).
- [ ] Firma real: `runCashoutPayout(raw: unknown): Promise<CashoutPayoutOutput>` (`cashout-payout.ts:67`).
- [ ] Los campos del `result` son EXACTAMENTE 8 (`cashout-payout.ts:33-42`): `slug, executed, status, payoutId,
      deliveredLocal, txRef, reason, provenance`. **SIN** `beneficiary` **ni** `travelRuleData`. NO agregues/renombres.
- [ ] El 400 usa **SOLO** `parsed.error.flatten()`. **PROHIBIDO** `parsed.data`, el body crudo, `parsed.error.issues`
      transformado, `parsed.error.message` concatenado, o mensajes custom que interpolen el valor (CD-6).
      `CashoutPayoutInputSchema` se reutiliza **tal cual** (no se modifica; usa `.min()`/`.positive()`/`.enum()`
      sin mensajes custom → mensajes Zod value-free como `"Required"`).
- [ ] El 502 tiene body **fijo** `{ error: "payout_unavailable" }` + `console.warn` con **SOLO** `err.name`.
      **PROHIBIDO** `err.message`, `err.stack`, el input o el body en el log o response (CD-6).
- [ ] El código de error 502 es `"payout_unavailable"` (NO `"verification_unavailable"` — ese es de KYC; NO
      `"quote_unavailable"` — ese es de FX).
- [ ] El endpoint envuelve la salida en `{ result }` (CD-8). NO devuelvas el output "pelado".
- [ ] El flag nuevo se llama **`PAYOUT_ALLOW_MOCK`** (≠ `ALLOW_FALLBACK_PAYOUT`, CD-11). Vive SOLO dentro de la
      rama `NODE_ENV==='production'`. La rama dev (`ALLOW_FALLBACK_PAYOUT`) y el bloque `hasReal` quedan **byte-idénticos**.
- [ ] **NO** hay bloque de receipt EIP-712. **NO** hay lógica de pago/x402/on-chain/Supabase/viem en el endpoint.
- [ ] **NO** se leen env vars de payout en el route (`TRANSFI_API_KEY`/`PAYOUT_ALLOW_MOCK`/`ALLOW_FALLBACK_PAYOUT`).
      El core las resuelve dentro de `assertPayoutProviderSafe()` / `getPayoutProvider()`. El route no las referencia.
- [ ] **NO** se agregan deps nuevas (Next/React/zod/vitest ya están). NO `@supabase/*`, NO `viem`, NO SDK de pago.
- [ ] Debe existir ≥1 test NO-PII a nivel HTTP en el **200**, el **400** y el **502** (CD-6, tests 3/8/9 de §W1.2).

> **Símbolos verificados (para que NO alucines):**
> - `cashout-payout.ts:14` `SLUG="remit-cashout-payout"` · `:15` `PRICE_USDC=0.03` · `:17-29`
>   `CashoutPayoutInputSchema` (`quoteId, amountUsd, kycVerificationId, kycPayoutAllowed, beneficiary{name,
>   country, method, destination}, idempotencyKey`) · `:33-42` `CashoutPayoutOutput` (8 campos, sin PII) ·
>   `:48-61` `assertPayoutProviderSafe()` (sede del flag) · `:67` `runCashoutPayout` · `:71-82` hard-gate KYC.
> - `providers/payout.ts:68-89` `FallbackPayoutProvider` (`payoutId:fallback-${idempotencyKey}`,
>   `deliveredLocal:null`, `txRef:null`, `provenance:"local-fallback"`) · `:108-118` `getPayoutProvider()`
>   (sin `TRANSFI_API_KEY` → fallback; con key sin `TRANSFI_ADAPTER_READY==='true'` → **lanza**
>   `transfi_adapter_not_ready`).
> - `remit-kyc-validator/invoke/route.ts` (exemplar byte-a-byte del endpoint, VERIFICADO ✓).
> - `remit-kyc-validator/invoke/route.test.ts` (exemplar del test HTTP con `vi.hoisted`+`vi.mock`, VERIFICADO ✓).

---

## 5. Waves

### Wave -1: Environment Gate (verificar antes de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-remittance-agents
npm install 2>/dev/null || echo "Sin package.json"
# Los archivos base del Scope IN existen:
ls src/agents/cashout-payout.ts src/providers/payout.ts \
   src/app/api/agents/remit-kyc-validator/invoke/route.ts 2>/dev/null || echo "FALTA archivo base"
# La carpeta del endpoint nuevo NO debe existir todavía:
ls src/app/api/agents/remit-cashout-payout 2>/dev/null && echo "OJO: ya existe" || echo "OK: no existe aún"
```
**Si algo falla:** PARAR y reportar al orquestador. No implementar sobre entorno roto.

---

### Wave 0 (Serial Gate — flag primero; los tests de W1 dependen de él)

#### W0.1 — `src/agents/cashout-payout.ts` (Modificar l.48-61) — opt-in `PAYOUT_ALLOW_MOCK`

> ÚNICO cambio de core. **AR obligatorio** (CD-7). El `hasReal` y la rama dev quedan byte-idénticos.
> Este es el diseño §4.3 del SDD: `hasReal` retorna PRIMERO → el flag SOLO elige throw-vs-mock, jamás mock-vs-real.

**Reemplazá EXACTAMENTE este bloque (la rama prod actual, `cashout-payout.ts:52-54`):**

```ts
  if (process.env.NODE_ENV === "production") {
    throw new Error("payout_refused: se requiere provider de payout REAL en producción (no fallback)");
  }
```

**Por este (agrega el opt-in dentro de la MISMA rama prod):**

```ts
  if (process.env.NODE_ENV === "production") {
    // ⚠️ SEGURIDAD MONEY-PATH (WKH-172, etapa 1): PAYOUT_ALLOW_MOCK habilita SOLO el
    // FallbackPayoutProvider (mock, NUNCA mueve plata). NO abre ningún path a desembolso real:
    // el path real sigue 100% gated por TRANSFI_API_KEY + TRANSFI_ADAPTER_READY (chequeado arriba
    // vía hasReal, y de nuevo en getPayoutProvider()). Activar este flag en CUALQUIER deploy que
    // no sea el de etapa 1 (mock) es un INCIDENTE DE SEGURIDAD money-path.
    if (process.env.PAYOUT_ALLOW_MOCK !== "true") {
      throw new Error("payout_refused: se requiere provider de payout REAL en producción (no fallback)");
    }
    console.warn(
      "[remit-payout] PROD + PAYOUT_ALLOW_MOCK: usando payout FALLBACK (mock, NO mueve plata) — SOLO etapa 1",
    );
    return;
  }
```

Reglas (NO negociables):
- **NO** toques la línea `const hasReal = ...` ni el `if (hasReal) return;` (l.49-51) — quedan idénticos.
- **NO** toques la rama dev `if (process.env.ALLOW_FALLBACK_PAYOUT !== "true") {...}` + su `console.warn`
  (l.55-60) — quedan byte-idénticos. NO renombres `ALLOW_FALLBACK_PAYOUT` ni amplíes su alcance (CD-11).
- El nombre del flag es `PAYOUT_ALLOW_MOCK` exacto. El comentario de seguridad money-path DEBE quedar horneado (CD-11).
- El mensaje del `throw` de `payout_refused` se mantiene idéntico (los tests existentes matchean `/payout_refused/`).

**Verificación W0:** `npm run typecheck` (tsc --noEmit) verde. Los tests existentes de `cashout-payout.test.ts`
siguen verdes (el test "PROD sin provider real → throws payout_refused" l.26-30 NO setea `PAYOUT_ALLOW_MOCK`,
así que `!== "true"` → sigue lanzando).

---

### Wave 1 (código automatizable — depende de W0)

#### W1.1 — `src/app/api/agents/remit-cashout-payout/invoke/route.ts` (Crear — ENDPOINT PRINCIPAL)

Fork byte-a-byte de `remit-kyc-validator/invoke/route.ts`. Se cambia `KycInputSchema/runKycValidator` →
`CashoutPayoutInputSchema/runCashoutPayout`, el import a `@/agents/cashout-payout`, y el código de error 502 a
`payout_unavailable`.

**Contenido exacto:**

```ts
// src/app/api/agents/remit-cashout-payout/invoke/route.ts
// Endpoint HTTP del agente remit-cashout-payout. Envuelve runCashoutPayout (lib pura) y honra el
// contrato a2a: POST /invoke → 200 { result: {...} } (legible por data.result ?? data en compose.ts).
// Fork de remit-kyc-validator/invoke/route.ts (mismo repo), cambiando el core KYC por el core Payout.
// CD-6 (eje crítico): NINGÚN response (200/400/502) puede exponer beneficiary.name/destination ni travelRuleData.
import { NextRequest, NextResponse } from "next/server";
import { CashoutPayoutInputSchema, runCashoutPayout } from "@/agents/cashout-payout";

export async function POST(req: NextRequest) {
  const parsed = CashoutPayoutInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    // CD-6: SOLO parsed.error.flatten() (mensajes Zod, value-free). NUNCA parsed.data / body crudo /
    // mensajes custom que interpolen el valor recibido (beneficiary.name/destination NO se ecoan).
    return NextResponse.json(
      { error: "invalid_input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await runCashoutPayout(parsed.data);
    return NextResponse.json({ result }, { status: 200 });
  } catch (err) {
    // CD-6: el core puede lanzar payout_refused (fail-safe sin PAYOUT_ALLOW_MOCK) o transfi_adapter_not_ready.
    // Body FIJO opaco + warn SOLO con err.name (nunca err.message / stack / input). Nunca un 500.
    console.warn("[remit-cashout-payout] payout failed:", {
      errorName: err instanceof Error ? err.name : "unknown",
    });
    return NextResponse.json({ error: "payout_unavailable" }, { status: 502 });
  }
}
```

Reglas:
- `safeParse` para el **400 estructurado** (AC-8). `runCashoutPayout` re-parsea internamente con el mismo schema
  (`cashout-payout.ts:68`, idempotente) — no es doble validación problemática.
- Envolver en `{ result }` (AC-4 / CD-8).
- `catch → 502 { error: "payout_unavailable" }` (nunca 500 sin manejar).
- **NO** agregar `runtime`/`dynamic` exports salvo que `next build` lo exija.

#### W1.2 — `src/app/api/agents/remit-cashout-payout/invoke/route.test.ts` (Crear — 9 tests)

Exemplar del mock: `remit-kyc-validator/invoke/route.test.ts` (`vi.hoisted` + `vi.mock(...importActual)` para
forzar el throw del 502 sin tocar el core). **`beforeEach`** setea `TRANSFI_API_KEY=""` + `ALLOW_FALLBACK_PAYOUT="true"`
(en `NODE_ENV="test"` de vitest el mock corre por la rama dev). Los tests de prod stubean además `NODE_ENV=production`.

**Contenido exacto:**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

// Mock del core con default = implementación real (los demás tests corren el path real).
// El test del 502 usa mockImplementationOnce para forzar un throw sin tocar cashout-payout.ts.
const { runCashoutPayoutMock } = vi.hoisted(() => ({ runCashoutPayoutMock: vi.fn() }));
vi.mock("@/agents/cashout-payout", async (importActual) => {
  const actual = await importActual<typeof import("@/agents/cashout-payout")>();
  runCashoutPayoutMock.mockImplementation(actual.runCashoutPayout);
  return { ...actual, runCashoutPayout: runCashoutPayoutMock };
});

import { POST } from "./route";

const ENDPOINT = "http://localhost/api/agents/remit-cashout-payout/invoke";

// Input válido de referencia con PII real del beneficiario (name + destination Yape) para los asserts NO-PII.
const validInput = {
  quoteId: "q1",
  amountUsd: 100,
  kycVerificationId: "v1",
  kycPayoutAllowed: true,
  beneficiary: { name: "Bob", country: "PE", method: "yape", destination: "999888777" },
  idempotencyKey: "idem-1",
};

function invoke(body: unknown) {
  return POST(
    new NextRequest(ENDPOINT, { method: "POST", body: JSON.stringify(body) }),
  );
}

describe("POST /api/agents/remit-cashout-payout/invoke", () => {
  beforeEach(() => {
    vi.stubEnv("TRANSFI_API_KEY", "");        // TransFi OFF → FallbackPayoutProvider (CD-4)
    vi.stubEnv("ALLOW_FALLBACK_PAYOUT", "true"); // en NODE_ENV=test corre el mock por la rama dev
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // (1) AC-3: hard-gate KYC → 200 blocked, NO ejecuta provider.
  it("kycPayoutAllowed:false → 200 blocked, no ejecuta provider", async () => {
    const res = await invoke({ ...validInput, kycPayoutAllowed: false });
    expect(res.status).toBe(200);
    const output = (await res.json()).result;
    expect(output.executed).toBe(false);
    expect(output.status).toBe("blocked");
    expect(output.reason).toBe("kyc_gate_not_passed");
    expect(output.payoutId).toBeNull();
  });

  // (2) AC-4 / AC-6 / CD-9: body válido → 200 { result } con EXACTAMENTE los 8 campos, provenance mock.
  it("body válido → 200 { result } con exactamente los 8 campos, provenance local-fallback", async () => {
    const res = await invoke(validInput);
    expect(res.status).toBe(200);
    const data = await res.json();
    const output = data.result ?? data; // contrato compose.ts (data.result ?? data)
    expect(output.slug).toBe("remit-cashout-payout");
    expect(Object.keys(output).sort()).toEqual([
      "deliveredLocal",
      "executed",
      "payoutId",
      "provenance",
      "reason",
      "slug",
      "status",
      "txRef",
    ]);
    expect(output.provenance).toBe("local-fallback");
    expect(output.deliveredLocal).toBeNull();
    expect(output.txRef).toBeNull();
  });

  // (3) AC-4 / CD-6: el 200 NO filtra beneficiary.name/destination ni travelRuleData (NO-PII HTTP).
  it("el 200 NO filtra beneficiary.name/destination ni travelRuleData (NO-PII HTTP)", async () => {
    const res = await invoke(validInput);
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain("999888777"); // el CCI/Yape (destination) nunca viaja
    expect(body).not.toContain("Bob");        // el nombre del beneficiario nunca viaja
    expect(body).not.toContain("travelRuleData");
  });

  // (4) AC-5: idempotencia — mismo idempotencyKey → mismo payoutId determinístico.
  it("idempotencia: mismo idempotencyKey → mismo payoutId", async () => {
    const a = (await (await invoke(validInput)).json()).result;
    const b = (await (await invoke(validInput)).json()).result;
    expect(a.payoutId).toBe("fallback-idem-1");
    expect(b.payoutId).toBe(a.payoutId);
  });

  // (5) AC-6: PROD sin PAYOUT_ALLOW_MOCK → 502 payout_unavailable (fail-safe default intacto).
  it("PROD sin PAYOUT_ALLOW_MOCK → 502 payout_unavailable", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAYOUT_ALLOW_MOCK", "");
    vi.stubEnv("TRANSFI_API_KEY", "");
    const res = await invoke(validInput);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "payout_unavailable" });
  });

  // (6) AC-6 / §4.3: PROD + PAYOUT_ALLOW_MOCK → 200 mock a nivel HTTP.
  it("PROD + PAYOUT_ALLOW_MOCK → 200 mock (local-fallback, no mueve plata)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAYOUT_ALLOW_MOCK", "true");
    vi.stubEnv("TRANSFI_API_KEY", "");
    const res = await invoke(validInput);
    expect(res.status).toBe(200);
    const output = (await res.json()).result;
    expect(output.provenance).toBe("local-fallback");
    expect(output.deliveredLocal).toBeNull();
  });

  // (7) AC-8 / CD-6: input inválido CON beneficiary PII → 400 que NO ecoa destination/name.
  it("input inválido (falta idempotencyKey) con beneficiary PII → 400 SIN ecoar destination", async () => {
    const res = await invoke({ ...validInput, idempotencyKey: undefined });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid_input");
    expect(data.details).toBeTruthy();
    expect(JSON.stringify(data)).not.toContain("999888777");
    expect(JSON.stringify(data)).not.toContain("Bob");
  });

  // (8) AC-8: body no-JSON → 400 (no 500).
  it("body no-JSON → 400 (no 500)", async () => {
    const res = await POST(
      new NextRequest(ENDPOINT, { method: "POST", body: "not-json{" }),
    );
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("invalid_input");
  });

  // (9) CD-6 / §4.6: runCashoutPayout lanza → 502 opaco sin filtrar internals/PII.
  it("runCashoutPayout lanza → 502 { error: payout_unavailable } sin filtrar internals", async () => {
    runCashoutPayoutMock.mockImplementationOnce(async () => {
      throw new Error("payout_refused leak 999888777");
    });
    const res = await invoke(validInput);
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data).toEqual({ error: "payout_unavailable" });
    expect(JSON.stringify(data)).not.toContain("999888777");
    expect(JSON.stringify(data)).not.toContain("payout_refused");
    expect(data.stack).toBeUndefined();
  });
});
```

Notas de test (por qué cada aserto pasa — NO negociables):
- `beforeEach` corre el mock por la rama dev (`NODE_ENV="test"` + `ALLOW_FALLBACK_PAYOUT="true"`). El mock
  (`FallbackPayoutProvider.execute`, `payout.ts:69-78`) devuelve `payoutId:"fallback-idem-1"`, `status:"settled"`,
  `deliveredLocal:null`, `txRef:null`, `provenance:"local-fallback"`; `runCashoutPayout` los mapea 1:1 al output.
- Test (1) hard-gate: `runCashoutPayout` retorna antes de `assertPayoutProviderSafe()`/provider
  (`cashout-payout.ts:71-82`) → no importa el env de payout; `payoutId:null`, `provenance:"n/a"`.
- Test (3)/(7)/(9): `CashoutPayoutOutput` NO incluye `beneficiary`/`travelRuleData` → nunca aparecen `"Bob"`,
  `"999888777"` ni `"travelRuleData"` en el body. En el 400, `flatten()` devuelve solo mensajes Zod
  (`{ formErrors:[], fieldErrors:{ idempotencyKey:["Required"] } }`), sin ecoar el `beneficiary`.
- Test (5)/(6): `afterEach` unstub + `beforeEach` re-stub; los tests de prod añaden `NODE_ENV=production`. En (5)
  sin `PAYOUT_ALLOW_MOCK` → `assertPayoutProviderSafe()` lanza `payout_refused` → catch → 502. En (6) con el flag
  → procede al mock → 200.
- Test (9): el mock default corre el core real; solo este test fuerza el throw con `mockImplementationOnce`.
- `new NextRequest(...)` es type-correct (extiende `Request`); evita el cast `as NextRequest`.

#### W1.3 — `src/agents/cashout-payout.test.ts` (Modificar — +3 tests del flag)

Agregá un `describe` nuevo al final del archivo (los tests existentes l.13-52 quedan intactos y verdes).
Reusá el `validInput` ya definido en el archivo (l.4-11) y el `afterEach(() => vi.unstubAllEnvs())`.

**Agregá este bloque:**

```ts
describe("runCashoutPayout — flag PAYOUT_ALLOW_MOCK (prod opt-in, etapa 1)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("PROD + PAYOUT_ALLOW_MOCK → ejecuta mock (no mueve plata)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRANSFI_API_KEY", "");
    vi.stubEnv("PAYOUT_ALLOW_MOCK", "true");
    const out = await runCashoutPayout(validInput);
    expect(out.executed).toBe(true);
    expect(out.provenance).toBe("local-fallback");
    expect(out.deliveredLocal).toBeNull();
    expect(out.txRef).toBeNull();
  });

  it("PROD + PAYOUT_ALLOW_MOCK + TRANSFI_API_KEY sin READY → throws transfi_adapter_not_ready", async () => {
    // El flag NO habilita un real a medias ni un mock silencioso: getPayoutProvider() lanza fail-loud.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAYOUT_ALLOW_MOCK", "true");
    vi.stubEnv("TRANSFI_API_KEY", "k");
    vi.stubEnv("TRANSFI_ADAPTER_READY", "");
    await expect(runCashoutPayout(validInput)).rejects.toThrow(/transfi_adapter_not_ready/);
  });

  it("PROD sin PAYOUT_ALLOW_MOCK → throws payout_refused (default intacto)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRANSFI_API_KEY", "");
    vi.stubEnv("PAYOUT_ALLOW_MOCK", "");
    await expect(runCashoutPayout(validInput)).rejects.toThrow(/payout_refused/);
  });
});
```

> Trazas de seguridad (§4.3): en el 2º test `hasReal = !!"k" && (""==="true")` = `false` → entra a la rama prod
> → flag `"true"` → procede → `getPayoutProvider()` ve `TRANSFI_API_KEY="k"` con `TRANSFI_ADAPTER_READY!=="true"`
> → **lanza `transfi_adapter_not_ready`** (`payout.ts:111-114`). El flag NUNCA materializa un provider real.
> **Este es el test que prueba que el flag no puede habilitar desembolso real.**

**Verificación W1** (todo verde antes de cerrar F3):
```
cd /home/ferdev/.openclaw/workspace/wasiai-remittance-agents
npx @biomejs/biome check --write src/agents/cashout-payout.ts \
  src/app/api/agents/remit-cashout-payout/invoke/route.ts \
  src/app/api/agents/remit-cashout-payout/invoke/route.test.ts \
  src/agents/cashout-payout.test.ts    # (ajustar al script biome del repo si difiere)
npm test          # 9 HTTP + 3 core nuevos VERDES + TODOS los existentes verdes
npm run typecheck # tsc --noEmit → verde (incl. .test.ts)
npm run build     # next build compila la ruta nueva remit-cashout-payout/invoke
```

---

### Wave 2 — Docs (depende de W1)

#### W2.1 — `README.md` (Modificar — agregar sección, espejo de la de `remit-kyc-validator`)

Agregá una sección nueva justo después de la sección de `remit-kyc-validator`. Contenido:

````markdown
## Endpoint HTTP + deploy (etapa 1 — `remit-cashout-payout`)

El agente `remit-cashout-payout` ya es invocable vía Next.js App Router (mismo deploy que los otros `remit-*`):

```
POST /api/agents/remit-cashout-payout/invoke
body: { "quoteId": "q1", "amountUsd": 100, "kycVerificationId": "v1", "kycPayoutAllowed": true,
        "beneficiary": { "name": "<PII>", "country": "PE", "method": "yape", "destination": "<Yape/CCI>" },
        "idempotencyKey": "idem-1" }
→ 200 { "result": { "slug", "executed", "status", "payoutId",
                    "deliveredLocal", "txRef", "reason", "provenance" } }  # SIN beneficiary ni travelRuleData
→ 200 { "result": { "executed": false, "status": "blocked", "reason": "kyc_gate_not_passed" } }  # hard-gate KYC
→ 400 { "error": "invalid_input", "details": {...} }  # body inválido (mensajes Zod, sin PII)
→ 502 { "error": "payout_unavailable" }               # fail-safe / misconfig del provider
```

Etapa 1 corre 100% en **payout MOCK** (`FallbackPayoutProvider`, `provenance:"local-fallback"`,
`deliveredLocal:null`, `txRef:null`): NUNCA mueve plata real. **TransFi queda OFF** (etapa 2 / WKH-168):
`TRANSFI_API_KEY` / `TRANSFI_ADAPTER_READY` **sin setear** en el deploy.

**Flag `PAYOUT_ALLOW_MOCK`:** el fail-safe `assertPayoutProviderSafe()` lanza `payout_refused` en
`NODE_ENV=production` sin provider real. Como Vercel fija `NODE_ENV=production`, el deploy de etapa 1 setea
`PAYOUT_ALLOW_MOCK=true` para permitir SOLO el mock. **NO habilita ningún path a desembolso real** (ese sigue
100% gated por `TRANSFI_API_KEY`+`TRANSFI_ADAPTER_READY`). ⚠️ Activar `PAYOUT_ALLOW_MOCK` en cualquier deploy
que no sea el de etapa 1 (mock) es un **incidente de seguridad money-path**.

**Garantía dura NO-PII:** el output NUNCA expone `beneficiary.name`, `beneficiary.destination` (Yape/CCI) ni
`travelRuleData` en ninguna respuesta (200/400/502). **Sin** receipt EIP-712 y **sin** lógica de pago/x402 del
lado del agente (lo hace el gateway a2a).

### Correr local
`npm run dev` → `http://localhost:3030/api/agents/remit-cashout-payout/invoke`
````

**Verificación W2:** consistencia del contrato documentado con `route.ts`.

---

## 6. Artefactos para las waves MANUALES (`!` humano — NO las ejecuta el Dev/pipeline, CD-7)

> W3, W4, W5 son mutaciones de infra/prod. El Dev **documenta** estos artefactos pero **NO los ejecuta**.
> El cambio del flag (W0) es la ÚNICA excepción acotada al "no tocar el core" y requiere AR explícito antes del deploy.

### W3 — Redeploy Vercel (MISMO proyecto `wasiai-remittance-agents`, NO uno nuevo)

Env vars de payout etapa 1:
```
# Etapa 1 (payout MOCK): habilitar el mock en el deploy Vercel prod (Opción A / WKH-172):
PAYOUT_ALLOW_MOCK=true      # ← SETEAR: habilita SOLO el FallbackPayoutProvider (mock). NO habilita real.
                            #   Activarlo fuera del deploy de etapa 1 = incidente de seguridad money-path.
# PROHIBIDO en esta HU (CD-4):
# TRANSFI_API_KEY           ← NO setear
# TRANSFI_ADAPTER_READY     ← NO setear (debe quedar != "true")
# ALLOW_FALLBACK_PAYOUT     ← irrelevante en prod (la rama prod usa PAYOUT_ALLOW_MOCK)
```

`agent_url` resultante:
`https://wasiai-remittance-agents.vercel.app/api/agents/remit-cashout-payout/invoke`

Smoke post-deploy:
```
curl -X POST https://wasiai-remittance-agents.vercel.app/api/agents/remit-cashout-payout/invoke \
  -H 'content-type: application/json' \
  -d '{"quoteId":"q1","amountUsd":100,"kycVerificationId":"v1","kycPayoutAllowed":true,"beneficiary":{"name":"Bob","country":"PE","method":"yape","destination":"999888777"},"idempotencyKey":"idem-1"}'
# → 200 { "result": { ... "provenance":"local-fallback", "deliveredLocal":null, "txRef":null } }
# y verificar que la respuesta NO contiene "999888777" / "Bob" / "travelRuleData".
# Segundo curl idéntico → mismo payoutId "fallback-idem-1".
# Smoke del gate: kycPayoutAllowed:false → { "result": { "status":"blocked", "reason":"kyc_gate_not_passed" } }.
```

### W4 — Registro `POST /agents` (contra prod Railway, a2a-key autenticado)

> `slug` NO se manda: se deriva de `name` vía `name.toLowerCase().replace(/\s+/g,'-')`.
> `name` = `"remit-cashout-payout"` byte-idéntico ⇒ slug `remit-cashout-payout` (CD-3).
> Registrar es **gratis** (WKH-173 live: `requireA2AKey()` auth-only, sin débito).
> **Header obligatorio:** `x-payment-chain: avalanche-fuji` (además del a2a-key autenticado).

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
- `payoutWallet` = wallet EVM **testnet** del creator (Missing Input #2, lo aporta el humano) → habilita el leg
  `creator` del split (AC-9). **CD-5: testnet, nunca mainnet.**
- `inputSchema` declara los **campos** (incluye `beneficiary`, que el core exige) — son definiciones de forma,
  **NO valores PII**. La garantía CD-6 opera sobre los **valores** en runtime.
- `outputSchema` = los 8 campos de `CashoutPayoutOutput` — **CERO campos del beneficiario / Travel Rule** (CD-6).

### W4.2 / W5 — Verificación (QA F4, evidencia archivo:línea / fila DB)
- `POST /discover` muestra `remit-cashout-payout` `status:active`, sin afectar `agentshop-cashout-matcher`
  (AC-1/AC-2).
- `/compose` con a2a-key y `steps[0]=remit-cashout-payout` (input válido) → `result` mock sin PII, hard-gate
  respetado (AC-3/AC-4/AC-6).
- Forzar un step 502 → fila de credit-back en `a2a_refund_outbox` (AC-7).
- Fila `charged` + `tx_hash` en `a2a_fee_splits` leg `creator` = `payoutWallet` (AC-9).

---

## 7. Constraint Directives (copiados del SDD — no se relajan)

### OBLIGATORIO
- **CD-3**: slug byte-idéntico `remit-cashout-payout` (`name` exacto en el registro).
- **CD-6**: ningún response (200/400/502) ni log expone `beneficiary.name`/`beneficiary.destination`/
  `travelRuleData`. 400 = SOLO `parsed.error.flatten()`. 502 = body fijo `{error:"payout_unavailable"}` +
  `console.warn` con SOLO `err.name`. ≥1 test NO-PII en 200, 400 y 502.
- **CD-8**: endpoint responde `200 { result: {...} }` (legible por `data.result ?? data`).
- **CD-9**: mock siempre `deliveredLocal:null`, `txRef:null`, `provenance:"local-fallback"` — nunca ofuscado/renombrado.
- **CD-11**: flag `PAYOUT_ALLOW_MOCK` (≠ `ALLOW_FALLBACK_PAYOUT`), guarda propia dentro de `NODE_ENV==='production'`,
  comentario de seguridad money-path horneado.
- Reusar `CashoutPayoutInputSchema` + `runCashoutPayout` de `@/agents/cashout-payout` — NO duplicar.
- **Blindaje histórico (WKH-114/144/115)**: `biome check --write` por archivo antes del gate; narrowing de
  nullable con `x?.prop`; sin imports sin uso; `tsc --noEmit` verde **también** sobre `.test.ts`.

### PROHIBIDO
- **CD-1**: NO tocar `wasiai-agentshop` / `agentshop-cashout-matcher` ni su registro/slug.
- **CD-2**: NO tocar `wasiai-a2a` (ni `orchestrate.ts`, ni `compose.ts`, ni ampliar `refund-outbox.ts`).
- **CD-4**: NO setear `TRANSFI_API_KEY` / `TRANSFI_ADAPTER_READY=true` en el deploy de esta HU.
- **CD-5**: testnet-only (`payoutWallet` testnet, nunca mainnet).
- **CD-7**: mutaciones infra/prod (redeploy, `POST /agents`, `payoutWallet`) **y cualquier cambio a
  `assertPayoutProviderSafe()`** las ejecuta/ratifica el humano vía `!`; el cambio del flag requiere AR explícito.
- **CD-10**: NO tocar `resolveTravelRuleData()` (stub).
- NO tocar `src/providers/payout.ts`/`types.ts` (el flag vive SOLO en `cashout-payout.ts`).
- NO tocar el hard-gate KYC (`cashout-payout.ts:71-82`).
- NO agregar deps nuevas, receipt EIP-712, ni consumidor de value-delivery real (WKH-168).

---

## 8. Test Expectations (resumen — 9 HTTP + 3 core)

| Test | ACs / CD | Framework | Tipo |
|------|----------|-----------|------|
| `route.test.ts` (9): hard-gate 200-blocked / 8-campos-mock / NO-PII-200 / idempotencia / PROD-sin-flag-502 / PROD-con-flag-200 / 400-NO-PII / no-JSON-400 / 502-opaco | AC-3/4/5/6/8, CD-6/9 | vitest | integration (HTTP) |
| `cashout-payout.test.ts` (+3): PROD+flag→mock / PROD+flag+TransFi-sin-ready→throws / PROD-sin-flag→throws | AC-6, §4.3 pt.1/2/4 | vitest | unit (core) |

**Prueba de que el flag NO habilita desembolso real:** el test core "PROD + PAYOUT_ALLOW_MOCK + TRANSFI_API_KEY
sin READY → throws `transfi_adapter_not_ready`". Con TransFi presente pero no listo, `getPayoutProvider()` hace
fail-loud (NO mock silencioso, NO real a medias). Complementado por: `hasReal` retorna PRIMERO (el flag ni se
lee con TransFi real), y sin `TRANSFI_API_KEY` `getPayoutProvider()` SOLO puede devolver el mock.

### Criterio Test-First
APIs / lógica money-path → **Test-first: Sí**. Docs (W2) → No.

---

## 9. Out of Scope (NO tocar bajo ninguna circunstancia)

- `src/providers/payout.ts`, `src/providers/types.ts`, `resolveTravelRuleData()`, el hard-gate KYC, el scaffold Next.
- `remit-corridor-fx/**`, `remit-kyc-validator/**` (solo se leen como exemplar).
- `wasiai-agentshop/**`, `wasiai-a2a/**`.
- Adapter TransFi real / desembolso real / máquina de estados value-delivery (WKH-168).
- Re-verificación server-to-server del `kycPayoutAllowed` (boundary de confianza heredado, DT-6).
- Mainnet. Migraciones de schema. Reabrir el modo de pago (a2a-key).
- NO "mejorar" código adyacente. NO agregar funcionalidad no listada.

---

## 10. Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala al Architect.** No inventar, no asumir, no improvisar.

Situaciones de escalation:
- El bloque a reemplazar en `assertPayoutProviderSafe()` no matchea byte-a-byte lo esperado (§W0.1).
- Un import de `@/agents/cashout-payout` no está disponible / firma distinta.
- El exemplar KYC route ya no existe o cambió de forma.
- `next build` exige `runtime`/`dynamic` exports no previstos.
- Ambigüedad en un AC o necesidad de tocar un archivo fuera de la tabla §2.

---

## 11. Done Definition (F3 — código)

- [ ] W0: `cashout-payout.ts:52-54` reemplazado por el opt-in `PAYOUT_ALLOW_MOCK` (§W0.1); `hasReal` y la rama
      dev byte-idénticos; comentario de seguridad money-path horneado (CD-11); `tsc` verde.
- [ ] W1: `route.ts` creado (fork KYC, 502 `payout_unavailable`); `route.test.ts` con 9 tests (incl. NO-PII en
      200/400/502, hard-gate, idempotencia, flag); `cashout-payout.test.ts` con +3 tests del flag.
- [ ] `biome check --write` por archivo + `npm test` verde (12 nuevos + todos los existentes) +
      `npm run typecheck` verde (incl. `.test.ts`) + `npm run build` compila la ruta nueva.
- [ ] W2: `README.md` con la sección "Endpoint HTTP + deploy (etapa 1 — `remit-cashout-payout`)".
- [ ] Cero cambios en `src/providers/*`, `resolveTravelRuleData()`, hard-gate, scaffold, hermanos `remit-*`,
      `wasiai-agentshop/*`, `wasiai-a2a/*`. Cero deps nuevas. Sin receipt EIP-712, sin lógica de pago/x402.
- [ ] Ningún response HTTP expone `beneficiary.name`/`destination`/`travelRuleData` (CD-6, tests 3/7/9).
- [ ] Anti-Hallucination Checklist (§4) completo.

**NO es parte de F3** (lo hace el humano vía `!`, CD-7): W3 redeploy Vercel (con `PAYOUT_ALLOW_MOCK=true`),
W4 registro `POST /agents`, W5 verificación e2e del riel. **El cambio del flag (W0) requiere AR explícito.**

---

*Story File generado por NexusAgil — Architect F2.5. Contrato para el Dev (F3).*
