# AR — WKH-314 · x402 inbound en Solana

**Veredicto: RECHAZADO** — 2 `BLQ-ALTO`, 3 `BLQ-MED`, 1 `BLQ-BAJO`, 3 `MNR`.

Rama atacada: `feat/212-wkh-314-x402-inbound-solana-f3`, commit `e8abe36`, base `main@75de7eb`.
Instrumentos: todo `git` con `/usr/bin/git` (el hook `rtk` trunca `git diff`). Repros con
`./node_modules/.bin/tsx` en scratchpad único. Suite dirigida `--maxWorkers=1`, JSON validado por
raíz (`testResults[].name` bajo `/wasiai-a2a/`): **160 passed / 0 failed** en 9 archivos.
El AR **no tocó** `src/`, `test/` ni migraciones.

---

## BLQ-ALTO-1 · el monto del sobre nunca se compara contra el precio de ESTE request

`src/middleware/x402.ts:643` + `:690` + `:841`

`resolveSolanaPaymentRequirements` resuelve `requiredAmount` una vez (`:643`) y lo usa **sólo** para
construir el challenge (`:690`). Después de P2 todo el camino usa `presented.amountAtomic`, que sale
del sobre del cliente:

```ts
// x402.ts:841
requiredAtomic: presented.amountAtomic,
```

No existe en la rama Solana el equivalente del guard EVM de `x402.ts:1211`:

```ts
if (BigInt(auth.value) < BigInt(requiredAmount)) bindingOk = false;
```

El MAC prueba *"este sobre lo emitimos nosotros"*, **no** *"este es el precio de ahora"*. Y el precio
del mismo `resource` **varía por request**: `src/routes/compose.ts:505` calcula el total sobre el
**body**, mientras `resource` es `protocol://hostname + request.url` (`x402.ts:1052`), o sea
`/compose` a secas.

### Repro (salida literal)

```
reference BARATA : FLUoYAsm9Z16H4UqHHdRzhMCmL1z1BazGd7z64vFW8Tq
reference CARA   : 13bECkpGJvD4DkWUVz9cdBRLKhGgj2WFb9LhTdSr6tNL
mismo resource   : true
VEREDICTO del sobre barato en el request caro: {"state":"valid"}
requiredAtomic que usaria la cadena (x402.ts:841) = 1
requiredAmount que el servidor acababa de resolver = 50000000
```

1. `POST /compose` con pipeline barato → 402 con `maxAmountRequired: "1"` (piso de `compose.ts:501`).
2. El atacante transfiere **1 unidad atómica = 0,000001 USDC** con esa `reference` y espera finalidad.
3. Dentro de los 900 s (`solana-x402-challenge.ts:55`), `POST /compose` con un pipeline de 50 USDC
   presentando el sobre viejo. `verifySolanaChallengeReference` da `valid`, la cadena se consulta
   contra `requiredAtomic: '1'`, `creditedAtomicSum` da 1 ≥ 1 → `finalized_ok` → **acceso concedido**.

**Plata:** el gateway paga a los agentes downstream el pipeline completo y cobra 0,000001 USDC.
Repetible. No hay reembolso inbound en el camino x402 (el bloque de refund está gateado en
`request.a2aKeyRow`, `compose.ts:459`).

**Rompe el contrato del propio Story File** (`story-file.md:544`): *"El monto sale de UNA sola
resolución reusada por el challenge y por el binding (CD-11)"*. Hay dos expresiones y divergen.

**Cobertura:** `src/middleware/x402.solana-inbound.test.ts` tiene 29 `it()` y **todos** arman el sobre
con `envelope(c, sig)` donde `c = await getChallenge(app)` — el challenge del mismo request. Control
positivo: `grep "amountAtomic: '"` da un hit (`:458`) y es un fixture de `peek`.

**Fix:** comparar `BigInt(presented.amountAtomic) >= BigInt(requiredAmount)` antes de P3, con el
`requiredAmount` de `:643`. Misma clase de agujero en `presented.payTo` y `presented.mint`, que
tampoco se cruzan contra `getSolanaInboundPayTo()` / `getSolanaUsdcMint()`.

---

## BLQ-ALTO-2 · la `reference` sin entropía por pedido permite ROBAR el pago de otro

Agrava con medición lo que el dev declaró como T-CHAL-02b *"inocuo porque el single-use vive en la
firma"*. **La afirmación es falsa**: el ledger de uso único no puede distinguir a los dos callers.

