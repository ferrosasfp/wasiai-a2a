# DONE Report — WKH-66 [PROD-HARDENING] Production hardening pack for wasiai-x402 MCP

> Pipeline NexusAgil QUALITY AUTO completo
> Branch: feat/071-wkh-66-prod-hardening | Ultimo commit: 0a33d92
> Fecha de cierre: 2026-04-29

---

## Resumen ejecutivo

WKH-66 cierra el lema fundacional del proyecto: "no construimos software para hackathon sino para produccion". Tras WKH-65 el MCP server `wasiai-x402` estaba LIVE en Vercel pero expuesto a 6 caveats operacionales criticos — race condition de overspend contra un operator wallet con $4.74 USDC mainnet finitos, cold-start de ~30s en la primera invocacion, ausencia de monitoreo de balance, bearer rotation sin runbook, y modos de falla sin probar. Esta HU los cierra en 5 waves coordinadas (W0-W5) + 1 fix-pack iteration: 24 archivos nuevos + 5 modificados, 173/173 tests passing (baseline 103), 1 BLQ-ALTO encontrado y resuelto (stale snapshot gate bypass), y 23/23 ACs + 22/22 CDs verificados por QA F4. El sistema queda en modo degradado elegante ante cualquier falla de infra (rate-limit fail-open, balance-gate fail-secure) y listo para operacion mainnet sostenida post-provisioning de Upstash KV + cron-job.org.

---

## Pipeline timeline

