import { defineConfig } from 'vitest/config'

/**
 * CONFIG DEL E2E MANUAL DE DEVNET — el único que habla con red y con base REALES.
 *
 * ── POR QUÉ EXISTE UN SEGUNDO CONFIG ───────────────────────────────────────
 *
 * `vitest.config.ts` fija `test.env` con `SUPABASE_URL=http://localhost:54321` y una
 * service key de juguete. Eso NO es un accidente y NO hay que quitarlo: es la garantía
 * de que ninguno de los ~4300 unit tests pueda tocar una base real (ni de desarrollo ni
 * de producción). Sin ese estubeo, un test que se olvide de mockear `lib/supabase.js`
 * escribe donde no debe.
 *
 * Pero la `env` de la config de vitest **GANA sobre `process.env`**. O sea que
 * `SUPABASE_URL=... npx vitest run <e2e>` NO sirve: el valor exportado se pisa. Con eso,
 * `devnet-e2e.manual.test.ts` era IMPOSIBLE de correr desde WKH-307, porque `settle()`
 * arranca con el preflight del ledger (`probeSettleLedger()` → `schema-preflight.ts`),
 * ese preflight pega contra el localhost estubeado, no hay nada escuchando, y el e2e
 * muere en `SOLANA_SETTLE_LEDGER_SCHEMA_UNAVAILABLE` sin llegar nunca a la cadena.
 * (Cuatro intentos se perdieron ahí antes de encontrarlo.)
 *
 * La solución es un config aparte, NO relajar el principal: acá NO se declara `env`, así
 * que `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` llegan tal cual desde `process.env`.
 *
 * ── QUÉ NO SE REUSA DEL CONFIG PRINCIPAL, Y POR QUÉ ────────────────────────
 *
 * No hay `mergeConfig` a propósito: lo único que este archivo necesita del principal es
 * justamente lo que tiene que NO heredar (`env`). Y los thresholds de `coverage` no
 * significan nada para un archivo suelto que se corre a mano, así que tampoco están:
 * heredarlos daría un fallo de cobertura garantizado que no habla de nada real.
 *
 * ── EJECUCIÓN ──────────────────────────────────────────────────────────────
 *
 * El runbook completo (SOL, USDC, ATAs, base de datos y formato de la clave) vive en el
 * header de `src/adapters/solana/devnet-e2e.manual.test.ts`. Comando corto:
 *
 *   SOLANA_DEVNET_E2E=1 SOLANA_OPERATOR_PRIVATE_KEY=<base58> \
 *   SOLANA_E2E_PAYTO=<pubkey> SOLANA_E2E_AMOUNT_ATOMIC=1 \
 *     node --env-file=.env ./node_modules/vitest/vitest.mjs run \
 *       --config vitest.e2e.config.ts
 *
 * ⚠️ `node --env-file=.env` y NO `set -a; . ./.env`: este `.env` tiene valores con
 * caracteres que bash interpreta, y sourcearlo aborta con
 * `./.env: line 38: ...: command not found` (medido). `--env-file` lo parsea como
 * dotenv, sin pasar por el shell. Y `.env` apunta a bdwv, que es la base correcta.
 */
export default defineConfig({
  test: {
    // SOLO el e2e manual. Este config levanta el estubeo de la base, así que ampliar
    // este glob es exactamente lo que no hay que hacer: cualquier otro test que entre
    // acá correría contra la base real que apunte `SUPABASE_URL`.
    include: ['src/adapters/solana/devnet-e2e.manual.test.ts'],
    exclude: ['dist/**', 'node_modules/**', 'packages/**'],

    // DECISIÓN: `false`, igual que el config principal.
    //
    // Qué pasa en cada caso (MEDIDO, no supuesto):
    //   · sin `SOLANA_DEVNET_E2E=1` → el `describe.runIf(E2E)` del archivo se degrada a
    //     `describe.skip`, así que el archivo SÍ colecta: vitest reporta
    //     "1 skipped" y sale 0. `passWithNoTests` no participa de ese camino.
    //   · si el path de `include` deja de matchear (un rename, un typo) → "No test files
    //     found" y con `false` eso es exit 1. Con `true` sería exit 0, o sea un verde
    //     que se lee igual que un e2e exitoso: el peor resultado posible para un
    //     comando cuyo propósito es mover dinero real.
    //
    // Se elige `false` porque el único caso donde este flag decide es el del glob roto,
    // y ahí queremos ruido. El caso "está apagado" ya se distingue solo: la salida dice
    // `skipped`, no `passed`. Si ves `1 skipped` NO corriste el e2e — te falta
    // `SOLANA_DEVNET_E2E=1`.
    passWithNoTests: false,

    // Red real + confirmación de devnet. El `it` ya declara 120s; esto evita que el
    // default de 5s del hook de vitest corte antes por su cuenta.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
})
