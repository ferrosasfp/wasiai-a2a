# Work Item — [WKH-66] [PROD-HARDENING] Production hardening pack for wasiai-x402 MCP — concurrency + monitoring + chaos tests

> Fase F1 (analyst) — modo AUTO QUALITY. Ticket: https://ferrosasfp.atlassian.net/browse/WKH-66
> Predecesores inmediatos:
>   - `doc/sdd/069-wkh-64-mcp-x402/` (DONE 2026-04-30) — MCP server stdio + handlers
>   - `doc/sdd/070-wkh-65-mcp-vercel-deploy/` (DONE 2026-04-30, commit 9636383) — HTTP transport + Vercel remote deploy live en `https://wasiai-x402-mcp.vercel.app/api/mcp`

## Product Context

[SIN PRODUCT CONTEXT — work-item self-contained, narrativa en CLAUDE.md, HACKATHON-FINAL.md, y description del ticket Jira WKH-66]

## Resumen

Endurecer el MCP server `wasiai-x402` desplegado en Vercel para soportar operación sostenida sin intervención humana en mainnet (Avalanche C-Chain USDC). Tras WKH-65 el endpoint está LIVE pero la auditoría post-deploy detectó 6 caveats que bloquean el lema "no construimos software para hackathon sino para producción": cold-start ~30s en la primera invocación, race condition de overspend en concurrencia (no nonce collision — colisión de balance entre signs concurrentes contra un operator wallet con $4.74 USDC mainnet finitos), monitoreo de balance ausente (76 demos restantes y sin alerta), bearer/session rotation no documentada, modos de falla no probados (Railway facilitator, Kite RPC, Avalanche RPC, downstream agent), y stress concurrente no verificado. El alcance se descompone en 5 waves coordinadas dentro de `mcp-servers/wasiai-x402/` SIN tocar el core (`src/{sign,auth,url-validator,handlers,config,log}.mjs`): W1 cold-start mitigation (Vercel Cron warmup), W2 balance gate + per-bearer rate limit (Vercel KV), W3 operator balance monitoring + alerts webhook (cron 15 min), W4 bearer rotation + session refresh runbook (scripts + docs), W5 chaos tests + failure-mode verification (~25 tests).

## Sizing

- **SDD_MODE**: full (QUALITY) — toca payment path con guards de seguridad nuevos (balance fail-secure), introduce dep externa (Vercel KV / Upstash Redis), 5 waves coordinadas con dependencias entre módulos compartidos, y nuevos cron endpoints autenticados que extienden la superficie pública.
- **Estimación**: L (15+ archivos nuevos/modificados, dep externa nueva, ~25 tests adicionales, 5 waves)
- **Pipeline**: QUALITY confirmado (humano declaró QUALITY, no se baja)
- **Branch sugerido**: `feat/071-wkh-66-prod-hardening` desde `main@7b9fc7d`
- **Skills router**: (1) `vercel-serverless` (Cron + KV provisioning + function lifecycle), (2) `payment-rails-hardening` (balance race, fail-secure, circuit-breaker, alert webhook)

### Veredicto sizing — QUALITY confirmado

**Argumentos a favor de mantener QUALITY (no bajar a FAST+AR):**

1. **Toca payment path con guard nuevo de seguridad**: el balance gate (W2) introduce un nuevo invariant ("never sign if estimated post-spend balance < threshold"). Una regresión convierte el operator wallet en un drain primitive — exactamente la clase de bug que SEC-DRAIN-1 / WKH-59 cerró server-side. AR debe atacar el orden de operaciones balance-check → sign → settle.
2. **Dep externa nueva con failure modes propios**: Vercel KV (Upstash Redis under the hood) puede estar caído, slow, o devolver datos stale. CD-2 fail-secure es crítico — una mala implementación rompe demos completos.
3. **Concurrencia real**: la HU explícitamente quiere soportar demos concurrentes. El balance gate y el rate limit DEBEN ser correctos bajo carga. Tests de stress concurrente (W5) son obligatorios.
4. **5 waves coordinadas**: hay dependencias claras (W2 require KV setup, W3 reusa balance lectura, W5 tests cross-cutting). Sin SDD formal el orden de implementación no se autodocumenta.
5. **Nuevos endpoints públicos autenticados**: `/api/cron/warmup` y `/api/cron/balance-check` extienden la superficie de ataque. CRON_SECRET mal validado = nuevo auth bypass.
6. **Alert webhook = canal de exfiltración potencial**: si se filtra info sensible (PK, bearer, balance hex) en el body POST, leaks a un endpoint atacante.

**Argumentos a favor de bajar (descartados):**
- "El core no se toca" — cierto, pero las nuevas piezas se montan EN el flow de pago. La resiliencia del wrap importa tanto como la del wrappee.
- "Tests cubren bien" — los tests son OUTPUT del trabajo, no sustituto de la revisión arquitectónica de un nuevo guard de seguridad.

**Veredicto: QUALITY firme.**

---

## Verificación @vercel/kv (DT-A — F0)

**Hallazgo**: `@vercel/kv` (npm package) sigue publicado pero **deprecado en favor de la integración Vercel Marketplace + `@upstash/redis`** desde mid-2024. La Vercel KV "classic" se discontinuó como producto first-party; el provisioning ahora es: Vercel Marketplace → Upstash → Redis instance → env vars `KV_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN` inyectadas en el proyecto.

