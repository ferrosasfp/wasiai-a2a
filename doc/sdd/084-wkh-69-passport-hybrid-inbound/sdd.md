# SDD #084: [KITE-PASSPORT] Model B Hybrid — Passport inbound + operator outbound cross-chain

> SPEC_APPROVED: no
> Fecha: 2026-05-03
> Tipo: feature
> SDD_MODE: full
> Branch: `feat/084-wkh-69-passport-hybrid-inbound` (desde `main` HEAD `ce393e9`)
> Artefactos: `doc/sdd/084-wkh-69-passport-hybrid-inbound/`
> Pipeline: QUALITY (toca auth + payment surface)
> Spike trazabilidad: WKH-68 → `doc/sdd/spike-kite-passport/{decision-doc.md,poc-results.md,discovery-notes.md}`

---

## 1. Resumen

Implementar Model B Hybrid (aprobado en spike WKH-68): **Kite Passport como mecanismo
inbound de autorización user-facing**, mientras `OPERATOR_PRIVATE_KEY` sigue siendo el
firmante para outbound cross-chain settlement. El orquestador (`wasiai-a2a`) se vuelve
**agnóstico al payer** — la firma EIP-3009 puede venir tanto de un Passport session
wallet como de un raw EOA, y ambos paths usan el mismo `getPaymentAdapter().verify()`
+ `.settle()`.

Scope cerrado:
- **AC-1..AC-3**: verificar (no romper) que mainnet defaults USDC + EIP-712 domain `"USDC"`
  ya están correctos en `payment.ts`.
- **AC-4**: telemetry — etiquetar `payment_origin: "passport" | "eoa"` en
  `a2a_events.metadata` JSONB sin migration.
- **AC-5**: `doc/passport-onboarding.md` con flujo completo + smoke-test diferido para humano.
- **AC-6**: tests con mock signature shape Passport-derived que valida el round-trip
  `decodeXPayment` → adapter mock acepta.
- **AC-7**: zero regression contra baseline 794 tests.
- **AC-8**: testnet path (PYUSD chain 2368) inalterado.
- **AC-9**: outbound `OPERATOR_PRIVATE_KEY` inalterado.
- **AC-10**: `requirePassport` opt-in middleware vía `PASSPORT_REQUIRE_INBOUND=true`.

**Resultado esperado**: pipeline merge-ready con hooks de telemetry y guard, sin cambios
de Railway env vars en prod hasta que el humano corra el smoke-test E2E (CD-WKH69-1).

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 084 |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Objetivo** | Hacer `wasiai-a2a` agnóstico al payer (Passport o EOA) en inbound x402, agregar telemetry `payment_origin`, opt-in middleware `requirePassport`, documentación de onboarding. |
| **Reglas de negocio** | Backward compat 100% para EOA; outbound cross-chain inalterado; sin Railway env changes hasta validación humana. |
| **Scope IN** | `src/middleware/x402.ts`, `src/middleware/event-tracking.ts`, `src/middleware/passport.ts` (new), `src/services/event.ts` (no API change — confirm `metadata` JSONB acepta), `test/passport-*.test.ts` (new), `doc/passport-onboarding.md` (new), `.env.example` |
| **Scope OUT** | Subprocess wrapping de `kpass`; cambios en `chain.ts`; DB migration; cross-chain outbound; E2E real con fondos reales (smoke test diferido); `OPERATOR_PRIVATE_KEY` flow |
| **Missing Inputs** | (A) Real Passport-funded x402 wire shape — diferido al smoke-test post-merge (CD-WKH69-1); (B) Canonical USDC contract en chain 2366 prod (default ya verified en staging) |

### Acceptance Criteria (EARS) — heredados del work-item

Ver `work-item.md` líneas 17-35. Los 10 ACs se mapean en §10 (Test Plan) a tests concretos.

---

## 3. Context Map (Codebase Grounding)

### Archivos leídos (verificados con Read)

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `src/adapters/kite-ozone/payment.ts` | confirm `DEFAULT_EIP712_DOMAIN_NAME_MAINNET='USDC'` (línea 93) y `DEFAULT_PAYMENT_TOKEN_MAINNET=0x7aB6...` (línea 91) | env-driven defaults via `getKiteNetwork()`; lazy readers; warn-once pattern (`_warnedDefaultToken`); `_resetWalletClient()` test helper |
| `src/middleware/x402.ts` | entrypoint EIP-3009 verify+settle; `decodeXPayment` (lines 57-80); `requirePayment` factory (line 82) | Fastify preHandler factory pattern; setea `request.paymentTxHash` y `request.paymentVerified` (lines 18-22); base64 → JSON shape strict |
| `src/middleware/event-tracking.ts` | onResponse hook que llama `eventService.track` con `metadata` JSONB | Fastify augmentation `request._eventTrackingStartMs`; fire-and-forget `.catch()`; allowlist `TRACKED_PREFIXES` |
| `src/middleware/forward-key.ts` | exemplar **canonical** para opt-in env-flag middleware factory que retorna `[]` cuando off | `requireForwardKey()` línea 66; trim + min-length guard; `preHandlerAsyncHookHandler[]` return; logging sin leakage; sufijo `_HEADER` constant |
| `src/middleware/event-tracking.test.ts` | exemplar para test de middleware con Fastify in-memory + `vi.mock` de service | `app.inject()` + `await ready()`; `mockTrack` + setTimeout para fire-and-forget |
| `src/services/event.ts` | confirm `track()` acepta `metadata: Record<string, unknown>` (line 62) | `metadata: input.metadata ?? {}` línea 75 — JSONB sin schema enforcement |
| `src/adapters/__tests__/payment.contract.test.ts` | exemplar para tests contract-level del adapter con vi.mock viem | `vi.mock('viem', ...)`; `_resetWalletClient()` reset entre tests; `signTypedData` mock que retorna firma 0x.. |
| `src/adapters/__tests__/payment.mainnet.test.ts` | confirma que mainnet path ya está testeado (KITE_NETWORK=mainnet → chainId=2366, EIP-712 domain `'USDC'`) | reset env between tests; verifies `getDefaultEip712DomainName()` returns `'USDC'` for mainnet |
| `.env.example` (lines 84-99 + 137-149) | confirma keys `KITE_NETWORK`, `X402_PAYMENT_TOKEN`, `X402_EIP712_DOMAIN_NAME`, `X402_TOKEN_SYMBOL` | Sección "Kite Network Selection (068)" ya documenta mainnet activation |
| `src/middleware/forward-key.test.ts` | (referencial) exemplar de tests para opt-in factory | si env unset → factory retorna `[]` → middleware NO mounted |

