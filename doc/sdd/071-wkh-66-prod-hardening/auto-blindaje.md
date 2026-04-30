# Auto-Blindaje — WKH-66

Errores cometidos durante F3 + fix aplicado + dónde más podría ocurrir.

### [2026-04-29 W1] node:crypto module is frozen — cannot monkey-patch

- **Error**: `Cannot assign to read only property 'timingSafeEqual' of object '[object Module]'`
  en `tests/cron-auth.test.mjs` T-CA-05.
- **Causa raíz**: `import * as crypto from 'node:crypto'` retorna un Module frozen.
  No se puede asignar `crypto.timingSafeEqual = ...` para spy. Difiere de CommonJS
  donde `require('node:crypto').timingSafeEqual = jest.fn()` funcionaba.
- **Fix**: reemplazado spy por behavioural assertion — same-length-wrong-byte
  llega a `timingSafeEqual` y retorna false → 401. Source review confirma que
  ese es el único comparator usado.
- **Aplicar en**: cualquier futuro test que pretenda spy módulos node:* (crypto, fs,
  http, etc). Usar dependency injection o behavioural tests, NO mutación del
  Module namespace.

### [2026-04-29 W3] orphan setTimeout en fetch mock bloquea test runner 60s

- **Error**: `node --test tests/alerts.test.mjs` reportaba `pass 5, duration_ms
  60088` aunque cada test individual era <200ms.
- **Causa raíz**: el mock de fetch para T-AL-01 tenía `setTimeout(() =>
  resolve(...), 60_000)` "para que nunca resuelva y dispare el abort". Aunque
  el AbortSignal disparaba `reject()` correctamente, el `setTimeout` quedaba
  pendiente y mantenía el event loop vivo hasta agotar 60s.
- **Fix**: capturar handle de setTimeout y `clearTimeout()` adentro del
  abort listener. NO usar `unref()` porque cancela los demás tests.
- **Aplicar en**: cualquier test que use `setTimeout` con un abort listener
  (chaos.test.mjs, cron-balance-check.test.mjs T-BC-03, etc). Patrón
  obligatorio: `clearTimeout(t)` adentro del `addEventListener('abort', ...)`.

### [2026-04-29 fix-pack 1/3] Redis-TTL ≠ data freshness — stale snapshot defeats balance gate (BLQ-ALTO-1)

- **Error**: `src/balance-guard.mjs` confiaba en cualquier snapshot que
  estuviera presente en KV. El cron escribe TTL Redis 1800s (30 min) pero el
  SDD prometía freshness 30s. Tras un drain externo entre runs del cron, el
  gate aprobaba calls contra balance "fantasma" durante hasta ~15 min.
- **Causa raíz**: confusión entre TTL de eviction de Redis (anti-OOM) y
  ventana de freshness de la app (anti-stale-decision). El cron escribió
  TTL largo para asegurarse de que el snapshot no desapareciera entre runs
  de cron-job.org; pero el código de lectura interpretó "presente en KV =
  trustable", saltándose la validación de `checkedAt`.
- **Fix**: en `checkBalanceWithClaim` — leer `checkedAt`, calcular `ageMs =
  Date.now() - new Date(checkedAt).getTime()`, y solo confiar si
  `Number.isFinite(ageMs) && 0 ≤ ageMs ≤ SNAPSHOT_FRESH_MS (30_000)`. Si el
  blob no tiene `checkedAt`, si el ageMs es negativo (clock skew), o si
  excede 30s → log `mcp.balance.snapshot-stale` y caer al RPC. El RPC
  refresca el snapshot al final del path "fallback".
- **Aplicar en**: cualquier futuro caché-de-decisión donde la TTL de
  storage sea más larga que la ventana de validez del dato. Patrón
  obligatorio: `if (data.timestamp && Date.now() - data.timestamp <=
  FRESH_MS) trust; else refetch`. NO confiar en el TTL del backend de
  storage como freshness signal.

### [2026-04-29 fix-pack 1/3] T-CH-11 testing-the-wrong-thing (false positive)

- **Error**: `tests/chaos.test.mjs:287-308` "T-CH-11 KV stale data → re-fetches
  RPC" pasaba pero NO ejercitaba la lógica de freshness check. Usaba
  `staleData` del kv-mock, que setea `expiresAt: _now() - 1` → al hacer
  `kv.get(key)` el mock purga la entry y devuelve null → el código cae al
  RPC porque "no hay snapshot", NO porque "snapshot es viejo".
- **Causa raíz**: el mock interpretaba "stale" como Redis-expired
  (legítimo eviction) cuando lo que el SDD describía era "Redis-fresh,
  data-stale" (TTL bien, pero `checkedAt` viejo).
- **Fix**: T-CH-11 ahora usa `kv.set(key, blob, { ex: 1500 })` con
  `checkedAt: 60s atrás`. Esto fuerza la rama de freshness check (la que
  el bug BLQ-ALTO-1 dejaba sin cobertura).
- **Aplicar en**: cualquier test cuya pre-condición incluya "stale" / "old"
  / "expired" — verificar EXACTAMENTE qué semántica testea el mock. Diff
  el assertion contra el call-graph; si el code path bajo prueba nunca se
  ejecuta porque algo upstream cortocircuita, el test pasa por la razón
  equivocada.

### [2026-04-29 fix-pack 1/3] threshold env not validated → silent gate bypass

- **Error**: `runWithBalanceGate` en `api/mcp.mjs` y el cron en
  `api/cron/balance-check.mjs` hacían `parseFloat(process.env...)` sin
  validar. `parseFloat('abc')` retorna NaN → `NaN < x` y `x < NaN` son
  ambos `false` → la comparación `balanceUsdc < threshold` da false →
  gate aprueba. `parseFloat('-1')` retorna -1 → cualquier balance positivo
  pasa el threshold check.
- **Causa raíz**: confianza ciega en variables de entorno + parseFloat
  silencioso. `parseFloat` nunca tira; convierte basura en NaN.
- **Fix**: agregar guard `Number.isFinite(threshold) && threshold >= 0`
  inmediatamente después del parseFloat. En `runWithBalanceGate`, retorna
  `{ ok:false, stage:'balance-gate', error:'invalid threshold config' }`.
  En el cron, retorna 500 + log estructurado. Tests T-BG-11 y T-BG-11b
  cubren NaN y negativo.
- **Aplicar en**: TODA conversión `parseFloat` / `parseInt` / `Number()`
  desde env vars o input externo. Patrón: `const x = Number(raw); if
  (!Number.isFinite(x) || x < min || x > max) reject(...)`.