**Compatibilidad Node 22.x + Vercel Functions**:
- `@vercel/kv` v3.x requiere Node ≥18, compatible con Node 22.x serverless. PERO depende del backend Upstash y duplica una capa de wrapper.
- `@upstash/redis` v1.x es REST-based (HTTP fetch only), 100% Edge/Node compatible, sin deps nativas — encaja mejor en Vercel Serverless stateless. Recomendado por Vercel docs (post-2024) para nuevas integraciones.

**Decisión propuesta para F2 (Architect)**:
- DT-A actualizado: usar **`@upstash/redis`** directo (REST API) como dep — más simple, más estable, alineado con la dirección oficial Vercel post-2024. `@vercel/kv` es un wrapper innecesario.
- Provisioning: Vercel dashboard → "Storage" → Upstash KV → conectar a proyecto `wasiai-x402-mcp`. Las env vars `KV_REST_API_URL` + `KV_REST_API_TOKEN` se inyectan automáticamente.
- Fallback si Upstash no está disponible en el plan actual: documentar como bloqueante en F2 (el hackathon corre en Vercel Hobby — verificar si el free tier de Upstash incluye plan suficiente para nuestro volumen, ~10k ops/mes para warmup + balance check + rate limit).

**Estado: VERIFICADO en F0, propuesta de cambio DT-A documentada para F2.**

> **Plan Vercel verificado en F0**: `hobby` (active). Confirmado: `*/4` y `*/15` cron schedules NO funcionan en Hobby (mínimo 1/día). **Decisión humano**: Opción B — usar cron externo cron-job.org en vez de Vercel Cron.

---

## Acceptance Criteria (EARS)

### W1 — Cold start mitigation (warmup cron)

- **AC-W1-1** (UPDATE Opción B): WHERE existe `scripts/setup-cronjob.mjs` y se ejecuta con `CRONJOB_ORG_API_TOKEN` válido + `MCP_DEPLOY_URL` apuntando al endpoint Vercel + `CRON_SECRET` configurado, the system SHALL crear (o actualizar idempotentemente) un cron job en cron-job.org con: title=`wasiai-x402-warmup`, url=`<MCP_DEPLOY_URL>/api/cron/warmup`, schedule `*/4 * * * *`, requestMethod GET, headers `Authorization: Bearer <CRON_SECRET>`. SHALL imprimir el `jobId` retornado por cron-job.org API a stdout.
- **AC-W1-2**: WHEN GET `/api/cron/warmup` se invoca con header `Authorization: Bearer <CRON_SECRET>`, the system SHALL responder 200 con body `{ ok: true, warmedAt: <iso8601> }` en ≤2s p95 después de la primera invocación caliente.
- **AC-W1-3**: IF GET `/api/cron/warmup` se invoca SIN `Authorization: Bearer <CRON_SECRET>`, THEN the system SHALL responder 401 con `{ error: "unauthorized" }` ANTES de cualquier procesamiento. La verificación SHALL ser timing-safe (`node:crypto.timingSafeEqual`).
- **AC-W1-4**: WHILE el handler de warmup corre, the system SHALL pre-cargar los módulos críticos (`src/handlers.mjs`, `src/sign.mjs`, viem account derivation) para que la siguiente invocación del MCP encuentre el módulo ya en memoria. SHALL NOT firmar ninguna transacción ni hacer fetch al gateway real.

### W2 — Balance gate + per-bearer rate limit

- **AC-W2-1**: WHEN `pay_x402` se invoca y la balance del operator wallet (consultada vía RPC Avalanche C-Chain mainnet) es **menor que** `MCP_BALANCE_THRESHOLD_USDC` (default `0.50` USDC en wei equivalente), the system SHALL rechazar con `{ ok: false, stage: "balance-gate", error: "operator balance below threshold" }` ANTES de firmar el envelope.
- **AC-W2-2**: IF la lectura de balance falla (RPC down, timeout, KV down si se cachea), THEN the system SHALL **fail-secure**: rechazar el `pay_x402` con `{ ok: false, stage: "balance-gate", error: "balance check unavailable" }`. PROHIBIDO permitir el pago si no se puede verificar la balance (CD-2).
- **AC-W2-3**: WHILE concurrent `pay_x402` requests están en vuelo, the system SHALL serializar la decisión balance-check + sign mediante un **claim atómico en KV** (key `balance-claim:<chain>:<operator>`, TTL 30s, INCRBY del monto comprometido). SHALL rechazar la N-ésima request si `claimed + requested > balance - threshold`.
- **AC-W2-4**: WHEN `pay_x402` completa exitosamente (`stage: settled`), the system SHALL liberar el claim KV (`DECRBY` del monto). IF el settle falla, THEN the system SHALL liberar el claim igualmente para que el próximo request no quede bloqueado por un claim huérfano.
- **AC-W2-5**: WHEN cualquier tool (`discover_agents`, `get_payment_quote`, `pay_x402`) se invoca, the system SHALL aplicar rate limit per-bearer-hash con default `MCP_RATE_LIMIT_PER_MIN=5` (sliding window 60s, KV-backed). IF se excede, THEN the system SHALL responder 429 con `{ error: "rate limit exceeded", retryAfter: <seconds> }`.
- **AC-W2-6**: WHILE el rate limit consulta KV, the system SHALL hashear el bearer presentado con `node:crypto.createHash('sha256')` ANTES de usarlo como key. PROHIBIDO usar el bearer plano como key KV (CD-3).
- **AC-W2-7**: IF KV está down al momento del rate limit lookup, THEN the system SHALL **fail-open** para rate limit (permitir la request — no bloquear servicio por infra accesoria) PERO **fail-secure** para balance gate (rechazar — pérdida de plata es worse than DoS).

