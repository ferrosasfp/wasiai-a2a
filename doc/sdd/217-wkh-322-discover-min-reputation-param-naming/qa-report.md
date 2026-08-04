# QA Report (F4) — WKH-322 · `/discover` deja de descartar parámetros en silencio

| Campo | Valor |
|---|---|
| Rama | `feat/217-wkh-322-discover-reputation-param-naming` (26 commits sobre `main`) |
| Fecha | 2026-08-04/05 |
| Rondas previas | AR ×4 (RECHAZADO→RECHAZADO→RECHAZADO→RECHAZADO, fix-packs 1-4), CR ×1 (APROBADO CON MENORES) |
| **Veredicto QA** | **APROBADO** |

---

## 1. ACs — con evidencia archivo:línea

| AC | Texto (resumen) | Veredicto | Evidencia |
|---|---|---|---|
| AC-1 | `minReputation` filtra y reporta `excluded.reputation` (regresión, pin) | ✅ PASS | `src/routes/discover.minreputation.test.ts:425` `T-R22`, `:438` `T-R23` — corridos por mí, verdes (ver §3) |
| AC-2 | `min_reputation` (snake_case) NO da respuesta indistinguible de "sin filtro"; alias o 400 | ✅ PASS | Alias implementado: `src/lib/discovery-query.ts:388-401` (`resolveMinReputation`), wireado en `src/routes/discover.ts:79-82`. Test: `discover.minreputation.test.ts:452` `T-R24` (`?min_reputation=2` filtra, service recibe `2` no `undefined`), `:518` `T-R26` (`?capability=` → 400 nombrando `capabilities`), `:549` `T-R27` (`?bogusparam=` → 400, la clase) |
| AC-3 | Alias produce resultados idénticos; conflicto entre nombres se resuelve DECLARADO | ✅ PASS | `discover.minreputation.test.ts:477` `T-R25` (mismo objeto de llamada, misma respuesta), `:577` `T-R28`/`:600` `T-R28c` (conflicto → 400 `CONFLICTING_MIN_REPUTATION`; mismo valor no es conflicto). Unit: `src/lib/discovery-query.test.ts:232` `T-U1`, `:240` `T-U2`, `:258` `T-U3`, `:266` `T-U4` |
| AC-4 | Fail-closed se mantiene con los dos nombres si el batch de reputación está degradado | ✅ PASS | `discover.minreputation.test.ts:612-648` `T-R29` — leído y verificado: `standingUnavailable: true`, `camelCall` === `snakeCall`, `agents: []` para ambos. Corrido por mí, verde |
| AC-5 | Ampliación de validación (400 para cualquier clave desconocida) documentada ANTES de activar | ✅ PASS | `doc/INTEGRATION.md:257-303` (lista de 10 parámetros + tabla de errores) está en el mismo diff que el wiring (CD-8). Test: `discover.minreputation.test.ts:706` `T-R30` / `:731` `T-R30b` — enumeración a mano de los 10 nombres (no itera la constante, CD-10) |

Los 5 ACs verificados con test nombrado, corrido por mí (no tomado del reporte del Dev): `npx vitest run src/routes/discover.minreputation.test.ts src/lib/discovery-query.test.ts src/__tests__/e2e/e2e.test.ts` → **135 passed (135)**.

---

## 2. Runtime / candados — probados AL REVÉS (no confiados por reporte)

### 2.1 `src/__tests__/discover-callsites.test.ts` — plantado un onceavo call-site

Creé `tools/qa-plant-test/plant-call-site.mjs` con `body: JSON.stringify({ query: 'plantedByQA' })` (clave `query`, inválida) apuntando a `/discover`, en un directorio (`tools/`) que no existía antes.

```
npx vitest run src/__tests__/discover-callsites.test.ts
❯ T-CS-2: ninguna clave enviada a /discover queda fuera de ALLOWED_DISCOVER_PARAMS — FAIL
  tools/qa-plant-test/plant-call-site.mjs:5  clave 'query' (body JSON)
```

