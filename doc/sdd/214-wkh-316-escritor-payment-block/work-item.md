# Work Item — [WKH-316] El escritor del bloque de pago de un agente

**Fecha**: 2026-07-29
**Fase**: F1 (F0 + F1 por `nexus-analyst`)
**Ticket**: WKH-316
**NNN**: 214 (verificado: el directorio más alto de `doc/sdd/` es `213-wkh-315-deposito-prepago-solana`;
`210`, `211`, `212` y `213` están tomados)

---

## Resumen

Hoy **nadie puede publicar por API un agente que declare en qué red cobra**. El lector de
`metadata.payment` existe y corre en producción (WKH-241); el **escritor nunca existió**. Esta HU
agrega `payment` a `POST /agents` y `PATCH /agents/:slug` con los guards de write-boundary que el
camino del dinero exige, reusando los validadores que ya son fuente única de verdad.

---

## F0 — Codebase Grounding (verificado, con archivo:línea)

### El hallazgo, confirmado

| Afirmación | Evidencia |
|---|---|
| `PublishAgentInput` no tiene `payment` | `src/types/index.ts:191-218` — los campos son `name`, `agentUrl`, `capabilities`, `description`, `priceUsdc`, `inputSchema`, `outputSchema`, `discoverable`, `payoutWallet`, `referrerRef`, `payoutChain`. Ninguno es `payment`. |
| `UpdateAgentInput` tampoco | `src/types/index.ts:224-239` — mismo subconjunto. |
| `buildMetadata` sólo persiste 3 keys | `src/services/agent.ts:177-189` — `inputSchema`, `outputSchema`, `discoverable`. Si no hay ninguna devuelve `null`. |
| El merge de metadata del PATCH también sólo 3 keys | `src/services/agent.ts:556-571` — el `if` que decide si tocar `metadata` sólo mira esos tres campos. |
| El lector existe y se usa | `src/lib/payment-spec-reader.ts:129-179` (`readPaymentSpec`), consumido por `src/services/agent.ts:147` (self-published) y por el mapper de registries externos (`discovery.ts` `mapAgent`). |
| El campo se lee en producción y el catálogo es público | `GET /discover` (`src/routes/discover.ts:79-117`) no exige auth; `GET /capabilities` (`src/routes/capabilities.ts:62-77`) devuelve `agents: discovered.agents`, o sea el MISMO shape `Agent` con su `payment`. |
| Las dos filas Solana se sembraron fuera del repo | `doc/sdd/184-wkh-241-expose-self-published-payment-spec/done-report.md:40` — "2 target agents already have `metadata.payment` in dev DB (seedeado outside this repo)". |
| Esta HU ya estaba anticipada como pre-requisito | mismo done-report, `:242` (AR-4): *"When write-path API is added (`POST`/`PATCH /agents` accepting `metadata.payment`), will need allowlist of operator's allowed payment chains + payTo ownership verification, else becomes BLQ-ALTO"*. |
| No existe ningún publicador | busqué `**/*publish*` en `wasiai-remittance-agents` y `scripts/**/*agent*` en este repo: no hay script que haga `POST /agents`. |

### El camino de alta y actualización, completo

| Endpoint | Ruta | Auth | Autorización | Servicio | Tabla |
|---|---|---|---|---|---|
| `POST /agents` | `src/routes/agents.ts:118-284` | `requireA2AKey()` (`:121`) — **auth-only, gratis**, no invoca pago | `request.a2aKeyRow` obligatorio → si falta, 403 `A2A_KEY_REQUIRED` (`:158-161`, helper `:56-63`). El `owner_ref` del insert sale de `keyRow.owner_ref` (`:263-266`) | `publishedAgentService.publish` (`src/services/agent.ts:343-423`) | `a2a_agents` |
| `PATCH /agents/:slug` | `src/routes/agents.ts:289-414` | idem (`:295`) | idem 403; el `owner_ref` se pasa al service (`:397-401`) | `publishedAgentService.update` (`src/services/agent.ts:487-596`) | `a2a_agents` |
| `DELETE /agents/:slug` | `src/routes/agents.ts:419-454` | idem | idem | `.delete` (`:602-633`) | `a2a_agents` |
| `GET /agents` (list-mine) | `src/routes/agents.ts:460-482` | idem | owner-scoped | `.listMine` (`:466-476`) | `a2a_agents` |

