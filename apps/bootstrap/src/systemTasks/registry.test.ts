import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeSystemTask } from '@happier-dev/cli-common/systemTasks';
import { describe, expect, it, vi } from 'vitest';

import { createDefaultInteractiveKinds } from '../bin/hsetup.js';
import { createHsetupSystemTaskRegistry } from './registry.js';

function createFakeHappierCli(scenario: Readonly<{
  cliVersion?: string;
  serverCurrent?: Record<string, unknown>;
  authStatus?: Record<string, unknown>;
  authRequests?: readonly Record<string, unknown>[];
  authWaits?: readonly Record<string, unknown>[];
  serviceStatuses?: readonly Record<string, unknown>[];
  daemonStatuses?: readonly Record<string, unknown>[];
}>): Readonly<{
  cliPath: string;
  cleanup: () => void;
  readInvocations: () => string[][];
}> {
  const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-cli-'));
  const cliPath = join(rootDir, 'fake-happier');
  const statePath = join(rootDir, 'scenario.json');
  const logPath = join(rootDir, 'invocations.log');

  writeFileSync(statePath, JSON.stringify({
    // The real CLI answers `--version`; the tasks read it to state which CLI answered.
    cliVersion: scenario.cliVersion ?? '0.2.13',
    serverCurrent: scenario.serverCurrent ?? {
      ok: true,
      kind: 'server_current',
      data: {
        active: {
          id: 'cloud',
          serverUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        },
      },
    },
    authStatus: scenario.authStatus ?? {
      ok: true,
      kind: 'auth_status',
      data: {
        authenticated: true,
        machineRegistered: true,
        machineId: 'machine-local-1',
      },
    },
    authRequests: scenario.authRequests ?? [
      {
        publicKey: 'public-key-local-1',
      },
    ],
    authWaits: scenario.authWaits ?? [
      {
        success: true,
        machineId: 'machine-local-1',
      },
    ],
    serviceStatuses: scenario.serviceStatuses ?? [
      {
        ok: true,
        platform: process.platform,
        installed: true,
        daemon: { running: true, pid: 4321 },
        system: { ok: true, output: 'service ready' },
      },
    ],
    daemonStatuses: scenario.daemonStatuses ?? [
      {
        server: {
          serverUrl: 'https://relay.example.test',
          localServerUrl: null,
          publicServerUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        },
        daemon: {
          running: true,
          pid: 4321,
        },
        service: {
          installed: true,
          running: true,
        },
        auth: {
          authenticated: true,
          machineRegistered: true,
          machineId: 'machine-local-1',
          needsAuth: false,
        },
      },
    ],
  }, null, 2));

  writeFileSync(cliPath, `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');

const statePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
const logPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
const argv = process.argv.slice(2);
appendFileSync(logPath, JSON.stringify(argv) + '\\n');

const state = JSON.parse(readFileSync(statePath, 'utf8'));
const command = argv.join(' ');

function printJson(value) {
  process.stdout.write(JSON.stringify(value) + '\\n');
}

if (command === '--version') {
  process.stdout.write(state.cliVersion + '\\n');
  process.exit(0);
}

if (command === 'server current --json') {
  printJson(state.serverCurrent);
  process.exit(0);
}

if (command === 'auth status --json') {
  printJson(state.authStatus);
  process.exit(0);
}

if (command === 'auth request --json') {
  const requests = Array.isArray(state.authRequests) ? state.authRequests : [];
  const next = requests.length > 0
    ? requests.shift()
    : {
        publicKey: 'public-key-local-default',
      };
  state.authRequests = requests;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  printJson(next);
  process.exit(0);
}

if (argv[0] === 'auth' && argv[1] === 'approve' && argv.includes('--json')) {
  printJson({ success: true });
  process.exit(0);
}

if (argv[0] === 'auth' && argv[1] === 'wait' && argv.includes('--json')) {
  const waits = Array.isArray(state.authWaits) ? state.authWaits : [];
  const next = waits.length > 0
    ? waits.shift()
    : {
        success: true,
        machineId: 'machine-local-default',
      };
  state.authWaits = waits;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  printJson(next);
  process.exit(0);
}

if (command === 'daemon service status --json') {
  const statuses = Array.isArray(state.serviceStatuses) ? state.serviceStatuses : [];
  const next = statuses.length > 0
    ? statuses.shift()
    : {
        ok: true,
        platform: process.platform,
        installed: true,
        daemon: { running: true, pid: 1234 },
        system: { ok: true, output: 'service ready' },
      };
  state.serviceStatuses = statuses;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  printJson(next);
  process.exit(0);
}

if (command === 'daemon status --json') {
  const statuses = Array.isArray(state.daemonStatuses) ? state.daemonStatuses : [];
  const next = statuses.length > 0
    ? statuses.shift()
    : {
        server: {
          serverUrl: 'https://relay.example.test',
          localServerUrl: null,
          publicServerUrl: 'https://relay.example.test',
          webappUrl: 'https://app.example.test',
        },
        daemon: {
          running: true,
          pid: 1234,
        },
        service: {
          installed: true,
          running: true,
        },
        auth: {
          authenticated: true,
          machineRegistered: true,
          machineId: 'machine-local-default',
          needsAuth: false,
        },
      };
  state.daemonStatuses = statuses;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  printJson(next);
  process.exit(0);
}

if (argv[0] === 'server' && argv[1] === 'set' && argv.includes('--json')) {
  printJson({ ok: true, kind: 'server_set' });
  process.exit(0);
}

if (argv[0] === 'daemon' && argv[1] === 'service' && (argv[2] === 'install' || argv[2] === 'start') && argv.includes('--json')) {
  printJson({ ok: true, platform: process.platform });
  process.exit(0);
}

process.stderr.write('Unexpected fake happier args: ' + command + '\\n');
process.exit(1);
`);
  chmodSync(cliPath, 0o755);
  writeFileSync(logPath, '');

  return {
    cliPath,
    cleanup() {
      rmSync(rootDir, { recursive: true, force: true });
    },
    readInvocations() {
      const raw = readFileSync(logPath, 'utf8').trim();
      if (!raw) {
        return [];
      }
      return raw.split('\n').map((line) => JSON.parse(line) as string[]);
    },
  };
}

