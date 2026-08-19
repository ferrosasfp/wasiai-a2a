# Adversarial Review — #214 · WKH-316 · El escritor del bloque `payment`

> Adversary: `nexus-adversary` · Fecha: 2026-08-19
> Rama auditada: `feat/214-wkh-316-payment-block` (6 commits) · Base: `main` @ `8242b16`
> Expediente leído: `work-item.md`, `sdd.md`, `story-file.md`, `auto-blindaje.md`
> Regla aplicada: **manda el Story File** donde contradice al work-item.

---

## VEREDICTO: **RECHAZADO** — 1 BLOQUEANTE-BAJO activo

| Nivel | # | IDs |
|---|---|---|
| BLQ-ALTO | 0 | — |
| BLQ-MEDIO | 0 | — |
| **BLQ-BAJO** | **1** | `BLQ-BAJO-1` |
| MENOR | 4 | `MNR-1` .. `MNR-4` |

El fix-pack es **de un solo ítem y no toca `src/`**: corregir dos números en la tabla
de citas desplazadas de `auto-blindaje.md`. Todo lo demás que se atacó — los 7 guards,
la whitelist, el merge, el borrado, el log de auditoría, la ownership, la doc — resistió.

**Lo que NO encontré, y lo digo explícito porque es el dato**: cero problemas de
seguridad explotables, cero pérdida de datos, cero ACs rotos, cero drift de scope,
cero queries nuevas sin filtro de dueño, cero secretos, cero dependencias nuevas.

---

## 0. Verificación de lo que el Dev declara (no heredé nada)

| Medición | Dev declara | Yo medí | ¿Coincide? |
|---|---|---|---|
| `npm test` (W4 final) | 289 archivos / 5746 passed / 19 skipped | `Test Files 289 passed \| 6 skipped (295)` · `Tests 5746 passed \| 19 skipped (5765)` | ✅ |
| `npx tsc --noEmit` | exit 0 | `tsc exit=0` | ✅ |
| `npm run lint` (biome) | exit 0 | `Checked 489 files … lint exit=0` | ✅ |
| README: 295 archivos de test | 295 | 289+6 = **295** | ✅ |
| README: 489 archivos que linta Biome | 489 | biome imprimió **489** | ✅ |
| md5 `src/lib/operator-address.ts` | `9d90b4d6…` | `9d90b4d678a3b90cdb834756b36ec053` | ✅ |
| md5 `src/services/agent.ts` | `0c19614e…` | `0c19614ecf91c4669bd4802cb3fcd3ad` | ✅ |

Los tres comandos corridos **sin redirección a archivo** y con la salida leída directa
(CD-A3). Árbol de trabajo verificado limpio antes y después de cada mutación
(`git status --porcelain` sólo muestra el `story-file.md` untracked del **otro agente**,
que no toqué).

---

## 1. El mutante que sostiene toda la HU — `M15`, re-corrido

**Pregunta del orquestador**: `M15` (el service persiste `updates.payment` crudo) pone rojo
exactamente UNO de 5753 tests. ¿Ese testigo discrimina de verdad, y hay un segundo camino
por el que el agujero se cuele sin que `T-316-25` se entere?

### Re-corrida independiente

Mutación aplicada en `src/services/agent.ts` (línea `meta.payment = paymentBlock;` →
`meta.payment = updates.payment;`), suite **completa**:

```
Test Files  1 failed | 288 passed | 6 skipped (295)
     Tests  1 failed | 5745 passed | 19 skipped (5765)
```

Único rojo: `src/services/agent.payment.test.ts:508` (`T-316-25`), y **muere por la razón
correcta**, no por una barata:

```
- Expected            + Received
  [ "asset", "chain", "contract", "method",
+   "network", "resolvedChain", "sarasa" ]
```

Es decir: el testigo detecta exactamente las keys derivadas envenenadas, no un
`toBe(422)` genérico. **Confirmado: `T-316-25` discrimina.**

### ¿Hay un segundo camino? — auditado, NO lo hay

Enumeré todos los sitios que escriben `metadata.payment`:

| # | Sitio | Quién produce el valor | Testigo |
|---|---|---|---|
| 1 | `src/services/agent.ts:472-478` (INSERT de `publish`) vía `buildMetadata(input, paymentBlock)` (`:452`) | `result.block` de `validatePaymentBlock` | `T-316-02` |
| 2 | `src/services/agent.ts:746` (`meta.payment = paymentBlock`, en el merge de `update`) | `result.block` | `T-316-25` |

No hay un tercero. Y el **lado de lectura no puede taparlo ni delatarlo**:
`readStoredPaymentBlock` (`src/lib/payment-spec-writer.ts:311-331`) hace whitelist en
lectura y `readPaymentSpec` recomputa `resolvedChain`/`network` en cada lectura, así que
un JSONB envenenado **no se ve en ninguna respuesta HTTP**. Eso es justamente por qué el
único testigo posible es un espía sobre el argumento del `update()`, que es lo que
`T-316-25` hace. Un solo testigo acá es la arquitectura correcta, no una debilidad.

**Control cruzado**: corrí además el mutante que borra `|| updates.payment !== undefined`
de la condición del merge (`src/services/agent.ts:729-732`, dentro del `if` de `:726-733`) → **4 failed**. O sea que la
condición del merge y la condición del log de auditoría no pueden derivar en silencio.

---

## 2. El bug que el Dev encontró solo — el `prev` que reportaba el valor nuevo

**Verificado el arreglo**: `previousPaymentBlock` se captura en
`src/services/agent.ts:691-693`, **antes** del bloque de merge (condición `:726-733`, cuerpo
`:734-754`).
La captura construye un objeto nuevo key-por-key (`readStoredPaymentBlock` `:324-330`),
así que la mutación posterior de `existing.metadata` no lo alcanza.

**Verificado que `M14` lo fija** — mutación: devolver la lectura al sitio del log
(`prev: readStoredPaymentBlock(readMetadataObject(existing.metadata))`), suite completa:

```
Test Files  1 failed | 288 passed | 6 skipped (295)
     Tests  2 failed | 5744 passed | 19 skipped (5765)
```

Y muere por la razón correcta (`agent.payment.test.ts:634`):

