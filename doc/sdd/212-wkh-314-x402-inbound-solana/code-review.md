# CR — WKH-314 · x402 inbound en Solana (tras el fix-pack del AR)

**Veredicto: RECHAZADO** — 3 `BLQ-BAJO`, 7 `MNR`.

**Ninguno de los 6 hallazgos del AR volvió.** Los 6 arreglos son *el arreglo correcto* y están vivos
bajo mutación. Lo que bloquea es deuda **nueva** que el fix-pack introdujo, toda de bajo impacto.

Rama `feat/212-wkh-314-x402-inbound-solana-f3`, commit `882028e` sobre `e8abe36`, base `main@75de7eb`.
Instrumentos: `/usr/bin/git`, `/usr/bin/sed`, `/usr/bin/cat`, `/usr/bin/wc`. Mutación en **worktree
aislado** (`node_modules` por symlink, removido al terminar). JSON de vitest validado por raíz
(0 archivos fuera de `/wasiai-a2a/`). Atribución **por nombre de test**, nunca por exit code. Sin
`pkill`. El CR **no tocó** `src/`, `test/` ni migraciones.

| Puerta | Resultado |
|---|---|
| `tsc --noEmit` | exit 0 |
| `biome check src/` | exit 0 — 501 archivos |
| Suite completa | 303 archivos · 5937 tests · **5918 passed / 0 failed** / 19 skipped |
| Los 19 skipped | todos `*.real.test.ts` / `*.manual.test.ts` preexistentes. **Ninguno de WKH-314** |
| `cited-lines-guard` · `readme-numbers` · `ownership-filter-guard` | 38/38 passed |
| Los 22 `it()` nuevos del fix-pack | los 22 hallados por título en el JSON, **los 22 passed** |

---

## 0. Mutación propia del CR — 13 mutantes, muertos por NOMBRE de test

No aceptó los 20/20 del dev ni el verde del fix-pack.

| Mutante | Qué rompe | Muerto por |
|---|---|---|
| M1 | `BigInt(presented.amountAtomic) >= BigInt(requiredAmount)` → `\|\| true` | `T-PRICE-01` |
| M2 | guard de `payTo`/`mint` → `if (false)` | `T-PRICE-04` |
| M3 | saca `c.nonce` del material del MAC | `T-CHAL-02b`, `T-STEAL-01/02/03` |
| M3b | `randomBytes` → `Buffer.alloc(16, 7)` | `T-CHAL-02b/02c`, `T-STEAL-01/02` |
| M4 | `landed_failed` rank 0 → 3 | `T-UNK-06b`, `T-UNK-08`, `T-UNK-08b` |
| M5 | `if (reply.sent) return reply;` → `if (false)` | `T-504-01` |
| M6 | timeout de `getSignatureStatuses` → `absent` | `T-RPCTO-01` |
| **M6b** | reescribe el `detail` del timeout | **SOBREVIVE — mutante equivalente** (sólo cambia un string que ningún test assertea). No es hueco |
| M6c | saca `withRpcTimeout` de `getParsedTransaction` | `T-RPCTO-02` |
| M6d | binding del timeout → `reference_absent` | `T-RPCTO-02` |
| M7 | `if (primaryViolation !== null)` → `if (false)` | `T-PRE-04c` |
| M8 | mensaje de `PROOF_ABSENT` siempre "two nodes" | `T-ABSX-01` |
| M9 | comenta `warnOnFallbackShape()` | `T-PRE-06`, `T-PRE-06b` |

**12/13 muertos, el 13º es equivalente.** Los 6 arreglos tienen candado real.

---

## 1. Veredicto sobre los seis puntos del encargo

### 1 · `extra.nonce` como cambio de contrato — **ACEPTABLE** (con MNR-3)

Si el cliente no lo eco-repite, medido:

| Caso | Código | Retry-After | ¿Consume? |
|---|---|---|---|
| omite el campo | `X402_SOLANA_PROOF_MALFORMED` | no | **no** (`T-STEAL-03`) |
| manda otro valor | `X402_SOLANA_REFERENCE_MISMATCH` | no | **no** (`T-STEAL-03`) |

Deniega limpio, no consume, y el mensaje **nombra el campo** (`solana-x402-challenge.ts:245-247`).

