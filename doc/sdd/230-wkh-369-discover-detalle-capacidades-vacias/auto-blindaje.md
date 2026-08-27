# Auto-Blindaje — #230 · WKH-369 · F3 (Dev)

> Rama: `feat/230-wkh-369-detalle-capacidades-federadas` (desde `main` @ `18e4550`)
> Fecha: 2026-08-27

---

## 0. Línea base del gate, medida antes de tocar una línea (W0.1)

Corrida sobre el árbol limpio, en el orden de `.github/workflows/ci.yml`:

```
npx tsc -p tsconfig.json --noEmit  → "TypeScript compilation completed", exit 0
npm run lint                       → "Checked 516 files in 274ms. No fixes applied."
npm test                           → Test Files  310 passed | 6 skipped (316)
                                     Tests      6290 passed | 19 skipped (6309)
```

**Coincide exactamente con la del Story File §0.4.** Delta cero: el número no envejeció
entre F2.5 y F3.

---

## 1. CD-2 — los 14 rojos, cada uno con su mutación y su MOTIVO

Protocolo: aplicar la mutación → correr **sólo** el test afectado
(`vitest run <archivo> -t '<ID>'`) → copiar el rojo literal → restaurar con `cp` desde una
copia hecha **antes**, nunca con `git checkout --`.

Backup de sesión: `…/scratchpad/wkh369-f3/` (subdirectorio propio — ver §3, E-4).

| ID | `archivo:línea` mutado | Mutación | Rojo REAL |
|---|---|---|---|
| **T-01** | `src/services/agent-detail.ts:60` | comentar `agent.capabilities = entrada.capabilities;` | `AssertionError: expected [] to deeply equal [ 'remittance', 'remit', 'kyc', …(1) ]` |
| **T-02a** | `src/services/agent-detail.ts:73` | comentar `agent.capabilitiesState = 'unresolved';` (rama 5b) | `AssertionError: expected undefined to be 'unresolved' // Object.is equality` |
| **T-02b** | `src/services/agent-detail.ts:60-70` | agregar `if (agent.capabilities.length === 0) agent.capabilitiesState = 'unresolved';` dentro de 5a | `AssertionError: expected true to be false // Object.is equality` |
| **T-02c** | `src/services/agent-detail.ts:49,75-78` | sacar el `try { … } catch { … }` (queda un bloque desnudo) | `Error: registro down` propagado, **no** un assert: `Error: registry down ❯ src/services/agent-detail.test.ts:302:7` |
| **T-03** | `src/services/agent-detail.ts:60` | la misma de T-01 (el paso 5a lee el payload de DETALLE) | `AssertionError: expected 1 to be +0 // Object.is equality` — o sea `difiere: 1` |
| **T-04** | `src/services/agent-detail.test.ts:337` | `const poblacion = SLUGS_MEDIDOS.length` (denominador = total) | `AssertionError: expected 25 to be 50 // Object.is equality` |
| **T-05** | `src/services/agent-detail.ts:60` | la misma de T-01 | `AssertionError: expected [] to have a length of 4 but got +0` |
| **T-06a** | `src/services/agent-detail.ts:65-69` | sacar la copia de `reputation` | `AssertionError: expected NaN to be 7 // Object.is equality` |
| **T-06b** | `src/services/discovery.ts:1500` ⚠️ **temporal** | `V2_PRICE_FALLBACK_FIELD = 'price_per_call_XXX'` | caso (a): `AssertionError: expected +0 to be 0.001 // Object.is equality` |
| **T-07a** | `src/services/discovery.ts:1381` ⚠️ **temporal** | agregar `capabilitiesState: 'unresolved' as const` al objeto que devuelve `mapAgent` | el string difiere: `Received` termina en `…"status":"active"},"capabilitiesState":"unresolved"}` contra un `Expected` que cierra en `…"status":"active"}}` |
| **T-07b** | idem T-07a | idem | `AssertionError: expected [ 'id', 'name', 'slug', …(13) ] to not include 'capabilitiesState'` |
| **T-08** | `src/routes/discover.ts:341` | volver a `discoveryService.getAgent(slug, registry)` | `AssertionError: expected [] to have a length of 4 but got +0` |
| **T-09** | `src/services/agent-detail.ts:47` | sacar el guard `agent.registry_id === SELF_PUBLISHED_REGISTRY_ID` | `AssertionError: expected "discover" to not be called at all, but actually been called 1 times` — ⚠️ **NO** el rojo que el Story File esperaba. Ver §2 |
| **T-10** | `src/services/agent-detail.ts:51` | `registry: agent.registry` (el NOMBRE) | `AssertionError: expected "discover" to be called with arguments: [ { registry: 'wasiai', …(1) } ]` · diff: `- "registry": "wasiai"` / `+ "registry": "WasiAI"` |

