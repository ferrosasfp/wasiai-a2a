# Story File — #214: [WKH-316] El escritor del bloque `payment` de un agente

> SDD: `doc/sdd/214-wkh-316-escritor-payment-block/sdd.md` (SPEC_APPROVED 2026-08-19)
> Fecha: 2026-08-19
> Branch: `feat/214-wkh-316-payment-block-writer`
> Base medida: `main` @ `8242b16` · `npm test` = **286 archivos / 5624 passed | 19 skipped** · `npx tsc --noEmit` exit 0
> Dev lee SOLO este documento. Si algo no está acá, PARÁS y escalás al Architect.

---

## 🔴 LEER ANTES DE ESCRIBIR UNA LÍNEA — la trampa #1 de esta HU

**`src/routes/agents.publish.test.ts` NO inicializa el registry de adapters.** Está medido:
sus 4 `vi.mock` son `node:dns` (`:33`), `../lib/supabase.js` (`:38`), `../services/agent.js` (`:57`)
y `../middleware/a2a-key.js` (`:77`). **Ninguno es `../adapters/registry.js`.**

Consecuencia mecánica: `getAdaptersBundle(chainKey)` arranca con
`if (!_initialized) return undefined;` (`src/adapters/registry.ts:483-484`), así que en esa suite
**devuelve `undefined` para toda chain**, y el paso 3 del validador (AC-3) va a rechazar
**TODO** bloque `payment` con `PAYMENT_CHAIN_NOT_INITIALIZED`.

### Lo que va a pasar si no hacés nada

Escribís el test del camino feliz (`POST /agents` con `payment` válido → 201), lo ves en **422**,
y "arreglás" el guard de AC-3 para que no rechace. **Eso rompe la HU creyendo que la estás
terminando**: AC-3 es justamente la mitad de la HU que impide publicar una fila que nunca va a cobrar.

### Mitigación OBLIGATORIA — textual

> **En TODO archivo de test donde una llamada tenga que llegar a `validatePaymentBlock` con un
> bloque que se espera ACEPTADO, se agrega un `vi.mock('../adapters/registry.js', …)` construido
> con `importOriginal` + spread + override explícito de `getAdaptersBundle` y
> `getInitializedChainKeys`. PROHIBIDO tocar el orden o la condición de los guards de
> `validatePaymentBlock` para que un test pase. Si un test da 422 inesperado, el bug está en el
> mock del test, no en el guard.**

Aplica a **tres** archivos, no a uno (los tres ejercitan código real que llama al validador):

| Archivo | Por qué llega al validador |
|---|---|
| `src/routes/agents.publish.test.ts` | mockea el service, así que el guard del **route** es el que corre |
| `src/routes/agents.ownership.test.ts` | usa el service **REAL** + supabase mockeado (docblock `:5-6`) → corre la defense-in-depth |
| `src/services/agent.payment.test.ts` | llama al service **REAL** (`:48`) → corre la defense-in-depth |

**Exemplar VERIFICADO del mock correcto** — `src/routes/well-known.test.ts:37-54`. Copiar la forma,
no los valores. Su propio docblock (`:27-35`) explica por qué un factory sin `importOriginal` deja
el resto de los exports en `undefined` y explota la suite entera por un motivo ajeno a lo que se prueba:

```ts
vi.mock('../adapters/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/registry.js')>();
  return {
    ...actual,                                  // ← sin esto, el resto queda undefined
    getInitializedChainKeys: () => ['solana-devnet', 'avalanche-fuji'],
    getAdaptersBundle: (chainKey?: string) =>
      chainKey === 'solana-devnet' || chainKey === 'avalanche-fuji'
        ? { payment: { supportedTokens: [{ symbol: 'USDC' }] } }
        : undefined,
  };
});
```

⚠️ El override de `getAdaptersBundle` **debe seguir devolviendo `undefined` para al menos una
chain conocida**, o el test de AC-3 (`T-316-05`) no puede ponerse rojo nunca.

---

## ⚠️ Tres cosas del work-item que están MEDIDAS COMO FALSAS. El SDD manda.

**1. La justificación original de la HU está VENCIDA.**
El work-item (`work-item.md:414-419`) dice que esta HU "bloquea el cobro del KYC en Solana" porque
`remit-kyc-validator` tendría `payment: null`. **Medido contra producción el 2026-08-18:
`GET /discover` devuelve para ese agente el bloque Solana completo.** Alguien lo sembró a mano
fuera del repo después de que se escribiera ese texto.
👉 **La HU sigue siendo necesaria** por el camino de escritura **por API** y porque **desbloquea
WKH-314**. 👉 **PROHIBIDO** repetir la justificación del KYC en cualquier docblock, comentario,
README o mensaje de commit de este diff (CD-A2).

> 🔴 **CALIBRACIÓN DEL DEV (2026-08-19, W0), a pedido del orquestador — "desbloquea WKH-314" hay que
> calificarlo.** Lo que 314 espera de esta HU es **documentación**, no mecanismo. Medido en el árbol:
> `readPaymentSpec` tiene exactamente **dos** consumidores de producción —`src/services/discovery.ts:1380`
> y `src/services/agent.ts:164` (`:156` antes de mi diff de W0)— y **ninguno de los dos está en el
> camino de `requirePayment`**. La intersección real de Scope IN entre las dos HUs es **un solo
> archivo: `doc/INTEGRATION.md`**.
> 👉 **PROHIBIDO escribir "esto bloquea a WKH-314" sin calificar** en cualquier docblock, README o
> mensaje de commit de este diff. Lo que se bloquea es la wave de docs. Es el mismo CD-A2 de arriba.

**2. El conjunto a migrar está VACÍO. No hay backfill, no hay wave de migración.**
`GET /discover?limit=200` → **25 de 25 agentes con bloque `payment`**, de los cuales sólo **3 son
`self-published`** (los únicos que este escritor alcanza: los otros 22 son federados de `wasiai-v2`
y su `payment` lo sirve ese registry, no `a2a_agents`). Los 3 alcanzables ya son válidos contra 5
de los 6 guards. 👉 **Cero filas que tocar. Cero DDL. Cero migración** (CD-14).

**3. Las citas del work-item están corridas, y un archivo del Scope IN no existe.**
`types/index.ts:191-218` es en realidad **`:282-309`**; `agent.ts:177-189` es **`:186-198`**;
`agent.ts:556-571` es **`:645-660`**. Todas las de ESTE documento fueron re-abiertas contra
`8242b16`. 👉 **`src/services/agent.test.ts` NO EXISTE** (verificado con `ls`): el work-item lo
lista en su Scope IN y es falso. **No lo crees.** Los tests del service de esta HU van a
`src/services/agent.payment.test.ts`.

---

## Goal

`POST /agents` y `PATCH /agents/:slug` aceptan un bloque `payment` opcional
(`{ method, chain, contract, asset? }`) y lo persisten dentro de la columna JSONB
`a2a_agents.metadata`, detrás de **siete guards de write-boundary** que impiden publicar una ficha
que jamás va a poder cobrar. WKH-241 construyó el **lector** (`src/lib/payment-spec-reader.ts`) y
corre en producción; **el escritor nunca existió**, así que hoy un tercero que publica por API no
puede declarar en qué red cobra. Esta HU no toca el settle, ni el lector, ni los adapters, ni la DB.

---

## Acceptance Criteria (EARS)

> Copiados del work-item (`work-item.md:129-194`). Los cambios que el SDD hizo sobre ellos están
> anotados en línea y son normativos.

- **AC-1** — WHEN a `POST /agents` request authenticated with a valid a2a-key includes
  `payment: { method, chain, contract, asset? }` that passes every guard of AC-2..AC-6 and AC-10,
  the system SHALL persist that block under the `payment` key of the row's `metadata` JSONB, SHALL
  return it in the 201 response body, and the subsequent `GET /discover` SHALL expose it as
  `agent.payment` through the existing reader (`payment-spec-reader.ts`) with no change to that reader.
  > ⚠️ **"verbatim" del work-item queda ANULADO por CD-10**: se persiste una **whitelist explícita
  > de 4 keys**, con `trim()` en `chain`, `contract` y `asset`. Ver §"Qué se persiste".

- **AC-2** — IF the declared `payment.chain` does not resolve to a `ChainKey` via `normalizeChainSlug`
  (`src/adapters/chain-resolver.ts:419`), THEN the system SHALL reject with `422` and
  `error_code: INVALID_PAYMENT_CHAIN`, and SHALL NOT insert, update or otherwise touch any row of
  `a2a_agents`.

- **AC-3** — IF the declared `payment.chain` resolves to a `ChainKey` that the running registry has
  NOT initialized (`getAdaptersBundle(chainKey) === undefined`), THEN the system SHALL reject with
  `422` and `error_code: PAYMENT_CHAIN_NOT_INITIALIZED`, and the response SHALL include the
  actionable list `getInitializedChainKeys()`.

- **AC-4** — IF the declared `payment.contract`, after trimming surrounding whitespace, does not
  satisfy `isValidPayoutWallet(contract, ns)` where `ns` comes from `getChainVmFamily(chainKey)`
  (`src/adapters/chain-resolver.ts:129`), THEN the system SHALL reject with `422` and
  `error_code: INVALID_PAYMENT_PAYTO_FORMAT`; AND WHILE validating or persisting the value the
  system SHALL NOT alter its letter case (un `0x…` en un slot Solana y un base58 en un slot EVM son
  **los dos** rechazados por esta única regla).

