# SDD — [WKH-365] Tablero de las tres preguntas (HU 228)

Input: `doc/sdd/228-tablero-tres-preguntas/work-item.md` (HU_APPROVED) · issue `ferrosasfp/wasiai-a2a#179`.
Worktree `/home/ferdev/.openclaw/workspace/a2a-tablero`, rama `feat/228-tablero-tres-preguntas`.
SDD_MODE: full (QUALITY).

---

## 1. Context Map — qué se leyó y qué salió de ahí

| Archivo leído | Por qué | Qué se extrajo |
|---|---|---|
| `src/routes/dashboard.ts:314-330` | El gate del API nuevo | `requireAdminTokenForTrace`: 503 si falta `DASHBOARD_ADMIN_TOKEN`, 401 si el header no casa. Se reusa TAL CUAL. |
| `src/routes/dashboard.ts:355`, `:360-372`, `:374-410` | Registro del plugin y patrón shell-HTML-público + API-gateada | `fastify.get('/', {config:{rateLimit:false}})` sirve HTML leído en `readFileSync` al arranque; `/api/trace` lleva `preHandler: requireAdminTokenForTrace`. |
| `src/routes/dashboard.ts:420` | Cache server-side | `const STATS_CACHE_TTL_MS = 30_000` dentro del plugin, cache en closure. |
| `src/index.ts:58`, `:381` | Dónde se monta | `register(dashboardRoutes, { prefix: '/dashboard' })`. Las rutas nuevas NO necesitan tocar `index.ts`. |
| `src/services/reputation.ts:264-270`, `:336-397` | La tarjeta 2 | `computeStandingBatch(slugs)` → `{degraded, standings}`. Docblock `:266`: «`degraded: true` significa "no pude preguntar por el historial"». El "sin dato" YA existe; no se inventa otro. |
| `src/types/index.ts:536-546` | Contrato de la tarjeta 2 | `AgentStandingBatch { degraded: boolean; standings: Map<string, AgentStandingCounters> }`. |
| `src/services/budget.ts:94-116` (`getBalance`) | Patrón obligatorio de ownership | `.eq('id', keyId).eq('owner_ref', ownerId).single()` + `PGRST116 → OwnershipMismatchError`. Es el patrón que copia DT-3. |
| `src/services/identity.ts:91-105` (`lookupByHash`) + `test/ownership-filter-guard.exceptions.ts:108-117` | La alternativa que se DESCARTA en DT-3 | Lee `a2a_agent_keys` SIN filtro de dueño y está exceptuada como `auth-por-hash` («exigirle un filtro por dueño sería circular»). No es la única sin filtro: `agent-link.ts:265` es otra, con otra categoría. |
| `src/routes/auth/me.ts:23-30` | Qué campos publica AC-1 | `budget`, `daily_limit_usd`, `daily_spent_usd`, `daily_reset_at` salen de la MISMA fila de `a2a_agent_keys`; `key_id`/`key_id_hash` también (CD-5 los prohíbe acá). |
| `src/adapters/solana/chain.ts:20-27`, `:39-41` (`getSolanaRpcUrl`), `:73-78` (`getSolanaConnection`, que DT-4 NO usa) | Patrón de config de la tarjeta 3 | env > default documentado (`DEFAULT_USDC_MINT_DEVNET`); `getSolanaRpcUrl()` cae a `https://api.devnet.solana.com` si `SOLANA_RPC_URL` no está. |
| `src/adapters/solana/base58.ts:27` | Codificar el `memcmp` | `base58Encode(bytes: Uint8Array): string`. |
| `src/adapters/base/payment.ts:304` (y 7 sitios más) | Cómo se acota una llamada de red acá | `fetch(..., { signal: AbortSignal.timeout(MS) })`. |
| **Repo vecino** `solana-programs/programs/escrow/src/lib.rs:426-462`, `target/idl/escrow.json`, `scripts/list-live-escrows.py:100-102,539-593` | **Resuelve el `[NEEDS CLARIFICATION]` del F1** | Program id, discriminador, layout y tamaño exactos de `EscrowState` (§DT-4). |
| `src/routes/dashboard.trace.test.ts:1-70` | Exemplar del test de rutas | Mocks de TODO lo que `dashboard.ts` importa (cero supabase), Fastify en memoria, casos del gate. |
| `src/static/dashboard-trace.html:1-40` + `src/static/dashboard-trace.render.test.ts:128-360` | Exemplar del shell y de su test | HTML+CSS+JS inline sin CDN ni build; el test extrae las funciones del HTML y las ejercita (`esc`, `render`, XSS, "sin datos" ≠ cero). |
| `vitest.config.ts:5`, `:16` | Dónde tienen que vivir los tests nuevos | `include: ['src/**/*.test.ts','test/**/*.test.ts','test/**/*.test.mjs']`, `passWithNoTests: false`. |
| `test/cited-lines-guard.citations.ts:87-102` | Exposición de esta HU al guardián de citas | `CORTE_A_PATHS` (14 paths) **NO** incluye `src/routes/dashboard.ts`, `src/services/*` nuevos ni `src/static/*`. Esta HU **no** agrega citas al candado. Medido, no supuesto. |
| `doc/sdd/_INDEX.md` (fila `| 228 `) | Guardián `sdd-index-matches-folders` | La fila 228 **ya existe** (1 coincidencia). No hay que agregarla. |
| Auto-blindajes 227 / 226 / 224 | Paso 6 del grounding | Ver CD-10..CD-13. |