**Todos los rojos previstos por el Story File §7.2 salieron con el mensaje previsto, salvo
T-09** (§2). T-06a se midió **dos veces**: la primera contra la forma original de la línea, y
otra vez contra la forma final después del arreglo de `exactOptionalPropertyTypes` (§3, E-2),
porque un rojo medido sobre código que después cambió es un rojo de otro programa.

### Restauración de `src/services/discovery.ts` — probada, no supuesta (CD-11 / §7.3)

Después de cada mutación temporal (T-06b y T-07a/b), y otra vez al cerrar W3:

```
/usr/bin/git status --porcelain src/services/discovery.ts   → salida VACÍA
/usr/bin/git diff --stat src/services/discovery.ts          → salida VACÍA
sed -n '1500p' src/services/discovery.ts
  → const V2_PRICE_FALLBACK_FIELD = 'price_per_call' as const;
```

Y un barrido de restos: `/usr/bin/grep -rn "MUTANTE" src/` no devuelve ninguna línea escrita
por esta HU (los 19 aciertos son comentarios preexistentes de otros archivos).

---

## 2. ⚠️ El rojo de T-09 NO fue el que el Story File predijo — y el test estaba incompleto

- **Error**: el Story File §7.2 predice para T-09 el rojo `expected 1 to be 0`, o sea que la
  aserción que mata al mutante sería el contador de `mockFetch`. **Es falso, medido.**
- **Causa raíz**: sacando el guard de self-published, el resolver llama a
  `discover({ registry: 'self-published', includeInactive: true })`. Ese valor es
  **exactamente** `SELF_PUBLISHED_REGISTRY_NAME`, así que `discover()` entra por el merge
  **local** (`discovery.ts:249`, `publishedAgentService.listAsAgents()`), `getWithSecrets`
  devuelve `undefined` y `registries` queda vacío ⇒ **cero fetch outbound**. El contador de
  `mockFetch` sigue en 0 y la aserción del Story File **pasa con el mutante puesto**.
- **Fix**: T-09 lleva DOS aserciones. La del contador (la que el Story File pide) se conserva
  tal cual, y se agrega `expect(discoverSpy).not.toHaveBeenCalled()`, que es la que
  efectivamente mata al mutante. El comentario en el test dice por qué no es redundante.
- **Aplicar en**: cualquier guard de *no pagar I/O* cuyo testigo cuente llamadas de RED. La
  llamada que el guard evita puede resolverse por un camino que no toca la red — y entonces
  el contador mide la ausencia de una consecuencia, no la del comportamiento. **Contá la
  llamada que el guard evita, no su efecto más visible.**

---

## 3. Errores propios de esta sesión

### [2026-08-27] W0 — `npx biome` no resuelve el ejecutable en este entorno
- **Error**: `npx biome check --write src/types/index.ts` salió con
  `npm error could not determine executable to run`, después de imprimir una salida parcial
  confusa (`Lint: 2 errors, 0 warnings`) que **no era de mi archivo**. Casi la leo como un
  fallo real de mi edición.
- **Causa raíz**: el paquete se llama `@biomejs/biome`; `npx biome` intenta resolver un
  paquete `biome` que no existe. `npm run lint` funciona porque el script del `package.json`
  usa el binario local.
