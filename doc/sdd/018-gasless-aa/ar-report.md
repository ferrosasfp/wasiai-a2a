# Adversarial Review — WKH-29 Gasless EIP-3009 (post-F3)

| Campo | Valor |
|-------|-------|
| HU | WKH-29 |
| Branch | `feat/018-gasless-aa` |
| Fase | F3 → AR |
| Reviewer | Adversary |
| Fecha | 2026-04-06 |

Archivos atacados:
- `src/lib/gasless-signer.ts` (NUEVO, 288 L)
- `src/lib/gasless-signer.test.ts` (NUEVO, 233 L)
- `src/routes/gasless.ts` (NUEVO, 21 L)
- `src/index.ts` (modificado L20, L59-62)
- `src/types/index.ts` (modificado L405-441)
- `.env.example` (modificado L38-44)

---

## 1. Seguridad / Secrets (CD-1)

### H-1 — `routes/gasless.ts:15` re-emite `err.message` al cliente
- **Severidad**: MENOR
- **Evidencia**: `src/routes/gasless.ts:13-17`
  ```ts
  return reply.status(500).send({
    error: err instanceof Error ? err.message : 'gasless status failed',
  })
  ```
- **Ataque**: `getGaslessStatus()` jamás `throw`-ea (atrapa todo internamente), por lo que el catch es código muerto. Si en el futuro alguien refactoriza y `getGaslessStatus` propaga (p. ej. metiendo `submitGaslessTransfer`), el `err.message` puede contener `OPERATOR_PRIVATE_KEY is required for gasless signer` o un fragmento de stack con env vars. Hoy no filtra, mañana sí.
- **Fix sugerido**: cambiar a un mensaje constante (`'gasless status failed'`) y log interno con `fastify.log.error`.

### H-2 — `sanitizeError()` solo recorta a 120 chars
- **Severidad**: MENOR
- **Evidencia**: `src/lib/gasless-signer.ts:94-99`
- **Ataque**: si `fetch` rechaza con un `TypeError` de undici cuyo `message` empieza con "fetch failed" + URL completa, los primeros 120 chars de cualquier `Error.message` futuro pueden incluir información sensible (URL con query params, headers en builds custom). No expone nada hoy, pero `substring(0,120)` no es sanitización real, es truncado.
- **Fix sugerido**: whitelist (`statusCode`, `errorClass`) en vez de pasar `message` raw.

### H-3 — `getGaslessStatus()` ejecuta side effects aun con flag OFF
- **Severidad**: MENOR
- **Evidencia**: `src/lib/gasless-signer.ts:252-278`
- **Ataque**: La función ignora `enabled` y siempre llama `privateKeyToAccount(pk)` (si la PK existe) **y siempre dispara `getSupportedToken()` (HTTP fetch al relayer)**. Aun con `GASLESS_ENABLED=false`, si por algún motivo la ruta queda registrada o alguien importa `getGaslessStatus` desde otro módulo, el server hace tráfico saliente al relayer y carga PK en memoria. No es un leak directo, pero contradice el espíritu de DT-3/CD-4 ("opt-in, no rompe nada").
- **Fix sugerido**: `if (!enabled) return { enabled:false, network:'kite-testnet', supportedToken:null, operatorAddress:null }` antes de los side effects.

---

## 2. EIP-712 / EIP-3009 correctness

### H-4 ⛔ BLOQUEANTE — `hexToSignature(...).v` puede ser `undefined`
- **Severidad**: **BLOQUEANTE**
- **Evidencia**: `src/lib/gasless-signer.ts:200, 210`
  ```ts
  const { v, r, s } = hexToSignature(signature)
  ...
  v: Number(v),
  ```
- **Ataque**: en viem ≥2.x, el shape devuelto por `hexToSignature` (alias de `parseSignature`) es `{ r, s, yParity, v? }` donde **`v` es opcional** (legacy). Para firmas EIP-712 viem-nativas (`signTypedData`), viem **no** rellena `v` automáticamente; el campo puede venir `undefined`. `Number(undefined) === NaN`. El payload enviado al relayer tendría `"v": NaN` → `JSON.stringify` lo serializa como `null` → el smart contract de PYUSD haría `ecrecover` con `v=0` y devolvería signer ≠ from → **transferencia rechazada on-chain**. No hay manera de que el happy path funcione tal cual.
- **Reproducción**:
  ```ts
  const sig = await client.signTypedData({...})
  const parts = hexToSignature(sig)
  // parts.v puede ser undefined; parts.yParity es 0|1
  ```
