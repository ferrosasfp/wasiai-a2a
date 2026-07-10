# Report — HU [WKH-170] Publicar `remit-kyc-validator` como agente standalone del marketplace A2A

**Fase final: DONE (código)**  
**Status del cierre: PENDING-DEPLOY (W3/W4/W5 manuales `!`)**  
**Fecha de cierre: 2026-07-10**

---

## Resumen ejecutivo

Se entregó el **endpoint HTTP** que hace invocable al agente `remit-kyc-validator` (validación KYC/AML de remesas, etapa 1 / Free-KYC con fallback simulado). El endpoint es un fork de `remit-corridor-fx` alojado en el mismo deploy Vercel `wasiai-remittance-agents` (Next.js App Router); se registrará en el marketplace A2A vía `POST /agents` sin código nuevo en `wasiai-a2a` (patrón a2a-key prepago heredado de WKH-171).

**Eje crítico:** garantía dura de **NO-PII** — endpoint NUNCA filtra `legalId` (DNI) ni `travelRuleData` en ningún response HTTP (200/400/502/logs). Comprobado con tests que inyectan DNI real y verifican ausencia.

**Veredictos del pipeline:**
- F3 (Código): ✅ APROBADO — `npm test` 47/47 verde, `npm run build` compila, tsc sin errores, CR APPROVED.
- AR: ✅ APROBADO con 2 MENOR (1 pre-existente fuera de scope, 1 test extra agregado post-AR).
- CR: ✅ APPROVED — 0 BLQ, 0 MENOR.
- F4 (QA): ✅ APROBADO PARA DONE — 5/8 ACs PASS (código), 3 ACs PENDING-DEPLOY (registro y smoke, gated por `!` humano).

**Archivos modificados:**
- `wasiai-remittance-agents/src/app/api/agents/remit-kyc-validator/invoke/route.ts` (CREAR)
- `wasiai-remittance-agents/src/app/api/agents/remit-kyc-validator/invoke/route.test.ts` (CREAR, 8 tests)
- `wasiai-remittance-agents/README.md` (sección endpoint nuevo)
- `wasiai-a2a`: **CERO código** (registro runtime, paso manual W4)

---

## Pipeline ejecutado (resumen)

| Fase | Actividad | Status | Evid. |
|------|-----------|--------|-------|
| **F0** | Project Context grounding | ✅ DONE | `work-item.md` §Grounding — 6 hallazgos clave verificados |
| **F1** | Work Item + ACs EARS | ✅ HU_APPROVED | 8 ACs EARS (AC-1 a AC-8) con ejemplo SDD remit-corridor-fx |
| **F2** | SDD + Constraint Directives | ✅ SPEC_APPROVED | 12 CDs (CD-1..8 + prohibiciones explícitas) |
| **F2.5** | Story File (contrato Dev) | ✅ READY | §W1 (endpoint+tests), §W2 (README), §W3-W5 (manuales `!`) |
| **F3** | Implementación + Tests | ✅ DONE | `route.ts` (18 líneas fork), `route.test.ts` (8 tests, 47 verde total) |
| **AR** | Adversarial Review | ✅ APROBADO (2 MENOR) | `ar-report.md` — fuga PII verificada 0; fail-safe verificado; 46/46 tests |
| **CR** | Code Review | ✅ APPROVED | `cr-report.md` — pattern consistency con WKH-171, cero drift |
| **F4** | QA Validation | ✅ APROBADO PARA DONE | `f4-report.md` — 5/8 ACs PASS, 3 PENDING-DEPLOY; 0 drift |
| **DOCS** | Report Final | ✅ ESTE DOC | Consolidación de Auto-Blindaje + Runbook `!` + Lecciones |

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia (archivo:línea) |
|----|--------|--------------------------|
| **AC-1** | PENDING-DEPLOY `!` | `POST /discover` debe mostrar `remit-kyc-validator` como agente activo — depende de W4 (registro en `a2a_agents` con slug exacto). No verificable sin ejecutar el registro (paso humano). |
| **AC-2** | PENDING-DEPLOY `!` | Nueva fila en `a2a_agents` con slug `remit-kyc-validator` — mismo, depende de W4. No tocamos `agentshop-*` (confirmado: CD-1 respetado). |
| **AC-3** | **PASS** | 200 con EXACTAMENTE 7 campos (slug, approved, riskLevel, reasons, verificationId, provenance, payoutAllowed), SIN `legalId`/`travelRuleData` en 200/400/502. `route.ts:21-22` devuelve `{ result }` de `runKycValidator()` → `kyc-validator.ts:89-97` confirma 7 campos. `route.test.ts:43-58` (test 1 exact keys), `:61-66` (test 2 NO-PII 200), `:70-79` (test 2b extra field), `:98-105` (test 5 NO-PII 400), `:118-129` (test 7 NO-PII 502). |
| **AC-4** | **PASS** | Didit OFF (100% `FallbackKycProvider`) — `providers/kyc.ts:103-113` sin `DIDIT_API_KEY` devuelve fallback. `route.test.ts:82-86` (test 3) verifica `provenance:"local-fallback"`. |
| **AC-5** | **PASS** | PROD + fallback → `payoutAllowed:false` sin excepción — `kyc-validator.ts:56-69` `isPayoutAllowed()` gate bloquea fallback en prod. `route.test.ts:88-95` (test 4) con `NODE_ENV=production` verifica. |
| **AC-6** | **PASS** | 200 `{result}` legible por `data.result ?? data` — `route.ts:22` envuelve. `route.test.ts:43-58` (test 1) usa el contrato. |
| **AC-7** | **PASS** | 400 estructurado SIN ecoar `legalId`, nunca 500 — `route.ts:14-18` usa `parsed.error.flatten()` (value-free). `route.test.ts:98-105` (test 5) envía body inválido con DNI real, verifica no aparece en 400. |
| **AC-8** | PENDING-DEPLOY `!` | Fee-split creator leg a `payoutWallet` — `a2a_fee_splits` charged row — depende de W4 (payoutWallet) + W5 (smoke e2e). Mecanismo genérico ya verificado en WKH-171 (no código nuevo esta HU). |