- **Fix**: `./node_modules/.bin/biome check --write <archivos>` — directo, sin `npx`.
- **Aplicar en**: todo CD-14 de este repo. El Story File escribe `npx biome check --write` y
  **ese comando no corre acá**.

### [2026-08-27] W1 — dos errores de tipos que `vitest` no puede ver
- **Error**: con los 10 tests en VERDE, el paso 1 del gate dio dos `error TS`:
  1. `agent-detail.test.ts:221` — el doble de `getWithSecrets` devolvía `null` y la firma real
     es `Promise<RegistryConfig | undefined>`.
  2. `agent-detail.ts:61` — `agent.reputation = entrada.reputation` con
     `exactOptionalPropertyTypes: true`: `number | undefined` no es asignable a `number`.
- **Causa raíz**: `vitest` transpila sin chequear tipos. **Diez tests verdes no dicen nada
  sobre `tsc`**, y el Story File manda correr el gate *desde el paso 1* justamente por esto.
- **Fix**: (1) el doble devuelve `undefined`. (2) La copia de `reputation` respeta la
  doctrina «omitido, no `null`» del repo: si la entrada de la lista no trae el campo, se
  **borra** del detalle en vez de escribirle `undefined`
  (`src/services/agent-detail.ts:65-69`). En la práctica la rama de borrado no se alcanza —
  `mapAgent` siempre produce `reputation` (puede ser `NaN`) — pero escribir
  `agent.reputation = undefined` habría publicado la clave con valor `null` tras el
  `JSON.stringify`, que es exactamente la ambigüedad que esta HU existe para matar.
- **Aplicar en**: cualquier asignación a un campo `?:` de `Agent`. El árbol compila con
  `exactOptionalPropertyTypes`, así que **copiar un opcional incluye copiar su ausencia**.

### [2026-08-27] W1 — el scratchpad compartido ya tenía un `discovery.ts.bak` de otra sesión
- **Error**: la primera copia de respaldo fue a la raíz del scratchpad, que ya contenía
  `discovery.ts.bak` (301 archivos de sesiones anteriores). Un `cp` de restauración desde el
  archivo equivocado habría **revertido `discovery.ts` a un estado ajeno** — y el
  `git status --porcelain` habría salido sucio sin que yo entendiera por qué.
- **Causa raíz**: el scratchpad es compartido entre sesiones del mismo proyecto.
- **Fix**: subdirectorio propio `…/scratchpad/wkh369-f3/`, y el respaldo se **verificó**
  contra el original con `/usr/bin/diff -q` antes de usarlo (`diff` a secas miente en este
  entorno: contesta `Files are identical` sobre archivos que difieren).
- **Aplicar en**: todo protocolo §7.3. **Un backup que no comparaste no es un backup: es un
  archivo con el nombre correcto.**

### [2026-08-27] W2 — el `import` que quedaba sin usar, y sí quedó sin usar
- **Error potencial evitado**: `src/routes/agent-card.ts` importaba
  `{ discoveryService, extractDeclaredTokenId }` del mismo módulo. Al reemplazar la única
  llamada a `discoveryService.getAgent` (línea 43), `discoveryService` quedó **huérfano**.
- **Causa raíz**: el Story File §W2b anticipaba que "se sigue usando" — pero lo que se sigue
  usando es `extractDeclaredTokenId`, que viene del mismo `import` **con otro nombre**.
  Verificado con `/usr/bin/grep -n 'discoveryService\|extractDeclaredTokenId'`: los únicos
  usos de `discoveryService` en ese archivo eran la línea 10 (el import) y la 43 (la llamada).
- **Fix**: el import se partió en dos: `resolveAgentForDetailView` de `agent-detail.js` y
  **sólo** `extractDeclaredTokenId` de `discovery.js`. En `src/routes/discover.ts`
  `discoveryService` **sí** se queda: lo usan los handlers de `GET`/`POST /discover`
  (líneas 234 y 304).
- **Aplicar en**: `tsc` y `vitest` son **ciegos** a un import sin usar; sólo lo ve `biome`, y
  `lint` va **segundo** en el gate. Es el modo de falla que ya sobrevivió 5 revisiones en este
  repo.