- **AC-5** — IF the declared `payment.contract` is the EVM zero address (in any letter case) for an
  EVM chain, or the all-zero Solana pubkey `11111111111111111111111111111111` for a Solana chain,
  THEN the system SHALL reject with `422` and `error_code: ZERO_PAYMENT_PAYTO`.

- **AC-6** — IF the declared `payment.contract` equals the gateway operator's own address for that VM
  family AND that address is resolvable in the running process, THEN the system SHALL reject with
  `422` and `error_code: PAYTO_IS_OPERATOR`; WHERE the operator address is not resolvable, the system
  SHALL accept the request and SHALL log `code: PAYTO_OPERATOR_CHECK_SKIPPED`.

- **AC-7** — WHEN a `PATCH /agents/:slug` request includes `payment`, the system SHALL apply the same
  guards as AC-2..AC-6 and AC-10, SHALL resolve authorization through the EXISTING ownership guard of
  `publishedAgentService.update`, SHALL respond `404 Agent not found` when the caller is not the
  owner, and SHALL merge the block over the existing `metadata` WITHOUT deleting `inputSchema`,
  `outputSchema` or `discoverable`.

- **AC-8** — WHEN a `PATCH /agents/:slug` request sends `payment: null` explicitly, the system SHALL
  delete the `payment` key from that row's `metadata` and SHALL leave every other key of `metadata`
  byte-identical.

- **AC-9** — WHILE a row's `metadata` has not been written by this HU's write path, the system SHALL
  return byte-identical `GET /discover` and `GET /capabilities` JSON for that agent, SHALL NOT
  re-validate the `payment` block already stored in the seeded Solana rows, and SHALL NOT rewrite,
  normalize or migrate any pre-existing `metadata`.
  > ⚠️ Corrección medida: son **TRES** filas sembradas, no dos (`remit-corridor-fx-solana`,
  > `remit-cashout-payout-solana`, `remit-kyc-validator`).

- **AC-10** — IF `payment` is present and `payment.method` is not exactly the string `x402`, THEN the
  system SHALL reject with `422` and `error_code: UNSUPPORTED_PAYMENT_METHOD`.

- **AC-11** — WHERE the request body omits `payment` entirely, the system SHALL behave exactly as
  today: no `payment` key is written to `metadata`, `buildMetadata` still returns `null` when no other
  metadata field is present, and the resulting `Agent.payment` remains `undefined`.

- **AC-12** — WHEN `payment` is present and `payment.asset` is present, the system SHALL compare it
  case-insensitively against `supportedTokens[0].symbol` of the resolved chain's payment adapter and
  SHALL reject a mismatch with `422` and `error_code: PAYMENT_ASSET_MISMATCH`.
  > ✅ **La condicional del work-item quedó RESUELTA en F2: AC-12 es ESTRICTO.** El símbolo del
  > adapter Solana es el literal `'USDC'` (`src/adapters/solana/payment.ts:82`, usado en
  > `supportedTokens` en `:306`), así que la condición de degradación es falsa.
  > **Consecuencia asumida a propósito, escribila en la doc y no la "arregles"**: declarar
  > `asset: "USDC"` para `kite-ozone-testnet` **da 422 hoy**, porque ese riel usa
  > `process.env.X402_TOKEN_SYMBOL ?? 'PYUSD'` (`src/adapters/kite-ozone/payment.ts:164`), y
  > `tempo-testnet` usa `'AlphaUSD'` (`src/adapters/tempo/payment.ts:61`). Es correcto: `asset` es
  > decorativo (ningún camino de settle lo lee), así que rechazarlo **no puede mover un centavo**;
  > sólo evita que el catálogo mienta.

---

## Files to Modify/Create

⚠️ **Las líneas de esta tabla son de `main` @ `8242b16`, ANTES de tu diff.** Después de W0 se corren.
Re-verificalas con `sed -n 'Np'` antes de citarlas en cualquier docblock (CD-A1).

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `src/types/index.ts` | Modificar | `AgentPaymentSpecInput` (interfaz nueva, 4 campos) + `payment?: AgentPaymentSpecInput` en `PublishAgentInput` (`:282`) + `payment?: AgentPaymentSpecInput \| null` en `UpdateAgentInput` (`:315`) | `AgentPaymentSpec` (`:200-262`) |
| 2 | `src/lib/operator-address.ts` | **Crear** (~45 LOC) | `resolveOperatorAddress(family)` — nunca lanza, cachea por familia (incluido el `null`), `await import()` para Solana | `resolveTreasury` (`src/adapters/deposit-verifier.ts:161-176`) |
| 3 | `src/lib/operator-address.test.ts` | **Crear** | Tests de #2 (T-316-11) | `src/lib/payment-spec-reader.test.ts` |
| 4 | `src/lib/payment-spec-writer.ts` | **Crear** (~150 LOC) | `validatePaymentBlock()` (los 7 pasos) · `readStoredPaymentBlock()` · `logPaymentBlockChange()` | `src/lib/payment-spec-reader.ts` (docblock leaf `:1-18`) |
| 5 | `src/lib/payment-spec-writer.test.ts` | **Crear** | El grueso de los ACs (T-316-04..10, 19, 21, 22, 23) | `src/lib/payment-spec-reader.test.ts` |
| 6 | `src/routes/agents.ts` | Modificar | Guard 422 en POST (después del guard de `referrerRef`, que termina en `:225`) y en PATCH (después del guard de `capabilities`, que termina en `:410`); captura condicional en el `input` del POST (bloque `:230-261`) | `isValidPayoutWalletForChain` (`:74-95`) + su uso en `:197-210` |
| 7 | `src/services/agent.ts` | Modificar | `PublishedAgentRecord.payment` (`:65-77`) · `mapRowToRecord` (`:161-180`) · `buildMetadata` (`:186-198`) · merge del PATCH (`:645-660`) · defense-in-depth en `publish` (`:392-397`) y `update` (`:604-614`) · llamada al log de auditoría | `readSchema` (`:99-108`), `assertValidPayoutWallet` (`:242-248`), `buildMetadata` (`:186-198`) |
| 8 | `src/routes/agents.publish.test.ts` | Modificar | Tests de route del POST (T-316-01, 20) + **el mock del registry** | su propio harness (`:27-84`) |
| 9 | `src/routes/agents.ownership.test.ts` | Modificar | Tests de route del PATCH: AC-7 cross-owner → 404 (T-316-12) + **el mock del registry** | su propio harness (`:34-45`) |
| 10 | `src/services/agent.payment.test.ts` | Modificar | Persistencia, merge, borrado, byte-identidad, whitelist en el PATCH (T-316-02, 03, 13..18, 25) + **el mock del registry** | su propio harness (`:15-46`) |
| 11 | `doc/INTEGRATION.md` | Modificar | Subsección nueva en §3 (`:151`) — `POST /agents` **no está documentado en ninguna parte hoy**, verificado | tabla de skip-codes (`:634-644`) |
| 12 | `README.md` | Modificar | Una línea en la fila de `/agents` (`:287`) apuntando a la subsección nueva de INTEGRATION | la propia tabla (`:280-293`) |

**NO se toca nada más.** En particular: cero DDL, cero migración, y la fila `214` de
`doc/sdd/_INDEX.md` **ya existe** (`:181`) — no la reescribas (eso es F4/DONE).

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 13 | `test/ownership-filter-guard.exceptions.ts` | Modificar (**sólo re-apuntar**) | Correr el `line` de las entradas de `src/services/agent.ts` por el desplazamiento que produzca este diff, y las citas de prosa **dentro de esas mismas entradas** que apunten a `src/services/agent.ts` | las propias entradas |

> 🔴 **CORRECCIÓN DEL DEV (2026-08-19, W0) — esta fila la agregó el Dev, no el Architect.**
> El Story File decía *"`test/ownership-filter-guard.exceptions.ts` **no se toca** (esta HU no
> agrega ni una cadena `supabase.from(...)` nueva)"*. **La premisa es cierta y la conclusión no se
> sigue**, y está medido: agregar 8 líneas a `src/services/agent.ts` (1 de import + 7 del campo
> `PublishedAgentRecord.payment`) dejó `npm test` en **2 failed | 5622 passed** —
> `test/ownership-filter-guard.test.ts` G-08 y G-09—, **sin una sola query nueva**. El motivo es
> que ese archivo fija cada excepción por `{ file, line }`: lo que lo rompe es el
> **desplazamiento**, no la cadena.
>
> **Alcance permitido de esta fila, y nada más:** correr el número de línea de entradas que YA
> existen, y las citas de prosa que este diff desplazó dentro de esas mismas entradas.
> ⛔ **PROHIBIDO agregar una entrada nueva, reescribir un motivo, o tocar entradas de otros
> archivos.** Si tu diff necesita una entrada NUEVA, eso significa que agregaste una cadena
> `supabase.from(...)` sin filtro de dueño: **parás y escalás** (CD-5, BLOQUEANTE en AR).
> ⛔ Y las líneas nuevas se obtienen **leyendo el código** (`sed -n 'Np'`), nunca volcando la salida
> del escáner — lo exige el `CLAUDE.md` del repo para este archivo en particular.
>
> Cambio de W0 (auditable): `318→326`, `343→351`, `454→462`, `494→502`, `527→535` (todas `+8`), y
> dentro de esas 5 entradas `:330-335→:338-343`, `:450→:458`, `:580→:588`, `:701→:709`, `:407→:415`.
> **Se vuelve a correr en W3B**, que edita el mismo archivo.

