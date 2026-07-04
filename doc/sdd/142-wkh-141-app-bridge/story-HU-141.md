# Story File — HU WKH-141 v1: APP Bridge (Capability Declaration + Internal Mapping)

> Contrato autocontenido para `nexus-dev`. **NO releas el SDD.** Todo lo que
> necesitás está acá. Si algo no está acá, no lo hagas.
> Fuente: `doc/sdd/142-wkh-141-app-bridge/sdd.md` (ya destilado). SPEC_APPROVED: sí.
> Branch: `feat/142-wkh-141-app-capability-declaration`

---

## 1. Contexto compacto (qué se construye y por qué)

v1 **outbound-only** de un puente APP-compatible (Agent Payments Protocol de OKX):

1. Un campo **aditivo** `paymentIntents` en el Agent Card que *declara* —en el
   vocabulario de intents de APP (`charge`/`session`/`upto`)— qué primitivas de
   pago puede settlear el gateway WasiAI. Detrás de doble gate: flag global
   `APP_BRIDGE_ENABLED` (default OFF) **Y** opt-in por-agente
   `metadata.appPaymentIntents === true`.
2. Un **adaptador interno PURO** `src/adapters/app-intent-mapper.ts` que traduce
   resultados ya-validados de nuestras operaciones (`charge` x402, `session`/`upto`
   WKH-135) a un `AppIntentEnvelope` versionado con vocabulario APP. **CERO I/O,
   cero persistencia, cero endpoint.**

**Invariante de seguridad no negociable:** el v1 NUNCA parsea un wire-format ajeno
(no hay endpoint inbound) y NUNCA arrastra datos financieros del owner al envelope
(allow-list explícita). La honestidad del positioning está **horneada en el tipo**:
`alignment:'conceptual'` + `disclaimer` son campos **NO opcionales** en el card y en
el envelope → es estructuralmente imposible declarar la capacidad sin la aclaración.

---

## 2. Scope IN — archivos exactos a tocar (NADA fuera de esto)

| # | Archivo | Acción |
|---|---------|--------|
| 1 | `src/types/index.ts` | Modificar — tipos W0 + campo `paymentIntents?` en `AgentCard` |
| 2 | `src/adapters/app-intent-mapper.ts` | **Crear** — mapper puro |
| 3 | `src/services/agent-card.ts` | Modificar — flag + gate opt-in + inclusión aditiva |
| 4 | `src/adapters/app-intent-mapper.test.ts` | **Crear** — tests del mapper |
| 5 | `src/services/agent-card.test.ts` | Modificar — tests del campo aditivo |

**Fuera de estos 5 archivos: PROHIBIDO tocar nada.** Sin migraciones, sin cambios
de BD, sin nuevas dependencias, sin tocar el money-path (`payments.ts`, `x402.ts`,
`payment-intent.ts`, settlement).

---

## 3. Anti-Hallucination Checklist (símbolos verificados — usalos tal cual)

Todos verificados con Read/Grep el 2026-07-04. NO inventes variaciones.

| Símbolo | Ubicación real verificada | Uso |
|---------|---------------------------|-----|
| `interface AgentCard` | `src/types/index.ts:785-828` | agregarle `paymentIntents?` |
| Extensiones opcionales `inputSchema?`/`identity?`/`computedReputation?` en `AgentCard` | `src/types/index.ts:815-828` | patrón "consumer que no la entiende la ignora" (DT-6) |
| `metadata?: Record<string, unknown>` en `Agent` | `src/types/index.ts:195` | leer `metadata?.appPaymentIntents` |
| `function isDiscoverable(agent): boolean { return agent.metadata?.discoverable === true; }` | `src/services/agent-card.ts:18-20` | patrón opt-in estricto a copiar |
| Spread condicional aditivo `...(agent.metadata?.a2aCompliant === true && { a2aCompliant: true })` | `src/services/agent-card.ts:135` | patrón de inclusión aditiva |
| Spread condicional `...(identity !== undefined && { identity })` | `src/services/agent-card.ts:148-156` | patrón de omisión de campo top-level |
| `buildAgentCard(agent, registryConfig, baseUrl, identity?, computedReputation?)` | `src/services/agent-card.ts:88-158` (dentro de `agentCardService`) | agregar inclusión en el `return {...}` |
| `buildSelfAgentCard(baseUrl)` | `src/services/agent-card.ts:163-200` (dentro de `agentCardService`) | agregar inclusión gateada solo por flag |
| `export function isWritebackEnabled() { return process.env.ERC8004_REPUTATION_WRITEBACK_ENABLED === 'true'; }` | `src/adapters/erc8004-reputation-writer.ts:76-78` | patrón EXACTO del flag (`=== 'true'`) |
| Result-types tipados (`Erc8004WriteReason`/`Erc8004WriteResult` como union) | `src/adapters/erc8004-reputation-writer.ts:58-71` | forma de tipos de resultado del adaptador |
| Tests con `vitest` (`import { describe, expect, it } from 'vitest'`) | `src/adapters/erc8004-reputation.test.ts:10` | framework y estilo |

