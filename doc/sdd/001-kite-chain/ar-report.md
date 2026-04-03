# AR Report — WKH-5: Kite Chain — Conexión Ozone Testnet

**Fecha:** 2026-04-01  
**Revisado por:** Adversary (NexusAgile AR)  
**Branch:** `feat/wkh-5-kite-chain`  
**Artefactos revisados:**
- `src/lib/kite-chain.ts`
- `src/services/kite-client.ts`
- `src/services/kite-client.test.ts`
- `src/index.ts`
- `package.json`
- `.env.example`

---

## Hallazgos por Categoría

---

### 1. Seguridad — ✅ OK

Sin hallazgos.

- No hay secrets hardcodeados. El único valor de `KITE_RPC_URL` en `.env.example` es el RPC público de testnet (`https://rpc-testnet.gokite.ai/`) — sin API key, sin clave privada. Correcto.
- `KITE_PRIVATE_KEY` no existe en ningún archivo. WalletClient fue correctamente excluido del scope (pertenece a WKH-6). ✅
- `process.env` no expone nada sensible. `KITE_RPC_URL` es una URL pública de testnet. ✅
- No hay vectores de inyección identificables. `rpcUrl` se pasa a `http()` de viem como string; no se concatena en SQL ni se usa en shell. ✅
- `.env` figura en `.gitignore` (línea `^\.env$` existente). ✅

---

### 2. Lógica de Negocio — ✅ OK

Sin hallazgos bloqueantes.

- Singleton inicializado correctamente vía top-level await. El patrón de módulo ES garantiza que todos los importadores reciben la misma instancia. ✅
- `requireKiteClient()` lanza el error correcto: `'Kite client not initialized. Check KITE_RPC_URL env var.'` — mensaje descriptivo con la env var para diagnóstico. ✅
- Orden de inicialización: `import { kiteClient }` en `index.ts` está **antes** de `serve()`. El top-level await del módulo se resuelve antes de que el servidor arranque, garantizando AC-3 y AC-4 en orden correcto. ✅
- `kiteClient` no puede quedar en estado inconsistente: solo puede ser `PublicClient` (válido) o `null`. No hay estado intermedio ni parcial. ✅
- `initKiteClient` recibe `rpcUrl` como parámetro con default `= process.env.KITE_RPC_URL` — permite inyección limpia en tests sin pollute global. ✅

---

### 3. Manejo de Errores — ✅ OK

Sin hallazgos.

- El bloque `try/catch` en `initKiteClient` captura fallos de `getChainId()` (AC-5). El servidor no crashea. ✅
- El error se loguea con `console.error('Kite client init failed:', err)` — completo, no silenciado. ✅
- No hay excepciones silenciosas (swallowed). Todos los paths retornan explícitamente `null` o el cliente. ✅
- La ausencia de `KITE_RPC_URL` produce `console.warn` y retorno `null` — degradación controlada. ✅

---

### 4. Tests — ⚠️ MENOR

**Hallazgo 4.1 — MENOR**

| Campo | Detalle |
|-------|---------|
| **Severidad** | MENOR |
| **Descripción** | `vi.mock` dentro de la función async `importKiteClient()` no es hoisted por Vitest. El mock top-level (fuera de la función) SÍ es hoisted. Después de `vi.resetModules()`, el mock registry de Vitest persiste (resetModules solo limpia el module cache), por lo que el mock top-level sigue activo para re-importaciones. Sin embargo, registrar `vi.mock` dentro de una función async es comportamiento dependiente de implementación interna de Vitest y puede ser frágil en versiones futuras o cambios de configuración. |
| **Archivo:línea** | `src/services/kite-client.test.ts:28-37` |
| **Corrección recomendada** | El mock dentro de `importKiteClient()` es redundante (el top-level mock persiste tras resetModules). Se puede eliminar para simplificar. Alternativamente, documentar explícitamente que la redundancia es intencional como guard de seguridad. No es un bug — funciona en Vitest 1.x. |

**Hallazgo 4.2 — MENOR**

| Campo | Detalle |
|-------|---------|
| **Severidad** | MENOR |
| **Descripción** | No se testea el caso de reconexión (restart del servidor con `kiteClient` previamente null). Por el patrón singleton de módulo ES, esto no es posible sin resetModules — lo cual está fuera del scope de WKH-5. Documentado como gap conocido para WKH-6+. |
| **Archivo:línea** | `src/services/kite-client.test.ts` — test ausente |
| **Corrección recomendada** | No corregir en WKH-5 (fuera de scope). Documentar en backlog. |

**Hallazgo 4.3 — MENOR**

