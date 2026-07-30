/**
 * E2E MANUAL de devnet — la mitad del settle Solana que SÍ necesita red
 * (P1, hallazgo 6).
 *
 * ⚠️ NO CORRE EN CI Y NO DEBE CORRER EN CI. Está gateado por
 * `SOLANA_DEVNET_E2E=1`; sin esa env el `describe` entero queda SKIPPED. No hay
 * ni un `vi.mock` en este archivo a propósito: acá todo es real (RPC, keypair,
 * SPL token program). Si algún día alguien mockea algo en este archivo, deja de
 * ser un e2e y hay que borrarlo — ese fue exactamente el bug que reemplaza.
 *
 * ─── QUÉ REEMPLAZA ────────────────────────────────────────────────────────
 * El e2e viejo vivía dentro de `payment.test.ts`, que mockea `./chain.js`,
 * `@solana/spl-token` y `sendAndConfirmTransaction` a nivel módulo.
 * `vi.importActual('./payment.js')` NO desmockea las dependencias del módulo,
 * así que el "settle real en devnet" corría contra los mocks: con
 * `SOLANA_DEVNET_E2E=1` pasaba en 270 ms, offline, sin operator key y sin
 * fondos, asertando `success: true` sobre una firma inventada.
 *
 * Dos diferencias de fondo con ese test:
 *  1. **Falla ruidosamente si le faltan las envs** (el viejo hacía
 *     `process.env.SOLANA_E2E_PAYTO as string`, o sea `undefined` casteado, y se
 *     apoyaba en el mock para no explotar).
 *  2. **Verifica que el BALANCE SE MOVIÓ**, no que la promesa resolvió. Un
 *     `success: true` sin delta de balance es precisamente el falso verde que
 *     esta batería vino a eliminar.
 *
 * ─── RUNBOOK ──────────────────────────────────────────────────────────────
 * Precondiciones (una vez):
 *   1. Un keypair de operador con SOL de devnet para fees:
 *        solana-keygen new -o /tmp/wasiai-devnet-operator.json
 *        solana airdrop 2 <PUBKEY> --url devnet
 *   2. USDC de devnet (mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU) en la
 *      ATA del operador, y una ATA de destino ya creada para el payTo.
 *      Faucet: https://faucet.circle.com (Solana Devnet).
 *   3. `SOLANA_OPERATOR_PRIVATE_KEY` es el secret ed25519 de 64 bytes en BASE58
 *      (NO el JSON array de solana-keygen). Conversión:
 *        node -e "const b=require('bs58');const k=require('/tmp/wasiai-devnet-operator.json');console.log(b.default.encode(Uint8Array.from(k)))"
 *   4. **UNA BASE DE DATOS ALCANZABLE, Y QUE SEA `bdwv`.** Desde WKH-307 `settle()`
 *      arranca con el preflight del ledger durable (`ensureSolanaSchemaReady()` →
 *      `probeSettleLedger()`), que es OBLIGATORIO y fail-closed: sin él el e2e no
 *      llega nunca a la cadena, muere en `SETTLE_LEDGER_SCHEMA_UNAVAILABLE`.
 *      La migración `20260730000000_wkh307_solana_settle_intents.sql` está aplicada
 *      en **bdwv** (verificado: el probe devuelve `{ probe: 'ok' }` contra bdwv).
 *      **JAMÁS caldz** — es el archivo de mainnet, y este test mueve dinero.
 *
 * ─── EJECUCIÓN ────────────────────────────────────────────────────────────
 * ⚠️ HAY QUE USAR EL CONFIG DEDICADO `vitest.e2e.config.ts`. Con el config principal
 * este test es IMPOSIBLE de correr, y exportar `SUPABASE_URL` NO alcanza:
 * `vitest.config.ts:17-20` declara `test.env` con `SUPABASE_URL=http://localhost:54321`
 * y una service key de juguete, y **la `env` de la config de vitest GANA sobre
 * `process.env`**. O sea que el preflight pega contra un localhost donde nada escucha
 * (evidencia: `probe: 'failed' … TypeError: fetch failed`) por más que hayas exportado
 * las credenciales correctas. Ese estubeo NO se toca: es lo que impide que los ~4300
 * unit tests escriban en una base real. `vitest.e2e.config.ts` no declara `env`, así
 * que ahí sí pasan las credenciales del entorno.
 *
 *   SOLANA_DEVNET_E2E=1 \
 *   SOLANA_OPERATOR_PRIVATE_KEY=<base58-64-bytes> \
 *   SOLANA_E2E_PAYTO=<pubkey-destino-con-ATA-creada> \
 *   SOLANA_E2E_AMOUNT_ATOMIC=1 \
 *     node --env-file=.env ./node_modules/vitest/vitest.mjs run \
 *       --config vitest.e2e.config.ts
 *
 * Sobre el `--env-file`:
 *   · `.env` es la fuente recomendada del par `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`:
 *     apunta a **bdwv** y no trae ninguna variable de Solana, así que no puede
 *     contaminar la corrida.
 *   · `node --env-file=` y NO `set -a; . ./.env`: sourcear este `.env` con bash aborta
 *     (`./.env: line 38: …: command not found`) porque hay valores con caracteres que
 *     el shell interpreta.
 *   · 🚨 **NO cargues `.env.local` completo.** Trae `SOLANA_USDC_MINT_DEVNET=8yRX3f…`,
 *     que es el mint VIEJO: liquidarías con el token equivocado y el resultado no
 *     probaría nada del money-path real. El mint correcto es el default del código,
 *     `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (USDC de Circle) — o sea que lo
 *     mejor es NO setear `SOLANA_USDC_MINT_DEVNET` en absoluto.
 *
 * Qué esperar: la firma se imprime por consola; se verifica en
 *   https://explorer.solana.com/tx/<sig>?cluster=devnet
 *
 * Si la salida dice `1 skipped` NO corriste nada: falta `SOLANA_DEVNET_E2E=1`.
 *
 * Si falla:
 *   · "could not find account"        → falta la ATA (del operador o del payTo).
 *   · "insufficient funds for rent"   → falta SOL de devnet para fees.
 *   · `SETTLE_LEDGER_SCHEMA_UNAVAILABLE` con `probe_failed` → la base no
 *     respondió (¿estás corriendo con el config principal? ¿falta el `--env-file`?).
 *   · `SETTLE_LEDGER_SCHEMA_UNAVAILABLE` con `table_missing` → esa base NO
 *     tiene la migración de WKH-307. Apuntá a bdwv o aplicala.
 *   · timeout de confirmación         → devnet congestionada; reintentar. El
 *     adapter tiene self-heal (WKH-235a) y recupera la firma si SÍ confirmó.
 */

