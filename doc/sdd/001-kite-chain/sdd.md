# SDD — WKH-5: Kite Chain — Conexión Ozone Testnet

**Versión:** 1.0  
**Autor:** Architect (NexusAgile F2)  
**Fecha:** 2026-04-01  
**Branch:** `feat/wkh-5-kite-chain`  
**Estado:** SPEC_APPROVED_PENDING

---

## 1. Context Map

### Qué existe hoy

```
src/
├── index.ts                  # Hono app, serve(), banner, no Kite
├── routes/                   # registries, discover, compose, orchestrate — sin cambios
├── services/
│   ├── registry.ts           # Patrón exemplar: export const registryService = { ... }
│   ├── discovery.ts
│   ├── compose.ts
│   └── orchestrate.ts
└── types/
    └── index.ts              # PaymentConfig ya definido (network: 'kite-testnet' | 'kite-mainnet')
```

**Dependencias actuales:** Hono 4, @hono/node-server, Vitest.  
**Dependencia pendiente:** `viem` — NO instalado. Esta HU lo instala.

### Qué añade esta HU (WKH-5)

```
src/
├── lib/
│   └── kite-chain.ts         # NEW: defineChain para KiteAI Testnet (chain ID 2368)
├── services/
│   ├── kite-client.ts        # NEW: singleton PublicClient + requireKiteClient()
│   └── kite-client.test.ts   # NEW: tests Vitest cubriendo los 6 ACs
└── index.ts                  # MODIFIED: import kite-client + log en banner
```

Adicionalmente:
- `package.json` — se añade `viem` como dependency (no devDependency)
- `.env.example` — se añade `KITE_RPC_URL`

### Qué NO toca esta HU

- `src/routes/*` — sin cambios
- `src/services/registry.ts`, `discovery.ts`, `compose.ts`, `orchestrate.ts` — sin cambios
- `src/types/index.ts` — **no se necesitan tipos nuevos** (ver sección 3.4)
- `tsconfig.json` — ya soporta `module: ESNext` (top-level await funciona)
- `doc/spikes/kite-ozone.md` — solo lectura, no modificar

### Posición en el roadmap Kite

```
WKH-5 (esta HU) → PublicClient + chain definition
  ↓
WKH-6 → WalletClient + identidad (kite/identity.ts) — depende de WKH-5
  ↓
WKH-7+ → x402 payment flows — depende de WKH-6
```

---

## 2. Decisiones de Diseño (ADRs)

### ADR-1: PublicClient only (no WalletClient)

| | |
|---|---|
| **Decisión** | Solo `createPublicClient` en esta HU. |
| **Alternativa descartada** | Crear también `WalletClient` con cuenta firmante. |
| **Razón** | Principio de mínima responsabilidad. El WalletClient necesita clave privada (`KITE_PRIVATE_KEY`), lógica de identidad, y manejo seguro de secretos — todo eso es responsabilidad de WKH-6. Esta HU solo prueba que el nodo es alcanzable y devuelve chain ID correcto. |

### ADR-2: Top-level await para inicialización

| | |
|---|---|
| **Decisión** | `export const kiteClient = await initKiteClient()` — top-level await en el módulo. |
| **Alternativa descartada A** | Lazy init con getter: `getKiteClient()` que inicializa en el primer uso. |
| **Alternativa descartada B** | Callback / event emitter al arranque. |
| **Razón** | `tsconfig.json` ya tiene `"module": "ESNext"` y `"target": "ES2022"` — top-level await es nativo. El patrón de `registry.ts` inicializa en cuerpo del módulo. La alternativa lazy complica la detección de errores en arranque y dificulta el testeo determinista. Al importar `kite-client.ts` desde `index.ts`, el await se resuelve antes de que `serve()` arranque el servidor — garantizando AC-3 y AC-4 en el orden correcto. |

### ADR-3: Singleton por módulo (no clase, no factory)

