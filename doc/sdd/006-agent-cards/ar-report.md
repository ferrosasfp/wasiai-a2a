# AR Report — WKH-15 Agent Cards

> **Adversary:** San (AR) | **Fecha:** 2026-04-03 | **Branch:** `feat/wkh-15-agent-cards`

---

## Resultado: ✅ APROBADO con hallazgos menores

No hay bloqueantes. La implementación sigue el SDD fielmente. Tests pasan (29/29).

---

## Hallazgos por categoría

### 1. Seguridad — MENOR

**F1: `X-Forwarded-Proto` sin validación.** `resolveBaseUrl()` confía ciegamente en el header `X-Forwarded-Proto`. Un atacante puede enviar `X-Forwarded-Proto: ftp` y el `url` del AgentCard generado sería `ftp://host/agents/slug`. En producción detrás de un proxy bien configurado esto no es explotable, pero la función no valida que el proto sea `http` o `https`.

- **Severidad:** MENOR — el valor solo aparece en el JSON de respuesta, no se usa para redirecciones ni fetches server-side.
- **Fix sugerido:** Whitelist `['http', 'https']` en `resolveBaseUrl`.

**F2: Sin rate limiting ni validación de `slug`.** El parámetro `:slug` se pasa directo a `discoveryService.getAgent()` sin sanitización. No hay injection real porque `getAgent` hace matching contra datos en memoria/DB, pero slugs arbitrariamente largos podrían usarse para logging abuse.

- **Severidad:** MENOR — riesgo bajo, discovery ya lo maneja.

### 2. Data Integrity — MENOR

**F3: `capabilities` → `skills` mapeo lazy.** Cada capability string se usa como `id`, `name` Y `description` simultáneamente (`{ id: cap, name: cap, description: cap }`). Esto es conforme al SDD §2.2 pero produce AgentCards con skills poco informativas: `{ id: "summarize", name: "summarize", description: "summarize" }`.

- **Severidad:** MENOR — es una limitación del tipo `Agent` actual, no un bug. Documentada como decisión de diseño.

### 3. Error Handling — MENOR

**F4: Registry no encontrado devuelve mismo error que agente no encontrado.** Cuando el agente existe pero su registry config no se encuentra en `getEnabled()`, la ruta devuelve `{ error: "Agent not found" }`. El error real es "registry config not found" — un estado inconsistente entre discovery y registry. Debugging será confuso.

- **Severidad:** MENOR — edge case improbable en operación normal (implicaría un registry deshabilitado después de discovery).

### 4. Performance — MENOR

**F5: `getEnabled()` fetches todos los registries para encontrar uno.** La ruta llama `registryService.getEnabled()` y luego `.find()` por name. Si hay muchos registries, esto es ineficiente. Un `getByName(name)` sería más directo.

- **Severidad:** MENOR — en la práctica habrá pocos registries (<10). CD-7 prohíbe modificar `registryService`.

### 5. Scope Creep — ✅ OK

Implementación alineada al scope IN/OUT del work item. No se agregó nada extra.

### 6. Constraint Violations — ✅ OK

| CD | Estado |
|----|--------|
| CD-1 (no any) | ✅ |
| CD-2 (no ethers) | ✅ |
| CD-3 (no hardcode auth) | ✅ |
| CD-4 (no clases) | ✅ |
| CD-5 (ESM only) | ✅ |
| CD-6 (no persistencia) | ✅ |
| CD-7 (no modificar servicios) | ✅ |
| CD-8 (no campos v2) | ✅ |
| CD-9 (match by name) | ✅ |
| CD-10 (puerto 3001) | ✅ |
| CD-11 (resolveBaseUrl) | ✅ |
| CD-12 (default text/plain) | ✅ |

### 7. Test Coverage — MENOR

**F6: Falta test para registry-not-found path.** La ruta tiene un branch donde el agente existe pero `registries.find()` no encuentra el config → 404. Este path no tiene test de integración.

- **Severidad:** MENOR — path defensivo, pero debería testearse.
- **Fix:** Agregar test: `mockGetAgent` retorna agente, `mockGetEnabled` retorna array vacío → expect 404.

**F7: AC-5 parcialmente cubierto.** El AC dice `Kite/x402 → ["x402"]` pero la implementación no maneja x402 (devuelve `[]` para tipos no reconocidos). El SDD §2.2 documenta explícitamente que `RegistryAuth.type` no incluye `x402` aún y lo difiere. Los tests no verifican un caso x402.

- **Severidad:** MENOR — decisión consciente documentada en SDD, no un olvido.

### 8. Anti-hallucination — ✅ OK

- Todos los imports existen y son correctos.
- `discoveryService.getAgent`, `registryService.getEnabled` verificados en código real.
- Tipos `Agent`, `RegistryConfig`, `RegistryAuth` existen con los campos usados.
- Fastify plugin pattern correcto.
- No hay APIs inventadas.

---

## Resumen

| Categoría | Veredicto | Hallazgos |
|-----------|-----------|-----------|
| Seguridad | MENOR | F1, F2 |
| Data Integrity | MENOR | F3 |
| Error Handling | MENOR | F4 |
| Performance | MENOR | F5 |
| Scope Creep | OK | — |
| Constraints | OK | — |
| Test Coverage | MENOR | F6, F7 |
| Anti-hallucination | OK | — |

**Bloqueantes: 0** | **Menores: 7** | **OK: 3**

**Veredicto: ✅ APROBADO — puede avanzar. Los hallazgos menores se pueden resolver en iteración posterior o como tech debt tickets.**
