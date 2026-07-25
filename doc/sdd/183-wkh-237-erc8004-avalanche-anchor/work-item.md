# Work Item — [WKH-237] remit-kyc-validator: identidad ERC-8004 anclada en Avalanche

## Resumen
Extender el allow-set de discovery `ERC8004_ALLOWED_CHAINS` (`src/services/discovery.ts`)
para aceptar Avalanche (C-Chain 43114 / Fuji 43113) como chain válida de una
declaración/binding ERC-8004, sin romper el soporte Base (8453/84532) existente.
Esto alinea el código con el claim que el deck (slide 17, programa Solana LATAM
Labs / WayLearn) ya hace hoy — "KYC en Avalanche por ERC-8004" — para el agente
`remit-kyc-validator`. **Este work-item cubre el lado de código
(accept-set + resolución vía JSONB reverse-lookup, sin RPC).** El lado on-chain
real (bind verificado contra un contrato IdentityRegistry deployado en
Avalanche) es un Missing Input explícito — ver sección dedicada abajo.

## Sizing
- SDD_MODE: mini
- Estimación: S
- Branch sugerido: `feat/183-wkh-237-erc8004-avalanche-allowset`
- Modo: FAST+AR (cambio chico pero toca superficie sensible: resolución de
  identidad en `/discover`, matching bidireccional WKH-100/WKH-113)

## Grounding real (F0)

1. **`ERC8004_ALLOWED_CHAINS`** vive en `src/services/discovery.ts:124`:
   ```ts
   const ERC8004_ALLOWED_CHAINS: ReadonlySet<number> = new Set([8453, 84532]);
   ```
   Se usa en `extractDeclaredTokenId()` / `parseRegistrationEntry()` /
   `buildDeclaration()` (discovery.ts:141-223) para decidir si el `chainId`
   que un agente DECLARA en su AgentCard (`metadata.registrations[].agentId`
   CAIP-10, o el fallback `metadata.erc8004`) es aceptable. **No hace RPC** —
   es un filtro puro en memoria.

2. **La resolución real del badge `verified:true`** ocurre en
   `identityService.resolveIdentityForAgent()` (`src/services/identity.ts:351-387`):
   un SELECT a `a2a_agent_keys` (columna `erc8004_identity` JSONB) que cruza
   `(token_id, chain_id)` + `(agent_registry, agent_slug)` — **también sin RPC**
   (comentario explícito WKH-100 DT-18: "No RPC at serve-time — only the
   JSONB reverse-lookup"). Esto confirma que el Scope IN de esta HU (extender
   el allow-set) es 100% código+DB, testeable sin infra on-chain.

3. **El VERIFY/BIND on-chain real** (lo que persiste el `erc8004_identity`
   JSONB por primera vez) vive en `POST /erc8004/bind`
   (`src/routes/auth/identity.ts:35-206`) y usa
   `src/adapters/erc8004-identity.ts` — este reader **está hardcodeado a
   Base**: `getBaseNetwork()` / `getBaseChain()` (`./base/chain.js`),
   `expectedChainIdFor()` solo retorna 8453/84532
   (`erc8004-identity.ts:120-122`), y las direcciones de registry solo se
   resuelven vía `ERC8004_REGISTRY_ADDRESS_BASE_MAINNET` /
   `_BASE_SEPOLIA` / fallback global (`erc8004-identity.ts:73-81`). **No hay
   ningún camino de código hoy para bindear/verificar un token en Avalanche.**

4. **El contrato en sí**: `.env.example:611-623` documenta que incluso las
   direcciones de Base están **vacías** (`ERC8004_REGISTRY_ADDRESS_BASE_MAINNET=`,
   `ERC8004_REGISTRY_ADDRESS_BASE_SEPOLIA=`) — confirma el estado "deploy
   pending" de WKH-100 que describe la HU de Jira. No existe ninguna variable
   `ERC8004_REGISTRY_ADDRESS_AVALANCHE_*` en el repo, ni referencia a un
   contrato IdentityRegistry deployado en Avalanche (mainnet o Fuji).

**Conclusión del grounding**: la HU tiene dos partes claramente separables —
(a) CÓDIGO completable/testeable 100% en este repo (extender el allow-set +
tests de regresión/no-regresión), y (b) una parte OPERATIVA/on-chain (contrato
IdentityRegistry deployado en Avalanche + generalizar el reader/bind route
Base-only) que NO se puede completar solo con código porque el contrato no
existe/no está confirmado. Ver "Missing Inputs".

## Acceptance Criteria (EARS)

