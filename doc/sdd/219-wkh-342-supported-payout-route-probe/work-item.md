# Work Item — [WKH-342] `/supported` anuncia una capacidad cuyo transporte no está registrado, y el guard de arranque valida un string en vez de la ruta

## Resumen
`GET /supported` del facilitator (consumido por wasiai-a2a, wasiai-v2 y terceros — así lo dice
su propio docblock, `wasiai-facilitator/src/routes/supported.ts:5-6`) deriva su respuesta
exclusivamente de `chainRegistry` (`wasiai-facilitator/src/core/supported.ts:135-137`), sin mirar
si `POST /solana/payout` está realmente registrado (`wasiai-facilitator/src/app.ts:422-424`, gate
independiente `isSolanaPayoutEnabled()`). Del otro lado, el guard de arranque del gateway
(`wasiai-a2a/src/adapters/solana/facilitator-settle.ts:162-174`) sólo valida que
`SOLANA_FACILITATOR_URL` no esté vacía — su propio docblock (línea 150) admite que eso "NO
prueba que del otro lado exista `POST /solana/payout`". Esta HU cierra las dos mitades: (A) que
`/supported` deje de mentir para TODO consumidor, y (B) que el gateway no arranque creyendo que
puede pagar por Solana vía facilitator cuando la ruta no existe.

## Sizing
- SDD_MODE: full
- Estimación: M
- Branch sugerido: `fix/219-wkh-342-supported-derive-registered-routes` (wasiai-facilitator) +
  `fix/219-wkh-342-payout-route-probe-guard` (wasiai-a2a)

## Estado de la bandera — DERIVADO, no MEDIDO
Hoy `SOLANA_SETTLE_VIA_FACILITATOR` está APAGADA — esto es **DERIVADO**, no medido: ningún
endpoint expone su valor en runtime, y se infiere de que hay settles Solana exitosos en
producción mientras `POST /solana/payout` es 404 (si la bandera estuviera ON, cada leg moriría
`'unknown'` en `payoutViaFacilitator`, `facilitator-settle.ts:200-289`). Esta HU no mide ese
valor ni lo cambia (CD-1) — sólo cierra la mina para cuando alguien la prenda.

## Acceptance Criteria (EARS)

- **AC-1** (facilitator, mitad A — deriva de rutas reales): WHEN `GET /supported` construye su
  respuesta y una entrada de chain/método implica la disponibilidad de una ruta dedicada no-x402
  (p.ej. `POST /solana/payout`), the system SHALL derivar esa implicación de si la ruta está
  efectivamente registrada en la instancia Fastify de ese arranque (mismo booleano que consume
  `app.ts:422` u otra señal de registro en vivo), NOT únicamente de `ChainMetadata.supportedMethods`
  del `chainRegistry`. Mecanismo exacto (campo nuevo vs. extender `methods`) queda para el SDD
  (F2) — ver Missing Inputs.

- **AC-2** (gateway, mitad B — sondea la ruta, no el string): WHEN el gateway arranca con
  `SOLANA_SETTLE_VIA_FACILITATOR=true` y una URL de facilitator configurada, the system SHALL
  sondear si `POST /solana/payout` existe en ese facilitator, ADEMÁS del chequeo actual de URL
  no-vacía (`assertFacilitatorPayoutConfigured`, `facilitator-settle.ts:162-174` queda como piso,
  no se reemplaza).

- **AC-3** (dirección i — la ruta NO existe): IF el sondeo determina, de forma definitiva, que
  `POST /solana/payout` no está registrada (p.ej. un 404 reproducible que no es indistinguible de
  un proxy intermedio — el criterio de "definitivo" es decisión de diseño del Architect), THEN
  the system SHALL rechazar el arranque O degradar de forma explícitamente declarada y logueada
  (nunca arrancar en silencio creyendo que el leg de payout vía facilitator funciona).

- **AC-4** (dirección ii — NO puedo preguntar, y NO es lo mismo que "no existe"): IF el sondeo no
  puede completarse (timeout, facilitator caído, error de red, respuesta no concluyente), THEN
  the system SHALL NOT tratar ese resultado como equivalente a AC-3 ("la ruta no existe") — SHALL
  seguir un tercer camino explícito y distinto de "existe"/"no existe" (p.ej. arrancar con warning
  loud + reintento acotado, o el criterio que fije el Architect), preservando los tres desenlaces
  del sondeo (existe / no existe / no sé) sin colapsarlos en un booleano.

