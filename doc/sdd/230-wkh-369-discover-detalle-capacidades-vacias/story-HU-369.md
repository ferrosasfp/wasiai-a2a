# Story File — #230 · WKH-369: `/discover/<slug>` publica capacidades vacías para todo agente federado

> SDD: `doc/sdd/230-wkh-369-discover-detalle-capacidades-vacias/sdd.md` (SPEC_APPROVED 2026-08-27, commit `dc1c448`)
> Work item: `doc/sdd/230-wkh-369-discover-detalle-capacidades-vacias/work-item.md` (HU_APPROVED 2026-08-27)
> Fecha: 2026-08-27 · Fase: F3 (Dev)
> Branch: `fix/230-wkh-369-discover-detalle-capacidades-vacias` (crear desde `main` @ `dc1c448`)
> Modo: QUALITY
>
> **Este documento es el contrato completo. Si algo no está acá, PARÁ y escalá al Architect.
> No inventes, no asumas, no improvises.**

---

# 0. ⛔ LEER ANTES DE ESCRIBIR UNA LÍNEA

## 0.1 Las CUATRO trampas de esta HU (todas cayeron al medirlas)

Esta HU tuvo cuatro hipótesis que se dieron por buenas y se cayeron. **Las cuatro por la
misma causa: se midió el artefacto que el cliente puede pedir, no el que el sistema
consume.** La quinta la vas a cometer vos si no las conocés.

| # | Hipótesis | Quién la sostuvo | Cómo cayó |
|---|---|---|---|
| **1** | «El bug está en `mapAgent`, que diverge entre lista y detalle» | issue #182 | **NO diverge.** Los dos caminos llaman a la misma función sin ramificar: `src/services/discovery.ts:1273` (lista) y `:1436` (detalle). Verificado en este árbol |
| **2** | «Falta un `agentPath` para desenvolver el sobre del detalle» | F1 | **No hay sobre.** El agente viene en la raíz del cuerpo. No hay campo que buscar ni sobre que abrir |
| **3** | «Hay un fallback al nombre canónico que salva a la lista» | encargo de F2 | **El `??` protege la RUTA, no el VALOR.** `getNestedValue(raw, mapping.capabilities ?? 'capabilities')` (`discovery.ts:1360-1362`): si `mapping.capabilities === 'tags'`, se lee `raw.tags` y nada más. El único fallback al nombre canónico del archivo es el de **precio** (`discovery.ts:1500`, `:1512-1544`) |
| **4** | «El payload sin credencial de `/api/v1/capabilities` es el que consume el gateway» | orquestador | **Es OTRO cuerpo.** Sin credencial ese endpoint delega en el propio `/discover` de a2a y devuelve agentes ya mapeados. El cuerpo que el gateway recibe es el catálogo nativo de v2, con `tags` |

### 🔬 El método que SÍ funciona, y que tenés que usar para toda verificación contra producción

`mapAgent` guarda el crudo entero en `metadata`:

```
src/services/discovery.ts:1378        metadata: raw,
```

⇒ **`GET /discover/<slug>` → `metadata` ES, literalmente, lo que recibió el mapper.**
No hay que adivinar ni pedirle nada a otro endpoint.

Ya medido con ese método (`[MEDIDO-F2]`, 2026-08-27): el `metadata` del detalle federado
tiene **28 claves** y **ninguna de capacidades** — ni `tags`, ni `capabilities`, ni `skills`,
ni `labels`, ni `keywords`. Lo más parecido es `category`, que es **1 de las 4** capacidades
reales.

⇒ **El dato NO está en la respuesta que se está leyendo.** Por eso el arreglo no puede ser
de mapeo. Hay que ir a buscarlo a la única fuente que lo tiene (la LISTA) o declarar que no
se pudo resolver.

## 0.2 🔴 EL RIESGO #1 — y no es el arreglo

**Confundir `registry` (nombre de display) con `registry_id` (PK del registro).**

Medido contra producción el 2026-08-27:

| Petición | Resultado |
|---|---|
| `GET /discover?limit=100&registry=WasiAI` (el **nombre**) | `agents: 0` · `total: 0` · `sources: []` · **`catalogStatus: "complete"`** |
| `GET /discover?limit=100&registry=wasiai` (el **id**) | `agents: 24` · `total: 24` · `sources: [{name:"WasiAI", state:"ok", rows:24}]` |

**No da error: da un catálogo vacío que se anuncia COMPLETO.** Si lo confundís, el
enriquecimiento devuelve `'unresolved'` para siempre, la ruta contesta 200, el gate queda
en verde y la HU parece hecha **sin haber arreglado nada**. Es el mismo modo de falla que
esta HU existe para matar, un nivel más arriba.

**Y la trampa está armada a 20 líneas del punto de inserción.** `src/routes/agent-card.ts:66`
usa la convención **contraria**, a propósito y con el comentario puesto:

```
src/routes/agent-card.ts:65        } else {
src/routes/agent-card.ts:66        // ⚠️ CD-9: Agent.registry = name, NOT id. Match by name.
src/routes/agent-card.ts:67        const registries = await registryService.getEnabled();
src/routes/agent-card.ts:68        registryConfig = registries.find((r) => r.name === agent.registry);
```

⛔ **NO toques `agent-card.ts:66-68`.** Está bien como está: ahí se busca por nombre porque
lo que se necesita es el `RegistryConfig` cuyo `name` coincide con el display name del agente.

✅ **Lo que vos usás es `agent.registry_id`.** Verificado en el árbol, no supuesto:

```
src/services/discovery.ts:1374        registry_id: registry.id,      // en mapAgent
src/types/index.ts:436                registry_id: string;           // en la interfaz Agent
src/services/discovery.ts:227         ([await registryService.getWithSecrets(query.registry)]…
src/services/discovery.ts:1402-1406   getAgent: registryId → getWithSecrets(registryId)
src/services/registry.ts:262-268      async getWithSecrets(id) { … .eq('id', id) … }
```

⇒ La cadena `discover({registry}) → getWithSecrets(registry) → .eq('id', registry)` es
**código leído**, no una medición: `DiscoveryQuery.registry` es el **ID**.

**Esto tiene su propio test obligatorio: T-10.** Sin ese test la confusión es un verde
silencioso.

## 0.3 Herramientas de este entorno — medido, no teórico

| ⛔ NO usar | ✅ Usar | Por qué |
|---|---|---|
| La herramienta `Grep` | `/usr/bin/grep -rn` | Respeta `.gitignore` y devuelve **cero falso** |
| `cat` | `Read` o `sed -n 'A,Bp'` | Un hook lo corrompe, con exit 0 |
| `diff` | `/usr/bin/diff` | Contesta **`Files are identical` sobre archivos que difieren** |
| `git diff` | `/usr/bin/git diff` | Trunca cortando hunks (3250 líneas salieron 532) |
| `git log` para «¿está en main?» | `git merge-base --is-ancestor <sha> origin/main` | Omite los commits de merge |
| `git checkout -- <archivo>` para restaurar tras una mutación | `cp` desde una copia hecha antes | `git checkout --` borra también lo que estabas midiendo |

## 0.4 El gate del repo — COMPLETO y EN ORDEN

⛔ **`npm run qa` NO EXISTE en este repo.** Verificado: `package.json` tiene `lint`, `test`,
`build`, `format`; no hay `qa`. El gate es la secuencia de `.github/workflows/ci.yml`:

```bash
npx tsc -p tsconfig.json --noEmit     # paso 1
npm run lint                          # paso 2  ← es `biome check src/`
npm test                              # paso 3  ← es `vitest run`
```

**Línea base ya medida sobre `main` (2026-08-27). Tenés que llegar a ≥ esto:**