**ROJO, con archivo:línea:clave exactos.** Árbol restaurado (`rm -rf tools`), `git status` idéntico al inicial.

### 2.2 `test/test-files-are-run-in-ci.test.ts` — plantado un archivo de test huérfano

Creé `tools/qa-plant-orphan/orphan.test.ts` (test trivial, `staged` con `git add`), en directorio nuevo fuera de todo runner declarado en `ci.yml`.

```
npx vitest run test/test-files-are-run-in-ci.test.ts
❯ ★ ningún archivo de test queda fuera del alcance de todos los runners — FAIL
  Huérfanos: tools/qa-plant-orphan/orphan.test.ts
```

**ROJO, con el path exacto.** Deshice el `git add`, borré `tools/`. `git status` idéntico al inicial (verificado).

**Conclusión**: los dos candados que deciden si esta HU cierra la CLASE (no sólo las 10 instancias conocidas) están verificados por mí, no por lectura del reporte del Dev/AR.

---

## 3. Gates — corridos por mí, no reusados

| Gate | Comando | Resultado (mío) | Resultado (Dev/CR reportado) | Match |
|---|---|---|---|---|
| `tsc` | `npx tsc --noEmit` | exit 0, limpio | limpio | ✅ |
| Suite raíz | `npm test` | **5006 passed, 19 skipped** (244 files) | 5006 passed / 19 skipped | ✅ exacto |
| `mcp-servers/wasiai-x402` | `npm test` (Node test runner) | **347 pass, 0 fail** | 347/347 | ✅ exacto |
| `packages/agent-sdk` | `npm test` (vitest) | **30 passed** (8 files) | 30/30 | ✅ exacto |
| Lint | `npm run lint` (biome) | `Checked 442 files. No fixes applied.` | limpio | ✅ |

Los 5 gates verdes, con mis propios números, coincidiendo byte a byte con lo reportado.

---

## 4. Drift detection

- **Scope IN original (8 archivos)** cumplido: `src/lib/discovery-query.ts`, `src/routes/discover.ts`, los dos test files, `doc/INTEGRATION.md`, + los call-sites `query`→`q`.
- **Extensiones de alcance declaradas** (autorizadas por el orquestador), ambas verificadas legítimas:
  - **(a)** `docs/api-reference.md` — preexistente, fuera del Scope IN original. Confirmado el fix: `minReputation` scale `[0,1]`→`[0,100]` (`docs/api-reference.md:100`), + `min_reputation`/`allowTrial` agregados a la tabla, + corrección AR-4 MNR-3 (`?allowTrial=` vacío = 200, techo `2^53-1` en `limit`). Declarado en `auto-blindaje.md:361-374`.
  - **(b)** `permissions: contents: read` en `.github/workflows/ci.yml:14-17` — agregado por el Dev por su cuenta, declarado en `auto-blindaje.md:405-416`. Verificado el diff completo: no rompe el workflow (`actions/checkout` sólo necesita `contents: read`; `cache: npm` de `setup-node` no usa scopes del `GITHUB_TOKEN`; ningún step publica/comenta/sube artifacts). Los dos `npm install`/`npm ci` nuevos de sub-paquetes llevan `--ignore-scripts` explícito (AR-4 `BLQ-BAJO-2`, cerrado — verificado en el diff, `ci.yml:50,60`).
- **Wave order**: `git log` confirma serie estricta W0 (`62067df`) → W1 (`0592312`) → W2 (`14f7d5f`), seguida de 4 fix-packs seriales por ronda de AR/CR. Sin violaciones.
- **`ALLOWED_DISCOVER_PARAMS`**: exactamente **10 claves** (`discovery-query.ts:202-213`), sin `category` ni `cursor`, sin banderas nuevas — verificado extrayendo el literal del archivo, no leyendo el reporte.
- **`wasiai-v2`**: `git diff --name-only main..HEAD` — cero archivos de ese repo. Las ~10 apariciones de la cadena `wasiai-v2` en el diff están todas dentro de `doc/sdd/217-.../*.md` (prosa de análisis/reportes), no tocan código de v2. `BLQ-ALTO-1` (AR: `category`/`cursor` de v2 chocan con el guard) sigue **afuera**, confirmado — decisión del founder, no aplicada en este fix-pack.
- **`GET /discover/:slug`**: no tocado (`discover.ts:309-330`), sigue sin el guard — coincide con TD-322-1 declarada.

