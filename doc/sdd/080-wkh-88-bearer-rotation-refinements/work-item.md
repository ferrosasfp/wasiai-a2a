# Work Item — [WKH-88] Bearer Rotation Refinements (HTTP method gate + JSDoc + tests)

## Resumen

Carry-forward de 9 MNRs del sprint WKH-75 (DONE clean 2026-05-02). Se aplican cuatro
mejoras de calidad al sistema de rotación de bearer token en el MCP server wasiai-x402:
(1) defensa en profundidad HTTP method gate (POST-only) en ambos endpoints cron,
(2) KV mutex NX-flagged para prevenir escrituras concurrentes de `MCP_BEARER_TOKEN_PREV`,
(3) JSDoc completo en `rotateBearer()`, y (4) extracción de constantes KV duplicadas a
`src/kv-keys.mjs`. Cobertura de tests extendida para cubrir los caminos que quedaron
sin test dedicado post-WKH-75.

Pipeline: **FAST+AR** — toca security surface (auth path en endpoints + race condition KV).

---

## Sizing

- SDD_MODE: mini
- Estimación: S (~85 LOC netos; 6 archivos tocados + 1 nuevo)
- Branch sugerido: `feat/080-wkh-88-bearer-rotation-refinements`
- Base: `main` (post-WKH-89, commit `d00c0c8`)

---

## Acceptance Criteria (EARS)

- **AC-1 (HTTP method gate — rotate)**: WHEN `rotate-bearer` endpoint receives a
  non-POST request (GET, PUT, DELETE, OPTIONS, etc.) with any Authorization header,
  the system SHALL return HTTP 405 `{"error":"method not allowed"}` before evaluating
  auth, regardless of whether CRON_SECRET is valid.

- **AC-2 (HTTP method gate — invalidate)**: WHEN `invalidate-prev-bearer` endpoint
  receives a non-POST request (GET, PUT, DELETE, OPTIONS, etc.) with any Authorization
  header, the system SHALL return HTTP 405 `{"error":"method not allowed"}` before
  evaluating auth, regardless of whether CRON_SECRET is valid.

- **AC-3 (KV mutex — concurrent rotation)**: WHEN `rotateBearer()` is called while
  another rotation is in progress (KV NX-flagged mutex key already set), the system
  SHALL return `{ok:false, stage:'mutex', reason:'rotation already in progress'}` and
  SHALL NOT proceed to any Vercel API call or write `MCP_BEARER_TOKEN_PREV`.

- **AC-4 (JSDoc — rotateBearer)**: the system SHALL expose `rotateBearer()` with full
  JSDoc including `@param` shapes for all five parameters (vercelToken, projectId,
  teamId, alertWebhookUrl, kvClient), `@returns` shape documenting both success variant
  `{ok:true, rotatedAt, expiresAt}` and all error variants `{ok:false, stage, reason}`,
  and `@throws` declaration stating the function never throws (per CD-12).

- **AC-5 (kv-keys.mjs — zero duplication)**: WHILE `src/kv-keys.mjs` exists and
  exports `KV_KEYS` as a const-frozen object, the system SHALL import `KV_KEYS`
  from `src/kv-keys.mjs` in both `src/bearer-rotation.mjs` and
  `api/cron/invalidate-prev-bearer.mjs`, with zero remaining inline
  `const KV_KEY = 'last-bearer-rotation'` declarations in those two files.

- **AC-6 (T-CIN-05 — NaN guard test)**: WHEN `invalidate-prev-bearer` handler is
  called and the KV mock returns a snapshot where `expiresAt` is the string
  `'not-a-date'`, the system SHALL return `{ok:true, skipped:true,
  reason:'snapshot expiresAt unparseable'}` without triggering any Vercel API call.

- **AC-7 (test baseline preserved)**: WHEN `npm test` is executed after all changes,
  the system SHALL pass a minimum of 244 tests (232 WKH-75 baseline + new tests added
  by this work item) with zero regressions.

---

## Scope IN

