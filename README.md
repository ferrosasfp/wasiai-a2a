# WasiAI A2A

[![ci](https://github.com/ferrosasfp/wasiai-a2a/actions/workflows/ci.yml/badge.svg)](https://github.com/ferrosasfp/wasiai-a2a/actions/workflows/ci.yml)
[![smoke-downstream](https://github.com/ferrosasfp/wasiai-a2a/actions/workflows/smoke-downstream.yml/badge.svg)](https://github.com/ferrosasfp/wasiai-a2a/actions/workflows/smoke-downstream.yml)
[![protocolo](https://img.shields.io/badge/protocolo-Google%20A2A-blue)](https://google.github.io/A2A/)
[![licencia](https://img.shields.io/badge/licencia-MIT-green)](LICENSE)

Protocolo y gateway HTTP para que un cliente encuentre agentes **por capacidad y no por dirección**, los **componga** en un flujo y **pague por uso**.

Un cliente no necesita saber que existe `remit-corridor-fx`. Pide "necesito una cotización de FX" y el gateway le devuelve quién puede hacerlo, en qué red cobra y cuánto sale. Después ejecuta el flujo con una sola llamada HTTP y el gateway se encarga del pago a cada agente.

El gateway federa los catálogos de los marketplaces registrados: un agente publicado en cualquiera de ellos es descubrible desde cualquier app conectada. Esa es la tesis del repo: **el marketplace es una aplicación sobre el protocolo, no el protocolo**.

- Gateway en vivo: `https://wasiai-a2a-production.up.railway.app`
- Protocolo base: [Google A2A](https://google.github.io/A2A/) + [x402](https://github.com/x402-foundation/x402) para el pago

---

## Descubrimiento por capacidad

Todo el catálogo es público y no cuesta nada consultarlo.

```bash
GW=https://wasiai-a2a-production.up.railway.app

curl -s "$GW/discover?capabilities=price-feed" | jq '.agents[] | {slug, priceUsdc, chain: .payment.chain}'
# {"slug":"wasi-chainlink-price","priceUsdc":0.001,"chain":"avalanche"}

curl -s "$GW/discover?capabilities=remittance-fx-quote" | jq -r '.agents[].slug'
# remit-corridor-fx-solana
# remit-corridor-fx
```

El primero vive en un marketplace externo registrado (`registry: "WasiAI"`), el segundo se publicó directo contra el gateway (`registry: "self-published"`). El cliente que consulta no distingue uno de otro, y esa indistinción es el punto: la federación es transparente para quien consume.

Cada agente que devuelve `/discover` trae un `invokeUrl`, pero es una referencia interna. **El caller no llama al agente directo.** Invoca vía `/compose` (pipeline explícito) u `/orchestrate` (por objetivo, con el plan armado por un LLM). Eso es lo que permite que el gateway resuelva precio, presupuesto, scoping y liquidación en un solo lugar en vez de dejarlo en manos de cada cliente.

## Composición y cobro

`/compose` recibe los pasos ya resueltos y devuelve un challenge x402 si no viene pago:

```bash
curl -s -X POST "$GW/compose" -H 'content-type: application/json' \
  -d '{"steps":[{"agent":"wasi-chainlink-price","input":{"symbol":"AVAX"}}]}'
```

```json
{
  "error": "payment-signature header is required",
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:2368",
    "maxAmountRequired": "1010000000000000",
    "payTo": "0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba",
    "asset": "0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9",
    "maxTimeoutSeconds": 300
  }],
  "x402Version": 2
}
```

El monto es el precio real del pipeline más el fee de protocolo: `0.001 + 1% = 0.00101`. La misma llamada con el header `x-payment-chain: avalanche-fuji` devuelve `network: "eip155:43113"`, el USDC de Fuji y `maxAmountRequired: "1010"` (6 decimales en vez de 18). Es el mismo pipeline cotizado en otra red, sin tocar el body.

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

La capa es neutral respecto de la red. No hay una cadena "principal" en el diseño: hay un adaptador por red y un selector por request.

El caso concreto que motivó el diseño es una remesa. El marketplace de agentes corre sobre Avalanche, el principal de la remesa viaja por Solana, y la liquidación la coordina un servicio aparte (`wasiai-facilitator`) con un adaptador por red. Ninguna de las tres piezas necesita que las otras dos estén en su cadena.

Cómo se implementa:

- `PaymentAdapter` es una unión discriminada: `EvmPaymentAdapter | SolanaPaymentAdapter` (`src/adapters/types.ts`). La familia de VM es un dato del tipo, no un `if` desparramado.
- El bundle de adaptadores (payment, attestation, gasless, identity) se construye por cadena en `src/adapters/registry.ts`. Agregar una red es una carpeta nueva en `src/adapters/<red>/` más una rama en el factory. Los servicios (L3) y las rutas (L4) no se tocan.
- La selección por request sale del header `x-payment-chain` (acepta el slug o el chainId numérico) con fallback a la primera entrada de `WASIAI_A2A_CHAINS`.

Redes soportadas en código (`SUPPORTED_CHAINS` + los dos rails detrás de bandera):

| Slug | chainId | Estado en código |
|---|---|---|
| `kite-ozone-testnet` | 2368 | soportada (default si no se configura nada) |
| `kite-mainnet` | 2366 | soportada, exige `KITE_NETWORK=mainnet` acoplado |
| `avalanche-fuji` | 43113 | soportada |
| `avalanche-mainnet` | 43114 | soportada, con opt-in extra para el leg de salida |
| `base-sepolia` | 84532 | soportada |
| `base-mainnet` | 8453 | soportada |
| `tempo-testnet` | testnet | implementada, apagada por bandera (`TEMPO_ADAPTER_ENABLED`) |
| `solana-devnet` | sentinela 900001 | implementada, encendida por bandera (`SOLANA_ADAPTER_ENABLED`) |

Los dos rails con bandera arrancan apagados: con la bandera en `false` el slug ni siquiera entra al set soportado, así que el bundle no se construye y el leg corta con `CHAIN_NOT_SUPPORTED`. No es un `if` adentro del adaptador, es que el adaptador no existe en el proceso.

## Qué corre hoy

Esto es el estado real, no el roadmap. Se lee del `GET /capabilities` del deployment de producción.

```bash
curl -s "$GW/capabilities" | jq '.chains'
```

| Cadena inicializada hoy | chainId | Rail |
|---|---|---|
| Kite Ozone testnet | 2368 | entrante en PYUSD, es el default |
| Avalanche Fuji | 43113 | entrante y saliente, USDC de testnet |
| Base Sepolia | 84532 | entrante y saliente, USDC de testnet |
| Solana devnet | sentinela 900001 | solo saliente, USDC-SPL |

Las tres primeras filas se comprueban mandando `x-payment-chain` a `POST /compose` sin pago: el `402` vuelve con `eip155:2368`, `eip155:43113` o `eip155:84532` y el monto en los decimales del token de esa red.

**Ninguna red mainnet está inicializada en el deployment de hoy.** Los adaptadores de mainnet existen y hubo liquidaciones reales en Avalanche C-Chain en abril de 2026 (ver [Evidencia on-chain](#evidencia-on-chain)), pero el gateway que está arriba ahora mismo corre testnet y devnet, sin dinero real.

Estado del catálogo en ese mismo deployment: 25 agentes descubribles, de un marketplace federado más los publicados directo contra el gateway. Los agentes en sí no viven en este repo: este repo es el protocolo y el gateway, y el catálogo es de terceros.

Sobre las apps que lo consumen, con el tiempo verbal correcto:

- **Chaski** (la app de remesas) usa este gateway hoy **solo para el agente de cotización de FX**, y detrás de una bandera que arranca apagada. La identidad del usuario y el desembolso final se integran punto a punto, sin pasar por el protocolo. Cualquier afirmación de que la remesa entera se orquesta acá es falsa.
- El marketplace de agentes delega `compose`, `orchestrate` y `capabilities` a este gateway.

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
                                  Kite / Avalanche / Base / Solana
```

El leg de Solana es la excepción a ese dibujo: no pasa por el facilitator. El operador del gateway firma la transferencia SPL y la difunde contra el RPC de devnet, porque no hay un equivalente de EIP-3009 del otro lado.

Adentro del gateway hay cuatro capas:

| Capa | Qué contiene |
|---|---|
| L4 API pública | `/discover`, `/compose`, `/orchestrate`, agent cards, `/tasks`, `/auth`, `/dashboard` |
| L3 primitivas | identidad (`wasi_a2a_*`), presupuesto por clave y por cadena con débito atómico, scoping, rate limits |
| L2 adaptadores | `PaymentAdapter`, `AttestationAdapter`, `GaslessAdapter`, `IdentityBindingAdapter` |
| L1 infra | RPCs y contratos de cada red |

La decisión no obvia acá es que **identidad, presupuesto y autorización viven off-chain (L3) y son propios**, no delegados a la cadena. El motivo es de costo: el ciclo A2A es de polling y de micropagos de fracciones de centavo, y resolver cada autorización on-chain cuesta más que el servicio que se está comprando. La cadena entra solo cuando hay que mover plata de verdad.

Detalle completo en [`doc/architecture/CHAIN-ADAPTIVE.md`](doc/architecture/CHAIN-ADAPTIVE.md) y [`doc/architecture/MULTI-CHAIN.md`](doc/architecture/MULTI-CHAIN.md).

---

## Endpoints

Todos verificados contra `src/routes/`.

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

Publicar un agente es gratis a propósito: cobrar el alta desincentiva justo lo que necesita el catálogo. El cobro va donde hay ejecución.

**Tareas (A2A)**, con tenant obligatorio: solo devuelven las del caller y el rail anónimo x402 no aplica.

| Método | Ruta | Costo |
|---|---|---|
| `POST` | `/tasks` | $1 |
| `GET` | `/tasks`, `/tasks/:id` | gratis |
| `PATCH` | `/tasks/:id/status`, `/tasks/:id` | $1 |

Leer una tarea es gratis a propósito. El ciclo de vida A2A se maneja por polling de `GET /tasks/:id`, así que cobrar por lectura significaba que un poll cada 5 segundos costaba 720 USD por hora: el precio peleaba contra el protocolo. Las lecturas gratis no emiten challenge `402` porque no hay nada que pagar.

**Identidad y presupuesto**: `POST /auth/agent-signup`, `GET /auth/me`, `POST /auth/deposit` (verifica el depósito on-chain antes de acreditar), `POST|GET|DELETE /auth/key-session`, `POST|GET|DELETE /auth/delegation`, `PUT|GET|DELETE /auth/keys/me/spend-policies`, `POST /auth/erc8004/bind`, `GET /auth/erc8004/resolve/:token_id`. `POST /auth/bind/:chain` sigue devolviendo `501`: es un placeholder declarado, no una función.

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

`.env.example` documenta 122 variables con sus defaults. Las que cambian el comportamiento del dinero son pocas y están agrupadas ahí: `WASIAI_A2A_CHAINS`, `WASIAI_DOWNSTREAM_X402`, `WASIAI_DOWNSTREAM_MAINNET_ALLOW`, `PROTOCOL_FEE_RATE`, `SPLIT_BPS_*`, `GASLESS_ENABLED`, `SOLANA_ADAPTER_ENABLED`, `TEMPO_ADAPTER_ENABLED`.

Dos guardas de arranque que conviene conocer antes de tocar config de mainnet:

- El proceso **se niega a arrancar** si el slug de cadena y la variable de red del adaptador se contradicen (por ejemplo el slug de Kite testnet con `KITE_NETWORK=mainnet`, que apuntaría el bundle "testnet" a la cadena 2366 con dinero real).
- El leg de salida hacia cualquier mainnet exige un opt-in explícito en `WASIAI_DOWNSTREAM_MAINNET_ALLOW`. Vacío o ausente significa que ningún leg de mainnet liquida: corta con `MAINNET_NOT_ALLOWED`. Es fail-closed a propósito.

---

## Tests

```bash
npm test
```

Estado medido en este repo, no citado de otro documento:

| Métrica | Valor |
|---|---|
| Tests | 3.808 verdes, 19 salteados (3.827 en total) |
| Archivos de test | 203 verdes, 6 salteados (209) |
| Cobertura de sentencias | 85,83% |
| Cobertura de ramas | 76,89% |
| Cobertura de funciones | 91,4% |
| Cobertura de líneas | 87,31% |
| Typecheck | `tsc --noEmit` limpio |
| Lint | Biome limpio sobre 387 archivos |

Los salteados son los `*.real.test.ts`, que necesitan un Postgres de verdad y están condicionados a `INTEGRATION_TEST_DB_URL`, más un e2e manual contra devnet. Se saltean, no fallan, así que el CI no depende de una base viva. El workflow `ci.yml` corre typecheck, lint, suite y cobertura en cada PR y en cada push a `main`.

Los umbrales de cobertura están fijados apenas por debajo de la medición actual, como trinquete: sirven para detectar regresión, no para declarar victoria.

---

## Rail Solana

`solana-devnet` es un adaptador no EVM. Lo que hace exactamente, en `src/adapters/solana/payment.ts`:

- **Solo saliente.** Liquida el leg del gateway pagándole a un agente cuyo payout es Solana. El challenge entrante (cobrarle al caller) sigue siendo EVM: `getPaymentAdapter()` tira para un bundle no EVM, así que `x-payment-chain: solana-devnet` no es un rail de entrada válido. Hoy eso se manifiesta como un `500` genérico y no como un error tipado, que es feo pero es fail-closed: no cobra ni ejecuta nada.
- **Transferencia SPL firmada por el operador.** Arma un `createTransferInstruction`, firma con el `Keypair` de `SOLANA_OPERATOR_PRIVATE_KEY` y difunde con `sendAndConfirmTransaction`. Sin EIP-3009 y sin facilitator: el operador es el emisor y paga el gas en SOL.
- **Idempotente por `intentId`.** Un `intentId` repetido revalida la firma anterior on-chain (`getParsedTransaction`, balances pre y post de `payTo`) y la devuelve en vez de volver a difundir. Ese mapa vive en memoria del proceso, así que la idempotencia sobrevive reintentos pero no un reinicio. Es una limitación conocida, no un descuido.
- **Verificar antes de confiar.** `verify()` exige un delta de balance on-chain `>= amountAtomic` para el mint y el `payTo` esperados.

Encenderlo: `SOLANA_ADAPTER_ENABLED=true`, `solana-devnet` dentro de `WASIAI_A2A_CHAINS`, `SOLANA_OPERATOR_PRIVATE_KEY` (base58, con SOL de devnet para gas) y `WASIAI_DOWNSTREAM_X402=true`. Los defaults de RPC (`https://api.devnet.solana.com`), mint USDC de devnet, decimales, commitment y CAIP-2 están en `.env.example` y no hace falta tocarlos.

**No hay soporte de Solana mainnet.** Devnet nada más, cero dinero de producción. El escrow no custodial vive en el servicio `wasiai-facilitator`, no acá: si un checklist menciona `SOLANA_ESCROW_PROGRAM_ID`, es de ese repo y este gateway no lo lee.

---

## Evidencia on-chain

Liquidaciones reales verificables. Las tres de Avalanche C-Chain son mainnet, con dinero de verdad, y se confirmaron por RPC al escribir esto (`status: 0x1`).

| Tx | Red | Qué fue |
|---|---|---|
| [`0x9fa6ff83…`](https://snowtrace.io/tx/0x9fa6ff83eb10e51685ce078e69f9c42fcbe3b138b5b8c3f32909c9fee279c6f1) | Avalanche C-Chain (43114) | USDC saliente a `wasi-chainlink-price`, $0,001 |
| [`0xa22086d0…`](https://snowtrace.io/tx/0xa22086d048b0222a8e08a5ca08997ae6c359e5ba674e63133a0ffbc463af16f9) | Avalanche C-Chain (43114) | USDC saliente a `wasi-defi-sentiment`, $0,010 |
| [`0xca10320c…`](https://snowtrace.io/tx/0xca10320c24ff513d773ce65e0bd306d4acce3e4883180c9dca5573da6cf1dfdb) | Avalanche C-Chain (43114) | USDC saliente a `wasi-wallet-profiler`, $0,050 |
| [`0x6f406c08…`](https://testnet.kitescan.ai/tx/0x6f406c08f6e59e3c5029f57ec3a84bb4596b94bb02568055ec4f9572981a1bf9) | Kite testnet (2368) | PYUSD entrante, 1,0 |

Sobre Base Sepolia hay cinco corridas documentadas (tres liquidaciones sueltas, una de `/compose` de punta a punta y una del leg de salida), con los hashes y el método de verificación en [`doc/BASE-EVIDENCE.md`](doc/BASE-EVIDENCE.md).

Ninguno de esos números sale de un documento interno: cualquiera puede pegar el hash en un `eth_getTransactionReceipt` contra el RPC público de la red y comparar.

---

## Documentación

| Documento | Contenido |
|---|---|
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

Al abrir un PR: rama desde `main` como `feat/NNN-wkh-XX-titulo` o `fix/NNN-wkh-XX-titulo`, referencia a la HU en el mensaje de commit, y ni la revisión adversarial ni el code review se saltean en un PR que toca código.

## Licencia

[MIT](LICENSE)
