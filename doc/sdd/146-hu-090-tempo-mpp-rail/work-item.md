# Work Item — [WKH-090 / HU-090] Segundo rail de pago — adapter Tempo / MPP

## Estado del blocker gate (RESUELTO por el orquestador vía research web)

El blocker de F0 (¿existe testnet de Tempo/MPP?) **se levantó**. Verificado por
el orquestador (fuentes: `mpp.dev/overview`, `tempo.xyz/blog/mainnet`,
`docs.stripe.com/payments/machine/mpp`, `tempo.xyz/developers`):

1. **Tempo tiene testnet público desde dic-2025**, con stablecoin de testnet
   **pathUSD** (equivalente a USDC de testnet) + faucet. Se puede validar en
   testnet sin excepción a la política testnet-only del proyecto.
2. **MPP corre sobre HTTP 402** con flujo **Challenge → Credential → Receipt**
   (headers `WWW-Authenticate` / `Authorization` / `Payment-Receipt`).
3. **Dato clave para el diseño**: el path EVM de MPP tiene **"x402 exact
   compatibility"** — el adapter Tempo puede **reusar la maquinaria x402/
   EIP-3009 que wasiai-a2a ya tiene** (`SettleRequest`/`X402Proof` con
   `authorization`+`signature`), no requiere un contrato de tipos paralelo.
   Esto resuelve también el Missing Input #3 de la versión anterior de este
   work-item.
4. Token standard **TIP-20**, finalidad ~500ms, SDK TypeScript disponible. El
   chainId/RPC/dirección exacta de `pathUSD` en testnet **no bloquea el
   sizing de F1** — se resuelve en F2/F3 desde la doc oficial del faucet/SDK
   (mismo patrón que Base/Avalanche: el chainId real se confirma al construir
   `chain.ts`, no antes).

**Consecuencia**: esta HU pasa de `BLOCKED` a `in progress`, sizeada y con
scope real. Se mantiene bloqueado únicamente el **NEEDS CLARIFICATION** de
política de selección de rail (HU-091, decisión de producto separada — ver
Missing Inputs), que **no impide** un v1 funcional (default explícito, sin
auto-routing).

---

## Resumen
Abrir un segundo camino de pago (además de Kite/x402 y Avalanche/Base) vía un
adapter Tempo/MPP (Machine Payments Protocol, Stripe + Paradigm) sobre el
**testnet de Tempo** (stablecoin `pathUSD`), coexistiendo con `kite-ozone`,
`avalanche`, `base` bajo `src/adapters/`. Dado que MPP-EVM es x402-compatible,
el adapter **reutiliza el contrato de tipos existente** (`PaymentAdapter`,
`SettleRequest`, `X402Proof`) en lugar de inventar uno nuevo. Se entrega
**detrás de un feature-flag default OFF** — mismo patrón usado en WKH-141
(APP bridge) y WKH-133 (reputation write-back): aditivo, apagado por default,
byte-idéntico cuando está OFF.

## F0 — Grounding del contrato de adapter existente

- **Contrato (`src/adapters/types.ts:80-105`)**: `PaymentAdapter` expone
  `settle`/`verify`/`quote`/`sign`/`getScheme`/`getNetwork`/`getToken`/
  `getMaxTimeoutSeconds`/`getMerchantName`. `SettleRequest`/`X402Proof`
  (líneas 11-27) llevan `authorization`+`signature`+`network`+
  `paymentRequirements` — vocabulario x402/EIP-3009 que, confirmado el punto
  3 de arriba, **coincide con el "Credential" de MPP**. No hace falta
  extender estos tipos compartidos para el v1.
- **`ChainKey` es una unión cerrada** (`types.ts:124-130`): agregar Tempo
  exige extender el union type con `'tempo-testnet'` (reservando
  `'tempo-mainnet'` fuera de v1) y el dispatcher `buildBundle()` en
  `registry.ts:45-90` — mismo patrón que siguieron Base (NNN-088) y
  Avalanche (NNN-086).
