import { type Page } from '@playwright/test';

import {
  resolveTestDaemonCliLaunchSpec,
  startTestDaemon,
  type PreparedTestDaemonCliLaunchSpec,
  type StartedDaemon,
} from '../daemon/daemon';
import { approveTerminalConnect } from './approveTerminalConnect';
import {
  resolveCliTerminalConnectLaunchSpec,
  startCliAuthLoginForTerminalConnect,
  type PreparedCliTerminalConnectLaunchSpec,
} from './cliTerminalConnect';
import { acknowledgeTerminalConnectSuccessIfPresent } from './acknowledgeTerminalConnectSuccessIfPresent';
import { gotoCommittedWithRetries, gotoDomContentLoadedWithPathFallback } from './pageNavigation';
import { ensureAccountReadyForConnect } from './ensureAccountReadyForConnect';
import { waitForInitialAppUi } from './waitForInitialAppUi';

type AuthenticateAndStartDaemonLaunchParams = Readonly<{
  testDir: string;
  cliHomeDir: string;
  serverUrl: string;
  cliServerUrl?: string;
  uiBaseUrl: string;
  extraEnv?: NodeJS.ProcessEnv;
}>;

function buildCliLoginEnv(params: AuthenticateAndStartDaemonLaunchParams): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(params.extraEnv ?? {}),
    CI: '1',
    HAPPIER_DISABLE_CAFFEINATE: '1',
    HAPPIER_VARIANT: 'dev',
    HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
  };
}

function buildDaemonEnv(params: AuthenticateAndStartDaemonLaunchParams): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(params.extraEnv ?? {}),
    CI: '1',
    HAPPIER_HOME_DIR: params.cliHomeDir,
    HAPPIER_SERVER_URL: params.cliServerUrl ?? params.serverUrl,
    HAPPIER_WEBAPP_URL: params.uiBaseUrl,
    HAPPIER_DISABLE_CAFFEINATE: '1',
    HAPPIER_VARIANT: 'dev',
    HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
  };
}

export type PreparedAuthenticateAndStartDaemonLaunchSpecs = Readonly<{
  cliLogin: PreparedCliTerminalConnectLaunchSpec;
  daemon: PreparedTestDaemonCliLaunchSpec;
}>;

/**
 * Resolves exactly the CLI-login and daemon launch specs `authenticateAndStartDaemon` would resolve
 * for the same testDir, URLs and extraEnv, in the same order, for a caller that prepares them once
 * outside a test budget and lends them through `preparedLaunchSpecs` (the daemon spec is also reused
 * by the returned daemon's restart()).
 */
export async function resolveAuthenticateAndStartDaemonLaunchSpecs(
  params: AuthenticateAndStartDaemonLaunchParams,
): Promise<PreparedAuthenticateAndStartDaemonLaunchSpecs> {
  const cliLogin = await resolveCliTerminalConnectLaunchSpec({ testDir: params.testDir, env: buildCliLoginEnv(params) });
  const daemon = await resolveTestDaemonCliLaunchSpec({ testDir: params.testDir, env: buildDaemonEnv(params) });
  return Object.freeze({ cliLogin, daemon });
}

export async function authenticateAndStartDaemon(params: Readonly<{
  page: Page;
  testDir: string;
  cliHomeDir: string;
  serverUrl: string;
  cliServerUrl?: string;
  uiBaseUrl: string;
  /** Borrowed specs from resolveAuthenticateAndStartDaemonLaunchSpecs; nothing is resolved when given. */
  preparedLaunchSpecs?: PreparedAuthenticateAndStartDaemonLaunchSpecs;
  createAccount?: boolean;
  accountReadyTimeoutMs?: number;
  allowStoredCredentialsWithoutReady?: boolean;
  beforeTerminalConnect?: (page: Page) => Promise<void>;
  initialUiGotoTimeoutMs?: number;
  initialUiReadyTimeoutMs?: number;
  terminalConnectUrlTimeoutMs?: number;
  daemonStartupTimeoutMs?: number;
  extraEnv?: NodeJS.ProcessEnv;
}>): Promise<StartedDaemon> {
  const cliServerUrl = params.cliServerUrl ?? params.serverUrl;
  await gotoCommittedWithRetries(params.page, params.uiBaseUrl, params.initialUiGotoTimeoutMs);
  await waitForInitialAppUi({
    page: params.page,
    timeoutMs: params.initialUiReadyTimeoutMs,
    reloadOnFailure: false,
  });
  try {
    await ensureAccountReadyForConnect({
      page: params.page,
      timeoutMs: params.accountReadyTimeoutMs ?? 120_000,
      clickCreateAccount: params.createAccount !== false,
    });
  } catch (error) {
    const hasStoredCredentials = params.allowStoredCredentialsWithoutReady === true
      && await params.page.evaluate(() => {
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (!key?.startsWith('auth_credentials')) continue;
          const raw = localStorage.getItem(key);
          if (!raw) continue;
          try {
            const parsed = JSON.parse(raw) as { token?: unknown };
            if (typeof parsed.token === 'string' && parsed.token.trim()) return true;
          } catch {
            // Keep scanning; a malformed unrelated server scope is not enough.
          }
        }
        return false;
      });
    if (!hasStoredCredentials) throw error;
  }

  await params.beforeTerminalConnect?.(params.page);

  const cliLogin = await startCliAuthLoginForTerminalConnect({
    testDir: params.testDir,
    cliHomeDir: params.cliHomeDir,
    serverUrl: cliServerUrl,
    webappUrl: params.uiBaseUrl,
    connectUrlTimeoutMs: params.terminalConnectUrlTimeoutMs,
    env: buildCliLoginEnv(params),
    ...(params.preparedLaunchSpecs ? { preparedCliLaunchSpec: params.preparedLaunchSpecs.cliLogin } : {}),
  });

  try {
    await gotoDomContentLoadedWithPathFallback(params.page, cliLogin.connectUrl, '/terminal/connect', 90_000);
    await approveTerminalConnect({ page: params.page });
    await cliLogin.waitForSuccess();
    await acknowledgeTerminalConnectSuccessIfPresent(params.page);
  } finally {
    await cliLogin.stop().catch(() => {});
  }

  return await startTestDaemon({
    testDir: params.testDir,
    happyHomeDir: params.cliHomeDir,
    startupTimeoutMs: params.daemonStartupTimeoutMs,
    env: buildDaemonEnv(params),
    ...(params.preparedLaunchSpecs ? { preparedCliLaunchSpec: params.preparedLaunchSpecs.daemon } : {}),
  });
}
