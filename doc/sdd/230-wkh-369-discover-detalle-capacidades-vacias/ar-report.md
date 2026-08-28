# AR — Adversarial Review · #230 · WKH-369

> Rama `feat/230-wkh-369-detalle-capacidades-federadas` · commit `6d1cb63` · base `18e4550`
> Fecha: 2026-08-27 · Revisor: nexus-adversary
> Todo lo que sigue está **ejecutado**. Cada hallazgo trae el comando y el rojo literal.

## Veredicto

**RECHAZADO — BLOQUEANTEs activos (1 ALTO · 1 MEDIO · 3 BAJO · 3 MENOR).**

El gate del repo, corrido por mí en el orden de `.github/workflows/ci.yml`, **está en ROJO**.
`npm test` sale con **exit 1**. AC-8 no se cumple.

## El gate, medido por mí (no los números del Dev)

```
/usr/bin/git status --porcelain   → VACÍO   (árbol == 6d1cb63, verificado antes y después de mutar)

1) npx tsc -p tsconfig.json --noEmit → "TypeScript compilation completed"   exit 0   ✅
2) npm run lint                     → "Checked 519 files in 209ms. No fixes applied."  ✅
3) npm test                         → Test Files  1 failed | 311 passed | 6 skipped (318)
                                      Tests      4 failed | 6300 passed | 19 skipped (6323)
                                      exit 1                                            ❌
```

| | Base declarada | Dev declara | **Medido por mí** |
|---|---|---|---|
| `tsc` | 0 | 0 | **0** ✅ |
| `lint` | 516 | 519 | **519** ✅ |
| test files | 310/316 | 312/318 passed | **311 passed + 1 FAILED** (318) ❌ |
| tests | 6290/6309 | 6304/6323 passed | **6300 passed + 4 FAILED** (6323) ❌ |

⚠️ `auto-blindaje.md:157-166` afirma `Test Files 312 passed | 6 skipped (318)` y `fallos: 0`.
**Es falso, medido dos veces con el árbol limpio en `6d1cb63`.** El total 6304 sí coincide
(6300 + 4), o sea que la corrida existió pero el renglón "fallos 0" no se leyó.

---

# Hallazgos, ordenados para el fix-pack

## 🔴 BLQ-ALTO-1 — `npm test` falla: 4 rojos en `test/readme-numbers.test.ts` (AC-8 roto)

- **Categoría**: Test Coverage / Integration
- **Archivo:línea**: `README.md:378`, `README.md:383`, `README.es.md:412`, `README.es.md:417`
  · guard en `test/readme-numbers.test.ts:289`
- **Descripción**: el repo tiene un guardián que exige que los DOS README publiquen el número
  real de archivos de test y de archivos que lintea Biome, derivados del índice de git. La HU
  agrega **3 archivos a `src/`** (`agent-detail.ts` + 2 `.test.ts`) y **2 archivos de test**, y
  no actualiza ningún README. Los README no aparecen en `git diff --name-only main`.
- **Reproducción** (ejecutada, dos corridas independientes):
  ```
  $ npm test
  FAIL test/readme-numbers.test.ts > … > README.md (inglés) > declara el número real de archivos de test
  FAIL test/readme-numbers.test.ts > … > README.es.md (español) > declara el número real de archivos de test
    AssertionError: expected 316 to be 318 // Object.is equality
  FAIL test/readme-numbers.test.ts > … > README.md (inglés) > declara el número real de archivos que linta Biome
  FAIL test/readme-numbers.test.ts > … > README.es.md (español) > declara el número real de archivos que linta Biome
    AssertionError: expected 516 to be 519 // Object.is equality
  Tests  4 failed | 6300 passed | 19 skipped (6323)
  exit 1
  ```
- **Impacto**: el paso 3 del gate de CI falla ⇒ **AC-8 no se cumple** y el merge a `main`
  rompe CI. Además la HU se declaró cerrada con un número de gate que no es el que sale.
- **Sugerencia**: actualizar `316→318` y `516→519` en `README.md` y `README.es.md`, y volver a
  correr el gate **completo y en orden**, leyendo la línea `Tests` entera (no sólo el total).

