# Story File — HU WKH-307: idempotencia del settle Solana respaldada en ledger

> SDD (autoritativo, leelo antes de codear): `doc/sdd/209-wkh-307-solana-durable-idempotency-ledger/sdd.md`
> Work item: `doc/sdd/209-wkh-307-solana-durable-idempotency-ledger/work-item.md`
> Branch: `fix/209-wkh-307-solana-durable-idempotency-ledger`
> Modo: **QUALITY** · money-path · Estimación **L**
> Baseline de tests: **4065 passed | 19 skipped**

Este archivo es tu contrato. **No repite el SDD**: lo referencia por sección (§). Lo que sí está
completo acá es lo que no se puede perder en la traducción.

---

## 0. Qué se construye, en tres frases

El registro de "a qué `intentId` de Solana ya se le pagó y con qué firma" vive hoy en un `Map` de
proceso. Un restart lo borra, y después de ese restart el sistema **no sabe** si ya le pagó a un
agente: un retry re-transmite un SPL transfer real. Esta HU lo reemplaza por una tabla propia
(`a2a_solana_settle_intents`) con una máquina de tres estados (`claimed` → `signed` → `confirmed`)
cuyas transiciones son **escrituras condicionales atómicas** que informan en la misma operación si
aplicaron, y el reclamo ocurre **antes de que exista ninguna firma**.

Solana no tiene backstop on-chain (a diferencia de EIP-3009, con su nonce determinístico). Este
seam de aplicación es **la única** defensa contra el doble pago.

---

## 1. Las siete cosas que no podés no entender

Si algo de esta sección no te cierra, **parate y preguntá**. Cada punto es una decisión que se ve
rara si no sabés por qué está.

### 1.1 La bomba del identificador de reserva (DT-9) — **esto se elimina, no se conserva**

En `src/lib/downstream-payment.ts`, dentro de `settleSolanaLeg`, hay una línea que dice:

```ts
const legIntentId = intentId ?? `${agent.slug}:${payTo}`;
```

Cuando el caller no pasa `intentId`, la clave de idempotencia se **deriva del nombre del agente y
de su dirección de cobro**. O sea: una clave que es **la misma para todos los pagos a ese agente,
para siempre**.

Con el `Map` in-memory + TTL eso era casi inocuo: deduplicaba durante ~50 minutos y después la
entrada expiraba. Molesto, acotado, invisible.

**Con un registro durable, esa misma línea significa que el agente cobra una sola vez en su vida.**
El primer pago queda registrado como `confirmed`; **todo pago futuro a ese agente encuentra la fila,
re-verifica la firma vieja on-chain (que es válida, porque ese pago sí ocurrió), la devuelve, y no
transfiere un centavo.** Y el sistema reporta **éxito**. El agente trabaja gratis y nadie se entera.

**Estado real, verificado con grep exhaustivo:** los dos únicos call-sites de producción de
`invokeAgent` en `src/services/compose.ts` pasan `` `${composeRunId}:${i}` `` con
`composeRunId = randomUUID()`, e `invokeAgent` es el único caller de `signAndSettleDownstream`.
**El fallback es hoy inalcanzable.**

> **Y por eso mismo se elimina.** Este es el ejemplo canónico de una línea inofensiva que se vuelve
> catastrófica **cuando arreglás otra cosa**. Hoy es inalcanzable *y* inocua. Después de esta HU
> sigue siendo inalcanzable pero **ya no es inocua**: el día que alguien agregue un call-site que
> omita el argumento —un retry manual, un job de reconciliación, un endpoint nuevo— activa un modo
> de falla silencioso y permanente. La tentación es dejarlo "por las dudas". **Dejarlo por las dudas
> ES el bug**: un fallback existe para cubrirte cuando falta el dato, y acá el fallback es peor que
> no pagar.

**Qué hacés**: el `intentId` pasa a ser **obligatorio** para el leg Solana. Se elimina el fallback
derivado. Si `intentId` es `undefined` o string vacío, `settleSolanaLeg` devuelve `null` con
`code: 'MISSING_INTENT_ID'` **sin tocar la red**. Es fail-closed y no cambia ningún comportamiento
actual (el argumento siempre viene).

> **Alternativa prohibida**: derivar `randomUUID()` por invocación. Sería peor todavía — un
> identificador de idempotencia distinto en cada intento **desactiva la idempotencia entera** y
> convierte cualquier retry en un pago nuevo. Un identificador que no es estable entre reintentos no
> es un identificador de idempotencia.

### 1.2 El hallazgo del SDK: hay que dejar de usar `sendAndConfirmTransaction` (DT-6)

Verificado **en el SDK instalado** (`node_modules/@solana/web3.js` v1.98.4), no supuesto:

```
sendAndConfirmTransaction   →  connection.sendTransaction(transaction, signers, ...)
connection.sendTransaction  →  const latestBlockhash = await this._blockhashWithExpiryBlockHeight(...)
                            →  transaction.recentBlockhash = latestBlockhash.blockhash   ← INCONDICIONAL
                            →  transaction.sign(...signers)                              ← RE-FIRMA
```

La función cómoda **sobrescribe el blockhash aunque ya esté seteado, y vuelve a firmar** antes de
enviar. Consecuencia directa: **es imposible conocer la firma antes de la transmisión** mientras uses
ese helper. Cualquier pre-firma que hagas queda invalidada, y la firma "real" recién existe cuando la
transacción ya salió.

**Por qué eso rompe la HU entera**: la firma ed25519 de una transacción Solana existe *antes* del
broadcast (es la firma sobre el mensaje). Ese hecho es lo que permite **persistir primero y
transmitir después**, y de ahí sale la invariante que hace recuperable el caso feo:

> **Invariante I2 — el broadcast ocurre SIEMPRE después de que la firma quedó persistida. Por lo
> tanto, una fila en `claimed` (sin firma) DEMUESTRA que nunca se transmitió nada.**

Sin esa invariante, la ventana "transmitió con éxito pero se cayó antes de persistir" no tiene
salida: no podés distinguir "no salió nada" de "salió y no sé cuál", y las dos únicas conductas
posibles son pagar dos veces o trabar la plata para siempre. Con la invariante, un `claimed` viejo
es **prueba** de que no salió nada, y un `signed` te da la firma exacta para preguntarle a la cadena.

**Qué hacés** (§4.4 del SDD, pasos 5-7): `getLatestBlockhash` → setear `feePayer` +
`recentBlockhash` + `lastValidBlockHeight` → `tx.sign(operator)` →
`signature = base58Encode(tx.signature)` → **persistir `signed`** → `sendRawTransaction(tx.serialize())`
→ `confirmTransaction({signature, blockhash, lastValidBlockHeight})`. `base58Encode` ya existe en
`src/adapters/solana/base58.ts` y ya se usa para esto mismo en `candidateSignatureFromFailure`.

