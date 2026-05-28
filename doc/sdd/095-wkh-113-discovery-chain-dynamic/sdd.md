# SDD #095: [WKH-113] [BASE-08] discovery chain validation dinámica + compose chain-flow

> SPEC_APPROVED: no
> Fecha: 2026-05-27
> Tipo: feature (evolutivo sobre superficie crítica de pagos + discovery)
> SDD_MODE: full (QUALITY)
> Branch: feat/095-wkh-113-discovery-chain-dynamic
> Artefactos: doc/sdd/095-wkh-113-discovery-chain-dynamic/
> Work item: doc/sdd/095-wkh-113-discovery-chain-dynamic/work-item.md
> Epic: WKH-103 BASE port. Hermana de WKH-111 (BASE-06, inbound, DONE) y WKH-112
> (BASE-07, outbound downstream, DONE). Esta HU cierra el camino completo
> discovery → compose → downstream para que el `ChainKey` real del sub-agente
> sobreviva intacto hasta el borde del settle de WKH-112.

---

## 1. Resumen

WKH-111 hizo chain-aware el **cobro inbound** (3 chains, probado onchain). WKH-112 hizo
chain-aware el **settle outbound** dentro de `downstream-payment.ts`. Pero el outbound
real a sub-agentes en Base/Kite/Fuji **sigue roto** porque la `chain` que llega a ese
módulo nunca trae una chain ≠ avalanche/kite: dos gates upstream la borran o sobrescriben.

**GATE 1 — allowlist hardcodeada** (`discovery.ts:56-63`): `readPayment` rechaza
(`return undefined`) toda chain fuera del `Set` literal `ALLOWED_CHAIN_VALUES`
(`{avalanche, avalanche-testnet, avalanche-mainnet, kite-ozone-testnet, kite-mainnet}`).
`base-sepolia`/`base-mainnet`/`avalanche-fuji` quedan fuera → `agent.payment = undefined`
→ el downstream skip con `NO_PAYMENT_FIELD` (cero tx outbound para Base).

**GATE 2 — chain sobrescrita por getAgent** (síntoma a2a): `compose.resolveAgent`
(`:328-337`) resuelve PRIMERO vía `discoveryService.getAgent(slug)`, que pega al endpoint
v2 `GET /api/v1/agents/{slug}` — el cual **hardcodea `chain: avalanche`** e ignora la
columna real (verificado en F0/work-item H14). El endpoint v2 `GET /api/v1/capabilities`
(usado por `discover()`) **sí** emite la chain real per-row (H15). Ambos paths usan el
MISMO `mapAgent`/`readPayment` en a2a; la diferencia es solo la fuente de datos.

Esta HU hace **wiring** (no rewrite), a2a-only (sin tocar wasiai-v2, CD-6):

1. **Discovery (GATE 1)** — `readPayment` reemplaza la allowlist hardcodeada por
   validación derivada del chain-resolver puro (`normalizeChainSlug`), preservando la
   defensa SEC-AR BLQ-MED-1 (slug desconocido → `undefined`) y **preservando el shape
   de salida actual** (`avalanche-testnet`/`avalanche-mainnet` → `'avalanche'`; resto
   pass-through) para CERO regresión observable (AC-1/AC-5/AC-7/CD-1/CD-2).

2. **Compose (GATE 2)** — `resolveAgent` hidrata `payment.chain` (y el resto del
   `payment` cuando el agente vino sin él) desde el path que tiene la chain real
   (`discover()`/capabilities), sin cambiar la firma pública ni tocar `invokeAgent` ni
   `downstream-payment.ts`. Para agentes Avalanche/Kite ambos endpoints concuerdan → el
   merge es **no-op observable** (CD-2/AC-2).

Resultado esperado: para un agente `chain=base-sepolia`, `agent.payment.chain` llega a
`signAndSettleDownstream` como `base-sepolia` → `normalizeChainSlug` → adapter Base →
settle real (`eip155:84532`). Avalanche/Kite quedan funcionalmente idénticos y la suite
existente sigue verde.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 095 (WKH-113) |
| **Tipo** | feature / evolutivo (path de dinero real outbound + discovery) |
| **SDD_MODE** | full (QUALITY) |
| **Objetivo** | Que la chain real del sub-agente fluya sin hardcode desde discovery hasta el borde del settle, habilitando outbound en las 3 testnets, con cero regresión Avalanche/Kite. |
| **Reglas de negocio** | Golden Path: sin hardcodes de chain, solo viem (vía adapter), TS strict, fail-loud en chain desconocida, coherencia de chain end-to-end, no modificar wasiai-v2. |
| **Scope IN** | `src/services/discovery.ts` (`readPayment`), `src/services/compose.ts` (`resolveAgent`), tests asociados (`discovery.test.ts`, nuevo `compose.chain-flow.test.ts`). |
| **Scope OUT** | wasiai-v2 (CD-6, sub-tareas separadas: getAgent chain-real + payTo per-agente), `downstream-payment.ts` (WKH-112 DONE — solo recibe la chain correcta), inbound (WKH-111 DONE), mainnet, budget/a2a-key, schema de v2. |
| **Missing Inputs** | DT-1/DT-4/DT-5 + AC-7 cerrados en este SDD (§5). DT-3 (payTo) cerrado: PRESERVAR comportamiento actual (§5 DT-3), documentado como TD/sub-tarea wasiai-v2. |

### Acceptance Criteria (EARS) — heredados del work-item

- **AC-1** (Ubiquitous — validación dinámica, sin allowlist hardcodeada): the system
  SHALL validar la chain de `agent.payment` derivando el conjunto aceptado dinámicamente
  del chain-resolver (`normalizeChainSlug`) — PROHIBIDO el `Set` literal
  `ALLOWED_CHAIN_VALUES` ni ningún listado hardcodeado de slugs como fuente de verdad.
- **AC-2** (Ubiquitous — CERO regresión Avalanche/Kite): the system SHALL producir un
  `agent.payment` con la MISMA `chain` normalizada que hoy (avalanche/-testnet/-mainnet →
  `avalanche`; kite pass-through) y el settle outbound SHALL ser funcionalmente idéntico.
  Suite existente verde. Cualquier diff observable es **BLOQUEANTE**.
- **AC-3** (Event-driven — la chain real de Base llega a compose): WHEN `/compose`
  (o `/orchestrate`) resuelve un sub-agente cuya fila declara `chain = base-sepolia`,
  THEN el `agent.payment.chain` que compose pasa a `signAndSettleDownstream` SHALL
  resolver a `base-sepolia` (no `avalanche`), derivado del path que expone la chain real
  (capabilities/discover). PROHIBIDO que getAgent (hardcodea avalanche) determine la chain.
- **AC-4** (Event-driven — settle outbound real en Base): WHEN compose paga a un
  sub-agente `base-sepolia` con flag downstream activo y operator funded, THEN the system
  SHALL firmar+settlear vía el adapter de Base (`eip155:84532`), retornando un
  `DownstreamResult` con `txHash` verificable en Basescan. (Lo ejerce el adapter ya
  chain-aware de WKH-112 — esta HU solo garantiza que reciba `base-sepolia`.)