**Notas de anti-alucinación:**
- El módulo `src/adapters/app-intent-mapper.ts` **NO existe** hoy (confirmado). Lo creás vos.
- Los métodos del card viven dentro del objeto `export const agentCardService = { ... }` — `buildAgentCard`/`buildSelfAgentCard` son propiedades del objeto, NO funciones sueltas.
- `SettleOutcome` real (`src/types/index.ts:1100-1124`) tiene `{ status, txHash, finalAmountUsd, consumedUsd?, residualUsd?, cappedAt?, error?, failureKind? }`. **El mapper NO recibe este tipo** (ver CD-6). Solo lo miro para saber qué campos NO deben filtrarse.
- `[VERIFY-AT-IMPL]`: la firma exacta del descriptor (`getSupportedAppIntents()`) y el `disclaimer` string son decisión tuya dentro de las restricciones de abajo. No hay símbolo externo que verificar — es todo nuevo y auto-contenido.

---

## 4. Constraint Directives heredados (INVIOLABLES)

- **CD-1 (PROHIBIDO):** NO crear ningún endpoint/ruta HTTP que acepte o parsee un
  payload con wire-format de APP como input de un tercero. NO importar el mapper
  desde ninguna route handler como parser de input ajeno. El v1 es estrictamente
  outbound (declaración) + interno (mapeo). Violarlo = BLOQUEANTE en AR.
- **CD-2 (OBLIGATORIO):** el campo del Agent Card es **100% aditivo** — no renombra,
  no remueve, no cambia el tipo de ningún campo existente (consumido por
  wasiai-v2/registries). Verificar con `agent-card.test.ts` (no-regresión).
- **CD-3 (PROHIBIDO):** afirmar "certificado APP-compatible" / "100% compatible" en
  cualquier campo/string/comentario/doc sin la aclaración. Horneado: `alignment:'conceptual'`
  + `disclaimer` NO opcionales. El `disclaimer` NUNCA debe contener "certified"/"100%".
- **CD-4 (OBLIGATORIO):** flag `APP_BRIDGE_ENABLED` default OFF; con flag OFF el
  comportamiento es **byte-idéntico** al estado pre-HU (test explícito). Helper
  `isAppBridgeEnabled()` con `=== 'true'` estricto (copiá `isWritebackEnabled`).
- **CD-5 (OBLIGATORIO):** `app-intent-mapper.ts` es **función pura**: CERO imports de
  `db`/`redis`/`viem`/`fetch`/`fs`/`process.env`. Testeable sin mocks de infra.
  **El flag NO vive en el mapper** — vive en `agent-card.ts`.
- **CD-6 (PROHIBIDO — anti-leak, hereda WKH-137 BLQ-1):** el envelope y los inputs
  del mapper son **allow-list explícita**. PROHIBIDO `...spread` de `SettleOutcome`
  / `X402Response` / row del caller hacia el envelope. NUNCA incluir ni copiar:
  `ownerRef`, `buyerWallet`, `keyId`, `sellerRef`, `payTo`, `capSignature`,
  `funding_wallet`, `typedData`, `budget`, `error` interno. Shape interno ≠ shape de canal externo.
- **CD-7 (OBLIGATORIO — exactOptionalPropertyTypes:true):** construí campos
  opcionales del envelope/card con **asignación condicional**
  (`if (v !== undefined) obj.x = v;`), **NUNCA** `x: cond ? v : undefined` ni `?:` con `undefined`.
- **CD-8 (PROHIBIDO — overclaim):** NO declarar el intent `escrow` (4º de APP). Solo
  `charge`/`session`/`upto`. `getSupportedAppIntents()` NUNCA incluye `escrow`.