---

## 2. Decisiones técnicas

### DT-1 (heredada del F1, sin cambios) — vive en el gateway
`GET /dashboard/tres-preguntas` (HTML público, cero datos) + `GET /dashboard/api/tres-preguntas` (JSON, gateado). Ambas dentro de `src/routes/dashboard.ts`, que ya está registrado con prefijo `/dashboard`. **No** se crea un plugin nuevo: `src/routes/charged-routes.meta.test.ts:304` (T-META-06) exige que el guard escanee exactamente los plugins que la app registra, y un archivo de rutas nuevo obligaría a tocar ese inventario sin ninguna ganancia.

### DT-2 — UNA respuesta con tres tarjetas independientes
Un solo endpoint. Las tres lecturas corren con `Promise.allSettled`, cada tarjeta tiene su propio estado, y la respuesta es **200 aunque las tres estén en `sin_dato`** (AC-9). Tres endpoints separados triplicarían el gate, el cache y el fetch del cliente sin comprar nada: el operador siempre quiere las tres.

### DT-3 — 🔴 El saldo de la sonda se lee de la BASE, no llamándose a sí mismo por HTTP
**El F1 (DT-5) daba por hecho que hacía falta `A2A_PROBE_KEY` (una credencial de GASTO) como env del proceso del gateway. Se rechaza.**

Se lee la fila directo con el cliente de Supabase que el gateway ya tiene:

```
.from('a2a_agent_keys')
  .select('budget, daily_limit_usd, daily_spent_usd, daily_reset_at, is_active')
  .eq('id', process.env.A2A_PROBE_KEY_ID)
  .eq('owner_ref', process.env.A2A_PROBE_KEY_OWNER_REF)
  .single()
```

Por qué, en orden de peso:

1. **Deja de ser una promesa y pasa a ser una capacidad.** AC-7/CD-1 dicen "el tablero no gasta". Con `A2A_PROBE_KEY` en el entorno, eso lo sostiene la revisión de código. Sin la credencial en el proceso, el tablero **no puede** gastar aunque alguien escriba el código: la precondición desaparece del entorno, no del diff.
2. **El gate de ownership queda verde sin excepción nueva.** El par `id` + `owner_ref` es literalmente el patrón obligatorio del `CLAUDE.md` (exemplar `budget.ts:94-116`). `test/ownership-filter-guard.test.ts` no se pone rojo y `test/ownership-filter-guard.exceptions.ts` **no se toca**. Además el par se auto-chequea: si el `owner_ref` configurado no corresponde a esa key, PostgREST devuelve `PGRST116` (0 filas) → la tarjeta sale **`sin_dato`**, nunca el saldo de otro dueño.
3. **Las dos env nuevas NO son secretos.** Un UUID y un `owner_ref`. La alternativa metía una credencial viva de gasto en Railway; ésta no agrega superficie de secreto.
4. **El auto-llamado HTTP tiene tres modos de falla propios**: el proceso tiene que conocer su propia URL pública, atraviesa su propio rate-limiter (puede auto-429), y agrega un salto de red que puede colgar — todo para leer una fila que está a un `select` de distancia.