### 1.3 El efecto de segundo orden: el índice único parcial es obligatorio (DT-10 / AC-9)

Al dejar el helper del SDK **perdés un bucle que no sabías que estaba ahí**: `sendTransaction` lleva
un `Set` de firmas ya vistas y, si la firma derivada se repite bajo el blockhash cacheado, **re-pide
blockhash y re-firma**. Ese bucle te estaba tapando un caso real:

Dos legs del mismo run que le pagan **al mismo agente** **el mismo monto**. Los `intentId` difieren
(`run:0`, `run:1`), pero el mensaje de la transacción es idéntico (mismo from-ATA, mismo to-ATA,
mismo monto, mismo operador). Bajo el **mismo blockhash**, mensaje idéntico ⟹ **firma ed25519
idéntica** ⟹ **una sola transferencia on-chain** contabilizada como dos pagos.

**El agente cobra la mitad de lo que se le acreditó, y las dos filas dicen que se le pagó.**

**Qué hacés**: índice **único parcial** sobre la firma
(`CREATE UNIQUE INDEX ... (settle_signature) WHERE settle_signature IS NOT NULL`). El paso
"persistir `signed`" choca con `23505`; como el choque ocurre **antes del broadcast**, todavía no
salió nada: re-pedís blockhash, re-firmás, hasta `SOLANA_SETTLE_SIGN_MAX_ATTEMPTS` (default 3);
agotados, fail-closed. Es **más fuerte** que el bucle que reemplaza: aquel era un `Set` en memoria
de la `Connection` (por proceso, se pierde en el restart); éste es durable y cross-proceso.

> **El índice no es opcional ni "defensa en profundidad": es la reposición de una protección que
> DT-6 quita.** Si el `.sql` sale sin `UNIQUE`, la HU deja el sistema peor que como lo encontró.

### 1.4 Escritura condicional atómica, con el reloj del servidor (DT-2 / DT-12 / CD-1 / CD-12)

**PROHIBIDO** un `SELECT` que decida y un `INSERT`/`UPDATE` que ejecute. Toda transición es **una
sola operación de base de datos que informa en su propio resultado si aplicó**:
`INSERT ... ON CONFLICT (intent_id) DO UPDATE ... WHERE <cond> RETURNING` para el reclamo,
`UPDATE ... WHERE intent_id = ? AND <estado esperado> RETURNING` para las transiciones.

**Y el reloj es el de Postgres, no el de Node.** La condición de toma de un reclamo huérfano es
`claimed_at < now() - lease`. Si el umbral lo calculás en JS y lo mandás como `.lt('claimed_at', iso)`,
el reloj es el del **cliente**: dos instancias del gateway con skew tienen leases distintos, y una
instancia adelantada **roba un lease vivo** ⟹ dos broadcasts. Con `now()` de Postgres hay un solo
reloj para todos los procesos. Por eso las cuatro transiciones son funciones `plpgsql` invocadas con
`supabase.rpc(...)`, no cadenas `.update().eq(...)`.

> **Único `SELECT` permitido** (§DT-2, aclaración anti-falso-positivo): después de un upsert
> condicional que ya devolvió **0 filas**, para *clasificar* al perdedor (¿`signed`? ¿`confirmed`?
> ¿términos distintos?). Ese `SELECT` **no puede autorizar nada**: el único camino que devuelve
> `outcome:'claimed'` es el que la escritura atómica devolvió **con** filas. Lo canda `T-LDG-13`.

### 1.5 Fail-closed: no saber si ya pagaste **no puede** significar pagar (CD-2 / AC-4)

Cliente no configurado, RPC que tira, error de Postgres, `data` vacío, `applied: undefined`,
preflight negativo, forma inesperada de la respuesta: **todo eso es "no sé", y "no sé" nunca
autoriza una transferencia**. No hay fallback al `Map` (que ya no existe), no hay degradación
silenciosa, no hay "seguí igual y que el verify de después lo agarre".

La asimetría es deliberada y hay que poder defenderla: **un agente que no cobra es recuperable**
(retry, reconciliación, pago manual). **Un agente que cobra dos veces no lo es.** Riesgo R-2 del
SDD, aceptado a propósito.

Corolario de tipos (CD-11, del auto-blindaje de HU-202): **ninguna función de este seam devuelve
`boolean`**. Un `false` colapsa "el guard lo rechazó" / "la escritura falló" / "el store no está",
que tienen remedios distintos. Uniones discriminadas, siempre.

### 1.6 El preflight ejecutable: *un gate que nadie corre no es un gate* (DT-11 / AC-11)

La migración se aplica **solo a bdwv** (AC-7 / CD-4). Aplicarla a producción (caldz) es
**WKH-307b**, founder-gated, fuera de esta HU. Eso significa que **existe por diseño al menos una
base sin la tabla**.

La lección textual que motiva el preflight, del auto-blindaje de HU-202:

> *"Toda vez que un valor de retorno pasa de telemetría a condición de dinero, su precondición de
> esquema deja de ser documentación y pasa a ser código. **Un gate que nadie corre no es un gate.**"*

Un aviso en el header del `.sql` diciendo "aplicar antes de deployar" es prosa. Lo que hacés es
`src/adapters/solana/schema-preflight.ts`, espejo exacto de `src/adapters/escrow/schema-preflight.ts`:
probe perezoso + memoizado, veredicto **discriminado**, `warmSolanaSchemaPreflight()` fire-and-forget
desde `src/index.ts`, y **enforcement en `settle()` como primera operación**. Veredicto negativo ⟹
`settle()` rechaza ruidoso, con el motivo distinguible (`table_missing` / `rpc_missing` /
`probe_failed`), **nunca** un fallback.

El probe es **positivo**: llama al RPC de reclamo con `p_probe := true`, que hace
`RAISE EXCEPTION 'WKH307_PROBE_OK'` **como primera sentencia**, antes de cualquier escritura.
Recibir esa excepción demuestra que la función deployada es la nueva, sin escribir una sola fila.

**Consecuencia declarada**: mientras la migración no esté en caldz, un entorno que apunte a caldz con
`SOLANA_ADAPTER_ENABLED=true` no settlea Solana. Es fail-closed deliberado. Hoy el default del flag
es `false` y la cadena es devnet-only, así que el impacto operativo esperado es nulo.

### 1.7 Los tests que se retiran: la tabla la completás vos, no borrás en bloque

`src/adapters/solana/intent-dedup.test.ts` (791 líneas, **26 tests**) canda una política —TTL, cap,
ventana protegida, reloj inyectable— que DT-5 **elimina entera**. Un test de una política borrada no
puede sobrevivir a la política. Pero:

> **Una pérdida de cobertura silenciosa acá sería exactamente lo que esta HU viene a evitar.**

Por eso §4 de este archivo tiene la tabla **test por test, con los nombres reales del archivo**, y
una columna que **completás vos** con la evidencia del destino. Borrar el archivo y escribir uno
nuevo sin esa tabla es motivo de rechazo en AR, aunque la suite quede verde.

---

## 2. Scope IN — archivos exactos, con anclas **por contenido**

> ⚠️ **Anclas por contenido, nunca por número de línea.** Mientras se escribía este Story File, los
> dos call-sites de `invokeAgent` en `src/services/compose.ts` se movieron de 387→448 y de 667→778
> por otra HU en vuelo. Si anclás por línea, tu diff apunta a otra cosa.

### 2.1 Crear

| Archivo | Qué hace | Exemplar (verificado en disco) |
|---|---|---|
| `supabase/migrations/20260730000000_wkh307_solana_settle_intents.sql` | Tabla + PK + índice **UNIQUE parcial** sobre `settle_signature` + índice de inventario + las 4 funciones `plpgsql` de transición + GRANTs + `COMMENT ON` + cabecera con gate de orden de release y consultas de inventario (§4.7 del SDD) | `supabase/migrations/20260729000000_hu202_hop2_lease.sql` |
| `..._wkh307_solana_settle_intents_down.sql` | `DROP FUNCTION`/`DROP INDEX` + **RENAME** de la tabla a `..._backup_wkh307`. **NUNCA `DROP TABLE`** | `20260729000000_hu202_hop2_lease_down.sql` |
| `src/adapters/solana/settle-ledger.ts` | **Único** archivo de `src/adapters/solana/**` que importa `../../lib/supabase.js`. Expone `claimSettleIntent`, `recordSignedIntent`, `recordConfirmedIntent`, `reclaimExpiredIntent`, `readSettleIntent`. Resultados **discriminados**, fail-closed, logs sin PII | `wasiai-facilitator/src/infra/solana-escrow-release-dedup.ts` (solo lectura) + `src/adapters/escrow/debit-executor.ts` (`recordDebitSettleStatus`) |
| `src/adapters/solana/schema-preflight.ts` | Probe memoizado + `ensureSolanaSchemaReady()` + `warmSolanaSchemaPreflight()` + `_resetSolanaSchemaPreflight()` TEST-ONLY | `src/adapters/escrow/schema-preflight.ts` (`ensureEscrowSchemaReady` / `warmEscrowSchemaPreflight` / `_resetEscrowSchemaPreflight`, `EscrowSchemaVerdict`) |
| `scripts/apply-wkh307-migration.mjs` | Applier **bdwv-only**: refs hardcodeados, abort si resuelve a caldz, keys identificadas por el claim `ref` del JWT (**nunca** por el nombre de la variable), post-estado leído del catálogo | `scripts/apply-hu202-migration.mjs` (`BDWV_REF` / `CALDZ_REF` / `jwtRef`) |
| `src/adapters/solana/settle-ledger.test.ts` | T-LDG-01..13 | `src/adapters/escrow/debit-executor.test.ts` (mock `vi.mock('../../lib/supabase.js', () => ({ supabase: { rpc: vi.fn() } }))`) |
| `test/wkh307-solana-settle-intents.migration.test.ts` | T-MIG-01..14, SQL-estructural | `test/hu202-hop2-lease.migration.test.ts` (`flat()`, `code()`, `fnBody()`, `evalSqlPredicate()` — **exportado**, reusable) |

### 2.2 Modificar (ancla = texto exacto presente hoy)

| Archivo | Ancla por contenido | Qué hacés |
|---|---|---|
| `src/types/database.types.ts` | entrada `a2a_refund_outbox` como molde de `Row`/`Insert`/`Update` | Agregar `a2a_solana_settle_intents` + las 4 funciones en `Functions`. Sin esto, `supabase.rpc(...)` no typechequea |
| `src/adapters/solana/payment.ts` | `// ── Idempotencia (DT-10 / AC-7) — seam W3 ─` … hasta antes de `export class SolanaPaymentAdapter` | **Borrar** todo el bloque de política: `const _intentSignatures = new Map<string, IntentEntry>();`, `resolveIntentTtlMs`, `resolveMaxIntentEntries`, `resolveProtectedWindowMs`, `evictIntentSignatures`, `_warnedSoftCapBreached`, `ESTIMATED_MAX_RUN_WALL_CLOCK_MS`, `intentDedupNow`, `_intentDedupClock`, `rememberIntentSignature`, `recallIntentSignature` |
| ídem | `const prior = recallIntentSignature(req.intentId);` y `_intentSignatures.delete(req.intentId);` | Reemplazar el bloque de entrada de `settle()` por: preflight → reclamo atómico → ramas de §4.3 del SDD. **El `delete` + re-emisión (self-heal) desaparece** — ver R-3 en §5.3 de este archivo |
| ídem | `signature = await sendAndConfirmTransaction(connection, tx, [operator], {` | Reemplazar por firma explícita + `sendRawTransaction` + `confirmTransaction` (§1.2) |
| ídem | `// Persist-before-return del seam de idempotencia (W5 lo respalda en ledger).` + `rememberIntentSignature(req.intentId, signature);` | Reemplazar por `recordConfirmedIntent(...)`. **El comentario declara esta HU como pendiente: se va con él** |
| ídem | `export function _intentDedupSize`, `export function _seedIntentSignature`, `export function _setIntentDedupClock`, `export function _intentDedupPolicy` | **Borrar los 4.** `export function _resetSolanaClients(): void {` **se conserva** (lo usan `payment.test.ts` y `settle-wiring.test.ts`), con el cuerpo vaciado de lo que ya no existe |
| ídem | `recoverConfirmedSettle`, `verify`, `candidateSignatureFromFailure` | **Se conservan con su cuerpo intacto.** Son la validación de verdad |
| `src/adapters/types.ts` | `getSettledSignature(intentId: string): string \| undefined;` | → `getSettledSignature(intentId: string): Promise<SettledPeek>;` + el tipo `SettledPeek` (`none` / `settled` / `in_progress` / `unknown`). **Nunca lanza**: un fallo del store se traduce a `unknown` |
| `src/lib/downstream-payment.ts` | ``const legIntentId = intentId ?? `${agent.slug}:${payTo}`;`` | **Eliminar el fallback** (§1.1). `intentId` ausente/vacío ⟹ `return null` con `code: 'MISSING_INTENT_ID'`, sin tocar la red. La firma de `settleSolanaLeg` deja de tener `intentId?: string` opcional |
| ídem | `const priorSignature = adapter.getSettledSignature(legIntentId);` y `const isIdempotentReplay = priorSignature !== undefined;` | `await` + mapeo de §DT-8: `settled`/`in_progress` ⟹ **sonda** (no corta); `none` ⟹ **gate**; `unknown` ⟹ **gate** con `code: 'SETTLE_LEDGER_UNAVAILABLE'` |
| `src/lib/downstream-skip-code.ts` | `\| 'BALANCE_LOW_ON_IDEMPOTENT_REPLAY';` (fin del type `DownstreamSkipCode`) | Alta de `'MISSING_INTENT_ID'` y `'SETTLE_LEDGER_UNAVAILABLE'`. ⚠️ **`const PUBLIC_SKIP_CODE: Record<DownstreamSkipCode, PublicDownstreamSkipCode>` es exhaustivo por tipo: si no mapeás los dos, no compila.** Mapealos a códigos **públicos existentes** — `MISSING_INTENT_ID → 'NOT_CONFIGURED'`, `SETTLE_LEDGER_UNAVAILABLE → 'UNAVAILABLE'` — así **no** se agrega vocabulario público nuevo y `PUBLIC_SKIP_MEANING` no cambia (cero cambio de contrato de API) |
| `src/index.ts` | `if (isEscrowSettleEnabled()) warmEscrowSchemaPreflight();` | Agregar al lado el warm-up de Solana cuando `SOLANA_ADAPTER_ENABLED === 'true'` |
| `.env.example` | `SOLANA_INTENT_DEDUP_TTL_MS=` y `SOLANA_INTENT_DEDUP_MAX_ENTRIES=` | **Baja** de las dos con nota de deprecación (dejarlas "por compatibilidad" es peor: un operador creería que gobiernan algo). **Alta** de `SOLANA_SETTLE_LEDGER_LEASE_MS` (default 120000) y `SOLANA_SETTLE_SIGN_MAX_ATTEMPTS` (default 3) |
| `src/adapters/solana/intent-dedup.test.ts` | los 26 `it(` actuales | **Reescribir** según la tabla de §4. La tabla va como comentario de cabecera del archivo nuevo |
| `src/adapters/solana/payment.test.ts` | `vi.mock('@solana/web3.js', ...)` con `sendAndConfirmTransaction` | Dobles nuevos de `Connection` + T-PAY-01..07 |
| `src/adapters/solana/settle-wiring.test.ts` | `const sent: { tx?: Transaction; signers?: unknown; options?: unknown } = {};` | Ver §4.3 — **no es un "ajuste de dobles", es una re-anclada real** |
| `src/lib/downstream-payment.test.ts` | el doble de adapter con `getSettledSignature` | Peek async + los 2 skip-codes nuevos |

