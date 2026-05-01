#!/usr/bin/env node
// scripts/refresh-session.mjs — smoke check for /api/mcp tools/list (WKH-66 W4.3).
//
// Reads MCP_BEARER_TOKEN + MCP_DEPLOY_URL from env, POSTs a JSON-RPC
// `tools/list` request, asserts result.tools.length === 3.
//
// Exit codes:
//   0 → ok, prints `{ ok: true, toolCount: 3 }` to stdout.
//   1 → fail, error message on stderr.

const bearer = process.env.MCP_BEARER_TOKEN;
const deployUrl = process.env.MCP_DEPLOY_URL;

if (!bearer || !deployUrl) {
  process.stderr.write('refresh-session: MCP_BEARER_TOKEN and MCP_DEPLOY_URL required\n');
  process.exit(1);
}

const url = `${deployUrl.replace(/\/$/, '')}/api/mcp`;

let resp;
try {
  resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${bearer}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    redirect: 'error', // CD-18
  });
} catch (e) {
  process.stderr.write(`refresh-session: fetch failed: ${e.message}\n`);
  process.exit(1);
}

if (resp.status !== 200) {
  process.stderr.write(`refresh-session: status ${resp.status}\n`);
  process.exit(1);
}

const text = await resp.text();
let payload;
try {
  payload = JSON.parse(text);
} catch {
  // SSE-framed.
  const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
  if (!dataLine) {
    process.stderr.write('refresh-session: unparseable response\n');
    process.exit(1);
  }
  payload = JSON.parse(dataLine.slice(5).trim());
}

const tools = payload?.result?.tools;
if (!Array.isArray(tools) || tools.length !== 3) {
  process.stderr.write(`refresh-session: expected 3 tools, got ${tools?.length ?? 'unknown'}\n`);
  process.exit(1);
}

process.stdout.write(JSON.stringify({ ok: true, toolCount: 3 }) + '\n');
process.exit(0);
