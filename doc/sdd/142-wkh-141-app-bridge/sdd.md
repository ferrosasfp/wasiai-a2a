# SDD #142: [WKH-141 v1] APP Bridge — Capability Declaration + Internal Mapping

> SPEC_APPROVED: no
> Fecha: 2026-07-04
> Tipo: feature/interop
> SDD_MODE: full
> Branch: feat/142-wkh-141-app-capability-declaration
> Artefactos: doc/sdd/142-wkh-141-app-bridge/
> Depende de: WKH-135 (`session`/`upto`, DONE, NNN 137) · WKH-133 (patrón feature-flag, DONE, NNN 134)

---

## 1. Resumen

Se construye el **v1 acotado, outbound-only** del bridge APP-compatible: (a) un
campo **aditivo** en el Agent Card que declara —en el vocabulario de intents de
APP (`charge`/`session`/`upto`)— qué primitivas de pago puede settlear el gateway
WasiAI para ese agente, y (b) un **adaptador interno PURO** (`app-intent-mapper.ts`,
sin I/O, sin persistencia, sin endpoint) que traduce el resultado de nuestras
operaciones ya existentes (x402 `charge`, WKH-135 `session`/`upto`) a un envelope
versionado con vocabulario APP. Todo detrás de un **feature flag default OFF**
(`APP_BRIDGE_ENABLED`, patrón WKH-133).

**Por qué es outbound-only-safe:** el v1 NUNCA parsea un wire-format ajeno. Solo
*declara* capacidades propias (outbound) y *mapea* datos nuestros ya validados
(interno). No se abre ninguna superficie de deserialización de payloads de un
tercero — el mismo tipo de riesgo que los hallazgos ya remediados WKH-60 (RCE) y
WKH-62 (SSRF). La honestidad del positioning (AC-6/CD-3) se **hornea en el tipo**:
tanto el campo del card como el envelope llevan `alignment: 'conceptual'` +
`disclaimer` como campos NO opcionales, de modo que es estructuralmente imposible
surfacear la declaración sin la aclaración.

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 142 (WKH-141) |
| **Tipo** | feature/interop |
| **SDD_MODE** | full |
| **Objetivo** | Declarar (outbound) capacidades APP-compatibles en el Agent Card + mapear (interno, puro) nuestros intents al vocabulario APP, sin aceptar/parsear payloads ajenos, flag default OFF |
| **Reglas de negocio** | Aditivo y no-breaking en un contrato público (Agent Card, consumido por wasiai-v2/registries). Cero cambio de money-path. Positioning honesto (no "certificado"). |
| **Scope IN** | `src/services/agent-card.ts` (campo aditivo), `src/adapters/app-intent-mapper.ts` (nuevo, puro), `src/types/index.ts` (tipos), flag `APP_BRIDGE_ENABLED`, tests |
| **Scope OUT** | Endpoint inbound que parsee APP · XMTP · MPP real · escrow intent · cambio de settlement/money-path · certificación de interop real |
| **Missing Inputs** | #1/#2/#3 (spec real de APP, XMTP, dirección del bridge) → **v2, NO bloquean este v1**. #4 (shape del campo) y #5 (flag global vs per-agente) → **resueltos en este SDD** (§4.3, DT-4/DT-5) |

### Acceptance Criteria (EARS)