### 2.3 Scope OUT — no lo toques aunque te tiente

WKH-302 (mudar el broadcast al facilitator) · cualquier archivo de `wasiai-facilitator` (solo
lectura) · la tabla `facilitator_solana_settlements` (otra base) · **aplicar la migración a caldz** ·
dedup cross-caller (`x-idempotency-key`) · job de retención · instrucción Memo · **todo el camino
EVM** (`src/adapters/avalanche|base|tempo|kite-ozone/**` queda byte-idéntico) · `chain.ts`,
`base58.ts`, `attestation.ts`, `gasless.ts`, `registry.ts`, `src/services/compose.ts`.

---

## 3. Waves

| Wave | Depende de | Paralelizable |
|---|---|---|
| **W0** | — | **NO — gate serial.** Nadie empieza W1/W2 antes de que W0 esté en verde |
| **W1** | W0.4 | Sí: W1.1 y W1.2 son independientes entre sí |
| **W2** | W0.3, W0.4, W1.1, W1.2 | Parcial: W2.2 y W2.3 en paralelo una vez hecho W2.1 |
| **W3** | W2 | Sí: los 5 sub-items son archivos distintos |
| **W4** | W3 | **NO — serial.** La mutación necesita los tests que la cazan |

### W0 — contratos y esquema (serial)

- **W0.1** `..._wkh307_solana_settle_intents.sql`: tabla (§4.2 del SDD), PK sobre `intent_id`,
  **índice UNIQUE parcial sobre `settle_signature`**, índice de inventario, las 4 funciones con
  **firma y tipo de retorno estables desde el día 1** (todas devuelven la misma fila
  `(applied, outcome, status, settle_signature, last_valid_block_height, attempts)`, para que una
  migración futura pueda `CREATE OR REPLACE` sin `DROP` y sin ventana `PGRST202`), el parámetro
  `p_probe` con su `RAISE` como primera sentencia, GRANTs, `COMMENT ON`.
  **Sin `owner_ref` y sin RLS** — decisión explícita (§4.2 del SDD): es dedup global del gateway, el
  `intentId` no es objeto de un tenant y el adapter ni recibe `owner_ref`.
  **Montos como `TEXT`, nunca `NUMERIC`** (convención WKH-196).
- **W0.2** `..._down.sql`: `DROP FUNCTION` × 4 + `DROP INDEX` + **RENAME**, nunca `DROP TABLE`.
- **W0.3** `database.types.ts`: tabla + las 4 funciones.
- **W0.4** Tipos públicos del seam en `settle-ledger.ts` — **solo tipos y firmas, sin lógica**. Es lo
  que desbloquea W1 y W2 en paralelo.
- **W0.5** `scripts/apply-wkh307-migration.mjs`.
- **Verificación W0**: `npx tsc --noEmit` limpio. **No se aplica nada a ninguna base todavía.**

### W1 — el seam (paralelizable)

- **W1.1** `settle-ledger.ts`: las 5 funciones sobre `supabase.rpc(...)`, resultados discriminados,
  fail-closed, logs sin PII.
- **W1.2** `schema-preflight.ts`.

### W2 — rewiring del adapter

- **W2.1** `payment.ts` (borrado del bloque de política + `settle()` según §4.4 del SDD).
- **W2.2** `types.ts` + `downstream-payment.ts` + `downstream-skip-code.ts`.
- **W2.3** `index.ts` + `.env.example`.
- **Verificación W2**: `tsc` + `lint` + suite completa. Acá vas a ver rojo en los tests viejos: **es
  esperado**, W3 los resuelve según la tabla de §4 (no los borres para poner verde).

### W3 — tests (paralelizable por archivo)

W3.1 `settle-ledger.test.ts` · W3.2 `intent-dedup.test.ts` reescrito · W3.3 `payment.test.ts` ·
W3.4 `test/wkh307-...migration.test.ts` · W3.5 `downstream-payment.test.ts` + `settle-wiring.test.ts`.

