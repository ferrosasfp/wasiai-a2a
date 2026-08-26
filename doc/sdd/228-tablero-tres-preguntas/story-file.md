# Story File — [WKH-365] Tablero de las tres preguntas (HU 228)

Contrato autocontenido para el Dev. **Todo lo que necesitás está acá.** No hace falta abrir el SDD.
Worktree: `/home/ferdev/.openclaw/workspace/a2a-tablero` · rama `feat/228-tablero-tres-preguntas` (ya checked out).
Gate del repo: `npx tsc -p tsconfig.json --noEmit` → `npm run lint` → `npm test`. ⛔ **`npm run qa` NO EXISTE acá** (verificado en `package.json`: los scripts son `dev/build/start/lint/format/test/test:coverage/smoke:downstream/migrate:preflight/probe:money-path`).

---

## 1. Qué se construye, en una pantalla

Un tablero **de solo lectura** que contesta tres preguntas que hoy exigen trabajo manual:

1. **La caja de la sonda** — cuánto saldo le queda a la key que usa la sonda del money-path (`budget`, `daily_spent_usd`, `daily_limit_usd`).
2. **La reputación** — qué standing tiene cada agente con actividad reciente.
3. **Los escrows** — cuánta plata sigue trabada en escrows de Solana devnet.

⛔ **La sonda COMPRA; el tablero LEE.** Si el tablero cotiza, duplica el gasto y puede dar verde cuando la sonda da rojo. Cero `POST /compose`, cero `/orchestrate`, cero transacciones, cero firmas.

⚠️ **"No sé" ≠ "está bien".** Un tablero que sale verde porque no pudo leer una fuente es peor que no tener tablero. El `ok` tiene que ser **inconstruible sin los datos** — lo impide el tipo, no la disciplina.

---

## 2. Scope IN — la lista exhaustiva de archivos

| # | Archivo | Nuevo/Editado | Wave |
|---|---|---|---|
| 1 | `src/types/index.ts` | editado (+~55 al final) | W0 |
| 2 | `.env.example` | editado (+~30) | W0 |
| 3 | `src/adapters/solana/escrow-scan.ts` | **nuevo** | W1a |
| 4 | `src/adapters/solana/escrow-scan.test.ts` | **nuevo** | W1a |
| 5 | `src/services/tablero.ts` | **nuevo** | W1b |
| 6 | `src/services/tablero.test.ts` | **nuevo** | W1b |
| 7 | `src/static/dashboard-tres-preguntas.html` | **nuevo** | W1c |
| 8 | `src/static/dashboard-tres-preguntas.render.test.ts` | **nuevo** | W1c |
| 9 | `src/routes/dashboard.ts` | editado (+~70) | W2 |
| 10 | `src/routes/dashboard.tablero.test.ts` | **nuevo** | W2 |
| 11 | `README.md` | editado (3 números) | W3 |
| 12 | `README.es.md` | editado (los mismos 3 números) | W3 |
| 13 | `doc/sdd/228-tablero-tres-preguntas/auto-blindaje.md` | **nuevo** | W3 |

**Los ítems 11-12 son obligatorios y el SDD (CD-9) decía lo contrario — se corrige acá con evidencia.** Ver §8.

### Scope OUT (no tocar, ninguno)
`src/services/reputation.ts` · `scripts/probe-money-path.mjs` · `.github/workflows/probe-money-path.yml` · `test/ownership-filter-guard.exceptions.ts` · `test/ownership-filter-guard.test.ts` · `src/index.ts` (el plugin ya está registrado con prefijo `/dashboard`) · `doc/sdd/_INDEX.md` (la fila `228` ya existe) · cualquier repo vecino (`chaski-v3`, `wasiai-facilitator`, `wasiai-remittance-agents`, `solana-programs`) · variables en Railway (son del founder).

---

## 3. Anti-Hallucination Checklist (marcá cada una antes de escribir código)

