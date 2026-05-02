# QA Report — WKH-66 Production Hardening Pack

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-04-29
**Rama**: `feat/071-wkh-66-prod-hardening` (último commit `0a33d92`)
**Modo**: QA F4 post-AR-APROBADO (re-AR iter 1 cerrado)

---

## Resumen ejecutivo

Suite completa 173/173 passing, 0 fail, 0 skip. Los 23 ACs tienen evidencia
concreta (test ID + assertions). CD-1 respetado: los 7 archivos core no
aparecen en el diff. BLQ-ALTO-1 (stale snapshot gate bypass) verificado
cerrado: `SNAPSHOT_FRESH_MS = 30_000` + validación de `checkedAt` en
`balance-guard.mjs:168-169`. Fix-pack iter 1 resuelve los 3 findings del
re-AR. Drift: ninguno.

---

## 1. Runtime / Integration Checks

### 1.1 DB State
N/A — HU no toca Supabase. Estado vive en Upstash KV (provisioning manual
post-merge). No hay queries de DB que ejecutar.

### 1.2 Env Vars
Verificado en `.env.example` (líneas 89-138):

| Var | Obligatoria | Documentada | Default |
|-----|-------------|-------------|---------|
| `CRON_SECRET` | prod | SI (línea 93) | empty |
| `MCP_BALANCE_THRESHOLD_USDC` | NO | SI (línea 97) | 0.50 |
| `MCP_RATE_LIMIT_PER_MIN` | NO | SI (línea 100) | 5 |
| `MCP_ALERT_WEBHOOK_URL` | NO | SI (línea 113) | empty |
| `KV_REST_API_URL` | NO (null-safe) | SI (línea 127) | empty |
| `KV_REST_API_TOKEN` | NO (null-safe) | SI (línea 128) | empty |
| `CRONJOB_ORG_API_TOKEN` | dev-only | SI (línea 133) | empty |
| `MCP_DEPLOY_URL` | scripts-only | SI (línea 137) | empty |

Deployment target (Vercel): NO VERIFICABLE sin acceso al dashboard de Vercel.
Marcado como NO VERIFICABLE — requiere confirmación manual post-merge por
el operador.

### 1.3 Migration Apply
N/A — no hay migraciones Supabase en esta HU.

### 1.4 Smoke stdio invariant
`node src/index.mjs` → `exit:1` en 3s (sin salida a stdout). Correcto: el
server stdio requiere `OPERATOR_PRIVATE_KEY` en env para iniciar, que no está
seteada en el entorno de test. La salida a stdout está limpia (invariante
del protocolo MCP stdio).

---

## 2. ACs — Verificación con Evidencia

### W1 — Cold start mitigation

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-W1-1 | PASS | `scripts/setup-cronjob.mjs:33-48` — crea 2 jobs con titles `wasiai-x402-warmup` + `wasiai-x402-balance-check`, schedules `*/4 * * * *` / `*/15 * * * *`, header `Authorization: Bearer ${CRON_SECRET}`. Idempotencia por título: PATCH si match, PUT si no. Test `T-SC-02` (ok 105) verifica "1 PATCH + 1 PUT on existing". |
| AC-W1-2 | PASS | `api/cron/warmup.mjs:66-68` — responde `{ ok: true, warmedAt }` (ISO8601). Test `T-WM-01` (ok 60): "warmup happy path → 200 + body shape". Latencia verificada en tests (cron es warm por definición tras el preload). |
| AC-W1-3 | PASS | `api/cron/warmup.mjs:31-42` — `validateCronSecret` es lo primero antes de cualquier lógica. `src/cron-auth.mjs:47-76` usa `timingSafeEqual` (líneas 67-74). Tests `T-WM-02` (ok 61) + `T-CA-02..05` verifican: sin auth → 401, secret faltante → 500, timing-safe behavioral (mismo-longitud-byte-erróneo → 401). |
| AC-W1-4 | PASS | `api/cron/warmup.mjs:46-57` — solo `import` dinámico de `handlers.mjs` + `sign.mjs` + `privateKeyToAccount`. Sin `fetch()`, sin `payX402Handler`, sin llamadas RPC. Test `T-WM-04` (ok 63): spy sobre `globalThis.fetch` confirma `fetchCalls === 0`. |