---

## 5. Waves — orden obligatorio (serial hasta W2)

### Wave 0 — Tipos (serial gate). Archivo: `src/types/index.ts`

Agregar (podés ubicarlos cerca de `AgentCard` o en una sección nueva
`APP BRIDGE TYPES (WKH-141)`):

**W0.1 — Tipos del vocabulario y del envelope:**
- `AppIntentName` = union literal `'charge' | 'session' | 'upto'`. (SOLO estos 3 — CD-8.)
- `AppIntentEnvelope` con esta forma exacta (respetá qué es opcional y qué NO):
  ```
  vocabulary: 'app';               // literal, NO opcional
  envelopeVersion: string;         // NO opcional, p.ej. 'wasiai-app-map/v1'
  intent: AppIntentName;           // NO opcional
  alignment: 'conceptual';         // literal, NO opcional (AC-6/CD-3)
  status?: 'settled' | 'failed' | 'in_progress' | 'challenge';  // opcional
  amountUsd?: number;              // opcional
  chainId?: number;                // opcional
  txHash?: string | null;          // opcional
  expiresAt?: string;              // opcional
  disclaimer: string;              // NO opcional (AC-6/CD-3)
  ```
  Los opcionales, con `exactOptionalPropertyTypes`, se declaran como
  `status?: '...' | undefined` etc. (mismo estilo que `SettleOutcome` en el mismo
  archivo, L1100-1124) — pero se **asignan** condicionalmente (CD-7).
- `AppIntentDescriptor` — descriptor estático para poblar el card, p.ej.:
  ```
  intent: AppIntentName;
  alignment: 'conceptual';
  ```
- Inputs allow-list del mapper (interfaces **estrechas**, SOLO campos no sensibles):
  - `ChargeMapInput` — p.ej. `{ status?; amountUsd?; chainId?; txHash?; }`
  - `SessionMapInput` — p.ej. `{ status?; amountUsd?; chainId?; txHash?; expiresAt?; }`
  - `UptoMapInput` — p.ej. `{ status?; amountUsd?; chainId?; txHash?; expiresAt?; }`
  - **NINGUNO** de estos inputs debe tener `ownerRef`/`buyerWallet`/`keyId`/`sellerRef`/
    `payTo`/`capSignature`/`funding_wallet`/`typedData`/`budget`/`error` (CD-6).

**W0.2 — Campo aditivo en `AgentCard`** (agregar al final de la interface, junto a
`identity?`/`computedReputation?`, siguiendo el patrón DT-6 con comentario `WKH-141`):
```
/** WKH-141: APP-compatible payment intents declaration. Non-breaking optional
 *  extension — consumers que no la entienden la ignoran. alignment/disclaimer
 *  NO opcionales: honestidad horneada (AC-6/CD-3). */
paymentIntents?: {
  vocabulary: 'app';
  supported: AppIntentName[];
  alignment: 'conceptual';
  disclaimer: string;
};
```

**Verificación W0:** `tsc --noEmit` verde (o `npx tsc --noEmit`).

---

### Wave 1 — Mapper puro. Archivo: `src/adapters/app-intent-mapper.ts` (NUEVO)

**W1.1** — Crear el módulo. Exemplar de estilo: `src/adapters/erc8004-reputation-writer.ts`
(result-types tipados, header docblock explicando la responsabilidad y las CDs).

Exports:
- `mapChargeToApp(input: ChargeMapInput): AppIntentEnvelope`
- `mapSessionToApp(input: SessionMapInput): AppIntentEnvelope`
- `mapUptoToApp(input: UptoMapInput): AppIntentEnvelope`
- `getSupportedAppIntents(): AppIntentDescriptor[]` — lista estática de los 3
  intents (`charge`/`session`/`upto`), cada uno con `alignment:'conceptual'`. **Sin `escrow` (CD-8).**

Reglas de implementación:
- **CERO imports de infra** (db/redis/viem/fetch/fs) y **CERO `process.env`** (CD-5).
  Solo `import type { ... } from '../types/index.js'`.
