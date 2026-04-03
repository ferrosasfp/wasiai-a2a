# Adversarial Review — WKH-7: Supabase Registries

**Fecha:** 2026-04-02  
**Revisor:** Adversary (NexusAgile AR)  
**Branch:** `feat/wkh-7-supabase-registries`  
**Commit HEAD:** `9f31db0 feat(wkh-7): wave 4 — build pass, tsc clean`

> **Nota de proceso:** El branch contiene commits de WKH-6 y WKH-7 mezclados (Dev trabajó en el mismo worktree). Esto es un problema de proceso que debe corregirse en sprints futuros (branches separados por WKH). No es bloqueante para este AR — se evalúa únicamente el código de WKH-7.

---

## Veredicto Final

# ✅ AR_PASS

---

## Resultados por Categoría

### 1. Seguridad — OK ✅

| Check | Resultado |
|-------|-----------|
| `auth.value` nunca se loguea | ✅ OK — `registry.ts` tiene comentario explícito, y en `discovery.ts` solo se loguea `err.message`, nunca `registry.auth` |
| Usa `SUPABASE_SERVICE_KEY` (no ANON_KEY) | ✅ OK — `supabase.ts` lee `process.env.SUPABASE_SERVICE_KEY` |
| Auth values en headers (no en URL/logs) | ✅ OK — headers construidos en memoria, nunca serializados |

**Sin hallazgos de seguridad.**

---

### 2. Lógica — OK con menor ⚠️

| Check | Resultado |
|-------|-----------|
| Todos los métodos de `registryService` son `async` | ✅ OK — `list`, `get`, `register`, `update`, `delete`, `getEnabled` todos `async` |
| Guard `'wasiai'` en delete | ✅ OK — `if (id === 'wasiai') throw new Error('Cannot delete the WasiAI registry')` |
| ID generado como slug de name | ✅ OK — `config.name.toLowerCase().replace(/\s+/g, '-')` |

**MENOR:** El slugify solo reemplaza espacios (`\s+`). Caracteres especiales (acentos, `/`, `&`, etc.) en un nombre de registry quedarían sin normalizar, produciendo IDs potencialmente conflictivos o inválidos. No bloquea el MVP, pero debería usarse una función de slugify más robusta (ej. `name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()`).

---

### 3. Errores — OK ✅

| Check | Resultado |
|-------|-----------|
| `23505` para PK duplicate en `register()` | ✅ OK — manejado explícitamente |
| `PGRST116` para not-found en `update()` | ✅ OK — manejado explícitamente |
| `delete()` detecta not-found sin PGRST116 | ✅ OK — usa `data.length === 0` (Supabase retorna array vacío, no error) |
| Todos los `throw` usan `new Error(...)` | ✅ OK |

---

### 4. TypeScript — OK con menor ⚠️

| Check | Resultado |
|-------|-----------|
| `RegistryRow` tipado como `interface` | ✅ OK |
| `rowToRegistry` mapea todos los campos | ✅ OK — todos los campos cubiertos incluyendo opcionales con `?? undefined` |
| `any` implícito | ✅ OK — sin `any` implícito |
| Body del PATCH tipado como `Record<string, unknown>` | ⚠️ MENOR |

**MENOR:** En `registries.ts`, el handler `PATCH /:id` tipea el body como `Record<string, unknown>` y lo pasa directamente a `registryService.update(id, body)`. `update()` acepta `Partial<RegistryConfig>` e ignora campos desconocidos silenciosamente (la implementación hace mapping manual), pero la type annotation en la ruta no refleja el contrato real. El `tsc` pasa porque la asignación es estructuralmente compatible, pero el tipo debería ser `Partial<Omit<RegistryConfig, 'id' | 'createdAt'>>` para mayor precisión. No es bloqueante.

---

### 5. ESM/Build — OK ✅

| Check | Resultado |
|-------|-----------|
| Imports con extensión `.js` | ✅ OK — `'../lib/supabase.js'`, `'../services/registry.js'`, `'../types/index.js'`, `'./registry.js'` |
| `@supabase/supabase-js` en `dependencies` (no devDependencies) | ✅ OK — `"@supabase/supabase-js": "^2.101.1"` en `dependencies` |
| `"type": "module"` en package.json | ✅ OK |
| Build limpio (wave 4 confirma `tsc clean`) | ✅ OK |

---

### 6. Supabase — OK ✅

| Check | Resultado |
|-------|-----------|
| Singleton correcto | ✅ OK — `export const supabase = createSupabaseClient()` ejecutado una vez al importar |
| `process.exit(1)` si faltan env vars | ✅ OK — con mensaje descriptivo de las variables faltantes |
| `maybeSingle()` en `get()` (no `single()`) | ✅ OK — evita el error PGRST116 cuando no existe el registro |
| `persistSession: false`, `autoRefreshToken: false` | ✅ OK — correcto para uso server-side |

---

### 7. Scope — OK ✅

| Check | Resultado |
|-------|-----------|
| `discovery.ts` tiene `await` en todas las llamadas a `registryService` | ✅ OK — auto-blindaje Wave 3 corrigió las 4 llamadas faltantes |
| Cambios fuera de scope de WKH-7 | ✅ OK — los commits de WKH-6 son independientes, no tocan los archivos de WKH-7 |

---

### 8. Migración — OK ✅

| Check | Resultado |
|-------|-----------|
| `CREATE TABLE IF NOT EXISTS` | ✅ OK |
| `CREATE INDEX IF NOT EXISTS` | ✅ OK |
| Seed WasiAI con `ON CONFLICT (id) DO NOTHING` | ✅ OK — idempotente |
| Índice en `enabled` | ✅ OK — índice parcial `WHERE enabled = true` (óptimo para `getEnabled()`) |
| `auth.value` no hardcodeado en seed | ✅ OK — el seed solo incluye `{"type": "header", "key": "x-agent-key"}` sin value, con comentario indicando configurar manualmente |

---

## Resumen de Hallazgos

| # | Categoría | Severidad | Descripción |
|---|-----------|-----------|-------------|
| 1 | Lógica | MENOR | Slugify básico — solo reemplaza espacios, no normaliza caracteres especiales |
| 2 | TypeScript | MENOR | Body del PATCH tipado como `Record<string, unknown>` en lugar de `Partial<Omit<RegistryConfig, 'id' \| 'createdAt'>>` |

**Total bloqueantes: 0**  
**Total menores: 2**  
**Total OK: 6 categorías sin observaciones**

---

## Decisión

Los 2 hallazgos menores no comprometen seguridad, correctitud ni compilación. El código cumple todos los criterios del SDD. El auto-blindaje fue efectivo — el Dev detectó y corrigió el problema de los `await` faltantes antes de este AR.

**Recomendación:** Merge autorizado. Los menores pueden resolverse en el hardening post-hackathon.