### W3 — Operator balance monitoring + alerts webhook

- **AC-W3-1** (UPDATE Opción B): WHERE `scripts/setup-cronjob.mjs` se ejecuta, the system SHALL crear/actualizar idempotentemente un segundo cron job con: title=`wasiai-x402-balance-check`, url=`<MCP_DEPLOY_URL>/api/cron/balance-check`, schedule `*/15 * * * *`, headers `Authorization: Bearer <CRON_SECRET>`. SHALL imprimir el `jobId`.
- **AC-W3-2**: WHEN GET `/api/cron/balance-check` se invoca con `Authorization: Bearer <CRON_SECRET>` válido, the system SHALL leer la balance USDC del operator en Avalanche C-Chain mainnet, persistir un snapshot en KV (`balance-snapshot:<chain>:<operator>`, TTL 30 min) con `{ balanceWei, balanceUsdc, checkedAt, blockNumber }`, y responder 200 con ese mismo body.
- **AC-W3-3**: IF la balance leída es **menor que** `MCP_BALANCE_THRESHOLD_USDC` Y `MCP_ALERT_WEBHOOK_URL` está seteada, THEN the system SHALL hacer POST al webhook con body `{ severity: "critical", chain: "avalanche-c-chain-mainnet", operator: <0xAddr>, balanceUsdc: <num>, threshold: <num>, checkedAt: <iso8601> }`. Timeout del webhook SHALL ser 5s (CD-5). PROHIBIDO incluir PK ni bearer en el body.
- **AC-W3-4**: WHEN el webhook POST falla (timeout, 4xx, 5xx, DNS error), the system SHALL loggear `mcp.alert.webhook-failed` con stage + status pero NO SHALL fallar la cron — el cron-balance-check sigue siendo 200 para que Vercel no marque el cron como failing repetido.
- **AC-W3-5**: IF `MCP_ALERT_WEBHOOK_URL` no está configurada, THEN the system SHALL log-only (warn structured `mcp.alert.no-webhook-configured` una vez por instancia, helpered por `log.warnOnce`).

### W4 — Bearer rotation + session refresh runbook

- **AC-W4-1**: WHERE existe `scripts/rotate-bearer.mjs`, the system SHALL: (a) generar un nuevo bearer con `crypto.randomBytes(32).toString('hex')`, (b) imprimir el nuevo bearer a stdout EXACTAMENTE UNA VEZ, (c) NO escribirlo a disco, (d) NO commitearlo, (e) imprimir a stderr las instrucciones para `vercel env add MCP_BEARER_TOKEN` y `vercel env rm MCP_BEARER_TOKEN` del valor anterior.
- **AC-W4-2**: WHILE `scripts/rotate-bearer.mjs` corre, the system SHALL fallar con exit-code != 0 si detecta que stdout está siendo redirigido a un archivo trackeado por git (best-effort: chequea `process.stdout.isTTY === true`).
- **AC-W4-3**: WHERE existe `scripts/refresh-session.mjs`, the system SHALL invocar `tools/list` contra el endpoint `/api/mcp` con el bearer corriente (leído de env local, no commiteable) y reportar `{ ok: true, toolCount: 3 }` en stdout. SHALL fallar con exit != 0 si tools.length !== 3 o si el endpoint responde !=200.
- **AC-W4-4**: WHEN `README.md` se actualiza con la sección **"Operations runbook"**, the system SHALL incluir: (a) cómo rotar el bearer (`node scripts/rotate-bearer.mjs`), (b) cómo refrescar la sesión MCP (`node scripts/refresh-session.mjs`), (c) qué hacer si el alert webhook dispara (rellenar operator wallet, link a faucet/exchange), (d) cómo deshabilitar el cron temporariamente (eliminar entry de `vercel.json` + redeploy), (e) el TTL del bearer recomendado (90 días) y la fecha de la última rotación, (f) cómo ejecutar `node scripts/setup-cronjob.mjs` para provisionar los 2 cron jobs en cron-job.org, (g) cómo verificar status de los jobs en https://cron-job.org dashboard, (h) cómo desactivar temporariamente los jobs (POST `/jobs/{id}` con `enabled: false`).

### W5 — Chaos tests + failure-mode verification

