# Auto-Blindaje — WKH-71 Operator Wallet Alert

### [2026-07-05 21:00] FIX-PACK — BLQ-1: validar ≠ parsear + config-resolution fuera del try
- **Error**: `_resolveNative` en `gas-monitor.mjs` validaba el umbral con
  `Number.isFinite(parsed) && parsed >= 0` pero devolvía el STRING crudo. Strings
  como `"0.5 "` (espacio final), `"1e-6"` (notación científica) y `"0.1.2"` (doble
  punto) pasan ese guard pero hacen que `parseEther` LANCE `InvalidDecimalNumberError`.
  Como `resolveThresholds` corría FUERA del try/catch per-combo del loop, ese throw
  escapaba TODO el loop → el cron devolvía `{checked:0, results:[]}` → monitor en
  blackout, sin alertas (justo el modo de falla que la HU existe para matar; viola AC-6).
- **Causa raíz**: (1) confundir "es un número finito" con "es parse-safe para parseEther"
  — el conjunto de strings que `Number.parseFloat` acepta es estrictamente mayor que el
  que `parseEther` acepta. (2) Resolver config (thresholds/rpc) fuera del try/catch que
  supuestamente aísla cada combo — el docstring prometía aislamiento AC-6 que el código
  no cumplía para errores de config.
- **Fix**: (1) Sanitización parse-safe real con regex `^\d+(\.\d+)?$` — rechaza
  whitespace/científica/multi-punto/signo y cae al default de la chain con
  `log.warn(reason:'invalid-threshold-value')` en vez de propagar. (2) Se movió
  `resolveThresholds`/`resolveRpcUrl` DENTRO del try/catch per-combo: ningún error de
  config de un combo aborta los demás. Tests negativos `"0.5 "`/`"1e-6"`/`"0.1.2"`
  (T-GM-13/14) confirman no-throw + fallback + no-blackout.
- **Aplicar en**: Todo guard que valide un string antes de pasarlo a un parser estricto
  (parseEther, parseUnits, BigInt, new URL, JSON.parse) — validar con el MISMO criterio
  que el parser, o directamente probar el parse dentro de try. Y toda resolución de
  config dentro de un loop "aislado por item" debe vivir dentro del try/catch, no antes.

### [2026-07-05 18:30] Wave 1 — `src/lib/gasless-signer.ts` no existe
- **Error**: El work-item (AC-3) y el prompt del orquestador nombran
  `src/lib/gasless-signer.ts` como uno de los puntos donde `OPERATOR_PRIVATE_KEY`
  firma/transfiere. Ese archivo NO existe — solo existe `src/lib/gasless-signer.test.ts`,
  que en realidad importa de `src/adapters/kite-ozone/gasless.ts`.
- **Causa raíz**: El nombre "gasless-signer" es conceptual; el flujo gasless real
  vive en los adapters. Además, el gas del operador se gasta on-chain vía
  `writeContract` en `src/adapters/{avalanche,base}/gasless.ts` (el operador paga su
  propio gas) — NO en kite-ozone (ahí el relayer gokite paga el gas, el operador solo
  firma EIP-3009 off-chain, sin gas).
- **Fix**: Se implementó AC-3 donde el operador realmente gasta gas nativo: el catch
  de `submit failed` (writeContract) en `avalanche/gasless.ts` y `base/gasless.ts`,
  además de `fee-charge.ts`. NO se tocó kite-ozone (no aplica: operador sin gas ahí).
  Se creó un clasificador compartido `src/lib/operator-funding.ts`.
- **Aplicar en**: Cuando un work-item nombre un archivo por concepto, verificar su
  existencia real con Grep antes de asumir el path; mapear al punto donde el
  invariante (aquí: gasto de gas del operador) ocurre de verdad.

### [2026-07-05 18:30] Wave 0 — Biome import ordering + formatting
- **Error**: `operator-funding.test.ts` falló `biome check` (assist/organizeImports:
  imports nombrados sin ordenar alfabéticamente + wrapping de líneas).
- **Causa raíz**: Escribí los imports en orden semántico (constantes primero) en vez
  del orden alfabético que exige biome; y un `expect(...)` de una línea que biome
  reformatea a multilínea.
- **Fix**: `biome check --write` sobre el archivo (safe fix). Re-verificado con
  `biome check src/lib/` = 0.
- **Aplicar en**: Todo archivo TS nuevo — correr `biome check --write` antes del gate
  final; imports nombrados en orden alfabético (mayúsculas y minúsculas mezcladas
  siguen el orden de biome: `classifyOperatorError` antes que `OPERATOR_...`).

### [2026-07-05 18:30] Wave 2 — Test de setup-cronjob esperaba 4 jobs
- **Error**: Al agregar el 5º cron job (`wasiai-x402-gas-balance-check`),
  `tests/setup-cronjob.test.mjs` falló 4 tests (T-SC-01/02/03/05) que hardcodeaban
  "4 jobs" / counts de PUT/PATCH / `EXPECTED_TITLES`.
- **Causa raíz**: El test es un contrato de cantidad exacta de jobs; agregar uno lo
  rompe por diseño (guardrail contra jobs fantasma).
- **Fix**: Se actualizó `EXPECTED_TITLES` (+ gas-balance-check, alfabético), los counts
  (5 jobs, 5 PUT, 5 PATCH en re-run, 4 PUT + 1 PATCH en update) y se agregó
  `T-CRJ-INT-06` verificando schedule 15-min (arrays enteros, WKH-89), GET y bearer.
- **Aplicar en**: Al extender `TARGET_JOBS` en setup-cronjob.mjs, actualizar SIEMPRE
  el test de contrato en el mismo commit (count + titles + un INT test del nuevo job).
