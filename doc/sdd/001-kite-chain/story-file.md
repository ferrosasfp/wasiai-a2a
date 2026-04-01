# Story File — WKH-5: Kite Chain — Conexión Ozone Testnet

**Branch:** `feat/wkh-5-kite-chain` | **Base:** `main`

---

## Contexto para el Dev

Esta HU establece la conexión base con KiteAI Testnet (también llamada "Ozone", chain ID 2368). Crea dos artefactos: la definición de la chain (`kite-chain.ts`) y un singleton `PublicClient` (`kite-client.ts`) que se inicializa automáticamente al arrancar el servidor. Si la variable `KITE_RPC_URL` no está configurada, el sistema arranca igual pero con Kite deshabilitado — sin crashes.

Esta es la primera HU del módulo Kite. Las HUs siguientes (WKH-6+) dependen de este `PublicClient` para firmar transacciones e implementar flujos de pago x402. No toques nada fuera de los archivos indicados: no hay endpoints nuevos, no hay cambios en rutas ni en servicios existentes.

---

## Archivos a crear/modificar

| Archivo | Operación | Descripción |
|---------|-----------|-------------|
| `package.json` | Modificar | Añadir `"type": "module"` e instalar `viem` como dependency de runtime |
| `src/lib/kite-chain.ts` | Crear | `defineChain` de KiteAI Testnet — exporta `kiteTestnet` |
| `src/services/kite-client.ts` | Crear | Singleton `PublicClient` + helper `requireKiteClient()` |
| `src/services/kite-client.test.ts` | Crear | Tests Vitest cubriendo los 6 ACs |
| `src/index.ts` | Modificar | Importar `kiteClient` + añadir estado de Kite al banner |
| `.env.example` | Crear | Añadir `KITE_RPC_URL` con comentario |

---

## Implementación — Wave por Wave

### Wave 0: Preparar package.json + instalar viem

**Paso 1 — Añadir `"type": "module"` a `package.json`:**

Abre `package.json` y añade esta línea al nivel raíz (junto a `"name"`, `"version"`, etc.):

```json
"type": "module",
```

Sin esto, Node no resuelve ESM imports ni top-level await en runtime.

**Paso 2 — Instalar viem como dependency de runtime:**

```bash
npm install viem
```

No uses `-D`. viem es una dependency de runtime, no devDependency.

**Paso 3 — Verificar instalación:**

```bash
npm ls viem
```

Debe mostrar `viem@2.x.x`. La API asumida en este Story File es viem v2.

---

### Wave 1: src/lib/kite-chain.ts

Crea el archivo `src/lib/kite-chain.ts` con este contenido exacto:

```typescript
/**
 * KiteAI Testnet ("Ozone") — Chain Definition
 *
 * Chain ID: 2368
 * No existe definición oficial en viem/chains — se usa defineChain.
 * RPC público, no requiere API key.
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

---

### Wave 2: src/services/kite-client.ts

Crea el archivo `src/services/kite-client.ts` con este contenido exacto:

```typescript
/**
 * Kite Client — Singleton PublicClient para KiteAI Testnet
 *
 * Patrón: named export, singleton por módulo ES.
 * Top-level await: requiere "module": "ESNext" (ya en tsconfig).
 *
 * Exports:
 *   kiteClient         — PublicClient | null (null si KITE_RPC_URL no está configurado)
 *   requireKiteClient  — () => PublicClient (lanza si kiteClient es null)
 */
import { createPublicClient, http } from 'viem'
import type { PublicClient } from 'viem'
import { kiteTestnet } from '../lib/kite-chain.js'