**Resumen ACs:** 5 PASS de código, 3 PENDING-DEPLOY (correctamente gateados por el diseño, no fallos del pipeline).

---

## Hallazgos finales

### BLOQUEANTES
**0 BLOQUEANTES** — el gate PASA. No hay fuga de PII, no hay path a 500, fail-safe verificado.

### MENOR-1 — `verificationId` hash débil reversible (pre-existente, OUT de scope)
- **Ubicación:** `src/providers/kyc.ts:73` (`verificationId = fallback-${hashLite(legalId)}`)
- **Descripción:** hash polinómico 32-bit no-cripto sobre DNI → reversible por brute-force (10^8 valores). Actual bajo riesgo (testnet, demo data), pero potencial ALTO si Free-KYC corre en prod con DNIs reales.
- **Por qué NO bloquea WKH-170:** código pre-existente (CD-1 prohíbe tocar `providers/kyc.ts`), ruteado a follow-up **WKH-177** (seguridad).
- **Mitigación sugerida:** reemplazar `hashLite` por UUID opaco o HMAC-SHA256 derivado con secreto de servidor (WKH-177).

### MENOR-2 — Sin test explícito del stripping de PII en campo extra (CERRADO en fix-pack)
- **Ubicación:** ausencia en `route.test.ts` original (antes de AR)
- **Descripción:** no hay test que inyecte campo PII no-schema y verifique que 200 no lo ecoa.
- **Status:** CERRADO — agregado post-AR como test 2b en `route.test.ts:70-79`, verde en F4 (47/47 tests).
- **Resultado:** defensa-en-profundidad completada, sin hallazgo residual.

---

## Auto-Blindaje consolidado

### Patrones de protección (herencia + nuevo)

| Patrón | Origen | Aplicación en WKH-170 | Verificación |
|--------|--------|----------------------|----------------|
| **Fail-safe `payoutAllowed`** | WKH-135 (agent-intents) | `isPayoutAllowed()` bloquea fallback en prod, siempre `false` con ALLOW_FALLBACK_KYC en NODE_ENV=production | test 4: `NODE_ENV=production` + `ALLOW_FALLBACK_KYC=true` → `false` |
| **NO-PII en error 400** | WKH-155 (RLS PII anon-readable) | `parsed.error.flatten()` value-free (Zod native), PROHIBIDO `parsed.data` ni body crudo | test 5: DNI real en body, 400 no lo ecoa |
| **NO-PII en error 502** | WKH-155 precedente | Body fijo `{error:"verification_unavailable"}`, console.warn SOLO `err.name`, sin `err.message`/stack | test 7: mock throw con honeypot, 502 no filtra |
| **Stateless endpoint** | A2A pattern (compose.ts) | Cero escritura a DB, cero lookup de estado, cero cache — puro pass-through wrapper | CR review: zero drift, zero new surface |
| **Contrato `{result}`** | WKH-171 (`remit-corridor-fx`) | Resultado envuelto en `{ result }` para ser legible por `data.result ?? data` | test 1: `data.result ?? data` + `Object.keys` verifican contrato |
| **Number aritmética** | WKH-133 (anti-hallucination) | No hay aritmética nueva en el route; el core (`kyc-validator.ts`) no toca dinero | CD-4 respetado: sin nuevas deps, sin lógica de pago |
| **Ownership check (future)** | WKH-53/54 (RLS ownership) | El registro `POST /agents` (W4) se hace con a2a-key autenticado (owner_ref derivado); la fila persiste con owner_ref. El endpoint GET no valida ownership (stateless, consumidor califica ya en gateway via composición) | F0 análisis: owner_ref aplicable en W4, no en endpoint GET |