**Refinamiento explícito de AC-1** (para que F4 no lo lea como drift): AC-1 dice «leído de `GET /auth/me` en esa misma corrida». Se cumple la **sustancia** — las mismas columnas, de la misma fila de `a2a_agent_keys`, leídas en esa misma corrida, que es exactamente lo que `auth/me.ts:23-30` devuelve — sin el salto HTTP. Lo que AC-1 prohíbe (y se respeta) es servir un número cacheado de otra corrida o precomputado.

Estados de la tarjeta 1: `ok` · `sin_dato:no_configurado` (falta alguna de las dos env) · `sin_dato:no_encontrada` (`PGRST116` — id/owner no casan, o la key no existe) · `sin_dato:error_db`.
`is_active: false` **no** es `sin_dato`: es un dato y se muestra como advertencia (una key desactivada con saldo es información, no ausencia).

**Se descarta** `identityService.lookupByHash` (que también leería la fila, y sin env de owner): exige tener la credencial en el proceso, o sea vuelve al problema del punto 1.

### DT-4 — ✅ Escrows: el `[NEEDS CLARIFICATION]` del F1, RESUELTO con evidencia

El programa **no vive en este árbol**; vive en `/home/ferdev/.openclaw/workspace/solana-programs`. Lo medido:

- **Program id**: `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x` (`target/idl/escrow.json` campo `address`; citado también en `doc/sdd/212-wkh-314-x402-inbound-solana/sdd.md:50` de este repo).
- **Layout de `EscrowState`** (`programs/escrow/src/lib.rs:444-455`), con offsets desde el byte 0 de la cuenta:

  | offset | bytes | campo |
  |---|---|---|
  | 0 | 8 | discriminador Anchor |
  | 8 | 32 | `sender` |
  | 40 | 32 | `beneficiary` |
  | 72 | 32 | `authority` |
  | 104 | 32 | `mint` |
  | 136 | 8 | `amount` (u64 LE) |
  | 144 | 8 | `deadline` (i64 LE, unix ts) |
  | 152 | 1 | `status` — `0 Deposited · 1 Released · 2 Refunded` (`lib.rs:457-462`) |
  | 153 | 1 | `bump` |

  **Total 154 bytes**, confirmado por tres fuentes independientes: la aritmética de arriba, `solana-programs/README.md:390` («`EscrowState` … 154 bytes») y `scripts/list-live-escrows.py:100-101` (`ESCROW_STATE_SIZE = 154`).
- **Discriminador**: `[19,90,148,111,55,130,229,108]` (IDL, campo `accounts[].discriminator`). **Verificado**: es `sha256("account:EscrowState")[0..8]` — computado y comparado, da `True`. Va como constante nombrada **con un test que recomputa el sha256 y compara** (T-ESC-DISC): así una errata en los 8 bytes es imposible de que pase.
- **La query**: `getProgramAccounts(programId, { encoding: 'base64', commitment, filters: [{dataSize:154},{memcmp:{offset:0,bytes:base58Encode(DISCRIMINATOR)}}] })`. Es exactamente lo que hace el prior art (`list-live-escrows.py:539-550`). El `dataSize` ya separa `EscrowState` (154) de `EscrowIndex` (558 = 8+32+1+1+4+16·32, `lib.rs:422,428-437`); el `memcmp` del discriminador es el cinturón.
- **Clasificación en JS, no en el RPC**: se decodifica cada cuenta y se clasifica. Filtrar `status` por `memcmp` devolvería sólo `Deposited` y perdería el denominador; decodificar cuesta microsegundos sobre decenas de cuentas.
- **Reloj**: `deadline` se compara contra el **reloj del CLUSTER**, nunca contra `Date.now()`. Prior art `list-live-escrows.py:274` y `:427` documentan que el reloj local **da vuelta los veredictos de deadline**. Se lee del sysvar Clock `SysvarC1ock11111111111111111111111111111111` (`unix_timestamp` = i64 LE en offset 32) **en el MISMO POST**, como batch JSON-RPC de 2 elementos → **una sola llamada HTTP**. Si el reloj no se puede leer, `vencidos` sale `null` con motivo y el resto de la tarjeta igual se muestra (degradación independiente).
- **Unidades**: sólo se suma el `amount` de los escrows cuyo `mint` sea `getSolanaUsdcMint()`, formateado con `getSolanaUsdcDecimals()`. Los de otro mint se reportan como `otros_mints_count` — **nunca sumados**, que sería sumar peras con manzanas.
- **Transporte**: `fetch` JSON-RPC crudo + `AbortSignal.timeout(8000)`, **no** `Connection` de `@solana/web3.js`. Motivo: `Connection` reintenta internamente ante 429 con backoff y no admite timeout por llamada — o sea que el modo de falla que esta tarjeta tiene que reportar en 1 segundo ("el RPC me está tirando 429") se convertiría en una request colgada. `@solana/web3.js@1.98.4` sigue instalado y en uso en el resto del adapter; acá no se usa a propósito.
- **Sin fallback y sin reintento**: `SOLANA_RPC_URL_FALLBACK` existe y **no** se usa acá. Un tablero no puede duplicar la carga del RPC que el camino del dinero necesita; y su fallback está reservado para veredictos de cadena (`.env.example:1373-1375`).
- **`SOLANA_ESCROW_PROGRAM_ID`**: env nueva con default documentado `DR5G…` (patrón `chain.ts:21-22`). **Medido**: hoy no existe ninguna env de program id en `.env.example` ni ninguna referencia al program id en `src/`.