**Por qué es aceptable**: el sobre ya exigía eco-repetir **seis** campos no-estándar (`reference`,
`payTo`, `amountAtomic`, `mint`, `issuedAt`, `expiresAt`). Ninguna wallet genérica ni Solana Pay podía
hablar este rail antes; el `nonce` es el **séptimo** campo de un sobre que ya era custom, no un
contrato nuevo. Verificado que viaja: `x402.ts:600` lo publica en `extra`, `doc/INTEGRATION.md:928` y
`:955` lo documentan en las dos puntas, `:962-964` dice "the **seven** `authorization` fields". El tipo
lo hace **obligatorio** (`adapters/types.ts:553`, no opcional). **No hay `/.well-known` que publique el
sobre** (`src/routes/well-known.ts` no lo toca): el contrato vive en el 402 y en `INTEGRATION.md`.

Que el rail nazca apagado lo vuelve aceptable **con evidencia**: `acceptsInboundPayment`
(`src/adapters/registry.ts:523-531`) da `false` para Solana hasta que estén las 4 envs ⇒ hoy **nadie**
puede tener un cliente escrito contra el sobre de 6 campos.

### 2 · Los 8 s — **la lección del repo NO se reproduce acá** (el número sí es problema: BLQ-BAJO-3)

Qué sigue corriendo tras el vencimiento: `withRpcTimeout` (`inbound-presence.ts:107-129`) es
`Promise.race` sin `AbortSignal`, así que el `fetch` sigue en vuelo. **Pero las dos llamadas techadas
son de SÓLO LECTURA** — `getSignatureStatuses` (`:176`) y `getParsedTransaction` (`:429`) — y su
resultado se descarta. **No hay bucle, no hay reintento propio, no hay escritura**: un solo fetch en
vuelo por llamada. El fallo de `techo-promise-race-no-frena-el-trabajo` (bucle a ~40.000 req/s tras el
vencimiento) **no tiene análogo acá**. No puede consumir la prueba: el consumo está detrás de `x402.ts:1063`.

Verificada la trampa que sí podía haber: `Promise.race` deja la rechazada colgando como
`unhandledRejection`. Probado el patrón exacto con un `work` que rechaza 150 ms después de que el techo
ganó ⇒ **exitCode 0, cero `unhandledRejection`**. El `clearTimeout` del `finally` (`:126`) está.

### 3 · `return reply` vs `return` — **la afirmación del dev es FALSA; el código está bien**

Medido contra **Fastify 5.9.0** (el del repo), preHandler que manda el 504 desde fuera del lifecycle:

```
[return reply]     status=504 handlerRan=false hookPosteriorRan=false
[return undefined] status=504 handlerRan=false hookPosteriorRan=false
[ambos] dentro del hook: reply.sent = true
```

Con `reply.sent === true`, `undefined` es **idéntico** a `reply`. Lo que corta la cadena es el
`reply.send()` previo. ⇒ *"con `undefined` el route handler habría corrido el trabajo pago"* **no se
sostiene**. El **comentario del código dice lo correcto** y contradice a la desviación reportada
(`x402.ts:1055-1056`). → `MNR-1`.

**El camino EVM con `return;` no tiene el mismo problema**: sus 6 chequeos (`x402.ts:1358, 1371, 1398,
1467, 1491, 1569`) hacen `return;` **después** de un `.send()` propio o dentro del guard
`FST_ERR_REP_ALREADY_SENT` (`:1356`). **No hay hallazgo nuevo en código viejo.**

### 4 · Reusar códigos de error — **aceptable como decisión, incompleto como doc** (MNR-3)

Un integrador **sí** distingue, pero no por el `error_code`: por el `message` (`x402.ts:812`) y porque
el rechazo del sobre rancio ocurre **antes de P3** (`T-PRICE-01` lo assertea con los mocks sin llamar).

**Lo que falta**: la remediación no es la misma. Para "la cadena acreditó de menos",
`INTEGRATION.md:989` dice *"no — waiting will not help"*, correcto. Para "tu sobre es de otro precio",
la remediación es pedir un 402 nuevo y **pagar de nuevo**, y la transferencia ya en cadena con la
referencia vieja **queda varada para siempre**.

⚠️ **Nota de arquitectura que el comentario de P2b oculta**: `x402.ts:797-799` dice *"Es el mismo guard
que la rama EVM"*. Las **reglas** son las mismas; la **consecuencia** no. En EVM la autorización
EIP-3009 aún no se liquidó cuando se rechaza — no se movió un centavo. En Solana el pagador **ya
transfirió** antes de presentar. La analogía es correcta en mecánica y **engañosa en riesgo**.

### 5 · Los dos tests que cambiaron de expectativa — **ninguno afloja; los dos ENDURECEN**