- AC-1: WHEN un agente declara en su AgentCard (`metadata.registrations[].agentId`
  o el fallback `metadata.erc8004`) una identidad ERC-8004 con `chainId` igual a
  43114 (Avalanche C-Chain) o 43113 (Avalanche Fuji), the system SHALL aceptar
  esa declaración en `extractDeclaredTokenId()` (no descartarla por chain
  desconocida).
- AC-2: WHEN discovery resuelve un agente cuyo binding verificado en
  `a2a_agent_keys.erc8004_identity` tiene `chain_id` 43114 o 43113 Y coincide
  con `(agent_registry, agent_slug)` declarados, the system SHALL adjuntar
  `agent.identity = { erc8004_token_id, chain_id, verified: true }` en la
  respuesta de `/discover` (mismo comportamiento que hoy para Base, vía
  `resolveIdentityForAgent`, sin RPC).
- AC-3: WHEN se selecciona `remit-kyc-validator` para una remesa y se cobra su
  fee, the system SHALL seguir cobrándolo en Avalanche exactamente como hoy
  (WKH-170/171) — esta HU NO modifica el payment path, solo el accept-set de
  identidad.
- AC-4 (no regresión Base): WHEN discovery resuelve una declaración/binding con
  `chainId` 8453 (Base mainnet) o 84532 (Base sepolia), the system SHALL seguir
  aceptándola y resolviéndola byte-idéntico al comportamiento actual (mismo
  test suite existente en `discovery.test.ts` en verde, sin modificar
  aserciones previas).
- AC-5 (edge — chain desconocida): IF un agente declara un `chainId` que NO
  está en `{8453, 84532, 43114, 43113}` (p.ej. `1` mainnet Ethereum, `137`
  Polygon, o cualquier chain exótica), THEN the system SHALL ignorar esa
  entrada de declaración (`extractDeclaredTokenId` continúa al siguiente
  fallback o retorna `null`) y NO adjuntar badge `verified` a partir de ella.

## Scope IN

- `src/services/discovery.ts` — extender `ERC8004_ALLOWED_CHAINS` de
  `new Set([8453, 84532])` a `new Set([8453, 84532, 43114, 43113])`, con
  comentario explícito aclarando que esto SOLO afecta el accept-set de
  discovery (declare + reverse-lookup JSONB), NO habilita bind on-chain en
  Avalanche (eso es Scope OUT, ver Missing Inputs).
- `src/services/discovery.test.ts` — tests nuevos/extendidos:
  - declaración con `chainId: 43114` y `chainId: 43113` aceptada por
    `extractDeclaredTokenId` (vía CAIP-10 `eip155:43114:...` y el fallback
    `metadata.erc8004`).
  - regresión: 8453/84532 siguen aceptados exactamente igual (no tocar
    aserciones existentes, solo agregar).
  - edge: chain desconocida (ej. `137`) sigue rechazada.
  - `resolveIdentityForAgent`/`attachIdentities` con un binding fixture
    `chain_id: 43113` en `a2a_agent_keys.erc8004_identity` (mock de
    supabase) surfacea `verified:true` en el agente correcto (AC-2).

## Scope OUT

- Generalizar `src/adapters/erc8004-identity.ts` y
  `src/routes/auth/identity.ts` (`POST /erc8004/bind`) para soportar
  verificación/bind on-chain en Avalanche (nuevo reader multi-chain, param
  `chain` en el body, nuevos env vars
  `ERC8004_REGISTRY_ADDRESS_AVALANCHE_MAINNET` /
  `ERC8004_REGISTRY_ADDRESS_AVALANCHE_FUJI`). Es código real y no trivial —
  se sugiere HU de seguimiento (WKH-237b) SI el founder confirma que hay un
  contrato IdentityRegistry en Avalanche contra el cual bindear (ver Missing
  Inputs).
- Deploy/uso de un contrato ERC-8004 IdentityRegistry en Avalanche (mainnet o
  Fuji) — infra/on-chain, founder-gated.
- Mover FX/payout a Solana (eso es terreno de WKH-238, anclaje de identidad
  Solana).
- El wire Chaski → agente KYC (WKH-233).
- `ERC8004_REPUTATION_REGISTRY_ADDRESS*` (Fase 3, WKH-103) — no se toca.

## Decisiones técnicas (DT-N)

- DT-1a (ratificada por el orquestador — NO se re-abre en F2): anclar la
  identidad ERC-8004 del agente KYC en Avalanche extendiendo el allow-set con
  C-Chain 43114 y Fuji 43113. Es hacer literal lo que el deck ya afirma, no un
  cambio de narrativa.