```
tsc    exit 0 — "TypeScript compilation completed"
lint   Checked 516 files. No fixes applied.
test   Test Files  310 passed | 6 skipped (316)
       Tests      6290 passed | 19 skipped (6309)
```

⚠️ Dos avisos **preexistentes** que NO son fallos: `Failed to load source map for
typescript.js` (vite) y las líneas `DOWN:`/`CONFIG:`/`PASS:` de la sonda del money-path
(WKH-364), que son salida esperada de sus tests.

⚠️ **`npm run lint` es `biome check src/`: NO lintea `test/`.** De ahí sale CD-13.

---

# 1. Goal

`GET /discover/<slug>` publica `capabilities: []` para **24 de 24** agentes federados,
mientras `GET /discover` publica la lista real para esos mismos slugs. El mismo defecto
vacía las `skills` del Agent Card A2A (`GET /agents/<slug>/agent-card`), porque
`src/services/agent-card.ts:124` hace `agent.capabilities.map(...)`.

**Lo que construís:** un resolver nuevo (`src/services/agent-detail.ts`) que, para un agente
federado, enriquece la vista de detalle con las capacidades y la reputación que publica la
LISTA, y que **cuando no puede resolverlas lo DICE** (`capabilitiesState: 'unresolved'`) en
vez de publicar un `[]` mudo. Los dos routes gratis (`/discover/:slug` y
`/agents/:slug/agent-card`) pasan a llamar al resolver en vez de a `getAgent` pelado.

**Dónde NO vive el arreglo, y por qué es lo más importante del diseño:** `getAgent` tiene
**8 call-sites en 4 archivos**, y **4 de esos call-sites están en el camino del dinero**
(`compose.ts:1713`, `:1714`, `agent-price.ts:59`, `:71`, `:124`, `:125`). Meter I/O adentro
de `getAgent` le agregaría hasta 2 llamadas upstream por step de `/compose`, cuatro días
antes del Demo Day. Por eso **`src/services/discovery.ts` no se toca: CERO líneas.** Eso
convierte CD-3, CD-4 y AC-7 de promesas en propiedades del diseño.

---

# 2. Acceptance Criteria (EARS)

> Copiados del SDD aprobado sin cambios. QA los verifica en F4 con evidencia `archivo:línea`
> **y ejecutando**.

- **AC-1** — WHEN un caller pide `GET /discover/<slug>` para un agente servido por un
  registro federado, the system SHALL devolver un `capabilities` igual al que
  `GET /discover` publica para ese mismo slug en el mismo estado de catálogo.
- **AC-2** — IF el camino de detalle no puede resolver la lista de capacidades desde el
  payload upstream, THEN the system SHALL declarar la vista como no resuelta en vez de
  publicar `[]`.
- **AC-3** — WHEN se mida la paridad entre las dos vistas, the system SHALL clasificar cada
  agente en **`difiere` / `coincide-con-contenido` / `coincide-en-vacío`**, y SHALL calcular
  la tasa del defecto **sobre la población que puede exhibirlo**.
- **AC-4** — WHILE el defecto esté presente en el camino de detalle, the test de paridad
  SHALL fallar.
- **AC-5** — WHEN se pide `GET /agents/<slug>/agent-card` para un agente federado, the
  system SHALL derivar `skills` de la misma lista de capacidades que publica `GET /discover`.
- **AC-6** — WHEN el camino de detalle mapee un payload federado, the system SHALL producir
  los mismos valores que el camino de lista para **todo** campo de `agentMapping` cuyo path
  declarado difiera de su nombre canónico, o SHALL declarar el campo como no resuelto.
- **AC-7** — WHILE esta HU esté desplegada, the system SHALL dejar `GET /discover`,
  `POST /discover` y la resolución por capacidad de `/compose` con salida **byte-idéntica**.
- **AC-8** — WHEN se ejecute el gate del repo en el orden de `.github/workflows/ci.yml`,
  the system SHALL pasar los tres pasos.

---

# 3. Files to Modify / Create

| # | Archivo | Acción | Qué hacer | Exemplar | Presupuesto |
|---|---|---|---|---|---|
| 1 | `src/types/index.ts` | Modificar | Agregar `capabilitiesState?: 'unresolved'` a la interfaz `Agent`, **después de la línea 457** (`trial?: AgentTrialAdmission;`), patrón «omitido, no `null`» | Exemplar A | +4 código, ≤ 10 de docblock |
| 2 | `src/services/agent-detail.ts` | **CREAR** | `export async function resolveAgentForDetailView(...)` — el algoritmo de §5 | Exemplar B + D | ~45 código, ≤ 35 docblock |
| 3 | `src/routes/discover.ts` | Modificar | Línea `337`: `discoveryService.getAgent(slug, registry)` → `resolveAgentForDetailView(slug, registry)`. Un import nuevo | — | +2 / −1 |
| 4 | `src/routes/agent-card.ts` | Modificar | Línea `43`: idem. Un import nuevo. ⛔ **NO tocar `:66-68`** | — | +2 / −1 |
| 5 | `src/services/agent-detail.test.ts` | **CREAR** | T-01, T-02a/b/c, T-03, T-04, T-06a, T-06b, T-09, **T-10** | Exemplar C | ≤ 250 |
| 6 | `src/routes/discover.detail-capabilities.test.ts` | **CREAR** | T-05, **T-07a/b**, T-08 | Exemplar C | ≤ 190 |
| 7 | `doc/sdd/230-…/auto-blindaje.md` | **CREAR** | Bitácora de errores + **los rojos citados de CD-2** | — | prosa |

### ⛔ Archivos que uno esperaría tocar y que NO se tocan — es intencional

| Archivo | Por qué NO |
|---|---|
| `src/services/discovery.ts` | **CD-11. Cero líneas.** Es lo que hace automáticas a CD-3, CD-4, AC-7 y las 3 anclas del guardián de citas (líneas 63, 449, 529) |
| `src/services/agent-card.ts` | AC-5 se satisface **sin editarlo**: `:124` ya deriva `skills` de `agent.capabilities`. Se **verifica** con T-05; no se toca |
| `README.md`, `doc/**` (salvo `doc/sdd/230-…/`) | Fuera de scope |
| `supabase/migrations/**` | Sin cambios de esquema. **N/A** |
| `test/**` | **CD-13**: `npm run lint` no mira `test/`. Los tests de esta HU viven en `src/` |

### ✅ Verificado antes de escribir esto

```
src/services/agent-detail.ts                       → NO existe (nombre libre)
src/routes/discover.detail-capabilities.test.ts    → NO existe (nombre libre)
vitest.config.ts:5  include: ['src/**/*.test.ts', 'test/**/*.test.ts', …]
                    ⇒ un test en src/ SÍ corre en `npm test` Y SÍ lo lintea biome
doc/sdd/_INDEX.md   ya tiene la fila 230 (grep -c '230-wkh-369' → 1)
```

---

# 4. Exemplars (verificados en este árbol, rangos confirmados)

## Exemplar A — «campo aditivo omitido, no `null`»
**Archivo**: `src/types/index.ts:421-458` (la interfaz `Agent`)
**Usar para**: archivo #1.

El repo ya usa este patrón **tres veces** en la misma interfaz. Copialo tal cual:

```
src/types/index.ts:445-457
      /**
       * WKH-100 (AC-8): ERC-8004 verified identity surfaced from the agent's
       * bound Agent Key. Omitted (not null) when the agent has no bound identity
       * (backward-compat — AC-9/CD-9).
       */
      identity?: AgentCardIdentity;
      /** WKH-103 (AC-1): score off-chain computado. Omitido si 0 tasks (CD-9). */
      computedReputation?: AgentReputation;
      /**
       * WKH-313 (AC-2/DT-3): el agente entró bajo el piso por el CARRIL DE ESTRENO.
       * Omitido (no `null`) salvo que la admisión haya ocurrido de verdad.
       */
      trial?: AgentTrialAdmission;
    }
```

