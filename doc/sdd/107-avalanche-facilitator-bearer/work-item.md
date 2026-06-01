# Work Item — [WKH-107] [AVAX-BEARER] — wasiai-a2a manda `Authorization: Bearer` al facilitator en verify/settle Avalanche

> 🪞 **ESPEJO de WKH-106 (BASE-02).** Mismo gap, mismo fix, distinto adapter. WKH-106
> cerró el gap de bearer en el Base adapter (`src/adapters/base/payment.ts`); el
> Architect lo detectó como **TD-1: "Avalanche tiene el mismo gap"** en el SDD de
> WKH-106. Este work-item resuelve ese TD-1 sobre `src/adapters/avalanche/payment.ts`.
> El facilitator deployado (el MISMO que Base) **ya settlea Avalanche** — el único
> gap real es que el cliente Avalanche de a2a no se autentica → un settle/verify real
> hoy daría **HTTP 401**.

## Resumen

El Avalanche adapter de `wasiai-a2a` (`src/adapters/avalanche/payment.ts`) está
completo y ya apunta al facilitator deployado por default
(`getFacilitatorUrl()` → `AVALANCHE_FACILITATOR_URL ?? WASIAI_FACILITATOR_URL ??
https://wasiai-facilitator-production.up.railway.app`, l.143-149). PERO `verifyX402`
(l.238-243) y `settleX402` (l.278-283) mandan solo el header
`{ 'Content-Type': 'application/json' }` — **no mandan `Authorization: Bearer <key>`**,
que el facilitator exige (`requireFacilitatorKey`, timing-safe, obligatorio fuera de
`NODE_ENV=test`). El MISMO facilitator que ya settlea Base Sepolia también settlea
Avalanche: `GET /supported` lista `eip155:43113` (Fuji) y `eip155:43114` (C-Chain),
ambos breaker CLOSED. Resultado: un `/verify` o `/settle` real desde el adapter
Avalanche contra el facilitator deployado devuelve **HTTP 401**.

Este work-item agrega el header bearer leyendo la key desde env con degradación
segura — **espejo exacto del fix de WKH-106 en Base** (`getFacilitatorApiKey()`,
header condicional). **NO es un build** — es un wiring de auth de bajo riesgo sobre
un adapter existente. **NO se toca el repo `wasiai-facilitator`** (ya está hecho) ni
el Base adapter (ya hecho en WKH-106).

## Sizing

- **SDD_MODE: mini** (cambio quirúrgico en 1 archivo de producción + `.env.example` + tests)
- **Estimación: S** — agregar un helper de resolución de key (espejo del
  `getFacilitatorApiKey()` de Base) + un header condicional en 2 funciones
  (`verifyX402` / `settleX402`), documentar 1 env var, y tests que asserten el
  header. No mueve fondos nuevos, no agrega chains, no toca firmas de interfaces.
  Idéntico en alcance a WKH-106 (que fue S).
- **Categoría: ENABLEMENT / WIRING** (NO build, NO L). El facilitator ya existe y
  settlea Avalanche; lo que falta es que el cliente Avalanche se autentique.
- **Metodología: QUALITY** — toca el payment path (verify/settle) → AR + CR
  obligatorios aunque el cambio sea chico.
- **Branch sugerido:** `feat/107-avalanche-facilitator-bearer`
- **Repos afectados:** SOLO `wasiai-a2a`. `wasiai-facilitator` NO se toca.

## Skills Router (máx 2)

- `secure-secrets-handling` — la API key es un secret: solo desde env, nunca
  hardcode, nunca en logs/serialización.
- `http-client-auth` — construcción correcta del header `Authorization: Bearer`
  en un fetch existente sin romper el path degradado.

## Grounding — estado real (archivo:línea, verificado en vivo 2026-06-01)

### wasiai-facilitator — COMPLETO y settleando Avalanche (NO se toca)

| Hecho | Evidencia |
|-------|-----------|
| Mismo facilitator que Base, deployado | `https://wasiai-facilitator-production.up.railway.app` |
| `GET /supported` lista Avalanche | `eip155:43113` (Fuji) + `eip155:43114` (C-Chain), ambos breaker CLOSED |
| `/settle` + `/verify` exigen auth | `requireFacilitatorKey` timing-safe, header `Authorization: Bearer <FACILITATOR_API_KEY>`, obligatorio fuera de `NODE_ENV=test` (idéntico a lo verificado en WKH-106) |
| Domain EIP-712 server-side | el envelope del cliente NO necesita `extra.name/version` |

