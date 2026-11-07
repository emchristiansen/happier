import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import {
  resolveTestDaemonCliLaunchSpec,
  startTestDaemon,
  type PreparedTestDaemonCliLaunchSpec,
  type StartedDaemon,
} from '../../src/testkit/daemon/daemon';
import {
  resolveCliTerminalConnectLaunchSpec,
  startCliAuthLoginForTerminalConnect,
  type PreparedCliTerminalConnectLaunchSpec,
  type StartedCliTerminalConnect,
} from '../../src/testkit/uiE2e/cliTerminalConnect';
import {
  createSessionFromNewSessionComposer,
  reloadCreatedSessionFromNewSessionComposer,
} from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { resolveCliJsonLaunchSpec, runCliJson, type PreparedCliJsonLaunchSpec } from '../../src/testkit/uiE2e/cliJson';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { waitForDaemonMachineIdFromCliSettings } from '../../src/testkit/uiE2e/daemonMachineId';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: transcript small reconnect catch-up', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-transcript-catchup-small-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));
  const t1TestDir = resolve(join(suiteDir, 't1-reconnect-small'));
  const t1CliLoginEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    HOME: cliHomeDir,
    CI: '1',
    HAPPIER_DISABLE_CAFFEINATE: '1',
    HAPPIER_VARIANT: 'dev',
  });
  const t1DaemonEnv = (serverUrl: string, webappUrl: string): NodeJS.ProcessEnv => ({
    ...process.env,
    HOME: cliHomeDir,
    CI: '1',
    HAPPIER_HOME_DIR: cliHomeDir,
    HAPPIER_SERVER_URL: serverUrl,
    HAPPIER_WEBAPP_URL: webappUrl,
    HAPPIER_DISABLE_CAFFEINATE: '1',
    HAPPIER_VARIANT: 'dev',
    HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
    HAPPIER_E2E_FAKE_CLAUDE_LOG: resolve(join(t1TestDir, 'fake-claude.jsonl')),
    HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
    HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
  });
  const t1CliJsonEnv = (): NodeJS.ProcessEnv => ({ ...process.env, HOME: cliHomeDir });

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;
  // Immutable CLI launch specs prepared once here (outside the per-test budget) and borrowed by t1.
  let t1CliLoginLaunchSpec: PreparedCliTerminalConnectLaunchSpec | null = null;
  let t1DaemonLaunchSpec: PreparedTestDaemonCliLaunchSpec | null = null;
  let t1CliJsonLaunchSpec: PreparedCliJsonLaunchSpec | null = null;

  test.beforeAll(async () => {
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(process.env));
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys,providers.claude.unifiedTerminal',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
        // Large gap threshold set high so reconnect uses incremental catch-up (`afterSeq=`) instead of a tail reset snapshot.
        EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON: JSON.stringify({
          messageLargeGapSeq: 100,
          messageMaxIncrementalPagesOnResume: 3,
          transcriptForwardPrefetchThresholdPx: 800,
          messageCatchUpConcurrencyLimit: 1,
          resumeConcurrencyLimit: 2,
          bootstrapConcurrencyLimit: 3,
          changesPageLimit: 200,
        }),
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);

    await mkdir(t1TestDir, { recursive: true });
    t1CliLoginLaunchSpec = await resolveCliTerminalConnectLaunchSpec({ testDir: t1TestDir, env: t1CliLoginEnv() });
    t1DaemonLaunchSpec = await resolveTestDaemonCliLaunchSpec({
      testDir: t1TestDir,
      env: t1DaemonEnv(server.baseUrl, uiBaseUrl),
    });
    t1CliJsonLaunchSpec = await resolveCliJsonLaunchSpec({ testDir: t1TestDir, env: t1CliJsonEnv() });
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('uses incremental afterSeq catch-up on reconnect when gap is small', { tag: "@smoke" }, async ({ page }) => {
    test.setTimeout(180_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');
    if (!t1CliLoginLaunchSpec || !t1DaemonLaunchSpec || !t1CliJsonLaunchSpec) {
      throw new Error('missing prepared CLI launch specs');
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

    await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });

    const testDir = t1TestDir;
    await mkdir(testDir, { recursive: true });

    const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      webappUrl: uiBaseUrl,
      env: t1CliLoginEnv(),
      preparedCliLaunchSpec: t1CliLoginLaunchSpec,
    });

    await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('terminal-connect-approve').click();
    await cliLogin.waitForSuccess();
    await cliLogin.stop().catch(() => {});

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: cliHomeDir,
      env: t1DaemonEnv(server.baseUrl, uiBaseUrl),
      preparedCliLaunchSpec: t1DaemonLaunchSpec,
    });

    const machineId = await waitForDaemonMachineIdFromCliSettings({ cliHomeDir, timeoutMs: 120_000 });
    const session = await createSessionFromNewSessionComposer({
      page,
      uiBaseUrl,
      machineId,
      prompt: 'hello small gap',
      readiness: 'first-turn-reload-safe',
    });
    const { sessionId } = session;

    await reloadCreatedSessionFromNewSessionComposer({ page, session });

    const requests: Array<{ url: string; ts: number }> = [];
    page.on('request', (req) => requests.push({ url: req.url(), ts: Date.now() }));

    await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 120_000 });
    await page.context().setOffline(true);
    await page.waitForTimeout(500);

    for (let i = 0; i < 5; i += 1) {
      const message = `missed small gap ${i} ${run.runId}`;
      const sendEnvelope = await runCliJson({
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        webappUrl: uiBaseUrl,
        env: t1CliJsonEnv(),
        label: `session-send-missed-${i}`,
        args: ['session', 'send', sessionId, message, '--json'],
        timeoutMs: 120_000,
        preparedCliLaunchSpec: t1CliJsonLaunchSpec,
      });
      expect(sendEnvelope.ok).toBe(true);
      expect(sendEnvelope.kind).toBe('session_send');
    }

    const reconnectStart = Date.now();
    await page.context().setOffline(false);

    await expect
      .poll(
        async () => {
          const after = requests.filter((r) => r.ts >= reconnectStart).map((r) => r.url);
          const hasChanges = after.some((u) => u.includes('/v2/changes'));
          const hasAfterSeq = after.some(
            (u) => u.includes(`/v1/sessions/${sessionId}/messages?`) && u.includes('afterSeq='),
          );
          const hasSnapshot = after.some(
            (u) => u.includes(`/v1/sessions/${sessionId}/messages`) && !u.includes('afterSeq='),
          );
          return { hasChanges, hasAfterSeq, hasSnapshot, after };
        },
        { timeout: 60_000 },
      )
      .toMatchObject({ hasChanges: true, hasAfterSeq: true, hasSnapshot: false });
  });
});