| File | Change |
|------|--------|
| `mcp-servers/wasiai-x402/api/cron/rotate-bearer.mjs` | Add `req.method !== 'POST'` gate as first check (before auth) |
| `mcp-servers/wasiai-x402/api/cron/invalidate-prev-bearer.mjs` | Add `req.method !== 'POST'` gate as first check (before auth); replace inline `KV_KEY` with `KV_KEYS` import |
| `mcp-servers/wasiai-x402/src/bearer-rotation.mjs` | Add full JSDoc to `rotateBearer()`; add KV mutex NX guard (S0-pre step); replace inline `KV_KEY` with `KV_KEYS` import |
| `mcp-servers/wasiai-x402/src/kv-keys.mjs` | **NEW** — export `Object.freeze({ LAST_ROTATION: 'last-bearer-rotation', ROTATION_MUTEX: 'rotation-mutex' })` |
| `mcp-servers/wasiai-x402/tests/cron-rotate-bearer.test.mjs` | Add T-MTHD-01: GET→405, POST→continues normally |
| `mcp-servers/wasiai-x402/tests/cron-invalidate-prev-bearer.test.mjs` | Add T-MTHD-02: GET→405; add T-CIN-05: NaN expiresAt guard |
| `mcp-servers/wasiai-x402/tests/bearer-rotation.test.mjs` | Add T-MUTEX-01: concurrent call → mutex skip |

---

## Scope OUT

- MNR-AR-3 (User-Agent / CSRF gate en cron endpoints) — explícitamente deferido
  "aceptable post-hackathon" en el AR original; NO se implementa aquí.
- MNR-CR-1 (commit de work-item/sdd/story de WKH-75) — trazabilidad cubierta por
  WKH-88 mismo; no requiere cambios de código.
- MNR-CR-5 (comment cosmético sobre KV_TTL_SECONDS = 25h) — no-priority; el SDD
  puede aclararlo en notas pero no es un AC propio.
- Cualquier cambio a `src/cron-auth.mjs`, `src/vercel-env.mjs`, o archivos fuera de
  `mcp-servers/wasiai-x402/`.
- RLS a nivel base de datos (tabla `a2a_agent_keys`) — fuera de alcance, trackeado
  en WKH-SEC-02.

---

## Decisiones técnicas

- **DT-1 (method gate antes de auth)**: El check `req.method !== 'POST'` DEBE
  preceder a `validateCronSecret()`. Razón: no se deben emitir log lines de "unauthorized"
  para peticiones que ni siquiera deberían llegar al endpoint — información leakage mínima
  y semántica HTTP correcta (405 es método incorrecto, no auth failure). CD-WKH88-1.

- **DT-2 (KV mutex con NX flag + TTL corto)**: La primitiva de mutex debe ser un
  `kvClient.set(MUTEX_KEY, rotatedAt, { nx: true, ex: 300 })`. Si retorna `null`/falsy,
  la rotación ya está en curso y se retorna early. TTL de 5 min es suficiente para que
  una rotación completa termine y no deje un mutex permanente bloqueado. Compatible con
  Upstash Redis (NX set es estándar). CD-WKH88-2.

- **DT-3 (kv-keys.mjs como frozen object)**: Exportar `Object.freeze({...})` en lugar
  de strings sueltos evita mutación accidental en runtime. Los consumidores acceden via
  `KV_KEYS.LAST_ROTATION` y `KV_KEYS.ROTATION_MUTEX`. CD-WKH88-3.

- **DT-4 (T-MUTEX-01 con mock KV NX)**: El test de mutex debe mockear `kvClient.set`
  para retornar `null` en la primera llamada (mutex ya tomado) y verificar que ninguna
  función de `vercel-env.mjs` es llamada. No requiere concurrencia real — el mock simula
  la condición de carrera determinísticamente. CD-WKH88-4.

---

## Constraint Directives (CD)

### Heredados de WKH-75 (aplicables a esta HU)

- **CD-9**: NEVER log `MCP_BEARER_TOKEN`, `MCP_BEARER_TOKEN_PREV`, `VERCEL_TOKEN`,
  `CRON_SECRET`, ni fragmentos derivados en ningún log line.
- **CD-12**: `rotateBearer()` NEVER throws. Todos los caminos de error retornan
  `{ok:false, stage, reason}`. Cualquier excepción interna se captura y convierte.