| Fase | Sub-agente | Output | Veredicto |
|------|-----------|--------|-----------|
| F0+F1 | nexus-analyst (opus) | work-item.md (23 ACs EARS, 11 DTs, sizing QUALITY firme) | HU_APPROVED |
| F2 | nexus-architect (opus) | sdd.md (860 lineas, 11 DTs, 22 CDs, 5 waves spec'd) | SPEC_APPROVED |
| F2.5 | nexus-architect (opus) | story-WKH-66.md (1055 lineas, W0-W5 detalladas) | READY_FOR_F3 |
| F3 | nexus-dev (opus) | 24 archivos nuevos + 5 modificados, commit 989496e | 168/168 tests |
| AR | nexus-adversary (opus) | 1 BLQ-ALTO + 2 MENORES | BLOQUEANTE |
| CR | nexus-adversary (opus) | 4 MENORES | APROBADO |
| Fix iter 1 | nexus-dev (opus) | commit 0a33d92, +5 tests (168 -> 173) | 173/173 |
| Re-AR | nexus-adversary (opus) | 4/4 fixes verified | APROBADO |
| F4 QA | nexus-qa (sonnet) | 23/23 ACs + 22/22 CDs evidenciados archivo:linea | APROBADO PARA DONE |

---

## ACs cumplidos (23/23)

### W1 — Cold start mitigation

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-W1-1 | PASS | `scripts/setup-cronjob.mjs:33-48` — crea 2 jobs idempotentemente (PATCH si match, PUT si no). Test T-SC-02 (ok 105). |
| AC-W1-2 | PASS | `api/cron/warmup.mjs:66-68` — responde `{ ok:true, warmedAt }` ISO8601. Test T-WM-01 (ok 60). |
| AC-W1-3 | PASS | `src/cron-auth.mjs:47-76` — timingSafeEqual, sin auth → 401, secret faltante → 500. Tests T-WM-02, T-CA-02..05. |
| AC-W1-4 | PASS | `api/cron/warmup.mjs:46-57` — sin fetch(), sin payX402Handler. Test T-WM-04 (ok 63): fetchCalls === 0. |

### W2 — Balance gate + rate-limit

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-W2-1 | PASS | `src/balance-guard.mjs:211-215` — rechaza pre-firma si balanceUsdc < threshold. Tests T-BG-02 (ok 71), T-HTTP-14 (ok 93). |
| AC-W2-2 | PASS | `src/balance-guard.mjs:136-139,203-208` — null KV y RPC down → fail-secure. Tests T-BG-03 (ok 72), T-CH-08 (ok 48). |
| AC-W2-3 | PASS | `src/balance-guard.mjs:219-238` — INCRBY atomico + DECRBY revert CAS. Tests T-BG-04 (ok 73), T-CS-01 (ok). |
| AC-W2-4 | PASS | `api/mcp.mjs:185-193` — try/finally garantiza release en settle ok o fail. Tests T-BG-05..T-BG-07 (ok 74-76). |
| AC-W2-5 | PASS | `api/mcp.mjs:315-345` — rate limit post-auth, pre-config. 429 + Retry-After. Tests T-HTTP-13 (ok 92), T-RL-02 (ok 96). |
| AC-W2-6 | PASS | `src/rate-limit.mjs:36-38` — sha256 trunc 16, key `rl:<16hex>`. Test T-RL-03 (ok 97). |
| AC-W2-7 | PASS | `src/rate-limit.mjs:52` fail-open, `src/balance-guard.mjs:137-139` fail-secure. Tests T-RL-04, T-CH-08, T-CH-09. |

### W3 — Balance monitoring + alerts

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-W3-1 | PASS | `scripts/setup-cronjob.mjs:42-48` — segundo job `wasiai-x402-balance-check` schedule `*/15 * * * *`. Test T-SC-01 (ok 104). |
| AC-W3-2 | PASS | `api/cron/balance-check.mjs:100-143` — snapshot KV TTL 1800s. Test T-BC-01 (ok 97). |
| AC-W3-3 | PASS | `api/cron/balance-check.mjs:146-163` + `src/alerts.mjs:24-31` — POST webhook con body whitelist. Tests T-BC-02 (ok 98), T-AL-02 (ok 2). |
| AC-W3-4 | PASS | `src/alerts.mjs:73-81` — timeout/network → log solo. Tests T-BC-03 (ok 99), T-AL-01 (ok 1). |
| AC-W3-5 | PASS | `src/alerts.mjs:49-55` — warnOnce si no URL configurada. Tests T-AL-04 (ok 4), T-BC-04 (ok). |

### W4 — Bearer rotation + session refresh

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-W4-1 | PASS | `scripts/rotate-bearer.mjs:28-29` — randomBytes(32) a stdout una vez, instrucciones a stderr. Test T-RB-01 (ok 102). |
| AC-W4-2 | PASS | `scripts/rotate-bearer.mjs:20-26` — TTY check, no-TTY → exit 1. Test T-RB-02 (ok 103). |
| AC-W4-3 | PASS | `scripts/refresh-session.mjs:57-63` — tools.length !== 3 → exit 1. Test T-RS-01 (ok 101). |
| AC-W4-4 | PASS | `README.md:238-327` — 8 puntos del runbook: rotate, refresh, webhook, deshabilitar cron, TTL 90d, setup-cronjob, verificar dashboard, desactivar via API. |

### W5 — Chaos + stress

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-W5-1 | PASS | `tests/chaos.test.mjs` — 20 tests T-CH-01..T-CH-20, 18 escenarios requeridos + 2 adicionales. 100% mocks. |
| AC-W5-2 | PASS | `tests/concurrent-stress.test.mjs` — T-CS-01 (10 concurrentes → exactamente 1 pass) + T-CS-02 (regression BLQ-ALTO-1). |
| AC-W5-3 | PASS | `tests/balance-guard.test.mjs` — 12 tests T-BG-01..T-BG-11b. 8 requeridos + 4 adicionales. |
| AC-W5-4 | PASS | `tests/rate-limit.test.mjs` — 6 tests T-RL-01..T-RL-06 cubriendo todos los escenarios del AC. |
| AC-W5-5 | PASS | `npm test` → 173/173 passing, 0 fail, 0 skip. Baseline 103 + 70 nuevos. |

### Cross-cutting

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-X-1 | PASS | `tests/audit-stderr.test.mjs` (ok 6) + T-CH-20 + T-HTTP-11 — PK/bearer/CRON_SECRET nunca en stderr. |
| AC-X-2 | PASS | `.env.example:89-138` — 8 vars documentadas con nombre, obligatoria, formato, ejemplo, default. |
| AC-X-3 | PASS | `package.json:32` — `"@upstash/redis": "^1.34.0"`. Sin `*` ni `latest`. |

---

## Findings y resolucion

### BLQ-ALTO-1 (AR) — Stale KV snapshot defeats balance gate

El guard en `src/balance-guard.mjs` confiaba en cualquier snapshot KV presente sin verificar su edad. El cron escribe TTL Redis de 1800s (anti-OOM), pero si el operator wallet sufria un drain externo entre runs del cron (gap de hasta ~15 min), el gate aprobaba `pay_x402` contra un balance "fantasma". En concurrencia de 10 requests con balance real $0.30 (por debajo del threshold $0.50), el gate podia aprobar calls hasta que el snapshot envejeciera.

Fix aplicado en commit 0a33d92: `SNAPSHOT_FRESH_MS = 30_000` en `balance-guard.mjs:44-48`, validacion `checkedAt` en `balance-guard.mjs:168-169`. Snapshot con edad > 30s cae al RPC real. Test de regression T-CS-02 en `tests/concurrent-stress.test.mjs`: snapshot stale 60s + RPC real $0.30 → 0 calls pasan, ledger 0.

### MENORs resueltos en fix-pack iter 1 (3 de 6)

- **MNR-AR-2 threshold validation**: `parseFloat(env)` sin guard → NaN bypass silencioso. Fix: `Number.isFinite(threshold) && threshold >= 0` en `balance-guard.mjs` y `balance-check.mjs`. Tests T-BG-11 (NaN) y T-BG-11b (negativo).
- **MNR-CR-3 viem singleton**: multiples imports instanciaban viem clients por separado. Fix: factory `src/avax-client.mjs` (1 archivo extra vs spec original de 26).
- **MNR-CR-4 T-CH-11 false positive**: test "KV stale data" chequeaba eviction Redis, no freshness de data. Fix: T-CH-11 usa `checkedAt: 60s atras` con TTL Redis largo, ejercitando la rama de freshness check real.

### MENORs diferidos a backlog

- **MNR-AR-1** BigInt precision loss (`Number()` coercion sobre balanceWei > 2^53) — riesgo en wallets de alto volumen. Diferido a WKH-67 o ticket independiente.
- **MNR-CR-1** `setup-cronjob.mjs` output imprime `nextExecution=unknown` — no critico para demos. Diferido.
- **MNR-CR-2** README placeholder fecha rotacion ("2026-XX-XX") — cosmetic. Diferido.

---

## Metricas finales

| Metrica | Valor |
|---------|-------|
| Archivos creados | 24 (+ 1 en fix-pack: `src/avax-client.mjs`) = 25 total |
| Archivos modificados | 5 (`api/mcp.mjs`, `package.json`, `README.md`, `.env.example`, `tests/http.test.mjs`) |
| LOC nuevas (aprox) | ~3500 codigo + ~2500 tests |
| Tests passing | 173/173 (baseline 103 + 70 nuevos) |
| BLQs encontrados / resueltos | 1 / 1 |
| Fix-pack iterations | 1 de 3 max |
| ACs cumplidos | 23/23 PASS |
| CDs verificados | 22/22 cumplidos (CD-16 excluido del conteo QA por ser informativo) |
| Drift de scope | Ninguno — zero archivos fuera de `mcp-servers/wasiai-x402/` |

---

## CD Verification (spot-check)

| CD | Status |
|----|--------|
| CD-1: NO core modificado | PASS — sign.mjs, auth.mjs, url-validator.mjs, handlers.mjs, config.mjs, log.mjs, index.mjs intactos |
| CD-2: balance fail-secure | PASS — `balance-guard.mjs:137-139` (null KV), `:203-208` (RPC down) |
| CD-3: bearer hash sha256 | PASS — `rate-limit.mjs:36-38` sha256 trunc 16 |
| CD-4: cron timingSafeEqual | PASS — `cron-auth.mjs:67-74` |
| CD-5: webhook timeout 5s | PASS — `alerts.mjs:70` AbortSignal.timeout(5000) |
| CD-6: rotate no-commit | PASS — TTY check + sin writeFile |
| CD-7: tests 100% mocks | PASS — todos usan createKvMock + createRpcMock |
| CD-8: JSON-line logs | PASS — cero console.* en src/ y api/cron/ nuevos |
| CD-9: tests >= 128 | PASS — 173 |
| CD-13: claim TTL <= 60s | PASS — default 30s, guard `> 60s → fail` en `:132-134` |
| CD-14: bearer hash trunc 16 | PASS — `rate-limit.mjs:37` .slice(0,16) |
| CD-15: no token real commiteado | PASS — solo placeholders en .env.example |
| CD-17: no `event:` en payload log | PASS — grep 0 matches |
| CD-18: `redirect:'error'` en todos los fetch nuevos | PASS — alerts.mjs, setup-cronjob.mjs, refresh-session.mjs |

---

## Auto-Blindaje consolidado

Entradas generadas durante F3 y fix-pack iter 1 de WKH-66:

### [2026-04-29 W1] node:crypto module es frozen — no se puede monkey-patch

- **Error**: `Cannot assign to read only property 'timingSafeEqual' of object '[object Module]'` en tests/cron-auth.test.mjs T-CA-05.
- **Causa raiz**: `import * as crypto from 'node:crypto'` retorna Module frozen. No se puede asignar para spy.
- **Fix**: behavioural assertion — same-length-wrong-byte llega a timingSafeEqual y retorna false → 401.
- **Aplicar en**: cualquier test que pretenda spy modulos node:* (crypto, fs, http). Usar DI o behavioural tests, NO mutacion del Module namespace.

### [2026-04-29 W3] orphan setTimeout en fetch mock bloquea test runner 60s

- **Error**: `node --test tests/alerts.test.mjs` tardaba 60s aunque cada test individual era <200ms.
- **Causa raiz**: mock de fetch con setTimeout(60_000) "para que nunca resuelva y dispare abort" — el AbortSignal rechazaba correctamente pero el setTimeout quedaba pendiente y mantenia el event loop vivo.
- **Fix**: capturar handle de setTimeout y clearTimeout() adentro del abort listener.
- **Aplicar en**: cualquier test con setTimeout + abort listener. Patron obligatorio: `clearTimeout(t)` adentro del `addEventListener('abort', ...)`.

### [2026-04-29 fix-pack 1/3] Redis-TTL != data freshness — stale snapshot defeats balance gate (BLQ-ALTO-1)

- **Error**: balance-guard.mjs confiaba en cualquier snapshot presente en KV. Cron escribe TTL Redis 1800s (anti-OOM) pero el SDD prometia freshness 30s.
- **Causa raiz**: confusion entre TTL de eviction de Redis (anti-OOM) y ventana de freshness de la app (anti-stale-decision).
- **Fix**: leer checkedAt, calcular ageMs, solo confiar si `Number.isFinite(ageMs) && 0 <= ageMs <= SNAPSHOT_FRESH_MS (30_000)`. Si excede o no tiene checkedAt → caer al RPC.
- **Aplicar en**: cualquier cache-de-decision donde la TTL del storage sea mas larga que la ventana de validez del dato. Patron: `if (data.timestamp && Date.now() - data.timestamp <= FRESH_MS) trust; else refetch`. NUNCA confiar en el TTL del backend como freshness signal.

### [2026-04-29 fix-pack 1/3] T-CH-11 testing-the-wrong-thing (false positive)

- **Error**: T-CH-11 "KV stale data → re-fetches RPC" pasaba pero NO ejercitaba la logica de freshness check. Mock usaba `expiresAt: _now() - 1` → kv.get() purga entry → code cae al RPC porque "no hay snapshot", NO porque "snapshot es viejo".
- **Causa raiz**: mock interpretaba "stale" como Redis-expired (eviction), cuando el bug era "Redis-fresh, data-stale" (TTL bien, checkedAt viejo).
- **Fix**: T-CH-11 ahora usa `kv.set(key, blob, { ex: 1500 })` con `checkedAt: 60s atras`. Fuerza la rama de freshness check que el bug BLQ-ALTO-1 dejaba sin cobertura.
- **Aplicar en**: todo test cuya pre-condicion incluya "stale"/"old"/"expired" — verificar EXACTAMENTE que semantica testea el mock. Si el code path bajo prueba nunca se ejecuta porque algo upstream cortocircuita, el test pasa por la razon equivocada.

### [2026-04-29 fix-pack 1/3] threshold env not validated → silent gate bypass

- **Error**: parseFloat(process.env...) sin validar. `parseFloat('abc')` → NaN → `NaN < x` es false → gate aprueba. `parseFloat('-1')` → -1 → cualquier balance positivo pasa.
- **Causa raiz**: confianza ciega en env vars + parseFloat silencioso.
- **Fix**: guard `Number.isFinite(threshold) && threshold >= 0` inmediatamente despues del parseFloat. En runWithBalanceGate → fail-secure. En cron → 500 + log estructurado.
- **Aplicar en**: TODA conversion parseFloat/parseInt/Number() desde env vars o input externo. Patron: `const x = Number(raw); if (!Number.isFinite(x) || x < min || x > max) reject(...)`.

---

## Archivos modificados

### Nuevos — src/ (modulos)

- `mcp-servers/wasiai-x402/src/balance-guard.mjs` — balance check + claim atomico KV
- `mcp-servers/wasiai-x402/src/rate-limit.mjs` — sliding window per-bearer-hash
- `mcp-servers/wasiai-x402/src/alerts.mjs` — webhook POST con whitelist body
- `mcp-servers/wasiai-x402/src/kv-client.mjs` — wrapper lazy Upstash Redis
- `mcp-servers/wasiai-x402/src/cron-auth.mjs` — timingSafeEqual para CRON_SECRET
- `mcp-servers/wasiai-x402/src/avax-client.mjs` — viem singleton factory (extraccion de fix-pack)

### Nuevos — api/cron/ (handlers Vercel)

- `mcp-servers/wasiai-x402/api/cron/warmup.mjs` — cold-start mitigation
- `mcp-servers/wasiai-x402/api/cron/balance-check.mjs` — monitoring + alerts

### Nuevos — scripts/ (CLI)

- `mcp-servers/wasiai-x402/scripts/setup-cronjob.mjs` — provisioning idempotente cron-job.org
- `mcp-servers/wasiai-x402/scripts/rotate-bearer.mjs` — generacion de nuevo bearer
- `mcp-servers/wasiai-x402/scripts/refresh-session.mjs` — smoke check endpoint MCP

### Nuevos — tests/

- `mcp-servers/wasiai-x402/tests/_mocks/kv-mock.mjs`
- `mcp-servers/wasiai-x402/tests/_mocks/rpc-mock.mjs`
- `mcp-servers/wasiai-x402/tests/_mocks/cronjob-org-mock.mjs`
- `mcp-servers/wasiai-x402/tests/chaos.test.mjs` (20 tests)
- `mcp-servers/wasiai-x402/tests/concurrent-stress.test.mjs` (2 tests, T-CS-01/02)
- `mcp-servers/wasiai-x402/tests/balance-guard.test.mjs` (12 tests)
- `mcp-servers/wasiai-x402/tests/rate-limit.test.mjs` (6 tests)
- `mcp-servers/wasiai-x402/tests/alerts.test.mjs`
- `mcp-servers/wasiai-x402/tests/audit-stderr.test.mjs`
- `mcp-servers/wasiai-x402/tests/cron-auth.test.mjs`
- `mcp-servers/wasiai-x402/tests/cron-balance-check.test.mjs`
- `mcp-servers/wasiai-x402/tests/cron-warmup.test.mjs`
- `mcp-servers/wasiai-x402/tests/refresh-session.test.mjs`
- `mcp-servers/wasiai-x402/tests/rotate-bearer.test.mjs`
- `mcp-servers/wasiai-x402/tests/setup-cronjob.test.mjs`

### Modificados

- `mcp-servers/wasiai-x402/api/mcp.mjs` — rate-limit + balance-gate integrados
- `mcp-servers/wasiai-x402/package.json` — dep @upstash/redis ^1.34.0
- `mcp-servers/wasiai-x402/README.md` — Operations runbook (seccion 238-327)
- `mcp-servers/wasiai-x402/.env.example` — 8 nuevas vars lineas 89-138
- `mcp-servers/wasiai-x402/tests/http.test.mjs` — tests T-HTTP-13/14 agregados

---

## Post-merge gates pendientes (responsabilidad del operador)

1. **Upstash Redis provisioning**: Vercel dashboard → Storage → Marketplace → Upstash → conectar al proyecto `wasiai-x402-mcp`. Auto-inyecta `KV_REST_API_URL` + `KV_REST_API_TOKEN`.
2. **CRON_SECRET**: `openssl rand -hex 32` → `vercel env add CRON_SECRET production`
3. **MCP_ALERT_WEBHOOK_URL**: opcional (Slack/Discord incoming webhook URL)
4. **Deploy**: `vercel deploy --prod`
5. **Run setup-cronjob.mjs**: `CRONJOB_ORG_API_TOKEN=... MCP_DEPLOY_URL=... CRON_SECRET=... node scripts/setup-cronjob.mjs`
6. **Verify**: cron-job.org dashboard muestra `wasiai-x402-warmup` (*/4) + `wasiai-x402-balance-check` (*/15) activos
7. **Smoke**: `curl -H "Authorization: Bearer $CRON_SECRET" https://wasiai-x402-mcp.vercel.app/api/cron/warmup`

Nota critica: sin Upstash KV provisionado, rate-limit es fail-open (permite requests) y balance-gate es fail-secure (rechaza todos los pay_x402). El sistema NO crashea pero tampoco protege el wallet contra overspend hasta que KV este activo.

---

## Decisiones diferidas a backlog

- **MNR-AR-1 — BigInt precision loss**: `Number(balanceWei)` pierde precision para wallets con > 2^53 wei. Diferido — no afecta al operator actual ($4.74 USDC = ~4.74e6 unidades de 6 decimales = bien dentro de Number.MAX_SAFE_INTEGER). Crear ticket WKH-67 o equivalente cuando el volumen justifique.
- **MNR-CR-1 — setup-cronjob nextExecution=unknown**: output cosmetic. Diferido a proxima iteracion de scripts ops.
- **MNR-CR-2 — README placeholder fecha rotacion**: "2026-XX-XX" debe completarse post-rotacion real. El operador lo actualiza cuando ejecute el runbook.

---

## Lecciones para proximas HUs

1. **Redis TTL != data freshness**: un TTL de eviction largo (anti-OOM) y una ventana de freshness de negocio son conceptos ortogonales. Siempre almacenar `checkedAt`/`timestamp` en el payload y verificarlo en la capa de aplicacion. Nunca confiar en la presencia de la key como seal de frescura.

2. **Mock semantics "stale" necesitan ser exactas**: "stale" puede significar Redis-expired (key borrada) o data-stale (key presente, checkedAt viejo). Si el test usa la semantica equivocada, el code path real nunca se ejecuta y el test pasa por la razon incorrecta. Siempre diff el assertion contra el call-graph antes de marcar un test como "cubre el bug".

3. **parseFloat desde env vars requiere validacion explicita**: parseFloat es silencioso — convierte 'abc' en NaN y '-1' en -1 sin lanzar. Todo parseFloat/parseInt/Number() desde env o input externo debe ser seguido de `Number.isFinite(x) && x >= min && x <= max`. Sin ese guard, misconfiguraciones se convierten en bypasses de seguridad silenciosos.

4. **orphan setTimeout bloquea test runner**: en tests con abort listeners, siempre capturar el handle del setTimeout y llamar clearTimeout() adentro del listener. El AbortSignal rechaza la promesa pero el setTimeout queda pendiente y mantiene el event loop vivo hasta su expiracion.

---

## Referencias

- Jira: https://ferrosasfp.atlassian.net/browse/WKH-66
- Predecesores DONE: WKH-64 (`069-wkh-64-mcp-x402/done-report.md`), WKH-65 (`070-wkh-65-mcp-vercel-deploy/done-report.md`)
- Branch: `feat/071-wkh-66-prod-hardening`
- Commits clave: `989496e` (feat principal F3) → `0a33d92` (fix-pack iter 1)
- Engram: "hack kite — DEMO LIVE: Sonnet 4.6 administrado paga mainnet autonomo cross-chain"
