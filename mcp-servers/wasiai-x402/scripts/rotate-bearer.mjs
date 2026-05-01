#!/usr/bin/env node
// scripts/rotate-bearer.mjs — generate a fresh MCP_BEARER_TOKEN (WKH-66 W4.1).
//
// Contract:
//   - Stdout: ONE line, exactly the new bearer (64 hex chars + LF).
//   - Stderr: human-readable instructions for `vercel env add/rm`.
//
// Safety invariants (CD-6):
//   - Refuse to print the bearer when stdout is NOT a TTY. Otherwise an
//     accidental `node scripts/rotate-bearer.mjs > .env` would commit the
//     secret to disk and possibly to git.
//   - NEVER write to disk. NEVER mutate .env. The operator copies the
//     stdout line manually into Vercel env via the CLI commands shown on
//     stderr.
//   - NEVER log the bearer to stderr (CD-10). Stderr is allowed to print
//     the rotation runbook only.

import { randomBytes } from 'node:crypto';

if (!process.stdout.isTTY) {
  process.stderr.write(
    'Refusing to print bearer to non-TTY (would risk redirect to git-tracked file). ' +
    'Re-run from interactive terminal.\n',
  );
  process.exit(1);
}

const bearer = randomBytes(32).toString('hex'); // 64 hex chars
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