| | |
|---|---|
| **Decisión** | `export const kiteClient: PublicClient | null` — named export directo del singleton. |
| **Alternativa descartada** | Clase `KiteClientService` con constructor o método `getInstance()`. |
| **Razón** | Consistencia con `registryService` (exemplar del codebase). El módulo ES actúa como singleton natural: todos los importadores reciben la misma instancia (AC-2). Sin clases, sin `new`, sin factories — patrón establecido en el proyecto. |

### ADR-4: requireKiteClient() helper

| | |
|---|---|
| **Decisión** | Exportar `requireKiteClient(): PublicClient` que lanza `Error` si `kiteClient` es `null`. |
| **Alternativa descartada** | Que cada consumidor haga `if (!kiteClient) throw ...` inline. |
| **Razón** | DRY. Centraliza el mensaje de error. Futuros servicios (WKH-6+) usan `requireKiteClient()` sin escribir la guarda manualmente. El error message incluye la env var para diagnóstico inmediato. |

### ADR-5: KITE_RPC_URL leído en cuerpo del módulo (process.env)

| | |
|---|---|
| **Decisión** | `initKiteClient()` recibe `rpcUrl: string | undefined = process.env.KITE_RPC_URL` como parámetro con default. |
| **Razón** | Permite mockear en tests sin modificar `process.env` (Vitest puede inyectar el valor directamente). El valor por defecto viene de `process.env` en producción. Ver sección 3.2 para la firma exacta. |

---

## 3. Diseño Técnico

### 3.1 src/lib/kite-chain.ts

```typescript
/**
 * KiteAI Testnet ("Ozone") — Chain Definition
 *
 * Fuente: Spike WKH-19 + docs.gokite.ai
 * Chain ID: 2368
 * "Ozone" es el nombre de campaña; la red oficial es "KiteAI Testnet".
 * No existe definición oficial en viem/chains — se usa defineChain.
 */
import { defineChain } from 'viem'

export const kiteTestnet = defineChain({
  id: 2368,
  name: 'KiteAI Testnet',
  nativeCurrency: {
    decimals: 18,
    name: 'KITE',
    symbol: 'KITE',
  },
  rpcUrls: {
    default: {
      http: ['https://rpc-testnet.gokite.ai/'],
    },
    public: {
      http: ['https://rpc-testnet.gokite.ai/'],
    },
  },
  blockExplorers: {
    default: {
      name: 'KiteScan',
      url: 'https://testnet.kitescan.ai',
    },
  },
  testnet: true,
})
```

### 3.2 src/services/kite-client.ts

```typescript
/**
 * Kite Client — Singleton PublicClient para KiteAI Testnet
 *
 * Patrón: mismo que registryService — named export, singleton por módulo ES.
 * Top-level await: requiere "module": "ESNext" (ya en tsconfig).
 *
 * Exports:
 *   kiteClient         — PublicClient | null (null si KITE_RPC_URL no está configurado)
 *   requireKiteClient  — () => PublicClient (lanza si kiteClient es null)
 */
import { createPublicClient, http } from 'viem'
import type { PublicClient } from 'viem'
import { kiteTestnet } from '../lib/kite-chain'

/**
 * Inicializa el PublicClient.
 * @param rpcUrl - RPC URL. Parametrizado para facilitar el testeo con vi.mock.
 */
async function initKiteClient(
  rpcUrl: string | undefined = process.env.KITE_RPC_URL
): Promise<PublicClient | null> {
  if (!rpcUrl) {
    console.warn('KITE_RPC_URL not set — Kite features disabled')
    return null
  }

  try {
    const client = createPublicClient({
      chain: kiteTestnet,
      transport: http(rpcUrl),
    })

    const chainId = await client.getChainId()
    console.log(`Kite Ozone Testnet connected | chainId: ${chainId}`)
    return client
  } catch (err) {
    console.error('Kite client init failed:', err)
    return null
  }
}

export const kiteClient: PublicClient | null = await initKiteClient()

/**
 * Obtiene el kiteClient o lanza un error descriptivo.
 * Usar en cualquier servicio que requiera conexión activa a Kite.
 */
export function requireKiteClient(): PublicClient {
  if (!kiteClient) {
    throw new Error(
      'Kite client not initialized. Check KITE_RPC_URL env var.'
    )
  }
  return kiteClient
}
```