- **AC-5** (Unwanted — chain desconocida → rechazo): IF `agent.payment.chain` NO resuelve
  a un `ChainKey` reconocido, THEN `readPayment` SHALL devolver `undefined` (preservando
  SEC-AR BLQ-MED-1). PROHIBIDO aceptar/normalizar a default.
- **AC-6** (State-driven — coherencia end-to-end): WHILE se procesa el pago a un agente
  cuya chain real es `K`, the system SHALL usar `K` coherente desde `readPayment` →
  `agent.payment.chain` → `normalizeChainSlug` (downstream) → `getPaymentAdapter(K)`.
  PROHIBIDO que un endpoint intermedio reemplace `K`.
- **AC-7** (Optional/Unwanted — efecto colateral seguro sobre `avalanche-fuji`): WHERE
  existan agentes `chain = avalanche-fuji` (hoy con `payment = null`), WHEN la validación
  dinámica los acepte, THEN `agent.payment` SHALL resolver a `avalanche-fuji` y el settle
  SHALL rutear al adapter Fuji (mismo USDC/network que `avalanche`, `eip155:43113`) — sin
  cross-chain. **CERRADO §5 AC-7: deseado y seguro** (misma red de pago ya soportada).

## 3. Context Map (Codebase Grounding)

### Archivos leídos (verificados con Read, líneas reales)

| Archivo | Por qué | Patrón / hallazgo extraído |
|---------|---------|----------------------------|
| `src/services/discovery.ts` | Núcleo (GATE 1) | `ALLOWED_CHAIN_VALUES` `Set` literal (`:56-63`). `readPayment` (`:65-111`): valida method+chain+contract presentes; rechaza chain fuera del set (`:92-95`); normaliza `avalanche-testnet`/`-mainnet` → `'avalanche'`, resto pass-through (`:97-103`); retorna `{method, chain, contract, asset}` (`:105-110`). `mapAgent` llama `payment: readPayment(raw)` (`:329`). `discover()`/`queryRegistry` (`:117-293`) y `getAgent` (`:336-375`) usan el **MISMO** `mapAgent`/`readPayment` (`:292`, `:369`) — la diferencia es solo el endpoint (`discoveryEndpoint` vs `agentEndpoint`). |
| `src/services/compose.ts` | Núcleo (GATE 2) | `resolveAgent` (`:328-337`): `getAgent(slug, registry)` → si null `getAgent(slug)` → si null `discover({limit:50}).find(slug)`. `invokeAgent` (`:338-462`): payTo inbound `metadata.payTo ?? metadata.payment.contract` (`:370-380`); selector Base usa `agent.payment?.chain` + `normalizeChainSlug` (`:416-420`); `signAndSettleDownstream(agent, logger)` (`:459`). `resolveAgent` se llama en `:70` (step principal) y `:207` (lookahead). |
| `src/services/discovery.test.ts` | Tests existentes a no-regresar + exemplar de fixture | `mapAgent`/`discover` tests afirman `payment.chain === 'avalanche'` para avalanche/-testnet/-mainnet (`:179`, `:221`, `:273`), `=== 'kite-ozone-testnet'` para kite (`:301`), `polygon` → `undefined` (`:244`). Fixture: `setupRegistryResponse(rawAgents)` + `mockFetch` + `makeRawAgent` (`:46-67`). Mockea `registry.js` + circuit-breaker + `fetch` global (`:8-23`). |
| `src/services/compose.test.ts` | Mock del consumidor + exemplar | `vi.mock('./discovery.js', () => ({ discoveryService: { getAgent: vi.fn(), discover: vi.fn() } }))` (`:29-31`); `vi.mock('../lib/downstream-payment.js', () => ({ signAndSettleDownstream: vi.fn().mockResolvedValue(null) }))` (`:46-48`, signature-agnóstico); `mockAgentsBySlug` route helper (`:1077-1081`); tests selector Base usan `agent.payment.chain` directo (`:1457-1594`) — **estos mockean payment directo (el gap WKH-112); los nuevos NO deben**. |
| `src/adapters/chain-resolver.ts` | Resolver puro (DT-4) | `normalizeChainSlug(raw)` (`:61-66`) → `ChainKey \| undefined`, total/never-throw, lowercase+trim. `SLUG_ALIASES` (`:20-53`): `avalanche`/`avalanche-testnet`/`fuji`/`43113` → `'avalanche-fuji'`; `avalanche-mainnet`/`43114` → `'avalanche-mainnet'`; `kite-ozone-testnet`/`kite-testnet`/`2368` → `'kite-ozone-testnet'`; `base-sepolia`/`base-testnet`/`84532` → `'base-sepolia'`; `base`/`base-mainnet`/`8453` → `'base-mainnet'`. Slug desconocido (`polygon`/`solana`) → `undefined`. **NO importa el registry — desacoplado.** |
| `src/adapters/registry.ts` | Helpers (DT-4 alternativa) | `getInitializedChainKeys()` (`:226-228`) → chains realmente inicializadas. `getAdaptersBundle(chainKey?)` (`:213-220`) no-throw. `SUPPORTED_CHAINS` (`:25-32`) incluye las 6 keys (base incluido). Despacha `createBaseAdapters` (`:76-83`). |
| `src/lib/downstream-payment.ts` | Consumidor de la chain (NO se toca) | `signAndSettleDownstream` resuelve `chainKey = normalizeChainSlug(agent.payment.chain)` (`:151`) → `getAdaptersBundle` (`:152`) → skip `CHAIN_NOT_SUPPORTED` si undefined (`:153-164`). **payTo = `agent.payment.contract`**: `validatePayTo(agent.payment.contract)` (`:167`), luego `adapter.sign({ to: payToCheck.addr, ... })` (`:279-280`). Decimales del adapter (`:200`). NEVER-throws. **CRÍTICO: `normalizeChainSlug('avalanche')` Y `normalizeChainSlug('avalanche-fuji')` → ambos `'avalanche-fuji'` → mismo adapter.** |
| `src/types/index.ts` | Tipo del contrato | `AgentPaymentSpec { method: string; chain: string; contract: \`0x${string}\`; asset?: string }` (`:89-94`), pass-through raw, doc "no se normaliza chain/method (preservar shape)". `Agent.payment?: AgentPaymentSpec`, `Agent.metadata: raw`. |

### Exemplars (verificados — existen en disco)

| Para crear/modificar | Seguir patrón de | Razón |
|----------------------|------------------|-------|
| Validación dinámica en `readPayment` (discovery.ts) | `normalizeChainSlug` (`chain-resolver.ts:61-66`) — ya usado por el inbound (WKH-111) y el downstream (WKH-112) | Resolver puro, total, never-throw, slug desconocido → `undefined`. Fuente única de verdad slug→ChainKey. Reutilizar, no duplicar (CD-1). |
| Merge selectivo de `payment.chain` en `resolveAgent` (compose.ts) | El propio `resolveAgent` (`:328-337`) ya tiene el fallback `discover()` | Reusar `discoveryService.discover` como fuente de la chain real; merge no-op para agentes ya correctos. |
| Test `discovery.test.ts` (extender) | `discovery.test.ts:46-67`, `:157-304` | `setupRegistryResponse` + `makeRawAgent` + asserts `payment.chain`. Patrón ya verde. |
| Test nuevo `compose.chain-flow.test.ts` | `discovery.test.ts` fixture (registry HTTP mockeado) + `compose.test.ts:1077-1081` (resolveAgent) | NO mockear `agent.payment` directo: ejercer discovery→compose con fixture de registry `chain=base-sepolia` y capturar el `agent` pasado a `signAndSettleDownstream` (mock). |