- [ ] **AH-1** — El plugin de dashboard ya está montado: `src/index.ts:381` hace `register(dashboardRoutes, { prefix: '/dashboard' })`. **NO crees un plugin de rutas nuevo**: `src/routes/charged-routes.meta.test.ts:304` (T-META-06) exige que el guard escanee exactamente los plugins que la app registra.
- [ ] **AH-2** — El guard que se reusa se llama **`requireAdminTokenForTrace`** y vive en `src/routes/dashboard.ts:314-331`. **NO** uses `requireAdminToken` (ese es el opt-in grandfathered de `/api/stats`, deja la superficie abierta cuando `NODE_ENV !== 'production'`).
- [ ] **AH-3** — El cliente de Supabase se importa `import { supabase } from '../lib/supabase.js';` (así lo hace `src/services/reputation.ts`). Extensión `.js` obligatoria en todos los imports relativos (ESM).
- [ ] **AH-4** — `computeStandingBatch(slugs: string[]): Promise<AgentStandingBatch>` existe en `src/services/reputation.ts:336`; el tipo `AgentStandingBatch { degraded: boolean; standings: Map<string, AgentStandingCounters> }` está en `src/types/index.ts:542-545`. **No lo modifiques, no lo dupliques.**
- [ ] **AH-5** — `base58Encode(bytes: Uint8Array): string` está en `src/adapters/solana/base58.ts:27`. Es el que codifica el `memcmp`.
- [ ] **AH-6** — `getSolanaRpcUrl()` (`chain.ts:39-41`), `getSolanaCommitment()` (`:43-46`), `getSolanaUsdcMint()` (`:48-50`), `getSolanaUsdcDecimals()` (`:52-59`) ya existen. `getSolanaConnection()` (`:73-78`) existe **y acá NO se usa** (CD-7).
- [ ] **AH-7** — `a2a_events` **no tiene** columna `owner_ref` (`src/types/database.types.ts:326-340`: `agent_id, agent_name, cost_usdc, created_at, event_type, goal, id, latency_ms, metadata, registry, status, tx_hash`). Por eso leerla es neutral para el guardián de ownership.
- [ ] **AH-8** — `a2a_agent_keys` **sí** tiene `owner_ref`, así que el filtro es OBLIGATORIO (§5.1). Si lo omitís, `test/ownership-filter-guard.test.ts` se pone rojo y estarías escribiendo un IDOR.
- [ ] **AH-9** — Los tests nuevos matchean el `include` de `vitest.config.ts:5` (`['src/**/*.test.ts','test/**/*.test.ts','test/**/*.test.mjs']`). `passWithNoTests: false`.
- [ ] **AH-10** — `npm run build` copia `src/static/.` → `dist/static/`, así que el HTML nuevo se sirve en prod sin tocar el build.
- [ ] **AH-11** — TypeScript **strict, sin `any` explícito**. Sin hardcodes de URLs/keys; todo por env con default documentado.
- [ ] **AH-12** — Todo lo que se consulte en base va contra **bdwv**. ⛔ `caldz` es MAINNET y está **PROHIBIDA**.

---

## 4. Waves

### W0 — serial (contratos; nadie arranca antes)

**`src/types/index.ts`** — al final del archivo, ~55 líneas:

```ts
export type SinDatoReason =
  | 'no_configurado' | 'no_encontrada' | 'error_db'          // caja
  | 'historial_ilegible'                                      // reputación
  | 'rpc_no_configurado' | 'rpc_error' | 'respuesta_invalida'; // escrows
```

Y las tres tarjetas + el snapshot, **como uniones discriminadas**:

```ts
type Card<T> = ({ status: 'ok' } & T) | { status: 'sin_dato'; reason: SinDatoReason };
```

- `TableroCajaCard` — el `ok` lleva `budget`, `daily_limit_usd`, `daily_spent_usd`, `daily_reset_at`, `is_active`.
- `TableroReputacionCard` — el `ok` lleva `agentes: Array<{ slug; tasksSettled; successCount; failedCount }>` y la etiqueta de ventana.
- `TableroEscrowsCard` — el `ok` lleva `escrows_vivos`, `usdc_bloqueado` (string formateado), `otros_mints_count`, `vencidos: number | null`, y el motivo cuando `vencidos` es `null`.
- `TableroSnapshot` — `{ generatedAt: string; caja: TableroCajaCard; reputacion: TableroReputacionCard; escrows: TableroEscrowsCard }`.