- DT-2: los chain-ids se manejan como `number` EVM crudos (43114/43113),
  consistente con el patrón existente de `ERC8004_ALLOWED_CHAINS: Set<number>`
  — NO se reutiliza `ChainKey`/`normalizeChainSlug` de `chain-resolver.ts`
  porque son dos sistemas independientes (ese resolver gobierna el payment
  rail inbound/outbound, no el accept-set de identidad ERC-8004).
- DT-3: el VERIFY/BIND on-chain (`ownerOf` check, `POST /erc8004/bind`) queda
  Base-only en esta HU. Extenderlo a Avalanche es un cambio de mayor alcance
  (nuevo reader + nuevos envs + contrato deployado) diferido explícitamente —
  ver Scope OUT / Missing Inputs.
- DT-4: sin hardcodes de direcciones de contrato — si en el futuro se
  implementa el bind en Avalanche, las direcciones vienen de env vars nuevas
  (`ERC8004_REGISTRY_ADDRESS_AVALANCHE_*`), nunca literal en TS (mismo patrón
  que Base).

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO modificar el comportamiento existente para 8453/84532 — el
  Set debe seguir conteniendo exactamente esos dos valores además de los
  nuevos; test de regresión obligatorio antes de mergear.
- CD-2: PROHIBIDO hardcodear cualquier dirección de contrato ERC-8004 de
  Avalanche en código TypeScript. Quedan fuera de Scope IN, pero si se tocan
  en un follow-up, SIEMPRE vía env var (regla `.nexus/project-context.md`
  "Sin hardcodes"), nunca como literal ni como parte del habilitar el bind
  on-chain de esta HU.
- CD-3: OBLIGATORIO dejar un comentario en el código (junto al `Set`)
  aclarando explícitamente que la extensión Avalanche es solo el accept-set de
  discovery — no habilita `/erc8004/bind` en Avalanche — para que un futuro
  AR/CR no asuma que el bind ya funciona ahí.
- CD-4: OBLIGATORIO que el test de AC-2 use un binding **fixture/mock** (NO
  una llamada RPC real, NO depende de ningún contrato deployado) — igual
  patrón que los tests actuales de `resolveIdentityForAgent` para Base.

## Missing Inputs

- **[bloqueante — fuera del alcance de código]** No existe (o no está
  confirmado) un contrato ERC-8004 `IdentityRegistry` deployado en Avalanche
  (C-Chain 43114 o Fuji 43113). Ni siquiera el de Base está configurado hoy —
  `.env.example` tiene `ERC8004_REGISTRY_ADDRESS_BASE_MAINNET=` y
  `_BASE_SEPOLIA=` **vacías** (WKH-100 "deploy pending", confirmado por
  grounding). Sin este contrato, aunque se generalizara el reader/bind route
  (Scope OUT de esta HU), `POST /erc8004/bind` en Avalanche devolvería
  `REGISTRY_NOT_CONFIGURED` (503) — no hay forma de producir un binding
  Avalanche real-verificado-on-chain todavía.
- **[decidir founder — bloquea WKH-237b, no esta HU]** ¿Existe una dirección
  pública/canónica de un IdentityRegistry ERC-8004 ya deployado en Avalanche
  por algún tercero (análogo a las direcciones `0x8004...` documentadas para
  Base), o WasiAI necesita deployar su propia instancia en Avalanche? Esto
  determina si el follow-up es "solo wire" o "wire + deploy contrato".
- **[resuelto — no bloquea esta HU]** El Scope IN de esta HU (extensión del
  allow-set + tests con fixtures) es 100% completable y testeable en este
  repo sin depender de lo anterior. El AC-1/AC-2 se validan con datos
  simulados en tests (fixtures de binding), consistente con CD-4 — NO
  representan una verificación on-chain real todavía.

## Análisis de paralelismo

- No bloquea otras HUs activas. Puede correr en paralelo con WKH-238 (anclaje
  de identidad Solana) y WKH-233 (wire Chaski→KYC-agente) — superficies
  distintas.
- Depende conceptualmente de WKH-100 (Fase 1, identity binding — DONE) pero no
  lo modifica.
- Esta HU **por sí sola NO cierra** la aspiración completa del deck ("KYC en
  Avalanche" con badge on-chain verificado real) — eso requiere el follow-up
  WKH-237b (Scope OUT) + el contrato deployado (Missing Input bloqueante). El
  orquestador debe decidir si ejecuta esta HU (código, no-bloqueada) y abre
  WKH-237b por separado, o si espera confirmación del founder sobre el
  contrato antes de avanzar con el follow-up.