---

## Contrato de Integración ⚠️ BLOQUEANTE

### Caller (tercero / WKH-317) → `POST /agents` · `PATCH /agents/:slug`

**Request — el campo nuevo (opcional en las dos rutas):**

```json
{
  "payment": {
    "method":   "x402",
    "chain":    "solana-devnet",
    "contract": "64KKjZFSMZRucKPqTpGydrUFeFdLHDhbHTJVGmEaXS6z",
    "asset":    "USDC"
  }
}
```

| Campo | Tipo | Obligatorio | Semántica |
|---|---|---|---|
| `method` | `string` | sí | Debe ser **exactamente** `"x402"`. Sin trim, sin lowercase: `"X402"` y `" x402 "` se rechazan. |
| `chain` | `string` | sí | Alias que `normalizeChainSlug` conozca **y** riel inicializado en este proceso. |
| `contract` | `string` | sí | ⚠️ **ES LA BILLETERA DE COBRO (el `payTo`), NO un token ni un contrato.** El nombre miente y ya produjo un bloqueante rojo falso — está documentado en `src/types/index.ts:203-225`. |
| `asset` | `string` | no | Etiqueta. Se compara case-insensitive contra `supportedTokens[0].symbol` del riel. |

**Response `PATCH` para borrar el bloque:** `{"payment": null}` (el `null` **explícito** es la
señal de borrado; `undefined` / ausente = "no lo toques").

**Response exitoso** — `201` (POST) / `200` (PATCH), body = `PublishedAgentRecord` con el campo
nuevo `payment` presente **sólo si la fila tiene bloque** (nunca `payment: null`, nunca
`payment: undefined` serializado):

```json
{
  "slug": "mi-agente",
  "name": "Mi Agente",
  "priceUsdc": 0.5,
  "enabled": true,
  "discoverable": false,
  "createdAt": "2026-08-19T00:00:00.000Z",
  "payment": { "method": "x402", "chain": "solana-devnet", "contract": "64KK…", "asset": "USDC" }
}
```

**Errores — los 8 `error_code` nuevos, todos `422`:**

```json
{
  "error": "Invalid payment",
  "error_code": "INVALID_PAYMENT_CHAIN",
  "field": "payment.chain",
  "reason": "payment.chain must be a chain slug this gateway knows"
}
```

| `error_code` | `field` | `reason` (literal, ESTÁTICO — CD-8) | Cuándo |
|---|---|---|---|
| `INVALID_PAYMENT_BLOCK` | `payment` | `payment must be an object with string method, chain and contract` | `payment` presente pero no es objeto, es array, o falta/está vacío alguno de los 3 strings |
| `UNSUPPORTED_PAYMENT_METHOD` | `payment.method` | `payment.method must be exactly "x402"` | AC-10 |
| `INVALID_PAYMENT_CHAIN` | `payment.chain` | `payment.chain must be a chain slug this gateway knows` | AC-2 |
| `PAYMENT_CHAIN_NOT_INITIALIZED` | `payment.chain` | `payment.chain is not an active rail in this deployment` | AC-3 — **agrega además `"initializedChains": [...]`** |
| `INVALID_PAYMENT_PAYTO_FORMAT` | `payment.contract` | `payment.contract must be a valid payout address for its chain family` | AC-4 |
| `ZERO_PAYMENT_PAYTO` | `payment.contract` | `payment.contract must not be the zero address` | AC-5 |
| `PAYTO_IS_OPERATOR` | `payment.contract` | `payment.contract must not be the gateway operator address` | AC-6 |
| `PAYMENT_ASSET_MISMATCH` | `payment.asset` | `payment.asset does not match the token this rail settles` | AC-12 |

⚠️ **Ningún `reason` refleja el valor recibido** (CD-8, patrón de `src/routes/agents.ts:205-209`).
El valor va a `request.log.warn({ field, code }, '…')`.

⚠️ **`initializedChains` NO es disclosure.** `getInitializedChainKeys()` ya es público y sin auth en
`GET /capabilities` (`chains[].key`), medido hoy contra producción.

⚠️ **Un no-dueño con bloque inválido recibe 422, no 404** — el guard del route corre antes que el
guard de dueño (que vive dentro de `update()`). Disclosure: cero, porque la validación depende sólo
del input del caller y de config ya pública.

---

## Diseño — lo que hay que construir, exactamente

### A. `src/types/index.ts` (W0)

```ts
/**
 * WKH-316 — lo que un agente DECLARA al publicar. NO es `AgentPaymentSpec`:
 * ese tipo tiene además `resolvedChain` y `network`, que los DERIVA el gateway
 * (`payment-spec-reader.ts:212-213`) y que el caller no puede escribir (CD-11).
 */
export interface AgentPaymentSpecInput {
  method: string;           // debe ser exactamente 'x402' (AC-10)
  chain: string;            // alias que `normalizeChainSlug` conozca (AC-2)
  contract: string;         // ⚠️ la BILLETERA DE COBRO (payTo), NO un token
  asset?: string;           // etiqueta; se compara con supportedTokens[0].symbol (AC-12)
}
```

- `PublishAgentInput.payment?: AgentPaymentSpecInput`
- `UpdateAgentInput.payment?: AgentPaymentSpecInput | null` (`null` explícito = borrar, AC-8)
- `PublishedAgentRecord.payment?: AgentPaymentSpecInput` (en `src/services/agent.ts:65-77`)

### B. `src/lib/operator-address.ts` (W1)

```ts
export type OperatorFamily = 'evm' | 'solana';
export async function resolveOperatorAddress(family: OperatorFamily): Promise<string | null>;
```

- **EVM**: `privateKeyToAccount(process.env.OPERATOR_PRIVATE_KEY as \`0x${string}\`).address` dentro
  de `try/catch` → `null` ante cualquier fallo. Copia exacta del patrón de
  `src/adapters/deposit-verifier.ts:167-173`. `viem` **ya es dependencia directa**.
- **Solana**: `await import('../adapters/solana/chain.js')` →
  `getSolanaOperatorKeypair().publicKey.toBase58()` dentro de `try/catch` → `null`.
- **Cachea el resultado por proceso y por familia, incluido el `null`.**
- **NUNCA lanza.** Es la única garantía que el caller necesita.

⚠️ **Costo declarado de la rama Solana, y por qué el `catch` NO puede ser silencioso.**
`getSolanaOperatorKeypair()` (`src/adapters/solana/chain.ts:84`) no es un getter puro: loguea
(`:95`) y corre la aserción de coherencia depósito↔operador de WKH-315 (`:137-149`), **que lanza**.
Si el proceso todavía no había cargado el keypair, esta HU sería la primera en dispararla y el
`catch` se tragaría un error de configuración que hoy explota ruidosamente en el settle.
👉 **El `catch` DEBE loguear `code: 'PAYTO_OPERATOR_CHECK_SKIPPED'` junto con `err.message`
(server-side, nunca al cliente).** Un `catch {}` vacío acá es **BLOQUEANTE en AR**.

⚠️ **CD-13 — el import de Solana es `await import()`, JAMÁS estático.** Un import estático de
`@solana/web3.js` desde `src/lib/` lo carga en todo proceso que sirva rutas — que es exactamente lo
que `src/adapters/registry.ts` evita (sus imports top-level `:1-16` son sólo `lib/logger`,
`chain-resolver` y tipos; **todos** los adapters entran por `await import()` dentro de `buildBundle`).

### C. `src/lib/payment-spec-writer.ts` (W2) — módulo LEAF, el único validador

```ts
export type PaymentBlockRejection =
  | { code: 'INVALID_PAYMENT_BLOCK';         field: 'payment' }
  | { code: 'UNSUPPORTED_PAYMENT_METHOD';    field: 'payment.method' }
  | { code: 'INVALID_PAYMENT_CHAIN';         field: 'payment.chain' }
  | { code: 'PAYMENT_CHAIN_NOT_INITIALIZED'; field: 'payment.chain'; initializedChains: string[] }
  | { code: 'INVALID_PAYMENT_PAYTO_FORMAT';  field: 'payment.contract' }
  | { code: 'ZERO_PAYMENT_PAYTO';            field: 'payment.contract' }
  | { code: 'PAYTO_IS_OPERATOR';             field: 'payment.contract' }
  | { code: 'PAYMENT_ASSET_MISMATCH';        field: 'payment.asset' };

export type PaymentBlockResult =
  | { ok: true;  block: AgentPaymentSpecInput; operatorCheckSkipped: boolean }
  | { ok: false; rejection: PaymentBlockRejection };

export async function validatePaymentBlock(raw: unknown): Promise<PaymentBlockResult>;
export function readStoredPaymentBlock(meta: Record<string, unknown>): AgentPaymentSpecInput | undefined;
export function logPaymentBlockChange(args: { … }): void;
```

**Orden de los guards — NORMATIVO (CD-12). El primero que falla gana.**
Motivo mecánico: los pasos 4-7 dependen del `chainKey` y del `bundle` que resuelven los pasos 2-3;
invertirlos produce un `undefined` en runtime o un `field` que apunta al campo equivocado.