1. **AC-1** — WHEN se solicita `GET /agents/:id/agent-card` con el flag `APP_BRIDGE_ENABLED=true` y el agente opta-in explícitamente, THE system SHALL incluir un campo aditivo `paymentIntents` que liste los intents en vocabulario APP soportados, sin alterar ningún campo existente del card.
2. **AC-2** — WHEN el mapper recibe un resultado ya-validado de una operación existente (`charge`/`session`/`upto`), THE system SHALL producir un envelope versionado con vocabulario APP — función pura, no persistido, no expuesto por HTTP.
3. **AC-3** — IF no hay confirmación humana del wire-format exacto de APP, THEN THE system SHALL NO exponer ningún endpoint que parsee/acepte payloads APP de un tercero (estrictamente outbound + interno).
4. **AC-4** — WHILE `APP_BRIDGE_ENABLED` está OFF (default), THE system SHALL comportarse byte-idéntico al estado actual (campo ausente, mapper no invocado desde ningún path de request).
5. **AC-5** — WHEN corre la suite existente de `agent-card`/`discover`, THE system SHALL mostrar cero regresiones en los campos ya consumidos (el campo nuevo es estrictamente aditivo).
6. **AC-6** — IF se surfacea la declaración de capacidades, THEN THE system SHALL aclarar explícitamente que es alineación **conceptual/vocabulario compartido**, NO interop certificada end-to-end — prohibido "certificado"/"100% compatible" sin la aclaración.

---

## 3. Context Map (Codebase Grounding)

### Archivos leídos (verificados con Read/Glob)
| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `src/services/agent-card.ts` | Punto de extensión del Agent Card (AC-1) | Campos aditivos opcionales via spread condicional `...(x !== undefined && { x })` (líneas 135, 148-156); opt-in por-agente estricto `agent.metadata.X === true` (`isDiscoverable` L18-20, `a2aCompliant` L135) |
| `src/types/index.ts` (L785-828, L1100-1124) | Contrato `AgentCard` + `SettleOutcome` reales | `AgentCard` ya tiene extensiones opcionales `identity?`/`computedReputation?`/`inputSchema?` (DT-6 "consumers que no la entienden la ignoran"). `SettleOutcome` = `{ status, txHash, finalAmountUsd, consumedUsd?, residualUsd?, cappedAt?, error?, failureKind? }` |
| `src/services/payment-intent.ts` (L349,509-511,540-542,564-568,812-814,866-871) | Shapes reales de nuestros intents (fuente del mapeo, AC-2) | `openSession`/`createUpto` → `{ intentId, expiresAt }`; `closeSession`/`settleUpto` → `SettleOutcome`; `addVoucher` → `{ accepted, consumedUsd, duplicate }` |
| `src/middleware/x402.ts` (L111-135) | Shape real del `charge` (x402) | `X402PaymentPayload` = `{ scheme, network, maxAmountRequired, resource, payTo, asset, ... }`; `X402Response` = `{ error, accepts:[payload], x402Version:2 }` |
| `src/adapters/erc8004-reputation-writer.ts` (L19,76-78) | Patrón de feature-flag WKH-133 (DT-3/CD-4) | `export function isXEnabled() { return process.env.FLAG === 'true'; }` — ON solo con el literal exacto `'true'`, cualquier otra cosa OFF |
| `doc/competitive/okx-ai-analysis-2026-07.md` (L15-16,22,43,55) | Fuente de la HU (vocabulario APP) | APP = 1 wire-format, 4 intents (`charge`/`escrow`/`session`/`upto`); v1 declara solo los 3 con money-path real hoy |

### Exemplars
| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `src/adapters/app-intent-mapper.ts` (nuevo) | `src/adapters/erc8004-reputation.ts` (módulo puro con result-types tipados) + input allow-list (ver §4.3) | Módulo de adaptador con tipos de resultado propios; el mapper es más simple (100% puro, sin viem) |
| `src/services/agent-card.ts` (campo `paymentIntents`) | `agent-card.ts:135,148-156` (spread condicional) + `isDiscoverable` L18-20 (opt-in estricto) | Campo aditivo omitido cuando no aplica; opt-in por-agente reusa el patrón existente |
| `src/services/agent-card.test.ts` (extender) | El mismo archivo (tests de `discoverable`/`a2aCompliant` aditivos) | No-regresión + gate de flag OFF |
| Flag `isAppBridgeEnabled()` en `agent-card.ts` | `erc8004-reputation-writer.ts:76-78` | `=== 'true'` estricto |

### Estado de BD relevante
| Tabla | Existe | Nota |
|-------|--------|------|
| — | N/A | **Cero cambios de BD.** El v1 es declarativo/mapeo puro. No hay tabla nueva, no hay columna nueva, no hay migración. |

