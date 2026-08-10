# Work Item — [WKH-314] La pata de ENTRADA de pagos en Solana (x402 inbound)

**Tipo**: feature / money-path / multi-VM
**Estado**: F1 (work-item). NO hay decisión tomada, NO hay diseño.
**Repo**: `/home/ferdev/.openclaw/workspace/wasiai-a2a` (leído en solo lectura, rama `main`)
**Fecha de verificación del código**: 2026-07-29
**Trazabilidad del identificador**: esta HU estaba planificada como `WKH-210` / `HU-SOL-F3`
("402 intent", marcada OPCIONAL / fast-follow). Se le asigna **WKH-314** porque el
directorio `doc/sdd/210-…` ya está ocupado por WKH-308 y el índice ya arrastra una deuda
de numeración documentada (`_INDEX.md:181-209`). El número de ticket es nuevo a propósito;
el alcance es el que estaba planificado, ahora obligatorio.

---

## Resumen

Hoy **no existe ninguna forma de que el dinero ENTRE al gateway por Solana**. El leg de
SALIDA (gateway → agente, SPL transfer real) funciona y está verificado en cadena. El leg
de ENTRADA está cerrado por dos paredes independientes, y el encargo sólo nombraba una.
Esta HU abre la primera: que un pagador que llega con x402 pueda pagar en Solana, y que el
gateway **verifique** ese pago (no lo origine) antes de entregar servicio.

Fecha comprometida ante la incubadora (WayLearn / Solana LATAM Labs): semana del
**2026-08-03**. Restricción del founder que no se toca: **devnet, plata no real**.

---

## Sizing

- **SDD_MODE**: full (el repo es siempre QUALITY; esto es money-path)
- **Estimación**: **L**
- **Branch sugerido**: `feat/212-wkh-314-x402-inbound-solana`
- **Veredicto honesto contra la fecha**: el leg de entrada COMPLETO **no entra** en la
  semana del 03/08. El **corte mínimo** sí entra, y está definido en §7. Ver ahí también
  qué se descartó como corte y por qué era peor que no hacer nada.

---

## 1. El hueco, y el segundo hueco que el encargo no nombraba

### 1.1 Pared A — x402 inbound rechaza cualquier chain no-EVM (dato dado, verificado)

`src/services/compose.ts:1462`

```ts
if (agent.priceUsdc > 0 && !a2aKey && inboundVmUnsupported) { … }
```

`inboundVmUnsupported` (`compose.ts:1461`) es la disyunción de dos guardas: la chain
declarada del agente no es EVM (`:1430-1435`, vía `normalizeChainSlug` + `getChainVmFamily`)
o el `payTo` no valida como address EVM (`:1456-1460`, vía `isValidWallet`).

El corte de verdad, sin embargo, es más arriba y más duro: el middleware x402 corta con
**400** antes de tocar nada, en `src/middleware/x402.ts:479-497`, consultando
`acceptsInboundPayment(bundle)` — cuya definición completa es una línea:

`src/adapters/registry.ts:510-512`

```ts
export function acceptsInboundPayment(bundle: AdaptersBundle): boolean {
  return bundle.payment.vmFamily === 'evm';
}
```

Y la razón por la que es EVM-only está escrita, no inferida: **todo** el camino inbound
(`buildX402Response` → `resolvePaymentRequirements` → `verify` → `settle`) pasa por
`getPaymentAdapter()`, que **lanza a propósito** sobre un adapter no-EVM
(`registry.ts:414-422`). El docstring de `acceptsInboundPayment` (`registry.ts:494-509`) lo
dice mejor de lo que yo podría: *"Un adapter Solana ahí no es 'un rail a medio hacer': es
la mitad que nunca existió."*

`GET /capabilities` publica la asimetría honestamente (`src/routes/capabilities.ts:44-60`):
`solana-devnet` sale con `acceptsInboundPayment: false`. Eso es HU-204 y **es correcto
hoy** — es un contrato público que esta HU va a cambiar.

### 1.2 Pared B — el camino prepago tampoco se puede FONDEAR en Solana (hallazgo nuevo)

El encargo asume que hoy "a un agente Solana sólo se le puede pagar con clave prepaga".
Eso es cierto para el **débito**, y falso para el **fondeo**. La clave prepaga no se puede
cargar en Solana:

