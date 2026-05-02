# Work Item — [WKH-67] [BUG-WKH66] Balance-gate decimals mismatch — PYUSD inbound vs USDC outbound

> Fase F1 (analyst) — modo AUTO QUALITY pipeline. Ticket: https://ferrosasfp.atlassian.net/browse/WKH-67
> Predecesor inmediato: `doc/sdd/071-wkh-66-prod-hardening/` (DONE 2026-04-29) — DONE pero introdujo regression bloqueante en producción.
> Ramas relacionadas: WKH-64 (`069-wkh-64-mcp-x402` AC-11 sign-guard), WKH-65 (`070-wkh-65-mcp-vercel-deploy` BLQ-iter3-1 redirect:'error').
> Bug discovery: humano post-merge gate WKH-66 vía smoke real con `wasiai-x402-mcp.vercel.app/api/mcp` contra mainnet. ROLLBACK ya hecho a deploy `wasiai-x402-ah0gufv0p` (era WKH-65). Cron-job.org jobs DISABLED (re-enable post-fix).

## Product Context

[SIN PRODUCT CONTEXT — work-item self-contained, narrativa heredada de WKH-64/65/66 + ticket Jira WKH-67 + reproducción documentada en este archivo]

---

## Resumen

WKH-66 (`071-wkh-66-prod-hardening`) shippeo a mainnet el balance-gate del operator wallet (Avalanche C-Chain mainnet, USDC, 6 decimals) montado dentro de `runWithBalanceGate` en `api/mcp.mjs:123-194`. La implementación reusa el argumento existente `args.maxAmountWei` (introducido en WKH-64 AC-11 como **sign guard sobre INBOUND PYUSD wei**, Kite testnet, **18 decimals**) como el `requestedWei` del claim atómico KV (OUTBOUND USDC wei).

El argumento es **el mismo nombre y la misma posición** pero las dos guards lo interpretan en **decimales radicalmente distintos**: 18 vs 6. NO existe un único valor numérico que satisfaga ambos checks simultáneamente:

- Si el caller pasa `1000000000000000000` (1 PYUSD wei = 18 decimals): pasa el sign guard (≥ challenge) pero el balance-gate intenta reservar `10^18` USDC wei = $10^12 USDC → `concurrent claim exceeded` (excede balance $4.756).
- Si el caller pasa `100000` ($0.10 USDC = 6 decimals): el balance-gate aprueba pero el sign guard rechaza con `amount exceeds maxAmountWei guard` (porque `accepts.maxAmountRequired` viene en PYUSD wei mucho mayor que 10^5).
- Si el caller no pasa `maxAmountWei`: el balance-gate retorna `maxAmountWei required (balance gate cannot reserve a claim without it)` ANTES de llegar al sign guard.

**Resultado en mainnet**: TODOS los `pay_x402` rebotan en `stage:'balance-gate'`. El deploy WKH-66 quedó funcionalmente broken. El demo previo (WKH-65) fue rollback-ed para mantener la URL operativa para el hackathon.

WKH-67 separa los dos guards en dimensiones distintas, derivando el OUTBOUND USDC wei desde una fuente correcta (no del INBOUND PYUSD wei), preserva todos los invariants de seguridad de WKH-64/65/66 (5 BLQs cerrados, redirect:'error', fail-secure, atomic claim, rate-limit), y habilita el deploy con smoke real de $0.061 USDC mainnet end-to-end.

---

## Sizing

- **SDD_MODE**: full (QUALITY) — bug fix sobre payment path con guards de seguridad acoplados, requiere modificar `src/handlers.mjs` (CD-1 inviolable de WKH-66 — debe levantarse explícitamente con justificación), preserva regresiones cerradas en WKH-64/65/66 (5 BLQs + 1 BLQ-iter3-1 + 1 BLQ-ALTO-1), agrega tests para el nuevo invariant (decimals separation) más concurrent stress que YA debe pasar (T-CS-01, T-CS-02 baseline).
- **Estimación**: M (3-4 archivos modificados, ~6-10 tests nuevos, 0 deps nuevas, 1 wave coordinada — pero impacto mainnet alto requiere QUALITY pipeline completo).
- **Pipeline**: QUALITY firme (humano declaró QUALITY — el bug está en payment path con $$$ reales en mainnet, no se baja).
- **Branch sugerido**: `fix/072-wkh-67-balance-gate-decimals` desde `main@b095b80` (commit con regression).
- **Skills router**: (1) `payment-rails-hardening` (decimals separation, sign-vs-balance guard semantic split, fail-secure preservation), (2) `vercel-serverless` (re-deploy validado contra el deploy que rolleamos atrás + cron-job.org re-enable).

### Veredicto sizing — QUALITY confirmado

**Argumentos a favor (todos):**