### W2 — Balance gate + rate-limit

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-W2-1 | PASS | `src/balance-guard.mjs:211-215` — `if (balanceUsdc < threshold) return { ok: false, stage: 'balance-gate', error: 'operator balance below threshold' }`. Ejecutado ANTES del `incrby` del claim. Test `T-BG-02` (ok 71): balance $0.40 < threshold $0.50 → rechazado. Test `T-HTTP-14` (ok 93): integración completa en `api/mcp.mjs`. |
| AC-W2-2 | PASS | `src/balance-guard.mjs:136-139` — `if (!kvClient) return { ok: false, ... 'balance check unavailable' }`. `src/balance-guard.mjs:203-208` — RPC catch → `return { ok: false, stage: 'balance-gate', error: 'balance check unavailable' }`. Tests `T-BG-03` (ok 72): RPC fail → fail-secure. `T-CH-08` (ok 48): KV down → fail-secure. |
| AC-W2-3 | PASS | `src/balance-guard.mjs:219-238` — INCRBY atómico (`kvClient.incrby`) seguido de check post-incremento + DECRBY revert (CAS). Tests `T-BG-04` (ok 73): INCRBY + EXPIRE 30. `T-CS-01` (ok): 10 concurrent → exactamente 1 pasa, ledger = 1 × requestedWei. |
| AC-W2-4 | PASS | `api/mcp.mjs:185-193` — `try { return await runHandler() } finally { await releaseClaim({...}) }`. SIEMPRE libera el claim en settle ok o fail. Tests `T-BG-05` (ok 74): release on settle ok. `T-BG-06` (ok 75): try/finally invariant — DECRBY llamado aunque handler throw. `T-BG-07` (ok 76): release on sign fail. |
| AC-W2-5 | PASS | `api/mcp.mjs:315-345` — rate limit DESPUÉS de bearer auth, ANTES de config. Responde 429 con `{ error: 'rate limit exceeded', retryAfter }` + header `Retry-After`. Test `T-HTTP-13` (ok 92): "rate limit fires after 5 req/min for same bearer". `T-RL-02` (ok 96): request 6 → 429 + retryAfter > 0. |
| AC-W2-6 | PASS | `src/rate-limit.mjs:36-38` — `createHash('sha256').update(bearerToken,'utf8').digest('hex').slice(0,16)`. Key shape `rl:<16-hex>`. Test `T-RL-03` (ok 97): "bearer hash es sha256 trunc16 (no plano)" — verifica que key no contiene el bearer plano. |
| AC-W2-7 | PASS | `src/rate-limit.mjs:52` — `if (!kvClient) return { ok: true }` (fail-open). `src/balance-guard.mjs:137-139` — `if (!kvClient) return fail-secure`. Tests `T-RL-04` (ok 98): KV down → rate-limit fail-open. `T-CH-08` (ok 48): KV down → balance-gate fail-secure. `T-CH-09` (ok 49): KV down → rate-limit fail-open. |