### Auto-blindaje histórico revisado (últimas 3 HUs DONE con archivo)

| HU | Patrón recurrente | CD aplicado |
|----|-------------------|-------------|
| WKH-88 (080) | Adding new mock dependency call (e.g. `kvClient.set` mutex pre-existing) breaks tests con `failNext`/call-count assumptions | CD-WKH69-7 below |
| WKH-86 (082) | Manifest/whitelist defaults amplían tests obsoletos; pattern more-specific must precede pattern more-general | CD-WKH69-7 below |
| WKH-75 (076) | Workspace branch instability between Bash/Edit calls causes silent file disappearance / branch flips | nota a Dev (no CD — workspace-level, no architectural) |

### Exemplars

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `src/middleware/passport.ts` (new) | `src/middleware/forward-key.ts` líneas 66-127 | Mismo patrón opt-in env-flag factory que retorna `[]` cuando off; `requireForwardKey()` es el canonical reference (DT-3 explicit) |
| `test/passport-*.test.ts` (new) | `src/middleware/event-tracking.test.ts` (Fastify-in-memory) + `src/adapters/__tests__/payment.contract.test.ts` (vi.mock viem) | Two-layer: middleware-level con `app.inject()` + adapter-level con mock signature |
| `src/middleware/x402.ts` (modify minor) | el propio archivo lines 82-188 | Solo agregar lectura de header `x-passport-session` y setear `request.paymentOrigin` para downstream middleware |
| `src/middleware/event-tracking.ts` (modify) | el propio archivo lines 33-84 | Solo agregar `request.paymentOrigin` al `metadata` payload (línea 67-74 — extender objeto) |
| `doc/passport-onboarding.md` (new) | `doc/runbooks/operator-identities-runbook.md` (WKH-80, similar runbook style) | Step-by-step CLI + smoke test section + troubleshooting |

### Estado de BD relevante

| Tabla | Existe | Columnas relevantes | Acción |
|-------|--------|---------------------|--------|
| `a2a_events` | Sí | `metadata: jsonb` (sin schema) | Cero migration. Insertar `payment_origin: "passport"\|"eoa"` dentro de `metadata` (DT-4) |
| `a2a_agent_keys` | Sí | `owner_ref` (CD-WKH53) | Esta HU NO toca esta tabla — N/A |

### Componentes reutilizables encontrados

- `getPaymentAdapter()` en `src/adapters/registry.ts` — single source para verify/settle path. NO duplicar.
- `eventService.track()` en `src/services/event.ts` — accepts arbitrary `metadata` JSONB. NO modificar la signature.
- `_resetWalletClient()` en `payment.ts` — helper para tests con env-vars dinámicos. Reutilizar.
- Pattern `requireForwardKey()` — exemplar exacto para `requirePassport()`.

---

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar | Wave |
|---------|--------|-------------|----------|------|
| `src/middleware/x402.ts` | Modify | Augmentar `FastifyRequest` con `paymentOrigin?: 'passport' \| 'eoa'`. En `requirePayment` handler: leer header `x-passport-session` (truthy → `'passport'`, ausente → `'eoa'`), setear `request.paymentOrigin` antes del adapter call. | el propio archivo lines 18-23, 82-188 | W1 |
| `src/middleware/event-tracking.ts` | Modify | Si `request.paymentOrigin` está seteado, incluirlo en `metadata.payment_origin` del `track()` call (línea 67-74). Sin breaking change: campo opcional. | el propio archivo lines 62-82 | W3 |
| `src/middleware/passport.ts` | Create | `requirePassport()` factory: si `PASSPORT_REQUIRE_INBOUND !== 'true'` retorna `[]`. Si está activo, valida que `request.paymentOrigin === 'passport'` (lo setea x402.ts via header) → si no, 403 `PASSPORT_REQUIRED`. | `src/middleware/forward-key.ts` lines 66-127 | W4 |
| `src/middleware/passport.test.ts` | Create | Tests for `requirePassport()` factory: env unset → `[]`; env true + header presente → 200; env true + header ausente → 403 con shape `{error, error_code}`. | `src/middleware/forward-key.test.ts` | W4 |
| `src/middleware/x402.passport-shape.test.ts` | Create | AC-6 test: construye `payment-signature` header con `authorization.from` derivado de keypair determinístico (mock Passport shape) + header `x-passport-session: true`; mockea `getPaymentAdapter()` y verifica que `decodeXPayment` parsea OK + `request.paymentOrigin === 'passport'` post-handler. | `src/middleware/event-tracking.test.ts` (Fastify in-memory) + `src/adapters/__tests__/payment.contract.test.ts` (vi.mock viem) | W1 |
| `test/fixtures/passport-shape.ts` | Create | Helper que genera un mock `payment-signature` header con shape Passport-derived. Comment block `// PASSPORT-MOCK-SHAPE:` (CD-WKH69-6). | exemplars en tests existentes | W1 |
| `doc/passport-onboarding.md` | Create | User onboarding flow + Smoke Test section (DT-7) + troubleshooting. | `doc/runbooks/operator-identities-runbook.md` | W2 |
| `.env.example` | Modify | Add `PASSPORT_REQUIRE_INBOUND=` (commented, default off) con bloque explicativo. | sección WASIAI_V2_FORWARD_KEY (lines 21-39) | W4 |
| `src/services/event.ts` | NO change | `metadata: Record<string, unknown>` ya acepta `payment_origin`. Cero modificación de service. | — | — |
| `src/adapters/kite-ozone/payment.ts` | NO change (only verify) | DEFAULTS mainnet ya correctos (líneas 90-93). Si W0 audit detecta drift → escalar al humano. | — | W0 (audit) |

