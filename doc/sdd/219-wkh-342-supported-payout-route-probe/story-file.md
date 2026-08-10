# Story File — [WKH-342] `/supported` publica las rutas dedicadas reales · el gateway sondea la ruta, no el string

**Este archivo es tu contrato. Si algo no está acá, no lo hagas.** Especificación completa en
`sdd.md` (mismo directorio) — sólo para consultar el "por qué", no para decidir el "qué".

Todo lo MEDIDO de acá se midió el **2026-08-09** contra `wasiai-a2a@568cf40` y
`wasiai-facilitator@b896228`. `MEDIDO` = leído/ejecutado. `DERIVADO` = inferido.

**⛔ Trabajás en DOS repos:**
- **A** = `/home/ferdev/.openclaw/workspace/wasiai-facilitator` (rama `fix/219-wkh-342-supported-derive-registered-routes`)
- **B** = `/home/ferdev/.openclaw/workspace/wasiai-a2a` (rama `fix/219-wkh-342-payout-route-probe-guard`)

---

## 1 · Qué se construye, en dos frases

`GET /supported` del facilitator hoy **no dice nada** sobre el riel de tesorería: `POST /solana/payout`
se registra bajo su propio gate (`A/src/app.ts:422`) y `/supported` se arma sólo del `chainRegistry`
(`A/src/core/supported.ts:136`), así que un consumidor no puede saber si ese transporte existe.
Del otro lado, el guard de arranque del gateway sólo valida que la URL no esté vacía
(`B/src/adapters/solana/facilitator-settle.ts:162-174`) y su propio docblock (`:149-156`) admite que
eso **no prueba** que la ruta exista. Mitad A publica la verdad derivada del router vivo; mitad B la
sondea y usa el resultado con **tres** desenlaces, nunca dos.

**⚠️ Corrección al encuadre, MEDIDA — no la contradigas al escribir docblocks:** `/supported` **no
anuncia** hoy la capacidad de desembolso. El único método de la entrada Solana es
`spl-token-transfer-finalized` (`A/src/chains/solana-adapter.ts:138`), que es el riel **testigo** de
`/verify`+`/settle` y **sí existe**; y `A/src/core/supported.ts:69-70` dice textual que
payout/sponsor/release no son adaptadores y no salen en `/supported`. **Por eso el cambio es un campo
ADITIVO y no un filtro: no hay ningún string que sacar.** Si escribís "dejaba de mentir" en un
comentario, estás afirmando de más.

---

## 2 · 🔴 ORDEN ENTRE REPOS: **A primero, B después.** No es cosmético.

Ningún orden rompe producción — los dos están medidos. El orden importa por otra cosa:

- **A primero** → aparece el campo nuevo. **Cero consumidores** en runtime lo leen (MEDIDO
  2026-08-09: 0 hits de `/supported` en `B/src`, en todo `wasiai-v2`, `wasiai-sdk`, `chaski-v3`,
  `wasiai-monitor`, `wasiai-cli`). Los dos únicos consumidores son scripts de B
  (`B/scripts/smoke-downstream-x402.mjs:337`, `B/scripts/hackathon-e2e.mjs:133`) y leen campos por
  nombre, sin igualdad profunda ni enumeración de claves. Efecto observable: **cero**.
- **B primero** → el gateway sondea un facilitator sin el campo ⟹ veredicto `route_unaskable`
  (razón `field_absent`) ⟹ hace el POST real ⟹ comportamiento **idéntico al de hoy**. No rompe
  nada, **pero el guard queda INERTE hasta que A despliegue**, y una validación hecha en esa
  ventana daría un verde falso sobre un guard que no está guardando nada.

**Regla operativa: no empieces W3 hasta que W1+W2 estén verdes.** No hace falta que A esté
desplegado para codear B (los tests de B usan dobles), pero sí para que la HU signifique algo.

---

## 3 · Scope IN — archivos exactos, y nada más

