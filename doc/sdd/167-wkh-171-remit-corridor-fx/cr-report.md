# CR Report — WKH-171 `remit-corridor-fx` endpoint HTTP (etapa 1)

> Sección **Adversary** (Code Review de calidad). Reviewer: nexus-adversary.
> Repo revisado: `/home/ferdev/.openclaw/workspace/wasiai-remittance-agents/`
> Contrato: `doc/sdd/167-wkh-171-remit-corridor-fx/story-file.md`
> Nota: no existe `ar-report.md` previo en el SDD dir → CR corre standalone, foco en calidad/patrones.

**Veredicto global: APPROVED (con MENORes)**

Evidencia de verde (ejecutado por el reviewer, entorno seguro):
- `npx tsc --noEmit` → EXIT 0 (typecheck verde, incluso con `types:["node"]` + `React.ReactNode` global).
- `npx vitest run` → **7 files, 38 tests passed** (incluye los 5 nuevos de `route.test.ts` + los 2 previos de `corridor-fx` + resto del repo, todos verdes → sin regresión).

---

## 1. Fidelidad al Story File — OK

- `route.ts` es **byte-idéntico** al contenido exacto del Story File (§W1.1, líneas 266-295). Imports correctos:
  `CorridorFxInputSchema` y `runCorridorFx` desde `@/agents/corridor-fx` — ambos existen y exportados
  (`src/agents/corridor-fx.ts:13`, `:31`). Sin símbolos inventados.
- **Fork de cobraya bien hecho**: comparado con `wasiai-lendable/.../cobraya-credit-scorer/invoke/route.ts`,
  el endpoint **omite** correctamente el bloque receipt EIP-712 (`signReceipt`/`getAgentAddress`, exemplar
  líneas 5, 52-77), el `computeScore`, el `generateRationale` (LLM) y el `isValidUuidV4`. Conserva solo el
  patrón `safeParse → 400` + `NextResponse.json`. Cumple Anti-Hallucination §2 (sin receipt, sin pago/x402/
  Supabase/viem).
- Salida envuelta en `{ result }` (route.ts:19) — cumple CD-7 / AC-6, legible por `data.result ?? data`.
- `catch → 502 { error:"quote_unavailable" }` con `console.warn` estructurado sin stack (route.ts:20-27) —
  nunca 500 crudo (AC-7 espíritu). Patrón cobraya respetado.
- Env vars `FALLBACK_FX_*` NO referenciadas en el endpoint (se leen en `fx.ts:10-11`). Sin hardcode de rate/PEN.

## 2. Calidad de tests — OK (1 MENOR de cobertura)

- 5 tests presentes y **verdes**, asertan lo correcto y NO son tautológicos:
  - `route.test.ts:27-37` — 200 `{result}` legible por `data.result ?? data`, valida `slug`, `localCurrency="PEN"`,
    `Number.isFinite(rate)`, `netDeliveredLocal>0`, `quoteId` truthy (matchea `CorridorFxOutput`).
  - `route.test.ts:40-46` — deriva del mid mockeado 3.8 + spread 250bps: `3.6 < rate < 3.8`. Rango correcto
    (esperado ~3.705); confirma que el spread se aplica en contra y que no hay hardcode. No tautológico.
  - `route.test.ts:49-53` — `provenance === "local-fallback"` (AC-4).
  - `route.test.ts:56-62` — negativo: `amountUsd:-5` → 400 `invalid_input` + `details` (AC-7).
  - `route.test.ts:65-72` — negativo: body no-JSON → 400 `invalid_input` (AC-7, valida el `.catch(()=>null)`).
- Mocks razonables (no laxos): `vi.stubEnv("TRANSFI_API_KEY","")` fuerza fallback; `vi.stubGlobal("fetch", …PEN:3.8)`
  provee el mid real mockeado. Cleanup correcto en `afterEach` (unstub globals/envs).
- **Nota (no finding):** el cache módulo-nivel de `getUsdToPenMid` (`fx.ts:73`) hace que los tests 2-5 puedan
  pegarle al cache poblado por el test 1 en lugar de al `fetch` stub; como el valor es siempre 3.8, es
  determinístico y no genera flakiness ni oculta un bug. OK.

## 3. Scaffold — OK

- `package.json` — matchea §W0.1 exacto: puerto 3030 (evita colisión 3010/3020), `type:"module"`, `zod`
  conservado, deps mínimas (`next 14.2.5`, `react/react-dom 18.3.1`) sin `@supabase/*`/`viem`/SDK de pago (CD-2).
- `tsconfig.json` — conserva el **rigor del repo**: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `exactOptionalPropertyTypes:false` + agrega lo de Next (`jsx:preserve`, `plugins:[next]`, `paths @/*`,
  `incremental`). `types:["node"]` **no rompe** el typecheck (verificado EXIT 0).