### wasiai-a2a — el GAP REAL (Avalanche adapter)

| Path | Estado |
|------|--------|
| `src/adapters/avalanche/payment.ts:238-243` | `verifyX402` fetch a `/verify` con `headers: { 'Content-Type': 'application/json' }` — **falta `Authorization: Bearer`** → 401 real. |
| `src/adapters/avalanche/payment.ts:278-283` | `settleX402` fetch a `/settle` con `headers: { 'Content-Type': 'application/json' }` — **falta `Authorization: Bearer`** → 401 real. |
| `src/adapters/avalanche/payment.ts:143-149` | `getFacilitatorUrl()` — cadena de fallback de URL a espejar para la key: `AVALANCHE_FACILITATOR_URL ?? WASIAI_FACILITATOR_URL ?? default`. NO existe aún `getFacilitatorApiKey()` en este archivo. |
| `src/adapters/avalanche/payment.ts:203-224` | `buildX402CanonicalBody` — NO cambia (el header es transport-level). |
| `src/adapters/types.ts` | `SettleRequest` / `VerifyResult` / `X402Proof` — interfaces NO cambian. |
| `src/adapters/__tests__/avalanche.test.ts:31-32` | tests del adapter; mockean `fetch` (`mockFetch` vía `vi.stubGlobal`). Aquí van los asserts del header bearer. |
| `.env.example:176-186` | sección "Avalanche facilitator override" documenta `AVALANCHE_FACILITATOR_URL`. Falta documentar la nueva `AVALANCHE_FACILITATOR_API_KEY`. |

### Solución de WKH-106 a espejar (Base adapter, ya mergeado — referencia, NO se toca)

| Path | Patrón a espejar |
|------|------------------|
| `src/adapters/base/payment.ts:173-179` | `getFacilitatorApiKey()`: `process.env.BASE_FACILITATOR_API_KEY?.trim() \|\| process.env.FACILITATOR_API_KEY?.trim() \|\| undefined`. |
| `src/adapters/base/payment.ts:269-273` | en `verifyX402`: `const headers = { 'Content-Type': 'application/json' }; if (apiKey) headers.Authorization = ` Bearer ${apiKey}` ;`. |
| `src/adapters/base/payment.ts:314-318` | ídem en `settleX402`. |
| `.env.example:534-539` | doc de `BASE_FACILITATOR_API_KEY` (formato a espejar para `AVALANCHE_FACILITATOR_API_KEY`). |

> ⚠️ Diferencia con Base a respetar: el tipo de red del Avalanche adapter es
> `'fuji' | 'mainnet'` (`AvalancheNetwork`), NO `'testnet' | 'mainnet'`. El nombre
> del helper y la cadena de fallback son los únicos cambios respecto al patrón Base.
> A diferencia de Base (caveat BASE-01 stale), **Avalanche NO tiene un caveat stale
> que borrar** — el header del archivo ya describe correctamente el canonical x402
> mode. No hay equivalente de AC-7 de WKH-106.

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `verifyX402` POSTea a `/verify` AND existe una API key configurada
  vía env, the system SHALL incluir el header `Authorization: Bearer <key>` en el
  request además de `Content-Type: application/json`.

- **AC-2**: WHEN `settleX402` POSTea a `/settle` AND existe una API key configurada
  vía env, the system SHALL incluir el header `Authorization: Bearer <key>` en el
  request además de `Content-Type: application/json`.

- **AC-3**: WHERE la API key se resuelve por env, the system SHALL usar la cadena de
  fallback `AVALANCHE_FACILITATOR_API_KEY` → `FACILITATOR_API_KEY` (espejo del orden
  de `getFacilitatorUrl()` en l.143-149 y de `getFacilitatorApiKey()` de Base en
  `base/payment.ts:173-179`), tomando la primera definida y no vacía.

