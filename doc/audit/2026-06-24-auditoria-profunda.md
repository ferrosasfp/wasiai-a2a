# Auditoría profunda de ingeniería — wasiai-a2a

**Fecha:** 2026-06-24
**Branch:** `fix/117-session-dest-cap`
**Alcance:** todo `src/` (106 archivos fuente, 22.7k LOC; 107 archivos de test, 1.714 tests).
**Método:** 4 auditores paralelos especializados (arquitectura/TS, seguridad money-path, correctitud de negocio, testing) + verificación manual de los hallazgos ALTA. Toda cita es archivo:línea verificada contra el árbol actual.

---

## 0. Baseline objetivo (medido)

| Métrica | Resultado |
|---|---|
| `tsc --noEmit` (strict) | ✅ 0 errores |
| Test suite (`vitest run`) | ✅ 1.714 pass · 10 skip · 0 fail |
| Coverage global | Statements **82.7%** · Branches **75.6%** · Funcs **83.9%** · Lines **84.3%** |
| Biome | ⚠️ 2 archivos con drift de formato + 1 lint fixable |

---

## 1. Veredicto ejecutivo

**El proyecto está a nivel profesional-senior, con holgura.** No es marketing: la separación de capas es estricta y sin violaciones (verificado por grep: `services`/`adapters`/`lib` no importan `routes`/`middleware`), la jerarquía de errores (~40 clases con `code` discriminado, cero `throw` de strings) es de nivel staff, el uso de `any` es prácticamente nulo bajo `strict:true`, y el money-path tiene defensas maduras (ownership guard app-layer completo, débito atómico vía RPC `FOR UPDATE`, anti-replay de depósitos por `UNIQUE`, firma EIP-712 con `timingSafeEqual` + nonce, SSRF guard robusto).

Lo que lo separa del "10/10 que no se equivoca" **no es estilo sino un puñado de defectos concretos de correctitud en unhappy-paths del money-path** — el principal: `/compose` cobra el step-0 y **no lo reembolsa si ese step falla**. Es el tipo de bug que un "súper-pro que no se equivoca" no dejaría pasar, y es la prioridad #1.

**Calificación por dimensión:**

| Dimensión | Nota | Resumen |
|---|---|---|
| Arquitectura / capas | A | Layering impecable; deuda = funciones-monolito grandes |
| TypeScript idiomático | A | `any` ≈ 0; falta activar flags strict extra (`noUncheckedIndexedAccess`) |
| Seguridad money-path | A− | Sin CRÍTICAS explotables; gaps de hardening (replay inbound x402, TOCTOU SSRF) |
| Correctitud de negocio | B+ | 1 bug ALTA real (refund step-0) + riesgos de float/NaN |
| Testing | B | 84% lines pero **branches 75%** y **sin e2e HTTP happy-path** de compose/orchestrate |

---

## 2. Hallazgos consolidados (priorizados)

### 🔴 ALTA — corregir

| # | archivo:línea | Problema | Fix |
|---|---|---|---|
| A1 | `routes/compose.ts:224-238` + `compose.ts:142` | **Step-0 no se reembolsa en fallo.** El middleware debita `composeEstimatedCostUsd` (precio real del step-0). Si el step-0 falla (500/timeout/SSRF), la ruta devuelve el error **sin reembolsar**, y `refundStepDebit` es no-op para `i===0` (guard `i>0`). `orchestrate.ts:644` sí reembolsa → asimetría. **Cobro sin contraprestación reproducible** con un `/compose` de un solo step caído. | Reembolsar `composeEstimatedCostUsd` en la rama `!result.success` cuando el fallo es del step-0 (path a2a-key con débito), usando el destino canónico del step-0. |
| A2 | `compose.ts:340-347` + `:252-282` | **Re-debit del retry adaptativo sin confirmación real de reversión.** El diseño asume `refund1ok ⟹ budget revertido`, pero `creditWithDest` devuelve `success:true` aunque la RPC afecte 0 filas (p.ej. mismatch de destino). Riesgo de doble consumo de dest-cap. | Que las RPC de refund devuelvan filas afectadas; tratar `0 rows` como `success:false` y bloquear el re-debit. |
| A3 | `orchestrate.ts:283` | **`Number(bal)` sin guard de `NaN`.** Un `budget` JSONB con valor no numérico → `Number(bal)` = `NaN`, y `NaN <= 0` es `false` → pasa el early-fail "sin fondos" y avanza a ejecutar/debitar. | `Number.isFinite(Number(bal))`; tratar `NaN` como 0. |