- `vitest.config.ts` — alias `@ → ./src` correcto (load-bearing); sin él `route.test.ts` no resolvería
  `@/agents/corridor-fx`. `include:["src/**/*.test.ts"]` sigue cubriendo los tests previos.
- `next.config.mjs`, `.gitignore`, `layout.tsx`, `page.tsx` — matchean §W0 exacto, presentación sin lógica.
- **Sin scope drift**: los untracked del repo remittance son exactamente los Scope-IN (route, test, layout, page,
  configs, README). `src/agents/*` y `src/providers/*` intactos (CD-1).

## 4. Manejo de errores + tipos — OK

- `route.ts` sin `any`: `err instanceof Error` narrowing (línea 24). `req:NextRequest`, retorno `NextResponse`.
- `route.test.ts` tipa `body:unknown` en el helper `invoke` — correcto.
- Error handling limpio y de dos capas: 400 estructurado (validación) vs 502 (falla del core/misconfig).
  Los `as any` del código existen solo en `fx.ts:32,84` (fuera de scope, prohibido tocar) — no imputables a esta HU.

## 5. Consistencia (README vs código) — OK

- `README.md:63-92` describe el contrato exacto que implementa `route.ts`: método/path, `{result}` con los 9
  campos exactos (`slug,rate,feeUsd,netDeliveredLocal,localCurrency:PEN,etaMinutes,quoteId,expiresAt,provenance`),
  400 `invalid_input`, 502 `quote_unavailable`, puerto 3030, `provenance:"local-fallback"`. Env vars
  (`FALLBACK_FX_SPREAD_BPS/FLAT_FEE_USD/STATIC_USD_PEN`) coinciden con `fx.ts:10-11,75`.
- `README.md:75-77` aclara correctamente que el patrón `→ receipt EIP-712 →` aplica a agentes con `agent-signer`
  y que etapa 1 lo **omite** — consistente con el fork sin receipt.

---

## Hallazgos

### MENOR-1 — [Test Coverage] Rama 502 (catch) sin test — `route.ts:20-27`
El branch `catch → 502 quote_unavailable` no tiene cobertura. El Story File scopeó explícitamente 5 tests y no
pidió un test de 502, y en modo fallback el core rara vez lanza (hay fallback estático `STATIC_USD_PEN`), por eso
es defensivo. No bloquea.
**Fix sugerido (opcional):** un 6º test con `vi.mock("@/agents/corridor-fx", …)` que haga `runCorridorFx` lanzar,
y asertar `res.status===502` + `error==="quote_unavailable"`. Cierra la única rama sin ejercitar del endpoint.

### MENOR-2 — [Deps/Mantenibilidad] `next@14.2.5` pinneado a un patch viejo — `package.json:16`
14.2.5 (jul-2024) arrastra CVEs corregidos en patches posteriores de la línea 14.2.x (auth-bypass de middleware,
SSRF). La superficie real acá es baja (solo una API route, sin middleware de auth), y el pin fue decisión del
Story File §W0.1, por eso es MENOR y no bloqueante.
**Fix sugerido (opcional):** bumpear a la última `14.2.x` disponible antes del deploy (W3), corriendo
`typecheck`+`test` para confirmar verde. Respetá el pin si hay una DT que lo fije.

### MENOR-3 — [Housekeeping] `tsconfig.tsbuildinfo` no está en `.gitignore` — `.gitignore:1-17`
`incremental:true` (tsconfig.json:19) genera `tsconfig.tsbuildinfo`, que aparece como untracked y no está
excluido. Riesgo de commitear un artefacto de build.
**Fix sugerido:** agregar `*.tsbuildinfo` (o `tsconfig.tsbuildinfo`) al `.gitignore`.

---

## Checks CR (resumen)

| Check | Resultado |
|-------|-----------|
| Fidelidad al Story File / fork cobraya sin receipt | OK |
| Calidad de tests (asserts, mocks, no tautológicos) | OK (MENOR-1 cobertura 502) |
| Scaffold (package/tsconfig/vitest/next.config) | OK |
| Manejo de errores + tipos (sin `any` injustificado) | OK |
| Consistencia README vs código | OK |
| Deps / mantenibilidad | OK (MENOR-2 next patch, MENOR-3 gitignore) |

**Veredicto: APPROVED con MENORes.** Ningún hallazgo bloquea DONE. Los 3 MENORes son mejoras opcionales
(cobertura de rama defensiva, hygiene de deps, gitignore) que pueden entrar ahora o ir al backlog a criterio
del Dev/orquestador. Typecheck verde + 38/38 tests verdes + cero scope drift + fidelidad total al contrato.