### Estado de BD relevante

N/A — esta HU no toca BD. `readPayment`/`resolveAgent` consumen respuestas HTTP del
registry (vía `fetch`), no Supabase. El Ownership Guard (WKH-53) no aplica (no hay query
a `a2a_agent_keys`).

### Componentes reutilizables encontrados

- `normalizeChainSlug` (`chain-resolver.ts`) — puro, ya usado inbound+outbound. **Reutilizar.**
- `discoveryService.discover` / `mapAgent` / `readPayment` (`discovery.ts`) — ya existen.
- `getInitializedChainKeys` / `getAdaptersBundle` (`registry.ts`) — disponibles si se
  eligiera el guard de init en discovery (se descarta — ver DT-4).

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Qué cambia | Exemplar |
|---------|--------|-----------|----------|
| `src/services/discovery.ts` | Modificar | (a) Borrar `ALLOWED_CHAIN_VALUES` (`:56-63`). (b) `readPayment`: reemplazar el check `if (!ALLOWED_CHAIN_VALUES.has(chainRaw))` (`:92-95`) por `if (normalizeChainSlug(chainRaw) === undefined) return undefined;` (DT-4/DT-5/AC-1/AC-5). (c) **Conservar** la normalización de salida (`:97-103`): `avalanche-testnet`/`avalanche-mainnet` → `'avalanche'`, resto pass-through (CD-2/AC-2). (d) Importar `normalizeChainSlug` de `../adapters/chain-resolver.js`. (e) Actualizar el JSDoc del bloque SEC-AR (`:30-54`) para reflejar la validación dinámica. | `normalizeChainSlug` |
| `src/services/compose.ts` | Modificar | `resolveAgent` (`:328-337`): tras resolver el agente vía `getAgent`, **hidratar `payment.chain` (y el `payment` completo si falta) desde el path con la chain real** (`discover()`/capabilities). Ver §4.3 para el algoritmo exacto (DT-1). NO cambiar la firma. NO tocar `invokeAgent` ni el downstream. | `resolveAgent:328-337` |
| `src/services/discovery.test.ts` | Extender | Tests de `readPayment`/`mapAgent`/`discover`: acepta `base-sepolia`/`base-mainnet`/`avalanche-fuji`; preserva `avalanche` normalizado y kite pass-through; rechaza `solana`/`polygon`. NO regresar los asserts existentes (`avalanche`, kite). | `discovery.test.ts:157-304` |
| `src/services/compose.chain-flow.test.ts` | Crear | Tests de integración discovery→compose SIN mockear `agent.payment`: fixture de registry con `chain=base-sepolia` (capabilities) + getAgent que devuelve avalanche → afirma que `resolveAgent` produce `payment.chain === 'base-sepolia'` y que el `agent` pasado a `signAndSettleDownstream` lo conserva. Test de no-regresión avalanche/kite (merge no-op). | `discovery.test.ts` fixture + `compose.test.ts:29-48` |

### 4.2 Modelo de datos

N/A — sin cambios de BD.

### 4.3 Diseño de la resolución de chain en compose (DT-1 — CERRADO)

#### Problema

`resolveAgent` (`:328-337`) prefiere `getAgent` (endpoint v2 `agents/{slug}`, que
hardcodea `chain: avalanche`). Aunque GATE 1 ya no borre Base, el `agent.payment.chain`
resuelto por `getAgent` sería `avalanche` para un agente que realmente cobra en
`base-sepolia` → el settle iría (mal) a Avalanche (cross-chain — viola CD-5/AC-3).

#### Opciones evaluadas

- **(a) Invertir prioridad: `discover()` primero.** Rechazada: cambia el comportamiento
  de resolución de TODOS los agentes (Avalanche/Kite incluidos), pierde la metadata
  completa que `getAgent` puede traer y que la lista `discover()` (límite 50) podría no
  incluir → riesgo de regresión amplio (CD-2) y de no encontrar agentes fuera del top-50.
- **(b) ELEGIDA — merge selectivo: `getAgent` para la metadata completa, hidratar
  `payment` desde el path con la chain real (`discover()`/capabilities).** El agente
  resuelto por `getAgent` conserva su shape; solo se corrige el `payment` (la chain real)
  consultando el path que la tiene. Para Avalanche/Kite ambos endpoints concuerdan → el
  merge es no-op observable (CD-2/AC-2).
- **(c) getAgent chain-aware "por otro medio".** Rechazada: requeriría inferir la chain
  sin la fuente real (heurística frágil) o tocar v2 (viola CD-6).

#### Algoritmo (opción b)

`resolveAgent(step)`:

1. Resolver `agent` como hoy: `getAgent(slug, registry)` → `getAgent(slug)` → fallback
   `discover().find(slug)`. **Sin cambios en esta cadena.**
2. Si `agent === null` → `return null` (sin cambios).
3. **Hidratación de chain real (NUEVO)**: obtener el "agente con chain real" desde el
   path capabilities/discover y, si difiere, corregir `agent.payment`:
   - `const real = (await discoveryService.discover({ limit: 50 })).agents.find(a => a.slug === agent.slug);`
   - Si `real?.payment?.chain` existe **y** `real.payment.chain !== agent.payment?.chain`,
     reemplazar `agent.payment = real.payment` (el `payment` completo del path con la
     chain real — incluye `contract`/`asset`/`method` coherentes con esa chain).
   - Si `agent.payment` ya está ausente y `real.payment` existe → adoptar `real.payment`
     (cubre el caso GATE 1: getAgent v2 emite avalanche-hardcoded pero capabilities trae
     base-sepolia con su payment real).
   - Si `real` no se encuentra (agente fuera del top-50 de discover, o discover vacío) →
     **conservar el `agent.payment` de getAgent** (fail-soft: no se introduce cross-chain
     porque no se cambia nada; el comportamiento queda igual al actual). NO se asume Base.
4. `return agent`.

**Justificación de "el path con la chain real":** `discover()` → `queryRegistry` pega al
`discoveryEndpoint` (= v2 `capabilities`), que emite `payment.chain = a.chain ?? CHAIN_NAME`
(chain real per-row, H15). `getAgent` pega a `agentEndpoint` (= v2 `agents/{slug}`), que
hardcodea avalanche (H14). El merge corrige solo cuando difieren → para Avalanche/Kite
(donde la fila ES avalanche/kite y ambos endpoints coinciden) no hay diff → no-op.

**Coherencia (CD-5/AC-6):** tras el merge, `agent.payment.chain` es la chain real; ese
mismo valor lo consume el selector Base de `invokeAgent` (`:416-420`) y
`signAndSettleDownstream` (`:459` → `downstream-payment.ts:151`). Una sola fuente.

