# AR Report — WKH-106 BASE-03 Bazaar Discovery Extension

- **Modo**: AUTO FAST+AR (paralelo con CR)
- **Branch**: `feat/wkh-base-port-v1`
- **Commits**: `b20d731` (W1) · `b2bccea` (W2) · `ded6a36` (W3) · `e5d84d4` (W4)
- **Reviewer**: nexus-adversary
- **Fecha**: 2026-05-19

---

## 1. Veredicto

**APROBADO** — sin BLOQUEANTEs activos.

3 MENORes de observabilidad / refactor opcional. La adaptación del Dev
(no usar middleware Fastify, ver `auto-blindaje.md`) es **funcionalmente
equivalente** al intent del work-item y respeta CD-1/CD-5/CD-6/CD-7. Tests
1039/1039 verdes. Sin scope drift. Sin secrets en logs. Sin `any`. Sin
`ethers`. Sin `--no-verify`.

---

## 2. Tabla BLOQUEANTES

| ID | Categoría | Sev | Archivo:línea | Descripción |
|----|-----------|-----|---------------|-------------|
| — | — | — | — | (ninguno) |

---

## 3. Tabla MENORes

| ID | Categoría | Archivo:línea | Descripción |
|----|-----------|---------------|-------------|
| MNR-1 | Security (obs leak) | `src/services/compose.ts:434` | El log "Base settle facilitator selector" emite el **valor completo** de `CDP_FACILITATOR_URL` (no solo el "URL host pattern" como dice el comentario). Hoy la URL pública (`https://x402.org/facilitator`) NO es secreta, pero si en el futuro algún operador apunta a un endpoint privado con token en query-string, ese token quedaría en stdout. Sugerencia: parsear con `new URL(...)` y loggear solo `host`+`pathname`, no la query. No bloquea — la URL actual es pública y CD-2 mantiene la URL fuera del código. |
| MNR-2 | Type Safety (tightening) | `src/services/compose.ts:421` | `meta = agent.metadata as Record<string, unknown> \| undefined` se repite a lo largo de `compose.ts`. Es consistente con el patrón pre-existente (ver `readCategory()` línea 54-58), por lo cual NO es scope drift, pero un helper `readMetaString(agent, key)` reduciría duplicación. Es deuda técnica pura, queda en backlog. |
| MNR-3 | Test Coverage (gap menor) | `src/lib/cdp-selector.test.ts` | El test "AC-5 base-sepolia con CDP env vacío" cubre `cdpFacilitatorUrl: ''`. Falta el caso `cdpFacilitatorUrl: '   '` (whitespace) — actualmente lo trataría como URL válida (length>0). No es bloqueante porque `process.env.X = '   '` no es un patrón realista y `CD-2` exige la URL desde env (los operadores son developers, no input público). Si se quiere endurecer, agregar `.trim().length > 0`. |

---

## 4. Production-grade audit checklist