```
-   "contract": "So11111111111111111111111111111111111111112"   ← el viejo
+   "contract": "Vote111111111111111111111111111111111111111"   ← el nuevo
```

### ¿Hay otro lugar en el diff que lea después de mutar?

Barrí los tres consumidores de `readMetadataObject` en el diff:

- `mapRowToRecord` (`:174-197`) — sólo lee (`readSchema` × 2 + `readStoredPaymentBlock`), no muta.
- `publish()` — `buildMetadata` construye un `meta` **nuevo** (`:219`), no alias de nada.
- `update()` — el único mutador. Después del merge, `existing` **no se vuelve a leer**:
  el `.update()` usa `updateRow`, el log usa `previousPaymentBlock` (ya copiado) y
  `paymentBlock`, y el retorno usa `mapRowToRecord(data)` (la fila que devolvió Supabase).

**Sin hallazgos.** Nota de diseño que sí queda expuesta y es correcta: `updateRow.metadata`
y `existing.metadata` son **el mismo objeto** (`:734` + `:753-754`). Es inocuo porque
`existing` se descarta, pero es un alias vivo — está documentado en el comentario `:683-690`.

---

## 3. La desviación de scope autorizada — `test/ownership-filter-guard.exceptions.ts`

Verifiqué las **5 entradas una por una**, abriendo cada destino en el árbol final y
confirmando además que la línea pertenece a la **función que el motivo nombra** (no
alcanza con que sea un `.from('a2a_agents')` cualquiera).

| Entrada | `line` nuevo | Qué hay ahí | Función | ¿Es la que dice el motivo? |
|---|---|---|---|---|
| `getRow` (chequeo-en-js) | `347` | `.from('a2a_agents')` | `getRow` (`:345`) | ✅ |
| `getSplitContextRow` | `372` | `.from('a2a_agents')` | `getSplitContextRow` (`:366`) | ✅ |
| `listAsAgents` | `507` | `.from('a2a_agents')` | `listAsAgents` (`:505`) | ✅ |
| `listPublisherAnchors` | `547` | `.from('a2a_agents')` | `listPublisherAnchors` (`:537`) | ✅ |
| `getBySlugAsAgent` | `580` | `.from('a2a_agents')` | `getBySlugAsAgent` (`:578`) | ✅ |

Y las **5 citas de prosa dentro de esas mismas entradas**:

| Cita de prosa | Destino verificado |
|---|---|
| `docblock :359-364` (getSplitContextRow) | ✅ `:359` = `* WKH-143 (DT-4/CD-5) — lee SOLO las columnas de ownership/payout…`, `:364` cierra el párrafo |
| `:503` (listAsAgents) | ✅ `* NO filtra por owner — es la vista pública descubrible.` |
| `:633` (update, comparación en JS) | ✅ `if (existing.owner_ref !== ownerRef) {` |
| `:808` (delete, comparación en JS) | ✅ `if (existing.owner_ref !== ownerRef) {` |
| `:447` (pre-check de colisión de slug) | ✅ `const clash = await this.getRow(slug);` |

**Y los motivos siguen siendo ciertos**: leí las 5 cadenas completas en el árbol final y
ninguna cambió de forma ni de verbo. `listAsAgents` sigue acotada por `.eq('enabled', true)`,
`listPublisherAnchors` sigue por `.in('slug', slugs).eq('enabled', true)`, `getSplitContextRow`
sigue seleccionando `owner_ref, payout_wallet, referrer_ref` (lee la columna, no filtra por
ella), `getBySlugAsAgent` sigue devolviendo el shape público `Agent`, `getRow` sigue sin
filtro deliberadamente.

**Cero entradas nuevas, cero motivos reescritos** — confirmado mecánicamente: el diff del
archivo es `+9 −9`, todas ediciones de números dentro de entradas preexistentes.

**Cero `supabase.from(...)` nuevo en todo el diff** (CD-5 respetado). El guardián
`test/ownership-filter-guard.test.ts` corre verde en la suite completa.

**Sin hallazgos.**

---

## 4. `T-316-09` reescrito — ¿el `toLowerCase()` del paso 5 EVM es load-bearing?

**La afirmación del Dev es CIERTA: no es load-bearing.** Verificado por dos vías.

**Analítica** — `ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/` (`src/lib/wallet-format.ts:20`) exige
el prefijo `0x` **en minúscula**. El cuerpo de la zero-address son 40 ceros, que no tienen
caja. Luego, para todo input que pase el paso 4, `payTo.toLowerCase() === payTo`.

**Por mutación** — `src/lib/payment-spec-writer.ts:141`,
`payTo.toLowerCase() === EVM_ZERO_ADDRESS` → `payTo === EVM_ZERO_ADDRESS`, suite completa:

```
Test Files  289 passed | 6 skipped (295)
     Tests  5746 passed | 19 skipped (5765)      ← SOBREVIVE
```

Sobrevive, como el Dev declaró. **No es un finding**: es código defensivo muerto,
**declarado como muerto** en el docblock del test (`payment-spec-writer.test.ts:336-355`)
y en `auto-blindaje.md`. Es exactamente lo contrario de una afirmación de más.

### Y dónde SÍ decide algo — verificado que está vigilado

El paso 7 (`sameAddress`, `:146-149`) usa `toLowerCase()` en **los dos lados**, y ahí sí es
load-bearing: `privateKeyToAccount().address` devuelve la address con checksum EIP-55
(caja mezclada) y `ADDRESS_RE` acepta la variante en minúsculas. Sin la normalización,
**AC-6 se saltea mandando el operador en otra caja**.

Mutación `src/lib/payment-spec-writer.ts:147` → `return a === b;`:

```
Test Files  1 failed | 288 passed | 6 skipped (295)
     Tests  1 failed | 5745 passed | 19 skipped (5765)
```

Rojo en `payment-spec-writer.test.ts:396` — *"EVM: la MISMA address en otra caja también
rechaza"*. **El guard que importa SÍ tiene testigo.**

---

## 5. La desviación de firma — `buildMetadata(source, payment?)`