### W4 — verificación dura (serial)

W4.1 campaña de mutación (§5) · W4.2 `npm run migrate:preflight` + applier **contra bdwv
exclusivamente**, post-estado leído del catálogo · W4.3 e2e manual devnet opcional
(`SOLANA_DEVNET_E2E=1`) · W4.4 `auto-blindaje.md` + done-report.

---

## 4. Destino de la batería existente — **completá la última columna**

### 4.1 `src/adapters/solana/intent-dedup.test.ts` — 26 tests, nombres reales

> El SDD estimó "~40 tests retirados". El conteo auditado es: **23 eliminados**, **2 invertidos**,
> **1 migrado** en este archivo, más **24 re-anclados** en otros dos archivos (no eliminados).
> Reportá los números auditados, no la estimación.

| # | Test (nombre real) | Destino | Por qué | Evidencia (**la completás vos**) |
|---|---|---|---|---|
| 1 | `T-TTL-1: una entrada FRESCA sigue siendo idempotente` | **ELIMINADO** | La propiedad sobrevive en `T-IDM-03`, pero sin TTL el escenario "fresca" no existe | |
| 2 | `T-TTL-2: una entrada EXPIRADA se trata como ausente` | **ELIMINADO** | No hay expiración (DT-5) | |
| 3 | `T-TTL-3: leer una entrada expirada la BORRA` | **ELIMINADO** | ídem | |
| 4 | `T-TTL-4: el barrido en el set limpia las expiradas` | **ELIMINADO** | No hay barrido | |
| 5 | `T-TTL-5 (INVARIANTE): no puede expirar dentro de la cota estimada` | **ELIMINADO** | La invariante deja de ser necesaria: nada expira | |
| 6 | `T-TTL-6 (INVARIANTE): el TTL default duplica la cota estimada` | **ELIMINADO** | ídem | |
| 7 | `T-TTL-7 (FAIL-SAFE del knob): override corto se eleva al piso` | **ELIMINADO** | El knob se retira de `.env.example` | |
| 8 | `T-TTL-8: un override RAZONABLE se respeta` | **ELIMINADO** | ídem | |
| 9 | `T-TTL-9: el TTL sigue a TIMEOUT_COMPOSE_MS` | **ELIMINADO** | ídem | |
| 10 | `T-TTL-10: env inválida → default` | **ELIMINADO** | ídem | |
| 11 | `T-TTL-11 (AR MENOR-1): el piso del knob es la cota ESTIMADA` | **ELIMINADO** | ídem | |
| 12 | `T-CAP-1: el cap DESALOJA las más viejas` | **ELIMINADO** | No hay cap (una tabla no tiene el leak que el cap acotaba) | |
| 13 | `T-CAP-2 (FAIL-SAFE): todas protegidas → no se desaloja nada` | **ELIMINADO** | ídem | |
| 14 | `T-CAP-3: el cap excedido emite un warn una vez por episodio` | **ELIMINADO** | ídem | |
| 15 | `T-CAP-4: el desalojo respeta el borde exacto de la ventana` | **ELIMINADO** | ídem | |
| 16 | `T-CAP-5: env de cap inválida → default 10.000` | **ELIMINADO** | ídem | |
| 17 | `T-CAP-6 (AR MENOR-2): el warn se RE-ARMA al bajar del cap` | **ELIMINADO** | ídem | |
| 18 | `T-CAP-7 (AR MENOR-2): el re-armado también con el DESALOJO` | **ELIMINADO** | ídem | |
| 19 | `T-CLK-1: el reloj del seam es inyectable y el RESTORE vuelve al real` | **ELIMINADO** | El reloj pasa a ser el de Postgres (DT-12). No hay reloj de proceso que inyectar | |
| 20 | `T-CLK-2: el módulo ARRANCA con el reloj real` | **ELIMINADO** | ídem | |
| 21 | `T-NOTIMER: el barrido es lazy — ningún setInterval` | **ELIMINADO** | No hay barrido | |
| 22 | `T-HEAL-2: el self-heal RENUEVA la antigüedad` | **ELIMINADO** | Mecánica de retención pura | |
| 23 | `T-HEAL-3: settle nuevo sobre un intentId expirado re-emite` | **ELIMINADO** | Dependía de la expiración. **La propiedad legítima que cubría —una tx que nunca aterrizó se puede reintentar— sobrevive MEJOR en `T-IDM-06b`** (blockhash expirado = **prueba**, no inferencia por tiempo) | |
| 24 | `T-HEAL-1: firma previa que NO verifica → se borra y se re-emite` | **INVERTIDO** → `T-IDM-12` | **Cambio de conducta declarado (R-3).** Con store durable, "la firma registrada no verifica" es un RPC mintiendo o contabilidad corrupta: ninguna se arregla pagando de nuevo. El test nuevo afirma lo **contrario**: **0 broadcasts** + rechazo | |
| 25 | `T-P1-2a: firma que no verifica + re-broadcast que falla → no queda huérfana` | **INVERTIDO** → `T-IDM-12` | ídem: ya no hay re-broadcast que pueda dejar huérfana | |
| 26 | `T-P1-2b: firma que SÍ verifica → la entrada SOBREVIVE (N retries, CERO broadcasts)` | **MIGRADO** → `T-IDM-03` | **La propiedad es exactamente la de la HU** y sobrevive intacta; solo cambia el almacén | |

### 4.2 `src/adapters/solana/payment.test.ts` — 19 tests, **re-anclados, no eliminados**

Ninguno se borra. Los 12 que hoy pasan por `sendAndConfirmTransaction` (`T-234-AC2`,
`T-234-AC7`, `T-235a-AC1`, `AC1b`, `AC1b0`, `AC2`, `AC2b`, `AC2c`, `AC2d`, `AC2e`) se re-anclan a
`sendRawTransaction` + `confirmTransaction`. `T-FIX2-adapter` (que hoy afirma que
`getSettledSignature` es lectura pura sin RPC) se reescribe async con la unión discriminada.
Los de `quote()` y `getOperatorSplBalance()` no se tocan.

**Los tests de `recoverConfirmedSettle` son no-regresión de dinero: si alguno queda sin equivalente,
es un hallazgo, no una simplificación.**

### 4.3 `src/adapters/solana/settle-wiring.test.ts` — 5 tests, re-anclada **no trivial**

El SDD lo llama "ajuste de dobles"; en el código es más que eso. Hoy el archivo captura la
`Transaction` **como objeto**:

```ts
const sent: { tx?: Transaction; signers?: unknown; options?: unknown } = {};
```