| Campo | Detalle |
|-------|---------|
| **Severidad** | MENOR |
| **Descripción** | AC-2 (singleton test) es frágil en concepto. `importKiteClient()` llama `vi.resetModules()` internamente; luego `const mod2 = await import('./kite-client.js')` obtiene el módulo cacheado del ciclo anterior. El test pasa, pero depende del orden de ejecución en el mismo contexto. Si el orden de tests cambiara y otro test llamara `importKiteClient()` entre mod1 y mod2, el singleton rompería. Hoy los tests son aislados (cada uno llama `importKiteClient` antes de la segunda importación directa), pero es un patrón riesgoso. |
| **Archivo:línea** | `src/services/kite-client.test.ts:76-85` |
| **Corrección recomendada** | Aceptable para WKH-5. Documentar el orden de dependencia implícita en el comentario del test. |

---

### 5. Tipos TypeScript — ⚠️ MENOR

**Hallazgo 5.1 — MENOR**

| Campo | Detalle |
|-------|---------|
| **Severidad** | MENOR |
| **Descripción** | `createPublicClient({chain: kiteTestnet, transport: http(rpcUrl)})` en viem v2 retorna `PublicClient<HttpTransport, typeof kiteTestnet>` (tipo genérico específico). La función anota el retorno como `Promise<PublicClient \| null>` donde `PublicClient` es el tipo base (sin type params). En strictMode con TypeScript 5.4, la asignación puede generar una advertencia de tipo dependiendo de cómo viem 2.47.x exporte `PublicClient`. Si `PublicClient` tiene params con defaults, funciona sin warnings. Si no, puede requerir cast. No se pudo verificar sin ejecutar `tsc --noEmit`. |
| **Archivo:línea** | `src/services/kite-client.ts:24, 35` |
| **Corrección recomendada** | Ejecutar `npx tsc --noEmit` y verificar que no hay errores de tipo. Si los hay, anotar el retorno de `initKiteClient` con el tipo genérico específico de viem: `ReturnType<typeof createPublicClient> \| null`. |

**Hallazgo 5.2 — OK**

No hay `any` implícito. El mock de tests usa `chain: unknown` correctamente. Todos los parámetros tipados. ✅

---

### 6. Compatibilidad ESM — 🔴 BLOQUEANTE

**Hallazgo 6.1 — BLOQUEANTE**

| Campo | Detalle |
|-------|---------|
| **Severidad** | **BLOQUEANTE** |
| **Descripción** | WKH-5 añade `"type": "module"` a `package.json`. Con esto activo, `node dist/index.js` (`npm start`) requiere que todos los imports relativos tengan extensión `.js`. Sin embargo, los imports existentes en `src/index.ts` (líneas 13-16) y en los routes/services NO tienen extensión: `'./routes/registries'`, `'./routes/discover'`, `'./routes/compose'`, `'./routes/orchestrate'`, `'../services/registry'`, etc. El `tsconfig.json` usa `"moduleResolution": "bundler"` que NO añade extensiones `.js` en el output compilado. Resultado: `npm run build && npm start` falla con `ERR_MODULE_NOT_FOUND` en el primer import sin extensión. **El path de producción está roto.** El script `dev` (tsx) funciona porque tsx maneja la resolución — esto enmascara el problema en desarrollo. |
| **Archivo:línea** | `src/index.ts:13-16` (imports sin .js) + `package.json` (`"type": "module"`) |
| **Corrección recomendada** | **Opción A (preferida para producción):** Cambiar `"moduleResolution"` en `tsconfig.json` a `"node16"` o `"nodenext"` — esto fuerza que los imports relativos en source lleven extensión `.js` (TypeScript lo exigirá en compilación), y el output compilado será ESM-compatible con Node. Requiere añadir `.js` a todos los imports existentes. **Opción B (hackathon/pragmática):** Si `npm start` no está en el scope de uso (solo `npm run dev`), documentar explícitamente el limitante en README y en este AR. Pero no es aceptable para merge a `main` sin documentación explícita. **Opción C:** Cambiar `"start"` script a `tsx dist/index.ts` (impropio para producción). |

**Nota de contexto:** Esta incompatibilidad existía potencialmente antes de WKH-5 (el proyecto usaba ESM syntax sin `type: module`), pero WKH-5 lo activó explícitamente. El SDD ordenó agregar `"type": "module"` (correcto por spec), pero el SDD no anticipó que los imports existentes en el codebase carecen de extensiones. El Dev implementó lo especificado correctamente — el gap está en el SDD. Sin embargo, el resultado es un `npm start` roto, lo que impide merge responsable.

---

### 7. Scope Drift — ✅ OK

Sin hallazgos.

Archivos modificados/creados exactamente según el Story File:

| Archivo | Operación especificada | Estado |
|---------|----------------------|--------|
| `package.json` | Modificar (type:module + viem) | ✅ Correcto |
| `src/lib/kite-chain.ts` | Crear | ✅ Correcto |
| `src/services/kite-client.ts` | Crear | ✅ Correcto |
| `src/services/kite-client.test.ts` | Crear | ✅ Correcto |
| `src/index.ts` | Modificar (import + banner) | ✅ Correcto |
| `.env.example` | Crear | ✅ Correcto |