**Patrón clave:**
- Campo `?:` opcional. **Nunca** `| null`. Se **omite** la clave cuando resuelve bien.
- Docblock que nombra la HU y el motivo de backward-compat.
- El campo va **al final** de la interfaz, después de `trial` (línea 457).

### 🎯 Dos verificaciones que hice por vos, y que acotan el riesgo del guardián de citas

`src/types/index.ts` está en `CORTE_A_PATHS` (`test/cited-lines-guard.citations.ts:87-102`),
o sea que **toda** cita `:N` que escribas ahí tiene que estar declarada a mano en un archivo
fuera de tu scope. De ahí sale **CD-12**. Pero la otra mitad del riesgo (que tu inserción
DESPLACE una línea citada, el `E-LINE_MOVED` que pasó en la HU 226) **está medida y no aplica**:

```
Las ÚNICAS dos citas que apuntan a src/types/index.ts:
  test/cited-lines-guard.citations.ts:221-225   → line 203, endLine 225
  test/cited-lines-guard.citations.ts:356-360   → line 217, endLine 218
Tu inserción va DESPUÉS de la línea 457 ⇒ no puede moverlas.

Ninguna cita tiene target = src/routes/discover.ts, src/routes/agent-card.ts
ni src/services/agent-card.ts  (grep con /usr/bin/grep → 0 resultados)
⇒ tus ediciones en los routes no pueden disparar E-LINE_MOVED.
```

## Exemplar B — «el enriquecimiento se resuelve en el ROUTE, NO en `getAgent`»
**Archivo**: `src/routes/agent-card.ts:52-56` (guard self-published) y `:91-101`
(el precedente exacto de esta decisión)
**Usar para**: archivo #2.

```
src/routes/agent-card.ts:52-56
      let registryConfig: RegistryConfig | undefined;
      if (agent.registry_id === SELF_PUBLISHED_REGISTRY_ID) {
        registryConfig = {
          id: SELF_PUBLISHED_REGISTRY_ID,
          name: agent.registry,
```

```
src/routes/agent-card.ts:91-101
      // WKH-103 (DT-8): score off-chain resuelto antes del build. Graceful
      // (AC-4/CD-5). Se computa en el ROUTE (NO en getAgent) para una sola
      // fuente y para tener el score listo cuando W3 agregue el on-chain.
      let computedReputation: AgentReputation | undefined;
      try {
        computedReputation =
          (await reputationService.computeReputationForAgent(agent.slug)) ??
          undefined;
      } catch {
        computedReputation = undefined; // sin reputación, NUNCA 5xx (CD-5)
      }
```

**Patrón clave, y es lo que tenés que copiar literalmente:**
- El guard de self-published es `agent.registry_id === SELF_PUBLISHED_REGISTRY_ID`, con
  `SELF_PUBLISHED_REGISTRY_ID` importado de `../types/index.js` (`src/types/index.ts:305`).
- El enriquecimiento va envuelto en `try { … } catch { … }` y **NUNCA produce un 5xx**: si
  falla, se degrada. En tu caso la degradación es `capabilitiesState = 'unresolved'`.
- El comentario nombra la HU, el AC y el CD que lo justifican.

## Exemplar C — «testigo que ejercita `mapAgent` de verdad» (CD-7)
**Archivo**: `src/services/discovery.test.ts:21-29` + `:43-48` + `:143-177`
**Usar para**: archivos #5 y #6.

Las dos piezas obligatorias del doble:

```
src/services/discovery.test.ts:21-29
    vi.mock('./registry.js', () => ({
      registryService: {
        getEnabled: vi.fn(),
        get: vi.fn(),
        // HIGH-1: el filtro `query.registry` usa `getWithSecrets` (necesita
        // `auth.value` para el header outbound). `get` quedó redactado.
        getWithSecrets: vi.fn(),
      },
    }));
```

```
src/services/discovery.test.ts:43-48
    const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
    vi.stubGlobal('fetch', mockFetch);
    vi.mock('undici', async (importOriginal) => {
      const actual = await importOriginal<typeof import('undici')>();
      return { ...actual, fetch: mockFetch };
    });
```

⚠️ **Las DOS son obligatorias.** `ssrfFetch` usa el `fetch` PROPIO de undici, no el global.
Si doblás sólo uno, el doble no intercepta y el test se va a la red o falla raro.

Los helpers de fixture que podés copiar:

```
src/services/discovery.test.ts:143-155     function makeRegistry(o: Partial<RegistryConfig> = {})
                                             → { id:'reg-1', name:'test-registry',
                                                 discoveryEndpoint:'https://example.com/agents',
                                                 invokeEndpoint:'https://example.com/invoke/{slug}',
                                                 schema:{discovery:{}, invoke:{method:'POST'}},
                                                 enabled:true, createdAt:new Date(), ownerRef:'system' }
src/services/discovery.test.ts:157-170     function makeRawAgent(o = {})
src/services/discovery.test.ts:172-178     function setupRegistryResponse(rawAgents)
src/services/discovery.test.ts:1492-1501   function makeV2Registry()  → agentMapping: { price: 'price_per_call_usdc' }
src/services/discovery.test.ts:1411-1445   el test que llama a `discoveryService.getAgent('bound-agent')` de verdad
```

Otros mocks que ese archivo necesita y vos también vas a necesitar:

```
src/services/discovery.test.ts:16-18   vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }))
src/services/discovery.test.ts:32-36   vi.mock('../lib/circuit-breaker.js', …execute: (fn) => fn())
src/services/discovery.test.ts:67-83   vi.mock('../lib/supabase.js', …)   // builder thenable
src/services/discovery.test.ts:94-115  vi.mock('./reputation.js', …)      // computeStandingBatch + computeReputationBatch
```

**Dos cosas que el exemplar NO hace y vos SÍ tenés que hacer:**

1. **Mockeá también `./agent.js`.** `discovery.ts:63` importa `publishedAgentService` de
   `./agent.js`, y lo usa en `discover()` (`:253 listAsAgents()`) y en `getAgent()`
   (`:1393 getBySlugAsAgent(slug)`). El exemplar lo deja correr contra el supabase falso;
   para vos eso es no-determinismo gratis. Mockealo con `listAsAgents`, `getBySlugAsAgent`
   y `listPublisherAnchors`.
2. **`mockFetch` tiene que responder SEGÚN LA URL**, no con `mockResolvedValue` único: el
   `discoveryEndpoint` devuelve el sobre de lista con `tags`; el `agentEndpoint` devuelve
   la forma de detalle **sin** `tags`. Ésa es la única manera de que `mapAgent` corra de
   verdad en los dos caminos.

⛔ **PROHIBIDO** el patrón de `src/routes/discover.test.ts:24-30`:

```
src/routes/discover.test.ts:24-30
    vi.mock('../services/discovery.js', () => ({
      discoveryService: {
        discover: vi.fn().mockResolvedValue({ agents: [], total: 0 }),
        getAgent: vi.fn().mockResolvedValue(null),
      },
    }));
```

**Ésa es la razón MEDIDA de que este bug haya sobrevivido**: con `getAgent` mockeado,
`mapAgent` nunca corre en la ruta de detalle bajo test, y por construcción ninguna cantidad
de tests de esa ruta puede cazarlo. Es **CD-7**.

## Exemplar D — export de servicio como función libre
**Archivo**: `src/services/agent-price.ts:1-12` y `:44`
**Usar para**: archivo #2.