- **CD-15**: NEVER incluir `CRON_SECRET` ni `MCP_BEARER_TOKEN` en stdout/stderr
  de error output.

### Nuevos en WKH-88

- **CD-WKH88-1**: El check `req.method !== 'POST'` MUST aparecer como el primer
  statement ejecutable del handler, antes de cualquier llamada a `validateCronSecret`
  o log line de auth.

- **CD-WKH88-2**: El KV mutex MUST usar la primitiva NX-flagged (`{nx:true, ex:N}`)
  compatible con cron-job.org + Upstash Redis. PROHIBIDO usar `if (await kv.get(mutex))`
  (read-then-write — no es atómica).

- **CD-WKH88-3**: `src/kv-keys.mjs` MUST exportar un `const`-frozen object
  (`Object.freeze({...})`). PROHIBIDO exportar funciones que retornan strings o
  exports sueltos no agrupados.

- **CD-WKH88-4**: T-CIN-05 MUST inyectar `expiresAt: 'not-a-date'` directamente
  en el mock del KV client (el mock retorna el snapshot con el valor corrupto).
  PROHIBIDO corromper `Date` o `Date.parse` via monkey-patch global.

- **CD-WKH88-5**: T-MTHD-01 y T-MTHD-02 MUST verificar que el response code es 405
  Y que el body contiene `{error:'method not allowed'}` Y que `validateCronSecret`
  no fue llamado (spy/mock verificable).

- **CD-WKH88-6**: El mutex key (`ROTATION_MUTEX`) MUST tener un TTL máximo de 10
  minutos. PROHIBIDO omitir el `ex` / `px` en el set NX — un mutex sin TTL bloquea
  permanentemente ante crash del cron worker.

- **CD-WKH88-7**: PROHIBIDO agregar nuevas dependencias npm. Todo lo necesario
  (`node:crypto`, `@upstash/redis`, Node.js test runner nativo) ya existe en el
  package.json.

---

## Missing Inputs

- [resuelto en F2] Nombre exacto del mutex KV key — sugerido `'rotation-mutex'`
  en `kv-keys.mjs`; Architect confirma o ajusta.
- [resuelto en F2] TTL del mutex: 5 min vs 10 min — DT-2 propone 5 min, CD-WKH88-6
  fija el máximo en 10 min; Architect decide el valor exacto.
- [TBD] Verificar si los test files `cron-rotate-bearer.test.mjs` y
  `cron-invalidate-prev-bearer.test.mjs` ya existen o requieren ser creados desde cero —
  Architect grounding en F2.

---

## Análisis de paralelismo

- WKH-88 NO bloquea otras HUs activas (todas las demás tocan `src/` principal del
  gateway, no `mcp-servers/wasiai-x402/`).
- WKH-88 es successor directo de WKH-75 (DONE) y WKH-89 (DONE, fix crontab strings).
  Puede arrancarse en paralelo con cualquier HU del gateway principal.
- Si WKH-88 crea `src/kv-keys.mjs`, NO hay conflicto con ningún archivo existente
  (archivo nuevo, no toca nada del gateway).

---

## Skills Router

- **domain/security** — method gate antes de auth, KV mutex atómico, CD-WKH88-1..6
- **domain/testing** — T-MTHD-01/02, T-CIN-05, T-MUTEX-01 con mocks determinísticos

---

## Referencias

| Artefacto | Ruta |
|-----------|------|
| WKH-75 DONE report | `doc/sdd/076-wkh-75-bearer-rotation-cron/done-report.md` |
| WKH-89 DONE report | `doc/sdd/079-wkh-89-cronjob-schedule-fix/done-report.md` |
| rotate-bearer endpoint | `mcp-servers/wasiai-x402/api/cron/rotate-bearer.mjs` |
| invalidate-prev-bearer endpoint | `mcp-servers/wasiai-x402/api/cron/invalidate-prev-bearer.mjs` |
| bearer-rotation core | `mcp-servers/wasiai-x402/src/bearer-rotation.mjs` |
| kv-keys (nuevo) | `mcp-servers/wasiai-x402/src/kv-keys.mjs` |