1. **Bug en mainnet con $$$ reales**. La operator wallet tiene $4.756 USDC. Una mala separación re-introduce el drain primitive que SEC-DRAIN-1 (WKH-59) cerró. El balance-gate fail-secure DEBE seguir siendo fail-secure.
2. **Levanta CD-1 inviolable de WKH-66**. WKH-66 prohibió tocar `src/handlers.mjs`. Approach A (recomendado) toca handlers para inyectar el balance-gate POST-probe. Esto requiere AR explícito sobre por qué se levanta el constraint y qué nuevas regresiones podría introducir.
3. **5 BLQs históricos en zona de impacto**. WKH-64 cerró absolute-URL SSRF, backslash bypass, redirect leak, viem error sanitization, signature truncation. WKH-65 cerró BLQ-iter3-1 (`redirect:'error'`). WKH-66 cerró BLQ-ALTO-1 (snapshot freshness). Cualquier cambio en el flow probe→sign→settle DEBE preservar los 6.
4. **Concurrent stress baseline**. WKH-66 introdujo `tests/concurrent-stress.test.mjs` (T-CS-01, T-CS-02). El fix DEBE mantener atomicidad del claim KV — si rompemos la serialización al cambiar dónde corre el balance-gate, los tests rompen.
5. **Re-deploy con smoke real $0.061 USDC mainnet** = gate humano final con plata. QUALITY garantiza F4 QA con evidencia archivo:línea + smoke E2E antes de DONE.
6. **Auto-blindaje obligatorio**. La lección "params shared across guards must have same unit/decimals" es nueva y debe cementarse como CD para evitar regression en futuras HUs.

**Argumentos en contra (descartados):**
- "Es un bug fix chico" — el cambio podría parecer trivial (1-2 líneas) pero el cambio de SEMÁNTICA del balance-gate (qué reserva, en qué decimales, en qué momento del flow) es estructural. La revisión QUALITY es mandatoria.

**Veredicto: QUALITY firme.**

---

## Decisión Approach A vs B (cementada en F1)

El ticket WKH-67 propone dos approaches. Esta sección los evalúa y deja **Approach A** como decisión vinculante para F2.

### Approach A — Mover balance-gate INSIDE de `payX402Handler` post-probe (RECOMENDADO)

**Mecánica:**
1. El handler ejecuta el probe (sin firma) y recibe `accepts[0].maxAmountRequired` (PYUSD INBOUND wei, 18 decimals).
2. ANTES de la sección `[2] Cap guard (AC-11)` el handler invoca el balance-gate con un `requestedUsdcWei` derivado del payload del caller (`payload.maxBudget` USDC number → ×10^6 wei) — fuente correcta del OUTBOUND budget que el caller declaró.
3. Si el balance-gate retorna `ok:false`, retornar tal cual (mismo shape que hoy, `stage:'balance-gate'`).
4. Si pasa, continuar con el cap guard PYUSD (18 decimals) sobre `args.maxAmountWei` original — sin cambios semánticos.
5. `releaseClaim` se invoca en el `finally` del handler (no en `api/mcp.mjs`).

**Pros:**
- **Clean semántica**: cada guard usa su propia dimensión sin coupling.
- **Sin breaking change** del schema MCP `pay_x402`: el caller sigue pasando `maxAmountWei` (PYUSD inbound wei) opcional + `payload.maxBudget` (USDC outbound, ya existente).
- **Source-of-truth correcta**: el OUTBOUND USDC wei se deriva del payload — el caller NO debe traducir entre cadenas.
- **Reduce lockstep entre `api/mcp.mjs` y handlers**: el balance-gate vive en el mismo archivo que el cap guard, mismo flow narrativo.

**Cons:**
- Requiere **levantar CD-1 de WKH-66** (`PROHIBIDO modificar src/handlers.mjs`). La justificación es: el constraint fue puesto para evitar regresiones en el core sign flow durante una HU de hardening que pretendía ser strictly additive en `api/mcp.mjs`. WKH-67 es un fix sobre el **acoplamiento mismo** que el constraint no anticipó. El nuevo CD-1 (versión WKH-67) re-prohíbe tocar `src/sign.mjs`, `src/url-validator.mjs`, `src/auth.mjs`, `src/log.mjs`, `src/config.mjs`, `src/index.mjs` — pero permite explícitamente `src/handlers.mjs` SOLO en la sección post-probe / pre-cap-guard.
- AR debe atacar: ¿el balance-gate post-probe sigue siendo fail-secure si el probe ya consumió tiempo y el claim queda huérfano por TTL? (Sí — TTL 30s, idéntico al actual.)
- Si `payload.maxBudget` no está presente o es inválido, ¿qué hacer? → AC-7 (ver abajo): rechazar fail-secure con stage:'balance-gate'.

### Approach B — Renombrar arg + agregar uno nuevo

**Mecánica:**
- Mantener `maxAmountWei` para el sign guard (PYUSD inbound).
- Agregar nuevo `maxOutboundUsdcWei` para el balance-gate (USDC outbound, 6 decimals).
- El balance-gate se sigue ejecutando en `runWithBalanceGate` (no se toca `handlers.mjs`).

**Pros:**
- No levanta CD-1 de WKH-66.
- Explícito en el schema — los dos params son visibles como tales.

**Cons:**
- **Breaking change** de schema MCP. Callers existentes (Claude Console managed agents) deben actualizar sus llamadas. El ticket Jira lista esto explícitamente como con.
- **Requiere que el caller traduzca entre cadenas** — Claude debe saber que la INBOUND es PYUSD-Kite (18d) y la OUTBOUND es USDC-Avalanche (6d). Esto filtra implementation detail al consumer.
- **No resuelve el problema de fondo**: en el futuro, si agregamos otra cadena downstream (e.g. Base USDC, Polygon USDT con 6 vs 18 decimals respectivamente), tenemos que seguir agregando args.
- **Doc burden**: tools/list descriptors deben explicar la diferencia, los ejemplos en README se duplican.

### Decisión vinculante