---

## 4. Delta del gate contra la línea base (W3.5 — completo y en orden, una vez)

```
npx tsc -p tsconfig.json --noEmit  → "TypeScript compilation completed", exit 0
npm run lint                       → "Checked 519 files in 281ms. No fixes applied."
npm test                           → Test Files  312 passed | 6 skipped (318)
                                     Tests      6304 passed | 19 skipped (6323)
```

| | Base | Ahora | Delta |
|---|---|---|---|
| archivos que lintea `biome` | 516 | 519 | **+3** (los 3 archivos nuevos de `src/`) |
| archivos de test | 310 | 312 | **+2** |
| tests | 6290 | 6304 | **+14** — exactamente los 14 de esta HU |
| fallos | 0 | 0 | — |

Los avisos de `Failed to load source map for typescript.js` y las líneas
`DOWN:`/`CONFIG:`/`PASS:` de la sonda del money-path aparecen **igual** en la línea base:
son preexistentes, no consecuencia de esta HU.

---

## 5. Presupuesto (§9) — el exceso, medido y justificado

| Concepto | Presupuesto | Real | |
|---|---|---|---|
| Código de producción (sin prosa) | ≤ 70 | **38** | ✅ |
| Docblocks y comentarios | ≤ 60 | **59** | ✅ |
| Tests | ≤ 420 | **670** | ⚠️ **1.6×** |
| Total del diff en `src/` | ≤ 550 | **767** | ⚠️ **1.39×** (bajo el umbral 2× = 1100) |
| Archivos de producción tocados | 4 | **4** | ✅ |

Desglose del código de producción: `agent-detail.ts` 32 · `agent-card.ts` 3 ·
`discover.ts` 2 · `types/index.ts` 1.

**El exceso está en los tests, y es de arnés, no de lógica.** *¿Qué parte de esto seguiría
existiendo si lo escribiera alguien que ya conoce este código?* Casi todo:

- **~90 líneas por archivo de mocks de módulo**, duplicadas entre los dos. CD-7 prohíbe el
  atajo (doblar `discoveryService`), así que hay que doblar las **siete** dependencias que
  `discovery.ts` toca para que `mapAgent` corra de verdad: logger, `registry.js`,
  circuit-breaker, `undici` **más** el `fetch` global, `supabase.js`, `reputation.js` y
  `agent.js`. Los `vi.mock` son por archivo y se hoistean: **no se pueden compartir**.
- **~80 líneas de fixture** (los payloads de LISTA y de DETALLE, con la divergencia medida)
  también duplicadas. Compartirlas exigiría un archivo nuevo en `src/`, y §3 enumera los
  7 archivos del Scope IN: crear un octavo es expandir alcance sin autorización.
- El resto es el clasificador de tres estados de AC-3 y el literal de T-07a, que son el
  contenido de dos ACs.

**Lo único recortable identificado**: unificar el fixture en un helper compartido
(~60 líneas menos). Requiere un archivo fuera del Scope IN ⇒ queda propuesto para el CR,
no ejecutado.

---

## 6. Lo que NO se pudo cumplir tal cual, y por qué

1. **El rojo de T-09** no es el que el Story File predice. Medido, documentado en §2, y el
   test se reforzó con la aserción que sí mata al mutante.
2. **`npx biome check --write`** no corre en este entorno (§3). Se usó el binario local.
   CD-14 se cumplió sobre los **seis** archivos tocados antes del gate final.
3. **El nombre de rama** es `feat/230-wkh-369-detalle-capacidades-federadas` (indicación del
   orquestador), no el `fix/230-…` del encabezado del Story File. Sin efecto técnico.
4. **La base es `18e4550`**, no `dc1c448`. `git merge-base --is-ancestor origin/main HEAD` →
   `AL DIA`, y las tres anclas de `sed` de W−1 mostraron **exactamente** lo esperado
   (`discover.ts:337`, `agent-card.ts:43`, `types/index.ts:457`), así que el árbol no se
   movió respecto del SDD.
