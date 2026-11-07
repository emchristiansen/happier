import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readHappierCliChoiceSync, resolveForeignHappierCli, writeHappierCliChoice } from '@happier-dev/cli-common/firstPartyRuntime';
import { executeSystemTask } from '@happier-dev/cli-common/systemTasks';
import { parseSetupCliChoicePromptData, SETUP_CLI_CHOICE_PROMPT_KIND, type SystemTaskJsonValue } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureSetupCapableLocalHappierCli } from '../happierCli.js';
import {
  configureRelay,
  registerRelayProfile,
  controlDaemonService,
  installService,
  requestAuthPairing,
  waitForAuthPairing,
} from '../localDaemonCli.js';
import { createHsetupSystemTaskRegistry } from '../registry.js';
import {
  createSetupThisComputerKind,
  ensureManagedCliPathExposureDefault,
  recordHappierCliChoiceDefault,
  removeManagedCliPathExposureDefault,
} from './setupThisComputer.js';

/**
 * R12's regression, composed: a user with an npm `happier` answers the one question, and the real
 * resolution, choice record, managed install, PATH exposure and service commands run against real
 * executables at the process boundary. Only the release download is replaced (by a local payload),
 * and the two CLIs are small scripts that answer the JSON commands setup issues and log who ran.
 */
const NPM_VERSION = '0.2.13';
const MANAGED_VERSION = '0.2.14';
const RELAY = 'https://relay.example.test';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fakeCliScript(params: Readonly<{ version: string; logPath: string; dryRun: unknown; userPinPath?: string }>): string {
  const status = {
    server: { activeServerId: 'custom', serverUrl: RELAY, localServerUrl: null, publicServerUrl: RELAY, webappUrl: RELAY, comparableKey: 'relay.example.test' },
    daemon: { running: true, pid: 4321, httpPort: 7777, startedWithCliVersion: params.version, serviceManaged: true, serviceLabel: 'happier.daemon' },
    service: { installed: true, running: true, targetMode: 'default-following' },
    auth: { authenticated: true, machineRegistered: true, machineId: 'machine-1', needsAuth: false, accountId: 'acct_app', credentialState: 'valid', validatedAccountId: 'acct_app' },
    // What the answering CLI derives for itself: the service runs it, so its version matches.
    runtimeConvergence: { controlReachable: true, serviceOwnsRunningDaemon: true, machineIdMatches: true, cliVersionMatches: true },
  };
  return `#!${process.execPath}
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(params.logPath)}, JSON.stringify({ cli: ${JSON.stringify(params.version)}, args }) + '\\n');
const has = (flag) => args.includes(flag);
const out = (value) => console.log(JSON.stringify(value));
if (has('--version')) console.log(${JSON.stringify(params.version)});
else if (args[0] === 'daemon' && args[1] === 'status') out(${JSON.stringify(status)});
else if (args[0] === 'auth' && args[1] === 'status') out({ ok: true, data: { authenticated: true, accountId: 'acct_app', machineId: 'machine-1' } });
else if (args[0] === 'server' && args[1] === 'set') out({ ok: true, data: { active: { serverUrl: ${JSON.stringify(RELAY)}, comparableKey: 'relay.example.test' } } });
else if (args[1] === 'service' && args[2] === 'list') out({ entries: ${params.userPinPath ? `[JSON.parse(require('node:fs').readFileSync(${JSON.stringify(params.userPinPath)}, 'utf8'))]` : '[]'}, services: [], capabilities: { pinnedServiceCoexistence: true } });
else if (args[1] === 'service' && args[2] === 'install' && has('--dry-run')) out(${JSON.stringify(params.dryRun)});
else out({ ok: true });
`;
}