- Cada `map*ToApp`:
  1. Arranca un objeto base con los campos NO opcionales SIEMPRE presentes:
     `vocabulary:'app'`, `envelopeVersion` (constante del módulo, p.ej.
     `const ENVELOPE_VERSION = 'wasiai-app-map/v1'`), `intent` (el que corresponde),
     `alignment:'conceptual'`, `disclaimer` (constante del módulo, string honesto —
     ver abajo).
  2. Asigna los opcionales SOLO si vienen definidos, con **asignación condicional**
     (CD-7): `if (input.amountUsd !== undefined) env.amountUsd = input.amountUsd;` etc.
     **NUNCA** `amountUsd: input.amountUsd ?? undefined` ni spread `...input`.
  3. **PROHIBIDO** `...spread` del input completo hacia el envelope (CD-6). Copiá campo por campo, allow-listed.
- `disclaimer` (constante del módulo): string honesto de alineación conceptual.
  **PROHIBIDO** que contenga "certified"/"certificado"/"100%" (CD-3). Ejemplo de tono:
  `'Conceptual vocabulary alignment with the OKX Agent Payments Protocol (APP); not an end-to-end certified interop.'`
- El mapper **no lanza** (los inputs ya vienen validados aguas arriba).

**Verificación W1:** `tsc --noEmit` + los tests de pureza/no-leak (W3) verdes.

---

### Wave 2 — Integración Agent Card. Archivo: `src/services/agent-card.ts`

**W2.1a — Helper de flag** (top-level, junto a `isDiscoverable` L18-20):
```
/** WKH-141: ON solo con el literal exacto 'true' (patrón WKH-133). Default OFF. */
function isAppBridgeEnabled(): boolean {
  return process.env.APP_BRIDGE_ENABLED === 'true';
}
```
(Copiá el patrón `=== 'true'` de `erc8004-reputation-writer.ts:76-78`.)

**W2.1b — Helper opt-in por-agente** (junto a `isDiscoverable`):
```
/** WKH-141: opt-in estricto por-agente. Solo `metadata.appPaymentIntents === true`. */
function appPaymentIntentsOptIn(agent: Agent): boolean {
  return agent.metadata?.appPaymentIntents === true;
}
```

**W2.1c — Inclusión aditiva en `buildAgentCard`** (dentro del `return {...}`, L124-157,
después de `computedReputation`): agregá un spread condicional que solo incluya el
campo cuando **flag ON Y opt-in ON**:
```
...(isAppBridgeEnabled() &&
    appPaymentIntentsOptIn(agent) && {
      paymentIntents: {
        vocabulary: 'app' as const,
        supported: getSupportedAppIntents().map((d) => d.intent),
        alignment: 'conceptual' as const,
        disclaimer: '<mismo disclaimer honesto>',
      },
    }),
```
- Importá `getSupportedAppIntents` desde `../adapters/app-intent-mapper.js`.
- `supported` DEBE ser `['charge','session','upto']` (derivado de `getSupportedAppIntents()`, sin `escrow`).
- Reutilizá el MISMO `disclaimer` que el mapper (podés exportarlo como constante
  desde el mapper — p.ej. `export const APP_ALIGNMENT_DISCLAIMER` — y consumirlo acá
  para no duplicar el string; decisión tuya, pero UN solo source de verdad).

**W2.1d — Inclusión en `buildSelfAgentCard`** (L163-200, dentro del `return {...}`,
después de `invocationNote`): gateado **solo por el flag** (el self-card no tiene
metadata por-agente):
```
...(isAppBridgeEnabled() && {
  paymentIntents: {
    vocabulary: 'app' as const,
    supported: getSupportedAppIntents().map((d) => d.intent),
    alignment: 'conceptual' as const,
    disclaimer: '<mismo disclaimer>',
  },
}),
```

**Nota CD-7:** el spread condicional `...(cond && { x })` es el patrón ya usado en
este archivo (L135, L148-156) y es seguro con `exactOptionalPropertyTypes` porque el
campo se **omite** cuando la condición es falsa (no se asigna `undefined`).

**Verificación W2:** `tsc --noEmit` + `agent-card.test.ts` verde.

---

### Wave 3 — Tests. Archivos: `app-intent-mapper.test.ts` (nuevo) + `agent-card.test.ts` (extender)

Framework: **vitest** (`import { describe, expect, it } from 'vitest'`).

**W3.1 — `src/adapters/app-intent-mapper.test.ts` (NUEVO):**

