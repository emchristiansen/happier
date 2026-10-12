import os from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

describe('resolveBackendIsolationBundle', () => {
  it('creates an isolation root under the active server dir and overlays XDG state/cache/data', async () => {
    const homeDir = await mkdtemp(join(os.tmpdir(), 'happier-isolation-home-'));
    const previousEnv = {
      HAPPIER_HOME_DIR: process.env.HAPPIER_HOME_DIR,
      HAPPIER_SERVER_URL: process.env.HAPPIER_SERVER_URL,
      HAPPIER_WEBAPP_URL: process.env.HAPPIER_WEBAPP_URL,
      HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS: process.env.HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS,
      HOME: process.env.HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CODEX_HOME: process.env.CODEX_HOME,
      HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: process.env.HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON,
      HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON: process.env.HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON,
      HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT: process.env.HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT,
    };
    try {
      process.env.HAPPIER_HOME_DIR = homeDir;
      process.env.HAPPIER_SERVER_URL = 'https://api.example.test';
      process.env.HAPPIER_WEBAPP_URL = 'https://app.example.test';
      process.env.HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS = '123456';
      process.env.HOME = join(homeDir, 'real-home');
      process.env.XDG_CONFIG_HOME = join(homeDir, 'real-config');
      process.env.XDG_STATE_HOME = join(homeDir, 'real-state');
      process.env.XDG_CACHE_HOME = join(homeDir, 'real-cache');
      process.env.XDG_DATA_HOME = join(homeDir, 'real-data');
      process.env.OPENAI_API_KEY = 'parent-connected-secret';
      process.env.CODEX_HOME = join(homeDir, 'parent-connected-codex');
      process.env.HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON = JSON.stringify([{ serviceId: 'openai-codex', source: 'connected' }]);
      process.env.HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON = JSON.stringify(['OPENAI_API_KEY', 'CODEX_HOME']);
      process.env.HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT = join(homeDir, 'parent-connected-root');

      const { reloadConfiguration } = await import('@/configuration');
      reloadConfiguration();

      const { configuration } = await import('@/configuration');
      const { resolveBackendIsolationBundle } = await import('./resolveBackendIsolationBundle');

      const bundle = resolveBackendIsolationBundle({
        backendId: 'claude',
        isolationId: 'run_1',
        scope: 'execution_run',
        intent: 'memory_hints',
        cwd: process.cwd(),
      });

      const root = join(configuration.activeServerDir, 'isolation', 'claude', 'execution_run', 'run_1');
      expect(bundle.env.XDG_STATE_HOME).toBe(join(root, 'xdg', 'state'));
      expect(bundle.env.XDG_CACHE_HOME).toBe(join(root, 'xdg', 'cache'));
      expect(bundle.env.XDG_DATA_HOME).toBe(join(root, 'xdg', 'data'));
      expect(bundle.env.HAPPIER_OPENCODE_SERVER_TURN_INACTIVITY_TIMEOUT_MS).toBe('123456');
      expect(bundle.env.HOME).toBe(join(homeDir, 'real-home'));
      expect(bundle.env.XDG_CONFIG_HOME).toBe(join(homeDir, 'real-config'));
      expect(bundle.env.OPENAI_API_KEY).toBeUndefined();
      expect(bundle.env.CODEX_HOME).toBeUndefined();
      expect(bundle.env.HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON).toBeUndefined();
      expect(bundle.env.HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON).toBeUndefined();
      expect(bundle.env.HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT).toBeUndefined();
    } finally {
      vi.resetModules();
      await rm(homeDir, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