- `src/adapters/deposit-verifier.ts:82-86` — comentario literal en el código:
  `// WKH-234 — Solana rail. Deposit = Scope OUT (settle-only); código muerto para la ruta
  de deposit (Solana no entra al viem deposit-path).`
- `src/routes/auth/deposit.ts:57` + `:63` — `POST /deposit` exige
  `tx_hash` con `/^0x[0-9a-fA-F]{64}$/`. Una firma Solana es base58, no `0x…`.
- `src/routes/auth/deposit.ts:64-65` — exige `chain_id: number`. Solana no tiene chainId
  numérico; su `chainConfig.chainId` es un sentinel sintético (`registry.ts:263-264`, DT-8
  de WKH-234).
- El verificador entero es viem (`deposit-verifier.ts:12-19`): lee un `Transfer` ERC-20.

Consecuencia, y es la que importa para el compromiso con la incubadora: **hoy todo dólar
que entra al gateway entra por una chain EVM**, por x402 o por depósito prepago. La frase
*"no debe intervenir Avalanche"* no es satisfacible hoy por ninguno de los dos caminos, y
cerrar sólo la pared A la satisface **únicamente si el pagador de la demo paga por x402**.
Ver MI-1: es bloqueante y no lo pude determinar desde este repo.

### 1.3 Tercer hallazgo — el anti-replay inbound que existe FALLA ABIERTO, y en Solana eso cambia de significado

`src/services/x402-nonce.ts:31-53` registra el nonce inbound en `a2a_x402_nonces` con
`UNIQUE(network, nonce)`, y devuelve tres estados (`fresh` / `replay` / `unavailable`).
Ante cualquier error que no sea el `23505`, **falla ABIERTO** (`:41-51`), y la
justificación está escrita en el encabezado del archivo (`:10-13`):

> *"el `authorization.nonce` EIP-3009 ya es single-use a nivel token on-chain, así que esta
> tabla nunca es la única defensa del replay"*

**Esa justificación se evapora en Solana.** Una prueba de pago Solana es una firma de una
tx ya aterrizada: se puede presentar N veces y la cadena no objeta nada, porque no hay
nada que gastar por segunda vez. No hay backstop on-chain — es la misma propiedad que
`settle-ledger.ts:9-13` documenta para el leg de salida, sólo que del lado de la entrada.
Reusar este seam tal cual convierte un blip de DB en **servicio gratis ilimitado**. De ahí
CD-4.

---

## 2. Lo que YA EXISTE y hay que reusar (relevado, con archivo:línea)

| Pieza | Dónde | Qué aporta al leg de entrada |
|---|---|---|
| **Presencia on-chain de 5 estados** | `src/adapters/types.ts:170-187` (`SettlementPresence`) | **El tipo de tres valores que esta HU exige YA EXISTE.** `landed_ok` / `landed_failed` / `landed_mismatch` / `absent` / `unknown`, con exhaustividad forzada por el compilador. No hay que diseñarlo: hay que reusarlo (DT-2 / CD-3). |
| **El probe que lo produce** | `src/adapters/solana/payment.ts:572-644` (`probeSettlementPresence`) | `getSignatureStatuses(..., { searchTransactionHistory: true })` (`:580-582`) — la única fuente admitida para una determinación NEGATIVA. Traduce todo fallo a `unknown`, nunca lanza (`:570`). |
| **Validación de términos** | `src/adapters/solana/payment.ts:1101-1130` (`checkTerms`) | Puro, sin red. Valida mint + monto + destino leyendo `pre/postTokenBalances` (`:1114-1122`). **NO lee accounts de instrucción**, así que la validación de `reference` es código NUEVO, no reuso (MI-3). |
| **Ledger durable + doctrina** | `src/adapters/solana/settle-ledger.ts:15-39` | Las tres reglas (escritura condicional atómica en plpgsql, fail-closed, ninguna función devuelve `boolean`) son el molde exacto de la tabla de single-use del inbound. |
| **Migración de referencia** | `supabase/migrations/20260730000000_wkh307_solana_settle_intents.sql` | Aplicada en bdwv. Molde de forma y de gate de re-hidratación. |
| **Preflight de retención del RPC** | `src/adapters/solana/schema-preflight.ts` (~`:179`) | Fail-closed al arrancar si el nodo no retiene historia suficiente para afirmar "no está". El inbound tiene la MISMA dependencia (MI-5). |
| **Verificación 3-estados en el facilitator** | `wasiai-facilitator/src/methods/solana-payout/verify-transfer.ts:88-159` (`verifyPayoutSignature`) | Ya clasifica `confirmed` / `absent` / `indeterminate` sobre una tx aterrizada. Reusable **si** el testigo se mueve al facilitator; hoy Scope OUT (DT-1). |
| **Doctrina testigo vs tesorero** | `wasiai-facilitator/src/routes/solana-payout.ts:1-32` | *"`/settle` significa 'acá hay un pago que YA ocurrió; verificalo y registralo' — el facilitator es TESTIGO"*. El leg de entrada es exactamente el rol de testigo, y ese docstring prohíbe explícitamente meterlo como un modo de una ruta que gasta. |
| **Adapter Solana liquidando de verdad** | `src/adapters/solana/payment.ts` | Firma verificada en cadena el 2026-07-29 (`3pNqu9jHduGaXioB8Mf7WNvBgZQgJV4MnE6NDGWZdz6aY5gr2ivxfbwzrnweutSVtyKnvv7y7kXnARroktjyWsZx`, `err: None`, USDC de Circle). Dato heredado del encargo, no re-verificado acá. |
| **Canal de "resultado desconocido" del inbound EVM** | `src/middleware/x402.ts:674-730` (`emitInboundSettleUnknown`) | Log alertable con `error_code` estable **+** evento durable en `a2a_events`. El inbound Solana necesita el MISMO canal, no uno nuevo (AC-6). |