⛔ **`TableroSnapshot` NO tiene ningún campo agregado de salud en la raíz** — ni `healthy`, ni `ok`, ni `status` global, ni semáforo. Un agregado necesita una regla para "las tres sin dato", y la lección de la HU 227 es que esa regla se escribe mal (el DEFAULT de una escalera de monitoreo era PASS). **No lo agregues "para que quede lindo".**

**`.env.example`** — documentar con el patrón de bloque que ya usa el archivo:
- `A2A_PROBE_KEY_ID` (UUID de la key de la sonda; **no es secreto**)
- `A2A_PROBE_KEY_OWNER_REF` (owner de esa key; **no es secreto**)
- `SOLANA_ESCROW_PROGRAM_ID` — default documentado `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x`
- una línea aclarando que `DASHBOARD_ADMIN_TOKEN` gatea también esta pantalla.

⚠️ Cada `VAR=` que agregues suma al conteo que los README publican (§8).

### W1 — paralelizable (tres frentes que no se pisan)

| # | Archivos | Qué |
|---|---|---|
| W1a | `src/adapters/solana/escrow-scan.ts` + `.test.ts` | `scanEscrows(): Promise<TableroEscrowsCard>` — §5.3. Cero Supabase. |
| W1b | `src/services/tablero.ts` + `.test.ts` | `tableroService.snapshot()`: `Promise.allSettled` de las tres. `leerCajaDeLaSonda()` (§5.1) y `leerReputacion()` (§5.2) viven acá; importa `scanEscrows` de W1a (mockeable). |
| W1c | `src/static/dashboard-tres-preguntas.html` + `.render.test.ts` | Shell HTML — §5.5. |

### W2 — serial (cablea W1 y sólo eso)

`src/routes/dashboard.ts`:
- `readFileSync` del HTML nuevo **al arranque**, junto a `traceHtml` (`dashboard.ts:350-353`).
- `fastify.get('/tres-preguntas', { config: { rateLimit: false } }, …)` → sirve el HTML público **sin datos**. Patrón exacto: `dashboard.ts:374-382` (la ruta `/trace`).
- `fastify.get('/api/tres-preguntas', { config: { rateLimit: false }, preHandler: requireAdminTokenForTrace }, …)`. Patrón exacto: `dashboard.ts:390-410`, incluido el `catch` que loguea el detalle server-side y devuelve un mensaje estático al cliente.
- El cache por tarjeta de §5.4, en el closure del plugin (patrón `dashboard.ts:419-421`).
- `src/routes/dashboard.tablero.test.ts` — patrón de mocks totales de `src/routes/dashboard.trace.test.ts:13-70`.

### W3 — cierre (§8)

`README.md` + `README.es.md` (los 3 números) y `doc/sdd/228-tablero-tres-preguntas/auto-blindaje.md`.

---

## 5. Los patrones, con line ranges verificados

### 5.1 La caja: se lee EN PROCESO, no por HTTP

⛔ **NO te llames a vos mismo por HTTP** a `GET /auth/me`. Se lee la fila directo:

```ts
const { data, error } = await supabase
  .from('a2a_agent_keys')
  .select('budget, daily_limit_usd, daily_spent_usd, daily_reset_at, is_active')
  .eq('id', process.env.A2A_PROBE_KEY_ID)
  .eq('owner_ref', process.env.A2A_PROBE_KEY_OWNER_REF)
  .single();
```

**Exemplar del patrón obligatorio**: `src/services/budget.ts:94-116` (`getBalance`) — `.eq('id', keyId).eq('owner_ref', ownerId).single()` + `error.code === 'PGRST116'` como el caso de ownership.

**Por qué NO por HTTP, y va escrito en el docblock:** sin `A2A_PROBE_KEY` (una credencial de GASTO) en el proceso, *"el tablero no gasta"* deja de ser una promesa que sostiene la revisión de código y pasa a ser una **capacidad ausente del entorno** — el tablero no puede gastar aunque alguien escriba el código.

⛔ **El filtro por `owner_ref` es OBLIGATORIO** (regla de seguridad del `CLAUDE.md`) y así el guardián de ownership queda verde **sin agregar ninguna excepción**. El par id+owner además se auto-chequea: si no casan, PostgREST devuelve `PGRST116` (0 filas) → `sin_dato:no_encontrada`, **nunca el saldo de otro dueño**.

