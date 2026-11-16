// Fixture for per-session softmax crash/restart and reservation-custody acceptance (spec
// happier-selection-b6573fb3 revision 5, Appendix C.2 T5, T14, T16–T20).
//
// Real processes throughout: server-light, the daemon and its session runners, and the Agent SDK
// launcher. Only the Claude executable (fake Claude) and the OAuth token endpoint are fixtures.
//
// What this adds over `startConnectedServicesClaudeDaemon`:
// - A programmable reverse proxy between every client (daemon, runners, test) and the server. It
//   forwards verbatim, including websocket upgrades, and lets a test stall, drop, or lose the
//   response of individual HTTP requests (for example one reservation PUT) to place a real daemon
//   at a precise point of the reservation protocol. The proxy never fabricates a reservation
//   outcome: a definite 409 is produced by the real route after the test advances the revision
//   with another real PUT.
// - Real daemon crash and restart: SIGKILL of the daemon process alone (its session runners keep
//   running, as after a real crash), then a new daemon on the same home/state directory.
// - Real server stop/start on the same data directory; the proxy retargets to the new port.

import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';

import { upsertEncryptedAccountSettingsV2 } from './accountSettings';
import { createTestAuth, type TestAuth } from './auth';
import { seedCliAuthForServer } from './cliAuth';
import { daemonControlPostJson } from './daemon/controlServerClient';
import {
  resolveTestDaemonCliLaunchSpec,
  sanitizeDaemonEnvForSpawn,
  startTestDaemon,
  stopDaemonFromHomeDir,
  waitForDaemonState,
  type DaemonState,
  type PreparedTestDaemonCliLaunchSpec,
  type StartedDaemon,
} from './daemon/daemon';
import { createTempPathBin } from './fs/tempPathBin';
import { writeTestManifestForServer } from './manifestForServer';
import { ensureCliSharedDepsBuilt } from './process/cliDist';
import { installFakeSecurityCli } from './process/fakeSecurityCli';
import { isProcessAlive } from './process/processTree';
import { startServerLight, type StartedServer } from './process/serverLight';
import { spawnLoggedProcess, type SpawnedProcess } from './process/spawnProcess';
import { repoRootDir } from './paths';
import { resolvePreparedCliSnapshotEntrypoint, type StartedConnectedServicesClaudeDaemonFixture } from './connectedServicesRecovery';

type UnknownRecord = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Programmable proxy
// ---------------------------------------------------------------------------------------------

export type ProxiedRequest = Readonly<{
  seq: number;
  method: string;
  pathname: string;
  search: string;
  body: Buffer;
  receivedAtMs: number;
}>;

/**
 * What the proxy does with one request:
 * - `forward`: send to the server and relay its response;
 * - `forward_lose_response`: send to the server, wait for its response (so the server committed),
 *   then destroy the client socket without replying (a lost response after commit);
 * - `drop`: destroy the client socket without forwarding (lost before commit);
 * - `respond`: reply locally with this status/body without forwarding (route definitely unavailable).
 */
export type ProxyAction =
  | Readonly<{ kind: 'forward' }>
  | Readonly<{ kind: 'forward_lose_response' }>
  | Readonly<{ kind: 'drop' }>
  | Readonly<{ kind: 'respond'; status: number; body: unknown }>;

export type ProxyHook = (request: ProxiedRequest) => ProxyAction | null | Promise<ProxyAction | null>;