- **Fix sugerido** (no implementar): derivar `v` de `yParity`:
  ```ts
  const parsed = hexToSignature(signature) // o parseSignature
  const v = parsed.v !== undefined ? Number(parsed.v) : (Number(parsed.yParity) + 27)
  ```
  Y ajustar test 6 para verificar `v === 27 || v === 28`.

### H-5 ⛔ BLOQUEANTE — `hexToSignature` puede no existir en viem instalado
- **Severidad**: **BLOQUEANTE** (a confirmar)
- **Evidencia**: `src/lib/gasless-signer.ts:10` `import { ..., hexToSignature } from 'viem'`
- **Ataque**: viem 2.x consolidó `hexToSignature` en `parseSignature` (changelog viem 2.18+). En el SDD §2.46 el Architect dice "verificado en runtime", pero según la versión exacta de viem (`^2.47.6`), `hexToSignature` puede ser un re-export deprecado o estar removido. Si `npm i` resolvió a 2.47.6 (la última 2.x compatible) entonces existe; si a 2.21+ podría faltar. **No hay evidencia en la implementación de un fallback.** Si `npm install` futuro bumpa la versión, el módulo crashea al cargarse (import error).
- **Fix sugerido**: usar `parseSignature` (canónico viem 2.x) o agregar compat: `import { parseSignature as hexToSignature } from 'viem'`. Ejecutar `node -e "console.log(typeof require('viem').hexToSignature, typeof require('viem').parseSignature)"` y consignar evidencia.

### H-6 — Falta `EIP712Domain` en `types`
- **Severidad**: OK (informativo)
- **Evidencia**: `src/lib/gasless-signer.ts:39-48`
- **Ataque**: viem `signTypedData` infiere `EIP712Domain` automáticamente desde `domain`, así que no es bug. Mencionar para descartar falsos positivos en CR.

### H-7 — `from` derivado del signer (correcto)
- **Severidad**: OK
- **Evidencia**: `src/lib/gasless-signer.ts:191, 203` (`account.address`)
- Comentario: el `from` firmado coincide con el `from` enviado al relayer. Bien.

---

## 3. Temporal / EIP-3009 constraints

### H-8 — `validBefore` puede ya estar vencido al llegar al relayer
- **Severidad**: MENOR
- **Evidencia**: `src/lib/gasless-signer.ts:178` `validBefore = validAfter + 25n` y AC-3
- **Ataque**: `validAfter = blockTs - 1` y `validBefore = blockTs + 24`. Si entre `getBlock` y la inclusión on-chain del relayer pasan más de 24 segundos (un solo bloque lento + cola del relayer), el contrato rechaza con `authorization expired`. El work-item dice "30s" como límite del relayer; el código aprovecha solo 25, dejando 24 efectivos. Si el `getBlock` devuelve un `timestamp` rezagado (es habitual en RPCs públicos que responden con un bloque viejo en cache), el margen real puede ser ~10s. No hay reintentos.
- **Fix sugerido**: usar `Math.floor(Date.now()/1000)` o `Number(blockTs)` y agregar 28s; o mover a `validBefore = validAfter + 30n` aceptando el riesgo del límite y dejar comentario.

### H-9 — `getBlock` puede fallar y propaga al caller
- **Severidad**: MENOR
- **Evidencia**: `src/lib/gasless-signer.ts:175`
- **Ataque**: `requireKiteClient().getBlock(...)` puede lanzar (`KITE_RPC_URL` mal, RPC down). El `signTransferWithAuthorization` no atrapa nada y propaga. AC-6 dice "no crash, isolated"; el server no crashea (porque ninguna ruta llama a `signTransferWithAuthorization` aún), pero si en el futuro se monta una ruta `POST /gasless/transfer` sin try/catch, sí. Hoy es OK porque la función no tiene caller en producción.
- **Fix sugerido**: documentar en JSDoc que el caller debe envolver en try/catch, o agregar try/catch interno con error sanitizado.