async function createComputer(options: Readonly<{ brokenNpmCli?: boolean; userOwnedPin?: boolean }> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hsetup-r12-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const logPath = join(root, 'cli.log');
  await mkdir(home, { recursive: true });
  const userPinPath = options.userOwnedPin ? join(root, 'user-pinned-service.json') : undefined;
  if (userPinPath) {
    await writeFile(userPinPath, JSON.stringify({
      targetMode: 'pinned', releaseChannel: 'stable', serverId: 'custom', activeServerId: 'custom',
      relayUrl: RELAY, happierHomeDir: join(home, '.happier'), managedBy: null,
      command: '/user-owned/happier', autostart: 'at-login',
    }));
  }

  // An npm global install: `<prefix>/bin/happier` → the package's own entry, with its package.json.
  const packageRoot = join(root, 'npm-global', 'lib', 'node_modules', '@happier-dev', 'cli');
  const npmBin = join(root, 'npm-global', 'bin');
  const npmCli = join(npmBin, 'happier');
  await mkdir(join(packageRoot, 'bin'), { recursive: true });
  await mkdir(npmBin, { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@happier-dev/cli', version: NPM_VERSION }));
  await writeFile(join(packageRoot, 'bin', 'happier.cjs'), options.brokenNpmCli
    // A CLI that answers nothing setup can read (a pre-0.2 build, or one that errors).
    ? `#!${process.execPath}\nprocess.exit(3);\n`
    : fakeCliScript({ version: NPM_VERSION, logPath, dryRun: { ok: true, plan: {} }, userPinPath }));
  await chmod(join(packageRoot, 'bin', 'happier.cjs'), 0o755);
  await symlink(join(packageRoot, 'bin', 'happier.cjs'), npmCli);

  // The managed release payload; its CLI's dry-run proposes switching the service off the npm CLI.
  const payloadRoot = join(root, 'payload');
  await mkdir(join(payloadRoot, 'package-dist'), { recursive: true });
  await writeFile(join(payloadRoot, 'package-dist', 'index.mjs'), 'export {};\n');
  const managedShim = join(home, '.happier', 'bin', 'happier');
  await writeFile(join(payloadRoot, 'happier'), fakeCliScript({
    version: MANAGED_VERSION,
    logPath,
    userPinPath,
    dryRun: {
      ok: true,
      plan: {},
      installConflict: {
        blocking: false,
        message: `The background service runs ${npmCli}; installing switches it to ${managedShim}.`,
        competingServices: [],
        servicesToRemove: [],
        runtimeReplacement: { current: npmCli, replacement: managedShim },
      },
    },
  }));
  await chmod(join(payloadRoot, 'happier'), 0o755);

  for (const name of ['HAPPIER_HOME_DIR', 'HAPPIER_BOOTSTRAP_CLI_PATH', 'HAPPIER_BOOTSTRAP_HAPPIER_PATH', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID', 'HAPPIER_NO_PATH_UPDATE']) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv('HOME', home);
  vi.stubEnv('SHELL', '/bin/bash');
  vi.stubEnv('PATH', npmBin);
  vi.stubEnv('HAPPIER_STACK_REPO_DIR', join(root, 'elsewhere'));

  const preparePayload = vi.fn(async () => ({ versionId: MANAGED_VERSION, payloadRoot, cleanup: async () => undefined }));
  const kind = createSetupThisComputerKind({
    recordCliChoice: recordHappierCliChoiceDefault,
    removePathExposure: removeManagedCliPathExposureDefault,
    ensureCli: (params) => ensureSetupCapableLocalHappierCli(params, { preparePayload }),
    configureRelay,
    registerRelayProfile,
    requestAuthPairing,
    waitForAuthPairing,
    installService,
    startService: controlDaemonService,
    ensurePathExposure: ensureManagedCliPathExposureDefault,
  });

  const run = async (choice: 'managed' | 'own', channel: 'stable' | 'preview' = 'stable', taskParams: Readonly<Record<string, SystemTaskJsonValue>> = {}) => {
    const prompts: string[] = [];
    const promptData: unknown[] = [];
    const result = await kind.run({
      params: {
        activeRelayUrl: RELAY,
        activeWebappUrl: RELAY,
        activeLocalRelayUrl: null,
        channel,
        expectedAccountId: 'acct_app',
        ...taskParams,
      } satisfies Record<string, SystemTaskJsonValue>,
      emit: () => undefined,
      prompt: async (prompt) => {
        prompts.push(prompt.kind);
        promptData.push(prompt.data);
        return prompt.kind === SETUP_CLI_CHOICE_PROMPT_KIND ? { choice } : { approved: true };
      },
    });
    return { result, prompts, promptData };
  };

  const readLog = async () => (await readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { cli: string; args: string[] });
  const readStatus = async () => await executeSystemTask({
    spec: { protocolVersion: 1, kind: 'daemon.service.status.v1', params: { target: { kind: 'local' }, channel: 'stable' } },
    taskId: 'r12-status',
    registry: createHsetupSystemTaskRegistry(),
    emitEvent: () => undefined,
  });

  return { home, npmBin, npmCli, managedShim, preparePayload, run, readLog, readStatus, userPinPath };
}

describe.skipIf(process.platform === 'win32')('one CLI per computer, composed (R12)', () => {
  it('Settings changes the home CLI in both directions while the active user-owned pin and relay identity stay untouched', async () => {
    const computer = await createComputer({ userOwnedPin: true });
    if (!computer.userPinPath) throw new Error('Expected the user-owned pin fixture.');
    const originalPin = await readFile(computer.userPinPath, 'utf8');
    const happierHome = join(computer.home, '.happier');
    await mkdir(join(happierHome, 'servers', 'custom'), { recursive: true });
    const identityFiles = [join(happierHome, 'settings.json'), join(happierHome, 'servers', 'custom', 'access.key')];
    for (const path of identityFiles) await writeFile(path, 'user-owned relay identity\n');
    await writeHappierCliChoice({ choice: { mode: 'own', command: computer.npmCli }, processEnv: process.env });

    const managed = await computer.run('managed', 'stable', { reconsiderCli: true, cliOnly: true });

    expect(managed.prompts).toEqual([SETUP_CLI_CHOICE_PROMPT_KIND]);
    expect(managed.result).toMatchObject({
      machineId: null, cliProvenance: 'managed', cliVersion: MANAGED_VERSION,
      relayChanged: false, credentialsChanged: false, serviceAction: 'none',
    });
    expect(readHappierCliChoiceSync({ processEnv: process.env })).toEqual({ mode: 'managed' });
    await vi.waitFor(async () => {
      expect(await readFile(join(computer.home, '.bashrc'), 'utf8')).toContain('Added by Happier Desktop');
    });
    vi.stubEnv('PATH', `${join(happierHome, 'bin')}:${computer.npmBin}`);

    const own = await computer.run('own', 'stable', { reconsiderCli: true, cliOnly: true });

    expect(own.prompts).toEqual([SETUP_CLI_CHOICE_PROMPT_KIND]);
    expect(own.result).toMatchObject({ machineId: null, cliProvenance: 'override', serviceAction: 'none' });
    expect(readHappierCliChoiceSync({ processEnv: process.env })).toEqual({ mode: 'own', command: computer.npmCli });
    expect(await readFile(join(computer.home, '.bashrc'), 'utf8')).not.toContain('Added by Happier Desktop');
    expect(await readFile(computer.userPinPath, 'utf8')).toBe(originalPin);
    for (const path of identityFiles) expect(await readFile(path, 'utf8')).toBe('user-owned relay identity\n');
    // Only executable-version probes are allowed: no relay, auth, inventory or service command.
    expect((await computer.readLog()).every((entry) => entry.args.length === 1 && entry.args[0] === '--version')).toBe(true);
  });

  it.each<Record<string, SystemTaskJsonValue>>([{ cliOnly: true }, { reconsiderCli: false, cliOnly: true }, { reconsiderCli: true, cliOnly: 'true' }])(
    'rejects an invalid CLI-only request before touching this computer: %j', async (taskParams) => {
      const computer = await createComputer({ userOwnedPin: true });
      await expect(computer.run('managed', 'stable', taskParams)).rejects.toMatchObject({ code: 'invalid_params' });
      expect(existsSync(join(computer.home, '.happier', 'cli-choice.json'))).toBe(false);
      expect(computer.preparePayload).not.toHaveBeenCalled();
    },
  );

  it('"Keep my own": no managed CLI is installed, no PATH line is written, and readiness is read from the npm CLI', async () => {
    const computer = await createComputer();

    const { result, prompts } = await computer.run('own');

    expect(prompts).toEqual([SETUP_CLI_CHOICE_PROMPT_KIND]);
    expect(result).toMatchObject({ cliProvenance: 'override', cliVersion: NPM_VERSION });
    expect(computer.preparePayload).not.toHaveBeenCalled();
    expect(existsSync(join(computer.home, '.happier', 'cli'))).toBe(false);
    expect(existsSync(join(computer.home, '.bashrc'))).toBe(false);
    expect(existsSync(join(computer.home, '.profile'))).toBe(false);

    const status = await computer.readStatus();
    expect(status).toMatchObject({
      ok: true,
      data: {
        acquisition: { command: computer.npmCli, provenance: 'override', version: NPM_VERSION },
        runtimeConvergence: { cliVersionMatches: true },
        cli: { choice: { mode: 'own', otherCli: { command: computer.npmCli, updateCommand: 'npm install -g @happier-dev/cli@latest' } } },
      },
    });
    // Every command setup and the status read ran — service install included — went to that CLI.
    expect(new Set((await computer.readLog()).map((entry) => entry.cli))).toEqual(new Set([NPM_VERSION]));
  });

  it('"Let Happier manage it": the managed CLI comes first on PATH and the service is switched to it with no second question', async () => {
    const computer = await createComputer();

    const { result, prompts } = await computer.run('managed');

    expect(prompts).toEqual([SETUP_CLI_CHOICE_PROMPT_KIND]);
    expect(result).toMatchObject({ cliProvenance: 'managed', cliVersion: MANAGED_VERSION });
    const managedCommands = (await computer.readLog()).filter((entry) => entry.cli === MANAGED_VERSION).map((entry) => entry.args.join(' '));
    expect(managedCommands).toContain('daemon service install --yes --replace-existing=all --json');

    // The PATH line lands even though the npm CLI resolves, and a new terminal then runs ours first.
    const binDir = join(computer.home, '.happier', 'bin');
    await vi.waitFor(async () => {
      expect(await readFile(join(computer.home, '.bashrc'), 'utf8')).toContain(`export PATH="${binDir}:$PATH"`);
    });
    // R13 (b): the old copy behind it is still found, so Settings keeps its removal hint and change.
    expect(resolveForeignHappierCli({ binDir, processEnv: { HOME: computer.home, PATH: `${binDir}:${computer.npmBin}` } })).toBe(computer.npmCli);

    // The app opened again from a terminal that now runs the managed CLI first.
    vi.stubEnv('PATH', `${binDir}:${computer.npmBin}`);
    const status = await computer.readStatus();
    expect(status).toMatchObject({
      ok: true,
      data: {
        acquisition: { provenance: 'managed', version: MANAGED_VERSION },
        cli: { choice: { mode: 'managed', otherCli: { command: computer.npmCli, removalCommand: 'npm uninstall -g @happier-dev/cli' } } },
      },
    });
  });

  it('a CLI nobody chose that fails the app-open read is the question, not a Retry: "own" ends by name with its update command, "manage" goes on', async () => {
    const computer = await createComputer({ brokenNpmCli: true });

    await expect(computer.readStatus()).resolves.toMatchObject({ ok: false, error: { code: 'cli_choice_required' } });

    await expect(computer.run('own')).rejects.toMatchObject({
      code: 'cli_own_below_setup_floor',
      message: expect.stringContaining('npm install -g @happier-dev/cli@latest'),
    });
    expect(computer.preparePayload).not.toHaveBeenCalled();

    // Kept but unusable: asked again, naming just the path, and this time managed.
    const managed = await computer.run('managed');
    expect(parseSetupCliChoicePromptData(managed.promptData[0])).toMatchObject({ command: computer.npmCli, version: null, belowSetupFloor: true });
    expect(managed.result).toMatchObject({ cliProvenance: 'managed', cliVersion: MANAGED_VERSION });
  });

  it('"Let Happier manage it" from an app of another channel adopts the default channel\'s managed CLI: the service switch is the only change (R10 D2 × R12)', async () => {
    const computer = await createComputer();

    const { result, prompts } = await computer.run('managed', 'preview');

    // The user's `happier` (and its service) follow the default channel, stable here: its managed CLI
    // replaces it, so the dry-run is the pure runtime switch the answer consents to — no other
    // ring's service to remove, and the default channel is not repointed.
    expect(prompts).toEqual([SETUP_CLI_CHOICE_PROMPT_KIND]);
    expect(computer.preparePayload).toHaveBeenCalledWith(expect.objectContaining({ channel: 'stable' }));
    expect(result).toMatchObject({ cliProvenance: 'managed', cliVersion: MANAGED_VERSION });
    expect(existsSync(join(computer.home, '.happier', 'cli', 'current.version'))).toBe(true);
    expect(existsSync(join(computer.home, '.happier', 'cli-preview'))).toBe(false);
  });

  it('a kept CLI that disappeared is asked about before anything stands in for it: "own" names reinstalling, "manage" goes on (R13)', async () => {
    const computer = await createComputer();
    // Managed once, then "Keep my own" — the managed copy is still on disk.
    await computer.run('managed');
    await writeHappierCliChoice({ choice: { mode: 'own', command: computer.npmCli }, processEnv: process.env });
    await rm(computer.npmCli, { force: true });
    const logBefore = (await computer.readLog()).length;

    // Neither the leftover managed copy nor a download answers for it.
    await expect(computer.readStatus()).resolves.toMatchObject({ ok: false, error: { code: 'cli_choice_required' } });
    await expect(computer.run('own')).rejects.toMatchObject({ code: 'cli_own_missing', message: expect.stringContaining(computer.npmCli) });
    expect((await computer.readLog()).length).toBe(logBefore);
    expect(computer.preparePayload).toHaveBeenCalledTimes(1);

    const managed = await computer.run('managed');
    expect(parseSetupCliChoicePromptData(managed.promptData[0])).toMatchObject({ command: computer.npmCli, version: null, missing: true });
    expect(managed.result).toMatchObject({ cliProvenance: 'managed', cliVersion: MANAGED_VERSION });
  });
});