### Repo A (facilitator)
| Archivo | Qué se toca |
|---|---|
| `A/src/core/supported.ts` | tipo del id de ruta + campo `dedicatedRoutes` en `SupportedResponse` + parámetro **requerido** en `getSupportedResponse()` (hoy `:135`, sin parámetros) |
| `A/src/routes/supported.ts` | computar la señal con `app.hasRoute` **dentro del handler** (`:42-66`) y agregar el campo al build explícito (`:62-65`) |
| `A/src/__tests__/unit/routes.supported.test.ts` | T-A1…T-A4 |
| `A/src/__tests__/unit/chains/solana-adapter.test.ts:454-460` | 2º y último llamador de `getSupportedResponse()` (MEDIDO): adaptarlo al parámetro nuevo |

### Repo B (gateway)
| Archivo | Qué se toca |
|---|---|
| `B/src/adapters/solana/facilitator-settle.ts` | el sondeo, el veredicto tri-estado, la memoización y el gate perezoso. **`assertFacilitatorPayoutConfigured` (`:162-174`) NO SE TOCA** — queda como piso |
| `B/src/index.ts` | **UNA** línea, después de `await fastify.listen()` (`:327`), junto a `:338` y `:345` |
| `B/src/adapters/solana/facilitator-settle.test.ts` | T-B1…T-B6, T-B8, T-B10, T-B11 |
| `B/src/adapters/solana/facilitator-settle.wiring.test.ts` (**nuevo**) | T-B7. Va en `src/`, no en `test/`, porque `B/tsconfig.json:19` incluye sólo `src/**/*`: un test en `test/` **no lo typechequea nadie** (MEDIDO) |

**Fuera de Scope IN, prohibido abrir:** `B/src/adapters/solana/payment.ts`,
`B/src/adapters/registry.ts`, `A/src/routes/solana-payout.ts`, cualquier migración, cualquier
`.env*`.

---

## 4 · 🔴 LOS TRES DESENLACES — el corazón de la HU

Unión discriminada en `B/src/adapters/solana/facilitator-settle.ts`. **PROHIBIDO un `boolean` o un
`boolean | undefined` en la firma** (ver §7 CD-5).

```
PayoutRouteVerdict =
  | { state: 'route_registered' }
  | { state: 'route_absent';    detail: string }
  | { state: 'route_unaskable'; reason: UnaskableReason; detail: string }
```

| Estado | Evidencia que lo produce | Qué hace el sistema | Log |
|---|---|---|---|
| `route_registered` | `GET {url}/supported` → **200**, cuerpo JSON parseable, `dedicatedRoutes` **es array** y **contiene** `"POST /solana/payout"` | sigue, hace el POST | silencio |
| `route_absent` | 200 + parseable + `dedicatedRoutes` **es array** y **no** lo contiene | **rechaza el leg ANTES del POST**, con la MISMA construcción que la rama sin URL de hoy (`facilitator-settle.ts:203-209`): `FacilitatorSettleError(..., 'not-sent')` | `log.error`, con la acción para el operador |
| `route_unaskable` | **todo lo demás** | **sigue igual que hoy**: hace el POST real y la clasificación de 4 pasos (`:230-288`) decide | `log.warn` |

`UnaskableReason` — cuatro razones, cada una con su acción (molde: `SolanaSchemaFailure`,
`B/src/adapters/solana/schema-preflight.ts:72-91`):

| Razón | Cuándo | Acción del operador |
|---|---|---|
| `transport_error` | DNS / connection refused / timeout / abort | mirar la red y el facilitator |
| `probe_http_error` | status ≠ 200 — **incluido un 404 sobre `/supported` mismo** | hay un proxy en el medio, o la URL apunta a otra cosa |
| `body_unreadable` | no es JSON, o no es objeto | ídem: alguien reescribió la respuesta |
| `field_absent` | **200 sano pero `dedicatedRoutes` no es un array** | el facilitator es **anterior a la mitad A**: desplegá A |

### La asimetría, escrita acá porque es lo primero que te van a atacar

**"No sé" DEJA PASAR al POST en vez de bloquear, y el motivo es que los dos errores no cuestan lo
mismo:**
- Bloquear con "no sé" convierte **un blip del vecino en un corte de pagos nuestro**,
  autoinfligido, con el facilitator posiblemente sano.