### 🟠 MEDIA — planificar

| # | archivo:línea | Problema | Fix |
|---|---|---|---|
| M1 | `middleware/x402.ts:278-321` | Anti-replay del x402 **inbound** delegado 100% al facilitator externo (sin nonce-store local), a diferencia de depósitos y signed-auth que sí lo tienen. | Tabla `a2a_x402_nonces UNIQUE(network,nonce)` antes de `settle()`. |
| M2 | `url-validator.ts:270` + `discovery.ts:439,535` | TOCTOU / DNS-rebinding: se valida la IP en `dns.lookup` pero `fetch` re-resuelve. Registry endpoints son atacante-influenciables vía POST /registries. | Pinear la IP validada en el `fetch` (agente custom que rechace IPs privadas en connect-time). |
| M3 | `compose.ts:255-271` vs `routes/compose.ts:97` | Refund del dest-cap re-deriva el destino en cada capa; si el string canónico diverge entre débito y refund, el cap del destino real no se libera. | Resolver el destino una vez y propagarlo (como ya se hace con el precio). |
| M4 | `a2a-key.ts:247-900` | `requirePaymentOrA2AKey` ≈ 650 líneas, 3 branches de auth inline. God-function; difícil de testear por branch, alto blast-radius (es el path más sensible). | Extraer `resolveSessionAuth`/`resolveDelegationAuth`/`resolveMasterAuth`. |
| M5 | `budget.ts:322` | La rama master de `debit` devuelve `error.message` crudo de Postgres (info disclosure). Las otras 3 rutas ya lo sanitizan. | Mapear a código estable (`DEBIT_FAILED`); loguear el detalle server-side. |
| M6 | `orchestrate.ts:655-672` | Refund best-effort: si `credit` falla solo se setea flag + log; el caller perdió el dinero y `remainingBudgetUsd` no lo refleja. | Outbox/dead-letter de refunds fallidos para reintento. |
| M7 | `4× producción` (`a2a-key.ts:292`, `compose.ts:156`, `routes/compose.ts:117`, `orchestrate.ts:491`) | Magic number `1.0` ("placeholder fee $1") duplicado; cambiar la política toca 4 archivos. Viola "sin magic numbers". | `export const PLACEHOLDER_FEE_USD` en `lib/price.ts` (o env). |
| M8 | `orchestrate.ts:258` | El protocol fee se cobra sobre `budget` solicitado, no sobre el costo ejecutado → sobre-cobro respecto al valor entregado. | **Confirmar invariante de negocio** (WKH-44); si debe ser sobre costo real, usar `pipeline.totalCostUsdc`. |
| M9 | Supabase rows (budget/identity/key-session/...) | `data as DomainType` sin validación runtime; si el schema deriva el `as` miente y el bug aparece lejos. | Validador fino en bordes críticos o cliente tipado `SupabaseClient<Database>`. |

### 🟡 BAJA — pulido

| # | archivo:línea | Problema |
|---|---|---|
| B1 | `tsconfig.json` | Falta `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noFallthroughCasesInSwitch`, `noImplicitOverride`. |
| B2 | `routes/auth.ts` (1637 líneas) | God-file: ~20 handlers + 12 parsers. Split en `routes/auth/*.ts` por dominio. |
| B3 | `services/*` (`budget`, `fee-charge`, `receipt`) | `console.*` directo vs logger inyectado (observabilidad inconsistente; compose/orchestrate sí threadean logger). |
| B4 | `discovery.ts:556,560` | Dos `catch {}` vacíos sin comentario (resto del archivo sí documenta cada swallow). |
| B5 | `discovery.ts:486` | `Number(undefined)=NaN` en reputation; `NaN ?? 0` no captura NaN → sort por reputación indefinido. |
| B6 | `field-error-parser.ts:164` | `indexOf('required')` matchea cualquier substring → tokens espurios en bodies con "required" fuera de contexto de error. |
| B7 | `compose.ts:614,622` | Hasta 2 `discover({limit:50})` por step (latencia/coste, no correctitud). Cachear por request. |
| B8 | `error-boundary.ts:23` | `err as unknown as AppError` double-assertion; usar narrowing. |
| B9 | `reputation.ts:116` | lint `useLiteralKeys` (FIXABLE por biome). |
| B10 | `field-error-parser.ts`, `auth.ts` | Drift de formato biome (correr `biome format --write`). |
| B11 | `kite-client.test.ts:16` | `vi.mock('viem')` duplicado dentro de función async → warning vitest. |

