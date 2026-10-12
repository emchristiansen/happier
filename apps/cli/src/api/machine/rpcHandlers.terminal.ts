import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  DaemonTerminalCloseRequestSchema,
  DaemonTerminalEnsureRequestSchema,
  DaemonTerminalInputRequestSchema,
  DaemonTerminalResizeRequestSchema,
  DaemonTerminalRestartRequestSchema,
  DaemonTerminalStreamReadRequestSchema,
  type DaemonTerminalErrorCode,
  type DaemonTerminalLaunchIntent,
} from '@happier-dev/protocol';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import {
  authorizeFilesystemPath,
} from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';
import {
  type FilesystemAccessPolicy,
  resolveFilesystemPolicyDefaultDirectory,
  resolveFilesystemAccessPolicy,
} from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { resolveMachineRpcWorkingDirectory } from './resolveMachineRpcWorkingDirectory';
import { readDaemonTerminalPtyConfig } from '@/daemon/terminalPty/terminalPtyConfig';
import { createTerminalPtySessionManager, type TerminalPtySessionManager } from '@/daemon/terminalPty/terminalPtySessionManager';
import { createNodePtyProvider } from '@/integrations/pty/ptyProvider';
import { buildHappyCliSubprocessLaunchSpec } from '@/utils/spawnHappyCLI';

function err(errorCode: DaemonTerminalErrorCode): { ok: false; errorCode: DaemonTerminalErrorCode; error: DaemonTerminalErrorCode } {
  return { ok: false, errorCode, error: errorCode };
}