**Estados de la tarjeta 1:**
- `ok` — la fila se leyó.
- `sin_dato:no_configurado` — falta alguna de las dos env.
- `sin_dato:no_encontrada` — `PGRST116`.
- `sin_dato:error_db` — cualquier otro error.
- `is_active: false` **NO es `sin_dato`**: es un dato, se muestra como advertencia. Una key desactivada con saldo es información, no ausencia.

⛔ **El `select` no pide `id` ni `key_hash`.** La prohibición de exponer `key_id`/`key_id_hash` se cumple **en la query**, no en el serializador.

### 5.2 Reputación: cero lógica nueva

Reusa `reputationService.computeStandingBatch` (`src/services/reputation.ts:336`), que **ya distingue** `degraded: true` — *"no pude preguntar por el historial"*, documentado en `reputation.ts:261-270` — de "cero historial". **Ése ES el "sin dato": no inventes otro.**

Universo de slugs, derivado de `a2a_events` (no de `/discover`, que puede salir a registries remotos):

```ts
.from('a2a_events').select('agent_id')
  .gte('created_at', <ahora - 30d>)
  .order('created_at', { ascending: false })
  .limit(1000)
```
→ dedupe en JS → **tope de 50 slugs** → `computeStandingBatch(slugs)`.

**Tres estados, y los tres son distintos:**
- error de esta query **o** `degraded: true` → `sin_dato:historial_ilegible`;
- `degraded: false` con 0 slugs → **`ok` con `agentes: []`** y la etiqueta "sin actividad en la ventana" (es una respuesta, no una ausencia);
- `degraded: false` con slugs → `ok` con la lista.

Campos por agente, de `AgentStandingCounters` (`src/types/index.ts:501-505`): `tasksSettled`, `successCount`, `failedCount`.

### 5.3 Escrows: `getProgramAccounts` + el reloj del cluster

**Program id**: `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x`, env `SOLANA_ESCROW_PROGRAM_ID` con ese default documentado (patrón `chain.ts:20-27` + `:39-41`).

**Layout de `EscrowState`** (offsets desde el byte 0 de la cuenta):

| offset | bytes | campo |
|---|---|---|
| 0 | 8 | discriminador Anchor |
| 8 | 32 | `sender` |
| 40 | 32 | `beneficiary` |
| 72 | 32 | `authority` |
| 104 | 32 | `mint` |
| 136 | 8 | `amount` (u64 **LE**) |
| 144 | 8 | `deadline` (i64 **LE**, unix ts) |
| 152 | 1 | `status` — `0 Deposited · 1 Released · 2 Refunded` |
| 153 | 1 | `bump` |

**Total: 154 bytes.**

**Discriminador**: `[19,90,148,111,55,130,229,108]` — va **como constante nombrada, con un test que la recomputa** (`sha256("account:EscrowState")[0..8]`). Verificado: da exactamente esos 8 bytes. Así una errata es imposible de que pase.

**La query** (un solo POST JSON-RPC, batch de **2 elementos**):
1. `getProgramAccounts(programId, { encoding: 'base64', commitment: getSolanaCommitment(), filters: [{ dataSize: 154 }, { memcmp: { offset: 0, bytes: base58Encode(DISCRIMINATOR) } }] })`
2. `getAccountInfo('SysvarC1ock11111111111111111111111111111111', { encoding: 'base64' })` → `unix_timestamp` = **i64 LE en offset 32**.

**Clasificación en JS, no en el RPC**: decodificá cada cuenta y clasificá. Filtrar `status` por `memcmp` devolvería sólo `Deposited` y perdería el denominador.

⚠️ **El reloj es el del CLUSTER, nunca `Date.now()`.** El reloj local **da vuelta los veredictos de deadline** (documentado en el script vecino). Si el Clock no se pudo leer, `vencidos` sale **`null` con motivo** y el resto de la tarjeta igual se muestra (degradación independiente). ⛔ `vencidos` nunca es `0` por no haber podido leer.

**Unidades**: sólo se suma el `amount` de los escrows cuyo `mint` sea `getSolanaUsdcMint()`, formateado con `getSolanaUsdcDecimals()`. Los de otro mint van a `otros_mints_count` y **nunca se suman** (sería sumar peras con manzanas).