---

## 🟠 BLQ-MED-1 — el `catch` del resolver es MUDO, y colapsa dos causas en el mismo payload

- **Categoría**: Error Handling
- **Archivo:línea**: `src/services/agent-detail.ts:75-78` (y `:73`)
- **Descripción**: cuando la llamada al catálogo tira, el resolver escribe
  `capabilitiesState = 'unresolved'` y devuelve, **sin emitir ni un log**. El precedente del
  propio repo es el contrario: WKH-318 hizo que toda fuente degradada emita un warn
  estructurado con `error_code: 'REGISTRY_SOURCE_FAILED'`
  (`discovery.ts:277-284` y `:408-415`). Acá no hay nada. Peor: la rama `:73` (el agente no
  está en el catálogo) y la rama `:76` (el catálogo se cayó) producen un payload
  **byte-idéntico**, así que ni el cliente ni el operador pueden separarlas.
  Es la misma clase de colapso que esta HU existe para matar (`[]` ≡ «no pudimos leer»),
  un nivel más arriba.
- **Reproducción** (sonda ejecutada, 2/2 verdes, luego borrada):
  ```ts
  // L-1: getWithSecrets rechaza  ⇒  unresolved, y CERO logs
  vi.mocked(registryService.getWithSecrets).mockRejectedValue(new Error('catalogo caido'));
  const a = await resolveAgentForDetailView('agente-rico');
  expect(a?.capabilitiesState).toBe('unresolved');
  expect(logSpy.error.mock.calls.length).toBe(0);   // ✅ pasa
  expect(logSpy.warn.mock.calls.length).toBe(0);    // ✅ pasa
  expect(logSpy.info.mock.calls.length).toBe(0);    // ✅ pasa

  // L-2: "ausente del catálogo" vs "catálogo caído"  ⇒  MISMO JSON
  expect(JSON.stringify(ausente)).toBe(JSON.stringify(caido));   // ✅ pasa
  ```
  Resultado: `Tests 2 passed (2)`.
- **Impacto**: un registro caído durante horas se ve exactamente igual que un agente que
  legítimamente no está en el catálogo. No hay ninguna señal grepeable. El propio T-02c del
  Dev ejercita este camino y **no** verifica que se loguee.
- **Sugerencia**: emitir un `log.warn` estructurado en el `catch` (con `error_code`, `slug`,
  `registry_id` y la causa clasificada), reusando `classifyFetchFailure` que ya existe en
  `discovery.ts`. Y decidir si las dos ramas merecen valores distintos o al menos logs
  distintos — si se decide que no, que quede escrito como DT.

---

## 🟡 BLQ-BAJO-1 — `unresolved` FALSO: se marca no-resuelto sobre capacidades que SÍ se resolvieron

- **Categoría**: Data Integrity / contrato público
- **Archivo:línea**: `src/services/agent-detail.ts:73`
- **Descripción**: la rama «el agente no está en la lista» escribe `capabilitiesState =
  'unresolved'` **sin mirar si el detalle ya traía capacidades**. Para un registro cuyo
  endpoint de detalle sí publica el campo (`mapAgent` lo mapea igual, `discovery.ts:1360-1362`),
  la respuesta sale **auto-contradictoria**: capacidades reales + la marca que dice que no se
  pudieron leer. Un consumidor que respete AC-2 va a descartar datos válidos.
- **Reproducción** (sonda P-1, ejecutada, verde ⇒ el defecto está):
  ```ts
  // registro cuyo DETALLE sí publica `tags`, y cuya LISTA no trae el slug
  detalle = { slug:'agente-rico', tags:['payments','kyc'], … };   lista = [];
  const agent = await resolveAgentForDetailView('agente-rico');
  expect(agent?.capabilities).toEqual(['payments','kyc']);   // ✅ pasa
  expect(agent?.capabilitiesState).toBe('unresolved');       // ✅ pasa  ← contradicción
  ```
