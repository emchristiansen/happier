import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { writeKimiFixture } from './runtimeDiscovery.testkit';
import { cliCapability } from './capability';
import { AGENT_IDS } from '@happier-dev/agents';
import type { DetectCliSnapshot } from '@/capabilities/snapshots/cliSnapshot';

afterEach(() => vi.unstubAllEnvs());

describe.skipIf(process.platform === 'win32')('Kimi CLI readiness', () => {
  it.each(['current', 'legacy', 'malformed'] as const)('classifies %s through its real ACP process', async (kind) => {
    await withTempDir('happier-kimi-readiness-', async (dir) => {
      vi.stubEnv('HAPPIER_KIMI_PATH', writeKimiFixture(dir, kind));
      // Snapshot is the daemon boundary; populate every known provider explicitly.
      const clis = Object.fromEntries(AGENT_IDS.map((id) => [id, { available: false }])) as DetectCliSnapshot['clis'];
      clis.kimi = { available: true, resolvedPath: '/old/kimi', resolvedCommand: '/old/kimi', version: '1.49.0', isLoggedIn: true };
      const result = await cliCapability.detect({ request: { id: 'cli.kimi', params: { includeLoginStatus: true } }, context: {
        cliSnapshot: { path: null, clis, tmux: { available: false }, windowsTerminal: { available: false } },
      } });
      expect(result).toMatchObject({ available: kind === 'current', kimiRuntime: { kind: kind === 'malformed' ? 'unknown' : kind } });
      expect(result).not.toHaveProperty('version');
      expect(result).toMatchObject({ isLoggedIn: null });
      expect(result).not.toHaveProperty('resolvedCommand', '/old/kimi');
    });
  });
});