**Escrow Anchor y gasless / fee-payer propio del facilitator quedan fuera** (§6): en el
leg de entrada el que construye, firma, envía y paga el fee es el **pagador**, no nosotros.

---

## 3. La decisión de diseño que no puedo tomar yo

### 3.1 Por qué la pata de entrada invierte el problema

El proyecto viene persiguiendo un bug sistémico: *"no pude preguntar" leído como "no
pasó"*. En el leg de SALIDA el riesgo de ese colapso es **pagar dos veces**, y la asimetría
es fácil: no cobrar es recuperable, cobrar dos veces no. Por eso todo el rail de salida
fail-closea, y está escrito así (`settle-ledger.ts:29-34`).

En el leg de ENTRADA la asimetría **se da vuelta y deja de ser obvia**. Si no se puede
determinar si un pago llegó, las dos salidas son malas de formas distintas:

- **Entregamos el servicio gratis.** Cuesta plata NUESTRA: el gateway le paga a los
  sub-agentes desde la wallet del operador. Cota medida, no estimada: **1.9 USD por corrida**
  en el peor caso de `/orchestrate` (19 pasos pagables; `/compose` corta en 4) — el número lo
  midió WKH-306 (`doc/sdd/190-wkh-306-prepago-agentes-propios/`, fila `190` del índice).
  Automático, acotado por corrida, y en devnet no es plata real.
- **Rechazamos a alguien que pagó de verdad.** El pagador ya hizo un SPL transfer
  irreversible a nuestra `payTo`. Le retuvimos su plata y no le dimos nada. Recuperarlo
  exige un **reembolso manual** (una transferencia de salida) y mirada humana, igual que el
  destrabe del leg de salida (`doc/sdd/209-…/runbook-destrabe.md`). Y el daño reputacional
  cae justo sobre la audiencia de esta demo.

### 3.2 Lo que hace la comparación distinta de "cuál cuesta menos"

Las dos cotas de arriba son **por evento**. La pregunta honesta no es cuál error es más
barato, es **cuál error es más barato cuando un adversario elige cuál de los dos ocurre**.

- El servicio gratis es **repetible a voluntad** por quien pueda producir un
  `unknown` (una firma inverificable presentada en loop, un RPC degradado, la DB del
  single-use muda). 1.9 USD × 1000 requests no es 1.9 USD.
- El rechazo falso, en cambio, **no es explotable por un tercero**: nadie se beneficia de
  que rechacemos a un pagador legítimo. Es un daño de disponibilidad y de reputación, no un
  vector.

### 3.3 Un matiz que reduce el problema antes de decidir nada

Un rechazo por `unknown` **no tiene por qué ser permanente**. Si se deniega **sin consumir
la prueba**, la firma sigue siendo gastable y el pagador reintenta cuando el RPC vuelve a
contestar: el "rechazo falso" pasa de pérdida a demora. Eso disuelve el caso fácil (la
cadena no contesta).