function restoreEnvVar(key: string, previousValue: string | undefined): void {
  if (previousValue === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = previousValue;
}

function createFakeTailscaleCli(scenario: Readonly<{
  statusJsons?: readonly Record<string, unknown>[];
  statusDelayMs?: number;
  loginOutputs?: readonly Readonly<{ exitCode?: number; stdout?: string; stderr?: string }>[];
  serveStatuses?: readonly string[];
  serveEnableOutputs?: readonly Readonly<{ exitCode?: number; stdout?: string; stderr?: string }>[];
}>): Readonly<{
  cliPath: string;
  cleanup: () => void;
  readInvocations: () => string[][];
}> {
  const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-tailscale-'));
  const cliPath = join(rootDir, 'fake-tailscale');
  const statePath = join(rootDir, 'scenario.json');
  const logPath = join(rootDir, 'invocations.log');

  writeFileSync(statePath, JSON.stringify({
    statusDelayMs: scenario.statusDelayMs ?? 0,
    statusJsons: scenario.statusJsons ?? [
      {
        BackendState: 'Running',
        AuthURL: '',
        HaveNodeKey: true,
        Self: {
          DNSName: 'relay.tailf00.ts.net.',
        },
        CurrentTailnet: {
          Name: 'example-tailnet',
        },
        TailscaleIPs: ['100.64.0.10'],
      },
    ],
    loginOutputs: scenario.loginOutputs ?? [],
    serveStatuses: scenario.serveStatuses ?? [],
    serveEnableOutputs: scenario.serveEnableOutputs ?? [],
  }, null, 2));

  writeFileSync(cliPath, `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');

const statePath = process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH;
const logPath = process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH;
const argv = process.argv.slice(2);
appendFileSync(logPath, JSON.stringify(argv) + '\\n');

const state = JSON.parse(readFileSync(statePath, 'utf8'));

function shift(list, fallback) {
  const values = Array.isArray(list) ? [...list] : [];
  const next = values.length > 0 ? values.shift() : fallback;
  return { next, rest: values };
}

if (argv[0] === 'status' && argv[1] === '--json') {
  const { next, rest } = shift(state.statusJsons, {
    BackendState: 'Running',
    AuthURL: '',
    HaveNodeKey: true,
    Self: { DNSName: 'relay.tailf00.ts.net.' },
    CurrentTailnet: { Name: 'example-tailnet' },
    TailscaleIPs: ['100.64.0.10'],
  });
  const finish = () => {
    state.statusJsons = rest;
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    process.stdout.write(JSON.stringify(next) + '\\n');
    process.exit(0);
  };
  const delayMs = Math.max(0, Math.trunc(Number(state.statusDelayMs ?? 0)));
  if (delayMs > 0) {
    setTimeout(finish, delayMs);
  } else {
    finish();
  }
} else if (argv[0] === 'login' && (argv[1] === '--qr' || argv.length === 1)) {
  const { next, rest } = shift(state.loginOutputs, {
    exitCode: 0,
    stdout: 'logged in',
    stderr: '',
  });
  state.loginOutputs = rest;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  if (next.stdout) process.stdout.write(String(next.stdout));
  if (next.stderr) process.stderr.write(String(next.stderr));
  process.exit(Number(next.exitCode ?? 0));
} else if (argv[0] === 'serve' && argv[1] === 'status') {
  const { next, rest } = shift(state.serveStatuses, '');
  state.serveStatuses = rest;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.stdout.write(String(next ?? ''));
  process.exit(0);
} else if (argv[0] === 'serve' && argv[1] === '--bg') {
  const { next, rest } = shift(state.serveEnableOutputs, {
    exitCode: 0,
    stdout: '',
    stderr: '',
  });
  state.serveEnableOutputs = rest;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  if (next.stdout) process.stdout.write(String(next.stdout));
  if (next.stderr) process.stderr.write(String(next.stderr));
  process.exit(Number(next.exitCode ?? 0));
} else {
  process.stderr.write('Unexpected fake tailscale args: ' + argv.join(' ') + '\\n');
  process.exit(1);
}
`);
  chmodSync(cliPath, 0o755);
  writeFileSync(logPath, '');

  return {
    cliPath,
    cleanup() {
      rmSync(rootDir, { recursive: true, force: true });
    },
    readInvocations() {
      const raw = readFileSync(logPath, 'utf8').trim();
      if (!raw) {
        return [];
      }
      return raw.split('\n').map((line) => JSON.parse(line) as string[]);
    },
  };
}

describe('createHsetupSystemTaskRegistry', () => {
  it('dispatches local setup only through the interactive map, and no longer answers the deleted relay repair kind', () => {
    const registry = createHsetupSystemTaskRegistry();
    const interactiveKinds = createDefaultInteractiveKinds();

    expect(Object.keys(interactiveKinds)).toContain('setup.thisComputer.v1');
    expect(registry.has('setup.thisComputer.v1')).toBe(false);
    expect(registry.has('relay.connectBackgroundService.v1')).toBe(false);
    // INV1, literally: no kind is registered in both dispatch maps. `runHsetupCli` prefers the
    // interactive map for every kind in it, so a registry twin can never run — it is a second
    // entry nothing can reach, which is the same dead-registration defect the plan names in 0.3.
    expect(Object.keys(interactiveKinds).filter((kind) => registry.has(kind))).toEqual([]);
    expect(registry.has('remote.ssh.bootstrapMachine.v1')).toBe(false);
  });

  it('runs daemon.service.status.v1 and reports the local daemon status snapshot', async () => {
    const fakeCli = createFakeHappierCli({
      daemonStatuses: [
        {
          // Mirrors `readDaemonStatusSnapshot`'s own shape (the doctor snapshot's daemon-status
          // block, which the bootstrap reader now parses with that schema).
          server: {
            activeServerId: 'cloud',
            serverUrl: 'https://relay.example.test',
            localServerUrl: null,
            publicServerUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
            comparableKey: 'relay.example.test',
          },
          daemon: {
            running: true,
            pid: 4321,
            httpPort: 43117,
          },
          service: {
            installed: true,
            running: true,
          },
          auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine-local-1',
            needsAuth: false,
            accountId: 'acct_local',
          },
        },
      ],
    });
    const previousCliPath = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
    try {
      process.env.HAPPIER_BOOTSTRAP_CLI_PATH = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'daemon.service.status.v1',
          params: {
            surface: 'desktop.ui',
            target: { kind: 'local' },
            mode: 'user',
          },
        },
        taskId: 'task_daemon_status_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent() {},
      });

      expect(result).toMatchObject({
        protocolVersion: 1,
        taskId: 'task_daemon_status_1',
        ok: true,
        data: {
          serviceInstalled: true,
          daemonRunning: true,
          needsAuth: false,
          machineId: 'machine-local-1',
          // Acquisition is stated, not implied: this run resolved an override CLI.
          acquisition: { command: fakeCli.cliPath, provenance: 'override', version: '0.2.13', channel: null },
          server: { serverUrl: 'https://relay.example.test', publicServerUrl: 'https://relay.example.test' },
          service: { installed: true, running: true },
          // A CLI that emits no runtimeConvergence leaves the running daemon unknown.
          runtimeConvergence: null,
        },
      });
      expect(fakeCli.readInvocations()).toContainEqual(['daemon', 'status', '--json']);
    } finally {
      restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previousCliPath);
      restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('runs daemon.service.start.v1 and waits for the ready daemon status snapshot', async () => {
    const fakeCli = createFakeHappierCli({
      daemonStatuses: [
        {
          // Mirrors `readDaemonStatusSnapshot`'s own shape (the doctor snapshot's daemon-status
          // block, which the bootstrap reader now parses with that schema).
          server: {
            activeServerId: 'cloud',
            serverUrl: 'https://relay.example.test',
            localServerUrl: null,
            publicServerUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
            comparableKey: 'relay.example.test',
          },
          daemon: {
            running: true,
            pid: 4321,
            httpPort: 43117,
          },
          service: {
            installed: true,
            running: true,
          },
          auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine-local-1',
            needsAuth: false,
            accountId: 'acct_local',
          },
        },
        {
          // Mirrors `readDaemonStatusSnapshot`'s own shape (the doctor snapshot's daemon-status
          // block, which the bootstrap reader now parses with that schema).
          server: {
            activeServerId: 'cloud',
            serverUrl: 'https://relay.example.test',
            localServerUrl: null,
            publicServerUrl: 'https://relay.example.test',
            webappUrl: 'https://app.example.test',
            comparableKey: 'relay.example.test',
          },
          daemon: {
            running: true,
            pid: 4321,
            httpPort: 43117,
          },
          service: {
            installed: true,
            running: true,
          },
          auth: {
            authenticated: true,
            machineRegistered: true,
            machineId: 'machine-local-1',
            needsAuth: false,
            accountId: 'acct_local',
          },
        },
      ],
    });
    const previousCliPath = process.env.HAPPIER_BOOTSTRAP_CLI_PATH;
    const previousStatePath = process.env.HAPPIER_FAKE_CLI_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_CLI_LOG_PATH;
    try {
      process.env.HAPPIER_BOOTSTRAP_CLI_PATH = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_CLI_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_CLI_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'daemon.service.start.v1',
          params: {
            surface: 'desktop.ui',
            target: { kind: 'local' },
            mode: 'user',
          },
        },
        taskId: 'task_daemon_start_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent() {},
      });

      expect(result).toMatchObject({
        protocolVersion: 1,
        taskId: 'task_daemon_start_1',
        ok: true,
        data: {
          serviceInstalled: true,
          daemonRunning: true,
          needsAuth: false,
          machineId: 'machine-local-1',
        },
      });
      // One version read for the whole run: the readiness re-read reuses the CLI this run already
      // resolved instead of resolving and versioning the CLI again on every poll.
      expect(fakeCli.readInvocations()).toEqual([
        ['--version'],
        ['daemon', 'status', '--json'],
        // The pinned services the app also manages (one login-start setting), each started on its own.
        ['daemon', 'service', 'list', '--json'],
        ['daemon', 'service', 'start', '--json'],
        ['daemon', 'status', '--json'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_BOOTSTRAP_CLI_PATH', previousCliPath);
      restoreEnvVar('HAPPIER_FAKE_CLI_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_CLI_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('runs relay.runtime.status.v1 with deterministic progress and result payloads', async () => {
    const events: unknown[] = [];
    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'relay.runtime.status.v1',
        params: {
          target: { kind: 'local' },
          channel: 'stable',
          mode: 'user',
        },
      },
      taskId: 'task_status_1',
      registry: createHsetupSystemTaskRegistry({
        relayRuntime: {
          async readStatus() {
            return {
              installed: true,
              version: '1.2.3',
              service: {
                active: true,
                enabled: true,
              },
              baseUrl: 'http://127.0.0.1:3005',
            };
          },
          async checkHealth() {
            return true;
          },
        },
      }),
      now: () => 1700000000000,
      emitEvent(event) {
        events.push(event);
      },
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'progress',
        stepId: 'relay.status.inspect',
        message: 'Inspecting relay runtime',
      }),
      expect.objectContaining({
        type: 'progress',
        stepId: 'relay.status.health',
        message: 'Checking relay runtime health',
      }),
    ]);
    expect(result).toEqual({
      protocolVersion: 1,
      taskId: 'task_status_1',
      ok: true,
      data: {
        installed: true,
        version: '1.2.3',
        relayUrl: 'http://127.0.0.1:3005',
        healthy: true,
        service: {
          active: true,
          enabled: true,
        },
      },
    });
  });

  it('runs relay.runtime.start.v1 through the lifecycle controller before returning fresh status', async () => {
    const controlled: string[] = [];
    const result = await executeSystemTask({
      spec: {
        protocolVersion: 1,
        kind: 'relay.runtime.start.v1',
        params: {
          target: { kind: 'local' },
          channel: 'stable',
          mode: 'user',
        },
      },
      taskId: 'task_start_1',
      registry: createHsetupSystemTaskRegistry({
        relayRuntime: {
          async readStatus() {
            return {
              installed: true,
              version: '1.2.3',
              service: {
                active: true,
                enabled: true,
              },
              baseUrl: 'http://127.0.0.1:3005',
            };
          },
          async checkHealth() {
            return true;
          },
          async control(params) {
            controlled.push(params.action);
          },
        },
      }),
      emitEvent() {},
    });

    expect(controlled).toEqual(['start']);
    expect(result.ok).toBe(true);
  });

  it('runs secureAccess.tailscale.v1 with the existing tailnet-only serve URL when tailscale is already ready', async () => {
    const fakeCli = createFakeTailscaleCli({
      statusDelayMs: 900,
      serveStatuses: [
        [
          'https://relay.tailf00.ts.net',
          '|-- / proxy http://127.0.0.1:3005',
        ].join('\n'),
      ],
    });
    const previousTailscaleBin = process.env.HAPPIER_TAILSCALE_BIN;
    const previousStatePath = process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH;
    const events: unknown[] = [];
    try {
      process.env.HAPPIER_TAILSCALE_BIN = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'secureAccess.tailscale.v1',
          params: {
            upstreamUrl: 'http://127.0.0.1:3005',
          },
        },
        taskId: 'task_tailscale_ready_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent(event) {
          events.push(event);
        },
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_tailscale_ready_1',
        ok: true,
        data: {
          tailscaleInstalled: true,
          tailscaleLoggedIn: true,
          serveEnabled: true,
          shareableHttpsUrl: 'https://relay.tailf00.ts.net',
          requiresApproval: null,
        },
      });
      expect(events).toEqual([
        expect.objectContaining({ type: 'progress', stepId: 'detect' }),
        expect.objectContaining({ type: 'progress', stepId: 'verify url' }),
      ]);
      expect(fakeCli.readInvocations()).toEqual([
        ['status', '--json'],
        ['serve', 'status'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_TAILSCALE_BIN', previousTailscaleBin);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_LOG_PATH', previousLogPath);
      fakeCli.cleanup();
    }
  });

  it('runs secureAccess.tailscale.v1 through interactive login and returns a structured approval URL when serve needs tailnet approval', async () => {
    const fakeCli = createFakeTailscaleCli({
      statusJsons: [
        {
          BackendState: 'NeedsLogin',
          AuthURL: 'https://login.tailscale.com/a/example',
          HaveNodeKey: false,
        },
        {
          BackendState: 'Running',
          AuthURL: '',
          HaveNodeKey: true,
          Self: {
            DNSName: 'relay.tailf00.ts.net.',
          },
          CurrentTailnet: {
            Name: 'example-tailnet',
          },
          TailscaleIPs: ['100.64.0.10'],
        },
      ],
      loginOutputs: [
        {
          exitCode: 0,
          stdout: 'To authenticate, visit https://login.tailscale.com/a/example',
        },
      ],
      serveStatuses: [''],
      serveEnableOutputs: [
        {
          exitCode: 1,
          stderr: 'To authorize your tailnet, visit https://login.tailscale.com/f/serve?node=node-123',
        },
      ],
    });
    const previousTailscaleBin = process.env.HAPPIER_TAILSCALE_BIN;
    const previousStatePath = process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH;
    const previousLogPath = process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH;
    const previousPollTimeout = process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS;
    const previousPollInterval = process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS;
    const events: unknown[] = [];
    try {
      process.env.HAPPIER_TAILSCALE_BIN = fakeCli.cliPath;
      process.env.HAPPIER_FAKE_TAILSCALE_STATE_PATH = join(fakeCli.cliPath, '..', 'scenario.json');
      process.env.HAPPIER_FAKE_TAILSCALE_LOG_PATH = join(fakeCli.cliPath, '..', 'invocations.log');
      // Avoid long approval polling in this registry integration test. The handler still returns the approval URL,
      // and the UX layer can re-run or poll separately if desired.
      process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS = '0';
      process.env.HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS = '0';

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'secureAccess.tailscale.v1',
          params: {
            upstreamUrl: 'http://127.0.0.1:3005',
            loginPolicy: 'interactive',
          },
        },
        taskId: 'task_tailscale_approval_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent(event) {
          events.push(event);
        },
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_tailscale_approval_1',
        ok: true,
        data: {
          tailscaleInstalled: true,
          tailscaleLoggedIn: true,
          serveEnabled: false,
          shareableHttpsUrl: null,
          requiresApproval: {
            url: 'https://login.tailscale.com/f/serve?node=node-123',
          },
        },
      });
      expect(events).toEqual([
        expect.objectContaining({ type: 'progress', stepId: 'detect' }),
        expect.objectContaining({
          type: 'prompt',
          stepId: 'login',
          data: {
            kind: 'needsUserAction.scanQr',
            url: 'https://login.tailscale.com/a/example',
            usedQr: true,
          },
        }),
        expect.objectContaining({
          type: 'progress',
          stepId: 'serve enable',
        }),
        expect.objectContaining({
          type: 'prompt',
          stepId: 'serve enable',
          data: {
            kind: 'tailscaleServeApproval',
            url: 'https://login.tailscale.com/f/serve?node=node-123',
          },
        }),
      ]);
      expect(fakeCli.readInvocations()).toEqual([
        ['status', '--json'],
        ['login', '--qr'],
        ['status', '--json'],
        ['serve', 'status'],
        ['serve', '--bg', 'http://127.0.0.1:3005'],
      ]);
    } finally {
      restoreEnvVar('HAPPIER_TAILSCALE_BIN', previousTailscaleBin);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_STATE_PATH', previousStatePath);
      restoreEnvVar('HAPPIER_FAKE_TAILSCALE_LOG_PATH', previousLogPath);
      restoreEnvVar('HAPPIER_TAILSCALE_APPROVAL_POLL_TIMEOUT_MS', previousPollTimeout);
      restoreEnvVar('HAPPIER_TAILSCALE_APPROVAL_POLL_INTERVAL_MS', previousPollInterval);
      fakeCli.cleanup();
    }
  });

  it('returns prompt_required with a structured install prompt when installIfMissing is requested but tailscale is unavailable', async () => {
    const previousTailscaleBin = process.env.HAPPIER_TAILSCALE_BIN;
    const previousInstallMode = process.env.HAPPIER_TAILSCALE_INSTALL_MODE;
    const events: unknown[] = [];
    try {
      process.env.HAPPIER_TAILSCALE_BIN = join(tmpdir(), `missing-tailscale-${Date.now()}`);
      process.env.HAPPIER_TAILSCALE_INSTALL_MODE = 'manual';

      const result = await executeSystemTask({
        spec: {
          protocolVersion: 1,
          kind: 'secureAccess.tailscale.v1',
          params: {
            upstreamUrl: 'http://127.0.0.1:3005',
            installPolicy: 'installIfMissing',
          },
        },
        taskId: 'task_tailscale_install_1',
        registry: createHsetupSystemTaskRegistry(),
        now: () => 1700000000000,
        emitEvent(event) {
          events.push(event);
        },
      });

      expect(result).toEqual({
        protocolVersion: 1,
        taskId: 'task_tailscale_install_1',
        ok: false,
        error: {
          code: 'prompt_required',
          message: 'Install Tailscale and rerun secure access setup.',
        },
      });
      expect(events).toEqual([
        expect.objectContaining({ type: 'progress', stepId: 'detect' }),
        expect.objectContaining({
          type: 'progress',
          stepId: 'install',
        }),
        expect.objectContaining({
          type: 'prompt',
          stepId: 'install',
          data: {
            kind: 'tailscaleInstall',
            platform: process.platform,
            url: expect.any(String),
          },
        }),
      ]);
    } finally {
      restoreEnvVar('HAPPIER_TAILSCALE_BIN', previousTailscaleBin);
      restoreEnvVar('HAPPIER_TAILSCALE_INSTALL_MODE', previousInstallMode);
      vi.unstubAllGlobals();
    }
  });
});