```
src/services/agent-price.ts:1-12
    /**
     * Agent Price Resolver — WKH-59 (real-price-debit)
     *
     * Resuelve `agent.priceUsdc` desde el registry con cache in-process TTL 60s.
     * Usado por `src/routes/compose.ts` preHandler antes del middleware de debit.
     *
     * CD-8: única ubicación de esta función. NO duplicar.
     * CD-1: TypeScript strict, sin `any`.
     * DT-B: cache Map (no Redis, no existe client en el proyecto).
     * DT-G: cache negativo NO se persiste (null → no cachear; re-fetch en próximo miss).
     */
    import { discoveryService } from './discovery.js';
```
```
src/services/agent-price.ts:44        export async function resolveAgentPriceUsdc(
```

**Patrón clave:** docblock de cabecera que nombra la HU, quién lo consume y los CD que
gobiernan; `export async function`, no un objeto-servicio; imports con extensión `.js`.

⛔ **NO copies la caché TTL de `agent-price.ts:16-19`, `:83`.** Está fuera de scope (§10).

---

# 5. Contrato de Integración ⚠️ BLOQUEANTE

Esta HU cambia lo que dos endpoints HTTP publican y agrega una llamada gateway → registro
federado. Los tres contratos, exactos.

## 5.1 `resolveAgentForDetailView` — el contrato interno (route → service)

```
Archivo:  src/services/agent-detail.ts   (NUEVO)
Firma:    export async function resolveAgentForDetailView(
            slug: string,
            registryId?: string,
          ): Promise<Agent | null>
```

`registryId` es **el mismo valor** que hoy se le pasa a `getAgent` como segundo argumento
(el querystring `?registry=` de los dos routes). Verificado: `getAgent(slug, registryId)`
lo entrega a `registryService.getWithSecrets(registryId)` (`discovery.ts:1402-1406`), que
filtra `.eq('id', id)` (`registry.ts:262-268`). **Es un ID.**

### El algoritmo, paso por paso

```
1. const agent = await discoveryService.getAgent(slug, registryId)   // SIN CAMBIOS
   if (!agent) return null                                            // el route hace el 404, como hoy

2. if (agent.registry_id === SELF_PUBLISHED_REGISTRY_ID) return agent
   // medido: 0 divergencias en los 5 self-published. No se paga I/O por nada.

3. try {
     const listado = await discoveryService.discover({
       registry: agent.registry_id,     // 🔴 EL ID. Ver §0.2. NUNCA agent.registry
       includeInactive: true,           // el detalle sirve agentes inactivos; la lista
     })                                 // los filtra por default (discovery.ts:448-450)

4.   const entrada = listado.agents.find((a) => a.slug === agent.slug)

5a.  if (entrada) {
       agent.capabilities = entrada.capabilities
       agent.reputation   = entrada.reputation     // cierra las 2 divergencias de AC-6
       return agent                                // SIN capabilitiesState (clave OMITIDA)
     }

5b.  agent.capabilitiesState = 'unresolved'        // AC-2
     return agent                                  // capabilities queda como estaba ([])

   } catch {
     agent.capabilitiesState = 'unresolved'        // AC-2 · NUNCA un 5xx
     return agent
   }
```

⚠️ **`includeInactive: true` es load-bearing, no decorativo.** `discovery.ts:448-450` filtra
`a.status === 'active'` cuando `includeInactive` es falsy. Sin esa bandera, todo agente
federado inactivo caería en 5b y publicaría `'unresolved'` teniendo capacidades resueltas.

⚠️ **`agent.reputation` de la lista puede ser `NaN`** (`discovery.ts:1364-1366` hace
`Number(undefined)`, y `JSON.stringify(NaN)` da `null`). Eso es correcto y esperado:
copiás lo que la lista publica, sea lo que sea. **NO lo "arregles"** — es `TD-369-1` y
arreglarlo violaría AC-7 (§10).

## 5.2 `GET /discover/:slug` — el contrato HTTP de salida

**Sin cambios** en códigos ni en forma, salvo **una clave aditiva y opcional**.

| Salida | Significado, ahora **sin ambigüedad** |
|---|---|
| `capabilities: ["a","b"]`, sin `capabilitiesState` | El agente declara esas capacidades |
| `capabilities: []`, **sin** `capabilitiesState` | El agente declara que **no tiene** capacidades |
| `capabilities: []`, **con** `capabilitiesState: "unresolved"` | El gateway **no pudo leerlas**. No es una afirmación sobre el agente |

Precedente del repo: WKH-318, `rows: null` ≠ `rows: 0`. No se inventa una segunda doctrina.

**Errores — la tabla completa:**

| HTTP | Cuándo | Cambia respecto de hoy |
|---|---|---|
| `200` | El agente existe (federado o self-published) | No |
| `200` + `capabilitiesState: "unresolved"` | `discover()` lanzó (red, SSRF, breaker abierto), o el slug no está en el listado, o el catálogo vino truncado y el slug quedó fuera de página, o el registro está deshabilitado | **Nuevo** |
| `404 {"error":"Agent not found"}` | `resolveAgentForDetailView` devolvió `null` | No |
| `5xx` | ⛔ **NUNCA por el enriquecimiento.** Es aditivo y degradable | No |

⛔ **`metadata` NO se toca** (CD-16). En el detalle sigue siendo el cuerpo crudo del
endpoint de detalle (`discovery.ts:1378`). Es la superficie por la que las sondas de
WKH-364 leen el esquema; pisarla con la de la lista cambiaría de qué fuente derivan su input.
Cambiar eso es otra HU.

⛔ **`payment`, `identity`, `invokeUrl`, `priceUsdc`, `computedReputation` NO se tocan.**

## 5.3 `GET /agents/:slug/agent-card` — el efecto de AC-5

**No se escribe una sola línea nueva de derivación.** `src/services/agent-card.ts:124` ya
hace:

```
src/services/agent-card.ts:124
        const skills: AgentSkill[] = agent.capabilities.map((cap) => ({
          id: cap,
          name: cap,
          description: cap,
        }));
```

⇒ Con `capabilities` bien resuelto, `skills` sale bien **gratis**. Se **verifica** con T-05.

⚠️ **Corolario de diseño, y es DT-6:** `capabilities` sigue siendo `string[]`, **jamás
`null`**. Ese `.map(...)` no tiene guard: un `null` ahí es un `TypeError` en el Agent Card.
Por eso el marcador es un campo **aditivo y aparte**, no un cambio de tipo.

## 5.4 gateway → registro federado (la llamada que se agrega)

| | |
|---|---|
| Quién | `resolveAgentForDetailView`, paso 3 |
| Qué | `discoveryService.discover({ registry: agent.registry_id, includeInactive: true })` |
| Cuándo | Sólo en las dos rutas GRATIS de detalle. **Nunca** en `/compose`, `/orchestrate` ni en la cotización |
| Costo medido | **~+220 ms** (0.262 / 0.220 / 0.220 s en 3 corridas contra producción). El detalle pasa de ~300 ms a ~520 ms en p50 |
| Por qué acotado al registry del agente | `GET /discover?limit=100` sin `registry` costó 0.735 / 0.450 / 0.417 s, re-consulta registries ajenos y mezcla el merge de self-published |
| Caché | ⛔ **NO.** `TD-369-3`. Ver §10 |

---

# 6. Constraint Directives

## 6.1 OBLIGATORIO

- **CD-1** — 🔴 **El fixture de paridad DEBE tener capacidades NO VACÍAS en un agente
  federado.** Al menos **2** (el fixture de §7.1 tiene 4) en la vista de LISTA, **y** un
  payload de detalle con la forma divergente medida (sin `tags`). **Un fixture vacío pasa
  con el bug puesto** — es literalmente el error de muestreo del issue #182, movido al test,
  donde es mucho más caro porque se ve verde. ⚙️ **Mecanizada**: T-03 asserta
  `coincideConContenido >= 1`, así que un fixture vacío **no puede** ponerlo en verde.