| Paso | Guard | Rechazo | AC |
|---|---|---|---|
| 0 | `raw` es objeto no-array; `method`/`chain`/`contract` son strings no vacíos tras `trim()` | `INVALID_PAYMENT_BLOCK` | — |
| 1 | `method === 'x402'` **exacto** (sin trim, sin lowercase) | `UNSUPPORTED_PAYMENT_METHOD` | AC-10 |
| 2 | `chainKey = normalizeChainSlug(chain.trim())` ≠ `undefined` | `INVALID_PAYMENT_CHAIN` | AC-2 |
| 3 | `bundle = getAdaptersBundle(chainKey)` ≠ `undefined` | `PAYMENT_CHAIN_NOT_INITIALIZED` + `getInitializedChainKeys()` | AC-3 |
| 4 | `isValidPayoutWallet(contract.trim(), getChainVmFamily(chainKey))` | `INVALID_PAYMENT_PAYTO_FORMAT` | AC-4 |
| 5 | no es la zero-address de la familia | `ZERO_PAYMENT_PAYTO` | AC-5 |
| 6 | `asset` presente ⇒ coincide (case-insensitive) con `supportedTokens[0].symbol` | `PAYMENT_ASSET_MISMATCH` | AC-12 |
| 7 | `op = await resolveOperatorAddress(family)`; si `op !== null` y coincide ⇒ rechazo. Si `op === null` ⇒ **acepta** y marca `operatorCheckSkipped: true` | `PAYTO_IS_OPERATOR` | AC-6 |

**Paso 3 — llamá SIEMPRE con el `chainKey` explícito.** `getAdaptersBundle()` **sin argumento cae
al `_defaultChainKey`** (`src/adapters/registry.ts:484-485`): un `getAdaptersBundle(chainKey ?? …)`
o un argumento olvidado haría pasar una chain no inicializada usando el bundle de otra.

**Paso 4 — el tipo casa sin cast.** `getChainVmFamily` devuelve `ChainVmFamily = 'evm' | 'solana'`
(`src/adapters/chain-resolver.ts:116`) e `isValidPayoutWallet` recibe
`WalletNamespace = 'evm' | 'solana'` (`src/lib/wallet-format.ts:123`). Son la misma unión de
literales: **prohibido un `as`** para unirlas.

**Paso 5 — dos ramas, no una:**

```ts
// EVM: el formato hex YA está garantizado por el paso 4 → toLowerCase() es seguro
// y NECESARIO (una address EVM es case-insensitive por EIP-55).
if (family === 'evm' && payTo.toLowerCase() === '0x' + '0'.repeat(40)) → ZERO_PAYMENT_PAYTO
// Solana: comparación EXACTA, sin tocar la caja. base58 es case-sensitive (CD-3).
if (family === 'solana' && payTo === '1'.repeat(32)) → ZERO_PAYMENT_PAYTO
```

⚠️ **AC-5 NO es redundante con AC-4, y está medido.** `'1'.repeat(32)` (la pubkey de todos ceros /
System Program) **decodifica a 32 bytes exactos**, así que `isValidSolanaAddress`
(`src/lib/wallet-format.ts:52`, vía `base58DecodedByteLength(w) === 32`) **la ACEPTA**. Sin el paso
5, un agente podría publicar un payTo que quema todos sus fees.

**Paso 6 — landmine del compilador, y la decisión ya tomada.** `tsconfig.json` tiene
`noUncheckedIndexedAccess: true` (`:10`), así que `bundle.payment.supportedTokens[0]` es
`TokenSpec | SolanaTokenSpec | undefined` y **no compila** sin manejar el `undefined`.
👉 **Decisión normativa (DT-STORY-1): si `supportedTokens[0]` es `undefined`, el paso 6 se SALTEA
(acepta) y se loguea `code: 'PAYMENT_ASSET_CHECK_SKIPPED'` con el `chainKey`.** Mismo criterio de
degradación explícita que AC-6. **PROHIBIDO `!` (non-null assertion) y PROHIBIDO `as TokenSpec`.**
Nota: `symbol: string` existe en las dos mitades de la unión (`src/adapters/types.ts:7` y `:115`),
así que **no hace falta narrowing** por `vmFamily` para leerlo — sólo el `?.`.

**Paso 7 — misma disciplina que el paso 5**: EVM `toLowerCase()` en ambos lados (el formato hex ya
está garantizado por el paso 4); Solana comparación exacta.

**`readStoredPaymentBlock(meta)`** — narrowing acotado del bloque **tal como está persistido** (las
4 keys), para `mapRowToRecord`. Es el gemelo de `readSchema` (`src/services/agent.ts:99-108`), **NO**
un segundo lector de discovery: `readPaymentSpec` sigue siendo el ÚNICO productor de `Agent.payment`
(CD-6).

**`logPaymentBlockChange(args)`** — vive acá, no en el service. `src/services/agent.ts` **no importa
ningún logger** (verificado, `:19-44`), y el precedente del repo para loguear PII-safe desde fuera
del service es `logOwnershipMismatch` (`src/services/security/errors.ts:494-545`). Este módulo crea
su propio `getLogger('payment-writer')`.

```ts
logPaymentBlockChange({
  op: 'publish' | 'update' | 'delete',
  slug,                                          // público (ya está en /discover)
  ownerRefHash: sha256(ownerRef).slice(0, 16),   // HASHEADO, como logOwnershipMismatch:517
  prev: { chain, contract } | null,
  next: { chain, contract } | null,
});
```

⚠️ **Por qué el `contract` va EN CLARO y el `owner_ref` hasheado.** El `owner_ref` es identidad de
inquilino y el repo ya lo hashea; el `contract` es la billetera de cobro, **ya publicada sin auth en
`GET /discover`** (medido: las 3 filas vivas la exponen), así que hashearlo no protege nada y
**destruye el único valor del log**: contestar "¿a qué billetera se repuntó, y cuándo?" el día que
un fee aparezca donde no debe.

### D. Qué se persiste, exactamente (CD-10 · CD-11)

```ts
// Whitelist EXPLÍCITA de 4 keys. PROHIBIDO { ...raw } / Object.assign({}, raw).
const persisted = {
  method: raw.method,                                           // ya validado === 'x402'
  chain:  raw.chain.trim(),                                     // trim sí, lowercase NO
  contract: raw.contract.trim(),                                // trim sí, lowercase NO (CD-3)
  ...(asset !== undefined ? { asset: raw.asset.trim() } : {}),  // trim sí, caja preservada
};
```

- **Por qué whitelist y no verbatim.** `AgentPaymentSpec` declara `resolvedChain`
  (`src/types/index.ts:238`) y `network` (`:261`) como **derivados por el gateway**. Con un spread,
  un caller escribiría `resolvedChain: 'avalanche-mainnet'` dentro del JSONB. Hoy `/discover` no
  cambiaría —`readPaymentSpec` los **recomputa siempre** (`src/lib/payment-spec-reader.ts:212-213`)—
  pero el valor envenenado quedaría en `metadata`, y `mapRowToRecord` (esta HU) y WKH-314 leen el
  bloque crudo.
- **Keys desconocidas: se descartan en SILENCIO, no se rechazan.** Mismo criterio que el `slug` del
  body del POST (`src/routes/agents.ts:227-229`). Un 422 por una key desconocida rompe la
  compatibilidad hacia adelante de una API pública de escritura.
- **Por qué `chain` se trimea aunque el work-item (DT-7) diga "verbatim" — desviación declarada:**
  `normalizeChainSlug` hace `raw.trim().toLowerCase()` internamente antes de resolver
  (`src/adapters/chain-resolver.ts:420-422`), así que `' avalanche '` **resuelve igual** y se
  persistiría con espacios, divergiendo del valor sobre el que el sistema actúa. Se trimea; **no** se
  cambia la caja, que es la mitad de DT-7 que sí importa.
- **`exactOptionalPropertyTypes: true`** (`tsconfig.json:11`): `asset` se agrega con spread
  condicional. **`{ asset: undefined }` no compila.**

### E. `src/routes/agents.ts` (W3A)

**POST** — insertar el guard **después** del guard de `referrerRef` (el que termina en `:225`) y
**antes** de armar el `input` (`:230`):

```ts
if (body.payment !== undefined) {
  const result = await validatePaymentBlock(body.payment);
  if (!result.ok) {
    request.log.warn(
      { field: result.rejection.field, code: result.rejection.code },
      'agent publish rejected: invalid payment',
    );
    return reply.status(422).send({ error: 'Invalid payment', … });
  }
}
```

Y la captura condicional junto a las demás (`:255-261`): `input.payment = result.block;`

**PATCH** — mismo guard, insertado **después** del guard de `capabilities` (termina en `:410`) y
**antes** de `publishedAgentService.update(...)` (`:412`). Mensaje del log:
`'agent update rejected: invalid payment'`.

⚠️ **El PATCH le pasa el `body` CRUDO al service** (`src/routes/agents.ts:412-416`), sin whitelist —
a diferencia del POST. Y **el sistema de tipos NO lo protege**: `Record<string, unknown>` **es
asignable** a `UpdateAgentInput` (todas sus props son opcionales), verificado con el compilador del
repo. **El único guard del PATCH es el de runtime.** De ahí la sección F.

### F. `src/services/agent.ts` (W3B) — 🔴 el punto donde se cierra el agujero del PATCH