- **Alcanzabilidad, honesta**: con el único registro federado de hoy (`wasiai`, cuyo detalle
  **no** publica capacidades) el efecto visible es `capabilities: []` + `unresolved`, que no
  se contradice. El camino se abre (a) al alta de cualquier registro con detalle rico —
  operación normal por `POST /registries`, no un refactor — y (b) hoy mismo vía
  `AGENT_BLOCKLIST` (ver MNR-2) y vía truncamiento del over-fetch de 200.
- **Impacto**: se publica una afirmación falsa sobre el propio dato que se está publicando.
- **Sugerencia**: marcar `unresolved` sólo si `agent.capabilities.length === 0`, o distinguir
  «no resuelto» de «no confirmado contra la lista». Cualquiera de las dos, escrita como
  decisión.

---

## 🟡 BLQ-BAJO-2 — CD-1 NO está mecanizada: T-03 pasa con el fixture vacío Y el bug puesto

- **Categoría**: Test Coverage
- **Archivo:línea**: `src/services/agent-detail.test.ts:320-321` (el comentario y la aserción)
- **Descripción**: la línea `:320` afirma *«CD-1 mecanizada: con un fixture de capacidades
  vacías esto es imposible»* sobre
  `expect(conteo.coincideConContenido).toBeGreaterThanOrEqual(1)`. **Es falso.** El contador
  lo satisface el agente **self-published** (`makeSelfAgent()`, caps `['weather','geo']`), que
  por construcción **no puede exhibir el defecto**: el resolver le hace early-return en
  `agent-detail.ts:47` y nunca pasa por el enriquecimiento. O sea, el testigo de CD-1 lo firma
  un agente que no está en la población del bug — que es exactamente el error de muestreo que
  el work-item §133 denuncia.
- **Reproducción** (ejecutada):
  ```
  1) mutar producción:  agent-detail.ts:60 → // MUTANTE: agent.capabilities = entrada.capabilities;
  2) vaciar el fixture: agent-detail.test.ts:100 → const CAPS_FED: string[] = [];
  3) npx vitest run src/services/agent-detail.test.ts -t 'T-03'
     → PASS (1) FAIL (0)          ← con el bug puesto y el fixture vacío, T-03 pasa
  ```
  Control con la mutación sola (fixture lleno): `T-03 → AssertionError: expected 1 to be +0`,
  o sea que T-03 sí caza el bug **mientras el fixture tenga contenido** — pero no protege esa
  precondición, que es lo único que CD-1 pedía.
- **Compensación parcial (medida, no supuesta)**: con el fixture vacío + bug, la suite completa
  del archivo da `PASS (8) FAIL (2)`: caen **T-01** (`expected [] to deeply equal [...]`) y
  **T-04** (`expected +0 to be 1`, `:333`). Así que el defecto no pasaría entero — pero el
  guard que la HU designó como el mecanizador de CD-1 no mecaniza nada.
- **Impacto**: la afirmación `:320` es prosa que afirma de más sobre el propio artefacto de
  verificación. El próximo que toque el fixture confiando en ese comentario se queda sin red.
- **Sugerencia**: contar `coincideConContenido` **sólo sobre los federados** (excluyendo
  `registry_id === SELF_PUBLISHED_REGISTRY_ID`), o subir el piso a `>= 2`. Y corregir el
  comentario para que diga lo que la aserción hace.

---

## 🟡 BLQ-BAJO-3 — amplificación por request en una ruta con `rateLimit: false`

- **Categoría**: Performance / disponibilidad
- **Archivo:línea**: `src/routes/discover.ts:327` (`config: { rateLimit: false }`) +
  `src/services/agent-detail.ts:50-56`
- **Descripción**: `GET /discover/:slug` está **exento de rate limit** de forma explícita.
  Cada request ahora dispara, además del fetch de detalle de siempre, un `discover()` completo
  contra el registro: **1 fetch upstream de hasta 200 filas** (`resolveUpstreamFetchLimit`,
  piso 200) y **una query a supabase por cada fila** que declare token ERC-8004
  (`discovery.ts:attachIdentities`, `Promise.all` sin batch), más el `computeStandingBatch`.