**El endurecimiento es real.** Con la firma que pedía el Story File
(`payment` como key de `source`), la llamada que ya existe en `publish()` es
`buildMetadata(input)`, e `input` es de tipo `PublishAgentInput` **que ahora tiene
`payment?`** (`src/types/index.ts:337-344`). O sea que `source.payment` sería literalmente
`input.payment` — el objeto que en el POST viene del route. Con el parámetro aparte, el
único valor pasable es el que produjo el validador: `src/services/agent.ts:452`
`buildMetadata(input, paymentBlock)`, y `paymentBlock` sólo se asigna en `:436`
(`paymentBlock = result.block`). La regla pasa de prohibición a imposibilidad.

**`M16` lo fija** — el Dev declara que `buildMetadata(input, input.payment)` pone rojo
`T-316-02`. Corroborado indirectamente por mi mutante equivalente sobre la whitelist
(`{ ...obj }` en `:285-289` de `payment-spec-writer.ts`), que puso rojo **5 tests en 3 archivos**, entre ellos
`T-316-02` y `T-316-22`.

**Sin hallazgos.** La desviación está declarada en `auto-blindaje.md` y es un
endurecimiento, no una relajación.

---

## 6. Las 4 citas desplazadas reportadas y NO arregladas — 🔴 **2 de 4 traen el número EQUIVOCADO**

Este es el único BLOQUEANTE del reporte. Ver `BLQ-BAJO-1` abajo.

Resumen de lo medido, anclando por **contenido** (no por delta global):

| Archivo que cita | Cita vieja (en `main`) | Qué es ese ancla en `main` | Dev reporta | Medido en HEAD | ¿OK? |
|---|---|---|---|---|---|
| `src/services/agent.ownership.test.ts:6` | `agent.ts:549` | `.eq('owner_ref', ownerRef)` de **`listMine`** | `:761` | `:761` = `.eq('owner_ref', ownerRef)` del **UPDATE de `update()`** · el correcto es **`:602`** | ❌ |
| `src/services/agent.ownership.test.ts:6` | `agent.ts:715` | `.eq('owner_ref', ownerRef)` de **`delete`** | `:822` | `:822` = `.eq('owner_ref', ownerRef)` de `delete` | ✅ |
| `src/services/orchestrate.ts:1160` | `agent.ts:526` | `const { data, error } = await supabase` de **`getBySlugAsAgent`** | `:599` | `:599` = la misma línea pero dentro de **`listMine`** · el correcto es **`:579`** | ❌ |
| `src/lib/self-published-auth.ts:29` | `routes/agents.ts:265` | `keyRow.owner_ref,` | `:330` | `:330` = `keyRow.owner_ref,` | ✅ |
| `src/services/discovery.ts:255` | `agent.ts:429-440` | **el INSERT de `publish()`**, no `listAsAgents` | `:469-480` | `:469-480` = el INSERT de `publish()` (mecánicamente bien, semánticamente mal **ya en `main`**) | ⚠️ ver `MNR-4` |

**La cita pre-existente confirmada**: `src/types/index.ts` afirma
*"`publish` la escribe `true` (`services/agent.ts:399`)"* y en `main` @ `8242b16` la línea
399 de ese archivo **está vacía** (`sed -n '399p'` sobre `git show 8242b16:src/services/agent.ts`
devuelve la línea en blanco entre `sanitizeCapabilities(...)` y el comentario `// Slug
server-side`). ✅ Confirmado, **no es de esta HU**, y el Dev hizo bien en reportarla sin
tocarla. Queda para quien corresponda.

---

## 7. Lo que la HU NO entrega — ¿sobrevive la justificación vencida del KYC?

**NO sobrevive. Cero apariciones.** Barrido sobre el diff **completo** (3250 líneas,
extraído con `/usr/bin/git` porque el `git` del hook lo trunca a 532) sobre
`src/ test/ doc/INTEGRATION.md README.md README.es.md`:

```
grep -in "kyc|remit-|WKH-314|desbloquea|bloquea el cobro"  →  0 coincidencias
```

Y sobre los **6 mensajes de commit**: `kyc` → 0. `WKH-314` aparece **una** vez, en el
commit de W0, y aparece **calificado exactamente como CD-A2 exige**:

> *"la calificacion de «desbloquea WKH-314» (lo que se bloquea es la wave de docs, no el
> mecanismo: `readPaymentSpec` tiene dos consumidores de produccion,
> `services/discovery.ts:1380` y `services/agent.ts:164`, y ninguno esta en el camino de
> `requirePayment`)"*

**Sin hallazgos.** CD-A2 respetado.

---

# Las 11 categorías

## 1. Security — **OK**

- **Ownership / IDOR**: cero cadenas `supabase.from(...)` nuevas en todo el diff (CD-5).
  El PATCH sigue saliendo por `OwnershipMismatchError` → 404 disclosure-safe, y el UPDATE
  sigue filtrado por `.eq('slug', slug).eq('owner_ref', ownerRef)` (`src/services/agent.ts:757-763`).
  `T-316-12` fija el 404 cross-owner **con su gemelo positivo** (`agents.ownership.test.ts:374-387`),
  sin el cual un `return 404` incondicional pasaría.
- **Orden auth-first**: el guard de `payment` corre en `src/routes/agents.ts:270` (POST) y
  `:485` (PATCH), **después** del `preHandler: requireA2AKey()` y del `if (!keyRow)`
  (`:193-196`). Ningún anónimo llega a `resolveOperatorAddress`, que es lo único del diff
  que puede cargar `@solana/web3.js` y el keypair del operador.
- **Secretos**: `resolveOperatorAddress` nunca devuelve ni loguea material privado —
  `privateKeyToAccount(pk).address` (pública) y `keypair.publicKey.toBase58()` (pública).
  El `catch` loguea `err.message`, y `operator-address.test.ts:99` assertea explícitamente
  que la clave basura **no aparece** en el log. `OPERATOR_PRIVATE_KEY` es la env correcta:
  es la misma que usan `adapters/base/payment.ts:198`, `adapters/avalanche/gasless.ts:225`
  y `adapters/deposit-verifier.ts` — o sea, sí es la address propia del gateway.
- **Disclosure de `initializedChains`**: verificado que **ya es público sin auth**.
  `src/routes/capabilities.ts:31` es un `fastify.get('/')` **sin `preHandler`** y `:44`
  publica `getInitializedChainKeys()` como `chains[].key`. Además `src/routes/gasless.ts:105`
  ya devuelve la lista joineada en un mensaje de error. La afirmación del Story File es cierta.
