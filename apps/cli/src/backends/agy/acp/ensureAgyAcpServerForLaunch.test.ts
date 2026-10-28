import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureRuntimeInstallablesForLaunch: vi.fn(),
  resolveExistingAgyAcpManagedBinPath: vi.fn(),
  resolveAgyAcpReleaseAsset: vi.fn(),
  readSettings: vi.fn(),
  getActiveAccountSettingsSnapshot: vi.fn(),
}));

vi.mock('@/installables/runtime/ensureRuntimeInstallablesForLaunch', () => ({
  ensureRuntimeInstallablesForLaunch: mocks.ensureRuntimeInstallablesForLaunch,
}));
vi.mock('@/capabilities/deps/agyAcp', () => ({
  resolveExistingAgyAcpManagedBinPath: mocks.resolveExistingAgyAcpManagedBinPath,
}));
vi.mock('@/runtime/managedTools/providers/agyAcpRelease', () => ({
  resolveAgyAcpReleaseAsset: mocks.resolveAgyAcpReleaseAsset,
}));
vi.mock('@/persistence', () => ({ readSettings: mocks.readSettings }));
vi.mock('@/settings/accountSettings/activeAccountSettingsSnapshot', () => ({
  getActiveAccountSettingsSnapshot: mocks.getActiveAccountSettingsSnapshot,
}));

import { INSTALLABLE_KEYS } from '@happier-dev/protocol';
import { ensureAgyAcpServerForLaunch } from './ensureAgyAcpServerForLaunch';

describe('ensureAgyAcpServerForLaunch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readSettings.mockResolvedValue({ machineId: 'machine-1' });
    mocks.getActiveAccountSettingsSnapshot.mockReturnValue(null);
    mocks.resolveExistingAgyAcpManagedBinPath.mockReturnValue('/managed/agy_acp_server.par');
    mocks.resolveAgyAcpReleaseAsset.mockReturnValue({ args: ['--uid='] });
    mocks.ensureRuntimeInstallablesForLaunch.mockResolvedValue({ ok: true });
  });

  it('uses the canonical runtime-installable ensure before resolving the pinned launch', async () => {
    const settings = { featureToggles: {} } as never;
    const env = { AGY_TEST: '1' };

    await expect(ensureAgyAcpServerForLaunch({ accountSettings: settings, env })).resolves.toEqual({
      command: '/managed/agy_acp_server.par',
      args: ['--uid='],
    });
    expect(mocks.ensureRuntimeInstallablesForLaunch).toHaveBeenCalledWith({
      installableKeys: [INSTALLABLE_KEYS.AGY_ACP_SERVER],
      settings,
      machineId: 'machine-1',
      env,
    });
    expect(mocks.resolveExistingAgyAcpManagedBinPath).toHaveBeenCalledOnce();
  });

  it('surfaces the canonical install error and log without resolving a stale executable', async () => {
    mocks.ensureRuntimeInstallablesForLaunch.mockResolvedValue({
      ok: false,
      errorMessage: 'digest mismatch',
      logPath: '/logs/agy-install.log',
    });

    await expect(ensureAgyAcpServerForLaunch()).rejects.toThrow(
      'Agy ACP server is unavailable: digest mismatch (install log: /logs/agy-install.log)',
    );
    expect(mocks.resolveExistingAgyAcpManagedBinPath).not.toHaveBeenCalled();
  });
});