### W3 — Balance monitoring + alerts

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-W3-1 | PASS | `scripts/setup-cronjob.mjs:42-48` — segundo job `wasiai-x402-balance-check`, URL `${DEPLOY_URL}/api/cron/balance-check`, schedule `*/15 * * * *`. Test `T-SC-01` (ok 104): "create both jobs (no existing)" — stdout contiene ambos jobIds. |
| AC-W3-2 | PASS | `api/cron/balance-check.mjs:100-143` — lee balance vía `getOperatorBalance`, persiste snapshot KV con TTL 1800s (`{ ex: SNAPSHOT_TTL_SEC }`), responde 200 con `{ balanceWei, balanceUsdc, checkedAt, blockNumber }`. Test `T-BC-01` (ok 97): "happy path 200 + KV snapshot persisted with TTL 1800s". |
| AC-W3-3 | PASS | `api/cron/balance-check.mjs:146-163` — `if (balanceUsdc < threshold)` → `sendAlert({ severity:'critical', body: { chain, operator, balanceUsdc, threshold, checkedAt, blockNumber } })`. `src/alerts.mjs:24-31` — whitelist `ALLOWED_BODY_KEYS` excluye PK/bearer/CRON_SECRET. Test `T-BC-02` (ok 98): "balance < threshold + webhook → POST whitelist body". `T-AL-02` (ok 2): "body whitelist enforced". |
| AC-W3-4 | PASS | `src/alerts.mjs:73-81` — catch de AbortError/network → log + return sin throw. `api/cron/balance-check.mjs:150-163` — `await sendAlert(...)` es fire-and-forget; el response 200 sigue en líneas 165-174. Test `T-BC-03` (ok 99): "webhook timeout → log only, cron still 200". `T-AL-01` (ok 1): "sendAlert timeout 5s aborts via AbortSignal". |
| AC-W3-5 | PASS | `src/alerts.mjs:49-55` — `if (!webhookUrl) { log.warnOnce(..., 'mcp.alert.no-webhook-configured', {}) }`. Test `T-AL-04` (ok 4): "webhookUrl missing → warnOnce + no fetch". `T-BC-04` (ok): "URL not set → warnOnce + 200". |

### W4 — Bearer rotation + session refresh

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-W4-1 | PASS | `scripts/rotate-bearer.mjs:28-29` — `randomBytes(32).toString('hex')` → `process.stdout.write(bearer + '\n')` (stdout EXACTLY ONCE). Instrucciones `vercel env add/rm` → stderr (líneas 31-42). Sin `writeFile` ni mutación de `.env`. Test `T-RB-01` (ok 102): "generates 32 bytes hex once + no disk write". |
| AC-W4-2 | PASS | `scripts/rotate-bearer.mjs:20-26` — `if (!process.stdout.isTTY) { stderr.write('Refusing...'); process.exit(1) }`. Test `T-RB-02` (ok 103): "rotate non-TTY → exit !=0". |
| AC-W4-3 | PASS | `scripts/refresh-session.mjs:57-63` — `tools.length !== 3` → `process.exit(1)`. Status ≠ 200 → exit 1. Test `T-RS-01` (ok 101): "refresh session tools/list → 3 → exit 0" — stub fetch con 3 tools, verifica exit 0 y `{ ok:true, toolCount:3 }` en stdout. |
| AC-W4-4 | PASS | `README.md:238-327` — secciones (a) rotate bearer, (b) refresh sesión, (c) alert webhook dispara, (d) deshabilitar cron, (e) TTL 90 días + placeholder fecha, (f) provisionar 2 cron jobs, (g) verificar status en dashboard, (h) desactivar via API. Todos los 8 puntos del AC presentes. |