### 4.2 Modelo de datos

**No DB migration**. `a2a_events.metadata` es `jsonb` sin schema enforcement. La nueva
key `payment_origin: "passport" | "eoa"` se inserta directamente en el objeto que ya
recibe `endpoint`, `method`, `statusCode`, etc. (`event-tracking.ts` línea 67-74).

Forward-compat: dashboard analytics (futura HU) podrá hacer `metadata->>'payment_origin'`
para conteo. Sin esta HU, las rows persisten sin esa key (= legacy null).

### 4.3 Componentes / Servicios

```
┌─────────────────────────────────────────────────────────────┐
│  Inbound x402 Request                                       │
│  (headers: payment-signature, optional x-passport-session) │
└──────────────┬──────────────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│ requirePassport (W4, opt-in only)   │ ← AC-10
│  - reads PASSPORT_REQUIRE_INBOUND   │
│  - if true & origin != passport:    │
│    403 PASSPORT_REQUIRED            │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│ requirePayment (x402.ts)            │ ← AC-1, AC-4 (origin set)
│  - reads x-passport-session header  │
│  - sets request.paymentOrigin       │
│  - calls adapter.verify + settle    │
│    (UNCHANGED path — agnostic)      │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│ Route handler (e.g. /orchestrate)   │ ← AC-9 (downstream untouched)
│  - downstream uses OPERATOR_PK      │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│ event-tracking.ts onResponse        │ ← AC-4 (payment_origin tagged)
│  - reads request.paymentOrigin      │
│  - eventService.track({metadata:    │
│       {payment_origin}})            │
└─────────────────────────────────────┘
```

### 4.4 Flujo principal (Happy Path) — 3 escenarios

**A) Passport-funded inbound + telemetry**:
1. Cliente Passport ejecuta `kpass agent:session execute --url https://wasiai-a2a/orchestrate ...`
2. Passport negocia 402, firma EIP-3009 con session keypair, retry con `payment-signature: <base64>` + `x-passport-session: true`
3. `requirePayment` → `decodeXPayment` parsea → `request.paymentOrigin = 'passport'`
4. Adapter `verify()` + `settle()` aceptan firma normalmente (path agnostic)
5. Route handler ejecuta lógica de negocio
6. `onResponse` hook → `eventService.track({metadata: {payment_origin: 'passport', ...}})`
7. Row en `a2a_events` con `metadata.payment_origin = 'passport'`

**B) EOA-funded inbound (legacy)**:
1. Cliente con EOA firma EIP-3009 con su PK, manda `payment-signature` (sin `x-passport-session`)
2. `requirePayment` → `request.paymentOrigin = 'eoa'`
3. Adapter accepts. Path idéntico.
4. Telemetry: `metadata.payment_origin = 'eoa'`

**C) Opt-in `requirePassport` activo**:
1. `PASSPORT_REQUIRE_INBOUND=true` env-set en deploy
2. Cliente EOA (sin `x-passport-session`) → `requirePassport` middleware setea origin? **No**: el orden es: x402 setea origin primero, requirePassport lee después. Por lo tanto el orden de mount en `app.ts` es: `[requirePayment, requirePassport, route-handler]` — pero requirePayment ya consumió 402 y settled. **Re-evaluar orden** — ver §11.

### 4.5 Flujo de error

| Caso | Respuesta |
|------|-----------|
| `payment-signature` ausente | 402 (existing path) |
| Firma inválida | 402 (existing path) |
| Settlement fail | 402 (existing path) |
| `PASSPORT_REQUIRE_INBOUND=true` + sin `x-passport-session` header | 403 `{"error":"Passport session required","error_code":"PASSPORT_REQUIRED"}` (AC-10) |
| `x-passport-session` con valor no-truthy (e.g. `"false"`) | Tratado como ausente — `paymentOrigin = 'eoa'` |
| `x-passport-session: true` pero firma falla verify | 402 normal (origin no afecta auth, solo telemetry) |

---

## 5. Constraint Directives (Anti-Alucinación)

### Heredados del work-item (líneas 95-113)