El caso que **no** se disuelve es cuando lo indeterminado es el **store de single-use**:
ahí no sabemos si la prueba ya se gastó, y "reintentá después" arriesga servir dos veces un
mismo pago — que cae otra vez en el balde del servicio gratis. Ése es el borde real.

### 3.4 `[DECIDE FOUNDER]` — la pregunta, tal como se la vamos a presentar

> **Cuando el gateway NO puede determinar si un pago Solana llegó (o si esa prueba de pago
> ya se usó), ¿preferís que entregue el servicio o que lo rechace?**
>
> - **Rechazar sin consumir la prueba** (fail-closed): nadie recibe servicio sin pago
>   comprobado. El pagador legítimo reintenta y se le sirve cuando el sistema pueda volver a
>   preguntar; su plata no se pierde, se demora. Costo: durante una degradación del RPC o de
>   la DB, **pagadores reales se comen rechazos** — y si eso pasa en la demo, pasa delante de
>   los mentores.
> - **Entregar el servicio** (fail-open): ningún pagador legítimo queda afuera nunca. Costo:
>   quien pueda provocar un "no sé" obtiene servicio gratis **cuantas veces quiera**, a
>   ≤1.9 USD por corrida de nuestra wallet.
> - **Tercera opción, si preferís no elegir un extremo**: aceptar en un estado
>   `pendiente_de_verificación` — no se entrega nada todavía, no se consume la prueba, y
>   queda una fila donde reconciliarlo. Es más código y una superficie de operación nueva.
>
> **Por qué decidirlo AHORA aunque sea devnet y la plata no sea real**: lo que se fija con
> esta respuesta no son los dólares de devnet, es **la forma del código y la política que
> mainnet va a heredar**. Es la misma clase de decisión que el mínimo de 5 dólares: de
> negocio, no técnica.
>
> **Hasta que exista respuesta, el default que propone esta HU es rechazar sin consumir la
> prueba** — es el único que no se puede explotar, y es el que ya rige el resto del rail
> Solana. Si el founder decide otra cosa, es un cambio de política, no un bug.

### 3.5 El tipo de retorno — no es opcional

