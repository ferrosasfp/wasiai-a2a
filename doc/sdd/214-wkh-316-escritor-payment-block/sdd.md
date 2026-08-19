# SDD #214: [WKH-316] El escritor del bloque `payment` de un agente

> SPEC_APPROVED: no
> Fecha: 2026-08-18
> Tipo: feature / money-path (write boundary)
> SDD_MODE: full
> Branch: `feat/214-wkh-316-payment-block-writer`
> Artefactos: `doc/sdd/214-wkh-316-escritor-payment-block/`
> Base medida: `main` @ `8242b16` · `tsc --noEmit` exit 0 · `npm test` 286 archivos / 5624 passed | 19 skipped

---

## 1. Resumen

WKH-241 construyó el **lector** de `metadata.payment` (`src/lib/payment-spec-reader.ts`) y corre en
producción. El **escritor nunca existió**: `PublishAgentInput` (`src/types/index.ts:282-309`) no declara
`payment`, y `buildMetadata` (`src/services/agent.ts:186-198`) persiste sólo `inputSchema`,
`outputSchema` y `discoverable`. Un tercero que publique por API **no puede declarar en qué red cobra**.

Esta HU agrega `payment` a `POST /agents` y `PATCH /agents/:slug` con siete guards de write-boundary,
un módulo nuevo que los concentra, y un log de auditoría de cada escritura. No toca el settle, ni el
lector, ni los adapters, ni la DB (no hay DDL: `a2a_agents.metadata` ya es JSONB).

**Lo que este SDD corrige del work-item, medido hoy** — ver §3.2. La premisa "`remit-kyc-validator`
tiene `payment: null`" es **falsa al 2026-08-18**: los tres agentes self-published ya tienen bloque
Solana completo, sembrado fuera del repo. El valor de la HU **no cambia** (el camino de escritura sigue
sin existir, y WKH-314 necesita el campo persistido), pero la línea "Bloquea: el cobro del KYC en
Solana" **ya no es cierta** y no se puede usar para justificar el orden de merge.

---

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 214 |
| **Ticket** | WKH-316 |
| **Tipo** | feature / money-path |
| **SDD_MODE** | full |
| **Objetivo** | Que un agente pueda DECLARAR y PERSISTIR en qué red cobra, por API pública autenticada, sin poder publicar un bloque que jamás va a cobrar. |
| **Reglas de negocio** | El bloque es owner-scoped; se puede modificar después; toda escritura deja rastro; el catálogo público de un agente NO modificado no cambia ni un byte. |
| **Scope IN** | §6 |
| **Scope OUT** | §6 |
| **Missing Inputs** | MI-1 abierto (`[DECIDE FOUNDER]`); MI-2 y MI-5 **RESUELTOS** en §3.3; MI-3 **RESUELTO** en §3.2; MI-4 **RESUELTO parcialmente** en §3.2 |

Los 12 ACs EARS son los del work-item (`work-item.md:129-194`) y **no se reescriben acá**. Lo que
este SDD hace con ellos: resuelve la condicional de AC-12 (§3.3 · MI-2), fija el mecanismo de AC-6
(§3.3 · MI-5), y corrige el enunciado de AC-9 (§3.2 · son **tres** filas sembradas, no dos).

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos

| Archivo | Por qué | Patrón / hecho extraído |
|---------|---------|-------------------------|
| `src/types/index.ts:200-262` | `AgentPaymentSpec` | Tiene **6** campos, no 4: `method`, `chain`, `contract`, `asset` + **`resolvedChain` y `network` que son DERIVADOS por el gateway** (`:229-261`, "DERIVADO por el gateway, no declarado"). Un input verbatim los dejaría escribir. → DT-6. |
| `src/types/index.ts:282-309` / `:315-349` | `PublishAgentInput` / `UpdateAgentInput` | Confirmado: ninguno declara `payment`. `UpdateAgentInput` ya tiene `enabled` (el work-item no lo listaba). |
| `src/lib/payment-spec-reader.ts:159-215` | El lector, intocable | Devuelve un objeto CONSTRUIDO con 6 keys; **recomputa siempre** `resolvedChain`/`network` (`:212-213`) e **ignora** cualquier key extra del raw. Valida chain con `normalizeChainSlug` y devuelve `undefined` si no la conoce (`:190-193`). |
| `src/routes/agents.ts:114-284` (POST) | Exemplar del guard de write-boundary | Arma un `input` con **whitelist explícita** campo por campo (`:230-261`); un `slug` del body se ignora. 422 con `{ error, field, reason }` (`:188-192`); mensaje ESTÁTICO, detalle a `request.log.warn`. |
| `src/routes/agents.ts:289-429` (PATCH) | Asimetría crítica | **Le pasa el `body` CRUDO al service** (`:412-416`), sin whitelist. Todo campo nuevo del PATCH depende 100% del guard de runtime. |
| `src/services/agent.ts:186-198` | `buildMetadata` | Tres keys condicionales; `null` si queda vacío. Punto de inserción de `payment` en el alta. |
| `src/services/agent.ts:645-660` | Merge de metadata del PATCH | Lee `existing.metadata` y mergea encima → CD-7 (preservar `inputSchema`/`outputSchema`/`discoverable`) se cumple **por construcción** si se sigue este patrón. |
| `src/services/agent.ts:565-685` | `update()` — guard de dueño | Pre-fetch (`:571`) + comparación (`:580-588`) + UPDATE filtrado `.eq('slug').eq('owner_ref')` (`:665-666`) + `PGRST116` → 404 (`:673-680`). **El bloque hereda el guard sin una línea nueva.** |
| `src/services/agent.ts:65-77` / `:161-180` | `PublishedAgentRecord` / `mapRowToRecord` | **NO exponen `payment`** → AC-1 ("devolverlo en el 201") exige tocarlos. `readSchema` (`:99-108`) es el patrón de narrowing a copiar. |
| `src/services/agent.ts:19-44` | Imports del service | **No importa ningún logger.** → el log de auditoría no puede ser un `log.info` suelto acá (DT-8). |
| `src/lib/wallet-format.ts:129-131` | `isValidPayoutWallet(w, ns)` | Único validador de forma por familia. `isValidSolanaAddress` = base58 decode a 32 bytes exactos (`:52-61`). |
| `src/adapters/chain-resolver.ts:419-424` | `normalizeChainSlug` | Hace `raw.trim().toLowerCase()` **internamente** antes del lookup. → DT-7 (trim del `chain` persistido). |
| `src/adapters/chain-resolver.ts:116-131` | `getChainVmFamily(chainKey)` | `Record<ChainKey, 'evm'\|'solana'>` exhaustivo. Es el mapeo a usar para `ns` (AC-4), NO un `=== 'solana-devnet'` a mano. |
| `src/adapters/registry.ts:480-499` | `getAdaptersBundle` / `getInitializedChainKeys` | `getSupportedChains()` (`:70`) **NO está exportada** — confirmado. `getAdaptersBundle` devuelve `undefined` para TODO si `_initialized === false` (`:485`). |
| `src/adapters/registry.ts:1-16` | Imports top-level del registry | Sólo `lib/logger`, `chain-resolver` y tipos. **Todos los adapters se cargan por `await import()` dentro de `buildBundle`.** → importar `registry.js` desde `src/lib/` es barato y no crea ciclo. |
| `src/adapters/types.ts:114-118`, `:339` | `SolanaTokenSpec` | Tiene `symbol: string`, igual que `TokenSpec` (`:6-10`) → `supportedTokens[0].symbol` se lee sobre la unión sin narrowing. |
| `src/adapters/deposit-verifier.ts:161-176` | `resolveTreasury` | **Exemplar exacto** del patrón "derivar address del operador sin lanzar": `try { privateKeyToAccount(pk).address } catch { return null }`. |
| `src/adapters/solana/chain.ts:84-95` | `getSolanaOperatorKeypair()` | **LANZA** si falta la env, **loguea**, y corre una aserción de coherencia WKH-315 que también puede lanzar. → sólo se puede llamar envuelto en try/catch (DT-5). |
| `src/services/security/errors.ts:494-545` | `logOwnershipMismatch` | Precedente de logging PII-safe fuera del service: **hashea** `ownerRef` con SHA-256 truncado a 16. → DT-8 copia el hash del owner y deja el `contract` en claro. |
| `src/routes/agents.publish.test.ts:27-84` | Harness de route-test | Mockea `node:dns`, `../lib/supabase.js`, `../services/agent.js` (spread de `importActual` + override) y `../middleware/a2a-key.js`. **NO inicializa el registry de adapters.** |
| `src/services/agent.payment.test.ts:15-46` | Harness de service-test | Supabase in-memory + espía del módulo leaf delegando en el real vía `importOriginal`. Exemplar para el gemelo de escritura. |
| `src/routes/agents.ownership.test.ts:10-32` | Límite declarado | Su propio docblock avisa: verifica que **la consulta se escribió**, no que **aisló**. El aislamiento vive en `src/services/agent.ownership.test.ts`. |
| `doc/INTEGRATION.md:244-252`, `:636-642` | Docs del lector | `agents[].payment` ya documentado del lado de LECTURA, incluidos `NO_PAYMENT_FIELD` / `CHAIN_NOT_SUPPORTED` / `INVALID_PAY_TO_FORMAT`. **`POST /agents` no está documentado en ninguna parte** (`grep 'payoutWallet' --include=*.md` → 0 hits en `README.md` y `doc/INTEGRATION.md`). |

