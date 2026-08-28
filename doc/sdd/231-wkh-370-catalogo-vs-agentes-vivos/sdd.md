# SDD #231: [WKH-370] Nada compara el catálogo con los agentes vivos

> SPEC_APPROVED: no
> Fecha: 2026-08-27 · Rol: nexus-architect · Fase: F2
> Tipo: feature (guard/vigilante)
> SDD_MODE: full · Modo NexusAgil: QUALITY
> Branch: `feat/231-wkh-370-catalogo-vs-agentes-vivos` (desde `main` @ `a9087e4` — **medido**: `git rev-parse --abbrev-ref HEAD` → `main`, cierra MI-7)
> Artefactos: `doc/sdd/231-wkh-370-catalogo-vs-agentes-vivos/`
> Issue de origen: github.com/ferrosasfp/wasiai-a2a/issues/186

---

## 0. Cómo leer las citas de este documento

El F1 corrió **sin shell**. Este F2 **sí tuvo shell y red**, y volvió a medir. Marcas:

| Marca | Significado |
|---|---|
| `[MEDIDO-F2]` | Lo ejecuté/leí en esta corrida, hoy 2026-08-27, contra este árbol o contra producción. |
| `[HEREDADO]` | Viene del work-item o del encargo y **no** lo re-medí. Se declara, no se afirma. |

⚠️ `doc/sdd/` **no** está en `CORTE_A_PATHS` (`test/cited-lines-guard.citations.ts:87-102`, 14 paths) `[MEDIDO-F2]` ⇒ **las citas de este SDD no las verifica ninguna suite**. Se escribieron abriendo cada archivo, no copiándolas de otro documento — que es el defecto que `test/cited-lines-guard.test.ts:17-25` documenta como una tasa del 5 % en el mejor caso posible.

### Línea base del gate — medida hoy, árbol limpio en `a9087e4`

```
git status --short          → (vacío: árbol limpio, índice consistente)
npx tsc -p tsconfig.json --noEmit  → "TypeScript compilation completed"          exit 0
npm run lint                       → "Checked 519 files in 304ms. No fixes applied."  exit 0
npm test                           → Test Files  312 passed | 6 skipped (318)
                                     Tests      6310 passed | 19 skipped (6329)   exit 0
                                     Duration 15.38s
```
`[MEDIDO-F2]` — corrida completa y **en el orden de `.github/workflows/ci.yml:36-43`**. ⛔ `npm run qa` no existe en este repo.

La fila `231` **ya está pegada** en `doc/sdd/_INDEX.md:223` `[MEDIDO-F2]`, así que `test/sdd-index-matches-folders.test.ts` está verde en la línea base y no hay deuda pendiente del F1.

---

## 1. Resumen

La ficha de cada agente self-published en `a2a_agents` es una copia a mano del manifiesto que el agente sirve, y **nada las compara nunca**. Esta HU construye el vigilante. No corrige datos (Scope OUT).

Se entrega **un chequeo con dos mitades independientes**, porque los defectos son de familias distintas y el chequeo obvio sólo caza una:

- **DERIVA** — catálogo ≠ manifiesto vivo. Se mide con datos **públicos**, cero credenciales.
- **COMPLETITUD** — la fila está **incompleta**, no desincronizada: no *difiere* del manifiesto, simplemente no tiene nada que comparar. Un chequeo de deriva la llama conforme.

Las dos mitades corren como **dos jobs independientes** de un workflow propio programado, con **clases y códigos de salida distintos** y **dos títulos de issue distintos**, para que el código de salida solo ya atribuya la causa y para que el verde de una nunca cierre el aviso de la otra.

**El resultado que importa no es que el chequeo dé verde hoy: es que se ponga rojo cuando corresponda, y por el motivo correcto.** De hecho **nace en rojo**, y eso es correcto — ver §11.

---

## 2. Work Item

| Campo | Valor |
|---|---|
| **#** | 231 |
| **Tipo** | feature (guard) |
| **SDD_MODE** | full |
| **Objetivo** | Un vigilante que compare catálogo↔manifiesto vivo (deriva) y evalúe la completitud de la fila, como dos comprobaciones separadas con clases y exit codes distintos. |
| **Scope IN** | `scripts/check-catalog-vs-live.mjs`, `test/check-catalog-vs-live.test.mjs`, `.github/workflows/check-catalog-vs-live.yml`, un booleano derivado en `src/services/agent.ts` + su test, `package.json` (2 scripts), `.env.example`, los 2 números de los dos README, 3 números de línea en `test/cited-lines-guard.citations.ts`. |
| **Scope OUT** | Corregir filas del catálogo · el camino del dinero (`agent-split-context.ts`, `compose.ts`, el settle) · el pin del KYC · `src/services/discovery.ts` · los 24 federados · cualquier método que no sea GET. |
| **Missing Inputs** | MI-1..MI-7 del F1: **todos cerrados** en §10. Queda **MI-8 nuevo** (acción del founder): crear el secreto `A2A_CATALOG_OWNER_KEY`. No bloquea el merge. |

Los ACs son los del work-item (AC-1..AC-10) y no se reescriben acá. §8 mapea cada uno a su test.

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos en esta corrida

| Archivo | Por qué | Patrón extraído `[MEDIDO-F2]` |
|---|---|---|
| `scripts/probe-money-path.mjs` (463 líneas) | Arte previo directo: la sonda que ya clasifica en clases con exit code por clase | Encabezado que declara las clases (`:6-10`); `schemaFingerprint` + `canonicalJson` (`:201-212`); `ladder()` pura con default que **no** es PASS (`:343-345`); `request()` con timeout+retry acotado (`:357-374`); `main(env = process.env)` exportada que **devuelve** el exit code (`:379`); `emit()` que escribe UNA línea (`:443-450`); auto-run sólo si se invoca directo (`:452-463`) |
| `test/probe-money-path.test.mjs` (581 líneas) | El molde de la suite: cero red, funciones puras importadas + afirmaciones sobre el YAML REAL | `sinComentarios(yaml)` y `sinComentariosJs(src)` (`:41-62`) para que el guardián mire CÓDIGO y no PROSA; `fetch` doblado para `main()` (`:326`); fixture del schema real (`:65`) |
| `.github/workflows/smoke-downstream.yml` (94 líneas) | Exemplar estructural del F1 (opción C): secret-free, cron, título propio | Job único, `permissions: contents:read + issues:write` (`:17-19`); abrir/comentar por título exacto (`:74-79`); cerrar en verde (`:83-94`) |
| `.github/workflows/probe-money-path.yml` (178 líneas) | El aviso más completo del repo, y el que trae la trampa de CD-6 | El aviso **pega la línea de clase** vía `env:` (`:117`), nunca interpolada en el `run:`; el fallo de `gh issue list` no se traga el aviso (`:148-151`); `TITULO` idéntico en abrir (`:116`) y cerrar (`:165`) |
| `.github/workflows/ci.yml` (105 líneas) | El gate, y el motivo por el que este chequeo NO va ahí | `:4-6` declara *"Runs WITHOUT secrets or a live database"*; los 3 pasos del gate en `:36-43` |
| `src/services/agent.ts` (≈820 líneas) | Los DOS mappers, `getSplitContextRow`, el shape de `listMine` | `mapRowToAgent` → `/discover`, emite `metadata` entero (`:138-171`, el `metadata,` de `:165`) y **ningún `inputSchema` de raíz**; `mapRowToRecord` → `publish`/`update`/`listMine`, **sí** iza `inputSchema`/`outputSchema` a la raíz (`:176-177,190-191`); `getSplitContextRow` selecciona `owner_ref, payout_wallet, referrer_ref` (`:373`) |
| `src/routes/agents.ts` (599 líneas) | Quién puede leer qué | `GET /` (listMine) con `preHandler: [...requireA2AKey()]` (`:574-578`) y filtro por `keyRow.owner_ref` (`:586`). **`PATCH /:slug` (`:362-368`) y `DELETE /:slug` (`:533-536`) usan EXACTAMENTE el mismo `requireA2AKey()`** |
| `src/services/agent-split-context.ts` (121 líneas) | La tesis de la HU, y CD-5 | El ternario `row?.payoutWallet ? … : null` (`:50-52`); CD-5 (`:13-14`); best-effort CD-10 (`:8-10`) |
| `src/types/database.types.ts` | La forma real de la fila | `a2a_agents.Row` (`:53-66`): `owner_ref: string` **NOT NULL**, `payout_wallet: string \| null`, `metadata: Json \| null`. `Insert` (`:75`) exige `owner_ref` |
| `src/types/index.ts` | El discriminante del universo | `SELF_PUBLISHED_REGISTRY_ID = 'self-published'` (`:305`), `SELF_PUBLISHED_REGISTRY_NAME = 'self-published'` (`:306`) |
| `src/routes/discover.ts` | La base de CD-8 | `:325-348`: el detalle perdió `rateLimit: false` y pasó a **201 `supabase.from()`** por request con 200 filas; 30 con 29 filas |
| `src/routes/metrics.ts` | Descartar `/metrics` como casa del booleano | Contadores en memoria, `METRICS_TOKEN` fail-CLOSED en prod (`:19-25`). No lee la base ⇒ no sirve |
| `src/routes/charged-routes.meta.test.ts` | Que el chequeo no gaste | Inventario CONGELADO de rutas que cobran (`:280-291`): **ningún `GET`/`HEAD`**, y `:299` lo fija |
| `vitest.config.ts` | Qué corre y con qué globs | `include: ['src/**/*.test.ts','test/**/*.test.ts','test/**/*.test.mjs']` (`:5`); `passWithNoTests: false` (`:16`) |
| `biome.json` | Qué se lintea | `files.includes: ["src/**/*.ts"]` (`:9`) ⇒ **`scripts/` y `test/` NO se lintean** |
| `package.json` | Dónde agregar scripts sin romper nada | Línea **11** = `"lint": "biome check src/",` `[MEDIDO-F2]`. Un test del repo la clava (ver CD-14) |
| `test/readme-numbers.test.ts` | Los números que se mueven | `trackedFiles()` usa `git ls-files` (`:82-90`) — **contra el ÍNDICE, no el disco** |
| `test/cited-lines-guard.citations.ts` | El costo oculto de tocar `src/services/agent.ts` | `CORTE_A_PATHS` (`:87-102`) incluye `src/routes/agents.ts` y `src/services/agent.ts`. **3 citas apuntan a `src/services/agent.ts`, en las líneas 399, 808 y 822** `[MEDIDO-F2]` |
| `test/scripts-imported-by-tests-are-tracked.test.ts` | Por qué el `.mjs` nuevo tiene que estar en el índice | Descubre CUALQUIER literal `scripts/*.mjs` (`:48`), importado o spawneado |
| `test/test-files-are-run-in-ci.test.ts` | Por qué el workflow nuevo no puede confundir al descubridor de runners | Descubre runners leyendo los workflows y quedándose con los steps que corren `npm test` / `npm run test…` (`:28-39`) |
| `doc/sdd/230-…/auto-blindaje.md`, `doc/sdd/229-…/auto-blindaje.md` | Auto-Blindaje histórico (paso obligatorio de F2) | Ver §6.3 |

