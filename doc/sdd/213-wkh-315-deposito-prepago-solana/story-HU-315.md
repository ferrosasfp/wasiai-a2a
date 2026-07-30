# Story File — HU WKH-315: la pared B, fondear la clave prepaga en Solana (deposit inbound)

> SDD (autoritativo, leelo antes de codear): `doc/sdd/213-wkh-315-deposito-prepago-solana/sdd.md`
> Work item: `doc/sdd/213-wkh-315-deposito-prepago-solana/work-item.md`
> Branch: `feat/213-wkh-315-deposito-prepago-solana` · Worktree: `/home/ferdev/.openclaw/workspace/wt-315`
> Modo: **QUALITY** · money-path de **ENTRADA** · multi-VM · Estimación **M/L**
> Devnet. Plata NO real. Migraciones **sólo a `bdwv`**, JAMÁS a `caldz`.

Este archivo es tu contrato. **No repite el SDD**: lo referencia por sección (§). Lo que sí está
completo acá es todo lo que no se puede perder al bajar el diseño a tareas: archivo, ancla por
contenido, qué cambia, qué AC satisface, qué test lo prueba y qué mutante lo canda.

**Si algo de acá te resulta ambiguo, parate y preguntá.** No inventes: el SDD ya pasó gate y las
decisiones que tomó no son tuyas para reinterpretar. Los tres puntos donde el SDD quedó corto están
marcados como `[SDD GAP]` en §10 con la resolución mínima ya escrita — no hay nada más que decidir.

---

## 0. Qué se construye, en tres frases

Hoy `POST /auth/deposit` rechaza una firma base58 en su primera línea de validación
(`deposit.ts:57`,`:63`) y su verificador es viem de punta a punta, así que **todo dólar que entra al
sistema entra por Avalanche/Base/Kite**. Esta HU abre la entrada por Solana: el owner **prueba
control de una wallet Solana con una firma ed25519**, manda USDC de devnet a la ATA de depósito del
gateway, presenta la firma, y el gateway **verifica en cadena a nivel `finalized` antes de acreditar**
y acredita **exactamente una vez**, con una clave de unicidad que **no depende de ninguna variable de
entorno**.

El camino EVM queda **byte-idéntico** (CD-1). Eso no es un deseo: es la condición de aceptación que
se prueba con las cuatro suites existentes verdes **sin editarse**.

### 0.1 Precondición operativa del worktree — hacelo antes de la primera línea

**El worktree `wt-315` no tiene `node_modules`** (verificado: `ls node_modules` → no existe; sí hay
`package-lock.json`). Sin eso ni `npx tsc --noEmit` ni `vitest` corren, y el error que vas a ver
(`Cannot find package 'vitest'`) parece un problema de config y no lo es.

```bash
cd /home/ferdev/.openclaw/workspace/wt-315
npm ci
npx vitest run            # ← BASELINE: anotá "N passed | M skipped" ANTES de tocar nada
```

**Anotá el baseline en el done-report.** El número final se reporta como `baseline + nuevos`, y si se
aleja, se explica. No hay tests que eliminar en esta HU: todo es aditivo.

---

## 1. Las ocho cosas que no podés no entender

### 1.1 La prueba ed25519 — el primitivo ya está MEDIDO, no lo busques de nuevo (§5 del SDD)

`node:crypto` verifica ed25519 nativo. **CERO dependencias nuevas** (PROHIBIDO `tweetnacl`: no está
declarada en `package.json`, entra sólo como transitiva de `@solana/web3.js`; `solana/base58.ts:8-11`
documenta la decisión de la casa para el caso idéntico de `bs58`).

La receta, medida en vivo por el SDD (`spki der len 44`, `verify ok: true`, `verify tampered: false`):

1. pubkey ed25519 cruda de **32 bytes**;
2. prefijo **SPKI DER fijo de 12 bytes**: `302a300506032b6570032100` → concatenado da 44 bytes;
3. `crypto.createPublicKey({ key: <der 44 bytes>, format: 'der', type: 'spki' })`;
4. `crypto.verify(null, <mensaje utf8>, keyObject, <firma 64 bytes>)`. El `null` como algoritmo es
   **correcto y obligatorio** para Ed25519 (la curva ya define el hash).

Mensaje canónico, **nuevo y namespaceado**, con el `key_id` del caller autenticado (NUNCA del body):

```
WASIAI_BIND_FUNDING_WALLET_SOLANA:<key_id>
```

**Gotcha de endianness que te va a costar horas si no lo lees ahora.** `isValidSolanaAddress`
(`wallet-format.ts:50-71`) sólo devuelve `boolean`, no los bytes, así que `ed25519.ts` necesita su
**propio decoder** (PROHIBIDO `base58DecodeToBytes` de `solana/base58.ts:62`: **lanza** con el
literal `'SOLANA_OPERATOR_PRIVATE_KEY is not valid base58'` y eso no puede pasarle a un input del
caller). El algoritmo base-x de `wallet-format.ts:52-69` acumula **little-endian**: `bytes[0]` es el
byte menos significativo y los `1` iniciales se empujan al FINAL del array. El orden real de la
pubkey es **`bytes` invertido**. Si no invertís, `crypto.verify` devuelve `false` para todo y parece
que la firma está mal.

> **Canario obligatorio** (`T-315-08e`): el decoder de `ed25519.ts` sobre la base58 de una pubkey
> generada con `Keypair.generate()` tiene que dar **exactamente** `keypair.publicKey.toBytes()`. El
> test importa `@solana/web3.js`; el módulo de producción **no** (sigue siendo leaf).

**Despacho: por un campo explícito, NUNCA por olfateo del formato.** El body de
`POST /auth/funding-wallet` gana `namespace?: 'evm' | 'solana'`, **default `'evm'`**. Un caller EVM de
hoy manda `{wallet, signature}` sin `namespace` ⇒ rama EVM byte-idéntica. `namespace` con un valor no
reconocido ⇒ **400 `INVALID_INPUT`** (fail-closed, **no** default a EVM). El tipo
`WalletNamespace = 'evm' | 'solana'` **ya existe** y se exporta de `wallet-format.ts:73` — reusalo, no
declares otro.

*Por qué no despachar por formato, aunque los dos predicados sean hoy mutuamente excluyentes: elegir
qué **gate de seguridad** se aplica en base a una coincidencia de charset es el tipo de acoplamiento
implícito que se rompe en silencio.*

Y `verifyEd25519Base58(...): boolean` **no viola CD-3**: un cómputo criptográfico local no tiene "no
pude preguntar" — no hay sistema externo. CD-3 gobierna las consultas a la cadena y a la base.
Cualquier fallo (decode, longitud, verificación) ⇒ `false` ⇒ **403 `FUNDING_WALLET_PROOF_INVALID`**,
el mismo código que la rama EVM.

### 1.2 Footgun 1 — el destino: el reuso ingenuo tiene que NO COMPILAR (AC-14 / CD-5)

`resolveTreasury('solana-devnet')` (`deposit-verifier.ts:111-126`) busca
`A2A_DEPOSIT_TREASURY_SOLANA`, lo testea contra `ADDRESS_RE = /^0x…{40}$/` (`:59`,`:114`) — **una
pubkey base58 falla** — y **cae al fallback `privateKeyToAccount(OPERATOR_PRIVATE_KEY).address`**
(`:117-124`). O sea: devuelve **una dirección EVM** como destino esperado de un depósito Solana, en
silencio.

El cierre **no es un comentario, es el compilador**:

```ts
export type EvmChainKey = Exclude<ChainKey, 'solana-devnet'>;
export function isEvmChainKey(k: ChainKey): k is EvmChainKey {
  return getChainVmFamily(k) === 'evm';   // proyección PURA y exhaustiva, chain-resolver.ts:98
}
export function resolveTreasury(chainKey: EvmChainKey): `0x${string}` | null { /* cuerpo BYTE-IDÉNTICO */ }
```

**El cuerpo de `resolveTreasury` y de `verifyDeposit` no cambia una línea.** Sólo firmas y tipos.

Call-sites de `resolveTreasury`, verificados con grep exhaustivo — son **exactamente dos**, ninguno en
tests: `deposit.ts:218` (deposit-info) y `deposit-verifier.ts:304` (dentro de `verifyDeposit`).
El segundo es el que el SDD no resolvió → ver **`[SDD GAP #2]` (§10)**: la resolución está escrita, no
la improvises.

### 1.3 Footgun 2 — `finalized`: literal de módulo, y la ausencia de status es `unknown` (AC-2 / CD-7)

```ts
const DEPOSIT_COMMITMENT = 'finalized' as const;   // en src/adapters/solana/deposit-verifier.ts
```

**PROHIBIDA cualquier env que lo debilite.** Una variable capaz de bajar una garantía de dinero es el
mismo footgun que un `SKIP_`. La única forma admitida de una salida por env en esta casa es
**declarar una afirmación del operador** (exemplar: `SOLANA_RPC_LEDGER_HISTORY_DECLARED_SUFFICIENT`,
`schema-preflight.ts:120`), y acá **no hay nada que el operador pueda afirmar en lugar de la cadena**.

Y la finalidad **se LEE, no se hereda**. `getSignatureStatuses` devuelve `confirmationStatus` por
firma — en el tipo del SDK es **opcional**, así que la ausencia es un caso real, no paranoia:

| `confirmationStatus` | veredicto | HTTP |
|---|---|---|
| `'finalized'` | seguir (evidencia **positiva**) | — |
| `'processed'` / `'confirmed'` | `not_finalized` — negativa **medida**, reintentable | 400 `DEPOSIT_NOT_FINALIZED` |
| **ausente / desconocido** | **`unknown`** — NO "todavía no" | **503 `DEPOSIT_VERIFICATION_UNKNOWN`** |

Los términos también se leen a `finalized`: `getParsedTransaction(signature, { commitment:
'finalized', maxSupportedTransactionVersion: 0 })`. **NO** uses `getSolanaCommitment()` (default
`confirmed`, `chain.ts:43-46`) ni heredes el commitment de la `Connection` compartida: el override es
**por llamada**, así que podés reusar la `Connection` cacheada de `getSolanaConnection()` sin
contaminar el settle.