- **Selección de rail (`chain-resolver.ts`)**: hoy es explícita — header
  `x-payment-chain` > `agent manifest payment.chain` > default (primer chain
  del CSV `WASIAI_A2A_CHAINS`). El v1 de Tempo usa exactamente este
  mecanismo; no se construye auto-routing por costo/latencia/geografía (eso
  es HU-091, ver Missing Inputs, `[NEEDS CLARIFICATION]` explícito).
- **Factory pattern de referencia**: `createBaseAdapters(opts?: { network })`
  (`src/adapters/base/index.ts`) es el patrón a copiar — recibe `network`
  explícito, sin mutación de `process.env` (a diferencia del patrón legacy
  DT-I de `createKiteOzoneAdapters`, ya marcado como deuda técnica
  `TD-NEW-KITE-PARAMS`). El adapter Tempo sigue el patrón Base.
- **Feature-flag precedente**: `WKH-141` (bridge APP, NNN-142) y `WKH-133`
  (reputation write-back, NNN-134) ya establecieron el patrón "feature
  aditiva, flag default OFF, comportamiento byte-idéntico apagado" — se
  reutiliza el mismo criterio acá en lugar de inventar uno nuevo.

---

## Sizing
- **SDD_MODE**: `full` (QUALITY) — es un rail de pago nuevo (money-path),
  AR/CR obligatorio sin excepción (CLAUDE.md: money-path → QUALITY siempre).
- **Estimación**: **M** — comparable al esfuerzo de Base (WKH-104, NNN-088):
  no hay que inventar un contrato de tipos nuevo (x402-compatible confirmado),
  solo el mapeo Challenge/Credential/Receipt sobre el contrato existente +
  extender `ChainKey`/`registry.ts`/`chain-resolver.ts` + feature flag +
  tests de contrato.
- **Branch sugerido**: `feat/146-hu-090-tempo-mpp-rail`

## Sizing — Skills Router
- `money-path-review` — cualquier settle/verify nuevo en el money-path exige
  el mismo lente de doble-cobro/idempotencia que los rails existentes,
  aunque el rail nazca apagado por flag.
- `chain-adapter-integration` — extender `ChainKey` + `registry.ts` +
  `chain-resolver.ts` es un patrón repetido 3 veces (Kite, Avalanche, Base);
  el cuarto rail sigue exactamente esa receta.

---

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `WASIAI_A2A_CHAINS` incluye el slug `tempo-testnet` Y el
  feature-flag de Tempo (p.ej. `TEMPO_ADAPTER_ENABLED=true`, nombre exacto a
  confirmar en F2) está activo, the system SHALL construir un
  `AdaptersBundle` completo para Tempo testnet (payment + attestation +
  gasless-o-null + chainConfig) sin alterar el comportamiento byte-idéntico
  de los bundles existentes (Kite/Avalanche/Base) — mismo invariante CD-2 de
  WKH-MULTICHAIN (NNN-086).

- **AC-2**: WHILE el feature-flag de Tempo esté en su valor default (OFF), the
  system SHALL comportarse byte-idéntico al estado actual — ningún
  `ChainKey` de Tempo se registra en `SUPPORTED_CHAINS`, ningún módulo de
  `src/adapters/tempo/` se importa en el hot path.

- **AC-3**: WHEN un caller completa el flujo MPP Challenge→Credential→Receipt
  contra el rail Tempo, the system SHALL mapear ese flujo al contrato
  existente sin crear un tipo de proof paralelo: el "Credential" puebla
  `X402Proof`/`SettleRequest` (`authorization`+`signature`+`network`), y el
  "Receipt" se registra vía `AttestationAdapter.attest()` — reusando
  `PaymentAdapter`/`AttestationAdapter` tal como están definidos hoy en
  `types.ts`.

- **AC-4**: WHEN se resuelve el chain vía header `x-payment-chain` o el
  manifest del agente, the system SHALL soportar el slug `tempo-testnet` (y
  su alias de chainId numérico, una vez confirmado en F2 desde la doc
  oficial del faucet/SDK de Tempo) en `chain-resolver.ts` exactamente igual
  que los demás rails — sin lógica especial hardcodeada.

