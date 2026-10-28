import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { McpServerConfig } from '@/agent/core';
import {
  createProtectedLocalStateDirectory,
  createProtectedLocalStateFileExclusive,
  ensureProtectedLocalStateDirectory,
} from '@/utils/fs/protectedLocalState';
import { createAbsolutePathSymlink } from '@/utils/fs/createAbsolutePathSymlink';
import { expandHomeDirPath, resolveHomeDirFromEnvironment } from '@/utils/path/expandHomeDirPath';

type EnvLike = Readonly<Record<string, string | undefined>>;
type DevinConfigEnvironmentKey = 'APPDATA' | 'XDG_CONFIG_HOME';

function resolveDevinConfigEnvironmentKey(platform: NodeJS.Platform): DevinConfigEnvironmentKey {
  return platform === 'win32' ? 'APPDATA' : 'XDG_CONFIG_HOME';
}

export function resolveDevinConfigPaths(
  env: EnvLike,
  platform: NodeJS.Platform = process.platform,
): Readonly<{
  configRoot: string;
  devinConfigDir: string;
  mainConfigPath: string;
  mcpConfigPath: string;
}> {
  const configEnvironmentKey = resolveDevinConfigEnvironmentKey(platform);
  const configuredRoot = env[configEnvironmentKey]?.trim() ?? '';
  const configRoot = expandHomeDirPath(configuredRoot, env, platform)
    || (platform === 'win32'
      ? join(resolveHomeDirFromEnvironment(env, platform), 'AppData', 'Roaming')
      : join(resolveHomeDirFromEnvironment(env, platform), '.config'));
  const devinConfigDir = join(configRoot, 'devin');
  return {
    configRoot,
    devinConfigDir,
    mainConfigPath: join(devinConfigDir, 'config.json'),
    mcpConfigPath: join(devinConfigDir, 'mcp_config.json'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readUserMcpConfig(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse Devin MCP config at ${path}`, { cause: error });
  }
}

async function linkOptionalConfigEntry(params: Readonly<{
  source: string;
  destination: string;
}>): Promise<void> {
  let sourceStat;
  try {
    sourceStat = await stat(params.source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await mkdir(dirname(params.destination), { recursive: true, mode: 0o700 });
  await createAbsolutePathSymlink({
    sourcePath: params.source,
    destinationPath: params.destination,
    sourceKind: sourceStat.isDirectory() ? 'directory' : 'file',
  });
}

async function projectOptionalConfigTree(params: Readonly<{
  source: string;
  destination: string;
  excludedSourcePaths?: readonly string[];
}>): Promise<void> {
  const excludedSourcePaths = new Set(
    (params.excludedSourcePaths ?? []).map((path) => resolve(path)),
  );
  let entryNames: readonly string[];
  try {
    entryNames = await readdir(params.source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await mkdir(params.destination, { recursive: true, mode: 0o700 });
  await Promise.all(entryNames.map(async (entryName) => {
    const source = join(params.source, entryName);
    if (excludedSourcePaths.has(resolve(source))) return;
    await linkOptionalConfigEntry({
      source,
      destination: join(params.destination, entryName),
    });
  }));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function resolveDevinProjectConfigDirectories(
  cwd: string,
  hasVcsRoot: (directory: string) => Promise<boolean> = async (directory) => (
    await pathExists(join(directory, '.git')) || await pathExists(join(directory, '.jj'))
  ),
): Promise<readonly string[]> {
  const candidates: string[] = [];
  let current = resolve(cwd);
  while (true) {
    candidates.push(current);
    if (await hasVcsRoot(current)) {
      return candidates;
    }
    const parent = dirname(current);
    if (parent === current) return candidates.slice(0, 1);
    current = parent;
  }
}

async function assertNoProjectMcpServerShadowsSession(params: Readonly<{
  cwd: string;
  sessionServerNames: readonly string[];
}>): Promise<void> {
  if (params.sessionServerNames.length === 0) return;
  const sessionServerNames = new Set(params.sessionServerNames);
  const projectDirectories = await resolveDevinProjectConfigDirectories(params.cwd);
  for (const directory of projectDirectories) {
    for (const fileName of ['mcp_config.json', 'mcp_config.local.json']) {
      const path = join(directory, '.devin', fileName);
      const config = await readUserMcpConfig(path);
      const servers = isRecord(config.mcpServers) ? config.mcpServers : {};
      for (const name of Object.keys(servers)) {
        if (!sessionServerNames.has(name)) continue;
        throw new Error(
          `Devin project MCP config at ${path} shadows the session MCP server '${name}'. Rename or disable the project server before starting this Happier session.`,
        );
      }
    }
  }
}

function restoreMcpChildConfigEnvironment(
  value: unknown,
  originalConfigRoot: string,
  configEnvironmentKey: DevinConfigEnvironmentKey,
): unknown {
  if (!isRecord(value) || typeof value.command !== 'string') return value;
  const existingEnv = isRecord(value.env) ? value.env : {};
  return {
    ...value,
    env: {
      [configEnvironmentKey]: originalConfigRoot,
      ...existingEnv,
    },
  };
}

function materializeSessionMcpServer(
  config: McpServerConfig,
  originalConfigRoot: string,
  configEnvironmentKey: DevinConfigEnvironmentKey,
): Record<string, unknown> {
  return {
    command: config.command,
    args: config.args ?? [],
    env: {
      [configEnvironmentKey]: originalConfigRoot,
      ...config.env,
    },
    transport: 'stdio',
  };
}

export async function prepareDevinMcpProcessLaunch(params: Readonly<{
  cwd: string;
  platform?: NodeJS.Platform;
  processEnv: EnvLike;
  mcpServers: Readonly<Record<string, McpServerConfig>>;
}>): Promise<Readonly<{
  env: Readonly<Record<string, string>>;
  cleanup: () => Promise<void>;
}>> {
  if (Object.keys(params.mcpServers).length === 0) {
    return { env: {}, cleanup: () => Promise.resolve() };
  }

  await assertNoProjectMcpServerShadowsSession({
    cwd: params.cwd,
    sessionServerNames: Object.keys(params.mcpServers),
  });
  const platform = params.platform ?? process.platform;
  const configEnvironmentKey = resolveDevinConfigEnvironmentKey(platform);
  const sourcePaths = resolveDevinConfigPaths(params.processEnv, platform);
  const userConfig = await readUserMcpConfig(sourcePaths.mcpConfigPath);
  const userServers = isRecord(userConfig.mcpServers) ? userConfig.mcpServers : {};
  const mergedServers = Object.fromEntries([
    ...Object.entries(userServers).map(([name, config]) => [
      name,
      restoreMcpChildConfigEnvironment(config, sourcePaths.configRoot, configEnvironmentKey),
    ]),
    ...Object.entries(params.mcpServers).map(([name, config]) => [
      name,
      materializeSessionMcpServer(config, sourcePaths.configRoot, configEnvironmentKey),
    ]),
  ]);

  const overlayRoot = await createProtectedLocalStateDirectory(
    join(tmpdir(), 'happier-devin-acp-'),
  );
  try {
    const overlayDevinDir = join(overlayRoot, 'devin');
    await Promise.all([
      projectOptionalConfigTree({
        source: sourcePaths.devinConfigDir,
        destination: overlayDevinDir,
        excludedSourcePaths: [sourcePaths.mcpConfigPath],
      }),
      linkOptionalConfigEntry({
        source: join(sourcePaths.configRoot, 'cognition'),
        destination: join(overlayRoot, 'cognition'),
      }),
    ]);
    await ensureProtectedLocalStateDirectory(overlayDevinDir);
    await createProtectedLocalStateFileExclusive(
      join(overlayDevinDir, 'mcp_config.json'),
      JSON.stringify({ ...userConfig, mcpServers: mergedServers }),
    );

    return {
      env: { [configEnvironmentKey]: overlayRoot },
      cleanup: async () => {
        await rm(overlayRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(overlayRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