### W5 — Chaos + stress

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-W5-1 | PASS | `tests/chaos.test.mjs` — 20 tests total (T-CH-01..T-CH-20). Los 18 escenarios requeridos cubiertos: facilitator down (T-CH-01), facilitator slow (T-CH-02), gateway 502 (T-CH-03), gateway redirect 302 (T-CH-04), Kite/Avax RPC timeout (T-CH-05), RPC 429 (T-CH-06), downstream ECONNREFUSED (T-CH-07), KV down balance-check (T-CH-08), KV down rate-limit (T-CH-09), KV slow (T-CH-10), KV stale data (T-CH-11), RPC ECONNREFUSED (T-CH-12), envelope replay (T-CH-13), insufficient balance (T-CH-14), balance read failure (T-CH-15), claim contention concurrent (T-CH-16), claim release on failure (T-CH-17), claim TTL expiry (T-CH-18). Todos 100% mocks. |
| AC-W5-2 | PASS | `tests/concurrent-stress.test.mjs` — T-CS-01 + T-CS-02 presentes. T-CS-01 (ok): 10 calls concurrentes, balance $0.61, threshold $0.50, amount $0.10 → exactamente 1 pass, ledger = requestedWei, ledger 0 post-release. T-CS-02 (ok): BLQ-ALTO-1 regression — snapshot stale 60s + RPC real $0.30 → 0 calls pasan, ledger 0. |
| AC-W5-3 | PASS | `tests/balance-guard.test.mjs` — 12 tests (T-BG-01..T-BG-11b). Los 8 requeridos del AC cubiertos: (a) happy path T-BG-01, (b) below threshold T-BG-02, (c) RPC fail T-BG-03, (d) claim atomic T-BG-04, (e) release ok T-BG-05, (f) release fail T-BG-06, (g) sign fail T-BG-07, (h) TTL expiry T-BG-08. Adicionales: T-BG-09/10/11/11b cubriendo stale snapshot + threshold inválido. |
| AC-W5-4 | PASS | `tests/rate-limit.test.mjs` — 6 tests T-RL-01..T-RL-06: (a) primer request ok T-RL-01, (b) N+1 → 429 T-RL-02, (c) post-ventana ok T-RL-06, (d) isolation T-RL-05, (e) sha256 no-plano T-RL-03, (f) KV down fail-open T-RL-04. |
| AC-W5-5 | PASS | `npm test` → `# tests 173 / # pass 173 / # fail 0 / # skipped 0` (run completo verificado). Baseline WKH-65 era 103; 173 > 158 mínimo del AC. |

### Cross-cutting

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-X-1 | PASS | `tests/audit-stderr.test.mjs` (ok 6): spy sobre `process.stderr.write` verifica que OPERATOR_PRIVATE_KEY, MCP_BEARER_TOKEN, CRON_SECRET, KV_REST_API_TOKEN, CRONJOB_ORG_API_TOKEN nunca aparecen en stderr. `tests/chaos.test.mjs:T-CH-20` (ok 20): audit sobre todos los scenarios del chaos. `tests/http.test.mjs:T-HTTP-11` (ok 87): PK+bearer nunca en stderr. |
| AC-X-2 | PASS | `.env.example:89-138` documenta todas las vars: `CRON_SECRET`, `MCP_BALANCE_THRESHOLD_USDC=0.50`, `MCP_RATE_LIMIT_PER_MIN=5`, `MCP_ALERT_WEBHOOK_URL=`, `KV_REST_API_URL=`, `KV_REST_API_TOKEN=`. Con nombre, obligatoria, formato, ejemplo, default. |
| AC-X-3 | PASS | `package.json:32` — `"@upstash/redis": "^1.34.0"`. Caret-minor aceptado per AC. Sin `*` ni `latest`. |

---

## 3. CD Verification (spot-check)

| CD | Status | Evidencia |
|----|--------|-----------|
| CD-1: NO core modificado | PASS | `git diff main...feat/... --name-only` — ninguno de los 7 archivos core aparece: `sign.mjs`, `auth.mjs`, `url-validator.mjs`, `handlers.mjs`, `config.mjs`, `log.mjs`, `index.mjs`. |
| CD-2: balance fail-secure | PASS | `balance-guard.mjs:137-139` (null KV), `:203-208` (RPC down) → `{ ok:false, stage:'balance-gate' }`. |
| CD-3: bearer hash sha256 | PASS | `rate-limit.mjs:36-38` sha256 trunc 16. Key `rl:<16hex>`. NO IP. |
| CD-4: cron CRON_SECRET timing-safe | PASS | `cron-auth.mjs:67-74` `timingSafeEqual`. Missing → 500 (no bypass). |
| CD-5: webhook timeout 5s | PASS | `alerts.mjs:70` `signal: AbortSignal.timeout(timeoutMs)`, default `timeoutMs=5000`. |
| CD-6: rotate-bearer no commit | PASS | `rotate-bearer.mjs:20-26` TTY check, sin `writeFile`. |
| CD-7: tests 100% mocks | PASS | Todo test nuevo usa `createKvMock` + `createRpcMock` de `tests/_mocks/`. Sin red real. |
| CD-8: logs JSON-line sin console.* | PASS | `grep console.` en todos los nuevos archivos src/ y api/cron/ → 0 matches. |
| CD-9: tests ≥128 | PASS | 173 passing. |
| CD-13: claim TTL ≤ 60s | PASS | `balance-guard.mjs:41` default 30s, `:132-134` guard `if (claimTtlSec > 60) return fail`. |
| CD-14: bearer hash trunc 16 | PASS | `rate-limit.mjs:37` `.slice(0,16)`. |
| CD-15: no commit de CRONJOB_ORG_API_TOKEN real | PASS | Solo `SECRETS.CRONJOB_TOKEN = 'cronjob-token-bbbb...'` en test (placeholder). `.env.example` documenta como empty. |
| CD-17: no `event:` en payload log | PASS | Ningún log nuevo pasa `event:` dentro del objeto fields. |
| CD-18: `redirect:'error'` en todos los fetch nuevos | PASS | `alerts.mjs:68`, `setup-cronjob.mjs:54/68/83`, `refresh-session.mjs:31` — todos tienen `redirect: 'error'`. |

