#!/usr/bin/env node
// scripts/rotate-bearer.mjs — generate a fresh MCP_BEARER_TOKEN.
//
// WKH-66 W4.1 manual-only; WKH-75 W2 adds HEADLESS mode (cron / CI).
//
// CD-6 (manual): refuse non-TTY stdout. CD-9: never log bearer/token.

import { randomBytes } from 'node:crypto';

const HEADLESS = Boolean(process.env.VERCEL_TOKEN && process.env.VERCEL_PROJECT_ID);

if (HEADLESS) {
  const { rotateBearer } = await import('../src/bearer-rotation.mjs');
  const { getKvClient } = await import('../src/kv-client.mjs');

  let result;
  try {
    result = await rotateBearer({
      vercelToken: process.env.VERCEL_TOKEN,
      projectId: process.env.VERCEL_PROJECT_ID,
      teamId: process.env.VERCEL_TEAM_ID,
      alertWebhookUrl: process.env.MCP_ALERT_WEBHOOK_URL,
      kvClient: getKvClient(),
    });
  } catch (err) {
    process.stderr.write(`rotate-bearer: unexpected error (${err?.name ?? 'Error'})\n`);
    process.exit(1);
  }

  if (result?.ok) {
    process.stdout.write(JSON.stringify({
      ok: true,
      rotatedAt: result.rotatedAt,
      expiresAt: result.expiresAt,
    }) + '\n');
    process.exit(0);
  }

  process.stderr.write(
    `rotate-bearer: rotation failed at stage="${result?.stage ?? 'unknown'}" reason="${result?.reason ?? 'unknown'}"\n`,
  );
  process.exit(1);
}

if (!process.stdout.isTTY) {
  process.stderr.write(
    'Refusing to print bearer to non-TTY (would risk redirect to git-tracked file). ' +
    'Re-run from interactive terminal.\n',
  );
  process.exit(1);
}

const bearer = randomBytes(32).toString('hex');
process.stdout.write(bearer + '\n');

process.stderr.write([
  '',
  '=== Next steps ===',
  '1. vercel env rm MCP_BEARER_TOKEN production   # remove the previous token',
  '2. vercel env add MCP_BEARER_TOKEN production   # paste the bearer above',
  '3. vercel deploy --prod                         # rollout',
  '',
  'NOTE: never paste the bearer into a chat, git issue, or .env file. The',
  'value above is only valid in this terminal session.',
  '',
].join('\n'));
