import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliDataKeyAuthForServer } from '../../src/testkit/cliAuth';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { createUserScopedSocketCollector } from '../../src/testkit/socketClient';
import { createDataKeyRpcClient, unwrapDataKeyRpcResult } from '../../src/testkit/syntheticAgent/rpcClient';
import { waitFor } from '../../src/testkit/timing';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { waitForSessionActive } from '../../src/testkit/providers/scenarios/sessionRuntime';
import { readSpawnSessionRpcTimeoutMsFromEnv } from '../../../../apps/ui/sources/sync/domains/session/spawn/spawnSessionRpcTimeout';
import { parseTestTerminalAttachmentInfo } from '../../src/testkit/uiE2e/terminalAttachmentInfo';
import {
  readFakeCodexAppServerRequestLog,
  writeFakeCodexAppServerScript,
} from '../../src/testkit/codexAppServerRemoteHarness';

const run = createRunDirs({ runLabel: 'core' });

async function writeFakeLocalCodexScript(params: Readonly<{ testDir: string; invocationLogPath: string }>): Promise<string> {
  const scriptPath = resolve(join(params.testDir, 'fake-local-codex.mjs'));
  await writeFile(
    scriptPath,
    [
      '#!/usr/bin/env node',
      'import { appendFile } from "node:fs/promises";',
      `const invocationLogPath = ${JSON.stringify(params.invocationLogPath)};`,
      'await appendFile(invocationLogPath, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");',
      'process.exit(0);',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o755 },
  );
  return scriptPath;
}

