import { DeferredApiSessionClient } from '@/agent/runtime/startup/DeferredApiSessionClient';
import type { BackendStartupSpec, StartupTask } from '@/agent/runtime/startup/startupSpec';
import { configuration } from '@/configuration';
import { createClaudeInitializeSessionInBackgroundTask } from './tasks/initializeSessionInBackgroundTask';
import { createClaudeRegisterRpcHandlersTask } from './tasks/registerRpcHandlersTask';
import { createClaudeStartHookServerTask } from './tasks/startHookServerTask';

type HookServer = Readonly<{ port: number; stop: () => void }>;

export type ClaudeStartupArtifacts = {
  deferredSession: DeferredApiSessionClient;
  hookServer: HookServer | null;
  hookSettingsPath: string | null;
  hookPluginDir: string | null;
  exitCode: number | null;
};

type CreateClaudeStartupSpecDeps = Readonly<{
  startHookServer: () => Promise<HookServer>;
  generateHookSettingsFile: (port: number) => Promise<string> | string;
  generateHookPluginDir: (port: number) => Promise<string | null> | string | null;
  cleanupHookSettingsFile: (path: string) => void;
  cleanupHookPluginDir: (path: string | null | undefined) => void;
  registerRpcHandlers: (args: { artifacts: ClaudeStartupArtifacts }) => void;
  initializeSessionInBackground: (args: { artifacts: ClaudeStartupArtifacts; signal: AbortSignal }) => Promise<void>;
  spawnLoop: (args: { artifacts: ClaudeStartupArtifacts; signal: AbortSignal }) => Promise<number>;
}>;

const defaultDeps: CreateClaudeStartupSpecDeps = {
  startHookServer: async () => {
    throw new Error('startHookServer not wired');
  },
  generateHookSettingsFile: () => {
    throw new Error('generateHookSettingsFile not wired');
  },
  generateHookPluginDir: () => null,
  cleanupHookSettingsFile: () => {},
  cleanupHookPluginDir: () => {},
  registerRpcHandlers: () => {},
  initializeSessionInBackground: async () => {},
  spawnLoop: async () => 0,
};

export function createClaudeStartupSpec(params: {
  existingSessionId?: string;
  configureSessionClient?: (session: DeferredApiSessionClient) => void;
  deps?: Partial<CreateClaudeStartupSpecDeps>;
}): BackendStartupSpec<ClaudeStartupArtifacts> {
  const deps: CreateClaudeStartupSpecDeps = { ...defaultDeps, ...(params.deps ?? {}) };

  const tasks: Array<StartupTask<ClaudeStartupArtifacts>> = [
    createClaudeRegisterRpcHandlersTask({ registerRpcHandlers: deps.registerRpcHandlers }),
    createClaudeStartHookServerTask({
      startHookServer: deps.startHookServer,
      generateHookSettingsFile: deps.generateHookSettingsFile,
      generateHookPluginDir: deps.generateHookPluginDir,
    }),
    createClaudeInitializeSessionInBackgroundTask({ initializeSessionInBackground: deps.initializeSessionInBackground }),
  ];

  return {
    backendId: 'claude',
    createArtifacts: () => {
      const placeholderSessionId = `PID-${process.pid}`;
      const deferredSession = new DeferredApiSessionClient({
        placeholderSessionId,
        existingSessionId: params.existingSessionId,
        limits: {
          maxEntries: configuration.startupDeferredSessionBufferMaxEntries,
          maxBytes: configuration.startupDeferredSessionBufferMaxBytes,
        },
      });
      params.configureSessionClient?.(deferredSession);

      return {
        deferredSession,
        hookServer: null,
        hookSettingsPath: null,
        hookPluginDir: null,
        exitCode: null,
      };
    },
    tasks,
    spawnVendor: async ({ artifacts, signal }) => {
      artifacts.exitCode = await deps.spawnLoop({ artifacts, signal });
    },
  };
}