`src/lib/solana-x402-challenge.ts:86-104` + `:155` — el material del MAC es
`resource|payTo|amount|mint|network|issuedAt|expiresAt`. Nada por caller, nada por pedido.
`issuedAt` tiene granularidad de 1 segundo (`:140`).

### Repro (salida literal)

```
issuedAt victima  : 1787154138
issuedAt atacante : 1787154138
reference victima : 4QZ1JdJ1gbDTDi6A7TpR3CemimYVLaMyveRMXw3XMeuF
reference atacante: 4QZ1JdJ1gbDTDi6A7TpR3CemimYVLaMyveRMXw3XMeuF
MISMA REFERENCE   : true
TERMINOS IDENTICOS para el store: true
```

Los 5 campos que compara el store (`migration:209-213`, `:297-301`) —
`reference, resource, pay_to, amount_atomic, mint` — salen byte-idénticos. `issuedAt`/`expiresAt` no
están en la tabla.

1. El atacante pide un 402 por segundo a un endpoint de precio estable. Sostiene un sobre válido para
   prácticamente cada segundo.
2. La víctima recibe un 402 en el segundo T y transfiere USDC con esa `reference`.
3. El atacante consulta `getSignaturesForAddress(reference)` — la mecánica Solana Pay que este mismo
   diseño usa (`inbound-verify.ts:210` la busca en `accountKeys`). La firma de la víctima es pública
   desde que aterriza.
4. El atacante presenta esa firma con **su propio** sobre. P2 valida (misma reference), P3 `none`,
   P4/P5 `finalized_ok` + `bound`, P6 escribe, **P7 consume** (`x402.ts:969`) → servicio al atacante.
5. La víctima presenta la suya → `X402_SOLANA_PROOF_REPLAY` (`x402.ts:805-811`).

**Plata:** la víctima transfirió USDC en cadena, no recibe servicio, no hay reembolso, y el mensaje le
dice que su firma *"ya se usó para obtener servicio"*.

**El peek lo amplifica:** `x402.ts:820-836` — si la fila ya está `observed` con términos iguales, se
saltean `getSignatureStatuses` y `getParsedTransaction` completos.

**Fix:** entropía por emisión en el material del MAC, devuelta en `extra` para que el pagador la
eco-repita (queda sin estado: el MAC la cubre).

---

## BLQ-MED-1 · un nodo que dice "la tx FALLÓ on-chain" pierde contra otro que dice `finalized_ok`

`src/adapters/solana/inbound-verify.ts:39-54` — `presenceRank`: `terms_mismatch`=0,
`finalized_ok`=1, `landed_failed`=2.

El archivo declara la doctrina en `:16-21` (*"ante una anomalía sobre dinero se deniega"*) y la aplica
a `terms_mismatch` (pegajoso) pero **no** a `landed_failed`, que es el mismo tipo de aserción positiva
sobre una transacción inmutable.

### Repro (salida literal)

```
primario dice FALLO on-chain / fallback dice finalized_ok => finalized_ok  *** CONCEDE ***
primario dice finalized_ok / fallback dice FALLO on-chain => finalized_ok  *** CONCEDE ***
primario dice finalized_ok / fallback dice not_finalized  => finalized_ok  *** CONCEDE ***
CONTROL: primario finalized_ok / fallback terms_mismatch  => terms_mismatch  (deniega)
```

Un `landed_failed` **es evidencia positiva de que nada se movió** (`inbound-presence.ts:145-147`,
`:273-275`); resolverlo como grant entrega servicio contra una transferencia que no transfirió.

**Derriba la premisa del docblock `:8-14`** (*"Con dos, hace falta voltear los dos"*): para un grant
falso alcanza con UN nodo — `finalized_ok` gana contra `unknown`(5), `absent`(4), `not_finalized`(3) y
`landed_failed`(2).

**Fix:** `landed_failed` a rank 0 junto a `terms_mismatch`, o pegajoso explícito.

---

## BLQ-MED-2 · la rama Solana quema la prueba aunque el 504 ya haya salido

`src/middleware/x402.ts:634-999`: `reply.sent` aparece **una sola vez**, en `:997`, y sólo para el
header. El camino EVM lo chequea seis veces (`:1257, :1270, :1297, :1366, :1390, :1468`) con el
comentario que lo explica en `:1255`.