desde el mock de `sendAndConfirmTransaction`, y `T-P1-6a/b/d/e` decodifican `tx.instructions[0].data`
byte a byte (el monto u64 LE, el program id real, la dirección operador→payTo). Con `sendRawTransaction`
**recibís un buffer serializado, no un objeto**. Qué hacés:

1. `fakeConnection` deja de ser `{ __stub: 'connection' }`: necesita `getLatestBlockhash`,
   `sendRawTransaction`, `confirmTransaction` (y `getBlockHeight` donde aplique).
2. La captura pasa a ser el argumento de `connection.sendRawTransaction`, y **rehidratás** con
   `Transaction.from(raw)` — que preserva instrucciones, `programId`, `keys` y `data`, así que las
   4 aserciones de bytes siguen valiendo **sin aflojarse**.
3. `T-P1-6c` ("firma el OPERADOR y el commitment configurado viaja al broadcast") pasa a afirmar
   sobre `Transaction.from(raw).signatures[0].publicKey` y sobre `preflightCommitment`.
4. **Agregá `vi.mock` de `./settle-ledger.js` y de `./schema-preflight.js`.** Sin eso el settle
   intenta hablar con el `supabase` que `vitest.config.ts` apunta a `http://localhost:54321`, el
   claim falla, y **por fail-closed los 5 tests se ponen rojos por el motivo equivocado**.

> Lo mismo aplica a `payment.test.ts`: los dobles del ledger y del preflight son ahora precondición
> de todo test que llegue a `settle()`.

---

## 5. Tests por AC — **los tests miden transmisiones, no mecanismo**

### 5.0 La unidad de medida

El doble de `Connection` lleva `sendRawTransaction: vi.fn()`. **Casi toda aserción de esta HU termina
en `expect(mockSendRaw).toHaveBeenCalledTimes(N)` con `N ∈ {0,1}`**, más el monto y el destino cuando
`N = 1`. La pregunta que responde cada test es *¿salió una transmisión? ¿cuántas? ¿de cuánto y a
quién?* — **nunca** *¿se llamó a tal función interna?* ni *¿existe tal variable?*.

Razón (CD-10, auto-blindaje HU-202 22:00): una tabla de verdad re-implementada en JS es **verdadera
por construcción** — se demostró con una mutación stealth que quedó verde. Para el SQL: **extraé y
evaluá** el predicado del `.sql` con el `evalSqlPredicate` que `test/hu202-hop2-lease.migration.test.ts`
ya exporta. Nunca lo reescribas en JS.

### 5.1 Un test por AC

| AC | Test | Archivo | Qué afirma (efecto, no mecanismo) |
|---|---|---|---|
| AC-1 | `T-IDM-01` | `intent-dedup.test.ts` | Reclamo rechazado ⟹ `sendRawTransaction` **0 veces** y `settle()` rechaza. Camino feliz: el `rpc('claim_solana_settle_intent')` ocurre **antes** del primer `sendRawTransaction` (`mock.invocationCallOrder`) |
| AC-2 | `T-IDM-02` | ídem | Dos `settle()` concurrentes (`Promise.allSettled`) sobre el mismo `intentId`, contra un doble con **PK real emulada** (un `Map` interno que rechaza el 2º insert): `sendRawTransaction` **exactamente 1 vez**; la perdedora rechaza y **no** devuelve `success:true` |
| AC-3 | `T-IDM-03` | ídem | Fila `confirmed` + `verify()` válido ⟹ devuelve **esa** firma, **0** broadcasts, y `getParsedTransaction` **se llamó** (la firma no se devolvió sin re-verificar). Absorbe `T-P1-2b`: N retries, **0** broadcasts |
| AC-4 | `T-IDM-04` | ídem | Tres modos de indisponibilidad (rpc lanza · rpc devuelve `error` · `data` vacío): en los tres, **0** broadcasts. **Ningún** camino devuelve `success:true` |
| AC-5 | `T-IDM-05` | ídem | **El test que canda el motivo de existir de la HU.** Instancia **nueva** de `SolanaPaymentAdapter` tras `_resetSolanaClients()` (cero estado en memoria) con la fila `confirmed` ya en el doble ⟹ devuelve la firma previa, **0** broadcasts |
| AC-6 | `T-IDM-06a/b/c` | ídem | (a) `signed` + tx confirmada on-chain ⟹ devuelve la firma, **0** broadcasts, la fila pasa a `confirmed`; (b) `signed` + no confirmada + `getBlockHeight() > last_valid_block_height` ⟹ re-firma y **exactamente 1** broadcast nuevo, con la firma vieja archivada en `expired_signatures`; (c) `signed` + no confirmada + blockhash **vivo** ⟹ **0** broadcasts y rechazo |
| AC-7 | `T-MIG-14` | migration test | El applier hardcodea el ref de bdwv, aborta si resuelve al de caldz, identifica keys por el claim `ref` del JWT. Afirma que el literal de caldz aparece **solo** en el guard de abort |
| AC-8 | `T-IDM-07` | `intent-dedup.test.ts` | Fila `confirmed` para `payTo=A, amount=3000000`; llega `settle()` con `payTo=B` ⟹ **0** broadcasts **y** el retorno **no** contiene la firma de A. Ídem con `amountAtomic` distinto y con `mint` distinto (3 casos) |
| AC-9 | `T-IDM-08` | ídem | El doble emula `UNIQUE(settle_signature)`: 1er `recordSigned` con firma S pasa, el 2º (otro `intentId`) devuelve 23505 ⟹ el adapter **re-firma** y el broadcast sale con firma **distinta**; **nunca** dos filas con la misma `settle_signature`. Borde: agotados los 3 intentos ⟹ **0** broadcasts |
| AC-10 | `T-IDM-09` + `T-MIG-08` | ídem + migration | `claimed` **fuera** del lease ⟹ el reclamo lo toma y sale **1** broadcast (no queda trabada). `claimed` **dentro** del lease ⟹ **0** broadcasts. `T-MIG-08` **evalúa el predicado extraído del `.sql`** sobre la tabla de verdad de las dos direcciones |
| AC-11 | `T-IDM-10` | ídem | Preflight negativo ⟹ **0** broadcasts y rechazo con el código de esquema. **Segundo caso: se afirma el COSTO** — el rpc de probe se llamó **1** vez en 3 `settle()` (memoización). Lección HU-208 M5: toda afirmación del tipo *"no agrega costo"* tiene que asertar el costo |
| R-3 | `T-IDM-12` | ídem | Fila `confirmed` cuyo `verify()` **falla** ⟹ **0** broadcasts + rechazo. Es la inversión explícita de `T-HEAL-1`/`T-P1-2a` |
| DT-8 | `T-IDM-11` | ídem | `getSettledSignature` async: los 4 valores de `SettledPeek` y su efecto en el pre-check (§DT-8 del SDD) |

