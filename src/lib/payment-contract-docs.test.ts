/**
 * CHEQUEO MECÁNICO de la semántica de `payment.contract` en la documentación viva.
 *
 * ── EL PROBLEMA QUE ESTO CIERRA ────────────────────────────────────────────────
 * `payment.contract` NO es un contrato ni un token: es la BILLETERA QUE COBRA (el
 * `payTo` del leg de salida). El nombre engaña, y no en abstracto:
 *  · produjo un bloqueante rojo FALSO (se leyó el valor como el identificador del
 *    token, "no existía", y parecía un bug de producción);
 *  · y produjo un bug REAL en la documentación pública: el ejemplo de
 *    `doc/integration-base.md` traía el address de USDC en Base mainnet dentro de
 *    `"contract"`, o sea que un publicador que copiaba el bloque apuntaba sus
 *    ingresos al contrato del token.
 *
 * El campo NO se renombra (es contrato de una respuesta pública que consumen
 * terceros), así que la defensa es que nadie vuelva a escribir un token ahí.
 *
 * ── QUÉ AFIRMA ESTE TEST ───────────────────────────────────────────────────────
 * Ningún `"contract": "<address>"` de la documentación viva es una dirección de
 * TOKEN de las que declaran los adapters. Las direcciones de token NO se hardcodean
 * acá: se derivan de `src/adapters/<chain>/payment.ts`, que es su fuente de verdad.
 *
 * Lo que este test NO cubre, dicho para que nadie lo lea de más: no puede detectar
 * un address de token que los adapters no declaren (p. ej. el mint de un token
 * Solana), ni un valor equivocado que no sea un token. La afirmación de que el
 * valor es el destinatario del transfer es CONDUCTUAL y la fija otro test:
 * `downstream-payment.test.ts:967` (`expect(signArg.to).toBe(PAYTO_ADDR)`).
 */

import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** Direcciones de TOKEN declaradas por los adapters (la fuente de verdad). */
function tokenAddresses(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of globSync('src/adapters/*/payment.ts', { cwd: REPO })) {
    const source = readFileSync(`${REPO}${file}`, 'utf8');
    const re =
      /const\s+([A-Z0-9_]*(?:USDC|TOKEN|PYUSD)[A-Z0-9_]*)\s*=\s*\n?\s*'(0x[0-9a-fA-F]{40})'/g;
    for (const m of source.matchAll(re)) {
      if (m[1] && m[2]) found.set(m[2].toLowerCase(), `${file} → ${m[1]}`);
    }
  }
  return found;
}

/** Documentación VIVA (la histórica de `doc/sdd/` y `doc/roadmap/` no se toca). */
function liveDocs(): string[] {
  return [
    'README.md',
    ...globSync('doc/*.md', { cwd: REPO }),
    ...globSync('doc/migration/*.md', { cwd: REPO }),
  ];
}

describe('`payment.contract` en la documentación', () => {
  it('los adapters declaran direcciones de token (sanity del scanner)', () => {
    // Si este scanner dejara de matchear, el test de abajo pasaría comparando
    // contra un conjunto vacío y no protegería nada.
    expect(tokenAddresses().size).toBeGreaterThan(3);
  });

  it('ningún ejemplo de `payment.contract` usa la dirección de un token', () => {
    const tokens = tokenAddresses();
    const offenders: string[] = [];
    for (const file of liveDocs()) {
      const lines = readFileSync(`${REPO}${file}`, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        for (const m of line.matchAll(/"contract"\s*:\s*"([^"]+)"/g)) {
          const value = m[1]?.toLowerCase();
          // Se ignoran las menciones en prosa que citan el error a propósito:
          // sólo interesan los valores dentro de un bloque JSON de ejemplo.
          if (value && tokens.has(value)) {
            offenders.push(
              `${file}:${idx + 1} → ${m[1]} es ${tokens.get(value)}`,
            );
          }
        }
      });
    }
    expect(
      offenders,
      '`payment.contract` es la BILLETERA QUE COBRA (el payTo), no un token: un ejemplo con la dirección de un token le dice al publicador que apunte sus ingresos al contrato del token',
    ).toEqual([]);
  });
});
