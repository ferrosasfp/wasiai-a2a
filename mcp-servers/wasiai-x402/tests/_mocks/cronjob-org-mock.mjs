// cronjob-org-mock.mjs — Mock fetch for https://api.cron-job.org/jobs.
//
// Spec coverage: scripts/setup-cronjob.mjs uses
//   GET    /jobs            → list
//   PUT    /jobs            → create (idempotent if no existing match by title)
//   PATCH  /jobs/<id>       → update
//
// The mock is body-aware (CD-19): PUT bodies carry { job: { title, ... } }
// and the mock matches by title to detect duplicates. Tests T-SC-02/03 rely
// on this behaviour.
//
// PROHIBITED: simulating a real network. Tests that exercise the cron
// provisioning script call this mock through a `fetch` slot, not a real
// HTTP server.

let _nextId = 100;

export function createCronjobOrgMock({
  existingJobs = [],
  failNext = 0,
  slowMs = 0,
} = {}) {
  // Clone seed jobs so multiple test runs don't share state.
  const jobs = existingJobs.map((j) => ({ ...j, jobId: j.jobId ?? _nextId++ }));
  let _failNext = failNext;
  const calls = [];

  async function fetchMock(url, opts = {}) {
    calls.push({ url: String(url), method: opts.method ?? 'GET', body: opts.body });

    if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));
    if (_failNext > 0) {
      _failNext -= 1;
      throw new Error('cronjob-org: simulated failure');
    }

    const u = new URL(String(url));
    if (u.hostname !== 'api.cron-job.org') {
      throw new Error(`cronjob-org-mock: unexpected host ${u.hostname}`);
    }

    const method = (opts.method ?? 'GET').toUpperCase();

    // GET /jobs → list
    if (method === 'GET' && u.pathname === '/jobs') {
      return _json(200, { jobs });
    }

    // PUT /jobs → create
    if (method === 'PUT' && u.pathname === '/jobs') {
      const body = _parseBody(opts.body);
      if (!body?.job?.title) {
        return _json(400, { message: 'missing job.title' });
      }
      // Idempotency check — duplicate title on PUT is a script bug.
      const existing = jobs.find((j) => j.title === body.job.title);
      if (existing) {
        return _json(409, { message: 'duplicate', jobId: existing.jobId });
      }
      const jobId = _nextId++;
      const created = { ...body.job, jobId, nextExecution: 1700000000 };
      jobs.push(created);
      return _json(200, { jobId });
    }

    // PATCH /jobs/<id> → update
    if (method === 'PATCH' && /^\/jobs\/\d+$/.test(u.pathname)) {
      const id = Number(u.pathname.split('/').pop());
      const body = _parseBody(opts.body);
      const idx = jobs.findIndex((j) => j.jobId === id);
      if (idx === -1) return _json(404, { message: 'not found' });
      jobs[idx] = { ...jobs[idx], ...(body?.job ?? {}) };
      return _json(200, { jobId: id });
    }

    return _json(404, { message: 'route not handled by mock' });
  }

  // Test introspection.
  fetchMock._jobs = jobs;
  fetchMock._calls = calls;
  fetchMock._setFailNext = (n) => { _failNext = n; };

  return fetchMock;
}

function _json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function _parseBody(body) {
  if (!body) return null;
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { return null; }
  }
  return body;
}