- **AC-4**: IF no hay ninguna API key configurada (ni `AVALANCHE_FACILITATOR_API_KEY`
  ni `FACILITATOR_API_KEY`, o ambas vacías/whitespace), THEN the system SHALL omitir
  el header `Authorization` por completo (degradación segura) y completar el fetch
  sin lanzar — preservando el comportamiento de los tests existentes
  (`avalanche.test.ts`) que no setean la key.

- **AC-5**: the system SHALL NUNCA loguear, serializar ni incluir la API key en
  mensajes de error, envelopes x402 o cualquier salida observable.

- **AC-6**: WHEN se construye el header bearer, the system SHALL leer el valor SOLO
  desde env vars — NUNCA desde un literal hardcodeado en código fuente.

- **AC-7**: the system SHALL documentar la nueva env var `AVALANCHE_FACILITATOR_API_KEY`
  en `.env.example` (sección Avalanche facilitator, junto a `AVALANCHE_FACILITATOR_URL`
  en l.176-186), describiendo la cadena de fallback y la nota "NUNCA commitear el valor
  real / NUNCA en logs".

## Scope IN (solo `wasiai-a2a`)

- `src/adapters/avalanche/payment.ts`:
  - Helper de resolución de key (espejo de `getFacilitatorApiKey()` de Base): leer
    `AVALANCHE_FACILITATOR_API_KEY?.trim() || FACILITATOR_API_KEY?.trim() || undefined`
    (Architect confirma nombre/orden final en F2).
  - `verifyX402` (l.238-243): agregar `Authorization: Bearer <key>` al objeto
    `headers` SOLO si hay key.
  - `settleX402` (l.278-283): ídem.
- `.env.example`: documentar `AVALANCHE_FACILITATOR_API_KEY` (sección Avalanche
  facilitator, l.176-186), con la cadena de fallback y la nota "NO commitear el valor
  real / NUNCA en logs" (espejo de `BASE_FACILITATOR_API_KEY` en l.534-539).
- `src/adapters/__tests__/avalanche.test.ts`: tests que mockean `fetch` y assertean que
  (a) con key seteada el header bearer se manda en verify y settle; (b) sin key el
  header se omite y el fetch igual completa.

## Scope OUT

- **El repo `wasiai-facilitator`** — ya está completo y auditado A+. NO se toca.
- **Avalanche mainnet (43114)** — PROHIBIDO. Strictly testnet (Fuji 43113), igual que
  WKH-106 fue strictly Base Sepolia.
- **El Base adapter (`src/adapters/base/payment.ts`)** — ya resuelto en WKH-106. NO se
  toca (es referencia de patrón, no scope).
- **El Kite adapter** — usa Pieverse mode (patrón distinto), no aplica este gap. Fuera
  de scope.
- **Activar el flag `WASIAI_DOWNSTREAM_X402`** — es ops; lo corre el humano.
- **Setear el valor real de la API key en prod** — es ops (Railway env). Este
  work-item solo wirea el código + documenta la var.
- **Cambios en `extra.name/version` del envelope** — innecesarios; el facilitator
  hardcodea el domain server-side.
- **Cambios en interfaces `SettleRequest` / `VerifyResult` / `X402Proof`** ni en
  `buildX402CanonicalBody` — el header es transport-level.

## Decisiones técnicas (DT-N)

- **DT-1**: La key se resuelve desde env con fallback `AVALANCHE_FACILITATOR_API_KEY`
  → `FACILITATOR_API_KEY`. Razón: espejar (a) la cadena de fallback de URL existente
  del propio Avalanche adapter (`getFacilitatorUrl()` l.143-149: override por-chain →
  shared global) y (b) el patrón ya mergeado en Base (`getFacilitatorApiKey()`
  `base/payment.ts:173-179`). El `FACILITATOR_API_KEY` compartido es el que usa el
  facilitator server-side, así que el cliente puede reusarlo o sobreescribir por-chain.

- **DT-2**: Degradación segura — si no hay key (o es whitespace), se omite el header
  (no se manda `Bearer undefined` ni `Bearer `). Usar `.trim() || undefined` (espejo
  de Base). Razón: los tests existentes (`avalanche.test.ts`) y cualquier entorno
  `NODE_ENV=test` no setean key y el facilitator permite bypass en test; romper eso
  quebraría la suite y el comportamiento local.