- **AC-W5-1**: WHERE existe `tests/chaos.test.mjs`, the system SHALL incluir mínimo 18 escenarios cubriendo: facilitator down (5xx), facilitator slow (>30s), gateway 502, gateway redirect 302 (verifica que `redirect:'error'` BLQ-iter3-1 sigue activo), Kite RPC timeout, Avalanche RPC rate-limit (429), downstream agent crash, KV down (balance-check + rate-limit), KV slow, KV stale data, partial network partition (DNS resolve OK pero connection refused), envelope replay (mismo nonce), insufficient balance, balance read failure, claim contention (concurrent), claim release on failure, claim TTL expiry, alert webhook timeout. TODOS los escenarios SHALL usar mocks 100% — PROHIBIDO mainnet, PROHIBIDO operator wallet real (CD-7).
- **AC-W5-2**: WHERE existe `tests/concurrent-stress.test.mjs`, the system SHALL incluir un test que dispare 10 invocaciones concurrentes a `pay_x402` contra el handler con balance mocked en `$0.51 USDC` y `requested = $0.10` per call, threshold `$0.50`, y verificar que: (a) exactamente la cantidad esperada de calls pasa el balance gate (claimed_total <= balance - threshold), (b) las restantes son rechazadas con `stage: balance-gate`, (c) NO hay double-spend (cada call que pasó el gate aparece exactamente una vez en el ledger del mock).
- **AC-W5-3**: WHERE existe `tests/balance-guard.test.mjs`, the system SHALL incluir tests de: (a) balance > threshold + amount → permite, (b) balance < threshold → rechaza pre-firma, (c) balance read fails → rechaza fail-secure, (d) claim atomic (CAS ok), (e) claim release on settle ok, (f) claim release on settle fail, (g) claim release on sign fail, (h) claim TTL expiry libera huérfanos.
- **AC-W5-4**: WHERE existe `tests/rate-limit.test.mjs`, the system SHALL incluir tests de: (a) primer request OK, (b) request N+1 dentro de la ventana → 429, (c) request post-ventana → OK, (d) bearers diferentes no se afectan (key isolation), (e) bearer hash es sha256 (no plano), (f) KV down → fail-open (permite request).
- **AC-W5-5**: WHEN `npm test` corre, the system SHALL ejecutar la suite completa con baseline 103 (WKH-65) + nuevos chaos suite (~25 más) y SHALL pasar 100% (≥128 tests, 0 fail, 0 skip).

### Cross-cutting (todas las waves)

- **AC-X-1**: WHILE cualquier nuevo handler `/api/cron/*` corre, the system SHALL NEVER loggear `OPERATOR_PRIVATE_KEY`, `MCP_BEARER_TOKEN`, `CRON_SECRET`, `KV_REST_API_TOKEN`, ni `MCP_ALERT_WEBHOOK_URL` (la URL puede contener tokens en query). Los tests SHALL cubrir este invariant con spy sobre `process.stderr.write` (mismo patrón que WKH-65 AC-8).
- **AC-X-2**: WHEN `.env.example` se actualiza, the system SHALL documentar todas las nuevas env vars con: nombre, obligatoria=sí/no, formato, ejemplo redactado, default. Vars: `CRON_SECRET`, `MCP_BALANCE_THRESHOLD_USDC`, `MCP_RATE_LIMIT_PER_MIN`, `MCP_ALERT_WEBHOOK_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`.
- **AC-X-3**: WHEN `package.json` se actualiza, the system SHALL declarar la nueva dep (`@upstash/redis` recomendado, ver DT-A) con versión pineada (ej. `^1.34.0`). PROHIBIDO `*` o `latest`.

---

## Scope IN

Todo dentro de `mcp-servers/wasiai-x402/`:

1. `package.json` (modificar) — agregar dep `@upstash/redis` (ver DT-A). Posible script `test:chaos`, `test:stress`, `test:balance-guard`, `test:rate-limit`. Posible script `rotate:bearer` y `refresh:session`.
2. `api/cron/warmup.mjs` (nuevo) — handler GET con CRON_SECRET auth + module preload.
3. `api/cron/balance-check.mjs` (nuevo) — handler GET con CRON_SECRET auth + RPC balance read + KV snapshot + alert webhook si threshold cruzado.
4. `src/balance-guard.mjs` (nuevo) — `checkBalanceWithClaim({operator, chain, requestedWei, threshold, kvClient})` retorna `{ ok, claimId }`; `releaseClaim(claimId)`. Encapsula la lectura RPC + claim KV atómico.
5. `src/rate-limit.mjs` (nuevo) — `checkRateLimit({bearerHash, kvClient, perMin})` retorna `{ ok, retryAfter }`. Sliding window. Fail-open si KV down.
6. `src/alerts.mjs` (nuevo, opcional pero recomendado) — `sendAlert({severity, body, webhookUrl, timeoutMs=5000})`. POST con AbortSignal.timeout. NO retries (cron retry covers it).
7. `src/kv-client.mjs` (nuevo) — wrapper liviano de `@upstash/redis` con `getClient()` lazy + null-safe en tests (mockeable).
8. `src/cron-auth.mjs` (nuevo) — `validateCronSecret(authHeader)` con `timingSafeEqual` (mismo patrón que `src/auth.mjs`).
9. `api/mcp.mjs` (modificar) — integrar `checkRateLimit` antes del dispatch de `tools/call`, integrar `checkBalanceWithClaim` específicamente en el path `pay_x402` (vía wrapping del handler o pre-flight en el switch). PROHIBIDO modificar `src/handlers.mjs` (CD-1).
10. `scripts/rotate-bearer.mjs` (nuevo) — script CLI para generar+imprimir nuevo bearer.
11. `scripts/refresh-session.mjs` (nuevo) — smoke check del endpoint MCP.
12. `mcp-servers/wasiai-x402/scripts/setup-cronjob.mjs` (nuevo) — provisioning idempotente de los 2 cron jobs externos via cron-job.org API. Lee `CRONJOB_ORG_API_TOKEN` + `MCP_DEPLOY_URL` + `CRON_SECRET` de env. Si los jobs ya existen (match by title), update; sino, create. Imprime `jobId` + `nextExecution` per job.
13. `tests/chaos.test.mjs` (nuevo) — ≥18 escenarios.
14. `tests/concurrent-stress.test.mjs` (nuevo) — stress concurrente con balance mocked.
15. `tests/balance-guard.test.mjs` (nuevo) — unit tests del guard.
16. `tests/rate-limit.test.mjs` (nuevo) — unit tests del rate limit.
17. `README.md` (modificar) — sección "Operations runbook".
18. `.env.example` (modificar) — nuevas vars.