### H-10 — `Number(blockTs)` no se hace, pero `blockTs` puede ser `undefined`
- **Severidad**: MENOR
- **Evidencia**: `src/lib/gasless-signer.ts:176` `const blockTs = block.timestamp`
- **Ataque**: `getBlock({blockTag:'latest'})` en viem retorna `Block` con `timestamp: bigint` (no `null` cuando es 'latest'). Tipos OK. Pero si por mock o bug viene `undefined`, `undefined - 1n` lanza `TypeError`. El test mockea con `1700000000n`, así que el path real no se valida. Dependencia frágil del shape de viem.

---

## 4. Error handling / Robustez

### H-11 — Sin timeout en `fetch` (tanto discovery como submit)
- **Severidad**: MENOR
- **Evidencia**: `src/lib/gasless-signer.ts:147, 225`
- **Ataque**: `fetch(GASLESS_TOKENS_URL)` sin `AbortSignal.timeout(...)`. Si el relayer cuelga la conexión, `getGaslessStatus()` (llamado por `GET /gasless/status`) bloquea el handler indefinidamente (Fastify default no tiene request timeout). Una ruta con flag ON puede ser DoSeada por el relayer.
- **Fix sugerido**: `fetch(url, { signal: AbortSignal.timeout(5000) })`.

### H-12 — Sin retry pese a missing-input del work-item
- **Severidad**: MENOR
- **Evidencia**: work-item.md L144 dice "Retry basico: 1 retry con 2s delay" como mitigación; `gasless-signer.ts:225-238` no tiene retry.
- **Ataque**: la mitigación documentada no se implementó. Drift respecto al work-item (no respecto al SDD, que omite retry).
- **Fix sugerido**: agregar 1 retry con backoff o eliminar la mención del work-item para alinear.

### H-13 — `submitGaslessTransfer` no chequea `Content-Type` de la respuesta
- **Severidad**: OK (defensivo cubre)
- **Evidencia**: `src/lib/gasless-signer.ts:240` valida `txHash` shape. Suficiente.

---

## 5. Feature flag / Scope leakage (CD-4)

### H-14 — Import de `gaslessRoutes` en `src/index.ts:20` es incondicional
- **Severidad**: OK
- **Evidencia**: `src/index.ts:20`
- **Ataque**: aunque el import siempre se ejecuta, `gasless-signer.ts` no tiene side effects en el top-level (solo declara constantes y singletons en `null`). El `getWalletClient()` lazy nunca corre si nadie lo invoca. Verificado: con `GASLESS_ENABLED=false`, no se carga PK ni se hace fetch.

### H-15 — Si `GASLESS_ENABLED=true` y falta `OPERATOR_PRIVATE_KEY`, `getGaslessStatus` aún responde
- **Severidad**: OK (intencional por DT)
- **Evidencia**: `src/lib/gasless-signer.ts:256-263`
- Comentario: si la PK falta, `operatorAddress=null`. La ruta `/gasless/status` responde 200 con `enabled:true, operatorAddress:null`. Razonable.

---

## 6. Tipos / TS strict (CD-3)

### H-16 — `_walletClient: ReturnType<typeof createWalletClient> | null` pierde el genérico
- **Severidad**: MENOR
- **Evidencia**: `src/lib/gasless-signer.ts:52`
- **Ataque**: sin parámetros de tipo, `account` se infiere como `Account | undefined`, obligando a `client.account!` (L181) — non-null assertion. Es `as`-equivalente y evade TS strict de manera sutil. Mismo patrón que `x402-signer.ts`, así que es drift consistente, no nuevo.

### H-17 — `entry as RawTokenEntry` en `parseTestnetToken`
- **Severidad**: OK
- **Evidencia**: `src/lib/gasless-signer.ts:114`
- Comentario: cast "narrow" defensivo seguido de validación campo a campo. Aceptable.

