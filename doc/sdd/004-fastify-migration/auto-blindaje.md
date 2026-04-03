# Auto-Blindaje — WKH-20 Fastify Migration

## Error 1: kite-client.js import en src/index.ts

**Error:** El Story File incluye `import { kiteClient } from './services/kite-client.js'` pero `src/services/kite-client.ts` no existe en el codebase.

**Fix mínimo:** Removido el import y la línea del banner ASCII que referenciaba `kiteClient`. El servicio kite-client no existe en este codebase aún — su ausencia no forma parte del scope de WKH-20.

---

## Error 2: Type mismatch en routes/compose.ts y routes/registries.ts

**Error:** TypeScript strict rechaza:
- `input?: Record<string, unknown>` en Body no asignable a `ComposeStep.input: Record<string, unknown>` (non-optional)
- `schema: unknown` en Body no asignable a `RegistrySchema`
- `auth: unknown` en Body no asignable a `RegistryAuth | undefined`

**Causa:** Story File usa `unknown` en Body types de routes pero los services/types son más específicos.

**Fix mínimo:** Importar tipos reales (`RegistrySchema`, `RegistryAuth`, `ComposeStep`) desde `../types/index.js` y usarlos en los Body generics. No se modifica lógica de negocio.