**`T-CHAL-02b`** (`solana-x402-challenge.test.ts:90-110`): de `toBe` a `.not.toBe`, y ahora **mide la
precondición del ataque antes de asertar** (`issuedAt`, `maxAmountRequired`, `payTo`, `mint`,
`resource` iguales, `:100-104`). Antes 1 aserción tautológica; ahora 6, y muere con **dos** mutantes
(M3 y M3b). Nace `T-CHAL-02c` (200 emisiones → 200 nonces, ninguno contiene el timestamp), que impide
reemplazar el CSPRNG por un contador.

**`T-UNK-08`** (`inbound-verify.test.ts:79-108`), dos cambios:
- `[OK, FAILED, 'finalized_ok'] → [OK, FAILED, 'landed_failed']`: **ése era el bug** (BLQ-MED-1); M4 lo confirma.
- `[MISMATCH, FAILED, 'terms_mismatch']` **salió** de la tabla simétrica. La tabla assertea los dos
  órdenes con el mismo resultado, y `MISMATCH`/`FAILED` ahora **empatan en tier 0** ⇒ el desempate lo
  gana el primario y el resultado depende del orden. **No se perdió cobertura**: `T-UNK-08b`
  (`:124-134`) assertea **los dos órdenes explícitamente**. M4 lo mata también. Cobertura neta **mayor**.

**`T-ABSX-01`** (`x402.solana-inbound.test.ts:648-665`): el rename es honesto — el fallback está borrado
en el `beforeEach`, así que medía UN nodo. Ahora assertea `'one node searched'`,
`.not.toContain('two independent nodes')` **y** `probeMock` llamado 1 vez. Nace `T-ABSX-02` (`:667-690`),
el gemelo real de dos nodos con `probeMock` 2 veces. M8 mata a `T-ABSX-01`.

### 6 · `landed_failed` a tier 0 — **sí existe el caso legítimo** → `BLQ-BAJO-1`

---

## 2. BLOQUEANTES

### `BLQ-BAJO-1` · el veto de `landed_failed` no exige finalidad, y el `finalized_ok` al que le gana sí

**Categoría**: Data Integrity / Error Handling
**Archivo:línea**: `src/adapters/solana/inbound-presence.ts:204-205` · `:207` ·
`src/adapters/solana/inbound-verify.ts:34-40` · `src/middleware/x402.ts:960-962` · `:548-552`

`probeInboundLanding` devuelve `landed_failed` **en cuanto `status.err` es truthy** y recién **después**
mira `confirmationStatus`:

```
204:  if (status.err) {
205:    return { state: 'landed_failed', detail: JSON.stringify(status.err) };
206:  }
207:  const conf = status.confirmationStatus;
```

⇒ un status a nivel `processed` o `confirmed` con `err` produce `landed_failed`, que tras el fix es
**tier 0 y le gana a `finalized_ok`** (`inbound-verify.ts:66-69`). **Un veto no finalizado vetando una
afirmación finalizada** es la asimetría que el resto del archivo evita en todos lados.

**Input concreto**: primario devuelve `{err: {InstructionError: [...]}, confirmationStatus: 'processed'}`
— una tx incluida en una bifurcación que después se descarta, que en devnet no es exótico. Fallback
devuelve `{err: null, confirmationStatus: 'finalized'}`.
- Esperado: `finalized_ok` (una tx `finalized` es inmutable; una `processed` no vota contra ella), o
  al menos `unknown` reintentable.
- Real: `combineInboundPresence` da `landed_failed` → `x402.ts:960-962` → `X402_SOLANA_TX_FAILED`, que
  **no está** en `SOLANA_RETRYABLE_CODES` (`:548-552`) ⇒ **sin `Retry-After`**, e `INTEGRATION.md:991`
  le dice al pagador *"no"* en la columna "retriable".

**Impacto**: un pagador cuya transferencia **sí** se finalizó recibe *"the transaction landed and failed
on-chain: nothing moved"* y la guía documentada de que reintentar no sirve. Su USDC quedó en la wallet
del gateway y no recibió servicio. La prueba no se consume, así que un cliente terco se recupera, **pero
la doc le dice que no lo intente**.

**Y hace falsa la razón escrita**: `inbound-verify.ts:34-35` afirma *"Es una aserción POSITIVA sobre una
transacción **inmutable**"*. Para el sub-caso `processed`/`confirmed` la transacción **no es inmutable**,
que es la definición misma de esos commitments.

