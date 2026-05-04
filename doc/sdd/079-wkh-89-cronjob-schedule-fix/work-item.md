# Work Item — [WKH-89] BUG: setup-cronjob.mjs sends crontab strings to cron-job.org API (expects integer arrays)

## Resumen

`mcp-servers/wasiai-x402/scripts/setup-cronjob.mjs` define los schedules de los 4 cron jobs usando sintaxis crontab (`'*/4'`, `'*'`, `'*/30'`). La API REST de cron-job.org NO entiende crontab — requiere arrays de enteros donde `-1` significa "every". El resultado actual: los 4 jobs fueron registrados con schedule efectivo "Jan 1 yearly" (disabled). Bearer rotation (WKH-75) nunca se ha ejecutado automáticamente. Se aplicó un workaround manual via API directa el 2026-05-04, pero la próxima ejecución de `setup-cronjob.mjs` revertirá el fix. Este work item corrige el bug permanentemente y endurece los tests para que detecten regresiones de tipo de payload antes de afectar producción.

---

## Sizing

- **SDD_MODE:** mini (bugfix en un solo script + tests, sin cambios de arquitectura)
- **Estimación:** S
- **Pipeline:** FAST+AR (toca infraestructura de cron — rotation gate de producción)
- **Branch sugerido:** `feat/079-wkh-89-cronjob-schedule-fix` desde `main` HEAD (post-WKH-90 merge)

---

## Acceptance Criteria (EARS)

- **AC-1:** WHEN `setup-cronjob.mjs` construye el payload para el job `wasiai-x402-warmup`, the system SHALL send `schedule: { minutes: [0,4,8,12,16,20,24,28,32,36,40,44,48,52,56], hours: [-1], mdays: [-1], months: [-1], wdays: [-1] }` al cuerpo JSON de la petición PUT/PATCH a `api.cron-job.org`.

- **AC-2:** WHEN `setup-cronjob.mjs` construye el payload para el job `wasiai-x402-balance-check`, the system SHALL send `schedule: { minutes: [0,15,30,45], hours: [-1], mdays: [-1], months: [-1], wdays: [-1] }` al cuerpo JSON de la petición PUT/PATCH a `api.cron-job.org`.

- **AC-3:** WHEN `setup-cronjob.mjs` construye el payload para el job `wasiai-x402-bearer-rotation`, the system SHALL send `schedule: { minutes: [0], hours: [9], mdays: [1], months: [-1], wdays: [-1] }` al cuerpo JSON de la petición PUT/PATCH a `api.cron-job.org`.

- **AC-4:** WHEN `setup-cronjob.mjs` construye el payload para el job `wasiai-x402-invalidate-prev-bearer`, the system SHALL send `schedule: { minutes: [0], hours: [10], mdays: [-1], months: [-1], wdays: [-1] }` al cuerpo JSON de la petición PUT/PATCH a `api.cron-job.org`.

- **AC-5:** WHEN el script `setup-cronjob.mjs` es ejecutado contra el estado actual de cron-job.org (jobs 7547879/7547880/7558205/7558208 con schedules del workaround del 2026-05-04), the system SHALL producir zero schedule drift — los schedules enviados en el PATCH deben coincidir byte-a-byte con los schedules del workaround aplicado manualmente.

- **AC-6:** WHEN los tests unitarios en `tests/setup-cronjob.test.mjs` son ejecutados con `node --test`, the system SHALL assertar que cada uno de los 4 payloads enviados a `fetch` contiene arrays de enteros (no strings con crontab syntax) en todos los campos de `schedule`, y el test runner SHALL reportar 0 failures.

- **AC-7:** IF algún valor en cualquier campo `schedule` de `TARGET_JOBS` es de tipo `string` (e.g. `'*/4'`, `'*'`), THEN the unit tests SHALL fail con un mensaje que identifique el job title y el campo inválido.

---

## Scope IN

- `mcp-servers/wasiai-x402/scripts/setup-cronjob.mjs` — reemplazar los 4 objetos `schedule` en `TARGET_JOBS` con arrays de enteros según DT-1 a DT-4. Sin cambios a la lógica de `main()`, `createJob()`, `updateJob()`, ni `listJobs()`.
- `mcp-servers/wasiai-x402/tests/setup-cronjob.test.mjs` — crear o actualizar con tests que interceptan el JSON body enviado a `fetch` y assertan: (a) todos los campos de `schedule` son arrays de enteros, (b) los valores exactos de cada job coinciden con los definidos en DT-1 a DT-4.

---

## Scope OUT

