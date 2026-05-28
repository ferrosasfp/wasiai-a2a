# Auto-Blindaje — WKH-113 [BASE-08]

Registro de errores cometidos durante la implementación (F3) y su corrección.
Cada entrada protege futuras HUs del mismo fallo.

---

## Sesión 2026-05-27 (Dev / F3)

**Sin errores durante la implementación.** Las 3 waves de código (W0 baseline,
W1 discovery, W2 compose) pasaron typecheck (`tsc -p tsconfig.build.json --noEmit`)
y `npm test` en el primer intento, sin correcciones intermedias.

Factores que evitaron errores (lecciones ya internalizadas del Story File):

- **CD-7 (no devolver ChainKey como salida)**: el Story File documentó explícitamente
  que `normalizeChainSlug('avalanche') → 'avalanche-fuji'`, por lo que la validación
  (`=== undefined`) y la normalización de salida (string legacy) se mantuvieron
  SEPARADAS desde el primer edit. No se tocó el bloque `:97-103`.
- **CD-11 (mock discovery completo)**: el nuevo `compose.chain-flow.test.ts` exportó
  `getAgent` + `discover` desde el inicio, copiando el patrón verificado de
  `compose.test.ts:29-31`. El grep post-cambio confirmó cero mocks rotos.
- **CD-8 (no-op merge)**: la condición `real.payment.chain !== agent.payment?.chain`
  garantiza no-op observable para Avalanche/Kite. Verificado con `toBe()` sobre la
  referencia del objeto payment (no solo el valor de chain) en T-CD8a/b.

> Si una HU futura toca `readPayment` o `resolveAgent`, releer el invariante CD-7
> ANTES de tocar la normalización de salida: nunca usar el retorno de
> `normalizeChainSlug` como el `chain` del `AgentPaymentSpec`.