**Guard de dueño — cumplido hoy y reusable tal cual.** `update` hace: (1) pre-fetch por slug
(`agent.ts:492`), (2) compara `existing.owner_ref !== ownerRef` → `OwnershipMismatchError`
(`:501-509`), (3) el UPDATE final filtra por `.eq('slug', slug).eq('owner_ref', ownerRef)`
(`:576-577`) como defensa TOCTOU, (4) `PGRST116` → 404 disclosure-safe (`:584-591`). El route mapea
`OwnershipMismatchError` a **404** (no 403) para no distinguir "no existe" de "es de otro dueño"
(`routes/agents.ts:45-53`). Como el bloque de pago se escribe **dentro de la columna `metadata` de ese
mismo UPDATE**, hereda el guard sin una línea nueva de seguridad — igual que hizo `payoutWallet` en
WKH-143b (`agent.ts:548-552`).

**No hace falta migración de DB.** `a2a_agents.metadata` ya es `Json | null`
(`src/types/database.types.ts:59`) y el bloque vive adentro. Ojo con la asimetría existente: no hay
columna `payout_chain` en la tabla (`database.types.ts:52-96`), así que el `payoutChain` del input de
hoy es **sólo contexto de validación, nunca se persiste** (`agent.ts:213-222` lo usa para resolver el
namespace y se descarta). El `payment.chain` de esta HU **sí** se persiste, porque va en el JSONB.

### Semántica de los campos, y qué NO significan

El bloque publicado es `{ method, chain, contract, asset }` (`src/types/index.ts:163-171`).

- **`contract` es la BILLETERA DE COBRO, no el token.** Confirmado en el productor real:
  `wasiai-remittance-agents/src/manifest/build.ts:42-47` arma
  `payment: { method: "x402", chain: entry.chain, contract: resolved.payTo, asset: entry.asset }`,
  donde `resolved.payTo` viene de `resolvePayTo` (`paytos.ts:10-32`), que lee una env `*_PAYTO`.
  Y confirmado en el consumidor: `downstream-payment.ts:744` hace
  `validatePayTo(agent.payment.contract)` y `:261` hace `const payTo = agent.payment?.contract`.
  El nombre es engañoso y **ya hizo fabricar un hallazgo falso en esta sesión**.
- **`asset` es decorativo hoy.** El monto y los decimales del settle salen SIEMPRE de
  `adapter.supportedTokens[0]` (`downstream-payment.ts:284` en la rama Solana, `:777-785` en la EVM),
  **nunca** del `asset` declarado. Declarar `asset: "PEN"` no cambia un centavo de lo que se
  transfiere: cambia lo que el catálogo público **dice**.
- **`method` sólo es honrado si vale `x402`.** `downstream-payment.ts:625-635` corta con
  `METHOD_NOT_SUPPORTED` para cualquier otro valor.

### Qué valida el gateway HOY, y dónde

| Control | Dónde | Cuándo |
|---|---|---|
| chain conocida por el resolver | `payment-spec-reader.ts:160-163` (`normalizeChainSlug`) | READ (discovery). Chain desconocida → `payment` se **omite** entero, sin error. |
| chain inicializada en el proceso | `downstream-payment.ts:640-653` (`getAdaptersBundle`) | SETTLE → skip `CHAIN_NOT_SUPPORTED` |
| formato del payTo EVM | `downstream-payment.ts:221-234` (`validatePayTo` → `isValidWallet`) | SETTLE → skip `INVALID_PAY_TO_FORMAT` |
| zero-address EVM | `downstream-payment.ts:230-232` | SETTLE → skip `ZERO_PAY_TO` |
| formato del payTo Solana | `downstream-payment.ts:261-268` (`isValidSolanaAddress`) | SETTLE → skip `INVALID_PAY_TO_FORMAT`. **NO hay chequeo de zero/System-Program en la rama Solana.** |
| gate mainnet fail-closed | `downstream-payment.ts:710-728` (`WASIAI_DOWNSTREAM_MAINNET_ALLOW`) | SETTLE → skip `MAINNET_NOT_ALLOWED` |
| formato del payTo en el WRITE path | `routes/agents.ts:83-95` + `services/agent.ts:233-239` | **sólo para `payoutWallet`** (el creator-split del 1%), NO para el payTo del precio completo |

O sea: **todo el control del bloque de pago vive en settle-time**. Un bloque basura hoy no se puede
ni escribir; en cuanto se pueda, sin guards de write-boundary se publicaría una fila que **nunca va a
cobrar** y el catálogo público mentiría hasta que alguien mire un log de skip.

### Los dos footguns que hay que respetar