- `mcp-servers/wasiai-x402/api/cron/*.mjs` — los endpoints de cron no cambian.
- `mcp-servers/wasiai-x402/src/bearer-rotation.mjs` — no cambia.
- `mcp-servers/wasiai-x402/src/cron-auth.mjs` — no cambia.
- Ningún archivo en `src/` del proyecto raíz.
- README.md — los schedules semánticos no cambian (solo se corrige la representación en el script).
- Jobs en cron-job.org — el fix al script los corregirá automáticamente en la próxima ejecución; no se requiere acción manual adicional.

---

## Decisiones técnicas (DT-N)

- **DT-1 (warmup schedule):** `every 4 min` se expande a `minutes: [0,4,8,12,16,20,24,28,32,36,40,44,48,52,56]` (14 valores, múltiplos de 4 del 0 al 56), `hours: [-1], mdays: [-1], months: [-1], wdays: [-1]`. Justificación: cron-job.org requiere la lista explícita de minutos; `-1` en los demás campos equivale a "any". No se usa helper de expansión — los arrays se definen inline para máxima legibilidad y auditabilidad. El workaround manual del 2026-05-04 usó este mismo array, garantizando zero drift (AC-5).

- **DT-2 (balance-check schedule):** `every 15 min` se mapea a `minutes: [0,15,30,45]`, `hours: [-1], mdays: [-1], months: [-1], wdays: [-1]`. Justificación: 4 valores exactos, sin ambigüedad. Consistente con el workaround activo.

- **DT-3 (bearer-rotation schedule):** `every 30 days at 09:00 UTC` se implementa como `minutes: [0], hours: [9], mdays: [1], months: [-1], wdays: [-1]` (1er día de cada mes a las 09:00 UTC). Justificación: cron-job.org no soporta "cada N días" con un offset arbitrario — el 1ro del mes es la aproximación estándar para ciclos mensuales. El comentario original del script (`every 30 days`) se actualiza en el código fuente para reflejar la semántica real. Consistente con el workaround activo.

- **DT-4 (invalidate-prev-bearer schedule):** `daily at 10:00 UTC` se mapea a `minutes: [0], hours: [10], mdays: [-1], months: [-1], wdays: [-1]`. Justificación: schedule trivial, sin ambigüedad. Consistente con el workaround activo.

---

## Constraint Directives (CD-N)

- **CD-1:** PROHIBIDO usar strings crontab (`'*/N'`, `'*'`) en ningún campo de `schedule` de `TARGET_JOBS`. OBLIGATORIO usar arrays de integers.

- **CD-2:** PROHIBIDO agregar una función helper de expansión crontab en este fix. Los arrays se definen inline en `TARGET_JOBS`. Un helper agrega indirección que obscurece el bug original; la claridad es prioridad.

- **CD-3:** PROHIBIDO modificar la lógica de `main()`, `createJob()`, `updateJob()`, o `listJobs()`. El cambio es exclusivamente en los literales de `schedule` dentro de `TARGET_JOBS`.

- **CD-4:** OBLIGATORIO que los tests intercepten el `body` JSON real enviado a `fetch` (el argumento `init.body`), no solo assertar que `fetch` fue llamado. Tests que solo verifican "fetch was called" no detectan el bug original.

- **CD-5:** PROHIBIDO loggear `CRONJOB_ORG_API_TOKEN` ni `CRON_SECRET` en ningún path (stdout, stderr, mensajes de error de tests). Heredado de CD-15 del script original.

- **CD-6:** OBLIGATORIO que el test file sea ejecutable con `node --test tests/setup-cronjob.test.mjs` sin variables de entorno reales (el test harness debe mockear `fetch` y las env vars).

- **CD-7:** OBLIGATORIO actualizar el comentario inline del job `wasiai-x402-bearer-rotation` en el script para reflejar que el schedule real es "1st of month at 09:00 UTC", no "every 30 days". No mentir en los comentarios.

- **CD-8:** PROHIBIDO crear, modificar o leer archivos fuera de `mcp-servers/wasiai-x402/scripts/` y `mcp-servers/wasiai-x402/tests/` durante la implementación de este work item.

---

## Missing Inputs

- [resuelto en F2] Confirmar si `tests/setup-cronjob.test.mjs` ya existe en el repo o debe crearse desde cero. (El script setup existe; el test file podría no existir dado que los tests previos de WKH-75 se focalizaron en `bearer-rotation.mjs`.)

---

## Análisis de paralelismo

- Esta HU NO bloquea otras HUs activas.
- Puede correr en paralelo con cualquier HU que no toque `mcp-servers/wasiai-x402/scripts/` o `mcp-servers/wasiai-x402/tests/`.
- URGENCIA: bearer rotation nunca ha ejecutado automáticamente. El workaround manual es frágil — la próxima ejecución accidental de `setup-cronjob.mjs` revierte el fix. Prioridad: ALTA.
- Riesgo post-merge: zero (cambio de literales + tests, sin lógica de producción nueva).