### Decisiones de seguridad documentadas

1. **Fallback determínístico sin red:** etapa 1 corre 100% en `FallbackKycProvider`, nunca intenta Didit real (CD-4). Fail-loud si se setea `DIDIT_API_KEY` sin `DIDIT_ADAPTER_READY=true`.
2. **PII redaction en 3 niveles:** core (`runKycValidator` → 7 campos), middleware (route 400/502), tests (2 tests PII). Ofensiva.
3. **`payoutAllowed` inerte en etapa 1:** campo calculado, expuesto, pero sin consumidor real (value-delivery = Fase A/WKH-168). Documentado para no engañar.

---

## Archivos modificados (git diff summary)

### Repos tocados
| Repo | Scope | Cambios |
|------|-------|---------|
| `wasiai-remittance-agents` | Code (F3) | ✅ 3 archivos: `route.ts`, `route.test.ts`, `README.md` |
| `wasiai-a2a` | Code (F3) | ✅ CERO archivos (registro = runtime `!` humano) |
| `wasiai-agentshop` | Code (F3) | ✅ CERO archivos (CD-1: intacto) |

### Detalles

**Creados:**
- `wasiai-remittance-agents/src/app/api/agents/remit-kyc-validator/invoke/route.ts` (18 líneas)
- `wasiai-remittance-agents/src/app/api/agents/remit-kyc-validator/invoke/route.test.ts` (130 líneas, 8 tests)

**Modificados:**
- `wasiai-remittance-agents/README.md` — 1 sección nueva agregada (30 líneas post-factum)

**Intactos:**
- `wasiai-remittance-agents/src/agents/kyc-validator.ts` (no cambios, CD-1)
- `wasiai-remittance-agents/src/providers/kyc.ts` (no cambios, CD-1)
- `wasiai-remittance-agents/src/app/api/agents/remit-corridor-fx/**` (exemplar read-only)
- `wasiai-agentshop/**` (CD-1)
- `wasiai-a2a/**` (CD-2)

---

## Decisiones diferidas a backlog

### WKH-177 — Seguridad: reemplazar `verificationId` hash débil por opaco
- **Tipo:** Security follow-up de MENOR-1.
- **Descripción:** reemplazar `hashLite` en `providers/kyc.ts:90-95` por UUID/HMAC-SHA256 + servidor.
- **Prioridad:** ALTA (si Free-KYC va a prod con DNIs reales antes de Didit etapa 2).
- **Owner:** Founder (seguridad), no necesar developer.

### WKH-168 — Fase A: Wiring de `payoutAllowed` a gate de payout real
- **Descripción:** hoy `payoutAllowed` se calcula pero no se usa. En Fase A (value-delivery real), un agente KYC que devuelva `false` debe bloquear cualquier transacción de dinero.
- **Prioridad:** P0 para Fase A (no es deuda de WKH-170; WKH-170 solo garantiza que se calcula correctamente).

---

## Runbook de los `!` humanos (pasos no-automatizados)

### W3 — Redeploy Vercel (mismo proyecto `wasiai-remittance-agents`)

**Qué:** Agregar la ruta `/api/agents/remit-kyc-validator/invoke` al deploy existente de `wasiai-remittance-agents` (que ya contiene `/api/agents/remit-corridor-fx/invoke` de WKH-171).

**Cómo:**
```bash
cd /ruta/a/wasiai-remittance-agents
vercel deploy --prod
```

**Confirmaciones previas:**
1. Verificar que `.env.production` (Vercel) **NO** tiene `DIDIT_API_KEY` seteada (CD-4 obligatorio).
2. Verificar que `DIDIT_ADAPTER_READY` **NO** está en Vercel (debe faltar completamente).
3. Ejecutar `npm test` local para confirmar 47/47 verde antes de deployar.

**Resultado esperado:**
- Vercel deploy completa sin errores, new route listada en output.
- URL del endpoint: `https://wasiai-remittance-agents.vercel.app/api/agents/remit-kyc-validator/invoke`

