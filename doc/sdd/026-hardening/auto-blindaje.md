# Auto-Blindaje -- #026 Hardening

### [2026-04-06 21:15] Wave 1 -- FastifyError type cast through Record<string,unknown>
- **Error**: TypeScript error TS2352 -- Conversion of type 'FastifyError' to 'Record<string, unknown>' may be a mistake
- **Causa raiz**: FastifyError has a fixed set of properties, not an index signature. Direct cast to Record fails.
- **Fix**: Cast through `unknown` first: `error as unknown as { code?: string; statusCode?: number }`
- **Aplicar en**: Any Fastify error handler that needs to access non-standard properties on FastifyError

### [2026-04-06 21:16] Wave 1 -- @fastify/rate-limit v10 incompatible with Fastify 4
- **Error**: `fastify-plugin: @fastify/rate-limit - expected '5.x' fastify version, '4.29.1' is installed`
- **Causa raiz**: Story file specified `@fastify/rate-limit` without version constraint. npm installed v10 which requires Fastify 5.
- **Fix**: Pin to `@fastify/rate-limit@^9.1.0` which supports Fastify 4.x
- **Aplicar en**: Any Fastify plugin installation -- always check `fastify` peer dependency version in package.json before installing

### [2026-04-06 21:17] Wave 1 -- @fastify/rate-limit throws response object, not Error
- **Error**: Rate limit responses returned 500 instead of 429. The `errorResponseBuilder` result is thrown (not sent), and our error boundary received a plain object instead of an Error.
- **Causa raiz**: `@fastify/rate-limit` v9 line 261: `throw params.errorResponseBuilder(req, respCtx)`. The returned object IS the thrown error. If it's a plain object (not Error), Error properties like `.message` and `.statusCode` are missing.
- **Fix**: Make `errorResponseBuilder` return an actual Error object with `.statusCode`, `.code`, and `.retryAfterMs` properties set
- **Aplicar en**: Any Fastify plugin that uses errorResponseBuilder pattern -- always return Error instances, not plain objects

### [2026-04-06 21:17] Wave 1 -- errorResponseBuilderContext.statusCode missing in v9 types
- **Error**: `TS2339: Property 'statusCode' does not exist on type 'errorResponseBuilderContext'`
- **Causa raiz**: v9 types only declare `ban`, `after`, `max`, `ttl` -- but the runtime code does set `statusCode`. The types are incomplete.
- **Fix**: Derive statusCode from `context.ban ? 403 : 429` instead of accessing `context.statusCode`
- **Aplicar en**: When using @fastify/rate-limit v9 errorResponseBuilder, do not rely on undocumented type fields