1. **`getSupportedChains()` NO está exportada.** El brief la señala en
   `src/adapters/registry.ts:70-75`, y ahí está — pero es **privada del módulo** (`function
   getSupportedChains()`, sin `export`). Los accesores exportados son
   `getInitializedChainKeys()` (`registry.ts:481-483`), `getAdaptersBundle(key)` (`:468-475`) y
   `getInboundPaymentChainKeys()` (`:520-525`). El escritor **debe** usar los exportados: son además
   más precisos (la lista de chains realmente inicializadas en ESTE proceso, no la de slugs
   teóricamente soportados).
2. **`toLowerCase()` es correcto para hex y DESTRUYE base58.** El único uso legítimo está dentro de
   la rama EVM: `downstream-payment.ts:230` compara `contract.toLowerCase()` contra la zero-address
   **después** de que `isValidWallet` ya garantizó que es hex (`:227`). El repo hermano documenta la
   misma disciplina y la aplica bien: `wasiai-remittance-agents/src/manifest/wallet-format.ts:19-21`
   define `isZeroAddress` con `toLowerCase()` y `paytos.ts:28` lo llama **sólo si**
   `entry.family === "evm"`. Base58 es case-sensitive: `toLowerCase()` sobre una pubkey Solana
   produce otra cadena, casi siempre inválida, y si por casualidad decodifica a 32 bytes produce
   **otra billetera**. Verificado: hoy el write path de este repo NO lowercasea ninguna wallet.

---

## Sizing

- **Modo del proyecto**: QUALITY (invariante de `CLAUDE.md` para wasiai-a2a).
- **SDD_MODE**: `full`. No es `mini` a pesar de ser aditivo y chico: es un **write path que decide a
  qué dirección va el dinero** de un agente. WKH-241 pudo ir FAST+AR porque era read-only; esto no.
- **Estimación**: **M**. 1 módulo leaf nuevo (~120 LOC), 2 guards de route, 3 puntos de servicio,
  ~25 tests. Sin migración de DB, sin cambios en el settle, sin cambios en el read path.
- **Contra la semana del 2026-08-03**: entra con holgura. La superficie es acotada y los cuatro
  validadores que necesita ya existen y están testeados.
- **Branch sugerido**: `feat/214-wkh-316-payment-block-writer`

---

## Acceptance Criteria (EARS)

- **AC-1** — WHEN a `POST /agents` request authenticated with a valid a2a-key includes
  `payment: { method, chain, contract, asset? }` that passes every guard of AC-2..AC-6 and AC-10,
  the system SHALL persist that block verbatim under the `payment` key of the row's `metadata`
  JSONB, SHALL return it in the 201 response body, and the subsequent `GET /discover` SHALL expose
  it as `agent.payment` through the existing reader (`payment-spec-reader.ts`) with no change to
  that reader.

- **AC-2** — IF the declared `payment.chain` does not resolve to a `ChainKey` via
  `normalizeChainSlug` (`src/adapters/chain-resolver.ts:322-327`), THEN the system SHALL reject the
  request with `422` and `error_code: INVALID_PAYMENT_CHAIN`, and SHALL NOT insert, update or
  otherwise touch any row of `a2a_agents`.

- **AC-3** — IF the declared `payment.chain` resolves to a `ChainKey` that the running registry has
  NOT initialized (`getAdaptersBundle(chainKey) === undefined` — the case of `solana-devnet` with
  `SOLANA_ADAPTER_ENABLED` off, or `tempo-testnet` with `TEMPO_ADAPTER_ENABLED` off), THEN the
  system SHALL reject with `422` and `error_code: PAYMENT_CHAIN_NOT_INITIALIZED`, and the response
  SHALL include the actionable list `getInitializedChainKeys()`.

- **AC-4** — IF the declared `payment.contract`, after trimming surrounding whitespace, does not
  satisfy `isValidPayoutWallet(contract, ns)` where `ns` is derived from
  `getChainVmFamily(chainKey)` (`chain-resolver.ts:98-100`), THEN the system SHALL reject with `422`
  and `error_code: INVALID_PAYMENT_PAYTO_FORMAT`; AND WHILE validating or persisting the value the
  system SHALL NOT alter its letter case (a `0x…` in a Solana slot and a base58 in an EVM slot are
  BOTH rejected by this single rule).

- **AC-5** — IF the declared `payment.contract` is the EVM zero address (in any letter case) for an
  EVM chain, or the all-zero Solana pubkey `11111111111111111111111111111111` for a Solana chain,
  THEN the system SHALL reject with `422` and `error_code: ZERO_PAYMENT_PAYTO`.

