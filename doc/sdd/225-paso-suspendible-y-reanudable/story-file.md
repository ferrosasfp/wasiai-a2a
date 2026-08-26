# Story File — WKH-225 · Paso suspendible y reanudable · **CORTE A**

> **Fase**: F2.5 · **Modo**: QUALITY · **Estado**: post-`SPEC_APPROVED`
> **Worktree**: `/home/ferdev/.openclaw/workspace/wt-225` · **Rama**: `feat/225-paso-suspendible-y-reanudable`
> **Base**: `5578998` (verificado: `git rev-parse --short HEAD` = `5578998`, `--abbrev-ref HEAD` = `feat/225-paso-suspendible-y-reanudable`)
> **Fuente**: `doc/sdd/225-paso-suspendible-y-reanudable/sdd.md` (898 líneas) + `work-item.md` (497 líneas)

---

## ⛔ LEER ESTO PRIMERO — 6 cosas que ponen `npm test` en ROJO y no son obvias

Si te salteás cualquiera de estas seis, la suite se cae y vas a perder una hora buscando por qué.
Las seis están **medidas en este worktree hoy**, no heredadas.

### 0. `.nexus/project-context.md` NO EXISTE EN ESTE WORKTREE

Está gitignoreado. Vive **sólo** en el checkout principal:

```
/home/ferdev/.openclaw/workspace/wasiai-a2a/.nexus/project-context.md   (668 líneas)
```

⛔ **No lo busques en `wt-225`: no está.** Leelo de esa ruta absoluta. Es la fuente de verdad del
stack (bandera `=== 'true'` `:252-268`; bdwv vs caldz `:97-101`; convención `_down.sql` `:403`;
`input-required` `:370`; sin `REDIS_URL` `:597`).

---

### 1. 🔴 EL GATE DE ESTE REPO **NO** ES `npm run qa`. ESE SCRIPT NO EXISTE.

Medido hoy en el worktree y en el checkout principal, en el commit base `5578998`:

```
$ /usr/bin/grep -n '"qa"' package.json    →  (sin salida, exit 1)
```

`package.json` declara exactamente: `dev`, `build`, `start`, `lint`, `format`, `test`,
`test:coverage`, `smoke:downstream`, `migrate:preflight`. **Ninguno es `qa`.**
(`CLAUDE.md` regla 9 dice `npm run qa`; la regla está vieja. Es `NC-2` del SDD §8.2 — bloquea F4,
no F3.)

**El gate real es `.github/workflows/ci.yml`. Corré esto, EN ESTE ORDEN, desde `wt-225`:**

```bash
npx tsc -p tsconfig.json --noEmit          # ci.yml:36-37
npm run lint                               # ci.yml:39-40   ← biome check src/
npm test                                   # ci.yml:42-43   ← vitest run
```

Y para cerrar la wave final, los dos sub-paquetes que el `npm test` de la raíz **no toca**
(`vitest.config.ts:6` excluye `packages/**`, y `mcp-servers/**` no está en su `include`):

```bash
cd mcp-servers/wasiai-x402 && npm ci --ignore-scripts && npm test     # ci.yml:67-73
cd packages/agent-sdk && npm install --ignore-scripts --no-audit --no-fund && npm test  # ci.yml:77-83
```

> 🔴 **`npm run lint` va SEGUNDO, y es el eslabón que ya se saltó una vez.** Un `import` sin usar
> sobrevivió **5 revisiones** porque todos corrían `vitest` + `tsc` y nadie corría `lint`.
> **Correr las partes de un gate no es correr el gate.** No declares una wave cerrada sin los tres.

---

### 2. 🔴 CD-20 — SI ESTA HU NO TOCA **LOS DOS** README, `npm test` VA A ROJO

Esto **no es documentación: es un eslabón del gate**. `test/readme-numbers.test.ts` deriva del repo
tres números y hace `expect(declarado).toBe(real)` (`:283`, `:289`, `:295`). Esta HU mueve **los
tres**.

| Número | README.md | README.es.md | Hoy | Cómo se deriva (el test lo re-deriva en cada `npm test`) |
|---|---|---|---|---|
| Archivos de test | `:378` `**303 test files**` | `:412` `**303 archivos de test**` | **303** | globs `include` de `vitest.config.ts` sobre el índice de git |
| Variables de `.env.example` | `:351` `documents **186 variables**` | `:385` `documenta **186 variables**` | **186** | `grep -cE '^[A-Z][A-Z0-9_]*=' .env.example` |
| Archivos lintados | `:383` `over **501 files**` | `:417` `sobre **501 archivos**` | **501** | `files.includes` de `biome.json` = `src/**/*.ts` |

**Texto literal de CD-20:**

> ✅ **OBLIGATORIO** actualizar los tres números derivados de **los dos** README en el **mismo
> commit** que agrega archivos de test, variables de `.env.example` o archivos bajo `src/`.
> ⛔ **PROHIBIDO copiar los números de este SDD**: re-derivarlos con los comandos que el propio
> README publica.

**Los comandos exactos para re-derivar** (⚠️ `/usr/bin/grep`, no `grep` — el hook `rtk` deforma la
salida mezclando números de línea con contenido):

```bash
cd /home/ferdev/.openclaw/workspace/wt-225
# 1) variables de .env.example
/usr/bin/grep -cE '^[A-Z][A-Z0-9_]*=' .env.example
# 2) archivos de test (los 3 globs del include de vitest.config.ts:5)
/usr/bin/git ls-files | /usr/bin/grep -E '^(src/.*\.test\.ts|test/.*\.test\.ts|test/.*\.test\.mjs)$' | /usr/bin/wc -l
# 3) archivos que linta Biome (biome.json:9 → "includes": ["src/**/*.ts"])
/usr/bin/git ls-files | /usr/bin/grep -E '^src/.*\.ts$' | /usr/bin/wc -l
```

> 🔴 **TRAMPA MEDIDA: `git ls-files` sólo ve archivos TRACKEADOS.** Si derivás los números **antes**
> de hacer `git add` de los archivos nuevos, te van a dar los de hoy y el README va a quedar mal.
> **Hacé `git add` primero, derivá después.**

> ⚠️ **El SDD §4 W2.5 proyecta `+7 test files / +3 variables / +3 archivos src`. Yo conté
> `+6 / +3 / +7`** (ver §"Contradicciones", abajo). **No uses ninguno de los dos: derivá.**

Y el espejo: `test/readme-parity.test.ts` (267 líneas) exige que `README.es.md` acompañe a
`README.md`. Cada idioma se mide **por separado** con su propio regex
(`test/readme-numbers.test.ts:204-223`); ninguno hereda el resultado del otro.

---

### 3. 🔴 CD-7 — EL GUARD `i > 0` DE `compose.ts:571` NO SE TOCA

**Texto literal de CD-7 (heredado del work-item):**

> ⛔ **PROHIBIDO tocar el guard `i > 0`** de `compose.ts:571`, ni su comentario CD-11.
> Es la única defensa contra el doble débito del step 0. **El AR debe verificar que sobrevive.**

Verificado hoy — `src/services/compose.ts:571` es exactamente:

```ts
      if (i > 0 && scopingKeyRow && chainId !== undefined) {
```

y su comentario vive en `:544-556` (`"CD-11: guard \`i > 0\` es la ÚNICA defensa contra double-debit
del step 0 … NO REMOVER. AR/CR debe verificar que esta línea sobrevive en futuras HUs."`).

**Testigo obligatorio `T-SUSP-GUARD571`** (`src/services/compose.suspend.test.ts`):
⚠️ **se ancla POR CONTENIDO, no por número de línea.** Esta HU inserta líneas antes y el número se
mueve. Ancla contra el string `'if (i > 0 && scopingKeyRow && chainId !== undefined) {'` leído del
fuente, nunca contra `571`.

---

### 4. 🔴 CD-18 — EL COBRO DEL FEE: EL CAMINO INGENUO COBRA **DOS VECES**

**Leé `src/routes/compose.ts:1167-1230` ANTES de tocar esa rama.** Medido hoy:

```ts
// src/routes/compose.ts:1182-1189
const feeParams: FeeChargeParams = {
  orchestrationId: request.id,        // :1183  ← la clave de idempotencia
  feeBaseUsdc: result.totalCostUsdc,  // :1184
  feeRate: getProtocolFeeRate(),
};
…
const feeResult = await chargeProtocolFee(feeParams);   // :1189
```

⇒ La idempotencia del fee es **por `orchestrationId` = `request.id`**. Un `POST /compose/resume` es
**otro `request.id`**. Si un run suspendido tomara el camino de éxito: se cobraría el fee sobre el
pipeline **parcial**, y **otra vez** al reanudar. **Doble cobro de fee, plata real.**

**Texto literal de CD-18:**

> ⛔ **PROHIBIDO** cobrar el fee de protocolo en la respuesta 202. Se cobra **una vez**, al
> completar, sobre el total acumulado, con `compose_run_id` como clave de idempotencia.

⇒ **La rama `if (result.suspended)` va ANTES del bloque de fee** (que arranca en el `try` de
`:1167`) **y antes** de `if (!result.success)` (`:1092`), **y después** de `if (reply.sent)`
(`:1087`, el 504 que refundea). Ese es el orden exacto y no es negociable.

---

### 5. 🔴 CD-17 — SIN PERSISTIR 3 CAMPOS, ESTA HU **ABRE** UN BYPASS DE UN GUARD DE DINERO

**Texto literal de CD-17:**

> ✅ **OBLIGATORIO** persistir `contracting_chain`, `contracting_depth` y `self_host_hint`, y
> **restaurarlos** en la reanudación. ⛔ Reanudar con `depth: 0` es un bypass del guard anti-bucle
> de capa 1 abierto por esta HU.

Medido en `src/services/compose.ts` — los tres se desestructuran del `ComposeRequest` en
`executePipeline`:

```ts
// :338-348 (aprox., dentro del destructuring de `request`)
contractingChain,
contractingDepth,
selfHostHint,
// :358
const selfIdentity = resolveSelfHosts(selfHostHint);
// :359-367
const outboundContracting = {
  chain: contractingChain ?? [],
  depth: contractingDepth ?? 0,
  canonicalId: selfIdentity.canonicalId,
  selfHosts: selfIdentity.hosts,
};
```

⇒ Si la reanudación reconstruye el `ComposeRequest` **sin** esos tres campos, arranca con
`chain: []` y `depth: 0` ⇒ **la profundidad del guard anti-bucle se reinicia** y el costo `5^k` que
WKH-360 cerró vuelve a estar abierto. Y `selfHostHint` ausente ⇒ `resolveSelfHosts` da `hosts: []`
⇒ **SITIO 3 y SITIO 4 quedan INERTES** (el propio docblock `:349-357` lo dice textual).

Testigo: **`T-RES-11`** — `depth` entrante 4 ⇒ el guard corta; `depth` 0 ⇒ no corta. Sin ese test,
la persistencia de `contracting_depth` es código que nadie mira.

---

### 6. 🔴🔴 HALLAZGO NUEVO DE ESTE F2.5 — **EL SDD NO LO MENCIONA**: `cited-lines-guard`

Existe un guardián que el SDD **no leyó**: `test/cited-lines-guard.test.ts` (+ `.citations.ts`,
`.scanner.ts`, `.exceptions.ts`), producto de la HU 224. Pone `npm test` en ROJO cuando una cita
`archivo:línea` apunta a otra cosa.