- **CD-2** — **Romper a propósito CADA test nuevo antes de darlo por bueno.** La mutación
  exacta de cada uno está en §7.2. El rojo se cita en `auto-blindaje.md` con el
  `archivo:línea` mutado y la salida real. **Un guard cuyo rojo nadie vio no está entregado.**
- **CD-6** — **Ningún guard puede leerse a sí mismo.** Los valores esperados se escriben
  **literales, a mano**. ⛔ PROHIBIDO derivarlos llamando a `mapAgent`, a `discover()` o al
  propio resolver. ⛔ PROHIBIDO correr el test, copiar el `actual` y pegarlo como `expected`.
- **CD-8** — **El gate se corre COMPLETO y EN ORDEN, una vez** (§0.4). Correr las partes de
  un gate no es correr el gate.
- **CD-13** — **Todos los tests de esta HU van en `src/`, nunca en `test/`.** `npm run lint`
  es `biome check src/` y no mira `test/`. Precedente: auto-blindaje de la HU 229, W0.
- **CD-14** — **Correr `npx biome check --write <archivo>` sobre cada archivo nuevo o
  modificado ANTES de cantar verde**, y re-correr el gate **desde el paso 1**, no desde donde
  falló. `tsc` y `vitest` son ciegos al formato y `lint` va **segundo**.
  **Precedente en DOS HUs consecutivas: 226 (Wave 1) y 229 (W0). Es el error recurrente #1
  de este repo.**
- **CD-15** — **`[]` nunca se publica como afirmación sin haber comprobado la resolución.**
  Corolario de AC-2 escrito como prohibición, para que ningún camino nuevo lo reintroduzca.

## 6.2 PROHIBIDO

- **CD-3** — ⛔ **Tocar el camino del dinero.** Nada de `src/lib/downstream-payment.ts`,
  `src/adapters/**`, `src/middleware/x402.ts`, `fee-*`, settle, escrow. **Demo Day es el
  lunes 31.** Si el arreglo parece necesitarlo, está mal planteado: parar y escalar.
- **CD-4** — ⛔ **Cambiar el comportamiento observable de `mapAgent` para el camino de LISTA.**
  Satisfecho por construcción (no se edita), **y aun así se demuestra EJECUTANDO** (T-07a/b).
- **CD-5** — ⛔ **«Arreglar» esto editando datos.** Ni la fila `registries` de `bdwv`, ni
  republicar el catálogo. `bdwv` sirve producción.
- **CD-7** — ⛔ **Validar esta HU con un test que mockee `discoveryService`.** Ver Exemplar C.
- **CD-9** — ⛔ **Derivar capacidades de `category`, `agent_type`, `chain`, `creator` o de
  cualquier heurística sobre el payload de detalle.** `category` produciría
  `capabilities: ["compliance"]`: un valor **plausible, con la forma correcta, y falso** —
  pierde el 75 % del dato, rompe la resolución por capacidad, y es exactamente el modo de
  falla que esta HU existe para matar. Un `[]` al menos se ve raro; un `["compliance"]` pasa
  todas las revisiones. ⚠️ Es **atractiva** porque es la única salida que no cuesta I/O; ésa
  es precisamente la razón por la que vuelve. **Si el listado no resuelve, la salida es
  `'unresolved'`, nunca una aproximación.**
- **CD-10** — 🔴 ⛔ **Pasar `agent.registry` (nombre) a `discover({registry})`.** Va
  `agent.registry_id`. Ver §0.2 completo. **T-10 es obligatorio.**
- **CD-11** — ⛔ **Editar `src/services/discovery.ts`.** Cero líneas commiteadas. Protege
  CD-3, CD-4, AC-7 y las 3 anclas del guardián de citas (líneas 63, 449, 529). **La única
  excepción son las mutaciones TEMPORALES de CD-2, con el protocolo de §7.3.**
- **CD-12** — ⛔ **Escribir un token `:<dígito>` en cualquier comentario que agregues a
  `src/types/index.ts`.** Ese archivo es uno de los `CORTE_A_PATHS`
  (`test/cited-lines-guard.citations.ts:87-102`): toda cita ahí —incluso un `:N` suelto—
  debe estar declarada a mano en un archivo **fuera de tu Scope IN**. Es un rojo del gate.
  **Precedente: auto-blindaje de la HU 228, Wave 0.**
  **Verificación obligatoria antes de cerrar W0:**
  ```bash
  sed -n '458,475p' src/types/index.ts | /usr/bin/grep -nE ':[0-9]'   # → sin resultados
  ```
  (ajustá el rango al que hayas escrito de verdad).
  ⇒ En el docblock nombrá **WKH-369 / AC-2 / DT-6**, sin números de línea.
- **CD-16** — ⛔ **Tocar `metadata` en el camino de detalle.** §5.2.
- ⛔ **Dependencias nuevas: NINGUNA.** Esta HU no agrega ni actualiza ningún paquete. Los
  únicos símbolos externos son `vitest` y `fastify`, ya importados en los exemplars.
- ⛔ **NO escribas rutas con forma de path a documentos (`doc/…​.md`) dentro de comentarios de
  código.** `test/docs-referenced-by-code-exist.test.ts` verifica que resuelvan. Si citás la
  HU, citá `WKH-369` a secas.
- ⛔ **NO "mejores" código adyacente. NO refactorices `mapAgent`, `toArray`, `getNestedValue`
  ni `resolvePriceWithFallback`.** El mapper **no es el bug** — ésa es la hipótesis #1, que
  ya cayó.

---

# 7. Test Expectations

| Archivo | ACs | Tipo |
|---|---|---|
| `src/services/agent-detail.test.ts` | AC-1, AC-2, AC-3, AC-4, AC-6 + CD-1, CD-10 | unit (service, sin HTTP) |
| `src/routes/discover.detail-capabilities.test.ts` | AC-1, AC-5, AC-7 | integration (borde HTTP con Fastify) |

**Test-first: SÍ.** Es lógica de negocio sobre una API. Escribí el test, vela fallar por la
razón correcta, después implementá.

## 7.1 El fixture — donde vive CD-1

A mano, en `src/services/agent-detail.test.ts`, con **la forma medida en producción**, nunca
inventada. Los cuatro agentes son obligatorios: cada uno cubre un estado distinto.

| Agente | Payload de LISTA (el `raw` que devuelve el `discoveryEndpoint`) | Payload de DETALLE (el `raw` que devuelve el `agentEndpoint`) | Rol |
|---|---|---|---|
| `fed-con-caps` | `tags: ["remittance","remit","kyc","compliance"]`, `price_per_call_usdc: 0.001`, `erc8004: { reputation_score: 7 }`, `status: "active"` | `category: "compliance"`, `price_per_call: 0.001`, `reputation: { score: null, count: 0 }`, **SIN `tags`**, **SIN `erc8004`**, **SIN `price_per_call_usdc`** | 🔴 **El que hace NO VACUO al guard (CD-1)** |
| `fed-sin-caps` | `tags: []` | mismo shape, sin `tags` | `coincide-en-vacío`: prueba que el arreglo **no inventa** |
| `fed-fuera-del-listado` | *(NO aparece en la lista)* | igual que `fed-con-caps` | Dispara AC-2 |
| `self-agent` | self-published: `registry_id === SELF_PUBLISHED_REGISTRY_ID`, `capabilities: ["weather","geo"]` | — | Prueba que se saltea el paso 3 |

El registro del fixture: `makeRegistry({ id: 'wasiai', name: 'WasiAI', agentEndpoint:
'https://example.com/agent/{slug}', schema: { discovery: { agentMapping: { capabilities:
'tags', price: 'price_per_call_usdc', reputation: 'erc8004.reputation_score' } }, invoke: {
method: 'POST' } } })`.