### Componentes reutilizables encontrados
- `isDiscoverable`/patrón opt-in estricto (`agent-card.ts:18-20`) — reutilizar la forma para el opt-in por-agente `appPaymentIntents === true`.
- Spread condicional aditivo (`agent-card.ts:148-156`) — reutilizar para omitir el campo cuando el flag/opt-in no aplican.
- Result-types tipados de adaptador (`erc8004-reputation.ts`) — reutilizar la forma para `AppIntentEnvelope`.

---

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `src/types/index.ts` | Modificar | Tipos W0: `AppIntentName`, `AppIntentEnvelope`, `AppIntentDescriptor`, inputs allow-list del mapper (`ChargeMapInput`/`SessionMapInput`/`UptoMapInput`), y campo `paymentIntents?` en `AgentCard` | `AgentCard` L785-828 (extensiones opcionales existentes) |
| `src/adapters/app-intent-mapper.ts` | Crear | Funciones PURAS: `mapChargeToApp`/`mapSessionToApp`/`mapUptoToApp` (input allow-listed → `AppIntentEnvelope`) + `getSupportedAppIntents()` (descriptor para el card). Sin imports de db/redis/viem/fetch/fs | `erc8004-reputation.ts` (result-types) |
| `src/services/agent-card.ts` | Modificar | `isAppBridgeEnabled()` (flag) + opt-in por-agente `appPaymentIntents === true` + inclusión aditiva del campo `paymentIntents` en `buildAgentCard` y `buildSelfAgentCard` (self gated solo por flag) | `agent-card.ts:18-20,135,148-156` |
| `src/adapters/app-intent-mapper.test.ts` | Crear | Tests unitarios del mapper (AC-2, AC-6, pureza, no-leak) | `erc8004-reputation.test.ts` |
| `src/services/agent-card.test.ts` | Modificar | Tests del campo aditivo (AC-1, AC-4, AC-5, AC-6) | mismo archivo |

### 4.2 Modelo de datos

N/A — cero cambios de BD (ver §3 tabla de BD).

### 4.3 Componentes / Servicios

**A) Campo del Agent Card (resuelve Missing Input #4 → DT-4).** Campo top-level
opcional `paymentIntents` en `AgentCard`, forma:

```
paymentIntents?: {
  vocabulary: 'app';                 // literal — namespace de vocabulario (intents de OKX APP)
  supported: AppIntentName[];        // ('charge' | 'session' | 'upto')[]
  alignment: 'conceptual';           // literal NO opcional — AC-6/CD-3 horneado en el tipo
  disclaimer: string;                // NO opcional — aclaración honesta siempre presente
}
```

Se eligió top-level (no bajo `capabilities`) para mantener `capabilities` con su
shape estricto actual (booleans) y seguir la convención de extensiones opcionales
top-level (`identity?`/`computedReputation?`). `alignment` y `disclaimer` son
**no opcionales**: el tipo hace imposible surfacear la capacidad sin la aclaración
(AC-6/CD-3 por construcción).

**B) Gate de inclusión (resuelve Missing Input #5 → DT-5).** El campo se incluye en
`buildAgentCard` SOLO si:
1. `isAppBridgeEnabled()` (global, `APP_BRIDGE_ENABLED === 'true'`, default OFF), **Y**
2. opt-in por-agente estricto: `agent.metadata?.appPaymentIntents === true` (mismo
   patrón que `isDiscoverable`; ausente/`false`/truthy-no-literal → NO se declara).

`buildSelfAgentCard` (el card propio del gateway) se gatea **solo por el flag
global** (no hay metadata por-agente; es el gateway declarándose). Con el flag OFF
ambos caminos omiten el campo → byte-idéntico (AC-4/CD-4).

**C) Mapper puro (`app-intent-mapper.ts`).** `AppIntentEnvelope`:

```
AppIntentEnvelope = {
  vocabulary: 'app';
  envelopeVersion: string;           // versión de NUESTRO mapeo, p.ej. 'wasiai-app-map/v1'
  intent: 'charge' | 'session' | 'upto';
  alignment: 'conceptual';           // literal NO opcional (AC-6)
  status?: 'settled' | 'failed' | 'in_progress' | 'challenge';  // derivado, no sensible
  amountUsd?: number;
  chainId?: number;
  txHash?: string | null;
  expiresAt?: string;
  disclaimer: string;                // NO opcional
}
```

**Allow-list de inputs (CD-6, anti-leak).** Los inputs del mapper son interfaces
**estrechas** con SOLO campos no sensibles (`amountUsd`, `chainId`, `status`,
`txHash`, `expiresAt`, `intent`). El mapper **NO** recibe `SettleOutcome`/
`X402Response` crudos ni el row del caller: el call-site (futuro) debe extraer los
campos permitidos ANTES de llamar. El mapper **NUNCA** ve ni copia `ownerRef`,
`buyerWallet`, `keyId`, `sellerRef`, `payTo`, `capSignature`, `funding_wallet`,
`typedData`, `budget`, `error` interno. Esto se testea por ausencia.

`getSupportedAppIntents(): AppIntentDescriptor[]` devuelve la lista estática de
intents que el gateway settlea hoy (`charge`/`session`/`upto`) con su alignment —
usado por `agent-card.ts` para poblar `supported`.

### 4.4 Flujo principal (Happy Path)

**AC-1 (declaración):** request `GET /agents/:id/agent-card` → route llama
`buildAgentCard` → si `isAppBridgeEnabled()` && `metadata.appPaymentIntents===true`
→ el card incluye `paymentIntents: { vocabulary:'app', supported:['charge','session','upto'], alignment:'conceptual', disclaimer:'...' }`.

**AC-2 (mapeo interno):** en un test (o call-site futuro), se extraen los campos
permitidos de un resultado ya-validado y se pasan a `mapSessionToApp(input)` →
retorna `AppIntentEnvelope` con vocabulario APP. No toca red/DB/fs, no persiste,
no hay endpoint.

### 4.5 Flujo de error

- **Flag OFF (default):** `buildAgentCard` omite `paymentIntents` (spread
  condicional no-op). Cero diferencia observable (AC-4).