**`test/cited-lines-guard.citations.ts:87-102` — `CORTE_A_PATHS`, los 14 archivos vigilados:**

```
src/types/index.ts          ← 🔴 W0.1 LO EDITA
src/routes/agents.ts
src/services/agent.ts
src/services/agent.payment.test.ts
src/routes/agents.publish.test.ts
src/routes/agents.ownership.test.ts
src/lib/operator-address.ts
src/lib/payment-spec-writer.ts
src/lib/payment-spec-reader.ts
src/services/compose.ts     ← 🔴 W1.4 LO EDITA
src/services/fee-split.ts
test/payment-guards-live-in-one-place.test.ts
test/sdd-index-matches-folders.exceptions.ts
CLAUDE.md
```

**Consecuencia 1 — citas que APUNTAN a archivos que esta HU edita.** Si insertás una línea por
encima del ancla, la entrada se pone roja sola. Las cuatro que te afectan (medidas hoy):

| Entrada en `citations.ts` | `target` | `line` | `mustContain` | El literal vive en |
|---|---|---|---|---|
| `:210-226` | `src/types/index.ts` | **203-225** | `'EL NOMBRE MIENTE'` | `src/types/index.ts:288` (`` `:203-225` ``) |
| `:255-268` | `src/services/compose.ts` | **571** | `'if (i > 0 &&'`, `'scopingKeyRow'` | `src/types/index.ts:1450` (`src/services/compose.ts:571`) |
| `:283-291` | `src/routes/compose.ts` | **63-77** | `'function deriveComposeDestination(resolved'` | `src/services/compose.ts:575` |
| `:308-321` | `src/services/compose.ts` | **571** | `'if (i > 0 &&'`, `'scopingKeyRow'` | `src/services/compose.ts:688` (`` guard `i > 0` de :571 ``) |
| `:322-330` | `src/types/index.ts` | **217-218** | `'cambio de contrato con costo para terceros'` | `src/services/compose.ts:1548` |

⇒ **REGLA OPERATIVA, obligatoria:**
- ⛔ **NO insertes ninguna línea por encima de `src/types/index.ts:225`.** `ComposeSuspension`,
  `ResumeCaller`, `SuspendedRunRow`, `SuspendedRunClaim` van **abajo** (`ComposeResult` está en
  `:1180`, muy después: sin problema). Si necesitás un `import` nuevo arriba de todo, tenés que
  correr `line:`/`endLine:` de **dos** entradas *y* el texto `` `:203-225` `` en `:288` y
  `types/index.ts:217-218` en `compose.ts:1548`.
- ⛔ **NO insertes ninguna línea por encima de `src/services/compose.ts:571`** — incluido **un
  `import` al principio del archivo**. Si lo hacés, tenés que actualizar, en el mismo commit:
  (a) `line: 571` en **dos** entradas de `citations.ts`; (b) el literal
  `src/services/compose.ts:571` en `src/types/index.ts:1450`; (c) el literal `:571` en
  `src/services/compose.ts:688`. Es exactamente el modo de falla
  *"las citas que rompés vos al arreglar otra cosa"*.
- ⛔ **NO insertes líneas por encima de `src/routes/compose.ts:77`** (mismo razonamiento, la entrada
  apunta a `deriveComposeDestination`).

**Consecuencia 2 — citas NUEVAS que ESCRIBAS.** Toda cita `archivo:línea` que escribas en un
docblock de `src/types/index.ts` o `src/services/compose.ts` **exige una entrada escrita a mano** en
`test/cited-lines-guard.citations.ts` (`from`, `cite`, `target`, `line`, `mustContain`,
`symbolPath`), o el guardián da `E-UNDECLARED`. El universo se **deriva** en cada corrida; lo único
a mano es la afirmación.
⇒ **Consejo práctico**: en `src/types/index.ts` y `src/services/compose.ts`, escribí los docblocks
nuevos **sin** `archivo:línea` (nombrá el símbolo: *"el guard `i > 0` de `executePipeline`"*). En
los archivos NUEVOS (`resume-token.ts`, `suspended-run.ts`, `routes/compose.ts`) las citas son
libres: **no están en `CORTE_A_PATHS`**.

---

## 1. Qué se construye, en cinco líneas

Un paso del pipeline de `/compose` puede **suspenderse**: devolver un artefacto opaco del agente
(típicamente una URL a la que va una persona) y quedar esperando, con estado **durable** en una tabla
nueva de **bdwv**, en vez de tener que terminar dentro del mismo request HTTP. Después el caller
vuelve con un token firmado a `POST /compose/resume` y el pipeline **continúa desde el step
siguiente**, sin re-invocar ni re-debitar nada de lo ya hecho.

**Por qué existe** (arquitectura del founder, no mejora técnica): hoy Chaski le habla **directo** al
agente de identidad salteándose al Coordinador, porque ese agente publica `kyc-hosted-redirect` y el
modelo pedido-respuesta de `/compose` no lo expresa ⇒ **ese agente se consume GRATIS, fuera del
carril de pago**.

⛔ **PROHIBIDO escribir que "esto ya funciona porque el pipeline existe".** Existe todo **menos** el
estado suspendido. Ese estado es el trabajo.
⛔ **El corte A no hace verdadera la frase del pitch por sí solo.** Entrega la capacidad; la frase la
hace verdadera el corte B, que **no se diseña ni se toca acá**.

---

## 2. Scope IN — lista exhaustiva de archivos

**24 archivos.** Nada fuera de esta lista.

| # | Archivo | Nuevo | Wave |
|---|---|---|---|
| 1 | `src/types/index.ts` | — | W0 |
| 2 | `src/lib/resume-token.ts` | ✅ | W0 |
| 3 | `src/lib/resume-token.test.ts` | ✅ | W0 |
| 4 | `supabase/migrations/20260823000000_wkh225_suspended_runs.sql` | ✅ | W0 |
| 5 | `supabase/migrations/20260823000000_wkh225_suspended_runs_down.sql` | ✅ | W0 |
| 6 | `src/types/database.types.ts` | — | W0 |
| 7 | `test/wkh225-suspended-runs.migration.test.ts` | ✅ | W0 |
| 8 | `src/lib/capability-risk.ts` | — | W0 |
| 9 | `src/lib/capability-risk.test.ts` | — | W0 |
| 10 | `.env.example` | — | W0 |
| 11 | `src/services/suspended-run.ts` | ✅ | W1 |
| 12 | `src/services/suspended-run.test.ts` | ✅ | W1 |
| 13 | `src/services/suspended-run.ownership.test.ts` | ✅ | W1 |
| 14 | `src/services/compose.ts` | — | W1 |
| 15 | `src/services/compose.suspend.test.ts` | ✅ | W1 |
| 16 | `test/ownership-filter-guard.exceptions.ts` | — | W1 |
| 17 | `src/routes/compose.ts` | — | W2 |
| 18 | `src/routes/compose.resume.test.ts` | ✅ | W2 |
| 19 | `src/services/reconciliation.ts` | — | W2 |
| 20 | `src/services/reconciliation.test.ts` | — | W2 |
| 21 | `README.md` | — | W2 |
| 22 | `README.es.md` | — | W2 |
| 23 | `doc/sdd/_INDEX.md` | — | W2 · ⚠️ **ver §Contradicciones: probablemente NO haya que tocarlo** |
| 24 | `test/cited-lines-guard.citations.ts` | — | **condicional** · sólo si desplazás una de las 5 anclas de §0.6 |

### ⛔ Scope OUT — cero diff, sin excepciones

- ⛔ **`src/services/orchestrate.ts`** — es el testigo `T-SUSP-CALLSITE`: la cadena `suspension:`
  **no puede aparecer** ahí. Si la agregás, el test falla y con razón.
- ⛔ **`chaski-v3`**, **`wasiai-remittance-agents`** — son el corte B. **Otro repo, otra HU.**
- ⛔ **`src/lib/compose-limits.ts`** — CD-11. Ni siquiera para arreglar su docblock rancio
  (`TD-225-02`).
- ⛔ **`scripts/verify-rls-enabled.mjs` / `test/verify-rls-enabled.test.ts`** — NO agregues
  `a2a_suspended_runs` a `RLS_TABLES`: rippleaería `toHaveLength(10)` (`:75`, `:85`). Es el
  precedente literal de `test/agent-links.migration.test.ts:8-10`.
- ⛔ **`src/lib/settle-withholding.ts`** — CD-12: `SETTLE_UNKNOWN_EVENT_TYPES` no gana miembros.
- ⛔ **`src/services/inbound-task.ts`**, **`src/services/agent-link.ts`**,
  **`src/services/verification.ts`**, **`mcp-servers/wasiai-x402/**`**, **`src/mcp/tools/orchestrate.ts`**,
  **`scripts/*.mjs`** — son los otros consumidores del desenlace (MI-5). Quedan inalcanzables **por
  construcción** (DT-A2). Si alguno necesita un diff, **parás y avisás**: significa que DT-A2 se rompió.
- ⛔ **Redis / cola / worker / sweeper.** Sin sweeper, un run abandonado no emite residuo hasta que
  alguien intente reanudarlo. Está aceptado como `TD-225-01` (NC-3). **No lo construyas.**
- ⛔ **Mainnet, plata real, migración a `caldz`.**

---

## 3. Anti-Hallucination Checklist — específico de esta HU

Antes de escribir cada archivo, tildá:

- [ ] **Leí `.nexus/project-context.md` desde `/home/ferdev/.openclaw/workspace/wasiai-a2a/.nexus/project-context.md`** (no está en el worktree).
- [ ] **`grep` = `/usr/bin/grep`.** El hook `rtk` deforma la salida (mezcla nº de línea con contenido) y `git diff` bajo `rtk` **TRUNCA cortando hunks** — usá `/usr/bin/git`.
- [ ] **No agrego ninguna dependencia.** `node:crypto` es built-in; `@supabase/supabase-js` ya está. Verificado: `package-lock.json:829-830` → **2.101.1** instalada.
- [ ] **`supabase.rpc()` está tipado `FnName extends keyof Schema['Functions']`** (`node_modules/@supabase/supabase-js/dist/index.d.mts:512-517`, del checkout principal). ⇒ **`claim_suspended_run` y `settle_suspended_run` DEBEN declararse en `src/types/database.types.ts` bajo `Functions:` (bloque en `:2866`) o `tsc --noEmit` FALLA.** Precedentes: `claim_agent_link` `:2987`, `settle_agent_link` `:2999`.
- [ ] **La tabla entra sola al guardián de ownership** en cuanto `owner_ref` aparezca en su bloque `Row` de `database.types.ts` **con 10 espacios de indentación** (`test/ownership-filter-guard.scanner.ts:243-283`, `deriveTables`). Eso significa: **una cadena `select`/`update`/`delete` sin `.eq('owner_ref', …)` pone `npm test` en rojo en W1, no en W2.** Es la mitigación, no un rojo misterioso.
- [ ] **El guardián de ownership verifica PRESENCIA, no VALOR, y no ve los `supabase.rpc(...)`.** ⇒ **las dos RPC quedan enteras fuera del guardián**. Por eso `T-OWN-*` y el `IS DISTINCT FROM` dentro del SQL **no son redundantes**: son la única cobertura de ese hueco.
- [ ] **`errorCode` es una unión CERRADA de 5 miembros** (`src/types/index.ts:1207-1212`, verificado byte a byte hoy: `SCOPE_DENIED`, `DEST_CAP_EXCEEDED`, `INPUT_MAPPING_FAILED`, `CONTRACTING_LOOP_DETECTED`, `CONTRACTING_DEPTH_EXCEEDED`). **NO gana miembros.** El fallo de persistencia sale como `success:false` **sin `errorCode`** ⇒ cae en el `default → 400` de `src/routes/compose.ts:1112` (`let status = 400`). Precedente escrito: el guard de presupuesto de `compose.ts` tampoco agrega `errorCode` y dice por qué.
- [ ] **`ComposeResult` sale por HTTP SIN schema de respuesta** (`src/routes/compose.ts:1127-1128` y `:1270-1276` hacen `reply.send({ ...result, … })`) y **lo leen consumidores fuera de este repo** (`src/types/index.ts:1290-1291`). ⇒ el cambio es **estrictamente aditivo**: `success` sigue siendo `boolean`.
- [ ] **Antes de citar cualquier `archivo:línea`, abrí el archivo.** El propio SDD midió 3 citas mal de ~60 propias (5 %), escritas por roles dedicados. Y en `src/types/index.ts` / `src/services/compose.ts` **la cita nueva además exige entrada en `cited-lines-guard.citations.ts`** (§0.6).
- [ ] **Hay DOS `compose.ts`.** `src/routes/compose.ts` (1282 líneas, HTTP) y `src/services/compose.ts` (1804 líneas, el bucle). Es el caso que `E-WRONG_FILE` existe para explicar (`citations.ts:255-262`). Escribí siempre la ruta completa.
- [ ] **`git add` ANTES de derivar los números del README** (`git ls-files` sólo ve trackeado).