describe('core e2e: direct Codex app-server sessions takeover+continue', () => {
  let server: StartedServer | null = null;
  let daemon: StartedDaemon | null = null;
  let ui: ReturnType<typeof createUserScopedSocketCollector> | null = null;
  let tmuxTmpDir: string | null = null;
  let tmuxSessionName: string | null = null;
  let activeTestDir: string | null = null;

  afterEach(async () => {
    ui?.close();
    ui = null;
    if (tmuxTmpDir && tmuxSessionName && activeTestDir) {
      const env = { ...process.env, TMUX: undefined, TMUX_PANE: undefined, TMUX_TMPDIR: tmuxTmpDir };
      const panes = spawnSync('tmux', ['list-panes', '-s', '-t', tmuxSessionName, '-F', '#{pane_id} #{pane_start_command}'], { env, encoding: 'utf8' });
      const output = [panes.stdout, panes.stderr];
      for (const row of panes.stdout.trim().split('\n').filter(Boolean)) {
        const paneId = row.split(' ')[0];
        const capture = spawnSync('tmux', ['capture-pane', '-p', '-t', paneId, '-S', '-100'], { env, encoding: 'utf8' });
        output.push(`Pane ${paneId}`, capture.stdout, capture.stderr);
      }
      await writeFile(join(activeTestDir, 'tmux.panes.log'), output.join('\n'), 'utf8');
    }
    await daemon?.stop().catch(() => {});
    daemon = null;
    if (tmuxTmpDir && tmuxSessionName) {
      spawnSync('tmux', ['kill-session', '-t', tmuxSessionName], {
        env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined, TMUX_TMPDIR: tmuxTmpDir },
        stdio: 'ignore',
      });
      await rm(tmuxTmpDir, { recursive: true, force: true });
    }
    tmuxTmpDir = null;
    tmuxSessionName = null;
    activeTestDir = null;
    await server?.stop().catch(() => {});
    server = null;
  });

  afterAll(async () => {
    await daemon?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  for (const { mode, terminalMode } of [
    { mode: 'persisted', terminalMode: 'plain' },
    { mode: 'direct', terminalMode: 'tmux' },
    { mode: 'persisted', terminalMode: 'tmux' },
  ] as const) {
    it.skipIf(terminalMode === 'tmux' && (process.platform === 'win32' || spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0))(
      `continues a linked Codex app-server session after '${mode}' takeover with '${terminalMode}'`, async () => {
      const testDir = run.testDir(`direct-sessions-codex-app-server-takeover-${mode}-${terminalMode}-continue`);
      activeTestDir = testDir;
      const daemonHomeDir = resolve(join(testDir, 'daemon-home'));
      const codexHomeDir = resolve(join(testDir, '.codex'));
      const appServerRequestLogPath = resolve(join(testDir, 'fake-codex-app-server.requests.jsonl'));
      const localCodexInvocationLogPath = resolve(join(testDir, 'fake-local-codex.invocations.jsonl'));
      const remoteSessionId = '44444444-4444-4444-4444-444444444444';
      const linkedDirectory = '/tmp/direct-codex-app-server-takeover-project';

      await mkdir(daemonHomeDir, { recursive: true });
      await mkdir(codexHomeDir, { recursive: true });

      const fakeAppServer = await writeFakeCodexAppServerScript({
        dir: testDir,
        requestLogPath: appServerRequestLogPath,
      });
      const fakeLocalCodex = await writeFakeLocalCodexScript({
        testDir,
        invocationLogPath: localCodexInvocationLogPath,
      });

      server = await startServerLight({
        testDir,
        dbProvider: 'sqlite',
        extraEnv: {
          HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
        },
      });
      const serverBaseUrl = server.baseUrl;
      const auth = await createTestAuth(serverBaseUrl);

      const machineKey = Uint8Array.from(randomBytes(32));
      const seeded = await seedCliDataKeyAuthForServer({
        cliHome: daemonHomeDir,
        serverUrl: server.baseUrl,
        token: auth.token,
        machineKey,
      });

      daemon = await startTestDaemon({
        testDir,
        happyHomeDir: daemonHomeDir,
        env: {
          ...process.env,
          CI: '1',
          HAPPIER_HOME_DIR: daemonHomeDir,
          HAPPIER_SERVER_URL: serverBaseUrl,
          HAPPIER_WEBAPP_URL: serverBaseUrl,
          CODEX_HOME: codexHomeDir,
          HAPPIER_CODEX_APP_SERVER_BIN: fakeAppServer,
          HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '2000',
          HAPPIER_CODEX_TUI_BIN: fakeLocalCodex,
          HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        },
      });

      ui = createUserScopedSocketCollector(serverBaseUrl, auth.token);
      ui.connect();
      await waitFor(() => ui?.isConnected() === true, { timeoutMs: 20_000, context: 'socket connected for direct Codex app-server takeover persist e2e' });

      const machineRpc = createDataKeyRpcClient(ui, machineKey);

      let link: Awaited<ReturnType<typeof machineRpc.call>> | null = null;
      await waitFor(async () => {
        link = await machineRpc.call(`${seeded.machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_LINK_ENSURE}`, {
          machineId: seeded.machineId,
          providerId: 'codex',
          remoteSessionId,
          titleHint: 'Direct Codex app-server linked session',
          directoryHint: linkedDirectory,
          codexBackendMode: 'appServer',
          source: { kind: 'codexHome', home: 'user' },
        });
        return link.ok === true;
      }, { timeoutMs: 30_000, context: 'direct Codex app-server link RPC available' });
      if (!link) {
        throw new Error('Expected direct Codex app-server link response');
      }
      const linkResult = unwrapDataKeyRpcResult(link, 'direct Codex app-server persisted link');
      expect(linkResult).toEqual(expect.objectContaining({
        ok: true,
        created: true,
      }));
      const sessionId = (linkResult as { sessionId: string }).sessionId;
      expect((await fetchSessionV2(serverBaseUrl, auth.token, sessionId)).active).toBe(false);

      if (terminalMode === 'tmux') {
        tmuxTmpDir = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'happy-direct-tmux-'));
        tmuxSessionName = `happy-direct-${randomUUID().slice(0, 8)}`;
      }
      const method = mode === 'persisted' ? RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER_PERSIST : RPC_METHODS.DAEMON_DIRECT_SESSION_TAKEOVER;
      const takeover = await machineRpc.call(`${seeded.machineId}:${method}`, {
        machineId: seeded.machineId,
        sessionId,
        ...(tmuxTmpDir && tmuxSessionName ? {
          terminal: { mode: 'tmux', tmux: { sessionName: tmuxSessionName, isolated: true, tmpDir: tmuxTmpDir } },
        } : {}),
      });
      const takeoverResult = unwrapDataKeyRpcResult(takeover, `direct Codex app-server takeover ${mode}`);
      expect(takeoverResult).toEqual(mode === 'persisted' ? { ok: true, converted: true } : { ok: true });

      // Takeover admits the spawn before the runner registers. Keep the provider
      // assertion's budget separate from the owning spawn lifecycle.
      await waitForSessionActive({
        baseUrl: serverBaseUrl,
        token: auth.token,
        sessionId,
        timeoutMs: readSpawnSessionRpcTimeoutMsFromEnv(),
      });

      await waitFor(async () => {
        const requests = await readFakeCodexAppServerRequestLog(appServerRequestLogPath);
        return requests.some((entry) => entry.method === 'thread/resume' && entry.params?.threadId === remoteSessionId);
      }, { timeoutMs: 45_000, context: 'direct Codex app-server persisted takeover resumes linked app-server thread' });

      if (tmuxTmpDir && tmuxSessionName) {
        const attachmentPath = join(daemonHomeDir, 'terminal', 'sessions', `${encodeURIComponent(sessionId)}.json`);
        await waitFor(async () => {
          const attachment = parseTestTerminalAttachmentInfo(await readFile(attachmentPath, 'utf8').catch(() => ''));
          return attachment?.sessionId === sessionId;
        }, { timeoutMs: 30_000, context: `${mode} takeover terminal attachment` });
        const attachment = parseTestTerminalAttachmentInfo(await readFile(attachmentPath, 'utf8'));
        expect(attachment?.terminal.mode).toBe('tmux');
        expect(attachment?.terminal.tmux?.tmpDir).toBe(tmuxTmpDir);
        const target = attachment?.terminal.tmux?.target;
        if (!target) throw new Error('Missing takeover tmux target');
        const pane = spawnSync('tmux', ['display-message', '-p', '-t', target, '#{session_name} #{pane_dead} #{pane_pid}'], {
          env: { ...process.env, TMUX: undefined, TMUX_PANE: undefined, TMUX_TMPDIR: tmuxTmpDir },
          encoding: 'utf8',
        });
        expect(pane.status).toBe(0);
        const [sessionName, dead, pid] = pane.stdout.trim().split(' ');
        expect(sessionName).toBe(tmuxSessionName);
        expect(dead).toBe('0');
        expect(Number(pid)).toBeGreaterThan(0);
      }

      if (existsSync(localCodexInvocationLogPath)) {
        const localInvocations = (await readFile(localCodexInvocationLogPath, 'utf8'))
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        expect(localInvocations).toEqual([]);
      }

      ui.close();
    }, 240_000);
  }
});