⚠️ **`id: 'wasiai'` y `name: 'WasiAI'` DEBEN ser distintos.** Si los hacés iguales, T-10 se
vuelve vacuo y el riesgo #1 pasa en verde. Es la mitad del valor de todo el fixture.

⛔ **CD-6**: los valores esperados se escriben **literales**. Prohibido derivarlos llamando a
`mapAgent`, a `discover()` ni al resolver.

## 7.2 Los tests, con su mutación y su rojo esperado

> ⚠️ **CD-2 gobierna esta tabla.** Cada mutación se aplica, se corre **sólo ese archivo de
> test** (`npx vitest run src/services/agent-detail.test.ts`), se copia el rojo a
> `auto-blindaje.md` y **se restaura con `cp`** (§7.3).

| ID | AC / CD | Archivo | Qué afirma | Mutación que DEBE ponerlo ROJO | Rojo esperado |
|---|---|---|---|---|---|
| **T-01** | AC-1 | `agent-detail.test.ts` | `fed-con-caps` en detalle devuelve **exactamente** `["remittance","remit","kyc","compliance"]` | En `agent-detail.ts`, volver el paso 5a un no-op (comentar la asignación de `capabilities`) | `expected [] to deep equal [ 'remittance', … ]` |
| **T-02a** | AC-2 | `agent-detail.test.ts` | `fed-fuera-del-listado` → `capabilitiesState === 'unresolved'` **Y** `capabilities` sigue siendo `[]` | Borrar la asignación de `capabilitiesState` en 5b | `expected undefined to be 'unresolved'` |
| **T-02b** | AC-2 | `agent-detail.test.ts` | `fed-sin-caps` → `capabilities: []` **Y la clave `capabilitiesState` AUSENTE**: `expect('capabilitiesState' in agent).toBe(false)` | Marcar `'unresolved'` siempre que `capabilities.length === 0` | `expected true to be false` |
| **T-02c** | AC-2 | `agent-detail.test.ts` | Si `discover()` **rechaza**, se devuelve el agente con `'unresolved'` — **no** se propaga el throw | Sacar el `try/catch` del paso 3 | el test falla con el error propagado, no con un assert |
| **T-03** | AC-3, AC-4, **CD-1** | `agent-detail.test.ts` | Partición de **TRES** estados sobre el fixture completo: `{ difiere: 0, coincideConContenido: >= 1, coincideEnVacio: >= 1 }`. 🔴 **`coincideConContenido >= 1` es la aserción que hace IMPOSIBLE pasar con fixture vacío** | Restaurar el defecto: que el paso 5a lea las capacidades del payload de DETALLE en vez de la entrada del listado | `difiere: 1` ⇒ `expected 1 to be 0` |
| **T-04** | AC-4 | `agent-detail.test.ts` | La tasa se calcula sobre `difiere + coincideConContenido`, **NO** sobre el total. Con el fixture: `1/2 = 50 %`, y **no** `1/4 = 25 %` | Cambiar el denominador al total de agentes | `expected 25 to be 50` |
| **T-06a** | AC-6 | `agent-detail.test.ts` | El `reputation` del detalle es **`7`** (el de la lista), no `NaN` | Sacar la asignación de `reputation` del paso 5a | `expected NaN to be 7` |
| **T-06b** | AC-6, TD-369-4 | `agent-detail.test.ts` | 🔴 **Dos casos:** (a) con el payload de detalle tal cual (**con** `price_per_call`), `priceUsdc === 0.001`; (b) con un payload de detalle **sin** `price_per_call`, `priceUsdc === 0` y **DIVERGE** de la lista. Fija que el `0/29` medido depende de `V2_PRICE_FALLBACK_FIELD` y **no** de que el detalle esté sano | Cambiar `V2_PRICE_FALLBACK_FIELD` en `discovery.ts:1500` a `'price_per_call_XXX'`. **Mutación temporal — protocolo §7.3** | el caso (a) da `expected 0 to be 0.001` |
| **T-09** | — | `agent-detail.test.ts` | `self-agent` **no dispara ningún fetch de catálogo**: contar llamadas a `mockFetch` antes y después, y assertar que no aumentaron | Sacar el guard de self-published del paso 2 | `expected 1 to be 0` |
| **T-10** | **CD-10** 🔴 | `agent-detail.test.ts` | El resolver llama a `discover()` con **`registry: 'wasiai'` (el ID)**. Se asserta el **argumento exacto**: `expect(discoverSpy).toHaveBeenCalledWith({ registry: 'wasiai', includeInactive: true })` | Cambiar el paso 3 a `agent.registry` (el nombre) | `expected { registry: 'WasiAI', … }` |
| **T-05** | AC-5 | `discover.detail-capabilities.test.ts` | `GET /agents/fed-con-caps/agent-card` → `skills.length === 4` **y los 4 `id` correctos** | La misma de T-01 | `expected 0 to be 4` |
| **T-07a** | **AC-7** 🔴 | `discover.detail-capabilities.test.ts` | Paridad **EJECUTADA** del camino de LISTA: `JSON.stringify(result.agents[0])` de `discoveryService.discover({})` sobre el fixture, comparado contra un **literal escrito a mano** (CD-6) | Escribir `capabilitiesState` también dentro de `mapAgent`. **Mutación temporal — protocolo §7.3** | el string difiere |
| **T-07b** | **AC-7** | `discover.detail-capabilities.test.ts` | Invariante de key-set: para **todo** agente de `discover({})`, `Object.keys(agent)` **NO** incluye `'capabilitiesState'`. Cubre también al federado con `tags: []` | La misma de T-07a | `expected [ …, 'capabilitiesState' ] not to contain 'capabilitiesState'` |
| **T-08** | AC-1, AC-5 | `discover.detail-capabilities.test.ts` | El borde HTTP: `GET /discover/fed-con-caps` → `200` con las 4 capacidades, **sin mockear `discoveryService`** (CD-7) | Volver el route a `discoveryService.getAgent` pelado | `expected [] to have length 4` |

**AC-8 no es un test: es el gate del repo (§0.4), corrido completo y en orden, una vez.**

### 🔴 T-07a: la trampa que te espera, dicha antes de que caigas

El literal de T-07a lo vas a escribir a mano leyendo `mapAgent` (`discovery.ts:1345-1382`),
y la primera corrida probablemente **no** va a coincidir. **En ese momento la tentación es
pegar el `actual` como `expected`. Eso es exactamente lo que CD-6 prohíbe**: un guard que
recalcula lo que vigila aplaude cualquier cosa, incluido el bug.

**Lo que hacés en cambio:** mirás la diferencia, decidís **cuál de los dos lados tiene razón
leyendo `mapAgent`**, y anotás la resolución en `auto-blindaje.md`. Si el literal estaba mal,
lo corregís **desde el código fuente del mapper**, no desde la salida.

Para que el literal sea manejable, el fixture de T-07a usa **UN solo agente**.

## 7.3 🔴 Protocolo de mutación cuando toca `src/services/discovery.ts`

T-06b y T-07a/b requieren mutar `discovery.ts` **temporalmente**. CD-11 prohíbe **commitear**
cambios ahí, no medir. El protocolo, y no te lo saltees:

```bash
# 1. Copia de respaldo FUERA del repo (tu scratchpad de sesión, no /tmp pelado)
BAK="$SCRATCH/discovery.ts.bak"
cp src/services/discovery.ts "$BAK"

# 2. Mutar (Edit), correr SÓLO el test afectado, capturar el rojo
npx vitest run src/services/agent-detail.test.ts

# 3. Restaurar — ⛔ NUNCA `git checkout -- src/services/discovery.ts`
cp "$BAK" src/services/discovery.ts

# 4. PROBAR que quedó limpio (no alcanza con creerlo)
/usr/bin/git status --porcelain src/services/discovery.ts    # → salida VACÍA
/usr/bin/git diff --stat src/services/discovery.ts           # → salida VACÍA
```