- **AC-6** — IF the declared `payment.contract` equals the gateway operator's own address for that
  VM family AND that address is resolvable in the running process, THEN the system SHALL reject
  with `422` and `error_code: PAYTO_IS_OPERATOR`; WHERE the operator address is not resolvable
  (key not configured for that family), the system SHALL accept the request and SHALL log
  `code: PAYTO_OPERATOR_CHECK_SKIPPED`.

- **AC-7** — WHEN a `PATCH /agents/:slug` request includes `payment`, the system SHALL apply the
  same guards as AC-2..AC-6 and AC-10, SHALL resolve authorization through the EXISTING ownership
  guard of `publishedAgentService.update` (pre-fetch + `owner_ref` comparison + UPDATE filtered by
  `.eq('slug', …).eq('owner_ref', …)`), SHALL respond `404 Agent not found` when the caller is not
  the owner, and SHALL merge the block over the existing `metadata` WITHOUT deleting
  `inputSchema`, `outputSchema` or `discoverable`.

- **AC-8** — WHEN a `PATCH /agents/:slug` request sends `payment: null` explicitly, the system SHALL
  delete the `payment` key from that row's `metadata` and SHALL leave every other key of `metadata`
  byte-identical.

- **AC-9** — WHILE a row's `metadata` has not been written by this HU's write path, the system SHALL
  return byte-identical `GET /discover` and `GET /capabilities` JSON for that agent, SHALL NOT
  re-validate the `payment` block already stored in the two seeded Solana rows, and SHALL NOT
  rewrite, normalize or migrate any pre-existing `metadata`.

- **AC-10** — IF `payment` is present and `payment.method` is not exactly the string `x402`, THEN
  the system SHALL reject with `422` and `error_code: UNSUPPORTED_PAYMENT_METHOD` (the settle path
  honours no other method — `downstream-payment.ts:625-635` — so any other value publishes a block
  that can never pay).

- **AC-11** — WHERE the request body omits `payment` entirely, the system SHALL behave exactly as
  today: no `payment` key is written to `metadata`, `buildMetadata` still returns `null` when no
  other metadata field is present, and the resulting `Agent.payment` remains `undefined`.

- **AC-12** — WHEN `payment` is present and `payment.asset` is present, the system SHALL compare it
  case-insensitively against `supportedTokens[0].symbol` of the resolved chain's payment adapter and
  SHALL reject a mismatch with `422` and `error_code: PAYMENT_ASSET_MISMATCH`
  (**condicionado** — ver Missing Inputs MI-2: si en F2 se verifica que el símbolo del token del
  adapter Solana no es exactamente `USDC`, este AC se degrada a log de advertencia sin rechazo, para
  no bloquear a los colaboradores por una etiqueta).

---

## Scope IN

- `src/lib/payment-spec-writer.ts` — **NUEVO**, módulo leaf. El único validador del bloque en el
  write path (espejo estructural de `payment-spec-reader.ts`).
- `src/lib/payment-spec-writer.test.ts` — NUEVO.
- `src/types/index.ts` — agregar `payment?: AgentPaymentSpecInput` a `PublishAgentInput`
  (`:191-218`) y `payment?: AgentPaymentSpecInput | null` a `UpdateAgentInput` (`:224-239`).
- `src/routes/agents.ts` — guard de write-boundary + los 7 `error_code` nuevos, en POST (`:118-284`)
  y PATCH (`:289-414`); captura condicional del campo hacia el input (patrón `:255-261`).
- `src/services/agent.ts` — `buildMetadata` (`:177-189`) escribe la key `payment`; el merge del
  PATCH (`:556-571`) la mergea/borra; `PublishedAgentRecord` (`:65-77`) y `mapRowToRecord`
  (`:152-171`) la exponen en la respuesta de publish/update/list-mine; defense-in-depth en
  `publish` (`:368-375`) y `update` (`:523-532`), igual que `assertValidPayoutWallet`.
- `src/services/agent.test.ts`, `src/routes/agents.publish.test.ts`,
  `src/routes/agents.ownership.test.ts` — tests.
- `README.md` + `doc/INTEGRATION.md` — documentar el campo nuevo y su semántica
  (`contract` = billetera de cobro, NO el token).
- `doc/sdd/214-wkh-316-escritor-payment-block/` — artefactos del pipeline.

## Scope OUT

