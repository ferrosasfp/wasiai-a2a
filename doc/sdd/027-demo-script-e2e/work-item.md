# Work Item -- [WKH-30] Demo Script E2E

## Resumen

Script de smoke test automatizado que valida todos los endpoints clave de WasiAI A2A en secuencia. Permite a jueces del hackathon Kite (y a CI) verificar que el release funciona con un solo comando. No modifica codigo de produccion: solo agrega un script nuevo y documentacion en README.

## Sizing

- SDD_MODE: mini
- Estimation: S (1-2 archivos nuevos, 0 cambios en produccion)
- Branch sugerido: feat/027-demo-script-e2e
- Skills: [cli-scripting, api-testing]

## Acceptance Criteria (EARS)

- AC-1: WHEN the user runs `./scripts/smoke-test.sh` without arguments, the system SHALL use `https://wasiai-a2a-production.up.railway.app` as BASE_URL by default.
- AC-2: WHEN the user runs `./scripts/smoke-test.sh <url>`, the system SHALL use the provided URL as BASE_URL.
- AC-3: WHEN the script executes, the system SHALL hit each endpoint sequentially and print PASS or FAIL per endpoint with the HTTP status code.
- AC-4: WHEN all endpoints return expected responses, the script SHALL exit with code 0.
- AC-5: IF any endpoint returns an unexpected status or missing expected field, THEN the script SHALL print FAIL for that endpoint and exit with code 1 after completing all checks.
- AC-6: WHEN `GET /` is hit, the system SHALL verify HTTP 200 and JSON body containing `name` and `version` fields.
- AC-7: WHEN `GET /.well-known/agent.json` is hit, the system SHALL verify HTTP 200 and JSON body containing `name` and `skills` fields.
- AC-8: WHEN `GET /gasless/status` is hit, the system SHALL verify HTTP 200 and JSON body containing `funding_state` field.
- AC-9: WHEN `GET /dashboard` is hit, the system SHALL verify HTTP 200 and response containing HTML content.
- AC-10: WHEN `GET /dashboard/api/stats` is hit, the system SHALL verify HTTP 200 and JSON body containing `registriesCount` field.
- AC-11: WHEN `POST /auth/agent-signup` is hit with a valid body, the system SHALL verify HTTP 201 and response containing a key starting with `wasi_a2a_`.
- AC-12: WHEN `GET /auth/me` is hit with the key from AC-11, the system SHALL verify HTTP 200 and response containing key status information.
- AC-13: WHEN `POST /discover` is hit, the system SHALL verify HTTP 200 and response containing an agents array.
- AC-14: WHERE compose/orchestrate endpoints require x402 payment, the script SHALL skip those steps with a SKIP label and not count them as FAIL.

## Scope IN

- `scripts/smoke-test.sh` -- nuevo archivo, bash script
- `README.md` -- agregar seccion "Smoke Test / Demo" con instrucciones de uso

## Scope OUT

- Cambios en codigo de produccion (`src/`)
- Migraciones de base de datos
- Nuevos endpoints
- Tests unitarios (el script ES el test E2E)
- CI/CD integration (puede ser un follow-up)

## Decisiones tecnicas (DT-N)

- DT-1: Bash script (no Node.js) -- minimiza dependencias, cualquier juez con curl puede ejecutarlo. Solo requiere `curl` y `jq`.
- DT-2: El script usa `curl` + `jq` para requests y validacion JSON. Si `jq` no esta disponible, el script SHALL advertir y degradar a grep-based validation.
- DT-3: El signup en AC-11 crea una key temporal. No se limpia despues (las keys son idempotentes por owner_ref, y en produccion esto es aceptable para demo).

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO hardcodear URLs de produccion dentro del script salvo como default de BASE_URL.
- CD-2: PROHIBIDO almacenar secrets en el script -- solo usa datos publicos o datos generados en el propio run.
- CD-3: OBLIGATORIO que el script sea ejecutable (`chmod +x`) y tenga shebang `#!/usr/bin/env bash`.
- CD-4: OBLIGATORIO que cada endpoint tenga su propio bloque PASS/FAIL con nombre descriptivo.

## Missing Inputs

- [resuelto en script] El body exacto de `POST /auth/agent-signup` -- se puede inferir del route handler (requiere `owner_ref`).
- [resuelto en script] El body exacto de `POST /discover` -- se puede inferir del route handler (requiere `query` field).

## Analisis de paralelismo

- Esta HU NO bloquea ninguna otra HU.
- Esta HU NO depende de ninguna HU en progreso -- todos los endpoints ya existen en produccion.
- Puede ejecutarse en paralelo con cualquier otra HU.
