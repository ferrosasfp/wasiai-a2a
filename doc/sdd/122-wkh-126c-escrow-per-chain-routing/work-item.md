# Work Item — [WKH-126c] Routing de escrow POR-CADENA (fallback a treasury en cadenas sin contrato)

## Resumen

El selector de verifier en `POST /auth/deposit` (paso 5, `auth.ts:666`) usa `escrowModeEnabled()` como condición global, pero el contrato escrow es PER-CADENA (resuelto por `A2A_ESCROW_CONTRACT_<FAMILY>`). Con solo `A2A_ESCROW_CONTRACT_BASE` configurado, activar `ESCROW_MODE_ENABLED=true` causa que Kite y Avalanche (sin contrato) retornen `ESCROW_CONTRACT_NOT_CONFIGURED` → 503, rompiendo el flujo de depósito en esas cadenas. El fix introduce un helper `escrowEnabledForChain(chainKey)` que combina el flag global con la existencia del contrato para esa cadena específica, permitiendo activar Base Sepolia en escrow sin afectar Kite/Avalanche (fallback silencioso a treasury). El flag off sigue implicando treasury en todas las cadenas (cero regresión sobre AC-8 de WKH-126b).

## Sizing

- SDD_MODE: mini
- Estimación: S
- Branch sugerido: `fix/122-wkh-126c-escrow-per-chain-routing`

## Skills de dominio

- `payment-verification` — routing condicional del verifier en el paso de depósito
- `chain-adapter` — resolución de contratos por familia de cadena (resolveEscrowContract / resolveChainFamilyEnvSuffix)

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `POST /auth/deposit` se procesa para una `chainKey` cuyo `A2A_ESCROW_CONTRACT_<FAMILY>` está configurado Y `ESCROW_MODE_ENABLED=true`, THEN the system SHALL invocar `verifyEscrowDeposit` y retornar 200 con `balance` acreditado si el depósito es válido.

- **AC-2**: WHEN `POST /auth/deposit` se procesa para una `chainKey` cuyo `A2A_ESCROW_CONTRACT_<FAMILY>` NO está configurado Y `ESCROW_MODE_ENABLED=true`, THEN the system SHALL invocar `verifyDeposit` (treasury path) en lugar de `verifyEscrowDeposit`, y SHALL NOT retornar 503 con `ESCROW_CONTRACT_NOT_CONFIGURED` por ausencia de contrato.

- **AC-3**: WHILE `ESCROW_MODE_ENABLED` es `undefined`, vacío, o cualquier valor distinto de `'true'` exacto, the system SHALL invocar `verifyDeposit` (treasury) para TODAS las cadenas, independientemente de si `A2A_ESCROW_CONTRACT_<FAMILY>` está configurado o no.

- **AC-4**: WHEN `escrowEnabledForChain(chainKey)` retorna `true` y `verifyEscrowDeposit` retorna `ok: true`, THEN the system SHALL ejecutar el funding-wallet gate (`result.from` vs `callerKey.funding_wallet`) con idéntica lógica al path treasury (sin cambio de comportamiento en el gate ni en la acreditación downstream).

- **AC-5**: IF `ESCROW_MODE_ENABLED=true` Y el contrato está configurado para la cadena, THEN the system SHALL seguir respondiendo 503 ante `RPC_UNAVAILABLE` y 400 ante cualquier razón de fallo on-chain del verifier escrow (preserva CD-10 de WKH-126b).

- **AC-6**: WHEN se ejecutan los tests existentes de `auth.escrow.test.ts` (incluyendo el test AC-8 de WKH-126b que cubre flag off → treasury), THEN the system SHALL reportar todos los tests en estado PASS sin modificación de los casos existentes.

## Scope IN

- `src/routes/auth.ts` — reemplazar el selector `escrowModeEnabled()` en línea 666 por `escrowEnabledForChain(chainKey)` e implementar el helper en el mismo archivo.
- `src/adapters/escrow-verifier.ts` — exportar `resolveEscrowContract` si aún no es accesible desde `auth.ts` (ya es `export function` en línea 94, confirmar en F2 que no requiere cambio).
- `src/routes/auth.escrow.test.ts` — agregar casos de test para AC-1 (Base con contrato + flag on → escrow), AC-2 (Kite sin contrato + flag on → treasury, no 503), AC-3 (flag off → treasury en todas).

## Scope OUT