**Fix**: exigirle al veto el mismo estándar que al grant — `landed_failed` sólo cuando
`confirmationStatus === 'finalized'`, y `unknown` (reintentable) cuando el `err` viene sin finalidad; o
dejar el rank en 0 pero declarar `X402_SOLANA_TX_FAILED` retryable cuando el veto no está finalizado.
Cualquiera necesita su gemelo en `inbound-presence.test.ts` y la corrección de `inbound-verify.ts:34-35`.

### `BLQ-BAJO-2` · cinco citas `archivo:línea` rotas por la propia edición — viola CD-A1 (3/3)

Las cinco, verificadas con `/usr/bin/sed -n 'Np'`:

| Cita escrita | Dónde | Qué hay HOY ahí | Dónde está de verdad |
|---|---|---|---|
| `` `:1226` en este archivo `` | `src/middleware/x402.ts:799` | `.status(400)` | `x402.ts:1318` |
| `` `:1272` `` | `src/middleware/x402.ts:1059` | `const canonical = request.headers[X_PAYMENT_HEADER];` | `x402.ts:1356` |
| `x402.ts:1217` | `src/middleware/x402.solana-inbound.test.ts:933` | `{` | `x402.ts:1318` |
| `x402.ts:1030-1033` | `src/middleware/x402.solana-inbound.test.ts:226` | comentario suelto | `x402.ts:1131-1133` |
| `x402.ts:1226` | `story-file.md:551` | `.status(400)` | `x402.ts:1318` |

**Causa raíz, medida**: en `e8abe36` `BigInt(auth.value) < BigInt(requiredAmount)` estaba en `:1217` y
`x402ChallengeAmountUsd === 'number'` en `:1031`. **Las citas eran correctas al escribirse.** El propio
fix-pack insertó ~113 líneas encima (P2b +67, comentario de P7 +13, rama `absent` +9, resto) y las
corrió. Es exactamente el patrón que `CD-A1` nombra: *"Las tres HUs rompieron **sus propias** citas al
editar"*.

**Por qué bloquea**: `CD-A1` está declarada **3/3** en `story-file.md:144-152` con regla operativa
literal — *"Obligatorio al cerrar CADA wave: re-abrir cada cita escrita en esa wave y confirmarla con
`sed -n 'Np'`"*, y cierra con *"No agregues las tuyas."* Son **cinco**. Y las cuatro que apuntan a
`x402.ts` son el argumento de paridad que sostiene P2b: quien vaya a verificar *"es el mismo guard que
la rama EVM"* aterriza en `.status(400)`, dentro de la rama de chain-no-soportada. **Falso negativo de
verificación sobre el money-path.**

**Nada se pone rojo**: `cited-lines-guard.test.ts` está verde porque estos archivos no están en su
"Corte A". El guard no cubre esto **por diseño** (su propio docblock lo dice).

**Fix**: re-derivar las 5 con `/usr/bin/grep -n` del literal; o citar **el símbolo**
(`resolvePaymentRequirements`, `Guard FST_ERR_REP_ALREADY_SENT`), que es lo único que sobrevive a la
próxima inserción.

### `BLQ-BAJO-3` · "los 60 s de `/compose`" no existen — viola CD-A2 (3/3)

**Archivo:línea**: `src/adapters/solana/inbound-presence.ts:92-94`

```
94: * serie × 2 proveedores deja el peor caso por debajo de los 60 s de `/compose`.
```

Medido:

| Ruta | Techo real | Archivo:línea |
|---|---|---|
| `/compose` | `TIMEOUT_COMPOSE_MS ?? '180000'` → **180 s** | `src/routes/compose.ts:914` |
| `/orchestrate` (×3) | `TIMEOUT_ORCHESTRATE_MS ?? '120000'` → **120 s** | `src/routes/orchestrate.ts:151, 329, 559` |
| `/inbound`, `/agent-links` | idem → **120 s** | `src/routes/inbound.ts:54`, `agent-links.ts:143` |

**Ninguna ruta del repo usa 60 s.** El número viene del encabezado histórico de
`src/middleware/timeout.ts:3` (*"WKH-18: AC-9 (60s compose)"*), también viejo.

**Y afirma de más en un segundo eje**: "el peor caso" no son 32 s. Antes corre
`ensureSolanaInboundReady` (P0), que en estado no-memoizado dispara `probeInboundProofStore`,
`probeRpcHistoryRetention` y `warnOnTokenAccountShape` (`inbound-preflight.ts:245`, `:264`, `:277`) —
**ninguna con techo** — más el peek, el observe y el consume contra Postgres. Los 8 s acotan **dos** de
las llamadas del camino, no el camino.