export type ProgrammableServerProxy = Readonly<{
  baseUrl: string;
  setTarget: (targetBaseUrl: string) => void;
  /** Installs the hook consulted for every HTTP request (null restores plain forwarding). */
  setHook: (hook: ProxyHook | null) => void;
  requests: () => readonly ProxiedRequest[];
  /** Destroys every open client and upstream socket (websockets reconnect afterwards). */
  dropAllSockets: () => void;
  stop: () => Promise<void>;
}>;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startProgrammableServerProxy(params: Readonly<{ targetBaseUrl: string }>): Promise<ProgrammableServerProxy> {
  let target = new URL(params.targetBaseUrl);
  let hook: ProxyHook | null = null;
  let seq = 0;
  const log: ProxiedRequest[] = [];
  const sockets = new Set<Duplex>();
  const track = <T extends Duplex>(socket: T): T => {
    if (!sockets.has(socket)) {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    }
    return socket;
  };

  const forward = async (req: IncomingMessage, url: URL, body: Buffer): Promise<{ status: number; headers: Headers; body: Buffer }> => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      if (lower === 'host' || lower === 'connection' || lower === 'content-length' || lower === 'transfer-encoding') continue;
      if (Array.isArray(value)) for (const item of value) headers.append(key, item);
      else if (typeof value === 'string') headers.set(key, value);
    }
    const upstream = new URL(`${url.pathname}${url.search}`, target);
    const response = await fetch(upstream, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : new Uint8Array(body),
    });
    return { status: response.status, headers: response.headers, body: Buffer.from(await response.arrayBuffer()) };
  };

  const reply = (res: ServerResponse, status: number, headers: Headers | null, body: Buffer): void => {
    res.statusCode = status;
    headers?.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === 'transfer-encoding' || lower === 'content-encoding' || lower === 'content-length' || lower === 'connection') return;
      res.setHeader(key, value);
    });
    res.setHeader('content-length', String(body.length));
    res.end(body);
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://proxy.invalid');
      const body = await readBody(req);
      seq += 1;
      const request: ProxiedRequest = {
        seq, method: req.method ?? 'GET', pathname: url.pathname, search: url.search, body, receivedAtMs: Date.now(),
      };
      log.push(request);
      const action = (hook ? await hook(request) : null) ?? { kind: 'forward' as const };
      if (action.kind === 'drop') {
        req.socket.destroy();
        return;
      }
      if (action.kind === 'respond') {
        reply(res, action.status, null, Buffer.from(JSON.stringify(action.body)));
        return;
      }
      const upstream = await forward(req, url, body);
      if (action.kind === 'forward_lose_response') {
        req.socket.destroy();
        return;
      }
      reply(res, upstream.status, upstream.headers, upstream.body);
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      reply(res, 503, null, Buffer.from(JSON.stringify({ error: `proxy_upstream_error: ${error instanceof Error ? error.message : String(error)}` })));
    }
  });
  server.keepAliveTimeout = 1_000;
  server.on('connection', (socket) => track(socket));
  server.on('upgrade', (req, socket, head) => {
    track(socket);
    const upstream = track(connect({ host: target.hostname, port: Number(target.port) }));
    upstream.once('connect', () => {
      upstream.write(`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}\r\n`);
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        const key = req.rawHeaders[index];
        const value = req.rawHeaders[index + 1];
        if (!key || value === undefined) continue;
        upstream.write(`${key}: ${value}\r\n`);
      }
      upstream.write('\r\n');
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.once('error', () => socket.destroy());
    upstream.once('close', () => socket.destroy());
    socket.once('error', () => upstream.destroy());
    socket.once('close', () => upstream.destroy());
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address !== 'object') throw new Error('programmable server proxy missing address');

  const dropAllSockets = () => {
    for (const socket of [...sockets]) socket.destroy();
  };
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    setTarget: (next) => { target = new URL(next); },
    setHook: (next) => { hook = next; },
    requests: () => [...log],
    dropAllSockets,
    stop: async () => {
      dropAllSockets();
      if (!server.listening) return;
      await new Promise<void>((resolveStop) => server.close(() => resolveStop()));
    },
  };
}

/** Matches the per-group reservation routes; returns the decision ID for item routes. */
export function matchReservationRoute(request: Pick<ProxiedRequest, 'pathname'>, groupId: string): { decisionId: string | null } | null {
  const prefix = `/v3/connect/claude-subscription/groups/${groupId}/assignment-reservations`;
  if (request.pathname === prefix) return { decisionId: null };
  if (request.pathname.startsWith(`${prefix}/`)) return { decisionId: decodeURIComponent(request.pathname.slice(prefix.length + 1)) };
  return null;
}