- **`wasiai-remittance-agents`: NO se toca.** Ese repo ya **produce** el documento
  (`src/manifest/build.ts:33-49`, con su propio fail-closed en `paytos.ts`). El corte es:
  *ese repo produce el manifiesto, este repo lo acepta*. **Un escritor por repo.** El script que lee
  el manifiesto y hace el `POST /agents` es **otra HU, y vive en el repo de los agentes**
  (propuesta: **WKH-317**, "publicador de manifiesto"). Hoy ese publicador **no existe** en ningún
  repo (verificado).
- Migración de DB / DDL. `metadata` ya es JSONB.
- `src/lib/payment-spec-reader.ts` y `src/lib/downstream-payment.ts` — **intocables**.
  En particular NO se agrega el chequeo de zero-pubkey a la rama Solana del settle (queda como
  **TD-SOLANA-ZERO-PAYTO-SETTLE**): cambiar qué payTos settlea es un cambio observable del camino
  del dinero, fuera del alcance de un write path.
- Prueba de posesión del payTo (`[DECIDE FOUNDER]`, ver MI-1).
- Versionado / historial / congelamiento del bloque de pago (ver "Actualización posterior").
- Mover el cobro de `remit-kyc-validator` a Solana — **es la HU que ésta desbloquea**, no ésta.
- Inbound x402 sobre Solana (WKH-314) y depósito prepago Solana (WKH-315).
- Agentes de registries **federados**: su `payment` lo sirve el registry en su propio payload
  (`discovery.ts` `mapAgent`); este escritor sólo alcanza a las filas de `a2a_agents`.

---

## Decisiones técnicas (DT-N)

- **DT-1 — El validador va en un módulo LEAF nuevo (`payment-spec-writer.ts`), no dentro del route
  ni del service.** Lo necesitan los dos: el route (para el 422 con `error_code`) y el service
  (defense-in-depth, patrón ya establecido por `assertValidPayoutWallet`, `agent.ts:233-239`). Un
  leaf sin dependencias evita el ciclo `discovery.ts ⇄ agent.ts` (auto-blindaje WKH-241 W0) y evita
  que las suites que mockean módulos gordos completos lo dejen `undefined` (auto-blindaje P1
  hallazgo 4, que rompió 84 tests). Es el mismo patrón de `wallet-format.ts`, `chain-resolver.ts`,
  `price.ts` y `downstream-skip-code.ts`.

- **DT-2 — `payment` es OPCIONAL en el alta.** Los ~23 agentes que hoy no lo tienen siguen
  publicándose y descubriéndose igual (AC-11). Hacerlo obligatorio rompería toda publicación
  existente y no hay dato del cual inferir un default: inventar uno significaría elegir por el
  agente **a qué billetera le pagan**.

- **DT-3 — La chain se valida en DOS capas y las dos rechazan.** (a) slug conocido por el resolver
  puro (`normalizeChainSlug`), (b) bundle realmente inicializado en el proceso
  (`getAdaptersBundle`). Rechazar en (b) es deliberado y es la decisión discutible de esta HU:
  el costo es que con la bandera de un rail apagada no se puede pre-cargar un agente de ese rail, y
  que el resultado del publish depende de la config del proceso. El beneficio es que **no se emite
  una fila que jamás puede cobrar**: si se aceptara, el agente queda descubrible, se lo invoca, se
  le debita al caller y su fee se salta con `CHAIN_NOT_SUPPORTED` en un log que nadie mira. Un 422
  accionable que además lista `getInitializedChainKeys()` le dice al colaborador exactamente qué
  pasa, en el único momento en que un humano está mirando.

- **DT-4 — El `asset` se valida contra el símbolo del token del adapter, no contra la cadena, y NO
  se valida su existencia on-chain.** No hace falta ir a la cadena: los decimales y el monto salen
  SIEMPRE de `adapter.supportedTokens[0]` (`downstream-payment.ts:284`, `:777-785`), nunca del
  `asset` declarado. Declarar un token inexistente **no puede cambiar lo que se transfiere** — el
  único daño es un catálogo público que miente. Por eso el control correcto es una comparación con
  el símbolo que el adapter ya expone (`TokenSpec.symbol`, `src/adapters/types.ts:6-10`), gratis
  porque el bundle ya está resuelto por DT-3, y no una consulta RPC.

- **DT-5 — El payTo se declara, no se prueba.** Ver MI-1 para el argumento completo y el
  `[DECIDE FOUNDER]`.

- **DT-6 — Sin versionado ni congelamiento del bloque.** Ver la sección siguiente.