- Dejar pasar tiene el costo **acotado y ya conocido**: el POST real hereda intacta la
  clasificación de HU-201, donde un 404 mudo cae en `'unknown'` (`facilitator-settle.ts:270-275`)
  ⟹ ni refund ni re-envío, revisión humana. O sea que **el peor caso de `route_unaskable` es
  exactamente el comportamiento de hoy, no uno peor. No hay doble pago en esa rama.**
- Y ojo con la comparación fácil: en `schema-preflight.ts:148-160` la decisión es **la contraria**
  (no medir ⟹ cortar) porque allá permitir de más habilita un **segundo pago irreversible**. Acá no
  medir sólo **posterga** una determinación. La regla es la misma —el default va del lado del error
  barato— y por eso el resultado es distinto. No "unifiques" los dos criterios.

**Y por qué `route_absent` sí puede bloquear sin miedo al 404 de un proxy** (que es lo que temía el
work-item, `facilitator-settle.ts:150-156`): la determinación negativa **no se lee de un status
code**, se lee de un **200 sano donde el facilitator enumeró sus rutas dedicadas y ésta no está**.
Un proxy que devuelve 404 cae en `probe_http_error`. Un facilitator viejo cae en `field_absent`.
**Sólo el facilitator real, contestando bien, puede decir "no la tengo" — por eso no hacen falta N
reintentos.**

**Discriminante obligatorio: `Array.isArray(body.dedicatedRoutes)`.** Nunca truthiness, nunca
`.length`. Un `[]` es una RESPUESTA (`route_absent`), la ausencia del campo es un NO SÉ.

### Timing y memoización (no lo cambies)

- **El arranque NUNCA falla por el sondeo.** El único fallo de arranque sigue siendo el de hoy:
  bandera `'true'` + sin URL (`assertFacilitatorPayoutConfigured`, intacta).
- **Al arrancar se dispara igual**, fire-and-forget, sin `await`, **después** de
  `await fastify.listen()` (`B/src/index.ts:327`), exactamente como `:338` y `:345`. Motivo MEDIDO:
  `B/railway.json:10` trae `ON_FAILURE` **sin** `restartPolicyMaxRetries` (el facilitator sí lo
  trae, `A/railway.json:11-12`), y `healthcheckTimeout` es 60 s (`B/railway.json:9`) — un sondeo
  bloqueante deja al gateway en ciclo de reinicios por un vecino caído dos minutos.
- **El gate real es perezoso**, paso 0 de `payoutViaFacilitator`: **después** del chequeo de URL
  (`:203-209`) y **antes** del `fetch` (`:219`), y **comparte el MISMO veredicto memoizado** que el
  warm-up (no pueden divergir — el argumento está en `schema-preflight.ts:47-50`).
- Copiá la mecánica de `schema-preflight.ts:122-137, 240-285`: `_cached` / `_cachedAt` /
  `_inFlight` (single-flight), un `_reset…()` test-only, y el `warm…()` con
  `void … .catch(() => {})`.
- **TTL doble, y acá te apartás del exemplar a propósito**: positivo **300 s**, negativo **60 s**.
  El positivo **no** es infinito porque el sujeto es **otro servicio que redespliega solo** (es el
  "queda stale" del work-item); en el preflight de esquema el sujeto es nuestra base y revertir
  viene con un restart nuestro (`schema-preflight.ts:233-235`).
- **Timeout del sondeo: 5 s.** NO reuses `FACILITATOR_TIMEOUT_MS` (`:40`, 30 s): ese techo es para
  un request que FIRMA Y TRANSMITE, y el gate perezoso no puede sumar 30 s a un leg de dinero.
- **NO uses `classifySettleTransportError`** (`B/src/adapters/errors.ts:296-313`) en el sondeo. Esa
  función decide la disposición del **VALOR** (`'not-sent'` vs `'unknown'`); el sondeo **no manda
  valor**, así que ahí `'not-sent'` sería trivialmente cierto en los tres desenlaces = información
  cero. Todo fallo de transporte del sondeo es `transport_error`. (Sí se usa, intacta, en el POST
  real.)

---