export function parseJsonBody(request: Pick<ProxiedRequest, 'body'>): UnknownRecord | null {
  try {
    const parsed = JSON.parse(request.body.toString('utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as UnknownRecord : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------------------------

export type PerSessionRecoveryFixture = StartedConnectedServicesClaudeDaemonFixture & Readonly<{
  proxy: ProgrammableServerProxy;
  /** The server's own URL (bypasses the proxy). */
  directServerBaseUrl: () => string;
  daemonEnv: NodeJS.ProcessEnv;
  testDir: string;
  /** Current daemon (state changes after a restart). */
  current: () => Readonly<{ pid: number; port: number; controlToken: string | undefined }>;
  /** SIGKILL the daemon process only; session runners stay alive. Returns the killed pid. */
  crashDaemon: () => Promise<number>;
  /** Start a new daemon on the same home/state directory (after `crashDaemon`). */
  restartDaemon: () => Promise<DaemonState>;
  /** Stop the server process and start it again on the same data directory. */
  restartServer: (options?: Readonly<{ downtimeMs?: number }>) => Promise<void>;
  stopServer: () => Promise<void>;
  startServer: () => Promise<void>;
  teardown: () => Promise<void>;
}>;

function snapshotSubprocessEnv(snapshotDir: string): Record<string, string> {
  return {
    HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
    HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: resolvePreparedCliSnapshotEntrypoint(snapshotDir),
    HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
  };
}

function launchSpecSubprocessEnv(spec: Readonly<{ command: string; args: ReadonlyArray<string> }>): Record<string, string> {
  if (spec.command !== process.execPath || spec.args.length !== 1) return {};
  const entrypoint = spec.args[0]?.trim() ?? '';
  if (!entrypoint.endsWith('.mjs')) return {};
  return { HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node', HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint };
}

async function waitForControlList(port: number, controlToken: string | undefined): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const res = await daemonControlPostJson({ port, path: '/list', body: {}, controlToken, timeoutMs: 5_000 }).catch(() => null);
    if (res?.status === 200) return;
    if (Date.now() - startedAt > 30_000) throw new Error('Timed out waiting for daemon control /list');
    await new Promise((r) => setTimeout(r, 100));
  }
}

export async function startPerSessionRecoveryFixture(params: Readonly<{
  testDir: string;
  testName: string;
  tokenUrl: string;
  fakeClaudePath: string;
  fakeClaudeLogPath: string;
  accountSettings?: Readonly<Record<string, unknown>>;
  serverExtraEnv?: Record<string, string>;
  extraEnv?: Record<string, string>;
  cliSnapshotDir?: string;
}>): Promise<PerSessionRecoveryFixture> {
  const startedAt = new Date().toISOString();
  const serverEnv = {
    HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '1',
    HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_GROUPS__ENABLED: '1',
    HAPPIER_FEATURE_CONNECTED_SERVICES_ACCOUNT_FALLBACK__ENABLED: '1',
    ...(params.serverExtraEnv ?? {}),
  };
  let server: StartedServer = await startServerLight({ testDir: params.testDir, dbProvider: 'sqlite', extraEnv: serverEnv });
  const serverPort = server.port;
  const proxy = await startProgrammableServerProxy({ targetBaseUrl: server.baseUrl });
  const baseUrl = proxy.baseUrl;

  const auth: TestAuth = await createTestAuth(baseUrl);
  const daemonHomeDir = resolve(join(params.testDir, 'daemon-home'));
  const workspaceDir = resolve(join(params.testDir, 'workspace'));
  const sourceClaudeConfigDir = resolve(join(params.testDir, 'source-claude-config'));
  await mkdir(daemonHomeDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(sourceClaudeConfigDir, { recursive: true });
  await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"e2e"}\n', 'utf8');

  const secret = Uint8Array.from(randomBytes(32));
  const { serverId, machineId } = await seedCliAuthForServer({ cliHome: daemonHomeDir, serverUrl: baseUrl, token: auth.token, secret });
  await upsertEncryptedAccountSettingsV2({
    baseUrl, token: auth.token, secret,
    settings: {
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'auto',
      claudeRemoteAgentSdkEnabled: true,
      claudeRemoteSettingSourcesV2: ['user', 'project', 'local'],
      ...(params.accountSettings ?? {}),
    },
  });
  writeTestManifestForServer({
    testDir: params.testDir, server, startedAt, runId: params.testName, testName: params.testName, sessionIds: [],
    env: { CI: process.env.CI, HAPPIER_HOME_DIR: daemonHomeDir, HAPPIER_SERVER_URL: baseUrl, HAPPIER_WEBAPP_URL: baseUrl, CLAUDE_CONFIG_DIR: sourceClaudeConfigDir },
  });

  const tempPathBin = await createTempPathBin({ prefix: 'happier-per-session-recovery-bin-', baseDir: params.testDir, env: process.env });
  if (process.platform === 'darwin') await installFakeSecurityCli(tempPathBin);

  const daemonEnv: NodeJS.ProcessEnv = {
    ...tempPathBin.env,
    CI: '1',
    HAPPIER_VARIANT: 'dev',
    HAPPIER_DISABLE_CAFFEINATE: '1',
    HAPPIER_HOME_DIR: daemonHomeDir,
    HAPPIER_SERVER_URL: baseUrl,
    HAPPIER_WEBAPP_URL: baseUrl,
    HAPPIER_ACTIVE_SERVER_ID: serverId,
    CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
    HAPPIER_CLAUDE_PATH: params.fakeClaudePath,
    HAPPIER_E2E_FAKE_CLAUDE_LOG: params.fakeClaudeLogPath,
    HAPPIER_E2E_FAKE_CLAUDE_REQUIRE_NATIVE_OAUTH: '1',
    ...(params.cliSnapshotDir ? snapshotSubprocessEnv(params.cliSnapshotDir) : { HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1' }),
    HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '1',
    HAPPIER_CONNECTED_SERVICES_REFRESH_TICK_MS: '300000',
    HAPPIER_CONNECTED_SERVICES_AUTH_GROUP_RESTART_SIGNAL_DELAY_MS: '0',
    HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_TOKEN_URL: params.tokenUrl,
    HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_OAUTH_CLIENT_ID: 'happier-e2e-claude-client',
    ...(params.extraEnv ?? {}),
  };
  if (params.cliSnapshotDir) {
    delete daemonEnv.HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT;
    delete daemonEnv.HAPPY_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT;
  } else {
    await ensureCliSharedDepsBuilt({ testDir: params.testDir, env: daemonEnv });
  }

  const launch: PreparedTestDaemonCliLaunchSpec = await resolveTestDaemonCliLaunchSpec({
    testDir: params.testDir,
    env: daemonEnv,
    ...(params.cliSnapshotDir ? { snapshotDir: params.cliSnapshotDir, preparedDistSnapshotOnly: true } : {}),
  });
  // Runners must survive the daemon's death, exactly as after a real crash.
  const daemon: StartedDaemon = await startTestDaemon({
    testDir: params.testDir, happyHomeDir: daemonHomeDir, env: daemonEnv, preparedCliLaunchSpec: launch,
    startupTimeoutMs: 120_000, cleanupDescendantsOnExit: false,
  });
  await waitForControlList(daemon.state.httpPort, daemon.state.controlToken);

  let currentState: DaemonState = daemon.state;
  const restartedProcs: SpawnedProcess[] = [];
  let restartCount = 0;

  const fixture = {
    server,
    serverBaseUrl: baseUrl,
    auth,
    accountSecret: secret,
    daemon,
    daemonHomeDir,
    workspaceDir,
    serverId,
    machineId,
    get daemonPort() { return currentState.httpPort; },
    get controlToken() { return currentState.controlToken; },
    fakeClaudeLogPath: params.fakeClaudeLogPath,
    fakeClaudeScenario: null,
    proxy,
    directServerBaseUrl: () => server.baseUrl,
    daemonEnv,
    testDir: params.testDir,
    current: () => ({ pid: currentState.pid, port: currentState.httpPort, controlToken: currentState.controlToken }),
    crashDaemon: async () => {
      const pid = currentState.pid;
      process.kill(pid, 'SIGKILL');
      const startedAtMs = Date.now();
      while (isProcessAlive(pid)) {
        if (Date.now() - startedAtMs > 10_000) throw new Error(`daemon ${pid} survived SIGKILL`);
        await new Promise((r) => setTimeout(r, 25));
      }
      return pid;
    },
    restartDaemon: async () => {
      const previousPid = currentState.pid;
      restartCount += 1;
      const spec = launch.spec;
      const proc = spawnLoggedProcess({
        command: spec.command,
        args: [...spec.args, 'daemon', 'start-sync', '--takeover'],
        cwd: spec.cwd ?? repoRootDir(),
        env: {
          ...sanitizeDaemonEnvForSpawn(daemonEnv),
          ...(spec.env ?? {}),
          ...launchSpecSubprocessEnv(spec),
          CI: '1',
          HAPPIER_HOME_DIR: daemonHomeDir,
        },
        stdoutPath: resolve(params.testDir, `daemon.restart-${restartCount}.stdout.log`),
        stderrPath: resolve(params.testDir, `daemon.restart-${restartCount}.stderr.log`),
        cleanupDescendantsOnExit: false,
      });
      restartedProcs.push(proc);
      currentState = await waitForDaemonState(daemonHomeDir, { timeoutMs: 120_000, excludePid: previousPid });
      await waitForControlList(currentState.httpPort, currentState.controlToken);
      return currentState;
    },
    stopServer: async () => {
      await server.stop();
      proxy.dropAllSockets();
    },
    startServer: async () => {
      server = await startServerLight({
        testDir: params.testDir, dbProvider: 'sqlite', extraEnv: serverEnv, preserveExistingDataDir: true,
        __portAllocator: async () => serverPort, instanceLabel: `restart-${Date.now()}`,
      });
      proxy.setTarget(server.baseUrl);
    },
    restartServer: async (options?: Readonly<{ downtimeMs?: number }>) => {
      await fixture.stopServer();
      if (options?.downtimeMs) await new Promise((r) => setTimeout(r, options.downtimeMs));
      await fixture.startServer();
    },
    teardown: async () => {
      proxy.setHook(null);
      await stopDaemonFromHomeDir(daemonHomeDir).catch(() => {});
      await daemon.proc.stop().catch(() => {});
      for (const proc of restartedProcs) await proc.stop().catch(() => {});
      await server.stop().catch(() => {});
      await proxy.stop().catch(() => {});
    },
  };
  return fixture as unknown as PerSessionRecoveryFixture;
}

// ---------------------------------------------------------------------------------------------
// Durable-state readers
// ---------------------------------------------------------------------------------------------

export type LedgerEntry = UnknownRecord & Readonly<{
  decisionId: string;
  sessionId: string;
  groupId: string;
  origin: string;
  state: string;
  proposal: UnknownRecord;
}>;

export function perSessionLedgerPath(fixture: Pick<PerSessionRecoveryFixture, 'daemonHomeDir' | 'serverId'>): string {
  return resolve(fixture.daemonHomeDir, 'servers', fixture.serverId, 'connected-services', 'per-session-assignments.json');
}

export async function readLedgerEntries(fixture: Pick<PerSessionRecoveryFixture, 'daemonHomeDir' | 'serverId'>): Promise<LedgerEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(perSessionLedgerPath(fixture), 'utf8')) as { entriesByDecisionId?: Record<string, LedgerEntry> };
    return Object.values(parsed.entriesByDecisionId ?? {});
  } catch {
    return [];
  }
}

export type DaemonLogEvent = Readonly<{ file: string; event: string; detail: UnknownRecord; line: string }>;

/** `[ConnectedServices] <event> {json}` lines from every daemon log in the home (all daemon lives). */
export async function readDaemonConnectedServiceEvents(fixture: Pick<PerSessionRecoveryFixture, 'daemonHomeDir'>): Promise<DaemonLogEvent[]> {
  const logsDir = resolve(fixture.daemonHomeDir, 'logs');
  if (!existsSync(logsDir)) return [];
  const events: DaemonLogEvent[] = [];
  for (const name of (await readdir(logsDir)).sort()) {
    if (!name.endsWith('.log')) continue;
    const raw = await readFile(join(logsDir, name), 'utf8').catch(() => '');
    for (const line of raw.split('\n')) {
      const match = /\[ConnectedServices\] ([a-z0-9_]+) (\{.*\})\s*$/.exec(line);
      if (!match) continue;
      let detail: UnknownRecord = {};
      try { detail = JSON.parse(match[2]!) as UnknownRecord; } catch { /* keep empty */ }
      events.push({ file: name, event: match[1]!, detail, line });
    }
  }
  return events;
}

/** Raw lines of every log in the daemon home that contain `needle` (daemon and runner logs). */
export async function grepDaemonHomeLogs(fixture: Pick<PerSessionRecoveryFixture, 'daemonHomeDir'>, needle: string): Promise<string[]> {
  const logsDir = resolve(fixture.daemonHomeDir, 'logs');
  if (!existsSync(logsDir)) return [];
  const lines: string[] = [];
  for (const name of (await readdir(logsDir)).sort()) {
    if (!name.endsWith('.log')) continue;
    const raw = await readFile(join(logsDir, name), 'utf8').catch(() => '');
    for (const line of raw.split('\n')) if (line.includes(needle)) lines.push(`${name}: ${line}`);
  }
  return lines;
}

export function processState(pid: number): string | null {
  try {
    // /proc/<pid>/stat: "pid (comm) S ..." — the state letter follows the last ')'.
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return raw.slice(raw.lastIndexOf(')') + 2).split(' ')[0] ?? null;
  } catch {
    return null;
  }
}
