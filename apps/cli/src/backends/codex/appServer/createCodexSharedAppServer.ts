import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import { logger } from '@/ui/logger';
import { resolveWindowsCommandInvocation } from '@happier-dev/cli-common/process';

import {
  createCodexAppServerClient,
  sanitizeCodexAppServerEnv,
  type DisposableCodexAppServerClient,
} from './client/createCodexAppServerClient';
import { readCodexAppServerStartupRpcTimeoutMs } from './client/codexAppServerRpcTimeout';
import { appendCodexCliConfigOverridesArgs } from '../utils/appendCodexCliConfigOverridesArgs';
import { resolveCodexCliInvocation } from '../utils/resolveCodexCliInvocation';

type InvocationResolver = (params: Readonly<{
  args: string[];
  cwd: string;
  processEnv: NodeJS.ProcessEnv;
}>) => Promise<Readonly<{ command: string; args: string[] }>>;

type SharedServerDependencies = Readonly<{
  createRuntimeDirectory: () => Promise<string>;
  resolveInvocation: InvocationResolver;
  spawnProcess: typeof spawn;
  waitForSocket: (socketPath: string, child: ChildProcess, timeoutMs: number) => Promise<void>;
  createClient: typeof createCodexAppServerClient;
  terminateProcess: (child: ChildProcess) => Promise<void>;
  removeRuntimeDirectory: (directory: string) => Promise<void>;
}>;

async function waitForSocket(socketPath: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  let terminalError: Error | null = null;
  child.once('error', (error) => { terminalError = error; });
  child.once('exit', (code, signal) => {
    terminalError = new Error(`Codex shared app-server exited before its socket was ready (${code ?? signal ?? 'unknown'})`);
  });
  while (Date.now() - startedAt < timeoutMs) {
    if (terminalError) throw terminalError;
    try {
      await stat(socketPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for Codex shared app-server socket at ${socketPath}`);
}

function defaultDependencies(): SharedServerDependencies {
  return {
    createRuntimeDirectory: async () => await mkdtemp(join(tmpdir(), 'happier-codex-')),
    resolveInvocation: async ({ args, cwd, processEnv }) => await resolveCodexCliInvocation({
      args,
      cwd,
      processEnv,
      overrideEnvVarKeys: ['HAPPIER_CODEX_APP_SERVER_BIN', 'HAPPIER_CODEX_TUI_BIN', 'HAPPY_CODEX_TUI_BIN'],
      targetLabel: 'Codex app-server',
    }),
    spawnProcess: spawn,
    waitForSocket,
    createClient: createCodexAppServerClient,
    terminateProcess: async (child) => await killProcessTree(child),
    removeRuntimeDirectory: async (directory) => await rm(directory, { recursive: true, force: true }),
  };
}

export async function createCodexSharedAppServer(params: Readonly<{
  directory: string;
  processEnv?: NodeJS.ProcessEnv;
  configOverrides?: readonly string[];
  dependencies?: Partial<SharedServerDependencies>;
}>): Promise<Readonly<{
  endpoint: string;
  createClient: () => Promise<DisposableCodexAppServerClient>;
  dispose: () => Promise<void>;
}>> {
  const dependencies = { ...defaultDependencies(), ...params.dependencies };
  const processEnv = sanitizeCodexAppServerEnv(params.processEnv ?? process.env);
  const runtimeDirectory = await dependencies.createRuntimeDirectory();
  // Leave the socket parent absent so Codex creates it with its cross-platform
  // private-directory policy (0700 on Unix, a user-only DACL on Windows).
  const socketPath = join(runtimeDirectory, 'private', 'app-server.sock');
  const endpoint = `unix://${socketPath}`;
  let child: ChildProcess | null = null;
  let disposed = false;
  try {
    const baseInvocation = await dependencies.resolveInvocation({
      args: ['app-server', '--listen', endpoint],
      cwd: params.directory,
      processEnv,
    });
    const resolved = appendCodexCliConfigOverridesArgs(baseInvocation, params.configOverrides ?? []);
    const invocation = resolveWindowsCommandInvocation({
      command: resolved.command,
      args: resolved.args,
      env: processEnv,
      resolveCommandOnPath: true,
    });
    child = dependencies.spawnProcess(invocation.command, invocation.args, {
      cwd: params.directory,
      env: processEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    child.stderr?.on('data', (chunk) => {
      logger.debug('[codex-shared-app-server] stderr', String(chunk).trim());
    });
    await dependencies.waitForSocket(
      socketPath,
      child,
      readCodexAppServerStartupRpcTimeoutMs(processEnv),
    );
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      if (child) await dependencies.terminateProcess(child);
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    try {
      await dependencies.removeRuntimeDirectory(runtimeDirectory);
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Codex shared app-server startup and cleanup failed');
    throw error;
  }

  const serverChild = child;
  return {
    endpoint,
    createClient: async () => await dependencies.createClient({
      cwd: params.directory,
      processEnv,
      transport: { kind: 'unixWebSocket', socketPath },
    }),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await dependencies.terminateProcess(serverChild);
      await dependencies.removeRuntimeDirectory(runtimeDirectory);
    },
  };
}