| Item | Status | Evidencia |
|------|--------|-----------|
| Co-Authored-By Claude en los 4 commits | ✓ | `git log --grep="WKH-106"` muestra 4 commits, 4 trailers `Co-Authored-By: Claude Opus 4.7` |
| `--no-verify` ausente | ✓ | `git reflog feat/wkh-base-port-v1` — todos los commits pasaron por hooks |
| TypeScript strict (sin `any` explícito) | ✓ | `grep ": any\|<any>\|as any"` en archivos WKH-106 → 0 hits |
| Sin `ethers.js` | ✓ | `grep "ethers"` en `src/lib/cdp-selector.ts`, `src/lib/bazaar.ts`, `src/services/agent-card.ts`, `src/routes/agent-card.ts` → 0 hits. AC respeta CD interno del proyecto (viem-only) |
| Tests reales (no snapshot fake) | ✓ | `bazaar.test.ts` (172 LOC), `cdp-selector.test.ts` (115 LOC), `agent-card.test.ts` +WKH-106 block (155 LOC), `routes/agent-card.test.ts` +Bazaar block (~200 LOC), `compose.test.ts` +5 telemetry tests. Asserts concretos (`expect(card.inputSchema).toEqual(validInputSchema)`, `expect(body.error_code).toBe('BAZAAR_SCHEMA_INVALID')`) |
| Error classes (no strings) | ✓ | `BazaarSchemaError` class con `field` + `details` (`src/lib/bazaar.ts:58-72`) |
| Logging sin verbose / sin secrets | ✓ con MNR-1 | `console.log` único en `compose.ts:434`. NO emite `CDP_API_KEY`. Emite URL pública. Ver MNR-1. |
| Default seguro (opt-out por defecto, CD-1) | ✓ | `isDiscoverable()` exige `=== true` literal (`agent-card.ts:16-18`). Truthy values (`'true'`, `1`, `'yes'`) NO promueven (test `routes/agent-card.test.ts:208-224`) |
| `@x402/extensions` pinned sin caret (CD-3) | ✓ | `package.json:22` → `"@x402/extensions": "2.12.0"` (exacto, sin caret) |
| `npm test` 1039/1039 | ✓ | `Test Files  71 passed (71) · Tests 1039 passed (1039) · Duration 2.05s` |
| `npm audit --omit=dev` clean for WKH-106 | ✓ (con caveat) | 2 vulnerabilidades pre-existentes: `@anthropic-ai/sdk` (moderate, no relacionada con WKH-106) y `fast-uri ≤ 3.1.1` (high). **`fast-uri@3.1.0` es transitiva de fastify@5.8.5 — NO la introdujo `@x402/extensions@2.12.0`**. La nueva dep AGREGA `fast-uri` via su propia chain (`@x402/extensions → ajv@8.18.0 → fast-uri@3.1.0`) pero se deduplicó al mismo 3.1.0 ya presente. WKH-106 NO introdujo el problema. Recomendación: tracker WKH-SEC-XX para `npm audit fix` (out of scope para este AR). |
| AJV strict:false documentado y acotado | ✓ | `bazaar.ts:74-78` — comentario explica que `strict:false` acepta draft-7 y draft-2020-12 declarados por dev del agente. El uso es `ajv.compile()` para validar SHAPE syntactically — no se ejecuta el schema contra inputs no-confiables, descartando prototype pollution via custom keywords. |

---

## 5. AC compliance (7 ACs)

| AC | Status | Evidencia |
|----|--------|-----------|
| **AC-1**: `GET /agents/:slug/agent-card` con `discoverable=true` SHALL incluir `inputSchema`/`outputSchema` | PASS | `src/services/agent-card.ts:107-118` aplica spread condicional. Test `routes/agent-card.test.ts:127-156` verifica 200 + body.inputSchema/outputSchema iguales a los del manifest. |
| **AC-2**: chainKey `base-*` + `CDP_FACILITATOR_URL` set → settle vía CDP | PASS | **Path real (no observability)**: `src/adapters/base/payment.ts:163-170` — la chain de fallback respeta `CDP_FACILITATOR_URL` para el settle real. **Observability**: `src/services/compose.ts:420-435` loggea la decisión. Test `compose.test.ts:1434-1474` afirma `selectorLog.toContain('selected=https://x402.org/facilitator')`. |
| **AC-3**: `discoverable=false` o ausente → response NO incluye schemas | PASS | `isDiscoverable()` requiere `=== true` literal. Tests `agent-card.test.ts:173-206` + `routes/agent-card.test.ts:158-213`. Adaptación legítima del Dev: no hay middleware mount (no era una API real del SDK), pero el AC habla del shape de la response, que se cumple. |
| **AC-4**: manifest `discoverable=true` + schema malformado → reject en load con error msg que identifica el field | PASS | `BazaarSchemaError` con `field: 'inputSchema' \| 'outputSchema'` (`bazaar.ts:58-72`). Route handler mapea a HTTP 422 con `error_code: 'BAZAAR_SCHEMA_INVALID'` (`routes/agent-card.ts:55-65`). Tests `routes/agent-card.test.ts:215-275` verifican que `body.field === 'inputSchema'` o `body.field === 'outputSchema'` según cuál sea inválido. |
| **AC-5**: `CDP_FACILITATOR_URL` ausente → settles Base via wasiai-facilitator path, sin regresión | PASS | `selectFacilitatorUrl()` retorna `agentManifestFacilitatorUrl` o `undefined` cuando `cdpFacilitatorUrl` es undefined/'' (`cdp-selector.ts:60-65`). Adapter Base fall-back chain (`payment.ts:163-170`) usa `WASIAI_FACILITATOR_URL ?? hardcoded` cuando CDP env es absent. Test `compose.test.ts:1476-1516` afirma `selected=<adapter-default>` + `cdpEnvSet=false`. |
| **AC-6**: middleware Bazaar mounted SHALL pasar `inputSchema`/`outputSchema` al constructor | PASS (adaptado) | **API del SDK no expone middleware** (ver `auto-blindaje.md`). La intención del AC era "los schemas llegan al CDP Facilitator". La adaptación: los schemas se serializan en la response de agent-card (path que CDP Facilitator polea), y `buildBazaarDiscoveryExtension()` (`bazaar.ts:178-201`) declara extension descriptor que invoca `declareDiscoveryExtension` del SDK — disponible para futuro mount como ResourceServerExtension. El intent del AC (CDP recibe los schemas tras 1° settle) se cumple via el serializado del card. |
| **AC-7**: chainKey NO-base → selector NO aplica regardless de env (Kite/Avalanche untouched) | PASS | **Defensa en 3 capas**: (1) `selectFacilitatorUrl()` chequea `chainKey.startsWith('base-')` antes de aplicar override (`cdp-selector.ts:53`). (2) `compose.ts:420` envuelve TODO el bloque de telemetry en `if (chainKey?.startsWith('base-'))`. (3) Tests `compose.test.ts:1518-1594` afirman que para Kite (`kite-testnet`) y Avalanche (`avalanche-fuji`), `selectorLog` es `undefined` (no se loggeó). |