### 3.2 Exemplars verificados (existencia confirmada por barrido de archivos, hoy)

| Para crear | Seguir patrón de | Existe | Qué se copia |
|---|---|---|---|
| `scripts/check-catalog-vs-live.mjs` | `scripts/probe-money-path.mjs` | ✅ | Encabezado de clases, `schemaFingerprint`, `ladder` pura, `main(env)` exportada, `emit()` de una línea, auto-run condicional |
| `test/check-catalog-vs-live.test.mjs` | `test/probe-money-path.test.mjs` | ✅ | `sinComentarios`/`sinComentariosJs`, fixtures literales, `fetch` doblado, afirmaciones sobre el YAML real |
| `.github/workflows/check-catalog-vs-live.yml` | `.github/workflows/probe-money-path.yml` (aviso) + `smoke-downstream.yml` (estructura secret-free) | ✅ ✅ | Bloque `permissions`, abrir/comentar/cerrar por título exacto, `env:` para la línea de clase |
| booleano en `src/services/agent.ts` | `mapRowToRecord` (`:174-198`), asignación condicional | ✅ | El mismo estilo de campo derivado del row |
| `src/services/agent.completeness.test.ts` | `src/services/agent.payment.test.ts` | ✅ | Convención de tests de servicio junto al servicio |

### 3.3 Estado real medido contra producción, hoy 2026-08-27 `[MEDIDO-F2]`

`GET https://wasiai-a2a-production.up.railway.app/discover` → 200.

```
sobre:      { agents, total, totalAtLeast, registries, sources, catalogStatus, excluded }
total: 29 · totalAtLeast: 29 · catalogStatus: "complete"
sources: [{name:"WasiAI", state:"ok", rows:24}, {name:"self-published", state:"ok", rows:5}]
hosts de invokeUrl: wasiai-remittance-agents.vercel.app → 5 ; wasiai-v2.vercel.app → 24
con `metadata.inputSchema`: 5   ·   con `inputSchema` EN LA RAÍZ: 0   ← CD-1, medido
```

**El discriminante del universo NO es el host: es el campo `registry`.** Cada fila trae `registry: "self-published"` o `registry: "WasiAI"` `[MEDIDO-F2]`, y para self-published lo pone el mapper como literal (`agent.ts:150` → `SELF_PUBLISHED_REGISTRY_NAME`). Parsear el host es adivinar; leer `registry` es preguntar.

Los 5 elegibles y su `pathSlug` (derivado del `invokeUrl`, **2 de 5 difieren del slug**):

| slug del catálogo | pathSlug | `metadata` keys |
|---|---|---|
| `remit-corridor-fx-solana` | **`remit-corridor-fx`** ⚠️ | payment, inputSchema, discoverable, outputSchema |
| `remit-cashout-payout-solana` | **`remit-cashout-payout`** ⚠️ | payment, inputSchema, discoverable, outputSchema |
| `remit-kyc-validator` | `remit-kyc-validator` | payment, inputSchema, discoverable, outputSchema |
| `remit-kyc-decision` | `remit-kyc-decision` | payment, inputSchema, discoverable — **sin `outputSchema`** |
| `remit-kyc-session` | `remit-kyc-session` | payment, inputSchema, discoverable — **sin `outputSchema`** |

Cierra MI-4. Y la última columna es el hallazgo de §11.

### 3.4 El manifiesto — medido, no asumido (cierra MI-2)

URL = `invokeUrl` con el sufijo `/invoke` reemplazado por `/manifest`. Los 5 dan **200 `application/json`** `[MEDIDO-F2]`:

```
keys de primer nivel (idénticas en los 5):
  manifestVersion, slug, name, description, capabilities, priceUsdc, inputSchema, payment

⚠️ `inputSchema` está EN LA RAÍZ del manifiesto (en el catálogo vive en `metadata.inputSchema`).
⚠️ `outputSchema` NO está en NINGUNO de los 5 manifiestos.  ← 0/5, medido
✅ `manifest.slug === catalogo.slug` en los 5, INCLUIDOS los 2 cuyo pathSlug difiere.
```

Deriva medida hoy, huella sha256-12 sobre JSON canónico:

| slug | `metadata.inputSchema` | `manifest.inputSchema` | |
|---|---|---|---|
| remit-corridor-fx-solana | `8d8bb152ab46` | `8d8bb152ab46` | OK |
| remit-kyc-decision | `290928d46672` | `290928d46672` | OK |
| remit-cashout-payout-solana | `ff84b5afd42a` | `ff84b5afd42a` | OK |
| remit-kyc-session | `e65060f33f32` | `e65060f33f32` | OK |
| remit-kyc-validator | `7d507b7985fa` | `7d507b7985fa` | OK |

Y además, comparados en la misma corrida: `name` **5/5 iguales**, `priceUsdc` **5/5**, `capabilities` **5/5**, `metadata.payment` vs `manifest.payment` **5/5** `[MEDIDO-F2]`. **Deriva 0/5 en cinco campos, no en uno.**

**Federados**: `GET https://wasiai-v2.vercel.app/api/v1/models/agentshop-cashout-matcher/manifest` → **404 con cuerpo HTML** `[MEDIDO-F2]`. Confirma CD-3 y el Scope OUT.

---

## 4. Decisiones técnicas

### DT-1 — Dónde corre: **workflow propio programado, partido en dos jobs SIN `needs:`**

Se confirma la opción C del F1. Lo que este F2 agrega es la **verificación de que la partición da la propiedad prometida**, que era el pedido explícito del encargo.