**Transporte**: `fetch` JSON-RPC crudo + `AbortSignal.timeout(8000)`. Exemplar: `src/adapters/base/payment.ts:298-310`.
⛔ **PROHIBIDO usar `Connection` de `@solana/web3.js` acá**: reintenta internamente ante 429 con backoff y no admite timeout por llamada, o sea que el modo de falla que esta tarjeta tiene que reportar en 1 segundo ("el RPC me está tirando 429") se convertiría en una request colgada.
⛔ **Sin fallback y sin reintento**: `SOLANA_RPC_URL_FALLBACK` existe y **no se usa acá**. Un tablero no puede duplicar la carga del RPC que el camino del dinero necesita.

**Estados de la tarjeta 3:**
- `ok`
- `sin_dato:rpc_no_configurado` — `SOLANA_RPC_URL` sin setear. ⚠️ El default de `getSolanaRpcUrl()` es el endpoint **público** (`https://api.devnet.solana.com`), que devuelve **429 sostenido** y no sirve como fuente: se dice, no se finge. Chequeá `process.env.SOLANA_RPC_URL` directo.
- `sin_dato:rpc_error` — 429 / 5xx / timeout (`AbortError`) / error JSON-RPC.
- `sin_dato:respuesta_invalida` — el shape no es el esperado.

**Fuera del corte**: no se comprueba si el beneficiario tiene ATA. Cuesta 1 RPC por escrow y es un diagnóstico, no una de las tres preguntas.

### 5.4 Refresco: cache por tarjeta, sin polling

Cache en el closure del plugin, **una entrada por tarjeta** — no una global: una fuente caída no debe invalidar el resultado bueno de las otras dos.

- `TTL_OK = 60_000` (alineado con `STATS_CACHE_TTL_MS`, `dashboard.ts:420`).
- `TTL_SIN_DATO = 15_000` — **el fallo TAMBIÉN se cachea, y menos.** No cachearlo deja que un reload en bucle martille justo al RPC que ya está en 429; cachearlo 60 s esconde una recuperación por un minuto entero.
- Cliente: fetch al abrir + botón "actualizar". ⛔ **Sin `setInterval`** — a diferencia de `dashboard-trace.html`, acá el reintento automático es carga sobre un RPC con cuota.

### 5.5 El shell HTML

Exemplar: `src/static/dashboard-trace.html:1-45` — HTML + CSS + JS **inline**, sin CDN y sin build step.

- **Sin datos de tenant en el HTML.** Es un cascarón: pide el token al operador y lo manda por header `X-Admin-Token`.
- El **único** `fetch` de la página es el `GET /dashboard/api/tres-preguntas`. Hay test que lo mantiene así.
- `esc()` tiene que escapar **también las comillas** (su salida se interpola dentro de atributos) y el `&` **primero**. Copiá el criterio de `dashboard-trace.render.test.ts:127-157`, no el `esc()` de `dashboard.html` (usa el truco del text node y NO escapa comillas).
- `esc()` y `render()` **extraíbles** para el test: `fetch` y timers son **parámetros de la función, no globales** (patrón `dashboard-trace.render.test.ts:1-60`).
- ⛔ **El `default` del `switch` de estado es GRIS ("sin dato"), NUNCA verde.** Un `status` desconocido o ausente se pinta gris con leyenda.
- ⛔ Ningún botón que dispare un pipeline (`compose`/`orchestrate`). Todo lo que se ve ya pasó.

---

## 6. Tests requeridos (≥1 por AC, con archivo)