Estados de la tarjeta 3: `ok` · `sin_dato:rpc_no_configurado` (`SOLANA_RPC_URL` sin setear → estaríamos midiendo contra el endpoint público que ya da 429 sostenido; se dice, no se finge) · `sin_dato:rpc_error` (429/5xx/timeout/JSON-RPC error) · `sin_dato:respuesta_invalida`.

**Lo que esta HU NO hace** (y por qué): no comprueba si el beneficiario tiene ATA (el `unpayable` de `list-live-escrows.py:651`). Cuesta 1 RPC por escrow y es un diagnóstico, no una de las tres preguntas.

### DT-5 — Reputación: cero lógica nueva, y el universo de slugs se deriva
`computeStandingBatch(slugs)` sin tocar `reputation.ts`. Los slugs salen de **`a2a_events`**, no de `/discover` ni de `agentService`:

```
.from('a2a_events').select('agent_id')
  .gte('created_at', <ahora - 30d>)
  .order('created_at', { ascending: false }).limit(1000)
```
→ dedupe en JS → **tope de 50 slugs**.

Por qué así: (a) `a2a_events` **no tiene `owner_ref`** (`src/types/database.types.ts:326-340`), así que la lectura es neutral para el guardián de ownership; (b) `/discover` puede salir a registries remotos y CD-1 lo prohíbe; (c) un agente sin eventos no tiene reputación que mostrar, así que el universo correcto ES el de los eventos. Todo contra **bdwv** (CD-3).

Tres estados, y los tres son distintos:
- error de esta query **o** `degraded: true` → `sin_dato:historial_ilegible`;
- `degraded:false` con 0 slugs → **`ok` con `agentes: []` y la etiqueta "sin actividad en la ventana"** (es una respuesta, no una ausencia);
- `degraded:false` con slugs → `ok` con la lista.

### DT-6 — Refresco: cache por tarjeta, y el cliente NO hace polling
Cache en el closure del plugin, **una entrada por tarjeta** (no una global: una fuente caída no debe invalidar el resultado bueno de las otras dos).
- `TTL_OK = 60_000` — el número del F1, alineado con `STATS_CACHE_TTL_MS` (`dashboard.ts:420`).
- `TTL_SIN_DATO = 15_000` — **el fallo también se cachea, y menos.** No cachearlo (el criterio de `reputation.ts:311`) deja que un reload en bucle martille justo al RPC que ya está en 429; cachearlo 60 s esconde una recuperación por un minuto entero. 15 s es la decisión, y se declara.
- Cliente: fetch al abrir + botón "actualizar". **Sin `setInterval`** — a diferencia de `dashboard-trace.html`, acá el reintento automático es carga sobre un RPC con cuota.

Las tres fuentes siguen siendo gratis: un `select` a Supabase, otro `select` a Supabase, y **una** llamada HTTP a un RPC devnet. Cero transacciones, cero firmas, cero cotizaciones.

### DT-7 — La forma de "sin dato", y por qué el verde es inalcanzable por omisión
Cada tarjeta es una unión discriminada:

```ts
type Card<T> = ({ status: 'ok' } & T) | { status: 'sin_dato'; reason: SinDatoReason };
```

Tres propiedades que esto compra, y que hay que sostener en el Dev:
1. **`ok` no se puede construir sin los datos** — lo impide el tipo, no la disciplina.
2. **No hay campo agregado de salud en la raíz.** Ni `healthy`, ni `status` global, ni semáforo. Un agregado necesitaría una regla para "las tres sin dato", y la lección de 227 (`auto-blindaje.md:72`, «El DEFAULT de una escalera de monitoreo era PASS») es que esa regla se escribe mal. La respuesta trae tres estados y **el humano lee tres estados**.
3. **En el HTML, el `default` del `switch` de estado es "sin dato"**, no "ok". Un `status` desconocido o ausente se pinta gris con leyenda, nunca verde. Hay test.

---

## 3. Constraint Directives

**Heredados del work item (CD-1..CD-6), sin cambios.** Se refuerzan dos:
- **CD-1** queda además garantizado por entorno: DT-3 saca del proceso la única credencial capaz de gastar.
- **CD-5** (no exponer `key_id`/`key_id_hash`): el `select` de DT-3 **no pide** `id` ni `key_hash`. La prohibición se cumple en la query, no en el serializador.

Nuevos del SDD:

- **CD-7**: PROHIBIDO usar `Connection` de `@solana/web3.js` para la tarjeta 3 (reintento oculto ante 429 + sin timeout por llamada, DT-4). `fetch` + `AbortSignal.timeout`.
- **CD-8**: PROHIBIDO comparar `deadline` contra `Date.now()`. El reloj es el del cluster; si no se pudo leer, `vencidos` es `null` con motivo — nunca `0`.
- **CD-9**: PROHIBIDO tocar `src/services/reputation.ts`, `scripts/probe-money-path.mjs`, `.github/workflows/probe-money-path.yml`, `test/ownership-filter-guard.exceptions.ts`, `README.md` y `README.es.md`. (Los READMEs: `test/readme-parity.test.ts:201-229` exige paridad ES/EN; editar uno solo pone CI en rojo y editar los dos está fuera del corte.)
- **CD-10** — *recurrente en 227 · 226 · 224*: PROHIBIDO que un docblock, un comentario o el nombre de un test **afirmen un mecanismo que el código no tiene**. Cada frase que describa un comportamiento tiene que ser falsable con un input concreto, o no se escribe. Referencias: `227/auto-blindaje.md:136` («La prosa del YAML describía un mecanismo inexistente»), `226/auto-blindaje.md:30` («el Story File afirmaba "exposición cero" … y era FALSO»), `224/auto-blindaje.md:32` («el docblock afirmaba que un trozo del regex cargaba un comportamiento que NO cargaba»).
- **CD-11** — *recurrente en 226 · 227*: OBLIGATORIO `git add` de **cada archivo nuevo** (los 5 de esta HU + los artefactos de `doc/sdd/228-…/`) **antes** de correr el gate. En este repo un archivo nuevo sin trackear da **gate verde falso** (`226/auto-blindaje.md:107`) y `.gitignore` se come evidencia en silencio (`227/auto-blindaje.md:44`). El guardián `sdd-index-matches-folders` (G-T, `:383`) también exige la carpeta en git.
- **CD-12** — *lección de 226*: el gate del repo es la secuencia de `.github/workflows/ci.yml` **en orden**: `npx tsc -p tsconfig.json --noEmit` → `npm run lint` → `npm test`. `npm run qa` **no existe acá**. `lint` va segundo y es el que caza formato que `tsc` y `vitest` dejan pasar (`226/auto-blindaje.md:8`).
- **CD-13** — *lección de 226 (MNR-1)*: si el diff excede el presupuesto de §6 más de 2x, la justificación se escribe **en `auto-blindaje.md` durante F3**, no se improvisa en el CR.
- **CD-14**: PROHIBIDO que la respuesta JSON tenga un campo de salud agregado (`healthy`, `ok`, `status` de raíz) — DT-7.3.

---

## 4. Waves