- **Opt-in ausente/no-literal con flag ON:** campo omitido (AC-4/Missing#5).
- **Mapper con input parcial:** los campos opcionales del envelope se omiten via
  asignación condicional (nunca `?: undefined`, ver CD-7); `vocabulary`/`intent`/
  `alignment`/`disclaimer`/`envelopeVersion` siempre presentes. El mapper no
  lanza (input ya validado aguas arriba).
- **Intento de wire-format inbound:** N/A — no existe endpoint que lo acepte
  (AC-3/CD-1). Invariante estructural, no runtime.

---

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir
- **CD-2** — El campo del Agent Card es **100% aditivo**: no renombra, no remueve,
  no cambia el tipo de ningún campo existente consumido por wasiai-v2/registries.
  Verificar contra `src/services/agent-card.test.ts` (no-regresión).
- **CD-4** — Feature flag `APP_BRIDGE_ENABLED` default OFF; con el flag OFF el
  comportamiento es byte-idéntico al estado pre-HU (test explícito). Helper
  `isAppBridgeEnabled()` con `=== 'true'` estricto (patrón WKH-133).
- **CD-5** — El mapper `app-intent-mapper.ts` es **función pura**: cero I/O (db,
  red, fs, process.env). Testeable sin mocks de infraestructura. (El flag NO vive
  en el mapper — vive en `agent-card.ts`.)
- **CD-6** *(hereda del aprendizaje WKH-137 auto-blindaje BLQ-1)* — El envelope y
  los inputs del mapper son **allow-list explícita**: PROHIBIDO `...spread` de un
  shape interno rico (`SettleOutcome`/`X402Response`/row del caller) hacia el
  envelope. NUNCA incluir `ownerRef`/`buyerWallet`/`keyId`/`sellerRef`/`payTo`/
  `capSignature`/`funding_wallet`/`typedData`/`budget`. Shape interno ≠ shape de
  canal externo.
- **CD-7** *(hereda del aprendizaje recurrente WKH-133/134/136/137)* — Con
  `exactOptionalPropertyTypes:true`: construir campos opcionales del envelope/card
  con asignación condicional (`if (v !== undefined) obj.x = v`), **NUNCA**
  `x: cond ? v : undefined` ni `?:` con `undefined`.
- Imports: solo módulos que EXISTEN. viem PROHIBIDO en el mapper (no lo necesita).

### PROHIBIDO
- **CD-1** — PROHIBIDO exponer cualquier endpoint HTTP que acepte/parsee un payload
  con wire-format de APP como input no confiable de un tercero sin confirmación
  humana del schema exacto. Cualquier PR que lo haga = BLOQUEANTE en AR
  (severidad equivalente a deserialización insegura; ref. WKH-60/WKH-62).
- **CD-3** — PROHIBIDO afirmar "certificado APP-compatible"/"100% compatible" en
  cualquier doc/README/pitch/campo sin la aclaración de AC-6. La honestidad está
  horneada: `alignment:'conceptual'` + `disclaimer` son NO opcionales.
- **CD-8** — PROHIBIDO declarar el intent `escrow` (4º de APP): no está cableado al
  vocabulario de intents hoy (el escrow WKH-126 es un primitivo distinto).
  Declararlo sería overclaim. Solo `charge`/`session`/`upto`.
- NO agregar dependencias nuevas. NO cambiar el money-path (`charge`/`session`/
  `upto`/settlement). NO tocar archivos fuera del Scope IN. NO crear migraciones.

---

## 6. Scope

**IN:** campo aditivo `paymentIntents` en el Agent Card (outbound) · mapper puro
`app-intent-mapper.ts` (charge/session/upto → envelope APP) · tipos en
`types/index.ts` · flag `APP_BRIDGE_ENABLED` default OFF · tests · disclaimer de
honestidad horneado en el tipo.

**OUT:** endpoint inbound que parsee APP · XMTP · MPP real · intent `escrow` ·
cambio de settlement/money-path · certificación de interop real · decisión
inbound-vs-outbound del v2 (Missing Inputs #1/#2/#3).

---

## 7. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Overclaim: surfacear "compatible" sin aclaración (AC-6/CD-3) | M | Reputacional | `alignment:'conceptual'`+`disclaimer` NO opcionales → imposible por tipo. Test de ausencia de "certified"/"100%" |
| Leak: el envelope arrastra datos financieros del owner (WKH-137 BLQ-1) | M | Seguridad (IDOR-like) | CD-6 allow-list; inputs estrechos; test de ausencia de campos sensibles |
| Regresión en el contrato público del Agent Card (CD-2) | B | Rompe wasiai-v2/registries | Campo estrictamente aditivo + spread condicional + no-regresión en `agent-card.test.ts` |
| Drift semántico: nuestro `session`/`upto` ≠ modelo exacto de APP | M | Engañoso para caller externo | v1 estrictamente outbound + `alignment:'conceptual'`; sin interop real declarada |
| Inbound accidental (CD-1) | B | Superficie de deserialización | v1 no crea endpoint; invariante estructural; AR marca BLOQUEANTE cualquier parse de payload ajeno |
| `exactOptionalPropertyTypes` en el nuevo campo opcional (CD-7) | M | `tsc` rojo | Asignación condicional, nunca `?: undefined` |

---

## 8. Dependencias

- WKH-135 (`session`/`upto`, DONE, NNN 137) — provee los shapes de resultado que
  el mapper traduce. Disponible.
- WKH-133 (patrón feature-flag, DONE, NNN 134) — patrón `isXEnabled()` reusado.
- Ninguna dependencia bloqueante pendiente para el v1.

## 9. Missing Inputs

- [ ] #1 Spec/wire-format exacto de APP — **v2, NO bloquea este v1** (outbound-only por diseño).
- [ ] #2 Transport XMTP — **v2/epic aparte, NO bloquea**.
- [ ] #3 Dirección del bridge (inbound vs outbound) — **v2, NO bloquea** (v1 neutral).
- [x] #4 Shape del campo del Agent Card — **RESUELTO** (§4.3-A, DT-4: top-level `paymentIntents`).
- [x] #5 Flag global vs per-agente — **RESUELTO** (§4.3-B, DT-5: flag global + opt-in por-agente estricto).

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| — | — | Ninguno abierto en este SDD. Los `[NEEDS CLARIFICATION]` #1/#2/#3 pertenecen al **v2** (inbound/XMTP/MPP), fuera del scope de esta HU. | No |

> Gate: no hay `[NEEDS CLARIFICATION]` que resolver para el v1.

---

## Decisiones técnicas (DT-N)

- **DT-1** — v1 outbound-declaración + mapeo interno, **nunca inbound** (hereda del work-item DT-1). Evita por diseño la superficie de deserialización de payloads ajenos (ref. WKH-60/WKH-62).
- **DT-2** — Reuso total de WKH-135/x402 como fuente de verdad; el mapper NO reimplementa settlement, solo traduce vocabulario (cero duplicación de lógica de dinero).
- **DT-3** — Feature flag default OFF (patrón WKH-133) — mergeable/testeable en CI sin activar la afirmación pública.
- **DT-4** *(resuelve Missing #4)* — Campo top-level `paymentIntents` en `AgentCard` con `alignment`/`disclaimer` no opcionales; no bajo `capabilities` (preserva su shape estricto).
- **DT-5** *(resuelve Missing #5)* — Gate = flag global `APP_BRIDGE_ENABLED` **Y** opt-in por-agente `metadata.appPaymentIntents === true` (permite que un operador no publique la declaración). El self-card se gatea solo por el flag.
- **DT-6** — Honestidad horneada en el tipo (`alignment:'conceptual'` + `disclaimer` no opcionales) → AC-6/CD-3 imposible de violar por omisión.
- **DT-7** — Solo se declaran `charge`/`session`/`upto` (3 de los 4 intents de APP). `escrow` OUT (CD-8): no cableado al vocabulario, declararlo sería overclaim.

---

## Waves de Implementación

### Wave 0 (Serial Gate) — contratos/tipos
- [ ] **W0.1**: En `src/types/index.ts` agregar `AppIntentName` (`'charge'|'session'|'upto'`), `AppIntentEnvelope`, `AppIntentDescriptor`, inputs allow-list del mapper (`ChargeMapInput`/`SessionMapInput`/`UptoMapInput`), y el campo opcional `paymentIntents?` en `AgentCard`. → Exemplar: `types/index.ts:785-828`
- Verificación: `tsc --noEmit` verde.

### Wave 1 (depende de W0) — mapper puro
- [ ] **W1.1**: `src/adapters/app-intent-mapper.ts` — `mapChargeToApp`/`mapSessionToApp`/`mapUptoToApp` (input allow-listed → `AppIntentEnvelope`) + `getSupportedAppIntents()`. Cero imports de infra (db/redis/viem/fetch/fs/process.env). Asignación condicional para opcionales (CD-7). → Exemplar: `erc8004-reputation.ts`
- Verificación: `tsc --noEmit` + test de pureza/no-leak.

### Wave 2 (depende de W1) — integración Agent Card
- [ ] **W2.1**: `src/services/agent-card.ts` — `isAppBridgeEnabled()` (flag) + gate opt-in `appPaymentIntents === true` + inclusión aditiva de `paymentIntents` en `buildAgentCard` (flag+opt-in) y `buildSelfAgentCard` (solo flag). → Exemplar: `agent-card.ts:18-20,148-156` + `erc8004-reputation-writer.ts:76-78`
- Verificación: `tsc --noEmit` + `agent-card.test.ts`.

### Wave 3 (final) — tests + docs
- [ ] **W3.1**: `app-intent-mapper.test.ts` + extensiones a `agent-card.test.ts` (ver §Test Plan).
- [ ] **W3.2**: Línea de docs de honestidad (AC-6) — SOLO si se documenta públicamente; en v1 con flag OFF nada se publica, el disclaimer vive en el tipo. Nota en el SDD/done-report; sin README nuevo.
- Verificación: suite completa verde + `biome check`.

## Test Plan

| Test | AC/CD que cubre | Wave | Framework |
|------|-----------------|------|-----------|
| `mapChargeToApp`/`mapSessionToApp`/`mapUptoToApp`: input conocido → envelope esperado (vocabulary='app', intent correcto) | AC-2 | W3 | vitest |
| Envelope siempre lleva `alignment:'conceptual'` + `disclaimer` no vacío; nunca contiene "certified"/"100%" | AC-6, CD-3 | W3 | vitest |
| Mapper NO expone campos sensibles: el JSON del envelope no contiene `ownerRef`/`buyerWallet`/`keyId`/`sellerRef`/`payTo`/`capSignature`/`funding_wallet`/`typedData`/`budget` | CD-6 | W3 | vitest |
| Pureza: el mapper no importa db/redis/viem/fetch/fs (assert estructural sobre imports del módulo) + funciones deterministas sin mocks de infra | CD-5, AC-2 | W3 | vitest |
| `buildAgentCard` con flag OFF → SIN campo `paymentIntents` (byte-idéntico) | AC-4, CD-4 | W3 | vitest |
| `buildAgentCard` flag ON + `appPaymentIntents===true` → campo presente con `supported:['charge','session','upto']` | AC-1 | W3 | vitest |
| `buildAgentCard` flag ON + opt-in ausente/no-literal → campo AUSENTE | AC-4, Missing#5 | W3 | vitest |
| No-regresión: campos existentes del card (name/url/capabilities/skills/authentication/identity...) intactos con la feature activa | AC-5, CD-2 | W3 | vitest |
| `getSupportedAppIntents()` no incluye `escrow` | CD-8 | W3 | vitest |
| AC-3/CD-1 (no inbound): invariante estructural — no hay ruta que importe el mapper como parser de input ajeno (documentado; no hay endpoint positivo que testear) | AC-3, CD-1 | W3 | nota + revisión AR |

## Verificación Incremental

| Wave | Verificación |
|------|--------------|
| W0 | `tsc --noEmit` |
| W1 | `tsc --noEmit` + test pureza/no-leak |
| W2 | `tsc --noEmit` + `agent-card.test.ts` |
| W3 | suite completa + `biome check` |

---

## Readiness Check

```
[x] Cada AC tiene al menos 1 archivo asociado (§4.1) y ≥1 test (Test Plan)
[x] Cada archivo en §4.1 tiene Exemplar verificado con Read/Glob
[x] No hay [NEEDS CLARIFICATION] pendientes (los del v2 no son de esta HU)
[x] Constraint Directives incluyen ≥3 PROHIBIDO (CD-1, CD-3, CD-8 + genéricos)
[x] Context Map tiene ≥2 archivos leídos (6 archivos reales)
[x] Scope IN y OUT explícitos y no ambiguos
[x] BD: N/A verificado (cero cambios de BD)
[x] Happy Path completo (§4.4)
[x] Flujo de error definido (§4.5)
[x] Missing Inputs #4/#5 resueltos; #1/#2/#3 marcados como v2 no-bloqueante
[x] Aprendizajes históricos incorporados: CD-6 (WKH-137 leak), CD-7 (exactOptionalPropertyTypes WKH-133/134/136/137)
```

Todos los checks OK → SDD listo para GATE SPEC_APPROVED.

---

*SDD generado por nexus-architect — F2 — FULL. No incluye Story File (F2.5, post SPEC_APPROVED).*
