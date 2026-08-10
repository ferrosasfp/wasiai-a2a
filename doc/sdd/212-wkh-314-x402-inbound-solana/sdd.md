# SDD — [WKH-314] La pata de ENTRADA de pagos en Solana (x402 inbound)

**Fase**: F2 (SDD) · **Gate cumplido**: `HU_APPROVED`
**Repo**: `wasiai-a2a` · **Worktree**: `/home/ferdev/.openclaw/workspace/wt-314`
**Rama**: `feat/212-wkh-314-x402-inbound-solana` (creada desde `main@6b391d6`)
**Input**: `doc/sdd/212-wkh-314-x402-inbound-solana/work-item.md` (493 líneas, 9 ACs EARS)
**Fecha de verificación del código**: 2026-07-29
**SDD_MODE**: full · **Estimación**: L · **Devnet-only, sin excepción**

---

## 0. Resolución de los Missing Inputs del work-item

| MI | Estado en F2 | Resolución |
|---|---|---|
| MI-1 `[bloqueante]` | **RESUELTO por el founder** | **Las dos paredes se abren.** Pared A = esta HU. Pared B = **WKH-315**, en paralelo, worktree `wt-315`, rama propia. |
| MI-2 `[bloqueante]` | **RESUELTO por el founder** | **Rechazar, SIN consumir la prueba.** Razonamiento en §2. Aplica aunque sea devnet: lo que se fija es la forma del código que mainnet hereda. |
| MI-3 `[resolver en F2]` | **RESUELTO** → DT-6 | Referencia como **cuenta extra read-only** (convención Solana Pay), verificada sobre la firma que el pagador YA nos entrega. Memo descartado (DT-6). |
| MI-4 `[resolver en F2]` | **RESUELTO** → DT-11 | `SOLANA_X402_INBOUND_ENABLED`, default `false`, **ANDeado** con `SOLANA_ADAPTER_ENABLED` y con la completitud de configuración. |
| MI-5 `[no pude determinarlo]` | **RESUELTO con una corrección** | El work-item y el encargo dicen que `probeRpcHistoryRetention` es "genérico y consumible". **Es genérico de cuerpo, pero NO es consumible: es `private` y sólo se alcanza a través de `ensureSolanaSchemaReady()`, que antes exige que la tabla del settle OUTBOUND resuelva** (`schema-preflight.ts:211-226`: el `case 'ok'` de `probeSettleLedger()` es la única puerta al chequeo de retención). Ver DT-9: esta HU es la dueña de exportarlo. |
| MI-6 `[escalar al humano]` | **RESUELTO** | `.nexus/project-context.md:667` dice `2026-07-29 | Versión: 0.2.0` y §"Blockchain: hay DOS familias de VM" (`:117-124`) ya describe el stack real. Es fuente de verdad confiable. |
| MI-7 `[NEEDS CLARIFICATION]` | **FUERA DE ALCANCE de esta HU** | Identidad ERC-8004 anclada a Avalanche. Esta HU no toca identidad ni agent cards. Se deja abierto al founder; no bloquea. |
| Riesgo de merge fila 189 | **FALSO** (verificado) | `usdToAtomicUnits` ya está en `main`: `src/adapters/solana/payment.ts:7,260` y `src/adapters/base/payment.ts`. Nada que esperar. |

---

## 1. Context Map — qué leí, por qué, y qué patrón extraje

Todos los paths verificados con `ls`/`Read` sobre el árbol real. Cero rutas inferidas.

| Archivo (verificado) | Por qué lo leí | Patrón / hecho extraído |
|---|---|---|
| `src/middleware/x402.ts` (892 líneas) | Es la pared A real | El corte non-EVM está en `:479-497`; el header de chain se setea en `:512`; el binding EVM en `:545-591`; el canal `unknown` en `:674-730`; el fin del handler en `:882-891`. **La bifurcación Solana entra entre `:512` y `:514` y no toca una sola línea EVM aguas abajo.** |
| `src/adapters/registry.ts:414-422, 494-525` | Dónde vive el veto | `getPaymentAdapter()` **lanza** sobre non-EVM (`:416-420`); `acceptsInboundPayment` es una línea (`:510-512`); `getInboundPaymentChainKeys()` la consume (`:520-525`). Una sola definición ⇒ DT-5 del work-item se cumple gratis. |
| `src/adapters/solana/payment.ts:557-644` | El probe de presencia | `probeSettlementPresence` es **`private`**, jamás lanza (`:570`), y usa `getSignatureStatuses(..., searchTransactionHistory:true)` (`:580-582`) como única fuente de negativa. `null` tras búsqueda ⇒ `absent` (`:600`). |
| `src/adapters/solana/payment.ts:1093-1130` | La validación de términos | `checkTerms` es **puro, sin red**, lee `pre/postTokenBalances` (`:1114-1122`) y usa el mint **CONFIGURADO** (`getSolanaUsdcMint()`, `:1109`), no el del proof. **Usa `.find()`, no una suma** (`:1116-1121`) → ver DT-8, es una fuente de falso rechazo. |
| `src/adapters/solana/payment.ts:176-194, 251-267` | Superficie común del adapter | `getMint()`, `getScheme()`, `getNetwork()` (devuelve el CAIP-2, `:185`), y `quote()` que ya delega en `usdToAtomicUnits` (`:260`). **El challenge Solana se puede armar sin inventar nada.** |
| `src/adapters/types.ts:129-207, 209-245` | El tipo de 3 (5) valores | `SettlementPresence` (`:170-187`) con su docstring-doctrina (`:132-168`). `SolanaSettleProof` (`:124-128`). `SolanaPaymentAdapter` (`:209-243`). `PaymentAdapter` es unión discriminada (`:245`). |
| `src/adapters/solana/settle-ledger.ts:1-130` | La doctrina del store | Las 3 reglas (`:15-39`): escritura condicional atómica en plpgsql, fail-closed, **ninguna función devuelve `boolean`**. Y el **boundary CD-7** (`:40-45`): *"este es el ÚNICO archivo de `src/adapters/solana/**` que importa `lib/supabase.js`"*. ⇒ DT-7. |
| `supabase/migrations/20260730000000_wkh307_solana_settle_intents.sql:149-305` | El molde de la migración | Tabla con PK que hace atómico el reclamo (`:150`); `amount_atomic TEXT` **nunca NUMERIC** (`:153-154`, WKH-196); `REVOKE ALL` + `GRANT` a `service_role` (`:198-199`); `INSERT … ON CONFLICT DO UPDATE … WHERE … RETURNING` como una sola sentencia (`:245-271`); clasificación del perdedor en un `SELECT` que **no puede autorizar** (`:273-301`); `p_probe` con `RAISE EXCEPTION` como primera sentencia (`:239-243`). |
| `supabase/migrations/20260529000000_a2a_key_deposits.sql:16-18, 71-79` | El patrón que no puede fallar abierto | `CONSTRAINT uq_a2a_key_deposits_chain_tx UNIQUE (chain_id, tx_hash)` + `EXCEPTION WHEN unique_violation THEN RAISE` **antes** de acreditar. Reclamo antes de acreditar, garantizado por el motor. |
| `src/services/x402-nonce.ts:1-53` | El anti-replay que NO sirve | Falla ABIERTO en `:39-51` con la justificación escrita en `:9-13` (el nonce EIP-3009 es single-use on-chain). **Falso en Solana** ⇒ CD-4 del work-item, honrado en CD-4 de acá. |
| `src/adapters/solana/schema-preflight.ts` (286 líneas) | La precondición de retención | `probeRpcHistoryRetention` (`:166-208`) es `private` y sólo se alcanza desde `probeSolanaSchema` (`:211-226`) **después** de que `probeSettleLedger()` diga `ok`. Cache single-flight en `ensureSolanaSchemaReady` (`:240-275`). `BLOCKHASH_VALIDITY_SLOTS = 150` (`:106`). Salida explícita `SOLANA_RPC_LEDGER_HISTORY_DECLARED_SUFFICIENT` (`:120`). |
| `src/adapters/solana/chain.ts` (109 líneas) | Config y conexión | `getSolanaConnection()` es un singleton de proceso que lee **sólo `SOLANA_RPC_URL`** (`:39-41, 73-77`). `getSolanaOperatorKeypair()` (`:84-100`) es el único punto que toca la llave privada. |
| `src/adapters/deposit-verifier.ts:70-87, 176-178` | Dónde se NOMBRA el fallback | `rpcFallbackEnvVar('solana-devnet')` **devuelve el string** `'SOLANA_RPC_URL_FALLBACK'` pero es el resolver del deposit-path **viem**, y su propio comentario (`:82-84`) dice que para Solana es **código muerto**. |
| `src/services/compose.ts:1430-1534, 1588-1625` | El supuesto "pared A" del §1.1 | **CORRECCIÓN MATERIAL — ver §3.** Ese guard NO es el leg caller→gateway. |
| `src/routes/capabilities.ts:31-60` | El contrato público | `acceptsInboundPayment(bundle)` publicado por chain (`:57-58`). Cambio aditivo de HU-204. AC-8 se cumple con una sola definición. |
| `src/services/event.ts:50-90` | El canal durable | `eventService.track({ eventType, status, metadata })` inserta en `a2a_events` y **TIRA si el insert falla** (`:88`) ⇒ siempre fire-and-forget con `.catch()`. |
| `src/types/index.ts:1006-1054` | La forma del sobre x402 | `X402PaymentPayload` / `X402Response` / `X402PaymentRequest`. **`decodeXPayment` (`x402.ts:359-382`) sólo exige `authorization: object` + `signature: string`** ⇒ el sobre Solana entra sin tocar el decoder. |
| `programs/escrow/src/lib.rs` en `/home/ferdev/.openclaw/workspace/solana-programs` + `Anchor.toml:14-18` | Medir la opción (b) | Programa devnet `DR5GoMT7sAKzD6wZMKJPeknS3Y6fzgZUNevi7xiESE4x`. Instrucciones: `deposit`, `release`, `refund`, `close`, `register_escrow`, `deregister_escrow`. Seeds `["escrow", sender, remittance_id]` (`:270, :310`); el vault tiene `associated_token::authority = escrow_state` (`:279, :322`). **No hay ninguna instrucción de barrido de una cuenta arbitraria.** |
| `src/middleware/x402.{binding,chain-aware,challenge-amount,settle-unknown,settle-reverify,dual-header,passport-shape,non-evm-inbound}.test.ts` | La prueba de CD-1 | Los 8 archivos existen (verificado uno por uno). `non-evm-inbound.test.ts` inicializa `WASIAI_A2A_CHAINS='base-sepolia,solana-devnet'` (`:233`) y afirma que `getPaymentAdapter('solana-devnet')` lanza (`:254-255`). |
| `src/routes/capabilities.inbound-chains.test.ts:118` | Guardián de AC-8 | Setea `SOLANA_ADAPTER_ENABLED=true` y afirma `acceptsInboundPayment:false` para Solana. **Sigue verde con el flag nuevo en OFF.** |
| `.env.example:965-999` | Config Solana existente | `SOLANA_RPC_URL_FALLBACK=` está documentada como `# opcional` (`:969`) y **no la lee nadie**. No existe ninguna variable con la wallet Solana **receptora** (sólo la privada del operador, `:973`). |
| `.nexus/project-context.md:75-124, 667` | Stack | v0.2.0, dos familias de VM, Fastify 5, vitest, biome, TS strict, Supabase bdwv. Sin Redis en este repo. |