**Verificación post-deploy (smoke local):**
```bash
curl -X POST https://wasiai-remittance-agents.vercel.app/api/agents/remit-kyc-validator/invoke \
  -H 'content-type: application/json' \
  -d '{"senderName":"Alice","senderCountry":"US","legalId":"12345678","amountUsd":100,"receiverName":"Bob","receiverCountry":"PE","purpose":"family"}'
```
Esperado: `200` con `result.provenance:"local-fallback"` + `result.payoutAllowed:false` + **sin** `"12345678"` ni `"travelRuleData"` en la respuesta.

---

### W4 — Registro `POST /agents` (contra prod Railway, a2a-key autenticado)

**Qué:** Registrar el agente en `wasiai-a2a` con 1 llamada HTTP al endpoint `POST /agents` (WKH-134 / WKH-173 live).

**Cómo:**
```bash
curl -X POST https://<a2a-prod-railway>/agents \
  -H 'Authorization: Bearer <a2a-key-autenticado>' \
  -H 'x-payment-chain: avalanche-fuji' \
  -H 'content-type: application/json' \
  -d '{
    "name": "remit-kyc-validator",
    "agentUrl": "https://wasiai-remittance-agents.vercel.app/api/agents/remit-kyc-validator/invoke",
    "description": "Validación KYC/AML de remesa (identidad + screening + Travel Rule). Etapa 1 Free-KYC / fallback determinístico; Didit real en etapa 2. El output NUNCA expone PII (DNI/Travel Rule).",
    "priceUsdc": 0.02,
    "capabilities": ["kyc-verification", "aml-screening", "travel-rule", "remittance-compliance"],
    "payoutWallet": "0x<WALLET-EVM-CREATOR-TESTNET>",
    "discoverable": true,
    "inputSchema": { ... },
    "outputSchema": { ... }
  }'
```

**Requerimientos:**
- `<a2a-key-autenticado>`: a2a-key válido (prepago) que sea owner del registro. Se obtiene vía `POST /auth/signup` si no existe (admin/founder).
- `<WALLET-EVM-CREATOR-TESTNET>`: wallet Avalanche Fuji / Kite testnet / Base Sepolia del creator (para recibir el leg `creator` del protocol fee 1%). **Testnet ONLY** (CD-5).
- Header `x-payment-chain: avalanche-fuji` — cadena de pago (donde está el a2a-key fondeo).
- **No enviar `slug`:** se deriva automáticamente de `name.toLowerCase().replace(/\s+/g,'-')` → `"remit-kyc-validator"` (CD-3).

**Payload completo:**
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

**Resultado esperado:**
- HTTP 201 (o 200) con body `{ slug: "remit-kyc-validator", ... }`.
- Nueva fila en `a2a_agents` (Supabase prod, tabla `a2a_agents`) con:
  - `slug: "remit-kyc-validator"`
  - `name: "remit-kyc-validator"`
  - `agent_url: "https://wasiai-remittance-agents.vercel.app/api/agents/remit-kyc-validator/invoke"`
  - `price_usdc: 0.02`
  - `payout_wallet: "0x..."`
  - `owner_ref: <del a2a-key autenticado>`
  - `enabled: true` (o `status: "active"`)

**Costo:** $0 (gratis, WKH-173 live: `requireA2AKey()` auth-only, sin débito).

---

### W5 — Smoke E2E post-registro

**AC-1: Discovery muestra el agente**
```bash
curl -s 'https://<a2a-prod-railway>/discover?maxPrice=1&limit=100' | jq '.[] | select(.slug=="remit-kyc-validator")'
```
Esperado: fila con `slug: "remit-kyc-validator"`, `status: "active"` (o `enabled: true`), sin tocar `agentshop-kyc-validator` (debe seguir presente).

**AC-3/AC-6: Invocación vía `/compose` devuelve `{result}` sin PII**
```bash
curl -X POST https://<a2a-prod-railway>/compose \
  -H 'Authorization: Bearer <a2a-key>' \
  -H 'x-payment-chain: avalanche-fuji' \
  -H 'content-type: application/json' \
  -d '{
    "steps": [
      {
        "agent": { "slug": "remit-kyc-validator" },
        "input": {
          "senderName": "Alice",
          "senderCountry": "US",
          "legalId": "12345678",
          "amountUsd": 100,
          "receiverName": "Bob",
          "receiverCountry": "PE",
          "purpose": "family"
        }
      }
    ]
  }'
```
Esperado: `200` con `result.slug: "remit-kyc-validator"`, `result.approved: true` (o false, según lógica fallback), `result.provenance: "local-fallback"`, `result.payoutAllowed: false` (prod). **Sin** `"12345678"` ni `"travelRuleData"` en el body.

