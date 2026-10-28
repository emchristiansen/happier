import type { ClaudeRemoteRunnerKind } from '../remote/claudeRemoteDispatch';
import { isReplaySdkMessage } from '../remote/runtimeActivityEvidence';

import type { ClaudeWorkflowActivitySource } from './claudeWorkflowActivitySource';

/**
 * Route one remote-runner `onMessage` value (an `SDKMessage`) into the shared Claude Dynamic Workflow
 * ACTIVITY source.
 *
 * Only the SDK-stream runners (`agentSdk` + the `legacy` fallback) deliver workflow activity through
 * `onMessage`: Claude's agent-SDK emits the `Workflow` tool-use anchor as an `assistant` message and
 * the `task_started` / `task_progress` (with `workflow_progress[]`) / `task_notification` lifecycle as
 * `system` messages, all of which the workflow correlation parser already understands.
 *
 * The unified-terminal runner instead feeds the SAME source through the RAW transcript channel
 * (`onRawTranscriptValue`), and it is the ONLY runner that uses that channel — so the dispatcher
 * explicitly reports a null runner kind for Unified. Gating on the runner kind therefore prevents
 * the unified runner's visible-transcript `onMessage` — which still carries the assistant `Workflow`
 * tool-use anchor — from DOUBLE-feeding a source already driven by its raw channel. A `null` kind
 * (Unified, or before any runner was selected) is never fed here.
 */
export function routeClaudeSdkMessageToWorkflowSource(params: Readonly<{
  message: unknown;
  runnerKind: ClaudeRemoteRunnerKind | null;
  workflowActivitySource: ClaudeWorkflowActivitySource | null;
}>): void {
  if (params.runnerKind !== 'agentSdk' && params.runnerKind !== 'legacy') return;
  params.workflowActivitySource?.observeTranscriptMessage(params.message, {
    historicalReplay: isReplaySdkMessage(params.message),
  });
}