`smoke-downstream.yml` tiene **un solo job** (`light-smoke`, `:22`) `[MEDIDO-F2]`, así que el exemplar no demuestra la propiedad por sí mismo: la demuestra la **ausencia de `needs:`**. En GitHub Actions, dos jobs sin `needs:` corren en paralelo y el fallo de uno no impide el otro. Por eso:

- **job `deriva`** — cero secretos. Corre siempre.
- **job `completitud`** — recibe `A2A_CATALOG_OWNER_KEY`. Si el secreto falta, sale **CONFIG(3)** nombrándolo, y `deriva` **no se entera**.
- ⛔ **Ningún `needs:` entre ellos.** Un test lo afirma sobre el YAML real (T-Y3).

Descartadas, con el motivo medido:

| Opción | Por qué no |
|---|---|
| Dentro de `npm test` / `ci.yml` | `ci.yml:4-6` declara que corre *"WITHOUT secrets or a live database"*. Meter red contra producción ahí revierte una decisión de arquitectura del gate, no la ajusta. **CD-4.** |
| Colgado de `probe-money-path.yml` | Pasa **un solo** secreto (`A2A_PROBE_KEY`, `:100`) y ninguna credencial de catálogo. Y su aviso dedupea/cierra **por título exacto** (`:116`, `:165`) ⇒ compartirlo hace que el verde del pago cierre el aviso de la deriva. **CD-6.** Además ata la cadencia del catálogo a una que se eligió por **presupuesto de dinero** (`:34-38`, bajó de 48 a 24 corridas/día). |

**Cadencia**: `cron: '23 6 * * *'` — diaria, minuto no redondo (el planificador de GitHub encola masivamente en el minuto 0, razón escrita en `probe-money-path.yml:31-33`), y distinta de las dos existentes (`0 7 * * *` y `7 * * * *`) para no competir por runner. Costo: **0 USDC** — sólo GET, y el inventario congelado de rutas que cobran no tiene ningún `GET` (`charged-routes.meta.test.ts:280-299`).

**Triggers**: `schedule` + `workflow_dispatch` + `pull_request` acotado por `paths:` a los 3 archivos del chequeo. El `pull_request` es **sólo para el job `deriva`** (`continue-on-error: true`, informativo): el job `completitud` lleva `if: github.event_name != 'pull_request'` para que **la credencial no viaje a ninguna corrida de PR**, ni siquiera de una rama de este mismo repo — que sí recibe los secrets (`probe-money-path.yml:77-79` lo documenta medido).

### DT-2 — La vista autoritativa del catálogo es la **LISTA**

Se hereda de WKH-369 y se re-verifica: `discover.ts:325-348` `[MEDIDO-F2]` documenta que `GET /discover/:slug` pasó de 1 a **hasta 201 `supabase.from()` por request** (30 con las 29 filas de hoy) y **perdió `rateLimit: false`**. El chequeo lee `GET /discover` **una vez por job** y deriva todo de ahí. **CD-8.**

### DT-3 — 🔴 La credencial de la mitad de completitud: **se elige 3b**, con una acotación que las tres opciones del F1 no tenían

**Primero, los tres hechos que este F2 midió y que cambian el planteo del F1:**

1. **`owner_ref` NO puede ser nulo.** `database.types.ts:53-66` lo declara `owner_ref: string` en `Row` y **obligatorio en `Insert` (`:75`)** `[MEDIDO-F2]`. ⇒ Un chequeo de *presencia* de `owner_ref` **es vacuo**: no existe input que lo ponga rojo. Es exactamente la clase "control que se lee a sí mismo" de CD-7. Se conserva como campo de AC-2 pero se implementa como **cadena no vacía tras `trim()`** (lo único que el tipo no descarta) y **se declara vacuo en el docblock**. No se disfraza de protección.
2. **`payout_wallet` no tiene ningún camino de lectura público.** Barrido completo de `src/` `[MEDIDO-F2]`: los únicos lectores son `getSplitContextRow` (`agent.ts:373`) y `agent-split-context.ts:50,65`. `mapRowToAgent` no lo emite; `mapRowToRecord` tampoco. Confirma el hallazgo del F1.
3. **🔴 No existe ninguna agent key de sólo lectura.** `GET /` (listMine), `PATCH /:slug` y `DELETE /:slug` usan **el mismo** `requireA2AKey()` (`agents.ts:577`, `:368`, `:536`) `[MEDIDO-F2]`. El scoping de una key (`allowed_agent_slugs`, `max_spend_per_call_usd`) rige la **invocación**, no el CRUD del catálogo. ⇒ **cualquier** credencial capaz de leer `listMine` puede además borrar esas filas. Esto el F1 no lo midió y es el costo real de 3b.

**Y una medición que cierra la factibilidad de 3c:**

`a2a_agents` **no está** en `RLS_TABLES` (`scripts/verify-rls-enabled.mjs:23-34`, la lista canónica de tablas con RLS verificada, 10 nombres) `[MEDIDO-F2]` — aunque `a2a_agents` **sí tiene** `owner_ref`. Sin RLS, una llave `anon`/publicable lee la fila **entera**, `payout_wallet` incluido. Una 3c honesta exige, en producción y por mano del founder: `ENABLE ROW LEVEL SECURITY` sobre una tabla del vecindario del dinero (que es **WKH-SEC-02 / TD-SEC-01, abierta**), **o** una VISTA + un rol Postgres dedicado + un JWT firmado con el secreto del proyecto. Las dos son **DDL de producción fuera del Scope IN** y **no verificables dentro de esta HU**.
> Nota lateral, no de esta HU: que `a2a_agents` tenga `owner_ref` y no esté en `RLS_TABLES` es una discrepancia real entre el criterio escrito de `CLAUDE.md` y la lista de ese script. Queda anotado como **`TD-370-RLS-SET-INCOMPLETO`**, no se toca acá.

**La decisión:**

> ### ✅ **3b — un booleano `hasPayoutWallet` en `PublishedAgentRecord`, emitido por `mapRowToRecord` y servido SÓLO por rutas ya autenticadas y owner-scoped.**

| Opción | Radio de explosión de la credencial | Veredicto |
|---|---|---|
| **3a** service key BYPASSRLS | **La base de producción entera** (`bdwv`): budgets de todos los owners, escrows, `tasks`, keys | ⛔ **Rechazada.** El radio no es proporcional a leer un booleano |
| **3b** booleano en ruta autenticada | Las **7 filas** de ese owner: leer, modificar, borrar | ✅ **Elegida** |
| **3c** llave de sólo lectura de alcance mínimo | El más chico | ⛔ **No factible en esta HU** — medido arriba: exige DDL de producción y acción del founder que esta HU no puede verificar |

**Quién puede leer el booleano, y por qué no filtra el valor de la wallet** (la pregunta explícita del encargo):

- **Quién**: únicamente el **dueño de la fila**, con su propia agent key, vía `GET /agents` — la ruta filtra por `keyRow.owner_ref` antes de mapear (`agents.ts:586`) — y vía el eco de su propio `POST`/`PATCH`. Es el mismo dato que ese dueño ya cargó él mismo.
- **Nunca por `/discover`**: `/discover` pasa por `mapRowToAgent` (`agent.ts:138-171`), **otro mapper**, que no se toca. Esta HU no agrega **ninguna** superficie pública anónima.
- **Por qué no viola CD-5** (`agent-split-context.ts:13-14`, *"lee `payout_wallet`/`owner_ref` SOLO vía `getSplitContextRow` (nunca por un shape público)"*): CD-5 protege **el valor**. `hasPayoutWallet` es `row.payout_wallet !== null && row.payout_wallet.trim() !== ''` — un bit. No permite derivar la dirección, ni su longitud, ni su familia (EVM/Solana). **Presencia ≠ valor**, y ese es el eje entero de la decisión.

**Las mitigaciones, que son parte de la decisión y no un adorno** (porque el hecho 3 de arriba es real):

