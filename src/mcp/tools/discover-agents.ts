/**
 * discover_agents — thin wrapper over discoveryService.discover with a
 * timeout enforced by Promise.race (AC-8).
 */

import { discoveryService } from '../../services/discovery.js';
import type { DiscoveryResult } from '../../types/index.js';
import {
  type DiscoverAgentsInput,
  MCP_ERRORS,
  MCPToolError,
  type ToolContext,
} from '../types.js';

export async function discoverAgents(
  input: DiscoverAgentsInput,
  _ctx: ToolContext,
): Promise<DiscoveryResult> {
  const timeoutMs = parseInt(
    process.env.TIMEOUT_ORCHESTRATE_MS ?? '120000',
    10,
  );

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new MCPToolError(MCP_ERRORS.TOOL_EXECUTION, 'Discovery timeout'));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      discoveryService.discover({
        query: input.query,
        capabilities: input.capabilities,
        maxPrice: input.maxPrice,
        limit: input.limit ?? 20,
      }),
      timeoutPromise,
    ]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