### 3.2 Estado REAL del catálogo — la pregunta de "los 25 agentes ya publicados"

Medido el **2026-08-18** contra producción (`https://wasiai-a2a-production.up.railway.app`), no
estimado:

```
GET /discover?limit=200   → total 25 · registry: WasiAI 22 | self-published 3
GET /capabilities         → sources: [{WasiAI, ok, rows:22}, {self-published, ok, rows:3}]
                            chains:  kite-ozone-testnet(default) · avalanche-fuji · base-sepolia · solana-devnet
```

| Hecho medido | Valor | Consecuencia para esta HU |
|---|---|---|
| Agentes con bloque `payment` | **25 de 25** | El conjunto "agentes ya publicados **sin** `payment`" está **VACÍO**. La pregunta "¿se infiere, se deja nulo, se migra?" no tiene sujeto. |
| Filas alcanzables por este escritor (`a2a_agents`) | **3** (`remit-corridor-fx-solana`, `remit-cashout-payout-solana`, `remit-kyc-validator`) | Las otras **22 son federadas** (registry `WasiAI` = wasiai-v2): su `payment` lo sirve ese registry en su payload vía `discovery.mapAgent`. Este escritor **no las alcanza y no puede migrarlas**. |
| Bloque de las 3 filas | idéntico: `{"method":"x402","chain":"solana-devnet","contract":"64KKjZFSMZRucKPqTpGydrUFeFdLHDhbHTJVGmEaXS6z","asset":"USDC"}` | Ya son válidas contra AC-2/AC-4/AC-5/AC-10/AC-12 (verificado: ese base58 decodifica a **32 bytes exactos**). Sólo AC-6 queda abierto — NC-1. |
| `chain` declarada por las 22 federadas | 16 `avalanche` + 6 `avalanche-fuji`, **todas** `resolvedChain: avalanche-fuji` | Confirma que `avalanche` es alias de Fuji y que el reader deriva bien. Irrelevante para el write path: son federadas. |
| Rieles inicializados en prod | `kite-ozone-testnet`, `avalanche-fuji`, `base-sepolia`, `solana-devnet` | **`solana-devnet` SÍ está vivo en prod** → AC-3 lo acepta hoy. `avalanche-mainnet`, `base-mainnet`, `kite-mainnet` y `tempo-testnet` **NO** → AC-3 los rechaza hoy (DT-3, consecuencia asumida). |

**MI-3 RESUELTO — y desmiente al work-item.** `remit-kyc-validator` **es self-published**
(`registry: "self-published"` en `/discover`), así que este escritor **sí** lo alcanza. Pero el
work-item (`work-item.md:414-419`) y `doc/roadmap/2026-08-incubadora-solana-checklist.md:136` dicen
que su `payment` es `null`; **hoy tiene el bloque Solana completo**. Alguien lo sembró a mano después
de que se escribieran esos documentos. **Esta HU NO desbloquea "el cobro del KYC en Solana": ya está
desbloqueado por fuera del repo.** Lo que sigue siendo cierto es que no hay forma de hacerlo *por API*
y que WKH-314 necesita el campo escribible.
*Sería falso si `/discover` devolviera `payment: null` para `remit-kyc-validator` — devuelve el bloque
completo, medido hoy.*

**MI-4 RESUELTO parcialmente.** No consulté la base, así que no sé el `owner_ref` de las 3 filas. Pero
la pregunta que MI-4 quería contestar ("¿alguien puede corregir esos bloques por API?") **pierde
urgencia**: los 3 bloques ya son válidos contra 5 de los 6 guards, así que no hay nada que corregir.
Si el `owner_ref` no corresponde a ninguna a2a-key nuestra, el efecto es que **nadie puede
PATCHearlas** — y como `payment` es opcional en el PATCH, eso no bloquea ninguna otra edición.

### 3.3 Missing Inputs resueltos en F2