`src/middleware/timeout.ts:12-20` manda el 504 desde fuera del lifecycle, registrado como preHandler
en `src/routes/compose.ts:38` y `src/routes/orchestrate.ts:25`. Después del arranque del timer la
rama Solana tiene: `:679` preflight, `:804` peek, `:846` RPC primario, `:853` RPC fallback, `:943`
observe, `:969` **consume**.

**Ninguna de las dos llamadas RPC tiene timeout ni `AbortSignal`** (`inbound-presence.ts:125`, `:369`)
y corren en serie. El dev midió que `api.devnet.solana.com` le daba `429` e `Internal error`: el
escenario lento es el endpoint del runbook.

**Plata:** el pagador transfirió USDC, recibió un 504, y su reintento devuelve
`X402_SOLANA_PROOF_REPLAY`. Pagó y no tiene nada. Distinto del residuo declarado en `:625-628`: acá la
respuesta **ya se sabe enviada** antes de consumir.

**Fix:** `if (reply.sent) return;` antes de P7 (`:969`) + timeout explícito en las dos llamadas RPC.

**Medido y descartado como causa alterna:** con Fastify 5 + `createTimeoutHandler` real, el segundo
`.send()` **no lanza** (`504`, `throw=null` con y sin guard). El problema no es la excepción: es el
consumo irreversible.

---

## BLQ-MED-3 · CD-5 "devnet-only" no se enforcea sobre el RPC PRIMARIO

Agrava el punto 5 del dev. No es sólo que el guard "acota, no cierra" ante un hostname opaco: es que
**no se aplica a la variable que importa**.

```
$ /usr/bin/grep -rn "looksLikeMainnetRpc" src/ test/
src/adapters/solana/chain.ts:261:function looksLikeMainnetRpc(url: string): boolean {
src/adapters/solana/chain.ts:284:  if (looksLikeMainnetRpc(raw)) {

$ /usr/bin/grep -rn "getSolanaRpcUrl" src/ | grep -v test
src/adapters/solana/chain.ts:39:export function getSolanaRpcUrl(): string {
src/adapters/solana/chain.ts:75:  _connection = new Connection(getSolanaRpcUrl(), getSolanaCommitment());
```

Un solo call-site, dentro de `getSolanaFallbackConnection` (`:284`). `getSolanaRpcUrl()` (`:39-41`)
lee `SOLANA_RPC_URL` sin validación y `:75` construye la `Connection` **primaria** con ella. El
primario es obligatorio; el fallback es opcional.

**Input:** `SOLANA_RPC_URL=https://api.mainnet-beta.solana.com` + las 4 envs del inbound. El preflight
pasa (`inbound-preflight.ts:170-178` sólo llama al fallback), el rail arranca, y toda la verificación
de cobros se hace contra **mainnet**.

**Prosa que afirma de más:** `story-file.md:755` (*"NO hay mainnet… sin RPC de mainnet"*) y
`doc/architecture/MULTI-CHAIN.md` (*"devnet-only"*). Ninguna tiene mecanismo detrás para el primario.

**Fix:** aplicar `looksLikeMainnetRpc` a `getSolanaRpcUrl()` **desde el preflight inbound** (no desde
`getSolanaConnection()`, compartida con el leg de salida), o corregir las dos frases.

---

## BLQ-BAJO-1 · el gateway afirma que "dos nodos independientes buscaron" cuando buscó uno

`src/middleware/x402.ts:900-905`: *"two independent nodes searched their transaction history and do
not know that signature."*, y la misma frase en `doc/INTEGRATION.md`.

```
UN solo nodo dice absent, sin fallback => {"state":"absent"} => "TWO independent nodes searched"
CONTROL con fallback unknown           => unknown
```

`inbound-verify.ts:68` (`if (fallback === null) return primary;`) devuelve el `absent` de un solo nodo
tal cual. Nada obliga al fallback: `inbound-preflight.ts:171` lo llama sólo para atrapar el throw de
mainnet, y no chequea `null`.

Sin pérdida de fondos (la prueba no se consume, es reintentable) ⇒ BAJO.

---

## MENORes

- **MNR-1** — `SOLANA_RPC_URL_FALLBACK` ausente degrada DT-10 a un proveedor **en silencio**: sin warn
  de arranque y sin chequeo de que sea distinto de `SOLANA_RPC_URL` (que `.env.example` pide en prosa).
  Falla en la dirección segura (más `unknown`, nunca un grant).