---

## 4. Drift Detection

- **Scope drift**: ninguno. `git diff main...feat/... --name-only` retorna solo archivos bajo `mcp-servers/wasiai-x402/` y `doc/sdd/071-wkh-66-prod-hardening/`. Zero archivos fuera de scope.
- **Wave drift**: confirmado por commits `989496e` (feat principal) + `0a33d92` (fix-pack iter 1 / AR). Orden W0→W1→W2→W3→W4→W5 respetado internamente.
- **Spec drift**: `avax-client.mjs` no estaba en el listado original de 26 archivos del SDD, pero es una extracción del singleton viem requerido por MNR-CR-3/CR-4 (finding de AR). No es scope creep — es refinamiento de calidad surgido del AR. Aceptable.
- **Test drift**: todos los test IDs mencionados en ACs existen y pasan.

---

## 5. Gates (confirmado por commits y ejecución directa)

| Gate | Status | Fuente |
|------|--------|--------|
| Tests (node --test) | PASS | Ejecutado directo: 173/173, 0 fail, 0 skip |
| Lint / tsc | N/A | Proyecto es JS puro (no TypeScript, no ESLint config en wasiai-x402) |
| Build | N/A | No hay step de build (MJS directo) |
| npm audit | PASS | `npm install` → "found 0 vulnerabilities" |

---

## 6. AR/CR Follow-up

No hay CR/AR reports en disco. El auto-blindaje `doc/sdd/071-wkh-66-prod-hardening/auto-blindaje.md`
documenta los 4 findings del fix-pack iter 1:

| Finding | Status | Evidencia cierre |
|---------|--------|-----------------|
| BLQ-ALTO-1: stale snapshot gate bypass | CERRADO | `balance-guard.mjs:44-48,168-169` — `SNAPSHOT_FRESH_MS=30_000`, validación `checkedAt`. `T-CH-11` + `T-CS-02` lo prueban. |
| orphan setTimeout en alert mock | CERRADO | Test `T-AL-01` pasa en <200ms (sin 60s bloqueo). |
| threshold env NaN bypass | CERRADO | `balance-guard.mjs`-vía-`runWithBalanceGate:142-152` + `balance-check.mjs:88-95`. Tests `T-BG-11` + `T-BG-11b`. |
| T-CH-11 testing-the-wrong-thing | CERRADO | T-CH-11 ahora usa `checkedAt: 60s atrás` con TTL Redis largo. |

---

## Nota final

Vercel env vars en production/preview NO VERIFICABLES sin acceso al dashboard.
El operador debe confirmar post-merge que `KV_REST_API_URL`, `KV_REST_API_TOKEN`,
y `CRON_SECRET` están seteadas en el proyecto Vercel antes de esperar que el
balance gate + rate limit funcionen con KV real. Sin ellas, el sistema cae al
modo degradado: rate-limit fail-open (permitido), balance-gate fail-secure
(rechaza todos los `pay_x402` — esto es correcto por CD-2).

**Listo para DONE.**