**MI-2 RESUELTO — AC-12 queda ESTRICTO.** El símbolo del token del adapter Solana es el literal
`'USDC'`: `const USDC_SYMBOL = 'USDC' as const` (`src/adapters/solana/payment.ts:82`), usado en
`supportedTokens` (`:303-309`). La condición de degradación de AC-12 ("si el símbolo no es exactamente
USDC") es **falsa**, así que AC-12 se implementa con rechazo 422.

Los símbolos de los otros rieles, porque cambian a quién le pega AC-12:

| ChainKey | `supportedTokens[0].symbol` | Fuente |
|---|---|---|
| `solana-devnet` | `USDC` | `src/adapters/solana/payment.ts:82` |
| `avalanche-fuji` / `avalanche-mainnet` | `USDC` | `src/adapters/avalanche/payment.ts:56` |
| `base-sepolia` / `base-mainnet` | `USDC` | `src/adapters/base/payment.ts:67` |
| `tempo-testnet` | `AlphaUSD` | `src/adapters/tempo/payment.ts:61` |
| `kite-ozone-testnet` / `kite-mainnet` | **`process.env.X402_TOKEN_SYMBOL`** ?? `PYUSD` (testnet) / `USDC.e` (mainnet) | `src/adapters/kite-ozone/payment.ts:164-165`, `:252-253` |

Consecuencia asumida y falsable: **declarar `asset: "USDC"` para `kite-ozone-testnet` devuelve 422
`PAYMENT_ASSET_MISMATCH` hoy**, porque el símbolo por defecto de ese riel es `PYUSD`. Eso es correcto
—el catálogo diría un token que ese riel no transfiere— pero significa que el resultado del publish
depende de una env var del operador. Se acepta: `asset` es decorativo (los decimales y el monto salen
siempre de `supportedTokens[0]`, `downstream-payment.ts:284` / `:777-785`), así que rechazarlo no puede
mover un centavo; sólo evita que el catálogo mienta. *Sería falso si algún camino de settle leyera
`payment.asset` — ninguno lo hace.*

**MI-5 RESUELTO — AC-6 se implementa, con degradación explícita.** No existe accesor limpio, así que
se crea uno (DT-5, `src/lib/operator-address.ts`), copiando el patrón de
`src/adapters/deposit-verifier.ts:161-176`:

- **EVM**: `privateKeyToAccount(process.env.OPERATOR_PRIVATE_KEY)` dentro de `try/catch` → `null` ante
  cualquier fallo. `viem` ya es dependencia directa y `downstream-payment.ts:12` la importa igual.
- **Solana**: `await import('../adapters/solana/chain.js')` → `getSolanaOperatorKeypair().publicKey.toBase58()`
  dentro de `try/catch` → `null`. **Import dinámico obligatorio** (CD-13): estático arrastraría
  `@solana/web3.js` a todo proceso que sirva rutas, que es exactamente lo que `registry.ts` evita
  cargando los adapters con `await import()`.
- Resultado cacheado por proceso y por familia, incluido el `null`.

⚠️ **Costo declarado de la rama Solana.** `getSolanaOperatorKeypair()` no es un getter puro: loguea
(`solana/chain.ts:95`) y corre la aserción de coherencia depósito↔operador de WKH-315 (`:141-147`), que
**lanza**. Si el proceso todavía no había cargado el keypair, esta HU sería la primera en dispararla, y
nuestro `catch` **se tragaría** un error de configuración que hoy explota ruidosamente en el settle.
Mitigación: el `catch` loguea con `code: 'PAYTO_OPERATOR_CHECK_SKIPPED'` **y** el `err.message`
(server-side, nunca al cliente). No se degrada a silencio.

**MI-1 SIGUE ABIERTO** (`[DECIDE FOUNDER]`, ver §10 · NC-3). El diseño es **aditivo respecto de la
prueba de posesión**: si el founder decide exigirla (WKH-318), entra como un guard más en
`validatePaymentBlock` sin rediseñar nada.

### 3.4 Exemplars verificados (todos confirmados con `test -f` y leídos)

| Para crear / modificar | Seguir patrón de | Qué copiar |
|---|---|---|
| `src/lib/payment-spec-writer.ts` (NUEVO) | `src/lib/payment-spec-reader.ts` | Docblock que explica por qué es un módulo aparte; función pura exportada; validación de chain derivada del resolver, nunca de un `Set` a mano. |
| `src/lib/operator-address.ts` (NUEVO) | `src/adapters/deposit-verifier.ts:161-176` | `try { privateKeyToAccount(pk).address } catch { return null }`. Nunca lanza. |
| Guards de route (`agents.ts`) | `isValidPayoutWalletForChain` (`routes/agents.ts:83-95`) + su uso en `:197-210` | Predicado local + `request.log.warn({field}, '…')` + 422 con mensaje estático. |
| Guards de service (`agent.ts`) | `assertValidPayoutWallet` (`services/agent.ts:242-248`) + `resolvePayoutNamespace` (`:222-231`) | Defense-in-depth que LANZA `Error`; no-op si el valor es `undefined`. |
| Persistencia en alta | `buildMetadata` (`services/agent.ts:186-198`) | Key condicional; `null` si el objeto queda vacío. |
| Merge del PATCH | `services/agent.ts:645-660` | Leer `existing.metadata`, mergear encima, castear en el borde. |
| `PublishedAgentRecord.payment` | `readSchema` + `mapRowToRecord` (`services/agent.ts:99-108`, `:161-180`) | Narrowing acotado; campo asignado **sólo si** `!== undefined` (nunca `null`). |
| Log de auditoría | `logOwnershipMismatch` (`services/security/errors.ts:494-545`) | `getLogger` en el módulo, SHA-256 truncado a 16 para el `owner_ref`. |
| Tests de route | `src/routes/agents.publish.test.ts:27-84` | 4 mocks (`node:dns`, supabase, service, middleware). |
| Tests de service | `src/services/agent.payment.test.ts:15-46` | Supabase in-memory + espía del leaf vía `importOriginal`. |
| Tests de aislamiento por dueño | `src/services/agent.ownership.test.ts` | Falso que **aplica** los filtros pedidos. |

### 3.5 Estado de BD

| Tabla | Existe | Columnas relevantes | Cambio |
|---|---|---|---|
| `a2a_agents` | Sí | `metadata: Json \| null`, `owner_ref`, `slug` | **NINGUNO. Cero DDL, cero migración.** El bloque vive dentro del JSONB existente. |

`a2a_agents` **tiene `owner_ref`**, así que está bajo la regla de ownership de `CLAUDE.md`. Esta HU
**no agrega ni una sola cadena `supabase.from(...)` nueva** (§4.1): toda escritura pasa por el UPDATE
ya filtrado de `update()` (`agent.ts:662-668`) y por el INSERT de `publish()`. Por lo tanto
`test/ownership-filter-guard.test.ts` **no cambia de conteo** y `test/ownership-filter-guard.exceptions.ts`
**no se toca**. *Sería falso si el diff introdujera un `.from('a2a_agents')` — CD-5 lo prohíbe y el
guardián lo detecta.*

---

## 4. Diseño técnico

### 4.1 Archivos a crear / modificar

| # | Archivo | Acción | Qué hace |
|---|---|---|---|
| 1 | `src/types/index.ts` | Modificar | `AgentPaymentSpecInput` (nuevo, 4 campos); `payment?` en `PublishAgentInput` y `payment?: … \| null` en `UpdateAgentInput`. |
| 2 | `src/lib/operator-address.ts` | **Crear** (~45 LOC) | `resolveOperatorAddress(family)` — nunca lanza, cachea, import dinámico para Solana. |
| 3 | `src/lib/operator-address.test.ts` | **Crear** | Tests del módulo 2. |
| 4 | `src/lib/payment-spec-writer.ts` | **Crear** (~150 LOC) | `validatePaymentBlock()` (los 6 guards) · `readStoredPaymentBlock()` · `logPaymentBlockChange()`. |
| 5 | `src/lib/payment-spec-writer.test.ts` | **Crear** | Tests del módulo 4 (el grueso de los ACs). |
| 6 | `src/routes/agents.ts` | Modificar | Guard 422 en POST (tras `payoutWallet`, `:197-210`) y en PATCH (tras `enabled`, `:381-394`); captura condicional en el `input` del POST (`:230-261`). |
| 7 | `src/services/agent.ts` | Modificar | `buildMetadata` escribe `payment`; merge del PATCH mergea/borra; defense-in-depth en `publish`/`update`; `PublishedAgentRecord.payment` + `mapRowToRecord`; llamada al log de auditoría. |
| 8 | `src/routes/agents.publish.test.ts` | Modificar | Tests de route del POST. |
| 9 | `src/routes/agents.ownership.test.ts` | Modificar | Tests de route del PATCH + AC-7 (cross-owner → 404). |
| 10 | `src/services/agent.payment.test.ts` | Modificar | Persistencia, merge, borrado, byte-identidad (CD-1). |
| 11 | `doc/INTEGRATION.md` | Modificar | Subsección nueva en §3 con el campo y los 7 `error_code`. |
| 12 | `README.md` | Modificar | Una línea en la tabla de endpoints (`:287`) apuntando a la subsección de INTEGRATION. |

⛔ **`src/services/agent.test.ts` NO EXISTE.** El work-item lo lista en su Scope IN
(`work-item.md:211`); verificado: los tests del service viven en `agent.payment.test.ts`,
`agent.enabled.test.ts`, `agent.ownership.test.ts`, `agent.pricing.test.ts`, `agent.trial-anchors.test.ts`.
**No crear un archivo nuevo con ese nombre** — los tests de esta HU van a `agent.payment.test.ts`.

### 4.2 Contrato de tipos (W0)

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
- `UpdateAgentInput.payment?: AgentPaymentSpecInput | null` — `null` explícito = borrar (AC-8)

⚠️ **El sistema de tipos NO protege el PATCH, medido.** `routes/agents.ts:412-416` le pasa un
`Record<string, unknown>` a `update(slug, updates: UpdateAgentInput, …)`. Verificado con el compilador
del repo (`node_modules/.bin/tsc --strict --exactOptionalPropertyTypes`): `Record<string, unknown>` **es
asignable** a una interfaz de props todas opcionales, exit 0; control negativo `{name: number}` → error
TS2322, exit 2. Conclusión: **el único guard del PATCH es el de runtime.** Por eso la defense-in-depth
del service (DT-9) no es opcional.

### 4.3 El módulo nuevo — `src/lib/payment-spec-writer.ts`

```ts
export type PaymentBlockRejection =
  | { code: 'INVALID_PAYMENT_BLOCK';           field: 'payment' }
  | { code: 'UNSUPPORTED_PAYMENT_METHOD';      field: 'payment.method' }
  | { code: 'INVALID_PAYMENT_CHAIN';           field: 'payment.chain' }
  | { code: 'PAYMENT_CHAIN_NOT_INITIALIZED';   field: 'payment.chain'; initializedChains: string[] }
  | { code: 'INVALID_PAYMENT_PAYTO_FORMAT';    field: 'payment.contract' }
  | { code: 'ZERO_PAYMENT_PAYTO';              field: 'payment.contract' }
  | { code: 'PAYTO_IS_OPERATOR';               field: 'payment.contract' }
  | { code: 'PAYMENT_ASSET_MISMATCH';          field: 'payment.asset' };

export type PaymentBlockResult =
  | { ok: true;  block: AgentPaymentSpecInput; operatorCheckSkipped: boolean }
  | { ok: false; rejection: PaymentBlockRejection };

export async function validatePaymentBlock(raw: unknown): Promise<PaymentBlockResult>;
```

**Orden de los guards** (el primero que falla gana, y el orden es normativo — CD-12):

| Paso | Guard | Rechazo | AC |
|---|---|---|---|
| 0 | `raw` es objeto no-array; `method`/`chain`/`contract` son strings no vacíos tras `trim()` | `INVALID_PAYMENT_BLOCK` (422) | — (borde nuevo, ver §4.6) |
| 1 | `method === 'x402'` exacto (sin trim, sin lowercase) | `UNSUPPORTED_PAYMENT_METHOD` | AC-10 |
| 2 | `chainKey = normalizeChainSlug(chain.trim())` ≠ `undefined` | `INVALID_PAYMENT_CHAIN` | AC-2 |
| 3 | `bundle = getAdaptersBundle(chainKey)` ≠ `undefined` | `PAYMENT_CHAIN_NOT_INITIALIZED` + `getInitializedChainKeys()` | AC-3 |
| 4 | `isValidPayoutWallet(contract.trim(), getChainVmFamily(chainKey))` | `INVALID_PAYMENT_PAYTO_FORMAT` | AC-4 |
| 5 | no es la zero-address de la familia | `ZERO_PAYMENT_PAYTO` | AC-5 |
| 6 | `asset` presente ⇒ `asset.trim().toUpperCase() === bundle.payment.supportedTokens[0].symbol.toUpperCase()` | `PAYMENT_ASSET_MISMATCH` | AC-12 |
| 7 | `op = await resolveOperatorAddress(family)`; si `op !== null` y coincide ⇒ rechazo. Si `op === null` ⇒ **acepta** y marca `operatorCheckSkipped: true` | `PAYTO_IS_OPERATOR` | AC-6 |

**Paso 5 — comparación de zero-address, y por qué son dos ramas y no una:**

```ts
// EVM: el formato hex YA está garantizado por el paso 4 → toLowerCase() es seguro
// y NECESARIO (una address EVM es case-insensitive por EIP-55).
// Patrón idéntico a downstream-payment.ts:227-232 y a paytos.ts:25-28 del repo hermano.
if (family === 'evm' && payTo.toLowerCase() === '0x' + '0'.repeat(40)) reject(ZERO_PAYMENT_PAYTO);
// Solana: comparación EXACTA, sin tocar la caja. base58 es case-sensitive (CD-3).
if (family === 'solana' && payTo === '1'.repeat(32)) reject(ZERO_PAYMENT_PAYTO);
```

⚠️ **AC-5 no es redundante con AC-4, y está medido**: `'1'.repeat(32)` (la pubkey de todos ceros /
System Program) **decodifica a 32 bytes exactos**, así que `isValidSolanaAddress` la **acepta**.
Verificado con el mismo algoritmo base-x de `wallet-format.ts:84-105`. Sin el paso 5, un agente podría
publicar un payTo que quema todos sus fees.

**Paso 7 — comparación con el operador, misma disciplina:** EVM `toLowerCase()` en ambos lados (el
formato hex ya está garantizado por el paso 4); Solana comparación exacta.

**`readStoredPaymentBlock(meta)`** — narrowing acotado del bloque **tal como está persistido** (las 4
keys), para `mapRowToRecord`. Es el gemelo de `readSchema` (`agent.ts:99-108`), NO un segundo lector
de discovery: `readPaymentSpec` sigue siendo el único productor de `Agent.payment` (CD-6).

**`logPaymentBlockChange(args)`** — DT-8.

### 4.4 Qué se persiste, exactamente

```ts
// Whitelist EXPLÍCITA de 4 keys. PROHIBIDO { ...raw } (CD-11).
const persisted = {
  method: raw.method,                    // ya validado === 'x402'
  chain:  raw.chain.trim(),              // trim sí, lowercase NO
  contract: raw.contract.trim(),         // trim sí, lowercase NO (CD-3)
  ...(asset !== undefined ? { asset: raw.asset.trim() } : {}),  // trim sí, caja preservada
};
```

**Por qué whitelist y no verbatim (DT-6).** `AgentPaymentSpec` declara `resolvedChain` y `network`
como **derivados por el gateway** (`types/index.ts:229-261`). Con un spread, un caller escribiría
`resolvedChain: 'avalanche-mainnet'` dentro del JSONB. Hoy `/discover` no cambiaría —
`readPaymentSpec:212-213` los **recomputa siempre**— pero el valor envenenado quedaría en `metadata`,
y `mapRowToRecord` (esta HU) y WKH-314 leen el bloque crudo. *Sería falso si `readPaymentSpec` leyera
`resolvedChain` del raw: no lo hace, lo recalcula en las dos ramas.*
Keys desconocidas: se **descartan en silencio**, no se rechazan — mismo criterio que el `slug` del body
del POST (`routes/agents.ts:227-229`). Un 422 por una key desconocida rompe la compatibilidad hacia
adelante de una API pública de escritura.

**Por qué `chain` se trimea aunque DT-7 del work-item diga "verbatim"** (desviación declarada):
`normalizeChainSlug` hace `raw.trim().toLowerCase()` antes de resolver
(`chain-resolver.ts:420-423`), así que `' avalanche '` **resuelve igual** y se persistiría con espacios,
divergiendo del valor sobre el que el sistema actúa. Se trimea; **no** se cambia la caja, que es la
mitad de DT-7 que sí importa.

### 4.5 Flujo principal

**POST /agents con `payment`:**
1. SSRF guard (sin cambios) → 2. `a2aKeyRequired` → 3. mínimos 400 → 4. `priceUsdc` / `payoutWallet` /
   `referrerRef` (sin cambios) → **5. `await validatePaymentBlock(body.payment)` si `body.payment !== undefined`**
   → 422 con `error_code` si falla; `request.log.warn` con el detalle → **6. captura condicional
   `input.payment = result.block`** → 7. `publish(input, keyRow.owner_ref)`:
   defense-in-depth → `buildMetadata` escribe la key → INSERT → **`logPaymentBlockChange({op:'publish', prev:null, next})`**
   → 8. `201` con `record.payment`.

**PATCH /agents/:slug con `payment`:** ídem, pero el guard corre **antes** de `update()`, y el guard de
dueño corre **dentro**. Un no-dueño con un bloque inválido recibe **422**, no 404.
*Disclosure: cero.* La validación depende sólo del input del caller y de la config del proceso, y la
lista `getInitializedChainKeys()` **ya es pública y sin auth** en `GET /capabilities` (medido hoy:
`chains[].key`). *Sería falso si `/capabilities` no publicara los chain keys — los publica.*

### 4.6 Flujo de error — contrato de respuesta

```json
{
  "error": "Invalid payment",
  "error_code": "INVALID_PAYMENT_CHAIN",
  "field": "payment.chain",
  "reason": "payment.chain must be a chain slug this gateway knows"
}
```

`PAYMENT_CHAIN_NOT_INITIALIZED` agrega `"initializedChains": ["kite-ozone-testnet", …]` (AC-3 lo exige;
no es disclosure, ver §4.5).

| `error_code` | HTTP | `reason` (ESTÁTICO — CD-8) |
|---|---|---|
| `INVALID_PAYMENT_BLOCK` | 422 | `payment must be an object with string method, chain and contract` |
| `UNSUPPORTED_PAYMENT_METHOD` | 422 | `payment.method must be exactly "x402"` |
| `INVALID_PAYMENT_CHAIN` | 422 | `payment.chain must be a chain slug this gateway knows` |
| `PAYMENT_CHAIN_NOT_INITIALIZED` | 422 | `payment.chain is not an active rail in this deployment` |
| `INVALID_PAYMENT_PAYTO_FORMAT` | 422 | `payment.contract must be a valid payout address for its chain family` |
| `ZERO_PAYMENT_PAYTO` | 422 | `payment.contract must not be the zero address` |
| `PAYTO_IS_OPERATOR` | 422 | `payment.contract must not be the gateway operator address` |
| `PAYMENT_ASSET_MISMATCH` | 422 | `payment.asset does not match the token this rail settles` |

⚠️ **Ningún `reason` refleja el valor recibido** (CD-8, patrón de `routes/agents.ts:275-281`). El valor
va a `request.log.warn({ field: 'payment.chain', code })`.

**Asimetría heredada, declarada:** el service lanza `Error` genérico y el `catch` del route lo mapea a
**400** `Failed to publish agent`, no a 422. Es exactamente lo que ya pasa con `assertValidPayoutWallet`
(`agent.ts:242-248` → `routes/agents.ts:269-281`). Alcanzable sólo si alguien llama al service sin
pasar por el route. No se cambia.

### 4.7 Log de auditoría (AC-7 / DT-8)

```ts
logPaymentBlockChange({
  op: 'publish' | 'update' | 'delete',
  slug,                                   // público (está en /discover)
  ownerRefHash: sha256(ownerRef).slice(0,16),   // HASHEADO, como logOwnershipMismatch
  prev: { chain, contract } | null,
  next: { chain, contract } | null,
});
```

**Por qué el `contract` va EN CLARO y el `owner_ref` hasheado.** El `owner_ref` es identidad de
inquilino: `services/security/errors.ts:494-545` lo hashea y esta HU no cambia esa política. El
`contract` es la billetera de cobro, **ya publicada sin auth en `GET /discover`** (medido: las 3 filas
la exponen), así que hashearlo no protege nada y **destruye el único valor del log**: contestar "¿a
qué billetera se repuntó, y cuándo?" el día que un fee aparezca donde no debe.

**Dónde vive.** `services/agent.ts` **no importa ningún logger** (verificado, `:19-44`). Se sigue el
precedente de `services/security/errors.ts`: la función vive en `payment-spec-writer.ts` con su propio
`getLogger('payment-writer')`, y el service la llama. **No** se agrega un logger al service, y **no**
se loguea desde el route (el route no tiene el valor `prev`).

---

## 5. Constraint Directives

### Heredadas del work-item (íntegras, sin reinterpretar)

- **CD-1** — `GET /discover` y `GET /capabilities` **no cambian** para un agente no modificado.
  Byte-identidad demostrada con test.
- **CD-2** — PROHIBIDO un segundo validador de chain o de wallet. Se usan EXACTAMENTE
  `normalizeChainSlug`, `getChainVmFamily`, `getAdaptersBundle`, `getInitializedChainKeys`,
  `isValidPayoutWallet`. Prohibido un `Set` de slugs, un regex de address o un decoder base58 nuevos.
- **CD-3** — PROHIBIDO `toLowerCase()`/`toUpperCase()` sobre `contract` en cualquier punto del write
  path. Única excepción: la comparación **dentro de la rama EVM**, después de que el paso 4 garantizó el
  formato hex (pasos 5 y 7 de §4.3).
- **CD-4** — PROHIBIDO derivar `payment` de `payout_wallet`/`payout_chain`, o viceversa.
- **CD-5** — PROHIBIDA cualquier query o mutación nueva sobre `a2a_agents` que no filtre por
  `owner_ref` además del `slug`. Un `.single()` sin `.eq('owner_ref', …)` en este diff es **BLOQUEANTE**
  en AR. (Esta HU **no agrega ninguna** — §3.5.)
- **CD-6** — PROHIBIDO modificar `src/lib/payment-spec-reader.ts`, `src/lib/downstream-payment.ts`,
  `src/adapters/**` y `src/services/discovery.ts`.
- **CD-7** — El merge del PATCH DEBE preservar `inputSchema`, `outputSchema`, `discoverable` y toda key
  desconocida ya presente. Escribir `metadata` desde cero es **BLOQUEANTE**.
- **CD-8** — Mensajes al cliente estáticos; el valor recibido va al log.

### Nuevas de este SDD

- **CD-9 (OBLIGATORIA)** — Los 6 guards viven **en un solo lugar**: `validatePaymentBlock`. El route la
  llama para el 422 y el service la llama para la defense-in-depth. **PROHIBIDO** re-implementar
  cualquiera de los 6 chequeos en `routes/agents.ts` o en `services/agent.ts`.
- **CD-10 (OBLIGATORIA)** — El bloque persistido se arma con **whitelist explícita de 4 keys**.
  `{ ...raw }` o `Object.assign({}, raw)` sobre el input del caller es **BLOQUEANTE**.
- **CD-11** — PROHIBIDO aceptar, persistir o devolver `resolvedChain` y `network` desde el input del
  caller. Son derivados del gateway (`types/index.ts:229-261`).
- **CD-12** — El orden de los guards de §4.3 es **normativo**. Motivo mecánico: los pasos 4-7 dependen
  del `chainKey` y del `bundle` que resuelven los pasos 2-3; invertirlos produce un `undefined` en
  runtime o un mensaje de error que apunta al campo equivocado.
- **CD-13** — El acceso al keypair de Solana es por **`await import()`**, nunca por import estático.
  Un import estático de `@solana/web3.js` en `src/lib/` lo carga en todo proceso que sirva rutas.
- **CD-14** — `payment` es **opcional en las dos rutas**. PROHIBIDO hacerlo obligatorio, PROHIBIDO
  inferir un default, PROHIBIDO backfillear filas existentes. Un `POST /agents` sin `payment` debe
  comportarse **byte-idéntico** a hoy (AC-11).

### Auto-Blindaje — lo que rompió las últimas 3 HUs DONE (223, 222, 221)

Leídos `223-coordinador-como-agente/auto-blindaje.md`, `222-wkh-345-uuid-param-validation/auto-blindaje.md`
y `221-wkh-sec-04-owner-ref-dinero-y-disputas/auto-blindaje.md`. Estos cuatro patrones se repiten en
**≥2 de las 3**, así que dejan de ser anécdota:

- **CD-A1 — PROHIBIDO citar `archivo:línea` sin re-verificarla DESPUÉS de la última edición del diff.**
  Recurrencia **3/3**: WKH-360 (*"Mi propia aritmética de desplazamiento (CD-11) ubicó mal una cita"*,
  *"Barrido de citas: 1 rota por mí"*), WKH-345 (*"Mi propio find/replace me rompió la prosa y las
  citas"*), WKH-SEC-04 (*"Mis propias ediciones corrieron las líneas que yo citaba"*, *"El fix-pack
  anterior invalidó su propia cita al escribirla"*). Al cerrar cada wave: re-abrir **cada** cita
  escrita en esa wave y confirmarla con `sed -n 'Np'`.
- **CD-A2 — PROHIBIDO escribir en un docblock, README o reporte una afirmación que no se midió en esa
  misma sesión.** Recurrencia **3/3**: WKH-345 (*"Copié a un docblock una afirmación del Story File
  que no medí, y era falsa"*), WKH-360 (*"dejé en falso un número publicado en los DOS README"*),
  WKH-SEC-04 (*"Escribí tres afirmaciones que mi propio archivo no podía refutar"*, *"Escribí un aserto
  sobre el fixture que yo había supuesto, no leído"*). Regla operativa: cada frase del diff debe poder
  completarse con "esto sería falso si \_\_\_", y ese \_\_\_ tiene que ser un input concreto.
  **Este SDD ya paga el precio de saltarse esta regla: el work-item afirma `remit-kyc-validator` con
  `payment: null` y hoy es falso (§3.2).**
- **CD-A3 — PROHIBIDO declarar verde corriendo sólo los archivos tocados, y PROHIBIDO medir un exit
  code después de un pipe.** Recurrencia **2/3**: WKH-345 (*"Corrí sólo los archivos que toqué y canté
  verde con 2 rojos en el árbol"*), WKH-SEC-04 (*"Verifiqué el lint con un comando que fallaba por otra
  cosa"*, *"Medí biome con un pipe y me dio el resultado tranquilizador"*). Cierre de wave = `npm test`
  **completo** + `npx tsc --noEmit` + `npm run lint`, sin pipe, con el exit code leído directo.
- **CD-A4 — Todo test negativo necesita su gemelo positivo, y hay que verificar POR QUÉ se puso rojo.**
  Recurrencia **2/3**: WKH-345 (*"T-5, tal como está especificado, no puede matar al mutante que dice
  matar"*), WKH-360 (*"Mi primer T-PROP-3 NO mataba a MUT-15"*, *"Mi testigo moría por la razón
  BARATA"*, *"Un mutante que MATA por el motivo equivocado (178 rojos en vez de 2)"*). Concreto acá:
  el test de AC-5 (zero pubkey Solana) debe fallar por `ZERO_PAYMENT_PAYTO` y **no** por
  `INVALID_PAYMENT_PAYTO_FORMAT` — se assertea el `error_code`, nunca sólo el 422.
- **CD-A5 — PROHIBIDO citar un commit o un documento que todavía no está en el índice de git.**
  Recurrencia **2/3**: WKH-345 (*"Escribí en el log un commit que todavía no existía"*), WKH-SEC-04
  (*"Cité un documento que todavía no estaba en el índice de git"*).
- **CD-A6 — Al agregar un import nuevo a un módulo que otros tests mockean, revisar los mocks de TODOS
  sus consumidores.** WKH-360: *"El Story File listaba 3 mocks que rompen `tsc`; el cuarto rompe en
  RUNTIME y no estaba"*, *"Encender un guard inerte prendió un mock AMPUTADO"*. Concreto y **medido**
  acá: `src/routes/agents.publish.test.ts` **no inicializa el registry de adapters**, así que
  `getAdaptersBundle()` devolverá `undefined` y **todo bloque `payment` será rechazado con AC-3** en
  esos tests. Ver §7 · R-1 para la mitigación obligatoria.

---

## 6. Scope

**IN**
- Los 12 archivos de §4.1.

**OUT**
- `wasiai-remittance-agents`, `chaski-v3`, `wasiai-v2`, `wasiai-facilitator` — **cero bytes**.
- El publicador de manifiesto que consume este endpoint (WKH-317, vive en el otro repo).
- Migración de DB / DDL / backfill de filas existentes (CD-14; y §3.2 muestra que el conjunto a
  migrar está vacío).
- `payment-spec-reader.ts`, `downstream-payment.ts`, `adapters/**`, `discovery.ts` (CD-6). En
  particular **no** se agrega el chequeo de zero-pubkey a la rama Solana del settle
  (**TD-SOLANA-ZERO-PAYTO-SETTLE**).
- Prueba de posesión del payTo (MI-1 / WKH-318).
- Versionado, historial o congelamiento del bloque (el work-item lo argumenta en `:286-315`; el
  reemplazo proporcionado es el log de auditoría de §4.7).
- Los 22 agentes federados: fuera de alcance por arquitectura, no por decisión (§3.2).

---

## 7. Riesgos

| # | Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|---|
| **R-1** | `payment-spec-writer` importa `adapters/registry.js`; las route-tests **no inicializan el registry**, así que `getAdaptersBundle()` → `undefined` y **todo** bloque cae en AC-3. Un Dev que no lo sepa escribe el test "camino feliz", lo ve en 422 y "arregla" el guard. | **Alta** (medido, no estimado) | Alto | Obligatorio: en cada test que espere un publish exitoso con `payment`, mockear `../adapters/registry.js` con `importActual` + override de `getAdaptersBundle`/`getInitializedChainKeys` (patrón de `agents.publish.test.ts:57-73`). **Está escrito en §8 y va al Story File.** |
| **R-2** | El `contract` de las 3 filas vivas (`64KKjZ…`) **podría ser** la pubkey del operador Solana → hoy el fee del agente vuelve al gateway. | Media | Alto (producto, no esta HU) | NC-1. AC-6 lo **detecta**, no lo causa. No hay lock-out: `payment` es opcional en el PATCH, así que ningún otro campo queda inaccesible. |
| **R-3** | DT-3 (rechazar riel no inicializado) impide pre-cargar un agente de un riel apagado. Hoy en prod eso rechaza `avalanche-mainnet`, `base-mainnet`, `kite-mainnet` y `tempo-testnet` (medido en `/capabilities`). | Alta | Bajo | Es la decisión, no un accidente: el 422 lista `getInitializedChainKeys()` y llega en el único momento en que hay un humano mirando. Alternativa (aceptar y fallar en settle) publica una fila que nunca cobra y se entera nadie. |
| **R-4** | AC-12 estricto rechaza `asset: "USDC"` en `kite-ozone-testnet` (símbolo por defecto `PYUSD`) y en `tempo-testnet` (`AlphaUSD`). | Media | Bajo | Documentado en §3.3 y en `doc/INTEGRATION.md`. No mueve dinero: `asset` no lo lee ningún camino de settle. |
| **R-5** | La primera carga de `getSolanaOperatorKeypair()` la dispararía esta HU, y su aserción WKH-315 (que **lanza**) quedaría tragada por el `catch` de AC-6. | Baja | Medio | El `catch` loguea `code: 'PAYTO_OPERATOR_CHECK_SKIPPED'` **con el `err.message`** server-side. Nunca silencio. |
| **R-6** | Conflicto de merge en `src/types/index.ts` con WKH-314/315. | Media | Bajo | El hunk de esta HU es **aditivo** (dos props opcionales + una interfaz nueva). Quien mergee segundo resuelve trivial. |
| **R-7** | Un `PATCH` con `payment: null` sobre una fila cuyo `metadata` era `{payment: X}` deja `metadata = {}` en vez de `NULL`. | Media | Muy bajo | §4.4b: si tras el merge `Object.keys(meta).length === 0` se escribe `null`, igual que `buildMetadata:197`. Observablemente idéntico (`readMetadataObject` mapea ambos a `{}`), pero mantiene "NULL = nada declarado". |

---

## 8. Plan de tests (≥1 por AC)

`npm test` es `vitest run`. ⚠️ **`npx vitest run > archivo` bajo el hook de `rtk` trunca a 500 chars y
devuelve exit 0** — correr sin redirección. **No existe script `qa`**: son `test`, `lint`
(`biome check src/` — no cubre `test/`) y `build`.

| AC | Test | Archivo | Qué prueba, y qué lo pondría rojo |
|---|---|---|---|
| **AC-1** | `T-316-01` | `agents.publish.test.ts` | POST con bloque válido → **201** y `body.payment` con las 4 keys. Rojo si `mapRowToRecord` no expone el campo. |
| **AC-1** | `T-316-02` | `agent.payment.test.ts` | `publish()` con supabase espiado → el `insert` recibe `metadata.payment` con exactamente las 4 keys. Rojo si `buildMetadata` no la escribe. |
| **AC-1** | `T-316-03` | `agent.payment.test.ts` | Fila con el bloque recién escrito → `listAsAgents()[0].payment` sale por `readPaymentSpec` **con** `resolvedChain`/`network`. Prueba el round-trip escritor→lector sin tocar el lector. |
| **AC-2** | `T-316-04` | `payment-spec-writer.test.ts` + route | `chain: 'polygon'` → `INVALID_PAYMENT_CHAIN` + 422. **Gemelo anti-vacuidad**: `chain: 'avalanche'` pasa el paso 2. **Y** el espía de supabase registra **cero** `insert`/`update` (la mitad "SHALL NOT touch any row"). |
| **AC-3** | `T-316-05` | `payment-spec-writer.test.ts` | Registry con `{avalanche-fuji}` y `chain: 'solana-devnet'` → `PAYMENT_CHAIN_NOT_INITIALIZED` **y** `initializedChains` contiene `avalanche-fuji`. |
| **AC-4** | `T-316-06` | `payment-spec-writer.test.ts` | Cruce de familias: base58 en slot EVM y `0x…` en slot Solana → los dos `INVALID_PAYMENT_PAYTO_FORMAT`. |
| **AC-4** | `T-316-07` | `payment-spec-writer.test.ts` | **Anti-caja**: un payTo Solana con mayúsculas y minúsculas mezcladas se persiste **carácter por carácter idéntico** (`expect(block.contract).toBe(input)`). Rojo si alguien mete un `toLowerCase()` (CD-3). |
| **AC-5** | `T-316-08` | `payment-spec-writer.test.ts` | `'1'.repeat(32)` → `ZERO_PAYMENT_PAYTO`. **Se assertea el `error_code`, no el 422** (CD-A4): ese valor **pasa** `isValidSolanaAddress`, así que un rojo por `INVALID_PAYMENT_PAYTO_FORMAT` sería una muerte falsa. |
| **AC-5** | `T-316-09` | `payment-spec-writer.test.ts` | `0x0000…0000` en 3 cajas distintas → `ZERO_PAYMENT_PAYTO` las 3 veces. |
| **AC-6** | `T-316-10` | `payment-spec-writer.test.ts` | Con `resolveOperatorAddress` mockeado a una address → payTo igual ⇒ `PAYTO_IS_OPERATOR`; payTo distinto ⇒ acepta. EVM: la variante en otra caja **también** rechaza. |
| **AC-6** | `T-316-11` | `operator-address.test.ts` | `OPERATOR_PRIVATE_KEY` ausente / basura ⇒ `null` **sin lanzar**; `validatePaymentBlock` acepta y marca `operatorCheckSkipped`, y el route loguea `PAYTO_OPERATOR_CHECK_SKIPPED`. |
| **AC-7** | `T-316-12` | `agents.ownership.test.ts` | PATCH cross-owner con `payment` válido → **404** `Agent not found`, y el espía de supabase confirma **cero** `update`. |
| **AC-7** | `T-316-13` | `agent.payment.test.ts` | `metadata` previo `{inputSchema, outputSchema, discoverable}` + PATCH sólo con `payment` → el `update` recibe las **4** keys. Rojo si se reescribe el objeto (CD-7). |
| **AC-7** | `T-316-14` | `agent.payment.test.ts` | El log de auditoría se emite con `prev` y `next`, y con `ownerRefHash` **≠** el `owner_ref` en claro (16 hex). |
| **AC-8** | `T-316-15` | `agent.payment.test.ts` | PATCH `payment: null` sobre `{inputSchema, payment}` → el `update` recibe `{inputSchema}` y **el `inputSchema` es el MISMO objeto** (`toEqual` estricto). |
| **AC-8** | `T-316-16` | `agent.payment.test.ts` | PATCH `payment: null` sobre `{payment}` solo → `metadata: null` (R-7). |
| **AC-9** | `T-316-17` | `agent.payment.test.ts` | **Byte-identidad (CD-1)**: dos filas — una con `metadata` sin `payment`, otra con el bloque sembrado real de las 3 filas vivas — pasan por `listAsAgents()` y se compara `JSON.stringify` contra un **literal escrito a mano**. Rojo ante cualquier key nueva, `payment: null` donde antes había ausencia, o reordenamiento. |
| **AC-9** | `T-316-18` | `agent.payment.test.ts` | El bloque sembrado **no** se re-valida: una fila con `chain: 'polygon'` en `metadata.payment` se lee igual que hoy (el reader la omite) y **nada la reescribe**. |
| **AC-10** | `T-316-19` | `payment-spec-writer.test.ts` | `'X402'`, `' x402 '` y `'eip3009'` → `UNSUPPORTED_PAYMENT_METHOD`. Gemelo: `'x402'` pasa. |
| **AC-11** | `T-316-20` | `agents.publish.test.ts` + `agent.payment.test.ts` | POST **sin** `payment` → el `insert` recibe `metadata: null` y `record.payment` es `undefined` (**no** `null`). Rojo si el campo aparece como `null`. |
| **AC-12** | `T-316-21` | `payment-spec-writer.test.ts` | Adapter con `supportedTokens[0].symbol = 'USDC'`: `asset: 'usdc'` **acepta** (case-insensitive), `asset: 'PEN'` → `PAYMENT_ASSET_MISMATCH`, `asset` ausente → acepta. |
| **CD-10** | `T-316-22` | `payment-spec-writer.test.ts` | Input con `resolvedChain: 'avalanche-mainnet'`, `network: 'mainnet'` y `sarasa: 1` → el bloque devuelto tiene **exactamente** `['method','chain','contract','asset']` (`Object.keys`). |
| **CD-2** | `T-316-23` | `payment-spec-writer.test.ts` | Espías sobre `normalizeChainSlug` / `isValidPayoutWallet` delegando en el real (patrón `agent.payment.test.ts:36-46`): si alguien escribió un validador paralelo, el espía no registra la llamada. |
| **Estructural** | `T-316-24` | `test/` | `src/routes/agents.ts` y `src/services/agent.ts` **no** contienen `normalizeChainSlug(` aplicado a `payment` ni un regex de address nuevo (CD-9). Grep estructural sobre el fuente. |

**Puertas de cierre de cada wave** (CD-A3, sin pipes, exit code leído directo):
`npm test` completo · `npx tsc --noEmit` · `npm run lint`.
**Línea base a superar, no a igualar**: `286 archivos / 5624 passed | 19 skipped`, `tsc` exit 0.

---

## 9. Waves

### W0 — Contratos (SERIAL, bloquea todo)
- `src/types/index.ts`: `AgentPaymentSpecInput` + `payment?` en `PublishAgentInput` /
  `payment?: … | null` en `UpdateAgentInput`.
- `src/services/agent.ts`: **sólo** `PublishedAgentRecord.payment?: AgentPaymentSpecInput` (el campo del
  tipo, sin lógica).
- Puerta: `npx tsc --noEmit` exit 0. **Cero cambios de comportamiento** → `npm test` idéntico a la base.

### W1 — `operator-address` (SERIAL, depende de W0)
- Crear `src/lib/operator-address.ts` + `src/lib/operator-address.test.ts`.
- Puerta: `npm test` + `tsc` + `lint`.

### W2 — El validador (SERIAL, depende de W0 + W1)
- Crear `src/lib/payment-spec-writer.ts` + `src/lib/payment-spec-writer.test.ts`.
- Cubre T-316-04..11, 19, 21, 22, 23.
- Puerta: ídem.

### W3A — Route (PARALELIZABLE con W3B, depende de W2)
- `src/routes/agents.ts` (POST + PATCH) · `agents.publish.test.ts` · `agents.ownership.test.ts`.
- Cubre T-316-01, 12, 20.
- ⚠️ Empezar por el mock del registry (R-1) **antes** de escribir el primer test de camino feliz.

### W3B — Service (PARALELIZABLE con W3A, depende de W2)
- `src/services/agent.ts` (`buildMetadata`, merge del PATCH, `mapRowToRecord`, defense-in-depth,
  llamada al log) · `agent.payment.test.ts`.
- Cubre T-316-02, 03, 13..18.

### W4 — Docs + estructural (depende de W3A + W3B)
- `doc/INTEGRATION.md` (subsección nueva en §3 + los 8 `error_code`) · `README.md:287` (una línea).
- `T-316-24`.
- Puerta final: `npm test` completo · `tsc` · `lint` · **barrido CD-A1 de todas las citas escritas en
  las 5 waves**.

---

## 10. Uncertainty Markers

| Marker | Sección | Descripción | ¿Bloquea SPEC_APPROVED? |
|---|---|---|---|
| **NC-1** `[NEEDS CLARIFICATION]` | §3.2 · R-2 | ¿`64KKjZFSMZRucKPqTpGydrUFeFdLHDhbHTJVGmEaXS6z` (el `contract` de los 3 agentes Solana vivos) **es** la pubkey del operador Solana del gateway? No es determinable desde el árbol: exige `SOLANA_OPERATOR_PRIVATE_KEY`, que vive en Railway. **Cómo se resuelve**: en el proceso desplegado, `getSolanaOperatorKeypair().publicKey.toBase58()` (`src/adapters/solana/chain.ts:84`) — el arranque ya lo loguea como `solana operator loaded` (`:95`). Si coincide, los 3 agentes le están pagando al gateway y hay una HU nueva. | **NO.** AC-6 se implementa igual y detecta el caso. No cambia una línea de este diseño. |
| **NC-2** `[NEEDS CLARIFICATION]` | §3.2 | ¿Existe alguna fila `a2a_agents` con `enabled = false` y sin `metadata.payment`? `/discover` sólo muestra `enabled = true`, y no consulté la base. | **NO.** AC-11 y CD-14 ya cubren el caso "sin bloque": se queda sin bloque. Ninguna fila se toca. |
| **NC-3** `[DECIDE FOUNDER]` | MI-1 | Prueba de posesión del payTo. Recomendación del analyst: **no** exigirla ahora (declarar la billetera de un tercero le **regala** plata a ese tercero; el daño es de atribución, no de custodia). | **NO** para F2. El diseño es aditivo: si el founder dice que sí, WKH-318 agrega un guard más a `validatePaymentBlock`. |
| **[TBD]** | §4.7 | Retención del log de auditoría (¿cuánto vive un `log.info` de Railway?). No lo determiné. | **NO.** Fuera de alcance del código. |

**Corrección de hecho, no marcador**: el work-item afirma que esta HU desbloquea el cobro del KYC en
Solana. **Medido hoy: ya está desbloqueado por siembra manual** (§3.2). La HU sigue siendo necesaria
por el camino de escritura por API y por WKH-314, pero **esa justificación en particular está vencida** y
no debe repetirse en el Story File ni en el reporte final.

---

## 11. Dependencias

**Ya mergeadas, nada bloquea:** WKH-241 (el lector), WKH-234 (familias de VM + `isValidSolanaAddress`
+ riel Solana flag-gated), WKH-134 / WKH-143b (el CRUD self-published y el patrón de write-boundary).

**Esta HU bloquea:** WKH-314 (x402 inbound Solana necesita el campo persistido) y WKH-317 (el
publicador de manifiesto, que vive en `wasiai-remittance-agents`).
**Ya NO bloquea:** el cobro del KYC en Solana (§3.2).

**Paralelismo:** único punto de roce es `src/types/index.ts` con WKH-314/315 (R-6). Los otros 4
archivos de producción son exclusivos de esta HU.

---

## 12. Readiness Check

| # | Criterio | Estado |
|---|---|---|
| 1 | Todos los paths referenciados existen | ✅ Verificados uno por uno con `test -f` (24 archivos). |
| 2 | Todas las líneas citadas re-leídas contra `main` @ `8242b16` | ✅ Las del work-item estaban corridas (`types/index.ts:191-218` → **`:282-309`**; `agent.ts:177-189` → **`:186-198`**; `:556-571` → **`:645-660`**) y este SDD usa las reales. |
| 3 | Stack respetado | ✅ TS strict + `exactOptionalPropertyTypes`, Fastify, Supabase service-key, Biome, Vitest. Cero dependencias nuevas (`viem` y `@solana/web3.js` ya son directas). |
| 4 | Cero DDL / cero migración | ✅ §3.5. |
| 5 | Cero queries nuevas sobre tablas con `owner_ref` | ✅ §3.5. `ownership-filter-guard` y su archivo de excepciones no se tocan. |
| 6 | Missing Inputs del work-item resueltos | ✅ MI-2, MI-3, MI-5 resueltos con medición. MI-4 resuelto parcialmente y despriorizado con motivo. MI-1 es `[DECIDE FOUNDER]` y **no** bloquea. |
| 7 | Los 12 ACs tienen ≥1 test nominado, con archivo | ✅ §8, 24 tests. |
| 8 | Los 8 CDs del work-item heredados íntegros | ✅ §5. |
| 9 | Auto-Blindaje histórico incorporado | ✅ CD-A1..A6, de las 3 últimas HUs DONE, con la recurrencia contada. |
| 10 | Decisión sobre los agentes ya publicados, con motivo | ✅ §3.2 + CD-14: **cero filas tocadas**, y está medido que el conjunto a migrar está vacío. |
| 11 | Compatibilidad hacia atrás demostrable | ✅ AC-11 + CD-14 + T-316-17/20 (byte-identidad contra literal escrito a mano). |
| 12 | `[NEEDS CLARIFICATION]` bloqueantes | ✅ **Ninguno.** Los 3 marcadores de §10 están declarados no-bloqueantes con motivo. |
| 13 | Fila de `_INDEX.md` | ✅ La fila `214` ya existe (`doc/sdd/_INDEX.md:181`). **No se toca** en F2. |

**Veredicto: LISTO PARA SPEC_APPROVED.**

---

*SDD generado por NexusAgil — FULL · nexus-architect · F2*