### W0 — serial (contratos; nadie arranca antes)
| Archivo | Qué |
|---|---|
| `src/types/index.ts` | `SinDatoReason`, `TableroCajaCard`, `TableroReputacionCard`, `TableroEscrowsCard`, `TableroSnapshot`. Uniones discriminadas (DT-7). ~55 líneas al final del archivo. |
| `.env.example` | Documentar `A2A_PROBE_KEY_ID`, `A2A_PROBE_KEY_OWNER_REF`, `SOLANA_ESCROW_PROGRAM_ID` (con su default) y que `DASHBOARD_ADMIN_TOKEN` gatea también esta pantalla. |

### W1 — paralelizable (tres frentes que no se pisan)
| # | Archivos | Qué |
|---|---|---|
| W1a | `src/adapters/solana/escrow-scan.ts` (nuevo) + `src/adapters/solana/escrow-scan.test.ts` (nuevo) | `scanEscrows(): Promise<TableroEscrowsCard>` — batch JSON-RPC (`getProgramAccounts` + sysvar Clock), decode con los offsets de DT-4, clasificación, unidades. Cero Supabase. |
| W1b | `src/services/tablero.ts` (nuevo) + `src/services/tablero.test.ts` (nuevo) | `tableroService.snapshot()`: `Promise.allSettled` de las tres; `leerCajaDeLaSonda()` (DT-3) y `leerReputacion()` (DT-5) viven acá; importa `scanEscrows` de W1a (contra el tipo de W0, mockeable). |
| W1c | `src/static/dashboard-tres-preguntas.html` (nuevo) + `src/static/dashboard-tres-preguntas.render.test.ts` (nuevo) | Shell: HTML+CSS+JS inline, sin CDN, sin datos. Pide el token al operador y lo manda por `X-Admin-Token`. Botón "actualizar", sin `setInterval`. `esc()` + `render()` extraíbles (patrón `dashboard-trace.render.test.ts`). |

### W2 — serial (cablea W1 y sólo eso)
| Archivo | Qué |
|---|---|
| `src/routes/dashboard.ts` | `GET /tres-preguntas` (HTML, `rateLimit:false`, público) + `GET /api/tres-preguntas` (`preHandler: requireAdminTokenForTrace`) + el cache por tarjeta de DT-6. `readFileSync` del HTML al arranque, junto a `traceHtml` (`:350`). |
| `src/routes/dashboard.tablero.test.ts` (nuevo) | Gate + contrato de la respuesta, con el patrón de mocks de `dashboard.trace.test.ts`. |

---

## 5. Plan de tests (≥1 por AC)