**Imports de viem verificados para viem v2:**
- `createPublicClient` — exportado desde `'viem'` ✅
- `http` — exportado desde `'viem'` ✅
- `PublicClient` (tipo) — exportado desde `'viem'` ✅
- `defineChain` (en kite-chain.ts) — exportado desde `'viem'` ✅

### 3.3 Modificación src/index.ts

**Añadir este import** al bloque de imports existente (después de los route imports):

```typescript
// Kite: importar dispara la inicialización (top-level await en el módulo)
import { kiteClient } from './services/kite-client'
```

**Modificar el bloque `console.log`** para añadir el estado de Kite al banner:

Reemplazar la línea actual:
```typescript
║   Server running on http://localhost:${port}                  ║
```

Por:
```typescript
║   Server running on http://localhost:${port}                  ║
║   Kite: ${kiteClient ? `connected (chainId: 2368)` : 'disabled (KITE_RPC_URL not set)'}${' '.repeat(kiteClient ? 16 : 8)}║
```

> **Nota de implementación:** El padding del banner puede ajustarse para que quede alineado visualmente. Lo importante es que el estado de Kite aparezca en el banner. El Dev puede ajustar el formato ASCII sin cambiar la lógica.

**Diff completo de src/index.ts** (solo las líneas que cambian):

```diff
  import orchestrateRoutes from './routes/orchestrate'
+ 
+ // Kite: importar dispara la inicialización (top-level await en el módulo)
+ import { kiteClient } from './services/kite-client'

  const app = new Hono()
```

```diff
  ║   Server running on http://localhost:${port}                  ║
  ║                                                           ║
+ ║   Kite: ${kiteClient ? 'connected (chainId: 2368)     ' : 'disabled (KITE_RPC_URL not set)'}║
+ ║                                                           ║
  ║   Endpoints:                                              ║
```

### 3.4 Modificación src/types/index.ts

**No se requieren cambios.**

Verificación realizada:
- `PaymentConfig` ya existe en `src/types/index.ts` con `network: 'kite-testnet' | 'kite-mainnet'` — cubre el tipado de red Kite.
- `KiteClientConfig` no es necesario: `kite-client.ts` recibe `rpcUrl: string | undefined` directamente — no hay config object.
- No añadir tipos por añadir. Si WKH-6 necesita tipos adicionales, los añade esa HU.

### 3.5 src/services/kite-client.test.ts