- No hay `WalletClient` en ningún archivo. ✅
- No hay cambios en `src/routes/*`. ✅
- No hay cambios en servicios existentes. ✅
- No hay cambios en `tsconfig.json`. ✅
- No hay tipos añadidos a `src/types/index.ts`. ✅
- No hay `initKiteClient` exportada. ✅

---

### 8. Producción — 🔴 BLOQUEANTE (ver Hallazgo 6.1)

**Hallazgo 8.1 — BLOQUEANTE** (derivado de Hallazgo 6.1)

| Campo | Detalle |
|-------|---------|
| **Severidad** | **BLOQUEANTE** |
| **Descripción** | `npm run build && npm start` falla. Ver Hallazgo 6.1. No se puede verificar que el código funciona en el build sin corrección. |
| **Archivo:línea** | `package.json:scripts.start` + todos los imports sin `.js` |
| **Corrección recomendada** | Ver Hallazgo 6.1. |

**Hallazgo 8.2 — MENOR**

| Campo | Detalle |
|-------|---------|
| **Severidad** | MENOR |
| **Descripción** | El banner ASCII en `index.ts` tiene desalineación. La línea de Kite: `║   Kite: connected (chainId: 2368)     ║` tiene 30 chars de contenido tras "Kite: ". La línea `║   Kite: disabled (KITE_RPC_URL not set)║` tiene 31 chars. El box tiene ancho interno de ~59 chars. Ninguna de las dos ramas está correctamente paddada al ancho del box, causando que el borde derecho `║` aparezca en columna incorrecta en la branch "disabled". |
| **Archivo:línea** | `src/index.ts:50` |
| **Corrección recomendada** | Paddear ambas strings al mismo ancho con espacios antes del `║` final. Calcular el ancho exacto del box (contar `═` en la línea `╔═══...╗`) y asegurar que ambos branches produzcan el mismo número de caracteres. Ejemplo: calcular padding dinámico con `.padEnd(N)`. |

---

## Resumen de Hallazgos

| # | Categoría | Severidad | Descripción breve |
|---|-----------|-----------|-------------------|
| 6.1 | ESM Compatibilidad | **BLOQUEANTE** | `npm start` falla: imports sin `.js` + `type: module` incompatibles con Node ESM nativo |
| 8.1 | Producción | **BLOQUEANTE** | Build no funciona en producción (derivado de 6.1) |
| 4.1 | Tests | MENOR | `vi.mock` dentro de función async es redundante y frágil a futuro |
| 4.2 | Tests | MENOR | Sin test de reconexión (gap conocido, fuera de scope) |
| 4.3 | Tests | MENOR | AC-2 (singleton) implica dependencia de orden entre tests |
| 5.1 | Tipos TypeScript | MENOR | Tipo genérico de viem v2 vs `PublicClient` base — verificar con `tsc --noEmit` |
| 8.2 | Producción | MENOR | Banner ASCII desalineado en branch "disabled" |

---

## Veredicto Global

```
AR_FAIL
```

**Razón:** 2 hallazgos BLOQUEANTES (6.1 y 8.1). `npm start` (path de producción) está roto tras agregar `"type": "module"` sin actualizar los imports de routes existentes a extensión `.js`.

**Acción requerida del Dev antes de continuar:**

Elegir una de las opciones de corrección del Hallazgo 6.1 y aplicarla. La más limpia para un proyecto que usará Node nativo en producción es cambiar `moduleResolution` a `"node16"` en `tsconfig.json` y añadir extensiones `.js` a todos los imports relativos del proyecto. Si el equipo acepta que `npm start` no se usa (solo `npm run dev`), documentarlo explícitamente en README y BACKLOG antes de merge.

Los menores pueden corregirse en la misma iteración o abrirse como issues separados.

---

*AR ejecutado por: Adversary (NexusAgile F2)*  
*Fecha: 2026-04-01*

## Correcciones Post-AR (Dev)

| # | BLOQUEANTE | Corrección aplicada | Archivos tocados |
|---|-----------|---------------------|-----------------|
| 1 | ESM imports sin extensión | Cambiado `"moduleResolution": "bundler"` → `"node16"` y `"module": "ESNext"` → `"Node16"` en tsconfig.json; añadida extensión `.js` a todos los imports relativos | tsconfig.json, src/index.ts, src/routes/compose.ts, src/routes/discover.ts, src/routes/orchestrate.ts, src/routes/registries.ts, src/services/compose.ts, src/services/discovery.ts, src/services/orchestrate.ts, src/services/registry.ts |
| 2 | npm test post-corrección | Todos los tests pasan sin modificación adicional (vitest maneja resolución independiente) — 8/8 tests ✅ | src/services/kite-client.test.ts (sin cambios necesarios) |