**APPROACH A**. Razones:
1. Schema MCP estable es prioritario — Claude Console managed agents NO deben tener que lidiar con detalles de cadenas downstream.
2. La semántica natural es: "yo (caller) declaro mi budget en USDC" (lo que ya hay en `payload.maxBudget`). El operator se encarga de la traducción a cualquier downstream.
3. El levantamiento controlado de CD-1 (con scope estricto: solo post-probe / pre-cap-guard) es de menor riesgo arquitectónico que un breaking change a un schema público.
4. El bug de fondo es el ACOPLAMIENTO de un mismo nombre con dos significados — Approach A lo desacopla en su raíz; Approach B lo nombra explícitamente pero deja la responsabilidad en el caller.

F2 architect cementa esta decisión y diseña el insertion point exacto en `payX402Handler`.

---

## Acceptance Criteria (EARS)

### Funcionales — fix del bug

- **AC-1** (event-driven, primary repro): WHEN `pay_x402` se invoca con `payload.maxBudget = 0.5` (USDC, number) y SIN `args.maxAmountWei`, the system SHALL ejecutar el flow completo probe→balance-gate→sign→settle y retornar `{ ok: true, stage: 'settled', ... }` cuando el operator wallet tiene balance ≥ threshold + 0.5 USDC y los downstream responden 200. PROHIBIDO retornar `{ ok: false, stage: 'balance-gate', error: 'maxAmountWei required' }` en este escenario.

- **AC-2** (state-driven): WHILE el balance-gate está activo en el flow, the system SHALL operar **EXCLUSIVAMENTE** sobre OUTBOUND USDC wei (6 decimales sobre Avalanche C-Chain mainnet). El `requestedWei` que se pasa a `checkBalanceWithClaim` SHALL ser derivado de `payload.maxBudget` (USDC number) → `_usdcToWei(maxBudget)` (BigInt 6-decimal wei). PROHIBIDO usar `args.maxAmountWei` como input al balance-gate.

- **AC-3** (state-driven, no-regression WKH-64 AC-11): WHILE el sign guard (cap guard) está activo en el flow, the system SHALL operar **EXCLUSIVAMENTE** sobre INBOUND PYUSD wei (18 decimales sobre Kite testnet). El comportamiento del sign guard (`requested > guard` → `stage:'sign', error:'amount exceeds maxAmountWei guard'`) SHALL ser idéntico al de WKH-64 AC-11 — sin cambios. WKH-64 AC-11 SHALL pasar tests existentes sin modificación.

- **AC-4** (event-driven): WHEN `pay_x402` se invoca y `payload.maxBudget` es `undefined`, `null`, no-numérico, ≤ 0, o > el balance disponible menos threshold, the system SHALL retornar `{ ok: false, stage: 'balance-gate', error: 'invalid or missing payload.maxBudget' }` (variantes específicas según el sub-caso) ANTES de invocar el probe. **Fail-secure**: NO se ejecuta probe ni firma sin un budget OUTBOUND válido.

- **AC-5** (state-driven, ordering): WHILE `payX402Handler` ejecuta, the system SHALL respetar el orden: (1) input sanitize, (2) endpoint validation (BLQ-iter2-1 SSRF), (3) probe sin firma con `redirect:'error'`, (4) parse de `accepts[0]`, (5) **balance-gate INSIDE handler** (AC-2), (6) cap guard PYUSD (AC-3), (7) sign, (8) settle con `redirect:'error'`. El balance-gate SHALL correr DESPUÉS del probe (porque depende de payload válido y endpoint válido) y ANTES del sign (porque el claim debe reservarse antes de comprometer la firma EIP-3009).

- **AC-6** (event-driven, claim release): WHEN `payX402Handler` retorna por cualquier camino (success, sign error, settle error, redirect refused, exception inesperada), the system SHALL invocar `releaseClaim` exactamente UNA VEZ con el mismo `requestedWei` que se reservó. PROHIBIDO double-release o no-release. La invocación SHALL ser via `try/finally` interno al handler.

- **AC-7** (unwanted condition, fail-secure): IF la lectura de balance falla, IF el claim KV falla, IF `kvClient` es null, o IF `payload.maxBudget` es inválido, THEN the system SHALL retornar `{ ok: false, stage: 'balance-gate', error: <específico> }` **ANTES** del sign. PROHIBIDO firmar sin pasar el balance-gate. Hereda CD-2 de WKH-66 — fail-secure inviolable.

### No-regression (WKH-64/65/66 invariants)

- **AC-8** (no-regression, BLQ historicals): WHEN tests de WKH-64 W-BLQ-1..W-BLQ-5 + WKH-65 W-BLQ-iter3-1 + WKH-66 W-BLQ-ALTO-1 corren post-fix, the system SHALL pasar 100% sin modificación al test code. La cobertura SHALL incluir: absolute-URL rejection, backslash bypass rejection, post-resolution SSRF guard, redirect:'error' on probe + settle, viem error sanitization, signature truncation in logs, snapshot freshness (30s) cron-vs-gate.

- **AC-9** (no-regression, baseline): WHEN `npm test` corre post-fix, the system SHALL ejecutar la suite completa con baseline ≥ 173 tests (WKH-66 final count) + nuevos tests del fix (estimado ~6-10), pasar 100% (0 fail, 0 skip excepto los explicitly justified). Concurrent stress (T-CS-01, T-CS-02 de WKH-66) SHALL pasar sin modificación.