### Auto-Blindaje histórico leído (paso obligatorio)

`doc/sdd/_INDEX.md` + las HUs DONE más recientes. **Los 4 archivos que existen**:
`209-wkh-307…/auto-blindaje.md`, `208-compose-por-capacidad/auto-blindaje.md`,
`203-compose-refund-broadcast-evidence/auto-blindaje.md`, `202-hop2-lease/auto-blindaje.md`.
(`210-wkh-308…` y `211-wkh-313…` no tienen auto-blindaje todavía.)

**Patrones recurrentes (≥2 HUs) que se convirtieron en Constraint Directives**:

| Patrón recurrente | Evidencia | CD que lo previene |
|---|---|---|
| **Falso KILLED en mutación**: la suite se pone roja sin haber probado nada | WKH-307 W4 (`no tests` por un `throw` en el cuerpo del `describe`); HU-208 W3 (M5 sobrevivió: el test medía el efecto observable y no el costo); HU-208 W3 (test cuyo setup hacía imposible la propiedad) | **CD-10** |
| **Dos expresiones separadas para el mismo valor de dinero** | HU-208 W2 (`refundComposeStep0` vs `resolveStep0DebitUsd`: caller cobrado y sin reembolso) | **CD-11** |
| **Fixtures que "parecen del tipo correcto" y funcionan por casualidad** | WKH-307 W3 (blockhash de 32 CARACTERES en vez de 32 bytes; `secretKey` de 64 ceros que dejó de alcanzar al serializar) | **CD-12** |
| **git destructivo sobre trabajo sin commitear durante la mutación** | HU-203 (`git checkout --` se llevó 160 líneas del fix) | **CD-13** |
| **Un `_down` que preserva datos sin re-hidratar** | WKH-307 (gate `WKH307_BACKUP_NOT_REHYDRATED`) | **CD-14** |

---

## 2. La política ante `unknown` — decidida, y por qué

**Decisión del founder: RECHAZAR, SIN CONSUMIR LA PRUEBA.** El SDD la implementa y la
argumenta así, porque el argumento es lo que sobrevive a mainnet:

No es *"cuál error cuesta menos"*. Es **cuál error cuesta menos cuando un adversario elige
cuál de los dos ocurre**.

- **Servicio gratis** es **repetible a voluntad** por cualquiera que pueda producir un
  `unknown`. La cota por corrida está medida (1.9 USD, WKH-306), pero la cota del **ataque**
  es 1.9 USD × el número de veces que el adversario quiera. No hay techo.
- **Rechazo falso** no es explotable por un tercero: nadie se beneficia de que rechacemos a
  un pagador legítimo. Es daño de disponibilidad, no un vector.

Y el rechazo deja de ser una pérdida porque **no consume la prueba**: la firma sigue siendo
gastable y el pagador reintenta con **la misma firma**, sin pagar de nuevo. **Rechazar sin
consumir no es una negativa, es un aplazamiento.** De ahí las tres mitigaciones (DT-9,
DT-10, DT-12) que hacen que el aplazamiento se resuelva solo.

El borde que el work-item identificó bien (§3.3): cuando lo indeterminado es el **store**,
"reintentá después" arriesgaría servir dos veces. **Ese borde se cierra por construcción**,
no por política: el consumo es una escritura condicional atómica contra una PK de Postgres
(DT-7), así que un store que no responde produce un **`unknown` del store** ⇒ se rechaza sin
consumir, y el reintento vuelve a competir por la misma PK. Nunca hay un camino en que dos
requests ganen el mismo consumo.

---

## 3. Corrección material al work-item: `compose.ts` NO es la pared A

El work-item §1.1 y §5 dicen que `src/services/compose.ts:1430-1462` es parte de la pared
A del x402 **inbound** y que "gana la rama Solana-soportada". **Leído el código, no lo es.**

Evidencia:

- `compose.ts:1509-1518` — dentro de la rama `!inboundVmUnsupported`, el código hace
  `getPaymentAdapter().sign({ to: payToEvm, value: valueWei })`, donde `payToEvm` es
  **el `payTo` DEL AGENTE** (`:1440-1457`) y `valueWei` sale de `agent.priceUsdc`.
- `compose.ts:1621-1625` — ese `paymentRequest` lo settlea **el gateway mismo**
  (`getPaymentAdapter().settle(...)`), pagándole al agente.
- `compose.ts:1519-1533` — el comentario C2 aclara que la autorización **no se le reenvía**
  al agente, justamente para que no la redima él.
- `compose.ts:1483-1490` — *"The Solana agent fee is settled operator-side in the DOWNSTREAM
  leg (`signAndSettleDownstream`), **not here**"*.

O sea: `inboundVmUnsupported` gobierna el leg **gateway → agente** usando la maquinaria
EIP-3009 sobre la chain default del gateway. **El leg caller → gateway de esta HU no pasa
por ahí en ningún punto.** El único corte del leg de entrada es `x402.ts:479-497`
(vía `acceptsInboundPayment`).

**Consecuencia**: `src/services/compose.ts` **sale del Scope IN**. Esto (a) reduce el
alcance, (b) elimina el conflicto de merge que el work-item §11.2 temía, y (c) **protege
CD-1**: no se toca un archivo del money-path EVM que no hacía falta tocar.

El work-item §7.2 ("el gateway como TESTIGO") sigue siendo la base del corte mínimo; lo
único que cambia es que **la "rama en `compose`" se elimina del corte** por esta evidencia.

---

## 4. La decisión de mecanismo: (a) destino compartido + referencia vs (b) destino único por pago

### 4.1 Los números de la opción (b), medidos hoy contra devnet

Medidos con `getMinimumBalanceForRentExemption` contra `https://api.devnet.solana.com`
(2026-07-29) y precio spot de SOL de dos fuentes independientes
(Coinbase `73.465`, Binance `73.57` USD):

| Magnitud | Medido | En USD (SOL = 73.465) |
|---|---|---|
| Renta mínima de una cuenta SPL de token (165 bytes) | **2 039 280 lamports = 0.00203928 SOL** | **0.14982 USD** |
| Renta mínima de una cuenta de sistema (0 bytes) | 890 880 lamports = 0.00089088 SOL | 0.06545 USD |
| Fee de una transacción de 1 firma | 5 000 lamports | 0.00037 USD |
| **Renta de UNA cuenta de token / fee de referencia de 0.03 USD** | — | **4.99× — la renta cuesta CINCO VECES el cobro** |

Y la retención del RPC público, también medida (`getSlot` = 479 892 445,
`getFirstAvailableBlock` = 478 997 073):

| Magnitud | Medido |
|---|---|
| Ventana de historia retenida por `api.devnet.solana.com` | **895 372 slots ≈ 4.15 días** (a 400 ms/slot) |
| Umbral que el código ya exige (`BLOCKHASH_VALIDITY_SLOTS`) | 150 slots ≈ 60 s |

### 4.2 La mecánica del barrido de la opción (b) — medida, no estimada

Para que el pagador haga una **transferencia SPL estándar** a un destino derivado de la
intención, ese destino tiene que ser una **cuenta de token** ya existente cuya autoridad
sea una PDA nuestra. Eso obliga a tres cosas, y las tres tienen un costo verificado:

1. **La cuenta hay que crearla y pagarla.** 0.14982 USD por intención. Recuperable **sólo
   cerrándola**, y cerrarla exige `CloseAccount` firmado por la autoridad ⇒ una instrucción
   de programa.
2. **El programa deployado NO puede barrerla.** Leído `programs/escrow/src/lib.rs`: las
   únicas instrucciones son `deposit`, `release`, `refund`, `close`, `register_escrow`,
   `deregister_escrow`; `release`/`refund` operan sobre un `escrow_state` derivado de
   `["escrow", sender, remittance_id]` (`:270, :310`) que **sólo existe si antes se llamó
   `deposit`** — que es exactamente lo que la opción (b) quiere evitar. **Conclusión: la (b)
   exige una instrucción NUEVA en `solana-programs` + un deploy a devnet.** Eso es un
   segundo repo escribiéndose y un deploy on-chain en la semana de la demo. Rompe
   "un escritor por repo" y agrega un artefacto binario al camino crítico.