⛔ **`git checkout --` está prohibido acá**: restaura desde el índice y se lleva puesto
cualquier otro cambio sin commitear, incluido lo que estabas midiendo.
⛔ **`diff` a secas está prohibido**: en este entorno contesta `Files are identical` sobre
archivos que difieren. Si querés comparar, `/usr/bin/diff`.

**El paso 4 es obligatorio antes del gate final de W3.** Si `git status --porcelain` sobre
`discovery.ts` devuelve algo, **parás** y restaurás antes de seguir.

---

# 8. Waves

## Wave −1 · Environment Gate (OBLIGATORIO — antes de tocar una línea)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a

# La rama al día. ⛔ NO uses `git log` para esto: omite los merges.
/usr/bin/git fetch origin
/usr/bin/git merge-base --is-ancestor origin/main HEAD && echo "AL DIA" || echo "FALTA MERGE"

# Los archivos base del Scope IN existen
ls src/types/index.ts src/routes/discover.ts src/routes/agent-card.ts \
   src/services/discovery.ts src/services/agent-card.ts src/services/discovery.test.ts

# Los nombres nuevos están libres
test -e src/services/agent-detail.ts && echo "⛔ YA EXISTE" || echo "libre"
test -e src/routes/discover.detail-capabilities.test.ts && echo "⛔ YA EXISTE" || echo "libre"

# Deps instaladas
npm ci --ignore-scripts || npm install --ignore-scripts

