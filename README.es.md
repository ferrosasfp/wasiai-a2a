[English](README.md)

# WasiAI A2A

[![ci](https://github.com/ferrosasfp/wasiai-a2a/actions/workflows/ci.yml/badge.svg)](https://github.com/ferrosasfp/wasiai-a2a/actions/workflows/ci.yml)
[![smoke-downstream](https://github.com/ferrosasfp/wasiai-a2a/actions/workflows/smoke-downstream.yml/badge.svg)](https://github.com/ferrosasfp/wasiai-a2a/actions/workflows/smoke-downstream.yml)
[![protocolo](https://img.shields.io/badge/protocolo-Google%20A2A-blue)](https://google.github.io/A2A/)
[![licencia](https://img.shields.io/badge/licencia-MIT-green)](LICENSE)

Protocolo y gateway HTTP para que un cliente encuentre agentes **por capacidad y no por dirección**, los **componga** en un flujo y **pague por uso**.

**Solana es la red principal de este gateway, y su leg de liquidación está verificado en cadena**: el pago de abajo mueve USDC-SPL de verdad en devnet, y cualquiera lo puede comprobar contra el RPC público. Lo que esa transferencia prueba es el mecanismo, no un cobro a precio de lista: el monto movido es 0,000001 USDC contra un precio declarado de 0,03.

Un cliente no necesita saber que existe `remit-corridor-fx-solana`. Pide "necesito una cotización de FX" y el gateway le devuelve quién puede hacerlo, en qué red cobra y cuánto sale. Después ejecuta el flujo con una sola llamada HTTP y el gateway se encarga del pago a cada agente.

El gateway federa los catálogos de los marketplaces registrados: un agente publicado en cualquiera de ellos es descubrible desde cualquier app conectada. Esa es la tesis del repo: **el marketplace es una aplicación sobre el protocolo, no el protocolo**.

- Gateway en vivo: `https://wasiai-a2a-production.up.railway.app`
- Red principal: **Solana** (devnet hoy; ninguna mainnet está inicializada en este deployment)
- Protocolo base: [Google A2A](https://google.github.io/A2A/) + [x402](https://github.com/x402-foundation/x402) para el pago

## Solana primero

**Solana es la red principal de este gateway.** Es el único rail no EVM del código y la cadena en la que cobra hoy la línea de remesa del catálogo: sus tres agentes (`remit-corridor-fx-solana`, `remit-cashout-payout-solana` y `remit-kyc-validator`) declaran los tres `solana-devnet` (medido contra `GET /discover?limit=50` del deployment de producción el 2026-08-15: 25 agentes, `catalogStatus: complete`, 3 en `solana-devnet`). El 2026-07-31 eran dos; `remit-kyc-validator` llegó después, y este renglón quedó una medición atrás hasta que se releyó.

El leg de pago Solana no es roadmap: mueve USDC-SPL de verdad. La transferencia [`3pNqu9jH…`](https://explorer.solana.com/tx/3pNqu9jHduGaXioB8Mf7WNvBgZQgJV4MnE6NDGWZdz6aY5gr2ivxfbwzrnweutSVtyKnvv7y7kXnARroktjyWsZx?cluster=devnet) está confirmada en devnet (`err: None`), es del USDC de Circle (`4zMMC9sr…`) y el destinatario es la wallet de cobro del agente `remit-corridor-fx-solana`. Se verifica con un `getTransaction` contra el RPC público de devnet, sin pedirle permiso a nadie.

Las otras redes siguen acá y siguen siendo verdad: Avalanche, Base, Kite y Tempo tienen su propio adaptador, y esa neutralidad es el producto. Lo que hay es un **orden**, no una exclusividad: cuando hay que elegir una red, es Solana.

Una asimetría que conviene leer temprano en vez de descubrirla contra un `400`: Solana es hoy el rail de **salida** (el gateway le paga al agente) y la cadena en la que puede debitar una clave prepaga. El cobro de **entrada** por x402 sigue siendo EVM, porque ese leg necesita una autorización firmada tipo EIP-3009 que el adaptador de Solana no implementa. El detalle está en [Rail Solana](#rail-solana).

---

## Descubrimiento por capacidad

Todo el catálogo es público y no cuesta nada consultarlo. **Los parámetros no reconocidos se rechazan con `400 UNKNOWN_DISCOVER_PARAM`**, lo que evita que un filtro mal escrito (por ejemplo `capability` en vez de `capabilities`) matchee todo en silencio.

```bash
GW=https://wasiai-a2a-production.up.railway.app

curl -s "$GW/discover?capabilities=remittance-fx-quote" | jq '.agents[] | {slug, priceUsdc, chain: .payment.chain, rail: .payment.resolvedChain, network: .payment.network}'
# {"slug":"remit-corridor-fx-solana","priceUsdc":0.03,"chain":"solana-devnet","rail":"solana-devnet","network":"testnet"}

curl -s "$GW/discover?capabilities=price-feed" | jq '.agents[] | {slug, priceUsdc, chain: .payment.chain, rail: .payment.resolvedChain, network: .payment.network}'
# {"slug":"wasi-chainlink-price","priceUsdc":0.001,"chain":"avalanche","rail":"avalanche-fuji","network":"testnet"}
```

`payment.chain` es la cadena de texto **que el agente declaró**, y varios alias aceptados
no dicen su entorno: `avalanche` es el más común en el catálogo vivo (16 de 25 agentes al
2026-08-05) y resuelve a Fuji, que es una red de pruebas. Por eso el catálogo informa
además a qué lo **resolvió** el gateway: `payment.resolvedChain` es el rail canónico y
`payment.network` es `testnet` o `mainnet`. Esos dos los deriva el gateway, y los agentes
siguen declarando exactamente lo que declaraban antes. La garantía detrás de `network` es
angosta a propósito: o el pago aterriza en ese entorno o no hay pago, porque la pata de
salida se niega a firmar cuando el entorno declarado del rail y el destino real no
coinciden.

El primero se publicó directo contra el gateway (`registry: "self-published"`) y cobra en Solana; el segundo vive en un marketplace externo registrado (`registry: "WasiAI"`) y cobra en Avalanche. El cliente que consulta no distingue uno de otro ni tiene que saber en qué red cobra cada uno, y esa indistinción es el punto: la federación, y la cadena, son transparentes para quien consume.

**Completitud del catálogo y `limit`.** Sin un parámetro `limit`, el gateway no le dice a cada
registry cuántas filas devolver, así que cada registry sirve su propia página por default. Con
`limit=50` el gateway aplica el techo que cada registry publica (`schema.discovery.maxLimit`).
Medido el 2026-08-15, tres corridas seguidas: `/discover` pelado y `/discover?limit=50` devuelven
los dos 25 agentes y `catalogStatus: complete`, con la fuente federada dando sus 22 filas sin que
se las pidan. El 2026-08-04 esa misma llamada pelada devolvía 23 y `truncated`.
Que es exactamente el motivo para **poner un `limit`** cuando consultes para filtrar o elegir por
capacidad, y sobre todo para `/orchestrate/plan`: sin él, lo que te llega depende de un default
que es de otro y puede cambiar sin avisar — como acaba de pasar.

Cada agente que devuelve `/discover` trae un `invokeUrl`, pero es una referencia interna. **El caller no llama al agente directo.** Invoca vía `/compose` (pipeline explícito) u `/orchestrate` (por objetivo, con el plan armado por un LLM). Eso es lo que permite que el gateway resuelva precio, presupuesto, scoping y liquidación en un solo lugar en vez de dejarlo en manos de cada cliente.

## Composición y cobro

Un pipeline tiene dos legs y no tienen por qué estar en la misma red: el **pago de salida** a cada agente (que para un agente Solana se liquida en USDC-SPL sobre Solana) y el **cobro de entrada** al caller, que hoy es x402 sobre EVM. El ejemplo de abajo es exactamente eso: el agente cobra en `solana-devnet` y el caller paga en una red EVM.

`/compose` recibe los pasos ya resueltos y devuelve un challenge x402 si no viene pago:

```bash
curl -s -X POST "$GW/compose" -H 'content-type: application/json' \
  -d '{"steps":[{"agent":"remit-corridor-fx-solana","input":{"amountUsdc":100,"corridor":"USDC-PEN"}}]}'
```

```json
{
  "error": "payment-signature header is required",
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:2368",
    "maxAmountRequired": "30300000000000000",
    "payTo": "0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba",
    "asset": "0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9",
    "maxTimeoutSeconds": 300
  }],
  "x402Version": 2
}
```

El monto es el precio real del pipeline más el fee de protocolo: `0.03 + 1% = 0.0303`. La misma llamada con el header `x-payment-chain: avalanche-fuji` devuelve `network: "eip155:43113"`, el USDC de Fuji y `maxAmountRequired: "30300"` (6 decimales en vez de 18). Es el mismo pipeline cotizado en otra red, sin tocar el body.

Lo que **no** hace, dicho con el error real: `x-payment-chain: solana-devnet` corta con `400 CHAIN_INBOUND_PAYMENT_UNSUPPORTED` y la respuesta explica la asimetría y las dos salidas (otra cadena para el x402, o una clave prepaga, que sí debita presupuesto en `solana-devnet`). Solana liquida hacia afuera; no cobra hacia adentro.

Hay dos formas de pagar y el caller elige una por request:

| Vía | Para quién | Cómo |
|---|---|---|
| x402 | consumidor esporádico, sin cuenta | responde el `402` con el header `X-Payment` firmado |
| clave prepaga | integrador con volumen | `POST /auth/agent-signup` devuelve una `wasi_a2a_*`, se manda en `x-a2a-key` o `Authorization: Bearer` |

Prioridad cuando llegan varias: `x-a2a-key` > `Bearer wasi_a2a_*` > x402. Un Bearer que no arranque con `wasi_a2a_` se ignora en vez de rechazarse, para no romper a quien ya usa ese header para otra cosa.

El fee de protocolo es 1% por defecto (`PROTOCOL_FEE_RATE`, con clamp duro en `[0, 0.10]`: un valor fuera de rango loguea error y cae al default). Se calcula sobre el **costo real ejecutado**, no sobre el `budget` declarado, así que pedir un presupuesto grande no infla el fee. `POST /orchestrate/plan` devuelve `feeRatePercent` y `protocolFeeUsdc` para que el caller lea la tarifa efectiva del runtime en lugar de confiar en este documento.

Ese 1% se subdivide en plataforma / creador / referido vía `SPLIT_BPS_*` en basis points, con validación fail-closed (los tres tienen que sumar exactamente `10000` o el proceso rechaza la config). El default es `10000/0/0`, todo a plataforma. Detalle y ejemplo trabajado en [`doc/architecture/FEE-MODEL.md`](doc/architecture/FEE-MODEL.md).

---

## Neutralidad de red

Que Solana sea la red principal es una decisión de **producto**, no un privilegio del diseño: en qué cadena corre un request se resuelve por configuración y por el agent card, no por una rama que le dé a una red capacidades que las otras no tienen. Hay un adaptador por red y un selector por request, y por eso agregar la siguiente cadena que pida un corredor es una carpeta más, no un rewrite.

Hay un nombre de cadena cableado en el código, como default: si no están seteadas ni `WASIAI_A2A_CHAINS` ni `WASIAI_A2A_CHAIN`, `src/adapters/registry.ts` cae a `kite-ozone-testnet`, que es lo que la tabla de abajo llama default de cobro. Cualquier deployment que setee la variable nunca llega a ese literal.

El caso concreto que motivó el diseño es una remesa. El principal de la remesa viaja por Solana, el marketplace de agentes corre sobre Avalanche, y la liquidación la coordina un servicio aparte (`wasiai-facilitator`) con un adaptador por red. Ninguna de las tres piezas necesita que las otras dos estén en su cadena.

Cómo se implementa:

- `PaymentAdapter` es una unión discriminada (`src/adapters/types.ts`): `SolanaPaymentAdapter` es un miembro de pleno derecho del tipo, no un caso especial colgado del camino EVM. La familia de VM es un dato del tipo (`vmFamily`), no un `if` desparramado.
- El bundle de adaptadores (payment, attestation, gasless, identity) se construye por cadena en `src/adapters/registry.ts`. Agregar una red es una carpeta nueva en `src/adapters/<red>/` más una rama en el factory. Los servicios (L3) y las rutas (L4) no se tocan.
- La selección por request sale del header `x-payment-chain` (acepta el slug o el chainId numérico) con fallback a la primera entrada de `WASIAI_A2A_CHAINS`.

Redes soportadas en código (`SUPPORTED_CHAINS` + los dos rails detrás de bandera), con la principal arriba:

| Slug | chainId | Estado en código |
|---|---|---|
| `solana-devnet` | sentinela 900001 | **red principal** · rail no EVM detrás de `SOLANA_ADAPTER_ENABLED`, encendido en el deployment de producción |
| `kite-ozone-testnet` | 2368 | soportada (default de cobro si no se configura nada) |
| `kite-mainnet` | 2366 | soportada, exige `KITE_NETWORK=mainnet` acoplado |
| `avalanche-fuji` | 43113 | soportada |
| `avalanche-mainnet` | 43114 | soportada, con opt-in extra para el leg de salida |
| `base-sepolia` | 84532 | soportada |
| `base-mainnet` | 8453 | soportada |
| `tempo-testnet` | testnet | implementada, apagada por bandera (`TEMPO_ADAPTER_ENABLED`) |

En `src/adapters/registry.ts` los dos rails con bandera se agregan al final del set y arrancan apagados en el repo (`SOLANA_ADAPTER_ENABLED=false` en `.env.example`, encendido por config del deployment). Con la bandera en `false` el slug ni siquiera entra al set soportado, así que el bundle no se construye y el leg corta con `CHAIN_NOT_SUPPORTED`. No es un `if` adentro del adaptador, es que el adaptador no existe en el proceso.

## Qué corre hoy

Esto es el estado real, no el roadmap. Se lee del `GET /capabilities` del deployment de producción.

```bash
curl -s "$GW/capabilities" | jq '.chains'
```

Las filas de abajo van en orden de producto; el endpoint devuelve Kite primero, porque es el default.

| Cadena inicializada hoy | chainId | Rail |
|---|---|---|
| **Solana devnet** | sentinela 900001 | solo saliente, USDC-SPL (`acceptsInboundPayment: false`) |
| Kite Ozone testnet | 2368 | entrante en PYUSD, es el default de cobro |
| Avalanche Fuji | 43113 | entrante y saliente, USDC de testnet |
| Base Sepolia | 84532 | entrante y saliente, USDC de testnet |

Las tres filas EVM se comprueban mandando `x-payment-chain` a `POST /compose` sin pago: el `402` vuelve con `eip155:2368`, `eip155:43113` o `eip155:84532` y el monto en los decimales del token de esa red. La fila de Solana se comprueba al revés, y esa es su naturaleza: el mismo request con `x-payment-chain: solana-devnet` devuelve `400 CHAIN_INBOUND_PAYMENT_UNSUPPORTED`, porque paga hacia afuera y no cobra hacia adentro.

**Ninguna red mainnet está inicializada en el deployment de hoy.** Los adaptadores de mainnet existen y hubo liquidaciones reales en Avalanche C-Chain en abril de 2026 (ver [Evidencia on-chain](#evidencia-on-chain)), pero el gateway que está arriba ahora mismo corre testnet y devnet, sin dinero real.

Estado del catálogo en ese mismo deployment: 25 agentes descubribles (medido el 2026-08-15 contra `GET /discover`, tres corridas seguidas), de un marketplace federado más los publicados directo contra el gateway. Tres cobran en Solana devnet, y son toda la línea de remesa. Los agentes en sí no viven en este repo: este repo es el protocolo y el gateway, y el catálogo es de terceros.

Ese `25` no es un número redondeado, y el endpoint que lo devuelve dice cuánto se cree a sí mismo. La misma respuesta trae `catalogStatus` y el desglose por fuente; el 2026-08-15 dice:

```bash
curl -s "$GW/capabilities" | jq '{catalogStatus, sources}'
# "catalogStatus": "complete"
# "sources": [ {"name":"WasiAI","state":"ok","rows":22},
#              {"name":"self-published","state":"ok","rows":3} ]
```

El 2026-07-31 la misma llamada decía `truncated`, con la fuente federada en `{"state":"truncated","rows":20,"truncationEvidence":"cursor"}`: había devuelto 20 filas y dejado un cursor no vacío, o sea que probó que había más y no lo mandó. Ese es el caso que el campo existe para nombrar, y sigue siendo posible aunque hoy no se dé.

Leído en voz alta, la respuesta de hoy: las dos fuentes están probadas completas. Una fuente es `ok` sólo con evidencia, o el cursor agotado o menos filas que el límite que se le envió; la que contesta sin ninguna de las dos queda `unverified`, y la que no se pudo consultar queda `failed` con `rows: null` en vez de `rows: 0`, porque "no pude preguntar" no es "no tiene". Lo mismo el roll-up: `complete` significa que todas las fuentes probaron haber dado todo, no que ninguna se quejó. El catálogo prefiere declarar que puede estar incompleto antes que publicar un total que no puede respaldar, que es también por lo que ese número puede moverse sin que nada esté roto.

**El tamaño del catálogo puede depender de si pedís un límite.** Medido el 2026-08-15, tres corridas
seguidas, las dos formas coinciden: 25 agentes y `catalogStatus: complete`, con un desglose por fuente
de 22 filas del registry federado `WasiAI` y 3 self-published. El 2026-08-04 la llamada pelada
devolvía 23 y `truncated` y sólo la forma con `limit=50` devolvía 25, y eso tampoco era una
inconsistencia de datos: cuando no se especifica límite el gateway no pasa ninguno hacia abajo, así
que cada registry sirve su página por defecto, y un `limit` explícito le dice "quiero N filas, hasta
tu máximo publicado". La diferencia desapareció porque la fuente federada ahora devuelve todo su
conjunto sin que se lo pidan, no porque el mecanismo se haya ido:

```bash
curl -s "$GW/discover" | jq '{catalogStatus, total: .total}'
# "catalogStatus": "complete", "total": 25     (el 2026-08-04 era "truncated", 23)

curl -s "$GW/discover?limit=50" | jq '{catalogStatus, total: .total}'
# "catalogStatus": "complete", "total": 25
```

**Limitaciones conocidas del descubrimiento:** la API de paginación acepta `limit` pero todavía no
soporta continuación por cursor; `/discover?limit=50` devuelve las primeras 50 coincidencias y no hay
forma de pedir el resto. Sin un parámetro `limit`, el gateway no le manda ninguno al registry, así que
el registry devuelve la página por defecto que tenga, y el catálogo puede quedar más truncado de lo
que vería quien sí especifica un límite (pasó el 2026-08-04; el 2026-08-15 las dos formas devuelven
los mismos 25). Una caída del registry y un error de validación del cliente (por
ejemplo un `minReputation` mal formado) se reportan los dos como `http_error` en la telemetría, sin
distinguirse. Los agentes publicados directo contra el gateway tienen `status: 'active'` clavado en el
descubrimiento y su publicador no puede marcarlos inactivos.

Sobre las apps que lo consumen, con el tiempo verbal correcto:

- **Chaski** (la app de remesas) resuelve **dos** patas por este gateway al 2026-08-11: la cotización
  de FX y el desembolso, pedidas **por capacidad** (`remittance-fx-quote` y `remittance-payout`) y no
  por nombre de agente. ⚠️ **Este renglón decía "solo para el agente de cotización de FX, y detrás de
  una bandera que arranca apagada", y que el desembolso se integra "punto a punto, sin pasar por el
  protocolo". Las dos mitades ya son falsas**, y eran falsas en la dirección que *subestima* el
  producto: el carril punto a punto no quedó apagado, se **borró** de `chaski-v3` (lo dice su propio
  código en `src/infrastructure/a2a/gateways.ts:126` y `src/presentation/flow.tsx:2693`), y la bandera
  que arrancaba apagada está puesta. Lo que sigue siendo cierto, y es la parte que vale conservar: **la
  identidad del usuario NO pasa por el protocolo**, y el desembolso final a fiat corre contra un
  adaptador mock por defecto, así que "la remesa entera se orquesta acá" sigue siendo falso, pero por
  un motivo distinto del que daba este renglón.
- El marketplace de agentes delega `compose`, `orchestrate` y `capabilities` a este gateway.

---

## Rail Solana

Es la red principal, así que es la que más letra chica merece. `solana-devnet` es el único adaptador no EVM del repo (`src/adapters/solana/`).

**Salida de dinero, o sea pagarle al agente** (`payment.ts`):

- **Transferencia SPL firmada por el operador.** Arma un `createTransferInstruction`, firma con el `Keypair` de `SOLANA_OPERATOR_PRIVATE_KEY` y difunde con `sendAndConfirmTransaction`. Sin EIP-3009: el operador es el emisor y paga el gas en SOL. Con `SOLANA_SETTLE_VIA_FACILITATOR=true` la firma y el broadcast los hace el facilitator y el gateway deja de tener una llave de settlement; la bandera arranca apagada.
- **Idempotente por `intentId`, en Postgres.** El registro de "a qué `intentId` ya se le pagó y con qué firma" vive en la tabla `a2a_solana_settle_intents` (`settle-ledger.ts`, migración `20260730000000_wkh307_solana_settle_intents.sql`), con escrituras condicionales atómicas vía `plpgsql` y el reloj del lease del lado de Postgres. Es a propósito: Solana no tiene el backstop que da el nonce determinista de EIP-3009 (un SPL transfer re-transmitido paga de nuevo), así que este seam de aplicación es la única defensa contra el doble pago, y un restart del proceso no la borra.
- **Fail-closed, y "no sé" no es "no pasó".** Un RPC caído, un timeout o una respuesta ilegible no autorizan una transferencia ni se reportan como leg no pagado: quedan como disposición desconocida para que un retry o la reconciliación las resuelva. Reportar "no se pagó" sobre algo que no se pudo comprobar es pagar dos veces por diseño.
- **Verificar antes de confiar.** `verify()` exige un delta de balance on-chain `>= amountAtomic` para el mint y el `payTo` esperados; un reintento revalida la firma anterior en cadena (`getParsedTransaction`) en vez de volver a difundir.

**Entrada de dinero, qué sí y qué no:**

- **Depósito prepago en Solana: implementado, testeado y prendido en el deployment de producción.** Estar en el código y estar prendido en el deployment son dos afirmaciones distintas, así que van por separado. *En el código* (`deposit-account.ts` + `deposit-verifier.ts`, con el flag prendido y apagado cubiertos en `src/routes/auth.solana-deposit.test.ts`): `POST /auth/deposit` acepta una firma Solana, la verifica en cadena contra la cuenta de depósito y acredita presupuesto, y el destino que publica `GET /auth/deposit-info` es la **ATA** derivada del par (mint, owner), no una wallet, porque en Solana los tokens no viven en la cuenta. Va detrás de su propio flag (`A2A_DEPOSIT_ENABLED_SOLANA`, separado del flag del rail a propósito) y exige que el depositante coincida con la funding wallet declarada de la clave. *En el deployment que está arriba*, ese flag ahora está prendido: `curl -s "$GW/auth/deposit-info"` devuelve cuatro redes, y la de `solana-devnet` trae `deposit_account: "9BBtuaoFpV3BNUrv4GnNu68RXBVeNwVaJiggyxuK4Qfx"`, su `deposit_account_owner` publicado aparte para que se pueda auditar la derivación, `required_commitment: "finalized"` y el mint de USDC de devnet (medido el 2026-07-31). Esa entrada no trae `treasury` ni `escrow_*` a propósito: los dos son resoluciones EVM, y una address EVM adentro de la entrada Solana mandaría USDC de devnet a un string que en Solana no es nada. `src/routes/auth/deposit.ts` publica la entrada sólo si el flag está prendido: anunciar una cuenta de depósito sin un verificador cableado detrás es invitar plata que después nadie puede acreditar.
- **El mínimo, y que se puede comprobar desde afuera.** Cada entrada trae además `deposit_minimum_usdc` y `deposits_enabled`, los dos calculados con `resolveDepositMinimumMicroUsd()`, el mismo choke-point que lee `checkDepositMinimum()` adentro de `budgetService.registerDeposit`. Es una sola fuente, no una copia publicada que pueda desfasarse, y `src/routes/auth.deposit-info-minimum.test.ts` la clava por los dos bordes: el monto publicado acredita, un micro-dólar menos no. La consecuencia práctica es que la configuración del camino del dinero se puede verificar desde afuera con un `curl` pelado y sin credenciales. Medido hoy, las cuatro redes publican el mismo `deposit_minimum_usdc: "1"` y `deposits_enabled: true`, y eso es el contrato y no una casualidad: el mínimo es del camino de depósito, no de una cadena. Sin mínimo configurado el campo es `null` y `deposits_enabled` es `false`, nunca `"0"`, porque un cero se leería como "mandá lo que quieras" mientras el guard en ese estado rechaza todo depósito.
- **No: x402 entrante.** El challenge de entrada sigue siendo EVM. `x-payment-chain: solana-devnet` corta con `400 CHAIN_INBOUND_PAYMENT_UNSUPPORTED` (`src/middleware/x402.ts`), un error tipado que además dice las dos salidas: otra cadena para el x402, o clave prepaga para seguir operando en `solana-devnet`.

Encender el rail: `SOLANA_ADAPTER_ENABLED=true`, `solana-devnet` dentro de `WASIAI_A2A_CHAINS`, `SOLANA_OPERATOR_PRIVATE_KEY` (base58, con SOL de devnet para gas) y `WASIAI_DOWNSTREAM_X402=true`. Los depósitos entrantes son un segundo interruptor arriba de ése, en este orden: aplicar la migración `20260731000000_wkh315_solana_deposit.sql`, setear `A2A_DEPOSIT_OWNER_SOLANA` (la pubkey dueña, no el destino) y `A2A_DEPOSIT_MIN_USDC`, y recién entonces `A2A_DEPOSIT_ENABLED_SOLANA=true`. Sin el mínimo el camino queda cerrado y contesta `503 DEPOSIT_MINIMUM_NOT_CONFIGURED` en vez de acreditar a ciegas. Los defaults de RPC (`https://api.devnet.solana.com`), mint USDC de devnet (el de Circle, `4zMMC9sr…`), decimales, commitment y CAIP-2 están en `.env.example` y no hace falta tocarlos.

**No hay soporte de Solana mainnet.** Devnet nada más, cero dinero de producción. El escrow no custodial vive en el servicio `wasiai-facilitator`, no acá: `SOLANA_ESCROW_PROGRAM_ID` es de ese repo y este gateway no lo lee.

---

## Arquitectura

Tres servicios, una base Postgres compartida (Supabase):

```
app.wasiai.io (Vercel)            thin-proxy + UI del marketplace
        |  x-wasiai-forward-key (HMAC)
        v
wasiai-a2a (Railway, este repo)   /discover /compose /orchestrate /tasks /mcp
        |  x402 /verify y /settle (solo legs EVM)
        v
wasiai-facilitator (Railway)      firma y liquida por red
        v
                                  Solana / Avalanche / Base / Kite
```

El leg de Solana es la excepción a ese dibujo. Por defecto no pasa por el facilitator: el operador del gateway firma la transferencia SPL y la difunde contra el RPC de devnet, porque no hay un equivalente de EIP-3009 del otro lado. Con `SOLANA_SETTLE_VIA_FACILITATOR=true` esa firma se delega al facilitator (`POST /solana/payout`) y el gateway no firma nada, ni siquiera como fallback: un facilitator caído es un leg no liquidado, no una excusa para volver a ser camino de dinero. La bandera arranca apagada y con ella apagada el comportamiento es el de antes.

Adentro del gateway hay cuatro capas:

| Capa | Qué contiene |
|---|---|
| L4 API pública | `/discover`, `/compose`, `/orchestrate`, agent cards, `/tasks`, `/auth`, `/dashboard` |
| L3 piezas básicas | identidad (`wasi_a2a_*`), presupuesto por clave y por cadena con débito atómico, scoping, rate limits |
| L2 adaptadores | `PaymentAdapter`, `AttestationAdapter`, `GaslessAdapter`, `IdentityBindingAdapter` |
| L1 infra | RPCs y contratos de cada red |

La decisión no obvia acá es que **identidad, presupuesto y autorización viven off-chain (L3) y son propios**, no delegados a la cadena. El motivo es de costo: el ciclo A2A es de polling y de micropagos de fracciones de centavo, y resolver cada autorización on-chain cuesta más que el servicio que se está comprando. La cadena entra solo cuando hay que mover plata de verdad.

Detalle completo en [`doc/architecture/CHAIN-ADAPTIVE.md`](doc/architecture/CHAIN-ADAPTIVE.md) y [`doc/architecture/MULTI-CHAIN.md`](doc/architecture/MULTI-CHAIN.md).

---

## Endpoints

Cada fila de abajo se leyó de `src/routes/` con los prefijos que registra `src/index.ts:270-313`. Eso es una afirmación sobre cada fila, no una afirmación de que la tabla esté generada ni de que sea exhaustiva — acá nadie lo verifica mecánicamente, así que si vas a apoyarte en esto, re-derivalo: `grep -rnE 'fastify\.(get|post|put|patch|delete)' src/routes/`. `/mock-registry/agents` aparece en ese grep y está a propósito fuera de las tablas: se monta sólo fuera de producción (`src/index.ts:292-297`).

**Públicos, sin costo**

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/` | info del servicio |
| `GET` | `/health` | probe de salud |
| `GET` | `/.well-known/agent.json` | agent card del propio gateway |
| `GET \| POST` | `/discover` | busca agentes en todos los registries |
| `GET` | `/discover/:slug` | un agente puntual |
| `GET` | `/capabilities` | métodos, cadenas inicializadas y catálogo |
| `GET` | `/agents/:slug/agent-card` | agent card A2A de un agente |
| `GET` | `/registries`, `/registries/:id` | marketplaces registrados (las credenciales outbound nunca se serializan) |
| `GET` | `/gasless/status` | estado del módulo gasless |
| `GET` | `/dashboard`, `/dashboard/trace` | UI de analítica y de rastreo |

`GET /metrics` expone el formato Prometheus, pero está protegido por `METRICS_TOKEN` y es fail-closed: en producción, si la variable no está seteada, responde `503` en vez de exponer métricas. Todo `/dashboard/api/*` devuelve datos cross-tenant y va detrás de token de operador (`DASHBOARD_ADMIN_TOKEN`); el HTML del dashboard es público porque no lleva ningún dato adentro, los pide el browser contra esa API gateada.

Una sola operación pide **dos** credenciales: `POST /dashboard/api/reconciliation/:intentId/release-lease` exige además `RECONCILIATION_RELEASE_TOKEN` (header `X-Reconciliation-Release-Token`), que debe ser un secreto distinto del token de panel. Es la única operación que vuelve pagable una fila **sin prueba** (atesta un negativo que no se puede verificar y el reconciliador reenvía el pago), así que no comparte credencial con las lecturas ni con su hermana `hop2-evidence`, cuyo hash sí se verifica on-chain. Si `RECONCILIATION_RELEASE_TOKEN` no está configurada, la operación responde `503` en producción **y** en desarrollo.

**Con credencial**

| Método | Ruta | Cobra | Descripción |
|---|---|---|---|
| `POST` | `/compose` | sí | ejecuta un pipeline explícito |
| `POST` | `/orchestrate` | sí | ejecuta a partir de un objetivo |
| `POST` | `/orchestrate/plan` | no debita | planifica y cotiza sin ejecutar ni liquidar |
| `POST` | `/orchestrate/execute` | sí | ejecuta un plan ya aprobado, con techo de costo |
| `POST` | `/registries` · `PATCH \| DELETE /registries/:id` | sí | alta y gestión de marketplaces |
| `POST` | `/agents` · `PATCH \| DELETE /agents/:slug` | no | publicación self-serve de agentes |
| `GET` | `/agents` | no | lista los agentes propios, filtrados por el owner del caller |
| `POST` | `/agents/:slug/link` · `/agents/links/:token/redeem` | según el link | links de invocación acotados |
| `POST` | `/mcp` | según el método | servidor MCP (JSON-RPC) |
| `POST` | `/inbound/:source/tasks` | sí | ingreso de tareas externas por webhook, autenticado por HMAC |
| `POST` | `/gasless/transfer` | sí | transferencia on-chain firmada por la wallet del operador. El débito se reembolsa en los tres caminos en los que no sale nada — RPC caído, módulo no operativo, transferencia fallida —, cada uno llamando a `refundGaslessDebit` en `src/routes/gasless.ts` |
| `GET` | `/receipts`, `/receipts/:id`, `/receipts/:id/verify` | no | recibos encadenados por HMAC de las operaciones del propio caller; `/verify` recalcula el hash e informa si algo fue alterado |

Publicar un agente es gratis a propósito: cobrar el alta desincentiva justo lo que necesita el catálogo. El cobro va donde hay ejecución.

**Tareas (A2A)**, con tenant obligatorio: solo devuelven las del caller y el rail anónimo x402 no aplica.

| Método | Ruta | Costo |
|---|---|---|
| `POST` | `/tasks` | $1 |
| `GET` | `/tasks`, `/tasks/:id` | gratis |
| `PATCH` | `/tasks/:id/status`, `/tasks/:id` | $1 |

Leer una tarea es gratis a propósito. El ciclo de vida A2A se maneja por polling de `GET /tasks/:id`, así que cobrar por lectura significaba que un poll cada 5 segundos costaba 720 USD por hora: el precio peleaba contra el protocolo. Las lecturas gratis no emiten challenge `402` porque no hay nada que pagar.

**Identidad y presupuesto**: `POST /auth/agent-signup`, `GET /auth/me`, `GET /auth/deposit-info`, `POST /auth/deposit` (verifica el depósito on-chain antes de acreditar; acepta una firma Solana o un hash EVM, y rechaza antes de salir a la red si la referencia no corresponde a la cadena pedida; el leg Solana va detrás de `A2A_DEPOSIT_ENABLED_SOLANA` y está prendido en el deployment en vivo, ver [Rail Solana](#rail-solana)), `POST|GET|DELETE /auth/key-session`, `POST|GET|DELETE /auth/delegation`, `PUT|GET|DELETE /auth/keys/me/spend-policies`, `POST /auth/erc8004/bind`, `GET /auth/erc8004/resolve/:token_id`. `POST /auth/bind/:chain` sigue devolviendo `501`: es un placeholder declarado, no una función.

Cuatro más bajo el mismo prefijo, todas escribiendo sobre la clave del propio caller y todas con el id de clave tomado del caller autenticado y nunca del body: `POST /auth/funding-wallet` ata una funding wallet con prueba de control (el caller firma `WASIAI_BIND_FUNDING_WALLET:<key_id>` en EVM o `WASIAI_BIND_FUNDING_WALLET_SOLANA:<key_id>` en Solana — dos textos distintos a propósito: hoy los preimágenes ya difieren igual (EIP-191 prefija su mensaje, un wallet Solana firma los bytes crudos), y el namespace está para que esa no-colisión no dependa de una convención de wallets que este repo no controla — y de ahí en adelante `/auth/deposit` exige que la transferencia venga de esa wallet), y `PATCH /auth/agent-key/:id/require-signature` más `PATCH /auth/key-session/:id/require-signature` prenden y apagan la firma EIP-712 por request, sobre la clave maestra y sobre una sub-sesión. `POST /auth/bind-passport` ata un Kite Agent Passport, y sólo existe cuando `PASSPORT_BINDING_ENABLED=true`: con el flag apagado la ruta no se monta y la respuesta es un `404` pelado, no un `403`.

**Pagos programados**: `POST /payments/session` (medido, con vouchers y cierre) y `POST /payments/upto` (tope firmado por ambas partes), más sus `/settle`, `/close` y `/dispute`.

---

## Correrlo local

Node 22 o superior (`engines` del `package.json`; el CI corre 22).

```bash
git clone https://github.com/ferrosasfp/wasiai-a2a.git
cd wasiai-a2a
npm install

cp .env.example .env
# mínimo para arrancar: SUPABASE_URL, SUPABASE_SERVICE_KEY,
# KITE_WALLET_ADDRESS (o PAYMENT_WALLET_ADDRESS) y ANTHROPIC_API_KEY

npm run dev          # tsx watch, escucha en 3001
```

El puerto por defecto es 3001 y no 3000, para no chocar con un Next.js corriendo al lado.

Ese mínimo levanta el gateway con el rail EVM por defecto: el rail Solana pide su propia bandera y su llave de operador ([Rail Solana](#rail-solana)). Y si `WASIAI_A2A_CHAINS` tuviera **sólo** `solana-devnet`, el proceso arranca pero no queda ninguna cadena que acepte cobro x402 de entrada: en esa config la única vía de cobro es la clave prepaga.

Scripts reales del `package.json`:

| Script | Qué hace |
|---|---|
| `npm run dev` | servidor con recarga (`tsx watch`) |
| `npm run build` | `tsc` a `dist/` y copia de estáticos |
| `npm start` | corre `dist/index.js` |
| `npm test` | suite completa (Vitest) |
| `npm run test:coverage` | suite con cobertura y umbrales |
| `npm run lint` | Biome sobre `src/` |
| `npm run format` | Biome con escritura |
| `npm run smoke:downstream` | smoke de red del leg de pago saliente |
| `npm run migrate:preflight` | chequeo previo de migraciones |

Sin `SUPABASE_URL` real el servidor arranca igual y responde `/health`, pero todo lo que toque catálogo o presupuesto falla: la persistencia no es opcional.

`.env.example` documenta **183 variables** con sus defaults (contadas con `grep -cE '^[A-Z][A-Z0-9_]*=' .env.example`, y esa misma cuenta la re-deriva `test/readme-numbers.test.ts` en cada `npm test`), y las pocas que cambian el comportamiento del dinero están agrupadas ahí.

Dos guardas de arranque que conviene conocer antes de tocar config de mainnet:

- El proceso **se niega a arrancar** si el slug de cadena y la variable de red del adaptador se contradicen (por ejemplo el slug de Kite testnet con `KITE_NETWORK=mainnet`, que apuntaría el bundle "testnet" a la cadena 2366 con dinero real).
- El leg de salida hacia cualquier mainnet exige un opt-in explícito en `WASIAI_DOWNSTREAM_MAINNET_ALLOW`. Vacío o ausente significa que ningún leg de mainnet liquida: corta con `MAINNET_NOT_ALLOWED`. Es fail-closed a propósito.

**Dos compuertas independientes para el dinero real**: hay dos chequeos separados antes de que un pago a una cadena mainnet llegue a producción. Ninguno alcanza solo; tienen que pasar los dos:

1. **Primera compuerta: el facilitator**. El servicio de liquidación (`wasiai-facilitator`) registra una cadena sólo cuando su adaptador está habilitado (un flag tipo `*_ENABLED`) y el endpoint RPC está configurado. Si una red no está registrada ahí, el adaptador no existe y no hay liquidación posible.

2. **Segunda compuerta: este repo**. Aunque una cadena mainnet esté registrada en el facilitator, este gateway no la invoca salvo que el slug esté listado en `WASIAI_DOWNSTREAM_MAINNET_ALLOW`. El chequeo ocurre en runtime (`src/lib/downstream-payment.ts:186-194`); si la cadena es mainnet y no está en el opt-in, el settle se saltea con `code: 'MAINNET_NOT_ALLOWED'` (línea 740) y se mapea a la acción `OPERATOR_DECIDE_MAINNET_OPT_IN` (src/lib/downstream-skip-code.ts:306). Es fail-closed: una variable vacía o ausente bloquea todos los legs de mainnet.

Un ejemplo: el 14 de agosto de 2026 el endpoint `/supported` del facilitator de producción devolvía cuatro cadenas (Kite Testnet, Avalanche Fuji, Base Sepolia, Solana Devnet), ninguna mainnet. O sea que la primera compuerta ya estaba cerrada. Pero aunque en el futuro devolviera Avalanche C-Chain mainnet (43114), seguiría bloqueado mientras esa cadena no esté listada en `WASIAI_DOWNSTREAM_MAINNET_ALLOW` y no se redespliegue. Ese doble candado es a propósito: probar una variable de una configuración no alcanza como prueba de que un camino de dinero real es seguro.

---

## Tests

```bash
npm test
```

Estado medido en este repo, no citado de otro documento. Cada número de abajo o se re-deriva en cada `npm test` con `test/readme-numbers.test.ts`, o está escrito con la fecha en que se midió para que no envejezca en silencio:

| Métrica | Valor |
|---|---|
| Archivos de test | **290 archivos de test** en la suite raíz. Derivado del `include` de `vitest.config.ts` sobre el índice de git, y verificado en los dos README, por `test/readme-numbers.test.ts` |
| Casos de test | lo imprime `npm test`. A propósito no se escribe acá: cambia con cada test nuevo, y un test que lo clavara tendría que correr la suite que está contando |
| Piso de cobertura que exige el CI | sentencias **80%**, ramas **70%**, funciones **80%**, líneas **80%** (`vitest.config.ts:26-31`). Por debajo de cualquiera de los cuatro, `npm run test:coverage` sale con código distinto de cero y el job `coverage` falla |
| Cobertura medida | `npm run test:coverage` imprimió 87,49% de sentencias, 79,64% de ramas, 92,48% de funciones y 89,02% de líneas el 2026-08-15 |
| Typecheck | `tsc --noEmit` limpio |
| Lint | `npm run lint` (Biome) sobre **482 archivos**, que es el `src/**/*.ts` de `biome.json` |
| CI | el badge `ci` de arriba es el resultado vivo de `.github/workflows/ci.yml`, y nada de esta tabla lo pisa |

Leé el badge, no esta tabla: si `ci` está en rojo el workflow se cortó en su primer paso fallado, y todo paso posterior — la suite incluida — se reporta como `skipped`, que no es lo mismo que pasado. Los pasos corren en orden (typecheck, lint, suite) y sin `if: always()`, así que un solo error de lint alcanza para dejar la suite sin correr en ese commit.

Unos pocos archivos se saltean en vez de correr: los `*.real.test.ts` necesitan un Postgres de verdad y están condicionados a `INTEGRATION_TEST_DB_URL`, más un e2e manual contra devnet. Se saltean, no fallan, así que el CI no depende de una base viva. `npm test` imprime cuántos son.

El 286 de arriba es sólo la suite raíz. El CI corre dos suites más, de sub-paquetes con runner propio, `mcp-servers/wasiai-x402` y `packages/agent-sdk`; no están en ese número, y `test/test-files-are-run-in-ci.test.ts` es lo que impide que un tercer sub-paquete nazca sin que nadie lo corra.

Contra la medición del 2026-08-15, el piso exigido queda entre 7,5 y 12,5 puntos más abajo. Es un trinquete para un derrumbe, no para una regresión de un punto: un piso pegado a la medición pone en rojo cada refactor y termina bajándolo el que tiene apuro.

---

## Evidencia on-chain

Liquidaciones verificables. La de Solana es devnet (sin dinero real) y se confirmó por RPC al escribir esto (`err: None`); las tres de Avalanche C-Chain son mainnet, con dinero de verdad, y también se confirmaron por RPC (`status: 0x1`).

| Tx | Red | Qué fue |
|---|---|---|
| [`3pNqu9jH…`](https://explorer.solana.com/tx/3pNqu9jHduGaXioB8Mf7WNvBgZQgJV4MnE6NDGWZdz6aY5gr2ivxfbwzrnweutSVtyKnvv7y7kXnARroktjyWsZx?cluster=devnet) | Solana devnet | USDC-SPL de Circle saliente a la wallet de cobro de `remit-corridor-fx-solana`, 0,000001 |
| [`0x9fa6ff83…`](https://snowtrace.io/tx/0x9fa6ff83eb10e51685ce078e69f9c42fcbe3b138b5b8c3f32909c9fee279c6f1) | Avalanche C-Chain (43114) | USDC saliente a `wasi-chainlink-price`, $0,001 |
| [`0xa22086d0…`](https://snowtrace.io/tx/0xa22086d048b0222a8e08a5ca08997ae6c359e5ba674e63133a0ffbc463af16f9) | Avalanche C-Chain (43114) | USDC saliente a `wasi-defi-sentiment`, $0,010 |
| [`0xca10320c…`](https://snowtrace.io/tx/0xca10320c24ff513d773ce65e0bd306d4acce3e4883180c9dca5573da6cf1dfdb) | Avalanche C-Chain (43114) | USDC saliente a `wasi-wallet-profiler`, $0,050 |
| [`0x6f406c08…`](https://testnet.kitescan.ai/tx/0x6f406c08f6e59e3c5029f57ec3a84bb4596b94bb02568055ec4f9572981a1bf9) | Kite testnet (2368) | PYUSD entrante, 1,0 |

Sobre Base Sepolia hay cinco corridas documentadas (tres liquidaciones sueltas, una de `/compose` de punta a punta y una del leg de salida), con los hashes y el método de verificación en [`doc/BASE-EVIDENCE.md`](doc/BASE-EVIDENCE.md).

Ninguno de esos números sale de un documento interno: cualquiera puede pegar el hash en un `eth_getTransactionReceipt` contra el RPC público de la red y comparar. Para la firma de Solana el equivalente es un `getTransaction` contra `https://api.devnet.solana.com`: devuelve `meta.err: null` y el par de balances pre/post del mint de Circle que prueba la transferencia.

---

## Documentación

| Documento | Contenido |
|---|---|
| [`doc/solana-labs/`](doc/solana-labs) | entregables del programa Solana LATAM Labs: roadmap (M1), negocio (M2) y arquitectura del MVP (M3) |
| [`doc/INTEGRATION.md`](doc/INTEGRATION.md) | guía de integración: auth, onboarding, x402, códigos de error, ejemplos |
| [`doc/integration-base.md`](doc/integration-base.md) | integración específica de Base y elección de facilitator |
| [`doc/architecture/CHAIN-ADAPTIVE.md`](doc/architecture/CHAIN-ADAPTIVE.md) | arquitectura L1 a L4 e interfaces de adaptador |
| [`doc/architecture/MULTI-CHAIN.md`](doc/architecture/MULTI-CHAIN.md) | selección de cadena, tabla de alias, activación de mainnet |
| [`doc/architecture/FEE-MODEL.md`](doc/architecture/FEE-MODEL.md) | modelo de fee y split, con ejemplo trabajado |
| [`doc/BASE-EVIDENCE.md`](doc/BASE-EVIDENCE.md) | pruebas on-chain del adaptador de Base |
| [`doc/kite-contracts.md`](doc/kite-contracts.md) | contratos y tokens de Kite |
| [`doc/sdd/_INDEX.md`](doc/sdd/_INDEX.md) | índice de specs, revisiones y reportes de QA de cada cambio |
| [`HACKATHON-FINAL.md`](HACKATHON-FINAL.md) | histórico de la entrega al hackathon de Kite |

---

## Contribuir

Cada cambio pasa por un pipeline con gates humanos entre roles (análisis, arquitectura, desarrollo, revisión adversarial, QA, cierre). Los artefactos de cada uno quedan en `doc/sdd/NNN-titulo/` y el detalle del método está en [`CLAUDE.md`](CLAUDE.md).

Al abrir un PR: rama desde `main` con prefijo `feat/` o `fix/`, y ni la revisión adversarial ni el code review se saltean en un PR que toca código.

## Licencia

[MIT](LICENSE)