- **DT-7 — El bloque se persiste VERBATIM (pass-through), salvo el `trim()` de los bordes del
  `contract`.** Ninguna normalización de `chain` en el write path: el read path ya tiene su propia
  normalización de salida documentada y sensible (`payment-spec-reader.ts:65-72`,
  `resolveAvalancheOutputChain`, con dos excepciones intencionales en el namespace avalanche).
  Normalizar también al escribir crearía **dos** normalizadores en cadena y una divergencia
  imposible de razonar.

---

## Actualización posterior del bloque de pago — la respuesta explícita

**Sí, el dueño puede modificar su propio bloque de pago después (AC-7), y NO hace falta versionado
ni congelamiento.** El razonamiento, porque es camino del dinero:

1. **Quién puede.** Sólo el `owner_ref` de la fila, por el guard existente (`agent.ts:492-509` +
   `:576-577`). Un tercero recibe 404, indistinguible de "no existe".
2. **A quién perjudica cambiar el destino a mitad de una ejecución.** Al **propio dueño**. El pagador
   del leg downstream es la wallet del operador del gateway; el receptor es quien el agente declaró.
   Si el dueño repunta su payTo entre el discover y el settle, redirige **su propia** plata. El
   caller ya fue debitado y recibe el trabajo igual; la plataforma cobra su fee igual. No hay tercero
   que pierda fondos. Por eso esto **no es un vector de robo** y no justifica una tabla de historial.
3. **Cuál es el riesgo real, y es otro.** Si le roban la a2a-key al dueño, el atacante puede
   repuntar el payTo y quedarse con los fees futuros. Eso **ya es cierto hoy** para `payout_wallet`
   (`agent.ts:551-552`), así que no es una clase nueva de riesgo — pero el monto en juego es mucho
   mayor: `payout_wallet` es sólo la pata del creator-split, y este bloque es el **precio completo**
   del agente. La mitigación proporcionada no es versionar: es **dejar rastro**.
4. **Lo que sí exige esta HU, entonces**: un log de auditoría en cada escritura del bloque, con
   `slug`, `owner_ref`, `{chain, contract}` anterior y `{chain, contract}` nuevo (AC-7). Si algún día
   un fee aparece en una billetera extraña, ese log es la única forma de saber **quién** lo puso y
   **cuándo**. Es una línea de código y cierra el único agujero que sí importa.
5. **Sobre congelar durante una ejecución en curso.** Dentro de un `POST /compose` el agente se
   resuelve una vez y el MISMO objeto `Agent` en memoria llega al settle
   (`services/compose.ts` → `signAndSettleDownstream`, que lee `agent.payment.contract`), así que el
   bloque ya está de hecho congelado por request. `[NEEDS CLARIFICATION]` No tracé exhaustivamente
   si un run multi-step o un reintento re-resuelve el agente por step; si lo hace, la ventana es de
   sub-segundo y el punto 2 la vuelve irrelevante (es la plata del propio dueño). **Nota adyacente**:
   existe una HU de quote-freeze (`doc/sdd/190-wkh-303-quote-freeze`); si el precio se congela al
   cotizar y el payTo se lee al settlear, las dos mitades del pago vienen de momentos distintos.
   No lo abro acá: lo dejo nombrado para el Architect.

---

## Constraint Directives (CD-N)

- **CD-1 (OBLIGATORIA)** — La respuesta pública de `GET /discover` y `GET /capabilities` **no cambia
  para un agente que no se modificó**. Byte-identidad demostrada con un test de snapshot sobre una
  fila con `metadata` sin `payment` y otra con el `payment` ya sembrado. Ni una key nueva, ni un
  reordenamiento, ni un `payment: null` donde antes el campo estaba ausente.
- **CD-2** — PROHIBIDO un segundo validador de chain o de wallet. El escritor usa
  EXACTAMENTE `normalizeChainSlug`, `getChainVmFamily`, `getAdaptersBundle`,
  `getInitializedChainKeys` e `isValidPayoutWallet`. Prohibido un `Set` de slugs nuevo, un regex de
  address nuevo, o un decodificador base58 nuevo (`isValidSolanaAddress` ya existe en
  `wallet-format.ts:50-71`).
- **CD-3** — PROHIBIDO aplicar `toLowerCase()` / `toUpperCase()` al `contract`, en cualquier punto
  del write path. El único `toLowerCase()` admisible es el de la comparación con la zero-address
  **dentro de la rama EVM**, después de que el formato hex ya fue verificado
  (patrón de `downstream-payment.ts:227-232` y de `paytos.ts:25-28`).
