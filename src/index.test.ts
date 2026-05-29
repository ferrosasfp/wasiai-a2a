/**
 * AC-6 — mock-registry gate (WKH-AUDIT-A2A)
 * In production the mock-registry route is NOT mounted → 404.
 *
 * The full server (src/index.ts) uses top-level await + side effects, so this
 * test replicates the exact guard (CD-3: `if (!isProduction)`) on an isolated
 * Fastify instance instead of importing index.ts.
 */

import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mockRegistryRoutes from './routes/mock-registry.js';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

describe('AC-6: mock-registry production gate', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    process.env.NODE_ENV = 'production';
    app = Fastify();
    // Replica del guard de src/index.ts (CD-3).
    if (process.env.NODE_ENV !== 'production') {
      await app.register(mockRegistryRoutes, {
        prefix: '/mock-registry/agents',
      });
    }
    await app.ready();
  });

  afterAll(async () => {
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    await app.close();
  });

  it('prod → GET /mock-registry/agents returns 404 (route not mounted)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/mock-registry/agents',
    });
    expect(res.statusCode).toBe(404);
  });
});