**No silent cross-chain (CD-5):** si la chain real no se puede determinar (discover no
trae el agente), NO se cambia el payment → el comportamiento es el actual (no se inventa
una chain). Si la chain real es desconocida para `normalizeChainSlug`, GATE 1 ya la
rechazó (`readPayment` → `undefined`), así que `real.payment` no existe y no se hidrata.

#### Costo / riesgo de la doble consulta

`resolveAgent` ya hace hasta 2 `getAgent` + 1 `discover()` en el peor caso (fallback).
La hidratación agrega **un** `discover({ limit: 50 })` cuando el agente se resolvió por
`getAgent` (no por el fallback discover). Mitigación: si el agente se resolvió por el
fallback `discover()` (paso 1, rama 3), **ese resultado YA tiene la chain real** → no se
re-consulta (reusar el agente del fallback). El Story File detallará evitar la doble
llamada en ese caso. Latencia adicional acotada (una llamada al registry ya cacheado por
el circuit-breaker); aceptable para un path que ya hace I/O de red.

### 4.4 Diseño de la validación dinámica en discovery (DT-4/DT-5 — CERRADO)

#### Decisión DT-4: `normalizeChainSlug` (resolver puro), NO `getInitializedChainKeys()`

`readPayment` valida con `normalizeChainSlug(chainRaw) !== undefined`. **NO** se acopla
discovery a `getInitializedChainKeys()` (chains inicializadas en el proceso).

Justificación (preferencia F1 + separación de responsabilidades):
- **Desacoplamiento**: `chain-resolver.ts` NO importa el registry de adapters (`:5-6`
  doc "Pure module — does NOT import from `./registry`"). Usar `normalizeChainSlug` en
  discovery mantiene discovery sin dependencia de la init de adapters. Acoplar a
  `getInitializedChainKeys()` haría que el resultado de discovery dependa del orden de
  arranque / de qué chains están en `WASIAI_A2A_CHAINS` — mezcla "qué chains conoce el
  protocolo" con "qué chains están activas en este proceso".
- **El guard de init ya vive aguas abajo**: `downstream-payment.ts:152-164` (WKH-112)
  ya hace `getAdaptersBundle(chainKey)` y skip `CHAIN_NOT_SUPPORTED` fail-loud si la
  chain conocida no está inicializada. Duplicar ese guard en discovery sería redundante
  y movería la decisión de "pagable ahora" al lugar equivocado. Discovery debe responder
  "¿es una chain que el protocolo entiende?"; el downstream responde "¿puedo pagarla en
  este proceso ahora mismo?".
- **Efecto**: una chain conocida pero no inicializada (ej. `base-mainnet` sin estar en el
  CSV) pasa el filtro de discovery (`payment` poblado) pero hace skip fail-loud en el
  settle. Es el comportamiento correcto (fail-loud aguas abajo, ya cubierto por WKH-112)
  y no abre cross-chain.

#### Decisión DT-5: preservar la defensa SEC-AR BLQ-MED-1

La validación dinámica **sigue rechazando** chains desconocidas: `normalizeChainSlug`
devuelve `undefined` para cualquier slug fuera de `SLUG_ALIASES` (`polygon`, `solana`,
`avalanche` literal-pero-typo, etc.). `readPayment` retorna `undefined` en ese caso
(`agent.payment` ausente → el downstream skip con `NO_PAYMENT_FIELD`). El objetivo es
**ampliar** el conjunto aceptado a "todas las chains que el resolver conoce" (que son
exactamente las que el gateway sabe pagar vía adapters), NO eliminar la validación. Un
registry comprometido que exponga `chain: 'ethereum-classic'` sigue siendo rechazado.

> **Comparación con la allowlist actual**: hoy `ALLOWED_CHAIN_VALUES` acepta
> `{avalanche, avalanche-testnet, avalanche-mainnet, kite-ozone-testnet, kite-mainnet}`.
> `normalizeChainSlug` acepta esos MÁS `{avalanche-fuji, fuji, 43113, 43114, 2368,
> kite-testnet, base-sepolia, base-testnet, 84532, base, base-mainnet, 8453, 2366}`. El
> conjunto se amplía a Base + Fuji + chainIds numéricos — exactamente las chains que los
> adapters soportan (`SUPPORTED_CHAINS`, registry.ts:25-32). NO se acepta ninguna chain
> sin adapter.

#### Preservación del shape de salida (CD-2/AC-2 — invariante crítico)

`readPayment` **NO** cambia el string `chain` de salida a `ChainKey`. Conserva la
normalización actual (`:97-103`):
- `avalanche-testnet`/`avalanche-mainnet` → `'avalanche'` (colapso histórico).
- todo lo demás (incl. `avalanche`, `kite-ozone-testnet`, `base-sepolia`,
  `avalanche-fuji`) → pass-through sin tocar.

**Por qué NO normalizar a `ChainKey`:** `normalizeChainSlug('avalanche')` →
`'avalanche-fuji'`. Si `readPayment` devolviera el `ChainKey`, el output observable de
`/discover`/`/capabilities` para un agente Avalanche cambiaría de `'avalanche'` a
`'avalanche-fuji'` → rompería los tests existentes (`discovery.test.ts:179,221,273`) y el
contrato observable (viola CD-2/AC-2). Como `downstream-payment.ts` ya re-normaliza con
`normalizeChainSlug` (`:151`) — y `normalizeChainSlug('avalanche')` y
`normalizeChainSlug('avalanche-fuji')` resuelven AMBOS a `'avalanche-fuji'` (mismo
adapter Fuji) — preservar el string legacy en discovery es seguro y CERO-regresión. La
validación (resolver puro) y la salida (string preservado) son responsabilidades
separadas dentro de `readPayment`.

### 4.5 Flujo principal (Happy Path Base Sepolia)

1. `/compose` step `{ agent: 'base-pay-agent' }`. `resolveAgent`:
   - `getAgent('base-pay-agent')` → v2 `agents/{slug}` devuelve `payment.chain` hardcodeado
     a `avalanche` (o, con `payment` ya poblado por GATE 1 arreglado, `avalanche`).
   - Hidratación: `discover({limit:50}).find('base-pay-agent')` → capabilities devuelve
     `payment.chain = 'base-sepolia'` (real). Difiere → `agent.payment = real.payment`
     (`{method:'x402', chain:'base-sepolia', contract:'0x…', asset:'USDC'}`).
2. `invokeAgent(agent)`: selector Base loguea `chainKey=base-sepolia` (`:416-420`).
3. `signAndSettleDownstream(agent, logger)` → `normalizeChainSlug('base-sepolia')` →
   `'base-sepolia'` → `getAdaptersBundle` OK → `adapter.sign/verify/settle` (Base,
   `eip155:84532`) → `DownstreamResult { txHash, settledAmount }` (AC-3/AC-4).

### 4.6 Flujo de error