1. El secreto se llama **`A2A_CATALOG_OWNER_KEY`** —nombre propio, nunca reusar `A2A_PROBE_KEY`— y **sólo** lo recibe el step del job `completitud`. Un test lo cuenta sobre el YAML: aparece **exactamente una vez** (T-Y5).
2. El job `completitud` lleva `if: github.event_name != 'pull_request'`. **La credencial no llega a ninguna corrida de PR** (T-Y6).
3. El chequeo **OBSERVA**: el fuente sin comentarios no contiene `method:` distinto de `GET`, ni `POST`, ni `PATCH`, ni `DELETE`, ni `/compose` (T-S1, CD-11).
4. ⛔ El valor nunca se imprime: la función que emite no menciona ninguna variable de credencial ni de wallet (T-S2, mismo estándar que `probe-money-path.mjs:19`).
5. Se declara **`TD-370-KEY-SOLO-LECTURA`**: el día que exista una agent key de sólo lectura, o RLS + vista sobre `a2a_agents` (WKH-SEC-02), este secreto se degrada. Escrito en el docblock del workflow, no en un backlog aparte.

⚠️ **Esto es lo que AR debe atacar.** La objeción más fuerte contra 3b, escrita acá para que nadie tenga que descubrirla: *el beneficio marginal es una alarma con latencia de 24 h sobre un campo que hoy está correcto en 5 de 5 filas, y el costo es una credencial permanente con poder de borrado sobre el catálogo de producción.* La respuesta: el defecto que la HU persigue nace en el **camino de escritura** (`POST /agents` sin `payoutWallet` no se queja — `agent.ts:467-468`, `:712-713`), y el vigilante es lo único que hoy lo vería. Si AR prefiere diferir el `payout_wallet` a la HU que arregle el camino de escritura, la alternativa está lista: bastan las filas 4 y 12 de la escalera de §5, y el chequeo saldría **CONFIG(3)** declarando que no midió esa mitad. **Eso lo decide el gate humano, no yo.**

### DT-4 — El costo oculto de tocar `src/services/agent.ts`, medido

`src/services/agent.ts` **está en `CORTE_A_PATHS`** (`test/cited-lines-guard.citations.ts:87-102`) y **3 citas declaradas apuntan a sus líneas 399, 808 y 822** `[MEDIDO-F2]`. La inserción de 3b va en la interfaz (≈`:88`) y en el mapper (≈`:196`), o sea **por encima de las tres** ⇒ las tres se desplazan y `test/cited-lines-guard.test.ts` **se pone rojo**.

Eso **no es un problema: es el guardián funcionando**, y es exactamente la lección de la memoria *"las citas que rompés vos al arreglar otra cosa"* y del aviso de `doc/sdd/230-…/auto-blindaje.md` (*"el fix-pack le movió TODAS las líneas"*). Se declara acá para que el Dev no lo descubra al final: **W3 corrige los 3 números a mano, leyendo cada línea**, nunca volcando la salida del escáner. **CD-13.**

`src/routes/agents.ts` **también** está en `CORTE_A_PATHS` y tiene **7 citas** apuntándole `[MEDIDO-F2]` — por eso **esta HU NO lo toca**: `GET /agents` ya devuelve lo que produce `mapRowToRecord`, así que el booleano viaja sin editar la ruta.

### DT-5 — Un solo script, dos modos

`scripts/check-catalog-vs-live.mjs` con `CHECK_MODE=deriva|completitud`. Un solo script porque las dos mitades comparten la lectura de `/discover`, la derivación del universo y la escalera; **una sola `classify()` pura** es un solo lugar donde testear el orden de precedencia.

⛔ **`CHECK_MODE` ausente o no reconocido ⇒ CONFIG(3)**, nunca un default que corra "algo". El principio es el de `probe-money-path.mjs:343-345`: *la única clase que jamás debe alcanzarse por omisión no puede ser la que dice que todo anda*.

### DT-6 — Qué campos se comparan para deriva, y cuál NO

Medido en §3.4: los 5 campos comparables coinciden hoy 5/5, así que los 5 entran.

| Campo | Catálogo | Manifiesto | Entra |
|---|---|---|---|
| `inputSchema` | `metadata.inputSchema` ⚠️ | raíz ⚠️ | ✅ por huella sha256-12 |
| `capabilities` | raíz | raíz | ✅ como conjunto canónico |
| `priceUsdc` | raíz | raíz | ✅ (es dinero) |
| `name` | raíz | raíz | ✅ |
| `payment` | **`metadata.payment`** ⚠️ | `payment` raíz | ✅ canónico |
| `description` | raíz | raíz | ⛔ prosa larga: generador de falsos rojos sin valor |
| `outputSchema` | `metadata.outputSchema` | **ausente 0/5** | ⛔ **excluido con motivo escrito**: no hay contraparte que comparar. Su ausencia **en el catálogo** sí cuenta, pero como **completitud**, no como deriva |

⚠️ **`payment` tiene la misma trampa que `inputSchema`, un nivel más allá**: `/discover` emite **DOS** `payment` — el `metadata.payment` **persistido** y un `payment` de raíz **derivado** por `readPaymentSpec` (`agent.ts:169`), que agrega `resolvedChain`/`network` que el manifiesto no tiene. Comparar el de raíz produce una deriva **fabricada** en los 5. **CD-12.**

### DT-7 — La clave de unión se **verifica**, no se confía

`pathSlug` sale del `invokeUrl` (`agent.ts:152` lo publica desde `row.agent_url`). Regla, en este orden:

1. Si el `invokeUrl` **no termina en `/invoke`** ⇒ **UNRESOLVED(6)** con motivo. ⛔ No se adivina otra forma de URL.
2. Se construye la URL de manifiesto reemplazando ese sufijo por `/manifest`.
3. Si el manifiesto **no contesta 200** o no es JSON ⇒ **INALCANZABLE(2)** para ese agente.
4. Si `manifest.slug !== catalogo.slug` ⇒ **UNRESOLVED(6)** y ⛔ **NO se comparan los schemas**.

Medido: los 5 pasan los 4 pasos, incluidos los 2 con `pathSlug ≠ slug`. **CD-2.**

---

## 5. Las clases de salida — el conjunto COMPLETO, y por qué cada una es distinguible

Sigue el patrón de `probe-money-path.mjs:6-10` (el código de salida solo ya atribuye la causa).

| Clase | exit | Qué afirma | Qué NO afirma |
|---|---|---|---|
| `CONFORME` | **0** | Se comparó **≥1** par y todo lo elegible está conforme y completo | Nada sobre los excluidos |
| *(excepción)* | **1** | Defecto del propio chequeo (excepción no manejada) | Nada sobre el catálogo. Reservado, igual que `probe-money-path.mjs:458-461` |
| `INALCANZABLE` | **2** | Un remoto no contestó: `/discover` o el manifiesto de un elegible (red, ≠200, no-JSON) | **NO** dice que el catálogo esté mal |
| `CONFIG` | **3** | **El chequeo no está en condiciones de afirmar nada.** Cubre: modo ausente/desconocido, catálogo vacío, cero elegibles, credencial ausente, **cero elegibles con schema (AC-7)**, cero pares comparados (AC-4), y "no pude preguntar por la completitud" | ⛔ **NO implica a producción.** Acusa al instrumento |
| `DERIVA` | **4** | Catálogo ≠ manifiesto en un campo comparable, nombrando slug, campo y las dos huellas (AC-1) | **NO** dice que la fila esté incompleta |
| `INCOMPLETA` | **5** | Una fila está **mal nacida** (AC-2/AC-3): le falta `metadata.inputSchema`, `metadata.outputSchema`, `payout_wallet` u `owner_ref` no vacío | **NO** dice que difiera del manifiesto. Puede tener deriva **cero** — ésa es la tesis |
| `UNRESOLVED` | **6** | La unión catálogo↔manifiesto **no se pudo verificar** (AC-6) | ⛔ **NO** es deriva. Un comparador que las confunda reporta una deriva que no existe |

**Las tres que el encargo pidió separar están separadas, y hay una cuarta:**
`DERIVA(4)` ≠ `INCOMPLETA(5)` ≠ *no-pude-preguntar*, y "no pude preguntar" **se parte en tres** porque son preguntas distintas:
`INALCANZABLE(2)` = *el otro no contestó* · `CONFIG(3)` = *yo no estoy en condiciones de preguntar* · `UNRESOLVED(6)` = *contestó, pero no puedo confiar en que sea el agente que creo*.

Ésa es la respuesta a la lección de `#180` que el encargo cita: **un "sin dato" nunca comparte código con un "todo bien", y el "sin dato" permanente (falta el secreto: fila 4) no comparte código con el transitorio (el remoto no contestó: fila 8).**

### La escalera — pura, primera fila que matchea gana