- **CD-WKH53** (inherited): toda query/mutación sobre `a2a_agent_keys` en `src/services/` DEBE incluir `.eq('owner_ref', ownerId)`. Esta HU NO toca esa tabla → no aplica directamente, pero CUALQUIER nuevo service-layer code que termine tocándola DEBE cumplir.
- **CD-WKH75** (inherited): NO modificar `src/cron/` ni `src/lib/kv.ts` fuera del scope de esta HU.
- **CD-WKH88** (inherited): HTTP method gates en cron endpoints. Esta HU NO crea endpoints cron → N/A direct, pero si se agrega cualquier endpoint, GET ≠ POST.
- **CD-WKH69-1**: PROHIBIDO modificar variables de entorno en Railway prod hasta que el smoke-test E2E con firma real Passport sea ejecutado (gate humano post-merge). Toda config nueva se documenta en `passport-onboarding.md` como "pendiente validación".
- **CD-WKH69-2**: PROHIBIDO romper backward-compatibility con flows EOA raw existentes. `KITE_NETWORK=testnet` (default) DEBE producir el mismo resultado que pre-HU. Tests existentes (PYUSD chain 2368) no se modifican.
- **CD-WKH69-3**: PROHIBIDO eliminar/modificar `OPERATOR_PRIVATE_KEY` en outbound settlement (cross-chain Avalanche). `src/lib/downstream-payment.ts` y similares NO se tocan.
- **CD-WKH69-4**: Las cuentas Passport (prod `0x7aB87602...` + staging `0xEB696D49...`) NO se borran. `.kite-passport/agent.json` permanece gitignored.
- **CD-WKH69-5**: PROHIBIDO hardcodear JWT, `agent_token`, `user_id`, `agent_id`, `public_key`, o cualquier Passport credential en código o tests. Todo valor sensible se lee de env vars o de archivos gitignored. Para tests: usar fixtures determinísticos vía keypair generado on-the-fly (DT-5).
- **CD-WKH69-6**: OBLIGATORIO — todo test que mockee Passport-shape signature DEBE incluir comment block `// PASSPORT-MOCK-SHAPE:` documentando: (a) keypair derivation assumption, (b) qué campo del delegation struct corresponde a cada test field, (c) qué open question del spike resuelve o asume.

### Nuevos (este SDD)

- **CD-WKH69-7** (de auto-blindaje WKH-88/86): cualquier nuevo test mock que use call-count assumptions (`failNext`, `mock.calls.length`) DEBE auditar tests existentes que comparten el mock. Preferir per-call-shape assertions (`expect(call[N].args[0]).toMatchObject(...)`) sobre raw counts. Si esta HU agrega `track()` calls extra, verificar `event-tracking.test.ts` line 111 etc. para `toHaveBeenCalledTimes(N)` que pueda romperse.
- **CD-WKH69-8**: PROHIBIDO crear archivos en `mcp-servers/wasiai-x402/` o `dist/` o cualquier deployable target. Esta HU es 100% dentro de `src/`, `test/`, `doc/`, `.env.example`.
- **CD-WKH69-9**: PROHIBIDO depender de imports de Passport SDK / Node SDK / kpass binary. Stay agnostic (DT-6). Imports externos: SOLO `viem`, `crypto`, `node:crypto`, librerías ya en `package.json`.
- **CD-WKH69-10**: OBLIGATORIO — el orden de mount de middleware en `app.ts` cuando `PASSPORT_REQUIRE_INBOUND=true` debe respetar: `requirePayment` (que setea `paymentOrigin`) ANTES de `requirePassport` (que lo lee). Si el orden quedara invertido, el guard recibiría `undefined` y siempre rechazaría (broken). Test `T-AC10-2` debe cubrir orden correcto.

### OBLIGATORIO seguir

- Patrón opt-in factory: seguir `requireForwardKey()` línea 66-79 de `forward-key.ts` (env unset → `[]`).
- Logging discipline: seguir `forward-key.ts` — NUNCA loguear el header value, solo `headerPresent: boolean` + truncated source si aplica.
- TypeScript strict: sin `any` explícito (CLAUDE.md).
- Tests: vitest, exemplares ya verificados.
- ESM imports con extensión `.js` (proyecto usa `.ts` source con `dist/.js` outputs — ver imports existentes).

### PROHIBIDO

- NO agregar dependencias nuevas al `package.json`.
- NO crear migrations en `migrations/`.
- NO tocar `src/lib/downstream-payment.ts` ni `src/services/budget.ts` (outbound).
- NO modificar `.kite-passport/` (gitignored).
- NO crear endpoints REST/JSON-RPC nuevos (esta HU es middleware + telemetry).
- NO commitear `.env`. Solo `.env.example`.
- NO usar `console.log` (proyecto usa `request.log` Pino).

---

## 6. Decisiones técnicas resueltas (DT-N)

> Las DT-1..DT-7 ya están redactadas en `work-item.md` líneas 67-91. Las repaso aquí
> sólo donde el SDD agrega resolución concreta o aclara la implementación.

**DT-1 (resuelto): payment_origin detection — header hint, no inference**
Server-side detection: leer header `x-passport-session`. Truthy (`"true"`, `"1"`, `"yes"`,
case-insensitive) → `paymentOrigin = 'passport'`. Cualquier otro valor (incluyendo
ausente) → `'eoa'`. **Telemetry-only**: NO se usa para auth (excepto AC-10 guard).
Esto responde a "Opción A (header)" de la pregunta DT-1 del prompt — descartando la
inferencia por shape de signature (frágil) y la lookup API (no existe SDK).

**DT-2 (resuelto): Mock strategy — keypair determinístico generado on-the-fly**
Tests usan `viem`'s `privateKeyToAccount(0x{32-bytes-fixed})` para generar una EVM
address determinística que actúa como "Passport session address". El test fixture
incluye comment block (CD-WKH69-6) explicando que esto es estructural — NO prueba
nada sobre el real ed25519 → secp256k1 mapping interno de Passport (open question
post-spike, ver `decision-doc.md` línea 168).