```typescript
/**
 * Tests para kite-client.ts — WKH-5
 * Cubre los 6 ACs de la HU.
 *
 * Estrategia: vi.mock intercepta 'viem' para que createPublicClient
 * retorne un cliente mockeado sin llamadas RPC reales.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ──────────────────────────────────────────────────────────────
// Mock de viem — debe estar ANTES del import del módulo bajo test
// ──────────────────────────────────────────────────────────────
const mockGetChainId = vi.fn()

vi.mock('viem', () => ({
  createPublicClient: vi.fn(() => ({
    getChainId: mockGetChainId,
  })),
  http: vi.fn((url: string) => ({ type: 'http', url })),
  defineChain: vi.fn((chain: unknown) => chain),
}))

// ──────────────────────────────────────────────────────────────
// Helper para reimportar el módulo con env vars controladas.
// Necesario porque kite-client.ts usa top-level await —
// el módulo se evalúa una vez por import en el contexto del test.
// Usamos importActual + resetModules para controlar el estado.
// ──────────────────────────────────────────────────────────────

async function importKiteClient(rpcUrl: string | undefined) {
  // Reimportar desde cero para que top-level await se re-ejecute
  vi.resetModules()

  // Re-mock viem después del resetModules
  vi.mock('viem', () => ({
    createPublicClient: vi.fn(() => ({
      getChainId: mockGetChainId,
    })),
    http: vi.fn((url: string) => ({ type: 'http', url })),
    defineChain: vi.fn((chain: unknown) => chain),
  }))

  // Setear la variable de entorno antes de importar
  if (rpcUrl !== undefined) {
    process.env.KITE_RPC_URL = rpcUrl
  } else {
    delete process.env.KITE_RPC_URL
  }

  return import('./kite-client')
}

// ──────────────────────────────────────────────────────────────

describe('kite-client', () => {
  const ORIGINAL_ENV = process.env.KITE_RPC_URL

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    // Restaurar env var original
    if (ORIGINAL_ENV !== undefined) {
      process.env.KITE_RPC_URL = ORIGINAL_ENV
    } else {
      delete process.env.KITE_RPC_URL
    }
    vi.restoreAllMocks()
  })

  // ────────────────────────────────────────────────────────────
  // AC-1: Al arrancar, kiteClient se inicializa automáticamente
  // ────────────────────────────────────────────────────────────
  it('AC-1: inicializa kiteClient automáticamente al importar el módulo', async () => {
    mockGetChainId.mockResolvedValue(2368)

    const { kiteClient } = await importKiteClient('https://rpc-testnet.gokite.ai/')

    expect(kiteClient).not.toBeNull()
  })

  // ────────────────────────────────────────────────────────────
  // AC-2: Singleton — misma instancia para todos los importadores
  // ────────────────────────────────────────────────────────────
  it('AC-2: exporta el mismo singleton en importaciones múltiples', async () => {
    mockGetChainId.mockResolvedValue(2368)

    const mod1 = await importKiteClient('https://rpc-testnet.gokite.ai/')
    // Segunda importación — el módulo ya está en caché, misma instancia
    const mod2 = await import('./kite-client')

    expect(mod1.kiteClient).toBe(mod2.kiteClient)
  })

  // ────────────────────────────────────────────────────────────
  // AC-3: Log correcto al conectar exitosamente
  // ────────────────────────────────────────────────────────────
  it('AC-3: loguea "Kite Ozone Testnet connected | chainId: 2368" cuando conecta', async () => {
    mockGetChainId.mockResolvedValue(2368)

    await importKiteClient('https://rpc-testnet.gokite.ai/')

    expect(console.log).toHaveBeenCalledWith(
      'Kite Ozone Testnet connected | chainId: 2368'
    )
  })

  // ────────────────────────────────────────────────────────────
  // AC-4: kiteClient es null y warn cuando KITE_RPC_URL no está
  // ────────────────────────────────────────────────────────────
  it('AC-4: kiteClient es null y loguea warning cuando KITE_RPC_URL no está configurado', async () => {
    const { kiteClient } = await importKiteClient(undefined)

    expect(kiteClient).toBeNull()
    expect(console.warn).toHaveBeenCalledWith(
      'KITE_RPC_URL not set — Kite features disabled'
    )
  })

  // ────────────────────────────────────────────────────────────
  // AC-5: Fallo de conexión — kiteClient es null, no crashea
  // ────────────────────────────────────────────────────────────
  it('AC-5: cuando la conexión RPC falla, kiteClient es null y loguea el error sin crashear', async () => {
    const rpcError = new Error('connection refused')
    mockGetChainId.mockRejectedValue(rpcError)

    const { kiteClient } = await importKiteClient('https://rpc-testnet.gokite.ai/')

    expect(kiteClient).toBeNull()
    expect(console.error).toHaveBeenCalledWith(
      'Kite client init failed:',
      rpcError
    )
  })

  // ────────────────────────────────────────────────────────────
  // AC-6: getChainId retorna 2368
  // ────────────────────────────────────────────────────────────
  it('AC-6: kiteClient.getChainId() retorna 2368', async () => {
    mockGetChainId.mockResolvedValue(2368)

    const { kiteClient } = await importKiteClient('https://rpc-testnet.gokite.ai/')

    expect(kiteClient).not.toBeNull()
    const chainId = await kiteClient!.getChainId()
    expect(chainId).toBe(2368)
    expect(typeof chainId).toBe('number')
  })

  // ────────────────────────────────────────────────────────────
  // requireKiteClient — happy path
  // ────────────────────────────────────────────────────────────
  it('requireKiteClient() retorna el cliente cuando está inicializado', async () => {
    mockGetChainId.mockResolvedValue(2368)

    const { requireKiteClient } = await importKiteClient('https://rpc-testnet.gokite.ai/')

    expect(() => requireKiteClient()).not.toThrow()
    const client = requireKiteClient()
    expect(client).not.toBeNull()
  })

  // ────────────────────────────────────────────────────────────
  // requireKiteClient — error cuando kiteClient es null
  // ────────────────────────────────────────────────────────────
  it('requireKiteClient() lanza Error cuando kiteClient es null', async () => {
    const { requireKiteClient } = await importKiteClient(undefined)

    expect(() => requireKiteClient()).toThrow(
      'Kite client not initialized. Check KITE_RPC_URL env var.'
    )
  })
})
```