1. **Chain desconocida en readPayment** (`chain='solana'`): `normalizeChainSlug` →
   `undefined` → `readPayment` → `undefined` → `agent.payment` ausente → downstream skip
   `NO_PAYMENT_FIELD` (AC-5/CD-1). No cross-chain.
2. **Chain real no encontrada en discover** (agente fuera del top-50): `resolveAgent`
   conserva el `payment` de getAgent (fail-soft, no cambia comportamiento — §4.3 paso 3).
3. **Chain conocida pero no inicializada** (`base-mainnet` sin estar en `WASIAI_A2A_CHAINS`):
   discovery la acepta (payment poblado), el downstream skip `CHAIN_NOT_SUPPORTED`
   fail-loud (WKH-112, `downstream-payment.ts:152-164`). No cross-chain.
4. **Agente Avalanche/Kite** (sin diff entre endpoints): merge no-op, comportamiento
   byte-idéntico (AC-2/CD-2).

## 5. Cierre de Decisiones Técnicas (DT-1/DT-3/DT-4/DT-5 + AC-7)

### DT-1 — Fuente de la chain de pago en compose (CERRADO → opción b, merge selectivo)

Ver §4.3. `resolveAgent` mantiene `getAgent` para la metadata e hidrata `payment` desde
el path `discover()`/capabilities (chain real), corrigiendo solo cuando difiere. No-op
para Avalanche/Kite (CD-2). No toca v2 (CD-6). No invierte la prioridad de resolución
(evita el blast radius de la opción a). **De menor riesgo y a2a-puro.**

### DT-3 — payTo del settle outbound (CERRADO → PRESERVAR comportamiento actual)

**Evidencia (verificada archivo:línea):**
- El destinatario del settle outbound es `agent.payment.contract`:
  `validatePayTo(agent.payment.contract)` (`downstream-payment.ts:167`), luego
  `adapter.sign({ to: payToCheck.addr, ... })` con `payToCheck.addr = agent.payment.contract`
  (`:279-280`).
- `readPayment` llena `contract` con `obj.contract` (`discovery.ts:88,108`), que en el
  flujo v2 es `getMarketplaceAddress(CHAIN_ID)` (contrato del marketplace) — ambos
  endpoints v2 emiten ese mismo `payment.contract` para las 3 chains por igual
  (work-item H14/H15, no re-verificado en v2 — fuera de scope CD-6).

**Decisión:** para esta HU se **PRESERVA** el comportamiento actual. El destinatario del
settle outbound a Base será el MISMO tipo de address (contrato del marketplace de la
chain real) que hoy recibe el outbound Avalanche/Kite. Esta HU NO cambia el `payTo`: el
único cambio respecto de hoy es que la chain del `payment` será la real (`base-sepolia`),
y por tanto el `contract` será el del marketplace de Base (que viene del mismo path
capabilities que la chain). **No es un bug nuevo de Base** — el modelo de payTo
centralizado en el marketplace afecta las 3 chains por igual y precede a esta HU.

**Por qué NO es BLOQUEANTE / NO requiere `[NEEDS CLARIFICATION]`:** el comportamiento
resultante es funcionalmente equivalente al outbound Avalanche/Kite que YA funciona en
prod (WKH-112, settle onchain verificado). Habilitar Base con el mismo modelo de payTo
NO introduce un riesgo nuevo ni cambia el invariante de seguridad. El payTo per-agente
(en vez del contrato del marketplace) es una **mejora de modelo de negocio** que requiere
cambios en wasiai-v2 (que ambos endpoints emitan el wallet per-agente) → **TD-WKH-113-01
+ sub-tarea wasiai-v2 separada** (Scope OUT, CD-6). No bloquea la habilitación de Base.

> El Architect NO considera que el comportamiento actual sea incorrecto ni bloqueante
> para esta HU: es coherente con el outbound ya funcional. Por tanto **NO se marca
> `[NEEDS CLARIFICATION]`**; se documenta como TD/sub-tarea para evolución futura.

### DT-4 — Validación dinámica: resolver puro vs chains inicializadas (CERRADO → resolver puro)

Ver §4.4. `normalizeChainSlug` (puro, desacoplado del registry); el guard de init vive
aguas abajo en `downstream-payment.ts` (WKH-112). Preferencia F1 confirmada.

### DT-5 — Preservar defensa SEC-AR BLQ-MED-1 (CERRADO → preservada)

Ver §4.4. Slug desconocido → `undefined`. El conjunto aceptado se amplía solo a chains
con adapter (las que `normalizeChainSlug` conoce); no se elimina la validación.

### AC-7 — Habilitar `avalanche-fuji` es deseado y seguro (CERRADO → SÍ)

`avalanche-fuji` resuelve, vía `normalizeChainSlug`, al adapter Fuji (`eip155:43113`),
**la misma red de pago que el path `avalanche` actual** (USDC Fuji). Hoy un agente
`chain=avalanche-fuji` cae fuera del allowlist (`payment=null`, H1) y no se le puede
pagar. Habilitarlo significa "más agentes ahora cobrables en una chain YA soportada y
probada onchain", NO una chain nueva no validada. **No abre un vector de pago no
intencional**: el destino del settle sigue siendo el adapter Fuji, idéntico al que ya
settlea para `avalanche`. Confirmado deseado y seguro.

> **Nota de coherencia (no bloqueante):** un agente que declare literal `avalanche-fuji`
> sale de `readPayment` con `chain='avalanche-fuji'` (pass-through), mientras un agente
> `avalanche-testnet` sale como `'avalanche'`. Ambos resuelven al MISMO adapter Fuji vía
> `normalizeChainSlug` en el downstream → mismo settle. La divergencia de string es
> cosmética y no afecta el routing (CD-2 preservado: los strings legacy `avalanche`/kite
> no cambian; solo se AGREGA la aceptación de `avalanche-fuji`).

## 6. Constraint Directives (Anti-Alucinación)

### Heredados del work-item (OBLIGATORIO)

- **CD-1** (sin hardcode de chains): PROHIBIDO mantener `ALLOWED_CHAIN_VALUES` ni ningún
  `Set`/array literal de slugs como fuente de verdad de qué chains acepta discovery. La
  validación DEBE derivarse de `normalizeChainSlug` (chain-resolver). Los aliases dentro
  de `chain-resolver.ts` NO son hardcode de esta HU (mapeo canónico reutilizado).
- **CD-2** (cero regresión Avalanche/Kite): el `agent.payment` producido para agentes
  Avalanche/Kite DEBE ser idéntico al actual (misma `chain` normalizada —
  avalanche-testnet/mainnet → `'avalanche'`; kite pass-through —, mismo
  `contract`/`asset`/`method`), y el settle outbound de esas chains DEBE permanecer
  funcionalmente idéntico. Suite existente verde. Cualquier diff observable es **BLOQUEANTE**.
- **CD-3** (solo viem, PROHIBIDO ethers.js): no aplica directamente (esta HU no toca
  firma onchain), pero PROHIBIDO introducir ethers si el wiring lo rozara.
- **CD-4** (TypeScript strict): PROHIBIDO `any` explícito y `as unknown`. La chain de
  salida de `readPayment` sigue siendo `string` (pass-through, `AgentPaymentSpec.chain`);
  el `ChainKey` se usa solo internamente para la validación (`normalizeChainSlug` ya
  tipa el retorno como `ChainKey | undefined`).