import { describe, expect, it } from 'vitest';

const E2E = process.env.SOLANA_DEVNET_E2E === '1';

describe.runIf(E2E)('Solana devnet e2e — MANUAL, red real (sin mocks)', () => {
  it('transfiere USDC de devnet de verdad: la firma confirma Y el balance del operador BAJA', async () => {
    // ── Preflight: sin esto el test no puede probar nada, así que CORTA acá con
    //    un mensaje que dice qué falta (en vez de pasar en vacío).
    const payTo = process.env.SOLANA_E2E_PAYTO;
    expect(
      process.env.SOLANA_OPERATOR_PRIVATE_KEY,
      'SOLANA_OPERATOR_PRIVATE_KEY es obligatoria para este e2e — ver el runbook del header',
    ).toBeTruthy();
    expect(
      payTo,
      'SOLANA_E2E_PAYTO es obligatoria para este e2e — ver el runbook del header',
    ).toBeTruthy();

    const amountAtomic = process.env.SOLANA_E2E_AMOUNT_ATOMIC ?? '1';

    // Imports REALES (este archivo no mockea nada).
    const { SolanaPaymentAdapter } = await import('./payment.js');
    const adapter = new SolanaPaymentAdapter();

    // ── Balance ANTES (lectura real del ATA del operador) ──────────────────
    const before = BigInt(await adapter.getOperatorSplBalance());
    expect(
      before >= BigInt(amountAtomic),
      `el operador no tiene fondos suficientes en devnet: ${before} < ${amountAtomic}`,
    ).toBe(true);

    const res = await adapter.settle({
      payTo: payTo as string,
      amountAtomic,
      intentId: `manual-e2e:${Date.now()}`,
    });

    expect(res.success).toBe(true);
    expect(typeof res.txHash).toBe('string');
    const signature = res.txHash as string;
    // eslint-disable-next-line no-console
    console.log(
      `[devnet e2e] https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    );

    // ── La firma existe ON-CHAIN y transfirió el monto al destino ──────────
    // `verify()` lee la tx del cluster y compara el delta de balance del payTo
    // contra el monto exigido. Esto es lo que distingue un settle real de un
    // `{ success: true }` inventado.
    const verified = await adapter.verify({
      signature,
      payTo: payTo as string,
      amountAtomic,
    });
    expect(verified.valid, `verify() rechazó la tx: ${verified.error}`).toBe(
      true,
    );

    // ── Y el dinero SALIÓ del operador (el delta que el mock nunca movía) ───
    const after = BigInt(await adapter.getOperatorSplBalance());
    expect(after).toBe(before - BigInt(amountAtomic));
  }, 120_000);
});