- **DT-3**: El header es transport-level — NO se agrega al envelope x402
  (`buildX402CanonicalBody` l.203-224 NO cambia). Razón: separar auth del payload; la
  idempotency key la deriva el server del body, no del header.

- **DT-4**: NO se cambian las firmas de `verify(proof)` / `settle(req)` ni las
  interfaces de `types.ts`. La key se lee del proceso (env), no se pasa como argumento.
  Razón: minimizar superficie de cambio; la key es config de despliegue, no dato de
  request. (Idéntico a DT-4 de WKH-106.)

- **DT-5**: El tipo de red es `AvalancheNetwork = 'fuji' | 'mainnet'` (NO `'testnet'`).
  El helper de key NO depende de la red (la misma key sirve para ambas), igual que
  `getFacilitatorUrl()` no toma `network`. Razón: el facilitator rutea por chain
  internamente vía `accepted.network` del body; la auth es global al facilitator.

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO hardcodear la API key en código fuente. OBLIGATORIO leerla SOLO
  desde env vars. `.env.example` lista la var sin valor real.

- **CD-2**: PROHIBIDO loguear, serializar o incluir la API key en mensajes de error,
  envelopes, o cualquier salida observable (espeja la política del facilitator y el
  CD-2 de WKH-106).

- **CD-3**: PROHIBIDO Avalanche mainnet (43114) en esta HU. Strictly testnet (Fuji
  43113).

- **CD-4**: OBLIGATORIO que el header solo se agregue cuando hay key configurada y no
  vacía (degradación segura). Sin key → header omitido, fetch completa, tests
  existentes no se rompen. PROHIBIDO mandar `Authorization: Bearer undefined`/vacío.

- **CD-5**: PROHIBIDO tocar el repo `wasiai-facilitator`.

- **CD-6**: PROHIBIDO tocar el Base adapter (`src/adapters/base/payment.ts`) — ya
  resuelto en WKH-106. Es referencia de patrón, NO scope de edición.

- **CD-7**: PROHIBIDO cambiar el formato del envelope x402 (`buildX402CanonicalBody`),
  las interfaces de `types.ts`, ni las firmas públicas del adapter.

- **CD-8**: TypeScript strict — sin `any` explícito, sin `as unknown` en código nuevo.

- **CD-9**: En los tests, OBLIGATORIO limpiar env con `delete process.env.X` (NO
  `process.env.X = undefined`) + `mockReset`/`clearAllMocks`, y usar una key literal de
  prueba (NO una real). Espeja CD de tests deterministas de WKH-106.

## Missing Inputs

- **[resuelto en F2 — MENOR] Nombre canónico de la env var de key**: se propone
  `AVALANCHE_FACILITATOR_API_KEY` con fallback a `FACILITATOR_API_KEY` (DT-1).
  Architect confirma en F2 (el facilitator usa `FACILITATOR_API_KEY` server-side; el
  cliente debería poder reusar ese nombre o un override por-Avalanche, igual que Base
  usó `BASE_FACILITATOR_API_KEY ?? FACILITATOR_API_KEY`).

- **[NEEDS CLARIFICATION — no bloqueante]** El valor real de la key en prod (Railway)
  es ops del humano; no bloquea el merge del código ni los unit tests (que mockean
  fetch). El smoke E2E real contra el facilitator deployado requeriría la key, pero ese
  smoke vive en ops, no en esta HU.

## Análisis de paralelismo

- **Bajo riesgo de conflicto.** El cambio toca un solo archivo de producción
  (`src/adapters/avalanche/payment.ts`) en 2 zonas acotadas (2 fetch headers) + un
  helper nuevo. No solapa con el Base adapter (WKH-106, ya mergeado).
- **Resuelve TD-1 de WKH-106** ("Avalanche tiene el mismo gap de bearer faltante").
- **Bloquea**: cualquier settle/verify real de a2a en Avalanche contra el facilitator
  hoy da 401; esta HU lo desbloquea. Habilita el smoke E2E real de Avalanche (ops).
- **Puede ir en paralelo** con cualquier HU que NO toque
  `src/adapters/avalanche/payment.ts` ni `.env.example` (sección Avalanche). Si hay
  otra HU activa sobre el Avalanche adapter, coordinar el merge.
- **No bloquea a `wasiai-facilitator`** (no se toca).