- Cambios al contrato Solidity `WasiAIEscrow.sol` (WKH-126a, ya DONE).
- Cambios a `verifyEscrowDeposit` internamente (lógica de verificación on-chain intacta).
- Cambios a `verifyDeposit` (treasury verifier intacto).
- Nuevos flags de feature adicionales ni nuevas env vars.
- Cualquier cambio al funding-wallet gate (paso 5b, `auth.ts:697-706`).
- Deploy/configuración de contratos en cadenas adicionales (Kite, Avalanche) — fuera de scope de esta HU.
- Endpoints fuera de `POST /auth/deposit`.

## Decisiones técnicas (DT-N)

- **DT-1**: El helper `escrowEnabledForChain(chainKey: ChainKey): boolean` se define como función privada en `auth.ts` (colindante con `escrowModeEnabled()`). Implementación: `return escrowModeEnabled() && resolveEscrowContract(chainKey) !== null`. Esto reutiliza las dos funciones ya existentes sin duplicar lógica y sin nuevas env vars. La verificación es synchronous (sin I/O), apta para el selector condicional en el handler.

- **DT-2**: `resolveEscrowContract` ya es exportada de `src/adapters/escrow-verifier.ts` (línea 94). El import en `auth.ts` (línea 26) ya importa desde `escrow-verifier.js`. Se agrega `resolveEscrowContract` al named import existente. Confirmar en F2 que el import actual no incluye `resolveEscrowContract` para agregarlo — si ya está importado, no cambiar nada del import.

- **DT-3**: El cambio al selector es de una línea en `auth.ts:666`: `escrowModeEnabled()` → `escrowEnabledForChain(chainKey)`. La variable `chainKey` ya existe en ese scope (resuelta en el paso 3, líneas 644-651). Cero restructuring del handler requerido.

- **DT-4**: Los tests nuevos en `auth.escrow.test.ts` deben importar y mockear `resolveEscrowContract` desde `escrow-verifier.js`. El mock actual del módulo (`vi.mock('../adapters/escrow-verifier.js', ...)`) SOLO incluye `verifyEscrowDeposit`. Hay que extenderlo para incluir `resolveEscrowContract` como vi.fn() para poder controlar per-test si el contrato está configurado o no. Alternativamente (DT-4b): si `escrowEnabledForChain` es una función privada en `auth.ts`, su comportamiento se puede controlar desde los tests seteando `process.env.A2A_ESCROW_CONTRACT_BASE` (ya que `resolveEscrowContract` lee la env var directamente). Elegir el enfoque más simple en F2; DT-4b (env var) es preferible para evitar mock sprawl.

## Constraint Directives (CD-N)

- **CD-1**: PROHIBIDO modificar la lógica del funding-wallet gate (pasos 5b, líneas 697-706 de `auth.ts`). El gate aplica igual en ambos paths y no debe condicionar por tipo de verifier.

- **CD-2**: OBLIGATORIO que el flag off (`ESCROW_MODE_ENABLED` ausente o distinto de `'true'`) siga usando `verifyDeposit` (treasury) en el 100% de las cadenas. El helper `escrowEnabledForChain` DEBE retornar `false` cuando `escrowModeEnabled()` retorna `false`, sin importar si `resolveEscrowContract` retorna un valor. (Preserva AC-8 de WKH-126b intacto.)

- **CD-3**: PROHIBIDO introducir nuevas env vars para esta HU. El routing per-chain se resuelve exclusivamente con las env vars ya existentes: `ESCROW_MODE_ENABLED` (global on/off) y `A2A_ESCROW_CONTRACT_<FAMILY>` (presencia = contrato configurado para esa cadena).

- **CD-4**: OBLIGATORIO que los tests de regresión de WKH-126b (`auth.escrow.test.ts`) sigan pasando sin modificación de casos existentes. Los casos nuevos se agregan como suites adicionales al mismo archivo.

## Missing Inputs

- Ninguno. El scope y la solución están completamente especificados. `resolveEscrowContract` ya es exported y la variable `chainKey` ya está en scope en el paso 5. No hay ambigüedad de implementación.

## Análisis de paralelismo

- Esta HU NO bloquea otras HUs activas en el backlog.
- Es un fix autónomo sobre un único handler (`POST /auth/deposit`).
- Puede mergearse en cualquier orden respecto a WKH-SEC-02 y WKH-125b (ya DONE).
- Prerequisito implícito: WKH-126b DONE (ya confirmado en `_INDEX.md`, entrada 117). WKH-126a (contrato Solidity) también DONE (entrada 121).