```
 0. catálogo no leído (red / status ≠ 200)                    → INALCANZABLE (2)
 1. CHECK_MODE ausente o no reconocido                        → CONFIG (3)
 2. agentes.length === 0                                      → CONFIG (3)   [catálogo vacío ⇒ instrumento]
 3. elegibles.length === 0                                    → CONFIG (3)   [AC-4/AC-5]
 4. modo=completitud && credencial ausente                    → CONFIG (3)   [nombra A2A_CATALOG_OWNER_KEY]
 5. modo=deriva && elegiblesConSchemaEnMetadata === 0         → CONFIG (3)   [AC-7 · CD-1 · el cero uniforme]
 6. modo=completitud && sinDato === elegibles.length          → CONFIG (3)   [no pude preguntar por NINGUNO]
 7. comparados === 0                                          → CONFIG (3)   [AC-4 · anti-vacuidad]
 8. inalcanzables > 0                                         → INALCANZABLE (2)
 9. unresolved > 0                                            → UNRESOLVED (6)  [AC-6]
10. incompletas > 0                                           → INCOMPLETA (5)  [AC-3 · va ANTES de deriva]
11. derivas > 0                                               → DERIVA (4)
12. sinDato > 0                                               → CONFIG (3)   [parcial: no se afirma lo que no se midió]
13. comparados > 0 && todo conforme                           → CONFORME (0)
14. default                                                   → INALCANZABLE (2)  ⛔ JAMÁS CONFORME
```

**Por qué 10 antes que 11**: AC-3 dice que una fila incompleta **no** se reporta como conforme; si coexisten, la que manda es la que cuesta dinero. **Y el orden no esconde nada**: la línea de salida lleva **siempre** los seis contadores, así que el exit code atribuye y la línea enumera.

**Formato de la línea única** (una sola, como `probe-money-path.mjs:443-450`):

```
<CLASE>: <mensaje que atribuye> | modo=<deriva|completitud> catalogo=<n> elegibles=<n>
  comparados=<n> derivas=<n> incompletas=<n> unresolved=<n> inalcanzables=<n>
  sindato=<n> excluidos=<n> durationMs=<n>
```
Más una segunda línea `EXCLUIDOS: slug=<motivo>; …` (AC-5 · CD-10: nunca en silencio) y, cuando hay hallazgos, una línea `HALLAZGO:` por agente con slug, campo y **las dos huellas** (AC-1) — nunca el valor de una wallet ni de una credencial (CD-5).

---

## 6. Constraint Directives

### 6.1 Heredados del work-item (íntegros, no se negocian)

- **CD-1** ⛔ PROHIBIDO buscar `inputSchema` en la raíz de `/discover`. Vive en `metadata.inputSchema`. **Re-medido hoy: 5 en `metadata`, 0 en la raíz.** Un barrido a la raíz devuelve *"0 de 29"*, que es falso ⇒ **cero uniforme ⇒ CONFIG, nunca deriva** (AC-7, fila 5).
- **CD-2** ⛔ PROHIBIDO asumir `slug == pathSlug`. Falso en **2 de 5, medido**. La unión se **verifica** por autodeclaración (DT-7).
- **CD-3** ⛔ PROHIBIDO tratar a los 29 por igual. El universo son los `registry === 'self-published'`. Los 24 federados **se excluyen con motivo escrito** (manifiesto 404 HTML, medido).
- **CD-4** ⛔ PROHIBIDO meter esto en `npm test` / `ci.yml` (`ci.yml:4-6`).
- **CD-5** ⛔ PROHIBIDO imprimir el valor de `payout_wallet`, de `owner_ref` o de cualquier credencial. **El repo es PÚBLICO.** Presencia/ausencia, nunca el valor.
- **CD-6** ⛔ PROHIBIDO reusar el título de issue de `probe-money-path` (`:116`,`:165`) o de `smoke-downstream` (`:56`,`:87`). **Y se extiende**: los DOS jobs de esta HU llevan títulos **distintos entre sí**, o el verde de la deriva cierra el aviso de la completitud — la misma trampa, un nivel adentro. **4 títulos, los 4 distintos** (T-Y4).
- **CD-7** ⛔ PROHIBIDO que el guard se lea a sí mismo, y prohibido un chequeo que sólo verifique una AUSENCIA sin control positivo. Todo test se rompe a propósito y **el rojo se confirma por su MOTIVO**.
- **CD-8** ⛔ PROHIBIDO iterar `GET /discover/<slug>`. Se lee la **lista**, una vez por job.
- **CD-9** ⛔ PROHIBIDO tocar `src/services/discovery.ts`, el camino del dinero y el pin del KYC. **El único `src/` de esta HU es `src/services/agent.ts`** (interfaz + `mapRowToRecord`) y su test nuevo. Declarado, como CD-9 exige.
- **CD-10** ⛔ PROHIBIDO excluir un agente en silencio. *"No lo pude medir"* **no es** *"está bien"*.
- **CD-11** ⛔ Este chequeo **OBSERVA**. Sólo GET. Ningún POST/PATCH/DELETE, ningún `/compose`.

### 6.2 Nuevos, de las mediciones de este F2

- **CD-12** ⛔ PROHIBIDO comparar el `payment` de **raíz** de `/discover` contra el del manifiesto. El de raíz lo **deriva** `readPaymentSpec` (`agent.ts:169`) y trae `resolvedChain`/`network` que el manifiesto no tiene ⇒ deriva **fabricada** en los 5. Se compara `metadata.payment`. Mismo error que CD-1, un campo más allá.
- **CD-13** ⛔ PROHIBIDO cerrar la HU sin corregir a mano las **3 citas** de `test/cited-lines-guard.citations.ts` que apuntan a `src/services/agent.ts` (líneas **399, 808, 822**), que la inserción de 3b desplaza. Se corrigen **leyendo cada línea**, jamás volcando la salida de un escáner.
- **CD-14** ⛔ PROHIBIDO insertar scripts en `package.json` por encima de la línea 11. Un test del repo clava `package.json` línea 11 = `"lint": "biome check src/"` `[MEDIDO-F2]`. Los 2 scripts nuevos van **al final** del bloque, después de `probe:money-path`. Y ⛔ ninguno puede empezar por `test`, o `test/test-files-are-run-in-ci.test.ts` intentaría traducirlo como runner.
- **CD-15** ⛔ PROHIBIDO afirmar que la completitud está verificada cuando el secreto falta. Filas 4 y 12 de la escalera. **Un "sin dato" nunca sale por exit 0.**
- **CD-16** ⛔ PROHIBIDO hardcodear 29 / 24 / 5. **El número se mueve** (MI-5): las dos filas del índice que lo corroboran dan 25 y 29 en fechas distintas. El chequeo lo **deriva** en cada corrida. Los fixtures de la suite sí son literales y llevan **la fecha en que se midieron**.
- **CD-17** ⛔ PROHIBIDO tratar la comprobación de `owner_ref` como una protección real sin declarar que es **casi vacua**: `database.types.ts:53-66,75` lo hace NOT NULL y obligatorio en `Insert`, así que el único input que la pone roja es la cadena vacía. Se escribe en el docblock. (CD-7 aplicado al propio diseño.)

### 6.3 Del Auto-Blindaje histórico — patrones que YA se repitieron

Leídos `doc/sdd/230-…/auto-blindaje.md` y `doc/sdd/229-…/auto-blindaje.md` `[MEDIDO-F2]` (los otros 4 son de HUs viejas). Tres patrones reinciden:

- **CD-18** ⛔ **`lint` es el SEGUNDO eslabón del gate y es el que sorprende.** 229 W0: un `expect(...).toBe(false)` de una línea pasó `tsc` y `vitest` y lo puso rojo **biome**. ⚠️ Y el corolario que ese mismo auto-blindaje deja escrito: **`npm run lint` es `biome check src/`, no mira `test/` ni `scripts/`** (`biome.json:9` = `["src/**/*.ts"]`, medido) ⇒ el único archivo de esta HU que biome va a mirar es `src/services/agent.ts` y su test nuevo. *Referencia: WKH-366 auto-blindaje, 2026-08-26 10:07.*
- **CD-19** ⛔ **Toda pregunta de igualdad de archivos va con ruta absoluta al binario.** 229 W1: `diff` bajo el hook contestó **"✅ Files are identical"** sobre archivos que difieren en 2 líneas — *afirmó lo que el autor esperaba oír*. Ya estaban documentados `cat`, `grep`, `git diff` y `git log`. **En esta HU: `/usr/bin/grep -rn`, `/usr/bin/diff`, `/usr/bin/git diff`, `/usr/bin/sed -n`. ⛔ nunca `cat`.** *Referencia: WKH-366 auto-blindaje, 2026-08-26 10:14.*
- **CD-20** ⛔ **Las mutaciones de AC-10 se restauran con `cp` desde una copia hecha ANTES, nunca con `git checkout --`**, y en un **subdirectorio propio del scratchpad**. 230 §1 y §3 E-4 lo dejan escrito tras haber perdido lo que medía. Y las citas de la tabla de mutaciones llevan **el commit del árbol en que se midieron** — 230 lo advierte porque su propio fix-pack movió todas las líneas. *Referencia: WKH-369 auto-blindaje §1, §3.*
- **CD-21** ⛔ **PROHIBIDO un fixture que pase con el bug puesto.** CD-1 de WKH-369 fue exactamente eso: un fixture con capacidades vacías que daba verde con el defecto presente. Acá el equivalente exacto es **un fixture de manifiesto sin `inputSchema`**: haría pasar tanto al comparador correcto como a uno que no compara nada. Todo fixture positivo lleva contenido que **sólo** un comparador que funciona puede satisfacer.

---

## 7. Waves de implementación

### W0 — Serial gate (nada empieza sin esto)

| # | Tarea | Archivos |
|---|---|---|
| W0.1 | Rama `feat/231-…` desde `main` @ `a9087e4`. Correr el gate completo **en orden** y anotar la línea base en `auto-blindaje.md`. Debe coincidir con §0; si no coincide, **parar** | — |
| W0.2 | Crear el subdirectorio propio del scratchpad para backups de mutación (CD-20) | — |
| W0.3 | **El contrato puro**: constantes (`BASE_URL`, `SELF_PUBLISHED`, `MANIFEST_SUFFIX`), las 7 clases con sus exit codes, `verdict()`, `canonicalJson`/`schemaFingerprint` (copiados de `probe-money-path.mjs:201-212`), `deriveManifestUrl()`, `readCredential()`, `classify()` con la escalera de §5. **Sin una sola línea de red** | `scripts/check-catalog-vs-live.mjs` (parte pura) |
| W0.4 | La suite de la escalera: fila por fila, mensajes distinguibles, default ≠ CONFORME | `test/check-catalog-vs-live.test.mjs` |

### W1 — Paralelizable (2 carriles independientes)

**Carril A — la red y el comparador**

| # | Tarea | Archivos |
|---|---|---|
| W1.A1 | `request()` con timeout + retry sólo en errores de conexión (patrón `probe-money-path.mjs:351-374`) | `scripts/check-catalog-vs-live.mjs` |
| W1.A2 | `derivarUniverso(agents)` → `{elegibles, excluidos:[{slug,motivo}]}` por `registry === 'self-published'` | idem |
| W1.A3 | `compararAgente(fila, manifiesto)` → los 5 campos de DT-6, con CD-1 y CD-12 | idem |
| W1.A4 | `evaluarCompletitud(fila, record?)` → los 4 campos de AC-2, con la nota de CD-17 | idem |
| W1.A5 | `main(env)` exportada, con los dos modos, que **devuelve** el exit code; `emit()`; auto-run condicional (`:452-463`) | idem |
| W1.A6 | Tests de W1.A con `fetch` doblado (cero red) + fixtures literales fechados 2026-08-27 | `test/check-catalog-vs-live.test.mjs` |

**Carril B — el booleano (DT-3 / 3b)**

| # | Tarea | Archivos |
|---|---|---|
| W1.B1 | `hasPayoutWallet: boolean` en `PublishedAgentRecord` (`:71-90`), con docblock que declara **quién lo lee** y **por qué no viola CD-5** | `src/services/agent.ts` |
| W1.B2 | Asignarlo en `mapRowToRecord` (`:174-198`): `row.payout_wallet !== null && row.payout_wallet.trim() !== ''`. ⛔ **No tocar `mapRowToAgent`** | idem |
| W1.B3 | Test: el booleano es `false` con `null` **y** con `'   '`; es `true` con valor; **y el objeto de `mapRowToAgent` NO lo contiene** (control negativo: que no se filtró a `/discover`) | `src/services/agent.completeness.test.ts` |
| W1.B4 | `npm run lint` inmediatamente después de W1.B (CD-18: biome mira estos dos archivos, y sólo estos) | — |

### W2 — El workflow (depende de W1.A5)

| # | Tarea | Archivos |
|---|---|---|
| W2.1 | Los 2 jobs **sin `needs:`**, `permissions: {contents: read, issues: write}`, `cron: '23 6 * * *'`, `workflow_dispatch`, `pull_request` con `paths:` a los 3 archivos del chequeo | `.github/workflows/check-catalog-vs-live.yml` |
| W2.2 | Job `deriva`: cero secretos; `continue-on-error: ${{ github.event_name == 'pull_request' }}` | idem |
| W2.3 | Job `completitud`: `if: github.event_name != 'pull_request'`; `A2A_CATALOG_OWNER_KEY` **una sola vez** | idem |
| W2.4 | Abrir/comentar/cerrar por título exacto, **dos títulos distintos**, pegando la línea de clase vía `env:` (patrón `probe-money-path.yml:112-178`) | idem |
| W2.5 | Los 2 npm scripts, **al final** del bloque (CD-14) | `package.json` |
| W2.6 | Documentar `A2A_CATALOG_OWNER_KEY` y `CHECK_MODE` | `.env.example` |
| W2.7 | Afirmaciones sobre el YAML **real** (T-Y1..T-Y6) | `test/check-catalog-vs-live.test.mjs` |

### W3 — Falsabilidad y arrastre (depende de W0..W2)

| # | Tarea | Archivos |
|---|---|---|
| W3.1 | **AC-10**: romper a propósito la mitad de **deriva** y la de **completitud**, una mutación por vez, y anotar el rojo **literal con su motivo**. Restaurar con `cp` (CD-20) | `doc/sdd/231-…/auto-blindaje.md` |
| W3.2 | **Controles positivos** de cada rojo: que el chequeo **efectivamente ejecutó** (`comparados > 0`). Un chequeo que sólo verifica una ausencia pasa igual cuando no ejecutó nada | `test/check-catalog-vs-live.test.mjs` |
| W3.3 | **CD-13**: corregir a mano los 3 números de línea de `src/services/agent.ts` (399, 808, 822 → los nuevos), **leyendo cada línea** | `test/cited-lines-guard.citations.ts` |
| W3.4 | `git add -A` **ANTES** del gate, y recién ahí actualizar los números de los dos README (§9) | `README.md`, `README.es.md` |

### W4 — Cierre (serial)

| # | Tarea |
|---|---|
| W4.1 | `git add -A` |
| W4.2 | `npx tsc -p tsconfig.json --noEmit` → `npm run lint` → `npm test`, **los tres, en ese orden, una vez** |
| W4.3 | Contrastar contra la línea base de §0: `318 → 320` archivos de test; `519 → 520` de biome; el conteo de tests sube |

---

## 8. Plan de tests — al menos uno por AC

⚠️ **Ningún test de esta HU abre un socket ni gasta un centavo.** Funciones puras importadas; `main()` con `fetch` doblado; afirmaciones sobre los archivos reales del repo. Patrón de `test/probe-money-path.test.mjs:1-15`.

