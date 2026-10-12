import { type AgentId, getBuiltInAcpConfig } from '@happier-dev/agents';

import type { AcpBackendOptions, AcpPermissionHandler } from '@/agent/acp/AcpBackend';
import type { PermissionMode } from '@/api/types';
import { createAcpBackend } from '@/agent/acp/createAcpBackend';
import type { AgentBackend, AgentFactoryOptions, AgentSessionOpenOptions, McpServerConfig, SessionId, StartSessionResult } from '@/agent/core';
import { requireProviderCliLaunchSpec } from '@/runtime/managedTools/requireProviderCliLaunchSpec';
import { resolveAcpCatalogTransportHandler } from './transport/resolveAcpCatalogTransportHandler';

export type CatalogDefinedAcpBackendOptions = AgentFactoryOptions & Readonly<{
  mcpServers?: Record<string, McpServerConfig>;
  permissionHandler?: AcpPermissionHandler;
  permissionMode?: PermissionMode;
  prepareProcessLaunch?: AcpBackendOptions['prepareProcessLaunch'];
  sessionModelAdapter?: AcpBackendOptions['sessionModelAdapter'];
  launch?: Readonly<{ command: string; args: readonly string[] }>;
}>;

export function createCatalogDefinedAcpBackend(
  agentId: AgentId,
  options: CatalogDefinedAcpBackendOptions,
): AgentBackend {
  const config = getBuiltInAcpConfig(agentId);
  if (!config) {
    throw new Error(`Agent '${agentId}' is not a built-in generic ACP agent`);
  }
  const launch = options.launch
    ?? requireProviderCliLaunchSpec(agentId, { processEnv: { ...process.env, ...options.env } });

  const backend: AgentBackend = createAcpBackend({
    agentName: agentId,
    cwd: options.cwd,
    command: launch.command,
    args: options.launch ? [...launch.args] : [...launch.args, ...config.launcher.args],
    env: {
      ...options.env,
      NODE_ENV: 'production',
      DEBUG: '',
    },
    prepareProcessLaunch: options.prepareProcessLaunch,
    sessionModelAdapter: options.sessionModelAdapter,
    sessionModesEnabled: config.supportsModes !== 'no',
    mcpServers: config.mcpServers === 'drop' ? undefined : options.mcpServers,
    permissionHandler: options.permissionHandler,
    transportHandler: resolveAcpCatalogTransportHandler(config.transportProfile),
    declaredSessionLoadSupport: config.supportsLoadSession,
  });

  const permissionMode = options.permissionMode ?? 'default';
  const sessionModeId = config.permissionModeMapping?.[permissionMode] ?? null;
  if (!sessionModeId) return backend;

  const configurable = backend as AgentBackend & {
    setSessionMode?: (sessionId: SessionId, modeId: string) => Promise<void>;
  };
  if (typeof configurable.setSessionMode !== 'function') return backend;

  const applyMode = async (result: StartSessionResult): Promise<StartSessionResult> => {
    await configurable.setSessionMode?.(result.sessionId, sessionModeId);
    return result;
  };

  const startSession = backend.startSession.bind(backend);
  configurable.startSession = async (
    initialPrompt?: string,
    openOptions?: AgentSessionOpenOptions,
  ): Promise<StartSessionResult> => applyMode(await startSession(initialPrompt, openOptions));

  if (typeof backend.loadSession === 'function') {
    const loadSession = backend.loadSession.bind(backend);
    configurable.loadSession = async (
      sessionId: SessionId,
      openOptions?: AgentSessionOpenOptions,
    ): Promise<StartSessionResult> => applyMode(await loadSession(sessionId, openOptions));
  }

  if (typeof backend.loadSessionWithReplayCapture === 'function') {
    const loadSessionWithReplayCapture = backend.loadSessionWithReplayCapture.bind(backend);
    configurable.loadSessionWithReplayCapture = async (sessionId: SessionId) => {
      const result = await loadSessionWithReplayCapture(sessionId);
      await configurable.setSessionMode?.(result.sessionId, sessionModeId);
      return result;
    };
  }

  return backend;
}