- **AC-5** (EVM intocado): WHILE `SOLANA_SETTLE_VIA_FACILITATOR` está unset/false, o la chain en
  uso es EVM (Kite/Avalanche/Base), the system SHALL arrancar y settlear byte-idéntico al
  comportamiento pre-HU — cero llamadas de red nuevas, cero guards nuevos, cero cambio observable
  en el camino EVM. Probado por las suites EVM existentes SIN modificar su semántica.

- **AC-6** (no fabricar disposición de pago): IF el sondeo del guard (AC-2/3/4) falla o es
  indeterminado, THEN the system SHALL NOT fabricar un estado terminal de pago (`success:false`,
  o cualquier veredicto sintético) a partir de ese resultado — el sondeo decide únicamente
  arranque/degradación de la CAPACIDAD, nunca la disposición de un pago concreto, que sigue
  gobernada exclusivamente por `PAYOUT_NO_SPEND_CODES`/`'unknown'` (HU-201,
  `facilitator-settle.ts:54-94`), intocada por esta HU.

- **AC-7** (vocabulario público no cambia sin razón escrita): IF la forma de la respuesta de
  `GET /supported` cambia (campo nuevo, campo renombrado, semántica de un campo existente
  cambiada), THEN the system SHALL hacerlo de forma ADITIVA (consumidores existentes no se
  rompen) Y el SDD (F2) SHALL documentar qué consumidores conocidos (wasiai-a2a, wasiai-v2,
  terceros — los tres nombrados en `supported.ts:5-6`) se ven afectados y por qué.

## Scope IN

### wasiai-facilitator
- `src/core/supported.ts` — `getSupportedResponse()`: derivar la señal de disponibilidad de
  `POST /solana/payout` del registro real de rutas, no sólo de `chainRegistry`.
- `src/app.ts` — posible exposición de `isSolanaPayoutEnabled()` (u otra señal de registro) al
  builder de `/supported` (hoy sólo se usa en la línea 422 para gatear el registro de la ruta).
- Tests correspondientes (`test/routes/supported.test.ts` o equivalente).

### wasiai-a2a
- `src/adapters/solana/facilitator-settle.ts` — `assertFacilitatorPayoutConfigured()` (o función
  nueva con nombre distinto si el Architect decide separar el sondeo del chequeo de string) para
  sondear la ruta con los 3 desenlaces de AC-2/3/4.
- Tests correspondientes (mock del facilitator con los 3 desenlaces: 200/404 definitivo/timeout).

## Scope OUT

- `chaski-v3`, `solana-programs`, `wasiai-remittance-agents` — fuera de alcance por instrucción.
- Prender, apagar o modificar CUALQUIER variable de entorno (`SOLANA_SETTLE_VIA_FACILITATOR`,
  `SOLANA_FACILITATOR_URL`, o cualquier otra) — decisión del founder, posterior a esta HU (CD-1).
- El camino EVM (Kite/Avalanche/Base) — verify/settle/boot deben quedar byte-idénticos (CD-2).
- La lógica interna de `POST /solana/payout` (`wasiai-facilitator/src/routes/solana-payout.ts`) —
  esta HU sondea si la ruta EXISTE, no cambia qué hace.
- El camino local de firma (`SOLANA_OPERATOR_PRIVATE_KEY`, fallback cuando la bandera está OFF) —
  intocado, sigue siendo el camino de dinero vivo hoy.
- `PAYOUT_NO_SPEND_CODES` / la disposición `'unknown'` de HU-201 — no se toca (CD-3).
- Decidir el timing del sondeo (sólo arranque / sólo primer uso / ambos) — queda para el
  Architect en F2, ver Missing Inputs.

## Decisiones técnicas (DT-N)

- **DT-1**: el gate de `app.ts:422` (`if (isSolanaPayoutEnabled())`) es UN `if`, pero
  `isSolanaPayoutEnabled()` ya agrega 3 condiciones internas (flag ON + key parseable + key
  distinta de fee-payer/release-authority — docblock `solana-payout.ts:14-16`). AC-1 debe leer
  la señal de "la ruta está registrada" desde ese booleano compuesto (o desde el registro real de
  Fastify), no reinventar una condición paralela que pueda desincronizarse de él.
- **DT-2**: el sondeo de AC-2 es una llamada de red en el arranque (o en el primer uso — ver
  Missing Inputs). Debe reusar el mismo timeout/clasificación de errores de transporte que ya
  existe en `payoutViaFacilitator` (`facilitator-settle.ts:230-239`,
  `classifySettleTransportError`) para no inventar una segunda taxonomía de "no pude preguntar".
