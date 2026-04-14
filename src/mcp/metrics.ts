/**
 * MCP Metrics — Prometheus counter `mcp_tool_calls_total{tool,status}`
 *
 * In-memory Map, process-local. Rendered via `renderMcpMetrics()` and
 * appended by `src/routes/metrics.ts` to the global /metrics payload.
 */

import { TOOL_NAMES, type ToolName } from './types.js';

interface ToolCounters {
  success: number;
  error: number;
}

// Initialise map with zeroed counters for every known tool so `/metrics`
// always exposes 8 series (4 tools x 2 statuses) — required for AC-18.
const mcpStats: Map<ToolName, ToolCounters> = new Map(
  TOOL_NAMES.map((tool) => [tool, { success: 0, error: 0 }]),
);

export function incrementMcpToolCall(
  tool: ToolName,
  status: 'success' | 'error',
): void {
  const counters = mcpStats.get(tool);
  if (!counters) return; // unreachable: ToolName is a closed union
  counters[status] += 1;
}

export function renderMcpMetrics(): string {
  const lines: string[] = [];
  lines.push(
    '# HELP mcp_tool_calls_total Total MCP tool calls by tool and status',
  );
  lines.push('# TYPE mcp_tool_calls_total counter');
  for (const [tool, counts] of mcpStats.entries()) {
    lines.push(
      `mcp_tool_calls_total{tool="${tool}",status="success"} ${counts.success}`,
    );
    lines.push(
      `mcp_tool_calls_total{tool="${tool}",status="error"} ${counts.error}`,
    );
  }
  return lines.join('\n');
}

/**
 * Test-only: reset counters. NOT exported from the package index; tests import
 * from this file directly.
 */
export function _resetMcpMetrics(): void {
  for (const tool of TOOL_NAMES) {
    mcpStats.set(tool, { success: 0, error: 0 });
  }
}