**DT-3 (resuelto): requirePassport — opt-in via PASSPORT_REQUIRE_INBOUND env, deployment-wide**
Sigue exemplar `requireForwardKey()`. NO per-route whitelist (DT-3 work-item línea 78-79
es explicit). Sin env var → factory retorna `[]` → middleware NO mounted. Con env
`"true"` → mounted globalmente en routes que ya usan `requirePayment`. Mount order:
ver CD-WKH69-10.

**DT-4 (resuelto): Telemetry — metadata JSONB extension**
`event-tracking.ts` línea 67-74 actualmente construye `metadata` con
`{endpoint, method, statusCode, responseTimeMs, timestamp, requestId}`. Esta HU
**spread-extends** con `...(request.paymentOrigin ? { payment_origin: request.paymentOrigin } : {})`.
Cero schema change; cero impact en rows legacy.

**DT-5 (parcial — diferido): Env vars Railway**
Esta HU **NO cambia env vars en Railway** (CD-WKH69-1). El `.env.example` queda con
`PASSPORT_REQUIRE_INBOUND=` (vacío) y comentario explicativo. Cuando el humano corra
el smoke-test post-merge y confirme firma real, decide si activar `PASSPORT_REQUIRE_INBOUND=true`
o no en cada environment. Backward compat con PYUSD: `KITE_NETWORK=testnet` (default)
sigue produciendo PYUSD path (existing tests cover esto).

**DT-6 (no aplica en F3): Live capture procedure**
La captura real de firma Passport (sin fondear) requiere `kpass agent:session create`
+ `kpass agent:session status --wait` para que la session quede aprobada. **Esto
NO bloquea F3** — el spike `poc-results.md` línea 92-93 ya capturó el `delegation`
struct y `public_key` shape. F3 usa keypair determinístico (DT-2). El humano puede
correr `kpass` post-merge para validar shape real (smoke-test, DT-7).

**DT-7 (resuelto): Smoke test E2E diferido**
`doc/passport-onboarding.md` incluye sección "Smoke Test (post-merge gate)" con steps
exactos para que el humano:
1. Fondee `0x7aB8760225Ffd90F23bd0B5BfC5B04965976AdB3` con ~$5 USDC mainnet
2. `kpass agent:session create` + approval URL via passkey
3. `kpass agent:session execute --url <wasiai-a2a-prod>/orchestrate`
4. Verifique 200 + `metadata.payment_origin = 'passport'` en la row de `a2a_events`
5. Si shape difiere de mock: open follow-up ticket WKH-XX

---

## 7. Plan de Waves

> 5 waves: W0 (audit, serial) → W1 (contract verification + tests) → W2 (docs)
> → W3 (telemetry) → W4 (hardening guard).

### W0 — Audit (Serial Gate, no code changes)

**Goal**: Confirmar que mainnet defaults USDC ya están correctos (AC-2, AC-3) **antes**
de escribir tests/code que dependa de eso. Detectar drift contra `project-context.md` /
spike artefacts.

**Files** (read-only):
- `src/adapters/kite-ozone/payment.ts` líneas 88-112 — verify defaults
- `src/adapters/kite-ozone/chain.ts` — verify chain 2366 def
- `.env.example` líneas 84-99, 137-149 — verify env keys

**Tests**: ninguno (audit only).

**Exit criteria**:
- Defaults `DEFAULT_PAYMENT_TOKEN_MAINNET=0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e` ✅
- Defaults `DEFAULT_EIP712_DOMAIN_NAME_MAINNET='USDC'` ✅
- Si drift detectado → escalar al humano antes de W1.

### W1 — Inbound contract verification + Passport-shape tests

**Goal**: Implementar `request.paymentOrigin` detection + tests con mock signature
shape Passport-derived. Cubrir AC-1, AC-2, AC-3, AC-6.

**Files**:
- `src/middleware/x402.ts` (modify):
  - Augmentar `FastifyRequest` interface (líneas 18-23) con `paymentOrigin?: 'passport' | 'eoa'`.
  - En `requirePayment` handler (línea 82+), antes de adapter.verify: leer
    `request.headers['x-passport-session']`. Si truthy → `request.paymentOrigin = 'passport'`. Else `'eoa'`.
- `test/fixtures/passport-shape.ts` (create): helper `buildPassportPaymentHeader(opts)`
  → `{ 'payment-signature': base64(...), 'x-passport-session': 'true' }`. Comment block CD-WKH69-6.
- `src/middleware/x402.passport-shape.test.ts` (create): tests
  - T-AC1-1: header con shape Passport-derived → `decodeXPayment` parsea OK
  - T-AC1-2: adapter mock acepta → `request.paymentOrigin === 'passport'`, status 200
  - T-AC2-1: adapter con `KITE_NETWORK=mainnet` → `getToken() === USDC_MAINNET`
  - T-AC3-1: con `KITE_NETWORK=mainnet` y `X402_EIP712_DOMAIN_NAME` unset → domain `'USDC'`
    (este test ya existe en `payment.mainnet.test.ts` línea 131-159 — **NO duplicar**, solo verificar pase)
  - T-AC6-1: round-trip `buildPassportPaymentHeader` → `decodeXPayment` → adapter mock OK
  - T-AC8-1: `KITE_NETWORK=testnet` (default) sin header `x-passport-session` → origin `'eoa'`, PYUSD path

**Exit criteria**:
- Tests nuevos pasan
- Baseline 794 tests sin regression (`npm test` full suite)
- `request.paymentOrigin` correctamente seteado en happy path

### W2 — Documentación

**Goal**: `doc/passport-onboarding.md` final con onboarding + smoke-test post-merge.
Cubre AC-5 + DT-7.