> **Nota Opción B**: `vercel.json` queda igual que en WKH-65 (solo `functions[api/mcp.mjs].maxDuration: 60`). NO se agrega `crons` array — el cron lo dispara cron-job.org externo.

## Scope OUT

- **NO modificar el core**: `src/sign.mjs`, `src/url-validator.mjs`, `src/handlers.mjs`, `src/config.mjs`, `src/log.mjs`, `src/auth.mjs`, `src/index.mjs` quedan intactos. Si una integración demanda cambio del core, se vuelve a F2 con justificación.
- NO modificar `src/` del repo principal (`wasiai-a2a/src/`).
- NO modificar `app.wasiai.io` ni `wasiai-v2`.
- NO publicar a npm.
- NO Edge Runtime para los nuevos endpoints (heredamos DT-B de WKH-65: Node.js Serverless por `node:crypto.timingSafeEqual` + Buffer).
- NO automatizar la rotación del bearer (W4 es manual + runbook — el script SOLO genera, NO escribe a Vercel).
- NO mover el balance check a Edge Functions ni a websocket — cron HTTP es suficiente.
- NO agregar autenticación mutual TLS, x-a2a-key, ni JWT en esta HU — bearer + CRON_SECRET (timing-safe) son los únicos esquemas.
- NO cambiar el formato del envelope x402 ni los handlers.
- NO añadir métricas Prometheus / Grafana / Datadog SDK — el alert webhook es genérico POST JSON (compat Slack/Discord/Datadog webhook) por DT-E.
- NO retries automáticos en `src/alerts.mjs` (la cron de 15 min es el retry natural).
- NO aumentar `maxDuration` por encima de 60s — si las nuevas guards ralentizan el flow más de eso, se trata como bug de performance en F3 antes de aumentar timeout.
- NO ampliar el plan Vercel de Hobby a Pro en esta HU (si Upstash free no alcanza el volumen, se documenta como bloqueante en F2 — NO se decide unilateralmente cambiar de plan, requiere gate humano).

---

## Decisiones técnicas (DT-N)

- **DT-A** [PROPUESTA — VERIFICACIÓN F0]: KV provider = **`@upstash/redis`** directo (REST API), NO `@vercel/kv`. Justificación: post-2024 Vercel KV "classic" se discontinuó; el provisioning actual es Vercel Marketplace → Upstash. Usar `@upstash/redis` directo elimina una capa de wrapper y es la dirección oficial. Architect debe confirmar en F2 que el plan Vercel Hobby + Upstash free tier alcanza el volumen estimado (~10k ops/mes: warmup 360/día, balance-check 96/día, rate-limit ~50-200/día durante demo). Si no alcanza, documentar como bloqueante para gate humano.
- **DT-B** [HEREDADO de WKH-65]: Vercel runtime Node.js Serverless (no Edge). Confirmed para los nuevos endpoints `/api/cron/*` (necesitan timing-safe compare).
- **DT-C** [RESUELTO HUMANO 2026-04-30 — Opción B]: Cron NO via Vercel (Hobby plan limit). Usar **cron-job.org externo** (free tier, API token suministrado por humano, guardado en `/tmp/wkh66-cronjob-token.txt` durante la sesión). Cron-job.org dispara HTTP GET a los endpoints `/api/cron/*` con header `Authorization: Bearer <CRON_SECRET>`. Schedules: warmup `*/4 * * * *`, balance-check `*/15 * * * *` (cron-job.org soporta granularidad por-minuto en free tier).
- **DT-D** [CONFIRMADO]: Circuit breaker threshold = `$0.50 USDC` mainnet via env `MCP_BALANCE_THRESHOLD_USDC`. Si la balance baja de eso, ningún `pay_x402` se firma. Default conservador para hackathon-grade ($4.74 inicial / $0.50 threshold = 9 demos de buffer antes del cutoff).
- **DT-E** [CONFIRMADO]: Rate limit = 5 req/min per bearer hash via env `MCP_RATE_LIMIT_PER_MIN`. Sliding window. Bearer hash con `sha256` (no plano).
- **DT-F** [CONFIRMADO]: Alert webhook = generic POST JSON (Slack incoming webhook compat, Discord webhook compat, Datadog event POST compat). Timeout 5s, no retries en sender. Body shape definido en AC-W3-3 — sin PK, sin bearer.
- **DT-G** [NUEVO F0 — Opción B]: Provisioning automatizado vía cron-job.org API. Architect F2 decide entre:
  - (a) Script `scripts/setup-cronjob.mjs` que usa `https://api.cron-job.org/jobs` para crear los 2 jobs (PUT /jobs con body `{job: {url, title, schedule, requestMethod, auth}}`).
  - (b) Setup manual documentado en runbook (más simple, menos automatización).
  Recomendación analyst: **(a)** — alineado con lema "production grade". El token cron-job.org va en env var `CRONJOB_ORG_API_TOKEN` (NO commit, solo dev local + Vercel env si el script se corre desde un cron interno).