- **CD-4** — PROHIBIDO derivar `payment` de `payout_wallet` / `payout_chain`, o viceversa (CD-3 de
  WKH-241). Son cosas distintas: `payout_wallet` es la pata del creator-split del 1%; `payment` es el
  payTo del precio completo del agente. Cruzarlas mandaría el 100% del precio a una wallet elegida
  para el 1%.
- **CD-5** — PROHIBIDA cualquier query o mutación nueva sobre `a2a_agents` que no filtre por
  `owner_ref` además del `slug`. Toda escritura del bloque pasa por el UPDATE ya filtrado de
  `publishedAgentService.update` (`agent.ts:573-579`). El cliente usa `SUPABASE_SERVICE_KEY`
  (BYPASSRLS): el guard vive en la app. Un `.single()` sobre `a2a_agents` sin `.eq('owner_ref', …)`
  en este diff es **BLOQUEANTE** en AR.
- **CD-6** — PROHIBIDO modificar `src/lib/payment-spec-reader.ts`, `src/lib/downstream-payment.ts`,
  `src/adapters/**` y `src/services/discovery.ts`.
- **CD-7** — El merge del PATCH DEBE preservar `inputSchema`, `outputSchema` y `discoverable` (y
  cualquier otra key desconocida ya presente en `metadata`). Escribir el objeto `metadata` completo
  desde cero es **BLOQUEANTE**: borraría en silencio los schemas de los agentes que ya los tienen.
- **CD-8** — Los mensajes de error al cliente son estáticos y no reflejan el valor recibido (CD-10 de
  WKH-134, `routes/agents.ts:276-281`). Un payTo o una chain inválidos van al `request.log.warn`, no
  al body de la respuesta.

---

## Missing Inputs

- **MI-1 — `[DECIDE FOUNDER]` ¿Se exige prueba de posesión del payTo, o alcanza declararlo?**
  **Mi recomendación: NO exigirla para la ventana del 03/08.** El argumento técnico:
  - *Nadie pierde fondos ajenos.* Declarar la billetera de un tercero le **regala** plata a ese
    tercero: el que declara es el que no cobra. No es un IDOR ni un robo; el pagador es el operador y
    el monto es el fee del propio declarante.
  - *El daño real es de atribución, no de custodia*: hacerse pasar por un agente "respaldado por" una
    billetera conocida, o lavar el flujo de fees por un tercero, o un typo que manda fees a un
    extraño para siempre. Serio, pero no es "alguien nos vacía la wallet".
  - *El costo de exigirla es asimétrico contra el objetivo de esta HU.* Para EVM hay plumbing de
    firma (bind de `funding_wallet` / ERC-8004, `src/routes/auth/bind.ts`). Para **Solana no
    encontré verificación de firma ed25519 en `src/`** (busqué `src/**/*ed25519*`: nada; el adapter
    Solana firma con la clave del operador, no verifica firmas de terceros). O sea: la familia que
    los colaboradores de Solana LATAM Labs necesitan es justo la que **no tiene** el mecanismo, y
    construirlo es una HU propia.
  - *Compensaciones que sí entran en esta HU*: el bloque es owner-scoped (AC-7), toda escritura queda
    en un log de auditoría con el `owner_ref`, y AC-6 corta el caso del payTo = wallet del operador.
  - Si el founder decide **sí**: sale de esta HU y entra como **WKH-318** (challenge-response:
    EIP-712 para EVM, ed25519 sobre un nonce para Solana), y este work-item agrega un CD que
    prohíba publicar un bloque sin binding verificado. Ese camino **no llega al 03/08**.

- **MI-2 — `[resolver en F2]` Verificar el símbolo del token del adapter Solana antes de hacer
  estricto AC-12.** Hay que leer `supportedTokens[0].symbol` de
  `createSolanaAdapters({ network: 'devnet' })` y confirmar que es exactamente `USDC`. Si no lo es,
  AC-12 se degrada a advertencia. No lo verifiqué: exigía instanciar el adapter (lee env del
  proceso), y no ejecuté nada.