## 5 · Waves — archivo por archivo

| Wave | Repo | Archivo | Qué hacés |
|---|---|---|---|
| **W0** (serial, contrato) | A | `src/core/supported.ts` | Tipo del id de ruta + `dedicatedRoutes: readonly string[]` en `SupportedResponse` (`:114-117`) + parámetro **requerido** en `getSupportedResponse()` (`:135`). Docblock del tri-estado (campo ausente = *no sé* / presente y contiene = *existe* / presente y no contiene = *no existe*), con el molde de `:44-92`. **Cero imports nuevos: la pureza declarada en `:20-28` no se toca.** |
| **W1** | A | `src/routes/supported.ts` | Tabla explícita de las 3 rutas opt-in — `POST /solana/payout` (`A/src/routes/solana-payout.ts:260`), `POST /solana/sponsor` (`solana-sponsor.ts:217`), `POST /solana/escrow/release` (`solana-escrow.ts:201`) — resueltas con `app.hasRoute({ method, url })` **dentro del handler** (`:42-66`), y el campo agregado al build explícito campo por campo (`:62-65`). Las tres, no sólo payout: comparten el mismo mecanismo de invisibilidad (`A/src/app.ts:411,416,422`). Adaptá también `A/src/__tests__/unit/chains/solana-adapter.test.ts:454-460`. |
| **W2** | A | `src/__tests__/unit/routes.supported.test.ts` | T-A1…T-A4. |
| **W3** | B | `src/adapters/solana/facilitator-settle.ts` | `PayoutRouteVerdict` + `UnaskableReason` + `probePayoutRoute()` + `ensurePayoutRouteReady()` (memoizado, single-flight, TTL doble) + `warmPayoutRoutePreflight()` + `_resetPayoutRoutePreflight()` (test-only) + el paso 0 de `payoutViaFacilitator`. El criterio `process.env.SOLANA_SETTLE_VIA_FACILITATOR === 'true'` va **DENTRO** de este módulo (es el dueño de esos nombres de env — motivo textual en `B/src/adapters/registry.ts:135-138`). |
| **W4** | B | `src/index.ts` | **UNA** línea: `warmPayoutRoutePreflight();` junto a `:338`/`:345`, después de `listen()`, **sin `await`** y **sin gate en el call-site** (el gate vive dentro — se aparta de `:338`/`:345` a propósito, y el docblock tiene que decir por qué). |
| **W5** | B | `facilitator-settle.test.ts` + `facilitator-settle.wiring.test.ts` | T-B1…T-B11. |

W2 puede ir en paralelo con W3. Todo lo demás es serial.

---

## 6 · Los 15 tests — usá **estos** IDs, no inventes otros

**Facilitator (A)** — `src/__tests__/unit/routes.supported.test.ts`. Patrón:
`app.inject()` + `chainRegistry._resetForTesting()` + mocks de `core/audit.js` e `ioredis`
+ `buildApp({...})` (`:1-60, 205-215`).

| ID | AC | Afirma | Input que lo pone en ROJO |
|---|---|---|---|
| **T-A1** | AC-1 | App real con el gate de payout satisfecho ⟹ `dedicatedRoutes` contiene `"POST /solana/payout"` | derivar el campo de `chainRegistry`/`supportedMethods` en vez del router |
| **T-A2** | AC-1 | Gate NO satisfecho ⟹ el campo existe, es array y **no** lo contiene; y `POST /solana/payout` en la misma app da 404 | hardcodear el string en la lista. También cae si `hasRoute` no atraviesa la encapsulación del plugin (eso hoy es **DERIVADO**: este test lo cierra) |
| **T-A3** | AC-7 | `chains` y `methods` conservan forma y valores, invariante exactamente-uno-de-`breakerState`/`breakerStateAbsentReason` intacto, y `methods` **no** gana ningún string de payout | filtrar o renombrar cualquier cosa: es el candado de "aditivo" |
| **T-A4** | AC-1 | `getSupportedResponse()` sigue pura: mismo parámetro ⟹ misma respuesta; y el parámetro es **requerido** | volverlo opcional con default ⟹ rojo. ⚠️ La parte de compilación se verifica con **`npm run typecheck:tests`**: `A/tsconfig.json:20` **excluye `**/*.test.ts`** del typecheck principal (MEDIDO) |

