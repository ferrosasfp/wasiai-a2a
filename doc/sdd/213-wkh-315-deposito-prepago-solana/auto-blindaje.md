# Auto-Blindaje — WKH-315 (depósito prepago Solana)

Errores cometidos durante F3 y cómo se previenen la próxima vez. Se escribe **cuando
el error ocurre**, no al final.

---

### [2026-07-30 W0] El story file afirmó que la suite CD-1 no habría que tocarla, y sí hubo que tocarla (por tipos, no por conducta)

- **Error**: asumí, siguiendo §1.7 y `[SDD GAP #2]`, que narrowear
  `VerifyDepositArgs.chainKey` a `EvmChainKey` no rompería
  `src/adapters/deposit-verifier.test.ts` — una de las cuatro suites que CD-1/AC-10
  exige **verdes sin modificarse**. Rompió: 14 errores de compilación.
- **Causa raíz**: la verificación del story file fue sobre el **VALOR** ("ningún test
  pasa `chainKey: 'solana-devnet'` a `verifyDeposit`" — cierto) y no sobre el **TIPO**
  de la expresión. Los 14 call-sites escriben
  `chainKey: 'kite-ozone-testnet' as ChainKey`: un cast de **ensanchamiento** que le
  borra al compilador la información de que el literal ya es EVM. Un `as` no es
  neutral: cambia lo que el compilador sabe, y por lo tanto cambia qué narrowing
  aguas arriba es posible.
- **Fix**: se quitaron los 14 `as ChainKey` (y el import de `ChainKey`, que quedó sin
  uso). Cero aserciones, cero fixtures, cero mocks, cero conducta. Se descartaron las
  dos alternativas porque `[SDD GAP #2]` las prohíbe explícitamente: el cast en
  `deposit-verifier.ts:304` (aserción sin chequeo) y un guard dentro de
  `verifyDeposit` (cambia un cuerpo que CD-1 congela).
- **Aplicar en**: cualquier HU que narrowee el tipo de un parámetro público.
  **Grepear `as <TipoAncho>` en los tests ANTES de estimar el impacto**, no sólo los
  valores literales. Un `as` en un test es una dependencia de tipos invisible para un
  grep por valor.

---

### [2026-07-30 W0] Una propiedad requerida nueva en `A2AAgentKeyRow` rompe 33 archivos de test, dos de ellos intocables

- **Error**: declaré `funding_wallet_solana: string | null` (requerida) en
  `src/types/a2a-key.ts`. `tsc` cayó en 33 archivos que construyen la fila a mano,
  entre ellos `src/routes/auth.test.ts` — suite CD-1, prohibido editarla.
- **Causa raíz**: en un repo con `exactOptionalPropertyTypes`, agregar un campo
  REQUERIDO a una interfaz que ~33 fixtures construyen literalmente es un cambio
  transversal, no aditivo. El costo no está en el tipo: está en la cantidad de
  fixtures que lo materializan.
- **Fix**: `funding_wallet_solana?: string | null`, con la razón escrita en el
  docstring del campo. El story file (W0.5) ya autorizaba exactamente esto
  ("si algún fixture existente rompe `tsc`, pasalo a `?: string | null` y
  **declaralo**"). Riesgo acotado y del lado seguro: el único lector en producción es
  el gate de `POST /auth/deposit`, que fail-closea sobre cualquier valor falsy
  (`undefined` incluido) con 403 `FUNDING_WALLET_NOT_BOUND`.
- **Aplicar en**: toda columna nueva que aparezca en un row-type compartido. Contar
  los fixtures ANTES de elegir requerido vs opcional: `grep -rl "key_hash:" src/`
  aproxima el costo en un comando.

---

### [2026-07-30 W1.3] Un test que grepea una prohibición se satisface con la prosa que la documenta

- **Error**: el test "el módulo es LEAF" de `ed25519.test.ts` afirmaba
  `expect(src).not.toMatch(/tweetnacl|bs58/)` sobre el fuente CRUDO. Se puso rojo en su
  primera corrida — y no por una violación: la cabecera del módulo **explica** por qué
  no se usan esas dos librerías.
- **Causa raíz**: el test se ponía rojo justamente por cumplir bien la prohibición. Es
  el reverso exacto de la vacuidad clásica (un match contra el texto completo que se
  satisface con un comentario): acá el comentario producía el FALSO POSITIVO en vez del
  falso verde, pero la causa es la misma — afirmar sobre texto sin separar código de
  prosa.
- **Fix**: grepear el texto SIN COMENTARIOS, con el mismo criterio que el helper
  `code()` de los tests de migración.
- **Aplicar en**: TODA aserción sobre el texto de un fuente. Si el archivo documenta la
  regla que el test vigila —y los buenos la documentan— hay que despojar comentarios en
  las dos direcciones. Ya se aplicó en `deposit-account.test.ts` (T-315-13),
  `deposit-verifier.test.ts` (CD-14) e `identity.solana-funding.test.ts` (M7).

---

### [2026-07-30 W2] Un guard de seguridad por subcadena prohibía la carga útil de la respuesta

- **Error**: `T-315-12c` afirmaba `not.toContain('1'.repeat(32))` para cazar el fixture
  de `OPERATOR_PRIVATE_KEY` (`0x` + `'11'` × 32). Rojo, y **no por una fuga**.
- **Causa raíz**: el mint fixture `So111…112` tiene una tirada de **40 unos
  consecutivos**, así que contiene el needle. Y `token.mint` es precisamente el dato que
  el depositante NECESITA. El guard prohibía la carga útil. Raíz profunda: **un secreto
  formado por un carácter repetido es indistinguible de una dirección base58 legítima**,
  así que un guard por subcadena sobre él no puede separar la fuga del dato bueno.
- **Fix**: NO borrar la aserción (eso sí habría debilitado el control). Se le dio al
  fixture un valor DISTINTIVO (`a3f19c7d` × 8), se afirma sobre el valor COMPLETO y
  sobre la **address derivada** con `privateKeyToAccount` —el valor exacto que el
  landmine publicaría, que antes no se verificaba—, y se agregó andamiaje anti-vacuidad
  (`networks.length === 1`) porque una respuesta vacía pasaba los cinco guards. Probado
  con una fuga inyectada: el guard muere con nombre.
- **Aplicar en**: todo fixture de secreto en un test de no-filtración. **Que sea
  distintivo es parte del contrato del test**, no un detalle estético. Y cuando un guard
  de seguridad se pone rojo, medir primero si lo que matchea es legítimo antes de tocar
  ninguna de las dos partes.

---

### [2026-07-30 W3.3] Un mutante sobrevivió: el test probaba el validador, no la ausencia del fallback

- **Error**: **M18 SOBREVIVIO** en la primera corrida de la campaña. La mutación
  (`A2A_DEPOSIT_SOLANA_OWNER ?? A2A_DEPOSIT_TREASURY_SOLANA`) dejó la suite entera verde.
- **Causa raíz**: el test ponía en la env de treasury una **address EVM**, que
  `isValidSolanaAddress` rechaza igual. O sea que el `null` venía de la validación
  siguiente, **no de la ausencia del fallback**. El test afirmaba sobre el validador y
  yo lo leía como si afirmara sobre el fallback. Es la vacuidad más difícil de ver: el
  test no es decorativo, prueba algo real — simplemente no prueba lo que su nombre dice.
- **Fix**: se agregó el caso que de verdad duele — la env de treasury con una **pubkey
  base58 VALIDA**, que es exactamente la confusión que el landmine invita (la env se
  llama `..._SOLANA`). Con ese caso, M18 pasa a **KILLED**.
- **Aplicar en**: cuando un test afirma "X no se usa", el fixture de X tiene que ser un
  valor que **sí funcionaría** si se usara. Si el fixture es rechazable por otro motivo,
  el test pasa por la razón equivocada. Regla operativa: **la mutación es la única forma
  de descubrir esto** — sin la campaña, este test habría entrado al AR como verde.

---

### [2026-07-30 W3.3] El mutante M1 del story file no compila, y eso es un hallazgo, no un obstáculo

- **Error**: M1 tal como lo especifica el story file (`DEPOSIT_COMMITMENT` pasa de
  `'finalized'` a `getSolanaCommitment()`) **no compila**, así que por la regla 3 no
  contaba como mutante.
- **Causa raíz** (y es buena noticia): `getParsedTransaction` tipa su `commitment` como
  `Finality` = `'confirmed' | 'finalized'`, que **excluye `'processed'`**. El retorno de
  `getSolanaCommitment()` incluye los tres, así que el SDK rechaza la sustitución. **El
  tipo del SDK es una segunda línea de defensa independiente**, que el diseño no había
  contado.
- **Fix**: se corrió la variante compilable y equivalente en intención —bajar el literal
  a `'confirmed'`—, que es el debilitamiento real que M1 quiere probar. **KILLED** por
  `T-315-03b`. Ambos resultados se reportan.
- **Aplicar en**: un mutante que no compila no se descarta en silencio ni se cuenta como
  muerto: se investiga POR QUE no compila (puede ser una defensa que nadie documentó) y
  se re-formula a la variante compilable más cercana.

---

### [2026-07-30 W3.2] El story file manda editar un documento que no existe en el repo

- **Error**: W3.2 lista `doc/MULTI-CHAIN.md` como archivo a modificar, y
  `chain-resolver.ts` lo cita como referencia de `TD-SOLANA-CAIP2-DENYLIST`. **No existe
  en este repositorio.**
- **Causa raíz**: la limpieza del 2026-07-28 sacó documentación interna a un repo
  privado. `test/docs-referenced-by-code-exist.test.ts` lo registra explícitamente como
  un nombre pelado que ya no resuelve, y por eso su chequeo sólo mira referencias con
  forma de ruta — así que el puntero roto **no pone roja ninguna suite**.
- **Fix**: NO se creó el archivo (crear un doc de raíz que el diseño suponía existente
  es inventar scope, y el contenido se movió a propósito). El runbook y la deuda
  declarada fueron a `doc/INTEGRATION.md` §6, que sí existe y es lo que el depositante
  lee, dejando anotado que el puntero del comentario sigue roto.
- **Aplicar en**: antes de "modificar" un archivo que un Story File lista, **verificar
  que exista**. Si no existe, es un hallazgo para el orquestador, no una invitación a
  crearlo.