- **CD-5** (no silent cross-chain): PROHIBIDO que la chain de pago resuelta por compose
  difiera de la chain real declarada por el agente. Si la chain real no se puede
  determinar con confianza, DEBE preferirse conservar el comportamiento actual / fail-loud
  aguas abajo (`CHAIN_NOT_SUPPORTED`) antes que asumir avalanche o Base.
- **CD-6** (no modificar wasiai-v2 en esta HU): el cambio es wasiai-a2a puro. La
  dependencia v2 (getAgent chain-real + payTo per-agente) se documenta como sub-tarea
  separada (TD-WKH-113-01), NO se incluye. Si el Dev cree que necesita tocar v2 → STOP.

### Nuevos del SDD (OBLIGATORIO)

- **CD-7** (preservar el shape de salida de `readPayment`): `readPayment` DEBE seguir
  devolviendo el string `chain` legacy (avalanche-testnet/mainnet → `'avalanche'`; resto
  pass-through). PROHIBIDO devolver el `ChainKey` de `normalizeChainSlug` como `chain`
  (cambiaría `avalanche` → `avalanche-fuji`, rompiendo CD-2 y los tests existentes). La
  validación usa `normalizeChainSlug` solo para decidir aceptar/rechazar, NO para reemplazar
  el valor de salida.
- **CD-8** (merge no-op para Avalanche/Kite en compose): la hidratación de chain en
  `resolveAgent` DEBE ser un no-op observable cuando `getAgent` y `discover()` concuerdan
  (Avalanche/Kite). PROHIBIDO cambiar el agente resuelto cuando no hay diff de chain.
  AR/CR DEBE verificar con un test que para `chain=avalanche`/`kite-ozone-testnet` el
  `agent.payment` final es idéntico al de `getAgent` (CD-2).
- **CD-9** (validación reutiliza el resolver puro, no se duplica): la validación de chain
  en `readPayment` DEBE usar `normalizeChainSlug` de `chain-resolver.ts`. PROHIBIDO
  reintroducir un `Set`/array de slugs, un `if (chain === 'base-sepolia')`, o acoplar
  discovery a `getInitializedChainKeys()` (DT-4).
- **CD-10** (no silent cross-chain en el merge — refuerza CD-5): la hidratación en
  `resolveAgent` SOLO corrige `payment` desde el path con la chain real
  (`discover()`/capabilities). PROHIBIDO inferir la chain de otra fuente, hardcodear Base,
  o asumir una chain cuando `discover()` no trae el agente. En ese caso se conserva el
  `payment` de getAgent (comportamiento actual).
- **CD-11** (mock-registry completo en tests compartidos — hereda lección WKH-111/093 +
  WKH-67/072): tras los cambios, `grep -rn "vi.mock('.*discovery" src/` y
  `grep -rn "vi.mock('.*adapters/chain-resolver" src/`; verificar que todo mock de
  `discovery.js` consumido por compose exponga `discover` (no solo `getAgent`), y que
  ningún mock incompleto devuelva `undefined` silencioso rompiendo el merge. Un mock de
  `discovery` que no exporte `discover` haría fallar la hidratación.

### PROHIBIDO (resumen)

- NO modificar `src/adapters/chain-resolver.ts`, `src/adapters/registry.ts`, ni ningún adapter.
- NO modificar `src/lib/downstream-payment.ts` (WKH-112 DONE — solo recibe la chain correcta).
- NO modificar `src/middleware/x402.ts`/`a2a-key.ts` (inbound, WKH-111 DONE).
- NO modificar wasiai-v2 (CD-6).
- NO cambiar la firma pública de `resolveAgent` ni `signAndSettleDownstream`.
- NO devolver `ChainKey` como `chain` en `readPayment` (CD-7).
- NO usar `any`/`as unknown`. NO agregar dependencias nuevas.

## 7. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Devolver `ChainKey` en `readPayment` cambia `avalanche` → `avalanche-fuji` (rompe CD-2 + tests `:179/221/273`) | M | A | CD-7: preservar el string legacy. La validación (`normalizeChainSlug`) es separada de la salida (string preservado). Test dedicado que afirma `avalanche-testnet` → `'avalanche'` sin cambio. |
| El merge en compose regresa Avalanche/Kite (cambia el agente resuelto) | M | A | CD-8: merge no-op cuando no hay diff. Test que afirma para `chain=avalanche`/`kite` el `payment` final == el de getAgent. |
| Mock de `discovery.js` incompleto en tests compartidos rompe el merge (silent undefined) | M | A | **Lección WKH-111/093 + WKH-67/072**: CD-11 — `grep -rn "vi.mock('.*discovery" src/`; todo mock consumido por compose DEBE exportar `discover`. El mock actual de `compose.test.ts:29-31` YA exporta `discover` (verificado). |
| `tsc --noEmit` pelado reporta TS6059 preexistente | B | B | **Lección WKH-111/093**: usar `tsc -p tsconfig.build.json --noEmit` como typecheck autoritativo. |
| Doble consulta a discover() añade latencia | B | B | §4.3: si el agente se resolvió por el fallback `discover()`, reusar ese resultado (no re-consultar). Registry cacheado por circuit-breaker. |
| Chain real no determinable (agente fuera del top-50 de discover) → settle a chain equivocada | B | A | CD-10: fail-soft conservando el payment de getAgent — NO se asume Base; el comportamiento queda igual al actual. Si getAgent trajo avalanche y el agente es realmente Base pero no aparece en discover, el settle hace skip o va a avalanche como hoy (no peor que el estado actual). Documentado. |
| Habilitar `avalanche-fuji` abre vector de pago | B | M | AC-7 §5: misma red Fuji ya soportada/probada onchain; no es chain nueva. Test que afirma `avalanche-fuji` → adapter Fuji. |

## 8. Dependencias

- `normalizeChainSlug` (`chain-resolver.ts:61-66`) — ya existe, no se modifica.
- `discoveryService.discover` / `mapAgent` / `readPayment` (`discovery.ts`) — ya existen.
- `signAndSettleDownstream` (`downstream-payment.ts`) — ya chain-aware (WKH-112), no se toca.
- **Runtime/smoke**: el gateway debe arrancar con `WASIAI_A2A_CHAINS` incluyendo
  `base-sepolia,avalanche-fuji,kite-ozone-testnet` (las 3 en prod — WKH-112 Capa D),
  `WASIAI_DOWNSTREAM_X402=true`, `OPERATOR_PRIVATE_KEY` funded, RPCs por chain. La
  evidencia onchain real (AC-4) la ejecuta el humano/QA fuera del pipeline (requiere un
  agente invocable `base-sepolia` — ver §9).

## 9. Requisitos operacionales (documentados, no bloquean unit tests)

- **`WASIAI_A2A_CHAINS`** DEBE incluir las 3 testnets (ya en prod). Una chain conocida no
  incluida → discovery la acepta pero el downstream skip `CHAIN_NOT_SUPPORTED` (DT-4).