**Gateway (B)** — `src/adapters/solana/facilitator-settle.test.ts`. Patrón:
`vi.spyOn(globalThis,'fetch')` + helper `jsonResponse(status, body)` + envs salvadas/restauradas
(`:26-67`), y los grupos G-1…G-5 de `facilitator-payout-startup-guard.test.ts:91-216`.

| ID | AC | Afirma | Input que lo pone en ROJO |
|---|---|---|---|
| **T-B1** | AC-2 | Bandera ON + URL ⟹ el arranque dispara **UN** `GET {url}/supported` | borrar la llamada del warm-up ⟹ 0 llamadas al spy |
| **T-B2** | AC-2/3 | `dedicatedRoutes` **contiene** la ruta ⟹ se hace el POST y vuelve la firma | que el gate rechace con el veredicto positivo |
| **T-B3** | **AC-3** | `dedicatedRoutes: []` ⟹ rechazo **antes** del POST: `readSettleValueDisposition(err) === 'not-sent'`, `fetch` llamado **una** vez y **nunca** contra `/solana/payout` | doble 200 con `[]`; si el gate no existe aparece el 2º `fetch` |
| **T-B4** | **AC-4 (i)** | **"NO PUDE PREGUNTAR" — ⚠️ el doble RECHAZA**: `fetchSpy.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { cause: { code: 'ETIMEDOUT' } }))` ⟹ `route_unaskable/transport_error`, **el POST SÍ se hace**, y el leg lo decide la respuesta real | colapsar el fallo del sondeo en `route_absent` ⟹ no hay POST. **PROHIBIDO escribir este caso con un doble que devuelva 404** — un 404 es una respuesta, no un "no pude preguntar", y no prueba el tercer desenlace |
| **T-B5** | **AC-4 (ii)** | Sondeo **200 sano SIN `dedicatedRoutes`** (facilitator viejo) ⟹ `route_unaskable/field_absent`, el POST se hace | leer la ausencia como "no está". El par que distingue este test de T-B3 es **`[]` vs campo ausente** |
| **T-B6** | AC-4 | Sondeo con **404 sobre `/supported`** y sondeo con **cuerpo no-JSON** ⟹ `probe_http_error` / `body_unreadable`, los dos `route_unaskable` | mapear el 404 del sondeo a `route_absent`: es el candado contra el proxy intermedio |
| **T-B7** | AC-2 | **Cableado**: `src/index.ts` contiene la llamada al warm-up, **después** de `fastify.listen(` (índices sobre el texto del archivo) y **sin `await`** | moverla arriba de `listen` o ponerle `await`. Sin este test el warm-up podría no estar cableado y todo el resto daría verde: `src/index.ts` no se puede importar desde un test (tiene `await initAdapters()` de nivel de módulo — dicho en `B/src/index.ts:246-248`), así que la única prueba posible es leer el fuente como texto (técnica ya usada en `B/test/ownership-filter-guard.scanner.ts`) |
| **T-B8** | **AC-5** | Bandera ausente / `'false'` / `'TRUE'` / `'1'` / `'yes'` / `''` ⟹ el warm-up y el gate no hacen **NI UN** `fetch` | `Boolean(process.env.X)` en vez de `=== 'true'` ⟹ los 5 valores salen a la red |
| **T-B9** | AC-5 | Las suites EVM existentes pasan **sin editarlas**: `payment.test.ts`, `payment.flag.test.ts`, `intent-dedup.test.ts`, `settle-wiring.test.ts` + Kite/Avalanche/Base | cualquier cambio en el camino EVM. **Si necesitás editar una de esas suites, pará: es señal de violación de la no-touch, va al AR** |
| **T-B10** | AC-6 | `PAYOUT_NO_SPEND_CODES` idéntico (comparación de conjunto), el sondeo no agrega códigos, y ningún veredicto del sondeo produce un `success` sintético | meter un código nuevo, o devolver un `SettleResult` desde el gate |
| **T-B11** | timing | 3 llamadas concurrentes al gate ⟹ **un** solo `GET /supported`; un `route_absent` se re-sondea pasados los 60 s y un `route_registered` pasados los 300 s (`vi.useFakeTimers`) | cachear el positivo para siempre ⟹ el re-sondeo no ocurre (es el "queda stale" del work-item, hecho test) |