- **AC-5**: IF el feature-flag de Tempo está OFF y un caller intenta forzar
  `tempo-testnet` vía header o manifest, THEN the system SHALL responder con
  el mismo error `CHAIN_NOT_SUPPORTED` que usa hoy para cualquier slug no
  inicializado — el rail no debe quedar parcialmente expuesto.

- **AC-6**: WHILE no exista una política de selección automática de rail
  (HU-091, `[NEEDS CLARIFICATION]`), the system SHALL resolver el rail
  únicamente por el mecanismo explícito ya existente (header > manifest >
  default del CSV) — SIN auto-routing por costo/latencia/geografía en v1.

- **AC-7**: IF el chainId/RPC/dirección exacta de `pathUSD` en Tempo testnet
  no está aún confirmado al cierre de F1, THEN esa resolución SHALL diferirse
  explícitamente a F2/F3 (grounded desde `tempo.xyz/developers` y el SDK
  TypeScript oficial) sin bloquear el resto del scope ni el sizing.

## Scope IN
- Nuevo `src/adapters/tempo/` (`chain.ts`, `payment.ts`, `attestation.ts`,
  `gasless.ts` si TIP-20 lo soporta de forma equivalente a EIP-3009 — a
  confirmar en F2, sino `null` como en Kite hoy, `index.ts`) siguiendo el
  patrón `createXAdapters(opts?: { network })` de Base.
- Extensión de `ChainKey` con `'tempo-testnet'` (reservando
  `'tempo-mainnet'` fuera de v1), `SUPPORTED_CHAINS`, `buildBundle()` en
  `registry.ts`, y aliases en `chain-resolver.ts`.
- Feature-flag env-driven, default OFF, gateando la inicialización del rail
  (mecanismo exacto — validación en `initAdapters()` vs. exclusión de
  `SUPPORTED_CHAINS` — se decide en F2).
- Mapeo Challenge→(paso de quote/sign existente)/Credential→`X402Proof`/
  Receipt→`AttestationAdapter.attest()`.
- Tests de contrato equivalentes a
  `src/adapters/__tests__/payment.contract.test.ts` para el nuevo adapter,
  más un test que verifique AC-2/AC-5 (flag OFF = no-op total).
- Resolución en F2/F3 del chainId real/RPC/dirección de `pathUSD` desde la
  doc oficial del faucet/SDK de Tempo.

## Scope OUT
- `tempo-mainnet` — no se agrega al union `ChainKey` en v1; requeriría la
  misma excepción explícita a la política testnet-only que ya aplica a
  `kite-mainnet`/`avalanche-mainnet`/`base-mainnet`.
- Política de selección automática de rail por costo/latencia/geografía —
  `[NEEDS CLARIFICATION]`, decisión de producto de HU-091, **no se
  construye acá**; el v1 usa el mecanismo explícito ya existente.
- Transportes no-HTTP de MPP (si los tuviera) — no mencionados por el
  encargo original, fuera de scope.
- Migrar o tocar los rails existentes (Kite/Avalanche/Base) — este HU es
  puramente aditivo.
- Activar el feature-flag en ningún ambiente por default — activación es
  decisión operativa post-DONE, no parte de este HU.

---

## Decisiones técnicas (DT-N)

- **DT-1**: Mapeo MPP → contrato existente: `Challenge` (HTTP 402 +
  `WWW-Authenticate`) se trata como el equivalente del paso de quote/sign
  x402 ya implementado; `Credential` (`Authorization`) puebla
  `X402Proof`/`SettleRequest` sin campos nuevos; `Receipt`
  (`Payment-Receipt`) se registra vía `AttestationAdapter.attest()`. Detalle
  exacto de headers a confirmar en F2 contra la spec real de MPP.
- **DT-2**: La factory sigue el patrón `createBaseAdapters` (network
  explícito vía `opts`, sin mutación de `process.env`) — NO se repite el
  patrón legacy DT-I de Kite.
- **DT-3**: Nuevo `ChainKey`: `'tempo-testnet'` únicamente en v1;
  `'tempo-mainnet'` queda reservado/no-agregado hasta decisión explícita de
  excepción mainnet.
