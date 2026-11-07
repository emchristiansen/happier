import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Page } from '@playwright/test';
import { afterEach, expect, it, vi } from 'vitest';

// The browser is the boundary for this composed helper.
vi.mock('./pageNavigation', () => ({
  gotoCommittedWithRetries: vi.fn(async () => {}),
  gotoDomContentLoadedWithPathFallback: vi.fn(async () => {}),
}));
vi.mock('./waitForInitialAppUi', () => ({ waitForInitialAppUi: vi.fn(async () => {}) }));
vi.mock('./ensureAccountReadyForConnect', () => ({ ensureAccountReadyForConnect: vi.fn(async () => {}) }));
vi.mock('./approveTerminalConnect', () => ({ approveTerminalConnect: vi.fn(async () => {}) }));
vi.mock('./acknowledgeTerminalConnectSuccessIfPresent', () => ({ acknowledgeTerminalConnectSuccessIfPresent: vi.fn(async () => {}) }));

// Launch-spec production is the boundary the prepared specs replace.
const cliLaunchSpecMock = vi.hoisted(() => ({ resolveCliTestLaunchSpec: vi.fn() }));
vi.mock('../process/cliLaunchSpec', async (original) => ({
  ...(await original<typeof import('../process/cliLaunchSpec')>()),
  resolveCliTestLaunchSpec: cliLaunchSpecMock.resolveCliTestLaunchSpec,
}));

// Observe the launch requests the composed helper makes; their own borrow behavior is covered next to them.
const launches = vi.hoisted(() => ({ cliLogin: vi.fn(), daemon: vi.fn() }));
vi.mock('./cliTerminalConnect', async (original) => ({
  ...(await original<typeof import('./cliTerminalConnect')>()),
  startCliAuthLoginForTerminalConnect: launches.cliLogin,
}));
vi.mock('../daemon/daemon', async (original) => ({
  ...(await original<typeof import('../daemon/daemon')>()),
  startTestDaemon: launches.daemon,
}));

import { resolveCliTerminalConnectLaunchSpec } from './cliTerminalConnect';
import { resolveTestDaemonCliLaunchSpec } from '../daemon/daemon';
import { authenticateAndStartDaemon, resolveAuthenticateAndStartDaemonLaunchSpecs } from './authenticateAndStartDaemon';

afterEach(() => {
  cliLaunchSpecMock.resolveCliTestLaunchSpec.mockReset();
  launches.cliLogin.mockReset();
  launches.daemon.mockReset();
});

it('prepares exactly the login and daemon specs authenticateAndStartDaemon resolves and lends them unresolved', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'happier-authenticate-borrowed-spec-'));
  try {
    let generation = 0;
    cliLaunchSpecMock.resolveCliTestLaunchSpec.mockImplementation(async () => {
      generation += 1;
      return { command: process.execPath, args: [resolve(testDir, `cli-dist-generation-${generation}`, 'src', 'index.ts')] };
    });
    launches.cliLogin.mockResolvedValue({ connectUrl: 'http://127.0.0.1:19006/terminal/connect#key=k', waitForSuccess: async () => {}, stop: async () => {} });
    const startedDaemon = { started: 'daemon' };
    launches.daemon.mockResolvedValue(startedDaemon);
    const launchParams = {
      testDir,
      cliHomeDir: resolve(testDir, 'cli-home'),
      serverUrl: 'http://127.0.0.1:4011',
      uiBaseUrl: 'http://127.0.0.1:19006',
      extraEnv: { HOME: resolve(testDir, 'cli-home'), HAPPIER_TEST_ENV_PROBE: 'kept' },
    };

    const prepared = await resolveAuthenticateAndStartDaemonLaunchSpecs(launchParams);
    const prepareCalls = cliLaunchSpecMock.resolveCliTestLaunchSpec.mock.calls.slice();
    cliLaunchSpecMock.resolveCliTestLaunchSpec.mockClear();

    const daemon = await authenticateAndStartDaemon({ page: {} as Page, ...launchParams, preparedLaunchSpecs: prepared });

    expect(daemon).toBe(startedDaemon);
    expect(cliLaunchSpecMock.resolveCliTestLaunchSpec).not.toHaveBeenCalled();
    const loginRequest = launches.cliLogin.mock.calls[0]?.[0];
    const daemonRequest = launches.daemon.mock.calls[0]?.[0];
    expect(loginRequest.preparedCliLaunchSpec).toBe(prepared.cliLogin);
    expect(daemonRequest.preparedCliLaunchSpec).toBe(prepared.daemon);

    // Resolving with the env the helper actually launches with reproduces the prepared resolutions.
    await resolveCliTerminalConnectLaunchSpec({ testDir, env: loginRequest.env });
    await resolveTestDaemonCliLaunchSpec({ testDir, env: daemonRequest.env });
    expect(cliLaunchSpecMock.resolveCliTestLaunchSpec.mock.calls).toEqual(prepareCalls);
    expect(prepareCalls[0]?.[0]?.env).toMatchObject({ HAPPIER_TEST_ENV_PROBE: 'kept', HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1' });
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
});

it('lends nothing when no specs were prepared, so each launch resolves its own', async () => {
  launches.cliLogin.mockResolvedValue({ connectUrl: 'http://127.0.0.1:19006/terminal/connect#key=k', waitForSuccess: async () => {}, stop: async () => {} });
  launches.daemon.mockResolvedValue({});

  await authenticateAndStartDaemon({
    page: {} as Page,
    testDir: '/fixture/test',
    cliHomeDir: '/fixture/test/cli-home',
    serverUrl: 'http://127.0.0.1:4011',
    uiBaseUrl: 'http://127.0.0.1:19006',
  });

  expect(launches.cliLogin.mock.calls[0]?.[0]).not.toHaveProperty('preparedCliLaunchSpec');
  expect(launches.daemon.mock.calls[0]?.[0]).not.toHaveProperty('preparedCliLaunchSpec');
});