- **Reproducción** (sondas P-2 y P-5, ejecutadas):
  ```ts
  // P-2: URLs exactas emitidas por UN GET de detalle
  expect(urls.length).toBe(2);                                          // ✅
  expect(urls[0]).toBe('https://example.com/agent/agente-rico');        // ✅
  expect(urls[1]).toBe('https://example.com/agents?limit=200');         // ✅  ← NUEVO

  // P-5: catálogo de 200 filas con token declarado ⇒ conteo de supabase.from()
  expect(n).toBe(-1);
  → AssertionError: expected 200 to be -1        ← exactamente 200 queries por request
  ```
  Línea base antes de la HU: `getAgent` hacía **como máximo 1** query de identidad
  (`discovery.ts:1441-1455`).
- **Impacto**: un caller anónimo, sin límite, multiplica por hasta ~200 el costo de DB por
  request. El cliente de supabase es el mismo que usan `/compose` y `/orchestrate`: saturar el
  pool degrada el camino del dinero. El multiplicador real en prod depende de cuántas de las
  ~29 filas declaran token ERC-8004 (no lo pude medir contra prod), así que el número de arriba
  es el techo del over-fetch, no la medición de producción.
- **Qué cubre el SDD y qué no**: §4.5 y `TD-369-3` miden y aceptan **la latencia**
  (+220 ms, «ruta gratis»). No miran ni el conteo de queries ni la exención de rate limit
  (`R-6` califica el impacto de «Bajo» sobre una medición sólo de latencia). Por eso esto no
  entra bajo la regla de «decisión documentada».
- **Sugerencia**: acotar el enriquecimiento (pasarle un `limit` al `discover()` interno, o el
  caché de `TD-369-3`), **o** sacarle la exención de rate limit a `/discover/:slug`, **o**
  ampliar el DT para que diga explícitamente que se acepta este fan-out en una ruta sin límite.

---

## 🔵 MNR-1 — `includeInactive` está cubierto por la FORMA del argumento, no por su efecto

`src/services/agent-detail.ts:52-55` llama al flag «Load-bearing», pero ningún fixture tiene
un agente `status: 'inactive'`. Medido: mutando `:55` a `includeInactive: false`,
`npx vitest run src/services/agent-detail.test.ts src/routes/discover.detail-capabilities.test.ts`
da `PASS (13) FAIL (1)`, y el único rojo es **T-10**
(`expected "discover" to be called with arguments: [ { registry: 'wasiai', …(1) } ]`), que
compara el objeto del argumento. Nadie demuestra la consecuencia: un federado inactivo
perdería sus capacidades y saldría con `unresolved` falso. Es el espejo de la lección que el
propio Dev escribió en `auto-blindaje.md:83-86`. Producción es correcta; falta el testigo de
comportamiento.

## 🔵 MNR-2 — `AGENT_BLOCKLIST` produce un `unresolved` con motivo falso

`discovery.ts:436-445` filtra el blocklist **dentro** de `runDiscoveryPipeline`, así que un
slug blocklisteado desaparece de la lista pero sigue resolviendo por `getAgent`. Medido
(sonda P-4, verde): con `AGENT_BLOCKLIST='agente-rico'`, `GET /discover/agente-rico` devuelve
el agente con `capabilitiesState: 'unresolved'`. La marca dice «no las pudimos leer» cuando la
verdad es «lo excluimos a propósito». Es la vía alcanzable **hoy** de BLQ-BAJO-1.

## 🔵 MNR-3 — la distinción de AC-2 no llega al Agent Card, y no está declarada como TD

`src/services/agent-card.ts` construye el card campo por campo (sin spread), así que
`capabilitiesState` no viaja. Un federado no resuelto sale con `skills: []` en
`GET /agents/:slug/agent-card` — el mismo `[]` ambiguo que la HU existe para matar, en la otra
ruta de detalle que la HU sí modificó (AC-5). Puede ser la decisión correcta (el AgentCard es
un artefacto de protocolo A2A y meterle un campo no estándar tiene su propio costo), pero no
está escrita en ningún lado: no hay TD-369-N que la cubra.