- **Injection**: no hay SQL crudo ni `EXECUTE format`. Todo va por el query-builder de
  Supabase con valores parametrizados.
- **Mass assignment**: el POST arma el `input` con whitelist explícita; el PATCH pasa el
  `body` crudo pero `update()` sólo lee keys conocidas y `updateRow` sólo recibe columnas
  conocidas. Prototype pollution vía body: Fastify usa `secure-json-parse` por default.
- **Oráculo de `PAYTO_IS_OPERATOR`**: sí, un caller autenticado puede *confirmar* una
  address del operador que ya conozca. No es finding: las addresses del operador son
  públicas on-chain por construcción y el oráculo es de igualdad (no permite búsqueda).

## 2. Error Handling — **OK**

- `resolveOperatorAddress` **nunca lanza**, y está probado con los dos negativos
  (env ausente, env basura) **más su gemelo positivo** (`operator-address.test.ts:104-110`),
  sin el cual un `return null` incondicional pasaría los dos negativos.
- El `catch` de la rama Solana **no es silencioso**: loguea `PAYTO_OPERATOR_CHECK_SKIPPED`
  + `err.message`, y `operator-address.test.ts:155` assertea que el mensaje de la aserción
  WKH-315 (`is not the solana operator pubkey`) llega entero al log del servidor. Esto era
  BLOQUEANTE por Story File si faltaba; está.
- Degradación explícita en dos puntos (paso 6 sin tokens, paso 7 sin operador), las dos
  logueadas y las dos con test.
- La defense-in-depth del service lanza `Error('Invalid payment')` genérico → el catch del
  route responde 400 con mensaje estático, sin leak de `err.message` al cliente
  (`src/routes/agents.ts:340-346` y `:508-516`). Camino inalcanzable en la práctica: el
  route ya devolvió 422, y **verifiqué que los dos validadores no pueden divergir** (misma
  función, mismo input, e idempotente: re-validar `result.block` da `result.block`).

## 3. Data Integrity — **OK con `MNR-3`**

- **CD-7 (no reescribir `metadata` desde cero)**: cumplido por construcción
  (`readMetadataObject(existing.metadata)` + merge encima, `src/services/agent.ts:734-747`).
  `T-316-13` lo fija con las 4 keys.
- **AC-8 (borrado)**: `delete meta.payment` (`:744`) + colapso R-7 a `metadata = null`
  (`:748-754`), con `T-316-15`/`T-316-16`.
- **AC-9 (byte-identidad)**: como `readMetadataObject` devuelve el objeto crudo, un bloque
  sembrado se re-escribe **verbatim** (sin normalizar ni reordenar) cuando el PATCH toca
  otro campo. Correcto.
- **Idempotencia**: PATCH repetido con el mismo bloque produce el mismo JSONB.
- Ver `MNR-3` por la ventana de lost-update.

## 4. Performance — **OK**

- `validatePaymentBlock` corre **dos veces por request** (route + service). Sin I/O: el
  único acceso externo (`resolveOperatorAddress`) está cacheado por proceso **y por
  familia, incluido el `null`** (`src/lib/operator-address.ts:49,109-113`), y hay test de
  cache para los dos casos (`operator-address.test.ts:112-130`).
- El `await import('../adapters/solana/chain.js')` (CD-13) corre **como máximo una vez por
  proceso** y sólo detrás de auth. Confirmado que el import estático no existe: los únicos
  imports top-level de `operator-address.ts` son `viem/accounts` y el logger (`:27-28`).
- Cero queries nuevas. El `prev` del log sale de la fila que `update()` ya había traído
  para el guard de dueño (`:694-696`), no de un SELECT extra.
- Cero N+1, cero loops sobre resultados.

## 5. Integration — **OK con `MNR-2`**

- **Aditivo**: `payment?` opcional en las dos rutas; `PublishedAgentRecord.payment?`
  opcional y **nunca `null`** (`src/services/agent.ts:195-196`).
- **`/discover` y `/capabilities` intactos**: `mapRowToAgent` no se tocó y
  `readPaymentSpec` sigue siendo el único productor de `Agent.payment` (CD-6 respetado —
  `discovery.ts`, `payment-spec-reader.ts`, `downstream-payment.ts` y `adapters/**` con
  **cero bytes** en el diff, verificado en `git diff --name-only`).
- **`PublishedAgentRecord` no se filtra a nadie**: sus 3 productores
  (`publish` `:498`, `listMine` `:607`, `update` `:791`) son todos owner-scoped.
- **`buildMetadata` cambió de firma** pero es `function` privada del módulo con **un solo
  call-site** (`:449`).
- El link del README (`INTEGRATION.md#declaring-where-your-agent-gets-paid-payment`)
  resuelve correctamente contra el heading `### Declaring where your agent gets paid (\`payment\`)`.
- **Las 6 citas de adapters de `doc/INTEGRATION.md` verificadas una por una** — todas
  exactas: `solana/payment.ts:82` = `USDC`, `avalanche/payment.ts:56` = `USDC`,
  `kite-ozone/payment.ts:253` = `X402_TOKEN_SYMBOL ?? …`, `:164` = `PYUSD`, `:165` = `USDC.e`,
  `tempo/payment.ts:61` = `AlphaUSD`.
- Ver `MNR-2` por el cambio de comportamiento en `POST` con `payment: null`.

## 6. Type Safety — **OK**

