# Auto-Blindaje — WKH-241 (F3)

### [2026-07-25 02:56] Fix-pack AR — README documentaba un checklist de activación Solana que el código no respalda
- **Error**: el bloque "Solana Support" del commit `76cc146` (README.md:108-155) listaba
  `SOLANA_USDC_MINT` (var inexistente), `SOLANA_ESCROW_PROGRAM_ID` (var fantasma en este repo,
  vive en el facilitator), un CAIP-2 inventado (`solana:EtgJlisy...`) y afirmaba
  "settlement is verify-only (no operator broadcast wallet)". Además OMITÍA
  `SOLANA_OPERATOR_PRIVATE_KEY` (obligatoria) y `WASIAI_A2A_CHAINS`/`WASIAI_DOWNSTREAM_X402`.
  Un founder siguiendo ese checklist habría encendido el rail sin operator keypair →
  `getSolanaOperatorKeypair()` lanza → `settleSolanaLeg` cae en `SETTLE_FAILED` → el leg
  never-throws devuelve `null` y el fee NO se liquida, en silencio.
- **Causa raíz**: la doc se escribió desde memoria/inferencia en lugar de leer las fuentes
  (`.env.example` bloque Solana líneas 774-784, `src/adapters/solana/chain.ts`,
  `src/adapters/solana/payment.ts`, `src/adapters/registry.ts`, `src/lib/downstream-payment.ts`).
  El sesgo "escrow Solana existe en el ecosistema" arrastró una var de OTRO servicio al README
  del gateway.
- **Fix**: sección reescrita contra el código: tabla de env vars con nombres exactos de
  `.env.example` + columna requerido/opcional, mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`,
  CAIP-2 `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, modelo correcto (settle-only outbound,
  operator-signed SPL transfer, idempotente por `intentId` in-proceso, sin hop al facilitator),
  aviso de que el operator necesita SOL de devnet para gas, y nota de que no hay var de escrow
  en este repo. Corregidas además 5 afirmaciones "verify-only" derivadas (headline, quality
  snapshot, diagrama de arquitectura, texto de flujo, tabla de adapter bundles: esa fila también
  ponía el SPL-USDC en la columna *inbound* cuando el rail es outbound) y el header de
  `doc/INTEGRATION.md` (listaba Solana entre las chains inbound soportadas: inbound es EVM-only,
  `getPaymentAdapter()` lanza para bundles no-EVM).
- **Aplicar en**: cualquier doc de activación/runbook de este repo. Regla: cada env var citada
  en un README se verifica con `grep -n <VAR> .env.example src/` ANTES de commitear; cada
  afirmación de modelo de settlement se verifica en el adapter concreto. Si una var no aparece
  en `src/`, no es del gateway.

### [2026-07-25 02:57] Fix-pack AR — cast `as \`0x${string}\`` engañoso en un campo namespace-agnóstico
- **Error**: `src/lib/payment-spec-reader.ts:110` hacía `contract: obj.contract as \`0x${string}\``
  cuando el guard previo (`typeof obj.contract !== 'string'` → return) ya narrowea a `string` y
  `AgentPaymentSpec.contract` es `` `0x${string}` | string `` (WKH-234). El cast sugería que el
  payTo siempre es EVM, justo en el módulo que habilita payTos base58 de Solana.
- **Causa raíz**: el cast venía copiado tal cual de `discovery.ts` (pre-WKH-234, cuando el tipo
  era EVM-only) y sobrevivió al move sin revisarse contra el tipo actual.
- **Fix**: `contract: obj.contract`. `tsc --noEmit` verde sin el cast, behavior-identical
  (3055 tests verdes, mismo conteo).
- **Aplicar en**: al mover código, revalidar cada `as` contra el tipo destino de HOY. Un `as`
  que "compila igual" puede estar documentando una invariante ya falsa.

### [2026-07-25 02:33] Wave 2 — Gate de lint (biome format) rojo por líneas largas en el test nuevo
- **Error**: `npx biome check src/` salió con 1 error de formatter en
  `src/lib/payment-spec-reader.test.ts` (una llamada `expect(...)` y un `for (const chain of [...])`
  que biome parte en varias líneas). `tsc --noEmit` y `vitest run` ya estaban verdes.
- **Causa raíz**: escribí los tests a mano sin correr el formatter de biome antes del gate;
  biome (line width 80) reformatea llamadas/arrays que superan el ancho, y `biome check`
  (sin `--write`) trata el diff de formato como ERROR de CI, no como warning.
- **Fix**: `npx biome check --write src/` + re-verificación `npx biome check src/` → 0 errores.
  Ningún cambio semántico (solo saltos de línea).
- **Aplicar en**: cualquier archivo nuevo `.ts`/`.test.ts` de este repo — correr
  `npx biome check --write src/` ANTES de declarar el gate de lint, en especial en tests con
  literales largos (arrays de slugs, objetos de fixture, `expect(...)` anidados).

### [2026-07-25 02:20] Wave 0 — Imports huérfanos al extraer una función a un módulo leaf
- **Error potencial detectado y evitado**: al mover `readPayment` de `src/services/discovery.ts`
  a `src/lib/payment-spec-reader.ts`, `discovery.ts` quedaba con dos imports sin uso
  (`normalizeChainSlug` de `../adapters/chain-resolver.js` y el tipo `AgentPaymentSpec`).
- **Causa raíz**: `tsconfig.json` NO tiene `noUnusedLocals`, así que `tsc --noEmit` pasa igual;
  el único gate que lo caza es biome (`noUnusedImports`), que corre después.
- **Fix**: grep de las 2 referencias en `discovery.ts` inmediatamente después del move y
  eliminación de ambos imports en el mismo commit.
- **Aplicar en**: toda extracción/move de funciones entre módulos de este repo — grepear el
  archivo origen por cada símbolo que la función movida usaba (no confiar en `tsc`).