**Fix**: corregir el denominador (180 s / 120 s), acotar la afirmación a *"las dos llamadas RPC de este
archivo"*, y —para que envejezca bien— derivar el techo del `TIMEOUT_*_MS` efectivo.

---

## 3. MENORes

- **`MNR-1`** · la desviación 2 reportada no se sostiene, aunque el código sí. Corregir **el reporte**,
  no `x402.ts:1063`.
- 🔴 **`MNR-2` · los dos README afirman que esta HU no existe.** `README.md:97`, `:160`, `:214` y
  `README.es.md:105`, `:168`, `:248` siguen diciendo *"The inbound challenge is still EVM"* / *"Solana
  settles outbound; it does not charge inbound"* / *"`x-payment-chain: solana-devnet` stops with
  `400 CHAIN_INBOUND_PAYMENT_UNSUPPORTED`"*. Con las 4 envs puestas eso es **falso**:
  `acceptsInboundPayment` (`registry.ts:527-531`) da `true` y sale un **402**, no un 400.
  `doc/INTEGRATION.md:906-909` sí lo condiciona bien; los README no. La HU **editó** los dos README
  (números) y dejó las 6 frases. Nada lo pone rojo: `readme-numbers.test.ts` cuenta archivos, no prosa.
  **No debería ir al backlog.**
- **`MNR-3`** · `INTEGRATION.md:970-971` (*"Your signature is not consumed by any of those rejections"*)
  tranquiliza de más. Cierto e incompleto: en `AMOUNT_SHORT` por sobre viejo, la transferencia ya en
  cadena con la referencia vieja **no se puede reusar nunca** (402 nuevo ⇒ `nonce` nuevo ⇒ referencia
  nueva ⇒ `reference_absent`). Escenario honesto, no de atacante: el precio sube entre el 402 y la
  presentación porque `resolveComposePriceHandler` lo recalcula. **Residuo de dinero no declarado**, y
  este repo declara sus residuos (`x402.ts:635-638` lo hace para el otro).
- **`MNR-4`** · P2b no está en el mapa de fases. `x402.ts:621-623` enumera `P0·P1·P2·P3·P4·P5·P6·P7·P9`
  y **no menciona P2b**, la fase que hace el guard del monto. (Los marcadores del cuerpo sí están.)
  `:617` dice *"la secuencia P0..P9"* cuando P8 no existe — nit preexistente.
- **`MNR-5`** · el comentario de `T-UNK-08b` (`inbound-verify.test.ts:126-128`) dice *"no cuál de los dos
  strings gana"* y `:129-133` fija exactamente cuál gana. El test es más frágil de lo que declara.
- **`MNR-6`** · `warnOnFallbackShape` compara una URL trimeada contra una sin trimear:
  `SOLANA_RPC_URL_FALLBACK?.trim()` contra `getSolanaRpcUrl()`, que **no** trimea (`chain.ts:39-41`).
  Con `"https://x "` vs `"https://x"` el warn "SAME url" no sale. Falla inocuo, pero no mide lo que dice.
