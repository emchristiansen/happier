import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildBackendTargetKey } from '@happier-dev/protocol';

import { handleClaudeCliCommand } from './command';
import * as runClaudeModule from '@/backends/claude/runClaude';
import * as directConnectedServicesModule from '@/cli/connectedServices/resolveDirectConnectedServiceEnvironment';
import * as ensureDaemonModule from '@/daemon/ensureDaemon';
import * as persistenceModule from '@/persistence';
import * as accountSettingsModule from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { __resetApplyAccountSettingsToProcessEnvStateForTests } from '@/settings/applyAccountSettingsToProcessEnv';
import * as authModule from '@/ui/auth';
import { logger } from '@/ui/logger';

const realBootstrap = accountSettingsModule.bootstrapAccountSettingsContext;
const CLAUDE_TARGET_KEY = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' });
const EXPLICIT_BINDINGS = {
  v: 1,
  bindingsByServiceId: {
    'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'selected-profile' },
  },
};

function accountSettings(claudeEnabled: boolean): Record<string, unknown> {
  return {
    schemaVersion: 6,
    backendEnabledByTargetKey: { [CLAUDE_TARGET_KEY]: claudeEnabled },
    connectedServicesDefaultAuthByAgentIdV1: {
      v: 1,
      bindingsByAgentId: {
        claude: {
          v: 1,
          bindingsByServiceId: {
            'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'excluded-default' },
          },
        },
      },
    },
  };
}

/**
 * Runs the normal `happier claude` command with the real settings bootstrap, schema, backend policy
 * and direct-binding resolution. Only the settings cache and HTTP fetch, credentials, connected
 * environment resolution and the Claude runner are synthetic.
 */
async function runClaudeCommand(params: Readonly<{
  cache: 'none' | 'fresh' | 'stale';
  claudeEnabled: boolean;
  /** What the server returns; defaults to the same settings as the cache. */
  network?: 'enabled' | 'disabled' | 'transport_failure';
  auth: 'json' | 'native';
}>) {
  vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue({
    token: 'x',
    encryption: { type: 'legacy', secret: new Uint8Array(32) },
  } as never);
  vi.spyOn(persistenceModule, 'readSettings').mockResolvedValue({ chromeMode: false, machineId: 'machine-1' } as never);
  vi.spyOn(authModule, 'ensureMachineIdForCredentials').mockResolvedValue({ machineId: 'machine-1' } as never);
  vi.spyOn(ensureDaemonModule, 'shouldAutoStartDaemonAfterAuth').mockReturnValue(false);
  const settingsContent = { t: 'plain', v: accountSettings(params.claudeEnabled) };
  const network = params.network ?? (params.claudeEnabled ? 'enabled' : 'disabled');
  const fetchFromServer = vi.fn(async () => {
    if (network === 'transport_failure') throw new Error('socket hang up');
    return { settingsContent: { t: 'plain', v: accountSettings(network === 'enabled') }, settingsVersion: 8 };
  });
  vi.spyOn(accountSettingsModule, 'bootstrapAccountSettingsContext').mockImplementation(async (bootstrapParams) =>
    await realBootstrap({
      ...bootstrapParams,
      deps: {
        resolveCachePath: () => '/synthetic/account.settings.cache.json',
        readCache: async () => (params.cache === 'none'
          ? null
          : {
              version: 2,
              // A stale cache is past any TTL, so a fast launch refreshes it in the background.
              cachedAt: params.cache === 'fresh' ? Date.now() : 0,
              settingsContent,
              settingsVersion: 7,
            }),
        writeCache: async () => {},
        fetchFromServer,
        decryptCiphertext: async () => {
          throw new Error('plain settings are never decrypted');
        },
      } as never,
    }));
  const resolveEnvironment = vi.spyOn(directConnectedServicesModule, 'resolveDirectConnectedServiceEnvironment')
    .mockResolvedValue({ env: {}, cleanupOnFailure: () => {}, cleanupOnExit: () => {} });
  const runSpy = vi.spyOn(runClaudeModule, 'runClaude').mockImplementation(async () => {
    expect(process.env.MCP_PERMISSION_WITNESS).toBe('preserved');
  });
  vi.spyOn(logger, 'fatal').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as typeof process.exit);

  const authArgs = params.auth === 'json'
    ? ['--auth-json', JSON.stringify(EXPLICIT_BINDINGS)]
    : ['--auth', 'native'];
  const outcome = await handleClaudeCliCommand({
    args: ['claude', ...authArgs],
    rawArgv: ['happier', 'claude', ...authArgs],
    terminalRuntime: null,
  } as never).then(() => 'completed', (error: Error) => error.message);
  return { outcome, fetchFromServer, resolveEnvironment, runSpy };
}

