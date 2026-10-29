import { resolve as resolvePath, parse as parsePath } from 'node:path';

import chalk from 'chalk';

import { configuration } from '@/configuration';
import { decodeJwtPayload } from '@/cloud/decodeJwtPayload';
import { resolveMachineIdForServerFromSettings } from '@/daemon/resolveMachineIdForServerFromSettings';
import { hasFlag, readFlagValue } from '@/cli/commands/shared/argvFlags';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { resolveEffectiveMcpServersForDirectory } from '@/mcp/servers/resolveEffectiveMcpServersForDirectory';
import { printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { readMcpServersSettingsFromAccountSettings } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import { loadFreshMcpAccountSettingsContext } from '../loadFreshMcpAccountSettingsContext';

import type { McpCommandDeps } from '../deps';
import { cmd, fail } from '@happier-dev/cli-common/output';

function summarizeMcpServersForJson(settings: ReturnType<typeof readMcpServersSettingsFromAccountSettings>): unknown {
  const bindingCountByServerId = new Map<string, number>();
  for (const binding of settings.bindings) {
    bindingCountByServerId.set(binding.serverId, (bindingCountByServerId.get(binding.serverId) ?? 0) + 1);
  }

  return {
    strictMode: settings.strictMode,
    servers: settings.servers.map((server) => ({
      id: server.id,
      name: server.name,
      transport: server.transport,
      bindingCount: bindingCountByServerId.get(server.id) ?? 0,
    })),
  };
}

export async function cmdMcpServersList(
  argv: string[],
  deps: McpCommandDeps,
  opts: Readonly<{ json: boolean }>,
): Promise<void> {
  const details = hasFlag(argv, '--details');
  const name = readFlagValue(argv, '--name');
  if (details && (!opts.json || !name || name.startsWith('-'))) {
    throw new Error('MCP declaration details require --name <name> and --json');
  }
  const credentials = await deps.readCredentials();
  if (!credentials) {
    if (opts.json) {
      await printJsonEnvelope({ ok: false, kind: 'mcp_servers_list', error: { code: 'not_authenticated' } }, { exitCode: 1 });
      return;
    }
    console.error(fail(`Not signed in. Run ${cmd('happier auth login')} first.`));
    process.exitCode = 1;
    return;
  }

  const ctx = await loadFreshMcpAccountSettingsContext(credentials, deps);
  const mcpSettings = readMcpServersSettingsFromAccountSettings(ctx.settings);

  if (details && name) {
    if (ctx.source !== 'network') {
      throw new Error('Fresh account settings are required for MCP declaration details');
    }
    const subject = decodeJwtPayload(credentials.token)?.sub;
    const accountId = typeof subject === 'string' ? subject.trim() : '';
    if (!accountId) throw new Error('Cannot establish the account identity for MCP declaration details');
    const settings = await deps.readSettings();
    const machineId = resolveMachineIdForServerFromSettings(settings, configuration.activeServerId, accountId);
    if (!machineId) throw new Error('No existing machine identity for this server and account');
    const server = mcpSettings.servers.find((entry) => entry.name === name) ?? null;
    const bindings = server ? mcpSettings.bindings.filter((binding) => binding.serverId === server.id) : [];
    const directory = resolvePath(expandHomeDirPath(readFlagValue(argv, '--dir') ?? process.cwd()));
    // Root observes the machine/all-machine default; workspace roots cover each declared refinement.
    const directories = new Set([parsePath(directory).root, directory]);
    for (const binding of bindings) {
      if (binding.target.t === 'workspace' && binding.target.machineId === machineId) {
        directories.add(binding.target.workspaceRoot);
      }
    }
    const effective = server ? [...directories].map((currentDirectory) => {
      const resolution = resolveEffectiveMcpServersForDirectory({
        settings: mcpSettings, machineId, directory: currentDirectory,
      });
      const selected = resolution.serversByName[name];
      if (!selected) throw new Error('Named MCP server is missing from the parsed settings');
      return { directory: resolution.directory, serverId: selected.serverId,
        bindingId: selected.bindingId, enabled: selected.enabled, stdio: selected.config.stdio ?? null };
    }) : [];
    await printJsonEnvelope({ ok: true, kind: 'mcp_servers_list', data: {
      settingsVersion: ctx.settingsVersion, source: ctx.source,
      serverUrl: configuration.serverUrl, apiServerUrl: configuration.apiServerUrl,
      accountId, machineId,
      server: server ? { id: server.id, name: server.name, transport: server.transport, stdio: server.stdio ?? null } : null,
      bindings: bindings.map((binding) => ({ id: binding.id, serverId: binding.serverId,
        enabled: binding.enabled, target: binding.target,
        ...(binding.overrides?.stdio ? { overrides: { stdio: binding.overrides.stdio } } : {}),
      })),
      effective,
    } });
    return;
  }

  const listed = name ? { ...mcpSettings, servers: mcpSettings.servers.filter((entry) => entry.name === name) } : mcpSettings;
  if (opts.json) {
    await printJsonEnvelope({ ok: true, kind: 'mcp_servers_list', data: summarizeMcpServersForJson(listed) });
    return;
  }

  console.log(chalk.gray(`MCP servers: ${listed.servers.length}`));
  for (const server of listed.servers) {
    console.log(`- ${server.name} (${server.transport})`);
  }
}