- **DT-3**: AC-1 no prescribe el mecanismo exacto (nuevo campo en `SupportedResponse` vs.
  extender `methods` vs. otro). El patrón ya existente de "exactamente uno de dos campos"
  (`breakerState`/`breakerStateAbsentReason`, `supported.ts:94-112`) es un precedente directo a
  evaluar en F2 para representar "capacidad declarada" vs. "capacidad no verificable".

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO prender, apagar o modificar `SOLANA_SETTLE_VIA_FACILITATOR`,
  `SOLANA_FACILITATOR_URL`, o cualquier env var de payout en esta HU. Escribir código y tests
  únicamente; encender la bandera es decisión del founder, posterior (AC-2/3/4 se validan con
  tests que simulan el flag ON, sin tocar el entorno real).
- **CD-2**: PROHIBIDO cualquier cambio de comportamiento observable en el camino EVM
  (Kite/Avalanche/Base) — verify, settle, arranque. Byte-idéntico, probado por las suites EVM
  existentes SIN modificar su semántica (AC-5).
- **CD-3**: PROHIBIDO fabricar un estado terminal de pago (`success`/`failure`) a partir del
  resultado del sondeo. La disposición `'unknown'` de HU-201 (`PAYOUT_NO_SPEND_CODES`,
  `facilitator-settle.ts:54-94`) permanece intocada; el sondeo del guard decide únicamente
  arranque/degradación de la capacidad (AC-6).
- **CD-4**: el vocabulario público de `GET /supported` sólo cambia de forma ADITIVA y con la
  razón + consumidores afectados documentados en el SDD (AC-7). Ningún consumidor existente
  (wasiai-a2a, wasiai-v2, terceros — `supported.ts:5-6`) puede romperse por este cambio.

## Missing Inputs

- **[NEEDS CLARIFICATION — decisión del Architect en F2, no bloqueante]** Timing del sondeo de
  AC-2: ¿al arrancar, la primera vez que se usa, o las dos? Contrapartida explícita: sondear SÓLO
  al arrancar puede quedar stale si el facilitator redeploya y pierde la ruta después; sondear
  SÓLO al primer uso reintroduce la ventana "un leg por vez, sin señal en el arranque" que esta
  HU busca cerrar; sondear las dos agrega una segunda llamada de red por ciclo de vida. No lo
  resuelvo acá — lo deja este work-item explícitamente para F2.
- **[NEEDS CLARIFICATION — decisión del Architect en F2, no bloqueante]** Qué cuenta como
  "definitivo" en AC-3 (¿un único 404? ¿N reintentos consistentes?) — un 404 puede venir de un
  proxy intermedio (ya señalado en el docblock de `facilitator-settle.ts:150-156`), así que
  declarar "definitivo" tras un solo intento puede ser demasiado agresivo para AC-3 vs. AC-4.
- **[NEEDS CLARIFICATION — decisión del Architect en F2, no bloqueante]** Mecanismo exacto de
  AC-1/AC-7 en la forma de la respuesta de `/supported` (ver DT-3).
- No hay bloqueantes para pasar a F2: ninguno de los tres puntos de arriba impide diseñar el SDD;
  son decisiones de diseño, no de producto/negocio.

## Análisis de paralelismo

- **No bloquea otras HUs.** Los archivos tocados (`wasiai-facilitator/src/core/supported.ts`,
  `src/app.ts`, `wasiai-a2a/src/adapters/solana/facilitator-settle.ts`) no aparecen en el scope
  de las HUs Solana actualmente en vuelo: WKH-314 (fila 212, `middleware/x402.ts` +
  `compose.ts`), WKH-315 (fila 213, `routes/auth/deposit.ts` + `adapters/solana/deposit-verifier.ts`),
  WKH-316 (fila 214, `types/index.ts` + `services/agent.ts`), WKH-318 corte B (fila 218, YA
  mergeado), WKH-319 (fila 216, `adapters/solana/payment.ts` `checkTerms`, en worktree sin
  mergear). Ninguna toca `facilitator-settle.ts` ni `supported.ts`/`app.ts`.
- **Puede ir en paralelo** con WKH-314/315/316/319: cero colisión de archivo. Único roce menor:
  todas viven bajo `wasiai-a2a/src/adapters/solana/` — si dos ramas tocan el mismo archivo por
  casualidad (no es el caso identificado hoy), el conflicto sería textual y trivial, no de lógica.
- **wasiai-facilitator** no tiene otras HUs Solana abiertas en este índice — el repo está libre
  de contención para el lado (A) de esta HU.