- **DT-H** [NUEVO — para F2]: ¿El balance gate consulta RPC en CADA `pay_x402` o usa el snapshot de la cron de 15 min? Trade-off: consultar en cada request agrega ~500-2000ms de latencia y es dependencia dura del RPC para el flow de pago. Usar snapshot es rápido pero stale (gap hasta 15 min — durante el cual pueden ocurrir 75 demos consecutivos). **Propuesta inicial**: lectura RPC sincrónica EN cada `pay_x402` con cache KV TTL 30s para amortizar requests bursty. Architect debe decidir el TTL exacto. Bloqueo si latencia adicional excede budget de UX.
- **DT-I** [NUEVO — para F2]: Atomic claim en KV — usar Redis script Lua o INCRBY/DECRBY con TTL? Lua garantiza atomicidad pero requiere Upstash plan que soporte EVAL (tier free de Upstash sí soporta). INCRBY+DECRBY+EXPIRE es suficiente si la lectura del balance también usa el mismo cliente. Decisión: Architect en F2.
- **DT-J** [NUEVO]: ¿`api/mcp.mjs` aplica el rate limit ANTES o DESPUÉS del bearer auth? Decisión: **ANTES del config validation, DESPUÉS del bearer auth**. Razón: rate limit no debe consumir slots para callers no autenticados (DoS sobre el rate limiter mismo); pero debe ejecutarse antes de la lectura de balance (que es costosa). Orden propuesto: CORS → method gate → bearer auth → rate limit → config → tool dispatch (con balance-gate dentro del switch para `pay_x402`).
- **DT-K** [NUEVO]: ¿Los tests de chaos requieren un `kv-mock.mjs`? Sí — Architect define la interfaz mock en F2 (Map-backed in-memory, soporta `get/set/incrby/expire/decrby`, simula latency/failure modes vía flags). PROHIBIDO test contra Upstash real (CD-7).

---

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO modificar `src/sign.mjs`, `src/url-validator.mjs`, `src/handlers.mjs`, `src/config.mjs`, `src/log.mjs`, `src/auth.mjs`, `src/index.mjs`. Si una integración demanda cambio del core, escalar a F2 con justificación.
- **CD-2**: Balance gate **fail-secure** — IF la lectura de balance falla por cualquier razón (RPC down, timeout, KV down si se cachea, parse error), THEN OBLIGATORIO rechazar el `pay_x402` con `stage: balance-gate`. PROHIBIDO permitir el pago en condición de incertidumbre. NO HAY override env var para bypass.
- **CD-3**: Rate limit OBLIGATORIO usar bearer-hash sha256 como key KV (NO el bearer plano, NO el IP). Razón: bearer plano en KV expone la credencial si Upstash logs leakean; IP se pisa por NAT/proxy y permite multi-tenant collisions.
- **CD-4**: Cron endpoints (`/api/cron/warmup`, `/api/cron/balance-check`) OBLIGATORIO autenticados con `CRON_SECRET` (env var) verificado timing-safe. Vercel inyecta el header `Authorization: Bearer <CRON_SECRET>` automáticamente cuando el cron está bien configurado. PROHIBIDO endpoint sin auth.
- **CD-5**: Alert webhook timeout OBLIGATORIO `5s` con `AbortSignal.timeout(5000)`. PROHIBIDO timeout > 10s (bloquearía la cron). PROHIBIDO retries en sender.
- **CD-6**: `scripts/rotate-bearer.mjs` PROHIBIDO escribir el bearer a disco, a `.env`, o commitear. SOLO stdout + instrucciones a stderr.
- **CD-7**: Chaos tests + concurrent stress + balance-guard + rate-limit tests OBLIGATORIO usar mocks 100%. PROHIBIDO red mainnet, PROHIBIDO operator wallet real, PROHIBIDO Upstash real. Mock interfaces vivirán en `tests/_mocks/` (Architect define en F2).
- **CD-8**: Logs OBLIGATORIO JSON-line via `src/log.mjs` (heredado WKH-64). PROHIBIDO `console.*` en cualquier nuevo archivo (excepto `scripts/*.mjs` donde stdout es parte del contrato CLI).
- **CD-9**: Tests passing — baseline 103 (WKH-65) + nuevos chaos suite. Mínimo 128 tests passing post-implementación. PROHIBIDO commitear con tests rojos o skipped (excepción: skipped explícitamente justificado en F2).
- **CD-10**: PROHIBIDO loggear `OPERATOR_PRIVATE_KEY`, `MCP_BEARER_TOKEN`, `CRON_SECRET`, `KV_REST_API_TOKEN`, ni la URL completa de `MCP_ALERT_WEBHOOK_URL` (puede contener tokens en query). Spy tests obligatorios (heredado WKH-65 AC-8 pattern).
- **CD-11**: PROHIBIDO `vercel.json` con valores literales de secrets (heredado WKH-65 CD-10). Cron paths OK, schedule OK, secret values NO.
- **CD-12** [NUEVO]: PROHIBIDO el alert webhook body incluir: PK, bearer, CRON_SECRET, raw balance hex sin redactar. Solo: severity, chain, operator address (público), balanceUsdc (decimal redondeado), threshold, checkedAt, optional blockNumber.
- **CD-13** [NUEVO]: PROHIBIDO claim KV TTL > 60s. Razón: si la función Vercel se cae mid-flow sin liberar el claim, queda huérfano. TTL 30s recomendado (mayor que p99 latencia x402 ~25s).
- **CD-14** [NUEVO]: OBLIGATORIO bearer-hash con `sha256` y SHA truncado a primeros 16 hex chars como key KV (`rl:<hash16>`). Hash completo no aporta seguridad adicional como key KV y consume más bytes.
- **CD-15** [UPDATE Opción B]: PROHIBIDO commitear `CRONJOB_ORG_API_TOKEN` o `CRON_SECRET` real. `.env.example` documenta como placeholders. La invocación del script `setup-cronjob.mjs` se hace dev-side desde `.env` local — Vercel env vars de production NO requieren `CRONJOB_ORG_API_TOKEN` (cron-job.org llama Vercel, no al revés).

