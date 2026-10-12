import { getAgentModelConfig } from '@happier-dev/agents';

import { createDevinBackend } from '@/backends/devin/acp/backend';
import { permissionModeForExecutionRunPolicy } from '@/agent/executionRuns/policy/permissionModeForExecutionRunPolicy';
import type { ExecutionRunBackendFactory } from '@/agent/executionRuns/registry/executionRunBackendTypes';
import { withExecutionRunBackendModelOptions } from '@/agent/executionRuns/runtime/applyExecutionRunBackendModelOptions';
import {
  resolveDevinSessionConfigOptionUpdate,
  resolveDevinSessionModelConfigUpdate,
} from '@/backends/devin/acp/modelControls';

const modelConfig = getAgentModelConfig('devin');

export const executionRunBackendFactory: ExecutionRunBackendFactory = (options) => {
  const backend = createDevinBackend({
    cwd: options.cwd,
    env: options.isolation?.env,
    permissionHandler: options.permissionHandler,
    permissionMode: permissionModeForExecutionRunPolicy(options.permissionMode),
    ...(options.resolveMcpServers ? { resolveMcpServers: options.resolveMcpServers } : {}),
  });

  return withExecutionRunBackendModelOptions(backend, {
    ...(options.modelId ? { modelId: options.modelId } : {}),
    modelApply: {
      method: modelConfig.acpModelSetMethod ?? 'set_model',
      ...(modelConfig.acpModelConfigOptionId
        ? { configOptionId: modelConfig.acpModelConfigOptionId }
        : {}),
    },
    ...(options.sessionConfigOptionOverrides
      ? { sessionConfigOptionOverrides: options.sessionConfigOptionOverrides }
      : {}),
    resolveSessionModelConfigUpdate: resolveDevinSessionModelConfigUpdate,
    resolveSessionConfigOptionUpdate: resolveDevinSessionConfigOptionUpdate,
  });
};
