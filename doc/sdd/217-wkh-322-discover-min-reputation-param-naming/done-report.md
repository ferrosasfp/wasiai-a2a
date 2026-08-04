# Report — WKH-322 `/discover` deja de descartar parámetros en silencio

## Resumen ejecutivo

Cerrada la HU de naming. `/discover` aceptaba `min_reputation` (snake_case) silenciosamente sin filtrar, mientras que el filtro real se llamaba `minReputation` (camelCase). Se implementó alias + 400 fail-loud para claves no reconocidas. 5/5 ACs verificados con evidencia archivo:línea; 4 pasadas adversariales de AR, cada una descubriendo que un mecanismo nuevo declaraba más cobertura de la que tenía; CR APROBADO; F4 APROBADO. La HU registra una lección de proceso: cada guard/barrido se verifica plantando casos que debería matarlo, no sólo leyendo el código.

---

## Pipeline ejecutado

| Fase | Gate | Status | Fecha |
|------|------|--------|-------|
| **F0** | project-context cargado | ✅ | 2026-08-03 |
| **F1** | work-item.md + HU_APPROVED | ✅ | 2026-08-03 |
| **F2** | sdd.md + SPEC_APPROVED | ✅ | 2026-08-03 |
| **F2.5** | story-WKH-322.md | ✅ | 2026-08-04 |
| **F3 W0-W2** | código + 50 tests nuevos + 2 archivos test (5006 passed, 19 skipped) | ✅ | 2026-08-04 00:52 |
| **AR-1** | 2 BLQ-ALTO (call-sites, integration) | ❌ RECHAZADO | 2026-08-04 01:30 |
| **Fix-pack 1** | 4 call-sites + doc INTEGRATION.md | ✅ wave W0.3 | 2026-08-04 02:00 |
| **AR-2** | call-sites creció 4→6→8→10; 2 BLQ-MEDIO | ❌ RECHAZADO | 2026-08-04 02:45 |
| **Fix-pack 2** | barrido automatizado `discover-callsites.test.ts` | ✅ wave W3 | 2026-08-04 14:20 |
| **AR-3** | guard declaraba cobertura no-fixturable; 4 BLQ-BAJO | ❌ RECHAZADO | 2026-08-04 20:10 |
| **Fix-pack 3** | docstring + fixtures + declare límites honestamente | ✅ wave W3 | 2026-08-04 23:00 |
| **AR-4** | guardián de CI + 2 BLQ-BAJO (npm install scripts, exclude) | ❌ RECHAZADO | 2026-08-05 01:15 |
| **Fix-pack 4** | `test-files-are-run-in-ci.test.ts` + ignore-scripts + ci.yml permissions | ✅ wave W3 | 2026-08-05 04:10 |
| **CR** | 0 BLQ, 4 MENORes (prosa, mutación) | ✅ APROBADO | 2026-08-05 08:30 |
| **F4 QA** | 5/5 ACs PASS, gates verdes, candados probados AL REVÉS | ✅ APROBADO | 2026-08-05 12:00 |
| **DONE** | report.md + _INDEX.md + consolidación | ✅ | 2026-08-05 |

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|---|--------|-----------|
| **AC-1** (regresión) | ✅ PASS | `minReputation` en `[0,100]` excluye por `computedReputation.score` y reporta `excluded.reputation`. Test `discover.minreputation.test.ts:425` `T-R22`, `:438` `T-R23`. Motor `applyReputationFloor` (`src/services/discovery.ts:577-591`) intacto. |
| **AC-2** (núcleo) | ✅ PASS | `min_reputation` NO produce respuesta indistinguible de "sin filtro". Implementado alias (`discovery-query.ts:388-401` `resolveMinReputation`) + 400 `UNKNOWN_DISCOVER_PARAM` para claves desconocidas. Test `discover.minreputation.test.ts:452` `T-R24`. |
| **AC-3** (alias identidad) | ✅ PASS | Resultados idénticos entre `?minReputation=N` y `?min_reputation=N`. Precedencia declarada: conflicto (ambos con valores distintos) → 400 `CONFLICTING_MIN_REPUTATION`. Test `:477` `T-R25`, `:577` `T-R28`/`:600` `T-R28c`. |
| **AC-4** (regresión) | ✅ PASS | Fail-closed con `standingBatch.degraded === true` para los dos nombres. Test `:612-648` `T-R29`: `standingUnavailable: true`, `agents: []` para camelCase y snake_case. |
| **AC-5** (documentación) | ✅ PASS | Ampliación de validación (400 para claves desconocidas) documentada ANTES de activar. `doc/INTEGRATION.md:257-303` está en el diff. Test `discover.minreputation.test.ts:706` `T-R30` (lista de 10 params enumerada a mano, no iterada desde constante). |