| ID | Archivo | Qué verifica / qué lo pone rojo |
|---|---|---|
| `T-CAJA-1` | `src/services/tablero.test.ts` | Fila fake → `status:'ok'` con `budget`/`daily_spent_usd`/`daily_limit_usd`. El fake **verifica que la cadena llevó `.eq('id')` Y `.eq('owner_ref')`**. Rojo si sacás cualquiera de los dos. |
| `T-CAJA-2a/b/c` | `src/services/tablero.test.ts` | env faltante → `no_configurado`; `PGRST116` → `no_encontrada`; error genérico → `error_db`. En los tres, `status !== 'ok'`. |
| `T-REP-1` | `src/services/tablero.test.ts` | Se llama `computeStandingBatch` y **no hay ninguna llamada de red saliente**: spy en `fetch` + guard estructural (el fuente de `tablero.ts` no contiene `composeService`/`orchestrate`). |
| `T-REP-2` | `src/services/tablero.test.ts` | `degraded:true` → `sin_dato:historial_ilegible`. Rojo si tratás `degraded` como "cero reputación". |
| `T-REP-3` | `src/services/tablero.test.ts` | **Control positivo**: `degraded:false` + 0 slugs → `ok` con `agentes:[]`. Los dos casos NO colapsan al mismo estado. |
| `T-ESC-1` | `src/adapters/solana/escrow-scan.test.ts` | Fixture base64 de 3 cuentas (1 Deposited USDC, 1 Released, 1 Deposited de otro mint) → conteo y suma **derivados**, `otros_mints_count` separado. Rojo con cualquier número hardcodeado. |
| `T-ESC-DISC` | `src/adapters/solana/escrow-scan.test.ts` | La constante del discriminador `=== sha256('account:EscrowState')[0..8]`. Recomputado en el test. |
| `T-ESC-LAYOUT` | `src/adapters/solana/escrow-scan.test.ts` | El `dataSize` pedido en el filtro `=== 154`. |
| `T-ESC-2a/b/c` | `src/adapters/solana/escrow-scan.test.ts` | 429, timeout (`AbortError`) y JSON-RPC `error` → `sin_dato:rpc_error`, y **`escrows_vivos` no existe en la respuesta** (no es `0`). |
| `T-ESC-3` | `src/adapters/solana/escrow-scan.test.ts` | Clock ilegible → `vencidos: null` con motivo **y el conteo/suma igual presentes**. Rojo si usás `Date.now()` o si tirás toda la tarjeta. |
| `T-SNAP-1` | `src/services/tablero.test.ts` | Las tres fuentes fallan → **HTTP 200** con las tres en `sin_dato`. Rojo con un `Promise.all` en vez de `allSettled`. |
| `T-SNAP-2` | `src/services/tablero.test.ts` | Una falla, las otras dos siguen en `ok`. |
| `T-CD5-1` | `src/services/tablero.test.ts` | El JSON serializado no contiene `key_id`, `key_hash`, `key_id_hash` ni el UUID configurado — **en NINGUNO de los estados**. |
| `T-CD14-1` | `src/services/tablero.test.ts` | La raíz del snapshot no tiene ningún campo booleano/agregado de salud. |
| `T-GATE-1` | `src/routes/dashboard.tablero.test.ts` | Sin `DASHBOARD_ADMIN_TOKEN` → **503 en dev Y en prod**; el service no se llamó; el body no trae `budget` ni ningún id. |
| `T-GATE-2` | `src/routes/dashboard.tablero.test.ts` | Token incorrecto/ausente → 401, service intacto. Rojo si sacás el `preHandler` o si usás el opt-in `requireAdminToken`. |
| `T-RO-1` | `src/routes/dashboard.tablero.test.ts` | Ningún handler llama a nada que escriba o gaste. |
| `T-UI-1` | `src/static/dashboard-tres-preguntas.render.test.ts` | Un `status` desconocido/ausente se pinta "sin dato", **nunca verde**. |
| `T-UI-2` | `src/static/dashboard-tres-preguntas.render.test.ts` | El HTML tiene **exactamente un** endpoint en sus `fetch`, y es el `GET` del tablero. Rojo si alguien agrega un botón que dispare un pipeline. |
| `T-UI-XSS` | `src/static/dashboard-tres-preguntas.render.test.ts` | `esc()` escapa `<`, `>`, `"`, `'` y el `&` primero; `null`/`undefined` → `''`. Datos hostiles (un slug con `<img src=x onerror=…>`) no ejecutan nada. |

**Anti-vacuidad**: cada bloque lleva su **control positivo** (el caso que SÍ da `ok`), porque un test que sólo comprueba `sin_dato` pasa con una implementación que devuelve `sin_dato` siempre.

---

## 7. Constraint Directives (heredadas — se cumplen todas)