### 3.6 .env.example

El archivo `.env.example` **no existe** en el repo — hay que crearlo desde cero:

```bash
# WasiAI A2A Protocol — Environment Variables
# Copiar a .env y completar con valores reales

# ─────────────────────────────────────────────────────────────
# Kite Chain — KiteAI Testnet (Ozone, Chain ID: 2368)
# Obtener KITE tokens de test: https://faucet.gokite.ai
# Explorer: https://testnet.kitescan.ai
# ─────────────────────────────────────────────────────────────
KITE_RPC_URL=https://rpc-testnet.gokite.ai/

# Puerto del servidor (default: 3001)
PORT=3001
```

También crear `.gitignore` entry si no existe (verificar que `.env` está en `.gitignore` para no commitear secretos).

---

## 4. Waves de implementación

### Wave 0 — Preparar package.json + instalar viem

**Paso 1:** El `package.json` actual no tiene `"type": "module"`. El top-level await y los ES modules requieren que Node lo sepa. Añadir antes de instalar:

```json
// package.json — añadir esta línea al nivel raíz
"type": "module",
```

**Paso 2:** Instalar viem:

```bash
npm install viem
```

Verificar que se añade a `dependencies` (no `devDependencies`) en `package.json`. viem es una dependency de runtime.

**Verificar versión instalada:** debe ser `^2.x`. El SDD asume viem v2 API.

```bash
npm ls viem
```

**Paso 3:** Verificar que `tsx` sigue funcionando con ESM:

```bash
npm run dev
# Debe arrancar sin errores de módulo
```

### Wave 1 — src/lib/kite-chain.ts

Crear el archivo completo desde la sección 3.1. Sin dependencias externas más allá de `viem`.

**Verificación rápida:**
```bash
npx tsx -e "import { kiteTestnet } from './src/lib/kite-chain'; console.log(kiteTestnet.id)"
# Debe imprimir: 2368
```

### Wave 2 — src/services/kite-client.ts

Crear el archivo completo desde la sección 3.2. Depende de Wave 1 y Wave 0.

**Verificación rápida (requiere KITE_RPC_URL configurado):**
```bash
KITE_RPC_URL=https://rpc-testnet.gokite.ai/ npx tsx -e "
  import { kiteClient } from './src/services/kite-client';
  console.log('client:', kiteClient ? 'OK' : 'null');
"
```

### Wave 3 — Modificaciones src/index.ts

Aplicar el diff de la sección 3.3. Depende de Wave 2.

**Verificación:** `npm run dev` debe arrancar sin errores y mostrar el estado de Kite en el banner.

### Wave 4 — src/services/kite-client.test.ts

Crear el archivo completo desde la sección 3.5. Depende de Wave 2 (no de Wave 3).

**Ejecutar tests:**
```bash
npm test
```