El resultado de la verificación inbound **no puede ser un `boolean` ni un `T | null`**. Ya
existe el tipo correcto y hay que reusarlo: `SettlementPresence`
(`src/adapters/types.ts:170-187`), cinco estados con exhaustividad forzada por el
compilador, donde `absent` ("el nodo buscó en su historia y no la conoce") y `unknown` ("no
pude preguntar") están **separados por diseño**. Su propio docstring
(`types.ts:132-168`) es la regla general del proyecto: *toda pregunta a un sistema externo
tiene tres respuestas — está / no está / no pude preguntar; si el tipo no tiene el tercero,
el tercero ya se perdió en el diseño.*

Ojo con un detalle que sí es nuevo: en el inbound hay **dos** preguntas indeterminables, no
una — la cadena (¿llegó?) y el store (¿ya se usó esta prueba?). Las dos necesitan su tercer
valor. Colapsar la segunda es exactamente el agujero del §1.3.

---

## 4. Acceptance Criteria (EARS)

- **AC-1** — WHEN un caller pide un endpoint cobrable con `x-payment-chain: solana-devnet` y
  sin prueba de pago, the system SHALL responder **402** con un challenge de forma Solana que
  incluya: red (`solana:<cluster>`), mint base58, monto en unidades atómicas del mint,
  `payTo` base58, una **referencia única por request** y una **expiración absoluta**.
- **AC-2** — WHEN un caller presenta una prueba cuya firma está en la cadena, lleva la
  referencia de ESE challenge, acredita ≥ el monto atómico requerido del mint configurado a
  la `payTo` del challenge, y no fue reclamada antes, the system SHALL conceder acceso y
  SHALL registrar el reclamo de forma durable antes de conceder.
- **AC-3** — WHEN la misma firma se presenta por segunda vez, the system SHALL denegar el
  acceso con un `error_code` estable propio de replay, SHALL NOT entregar servicio, y SHALL
  NOT depender de que el primer intento haya sido exitoso para detectarlo.
- **AC-4** — IF la transferencia aterrizada acredita **menos** que el monto atómico
  requerido, THEN the system SHALL denegar el acceso con un código distinguible de replay y
  de indeterminado, y SHALL NOT consumir la prueba.
- **AC-5** — IF la transferencia aterrizada acredita a un destinatario distinto de la
  `payTo` del challenge, o mueve un mint distinto del configurado, THEN the system SHALL
  denegar el acceso, SHALL NOT consumir la prueba, y SHALL NOT intentar ningún reembolso
  automático.
- **AC-6** — WHILE la cadena o el store de single-use no puedan responder, the system SHALL
  clasificar el resultado como `unknown` (nunca como `absent` ni como rechazo demostrado),
  SHALL emitir un registro durable de reconciliación que nombre la referencia y la firma
  —por el MISMO canal que el inbound EVM ya usa (`x402.ts:674-730`)— y SHALL aplicar la
  política elegida en `[DECIDE FOUNDER]` (§3.4); hasta que esa decisión exista, SHALL
  denegar sin consumir la prueba.
- **AC-7** — WHERE la chain resuelta es EVM, the system SHALL comportarse de forma
  byte-idéntica a hoy: mismos campos del challenge, mismos `error_code`, misma secuencia
  binding-check → `verify` → `settle` → re-verify on-chain.
- **AC-8** — WHEN se lee `GET /capabilities`, the system SHALL reportar
  `acceptsInboundPayment: true` para `solana-devnet` **si y sólo si** el camino de
  verificación inbound está cableado y habilitado en ese proceso.
- **AC-9** — WHILE el camino inbound Solana esté activo, the system SHALL NOT cargar,
  derivar ni usar ninguna clave privada Solana: el único acto irreversible del leg de
  entrada es del pagador.

---

## 5. Scope IN — un solo repo, un solo escritor

**Sólo `wasiai-a2a`.** Archivos/módulos previstos:

- `src/adapters/types.ts` — tipos del proof inbound. Reusa `SettlementPresence`.
- `src/adapters/solana/payment.ts` — expone la verificación inbound reusando
  `probeSettlementPresence` (`:572`) y `checkTerms` (`:1101`), + validación de `reference`
  (código nuevo, `checkTerms` no lee accounts de instrucción).
- `src/adapters/solana/inbound-claim.ts` (nuevo) — single-use fail-CLOSED, con la doctrina
  de `settle-ledger.ts:15-39`.
- `supabase/migrations/…_wkh314_solana_inbound_payments.sql` (nueva tabla + funciones
  plpgsql de escritura condicional atómica).
- `src/middleware/x402.ts` — rama Solana del challenge y de la verificación, **bifurcando
  antes** de `getPaymentAdapter()`.
- `src/adapters/registry.ts` — `acceptsInboundPayment` deja de ser el proxy
  `vmFamily === 'evm'` y pasa a ser una capacidad real del bundle.
- `src/services/compose.ts:1430-1462` — el guard `inboundVmUnsupported` gana la rama
  Solana-soportada.
- `src/adapters/solana/schema-preflight.ts` — extender la precondición de retención del RPC
  al inbound, si no la cubre ya (MI-5).
- Tests: nuevos + reescritura DELIBERADA de `src/middleware/x402.non-evm-inbound.test.ts`
  (sus expectativas se invierten por diseño para `solana-devnet`; **reescribir, no borrar**).
- Docs: `doc/INTEGRATION.md`, `doc/MULTI-CHAIN.md`.

---

## 6. Scope OUT (explícito)

1. **`wasiai-facilitator` — CERO cambios.** Regla de un escritor por repo, y además no hace
   falta para el corte: el gateway ya tiene `Connection` y el probe de 5 estados. Mover el
   testigo al facilitator (reusando `verifyPayoutSignature`,
   `verify-transfer.ts:88-159`, en una ruta dedicada como manda
   `solana-payout.ts:1-32`) es una **HU aparte, en ese repo, sin nada más escribiendo ahí**.
2. **Cerrar la pared B** (depósito prepago en Solana, §1.2) — HU separada. Ver MI-1: puede
   ser que sea ÉSTA la del camino crítico y no la pared A.
3. **Solana Pay QR / UX / SDK del lado del pagador.**
4. **Gasless / fee-payer para la tx del PAGADOR.** El pagador paga su propio fee.
5. **Escrow Anchor.** El leg de entrada es un SPL transfer directo a `payTo`.
6. **Reembolso automático** de un pago capturado y no servido: runbook manual.
7. **mainnet.** devnet-only, sin slug `-mainnet` (espeja CD-4 de WKH-234).
8. **Reusar `a2a_x402_nonces` / `checkAndRecordX402Nonce`** para la prueba Solana: prohibido
   por CD-4.
9. **Cambiar el modo de pago de los 3 agentes remit-\*** (hoy ratificado a2a-key prepago).

---

## 7. El corte mínimo, y el corte que se descartó

### 7.1 Lo que NO entra en la semana del 03/08

El leg de entrada completo son, como mínimo: challenge Solana + referencia + verificación de
3 (5) estados + single-use fail-closed con migración + flip de la capacidad pública +
rama en `compose` + ruta testigo en el facilitator + SDK/QR del pagador + docs. Bajo el
pipeline QUALITY (F2 → SPEC_APPROVED → F2.5 → F3 → AR → CR → F4, con fix-packs y pruebas de
mutación, que es lo que costaron WKH-306 y WKH-307 esta misma semana), **no entra**. Decirlo
ahora es más barato que descubrirlo el 06/08.

### 7.2 Corte mínimo propuesto — "el gateway como TESTIGO" (una HU, un repo)

Challenge Solana honesto (AC-1) + verificación de 5 estados reusando lo que ya existe
(AC-2/4/5/6) + single-use durable fail-closed (AC-3) + flip real de la capacidad (AC-8) +
rama en `compose` + EVM byte-idéntico (AC-7). Nada de facilitator, nada de SDK, nada de
gasless, nada de escrow.

**Por qué esto no deja el money-path a medias**, que es la objeción correcta:

- El gateway **no gana ninguna capacidad nueva de mover plata** en la entrada (AC-9 / CD-2).
  El único acto irreversible del leg lo hace el pagador con su propia wallet y su propio
  fee.
- Lo que sí puede fallar es un **grant equivocado**, que hace mover fondos en el leg de
  salida (≤1.9 USD/corrida medidos por WKH-306). En **devnet** eso no es plata real — y ése
  es precisamente el lugar donde conviene aprender la política antes de mainnet.
- El único agregado que **no** se puede recortar de este corte es el single-use fail-closed.
  Sin él, una prueba se presenta N veces y son N servicios gratis.

**Qué ve la incubadora**: una firma de devnet que los mentores pueden pegar en Solana
Explorer, hecha por un tercero con su propia wallet, verificada por el gateway contra la
cadena, y honrada exactamente una vez. Es uso real de tecnología Solana y es demostrable en
30 segundos.

### 7.3 Corte DESCARTADO — "sólo el 402 intent"

Emitir el challenge Solana y publicar `acceptsInboundPayment: true` **sin** la verificación
(era el alcance literal de "402 intent" de la HU-SOL-F3 original). Se descarta: sería
anunciar públicamente un pago que no podemos verificar. Cualquiera que lo tome recibe
servicio sin pago comprobado, o ninguno. **Eso es exactamente un arreglo a medias en el
camino del dinero**, y encima con un contrato público mintiendo (rompe AC-8).

---

## 8. Decisiones técnicas (DT-N)

- **DT-1** — La verificación vive en `wasiai-a2a`, **no** en el facilitator, para este
  corte. Justificación: a2a ya tiene la `Connection`, el probe de 5 estados
  (`payment.ts:572`) y la validación de términos (`payment.ts:1101`); mover el testigo al
  facilitator es una ruta net-new en un segundo repo (rompe un-escritor-por-repo y duplica
  el pipeline). Reversible: una HU posterior mueve el testigo detrás de la misma interfaz.
- **DT-2** — Se reusa `SettlementPresence` (`types.ts:170-187`) en vez de inventar un tipo
  inbound. El estado de la pregunta es el mismo; lo que cambia es quién pagó.
- **DT-3** — El single-use se clavea en la **firma** de la tx (única globalmente en Solana);
  la **referencia** es la que ata la prueba a ESTE challenge. Son dos propiedades distintas
  y van en dos columnas distintas: sin referencia, cualquier transferencia vieja a la misma
  `payTo` por el mismo monto valida.
- **DT-4** — La rama inbound Solana **no pasa** por `getPaymentAdapter()`
  (`registry.ts:414-422` lanza a propósito). La bifurcación va antes, sobre el bundle.
- **DT-5** — `acceptsInboundPayment` pasa a ser una capacidad real por bundle, conservando
  la propiedad que HU-204 estableció: **una sola definición**, consumida por el guard del
  middleware y por `/capabilities`, para que no puedan divergir.

---

## 9. Constraint Directives (CD-N)

- **CD-1** — **OBLIGATORIO: el camino EVM queda byte-idéntico.** Mismos status, mismos
  `error_code`, mismos campos del challenge, misma secuencia. Prueba: las suites
  `x402.binding` / `x402.chain-aware` / `x402.challenge-amount` / `x402.settle-unknown` /
  `x402.settle-reverify` / `x402.dual-header` / `x402.passport-shape` quedan verdes **sin
  modificarse**. Única excepción declarada: `x402.non-evm-inbound.test.ts`, cuyas
  expectativas se invierten por diseño para `solana-devnet` y se **reescriben**.
- **CD-2** — **PROHIBIDO** que el camino inbound firme o transmita nada, y **PROHIBIDO** que
  alcance una clave privada Solana. El único efecto irreversible del leg es del pagador.
- **CD-3** — **PROHIBIDO** un `boolean` o un `T | null` en cualquier eslabón de la cadena de
  verificación inbound. Se reusa `SettlementPresence`; un tipo nuevo se admite sólo si tiene
  ≥3 estados y el compilador fuerza la exhaustividad.
- **CD-4** — **PROHIBIDO** reusar `a2a_x402_nonces` / `checkAndRecordX402Nonce`
  (`x402-nonce.ts:31-53`) para la prueba Solana. Falla ABIERTO por diseño explícito
  (`:41-51`) y su justificación —el nonce EIP-3009 es single-use on-chain— es **falsa en
  Solana**. El single-use inbound es tabla propia, durable, **fail-CLOSED**, con escritura
  condicional atómica (doctrina `settle-ledger.ts:15-39`).
- **CD-5** — **OBLIGATORIO devnet.** Sin slug `-mainnet`, sin RPC de mainnet, sin plata
  real. Espeja CD-4 de WKH-234.
- **CD-6** — **PROHIBIDO** publicar `acceptsInboundPayment: true` mientras la verificación
  no esté cableada y habilitada. Es un contrato público sobre el que un tercero va a actuar.
- **CD-7** — **OBLIGATORIO** que el challenge lleve referencia única por request **y**
  expiración absoluta, y que las dos se validen del lado del servidor. Un challenge que se
  satisface con una transferencia de ayer no es un pago por este request.
- **CD-8** — **OBLIGATORIO** entrar por el canal de "resultado desconocido" que ya existe
  (`x402.ts:674-730`: log con `error_code` estable **+** evento durable en `a2a_events`).
  **PROHIBIDO** inventar vocabulario nuevo para lo mismo.

---

## 10. Missing Inputs

- **MI-1 `[bloqueante]` `[NEEDS CLARIFICATION]`** — **¿El pagador de la demo (Chaski o quien
  sea) va a pagar por x402, o con clave prepaga?** Decide si esta HU saca a Avalanche del
  flujo **o no saca nada**: el camino prepago no se puede fondear en Solana (§1.2,
  `deposit-verifier.ts:82-86`, `deposit.ts:57-65`), y el modo ratificado de los 3 agentes
  remit-\* es a2a-key prepago (filas 167/169/170 del índice). Si la demo paga prepago, la HU
  del camino crítico es la **pared B**, no la A. *No pude determinarlo desde este repo:
  requiere mirar `chaski-v3`.*
- **MI-2 `[bloqueante]`** — La política de `unknown` del §3.4 (`[DECIDE FOUNDER]`).
- **MI-3 `[resolver en F2]`** — ¿La referencia viaja como cuenta extra en la instrucción de
  transferencia (convención Solana Pay) o como memo? Las dos son verificables, pero por
  lecturas de RPC distintas. Verificado: `checkTerms` (`payment.ts:1114-1122`) lee **sólo**
  `pre/postTokenBalances` y ningún account de instrucción ⇒ esto es código nuevo.
- **MI-4 `[resolver en F2]`** — Flag propio del inbound: nombre, default (OFF), y si se
  ANDea con `SOLANA_ADAPTER_ENABLED` (hoy default `false`).
- **MI-5 `[resolver en F2]` — no pude determinarlo** — El preflight de retención del RPC de
  WKH-307 (`schema-preflight.ts`, ~`:179`) fail-closea si el nodo no retiene historia. **No
  verifiqué** si cubre ya el inbound o si es específico del settle. El inbound tiene la misma
  dependencia: sin retención, `absent` no se puede afirmar.
- **MI-6 `[escalar al humano]`** — **`.nexus/project-context.md` contradice el código.**
  Dice `Última actualización: 2026-03-31 | Versión: 0.1.0`, describe un stack Kite-only, no
  menciona Solana, Base, Tempo, el facilitator ni `@solana/web3.js`, y afirma *"Lib: viem v2
  — PROHIBIDO ethers.js"* como si toda la cadena fuera EVM. **No lo modifiqué** (fuera de mi
  alcance de escritura). Un sub-agente que lo tome como fuente de verdad va a decidir mal en
  esta HU.
