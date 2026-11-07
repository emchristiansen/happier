import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeSystemTask } from '@happier-dev/cli-common/systemTasks';
import { SETUP_PAIRING_PROMPT_KIND, type SystemTaskJsonValue } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  configureRelay,
  registerRelayProfile,
  controlDaemonService,
  installService,
  requestAuthPairing,
  waitForAuthPairing,
} from '../localDaemonCli.js';
import { createHsetupSystemTaskRegistry } from '../registry.js';
import { createSetupThisComputerKind } from './setupThisComputer.js';

/**
 * R13 (a): a stack/dev-launched app inherits a server selection (`HAPPIER_ACTIVE_SERVER_ID`,
 * `HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID`, `HAPPIER_SERVER_URL`) pinned to relay X, while the person
 * sets this computer up for relay Y. Every command the run issues must address Y — or, for the
 * lifecycle observation made before `server set`, the relay this Happier home's persisted
 * selection names (what the default-following service serves) — never the inherited pin.
 *
 * The real command builders spawn a CLI at the process boundary; the CLI resolves its relay with
 * the precedence of `apps/cli/src/configuration.ts` `resolveServerSelection` over a persisted
 * settings file that its own `server set` rewrites, and logs which profile each command addressed.
 */
const RELAY_X = 'https://relay-x.example.test';
const RELAY_Y = 'https://relay-y.example.test';
const RELAY_Z = 'https://relay-z.example.test';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fakeCliScript(params: Readonly<{ settingsPath: string; logPath: string }>): string {
  return `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const out = (value) => console.log(JSON.stringify(value));
if (has('--version')) { console.log('0.2.13'); process.exit(0); }
const settings = JSON.parse(fs.readFileSync(${JSON.stringify(params.settingsPath)}, 'utf8'));
const env = process.env;
const envUrl = String(env.HAPPIER_PUBLIC_SERVER_URL || env.HAPPIER_SERVER_URL || '').trim();
const envId = String(env.HAPPIER_ACTIVE_SERVER_ID || '').trim();
const byUrl = (url) => Object.keys(settings.servers).find((id) => settings.servers[id].serverUrl === url);
// configuration.ts: an env-selected persisted profile that does not match the env URL wins; else
// the env id or the URL-matching profile; with no env URL, the persisted active profile (its id
// still replaced by an env id).
const serverId = envUrl
  ? (envId && settings.servers[envId] && settings.servers[envId].serverUrl !== envUrl ? envId : (envId || byUrl(envUrl) || 'derived'))
  : (envId || settings.activeServerId);
const lifecycleId = String(env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID || '').trim() || serverId;
const serverUrl = (settings.servers[serverId] && settings.servers[serverId].serverUrl) || envUrl;
fs.appendFileSync(${JSON.stringify(params.logPath)}, JSON.stringify({ args, serverId, lifecycleId }) + '\\n');
const key = new URL(serverUrl).host;
if (args[0] === 'server' && args[1] === 'set') {
  const target = args[args.indexOf('--server-url') + 1];
  settings.activeServerId = byUrl(target);
  fs.writeFileSync(${JSON.stringify(params.settingsPath)}, JSON.stringify(settings));
  out({ ok: true, kind: 'server_set', data: { active: { serverUrl: target, comparableKey: new URL(target).host } } });
} else if (args[0] === 'daemon' && args[1] === 'status') {
  const installed = settings.installedByServerId?.[serverId] === true;
  out({
    server: { activeServerId: serverId, serverUrl, localServerUrl: null, publicServerUrl: serverUrl, webappUrl: serverUrl, comparableKey: key },
    daemon: { running: false, pid: null, httpPort: null },
    service: { installed, running: false, targetMode: installed ? 'default-following' : null },
    auth: { authenticated: false, machineRegistered: false, machineId: null, needsAuth: true, accountId: null },
  });
} else if (args[0] === 'auth' && args[1] === 'status') {
  out({ ok: false, error: { code: 'not_authenticated' } });
  process.exit(1);
} else if (args[0] === 'auth' && args[1] === 'request') {
  out({ publicKey: 'cHVibGljLWtleQ==', publicKeyB64Url: 'cHVibGljLWtleQ', pairingRequirement: 'compatible' });
} else if (args[0] === 'auth' && args[1] === 'wait') {
  out({ machineId: 'machine-' + serverId });
} else if (args[1] === 'service' && args[2] === 'list') {
  out({ entries: [], services: [], capabilities: { pinnedServiceCoexistence: true } });
} else if (args[1] === 'service' && args[2] === 'install' && has('--dry-run')) {
  out({ ok: true, plan: {} });
} else if (args[1] === 'service' && args[2] === 'install') {
  settings.installedByServerId = { ...settings.installedByServerId, [serverId]: true };
  fs.writeFileSync(${JSON.stringify(params.settingsPath)}, JSON.stringify(settings));
  out({ ok: true });
} else {
  out({ ok: true });
}
`;
}

