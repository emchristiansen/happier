import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Credentials, Settings } from '@/persistence';
import type { ActiveServerStoredTokenValidationResult } from '@/auth/validateStoredAuthTokenAgainstActiveServer';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const authAndSetupMachineIfNeededMock = vi.hoisted(() => vi.fn(async (_options?: unknown) => ({
  machineId: 'm1',
  credentials: { token: 't1', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
})));
const validateStoredAuthTokenAgainstActiveServerMock = vi.hoisted(() =>
  vi.fn<(token: string) => Promise<ActiveServerStoredTokenValidationResult>>(async () => ({ state: 'valid', httpStatus: 200, accountId: 'acct_test', accountLabel: null })),
);
const readCredentialsMock = vi.hoisted(() => vi.fn<() => Promise<Credentials | null>>(async () => null));
const readSettingsMock = vi.hoisted(() => vi.fn<() => Promise<Partial<Settings>>>(async () => ({})));
const clearCredentialsMock = vi.hoisted(() => vi.fn(async () => {}));
const clearMachineIdMock = vi.hoisted(() => vi.fn(async () => {}));
const stopDaemonMock = vi.hoisted(() => vi.fn(async () => ({ status: 'not_running' as const })));
const reconcileBackgroundServicesMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: (options?: unknown) => authAndSetupMachineIfNeededMock(options),
}));

vi.mock('../backgroundServiceFollowUp', () => ({
  reconcileDefaultFollowingBackgroundServicesAfterAuthentication: () => reconcileBackgroundServicesMock(),
}));

vi.mock('@/auth/validateStoredAuthTokenAgainstActiveServer', () => ({
  validateStoredAuthTokenAgainstActiveServer: (token: string) => validateStoredAuthTokenAgainstActiveServerMock(token),
}));

vi.mock('@/server/serverSelection', () => ({
  applyServerSelectionFromArgs: async (args: string[]) => args,
}));

vi.mock('@/persistence', () => ({
  readCredentials: () => readCredentialsMock(),
  readSettings: () => readSettingsMock(),
  clearCredentials: () => clearCredentialsMock(),
  clearMachineId: () => clearMachineIdMock(),
}));

vi.mock('@/daemon/controlClient', () => ({
  stopDaemon: () => stopDaemonMock(),
}));

vi.mock('@/daemon/ownership/daemonServiceInventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/daemon/ownership/daemonServiceInventory')>();
  return {
    ...actual,
    resolveInstalledDaemonServiceInventoryForCurrentRelay: async () => [],
  };
});

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

