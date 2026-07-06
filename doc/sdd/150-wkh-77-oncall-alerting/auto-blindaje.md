# Auto-Blindaje — WKH-77 On-Call Alerting

Registro de errores/gotchas durante la implementación F3. Sin errores bloqueantes
en esta sesión; se documentan las trampas anticipadas para futuras HUs.

### [2026-07-05] Wave 2 — Registrar un cron nuevo rompe los asserts de conteo hardcodeados
- **Error potencial**: `setup-cronjob.test.mjs` tiene asserts con el número exacto
  de jobs (5 jobs, 5 PUT, "1 PATCH + 4 PUT", 5 líneas de stdout) y un
  `EXPECTED_TITLES` fijo. Agregar el 6º job (`wasiai-x402-health-check`) los
  invalida de golpe si no se actualizan a la par.
- **Causa raíz**: los tests fijan el contrato del set de jobs por conteo y por
  lista ordenada alfabéticamente, no por "contiene". Es intencional (regression
  guard), pero acopla cada nuevo job a esos números.
- **Fix**: actualizar en el mismo commit `EXPECTED_TITLES` (health-check va
  alfabético entre gas-balance-check e invalidate-prev-bearer), los conteos
  5→6 / 4→5 PUT, `r2patches` 5→6, y la lista de titles de T-CRJ-INT-05. Se agregó
  T-CRJ-INT-07 (schedule del nuevo job) y T-SC-07 (jobs ajenos intactos).
- **Aplicar en**: cualquier HU futura que registre un 7º job en
  `scripts/setup-cronjob.mjs` — buscar TODOS los asserts numéricos en
  `setup-cronjob.test.mjs`, no solo el más obvio.

### [2026-07-05] Wave 2 — Cadencia de cron-job.org: arrays de enteros, NO crontab strings (WKH-89)
- **Error potencial**: escribir `minutes: '*/4'` (crontab string) hace que
  cron-job.org registre el job como "Jan 1 yearly" (efectivamente deshabilitado)
  sin error visible.
- **Causa raíz**: la REST API de cron-job.org exige arrays de enteros
  (`-1` = "every"), documentado en WKH-89.
- **Fix**: el 6º job usa `minutes: [0,4,8,...,56]` (mismo patrón que warmup) y
  `-1` en el resto. Cubierto por T-CRJ-INT-07 (asserts `typeof === 'number'`).
- **Aplicar en**: todo job nuevo en `setup-cronjob.mjs`.

### [2026-07-06] Fix-pack — `reachability` NO puede tratar un 5xx como "vivo" (outage silencioso)
- **Error**: en `mode:'reachability'`, `_evaluateTarget` retornaba `ok` para
  CUALQUIER status HTTP. Un target Vercel que crashea devuelve 502/503/504 → el
  monitor lo reportaba sano → outage silencioso, justo lo que la HU existe para
  cazar. (`health-monitor.mjs:177-179`).
- **Causa raíz**: se equiparó "recibí una respuesta HTTP" con "el origin está
  sano". Cierto para 401/404 (ruta auth-protegida = origin vivo), FALSO para 5xx.
- **Fix**: en reachability distinguir por rango — `status >= 500` → DOWN al tier
  del target (mismo path que un target normal caído); `status < 500` → vivo/ok.
  Tests T-HM-16 (503 → down, 404 → ok).
- **Aplicar en**: cualquier chequeo de "reachability/ping" en el ecosistema — un
  5xx nunca es "vivo"; separar "hubo respuesta" de "el servicio está sano".

### [2026-07-06] Fix-pack — un monitor de outage debe paralelizar y acotar su PROPIA duración
- **Error**: `checkHealthTargets` chequeaba los targets en serie (`for...of` +
  `await`) → worst case N×timeout (~20s con 4 targets timeouteando). Sumado a que
  el cron `api/cron/health-check.mjs` NO estaba en `functions{}` de `vercel.json`
  (default ~10s), un outage total mataba la función → 502, viola CD-2 (siempre
  200) justo cuando más se necesita el monitor.
- **Causa raíz**: el path secuencial hace que la latencia del tick escale con la
  cantidad de servicios caídos; sin `maxDuration` explícito la plataforma corta
  la función antes de terminar.
- **Fix**: (1) `Promise.allSettled` sobre `targets.map(_processTarget)` — acota el
  tick a ~max(timeout) sin importar N, manteniendo aislamiento por target (cada
  `_processTarget` se auto-aísla, una promesa rechazada no aborta el conjunto,
  fail-open intacto, orden de resultados preservado). (2) `maxDuration:30` para
  `api/cron/health-check.mjs` en `vercel.json` (belt-and-suspenders). Test T-HM-17
  (N timeouts → tick ~1 timeout, todos probados).
- **Aplicar en**: todo cron/monitor que itere sobre N targets con I/O de red —
  paralelizar con allSettled (nunca `for await` en serie sobre red) y declarar
  `maxDuration` explícito en Vercel para que el propio monitor no muera bajo el
  outage que debe reportar.

### [2026-07-06] Fix-pack — la doc debe ser verdadera: mention en critical de gas + guard de mass-ping
- **Error**: (NIT-1) la doc afirmaba que `ONCALL_MENTION` aplica a TODAS las
  critical (health + gas), pero el cron de gas NO pasaba `mention` → las critical
  de gas nunca pusheaban. (MNR-4) un `ONCALL_MENTION=@everyone`/`@here` por typo
  hubiera fanout-eado un ping masivo en cada P0.
- **Fix**: threadear `mention` por `checkGasBalances` → `sendAlert` (gateado a
  critical-only por `alerts.mjs`); y en `_resolveSafeMention` rechazar/sanitizar
  valores que contengan `@everyone`/`@here` (tratados como sin-mention +
  `warnOnce`). Tests T-GM-06b y T-AL-PUSH-06. Fold-in NIT-2: quitado el field
  `label` duplicado del body de health (solo `service`).
- **Aplicar en**: cuando la doc promete un comportamiento cross-cutting (mismo
  sender para health+gas), verificar que TODOS los call-sites lo cumplen; y todo
  input de config que se convierte en destinatario de notificación debe validarse
  contra valores de fanout masivo.

### [2026-07-05] Wave 0 — `content` de Discord es campo estructural, fuera del whitelist del body
- **Nota de diseño**: el push real de P0 se logra con un `content` a nivel raíz
  del payload de Discord (los embeds NO notifican). Ese `content` NO pasa por
  `sanitizeAlertBody` / `ALLOWED_BODY_KEYS` — es un campo estructural. Por eso el
  texto es genérico + el mention token; NUNCA se interpola body ahí para no
  arriesgar fuga de secrets. Solo se agrega en `severity === 'critical'` y con
  `ONCALL_MENTION` no vacío (graceful si falta).
- **Aplicar en**: futuras extensiones del sender compartido `alerts.mjs` — no
  meter datos del body en `content`; mantenerlo genérico.