---

# Las 11 categorías

| # | Categoría | Estado |
|---|---|---|
| 1 | **Security** | **OK** — no hay input nuevo hacia SQL/HTML/shell. `slug` y `registry` viajan por los mismos `getAgent`/`discover` de siempre; los guards SSRF (`validateRegistryUrl` + `ssrfFetch`) y el circuit breaker corren sin cambios. Ningún secreto nuevo: `getWithSecrets` se consume dentro de `discovery.ts` y su `RegistryConfig` no sale al payload. Ownership guard **no aplica**: `agent-detail.ts` no toca `supabase` (`/usr/bin/grep -n "supabase\|\.from(" src/services/agent-detail.ts` → sin aciertos), y `npm test` corre `ownership-filter-guard` en verde. |
| 2 | **Error Handling** | **BLQ-MED-1** |
| 3 | **Data Integrity** | **BLQ-BAJO-1** + **MNR-2**. Sin race conditions ni escrituras: es sólo lectura. La mutación `agent.capabilities = entrada.capabilities` opera sobre el objeto fresco que `mapAgent` construye por llamada (`discovery.ts:1353`), no sobre estructura compartida ni cacheada. |
| 4 | **Performance** | **BLQ-BAJO-3** |
| 5 | **Integration** | **OK** — verificado ejecutando, no leyendo. `/usr/bin/git diff main -- src/services/discovery.ts src/services/compose.ts src/services/agent-price.ts` → **0 líneas**. Los 6 call-sites del camino del dinero (`compose.ts:1713-1714`, `agent-price.ts:59/71/124/125`) siguen llamando a `getAgent` pelado. AC-7 tiene testigo real: mutando `discovery.ts:1381` para inyectar `capabilitiesState` en `mapAgent`, `discover.detail-capabilities.test.ts` da `PASS (1) FAIL (3)` con `expected [ 'id', … ] to not include 'capabilitiesState'` y el diff del string literal de T-07a. El `expected` de T-07a es un literal escrito a mano, **no** un espejo del `actual`. El campo nuevo es opcional y aditivo; ningún consumidor que valide forma se rompe. |
| 6 | **Type Safety** | **OK** — cero `any`, cero casting. `capabilitiesState?: 'unresolved'` es un literal type. `capabilities` sigue siendo `string[]` y nunca `null` (`toArray`, `discovery.ts:1491-1495`, tiene `return []` como piso). La rama `delete agent.reputation` (`:65-69`) respeta `exactOptionalPropertyTypes` y evita publicar `null`; está declarada como inalcanzable en la práctica y el motivo escrito coincide con `mapAgent:1364-1366`. |
| 7 | **Test Coverage** | **BLQ-ALTO-1**, **BLQ-BAJO-2**, **MNR-1**. Re-hice 4 de las 14 mutaciones que el Dev declara y **todas dieron el rojo con el motivo declarado**: (a) `agent-detail.ts:60` comentada → `PASS (10) FAIL (4)`, rojos de T-01/T-03/T-05/T-08 idénticos a `auto-blindaje.md:34,38,40,45`; (b) `:51 → registry: agent.registry` → `PASS (7) FAIL (7)`, o sea el riesgo `registry` vs `registry_id` está genuinamente cubierto; (c) `discovery.ts:1381` con `capabilitiesState` inyectado → T-07a/T-07b rojos; (d) `:47 → if (false)` → T-09 rojo **por `expect(discoverSpy).not.toHaveBeenCalled()`**, con el contador de `mockFetch` pasando — confirma `auto-blindaje.md §2`. Ningún guard se lee a sí mismo: T-07b lee `Object.keys()` en runtime, no el archivo fuente. |
| 8 | **Scope Drift** | **OK** — 7 archivos tocados, todos en el Scope IN de `sdd.md:460-464`. Ningún refactor de oportunidad; el `NaN` de `reputation` (TD-369-1) y `computedReputation` (TD-369-2) quedaron sin tocar como manda el SDD. (La ausencia de los README no es drift: es el BLQ-ALTO-1.) |
| 9 | **Destructive Migrations** | **N/A** — el diff no contiene SQL ni `migrations/`. `/usr/bin/git diff --name-only main` devuelve 7 archivos, todos `.ts` y `.md`. |
| 10 | **RPC `SECURITY DEFINER`** | **N/A** — no se crea ni se modifica ninguna función postgres, y `agent-detail.ts` no llama a `supabase.rpc(...)`. |
| 11 | **Cache Invalidation** | **N/A** — la HU **no** introduce ninguna capa de cache; el SDD lo descarta explícitamente (§4.5, `TD-369-3`) y lo verifiqué en el diff. Que no haya cache es justamente la precondición de BLQ-BAJO-3, y ahí está contado. |