- **AC-10** (no-regression, sec invariants): WHILE el flow corre, the system SHALL preservar: (a) timing-safe bearer compare en `api/mcp.mjs`, (b) rate-limit fail-open en KV down, (c) balance-gate fail-secure en RPC/KV down, (d) auth-first ordering (bearer ANTES de loadConfig), (e) PROHIBIDO loggear `OPERATOR_PRIVATE_KEY`, `MCP_BEARER_TOKEN`, `CRON_SECRET`, `KV_REST_API_TOKEN`, ni `MCP_ALERT_WEBHOOK_URL` en cualquier nuevo log.

### Operativos — re-deploy y smoke

- **AC-11** (event-driven): WHEN el branch `fix/072-wkh-67-balance-gate-decimals` se mergea a main vía PR aprobado en F4, the system SHALL re-deployear a Vercel `wasiai-x402-mcp.vercel.app/api/mcp` y el deploy URL SHALL ser distinto al actual (`wasiai-x402-ah0gufv0p` rolled back).

- **AC-12** (event-driven, smoke real): WHEN se ejecuta el smoke `scripts/smoke-prod-via-app-wasiai.mjs` (o equivalente en `mcp-servers/wasiai-x402/scripts/`) post-deploy con `payload.maxBudget = 0.5` y operator wallet con balance > $1 USDC, the system SHALL completar 1 transacción end-to-end (probe → balance-gate OK → sign → settle 200) gastando ≤ $0.10 USDC reales en mainnet. La transacción SHALL ser visible en Avalanche explorer. El test SHALL ser ejecutado UNA VEZ con $0.061 USDC documentado en done-report.

- **AC-13** (event-driven, cron re-enable): WHEN AC-12 pasa, the system SHALL re-habilitar los 2 cron-job.org jobs (`wasiai-x402-warmup` y `wasiai-x402-balance-check`) que fueron disabled durante el rollback. El status SHALL ser verificado vía `node scripts/setup-cronjob.mjs` en modo update o vía dashboard cron-job.org.

### Auto-blindaje — lessons learned

- **AC-14** (state-driven, doc): WHILE F4 cierra DONE, the system SHALL persistir `doc/sdd/072-wkh-67-balance-gate-decimals/auto-blindaje.md` con MÍNIMO 1 lección: "params shared across guards must have same unit/decimals — distinct concerns get distinct args". La lección SHALL incluir (a) el caso concreto WKH-66 → WKH-67, (b) el patrón AR para detectar este class de bug en futuros SDDs (grep dual-use de un arg en el mismo handler), (c) un CD para SDD futuros que cementa la regla.

- **AC-15** (cross-cutting, sign-off): WHEN F4 valida AC-1..AC-13 con evidencia archivo:línea + smoke evidence (tx hash mainnet), the system SHALL escribir `done-report.md` con: link al PR, link al deploy Vercel, tx hash mainnet, snapshot del balance pre/post smoke, link al cron-job.org status, y firma del QA agent.

---

## Scope IN

Todo dentro de `mcp-servers/wasiai-x402/` (heredado del subpaquete WKH-66) excepto donde se indique:

1. **`src/handlers.mjs`** (MODIFICAR — **levanta CD-1 de WKH-66**) — insertar el balance-gate INSIDE `payX402Handler` post-probe / pre-cap-guard. Insertar `releaseClaim` en `try/finally` interno. Cambio quirúrgico: ~30-50 líneas nuevas en una sola función. NO se toca el sign flow, NO se toca el SSRF guard, NO se toca el settle.

2. **`src/balance-guard.mjs`** (POSIBLE MODIFICAR) — F2 architect decide si la API actual `checkBalanceWithClaim({operator, chainId, requestedWei, threshold, kvClient, publicClient, usdcAddress})` es suficiente. Probable change: ninguno (la firma actual ya es correcta — el `requestedWei` simplemente pasaba el dato wrong; el módulo no es el culpable). Si F2 decide agregar un helper `_usdcToWei` exportado, OK.

3. **`api/mcp.mjs`** (MODIFICAR) — eliminar `runWithBalanceGate` wrapper (líneas 106-194) y el call site `case 'pay_x402'` (línea 222-227) que invoca el wrapper. Reemplazar por llamada directa a `payX402Handler` (que ahora hace el gate internamente). Mantener todo lo demás (CORS, bearer auth, rate-limit, ordering, transport, adapter Express).

4. **`tests/handlers.test.mjs` o nuevo `tests/balance-gate-handlers.test.mjs`** (NUEVO/MODIFICAR) — ≥6 tests cubriendo:
   - Test-1: AC-1 happy path (`payload.maxBudget=0.5`, sin `maxAmountWei`, balance OK → settled).
   - Test-2: AC-3 sign-guard regression (`payload.maxBudget=0.5` + `maxAmountWei=10^17` PYUSD wei, challenge=10^18 → reject `stage:'sign'`).
   - Test-3: AC-4 missing maxBudget (sin `maxBudget`, sin `maxAmountWei` → reject `stage:'balance-gate'`).
   - Test-4: AC-5 ordering (probe-first, balance-gate-second, sign-third — verificar via spy/mock order).
   - Test-5: AC-6 release on success.
   - Test-6: AC-6 release on settle error.
   - Test-7: AC-7 KV down → fail-secure (no firma).
   - Test-8: AC-7 invalid maxBudget (negative, NaN, string, > balance) → reject.