| AC | Test | Archivo | Qué lo pone rojo |
|---|---|---|---|
| AC-1 | `T-CAJA-1` — token válido → `status:'ok'` con `budget`/`daily_spent_usd`/`daily_limit_usd` de la fila fake, y el fake **verifica que la cadena llevó `.eq('id')` Y `.eq('owner_ref')`** | `src/services/tablero.test.ts` | sacar cualquiera de los dos `.eq` |
| AC-2 | `T-CAJA-2a/b/c` — env faltante → `no_configurado`; `PGRST116` → `no_encontrada`; error genérico → `error_db`. En los tres, **`status !== 'ok'`** | `src/services/tablero.test.ts` | que un fallo devuelva `ok` o un `budget` inventado |
| AC-3 | `T-REP-1` — se llama `computeStandingBatch` y **no** hay ninguna llamada de red saliente ni a `compose`/`orchestrate` (spies en `fetch` + guard estructural: el fuente de `tablero.ts` no contiene `composeService`/`orchestrate`) | `src/services/tablero.test.ts` | cualquier cotización nueva |
| AC-4 | `T-REP-2` — `degraded:true` → `sin_dato:historial_ilegible`. **`T-REP-3`**: `degraded:false` + 0 slugs → `ok` con `agentes:[]` (control positivo: los dos casos NO colapsan al mismo estado) | `src/services/tablero.test.ts` | tratar `degraded` como "cero reputación" |
| AC-5 | `T-ESC-1` — fixture base64 de 3 cuentas (1 Deposited USDC, 1 Released, 1 Deposited de otro mint) → conteo y suma **derivados**. `T-ESC-DISC`: la constante del discriminador == `sha256('account:EscrowState')[0..8]`. `T-ESC-LAYOUT`: `dataSize` pedido == 154 | `src/adapters/solana/escrow-scan.test.ts` | un número hardcodeado; una errata en el discriminador o el tamaño |
| AC-6 | `T-ESC-2a/b/c` — 429, timeout (`AbortError`) y JSON-RPC `error` → `sin_dato:rpc_error`, y **`escrows_vivos` no existe en la respuesta** (no es `0`) | `src/adapters/solana/escrow-scan.test.ts` | interpretar el silencio como cero |
| AC-6bis | `T-ESC-3` — Clock ilegible → `vencidos:null` con motivo **y el conteo/suma igual presentes** (degradación independiente, CD-8) | `src/adapters/solana/escrow-scan.test.ts` | usar `Date.now()`, o tirar toda la tarjeta |
| AC-7 | `T-RO-1` (ruta: ningún handler llama a nada que escriba/gaste) + `T-XSS/RO-2` (el HTML tiene exactamente **un** endpoint en sus `fetch`, y es el `GET` del tablero) | `dashboard.tablero.test.ts` + `dashboard-tres-preguntas.render.test.ts` | agregar un botón que dispare un pipeline |
| AC-8 | `T-GATE-1` sin `DASHBOARD_ADMIN_TOKEN` → 503 en dev **y** en prod; `T-GATE-2` token mal → 401; en ambos **el service no se llamó** y el body no trae `budget` ni ningún id | `src/routes/dashboard.tablero.test.ts` | sacar el `preHandler`, o usar el opt-in `requireAdminToken` |
| AC-9 | `T-SNAP-1` — las tres fuentes fallan → **HTTP 200** con las tres en `sin_dato`. `T-SNAP-2` — una falla, las otras dos siguen en `ok` | `src/services/tablero.test.ts` | un `Promise.all` en vez de `allSettled` |
| CD-5 | `T-CD5-1` — el JSON serializado no contiene `key_id`, `key_hash`, `key_id_hash` ni el UUID configurado, en NINGUNO de los estados | `src/services/tablero.test.ts` | filtrar el id en la vista en vez de en la query |
| CD-14/DT-7 | `T-CD14-1` — la raíz del snapshot no tiene ningún campo booleano de salud. `T-UI-1` — un `status` desconocido/ausente se pinta como "sin dato", nunca verde | `tablero.test.ts` + `render.test.ts` | un default PASS |

**Anti-vacuidad**: cada bloque lleva su control positivo (el caso que SÍ da `ok`), porque un test que sólo comprueba `sin_dato` pasa con una implementación que devuelve `sin_dato` siempre.

---

## 6. Presupuesto de diff (check 7 — el CR lo contrasta)

| Archivo | Tipo | Líneas |
|---|---|---|
| `src/types/index.ts` | prod | +55 |
| `src/adapters/solana/escrow-scan.ts` | prod (nuevo) | 150 |
| `src/services/tablero.ts` | prod (nuevo) | 140 |
| `src/routes/dashboard.ts` | prod | +70 |
| `src/static/dashboard-tres-preguntas.html` | prod (nuevo) | 280 |
| `.env.example` | config | +30 |
| **Producción + config** | | **~725** |
| `src/adapters/solana/escrow-scan.test.ts` | test (nuevo) | 250 |
| `src/services/tablero.test.ts` | test (nuevo) | 280 |
| `src/routes/dashboard.tablero.test.ts` | test (nuevo) | 170 |
| `src/static/dashboard-tres-preguntas.render.test.ts` | test (nuevo) | 150 |
| **Tests** | | **~850** |
| **TOTAL (sin `doc/`)** | | **~1.575** · techo 2x = **3.150** |

*¿Qué parte de esto seguiría existiendo si lo escribiera alguien que ya conoce Fastify?* Casi todo, y esa es la señal: dos rutas Fastify son ~25 líneas; el resto son el decodificador binario (que existe porque el layout es del programa, no de Fastify), los cuatro estados de degradación de cada tarjeta, y la pantalla. **Lo que NO justificaría el exceso**: helpers genéricos de HTTP, un mini-framework de "cards", o abstraer las tres lecturas en una interfaz común — las tres fuentes no se parecen y una interfaz común sólo agregaría indirección. Si el diff crece, es ahí donde hay que mirar primero.

---

## 7. Exemplars verificados