3. **Quien paga la renta rompe algo, sí o sí.**
   - Si la paga **el pagador**: 0.15 USD de sobrecargo sobre un cobro de 0.03 USD (**+499 %**).
     Mata el argumento entero de la opción, que era la interoperabilidad.
   - Si la paga **el gateway**: crear la cuenta es **firmar y transmitir una transacción**
     en el leg de entrada ⇒ **viola AC-9 y CD-2 directamente** (*"el único acto irreversible
     del leg de entrada es del pagador"*).
4. **Riesgo adicional que NO pude determinar**: una PDA es off-curve por construcción, y la
   ATA de una PDA requiere `allowOwnerOffCurve: true`. **No pude determinar** si Phantom /
   Solflare / Backpack aceptan un "enviar USDC a esta dirección" cuando el destino es una
   cuenta de token cuya autoridad es off-curve. Se mide instalando la wallet y probando en
   devnet; no es verificable desde este entorno.

### 4.3 El costo real de la opción (a), medido en vez de temido

El argumento contra la (a) es que preguntar *"¿ocurrió esta transacción?"* se responde en
el **historial**, que se poda. Medido, en este leg eso **no aplica**:

- La prueba que verificamos es **fresca por construcción**: el challenge tiene expiración
  absoluta (CD-7) del orden de minutos, así que la firma tiene segundos o minutos de vida
  cuando la preguntamos. La ventana retenida medida es de **4.15 días** — cuatro órdenes de
  magnitud de margen.
- Es **la misma pregunta, a la misma distancia**, que el leg de salida ya hace hoy y que su
  preflight ya protege (`schema-preflight.ts:166-208`, umbral 150 slots ≈ 60 s).
- **Y no hay búsqueda**: el pagador nos **entrega la firma** en el header. No hacemos
  `getSignaturesForAddress` sobre ninguna referencia. Es un `getSignatureStatuses` sobre una
  firma conocida. La objeción "buscar en el historial es frágil" se aplica a *descubrir* una
  transacción, no a *verificar* una que ya nos nombraron.

Lo que sí queda de la (a) es la **limitación por tasa** del RPC, y contra eso va la
mitigación de doble proveedor (DT-10).

### 4.4 Decisión — DT-1: **opción (a)**, destino compartido + referencia por pago

**Elegimos (a).** Los tres números que la sostienen:

1. **4.99×** — la renta de la (b) cuesta cinco veces el cobro que habilita, por pago.
2. **Cero instrucciones existentes** sirven para el barrido: la (b) exige un deploy nuevo en
   un segundo repo. Medido leyendo el programa, no supuesto.
3. **4.15 días vs minutos** — la fragilidad que la (b) venía a resolver no está presente en
   este leg: el margen de retención medido es de cuatro órdenes de magnitud.

Y el criterio de fondo, que es el mismo que descartó la (c): **ajustar el mecanismo al monto
y al riesgo.** Una cuenta de depósito por factura es el patrón correcto cuando la factura
justifica 0.15 USD de capital inmovilizado y una instrucción de barrido; para 3 centavos, no.

La (b) queda registrada como **la evolución natural cuando el monto crezca** (el principal
de una remesa, no el fee de una llamada), con los dos costos ya medidos para que la próxima
HU no los tenga que volver a medir.

**(c) escrow para todo: descartada** — ya venía descartada por el orquestador con argumento
(rompe interoperabilidad: el pagador necesitaría nuestro IDL) y el código lo confirma: la
instrucción `deposit` del programa es una llamada Anchor con cuentas específicas
(`lib.rs:258-293`), no una transferencia SPL. El escrow queda para el principal de la remesa.

---

## 5. Decisiones técnicas (DT-N)

- **DT-1 — Mecanismo: destino compartido (`payTo` fijo del gateway) + referencia única por
  pago.** Justificación completa y medida en §4.
- **DT-2 — Se reusa `SettlementPresence`** (`types.ts:170-187`). Hereda DT-2 del work-item.
  No se inventa un tipo inbound para la presencia.
- **DT-3 — El uso único se clava en la FIRMA; la referencia ata la prueba a ESTE
  challenge.** Dos propiedades, dos columnas. Hereda DT-3 del work-item.
- **DT-4 — La rama inbound Solana no pasa por `getPaymentAdapter()`.** La bifurcación entra
  en `x402.ts` entre `:512` y `:514`, sobre `bundle.payment.vmFamily`, con `return` inmediato.
  Ninguna línea del camino EVM (`:514-891`) se ejecuta ni se modifica.
- **DT-5 — `acceptsInboundPayment(bundle)` pasa a ser capacidad real, con UNA definición.**
  Nuevo cuerpo: `evm` ⇒ `true` (idéntico a hoy); `solana` ⇒ `isSolanaX402InboundConfigured()`
  — función **pura y síncrona** que exige las cuatro cosas juntas:
  `SOLANA_ADAPTER_ENABLED === 'true'` **Y** `SOLANA_X402_INBOUND_ENABLED === 'true'` **Y**
  `SOLANA_X402_INBOUND_PAY_TO` presente y base58 válido de 32 bytes **Y**
  `SOLANA_X402_INBOUND_CHALLENGE_SECRET` presente con longitud mínima.
  **Limitación declarada, no escondida**: `/capabilities` es síncrono, así que puede publicar
  *"configurado"* pero no *"la DB y el RPC están sanos"*. Eso último se enforcea perezoso en
  la verificación (DT-9), igual que WKH-307 (`schema-preflight.ts:33-50`). CD-6 se cumple en
  el sentido fuerte que importa: **con la config incompleta el valor publicado es `false` y
  el camino está cerrado**; nunca se anuncia una capacidad que no está cableada.
- **DT-6 — La referencia viaja como CUENTA EXTRA read-only en la transacción (convención
  Solana Pay), no como memo.** Tres razones:
  (1) es la convención documentada de Solana Pay, así que el pagador la produce con
  herramientas estándar y **sin nuestro IDL**;
  (2) se verifica leyendo `transaction.message.accountKeys` de la tx que YA sabemos presente
  — **no hace falta `getSignaturesForAddress`**, o sea no hay búsqueda en historial;
  (3) el memo obliga a parsear una cadena libre de una instrucción de otro programa, y
  `checkTerms` no lee instrucciones (`payment.ts:1114-1122`), así que el costo de código es
  el mismo pero la superficie de ambigüedad es mayor.
  **Borde declarado**: si la transacción es versión 0 y la referencia entra por una Address
  Lookup Table, la clave vive en `meta.loadedAddresses`, no en `accountKeys`. El lector
  **debe** mirar las dos; si la tx es v0 y no puede resolver las direcciones cargadas, el
  veredicto es **`unknown`**, nunca "la referencia no está" (CD-3).
  **No pude determinarlo en F2**: que una clave de 32 bytes inexistente pueda ir como cuenta
  read-only no-firmante en una transferencia SPL es el supuesto sobre el que Solana Pay se
  apoya, pero **verificarlo exige firmar y transmitir una transacción**, que F2 no puede
  hacer. **Es la primera tarea de W1**: probarlo en devnet antes de construir sobre él.
- **DT-7 — El single-use vive en `src/services/solana-inbound-proof.ts`, NO en
  `src/adapters/solana/`.** Desviación deliberada del work-item §5, por dos razones:
  (1) `settle-ledger.ts:40-45` declara ser **el único** archivo de `adapters/solana/**` con
  acceso a datos (CD-7 de WKH-307); agregar un segundo violaría un CD vigente;
  (2) es el reemplazo directo de `services/x402-nonce.ts`, y ese es el vecindario correcto —
  el llamador es el middleware, que ya importa `services/` (`x402.ts:29-30`).
  Doctrina heredada verbatim de `settle-ledger.ts:15-39`: escritura condicional atómica en
  plpgsql, fail-closed, ninguna función devuelve `boolean`.
- **DT-8 — El preflight inbound verifica que la wallet receptora tenga EXACTAMENTE una
  cuenta de token para el mint.** Hallazgo propio: `checkTerms` resuelve el balance con
  `.find()` sobre `pre/postTokenBalances` (`payment.ts:1116-1121`), o sea toma **la primera**
  entrada con ese `owner` y ese `mint`. Si la wallet receptora tuviera dos cuentas de token
  del mismo mint (ATA + auxiliar) y el pagador acreditara en la que no es la primera, el
  delta leído sería 0 y la verificación produciría un **`landed_mismatch` falso** sobre un
  pago real. No se toca `checkTerms` (protege el leg de salida que acaba de shipear); se
  convierte el riesgo en un **error de configuración ruidoso**: un
  `getTokenAccountsByOwner(payTo, { mint })` memoizado que devuelva ≠ 1 ⇒ preflight
  fail-closed con motivo propio.
- **DT-9 — Preflight inbound propio, que REUSA la retención sin duplicarla.**
  `src/adapters/solana/inbound-preflight.ts` con el mismo molde que
  `schema-preflight.ts:240-275` (cache single-flight, positivo para siempre, negativo con
  TTL). Verifica tres cosas: (1) la tabla + los RPC del store inbound resuelven (prueba
  POSITIVA con `p_probe`, molde `20260730000000…:239-243`); (2) la retención de historia del
  RPC; (3) DT-8.
  **Esta HU es la dueña de exportar `probeRpcHistoryRetention`**: hoy es `private` y sólo se
  alcanza tras exigir la tabla del settle OUTBOUND (`schema-preflight.ts:211-217`), que el
  inbound no necesita. El cambio es **añadir `export`, con el cuerpo byte-idéntico** —
  cero líneas de lógica tocadas. **Coordinación con WKH-315**: 315 importa el símbolo
  exportado y **no toca el archivo**. Si el F2 de 315 también planeaba exportarlo, esta HU
  reclama la propiedad y 315 cede.
- **DT-10 — Doble proveedor de RPC antes de declarar cualquier veredicto que NO sea un
  grant.** `SOLANA_RPC_URL_FALLBACK` **existe en `.env.example:969` y no la lee nadie**
  (verificado: `chain.ts:39-41` lee sólo `SOLANA_RPC_URL`; la única otra aparición es
  `deposit-verifier.ts:176-178`, que **devuelve el nombre de la variable como string** en el
  resolver del deposit-path viem, declarado código muerto para Solana en `:82-84`).
  Se agrega `getSolanaFallbackConnection(): Connection | null` en `chain.ts`, cacheada por
  proceso igual que la primaria. **Regla de escalada y de combinación** (una función pura y
  testeable, sin red):
  | Situación | Veredicto final | Por qué |
  |---|---|---|
  | Alguno de los dos dice `landed_mismatch` | **`landed_mismatch`** (pegajoso) | Un `landed_mismatch` es un parseo REAL con números distintos: dos parseos de la misma firma no pueden discrepar legítimamente. Si aparece junto a un `landed_ok`, es una anomalía que debe **denegar y alertar**, nunca resolverse a favor del grant. |
  | Si no, alguno dice `landed_ok` | `landed_ok` (grant) | El grant se apoya en **evidencia afirmativa** de al menos un proveedor, que es exactamente el criterio con el que se concede. |
  | Si no, alguno dice `landed_failed` | `landed_failed` (deniega, no consume) | La tx se ejecutó y falló: no hay transferencia. Terminal, pero **no se consume** la prueba (consumir no aporta nada y podría quemar una firma por error). |
  | Si no, **los dos** dicen `absent` | `absent` (deniega, no consume, reintentable) | Dos nodos independientes buscaron y no la conocen. |
  | Cualquier otro caso | **`unknown`** | Incluye "uno dice `absent` y el otro `unknown`": un `absent` solo, contradicho por un "no sé", **no es una negativa de dos nodos**. |
  Cuando no hay fallback configurado, el veredicto del primario se usa tal cual: **la
  ausencia de fallback nunca convierte un `unknown` en un grant**.
  **Por qué también se escala sobre `absent`** (y no sólo sobre `unknown`): en el leg de
  entrada, `absent` es un **rechazo**, y si el nodo primario simplemente no tiene esa porción
  de historia, el rechazo sería **permanente**, no un aplazamiento — el pagador reintentaría
  para siempre contra el mismo nodo ciego. Un segundo proveedor cuesta una lectura en el
  camino que ya iba a rechazar.
- **DT-11 — Flag: `SOLANA_X402_INBOUND_ENABLED`, default `false`, ANDeado.** Espeja
  `SOLANA_ADAPTER_ENABLED` (`registry.ts:63`, comparación literal contra `'true'`). Con el
  flag OFF **todo** el comportamiento observable es el de hoy, incluido el 400 de
  `CHAIN_INBOUND_PAYMENT_UNSUPPORTED`. Eso es lo que permite el CD-1 fuerte de §7.
- **DT-12 — El "sí" de la cadena se cachea en el store, en DOS estados: `observed` →
  `consumed`.** La pregunta caraque y con tercer valor (*"¿esta firma aterrizó y cumple?"*)
  se hace **una sola vez por pago, en la vida del pago**. Secuencia:
  1. Validación local del challenge (referencia re-derivable + no expirada) — pura, sin red.
  2. Presencia + términos de dinero (DT-10) ⇒ debe ser `landed_ok`.
  3. Binding (referencia presente en la tx + `blockTime` dentro de la ventana del challenge).
  4. `record_solana_inbound_observed(...)` — persiste el veredicto de la cadena.
  5. `consume_solana_inbound_proof(...)` — **escritura condicional atómica**; exactamente un
     ganador. El perdedor recibe `replay`.
  6. Concesión del acceso.
  Un reintento que encuentre la fila en `observed` **salta los pasos 2 y 3**: la incertidumbre
  de la cadena existe sólo en la primera verificación. Un reintento que la encuentre en
  `consumed` recibe `replay` (AC-3), **sin importar si el primer intento terminó bien** —
  porque la detección mira la FILA, no el resultado de nadie.
  **Alternativa más simple, rechazada**: una sola llamada que verifique y consuma. Es menos
  código, pero re-abre la ventana de incertidumbre en **cada** reintento, que es exactamente
  la mitigación que se nos pidió construir.
  **Residuo declarado y aceptado**: si el consumo aplica y la respuesta HTTP se pierde, el
  pagador queda cobrado sin servicio y su reintento da `replay`. Es **la misma postura que
  el camino EVM tiene hoy** (`x402.ts:644-659`) y se mitiga poniendo el consumo lo más tarde
  posible. No se resuelve en esta HU; se registra.
- **DT-13 — El challenge es SIN ESTADO: la referencia es un MAC, no una fila.** La
  referencia es `HMAC-SHA256(secreto, resource|payTo|amountAtomic|mint|caip2|issuedAt|expiresAt)`
  truncado a 32 bytes y codificado en base58 — o sea, **es una clave pública válida** y por lo
  tanto usable como cuenta. El 402 devuelve la tupla; el pagador la devuelve en
  `authorization`; el servidor **re-deriva y compara en tiempo constante**.
  Por qué sin estado: persistir cada challenge sería una **escritura por cada 402**, en una
  ruta pública y sin autenticar ⇒ amplificación de denegación de servicio gratis para
  cualquiera. El MAC da inforjabilidad y expiración con cero almacenamiento.
  El secreto va en `SOLANA_X402_INBOUND_CHALLENGE_SECRET`; sin él, DT-5 publica `false`.
- **DT-14 — El canal de `unknown` se EXTRAE, no se duplica.** `emitInboundSettleUnknown`
  (`x402.ts:674-730`) es hoy una closure sobre variables del handler EVM. Se extrae a una
  función de módulo con parámetros explícitos; el sitio EVM la invoca reenviando lo mismo.
  Dos implementaciones del mismo canal serían exactamente el defecto de HU-208 (*"dos
  expresiones separadas para la misma cosa"*, ver CD-11). Se conservan `error_code`
  `X402_SETTLE_UNKNOWN` y `eventType` `x402_settle_unknown` (CD-8: no se inventa
  vocabulario); la rama Solana agrega `signature` y `reference` al `metadata` y **no manda**
  `authorizationNonce`. **La prueba de que la extracción no cambió nada es
  `x402.settle-unknown.test.ts` verde SIN MODIFICAR.**
- **DT-15 — El sobre X-PAYMENT de Solana reusa la forma existente; `decodeXPayment` no se
  toca.** `decodeXPayment` (`x402.ts:359-382`) sólo exige `authorization` objeto y
  `signature` string. El sobre Solana es
  `{ authorization: { reference, payTo, amountAtomic, mint, issuedAt, expiresAt }, signature: '<txid base58>', network: 'solana:<genesis>' }`.
  Cero cambios en el decoder ⇒ cero riesgo sobre el camino EVM.
- **DT-16 — La wallet receptora se declara como PUBKEY, en una variable nueva.**
  `resolvePaymentRequirements` (`x402.ts:294-309`) resuelve `payTo` desde
  `PAYMENT_WALLET_ADDRESS || KITE_WALLET_ADDRESS`, que son direcciones EVM. El inbound Solana
  usa `SOLANA_X402_INBOUND_PAY_TO` (base58). **Nunca** se deriva de
  `SOLANA_OPERATOR_PRIVATE_KEY`: la variable existe precisamente para que el leg de entrada
  no tenga ningún motivo para tocar la llave (AC-9 / CD-2).
- **DT-17 — El testigo vive en `wasiai-a2a`, no en el facilitator** (hereda DT-1 del
  work-item). El gateway ya tiene la `Connection` y el probe. Reversible: una HU futura mueve
  el testigo detrás de la misma interfaz.

---

## 6. El uso único, garantizado por la BASE

Esto es el corazón de la HU. El work-item lo dice con precisión: `x402-nonce.ts:41-51` falla
ABIERTO con una justificación (`:10-13`) que **es cierta en EVM y falsa en Solana**. Una
prueba de pago Solana es la firma de una transacción ya aterrizada: se puede presentar N
veces y la cadena no objeta nada, porque no hay nada que gastar por segunda vez.

El patrón bueno **ya existe en este repo** y no hay que inventarlo:
`20260529000000_a2a_key_deposits.sql:17` — `UNIQUE (chain_id, tx_hash)` — con el reclamo
antes de acreditar en `:71-79`. **No puede fallar abierto**: si la fila está, la inserción
falla; siempre; sin que nadie se acuerde de chequear nada.

### 6.1 Migración nueva: `20260731000000_wkh314_solana_inbound_proofs.sql`

Molde: `20260730000000_wkh307_solana_settle_intents.sql`. Verificado que no hay colisión de
timestamp (el máximo actual es `20260730000000`).

```
TABLA public.a2a_solana_inbound_proofs
  caip2            TEXT   NOT NULL
  signature        TEXT   NOT NULL          -- firma base58 de la tx del PAGADOR
  PRIMARY KEY (caip2, signature)            -- ← ESTO es el uso único. No es defensa
                                            --   en profundidad: es LA defensa.
  reference        TEXT   NOT NULL
  resource         TEXT   NOT NULL
  pay_to           TEXT   NOT NULL
  amount_atomic    TEXT   NOT NULL          -- TEXT, NUNCA NUMERIC (WKH-196)
  mint             TEXT   NOT NULL
  status           TEXT   NOT NULL DEFAULT 'observed'
                          CHECK (status IN ('observed','consumed'))
  observed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  consumed_at      TIMESTAMPTZ NULL
  attempts         INTEGER NOT NULL DEFAULT 1
  created_at / updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
```

**Sin `owner_ref` y sin RLS, decisión explícita** (no un olvido): en el camino x402 puro no
hay identidad de caller — el pagador se identifica con su firma de pago. Es dedup GLOBAL del
gateway, igual criterio y misma redacción que `a2a_solana_settle_intents`
(`20260730000000…:171`). Se declara para que AR lo evalúe como decisión y no lo encuentre
como omisión. `REVOKE ALL … FROM PUBLIC, anon, authenticated` + `GRANT` sólo a
`service_role`; la tabla se toca **exclusivamente** por las funciones `SECURITY DEFINER` con
`search_path` fijo (patrón `20260529000000…:96-103`).

Tres funciones `plpgsql`, todas con `RETURNS TABLE(applied BOOLEAN, outcome TEXT, ...)` —
**ninguna devuelve `boolean`** (regla 3 de `settle-ledger.ts:36-38`):

1. **`record_solana_inbound_observed(...)`** — `INSERT … ON CONFLICT (caip2, signature) DO
   UPDATE SET attempts = attempts+1 … WHERE status='observed' AND los términos coinciden …
   RETURNING`. Una sola sentencia. Outcomes: `observed` (nuevo o re-observado) /
   `consumed` (replay) / `terms_conflict` (la misma firma presentada contra otro
   destino/monto/mint/referencia **no es este pago**).
2. **`consume_solana_inbound_proof(...)`** — `UPDATE … SET status='consumed', consumed_at=now()
   WHERE caip2=… AND signature=… AND status='observed' AND los términos coinciden RETURNING`.
   Exactamente un ganador, decidido por Postgres. Outcomes: `consumed` (ganó) /
   `already_consumed` (replay) / `not_observed` (estado imposible ⇒ fail-closed) /
   `terms_conflict`.
3. **`probe_solana_inbound_store(p_probe BOOLEAN)`** — `RAISE EXCEPTION
   'WKH314_PROBE_OK'` como **primera sentencia**, antes de tocar una fila. Prueba POSITIVA de
   costo cero para el preflight (molde `20260730000000…:239-243`). Leer un catálogo no probaría
   lo mismo: una función homónima con el cuerpo viejo figuraría igual.

Y el `_down` correspondiente, que **renombra en vez de borrar** (la evidencia de a quién se
le sirvió no se destruye) **con el gate de re-hidratación ejecutable** en el `up` — CD-14,
lección de WKH-307: preservar sin re-hidratar es preservar para nadie. Acá el gate aborta si
el backup conserva filas `status='consumed'`, porque re-aplicar el `up` sobre una tabla
vacía **borra el uso único de toda prueba ya gastada** ⇒ servicio gratis para cada firma
histórica.

### 6.2 El seam de aplicación: `src/services/solana-inbound-proof.ts`

Fail-CLOSED, verbatim la regla 2 de `settle-ledger.ts:30-34`: cliente caído, error de
Postgres, `data` vacío, `applied: undefined`, forma inesperada ⇒ todo eso es *"no sé"*, y
**"no sé" nunca concede acceso**. Sin fallback en memoria. Reusa los clasificadores de error
ya escritos y verificados en vivo (`settle-ledger.ts:99-128`: `PGRST205` / `42P01` para
esquema, `status:0 && code:''` para fallo de transporte) — **importados, no re-escritos**
(CD-11).

Tipos de retorno, ambos uniones con ≥3 estados:

```
InboundObserveResult = { state:'observed'; attempts:number }
                     | { state:'replay' }
                     | { state:'terms_conflict'; detail:string }
                     | { state:'unknown'; detail:string }      // el store no respondió

InboundConsumeResult = { state:'consumed' }
                     | { state:'replay' }
                     | { state:'unknown'; detail:string }
```

---

## 7. Promoción del primitivo compartido — el contrato que WKH-315 consume

`probeSettlementPresence` (`payment.ts:572-644`) es **`private`** y las dos HUs lo necesitan.
**Esta HU es la dueña de promoverlo.**

**Cómo**: extracción a un módulo nuevo `src/adapters/solana/presence.ts`, como **función
libre exportada** — no como método de `SolanaPaymentAdapter`.

Por qué función libre y no un método de la interfaz:
1. `SolanaPaymentAdapter` (`types.ts:209-243`) queda **intacta** ⇒ el radio de impacto sobre
   el leg de salida (que acaba de shipear en WKH-307/308) es mínimo.
2. `adapters/types.ts` no tiene por qué importar tipos de `@solana/web3.js`; dentro de
   `adapters/solana/` eso es normal.
3. 315 hace `import { probeSplTransferPresence } from '../adapters/solana/presence.js'` y no
   necesita un adapter instanciado.

### 7.1 El contrato expuesto (esto es lo que 315 puede usar sin modificarlo)

```ts
// src/adapters/solana/presence.ts

/**
 * ¿Esta firma está en la cadena, y acredita >= amountAtomic del mint CONFIGURADO
 * a payTo?
 *
 * CONTRATO:
 *  · NUNCA lanza. Todo fallo se traduce a { state:'unknown', detail }.
 *  · La única fuente admitida para una determinación NEGATIVA es
 *    getSignatureStatuses(..., { searchTransactionHistory:true }).
 *  · NO consulta la DB, NO lee el store de idempotencia, NO firma nada,
 *    NO toca ninguna clave privada.
 *  · Lee UN solo endpoint: el que se le pase (o el primario por defecto).
 *    La escalada al fallback NO vive acá — vive en el combinador (DT-10),
 *    para que este primitivo siga siendo la unidad testeable de UNA pregunta
 *    a UN nodo.
 */
export function probeSplTransferPresence(
  proof: SolanaSettleProof,          // { signature, payTo, amountAtomic } — types.ts:124-128
  connection?: Connection,           // ausente ⇒ getSolanaConnection()
): Promise<SettlementPresence>;      // types.ts:170-187 — cinco estados, exhaustividad forzada

/** Validación de TÉRMINOS sobre una tx ya parseada. Pura, sin red. */
export function checkSplTransferTerms(
  parsed: ParsedTransactionWithMeta,
  proof: SolanaSettleProof,
): { ok: true } | { ok: false; error: string };
```

**Qué cambia en `payment.ts`**: `probeSettlementPresence` y `checkTerms` pasan a ser
delegaciones de una línea a las funciones del módulo nuevo. **Extracción de comportamiento
preservado, cero cambios de lógica.** La prueba es que la suite del adapter
(`src/adapters/solana/payment.test.ts`, 23 tests según el auto-blindaje de WKH-307) queda
**verde sin modificarse**, más la mutación M-P1 de §9.

**Qué NO se cambia, a propósito**: el `.find()` de `checkTerms` (`payment.ts:1116-1121`). Es
una fuente conocida de falso `landed_mismatch` (DT-8) y arreglarlo cambiaría el
comportamiento del leg de salida. Se mitiga con un preflight ruidoso, no con un cambio
silencioso en un camino de dinero recién shipeado. Queda como **TD-INBOUND-MULTI-ATA**.

### 7.2 Coordinación explícita con WKH-315

| Símbolo | Dueño (quién lo crea/mueve) | Consumidor |
|---|---|---|
| `probeSplTransferPresence`, `checkSplTransferTerms` (`adapters/solana/presence.ts`) | **WKH-314** | WKH-315, sin tocar el archivo |
| `export` de `probeRpcHistoryRetention` (`schema-preflight.ts`) | **WKH-314** (añadir `export`, cuerpo byte-idéntico) | WKH-315, sin tocar el archivo |
| `getSolanaFallbackConnection()` (`adapters/solana/chain.ts`) | **WKH-314** | WKH-315 si lo necesita |
| `SettlementPresence` (`adapters/types.ts:170-187`) | Nadie: **ya existe**, se reusa | las dos |
| `src/services/solana-inbound-proof.ts` | **WKH-314**, exclusivo del leg x402 | nadie más |
| `src/routes/auth/deposit.ts`, `src/adapters/deposit-verifier.ts` | **WKH-315**, exclusivo | WKH-314 no los toca |
| `src/middleware/x402.ts` | **WKH-314**, exclusivo | WKH-315 no lo toca |

Archivos que **las dos** HUs tocan: `adapters/solana/chain.ts` y `.env.example`. Riesgo de
conflicto **bajo** (añadidos al final de bloques distintos), pero real: se declara acá para
que el merge se haga con conocimiento.

---

## 8. Constraint Directives (CD-N)

Los CD-1…CD-8 del work-item se heredan. Se refuerzan y se agregan CD-9…CD-14.

- **CD-1 — OBLIGATORIO: el camino EVM queda byte-idéntico.**
  Mismos status, mismos `error_code`, mismos campos del challenge, misma secuencia
  binding-check → `verify` → `settle` → re-verify.
  **Prueba, MÁS FUERTE que la que pedía el work-item**: las **ocho** suites x402 quedan
  verdes **SIN MODIFICARSE**, `x402.non-evm-inbound.test.ts` **incluida**.
  Se elimina la excepción que el work-item concedía, y se puede eliminar porque el flag nace
  en OFF (DT-11): con `SOLANA_X402_INBOUND_ENABLED` ausente, `acceptsInboundPayment` sobre el
  bundle Solana sigue devolviendo `false`, el 400 de `CHAIN_INBOUND_PAYMENT_UNSUPPORTED` sigue
  saliendo igual, y `getPaymentAdapter('solana-devnet')` sigue lanzando (DT-4: nunca lo
  llamamos). **Un test que hay que reescribir para que el cambio pase es un test que dejó de
  vigilar algo; uno que sigue verde intacto es la prueba de que no se rompió nada.**
  Las expectativas invertidas van en un archivo **NUEVO**: `x402.solana-inbound.test.ts`.
  También quedan verdes sin tocar `src/routes/capabilities.inbound-chains.test.ts` y
  `src/adapters/__tests__/registry.test.ts:919-1000`.
- **CD-2 — PROHIBIDO firmar, transmitir o alcanzar una clave privada Solana en el camino
  inbound.** El único efecto irreversible del leg es del pagador. Prueba ejecutable: un test
  que espía `getSolanaOperatorKeypair` y afirma **cero invocaciones** en el camino inbound
  completo, incluidos todos los caminos de rechazo. **PROHIBIDO** que
  `SOLANA_X402_INBOUND_PAY_TO` se derive de `SOLANA_OPERATOR_PRIVATE_KEY` (DT-16).
- **CD-3 — PROHIBIDO un `boolean` o un `T | null` en cualquier eslabón de la cadena de
  verificación inbound.** Se reusa `SettlementPresence`; los tipos nuevos
  (`InboundObserveResult`, `InboundConsumeResult`, el resultado del binding) tienen ≥3
  estados **y** el compilador fuerza la exhaustividad. Incluye el borde del binding: "no pude
  resolver las direcciones cargadas de una tx v0" es **`unknown`**, nunca "la referencia no
  está" (DT-6).
- **CD-4 — PROHIBIDO reusar `a2a_x402_nonces` / `checkAndRecordX402Nonce`
  (`x402-nonce.ts:31-53`) para la prueba Solana.** Falla ABIERTO por diseño (`:39-51`) y su
  justificación escrita (`:10-13`) es **falsa en Solana**. **Y PROHIBIDO "arreglarlo"
  volviéndolo fail-closed**: eso cambiaría el camino EVM y violaría CD-1. El single-use
  inbound es tabla propia, con el uso único garantizado por una **PK de Postgres** (§6.1).
- **CD-5 — OBLIGATORIO devnet.** Sin slug `-mainnet`, sin RPC de mainnet, sin plata real.
  Aplica también a `SOLANA_RPC_URL_FALLBACK`: **PROHIBIDO** que apunte a un endpoint de
  mainnet. Espeja CD-4 de WKH-234.
- **CD-6 — PROHIBIDO publicar `acceptsInboundPayment: true` mientras la verificación no esté
  cableada y configurada.** El valor sale de la **única** definición (DT-5), consumida por el
  guard del middleware y por `/capabilities`, para que no puedan divergir. La limitación de
  lo que un chequeo síncrono puede afirmar está declarada en DT-5, no escondida.
- **CD-7 — OBLIGATORIO que el challenge lleve referencia única por request Y expiración
  absoluta, y que las dos se validen del lado del servidor.** Un challenge que se satisface
  con una transferencia de ayer no es un pago por este request: la validación de frescura
  compara el **`blockTime` de la transacción** contra la ventana del challenge, no la hora en
  que llegó el header. **PROHIBIDO** validar la expiración leyendo un campo que el cliente
  manda sin MAC (DT-13).
- **CD-8 — OBLIGATORIO entrar por el canal de "resultado desconocido" que ya existe**
  (`x402.ts:674-730`: log con `error_code` estable **+** evento durable en `a2a_events`).
  **PROHIBIDO** inventar vocabulario nuevo para lo mismo, y **PROHIBIDO** una segunda
  implementación del canal: se extrae y se comparte (DT-14, CD-11).
- **CD-9 — PROHIBIDO consumir la prueba en cualquier camino de rechazo.** Los cinco rechazos
  (monto insuficiente, destino/mint distinto, referencia que no ata, challenge expirado,
  `unknown` de la cadena o del store) **dejan la firma gastable**. Cada uno con un
  `error_code` estable y distinguible, y con `Retry-After` **sólo** en los reintentables
  (`unknown`, `absent`): un rechazo por monto insuficiente no se arregla esperando.
  El único consumo posible es el paso 5 de DT-12, inmediatamente antes de conceder.
- **CD-10 — PROHIBIDO reportar un mutante como KILLED sin nombrar el test que falló y el
  motivo.** Patrón recurrente: WKH-307 W4 (`no tests` leído como muerto — un archivo que no
  colecciona pone todo en rojo sin haber probado nada) y HU-208 W3 (M5 sobrevivió porque el
  test medía el efecto observable en vez del costo). Corolarios obligatorios:
  (a) **"no tests" NUNCA cuenta como KILLED**; (b) **ningún helper que pueda tirar se invoca
  en el cuerpo de un `describe`** — todo lo que valide entrada externa (un `.sql`, un
  fixture) va dentro del `it`; (c) toda afirmación del tipo "no agrega costo" se prueba
  asertando el **número de llamadas de I/O**, no sólo el resultado.
  Referencia: WKH-307 auto-blindaje#[2026-07-29 03:05], HU-208 auto-blindaje#W3-M5.
- **CD-11 — PROHIBIDO dos expresiones separadas para el mismo valor o el mismo canal.**
  Patrón recurrente: HU-208 W2 (`refundComposeStep0` recalculaba el débito ⇒ caller cobrado
  sin reembolso). Aplica a: el monto atómico requerido (una sola resolución, reusada por el
  challenge y por el binding, igual que `resolvePaymentRequirements` hace en EVM —
  `x402.ts:288-309`); el canal de `unknown` (DT-14); los clasificadores de error de
  Postgres (se importan de `settle-ledger.ts:99-128`, no se re-escriben); la definición de
  `acceptsInboundPayment` (DT-5).
  Referencia: HU-208 auto-blindaje#W2.
- **CD-12 — PROHIBIDOS fixtures "que parecen del tipo correcto".** Patrón recurrente:
  WKH-307 W3 (un blockhash de 32 **caracteres** en vez de 32 **bytes**, que funcionaba por
  casualidad; y un `secretKey` de 64 ceros que dejó de alcanzar al serializar). En esta HU el
  riesgo concreto: **una firma Solana es base58 de 64 bytes (≈87-88 caracteres) y una
  referencia es base58 de 32 bytes**. `'x'.repeat(88)` no es base58 válido y va a explotar
  lejos del origen. **OBLIGATORIO** derivar los fixtures de la misma librería que los
  consume (`Keypair.generate().publicKey.toBase58()` para claves; firmas reales o
  `bs58.encode(randomBytes(64))`).
  Referencia: WKH-307 auto-blindaje#[2026-07-29 02:43] y #[2026-07-29 02:41].
- **CD-13 — PROHIBIDO git destructivo durante la campaña de mutación.** Patrón: HU-203
  (`git checkout --` se llevó 160 líneas sin commitear). **OBLIGATORIO**: copia física fuera
  del árbol de git + `sha256sum` de referencia antes de mutar, y verificación del hash al
  restaurar. `git checkout --`, `git restore` y `git stash` **no son mecanismos de undo**
  para cambios no commiteados.
  Referencia: HU-203 auto-blindaje#[2026-07-28 15:38].
- **CD-14 — OBLIGATORIO que el `_down` que preserva datos traiga un gate de re-hidratación
  EJECUTABLE en el `up`.** Patrón: WKH-307 (`WKH307_BACKUP_NOT_REHYDRATED`). Un paso en un
  runbook es prosa; **un gate que nadie corre no es un gate**.
  Referencia: WKH-307 auto-blindaje#[gate del ciclo down→up].

---

## 9. Waves de implementación

### W0 — serial. Contratos, tipos, esquema. Nada de red, nada de wiring.

| # | Archivo | Qué |
|---|---|---|
| W0.1 | `supabase/migrations/20260731000000_wkh314_solana_inbound_proofs.sql` + `_down.sql` | Tabla + PK `(caip2, signature)` + 3 funciones `plpgsql` + `p_probe` + gate de re-hidratación (§6.1). **Aplicar a bdwv ANTES de deployar código**, nunca a caldz. |
| W0.2 | `src/adapters/solana/presence.ts` (**nuevo**) + `src/adapters/solana/payment.ts` (delegación) | Promoción del primitivo. Contrato de §7.1. Extracción de comportamiento preservado. |
| W0.3 | `src/adapters/solana/schema-preflight.ts` | **Sólo** añadir `export` a `probeRpcHistoryRetention` (`:166`). Cuerpo byte-idéntico. |
| W0.4 | `src/adapters/types.ts` | `InboundObserveResult`, `InboundConsumeResult`, `SolanaInboundBinding` (unión ≥3 estados), `SolanaInboundChallenge`. Aditivo. |
| W0.5 | `src/adapters/solana/chain.ts` | `getSolanaFallbackConnection()`, `getSolanaInboundPayTo()`, `getSolanaInboundChallengeSecret()`, `isSolanaX402InboundConfigured()`, y `_resetSolanaChain()` extendido para limpiar la conexión de fallback. |

**Salida de W0**: compila (`npx tsc --noEmit` **completo**, no sólo `npm run build` — lección
de WKH-196), todas las suites existentes verdes, **cero cambio de comportamiento observable**.

**Primera tarea de W1, bloqueante de W1b** (declarada en DT-6): probar en **devnet** que una
transferencia SPL con una clave de 32 bytes inexistente como cuenta read-only no-firmante
aterriza, y que esa clave aparece en `transaction.message.accountKeys` de
`getParsedTransaction`. Si no aterrizara, DT-6 cae y hay que volver al memo — mejor
descubrirlo antes de construir sobre él.

### W1 — paralelizable (tres frentes, archivos disjuntos)

| # | Archivo | Qué | Depende de |
|---|---|---|---|
| W1a | `src/services/solana-inbound-proof.ts` (**nuevo**) | Seam fail-CLOSED del single-use. Reusa los clasificadores de `settle-ledger.ts:99-128`. | W0.1, W0.4 |
| W1b | `src/adapters/solana/inbound-verify.ts` (**nuevo**) | Combinador de doble proveedor (DT-10, función pura sobre dos `SettlementPresence`) + lectura del binding (referencia en `accountKeys` ∪ `meta.loadedAddresses`, y `blockTime` en la ventana). | W0.2, W0.5, prueba devnet |
| W1c | `src/lib/solana-x402-challenge.ts` (**nuevo**) | `buildSolanaChallenge()` / `verifySolanaChallengeReference()` — HMAC, puro, comparación en tiempo constante, expiración. Cero red, cero DB. | W0.5 |

### W2 — serial. Wiring y preflight.

| # | Archivo | Qué |
|---|---|---|
| W2.1 | `src/adapters/solana/inbound-preflight.ts` (**nuevo**) | Cache single-flight (molde `schema-preflight.ts:240-275`): store + retención (W0.3) + DT-8. Fail-closed con motivos distinguibles. |
| W2.2 | `src/adapters/registry.ts` | `acceptsInboundPayment` pasa a capacidad real (DT-5). EVM: idéntico. |
| W2.3 | `src/middleware/x402.ts` | (a) extraer `emitInboundSettleUnknown` a función de módulo (DT-14); (b) insertar la bifurcación Solana entre `:512` y `:514`, con `return`; (c) `buildSolanaX402Response` + el handler inbound Solana. **Ni una línea del camino EVM aguas abajo se modifica.** |
| W2.4 | `src/index.ts` | Warm-up del preflight inbound, fire-and-forget, sólo con el flag ON (patrón `warmSolanaSchemaPreflight`, `schema-preflight.ts:283-285`). |

### W3 — docs y config. Sin código de runtime.

`.env.example` (bloque nuevo con las tres variables + advertencia devnet del fallback),
`doc/INTEGRATION.md` (cómo paga un tercero en Solana: la tupla del 402, el sobre X-PAYMENT,
la tabla de `error_code` y cuáles son reintentables), `doc/MULTI-CHAIN.md` (la asimetría
deja de ser total; TD-INBOUND-MULTI-ATA registrado).

---

## 10. Plan de tests — ≥1 por AC, y qué mutación mata a los de dinero

Archivos nuevos: `src/middleware/x402.solana-inbound.test.ts`,
`src/services/solana-inbound-proof.test.ts`,
`src/adapters/solana/inbound-verify.test.ts`,
`src/lib/solana-x402-challenge.test.ts`,
`test/wkh314-inbound-proofs.migration.test.ts`.
Helpers compartidos en `test/helpers/` — **nunca importar un `.test.ts` desde otro**
(duplica sus suites: medido en WKH-307 auto-blindaje#[2026-07-29 02:35]).

| AC | Test (id) | Qué afirma | Mutación que lo debe matar |
|---|---|---|---|
| **AC-1** | `T-CHAL-01` | 402 con `x-payment-chain: solana-devnet` y flag ON: el body trae `network` = CAIP-2, `mint` base58, `maxAmountRequired` atómico del mint, `payTo` base58, `reference` y `expiresAt` absoluto | — |
| AC-1 | `T-CHAL-02` | El `reference` cambia entre dos 402 del mismo endpoint | **M1**: derivar la referencia sin el componente único ⇒ dos challenges iguales ⇒ rojo |
| AC-1 | `T-CHAL-03` | `maxAmountRequired` == `quote(amountUsd).amountWei` del adapter Solana (**una sola resolución**, CD-11) | **M2**: recalcular el monto con una segunda expresión (`toFixed`) ⇒ divergencia ⇒ rojo |
| **AC-2** 💰 | `T-GRANT-01` | Firma presente + referencia correcta + monto exacto + no reclamada ⇒ **acceso concedido** y la fila queda `consumed` | **M3**: invertir el orden de DT-12 (conceder antes de consumir) ⇒ el test que afirma "la fila está `consumed` **antes** de que el handler responda" cae |
| AC-2 💰 | `T-GRANT-02` | El consumo se persiste **antes** de conceder (espía de orden: el `consume` resuelve antes de que se setee `paymentVerified`) | **M4**: quitar el `await` del consume ⇒ rojo |
| AC-2 💰 | `T-GRANT-03` | `landed_ok` + monto **estrictamente mayor** al requerido ⇒ concede | **M5**: cambiar `delta < required` por `delta !== required` ⇒ rojo |
| **AC-3** 💰 | `T-REPLAY-01` | Segunda presentación de la misma firma ⇒ 402 con `error_code` `X402_SOLANA_PROOF_REPLAY`, **sin** servicio | **M6**: hacer que el seam falle ABIERTO ante error de DB (o sea, copiar `x402-nonce.ts:41-51`) ⇒ rojo. **Esta es LA mutación de la HU.** |
| AC-3 💰 | `T-REPLAY-02` | Replay detectado **aunque el primer intento haya fallado** después del consumo (fila `consumed`, servicio nunca entregado) ⇒ sigue siendo replay | **M7**: condicionar la detección a un flag de éxito del primer intento ⇒ rojo |
| AC-3 💰 | `T-REPLAY-03` (migración) | La PK `(caip2, signature)` existe **y es PRIMARY KEY / UNIQUE** en el `.sql` | **M8**: quitar `PRIMARY KEY` del `.sql` ⇒ rojo. Sin este test, la HU podría shipear con el uso único ausente y todo lo demás verde. |
| AC-3 💰 | `T-REPLAY-04` | Dos consumos **concurrentes** de la misma firma: exactamente uno gana | **M9**: reemplazar el `UPDATE … WHERE status='observed' RETURNING` por `SELECT` + `UPDATE` ⇒ los dos ganan ⇒ rojo |
| **AC-4** 💰 | `T-SHORT-01` | Acredita **menos** que el requerido ⇒ `X402_SOLANA_AMOUNT_SHORT`, distinguible de replay y de unknown | **M10**: `delta < required` → `delta <= required` invertido, o comparar en decimal en vez de atómico ⇒ rojo |
| AC-4 💰 | `T-SHORT-02` | La prueba **NO** se consume: la fila no existe, y una segunda presentación con el monto correcto **no** da replay | **M11**: mover el consume antes de la verificación de términos ⇒ rojo |
| **AC-5** 💰 | `T-TERMS-01` | Destino distinto de `payTo` ⇒ deniega con código propio, no consume, **cero** intentos de reembolso | **M12**: quitar el filtro `b.owner === proof.payTo` de `checkSplTransferTerms` ⇒ rojo |
| AC-5 💰 | `T-TERMS-02` | Mint distinto del configurado ⇒ deniega, no consume | **M13**: quitar el filtro `b.mint === mint` ⇒ rojo |
| AC-5 💰 | `T-TERMS-03` | Firma válida en todo **salvo** la referencia (prueba "robada del explorer") ⇒ deniega, no consume | **M14**: no verificar la referencia ⇒ rojo. Cubre el front-running del §4. |
| AC-5 💰 | `T-TERMS-04` | `blockTime` **anterior** a `issuedAt` del challenge (transferencia de ayer) ⇒ deniega | **M15**: quitar la comparación de `blockTime` ⇒ rojo |
| AC-5 💰 | `T-TERMS-05` | Referencia con un MAC forjado (no re-derivable) ⇒ deniega, y el rechazo ocurre **antes de tocar la red** (cero llamadas al RPC) | **M16**: comparar la referencia con `===` sobre el valor del cliente en vez de re-derivar ⇒ rojo |
| **AC-6** 💰 | `T-UNK-01` | RPC que tira en los **dos** proveedores ⇒ veredicto `unknown`, **nunca** `absent`; deniega; **no consume** | **M17**: mapear el fallo del RPC a `absent` ⇒ rojo |
| AC-6 💰 | `T-UNK-02` | Store mudo ⇒ `unknown`; deniega; **no consume**; el reintento con la misma firma vuelve a ser posible | **M18**: `return { kind:'unavailable' }` con fail-open (el defecto de `x402-nonce.ts`) ⇒ rojo |
| AC-6 | `T-UNK-03` | El `unknown` emite `error_code` `X402_SETTLE_UNKNOWN` **y** un `a2a_events` con `eventType` `x402_settle_unknown`, `signature` y `reference` | **M19**: cambiar el `error_code` en el helper extraído ⇒ rojo **acá y en `x402.settle-unknown.test.ts`** (prueba de que el canal es UNO) |
| AC-6 | `T-UNK-04` | Un `track()` que TIRA no cambia la respuesta HTTP (fire-and-forget con `.catch()`) | **M20**: quitar el `.catch()` ⇒ unhandled rejection ⇒ rojo |
| AC-6 💰 | `T-UNK-05` | Primario `absent` + fallback `landed_ok` ⇒ **`landed_ok`** (concede). Primario `absent` + fallback `unknown` ⇒ **`unknown`** (no es negativa de dos nodos) | **M21**: quedarse con el veredicto del primario ⇒ rojo. **M22**: tratar "uno absent, otro unknown" como `absent` ⇒ rojo |
| AC-6 💰 | `T-UNK-06` | Primario `landed_ok` + fallback `landed_mismatch` ⇒ **`landed_mismatch`** (pegajoso, deniega) | **M23**: poner `landed_ok` antes de `landed_mismatch` en la precedencia ⇒ rojo |
| AC-6 | `T-UNK-07` | Sin fallback configurado, un `unknown` del primario sigue siendo `unknown` (la ausencia de fallback nunca concede) | **M24**: default permisivo cuando no hay fallback ⇒ rojo |
| **AC-7** 💰 | `T-EVM-01…08` | **Las 8 suites x402 existentes verdes SIN MODIFICARSE**, con y sin el flag Solana ON | Cualquier cambio de status/`error_code`/campo/secuencia en el camino EVM ⇒ rojo |
| AC-7 💰 | `T-EVM-09` | La suite del adapter Solana (`payment.test.ts`) verde sin modificarse ⇒ la extracción de W0.2 preservó el comportamiento | **M-P1**: alterar el orden de `getSignatureStatuses` → `getParsedTransaction` en el módulo extraído ⇒ rojo |
| AC-7 | `T-EVM-10` | Con el flag OFF: `x-payment-chain: solana-devnet` sigue dando **400** `CHAIN_INBOUND_PAYMENT_UNSUPPORTED` con el mismo mensaje y la misma lista | **M25**: hacer que el flag falte y se lea como ON ⇒ rojo |
| **AC-8** | `T-CAP-01` | Flag OFF ⇒ `/capabilities` publica `acceptsInboundPayment: false` para `solana-devnet` (suite existente, intacta) | — |
| AC-8 | `T-CAP-02` | Flag ON **y config completa** ⇒ `true`; y el guard del middleware **concuerda** con lo publicado en el mismo proceso | **M26**: darle a `/capabilities` su propia expresión de la capacidad ⇒ divergencia ⇒ rojo (el defecto de HU-208, CD-11) |
| AC-8 | `T-CAP-03` | Flag ON pero **falta** `SOLANA_X402_INBOUND_PAY_TO` (o el secreto) ⇒ `false` y el camino cerrado | **M27**: gatear sólo por el flag ⇒ rojo (CD-6) |
| **AC-9** 💰 | `T-KEY-01` | Espía sobre `getSolanaOperatorKeypair`: **cero** invocaciones en los 6 caminos inbound (grant + 5 rechazos) | **M28**: derivar el `payTo` del keypair del operador ⇒ rojo |
| AC-9 💰 | `T-KEY-02` | Espía sobre `sendRawTransaction` / `sendTransaction`: **cero** invocaciones en todo el camino inbound | **M29**: cualquier transmisión (p. ej. crear una ATA) ⇒ rojo |
| **CD-9** 💰 | `T-NOCONS-01` | Test paramétrico sobre los **5** motivos de rechazo: en los cinco, la firma sigue gastable (una presentación posterior válida concede) | **M30**: consumir en el camino de rechazo ⇒ rojo en los 5 |
| **CD-9** | `T-RETRY-01` | Sólo `unknown` y `absent` llevan `Retry-After`; monto insuficiente / mint distinto / referencia mala **no** | **M31**: mandar `Retry-After` en todos ⇒ rojo |
| **CD-14** | `T-MIG-01…04` | El `.sql` tiene la PK, `amount_atomic TEXT` (no NUMERIC), `REVOKE ALL` + `GRANT` sólo a `service_role`, `search_path` fijo en las 3 funciones, y el gate de re-hidratación en el `up` | **M32**: quitar el gate ⇒ rojo. **M33**: `amount_atomic NUMERIC` ⇒ rojo |
| **DT-12** 💰 | `T-CACHE-01` | Segunda petición con la fila en `observed`: **cero** llamadas al RPC (se asertan las llamadas, no sólo el resultado — CD-10c) | **M34**: re-preguntar a la cadena siempre ⇒ el conteo de llamadas sube ⇒ rojo |

**Reglas de la campaña de mutación** (CD-10, CD-13): cada mutante se reporta con **el nombre
del test que falló y el motivo**; `no tests` **no** cuenta como KILLED; antes de mutar, copia
física fuera del árbol de git + `sha256sum`, y verificación del hash al restaurar.

**Los ACs de dinero (💰) no se consideran cubiertos por "la suite pasa": se consideran
cubiertos por COBERTURA de sus líneas de guard + el mutante correspondiente muerto.**

---

## 11. Exemplars verificados

Todos verificados con `ls`/`Read` sobre el árbol real en la fecha del SDD.

| Para | Exemplar (path verificado) |
|---|---|
| Migración con dedup atómico y `p_probe` | `supabase/migrations/20260730000000_wkh307_solana_settle_intents.sql:149-305` |
| Uso único garantizado por el motor | `supabase/migrations/20260529000000_a2a_key_deposits.sql:16-18, 71-79` |
| `_down` que preserva + gate de re-hidratación | `supabase/migrations/20260730000000_wkh307_solana_settle_intents.sql` (bloque 0) + `…_down.sql` |
| Seam de datos fail-closed, uniones, clasificadores de error | `src/adapters/solana/settle-ledger.ts:15-45, 99-128` |
| Preflight memoizado single-flight | `src/adapters/solana/schema-preflight.ts:240-285` |
| Probe de presencia de 5 estados | `src/adapters/solana/payment.ts:557-644` |
| Validación de términos pura | `src/adapters/solana/payment.ts:1093-1130` |
| Resolución de config con `opts > env > default` | `src/adapters/solana/chain.ts:31-77` |
| Flag literal contra `'true'` | `src/adapters/registry.ts:63` |
| Capacidad única consumida por dos lugares | `src/adapters/registry.ts:510-525` + `src/routes/capabilities.ts:57-58` |
| Canal `unknown` (log + evento durable) | `src/middleware/x402.ts:674-730` |
| Resolución única de los requisitos de pago | `src/middleware/x402.ts:288-309` |
| Guard de chain con 400 estable y accionable | `src/middleware/x402.ts:479-497` + `:65-92` |
| Test de middleware con registry REAL | `src/middleware/x402.non-evm-inbound.test.ts:226-260` |
| Test de la capacidad pública | `src/routes/capabilities.inbound-chains.test.ts:118` |
| Test de predicado sobre un `.sql` (helper fuera de `*.test.ts`) | `test/helpers/sql-predicate.ts` (creado por WKH-307 justamente para no duplicar suites) |
| Programa Anchor devnet (medición de la opción b) | `/home/ferdev/.openclaw/workspace/solana-programs/programs/escrow/src/lib.rs` + `Anchor.toml:14-18` |

---

## 12. Scope IN / OUT (delta respecto del work-item)

### Scope IN
`supabase/migrations/20260731000000_wkh314_solana_inbound_proofs.sql` (+ `_down`) ·
`src/adapters/solana/presence.ts` (nuevo) · `src/adapters/solana/inbound-verify.ts` (nuevo) ·
`src/adapters/solana/inbound-preflight.ts` (nuevo) · `src/services/solana-inbound-proof.ts`
(nuevo) · `src/lib/solana-x402-challenge.ts` (nuevo) · `src/adapters/solana/payment.ts`
(delegación) · `src/adapters/solana/schema-preflight.ts` (**una** palabra: `export`) ·
`src/adapters/solana/chain.ts` · `src/adapters/types.ts` · `src/adapters/registry.ts` ·
`src/middleware/x402.ts` · `src/index.ts` · los 5 archivos de test nuevos + helpers ·
`.env.example` · `doc/INTEGRATION.md` · `doc/MULTI-CHAIN.md`.

### Cambios respecto del Scope IN del work-item
- **`src/services/compose.ts` SALE.** Evidencia y razonamiento en §3.
- **`src/adapters/solana/inbound-claim.ts` se mueve** a `src/services/solana-inbound-proof.ts`
  (DT-7: no violar el boundary CD-7 de WKH-307).
- **`src/middleware/x402.non-evm-inbound.test.ts` NO se reescribe**: queda verde intacto y las
  expectativas invertidas van a un archivo nuevo (CD-1, y la razón está ahí).

### Scope OUT (se mantiene el del work-item, §6)
`wasiai-facilitator` cero cambios · pared B (es WKH-315) · Solana Pay QR/UX/SDK del pagador
(el 402 publica la tupla; construir el QR no) · gasless para la tx del pagador · escrow
Anchor · reembolso automático · mainnet · reusar `a2a_x402_nonces` · cambiar el modo de pago
de los 3 agentes remit-\* · **y además**: arreglar el `.find()` de `checkTerms`
(TD-INBOUND-MULTI-ATA, DT-8) y mover el testigo al facilitator (DT-17).

---

## 13. Riesgos y qué NO pude determinar

| # | Riesgo | Mitigación / estado |
|---|---|---|
| R-1 | **Que una clave de 32 bytes inexistente no pueda ir como cuenta read-only en una transferencia SPL.** Es el supuesto de DT-6. | **No pude determinarlo en F2**: verificarlo exige firmar y transmitir una transacción, prohibido en esta fase. **Se mide** transmitiendo una transferencia SPL en devnet con una `reference` random y leyendo `getParsedTransaction`. Es la primera tarea de W1 y **bloquea** W1b. Si falla, DT-6 cae y se vuelve al memo. |
| R-2 | **Compatibilidad de wallets con la opción (b)** (destino off-curve). | **No pude determinarlo**: requiere instalar Phantom/Solflare/Backpack y probar en devnet. Irrelevante para la decisión tomada (§4.4 elige la (a)); se registra porque la próxima HU que retome la (b) lo va a necesitar. |
| R-3 | **El límite de tasa real** del endpoint RPC que usará la demo. | **No pude determinarlo** sin generar carga contra un servicio de terceros, que no voy a hacer. El límite documentado del endpoint público de Solana es del orden de 100 req/10 s por IP, pero **no lo verifiqué**. Mitigación de diseño: DT-10 (doble proveedor) y DT-12 (la cadena se pregunta una vez por pago, nunca en los reintentos). **Se mide** con una batería controlada contra el endpoint que se vaya a usar, en W2. |
| R-4 | El `.find()` de `checkTerms` produce un `landed_mismatch` falso si la wallet receptora tiene dos cuentas de token del mismo mint. | DT-8: preflight que falla ruidoso con motivo propio. No se cambia `checkTerms` (protege el leg de salida). |
| R-5 | Respuesta perdida después del consumo ⇒ pagador cobrado sin servicio. | **Residuo declarado y aceptado** (DT-12). Misma postura que el camino EVM hoy (`x402.ts:644-659`). Se mitiga consumiendo lo más tarde posible. No se resuelve acá. |
| R-6 | Conflicto de merge con WKH-315 en `adapters/solana/chain.ts` y `.env.example`. | Bajo pero real. Declarado en §7.2 con la tabla de propiedad por símbolo. |
| R-7 | La demo del 03/08 necesita, además de esta HU, que el pipeline de Chaski efectivamente pague por x402 Solana. | Fuera del alcance de este repo. El work-item §11.1 ya lo marca: **esta HU es necesaria pero no suficiente** para el entregable de los 3 agentes. |
| R-8 | `SOLANA_RPC_URL_FALLBACK` apuntando por error a mainnet. | CD-5 explícito + validación en `getSolanaFallbackConnection()`: un host de mainnet ⇒ fail-closed al arrancar, no un warn. |

---

## 14. Readiness Check

| Requisito | Estado |
|---|---|
| Todos los MI bloqueantes resueltos | ✅ MI-1 y MI-2 resueltos por el founder (§0); MI-3/4/5 resueltos en F2 (DT-6/11/9); MI-6 verificado; MI-7 fuera de alcance y declarado |
| Cero `[NEEDS CLARIFICATION]` abiertos | ✅ |
| Todo path citado verificado con `ls`/`Read` | ✅ §1 y §11 |
| Los números de la decisión (a)/(b) son **medidos**, no recordados | ✅ §4.1 (renta 2 039 280 lamports = 0.14982 USD = 4.99× el fee; retención 895 372 slots ≈ 4.15 días; barrido: cero instrucciones aptas en el programa deployado) |
| Uso único garantizado por el motor, no por lógica de aplicación | ✅ PK `(caip2, signature)` (§6.1) + mutación M8 que lo vigila |
| Tipo de ≥3 valores en cada eslabón | ✅ CD-3; `SettlementPresence` reusado; 3 uniones nuevas |
| Política ante `unknown` decidida y argumentada | ✅ §2 — rechazar sin consumir |
| Primitivo compartido: dueño, contrato y coordinación | ✅ §7, §7.1, §7.2 |
| CD-1 (EVM byte-idéntico) con prueba ejecutable | ✅ 8 suites verdes **sin modificarse** + `T-EVM-01…10` |
| ≥1 test por AC, con mutación nombrada para los de dinero | ✅ §10 — 34 tests, 33 mutantes + M-P1 |
| Auto-Blindaje histórico leído y convertido en CDs | ✅ 4 archivos leídos ⇒ CD-10…CD-14, con referencia a la entrada concreta |
| Waves con W0 serial de contratos | ✅ §9 |
| Devnet-only | ✅ CD-5, extendido al fallback |
| Cero código de producción escrito en F2 | ✅ el único artefacto de esta fase es este documento |
| **LISTO PARA `SPEC_APPROVED`** | ✅ |

---

## 15. Precondiciones de despliegue (para el runbook de F3/F4)

1. **Aplicar `20260731000000_wkh314_solana_inbound_proofs.sql` a bdwv ANTES de deployar el
   código.** Nunca a caldz (regla del founder). Sin la migración, el preflight falla-closed y
   el inbound Solana no verifica: degradación ruidosa y recuperable, no un servicio gratis.
2. **Setear `SOLANA_X402_INBOUND_PAY_TO`** con la **pubkey** base58 de la wallet receptora, y
   verificar que tenga **exactamente una** cuenta de token para el mint configurado (DT-8).
   **Nunca** una clave privada en esta variable.
3. **Setear `SOLANA_X402_INBOUND_CHALLENGE_SECRET`** con un secreto de alta entropía. Nunca en
   logs, nunca en el repo.
4. **Setear `SOLANA_RPC_URL_FALLBACK`** con un **segundo proveedor de devnet distinto del
   primario** (que sean el mismo endpoint anula DT-10 entero: un `unknown` tiene que ser caro
   de provocar, y dos llamadas al mismo nodo caído no lo son).
5. **Recién entonces** `SOLANA_X402_INBOUND_ENABLED=true`. Antes de eso todo el cambio es
   inerte por construcción (DT-11).
