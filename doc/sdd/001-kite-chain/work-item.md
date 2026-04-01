# WKH-5 — Kite Chain: Conexión Ozone Testnet

**Tipo:** feature  
**Modo:** QUALITY  
**Branch:** `feat/wkh-5-kite-chain`  
**Estado:** F1_COMPLETE — pendiente HU_APPROVED

---

## Codebase Grounding (F0)

### Estructura src/

```
src/
├── index.ts                  # Entry point — Hono app, serve(), console banner
├── routes/
│   ├── registries.ts
│   ├── discover.ts
│   ├── compose.ts
│   └── orchestrate.ts
├── services/
│   ├── registry.ts
│   ├── discovery.ts
│   ├── compose.ts
│   └── orchestrate.ts
└── types/
    └── index.ts
```

### Patrones observados

| Patrón | Observación |
|--------|-------------|
| **Servicios** | Objeto exportado como `export const xyzService = { ... }` — named export, singleton inmediato (no clase, no `new`). Ejemplo: `registryService` en `src/services/registry.ts`. |
| **Inicialización** | Los singletons se inicializan en el cuerpo del módulo (e.g. `const registries = new Map()`). No hay factory function ni lazy init. |
| **Exports** | Named exports en todos los módulos. El `index.ts` usa `export default app`. |
| **Tipos** | Centralizados en `src/types/index.ts`, solo named exports de interfaces/types. |
| **Entry point** | `src/index.ts` importa servicios via routes, arranca el servidor con `serve()` de `@hono/node-server`, loguea con `console.log`. |
| **Env vars** | Acceso via `process.env.X ?? 'default'`. No hay wrapper de config centralizado aún. |
| **Módulo** | `moduleResolution: bundler`, `module: ESNext` — imports con path completo o sin extensión (tsx resuelve). |

### Stack

- **Runtime:** Node ≥ 20, TypeScript 5.4 (strict)
- **Framework HTTP:** Hono 4 + @hono/node-server
- **Testing:** Vitest
- **Build:** tsc → dist/
- **Dependencias viem:** ❌ NO instalado aún — hay que instalar `viem`

### Exemplar para KiteClient

El servicio más parecido al patrón que usaremos es `src/services/registry.ts`:
- Inicialización en cuerpo del módulo
- `export const registryService = { ... }` (named export del singleton)
- Sin clases, sin constructores

Para `kiteClient` seguiremos el mismo patrón: export const del singleton, inicializado al importar el módulo, con manejo de `null` si la env var no está.

---

## Work Item Normalizado

```
ID:     WKH-5
Título: Kite Chain — Conexión Ozone Testnet
Tipo:   feature
Modo:   QUALITY
Branch: feat/wkh-5-kite-chain
```

---

## Acceptance Criteria (EARS)

| # | Criterio |
|---|----------|
| AC-1 | **WHEN** el gateway arranca, **THEN** el KiteClient se inicializa automáticamente con la chain definition de Ozone Testnet (chainId 2368). |
| AC-2 | **WHEN** cualquier servicio importa `kiteClient`, **THEN** obtiene el mismo singleton (no se crea una nueva conexión). |
| AC-3 | **WHEN** la conexión a Ozone es exitosa al arrancar, **THEN** el log muestra `"Kite Ozone Testnet connected | chainId: 2368"`. |
| AC-4 | **IF** `KITE_RPC_URL` no está configurado, **THEN** el servidor arranca con la advertencia `"KITE_RPC_URL not set — Kite features disabled"` y `kiteClient` es `null`. |
| AC-5 | **IF** la conexión falla al arrancar (RPC no responde / chain ID incorrecto), **THEN** loguea el error completo pero **NO** crashea el servidor (`kiteClient` queda `null`). |
| AC-6 | **WHEN** se llama `await kiteClient.getChainId()`, **THEN** retorna `2368` (number). |

---

## Scope IN — Archivos a crear/modificar

### Archivos nuevos

| Archivo | Descripción |
|---------|-------------|
| `src/lib/kite-chain.ts` | `defineChain` de KiteAI Testnet (Ozone). Exporta `kiteTestnet` — la chain definition reutilizable. |
| `src/services/kite-client.ts` | Singleton `kiteClient` (viem `PublicClient` conectado a `kiteTestnet`). Exporta `kiteClient` (puede ser `null`) y el helper `requireKiteClient()` (lanza error si `kiteClient` es null). Todos los servicios que necesiten el client deben usar `requireKiteClient()` en lugar de acceder a `kiteClient` directamente. Incluye la lógica de init con logging y manejo de error. |
| `src/services/kite-client.test.ts` | Tests unitarios con Vitest: verifica que `kiteClient` no es null cuando `KITE_RPC_URL` está configurado, verifica que retorna null cuando no está, verifica que `getChainId()` retorna `2368`. |

### Archivos a modificar

