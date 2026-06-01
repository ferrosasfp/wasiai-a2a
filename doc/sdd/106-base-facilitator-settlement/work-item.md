# Work Item — [WKH-106] [BASE-02] — wasiai-a2a manda `Authorization: Bearer` al facilitator en verify/settle Base

> ⚠️ RE-SCOPE 2026-05-31. La versión previa de este work-item asumía que el repo
> `wasiai-facilitator` era un "scaffold vacío con .gitkeep" — **ESO ES FALSO**. El
> facilitator está COMPLETO, auditado A+ (commit `bd73082`, 616/616 tests verdes),
> deployado y settleando Base Sepolia real (tx `0xb9b156e684f85379311167ec20afb01900194a6436a93df7a660f222ca35521d`,
> block 42260832). Este work-item ahora refleja el **único gap real**: el cliente
> Base de a2a no manda el header `Authorization: Bearer` requerido por el
> facilitator → un settle real hoy daría 401.

## Resumen

El Base adapter de `wasiai-a2a` (`src/adapters/base/payment.ts`) está completo y
ya apunta al facilitator deployado por default. PERO `verifyX402` y `settleX402`
mandan solo el header `Content-Type` — **no mandan `Authorization: Bearer <key>`**,
que el facilitator exige (`requireFacilitatorKey`, timing-safe, obligatorio fuera
de `NODE_ENV=test`). Resultado: un `/verify` o `/settle` real desde a2a contra el
facilitator deployado devuelve **HTTP 401**. Además, el caveat BASE-01 en el header
del archivo está **stale** (afirma "el facilitator NO soporta Base RPC en esta fase
… 4xx esperado") cuando el facilitator YA settlea Base Sepolia.

Este work-item agrega el header bearer (leyendo la key desde env, con degradación
segura cuando no está configurada), borra/actualiza el caveat stale y documenta la
nueva env var. **NO es un build** — es un wiring de auth de bajo riesgo sobre un
adapter existente. **NO se toca el repo `wasiai-facilitator`** (ya está hecho).

## Sizing

- **SDD_MODE: mini** (cambio quirúrgico en 1 archivo de producción + `.env.example` + tests)
- **Estimación: S** — agregar un header condicional en 2 funciones + helper de
  resolución de key (espejo de `getFacilitatorUrl()`), borrar un comentario stale,
  documentar 1 env var, y tests que asserten el header. No mueve fondos nuevos, no
  agrega chains, no toca firmas de interfaces.
- **Categoría: ENABLEMENT / WIRING** (NO build, NO L). El facilitator ya existe y
  settlea; lo que falta es que el cliente se autentique.
- **Metodología: QUALITY** — toca el payment path (verify/settle) → AR + CR
  obligatorios aunque el cambio sea chico.
- **Branch sugerido:** `feat/106-base-facilitator-settlement`
- **Repos afectados:** SOLO `wasiai-a2a`. `wasiai-facilitator` NO se toca.

## Skills Router (máx 2)

- `secure-secrets-handling` — la API key es un secret: solo desde env, nunca
  hardcode, nunca en logs/serialización.
- `http-client-auth` — construcción correcta del header `Authorization: Bearer`
  en un fetch existente sin romper el path degradado.

## Grounding — estado real (archivo:línea, verificado en vivo 2026-05-31)

### wasiai-facilitator — COMPLETO y settleando (NO se toca)

| Hecho | Evidencia |
|-------|-----------|
| Facilitator completo, auditado A+ | commit `bd73082` "WFAC-AUDIT done report — 616/616 tests verdes, A+ seguridad" |
| `base-adapter.ts` real (18.9KB) | flujo `transferWithAuthorization` vía viem, simulate-then-settle |
| Deployado y settleando Base Sepolia | tx `0xb9b156e…ca35521d`, block 42260832, status 0x1, 2 logs Transfer EIP-3009 |
| `GET /supported` lista `eip155:84532` | breaker CLOSED |
| `/settle` + `/verify` exigen auth | `requireFacilitatorKey` (`wasiai-facilitator/src/middleware/auth.ts:21-45`) → header `Authorization: Bearer <FACILITATOR_API_KEY>`, timing-safe (`timingSafeEqual`), obligatorio fuera de `NODE_ENV=test` |
| Idempotency key derivada del body | NO es un header — el server la deriva (no requiere acción del cliente) |
| Domain EIP-712 hardcodeado server-side | `base.ts` hardcodea name='USDC', version='2', USDC `0x036C…CF7e` → el envelope del cliente NO necesita `extra.name/version` |

### wasiai-a2a — el GAP REAL

| Path | Estado |
|------|--------|
| `src/adapters/base/payment.ts:27-34` | **Caveat BASE-01 STALE** — afirma "el facilitator actual (WasiAI o CDP) NO soporta Base RPC en esta fase … una respuesta 4xx del facilitator es esperada y NO falla el build". FALSO hoy. **Borrar/actualizar** + quitar la referencia a "DT-11". |
| `src/adapters/base/payment.ts:262-267` | `verifyX402` fetch a `/verify` con `headers: { 'Content-Type': 'application/json' }` — **falta `Authorization: Bearer`** → 401 real. |
| `src/adapters/base/payment.ts:302-307` | `settleX402` fetch a `/settle` con `headers: { 'Content-Type': 'application/json' }` — **falta `Authorization: Bearer`** → 401 real. |
| `src/adapters/base/payment.ts:163-170` | `getFacilitatorUrl()` — cadena de fallback de URL a espejar para la key: `BASE_FACILITATOR_URL > CDP_FACILITATOR_URL > WASIAI_FACILITATOR_URL > default`. |
| `src/adapters/types.ts:11-29` | `SettleRequest` / `VerifyResult` / `X402Proof` — interfaces NO cambian (el header es transport-level, no del request shape). |
| `src/adapters/__tests__/base.test.ts:32-33` | tests del adapter; mockean `fetch` (`mockFetch`). Aquí van los asserts del header bearer. |
| `.env.example:527-559` | ya documenta `BASE_FACILITATOR_URL` / `CDP_FACILITATOR_URL`. Falta documentar la nueva `BASE_FACILITATOR_API_KEY`. |

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `verifyX402` POSTea a `/verify` AND existe una API key configurada
  vía env, the system SHALL incluir el header `Authorization: Bearer <key>` en el
  request además de `Content-Type: application/json`.

- **AC-2**: WHEN `settleX402` POSTea a `/settle` AND existe una API key configurada
  vía env, the system SHALL incluir el header `Authorization: Bearer <key>` en el
  request además de `Content-Type: application/json`.

- **AC-3**: WHERE la API key se resuelve por env, the system SHALL usar la cadena de
  fallback `BASE_FACILITATOR_API_KEY` → `FACILITATOR_API_KEY` (espejo del orden de
  `getFacilitatorUrl()` en l.163-170), tomando la primera definida.

- **AC-4**: IF no hay ninguna API key configurada (ni `BASE_FACILITATOR_API_KEY` ni
  `FACILITATOR_API_KEY`), THEN the system SHALL omitir el header `Authorization`
  por completo (degradación segura) y completar el fetch sin lanzar — preservando
  el comportamiento de los tests existentes que no setean la key.

- **AC-5**: the system SHALL NUNCA loguear, serializar ni incluir la API key en
  mensajes de error, envelopes x402 o cualquier salida observable.

- **AC-6**: WHEN se construye el header bearer, the system SHALL leer el valor SOLO
  desde env vars — NUNCA desde un literal hardcodeado en código fuente.

- **AC-7**: the system SHALL eliminar el caveat BASE-01 stale de
  `src/adapters/base/payment.ts:27-34` (y la referencia a DT-11), reemplazándolo
  por una nota correcta de que el facilitator ya settlea Base Sepolia y exige
  bearer auth.

## Scope IN (solo `wasiai-a2a`)

- `src/adapters/base/payment.ts`:
  - Helper de resolución de key (espejo de `getFacilitatorUrl()`): leer
    `BASE_FACILITATOR_API_KEY ?? FACILITATOR_API_KEY` (proponer; Architect confirma
    nombres en F2).
  - `verifyX402` (l.262-267): agregar `Authorization: Bearer <key>` al objeto
    `headers` SOLO si hay key.
  - `settleX402` (l.302-307): ídem.
  - Borrar/actualizar el caveat BASE-01 stale (l.27-34) + quitar la referencia a DT-11.
- `.env.example`: documentar `BASE_FACILITATOR_API_KEY` (sección Base, junto a
  `BASE_FACILITATOR_URL` en l.527+), con la cadena de fallback y la nota "NO commitear
  el valor real / NUNCA en logs".
- `src/adapters/__tests__/base.test.ts`: tests que mockean `fetch` y assertean que
  (a) con key seteada el header bearer se manda en verify y settle; (b) sin key el
  header se omite y el fetch igual completa.

## Scope OUT

- **El repo `wasiai-facilitator`** — ya está completo y auditado A+. NO se toca.
- **Base mainnet (8453)** — PROHIBIDO. Strictly testnet (84532).
- **Activar el flag `WASIAI_DOWNSTREAM_X402`** — es ops; lo corre el humano.
- **Setear el valor real de la API key en prod** — es ops (Railway env). Este
  work-item solo wirea el código + documenta la var.
- **Kite / Avalanche adapters** — fuera de scope. (Si Architect detecta que
  Avalanche tiene el MISMO gap de bearer faltante, lo marca como TD/HU aparte; NO
  lo arregla acá.)
- **Cambios en `extra.name/version` del envelope** — innecesarios; el facilitator
  hardcodea el domain server-side.
- **Cambios en interfaces `SettleRequest` / `VerifyResult` / `X402Proof`** — el
  header es transport-level.

## Decisiones técnicas (DT-N)

- **DT-1**: La key se resuelve desde env con fallback `BASE_FACILITATOR_API_KEY` →
  `FACILITATOR_API_KEY`. Razón: espejar la cadena de fallback de URL existente
  (`getFacilitatorUrl()` l.163-170) para que el override por-Base y el shared
  global coexistan, igual que con la URL. [Architect confirma nombres finales en F2.]

- **DT-2**: Degradación segura — si no hay key, se omite el header (no se manda
  `Bearer undefined` ni `Bearer `). Razón: los tests existentes (`base.test.ts`) y
  cualquier entorno `NODE_ENV=test` no setean key y el facilitator permite bypass
  en test (`auth.ts:27-29`); romper eso quebraría la suite y el comportamiento local.

- **DT-3**: El header es transport-level — NO se agrega al envelope x402
  (`buildX402CanonicalBody` l.227-248 NO cambia). Razón: separar auth del payload;
  la idempotency key la deriva el server del body, no del header.

- **DT-4**: NO se cambian las firmas de `verify(proof)` / `settle(req)` ni las
  interfaces de `types.ts`. La key se lee del proceso (env), no se pasa como
  argumento. Razón: minimizar superficie de cambio; la key es config de despliegue,
  no dato de request.

- **DT-5**: El caveat stale (l.27-34) se reescribe, no solo se borra, para dejar
  registro de que BASE-02 cerró el gap de auth y de que el facilitator settlea
  Base Sepolia real. [Wording exacto lo define Architect en F2.]

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO hardcodear la API key en código fuente. OBLIGATORIO leerla
  SOLO desde env vars. `.env.example` lista la var sin valor real.

- **CD-2**: PROHIBIDO loguear, serializar o incluir la API key en mensajes de error,
  envelopes, o cualquier salida observable (espeja la política `CD-NEW-AUTH-NOLOG`
  del facilitator `auth.ts:8-10`).

- **CD-3**: PROHIBIDO Base mainnet (8453) en esta HU. Strictly testnet (84532).

- **CD-4**: OBLIGATORIO que el header solo se agregue cuando hay key configurada
  (degradación segura). Sin key → header omitido, fetch completa, tests existentes
  no se rompen. PROHIBIDO mandar `Authorization: Bearer undefined`/vacío.

- **CD-5**: PROHIBIDO tocar el repo `wasiai-facilitator`.

- **CD-6**: PROHIBIDO cambiar el formato del envelope x402
  (`buildX402CanonicalBody`) ni las interfaces de `types.ts`.

- **CD-7**: TypeScript strict — sin `any` explícito, sin `as unknown` en código nuevo.

## Missing Inputs

- **[resuelto en F2 — MENOR] Nombre canónico de la env var de key**: se propone
  `BASE_FACILITATOR_API_KEY` con fallback a `FACILITATOR_API_KEY` (DT-1). Architect
  confirma en F2 si ya existe una convención (el facilitator usa `FACILITATOR_API_KEY`
  server-side; el cliente debería poder reusar ese nombre o un override por-Base).

- **[resuelto en F2 — MENOR] ¿Avalanche tiene el mismo gap?**: el envelope
  Avalanche también pasa por un facilitator que podría exigir bearer. Architect
  verifica en F2 y, si aplica, abre TD/HU aparte (NO en scope acá).

- **[NEEDS CLARIFICATION — no bloqueante]** El valor real de la key en prod (Railway)
  es ops del humano; no bloquea el merge del código ni los unit tests (que mockean
  fetch). El smoke E2E real contra el facilitator deployado requeriría la key, pero
  ese smoke vive en BASE-04 / ops, no en esta HU.

## Análisis de paralelismo

- **Bajo riesgo de conflicto.** El cambio toca un solo archivo de producción
  (`payment.ts`) en 3 zonas acotadas (caveat header + 2 fetch headers) + un helper.
- **Bloquea**: cualquier settle/verify real de a2a contra el facilitator hoy da 401;
  esta HU lo desbloquea. Habilita el smoke E2E real de Base (BASE-04 / ops).
- **Puede ir en paralelo** con cualquier HU que NO toque `src/adapters/base/payment.ts`.
  Si hay otra HU activa sobre el Base adapter, coordinar el merge para evitar
  conflicto en las líneas del fetch.
- **No bloquea a `wasiai-facilitator`** (no se toca).