- **Agente invocable `base-sepolia`**: hoy hay **0 agentes en `base-sepolia`** (work-item
  H16). Para la evidencia onchain de AC-4 hace falta seedear/disponer de un agente con
  `chain=base-sepolia` invocable en wasiai-v2. **[NEEDS CLARIFICATION operacional — NO
  bloquea el código ni los tests]**: ¿se seedea uno o existe? Sin él, la evidencia onchain
  de Base queda diferida; el flujo se valida con los tests integration discovery→compose
  (fixture base-sepolia). El orquestador escala este punto operacional al humano; NO
  bloquea SPEC_APPROVED (es validación de evidencia, no de diseño).
- **`OPERATOR_PRIVATE_KEY`** funded en las 3 chains (ya funded — WKH-112 H15).

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| TD-WKH-113-01 | 5/DT-3 | payTo del settle outbound = contrato del marketplace v2 (`getMarketplaceAddress`), no wallet per-agente. Afecta las 3 chains por igual (no es bug nuevo de Base). Mejora de modelo → sub-tarea wasiai-v2 separada (emitir payTo per-agente en ambos endpoints). | No (comportamiento equivalente al outbound Avalanche/Kite ya funcional) |
| NCL-OPS-1 | 9 | Agente invocable `base-sepolia` para la evidencia onchain de AC-4. Operacional, no de diseño. | No (la evidencia onchain queda diferida; el flujo se valida con tests integration) |

> Sin `[NEEDS CLARIFICATION]` de **diseño** pendientes. DT-1/DT-3/DT-4/DT-5 + AC-7
> cerrados en §5. El único NCL es operacional (agente base-sepolia para la evidencia
> onchain) y NO bloquea SPEC_APPROVED ni el código.

---

## Plan — Waves de Implementación

> Las ejecuta el Dev en F3 desde el Story File (F2.5). Aquí el plan que el Story File
> detallará por archivo exacto.

### Wave 0 (Serial Gate — prerequisitos)

- [ ] **W0.1**: `npm test` baseline — registrar el número exacto de tests verdes ANTES
  de tocar nada (línea base de CD-2).
- [ ] **W0.2**: `tsc -p tsconfig.build.json --noEmit` baseline limpio (typecheck
  autoritativo — NO el `tsc --noEmit` pelado; lección WKH-111/093).
- [ ] **W0.3**: Confirmar que el path discovery→compose expone la chain real per-agente
  en una fixture: con un registry mock cuyo `discoveryEndpoint`/capabilities devuelve un
  raw con `payment.chain = 'base-sepolia'`, afirmar que `discoveryService.discover()`
  produce `agents[0].payment.chain === 'base-sepolia'` (confirma que el path capabilities
  es la fuente correcta antes de tocar compose).

### Wave 1 (Discovery — validación dinámica)

- [ ] **W1.1**: Importar `normalizeChainSlug` en `discovery.ts`. Borrar
  `ALLOWED_CHAIN_VALUES` (`:56-63`). Reemplazar el check (`:92-95`) por
  `if (normalizeChainSlug(chainRaw) === undefined) return undefined;`. CONSERVAR la
  normalización de salida (`:97-103`) intacta (CD-7). Actualizar el JSDoc SEC-AR.
- [ ] **W1.2**: Extender `discovery.test.ts`: acepta `base-sepolia`/`base-mainnet`/
  `avalanche-fuji`/chainIds; preserva `avalanche`/kite; rechaza `solana`/`polygon`. NO
  regresar los asserts existentes.
- [ ] **W1.3 (verif)**: `tsc -p tsconfig.build.json --noEmit` + `npm test` suite verde.

### Wave 2 (Compose — merge selectivo de chain real)

- [ ] **W2.1**: En `compose.ts`, `resolveAgent`: tras resolver el agente, hidratar
  `payment` desde `discover()`/capabilities cuando difiere (§4.3). Evitar la doble
  llamada si el agente se resolvió por el fallback `discover()`. No-op para Avalanche/Kite
  (CD-8). No cambiar la firma.
- [ ] **W2.2**: Crear `compose.chain-flow.test.ts`: integración discovery→compose SIN
  mockear `agent.payment` directo. Ver Test Plan.
- [ ] **W2.3 (verif)**: `tsc -p tsconfig.build.json --noEmit` + `npm test` suite completa
  verde. `grep -rn "vi.mock('.*discovery" src/` y verificar que todos exporten `discover`
  (CD-11, lección WKH-111/093).

### Wave 3 (Validación E2E — la corre el humano/QA)

- [ ] **W3.1**: Evidencia onchain outbound en las 3 chains vía `/compose` contra gateway
  con las 3 testnets + facilitator + operator funded (requiere agente invocable
  base-sepolia — §9). Avalanche/Kite = regresión (tx hash status 0x1); base-sepolia =
  nuevo (tx hash en `sepolia.basescan.org`, AC-4).
- [ ] **W3.2**: Confirmar suite completa verde, cero regresión Avalanche/Kite (AC-2/CD-2).

### Dependencias

| Tarea | Depende de | Razón |
|-------|-----------|-------|
| W1.* | W0.1, W0.2, W0.3 | Baseline + confirmación de que capabilities expone la chain real. |
| W2.* | W1.* | El merge consume el `payment` ya validado por la discovery dinámica. |
| W3.* | W2.* | El smoke ejercita el path completo end-to-end. |

### Archivos involucrados

| Archivo | Existe | Acción | Wave | Exemplar |
|---------|--------|--------|------|----------|
| `src/services/discovery.ts` | Sí | Modificar | W1.1 | `normalizeChainSlug` |
| `src/services/discovery.test.ts` | Sí | Extender | W1.2 | `discovery.test.ts:157-304` |
| `src/services/compose.ts` | Sí | Modificar (`resolveAgent`) | W2.1 | `resolveAgent:328-337` |
| `src/services/compose.chain-flow.test.ts` | No | Crear | W2.2 | `discovery.test.ts` fixture + `compose.test.ts:29-48` |
| `src/lib/downstream-payment.ts` | Sí | NO modificar | — | — |

## Test Plan

> Framework: vitest. **Estrategia crítica (lección WKH-112)**: los tests de compose NO
> deben mockear `agent.payment` directo. El test de integración del path AC-3 mockea el
> registry HTTP (`fetch`) y el módulo `downstream-payment.js`, dejando correr el REAL
> `discoveryService` (real `mapAgent`/`readPayment`/`discover`) y la REAL `resolveAgent`,
> capturando el `agent` que llega a `signAndSettleDownstream`. Para `getAgent` vs
> `discover()` divergentes, la fixture devuelve `chain=avalanche` en el path getAgent
> (`agentEndpoint`) y `chain=base-sepolia` en el path discover (`discoveryEndpoint`).