const posixDescribe = process.platform === 'win32' ? describe.skip : describe;

posixDescribe('createHsetupSystemTaskRegistry cli.pathExposure kinds', () => {
  it('adds the managed CLI bin dir to the shell profile through the registry and removes it again', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'hsetup-registry-cli-path-'));
    const previousHome = process.env.HOME;
    const previousShell = process.env.SHELL;
    const previousHappierHome = process.env.HAPPIER_HOME_DIR;
    const previousNoPathUpdate = process.env.HAPPIER_NO_PATH_UPDATE;
    const previousPath = process.env.PATH;
    const zshrcPath = join(homeDir, '.zshrc');
    writeFileSync(zshrcPath, '# mine\n', 'utf8');
    try {
      process.env.HOME = homeDir;
      process.env.SHELL = '/bin/zsh';
      process.env.HAPPIER_HOME_DIR = join(homeDir, '.happier');
      process.env.PATH = '';
      delete process.env.HAPPIER_NO_PATH_UPDATE;
      const registry = createHsetupSystemTaskRegistry();
      const params = { surface: 'desktop.ui', target: { kind: 'local' }, mode: 'user' };

      const ensured = await executeSystemTask({
        spec: { protocolVersion: 1, kind: 'cli.pathExposure.ensure.v1', params },
        taskId: 'task_cli_path_ensure_1',
        registry,
        now: () => 1700000000000,
        emitEvent() {},
      });
      expect(ensured).toEqual({
        protocolVersion: 1,
        taskId: 'task_cli_path_ensure_1',
        ok: true,
        data: {
          changed: true,
          shellReloadHint: expect.stringContaining(zshrcPath),
          failure: null,
          existingCommand: null,
        },
      });
      expect(readFileSync(zshrcPath, 'utf8')).toContain(`export PATH="${join(homeDir, '.happier', 'bin')}:$PATH"`);

      const removed = await executeSystemTask({
        spec: { protocolVersion: 1, kind: 'cli.pathExposure.remove.v1', params },
        taskId: 'task_cli_path_remove_1',
        registry,
        now: () => 1700000000000,
        emitEvent() {},
      });
      expect(removed).toMatchObject({ ok: true, data: { removed: true, failure: null } });
      expect(readFileSync(zshrcPath, 'utf8')).toBe('# mine\n');
    } finally {
      restoreEnvVar('HOME', previousHome);
      restoreEnvVar('SHELL', previousShell);
      restoreEnvVar('HAPPIER_HOME_DIR', previousHappierHome);
      restoreEnvVar('HAPPIER_NO_PATH_UPDATE', previousNoPathUpdate);
      restoreEnvVar('PATH', previousPath);
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