> **REGLA NORMATIVA (DT-STORY-2): el bloque que se PERSISTE lo produce SIEMPRE el SERVICE, llamando
> a `validatePaymentBlock` y usando `result.block`. NUNCA se persiste `input.payment` /
> `updates.payment` tal como llegó.**

Por qué es obligatorio y no una elección de estilo: en el PATCH, `updates.payment` **es el objeto
crudo del caller** (ver §E). Si el service persistiera `updates.payment` directamente, un
`PATCH {"payment":{…,"resolvedChain":"avalanche-mainnet","network":"mainnet"}}` **escribiría esas
keys en el JSONB**, y CD-10/CD-11 quedarían burlados por la ruta que el route no whitelistea. La
validación corre dos veces por request (route para el 422, service para producir el bloque): es
exactamente el patrón ya establecido por `payoutWallet` (route `:197-210` → service `:242-248`), y
es barata (sin I/O: el único acceso externo, la address del operador, está cacheado).

Los cinco puntos:

1. **`PublishedAgentRecord`** (`:65-77`): agregar `payment?: AgentPaymentSpecInput;`.
2. **`mapRowToRecord`** (`:161-180`): `const payment = readStoredPaymentBlock(meta);` y
   `if (payment !== undefined) record.payment = payment;` — **exactamente** el patrón de
   `:177-178`. ⚠️ **Nunca asignar `null`** (AC-11 lo prohíbe explícitamente).
3. **`buildMetadata`** (`:186-198`): agregar `payment` al tipo del parámetro y
   `if (source.payment !== undefined) meta.payment = source.payment;`. El `return
   Object.keys(meta).length > 0 ? meta : null` de `:197` **se mantiene tal cual**.
4. **`publish()`** (`:392-397`, junto a `assertValidPayoutWallet`): si `input.payment !== undefined`,
   correr `validatePaymentBlock`; si `!result.ok` → `throw new Error('Invalid payment')`; si `ok` →
   usar `result.block` para construir el metadata. Después del INSERT exitoso:
   `logPaymentBlockChange({ op: 'publish', prev: null, next: … })`.
5. **`update()`**:
   - defense-in-depth junto a los otros guards (`:604-614`), **después** del guard de dueño
     (`:571-588`) — un no-dueño ya salió por `OwnershipMismatchError`;
   - **la condición del merge** (`:645-651`) hoy sólo mira `inputSchema`/`outputSchema`/`discoverable`:
     **hay que agregarle `|| updates.payment !== undefined`**. Ojo: `payment: null` también entra
     (`null !== undefined`), y tiene que entrar — es el borrado (AC-8);
   - dentro del merge (`:652-659`): `payment` presente y no-null → `meta.payment = result.block`;
     `payment === null` → `delete meta.payment`;
   - **R-7 (colapso a `null`)**: si tras el merge `Object.keys(meta).length === 0`, escribir
     `updateRow.metadata = null` en vez de `{}`, igual que `buildMetadata:197`. Es inalcanzable por
     cualquier otro camino (los otros tres campos sólo **asignan**, nunca borran), así que **no
     cambia el comportamiento de ningún PATCH existente**. `metadata?: Json | null` acepta el `null`
     (`src/types/database.types.ts:87`);
   - después del UPDATE exitoso: `logPaymentBlockChange({ op: 'update' | 'delete', prev, next })`,
     donde `prev` sale de `readStoredPaymentBlock(readMetadataObject(existing.metadata))`.

⚠️ **CD-7 se cumple POR CONSTRUCCIÓN si seguís el patrón de `:652`** (`readMetadataObject(existing.metadata)`
y mergear encima). **Escribir el objeto `metadata` desde cero es BLOQUEANTE**: borraría en silencio
los schemas de los agentes que ya los tienen.

⚠️ **CD-5 / ownership.** Esta HU **no agrega ni una sola cadena `supabase.from(...)` nueva**: toda
escritura pasa por el INSERT de `publish()` (`:432-436`) y por el UPDATE ya filtrado de `update()`
(`:662-668`, con `.eq('slug', slug).eq('owner_ref', ownerRef)`). Si tu diff introduce un
`.from('a2a_agents')` nuevo, **parás y escalás**: `test/ownership-filter-guard.test.ts` lo va a
detectar y es BLOQUEANTE en AR.

---

## Constraint Directives

### OBLIGATORIO

- **CD-1** — `GET /discover` y `GET /capabilities` **no cambian** para un agente no modificado.
  Byte-identidad demostrada con test contra un literal escrito a mano (T-316-17).
- **CD-9** — Los guards viven **en un solo lugar**: `validatePaymentBlock`. El route la llama para el
  422 y el service la llama para producir el bloque. **PROHIBIDO** re-implementar cualquiera de los
  7 chequeos en `routes/agents.ts` o en `services/agent.ts`.
- **CD-10** — El bloque persistido se arma con **whitelist explícita de 4 keys**. `{ ...raw }` o
  `Object.assign({}, raw)` sobre el input del caller es **BLOQUEANTE**.
- **CD-12** — El orden de los 7 guards es **normativo**.
- **CD-13** — El acceso al keypair de Solana es por **`await import()`**, nunca estático.
- **CD-14** — `payment` es **opcional en las dos rutas**. Un `POST /agents` **sin** `payment` debe
  comportarse **byte-idéntico** a hoy (AC-11).
- **CD-8** — Mensajes al cliente **estáticos**; el valor recibido va al `request.log.warn`.
- **DT-STORY-1** — `supportedTokens[0]` undefined ⇒ saltear el paso 6 + loguear
  `PAYMENT_ASSET_CHECK_SKIPPED`. Sin `!`, sin `as`.
- **DT-STORY-2** — El bloque persistido lo produce el **service**, desde `result.block`.

### PROHIBIDO

- **CD-2** — PROHIBIDO un segundo validador de chain o de wallet. Se usan EXACTAMENTE
  `normalizeChainSlug`, `getChainVmFamily`, `getAdaptersBundle`, `getInitializedChainKeys`,
  `isValidPayoutWallet`. **Prohibido** un `Set` de slugs nuevo, un regex de address nuevo, o un
  decoder base58 nuevo (`isValidSolanaAddress` ya existe, `src/lib/wallet-format.ts:52`).
- **CD-3** — PROHIBIDO `toLowerCase()` / `toUpperCase()` sobre `contract` en cualquier punto del
  write path. **Única excepción**: la comparación **dentro de la rama EVM**, después de que el paso 4
  garantizó el formato hex (pasos 5 y 7). Base58 es case-sensitive: bajarle la caja a una pubkey
  Solana produce otra cadena, y si por casualidad decodifica a 32 bytes produce **otra billetera**.
- **CD-4** — PROHIBIDO derivar `payment` de `payout_wallet`/`payout_chain`, o viceversa. Son cosas
  distintas: `payout_wallet` es la pata del creator-split del 1%; `payment.contract` es el payTo del
  **precio completo**.
- **CD-5** — PROHIBIDA cualquier query o mutación nueva sobre `a2a_agents` que no filtre por
  `owner_ref` además del `slug`. **BLOQUEANTE en AR.**
- **CD-6** — PROHIBIDO modificar `src/lib/payment-spec-reader.ts`, `src/lib/downstream-payment.ts`,
  `src/adapters/**` y `src/services/discovery.ts`.
- **CD-7** — PROHIBIDO escribir `metadata` desde cero en el PATCH. **BLOQUEANTE.**
- **CD-11** — PROHIBIDO aceptar, persistir o devolver `resolvedChain` y `network` desde el input del
  caller.
- **Dependencias nuevas: NINGUNA.** `viem` y `@solana/web3.js` ya son dependencias directas.
- PROHIBIDO tocar archivos fuera de la tabla "Files to Modify/Create".
- PROHIBIDO crear `src/services/agent.test.ts` (no existe y no debe existir).
- PROHIBIDO agregar el chequeo de zero-pubkey a la rama Solana del **settle** — queda como deuda
  declarada **TD-SOLANA-ZERO-PAYTO-SETTLE**.

### Auto-Blindaje — los 6 errores que rompieron las últimas 3 HUs cerradas

> Destilados de `doc/sdd/223-coordinador-como-agente/auto-blindaje.md`,
> `doc/sdd/222-wkh-345-uuid-param-validation/auto-blindaje.md` y
> `doc/sdd/221-wkh-sec-04-owner-ref-dinero-y-disputas/auto-blindaje.md` (los tres verificados
> existentes). Cada uno se repitió en ≥2 de las 3, así que dejan de ser anécdota.

- **CD-A1 (3/3) — PROHIBIDO citar `archivo:línea` sin re-verificarla DESPUÉS de la última edición
  del diff.** Las tres HUs rompieron sus propias citas al editar: *"Mi propia aritmética de
  desplazamiento ubicó mal una cita"*, *"Mi propio find/replace me rompió la prosa y las citas"*,
  *"Mis propias ediciones corrieron las líneas que yo citaba"*.
  👉 **Al cerrar cada wave: re-abrir CADA cita escrita en esa wave con `sed -n 'Np'` y confirmarla.**
  Las líneas de ESTE Story File son de `8242b16` y **se van a correr en cuanto edites**.