describe('handleClaudeCliCommand account backend policy', () => {
  beforeEach(() => {
    accountSettingsModule.resetInMemoryAccountSettingsContextForTests();
    __resetApplyAccountSettingsToProcessEnvStateForTests();
    vi.stubEnv('HAPPIER_SESSION_AUTOSTART_DAEMON', '0');
    vi.stubEnv('MCP_PERMISSION_WITNESS', 'preserved');
    vi.stubEnv('HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_JSON', undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    { cache: 'none' as const, auth: 'json' as const },
    { cache: 'none' as const, auth: 'native' as const },
    { cache: 'fresh' as const, auth: 'json' as const },
    { cache: 'fresh' as const, auth: 'native' as const },
  ])('refuses before connected-service or runner work when settings ($cache cache) disable Claude ($auth auth)', async (params) => {
    const { outcome, fetchFromServer, resolveEnvironment, runSpy } = await runClaudeCommand({ ...params, claudeEnabled: false });

    expect(outcome).toBe('exit:1');
    if (params.cache === 'none') expect(fetchFromServer).toHaveBeenCalled();
    expect(resolveEnvironment).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it.each([
    { cache: 'none' as const, auth: 'json' as const },
    { cache: 'none' as const, auth: 'native' as const },
    { cache: 'fresh' as const, auth: 'json' as const },
    { cache: 'fresh' as const, auth: 'native' as const },
  ])('runs Claude with exactly the explicit binding when settings ($cache cache) enable it ($auth auth)', async (params) => {
    const { outcome, resolveEnvironment, runSpy } = await runClaudeCommand({ ...params, claudeEnabled: true });

    expect(outcome).toBe('completed');
    expect(runSpy).toHaveBeenCalledTimes(1);
    if (params.auth === 'json') {
      expect(resolveEnvironment).toHaveBeenCalledTimes(1);
      const bindings = resolveEnvironment.mock.calls[0]![0].connectedServices;
      expect(bindings).toEqual(EXPLICIT_BINDINGS);
    } else {
      for (const call of resolveEnvironment.mock.calls) {
        const bindings = call[0].connectedServices;
        expect(JSON.stringify(bindings)).not.toContain('excluded-default');
        for (const binding of Object.values(bindings.bindingsByServiceId)) expect(binding).toEqual({ source: 'native' });
      }
    }
  });

  describe('a fast launch from a stale cache', () => {
    let unhandled: unknown[] = [];
    const recordUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };

    beforeEach(() => {
      unhandled = [];
      process.on('unhandledRejection', recordUnhandled);
    });

    afterEach(() => {
      process.off('unhandledRejection', recordUnhandled);
    });

    async function settleBackgroundWork(): Promise<void> {
      for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    }

    it.each([
      { network: 'disabled' as const },
      { network: 'enabled' as const },
      { network: 'transport_failure' as const },
    ])('starts from the cache and owns the background refresh outcome ($network)', async ({ network }) => {
      const { outcome, fetchFromServer, runSpy } = await runClaudeCommand({
        cache: 'stale',
        claudeEnabled: true,
        network,
        auth: 'json',
      });
      await settleBackgroundWork();

      expect(outcome).toBe('completed');
      expect(fetchFromServer).toHaveBeenCalled();
      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    });
  });

  it('still falls back to cached settings when the settings fetch fails in transport', async () => {
    vi.spyOn(persistenceModule, 'readCredentials').mockResolvedValue({
      token: 'x',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    } as never);
    const result = await realBootstrap({
      credentials: { token: 'x', encryption: { type: 'legacy', secret: new Uint8Array(32) } } as never,
      agentId: 'claude',
      mode: 'blocking',
      refresh: 'force',
      deps: {
        resolveCachePath: () => '/synthetic/account.settings.cache.json',
        readCache: async () => ({
          version: 2,
          cachedAt: Date.now(),
          settingsContent: { t: 'plain', v: accountSettings(true) },
          settingsVersion: 7,
        }),
        writeCache: async () => {},
        fetchFromServer: async () => {
          throw new Error('socket hang up');
        },
        decryptCiphertext: async () => null,
      } as never,
    });

    expect(result.source).toBe('cache');
  });
});