describe('happier auth login', () => {
  const envScope = createEnvKeyScope([
    'HAPPIER_ACTIVE_SERVER_ID',
    'HAPPIER_AUTH_METHOD',
    'HAPPIER_AUTH_PRINT_CONFIGURE_LINKS',
    'HAPPIER_AUTH_WAIT_TIMEOUT_MS',
    'HAPPIER_SERVER_URL',
  ]);

  beforeEach(() => {
    // This test relies on per-file module mocks; ensure we never reuse a cached login module
    // from a prior test file executed in the same forked worker.
    vi.resetModules();
  });

  afterEach(() => {
    envScope.restore();
    authAndSetupMachineIfNeededMock.mockReset();
    authAndSetupMachineIfNeededMock.mockResolvedValue({
      machineId: 'm1',
      credentials: { token: 't1', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
    });
    validateStoredAuthTokenAgainstActiveServerMock.mockReset();
    validateStoredAuthTokenAgainstActiveServerMock.mockResolvedValue({ state: 'valid', httpStatus: 200, accountId: 'acct_test', accountLabel: null });
    readCredentialsMock.mockReset();
    readCredentialsMock.mockResolvedValue(null);
    readSettingsMock.mockReset();
    readSettingsMock.mockResolvedValue({});
    clearCredentialsMock.mockReset();
    clearMachineIdMock.mockReset();
    stopDaemonMock.mockReset();
    stopDaemonMock.mockResolvedValue({ status: 'not_running' });
    reconcileBackgroundServicesMock.mockReset();
    reconcileBackgroundServicesMock.mockResolvedValue(true);
    process.exitCode = undefined;
    vi.resetModules();
  });

  it('sets HAPPIER_AUTH_METHOD before running the auth flow', async () => {
    delete process.env.HAPPIER_AUTH_METHOD;
    readCredentialsMock.mockResolvedValue({
      token: 'valid-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });
    readSettingsMock.mockResolvedValue({ machineId: 'machine-1' });
    let authMethodAtFlowStart: string | undefined;
    validateStoredAuthTokenAgainstActiveServerMock.mockImplementationOnce(async () => {
      authMethodAtFlowStart = process.env.HAPPIER_AUTH_METHOD;
      return { state: 'valid', httpStatus: 200, accountId: 'acct_test', accountLabel: null };
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin(['--method', 'web']);

      expect(authMethodAtFlowStart).toBe('web');
      expect(process.env.HAPPIER_AUTH_METHOD).toBe('web');
      expect(authAndSetupMachineIfNeededMock).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('prints a friendly error and exits before auth when --method is invalid', async () => {
    delete process.env.HAPPIER_AUTH_METHOD;

    class ExitError extends Error {
      readonly code: number;

      constructor(code: number) {
        super(`process.exit(${code})`);
        this.code = code;
      }
    }

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new ExitError(typeof code === 'number' ? code : 0);
    }) as typeof process.exit);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const { handleAuthLogin } = await import('./login');
      let thrown: unknown = null;
      try {
        await handleAuthLogin(['--method', 'nope']);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ExitError);
      expect((thrown as ExitError).code).toBe(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(/Invalid --method/i);
      expect(authAndSetupMachineIfNeededMock).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('sets HAPPIER_AUTH_PRINT_CONFIGURE_LINKS=1 when flag is present', async () => {
    delete process.env.HAPPIER_AUTH_PRINT_CONFIGURE_LINKS;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin(['--print-configure-links']);
      expect(process.env.HAPPIER_AUTH_PRINT_CONFIGURE_LINKS).toBe('1');
      expect(authAndSetupMachineIfNeededMock).toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('does not set HAPPIER_AUTH_PRINT_CONFIGURE_LINKS when flag is absent', async () => {
    delete process.env.HAPPIER_AUTH_PRINT_CONFIGURE_LINKS;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin([]);
      expect(process.env.HAPPIER_AUTH_PRINT_CONFIGURE_LINKS).toBeUndefined();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('prints authentication success exactly once after machine setup completes', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin([]);
      const output = consoleSpy.mock.calls.flat().map(String).join('\n');
      expect(output.match(/✓ Signed in$/gmu) ?? []).toHaveLength(1);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('hands --wait-timeout to the wait the auth flow performs', async () => {
    // The bound only exists if both files agree on this key; a rename on either
    // side leaves `happier setup` holding the terminal forever and says nothing.
    delete process.env.HAPPIER_AUTH_WAIT_TIMEOUT_MS;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin(['--wait-timeout', '300']);

      expect(process.env.HAPPIER_AUTH_WAIT_TIMEOUT_MS).toBe('300000');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('leaves the wait unbounded when no bound was asked for', async () => {
    delete process.env.HAPPIER_AUTH_WAIT_TIMEOUT_MS;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin([]);

      expect(process.env.HAPPIER_AUTH_WAIT_TIMEOUT_MS).toBeUndefined();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('passes setup-managed intent so setup remains the only daemon-start owner', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin(['--no-daemon-start']);

      expect(authAndSetupMachineIfNeededMock).toHaveBeenCalledWith({ callerIntent: 'setup-managed' });
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('surfaces an incomplete background-service follow-up to setup without clearing credentials', async () => {
    reconcileBackgroundServicesMock.mockResolvedValue(false);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin(['--no-daemon-start']);

      expect(process.exitCode).toBe(1);
      expect(clearCredentialsMock).not.toHaveBeenCalled();
      expect(clearMachineIdMock).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    }
  });

  it('reconciles setup-managed service readiness when credentials and machine registration already exist', async () => {
    readCredentialsMock.mockResolvedValue({
      token: 'valid-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });
    readSettingsMock.mockResolvedValue({ machineId: 'machine-1' });
    reconcileBackgroundServicesMock.mockResolvedValue(false);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin(['--no-daemon-start']);

      expect(authAndSetupMachineIfNeededMock).toHaveBeenCalledWith({ callerIntent: 'setup-managed' });
      expect(reconcileBackgroundServicesMock).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(1);
      expect(clearCredentialsMock).not.toHaveBeenCalled();
      expect(clearMachineIdMock).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    }
  });

  it('keeps standalone authentication successful when its optional service follow-up is incomplete', async () => {
    reconcileBackgroundServicesMock.mockResolvedValue(false);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin([]);

      expect(process.exitCode).toBeUndefined();
      expect(authAndSetupMachineIfNeededMock).toHaveBeenCalledWith({ callerIntent: 'standalone' });
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('repairs rejected stored credentials instead of reporting already authenticated', async () => {
    readCredentialsMock.mockResolvedValue({
      token: 'stale-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });
    readSettingsMock.mockResolvedValue({ machineId: 'machine-1' });
    validateStoredAuthTokenAgainstActiveServerMock.mockResolvedValue({
      state: 'invalid',
      httpStatus: 401,
      reasonCode: 'not_authenticated',
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin([]);

      expect(validateStoredAuthTokenAgainstActiveServerMock).toHaveBeenCalledWith('stale-token');
      expect(stopDaemonMock).toHaveBeenCalledTimes(1);
      expect(clearCredentialsMock).toHaveBeenCalledTimes(1);
      expect(clearMachineIdMock).toHaveBeenCalledTimes(1);
      expect(authAndSetupMachineIfNeededMock).toHaveBeenCalledTimes(1);
      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Already authenticated'));
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('selects same-machine web auth for a new login to a loopback relay and names the target', async () => {
    readCredentialsMock.mockResolvedValue(null);
    envScope.patch({
      HAPPIER_SERVER_URL: 'http://127.0.0.1:52753',
      HAPPIER_ACTIVE_SERVER_ID: '127.0.0.1-52753',
    });
    delete process.env.HAPPIER_AUTH_METHOD;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin([]);

      expect(process.env.HAPPIER_AUTH_METHOD).toBe('web');
      expect(consoleSpy.mock.calls.flat().join('\n')).toContain('http://127.0.0.1:52753');
    } finally {
      consoleSpy.mockRestore();
      delete process.env.HAPPIER_AUTH_METHOD;
    }
  });

  it('repairs a missing machine ID without announcing browser or phone reachability', async () => {
    readCredentialsMock.mockResolvedValue({
      token: 'valid-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });
    readSettingsMock.mockResolvedValue({});
    envScope.patch({ HAPPIER_SERVER_URL: 'http://127.0.0.1:52753' });
    delete process.env.HAPPIER_AUTH_METHOD;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin([]);

      const text = consoleSpy.mock.calls.flat().join('\n').toLowerCase();
      expect(process.env.HAPPIER_AUTH_METHOD).toBeUndefined();
      expect(text).not.toContain('browser');
      expect(text).not.toContain('phone cannot');
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