---

## 3. Lo que está excelente (fortalezas a preservar)

- **Jerarquía de errores** (`security/errors.ts`): ~40 clases con `readonly code` + `name`, `instanceof`-dispatchable. `logOwnershipMismatch` PII-safe con hash SHA-256 truncado.
- **Ownership guard completo**: TODAS las queries mutables/lectoras de `a2a_agent_keys` cruzan `.eq('owner_ref',...)`; firmas exigen `ownerId: string` (no opcional). Los lookups sin owner-gate están justificados (hot-path token-autenticado, no IDOR).
- **Anti-doble-cobro step-0**: guard `i>0` documentado como CD-11 inmutable; orchestrate debita solo step-0 y deja 1..N a compose.
- **Depósito a prueba de fraude**: verificación on-chain de receipt/status/chainId/confirmaciones/token/recipient **y depositor** (anti front-run), monto por BigInt, idempotencia + replay por `UNIQUE(chain_id,tx_hash)`, crédito por monto verificado (nunca `body.amount`).
- **Signed-auth (WKH-123)**: orden timestamp→firma→nonce; EIP-712 `recoverTypedDataAddress`; HMAC `timingSafeEqual`; anti-replay `UNIQUE(token_hash,nonce)`; nunca loguea firmas/nonces.
- **Precisión USDC**: montos on-chain siempre por `BigInt(Math.round(usdc*1e6))*BigInt(1e12)`; float solo para redondear a micro-USD.
- **Resiliencia de discovery**: cada registry en `Promise.all().catch(()=>[])`; SSRF distinguido de errores transitorios; enriquecimiento (identity/reputation) nunca rompe el discover.
- **VM sandbox** para transforms LLM (`node:vm`, timeout 1s, cache L2 scoped por `owner_ref`).
- **Error boundary global**: normaliza errores con `requestId`, oculta stack en prod, propaga `retryAfterMs`/`orchestrationId`.

---

## 4. Testing — estado y plan

**Estado:** 1.714 tests unitarios de alta calidad (nombrados por comportamiento/AC, no tautológicos, cubren scope-denial/SSRF/IDOR/unhappy-paths). **Gap principal:** branches 75% y **no hay e2e HTTP happy-path** de compose/orchestrate — el `e2e.test.ts` usa Supabase mockeado; los `*.real.test.ts` (atomicidad Postgres) están gateados con `skipIf(!ENABLED)` y **no corren en CI normal**.

**Archivos con menor cobertura:** `routes/discover.ts` (48%), `mcp/router.ts` (56%), `routes/orchestrate.ts` (62%), `services/security/errors.ts` (61%, huérfano), `lib/supabase.ts` (56%).

**Plan de tests (priorizado) — se implementa en la fase siguiente:**

- **P0 (integración / e2e HTTP):** compose 2-step con fallo de step-2 → refund y net-debit correcto · compose happy-path con fee 1% · orchestrate planner multi-step con budget tracking · discover con registry remoto 500 → degradación · gate CI para los 4 `.real.test.ts`.
- **P1 (rutas/router):** `routes/discover` (404, filtro, registry caído) · `routes/orchestrate` (catch+requestId, reply.sent) · `mcp/router` (method-not-found, params inválidos).
- **P2 (servicios):** `security/errors` (instanciar cada clase) · `budget` (REFUND_FAILED, ownership sin leak) · `kite-ozone/payment` (facilitator 401/500) · `registry` (upsert falla) · `supabase`/`event`/`llm/*` huérfanos.

---

## 5. Recomendación de cierre

1. **Fix inmediato A1** (refund step-0) — bug de dinero confirmado, fix quirúrgico + test de regresión.
2. **A2/A3** en el mismo lote de hardening del money-path.
3. **M1–M9** como HUs de hardening priorizadas (M8 requiere decisión de negocio, no es bug).
4. **B9/B10/B11** son triviales (biome + un test mock) — limpiar ya.
5. **Subir branches a ≥85%** con el plan de tests P0/P1.

El codebase es sólido y está bien por encima del promedio. Los ALTA son acotados y corregibles; cerrarlos lo lleva a "no se equivoca en el money-path".