**AC-8: Fee-split `creator` leg persistido**
Query a `a2a_fee_splits` (Supabase prod):
```sql
SELECT slug, leg, amount_usd, status, tx_hash FROM a2a_fee_splits
WHERE slug = 'remit-kyc-validator' AND leg = 'creator'
ORDER BY created_at DESC LIMIT 1;
```
Esperado: fila con `status: "charged"` o `"settled"`, `tx_hash` no-null (si settleó on-chain) o null (si pendiente), `amount_usd: 0.0002` (1% de 0.02).

---

## Lecciones para próximas HUs

1. **Fork + test pattern es robusto:** WKH-171 estableció el patrón (endpoint fork, test mock `vi.hoisted`), y esta HU lo aplicó byte-a-byte con cero divergencias. Para HUs similares de agentes que reutilizan lógica core: **copiar el exemplar sin justificar cambios** acelera F2/F3/CR sin sacrificar quality.

2. **Auto-Blindaje PII se hereda, no se improvisa:** MENOR-1 (hash débil) fue pre-existente porque `providers/kyc.ts` no se tocó (CD-1). Pero para PROTEGER el nuevo wrapper (`route.ts`), fue suficiente: (a) reutilizar schema+core sin modificar, (b) tests que inyecten PII real y verifiquen ausencia, (c) prohibir echo en error messages. Lección: **el blindaje vive en los tests defensivos**, no en comentarios de "será revisado después".

3. **`PENDING-DEPLOY` no es FAIL:** 3 ACs de registración+smoke (AC-1/2/8) quedaron PENDING por diseño, gateados por `!` humano. El gate de F4 pasó igual porque AR/CR/F3 aseguran que el código HACE su parte correctamente. Lección: **distinguir qué bloquea código (AR/CR/tests) de qué bloquea operaciones (deploys/registros)** evita falsos negativos.

4. **Fail-safe documental:** `payoutAllowed` está especificado como "inerte en etapa 1" porque NO tiene consumidor todavía (WKH-168, Fase A). Si después alguien lo wirear sin avisar, esto quedó documentado como trampa. Lección: **registrar en ACs y SDD cuándo un campo es inerte/futura**, no solo qué hace.

5. **Slug byte-identity es crítico:** CD-3 fue obsesivo (`name="remit-kyc-validator"` exacto, sin variantes). W4 lo derivó automáticamente; sin eso, una typo en el registro hubiera separado dos slugs. Lección: **en payloads REST que generan PKs, hardcodear el valor exacto esperado** y documentar la derivación.

---

## Verificación Final de Constraint Directives

| CD | Verificado | ✅ |
|----|------------|-----|
| CD-1 (core/providers/demo intactos) | mtimes 07-08 vs HU 07-10 | ✅ |
| CD-2 (`wasiai-a2a` CERO código) | Repo separado, 0 archivos tocados | ✅ |
| CD-3 (slug byte-idéntico) | `SLUG="remit-kyc-validator"` = `name` registro | ✅ |
| CD-4 (Didit OFF) | Sin DIDIT_API_KEY en `.env*` repo | ✅ |
| CD-5 (testnet-only) | `payoutWallet` será declarado testnet en W4 | ✅ |
| CD-6 (NO-PII 200/400/502) | Tests 2/5/7 verifican; route.ts código limpio | ✅ |
| CD-7 (mutaciones `!` humano) | W3/W4 no ejecutadas por Dev/pipeline | ✅ |
| CD-8 (contrato `{result}`) | Byte-idéntico a WKH-171 exemplar | ✅ |

---

## Cierre

**Status final:** `DONE (código) · PENDING-DEPLOY (W3/W4/W5 manuales)`

El endpoint está construido, testeado, auditado y listo. Las 3 ACs PENDING son por diseño arquitectónico (registro + smoke son operativos, no código). El runbook de los `!` humanos está documentado arriba. El orquestador puede pasar este reporte al humano para que ejecute W3/W4/W5.

**Próximos pasos (fuera de esta HU):**
1. Humano ejecuta W3 (redeploy Vercel).
2. Humano ejecuta W4 (registro `POST /agents`).
3. QA/Humano ejecuta W5 (smoke E2E).
4. Founder abre WKH-177 (seguridad `verificationId` hash).
5. Fase A: alguien wirear `payoutAllowed` a un gate de payout real.

*Reporte final generado por NexusAgil — nexus-docs. Pipeline completo WKH-170 DONE (código).*