- **CD-A2 (3/3) — PROHIBIDO escribir en un docblock, README o reporte una afirmación que no
  mediste en esa misma sesión.** *"Copié a un docblock una afirmación del Story File que no medí, y
  era falsa"*, *"dejé en falso un número publicado en los DOS README"*, *"Escribí un aserto sobre el
  fixture que yo había supuesto, no leído"*.
  👉 Regla operativa: cada frase que escribas debe poder completarse con **"esto sería falso si
  \_\_\_"**, y ese \_\_\_ tiene que ser un input concreto.
  👉 **Esta HU YA pagó ese precio**: el work-item afirma `remit-kyc-validator` con `payment: null` y
  hoy es falso.
- **CD-A3 (2/3) — PROHIBIDO declarar verde corriendo sólo los archivos tocados, y PROHIBIDO medir un
  exit code después de un pipe.** *"Corrí sólo los archivos que toqué y canté verde con 2 rojos en el
  árbol"*, *"Medí biome con un pipe y me dio el resultado tranquilizador"*.
  👉 Cierre de wave = `npm test` **completo** + `npx tsc --noEmit` + `npm run lint`, **sin pipe**,
  con el exit code leído directo.
- **CD-A4 (2/3) — Todo test negativo necesita su gemelo positivo, y hay que verificar POR QUÉ se
  puso rojo.** *"T-5 no puede matar al mutante que dice matar"*, *"Mi testigo moría por la razón
  BARATA"*.
  👉 Concreto acá: el test de AC-5 (zero pubkey Solana) debe fallar por `ZERO_PAYMENT_PAYTO` y **no**
  por `INVALID_PAYMENT_PAYTO_FORMAT`. **Se assertea el `error_code`, nunca sólo el `422`.**
- **CD-A5 (2/3) — PROHIBIDO citar un commit o un documento que todavía no está en el índice de git.**
- **CD-A6 — Al agregar un import nuevo a un módulo que otros tests mockean, revisar los mocks de
  TODOS sus consumidores.** *"El Story File listaba 3 mocks que rompen `tsc`; el cuarto rompe en
  RUNTIME y no estaba"*.
  👉 **Este es exactamente el riesgo #1 de arriba.** Antes de cerrar W3A/W3B: listar quién importa
  `src/routes/agents.ts` y `src/services/agent.ts` en tests, y revisar sus factories.

---

## Test Expectations

`npm test` = `vitest run`. **No existe script `qa`** en este repo: los scripts son `test`, `lint`
(`biome check src/` — **no cubre `test/`**) y `build`.
⚠️ **`npx vitest run > archivo` bajo el hook de `rtk` trunca a 500 chars y devuelve exit 0** — correr
**sin redirección**.

**Línea base a SUPERAR, no a igualar:** `286 archivos / 5624 passed | 19 skipped`, `tsc` exit 0.

| Test | AC / CD | Archivo | Qué prueba, y qué lo pondría rojo |
|---|---|---|---|
| `T-316-01` | AC-1 | `src/routes/agents.publish.test.ts` | POST con bloque válido → **201** y `body.payment` con las 4 keys. Rojo si `mapRowToRecord` no expone el campo. |
| `T-316-02` | AC-1 · CD-10 | `src/services/agent.payment.test.ts` | `publish()` con supabase espiado y un input **sucio** (con `resolvedChain`, `network`, `sarasa`) → el `insert` recibe `metadata.payment` con **exactamente** las 4 keys. |
| `T-316-03` | AC-1 | `src/services/agent.payment.test.ts` | Fila con el bloque recién escrito → `listAsAgents()[0].payment` sale por `readPaymentSpec` **con** `resolvedChain`/`network`. Round-trip escritor→lector sin tocar el lector. |
| `T-316-04` | AC-2 | `payment-spec-writer.test.ts` + route | `chain: 'polygon'` → `INVALID_PAYMENT_CHAIN` + 422. **Gemelo anti-vacuidad**: `chain: 'avalanche'` pasa el paso 2. **Y** el espía de supabase registra **cero** `insert`/`update`. |
| `T-316-05` | AC-3 | `payment-spec-writer.test.ts` | Registry con `{avalanche-fuji}` y `chain: 'solana-devnet'` → `PAYMENT_CHAIN_NOT_INITIALIZED` **y** `initializedChains` contiene `avalanche-fuji`. |
| `T-316-06` | AC-4 | `payment-spec-writer.test.ts` | Cruce de familias: base58 en slot EVM y `0x…` en slot Solana → los dos `INVALID_PAYMENT_PAYTO_FORMAT`. |
| `T-316-07` | AC-4 · CD-3 | `payment-spec-writer.test.ts` | **Anti-caja**: un payTo Solana con mayúsculas y minúsculas mezcladas se persiste **carácter por carácter idéntico** (`expect(block.contract).toBe(input)`). Rojo si alguien mete un `toLowerCase()`. |
| `T-316-08` | AC-5 · CD-A4 | `payment-spec-writer.test.ts` | `'1'.repeat(32)` → **`ZERO_PAYMENT_PAYTO`**. **Se assertea el `error_code`**: ese valor **pasa** `isValidSolanaAddress`, así que un rojo por `INVALID_PAYMENT_PAYTO_FORMAT` sería una muerte falsa. |
| `T-316-09` | AC-5 | `payment-spec-writer.test.ts` | `0x0000…0000` en 3 cajas distintas → `ZERO_PAYMENT_PAYTO` las 3 veces. |
| `T-316-10` | AC-6 | `payment-spec-writer.test.ts` | Con `resolveOperatorAddress` mockeado a una address: payTo igual ⇒ `PAYTO_IS_OPERATOR`; payTo distinto ⇒ acepta. EVM: la variante en otra caja **también** rechaza. |
| `T-316-11` | AC-6 | `src/lib/operator-address.test.ts` | `OPERATOR_PRIVATE_KEY` ausente / basura ⇒ `null` **sin lanzar**; `validatePaymentBlock` acepta y marca `operatorCheckSkipped`; se loguea `PAYTO_OPERATOR_CHECK_SKIPPED` **con el mensaje del error**. |
| `T-316-12` | AC-7 | `src/routes/agents.ownership.test.ts` | PATCH cross-owner con `payment` válido → **404** `Agent not found`, y el espía de supabase confirma **cero** `update`. |
| `T-316-13` | AC-7 · CD-7 | `agent.payment.test.ts` | `metadata` previo `{inputSchema, outputSchema, discoverable}` + PATCH **sólo** con `payment` → el `update` recibe las **4** keys. Rojo si se reescribe el objeto. |
| `T-316-14` | AC-7 | `agent.payment.test.ts` | El log de auditoría se emite con `prev` y `next`, y con `ownerRefHash` **≠** el `owner_ref` en claro (16 hex). |
| `T-316-15` | AC-8 | `agent.payment.test.ts` | PATCH `payment: null` sobre `{inputSchema, payment}` → el `update` recibe `{inputSchema}` y el `inputSchema` es el **MISMO** objeto (`toEqual` estricto). |
| `T-316-16` | AC-8 · R-7 | `agent.payment.test.ts` | PATCH `payment: null` sobre `{payment}` solo → `metadata: null`. |
| `T-316-17` | AC-9 · CD-1 | `agent.payment.test.ts` | **Byte-identidad**: dos filas — una con `metadata` sin `payment`, otra con el bloque sembrado real de las 3 filas vivas — pasan por `listAsAgents()` y se compara `JSON.stringify` contra un **literal escrito a mano**. Rojo ante cualquier key nueva, `payment: null` donde antes había ausencia, o reordenamiento. |
| `T-316-18` | AC-9 | `agent.payment.test.ts` | El bloque sembrado **no** se re-valida: una fila con `chain: 'polygon'` en `metadata.payment` se lee igual que hoy (el reader la omite) y **nada la reescribe**. |
| `T-316-19` | AC-10 | `payment-spec-writer.test.ts` | `'X402'`, `' x402 '` y `'eip3009'` → `UNSUPPORTED_PAYMENT_METHOD`. Gemelo: `'x402'` pasa. |
| `T-316-20` | AC-11 | `agents.publish.test.ts` + `agent.payment.test.ts` | POST **sin** `payment` → el `insert` recibe `metadata: null` y `record.payment` es `undefined` (**no** `null`). |
| `T-316-21` | AC-12 | `payment-spec-writer.test.ts` | Adapter con `supportedTokens[0].symbol = 'USDC'`: `asset: 'usdc'` **acepta** (case-insensitive), `asset: 'PEN'` → `PAYMENT_ASSET_MISMATCH`, `asset` ausente → acepta. |
| `T-316-22` | CD-10 · CD-11 | `payment-spec-writer.test.ts` | Input con `resolvedChain: 'avalanche-mainnet'`, `network: 'mainnet'` y `sarasa: 1` → el bloque devuelto tiene **exactamente** `['method','chain','contract','asset']` (`Object.keys`). |
| `T-316-23` | CD-2 | `payment-spec-writer.test.ts` | Espías sobre `normalizeChainSlug` / `isValidPayoutWallet` **delegando en el real** (patrón `agent.payment.test.ts:39-46`): si alguien escribió un validador paralelo, el espía no registra la llamada. |
| `T-316-24` | CD-9 | `test/` | Grep estructural sobre el fuente: `src/routes/agents.ts` y `src/services/agent.ts` **no** contienen un chequeo de address/chain propio para `payment`. |
| **`T-316-25`** | **CD-10 vía PATCH** | `agent.payment.test.ts` | 🔴 **AGREGADO POR ESTE STORY FILE — cierra el agujero de §F.** `update()` llamado con `updates.payment` **crudo y sucio** (`{method,chain,contract,resolvedChain,network,sarasa}`) → el `updateRow.metadata.payment` tiene **exactamente 4 keys**. Rojo si el service persiste `updates.payment` en vez de `result.block`. **Sin este test, la ruta PATCH burla CD-10/CD-11 y todos los demás tests siguen verdes.** |
| **`T-316-26`** | **DT-STORY-1** | `payment-spec-writer.test.ts` | 🔴 **AGREGADO.** Bundle mockeado con `supportedTokens: []` y `asset: 'USDC'` → **acepta** (no lanza, no rechaza) y loguea `PAYMENT_ASSET_CHECK_SKIPPED`. |