| Test | Cubre |
|------|-------|
| `mapChargeToApp`/`mapSessionToApp`/`mapUptoToApp`: input conocido → envelope con `vocabulary:'app'` + `intent` correcto + `envelopeVersion` presente | AC-2 |
| Todo envelope lleva `alignment:'conceptual'` + `disclaimer` no vacío; el `disclaimer` NO contiene (case-insensitive) `'certified'`/`'certificado'`/`'100%'` | AC-6, CD-3 |
| **No-leak:** `JSON.stringify(envelope)` NO contiene `ownerRef`/`buyerWallet`/`keyId`/`sellerRef`/`payTo`/`capSignature`/`funding_wallet`/`typedData`/`budget`. Pasá un input que (hipotéticamente) tuviera esos campos extra vía cast y verificá que el envelope NO los propaga (allow-list) | CD-6 |
| **Pureza estructural:** leé el source del módulo (`fs.readFileSync` en el test, o assert sobre el string del import) y verificá que NO importa `viem`/`fetch`/`db`/`redis`/`fs` ni usa `process.env`. Alternativa: assert que las funciones son deterministas (mismo input → mismo output) sin ningún mock de infra | CD-5, AC-2 |
| Input con opcionales ausentes → el envelope OMITE esos campos (no `=== undefined` como propiedad enumerable, respeta CD-7) mientras mantiene los 5 no-opcionales | CD-7 |
| `getSupportedAppIntents()` devuelve exactamente `charge`/`session`/`upto` y **NO** incluye `escrow` | CD-8 |

**W3.2 — Extender `src/services/agent-card.test.ts`:**

Para gatear el flag por test, seteá/limpiá `process.env.APP_BRIDGE_ENABLED` en
`beforeEach`/`afterEach` (mismo patrón env set/clear que `erc8004-reputation.test.ts`).

| Test | Cubre |
|------|-------|
| `buildAgentCard` con `APP_BRIDGE_ENABLED` ausente/OFF → resultado **SIN** la key `paymentIntents` (byte-idéntico) | AC-4, CD-4 |
| `buildAgentCard` con flag ON + `metadata.appPaymentIntents === true` → `paymentIntents` presente con `supported: ['charge','session','upto']`, `vocabulary:'app'`, `alignment:'conceptual'`, `disclaimer` no vacío | AC-1 |
| `buildAgentCard` con flag ON + opt-in ausente / `false` / valor truthy-no-literal (p.ej. `'true'` string o `1`) → campo **AUSENTE** | AC-4, Missing#5 |
| No-regresión: con la feature activa, los campos existentes (`name`, `url`, `capabilities`, `skills`, `authentication`, `inputModes`, `outputModes`, `invocationNote`, `identity` si aplica) permanecen intactos e iguales al baseline | AC-5, CD-2 |
| `buildSelfAgentCard` con flag OFF → SIN `paymentIntents`; con flag ON → CON `paymentIntents` (sin requerir metadata) | AC-4, AC-1 |

**AC-3/CD-1 (no inbound):** invariante estructural — no hay endpoint que testear
positivamente. Documentá en un comentario del test file que el mapper NO se importa
desde ninguna route como parser de input ajeno; el AR lo verifica.

**Verificación W3:** suite completa verde (`npm test` / `vitest run`) + `biome check`
(o `npx biome check`).

---

## 6. Done Definition (tu trabajo termina cuando)

- [ ] Los 5 archivos del Scope IN modificados/creados, nada fuera de eso.
- [ ] `tsc --noEmit` verde (sin `any`, respetando `exactOptionalPropertyTypes`).
- [ ] `AppIntentEnvelope` y el campo `paymentIntents` tienen `alignment:'conceptual'` + `disclaimer` **no opcionales**.
- [ ] Mapper 100% puro: sin imports de infra, sin `process.env`, sin I/O (CD-5).
- [ ] Envelope construido por allow-list; ningún campo financiero del owner presente (CD-6) — test de ausencia verde.
- [ ] Doble gate en `buildAgentCard` (flag + opt-in), gate simple en `buildSelfAgentCard` (flag). Flag OFF = byte-idéntico (CD-4).
- [ ] `getSupportedAppIntents()` sin `escrow` (CD-8); ningún string con "certified"/"100%" (CD-3).
- [ ] ≥1 test por AC (AC-1..AC-6) + tests de pureza/no-leak/no-regresión, todos verdes.
- [ ] `biome check` limpio.
- [ ] Sin endpoint nuevo, sin ruta que parsee payload APP (CD-1).

---

*Story File generado por nexus-architect — F2.5. El Dev implementa desde acá sin releer el SDD.*