- 🔴 **`MNR-7`** · `auto-blindaje.md:121-134` declara como **medido** un comportamiento de instrumento
  **que no se reproduce** (*"el hook reescribe `cat`/`sed` y el resultado colapsa líneas"*, *"El comando
  sale 0: la pérdida es silenciosa"*). Ver §5. **No debería ir al backlog**: el próximo agente lo va a
  leer como hecho establecido y va a descartar como artefacto conocido un desacuerdo que sería un
  hallazgo real.

---

## 4. Ítems del encargo sin hallazgo

- **Ningún test nuevo se lee a sí mismo.** Barrido de los 7 archivos de test por `readFileSync` /
  `import.meta.url` / `__filename` / `process.cwd()`. Único hit:
  `test/wkh314-inbound-proofs.migration.test.ts:22-44`, y lee **los dos `.sql`**, no su propio fuente.
  Los 13 mutantes confirman que ninguno es tautológico.
- **Los gemelos positivos están** (`CD-A4`): `T-PRICE-02/03/04`, `T-UNK-06c`, `T-RPCTO-03`, `T-PRE-04d`,
  `T-ABSX-02`. Y assertean el `error_code`, no el status.
- **`T-504-01` hace la carrera determinista** con un `peekMock` bloqueado hasta que el test lo suelta
  (`x402.solana-inbound.test.ts:1046-1056`), no "probablemente antes".
- **Sin scope drift.** 17 archivos = 6 arreglos + tests + 3 docs. `chain.ts` sólo exporta la función
  nueva **sin tocar `getSolanaConnection()`** (correcto: la comparte el leg de salida).
- **Sin migraciones, RPC/`SECURITY DEFINER` ni cache nuevos** en el fix-pack.

---

## 5. Sobre el instrumento `cat`/`sed` — no se reproduce, y la causa real es otra

Medido dos veces, una sobre el archivo y la versión exactos que el dev dice haber medido:

```
chain.ts HOY (329 lineas): /usr/bin/wc -l = 329 · cat -n (hook) a archivo = 329
chain.ts @ e8abe36  (303): /usr/bin/wc -l = 303 · cat -n (hook) = 303 · diff hook vs /usr/bin/cat = IDENTICOS
sed -n '261p' hook == /usr/bin/sed -n '261p'  -> misma linea, byte a byte
```

**El hook no elide.** Lo que **sí** se reproduce es otra cosa, ya en memoria como
`rtk-proxy-corrupts-redirected-output`: `cat -n archivo | tail -1` bajo el hook devuelve **vacío con
exit 0**. El hook corrompe la salida **redirigida por pipe**, no el contenido del archivo. Muy
probablemente eso es lo que el dev vio y atribuyó mal. → `MNR-7`.

Lo que sí se confirma del reporte del dev: `chain.ts` tenía 303 líneas en `e8abe36` y 329 en `882028e`.
Y **`git diff` bajo el hook sigue truncando**: usar `/usr/bin/git` para todo.

---

## 6. Qué NO se pudo medir (palabras del CR)

1. **`BLQ-BAJO-1` contra la cadena real.** El caso de dos proveedores discrepando se derivó **leyendo
   el código** (`inbound-presence.ts:204` devuelve antes de `:207`), no observándolo en devnet. **No se
   midió con qué frecuencia pasa** ni si pasa alguna vez. Lo que sí se afirma: el camino de código
   existe y la frase del docblock es falsa para él.
2. **La interoperabilidad del `extra.nonce` con un cliente real.** Contrato verificado en código, tests
   y `INTEGRATION.md`. **No se probó ninguna wallet, ni Solana Pay, ni ningún SDK x402.** El
   "aceptable" se apoya en que los otros 6 campos ya eran custom y en que el rail nace apagado.
3. **La distribución de latencia de cualquier proveedor RPC.** No se puede decir si 8 s es alto o bajo.
   Sólo se midió que el denominador que lo justifica (60 s) es falso.
4. **La migración contra bdwv.** No aplicada. Las 3 funciones `SECURITY DEFINER` se leyeron, no se
   ejecutaron. (No cambian en el fix-pack.)
5. **Cobertura.** Se corrió `vitest run` completo, **no** `npm run test:coverage`. Sin número para los
   archivos nuevos ni certeza de que el piso del CI (80/70/80/80) aguante con las ~370 líneas agregadas.
6. **El costo del `observed` que se escribe después de un 504.** P6 (`x402.ts:1023`) corre **antes** del
   guard de `:1063`, así que un request ya respondido con 504 igual escribe su fila `observed`.
   Verificado que **no consume la prueba** y que ayuda al reintento. **No se midió** si tiene costo bajo
   carga ni si puede acumular filas huérfanas.
7. **El comportamiento con `SOLANA_RPC_URL` con espacios** (`MNR-6`). Derivado comparando
   `chain.ts:39-41` contra `inbound-preflight.ts`; no ejecutado.

---

## 7. Orden del fix-pack 2

1. **`BLQ-BAJO-1`** — exigirle finalidad al veto, o hacer `X402_SOLANA_TX_FAILED` retryable cuando el
   veto no está finalizado. Con gemelo en `inbound-presence.test.ts` y corrigiendo `inbound-verify.ts:34-35`.
2. **`BLQ-BAJO-2`** — re-derivar las 5 citas y **re-verificarlas con `sed -n 'Np'` DESPUÉS de la última
   edición**, que es lo que pide `CD-A1`.
3. **`BLQ-BAJO-3`** — corregir `inbound-presence.ts:94` (180 s / 120 s) y acotar *"el peor caso"*.
4. Los 7 MENORes, con **`MNR-2` (los README) y `MNR-7` (el auto-blindaje)** como los dos que **no**
   deberían ir al backlog: uno miente sobre lo que el producto hace, el otro le va a mentir al próximo agente.
