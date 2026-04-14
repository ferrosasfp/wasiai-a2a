/**
 * MCP Metrics Tests — AC-18
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetMcpMetrics,
  incrementMcpToolCall,
  renderMcpMetrics,
} from './metrics.js';

beforeEach(() => {
  _resetMcpMetrics();
});

describe('MCP metrics', () => {
  it('AC-18: incrementMcpToolCall + renderMcpMetrics produce Prometheus-formatted counters', () => {
    incrementMcpToolCall('pay_x402', 'success');
    incrementMcpToolCall('pay_x402', 'success');
    incrementMcpToolCall('orchestrate', 'error');

    const out = renderMcpMetrics();

    expect(out).toContain(
      '# HELP mcp_tool_calls_total Total MCP tool calls by tool and status',
    );
    expect(out).toContain('# TYPE mcp_tool_calls_total counter');
    expect(out).toContain(
      'mcp_tool_calls_total{tool="pay_x402",status="success"} 2',
    );
    expect(out).toContain(
      'mcp_tool_calls_total{tool="pay_x402",status="error"} 0',
    );
    expect(out).toContain(
      'mcp_tool_calls_total{tool="orchestrate",status="error"} 1',
    );
    expect(out).toContain(
      'mcp_tool_calls_total{tool="orchestrate",status="success"} 0',
    );
    // Always 4 tools x 2 statuses = 8 counter lines
    const counterLines = out
      .split('\n')
      .filter((l) => l.startsWith('mcp_tool_calls_total{'));
    expect(counterLines).toHaveLength(8);
  });

  it('renders zeros for all 4 tools x 2 statuses by default', () => {
    const out = renderMcpMetrics();
    for (const tool of [
      'pay_x402',
      'get_payment_quote',
      'discover_agents',
      'orchestrate',
    ]) {
      expect(out).toContain(
        `mcp_tool_calls_total{tool="${tool}",status="success"} 0`,
      );
      expect(out).toContain(
        `mcp_tool_calls_total{tool="${tool}",status="error"} 0`,
      );
    }
  });
});