- **CD-1**: PROHIBIDO disparar `POST /compose`, `POST /orchestrate` o cualquier operación que gaste. El tablero **observa**.
- **CD-2**: PROHIBIDO modificar la sonda (`scripts/probe-money-path.mjs`, `.github/workflows/probe-money-path.yml`).
- **CD-3**: PROHIBIDO consultar `caldz` (MAINNET). Todo contra **bdwv**.
- **CD-4**: OBLIGATORIO que "sin dato" sea visualmente distinto en las tres tarjetas, y que el estado sano sea **inalcanzable por ausencia de respuesta**.
- **CD-5**: PROHIBIDO exponer `key_id`, `key_id_hash` o cualquier identificador crudo de la credencial de la sonda, en el HTML o el JSON. Se cumple **en la query** (§5.1).
- **CD-6**: OBLIGATORIO gatear el API con `requireAdminTokenForTrace` (fail-closed). NUNCA `requireAdminToken`.
- **CD-7**: PROHIBIDO `Connection` de `@solana/web3.js` para la tarjeta 3 (§5.3).
- **CD-8**: PROHIBIDO comparar `deadline` contra `Date.now()`. Si el Clock no se leyó, `vencidos` es `null` con motivo — **nunca `0`**.
- **CD-9**: PROHIBIDO tocar `src/services/reputation.ts`, la sonda y `test/ownership-filter-guard.exceptions.ts`. *(La parte de los README de esta CD queda **anulada** por §8: es materialmente imposible de cumplir.)*
- **CD-10** — *recurrente en 227 · 226 · 224*: PROHIBIDO que un docblock, un comentario o el nombre de un test **afirmen un mecanismo que el código no tiene**. Cada frase que describa un comportamiento tiene que ser **falsable con un input concreto**, o no se escribe.
- **CD-11** — *recurrente en 226 · 227*: OBLIGATORIO `git add` de **cada archivo nuevo** antes de correr el gate (§9).
- **CD-12**: el gate es la secuencia de `.github/workflows/ci.yml` **en orden**. `lint` va segundo y es el que caza lo que `tsc` y `vitest` dejan pasar.
- **CD-13**: si el diff excede el presupuesto de §10 más de 2x, la justificación se escribe **en `auto-blindaje.md` durante F3**, no se improvisa en el CR.
- **CD-14**: PROHIBIDO un campo de salud agregado en la raíz de la respuesta (`healthy`, `ok`, `status` de raíz).

---

## 8. ⚠️ Los README: obligatorio, y el SDD decía lo contrario

El SDD (CD-9) prohíbe tocar `README.md` y `README.es.md`, citando `test/readme-parity.test.ts`. **Es materialmente imposible de cumplir**, y esto está medido, no supuesto:

`test/readme-numbers.test.ts` deriva tres números del **índice de git** (`git ls-files`, `:83`) y los compara con **igualdad exacta** contra lo que los README publican (`:283`, `:289`, `:295`):

| Número | De dónde sale | Dónde está publicado | Valor hoy |
|---|---|---|---|
| archivos de test | `include` de `vitest.config.ts:5` sobre el índice de git | `README.md:378` · `README.es.md:412` | **305** |
| archivos linteados | `includes` de `biome.json:9` (`src/**/*.ts`) sobre el índice | `README.md:383` · `README.es.md:417` | **503** |
| variables | `grep -cE '^[A-Z][A-Z0-9_]*=' .env.example` | `README.md:351` · `README.es.md:385` | **186** |

Esta HU agrega **4 archivos de test** (todos bajo `src/`, así que suman a los dos primeros conteos), **2 archivos `.ts` de producción** y **3 variables** a `.env.example`. Los tres números cambian ⇒ sin actualizarlos, `npm test` queda **rojo**.

**Qué hacer**: derivá los valores nuevos y actualizá **los dos README** (nunca uno solo: `readme-parity.test.ts` exige paridad ES/EN):