**Files**:
- `doc/passport-onboarding.md` (create):
  - § Quickstart (kpass install + signup + agent:register + session:create + execute)
  - § Architecture: diagram inbound Passport → wasiai-a2a → outbound operator
  - § Smoke Test (post-merge gate): steps 1-5 de DT-7
  - § Troubleshooting (faucet bug, jq dep, dir name `.kite-passport` not `.kpass`)
  - § Telemetry: how to query `a2a_events.metadata->>'payment_origin'`
  - § Env vars referencia: `PASSPORT_REQUIRE_INBOUND`, `KITE_NETWORK`, etc.

**Tests**: ninguno (doc only).

**Exit criteria**:
- Doc revisada por Architect (self-review): completitud + sin alucinaciones
- Comandos `kpass *` cited verbatim from `discovery-notes.md` líneas 53-103

### W3 — Telemetry payment_origin

**Goal**: `event-tracking.ts` propaga `request.paymentOrigin` a `metadata.payment_origin`
en `a2a_events`. Cubre AC-4.

**Files**:
- `src/middleware/event-tracking.ts` (modify):
  - Augmentar `FastifyRequest` (línea 24-29) si necesario — ya viene de x402.ts.
  - En el `metadata` object (línea 67-74): spread `...(request.paymentOrigin ? { payment_origin: request.paymentOrigin } : {})`.
- `src/middleware/event-tracking.test.ts` (modify):
  - **CUIDADO** (CD-WKH69-7 / auto-blindaje 080): los tests AC-1 (línea 105+) hacen `expect(mockTrack).toHaveBeenCalledTimes(1)` y consultan `mock.calls[0][0]`. Mi cambio NO debería alterar count; solo verificar que `metadata.payment_origin` aparece **cuando** `request.paymentOrigin` está set.
  - T-AC4-1 (new): inject con `paymentOrigin = 'passport'` (mockear setting de la prop) → `metadata.payment_origin === 'passport'`
  - T-AC4-2 (new): inject sin paymentOrigin → `metadata.payment_origin` AUSENTE (no `undefined`, ausente para forward-compat)

**Exit criteria**:
- Tests existentes pasan sin modificar (no count regression)
- Tests nuevos validan AC-4 ambos branches

### W4 — Hardening (requirePassport guard + .env.example)

**Goal**: Opt-in middleware `requirePassport` + env doc. Cubre AC-10.

**Files**:
- `src/middleware/passport.ts` (create):
  - `requirePassport(): preHandlerAsyncHookHandler[]` factory (exemplar `forward-key.ts`)
  - Reads `process.env.PASSPORT_REQUIRE_INBOUND`. Solo `'true'` activa (case-sensitive estricto, evitar `'TRUE'`/`'1'` por explicitness — match patrón `WASIAI_DOWNSTREAM_X402` en `.env.example` línea 296).
  - Si activo: handler verifica `request.paymentOrigin === 'passport'`. Si no, retorna 403 con
    `{ error: 'Passport session required', error_code: 'PASSPORT_REQUIRED' }`.
  - Logging: `request.log.warn({ paymentOrigin: request.paymentOrigin }, 'passport-required: rejected')` — NO leak header values.
- `src/middleware/passport.test.ts` (create):
  - T-AC10-1: env unset → factory retorna `[]`
  - T-AC10-2: env `'true'` + `paymentOrigin='passport'` → passthrough
  - T-AC10-3: env `'true'` + `paymentOrigin='eoa'` → 403 + body match
  - T-AC10-4: env `'true'` + `paymentOrigin=undefined` (middleware misconfigured) → 403 (fail-secure)
  - T-AC10-5: env `'TRUE'` (case mismatch) → factory retorna `[]` (strict comparison)
  - T-AC10-6: env `'false'` o cualquier otro → factory retorna `[]`
- `.env.example` (modify):
  - Add bloque `PASSPORT_REQUIRE_INBOUND=` antes o después de `WASIAI_V2_FORWARD_KEY` (línea 39).
  - Comentario explicativo: opt-in, default off, requires `x-passport-session: true` header on inbound.
- **Mount integration**: si esta HU mounta `requirePassport` en algún route (e.g. `/orchestrate`),
  el orden DEBE ser `[requirePayment, requirePassport, ...]` (CD-WKH69-10). **Decisión**:
  esta HU NO mounta `requirePassport` en routes (delegación al humano post-merge), solo
  exporta el factory + tests + doc. Si el humano quiere activar, edita `app.ts` o el
  route handler. Esto evita cambios bloqueantes pre-smoke-test (CD-WKH69-1).

**Exit criteria**:
- Tests pasan (≥6 nuevos)
- Baseline tests sin regression
- `.env.example` documenta nuevo flag

---

## 8. Test Plan

