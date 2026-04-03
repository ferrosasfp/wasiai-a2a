# Auto-Blindaje — WKH-7: Supabase Registries

## Wave 3 — Error en Story File: ubicación incorrecta del cambio

### Problema detectado

El Story File (sección Wave 3B) dice:

> Busca en el archivo `src/routes/discover.ts` la línea:
> `const registries = registryService.getEnabled()`

Pero esa línea **NO existe** en `src/routes/discover.ts`. La ruta solo llama a `discoveryService`, no a `registryService` directamente.

Las llamadas reales a `registryService.getEnabled()` y `registryService.get()` están en `src/services/discovery.ts` (líneas 14, 15, 135, 136).

### Corrección mínima aplicada

Se modificó `src/services/discovery.ts` para agregar `await` en las 4 llamadas al servicio de registros:

1. Línea 14: `[await registryService.get(query.registry)]`
2. Línea 15: `await registryService.getEnabled()`
3. Línea 135: `[await registryService.get(registryId)]`
4. Línea 136: `await registryService.getEnabled()`

### Justificación

Sin estos `await`, TypeScript arroja errores de compilación y el discovery falla en runtime silenciosamente (recibe Promise en lugar de array). La corrección es mínima, no cambia la API pública, y resuelve los errores de compilación.

### Estado

- Fecha: 2026-04-02
- Wave: 3
- Severidad: Alta (bloquea compilación y runtime)
- Resolución: corrección mínima aplicada