5. **`tests/concurrent-stress.test.mjs`** (POSIBLE MODIFICAR) — actualizar mock para reflejar que el caller pasa `payload.maxBudget` en USDC number, no `maxAmountWei` en USDC wei. T-CS-01 y T-CS-02 SHALL pasar post-update.

6. **`README.md`** (MODIFICAR) — actualizar sección "Tools / pay_x402" para documentar:
   - `payload.maxBudget` (USDC, number) es la SOURCE OF TRUTH para el balance-gate OUTBOUND.
   - `args.maxAmountWei` (PYUSD wei, BigInt string) es OPCIONAL y solo se usa para el sign guard INBOUND (cap defensivo contra challenges 402 anómalos).
   - Ejemplos actualizados con ambos casos: con/sin `maxAmountWei`.

7. **`doc/sdd/072-wkh-67-balance-gate-decimals/auto-blindaje.md`** (NUEVO en F4) — lección "decimals separation" (AC-14).

8. **Smoke script** (POSIBLE NUEVO) — `mcp-servers/wasiai-x402/scripts/smoke-mainnet-fix.mjs` o reusar existente. Documenta el run E2E post-deploy con $0.061 USDC.

## Scope OUT

- **NO modificar** `src/sign.mjs`, `src/url-validator.mjs`, `src/auth.mjs`, `src/log.mjs`, `src/config.mjs`, `src/index.mjs`, `src/kv-client.mjs`, `src/rate-limit.mjs`, `src/cron-auth.mjs`, `src/alerts.mjs`, `src/avax-client.mjs`. CD-1 (WKH-67 versión) preserva el resto del core.
- **NO modificar** `api/cron/warmup.mjs` ni `api/cron/balance-check.mjs` — esos handlers no usan `args.maxAmountWei`. Quedan intactos.
- **NO modificar** `vercel.json`, `package.json` (excepto bump de version si F2 lo decide), ni `.env.example` (no hay nuevas env vars).
- **NO agregar** nuevas dependencias (`@upstash/redis`, `viem`, etc. ya están).
- **NO cambiar** el shape del envelope x402, el algoritmo de firma EIP-3009, ni el formato de tools/list.
- **NO mover** el balance-gate a `api/cron/*` ni a edge functions — sigue siendo síncrono dentro del flow `pay_x402`.
- **NO** hacer breaking change en el schema MCP `pay_x402` (Approach B descartado).
- **NO** incrementar `maxDuration` por encima de 60s.
- **NO** cambiar el plan Vercel ni Upstash.
- **NO** modificar Supabase, ni `wasiai-v2`, ni `app.wasiai.io`.
- **NO** agregar lógica de retry automático en el balance-gate, ni en el smoke script.
- **NO** cambiar el RPC URL ni el USDC contract address — heredados de WKH-66.
- **NO** alterar el cron schedule ni el threshold $0.50 USDC.
- **NO** instrumentar nuevas métricas Prometheus/Datadog — el alert webhook ya existe.

---

## Decisiones técnicas (DT-N)

- **DT-1** [CEMENTADO F1 — Approach A]: balance-gate vive INSIDE `payX402Handler`, post-probe (después de parsear `accepts[0]`) y pre-cap-guard. La función `runWithBalanceGate` en `api/mcp.mjs` se elimina. Razón: separación natural de concerns; cada guard usa su propia dimensión sin acoplamiento via un arg compartido.

- **DT-2** [CEMENTADO F1]: el OUTBOUND USDC wei se deriva de `payload.maxBudget` (USDC number) usando `_usdcToWei(maxBudget)` (BigInt). `payload.maxBudget` ya es la source-of-truth declarada para el budget cliente-side (heredado del flow `compose` original). NO se introduce un nuevo arg en el schema MCP.

- **DT-3** [CEMENTADO F1]: el INBOUND PYUSD wei sigue siendo `args.maxAmountWei` (BigInt string opcional) — comportamiento idéntico a WKH-64 AC-11. Sin cambios al cap guard.

- **DT-4** [PARA F2]: el `releaseClaim` se invoca en un `try/finally` INTERNO al handler. F2 architect debe decidir si el `finally` envuelve solo el sign+settle o también la cap guard. Recomendación analyst: envolver desde DESPUÉS del balance-gate exitoso HASTA el return final (inclusive happy path, sign error, settle error) — equivalente al patrón actual en `runWithBalanceGate`.

- **DT-5** [PARA F2]: ¿qué hacer si `payload.maxBudget` no está declarado pero el endpoint es free (200 status)? Recomendación: validar `payload.maxBudget` ANTES del probe (fail-fast). Si no declarado y endpoint resulta free, el caller pierde latencia del probe-time? No — el probe es rápido y la validación de `maxBudget` cuesta micro-segundos. Decisión propuesta: **validar `maxBudget` ANTES del probe**. Architect ratifica.

- **DT-6** [PARA F2]: ¿el balance-gate debería usar `accepts[0].maxAmountRequired` traducido a USDC para más precisión, o mantener `payload.maxBudget` como fuente? Trade-off: el `maxAmountRequired` es exacto pero está en moneda INBOUND (PYUSD); traducirlo requiere oracle precio PYUSD/USDC = caja de Pandora. `payload.maxBudget` es declarado por el caller y es ceiling natural. Recomendación: **`payload.maxBudget`** (sin oracle). Si el actual `accepts[0].maxAmountRequired` traducido excede `maxBudget`, eso es responsabilidad del cap guard PYUSD (sign guard) — no del balance-gate.