- **MI-7 `[NEEDS CLARIFICATION]`** — *"No debe intervenir Avalanche"*: ¿sólo el dinero, o
  también la identidad? La identidad ERC-8004 de `remit-kyc-validator` está anclada a
  Avalanche por WKH-237 (fila 183 del índice). La identidad no es plata, pero si los
  colaboradores leen el agent card, van a ver Avalanche.

---

## 11. Análisis de dependencias y de paralelismo

### 11.1 Contra la migración del agente de KYC a Solana

- **No hay dependencia de código en ninguna dirección.** El leg de entrada es
  caller→gateway; que el agente de KYC sea Solana-native o no afecta al leg de
  **salida**, que ya es Solana-capable y verificado. Se pueden hacer en paralelo, y por
  archivos distintos.
- **Sí hay dependencia del ENTREGABLE**, y es la que importa para el compromiso: *"los 3
  agentes del pipeline de Chaski se cobran en Solana"*. Según la evaluación profunda del
  2026-07-24, **Chaski no invoca al KYC como agente**: va directo a Didit, y la HU que lo
  rutearía por agente (`WKH-233`) figura **bloqueada**. Ese dato tiene 5 días y **no lo pude
  verificar** en este repo (no hay `doc/sdd/` para WKH-233): tratarlo como hipótesis a
  confirmar, no como hecho.