async function createStackLaunchedComputer() {
  const root = await mkdtemp(join(tmpdir(), 'hsetup-r13a-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  const settingsPath = join(root, 'settings.json');
  const logPath = join(root, 'cli.log');
  // The default-following service serves Z (this home's persisted selection); the launch is pinned to X.
  await writeFile(settingsPath, JSON.stringify({
    activeServerId: 'relay-z',
    servers: {
      'stack-x': { serverUrl: RELAY_X },
      'relay-y': { serverUrl: RELAY_Y },
      'relay-z': { serverUrl: RELAY_Z },
    },
  }));
  const cliPath = join(bin, 'happier');
  await writeFile(cliPath, fakeCliScript({ settingsPath, logPath }));
  await chmod(cliPath, 0o755);

  for (const name of ['HAPPIER_BOOTSTRAP_CLI_PATH', 'HAPPIER_BOOTSTRAP_HAPPIER_PATH', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL', 'HAPPIER_LOCAL_SERVER_URL']) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv('HOME', home);
  vi.stubEnv('HAPPIER_HOME_DIR', join(home, '.happier'));
  vi.stubEnv('PATH', bin);
  vi.stubEnv('HAPPIER_ACTIVE_SERVER_ID', 'stack-x');
  vi.stubEnv('HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID', 'stack-x');
  vi.stubEnv('HAPPIER_SERVER_URL', RELAY_X);

  const kind = createSetupThisComputerKind({
    inspectCliChoice: async () => ({ choice: null, question: null }),
    recordCliChoice: async () => undefined,
    removePathExposure: async () => ({ removed: false, failure: null }),
    ensureCli: async () => ({ command: cliPath, provenance: 'override', version: '0.2.13' }),
    configureRelay,
    registerRelayProfile,
    requestAuthPairing,
    waitForAuthPairing,
    installService,
    startService: controlDaemonService,
    ensurePathExposure: async () => ({ changed: false, shellReloadHint: null, failure: null }),
  });

  const run = async () => await kind.run({
    params: {
      activeRelayUrl: RELAY_Y,
      activeWebappUrl: RELAY_Y,
      activeLocalRelayUrl: null,
      channel: 'stable',
      expectedAccountId: 'acct_app',
    } satisfies Record<string, SystemTaskJsonValue>,
    emit: () => undefined,
    prompt: async (prompt) => (prompt.kind === SETUP_PAIRING_PROMPT_KIND ? { approved: true } : { approved: false }),
  });

  const readLog = async () => (await readFile(logPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { args: string[]; serverId: string; lifecycleId: string })
    .map((entry) => ({ command: entry.args.filter((arg) => !arg.startsWith('-')).join(' '), serverId: entry.serverId, lifecycleId: entry.lifecycleId }));

  // The app's own reads and actions on this computer (`daemon.service.*.v1`), through the CLI the
  // app resolves for them.
  const runAppTask = async (kind: string) => {
    vi.stubEnv('HAPPIER_BOOTSTRAP_CLI_PATH', cliPath);
    try {
      return await executeSystemTask({
        spec: { protocolVersion: 1, kind, params: { target: { kind: 'local' }, channel: 'stable' } },
        taskId: `r13a-${kind}`,
        registry: createHsetupSystemTaskRegistry(),
        emitEvent: () => undefined,
      });
    } finally {
      vi.stubEnv('HAPPIER_BOOTSTRAP_CLI_PATH', undefined);
    }
  };

  return { run, readLog, runAppTask };
}

describe.skipIf(process.platform === 'win32')('setup runs against one target-scoped context (R13 a)', () => {
  it('addresses the target relay with every command, not the relay the app launch was pinned to', async () => {
    const computer = await createStackLaunchedComputer();

    const result = await computer.run();

    expect(result).toMatchObject({ machineId: 'machine-relay-y', relayChanged: true, credentialsChanged: true, serviceAction: 'install' });
    expect(await computer.readLog()).toEqual([
      // The run's own CLI's service inventory, read for this home's selection — never the launch pin.
      { command: 'daemon service list', serverId: 'relay-z', lifecycleId: 'relay-z' },
      // Preflight: judged for Y before anything selects it.
      { command: 'daemon service install', serverId: 'relay-y', lifecycleId: 'relay-y' },
      { command: 'auth status', serverId: 'relay-y', lifecycleId: 'relay-y' },
      // What the default-following service serves before the change: this home's selection, Z.
      { command: 'daemon status', serverId: 'relay-z', lifecycleId: 'relay-z' },
      // Apply: every command after `server set` addresses Y.
      { command: 'server set https://relay-y.example.test https://relay-y.example.test', serverId: 'relay-z', lifecycleId: 'relay-z' },
      { command: 'auth status', serverId: 'relay-y', lifecycleId: 'relay-y' },
      { command: 'auth request', serverId: 'relay-y', lifecycleId: 'relay-y' },
      { command: 'auth wait cHVibGljLWtleQ==', serverId: 'relay-y', lifecycleId: 'relay-y' },
      { command: 'daemon service install', serverId: 'relay-y', lifecycleId: 'relay-y' },
      { command: 'daemon service start', serverId: 'relay-y', lifecycleId: 'relay-y' },
    ]);
  });

  /**
   * One context rule for reads and writes: the app proves this computer ready from its own status
   * read, so that read must answer for the relay setup wrote (this home's persisted selection),
   * not the relay the launch was pinned to — otherwise a stack-launched app is never "ready".
   */
  it('reads and acts on this computer through the persisted selection setup wrote, not the launch pin', async () => {
    const computer = await createStackLaunchedComputer();

    const before = await computer.runAppTask('daemon.service.status.v1');
    expect(before).toMatchObject({ ok: true, data: { server: { activeServerId: 'relay-z', serverUrl: RELAY_Z } } });

    await computer.run();
    const after = await computer.runAppTask('daemon.service.status.v1');
    expect(after).toMatchObject({ ok: true, data: { server: { activeServerId: 'relay-y', serverUrl: RELAY_Y } } });

    await computer.runAppTask('daemon.service.stop.v1');
    const appCommands = (await computer.readLog()).filter((entry) => entry.command === 'daemon service stop' || entry.command === 'daemon status');
    expect(appCommands.every((entry) => entry.serverId !== 'stack-x' && entry.lifecycleId !== 'stack-x')).toBe(true);
    expect(appCommands.at(-2)).toEqual({ command: 'daemon service stop', serverId: 'relay-y', lifecycleId: 'relay-y' });
  });
});