- **DT-7** [PARA F2]: ¿el smoke script debe ser idempotente o one-shot? Recomendación: **one-shot** documentado en done-report con tx hash + balance pre/post. Re-runs requieren autorización humana explícita.

- **DT-8** [PARA F2]: ¿re-enable de cron-job.org es manual via dashboard o automatizado via `setup-cronjob.mjs`? Recomendación: ejecutar `node scripts/setup-cronjob.mjs` que ya es idempotente (WKH-66 AC-W1-1). No hace falta script nuevo.

- **DT-9** [PARA F2]: ¿la docstring de `pay_x402` en `tools/list` (TOOL_DESCRIPTORS) debe documentar la separación decimals? Recomendación: SÍ — actualizar el `description` field y `inputSchema` con notas claras: "maxAmountWei: optional defensive cap on INBOUND PYUSD wei challenge (18 decimals); payload.maxBudget: required OUTBOUND USDC budget in USDC number (will be converted to 6-decimal wei internally)".

---

## Constraint Directives (CD-N)

### Heredados de WKH-66 (con update)

- **CD-1 (UPDATED WKH-67)**: PROHIBIDO modificar `src/sign.mjs`, `src/url-validator.mjs`, `src/auth.mjs`, `src/log.mjs`, `src/config.mjs`, `src/index.mjs`, `src/kv-client.mjs`, `src/rate-limit.mjs`, `src/cron-auth.mjs`, `src/alerts.mjs`, `src/avax-client.mjs`. **PERMITIDO modificar `src/handlers.mjs` y `src/balance-guard.mjs`** SOLO en el scope estricto del fix de decimals (insertion del balance-gate INSIDE `payX402Handler`). Cualquier cambio fuera de ese scope dentro de `handlers.mjs` (e.g. tocar el sign flow o el SSRF guard) es BLOQUEANTE en AR.

- **CD-2 (HEREDADO)**: balance-gate **fail-secure**. IF lectura de balance falla, IF KV down, IF claim atómico falla, IF `payload.maxBudget` inválido, THEN OBLIGATORIO rechazar con `stage:'balance-gate'`. PROHIBIDO firmar en condición de incertidumbre. NO override env var.

- **CD-3 (HEREDADO)**: rate-limit con bearer-hash sha256 truncado 16 hex. Sin cambios.

- **CD-4 (HEREDADO)**: cron endpoints con `CRON_SECRET` timing-safe. Sin cambios.

- **CD-5 (HEREDADO)**: alert webhook timeout 5s, no retries. Sin cambios.

- **CD-6 (HEREDADO)**: `scripts/rotate-bearer.mjs` no escribe a disco. Sin cambios.

- **CD-7 (HEREDADO)**: chaos/concurrent stress/balance-guard/rate-limit tests usan mocks 100%. PROHIBIDO mainnet en tests. Sin cambios.

- **CD-8 (HEREDADO)**: logs OBLIGATORIO JSON-line via `src/log.mjs`. PROHIBIDO `console.*`.

- **CD-9 (UPDATED WKH-67)**: tests passing — baseline ≥173 (WKH-66) + nuevos del fix (~6-10) → mínimo 179 tests passing post-implementación. PROHIBIDO commitear con tests rojos.

- **CD-10 (HEREDADO)**: PROHIBIDO loggear secrets (PK, bearer, CRON_SECRET, KV token, webhook URL).

- **CD-11 (HEREDADO)**: PROHIBIDO `vercel.json` con secrets literales.

- **CD-12 (HEREDADO)**: alert webhook body whitelist. Sin cambios.

- **CD-13 (HEREDADO)**: claim KV TTL ≤ 60s. Sin cambios.

- **CD-14 (HEREDADO)**: bearer-hash sha256 trunc 16 hex. Sin cambios.

- **CD-15 (HEREDADO)**: PROHIBIDO commitear cron-job.org token o CRON_SECRET. Sin cambios.

- **CD-16 (HEREDADO opcional WKH-66)**: AVAX gas en operator wallet — cubierto por alert webhook si threshold cruzado. Sin cambios.

- **CD-17 (HEREDADO)**: PROHIBIDO `event:` dentro del payload de `log.{info,warn,error}`. AR/CR debe grep.

- **CD-18 (HEREDADO)**: `fetch()` con headers sensibles → `redirect:'error'`. Sin cambios.

- **CD-19 (HEREDADO)**: tests concurrentes con mocks header-aware (no canned secuencial).

### Nuevos en WKH-67

- **CD-20 (NEW WKH-67)**: PROHIBIDO usar el mismo argumento (named param o positional) como input de DOS guards/checks que operen en cadenas/decimales/dimensiones distintas. Cada guard SHALL recibir su input desde una source-of-truth dimensional consistente. AR/CR DEBE grep `args.maxAmountWei` y verificar que aparezca SOLO en el cap guard PYUSD (sign guard, AC-11) — nunca en el balance-gate. AR DEBE grep `payload.maxBudget` y verificar que aparezca SOLO en el balance-gate (AC-2) — nunca en el sign guard. Si AR detecta cross-uso, BLOQUEANTE.

