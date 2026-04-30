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