---

# WAVE 0 — SERIAL · Contratos, tipos, migración, LEAF

> **Cero comportamiento nuevo.** Los tipos son opcionales, la migración es aditiva, el LEAF no lo
> importa nadie todavía, la bandera está OFF. Nada de W0 cambia una decisión en runtime.
>
> **Presupuesto W0: ≈ 1334 líneas.**

### CDs que aplican a W0 — citados textualmente

> **CD-5** — ⛔ **PROHIBIDO migrar a `caldz`.** Toda migración a **bdwv**, con su `_down.sql`.

> **CD-13** — **OBLIGATORIO** que el módulo de firma sea **LEAF** (sólo `node:crypto`), por el
> motivo escrito en `orchestrate-quote.ts:26-27` y `compose-limits.ts:3-9`: media docena de suites
> mockean los módulos gordos del money-path completos y un export traído de ahí llega `undefined`.

> **CD-3** — ⛔ **PROHIBIDO un anti-replay en memoria del proceso.** Textual de
> `orchestrate-quote.ts:23-24`.

> **CD-5 (WKH-303, vía DT-5)** — Secreto HMAC propio, **sin fallback a ningún otro**. Fail-closed si
> está ausente.

> **CD-6** — **OBLIGATORIO** bandera nueva con comparación `=== 'true'` estricta y **default OFF**.

> **CD-8** — ⛔ **PROHIBIDO que el identificador de reanudación viaje en query string, en una URL,
> en un log o en un mensaje de error.**

> **CD-11** — ⛔ **PROHIBIDO subir `MAX_COMPOSE_STEPS`** en esta HU.

> **CD-19** — ✅ **OBLIGATORIO** que `expires_at` lo escriba **Postgres** (trigger), nunca Node.
> ⛔ **PROHIBIDO** replicar `agent-link.ts:195`.

> **CD-15** — ✅ **OBLIGATORIO**: si el run llevaba `frozenStepPricesUsd`, `expires_at` se acota
> además por el `exp` del quote que los congeló (`LEAST` en Postgres). ⛔ **PROHIBIDO** que un
> pipeline reanudado debite un precio congelado cuya garantía venció.

---

## W0.1 · `src/types/index.ts` — **+95 líneas**

⚠️ **Ver §0.6.** Escribí todo **por debajo de la línea 225**. Sin citas `archivo:línea` nuevas.

**Qué agregar** (aditivo, nada se borra, nada se renombra):

```ts
export interface ComposeSuspension {
  /** `id` de la fila de `a2a_suspended_runs`. NO es el token. */
  runId: string;
  /** Índice del step que suspendió. */
  step: number;
  /** DT-8/CD-21: lo que devolvió el agente, TAL CUAL. El gateway no lo interpreta. */
  artifact: unknown;
  /** ISO-8601. Lo escribió POSTGRES (CD-19), no este proceso. */
  expiresAt: string;
  /** Vocabulario del estándar A2A. Constante, para el cliente. */
  state: 'input-required';
}
```

- `ComposeResult.suspended?: ComposeSuspension` — **campo opcional nuevo**.
  ⛔ `success: boolean` **SIN CAMBIOS** (`:1181`). ⛔ `errorCode` **SIN CAMBIOS** (`:1207-1212`).
- `ComposeRequest.suspension?: { caller: ResumeCaller; ownerRef: string; keyId: string; ttlSeconds?: number; frozenPricesExpireAtMs?: number }`
  con el docblock: *"⛔ LO CONSTRUYE UN SOLO ARCHIVO: `src/routes/compose.ts`. Clavado por T-SUSP-CALLSITE."*
- `ResumeCaller` — espejo de `QuoteCaller`: `{ kind: 'key' | 'session' | 'delegation'; id: string }`.
- `SuspendedRunRow`, `SuspendedRunClaim`.

**Exemplar verificado**: `src/types/index.ts:1610-1627` (`AgentLinkRow`) y `:1671-1679`
(`AgentLinkClaim`, docblock: *"Fila del link devuelta por el RPC `claim_agent_link` (open→redeeming)"*).

**Vocabulario `'input-required'` — verificado**: `src/types/index.ts:2024-2028`, el array
`TASK_STATES` contiene `'input-required'` en `:2027`. Es el estado human-in-the-loop del estándar
A2A. ⚠️ El nombre del **estado interno de la fila** es `'suspended'`, y son cosas distintas **a
propósito**: uno es protocolo, el otro es la máquina de estados de una tabla nuestra.

**AC**: base de AC-1, AC-2. **Tests**: `T-SUSP-NOERRCODE` (la unión sigue teniendo exactamente 5
miembros), `T-SUSP-IMPOSSIBLE` (no existe camino que devuelva `{success:false, suspended:<presente>}`).

---

## W0.2 · `src/lib/resume-token.ts` — ✅ NUEVO — **+235 líneas**

**Exemplar verificado: `src/services/orchestrate-quote.ts` (406 líneas).**

| Qué se copia | Línea verificada | Contenido real |
|---|---|---|
| Docblock LEAF | `:26-27` | el motivo de CD-13 |
| TTL sin override por env, a propósito | `:37-41` | `QUOTE_TTL_SECONDS = 600` |
| Skew | `:44` | `QUOTE_CLOCK_SKEW_SECONDS = 60` — *"Tolerancia de `iat` en el futuro, por deriva de reloj entre instancias"* |
| **Secreto sin fallback, fail-closed, nunca lanza** | **`:115-126`** | `export function quoteHmacKey(): string | null { const secret = process.env[QUOTE_ENV_VAR]; if (typeof secret !== 'string' \|\| secret.length === 0) return null; return secret; }` |
| **Precedencia del binding** | **`:128-152`** | `resolveQuoteCaller`: delegación → sesión → key → `null`. *"`null` = caller no bindeable (x402 / anónimo)"* |
| 🔴 **ORDEN LOAD-BEARING DE 7 PASOS** | **`:328-342`** | ver abajo, textual |
| `verifyQuote` | `:343-406` | NUNCA lanza: cualquier entrada malformada devuelve un código |

**El orden de 7 pasos, textual de `orchestrate-quote.ts:330-342` — copialo:**

```
 * ORDEN LOAD-BEARING (CD-8) — la firma se valida ANTES de leer el payload:
 *  1. forma y tamaño del token
 *  2. secreto presente (fail-closed: sin secreto no se acepta NINGÚN quote, y jamás se cae
 *     al camino de precio vivo teniendo un quote presente)
 *  3. estructura del token (3 partes, prefijo, firma hex de 64)
 *  4. HMAC sobre el string crudo + `timingSafeEqual`
 *  5. recién ahora: decodificar, parsear y validar la forma del payload
 *  6. vigencia (`exp`) y `iat` no-futuro
 *  7. binding al caller
 *
 * ⚠️ El `exp` viaja DENTRO del payload que estamos verificando: leerlo antes de validar el
 * HMAC sería confiar en un campo que el atacante controla. […] PROHIBIDO invertirlo.
```

**Lo que se DIVERGE del exemplar, a propósito:**

- 🔴 **Contexto de dominio distinto.** La firma se calcula sobre `` `resume|${version}.${encoded}` ``
  (prefijo propio + secreto propio `COMPOSE_RESUME_HMAC_KEY`), para que **un quote jamás verifique
  como resume ni al revés**.
- 🔴 **NO se copia el multi-redeem.** `orchestrate-quote.ts:13-24` acepta A PROPÓSITO que un quote se
  redima más de una vez *"porque cada redención ejecuta el pipeline de verdad y debita su propio
  importe"*. **Ese razonamiento NO se transfiere**: un resume redimido dos veces ejecuta **dos veces
  la cola del pipeline** de un caller que pagó una. El single-use vive en `claim_suspended_run`.
- ⚠️ **El `exp` del token NO es la autoridad.** Es un fast-fail (espejo de
  `src/services/agent-link.ts:317-326`, *"pre-claim fast-fail (cero DB write)"*). La autoridad es
  `expires_at` comparado con `NOW()` **dentro** de `claim_suspended_run`.

**Constantes:**
```
SUSPEND_MAX_TTL_SECONDS  = env SUSPEND_MAX_TTL_SECONDS ?? 86400   (fail-safe NaN/<=0 → 86400)
SUSPEND_MIN_TTL_SECONDS  = 181   (piso duro: TIMEOUT_COMPOSE_MS/1000 + 1)
RESUME_CLOCK_SKEW_SECONDS = 60
default cuando el caller no pide TTL = SUSPEND_MAX_TTL_SECONDS
```
De dónde salen (MEDIDO, no elegido): el piso `>180 s` de `TIMEOUT_COMPOSE_MS` default `180000`
(`src/routes/compose.ts:913-915`) — por debajo del 504 del propio `/compose` la suspensión no compra
nada. El techo `86400` de **dos sitios independientes** con el mismo número, los dos para *"una
credencial con la que una persona vuelve"*: `agent-link.ts:143-146` (`LINK_MAX_TTL_SECONDS ?? 86400`)
y `key-session.ts:72` (`SESSION_MAX_TTL_SECONDS ?? 86400`). La forma *default = máximo* de
`agent-link.ts:180` (`let ttl = maxTtlSeconds();`).

**Formato**: `v1.<base64url(payload)>.<hmac hex64>`; payload `{v:1, bind, rid, iat, exp}`.

**AC**: AC-4. **Tests** en W0.3.

---

## W0.3 · `src/lib/resume-token.test.ts` — ✅ NUEVO — **+330 líneas**