- **DT-4**: Feature-flag env-driven, default OFF — mismo criterio que
  `WKH-141` (APP bridge) y `WKH-133` (reputation write-back): aditivo,
  apagado, byte-idéntico sin la flag.

## Constraint Directives (CD-N)

- **CD-1**: OBLIGATORIO que el feature-flag de Tempo tenga default OFF en
  todo ambiente — ningún despliegue activa el rail automáticamente.
- **CD-2**: PROHIBIDO agregar `'tempo-mainnet'` a `ChainKey`/
  `SUPPORTED_CHAINS` en este HU sin una decisión explícita de excepción a la
  política testnet-only (mismo criterio ya aplicado a los demás rails).
- **CD-3**: OBLIGATORIO reusar los tipos compartidos `SettleRequest`/
  `X402Proof`/`VerifyResult`/`QuoteResult` — PROHIBIDO crear un tipo de proof
  paralelo para Tempo salvo que en F2, con la spec real en mano, se
  demuestre una incompatibilidad de campos no anticipada (dado que ya se
  confirmó "x402 exact compatibility" en el path EVM de MPP).
- **CD-4**: OBLIGATORIO aplicar el mismo Ownership Guard (`owner_ref`,
  `CLAUDE.md` §Security Conventions) a cualquier tabla/query nueva que este
  HU introduzca relacionada al rail Tempo.
- **CD-5**: OBLIGATORIO que el nuevo adapter tenga tests de contrato
  equivalentes a los de Kite/Avalanche/Base **antes** de que el feature-flag
  pueda activarse en cualquier ambiente.

---

## Missing Inputs

- **`[NEEDS CLARIFICATION]`** Política de selección de rail (¿por costo,
  latencia, o geografía?) cuando existan múltiples rails activos — decisión
  de producto de HU-091, explícitamente fuera de esta HU. **No bloquea el
  v1**: el default conservador es el mecanismo explícito ya existente
  (header > manifest > default del CSV), sin auto-routing.
- **`[resuelto en F2]`** Nombre exacto del feature-flag env var
  (`TEMPO_ADAPTER_ENABLED` es un nombre tentativo, a confirmar/ajustar en
  F2 junto con el mecanismo de gateo — validación en `initAdapters()` vs.
  exclusión de `SUPPORTED_CHAINS`).
- **`[resuelto en F2/F3]`** chainId numérico, RPC URL, dirección del token
  `pathUSD`, y detalle exacto de los headers `WWW-Authenticate`/
  `Authorization`/`Payment-Receipt` — se obtienen de `tempo.xyz/developers`
  y el SDK TypeScript oficial al construir `src/adapters/tempo/chain.ts`.
  No bloquea el sizing ni el scope de F1.
- **`[resuelto en F2]`** Si TIP-20 soporta un patrón gasless equivalente a
  EIP-3009 (para poblar `GaslessAdapter`) o si el v1 debe dejar
  `gasless: null` como Kite hoy — se confirma con la spec del SDK de Tempo.

---

## Análisis de paralelismo
- **No bloquea ninguna HU existente** — es puramente aditiva sobre
  `src/adapters/`, detrás de un feature-flag default OFF.
- **No está bloqueada** (a diferencia de la versión anterior de este
  work-item) — puede pasar a F2 directamente.
- **Relacionada con HU-091** (política de selección de rail) — esa HU cobra
  sentido práctico recién cuando exista más de un rail activo por default;
  el v1 de esta HU la habilita sin depender de ella (rail explícito).
- **Puede correr en paralelo** con cualquier HU que no toque
  `src/adapters/types.ts`, `src/adapters/registry.ts`, o
  `src/adapters/chain-resolver.ts` — la mayoría del roadmap actual (billing,
  splits, disputes) es ortogonal a esto.

---

*Analyst F0+F1 — 2026-07-04 — HU-090 / WKH-090. NNN: 146. Branch sugerido:
feat/146-hu-090-tempo-mpp-rail. Blocker de testnet levantado por research web
del orquestador (2026-07-04); work-item sizeado y listo para gate
HU_APPROVED.*