### H-18 — `as 0x${string}` en `entry.address`
- **Severidad**: MENOR
- **Evidencia**: `src/lib/gasless-signer.ts:128`
- **Ataque**: si el relayer devuelve un address inválido (sin checksum, sin `0x`, longitud distinta), el cast oculta el error y la firma lo procesa con un address malformado → `signTypedData` lanza pero el mensaje no será el esperado. No hay validación regex `^0x[0-9a-fA-F]{40}$`.
- **Fix sugerido**: validar con `isAddress(entry.address)` de viem antes del cast.

---

## 7. Tests / Cobertura real

### H-19 ⛔ BLOQUEANTE — Test "decompose v/r/s" no detecta `v=NaN`
- **Severidad**: **BLOQUEANTE** (relacionado a H-4)
- **Evidencia**: `src/lib/gasless-signer.test.ts:127-140`
  ```ts
  expect(typeof r.v).toBe('number')
  ```
- **Ataque**: `typeof NaN === 'number'` devuelve `true`. Si `hexToSignature(...).v` es `undefined` (ver H-4), `Number(undefined) = NaN`, el test pasa felizmente. El test es de humo: no verifica que `v ∈ {27, 28}` ni que sea finito. Ergo: el bug crítico H-4 está enmascarado por un test que no afirma nada útil.
- **Fix sugerido**: agregar `expect([27,28]).toContain(r.v)` y `expect(Number.isFinite(r.v)).toBe(true)`.

### H-20 — Tests no cubren AC-1 end-to-end (sign + submit)
- **Severidad**: MENOR
- **Evidencia**: `src/lib/gasless-signer.test.ts` — sign y submit están en tests separados; el `submitGaslessTransfer` test usa un payload sintético con `from: 0x...0001` (no del signer real). Nunca se valida que el output de `signTransferWithAuthorization` sirva como input de `submitGaslessTransfer`.
- **Fix sugerido**: agregar test de integración (sin red): mockear fetch del POST y pasar el resultado real de sign.

### H-21 — No hay test para `getBlock` que falla
- **Severidad**: MENOR
- **Evidencia**: `src/lib/gasless-signer.test.ts` — `mockGetBlock` siempre resuelve. Caso `mockRejectedValue` no existe.
- **Ataque**: el path "RPC down → sign falla" no se valida.

### H-22 — `getGaslessStatus` test no verifica `enabled:true` con flag ON
- **Severidad**: OK
- **Evidencia**: `src/lib/gasless-signer.test.ts:220-232` — solo verifica que `operatorAddress` existe y que la PK no aparece serializada. Dado que `process.env.GASLESS_ENABLED` no se setea en el test, `enabled` es `false`. Aceptable pero el AC-7 happy path (enabled+supportedToken) no se afirma explícitamente.

### H-23 — Ningún test verifica AC-5 (registro condicional de rutas)
- **Severidad**: MENOR
- **Evidencia**: no hay test de `src/index.ts`. AC-5 ("WHEN GASLESS_ENABLED=true THE SYSTEM SHALL register /gasless/*") solo se valida manualmente.
- **Fix sugerido**: smoke test mínimo con Fastify inject.

---

## 8. Drift vs work-item / SDD / story-file

### H-24 — Snake_case vs camelCase del POST sigue sin verificar
- **Severidad**: MENOR (riesgo alto en runtime)
- **Evidencia**: story-file.md L156-174 ASUNCIÓN A-2; `src/lib/gasless-signer.ts:228` envía `JSON.stringify(payload)` con keys camelCase (`tokenAddress`, `validAfter`).
- **Ataque**: `/supported_tokens` devuelve **snake_case** (`eip712_name`, `minimum_transfer_amount`, `valid_after`), pero el POST se asume camelCase sin evidencia. No hay anotación en el código, ni TODO, ni `// TODO A-2`. El Dev se saltó el smoke test del POST. La probabilidad de un 400 inmediato del relayer es alta.
- **Fix sugerido**: smoke test manual con `curl`, agregar comentario `// VERIFIED 2026-04-06: relayer accepts camelCase` o convertir keys a snake_case.