| Test | Qué prueba | Cómo puede fallar por la razón equivocada |
|---|---|---|
| `T-TOK-1` | firma inválida ⇒ `RESUME_INVALID` | — |
| `T-TOK-2` | 🔴 firma inválida ⇒ **CERO llamadas a `supabase`** | **Sin esto sólo se prueba el código de error, no el ORDEN — y el orden ES el AC-4** |
| `T-TOK-3` | `iat` futuro > skew ⇒ inválido | — |
| `T-TOK-4` | 🔴 **token de QUOTE presentado como resume ⇒ inválido** (y al revés) | Si compartieran prefijo o secreto, este test es el único que lo caza |
| `T-TOK-5` | secreto ausente ⇒ inválido (fail-closed), **nunca lanza** | — |
| `T-TOK-6` | token > 8 KB ⇒ inválido **antes de decodificar** | — |
| `T-TOK-7` | `exp` vencido ⇒ inválido | — |
| `T-TOK-8` | binding a otro caller ⇒ inválido | Probá los 3 `kind` (`key`/`session`/`delegation`), no sólo uno |
| **`T-TOK-LEAF`** | el módulo importa **sólo** `node:crypto` — **leyendo su propio fuente** con `readFileSync`. **CD-13** | ⚠️ No lo escribas como `expect(self.includes('node:crypto'))` sobre el archivo de test: eso **nunca puede fallar**. Leé `src/lib/resume-token.ts` y assert que **no hay otro `from '…'`** |

---

## W0.4 · `supabase/migrations/20260823000000_wkh225_suspended_runs.sql` — ✅ NUEVO — **+215 líneas**

**Exemplar central verificado: `supabase/migrations/20260706000000_wkh137_agent_links.sql` (184 líneas).**
Leelo entero antes de escribir una línea. Rangos verificados hoy:

| Qué | Línea | Contenido real |
|---|---|---|
| Tabla | `:19-38` | `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` · `token_hash TEXT NOT NULL UNIQUE  -- SHA-256(token); UNIQUE = btree O(1) (CD-12)` · `owner_ref TEXT NOT NULL  -- Ownership Guard (CD-2)` · `key_id UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE` |
| Índices | `:39-41` | `(key_id, owner_ref)`, `(owner_ref)`, `(status)` |
| **RLS deny-by-default** | `:43-45` | `ALTER TABLE a2a_agent_links ENABLE ROW LEVEL SECURITY;` — **SIN `CREATE POLICY`** |
| Trigger `updated_at` | `:47-50` | `DROP TRIGGER IF EXISTS …; CREATE TRIGGER … BEFORE UPDATE … EXECUTE FUNCTION trigger_set_updated_at();` |
| **`FOR UPDATE`** | `:87` | `FROM a2a_agent_links l WHERE l.token_hash = p_token_hash FOR UPDATE;` |
| `NOT FOUND` | `:88-90` | `RAISE EXCEPTION 'LINK_NOT_FOUND: %', p_token_hash;` |
| **Vencimiento contra `NOW()`** | `:92-95` | `IF v_status = 'open' AND NOW() >= v_expires THEN RAISE EXCEPTION 'LINK_EXPIRED'; END IF;` |
| **Hardening** | `:115-122` | `$$ LANGUAGE plpgsql SECURITY DEFINER;` · `ALTER FUNCTION … SET search_path = public, pg_temp;` · `REVOKE EXECUTE ON FUNCTION … FROM PUBLIC, anon, authenticated;` · `GRANT EXECUTE ON FUNCTION … TO service_role;` |
| **status-gate exactly-once** | `:157-160` | `IF v_status <> 'redeeming' THEN RETURN; END IF;` |
| `reopen` | `:166-169` | `ELSIF p_outcome = 'reopen' THEN … -- SOLO tras __quoteStale (cero débito garantizado…)` |
| Hardening del settle | `:178-184` | ídem, con la **firma exacta** de 6 args |

### Columnas de `a2a_suspended_runs` (SDD §DT-A3, íntegro)

| Columna | Por qué | AC |
|---|---|---|
| `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` | el `runId` opaco | AC-2 |
| `token_hash TEXT NOT NULL UNIQUE` | **Sólo el hash, nunca el token.** Espejo de `:21` | AC-4 |
| `owner_ref TEXT NOT NULL` | Ownership Guard app-layer (CD-4) | AC-6 |
| `key_id UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE` | espejo de `:23` | — |
| `caller_kind TEXT NOT NULL CHECK (caller_kind IN ('key','session','delegation'))` + `caller_id TEXT NOT NULL` | la credencial **EXACTA**. Precedencia = la de `resolveQuoteCaller` (`orchestrate-quote.ts:136-152`) | AC-2, AC-4 |
| `compose_run_id UUID NOT NULL` | correlación + **clave de idempotencia del fee** (CD-18) | AC-2 |
| `step_index INT NOT NULL CHECK (step_index >= 0)` | dónde retomar | AC-8 |
| `steps_json JSONB NOT NULL` | los `StepResult` **COMPLETOS**, no reducidos: `collectStrandedSteps` lee `downstreamTxHash`, `txHash`, `costUsdc`, `agent.slug`, `agent.registry`, `agent.payment.chain`. Sin ellos **AC-7 no se puede cumplir** | AC-2, AC-7, AC-8 |
| `last_output JSONB` | `lastOutput` (`compose.ts:370`) | AC-8 |
| `remaining_steps JSONB NOT NULL` | los `ResolvedComposeStep` que faltan | AC-8 |
| `frozen_step_prices JSONB` | precios congelados | AC-2 |
| `total_cost_usdc NUMERIC(20,8) NOT NULL` · `total_latency_ms INT NOT NULL` | agregados (`compose.ts:368-369`) | AC-8 |
| 🔴 `contracting_chain JSONB` · `contracting_depth INT NOT NULL DEFAULT 0` · `self_host_hint TEXT` | **CD-17**. Sin esto la HU abre un bypass | AC-12 |
| `chain_id INT` | débito per-step de los restantes | AC-8 |
| `status TEXT NOT NULL DEFAULT 'suspended' CHECK (status IN ('suspended','resuming','resumed','failed','expired'))` | espejo de `:27-28` **con un estado más**: `expired` es terminal y **distinguible** de `failed`, porque AC-7 exige emitir el residuo **sólo** en la transición a `expired` | AC-5, AC-7 |
| `ttl_seconds INT NOT NULL CHECK (ttl_seconds BETWEEN 181 AND 86400)` | CD-19 | — |
| `expires_at TIMESTAMPTZ NOT NULL` | **lo escribe el TRIGGER, no la app** | AC-7 |
| `resumed_at TIMESTAMPTZ` · `error_message TEXT` · `created_at TIMESTAMPTZ NOT NULL DEFAULT now()` · `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()` | espejo de `:29-36` | — |

**Índices**: `(owner_ref)`, `(status)`, `(key_id, owner_ref)`, `(expires_at)`.
**RLS**: `ENABLE ROW LEVEL SECURITY` **sin `CREATE POLICY`**.
**Trigger `updated_at`**: reusa `trigger_set_updated_at`.

### 🔴 Trigger de `expires_at` — CD-19, la divergencia deliberada del exemplar

```sql
NEW.expires_at := now() + make_interval(secs => NEW.ttl_seconds);
```

Y con CD-15, cuando el `open` recibe el instante de vencimiento del quote que congeló precios, se
toma el `LEAST` **en Postgres**.

**Por qué** (medición 4 de MI-3, §2 del SDD): en la **lectura** ambos lados del `NOW() >= v_expires`
salen del mismo reloj (Postgres) ⇒ un skew node↔DB no puede volver reanudable un run vencido. El
único punto donde el skew se cuela es la **escritura**: `src/services/agent-link.ts:195` hace
`new Date(Date.now() + ttl*1000)` — **el único sitio del exemplar sensible al reloj**, y el que
**NO se replica**. Magnitud de δ que el repo ya asume: `QUOTE_CLOCK_SKEW_SECONDS = 60`
(`orchestrate-quote.ts:44`).

### Las dos RPC (DT-A4)

**`claim_suspended_run(p_token_hash TEXT, p_owner_ref TEXT)` → `suspended → resuming`.**
Orden de guards **copiado del exemplar y load-bearing**:

1. `SELECT … FOR UPDATE` por `token_hash`; `NOT FOUND` ⇒ `RAISE 'RUN_NOT_FOUND'`;
2. 🔴 `IF v_owner IS DISTINCT FROM p_owner_ref THEN RAISE 'RUN_NOT_FOUND'` — **el MISMO literal que
   "no existe"**. AC-6 pide 404, no 403, y `src/types/index.ts:394` lo llama *"404 disclosure-safe"*.
   **Que el mensaje sea idéntico es lo que lo hace disclosure-safe de verdad**: si dijera
   `OWNERSHIP_MISMATCH`, el atacante aprendería que el run existe;
3. `IF v_status = 'suspended' AND NOW() >= v_expires THEN` marcar `expired` **en la misma
   transacción** y `RAISE 'RUN_EXPIRED'`. La transición y el raise **juntos** son lo que hace que
   AC-7 emita **exactamente un** evento: la fila sólo puede pasar `suspended→expired` una vez;
4. `IF v_status <> 'suspended' THEN RAISE 'RUN_ALREADY_USED'`;
5. `UPDATE … SET status='resuming'` y devolver la fila.

> ⚠️ **Divergencia del exemplar, declarada**: `claim_agent_link` toma **un solo** arg
> (`Args: { p_token_hash: string }`, `database.types.ts:2988`) y **no** filtra por owner en el claim.
> Acá **sí**, porque AC-6 lo exige. Es una mejora sobre el exemplar, no una copia de su forma.

**`settle_suspended_run(p_id UUID, p_owner_ref TEXT, p_outcome TEXT, p_error TEXT)`** — cierre
exactly-once con **status-gate** `IF v_status <> 'resuming' THEN RETURN;` (espejo literal de `:157-160`).
`p_outcome ∈ {'resumed','reopen','failed'}`.
⛔ **`reopen` SÓLO desde guards que corren ANTES de cualquier débito o invoke de los steps
restantes.** Todo lo que pase después es **terminal** (`failed`), nunca se reabre. Es la **misma**
decisión que WKH-137 (su CD-8), no una nueva.

**Hardening obligatorio en las DOS**, verbatim del exemplar (`:115-122`, `:178-184`):
`SECURITY DEFINER` · `SET search_path = public, pg_temp` · `REVOKE EXECUTE … FROM PUBLIC, anon,
authenticated` · `GRANT EXECUTE … TO service_role`.

---

## W0.5 · `…_wkh225_suspended_runs_down.sql` — ✅ NUEVO — **+22 líneas**

Convención `project-context.md:403`. Verificado que el repo tiene el patrón
(`20260406000000_a2a_agent_keys_down.sql`, etc.).
Contenido: `DROP FUNCTION` × 2 **con la firma exacta** + `DROP TRIGGER` + `DROP FUNCTION` del trigger
de `expires_at` + `DROP TABLE`.

---

## W0.6 · `src/types/database.types.ts` — **+110 líneas** — 🔴 SERIAL Y NO OPCIONAL

Sin esto **`npx tsc -p tsconfig.json --noEmit` FALLA** (§3, checklist) y **la tabla no entra al
guardián de ownership**.

1. `Tables.a2a_suspended_runs: { Row / Insert / Update / Relationships }`.
   **Exemplar verificado**: `a2a_agent_links` en `:489-…`. Las claves del `Row` van **alfabéticas**,
   y `owner_ref: string;` con **10 espacios** de indentación (es lo que `deriveTables` matchea,
   `test/ownership-filter-guard.scanner.ts:277`).