### 5.2 `payment.test.ts` — orden persist→broadcast (T-PAY-*)

`T-PAY-01` `recordSigned` ocurre **antes** de `sendRawTransaction` (`invocationCallOrder`) y la firma
persistida es **exactamente** la transmitida (`base58Encode(tx.signature)` == arg de `recordSigned`
== retorno de `settle()`) · `T-PAY-02` `recordSigned` no aplica ⟹ **0** broadcasts (invariante I2 en
forma falsable) · `T-PAY-03` `feePayer`/`recentBlockhash` seteados **antes** de `tx.sign`, y
`confirmTransaction` recibe el **mismo** blockhash/`lastValidBlockHeight` persistido · `T-PAY-04`
`sendAndConfirmTransaction` **ya no se importa ni se invoca**: su doble registra **0** llamadas en
todos los caminos · `T-PAY-05` no-regresión de `verify()` (monto/mint/destino, `delta < required` ⟹
`valid:false`) · `T-PAY-06` no-regresión de `recoverConfirmedSettle` · `T-PAY-07` `getSettledSignature`
async.

### 5.3 `settle-ledger.test.ts` (T-LDG-*)

`01..05` un test por `outcome` del reclamo, y **ninguno de los cuatro no-`claimed` puede confundirse
con autorización** · `06` cliente/RPC que lanza ⟹ `{ok:false, reason:'store_unavailable'}`, **nunca**
`{ok:true}` · `07` error de Postgres no-23505 ⟹ `store_unavailable`, **no** "no existe" · `08` 23505
en `recordSigned` ⟹ `signature_collision`, distinguible de `not_claimed` · `09` `data` vacío / forma
inesperada / `applied: undefined` ⟹ **no confirmado** · `10` los montos viajan como **string**, cero
`Number()`/`parseFloat` sobre `amount_atomic` · `11` logs sin PII · `12` **el doble de `supabase.rpc`
CAPTURA sus args y el test afirma sobre ellos** (CD-9 — HU-202 pagó este error tres veces; dos
mutaciones sobrevivieron por él) · `13` ningún camino devuelve `outcome:'claimed'` sin fila devuelta
por el upsert (§1.4).

---

## 6. Los 15 mutantes, uno por uno

**Reglas** — (a) **todo mutante debe COMPILAR** (`npx tsc --noEmit` limpio, o `.sql` sintácticamente
válido) antes de contarse: un mutante que no compila no prueba nada, lo cazó el compilador, no el
test. (b) La evidencia de reversión es el **`sha256sum`**, no el `git status`: esta HU crea archivos
untracked y `git checkout --` no los revierte. Guardá el listado de hashes antes de empezar y
compará al final. (c) **Nunca `git checkout --`**: hay otra HU con cambios sin commitear en este
mismo árbol de trabajo.

| # | Mutación (compila) | Dónde (ancla por contenido) | Test asesino |
|---|---|---|---|
| **M1** | `if (claim.outcome !== 'claimed') { throw ... }` → `if (false) { throw ... }` (se transmite sin reclamo) | `payment.ts`, rama posterior al reclamo en `settle()` | `T-IDM-01`, `T-IDM-02`, `T-IDM-04` |
| **M2** | Variante sutil de M1: `if (claim.outcome !== 'claimed' && false)` | ídem | `T-IDM-01`, `T-IDM-02` |
| **M3** | Mover la llamada al reclamo **después** de construir y firmar la tx (sigue antes del broadcast: el orden se rompe, el efecto no obviamente) | `payment.ts`, `settle()` | `T-IDM-01` (orden por `invocationCallOrder`) |
| **M4** | `store_unavailable` se trata como "no existe" ⟹ se reclama igual y se transmite | `settle-ledger.ts`, traducción del error del rpc | `T-IDM-04`, `T-LDG-06`, `T-LDG-07` |
| **M5** | `applied !== true` → `applied === false` (un `undefined` pasa como éxito) | `settle-ledger.ts` | `T-LDG-09` |
| **M6** | **Mover `recordSigned` DESPUÉS de `sendRawTransaction`** (rompe I2) | `payment.ts`, pasos 6↔7 de §4.4 | `T-PAY-01`, `T-PAY-02` |
| **M7** | Ignorar el resultado de `recordSigned` y transmitir igual | `payment.ts` | `T-PAY-02`, `T-IDM-01` |
| **M8** | `terms_conflict` devuelve la firma previa en vez de rechazar | `payment.ts`, rama de §4.5 | `T-IDM-07` (los 3 casos) |
| **M9** | El estado `confirmed` devuelve la firma **sin** llamar a `verify()` | `payment.ts`, rama `confirmed` | `T-IDM-03` (afirma que `getParsedTransaction` se llamó) |
| **M10** | El estado `signed` re-firma y re-transmite **sin** chequear el block height | `payment.ts`, rama `signed` | `T-IDM-06c` (blockhash vivo ⟹ 0 broadcasts) |
| **M11** | El 23505 de `recordSigned` se traga y se transmite igual | `settle-ledger.ts` / `payment.ts` | `T-IDM-08`, `T-LDG-08` |
| **M12** | En el `.sql`: borrar `AND t.claimed_at < now() - make_interval(...)` del `ON CONFLICT DO UPDATE` (el lease deja de existir ⟹ cualquier retry roba el reclamo) | migración, `claim_solana_settle_intent` | `T-MIG-08` (**evalúa** el predicado extraído, no lo re-implementa) |
| **M13** | En el `.sql`: borrar los tres `AND t.<término> = EXCLUDED.<término>` (AC-8 desaparece) | migración, `claim_solana_settle_intent` | `T-MIG-09` |
| **M14** | En el `.sql`: crear el índice de `settle_signature` **sin** `UNIQUE` (AC-9 desaparece, §1.3) | migración, bloque de índices | `T-MIG-10` |
| **M15** | En el `_down.sql`: `DROP TABLE` en vez de `RENAME` (destruye la evidencia de qué se pagó) | migración `_down` | `T-MIG-13` |

### 6.1 Cuando un mutante sobrevive — **dos causas, no una**

Un sobreviviente **no significa automáticamente que falta un test**. Las causas son dos:

1. **Falta un test** — la propiedad no está candada. Escribís el test.
2. **La mutación no era una mutación** — el runtime iguala las dos implementaciones, así que no hay
   nada que cazar.

> **Determinalo empíricamente antes de escribir nada.** Si escribís un test para un mutante
> equivalente, lo que estás candando es una **equivalencia accidental**: el test pasa por un motivo
> que no es la propiedad, y el día que el runtime cambie se rompe sin que nada esté mal. Probá la
> equivalencia (ejercitá los dos caminos con el mismo input y compará el resultado observable) y, si
> es equivalente, **documentalo como equivalente** en el reporte de la campaña.

