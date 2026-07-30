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
