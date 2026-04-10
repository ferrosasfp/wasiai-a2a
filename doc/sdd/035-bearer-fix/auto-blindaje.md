# Auto-Blindaje -- WKH-BEARER-FIX (035)

### [2026-04-06 11:33] Wave 2 -- DiscoveryResult mock missing registries field
- **Error**: TypeScript error TS2345 -- mock for `discoveryService.discover` in E2E test was missing the `registries` property required by `DiscoveryResult` interface.
- **Causa raiz**: The default mock in `setup.ts` returned `{ agents: [], total: 0 }` but the type requires `{ agents, total, registries }`. The invocationNote test also created a mock without `registries`.
- **Fix**: Added `registries: []` to the default mock in `setup.ts` and `registries: ['mock']` to the invocationNote test mock.
- **Aplicar en**: Any future E2E test that mocks `discoveryService.discover` must include the `registries` field.
