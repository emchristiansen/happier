import { AGENTS_CORE } from './manifest.js';
import { resolveAgentRuntimeControlSurfaceForSession } from './sessionControls/providerSessionBackends.js';
import { resolvePersistedCodexRuntimeIdentity } from './sessionControls/codexRuntimeIdentity.js';
import type {
  AgentCore,
  AgentId,
  AgentLocalControlAttachStrategy,
  AgentLocalControlTopology,
} from './types.js';

export type AgentLocalControlCapability = Readonly<{
  supported: boolean;
  topology: AgentLocalControlTopology;
  attachStrategy: AgentLocalControlAttachStrategy;
}>;

export function getAgentLocalControlCapability(agentId: AgentId): AgentLocalControlCapability | null {
  const agent = AGENTS_CORE[agentId] as AgentCore;
  const localControl = agent.localControl;
  if (!localControl || localControl.supported !== true) return null;
  return {
    supported: true,
    topology: localControl.topology ?? 'exclusive',
    attachStrategy: localControl.attachStrategy ?? 'unsupported',
  };
}

export function getAgentLocalControlCapabilityForSession(params: Readonly<{
  agentId: AgentId;
  metadata: unknown;
  accountSettings?: Record<string, unknown> | null;
}>): AgentLocalControlCapability | null {
  // Codex sessions created before runtime identity was persisted used terminal
  // attachment. Preserve that released shape instead of reinterpreting them as
  // the current App Server default.
  if (params.agentId === 'codex' && !resolvePersistedCodexRuntimeIdentity(params.metadata)) {
    return getAgentLocalControlCapability(params.agentId);
  }
  const surface = resolveAgentRuntimeControlSurfaceForSession(params);
  if (!surface) return getAgentLocalControlCapability(params.agentId);
  const localControl = surface.localControl;
  if (!localControl || localControl.supported !== true) return null;
  return {
    supported: true,
    topology: localControl.topology ?? 'exclusive',
    attachStrategy: localControl.attachStrategy ?? 'unsupported',
  };
}

export function usesProviderAttachForLocalControl(agentId: AgentId): boolean {
  return getAgentLocalControlCapability(agentId)?.attachStrategy === 'provider_attach';
}