---

## 6. Adaptation legitimacy assessment

**Claim del Dev (`auto-blindaje.md`)**: `@x402/extensions/bazaar` NO es un middleware Fastify. Es un set de funciones puras (`declareDiscoveryExtension`, `validateDiscoveryExtension`, `withBazaar`, `bazaarResourceServerExtension`). El work-item asumía mount-middleware approach que no existe en la API real.

**Verificación**:
1. `bazaar.ts:25-33` importa nombres explícitos: `declareDiscoveryExtension`, `validateDiscoveryExtension`, `DiscoveryExtension` y 3 config types. **No** `bazaarMiddleware` ni `fastifyBazaar`. Esto matchea con el shape descrito en auto-blindaje.
2. `routes/agent-card.ts` NO contiene `fastify.register(bazaarMiddleware, ...)` — sólo el handler GET con catch de `BazaarSchemaError`. Esto matchea el plan de adaptación.
3. El work-item DT-4 dice "Bazaar middleware se monta en `src/routes/agent-card.ts` como Fastify plugin condicional". Esto NO se cumple — pero el Dev documentó la desviación en `auto-blindaje.md` con justificación técnica verificable.

**Veredicto**: la adaptación es **legítima y bien documentada**. El AC intent (publicar schemas + Coinbase Bazaar puede indexar) se cumple por otro mecanismo (JSON serialization del agent-card) que es **funcionalmente equivalente** desde la perspectiva del cliente Bazaar. La SDK proporciona el descriptor (`bazaarResourceServerExtension`) que el gateway puede inyectar a futuro si decide ser un x402 resource server. Por ahora, el gateway NO sirve 402 directly — son los agentes los que sirven 402 — por lo que el SDK descriptor queda disponible pero no mounted.

**Recomendación al Architect**: documentar esta desviación como `DT-7` en el SDD (si existe) o levantar una TD-N en backlog ("revisitar mount cuando gateway sirva 402 directly"). No es BLOQUEANTE — es traza histórica.

---

## 7. Regression verification

| Verificación | Status | Evidencia |
|--------------|--------|-----------|
| Avalanche adapter intacto | ✓ | `git diff main feat/wkh-base-port-v1 -- src/adapters/avalanche/` → **0 bytes**. Sin cambios. |
| Kite-Ozone adapter intacto | ✓ | `git diff main feat/wkh-base-port-v1 -- src/adapters/kite-ozone/` → **0 bytes**. Sin cambios. |
| Tests pre-existentes pasan | ✓ | Baseline pre-WKH-104 era 987 tests. Tras WKH-104+WKH-106 son 1039 (+52). Suite verde 100%. |
| Backward compat de AgentCard | ✓ | `inputSchema?` y `outputSchema?` son opcionales en el interface (`types/index.ts:516,521`). Consumers existentes que no entienden los campos los ignoran (`DT-6` non-breaking). Test `agent-card.test.ts:60-141` verifica el shape clásico sin schemas. |
| Compose settle path para Kite/Avalanche unchanged | ✓ | `compose.ts:420` — TODO el bloque WKH-106 está envuelto en `if (chainKey?.startsWith('base-'))`. Para Kite/Avalanche, ese branch NO ejecuta, ni siquiera el log. Tests `compose.test.ts:1518-1594` lo confirman. |
| `agent-card` route schema 422 no introduce drift en happy path 200 | ✓ | `routes/agent-card.test.ts:37-101` test "returns 200 with valid AgentCard for existing agent" sigue verde. Sin cambios al path 200 base. |
| ChainKey union closed (no `'base'` literal) | ✓ | `adapters/types.ts:122-128` — solo `'base-mainnet'` y `'base-sepolia'`. El alias `'base'` se resuelve via `normalizeChainSlug()` ANTES de llegar al selector (`compose.ts:417-419`), eliminando edge cases como `chainKey === 'base'`. |