> Honestidad para que el AR no lo levante como hallazgo nuevo: `payment.ts:619` y `:1141` leen a
> `'confirmed'` **a propósito y con su razón escrita**. Son del camino de SALIDA y quedan intactos.

### 1.4 Footgun 3 — el sentinel: la unicidad la impone un ÍNDICE SIN `chain_id` (AC-13 / CD-8)

`SOLANA_SYNTHETIC_CHAIN_ID` es **cambiable en caliente** (`chain.ts:65-70`) y la clave actual es
`UNIQUE (chain_id, tx_hash)` (`20260529000000:17`). Cambiar el sentinel **re-abre todos los depósitos
Solana pasados para re-crédito**: misma firma + otro `chain_id` = otra fila, sin colisión.

Se cierra **en la base**, no con un guard:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS uq_a2a_key_deposits_solana_sig
  ON a2a_key_deposits (tx_hash) WHERE vm_family = 'solana';
```

Tres propiedades: (1) **no menciona `chain_id`** ⇒ ninguna mutación de env crea una segunda fila
creditable; (2) `UNIQUE (chain_id, tx_hash)` **queda intacto** ⇒ EVM byte-idéntico; (3) el
`EXCEPTION WHEN unique_violation THEN RAISE 'DEPOSIT_ALREADY_CREDITED'`
(`20260529000000:77-79`) es **agnóstico de qué índice se violó** ⇒ el 409 se hereda **sin una línea
de plpgsql nueva**.

**Si alguien cambia el sentinel**, el peor caso pasa a ser *un bucket de saldo que no se puede gastar
desde el bucket viejo* (recuperable, visible) en vez de *saldo duplicado* (irreversible). Cuando los
dos errores no cuestan lo mismo, el default va del lado barato. **PROHIBIDO** agregar el alias
`'900001'` a `SLUG_ALIASES` (`chain-resolver.ts:20-68` es un mapa PURO que no lee env; con
`SOLANA_SYNTHETIC_CHAIN_ID=900002` el alias seguiría ruteando y saldría un `CHAIN_MISMATCH`
inexplicable). El caller Solana manda el header `x-payment-chain: solana-devnet`.

### 1.5 La migración — `bdwv` JAMÁS `caldz`, el `DROP FUNCTION`, y el `_down` es la mitad de un CICLO

Tres cosas, ninguna opcional:

1. **`DROP FUNCTION IF EXISTS register_a2a_key_deposit(uuid,integer,numeric,text,text,text);` ANTES
   del `CREATE OR REPLACE` de 7 params.** Sin eso, `CREATE OR REPLACE` con tipos de entrada distintos
   crea una **SOBRECARGA** y el caller recibe `function ... is not unique`. Es el bug documentado en
   `20260529000000:27-31` (FIX-2/MNR — ojo: el SDD §4.7-3 lo cita como `:148-155`, que **no existe**;
   el archivo tiene 104 líneas. La cita correcta es `:27-31` + el `DROP` en `:32`).
2. **El `_down` archiva y el `up` re-hidrata.** El `_down` **destruye datos** (`DROP COLUMN
   vm_family`), así que un ciclo `down → up` deja todas las filas Solana con `vm_family='evm'` y su
   unicidad **vuelve a depender del sentinel**: se re-abren para re-crédito. Por eso:
   - `_down`: `CREATE TABLE IF NOT EXISTS a2a_key_deposits_solana_backup_wkh315 AS SELECT id, tx_hash
     FROM a2a_key_deposits WHERE vm_family='solana';` **antes** de dropear la columna;
   - `up`: **re-hidratar** `vm_family='solana'` desde ese backup si la tabla existe, **antes** de
     crear el índice parcial.
   *Es el mismo bug que WKH-307 §MNR-4 documentó, en otra ropa (CD-17).*
3. **Destino `bdwv` únicamente.** Aplicarla es **W3.4, founder-gated**. En W0.3 la migración se
   **escribe y no se aplica a ninguna base**.

### 1.6 NO consumas `probeSettlementPresence` y NO toques `payment.ts` (§7.1 del SDD)

Te va a tentar reusar el probe que ya existe. **El SDD probó que ese reuso sería incorrecto**, con dos
evidencias:

1. Su veredicto de términos **exige monto y destino conocidos de antemano**:
   `probeSettlementPresence(proof: SolanaSettleProof)` (`payment.ts:572-574`) saca su
   `landed_ok`/`landed_mismatch` de `checkTerms(parsed, proof)` (`:640`), que compara
   `delta < BigInt(proof.amountAtomic)` con `owner === proof.payTo` (`:1110-1128`). **Un depósito no
   conoce el monto: lo DESCUBRE.** Invocarlo obligaría a fabricar un proof con `amountAtomic: '0'`, y
   entonces `landed_ok` significaría *"el saldo no bajó"*: **un guard de dinero que siempre pasa**. No
   es reuso, es un falso verde con forma de reuso, y un AR lo marcaría BLOQUEANTE con razón.
2. **Lee a `'confirmed'` hardcodeado** (`:619`) y su `SettlementPresence` **descarta**
   `confirmationStatus` (sólo mira `status.err`, `:601`) ⇒ su `landed_ok` **no implica `finalized`** y
   no puede sostener CD-7.

**Lo compartido es la DOCTRINA, no la función**: tres valores mínimo, `getSignatureStatuses` +
`searchTransactionHistory` como **única** fuente de una negativa, `unknown` para todo lo demás, nunca
lanzar. Copiá esa forma (`payment.ts:572-644` es tu exemplar de lectura) y **no modifiques
`payment.ts` ni un byte** — es de WKH-314 y es el único archivo con solapamiento no trivial.

### 1.7 El camino EVM byte-idéntico, y el ÚNICO delta observable declarado (CD-1 / AC-10)

**Prueba exigida**: `src/routes/auth.test.ts`, `src/adapters/deposit-verifier.test.ts`,
`src/adapters/escrow-verifier.test.ts` y `src/services/budget.test.ts` quedan **verdes sin
modificarse**. Un test que haya que tocar es **señal de regresión, no de refactor**.

Dos verificaciones que ya hice para que no las repitas:
- `auth.test.ts:447` usa `tx_hash: '0xbad'`, que **falla los dos predicados** (el alfabeto base58 no
  contiene `'0'`) ⇒ sigue dando `INVALID_INPUT` en el mismo lugar;
- ningún test llama `resolveTreasury` ni pasa `chainKey: 'solana-devnet'` a `verifyDeposit`.

**Delta observable único, declarado**: `{tx_hash: <firma base58>, chain_id: <inexistente>}` pasa de
`INVALID_INPUT` a `CHAIN_NOT_SUPPORTED`. Antes era **inalcanzable** (toda firma base58 moría en el
paso 2), así que ningún cliente EVM existente puede observarlo. Si encontrás un segundo delta, **es un
hallazgo: reportalo, no lo absorbas**.

### 1.8 El depositante es el owner que BAJA, y si hay dos, se rechaza (AC-7 / AC-15)

El análogo de `Transfer.from` en Solana es el **owner de la cuenta de origen**: la entrada del mint
cuyo delta es **negativo**, leída de `preTokenBalances` (que es donde el `owner` está poblado aun si
la cuenta se cierra en la misma tx). **No es el fee-payer**: en Solana el fee-payer puede ser un
tercero (gasless) y no tiene por qué haber puesto los fondos.

- exactamente **un** owner de origen distinto ⇒ ése es el depositante;
- **dos o más** ⇒ **`DEPOSITOR_AMBIGUOUS`**, fail-closed, sin acreditar y **sin consumir la prueba**.
  Adivinar cuál de dos es el depositante es exactamente donde se pierde el gate;
- **cero** (imposible si el delta de destino es `> 0`, pero el compilador no lo sabe) ⇒
  `DEPOSITOR_AMBIGUOUS`, **nunca** un `undefined` que se cuele.

Y el gate contra la wallet bindeada es **byte-exacto**: `result.depositor ===
callerKey.funding_wallet_solana`, **sin `toLowerCase()` en ningún lado** (CD-6/AC-8). Bajar a
minúsculas una pubkey base58 la destruye, y el índice UNIQUE es case-sensitive por ser `TEXT` en
Postgres.

> **Por qué el gate no es opcional** (CD-2, BLOQUEANTE automático en AR si se saltea): las firmas de
> una cuenta son **públicas** vía `getSignaturesForAddress` sobre la ATA de depósito. Un atacante no
> necesita front-runear nada: hace polling, toma la firma del depósito ajeno y la presenta como
> propia. Y el **UNIQUE que existe para proteger garantiza que el legítimo pierda**. Con el gate, ese
> ataque termina en **403 sin insertar fila**, así que el legítimo sigue pudiendo reclamar. El gate es
> lo que hace que el anti-replay siga siendo una defensa.

---

## 2. Scope IN / OUT — archivos exactos, anclas **por contenido**

> ⚠️ **Anclá por contenido, nunca por número de línea.** Hay otras HUs en vuelo (211, 212, 314) en
> otros worktrees; los números se mueven.

### 2.1 Crear (10 archivos)

| Archivo | Qué hace | Exemplar (verificado en disco) | Wave |
|---|---|---|---|
| `supabase/migrations/20260731000000_wkh315_solana_deposit.sql` | §1.5 + §4.7 del SDD: `vm_family` + CHECK + índice parcial · `funding_wallet_solana` + UNIQUE parcial · `DROP FUNCTION` de 6 args · `register_a2a_key_deposit` de 7 params · hardening (`SET search_path`/`REVOKE`/`GRANT`) · re-hidratación desde el backup | `20260529000001_a2a_key_funding_wallet.sql` (columna+índice parcial) + `20260529000000_a2a_key_deposits.sql:27-32`,`:93-103` | W0.3 |
| `..._wkh315_solana_deposit_down.sql` | Archiva y revierte: backup de las firmas Solana → DROP índice → DROP CHECK → DROP columnas → DROP fn de 7 → **restaura la de 6** | `20260529000000:27-31` | W0.3 |
| `src/adapters/solana/deposit-account.ts` | `resolveSolanaDepositOwner()` · `resolveSolanaDepositAta()` · `isSolanaDepositEnabled()`. **CERO `Keypair`** | `solana/chain.ts:39-70` (opts>env>default), `payment.ts:214` (ATA), `parsers.ts:81-83` (comparación estricta de string) | W1.1 |
| `src/adapters/solana/deposit-verifier.ts` | `verifySolanaDeposit(...)` — §4.8 del SDD. **NUNCA lanza** | `payment.ts:572-644` (forma del probe) + `:1101-1130` (delta de token balances) + `deposit-verifier.ts:341-365` (orden de clasificación) | W1.2 |
| `src/lib/ed25519.ts` | `verifyEd25519Base58(message, pubkeyBase58, signatureBase58): boolean` + decoder base58 propio que **devuelve, no lanza**. Módulo **leaf** (cero imports del proyecto) | `src/lib/wallet-format.ts` (leaf) | W1.3 |
| `src/adapters/solana/deposit-verifier.test.ts` | T-315-02,03,03b,05,06,07,07b,10,16,16b | `src/adapters/deposit-verifier.test.ts` | W1/W3 |
| `src/adapters/solana/deposit-account.test.ts` | T-315-13 (estático), T-315-19 (flag) | `src/adapters/solana/chain.test.ts` | W1 |
| `src/lib/ed25519.test.ts` | T-315-08d, 08e (canario del decoder), 17-adyacentes | `src/adapters/solana/base58.test.ts` | W1 |
| `src/routes/auth.solana-deposit.test.ts` | T-315-01,04,07c,07d,08,08b,08c,12,12b,12c,17,18 | `src/routes/auth.test.ts` (`app.inject` + mocks de `identityService`/`budgetService`) | W2/W3 |
| `src/services/identity.solana-funding.test.ts` | T-315-09, 09b | `src/services/identity.test.ts` | W1 |
| `test/wkh315-solana-deposit.migration.test.ts` | T-315-04b, 14, 14b, 14c + predicados estructurales del `.sql` | `test/wkh307-solana-settle-intents.migration.test.ts` + `test/helpers/sql-predicate.ts` (`evalSqlPredicate`, exportado en `:49`) | W0/W3 |

### 2.2 Modificar (ancla = texto exacto presente hoy)

| Archivo | Ancla por contenido | Qué hacés | Wave |
|---|---|---|---|
| `src/adapters/types.ts` | `export type SettledPeek =` (bloque de tipos Solana; **`SettlementPresence` NO se toca**) | Bloque **aditivo**: `SolanaDepositLanding` (5 estados) + `SolanaDepositReason` + `SolanaDepositVerification` (unión discriminada) | W0.1 |
| `src/lib/wallet-format.ts` | `const SOLANA_PUBKEY_BYTES = 32;` | Agregar `SOLANA_SIGNATURE_BYTES = 64` + `isValidSolanaSignature(s: string): boolean` — **misma técnica base-x**, 64 bytes. `isValidSolanaAddress` **no se toca** | W0.2 |
| `src/adapters/deposit-verifier.ts` | `export function resolveTreasury(chainKey: ChainKey)` y `export interface VerifyDepositArgs {` | `EvmChainKey` + `isEvmChainKey` + firmas narrowed (§1.2 + `[SDD GAP #2]`). **Cuerpos byte-idénticos** | W0.4 |
| `src/types/database.types.ts` | `register_a2a_key_deposit: {` · `funding_wallet: string \| null;` (3 apariciones: Row/Insert/Update de `a2a_agent_keys`) · `a2a_key_deposits: {` | **Aditivo, a mano, sin regenerar el archivo**: `p_vm_family?: string` en los Args · `funding_wallet_solana` en las 3 formas de `a2a_agent_keys` · `vm_family` en las 3 formas de `a2a_key_deposits`. Ver `[SDD GAP #1]` | W0.5 |
| `src/types/a2a-key.ts` | `funding_wallet: string \| null; // WKH-35 FIX-1` | Agregar `funding_wallet_solana: string \| null;` (espejo, byte-exacto, **sin** "lowercase" en el comentario). Si algún fixture existente rompe `tsc`, pasalo a `?: string \| null` y **declaralo** | W0.5 |
| `src/services/identity.ts` | `async bindFundingWallet(` … `const normalized = wallet.toLowerCase();` | Agregar **al lado** `bindSolanaFundingWallet(keyId, ownerId, pubkey)`: copia **sin** la línea `toLowerCase()`, escribe `funding_wallet_solana`, mismo Ownership Guard (`.eq('id').eq('owner_ref').select('id')`), `23505` → `FundingWalletAlreadyBoundError`, 0 filas → `logOwnershipMismatch` + `OwnershipMismatchError`. **`bindFundingWallet` NO se toca** | W1.4 |
| `src/routes/auth/parsers.ts` | `export function fundingWalletBindMessage(keyId: string): string {` | Agregar **al lado** `solanaFundingWalletBindMessage(keyId)` = `` `WASIAI_BIND_FUNDING_WALLET_SOLANA:${keyId}` ``. El de EVM **no se toca** | W2.1 |
| `src/routes/auth/funding-wallet.ts` | `const wallet = body?.wallet;` y `!ADDRESS_RE.test(wallet) ||` | Rama `namespace: 'solana'` (§3 W2.2). El bloque EVM (`recoverMessageAddress` + `toLowerCase`) queda **intacto** | W2.2 |
| `src/services/budget.ts` | `async registerDeposit(` … `p_token: token ?? null,` | 7º parámetro `vmFamily?: 'evm' \| 'solana'`; `p_vm_family` **sólo se agrega al objeto si `vmFamily !== undefined`** (spread condicional). La llamada EVM queda byte-idéntica | W2.3 |
| `src/routes/auth/deposit.ts` | `const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;` · `const chainId = bundle.chainConfig.chainId; // CD-5` · `const result = escrowEnabledForChain(chainKey)` · `if (payment.vmFamily !== 'evm') return null;` | Los 6 cambios de §3 W2.4, en ese orden exacto | W2.4 |
| `src/adapters/solana/chain.ts` | `log.info(\n    { operator: keypair.publicKey.toBase58() },` (dentro de `getSolanaOperatorKeypair`, **después** de la carga exitosa) | Aserción de coherencia cuenta-de-depósito ↔ operador (§3 W3.1). **Cuttable** por decisión del AR | W3.1 |
| `src/adapters/solana/chain.test.ts` | los `describe` existentes de `getSolanaOperatorKeypair` | Tests **aditivos** de la aserción de W3.1 (T-315-20) | W3.1 |
| `.env.example` · `doc/INTEGRATION.md` · `doc/MULTI-CHAIN.md` | bloque Solana existente | Envs nuevas + runbook del depositante + el disparo declarado de `TD-SOLANA-CAIP2-DENYLIST` | W3.2 |

### 2.3 Scope OUT — **no lo toques aunque te tiente, y por qué**

| No tocar | Por qué |
|---|---|
| **`src/adapters/solana/payment.ts`** | Es de **WKH-314** y es el único solapamiento no trivial de las dos HUs. Además su probe **no sirve** para un depósito (§1.6). Cero bytes. |
| **`verifyDeposit` (cuerpo)**, `escrow-verifier.ts`, `_resetVerifier` | CD-1: el camino EVM es byte-idéntico. En `deposit-verifier.ts` cambiás **firmas y tipos**, nada de cuerpos. |
| **`bindFundingWallet`** e `identity.ts:176` (`wallet.toLowerCase()`) | El lowercase de EVM es contrato declarado en su migración (`20260529000001:14`). Cambiarlo toca el camino EVM. |
| **`increment_a2a_key_spend`**, `getBalance`, `GET /me` | La "contabilidad única" es **otra HU** (§4.2 del SDD): toca los tres caminos de débito y CD-1 lo prohíbe. Acá el depósito acredita `budget['<sentinel>']`, igual que EVM acredita el suyo. |
| **`SettlementPresence`** (`types.ts:170-187`) | Congelado (CD-3 de las dos HUs). Agregás un bloque aditivo en el mismo archivo, no lo rediseñás. |
| **`src/adapters/solana/schema-preflight.ts`** | `probeRpcHistoryRetention` (`:166-208`) ya es genérico y es la precondición de poder afirmar `absent`. **Ninguna HU la re-implementa ni la debilita.** |
| **`src/adapters/registry.ts`** / `isSolanaEnabled()` | Choke-point único del rail (`:62-64`), y tu módulo **NO lo lee**: el AND es estructural (sin flag no hay bundle ⇒ `CHAIN_NOT_SUPPORTED`). |
| **`src/middleware/x402.ts`**, `compose.ts`, `downstream-payment.ts` | Camino de SALIDA / pared A. De `x402.ts:674-730` sólo **copiás el vocabulario** del canal `unknown`. |
| **`SLUG_ALIASES`** (`chain-resolver.ts:20-68`) | PROHIBIDO el alias `'900001'` (§1.4). Mapa puro que no lee env. |
| **`a2a_x402_nonces` / `checkAndRecordX402Nonce`** | Falla **ABIERTO** por diseño con una justificación que es **falsa en Solana** (CD-10). |
| **`base58DecodeToBytes`** (`solana/base58.ts:62`) sobre input del caller | Lanza con un mensaje que nombra `SOLANA_OPERATOR_PRIVATE_KEY`: una falsa alarma de seguridad en los logs por un typo del usuario. |
| **`usdToAtomicUnits`** (`atomic-amount.ts:87`) para el monto declarado | Toma un `number`; FIX-3 (`deposit-verifier.ts:350-365`) existe precisamente para no pasar el monto por un float. Usá `parseUnits`/`formatUnits` de `viem` (matemática decimal pura, las mismas que usa el verificador EVM). |
| **`caldz`** (cualquier escritura), `_INDEX.md`, `.nexus/project-context.md`, `doc/sdd/211-*`, `doc/sdd/212-*`, `contracts/.gas-snapshot`, `doc/audit/`, `doc/jury-qa*.md`, `doc/sdd/118-*` | Reglas duras del encargo. Y **jamás** abras `chaski-v3/m5-keys/`. |
| **mainnet**, escrow Anchor, gasless del depositante, withdraw, reembolso automático, UX/QR/SDK, mínimo de depósito (AC-9), la puerta de liquidez (Apéndice A), `TD-SOLANA-CAIP2-DENYLIST` | Scope OUT explícito del SDD §6. El disparo del TD se **declara** en la doc (W3.2), no se cierra. |

---

## 3. Waves — tarea por tarea

| Wave | Depende de | Paralelizable |
|---|---|---|
| **W0** | `npm ci` + baseline | **NO — gate serial.** Nadie empieza W1/W2 antes de que W0 esté en verde (`npx tsc --noEmit` **completo**) |
| **W1** | W0.1, W0.2, W0.4, W0.5 | **Sí, los 4 módulos en paralelo**: W1.2 depende del *contrato* de W1.1 (declarado acá), no de su cuerpo |
| **W2** | W0 + W1 | Parcial: W2.1/W2.3 en paralelo; W2.2 tras W1.3+W1.4+W2.1; W2.4 al final |
| **W3** | W2 | W3.1 y W3.2 en paralelo; **W3.3 (mutación) es serial y va última**; W3.4 founder-gated |

---

### W0 — contratos y esquema (serial, nada empieza sin esto)

| # | Archivo + ancla | Qué cambia | AC | Test | Mutante |
|---|---|---|---|---|---|
| **W0.1** | `src/adapters/types.ts` — después del bloque `export type SettledPeek =` | Bloque aditivo con los 3 tipos de §3.1 de este archivo. **PROHIBIDO copiar la forma de `DepositVerification`** (`deposit-verifier.ts:38-48`: `ok: boolean` + `reason?`, colapsa "no pude preguntar" en `TX_NOT_FOUND`) | AC-2, AC-6 · CD-3 | compila + los tests de W1.2 lo ejercitan | — |
| **W0.2** | `src/lib/wallet-format.ts` — junto a `SOLANA_PUBKEY_BYTES` | `isValidSolanaSignature`: charset base58 + decode a **exactamente 64 bytes**. Mismo algoritmo, **sin normalización de caja**, **sin lanzar** | AC-1, AC-8 | `src/lib/wallet-format.test.ts` (aditivo): 64 bytes ok · 32 bytes (pubkey) ⇒ `false` · `'0xbad'` ⇒ `false` · charset inválido ⇒ `false` | — |
| **W0.3** | `..._wkh315_solana_deposit.sql` + `_down.sql` | §1.5 completo. **Se escribe, NO se aplica** | AC-3, AC-7, AC-13 | `test/wkh315-solana-deposit.migration.test.ts`: T-315-14, 14b, 14c, 04b | **M11, M13, M14** |
| **W0.4** | `src/adapters/deposit-verifier.ts` — `resolveTreasury(chainKey: ChainKey)` + `VerifyDepositArgs` | `EvmChainKey` + `isEvmChainKey` + narrowing (§1.2 + `[SDD GAP #2]`). Cuerpos intactos | AC-14 · CD-5 | `src/adapters/deposit-verifier.evm-only.test.ts`: T-315-15 (`@ts-expect-error` sobre `resolveTreasury('solana-devnet')`) | **M18** |
| **W0.5** | `src/types/database.types.ts` + `src/types/a2a-key.ts` | Los 3 bloques aditivos de §2.2. **Sin regenerar** database.types.ts (`[SDD GAP #1]`) | habilita AC-3/AC-7 | compila | — |

**Verificación W0**: `npx tsc --noEmit` **completo** (no alcanza `npm run build`: `tsconfig.build.json`
excluye tests — lección WKH-196) + los predicados de la migración corriendo verdes.

#### 3.1 Los tipos de W0.1, textualmente (para que no haya dos versiones)

```ts
// ── WKH-315 — depósito Solana (bloque ADITIVO; SettlementPresence NO se toca) ──
export type SolanaDepositLanding =
  | { state: 'finalized_ok' }
  | { state: 'landed_failed'; detail: string }
  | { state: 'not_finalized'; confirmationStatus: string }
  | { state: 'absent' }
  | { state: 'unknown'; detail: string };

export type SolanaDepositReason =
  | 'TX_ABSENT' | 'TX_FAILED' | 'DEPOSIT_NOT_FINALIZED'
  | 'MINT_MISMATCH' | 'RECIPIENT_MISMATCH' | 'AMOUNT_MISMATCH'
  | 'DEPOSITOR_AMBIGUOUS' | 'DEPOSIT_ACCOUNT_NOT_CONFIGURED'
  | 'DEPOSIT_VERIFICATION_UNKNOWN';

export type SolanaDepositVerification =
  | { ok: true; amountAtomic: bigint; amountUsd: string; depositor: string;
      ata: string; mint: string; signature: string }
  | { ok: false; reason: SolanaDepositReason; detail?: string };
```

La exhaustividad la fuerza el compilador en el `switch` del mapeo de errores de W2.4 (patrón
`types.ts:170-187`): **no** uses `default:`.

---

### W1 — los cuatro módulos (paralelizable)

#### W1.1 · `src/adapters/solana/deposit-account.ts` (nuevo)

| Qué | Detalle |
|---|---|
| **Contrato** | `resolveSolanaDepositOwner(): string \| null` · `resolveSolanaDepositAta(): string \| null` · `isSolanaDepositEnabled(): boolean` |
| **Owner** | `A2A_DEPOSIT_OWNER_SOLANA`, validado con `isValidSolanaAddress`. Ausente o inválida ⇒ `null`. **PROHIBIDO cualquier fallback** — el fallback silencioso es exactamente cómo `resolveTreasury` se volvió un landmine |
| **ATA** | `getAssociatedTokenAddressSync(new PublicKey(getSolanaUsdcMint()), new PublicKey(owner)).toBase58()` — mismo derivador que `payment.ts:214`, **sin red**. Cualquier throw de `PublicKey` ⇒ `null` (no propagues) |
| **Flag** | `process.env.A2A_DEPOSIT_ENABLED_SOLANA === 'true'` **Y** `resolveSolanaDepositOwner() !== null`. **PROHIBIDO `Boolean(process.env...)`** (exemplar `parsers.ts:81-83`) |
| **Prohibiciones** | **CERO** `Keypair`, cero `getSolanaOperatorKeypair`, cero lectura de `SOLANA_ADAPTER_ENABLED` (el AND con el rail es estructural: sin flag no hay bundle) |
| AC | AC-4, AC-11, AC-12, AC-14 |
| Tests | `deposit-account.test.ts`: **T-315-13** (estático: los archivos del camino de depósito no mencionan `getSolanaOperatorKeypair` ni `Keypair` en sus imports) · **T-315-19** (`A2A_DEPOSIT_ENABLED_SOLANA='false'`/`'1'`/`'TRUE'`/ausente ⇒ OFF; sólo `'true'` ⇒ ON) · owner inválido ⇒ ATA `null` ⇒ OFF |
| Mutantes | **M18, M19** |

> **Nota anti-falso-positivo para T-315-13**: `deposit-account.ts` importa `./chain.js` para el mint, y
> `chain.ts:1` importa `Keypair` a nivel de módulo para el camino de **settle**. La garantía que este
> test canda es *"el camino de depósito nunca INVOCA el loader del keypair"*, y se afirma grepeando el
> **texto de los archivos del camino de depósito** (`deposit-account.ts`, `solana/deposit-verifier.ts`,
> `lib/ed25519.ts`), no su cierre transitivo. Escribí esa limitación en el comentario del test: un
> test que promete más de lo que mide es peor que no tenerlo.
>
> El `| null` de la resolución de config **no viola CD-3**: es una lectura de env local, sin tercer
> valor posible; el verificador lo traduce a `DEPOSIT_ACCOUNT_NOT_CONFIGURED`, que **sí** es un estado
> de la unión discriminada.

#### W1.2 · `src/adapters/solana/deposit-verifier.ts` (nuevo) — el corazón

`verifySolanaDeposit({ signature, expectedAmountUsd }): Promise<SolanaDepositVerification>` —
**NUNCA lanza**. Secuencia exacta (§4.8 del SDD):

| Paso | Qué hace | Falla ⇒ |
|---|---|---|
| 1 | `if (!isSolanaDepositEnabled()) …` y luego `resolveSolanaDepositAta()` | `DEPOSIT_ACCOUNT_NOT_CONFIGURED` (503). **Choke-point único**: la ruta no lee el flag |
| 2 | `getSignatureStatuses([signature], { searchTransactionHistory: true })` — **única fuente admitida de una negativa** | throw / array ausente / array vacío ⇒ **`unknown`** (nunca `absent`) · `status === null` **después de haber buscado** ⇒ `absent` → `TX_ABSENT` · `status.err` ⇒ `landed_failed` → `TX_FAILED` |
| 3 | Finalidad (§1.3): `confirmationStatus === 'finalized'` | `'processed'`/`'confirmed'` ⇒ `DEPOSIT_NOT_FINALIZED` (400) · **ausente ⇒ `unknown`** (503) |
| 4 | `getParsedTransaction(signature, { commitment: DEPOSIT_COMMITMENT, maxSupportedTransactionVersion: 0 })` | throw ⇒ `unknown` · `!parsed?.meta` ⇒ **`unknown`** ("el status dice que está pero este nodo no la tiene parseada" ≠ "no coinciden" — lección literal de `payment.ts:625-633`) · `parsed.meta.err` ⇒ `TX_FAILED` |
| 5 | Términos sobre `pre/postTokenBalances`, **en el orden del EVM** (`deposit-verifier.ts:341-346`) para que los códigos sean distinguibles | ninguna entrada con `mint === getSolanaUsdcMint()` en pre **ni** post ⇒ `MINT_MISMATCH` · hay entradas del mint pero el delta de la ATA esperada **no es `> 0`** ⇒ `RECIPIENT_MISMATCH` |
| 5b | **Match TRIPLE del destino** (CD-5): `mint === esperado` **Y** `owner === A2A_DEPOSIT_OWNER_SOLANA` **Y** `parsed.transaction.message.accountKeys[accountIndex] === <ATA derivada>` | *Por qué las tres y no `(owner, mint)` como `checkTerms` (`payment.ts:1117-1119`): un `find` por `(owner,mint)` toma la PRIMERA de varias cuentas del mismo owner y puede **sub-medir** el delta; y CD-5 exige comparar contra la ATA* |
| 6 | Depositante (§1.8): owner de la entrada del mint con delta **negativo**, leído de `preTokenBalances` | ≠1 owner distinto ⇒ `DEPOSITOR_AMBIGUOUS` |
| 7 | Monto declarado (opcional), **BigInt vs BigInt**: `parseUnits(expectedAmountUsd, getSolanaUsdcDecimals())` vs `amountAtomic`; throw de `parseUnits` ⇒ `AMOUNT_MISMATCH` | `AMOUNT_MISMATCH`. **PROHIBIDO `usdToAtomicUnits`** |
| 8 | `{ok:true, amountAtomic, amountUsd: formatUnits(delta, decimals), depositor, ata, mint, signature}` | **El monto acreditado es SIEMPRE el de la cadena** (AC-1) |

- **CD-14, la regla que gobierna todo el archivo**: `if (res.error) return <veredicto definitivo>`
  está **PROHIBIDO**. Un `absent`, un `MINT_MISMATCH` o un `not_finalized` exigen evidencia
  **POSITIVA**; todo lo demás se llama `unknown`. Cuando encuentres un sitio con esa forma,
  **grepeá la forma en todo el archivo** antes de darlo por terminado.
- AC: AC-1, AC-2, AC-4, AC-5, AC-6, AC-15 · Tests: T-315-02, 03, 03b, 05, 06, 07, 07b, 10, 16, 16b ·
  Mutantes: **M1, M2, M3, M4, M8, M9, M10, M16**.

#### W1.3 · `src/lib/ed25519.ts` (nuevo)

| Qué | Detalle |
|---|---|
| **Contrato** | `verifyEd25519Base58(message: string, pubkeyBase58: string, signatureBase58: string): boolean` |
| **Cómo** | §1.1: decoder base58 propio → `Uint8Array \| null` (**big-endian**, ojo la inversión), longitudes 32/64 exactas, SPKI DER con el prefijo `302a300506032b6570032100`, `crypto.verify(null, …)` dentro de `try/catch` |
| **Prohibiciones** | Cero imports del proyecto (módulo **leaf**, como `wallet-format.ts`) · cero dependencias nuevas · **nunca lanza** · nunca loguea la firma ni el mensaje |
| AC | AC-7 |
| Tests | **T-315-08d** (firma válida para OTRO `key_id` ⇒ `false`) · **T-315-08e** (canario del decoder contra `Keypair.generate().publicKey.toBytes()`) · firma manipulada 1 bit ⇒ `false` · base58 inválido ⇒ `false` **sin lanzar** · pubkey de 31/33 bytes ⇒ `false` |
| Mutantes | **M17** |
| Fixtures (CD-16) | `generateKeyPairSync('ed25519')` + `crypto.sign(null, msg, privateKey)`. **PROHIBIDO** `'x'.repeat(88)` o un buffer de ceros |

#### W1.4 · `src/services/identity.ts` — `bindSolanaFundingWallet`

Copia de `bindFundingWallet` (ancla: `const normalized = wallet.toLowerCase();`) **sin esa línea**,
escribiendo `funding_wallet_solana` **byte-exacto**. Mismo Ownership Guard, misma traducción de
errores, devuelve la pubkey tal cual llegó.

- AC: AC-7, AC-8 · Tests: **T-315-09b** (persiste byte-exacto: el arg del `.update()` se **captura** y
  se asserta) · `23505` ⇒ `FundingWalletAlreadyBoundError` · 0 filas ⇒ `OwnershipMismatchError`
  (403) · Mutante: **M7**.

**Verificación W1**: `npx tsc --noEmit` + los 4 archivos de test nuevos verdes.

---

### W2 — integración

#### W2.1 · `src/routes/auth/parsers.ts`
`solanaFundingWalletBindMessage(keyId)` junto al de EVM, que **no se toca**. Sin CAIP-2 ni cluster en
el preimagen (a propósito: el bind es por *key*, no por red; meter un valor env-driven invalidaría
todos los binds al cambiar `SOLANA_CAIP2_CHAIN_ID` — el mismo error que CD-8 caza en otro lugar).
AC-7. Test: assert del literal exacto en `auth.solana-deposit.test.ts`.

#### W2.2 · `src/routes/auth/funding-wallet.ts` — la rama del bind

Orden exacto, con el bloque EVM intacto:

1. Auth (sin cambios).
2. Leer `namespace` del body: `undefined` ⇒ `'evm'`; `'solana'` ⇒ rama nueva; **cualquier otro valor
   ⇒ 400 `INVALID_INPUT`** (fail-closed, **no** default a EVM).
3. Rama `'solana'`: `isValidSolanaAddress(wallet)` **y** `isValidSolanaSignature(signature)`; falla
   ⇒ 400 `INVALID_INPUT`. **Sin `ADDRESS_RE`, sin `toLowerCase()`, en ningún punto.**
4. `verifyEd25519Base58(solanaFundingWalletBindMessage(callerKey.id), wallet, signature)` ⇒ `false`
   ⇒ **403 `FUNDING_WALLET_PROOF_INVALID`** (mismo código que EVM).
5. `identityService.bindSolanaFundingWallet(callerKey.id, callerKey.owner_ref, wallet)` → 200
   `{ funding_wallet_solana: <pubkey> }`. Errores: 409 `FUNDING_WALLET_ALREADY_BOUND` · 403
   `OWNERSHIP_MISMATCH` · 500 `FUNDING_WALLET_BIND_FAILED` (misma traducción que EVM).

AC-7, AC-8 · Tests: **T-315-08c** (bind válido ⇒ 200), **T-315-09** (dos pubkeys que difieren **sólo
en caja** ⇒ dos valores distintos, sin normalización ni colisión), namespace basura ⇒ 400 ·
Mutantes: **M6, M7**.

#### W2.3 · `src/services/budget.ts` — `registerDeposit(..., vmFamily?)`

```ts
// ancla: p_token: token ?? null,
...(vmFamily !== undefined ? { p_vm_family: vmFamily } : {}),
```

**La llamada EVM no debe enviar `p_vm_family`.** AC-3, AC-13 · Test **T-315-11b** en
`src/services/budget.test.ts` (**aditivo**, no reescribas nada): el doble de `supabase.rpc`
**captura** los args y se asserta que la llamada sin `vmFamily` **no tiene la clave**, y que con
`'solana'` la tiene · Mutante **M12**.

#### W2.4 · `src/routes/auth/deposit.ts` — los 6 cambios, en este orden

| # | Ancla | Qué hacés |
|---|---|---|
| 1 | `!TX_HASH_RE.test(txHash) ||` (paso 2) | `!isAcceptedTxRef(txHash) ||`, con el helper local `const isAcceptedTxRef = (t: string) => TX_HASH_RE.test(t) \|\| isValidSolanaSignature(t);`. **NO es un regex laxo** (CD-6b): son dos predicados estructurales estrictos y mutuamente excluyentes. El resto del `if` **no se toca** |
| 2 | `const chainId = bundle.chainConfig.chainId; // CD-5` | **Paso 3b nuevo, INMEDIATAMENTE después y ANTES del `chain_id` match**: coherencia familia↔formato — `getChainVmFamily(chainKey)` vs el predicado que matcheó. Mismatch ⇒ **400 `INVALID_INPUT`** y **cero red**. *Va antes del paso 4 a propósito: así una firma base58 sobre una chain EVM sigue contestando `INVALID_INPUT`, exactamente como hoy* |
| 3 | `const result = escrowEnabledForChain(chainKey)` (paso 5) | **Antes** de esa línea: `if (bundle.payment.vmFamily === 'solana') { …sub-flujo Solana…; }` con `return` en todas sus salidas. `bundle.payment.vmFamily === 'solana'` narrowea `payment` al `SolanaPaymentAdapter` (verificado: `types.ts:104` y `:210` tienen el discriminante literal) |
| 4 | idem, después del bloque Solana | `if (!isEvmChainKey(chainKey)) return reply.status(400).send({ error_code: 'CHAIN_NOT_SUPPORTED' });` — **inalcanzable** (no-EVM ⟺ `solana-devnet` ⟺ `vmFamily==='solana'`, ya retornado), existe para que `tsc` narrowee. Comentalo como tal. Desde acá el bloque EVM queda **byte-idéntico** |
| 5 | `if (payment.vmFamily !== 'evm') return null;` (deposit-info) | **Antes** de esa línea, la rama Solana de `deposit-info` (§3.2). **Después** de esa línea, `if (!isEvmChainKey(chainKey)) return null;`. **Los dos guards se conservan**: el primero preserva la conducta byte a byte, el segundo es el que narrowea |
| 6 | — | Import de `isValidSolanaSignature`, `getChainVmFamily`, `isEvmChainKey`, `verifySolanaDeposit`, `resolveSolanaDepositAta`/`Owner`, `isSolanaDepositEnabled`, `eventService` |

##### Sub-flujo Solana del POST (paso 3 de arriba), en orden

1. `const result = await verifySolanaDeposit({ signature: txHash, expectedAmountUsd: body.amount });`
2. `if (!result.ok)`: mapeo **propio** por `switch (result.reason)` **exhaustivo, sin `default`** — el
   mapeo EVM (lista literal en `deposit.ts:119-123`) **no se toca**:

| `reason` | HTTP | ¿Consume la prueba? |
|---|---|---|
| `TX_ABSENT` · `TX_FAILED` · `DEPOSIT_NOT_FINALIZED` · `MINT_MISMATCH` · `RECIPIENT_MISMATCH` · `AMOUNT_MISMATCH` · `DEPOSITOR_AMBIGUOUS` | **400** | **No** (retorna antes de `registerDeposit`) |
| `DEPOSIT_ACCOUNT_NOT_CONFIGURED` · `DEPOSIT_VERIFICATION_UNKNOWN` | **503** | **No** |

3. **Sólo para `DEPOSIT_VERIFICATION_UNKNOWN`**, el canal durable de "no pude determinar" — **se reusa
   el vocabulario existente** de `x402.ts:674-730` (existe desde HU-198/201; **WKH-314 no lo crea**),
   PROHIBIDO inventar otro (CD-11):
   - `req.log.error({ error_code: 'DEPOSIT_VERIFICATION_UNKNOWN', valueDisposition: 'unknown',
     chainKey, chainId, keyId: callerKey.id, signature: txHash, detail }, '…')`
   - `void eventService.track({ eventType: 'solana_deposit_unknown', status: 'failed', metadata: {…} })
     .catch(…)` — fire-and-forget con `.catch`: **un fallo de telemetría no puede cambiar la respuesta
     de un money-path**. `eventType` es `string` libre, no hay tipo que extender.
   - **NO registres `owner_ref`** (`a2a_events` es telemetría global; el `keyId` alcanza para
     reconciliar — mismo criterio que el canal x402).
   - **El mensaje debe decir que la prueba NO se consumió** y que el depositante puede reintentar. En
     x402 el nonce ya estaba quemado; acá no, y el operador no tiene que salir a buscar una
     reconciliación manual que no hace falta.
4. Gate de funding wallet (rama Solana): `if (!callerKey.funding_wallet_solana)` ⇒ 403
   `FUNDING_WALLET_NOT_BOUND`; `if (result.depositor !== callerKey.funding_wallet_solana)` ⇒ 403
   `FUNDING_WALLET_MISMATCH`. **Comparación byte-exacta, cero `toLowerCase()`.**
5. `budgetService.registerDeposit(callerKey.id, chainId, result.amountUsd, ownerRef, txHash,
   'USDC'→ el `symbol` de `payment.supportedTokens[0]`, 'solana')`. El `chainId` sigue siendo
   `bundle.chainConfig.chainId` (CD-5), **nunca** el del caller.
6. Recibo `deposit_verified` — **misma forma que EVM**, `void` sin await.
7. `200 { balance, chain_id: chainId }` — **misma forma que EVM**. Errores del try/catch: 409
   `DEPOSIT_ALREADY_CREDITED` / 403 `OWNERSHIP_MISMATCH` / 500 `DEPOSIT_FAILED`, reusando el catch
   existente si te queda dentro, o replicándolo si armás un bloque aparte.

##### 3.2 La entrada Solana de `GET /auth/deposit-info` (AC-11 / CD-13)

Se publica **si y sólo si** `isSolanaDepositEnabled()`; con el flag OFF ⇒ `return null` (no aparece).
Shape exacto — **sin `treasury`, sin `escrow_*`** (publicar una dirección EVM acá es el landmine de
§1.2 con otro nombre):

```
{ chain_id, slug: 'solana-devnet', family: resolveChainFamilyEnvSuffix(chainKey), vm_family: 'solana',
  cluster: getSolanaNetwork(),
  token: { symbol, mint, decimals }        // ← de payment.supportedTokens[0], NO hardcodeado
  deposit_account: <ATA derivada>,          // ← el destino real
  deposit_account_owner: <pubkey del owner>,
  required_commitment: 'finalized' }
```

Tests: **T-315-12** (flag OFF ⇒ no lista Solana) · **T-315-12b** (flag ON + owner configurado ⇒
lista los 7 campos, `deposit_account` **≠** `deposit_account_owner`) · **T-315-12c** (jamás una clave
privada; jamás el owner como destino) · **T-315-18** (POST con el flag OFF ⇒ 503
`DEPOSIT_ACCOUNT_NOT_CONFIGURED`, **cero red**).

**Verificación W2**: `npx tsc --noEmit` + `npm run lint` + **suite completa**, con las 4 suites de
CD-1 **verdes sin editarse**.

---

### W3 — hardening, docs y evidencia

| # | Tarea | Detalle | AC / CD | Test |
|---|---|---|---|---|
| **W3.1** | `chain.ts` — coherencia cuenta-de-depósito ↔ operador | Ancla: el `log.info({ operator: keypair.publicKey.toBase58() }, …)` **dentro de** `getSolanaOperatorKeypair`, **después** de la carga exitosa. Regla: si `A2A_DEPOSIT_OWNER_SOLANA` está seteada **y** `!== keypair.publicKey.toBase58()` **y** `A2A_DEPOSIT_OWNER_IS_DEDICATED_SOLANA !== 'true'` ⇒ **throw** fail-loud (mensaje sin secretos). Exemplar de la salida declarada: `schema-preflight.ts:120`. **Trade-off declarado**: un error de config del DEPÓSITO deja de settlear la SALIDA — ruidoso, inmediato y reversible en un minuto, contra un dinero perdido que no lo es. **Cuttable** si el AR juzga el blast-radius excesivo; si se corta, el residuo va al runbook de W3.2 y **se declara** | §4.4 SDD | **T-315-20** (aditivo en `chain.test.ts`): owner == operador ⇒ carga ok · owner ≠ operador sin la declaración ⇒ throw · owner ≠ operador con `..._IS_DEDICATED='true'` ⇒ carga ok · env ausente ⇒ carga ok |
| **W3.2** | `.env.example` + `doc/INTEGRATION.md` + `doc/MULTI-CHAIN.md` | Envs: `A2A_DEPOSIT_OWNER_SOLANA`, `A2A_DEPOSIT_ENABLED_SOLANA` (default OFF), `A2A_DEPOSIT_OWNER_IS_DEDICATED_SOLANA`. Runbook del depositante: cómo firmar `WASIAI_BIND_FUNDING_WALLET_SOLANA:<key_id>`, a qué **ATA** transferir, y el orden **migración → env → flag**. Y el **disparo declarado** de `TD-SOLANA-CAIP2-DENYLIST` (`chain-resolver.ts:252-264`: su condición de reactivación se dispara al encender el rail; **esta HU no lo cierra**, lo declara y pide dueño) | AC-11 · D-4 | `test/docs-referenced-by-code-exist.test.ts` sigue verde |
| **W3.3** | **Campaña de mutación 20/20** (§4) + **cobertura de las líneas de los guards de dinero** | Serial, va última. "La suite pasa" **no** es la métrica: se mide cobertura de las líneas de los guards | CD-15 | — |
| **W3.4** | **Aplicar la migración a `bdwv`** | **Founder-gated. `caldz` PROHIBIDA.** Post-estado leído del **catálogo** (`information_schema.columns`, `pg_indexes`, `pg_get_functiondef`), no del exit code | CD-12 | — |

---

## 4. Los 20 mutantes, con su test asesino nombrado

**Reglas de la campaña** (203 + 209, no negociables):

1. **Respaldo físico fuera del árbol de git → mutar → probar que aterrizó (hash distinto) →
   `npx tsc --noEmit` LIMPIO → correr → restaurar por `cp` → verificar por hash.**
2. **PROHIBIDO `git checkout --` / `git restore` / `git stash`** sobre trabajo sin commitear (en 203
   se comió 160 líneas). La evidencia de reversión es el **`sha256sum`**, no el `git status`.
3. **Un mutante que no compila NO cuenta** (lo cazó el compilador, no el test).
4. **`no tests` NUNCA cuenta como KILLED** (209 §M12): hace falta el **nombre** del test que falló y
   su motivo. Un archivo que no colecta, una suite ausente o un `describe.skip` **no son KILLED**.
5. Ningún helper que pueda tirar se invoca en el cuerpo de un `describe`.

| # | Mutación (guard de dinero) | Dónde (ancla por contenido) | Test asesino | Test creado en |
|---|---|---|---|---|
| **M1** | `DEPOSIT_COMMITMENT` pasa de `'finalized'` a `getSolanaCommitment()` | `solana/deposit-verifier.ts`, literal de módulo | `T-315-03`, `T-315-03b` | W1.2 |
| **M2** | `confirmationStatus` ausente se lee como `'finalized'` en vez de `unknown` | ídem, paso 3 | `T-315-07`, `T-315-03` | W1.2 |
| **M3** | un throw de `getSignatureStatuses` devuelve `absent` en vez de `unknown` | ídem, paso 2 | `T-315-07`, `T-315-07d` | W1.2 / W2.4 |
| **M4** | `!parsed?.meta` devuelve `RECIPIENT_MISMATCH` en vez de `unknown` | ídem, paso 4 | `T-315-07b` | W1.2 |
| **M5** | el gate de funding wallet se saltea cuando `vmFamily==='solana'` | `deposit.ts`, sub-flujo Solana paso 4 | `T-315-08`, `T-315-08b` | W2.4 |
| **M6** | la comparación del depositante recupera `.toLowerCase()` en los dos lados | ídem | `T-315-09` | W2.2 |
| **M7** | `bindSolanaFundingWallet` recupera `wallet.toLowerCase()` | `identity.ts` | `T-315-09b` | W1.4 |
| **M8** | el match de destino usa sólo `(owner, mint)` y no la ATA derivada | `solana/deposit-verifier.ts`, paso 5b | `T-315-05` | W1.2 |
| **M9** | el depositante pasa a ser el fee-payer (primer firmante) | ídem, paso 6 | `T-315-16b` | W1.2 |
| **M10** | con ≥2 owners de origen se toma el primero en vez de rechazar | ídem, paso 6 | `T-315-16` | W1.2 |
| **M11** | el índice parcial Solana pasa a `(chain_id, tx_hash)` | migración, bloque de índices | `T-315-14`, `T-315-04b` | W0.3 |
| **M12** | `p_vm_family` pierde el `DEFAULT 'evm'` | migración, firma de la fn | `T-315-11b` + la suite EVM existente | W2.3 |
| **M13** | el `.sql` omite el `DROP FUNCTION` de la firma de 6 params | migración | `T-315-14` (predicado: el DROP **precede** al CREATE) | W0.3 |
| **M14** | el `_down` dropea `vm_family` sin archivar / el `up` no re-hidrata | `_down.sql` / `up` | `T-315-14c` | W0.3 |
| **M15** | el crédito se mueve ANTES del verify (`registerDeposit` primero) | `deposit.ts`, sub-flujo Solana | `T-315-03`, `T-315-05`, `T-315-07d` (orden por `mock.invocationCallOrder`) | W2.4 |
| **M16** | el monto acreditado pasa a ser `body.amount` en vez del de la cadena | `deposit.ts` paso 5 / verificador paso 8 | `T-315-01`, `T-315-02` | W1.2 / W2.4 |
| **M17** | `verifyEd25519Base58` devuelve `true` ante un error de decode | `lib/ed25519.ts` | `T-315-08d` | W1.3 |
| **M18** | `resolveSolanaDepositOwner` cae a `resolveTreasury` cuando la env falta | `deposit-account.ts` | `T-315-15` (no compila), `T-315-12` | W0.4 / W1.1 |
| **M19** | `A2A_DEPOSIT_ENABLED_SOLANA` se compara con `Boolean(process.env...)` | `deposit-account.ts` | `T-315-19` (`'false'` debe seguir OFF), `T-315-12` | W1.1 |
| **M20** | el paso 3b (coherencia familia↔formato) se elimina | `deposit.ts` | `T-315-17`: firma base58 con `x-payment-chain: avalanche-fuji` ⇒ 400 `INVALID_INPUT` y **cero red** | W2.4 |

### 4.1 Cuando un mutante sobrevive — dos causas, no una

1. **Falta un test** → escribilo.
2. **La mutación no era una mutación** → el runtime iguala las dos implementaciones.

**Determinalo empíricamente antes de escribir nada.** Un test escrito contra un mutante equivalente
canda una **equivalencia accidental**: pasa por un motivo que no es la propiedad. Si es equivalente,
**documentalo como equivalente** en el reporte.

### 4.2 Las aserciones de andamiaje se validan desarmando el escenario

Varios tests necesitan aserciones que existen **para probar que el escenario está armado** (que la
fila del bind quedó sembrada, que el doble del RPC devuelve lo que creés). Sacá la siembra, corré,
confirmá que el test **falla por esa línea**. Si sigue verde, la aserción no prueba nada.

---

## 5. Tests por AC (mínimo exigido — §8.1 del SDD, con los añadidos marcados)

| AC | Test | Archivo |
|---|---|---|
| AC-1 feliz | `T-315-01` 200 + balance, **monto = el de la cadena** | `auth.solana-deposit.test.ts` |
| AC-1 monto | `T-315-02` el caller declara 10, la cadena dice 5 ⇒ `AMOUNT_MISMATCH` y `registerDeposit` **NO** llamado | `solana/deposit-verifier.test.ts` |
| AC-2 | `T-315-03` `confirmationStatus:'confirmed'` ⇒ 400 `DEPOSIT_NOT_FINALIZED` sin crédito · `T-315-03b` `getParsedTransaction` **se invoca con `commitment:'finalized'`** (assert sobre el arg capturado) | ídem |
| AC-3 | `T-315-04` segunda presentación ⇒ 409 `DEPOSIT_ALREADY_CREDITED`, balance sin cambio · `T-315-04b` la unicidad Solana la impone un índice **sin `chain_id`** | ruta + migración |
| AC-4 | `T-315-05` mint correcto a **otra** ATA ⇒ `RECIPIENT_MISMATCH`, sin crédito, **sin reembolso** | verificador |
| AC-5 | `T-315-06` otro mint a nuestra ATA ⇒ `MINT_MISMATCH`, **distinguible** de `RECIPIENT_MISMATCH` | verificador |
| AC-6 | `T-315-07` `getSignatureStatuses` tira ⇒ `unknown`, **nunca `absent`** · `T-315-07b` status presente pero sin `meta` ⇒ `unknown` · `T-315-07c` 503 + `eventService.track` con `valueDisposition:'unknown'` y la firma · `T-315-07d` `registerDeposit` **NO** llamado | verificador + ruta |
| AC-7 | `T-315-08` sin `funding_wallet_solana` ⇒ 403 `FUNDING_WALLET_NOT_BOUND` · `T-315-08b` depositante ≠ bindeada ⇒ 403 `FUNDING_WALLET_MISMATCH` **sin fila insertada** (el hijack de §1.8) · `T-315-08c` bind válido ⇒ 200 · `T-315-08d` firma de OTRO `key_id` ⇒ 403 `FUNDING_WALLET_PROOF_INVALID` · **`T-315-08e` (añadido)** canario del decoder base58 | ruta + `lib/ed25519.test.ts` |
| AC-8 | `T-315-09` dos pubkeys que difieren **sólo en caja** ⇒ dos valores distintos, sin colisión · `T-315-09b` persistencia byte-exacta | `identity.solana-funding.test.ts` |
| AC-9 | **Diferido** (`[DECIDE FOUNDER]` D-2, hoy no hay mínimo). Se testea la **ausencia**: `T-315-10` un depósito de `0.000001` acredita | verificador |
| AC-10 | `T-315-11` las 4 suites de CD-1 **verdes sin modificarse** · `T-315-11b` `registerDeposit` sin `vmFamily` **NO** manda `p_vm_family` | existentes + `budget.test.ts` |
| AC-11 | `T-315-12` / `12b` / `12c` (§3.2) · **`T-315-18` (añadido)** POST con flag OFF ⇒ 503, cero red | ruta |
| AC-12 | `T-315-13` **estático**, con su limitación escrita (§W1.1) | `deposit-account.test.ts` |
| AC-13 | `T-315-14` índice sobre `(tx_hash)` con `WHERE vm_family='solana'` y **sin `chain_id`** · `T-315-14b` `UNIQUE (chain_id, tx_hash)` sigue existiendo · `T-315-14c` el `_down` archiva y el `up` re-hidrata | migración |
| AC-14 | `T-315-15` **de compilación**: `@ts-expect-error` sobre `resolveTreasury('solana-devnet')` (falla si compilara) | `deposit-verifier.evm-only.test.ts` |
| AC-15 | `T-315-16` dos owners de origen ⇒ `DEPOSITOR_AMBIGUOUS` sin crédito · `T-315-16b` el depositante es el que **baja**, no el fee-payer (tx con fee-payer tercero) | verificador |
| M20 | `T-315-17` firma base58 + header EVM ⇒ 400 `INVALID_INPUT`, cero red | ruta |
| W3.1 | **`T-315-19` / `T-315-20` (añadidos)** flag estricto · aserción de coherencia | `deposit-account.test.ts` · `chain.test.ts` |

### 5.1 Fixtures — CD-16 es obligatorio

- Pubkeys y firmas: **derivadas de la librería que las consume** (`Keypair.generate().publicKey.toBase58()`,
  `crypto.sign(null, msg, privateKey)`). **NUNCA** `'x'.repeat(88)` ni un buffer de ceros.
- `preTokenBalances`/`postTokenBalances`: la forma **real** del RPC —
  `{ accountIndex, mint, owner, uiTokenAmount: { amount, decimals, uiAmount, uiAmountString } }` — y
  `transaction.message.accountKeys` con la ATA en el `accountIndex` correcto, **porque el match triple
  del paso 5b la lee**. Un fixture sin `accountKeys` hace pasar un test que no prueba el match.
- `amount_usd` en fixtures de migración: dentro del rango de `NUMERIC(18,6)` (209 §Hallazgo-1: un
  valor "bien grande" que la columna rechaza no prueba el round-trip).
- Los dobles de `supabase.rpc` y de `Connection` **capturan sus args** y al menos un test **asserta
  sobre ellos** (CD-9: WKH-202 pagó este error tres veces).

---

## 6. Anti-Hallucination Checklist (marcá antes de cerrar la HU)

```
[ ] Ningún path, función, símbolo o API que use fue inventado: todos verificados con Read/Grep
[ ] npm ci corrido en wt-315 y BASELINE de tests anotado antes del primer cambio
[ ] `npx tsc --noEmit` COMPLETO limpio (no alcanza `npm run build`: excluye tests — WKH-196)
[ ] DEPOSIT_COMMITMENT es un literal de módulo 'finalized'; NINGUNA env puede debilitarlo
[ ] confirmationStatus AUSENTE ⇒ unknown (503), NUNCA 'todavía no' ni 'finalized'
[ ] getSignatureStatuses con searchTransactionHistory:true es la ÚNICA fuente de una negativa
[ ] Ningún `if (err) return <veredicto definitivo>` en el verificador (CD-14); grepeé la FORMA
[ ] El índice parcial Solana es UNIQUE, sobre (tx_hash), WHERE vm_family='solana', SIN chain_id
[ ] UNIQUE (chain_id, tx_hash) sigue existiendo, intacto
[ ] El .sql tiene DROP FUNCTION de la firma de 6 args ANTES del CREATE OR REPLACE de 7
[ ] El _down ARCHIVA (backup de tx_hash Solana) y el up RE-HIDRATA antes de crear el índice
[ ] `SET search_path = public, pg_temp` + REVOKE PUBLIC/anon/authenticated + GRANT service_role
    sobre la firma de 7 params
[ ] La migración NO se aplicó a caldz. A bdwv sólo en W3.4, founder-gated
[ ] resolveTreasury recibe EvmChainKey y `resolveTreasury('solana-devnet')` NO COMPILA (T-315-15)
[ ] Los cuerpos de resolveTreasury y verifyDeposit no cambiaron una línea
[ ] Cero toLowerCase()/normalización de caja sobre firmas, pubkeys y mints — comparación Y
    persistencia. Cero lower() en el índice UNIQUE nuevo
[ ] El despacho del bind es por `namespace` explícito (default 'evm'); valor no reconocido ⇒ 400
[ ] El gate de funding wallet Solana existe, compara byte-exacto y NINGÚN camino lo saltea (CD-2)
[ ] El depositante es el owner con delta NEGATIVO (preTokenBalances), no el fee-payer
[ ] ≥2 owners de origen ⇒ DEPOSITOR_AMBIGUOUS (fail-closed), nunca "tomo el primero"
[ ] El match de destino es TRIPLE: mint + owner + dirección de la ATA derivada
[ ] TODO fallo retorna ANTES de registerDeposit ⇒ la prueba NO se consume (CD-9)
[ ] El monto acreditado es SIEMPRE el de la cadena; el declarado sólo se compara BigInt vs BigInt
[ ] Cero `usdToAtomicUnits`, cero Number()/parseFloat sobre montos atómicos
[ ] Cero dependencias nuevas (node:crypto alcanza para ed25519); cero `tweetnacl`
[ ] Cero base58DecodeToBytes sobre input del caller; los decoders nuevos DEVUELVEN, no lanzan
[ ] Ningún módulo del camino de depósito importa getSolanaOperatorKeypair ni Keypair (T-315-13,
    con su limitación transitiva ESCRITA en el test)
[ ] src/adapters/solana/payment.ts tiene CERO cambios (git diff vacío para ese archivo)
[ ] SettlementPresence y schema-preflight.ts sin cambios; SLUG_ALIASES sin el alias '900001'
[ ] deposit-info publica Solana SÓLO con isSolanaDepositEnabled(); nunca una address EVM ahí
[ ] Las 4 suites de CD-1 (auth.test, deposit-verifier.test, escrow-verifier.test, budget.test)
    verdes SIN editarse; si tuve que tocar una, lo reporté como posible regresión
[ ] El único delta observable del camino EVM es el declarado en §1.7; si hay otro, lo reporté
[ ] Los 20 mutantes corridos, TODOS compilando, cada KILLED con el NOMBRE del test que falló
[ ] Respaldo por sha256sum antes de mutar; restauración verificada por hash. Cero git destructivo
[ ] NO toqué doc/sdd/_INDEX.md, .nexus/project-context.md, doc/sdd/211-*, doc/sdd/212-*,
    contracts/.gas-snapshot, doc/audit/, doc/jury-qa*.md, doc/sdd/118-*
[ ] Sin Co-Authored-By en los commits (repo público). Sin secrets ni .env en logs ni en el diff
```

---

## 7. Verificación y Done Definition

### 7.1 Gates

```bash
cd /home/ferdev/.openclaw/workspace/wt-315
npx tsc --noEmit        # COMPLETO
npm run lint            # biome check src/
npm test                # vitest run — las 4 suites de CD-1 verdes SIN editarse
npm run migrate:preflight
```

### 7.2 Done

1. Las 5 tareas de W0, las 4 de W1, las 4 de W2 y W3.1-W3.3 cerradas (W3.4 queda founder-gated).
2. **20/20 mutantes** corridos, todos compilando, con veredicto documentado. Un sobreviviente sin test
   nuevo que lo cace **o** sin prueba empírica de equivalencia (§4.1) es un **hallazgo abierto**.
3. **Cobertura de las líneas de los guards de dinero** reportada — no "la suite pasa".
4. Delta de tests declarado: `baseline + nuevos`. Cero tests eliminados: si eliminaste alguno,
   explicá por qué.
5. `git diff --stat` con **`src/adapters/solana/payment.ts` ausente** de la lista.
6. Runbook de W3.2 escrito, con el orden **migración → env → flag** y el disparo declarado de
   `TD-SOLANA-CAIP2-DENYLIST` (necesita dueño, no lo cierra esta HU).
7. `auto-blindaje.md` de esta HU (todo error que cometiste y cómo se previene la próxima).
8. Los `[SDD GAP]` de §10 reportados en el done-report como resueltos-en-F2.5, para que el AR sepa que
   son refinamientos declarados y no invenciones del Dev.

### 7.3 Nota de release (no es código)

**Orden no negociable: la migración va ANTES del código, y `A2A_DEPOSIT_ENABLED_SOLANA` se enciende
al final.** Orden correcto ⇒ sin ventana (la columna existe y nadie la usa todavía). Orden inverso ⇒
el flag OFF por default hace que el camino Solana no exista: degradación **ruidosa y recuperable**, no
un crédito duplicado. Ése es exactamente el punto de que el gate sea el flag y no la prosa.

---

## 8. Errores y política — la tabla completa (§4.10 del SDD)

| Condición | `error_code` | Status | ¿Consume la prueba? |
|---|---|---|---|
| tx_hash con formato de otra familia | `INVALID_INPUT` | 400 | No (cero red) |
| firma ausente **habiendo buscado el histórico** | `TX_ABSENT` | 400 | No |
| aterrizó y falló on-chain | `TX_FAILED` | 400 | No |
| `processed`/`confirmed` (**medido**) | `DEPOSIT_NOT_FINALIZED` | 400 | No |
| mint distinto del configurado | `MINT_MISMATCH` | 400 | No |
| no acreditó a la ATA de depósito | `RECIPIENT_MISMATCH` | 400 | No. **Sin reembolso automático**: runbook manual |
| monto declarado ≠ on-chain | `AMOUNT_MISMATCH` | 400 | No |
| >1 owner de origen | `DEPOSITOR_AMBIGUOUS` | 400 | No |
| cuenta de depósito sin configurar / flag OFF | `DEPOSIT_ACCOUNT_NOT_CONFIGURED` | **503** | No |
| **no se pudo determinar** | `DEPOSIT_VERIFICATION_UNKNOWN` | **503** | No (+ log + `a2a_events`) |
| wallet Solana no bindeada / no coincide | `FUNDING_WALLET_NOT_BOUND` / `_MISMATCH` | 403 | No |
| firma ya acreditada | `DEPOSIT_ALREADY_CREDITED` | 409 | Ya estaba consumida |

**La partición 400/503 ya existe en la casa**: 503 = "no puedo responder por la cadena o por la
config" (espejo de `RPC_UNAVAILABLE` / `ESCROW_CONTRACT_NOT_CONFIGURED`, `deposit.ts:119-123`);
400 + código propio = negativa **medida**, que el caller distingue por el código.

---

## 9. Lo que el SDD dejó abierto y NO es tuyo para cerrar

| # | Qué | Estado |
|---|---|---|
| D-1 / D-7 | Bucket del saldo por red vs contabilidad única | El depósito acredita `budget['<sentinel>']`, igual que EVM. La contabilidad única es **otra HU** (toca los tres caminos de débito). **No la empieces.** |
| D-2 | ¿Mínimo de depósito? | Hoy no existe ninguno. AC-9 **diferido**; el diseño no lo impide. `T-315-10` testea la ausencia |
| D-4 | ¿Quién cierra `TD-SOLANA-CAIP2-DENYLIST`? | Se **declara** el disparo en W3.2. **No lo cierres acá** |
| D-6 | ¿ATA del operador o cuenta dedicada? | Recomendada la del operador; si es dedicada, el operador declara `A2A_DEPOSIT_OWNER_IS_DEDICATED_SOLANA=true`. **El código soporta las dos**: no elijas por él |
| MI-3 / D-5 | ¿La demo paga x402 o prepago? | **No se pudo determinar** (requiere `chaski-v3`). Ya no es bloqueante: §7.1 del SDD eliminó la dependencia de orden con WKH-314 |

---

## 10. `[SDD GAP]` — tres huecos del SDD, ya resueltos acá para que no decidas vos

> Estos tres se detectaron en F2.5 verificando el código y **están reportados al orquestador**. La
> resolución de cada uno es mínima y conservadora; **no la extiendas**.

### `[SDD GAP #1]` — `src/types/database.types.ts` y `src/types/a2a-key.ts` no están en la tabla §4.1

Verificado: `database.types.ts` declara `register_a2a_key_deposit.Args` sin `p_vm_family`
(`:3496-3503`), `a2a_agent_keys` Row/Insert/Update con `funding_wallet` pero sin
`funding_wallet_solana` (`:208`,`:232`,`:256`), y `a2a_key_deposits` (`:407`) sin `vm_family`. Y
`A2AAgentKeyRow` (`a2a-key.ts:96`) tampoco tiene la columna nueva. Sin esos tipos,
`.update({ funding_wallet_solana })` y la lectura `callerKey.funding_wallet_solana` **no compilan**.

**Resolución (W0.5)**: edición **aditiva y a mano** de los 3 bloques + la interfaz. **PROHIBIDO
regenerar** `database.types.ts` (traería drift de otras tablas y ensancharía el diff de un money-path).
*(Nota: `budget.ts` castea el objeto de args con `as unknown as …Args`, así que `p_vm_family` compilaría
igual sin tocar los tipos — pero entonces el tipo generado **miente** sobre la firma real de la RPC, y
eso es exactamente el tipo de deuda que después se paga en un money-path.)*

### `[SDD GAP #2]` — narrowear `resolveTreasury` rompe su call-site INTERNO

El SDD (§4.4) dice que el único call-site externo es `deposit.ts:218` y que `deposit-verifier.ts:304`
"ya está dentro de `verifyDeposit`, que sólo se invoca desde la rama EVM". **Eso es cierto en runtime y
falso para `tsc`**: `VerifyDepositArgs.chainKey` es `ChainKey`, así que `resolveTreasury(chainKey)` en
`:304` **no compila** con la firma narrowed.

**Resolución (W0.4), la que preserva la conducta observable**: `VerifyDepositArgs.chainKey` pasa a
`EvmChainKey`, y en `deposit.ts` el narrowing lo hace el guard **inalcanzable** de W2.4 ítem 4
(`if (!isEvmChainKey(chainKey)) return … 'CHAIN_NOT_SUPPORTED'`), colocado **después** de la
bifurcación Solana. Es inalcanzable porque no-EVM ⟺ `solana-devnet` ⟺ `payment.vmFamily === 'solana'`,
que ya retornó (verificado en `chain-resolver.ts:87-96`).

**PROHIBIDAS las dos alternativas**: (a) un `as EvmChainKey` en `:304` — un cast es una aserción sin
chequeo, y AC-14 pide que el compilador sea la defensa; (b) un guard nuevo **dentro** de
`verifyDeposit` — cambia el cuerpo de una función que CD-1 congela.

Verificado para que no lo re-investigues: `resolveTreasury` tiene **exactamente 2** call-sites en todo
el repo y **ninguno en tests**; ningún test pasa `chainKey: 'solana-devnet'` a `verifyDeposit`.

### `[SDD GAP #3]` — cita de línea equivocada en §4.7-3

El SDD cita el bug del `CREATE OR REPLACE` que crea sobrecarga como
`20260529000000_a2a_key_deposits.sql:148-155`. **Ese archivo tiene 104 líneas.** La documentación real
está en **`:27-31`** y el `DROP FUNCTION` en **`:32`**. El contenido del SDD es correcto; la cita no.
Usá `:27-31` como exemplar y **no vayas a buscar líneas que no existen**.

---

*Story File — NexusAgil · F2.5 · WKH-315*