**Criterio test-first**: lógica de negocio y rutas → **sí**. Docs (W4) → no.

---

## Waves

### Wave -1: Environment Gate (OBLIGATORIO — antes de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
git rev-parse --short HEAD            # esperado: 8242b16 (o el merge-base de tu rama)
npm install
ls src/lib/payment-spec-reader.ts src/adapters/deposit-verifier.ts \
   src/adapters/solana/chain.ts src/routes/well-known.test.ts \
   src/routes/agents.publish.test.ts src/services/agent.payment.test.ts \
   src/routes/agents.ownership.test.ts
ls src/lib/payment-spec-writer.ts src/lib/operator-address.ts 2>&1   # DEBEN faltar
ls src/services/agent.test.ts 2>&1                                   # DEBE faltar
npx tsc --noEmit ; echo "tsc exit=$?"
npm test          # base: 286 archivos / 5624 passed | 19 skipped
```

**Si algo falla acá: PARÁS y reportás al orquestador.** No implementar sobre un entorno roto.
⚠️ Los exit codes se leen **directo, nunca después de un pipe** (CD-A3).

### Wave 0 — Contratos (SERIAL, bloquea todo)
- [ ] W0.1: `src/types/index.ts` → `AgentPaymentSpecInput` + `payment?` en `PublishAgentInput`
      (`:282`) + `payment?: … | null` en `UpdateAgentInput` (`:315`) → Archivo #1
- [ ] W0.2: `src/services/agent.ts` → **sólo** `PublishedAgentRecord.payment?` (el campo del tipo,
      **sin lógica**) → Archivo #7 (parcial)
- **Puerta**: `npx tsc --noEmit` exit 0. **Cero cambios de comportamiento** → `npm test` idéntico a
  la base (5624 passed). Si el conteo cambió, algo hiciste de más.

### Wave 1 — `operator-address` (SERIAL, depende de W0)
- [ ] W1.1: crear `src/lib/operator-address.ts` → Archivo #2 → Exemplar 2
- [ ] W1.2: crear `src/lib/operator-address.test.ts` (T-316-11) → Archivo #3
- **Puerta**: `npm test` + `tsc` + `lint`.

### Wave 2 — El validador (SERIAL, depende de W0 + W1)
- [ ] W2.1: crear `src/lib/payment-spec-writer.ts` → Archivo #4 → Exemplar 1
- [ ] W2.2: crear `src/lib/payment-spec-writer.test.ts` (T-316-04..10, 19, 21, 22, 23, 26) → Archivo #5
- **Puerta**: `npm test` + `tsc` + `lint`.
- **Cierra**: AC-2, AC-3, AC-4, AC-5, AC-6, AC-10, AC-12 (a nivel de módulo) + CD-2, CD-10, CD-11, CD-12.

### Wave 3A — Route (PARALELIZABLE con W3B, depende de W2)
- [ ] **W3A.0 — PRIMERO: el mock del registry** en `agents.publish.test.ts` y `agents.ownership.test.ts`
      (riesgo #1). **Antes** de escribir el primer test de camino feliz.
- [ ] W3A.1: `src/routes/agents.ts` POST + PATCH → Archivo #6 → Exemplar 3
- [ ] W3A.2: `agents.publish.test.ts` (T-316-01, 20) → Archivo #8
- [ ] W3A.3: `agents.ownership.test.ts` (T-316-12) → Archivo #9
- **Cierra**: AC-1 (respuesta 201), AC-7 (el 404 cross-owner), AC-11 (route).

### Wave 3B — Service (PARALELIZABLE con W3A, depende de W2)
- [ ] **W3B.0 — PRIMERO: el mock del registry** en `agent.payment.test.ts` (riesgo #1).
- [ ] W3B.1: `src/services/agent.ts` — los 5 puntos de §F → Archivo #7 → Exemplars 4, 5, 6
- [ ] W3B.2: `agent.payment.test.ts` (T-316-02, 03, 13..18, 25) → Archivo #10
- **Cierra**: AC-1 (persistencia), AC-7 (merge), AC-8, AC-9, AC-11 (service) + CD-1, CD-7, DT-STORY-2.

### Wave 4 — Docs + estructural (depende de W3A + W3B)
- [ ] W4.1: `doc/INTEGRATION.md` — subsección nueva en §3 (`:151`) con el campo, la advertencia de
      que `contract` **es la billetera de cobro y no un token**, los 8 `error_code`, y la
      consecuencia de AC-12 estricto en kite/tempo → Archivo #11
- [ ] W4.2: `README.md:287` — una línea apuntando a esa subsección → Archivo #12
- [ ] W4.3: `T-316-24` (grep estructural) → `test/`
- [ ] W4.4: **barrido CD-A1** — re-abrir con `sed -n 'Np'` TODAS las citas `archivo:línea` escritas
      en las 5 waves (docblocks, comentarios, INTEGRATION.md) y confirmarlas contra el árbol final.
- **Puerta final**: `npm test` completo (**> 5624 passed**) · `npx tsc --noEmit` exit 0 ·
  `npm run lint` exit 0. Los tres sin pipe.

### Verificación incremental

| Wave | Verificación al completar |
|------|---------------------------|
| W-1 | Environment gate completo, base reproducida |
| W0 | `tsc --noEmit` exit 0 + `npm test` **idéntico** a la base |
| W1 | `npm test` + `tsc` + `lint` |
| W2 | `npm test` + `tsc` + `lint` |
| W3A / W3B | `npm test` + `tsc` + `lint` **completos** (no sólo los archivos tocados — CD-A3) |
| W4 | `npm test` + `tsc` + `lint` + barrido de citas CD-A1 |

---

## Exemplars (verificados uno por uno contra `main` @ `8242b16`)

### Exemplar 1 — Módulo LEAF del write path
**Archivo**: `src/lib/payment-spec-reader.ts` (docblock `:1-18`, función `:159-215`)
**Usar para**: `src/lib/payment-spec-writer.ts` (Archivo #4)
**Patrón clave**:
- Docblock que explica **por qué** es un módulo aparte (evitar el ciclo `discovery.ts ⇄ agent.ts`) y
  que declara ser el **único** choke-point.
- Imports mínimos: el resolver puro + `import type`. **Prohibido** importar servicios.
- Devuelve un objeto **CONSTRUIDO key por key** (`:206-214`), nunca un spread del raw.
- Valida la chain con `normalizeChainSlug` y devuelve `undefined` si no la conoce (`:190-193`).
- **NO se toca este archivo** (CD-6). Es el modelo, no el sujeto.

### Exemplar 2 — Derivar la address del operador SIN lanzar
**Archivo**: `src/adapters/deposit-verifier.ts:161-176` (`resolveTreasury`)
**Usar para**: `src/lib/operator-address.ts` (Archivo #2)
**Patrón clave**:
```ts
const pk = process.env.OPERATOR_PRIVATE_KEY;
if (pk) {
  try { return privateKeyToAccount(pk as `0x${string}`).address; }
  catch { return null; }
}
return null;
```
- Import de `viem/accounts` en el top (`:20`) — para la rama EVM eso es correcto, `viem` ya es
  dependencia directa. **Para la rama Solana NO**: ahí va `await import()` (CD-13).
- Nunca lanza. El caller decide cómo degradar.

### Exemplar 3 — Guard de write-boundary en el route
**Archivo**: `src/routes/agents.ts:74-95` (`isValidPayoutWalletForChain`) + su uso en `:197-210`
**Usar para**: `src/routes/agents.ts` (Archivo #6)
**Patrón clave**:
- Predicado/validación local, después de los guards de mínimos y antes de armar el `input`.
- `request.log.warn({ field: '…' }, 'agent publish rejected: …')` con el detalle.
- `reply.status(422).send({ error, field, reason })` con `reason` **estático**.
- La captura hacia el `input` es **condicional** por `exactOptionalPropertyTypes` (`:236-261`).
- El bloque simétrico del PATCH está en `:349-373`, y ahí el `body` sigue crudo hacia el service.

### Exemplar 4 — Persistencia condicional en el alta
**Archivo**: `src/services/agent.ts:186-198` (`buildMetadata`)
**Usar para**: `src/services/agent.ts` (Archivo #7)
**Patrón clave**: keys condicionales (`if (source.X !== undefined) meta.X = source.X`) y
`return Object.keys(meta).length > 0 ? meta : null` (`:197`).

### Exemplar 5 — Merge del PATCH que preserva lo que no se pidió
**Archivo**: `src/services/agent.ts:645-660`
**Usar para**: `src/services/agent.ts` (Archivo #7)
**Patrón clave**: la condición de entrada (`:647-651`) enumera los campos que disparan el merge —
**hay que agregarle `payment`**; adentro, `readMetadataObject(existing.metadata)` (`:652`) lee lo que
ya había y se mergea **encima**; el cast a `Json` va sólo en el borde (`:659`).

### Exemplar 6 — Defense-in-depth que LANZA en el service
**Archivo**: `src/services/agent.ts:242-248` (`assertValidPayoutWallet`) + `:222-231`
(`resolvePayoutNamespace`)
**Usar para**: `src/services/agent.ts` (Archivo #7)
**Patrón clave**: **no-op si el valor es `undefined`**; lanza `Error` genérico si es inválido; el
route ya devolvió 422 antes. Llamada en `publish` (`:392-397`) y en `update` (`:604-614`).

### Exemplar 7 — Narrowing acotado a `PublishedAgentRecord`
**Archivo**: `src/services/agent.ts:99-108` (`readSchema`) + `:161-180` (`mapRowToRecord`)
**Usar para**: `readStoredPaymentBlock` y el nuevo campo del record
**Patrón clave**: devolver `undefined` (no `null`) cuando no hay valor; asignar al record **sólo si
`!== undefined`** (`:177-178`) — obligatorio con `exactOptionalPropertyTypes`.

### Exemplar 8 — Log PII-safe fuera del service
**Archivo**: `src/services/security/errors.ts:494-545` (`logOwnershipMismatch`)
**Usar para**: `logPaymentBlockChange` en `payment-spec-writer.ts`
**Patrón clave**: `crypto.createHash('sha256').update(v).digest('hex').slice(0, 16)` (`:517`), el
logger propio del módulo, y el payload como objeto plano con `ts` ISO.

### Exemplar 9 — 🔴 Mock del registry con `importOriginal`
**Archivo**: `src/routes/well-known.test.ts:37-54` (su docblock `:27-35` explica el hazard)
**Usar para**: los tres archivos de test del riesgo #1
**Patrón clave**: `async (importOriginal) => { const actual = await importOriginal<…>(); return { ...actual, … } }`.
**Sin el spread, todo lo que no overrideás queda `undefined` y la suite explota por un motivo ajeno.**

### Exemplar 10 — Harness de route-test
**Archivo**: `src/routes/agents.publish.test.ts:27-84`
**Usar para**: Archivos #8 y #9
**Patrón clave**: `vi.hoisted` para los espías; 4 mocks (`node:dns` `:33`, supabase `:38`, service
`:57` con spread de `importActual`, middleware `:77` que inyecta `a2aKeyRow`); `currentOwner` como
variable de módulo para simular el caller.

### Exemplar 11 — Harness de service-test + espía que delega en el real
**Archivo**: `src/services/agent.payment.test.ts:15-46`
**Usar para**: Archivo #10 y para `T-316-23`
**Patrón clave**: supabase in-memory con `state` hoisted (`:15-33`); y el espía del módulo leaf
**delegando en la implementación REAL** vía `importOriginal` (`:39-46`) — así el comportamiento queda
intacto y el test puede afirmar *"nadie escribió un validador paralelo"*.

### Exemplar 12 — Lo que un test de route NO garantiza
**Archivo**: `src/routes/agents.ownership.test.ts:10-32`
**Usar para**: no auto-engañarte con `T-316-12`
**Patrón clave**: su propio docblock avisa que ese archivo verifica que **la consulta se escribió**,
no que **aisló** (`maybeSingle`/`single` devuelven `state.row` sin importar qué se filtró). El
aislamiento real vive en `src/services/agent.ownership.test.ts`. **No escribas en un docblock que
`T-316-12` prueba aislamiento: sería falso.**

---

## Anti-Hallucination Checklist (esta HU)

- [ ] **NO existe** `src/services/agent.test.ts`, y no lo voy a crear.
- [ ] **NO existe** `getSupportedChains()` exportada (`src/adapters/registry.ts:70`, sin `export`).
      Los accesores exportados son `getAdaptersBundle` (`:480`), `getInitializedChainKeys` (`:493`) y
      `getInboundPaymentChainKeys` (`:532`).
- [ ] `isValidPayoutWallet(w, ns)` está en `src/lib/wallet-format.ts:129`, e `isValidSolanaAddress`
      en `:52`. **No escribo un decoder base58 nuevo.**
- [ ] `getChainVmFamily` está en `src/adapters/chain-resolver.ts:129` y `normalizeChainSlug` en
      `:419`. **No escribo un `Set` de slugs.**
- [ ] `normalizeChainSlug` YA hace `trim().toLowerCase()` internamente (`:421`) — no lo repito antes
      de llamarlo, pero **sí** trimeo el valor que persisto.
- [ ] `AgentPaymentSpec` (`src/types/index.ts:200`) tiene **6** campos, no 4: `resolvedChain` (`:238`)
      y `network` (`:261`) son **derivados**. Mi tipo de input tiene **4**.
- [ ] Cero dependencias nuevas en `package.json`.
- [ ] Cero `supabase.from(...)` nuevo. `test/ownership-filter-guard.exceptions.ts` sin tocar.
- [ ] Cero DDL, cero migración, cero backfill.
- [ ] No toqué `payment-spec-reader.ts`, `downstream-payment.ts`, `adapters/**`, `discovery.ts`.
- [ ] No reescribí `doc/sdd/_INDEX.md` (la fila `214` ya existe en `:181`).
- [ ] Todas las citas `archivo:línea` que escribí las re-abrí **después** de mi última edición.
- [ ] No repetí en ningún lado la justificación vencida del "cobro del KYC en Solana".

---

## Uncertainty Markers — NO bloquean, pero se reportan tal cual

| Marker | Qué es | Qué hace el Dev |
|---|---|---|
| **NC-1** `[NEEDS CLARIFICATION]` | ¿`64KKjZFSMZRucKPqTpGydrUFeFdLHDhbHTJVGmEaXS6z` (el `contract` de los 3 agentes Solana vivos) **es** la pubkey del operador Solana del gateway? No es determinable desde el árbol: exige `SOLANA_OPERATOR_PRIVATE_KEY`, que vive en Railway. Si coincide, esos 3 agentes le están pagando al gateway y hay una HU nueva. | **Nada.** AC-6 se implementa igual y **detecta** el caso. No cambia una línea del diseño. **No uses esa address como fixture de "payTo válido aceptado"** — usá otra pubkey base58 de 32 bytes. |
| **NC-2** `[NEEDS CLARIFICATION]` | ¿Existe alguna fila `a2a_agents` con `enabled = false` y sin `metadata.payment`? `/discover` sólo muestra `enabled = true` y no se consultó la base. | **Nada.** AC-11 + CD-14 ya cubren "sin bloque": se queda sin bloque. Ninguna fila se toca. |
| **NC-3** `[DECIDE FOUNDER]` | Prueba de posesión del `payTo`. Recomendación del analyst: **no** exigirla ahora — declarar la billetera de un tercero le **regala** plata a ese tercero, así que el daño es de **atribución**, no de custodia. | **Nada.** El diseño es **aditivo**: si el founder dice que sí, WKH-318 agrega **un guard más** a `validatePaymentBlock`, sin rediseñar. |

---

## Out of Scope

- `wasiai-remittance-agents`, `chaski-v3`, `wasiai-v2`, `wasiai-facilitator` — **cero bytes**.
- **WKH-317** (el publicador de manifiesto que consume este endpoint): vive en el otro repo.
- Migración de DB / DDL / backfill de filas existentes.
- Los **22 agentes federados**: fuera de alcance **por arquitectura**, no por decisión — su `payment`
  lo sirve el registry `WasiAI` en su propio payload (`discovery.mapAgent`), no `a2a_agents`.
- `payment-spec-reader.ts`, `downstream-payment.ts`, `adapters/**`, `discovery.ts` (CD-6). En
  particular **no** se agrega el chequeo de zero-pubkey a la rama Solana del **settle**
  (**TD-SOLANA-ZERO-PAYTO-SETTLE**).
- Prueba de posesión del payTo (NC-3 / WKH-318).
- Versionado, historial o congelamiento del bloque. El reemplazo proporcionado es el log de auditoría.
- RLS a nivel Postgres sobre `a2a_agents` (WKH-SEC-02 / TD-SEC-01).
- NO "mejorar" código adyacente. NO refactors no solicitados. NO funcionalidad no listada.

---

## Escalation Rule

> **Si algo no está en este Story File, PARÁS y preguntás al Architect.** No inventar, no asumir, no
> improvisar. El Architect resuelve y actualiza el Story File antes de que sigas.

Situaciones de escalation específicas de esta HU:

- Un test da **422** donde esperabas 201 y estás por tocar el orden o la condición de un guard →
  **PARÁS.** Es el riesgo #1: arreglá el mock del registry, no el guard.
- Necesitás agregar un `supabase.from(...)` nuevo → **PARÁS** (CD-5, BLOQUEANTE en AR).
- El compilador te pide un `!` o un `as` para leer `supportedTokens[0]` → **usá `?.` y la decisión
  DT-STORY-1**; si aun así no compila, PARÁS.
- Una cita `archivo:línea` de este documento no coincide con el árbol → PARÁS y reportás (puede ser
  drift real de `main`).
- El `npm test` final da **menos** de 5624 passed → PARÁS. Rompiste algo.

---

*Story File generado por NexusAgil — F2.5 · nexus-architect · WKH-316*
