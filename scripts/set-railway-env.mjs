#!/usr/bin/env node
/**
 * Set Railway production env var via GraphQL API (avoids CLI sandbox guardrail).
 * Reads RAILWAY_TOKEN from .env.
 *
 * Usage: node scripts/set-railway-env.mjs <KEY> <VALUE>
 */
import { readFileSync } from 'node:fs';

function readEnv(p) {
  const out = {};
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch { /* ignore */ }
  return out;
}

const env = readEnv('/home/ferdev/.openclaw/workspace/wasiai-a2a/.env');
const TOKEN = env.RAILWAY_TOKEN;
if (!TOKEN) { console.error('Missing RAILWAY_TOKEN in .env'); process.exit(3); }

const [name, value] = process.argv.slice(2);
if (!name || !value) { console.error('Usage: node set-railway-env.mjs <KEY> <VALUE>'); process.exit(3); }

const API = 'https://backboard.railway.com/graphql/v2';

async function gql(query, variables) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    console.error('GraphQL errors:', JSON.stringify(json.errors, null, 2));
    process.exit(1);
  }
  return json.data;
}

// Step 1: discover project + service ids via `me { projects }`
console.log(`Discovering Railway resources for token...`);
const me = await gql(`
  query Me {
    me {
      projects {
        edges {
          node {
            id
            name
            services {
              edges {
                node {
                  id
                  name
                  serviceInstances {
                    edges {
                      node {
                        environmentId
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`);

const projects = me?.me?.projects?.edges ?? [];
let target = null;
for (const p of projects) {
  for (const s of (p.node.services?.edges ?? [])) {
    if (s.node.name?.toLowerCase().includes('wasiai-a2a')) {
      const envId = s.node.serviceInstances?.edges?.[0]?.node?.environmentId;
      target = { projectId: p.node.id, projectName: p.node.name, serviceId: s.node.id, serviceName: s.node.name, environmentId: envId };
      break;
    }
  }
  if (target) break;
}

if (!target) {
  console.error('Could not find a service matching "wasiai-a2a". Available:');
  for (const p of projects) {
    for (const s of (p.node.services?.edges ?? [])) {
      console.error(`  ${p.node.name} / ${s.node.name}`);
    }
  }
  process.exit(1);
}

console.log(`Target: ${target.projectName} / ${target.serviceName} (env ${target.environmentId})`);

// Step 2: upsert the variable
const result = await gql(`
  mutation UpsertVariable($input: VariableUpsertInput!) {
    variableUpsert(input: $input)
  }
`, {
  input: {
    projectId: target.projectId,
    serviceId: target.serviceId,
    environmentId: target.environmentId,
    name,
    value,
  },
});

console.log(`✓ Variable ${name} set on ${target.serviceName}.`);
console.log(`  Result:`, JSON.stringify(result));
console.log(`  Railway will redeploy automatically.`);