---

## 7 · ⛔ NO-TOUCH — lista cerrada

1. **Camino EVM byte-idéntico** (Kite / Avalanche / Base): verify, settle, arranque. Cero llamadas
   de red nuevas, cero guards nuevos. **No edites la semántica de ninguna suite EVM** (T-B9).
2. **Cero líneas que fabriquen una disposición de pago.** Un `success:false` inventado a partir de
   un 404 **es peor que el 404**. El sondeo decide **arranque/degradación de la CAPACIDAD**, jamás
   la disposición de un pago concreto. `PAYOUT_NO_SPEND_CODES` (`facilitator-settle.ts:83-94`) y la
   disposición `'unknown'` de HU-201 quedan **intactas**; el rechazo por `route_absent` reusa la
   construcción de `:203-209` y **no** introduce ningún valor de disposición nuevo.
3. **Ninguna variable de entorno tocada ni propuesta.** No prendas, no apagues, no modifiques
   `SOLANA_SETTLE_VIA_FACILITATOR`, `SOLANA_FACILITATOR_URL` ni ninguna otra — y **no introduzcas
   una nueva**: los TTL (300 s / 60 s) y el timeout (5 s) son constantes de módulo. Encender la
   bandera es decisión del founder, posterior a esta HU.
4. **El arranque no puede fallar por el sondeo**: sin `await` en el camino de boot, sin `throw` que
   escape, y el `catch` no puede terminar en `process.exit`.
5. **La ausencia de `dedicatedRoutes` no es "la ruta no está"** (`Array.isArray`, nunca truthiness).
6. **`getSupportedResponse()` no pierde la pureza** (`A/src/core/supported.ts:20-28`): cero I/O,
   cero logger, cero import de `infra/*` o `routes/*`. La señal entra **por parámetro requerido**.
7. **La señal no se lee en el cuerpo del plugin de `/supported`**, sólo dentro del handler: el
   registro de plugins es diferido hasta `ready()` y `app.register(solanaPayoutRoute)` está en
   `A/src/app.ts:423` vs `supportedRoute` en `:425`.
8. **`assertFacilitatorPayoutConfigured` no se modifica ni se reemplaza.** Es el piso (AC-2).

---

## 8 · Baseline que tenés que reproducir al cerrar

Medido hoy, **2026-08-09**, en árbol limpio de código:

| Repo | Comando | Resultado MEDIDO | Commit |
|---|---|---|---|
| A (facilitator) | `npm test` | **92 test files passed (92) · 1355 tests passed (1355)** | `b896228` |
| A | `npm run typecheck` | exit 0 · "TypeScript compilation completed" | `b896228` |
| A | `npm run typecheck:tests` | exit 0 · "ok ✓" — **obligatorio**: el typecheck principal excluye `**/*.test.ts` (`A/tsconfig.json:20`) | `b896228` |
| A | `npm run lint` (`eslint src/ --max-warnings 0`) | correr y dejar en 0 warnings | `b896228` |
| B (a2a) | `npm test` | **273 passed \| 6 skipped (279 files) · 5358 passed \| 19 skipped (5377 tests)** | `568cf40` |
| B | `npx tsc --noEmit` | exit 0 · "TypeScript compilation completed" (cubre `src/**/*`, incluidos los tests de `src/` — `B/tsconfig.json:19`) | `568cf40` |
| B | `npm run lint` (`biome check src/`) | correr y dejar limpio | `568cf40` |

**Al cerrar: los totales sólo pueden SUBIR por los tests que agregás, y `skipped` no puede crecer.**
Si algún test previo pasa a fallar o a skipped, es un hallazgo, no un ajuste. En B corre además
`test/test-files-are-run-in-ci.test.ts` (un archivo de test nuevo tiene que quedar cubierto por los
globs) y `test/docs-referenced-by-code-exist.test.ts` (si un docblock cita un path de `doc/`, ese
path tiene que existir).