- **MNR-2** — `X402_SETTLE_UNKNOWN` afirma más de lo que el código garantiza: *"We do not consume your
  proof on that path"* (`doc/INTEGRATION.md`, `x402.ts:987`). Si el `UPDATE` commitea y la respuesta
  del RPC se pierde, `solana-inbound-proof.ts:310` da `store_unavailable` y la afirmación es falsa.
- **MNR-3** — los 29 `it()` derivan siempre el sobre del challenge del mismo request. No hay un test
  con sobre emitido a **otro precio**, ni con **dos callers** compartiendo referencia. Ése es el hueco
  por el que pasan BLQ-ALTO-1 y BLQ-ALTO-2; **los 20 mutantes muertos no lo tocan porque ningún
  mutante puede introducir un test que no existe.**

---

## Veredicto sobre los 7 puntos que el dev declaró

| # | Punto | Veredicto |
|---|---|---|
| 1 | NC-2: DT-6 sin verificar | **MENOR.** Si el supuesto es falso, `readInboundBinding` da `reference_absent` (`inbound-verify.ts:229-233`) ⇒ nadie puede pagar. Falla **cerrado**: riesgo de disponibilidad, no de cobrar de menos. |
| 2 | `finalized` → `confirmed` | **OK.** Una tx `finalized` es inmutable y la finalidad se prueba antes con `getSignatureStatuses` (`inbound-presence.ts:149`). Si el parse da `null`, `readInboundTerms(undefined)` (`:264-272`) da `unknown` ⇒ deny reintentable sin consumir. |
| 3 | T-CHAL-02b "inocuo" | **FALSO — ver BLQ-ALTO-2.** Los términos que el store compara son idénticos entre dos callers distintos (medido). |
| 4 | Preflight (5) avisa, no falla | **OK.** `creditedAtomicSum` suma sobre todas las entradas del `payTo`; 2 ATAs es un caso correcto. La colisión peligrosa sí falla cerrada (`inbound-preflight.ts:107-129`). |
| 5 | Guard anti-mainnet | **Peor de lo declarado — BLQ-MED-3.** |
| 6 | `database.types.ts` / `:2567` | **OK, verificado.** El único hunk arranca en `@@ -2929,6 +2929,61 @@`; la cita (`cited-lines-guard.citations.ts:709-714`) intacta y el guard verde. |
| 7 | 3 funciones `SECURITY DEFINER` | **OK, verificado.** `grep "a2a_solana_inbound_proofs" src/` da un hit y es un comentario (`database.types.ts:2934`) — cero `.from()`. Control positivo: el mismo grep sobre `a2a_solana_settle_intents` sí encuentra `.from()` (`settle-ledger.ts:552, :603`). `SET search_path`, `REVOKE ... FROM PUBLIC, anon, authenticated`, `GRANT` sólo a `service_role`, sin SQL dinámico. |

---

## Lo que el AR NO pudo medir (sus palabras)

- **DT-6 contra la cadena.** No firmó ninguna transferencia devnet: sin keypair fondeada. Sigue **sin
  verificar empíricamente**. Lo que sí afirma es la dirección del fallo: cerrada.
- **La carrera real de BLQ-ALTO-2 contra el reloj de devnet.** Midió que las referencias y los términos
  colisionan; **no midió** cuánto tarde puede presentar el atacante, ni si un rate-limit de producción
  le impide sostener un 402 por segundo. No lo estima.
- **La aplicación de la migración contra bdwv.** No la corrió. `test/wkh314-inbound-proofs.migration.test.ts`
  es un test de predicados sobre el SQL; la lectura de las 3 funciones es estática.
- **Cobertura y mutación de los archivos nuevos.** No corrió `test:coverage` ni un barrido propio:
  aceptó los 20/20 del dev y buscó lo que esos mutantes no pueden tocar. MNR-3 es el resultado.

---

## Orden del fix-pack

1. **BLQ-ALTO-1** — comparar el monto del sobre contra el precio resuelto del request (y `payTo` y `mint`).
2. **BLQ-ALTO-2** — entropía por emisión en el material del MAC.
3. **BLQ-MED-1** — `landed_failed` pegajoso.
4. **BLQ-MED-2** — `if (reply.sent) return` antes de P7 + timeout en las dos llamadas RPC.
5. **BLQ-MED-3** — guard anti-mainnet sobre `SOLANA_RPC_URL`, o corregir las dos frases.
6. **BLQ-BAJO-1** — que el mensaje de `PROOF_ABSENT` diga cuántos nodos buscaron de verdad.