2. `Functions.claim_suspended_run` y `Functions.settle_suspended_run` dentro del bloque
   `Functions: {` de `:2866`.
   **Exemplar verificado**, `:2987-3009`:
   ```ts
   claim_agent_link: {
     Args: { p_token_hash: string };
     Returns: { id: string; owner_ref: string; key_id: string; … }[];
   };
   settle_agent_link: {
     Args: { p_id: string; p_owner_ref: string; p_outcome: string; p_tx_hash: string | null;
             p_cost: number | null; p_error: string | null };
     Returns: undefined;
   };
   ```

---

## W0.7 · `test/wkh225-suspended-runs.migration.test.ts` — ✅ NUEVO — **+245 líneas**

**Exemplar verificado: `test/agent-links.migration.test.ts` (75 líneas). Copiá el patrón entero:
100 % mock con `readFileSync` sobre el `.sql`, sin DB.**

Del docblock del exemplar (`:1-10`), **copiá también esta decisión**:

> *"NO se agrega `a2a_agent_links` al set canónico RLS_TABLES de `verify-rls-enabled.test.ts`
> (ripplearía el conteo `toHaveLength(10)`, fuera de scope)."*

Asserts (`T-MIG-*`), calcados de `:25-59`:

- RLS: `expect(sql).toMatch(/ALTER TABLE a2a_suspended_runs\s+ENABLE ROW LEVEL SECURITY;/)` +
  `expect(sql.toUpperCase()).not.toContain('CREATE POLICY')` +
  `expect(sql).not.toContain('FORCE ROW LEVEL SECURITY')`.
- CHECK de los **5** estados: `"CHECK (status IN ('suspended','resuming','resumed','failed','expired'))"`.
- `token_hash UNIQUE`: `toMatch(/token_hash\s+TEXT NOT NULL UNIQUE/)` **y**
  `not.toMatch(/CREATE INDEX .* ON a2a_suspended_runs \(token_hash\)/)`.
- `SECURITY DEFINER` × 2 · `FOR UPDATE;` × 2 (**con el `;`** — los comentarios mencionan
  "FOR UPDATE" sin punto y coma, es la trampa que el exemplar documenta en `:49-50`).
- `SET search_path = public, pg_temp` · `FROM PUBLIC, anon, authenticated` · `TO service_role`.
- `v_owner IS DISTINCT FROM p_owner_ref` (AC-6, **`T-RUN-2`**: la RPC levanta el **mismo** literal
  `RUN_NOT_FOUND` en "no existe" y en "otro dueño").
- `IF v_status <> 'resuming' THEN` (status-gate).
- El `_down.sql` dropea con la **firma exacta**.
- 🔴 **Testigo de CD-19**: `NOW()` aparece en el claim **y `Date.now` NO aparece en ningún lado del SQL**.

---

## W0.8 · `src/lib/capability-risk.ts` — **+16 líneas** — AC-10

**Verificado hoy** (`:89-99`): `NON_DISBURSEMENT_CAPABILITIES` tiene 9 entradas y **ninguna** es
`kyc-hosted-redirect` ni `legacy-single-shot-kyc` ⇒ `classifyCapabilities` (`:137-154`) devuelve
`'unclassified'` ⇒ `needsTightTrialQuota` (`:166-170`) da `true` ⇒ **cupo estrecho para
`remit-kyc-validator` el día que se republique la ficha**. AC-10 lo previene.