---

# Riesgo #1 del encargo (`registry` vs `registry_id`) — DESCARTADO, con la medición

No pude construir el input que lo rompe, y es porque el resolver está del lado correcto:

- `agent-detail.ts:51` usa **`agent.registry_id`**, que `mapAgent` llena con `registry.id`
  (`discovery.ts:1374`), no con el nombre.
- `discover()` resuelve el registro con `registryService.getWithSecrets(query.registry)`
  (`discovery.ts:229`), que hace `.eq('id', id)` (`registry.ts:262-266`). Es un **ID**.
- `?registry=WasiAI` (el nombre) ni siquiera llega al resolver: `getAgent` hace el mismo
  `getWithSecrets('WasiAI')` → `undefined` → `registries` vacío → `getAgent` devuelve `null` →
  **404**, no un catálogo vacío que se anuncia completo.
- La convención contraria de `agent-card.ts:66-68` (`r.name === agent.registry`) sigue
  aplicándose sólo a `registryService.getEnabled()`, que devuelve configs, no al catálogo.
- Mutación ejecutada: `:51 → registry: agent.registry` ⇒ **`PASS (7) FAIL (7)`**, con
  T-10 dando `- "registry": "wasiai" / + "registry": "WasiAI"`.

**Categoría OK.** Es un dato, no una omisión.

# El exceso de arnés (670 vs 420) — MIRADO, sin hallazgo

Leí los dos archivos de test enteros. El excedente es `vi.mock` de las 7 dependencias que
`discovery.ts` toca (obligatorio por CD-7, y los `vi.mock` se hoistean por archivo: no se
pueden compartir), fixtures de payload, y `clasificar()` / `medirParidad()` — que **son** el
contenido de AC-3, no lógica de producción disfrazada. Nada de eso pertenece a `src/`.
`agent-detail.ts` tiene 32 líneas de código real. **OK.**

---

# Orden sugerido para el fix-pack

1. **BLQ-ALTO-1** — los dos README (`316→318`, `516→519`). Sin esto no hay gate verde.
2. **BLQ-MED-1** — log estructurado en el `catch` de `agent-detail.ts:75-78`.
3. **BLQ-BAJO-1** — no marcar `unresolved` sobre capacidades ya resueltas.
4. **BLQ-BAJO-2** — que `coincideConContenido` cuente sólo federados, y corregir el comentario `:320`.
5. **BLQ-BAJO-3** — acotar el fan-out o declarar la decisión con el número de queries y la exención de rate limit.
6. MNR-1/2/3 — a criterio del CR.

⚠️ Al re-correr el gate: leer la línea `Tests` **completa**. `npm test | tail` puede mostrar
`[exited with code 0]` porque ese es el exit del pipe, no el de `npm`. El exit real de
`npm test` en este commit es **1** (`PIPESTATUS[0]=1`).

# Higiene de la revisión

Todas las mutaciones se aplicaron con `sed -i` y se restauraron con `cp` desde
`…/scratchpad/ar369/` (subdirectorio propio, backups verificados con `/usr/bin/diff -q` antes
de usarse). **Nunca `git checkout --`.** Las 3 sondas temporales
(`src/services/zzar369probe.test.ts`, `zzar369log.test.ts`) se borraron.
Verificación final: `/usr/bin/git status --porcelain` → **vacío**; `git rev-parse --short HEAD`
→ `6d1cb63`.