### H-25 — Archivos prohibidos NO modificados
- **Severidad**: OK
- **Evidencia**: grep `ethers` en `src/` → 0 matches. `src/middleware/x402.ts` y `src/lib/x402-signer.ts` intactos. `src/lib/kite-chain.ts` intacto.
- Buen comportamiento del Dev.

### H-26 — `network` en `GaslessSupportedToken` vs en `GaslessStatus` son strings distintos
- **Severidad**: OK (cosmético)
- **Evidencia**: `src/types/index.ts:410` (`'testnet'`) vs L438 (`'kite-testnet'`)
- Ataque: el consumidor de `/gasless/status` ve dos `network` distintos (`status.network='kite-testnet'`, `status.supportedToken.network='testnet'`). Confuso pero no incorrecto.

### H-27 — `KITE_NETWORK`/`KITE_FACILITATOR_ADDRESS` no se reusan
- **Severidad**: OK
- Comentario: gasless es path independiente (CD-5). Bien.

---

## Verificaciones extras

| Check | Resultado |
|-------|-----------|
| `import 'ethers'` en `src/` | 0 matches — OK |
| `console.log` en `gasless-signer.ts` | 0 — OK |
| `fastify.log.info/error` con secretos en `routes/gasless.ts` | Solo `err.message` (ver H-1) — MENOR |
| `throw new Error` con secretos | Mensajes genéricos (`OPERATOR_PRIVATE_KEY is required` no incluye valor) — OK |
| Lazy singleton sin race | Single-threaded Node, OK |
| `OPERATOR_PRIVATE_KEY` ausente con flag ON | `getWalletClient()` lanza (L62), `getGaslessStatus` devuelve `operatorAddress:null` — OK |
| Min transfer validación antes de firmar | L173 antes de L185 — OK |
| Comparación `bigint` | `value < BigInt(token.minimumTransferAmount)` — OK |

---

## Resumen de hallazgos

| Severidad | Cantidad | IDs |
|-----------|----------|-----|
| **BLOQUEANTE** | **3** | H-4, H-5, H-19 |
| MENOR | 14 | H-1, H-2, H-3, H-8, H-9, H-10, H-11, H-12, H-16, H-18, H-20, H-21, H-23, H-24 |
| OK | 10 | H-6, H-7, H-13, H-14, H-15, H-17, H-22, H-25, H-26, H-27 |

---

## Veredicto final

# **BLOQUEANTE** → vuelve a F3

Justificación: H-4 + H-19 son una pareja letal. El happy path NO funciona (v=NaN en el payload final → relayer rechaza o on-chain ecrecover devuelve signer incorrecto), y el test que debería detectarlo afirma `typeof === 'number'` (que pasa con NaN). Sumado a H-5 (riesgo de import error si `hexToSignature` no existe en la versión instalada), AC-1, AC-2 y AC-7 no están cubiertos por evidencia real.

---

## Fixes para F3 (operativo)

### Fix-1 (H-4 + H-19) — corregir extracción de `v`
- **Archivo**: `src/lib/gasless-signer.ts:200, 210`
- **Cambio**: tras `const parsed = hexToSignature(signature)`, derivar:
  ```ts
  const vNum = parsed.v !== undefined
    ? Number(parsed.v)
    : Number(parsed.yParity) + 27
  ```
- **Verificar**: ejecutar `npm test -- gasless-signer` con un test nuevo:
  ```ts
  expect([27, 28]).toContain(r.v)
  expect(Number.isFinite(r.v)).toBe(true)
  ```
- **Archivo**: `src/lib/gasless-signer.test.ts:136` — reemplazar `expect(typeof r.v).toBe('number')` por las dos expects de arriba.

### Fix-2 (H-5) — confirmar o reemplazar `hexToSignature`
- **Archivo**: `src/lib/gasless-signer.ts:10`
- **Comando de verificación** (Dev debe correr y pegar evidencia en commit message o validation report):
  ```
  node -e "const v=require('viem'); console.log({hexToSignature: typeof v.hexToSignature, parseSignature: typeof v.parseSignature, version: require('viem/package.json').version})"
  ```
- **Si `hexToSignature` es `undefined`**: cambiar import a `import { parseSignature } from 'viem'` y renombrar la llamada.