| Test ID | AC cubierto | Wave | Archivo | Descripción |
|---------|-------------|------|---------|-------------|
| T-AC1-1 | AC-1 | W1 | `x402.passport-shape.test.ts` | Mock Passport-shape header → `decodeXPayment` parsea sin throw |
| T-AC1-2 | AC-1 | W1 | `x402.passport-shape.test.ts` | Adapter mock acepta firma → 200 + `request.paymentOrigin='passport'` |
| T-AC2-1 | AC-2 | W1 | `x402.passport-shape.test.ts` | `KITE_NETWORK=mainnet` → `adapter.getToken()` = USDC mainnet (verify pase, no duplicar) |
| T-AC3-1 | AC-3 | W1 | `payment.mainnet.test.ts` (existing) | `KITE_NETWORK=mainnet` + domain unset → domain `'USDC'` (test ya existe) |
| T-AC4-1 | AC-4 | W3 | `event-tracking.test.ts` | `paymentOrigin='passport'` → `metadata.payment_origin='passport'` |
| T-AC4-2 | AC-4 | W3 | `event-tracking.test.ts` | `paymentOrigin='eoa'` → `metadata.payment_origin='eoa'` |
| T-AC4-3 | AC-4 | W3 | `event-tracking.test.ts` | `paymentOrigin=undefined` → key ausente en metadata (no key with value undefined) |
| T-AC5-1 | AC-5 | W2 | (manual review) | `passport-onboarding.md` existe + contiene secciones Quickstart, Smoke Test, Troubleshooting |
| T-AC6-1 | AC-6 | W1 | `x402.passport-shape.test.ts` | Round-trip: `buildPassportPaymentHeader` → `decodeXPayment` → adapter mock acepta |
| T-AC7 | AC-7 | post-W4 | `npm test` | Baseline ≥794 tests pasan sin regression |
| T-AC8-1 | AC-8 | W1 | `x402.passport-shape.test.ts` | `KITE_NETWORK=testnet` (default) → PYUSD path inalterado |
| T-AC9 | AC-9 | post-W4 | (audit) | Grep `OPERATOR_PRIVATE_KEY` references — mismas que pre-HU |
| T-AC10-1 | AC-10 | W4 | `passport.test.ts` | env unset → `[]` |
| T-AC10-2 | AC-10 | W4 | `passport.test.ts` | env `'true'` + origin `'passport'` → passthrough |
| T-AC10-3 | AC-10 | W4 | `passport.test.ts` | env `'true'` + origin `'eoa'` → 403 PASSPORT_REQUIRED |
| T-AC10-4 | AC-10 | W4 | `passport.test.ts` | env `'true'` + origin undefined → 403 (fail-secure) |
| T-AC10-5 | AC-10 | W4 | `passport.test.ts` | env `'TRUE'` → `[]` (strict 'true' only) |
| T-AC10-6 | AC-10 | W4 | `passport.test.ts` | env any other value → `[]` |

**Total tests nuevos**: ~14 (excluding existing T-AC3-1 reuse).

**Mock fixtures necesarias**:
- `test/fixtures/passport-shape.ts`:
  - `buildPassportPaymentHeader(opts: { from?, to?, value? })` — returns `{ headers, paymentRequest }`
  - Uses `privateKeyToAccount(deterministicKey)` from `viem/accounts` for `from` derivation
  - Comment block `// PASSPORT-MOCK-SHAPE:` per CD-WKH69-6 — documents:
    (a) keypair = `0x{fixed-32-bytes}`, NOT a real Passport ed25519
    (b) `from` field corresponds to `delegation.public_key`-derived EVM address (assumed)
    (c) Open question #1 from `decision-doc.md` line 168: real wire shape unknown until smoke-test
- `test/fixtures/eoa-shape.ts` (only if needed — likely existing `payment.contract.test.ts` mocks suffice)

---

## 9. Riesgos y Mitigaciones

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|-----------|
| EIP-712 domain shape mainnet difiere del expected (`'USDC'`) | M | A (verify fail) | W0 audit confirma defaults; smoke-test post-merge valida real Passport sig (DT-7) |
| Real Passport public key derivation NO mapea 1:1 a EVM address vía secp256k1 | M | A (telemetry bug) | DT-2 + comment block CD-WKH69-6 documenta assumption; smoke-test es ground truth; si falla, follow-up ticket |
| Backward-compat break en EOA path | B | A | CD-WKH69-2; T-AC8-1 lock testnet PYUSD path; baseline 794 tests sin regression (T-AC7) |
| Multi-tenant Passport vs `wasi_a2a_keys` collision | B | M | Esta HU NO toca `wasi_a2a_keys`; coexistence path es explicit (`paymentOrigin` is metadata-only, no auth role) |
| Rate-limits Passport en E2E | B | B (test-only) | No aplica en F3 (mocks). Smoke-test single shot. |
| ChainId binding mismatch (2366 vs 2368) en firma | M | A | Existing test `payment.mainnet.test.ts` línea 131-159 lock chain 2366 with mainnet; T-AC8-1 lock 2368 testnet |
| Mock-call-count drift en `event-tracking.test.ts` por agregar payload key | M | M (CI fail) | CD-WKH69-7; W3 plan explícitamente verifica que `toHaveBeenCalledTimes` no se altera; usar object-matching, no count-based |
| Mount order `requirePayment` ↔ `requirePassport` invertido | B | A (always reject) | CD-WKH69-10; T-AC10-4 cubre fail-secure; W4 NO mounta el guard en routes (delegación al humano) |
| Passport SDK aparece mid-HU | B | B | DT-6 explicit reject; CD-WKH69-9 prohibe imports |
| Workspace branch instability (auto-blindaje WKH-75) | M | M (lost work) | Dev guidance: prefer atomic Bash batches; verify branch BEFORE/AFTER each test+commit. NO architectural fix posible. |

---

## 10. Dependencias

**Pre-requisitos antes de empezar F3**:
- [x] Branch `feat/084-wkh-69-passport-hybrid-inbound` desde `main` `ce393e9` checkout
- [x] `npm install` clean (no new deps)
- [x] Baseline tests pasan en local: `npm test` ≥794 tests OK
- [x] Spike artefacts disponibles (`doc/sdd/spike-kite-passport/`)
- [x] `.kite-passport/agent.json` gitignored (verificar con `git check-ignore -v .kite-passport/`)

**Bloqueado por**: nada en este repo. WKH-87 ya está DONE (`ce393e9`).

**Bloquea**: ninguna HU activa. Dashboard analytics breakdown por `payment_origin` es post-merge.

---