export function registerMachineTerminalRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  deps?: Readonly<{
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    workingDirectory?: string;
    accessPolicy?: FilesystemAccessPolicy;
    sessionManager?: TerminalPtySessionManager;
    buildHappyCliSubprocessLaunchSpecFn?: typeof buildHappyCliSubprocessLaunchSpec;
  }>;
}>): void {
  const { rpcHandlerManager } = params;
  const env = params.deps?.env ?? process.env;
  const platform = params.deps?.platform ?? process.platform;

  const config = readDaemonTerminalPtyConfig(env);
  const accessPolicy = params.deps?.accessPolicy ?? resolveFilesystemAccessPolicy({ env, platform });
  const workingDirectory =
    params.deps?.workingDirectory
    ?? resolveFilesystemPolicyDefaultDirectory({
      defaultDirectory: resolveMachineRpcWorkingDirectory({ env, platform }),
      accessPolicy,
    });

  let sessionManager: TerminalPtySessionManager | null = params.deps?.sessionManager ?? null;
  const getSessionManager = (): TerminalPtySessionManager => {
    if (sessionManager) return sessionManager;
    sessionManager = createTerminalPtySessionManager({
      ptyProvider: createNodePtyProvider(),
      config: config.sessionManager,
      env,
      platform,
    });
    return sessionManager;
  };
  const buildHappyCliSubprocessLaunchSpecFn =
    params.deps?.buildHappyCliSubprocessLaunchSpecFn ?? buildHappyCliSubprocessLaunchSpec;

  const resolveLaunch = (input: Readonly<{
    terminalKey?: string;
    launch?: DaemonTerminalLaunchIntent;
  }>): Readonly<{
    terminalKey: string;
    launch?: Readonly<{ file: string; args: readonly string[]; env?: Readonly<Record<string, string>> }>;
  }> | null => {
    if (input.launch?.kind === 'session_attach') {
      const sessionId = input.launch.sessionId;
      try {
        const launchSpec = buildHappyCliSubprocessLaunchSpecFn(['attach', sessionId]);
        return {
          terminalKey: `session-attach:${sessionId}`,
          launch: {
            file: launchSpec.filePath,
            args: launchSpec.args,
            ...(launchSpec.env ? { env: launchSpec.env } : {}),
          },
        };
      } catch {
        return null;
      }
    }
    if (input.launch?.kind === 'happier_cli') {
      try {
        const launchSpec = buildHappyCliSubprocessLaunchSpecFn(input.launch.args);
        return {
          terminalKey: input.terminalKey ?? `happier-cli:${JSON.stringify(input.launch.args)}`,
          launch: {
            file: launchSpec.filePath,
            args: launchSpec.args,
            ...(launchSpec.env ? { env: launchSpec.env } : {}),
          },
        };
      } catch {
        return null;
      }
    }
    return input.terminalKey ? { terminalKey: input.terminalKey } : null;
  };

  const resolveCwd = (cwdInput: unknown): { ok: true; cwd: string } | ReturnType<typeof err> => {
    const raw = typeof cwdInput === 'string' && cwdInput.trim().length > 0 ? cwdInput.trim() : workingDirectory;
    const expanded = expandHomeDirPath(raw, env, platform);

    const validation = authorizeFilesystemPath({
      targetPath: expanded,
      defaultDirectory: workingDirectory,
      accessPolicy,
      platform,
    });
    if (!validation.valid) {
      return err('terminal_cwd_denied');
    }
    return { ok: true, cwd: validation.resolvedPath };
  };

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_ENSURE, async (raw: unknown) => {
    if (!config.enabled) return err('terminal_disabled');
    const parsed = DaemonTerminalEnsureRequestSchema.safeParse(raw);
    if (!parsed.success) return err('terminal_invalid_request');

    const cwd = resolveCwd(parsed.data.cwd);
    if (!cwd.ok) return cwd;
    const resolvedLaunch = resolveLaunch(parsed.data);
    if (!resolvedLaunch) return err('terminal_spawn_failed');

    return getSessionManager().ensure({
      terminalKey: resolvedLaunch.terminalKey,
      cwd: cwd.cwd,
      cols: parsed.data.cols,
      rows: parsed.data.rows,
      initialCommand: parsed.data.initialCommand,
      ...(resolvedLaunch.launch ? { launch: resolvedLaunch.launch } : {}),
    });
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_STREAM_READ, async (raw: unknown) => {
    if (!config.enabled) return err('terminal_disabled');
    const parsed = DaemonTerminalStreamReadRequestSchema.safeParse(raw);
    if (!parsed.success) return err('terminal_invalid_request');

    return getSessionManager().read({
      terminalId: parsed.data.terminalId,
      cursor: parsed.data.cursor,
      maxBytes: parsed.data.maxBytes ?? config.readDefaults.maxBytes,
      maxEvents: parsed.data.maxEvents ?? config.readDefaults.maxEvents,
    });
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_INPUT, async (raw: unknown) => {
    if (!config.enabled) return err('terminal_disabled');
    const parsed = DaemonTerminalInputRequestSchema.safeParse(raw);
    if (!parsed.success) return err('terminal_invalid_request');
    return getSessionManager().input(parsed.data);
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_RESIZE, async (raw: unknown) => {
    if (!config.enabled) return err('terminal_disabled');
    const parsed = DaemonTerminalResizeRequestSchema.safeParse(raw);
    if (!parsed.success) return err('terminal_invalid_request');
    return getSessionManager().resize(parsed.data);
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_CLOSE, async (raw: unknown) => {
    if (!config.enabled) return err('terminal_disabled');
    const parsed = DaemonTerminalCloseRequestSchema.safeParse(raw);
    if (!parsed.success) return err('terminal_invalid_request');
    return getSessionManager().close(parsed.data);
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_TERMINAL_RESTART, async (raw: unknown) => {
    if (!config.enabled) return err('terminal_disabled');
    const parsed = DaemonTerminalRestartRequestSchema.safeParse(raw);
    if (!parsed.success) return err('terminal_invalid_request');

    const cwd = resolveCwd(parsed.data.cwd);
    if (!cwd.ok) return cwd;
    const resolvedLaunch = resolveLaunch(parsed.data);
    if (!resolvedLaunch) return err('terminal_spawn_failed');

    return getSessionManager().restart({
      terminalKey: resolvedLaunch.terminalKey,
      cwd: cwd.cwd,
      cols: parsed.data.cols,
      rows: parsed.data.rows,
      initialCommand: parsed.data.initialCommand,
      ...(resolvedLaunch.launch ? { launch: resolvedLaunch.launch } : {}),
    });
  });
}