---

## 8. Categorías clásicas — resumen

| Categoría | Status | Notas |
|-----------|--------|-------|
| 1. Security | OK | AJV `strict:false` documentado y acotado a `compile()` (no `validate(untrustedInput)`), sin prototype pollution exploit. No hardcoded secrets. URL log es pública (ver MNR-1 para futuro). |
| 2. Error Handling | OK | `BazaarSchemaError` con discriminator `field`. Try/catch en route con `instanceof` check + re-throw para errores no-mapped. Sin errores silenciados. |
| 3. Data Integrity | N/A | WKH-106 no toca DB ni concurrent writes. Schema validation es read-only sobre metadata in-memory. |
| 4. Performance | OK | AJV singleton (`_ajv = new Ajv(...)` line 78) — compile cached. `selectFacilitatorUrl` es pure O(1). El log de compose es 1 `console.log` por settle Base — negligible. |
| 5. Integration | OK | `@x402/extensions@2.12.0` pinned exacto. AgentCard backward compat preservada (campos opcionales). No breaks de la `PaymentAdapter` interface (DT-3 cumplido). |
| 6. Type Safety | OK | Sin `any` explícito. Schemas tipados como `Record<string, unknown>` (CD-8). `BazaarDeclareConfig` re-exporta los config types del SDK con discriminator preservado (workaround documentado para `DistributiveOmit` quirk del SDK). |
| 7. Test Coverage | OK | 52 tests nuevos. Cubre AC-1..AC-7 (7/7) + CD-1 truthy guards + happy/edge cases. Mocks no-mentirosos (configs reales, sin stubs vacíos). |
| 8. Scope Drift | OK | Cambios alcanzados: `src/lib/cdp-selector.ts` (NEW), `src/lib/bazaar.ts` (NEW), `src/services/agent-card.ts`, `src/routes/agent-card.ts`, `src/services/compose.ts`, `src/types/index.ts`, `package.json`, `README.md`, `.env.example` + 5 test files. Todo dentro de Scope IN del work-item. |
| 9. Destructive Migrations | N/A | No hay migrations en WKH-106. |
| 10. RPC SECURITY DEFINER | N/A | No hay RPCs nuevas en WKH-106. |
| 11. Cache Invalidation | N/A | WKH-106 no introduce cache. AJV singleton compila schemas, pero esto no es un cache user-scoped (es un compilador stateless por schema único). |

---

## 9. Resumen ejecutivo

WKH-106 implementa correctamente el intent del work-item con **adaptación legítima documentada** (el SDK `@x402/extensions/bazaar` no expone middleware Fastify; el Dev usa el SDK como builder/validator y serializa los schemas en la response del agent-card, que es funcionalmente equivalente). Los 7 ACs se cumplen — para AC-6 la cumplimiento es vía mecanismo alternativo (JSON serialization → CDP polls) en vez de mount directo, documentado en `auto-blindaje.md`.

**Production-grade**:
- 4 commits con `Co-Authored-By` ✓
- Sin `any` ✓
- Sin `ethers` ✓
- Sin `--no-verify` ✓
- Pin exacto `@x402/extensions: 2.12.0` ✓
- 1039/1039 tests verdes ✓
- Sin scope drift ✓
- Sin secrets en logs (URL es pública) ✓
- Defaults seguros (opt-out, literal `=== true` gate) ✓

**Regresión**: 0 cambios en Avalanche/Kite (`git diff` confirma archivos intactos). Path de settle Base no se ejecuta para chains no-Base (defensa en 3 capas).

**Gate**: APROBADO. CR puede correr en paralelo para validación de patrones / consistencia. F4 QA puede arrancar tras CR APROBADO.

**MENORes**: 3 items de observabilidad / refactor opcional. Ninguno bloquea DONE. Se documentan para backlog o se aceptan como deuda técnica controlada.

---

## 10. Artefactos generados

- Este reporte: `doc/sdd/090-wkh-106-bazaar-extension/ar-report.md`
- Próximo paso: el orquestador puede invocar CR (`/nexus-p6-cr WKH-106`) si aún no corrió, o pasar directo a F4 QA si CR ya emitió APROBADO en paralelo.