| ID | AC / CD | Qué cubre | Archivo | Cómo se lo rompe a propósito (AC-10) |
|---|---|---|---|---|
| **T-D1** | AC-1 | Con huellas distintas en `inputSchema` → **DERIVA(4)** nombrando slug, campo y **las dos** huellas | `test/check-catalog-vs-live.test.mjs` | Devolver la huella del catálogo en las dos ⇒ CONFORME falso |
| **T-D2** | AC-1 · DT-6 | Los 5 campos comparables producen deriva **cada uno por separado** (5 casos) | idem | Sacar un campo del comparador ⇒ ese caso pasa a CONFORME |
| **T-D3** | AC-1 · **CD-21** | El fixture positivo tiene `inputSchema` **con contenido**: un comparador que no compara nada **no** lo satisface | idem | Vaciar el fixture ⇒ el test pasa con el bug puesto |
| **T-C1** | AC-2 | Completitud y deriva son **independientes**: el mismo agente conforme en deriva puede salir INCOMPLETA | idem | Encadenar las dos mitades ⇒ la incompleta se reporta conforme |
| **T-C2** | **AC-3 (la tesis)** | Fila con `hasPayoutWallet: false` y deriva **cero** → **INCOMPLETA(5)**, ⛔ nunca CONFORME(0) | idem | Poner la fila 10 después de la 13 en la escalera |
| **T-C3** | AC-3 | Fila con `metadata` vacío (sin `inputSchema` ni `outputSchema`) → INCOMPLETA aunque no haya nada que comparar | idem | idem |
| **T-C4** | **CD-17** | `owner_ref: '   '` → INCOMPLETA; y el docblock **declara** que `owner_ref: null` es imposible por tipo | idem | — (el test documenta un límite, no lo esconde) |
| **T-V1** | **AC-4** | `comparados === 0` con todo lo demás conforme → **CONFIG(3)**, ⛔ nunca 0. La anti-vacuidad | idem | Sacar la fila 7 ⇒ un chequeo que no ejecutó nada sale verde |
| **T-V2** | AC-4 · CD-7 | **Control positivo**: en el caso feliz, la línea emitida lleva `comparados > 0`. Un rojo sin este control no prueba que el chequeo corrió | idem | — |
| **T-U1** | **AC-5** | Los 24 federados salen en `EXCLUIDOS:` **con motivo no vacío**, uno por uno | idem | Filtrar sin registrar ⇒ exclusión silenciosa |
| **T-U2** | AC-5 · CD-3 | `elegibles === 0` → CONFIG(3), ⛔ nunca CONFORME | idem | Sacar la fila 3 |
| **T-J1** | **AC-6** | `manifest.slug !== catalogo.slug` → **UNRESOLVED(6)** y ⛔ **no se comparan los schemas** | idem | Ignorar la autodeclaración ⇒ compara el agente equivocado |
| **T-J2** | AC-6 · **CD-2** | Los 2 casos reales `pathSlug ≠ slug` resuelven bien; un `invokeUrl` que no termina en `/invoke` → UNRESOLVED, **no** una URL adivinada | idem | Asumir `slug == pathSlug` ⇒ 404 leído como deriva |
| **T-Z1** | **AC-7 · CD-1** | Fixture con los 5 publicando `inputSchema` **en la raíz** y nada en `metadata` → **CONFIG(3)**, ⛔ **NO** "5 derivas". El cero uniforme acusa al instrumento | idem | Mirar la raíz ⇒ "0 de 29 publican schema", falso |
| **T-Z2** | **CD-12** | Fixture con `payment` derivado en la raíz (con `resolvedChain`) y `metadata.payment` igual al manifiesto → CONFORME. Comparar la raíz da deriva **fabricada** | idem | Comparar `agent.payment` en vez de `agent.metadata.payment` |
| **T-E1** | **AC-8** | Las 7 clases tienen exit codes **distintos** y ningún mensaje usa la palabra clave de otra clase (patrón `probe-money-path.test.mjs:283`) | idem | Reusar un código ⇒ el exit deja de atribuir |
| **T-E2** | AC-8 · DT-5 | `CHECK_MODE` ausente / basura → CONFIG(3). El default **nunca** corre "algo" | idem | Poner un default ⇒ un typo mide otra cosa en silencio |
| **T-E3** | AC-8 | El **default de la escalera** (fila 14) no es CONFORME: un `obs` que no matchea nada sale ruidoso | idem | Cambiar la fila 14 a CONFORME |
| **T-E4** | AC-8 · CD-15 | Modo completitud sin credencial → CONFIG(3) **nombrando `A2A_CATALOG_OWNER_KEY`**; y `sinDato > 0` parcial → CONFIG(3), ⛔ nunca 0 | idem | Sacar la fila 12 ⇒ se afirma conforme lo que no se midió |
| **T-Y1** | **AC-9** | El YAML tiene **2 jobs** y **ningún `needs:`** entre ellos (sobre el YAML sin comentarios) | idem | Agregar `needs:` ⇒ un fallo de completitud apaga la deriva |
| **T-Y2** | AC-9 | Los dos jobs tienen su par abrir/cerrar, con el **mismo** título dentro de cada par | idem | Cambiar uno ⇒ el aviso nunca se cierra |
| **T-Y3** | AC-9 · DT-1 | Si el job de completitud falla, el de deriva igual corre — verificado por la **ausencia de `needs:`** y por `if:` que no dependen del otro job | idem | — |
| **T-Y4** | **CD-6** | Los **4** títulos del repo (2 nuevos + `probe-money-path.yml:116` + `smoke-downstream.yml:56`) son **los 4 distintos**, leídos de los archivos reales | idem | Reusar un título ⇒ un chequeo cierra el aviso del otro |
| **T-Y5** | DT-3 mit.1 | `A2A_CATALOG_OWNER_KEY` aparece **exactamente una vez** en el YAML, y en el step del job `completitud` | idem | Filtrarlo al job `deriva` ⇒ la credencial viaja de más |
| **T-Y6** | DT-3 mit.2 | El job `completitud` lleva `if: github.event_name != 'pull_request'` | idem | Sacarlo ⇒ la credencial llega a corridas de PR |
| **T-S1** | **CD-11** | El fuente **sin comentarios** no contiene `POST`/`PATCH`/`DELETE`/`/compose`, y todo `method:` es `GET` | idem | Un método que muta ⇒ el vigilante deja de observar |
| **T-S2** | **CD-5** | La función que emite no menciona ninguna variable de credencial ni de wallet (patrón `probe-money-path.test.mjs:514-529`) | idem | Loguear el row entero ⇒ el valor llega a un issue público |
| **T-S3** | CD-8 | El fuente no construye ninguna URL `/discover/<slug>`: sólo la lista | idem | Iterar el detalle ⇒ 429 y hasta 201 queries por agente |
| **T-S4** | CD-14 | El nombre de los npm scripts no empieza por `test`, y `package.json` línea 11 sigue siendo `"lint": "biome check src/"` | idem | Insertar arriba ⇒ rompe el test que la clava |
| **T-B1** | AC-2 · W1.B | `hasPayoutWallet` es `false` con `null` y con `'   '`, `true` con valor | `src/services/agent.completeness.test.ts` | Usar `!!row.payout_wallet` ⇒ `'   '` cuenta como completa |
| **T-B2** | **CD-9 / DT-3** | **Control negativo**: el objeto que produce `mapRowToAgent` (el de `/discover`) **no** contiene `hasPayoutWallet`. La HU no agrega superficie pública anónima | idem | Ponerlo en el mapper equivocado ⇒ se publica a todo el mundo |

**Total: 30 tests**, ≥1 por AC (AC-1: T-D1..T-D3 · AC-2: T-C1,T-C4,T-B1 · AC-3: T-C2,T-C3 · AC-4: T-V1,T-V2 · AC-5: T-U1,T-U2 · AC-6: T-J1,T-J2 · AC-7: T-Z1 · AC-8: T-E1..T-E4 · AC-9: T-Y1..T-Y3 · **AC-10: se satisface por la última columna entera + W3.1/W3.2**).

---

## 9. Presupuesto de escala (el CR lo contrasta — regla 10 de `CLAUDE.md`)

Referencias reales del repo: `probe-money-path.mjs` = **463** líneas, su suite = **581**, su workflow = **178**, `smoke-downstream.yml` = **94** `[MEDIDO-F2]`.

| Archivo | Acción | Presupuesto |
|---|---|---|
| `scripts/check-catalog-vs-live.mjs` | Crear | **≤ 360** |
| `test/check-catalog-vs-live.test.mjs` | Crear | **≤ 460** |
| `.github/workflows/check-catalog-vs-live.yml` | Crear | **≤ 150** (2 jobs) |
| `src/services/agent.ts` | Modificar | **≤ 16** (interfaz + mapper + docblock) |
| `src/services/agent.completeness.test.ts` | Crear | **≤ 80** |
| `test/cited-lines-guard.citations.ts` | Modificar | **≤ 6** (3 números) |
| `package.json` | Modificar | **+2** |
| `.env.example` | Modificar | **≤ 6** |
| `README.md` / `README.es.md` | Modificar | **≤ 4** (2 números c/u) |
| **TOTAL fuera de `doc/`** | | **≈ 1.040 líneas · techo 1.100** |