| Test | AC que cubre | Wave | Qué prueba / qué se mockea |
|------|-------------|------|----------------------------|
| **T-AC1a**: readPayment acepta base-sepolia | AC-1/CD-1 | W1.2 | `mapAgent` con `payment.chain='base-sepolia'` → `agent.payment.chain==='base-sepolia'` (antes daba `undefined`). |
| **T-AC1b**: readPayment acepta avalanche-fuji + chainId | AC-1/AC-7 | W1.2 | `chain='avalanche-fuji'` → `'avalanche-fuji'`; `chain='84532'` → `'84532'` (pass-through, aceptado). |
| **T-AC2a**: regresión avalanche normalizado | AC-2/CD-2/CD-7 | W1.2 | `chain='avalanche'` → `'avalanche'`; `chain='avalanche-testnet'` → `'avalanche'`; `chain='avalanche-mainnet'` → `'avalanche'` (idéntico a hoy, NO `avalanche-fuji`). |
| **T-AC2b**: regresión kite pass-through | AC-2/CD-2/CD-7 | W1.2 | `chain='kite-ozone-testnet'` → `'kite-ozone-testnet'` (pass-through, sin cambio). |
| **T-AC5**: chain desconocida → undefined | AC-5/DT-5 | W1.2 | `chain='polygon'` y `chain='solana'` → `readPayment` undefined → `agent.payment` undefined (defensa SEC-AR preservada). |
| **T-AC1-discover**: discover expone base-sepolia | AC-1/AC-3 | W1.2 | `discover()` con fixture `chain='base-sepolia'` → `agents[0].payment.chain==='base-sepolia'`. |
| **T-AC3-flow**: chain real Base sobrevive discovery→compose | AC-3/AC-6/CD-5/CD-10 | W2.2 | Registry fixture: `agentEndpoint`→`chain=avalanche` (getAgent hardcode), `discoveryEndpoint`→`chain=base-sepolia` (real). `resolveAgent('base-pay-agent')` → `agent.payment.chain==='base-sepolia'`. Mock `downstream-payment` y afirmar que el `agent` capturado tiene `payment.chain==='base-sepolia'` (la chain sobrevive hasta el borde del settle). **NO mockea `agent.payment` directo.** |
| **T-CD8a**: merge no-op avalanche | AC-2/CD-8 | W2.2 | Ambos endpoints `chain=avalanche` (o getAgent avalanche + discover avalanche). `resolveAgent` → `payment` idéntico al de getAgent; sin cross-chain. |
| **T-CD8b**: merge no-op kite | AC-2/CD-8 | W2.2 | Ambos endpoints `chain=kite-ozone-testnet`. `payment` final == getAgent. |
| **T-CD10**: chain real no encontrada → fail-soft | CD-5/CD-10 | W2.2 | `discover()` no trae el agente (top-50 vacío para ese slug). `resolveAgent` conserva el `payment` de getAgent (no asume Base, no cross-chain). |
| **T-AC7**: avalanche-fuji habilitado | AC-7 | W1.2/W2.2 | Agente `chain=avalanche-fuji` (hoy `payment=null`) ahora con `payment` poblado; la chain resuelve al adapter Fuji aguas abajo. |
| **smoke outbound** (E2E) | AC-4/AC-2 | W3.1 | Oráculo real: tx hash en Basescan (base-sepolia) + status 0x1 en Avalanche/Kite (regresión). Lo corre el humano/QA. |

> Cobertura: AC-1 (T-AC1a/b, T-AC1-discover), AC-2 (T-AC2a/b, T-CD8a/b), AC-3 (T-AC3-flow),
> AC-4 (smoke), AC-5 (T-AC5), AC-6 (T-AC3-flow), AC-7 (T-AC1b, T-AC7). ≥1 test por AC.
> Total: ~11 unit/integration + 1 smoke E2E.

## Verificación Incremental

| Wave | Verificación al completar |
|------|---------------------------|
| W0 | baseline `npm test` verde + `tsc -p tsconfig.build.json --noEmit` limpio + discover expone chain real (fixture) |
| W1 | tsc autoritativo + `npm test` suite completa verde (incl. nuevos discovery) |
| W2 | tsc + `npm test` suite completa verde + grep mocks discovery completos (CD-11) |
| W3 | smoke E2E (tx hash Basescan + regresión Avalanche/Kite) + full suite verde |

## Estimación

- Archivos modificados: 2 prod (`discovery.ts` neto ~-8/+4 por borrar el Set; `compose.ts`
  `resolveAgent` ~+12).
- Archivos de test: 1 extendido (`discovery.test.ts`), 1 nuevo (`compose.chain-flow.test.ts`).
- Tests: ~11 unit/integration + 1 smoke E2E.
- Líneas estimadas: prod neto ~+10; test ~+200.

---

## Readiness Check (Architect — ejecutado antes de SPEC_APPROVED)

```
READINESS CHECK:
[x] Cada AC tiene ≥1 archivo asociado en tabla 4.1 (discovery.ts + compose.ts + tests)
[x] Cada archivo en 4.1 tiene Exemplar verificado con Read (normalizeChainSlug, resolveAgent:328-337, discovery.test.ts:157-304, compose.test.ts:29-48)
[x] No hay [NEEDS CLARIFICATION] de diseño pendientes — DT-1/DT-3/DT-4/DT-5 + AC-7 cerrados en §5
[x] DT-3 (payTo) resuelto: PRESERVAR comportamiento actual (equivalente al outbound Avalanche/Kite); TD-WKH-113-01 + sub-tarea v2; NO bloqueante, NO marcado [NEEDS CLARIFICATION]
[x] Único NCL es operacional (agente base-sepolia para evidencia onchain) — NO bloquea SPEC_APPROVED
[x] Constraint Directives ≥3 PROHIBIDO (CD-1..CD-11 + sección PROHIBIDO); CD-1..CD-6 heredados
[x] Context Map ≥2 archivos leídos (8 archivos, líneas reales verificadas)
[x] Scope IN/OUT explícitos y no ambiguos
[x] BD: N/A (no aplica) — declarado
[x] Happy Path completo (§4.5)
[x] Flujo de error definido — 4 casos (§4.6)
[x] Cada AC tiene ≥1 test en Test Plan
[x] DTs abiertos del work-item cerrados (DT-1 merge selectivo, DT-3 payTo preservar, DT-4 resolver puro, DT-5 defensa preservada, AC-7 fuji seguro)
[x] Auto-Blindaje histórico revisado (3 últimas DONE: WKH-112/094, WKH-111/093, WKH-106/090):
    - CD-11 hereda lección WKH-111/093 + WKH-67/072 (mock-registry/discovery incompleto → silent undefined → ripple). Verificado: compose.test.ts:29-31 YA exporta `discover`.
    - W0.2/W1.3/W2.3 aplican lección WKH-111/093 (tsc -p tsconfig.build.json autoritativo, NO tsc pelado TS6059).
    - CD-7 aplica lección WKH-112/094 (campo/normalización que cambia silenciosamente al delegar/normalizar — aquí 'avalanche'→'avalanche-fuji'; debe quedar test-afirmado: T-AC2a).
    - Estrategia de test integration discovery→compose (NO mockear agent.payment) cierra el gap de scoping de WKH-112.
```

Todos los checks pasan. SDD listo para presentar al humano en GATE 2 (SPEC_APPROVED).

---

*SDD generado por NexusAgil — FULL — WKH-113 (BASE-08)*