### Fix-3 (H-24) — verificar shape del POST al relayer
- **Acción Dev**: ejecutar smoke test contra `https://gasless.gokite.ai/testnet` con un payload mínimo (sin secretos en logs).
- **Documentar**: agregar comentario `// VERIFIED 2026-04-06: relayer accepts camelCase {tokenAddress, validAfter, validBefore, v, r, s}` arriba de `submitGaslessTransfer`, o ajustar serialización a snake_case si falla.
- **Archivo**: `src/lib/gasless-signer.ts:225-229`

### Fix-4 opcional (H-3) — flag short-circuit en `getGaslessStatus`
- **Archivo**: `src/lib/gasless-signer.ts:252`
- **Cambio**: si `enabled === false`, retornar early con `supportedToken:null, operatorAddress:null` y sin tocar PK ni fetch.

### Fix-5 opcional (H-11) — timeout en fetch
- **Archivos**: `src/lib/gasless-signer.ts:147, 225`
- **Cambio**: agregar `signal: AbortSignal.timeout(5000)` en ambos `fetch`.

---

*Generado: 2026-04-06 | Adversary AR | ar-report.md (post-F3)*

---

# AR v2 — Re-review post-fix

## Verificación de BLOQUEANTES

- **H-4 — `v` puede ser `undefined`**: **CERRADO**
  - Evidencia: `src/lib/gasless-signer.ts:10` import canónico `parseSignature` (no `hexToSignature`); `src/lib/gasless-signer.ts:205-207`:
    ```ts
    const parsed = parseSignature(signature)
    const v = parsed.v !== undefined ? Number(parsed.v) : Number(parsed.yParity) + 27
    ```
  - Análisis del path muerto: `parseSignature` en viem 2.47.6 garantiza `yParity: 0|1` siempre presente para firmas serializadas (64 o 65 bytes). Si `parsed.v === undefined`, `parsed.yParity` es `0|1` ⇒ `v ∈ {27,28}`. Si `parsed.v` viene como `bigint` (27n/28n) ⇒ `Number(27n)=27`. No hay rama que produzca `NaN`/`null`/`undefined` salvo que viem retorne shape inválido (contract violation, fuera de scope). Path cubierto.

- **H-5 — `hexToSignature` posible import muerto**: **CERRADO**
  - Evidencia: `src/lib/gasless-signer.ts:10` `import { createWalletClient, http, parseSignature } from 'viem'` — `hexToSignature` ya NO se importa.
  - Verificación runtime: `node -e "..."` → `{"parseSignature":"function","hexToSignature":"function","version":"2.47.6"}`. `parseSignature` existe y es el canónico.
  - Referencias residuales sólo en JSDoc/comentarios (`gasless-signer.ts:5,168`) — no son código ejecutable, no rompen import. OK.

- **H-19 — Test "decompose v/r/s" no detecta `v=NaN`**: **CERRADO**
  - Evidencia: `src/lib/gasless-signer.test.ts:127-187` test reescrito.
  - Aserciones reales: `Number.isFinite(r.v)` (L138), `[27,28]).toContain(r.v)` (L139), regex sobre r/s (L142-143).
  - Recovery real: L147-186 reconstruye firma con `serializeSignature({r,s,v:BigInt(r.v)})` y llama `recoverTypedDataAddress` con el typed data exacto, comparando contra `privateKeyToAccount(TEST_PK).address` (L149, L186). Si `v` estuviera mal o `r/s` rotos, la address recuperada NO coincidiría → test fallaría. Es prueba criptográfica end-to-end de la firma, no humo.
  - PK determinista: `TEST_PK` (`gasless-signer.test.ts:9-11`), Anvil/Hardhat default account #0. Misma PK usada para firmar (vía `process.env.OPERATOR_PRIVATE_KEY`) y para derivar `expected`. Coherente.

## Verificación de MENORes cerrados

- **H-3 — `getGaslessStatus` side effects con flag OFF**: **CERRADO**
  - Evidencia: `src/lib/gasless-signer.ts:265-275` early-return cuando `enabled === false`. NO carga PK, NO llama `getSupportedToken`, NO toca wallet. Retorna `{enabled:false, network, supportedToken:null, operatorAddress:null}`.