---

## 9 · ⚠️ La trampa que ya cobró seis veces en la HU anterior

**Todo conteo, total o cita `archivo:línea` que escribas se deriva y se escribe como ÚLTIMA
acción.** Si después de escribirlo editás cualquier archivo citado —aunque sea otro renglón—, ese
número y esas líneas **vuelven a estar sin verificar**: los barridos miran lo que escribiste, no lo
que desplazaste. Dos consecuencias prácticas:
- Terminá el código, después releé y recién entonces escribí los números y las citas del reporte.
- Toda cifra o estado medido va con su **fecha o commit en la misma línea**. Una foto sin fecha
  envejece sola y nadie se entera.

Y el primo de esa trampa: **cada frase de docblock nueva tiene que ser falsable con un input
concreto.** Prosa que afirma de más apaga la revisión que la habría cazado — es el hallazgo
recurrente de las últimas HUs. Si no podés nombrar el input que la pondría en rojo, no la escribas.

---

## 10 · Done Definition

- [ ] W0…W5 completas, sólo los archivos de §3 modificados.
- [ ] Los 15 tests con **estos** IDs, verdes, cada uno con su input rojo verificado a mano (mutá,
      vé el rojo, revertí).
- [ ] T-B4 usa un doble que **rechaza**; T-B6 el 404; T-B3 el `[]`; T-B5 el campo ausente. Cuatro
      inputs distintos para tres desenlaces + la razón del facilitator viejo.
- [ ] `route_unaskable` **nunca** bloquea un leg; `route_absent` **nunca** hace el POST.
- [ ] Firma del sondeo con la unión discriminada. Cero `boolean` en el retorno.
- [ ] Baseline de §8 reproducido en los **dos** repos, con los totales nuevos y el commit al lado.
- [ ] Los 8 puntos de la no-touch (§7) verificados uno por uno, con `archivo:línea` cada uno.
- [ ] Los números y las citas del reporte escritos **al final**, después de la última edición.
- [ ] `auto-blindaje.md` en este directorio si hubo errores propios durante la implementación.

---

## 11 · Anti-Hallucination Checklist (verificá ANTES de escribir código)

- [ ] `A/src/core/supported.ts:135` — `getSupportedResponse()` hoy no recibe parámetros.
- [ ] `A/src/routes/supported.ts:32-41` — la ruta **no** declara `schema` ⟹ ningún serializador
      poda el campo nuevo. Y `:62-65` es el build explícito donde hay que agregarlo.
- [ ] `A/src/app.ts:422-424` — el `if (isSolanaPayoutEnabled())` que registra la ruta. La función
      vive en `A/src/infra/solana-payout-operator.ts:157`, y `core/supported.ts` tiene **prohibido**
      importar `infra/*` (`:23`): por eso la señal se inyecta.
- [ ] `hasRoute({ method, url }): boolean` existe en fastify 5.8.5
      (`A/node_modules/fastify/types/instance.d.ts:207-211`).
- [ ] Los tres paths exactos: `'/solana/payout'`, `'/solana/sponsor'`, `'/solana/escrow/release'`.
- [ ] `B/src/adapters/solana/facilitator-settle.ts:203-209` — la construcción del throw `'not-sent'`
      que hay que reusar; `:219` el `fetch`; `:230-288` los 4 pasos que **no se tocan**.
- [ ] `B/src/adapters/solana/schema-preflight.ts:122-137, 240-285` — la mecánica de memoización a
      copiar; `:72-91` el molde de "una razón con su acción"; `:233-235` el TTL del que te apartás.
- [ ] `B/src/index.ts:327` (`listen`), `:338` y `:345` (los dos warm-ups fire-and-forget existentes).
- [ ] `A/tsconfig.json:20` excluye `**/*.test.ts`; `B/tsconfig.json:19` incluye `src/**/*`.
- [ ] En el facilitator vitest corre **sólo** `src/**/*.test.ts`: un test en `A/test/…` **no lo
      correría nadie**.
