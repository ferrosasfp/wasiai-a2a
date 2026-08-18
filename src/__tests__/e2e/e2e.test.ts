/**
 * E2E Test Suite — WKH-029
 * Covers AC-1 through AC-20: full request/response cycle via fastify.inject()
 */

import type Fastify from 'fastify';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  buildTestApp,
  discoveryService,
  identityService,
  makeKeyRow,
  TEST_KEY,
  TEST_KEY_ID,
} from './setup.js';

// ── Environment ───────────────────────────────────────────────
process.env.RATE_LIMIT_MAX = '10';
process.env.RATE_LIMIT_WINDOW_MS = '60000';
process.env.KITE_WALLET_ADDRESS = '0x1234567890123456789012345678901234567890';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const mockCreateKey = identityService.createKey as ReturnType<typeof vi.fn>;
const mockLookupByHash = identityService.lookupByHash as ReturnType<
  typeof vi.fn
>;
const mockDiscover = discoveryService.discover as ReturnType<typeof vi.fn>;

describe('E2E', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Server bootstrap + health (AC-1, AC-2) ─────────────────

  describe('Server bootstrap + health', () => {
    it('AC-1: buildTestApp() completes without errors', () => {
      expect(app).toBeDefined();
    });

    it('AC-2: GET / returns 200 with name and version', async () => {
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.name).toBe('WasiAI A2A Protocol');
      expect(body.version).toBe('0.1.0');
    });
  });

  // ── Well-known agent card (AC-3) ────────────────────────────

  describe('Well-known agent card', () => {
    it('AC-3: GET /.well-known/agent.json returns valid Agent Card', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/.well-known/agent.json',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('name');
      expect(body).toHaveProperty('description');
      expect(body).toHaveProperty('url');
      expect(body).toHaveProperty('capabilities');
      expect(body).toHaveProperty('skills');
    });
  });

  // ── Middleware -- request-id (AC-4) ─────────────────────────

  describe('Middleware -- request-id', () => {
    it('AC-4: every response includes x-request-id in UUID format', async () => {
      const res = await app.inject({ method: 'GET', url: '/' });
      const reqId = res.headers['x-request-id'] as string;
      expect(reqId).toBeDefined();
      expect(reqId).toMatch(UUID_RE);
    });
  });

  // ── Middleware -- error boundary (AC-5) ─────────────────────

  describe('Middleware -- error boundary', () => {
    it('AC-5: error responses have structured shape with error, code, requestId', async () => {
      mockDiscover.mockRejectedValueOnce(new Error('Discovery exploded'));

      const res = await app.inject({ method: 'GET', url: '/discover' });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      const body = res.json();
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('code');
      expect(body).toHaveProperty('requestId');
    });
  });

  // ── Middleware -- rate limit (AC-6) ─────────────────────────
  // Uses separate app instance to avoid state pollution

  describe('Middleware -- rate limit', () => {
    let rateLimitApp: ReturnType<typeof Fastify>;

    beforeAll(async () => {
      rateLimitApp = await buildTestApp();
    });

    afterAll(() => rateLimitApp.close());

    it('AC-6: 11th request returns 429 with Retry-After', async () => {
      mockCreateKey.mockResolvedValue({ key: TEST_KEY, key_id: TEST_KEY_ID });

      // Fire 11 requests to a rate-limited endpoint
      const results = [];
      for (let i = 0; i < 11; i++) {
        const res = await rateLimitApp.inject({
          method: 'POST',
          url: '/auth/agent-signup',
          payload: { owner_ref: `user-${i}` },
        });
        results.push(res);
      }

      const lastRes = results[10];
      expect(lastRes.statusCode).toBe(429);
      expect(lastRes.headers['retry-after']).toBeDefined();
    });
  });

  // ── Identity -- agent-signup (AC-7) ─────────────────────────

  describe('Identity -- agent-signup', () => {
    it('AC-7: POST /auth/agent-signup returns 201 with wasi_a2a_ key', async () => {
      mockCreateKey.mockResolvedValue({ key: TEST_KEY, key_id: TEST_KEY_ID });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/agent-signup',
        payload: { owner_ref: 'user-1' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.key).toMatch(/^wasi_a2a_/);
    });
  });

  // ── Identity -- me (AC-8, AC-9, AC-10) ─────────────────────

  describe('Identity -- me', () => {
    it('AC-8: GET /auth/me with valid key returns 200 with budget/scoping', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());

      const res = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { 'x-a2a-key': TEST_KEY },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('budget');
      expect(body).toHaveProperty('scoping');
    });

    it('AC-9: GET /auth/me without header returns 403', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/me',
      });

      expect(res.statusCode).toBe(403);
    });

    it('AC-10: GET /auth/me with invalid key returns 403 with code KEY_NOT_FOUND', async () => {
      mockLookupByHash.mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { 'x-a2a-key': 'wasi_a2a_bad' },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ── Identity -- deposit + bind (AC-11, AC-12) ──────────────

  describe('Identity -- deposit + bind', () => {
    it('AC-11: POST /auth/deposit is live (no longer 501) — without auth returns 403 (WKH-35)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/deposit',
        payload: {
          key_id: TEST_KEY_ID,
          chain_id: 2368,
          token: 'PYUSD',
          amount: '10.00',
          tx_hash: '0xabc123',
        },
      });

      // WKH-35 re-enabled the endpoint; the old 501 contract is gone. With no
      // x-a2a-key / Bearer header the request is unauthenticated → 403.
      expect(res.statusCode).toBe(403);
    });

    it('AC-12: POST /auth/bind/kite returns 501', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/bind/kite',
      });

      expect(res.statusCode).toBe(501);
    });
  });

  // ── Gasless status (AC-13) ──────────────────────────────────

  describe('Gasless status', () => {
    it('AC-13: GET /gasless/status returns 200 with funding_state', async () => {
      const res = await app.inject({ method: 'GET', url: '/gasless/status' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('funding_state');
      expect(['unconfigured', 'unfunded', 'ready']).toContain(
        body.funding_state,
      );
    });
  });

  // ── Dashboard (AC-14, AC-15) ────────────────────────────────

  describe('Dashboard', () => {
    it('AC-14: GET /dashboard returns 200 with text/html', async () => {
      const res = await app.inject({ method: 'GET', url: '/dashboard' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });

    it('AC-15: GET /dashboard/api/stats returns 200 with JSON', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/api/stats',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
    });
  });

  // ── Discovery (AC-16) ──────────────────────────────────────

  describe('Discovery', () => {
    it('AC-16: GET /discover returns 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/discover' });
      expect(res.statusCode).toBe(200);
    });

    it('POST /discover returns 200 (WKH-BEARER-FIX AC-9)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/discover',
        payload: { q: 'test' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('GET /discover with agents includes invocationNote (WKH-BEARER-FIX AC-11)', async () => {
      mockDiscover.mockResolvedValueOnce({
        agents: [
          {
            id: 'agent-1',
            name: 'Test Agent',
            slug: 'test-agent',
            description: 'A test agent',
            capabilities: ['test'],
            priceUsdc: 0,
            registry: 'mock',
            invokeUrl: 'https://example.com/invoke',
            invocationNote:
              'The invokeUrl is an internal reference. To invoke this agent, use POST /compose or POST /orchestrate on the WasiAI A2A gateway.',
            verified: false,
            status: 'active',
            metadata: {},
          },
        ],
        total: 1,
        registries: ['mock'],
      });

      const res = await app.inject({ method: 'GET', url: '/discover' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.agents[0]).toHaveProperty('invocationNote');
      expect(body.agents[0].invocationNote).toContain('/compose');
    });
  });

  // ── Health (WKH-BEARER-FIX AC-10) ──────────────────────────

  describe('Health', () => {
    it('AC-10: GET /health returns 200 with status and uptime', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('status', 'ok');
      expect(body).toHaveProperty('uptime');
      expect(typeof body.uptime).toBe('number');
    });

    // HU-306 (AC-5 / T-HEALTH-SHAPE)
    it('T-HEALTH-SHAPE: sin umbral configurado el campo de exposición NO aparece, y `status` sigue intacto', async () => {
      delete process.env.STRANDED_EXPOSURE_ALERT_THRESHOLD_USD;
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // El `healthyField` que el monitor lee para decidir "arriba/abajo" no se toca.
      expect(body).toHaveProperty('status', 'ok');
      // Feature OFF ⟹ campo AUSENTE (no `false`): "no se computó" y "se computó y no hay
      // breach" son cosas distintas y no se escriben igual.
      expect(body).not.toHaveProperty('strandedExposureBreached');
    });

    it('T-HEALTH-SHAPE: con umbral configurado el campo aparece y es ADITIVO', async () => {
      process.env.STRANDED_EXPOSURE_ALERT_THRESHOLD_USD = '25';
      try {
        const res = await app.inject({ method: 'GET', url: '/health' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).toHaveProperty('status', 'ok');
        expect(body).toHaveProperty('uptime');
        expect(body).toHaveProperty('strandedExposureBreached');
        // Recién arrancado y sin snapshot: 'unknown' (truthy ⟹ el monitor alerta como
        // degradado). NUNCA `false`, que afirmaría que no hay breach sin haberlo mirado.
        expect(body.strandedExposureBreached).toBe('unknown');
      } finally {
        delete process.env.STRANDED_EXPOSURE_ALERT_THRESHOLD_USD;
      }
    });

    // Fix-pack observabilidad 2026-07-31: "apagada a propósito" y "mal escrita" son cosas
    // distintas y no se pueden escribir igual en el JSON. Antes las dos omitían el campo,
    // así que un typo en el umbral hacía DESAPARECER del canal push justamente al
    // indicador de que la alerta está rota, y un campo ausente se lee como "no hay
    // problema". Se prueba contra el handler real de /health, no contra el helper.
    it('T-HEALTH-SHAPE: con el umbral PUESTO pero ILEGIBLE el campo APARECE diciendo "unknown"', async () => {
      // `1O` con letra O: no da error, da una alerta que nunca suena.
      process.env.STRANDED_EXPOSURE_ALERT_THRESHOLD_USD = '1O';
      try {
        const res = await app.inject({ method: 'GET', url: '/health' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).toHaveProperty('status', 'ok');
        // No desaparece: el monitor tiene que poder alertar sobre esto.
        expect(body).toHaveProperty('strandedExposureBreached');
        expect(body.strandedExposureBreached).toBe('unknown');
        // Truthy ⟹ el `degradedPath` del health-monitor dispara sin tocar el monitor.
        expect(Boolean(body.strandedExposureBreached)).toBe(true);
      } finally {
        delete process.env.STRANDED_EXPOSURE_ALERT_THRESHOLD_USD;
      }
    });

    /**
     * ⚠️ WKH-360 · fix-pack CR/BLQ-BAJO-2 — **el campo `contractingGuard` de
     * `/health` no lo verificaba NINGÚN test, en ninguno de los dos handlers.**
     * Medido por el CR: borrando la línea de `e2e/setup.ts` la suite quedaba en
     * `5594 passed, cero rojos`.
     *
     * Por qué importa más que un campo cualquiera: NC-1 lo designa como **el único
     * instrumento** para saber, DESPUÉS del deploy, si `BASE_URL`/`A2A_SELF_HOSTS`
     * quedaron puestas — desde afuera del hosting no se puede distinguir. Y de eso
     * depende si la capa 1 cubre los alias propios o sólo el `Host` de cada
     * petición (fix-pack BLQ-MED-1). Un instrumento que puede desaparecer sin que
     * nada se ponga rojo no es un instrumento.
     *
     * Sigue el precedente de `T-HEALTH-SHAPE`, veinte líneas más arriba: par
     * presente/ausente contra el handler REAL vía `inject('/health')`, no contra el
     * helper.
     */
    it('T-HEALTH-CONTRACTING: sin identidad configurada, el campo dice `request-only` con conteo 0', async () => {
      const savedHosts = process.env.A2A_SELF_HOSTS;
      const savedBase = process.env.BASE_URL;
      delete process.env.A2A_SELF_HOSTS;
      delete process.env.BASE_URL;
      try {
        const res = await app.inject({ method: 'GET', url: '/health' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).toHaveProperty('status', 'ok');
        // El campo existe SIEMPRE: "no me reconozco por ningún alias" es
        // justamente el estado que hay que poder ver después del deploy.
        expect(body).toHaveProperty('contractingGuard');
        expect(body.contractingGuard.selfHostCount).toBe(0);
        expect(body.contractingGuard.source).toBe('request-only');
        expect(typeof body.contractingGuard.depthMax).toBe('number');
      } finally {
        if (savedHosts !== undefined) process.env.A2A_SELF_HOSTS = savedHosts;
        if (savedBase !== undefined) process.env.BASE_URL = savedBase;
      }
    });

    it('T-HEALTH-CONTRACTING: con identidad configurada dice `env` con el CONTEO, nunca los hosts', async () => {
      const savedHosts = process.env.A2A_SELF_HOSTS;
      process.env.A2A_SELF_HOSTS = 'gw.example.com,alias.example.com';
      try {
        const res = await app.inject({ method: 'GET', url: '/health' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.contractingGuard.selfHostCount).toBe(2);
        expect(body.contractingGuard.source).toBe('env');
        // ⛔ Sale el CONTEO, no los hosts. Es parte del contrato del campo.
        expect(JSON.stringify(body.contractingGuard)).not.toContain(
          'gw.example.com',
        );
      } finally {
        if (savedHosts === undefined) delete process.env.A2A_SELF_HOSTS;
        else process.env.A2A_SELF_HOSTS = savedHosts;
      }
    });
  });

  // ── Bearer auth on /auth/me (WKH-BEARER-FIX AC-8) ────────

  describe('Bearer auth', () => {
    it('AC-8: GET /auth/me with Bearer wasi_a2a_* returns 200', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());

      const res = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${TEST_KEY}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('budget');
      expect(body).toHaveProperty('scoping');
    });
  });

  // ── Error handling (AC-17, AC-18) ───────────────────────────

  describe('Error handling', () => {
    it('AC-17: POST with invalid JSON returns 400 with structured error', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/orchestrate',
        headers: { 'content-type': 'application/json' },
        payload: 'this is not valid json{{{',
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('code');
      expect(body).toHaveProperty('requestId');
    });

    it('AC-18: GET /nonexistent returns 404', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/this-route-does-not-exist',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── Protected routes (AC-19, AC-20) ─────────────────────────

  describe('Protected routes', () => {
    it('AC-19: POST /compose without auth returns 402', async () => {
      // HIGH-2 (2026-07-26): el payload usaba `agentSlug` (¡no `agent`!), o sea que
      // era un body MALFORMADO y el 402 se obtenía por accidente — el gate de auth
      // corría antes de cualquier validación de shape. Desde HIGH-2 la validación
      // de shape corre PRE-PAGO (para que un body malformado no se cobre, ni en el
      // path prepago ni en el x402, que no tiene refund inbound), así que ese
      // payload ahora da 400. El payload se corrige a un body BIEN FORMADO: así el
      // test prueba lo que dice probar (la ruta exige pago) en vez de apoyarse en
      // el orden relativo de dos guards distintos.
      // El nuevo comportamiento (malformado + sin auth → 400 pre-pago) queda
      // cubierto por AC-19b abajo.
      //
      // Con un body bien formado el preHandler de precio SÍ corre, y el
      // `getAgent` por defecto de este harness devuelve null → 404
      // AGENT_NOT_FOUND (que también es pre-débito, correcto). Para aislar el
      // gate de AUTH hay que hacer que el agente resuelva.
      const mockGetAgent = discoveryService.getAgent as ReturnType<
        typeof vi.fn
      >;
      mockGetAgent.mockResolvedValueOnce({
        id: 'a1',
        name: 'Test Agent',
        slug: 'test',
        description: '',
        capabilities: [],
        priceUsdc: 0.5,
        registry: 'wasiai',
        registry_id: 'wasiai',
        invokeUrl: 'https://example.com/invoke/test',
        invocationNote: '',
        verified: false,
        status: 'active',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/compose',
        payload: { steps: [{ agent: 'test', input: {} }] },
      });

      expect(res.statusCode).toBe(402);
      mockGetAgent.mockReset();
      mockGetAgent.mockResolvedValue(null);
    });

    it('AC-19b (HIGH-2): POST /compose con body malformado y sin auth → 400 ANTES del challenge de pago', async () => {
      // El caller x402 no tiene refund inbound: si el 402 se emitiera primero y el
      // caller pagara, el 400 posterior se quedaría con su plata. Rechazar por
      // shape ANTES del pago es la única defensa para ese path.
      const res = await app.inject({
        method: 'POST',
        url: '/compose',
        payload: { steps: [] },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
    });

    it('AC-20: POST /orchestrate without auth returns 402', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/orchestrate',
        payload: { goal: 'test', budget: 1 },
      });

      expect(res.statusCode).toBe(402);
    });
  });
});