## 11. Mount-order y orden de hooks (clarificación)

`requirePayment` setea `request.paymentOrigin` durante su ejecución. `requirePassport`
debe ejecutarse **DESPUÉS** para leer ese campo. Fastify ejecuta `preHandler` en el
orden de registro.

**Decisión final** (para reducir blast-radius en F3):

- W4 **exporta** `requirePassport()` factory + tests + doc.
- W4 **NO mounta** el guard en `app.ts` ni en routes específicos.
- El humano, post-smoke-test exitoso, edita `app.ts` o el route que quiera proteger
  para mountarlo en orden correcto: `[requirePayment, requirePassport, ...]`.
- `passport-onboarding.md` documenta este step manual.

Esto cumple con CD-WKH69-1 (no Railway env changes prematuros) Y CD-WKH69-10
(orden correcto cuando se monte). Tradeoff: AC-10 está cubierto **a nivel factory**
(tests demuestran comportamiento), no a nivel runtime live. El work-item AC-10 dice
"WHERE `PASSPORT_REQUIRE_INBOUND=true` env flag is set, the system SHALL reject..."
— esta HU implementa la **capacidad** de rechazar; la activación queda gated por
humano.

> **Si el QA en F4 considera que esto NO satisface AC-10**, marcar como follow-up
> en F4 reporte y abrir ticket post-merge para mount integration. NO bloquear merge.

---

## 12. Missing Inputs

| Item | Bloqueante? | Resolución |
|------|-------------|-----------|
| Wire shape exacto de `authorization.from` en una real Passport-funded tx | No para F3 | Smoke-test post-merge (DT-7); fixture mock asume secp256k1 derivation (CD-WKH69-6) |
| Canonical USDC contract en chain 2366 PROD vs staging (`0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e`) | No | Default ya en `payment.ts` línea 91; smoke-test confirma |
| Kite API pública para session address lookup | No | DT-1 explicit reject — telemetry-only via header hint |
| Staging faucet bug fix | No | Externo a Kite team — no bloquea F3 (mock testing) |

---

## 13. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| (ninguno) | — | Todos los TBDs del work-item resueltos por DTs en §6 | No |

---

## 14. Readiness Check (F2 → SPEC_APPROVED gate)

```
[x] Cada AC tiene al menos 1 test asociado (§8 tabla — 10 ACs / 14 tests)
[x] Cada archivo en §4.1 tiene Exemplar verificado con Read
[x] No hay [NEEDS CLARIFICATION] pendientes
[x] Constraint Directives ≥3 PROHIBIDO (§5: 6+ heredados + 4 nuevos = 10 CDs)
[x] Context Map tiene ≥2 archivos leídos (§3: 10 archivos verificados)
[x] Scope IN y OUT explícitos y no ambiguos (§2)
[x] BD: tabla `a2a_events.metadata` jsonb verificada (§4.2)
[x] Flujo Happy Path completo (§4.4 con 3 escenarios)
[x] Flujo de error definido (§4.5 con 6 casos)
[x] Wave plan claro con exit criteria (§7)
[x] Test plan ≥1 test por AC (§8)
[x] Risks documentados (§9)
[x] Auto-blindaje histórico revisado y CD agregado (§3 + CD-WKH69-7)
[x] Mount-order clarification para AC-10 documentada (§11)
[x] Smoke-test E2E plan diferido para humano post-merge (§7 W2 + DT-7)
[x] CD-WKH69-1 respetado: zero Railway env changes en esta HU
```

**Status**: ✅ READY for SPEC_APPROVED gate.

---

## 15. Resumen de archivos finales

| Archivo | Acción | LOC estimadas |
|---------|--------|--------------|
| `src/middleware/x402.ts` | Modify | +15 |
| `src/middleware/event-tracking.ts` | Modify | +5 |
| `src/middleware/passport.ts` | Create | ~60 |
| `src/middleware/passport.test.ts` | Create | ~150 |
| `src/middleware/x402.passport-shape.test.ts` | Create | ~200 |
| `src/middleware/event-tracking.test.ts` | Modify | +50 |
| `test/fixtures/passport-shape.ts` | Create | ~80 |
| `doc/passport-onboarding.md` | Create | ~250 lines (md) |
| `.env.example` | Modify | +18 |
| **Total** | | **~828 LOC + doc** |

Tests nuevos: ~14. Tests modificados: 0 (solo `event-tracking.test.ts` agrega T-AC4-*).

---

## 16. Referencias

- Spike WKH-68: `doc/sdd/spike-kite-passport/{decision-doc.md, poc-results.md, discovery-notes.md}`
- Work item: `doc/sdd/084-wkh-69-passport-hybrid-inbound/work-item.md`
- Project context: `.nexus/project-context.md` (stack, reglas)
- Skill template: `~/.claude/skills/nexus-agile/references/sdd_template.md` (FULL)
- Auto-blindaje refs: `doc/sdd/080-wkh-88-bearer-rotation-refinements/auto-blindaje.md`,
  `doc/sdd/082-wkh-86-migration-preflight-refinements/auto-blindaje.md`,
  `doc/sdd/076-wkh-75-bearer-rotation-cron/auto-blindaje.md`
- Existing exemplars verificados:
  - `src/middleware/forward-key.ts` (canonical opt-in factory)
  - `src/middleware/event-tracking.ts` (telemetry hook)
  - `src/adapters/__tests__/payment.mainnet.test.ts` (KITE_NETWORK mainnet tests)
  - `src/adapters/__tests__/payment.contract.test.ts` (vi.mock viem pattern)

---

*SDD generado por NexusAgil — F2 — Architect — 2026-05-03*