---

## Missing Inputs

- **[NEEDS CLARIFICATION en F2]** DT-A: confirmar plan Vercel actual y disponibilidad de Upstash KV. Si Hobby + Upstash free no alcanza el volumen estimado, escalar como bloqueante.
- **[NEEDS CLARIFICATION en F2]** DT-C: confirmar que el plan Vercel actual soporta `*/4 * * * *` (Vercel Hobby tiene mínimo 1/día para crons). Si no, escalar.
- **[NEEDS CLARIFICATION en F2]** DT-H: ¿lectura RPC en cada `pay_x402` con cache KV 30s, o snapshot 15 min de la cron? Trade-off latencia vs staleness.
- **[NEEDS CLARIFICATION en F2]** DT-I: atomicidad del claim — Lua script vs INCRBY+EXPIRE. Confirmar capabilities Upstash.
- **[NEEDS CLARIFICATION en F2]** Naming exacto de las env vars del Marketplace Upstash: `KV_REST_API_URL` + `KV_REST_API_TOKEN` es lo histórico, pero algunas integraciones nuevas usan `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`. Architect verifica en Vercel project actual.
- **[NEEDS CLARIFICATION en F2]** ¿El alert webhook va a Slack, Discord, Datadog, o un endpoint custom del operador? Architect documenta el destino y el shape del body que ese provider espera (e.g. Slack requiere `text` field). El work-item declara shape genérico — el destino exacto es F2.
- **[RESUELTO F0]** project-context.md sigue válido post-WKH-65 — no requiere update.
- **[RESUELTO F0]** Sizing QUALITY confirmado por análisis (no se baja).
- **[RESUELTO F0]** `@vercel/kv` deprecation status — usar `@upstash/redis` directo.

---

## Análisis de paralelismo

- **W1 vs W4 paralelo**: SÍ — W1 toca `vercel.json` + `api/cron/warmup.mjs`, W4 toca `scripts/*.mjs` + `README.md`. 0 archivos compartidos. Pueden implementarse en paralelo (incluso por dos devs distintos si fuera el caso).
- **W2 vs W3 secuencial**: PARCIAL — W3 reusa `src/balance-guard.mjs` (lectura RPC) implementada en W2. W3 requiere W2 al menos a nivel de API (la función de lectura debe existir antes que el cron de balance-check).
- **W5 último**: SÍ — los chaos tests cubren todos los flows nuevos de W1+W2+W3. Implementar W5 en paralelo con W1-W4 generaría tests sobre interfaces inestables. Recomendado: W5 como wave de cierre, una vez que W1-W4 estabilizaron sus interfaces.
- **Cross-cutting (`api/mcp.mjs` modify)**: solo se toca al final de W2 para integrar el rate limit + balance gate en el dispatch. Esto es un único punto de modificación coordinado entre W2 (que aporta los módulos) y W5 (que verifica el integrate).
- **NO bloquea otras HUs server-side**: 0 cambios a `src/` del repo principal, 0 cambios a Supabase schema, 0 cambios a wasiai-v2.
- **Branch base**: `main@7b9fc7d` (commit post-merge WKH-65 y mainnet hybrid activated).
- **Predecesor**: WKH-65 DONE, deploy LIVE en `wasiai-x402-mcp.vercel.app/api/mcp`. Esta HU es evolutiva, no bloqueante para la demo del hackathon (la demo ya funciona — esta HU la endurece para operación sostenida).