`doc/sdd/231-…/` (sdd, story-file, auto-blindaje, cr-report, qa-report) queda **fuera del presupuesto**, como en las HUs previas.

**La pregunta que decide (regla 10)**: *¿qué parte de esto seguiría existiendo si lo escribiera alguien que ya conoce esta librería?* Respuesta honesta: casi todo lo de `scripts/` y `.github/` es **estructura obligada por el arte previo del repo** (escalera, emit, aviso abrir/cerrar), y la mitad de la suite existe por CD-7 (romperlo a propósito). **Si el diff supera 2.200 líneas fuera de `doc/`, se justifica por escrito o se recorta.** El primer candidato a recortar, si hay que recortar: los 5 campos de DT-6 bajan a 2 (`inputSchema` + `payment`), que son los que tocan dinero.

---

## 10. Missing Inputs — estado

| # | Qué faltaba | Estado tras F2 |
|---|---|---|
| **MI-1** | El issue #186 y sus comentarios | ✅ **Cerrado por el orquestador**: su medición está íntegra en el encargo y en el work-item. No quedó nada por contrastar |
| **MI-2** | Ruta y forma del manifiesto | ✅ **CERRADO, MEDIDO** — §3.4. `invokeUrl` con `/invoke`→`/manifest`, 200 en 5/5, `inputSchema` en la raíz, `outputSchema` ausente 0/5, autodeclaración `slug` correcta 5/5 |
| **MI-3** | Cuál de las tres credenciales | ✅ **CERRADO: 3b**, con razón escrita y 5 mitigaciones (DT-3). 3c medida **no factible** en esta HU |
| **MI-4** | Los 5 slugs y cuáles tienen `pathSlug ≠ slug` | ✅ **CERRADO, MEDIDO** — §3.3. Son 2: `remit-corridor-fx-solana` y `remit-cashout-payout-solana` |
| **MI-5** | El conteo 29/24/5 | ✅ **CERRADO**: hoy es 29/24/5, y **se deriva, no se hardcodea** (CD-16) |
| **MI-6** | Si `getSplitContextRow` lee `payout_chain` | ✅ **CERRADO: NO.** Selecciona exactamente `owner_ref, payout_wallet, referrer_ref` (`agent.ts:373`) y devuelve esos tres (`:382-388`) |
| **MI-7** | La rama actual | ✅ **CERRADO**: `main` @ `a9087e4` |
| **MI-8** | 🆕 **Crear el secreto `A2A_CATALOG_OWNER_KEY`** (agent key del owner de los 5, alta por el founder) | 🟠 **Acción del founder. NO bloquea el merge**: sin él, el job `completitud` sale CONFIG(3) nombrándolo y `deriva` corre igual. Mismo perfil que `A2A_PROBE_KEY` en WKH-364 |

---

## 11. Riesgos — incluido el que el gate humano tiene que aceptar

| # | Riesgo | P | I | Mitigación |
|---|---|---|---|---|
| **R-1** | 🔴 **El chequeo NACE EN ROJO.** Medido hoy: `remit-kyc-session` y `remit-kyc-decision` **no tienen `metadata.outputSchema`** ⇒ AC-2 las clasifica **INCOMPLETA(5)** desde la primera corrida | **Alta** | Media | **Es el comportamiento correcto y es la prueba viva de la tesis** (AC-3 tiene una instancia real, hoy, con datos públicos). Pero "corregir filas" es **Scope OUT** ⇒ el rojo persiste hasta que alguien complete esas 2 filas, y **un control crónicamente rojo entrena a ignorarlo**. **⚠️ Decisión del gate humano**: (a) aceptar el rojo y abrir una HU de seguimiento de 1 PATCH para completarlas, o (b) autorizar excepcionalmente completarlas dentro de esta HU. **No la tomo yo** |
| **R-2** | La credencial de completitud tiene poder de borrado sobre el catálogo (no existe key de sólo lectura — medido) | Baja | **Alta** | Las 5 mitigaciones de DT-3, los tests T-Y5/T-Y6, y `TD-370-KEY-SOLO-LECTURA` escrito en el workflow |
| **R-3** | Un manifiesto lento o un 429 pone el chequeo rojo sin que haya defecto | Media | Baja | Clase **INALCANZABLE(2)**, distinta de DERIVA(4); timeout generoso y retry sólo en errores de conexión (`probe-money-path.mjs:351-354`) |
| **R-4** | La inserción en `src/services/agent.ts` rompe `cited-lines-guard` | **Alta (esperada)** | Baja | **CD-13 + W3.3.** Es el guardián funcionando; se corrige a mano leyendo cada línea |
| **R-5** | `readme-numbers` da **verde en falso** con archivos untracked | Media | Media | **`git add -A` ANTES del gate** (W3.4/W4.1). `test/readme-numbers.test.ts:82-90` enumera con `git ls-files`, contra el ÍNDICE. Pasó en WKH-369 |
| **R-6** | Los 4 títulos de issue del repo colisionan | Baja | Media | **T-Y4** los lee de los archivos reales y exige los 4 distintos |
| **R-7** | Conflicto de merge en `doc/sdd/_INDEX.md` | Media | Baja | Trivial: una fila al final. La 231 ya está pegada (`_INDEX.md:223`) |

---

## 12. Dependencias

- Nada bloquea el arranque. `A2A_CATALOG_OWNER_KEY` (MI-8) es acción del founder y **no bloquea el merge**.
- Dependencia **blanda** con WKH-369 (fila 230, desplegada): cambió el costo y el rate-limit de `GET /discover/:slug`, de donde sale CD-8. **Toda medición de `/discover` anterior al 2026-08-27 ya no vale**; las de este SDD son de hoy.

## 13. Uncertainty Markers

| Marker | Sección | Descripción | ¿Bloqueante? |
|---|---|---|---|
| ⚠️ **Decisión del humano** | §11 R-1 | El chequeo nace rojo por 2 filas sin `outputSchema`. Opción (a) aceptar + HU de seguimiento, u (b) autorizar completarlas acá | **Sí, para SPEC_APPROVED** |
| ⚠️ **A atacar en AR** | §DT-3 | La elección 3b y su credencial con poder de escritura. La alternativa (diferir `payout_wallet`) está especificada y lista | No para F2.5 |

⛔ **No hay ningún `[NEEDS CLARIFICATION]` abierto.** Los dos markers de arriba son **decisiones**, no ambigüedades: las dos ramas están especificadas y cualquiera de las dos es implementable sin volver a F2.

---

## 14. Readiness Check

```
[x] Cada AC tiene al menos 1 archivo asociado y ≥1 test  ...........  §8, 30 tests, AC-1..AC-10
[x] Cada archivo tiene un Exemplar VERIFICADO que existe  ...........  §3.2, existencia confirmada hoy
[x] No hay [NEEDS CLARIFICATION] pendientes  ........................  §13
[x] Constraint Directives con al menos 3 PROHIBIDO  .................  §6, 21 CDs (11 heredados + 10 nuevos)
[x] Context Map con al menos 2 archivos leídos  .....................  §3.1, 20 archivos
[x] Scope IN y OUT explícitos y no ambiguos  ........................  §2
[x] Si hay BD: tablas verificadas que existen  ......................  `a2a_agents`, `database.types.ts:52-96`. ⛔ Sin cambios de esquema
[x] Flujo principal completo  .......................................  §4 DT-5/DT-7 + §5 escalera
[x] Flujo de error definido  ........................................  §5, 7 clases, 6 códigos de salida
[x] MI del F1 cerrados  .............................................  §10, MI-1..MI-7 cerrados; MI-8 nuevo, no bloqueante
[x] Auto-Blindaje histórico leído y convertido en CD  ...............  §6.3, CD-18..CD-21 (229 y 230)
[x] Presupuesto de escala declarado  ................................  §9, ≈1.040 líneas, techo 1.100
[x] Línea base del gate medida, COMPLETA y en orden  ................  §0
[x] Las clases de salida son distinguibles entre sí  ................  §5, 4 clases distintas de "no-verde-no-hallazgo"
```

**Veredicto: LISTO para SPEC_APPROVED**, con una condición: el humano tiene que resolver **R-1** (el chequeo nace rojo) al aprobar. Las dos ramas están especificadas; ninguna exige volver a F2.

---

*SDD generado por NexusAgil — FULL · nexus-architect · 2026-08-27*