| Para | Exemplar (path real, rango verificado) |
|---|---|
| Gate fail-closed | `src/routes/dashboard.ts:314-330` |
| Ruta HTML pública + API gateada | `src/routes/dashboard.ts:374-410` |
| Cache en closure del plugin | `src/routes/dashboard.ts:419-433` |
| `.eq('id') + .eq('owner_ref')` + `PGRST116` | `src/services/budget.ts:94-116` |
| Degradación explícita como tercer valor | `src/services/reputation.ts:264-270`, `:350-366` |
| env > default documentado | `src/adapters/solana/chain.ts:20-27`, `:39-41` |
| `fetch` acotado con timeout | `src/adapters/base/payment.ts:298-310` |
| Test de rutas con Fastify en memoria + mocks totales | `src/routes/dashboard.trace.test.ts:13-70` |
| Shell HTML sin CDN ni build | `src/static/dashboard-trace.html:1-40` |
| Test que ejercita el JS del HTML | `src/static/dashboard-trace.render.test.ts:128-360` |
| Escaneo de escrows (prior art, otro repo) | `solana-programs/scripts/list-live-escrows.py:100-102`, `:539-593` |
| Layout on-chain | `solana-programs/programs/escrow/src/lib.rs:444-462`; `solana-programs/target/idl/escrow.json` |

---

## 8. Missing Inputs — estado

| # | Qué | Estado |
|---|---|---|
| 1 | `A2A_PROBE_KEY` como env del gateway | ❌ **CANCELADO por DT-3.** Ya no hace falta ninguna credencial nueva en el proceso. |
| 2 | Program id + layout del escrow | ✅ **RESUELTO** (DT-4), con tres fuentes independientes para el tamaño y el discriminador recomputado. |
| 3 | `requireAdminTokenForTrace` ¿alcanza? | ✅ **SÍ**, tal cual, sin segundo secreto. Quien tiene el token del panel hoy es exactamente quien debe ver esto, y el payload es del mismo orden de sensibilidad que `/api/trace` (cross-tenant). |
| 4 | TTL y forma de la respuesta | ✅ **RESUELTO** (DT-2, DT-6): un endpoint, tres tarjetas, `TTL_OK 60 s` / `TTL_SIN_DATO 15 s`. |
| 5 | 🟡 **NUEVO — founder, NO bloquea F2.5/F3** | `A2A_PROBE_KEY_ID` y `A2A_PROBE_KEY_OWNER_REF` en Railway (ninguno es secreto). `A2A_PROBE_KEY_ID` ya existe como línea de `.env.local` en `/home/ferdev/.openclaw/workspace/wasiai-a2a` (archivo no versionado; valor NO leído acá); el `owner_ref` sale de la fila de esa key. Sin esto, la tarjeta 1 muestra `sin_dato:no_configurado` — que es el comportamiento correcto, así que **no bloquea el merge**, sólo el valor operativo. |
| 6 | 🟡 `SOLANA_RPC_URL` en el proceso del gateway | Si no está seteada, la tarjeta 3 sale `sin_dato:rpc_no_configurado` (DT-4). Verificable por el founder en Railway; no bloquea el merge. |

---

## 9. Readiness Check

- [x] Todo path referenciado existe y fue abierto (Read/Grep), incluidos los del repo vecino.
- [x] El `[NEEDS CLARIFICATION]` del F1 está **resuelto con medición**, no con memoria: 154 bytes por tres fuentes, discriminador recomputado (`True`), offsets del `lib.rs`.
- [x] El bloqueante del F1 fue **cuestionado y eliminado** (DT-3), con la regla de ownership del `CLAUDE.md` a la vista y **sin** excepción nueva en `ownership-filter-guard.exceptions.ts`.
- [x] Refresco definido y gratis: 2 `select` + **1** HTTP al RPC, cacheados (DT-6).
- [x] "Sin dato" tiene mecanismo, motivo tipado y test en las tres tarjetas; el verde es inalcanzable por omisión (DT-7, CD-14).
- [x] ≥1 test por AC, con control positivo anti-vacuidad.
- [x] Presupuesto de diff declarado con la pregunta del check 7 contestada.
- [x] CDs del work item heredados + 8 nuevos, 4 de ellos derivados de los auto-blindajes 227/226/224.
- [x] Sin TBDs. Los dos ítems abiertos son acciones del founder en Railway y **degradan a `sin_dato`**, que es el comportamiento correcto: no bloquean F2.5 ni F3.

**Listo para `SPEC_APPROVED`.**