---

## Categorías de riesgo (para Adversary Review — AR)

1. **Auth bypass on cron endpoints** (ALTO impacto, MEDIO prob): si `validateCronSecret` no es timing-safe o si CRON_SECRET ausente => "auth disabled" en lugar de 500, atacantes externos pueden disparar `/api/cron/balance-check` y `/api/cron/warmup` arbitrariamente. AR debe verificar (a) timing-safe compare, (b) startup fail si CRON_SECRET missing, (c) los handlers no exponen info sensible en sus responses (balance OK pero PK/bearer NO).

2. **Balance race condition** (CRÍTICO impacto, ALTO prob sin guard): el escenario que motivó la HU. AR debe atacar: (a) ¿qué pasa con 10 requests concurrentes contra balance $0.51 + threshold $0.50 + amount $0.10? Solo 1 debería pasar — verificar que el claim atómico KV efectivamente serializa, (b) claim huérfano: si la función Vercel se cae entre claim y settle, ¿el claim libera por TTL 30s? (c) claim release on sign failure, (d) claim read inconsistency (Redis read-your-writes en Upstash REST API — verificar consistency model).

3. **KV failure modes** (ALTO impacto, MEDIO prob): (a) Upstash down → balance gate fail-secure (rechaza pago) PERO rate limit fail-open (permite request). AR verifica que las dos políticas no se confunden en el código (mismo cliente, dos políticas opuestas). (b) Upstash slow (>5s) → ¿timeout configurado en el cliente? (c) Upstash returns stale data por replication lag → ¿afecta el claim atómico?

4. **Webhook leak / SSRF** (MEDIO impacto, MEDIO prob): el body POST a `MCP_ALERT_WEBHOOK_URL` es controlado por nosotros, pero si la URL es atacante-controlada (env var compromised o setup error), ¿exfiltra info? AR verifica: (a) body whitelist (CD-12), (b) ¿la URL pasa por algún SSRF guard? Probablemente NO porque es un POST salida, pero confirmar que no hay open-redirect en cómo se construye, (c) timeout 5s suficiente como DoS-mitigation.

5. **Supply chain — `@upstash/redis`** (BAJO-MEDIO impacto, BAJO prob): nueva dep externa. AR verifica: (a) versión pineada (no `^` con range amplio), (b) no hay hooks postinstall sospechosos, (c) si Upstash deprecate la lib, ¿qué plan de migración? (d) auditoría de transitive deps (¿está activa la `npm audit`?).

6. **Cron auth bypass via Vercel internal routing** (MEDIO impacto, BAJO prob): Vercel inyecta el header `Authorization: Bearer <CRON_SECRET>` para sus crons internos. AR verifica que el handler NO acepta otro mecanismo (ej. query param `?token=...`) ni un fallback weaker.

7. **Rate-limit DoS sobre KV** (MEDIO impacto, BAJO prob): un atacante con N bearers válidos podría inflar las keys en KV (cada bearer hash = key separada). AR verifica: (a) TTL en cada key (60s sliding window), (b) key shape limita la cardinalidad, (c) ¿hay límite global de KV ops/min para nuestra cuenta? Si lo excede, rate limit comienza a fail-open globalmente — degradación elegante OK pero observable.

8. **Cold start pre-load divergencia** (BAJO impacto, BAJO prob): si el warmup pre-carga módulos pero la siguiente request real importa un módulo diferente (e.g. nuevos handlers añadidos sin actualizar warmup), la mitigación se vuelve placebo. AR verifica que el set de imports en `api/cron/warmup.mjs` coincide con los del flow real.

9. **Claim de balance no monetario** (BAJO impacto, BAJO prob): el claim se hace en wei comprometidos, pero la balance real se mide on-chain. Si hay diff por gas u otro débito, el claim queda overconfident. AR verifica que el claim incluye un fudge factor o que el threshold ya cubre overhead de gas (USDC en Avalanche C-Chain mainnet usa AVAX para gas, así que el operator wallet necesita AVAX separado del USDC — confirmar que la lectura de balance es del USDC ERC-20, no del native AVAX).

10. **`api/mcp.mjs` regression** (CRÍTICO impacto, BAJO prob si tests cubren): la integración del rate limit + balance gate modifica el handler que ya pasó WKH-65 con 19 tests. AR verifica que el orden de operaciones de WKH-65 (CORS → method → auth → config → dispatch) se preserva, ahora extendido a (CORS → method → auth → rate-limit → config → dispatch + balance-gate-en-pay_x402). Cualquier regresión sobre los AC-1..AC-16 de WKH-65 es BLOQUEANTE.

11. **cron-job.org availability**: SaaS externo. Si está caído, no hay warmup ni balance-check. Mitigación: AC-W3 fail-safe (alert dispara también si cron-job.org no llama en >30 min, vía heartbeat tracking en KV — `lastBalanceCheck` timestamp). Architect en F2 decide si vale agregar este check de meta-vivencia o si está fuera de scope.

---

## Estado post-update (2026-04-30 11:XX)

**DT-C resuelto** (Opción B humano), DT-G nuevo agregado. Listo para clinical review HU_APPROVED revisado y luego F2.
