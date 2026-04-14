/**
 * orchestrate — thin wrapper over orchestrateService.orchestrate. Generates
 * the orchestrationId locally and propagates `a2aKey` (AC-10).
 *
 * BLQ-3: maps each StepResult from the pipeline into the stable
 * OrchestrateStepOutput shape (agent slug + registry + output + costs +
 * optional txHash). The previous implementation returned ComposeStep[] with
 * empty `input` and `passOutput:false`, dropping all real step data.
 */

import crypto from 'node:crypto';
import { orchestrateService } from '../../services/orchestrate.js';
import type {
  OrchestrateToolInput,
  OrchestrateToolOutput,
  ToolContext,
} from '../types.js';

export async function orchestrate(
  input: OrchestrateToolInput,
  _ctx: ToolContext,
): Promise<OrchestrateToolOutput> {
  const orchestrationId = crypto.randomUUID();
  const result = await orchestrateService.orchestrate(
    {
      goal: input.goal,
      budget: input.budget,
      preferCapabilities: input.preferCapabilities,
      maxAgents: input.maxAgents,
      a2aKey: input.a2aKey,
    },
    orchestrationId,
  );

  return {
    orchestrationId: result.orchestrationId,
    steps: result.pipeline.steps.map((s) => ({
      agent: s.agent.slug,
      registry: s.agent.registry,
      output: s.output,
      costUsdc: s.costUsdc,
      latencyMs: s.latencyMs,
      txHash: s.txHash,
    })),
    result: result.answer,
    kiteTxHash: result.attestationTxHash,
    reasoning: result.reasoning,
    protocolFeeUsdc: result.protocolFeeUsdc,
  };
}