- **H-11 — Sin timeout en fetch**: **CERRADO**
  - Evidencia: `src/lib/gasless-signer.ts:148` (`AbortSignal.timeout(5000)` en GET supported_tokens) y `src/lib/gasless-signer.ts:240` (`AbortSignal.timeout(15000)` en POST submit). Ambos cumplen la mitigación.

- **H-1 — `routes/gasless.ts` re-emite `err.message`**: **CERRADO**
  - Evidencia: `src/routes/gasless.ts:13-21`. Catch logea sólo `errorClass` (constructor name) vía `fastify.log.error` y responde con string constante `'gasless status failed'`. No hay path donde el cliente reciba `err.message`.

- **H-24 — Snake_case vs camelCase POST**: **CERRADO (parcial — documentado)**
  - Evidencia: `src/lib/gasless-signer.ts:227-229` JSDoc TODO explícito:
    ```
    TODO(WKH-29): verify POST shape with relayer when test wallet has balance.
    Asumimos camelCase ({tokenAddress, validAfter, validBefore, v, r, s}) según
    story-file A-2; el smoke test real queda pendiente del fondeo de la wallet.
    ```
  - La asunción A-2 está documentada en código. La verificación runtime real sigue pendiente del fondeo, pero el riesgo está explícitamente trazado y aceptado. Aceptable como MENOR-cerrado vía documentación.

## Regresiones detectadas

Ninguna.

- Suite completa pasa (112/112), incluyendo `kite-client.test.ts`, `tasks.test.ts`, `orchestrate.test.ts`, etc.
- AC-7 happy path con flag ON está afirmado: el test reescrito (`gasless-signer.test.ts:267-284`) ahora setea `process.env.GASLESS_ENABLED='true'` y verifica `enabled:true`, `operatorAddress` truthy, y que `JSON.stringify(s)` NO contiene la PK. El short-circuit de H-3 NO rompe el path "ON".
- Migración `parseSignature`: r/s permanecen como hex `0x…` (66 chars), test los regex-valida (L142-143). No hay byte-order bugs.
- `grep "ethers" src/` → 0 matches.
- `grep "console\." src/lib/gasless-signer.ts src/routes/gasless.ts` → 0 matches.
- `console.log` en `src/index.ts:67` es PRE-EXISTENTE (banner de boot), no introducido por WKH-29.
- Sin `any` nuevos. Imports prohibidos: ninguno. Singleton pattern intacto.
- `src/index.ts:59-62` registro condicional intacto.

## Quality gates

| Gate | Resultado |
|------|-----------|
| `npx tsc --noEmit` | **PASS** (sin output, exit 0) |
| `npx vitest run src/lib/gasless-signer.test.ts` | **9/9 PASS** (34 ms) |
| `npx vitest run` (suite completa) | **112/112 PASS** (10 archivos) |
| `grep -rn "ethers" src/` | **0 matches** |
| `grep "console\." gasless-signer.ts gasless.ts` | **0 matches** |
| Verificación runtime `parseSignature` viem 2.47.6 | **OK** (`typeof === 'function'`) |
| Recovery criptográfico de firma en test | **PASS** (recoverTypedDataAddress ↔ signer) |

## Veredicto v2

# **OK** — apto para CR + F4

Justificación:
- Los 3 BLOQUEANTES (H-4, H-5, H-19) están cerrados con evidencia archivo:línea y verificación criptográfica real (no humo).
- Los 4 MENORes priorizados (H-1, H-3, H-11, H-24) están cerrados (H-24 vía documentación explícita de la asunción A-2 + TODO trazado, pendiente smoke test runtime cuando haya fondeo — riesgo aceptado y visible).
- Sin regresiones: 112/112 tests, typecheck limpio, sin imports prohibidos, sin secretos en logs.
- MENORes residuales no abordados (H-2, H-8, H-9, H-10, H-12, H-16, H-18, H-20, H-21, H-23) son no-bloqueantes y pueden quedar como deuda técnica trazada para iteraciones futuras o post-fondeo.

*Generado: 2026-04-06 | Adversary AR v2 | post-fix-wave*