- `tsc --noEmit` exit 0 con `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
- Cero `any`. Cero `!` (non-null assertion) sobre `supportedTokens[0]`: se usa `?.` y la
  decisión DT-STORY-1 (`src/lib/payment-spec-writer.ts:248-256`).
- Los `as` que hay son de borde y están justificados: `raw as Record<string, unknown>`
  después de un `typeof`/`null`/`Array.isArray` (`:171`, `:316`) y `meta as unknown as Json`
  en el borde de la DB (patrón preexistente).
- `getChainVmFamily` (`ChainVmFamily`) e `isValidPayoutWallet` (`WalletNamespace`) casan sin
  cast, como pedía el Story File.
- `bundle.payment.supportedTokens` es seguro en runtime: `AdaptersBundle.payment` es
  `PaymentAdapter` **no opcional** (`src/adapters/types.ts:457`) y `supportedTokens` es un
  array no opcional (`:106`, `:339`).
- Sin `null` donde el contrato pide `undefined` (AC-11): `mapRowToRecord` asigna condicional.

## 7. Test Coverage — **OK**

Corrí **6 mutantes propios** sobre la suite **completa**, con backup a disco y restauración
verificada por `md5sum`:

| # | Mutación | Resultado | ¿Muere por la razón correcta? |
|---|---|---|---|
| A | `meta.payment = updates.payment` (M15) | **KILLED** (1) | Sí — diff de `Object.keys` |
| B | `prev` leído después del merge (M14) | **KILLED** (2) | Sí — `prev.contract === next.contract` |
| C | `sameAddress` EVM sin `toLowerCase` | **KILLED** (1) | Sí — `PAYTO_IS_OPERATOR` no dispara |
| D | `isZeroPayTo` EVM sin `toLowerCase` | **SOBREVIVE** | Esperado y **declarado** por el Dev |
| E | whitelist → `{ ...obj }` | **KILLED** (5 en 3 archivos) | Sí — keys de más |
| F | `readStoredPaymentBlock` sin whitelist | **KILLED** (2) | Sí |
| G | merge sin `updates.payment !== undefined` | **KILLED** (4) | Sí |

- Todo test negativo tiene gemelo positivo (CD-A4): lo verifiqué en `T-316-04`, `T-316-09`,
  `T-316-10`, `T-316-11`, `T-316-12`, `T-316-19`.
- Los asserts son sobre `error_code`, **no sobre el 422** — lo confirmé en los casos donde
  la muerte barata era posible (`T-316-08` zero-pubkey Solana, `T-316-09` prefijo `0X`).
- `T-316-08` incluye un **control de la premisa** (`payment-spec-writer.test.ts:318-322`):
  espía que `isValidPayoutWallet` fue llamado con `'1'.repeat(32)` y **no** fue quien
  rechazó. Eso es lo que impide la muerte falsa.
- El guardián estructural `test/payment-guards-live-in-one-place.test.ts` **no es
  decorativo**: cada aserción de ausencia tiene su control de vacuidad (mismo patrón
  exigido **presente** en el validador), más un control del instrumento (`:133-155`) que
  verifica que el stripper de comentarios ni se come el código ni deja de sacar
  comentarios. Corrí el escenario "borrar la HU": se pondría rojo.
- Los mocks **no mienten sobre lo que prueban**: los tres archivos de test llevan el mock
  del registry con `importOriginal` + spread, y el override sigue devolviendo `undefined`
  para chains conocidas, así que AC-3 puede ponerse rojo. Los docblocks declaran
  explícitamente lo que **no** prueban (`agents.publish.test.ts` — no prueba persistencia;
  `agents.ownership.test.ts` — no prueba aislamiento por filtro).

## 8. Scope Drift — **OK**

18 archivos, **todos justificados**:

| Archivo | ¿En Scope IN? |
|---|---|
| 12 archivos de la tabla "Files to Modify/Create" | ✅ |
| `test/ownership-filter-guard.exceptions.ts` | ✅ fila #13, alcance respetado (ver §3) |
| `test/payment-guards-live-in-one-place.test.ts` | ✅ W4.3 (`T-316-24` → `test/`) |
| `README.es.md` | ⚠️ fuera de Scope IN — **desviación declarada** en `auto-blindaje.md`, obligada por `test/readme-numbers.test.ts` que verifica los DOS README. Sólo 2 números + 1 fila de tabla. |
| `doc/sdd/214-…/{sdd,story-file,auto-blindaje}.md` | ✅ artefactos del pipeline |

- `doc/sdd/_INDEX.md` **NO** tocado (correcto: es F4/DONE).
- `package.json` **NO** tocado — cero dependencias nuevas.
- `src/services/agent.test.ts` **NO** creado (prohibido).
- Cero DDL, cero migración, cero backfill.
- El `story-file.md` de la HU 212 (otro agente) quedó **untracked** y sin tocar — verificado
  antes y después de todas mis mutaciones.

## 9. Destructive Migrations — **N/A**

Esta HU no contiene una sola sentencia DDL ni un archivo de migración. `git diff --name-only`
no lista nada bajo `supabase/`, `migrations/` ni `*.sql`. El bloque `payment` vive dentro de
la columna JSONB `a2a_agents.metadata`, que ya existía. Cero filas preexistentes se tocan
(AC-9 + CD-14), y lo fijan `T-316-17` (byte-identidad contra literal escrito a mano) y
`T-316-18` (un bloque sembrado con chain desconocida no se re-valida ni se reescribe).

## 10. RPC con `SECURITY DEFINER` — **N/A**

El diff no crea, modifica ni llama ninguna función Postgres. Cero `supabase.rpc(...)` nuevo
(verificado sobre el diff completo). Toda escritura pasa por el INSERT de `publish()` y el
UPDATE filtrado de `update()`, ambos vía el query-builder.

## 11. Cache Invalidation Logic — **OK**

Hay **un solo** cache nuevo: `src/lib/operator-address.ts:49`, un `Map<OperatorFamily, string|null>`
por proceso.

- **No es multi-tenant**: la clave es la familia de VM, y el valor es una propiedad **del
  gateway**, no del caller. No hay `user_id` que falte porque no hay dato por usuario. El
  riesgo tipo LUM-58 (usuario A ve datos de usuario B) **no aplica**.
- **No se invalida nunca, a propósito y declarado** (`:35-48`): la entrada deriva de una env
  que se fija al arranque del proceso. Un redeploy vacía el cache.
- **El `null` se cachea deliberadamente** para no re-intentar el `await import()` de
  `@solana/web3.js` en cada publicación. Consecuencia declarada: el log de
  `PAYTO_OPERATOR_CHECK_SKIPPED` sale una vez por proceso, no por request.
- **No hay reset exportado**, y el docblock dice por qué (sería superficie para vaciar el
  guard en caliente). Los tests usan `vi.resetModules()` + re-import.
- TTL: infinito, y es correcto para la semántica (dirección derivada de una env inmutable).
- Cero React Query / SWR / `revalidatePath` / Redis / CDN nuevos.

---

# Hallazgos

## `BLQ-BAJO-1` — Dos de las cuatro citas desplazadas reportadas apuntan a la función equivocada

- **Categoría**: Integration (contrato de handoff) · viola **CD-A1** y **CD-A2**
- **Archivo:línea**: `doc/sdd/214-wkh-316-escritor-payment-block/auto-blindaje.md`, tabla de
  la entrada `[2026-08-19 00:44] Wave 4`; y el cuerpo del commit `91b4dd6`, que repite el
  mismo compromiso (*"las otras 4 van al reporte con su valor nuevo ya medido"*).

- **Qué está mal**

  1. Fila `src/services/agent.ownership.test.ts:6` → declara que `services/agent.ts:549`
     *"ahora es"* **`:761`**.
     - En `main` @ `8242b16`, `:549` es `.eq('owner_ref', ownerRef)` **dentro de `listMine`**
       (el docblock que la cita dice literalmente *"`src/services/agent.ts:549` (`listMine`)"*).
     - En el árbol final, **`:761` es `.eq('owner_ref', ownerRef)` del UPDATE dentro de
       `update()`** — otra función, otro hueco, otro test.
     - El valor correcto es **`:602`**.

  2. Fila `src/services/orchestrate.ts:1160` → declara que `services/agent.ts:526`
     *"ahora es"* **`:599`**.
     - En `main`, `:526` es `const { data, error } = await supabase` **dentro de
       `getBySlugAsAgent`** (que es exactamente lo que el comentario de `orchestrate.ts`
       está contando: *"`publishedAgentService.getBySlugAsAgent` — SELECT sobre `a2a_agents`"*).
     - En el árbol final, **`:599` es la MISMA línea de texto pero dentro de `listMine`**.
     - El valor correcto es **`:579`**.

  La causa raíz es la que el propio Dev nombró para W0 y después no aplicó acá: **el
  desplazamiento no es un delta único**. `update()` creció ~54 líneas en el medio, así que
  todo lo que está debajo se corre `+107`, mientras que lo que está entre `publish()` y
  `update()` se corre `+53`. Aplicar un delta uniforme produce un número que **existe** y
  que hasta contiene el **mismo texto** (`.eq('owner_ref', ownerRef)`, `const { data, error }
  = await supabase` aparecen media docena de veces cada uno en el archivo) — o sea, un
  número que **pasa cualquier verificación superficial y apunta al lugar equivocado**.

- **Reproducción**

  ```bash
  cd /home/ferdev/.openclaw/workspace/wasiai-a2a
  git show 8242b16:src/services/agent.ts > /tmp/agent.main.ts
  sed -n '545,549p' /tmp/agent.main.ts   # → async listMine(...) … .eq('owner_ref', ownerRef)
  sed -n '525,526p' /tmp/agent.main.ts   # → async getBySlugAsAgent(...) … await supabase

  awk 'NR>=757 && NR<=761 {print NR": "$0}' src/services/agent.ts
  #   757:  const { data, error } = await supabase
  #   758:    .from('a2a_agents')
  #   759:    .update(updateRow)          ← ES EL UPDATE, no listMine
  #   761:    .eq('owner_ref', ownerRef)

  awk 'NR>=598 && NR<=602 {print NR": "$0}' src/services/agent.ts
  #   598:  async listMine(ownerRef: string)   ← el correcto
  #   602:    .eq('owner_ref', ownerRef)

  awk 'NR>=578 && NR<=579 {print NR": "$0}' src/services/agent.ts
  #   578:  async getBySlugAsAgent(slug: string)
  #   579:    const { data, error } = await supabase   ← el correcto

  awk 'NR>=598 && NR<=599 {print NR": "$0}' src/services/agent.ts
  #   599:    const { data, error } = await supabase   ← lo que el Dev reportó: es listMine
  ```

  Esperado: `:761` → la línea de `listMine`. Real: la línea del UPDATE de `update()`.
  Esperado: `:599` → la línea de `getBySlugAsAgent`. Real: la línea de `listMine`.

- **Impacto**
  Estas dos citas son el **entregable** del barrido CD-A1: el Dev decidió, correctamente, no
  arreglarlas (están fuera de Scope IN, y una vive en un archivo que CD-6 prohíbe tocar) y
  en cambio **publicar el valor medido** para que otro las aplique. Quien las aplique va a
  escribir en `src/services/agent.ownership.test.ts:6` — el docblock cuyo único trabajo es
  nombrar **cuál** línea del filtro de dueño cubre ese archivo — una cita que apunta al
  filtro de **otra** función. Es exactamente el patrón que el repo ya tiene documentado como
  lección (*"las citas que rompés vos al arreglar otra cosa"*): una cita que apunta mal pero
  **muestra lo que el verificador esperaba ver** (la misma cadena `.eq('owner_ref', …)`), o
  sea que se auto-confirma y envejece en silencio. Cero impacto en runtime: es un defecto de
  un artefacto documental, y por eso es BAJO y no MEDIO.

- **Sugerencia**
  Re-medir los dos anclas **por contenido, no por delta**: extraer la línea exacta de
  `8242b16` y localizarla en HEAD por su función contenedora (`awk` desde la firma de la
  función hacia abajo), no sumando un desplazamiento. Corregir las dos celdas de la tabla de
  `auto-blindaje.md` a `:602` y `:579`. Recomendado además: agregar a esa entrada la regla
  operativa de que **un archivo con inserciones en el medio tiene más de un delta**, que es
  la lección que faltó. No hace falta tocar `src/`.

---

## `MNR-1` — El route escribe al log el objeto `payment` CRUDO del caller, sin cota

- **Categoría**: Security / Performance
- **Archivo:línea**: `src/routes/agents.ts:277` (POST) y `src/routes/agents.ts:492` (PATCH)

  ```ts
  request.log.warn(
    { field: result.rejection.field, code: result.rejection.code, value: body.payment },
    'agent publish rejected: invalid payment',
  );
  ```

- **Descripción**: `body.payment` es JSON arbitrario elegido por el caller, y se escribe
  entero en la línea de log de cada 422. **Ningún otro guard de este archivo lo hace**: el
  de `priceUsdc` (`:220`), el de `payoutWallet` (`:237`), el de `referrerRef` (`:252`), el
  de `enabled` (`:455-457`) y el de `capabilities` (`:467`) loguean todos **sólo el `field`**. Y el repo ya tiene
  esta clase de problema con nombre propio: `src/lib/discovery-query.ts:215-235` documenta
  que *"`src/index.ts` construye Fastify sin `bodyLimit` y el default son 1 MiB"*, y deja la
  deuda **TD-322-4** por una línea de log que crece con el input del atacante.

- **Reproducción**: `POST /agents` autenticado con
  `{"name":"x","agentUrl":"https://…","capabilities":["a"],"payment":{"method":"nope","chain":"<800 KB de texto>"}}`
  → 422 (esperado y correcto), y una línea de log de ~800 KB por request rechazado.
  Con `{ field, code }` la línea sería de longitud constante.

- **Impacto**: amplificación de volumen de logs (~1x hacia el sistema de logging), acotada
  por el rate-limiter global (`src/index.ts:288`) y por el 1 MiB de Fastify, y requiere una
  a2a-key válida. Riesgo de secreto: bajo — pino redacta `*.privateKey`, `*.secret`,
  `*.signature` a esa profundidad. Por eso es MENOR y no bloqueante.

- **Sugerencia**: alinear con los guards hermanos del mismo archivo (sólo `{ field, code }`),
  o si el valor se considera necesario para diagnóstico, acotarlo igual que
  `MAX_ECHOED_PARAM_NAME_LENGTH` ya acota el nombre de parámetro en `discovery-query.ts`.
  Nota: el Story File es ambiguo acá — su prosa dice *"el valor va a `request.log.warn`"*
  pero su snippet normativo muestra sólo `{ field, code }`. La decisión del Dev es defendible;
  lo que no está resuelto es la cota.

---

## `MNR-2` — `POST /agents` con `payment: null` pasa de 201 a 422 (cambio de comportamiento en una API pública)

- **Categoría**: Integration (backwards compatibility)
- **Archivo:línea**: `src/routes/agents.ts:270-271` + `src/lib/payment-spec-writer.ts:168-170`
- **Descripción**: antes de esta HU, `payment` era una key desconocida del body del POST y se
  ignoraba en silencio (mismo criterio que el `slug`, `src/routes/agents.ts:288-290`).
  Ahora `body.payment !== undefined` entra al validador y `payment: null` cae en
  `INVALID_PAYMENT_BLOCK` → **422**. Lo mismo pasa con `payment: {}`, `payment: "x"`,
  `payment: []`.
- **Reproducción**: `POST /agents {"name":"A","agentUrl":"https://a.example","capabilities":["x"],"payment":null}`.
  En `8242b16` → **201**. En la rama → **422 `INVALID_PAYMENT_BLOCK`**.
- **Impacto**: rompe a un cliente que serialice el campo como nullable (el patrón habitual de
  un ORM/DTO que emite `null` para "sin valor"). En la práctica bajo: el campo no existía, no
  hay caller documentado, y `PublishedAgentRecord` **nunca** emite `payment: null` (sólo
  presente o ausente), así que un round-trip response→request no lo produce.
- **Nota de calibración**: **es deliberado y está bien documentado** — el comentario del route
  (`:263-268`) y `doc/INTEGRATION.md` ("Deleting the block") explican el porqué, y el
  razonamiento es correcto (en un alta no hay nada que borrar). Lo reporto porque **ningún AC
  lo cubre** (AC-11 sólo habla de omitir la key entera) y porque no figura en la lista de
  desviaciones declaradas del `auto-blindaje.md`. No bloquea.
- **Sugerencia**: dejarlo como está y **declararlo** — una línea en `auto-blindaje.md` o un
  AC-13 en el cierre. Alternativa (no recomendada): tratar `payment: null` en el POST como
  "sin bloque", que colapsaría dos estados que la HU separó a propósito.

---

## `MNR-3` — Lost update: el merge de `metadata` es read-modify-write sin control de concurrencia

- **Categoría**: Data Integrity
- **Archivo:línea**: `src/services/agent.ts:624` (`const existing = await this.getRow(slug)`)
  → `:734-754` (merge) → `:757-763` (UPDATE)
- **Descripción**: `update()` lee la fila, mergea en memoria y escribe el objeto `metadata`
  **completo**, sin `updated_at` esperado, sin versión, sin `UPDATE … WHERE metadata = <lo
  que leí>`. Dos PATCH concurrentes del **mismo dueño** sobre el **mismo agente** se pisan a
  nivel de objeto `metadata`, no de campo.
- **Reproducción** (interleaving concreto):
  1. `PATCH /agents/mi-agente {"payment": {…}}` lee `existing.metadata = {inputSchema}`.
  2. `PATCH /agents/mi-agente {"discoverable": true}` lee `existing.metadata = {inputSchema}`.
  3. (1) escribe `{inputSchema, payment}`.
  4. (2) escribe `{inputSchema, discoverable}` → **el bloque `payment` desaparece**, con 200
     en las dos respuestas y sin ninguna señal en el log de auditoría (el log de (1) reporta
     correctamente el cambio que sí se hizo, y (2) no loguea porque `updates.payment` es
     `undefined`).
- **Impacto**: el agente queda sin declaración de cobro y vuelve al riel default del gateway
  —que es lo que `doc/INTEGRATION.md` dice que pasa sin bloque— sin que nadie se entere.
  Requiere concurrencia del mismo dueño sobre el mismo slug, que es poco frecuente.
- **Nota de calibración**: el patrón es **preexistente** (los tres campos
  `inputSchema`/`outputSchema`/`discoverable` ya se mergeaban así antes de esta HU), y el
  Story File no pide resolverlo. Lo reporto porque esta HU es la que mete un dato
  **money-relevante** (la billetera de cobro) dentro de esa ventana, no porque el Dev haya
  introducido el patrón. Por eso es MENOR y no bloqueante.
- **Sugerencia**: candidato a deuda con nombre (p. ej. `TD-316-METADATA-LWW`). El arreglo
  natural es un `jsonb_set` server-side sobre la key `payment` en vez de reescribir el
  objeto, o un `.eq('updated_at', existing.updated_at)` en el UPDATE (que ya está filtrado
  por `slug` + `owner_ref`, así que agregar una condición no toca la ownership).

---

## `MNR-4` — La cita `services/agent.ts:429-440` de `discovery.ts:255` ya era falsa en `main`, y el reporte propaga la versión desplazada de la cita falsa

- **Categoría**: Integration (documentación de código vivo)
- **Archivo:línea**: `src/services/discovery.ts:254-256`
- **Descripción**: el comentario afirma
  *"`listAsAgents()` es un SELECT sin `limit` ni cursor (`services/agent.ts:429-440`)"*.
  Medido: en `main` @ `8242b16`, `agent.ts:429-440` es el **INSERT de `publish()`**
  (`.from('a2a_agents').insert(row).select().single()`), **no** el SELECT de `listAsAgents`.
  La cita ya estaba rota antes de esta HU. El `auto-blindaje.md` reporta el valor nuevo
  `:469-480`, que es mecánicamente correcto (el mismo ancla, desplazado `+40`) pero **sigue
  siendo el INSERT de `publish()`**. La línea que sostiene la afirmación es, en el árbol
  final, **`src/services/agent.ts:506-510`**.
- **Reproducción**:
  ```bash
  git show 8242b16:src/services/agent.ts | sed -n '429,440p'   # → el INSERT de publish()
  awk 'NR>=469 && NR<=480 {print NR": "$0}' src/services/agent.ts  # → el INSERT de publish()
  awk 'NR>=505 && NR<=510 {print NR": "$0}' src/services/agent.ts  # → listAsAgents(), el SELECT real
  ```
- **Impacto**: quien vaya a arreglar la cita desplazada va a escribir `:469-480` y a dejar el
  comentario tan falso como está, con la apariencia de haberlo verificado. No afecta runtime.
- **Nota de calibración**: el defecto de origen **no es de esta HU** (es preexistente, igual
  que el `types/index.ts:399` que el Dev sí identificó como tal). Lo que sí es de esta HU es
  publicar un "valor nuevo ya medido" sin notar que el ancla no dice lo que la prosa afirma.
  Por eso MENOR y no parte del BLOQUEANTE.
- **Sugerencia**: en la tabla de citas de `auto-blindaje.md`, marcar esta fila como
  **cita preexistentemente falsa**, con el ancla correcto (`:506-510`) al lado, para que
  quien la arregle corrija la semántica y no sólo el número. `discovery.ts` sigue sin poder
  tocarse en esta HU (CD-6) — es sólo un cambio en el reporte.

---

# Instrumentos que fallaron o que hubo que verificar

Declarado, porque afecta la confianza en lo que reporto.

1. 🔴 **`git diff` bajo el hook de `rtk` TRUNCA el diff** — el diff completo del Scope IN es
   de **3250 líneas**; el que devolvió `git diff` bajo el hook fue de **532**, con marcas
   `... (truncated)` en el medio de los hunks. Un barrido de "¿sobrevive tal frase?" hecho
   sobre esa salida habría dado un **cero falso**. Todo el trabajo de barrido lo hice con
   `/usr/bin/git` invocado por ruta absoluta. Es una variante nueva del hallazgo ya conocido
   de `git log --oneline` (que borra los merges).
2. 🔴 **`grep` bajo el hook devuelve conteos y fragmentos en vez de `archivo:línea`** — un
   primer intento de listar los tests de operador devolvió `📄 273 (1): 0: si alguien mete un
   toLowerCase()...`, inutilizable para citar. Usé `/usr/bin/grep` por ruta absoluta y `awk`
   con `printf "%d: %s\n", NR, $0` cuando necesitaba números de línea exactos.
3. **`rg --type ts` no existe acá** (`unrecognized option '--type'`): el `rg` del PATH es
   `grep`. Usé `/usr/bin/grep -rn --include=*.ts`.
4. **Restauración de mutantes medida, nunca declarada**: harness propio en el scratchpad con
   backup a disco, `assert` de una sola ocurrencia del sitio, y `md5sum` antes/después. Los
   4 archivos de `src/` volvieron a sus hashes exactos
   (`0c19614e…`, `764b1f32…`, `9d90b4d6…`, `69ff9af6…`) y la suite volvió a
   `289 passed | 6 skipped · 5746 passed | 19 skipped`. `git status --porcelain` final: sólo
   el `story-file.md` untracked **del otro agente**, intacto.
5. **Los tres comandos de puerta corridos sin pipe a archivo**, con la salida leída directa
   (sólo `| tail` para recortar, nunca `> archivo`).

# Límites de este AR — lo que NO verifiqué

- **No consulté la base de producción ni Railway.** Todo lo que dice "medido" acá es medido
  **contra el árbol**. En particular no verifiqué NC-1 (si
  `64KKjZFSMZRucKPqTpGydrUFeFdLHDhbHTJVGmEaXS6z` es la pubkey del operador Solana): sigue
  abierto, y el Dev hizo lo correcto al **no** usarla como fixture de "payTo válido".
- **No corrí el camino real contra el registry inicializado.** Toda la suite mockea
  `getAdaptersBundle`. Que el conjunto de chains que `normalizeChainSlug` conoce y el que el
  registry inicializa se solapen como el integrador espera **no está probado por ningún test
  de este repo**, ni antes ni después de esta HU. No es un finding de la HU; es el borde
  donde termina lo que la suite puede decir.
- **No medí cobertura** (`npm run test:coverage`): el Story File no lo pide y el número
  publicado en los README (2026-08-15) no fue re-afirmado por este diff.
- **El guardián de ownership verifica PRESENCIA, no VALOR** — y esta HU no agrega ni una
  cadena nueva, así que su verde acá no aporta información nueva. El aislamiento real sigue
  viviendo en `src/services/agent.ownership.test.ts`, que esta HU no tocó.

---

# Orden sugerido del fix-pack

1. **`BLQ-BAJO-1`** — corregir `:761` → `:602` y `:599` → `:579` en la tabla de citas de
   `doc/sdd/214-wkh-316-escritor-payment-block/auto-blindaje.md`, re-midiendo por contenido.
   **No toca `src/`.** Es lo único que bloquea el gate.
2. `MNR-4` (mismo archivo, misma tabla — conviene hacerlo en la misma pasada).
3. `MNR-2` (una línea de desviación declarada).
4. `MNR-1` (una decisión de logging en 2 líneas de `src/routes/agents.ts`).
5. `MNR-3` (candidato a deuda con nombre, no a fix en esta HU).

*Reporte generado por NexusAgil — AR · nexus-adversary · WKH-316*