# Los 3 call-sites que vas a tocar están donde el Story File dice
sed -n '337p' src/routes/discover.ts     # → const agent = await discoveryService.getAgent(slug, registry);
sed -n '43p'  src/routes/agent-card.ts   # → const agent = await discoveryService.getAgent(slug, registry);
sed -n '457p' src/types/index.ts         # →   trial?: AgentTrialAdmission;
```

**Env vars: ninguna.** Esta HU no lee configuración nueva y sus tests no tocan la red ni la DB.

**Si algo de acá falla: PARÁ y reportá al orquestador.** No implementes sobre un entorno roto
ni sobre líneas que se movieron — si `sed -n '337p'` no muestra lo esperado, el árbol se
movió desde el SDD y hay que re-anclar.

## Wave 0 · Serial — contrato y línea base. Nada paralelizable.

- [ ] **W0.1** — Correr el **gate completo y en orden** (§0.4) sobre el árbol **sin tocar** y
      confirmar la línea base `310/316` · `6290/6309`. Si difiere, anotá el delta en
      `auto-blindaje.md` **antes** de escribir código: un número copiado de un artefacto
      envejece solo (precedente HU 228).
- [ ] **W0.2** — `src/types/index.ts`: agregar `capabilitiesState?: 'unresolved'` a `Agent`,
      **después de la línea 457**, con docblock según **Exemplar A**.
      ⛔ **CD-12**: cero tokens `:<dígito>` en ese docblock.
- [ ] **W0.3** — Verificar CD-12:
      `sed -n '<rango que escribiste>p' src/types/index.ts | /usr/bin/grep -nE ':[0-9]'` → vacío.
- [ ] **W0.4** — `npx biome check --write src/types/index.ts` (CD-14).
- [ ] **W0.5** — `npx tsc -p tsconfig.json --noEmit` → exit 0 · `npm run lint` → sin fixes.

**Salida de W0:** el tipo compila, `lint` limpio, y **nada más cambió**.

## Wave 1 · Serial — el resolver y su suite. Depende de W0.

- [ ] **W1.1** — **Escribir primero el test** `src/services/agent-detail.test.ts` con el
      fixture de §7.1 y T-01, T-02a/b/c, T-03, T-04, T-06a, T-06b, T-09, **T-10**.
      Verlo fallar por la razón correcta (el módulo no existe / la función no resuelve).
- [ ] **W1.2** — `src/services/agent-detail.ts` (**NUEVO**): `resolveAgentForDetailView`
      según §5.1, siguiendo **Exemplar B** (guard self-published + try/catch degradable) y
      **Exemplar D** (docblock de cabecera + `export async function`).
      El docblock nombra **CD-9, CD-10, CD-11 y CD-16**.
- [ ] **W1.3** — Ver los 10 tests en verde.
- [ ] **W1.4** — **CD-2**: aplicar la mutación de CADA uno de los 10 (§7.2), capturar el rojo
      literal, restaurar (§7.3 si toca `discovery.ts`), y volcarlo a
      `doc/sdd/230-…/auto-blindaje.md` con el `archivo:línea` mutado.
- [ ] **W1.5** — `npx biome check --write` sobre los dos archivos + gate **desde el paso 1**
      (CD-14).

**Salida de W1:** el resolver funciona y **está probado que sus 10 tests saben ponerse rojos**.

## Wave 2 · Los dos call-sites. Depende de W1. (Internamente paralelizable, pero son 2 líneas)

- [ ] **W2a** — `src/routes/discover.ts:337`: `discoveryService.getAgent(slug, registry)` →
      `resolveAgentForDetailView(slug, registry)`. Agregar el import
      (`import { resolveAgentForDetailView } from '../services/agent-detail.js';`) junto al de
      `discoveryService` (`src/routes/discover.ts:18`).
      ⚠️ Si `discoveryService` queda sin usar en ese archivo, **borrá el import** — un
      `import` sin usar es rojo de `biome` y ya sobrevivió 5 revisiones una vez por correr
      sólo `tsc` y `vitest`. (Verificá: `discoveryService` también se usa en el handler de
      `GET /discover` y `POST /discover` del mismo archivo, así que lo más probable es que
      **se quede**. Comprobalo con `/usr/bin/grep -n 'discoveryService' src/routes/discover.ts`.)
- [ ] **W2b** — `src/routes/agent-card.ts:43`: idem, mismo import.
      ⛔ **NO toques `:66-68`** — usa la convención `name` a propósito (§0.2).
      ⚠️ `discoveryService` **se sigue usando** en ese archivo (`extractDeclaredTokenId` viene
      del mismo módulo, `src/routes/agent-card.ts:10-13`): revisá con `grep` antes de borrar
      nada del bloque de imports.
- [ ] **W2c** — `npx biome check --write` sobre los dos + `npx tsc … --noEmit`.

## Wave 3 · Serial — los testigos del borde y de AC-7. Depende de W2.

- [ ] **W3.1** — `src/routes/discover.detail-capabilities.test.ts` (**NUEVO**): T-05,
      **T-07a**, **T-07b**, T-08. Fastify real, `discoveryService` **NO** mockeado (CD-7).
- [ ] **W3.2** — **CD-2** sobre los cuatro, con el protocolo de §7.3 para T-07a/b.
- [ ] **W3.3** — 🔴 **Verificar que `discovery.ts` quedó intacto:**
      `/usr/bin/git status --porcelain src/services/discovery.ts` → **vacío**.
- [ ] **W3.4** — `npx biome check --write` sobre el archivo nuevo (CD-14).
- [ ] **W3.5** — **CD-8**: el gate **completo y en orden, una vez**, contrastado contra la
      línea base de §0.4. Los conteos de `npm test` tienen que ser
      `>= 310 archivos` y `>= 6290 tests`, y **+2 archivos** de test nuevos.

## Wave 4 · Cierre.

- [ ] **W4.1** — `doc/sdd/230-…/auto-blindaje.md` completo: los **14 rojos** de CD-2, los
      errores que cometiste, y el delta del gate contra la línea base.
- [ ] **W4.2** — Medir el diff contra el presupuesto (§9) con `/usr/bin/git diff --stat`
      (⛔ **no** `git diff` bajo el proxy: trunca cortando hunks).
- [ ] **W4.3** — Reportar al orquestador. ⛔ **NO commitees.** ⛔ **NO actualices
      `doc/sdd/_INDEX.md`** — eso es F-DONE, del `nexus-docs`.

### Verificación incremental

| Wave | Verificación al completar |
|---|---|
| W−1 | Los 3 `sed -n` muestran lo esperado; los nombres nuevos están libres |
| W0 | `tsc` exit 0 + `lint` sin fixes + `grep -E ':[0-9]'` vacío en el rango nuevo |
| W1 | los 10 tests verdes **y** los 10 rojos citados |
| W2 | `tsc` exit 0 + `lint` sin fixes |
| W3 | gate COMPLETO y EN ORDEN + `git status --porcelain src/services/discovery.ts` vacío |
| W4 | diff dentro del presupuesto, `auto-blindaje.md` escrito |

---

# 9. Presupuesto de escala — el CR lo va a contrastar (regla 10 de CLAUDE.md)

| Concepto | Presupuesto |
|---|---|
| **Código de producción** (sin prosa, sin tests) | **≤ 70 líneas** |
| Docblocks y comentarios | ≤ 60 líneas |
| Tests | ≤ 420 líneas |
| **Total del diff en `src/`** | **≤ 550 líneas** |
| Umbral de justificación por escrito (2x) | **1100 líneas** |
| Archivos de producción tocados | **4** (1 nuevo, 3 modificados) |

**La pregunta que decide un exceso:** *¿qué parte de esto seguiría existiendo si lo
escribiera alguien que ya conoce este código?*

⚠️ **Señal de alarma:** si el diff de producción supera ~70 líneas, casi seguro apareció una
de estas cinco, y las cinco están prohibidas:

1. Un módulo de **caché de catálogo** (la más probable). 220 ms en una ruta gratis no lo
   pagan. `TD-369-3`.
2. Un **`agentPath` configurable** en el esquema de registro. Medido: **no hay a qué apuntar**.
3. Un **segundo `agentMapping`** para el endpoint de detalle. Mismo motivo.
4. **Refactorizar** `mapAgent` / `toArray` / `getNestedValue`. El mapper no es el bug.
5. Una **abstracción de «estrategia de resolución de campos»**. El defecto tiene **un** campo.

Un exceso justificado por escrito es información; un exceso silencioso es el hallazgo.

---

# 10. Out of Scope — NO tocar bajo ninguna circunstancia

- ⛔ **El camino del dinero**: `src/lib/downstream-payment.ts`, `src/adapters/**`,
  `src/middleware/x402.ts`, `fee-*`, settle, escrow. **Demo Day es el lunes 31.**
- ⛔ **El pin de seguridad del KYC** (`kyc-session-create`, `kyc-decision-read`).
- ⛔ **`src/services/discovery.ts`** (CD-11) y **`src/services/agent-card.ts`** (no hace falta).
- ⛔ **Republicar filas del catálogo** o editar `registries` en `bdwv` (CD-5). `bdwv` sirve
  **producción**.
- ⛔ **`TD-369-1` — el `NaN` de `reputation`.** `Agent.reputation` es `NaN` para **27 de 29**
  agentes en **las dos** vistas (`discovery.ts:1364-1366` hace `Number(undefined)`; el
  `JSON.stringify` lo serializa como `null`, así que **parece un `null` honesto**).
  ⚠️ **Va a parecerte una mejora obvia. Arreglarlo OMITIRÍA la clave y cambiaría los bytes
  de la LISTA para 27 agentes ⇒ violaría AC-7.** T-07a/b lo pondrían rojo. **No lo toques.**
- ⛔ **`TD-369-2` — `computedReputation` ausente en el detalle** (presente en 9 agentes de la
  lista, en 0 del detalle). No es campo de `agentMapping`, AC-6 no lo alcanza.
- ⛔ **`TD-369-3` — caché de catálogo.** §9.
- ⛔ **`TD-369-5` — `metadata.inputSchema` no existe en ninguna vista** (el crudo trae
  `input_schema` en snake_case y `src/services/agent-card.ts:141` lee
  `agent.metadata?.inputSchema`). Es de **WKH-364**.
- ⛔ Generalizar un `agentPath` / mapeo de detalle como contrato público para terceros. Y
  además, medido: **no resolvería nada**.
- ⛔ `README.md`, `doc/**` fuera de `doc/sdd/230-…/`, `doc/sdd/_INDEX.md`.
- ⛔ **NO commitees. NO pushees.** El pipeline sigue en AR → CR → F4 → DONE.

---

# 11. Done Definition — F3 termina cuando TODO esto es verdad

- [ ] Los **4 archivos de producción** están en el estado de §3, y **ningún otro** archivo de
      `src/` cambió. Probado con `/usr/bin/git status --porcelain src/`.
- [ ] `/usr/bin/git status --porcelain src/services/discovery.ts` → **salida vacía** (CD-11).
- [ ] Los **14 tests** (T-01, T-02a/b/c, T-03, T-04, T-05, T-06a, T-06b, T-07a, T-07b, T-08,
      T-09, T-10) están escritos, **en `src/`** (CD-13), y en verde.
- [ ] **CD-2 cumplida en los 14**: cada rojo está citado en `auto-blindaje.md` con el
      `archivo:línea` mutado y la salida real. *Un guard cuyo rojo nadie vio no está entregado.*
- [ ] **T-03 asserta `coincideConContenido >= 1`** y el fixture tiene un federado con **4**
      capacidades no vacías (CD-1).
- [ ] **T-10 asserta el argumento exacto `{ registry: 'wasiai', includeInactive: true }`**, con
      `id !== name` en el fixture (CD-10 / riesgo #1).
- [ ] `sed -n '<rango nuevo>p' src/types/index.ts | /usr/bin/grep -nE ':[0-9]'` → vacío (CD-12).
- [ ] **El gate corrido COMPLETO y EN ORDEN, una vez** (CD-8), con los tres resultados
      pegados en el reporte:
      `npx tsc -p tsconfig.json --noEmit` → exit 0 ·
      `npm run lint` → sin fixes ·
      `npm test` → `>= 310` archivos y `>= 6290` tests, **+2 archivos nuevos**.
- [ ] `npx biome check --write` corrido sobre **cada** archivo nuevo o modificado **antes**
      del gate final (CD-14).
- [ ] El diff está dentro del presupuesto de §9, o el exceso está **justificado por escrito**.
- [ ] `doc/sdd/230-…/auto-blindaje.md` escrito.
- [ ] **Sin commit, sin push, sin tocar `_INDEX.md`.**

---

# 12. Escalation Rule

> **Si algo no está en este Story File, PARÁS y preguntás al Architect.**
> No inventás. No asumís. No improvisás.

Escalá **inmediatamente**, sin intentar resolverlo, si:

1. El arreglo **parece necesitar** editar `src/services/discovery.ts` de forma permanente.
   → Está mal planteado (CD-11). Parar y escalar.
2. `sed -n '337p' src/routes/discover.ts` o `sed -n '43p' src/routes/agent-card.ts` **no**
   muestran el `getAgent` esperado. → El árbol se movió; hay que re-anclar el SDD.
3. Para que un test pase te hace falta **mockear `discoveryService`**. → Es CD-7, y es la
   razón medida de que este bug haya sobrevivido.
4. El literal de T-07a no coincide y **no podés explicar la diferencia leyendo `mapAgent`**.
   → No lo pegues. Escalá.
5. El diff de producción pasa de **140 líneas** (2x el presupuesto).
6. `npm run lint` da rojo en un archivo que **no** tocaste, o el guardián de citas
   (`test/cited-lines-guard.test.ts`) se pone rojo.