- Consecuencia: **esta HU es necesaria pero no suficiente** para el entregable de los 3
  agentes. Si el KYC no pasa por el riel a2a, sólo 2 de los 3 se cobran por el gateway,
  independientemente de la pata de entrada.
- **Bloqueo real, si aparece**: si la migración del KYC a Solana toca
  `discovery.ts` / `payment-spec-reader.ts` (los seams de WKH-241 / WKH-237), no choca con
  esta HU. Si tocara `compose.ts:1430-1462`, sí choca — es exactamente el bloque que esta HU
  modifica.

### 11.2 Riesgo de conflicto de merge (mirado, no supuesto)

- **`fix/p1-discover-reputation-402-cap` (fila 189) está ABIERTA**: `F3 DONE + fix-pack AR
  it2 (pendiente re-AR/CR/F4)`, y tocó el monto atómico del challenge 402 en los 5 adapters
  (`usdToAtomicUnits`) y la superficie del challenge. **Riesgo alto** de conflicto con la
  rama de esta HU en `middleware/x402.ts`. Recomendación: esperar su merge, o coordinar el
  orden.
- WKH-308 y WKH-307 ya están mergeadas (`fe4f654`, `c92330a`), así que
  `src/adapters/solana/payment.ts` está quieto. Bien.
- **Puede ir en paralelo con**: WKH-313 (fila 211, discovery/reputación — archivos
  disjuntos) y WKH-307b (ops puro: aplicar migración a caldz).
- **No puede ir en paralelo con**: cualquier HU que escriba `wasiai-facilitator`, si en algún
  momento se decide mover el testigo allá (§6.1). Un escritor por repo.

### 11.3 ¿Esta HU bloquea a otras?

Sí a dos: (a) cualquier demo que exija que la entrada de plata sea Solana-only; (b) el
cierre honesto del claim *"el pipeline de Chaski se cobra en Solana sin Avalanche"*, que
además necesita MI-1 resuelto y, según cómo se resuelva, la **pared B**.

---

## 12. Definition of Ready — estado

| Requisito | Estado |
|---|---|
| ACs en EARS, ≥5, sin lenguaje vago | ✅ 9 ACs |
| Scope IN / OUT explícito | ✅ §5 / §6 |
| Sizing decidido | ✅ QUALITY · full · L · corte mínimo en §7.2 |
| Tipo de retorno de 3+ valores definido desde el diseño | ✅ DT-2 / CD-3 (reusa `SettlementPresence`) |
| Decisión de negocio aislada y NO tomada por el agente | ✅ §3.4 `[DECIDE FOUNDER]` |
| Bloqueantes abiertos | ⚠️ MI-1 y MI-2. **MI-1 puede cambiar cuál es la HU correcta.** |