**Drift: ninguno fuera de lo declarado y autorizado.**

---

## 5. Deuda declarada (TD-322-1..4) — con dueño y criterio de cierre

Verificadas en `sdd.md:566-577` (ahora trackeado en git, `git ls-files` lo confirma):

| ID | Qué | Dueño / criterio de cierre |
|---|---|---|
| TD-322-1 | `GET /discover/:slug` sigue sin el guard | Fuera de alcance (DT-6). Se cierra extendiendo el guard a esa ruta en una HU futura |
| TD-322-2 | `verified`/`includeInactive` colapsan cualquier valor no `'true'` a `undefined` en silencio | Misma clase, sobre VALORES no NOMBRES. Cierre: HU de coerción estricta de booleanos |
| TD-322-3 | Dos nombres para el mismo parámetro, para siempre | Decisión consciente (DT-2): unificar rompería `/compose`↔chaski-v3. No se cierra — es permanente |
| TD-322-4 | Nombre de parámetro gigante en `req.url` no se trunca en el log de `GET` | Cierre: serializer custom de request en Fastify logger (HU de observabilidad aparte) |

Los límites declarados de los dos mecanismos (discover-callsites, test-files-are-run-in-ci) están en sus docstrings y en `auto-blindaje.md` fix-pack 3/4 — verificados que no son "cajón": cada límite no-fixturable está marcado como tal explícitamente (`auto-blindaje.md:294-303`), y AR-4 confirmó que no queda ninguno declarado sin fixture que pudiera tenerlo.

R-2 (agente único de `remittance-payout` queda excluido con piso ≥1) sigue declarado con **dueño founder**, no arreglado — correcto, es CD-1/money-adjacent.

---

## 6. Prosa honesta (CD-9)

Barrido dirigido sobre las afirmaciones nuevas de mayor riesgo:
- `discovery-query.ts:180-188` (orden "aproximadamente alfabético") — corregido en fix-pack (`MNR-1` del CR), ya no afirma "alfabético" sin matiz. Verificado el contraejemplo (`min_reputation` antes de `minReputation` en el Set, al revés de `sort()`).
- `docs/api-reference.md:101,104` — corregidos los dos falsables que encontró AR-4 (`?allowTrial=` vacío, techo `1e21`/`2^53-1`).
- `discovery-query.ts:298-301` (alcance del guard) — declara explícitamente que NO cubre `GET /discover/:slug`; no promete "ningún parámetro se pierde".
- No encontré, en el barrido de las secciones nuevas de `discovery-query.ts`, `discover.ts`, `doc/INTEGRATION.md` y `docs/api-reference.md`, ninguna frase adicional no cubierta ya por AR-4/CR con un input concreto que la falsee.

---

## 7. Veredicto

**APROBADO PARA DONE.**

- 5/5 ACs PASS con evidencia archivo:línea, tests corridos por mí.
- 5/5 gates verdes, corridos por mí, coincidiendo exacto con lo reportado.
- Los dos candados de clase probados al revés por mí: ambos se ponen rojo correctamente, árbol restaurado sin rastro.
- `BLQ-ALTO-1` confirmado afuera (decisión founder). `ALLOWED_DISCOVER_PARAMS` = 10 claves exactas.
- Cero drift no declarado. Las dos extensiones de alcance (api-reference.md, permissions en ci.yml) están documentadas, justificadas y verificadas como correctas/seguras.
- TD-322-1..4 con dueño y criterio de cierre, ninguna es un cajón.
- Prosa: los hallazgos previos de AR-4/CR ya fueron corregidos; no encontré una quinta frase falsa.

Sin follow-up bloqueante. Recomendado: mergear.