Todos los tests deben pasar. No deben hacer llamadas HTTP reales.

### Wave 5 — .env.example

Añadir las líneas de la sección 3.6. Sin dependencias. Puede hacerse en cualquier momento.

---

## 5. Constraint Directives (prohibiciones explícitas para el Dev)

1. **NO crear WalletClient** — es responsabilidad de WKH-6 (`src/services/kite/identity.ts`). Esta HU solo crea `PublicClient` (read-only).

2. **NO modificar ningún route** (`src/routes/*`) — esta HU no añade endpoints HTTP.

3. **NO modificar servicios existentes** (`registry.ts`, `discovery.ts`, `compose.ts`, `orchestrate.ts`) — sin cambios en servicios existentes.

4. **NO usar `process.env.KITE_RPC_URL` directamente dentro del cuerpo de `initKiteClient()`** — la función recibe el valor como parámetro con default `= process.env.KITE_RPC_URL`. Esto permite testeo sin manipular process.env globalmente.

5. **NO instalar viem como devDependency** — es dependency de runtime. Usar `npm install viem` (sin `-D`).

6b. **AÑADIR `"type": "module"` al package.json** antes de Wave 1 — sin esto Node no resuelve ESM imports ni top-level await en runtime. tsx lo maneja en dev, pero el build y los tests de vitest lo requieren.

6. **NO añadir tipos a `src/types/index.ts`** en esta HU — no son necesarios. `PaymentConfig` ya existe. Si WKH-6 necesita tipos, los añade WKH-6.

7. **NO hacer llamadas RPC reales en tests** — todos los tests mockean `viem` con `vi.mock`. Tests que hacen llamadas de red son frágiles en CI.

8. **NO modificar `tsconfig.json`** — la configuración existente (`module: ESNext`, `target: ES2022`) ya soporta top-level await. No cambiar nada.

9. **NO añadir lógica de reintentos o fallback de RPC** en esta HU — si el RPC falla, `kiteClient` queda `null` y se loguea el error. Reintentos/fallback son scope de una HU futura.

10. **NO crear `src/lib/kite-chain.ts` dentro de `src/services/`** — va en `src/lib/` por ser una definición reutilizable (no un service con estado).

11. **NO exportar `initKiteClient` como función pública** — es una función privada del módulo. Solo se exportan `kiteClient` y `requireKiteClient`.

---

## 6. Readiness Check

**¿El SDD es suficiente para que el Dev implemente sin preguntar nada?**

**Sí.**

Evidencia:

| Punto | Estado |
|-------|--------|
| Chain ID, RPC URL, chain definition completa | ✅ Sección 3.1, código copiable |
| Imports exactos de viem v2 verificados | ✅ Sección 3.2, nota de verificación explícita |
| Código completo de kite-client.ts | ✅ Sección 3.2, listo para copiar |
| Diff exacto de index.ts | ✅ Sección 3.3, líneas específicas |
| Decisión sobre types/index.ts | ✅ Sección 3.4, explica por qué no se toca |
| Tests completos con mocks | ✅ Sección 3.5, cubre los 6 ACs + requireKiteClient |
| .env.example (crear desde cero) | ✅ Sección 3.6, contenido completo |
| `"type": "module"` en package.json | ✅ Wave 0, paso obligatorio antes de todo |
| .gitignore — .env ya excluido | ✅ Verificado, no tocar |
| Orden de implementación | ✅ Sección 4, Wave 0-5 con comandos de verificación |
| Prohibiciones explícitas | ✅ Sección 5, 12 constraint directives |

**Lo único que el Dev necesita saber antes de Wave 2:** tener `KITE_RPC_URL` en su `.env` local para verificación manual. El testnet es público (`https://rpc-testnet.gokite.ai/`) — no requiere API key.

---

SDD_COMPLETE_V2 — Revisado por Requirements Reviewer (2026-04-01): correcciones de package.json type:module, .env.example creación desde cero, constraint directive añadida. Listo para SPEC_APPROVED