/**
 * Inicializa el PublicClient.
 * El parámetro rpcUrl permite inyectar el valor en tests sin tocar process.env globalmente.
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
 * Usa esta función en cualquier servicio que requiera conexión activa a Kite.
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

> **Nota sobre imports:** El import de `kite-chain` lleva extensión `.js` porque con `"type": "module"` en Node, los imports de TypeScript compilado requieren `.js`. Si tu setup usa tsx en dev sin compilar, y los tests fallan por la extensión, prueba sin `.js` (`'../lib/kite-chain'`). Ajusta según el comportamiento de tu entorno.

---

### Wave 3: Modificar src/index.ts

Aplica exactamente estos dos cambios en `src/index.ts`:

**Cambio 1 — Añade el import al bloque de imports** (después de los imports de routes):

```diff
  import orchestrateRoutes from './routes/orchestrate'
+
+ // Kite: importar dispara la inicialización (top-level await en el módulo)
+ import { kiteClient } from './services/kite-client.js'
```

**Cambio 2 — Añade el estado de Kite al banner de consola** (dentro del bloque `console.log` del servidor):

Localiza la línea que imprime la URL del servidor. Inmediatamente después, añade la línea de estado de Kite:

```diff
  ║   Server running on http://localhost:${port}                  ║
+ ║   Kite: ${kiteClient ? 'connected (chainId: 2368)     ' : 'disabled (KITE_RPC_URL not set)'}║
```

> **Nota sobre el padding:** El banner es ASCII art. Ajusta los espacios en la cadena para que la línea tenga el mismo ancho que las demás. El contenido lógico es lo que importa: mostrar `connected (chainId: 2368)` o `disabled (KITE_RPC_URL not set)` según el estado de `kiteClient`.

---

### Wave 4: src/services/kite-client.test.ts

Crea el archivo `src/services/kite-client.test.ts` con este contenido exacto:

```typescript
/**
 * Tests para kite-client.ts — WKH-5
 * Cubre los 6 ACs de la HU.
 *
 * Estrategia: vi.mock intercepta 'viem' para que createPublicClient
 * retorne un cliente mockeado — sin llamadas RPC reales.
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
// el módulo se evalúa una vez por import. resetModules fuerza
// re-evaluación para cada test.
// ──────────────────────────────────────────────────────────────
async function importKiteClient(rpcUrl: string | undefined) {
  vi.resetModules()

  // Re-registrar el mock de viem después del resetModules
  vi.mock('viem', () => ({
    createPublicClient: vi.fn(() => ({
      getChainId: mockGetChainId,
    })),
    http: vi.fn((url: string) => ({ type: 'http', url })),
    defineChain: vi.fn((chain: unknown) => chain),
  }))

  if (rpcUrl !== undefined) {
    process.env.KITE_RPC_URL = rpcUrl
  } else {
    delete process.env.KITE_RPC_URL
  }

  return import('./kite-client.js')
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
    if (ORIGINAL_ENV !== undefined) {
      process.env.KITE_RPC_URL = ORIGINAL_ENV
    } else {
      delete process.env.KITE_RPC_URL
    }
    vi.restoreAllMocks()
  })

  // AC-1: kiteClient se inicializa automáticamente al importar
  it('AC-1: inicializa kiteClient automáticamente al importar el módulo', async () => {
    mockGetChainId.mockResolvedValue(2368)

    const { kiteClient } = await importKiteClient('https://rpc-testnet.gokite.ai/')

    expect(kiteClient).not.toBeNull()
  })

  // AC-2: Singleton — misma instancia para todos los importadores
  it('AC-2: exporta el mismo singleton en importaciones múltiples', async () => {
    mockGetChainId.mockResolvedValue(2368)

    const mod1 = await importKiteClient('https://rpc-testnet.gokite.ai/')
    // Segunda importación usa el módulo ya cacheado — misma instancia
    const mod2 = await import('./kite-client.js')

    expect(mod1.kiteClient).toBe(mod2.kiteClient)
  })

  // AC-3: Log correcto al conectar exitosamente
  it('AC-3: loguea "Kite Ozone Testnet connected | chainId: 2368" cuando conecta', async () => {
    mockGetChainId.mockResolvedValue(2368)

    await importKiteClient('https://rpc-testnet.gokite.ai/')

    expect(console.log).toHaveBeenCalledWith(
      'Kite Ozone Testnet connected | chainId: 2368'
    )
  })

  // AC-4: kiteClient es null y warn cuando KITE_RPC_URL no está
  it('AC-4: kiteClient es null y loguea warning cuando KITE_RPC_URL no está configurado', async () => {
    const { kiteClient } = await importKiteClient(undefined)

    expect(kiteClient).toBeNull()
    expect(console.warn).toHaveBeenCalledWith(
      'KITE_RPC_URL not set — Kite features disabled'
    )
  })

  // AC-5: Fallo de conexión — kiteClient es null, no crashea el servidor
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

  // AC-6: getChainId retorna 2368
  it('AC-6: kiteClient.getChainId() retorna 2368', async () => {
    mockGetChainId.mockResolvedValue(2368)

    const { kiteClient } = await importKiteClient('https://rpc-testnet.gokite.ai/')

    expect(kiteClient).not.toBeNull()
    const chainId = await kiteClient!.getChainId()
    expect(chainId).toBe(2368)
    expect(typeof chainId).toBe('number')
  })

  // requireKiteClient — happy path
  it('requireKiteClient() retorna el cliente cuando está inicializado', async () => {
    mockGetChainId.mockResolvedValue(2368)

    const { requireKiteClient } = await importKiteClient('https://rpc-testnet.gokite.ai/')

    expect(() => requireKiteClient()).not.toThrow()
    expect(requireKiteClient()).not.toBeNull()
  })

  // requireKiteClient — error cuando kiteClient es null
  it('requireKiteClient() lanza Error cuando kiteClient es null', async () => {
    const { requireKiteClient } = await importKiteClient(undefined)

    expect(() => requireKiteClient()).toThrow(
      'Kite client not initialized. Check KITE_RPC_URL env var.'
    )
  })
})
```

---

### Wave 5: Crear .env.example

Crea el archivo `.env.example` en la raíz del proyecto con este contenido:

```bash
# WasiAI A2A Protocol — Environment Variables
# Copiar a .env y completar con valores reales

# ─────────────────────────────────────────────────────────────
# Kite Chain — KiteAI Testnet (Ozone, Chain ID: 2368)
# RPC público, no requiere API key.
# Obtener KITE tokens de test: https://faucet.gokite.ai
# Explorer: https://testnet.kitescan.ai
# ─────────────────────────────────────────────────────────────
KITE_RPC_URL=https://rpc-testnet.gokite.ai/

# Puerto del servidor (default: 3001)
PORT=3001
```

Además, verifica que `.env` está en `.gitignore`. Si no está, añade esta línea:

```
.env
```

---

## Verificación por Wave

### Wave 0
```bash
# Verificar que "type": "module" está en package.json
node -e "const p = JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log(p.type)"
# Debe imprimir: module

# Verificar viem instalado
npm ls viem
# Debe mostrar viem@2.x.x
```

### Wave 1
```bash
# Verificar chain definition
npx tsx -e "import { kiteTestnet } from './src/lib/kite-chain.js'; console.log(kiteTestnet.id)"
# Debe imprimir: 2368
```

### Wave 2
```bash
# Verificar client con KITE_RPC_URL configurado
KITE_RPC_URL=https://rpc-testnet.gokite.ai/ npx tsx -e "
  import { kiteClient } from './src/services/kite-client.js';
  console.log('client:', kiteClient ? 'OK' : 'null');
"
# Debe imprimir: Kite Ozone Testnet connected | chainId: 2368 y luego client: OK

# Verificar comportamiento sin KITE_RPC_URL
npx tsx -e "
  import { kiteClient } from './src/services/kite-client.js';
  console.log('client:', kiteClient ? 'OK' : 'null');
"
# Debe imprimir: KITE_RPC_URL not set — Kite features disabled y luego client: null
```

### Wave 3
```bash
# Arrancar el servidor y verificar el banner
KITE_RPC_URL=https://rpc-testnet.gokite.ai/ npm run dev
# Debe mostrar el banner con "Kite: connected (chainId: 2368)"

# Arrancar sin KITE_RPC_URL
npm run dev
# Debe mostrar el banner con "Kite: disabled (KITE_RPC_URL not set)"
```

### Wave 4
```bash
# Ejecutar todos los tests
npm test
# Todos los tests deben pasar. Ninguno debe hacer llamadas HTTP reales.
```

### Wave 5
```bash
# Verificar que .env.example existe y tiene KITE_RPC_URL
grep KITE_RPC_URL .env.example
# Debe mostrar la línea con la variable

# Verificar que .env está en .gitignore
grep "^\.env$" .gitignore
# Debe encontrar la línea
```

---

## Acceptance Criteria (para QA)

| # | Criterio |
|---|----------|
| AC-1 | **WHEN** el gateway arranca, **THEN** el KiteClient se inicializa automáticamente con la chain definition de Ozone Testnet (chainId 2368). |
| AC-2 | **WHEN** cualquier servicio importa `kiteClient`, **THEN** obtiene el mismo singleton (no se crea una nueva conexión). |
| AC-3 | **WHEN** la conexión a Ozone es exitosa al arrancar, **THEN** el log muestra `"Kite Ozone Testnet connected | chainId: 2368"`. |
| AC-4 | **IF** `KITE_RPC_URL` no está configurado, **THEN** el servidor arranca con la advertencia `"KITE_RPC_URL not set — Kite features disabled"` y `kiteClient` es `null`. |
| AC-5 | **IF** la conexión falla al arrancar (RPC no responde), **THEN** loguea el error completo pero **NO** crashea el servidor (`kiteClient` queda `null`). |
| AC-6 | **WHEN** se llama `await kiteClient.getChainId()`, **THEN** retorna `2368` (number). |

---

## Prohibiciones (NO hacer)

- **NO crear WalletClient** — pertenece a WKH-6. Esta HU solo crea `PublicClient` (read-only).
- **NO modificar rutas** (`src/routes/*`) — esta HU no añade endpoints HTTP.
- **NO modificar servicios existentes** — `registry.ts`, `discovery.ts`, `compose.ts`, `orchestrate.ts` no se tocan.
- **NO instalar viem como devDependency** — usar `npm install viem` sin `-D`.
- **NO acceder a `process.env.KITE_RPC_URL` directamente dentro del cuerpo de `initKiteClient()`** — la función recibe el valor como parámetro con default `= process.env.KITE_RPC_URL`. Esto permite testeo limpio.
- **NO añadir tipos a `src/types/index.ts`** — no son necesarios en esta HU.
- **NO hacer llamadas RPC reales en tests** — todos los tests mockean `viem` con `vi.mock`.
- **NO modificar `tsconfig.json`** — la configuración existente ya soporta top-level await.
- **NO añadir lógica de reintentos o fallback de RPC** — si el RPC falla, `kiteClient` queda `null`. Reintentos son scope futuro.
- **NO exportar `initKiteClient`** — es una función privada del módulo.
- **NO crear `kite-chain.ts` dentro de `src/services/`** — va en `src/lib/` (definición reutilizable, no service con estado).

---

## Definition of Done

Marca cada ítem antes de crear el PR:

- [ ] `npm ls viem` muestra `viem@2.x.x`
- [ ] `package.json` tiene `"type": "module"`
- [ ] `src/lib/kite-chain.ts` existe y `kiteTestnet.id === 2368`
- [ ] `src/services/kite-client.ts` existe con `kiteClient` y `requireKiteClient` exportados
- [ ] Con `KITE_RPC_URL` configurado: arranque loguea `"Kite Ozone Testnet connected | chainId: 2368"`
- [ ] Sin `KITE_RPC_URL`: arranque loguea warning y `kiteClient` es `null`
- [ ] Sin `KITE_RPC_URL`: el servidor NO crashea
- [ ] `npm test` — todos los tests pasan, cero fallos
- [ ] Ningún test hace llamadas HTTP reales (verificar con `--reporter=verbose`)
- [ ] `src/index.ts` muestra estado de Kite en el banner de consola
- [ ] `.env.example` creado con `KITE_RPC_URL`
- [ ] `.env` está en `.gitignore`
- [ ] Sin cambios en `src/routes/*`, servicios existentes, ni `tsconfig.json`
- [ ] Sin `WalletClient` en ningún archivo de esta HU
- [ ] Branch: `feat/wkh-5-kite-chain`, base: `main`