---

## Hallazgos finales — BLOQUEANTEs y MENORes

### Bloqueantes

#### `BLQ-ALTO-1` — NO ARREGLADO (decisión del founder, 2026-08-04)

**El problema**: `wasiai-v2` delega `GET /api/v1/capabilities` a a2a `/discover` y reenvía todos los query params sin filtrar. Especialmente: `category=defi` y `cursor=<next>` no están en `ALLOWED_DISCOVER_PARAMS` pero llegan a `/discover`, y post-merge devuelven **400 `UNKNOWN_DISCOVER_PARAM`**. Los dos parámetros documentados en la página pública del marketplace (https://app.wasiai.io docs) dejarían de funcionar.

**Medición**: ambos parámetros **hoy no hacen nada**. `category=defi` y `category=BASURA` devuelven la misma lista. Un cursor válido y uno basura devuelven la misma primera página. Ninguna funcionalidad activa se rompe.

**Decisión del founder (2026-08-04)**: **Opción A** — Mergear con el 400. Después, sacar `category` y `cursor` de la documentación pública de `wasiai-v2`, porque están medidos como muertos. Seguimiento abierto en v2 (repo distinto, único escritor).

**Dueño**: founder. **Criterio de cierre**: después de merge, issue en wasiai-v2 para remover parámetros de docs públicas.

---

### Menores (resueltos)

- **MNR-1** (CR) — `T-U9` y `T-U9b` partidos para distinguir "cota" de "anuncio" → mutantes con firmas distintas
- **MNR-2** (CR) — 2 de 5 límites del extractor tienen fixture; se agregó cross-reference en docstring
- **MNR-3** (AR-4 + corregido) — Prosa falsable en `docs/api-reference.md` (~`?allowTrial=` devuelve 200, no 400~): corregido con inputs concretos
- **MNR-4** (CR, declara deuda) — Candado de tipos `satisfies` pospuesto a HU futura

---

## Lo que esta HU registra bien

### 1. **Call-sites crecieron 4→6→8→10 por dos causas distintas**

| Ronda | Número | Causa | Mécanismo |
|-------|--------|-------|-----------|
| **F3** | 4 (story) | Búsqueda manual acotada (`scripts/ src/ packages/`) | grep + cruce a mano |
| **AR-1** | 6 → descubiertos 2 más en `e2e.test.ts` | Alcance incompleto: fuera de `packages/` no se buscó | re-grep del Dev |
| **AR-2** | 8 → descubiertos 2 más en huérfanos | El alcance dejaba afuera `mcp-servers/wasiai-x402/` entero (cliente HTTP publicado del repo) + `smoke-test.sh:229` dentro del alcance pero se escapó del cruce a mano | barrido `discover-callsites.test.ts` sobre `git ls-files` |
| **AR-3/AR-4** | 10 → ciclo cerrado | Se plantaron 15 formas de mandar un parámetro: 5 pasaron mudas (límites del extractor no-fixturable) | fixture de cada límite en `T-CS-4`, re-corrida con límites declarados |

**La lección**: Una lista heredada se lee como resultado, no como muestra. Una búsqueda grep ruidosa se abandona (70 hits de `query:`, 12 son Supabase, no `/discover`). El paso mecánico (cruce a mano) no escala ni deja audit trail. **El mecanismo cierra la clase; la lista no.**

### 2. **Cada mecanismo construido declaró más cobertura de la que tenía**

Cuatro rondas, cuatro mecanismos:

1. **AR-1 grep**: decía "busca `query:` en scripts/src/packages/", perdía mcp-servers/
2. **AR-2 barrido**: decía "una sola limitación: claves en runtime", tenía 9 límites no-declarados (URLSearchParams, axios, fixture.json con `"body"`, etc.)
3. **AR-3 guard de CI**: decía "traduce cada step a globs reales", no leía `exclude`, no veía `if:` ni `continue-on-error`
4. **Cada uno**: verificado contra el repo REAL (formas que ya existían), no plantando casos de prueba

**Por qué importa**: una declaración falsa de cobertura se lee como verdadera. "QUÉ NO CUBRE" existe para decirle al revisor siguiente **qué tiene que buscar a mano**. Si la lista miente, entra un onceavo call-site por justo donde decía que no había grieta.

### 3. **40 archivos de test que ningún CI corría** (descubierto en fix-pack 3)

- `mcp-servers/wasiai-x402/`: 32 tests en `tests/tools.test.mjs`, corredor de Node, nunca colectado
- `packages/agent-sdk/`: 8 tests en files varios, corredor de vitest, nunca colectado

El guardián `test/test-files-are-run-in-ci.test.ts` enumeró runners desde `ci.yml` y se pone rojo si aparece un `*.test.*` huérfano. Probado plantando un archivo en `tools/qa-plant-orphan/` → ROJO con path exacto.

---

## Auto-Blindaje consolidado

Se documentan 16 patrones de error + fix, organizados por ronda:

### Wave F3 W0-W2

- **W0 (00:47)** — Clase de error no importada en `catch instanceof`; patrón: imports de clases de error se agrupan
- **W0 (00:48)** — Test positivo iteraba constante (CD-10); patrón: positivos a mano, negativos pueden leer la constante
- **W2 (00:52)** — Mutante duplicado (borra vs. reordena, misma firma de muerte); patrón: mutantes distintos matan tests distintos
- **W1 (00:50)** — Lint rojo por formato post-escritura; patrón: lint **entre git add y commit**, no al final
- **W1 REINCIDIÓ (04:07)** — Mismo problema en fix-pack 4; un lint verde caduca en la siguiente edición

### Fix-pack 1 (call-sites, 02:00)

- **(14:05)** — Radio de búsqueda creció 4→6→8 por dos fallas encadenadas: (1) Story File lista **se lee** como resultado, no muestra; (2) grep ruidoso se abandona (70 hits, 12 son Supabase). **Lección mecánica**: dos procedimientos que NO escalan — grep manual requiere cruce a mano (fallará N veces), lista manual requiere re-grepear (no hay audit trail). Solución: test automatizado que enumeran archivos y extraen claves, corriendo en CI.

- **(14:20)** — Smoke `smoke-e2e-comprehensive.mjs` mandaba `{ query: '' }` sin assert de status. Con el guard, recibía 400, pero `?? []` tapaba el error y imprimía `✓ HTTP 400 — undefined agents` con exit 0. **Patrón**: status se chequea **ANTES** de leer body, `?? []` va DESPUÉS del chequeo. No invertir el orden.

- **(14:40)** — `T-U9` con dos asertos en el mismo `it` (cota + anuncio) los hacía indistinguibles por mutación (dos mutantes, una firma). Partidor en `T-U9` + `T-U9b`. **Patrón**: asertos independientes en `it` separados si dos mutantes distintos necesitan firmas distintas.

### Fix-pack 2 (barrido, 14:50-02:20)

- **(14:50)** — BLQ-ALTO-1 NO aplicado a propósito (decisión founder) + MENORes (deudas TD-322-1/2/3/4) declaradas; código/prosa honesto
- **(02:15)** — Comentario que explica el fix menciona `UNKNOWN_DISCOVER_PARAM`, exactamente el texto que el barrido exime. Exención restringida a `*.test.*`; un comentario en código normal ya no apaga el chequeo. **Patrón**: escape hatch textual necesita otra condición si "quien lo escribe de verdad" (un comentario de fix) podría activarlo.
- **(02:20)** — `T-CS-3` (POST cuyo body no se entiende) usaba proximidad en caracteres. Call-site con `body: JSON.stringify(body)` donde `body` viene de otra función pasaba mudo (evidencia de arriba caía en ventana). Fix: `ownerOf` asigna cada body a UNA sola llamada más cercana. **Patrón**: ventana (lint, scanner, logs) + "la evidencia vale como cobertura" = necesita dueño explícito.
- **(02:28)** — `isWellFormed()` de ES2024 pasó en vitest (Node 22) pero `tsc --noEmit` falló. `npm run build` tampoco lo habría cazado (tsconfig.build excluye tests). **Patrón**: `tsc --noEmit` siempre, incluso si suite está verde.

### Fix-pack 3 (guard + límites, 03:00-04:00)

- **(03:20)** — LA LECCIÓN DE LA RONDA: un guard se prueba por **lo que NO caza**. Verifiqué contra repo real (formas ya escritas), no plantando casos. Plantabas 15 formas, 5 pasaban mudas. Límites no-fixturable se declaran con marca explícita; los que son fixturable llevan su caso. **Patrón**: antes de declarar cobertura de un mecanismo, plantá 10 variantes y mide cuáles pasan mudas. La lista de límites sale de esa medición.

- **(03:05)** — `hasBody` booleano + `topLevelKeys` saltea spread = `{...extraFilters, limit:5}` pasaba verde con un solo hit. Fix: retorna `{keys, unresolved}`. Extractor parcial debe poder decir "incompleto". **Patrón**: parseador/extractor parcial en decisión de "cubierto" necesita tipo que distinga "leí todo" de "leí algo".

- **(03:14)** — Mi primer arreglo al barrido tapaba justo el call-site que pedían destapar (`smoke-base-downstream`). Lo detecté porque re-corrí **la reproducción del AR**, no la suite. **Patrón**: fix que pone algo en verde → re-corrí la reproducción del hallazgo, no la suite.

- **(03:10)** — 377 tests verdes que no corría nadie (`mcp-servers/wasiai-x402/tests/tools.test.mjs`, `packages/agent-sdk`). Agregué step de CI + guardián. **Patrón**: test en directorio nuevo → verificá que el runner lo colecta (corriendo el comando de CI, no el IDE).

### Fix-pack 4 (CI + prosa, 04:00-04:10)

- **(04:00)** — Guardián de CI prometía "traduce cada step a globs reales", declaraba UN límite (runtime). AR-4 midió 3 vectores verdes: `exclude` de vitest, `if:` que nunca resuelve true, `continue-on-error: true`. Los tres dejaban tests sin correr con guardián verde. Fix: `exclude` se resta, `if:/continue-on-error:` caen en `untranslatable` (no mecanismo, declaración honesta). **El titular**: cada mecanismo declaró más cobertura de la que tenía, y en las 4 hizo falta plantando casos para descubrirlo.

- **(04:10)** — Extensión de alcance declarada: `permissions: contents: read` en `ci.yml`, verificado que no rompe el workflow.

---

## Decisiones diferidas a backlog (TD-322-1..4)

| ID | Qué | Dueño | Criterio de cierre |
|----|-----|-------|-------------------|
| **TD-322-1** | `GET /discover/:slug` sigue sin el guard | Fuera de alcance (DT-6) | HU futura que extienda el guard a esa ruta |
| **TD-322-2** | `verified`/`includeInactive` colapsan valores no-booleanos en silencio (clase más amplia de coerción) | Mismo patrón que el de naming | HU de validación estricta de booleanos en `/discover` |
| **TD-322-3** | Dos nombres para el mismo parámetro, para siempre | Decisión consciente (DT-2): unificar rompería `/compose`↔chaski-v3 | No se cierra — es permanente por compatibilidad |
| **TD-322-4** | Nombre de parámetro gigante en `req.url` no se trunca en logs | Observabilidad (serializer custom de request en Fastify logger) | HU de observabilidad futura |

---

## Lecciones para próximas HUs

1. **Una lista heredada de un `.md` se lee como conclusión de una búsqueda. No lo es.** Un Story File con tabla cerrada "parece" output de grep exhaustivo. El paso "verificarla" no se siente como un paso: se siente como releer. Si la radio es un NOMBRE (no una firma), el compilador no ayuda y una lista heredada no cuenta como medición. Enunciar la regla no alcanza; hace falta un test que se ponga rojo solo.

2. **Todo mecanismo nuevo que promete cerrar una clase se verifica plantando casos que debería matarlo, ANTES de escribir lo que promete cubrir.** El grep, el barrido, el guard de CI, todos comenzaron verificados contra el repo real. Eso mide lo que caza; no lo que deja pasar. Un barrido que pasa en verde sobre un repo sin la forma peligrosa **no dice nada** sobre esa forma. La cobertura declarada sale de plantar 10 variantes y medir cuáles pasan mudas.

3. **Los límites de un mecanismo se escriben después de encontrar las grietas, no antes.** "QUÉ NO CUBRE" existe para que el revisor siguiente sepa qué buscar a mano. Un ítem declarado sin fixture y sin marca no se distingue de uno que dejé sin hacer. Todo lo fixturable tiene su caso; todo lo que no es, lleva su marca explícita.

4. **Un extractor/parseador parcial que alimenta una decisión de "cubierto" necesita un tipo que distinga "leí todo" de "leí algo".** Un booleano (`hasBody: true`) o una lista sin marcar (`keys: []`) ya perdieron esa información. El silencio se cuela por donde el mecanismo sabe a medias, que es peor que donde no sabe nada.

5. **La honestidad de una afirmación se mide en input concreto que la romería.** "Cualquier/ninguno/siempre" — todo universal necesita, al lado, el `?param=valor` que lo desmienta. Si la afirmación es larga, el revisor siguiente las aplica todas de una, las toma como verdaderas, y deja de buscar. Es la misma clase de silencio que esta HU vino a matar.

---

## Archivos modificados (producción)

| Archivo | Cambio | Contexto |
|---------|--------|---------|
| `src/lib/discovery-query.ts` | +166 líneas (aditivo puro) | Nuevas funciones `assertKnownDiscoverParams`, `resolveMinReputation`, constante `ALLOWED_DISCOVER_PARAMS` |
| `src/routes/discover.ts` | +3 removals, +46 net (wiring) | Import de nuevas clases de error + alias resolution en `parseFiltersOr400` |
| `doc/INTEGRATION.md` | +40/-1 | Tabla de parámetros y errores de `/discover` + ejemplos actualizados |
| `docs/api-reference.md` | Corrección escala + tabla actualizada | Extensión de alcance declarada (preexistente, fuera del Scope IN original) |

## Archivos de test

- `src/routes/discover.minreputation.test.ts` (aditivo, 50 tests nuevos: 22 `it` + 2 × 10 de `it.each` + 8 de validación)
- `src/lib/discovery-query.test.ts` (aditivo, 8 tests de validación)
- `src/__tests__/discover-callsites.test.ts` (nuevo, 887 líneas, 3 tests de clase + guardián)
- `test/test-files-are-run-in-ci.test.ts` (nuevo, 363 líneas, guardián de huérfanos)
- `src/__tests__/e2e/e2e.test.ts` (corrección: call-site `query`→`q`)

## Scripts tocados

10 call-sites de `query`→`q`:
1. `scripts/smoke-test.sh:229` (POST body)
2. `scripts/k6-deep-test.js:356` (POST body)
3. `scripts/smoke-e2e-comprehensive.mjs` (3 lugares, 1 POST con assert nuevo)
4. `scripts/smoke-e2e-cross-chain.mjs` (1 lugar)
5. `scripts/smoke-e2e-final.mjs` (1 lugar)
6. `mcp-servers/wasiai-x402/src/handlers.mjs:141` (GET query string a v2 `/api/v1/capabilities`)

Smoke scripts corregidos con assert de status 200 ANTES de leer body (`if (res.status !== 200) exit(1)`).

---

## Signoff y rastreo

- **Veredicto F4 QA**: APROBADO para DONE
- **Fecha de cierre**: 2026-08-05
- **Branch**: `feat/217-wkh-322-discover-reputation-param-naming` (26 commits sobre main)
- **Report escrito por**: nexus-docs
- **Session**: https://claude.ai/code/session_01WsgeDncyBvY2aUzQpd2Yvr