- **MI-3 — `[NEEDS CLARIFICATION / verificar en F2, potencialmente cambia el valor de la HU]`
  ¿`remit-kyc-validator` es una fila self-published de `a2a_agents`, o un agente de un registry
  federado?** Importa mucho: `metadata.payment` **sólo** se lee de `a2a_agents`
  (`services/agent.ts:147`); para un registry externo el bloque lo sirve el registry en su payload
  (`discovery.ts` `mapAgent`). Si el KYC viniera de un registry federado, **este escritor no lo
  desbloquea**. La lectura más probable, con lo que sí pude verificar, es que las tres filas
  `remit-*` son self-published: no existe registry propio para ellas, `POST /agents` es la única alta
  disponible, y eso explica por qué las dos Solana necesitaron una siembra manual de `metadata` y la
  de KYC quedó con `payment` ausente. **No pude determinarlo**: exigiría consultar `a2a_agents` en
  bdwv y no consulté la base.

- **MI-4 — `[NEEDS CLARIFICATION]` ¿El `owner_ref` de las dos filas Solana sembradas fuera del repo
  corresponde a una a2a-key que tengamos?** Si no, nadie puede `PATCH`earlas por API y corregir su
  bloque exigiría otra siembra manual. **No pude determinarlo** (misma razón que MI-3).

- **MI-5 — `[resolver en F2]` ¿Cómo se resuelve la dirección del operador para AC-6?** Para EVM
  `downstream-payment.ts:840-842` la deriva de `OPERATOR_PRIVATE_KEY` con `privateKeyToAccount`; para
  Solana el adapter tiene la keypair. Hay que elegir un accesor que **no** re-derive claves dentro
  del route (superficie de manejo de secretos nueva). Si no existe un accesor limpio, AC-6 se
  implementa a nivel de service o se degrada al `PAYTO_OPERATOR_CHECK_SKIPPED` que el propio AC-6 ya
  contempla.

---

## Dependencias

**Depende de** (todo ya mergeado, nada bloquea):
- WKH-241 — el lector (`payment-spec-reader.ts`). Esta HU es literalmente su contraparte, y su
  done-report ya la anticipó (AR-4, `:242`).
- WKH-234 — familias de VM, `isValidSolanaAddress`, rail Solana flag-gated.
- WKH-134 / WKH-143b — el CRUD self-published y el patrón de write-boundary guard que se copia.

**Bloquea**:
- **El cobro del KYC en Solana.** Hoy `remit-kyc-validator` declara `avalanche-fuji`/`evm` en el
  manifiesto del repo hermano (`wasiai-remittance-agents/src/manifest/registry.ts:32-33`) pero su
  fila **no tiene bloque de pago**, así que `Agent.payment` es `undefined` y el settle nunca entra
  por `payment.chain`: cobra por el default del gateway. Sin escritor no hay forma de corregirlo por
  API. (Sujeto a MI-3.)
- **La publicación de agentes por terceros** en la semana del 03/08. Es el punto de negocio: un
  colaborador que no puede declarar que cobra, no cobra.
- **WKH-317** (propuesta): el publicador de manifiesto en `wasiai-remittance-agents`, que consume
  este endpoint.

---

## Análisis de paralelismo

- **Corre en paralelo con WKH-315 y WKH-313** (worktrees separados). Mis archivos exclusivos:
  `src/routes/agents.ts`, `src/services/agent.ts`, `src/lib/payment-spec-writer.ts` — no los toca
  ninguna otra HU en vuelo por lo que se ve del mapa de módulos.
- **Punto de roce previsible: `src/types/index.ts`.** Es un archivo compartido y WKH-314/315 podrían
  agregar tipos ahí. El conflicto sería trivial (dos bloques de interfaces distintos), pero conviene
  que quien mergee segundo lo espere.
- **No abrí `doc/sdd/211-*`, `212-*` ni `213-*`** (hay tres agentes trabajando ahí), así que este
  análisis de paralelismo sale del mapa de módulos del código, no de los work-items de esas HUs.
- **No bloquea a ninguna de las tres.** Esta HU no toca el settle, ni los adapters, ni el inbound.

---

## Notas de proceso

- F0: `.nexus/project-context.md` existe y no se modificó (prohibido). Stack confirmado contra el
  código: TypeScript strict (`exactOptionalPropertyTypes` en uso, `agent.ts:402-407`), Fastify,
  Supabase con `SUPABASE_SERVICE_KEY` (BYPASSRLS), Biome, Vitest.
- Skills de dominio declarados (máx. 2): **money-path / multichain payments** y
  **API security (ownership guard, write-boundary validation)**.
- Fila para `doc/sdd/_INDEX.md`: en `_INDEX-row.md` de esta misma carpeta. **No reescribí
  `_INDEX.md`** (prohibido en esta fase).