```bash
cd /home/ferdev/.openclaw/workspace/a2a-tablero
/usr/bin/git add -A                      # ⚠️ PRIMERO: los tres conteos leen `git ls-files`
/usr/bin/git ls-files | /usr/bin/grep -cE '^src/.*\.test\.ts$'   # archivos de test
/usr/bin/git ls-files | /usr/bin/grep -cE '^src/.*\.ts$'         # archivos linteados
/usr/bin/grep -cE '^[A-Z][A-Z0-9_]*=' .env.example               # variables
```

Cambiá **sólo los números** (son texto en negrita, no literales entre backticks: la paridad de literales no se ve afectada). No reescribas las frases.

---

## 9. ⚠️ Correr el gate con TODO en el índice

**7 familias de guards de este repo derivan de `git ls-files`. Un archivo untracked les es invisible ⇒ gate verde FALSO.** Es el patrón de error recurrente #1 del auto-blindaje de este repo (226, 227).

```bash
cd /home/ferdev/.openclaw/workspace/a2a-tablero
/usr/bin/git add -A          # los 8 archivos nuevos + doc/sdd/228-…/ completo
/usr/bin/git status --short  # verificá que NO queda nada en "??"
npx tsc -p tsconfig.json --noEmit
npm run lint
npm test
```

⛔ **En ese orden, y los tres.** `npm run qa` **no existe** en este repo. Correr las partes de un gate no es correr el gate.
⚠️ Verificá también que `.gitignore` no se esté comiendo ninguno de los archivos nuevos (`git check-ignore -v <path>` miente en las dos direcciones; el instrumento confiable es que `git status --short` los muestre como `A`).

---

## 10. Presupuesto de diff (el CR lo contrasta)

| Bloque | Líneas |
|---|---|
| Producción + config (`types` +55, `escrow-scan.ts` 150, `tablero.ts` 140, `dashboard.ts` +70, HTML 280, `.env.example` +30) | **~725** |
| Tests (`escrow-scan.test.ts` 250, `tablero.test.ts` 280, `dashboard.tablero.test.ts` 170, `render.test.ts` 150) | **~850** |
| **TOTAL (sin `doc/` ni README)** | **~1.575** · techo 2x = **3.150** |

**Dónde mirar si crece**: helpers HTTP genéricos, un mini-framework de "cards", o una interfaz común para las tres lecturas. **Las tres fuentes no se parecen** (un `select`, otro `select`, un decodificador binario) y forzar una abstracción es el exceso más probable. Si excedés 2x, escribí la justificación en `auto-blindaje.md`.

---

## 11. Lo que el Dev NO hace

- No cotiza, no compra, no mueve dinero, no firma nada. **El tablero observa.**
- No toca la sonda, ni `chaski-v3`, ni `wasiai-facilitator`, ni `solana-programs`.
- No setea variables en Railway (son del founder). ⚠️ **Las que faltan NO bloquean el merge**: degradan a `sin_dato`, que es el comportamiento correcto. No inventes valores ni pongas defaults falsos para "que la tarjeta se vea".
- No agrega la fila `228` a `doc/sdd/_INDEX.md` (**ya existe**).
- No modifica el SDD ni el work item.

---

## 12. Done Definition

- [ ] Los 13 archivos de §2 escritos, y **ninguno fuera de esa lista**.
- [ ] Los 12 ítems del Anti-Hallucination Checklist (§3) verificados contra el código real.
- [ ] Las tres tarjetas tienen su `sin_dato` con motivo tipado, y `ok` es **inconstruible sin datos** (lo impide el tipo).
- [ ] `TableroSnapshot` **sin** campo agregado de salud en la raíz.
- [ ] El `select` de `a2a_agent_keys` lleva `.eq('id')` **y** `.eq('owner_ref')`, y no pide `id` ni `key_hash`.
- [ ] `test/ownership-filter-guard.exceptions.ts` **sin tocar** y el guardián verde.
- [ ] Los 20 tests de §6 escritos, cada bloque con su control positivo.
- [ ] Los 3 números de los **dos** README actualizados (§8).
- [ ] `git add -A` hecho **antes** del gate; `git status --short` sin `??`.
- [ ] `npx tsc --noEmit` → `npm run lint` → `npm test`: los tres verdes, en ese orden.
- [ ] `auto-blindaje.md` escrito, con la justificación del diff si excedió 2x (§10).
- [ ] Sin commits ni push: eso lo decide el humano al cierre del pipeline.