- **CD-21 (NEW WKH-67)**: el balance-gate en `payX402Handler` SHALL invocarse DESPUÉS del probe (después de parsear `accepts[0]`) Y ANTES del cap guard PYUSD. PROHIBIDO ejecutar el balance-gate ANTES del probe (porque podría fallar el balance-gate antes de saber si el endpoint es free / inválido / no-x402) ni DESPUÉS del cap guard (porque el cap guard podría firmar — el balance-gate debe correr antes de la firma).

- **CD-22 (NEW WKH-67)**: `payload.maxBudget` SHALL validarse como `Number.isFinite(x) && x > 0 && x < 1_000_000` (sane upper bound) ANTES de convertir a wei. NaN, null, undefined, negativo, string, 0, o > 1M USDC → reject `stage:'balance-gate', error:'invalid or missing payload.maxBudget'`.

- **CD-23 (NEW WKH-67)**: el `releaseClaim` SHALL invocarse exactamente UNA VEZ por flow exitoso del balance-gate (independiente del outcome posterior — sign error, settle error, exception). Patrón obligatorio: `try/finally` dentro de `payX402Handler` post-balance-gate. PROHIBIDO double-release ni no-release.

- **CD-24 (NEW WKH-67)**: el smoke real post-deploy SHALL gastar ≤ $0.10 USDC mainnet en una única transacción documentada con tx hash en done-report. PROHIBIDO ejecutar el smoke múltiples veces sin autorización humana (cada run cuesta plata real).

- **CD-25 (NEW WKH-67)**: `auto-blindaje.md` OBLIGATORIO en F4 con MÍNIMO 1 lección sobre decimals separation. Si la lección no está, F4 BLOQUEANTE.

---

## Missing Inputs

- **[RESUELTO F1]** Approach decision (A vs B) → Approach A cementado.
- **[RESUELTO F1]** CD-1 lift de WKH-66 → permitido SOLO para `src/handlers.mjs` y `src/balance-guard.mjs`, scope estricto al fix.
- **[NEEDS CLARIFICATION en F2]** DT-4: scope del `try/finally` interno (cubre sign+settle, o también cap guard).
- **[NEEDS CLARIFICATION en F2]** DT-5: ¿validar `payload.maxBudget` antes o después del probe? Recomendación analyst: ANTES (fail-fast).
- **[NEEDS CLARIFICATION en F2]** DT-9: tools/list descriptors update — texto exacto.
- **[NEEDS CLARIFICATION en F2]** ¿el smoke script vive en `mcp-servers/wasiai-x402/scripts/` o reusa el existente del repo principal? Probable reuse.
- **[RESUELTO F1]** sizing QUALITY (sin debate).
- **[RESUELTO F1]** scope OUT explícito (preserva 11 archivos del core).
- **[RESUELTO F1]** branch base `main@b095b80` (commit con regression).
- **[RESUELTO F1]** smoke budget `$0.10 USDC` en mainnet (CD-24).

---

## Análisis de paralelismo

- **Bloquea HUs futuras?** SÍ TEMPORARIAMENTE — toda HU que toque payment path o que dependa del MCP server live en mainnet debe esperar este fix. La demo del hackathon está parcialmente operativa via deploy WKH-65 rolled back.
- **Puede ir en paralelo con otras HUs?** Limitado:
  - **Cero conflicto** con HUs que tocan `wasiai-v2`, `app.wasiai.io`, Supabase RLS, agent cards, dashboards.
  - **Conflicto potencial** con cualquier otra HU que toque `mcp-servers/wasiai-x402/src/handlers.mjs` o `api/mcp.mjs`. Verificar antes de mergear.
- **Single wave** — no hay descomposición en sub-waves: el fix es atómico (handlers + api/mcp + tests + smoke) y debe shippearse junto. Splitearlo introduce ventanas inconsistentes en mainnet.
- **Branch base**: `main@b095b80` (commit con regression). Deploy actual rolled-back a `wasiai-x402-ah0gufv0p` (era WKH-65). El re-deploy post-fix invalida el rollback y restaura la URL canonical con código WKH-66 + WKH-67 combinado.
- **Predecesor inmediato**: WKH-66 DONE (con regression). Esta HU es **CORRECTIVA**, no evolutiva.
- **Sucesores potenciales**: WKH-68+ (futuro) — agregar más downstream chains (Base, Polygon, Arbitrum) reusará el patrón "balance-gate per outbound chain con su propio decimals helper" cementado por CD-20.

---

## Categorías de riesgo (para Adversary Review — AR)

1. **CD-1 lift mal contenido** (CRÍTICO impacto, MEDIO prob): el fix debe tocar SOLO post-probe / pre-cap-guard en `handlers.mjs`. Si el dev toca el sign flow, el SSRF guard, o el settle, eso es BLOQUEANTE. AR debe hacer diff line-by-line del PR contra el WKH-66 baseline y validar que el cambio está estrictamente en la sección permitida.

2. **Re-introducción del drain primitive** (CRÍTICO impacto, BAJO prob con tests): si el balance-gate corre en un orden mal definido (e.g. después del sign), o si el `releaseClaim` se invoca antes de que el flow se complete, hay ventana para que un caller drain el wallet. AR debe construir un escenario adversarial: 10 calls concurrentes con `payload.maxBudget=$0.05` cada uno contra balance $0.51 + threshold $0.50 → solo 1 puede pasar (=$0.01 disponible). Si más de 1 pasa, BLOQUEANTE. T-CS-01 / T-CS-02 cubren esto si el patrón se preserva.