**El docblock `:70-88` EXIGE una fuente por entrada** y deja fuera lo que no se pudo verificar (el
precedente `cashout-match`, `:85-88`: *"Un «probablemente no» no entra a una lista cuyo efecto es
AFLOJAR un cupo del camino del dinero"*).

**La fuente medida para las dos, y va en el docblock:**
`wasiai-remittance-agents/src/manifest/registry.ts:76` (`kyc-hosted-redirect`) y `:77`
(`legacy-single-shot-kyc`), con el docblock `:71-75` que dice que son **aditivas** y declaran
*"POR QUE CAMINO se hace el trabajo"* (rol vs camino). Ninguna nombra un desembolso; el propio
`capability-risk.ts:78-80` ya dice del mismo agente: *"Autoriza o rechaza; no paga"*.

⚠️ **`src/lib/capability-risk.ts:81-82` cita `doc/sdd/_INDEX.md:144`.** No muevas esa cita ni la
línea 144 del índice (ver W2.7 y §Contradicciones). Verificado hoy: `_INDEX.md:144` es la fila `157`
y contiene `remit.corridor-discovery`, `cashout-match` y `kyc-check`.

---

## W0.9 · `src/lib/capability-risk.test.ts` — **+50 líneas**

| Test | Qué prueba |
|---|---|
| `T-CAP-1` | `classifyCapability('kyc-hosted-redirect') === 'no-disbursement'` |
| `T-CAP-2` | ídem `legacy-single-shot-kyc` |
| `T-CAP-3` | 🔴 `needsTightTrialQuota` de las **6 capacidades REALES** de `remit-kyc-validator` da `false`. Las 6 exactas salen de `wasiai-remittance-agents/src/manifest/registry.ts:66-78`. **Es lo que prueba DT-7**; sin él, AC-10 es una lista sin efecto medido |

---

## W0.10 · `.env.example` — **+16 líneas**

Tres variables nuevas, en una sección propia al final, con el patrón de las secciones existentes
(`# ── WKH-NNN: … ──`):

```
COMPOSE_SUSPEND_ENABLED=
COMPOSE_RESUME_HMAC_KEY=
SUSPEND_MAX_TTL_SECONDS=
```

⚠️ El contador es `^[A-Z][A-Z0-9_]*=` ⇒ **cada línea de variable suma 1** (los comentarios no).
⇒ +3, y el README se actualiza en W2.5 (**re-derivando**, no copiando).

**CD-6, textual**: bandera con comparación `=== 'true'` **estricta** y **default OFF**.
Exemplar del repo: `src/adapters/registry.ts:63` y `project-context.md:252-268`.
Con la bandera OFF, `src/routes/compose.ts` **no construye** `request.suspension` ⇒ por DT-A2
**nada se enciende**: cero filas, cero queries, cero claves nuevas.

---

## 🚪 Puerta de salida de W0

```bash
npx tsc -p tsconfig.json --noEmit   # limpio
npm run lint                        # limpio
npm test                            # VERDE, y sin cambios de comportamiento
```
Nadie importa el LEAF todavía. Si algo del comportamiento cambió en W0, algo está mal.

---

# WAVE 1 — Persistencia + el desenlace en el service

> **PARALELIZABLE en dos frentes que no comparten archivo:**
> **W1-a** = `src/services/suspended-run.ts` + sus 2 tests + la excepción del guardián.
> **W1-b** = `src/services/compose.ts` + `compose.suspend.test.ts`.
>
> **Presupuesto W1: ≈ 1474 líneas.**

### CDs que aplican a W1 — citados textualmente

> **CD-1** — ⛔ **PROHIBIDO que el estado del pipeline suspendido viva en Chaski.** Si el
> Coordinador orquesta, el estado es suyo; si no, volvemos al problema que esta HU cierra.

> **CD-2** — ⛔ **PROHIBIDO representar la suspensión como `success: false`.** Protege la alerta
> `strandedExposureBreached` de `/health`.

> **CD-4** — **OBLIGATORIO** que toda query/mutación sobre la tabla nueva cruce el `id` con
> `.eq('owner_ref', <owner del caller>)`. El cliente usa `SUPABASE_SERVICE_KEY` (BYPASSRLS): el
> guard real es app-layer.

> **CD-7** — ⛔ **PROHIBIDO tocar el guard `i > 0`** de `compose.ts:571`, ni su comentario CD-11.
> Es la única defensa contra el doble débito del step 0. **El AR debe verificar que sobrevive.**

> **CD-16** — ⛔ **PROHIBIDO** que el sobre de suspensión que devuelve el agente contenga una clave
> `error`, `success:false`, o `status ∈ {'failed','error'}`.

> **CD-17** — ✅ **OBLIGATORIO** persistir `contracting_chain`, `contracting_depth` y
> `self_host_hint`, y **restaurarlos** en la reanudación. ⛔ Reanudar con `depth: 0` es un bypass del
> guard anti-bucle de capa 1 abierto por esta HU.

> **CD-21** — ⛔ **PROHIBIDO** que el `artifact` del agente se reescriba, se le agreguen parámetros,
> se valide contra una allowlist propia, o se loguee. Se persiste y se devuelve **tal cual**.

> **CD-22** (auto-blindaje) — ✅ **OBLIGATORIO** que toda función nueva de `suspended-run.ts`
> devuelva una **unión discriminada**, nunca un `boolean` ni un `null` que colapse "el guard lo
> rechazó" / "la escritura falló" / "el store no está".

---

## W1.1 · `src/services/suspended-run.ts` — ✅ NUEVO — **+345 líneas**

Funciones: `open()` (insert), `claim()` (RPC), `settle()` (RPC), `expire()` (+ el residuo de AC-7),
`listForOwner()`.

**Exemplar de consumo TS del RPC: `src/services/agent-link.ts` (544 líneas).**

| Qué se toma | Línea verificada |
|---|---|
| `maxTtlSeconds()` con default 86400 | `:143-146` |
| **default = máximo** (`let ttl = maxTtlSeconds();`) | `:180` |
| pre-claim fast-fail Node-side, "cero DB write" | `:317-326` |
| llamada a `claim_agent_link` | `:494` |
| el razonamiento del `reopen` (sólo pre-débito) | `:410-434` |
| ⛔ **`:195` — el ÚNICO sitio sensible al reloj. NO se copia** (CD-19) | `:195` |

**Doctrina obligatoria — `src/adapters/solana/settle-ledger.ts:16-38`, las 3 reglas, textual:**

> 1. **ESCRITURA CONDICIONAL ATOMICA.** Nunca un `SELECT` que decide y un `INSERT`/`UPDATE` que
>    ejecuta: entre los dos entra otro proceso. […] Y el reloj del lease es el de **Postgres**, no
>    el de Node.
> 2. **FAIL-CLOSED.** Cliente caido, RPC que tira, error de Postgres, `data` vacio, forma
>    inesperada: todo eso es "no se", y **"no se" nunca autoriza una transferencia**.
> 3. **NINGUNA FUNCION DEVUELVE `boolean`.** Un `false` colapsa "el guard lo rechazo" / "la
>    escritura fallo" / "el store no esta", que tienen remedios DISTINTOS. Uniones discriminadas
>    siempre.

**CD-4 en la práctica**: toda cadena `select` / `update` / `delete` sobre `a2a_suspended_runs` lleva
`.eq('owner_ref', ownerId)`. Firma obligatoria: `ownerId: string`, **nunca `string | undefined`**.
⚠️ El guardián se pone rojo **en W1**, no en W2, apenas la tabla aparezca en `database.types.ts`.

**AC-7 se implementa acá (`expire()`), REUSANDO el LEAF, sin escribir aritmética nueva:**

```
collectStrandedSteps(steps_json)          // src/lib/stranded-payment.ts:172
   ├─ devuelve []      ⇒ NO se emite NADA   (`:177-181`: un step sin downstreamTxHash ni txHash no entra)
   └─ devuelve algo    ⇒ buildStrandedPaymentEvent({ composeRunId, strandedSteps,
                             failedStepIndex: steps_json.length, … })   // `:226`
                        ⇒ eventService.track(...) FIRE-AND-FORGET con `.catch`
                           (exemplar: src/services/compose.ts:277-295)
```

⛔ **CD-12** se honra solo: el `event_type` es el de siempre,
`COMPOSE_STRANDED_PAYMENT_EVENT = 'compose_stranded_payment'` (`stranded-payment.ts:44`), y su propio
docblock `:34-43` dice **textual**:

> ⛔ PROHIBIDO agregarlo a `SETTLE_UNKNOWN_EVENT_TYPES` (CD-8). Son dos preguntas distintas y
> mezclarlas corrompe la lista de HU-203.

---

## W1.2 · `src/services/suspended-run.test.ts` — ✅ NUEVO — **+390 líneas**

| Test | AC | Qué prueba |
|---|---|---|
| `T-RUN-1` | AC-5 | `claim()` sobre una fila `resuming` devuelve `already_used`. ⚠️ **Con un doble de supabase que APLICA el status-gate**, no uno que siempre dice OK |
| `T-RUN-2` | AC-6 | La RPC levanta el **mismo literal** en "no existe" y en "otro dueño" |
| `T-RUN-*` | CD-22 | Toda función devuelve unión discriminada; ninguna devuelve `boolean` ni `null` colapsante |

---

## W1.3 · `src/services/suspended-run.ownership.test.ts` — ✅ NUEVO — **+155 líneas**

**`T-OWN-*` — que el filtro AÍSLE, no que exista.** Un falso que **aplica los filtros pedidos** y
devuelve la fila de OTRO owner ⇒ el service tiene que **no encontrarla**.

> ⚠️ Esto **no es redundante** con el guardián: `test/ownership-filter-guard.test.ts` verifica
> **PRESENCIA, no VALOR** — un `.eq('owner_ref', otroOwner)` lo pasa sin chistar — y **no ve los
> `supabase.rpc(...)`**, o sea que **las dos RPC quedan enteras fuera del guardián**. `T-OWN-*` y el
> `IS DISTINCT FROM` del SQL son la **única** cobertura de ese hueco.

Exemplar: los `src/services/*.ownership.test.ts` que `CLAUDE.md` declara obligatorios.

---

## W1.4 · `src/services/compose.ts` — **+130 líneas** — 🔴 EL ARCHIVO MÁS DISPUTADO

⚠️ **Ver §0.6 antes de tocarlo.** Insertar una línea por encima de `:571` rompe **dos** entradas de
`cited-lines-guard.citations.ts` y **dos** literales de texto en otros archivos.

**El punto de inserción, verificado hoy** — el `try` del step está en `:698-732` y el `catch` en `:733`:

```ts
      try {                                                       // :698
        const { output, downstream, downstreamSkipCode, coordinatorFee } =
          await this.invokeAgent(                                 // :700
            agent, input, a2aKey, undefined,
            `${composeRunId}:${i}`,   // WKH-234 intentId (leg Solana, AC-7)   :704
            outboundContracting,      // WKH-360 (AC-7): la traza saliente     :705
          );
        recordSolanaLegIfAny(downstream);                          // :709
        const agg = await this.finishSuccessfulStep({ … });        // :712-728
        totalCost = agg.totalCost; totalLatency = agg.totalLatency; lastOutput = agg.lastOutput;
      } catch (err) {                                              // :733
```

**Los tres cambios:**

**(a)** Lector del sobre de suspensión sobre `output`, **DESPUÉS de `invokeAgent`** (o sea después
de `:707`), dentro del `try`. **Gateado por `request.suspension` presente** — si está ausente, el
sobre **no se mira siquiera** (AC-9).

> 🔴 **Por qué DESPUÉS de `invokeAgent` y no antes** (MI-3, medición 3): el settle del step que
> suspende **ya terminó** cuando se lee su respuesta. En `invokeAgent`, el `fetch` está en `:1738`,
> el parseo del body en `:1760` y `signAndSettleDownstream` recién en **`:1785`**. Cuando la
> suspensión se decide, el leg de ese step **ya cerró**, y los steps `i+1..N` usan `intentId`
> distintos (`` `${composeRunId}:${i}` ``, `:704`). ⇒ **no hay ninguna entrada de idempotencia que
> pueda expirar mientras el run está suspendido.**

**(b)** Rama de suspensión: `finishSuccessfulStep` **normal** (el step `i` SÍ completó y SÍ se pagó)
→ persistir vía `suspendedRunService.open(...)` → `return { success: true, suspended: {…}, steps: results, … }`.

🔴 **`success: true` — CD-2, y no es estilo.** Con `success:true`, `src/services/compose.ts:230`
(`if (!result.success) this.recordStrandedRunIfAny(composeRunId, result)`) es un **no-op** ⇒ **cero
eventos `compose_stranded_payment` y cero diff en esa línea. AC-1 sale gratis.**
Si fuera `success:false`, cada suspensión emitiría un evento que `src/services/stranded-alert.ts:229-259`
acumula en 60 min y publica en `/health` como `degradedPath` ⇒ **un KYC funcionando normal haría
sonar la alerta de plata varada**, que es el daño que ese mismo archivo declara combatir (`:288-290`:
*"un canal que grita siempre es un canal que se aprende a ignorar"*).

**(c)** Fail-closed si el insert falla ⇒ `{ success: false }` **SIN `errorCode`** (la unión no se
toca) ⇒ cae en el `default → 400` de `src/routes/compose.ts:1112`. `NC-1` del SDD lo acepta con el
precedente escrito del guard de presupuesto. **Un mensaje distinguible alcanza para el operador.**

**⛔ Lo que NO se toca en este archivo:**
- el guard `i > 0` de `:571` ni su comentario `:544-556` (**CD-7**);
- `:230` (`if (!result.success) recordStrandedRunIfAny`) — queda **byte-idéntica**;
- `:232-243` (el camino del throw) — la suspensión **no viaja por throw** (DT-A1). Convertirla en
  throw obligaría a poner un `try` alrededor de `src/services/orchestrate.ts:1359`, o sea meter
  `/orchestrate` —**Scope OUT**— dentro del diff.

**🔴 CD-16 — el discriminante del sobre.** `src/services/verification.ts:63-75` (`hasErrorSignal`)
dispara con **`o.error` truthy** (`:68`), con `o.success === false` (`:70`) y con
`o.status ∈ {'failed','error'}` (`:71-74`) — sobre **el output DEL AGENTE**. ⇒ el sobre de suspensión
**no puede llevar** ninguna de esas tres, o `verifyStepOutput` marcaría el step como incompleto. El
discriminante es **una clave propia**, y su ausencia es el 100 % del tráfico de hoy.

---

## W1.5 · `src/services/compose.suspend.test.ts` — ✅ NUEVO — **+430 líneas**

| Test | AC | Qué prueba | 🔴 Cómo puede pasar POR LA RAZÓN EQUIVOCADA |
|---|---|---|---|
| `T-SUSP-1` | AC-1 | la suspensión devuelve `success !== false` | — |
| `T-SUSP-2` | AC-1 | **espía `eventService.track` y exige CERO llamadas con `event_type === 'compose_stranded_payment'`** | 🔴 **El fixture positivo TIENE que llevar un `downstreamTxHash` real en el step anterior.** Sin él, `collectStrandedSteps` devuelve `[]` y el test pasa **aunque el bug exista**. Es *"el test del camino feliz ejercitaba el agujero"* |
| `T-SUSP-3` | AC-2 | la fila persiste **los 8 campos** que AC-2 enumera | **Assert campo por campo, NO `toMatchObject` parcial** |
| `T-SUSP-4` | AC-2 | la respuesta trae `artifact` + `runId` + `expiresAt` | — |
| `T-SUSP-5` | AC-3 | con 3 steps y suspensión en el 1: `budgetService.debit` **no** se llama para el step 2, `invokeAgent` **no** se llama para el step 2, `signAndSettleDownstream` **no** se llama, `credit*` **no** se llama | **Cuatro espías, cuatro `not.toHaveBeenCalled()`** |
| `T-SUSP-6` | AC-9 | con `COMPOSE_SUSPEND_ENABLED` **ausente / `''` / `'TRUE'` / `'1'` / `'yes'`** ⇒ cero inserts, cero RPC, y **las claves del `ComposeResult` son exactamente las de hoy** (`Object.keys` contra snapshot de la rama base) | **La comparación de claves es lo que hace falsable "cero claves nuevas"**. Sin ella, AC-9 no se prueba |
| **`T-SUSP-CALLSITE`** | DT-A2 | `src/services/orchestrate.ts` **no contiene** la cadena `suspension:` ⇒ Scope OUT **estructural** | ⚠️ Leé `src/services/orchestrate.ts` con `readFileSync`, no el archivo de test. Un `expect(self.includes(…))` **nunca puede fallar**. Exemplar del patrón: `T-COTA-03`, descrito en `src/lib/stranded-payment.ts:70-74`, y `test/payment-guards-live-in-one-place.test.ts` |
| **`T-SUSP-GUARD571`** | CD-7 | el texto exacto `if (i > 0 && scopingKeyRow && chainId !== undefined) {` **sobrevive** en `src/services/compose.ts` | ⚠️ **Ancla por CONTENIDO, no por número de línea.** Esta HU inserta líneas y el 571 se mueve |
| **`T-SUSP-NOERRCODE`** | contrato | la unión `ComposeResult.errorCode` sigue teniendo **exactamente 5** miembros | — |
| **`T-SUSP-IMPOSSIBLE`** | DT-A1 | no existe ningún camino que devuelva `{success:false, suspended:<presente>}` | El estado `{success:true, suspended:true}` **no es un estado imposible mal modelado: ES el estado suspendido**. El imposible es el otro |

---

## W1.6 · `test/ownership-filter-guard.exceptions.ts` — **+24 líneas**

La entrada del sitio **cross-tenant admin** de W2.3 (`listSuspendedRuns`), escrita **a mano leyendo
el código**.

> ⛔ **Textual del docblock del archivo (`:5-11`)**: *"ESTA LISTA NO SE GENERA VOLCANDO LA SALIDA DEL
> ESCÁNER. Está escrita a mano, entrada por entrada, leyendo el sitio. […] un artefacto derivado de
> la misma medición que consume deja el control verde **por construcción** y no mide nada."*

**Forma exacta** (`OwnershipFilterException`, `:60-70`):

```ts
{
  file: 'src/services/reconciliation.ts',
  line: <la línea EXACTA del `.from(`>,       // ← la convención del censo
  table: 'a2a_suspended_runs',
  verb: 'select',
  category: 'admin-cross-tenant',             // ← categoría YA existente, verificada
  reason: '…',                                // ← nunca vacío (G-10)
}
```

El motivo: es superficie **admin gateada por `requireAdminToken`**, mismo patrón que
`listSettleUnknown` (`src/services/reconciliation.ts:722-724`, textual: *"Cross-tenant DELIBERADO
(mismo patrón que `listPending`/`listAmbiguous`): superficie de ALTO PRIVILEGIO gateada por
`requireAdminToken` en la ruta."*).

⚠️ **Dependencia de orden**: el `line:` tiene que ser el número **final**, después de que
`reconciliation.ts` quede escrito (W2.3). Escribí la entrada en W1 y **ajustá el número al cerrar W2**.

---

## 🚪 Puerta de salida de W1

- Bandera **OFF** ⇒ suite verde **y byte-idéntica** en comportamiento.
- Bandera **ON** en test ⇒ la suspensión persiste y devuelve el sobre; **`compose.ts:230` no emite
  residuo** (AC-1 **medido**, no argumentado).
- Los tres comandos del gate, en orden.

---

# WAVE 2 — Ruta, reanudación, reconciliación, y los números de los README

> **DEPENDE DE W1.** · **Presupuesto W2: ≈ 872 líneas.**

### CDs que aplican a W2 — citados textualmente

> **CD-8** — ⛔ **PROHIBIDO que el identificador de reanudación viaje en query string, en una URL,
> en un log o en un mensaje de error.** Mismo criterio que `agent-kyc-client.ts:150-153`.

> **CD-12** — ⛔ **PROHIBIDO agregar `compose_suspended` (o como se llame) a
> `SETTLE_UNKNOWN_EVENT_TYPES`.**

> **CD-18** — ⛔ **PROHIBIDO** cobrar el fee de protocolo en la respuesta 202. Se cobra **una vez**,
> al completar, sobre el total acumulado, con `compose_run_id` como clave de idempotencia.

> **CD-20** — ✅ **OBLIGATORIO** actualizar los tres números derivados de **los dos** README en el
> **mismo commit**. ⛔ **PROHIBIDO copiar los números de este SDD**: re-derivarlos.

> **CD-14** — **OBLIGATORIO** que el `_INDEX.md` reciba la fila de esta HU **antes** del primer
> commit que trackee la carpeta.

---

## W2.1 · `src/routes/compose.ts` — **+195 líneas**

⚠️ **No insertes líneas por encima de `:77`** (§0.6, la entrada que apunta a `deriveComposeDestination`).

**(a)** Construir `request.suspension` **sólo si** la bandera `COMPOSE_SUSPEND_ENABLED === 'true'`
**y** el caller es **bindeable**.
🔴 **R-2, fail-closed**: `resolveQuoteCaller` devuelve `null` para un caller x402 puro / anónimo
(`orchestrate-quote.ts:151`). Con `null` **no se construye `request.suspension`** ⇒ ese pipeline
**nunca suspende** y se comporta exactamente como hoy.

**(b)** La rama nueva, **en este orden exacto** dentro del handler:

```
:1087  if (reply.sent) { await refundComposeStep0(request, result.totalCostUsdc); return; }   ← YA EXISTE, queda arriba
       ────────────────────────────────────────────────────────────────────────────────────
       🆕 if (result.suspended) { … return reply.status(202).send({ suspended, requestId }); }
       ────────────────────────────────────────────────────────────────────────────────────
:1092  if (!result.success) { … refund step-0 … 400/402/403 }                                  ← YA EXISTE, queda abajo
:1167  try { … chargeProtocolFee({ orchestrationId: request.id, feeBaseUsdc: … }) … }          ← YA EXISTE, queda abajo
```

⇒ Un suspendido **no llega** al refund del step-0 (no falló) **ni al cobro del fee** (**CD-18**).

**(c)** `POST /compose/resume` — la ruta nueva. **Misma cadena de preHandlers que `/compose`, MENOS
el de precio del step-0.**
🔴 **CD-8**: el token va en el **BODY del POST**. **Se DIVERGE a propósito del exemplar**
`src/routes/agent-links.ts:164`, que lo toma del **path** (`req.params.token`) — un token en el path
queda en el access log del hosting. **Logs value-free**: sólo `runId`, `err.name` y el status. ⛔
Nunca el token, nunca el `artifact`.

**(d)** Mapeo HTTP — **exemplar verificado `src/routes/agent-links.ts:173-196`**:

```ts
if (err instanceof AgentLinkNotFoundError)   return reply.status(404).send({ error_code: 'LINK_NOT_FOUND' });      // :174-175
if (err instanceof AgentLinkExpiredError)    return reply.status(410).send({ error_code: 'LINK_EXPIRED' });        // :177-178
if (err instanceof AgentLinkAlreadyUsedError)return reply.status(409).send({ error_code: 'LINK_ALREADY_USED' });   // :180-181
if (err instanceof AgentLinkExecutionUnavailableError)
                                             return reply.status(503).send({ error_code: 'LINK_EXECUTION_UNAVAILABLE' }); // :192-196
```

Traducción para esta HU: `RESUME_INVALID` → **400** · `RUN_NOT_FOUND` → **404** (AC-6: y el body es
**byte-idéntico** al de un run inexistente) · `RUN_ALREADY_USED` → **409** · `RUN_EXPIRED` → **410**
· indisponible → **503**. Forma del body: `{ error_code: '…' }` (snake, como el exemplar).

**🔴 El cobro del fee en el camino de resume**: al **completar**, sobre el `totalCostUsdc`
**acumulado** (pre-suspensión + posteriores), con **`compose_run_id` de la fila** como clave de
idempotencia — **nunca `request.id`**, que es distinto en el resume. Es el único identificador
estable a través de la suspensión, y es el mismo que ya correlaciona el evento de residuo
(`src/lib/stranded-payment.ts:226-232`).

---

## W2.2 · `src/routes/compose.resume.test.ts` — ✅ NUEVO — **+440 líneas**

| Test | AC | Qué prueba | 🔴 Cómo puede pasar por la razón equivocada |
|---|---|---|---|
| `T-RES-1` | AC-5 | dos resumes con el mismo token ⇒ el 2º da `RESUME_ALREADY_USED` | **Doble de supabase que APLICA el status-gate**, no uno que siempre dice OK |
| `T-RES-2` | AC-5 | en el 2º: `debit` / `invokeAgent` / `settle` **no** se llaman | — |
| `T-RES-3` | AC-6 | resume con `owner_ref` distinto ⇒ **404**, y el body es **idéntico byte a byte** al de un `runId` inexistente | **Si los mensajes difieren, el 404 no es disclosure-safe.** Comparar el body entero, no el status |
| `T-RES-4` | AC-7 | run vencido ⇒ `RESUME_EXPIRED` + status `expired` | — |
| `T-RES-5` | AC-7 | con evidencia on-chain ⇒ **exactamente 1** `compose_stranded_payment` | — |
| `T-RES-6` | AC-7 | **sin** evidencia ⇒ **0** | — |
| `T-RES-7` | AC-7 | **dos intentos sobre el vencido ⇒ SIGUE SIENDO 1** | 🔴 **Es el que prueba el status-gate. Sin él, "exactamente uno" es una afirmación sin testigo** |
| `T-RES-8` | AC-8 | reanudación válida ⇒ ejecuta **sólo** los steps restantes; `invokeAgent` recibe **sólo** los agentes de `remaining_steps`; `result.steps` **incluye** los completados antes | **Comparar el array de `steps` COMPLETO, no su `.length`** |
| `T-RES-9` | AC-8 | `debit` no se llama para ningún step ≤ i | — |
| `T-RES-10` | AC-12 | reanudación con un agente cuyo `invokeUrl` es propio ⇒ `CONTRACTING_LOOP_DETECTED` | — |
| `T-RES-11` | AC-12 / CD-17 | la profundidad persistida se **restaura**: `depth` entrante 4 ⇒ el guard corta; `depth` 0 ⇒ no | 🔴 **Sin él, la persistencia de `contracting_depth` es código que nadie mira** |
| `T-TOK-*` (parte HTTP) | AC-4 | firma inválida ⇒ `RESUME_INVALID` **y CERO llamadas a `supabase`** | El orden ES el AC |

> **AC-12 sale casi gratis (DT-A8)**: la reanudación re-entra a `executePipeline` con los steps
> restantes ⇒ SITIO 3 (`compose.ts:444`) y SITIO 4 corren de nuevo sobre ellos y `selfIdentity` se
> re-resuelve. **Cero código nuevo.** Lo que **no** es gratis son los tres campos de CD-17.
> Y el razonamiento del propio código (`compose.ts:434-437`: *"el catálogo puede cambiar entre el
> preflight y la ejecución"*) es **MÁS** cierto tras horas de espera, no menos.

> ⛔ **R-1, y el corte A lo cierra**: el `resume` **sólo lleva el token**. ⛔ **PROHIBIDO** aceptar el
> veredicto del KYC en el body del resume: sería un veredicto de KYC **forjable por el cliente**.

---

## W2.3 · `src/services/reconciliation.ts` — **+100 líneas** — AC-11

`listSuspendedRuns()` consulta **`a2a_suspended_runs`** (⛔ **no** `a2a_events`) y se suma como
**cuarta clave** de `AmbiguousReport`.

**Exemplar verificado** (`src/services/reconciliation.ts`):

| Qué | Línea | Contenido real |
|---|---|---|
| shape de `AmbiguousReport` | `:317-…` | `rows` · `total` · `truncated` · `settleUnknown` · `strandedRuns` |
| ensamblado **SECUENCIAL a propósito, sin `Promise.all`** | `:670-684` | *"con las dos promesas en vuelo, un fallo de la primera deja la segunda como unhandled rejection"* |
| las **3 invariantes innegociables** | `:713-721` | ver abajo |
| **cross-tenant DELIBERADO** | `:722-724` | *"superficie de ALTO PRIVILEGIO gateada por `requireAdminToken` en la ruta"* |
| `::text` obligatorio (WKH-196) | `:783-784` | *"PostgREST entrega los NUMERIC como número JSON y `JSON.parse` redondea"* |
| `listStrandedRuns` | `:788+` | — |

**Las 3 invariantes, textual de `:713-721` — se heredan sin negociar:**

> 1. NO gateada por `isEscrowSettleEnabled()` […];
> 2. `total` exacto + `truncated` — una lista de plata retenida que se corta en silencio afirma algo
>    falso sobre su propia completitud;
> 3. un error de query **TIRA** en vez de devolver `[]` — una lista vacía por fallo mentiría "no hay
>    nada retenido", que es la peor respuesta posible acá.

⚠️ `total_cost_usdc` se selecciona como **`total_cost_usdc::text`** (WKH-196).
⚠️ Este es el sitio **sin `.eq('owner_ref', …)`** ⇒ necesita su entrada en W1.6.

---

## W2.4 · `src/services/reconciliation.test.ts` — **+120 líneas**

| Test | Qué prueba |
|---|---|
| `T-REC-1` | `listAmbiguous()` trae la **4ª clave** |
| `T-REC-2` | un run suspendido **no** aparece en `listSettleUnknown` ni en `listStrandedRuns` |
| `T-REC-3` | 🔴 **`SETTLE_UNKNOWN_EVENT_TYPES` sigue teniendo exactamente los mismos miembros que hoy** — **es el testigo mecánico de CD-12** |

---

## W2.5 · `README.md` — **+8** · W2.6 · `README.es.md` — **+8**

**Ver §0.2 completo.** Los seis sitios exactos, verificados hoy:

| Número | `README.md` | `README.es.md` | Valor de hoy |
|---|---|---|---|
| variables `.env.example` | `:351` | `:385` | **186** |
| archivos de test | `:378` | `:412` | **303** |
| archivos lintados | `:383` | `:417` | **501** |

**`git add` primero. Después derivá con los tres comandos de §0.2. Después escribí.**
⛔ No copies ni los del SDD ni los que yo conté.

---

## W2.7 · `doc/sdd/_INDEX.md` — **+1** — ⚠️ **PROBABLEMENTE YA ESTÁ HECHO**

🔴 **CONTRADICCIÓN SDD ↔ CÓDIGO, medida hoy.** El SDD dice *"+1: la fila de `index-row.md`, AL FINAL
de la tabla"*. Pero la fila **ya existe**:

```
$ /usr/bin/grep -n "^| [0-9]" doc/sdd/_INDEX.md | tail -1
217:| 225 | 2026-08-19 | [WKH-PENDIENTE] El Coordinador orquesta un paso que espera a una persona…
$ /usr/bin/git log --oneline -1 -- doc/sdd/_INDEX.md
0f6502a docs(WKH-225): la HU del paso suspendible, y por que el Coordinador la necesita
```

⇒ **CD-14 ya está satisfecho.** `work-item.md` e `index-row.md` ya están trackeados y la fila existe.

**Qué hacer**: verificar con el comando de arriba. **Si la fila está ⇒ NO agregues una segunda.**
El control **G-A2** (`test/sdd-index-matches-folders.test.ts:268`) exige **EXACTAMENTE UNA fila por
carpeta de HU**: una segunda pone `npm test` en ROJO.

⛔ **Y en ningún caso insertes una línea por ENCIMA de la 144.** El control **G-F1**
(`test/sdd-index-matches-folders.test.ts:398`) verifica líneas de `_INDEX.md` citadas desde `src/`, y
`src/lib/capability-risk.ts:81-82` cita `doc/sdd/_INDEX.md:144`. Verificado hoy: la línea 144 es la
fila `157` y contiene `remit.corridor-discovery`. **Insertar por encima corre la tabla y rompe una
cita del camino del dinero.**

---

## 🚪 Puerta de salida de W2 = Done Definition

---

# 4. Done Definition

## 4.1 El gate, entero, en orden, desde `/home/ferdev/.openclaw/workspace/wt-225`

```bash
npx tsc -p tsconfig.json --noEmit
npm run lint
npm test
cd mcp-servers/wasiai-x402 && npm ci --ignore-scripts && npm test
cd packages/agent-sdk && npm install --ignore-scripts --no-audit --no-fund && npm test
```

⛔ **`npm run qa` NO EXISTE en este repo.** No lo inventes, no lo agregues (es `NC-2`, va en commit
propio fuera de esta HU). **Citá la salida de cada paso.**

## 4.2 Los 12 ACs, cada uno con su testigo ejecutable

| AC | Testigo |
|---|---|
| AC-1 · suspender sin `success:false` ni evento de residuo | `T-SUSP-1`, `T-SUSP-2` |
| AC-2 · persistir el estado mínimo + devolver artefacto e id | `T-SUSP-3`, `T-SUSP-4` |
| AC-3 · no debitar/settlear/invocar los steps posteriores | `T-SUSP-5` |
| AC-4 · firma ANTES de leer el payload; `RESUME_INVALID` sin tocar la base | `T-TOK-1..8` |
| AC-5 · single-use ⇒ `RESUME_ALREADY_USED`, cero movimiento | `T-RES-1`, `T-RES-2`, `T-RUN-1` |
| AC-6 · cross-owner ⇒ **404** disclosure-safe | `T-RES-3`, `T-RUN-2` |
| AC-7 · vencido ⇒ terminal + **exactamente un** residuo, sólo con evidencia | `T-RES-4..7` |
| AC-8 · continuar desde el siguiente, sin re-invocar ni re-debitar | `T-RES-8`, `T-RES-9` |
| AC-9 · bandera OFF ⇒ **exactamente como hoy** | `T-SUSP-6` |
| AC-10 · clasificar las 2 capacidades | `T-CAP-1/2/3` |
| AC-11 · 4ª lista de reconciliación, sin mezclar | `T-REC-1/2/3` |
| AC-12 · guard anti-bucle en la reanudación | `T-RES-10`, `T-RES-11` |

**Transversales**: `T-SUSP-CALLSITE` · `T-SUSP-GUARD571` · `T-SUSP-NOERRCODE` · `T-SUSP-IMPOSSIBLE`
· `T-TOK-LEAF` · `T-MIG-*` · `T-OWN-*`.

## 4.3 Los 22 CDs

Los 14 heredados del work-item (CD-1..CD-14) + los 8 nuevos del SDD (CD-15..CD-22). Cada uno con su
testigo o su motivo escrito. Ninguno negociable.

## 4.4 Presupuesto de líneas (regla 10 del `CLAUDE.md`; el CR lo contrasta en su check 7)

| Wave | Producción | Tests | SQL | Docs/config | **Total** |
|---|---|---|---|---|---|
| W0 | 346 | 625 | 237 | 126 | **1334** |
| W1 | 499 | 975 | 0 | 0 | **1474** |
| W2 | 295 | 560 | 0 | 17 | **872** |
| | **1140** | **2160** | **237** | **143** | **≈ 3680** |

**Umbral del CR: > 7360 líneas exige justificación escrita o recorte.**
⚠️ Un diff **por debajo** del presupuesto en los archivos de contrato es tan sospechoso como uno por
encima: este repo tiene densidad de docblock **alta y deliberada**.

## 4.5 Lo que el Dev NO decide y tiene que ESCALAR

- **`[NEEDS CLARIFICATION]` abiertas** (`NC-1..NC-5`, SDD §10). **Ninguna bloquea F3.** `NC-2` (el
  script `qa`) bloquea **F4**.
- **`TD-225-01`** (sin sweeper de expiración proactiva) y **`TD-225-02`** (el docblock rancio de
  `src/lib/compose-limits.ts:11-27`, que describe un mecanismo que WKH-307 borró). **NO los
  arregles**: van al reporte de cierre con su fila.
- **Acción de OPS que ningún código hace**: republicar la ficha del agente en **bdwv** para que
  `capabilities` incluya `kyc-hosted-redirect`. `registry.ts:36-42` es textual:
  *"COPIA MANUAL … nada la sincroniza"*. Va al reporte de cierre, **no se descubre después**.
- **Si un archivo de Scope OUT necesita diff ⇒ PARÁS Y AVISÁS.** Significa que DT-A2 se rompió.

## 4.6 Focos declarados para el AR (los conocés desde ya; no los descubras vos)

1. **Replay del token de reanudación.**
2. **El reloj** — re-apuntado: el peligro que DT-6 describía **no existe**; el que sí existe es que
   el `expires_at` se escriba desde Node. **Atacar CD-19.**
3. **R-4 — PII durable** en `steps_json`: un agente de KYC podría poner PII en `StepResult.output`.
   Hoy ese output ya viaja al caller por HTTP (`src/routes/compose.ts:1270-1277`); la suspensión lo hace
   **durable**, que es un cambio de exposición **real**.
4. **DT-A1/DT-A2** — que `{success:true, suspended}` sea inalcanzable desde `/orchestrate`.
   ¿`T-SUSP-CALLSITE` es un testigo o un control que se lee a sí mismo?
5. **CD-18** — el doble cobro del fee de protocolo.

---

# 5. Contradicciones SDD ↔ código encontradas en este F2.5

**No corregí el SDD. Las dejo escritas acá y en el reporte al orquestador.**

| # | Qué dice el SDD | Qué mide el código hoy | Impacto |
|---|---|---|---|
| **C-1** 🔴 | El SDD **no menciona** `test/cited-lines-guard.*` | `CORTE_A_PATHS` (`citations.ts:87-102`) incluye **`src/types/index.ts` y `src/services/compose.ts`**, los dos archivos de W0.1 y W1.4. 5 entradas con `line:` fijo apuntan a esos archivos y a `src/routes/compose.ts` | **Puede poner `npm test` en ROJO.** Mitigado en §0.6 |
| **C-2** | W2.7: *"la fila del `_INDEX.md`, +1, al final de la tabla"* | La fila **ya existe**: `_INDEX.md:217`, commit `0f6502a`. CD-14 ya satisfecho | Agregar una segunda **rompe G-A2**. Mitigado en W2.7 |
| **C-3** | W2.5: *"+7 test files, +3 variables, +3 archivos `src/**/*.ts`"* | Mi conteo del plan de archivos: **+6 test files** (5 bajo `src/` + 1 bajo `test/`), **+3 variables**, **+7 archivos `src/**/*.ts`** (biome linta también los `.test.ts` de `src/`) | CD-20 ya obliga a **re-derivar**; ninguno de los dos números se usa |
| **C-4** | CD-18: *"`routes/compose.ts:1167-1170` idempotiza por `orchestrationId`"* | El `try` abre en `:1167`, pero `orchestrationId: request.id` está en **`:1183`** y `feeBaseUsdc` en **`:1184`** | Cosmético. Números exactos en §0.4 |
| **C-5** | §8.2: *"`packages/agent-sdk` … `npm install --ignore-scripts`"* | `ci.yml:81` es `npm install --ignore-scripts --no-audit --no-fund` | Cosmético. Comando exacto en §0.1 |
| **C-6** | DT-A4 describe `claim_suspended_run(p_token_hash, p_owner_ref)` "copiando el exemplar" | `claim_agent_link` toma **un solo** arg y **no** filtra por owner (`database.types.ts:2988`, `…agent_links.sql:59-115`) | **Es una divergencia deliberada y correcta** (AC-6 la exige). Declarada en W0.4 para que el AR no la lea como copia mal hecha |

**Exemplars del SDD que NO se pudieron verificar: ninguno.** Los 30 archivos del Context Map existen;
verifiqué con `sed`/`ls`/`wc` los rangos de los 11 exemplars de §5 y todos dicen lo que el SDD
afirma, con desvíos de ±2 líneas en tres rangos (anotados arriba donde importa).

---

# 6. Anexo — dónde está cada cosa (rutas absolutas)

| Qué | Ruta |
|---|---|
| Worktree de trabajo | `/home/ferdev/.openclaw/workspace/wt-225` |
| 🔴 `project-context.md` (gitignoreado, NO está en el worktree) | `/home/ferdev/.openclaw/workspace/wasiai-a2a/.nexus/project-context.md` |
| `node_modules` (para leer los `.d.ts` INSTALADOS) | `/home/ferdev/.openclaw/workspace/wasiai-a2a/node_modules/` |
| SDD | `/home/ferdev/.openclaw/workspace/wt-225/doc/sdd/225-paso-suspendible-y-reanudable/sdd.md` |
| Work Item | `/home/ferdev/.openclaw/workspace/wt-225/doc/sdd/225-paso-suspendible-y-reanudable/work-item.md` |
| Fila del índice (ya aplicada) | `/home/ferdev/.openclaw/workspace/wt-225/doc/sdd/225-paso-suspendible-y-reanudable/index-row.md` |
| Este Story File | `/home/ferdev/.openclaw/workspace/wt-225/doc/sdd/225-paso-suspendible-y-reanudable/story-file.md` |

**Herramientas** — ⚠️ el hook `rtk` deforma o trunca la salida de varias:
`/usr/bin/grep` (no `grep`) · `/usr/bin/git diff` (no `git diff`: **trunca cortando hunks**) ·
`git log` bajo `rtk` **borra los commits de merge** (usá `rev-parse` / `merge-base`) ·
⛔ **no redirijas `head`/`cat` bajo `rtk`: corrompe la salida con exit 0.**
