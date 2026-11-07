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
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import {
  createSessionFromNewSessionComposer,
  reloadCreatedSessionFromNewSessionComposer,
} from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { waitForDaemonMachineIdFromCliSettings } from '../../src/testkit/uiE2e/daemonMachineId';

const run = createRunDirs({ runLabel: 'ui-e2e' });
const SESSION_LOADED_TEST_ID = 'transcript-chat-list';
const SESSION_ROUTE_LOADING_TEST_ID = 'session-route-loading';
const SESSION_ROOT_UNAVAILABLE_TEST_ID = 'session-root-unavailable';
const SESSION_INVALID_LINK_TEST_ID = 'session-invalid-link';

declare global {
  interface Window {
    __happierSessionRouteUnavailableMonitor?: {
      seenUnavailableTestIds: string[];
    };
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sessionRouteUrlPattern(params: { sessionId: string; suffix?: string }): RegExp {
  return new RegExp(`/session/${escapeRegExp(params.sessionId)}${escapeRegExp(params.suffix ?? '')}(?:\\?.*)?$`);
}

function sessionRouteHref(params: { sessionHref: string; suffix: string }): string {
  const url = new URL(params.sessionHref);
  url.pathname = `${url.pathname}${params.suffix}`;
  return url.toString();
}

async function installSessionUnavailableFlashMonitor(page: Page): Promise<void> {
  await page.addInitScript((testIds: string[]) => {
    const state = { seenUnavailableTestIds: [] as string[] };
    window.__happierSessionRouteUnavailableMonitor = state;

    const recordVisibleUnavailable = () => {
      for (const testId of testIds) {
        if (document.querySelector(`[data-testid="${testId}"]`)) {
          state.seenUnavailableTestIds.push(testId);
        }
      }
    };

    const start = () => {
      recordVisibleUnavailable();
      new MutationObserver(recordVisibleUnavailable).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-testid'],
      });
    };

    if (document.documentElement) {
      start();
    } else {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    }
  }, [SESSION_ROOT_UNAVAILABLE_TEST_ID, SESSION_INVALID_LINK_TEST_ID]);
}

async function expectNoSessionUnavailableFlash(page: Page): Promise<void> {
  const seenUnavailableTestIds = await page.evaluate(() => {
    return window.__happierSessionRouteUnavailableMonitor?.seenUnavailableTestIds ?? [];
  });
  expect(seenUnavailableTestIds).toEqual([]);
}

test.describe('ui e2e: session subroutes', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-subroutes-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));
  const t1TestDir = resolve(join(suiteDir, 't1-subroutes'));
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
    HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
    HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
  });

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;
  // Immutable CLI launch specs prepared once here (outside the per-test budget) and borrowed by t1.
  let t1CliLoginLaunchSpec: PreparedCliTerminalConnectLaunchSpec | null = null;
  let t1DaemonLaunchSpec: PreparedTestDaemonCliLaunchSpec | null = null;

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
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);

    await mkdir(t1TestDir, { recursive: true });
    t1CliLoginLaunchSpec = await resolveCliTerminalConnectLaunchSpec({ testDir: t1TestDir, env: t1CliLoginEnv() });
    t1DaemonLaunchSpec = await resolveTestDaemonCliLaunchSpec({
      testDir: t1TestDir,
      env: t1DaemonEnv(server.baseUrl, uiBaseUrl),
    });
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('resolves session info/runs/files subroutes without redirecting', { tag: "@smoke" }, async ({ page }) => {
    test.setTimeout(180_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');
    if (!t1CliLoginLaunchSpec || !t1DaemonLaunchSpec) throw new Error('missing prepared CLI launch specs');

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
      prompt: `hello ${run.runId}`,
      readiness: 'first-turn-reload-safe',
    });
    const { sessionId } = session;

    await installSessionUnavailableFlashMonitor(page);
    await reloadCreatedSessionFromNewSessionComposer({ page, session });
    await expect(
      page.getByTestId(SESSION_ROUTE_LOADING_TEST_ID).or(page.getByTestId(SESSION_LOADED_TEST_ID)),
    ).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId(SESSION_LOADED_TEST_ID)).toHaveCount(1, { timeout: 120_000 });
    await expectNoSessionUnavailableFlash(page);
    await expect(page.getByText('FAKE_CLAUDE_OK_1')).toHaveCount(1, { timeout: 180_000 });

    // In-app navigation should resolve session subroutes.
    await expect(page.getByTestId('session-header-info-button')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('session-header-info-button').click();
    await expect(page).toHaveURL(sessionRouteUrlPattern({ sessionId, suffix: '/info' }), { timeout: 60_000 });
    await expect(page.getByTestId('session-info-screen')).toHaveCount(1, { timeout: 60_000 });

    await reloadCreatedSessionFromNewSessionComposer({ page, session });

    await page.goto(sessionRouteHref({ sessionHref: session.sessionHref, suffix: '/info' }), { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(sessionRouteUrlPattern({ sessionId, suffix: '/info' }), { timeout: 60_000 });
    await expect(page.getByTestId('debug-router-pathname')).toHaveText(`/session/${sessionId}/info`, { timeout: 60_000 });
    await expect(page.getByTestId('session-info-screen')).toHaveCount(1, { timeout: 60_000 });

    await page.goto(sessionRouteHref({ sessionHref: session.sessionHref, suffix: '/runs' }), { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(sessionRouteUrlPattern({ sessionId, suffix: '/runs' }), { timeout: 60_000 });
    await expect(page.getByTestId('session-runs-screen')).toHaveCount(1, { timeout: 60_000 });

    await page.goto(sessionRouteHref({ sessionHref: session.sessionHref, suffix: '/files' }), { waitUntil: 'domcontentloaded' });
    await expect(page).toHaveURL(sessionRouteUrlPattern({ sessionId, suffix: '/files' }), { timeout: 60_000 });
    await expect(page.getByTestId('session-files-screen')).toHaveCount(1, { timeout: 60_000 });
  });

  test('renders stable unavailable selectors for missing session routes', async ({ page }) => {
    test.setTimeout(180_000);
    if (!uiBaseUrl) throw new Error('missing ui fixture');

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
    await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });

    const missingSessionId = `missing-session-${run.runId}`;

    await page.goto(`${uiBaseUrl}/session/${missingSessionId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId(SESSION_ROOT_UNAVAILABLE_TEST_ID)).toHaveCount(1, { timeout: 120_000 });

    await page.goto(`${uiBaseUrl}/session/${missingSessionId}/terminal`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId(SESSION_INVALID_LINK_TEST_ID)).toHaveCount(1, { timeout: 120_000 });
  });
});