3. **`payload.maxBudget` adversarial inputs** (ALTO impacto, MEDIO prob): el caller controla `payload`. ¿Qué pasa con `maxBudget=Infinity`, `maxBudget=NaN`, `maxBudget="0.5"` (string), `maxBudget=-0.5`, `maxBudget=0`, `maxBudget=1e308`, `maxBudget=null`, `maxBudget=undefined`, `maxBudget={}`, `maxBudget=[0.5]`, `maxBudget=Symbol(...)`, prototype pollution via `__proto__: { maxBudget: 0.5 }`? AR debe verificar que CD-22 se cumple sin gaps. Recomendación analyst: usar guard `Number.isFinite(x) && x > 0 && x < 1_000_000`.

4. **No-regression sign guard PYUSD** (ALTO impacto, BAJO prob): WKH-64 AC-11 es el cap guard. Si el orden cambia o el arg se reusa, podría fallar silenciosamente (e.g. always pass cap guard porque `args.maxAmountWei` ahora se pasa al balance-gate y queda undefined al cap guard). AR debe verificar que `args.maxAmountWei` sigue llegando al cap guard como antes. Test-2 cubre esto.

5. **Claim huérfano** (MEDIO impacto, BAJO prob): si `releaseClaim` no se llama en algún path, el claim queda huérfano hasta TTL 30s. Durante esos 30s, otros calls pueden ser falsamente rechazados con `concurrent claim exceeded`. AR debe verificar que TODOS los return paths del handler (success, sign error, settle error, redirect refused, exception inesperada en cualquier subpaso) ejecutan el `finally`. Test-5, Test-6 cubren los normales.

6. **Race condition entre probe y balance-gate** (MEDIO impacto, BAJO prob): el probe consume tiempo. Entre el probe y el balance-gate, la balance del operator puede cambiar (ej: cron de balance-check escribió un snapshot stale, o viene una settle de otro request en vuelo). El claim atómico KV mitiga esto pero el SDD F2 debe detallar el orden exacto y la fuente del balance read en cada paso.

7. **`payload.maxBudget` vs `maxAmountRequired` desalineados** (MEDIO impacto, MEDIO prob): el caller declara `maxBudget=0.5` USDC, pero el endpoint downstream pide `maxAmountRequired=10^18` PYUSD wei (≈$1 PYUSD ≈$1 USDC). El balance-gate aprueba (gasta hasta $0.50 USDC outbound) pero el endpoint quiere $1 PYUSD inbound. ¿Se firma una transacción que el caller no autorizó por monto? El sign guard PYUSD (cap guard) ejecutado DESPUÉS del balance-gate atrapa esto si `args.maxAmountWei` está seteado — pero si NO está seteado (default `maxAmountWeiDefault` from cfg), podría firmarse. AR debe verificar que el comportamiento default es seguro y/o documentar el contrato exacto: "maxBudget = ceiling absoluto en USDC outbound; maxAmountWei = ceiling defensivo en PYUSD inbound".

8. **Smoke real costoso** (MEDIO impacto, ALTO prob de re-run accidental): cada smoke gasta plata real. Si el dev/QA re-corre el smoke en CI o por error, drainea el wallet. CD-24 prohíbe múltiples runs sin autorización. F4 debe ejecutar EXACTAMENTE una vez con $0.061 documentado.

9. **Deploy URL drift** (BAJO impacto, BAJO prob): el deploy actual rolled-back es `wasiai-x402-ah0gufv0p`. Si el re-deploy genera URL distinta, los cron-job.org jobs apuntan al URL canonical (`wasiai-x402-mcp.vercel.app/api/mcp`) que es alias estable. Verificar que el alias se actualiza al nuevo deploy.

10. **Cron re-enable lag** (BAJO impacto, BAJO prob): los jobs disabled deben re-enable post-deploy. Si quedan disabled, el warmup no corre y el cold-start regresa, el balance-check no corre y la alert no dispara. AC-13 cubre el re-enable explícitamente.

11. **Schema MCP drift en consumers** (BAJO impacto, BAJO prob): Approach A NO rompe schema; pero si un consumer ya estaba pasando `maxAmountWei` con valor USDC (porque pensaba que era OUTBOUND), ahora el sign guard lo rechazará porque trata el valor como PYUSD. Esto es defensa en profundidad — el consumer estaba mal. Documentar en README explícitamente.

12. **Auto-blindaje placebo** (BAJO impacto, BAJO prob): si el doc de auto-blindaje queda genérico ("be careful with units"), no previene el class de bug. CD-25 exige patrón AR concreto (grep `args.maxAmountWei` y `payload.maxBudget` cross-use).

---

## Estado post-F1 (2026-04-29 modo AUTO)

- Approach A cementado.
- 15 ACs en EARS (10 funcionales + 3 no-regression + 2 operativos + 2 auto-blindaje/sign-off).
- Scope IN/OUT explícito (8 archivos IN, 11 archivos OUT del core).
- 9 DTs (3 cementados F1, 6 para F2).
- 25 CDs (19 heredados de WKH-66 con update, 6 nuevos en WKH-67).
- 12 categorías de riesgo para AR.
- Branch propuesto: `fix/072-wkh-67-balance-gate-decimals` desde `main@b095b80`.
- Pipeline: QUALITY firme.
- Listo para HU_APPROVED humano y luego F2 (architect).