### 6.2 Las aserciones de andamiaje se validan desarmando el escenario

Varios tests de esta HU necesitan aserciones que existen **para probar que el escenario está
armado** (que la fila `signed` quedó sembrada, que el doble emula la PK, que el preflight devolvió
positivo). Esas aserciones son las que más fácil se vuelven decorativas.

> **Regla: una aserción que existe para probar que el escenario está armado se valida desarmando el
> escenario y viendo el rojo.** Sacá la siembra, corré, confirmá que el test falla **por esa línea**.
> Si sigue verde, la aserción no prueba nada y el test entero está midiendo aire.

---

## 7. Anti-Hallucination Checklist (marcá antes de abrir el PR)

```
[ ] Ningún path, función, símbolo o API que use fue inventado: todos verificados con Read/Grep
[ ] `sendAndConfirmTransaction` NO se importa ni se invoca en payment.ts (T-PAY-04 lo canda)
[ ] El fallback `intentId ?? `${agent.slug}:${payTo}`` fue ELIMINADO de downstream-payment.ts
[ ] El índice sobre settle_signature es UNIQUE y PARCIAL (WHERE settle_signature IS NOT NULL)
[ ] Ninguna decisión de transmitir se apoya en un SELECT previo (CD-1/CD-12); el único SELECT
    permitido es de clasificación posterior y no puede producir outcome:'claimed' (T-LDG-13)
[ ] El umbral del lease usa now() de POSTGRES, no un ISO calculado en Node
[ ] Ninguna función del seam devuelve boolean (CD-11): todas uniones discriminadas
[ ] settle-ledger.ts es el ÚNICO archivo de src/adapters/solana/** que importa lib/supabase.js (CD-7)
[ ] Cero Number()/parseFloat/+ unario sobre amount_atomic o last_valid_block_height (CD-8)
[ ] Ningún log de nivel info lleva payTo completo, secretKey ni la private key (CD-15)
[ ] Los 2 skip-codes nuevos están en PUBLIC_SKIP_CODE (Record exhaustivo) mapeados a códigos
    públicos EXISTENTES: PUBLIC_SKIP_MEANING no cambia, el contrato de API tampoco
[ ] Los dobles de supabase.rpc CAPTURAN sus args y al menos un test afirma sobre ellos (CD-9)
[ ] Cero TTL, cap, ventana protegida, desalojo o reloj inyectable reintroducidos (CD-13)
[ ] SOLANA_INTENT_DEDUP_TTL_MS y SOLANA_INTENT_DEDUP_MAX_ENTRIES ya no las lee ningún código
[ ] El reclamo es la PRIMERA operación de settle() tras el preflight, fuera de toda rama de
    transporte (CD-14, requisito R1 de WKH-302)
[ ] La tabla de §4.1 está COMPLETA con evidencia por fila (26 filas, ninguna vacía)
[ ] NO se aplicó ninguna migración a caldz. NO se tocó doc/sdd/_INDEX.md
[ ] NO se tocaron: contracts/.gas-snapshot, doc/audit/, doc/jury-qa*.md,
    doc/sdd/118-wkh-sec-02b-owner-ref-rpc/
[ ] NO se usó `git checkout --` ni ningún git destructivo (hay otra HU con cambios sin commitear
    en este árbol: src/services/compose.ts, src/routes/orchestrate.ts, src/lib/compose-input-mapping.ts)
[ ] Sin Co-Authored-By en los commits (repo público)
```

---

## 8. Verificación y Done Definition

### 8.1 Gates

```bash
npx tsc --noEmit        # COMPLETO — no alcanza `npm run build`: tsconfig.build.json excluye tests (lección WKH-196)
npm run lint            # biome check src/
npm test                # vitest run
npm run migrate:preflight
```

### 8.2 Baseline y delta — **declarado, no escondido**

Baseline: **4065 passed | 19 skipped**.

El conteo final **no** va a ser `4065 + N`. La identidad que tenés que reportar, con los dos números
auditados y la tabla de §4.1 como evidencia:

```
final = 4065 − <eliminados> + <nuevos>
```

Estimación de referencia (auditada, no una promesa): eliminados **23** (§4.1),
nuevos ≈ **50** (T-LDG 13 + T-IDM ~14 + T-PAY 7 + T-MIG 14 + downstream ~4) ⟹ **≈ 4092**.
Si tu número real se aleja, **explicá por qué**; no lo presentes como regresión ni lo maquilles.

### 8.3 Done

1. Los **15 mutantes** corridos, **todos compilando**, con veredicto documentado. Un sobreviviente
   sin test nuevo que lo cace (o sin prueba empírica de equivalencia, §6.1) es un hallazgo abierto.
2. Post-estado de bdwv **leído del catálogo** (`information_schema.columns`, `pg_indexes`,
   `pg_get_functiondef` de las 4 funciones), no asumido del exit code del applier. **caldz intacta**,
   con el guard del applier como evidencia.
3. Done-report que declare: **delta neto de tests** con su motivo · el **cambio de conducta R-3**
   (el self-heal que re-broadcasteaba desaparece — que no se lea como regresión) · la revisión de
   sizing **M → L**.
4. Work-item de **WKH-307b** creado ("aplicar la migración a caldz + habilitar el leg Solana en
   prod", founder-gated). Sin ese ticket, AC-7 deja una base sin esquema y el fail-closed de AC-11 es
   la única red: un desmantelamiento sin ticket es una llave dormida con otro nombre.
5. `auto-blindaje.md` de esta HU.
6. Comunicado a WKH-302 su único pedido de vuelta (§3.3 del SDD): si `POST /solana/payout` devuelve
   la firma antes de que el gateway persista, el gateway igual persiste `signed` con esa firma
   **antes** de tratar el leg como pagado.

### 8.4 Nota de release (no es código)

Deployar con `SOLANA_ADAPTER_ENABLED=false`, o fuera de una ventana de tráfico Solana. Único riesgo
residual: un compose-run **exactamente** a mitad de un settle Solana durante el restart del deploy.
Es una instancia única del mismo problema que la HU corrige, no un caso nuevo.

**Orden de release, no negociable: la migración va ANTES del código.** Orden correcto ⟹ sin ventana
(tabla vacía, nadie la lee todavía). Orden inverso ⟹ el preflight falla-closed y el leg Solana no
settlea hasta que la migración esté: degradación ruidosa y recuperable, **no** doble pago. Ese es
exactamente el punto de que el gate sea código y no prosa.

---

*Story File — NexusAgil · F2.5 · WKH-307*