| Archivo | Cambio |
|---------|--------|
| `src/index.ts` | Importar `kiteClient` del service para disparar la inicialización al arranque. Agregar log del estado de Kite en el banner de consola. |
| `src/types/index.ts` | Tipos `KiteClientConfig` (opcional, si se requiere tipado del config). Los tipos de `PaymentConfig` ya existen — verificar que no se dupliquen. |
| `package.json` | Agregar dependencia `viem` (latest). |
| `.env.example` | Añadir `KITE_RPC_URL=https://rpc-testnet.gokite.ai/` con comentario explicativo. |

---

## Scope OUT — No tocar

| Archivo | Razón |
|---------|-------|
| `src/routes/*` | No requieren cambios para esta HU. |
| `src/services/registry.ts` | Sin cambios. |
| `src/services/discovery.ts` | Sin cambios. |
| `src/services/compose.ts` | Sin cambios. |
| `src/services/orchestrate.ts` | Sin cambios. |
| `tsconfig.json` | Configuración suficiente para viem. |
| `doc/spikes/kite-ozone.md` | Spike de solo lectura, no modificar. |

---

## Dependencias

```
WKH-5
  ↑ (sin dependencias previas — primera HU del módulo Kite)
  
WKH-6  →  depende de WKH-5
  (WKH-6 puede importar kiteClient una vez que WKH-5 esté merged)
```

**Dependencia de librería externa:** `viem` — instalar como dependency (no devDependency), versión `^2.x` (latest stable).

---

## Branch

```bash
git checkout -b feat/wkh-5-kite-chain
```

Base: `main` (o la rama de integración del monorepo wasiai-a2a).

---

## Notas Técnicas de Implementación

### PublicClient vs WalletClient

Esta HU crea SOLO el `PublicClient` (read-only: queries, getChainId, getBalance). El `WalletClient` (write: firmar txs, enviar pagos) será responsabilidad de WKH-6 en `src/services/kite/identity.ts`. No añadir WalletClient en esta HU.

### Chain definition (src/lib/kite-chain.ts)

```typescript
import { defineChain } from 'viem'

export const kiteTestnet = defineChain({
  id: 2368,
  name: 'KiteAI Testnet',
  nativeCurrency: { decimals: 18, name: 'KITE', symbol: 'KITE' },
  rpcUrls: {
    default: { http: ['https://rpc-testnet.gokite.ai/'] },
    public:  { http: ['https://rpc-testnet.gokite.ai/'] },
  },
  blockExplorers: {
    default: { name: 'KiteScan', url: 'https://testnet.kitescan.ai' },
  },
  testnet: true,
})
```

> **Fuente:** Spike WKH-19. No existe definición oficial en `viem/chains`. `defineChain` es la vía correcta.

### Singleton pattern (src/services/kite-client.ts)

Seguir el patrón de `registryService` — objeto exportado directamente, inicializado al importar:

```typescript
// Pseudo-código — implementación real en F2/F3
import { createPublicClient, http } from 'viem'
import { kiteTestnet } from '../lib/kite-chain'

const rpcUrl = process.env.KITE_RPC_URL

let _client: PublicClient | null = null

async function initKiteClient() {
  if (!rpcUrl) {
    console.warn('KITE_RPC_URL not set — Kite features disabled')
    return null
  }
  try {
    const client = createPublicClient({ chain: kiteTestnet, transport: http(rpcUrl) })
    const chainId = await client.getChainId()
    console.log(`Kite Ozone Testnet connected | chainId: ${chainId}`)
    return client
  } catch (err) {
    console.error('Kite client init failed:', err)
    return null
  }
}

export const kiteClient = await initKiteClient()
```

> **Nota:** Top-level await requiere `"module": "ESNext"` — ya está en tsconfig. Verificar compatibilidad con tsx en dev.

### Helper requireKiteClient

Exportar desde `src/services/kite-client.ts`:

```typescript
export function requireKiteClient(): PublicClient {
  if (!kiteClient) throw new Error('Kite client not initialized. Check KITE_RPC_URL env var.')
  return kiteClient
}
```

Todos los servicios que necesiten `kiteClient` deben usar `requireKiteClient()` en lugar de acceder a `kiteClient` directamente. Esto garantiza un error explícito y rastreable en lugar de un fallo silencioso por `null`.

### Variable de entorno

```bash
KITE_RPC_URL=https://rpc-testnet.gokite.ai/
```

Fallback: si no está definida → `null` (no error).  
El RPC de testnet es público, pero se parametriza para permitir override (e.g. nodo local, failover).

---

## DoR Check

| Criterio | Estado |
|----------|--------|
| ACs completos y sin ambigüedad | ✅ 6 ACs definidos en formato EARS |
| Scope IN definido con archivos reales | ✅ Basado en estructura real de src/ |
| No hay [NEEDS CLARIFICATION] bloqueantes | ✅ Ninguno |
| Spike WKH-19 resuelve todos los unknowns técnicos | ✅ Chain ID, RPC URL, viem pattern — todos confirmados |

---

F1_COMPLETE_V2 — Correcciones aplicadas por Requirements Reviewer — Listo para HU_APPROVED
